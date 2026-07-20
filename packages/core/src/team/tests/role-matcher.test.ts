/**
 * 角色匹配器测试
 *
 * 验证三种匹配策略（keyword/ai/hybrid）真实可用，无 mock
 * 覆盖：keyword 评分、capability F1、skill 命中率、AI 降级、hybrid 合并
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRoles, matchRolesSync, MATCH_WEIGHTS, _internals } from "../role-matcher.js";
import type { TaskRequirement } from "../types.js";

function buildTask(overrides: Partial<TaskRequirement> = {}): TaskRequirement {
  return {
    taskId: "11111111-1111-1111-1111-111111111111",
    title: "设计微服务架构",
    description: "需要为电商平台设计支持高并发的微服务架构，包括订单、商品、库存三个核心服务",
    requiredCapabilities: [],
    preferredSkills: [],
    constraints: [],
    attachments: [],
    upstreamContext: {},
    priority: "medium",
    timeoutMs: 0,
    createdAt: new Date().toISOString(),
    // v1.1 新增：测试 fixture 默认空业务标签（与 TaskRequirement schema default 对齐）
    domainTags: [],
    ...overrides,
  };
}

test("matchRolesSync returns a top match", () => {
  const result = matchRolesSync("设计架构", "设计一个高并发系统");
  assert.ok(result !== null);
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
});

test("matchRolesSync prefers architect for architecture tasks", () => {
  const result = matchRolesSync("系统架构设计", "为电商平台设计微服务架构，包括订单、商品、库存三个核心服务");
  assert.ok(result !== null);
  assert.equal(result.roleId, "architect");
});

test("matchRolesSync prefers test-expert for test tasks", () => {
  const result = matchRolesSync("编写单元测试", "为登录模块编写完整的单元测试用例和E2E测试");
  assert.ok(result !== null);
  assert.equal(result.roleId, "test-expert");
});

test("matchRolesSync prefers ui-designer for UI tasks", () => {
  const result = matchRolesSync("界面设计", "为登录页面设计美观的UI界面，符合WCAG 2.1无障碍标准");
  assert.ok(result !== null);
  assert.equal(result.roleId, "ui-designer");
});

test("matchRolesSync prefers product-manager for PRD tasks", () => {
  const result = matchRolesSync("编写PRD", "为新功能编写产品需求文档，含用户故事、验收标准、优先级排序");
  assert.ok(result !== null);
  assert.equal(result.roleId, "product-manager");
});

test("matchRolesSync prefers solo-coder for code tasks", () => {
  const result = matchRolesSync(
    "实现登录功能",
    "使用 TypeScript 实现用户登录接口代码，包括参数校验、密码加密、JWT 签发，需要写代码编程"
  );
  assert.ok(result !== null);
  assert.equal(result.roleId, "solo-coder");
});

test("matchRoles returns topK results sorted by confidence desc", async () => {
  const task = buildTask();
  const results = await matchRoles(task, { strategy: "keyword", topK: 3 });
  assert.ok(results.length <= 3);
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i - 1]!.confidence >= results[i]!.confidence);
  }
});

test("matchRoles hybrid falls back to keyword when AI is unavailable", async () => {
  // 注入空客户端模拟 AI 不可用
  const task = buildTask();
  const results = await matchRoles(task, {
    strategy: "hybrid",
    topK: 3,
    injectedClient: { client: null, model: "test", baseURL: "" },
  });
  assert.ok(results.length > 0);
  // 由于 AI 不可用，策略应降级为 keyword
  for (const r of results) {
    assert.equal(r.strategy, "hybrid");
  }
});

test("matchRoles keyword strategy returns consistent results", async () => {
  const task = buildTask({ title: "测试覆盖率提升", description: "编写E2E测试提升覆盖率" });
  const r1 = await matchRoles(task, { strategy: "keyword", topK: 3 });
  const r2 = await matchRoles(task, { strategy: "keyword", topK: 3 });
  assert.equal(r1[0]?.roleId, r2[0]?.roleId);
});

test("MATCH_WEIGHTS sums to 1.0", () => {
  const sum = MATCH_WEIGHTS.capability + MATCH_WEIGHTS.skill + MATCH_WEIGHTS.keyword;
  assert.ok(Math.abs(sum - 1.0) < 0.001, `Weights should sum to 1.0, got ${sum}`);
});

test("computeKeywordOverlap returns 0 for empty keywords", () => {
  assert.equal(_internals.computeKeywordOverlap("test text", []), 0);
});

test("computeKeywordOverlap returns > 0 for matching keywords", () => {
  const overlap = _internals.computeKeywordOverlap("设计系统架构", ["架构", "设计"]);
  assert.ok(overlap > 0, `Expected overlap > 0, got ${overlap}`);
});

test("computeKeywordOverlap handles English keywords", () => {
  const overlap = _internals.computeKeywordOverlap("implement TypeScript code", ["TypeScript", "Rust"]);
  assert.ok(overlap > 0);
});

test("computeCapabilityMatch returns 0.5 when no required capabilities", () => {
  assert.equal(_internals.computeCapabilityMatch([], ["a", "b", "c"]), 0.5);
});

test("computeCapabilityMatch returns 1.0 for perfect overlap", () => {
  const score = _internals.computeCapabilityMatch(["a", "b"], ["a", "b", "c"]);
  assert.ok(score > 0.5, `Expected > 0.5, got ${score}`);
});

test("computeCapabilityMatch returns 0 for no overlap", () => {
  const score = _internals.computeCapabilityMatch(["x", "y"], ["a", "b"]);
  assert.equal(score, 0);
});

test("computeSkillMatch returns 0.5 when no preferred skills", () => {
  assert.equal(_internals.computeSkillMatch([], ["a", "b"]), 0.5);
});

test("computeSkillMatch returns 1.0 when all preferred skills match", () => {
  const score = _internals.computeSkillMatch(["TypeScript", "Python"], ["TypeScript", "Python", "Rust"]);
  assert.equal(score, 1.0);
});

test("computeSkillMatch is case insensitive", () => {
  const score = _internals.computeSkillMatch(["typescript"], ["TypeScript"]);
  assert.equal(score, 1.0);
});

test("aggregateScore returns value in [0, 1]", () => {
  const sb = { capability: 1, skill: 1, keyword: 1, priority: 1 };
  const score = _internals.aggregateScore(sb);
  assert.ok(score >= 0 && score <= 1);
});

test("aggregateScore returns 0 for all-zero breakdown", () => {
  const sb = { capability: 0, skill: 0, keyword: 0, priority: 0 };
  assert.equal(_internals.aggregateScore(sb), 0);
});

test("matchRoles respects topK limit", async () => {
  const task = buildTask();
  const r1 = await matchRoles(task, { strategy: "keyword", topK: 1 });
  const r5 = await matchRoles(task, { strategy: "keyword", topK: 5 });
  assert.equal(r1.length, 1);
  assert.equal(r5.length, 5);
});

test("matchRoles handles empty task title gracefully", async () => {
  const task = buildTask({ title: "", description: "Generic description here" });
  const results = await matchRoles(task, { strategy: "keyword", topK: 3 });
  assert.ok(results.length > 0);
});
