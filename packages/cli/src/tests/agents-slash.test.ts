/**
 * /agents 与沉淀建议命令单测（T03）
 *
 * 测试覆盖（对应 T03 验收①④）：
 *   - /agents 内置命令注册（BUILTIN 清单 + /help 渲染数据源）；
 *   - type:agent 条目不进 /<name> skill 命令清单（只经 /agents 展示）；
 *   - filterSlashCommands / findExactSlashCommand 对 /agents 的匹配；
 *   - /sediment-confirm 与 /sediment-dismiss 参数解析（含降级：缺参数报 invalid）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_SLASH_COMMANDS,
  buildSlashCommands,
  filterSlashCommands,
  findExactSlashCommand,
  formatBuiltinCommandList,
  parseSedimentationConfirmArgs,
  parseSedimentationDismissArgs,
} from "../ui/core/slash-commands";
import type { SkillInfo } from "@vegamo/deepcode-core";

// ============================================================================
// fixture
// ============================================================================

function skill(name: string, description = "普通技能"): SkillInfo {
  return { name, path: `~/.deepcode/skills/${name}/SKILL.md`, description };
}

function agent(name: string, description = "自定义 Agent"): SkillInfo {
  return { name, path: `~/.deepcode/skills/${name}/SKILL.md`, description, kind: "agent", role: "专家" };
}

// ============================================================================
// 内置命令注册
// ============================================================================

test("BUILTIN 清单注册 /agents、/sediment-confirm、/sediment-dismiss", () => {
  const kinds = BUILTIN_SLASH_COMMANDS.map((item) => item.kind);
  assert.ok(kinds.includes("agents"), "应有 agents 内置命令");
  assert.ok(kinds.includes("sediment-confirm"), "应有 sediment-confirm 内置命令");
  assert.ok(kinds.includes("sediment-dismiss"), "应有 sediment-dismiss 内置命令");
});

test("/help 渲染清单包含 /agents 与沉淀命令", () => {
  const list = formatBuiltinCommandList();
  assert.ok(list.includes("/agents"));
  assert.ok(list.includes("/sediment-confirm"));
  assert.ok(list.includes("/sediment-dismiss"));
});

// ============================================================================
// agent 条目不进 /<name> skill 命令清单
// ============================================================================

test("buildSlashCommands 过滤 type:agent 条目，保留普通 skill 与内置命令", () => {
  const items = buildSlashCommands([skill("plain-skill"), agent("code-reviewer")]);

  // agent 条目不得生成 /code-reviewer skill 命令
  const agentSkillItem = items.find((item) => item.kind === "skill" && item.name === "code-reviewer");
  assert.equal(agentSkillItem, undefined, "type:agent 条目不应进 skill 命令清单");

  // 普通 skill 命令保留
  const plainItem = items.find((item) => item.kind === "skill" && item.name === "plain-skill");
  assert.ok(plainItem);

  // 内置 /agents 命令保留
  const agentsCommand = items.find((item) => item.kind === "agents");
  assert.ok(agentsCommand);
  assert.equal(agentsCommand?.name, "agents");
});

test("buildSlashCommands 空列表时仍含内置 /agents（降级可用）", () => {
  const items = buildSlashCommands([]);
  const skillItems = items.filter((item) => item.kind === "skill");
  assert.equal(skillItems.length, 0);
  assert.ok(items.some((item) => item.kind === "agents"));
});

test("filterSlashCommands 与 findExactSlashCommand 可命中 /agents", () => {
  const items = buildSlashCommands([]);
  const matches = filterSlashCommands(items, "/agents");
  assert.ok(matches.length >= 1);
  assert.equal(matches[0]?.kind, "agents");

  const exact = findExactSlashCommand(items, "/agents");
  assert.ok(exact);
  assert.equal(exact.kind, "agents");
});

test("filterSlashCommands 支持 /ag 前缀匹配 /agents", () => {
  const items = buildSlashCommands([]);
  const matches = filterSlashCommands(items, "/ag");
  assert.ok(matches.some((item) => item.kind === "agents"));
});

// ============================================================================
// 沉淀命令参数解析
// ============================================================================

test("parseSedimentationConfirmArgs：缺省 scope=user，可显式 project", () => {
  const defaults = parseSedimentationConfirmArgs("/sediment-confirm troubleshoot-api");
  assert.deepEqual(defaults, { valid: true, name: "troubleshoot-api", scope: "user" });

  const project = parseSedimentationConfirmArgs("/sediment-confirm troubleshoot-api project");
  assert.deepEqual(project, { valid: true, name: "troubleshoot-api", scope: "project" });

  const explicitUser = parseSedimentationConfirmArgs("/sediment-confirm code-reviewer user");
  assert.deepEqual(explicitUser, { valid: true, name: "code-reviewer", scope: "user" });
});

test("parseSedimentationConfirmArgs：缺名称时 invalid（降级报错路径）", () => {
  assert.equal(parseSedimentationConfirmArgs("/sediment-confirm").valid, false);
  assert.equal(parseSedimentationConfirmArgs("/sediment-confirm   ").valid, false);
});

test("parseSedimentationConfirmArgs：非法 scope 回落 user（不报错）", () => {
  const parsed = parseSedimentationConfirmArgs("/sediment-confirm pattern-a blabla");
  assert.deepEqual(parsed, { valid: true, name: "pattern-a", scope: "user" });
});

test("parseSedimentationDismissArgs：提取名称，缺名称 invalid", () => {
  const ok = parseSedimentationDismissArgs("/sediment-dismiss pattern-a");
  assert.deepEqual(ok, { valid: true, name: "pattern-a" });

  assert.equal(parseSedimentationDismissArgs("/sediment-dismiss").valid, false);
});
