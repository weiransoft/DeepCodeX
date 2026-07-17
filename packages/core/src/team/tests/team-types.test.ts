/**
 * Team 模块类型测试
 *
 * 验证 types.ts 的 zod schema 严格性，确保 P0 类型定义无简化
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RoleId,
  RoleDefinition,
  TaskRequirement,
  MatchResult,
  DispatchResult,
  TeamConfig,
  ALL_SCHEMAS,
} from "../types.js";

test("RoleId accepts 5 valid role ids", () => {
  const validIds = ["architect", "product-manager", "solo-coder", "test-expert", "ui-designer"];
  for (const id of validIds) {
    assert.equal(RoleId.parse(id), id);
  }
});

test("RoleId rejects unknown role id", () => {
  assert.throws(() => RoleId.parse("invalid-role"));
});

test("RoleDefinition requires min 3 capabilities and skills", () => {
  const baseDef = {
    roleId: "architect" as const,
    name: "架构师",
    nameEn: "Architect",
    description: "负责系统架构设计相关工作",
    systemPromptPrefix: "x".repeat(60),
    systemPromptSuffix: "",
    capabilities: ["ab", "bc", "cd"],
    skills: ["xx", "yy", "zz"],
    keywords: ["k1", "k2", "k3"],
    priority: 5,
    metadata: {
      color: "#0d47a1",
      icon: "🏛️",
      outputFormat: "markdown" as const,
      enabledByDefault: true,
    },
  };
  assert.deepEqual(RoleDefinition.parse(baseDef).roleId, "architect");

  // 缺少能力
  const invalid = { ...baseDef, capabilities: ["a"] };
  assert.throws(() => RoleDefinition.parse(invalid));
});

test("TaskRequirement rejects missing required fields", () => {
  assert.throws(() => TaskRequirement.parse({}));
  assert.throws(() => TaskRequirement.parse({ title: "t" }));
});

test("TaskRequirement accepts complete task", () => {
  const task = {
    taskId: "12345678-1234-4123-8123-123456789012",
    title: "Test task",
    description: "Test description longer than 10 chars",
    requiredCapabilities: [],
    preferredSkills: [],
    constraints: [],
    attachments: [],
    upstreamContext: {},
    priority: "medium" as const,
    timeoutMs: 0,
    createdAt: new Date().toISOString(),
  };
  const parsed = TaskRequirement.parse(task);
  assert.equal(parsed.priority, "medium");
});

test("MatchResult requires reasons min length 1", () => {
  const baseMatch = {
    roleId: "solo-coder" as const,
    roleName: "独立开发者",
    confidence: 0.8,
    matchedCapabilities: ["code-implementation"],
    matchedSkills: ["TypeScript"],
    missingCapabilities: [],
    reasons: ["test reason"],
    scoreBreakdown: {
      capability: 0.8,
      skill: 0.7,
      keyword: 0.6,
      priority: 0.8,
    },
    strategy: "keyword" as const,
  };
  const parsed = MatchResult.parse(baseMatch);
  assert.equal(parsed.confidence, 0.8);

  // 缺少 reasons
  const invalid = { ...baseMatch, reasons: [] };
  assert.throws(() => MatchResult.parse(invalid));
});

test("MatchResult rejects confidence > 1", () => {
  const baseMatch = {
    roleId: "solo-coder" as const,
    roleName: "独立开发者",
    confidence: 1.5, // 越界
    matchedCapabilities: [],
    matchedSkills: [],
    missingCapabilities: [],
    reasons: ["test"],
    scoreBreakdown: { capability: 0, skill: 0, keyword: 0, priority: 0 },
    strategy: "keyword" as const,
  };
  assert.throws(() => MatchResult.parse(baseMatch));
});

test("DispatchResult accepts all 8 status", () => {
  const statuses = ["pending", "running", "succeeded", "failed", "timeout", "cancelled", "paused", "retrying"];
  for (const status of statuses) {
    const base = {
      taskId: "12345678-1234-4123-8123-123456789012",
      dispatchId: "23456789-2345-4234-8234-234567890123",
      matchedRole: {
        roleId: "solo-coder" as const,
        roleName: "独立开发者",
        confidence: 0.8,
        matchedCapabilities: [],
        matchedSkills: [],
        missingCapabilities: [],
        reasons: ["r"],
        scoreBreakdown: { capability: 0, skill: 0, keyword: 0, priority: 0 },
        strategy: "keyword" as const,
      },
      status,
      startedAt: new Date().toISOString(),
      durationMs: 100,
      artifacts: [],
      tokensConsumed: { prompt: 0, completion: 0, total: 0 },
      cacheHit: false,
      retryCount: 0,
    };
    const parsed = DispatchResult.parse(base);
    assert.equal(parsed.status, status);
  }
});

test("TeamConfig applies defaults when empty", () => {
  const parsed = TeamConfig.parse({});
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.matchStrategy, "hybrid");
  assert.equal(parsed.topK, 3);
  assert.equal(parsed.defaultRole, "solo-coder");
  assert.equal(parsed.ponytailMode, "full");
});

test("TeamConfig ponytailMode only accepts literal 'full'", () => {
  const parsed = TeamConfig.parse({ ponytailMode: "full" });
  assert.equal(parsed.ponytailMode, "full");
  assert.throws(() => TeamConfig.parse({ ponytailMode: "lite" }));
});

test("ALL_SCHEMAS exports 17 schemas", () => {
  const keys = Object.keys(ALL_SCHEMAS);
  assert.ok(keys.length >= 15, `Expected ≥15 schemas, got ${keys.length}: ${keys.join(",")}`);
});
