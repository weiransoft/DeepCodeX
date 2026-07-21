/**
 * buildUserPromptFromTask 单元测试（P0-2 验证）
 *
 * 设计文档 §7.3：6 个测试用例（BP-001~BP-006）
 *   - BP-001: 基本字段渲染（title + description）
 *   - BP-002: constraints 渲染（3 个 constraints）
 *   - BP-003: attachments 渲染（2 个 attachments）
 *   - BP-004: upstreamContext 透传（含 autonomousStage）
 *   - BP-005: 空 upstreamContext（不渲染"上游上下文"段）
 *   - BP-006: 非字符串 upstreamContext 值（JSON.stringify）
 *
 * 验证 team-adapter.ts:616-650 buildUserPromptFromTask 函数
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTask } from "../team-adapter.js";
import { buildUserPromptFromTask } from "../team-adapter.js";

// ============================================================================
// BP-001~BP-006: buildUserPromptFromTask 测试
// ============================================================================

test("BP-001: 基本字段渲染（title + description）", () => {
  const task = buildTask({
    title: "测试任务标题",
    description: "测试任务描述",
  });

  const prompt = buildUserPromptFromTask(task);

  // 断言：输出包含 title 和 description
  assert.ok(prompt.includes("测试任务标题"), `prompt 应包含 title，实际: ${prompt}`);
  assert.ok(prompt.includes("测试任务描述"), `prompt 应包含 description，实际: ${prompt}`);
  // 断言：包含段标题
  assert.ok(prompt.includes("# 任务标题"), `prompt 应含 "# 任务标题"，实际: ${prompt}`);
  assert.ok(prompt.includes("# 任务描述"), `prompt 应含 "# 任务描述"，实际: ${prompt}`);
});

test("BP-002: constraints 渲染（3 个 constraints）", () => {
  const task = buildTask({
    title: "测试",
    description: "描述",
    constraints: ["约束1", "约束2", "约束3"],
  });

  const prompt = buildUserPromptFromTask(task);

  // 断言：输出包含所有 constraints 行
  assert.ok(prompt.includes("# 约束条件"), `prompt 应含 "# 约束条件"，实际: ${prompt}`);
  assert.ok(prompt.includes("- 约束1"), `prompt 应含 "- 约束1"，实际: ${prompt}`);
  assert.ok(prompt.includes("- 约束2"), `prompt 应含 "- 约束2"，实际: ${prompt}`);
  assert.ok(prompt.includes("- 约束3"), `prompt 应含 "- 约束3"，实际: ${prompt}`);
});

test("BP-003: attachments 渲染（2 个 attachments）", () => {
  const task = buildTask({
    title: "测试",
    description: "描述",
    attachments: ["file1.ts", "file2.ts"],
  });

  const prompt = buildUserPromptFromTask(task);

  // 断言：输出包含所有 attachments 行
  assert.ok(prompt.includes("# 附件"), `prompt 应含 "# 附件"，实际: ${prompt}`);
  assert.ok(prompt.includes("- file1.ts"), `prompt 应含 "- file1.ts"，实际: ${prompt}`);
  assert.ok(prompt.includes("- file2.ts"), `prompt 应含 "- file2.ts"，实际: ${prompt}`);
});

test("BP-004: upstreamContext 透传（含 autonomousStage）", () => {
  const task = buildTask({
    title: "测试",
    description: "描述",
    upstreamContext: {
      autonomousStage: "plan",
      autonomousIteration: 1,
      autonomousGoal: "实现登录",
    },
  });

  const prompt = buildUserPromptFromTask(task);

  // 断言：user prompt 包含 "autonomousStage"
  assert.ok(prompt.includes("# 上游上下文"), `prompt 应含 "# 上游上下文"，实际: ${prompt}`);
  assert.ok(prompt.includes("autonomousStage"), `prompt 应含 "autonomousStage"，实际: ${prompt}`);
  assert.ok(prompt.includes("plan"), `prompt 应含 "plan"，实际: ${prompt}`);
});

test('BP-005: 空 upstreamContext（不渲染"上游上下文"段）', () => {
  const task = buildTask({
    title: "测试",
    description: "描述",
    upstreamContext: {},
  });

  const prompt = buildUserPromptFromTask(task);

  // 断言：user prompt 不包含 "上游上下文" 段
  assert.ok(!prompt.includes("# 上游上下文"), `prompt 不应含 "# 上游上下文"，实际: ${prompt}`);
});

test("BP-006: 非字符串 upstreamContext 值（JSON.stringify）", () => {
  const task = buildTask({
    title: "测试",
    description: "描述",
    upstreamContext: {
      count: 42,
    },
  });

  const prompt = buildUserPromptFromTask(task);

  // 断言：非字符串值被 JSON.stringify
  assert.ok(prompt.includes("# 上游上下文"), `prompt 应含 "# 上游上下文"，实际: ${prompt}`);
  assert.ok(prompt.includes("count: 42"), `prompt 应含 "count: 42"，实际: ${prompt}`);
});
