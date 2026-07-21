/**
 * RunState RunStateLike 接口实现测试（P0-1.1 验证）
 *
 * 设计文档 §7.6：10 个测试用例（RS-001~RS-010）
 *   - RS-001~RS-005: state getter + 4 个 mark 方法
 *   - RS-006~RS-009: recordIteration 4 个字段更新
 *   - RS-010: RunState 可注入 RalphLoopController（类型兼容性）
 *
 * 验证 v1.1 修正（M-07 / F-04）：
 *   - state 字段重命名为 stateValue（避免与 state getter 冲突）
 *   - 新增 state getter + 5 个方法（markRunning/markComplete/markFailed/markAborted/recordIteration）
 *   - RunState 实现 RunStateLike 接口，可传入 RalphLoopController 构造函数
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunState, RalphLoopController, defaultLoopConfig } from "../autonomous/index.js";
import type { IterationContext, StageHandler, StageResult } from "../autonomous/loop-controller.js";

/**
 * 创建临时目录用于 RunState 持久化
 * @returns 临时目录路径
 */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-rs-test-"));
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

// ============================================================================
// RS-001~RS-005: state getter + 4 个 mark 方法
// ============================================================================

test("RS-001: state getter 返回正确字段", () => {
  const dir = makeTmpDir();
  try {
    const rs = new RunState(dir, "r-001", "实现登录");
    // 断言：state getter 返回的字段与构造参数一致
    assert.equal(rs.state.runId, "r-001");
    assert.equal(rs.state.objective, "实现登录");
    // 默认值校验
    assert.equal(rs.state.iterIndex, 0);
    assert.equal(rs.state.consecutiveFailures, 0);
    assert.equal(rs.state.cumulativeTokens, 0);
    assert.equal(rs.state.commitsMade, 0);
  } finally {
    rmTmpDir(dir);
  }
});

test("RS-002: markRunning 修改 status", () => {
  const dir = makeTmpDir();
  try {
    const rs = new RunState(dir, "r-002", "测试");
    rs.markRunning();
    assert.equal(rs.state.status, "running");
  } finally {
    rmTmpDir(dir);
  }
});

test("RS-003: markComplete 修改 status", () => {
  const dir = makeTmpDir();
  try {
    const rs = new RunState(dir, "r-003", "测试");
    rs.markComplete();
    assert.equal(rs.state.status, "completed");
  } finally {
    rmTmpDir(dir);
  }
});

test("RS-004: markFailed 记录原因", () => {
  const dir = makeTmpDir();
  try {
    const rs = new RunState(dir, "r-004", "测试");
    rs.markFailed("测试失败原因");
    assert.equal(rs.state.status, "failed");
    assert.equal(rs.state.lastError, "测试失败原因");
  } finally {
    rmTmpDir(dir);
  }
});

test("RS-005: markAborted 记录原因", () => {
  const dir = makeTmpDir();
  try {
    const rs = new RunState(dir, "r-005", "测试");
    rs.markAborted("中止原因");
    assert.equal(rs.state.status, "aborted");
    assert.equal(rs.state.lastError, "中止原因");
  } finally {
    rmTmpDir(dir);
  }
});

// ============================================================================
// RS-006~RS-009: recordIteration 4 个字段更新
// ============================================================================

test("RS-006: recordIteration success 重置失败计数", () => {
  const dir = makeTmpDir();
  try {
    const rs = new RunState(dir, "r-006", "测试");
    // 连续 2 次 failed
    rs.recordIteration({
      iterIndex: 1,
      resultKind: "failed",
      summary: "fail 1",
      tokens: 10,
      committed: false,
      error: "e1",
    });
    rs.recordIteration({
      iterIndex: 2,
      resultKind: "failed",
      summary: "fail 2",
      tokens: 10,
      committed: false,
      error: "e2",
    });
    assert.equal(rs.state.consecutiveFailures, 2);

    // 第 3 次 success → 重置失败计数
    rs.recordIteration({ iterIndex: 3, resultKind: "success", summary: "ok", tokens: 10, committed: false, error: "" });
    assert.equal(rs.state.consecutiveFailures, 0);
    assert.equal(rs.state.iterIndex, 3);
  } finally {
    rmTmpDir(dir);
  }
});

test("RS-007: recordIteration failed 增加失败计数", () => {
  const dir = makeTmpDir();
  try {
    const rs = new RunState(dir, "r-007", "测试");
    rs.recordIteration({
      iterIndex: 1,
      resultKind: "failed",
      summary: "fail",
      tokens: 0,
      committed: false,
      error: "e",
    });
    assert.equal(rs.state.consecutiveFailures, 1);
  } finally {
    rmTmpDir(dir);
  }
});

test("RS-008: recordIteration committed 增加提交数", () => {
  const dir = makeTmpDir();
  try {
    const rs = new RunState(dir, "r-008", "测试");
    rs.recordIteration({ iterIndex: 1, resultKind: "success", summary: "ok", tokens: 0, committed: true, error: "" });
    assert.equal(rs.state.commitsMade, 1);

    rs.recordIteration({ iterIndex: 2, resultKind: "success", summary: "ok", tokens: 0, committed: false, error: "" });
    // committed=false 不增加
    assert.equal(rs.state.commitsMade, 1);
  } finally {
    rmTmpDir(dir);
  }
});

test("RS-009: recordIteration 累计 tokens", () => {
  const dir = makeTmpDir();
  try {
    const rs = new RunState(dir, "r-009", "测试");
    rs.recordIteration({
      iterIndex: 1,
      resultKind: "success",
      summary: "ok",
      tokens: 100,
      committed: false,
      error: "",
    });
    assert.equal(rs.state.cumulativeTokens, 100);

    rs.recordIteration({
      iterIndex: 2,
      resultKind: "success",
      summary: "ok",
      tokens: 200,
      committed: false,
      error: "",
    });
    assert.equal(rs.state.cumulativeTokens, 300);
  } finally {
    rmTmpDir(dir);
  }
});

// ============================================================================
// RS-010: RunState 可注入 RalphLoopController（类型兼容性）
// ============================================================================

test("RS-010: RunState 可注入 RalphLoopController", async () => {
  // 验证 RunState 实现 RunStateLike 接口，可传入 RalphLoopController 构造函数
  // 不抛类型错误即通过
  const dir = makeTmpDir();
  try {
    const runState = new RunState(dir, "r-010", "测试");
    const config = defaultLoopConfig();

    // 构造 stub stage handler 返回 success，让循环快速退出
    const successHandler: StageHandler = {
      handle(_ctx: IterationContext): StageResult {
        return {
          kind: "success",
          summary: "stub success",
          artifacts: { tokens: 0 },
        };
      },
    };

    // 构造 stub git driver
    const stubGitDriver = {
      commit: () => ({ success: true }),
      rollback: () => ({ success: true }),
    };

    // 设置 maxIterations=1 让循环只执行 1 次就退出
    const controller = new RalphLoopController({
      config: { ...config, maxIterations: 1 },
      projectRoot: dir,
      gitDriver: stubGitDriver,
      notesMemory: null,
      runState, // ← 注入 RunState 实例（验证 RunStateLike 接口兼容性）
      stageHandlers: {
        plan: successHandler,
        dev: successHandler,
        verify: successHandler,
        fix: successHandler,
      },
      log: () => {},
      sleepGuard: null,
    });

    // 执行 run()，不抛类型错误即通过
    const exitCode = await controller.run();
    // exitCode 应为 0（success）或 3（stop_when）
    assert.ok(exitCode === 0 || exitCode === 3, `exitCode 应为 0 或 3，实际: ${exitCode}`);
  } finally {
    rmTmpDir(dir);
  }
});
