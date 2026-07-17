/**
 * FeedbackControlLoop 单元测试
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ControlPhase,
  ALL_CONTROL_PHASES,
  isValidControlPhase,
  FeedbackControlLoopError,
  FeedbackControlStorageError,
  createExecutionCase,
  executionCaseToDict,
  executionCaseFromDict,
  createControlState,
  controlStateSuccessRate,
  controlStateAvgTime,
  touchControlState,
  createFeedback,
  SimpleMutex,
  NodeFileSystem,
  FeedbackCollector,
  StateEstimator,
  STRATEGY_DEFINITIONS,
  StrategyPool,
  FeedbackControlLoop,
} from "../../cybernetics/feedback-control-loop.js";

test("ControlPhase has 5 phases", () => {
  assert.ok(ALL_CONTROL_PHASES.length >= 5);
  assert.equal(ControlPhase.PERCEPTION, "perception");
  assert.equal(ControlPhase.DECISION, "decision");
  assert.equal(ControlPhase.EXECUTION, "execution");
  assert.equal(ControlPhase.FEEDBACK, "feedback");
  assert.equal(ControlPhase.COMPLETED, "completed");
});

test("isValidControlPhase accepts valid phases", () => {
  for (const p of ALL_CONTROL_PHASES) {
    assert.ok(isValidControlPhase(p));
  }
  assert.equal(isValidControlPhase("invalid"), false);
});

test("SimpleMutex lockSync/unlockSync works", () => {
  const mutex = new SimpleMutex();
  assert.equal(mutex.lockSync(), true);
  // 再次获取应失败
  assert.equal(mutex.lockSync(), false);
  // 解锁后再次成功
  mutex.unlockSync();
  assert.equal(mutex.lockSync(), true);
  mutex.unlockSync();
});

test("SimpleMutex runExclusive serializes critical section", async () => {
  const mutex = new SimpleMutex();
  const order: number[] = [];

  const t1 = mutex.runExclusive(async () => {
    await new Promise((r) => setTimeout(r, 20));
    order.push(1);
  });
  const t2 = mutex.runExclusive(async () => {
    await new Promise((r) => setTimeout(r, 5));
    order.push(2);
  });
  await Promise.all([t1, t2]);
  assert.deepEqual(order, [1, 2]);
});

test("NodeFileSystem exists and basic methods work", () => {
  const fs = new NodeFileSystem();
  assert.equal(typeof fs.exists, "function");
  assert.equal(fs.exists("/tmp"), true);
  assert.equal(fs.exists("/this/path/definitely/does/not/exist/xyz"), false);
});

test("createExecutionCase applies all fields", () => {
  const c = createExecutionCase({
    case_id: "test-case-001",
    task_type: "test",
    task_complexity: 5,
    task_features: { cpu: 0.5, memory: 0.7 },
    strategy: "explore",
    execution_time: 100,
    success: true,
  });
  assert.equal(c.case_id, "test-case-001");
  assert.equal(c.strategy, "explore");
  assert.equal(c.success, true);
  assert.equal(c.execution_time, 100);
});

test("executionCaseToDict and FromDict round-trip", () => {
  const c = createExecutionCase({
    case_id: "sig",
    task_type: "test",
    task_complexity: 3,
    task_features: { x: 1 },
    strategy: "strat",
    execution_time: 50,
    success: false,
  });
  const dict = executionCaseToDict(c);
  const c2 = executionCaseFromDict(dict);
  assert.equal(c2.case_id, "sig");
  assert.equal(c2.strategy, "strat");
  assert.equal(c2.success, false);
  assert.equal(c2.execution_time, 50);
});

test("createControlState initializes with default fields", () => {
  const s = createControlState("agent-1");
  assert.equal(s.agent_id, "agent-1");
  assert.equal(s.execution_count, 0);
  assert.equal(s.success_count, 0);
  assert.equal(s.failure_count, 0);
  assert.equal(s.total_execution_time, 0);
});

test("controlStateSuccessRate returns 0 when no executions", () => {
  const s = createControlState("agent-1");
  assert.equal(controlStateSuccessRate(s), 0);
});

test("controlStateSuccessRate returns correct ratio", () => {
  const s = createControlState("agent-1");
  s.execution_count = 10;
  s.success_count = 8;
  s.total_execution_time = 100;
  assert.equal(controlStateSuccessRate(s), 0.8);
  assert.equal(controlStateAvgTime(s), 10);
});

test("touchControlState updates timestamp", async () => {
  const s = createControlState("agent-1");
  const before = s.updated_at;
  await new Promise((r) => setTimeout(r, 10));
  touchControlState(s);
  assert.notEqual(s.updated_at, before);
});

test("createFeedback captures feedback fields", () => {
  const f = createFeedback({
    task_id: "task-001",
    success: true,
    execution_time: 50,
  });
  assert.equal(f.task_id, "task-001");
  assert.equal(f.success, true);
  assert.equal(f.execution_time, 50);
  assert.ok(f.created_at.length > 0);
  assert.deepEqual(f.suggestions, []);
});

test("STRATEGY_DEFINITIONS has strategy entries", () => {
  assert.ok(Object.keys(STRATEGY_DEFINITIONS).length > 0);
});

test("StrategyPool getStrategy returns a valid strategy", () => {
  const pool = new StrategyPool();
  const s = pool.getStrategy("default");
  assert.ok(s !== undefined);
  assert.equal(typeof s, "object");
});

test("StrategyPool getDefaultStrategy returns 'default'", () => {
  const pool = new StrategyPool();
  const def = pool.getDefaultStrategy();
  assert.equal(def, "default");
  assert.ok(STRATEGY_DEFINITIONS[def] !== undefined);
});

test("StrategyPool getAllStrategies returns map", () => {
  const pool = new StrategyPool();
  const all = pool.getAllStrategies();
  assert.ok(typeof all === "object");
  assert.ok(Object.keys(all).length > 0);
});

test("FeedbackCollector collect stores feedback", async () => {
  const collector = new FeedbackCollector();
  await collector.collect("t1", { success: true, execution_time: 10 });
  await collector.collect("t2", { success: false, execution_time: 20 });
  const all = await collector.getRecentFeedback(10);
  assert.equal(all.length, 2);
});

test("FeedbackCollector getErrorStatistics works", async () => {
  const collector = new FeedbackCollector();
  await collector.collect("t1", { success: false, error_type: "timeout", execution_time: 10 });
  const stats = await collector.getErrorStatistics();
  assert.ok(typeof stats === "object");
});

test("StateEstimator exists and has estimate method", () => {
  const estimator = new StateEstimator();
  assert.equal(typeof estimator.estimate, "function");
});

test("StateEstimator estimate returns a vector", async () => {
  const estimator = new StateEstimator();
  const v = await estimator.estimate({ complexity: "high" });
  assert.ok(typeof v === "object");
});

test("FeedbackControlLoop exists and has executeWithFeedback", () => {
  const loop = new FeedbackControlLoop({ agent_id: "agent-1" });
  assert.equal(typeof loop.executeWithFeedback, "function");
});

test("FeedbackControlLoop has setExecutor", () => {
  const loop = new FeedbackControlLoop({ agent_id: "agent-1" });
  loop.setExecutor(async (task) => ({ ...task, done: true }));
  assert.equal(typeof loop.executeWithFeedback, "function");
});

test("FeedbackControlLoop executeWithFeedback runs through phases", async () => {
  const loop = new FeedbackControlLoop({ agent_id: "agent-1" });
  let executed = false;
  loop.setExecutor(async (task) => {
    executed = true;
    return { ...task, done: true, success: true };
  });
  const result = await loop.executeWithFeedback({ id: "task-1" });
  assert.equal(executed, true);
  assert.equal((result as { done: boolean }).done, true);
});

test("FeedbackControlStorageError has path field", () => {
  const err = new FeedbackControlStorageError("/tmp/missing");
  assert.equal(err.path, "/tmp/missing");
  assert.ok(err instanceof FeedbackControlLoopError);
});

test("FeedbackControlLoop getControlState returns state", () => {
  const loop = new FeedbackControlLoop({ agent_id: "agent-1" });
  const state = loop.getControlState();
  assert.equal(state.agent_id, "agent-1");
});
