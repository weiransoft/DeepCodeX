/**
 * 角色注册表测试
 *
 * 验证 5 角色定义严格符合 multi-agent-team 1:1 移植，禁止 mock
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROLE_REGISTRY,
  ROLE_MAP,
  getRole,
  getEnabledRoles,
  findCandidatesByKeyword,
  listRoleIds,
} from "../role-registry.js";
import { RoleDefinition } from "../types.js";

test("ROLE_REGISTRY has exactly 5 roles", () => {
  assert.equal(ROLE_REGISTRY.length, 5);
});

test("ROLE_REGISTRY contains all expected role ids", () => {
  const ids = ROLE_REGISTRY.map((r) => r.roleId).sort();
  assert.deepEqual(ids, ["architect", "product-manager", "solo-coder", "test-expert", "ui-designer"]);
});

test("every role passes RoleDefinition validation", () => {
  for (const role of ROLE_REGISTRY) {
    const parsed = RoleDefinition.parse(role);
    assert.equal(parsed.roleId, role.roleId);
  }
});

test("every role has system prompt prefix >= 50 chars", () => {
  for (const role of ROLE_REGISTRY) {
    assert.ok(
      role.systemPromptPrefix.length >= 50,
      `Role ${role.roleId} has prompt too short: ${role.systemPromptPrefix.length}`
    );
  }
});

test("every role has min 3 capabilities, skills, keywords", () => {
  for (const role of ROLE_REGISTRY) {
    assert.ok(role.capabilities.length >= 3, `Role ${role.roleId} capabilities < 3`);
    assert.ok(role.skills.length >= 3, `Role ${role.roleId} skills < 3`);
    assert.ok(role.keywords.length >= 3, `Role ${role.roleId} keywords < 3`);
  }
});

test("every role system prompt contains Karpathy 4 principles", () => {
  const requiredKeywords = ["Think Before Coding", "Simplicity First", "Surgical Changes", "Goal-Driven"];
  for (const role of ROLE_REGISTRY) {
    for (const kw of requiredKeywords) {
      assert.ok(role.systemPromptPrefix.includes(kw), `Role ${role.roleId} prompt missing Karpathy principle: ${kw}`);
    }
  }
});

test("every role system prompt contains Ponytail red lines reference", () => {
  for (const role of ROLE_REGISTRY) {
    assert.ok(
      role.systemPromptPrefix.includes("Ponytail") || role.systemPromptPrefix.includes("ponytail"),
      `Role ${role.roleId} prompt missing Ponytail reference`
    );
  }
});

test("ROLE_MAP lookup is consistent with ROLE_REGISTRY", () => {
  for (const role of ROLE_REGISTRY) {
    assert.equal(ROLE_MAP.get(role.roleId)?.roleId, role.roleId);
  }
});

test("getRole returns the correct role", () => {
  const arch = getRole("architect");
  assert.equal(arch.roleId, "architect");
  assert.equal(arch.name, "架构师");
});

test("getRole throws for unknown id", () => {
  assert.throws(() => getRole("unknown" as never));
});

test("getEnabledRoles returns roles with enabledByDefault true", () => {
  const enabled = getEnabledRoles();
  assert.ok(enabled.length === 5, "All 5 roles should be enabled by default");
});

test("findCandidatesByKeyword returns roles matching keyword", () => {
  const candidates = findCandidatesByKeyword("架构");
  assert.ok(candidates.length >= 1, "Should find architect for 架构");
  assert.ok(candidates.some((c) => c.roleId === "architect"));
});

test("findCandidatesByKeyword returns roles matching skill", () => {
  const candidates = findCandidatesByKeyword("Figma");
  assert.ok(candidates.some((c) => c.roleId === "ui-designer"));
});

test("findCandidatesByKeyword returns empty for nonsense keyword", () => {
  const candidates = findCandidatesByKeyword("xyzzyxqwer");
  assert.equal(candidates.length, 0);
});

test("listRoleIds returns all 5 ids", () => {
  const ids = listRoleIds();
  assert.equal(ids.length, 5);
});

test("roles are sorted by priority desc in registry", () => {
  // product-manager (10) > architect (9) > solo-coder (8) > test-expert (7) > ui-designer (6)
  const priorities = ROLE_REGISTRY.map((r) => r.priority);
  for (let i = 1; i < priorities.length; i++) {
    assert.ok(
      priorities[i - 1]! >= priorities[i]!,
      `Not sorted at index ${i}: ${priorities[i - 1]} vs ${priorities[i]}`
    );
  }
});

test("every role has valid color hex", () => {
  for (const role of ROLE_REGISTRY) {
    assert.match(role.metadata.color, /^#[0-9A-Fa-f]{6}$/);
  }
});

test("every role has non-empty icon", () => {
  for (const role of ROLE_REGISTRY) {
    assert.ok(role.metadata.icon.length > 0);
  }
});
