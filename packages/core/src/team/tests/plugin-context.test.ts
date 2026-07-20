/**
 * PluginContext 测试
 *
 * 验证 plugin-context.ts 的工厂函数、辅助方法和状态隔离
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPluginContext,
  ctxInfo,
  ctxWarn,
  ctxError,
  ctxCritical,
  ctxDebug,
  emitEvent,
  getState,
  setState,
  isTimedOut,
  elapsedMs,
  toDispatchResult,
  guardDryRun,
  isCancelled,
  clonePluginContext,
} from "../plugin-context.js";
import { GoalDispatcher, PluginRegistry } from "../plugins/goal-dispatcher.js";
import type { TaskRequirement } from "../types.js";

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

function makeRegistry(): PluginRegistry {
  return new PluginRegistry();
}

function makeDispatcher(registry: PluginRegistry): GoalDispatcher {
  return new GoalDispatcher(registry);
}

test("buildPluginContext sets all required fields", () => {
  const registry = makeRegistry();
  const dispatcher = makeDispatcher(registry);
  const task = makeTask();
  const ctx = buildPluginContext({
    projectRoot: "/tmp/proj",
    task,
    dispatch: { dispatchId: "22222222-2222-4222-8222-222222222222", plugin: "test" },
    registry,
    dispatcher,
  });
  assert.equal(ctx.projectRoot, "/tmp/proj");
  assert.equal(ctx.dryRun, false);
  assert.equal(ctx.cancelled, false);
  assert.ok(Array.isArray(ctx.events));
  assert.ok(typeof ctx.state === "object");
  assert.equal(ctx.dispatch.plugin, "test");
  assert.equal(ctx.startTime > 0, true);
});

test("buildPluginContext throws on missing projectRoot", () => {
  const registry = makeRegistry();
  const dispatcher = makeDispatcher(registry);
  assert.throws(() =>
    buildPluginContext({
      projectRoot: "",
      task: makeTask(),
      dispatch: { dispatchId: "x", plugin: "y" },
      registry,
      dispatcher,
    })
  );
});

test("buildPluginContext throws on missing registry", () => {
  const dispatcher = makeDispatcher(new PluginRegistry());
  assert.throws(() =>
    buildPluginContext({
      projectRoot: "/x",
      task: makeTask(),
      dispatch: { dispatchId: "x", plugin: "y" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registry: null as any,
      dispatcher,
    })
  );
});

test("ctxInfo/ctxWarn/ctxError/ctxCritical/ctxDebug push events", () => {
  const registry = makeRegistry();
  const dispatcher = makeDispatcher(registry);
  const ctx = buildPluginContext({
    projectRoot: "/x",
    task: makeTask(),
    dispatch: { dispatchId: "x", plugin: "y" },
    registry,
    dispatcher,
  });
  ctxInfo(ctx, "info msg");
  ctxWarn(ctx, "warn msg");
  ctxError(ctx, "err msg");
  ctxCritical(ctx, "crit msg");
  ctxDebug(ctx, "dbg msg");
  // 默认 log 写入 ctx.events，至少 5 条
  assert.ok(ctx.events.length >= 5);
});

test("emitEvent attaches source and dispatchId", () => {
  const registry = makeRegistry();
  const dispatcher = makeDispatcher(registry);
  const ctx = buildPluginContext({
    projectRoot: "/x",
    task: makeTask(),
    dispatch: { dispatchId: "d-1", plugin: "p" },
    registry,
    dispatcher,
  });
  emitEvent(ctx, "custom.event", { data: 1 });
  const last = ctx.events[ctx.events.length - 1];
  assert.equal(last?.type, "custom.event");
  assert.equal(last?.source, "p");
  assert.equal(last?.dispatchId, "d-1");
});

test("getState/setState work on ctx.state", () => {
  const registry = makeRegistry();
  const dispatcher = makeDispatcher(registry);
  const ctx = buildPluginContext({
    projectRoot: "/x",
    task: makeTask(),
    dispatch: { dispatchId: "x", plugin: "y" },
    registry,
    dispatcher,
    state: { existing: 1 },
  });
  assert.equal(getState<number>(ctx, "existing"), 1);
  setState(ctx, "added", "value");
  assert.equal(getState<string>(ctx, "added"), "value");
});

test("isTimedOut returns false when no deadline", () => {
  const registry = makeRegistry();
  const dispatcher = makeDispatcher(registry);
  const ctx = buildPluginContext({
    projectRoot: "/x",
    task: makeTask(),
    dispatch: { dispatchId: "x", plugin: "y" },
    registry,
    dispatcher,
  });
  assert.equal(isTimedOut(ctx), false);
});

test("isTimedOut returns true when past deadline", () => {
  const registry = makeRegistry();
  const dispatcher = makeDispatcher(registry);
  const ctx = buildPluginContext({
    projectRoot: "/x",
    task: makeTask(),
    dispatch: { dispatchId: "x", plugin: "y" },
    registry,
    dispatcher,
    deadlineMs: Date.now() - 1000, // 已过期
  });
  assert.equal(isTimedOut(ctx), true);
});

test("elapsedMs returns positive number", async () => {
  const registry = makeRegistry();
  const dispatcher = makeDispatcher(registry);
  const ctx = buildPluginContext({
    projectRoot: "/x",
    task: makeTask(),
    dispatch: { dispatchId: "x", plugin: "y" },
    registry,
    dispatcher,
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(elapsedMs(ctx) >= 10);
});

test("toDispatchResult creates standard result", () => {
  const registry = makeRegistry();
  const dispatcher = makeDispatcher(registry);
  const task = makeTask();
  const ctx = buildPluginContext({
    projectRoot: "/x",
    task,
    dispatch: { dispatchId: "d-1", plugin: "p" },
    registry,
    dispatcher,
  });
  const r = toDispatchResult(ctx, "succeeded", { output: "ok", artifacts: ["a.txt"] });
  assert.equal(r.status, "succeeded");
  assert.equal(r.output, "ok");
  assert.deepEqual(r.artifacts, ["a.txt"]);
  assert.equal(r.taskId, task.taskId);
  assert.equal(r.dispatchId, "d-1");
});

test("guardDryRun returns true in dryRun mode", () => {
  const registry = makeRegistry();
  const dispatcher = makeDispatcher(registry);
  const ctx = buildPluginContext({
    projectRoot: "/x",
    task: makeTask(),
    dispatch: { dispatchId: "x", plugin: "y" },
    registry,
    dispatcher,
    dryRun: true,
  });
  assert.equal(guardDryRun(ctx, "write file"), true);
});

test("guardDryRun returns false in normal mode", () => {
  const registry = makeRegistry();
  const dispatcher = makeDispatcher(registry);
  const ctx = buildPluginContext({
    projectRoot: "/x",
    task: makeTask(),
    dispatch: { dispatchId: "x", plugin: "y" },
    registry,
    dispatcher,
  });
  assert.equal(guardDryRun(ctx, "write file"), false);
});

test("isCancelled reads ctx.cancelled", () => {
  const registry = makeRegistry();
  const dispatcher = makeDispatcher(registry);
  const ctx = buildPluginContext({
    projectRoot: "/x",
    task: makeTask(),
    dispatch: { dispatchId: "x", plugin: "y" },
    registry,
    dispatcher,
  });
  assert.equal(isCancelled(ctx), false);
  ctx.cancelled = true;
  assert.equal(isCancelled(ctx), true);
});

test("clonePluginContext produces independent state", () => {
  const registry = makeRegistry();
  const dispatcher = makeDispatcher(registry);
  const task = makeTask();
  const ctx = buildPluginContext({
    projectRoot: "/x",
    task,
    dispatch: { dispatchId: "x", plugin: "y" },
    registry,
    dispatcher,
    state: { k: "v" },
  });
  const cloned = clonePluginContext(ctx);
  setState(cloned, "k", "modified");
  assert.equal(getState<string>(ctx, "k"), "v");
  assert.equal(getState<string>(cloned, "k"), "modified");
});

test("custom log function is called instead of default", () => {
  const registry = makeRegistry();
  const dispatcher = makeDispatcher(registry);
  const calls: string[] = [];
  const ctx = buildPluginContext({
    projectRoot: "/x",
    task: makeTask(),
    dispatch: { dispatchId: "x", plugin: "y" },
    registry,
    dispatcher,
    log: (msg, level) => {
      calls.push(`${level}:${msg}`);
    },
  });
  ctxInfo(ctx, "hello");
  assert.deepEqual(calls, ["INFO:hello"]);
});
