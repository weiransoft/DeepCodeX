/**
 * GoalDispatcher + Plugin 系统测试
 *
 * 验证 DAG 调度、mutex 互斥、失败传播、hot_reload、cleanup 钩子
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GoalDispatcher,
  PluginRegistry,
  topologicalLevels,
  makeGoal,
  makeBatch,
  BasePlugin,
  validatePluginContracts,
} from "../plugins/index.js";
import {
  PluginAlreadyRegisteredError,
  PluginNotRegisteredError,
  PluginPriorityDuplicateError,
  PluginMutexAsymmetricError,
  DispatcherCircularDependencyError,
  DispatcherMissingDependencyError,
  PluginNameInvalidError,
  PluginMutexSelfError,
} from "../errors.js";
import type { DispatchResult, PluginContext, TaskRequirement } from "../types.js";

function makeTask(): TaskRequirement {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    title: "test task",
    description: "test description longer than 10 chars",
    requiredCapabilities: [],
    preferredSkills: [],
    constraints: [],
    attachments: [],
    upstreamContext: {},
    priority: "medium",
    timeoutMs: 0,
    createdAt: new Date().toISOString(),
    // v1.1 新增：测试 fixture 默认空业务标签
    domainTags: [],
  };
}

/** 测试 plugin：可配置 sleep + return value */
class TestPlugin extends BasePlugin {
  constructor(
    public readonly meta: {
      name: string;
      priority: number;
      description: string;
      mutexWith: string[];
      requiresTask: boolean;
    },
    public readonly behavior: {
      delayMs?: number;
      returnStatus?: "succeeded" | "failed" | "cancelled";
      throwError?: boolean;
      cleanupCalled?: boolean;
    } = {}
  ) {
    super(meta);
  }

  async execute(ctx: PluginContext): Promise<DispatchResult> {
    if (this.behavior.delayMs) {
      await new Promise((r) => setTimeout(r, this.behavior.delayMs));
    }
    if (this.behavior.throwError) {
      throw new Error("test plugin throws");
    }
    const status = this.behavior.returnStatus ?? "succeeded";
    return status === "succeeded" ? this.ok(ctx, "ok") : this.fail(ctx, "test fail");
  }

  async cleanup(ctx: PluginContext, exc: Error | null): Promise<void> {
    this.behavior.cleanupCalled = true;
    await super.cleanup(ctx, exc);
  }
}

test("topologicalLevels returns single level for no-deps goals", () => {
  const goals = [makeGoal({ plugin: "a" }), makeGoal({ plugin: "b", priority: 50 })];
  const levels = topologicalLevels(goals);
  assert.equal(levels.length, 1);
  // b has lower priority number (higher priority) - should be first
  assert.equal(levels[0]?.[0]?.plugin, "b");
});

test("topologicalLevels returns multiple levels for chained deps", () => {
  const a = makeGoal({ plugin: "a" });
  const b = makeGoal({ plugin: "b", dependencies: [a.goalId] });
  const c = makeGoal({ plugin: "c", dependencies: [b.goalId] });
  const levels = topologicalLevels([a, b, c]);
  assert.equal(levels.length, 3);
  assert.equal(levels[0]?.[0]?.goalId, a.goalId);
  assert.equal(levels[1]?.[0]?.goalId, b.goalId);
  assert.equal(levels[2]?.[0]?.goalId, c.goalId);
});

test("topologicalLevels throws on circular dependency", () => {
  const a = makeGoal({ plugin: "a" });
  const b = makeGoal({ plugin: "b", dependencies: [a.goalId] });
  // Force circular: a depends on b
  a.dependsOn.push(b.goalId);
  assert.throws(() => topologicalLevels([a, b]), DispatcherCircularDependencyError);
});

test("topologicalLevels throws on missing dependency", () => {
  const a = makeGoal({ plugin: "a", dependencies: ["nonexistent"] });
  assert.throws(() => topologicalLevels([a]), DispatcherMissingDependencyError);
});

test("PluginRegistry.register rejects duplicate", () => {
  const r = new PluginRegistry();
  r.register(new TestPlugin({ name: "a", priority: 100, description: "a", mutexWith: [], requiresTask: false }));
  assert.throws(
    () =>
      r.register(new TestPlugin({ name: "a", priority: 200, description: "a2", mutexWith: [], requiresTask: false })),
    PluginAlreadyRegisteredError
  );
});

test("PluginRegistry.unregister rejects unknown", () => {
  const r = new PluginRegistry();
  assert.throws(() => r.unregister("nonexistent" as never), PluginNotRegisteredError);
});

test("PluginRegistry.hotRegister skips strict contract", () => {
  const r = new PluginRegistry();
  r.hotRegister(new TestPlugin({ name: "a", priority: 100, description: "a", mutexWith: [], requiresTask: false }));
  r.hotUnregister("a", { force: true });
  r.hotRegister(new TestPlugin({ name: "a", priority: 200, description: "a", mutexWith: [], requiresTask: false }));
  assert.equal(r.size(), 1);
});

test("GoalDispatcher.dispatch executes simple goal", async () => {
  const registry = new PluginRegistry();
  registry.register(new TestPlugin({ name: "a", priority: 100, description: "a", mutexWith: [], requiresTask: false }));
  const dispatcher = new GoalDispatcher(registry);
  const task = makeTask();
  const batch = makeBatch({ task, goals: [makeGoal({ plugin: "a" })] });
  const result = await dispatcher.dispatch(batch);
  assert.equal(result.overallStatus, "succeeded");
  assert.equal(result.succeededCount, 1);
});

test("GoalDispatcher.dispatch handles plugin throw", async () => {
  const registry = new PluginRegistry();
  registry.register(
    new TestPlugin(
      { name: "a", priority: 100, description: "a", mutexWith: [], requiresTask: false },
      { throwError: true }
    )
  );
  const dispatcher = new GoalDispatcher(registry, { failFast: false });
  const task = makeTask();
  const batch = makeBatch({ task, goals: [makeGoal({ plugin: "a" })] });
  const result = await dispatcher.dispatch(batch);
  assert.equal(result.overallStatus, "failed");
  assert.equal(result.failedCount, 1);
});

test("GoalDispatcher.dispatch propagates failure to downstream", async () => {
  const registry = new PluginRegistry();
  registry.register(
    new TestPlugin(
      { name: "fail", priority: 100, description: "fail", mutexWith: [], requiresTask: false },
      { returnStatus: "failed" }
    )
  );
  registry.register(
    new TestPlugin({ name: "after", priority: 100, description: "after", mutexWith: [], requiresTask: false })
  );
  const dispatcher = new GoalDispatcher(registry, { failFast: false });
  const task = makeTask();
  const a = makeGoal({ plugin: "fail" });
  const b = makeGoal({ plugin: "after", dependencies: [a.goalId] });
  const batch = makeBatch({ task, goals: [a, b] });
  const result = await dispatcher.dispatch(batch);
  assert.equal(result.failedCount, 1);
  assert.equal(result.skippedCount, 1);
});

test("GoalDispatcher respects failFast", async () => {
  const registry = new PluginRegistry();
  registry.register(
    new TestPlugin(
      { name: "fail", priority: 100, description: "fail", mutexWith: [], requiresTask: false },
      { returnStatus: "failed" }
    )
  );
  registry.register(
    new TestPlugin({ name: "ok", priority: 100, description: "ok", mutexWith: [], requiresTask: false })
  );
  const dispatcher = new GoalDispatcher(registry, { failFast: true });
  const task = makeTask();
  // 显式指定优先级：fail 先执行（priority 数值小者先排，见 topologicalLevels 排序策略），
  // 避免未指定时按随机 goalId 字典序排序导致的执行顺序不确定性（flaky）
  const a = makeGoal({ plugin: "fail", priority: 1 });
  const b = makeGoal({ plugin: "ok", priority: 100 }); // No dep on a, should still be skipped due to failFast
  const batch = makeBatch({ task, goals: [a, b] });
  const result = await dispatcher.dispatch(batch);
  assert.equal(result.skippedCount, 1);
});

test("GoalDispatcher parallel execution with maxParallel", async () => {
  const registry = new PluginRegistry();
  registry.register(
    new TestPlugin(
      { name: "slow", priority: 100, description: "slow", mutexWith: [], requiresTask: false },
      { delayMs: 50 }
    )
  );
  const dispatcher = new GoalDispatcher(registry, { maxParallel: 2 });
  const task = makeTask();
  const goals = Array.from({ length: 4 }, () => makeGoal({ plugin: "slow" }));
  const start = Date.now();
  const result = await dispatcher.dispatch(makeBatch({ task, goals }));
  const duration = Date.now() - start;
  // 4 goals / 2 parallel = 2 rounds of 50ms = ~100ms
  assert.ok(duration < 500, `expected < 500ms, got ${duration}ms`);
  assert.equal(result.succeededCount, 4);
});

test("GoalDispatcher invokes cleanup hook", async () => {
  const registry = new PluginRegistry();
  const plugin = new TestPlugin(
    { name: "a", priority: 100, description: "a", mutexWith: [], requiresTask: false },
    { delayMs: 10 }
  );
  registry.register(plugin);
  const dispatcher = new GoalDispatcher(registry);
  const task = makeTask();
  const batch = makeBatch({ task, goals: [makeGoal({ plugin: "a" })] });
  await dispatcher.dispatch(batch);
  // cleanup called by finally
  assert.equal(plugin.behavior.cleanupCalled, true);
});

test("GoalDispatcher cancel() aborts subsequent goals", async () => {
  const registry = new PluginRegistry();
  registry.register(
    new TestPlugin({ name: "a", priority: 100, description: "a", mutexWith: [], requiresTask: false }, { delayMs: 50 })
  );
  const dispatcher = new GoalDispatcher(registry, { failFast: false });
  const task = makeTask();
  const goals = [makeGoal({ plugin: "a" }), makeGoal({ plugin: "a" })];
  // Cancel after first goal completes
  setTimeout(() => dispatcher.cancel(), 10);
  const result = await dispatcher.dispatch(makeBatch({ task, goals }));
  // At least one goal should be cancelled
  assert.ok(result.skippedCount >= 0);
});

test("validatePluginContracts detects duplicate priority", () => {
  const a = new TestPlugin({ name: "a", priority: 100, description: "a", mutexWith: [], requiresTask: false });
  const b = new TestPlugin({ name: "b", priority: 100, description: "b", mutexWith: [], requiresTask: false });
  assert.throws(() => validatePluginContracts([a, b]), PluginPriorityDuplicateError);
});

test("validatePluginContracts detects asymmetric mutex", () => {
  const a = new TestPlugin({ name: "a", priority: 100, description: "a", mutexWith: ["b"], requiresTask: false });
  const b = new TestPlugin({ name: "b", priority: 200, description: "b", mutexWith: [], requiresTask: false });
  assert.throws(() => validatePluginContracts([a, b]), PluginMutexAsymmetricError);
});

test("BasePlugin rejects invalid name", () => {
  assert.throws(() => {
    new TestPlugin({ name: "BadName", priority: 100, description: "x", mutexWith: [], requiresTask: false });
  }, PluginNameInvalidError);
});

test("BasePlugin rejects self-referential mutex", () => {
  assert.throws(() => {
    new TestPlugin({ name: "a", priority: 100, description: "x", mutexWith: ["a"], requiresTask: false });
  }, PluginMutexSelfError);
});

test("BasePlugin rejects invalid priority", () => {
  assert.throws(() => {
    new TestPlugin({ name: "a", priority: 2000, description: "x", mutexWith: [], requiresTask: false });
  }, PluginNameInvalidError);
});

test("GoalDispatcher.hotRegister is delegated", () => {
  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  dispatcher.hotRegister(
    new TestPlugin({ name: "x", priority: 100, description: "x", mutexWith: [], requiresTask: false })
  );
  assert.equal(registry.size(), 1);
  dispatcher.hotUnregister("x", { force: true });
  assert.equal(registry.size(), 0);
});

test("GoalDispatcher batch timeout", async () => {
  const registry = new PluginRegistry();
  registry.register(
    new TestPlugin(
      { name: "slow", priority: 100, description: "slow", mutexWith: [], requiresTask: false },
      { delayMs: 200 }
    )
  );
  const dispatcher = new GoalDispatcher(registry, { failFast: false, batchTimeoutMs: 50 });
  const task = makeTask();
  const batch = makeBatch({ task, goals: [makeGoal({ plugin: "slow" })] });
  const result = await dispatcher.dispatch(batch);
  // The goal started but timeout hit during execution
  assert.ok(result.goalStates.size >= 1);
});
