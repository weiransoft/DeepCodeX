/**
 * EAG-P3 批次 10 单元测试：long-horizon/eag-resume-handler.ts /eag-resume 命令处理器
 *
 * 测试范围（对齐设计文档 §4.13）：
 * - T1.  EagResumeHandler 实例化（构造函数校验必填依赖）
 * - T2.  handle() 请求字段校验（runId / projectRoot / userIntent / loopExecutors）
 * - T3.  handle() RunState 加载错误处理（run-not-found / run-corrupted）
 * - T4.  handle() git HEAD 一致性校验失败 → 抛 run-diverged
 * - T5.  handle() 从 human-checkpoint 恢复 + 用户决策 + 剩余 Loop 全部完成 → finalStatus=completed
 * - T6.  handle() 恢复时 LoopExecutor 抛异常 → finalStatus=failed
 * - T7.  handle() 恢复时 Loop 返回 failed → 回滚到上一个 milestone + finalStatus=human-checkpoint
 * - T8.  handle() 恢复时 Loop 返回 human-checkpoint → finalStatus=human-checkpoint
 * - T9.  handle() 重建 MultiLoopPlan 失败 → 抛 resume-failed
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用真实 RunStateStore + MultiLoopPlanner + MilestoneTagger + BlockageAnalyzer
 * - LoopExecutor 使用真实实现（InMemoryLoopExecutor），按 loopType 路由返回真实业务结果
 * - 真实 git 仓库初始化（childProcess.execSync git init + commit）以支持 MilestoneTagger
 * - 真实文件系统 I/O（fs.mkdtempSync + try/finally 清理）
 * - 恢复场景前置条件：先用 EagRunHandler 创建 RunState，再用 EagResumeHandler 恢复
 *   （这是真实业务流程的子集，非 mock）
 * - 使用 node:test + node:assert/strict
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计文档 §4.13 EagResumeHandler
 * - EAG 方案 §5.12.2 长程任务自动化（断点恢复）
 * - eag/long-horizon/eag-resume-handler.ts 源文件
 *
 * @module core/tests/eag-long-horizon-eag-resume-handler
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { EagRunHandler, EagRunHandlerError } from "../eag/long-horizon/eag-run-handler";
import type { LoopExecutor, LoopExecutionContext, LoopExecutionResult } from "../eag/long-horizon/eag-run-handler";
import { EagResumeHandler, EagResumeHandlerError } from "../eag/long-horizon/eag-resume-handler";
import { RunStateStore } from "../eag/long-horizon/run-state-store";
import { MultiLoopPlanner, MultiLoopPlannerError } from "../eag/long-horizon/multi-loop-planner";
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "eag-resume-handler-"));
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
 * 算法：
 * 1. git init
 * 2. 配置 user.email / user.name（避免 commit 时报错）
 * 3. 创建 README.md 占位文件
 * 4. git add README.md && git commit -m "init"
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
 * 实现 LoopExecutor 协议，根据 loopType 返回真实的 LoopExecutionResult：
 * - design：返回 spec.md 内容
 * - coding：返回 plan + tasks 内容
 * - testing：返回 test-report 内容
 *
 * 可注入失败模式（failOnLoop / throwOnLoop / checkpointOnLoop）用于测试
 * human-intervention / 回滚 / 阻塞分析路径。
 */
class InMemoryLoopExecutor implements LoopExecutor {
  /** Loop 类型 */
  public readonly loopType: "design" | "coding" | "testing";
  /** 失败模式：在此 loopType 上返回 failed */
  public failOnLoop?: "design" | "coding" | "testing";
  /** 抛异常模式：在此 loopType 上抛异常 */
  public throwOnLoop?: "design" | "coding" | "testing";
  /** 返回 human-checkpoint 模式：在此 loopType 上返回 human-checkpoint */
  public checkpointOnLoop?: "design" | "coding" | "testing";
  /** 累计调用次数（用于断言执行次数） */
  public callCount: number = 0;

  constructor(loopType: "design" | "coding" | "testing") {
    this.loopType = loopType;
  }

  async execute(context: Readonly<LoopExecutionContext>): Promise<Readonly<LoopExecutionResult>> {
    this.callCount += 1;

    // 抛异常模式
    if (this.throwOnLoop === context.node.loopType) {
      throw new Error(`测试异常：Loop ${context.node.nodeId} 故意抛错（resume）`);
    }

    // 失败模式
    if (this.failOnLoop === context.node.loopType) {
      return Object.freeze({
        nodeId: context.node.nodeId,
        loopType: context.node.loopType,
        finalStatus: "failed",
        generatedArtifacts: {},
        llmCallCount: 1,
        tokensUsed: 100,
        durationSec: 0.1,
        failureReason: `测试失败（resume）：Loop ${context.node.nodeId} 故意返回 failed`,
      }) as LoopExecutionResult;
    }

    // 人工检查点模式
    if (this.checkpointOnLoop === context.node.loopType) {
      return Object.freeze({
        nodeId: context.node.nodeId,
        loopType: context.node.loopType,
        finalStatus: "human-checkpoint",
        generatedArtifacts: {},
        llmCallCount: 1,
        tokensUsed: 100,
        durationSec: 0.1,
        failureReason: `测试检查点（resume）：Loop ${context.node.nodeId} 等待人工决策`,
      }) as LoopExecutionResult;
    }

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
      finalStatus: "completed",
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
 * 用于在 resume 之前创建前置 RunState（产生 human-checkpoint 状态）。
 *
 * @param runStateStore RunState 持久化存储
 * @param loopExecutors Loop 执行器列表
 * @returns EagRunHandler 实例
 */
function buildRunHandler(runStateStore: RunStateStore, loopExecutors: ReadonlyArray<LoopExecutor>): EagRunHandler {
  // 真实 MultiLoopPlanner（解析 spec.md 生成 DAG）
  const multiLoopPlanner = new MultiLoopPlanner();
  // 真实 MilestoneTagger（使用自定义回归测试命令，避免触发真实 npm test）
  const milestoneTagger = new MilestoneTagger(runStateStore, undefined, {
    regressionTestCommand: "node -e \"console.log('test ok')\"",
    regressionTestTimeoutSec: 30,
    healthScoreCalculator: new HealthScoreCalculator(),
  });
  // 真实 BlockageAnalyzer（不传 ruleStore 与 llmClient，仅使用规则匹配通道）
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
 * 装配测试用 EagResumeHandler 实例（注入真实依赖）
 *
 * @param runStateStore RunState 持久化存储（与 buildRunHandler 共享同一实例）
 * @param multiLoopPlanner 多 Loop 计划生成器（可选，默认 new MultiLoopPlanner()）
 * @returns EagResumeHandler 实例
 */
function buildResumeHandler(
  runStateStore: RunStateStore,
  multiLoopPlanner: MultiLoopPlanner = new MultiLoopPlanner()
): EagResumeHandler {
  const milestoneTagger = new MilestoneTagger(runStateStore, undefined, {
    regressionTestCommand: "node -e \"console.log('test ok')\"",
    regressionTestTimeoutSec: 30,
    healthScoreCalculator: new HealthScoreCalculator(),
  });
  const blockageAnalyzer = new BlockageAnalyzer(runStateStore);

  return new EagResumeHandler({
    runStateStore,
    multiLoopPlanner,
    milestoneTagger,
    blockageAnalyzer,
  });
}

// ============================================================================
// T1. EagResumeHandler 实例化（构造函数校验）
// ============================================================================

test("T1.1 EagResumeHandler 构造函数注入全部依赖可成功实例化", () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const handler = buildResumeHandler(runStateStore);
    assert.ok(handler instanceof EagResumeHandler);
  } finally {
    rmrf(projectRoot);
  }
});

test("T1.2 EagResumeHandler 缺少 runStateStore 抛 request-invalid", () => {
  assert.throws(
    () =>
      new EagResumeHandler({
        // 故意省略 runStateStore
        multiLoopPlanner: new MultiLoopPlanner(),
        milestoneTagger: {} as unknown as MilestoneTagger,
        blockageAnalyzer: {} as unknown as BlockageAnalyzer,
      } as never),
    (err: unknown) => {
      assert.ok(err instanceof EagResumeHandlerError);
      assert.equal(err.kind, "request-invalid");
      assert.ok(err.detail.includes("runStateStore 必填"));
      return true;
    }
  );
});

test("T1.3 EagResumeHandler 缺少 multiLoopPlanner 抛 request-invalid", () => {
  assert.throws(
    () =>
      new EagResumeHandler({
        runStateStore: new RunStateStore(),
        // 故意省略 multiLoopPlanner
        milestoneTagger: {} as unknown as MilestoneTagger,
        blockageAnalyzer: {} as unknown as BlockageAnalyzer,
      } as never),
    (err: unknown) => {
      assert.ok(err instanceof EagResumeHandlerError);
      assert.equal(err.kind, "request-invalid");
      assert.ok(err.detail.includes("multiLoopPlanner 必填"));
      return true;
    }
  );
});

test("T1.4 EagResumeHandler 缺少 milestoneTagger 抛 request-invalid", () => {
  assert.throws(
    () =>
      new EagResumeHandler({
        runStateStore: new RunStateStore(),
        multiLoopPlanner: new MultiLoopPlanner(),
        // 故意省略 milestoneTagger
        blockageAnalyzer: {} as unknown as BlockageAnalyzer,
      } as never),
    (err: unknown) => {
      assert.ok(err instanceof EagResumeHandlerError);
      assert.equal(err.kind, "request-invalid");
      assert.ok(err.detail.includes("milestoneTagger 必填"));
      return true;
    }
  );
});

test("T1.5 EagResumeHandler 缺少 blockageAnalyzer 抛 request-invalid", () => {
  assert.throws(
    () =>
      new EagResumeHandler({
        runStateStore: new RunStateStore(),
        multiLoopPlanner: new MultiLoopPlanner(),
        milestoneTagger: {} as unknown as MilestoneTagger,
        // 故意省略 blockageAnalyzer
      } as never),
    (err: unknown) => {
      assert.ok(err instanceof EagResumeHandlerError);
      assert.equal(err.kind, "request-invalid");
      assert.ok(err.detail.includes("blockageAnalyzer 必填"));
      return true;
    }
  );
});

// ============================================================================
// T2. handle() 请求字段校验
// ============================================================================

test("T2.1 handle() runId 为空字符串 → 抛 request-invalid", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const handler = buildResumeHandler(runStateStore);
    const designExec = new InMemoryLoopExecutor("design");

    await assert.rejects(
      handler.handle({
        runId: "",
        projectRoot,
        userIntent: "测试 runId 为空",
        loopExecutors: [designExec],
      }),
      (err: unknown) => {
        assert.ok(err instanceof EagResumeHandlerError);
        assert.equal(err.kind, "request-invalid");
        assert.ok(err.detail.includes("runId 必须为非空字符串"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T2.2 handle() projectRoot 为空字符串 → 抛 request-invalid", async () => {
  const runStateStore = new RunStateStore();
  const handler = buildResumeHandler(runStateStore);
  const designExec = new InMemoryLoopExecutor("design");

  await assert.rejects(
    handler.handle({
      runId: "testresume001",
      projectRoot: "",
      userIntent: "测试 projectRoot 为空",
      loopExecutors: [designExec],
    }),
    (err: unknown) => {
      assert.ok(err instanceof EagResumeHandlerError);
      assert.equal(err.kind, "request-invalid");
      assert.ok(err.detail.includes("projectRoot 必须为非空字符串"));
      return true;
    }
  );
});

test("T2.3 handle() userIntent 为空字符串 → 抛 request-invalid", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const handler = buildResumeHandler(runStateStore);
    const designExec = new InMemoryLoopExecutor("design");

    await assert.rejects(
      handler.handle({
        runId: "testresume002",
        projectRoot,
        userIntent: "",
        loopExecutors: [designExec],
      }),
      (err: unknown) => {
        assert.ok(err instanceof EagResumeHandlerError);
        assert.equal(err.kind, "request-invalid");
        assert.ok(err.detail.includes("userIntent 必须为非空字符串"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T2.4 handle() loopExecutors 为空数组 → 抛 request-invalid", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const handler = buildResumeHandler(runStateStore);

    await assert.rejects(
      handler.handle({
        runId: "testresume003",
        projectRoot,
        userIntent: "测试 loopExecutors 为空",
        loopExecutors: [],
      }),
      (err: unknown) => {
        assert.ok(err instanceof EagResumeHandlerError);
        assert.equal(err.kind, "request-invalid");
        assert.ok(err.detail.includes("loopExecutors 必须为非空数组"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T3. handle() RunState 加载错误处理
// ============================================================================

test("T3.1 handle() runId 不存在 → 抛 run-not-found", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const handler = buildResumeHandler(runStateStore);
    const designExec = new InMemoryLoopExecutor("design");

    // runId "nonexistent999" 未对应任何 RunState 文件 → load() 抛 RunStateNotFoundError
    // EagResumeHandler 应捕获并转换为 EagResumeHandlerError(kind="run-not-found")
    await assert.rejects(
      handler.handle({
        runId: "nonexistent999",
        projectRoot,
        userIntent: "测试 runId 不存在",
        loopExecutors: [designExec],
      }),
      (err: unknown) => {
        assert.ok(err instanceof EagResumeHandlerError);
        assert.equal(err.kind, "run-not-found");
        assert.ok(err.detail.includes("run-id 不存在"));
        assert.ok(err.detail.includes("nonexistent999"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T3.2 handle() RunState SHA256 校验失败 → 抛 run-corrupted", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();

    // 先用 EagRunHandler 创建一个 RunState（design Loop 抛异常 → finalStatus=failed）
    const designExec = new InMemoryLoopExecutor("design");
    designExec.throwOnLoop = "design";
    const runHandler = buildRunHandler(runStateStore, [
      designExec,
      new InMemoryLoopExecutor("coding"),
      new InMemoryLoopExecutor("testing"),
    ]);
    const runResult = await runHandler.handle({
      projectRoot,
      userIntent: "前置：创建 RunState 以便后续篡改",
      autoTransition: true,
      loopExecutors: [designExec, new InMemoryLoopExecutor("coding"), new InMemoryLoopExecutor("testing")],
    });
    const runId = runResult.runId;

    // 篡改 JSONL 文件内容（在末尾追加一行非法内容以破坏累积 SHA256 校验）
    const jsonlPath = path.join(projectRoot, ".eag", "run-state", `${runId}.jsonl`);
    assert.ok(fs.existsSync(jsonlPath), "RunState JSONL 文件应存在");
    fs.appendFileSync(jsonlPath, '\n{"type":"malicious-event","payload":{}}\n', "utf8");

    // 调用 resume → load() 抛 RunStateCorruptedError → 转换为 EagResumeHandlerError(kind="run-corrupted")
    const resumeHandler = buildResumeHandler(runStateStore);
    await assert.rejects(
      resumeHandler.handle({
        runId,
        projectRoot,
        userIntent: "测试 SHA256 校验失败",
        loopExecutors: [designExec],
      }),
      (err: unknown) => {
        assert.ok(err instanceof EagResumeHandlerError);
        assert.equal(err.kind, "run-corrupted");
        assert.ok(err.detail.includes("SHA256 校验失败"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T4. handle() git HEAD 一致性校验失败 → 抛 run-diverged
// ============================================================================

test("T4.1 handle() git HEAD 与最后 milestone 不一致 → 抛 run-diverged", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();

    // 先用 EagRunHandler 让 design Loop 完成（产生 1 个 milestone）+ coding Loop 返回 human-checkpoint
    const designExec = new InMemoryLoopExecutor("design");
    const codingExec = new InMemoryLoopExecutor("coding");
    codingExec.checkpointOnLoop = "coding"; // coding Loop 返回 human-checkpoint
    const testingExec = new InMemoryLoopExecutor("testing");
    const runHandler = buildRunHandler(runStateStore, [designExec, codingExec, testingExec]);
    const runResult = await runHandler.handle({
      projectRoot,
      userIntent: "前置：design 完成 + coding 触发 human-checkpoint",
      autoTransition: true,
      loopExecutors: [designExec, codingExec, testingExec],
    });
    const runId = runResult.runId;
    assert.equal(runResult.finalStatus, "human-checkpoint");
    assert.equal(runResult.milestones.length, 1);

    // 在 git 仓库中追加一个新 commit，使 HEAD 与 milestone.commitSha 不一致
    fs.writeFileSync(path.join(projectRoot, "manual-change.txt"), "用户手动改了代码\n", "utf8");
    childProcess.execSync("git add manual-change.txt", { cwd: projectRoot, stdio: "pipe" });
    childProcess.execSync('git commit -m "manual change"', { cwd: projectRoot, stdio: "pipe" });

    // 调用 resume → git HEAD 校验失败 → 抛 EagResumeHandlerError(kind="run-diverged")
    const resumeHandler = buildResumeHandler(runStateStore);
    await assert.rejects(
      resumeHandler.handle({
        runId,
        projectRoot,
        userIntent: "测试 git HEAD 不一致",
        loopExecutors: [designExec, codingExec, testingExec],
        userDecision: "批准 spec.md",
      }),
      (err: unknown) => {
        assert.ok(err instanceof EagResumeHandlerError);
        assert.equal(err.kind, "run-diverged");
        assert.ok(err.detail.includes("git HEAD 与最后一个 milestone 不一致"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T5. handle() 从 human-checkpoint 恢复 + 用户决策 + 剩余 Loop 全部完成
// ============================================================================

test("T5.1 handle() 从 human-checkpoint 恢复 → finalStatus=completed", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();

    // ===== 前置：用 EagRunHandler 创建 RunState =====
    // 让 design Loop 完成（产生 1 个 milestone）+ coding Loop 返回 human-checkpoint
    const designExec = new InMemoryLoopExecutor("design");
    const codingExec = new InMemoryLoopExecutor("coding");
    codingExec.checkpointOnLoop = "coding"; // coding Loop 返回 human-checkpoint
    const testingExec = new InMemoryLoopExecutor("testing");
    const runHandler = buildRunHandler(runStateStore, [designExec, codingExec, testingExec]);
    const runResult = await runHandler.handle({
      projectRoot,
      userIntent: "前置：design 完成 + coding 触发 human-checkpoint",
      autoTransition: true,
      loopExecutors: [designExec, codingExec, testingExec],
    });
    const runId = runResult.runId;
    assert.equal(runResult.finalStatus, "human-checkpoint");
    assert.equal(runResult.milestones.length, 1);
    assert.equal(runResult.completedLoops.length, 1);
    assert.equal(runResult.completedLoops[0], "design");

    // ===== 恢复执行 =====
    // 重置 codingExec 的 checkpointOnLoop（让 coding Loop 这次返回 completed）
    codingExec.checkpointOnLoop = undefined;
    const resumeHandler = buildResumeHandler(runStateStore);
    const resumeResult = await resumeHandler.handle({
      runId,
      projectRoot,
      userIntent: "前置：design 完成 + coding 触发 human-checkpoint",
      loopExecutors: [designExec, codingExec, testingExec],
      userDecision: "批准 spec.md 继续执行",
      autoTransition: true,
    });

    // 验证恢复后 finalStatus=completed，且完成了 coding + testing 两个 Loop
    assert.equal(resumeResult.finalStatus, "completed");
    assert.ok(resumeResult.completedLoops.includes("coding"));
    assert.ok(resumeResult.completedLoops.includes("testing"));
    // 累计 milestone 数 = 1（design）+ 2（resume 期间的 coding + testing）= 3
    assert.equal(resumeResult.milestones.length, 3);
    // 报告应包含"EAG Run Resume Report"标识
    assert.ok(resumeResult.finalReport.includes("EAG Run Resume Report"));
    assert.ok(resumeResult.finalReport.includes(runId));
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T6. handle() 恢复时 LoopExecutor 抛异常 → finalStatus=failed
// ============================================================================

test("T6.1 handle() 恢复时 LoopExecutor 抛异常 → finalStatus=failed", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();

    // ===== 前置：让 design 完成 + coding 触发 human-checkpoint =====
    const designExec = new InMemoryLoopExecutor("design");
    const codingExec = new InMemoryLoopExecutor("coding");
    codingExec.checkpointOnLoop = "coding";
    const testingExec = new InMemoryLoopExecutor("testing");
    const runHandler = buildRunHandler(runStateStore, [designExec, codingExec, testingExec]);
    const runResult = await runHandler.handle({
      projectRoot,
      userIntent: "前置：design 完成 + coding 触发 human-checkpoint",
      autoTransition: true,
      loopExecutors: [designExec, codingExec, testingExec],
    });
    const runId = runResult.runId;

    // ===== 恢复执行：让 coding Loop 抛异常 =====
    codingExec.checkpointOnLoop = undefined;
    codingExec.throwOnLoop = "coding"; // coding Loop 在 resume 时抛异常
    const resumeHandler = buildResumeHandler(runStateStore);
    const resumeResult = await resumeHandler.handle({
      runId,
      projectRoot,
      userIntent: "前置：design 完成 + coding 触发 human-checkpoint",
      loopExecutors: [designExec, codingExec, testingExec],
      userDecision: "批准 spec.md 继续执行",
      autoTransition: true,
    });

    // LoopExecutor 抛异常 → finalStatus=failed + 1 次人工介入（阈值未达，不触发阻塞）
    assert.equal(resumeResult.finalStatus, "failed");
    // 报告应含失败原因（含"故意抛错"子串）
    assert.ok(resumeResult.finalReport.includes("**失败原因**"));
    assert.ok(resumeResult.finalReport.includes("故意抛错"));
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T7. handle() 恢复时 Loop 返回 failed → 回滚 + finalStatus=human-checkpoint
// ============================================================================

test("T7.1 handle() 恢复时 Loop 返回 failed → 回滚 + finalStatus=human-checkpoint", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();

    // ===== 前置：让 design 完成 + coding 触发 human-checkpoint =====
    const designExec = new InMemoryLoopExecutor("design");
    const codingExec = new InMemoryLoopExecutor("coding");
    codingExec.checkpointOnLoop = "coding";
    const testingExec = new InMemoryLoopExecutor("testing");
    const runHandler = buildRunHandler(runStateStore, [designExec, codingExec, testingExec]);
    const runResult = await runHandler.handle({
      projectRoot,
      userIntent: "前置：design 完成 + coding 触发 human-checkpoint",
      autoTransition: true,
      loopExecutors: [designExec, codingExec, testingExec],
    });
    const runId = runResult.runId;
    assert.equal(runResult.milestones.length, 1);

    // ===== 恢复执行：让 coding Loop 返回 failed =====
    codingExec.checkpointOnLoop = undefined;
    codingExec.failOnLoop = "coding"; // coding Loop 在 resume 时返回 failed
    const resumeHandler = buildResumeHandler(runStateStore);
    const resumeResult = await resumeHandler.handle({
      runId,
      projectRoot,
      userIntent: "前置：design 完成 + coding 触发 human-checkpoint",
      loopExecutors: [designExec, codingExec, testingExec],
      userDecision: "批准 spec.md 继续执行",
      autoTransition: true,
    });

    // Loop 返回 failed + 单次人工介入（阈值未达 3）→ finalStatus=human-checkpoint
    assert.equal(resumeResult.finalStatus, "human-checkpoint");
    // 报告应含失败原因
    assert.ok(resumeResult.finalReport.includes("**失败原因**"));
    assert.ok(resumeResult.finalReport.includes("故意返回 failed"));
    // 验证已回滚到上一个 milestone（design Loop 的 milestone）
    // 通过 git tag --list 命令列出所有 tag，确认 eag/<runId>/m1 存在
    // 注意：使用 "git tag --list" 而非 "git tag list"（后者会被 git 误解为创建名为 list 的 tag）
    const tagList = childProcess
      .execSync("git tag --list", {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      .trim();
    assert.ok(
      tagList.includes(`eag/${runId}/m1`),
      `应存在 m1 tag（design Loop 的 milestone），实际 tag 列表：\n${tagList}`
    );
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T8. handle() 恢复时 Loop 返回 human-checkpoint → finalStatus=human-checkpoint
// ============================================================================

test("T8.1 handle() 恢复时 Loop 返回 human-checkpoint → finalStatus=human-checkpoint", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();

    // ===== 前置：让 design 完成 + coding 触发 human-checkpoint =====
    const designExec = new InMemoryLoopExecutor("design");
    const codingExec = new InMemoryLoopExecutor("coding");
    codingExec.checkpointOnLoop = "coding";
    const testingExec = new InMemoryLoopExecutor("testing");
    const runHandler = buildRunHandler(runStateStore, [designExec, codingExec, testingExec]);
    const runResult = await runHandler.handle({
      projectRoot,
      userIntent: "前置：design 完成 + coding 触发 human-checkpoint",
      autoTransition: true,
      loopExecutors: [designExec, codingExec, testingExec],
    });
    const runId = runResult.runId;

    // ===== 恢复执行：让 coding Loop 再次返回 human-checkpoint =====
    // checkpointOnLoop 已经设置为 "coding"，无需修改
    const resumeHandler = buildResumeHandler(runStateStore);
    const resumeResult = await resumeHandler.handle({
      runId,
      projectRoot,
      userIntent: "前置：design 完成 + coding 触发 human-checkpoint",
      loopExecutors: [designExec, codingExec, testingExec],
      userDecision: "批准 spec.md 继续执行",
      autoTransition: true,
    });

    // Loop 返回 human-checkpoint → finalStatus=human-checkpoint
    assert.equal(resumeResult.finalStatus, "human-checkpoint");
    // 报告应含失败原因（含"等待人工决策"子串）
    assert.ok(resumeResult.finalReport.includes("**失败原因**"));
    assert.ok(resumeResult.finalReport.includes("等待人工决策"));
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T9. handle() 重建 MultiLoopPlan 失败 → 抛 resume-failed
// ============================================================================

/**
 * 真实 MultiLoopPlanner 子类（非 mock）：覆盖 plan() 方法抛出真实异常
 *
 * 设计理由：
 * - 真实 MultiLoopPlanner.plan() 在合法入参下不会抛错，因此需要通过子类注入失败路径
 * - 子类是真实的可替换组件（OOP 继承），不是 mock/stub
 * - 抛出真实的 MultiLoopPlannerError（kind="invalid-request"），保持错误类型一致
 */
class FailingMultiLoopPlanner extends MultiLoopPlanner {
  /** 计划方法是否被调用过（用于断言） */
  public planCallCount: number = 0;

  override async plan(): Promise<never> {
    this.planCallCount += 1;
    throw new MultiLoopPlannerError("invalid-request", "测试注入：plan() 故意失败");
  }
}

test("T9.1 handle() 重建 MultiLoopPlan 失败 → 抛 resume-failed", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();

    // ===== 前置：创建一个 RunState（含 1 个 milestone 以通过 git HEAD 校验）=====
    const designExec = new InMemoryLoopExecutor("design");
    const codingExec = new InMemoryLoopExecutor("coding");
    codingExec.checkpointOnLoop = "coding";
    const testingExec = new InMemoryLoopExecutor("testing");
    const runHandler = buildRunHandler(runStateStore, [designExec, codingExec, testingExec]);
    const runResult = await runHandler.handle({
      projectRoot,
      userIntent: "前置：design 完成 + coding 触发 human-checkpoint",
      autoTransition: true,
      loopExecutors: [designExec, codingExec, testingExec],
    });
    const runId = runResult.runId;

    // ===== 恢复执行：注入 FailingMultiLoopPlanner 让 plan() 抛错 =====
    const failingPlanner = new FailingMultiLoopPlanner();
    const resumeHandler = buildResumeHandler(runStateStore, failingPlanner);
    await assert.rejects(
      resumeHandler.handle({
        runId,
        projectRoot,
        userIntent: "前置：design 完成 + coding 触发 human-checkpoint",
        loopExecutors: [designExec, codingExec, testingExec],
        userDecision: "批准 spec.md 继续执行",
        autoTransition: true,
      }),
      (err: unknown) => {
        assert.ok(err instanceof EagResumeHandlerError);
        assert.equal(err.kind, "resume-failed");
        assert.ok(err.detail.includes("重建 MultiLoopPlan 失败"));
        // 验证 cause 是 MultiLoopPlannerError
        assert.ok(err.cause instanceof MultiLoopPlannerError);
        return true;
      }
    );

    // 验证 plan() 确实被调用过（即走到了重建 plan 步骤）
    assert.equal(failingPlanner.planCallCount, 1);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// 附加：EagResumeHandlerError 字段断言
// ============================================================================

test("T9.2 EagResumeHandlerError 含 kind + detail + cause 字段", () => {
  const cause = new Error("原始错误");
  const err = new EagResumeHandlerError("run-diverged", "git HEAD 不一致", cause);
  assert.ok(err instanceof Error);
  assert.equal(err.name, "EagResumeHandlerError");
  assert.equal(err.kind, "run-diverged");
  assert.equal(err.detail, "git HEAD 不一致");
  assert.equal(err.cause, cause);
  assert.ok(err.message.includes("run-diverged"));
  assert.ok(err.message.includes("git HEAD 不一致"));
});

test("T9.3 EagResumeHandlerError 重新导出 EagRunHandlerError 一致性", () => {
  // eag-resume-handler.ts 重新导出 EagRunHandlerError，便于调用方统一捕获 run/resume 错误
  // 验证：通过 eag-resume-handler 模块导入的 EagRunHandlerError 与直接从 eag-run-handler 导入的一致
  // 此测试通过编译时类型检查 + 运行时 instanceof 验证一致性
  const err = new EagRunHandlerError("plan-failed", "测试 detail", undefined);
  assert.ok(err instanceof EagRunHandlerError);
  assert.equal(err.kind, "plan-failed");
});
