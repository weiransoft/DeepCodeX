/**
 * EAG-P3 批次 10 单元测试：long-horizon/eag-status-handler.ts /eag-status 命令处理器
 *
 * 测试范围（对齐设计文档 §4.14）：
 * - T1.  EagStatusHandler 实例化（构造函数校验必填依赖）
 * - T2.  handle() 请求字段校验（projectRoot / runId / recentCount）
 * - T3.  handle() 单 run 详情模式：runId 不存在 → 抛 run-not-found
 * - T4.  handle() 单 run 详情报告生成（含必要章节）
 * - T5.  handle() 最近 run 列表模式（空列表场景）
 * - T6.  handle() 单 run 详情报告章节完整性断言
 * - T7.  EagStatusHandlerError 字段断言
 * - T8.  handle() recentCount 默认值（10）
 * - T9.  handle() 列表报告格式断言
 * - T10. handle() 多个 RunState 列表显示
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用真实 RunStateStore（无 mock）
 * - 前置 RunState 通过真实 EagRunHandler 创建（真实业务流程的子集）
 * - 真实文件系统 I/O（fs.mkdtempSync + try/finally 清理）
 * - 真实 git 仓库初始化（childProcess.execSync git init + commit）
 * - 使用 node:test + node:assert/strict
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计文档 §4.14 EagStatusHandler
 * - EAG 方案 §5.12.2 长程任务自动化（进度报告）
 * - eag/long-horizon/eag-status-handler.ts 源文件
 *
 * @module core/tests/eag-long-horizon-eag-status-handler
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { EagRunHandler } from "../eag/long-horizon/eag-run-handler";
import type { LoopExecutor, LoopExecutionContext, LoopExecutionResult } from "../eag/long-horizon/eag-run-handler";
import { EagStatusHandler, EagStatusHandlerError } from "../eag/long-horizon/eag-status-handler";
import { RunStateStore } from "../eag/long-horizon/run-state-store";
import { MultiLoopPlanner } from "../eag/long-horizon/multi-loop-planner";
import { MilestoneTagger, HealthScoreCalculator } from "../eag/long-horizon/milestone-tagger";
import { BlockageAnalyzer } from "../eag/long-horizon/blockage-analyzer";

// ============================================================================
// 辅助工具
// ============================================================================

/**
 * 创建临时项目根目录
 *
 * @returns 临时项目根目录绝对路径
 */
function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eag-status-handler-"));
}

/**
 * 递归删除目录
 *
 * @param dirPath 待删除目录
 */
function rmrf(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
}

/**
 * 在临时目录初始化一个真实 git 仓库（含一次 commit）以支持 MilestoneTagger 的 git tag 操作
 *
 * @param projectRoot 项目根目录
 */
function initGitRepo(projectRoot: string): void {
  // git init（在临时目录中创建 .git 目录）
  childProcess.execSync("git init", { cwd: projectRoot, stdio: "pipe" });
  // 配置 git 用户信息（避免 commit 报错 "Please tell me who you are"）
  childProcess.execSync('git config user.email "test@example.com"', {
    cwd: projectRoot,
    stdio: "pipe",
  });
  childProcess.execSync('git config user.name "Test User"', {
    cwd: projectRoot,
    stdio: "pipe",
  });
  // 创建占位文件并提交（git tag 必须指向一个 commit）
  fs.writeFileSync(path.join(projectRoot, "README.md"), "# Test Project\n", "utf8");
  childProcess.execSync("git add README.md", { cwd: projectRoot, stdio: "pipe" });
  childProcess.execSync('git commit -m "init"', { cwd: projectRoot, stdio: "pipe" });
}

/**
 * 真实 Loop 执行器（基于内存状态，非 mock）
 *
 * 实现 LoopExecutor 协议，根据 loopType 返回真实的 LoopExecutionResult。
 */
class InMemoryLoopExecutor implements LoopExecutor {
  /** Loop 类型 */
  public readonly loopType: "design" | "coding" | "testing";
  /** 累计调用次数（用于断言执行次数） */
  public callCount: number = 0;

  constructor(loopType: "design" | "coding" | "testing") {
    this.loopType = loopType;
  }

  async execute(context: Readonly<LoopExecutionContext>): Promise<Readonly<LoopExecutionResult>> {
    this.callCount += 1;

    // 成功路径：根据 loopType 返回真实 artifacts
    const generatedArtifacts: Record<string, string> = {};
    if (context.node.loopType === "design") {
      generatedArtifacts.spec = "# spec.md\n\n## 模块：主模块\n";
    } else if (context.node.loopType === "coding") {
      generatedArtifacts.plan = "# plan.md\n";
      generatedArtifacts.tasks = "# tasks.md\n";
    } else if (context.node.loopType === "testing") {
      generatedArtifacts["test-report"] = "# 测试报告\n";
    }

    return Object.freeze({
      nodeId: context.node.nodeId,
      loopType: context.node.loopType,
      finalStatus: "completed" as const,
      generatedArtifacts: Object.freeze(generatedArtifacts),
      llmCallCount: 5,
      tokensUsed: 1000,
      durationSec: 0.5,
    }) as LoopExecutionResult;
  }
}

/**
 * 装配测试用 EagRunHandler 实例（注入真实依赖）
 *
 * 用于在 status 查询之前创建前置 RunState。
 *
 * @param runStateStore RunState 持久化存储
 * @param loopExecutors Loop 执行器列表
 * @returns EagRunHandler 实例
 */
function buildRunHandler(runStateStore: RunStateStore, loopExecutors: ReadonlyArray<LoopExecutor>): EagRunHandler {
  const multiLoopPlanner = new MultiLoopPlanner();
  const milestoneTagger = new MilestoneTagger(runStateStore, undefined, {
    regressionTestCommand: "node -e \"console.log('test ok')\"",
    regressionTestTimeoutSec: 30,
    healthScoreCalculator: new HealthScoreCalculator(),
  });
  const blockageAnalyzer = new BlockageAnalyzer(runStateStore);

  return new EagRunHandler({
    multiLoopPlanner,
    runStateStore,
    milestoneTagger,
    blockageAnalyzer,
    loopExecutors,
  });
}

/**
 * 创建一个已完成的 RunState（design + coding + testing 三个 Loop 全部完成）
 *
 * @param projectRoot 项目根目录
 * @param runStateStore RunState 持久化存储
 * @param userIntent 用户意图（用于区分多个 RunState）
 * @returns runId
 */
async function createCompletedRun(
  projectRoot: string,
  runStateStore: RunStateStore,
  userIntent: string
): Promise<string> {
  const designExec = new InMemoryLoopExecutor("design");
  const codingExec = new InMemoryLoopExecutor("coding");
  const testingExec = new InMemoryLoopExecutor("testing");
  const runHandler = buildRunHandler(runStateStore, [designExec, codingExec, testingExec]);
  const result = await runHandler.handle({
    projectRoot,
    userIntent,
    autoTransition: true,
    loopExecutors: [designExec, codingExec, testingExec],
  });
  return result.runId;
}

// ============================================================================
// T1. EagStatusHandler 实例化（构造函数校验）
// ============================================================================

test("T1.1 EagStatusHandler 构造函数注入 runStateStore 可成功实例化", () => {
  const handler = new EagStatusHandler({ runStateStore: new RunStateStore() });
  assert.ok(handler instanceof EagStatusHandler);
});

test("T1.2 EagStatusHandler 缺少 runStateStore 抛 request-invalid", () => {
  assert.throws(
    () => new EagStatusHandler({} as never),
    (err: unknown) => {
      assert.ok(err instanceof EagStatusHandlerError);
      assert.equal(err.kind, "request-invalid");
      assert.ok(err.detail.includes("runStateStore 必填"));
      return true;
    }
  );
});

// ============================================================================
// T2. handle() 请求字段校验
// ============================================================================

test("T2.1 handle() projectRoot 为空字符串 → 抛 request-invalid", async () => {
  const handler = new EagStatusHandler({ runStateStore: new RunStateStore() });
  await assert.rejects(handler.handle({ projectRoot: "", runId: "test001" }), (err: unknown) => {
    assert.ok(err instanceof EagStatusHandlerError);
    assert.equal(err.kind, "request-invalid");
    assert.ok(err.detail.includes("projectRoot 必须为非空字符串"));
    return true;
  });
});

test("T2.2 handle() runId 为空字符串 → 抛 request-invalid", async () => {
  const handler = new EagStatusHandler({ runStateStore: new RunStateStore() });
  await assert.rejects(handler.handle({ projectRoot: "/tmp", runId: "" }), (err: unknown) => {
    assert.ok(err instanceof EagStatusHandlerError);
    assert.equal(err.kind, "request-invalid");
    assert.ok(err.detail.includes("runId 必须为非空字符串"));
    return true;
  });
});

test("T2.3 handle() recentCount 为 0 → 抛 request-invalid", async () => {
  const handler = new EagStatusHandler({ runStateStore: new RunStateStore() });
  await assert.rejects(handler.handle({ projectRoot: "/tmp", recentCount: 0 }), (err: unknown) => {
    assert.ok(err instanceof EagStatusHandlerError);
    assert.equal(err.kind, "request-invalid");
    assert.ok(err.detail.includes("recentCount 必须为整数且 >= 1"));
    return true;
  });
});

test("T2.4 handle() recentCount 为非整数（1.5）→ 抛 request-invalid", async () => {
  const handler = new EagStatusHandler({ runStateStore: new RunStateStore() });
  await assert.rejects(handler.handle({ projectRoot: "/tmp", recentCount: 1.5 }), (err: unknown) => {
    assert.ok(err instanceof EagStatusHandlerError);
    assert.equal(err.kind, "request-invalid");
    assert.ok(err.detail.includes("recentCount 必须为整数且 >= 1"));
    return true;
  });
});

// ============================================================================
// T3. handle() 单 run 详情模式：runId 不存在 → 抛 run-not-found
// ============================================================================

test("T3.1 handle() runId 不存在 → 抛 run-not-found", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const handler = new EagStatusHandler({ runStateStore: new RunStateStore() });

    await assert.rejects(
      handler.handle({
        projectRoot,
        runId: "nonexistent888",
      }),
      (err: unknown) => {
        assert.ok(err instanceof EagStatusHandlerError);
        assert.equal(err.kind, "run-not-found");
        assert.ok(err.detail.includes("run-id 不存在"));
        assert.ok(err.detail.includes("nonexistent888"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T4. handle() 单 run 详情报告生成（含必要章节）
// ============================================================================

test("T4.1 handle() 提供合法 runId → 返回报告 + runState", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = await createCompletedRun(projectRoot, runStateStore, "测试合法 runId 报告生成");

    const handler = new EagStatusHandler({ runStateStore });
    const result = await handler.handle({ projectRoot, runId });

    // 验证返回值结构
    assert.ok(typeof result.report === "string");
    assert.ok(result.report.length > 0);
    assert.ok(result.runState !== undefined);
    assert.equal(result.runState!.runId, runId);
    // 报告标题应包含 runId
    assert.ok(result.report.includes(`# EAG Run Status: ${runId}`));
  } finally {
    rmrf(projectRoot);
  }
});

test("T4.2 handle() 报告含 run-id 标题与状态字段", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = await createCompletedRun(projectRoot, runStateStore, "测试报告标题与状态字段");

    const handler = new EagStatusHandler({ runStateStore });
    const result = await handler.handle({ projectRoot, runId });

    // 报告标题应含 run-id
    assert.ok(result.report.includes(`# EAG Run Status: ${runId}`));
    // 报告应含 "状态" 字段
    assert.ok(result.report.includes("**状态**"));
    // 报告应含 "启动时间" 字段
    assert.ok(result.report.includes("**启动时间**"));
    // 报告应含 "当前 Loop" 字段
    assert.ok(result.report.includes("**当前 Loop**"));
    // 报告应含 "当前迭代" 字段
    assert.ok(result.report.includes("**当前迭代**"));
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T5. handle() 最近 run 列表模式（空列表场景）
// ============================================================================

test("T5.1 handle() 无 runId + 无 RunState 文件 → 返回空列表报告", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const handler = new EagStatusHandler({ runStateStore: new RunStateStore() });

    const result = await handler.handle({ projectRoot });

    // 验证返回值结构
    assert.ok(typeof result.report === "string");
    assert.ok(result.report.length > 0);
    // recentRuns 应为空数组
    assert.ok(Array.isArray(result.recentRuns));
    assert.equal(result.recentRuns!.length, 0);
    // runState 应为 undefined（列表模式不返回单 run 详情）
    assert.equal(result.runState, undefined);
    // 报告应含 "EAG Recent Runs" 标题
    assert.ok(result.report.includes("# EAG Recent Runs"));
    // 报告应含 "无 Run 记录" 占位文本
    assert.ok(result.report.includes("（无 Run 记录）"));
  } finally {
    rmrf(projectRoot);
  }
});

test("T5.2 handle() 无 runId + 有 RunState 文件 → 返回最近 N 个 run 列表", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    // 创建 1 个 RunState
    await createCompletedRun(projectRoot, runStateStore, "测试列表模式（含 1 个 run）");

    const handler = new EagStatusHandler({ runStateStore });
    const result = await handler.handle({ projectRoot, recentCount: 10 });

    // recentRuns 应有 1 条记录
    assert.ok(Array.isArray(result.recentRuns));
    assert.equal(result.recentRuns!.length, 1);
    // 报告应含表格行（含 runId 占位）
    assert.ok(result.report.includes("| # | run-id | 状态"));
    // 报告应含 "使用 `/eag-status <run-id>` 查看单 run 详情" 提示
    assert.ok(result.report.includes("使用 `/eag-status <run-id>`"));
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T6. handle() 单 run 详情报告章节完整性断言
// ============================================================================

test('T6.1 handle() 单 run 详情报告含 "基本信息" 章节', async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = await createCompletedRun(projectRoot, runStateStore, "测试报告章节：基本信息");

    const handler = new EagStatusHandler({ runStateStore });
    const result = await handler.handle({ projectRoot, runId });

    assert.ok(result.report.includes("## 基本信息"));
  } finally {
    rmrf(projectRoot);
  }
});

test('T6.2 handle() 单 run 详情报告含 "完成度" 章节', async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = await createCompletedRun(projectRoot, runStateStore, "测试报告章节：完成度");

    const handler = new EagStatusHandler({ runStateStore });
    const result = await handler.handle({ projectRoot, runId });

    assert.ok(result.report.includes("## 完成度"));
    // 完成度章节应含 "总进度" 字段
    assert.ok(result.report.includes("**总进度**"));
    // 完成度章节应含三个 Loop 的显示（DESIGN / CODING / TESTING）
    assert.ok(result.report.includes("DESIGN Loop"));
    assert.ok(result.report.includes("CODING Loop"));
    assert.ok(result.report.includes("TESTING Loop"));
  } finally {
    rmrf(projectRoot);
  }
});

test('T6.3 handle() 单 run 详情报告含 "耗时与 Token" 章节', async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = await createCompletedRun(projectRoot, runStateStore, "测试报告章节：耗时与 Token");

    const handler = new EagStatusHandler({ runStateStore });
    const result = await handler.handle({ projectRoot, runId });

    assert.ok(result.report.includes("## 耗时与 Token"));
    assert.ok(result.report.includes("**总耗时**"));
    assert.ok(result.report.includes("**总 Token**"));
    assert.ok(result.report.includes("**总 LLM 调用**"));
  } finally {
    rmrf(projectRoot);
  }
});

test('T6.4 handle() 单 run 详情报告含 "里程碑" 章节', async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = await createCompletedRun(projectRoot, runStateStore, "测试报告章节：里程碑");

    const handler = new EagStatusHandler({ runStateStore });
    const result = await handler.handle({ projectRoot, runId });

    assert.ok(result.report.includes("## 里程碑"));
    // 完成的 Run 应有 3 个 milestone（design + coding + testing）
    // 报告应含表格头
    assert.ok(result.report.includes("| # | 名称 | 完成时间 | 健康度 | Tag |"));
    // 报告应含 milestone 的 tag 名（eag/<runId>/m1）
    assert.ok(result.report.includes(`eag/${runId}/m1`));
  } finally {
    rmrf(projectRoot);
  }
});

test('T6.5 handle() 单 run 详情报告含 "阻塞点" 章节', async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = await createCompletedRun(projectRoot, runStateStore, "测试报告章节：阻塞点");

    const handler = new EagStatusHandler({ runStateStore });
    const result = await handler.handle({ projectRoot, runId });

    assert.ok(result.report.includes("## 阻塞点"));
    // 完成的 Run 阻塞点应为"（无）"
    assert.ok(result.report.includes("（无）"));
  } finally {
    rmrf(projectRoot);
  }
});

test('T6.6 handle() 单 run 详情报告含 "人工介入历史" 章节', async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = await createCompletedRun(projectRoot, runStateStore, "测试报告章节：人工介入历史");

    const handler = new EagStatusHandler({ runStateStore });
    const result = await handler.handle({ projectRoot, runId });

    assert.ok(result.report.includes("## 人工介入历史"));
    // 完成的 Run 人工介入历史应为"（无）"
    assert.ok(result.report.includes("（无）"));
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T7. EagStatusHandlerError 字段断言
// ============================================================================

test("T7.1 EagStatusHandlerError 含 kind + detail + cause 字段", () => {
  const cause = new Error("原始错误");
  const err = new EagStatusHandlerError("run-not-found", "run-id 不存在", cause);
  assert.ok(err instanceof Error);
  assert.equal(err.name, "EagStatusHandlerError");
  assert.equal(err.kind, "run-not-found");
  assert.equal(err.detail, "run-id 不存在");
  assert.equal(err.cause, cause);
  assert.ok(err.message.includes("run-not-found"));
  assert.ok(err.message.includes("run-id 不存在"));
});

// ============================================================================
// T8. handle() recentCount 默认值（10）
// ============================================================================

test("T8.1 handle() 无 runId + 不提供 recentCount → 默认 10", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    // 创建 12 个 RunState，验证默认 recentCount=10 截取前 10 条
    for (let i = 0; i < 12; i++) {
      await createCompletedRun(projectRoot, runStateStore, `测试默认 recentCount 第 ${i + 1} 个 run`);
    }

    const handler = new EagStatusHandler({ runStateStore });
    const result = await handler.handle({ projectRoot }); // 不提供 recentCount，默认 10

    // 验证 recentRuns 被截取为 10 条
    assert.ok(Array.isArray(result.recentRuns));
    assert.equal(result.recentRuns!.length, 10);
    // 报告应含 "最近 10 个 EAG Run" 文本
    assert.ok(result.report.includes("最近 10 个 EAG Run"));
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T9. handle() 列表报告格式断言
// ============================================================================

test('T9.1 handle() 列表报告含 "EAG Recent Runs" 标题与表格头', async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    await createCompletedRun(projectRoot, runStateStore, "测试列表报告格式");

    const handler = new EagStatusHandler({ runStateStore });
    const result = await handler.handle({ projectRoot, recentCount: 5 });

    // 标题
    assert.ok(result.report.includes("# EAG Recent Runs"));
    // 表格头
    assert.ok(result.report.includes("| # | run-id | 状态 | 当前 Loop | 完成度 | 启动时间 | 最近更新 |"));
    assert.ok(result.report.includes("|---|--------|------|-----------|--------|---------|---------|"));
    // 提示语
    assert.ok(result.report.includes("使用 `/eag-status <run-id>` 查看单 run 详情"));
    assert.ok(result.report.includes("使用 `/eag-resume <run-id>` 恢复执行"));
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T10. handle() 多个 RunState 列表显示
// ============================================================================

test("T10.1 handle() 创建 3 个 RunState 后，列表报告含 3 条记录", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    // 创建 3 个 RunState
    const runId1 = await createCompletedRun(projectRoot, runStateStore, "测试列表显示 1");
    const runId2 = await createCompletedRun(projectRoot, runStateStore, "测试列表显示 2");
    const runId3 = await createCompletedRun(projectRoot, runStateStore, "测试列表显示 3");

    const handler = new EagStatusHandler({ runStateStore });
    const result = await handler.handle({ projectRoot, recentCount: 10 });

    // recentRuns 应有 3 条记录
    assert.ok(Array.isArray(result.recentRuns));
    assert.equal(result.recentRuns!.length, 3);
    // 列表应包含全部 3 个 runId
    const runIds = result.recentRuns!.map((s) => s.runId);
    assert.ok(runIds.includes(runId1));
    assert.ok(runIds.includes(runId2));
    assert.ok(runIds.includes(runId3));
    // 报告应含 "最近 3 个 EAG Run"
    assert.ok(result.report.includes("最近 3 个 EAG Run"));
    // 报告应含 3 条表格行（含 1 / 2 / 3 编号）
    assert.ok(result.report.includes("| 1 |"));
    assert.ok(result.report.includes("| 2 |"));
    assert.ok(result.report.includes("| 3 |"));
  } finally {
    rmrf(projectRoot);
  }
});
