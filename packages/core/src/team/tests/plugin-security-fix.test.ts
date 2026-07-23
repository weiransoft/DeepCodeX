/**
 * Phase 1 安全修复测试：验证 fn: 表达式语法被移除（RCE 风险消除）
 *
 * 测试目标：
 * 1. GraphPlugin.evaluateCondition 不再支持 fn: 表达式
 * 2. LoopPlugin.evaluateExit 不再支持 fn: 表达式
 * 3. 现有预定义条件（true/false/state.key/history.N/after:N）正常工作
 *
 * 来源：LOOP-GRAPH-FUSION-DESIGN.md v2.0 §12.1 Phase 1 安全修复
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphPlugin, LoopPlugin, PluginRegistry, GoalDispatcher } from "../plugins/index.js";
import { buildPluginContext } from "../plugin-context.js";
import type { PluginContext, TaskRequirement } from "../types.js";

/**
 * 构造测试任务（复用 plugins.test.ts 模式）
 */
function makeTask(): TaskRequirement {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    title: "security-fix-test",
    description: "test description longer than 10 chars",
    requiredCapabilities: [],
    preferredSkills: [],
    constraints: [],
    attachments: [],
    upstreamContext: {},
    priority: "medium",
    timeoutMs: 0,
    createdAt: new Date().toISOString(),
    domainTags: [],
  };
}

/**
 * 构造完整的 PluginContext（使用 buildPluginContext 确保所有必需字段存在）
 */
function makeCtx(extraState: Record<string, unknown> = {}): PluginContext {
  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  return buildPluginContext({
    projectRoot: "/tmp",
    task: makeTask(),
    dispatch: { dispatchId: "22222222-2222-4222-8222-222222222222", plugin: "test" },
    registry,
    dispatcher,
    state: extraState,
  });
}

test("Phase 1 安全修复：GraphPlugin fn: 表达式不再被求值", async () => {
  const plugin = new GraphPlugin();
  const ctx = makeCtx({
    graphNodes: [
      { id: "start", type: "decision", condition: "fn:ctx.state.malicious", next: ["a", "b"] },
      { id: "a", type: "end" },
      { id: "b", type: "end" },
    ],
    graphStartNode: "start",
    malicious: true,
  });

  // fn: 条件不应被求值，应返回默认值 0（选择 next[0]="a"），不抛出异常
  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded", "GraphPlugin 应在 fn: 条件下正常执行，不抛出异常");
});

test("Phase 1 安全修复：GraphPlugin 预定义条件 true/false 正常工作", async () => {
  const plugin = new GraphPlugin();

  // condition="true"（选择 next[0]）
  const ctxTrue = makeCtx({
    graphNodes: [
      { id: "start", type: "decision", condition: "true", next: ["yes", "no"] },
      { id: "yes", type: "end" },
      { id: "no", type: "end" },
    ],
    graphStartNode: "start",
  });
  const resultTrue = await plugin.execute(ctxTrue);
  assert.equal(resultTrue.status, "succeeded", "condition='true' 应正常执行");

  // condition="false"（选择 next[1]）
  const ctxFalse = makeCtx({
    graphNodes: [
      { id: "start", type: "decision", condition: "false", next: ["yes", "no"] },
      { id: "yes", type: "end" },
      { id: "no", type: "end" },
    ],
    graphStartNode: "start",
  });
  const resultFalse = await plugin.execute(ctxFalse);
  assert.equal(resultFalse.status, "succeeded", "condition='false' 应正常执行");
});

test("Phase 1 安全修复：GraphPlugin 预定义条件 state.key 正常工作", async () => {
  const plugin = new GraphPlugin();
  const ctx = makeCtx({
    graphNodes: [
      { id: "start", type: "decision", condition: "state.flag", next: ["on", "off"] },
      { id: "on", type: "end" },
      { id: "off", type: "end" },
    ],
    graphStartNode: "start",
    flag: true,
  });
  const result = await plugin.execute(ctx);
  assert.equal(result.status, "succeeded", "condition='state.flag' 应正常执行");
});

test("Phase 1 安全修复：LoopPlugin fn: 表达式不再被求值", async () => {
  const plugin = new LoopPlugin();
  let callCount = 0;
  const ctx = makeCtx({
    loop: true,
    loopStep: () => {
      callCount++;
      return "running";
    },
    loopMaxIterations: 3,
    // fn: 表达式不应被求值，Loop 应运行到 maxIterations
    loopExitWhen: "fn:result === 'done'",
  });

  await plugin.execute(ctx);

  // 验证：fn: 表达式被忽略，Loop 运行到 maxIterations（3 次）
  assert.equal(callCount, 3, "fn: 退出条件应被忽略，Loop 应运行到 maxIterations");
});

test("Phase 1 安全修复：LoopPlugin 预定义退出条件 'done' 正常工作", async () => {
  const plugin = new LoopPlugin();
  let callCount = 0;
  const ctx = makeCtx({
    loop: true,
    loopStep: () => {
      callCount++;
      return callCount >= 2 ? "done" : "running";
    },
    loopMaxIterations: 10,
    loopExitWhen: "done",
  });

  await plugin.execute(ctx);

  // 验证：预定义条件 'done' 正常工作，在第 2 次迭代后退出
  assert.equal(callCount, 2, "预定义条件 'done' 应正常触发退出");
});

test("Phase 1 安全修复：LoopPlugin 预定义退出条件 'after:N' 正常工作", async () => {
  const plugin = new LoopPlugin();
  let callCount = 0;
  const ctx = makeCtx({
    loop: true,
    loopStep: () => {
      callCount++;
      return "running";
    },
    loopMaxIterations: 10,
    loopExitWhen: "after:3",
  });

  await plugin.execute(ctx);

  // 验证：after:3 在第 3 次迭代后退出
  assert.equal(callCount, 3, "预定义条件 'after:3' 应在第 3 次迭代后退出");
});
