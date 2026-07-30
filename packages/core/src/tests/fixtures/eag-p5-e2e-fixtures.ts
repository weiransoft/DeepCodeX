/**
 * EAG-P5 E2E 测试共享夹具：autonomous / capability-verification 系列拆分文件共用
 *
 * 用途：
 * - 为 eag-p5-autonomous-*.test.ts 与 eag-p5-e2e-*.test.ts 系列拆分文件提供统一的 fixture
 * - 集中维护真实 AutonomousOrchestrator / StageHandler / GuardChain 装配逻辑
 * - 集中维护临时项目目录、tasks.md、声明源文件等真实文件系统夹具
 * - 严格遵循 NFR-9 禁止 mock：所有函数返回真实组件实例
 * - 严格遵循 NFR-8 不可变优先：所有返回对象使用 Object.freeze 冻结
 *
 * 设计依据：
 * - 需求文档 §3 FR-1 无人值守 4 阶段循环 + FR-4 /eag-autonomous 命令 + FR-7 NotesMemory
 * - 架构师审查 §4.1 AutonomousOrchestrator 接口契约 + §4.2 BlockerGuardChain 接口契约
 * - NFR-8 不可变优先 + NFR-9 禁止 mock + NFR-10 中文详细注释
 *
 * @module core/tests/fixtures/eag-p5-e2e-fixtures
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// UserPromptContent 类型导入（用于构造 EagCommandParser.parse 输入）
import type { UserPromptContent } from "../../session";

// P5 核心组件导入（用于 buildOrchestrator / buildStageContext 真实装配）
import {
  // AutonomousOrchestrator 主控制器
  AutonomousOrchestrator,
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
  // 类型
  type P5RunState,
  type P5StageContext,
  type P5StageKind,
  type TaskCard,
  // 默认配置常量
  AUTONOMOUS_DEFAULT_MAX_ITERATIONS,
  AUTONOMOUS_DEFAULT_MAX_TOKENS,
  AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT,
  AUTONOMOUS_DEFAULT_TEST_COMMAND,
  AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC,
} from "../../eag/p5/index";

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
export const PASS_TEST_CMD = `echo Tests: 1 passed, 0 failed`;

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
export const FAIL_TEST_CMD = `echo Tests: 0 passed, 1 failed; false`;

/**
 * 默认配置常量重新导出（便于拆分文件统一引用）
 *
 * 这些常量在原文件中被多个测试断言使用（如 F2 AUTONOMOUS_DEFAULT_* 常量正确性），
 * 通过 fixtures 统一导出避免每个拆分文件重复 import。
 */
export {
  AUTONOMOUS_DEFAULT_MAX_ITERATIONS,
  AUTONOMOUS_DEFAULT_MAX_TOKENS,
  AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT,
  AUTONOMOUS_DEFAULT_TEST_COMMAND,
  AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC,
};

// ============================================================================
// 2. 临时项目目录夹具
// ============================================================================

/**
 * 创建临时项目目录（真实文件系统）
 *
 * 在 os.tmpdir() 下创建唯一临时目录，并确保 .eag/p5 子目录存在。
 * 测试结束后由调用方通过 cleanupTempProject 清理。
 *
 * @param prefix 临时目录前缀（可选，默认 "eag-p5-e2e-"）
 * @returns 临时项目根目录绝对路径
 */
export function createTempProject(prefix: string = "eag-p5-e2e-"): string {
  const fullPrefix = path.join(os.tmpdir(), prefix);
  const projectRoot = fs.mkdtempSync(fullPrefix);
  // 创建 .eag/p5 子目录（run-state-store / notes-memory / confirmation-history-store 会用到）
  fs.mkdirSync(path.join(projectRoot, ".eag", "p5"), { recursive: true });
  return projectRoot;
}

/**
 * 清理临时项目目录（递归删除，容错处理）
 *
 * @param projectRoot 临时项目根目录
 */
export function cleanupTempProject(projectRoot: string): void {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // 忽略清理失败（测试环境不强求清理，CI 会定期清理 tmpdir）
  }
}

// ============================================================================
// 3. tasks.md / 声明源文件夹具
// ============================================================================

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
export function createTasksFile(
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
 * @param content 文件内容（可选，默认为测试占位内容）
 */
export function createDeclaredFile(
  projectRoot: string,
  relativePath: string,
  content: string = "// 测试文件内容\n"
): void {
  const absolutePath = path.join(projectRoot, relativePath);
  const parentDir = path.dirname(absolutePath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf8");
}

// ============================================================================
// 4. AutonomousOrchestrator 真实装配夹具
// ============================================================================

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
export function buildOrchestrator(overrides?: {
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

// ============================================================================
// 5. StageContext / RunState / TaskCard 夹具
// ============================================================================

/**
 * 构造最小可用的 P5RunState（用于 P5StageContext.runState 字段）
 *
 * 注意：此 RunState 仅用于 StageHandler 上下文，不写入文件系统。
 * StageHandler 仅读取 runState.maxIterations / runState.maxTokens 字段，
 * 不依赖 checksum 校验（checksum 由 RunStateStore 负责）。
 *
 * @param projectRoot 项目根目录
 * @param maxIterations 最大迭代次数
 * @param maxTokens 最大 Token 预算
 * @returns 冻结的 P5RunState
 */
export function createMinimalRunState(
  projectRoot: string,
  maxIterations: number = 10,
  maxTokens: number = 200000
): Readonly<P5RunState> {
  const now = new Date().toISOString();
  return Object.freeze({
    runId: "test-run-id",
    projectRoot,
    objective: "测试目标",
    startedAt: now,
    updatedAt: now,
    currentLoop: "coding",
    iterIndex: 0,
    currentStage: "plan",
    completedStages: Object.freeze([]),
    completedLoops: Object.freeze([]),
    totalLlmCallCount: 0,
    totalTokensUsed: 0,
    consecutiveFailures: 0,
    maxIterations,
    maxTokens,
    stopWhen: "",
    status: "running",
    lastGuardTriggered: null,
    // checksum 字段使用占位值（StageHandler 不校验 checksum）
    localChecksum: "sha256:placeholder",
    cumulativeChecksum: "sha256:placeholder",
  });
}

/**
 * 构造 P5StageContext（用于直接调用 StageHandler.handle()）
 *
 * 由于 P5StageContext 字段较多且部分为内部依赖（guardChain/smartConfirmation），
 * 本函数提供默认值构造，允许通过 overrides 覆盖任意字段。
 *
 * @param projectRoot 项目根目录
 * @param stage 当前阶段
 * @param overrides 覆盖字段（可选）
 * @returns 冻结的 P5StageContext
 */
export function buildStageContext(
  projectRoot: string,
  stage: P5StageKind,
  overrides?: Partial<P5StageContext>
): P5StageContext {
  const guardChain = createDefaultBlockerGuardChain({ throwOnDeny: false });
  const smartConfirmation = new P5SmartConfirmation();
  const runState = createMinimalRunState(projectRoot);

  return Object.freeze({
    runId: "test-run-id",
    iterIndex: 0,
    stage,
    projectRoot,
    worktreePath: projectRoot,
    objective: "测试目标",
    currentPlan: "",
    notesSnapshot: "",
    prevResults: Object.freeze([]),
    runState,
    guardChain,
    smartConfirmation,
    tasksFilePath: path.join(projectRoot, ".eag", "p5", "tasks.md"),
    testCommand: PASS_TEST_CMD,
    testTimeoutSec: 10,
    loopType: "coding",
    ...overrides,
  } as P5StageContext);
}

/**
 * 构造测试用 TaskCard（用于 M 组制品链测试）
 *
 * @param id 任务 ID
 * @param files 声明文件列表
 * @param symbols 声明符号列表
 * @returns 冻结的 TaskCard
 */
export function createTestTaskCard(
  id: string = "T-001",
  files: string[] = ["src/services/Service1.ts"],
  symbols: string[] = ["Service1"]
): Readonly<TaskCard> {
  return Object.freeze({
    id,
    title: `测试任务 ${id}`,
    requirementId: "F-001",
    dependencies: Object.freeze([]),
    acceptanceCriteria: Object.freeze(["测试通过"]),
    status: "pending",
    declaredSymbols: Object.freeze(symbols),
    declaredFiles: Object.freeze(files),
    declaredDeletions: Object.freeze([]),
  });
}

// ============================================================================
// 6. EagCommandParser 输入夹具
// ============================================================================

/**
 * 构造 UserPromptContent fixture（用于 EagCommandParser.parse 输入）
 *
 * @param text 用户输入文本
 * @param messageParams 可选的预装配请求对象
 * @returns 冻结的 UserPromptContent
 */
export function buildUserPrompt(text: string, messageParams?: Record<string, unknown>): UserPromptContent {
  return Object.freeze({
    text,
    imageUrls: Object.freeze([]),
    skills: Object.freeze([]),
    messageParams: messageParams ?? null,
  }) as UserPromptContent;
}
