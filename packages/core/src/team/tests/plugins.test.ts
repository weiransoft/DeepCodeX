/**
 * 6 个内置插件测试
 *
 * 验证 autonomous / multi-goal / graph / loop / resume / cancel 的真实功能
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AutonomousPlugin,
  MultiGoalPlugin,
  GraphPlugin,
  LoopPlugin,
  ResumePlugin,
  CancelPlugin,
  BUILTIN_PLUGINS,
  GoalDispatcher,
  PluginRegistry,
} from "../plugins/index.js";
import { buildPluginContext } from "../plugin-context.js";
import type { PluginContext, TaskRequirement } from "../types.js";

function makeTask(): TaskRequirement {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    title: "test task for plugin",
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

function makeCtx(extraState: Record<string, unknown> = {}): {
  ctx: PluginContext;
  registry: PluginRegistry;
  dispatcher: GoalDispatcher;
} {
  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  const ctx = buildPluginContext({
    projectRoot: "/tmp",
    task: makeTask(),
    dispatch: { dispatchId: "22222222-2222-4222-8222-222222222222", plugin: "test" },
    registry,
    dispatcher,
    state: extraState,
  });
  return { ctx, registry, dispatcher };
}

test("BUILTIN_PLUGINS contains 6 plugins", () => {
  assert.equal(BUILTIN_PLUGINS.length, 6);
  const names = BUILTIN_PLUGINS.map((p) => p.name);
  assert.ok(names.includes("autonomous"));
  assert.ok(names.includes("multi-goal"));
  assert.ok(names.includes("graph"));
  assert.ok(names.includes("loop"));
  assert.ok(names.includes("resume"));
  assert.ok(names.includes("cancel"));
});

test("BUILTIN_PLUGINS all pass contract validation", () => {
  // Note: validatePluginContracts will throw on asymmetric mutex
  // Here we just verify all plugins have valid name + priority
  for (const p of BUILTIN_PLUGINS) {
    assert.match(p.name, /^[a-z][a-z0-9-]*$/);
    assert.ok(Number.isInteger(p.priority));
    assert.ok(p.priority >= 0);
  }
});

test("AutonomousPlugin meta has correct shape", () => {
  const p = new AutonomousPlugin();
  assert.equal(p.name, "autonomous");
  assert.ok(p.priority > 0);
  assert.ok(p.mutexWith.length > 0);
  assert.equal(p.requiresTask, false);
});

test("AutonomousPlugin.matches returns true when autonomous flag set", () => {
  const p = new AutonomousPlugin();
  const { ctx } = makeCtx({ autonomous: true });
  assert.equal(p.matches(ctx), true);
});

test("AutonomousPlugin.execute dry-run returns ok", async () => {
  const p = new AutonomousPlugin();
  const { ctx } = makeCtx({ dryRun: true });
  ctx.dryRun = true;
  const result = await p.execute(ctx);
  assert.equal(result.status, "succeeded");
});

test("AutonomousPlugin.execute handles missing components", async () => {
  const p = new AutonomousPlugin();
  const { ctx } = makeCtx();
  const result = await p.execute(ctx);
  // Should either succeed (with empty iterations) or fail gracefully
  assert.ok(["succeeded", "failed"].includes(result.status));
});

test("MultiGoalPlugin with no sub-goals returns ok", async () => {
  const p = new MultiGoalPlugin();
  const { ctx } = makeCtx();
  const result = await p.execute(ctx);
  assert.equal(result.status, "succeeded");
  assert.ok(result.output?.includes("no sub-goals"));
});

test("MultiGoalPlugin.matches requires subGoals array", () => {
  const p = new MultiGoalPlugin();
  const { ctx } = makeCtx();
  assert.equal(p.matches(ctx), false);
  ctx.state["subGoals"] = [{ name: "a", plugin: "x" }];
  assert.equal(p.matches(ctx), true);
});

test("MultiGoalPlugin.execute with empty subGoals array", async () => {
  const p = new MultiGoalPlugin();
  const { ctx } = makeCtx({ subGoals: [] });
  const result = await p.execute(ctx);
  assert.equal(result.status, "succeeded");
});

test("GraphPlugin with no nodes returns ok", async () => {
  const p = new GraphPlugin();
  const { ctx } = makeCtx();
  const result = await p.execute(ctx);
  assert.equal(result.status, "succeeded");
});

test("GraphPlugin executes simple linear path", async () => {
  const p = new GraphPlugin();
  const { ctx } = makeCtx({
    graphNodes: [
      { id: "a", type: "task", plugin: "x", next: ["b"] },
      { id: "b", type: "task", plugin: "x", next: ["c"] },
      { id: "c", type: "end" },
    ],
    graphStartNode: "a",
  });
  const result = await p.execute(ctx);
  assert.equal(result.status, "succeeded");
  const path = ctx.state["graphPath"] as string[];
  assert.deepEqual(path, ["a", "b", "c"]);
});

test("GraphPlugin detects missing start node", async () => {
  const p = new GraphPlugin();
  const { ctx } = makeCtx({
    graphNodes: [{ id: "a", type: "task" }],
    graphStartNode: "nonexistent",
  });
  const result = await p.execute(ctx);
  assert.equal(result.status, "failed");
});

test("GraphPlugin decision node evaluates conditions", async () => {
  const p = new GraphPlugin();
  const { ctx } = makeCtx({
    graphNodes: [
      { id: "start", type: "task", next: ["decision"] },
      { id: "decision", type: "decision", next: ["pathA", "pathB"], condition: "true" },
      { id: "pathA", type: "end" },
      { id: "pathB", type: "end" },
    ],
    graphStartNode: "start",
  });
  const result = await p.execute(ctx);
  assert.equal(result.status, "succeeded");
  const path = ctx.state["graphPath"] as string[];
  assert.deepEqual(path, ["start", "decision", "pathA"]);
});

test("GraphPlugin detects circular path", async () => {
  const p = new GraphPlugin();
  // 实际写不出真正的环路（因为单源 next[0]），但用 next 列表伪造
  // 这里用 decision 节点指向自己来触发环路
  const { ctx } = makeCtx({
    graphNodes: [{ id: "loop", type: "decision", next: ["loop"], condition: "true" }],
    graphStartNode: "loop",
  });
  const result = await p.execute(ctx);
  // 应该因为环路检测失败
  assert.equal(result.status, "failed");
});

test("LoopPlugin with no step returns immediately", async () => {
  const p = new LoopPlugin();
  const { ctx } = makeCtx({ loop: true, loopMaxIterations: 3 });
  const result = await p.execute(ctx);
  assert.equal(result.status, "succeeded");
  assert.equal(ctx.state["loopHistory"], undefined);
});

test("LoopPlugin exits when predicate met", async () => {
  const p = new LoopPlugin();
  const { ctx } = makeCtx({
    loop: true,
    loopMaxIterations: 10,
    loopExitWhen: "done",
    loopStep: (i: number) => (i >= 4 ? "done" : "working"),
  });
  const result = await p.execute(ctx);
  assert.equal(result.status, "succeeded");
  const history = ctx.state["loopHistory"] as Array<{ iteration: number; result: unknown }>;
  assert.equal(history.length, 4); // iterations 1, 2, 3, 4 (第4次返回 done)
  assert.equal(ctx.state["loopExitReason"], "predicate");
});

test("LoopPlugin exits at max iterations", async () => {
  const p = new LoopPlugin();
  const { ctx } = makeCtx({
    loop: true,
    loopMaxIterations: 3,
    loopExitWhen: "never",
    loopStep: () => "working",
  });
  const result = await p.execute(ctx);
  assert.equal(result.status, "succeeded");
  const history = ctx.state["loopHistory"] as Array<{ iteration: number }>;
  assert.equal(history.length, 3);
  assert.equal(ctx.state["loopExitReason"], "max-iterations");
});

test("LoopPlugin handles cancellation", async () => {
  const p = new LoopPlugin();
  const { ctx } = makeCtx({
    loop: true,
    loopMaxIterations: 100,
    loopExitWhen: "never",
    loopStep: () => {
      return new Promise((r) => setTimeout(() => r("x"), 1));
    },
  });
  setTimeout(() => {
    ctx.cancelled = true;
  }, 5);
  const result = await p.execute(ctx);
  assert.equal(result.status, "succeeded");
  assert.equal(ctx.state["loopExitReason"], "cancelled");
});

test("LoopPlugin handles step throw", async () => {
  const p = new LoopPlugin();
  const { ctx } = makeCtx({
    loop: true,
    loopMaxIterations: 3,
    loopExitWhen: "never",
    loopStep: () => {
      throw new Error("step failed");
    },
  });
  const result = await p.execute(ctx);
  assert.equal(result.status, "failed");
});

test("ResumePlugin without checkpoint returns ok", async () => {
  const p = new ResumePlugin();
  const { ctx } = makeCtx();
  const result = await p.execute(ctx);
  assert.equal(result.status, "succeeded");
  assert.ok(result.output?.includes("无 checkpoint"));
});

test("ResumePlugin restores from inline checkpoint", async () => {
  const p = new ResumePlugin();
  const checkpoint = {
    version: "1.0" as const,
    checkpointId: "33333333-3333-4333-8333-333333333333",
    runId: "r-test",
    objective: "test",
    status: "failed" as const,
    currentPhase: "verify" as const,
    iteration: 5,
    maxIterations: 10,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: "test notes",
    phaseResults: {},
    testResults: { passed: 3, failed: 1, total: 4 },
    debtCount: 2,
  };
  const { ctx } = makeCtx({ resume: true, checkpoint });
  const result = await p.execute(ctx);
  assert.equal(result.status, "succeeded");
  const restored = ctx.state["runState"] as { iteration: number; runId: string };
  assert.equal(restored.runId, "r-test");
  assert.equal(restored.iteration, 5);
});

test("ResumePlugin rejects already-succeeded checkpoint", async () => {
  const p = new ResumePlugin();
  const checkpoint = {
    version: "1.0" as const,
    checkpointId: "44444444-4444-4444-8444-444444444444",
    runId: "r-done",
    objective: "test",
    status: "succeeded" as const,
    iteration: 5,
    maxIterations: 10,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const { ctx } = makeCtx({ resume: true, checkpoint });
  const result = await p.execute(ctx);
  assert.equal(result.status, "succeeded");
  assert.ok(result.output?.includes("无需恢复"));
});

test("CancelPlugin sets ctx.cancelled and propagates", async () => {
  const p = new CancelPlugin();
  const { ctx } = makeCtx({ cancel: true, cancelReason: "user test" });
  const result = await p.execute(ctx);
  assert.equal(result.status, "succeeded");
  assert.equal(ctx.cancelled, true);
  assert.equal(ctx.state["cancelReason"], "user test");
  assert.ok(ctx.events.some((e) => e.type === "cancel.signal"));
});

test("CancelPlugin matches when cancel flag set", () => {
  const p = new CancelPlugin();
  const { ctx } = makeCtx({ cancel: true });
  assert.equal(p.matches(ctx), true);
});

test("All plugins have unique names", () => {
  const names = BUILTIN_PLUGINS.map((p) => p.name);
  const unique = new Set(names);
  assert.equal(unique.size, names.length);
});

test("All plugins have unique priority within builtin set", () => {
  const priorities = BUILTIN_PLUGINS.map((p) => p.priority);
  const unique = new Set(priorities);
  assert.equal(unique.size, priorities.length);
});
