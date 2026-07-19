/**
 * EAG-P3 批次 10 单元测试：long-horizon/run-state-store.ts RunState 持久化存储
 *
 * 测试范围（对齐设计文档 §4.10）：
 * - T1.  RunStateStore 实例化（默认构造 + 注入 LockProvider + 注入 logger）
 * - T2.  initialize() 创建 .eag/run-state/<run-id>.jsonl 文件 + 首行 run-started 事件
 * - T3.  initialize() 未提供 runId 时自动生成 12 位十六进制字符串
 * - T4.  initialize() 使用调用方提供的 runId
 * - T5.  initialize() 重复初始化同 runId 抛 RunStateAlreadyExistsError
 * - T6.  initialize() projectRoot 非法抛 RunStateStoreError(invalid-request)
 * - T7.  initialize() runId 含非法字符（路径穿越）抛 RunStateStoreError(invalid-request)
 * - T8.  appendEvent() 追加 loop-started 事件并更新 currentLoop/currentIteration
 * - T9.  appendEvent() 追加 iteration-completed 事件并累计 totalLlmCallCount/totalTokensUsed
 * - T10. appendEvent() 追加 loop-completed 事件并加入 completedLoops + 重置 currentIteration
 * - T11. appendEvent() 追加 milestone-tagged 事件并加入 milestones
 * - T12. appendEvent() 追加 human-intervention + human-intervention-resolved 事件
 * - T13. appendEvent() 追加 run-paused / run-resumed / run-completed / run-failed 事件
 * - T14. RUN_STATE_EVENT_TYPES 参数化：11 种事件类型均可成功追加
 * - T15. SHA256 校验失败：手动篡改 .jsonl 文件后 load() 抛 RunStateCorruptedError
 * - T16. 错误类层级：RunStateStoreError 含 kind 属性，子类继承关系正确
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用真实文件系统 I/O（fs.mkdtempSync 创建临时目录，try/finally 清理）
 * - 不使用任何 mock 框架；FileLockProvider 是真实实现
 * - 使用 node:test + node:assert/strict
 * - SHA256 校验失败场景通过 fs.writeFileSync 手动篡改文件内容实现
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计文档 §4.10 RunState 持久化
 * - EAG 方案 §5.12.2 跨 Loop 续跑 + 跨会话续跑
 * - eag/long-horizon/run-state-store.ts 源文件
 *
 * @module core/tests/eag-long-horizon-run-state-store
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  RunStateStore,
  FileLockProvider,
  RunStateStoreError,
  RunStateCorruptedError,
  RunStateNotFoundError,
  RunStateAlreadyExistsError,
  RunStateDivergedError,
  RUN_STATE_EVENT_TYPES,
} from "../eag/long-horizon/run-state-store";
import type { LockProvider, LockHandle, RunStateEventType } from "../eag/long-horizon/run-state-store";
import { DEFAULT_RUN_STATE_DIR } from "../eag/long-horizon/types";

// ============================================================================
// 辅助工具：创建临时项目根目录 + 清理
// ============================================================================

/**
 * 创建临时项目根目录（mkdtempSync 保证唯一性，避免测试间相互干扰）
 *
 * @returns 临时项目根目录绝对路径
 */
function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eag-run-state-"));
}

/**
 * 递归删除目录（rimraf 风格，用于清理临时目录）
 *
 * @param dirPath 待删除目录
 */
function rmrf(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
}

/**
 * 计算单个 RunState JSONL 文件的当前行数（用于断言事件追加成功）
 *
 * @param projectRoot 项目根目录
 * @param runId run-id
 * @returns JSONL 文件行数（过滤空行后）
 */
function countJsonlLines(projectRoot: string, runId: string): number {
  const jsonlPath = path.join(projectRoot, DEFAULT_RUN_STATE_DIR, `${runId}.jsonl`);
  const content = fs.readFileSync(jsonlPath, "utf8");
  return content.split("\n").filter((line) => line.trim().length > 0).length;
}

// ============================================================================
// T1. RunStateStore 实例化
// ============================================================================

test("T1.1 RunStateStore 默认构造函数可成功实例化", () => {
  // 默认构造：内部使用 FileLockProvider + noopLog
  const store = new RunStateStore();
  assert.ok(store instanceof RunStateStore, "RunStateStore 应成功实例化");
});

test("T1.2 RunStateStore 支持注入 FileLockProvider", () => {
  // 显式注入 FileLockProvider 实例（生产实现）
  const lockProvider = new FileLockProvider();
  const store = new RunStateStore(lockProvider);
  assert.ok(store instanceof RunStateStore, "应支持注入 FileLockProvider");
});

test("T1.3 RunStateStore 支持注入自定义 LockProvider + logger", () => {
  // 注入内存 LockProvider（真实实现，非 mock）+ logger 回调
  const logs: Array<{ message: string; level: string }> = [];
  const logger = (message: string, level?: "info" | "warn" | "error") => {
    logs.push({ message, level: level ?? "info" });
  };
  const inMemoryLock = new InMemoryLockProvider();
  const store = new RunStateStore(inMemoryLock, logger);
  assert.ok(store instanceof RunStateStore, "应支持注入自定义 LockProvider + logger");
  void store; // 抑制未使用警告
});

// ============================================================================
// T2. initialize() 创建 JSONL 文件
// ============================================================================

test("T2.1 initialize() 在 .eag/run-state/ 下创建 <run-id>.jsonl 文件", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state = await store.initialize({
      projectRoot,
      runId: "test-init-001",
    });

    // 验证文件存在
    const jsonlPath = path.join(projectRoot, DEFAULT_RUN_STATE_DIR, "test-init-001.jsonl");
    assert.ok(fs.existsSync(jsonlPath), "JSONL 文件应被创建");

    // 验证返回的 RunState 字段
    assert.equal(state.runId, "test-init-001");
    assert.equal(state.projectRoot, path.resolve(projectRoot));
    assert.equal(state.status, "running");
    assert.equal(state.currentLoop, "design"); // 默认 initialLoop
    assert.equal(state.currentIteration, 0);
    assert.equal(state.completedLoops.length, 0);
    assert.equal(state.milestones.length, 0);
    assert.equal(state.humanInterventions.length, 0);
    assert.equal(state.humanInterventionCount, 0);
    assert.ok(state.checksum.startsWith("sha256:"), "checksum 应为 sha256: 前缀");
  } finally {
    rmrf(projectRoot);
  }
});

test("T2.2 initialize() 写入首行 run-started 事件", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    await store.initialize({ projectRoot, runId: "test-init-002" });

    // 读取首行验证事件类型
    const jsonlPath = path.join(projectRoot, DEFAULT_RUN_STATE_DIR, "test-init-002.jsonl");
    const content = fs.readFileSync(jsonlPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 1, "应仅有首行 run-started 事件");

    const firstEvent = JSON.parse(lines[0]);
    assert.equal(firstEvent.type, "run-started");
    assert.equal(firstEvent.payload.runId, "test-init-002");
    assert.equal(firstEvent.payload.initialLoop, "design");
    assert.ok(firstEvent.localChecksum.startsWith("sha256:"));
    assert.ok(firstEvent.cumulativeChecksum.startsWith("sha256:"));
    // 首事件 cumulativeChecksum = sha256("" + localChecksum)
    assert.notEqual(firstEvent.localChecksum, firstEvent.cumulativeChecksum);
  } finally {
    rmrf(projectRoot);
  }
});

test("T2.3 initialize() 自动创建 .eag/run-state/ 目录（含父目录）", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    // 初始时 .eag/run-state/ 不存在
    const runStateDir = path.join(projectRoot, DEFAULT_RUN_STATE_DIR);
    assert.ok(!fs.existsSync(runStateDir), "测试前提：目录不存在");

    const store = new RunStateStore();
    await store.initialize({ projectRoot, runId: "test-mkdir-001" });

    // 验证目录已递归创建
    assert.ok(fs.existsSync(runStateDir), ".eag/run-state/ 应被递归创建");
    assert.ok(fs.statSync(runStateDir).isDirectory(), "应为目录");
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T3. initialize() 自动生成 runId
// ============================================================================

test("T3.1 initialize() 未提供 runId 时自动生成 12 位十六进制字符串", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state = await store.initialize({ projectRoot });

    // 验证 runId 格式：12 位十六进制
    assert.match(state.runId, /^[a-f0-9]{12}$/, "runId 应为 12 位十六进制字符串");

    // 验证文件以自动生成的 runId 命名
    const jsonlPath = path.join(projectRoot, DEFAULT_RUN_STATE_DIR, `${state.runId}.jsonl`);
    assert.ok(fs.existsSync(jsonlPath), "文件名应与 runId 一致");
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T4. initialize() 使用提供的 runId
// ============================================================================

test("T4.1 initialize() 使用调用方提供的 runId", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state = await store.initialize({
      projectRoot,
      runId: "custom-run-id-001",
    });
    assert.equal(state.runId, "custom-run-id-001");

    // 文件名也应一致
    const jsonlPath = path.join(projectRoot, DEFAULT_RUN_STATE_DIR, "custom-run-id-001.jsonl");
    assert.ok(fs.existsSync(jsonlPath));
  } finally {
    rmrf(projectRoot);
  }
});

test("T4.2 initialize() 支持自定义 initialLoop=coding", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state = await store.initialize({
      projectRoot,
      runId: "test-init-coding",
      initialLoop: "coding",
    });
    assert.equal(state.currentLoop, "coding");

    // 验证首行事件 payload 含 initialLoop=coding
    const jsonlPath = path.join(projectRoot, DEFAULT_RUN_STATE_DIR, "test-init-coding.jsonl");
    const content = fs.readFileSync(jsonlPath, "utf8");
    const firstEvent = JSON.parse(content.split("\n")[0]);
    assert.equal(firstEvent.payload.initialLoop, "coding");
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T5. initialize() 重复初始化抛 RunStateAlreadyExistsError
// ============================================================================

test("T5.1 initialize() 同 runId 重复初始化抛 RunStateAlreadyExistsError", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    await store.initialize({ projectRoot, runId: "dup-001" });

    // 第二次初始化同 runId 应抛错
    await assert.rejects(
      () => store.initialize({ projectRoot, runId: "dup-001" }),
      (err: unknown) => {
        assert.ok(err instanceof RunStateAlreadyExistsError, "应抛 RunStateAlreadyExistsError");
        assert.ok(err instanceof RunStateStoreError, "应是 RunStateStoreError 子类");
        assert.equal(err.kind, "already-exists");
        assert.equal(err.runId, "dup-001");
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T6. initialize() projectRoot 非法抛 RunStateStoreError(invalid-request)
// ============================================================================

test("T6.1 initialize() projectRoot 为空字符串抛 invalid-request", async () => {
  const store = new RunStateStore();
  await assert.rejects(
    () => store.initialize({ projectRoot: "", runId: "test-001" }),
    (err: unknown) => {
      assert.ok(err instanceof RunStateStoreError);
      assert.equal(err.kind, "invalid-request");
      return true;
    }
  );
});

test("T6.2 initialize() projectRoot 为空白字符抛 invalid-request", async () => {
  const store = new RunStateStore();
  await assert.rejects(
    () => store.initialize({ projectRoot: "   ", runId: "test-002" }),
    (err: unknown) => {
      assert.ok(err instanceof RunStateStoreError);
      assert.equal(err.kind, "invalid-request");
      return true;
    }
  );
});

test("T6.3 initialize() request 为 null 抛 invalid-request", async () => {
  const store = new RunStateStore();
  await assert.rejects(
    () => store.initialize(null as any),
    (err: unknown) => {
      assert.ok(err instanceof RunStateStoreError);
      assert.equal(err.kind, "invalid-request");
      return true;
    }
  );
});

// ============================================================================
// T7. initialize() runId 含非法字符抛 RunStateStoreError(invalid-request)
// ============================================================================

test("T7.1 initialize() runId 含路径穿越字符（..）抛 invalid-request", async () => {
  const store = new RunStateStore();
  await assert.rejects(
    () => store.initialize({ projectRoot: "/tmp", runId: "../escape" }),
    (err: unknown) => {
      assert.ok(err instanceof RunStateStoreError);
      assert.equal(err.kind, "invalid-request");
      return true;
    }
  );
});

test("T7.2 initialize() runId 含斜杠抛 invalid-request", async () => {
  const store = new RunStateStore();
  await assert.rejects(
    () => store.initialize({ projectRoot: "/tmp", runId: "abc/def" }),
    (err: unknown) => {
      assert.ok(err instanceof RunStateStoreError);
      assert.equal(err.kind, "invalid-request");
      return true;
    }
  );
});

test("T7.3 initialize() runId 含特殊字符抛 invalid-request", async () => {
  const store = new RunStateStore();
  await assert.rejects(
    () => store.initialize({ projectRoot: "/tmp", runId: "abc@def!" }),
    (err: unknown) => {
      assert.ok(err instanceof RunStateStoreError);
      assert.equal(err.kind, "invalid-request");
      return true;
    }
  );
});

// ============================================================================
// T8. appendEvent() 追加 loop-started 事件
// ============================================================================

test("T8.1 appendEvent() 追加 loop-started 事件更新 currentLoop 与 currentIteration", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const initState = await store.initialize({
      projectRoot,
      runId: "test-loop-start-001",
    });

    // 追加 loop-started 事件
    const updatedState = await store.appendEvent(initState.runId, {
      type: "loop-started",
      payload: { loopType: "coding", iteration: 1 },
    });

    // 验证 currentLoop 与 currentIteration 已更新
    assert.equal(updatedState.currentLoop, "coding");
    assert.equal(updatedState.currentIteration, 1);
    assert.equal(updatedState.status, "running");

    // 验证文件已追加一行（首行 run-started + 第二行 loop-started = 2 行）
    assert.equal(countJsonlLines(projectRoot, initState.runId), 2);
  } finally {
    rmrf(projectRoot);
  }
});

test("T8.2 appendEvent() 不存在的 runId 抛 RunStateNotFoundError", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    await assert.rejects(
      () =>
        store.appendEvent("nonexistent-run-id", {
          type: "loop-started",
          payload: { loopType: "coding", iteration: 1 },
        }),
      (err: unknown) => {
        assert.ok(err instanceof RunStateNotFoundError);
        assert.equal(err.kind, "not-found");
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T8.3 appendEvent() 入参 type 非法抛 invalid-request", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state = await store.initialize({ projectRoot, runId: "test-bad-type" });

    await assert.rejects(
      () => store.appendEvent(state.runId, { type: "invalid-type" as any, payload: {} }),
      (err: unknown) => {
        assert.ok(err instanceof RunStateStoreError);
        assert.equal(err.kind, "invalid-request");
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T9. appendEvent() 追加 iteration-completed 事件累计统计
// ============================================================================

test("T9.1 appendEvent() 追加 iteration-completed 累计 totalLlmCallCount 与 totalTokensUsed", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state0 = await store.initialize({ projectRoot, runId: "test-iter-001" });

    // 第一次迭代完成：5 次 LLM 调用 + 1000 tokens
    const state1 = await store.appendEvent(state0.runId, {
      type: "iteration-completed",
      payload: { loopType: "design", iteration: 1, llmCallCount: 5, tokensUsed: 1000 },
    });
    assert.equal(state1.totalLlmCallCount, 5);
    assert.equal(state1.totalTokensUsed, 1000);
    assert.equal(state1.currentIteration, 1);

    // 第二次迭代完成：3 次 LLM 调用 + 500 tokens（累计）
    const state2 = await store.appendEvent(state1.runId, {
      type: "iteration-completed",
      payload: {
        loopType: "design",
        iteration: 2,
        llmCallCount: 3,
        tokensUsed: 500,
        completedTaskIds: ["T-001"],
        pendingDeleteFiles: ["tmp/old.txt"],
      },
    });
    assert.equal(state2.totalLlmCallCount, 8); // 5 + 3
    assert.equal(state2.totalTokensUsed, 1500); // 1000 + 500
    assert.equal(state2.currentIteration, 2);
    assert.deepEqual([...state2.completedTaskIds], ["T-001"]);
    assert.deepEqual([...state2.pendingDeleteFiles], ["tmp/old.txt"]);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T10. appendEvent() 追加 loop-completed 事件
// ============================================================================

test("T10.1 appendEvent() 追加 loop-completed 加入 completedLoops 并重置 currentIteration", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state0 = await store.initialize({ projectRoot, runId: "test-loop-comp-001" });

    // 先进入 design Loop 第 1 次迭代
    await store.appendEvent(state0.runId, {
      type: "loop-started",
      payload: { loopType: "design", iteration: 1 },
    });
    await store.appendEvent(state0.runId, {
      type: "iteration-completed",
      payload: { loopType: "design", iteration: 1, llmCallCount: 2, tokensUsed: 200 },
    });

    // 完成 design Loop
    const stateAfter = await store.appendEvent(state0.runId, {
      type: "loop-completed",
      payload: { loopType: "design" },
    });

    // 验证 completedLoops 已追加 "design"
    assert.deepEqual([...stateAfter.completedLoops], ["design"]);
    // currentIteration 应被重置为 0（loop-completed 触发重置）
    assert.equal(stateAfter.currentIteration, 0);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T11. appendEvent() 追加 milestone-tagged 事件
// ============================================================================

test("T11.1 appendEvent() 追加 milestone-tagged 事件加入 milestones 列表", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state0 = await store.initialize({ projectRoot, runId: "test-milestone-001" });

    const milestone = Object.freeze({
      index: 1,
      name: "DESIGN Loop 完成",
      loopType: "design" as const,
      completedAt: new Date().toISOString(),
      tagName: "eag/test-milestone-001/m1",
      commitSha: "abc123def456789",
      regressionResult: Object.freeze({
        totalTests: 50,
        passedTests: 50,
        failedTests: 0,
        exitCode: 0,
        durationSec: 12.5,
      }),
      healthScore: 0.95,
    });

    const state1 = await store.appendEvent(state0.runId, {
      type: "milestone-tagged",
      payload: { milestone },
    });

    assert.equal(state1.milestones.length, 1);
    assert.equal(state1.milestones[0].index, 1);
    assert.equal(state1.milestones[0].tagName, "eag/test-milestone-001/m1");
    assert.equal(state1.milestones[0].commitSha, "abc123def456789");
    assert.equal(state1.milestones[0].healthScore, 0.95);
    assert.equal(state1.milestones[0].regressionResult?.passedTests, 50);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T12. appendEvent() 追加 human-intervention + resolved 事件
// ============================================================================

test("T12.1 appendEvent() 追加 human-intervention 事件加入 humanInterventions", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state0 = await store.initialize({ projectRoot, runId: "test-hi-001" });

    const state1 = await store.appendEvent(state0.runId, {
      type: "human-intervention",
      payload: {
        loopType: "coding",
        reason: "FIX 失败 3 次",
        decision: "放宽 E7 评估器规则",
      },
    });

    assert.equal(state1.humanInterventions.length, 1);
    assert.equal(state1.humanInterventionCount, 1);
    assert.equal(state1.humanInterventions[0].loopType, "coding");
    assert.equal(state1.humanInterventions[0].reason, "FIX 失败 3 次");
    assert.equal(state1.humanInterventions[0].decision, "放宽 E7 评估器规则");
    assert.equal(state1.humanInterventions[0].resolved, false);
  } finally {
    rmrf(projectRoot);
  }
});

test("T12.2 appendEvent() 追加 human-intervention-resolved 标记 resolved=true", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state0 = await store.initialize({ projectRoot, runId: "test-hi-resolve-001" });

    // 触发人工介入
    await store.appendEvent(state0.runId, {
      type: "human-intervention",
      payload: { loopType: "coding", reason: "G-3 偏离", decision: "调整 spec" },
    });

    // 标记已解决
    const state2 = await store.appendEvent(state0.runId, {
      type: "human-intervention-resolved",
      payload: { index: 0 },
    });

    assert.equal(state2.humanInterventions.length, 1);
    assert.equal(state2.humanInterventions[0].resolved, true);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T13. appendEvent() 追加 run-paused / run-resumed / run-completed / run-failed
// ============================================================================

test("T13.1 appendEvent() 追加 run-paused 事件设置 status=paused 与 blockedReason", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state0 = await store.initialize({ projectRoot, runId: "test-pause-001" });

    const state1 = await store.appendEvent(state0.runId, {
      type: "run-paused",
      payload: { reason: "用户主动暂停" },
    });

    assert.equal(state1.status, "paused");
    assert.equal(state1.blockedReason, "用户主动暂停");
  } finally {
    rmrf(projectRoot);
  }
});

test("T13.2 appendEvent() 追加 run-resumed 事件恢复 status=running 并清除 blockedReason", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state0 = await store.initialize({ projectRoot, runId: "test-resume-001" });

    await store.appendEvent(state0.runId, {
      type: "run-paused",
      payload: { reason: "暂停测试" },
    });

    const state2 = await store.appendEvent(state0.runId, {
      type: "run-resumed",
      payload: {},
    });

    assert.equal(state2.status, "running");
    assert.equal(state2.blockedReason, undefined);
  } finally {
    rmrf(projectRoot);
  }
});

test("T13.3 appendEvent() 追加 run-completed 事件设置 status=completed", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state0 = await store.initialize({ projectRoot, runId: "test-complete-001" });

    const state1 = await store.appendEvent(state0.runId, {
      type: "run-completed",
      payload: { finalReport: "全部 Loop 完成" },
    });

    assert.equal(state1.status, "completed");
  } finally {
    rmrf(projectRoot);
  }
});

test("T13.4 appendEvent() 追加 run-failed 事件设置 status=failed 与 blockedReason", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state0 = await store.initialize({ projectRoot, runId: "test-fail-001" });

    const state1 = await store.appendEvent(state0.runId, {
      type: "run-failed",
      payload: { reason: "LoopGuard 触达上限" },
    });

    assert.equal(state1.status, "failed");
    assert.equal(state1.blockedReason, "LoopGuard 触达上限");
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T14. 参数化测试 11 种事件类型 RUN_STATE_EVENT_TYPES
// ============================================================================

test("T14.1 RUN_STATE_EVENT_TYPES 包含 11 种事件类型", () => {
  assert.equal(RUN_STATE_EVENT_TYPES.length, 11);
  const expectedTypes: ReadonlyArray<RunStateEventType> = [
    "run-started",
    "loop-started",
    "loop-completed",
    "iteration-completed",
    "milestone-tagged",
    "human-intervention",
    "human-intervention-resolved",
    "run-paused",
    "run-resumed",
    "run-completed",
    "run-failed",
  ];
  assert.deepEqual([...RUN_STATE_EVENT_TYPES], [...expectedTypes]);
});

test("T14.2 RUN_STATE_EVENT_TYPES 已冻结", () => {
  assert.equal(Object.isFrozen(RUN_STATE_EVENT_TYPES), true);
});

// 参数化：为非 run-started 的 10 种事件类型构造合法 payload，验证 appendEvent 接受
// run-started 由 initialize 写入，appendEvent 不接受 run-started（语义上仅 initialize 写首行）
for (const eventType of RUN_STATE_EVENT_TYPES) {
  if (eventType === "run-started") continue; // run-started 仅由 initialize 写入

  test(`T14.3 参数化：appendEvent 接受事件类型 ${eventType}`, async () => {
    const projectRoot = makeTempProjectRoot();
    try {
      const store = new RunStateStore();
      const state0 = await store.initialize({
        projectRoot,
        runId: `test-param-${eventType}`,
      });

      // 根据事件类型构造合法 payload
      const payload = buildPayloadForEventType(eventType);
      const updatedState = await store.appendEvent(state0.runId, {
        type: eventType,
        payload,
      });

      // 验证事件已追加（updatedAt 应晚于 startedAt 或等于）
      assert.ok(updatedState.updatedAt >= state0.startedAt);
      // 验证文件行数 = 2（首行 run-started + 当前事件）
      assert.equal(countJsonlLines(projectRoot, state0.runId), 2);
    } finally {
      rmrf(projectRoot);
    }
  });
}

// ============================================================================
// T15. SHA256 校验失败：手动篡改文件内容
// ============================================================================

test("T15.1 load() 检测到 localChecksum 不匹配时抛 RunStateCorruptedError", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state0 = await store.initialize({ projectRoot, runId: "test-corrupt-001" });
    await store.appendEvent(state0.runId, {
      type: "loop-started",
      payload: { loopType: "coding", iteration: 1 },
    });

    // 手动篡改第二行事件的 payload（保持 JSON 结构但内容变化）
    const jsonlPath = path.join(projectRoot, DEFAULT_RUN_STATE_DIR, "test-corrupt-001.jsonl");
    const content = fs.readFileSync(jsonlPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);

    // 篡改第二行：替换 iteration 1 → 999（localChecksum 不变，但内容不匹配）
    const tamperedLine2 = lines[1].replace('"iteration":1', '"iteration":999');
    const tamperedContent = lines[0] + "\n" + tamperedLine2 + "\n";
    fs.writeFileSync(jsonlPath, tamperedContent, "utf8");

    // load 应抛 RunStateCorruptedError（localChecksum 校验失败）
    await assert.rejects(
      () => store.load(state0.runId, projectRoot),
      (err: unknown) => {
        assert.ok(err instanceof RunStateCorruptedError, "应抛 RunStateCorruptedError");
        assert.ok(err instanceof RunStateStoreError, "应是 RunStateStoreError 子类");
        assert.equal(err.kind, "corrupted");
        assert.equal(err.runId, "test-corrupt-001");
        // 错误信息应含 "localChecksum" 关键字
        assert.ok(err.detail.includes("localChecksum"), "错误详情应提到 localChecksum");
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T15.2 load() 检测到 cumulativeChecksum 不匹配时抛 RunStateCorruptedError", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state0 = await store.initialize({ projectRoot, runId: "test-corrupt-002" });
    await store.appendEvent(state0.runId, {
      type: "loop-started",
      payload: { loopType: "design", iteration: 1 },
    });
    await store.appendEvent(state0.runId, {
      type: "iteration-completed",
      payload: { loopType: "design", iteration: 1, llmCallCount: 1, tokensUsed: 100 },
    });

    // 篡改第二行：删除第二行，让第三行 cumulativeChecksum 校验失败
    // （第三行 cumulativeChecksum 基于第二行 cumulativeChecksum 计算，删除第二行后链断）
    const jsonlPath = path.join(projectRoot, DEFAULT_RUN_STATE_DIR, "test-corrupt-002.jsonl");
    const content = fs.readFileSync(jsonlPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);

    // 仅保留首行 + 末行（删除中间行），末行 cumulativeChecksum 必然不匹配
    const tamperedContent = lines[0] + "\n" + lines[2] + "\n";
    fs.writeFileSync(jsonlPath, tamperedContent, "utf8");

    await assert.rejects(
      () => store.load(state0.runId, projectRoot),
      (err: unknown) => {
        assert.ok(err instanceof RunStateCorruptedError);
        assert.equal(err.kind, "corrupted");
        // 错误信息应含 "cumulativeChecksum" 关键字
        assert.ok(err.detail.includes("cumulativeChecksum"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T15.3 load() 文件不存在抛 RunStateNotFoundError", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    await assert.rejects(
      () => store.load("nonexistent-run", projectRoot),
      (err: unknown) => {
        assert.ok(err instanceof RunStateNotFoundError);
        assert.equal(err.kind, "not-found");
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T15.4 load() 成功加载并重建 RunState", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const state0 = await store.initialize({ projectRoot, runId: "test-load-001" });
    await store.appendEvent(state0.runId, {
      type: "loop-started",
      payload: { loopType: "coding", iteration: 1 },
    });
    await store.appendEvent(state0.runId, {
      type: "iteration-completed",
      payload: { loopType: "coding", iteration: 1, llmCallCount: 5, tokensUsed: 800 },
    });

    // 重新加载（模拟跨会话续跑）
    const reloaded = await store.load(state0.runId, projectRoot);

    // 验证字段一致
    assert.equal(reloaded.runId, state0.runId);
    assert.equal(reloaded.currentLoop, "coding");
    assert.equal(reloaded.currentIteration, 1);
    assert.equal(reloaded.totalLlmCallCount, 5);
    assert.equal(reloaded.totalTokensUsed, 800);
    assert.equal(reloaded.status, "running");
    // checksum 应为最后一行事件的累积 SHA256（与最后 appendEvent 返回的 state.checksum 一致）
    assert.ok(reloaded.checksum.startsWith("sha256:"));
    assert.ok(reloaded.checksum.length > "sha256:".length);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T16. 错误类层级与 kind 属性
// ============================================================================

test("T16.1 RunStateStoreError 含 kind 属性且 instanceof Error", () => {
  const err = new RunStateStoreError("invalid-request", "测试详情");
  assert.ok(err instanceof Error);
  assert.equal(err.kind, "invalid-request");
  assert.equal(err.detail, "测试详情");
  assert.equal(err.name, "RunStateStoreError");
});

test("T16.2 RunStateCorruptedError 是 RunStateStoreError 子类", () => {
  const err = new RunStateCorruptedError("run-001", "校验失败");
  assert.ok(err instanceof RunStateStoreError);
  assert.ok(err instanceof Error);
  assert.equal(err.kind, "corrupted");
  assert.equal(err.runId, "run-001");
  assert.equal(err.name, "RunStateCorruptedError");
});

test("T16.3 RunStateNotFoundError 是 RunStateStoreError 子类", () => {
  const err = new RunStateNotFoundError("run-002", "/tmp/project");
  assert.ok(err instanceof RunStateStoreError);
  assert.equal(err.kind, "not-found");
  assert.equal(err.runId, "run-002");
  assert.equal(err.name, "RunStateNotFoundError");
});

test("T16.4 RunStateAlreadyExistsError 是 RunStateStoreError 子类", () => {
  const err = new RunStateAlreadyExistsError("run-003", "/tmp/project");
  assert.ok(err instanceof RunStateStoreError);
  assert.equal(err.kind, "already-exists");
  assert.equal(err.runId, "run-003");
  assert.equal(err.name, "RunStateAlreadyExistsError");
});

test("T16.5 RunStateDivergedError 含 expectedCommitSha 与 actualCommitSha", () => {
  const err = new RunStateDivergedError("run-004", "abc123", "def456");
  assert.ok(err instanceof RunStateStoreError);
  assert.equal(err.kind, "diverged");
  assert.equal(err.runId, "run-004");
  assert.equal(err.expectedCommitSha, "abc123");
  assert.equal(err.actualCommitSha, "def456");
  assert.equal(err.name, "RunStateDivergedError");
});

// ============================================================================
// T17. listRuns() 列出所有 run（额外覆盖，确保完整性）
// ============================================================================

test("T17.1 listRuns() 返回空数组当 .eag/run-state/ 不存在", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    const runs = await store.listRuns(projectRoot);
    assert.equal(runs.length, 0);
  } finally {
    rmrf(projectRoot);
  }
});

test("T17.2 listRuns() 返回所有 run 摘要并按 updatedAt 降序排序", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    const store = new RunStateStore();
    // 创建 3 个 run
    await store.initialize({ projectRoot, runId: "list-001" });
    await store.initialize({ projectRoot, runId: "list-002" });
    await store.initialize({ projectRoot, runId: "list-003" });

    const runs = await store.listRuns(projectRoot);
    assert.equal(runs.length, 3);

    // 验证每个摘要含必要字段
    for (const summary of runs) {
      assert.ok(typeof summary.runId === "string");
      assert.ok(typeof summary.startedAt === "string");
      assert.ok(typeof summary.updatedAt === "string");
      assert.ok(typeof summary.status === "string");
      assert.ok(typeof summary.currentLoop === "string");
      assert.ok(typeof summary.completionRate === "number");
    }
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// 辅助类与函数
// ============================================================================

/**
 * 内存锁提供者（真实实现，非 mock）
 *
 * 使用 Map 跟踪锁状态，acquire 时设置锁，release 时清除锁。
 * 用于测试中避免真实文件锁的磁盘 I/O 开销。
 */
class InMemoryLockProvider implements LockProvider {
  /** 锁路径 → 获取时间的映射（value 为获取时间，便于后续判断） */
  private readonly locks: Map<string, number> = new Map();

  async acquire(lockPath: string): Promise<LockHandle> {
    if (this.locks.has(lockPath)) {
      // 锁已被占用（在生产实现中会重试 + 超时；此处简化为直接抛错）
      throw new RunStateStoreError("lock-timeout", `内存锁已被占用：${lockPath}`);
    }
    this.locks.set(lockPath, Date.now());
    return Object.freeze({
      lockPath,
      acquiredAt: Date.now(),
    });
  }

  async release(handle: LockHandle): Promise<void> {
    this.locks.delete(handle.lockPath);
  }
}

/**
 * 根据事件类型构造合法的 payload（用于参数化测试）
 *
 * @param eventType 事件类型
 * @returns 该事件类型的合法 payload
 */
function buildPayloadForEventType(eventType: RunStateEventType): Readonly<Record<string, unknown>> {
  switch (eventType) {
    case "loop-started":
      return { loopType: "design", iteration: 1 };
    case "loop-completed":
      return { loopType: "design" };
    case "iteration-completed":
      return { loopType: "design", iteration: 1, llmCallCount: 1, tokensUsed: 100 };
    case "milestone-tagged":
      return {
        milestone: {
          index: 1,
          name: "测试里程碑",
          loopType: "design",
          completedAt: new Date().toISOString(),
          tagName: "eag/test/m1",
          commitSha: "abc123",
          healthScore: 0.9,
        },
      };
    case "human-intervention":
      return { loopType: "coding", reason: "测试原因", decision: "测试决策" };
    case "human-intervention-resolved":
      return { index: 0 };
    case "run-paused":
      return { reason: "测试暂停" };
    case "run-resumed":
      return {};
    case "run-completed":
      return { finalReport: "测试完成" };
    case "run-failed":
      return { reason: "测试失败" };
    case "run-started":
      // run-started 由 initialize 写入，appendEvent 不接受，但为完整性返回
      return { runId: "test", projectRoot: "/tmp", initialLoop: "design" };
    default: {
      // exhaustiveness check：确保所有事件类型都被覆盖
      const _exhaustive: never = eventType;
      throw new Error(`未覆盖的事件类型：${_exhaustive as string}`);
    }
  }
}
