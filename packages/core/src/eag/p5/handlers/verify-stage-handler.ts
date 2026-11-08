/**
 * EAG-P5 Phase 5.2 VerifyStageHandler（TASK-P5-1.2-006）
 *
 * 本模块实现 `P5VerifyStageHandler` 类，是 AutonomousOrchestrator 4 阶段循环
 * 的 verify 阶段处理器，负责"测试命令真实执行 + G-A4a 证据强制 + G-A2a 黑名单"。
 *
 * 核心职责（对齐架构师审查 §3.1.3 + §4.1）：
 * 1. 从 ctx.testCommand 获取测试命令（如 "npm test"）
 * 2. 调用 smartConfirmation.decide() 做命令级三态决策（G-A2a 黑名单预检）
 * 3. 若 fail-closed → 返回 fatal（黑名单命中或高风险命令）
 * 4. 若 ask-user → 返回 failed（需用户确认）
 * 5. 通过 spawnSync 真实执行测试命令（cwd=projectRoot, timeout=testTimeoutSec）
 * 6. 解析测试输出（支持 node:test/Jest/Mocha/unittest/generic 格式，实现见 test-output-analysis.ts）
 * 7. 提取失败用例标识（pytest FAILED / unittest FAIL: / jest ✕ / mocha N) / TAP not ok）
 * 8. 构造 CompletionEvidence 制品（G-A4a 证据强制，摘要为"失败窗口优先"）
 * 9. 调用 guardChain.execute() 做 verify 阶段护栏判定
 * 10. 返回测试结果（pass/fail/skip + 退出码 + 输出摘要 + 失败用例）
 *
 * 关键技术决策：
 * - 命令执行：child_process.spawnSync（同步阻塞，捕获 stdout/stderr/exitCode）
 * - 超时控制：spawnSync 的 timeout 选项（超时后 SIGTERM 子进程）
 * - 输出解析：test-output-analysis.ts 的多格式解析器（真实 runner 输出逐条验证）
 * - 证据强制：CompletionEvidence 必须含 testExitCode + testOutputSummary（G-A4a）
 * - 证据可用性：摘要在超长时保留"失败窗口 + 尾部统计"，禁止只留头部
 *   （2026-11-03 run b64490b8ad78：head-only 截断导致 fix 无失败信息可依，两轮同败后熔断）
 *
 * 真实实现（禁止 mock）：
 * - 真实调用 child_process.spawnSync 执行测试命令
 * - 真实读取 stdout/stderr
 * - 真实解析测试结果
 * - 测试时使用真实可执行的测试命令（如 "node -e 'console.log(\"ok\")'"）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 *
 * @module eag/p5/handlers/verify-stage-handler
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { P5StageContext, P5StageHandler, P5StageResult } from "./types";
import { buildGuardContext, createSuccessStageResult, createFailedStageResult, toGuardRecords } from "./types";
import type { CompletionEvidence, TaskCard } from "../guards/types";
import { createPassVerdict } from "../guards/types";
import {
  buildTestOutputSummary,
  extractFailedTestIds,
  parseTestOutput,
  type FailedTestIdList,
  type TestResultStats,
} from "./test-output-analysis";

// 向后兼容导出：历史调用方（p5/index.ts、各 EAG 测试）从本模块 import parseTestOutput /
// TestResultStats。实现已迁至 test-output-analysis.ts（失败证据分析唯一实现）。
export { parseTestOutput } from "./test-output-analysis";
export type { TestResultStats } from "./test-output-analysis";

// ============================================================================
// 1. 常量定义
// ============================================================================

/**
 * verify 阶段"无测试目标诚实 skip"原因码（方案 A §3.7，架构师 P1-5）。
 */
export const VERIFY_REASON_TEST_SKIPPED_NO_TEST_TARGET = "test-skipped-no-test-target" as const;

/**
 * 默认测试命令（与 orchestrator/命令层默认值同源）。
 * 仅当测试命令为此默认值时才允许"无 package.json/scripts.test → skip"降级，
 * 用户显式配置的自定义命令失败一律按真实失败处理。
 */
const DEFAULT_TEST_COMMAND = "npm test" as const;

/**
 * npm 未定义 test 脚本时的真实输出模式。
 * 合成任务路径下 spawn 返回非零且输出命中该模式时，下限降级为 skip
 * （覆盖前置 package.json 探测与实际执行环境不一致的边界情况）。
 */
const NPM_NO_TEST_SCRIPT_RE = /Missing script:\s*["']?test["']?|no test script found/i;

/**
 * 测试命令允许执行的程序白名单。
 *
 * P0 安全修复：移除 shell:true 后，必须限制可执行程序，防止 testCommand 中注入
 * 任意系统命令。白名单覆盖常见 Node/Python 测试框架，使用 path.basename 兼容绝对路径。
 */
const ALLOWED_TEST_PROGRAMS: ReadonlySet<string> = new Set<string>([
  "npm",
  "node",
  "npx",
  "pnpm",
  "yarn",
  "tsc",
  "vitest",
  "jest",
  "mocha",
  "python",
  "python3",
  "pytest",
]);

/**
 * 解析测试命令字符串为 [程序, ...参数] 数组。
 *
 * P0 安全修复：
 * 1. 先按 shell 引号规则 tokenize，再对未被引号包裹的 token 做安全校验；
 * 2. 拒绝独立的 shell 操作符（; && || | < >）以及命令替换 $(...) / `...` / $VAR；
 * 3. 被引号包裹的元字符视为普通参数内容，允许合法 JS/Python 表达式使用 () 等；
 * 4. 程序必须命中 ALLOWED_TEST_PROGRAMS 白名单。
 *
 * 设计理由：移除 shell:true 后，spawnSync(program, args, { shell: false }) 不会调用 shell
 * 解释器，因此引号内的 shell 元字符对系统无害，只需阻止真正的命令链/重定向/替换。
 *
 * 2026-11-08：导出供 baseline-guard.ts 复用，保证"run 起始基线探测"与"每轮 verify"
 * 对同一 testCommand 的解释完全一致（同一白名单、同一 tokenize，不产生口径漂移）。
 *
 * @param command 原始命令字符串（如 "npm test"）
 * @returns 解析后的 [program, ...args]
 * @throws 含 shell 元字符、解析失败或程序不在白名单时抛出 Error
 */
export function parseShellCommand(command: string): { program: string; args: string[] } {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error("测试命令不能为空");
  }

  type Token = { value: string; quoted: boolean };
  const tokens: Token[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let currentQuoted = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];

    if (quote) {
      if (char === quote) {
        // 引号关闭时立即将已收集内容作为独立 token 推入，
        // 防止后续非空白字符（如 ; && ||）被追加到 quoted token 中，
        // 导致 shell 操作符被错误地视为参数内容而绕过安全检查。
        quote = null;
        if (current.length > 0) {
          tokens.push({ value: current, quoted: currentQuoted });
          current = "";
          currentQuoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      currentQuoted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push({ value: current, quoted: currentQuoted });
        current = "";
        currentQuoted = false;
      }
      continue;
    }

    current += char;
  }

  if (quote !== null) {
    throw new Error("测试命令引号未闭合");
  }
  if (current.length > 0) {
    tokens.push({ value: current, quoted: currentQuoted });
  }

  if (tokens.length === 0) {
    throw new Error("无法解析测试命令");
  }

  // 仅对未加引号的 token 进行 shell 安全检查
  const shellOperators = new Set([";", "&&", "||", "|", "<", ">"]);
  for (const token of tokens) {
    if (token.quoted) {
      continue;
    }
    const value = token.value;
    if (shellOperators.has(value)) {
      throw new Error(`测试命令包含非法 shell 操作符：${value}`);
    }
    if (/^\$\(.*\)$/.test(value) || /^`.*`$/.test(value) || value.startsWith("$")) {
      throw new Error(`测试命令包含非法 shell 替换：${value}`);
    }
    // 反斜杠在 Windows 路径或转义中较常见，但未加引号时仍可能用于转义注入，拒绝。
    if (/\\/.test(value)) {
      throw new Error(`测试命令包含非法反斜杠转义：${value}`);
    }
  }

  const programWithPath = tokens[0].value;
  const program = programWithPath.replace(/\\/g, "/").split("/").pop() ?? programWithPath;
  if (!ALLOWED_TEST_PROGRAMS.has(program)) {
    throw new Error(`测试命令程序不在白名单中：${program}`);
  }

  return { program: programWithPath, args: tokens.slice(1).map((token) => token.value) };
}

// ============================================================================
// 2. 类型定义
// ============================================================================

/**
 * 测试命令执行结果（spawnSync 原始输出）
 */
interface TestCommandResult {
  /** 退出码（0=成功，非 0=失败，null=信号终止） */
  readonly exitCode: number | null;
  /** 信号（如 "SIGTERM"，正常结束时为 null） */
  readonly signal: string | null;
  /** 标准输出（utf8 字符串） */
  readonly stdout: string;
  /** 标准错误（utf8 字符串） */
  readonly stderr: string;
  /** 是否超时 */
  readonly timedOut: boolean;
  /** 执行耗时（毫秒） */
  readonly durationMs: number;
  /**
   * 进程未能启动时的错误信息（如 ENOENT：命令不存在 / 解释器缺失）。
   *
   * 2026-11-03 新增（架构评审 B5）：此前 spawnSync 的 result.error 被丢弃，
   * "解释器不存在"会表现成 exitCode=-1 + 空输出，进而被"无测试计数"分支
   * 降级为 skip（假绿）。现在单独承载，由调用方判 fatal 并原样上报。
   */
  readonly spawnError: string | null;
}

// ============================================================================
// 3. P5VerifyStageHandler 类
// ============================================================================

/**
 * Verify 阶段处理器
 *
 * 设计原则（对齐 Karpathy Goal-Driven Execution + Ponytail 红线）：
 *   1. 真实执行：使用 child_process.spawnSync 真实执行测试命令（不模拟）
 *   2. 命令级护栏：先调用 smartConfirmation.decide() 做黑名单预检
 *   3. 证据强制：CompletionEvidence 必须含客观指标（exitCode + outputSummary）
 *   4. 超时控制：spawnSync timeout 选项防止卡死
 *   5. 不可变产出：返回的 P5StageResult 为冻结对象
 *
 * 使用方式：
 * ```typescript
 * const handler = new P5VerifyStageHandler();
 * const result = await handler.handle(ctx);
 * if (result.kind === "success") {
 *   const stats = result.artifacts["testStats"] as TestResultStats;
 *   const evidence = result.artifacts["completionEvidence"] as CompletionEvidence;
 * }
 * ```
 */
export class P5VerifyStageHandler implements P5StageHandler {
  /**
   * 执行 verify 阶段处理
   *
   * 完整时序：
   * 1. 获取测试命令（ctx.testCommand，默认 "npm test"）
   * 2. 调用 smartConfirmation.decide() 做命令级三态决策
   * 3. fail-closed → 返回 fatal（黑名单命中或高风险命令）
   * 4. ask-user → 返回 failed（需用户确认）
   * 5. auto-approve → 通过 spawnSync 真实执行测试命令
   * 6. 解析测试输出（TestResultStats）
   * 7. 构造 CompletionEvidence 制品（G-A4a 证据强制）
   * 8. 调用 guardChain.execute() 做 verify 阶段护栏判定
   * 9. 根据 exitCode + guardDecision 返回 success/failed
   *
   * @param ctx 阶段执行上下文
   * @returns 阶段执行结果
   */
  async handle(ctx: Readonly<P5StageContext>): Promise<Readonly<P5StageResult>> {
    const startTime = Date.now();

    try {
      // 1. 获取测试命令
      // 项目类型自动探测（异构 root 不会默认 npm test 必超时，2026-10-07）：
      //   - 用户显式指定 → 尊重 ctx.testCommand
      //   - 用户未指定 → detectDefaultTestCommand(projectRoot) 按项目类型选默认值
      //     Python → "python3 -m pytest" / Go → "go test ./..." / Rust → "cargo test" / Node → "npm test"
      //     都没有 → 回退 "npm test"（保持向后兼容）
      const testCommand = ctx.testCommand || detectDefaultTestCommand(ctx.projectRoot);

      // 1.5 方案 A §3.7（架构师 P1-5）：合成任务 + 默认 npm test + 项目真实无可测目标时，
      //     诚实 skip 而非 spawn 一个必然失败的 npm test 把循环拖入假失败。
      //     严格收窄：仅 ctx.synthesizedTask 路径允许；手写 tasks.md 不降级（无测试即失败）。
      if (ctx.synthesizedTask === true && testCommand.trim() === DEFAULT_TEST_COMMAND) {
        const noTestTarget = detectProjectWithoutTestTarget(ctx.projectRoot);
        if (noTestTarget) {
          return this.buildSkippedResult(testCommand, startTime, "项目无 package.json 或未定义 scripts.test");
        }
      }

      // 2. 调用 smartConfirmation.decide() 做命令级三态决策
      //    使用 createPassVerdict() 作为初始 verdict（系统级护栏未触发）
      const passVerdict = createPassVerdict();
      const confirmation = ctx.smartConfirmation.decide(passVerdict, testCommand);

      // 3. fail-closed → 返回 fatal
      if (confirmation.decision === "fail-closed") {
        return createFailedStageResult(
          "verify",
          "fatal",
          `测试命令被拒绝（${confirmation.reason}）`,
          `命令 "${testCommand}" 被判定为 fail-closed：${confirmation.reason}`,
          {
            testCommand,
            confirmation,
            guardRuleId: "G-A2a",
          },
          [],
          0,
          Date.now() - startTime
        );
      }

      // 4. ask-user → 返回 failed（需用户确认）
      if (confirmation.decision === "ask-user") {
        return createFailedStageResult(
          "verify",
          "failed",
          `测试命令需用户确认（${confirmation.reason}）`,
          `命令 "${testCommand}" 被判定为 ask-user：${confirmation.reason}`,
          {
            testCommand,
            confirmation,
            guardRuleId: "G-A2a",
          },
          [],
          0,
          Date.now() - startTime
        );
      }

      // 5. auto-approve → 真实执行测试命令
      const cmdResult = this.executeTestCommand(testCommand, ctx);

      // 5.5 命令未能启动（ENOENT/EACCES 等）→ fatal，禁止降级为 skip
      //     （2026-11-03，架构评审 B5：旧实现丢弃 spawnSync.error，
      //       "解释器不存在"被"无测试计数"分支当成"无测试可跑"跳过）
      if (cmdResult.spawnError !== null) {
        return createFailedStageResult(
          "verify",
          "fatal",
          `测试命令无法启动：${cmdResult.spawnError}`,
          `命令 "${testCommand}" 未能启动（cwd=${ctx.projectRoot}）：${cmdResult.spawnError}`,
          {
            testCommand,
            spawnError: cmdResult.spawnError,
            guardDecision: "PASS",
          },
          [],
          0,
          Date.now() - startTime
        );
      }

      // 6. 解析测试输出
      const testStats = parseTestOutput(cmdResult.stdout, cmdResult.stderr);
      // 失败用例标识（无失败时为空列表）：失败分支的摘要与制品都用它，
      // 保证 fix 阶段与最终报告拿到"哪个用例失败"的可操作信息。
      const failedTests = extractFailedTestIds(`${cmdResult.stdout}\n${cmdResult.stderr}`);

      // 7. 构造 CompletionEvidence 制品（G-A4a 证据强制）
      //    输出摘要必须合并 stdout 与 stderr：npm/yarn 等脚本运行器会把命令头
      //    （"> xxx@1.0.0 test" 两行）写到 stdout，而测试框架（node:assert、
      //    Jest 的失败详情、Mocha 等）常把真正的断言失败与堆栈写到 stderr。
      //    若用 `stdout || stderr`，npm 包装下 stdout 永非空，stderr 中的失败
      //    根因会被整体丢弃，fix 阶段将拿不到任何可用于修复的证据。
      //    此处与 parseTestOutput 的合并策略保持一致。
      const combinedTestOutput = [cmdResult.stdout, cmdResult.stderr]
        .filter((chunk) => typeof chunk === "string" && chunk.length > 0)
        .join("\n");
      // 2026-11-03 修复（run b64490b8ad78 事故）：摘要改为"失败窗口优先"。
      // 旧实现只保留输出前 2000 字符，而 pytest/unittest/jest/mocha/node --test
      // 的失败详情都在输出尾部——fix 阶段拿到的是一屏"进度点"，无法定位失败用例。
      const evidence: CompletionEvidence = Object.freeze({
        testCommand,
        testExitCode: cmdResult.exitCode ?? -1,
        testOutputSummary: buildTestOutputSummary(combinedTestOutput),
        coveragePercent: 0, // 代码覆盖率需要额外工具支持，默认 0
        evaluatorVerdict: cmdResult.exitCode === 0 ? "pass" : "fail",
        executedAt: new Date().toISOString(),
      });

      // 8. 判定测试是否通过
      //
      // 【2026-10-07 加 passed>0 守卫】旧条件 `exitCode===0 && failed===0` 在
      // "0 passed / 0 failed / exitCode=0" 场景下误判 success——测试运行器
      // 可能没跑任何用例（如 node --test 对空目录、没有 test 脚本的 npm test），
      // exitCode=0 但 passed=0，不代表"所有测试通过"，代表"根本没有测试"。
      // 加 passed>0 守卫后：
      //   exitCode=0, passed>0, failed=0 → 真通过 ✓
      //   exitCode=0, passed=0, failed=0 → 无测试 → testPassed=false → 进 skip 降级
      //   exitCode≠0 或 failed>0 → 真失败 → 进 failed 分支
      const testPassed = cmdResult.exitCode === 0 && testStats.passed > 0 && testStats.failed === 0;
      const summary = formatTestSummary(testStats, cmdResult, testPassed);

      // 9. 测试失败 → 直接返回 failed（不调用 guardChain，避免 G-A4a 误判）
      //    设计依据：G-A4a "完成声明证据强制"的语义是禁止自然语言声明完成，
      //    verify 阶段测试失败时并非声明完成，而是如实报告失败，
      //    此时护栏无需介入，直接返回 failed 让 fix 阶段尝试修复。
      if (!testPassed) {
        // 方案 A §3.7 下限降级：前置探测与真实执行不一致时（package.json 动态生成等），
        // 合成任务路径下 npm 明确报"Missing script: test"，按无测试目标 skip，
        // 其他真实测试失败（断言/编译错误等）一律保持 failed。
        if (
          ctx.synthesizedTask === true &&
          testCommand.trim() === DEFAULT_TEST_COMMAND &&
          NPM_NO_TEST_SCRIPT_RE.test(`${cmdResult.stdout}\n${cmdResult.stderr}`)
        ) {
          return this.buildSkippedResult(testCommand, startTime, "npm 报告未定义 test 脚本");
        }
        // "无测试可跑"降级（修复 verify 空测试误判 failed 2026-10-03 + 2026-10-07）：
        // 输出解析不出任何测试计数（0 passed / 0 failed / 0 skipped）时：
        //   exitCode≠0 → 极可能是测试运行器根本没用例可跑（node --test 空目录、
        //                pytest 收集 0 项、脚本名缺失变体）——判 failed 会白白
        //                累加 consecutiveFailures 把循环拖进熔断。
        //   exitCode=0 → 命令执行成功但解析不到任何测试计数——要么不是测试命令
        //                （如 echo "hello" exitCode=0 但不是测试），要么测试框架
        //                输出格式不认识（parseTestOutput 无匹配 pattern），要么
        //                真的没有测试用例。原条件 `exitCode===0 && failed===0`
        //                会误判 pass（错误），现在 testPassed=false 进入本分支。
        // 诚实语义：按"未验证"skip 处理（unverified，不代表测试通过也不代表失败）。
        const noTestsCollected = testStats.passed === 0 && testStats.failed === 0 && testStats.skipped === 0;
        if (noTestsCollected && cmdResult.exitCode === 0) {
          // exitCode=0 + 无测试计数：命令成功执行但没有任何测试结果
          // （含原 testPassed=false 踢过来的 exitCode=0 场景 + 原 noTestsCollected
          // exitCode≠0 但命令成功被调用的场景）
          return this.buildSkippedResult(
            testCommand,
            startTime,
            `测试命令退出码 ${cmdResult.exitCode} 但输出无任何测试计数（0 passed/0 failed/0 skipped）——判定为无测试可跑或非测试命令，而非测试失败`
          );
        }
        // exitCode≠0 + noTestsCollected：命令失败且无测试计数
        // 严格收窄（对齐既有契约）：仅 objective 合成任务 + 默认 npm test
        // 才允许降级——手写 tasks.md 的项目必须自备测试命令，exitCode≠0 如实 failed。
        if (noTestsCollected && ctx.synthesizedTask === true && testCommand.trim() === DEFAULT_TEST_COMMAND) {
          return this.buildSkippedResult(
            testCommand,
            startTime,
            `测试命令退出码 ${cmdResult.exitCode} 但输出无任何测试计数（0 passed/0 failed/0 skipped）——判定为无测试可跑，而非测试失败`
          );
        }
        // 基线红灯拆分（2026-11-08）：把本轮失败用例拆成"run 起始既有"与"本任务新增"。
        // orchestrator 在 run 起始采集一次基线失败用例集并注入 ctx；未注入（fixtures
        // 直接调 handler）或基线探测降级（baselineAvailable=false）时**不排除任何失败**，
        // summary/error 保持原样如实报失败（不破坏既有 D1 等回归断言）。
        const baselineSet = ctx.baselineFailedTestIds;
        const baselineAvailable = ctx.baselineAvailable === true && baselineSet !== undefined;
        const baselineMatched: string[] = [];
        const newFailed: string[] = [];
        // 仅在基线可用时做拆分；降级时两个数组都留空（表示"未做拆分、不排除任何失败"），
        // 由 baselineOnly=false 保证编排层不把这些失败排除掉。
        if (baselineAvailable) {
          for (const id of failedTests.ids) {
            if (baselineSet!.has(id)) {
              baselineMatched.push(id);
            } else {
              newFailed.push(id);
            }
          }
        }
        // baselineOnly 诚实性守卫：必须本轮真实识别到了失败用例、且全部都能归因到基线，
        // 才允许标记"无新增失败"。若本轮 failed>0 却提取不到任何用例标识（ids 为空），
        // 绝不能把真失败说成"纯基线"借以逃过熔断——此时 baselineOnly=false。
        const baselineOnly =
          baselineAvailable && failedTests.ids.length > 0 && newFailed.length === 0 && baselineMatched.length > 0;

        const baseSummary = formatTestSummary(testStats, cmdResult, testPassed, failedTests);
        // 如实写"N 个基线失败 + M 个新增失败"并列出新增用例；绝不声称测试通过，
        // 不把 testPassed 改成 true，不省略基线红灯仍失败的事实。
        // 边界：基线数据可用但本轮 failed>0 却提取不到任何用例标识时，不做拆分，
        // 明确写"未做拆分、不排除任何失败"，避免"0 基线 + 0 新增"的误导性表述。
        const canSplit = baselineAvailable && failedTests.ids.length > 0;
        const summary = !baselineAvailable
          ? baseSummary
          : canSplit
            ? `${baseSummary}；基线与新增拆分：${baselineMatched.length} 个基线失败（run 起始既有，非本任务引入）、` +
              `${newFailed.length} 个新增失败` +
              (newFailed.length > 0 ? `；新增用例：${newFailed.slice(0, 5).join("、")}` : "") +
              `；基线红灯仍失败，本阶段判定 failed（不得据此声明完成）`
            : `${baseSummary}；基线数据可用但本轮未提取到失败用例标识，未做拆分（不排除任何失败）；` +
              `基线红灯仍失败，本阶段判定 failed（不得据此声明完成）`;

        return createFailedStageResult(
          "verify",
          "failed",
          summary,
          `测试失败：exitCode=${cmdResult.exitCode}, failed=${testStats.failed}${formatFailedIdHint(failedTests)}`,
          {
            testCommand,
            testStats,
            // 失败用例标识（pytest FAILED / unittest FAIL: / jest ✕ / mocha N) / TAP not ok）：
            // fix 阶段据此"优先定位这些用例"，最终报告也能给出可操作信息，
            // 不再是只有 "exitCode=1, failed=1" 的空洞结论。
            // 原始清单保持不变（下游 fix / 既有回归断言依赖此字段）。
            failedTestIds: failedTests.ids,
            failedTestTotal: failedTests.total,
            // 基线拆分制品（2026-11-08）：基线数据可用时才有意义；降级时为空数组 +
            // baselineAvailable=false + baselineOnly=false，不排除任何失败。
            baselineOnly,
            newFailedTestIds: Object.freeze([...newFailed]),
            baselineFailedTestIds: Object.freeze([...baselineMatched]),
            baselineAvailable,
            // 原始尾部（≤4000 字符）：给 fix 阶段"从原始证据重建摘要"的兜底输入。
            // 只传摘要会让 fix 无法在摘要被前人截断时自愈（架构评审 B7）。
            testOutputTail: combinedTestOutput.slice(-RAW_OUTPUT_TAIL_CHARS),
            completionEvidence: evidence,
            commandResult: {
              exitCode: cmdResult.exitCode,
              signal: cmdResult.signal,
              timedOut: cmdResult.timedOut,
              durationMs: cmdResult.durationMs,
            },
            guardDecision: "PASS",
          },
          [],
          0,
          Date.now() - startTime
        );
      }

      // 10. 测试通过 → 调用 guardChain.execute() 做"声明完成"证据校验
      //     仅在测试通过时才校验 CompletionEvidence（G-A4a 防伪造完成）
      const taskCard = extractTaskCardFromPrevResults(ctx);
      const guardContext = buildGuardContext(ctx, {
        currentTaskCard: taskCard ?? undefined,
        completionEvidence: evidence,
        // 2026-11-01 修复（守卫恒绿）：verify 是唯一"命令在阶段内确定"的阶段，
        // 此前从未注入 pendingCommand → G-A1a 路径牢笼 / G-A1b 环境变量写保护 /
        // G-A3b 清理意图三条 BLOCKER 在本阶段全部空转。
        // 注入后形如 `export HOME=/tmp npm test` 的测试命令会被真实拦截。
        pendingCommand: testCommand,
        // 但 testCommand 是用户配置的命令，不应被 AUTO 白名单（G-A2c）拦下——
        // 否则项目自定义 runner 会让 verify 恒 ASK、运行永远收不了尾。
        commandAuthority: "user-configured",
      });

      const chainResult = await ctx.guardChain.execute(guardContext);
      const guardRecords = toGuardRecords(chainResult, ctx.iterIndex, "verify", ctx.loopType);

      // 11. 护栏 DENY → 返回 fatal（测试通过但护栏拒绝声明完成）
      if (chainResult.overallDecision === "DENY") {
        const firstDenial = chainResult.firstDenial;
        return createFailedStageResult(
          "verify",
          "fatal",
          `verify 阶段护栏拒绝（规则 ${firstDenial?.ruleId ?? "unknown"}）`,
          firstDenial?.reason ?? "未知原因",
          {
            testCommand,
            testStats,
            completionEvidence: evidence,
            guardDecision: "DENY",
            guardRuleId: firstDenial?.ruleId ?? "",
          },
          guardRecords,
          0,
          Date.now() - startTime
        );
      }

      // 12. 护栏 ASK → 返回 failed（需用户确认）
      if (chainResult.overallDecision === "ASK") {
        const firstAsk = chainResult.triggeredGuards.find((v) => v.decision === "ASK");
        return createFailedStageResult(
          "verify",
          "failed",
          `verify 阶段护栏需确认（规则 ${firstAsk?.ruleId ?? "unknown"}）`,
          firstAsk?.reason ?? "需用户确认",
          {
            testCommand,
            testStats,
            completionEvidence: evidence,
            guardDecision: "ASK",
            guardRuleId: firstAsk?.ruleId ?? "",
          },
          guardRecords,
          0,
          Date.now() - startTime
        );
      }

      // 13. 测试通过 + 护栏 PASS → 返回 success（声明完成合法）
      return createSuccessStageResult(
        "verify",
        summary,
        {
          testCommand,
          testStats,
          completionEvidence: evidence,
          commandResult: {
            exitCode: cmdResult.exitCode,
            signal: cmdResult.signal,
            timedOut: cmdResult.timedOut,
            durationMs: cmdResult.durationMs,
          },
          guardDecision: "PASS",
        },
        guardRecords,
        0,
        Date.now() - startTime
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return createFailedStageResult(
        "verify",
        "fatal",
        `verify 阶段异常：${error.message}`,
        error.stack ?? error.message,
        {},
        [],
        0,
        Date.now() - startTime
      );
    }
  }

  // ========================================================================
  // 内部辅助方法
  // ========================================================================

  /**
   * 构造"无测试目标诚实 skip"结果（方案 A §3.7）。
   *
   * 语义约定：
   * - kind=success：没有真实失败，不触发 fix/连续失败累计，循环可正常收尾；
   * - artifacts.skipped/unverified=true：禁止任何下游把它表述为"测试通过"，
   *   milestone 与最终报告必须标注该任务未经验证（P2-1）；
   * - 不调用 guardChain：没有 completionEvidence，也不声明完成。
   *
   * @param testCommand 测试命令文本
   * @param startTime 阶段开始时间戳
   * @param detail 触发 skip 的具体原因（人类可读）
   * @returns 冻结的 success 阶段结果
   */
  private buildSkippedResult(testCommand: string, startTime: number, detail: string): Readonly<P5StageResult> {
    return createSuccessStageResult(
      "verify",
      "项目未定义测试命令，跳过测试执行（注意：这不代表测试通过，任务结论标记为 unverified）",
      {
        testCommand,
        reason: VERIFY_REASON_TEST_SKIPPED_NO_TEST_TARGET,
        skipped: true,
        unverified: true,
        skipDetail: detail,
        guardDecision: "PASS",
      },
      [],
      0,
      Date.now() - startTime
    );
  }

  /**
   * 真实执行测试命令（child_process.spawnSync）
   *
   * @param command 测试命令（如 "npm test"）
   * @param ctx 阶段执行上下文
   * @returns 测试命令执行结果
   */
  private executeTestCommand(command: string, ctx: Readonly<P5StageContext>): TestCommandResult {
    const startTime = Date.now();
    const timeoutMs = Math.max(1000, ctx.testTimeoutSec * 1000);

    // P0 安全修复：使用 parseShellCommand 解析命令并移除 shell:true，防止命令注入
    const parsed = parseShellCommand(command);
    const result = spawnSync(parsed.program, parsed.args, {
      cwd: ctx.projectRoot,
      shell: false,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024, // 10MB，防止超大输出导致内存溢出
      killSignal: "SIGTERM",
    });

    const durationMs = Date.now() - startTime;
    const timedOut = result.status === null && result.signal === "SIGTERM";

    return {
      exitCode: result.status,
      signal: result.signal,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut,
      durationMs,
      // 进程未启动（ENOENT/EACCES 等）时 result.error 非空：必须原样上报，
      // 否则会被"输出无测试计数"分支误判为"无测试可跑"
      spawnError: result.error instanceof Error ? `${result.error.name}: ${result.error.message}` : null,
    };
  }
}

// ============================================================================
// 4. 测试输出解析器
// ============================================================================

/**
 * 探测项目是否真实缺少 npm 测试目标（方案 A §3.7，架构师 P1-5）。
 *
 * 判定规则（真实读取 package.json，不 spawn）：
 * - 无 package.json：true（默认 npm test 必然失败；Python/Go/Rust 等非 npm 项目同理，
 *   用户应显式配置对应 testCommand）；
 * - package.json 存在但 JSON 损坏：false（不做 skip 预判，交真实 spawn 裁定，避免掩盖故障）；
 * - 解析成功但无 scripts.test 或其值非非空字符串：true；
 * - 存在有效 scripts.test：false（必须真实执行）。
 *
 * @param projectRoot 项目根目录绝对路径
 * @returns true=可诚实 skip；false=必须执行真实测试命令
 */
function detectProjectWithoutTestTarget(projectRoot: string): boolean {
  const packageJsonPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return true;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as unknown;
    const scripts = (parsed as { scripts?: unknown } | null)?.scripts;
    if (!scripts || typeof scripts !== "object") {
      return true;
    }
    const testScript = (scripts as { test?: unknown }).test;
    return !(typeof testScript === "string" && testScript.trim().length > 0);
  } catch {
    // package.json 存在但无法解析：不让 skip 掩盖问题，走真实 spawn 路径
    return false;
  }
}

/**
 * 项目类型自动探测默认测试命令（修复异构 projectRoot 上默认 npm test 必超时，2026-10-07）。
 *
 * 探测优先级（按文件存在性）：
 *   1. pyproject.toml / requirements.txt / setup.py / conftest.py → "python3 -m pytest"
 *      （优先 pyproject.toml，覆盖新/旧 Python 项目；conftest.py 说明 pytest 配置已存在）
 *   2. Cargo.toml → "cargo test"
 *   3. go.mod → "go test ./..."
 *   4. package.json + 有 test script → "npm test"（原 DEFAULT_TEST_COMMAND）
 *   5. 以上都没有 → "npm test"（兜底，保持向后兼容；运行器会因 Missing script 进 skip 降级）
 *
 * 注意：探测只看根目录，不递归子目录。探测结果是"合理默认值"，
 * 不等于用户项目一定有测试——真实 spawn 失败仍会进 verify 已有的 skip/failed 分支。
 *
 * @param projectRoot EAG 目标项目根目录
 * @returns 探测到的默认测试命令字符串
 */
function detectDefaultTestCommand(projectRoot: string): string {
  const pyprojectPath = path.join(projectRoot, "pyproject.toml");
  const requirementsPath = path.join(projectRoot, "requirements.txt");
  const setupPyPath = path.join(projectRoot, "setup.py");
  const conftestPath = path.join(projectRoot, "conftest.py");
  if (
    fs.existsSync(pyprojectPath) ||
    fs.existsSync(requirementsPath) ||
    fs.existsSync(setupPyPath) ||
    fs.existsSync(conftestPath)
  ) {
    return "python3 -m pytest";
  }

  const cargoPath = path.join(projectRoot, "Cargo.toml");
  if (fs.existsSync(cargoPath)) {
    return "cargo test";
  }

  const goModPath = path.join(projectRoot, "go.mod");
  if (fs.existsSync(goModPath)) {
    return "go test ./...";
  }

  // Node.js：package.json + scripts.test 存在 → npm test
  // 没有 package.json 或没有 test script → 仍回退 npm test（detectProjectWithoutTestTarget
  // 在 synthesizedTask 路径会把这种情况降级为 skip，不会硬超时）
  return DEFAULT_TEST_COMMAND;
}

// ============================================================================
// 5. 辅助函数
// ============================================================================

/**
 * 格式化测试摘要
 *
 * @param stats 测试统计
 * @param cmdResult 命令执行结果
 * @param testPassed 是否通过
 * @param failedTests 失败用例标识（失败时附在摘要尾部，最多列 5 个）
 * @returns 摘要字符串
 */
function formatTestSummary(
  stats: TestResultStats,
  cmdResult: TestCommandResult,
  testPassed: boolean,
  failedTests?: Readonly<FailedTestIdList>
): string {
  const parts: string[] = [];
  if (testPassed) {
    parts.push("测试通过");
  } else if (cmdResult.timedOut) {
    parts.push("测试超时");
  } else {
    parts.push("测试失败");
  }
  parts.push(`${stats.passed} passed`);
  parts.push(`${stats.failed} failed`);
  if (stats.skipped > 0) {
    parts.push(`${stats.skipped} skipped`);
  }
  parts.push(`exitCode=${cmdResult.exitCode ?? "null"}`);
  parts.push(`duration=${cmdResult.durationMs}ms`);
  const idHint = failedTests ? formatFailedIdHint(failedTests, 5) : "";
  return parts.join(", ") + idHint;
}

/**
 * 原始输出尾部保留字符数（写入 artifacts.testOutputTail，供 fix 阶段重建摘要）。
 */
const RAW_OUTPUT_TAIL_CHARS = 4000 as const;

/**
 * 格式化"失败用例"提示片段（供摘要与 error 文本复用）。
 *
 * 标识按字典序排序后再展示：error 文本参与编排层的"确定性失败指纹"，
 * 排序可消除不同 runner 输出顺序带来的指纹抖动（架构评审 B3）。
 *
 * @param failedTests 失败用例标识列表
 * @param limit 最多列出条数
 * @returns 形如 "；失败用例：a、b（已识别 3 条）"；无失败用例返回空串
 */
function formatFailedIdHint(failedTests: Readonly<FailedTestIdList>, limit = 3): string {
  if (failedTests.ids.length === 0) return "";
  const shown = [...failedTests.ids].sort().slice(0, limit);
  const suffix = failedTests.total > shown.length ? `（已识别 ${failedTests.total} 条）` : "";
  return `；失败用例：${shown.join("、")}${suffix}`;
}

/**
 * 从 prevResults 中提取 plan 阶段产出的任务卡（复用 dev-stage-handler 的实现）
 *
 * @param ctx 阶段执行上下文
 * @returns 任务卡（若无则返回 null）
 */
function extractTaskCardFromPrevResults(ctx: Readonly<P5StageContext>): TaskCard | null {
  for (let i = ctx.prevResults.length - 1; i >= 0; i--) {
    const result = ctx.prevResults[i]!;
    if (result.stage === "plan" && result.kind === "success") {
      const taskCard = result.artifacts["taskCard"];
      if (taskCard && typeof taskCard === "object") {
        return taskCard as TaskCard;
      }
    }
  }
  return null;
}

// ============================================================================
// 6. 工厂函数
// ============================================================================

/**
 * 工厂函数：创建默认 P5VerifyStageHandler 实例
 *
 * @returns P5VerifyStageHandler 实例
 */
export function createVerifyStageHandler(): P5VerifyStageHandler {
  return new P5VerifyStageHandler();
}
