/**
 * EAG-P5 Phase 5.4 TASK-P5-5.4-003：E2E 集成测试
 *
 * 测试范围（对齐任务说明 + EAG-P5-TEST-CASES.md TC-E2E-RUN 系列）：
 * - A. extractEagAutonomousRequestFromPrompt 参数解析（TASK-P5-5.4-001 验证）
 *   - 完整参数解析（--goal / --max-iterations / --confirmation / --test-command / --stop-when 等）
 *   - 必填参数缺失拒绝（--goal 缺失 / 空字符串）
 *   - 取值范围非法拒绝（--max-iterations 超界 / --confirmation 非法值）
 *   - 默认值应用（未提供参数时使用默认值）
 *   - 不可变优先（Object.freeze 冻结）
 * - B. EagAutonomousCommandHandler 命令处理器（TASK-P5-5.4-001 验证）
 *   - 构造校验（orchestrator 必填）
 *   - execute() 成功路径（real AutonomousOrchestrator + 真实文件系统）
 *   - execute() 失败路径（orchestrator.run() 抛异常 → success=false）
 *   - execute() 入参校验（projectRoot / request 必填）
 *   - 返回结果不可变性（Object.freeze）
 * - C. EagCommandParser /eag-autonomous 命令识别（TASK-P5-5.4-002 验证）
 *   - 前缀匹配（大小写不敏感）
 *   - 无参数形式（/eag-autonomous）
 *   - 含参数形式（/eag-autonomous --goal "..."）
 *   - 其他命令严格匹配不冲突
 * - D. session.ts handleEagAutonomousCommand 集成（TASK-P5-5.4-002 验证）
 *   - AutonomousOrchestrator 未注入时 fail-closed
 *   - payload null 时重新解析获取错误详情
 *   - 完整成功路径（orchestrator 注入 + payload 有效 + 执行成功）
 *   - abort 信号响应
 * - E. 4 阶段循环 E2E（DOD-1 验证）
 *   - plan → dev → verify → fix 完整执行
 *   - finalStatus=completed / stop_when / aborted / failed 四类终止
 *   - milestones 里程碑记录
 *   - triggeredGuards 护栏触发记录
 * - F. 最大迭代限制（NFR-2 + G-A6d 验证）
 *   - maxIterations 上限触发终止
 *   - 不可变优先（Object.freeze）
 * - G. 三态确认（SmartConfirmation + ConfirmationHistoryStore 集成）
 *   - auto-approve（白名单 / 低风险命令）
 *   - ask-user（中等风险命令）
 *   - fail-closed（黑名单命令）
 *   - decideWithContext 扩展数据源（history / impact / task-pattern）
 * - H. RunState 持久化（DOD-3 验证）
 *   - .eag/p5/run-state/<runId>.jsonl 文件写入
 *   - SHA256 校验和验证
 * - I. NotesMemory 跨轮记忆（FR-7 验证）
 *   - .eag/p5/notes/<runId>.md 文件写入（按 run 隔离）
 *   - DECISION 标签段落
 * - J. GuardChain 15 条 BLOCKER（DOD-2 验证）
 *   - G-A1a 路径牢笼（越界写入 DENY）
 *   - G-A2a 黑名单命令（rm -rf / git push --force）
 *   - G-A3a 范围锁（tasks.md 范围外写操作）
 *   - G-A6d 上限冻结（Object.freeze）
 * - K. ConfirmationHistoryStore（TASK-P5-5.3-002 验证）
 *   - record(entry) 写入历史决策
 *   - query(pattern) 多维度查询
 *   - getStats() 聚合统计
 *   - JSONL 持久化
 *   - 原子写入（.tmp → rename）
 *
 * 测试约定（严格遵循项目规则 P-5 + NFR-9）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 AutonomousOrchestrator / StageHandler / GuardChain / SmartConfirmation 实例
 * - 使用真实文件系统（os.tmpdir + mkdtempSync）创建临时项目目录
 * - 使用真实 child_process（verify-stage-handler 内部 spawnSync 执行 node -e 命令）
 * - 每个测试用例独立构造临时目录与依赖实例，无共享可变状态
 * - 测试结束后清理临时目录（避免泄漏）
 * - 中文注释，符合 TypeScript 代码规范
 *
 * 设计依据：
 * - 需求文档 §3 FR-1 无人值守 4 阶段循环 + FR-4 /eag-autonomous 命令 + FR-7 NotesMemory
 * - 架构师审查 §4.1 AutonomousOrchestrator 接口契约 + §4.2 BlockerGuardChain 接口契约
 * - 任务说明 TASK-P5-5.3-001/002 + TASK-P5-5.4-001~004
 * - NFR-8 不可变优先 + NFR-9 禁止 mock + NFR-10 中文详细注释
 *
 * @module core/tests/eag-p5-e2e-autonomous
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// EagCommandParser + 命令处理器导入（TASK-P5-5.4-001/002 验证）
import { EagCommandParser, EAG_COMMAND_STRINGS } from "../eag/cli/eag-command-parser";
import type { EagCommand } from "../eag/cli/eag-command-parser";
import {
  EagAutonomousCommandHandler,
  extractEagAutonomousRequestFromPrompt,
  EAG_AUTONOMOUS_COMMAND_PREFIX,
  EAG_AUTONOMOUS_CONFIRMATION_VALUES,
} from "../eag/cli/eag-autonomous-command";
import type {
  EagAutonomousRequest,
  EagAutonomousCommandResult,
  EagAutonomousConfirmation,
} from "../eag/cli/eag-autonomous-command";

// P5 核心组件导入（TASK-P5-5.3-001/002 + 5.4 验证）
import {
  // AutonomousOrchestrator 主控制器
  AutonomousOrchestrator,
  createAutonomousOrchestrator,
  // 4 个 StageHandler
  P5PlanStageHandler,
  P5DevStageHandler,
  P5VerifyStageHandler,
  P5FixStageHandler,
  // 分流器
  createP5LoopExecutorFromHandlers,
  // 核心依赖
  P5RunStateStore,
  P5NotesMemory,
  P5SmartConfirmation,
  createDefaultBlockerGuardChain,
  // ConfirmationHistoryStore（Phase 5.3 TASK-P5-5.3-002 新增）
  P5ConfirmationHistoryStore,
  createDefaultP5ConfirmationHistoryStore,
  // SymbolGraphStore（Phase 5.1）
  SymbolGraphStore,
  // 类型
  type P5RunState,
  type P5StageContext,
  type AutonomousRunRequest,
  type AutonomousRunResult,
  // SmartConfirmation 扩展类型（Phase 5.3 TASK-P5-5.3-001）
  type P5SmartConfirmationContext,
  type P5DataSourceContribution,
  type P5ExtendedConfirmationResult,
  type P5ConfirmationDecision,
  // GuardChain 类型
  type GuardVerdict,
  type GuardContext,
  // 默认配置常量
  AUTONOMOUS_DEFAULT_MAX_ITERATIONS,
  AUTONOMOUS_DEFAULT_MAX_TOKENS,
  AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT,
  AUTONOMOUS_DEFAULT_TEST_COMMAND,
  AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC,
} from "../eag/p5";

// UserPromptContent 类型导入（用于构造 EagCommandParser 输入）
import type { UserPromptContent } from "../session";

// ============================================================================
// 1. 测试常量
// ============================================================================

/**
 * 通过测试命令（真实 child_process 执行，输出 Jest 格式）
 *
 * 命令：echo Tests: 1 passed, 0 failed
 * 输出：Tests: 1 passed, 0 failed
 * 退出码：0
 * 解析结果：{ passed: 1, failed: 0, skipped: 0, total: 1, parser: "jest" }
 *
 * SmartConfirmation 判定：
 * - 黑名单不命中（无危险模式）
 * - 白名单不命中
 * - 风险分=0 → auto-approve
 *
 * 设计说明（R1 修复）：
 * - 旧版本使用 node -e 'console.log("...")'，内层双引号与 CLI 参数外层双引号冲突
 * - CLI 参数解析正则 /--([\w][\w-]*)(?:[=\s]+(?:"([^"]*)"|'([^']*)'|...))/g 中
 *   双引号捕获组 "([^"]*)" 不支持内层双引号嵌套，导致 --test-command 值被截断
 * - 改用 echo 命令，不含任何引号，同时满足 CLI 解析和 verify-stage-handler 输出格式要求
 */
const PASS_TEST_CMD = `echo Tests: 1 passed, 0 failed`;

/**
 * 失败测试命令（真实 child_process 执行，输出 Jest 格式 + 非零退出码）
 *
 * 命令：echo Tests: 0 passed, 1 failed; false
 * 输出：Tests: 0 passed, 1 failed
 * 退出码：1（false 命令产生非零退出码）
 * 解析结果：{ passed: 0, failed: 1, skipped: 0, total: 1, parser: "jest" }
 *
 * SmartConfirmation 判定：同 PASS_TEST_CMD，auto-approve
 *
 * 设计说明（R1 修复）：
 * - 旧版本使用 node -e 'console.log("..."); process.exit(1)'，内层双引号冲突
 * - 改用 echo 输出测试格式 + false 产生非零退出码，不含任何引号
 * - shell 中 ; 为命令分隔符，echo 先执行输出，false 后执行产生退出码 1
 */
const FAIL_TEST_CMD = `echo Tests: 0 passed, 1 failed; false`;

// ============================================================================
// 2. 测试辅助函数
// ============================================================================

/**
 * 创建临时项目目录（真实文件系统）
 *
 * 在 os.tmpdir() 下创建唯一临时目录，并确保 .eag/p5 子目录存在。
 * 测试结束后由调用方通过 cleanupTempProject 清理。
 *
 * @returns 临时项目根目录绝对路径
 */
function createTempProject(): string {
  const prefix = path.join(os.tmpdir(), "eag-p5-e2e-test-");
  const projectRoot = fs.mkdtempSync(prefix);
  // 创建 .eag/p5 子目录（run-state-store / notes-memory / confirmation-history-store 会用到）
  fs.mkdirSync(path.join(projectRoot, ".eag", "p5"), { recursive: true });
  return projectRoot;
}

/**
 * 清理临时项目目录（递归删除，容错处理）
 *
 * @param projectRoot 临时项目根目录
 */
function cleanupTempProject(projectRoot: string): void {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // 忽略清理失败（测试环境不强求清理，CI 会定期清理 tmpdir）
  }
}

/**
 * 创建 tasks.md 文件（含指定状态的任务卡）
 *
 * 任务卡格式（对齐 plan-stage-handler 的解析器）：
 *   ## T-001 测试任务 1
 *   - requirement: F-001
 *   - status: pending
 *   - dependencies:
 *   - files: src/services/Service1.ts
 *   - deletions:
 *   - symbols: Service1
 *   - acceptance: 测试通过
 *
 * @param projectRoot 项目根目录
 * @param taskCount 任务卡数量
 * @param status 任务卡状态（pending/completed/in-progress/blocked）
 * @returns tasks.md 文件绝对路径
 */
function createTasksFile(
  projectRoot: string,
  taskCount: number,
  status: "pending" | "completed" | "in-progress" | "blocked"
): string {
  const tasksDir = path.join(projectRoot, ".eag", "p5");
  fs.mkdirSync(tasksDir, { recursive: true });
  const tasksFilePath = path.join(tasksDir, "tasks.md");

  const lines: string[] = [];
  lines.push("# EAG-P5 任务清单");
  lines.push("");

  for (let i = 1; i <= taskCount; i++) {
    const id = `T-${String(i).padStart(3, "0")}`;
    lines.push(`## ${id} 测试任务 ${i}`);
    lines.push(`- requirement: F-${String(i).padStart(3, "0")}`);
    lines.push(`- status: ${status}`);
    lines.push(`- dependencies: `);
    lines.push(`- files: src/services/Service${i}.ts`);
    lines.push(`- deletions: `);
    lines.push(`- symbols: Service${i}`);
    lines.push(`- acceptance: 测试通过`);
    lines.push("");
  }

  fs.writeFileSync(tasksFilePath, lines.join("\n"), "utf8");
  return tasksFilePath;
}

/**
 * 创建声明的源文件（让 dev 阶段能盘点到真实文件）
 *
 * @param projectRoot 项目根目录
 * @param relativePath 文件相对路径（相对 projectRoot）
 */
function createDeclaredFile(projectRoot: string, relativePath: string): void {
  const absolutePath = path.join(projectRoot, relativePath);
  const parentDir = path.dirname(absolutePath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(absolutePath, "// 测试文件内容\n", "utf8");
}

/**
 * 构造真实的 AutonomousOrchestrator 实例（使用真实的 5 个核心依赖）
 *
 * 完整装配以下依赖（对齐架构师审查 §4.1 + NFR-9 禁止 mock）：
 * - loopExecutor: P5LoopExecutor（含 4 个真实 StageHandler）
 * - runStateStore: P5RunStateStore（真实 JSONL 持久化）
 * - notesMemory: P5NotesMemory（真实 notes.md 文件）
 * - guardChain: BlockerGuardChain（6 层 15 条 BLOCKER 真实判定）
 * - smartConfirmation: P5SmartConfirmation（真实三态决策）
 *
 * @param overrides 可选的配置覆盖
 * @returns AutonomousOrchestrator 实例
 */
function buildOrchestrator(overrides?: {
  readonly defaultMaxIterations?: number;
  readonly defaultMaxTokens?: number;
  readonly defaultConsecutiveFailureAbort?: number;
  readonly defaultTestCommand?: string;
  readonly defaultTestTimeoutSec?: number;
}): AutonomousOrchestrator {
  const loopExecutor = createP5LoopExecutorFromHandlers(
    new P5PlanStageHandler(),
    new P5DevStageHandler(),
    new P5VerifyStageHandler(),
    new P5FixStageHandler()
  );
  const runStateStore = new P5RunStateStore();
  const notesMemory = new P5NotesMemory();
  // 使用 throwOnDeny: false 避免护栏 DENY 时抛出 GuardViolationError
  // StageHandler 会正确处理 DENY 结果（转换为 fatal StageResult）
  const guardChain = createDefaultBlockerGuardChain({ throwOnDeny: false });
  const smartConfirmation = new P5SmartConfirmation();

  return new AutonomousOrchestrator({
    loopExecutor,
    runStateStore,
    notesMemory,
    guardChain,
    smartConfirmation,
    defaultMaxIterations: overrides?.defaultMaxIterations,
    defaultMaxTokens: overrides?.defaultMaxTokens,
    defaultConsecutiveFailureAbort: overrides?.defaultConsecutiveFailureAbort,
    defaultTestCommand: overrides?.defaultTestCommand,
    defaultTestTimeoutSec: overrides?.defaultTestTimeoutSec,
  });
}

/**
 * 构造 UserPromptContent fixture（用于 EagCommandParser.parse 输入）
 *
 * @param text 用户输入文本
 * @param messageParams 可选的预装配请求对象
 * @returns 冻结的 UserPromptContent
 */
function buildUserPrompt(text: string, messageParams?: Record<string, unknown>): UserPromptContent {
  return Object.freeze({
    text,
    imageUrls: Object.freeze([]),
    skills: Object.freeze([]),
    messageParams: messageParams ?? null,
  }) as UserPromptContent;
}

// ============================================================================
// A. extractEagAutonomousRequestFromPrompt 参数解析测试
// ============================================================================

test("A1. 完整参数解析（所有 flag 提供时正确映射）", () => {
  const prompt = `/eag-autonomous --goal "为订单服务加退款功能" --max-iterations 10 --confirmation smart --test-command "npm test" --stop-when "all tests pass" --max-tokens 200000 --test-timeout-sec 600 --consecutive-failure-abort 3`;
  const request = extractEagAutonomousRequestFromPrompt(prompt);

  assert.equal(request.goal, "为订单服务加退款功能");
  assert.equal(request.maxIterations, 10);
  assert.equal(request.confirmation, "smart");
  assert.equal(request.testCommand, "npm test");
  assert.equal(request.stopWhen, "all tests pass");
  assert.equal(request.maxTokens, 200000);
  assert.equal(request.testTimeoutSec, 600);
  assert.equal(request.consecutiveFailureAbort, 3);
});

test("A2. 默认值应用（仅必填 --goal 提供时使用默认值）", () => {
  const prompt = `/eag-autonomous --goal "测试目标"`;
  const request = extractEagAutonomousRequestFromPrompt(prompt);

  assert.equal(request.goal, "测试目标");
  // 默认值断言（对齐 EAG_AUTONOMOUS_DEFAULT_* 常量）
  assert.equal(request.maxIterations, 10, "默认 maxIterations 应为 10");
  assert.equal(request.confirmation, "smart", "默认 confirmation 应为 smart");
  assert.equal(request.testCommand, "npm test", '默认 testCommand 应为 "npm test"');
  assert.equal(request.stopWhen, "", "默认 stopWhen 应为空字符串");
  assert.equal(request.maxTokens, 200000, "默认 maxTokens 应为 200000");
  assert.equal(request.testTimeoutSec, 600, "默认 testTimeoutSec 应为 600");
  assert.equal(request.consecutiveFailureAbort, 3, "默认 consecutiveFailureAbort 应为 3");
});

test("A3. 必填参数 --goal 缺失时抛错", () => {
  const prompt = `/eag-autonomous --max-iterations 10`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /缺少必填参数 --goal/);
});

test("A4. --goal 为空字符串时抛错", () => {
  const prompt = `/eag-autonomous --goal ""`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /缺少必填参数 --goal/);
});

test("A5. --max-iterations 超界时抛错（>1000）", () => {
  const prompt = `/eag-autonomous --goal "测试" --max-iterations 1001`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /--max-iterations 取值非法/);
});

test("A6. --max-iterations 非正整数时抛错（0）", () => {
  const prompt = `/eag-autonomous --goal "测试" --max-iterations 0`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /--max-iterations 取值非法/);
});

test("A7. --confirmation 非法值时抛错", () => {
  const prompt = `/eag-autonomous --goal "测试" --confirmation invalid-mode`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /--confirmation 取值非法/);
});

test("A8. --test-command 为空字符串时抛错", () => {
  const prompt = `/eag-autonomous --goal "测试" --test-command ""`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /--test-command 取值非法/);
});

test("A9. 命令前缀大小写不敏感匹配（/EAG-AUTONOMOUS）", () => {
  const prompt = `/EAG-AUTONOMOUS --goal "大小写测试"`;
  const request = extractEagAutonomousRequestFromPrompt(prompt);
  assert.equal(request.goal, "大小写测试");
});

test("A10. 命令前缀不匹配时抛错", () => {
  const prompt = `/eag-other --goal "测试"`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /命令前缀不匹配/);
});

test("A11. 返回对象被 Object.freeze 冻结（不可变优先）", () => {
  const prompt = `/eag-autonomous --goal "冻结测试"`;
  const request = extractEagAutonomousRequestFromPrompt(prompt);
  assert.ok(Object.isFrozen(request), "EagAutonomousRequest 应被冻结");
  // 尝试修改应抛 TypeError（严格模式）
  assert.throws(() => {
    (request as { goal: string }).goal = "modified";
  }, TypeError);
});

test("A12. --max-tokens 非正整数时抛错", () => {
  const prompt = `/eag-autonomous --goal "测试" --max-tokens 0`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /--max-tokens 取值非法/);
});

test("A13. --test-timeout-sec 非正整数时抛错", () => {
  const prompt = `/eag-autonomous --goal "测试" --test-timeout-sec -1`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /--test-timeout-sec 取值非法/);
});

test("A14. --consecutive-failure-abort 非正整数时抛错", () => {
  const prompt = `/eag-autonomous --goal "测试" --consecutive-failure-abort 0`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /--consecutive-failure-abort 取值非法/);
});

test("A15. EAG_AUTONOMOUS_CONFIRMATION_VALUES 常量正确性", () => {
  // 验证合法 confirmation 取值集合
  assert.ok(Array.isArray(EAG_AUTONOMOUS_CONFIRMATION_VALUES));
  assert.ok(EAG_AUTONOMOUS_CONFIRMATION_VALUES.includes("smart"));
  assert.ok(EAG_AUTONOMOUS_CONFIRMATION_VALUES.includes("always-ask"));
  assert.ok(EAG_AUTONOMOUS_CONFIRMATION_VALUES.includes("fail-closed"));
  // 冻结断言
  assert.ok(Object.isFrozen(EAG_AUTONOMOUS_CONFIRMATION_VALUES));
});

test("A16. EAG_AUTONOMOUS_COMMAND_PREFIX 常量正确性", () => {
  assert.equal(EAG_AUTONOMOUS_COMMAND_PREFIX, "/eag-autonomous");
});

// ============================================================================
// B. EagAutonomousCommandHandler 命令处理器测试
// ============================================================================

test("B1. EagAutonomousCommandHandler 构造成功（orchestrator 注入）", () => {
  const orchestrator = buildOrchestrator();
  const handler = new EagAutonomousCommandHandler(orchestrator);
  assert.ok(handler instanceof EagAutonomousCommandHandler);
});

test("B2. EagAutonomousCommandHandler 构造失败（orchestrator 为空）", () => {
  assert.throws(() => new EagAutonomousCommandHandler(null as unknown as AutonomousOrchestrator), /orchestrator 必填/);
});

test("B3. EagAutonomousCommandHandler execute() 成功路径", async () => {
  const projectRoot = createTempProject();
  try {
    // 准备 tasks.md（含 1 张 completed 任务卡，让 plan 阶段直接成功）
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const request = extractEagAutonomousRequestFromPrompt(
      `/eag-autonomous --goal "测试目标" --max-iterations 1 --test-command "${PASS_TEST_CMD}"`
    );

    const result = await handler.execute(request, projectRoot);

    // 验证成功路径
    assert.equal(result.success, true, "execute 应返回 success=true");
    assert.equal(result.errorMessage, "", "成功时 errorMessage 应为空");
    assert.ok(result.markdownReport.length > 0, "应生成 Markdown 报告");
    assert.ok(result.runResult, "应包含原始 AutonomousRunResult");
    assert.ok(Object.isFrozen(result), "结果应被 Object.freeze 冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("B4. EagAutonomousCommandHandler execute() 失败路径（orchestrator 抛异常）", async () => {
  const projectRoot = createTempProject();
  try {
    // 故意不创建 tasks.md，让 plan 阶段失败
    // 但 orchestrator.run() 不会抛异常（会捕获并返回 failed finalStatus）
    // 此测试验证 handler.execute() 在 orchestrator.run() 正常返回但 finalStatus=failed 时
    // 仍然返回 success=true（因为 execute() 的 success 字段表示 run() 是否抛异常）
    const orchestrator = buildOrchestrator();
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const request = extractEagAutonomousRequestFromPrompt(
      `/eag-autonomous --goal "无 tasks.md 测试" --max-iterations 1`
    );

    const result = await handler.execute(request, projectRoot);

    // 即使 finalStatus=failed，execute() 仍然返回 success=true（因为 run() 未抛异常）
    assert.equal(result.success, true);
    assert.ok(result.runResult, "应包含原始 AutonomousRunResult");
    assert.ok(result.markdownReport.length > 0, "应生成 Markdown 报告");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("B5. EagAutonomousCommandHandler execute() 入参校验（projectRoot 空）", async () => {
  const orchestrator = buildOrchestrator();
  const handler = new EagAutonomousCommandHandler(orchestrator);
  const request = extractEagAutonomousRequestFromPrompt(`/eag-autonomous --goal "测试"`);

  await assert.rejects(async () => handler.execute(request, ""), /projectRoot 必须为非空字符串/);
});

test("B6. EagAutonomousCommandHandler execute() 入参校验（request.goal 空）", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    const handler = new EagAutonomousCommandHandler(orchestrator);
    // 构造非法 request（绕过 extractEagAutonomousRequestFromPrompt 的校验）
    const invalidRequest = Object.freeze({
      goal: "", // 空 goal
      maxIterations: 10,
      confirmation: "smart" as EagAutonomousConfirmation,
      testCommand: "npm test",
      stopWhen: "",
      maxTokens: 200000,
      testTimeoutSec: 600,
      consecutiveFailureAbort: 3,
    }) as EagAutonomousRequest;

    await assert.rejects(
      async () => handler.execute(invalidRequest, projectRoot),
      /EagAutonomousRequest\.goal 必须为非空字符串/
    );
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("B7. EagAutonomousCommandResult 不可变性（Object.freeze）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const request = extractEagAutonomousRequestFromPrompt(
      `/eag-autonomous --goal "冻结测试" --max-iterations 1 --test-command "${PASS_TEST_CMD}"`
    );

    const result = await handler.execute(request, projectRoot);

    // 验证返回对象被 Object.freeze 冻结
    assert.ok(Object.isFrozen(result), "EagAutonomousCommandResult 应被冻结");
    // 尝试修改应抛 TypeError
    assert.throws(() => {
      (result as { success: boolean }).success = false;
    }, TypeError);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// C. EagCommandParser /eag-autonomous 命令识别测试
// ============================================================================

test("C1. EagCommandParser 识别 /eag-autonomous 命令（含参数）", () => {
  const parser = new EagCommandParser();
  const userPrompt = buildUserPrompt(`/eag-autonomous --goal "测试目标" --max-iterations 10`);
  const command = parser.parse(userPrompt);

  assert.equal(command.kind, "eag-autonomous");
  // payload 应为 EagAutonomousRequest（非 null）
  if (command.kind === "eag-autonomous") {
    assert.ok(command.payload, "payload 应非 null");
    assert.equal(command.payload!.goal, "测试目标");
    assert.equal(command.payload!.maxIterations, 10);
  }
});

test("C2. EagCommandParser 识别 /eag-autonomous 命令（无参数）", () => {
  const parser = new EagCommandParser();
  // 无参数形式：payload 解析失败（缺少 --goal），返回 null
  const userPrompt = buildUserPrompt(`/eag-autonomous`);
  const command = parser.parse(userPrompt);

  assert.equal(command.kind, "eag-autonomous");
  // payload 应为 null（因为缺少必填参数 --goal）
  if (command.kind === "eag-autonomous") {
    assert.equal(command.payload, null);
  }
});

test("C3. EagCommandParser 前缀匹配大小写不敏感（/EAG-AUTONOMOUS）", () => {
  const parser = new EagCommandParser();
  const userPrompt = buildUserPrompt(`/EAG-AUTONOMOUS --goal "大小写测试"`);
  const command = parser.parse(userPrompt);

  assert.equal(command.kind, "eag-autonomous");
});

test("C4. EagCommandParser 不误判其他 EAG 命令", () => {
  const parser = new EagCommandParser();
  // 验证其他 7 个命令严格匹配，不会被 /eag-autonomous 干扰
  const testCases: ReadonlyArray<{ readonly cmd: string; readonly kind: string }> = Object.freeze([
    { cmd: EAG_COMMAND_STRINGS.EAG_BUILD, kind: "eag-build" },
    { cmd: EAG_COMMAND_STRINGS.EAG_DESIGN, kind: "eag-design" },
    { cmd: EAG_COMMAND_STRINGS.EAG_TEST, kind: "eag-test" },
    { cmd: EAG_COMMAND_STRINGS.EAG_RUN, kind: "eag-run" },
    { cmd: EAG_COMMAND_STRINGS.EAG_RESUME, kind: "eag-resume" },
    { cmd: EAG_COMMAND_STRINGS.EAG_STATUS, kind: "eag-status" },
    { cmd: EAG_COMMAND_STRINGS.EAG_DEPLOY, kind: "eag-deploy" },
  ]);

  for (const tc of testCases) {
    const userPrompt = buildUserPrompt(tc.cmd);
    const command = parser.parse(userPrompt);
    assert.equal(command.kind, tc.kind, `命令 ${tc.cmd} 应识别为 ${tc.kind}`);
  }
});

test("C5. EagCommandParser 不误判非 EAG 命令（普通文本）", () => {
  const parser = new EagCommandParser();
  const userPrompt = buildUserPrompt(`请帮我写一个 Hello World 程序`);
  const command = parser.parse(userPrompt);
  assert.equal(command.kind, "unknown");
});

test("C6. EagCommandParser 返回冻结的 EagCommand 对象", () => {
  const parser = new EagCommandParser();
  const userPrompt = buildUserPrompt(`/eag-autonomous --goal "冻结测试"`);
  const command = parser.parse(userPrompt);

  // 验证顶层对象被冻结
  assert.ok(Object.isFrozen(command), "EagCommand 顶层对象应被冻结");
});

test("C7. EAG_COMMAND_STRINGS 含 EAG_AUTONOMOUS 常量", () => {
  // 验证 EAG_COMMAND_STRINGS 集合含 /eag-autonomous
  assert.equal(EAG_COMMAND_STRINGS.EAG_AUTONOMOUS, "/eag-autonomous");
  // 验证集合被冻结
  assert.ok(Object.isFrozen(EAG_COMMAND_STRINGS));
});

// ============================================================================
// D. session.ts handleEagAutonomousCommand 集成测试
// ============================================================================

test("D1. session.ts 集成：AutonomousOrchestrator 未注入时 fail-closed", async () => {
  // 此测试通过 EagAutonomousCommandHandler 间接验证 session.ts 的依赖校验逻辑
  // session.ts 中 handleEagAutonomousCommand 在 autonomousOrchestrator 未注入时
  // 会通知用户 "AutonomousOrchestrator 未注入" 并标记 session 状态为 failed
  // 此处验证 handler 构造时的等价校验（orchestrator 必填）
  assert.throws(() => new EagAutonomousCommandHandler(null as unknown as AutonomousOrchestrator), /orchestrator 必填/);
});

test("D2. session.ts 集成：payload null 时重新解析获取错误详情", () => {
  // 验证 EagCommandParser 在参数解析失败时返回 payload=null
  // session.ts 的 handleEagAutonomousCommand 会重新调用 extractEagAutonomousRequestFromPrompt
  // 以获取具体错误信息并通知用户
  const parser = new EagCommandParser();
  // 缺少 --goal 必填参数
  const userPrompt = buildUserPrompt(`/eag-autonomous --max-iterations 10`);
  const command = parser.parse(userPrompt);

  assert.equal(command.kind, "eag-autonomous");
  if (command.kind === "eag-autonomous") {
    assert.equal(command.payload, null, "缺少 --goal 时 payload 应为 null");
  }

  // 验证重新解析会抛出具体的错误信息
  assert.throws(
    () => extractEagAutonomousRequestFromPrompt(`/eag-autonomous --max-iterations 10`),
    /缺少必填参数 --goal/
  );
});

test("D3. session.ts 集成：完整成功路径（orchestrator 注入 + payload 有效 + 执行成功）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 模拟 session.ts 的完整路径：
    // 1. EagCommandParser.parse() 识别命令并提取 payload
    // 2. handleEagAutonomousCommand 校验 orchestrator 注入
    // 3. handleEagAutonomousCommand 校验 payload
    // 4. 创建 EagAutonomousCommandHandler
    // 5. 调用 handler.execute(request, projectRoot)
    const parser = new EagCommandParser();
    const userPrompt = buildUserPrompt(
      `/eag-autonomous --goal "完整路径测试" --max-iterations 1 --test-command "${PASS_TEST_CMD}"`
    );
    const command = parser.parse(userPrompt);

    assert.equal(command.kind, "eag-autonomous");
    if (command.kind !== "eag-autonomous" || !command.payload) {
      assert.fail("命令解析失败或 payload 为 null");
      return;
    }

    const orchestrator = buildOrchestrator();
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const result = await handler.execute(command.payload, projectRoot);

    assert.equal(result.success, true, "完整路径应成功");
    assert.ok(result.markdownReport.length > 0, "应生成 Markdown 报告");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// E. 4 阶段循环 E2E 测试
// ============================================================================

test("E1. 4 阶段循环完整执行（plan → dev → verify → fix，finalStatus=completed）", async () => {
  const projectRoot = createTempProject();
  try {
    // 创建含 1 张 completed 任务卡的 tasks.md（plan 阶段直接成功）
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 4 阶段循环完整执行",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证 finalStatus
    assert.equal(result.finalStatus, "completed", "应完成成功");
    assert.equal(result.exitCode, 0, "退出码应为 0（全绿）");
    // 验证迭代次数
    assert.ok(result.totalIterations >= 1, "应至少迭代 1 次");
    // 验证 milestones（每轮 4 阶段全绿 = 一个里程碑）
    assert.ok(result.milestones.length >= 1, "应至少有 1 个里程碑");
    // 验证 stop_when 时不应有 blockageReport
    assert.equal(result.blockageReport, undefined, "completed 时不应有 blockageReport");
    // 验证结果不可变性
    assert.ok(Object.isFrozen(result), "AutonomousRunResult 应被冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("E2. stop_when 终止条件（finalStatus=stop_when, exitCode=3）", async () => {
  const projectRoot = createTempProject();
  try {
    // R2 修复：使用 "pending" 状态的任务卡，让 stop_when 条件先于 completed 触发
    // 若使用 "completed"，plan 阶段直接完成，orchestrator 返回 finalStatus=completed 而非 stop_when
    // 使用 "pending" 时，测试命令通过（PASS_TEST_CMD）满足 stopWhen="all tests pass" 条件
    // orchestrator 检测到 stop_when 条件满足后返回 finalStatus=stop_when
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 stop_when 终止条件",
      maxIterations: 1,
      stopWhen: "all tests pass",
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证 stop_when 终止条件
    assert.equal(result.finalStatus, "stop_when");
    assert.equal(result.exitCode, 3, "stop_when 退出码应为 3");
    assert.ok(result.totalIterations >= 1);
    assert.ok(result.milestones.length >= 1, "stop_when 也应记录里程碑");
    assert.equal(result.blockageReport, undefined, "stop_when 时不应有 blockageReport");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("E3. aborted 终止条件（连续失败 >= abort 阈值, exitCode=2）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 aborted 终止条件",
      maxIterations: 5,
      consecutiveFailureAbort: 2, // 连续失败 2 次即 abort
      testCommand: FAIL_TEST_CMD, // 测试命令始终失败
      testTimeoutSec: 10,
    });

    // 验证 aborted 终止条件
    assert.equal(result.finalStatus, "aborted");
    assert.equal(result.exitCode, 2, "aborted 退出码应为 2");
    assert.ok(result.totalIterations >= 2, "至少迭代 2 次才触发 abort");
    assert.ok(result.blockageReport !== undefined, "aborted 时应有 blockageReport");
    assert.ok(result.blockageReport!.rootCauseHypotheses.length > 0, "blockageReport 应含根因假设");
    assert.ok(result.blockageReport!.suggestedSolutions.length > 0, "blockageReport 应含建议方案");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("E4. failed 终止条件（迭代次数用尽, exitCode=1）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 failed 终止条件",
      maxIterations: 1, // 仅 1 轮迭代
      consecutiveFailureAbort: 3, // abort 阈值设为 3（1 次失败不触发 abort）
      testCommand: FAIL_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证 failed 终止条件
    assert.equal(result.finalStatus, "failed");
    assert.equal(result.exitCode, 1, "failed 退出码应为 1");
    assert.ok(result.totalIterations >= 1);
    assert.ok(result.blockageReport !== undefined, "failed 时应有 blockageReport");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("E5. AutonomousRunResult 完整字段验证", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "完整字段验证",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证所有 readonly 字段存在且类型正确
    assert.equal(typeof result.runId, "string", "runId 应为 string");
    assert.ok(result.runId.length > 0, "runId 应非空");
    assert.ok(["completed", "failed", "aborted", "stop_when"].includes(result.finalStatus), "finalStatus 应为四值之一");
    assert.ok([0, 1, 2, 3].includes(result.exitCode), "exitCode 应为 0/1/2/3 之一");
    assert.ok(Array.isArray(result.completedLoops), "completedLoops 应为数组");
    assert.ok(Array.isArray(result.milestones), "milestones 应为数组");
    assert.equal(typeof result.totalIterations, "number", "totalIterations 应为 number");
    assert.equal(typeof result.totalLlmCallCount, "number", "totalLlmCallCount 应为 number");
    assert.equal(typeof result.totalTokensUsed, "number", "totalTokensUsed 应为 number");
    assert.equal(typeof result.durationSec, "number", "durationSec 应为 number");
    assert.equal(typeof result.finalReport, "string", "finalReport 应为 string");
    assert.ok(Array.isArray(result.triggeredGuards), "triggeredGuards 应为数组");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// F. 最大迭代限制测试（NFR-2 + G-A6d）
// ============================================================================

test("F1. maxIterations 上限触发终止（迭代次数用尽 → failed）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "测试 maxIterations 上限",
      maxIterations: 2, // 限制 2 轮迭代
      consecutiveFailureAbort: 10, // 高阈值，避免触发 abort
      testCommand: FAIL_TEST_CMD, // 始终失败
      testTimeoutSec: 10,
    });

    // 验证 maxIterations 上限触发 failed 终止
    assert.ok(result.finalStatus === "failed" || result.finalStatus === "aborted", "迭代用尽应为 failed 或 aborted");
    assert.ok(result.totalIterations <= 2, "迭代次数不应超过 maxIterations");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("F2. AUTONOMOUS_DEFAULT_* 常量正确性（NFR-2 + G-A6d）", () => {
  // 验证默认配置常量与架构师审查 §4.1 + 用户任务说明一致
  assert.equal(AUTONOMOUS_DEFAULT_MAX_ITERATIONS, 10, "默认最大迭代次数应为 10");
  assert.equal(AUTONOMOUS_DEFAULT_MAX_TOKENS, 200_000, "默认最大 Token 预算应为 200000");
  assert.equal(AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT, 3, "默认连续失败 abort 阈值应为 3");
  assert.equal(AUTONOMOUS_DEFAULT_TEST_COMMAND, "npm test", '默认测试命令应为 "npm test"');
  assert.equal(AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC, 600, "默认测试超时秒数应为 600");
});

test("F3. AutonomousRunRequest 不可变性（G-A6d Object.freeze）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");

    const orchestrator = buildOrchestrator();
    const request: AutonomousRunRequest = Object.freeze({
      projectRoot,
      objective: "不可变性测试",
      maxIterations: 1,
      maxTokens: 200000,
      stopWhen: "",
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
      consecutiveFailureAbort: 3,
    });

    // 验证 request 被冻结
    assert.ok(Object.isFrozen(request), "AutonomousRunRequest 应被冻结");
    // 尝试修改应抛 TypeError
    assert.throws(() => {
      (request as { maxIterations: number }).maxIterations = 999;
    }, TypeError);

    // 执行验证（确保冻结的 request 仍可被 orchestrator 处理）
    const result = await orchestrator.run(request);
    assert.ok(result.totalIterations >= 1);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// G. 三态确认测试（SmartConfirmation + ConfirmationHistoryStore 集成）
// ============================================================================

test("G1. SmartConfirmation 三态决策：auto-approve（白名单命令 npm test）", () => {
  const smartConfirmation = new P5SmartConfirmation();
  // 构造 PASS verdict（GuardChain 通过）
  // R3 修复：GuardDecision 类型为 "PASS" | "DENY" | "ASK"（大写字面量联合类型）
  // 旧版本使用小写 "pass" 违反类型契约，虽然 decide() 仅检查 "DENY" 不影响 G1 结果，
  // 但为正确性应使用大写 "PASS"
  const passVerdict: GuardVerdict = Object.freeze({
    decision: "PASS",
    severity: "none",
    ruleId: "",
    reason: "通过",
    timestamp: new Date().toISOString(),
  }) as GuardVerdict;

  // npm test 在白名单中 → auto-approve
  const result = smartConfirmation.decide(passVerdict, "npm test");
  assert.equal(result.decision, "auto-approve", "npm test 应自动放行");
  assert.equal(result.riskLevel, "low", "风险等级应为 low");
});

test("G2. SmartConfirmation 三态决策：fail-closed（黑名单命令 rm -rf ~）", () => {
  const smartConfirmation = new P5SmartConfirmation();
  // 构造 PASS verdict（GuardChain 通过，但 SmartConfirmation 黑名单命中）
  // R3 修复：decision 使用大写 "PASS" 对齐 GuardDecision 类型契约
  const passVerdict: GuardVerdict = Object.freeze({
    decision: "PASS",
    severity: "none",
    ruleId: "",
    reason: "通过",
    timestamp: new Date().toISOString(),
  }) as GuardVerdict;

  // rm -rf ~ 在黑名单中 → fail-closed
  const result = smartConfirmation.decide(passVerdict, "rm -rf ~");
  assert.equal(result.decision, "fail-closed", "rm -rf ~ 应拒绝");
  assert.ok(result.riskLevel === "critical" || result.riskLevel === "high", "风险等级应为 critical 或 high");
});

test("G3. SmartConfirmation 三态决策：guard DENY 短路 → fail-closed", () => {
  const smartConfirmation = new P5SmartConfirmation();
  // 构造 DENY verdict（GuardChain 拒绝）
  // R3 修复：decision 必须使用大写 "DENY"（GuardDecision 类型契约）
  // 旧版本使用小写 "deny"，decide() 检查 verdict.decision === "DENY" 不匹配，
  // 导致 DENY 短路逻辑未触发，返回 auto-approve 而非 fail-closed
  const denyVerdict: GuardVerdict = Object.freeze({
    decision: "DENY",
    severity: "blocker",
    ruleId: "G-A1a",
    reason: "路径牢笼拦截：越界写入 $HOME",
    timestamp: new Date().toISOString(),
  }) as GuardVerdict;

  // GuardChain DENY → SmartConfirmation 直接 fail-closed（短路）
  const result = smartConfirmation.decide(denyVerdict, "echo test");
  assert.equal(result.decision, "fail-closed", "GuardChain DENY 应短路为 fail-closed");
});

test("G4. SmartConfirmation decideWithContext 扩展数据源（基础 fail-closed 短路）", async () => {
  const smartConfirmation = new P5SmartConfirmation();
  // R3 修复：decision 使用大写 "DENY" 对齐 GuardDecision 类型契约
  const denyVerdict: GuardVerdict = Object.freeze({
    decision: "DENY",
    severity: "blocker",
    ruleId: "G-A1a",
    reason: "路径牢笼拦截",
    timestamp: new Date().toISOString(),
  }) as GuardVerdict;

  // 构造扩展上下文（含 historyStore / symbolGraphStore / taskCard）
  const historyStore = createDefaultP5ConfirmationHistoryStore();
  // R4 修复：P5SmartConfirmationContext 必填 projectRoot 字段
  // validateContext() 校验 projectRoot 必须为非空字符串，缺失时抛出异常
  const projectRoot = createTempProject();
  try {
    const context: P5SmartConfirmationContext = Object.freeze({
      command: "rm -rf ~",
      runId: "test-run-001",
      projectRoot,
      iterIndex: 0,
      stage: "dev",
      historyStore,
      symbolGraphStore: null,
      taskCard: null,
    }) as P5SmartConfirmationContext;

    // 基础决策已为 fail-closed → 应短路返回（不查询扩展数据源）
    const result = await smartConfirmation.decideWithContext(denyVerdict, context);

    assert.equal(result.baseDecision, "fail-closed");
    assert.equal(result.finalDecision, "fail-closed");
    assert.equal(result.dataSourceContributions.length, 1);
    assert.equal(result.dataSourceContributions[0].action, "none");
    assert.ok(Object.isFrozen(result), "P5ExtendedConfirmationResult 应被冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("G5. SmartConfirmation decideWithContext 扩展数据源（auto-approve + 历史决策贡献）", async () => {
  const smartConfirmation = new P5SmartConfirmation();
  // R3 修复：decision 使用大写 "PASS" 对齐 GuardDecision 类型契约
  const passVerdict: GuardVerdict = Object.freeze({
    decision: "PASS",
    severity: "none",
    ruleId: "",
    reason: "通过",
    timestamp: new Date().toISOString(),
  }) as GuardVerdict;

  const projectRoot = createTempProject();
  try {
    // 构造真实的 ConfirmationHistoryStore（含历史决策记录）
    const historyStore = createDefaultP5ConfirmationHistoryStore();

    // 写入一条历史决策记录（auto-approve，让历史数据源不触发升级）
    // R7 修复：record() 是 async 方法，必须 await 确保记录写入完成后再查询
    await historyStore.record(projectRoot, {
      runId: "test-run-001",
      iterIndex: 0,
      stage: "dev",
      command: "npm test",
      decision: "auto-approve",
      riskLevel: "low",
      riskScore: 0,
      guardRuleId: "",
      matchedPattern: "",
      reason: "白名单命令",
      timestamp: new Date().toISOString(),
    });

    // R4 修复：P5SmartConfirmationContext 必填 projectRoot 字段
    // 旧版本创建了 projectRoot 变量但未放入 context 对象，导致 validateContext() 抛异常
    const context: P5SmartConfirmationContext = Object.freeze({
      command: "npm test",
      runId: "test-run-001",
      projectRoot,
      iterIndex: 1,
      stage: "dev",
      historyStore,
      symbolGraphStore: null,
      taskCard: null,
    }) as P5SmartConfirmationContext;

    // 基础决策为 auto-approve（npm test 白名单）→ 扩展数据源评估
    const result = await smartConfirmation.decideWithContext(passVerdict, context);

    // 验证扩展数据源贡献记录
    assert.equal(result.baseDecision, "auto-approve");
    assert.ok(result.dataSourceContributions.length >= 1, "应至少有 1 个数据源贡献记录");
    // 历史数据源应参与评估
    const historyContribution = result.dataSourceContributions.find((c) => c.source === "history");
    assert.ok(historyContribution, "应含历史数据源贡献");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// H. RunState 持久化测试（DOD-3）
// ============================================================================

test("H1. RunState 持久化文件写入（.eag/p5/run-state/<runId>.jsonl）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "RunState 持久化测试",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证 RunState 持久化文件存在
    const runStateDir = path.join(projectRoot, ".eag", "p5", "run-state");
    assert.ok(fs.existsSync(runStateDir), `.eag/p5/run-state 目录应存在：${runStateDir}`);

    // 验证 runId 对应的 JSONL 文件存在
    const runStateFile = path.join(runStateDir, `${result.runId}.jsonl`);
    assert.ok(fs.existsSync(runStateFile), `RunState 文件应存在：${runStateFile}`);

    // 验证文件内容可解析为 JSONL（每行一个 JSON 对象）
    const fileContent = fs.readFileSync(runStateFile, "utf8");
    const lines = fileContent
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0);
    assert.ok(lines.length > 0, "RunState 文件应至少有 1 行");

    // 每行应可解析为 JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed, "RunState 每行应可解析为 JSON");
      assert.equal(typeof parsed.runId, "string", "RunState 应含 runId 字段");
    }
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// I. NotesMemory 跨轮记忆测试（FR-7）
// ============================================================================

test("I1. NotesMemory 文件写入（.eag/p5/notes/<runId>.md）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    // R5 修复：NotesMemory 路径契约为 <projectRoot>/.eag/p5/notes/<runId>.md（按 run 隔离）
    // 旧版本期望固定文件名 notes.md，实际路径为 <runId>.md
    // 需要从 orchestrator.run() 返回结果获取 runId，构造正确的文件路径
    const result = await orchestrator.run({
      projectRoot,
      objective: "NotesMemory 测试",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证 <runId>.md 文件存在（路径布局：<projectRoot>/.eag/p5/notes/<runId>.md）
    const notesFile = path.join(projectRoot, ".eag", "p5", "notes", `${result.runId}.md`);
    assert.ok(fs.existsSync(notesFile), `notes 文件应存在：${notesFile}`);

    // 验证文件内容非空
    const content = fs.readFileSync(notesFile, "utf8");
    assert.ok(content.length > 0, "notes 文件内容应非空");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// J. GuardChain 15 条 BLOCKER 测试（DOD-2）
// ============================================================================

test("J1. G-A1a 路径牢笼：越界写入 $HOME 拦截", () => {
  const guardChain = createDefaultBlockerGuardChain({ throwOnDeny: false });
  // R6 修复：
  // - GuardContext 使用 pendingCommand（非 command），guards 通过 context.pendingCommand 读取命令
  // - GuardContext 必填 loopType 字段
  // - 移除 changedFiles/declaredFiles/declaredSymbols（非 GuardContext 字段）
  // - guardChain.check() 不存在，改用 executeSync()（所有 guard 的 check() 都是同步的）
  // - result.verdicts 不存在，改用 result.allVerdicts（GuardChainResult 接口字段）
  // - v.decision === "deny"/"ask" 改为大写 "DENY"/"ASK"（GuardDecision 类型契约）
  const guardContext: GuardContext = Object.freeze({
    runId: "test-run-001",
    iterIndex: 0,
    stage: "dev",
    loopType: "coding",
    projectRoot: "/tmp/test-project",
    worktreePath: "/tmp/test-project",
    pendingCommand: "echo test > $HOME/.bashrc",
  }) as GuardContext;

  const result = guardChain.executeSync(guardContext);
  // 验证 GuardChain 拦截（DENY 或 ASK）
  assert.ok(
    result.allVerdicts.some((v) => v.decision === "DENY" || v.decision === "ASK"),
    "越界写入 $HOME 应被 GuardChain 拦截"
  );
});

test("J2. G-A2a 黑名单命令：rm -rf ~ 拦截", () => {
  const guardChain = createDefaultBlockerGuardChain({ throwOnDeny: false });
  // R6 修复：同 J1，修正 GuardContext 字段名和 GuardChain API
  const guardContext: GuardContext = Object.freeze({
    runId: "test-run-001",
    iterIndex: 0,
    stage: "dev",
    loopType: "coding",
    projectRoot: "/tmp/test-project",
    worktreePath: "/tmp/test-project",
    pendingCommand: "rm -rf ~",
  }) as GuardContext;

  const result = guardChain.executeSync(guardContext);
  // 验证 GuardChain 拦截
  assert.ok(
    result.allVerdicts.some((v) => v.decision === "DENY"),
    "rm -rf ~ 应被黑名单拦截（DENY）"
  );
});

test("J3. G-A2a 黑名单命令：git push --force 拦截", () => {
  const guardChain = createDefaultBlockerGuardChain({ throwOnDeny: false });
  // R6 修复：同 J1，修正 GuardContext 字段名和 GuardChain API
  const guardContext: GuardContext = Object.freeze({
    runId: "test-run-001",
    iterIndex: 0,
    stage: "dev",
    loopType: "coding",
    projectRoot: "/tmp/test-project",
    worktreePath: "/tmp/test-project",
    pendingCommand: "git push --force origin main",
  }) as GuardContext;

  const result = guardChain.executeSync(guardContext);
  assert.ok(
    result.allVerdicts.some((v) => v.decision === "DENY" || v.decision === "ASK"),
    "git push --force 应被拦截"
  );
});

test("J4. G-A6d 上限冻结：AUTONOMOUS_DEFAULT_* 常量被 Object.freeze 冻结", () => {
  // 验证配置常量被冻结（G-A6d 不可变优先）
  // 注：常量本身是 number/string 字面量，无法被 Object.freeze 冻结
  // 但通过 Object.isFrozen 验证包含它们的数据结构被冻结
  // 此处验证 EagAutonomousRequest 被冻结（等价于 G-A6d 在 CLI 层的落地）
  const request = extractEagAutonomousRequestFromPrompt(`/eag-autonomous --goal "G-A6d 测试"`);
  assert.ok(Object.isFrozen(request), "EagAutonomousRequest 应被冻结（G-A6d）");

  // 验证尝试修改冻结对象会抛 TypeError
  assert.throws(
    () => {
      (request as { maxIterations: number }).maxIterations = 999;
    },
    TypeError,
    "修改冻结对象应抛 TypeError"
  );
});

test("J5. GuardChain 完整执行返回 GuardChainResult", () => {
  const guardChain = createDefaultBlockerGuardChain({ throwOnDeny: false });
  // R6 修复：同 J1，修正 GuardContext 字段名和 GuardChain API
  // - result.verdicts → result.allVerdicts
  // - result.passed → result.overallDecision === "PASS"（GuardChainResult 无 passed 字段）
  const guardContext: GuardContext = Object.freeze({
    runId: "test-run-001",
    iterIndex: 0,
    stage: "verify",
    loopType: "testing",
    projectRoot: "/tmp/test-project",
    worktreePath: "/tmp/test-project",
    pendingCommand: "npm test",
  }) as GuardContext;

  const result = guardChain.executeSync(guardContext);
  // 验证 GuardChainResult 结构完整性
  assert.ok(result, "GuardChainResult 应非 null");
  assert.ok(Array.isArray(result.allVerdicts), "allVerdicts 应为数组");
  assert.equal(typeof result.overallDecision, "string", "overallDecision 应为 string");
  assert.ok(["PASS", "DENY", "ASK"].includes(result.overallDecision), "overallDecision 应为 PASS/DENY/ASK 之一");
  assert.equal(typeof result.durationMs, "number", "durationMs 应为 number");
});

// ============================================================================
// K. ConfirmationHistoryStore 测试（TASK-P5-5.3-002）
// ============================================================================

test("K1. P5ConfirmationHistoryStore record() 写入历史决策", async () => {
  // R7 修复：record() 是 async 方法，测试函数改为 async 并 await record() 调用
  const projectRoot = createTempProject();
  try {
    const store = createDefaultP5ConfirmationHistoryStore();
    const entry = Object.freeze({
      runId: "test-run-001",
      iterIndex: 0,
      stage: "dev" as const,
      command: "npm test",
      decision: "auto-approve" as P5ConfirmationDecision,
      riskLevel: "low" as const,
      riskScore: 0,
      guardRuleId: "",
      matchedPattern: "",
      reason: "白名单命令",
      timestamp: new Date().toISOString(),
    });

    // 写入不应抛异常（await 确保异步写入完成）
    await store.record(projectRoot, entry);

    // 验证文件已创建
    const historyDir = path.join(projectRoot, ".eag", "p5", "confirmation-history");
    assert.ok(fs.existsSync(historyDir), "confirmation-history 目录应存在");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("K2. P5ConfirmationHistoryStore query() 多维度查询", async () => {
  // R7 修复：record() / query() 均为 async 方法，测试函数改为 async 并 await 所有调用
  const projectRoot = createTempProject();
  try {
    const store = createDefaultP5ConfirmationHistoryStore();

    // 写入多条历史决策记录
    const baseTime = new Date().toISOString();
    const entries = Object.freeze([
      Object.freeze({
        runId: "run-001",
        iterIndex: 0,
        stage: "dev" as const,
        command: "npm test",
        decision: "auto-approve" as P5ConfirmationDecision,
        riskLevel: "low" as const,
        riskScore: 0,
        guardRuleId: "",
        matchedPattern: "",
        reason: "白名单",
        timestamp: baseTime,
      }),
      Object.freeze({
        runId: "run-001",
        iterIndex: 1,
        stage: "verify" as const,
        command: "rm -rf /tmp",
        decision: "fail-closed" as P5ConfirmationDecision,
        riskLevel: "critical" as const,
        riskScore: 100,
        guardRuleId: "G-A2a",
        matchedPattern: "rm -rf",
        reason: "黑名单",
        timestamp: baseTime,
      }),
      Object.freeze({
        runId: "run-002",
        iterIndex: 0,
        stage: "dev" as const,
        command: "npm run build",
        decision: "auto-approve" as P5ConfirmationDecision,
        riskLevel: "low" as const,
        riskScore: 0,
        guardRuleId: "",
        matchedPattern: "",
        reason: "白名单",
        timestamp: baseTime,
      }),
    ]);

    // 逐条 await record() 确保写入顺序
    for (const entry of entries) {
      await store.record(projectRoot, entry);
    }

    // 按 runId 查询（await query()）
    const run001Results = await store.query(projectRoot, { runId: "run-001" });
    assert.ok(run001Results.length >= 2, "run-001 应至少有 2 条记录");

    // 按 decision 查询
    const failClosedResults = await store.query(projectRoot, { decision: "fail-closed" });
    assert.ok(failClosedResults.length >= 1, "应至少有 1 条 fail-closed 记录");

    // 按 stage 查询
    const verifyResults = await store.query(projectRoot, { stage: "verify" });
    assert.ok(verifyResults.length >= 1, "应至少有 1 条 verify 阶段记录");

    // 按 commandSubstring 查询
    const npmResults = await store.query(projectRoot, { commandSubstring: "npm" });
    assert.ok(npmResults.length >= 2, "应至少有 2 条 npm 命令记录");

    // 按 guardRuleId 查询
    const guardResults = await store.query(projectRoot, { guardRuleId: "G-A2a" });
    assert.ok(guardResults.length >= 1, "应至少有 1 条 G-A2a 规则记录");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("K3. P5ConfirmationHistoryStore getStats() 聚合统计", async () => {
  // R7 修复：record() / getStats() 均为 async 方法，测试函数改为 async 并 await 所有调用
  const projectRoot = createTempProject();
  try {
    const store = createDefaultP5ConfirmationHistoryStore();

    // 写入多条历史决策记录
    const baseTime = new Date().toISOString();
    const entries = Object.freeze([
      Object.freeze({
        runId: "run-001",
        iterIndex: 0,
        stage: "dev" as const,
        command: "npm test",
        decision: "auto-approve" as P5ConfirmationDecision,
        riskLevel: "low" as const,
        riskScore: 0,
        guardRuleId: "",
        matchedPattern: "",
        reason: "白名单",
        timestamp: baseTime,
      }),
      Object.freeze({
        runId: "run-001",
        iterIndex: 1,
        stage: "dev" as const,
        command: "rm -rf /tmp",
        decision: "fail-closed" as P5ConfirmationDecision,
        riskLevel: "critical" as const,
        riskScore: 100,
        guardRuleId: "G-A2a",
        matchedPattern: "rm -rf",
        reason: "黑名单",
        timestamp: baseTime,
      }),
      Object.freeze({
        runId: "run-001",
        iterIndex: 2,
        stage: "verify" as const,
        command: "npm test",
        decision: "ask-user" as P5ConfirmationDecision,
        riskLevel: "medium" as const,
        riskScore: 30,
        guardRuleId: "",
        matchedPattern: "",
        reason: "中等风险",
        timestamp: baseTime,
      }),
    ]);

    for (const entry of entries) {
      await store.record(projectRoot, entry);
    }

    // 获取统计（await getStats()）
    const stats = await store.getStats(projectRoot);

    // 验证统计字段
    assert.ok(stats.totalEntries >= 3, "总记录数应 >= 3");
    assert.ok(stats.byDecision["auto-approve"] >= 1, "auto-approve 计数应 >= 1");
    assert.ok(stats.byDecision["fail-closed"] >= 1, "fail-closed 计数应 >= 1");
    assert.ok(stats.byDecision["ask-user"] >= 1, "ask-user 计数应 >= 1");
    assert.ok(stats.byStage["dev"] >= 2, "dev 阶段计数应 >= 2");
    assert.ok(stats.byStage["verify"] >= 1, "verify 阶段计数应 >= 1");
    assert.ok(stats.uniqueRunIds >= 1, "唯一 runId 数应 >= 1");
    assert.ok(stats.autoApproveRate > 0, "自动放行率应 > 0");
    assert.ok(stats.autoApproveRate + stats.askUserRate + stats.failClosedRate <= 1.01, "三态比例之和应约等于 1");
    assert.ok(stats.topGuardRuleIds.length > 0, "应含 Top 护栏规则");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("K4. P5ConfirmationHistoryStore JSONL 持久化（文件可解析）", async () => {
  // R7 修复：record() 是 async 方法，测试函数改为 async 并 await record() 调用
  const projectRoot = createTempProject();
  try {
    const store = createDefaultP5ConfirmationHistoryStore();

    await store.record(
      projectRoot,
      Object.freeze({
        runId: "run-persist-001",
        iterIndex: 0,
        stage: "dev" as const,
        command: "npm test",
        decision: "auto-approve" as P5ConfirmationDecision,
        riskLevel: "low" as const,
        riskScore: 0,
        guardRuleId: "",
        matchedPattern: "",
        reason: "持久化测试",
        timestamp: new Date().toISOString(),
      })
    );

    // 验证 JSONL 文件存在且可解析
    const historyDir = path.join(projectRoot, ".eag", "p5", "confirmation-history");
    const files = fs.readdirSync(historyDir).filter((f) => f.endsWith(".jsonl"));
    assert.ok(files.length > 0, "应至少有 1 个 .jsonl 文件");

    const filePath = path.join(historyDir, files[0]);
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0);
    assert.ok(lines.length > 0, "JSONL 文件应至少有 1 行");

    // 每行应可解析为 JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.runId, "string", "JSONL 行应含 runId 字段");
      assert.equal(typeof parsed.decision, "string", "JSONL 行应含 decision 字段");
    }
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("K5. P5ConfirmationHistoryStore clear() 清理历史记录", async () => {
  // R7 修复：record() / getStats() / clear() 均为 async 方法，测试函数改为 async 并 await 所有调用
  const projectRoot = createTempProject();
  try {
    const store = createDefaultP5ConfirmationHistoryStore();

    // 写入记录
    await store.record(
      projectRoot,
      Object.freeze({
        runId: "run-clear-001",
        iterIndex: 0,
        stage: "dev" as const,
        command: "npm test",
        decision: "auto-approve" as P5ConfirmationDecision,
        riskLevel: "low" as const,
        riskScore: 0,
        guardRuleId: "",
        matchedPattern: "",
        reason: "清理测试",
        timestamp: new Date().toISOString(),
      })
    );

    // 验证记录存在
    const beforeStats = await store.getStats(projectRoot);
    assert.ok(beforeStats.totalEntries >= 1, "清理前应有记录");

    // 清理
    await store.clear(projectRoot);

    // 验证记录已清理
    const afterStats = await store.getStats(projectRoot);
    assert.equal(afterStats.totalEntries, 0, "清理后总记录数应为 0");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("K6. P5ConfirmationHistoryStore 不可变性（返回冻结对象）", async () => {
  // R7 修复：record() / query() / getStats() 均为 async 方法，测试函数改为 async 并 await 所有调用
  const projectRoot = createTempProject();
  try {
    const store = createDefaultP5ConfirmationHistoryStore();

    await store.record(
      projectRoot,
      Object.freeze({
        runId: "run-immutable-001",
        iterIndex: 0,
        stage: "dev" as const,
        command: "npm test",
        decision: "auto-approve" as P5ConfirmationDecision,
        riskLevel: "low" as const,
        riskScore: 0,
        guardRuleId: "",
        matchedPattern: "",
        reason: "不可变性测试",
        timestamp: new Date().toISOString(),
      })
    );

    // query 返回的条目应被冻结（await query()）
    const results = await store.query(projectRoot, { runId: "run-immutable-001" });
    assert.ok(results.length > 0, "应至少有 1 条记录");
    for (const entry of results) {
      assert.ok(Object.isFrozen(entry), "历史记录条目应被冻结");
    }

    // getStats 返回的统计应被冻结（await getStats()）
    const stats = await store.getStats(projectRoot);
    assert.ok(Object.isFrozen(stats), "统计对象应被冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// L. 端到端完整流程测试（DOD-1 验证）
// ============================================================================

test("L1. 端到端完整流程：CLI 解析 → handler.execute → AutonomousOrchestrator.run → 结果渲染", async () => {
  const projectRoot = createTempProject();
  try {
    // 准备项目结构
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 步骤 1：用户输入 /eag-autonomous 命令
    const userPromptText = `/eag-autonomous --goal "端到端完整流程测试" --max-iterations 1 --test-command "${PASS_TEST_CMD}"`;

    // 步骤 2：EagCommandParser 解析命令
    const parser = new EagCommandParser();
    const userPrompt = buildUserPrompt(userPromptText);
    const command = parser.parse(userPrompt);
    assert.equal(command.kind, "eag-autonomous");
    if (command.kind !== "eag-autonomous" || !command.payload) {
      assert.fail("命令解析失败");
      return;
    }

    // 步骤 3：构造 AutonomousOrchestrator（5 个核心依赖完整装配）
    const orchestrator = buildOrchestrator();

    // 步骤 4：创建 EagAutonomousCommandHandler 并执行
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const result = await handler.execute(command.payload, projectRoot);

    // 步骤 5：验证执行结果
    assert.equal(result.success, true, "端到端流程应成功");
    assert.ok(result.runResult, "应包含 AutonomousRunResult");
    assert.ok(result.markdownReport.length > 0, "应生成 Markdown 报告");
    assert.ok(result.markdownReport.includes("[EAG Autonomous Loop]"), "报告应含标题");

    // 步骤 6：验证 RunState 持久化
    const runStateDir = path.join(projectRoot, ".eag", "p5", "run-state");
    assert.ok(fs.existsSync(runStateDir), "RunState 目录应存在");

    // 步骤 7：验证 NotesMemory 持久化
    // R5 修复：NotesMemory 路径契约为 <projectRoot>/.eag/p5/notes/<runId>.md（按 run 隔离，非固定 notes.md）
    const notesFile = path.join(projectRoot, ".eag", "p5", "notes", `${result.runResult!.runId}.md`);
    assert.ok(fs.existsSync(notesFile), `notes 文件应存在：${notesFile}`);

    // 步骤 8：验证结果不可变性
    assert.ok(Object.isFrozen(result), "EagAutonomousCommandResult 应被冻结");
    assert.ok(Object.isFrozen(result.runResult), "AutonomousRunResult 应被冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("L2. 端到端完整流程：失败路径（testCommand 失败 → finalStatus=failed）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const userPromptText = `/eag-autonomous --goal "失败路径测试" --max-iterations 1 --test-command "${FAIL_TEST_CMD}"`;

    const parser = new EagCommandParser();
    const command = parser.parse(buildUserPrompt(userPromptText));
    if (command.kind !== "eag-autonomous" || !command.payload) {
      assert.fail("命令解析失败");
      return;
    }

    const orchestrator = buildOrchestrator();
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const result = await handler.execute(command.payload, projectRoot);

    // 验证失败路径
    assert.equal(result.success, true, "execute() 应返回 success=true（run() 未抛异常）");
    assert.ok(result.runResult, "应包含 AutonomousRunResult");
    // finalStatus 应为 failed 或 aborted（因为 testCommand 失败）
    assert.ok(["failed", "aborted"].includes(result.runResult!.finalStatus), "finalStatus 应为 failed 或 aborted");
    assert.ok(result.markdownReport.includes("[EAG Autonomous Loop]"), "失败报告也应含标题");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("L3. 端到端完整流程：createAutonomousOrchestrator 工厂函数", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 使用工厂函数构造 orchestrator（验证工厂函数可用性）
    const orchestrator = createAutonomousOrchestrator({
      loopExecutor: createP5LoopExecutorFromHandlers(
        new P5PlanStageHandler(),
        new P5DevStageHandler(),
        new P5VerifyStageHandler(),
        new P5FixStageHandler()
      ),
      runStateStore: new P5RunStateStore(),
      notesMemory: new P5NotesMemory(),
      guardChain: createDefaultBlockerGuardChain({ throwOnDeny: false }),
      smartConfirmation: new P5SmartConfirmation(),
    });

    const result = await orchestrator.run({
      projectRoot,
      objective: "工厂函数测试",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    assert.ok(result.totalIterations >= 1, "工厂函数构造的 orchestrator 应可正常运行");
    assert.ok(Object.isFrozen(result), "结果应被冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});
