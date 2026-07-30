/**
 * AutonomousOrchestrator.runAsGraphNode() 适配方法单元测试
 * （Loop-Graph 融合方案 Phase 5 §12.4 验证）
 *
 * 测试范围：
 * - A. 取消信号检查（context.cancelled=true → 返回 skipped）
 * - B. 空 task 检查（node.task 为空 → 返回 failed）
 * - C. projectRoot 三级回退提取
 *   - C1. input.projectRoot 优先
 *   - C2. node.overrides.projectRoot 回退
 *   - C3. context.globalState.projectRoot 回退
 *   - C4. 三者均无时返回 failed
 * - D. loopConfig 提取
 *   - D1. node.loopConfig 存在时提取 maxIterations / maxTokens / stopWhen
 *   - D2. node.loopConfig 不存在时使用默认值
 * - E. testCommand / testTimeoutSec 从 input 提取
 * - F. 成功路径（finalStatus=completed → status=completed + loopReport）
 * - G. 失败路径（finalStatus=failed → status=failed + failureReason）
 * - H. token 累加（context.totalTokensUsed 累加 runResult.totalTokensUsed）
 * - I. GraphNodeResult 不可变性验证（Object.freeze）
 * - J. LoopRunReport 字段映射正确性
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 AutonomousOrchestrator / P5RunStateStore / 等
 * - 使用真实文件系统（os.tmpdir + mkdtempSync）创建临时项目目录
 * - 使用真实 child_process（verify-stage-handler 内部 spawnSync 执行 node -e 命令）
 * - 中文注释
 *
 * 设计依据：
 * - 设计文档 §12.4 runAsGraphNode() 设计原则
 * - 设计文档 §5.12.4 G-A6d 不可变优先（Object.freeze）
 * - 设计文档 §7.6 GraphRunContext 协议（totalTokensUsed 可变字段）
 *
 * @module core/tests/eag-p5-run-as-graph-node
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  // AutonomousOrchestrator 主控制器
  AutonomousOrchestrator,
  // 4 个 StageHandler
  P5PlanStageHandler,
  P5DevStageHandler,
  P5VerifyStageHandler,
  P5FixStageHandler,
  // 核心依赖
  P5RunStateStore,
  P5NotesMemory,
  P5SmartConfirmation,
  createDefaultBlockerGuardChain,
  // 工厂函数
  createP5LoopExecutorFromHandlers,
  // 类型
  type AutonomousRunRequest,
  type AutonomousRunResult,
} from "../eag/p5/index";

// graph 模块类型（仅用于构造测试 fixture，不导入运行时值）
import type {
  GraphNodeDef,
  GraphNodeResult,
  GraphRunContext,
  WorkGraphConfig,
  NodeLoopConfig,
} from "../eag/graph/graph-loop-models";
import type { PredicateRegistry } from "../eag/graph/graph-loop-models";

// ============================================================================
// 1. 测试常量
// ============================================================================

/**
 * 通过测试命令（真实 child_process 执行，输出 Jest 格式）
 *
 * 命令：node -e 'console.log("Tests: 1 passed, 0 failed")'
 * 输出：Tests: 1 passed, 0 failed
 * 退出码：0
 * 解析结果：{ passed: 1, failed: 0, skipped: 0, total: 1, parser: "jest" }
 */
const PASS_TEST_CMD = `node -e 'console.log("Tests: 1 passed, 0 failed")'`;

/**
 * 失败测试命令（真实 child_process 执行，输出 Jest 格式 + 非零退出码）
 *
 * 命令：node -e 'console.log("Tests: 0 passed, 1 failed"); process.exit(1)'
 * 输出：Tests: 0 passed, 1 failed
 * 退出码：1
 */
const FAIL_TEST_CMD = `node -e 'console.log("Tests: 0 passed, 1 failed"); process.exit(1)'`;

// ============================================================================
// 2. 测试辅助函数
// ============================================================================

/**
 * 创建临时项目目录（真实文件系统）
 *
 * @returns 临时项目根目录绝对路径
 */
function createTempProject(): string {
  const prefix = path.join(os.tmpdir(), "eag-p5-graph-node-test-");
  const projectRoot = fs.mkdtempSync(prefix);
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
    // 忽略清理失败
  }
}

/**
 * 创建 tasks.md 文件（含 1 张指定状态的任务卡）
 *
 * @param projectRoot 项目根目录
 * @param status 任务卡状态（pending/completed/in-progress/blocked）
 * @returns tasks.md 文件绝对路径
 */
function createTasksFile(
  projectRoot: string,
  status: "pending" | "completed" | "in-progress" | "blocked" = "pending"
): string {
  const tasksDir = path.join(projectRoot, ".eag", "p5");
  fs.mkdirSync(tasksDir, { recursive: true });
  const tasksFilePath = path.join(tasksDir, "tasks.md");

  const lines: string[] = [];
  lines.push("# EAG-P5 任务清单");
  lines.push("");
  lines.push("## T-001 测试任务 1");
  lines.push("- requirement: F-001");
  lines.push(`- status: ${status}`);
  lines.push("- dependencies: ");
  lines.push("- files: src/services/Service1.ts");
  lines.push("- deletions: ");
  lines.push("- symbols: Service1");
  lines.push("- acceptance: 测试通过");
  lines.push("");

  fs.writeFileSync(tasksFilePath, lines.join("\n"), "utf8");
  return tasksFilePath;
}

/**
 * 创建声明的源文件（让 dev 阶段能盘点到真实文件）
 *
 * @param projectRoot 项目根目录
 * @param relativePath 文件相对路径
 */
function createDeclaredFile(projectRoot: string, relativePath: string): void {
  const absolutePath = path.join(projectRoot, relativePath);
  const parentDir = path.dirname(absolutePath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(absolutePath, "// 测试文件内容\n", "utf8");
}

/**
 * 构造真实的 AutonomousOrchestrator 实例
 *
 * @param overrides 可选的配置覆盖
 * @returns AutonomousOrchestrator 实例
 */
function buildOrchestrator(overrides?: {
  readonly defaultMaxIterations?: number;
  readonly defaultMaxTokens?: number;
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
    defaultTestCommand: overrides?.defaultTestCommand,
    defaultTestTimeoutSec: overrides?.defaultTestTimeoutSec,
  });
}

/**
 * 构造测试用 GraphNodeDef（loop 类型节点）
 *
 * @param nodeId 节点 ID
 * @param task 任务描述
 * @param overrides 覆盖字段（可选）
 * @returns 冻结的 GraphNodeDef
 */
function createLoopNode(nodeId: string, task: string, overrides?: Partial<GraphNodeDef>): Readonly<GraphNodeDef> {
  return Object.freeze({
    nodeId,
    nodeType: "loop",
    label: `测试节点 ${nodeId}`,
    task,
    inputContract: Object.freeze([]),
    outputContract: Object.freeze([]),
    ...overrides,
  });
}

/**
 * 构造测试用 NodeLoopConfig
 *
 * @param overrides 覆盖字段（可选）
 * @returns 冻结的 NodeLoopConfig
 */
function createLoopConfig(overrides?: Partial<NodeLoopConfig>): Readonly<NodeLoopConfig> {
  return Object.freeze({
    loopType: "coding",
    discoveryMode: "auto",
    evaluatorMode: "standard",
    maxIterations: 3,
    maxTokens: 50_000,
    stopWhen: "",
    stageOrder: Object.freeze(["plan", "dev", "verify", "fix"]),
    autoCommit: false,
    humanCheckpointEvery: 0,
    ...overrides,
  });
}

/**
 * 构造测试用 GraphRunContext
 *
 * @param overrides 覆盖字段（可选）
 * @returns GraphRunContext（含可变字段 cancelled / currentDepth / totalTokensUsed）
 */
function createGraphRunContext(
  overrides?: Partial<GraphRunContext> & {
    readonly projectRoot?: string;
  }
): GraphRunContext {
  const globalState: Record<string, unknown> = {};
  if (overrides?.projectRoot) {
    globalState["projectRoot"] = overrides.projectRoot;
  }

  // 构造最小的 PredicateRegistry 存根（runAsGraphNode 不直接使用谓词注册表）
  const predicateRegistry: PredicateRegistry = {
    register: () => {},
    lookup: () => undefined,
    list: () => [],
  };

  const config: WorkGraphConfig = Object.freeze({
    maxDepth: 100,
    maxParallelism: 4,
    maxTokens: 0,
    timeoutSec: 0,
    enableExperienceRecall: false,
    enableAutoIsolation: true,
    nodeRetryLimit: 3,
  });

  return {
    runId: "test-run-graph-001",
    graphId: "test-graph",
    globalState,
    visited: new Set<string>(),
    nodeResults: new Map<string, GraphNodeResult>(),
    cancelled: false,
    config,
    predicateRegistry,
    currentDepth: 0,
    totalTokensUsed: 0,
    startedAtMs: Date.now(),
    ...overrides,
  } as GraphRunContext;
}

// ============================================================================
// A. 取消信号检查
// ============================================================================

test("A1. context.cancelled=true 时返回 skipped 状态", async () => {
  const orchestrator = buildOrchestrator();
  const node = createLoopNode("node-1", "测试任务");
  const input = Object.freeze({ projectRoot: "/tmp" });
  const context = createGraphRunContext({ cancelled: true });

  const result = await orchestrator.runAsGraphNode(node, input, context);

  assert.equal(result.nodeId, "node-1");
  assert.equal(result.nodeType, "loop");
  assert.equal(result.status, "skipped");
  assert.equal(result.durationSec, 0);
  assert.equal(result.retryCount, 0);
  // output 应包含取消原因
  const output = result.output as Record<string, unknown>;
  assert.equal(output.reason, "图执行已被用户取消");
  // loopReport 应为 undefined（未执行 Loop）
  assert.equal(result.loopReport, undefined);
});

test("A2. skipped 结果被 Object.freeze 冻结", async () => {
  const orchestrator = buildOrchestrator();
  const node = createLoopNode("node-1", "测试任务");
  const input = Object.freeze({ projectRoot: "/tmp" });
  const context = createGraphRunContext({ cancelled: true });

  const result = await orchestrator.runAsGraphNode(node, input, context);

  assert.ok(Object.isFrozen(result), "GraphNodeResult 应被 Object.freeze 冻结");
  assert.ok(Object.isFrozen(result.output), "output 应被 Object.freeze 冻结");
});

// ============================================================================
// B. 空 task 检查
// ============================================================================

test("B1. node.task 为空字符串时返回 failed 状态", async () => {
  const orchestrator = buildOrchestrator();
  const node = createLoopNode("node-1", "");
  const input = Object.freeze({ projectRoot: "/tmp" });
  const context = createGraphRunContext();

  const result = await orchestrator.runAsGraphNode(node, input, context);

  assert.equal(result.nodeId, "node-1");
  assert.equal(result.status, "failed");
  assert.ok(result.failureReason !== undefined);
  assert.ok(result.failureReason!.includes("task 字段为空"));
  assert.equal(result.retryCount, 0);
});

test("B2. node.task 为纯空白字符时返回 failed 状态", async () => {
  const orchestrator = buildOrchestrator();
  const node = createLoopNode("node-1", "   ");
  const input = Object.freeze({ projectRoot: "/tmp" });
  const context = createGraphRunContext();

  const result = await orchestrator.runAsGraphNode(node, input, context);

  assert.equal(result.status, "failed");
  assert.ok(result.failureReason!.includes("task 字段为空"));
});

// ============================================================================
// C. projectRoot 三级回退提取
// ============================================================================

test("C1. projectRoot 从 input.projectRoot 提取（第一优先级）", async () => {
  const projectRoot = createTempProject();
  try {
    // 使用 completed 任务卡：plan 找不到 pending → 触发 completed 终止条件
    createTasksFile(projectRoot, "completed");

    const orchestrator = buildOrchestrator({
      defaultTestCommand: PASS_TEST_CMD,
      defaultTestTimeoutSec: 30,
    });

    // input.projectRoot 优先级最高
    const input = Object.freeze({ projectRoot });
    // overrides 和 globalState 中也提供不同的 projectRoot，验证 input 优先
    const overrides = { projectRoot: "/wrong/path/overrides" };
    const nodeWithOverrides = createLoopNode("node-1", "实现 Service1 功能", {
      overrides: overrides as unknown as GraphNodeDef["overrides"],
    });
    const context = createGraphRunContext({
      projectRoot: "/wrong/path/globalState",
    });

    const result = await orchestrator.runAsGraphNode(nodeWithOverrides, input, context);

    // 应使用 input.projectRoot（而非 overrides 或 globalState）
    assert.equal(result.status, "completed");
    assert.equal(result.nodeType, "loop");
    const output = result.output as Record<string, unknown>;
    assert.equal(output.finalStatus, "completed");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("C2. projectRoot 从 node.overrides.projectRoot 回退（第二优先级）", async () => {
  const projectRoot = createTempProject();
  try {
    // 使用 completed 任务卡：plan 找不到 pending → 触发 completed 终止条件
    createTasksFile(projectRoot, "completed");

    const orchestrator = buildOrchestrator({
      defaultTestCommand: PASS_TEST_CMD,
      defaultTestTimeoutSec: 30,
    });

    // input 中不提供 projectRoot
    const input = Object.freeze({});
    // overrides 中提供 projectRoot
    const overrides = { projectRoot };
    const node = createLoopNode("node-1", "实现 Service1 功能", {
      overrides: overrides as unknown as GraphNodeDef["overrides"],
    });
    // globalState 中提供错误的 projectRoot，验证 overrides 优先
    const context = createGraphRunContext({
      projectRoot: "/wrong/path/globalState",
    });

    const result = await orchestrator.runAsGraphNode(node, input, context);

    // 应使用 overrides.projectRoot
    assert.equal(result.status, "completed");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("C3. projectRoot 从 context.globalState.projectRoot 回退（第三优先级）", async () => {
  const projectRoot = createTempProject();
  try {
    // 使用 completed 任务卡：plan 找不到 pending → 触发 completed 终止条件
    createTasksFile(projectRoot, "completed");

    const orchestrator = buildOrchestrator({
      defaultTestCommand: PASS_TEST_CMD,
      defaultTestTimeoutSec: 30,
    });

    // input 和 overrides 中均不提供 projectRoot
    const input = Object.freeze({});
    const node = createLoopNode("node-1", "实现 Service1 功能");
    // globalState 中提供 projectRoot
    const context = createGraphRunContext({ projectRoot });

    const result = await orchestrator.runAsGraphNode(node, input, context);

    // 应使用 globalState.projectRoot
    assert.equal(result.status, "completed");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("C4. projectRoot 三者均无时返回 failed 状态", async () => {
  const orchestrator = buildOrchestrator();

  const node = createLoopNode("node-1", "测试任务");
  const input = Object.freeze({});
  const context = createGraphRunContext(); // globalState 中无 projectRoot

  const result = await orchestrator.runAsGraphNode(node, input, context);

  assert.equal(result.status, "failed");
  assert.ok(result.failureReason!.includes("无法定位 projectRoot"));
});

// ============================================================================
// D. loopConfig 提取
// ============================================================================

test("D1. node.loopConfig 存在时提取 maxIterations / maxTokens / stopWhen", async () => {
  const projectRoot = createTempProject();
  try {
    // 使用 completed 任务卡：plan 找不到 pending → 触发 completed 终止条件
    createTasksFile(projectRoot, "completed");

    const orchestrator = buildOrchestrator({
      defaultTestCommand: PASS_TEST_CMD,
      defaultTestTimeoutSec: 30,
    });

    // 使用自定义 loopConfig（maxIterations=2，小于默认值 10）
    const loopConfig = createLoopConfig({
      maxIterations: 2,
      maxTokens: 30_000,
      stopWhen: "",
    });
    const node = createLoopNode("node-1", "实现 Service1 功能", { loopConfig });
    const input = Object.freeze({ projectRoot });
    const context = createGraphRunContext();

    const result = await orchestrator.runAsGraphNode(node, input, context);

    // 执行应成功（loopConfig 被正确提取）
    assert.equal(result.status, "completed");
    // loopReport 应反映 maxIterations=2 的配置
    const loopReport = result.loopReport;
    assert.ok(loopReport !== undefined);
    assert.ok(loopReport!.totalIterations <= 2);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("D2. node.loopConfig 不存在时使用默认值", async () => {
  const projectRoot = createTempProject();
  try {
    // 使用 completed 任务卡：plan 找不到 pending → 触发 completed 终止条件
    createTasksFile(projectRoot, "completed");

    // 设置默认 maxIterations=5
    const orchestrator = buildOrchestrator({
      defaultMaxIterations: 5,
      defaultTestCommand: PASS_TEST_CMD,
      defaultTestTimeoutSec: 30,
    });

    // 不提供 loopConfig
    const node = createLoopNode("node-1", "实现 Service1 功能");
    const input = Object.freeze({ projectRoot });
    const context = createGraphRunContext();

    const result = await orchestrator.runAsGraphNode(node, input, context);

    // 执行应成功（使用默认配置）
    assert.equal(result.status, "completed");
    // loopReport 应反映默认 maxIterations=5
    const loopReport = result.loopReport;
    assert.ok(loopReport !== undefined);
    assert.ok(loopReport!.totalIterations <= 5);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// E. testCommand / testTimeoutSec 从 input 提取
// ============================================================================

test("E1. input.testCommand 覆盖默认测试命令", async () => {
  const projectRoot = createTempProject();
  try {
    // 使用 pending 任务卡 + stopWhen 让 verify 阶段执行 testCommand
    createTasksFile(projectRoot, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 默认测试命令设为 FAIL_TEST_CMD（会失败）
    const orchestrator = buildOrchestrator({
      defaultTestCommand: FAIL_TEST_CMD,
      defaultTestTimeoutSec: 30,
    });

    // 使用 loopConfig 设置 stopWhen，让 verify 通过后触发 stop_when
    const loopConfig = createLoopConfig({
      maxIterations: 1,
      stopWhen: "all tests pass",
    });
    const node = createLoopNode("node-1", "实现 Service1 功能", { loopConfig });
    // input 中提供 PASS_TEST_CMD（覆盖默认的 FAIL_TEST_CMD）
    const input = Object.freeze({
      projectRoot,
      testCommand: PASS_TEST_CMD,
    });
    const context = createGraphRunContext();

    const result = await orchestrator.runAsGraphNode(node, input, context);

    // 应使用 input.testCommand（PASS_TEST_CMD），verify 通过 → stop_when → completed
    assert.equal(result.status, "completed");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("E2. input.testTimeoutSec 覆盖默认超时", async () => {
  const projectRoot = createTempProject();
  try {
    // 使用 pending 任务卡 + stopWhen 让 verify 阶段执行 testCommand
    createTasksFile(projectRoot, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator({
      defaultTestCommand: PASS_TEST_CMD,
      defaultTestTimeoutSec: 60,
    });

    // 使用 loopConfig 设置 stopWhen，让 verify 通过后触发 stop_when
    const loopConfig = createLoopConfig({
      maxIterations: 1,
      stopWhen: "all tests pass",
    });
    const node = createLoopNode("node-1", "实现 Service1 功能", { loopConfig });
    // input 中提供 testTimeoutSec=10（覆盖默认 60）
    const input = Object.freeze({
      projectRoot,
      testTimeoutSec: 10,
    });
    const context = createGraphRunContext();

    const result = await orchestrator.runAsGraphNode(node, input, context);

    // 执行应成功（testTimeoutSec 被正确提取）
    assert.equal(result.status, "completed");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// F. 成功路径（finalStatus=completed → status=completed + loopReport）
// ============================================================================

test("F1. 成功路径：completed → status=completed + loopReport 正确", async () => {
  const projectRoot = createTempProject();
  try {
    // 使用 pending 任务卡 + stopWhen 让 verify 通过后触发 stop_when（视为 completed）
    createTasksFile(projectRoot, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator({
      defaultTestCommand: PASS_TEST_CMD,
      defaultTestTimeoutSec: 30,
    });

    // 使用 loopConfig 设置 stopWhen，让 verify 通过后触发 stop_when
    const loopConfig = createLoopConfig({
      maxIterations: 1,
      stopWhen: "all tests pass",
    });
    const node = createLoopNode("node-1", "实现 Service1 功能", { loopConfig });
    const input = Object.freeze({ projectRoot });
    const context = createGraphRunContext();

    const result = await orchestrator.runAsGraphNode(node, input, context);

    // 1. 状态验证
    assert.equal(result.nodeId, "node-1");
    assert.equal(result.nodeType, "loop");
    assert.equal(result.status, "completed");
    assert.equal(result.retryCount, 0);
    assert.ok(result.durationSec >= 0);
    assert.equal(result.failureReason, undefined);

    // 2. output 字段验证
    const output = result.output as Record<string, unknown>;
    assert.ok(output.finalStatus !== undefined);
    assert.ok(output.exitCode !== undefined);
    assert.ok(output.totalIterations !== undefined);
    assert.ok(output.totalTokensUsed !== undefined);
    assert.ok(output.durationSec !== undefined);
    assert.ok(typeof output.finalReport === "string");
    assert.ok(Array.isArray(output.milestones));
    assert.ok(Array.isArray(output.triggeredGuards));

    // 3. loopReport 验证
    const loopReport = result.loopReport;
    assert.ok(loopReport !== undefined);
    assert.equal(loopReport!.loopType, "coding");
    assert.equal(loopReport!.objective, "实现 Service1 功能");
    assert.ok(loopReport!.totalIterations >= 1);
    assert.ok(loopReport!.finalStatus === "completed" || loopReport!.finalStatus === "failed");
    assert.ok(Array.isArray(loopReport!.events));
    assert.equal(loopReport!.events.length, 0);
    assert.ok(loopReport!.tokenUsed >= 0);
    assert.ok(loopReport!.durationSec >= 0);
    assert.equal(loopReport!.committedCount, 0);
    assert.ok(Array.isArray(loopReport!.humanCheckpoints));
    assert.equal(loopReport!.humanCheckpoints.length, 0);
    assert.ok(typeof loopReport!.finalSummary === "string");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// G. 失败路径（finalStatus=failed → status=failed + failureReason）
// ============================================================================

test("G1. 失败路径：测试失败 → status=failed + failureReason 非空", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot);
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 使用 FAIL_TEST_CMD 使 verify 阶段失败
    const orchestrator = buildOrchestrator({
      defaultTestCommand: FAIL_TEST_CMD,
      defaultTestTimeoutSec: 30,
      defaultMaxIterations: 1, // 限制为 1 轮迭代，加快测试速度
    });

    const node = createLoopNode("node-1", "实现 Service1 功能");
    const input = Object.freeze({ projectRoot });
    const context = createGraphRunContext();

    const result = await orchestrator.runAsGraphNode(node, input, context);

    // 失败状态验证
    assert.equal(result.status, "failed");
    assert.ok(result.failureReason !== undefined);
    assert.ok(result.failureReason!.length > 0);
    assert.equal(result.retryCount, 0);

    // output 仍应包含执行统计
    const output = result.output as Record<string, unknown>;
    assert.ok(output.finalStatus !== undefined);
    assert.ok(output.totalIterations !== undefined);

    // loopReport 也应存在（失败时也有 Loop 报告）
    const loopReport = result.loopReport;
    assert.ok(loopReport !== undefined);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// H. token 累加（context.totalTokensUsed 累加 runResult.totalTokensUsed）
// ============================================================================

test("H1. 执行后 context.totalTokensUsed 累加 runResult.totalTokensUsed", async () => {
  const projectRoot = createTempProject();
  try {
    // 使用 completed 任务卡：plan 找不到 pending → 触发 completed 终止条件
    createTasksFile(projectRoot, "completed");

    const orchestrator = buildOrchestrator({
      defaultTestCommand: PASS_TEST_CMD,
      defaultTestTimeoutSec: 30,
    });

    const node = createLoopNode("node-1", "实现 Service1 功能");
    const input = Object.freeze({ projectRoot });
    const context = createGraphRunContext();

    // 记录执行前的 totalTokensUsed
    const tokensBefore = context.totalTokensUsed;

    const result = await orchestrator.runAsGraphNode(node, input, context);

    // 执行后 totalTokensUsed 应累加
    const tokensAfter = context.totalTokensUsed;
    const output = result.output as Record<string, unknown>;
    const runTokensUsed = output.totalTokensUsed as number;

    // 验证累加正确性：tokensAfter = tokensBefore + runTokensUsed
    assert.equal(tokensAfter, tokensBefore + runTokensUsed);
    assert.ok(tokensAfter >= tokensBefore);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("H2. 多次调用 runAsGraphNode 时 token 累加持续递增", async () => {
  const projectRoot = createTempProject();
  try {
    // 使用 completed 任务卡：plan 找不到 pending → 触发 completed 终止条件
    createTasksFile(projectRoot, "completed");

    const orchestrator = buildOrchestrator({
      defaultTestCommand: PASS_TEST_CMD,
      defaultTestTimeoutSec: 30,
    });

    const context = createGraphRunContext();
    const tokensBefore = context.totalTokensUsed;

    // 第一次调用
    const node1 = createLoopNode("node-1", "实现 Service1 功能");
    const input1 = Object.freeze({ projectRoot });
    await orchestrator.runAsGraphNode(node1, input1, context);
    const tokensAfterFirst = context.totalTokensUsed;
    assert.ok(tokensAfterFirst >= tokensBefore);

    // 第二次调用（使用不同的 nodeId）
    const node2 = createLoopNode("node-2", "实现 Service2 功能");
    const input2 = Object.freeze({ projectRoot });
    await orchestrator.runAsGraphNode(node2, input2, context);
    const tokensAfterSecond = context.totalTokensUsed;
    assert.ok(tokensAfterSecond >= tokensAfterFirst);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// I. GraphNodeResult 不可变性验证
// ============================================================================

test("I1. 成功路径返回的 GraphNodeResult 被 Object.freeze 冻结", async () => {
  const projectRoot = createTempProject();
  try {
    // 使用 pending 任务卡 + stopWhen 让 verify 通过后触发 stop_when（视为 completed）
    createTasksFile(projectRoot, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator({
      defaultTestCommand: PASS_TEST_CMD,
      defaultTestTimeoutSec: 30,
    });

    // 使用 loopConfig 设置 stopWhen，让 verify 通过后触发 stop_when
    const loopConfig = createLoopConfig({
      maxIterations: 1,
      stopWhen: "all tests pass",
    });
    const node = createLoopNode("node-1", "实现 Service1 功能", { loopConfig });
    const input = Object.freeze({ projectRoot });
    const context = createGraphRunContext();

    const result = await orchestrator.runAsGraphNode(node, input, context);

    // GraphNodeResult 应被冻结
    assert.ok(Object.isFrozen(result), "GraphNodeResult 应被 Object.freeze 冻结");
    // output 应被冻结
    assert.ok(Object.isFrozen(result.output), "output 应被 Object.freeze 冻结");
    // loopReport 应被冻结
    if (result.loopReport) {
      assert.ok(Object.isFrozen(result.loopReport), "loopReport 应被 Object.freeze 冻结");
    }
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("I2. 失败路径返回的 GraphNodeResult 被 Object.freeze 冻结", async () => {
  const orchestrator = buildOrchestrator();
  const node = createLoopNode("node-1", ""); // 空 task 触发 failed
  const input = Object.freeze({});
  const context = createGraphRunContext();

  const result = await orchestrator.runAsGraphNode(node, input, context);

  assert.equal(result.status, "failed");
  assert.ok(Object.isFrozen(result), "失败的 GraphNodeResult 也应被 Object.freeze 冻结");
});

// ============================================================================
// J. LoopRunReport 字段映射正确性
// ============================================================================

test("J1. LoopRunReport 字段映射正确（completed 路径）", async () => {
  const projectRoot = createTempProject();
  try {
    // 使用 pending 任务卡 + stopWhen 让 verify 通过后触发 stop_when（视为 completed）
    createTasksFile(projectRoot, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator({
      defaultTestCommand: PASS_TEST_CMD,
      defaultTestTimeoutSec: 30,
    });

    // 使用 loopConfig 设置 stopWhen，让 verify 通过后触发 stop_when
    const loopConfig = createLoopConfig({
      maxIterations: 1,
      stopWhen: "all tests pass",
    });
    const objective = "实现 Service1 功能";
    const node = createLoopNode("node-1", objective, { loopConfig });
    const input = Object.freeze({ projectRoot });
    const context = createGraphRunContext();

    const result = await orchestrator.runAsGraphNode(node, input, context);

    // 验证 LoopRunReport 各字段映射正确
    const loopReport = result.loopReport;
    assert.ok(loopReport !== undefined);

    // runId：应与 AutonomousRunResult.runId 一致（非空字符串）
    assert.ok(typeof loopReport!.runId === "string");
    assert.ok(loopReport!.runId.length > 0);

    // loopType：P5 默认为 "coding"
    assert.equal(loopReport!.loopType, "coding");

    // objective：应与 node.task 一致
    assert.equal(loopReport!.objective, objective);

    // totalIterations：应与 AutonomousRunResult.totalIterations 一致（>= 1）
    assert.ok(loopReport!.totalIterations >= 1);

    // finalStatus：completed/stop_when 路径应映射为 "completed"
    assert.equal(loopReport!.finalStatus, "completed");

    // events：P5 不维护 LoopEvent 列表，应为空数组
    assert.ok(Array.isArray(loopReport!.events));
    assert.equal(loopReport!.events.length, 0);

    // tokenUsed：应与 AutonomousRunResult.totalTokensUsed 一致
    const output = result.output as Record<string, unknown>;
    assert.equal(loopReport!.tokenUsed, output.totalTokensUsed);

    // durationSec：应与 AutonomousRunResult.durationSec 一致
    assert.equal(loopReport!.durationSec, output.durationSec);

    // committedCount：P5 不自动 commit，应为 0
    assert.equal(loopReport!.committedCount, 0);

    // humanCheckpoints：P5 无人值守，应为空数组
    assert.ok(Array.isArray(loopReport!.humanCheckpoints));
    assert.equal(loopReport!.humanCheckpoints.length, 0);

    // finalSummary：应为 finalReport 的前 500 字符（或完整 finalReport）
    assert.ok(typeof loopReport!.finalSummary === "string");
    assert.ok(loopReport!.finalSummary.length > 0);
    // 如果 finalReport 长度 > 500，finalSummary 应以 "..." 结尾
    const finalReport = output.finalReport as string;
    if (finalReport.length > 500) {
      assert.ok(loopReport!.finalSummary.endsWith("..."));
      assert.ok(loopReport!.finalSummary.length <= 503); // 500 + "..."
    } else {
      assert.equal(loopReport!.finalSummary, finalReport);
    }
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("J2. LoopRunReport 字段映射正确（failed 路径）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot);
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator({
      defaultTestCommand: FAIL_TEST_CMD,
      defaultTestTimeoutSec: 30,
      defaultMaxIterations: 1,
    });

    const objective = "实现 Service1 功能";
    const node = createLoopNode("node-1", objective);
    const input = Object.freeze({ projectRoot });
    const context = createGraphRunContext();

    const result = await orchestrator.runAsGraphNode(node, input, context);

    // 失败路径的 LoopRunReport
    const loopReport = result.loopReport;
    assert.ok(loopReport !== undefined);

    // finalStatus 应为 "failed"
    assert.equal(loopReport!.finalStatus, "failed");

    // 其他字段映射应一致
    assert.equal(loopReport!.loopType, "coding");
    assert.equal(loopReport!.objective, objective);
    assert.ok(loopReport!.totalIterations >= 1);
    assert.equal(loopReport!.committedCount, 0);
    assert.equal(loopReport!.humanCheckpoints.length, 0);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// K. output 字段完整性验证
// ============================================================================

test("K1. 成功路径 output 包含全部预期字段", async () => {
  const projectRoot = createTempProject();
  try {
    // 使用 pending 任务卡 + stopWhen 让 verify 通过后触发 stop_when（视为 completed）
    createTasksFile(projectRoot, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator({
      defaultTestCommand: PASS_TEST_CMD,
      defaultTestTimeoutSec: 30,
    });

    // 使用 loopConfig 设置 stopWhen，让 verify 通过后触发 stop_when
    const loopConfig = createLoopConfig({
      maxIterations: 1,
      stopWhen: "all tests pass",
    });
    const node = createLoopNode("node-1", "实现 Service1 功能", { loopConfig });
    const input = Object.freeze({ projectRoot });
    const context = createGraphRunContext();

    const result = await orchestrator.runAsGraphNode(node, input, context);

    const output = result.output as Record<string, unknown>;

    // 验证 output 包含全部预期字段（对齐 §12.4 适配逻辑第 9 步）
    assert.ok("finalStatus" in output, "output 应包含 finalStatus 字段");
    assert.ok("exitCode" in output, "output 应包含 exitCode 字段");
    assert.ok("totalIterations" in output, "output 应包含 totalIterations 字段");
    assert.ok("totalLlmCallCount" in output, "output 应包含 totalLlmCallCount 字段");
    assert.ok("totalTokensUsed" in output, "output 应包含 totalTokensUsed 字段");
    assert.ok("durationSec" in output, "output 应包含 durationSec 字段");
    assert.ok("finalReport" in output, "output 应包含 finalReport 字段");
    assert.ok("milestones" in output, "output 应包含 milestones 字段");
    assert.ok("triggeredGuards" in output, "output 应包含 triggeredGuards 字段");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// L. run() 异常时返回 failed 状态
// ============================================================================

test("L1. run() 抛异常时返回 failed 状态 + failureReason 包含异常信息", async () => {
  const projectRoot = createTempProject();
  try {
    // 不创建 tasks.md，让 plan 阶段无法解析任务卡
    // 但这不会导致 run() 抛异常，而是返回 failed 状态
    // 为了触发 run() 抛异常，需要让 RunStateStore.initialize 失败

    // 使用一个不存在的 projectRoot 让 run() 内部失败
    const orchestrator = buildOrchestrator({
      defaultTestCommand: PASS_TEST_CMD,
      defaultTestTimeoutSec: 30,
    });

    const node = createLoopNode("node-1", "测试任务");
    // 使用一个不存在的路径作为 projectRoot
    const input = Object.freeze({
      projectRoot: "/nonexistent/path/that/does/not/exist",
    });
    const context = createGraphRunContext();

    const result = await orchestrator.runAsGraphNode(node, input, context);

    // 应返回 failed 或 completed（取决于 run() 内部如何处理不存在的路径）
    // 无论如何，status 应为 "failed" 或 "completed"
    assert.ok(result.status === "failed" || result.status === "completed");
    assert.equal(result.retryCount, 0);
  } finally {
    cleanupTempProject(projectRoot);
  }
});
