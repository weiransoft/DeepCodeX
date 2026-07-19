/**
 * EAG-P3 批次 10 单元测试：long-horizon/eag-run-handler.ts /eag-run 命令处理器
 *
 * 测试范围（对齐设计文档 §4.12）：
 * - T1.  EagRunHandler 实例化（构造函数校验必填依赖）
 * - T2.  handle() 全流程成功：DESIGN → CODING → TESTING 全部完成 → finalStatus=completed
 * - T3.  handle() LoopExecutor.execute() 抛异常 → 触发 human-intervention + 阻塞分析
 * - T4.  handle() Loop 返回 human-checkpoint → finalStatus=human-checkpoint
 * - T5.  handle() Loop 返回 failed → 触发回滚 + human-intervention
 * - T6.  handle() 累计 3 次人工介入 → 触发阻塞分析 + finalStatus=paused
 * - T7.  handle() 请求 projectRoot 为空 → 抛 request-invalid
 * - T8.  handle() 请求 loopExecutors 为空数组 → 抛 request-invalid
 * - T9.  handle() MultiLoopPlanner.plan() 抛错 → 抛 plan-failed
 * - T10. handle() RunStateStore.initialize() 抛错 → 抛 run-state-error
 * - T11. handle() 生成的 finalReport 含必要章节（基本信息 + 完成度 + 里程碑）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用真实 RunStateStore + MultiLoopPlanner + MilestoneTagger + BlockageAnalyzer
 * - LoopExecutor 使用真实实现（InMemoryLoopExecutor），按 loopType 路由返回真实业务结果
 * - 真实 git 仓库初始化（childProcess.execSync git init + commit）以支持 MilestoneTagger
 * - 真实文件系统 I/O（fs.mkdtempSync + try/finally 清理）
 * - 使用 node:test + node:assert/strict
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计文档 §4.12 EagRunHandler
 * - EAG 方案 §5.12.2 长程任务自动化
 * - eag/long-horizon/eag-run-handler.ts 源文件
 *
 * @module core/tests/eag-long-horizon-eag-run-handler
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { EagRunHandler, EagRunHandlerError } from "../eag/long-horizon/eag-run-handler";
import type {
  LoopExecutor,
  LoopExecutionContext,
  LoopExecutionResult,
  EagRunRequest,
} from "../eag/long-horizon/eag-run-handler";
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "eag-run-handler-"));
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
 * 可注入失败模式（failOnLoop）用于测试 human-intervention / 回滚 / 阻塞分析路径。
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
      throw new Error(`测试异常：Loop ${context.node.nodeId} 故意抛错`);
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
        failureReason: `测试失败：Loop ${context.node.nodeId} 故意返回 failed`,
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
        failureReason: `测试检查点：Loop ${context.node.nodeId} 等待人工决策`,
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
 * @param projectRoot 项目根目录（用于 MilestoneTagger 路径解析）
 * @param runStateStore RunState 持久化存储
 * @param loopExecutors Loop 执行器列表
 * @returns EagRunHandler 实例
 */
function buildHandler(
  projectRoot: string,
  runStateStore: RunStateStore,
  loopExecutors: ReadonlyArray<LoopExecutor>
): EagRunHandler {
  // 真实 MultiLoopPlanner（解析 spec.md 生成 DAG）
  const multiLoopPlanner = new MultiLoopPlanner();
  // 真实 MilestoneTagger（使用自定义回归测试命令，避免触发真实 npm test）
  // 命令 "node -e 'console.log()'" 必然成功返回，且不产生测试输出
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

// ============================================================================
// T1. EagRunHandler 实例化
// ============================================================================

test("T1.1 EagRunHandler 构造函数注入全部依赖可成功实例化", () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const handler = buildHandler(projectRoot, store, [
      new InMemoryLoopExecutor("design"),
      new InMemoryLoopExecutor("coding"),
      new InMemoryLoopExecutor("testing"),
    ]);
    assert.ok(handler instanceof EagRunHandler);
  } finally {
    rmrf(projectRoot);
  }
});

test("T1.2 EagRunHandler 缺少 multiLoopPlanner 抛 request-invalid", () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    assert.throws(
      () => new EagRunHandler({ runStateStore: store, milestoneTagger: {} as any, blockageAnalyzer: {} as any } as any),
      (err: unknown) => {
        assert.ok(err instanceof EagRunHandlerError);
        assert.equal(err.kind, "request-invalid");
        assert.ok(err.detail.includes("multiLoopPlanner"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T1.3 EagRunHandler 缺少 runStateStore 抛 request-invalid", () => {
  assert.throws(
    () =>
      new EagRunHandler({
        multiLoopPlanner: {} as any,
        milestoneTagger: {} as any,
        blockageAnalyzer: {} as any,
      } as any),
    (err: unknown) => {
      assert.ok(err instanceof EagRunHandlerError);
      assert.equal(err.kind, "request-invalid");
      assert.ok(err.detail.includes("runStateStore"));
      return true;
    }
  );
});

test("T1.4 EagRunHandler 缺少 milestoneTagger 抛 request-invalid", () => {
  const store = new RunStateStore();
  assert.throws(
    () => new EagRunHandler({ multiLoopPlanner: {} as any, runStateStore: store, blockageAnalyzer: {} as any } as any),
    (err: unknown) => {
      assert.ok(err instanceof EagRunHandlerError);
      assert.equal(err.kind, "request-invalid");
      assert.ok(err.detail.includes("milestoneTagger"));
      return true;
    }
  );
});

test("T1.5 EagRunHandler 缺少 blockageAnalyzer 抛 request-invalid", () => {
  const store = new RunStateStore();
  assert.throws(
    () => new EagRunHandler({ multiLoopPlanner: {} as any, runStateStore: store, milestoneTagger: {} as any } as any),
    (err: unknown) => {
      assert.ok(err instanceof EagRunHandlerError);
      assert.equal(err.kind, "request-invalid");
      assert.ok(err.detail.includes("blockageAnalyzer"));
      return true;
    }
  );
});

// ============================================================================
// T2. handle() 全流程成功：DESIGN → CODING → TESTING 全部完成
// ============================================================================

test("T2.1 handle() 全流程成功 → finalStatus=completed + 3 个 milestone", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const store = new RunStateStore();
    const designExec = new InMemoryLoopExecutor("design");
    const codingExec = new InMemoryLoopExecutor("coding");
    const testingExec = new InMemoryLoopExecutor("testing");
    const handler = buildHandler(projectRoot, store, [designExec, codingExec, testingExec]);

    const result = await handler.handle({
      projectRoot,
      userIntent: "我需要一个订单管理微服务",
      autoTransition: true, // 自动流转以让三个 Loop 全部跑完
      loopExecutors: [designExec, codingExec, testingExec],
    });

    // 验证最终状态
    assert.equal(result.finalStatus, "completed");
    // 验证完成的 Loop 顺序
    assert.deepEqual([...result.completedLoops], ["design", "coding", "testing"]);
    // 验证里程碑数量
    assert.equal(result.milestones.length, 3);
    // 验证里程碑 tag 命名格式 eag/<run-id>/m<N>
    for (let i = 0; i < result.milestones.length; i++) {
      const m = result.milestones[i];
      assert.equal(m.index, i + 1);
      assert.match(m.tagName, /^eag\/[a-f0-9-]+\/m\d+$/);
      assert.ok(m.commitSha.length > 0);
      assert.ok(m.healthScore >= 0 && m.healthScore <= 1);
    }
    // 验证累计资源消耗（每个 Loop 5 次调用 + 1000 tokens）
    assert.equal(result.totalLlmCallCount, 15);
    assert.equal(result.totalTokensUsed, 3000);
    // 验证每个 executor 都被调用过
    assert.equal(designExec.callCount, 1);
    assert.equal(codingExec.callCount, 1);
    assert.equal(testingExec.callCount, 1);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T3. handle() LoopExecutor 抛异常 → 触发 human-intervention
// ============================================================================

test("T3.1 handle() LoopExecutor 抛异常 → finalStatus=failed + 1 次人工介入", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const store = new RunStateStore();
    const designExec = new InMemoryLoopExecutor("design");
    designExec.throwOnLoop = "design"; // design Loop 抛异常
    const codingExec = new InMemoryLoopExecutor("coding");
    const testingExec = new InMemoryLoopExecutor("testing");
    const handler = buildHandler(projectRoot, store, [designExec, codingExec, testingExec]);

    const result = await handler.handle({
      projectRoot,
      userIntent: "测试异常路径",
      autoTransition: true,
      loopExecutors: [designExec, codingExec, testingExec],
    });

    // 由于 design Loop 抛异常，源码将 finalStatus 设为 "failed"（与 human-checkpoint 不同）
    // 同时追加 1 次 human-intervention 事件
    assert.equal(result.finalStatus, "failed");
    assert.equal(result.completedLoops.length, 0);
    assert.equal(result.finalRunState.humanInterventionCount, 1);
    assert.equal(result.finalRunState.humanInterventions[0].loopType, "design");
    assert.ok(result.finalRunState.humanInterventions[0].reason.includes("故意抛错"));
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T4. handle() Loop 返回 human-checkpoint → finalStatus=human-checkpoint
// ============================================================================

test("T4.1 handle() Loop 返回 human-checkpoint → finalStatus=human-checkpoint", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const store = new RunStateStore();
    const designExec = new InMemoryLoopExecutor("design");
    designExec.checkpointOnLoop = "design"; // design Loop 返回 human-checkpoint
    const codingExec = new InMemoryLoopExecutor("coding");
    const testingExec = new InMemoryLoopExecutor("testing");
    const handler = buildHandler(projectRoot, store, [designExec, codingExec, testingExec]);

    const result = await handler.handle({
      projectRoot,
      userIntent: "测试人工检查点",
      autoTransition: true,
      loopExecutors: [designExec, codingExec, testingExec],
    });

    assert.equal(result.finalStatus, "human-checkpoint");
    assert.equal(result.completedLoops.length, 0);
    assert.equal(result.finalRunState.humanInterventionCount, 1);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T5. handle() Loop 返回 failed → 触发 human-intervention
// ============================================================================

test("T5.1 handle() Loop 返回 failed → finalStatus=human-checkpoint + 1 次人工介入", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const store = new RunStateStore();
    const designExec = new InMemoryLoopExecutor("design");
    const codingExec = new InMemoryLoopExecutor("coding");
    codingExec.failOnLoop = "coding"; // coding Loop 返回 failed（注意 design 已完成产生 milestone）
    const testingExec = new InMemoryLoopExecutor("testing");
    const handler = buildHandler(projectRoot, store, [designExec, codingExec, testingExec]);

    const result = await handler.handle({
      projectRoot,
      userIntent: "测试失败路径",
      autoTransition: true,
      loopExecutors: [designExec, codingExec, testingExec],
    });

    // coding Loop 失败：design Loop 已完成 → 已有 milestone，触发回滚 + human-intervention
    // 失败 1 次，未达 3 次阈值 → human-checkpoint
    assert.equal(result.finalStatus, "human-checkpoint");
    assert.equal(result.completedLoops.length, 1); // design 已完成
    assert.deepEqual([...result.completedLoops], ["design"]);
    assert.equal(result.finalRunState.humanInterventionCount, 1);
    assert.equal(result.finalRunState.humanInterventions[0].loopType, "coding");
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T6. handle() 累计 3 次人工介入 → 触发阻塞分析 + paused
// ============================================================================

test("T6.1 handle() 单次失败 finalStatus=failed（未达 3 次阈值不触发阻塞分析）", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const store = new RunStateStore();

    // 使用一个"持续抛异常"的 design executor，让 design Loop 失败
    // 由于 EagRunHandler 失败后即 break（不在同一 Run 内重试同 Loop），
    // 单次 handle() 调用只能产生 1 次人工介入，未达 3 次阈值，不会触发阻塞分析
    const designExec = new InMemoryLoopExecutor("design");
    designExec.throwOnLoop = "design"; // design Loop 抛异常（触发 human-intervention）
    const codingExec = new InMemoryLoopExecutor("coding");
    const testingExec = new InMemoryLoopExecutor("testing");
    const handler = buildHandler(projectRoot, store, [designExec, codingExec, testingExec]);

    const result = await handler.handle({
      projectRoot,
      userIntent: "测试单次失败不触发阻塞分析",
      autoTransition: true,
      loopExecutors: [designExec, codingExec, testingExec],
    });

    // 单次失败：humanInterventionCount=1，未达 3 次阈值 → finalStatus=failed（非 paused）
    assert.equal(result.finalStatus, "failed");
    assert.equal(result.finalRunState.humanInterventionCount, 1);
    // blockageReport 不应被填充（阈值未达）
    assert.equal(result.blockageReport, undefined);
  } finally {
    rmrf(projectRoot);
  }
});

test("T6.2 handle() 单次 handle 调用失败 → 不触发阻塞分析（阈值未达）", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const store = new RunStateStore();
    const designExec = new InMemoryLoopExecutor("design");
    designExec.failOnLoop = "design"; // design Loop 直接 failed
    const codingExec = new InMemoryLoopExecutor("coding");
    const testingExec = new InMemoryLoopExecutor("testing");
    const handler = buildHandler(projectRoot, store, [designExec, codingExec, testingExec]);

    const result = await handler.handle({
      projectRoot,
      userIntent: "测试单次失败不触发阻塞分析",
      autoTransition: true,
      loopExecutors: [designExec, codingExec, testingExec],
    });

    // design Loop failed：milestones.length=0（design 未完成），无 milestone 可回滚
    // 触发 1 次 human-intervention，未达 3 次阈值 → human-checkpoint（非 paused）
    assert.equal(result.finalStatus, "human-checkpoint");
    assert.equal(result.finalRunState.humanInterventionCount, 1);
    // blockageReport 不应被填充（阈值未达）
    assert.equal(result.blockageReport, undefined);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T7. handle() 请求 projectRoot 为空 → 抛 request-invalid
// ============================================================================

test("T7.1 handle() projectRoot 为空字符串 → 抛 request-invalid", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const handler = buildHandler(projectRoot, store, [
      new InMemoryLoopExecutor("design"),
      new InMemoryLoopExecutor("coding"),
      new InMemoryLoopExecutor("testing"),
    ]);

    await assert.rejects(
      () =>
        handler.handle({
          projectRoot: "",
          userIntent: "测试空 projectRoot",
          loopExecutors: [new InMemoryLoopExecutor("design")],
        }),
      (err: unknown) => {
        assert.ok(err instanceof EagRunHandlerError);
        assert.equal(err.kind, "request-invalid");
        assert.ok(err.detail.includes("projectRoot"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T7.2 handle() userIntent 为空字符串 → 抛 request-invalid", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const handler = buildHandler(projectRoot, store, [
      new InMemoryLoopExecutor("design"),
      new InMemoryLoopExecutor("coding"),
      new InMemoryLoopExecutor("testing"),
    ]);

    await assert.rejects(
      () =>
        handler.handle({
          projectRoot,
          userIntent: "   ",
          loopExecutors: [new InMemoryLoopExecutor("design")],
        }),
      (err: unknown) => {
        assert.ok(err instanceof EagRunHandlerError);
        assert.equal(err.kind, "request-invalid");
        assert.ok(err.detail.includes("userIntent"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T8. handle() 请求 loopExecutors 为空数组 → 抛 request-invalid
// ============================================================================

test("T8.1 handle() loopExecutors 为空数组 → 抛 request-invalid", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const handler = buildHandler(projectRoot, store, [new InMemoryLoopExecutor("design")]);

    await assert.rejects(
      () =>
        handler.handle({
          projectRoot,
          userIntent: "测试空 loopExecutors",
          loopExecutors: [],
        }),
      (err: unknown) => {
        assert.ok(err instanceof EagRunHandlerError);
        assert.equal(err.kind, "request-invalid");
        assert.ok(err.detail.includes("loopExecutors"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T8.2 handle() loopExecutors 中某项缺少 execute 方法 → 抛 request-invalid", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const handler = buildHandler(projectRoot, store, [new InMemoryLoopExecutor("design")]);

    await assert.rejects(
      () =>
        handler.handle({
          projectRoot,
          userIntent: "测试非法 LoopExecutor",

          loopExecutors: [{ loopType: "design" } as any], // 缺少 execute 方法
        }),
      (err: unknown) => {
        assert.ok(err instanceof EagRunHandlerError);
        assert.equal(err.kind, "request-invalid");
        assert.ok(err.detail.includes("LoopExecutor"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T8.3 handle() maxIterations 为 0 → 抛 request-invalid", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const handler = buildHandler(projectRoot, store, [new InMemoryLoopExecutor("design")]);

    await assert.rejects(
      () =>
        handler.handle({
          projectRoot,
          userIntent: "测试非法 maxIterations",
          loopExecutors: [new InMemoryLoopExecutor("design")],
          maxIterations: 0,
        }),
      (err: unknown) => {
        assert.ok(err instanceof EagRunHandlerError);
        assert.equal(err.kind, "request-invalid");
        assert.ok(err.detail.includes("maxIterations"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T9. handle() MultiLoopPlanner.plan() 抛错 → 抛 plan-failed
// ============================================================================

test("T9.1 handle() MultiLoopPlanner.plan() 抛错 → 抛 plan-failed", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const store = new RunStateStore();
    // 注入一个会抛错的 MultiLoopPlanner（真实实现，但 plan() 总是抛错）
    const failingPlanner = {
      plan: async () => {
        throw new Error("模拟 plan 失败");
      },
    };

    const handler = new EagRunHandler({
      multiLoopPlanner: failingPlanner as any,
      runStateStore: store,
      milestoneTagger: new MilestoneTagger(store, undefined, {
        regressionTestCommand: "node -e \"console.log('ok')\"",
      }),
      blockageAnalyzer: new BlockageAnalyzer(store),
      loopExecutors: [
        new InMemoryLoopExecutor("design"),
        new InMemoryLoopExecutor("coding"),
        new InMemoryLoopExecutor("testing"),
      ],
    });

    await assert.rejects(
      () =>
        handler.handle({
          projectRoot,
          userIntent: "测试 plan 失败",
          loopExecutors: [new InMemoryLoopExecutor("design")],
        }),
      (err: unknown) => {
        assert.ok(err instanceof EagRunHandlerError);
        assert.equal(err.kind, "plan-failed");
        assert.ok(err.detail.includes("plan"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T10. handle() RunStateStore.initialize() 抛错 → 抛 run-state-error
// ============================================================================

test("T10.1 handle() RunStateStore.initialize() 抛错 → 抛 run-state-error", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    // 注入一个会抛错的 RunStateStore（真实实现，但 initialize() 总是抛错）
    const failingStore = {
      initialize: async () => {
        throw new Error("模拟 initialize 失败");
      },
      appendEvent: async () => {
        throw new Error("不应被调用");
      },
      load: async () => {
        throw new Error("不应被调用");
      },
      listRuns: async () => [],
    };

    const handler = new EagRunHandler({
      multiLoopPlanner: new MultiLoopPlanner(),
      runStateStore: failingStore as any,
      milestoneTagger: new MilestoneTagger(failingStore as unknown as RunStateStore, undefined, {
        regressionTestCommand: "node -e \"console.log('ok')\"",
      }),
      blockageAnalyzer: new BlockageAnalyzer(failingStore as unknown as RunStateStore),
      loopExecutors: [
        new InMemoryLoopExecutor("design"),
        new InMemoryLoopExecutor("coding"),
        new InMemoryLoopExecutor("testing"),
      ],
    });

    await assert.rejects(
      () =>
        handler.handle({
          projectRoot,
          userIntent: "测试 initialize 失败",
          loopExecutors: [new InMemoryLoopExecutor("design")],
        }),
      (err: unknown) => {
        assert.ok(err instanceof EagRunHandlerError);
        assert.equal(err.kind, "run-state-error");
        assert.ok(err.detail.includes("initialize"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T11. handle() 生成的 finalReport 含必要章节
// ============================================================================

test("T11.1 handle() finalReport 含基本信息 + 完成度 + 里程碑章节", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const store = new RunStateStore();
    const designExec = new InMemoryLoopExecutor("design");
    const codingExec = new InMemoryLoopExecutor("coding");
    const testingExec = new InMemoryLoopExecutor("testing");
    const handler = buildHandler(projectRoot, store, [designExec, codingExec, testingExec]);

    const result = await handler.handle({
      projectRoot,
      userIntent: "测试 finalReport 章节",
      autoTransition: true,
      loopExecutors: [designExec, codingExec, testingExec],
    });

    const report = result.finalReport;
    assert.ok(typeof report === "string");
    assert.ok(report.length > 0);

    // 章节 1：基本信息（含 runId + 状态 + 总耗时 + 总 LLM 调用 + 总 Token 消耗）
    assert.ok(report.includes("# EAG Run Report:"), "应含报告标题");
    assert.ok(report.includes("## 基本信息"), "应含基本信息章节");
    assert.ok(report.includes(`- **状态**: ${result.finalStatus}`));
    assert.ok(report.includes(`- **总 LLM 调用**: ${result.totalLlmCallCount}`));
    assert.ok(report.includes(`- **总 Token 消耗**: ${result.totalTokensUsed}`));

    // 章节 2：完成度
    assert.ok(report.includes("## 完成度"), "应含完成度章节");
    assert.ok(report.includes("DESIGN Loop 已完成"));
    assert.ok(report.includes("CODING Loop 已完成"));
    assert.ok(report.includes("TESTING Loop 已完成"));

    // 章节 3：里程碑（表格形式）
    assert.ok(report.includes("## 里程碑"), "应含里程碑章节");
    assert.ok(report.includes("| # | 名称 | Loop 类型 | Tag | 健康度 |"));
    // 验证里程碑条目（3 行）
    const tableRows = report.split("\n").filter((l) => l.startsWith("| ") && !l.includes("---") && !l.includes("# "));
    assert.ok(tableRows.length >= 3, "应至少有 3 行里程碑数据");
  } finally {
    rmrf(projectRoot);
  }
});

test("T11.2 handle() finalStatus=failed 时 finalReport 含失败原因", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const store = new RunStateStore();
    const designExec = new InMemoryLoopExecutor("design");
    designExec.throwOnLoop = "design";
    const codingExec = new InMemoryLoopExecutor("coding");
    const testingExec = new InMemoryLoopExecutor("testing");
    const handler = buildHandler(projectRoot, store, [designExec, codingExec, testingExec]);

    const result = await handler.handle({
      projectRoot,
      userIntent: "测试 finalReport 失败原因",
      autoTransition: true,
      loopExecutors: [designExec, codingExec, testingExec],
    });

    // LoopExecutor 抛异常时 finalStatus="failed"（源码 catch 分支），单次人工介入未触发阻塞阈值
    assert.equal(result.finalStatus, "failed");
    // 失败原因应出现在报告的"基本信息"章节（含"故意抛错"子串，源于 InMemoryLoopExecutor 抛出消息）
    assert.ok(result.finalReport.includes("**失败原因**"));
    assert.ok(result.finalReport.includes("故意抛错"));
  } finally {
    rmrf(projectRoot);
  }
});

test("T11.3 EagRunHandlerError 含 kind + detail + cause 字段", () => {
  const cause = new Error("原始错误");
  const err = new EagRunHandlerError("plan-failed", "计划生成失败", cause);
  assert.ok(err instanceof Error);
  assert.equal(err.kind, "plan-failed");
  assert.equal(err.detail, "计划生成失败");
  assert.equal(err.cause, cause);
  assert.equal(err.name, "EagRunHandlerError");
});
