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
 * 6. 解析测试输出（支持 Jest/Mocha/node:test/generic 格式）
 * 7. 构造 CompletionEvidence 制品（G-A4a 证据强制）
 * 8. 调用 guardChain.execute() 做 verify 阶段护栏判定
 * 9. 返回测试结果（pass/fail/skip + 退出码 + 输出摘要）
 *
 * 关键技术决策：
 * - 命令执行：child_process.spawnSync（同步阻塞，捕获 stdout/stderr/exitCode）
 * - 超时控制：spawnSync 的 timeout 选项（超时后 SIGTERM 子进程）
 * - 输出解析：基于正则的多格式解析器（Jest/Mocha/node:test/generic）
 * - 证据强制：CompletionEvidence 必须含 testExitCode + testOutputSummary（G-A4a）
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

import * as childProcess from "node:child_process";

import type { P5StageContext, P5StageHandler, P5StageResult } from "./types";
import { buildGuardContext, createSuccessStageResult, createFailedStageResult, toGuardRecords } from "./types";
import type { CompletionEvidence, TaskCard } from "../guards/types";
import { createPassVerdict } from "../guards/types";

// ============================================================================
// 1. 常量定义
// ============================================================================

/**
 * 测试输出最大摘要长度（字符数）
 *
 * 超出此长度的输出将被截断，仅保留前 N 字符 + "...(truncated)" 后缀。
 * 取值 2000：平衡可观测性与日志体积。
 */
const MAX_OUTPUT_SUMMARY_LENGTH = 2000 as const;

/**
 * 测试输出解析正则表（按优先级排序）
 *
 * 每条规则为 [正则, 解析器名称]，按顺序尝试匹配，命中第一个即停止。
 */
const TEST_OUTPUT_PATTERNS: ReadonlyArray<Readonly<[RegExp, string]>> = Object.freeze([
  // Jest 格式："Tests: 12 passed, 0 failed, 2 skipped"
  [/Tests:\s+(\d+)\s+passed(?:,\s+(\d+)\s+failed)?(?:,\s+(\d+)\s+(?:skipped|todo|skipping))?/i, "jest"],
  // Mocha 格式："X passing (Ys)\nZ failing\nW pending"
  [/(\d+)\s+passing(?:.*?)(\d+)\s+failing(?:.*?)(\d+)\s+pending/is, "mocha"],
  // node:test 格式："# tests N\n# pass N\n# fail N\n# skipped N"
  [
    /#\s*tests\s+(\d+)\s+#\s*pass(?:ed)?\s+(\d+)\s+#\s*fail(?:ed)?\s+(\d+)(?:\s+#\s*skip(?:ped)?\s+(\d+))?/i,
    "node-test",
  ],
  // 通用 PASS/FAIL 格式："N passed, M failed"
  [/(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/i, "generic-pass-fail"],
]);

// ============================================================================
// 2. 类型定义
// ============================================================================

/**
 * 测试结果统计（pass/fail/skip）
 */
export interface TestResultStats {
  /** 通过的测试数量 */
  readonly passed: number;
  /** 失败的测试数量 */
  readonly failed: number;
  /** 跳过的测试数量 */
  readonly skipped: number;
  /** 测试总数（passed + failed + skipped） */
  readonly total: number;
  /** 解析器名称（jest/mocha/node-test/generic） */
  readonly parser: string;
}

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
      const testCommand = ctx.testCommand || "npm test";

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

      // 6. 解析测试输出
      const testStats = parseTestOutput(cmdResult.stdout, cmdResult.stderr);

      // 7. 构造 CompletionEvidence 制品（G-A4a 证据强制）
      const evidence: CompletionEvidence = Object.freeze({
        testCommand,
        testExitCode: cmdResult.exitCode ?? -1,
        testOutputSummary: truncateOutput(cmdResult.stdout || cmdResult.stderr),
        coveragePercent: 0, // 代码覆盖率需要额外工具支持，默认 0
        evaluatorVerdict: cmdResult.exitCode === 0 ? "pass" : "fail",
        executedAt: new Date().toISOString(),
      });

      // 8. 判定测试是否通过
      //    测试失败时不调用 guardChain（G-A4a 仅校验"声明完成"的证据，
      //    测试失败并非声明完成，无需护栏拦截，直接返回 failed 进入 fix 阶段）
      const testPassed = cmdResult.exitCode === 0 && testStats.failed === 0;
      const summary = formatTestSummary(testStats, cmdResult, testPassed);

      // 9. 测试失败 → 直接返回 failed（不调用 guardChain，避免 G-A4a 误判）
      //    设计依据：G-A4a "完成声明证据强制"的语义是禁止自然语言声明完成，
      //    verify 阶段测试失败时并非声明完成，而是如实报告失败，
      //    此时护栏无需介入，直接返回 failed 让 fix 阶段尝试修复。
      if (!testPassed) {
        return createFailedStageResult(
          "verify",
          "failed",
          summary,
          `测试失败：exitCode=${cmdResult.exitCode}, failed=${testStats.failed}`,
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
   * 真实执行测试命令（child_process.spawnSync）
   *
   * @param command 测试命令（如 "npm test"）
   * @param ctx 阶段执行上下文
   * @returns 测试命令执行结果
   */
  private executeTestCommand(command: string, ctx: Readonly<P5StageContext>): TestCommandResult {
    const startTime = Date.now();
    const timeoutMs = Math.max(1000, ctx.testTimeoutSec * 1000);

    // spawnSync 执行命令（shell: true 支持 "npm test" 等复合命令）
    const result = childProcess.spawnSync(command, [], {
      cwd: ctx.projectRoot,
      shell: true,
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
    };
  }
}

// ============================================================================
// 4. 测试输出解析器
// ============================================================================

/**
 * 解析测试输出（stdout + stderr），提取 pass/fail/skip 统计
 *
 * 支持的格式（按优先级）：
 * 1. Jest："Tests: 12 passed, 0 failed, 2 skipped"
 * 2. Mocha："X passing (Ys)\nZ failing\nW pending"
 * 3. node:test："# tests N\n# pass N\n# fail N"
 * 4. 通用："N passed, M failed"
 *
 * 若所有格式都不匹配，返回 {passed:0, failed:0, skipped:0, total:0, parser:"unknown"}
 *
 * @param stdout 标准输出
 * @param stderr 标准错误（作为 fallback 解析源）
 * @returns 测试结果统计
 */
export function parseTestOutput(stdout: string, stderr: string): TestResultStats {
  // 合并 stdout + stderr 作为解析源（部分测试框架输出到 stderr）
  const output = `${stdout}\n${stderr}`;

  for (const [pattern, parserName] of TEST_OUTPUT_PATTERNS) {
    const match = pattern.exec(output);
    if (match) {
      const passed = parseIntOrZero(match[1]);
      const failed = parseIntOrZero(match[2]);
      const skipped = parseIntOrZero(match[3]);
      const total = passed + failed + skipped;
      return Object.freeze({
        passed,
        failed,
        skipped,
        total,
        parser: parserName,
      });
    }
  }

  // 无匹配 → 返回未知统计
  return Object.freeze({
    passed: 0,
    failed: 0,
    skipped: 0,
    total: 0,
    parser: "unknown",
  });
}

/**
 * 安全解析整数（解析失败返回 0）
 *
 * @param value 待解析的字符串（可能为 undefined）
 * @returns 解析后的整数，或 0
 */
function parseIntOrZero(value: string | undefined): number {
  if (!value) return 0;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? 0 : n;
}

// ============================================================================
// 5. 辅助函数
// ============================================================================

/**
 * 截断测试输出到最大摘要长度
 *
 * 超长输出截断后追加 "...(truncated)" 后缀。
 *
 * @param output 原始输出
 * @returns 截断后的输出
 */
function truncateOutput(output: string): string {
  if (!output) return "";
  if (output.length <= MAX_OUTPUT_SUMMARY_LENGTH) {
    return output;
  }
  return output.slice(0, MAX_OUTPUT_SUMMARY_LENGTH) + "...(truncated)";
}

/**
 * 格式化测试摘要
 *
 * @param stats 测试统计
 * @param cmdResult 命令执行结果
 * @param testPassed 是否通过
 * @returns 摘要字符串
 */
function formatTestSummary(stats: TestResultStats, cmdResult: TestCommandResult, testPassed: boolean): string {
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
  return parts.join(", ");
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
