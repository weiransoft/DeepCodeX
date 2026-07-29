/**
 * loop-controller async 化测试（P0-1.2 验证）
 *
 * 设计文档 §7.7：5 个测试用例（LC-001~LC-005）
 *   - LC-001: run() 返回 Promise
 *   - LC-002: async StageHandler 兼容（注入 async handle()）
 *   - LC-003: sync StageHandler 兼容（注入 sync handle()）
 *   - LC-004: backoffSleep 不阻塞 event loop（setTimeout 回调能执行）
 *   - LC-005: runOneIterationPublic async
 *
 * 验证 v1.1 修正（§3.4）：
 *   - StageHandler.handle 返回类型从 StageResult 改为 StageResult | Promise<StageResult>
 *   - run() 从 sync 改为 async，返回 Promise<number>
 *   - runOneIteration 内部 await handler.handle()
 *   - backoffSleep 从 BusyWait 自旋改为 setTimeout Promise
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RalphLoopController, defaultLoopConfig, RunState } from "../autonomous/index.js";
import type { IterationContext, StageHandler, StageResult, StageKind } from "../autonomous/loop-controller.js";

/**
 * 创建临时目录用于 RunState 持久化
 * @returns 临时目录路径
 */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-lc-test-"));
}

/**
 * 删除临时目录
 * @param dir 临时目录路径
 */
function rmTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 静默忽略
  }
}

/**
 * 构造 stub GitDriver（实现 GitDriverLike 接口）
 * - commit 返回 success=true，让循环正常 commit
 * - rollback 返回 success=true，让循环正常 rollback
 */
function makeStubGitDriver() {
  return {
    commit: () => ({ success: true }),
    rollback: () => ({ success: true }),
  };
}

/**
 * 构造 stub StageHandler，返回固定的 StageResult
 *
 * @param result 固定返回的 StageResult
 */
function makeStubHandler(result: StageResult): StageHandler {
  return {
    handle(_ctx: IterationContext): StageResult {
      return result;
    },
  };
}

/**
 * 构造 4 个 stage 都返回相同 result 的 handlers
 */
function makeHandlers(result: StageResult): Record<StageKind, StageHandler> {
  return {
    plan: makeStubHandler(result),
    dev: makeStubHandler(result),
    verify: makeStubHandler(result),
    fix: makeStubHandler(result),
  };
}

// ============================================================================
// LC-001: run() 返回 Promise
// ============================================================================

test("LC-001: run() 返回 Promise", async () => {
  const dir = makeTmpDir();
  try {
    const runState = new RunState(dir, "r-lc-001", "测试");
    const config = defaultLoopConfig();

    const controller = new RalphLoopController({
      config: { ...config, maxIterations: 1 },
      projectRoot: dir,
      gitDriver: makeStubGitDriver(),
      notesMemory: null,
      runState,
      stageHandlers: makeHandlers({
        kind: "success",
        summary: "ok",
        artifacts: { tokens: 0 },
      }),
      log: () => {},
      sleepGuard: null,
    });

    // 不使用 successHandler，直接用 makeHandlers 返回的 handlers
    const runPromise = controller.run();

    // 断言：run() 返回 Promise
    assert.ok(runPromise instanceof Promise, "run() 应返回 Promise");

    await runPromise;
  } finally {
    rmTmpDir(dir);
  }
});

// ============================================================================
// LC-002: async StageHandler 兼容
// ============================================================================

test("LC-002: async StageHandler 兼容", async () => {
  const dir = makeTmpDir();
  try {
    const runState = new RunState(dir, "r-lc-002", "测试");
    const config = defaultLoopConfig();

    // 构造 async StageHandler（handle 返回 Promise<StageResult>）
    const asyncHandler: StageHandler = {
      async handle(_ctx: IterationContext): Promise<StageResult> {
        // 模拟异步操作（如调用 LLM）
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        return {
          kind: "success",
          summary: "async success",
          artifacts: { tokens: 10 },
        };
      },
    };

    const controller = new RalphLoopController({
      config: { ...config, maxIterations: 1 },
      projectRoot: dir,
      gitDriver: makeStubGitDriver(),
      notesMemory: null,
      runState,
      stageHandlers: {
        plan: asyncHandler,
        dev: asyncHandler,
        verify: asyncHandler,
        fix: asyncHandler,
      },
      log: () => {},
      sleepGuard: null,
    });

    // 执行 run()，不抛错即通过（证明 async StageHandler 兼容）
    const exitCode = await controller.run();
    // exitCode 应为 0（success）或 3（stop_when）
    assert.ok(exitCode === 0 || exitCode === 3, `exitCode 应为 0 或 3，实际: ${exitCode}`);
  } finally {
    rmTmpDir(dir);
  }
});

// ============================================================================
// LC-003: sync StageHandler 兼容
// ============================================================================

test("LC-003: sync StageHandler 兼容", async () => {
  const dir = makeTmpDir();
  try {
    const runState = new RunState(dir, "r-lc-003", "测试");
    const config = defaultLoopConfig();

    // 构造 sync StageHandler（handle 返回 StageResult，非 Promise）
    const syncHandler: StageHandler = {
      handle(_ctx: IterationContext): StageResult {
        return {
          kind: "success",
          summary: "sync success",
          artifacts: { tokens: 5 },
        };
      },
    };

    const controller = new RalphLoopController({
      config: { ...config, maxIterations: 1 },
      projectRoot: dir,
      gitDriver: makeStubGitDriver(),
      notesMemory: null,
      runState,
      stageHandlers: {
        plan: syncHandler,
        dev: syncHandler,
        verify: syncHandler,
        fix: syncHandler,
      },
      log: () => {},
      sleepGuard: null,
    });

    // 执行 run()，不抛错即通过（证明 sync StageHandler 仍兼容，await 非 Promise 值直接返回）
    const exitCode = await controller.run();
    // exitCode 应为 0（success）或 3（stop_when）
    assert.ok(exitCode === 0 || exitCode === 3, `exitCode 应为 0 或 3，实际: ${exitCode}`);
  } finally {
    rmTmpDir(dir);
  }
});

// ============================================================================
// LC-004: backoffSleep 不阻塞 event loop
// ============================================================================

test("LC-004: backoffSleep 不阻塞 event loop（setTimeout 回调能执行）", async () => {
  const dir = makeTmpDir();
  try {
    const runState = new RunState(dir, "r-lc-004", "测试");
    const config = defaultLoopConfig();

    // 构造 retriable StageHandler，让循环触发 backoffSleep
    const retriableHandler: StageHandler = {
      handle(_ctx: IterationContext): StageResult {
        return {
          kind: "retriable",
          summary: "test retriable",
          artifacts: { tokens: 0 },
          error: "test error",
        };
      },
    };

    // 设置 maxIterations=2 + consecutiveFailureAbort=2 + backoffBaseSec=0.2 + backoffMaxSec=0.2
    // 第 1 次迭代：retriable → backoffSleep(0.2s)
    //   注意：backoffSleep 内部有 `if (sleepSec > 0.1)` 阈值，base 必须 > 0.1 才会实际 sleep
    // 第 2 次迭代：retriable → consecutiveFailures=2 → abort
    const controller = new RalphLoopController({
      config: {
        ...config,
        maxIterations: 2,
        consecutiveFailureAbort: 2,
        backoffBaseSec: 0.2,
        backoffMaxSec: 0.2,
      },
      projectRoot: dir,
      gitDriver: makeStubGitDriver(),
      notesMemory: null,
      runState,
      stageHandlers: {
        plan: retriableHandler,
        dev: retriableHandler,
        verify: retriableHandler,
        fix: retriableHandler,
      },
      log: () => {},
      sleepGuard: null,
    });

    // 启动 setTimeout（10ms 后设置 flag = true）
    // 如果 backoffSleep 阻塞 event loop，setTimeout 回调不会在 backoffSleep 期间执行
    // 如果 backoffSleep 用 setTimeout Promise，event loop 可以执行其他回调
    let setTimeoutFired = false;
    const setTimeoutHandle = setTimeout(() => {
      setTimeoutFired = true;
    }, 10);

    try {
      await controller.run();
    } finally {
      clearTimeout(setTimeoutHandle);
    }

    // 断言：setTimeout 回调已执行（证明 backoffSleep 期间 event loop 没被阻塞）
    // 注意：backoffSleep(0.05s) = 50ms，setTimeout(10ms) 应该在 backoffSleep 期间触发
    assert.ok(setTimeoutFired, "backoffSleep 期间 setTimeout 回调应能执行（证明不阻塞 event loop）");
  } finally {
    rmTmpDir(dir);
  }
});

// ============================================================================
// LC-006: backoffSleep 响应外部 abort（FIX-14，多角色审查 2026-07-29）
//
// 场景：某阶段返回 retriable 后进入 backoffSleep（base=5s）。
// 在退避期间从外部调用 runState.markAborted()，验证 backoffSleep 立即退出，
// 而不是等待完整的 5s。若 FIX-14 未生效，本测试将耗时 ~5s 并断言失败。
// ============================================================================

test("LC-006: backoffSleep 在 RunState 被 abort 时立即退出", async () => {
  const dir = makeTmpDir();
  try {
    const runState = new RunState(dir, "r-lc-006", "测试");
    const config = defaultLoopConfig();

    // 构造 retriable StageHandler，让循环触发 backoffSleep
    const retriableHandler: StageHandler = {
      handle(_ctx: IterationContext): StageResult {
        return {
          kind: "retriable",
          summary: "test retriable",
          artifacts: { tokens: 0 },
          error: "test error",
        };
      },
    };

    const controller = new RalphLoopController({
      config: {
        ...config,
        maxIterations: 2,
        consecutiveFailureAbort: 2,
        // 退避时间设长，若 FIX-14 未生效，测试会明显超时
        backoffBaseSec: 5.0,
        backoffMaxSec: 5.0,
      },
      projectRoot: dir,
      gitDriver: makeStubGitDriver(),
      notesMemory: null,
      runState,
      stageHandlers: {
        plan: retriableHandler,
        dev: retriableHandler,
        verify: retriableHandler,
        fix: retriableHandler,
      },
      log: () => {},
      sleepGuard: null,
    });

    const runPromise = controller.run();

    // 等待第一次迭代完成并进入 backoffSleep（stub handler 是同步的，100ms 足够）
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // 从外部触发 abort
    runState.markAborted("external abort");

    const abortAt = Date.now();
    await runPromise;
    const elapsedAfterAbort = Date.now() - abortAt;

    // 响应 abort 后应在 1.5s 内完成（正常 5s 退避的 1s 分片检查机制）
    assert.ok(elapsedAfterAbort < 1500, `backoffSleep 应在 abort 后立即退出，实际 abort 后耗时 ${elapsedAfterAbort}ms`);
    assert.equal(runState.state.status, "aborted", "RunState 状态应为 aborted");
  } finally {
    rmTmpDir(dir);
  }
});

// ============================================================================
// LC-005: runOneIterationPublic async
// ============================================================================

test("LC-005: runOneIterationPublic async（返回 Promise）", async () => {
  const dir = makeTmpDir();
  try {
    const runState = new RunState(dir, "r-lc-005", "测试");
    const config = defaultLoopConfig();

    const controller = new RalphLoopController({
      config: { ...config, maxIterations: 1 },
      projectRoot: dir,
      gitDriver: makeStubGitDriver(),
      notesMemory: null,
      runState,
      stageHandlers: makeHandlers({
        kind: "success",
        summary: "ok",
        artifacts: { tokens: 0 },
      }),
      log: () => {},
      sleepGuard: null,
    });

    // 调用 runOneIterationPublic
    const iterPromise = controller.runOneIterationPublic(1);

    // 断言：返回 Promise
    assert.ok(iterPromise instanceof Promise, "runOneIterationPublic 应返回 Promise");

    const result = await iterPromise;
    // 断言：返回 IterationResult（含 kind/summary/agentOutput 等字段）
    assert.ok(typeof result === "object" && result !== null, "result 应为对象");
    assert.ok("kind" in result, "result 应含 kind 字段");
    assert.ok("summary" in result, "result 应含 summary 字段");
  } finally {
    rmTmpDir(dir);
  }
});
