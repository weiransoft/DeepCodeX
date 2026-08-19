import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSlashCommands,
  filterSlashCommands,
  findExactSlashCommand,
  formatSlashCommandDescription,
  formatSlashCommandLabel,
  formatBuiltinCommandList,
  BUILTIN_SLASH_COMMANDS,
} from "../ui";
import type { SkillInfo } from "@vegamo/deepcode-core";

const skills: SkillInfo[] = [
  { name: "skill-writer", path: "~/.agents/skills/skill-writer/SKILL.md", description: "Write a SKILL.md" },
  { name: "code-review", path: "~/.agents/skills/code-review/SKILL.md", description: "Review code" },
];

test("buildSlashCommands prefixes skills before built-ins", () => {
  const items = buildSlashCommands(skills);
  assert.equal(items[0].kind, "skill");
  assert.equal(items[0].name, "skill-writer");
  const builtinNames = items.filter((i) => i.kind !== "skill").map((i) => i.name);
  assert.deepEqual(builtinNames, [
    // FIX-06（多角色审查 2026-07-29）：/help 内置命令（渲染同源命令清单）
    "help",
    "skills",
    "model",
    "plan",
    "new",
    "init",
    "resume",
    "continue",
    "undo",
    "mcp",
    "raw",
    "exit",
    // DeepCodeX 融合：多角色团队命令
    "team",
    "architect",
    "pm",
    "coder",
    "tester",
    "ui",
    // DeepCodeX V2 记忆管理命令
    "memory",
    // DeepCodeX EAG 规则管理命令
    "rules",
    // DeepCodeX Quality Gate 质量门禁命令
    "quality-check",
    // DeepCodeX Review 代码审查命令（工具验证优先）
    "review",
    // DeepCodeX ADR-DI-001 动态注入与后台子 Agent 命令
    "inject",
    "bg",
    "tasks",
    "fg",
    "cancel",
    "pause",
    // DeepCodeX EAG P5 编排命令（2026-07-31 FIX-3，与 slash-commands.ts 注册顺序对齐）
    "eag-autonomous",
    "eag-autonomous-status",
    "eag-autonomous-stop",
    "eag-graph",
    // DeepCodeX EAG DESIGN Loop 命令（2026-08-19 S3.2 接线，注册在末尾）
    "eag-design",
  ]);
});

// S3.2（2026-08-19 DESIGN Loop 接线）：/eag-design 精确匹配与参数提示
test("findExactSlashCommand returns built-in /eag-design with paradigm hint", () => {
  const items = buildSlashCommands(skills);
  const item = findExactSlashCommand(items, "/eag-design");
  assert.ok(item);
  assert.equal(item?.kind, "eag-design");
  // 参数提示必须覆盖必填 --requirement 与可选 --paradigm（4 个合法范式 ID）
  assert.ok(item?.args?.some((a) => a.includes("--requirement")));
  const paradigmArg = item?.args?.find((a) => a.includes("--paradigm"));
  assert.ok(paradigmArg, "--paradigm 参数提示应存在");
  for (const id of ["ddd-layered", "clean-architecture", "cqrs-es", "microservice"]) {
    assert.ok(paradigmArg?.includes(id), `--paradigm 提示应包含合法范式 ${id}`);
  }
});

test("filterSlashCommands matches partial prefixes", () => {
  const items = buildSlashCommands(skills);
  const matched = filterSlashCommands(items, "/skil").map((i) => i.name);
  assert.deepEqual(matched, ["skill-writer", "skills"]);
});

test("filterSlashCommands returns all entries on bare slash", () => {
  const items = buildSlashCommands(skills);
  const matched = filterSlashCommands(items, "/");
  assert.equal(matched.length, items.length);
});

test("filterSlashCommands returns nothing for non-slash tokens", () => {
  const items = buildSlashCommands(skills);
  assert.deepEqual(filterSlashCommands(items, "skill"), []);
});

test("findExactSlashCommand returns null when nothing matches", () => {
  const items = buildSlashCommands(skills);
  assert.equal(findExactSlashCommand(items, "/missing"), null);
});

test("findExactSlashCommand returns built-in /new", () => {
  const items = buildSlashCommands(skills);
  const item = findExactSlashCommand(items, "/new");
  assert.ok(item);
  assert.equal(item?.kind, "new");
});

test("findExactSlashCommand returns built-in /init", () => {
  const items = buildSlashCommands(skills);
  const item = findExactSlashCommand(items, "/init");
  assert.ok(item);
  assert.equal(item?.kind, "init");
  assert.equal(item?.description, "Initialize an AGENTS.md file with instructions for LLM");
});

test("findExactSlashCommand returns built-in /continue", () => {
  const items = buildSlashCommands(skills);
  const item = findExactSlashCommand(items, "/continue");
  assert.ok(item);
  assert.equal(item?.kind, "continue");
});

test("findExactSlashCommand returns built-in /undo", () => {
  const items = buildSlashCommands(skills);
  const item = findExactSlashCommand(items, "/undo");
  assert.ok(item);
  assert.equal(item?.kind, "undo");
});

test("findExactSlashCommand returns built-in /skills", () => {
  const items = buildSlashCommands(skills);
  const item = findExactSlashCommand(items, "/skills");
  assert.ok(item);
  assert.equal(item?.kind, "skills");
});

test("findExactSlashCommand returns built-in /model", () => {
  const items = buildSlashCommands(skills);
  const item = findExactSlashCommand(items, "/model");
  assert.ok(item);
  assert.equal(item?.kind, "model");
});

test("findExactSlashCommand returns built-in /plan", () => {
  const items = buildSlashCommands(skills);
  const item = findExactSlashCommand(items, "/plan");
  assert.ok(item);
  assert.equal(item?.kind, "plan");
});

test("findExactSlashCommand returns built-in /raw", () => {
  const items = buildSlashCommands(skills);
  const item = findExactSlashCommand(items, "/raw");
  assert.ok(item);
  assert.equal(item?.kind, "raw");
});

test("findExactSlashCommand returns the matching skill", () => {
  const items = buildSlashCommands(skills);
  const item = findExactSlashCommand(items, "/code-review");
  assert.ok(item);
  assert.equal(item?.kind, "skill");
  assert.equal(item?.skill?.name, "code-review");
});

test("findExactSlashCommand returns built-in /review", () => {
  const items = buildSlashCommands(skills);
  const item = findExactSlashCommand(items, "/review");
  assert.ok(item);
  assert.equal(item?.kind, "review");
  assert.equal(item?.description.includes("Code review"), true);
});

test("formatSlashCommandDescription keeps descriptions on one line", () => {
  assert.equal(formatSlashCommandDescription("Line one\n  line two"), "Line one line two");
});

test("formatSlashCommandLabel marks loaded skills", () => {
  const items = buildSlashCommands([
    { name: "loaded", path: "/skills/loaded/SKILL.md", description: "Loaded skill", isLoaded: true },
    { name: "fresh", path: "/skills/fresh/SKILL.md", description: "Fresh skill" },
  ]);

  assert.equal(formatSlashCommandLabel(items[0]), "/loaded ✓");
  assert.equal(formatSlashCommandLabel(items[1]), "/fresh");
});

// ============================================================================
// FIX-06（多角色审查 2026-07-29）：/help 命令与 formatBuiltinCommandList
// ============================================================================

test("findExactSlashCommand returns built-in /help", () => {
  const items = buildSlashCommands(skills);
  const item = findExactSlashCommand(items, "/help");
  assert.ok(item, "/help 应注册为内置命令");
  assert.equal(item?.kind, "help");
});

test("findExactSlashCommand returns built-in /memory", () => {
  const items = buildSlashCommands(skills);
  const item = findExactSlashCommand(items, "/memory");
  assert.ok(item, "/memory 应注册为内置命令");
  assert.equal(item?.kind, "memory");
});

test("formatBuiltinCommandList renders every registered builtin command", () => {
  const list = formatBuiltinCommandList();
  const lines = list.split("\n");

  // 行数与注册表条目数一致（一命令一行）
  assert.equal(lines.length, BUILTIN_SLASH_COMMANDS.length, "清单行数应与注册表条目数一致");

  // 每条命令的 label 与 description 均出现在对应行中
  for (const item of BUILTIN_SLASH_COMMANDS) {
    // 精确匹配：行前缀为 "  <label>  "，避免 /memory 描述里的 "review" 被误判为 /review
    const line = lines.find((l) => l.startsWith(`  ${item.label}  `));
    assert.ok(line, `清单应包含 ${item.label}`);
    assert.ok(line!.includes(item.description), `${item.label} 行应包含描述文本`);
  }

  // 关键命令必须出现在清单中（FIX-06 审查发现的 EPILOG 缺失项）
  for (const required of [
    "/help",
    "/team",
    "/memory",
    "/rules",
    "/quality-check",
    "/review",
    "/inject",
    "/bg",
    "/tasks",
  ]) {
    assert.ok(list.includes(required), `清单应包含 ${required}`);
  }
});

test("formatBuiltinCommandList aligns label column", () => {
  const lines = formatBuiltinCommandList().split("\n");
  // 所有行的 label 结束位置（description 起始列）应一致
  const maxLabelLen = Math.max(...BUILTIN_SLASH_COMMANDS.map((i) => i.label.length));
  for (const line of lines) {
    // 行格式：2 空格 + label.padEnd(maxLabelLen) + 2 空格 + description
    // description 起始索引 = 2 + maxLabelLen + 2
    const descStartCol = 2 + maxLabelLen + 2;
    // 该行在 descStartCol 之前应只包含 label + 空格（无描述文本混入）
    const prefix = line.slice(0, descStartCol);
    assert.ok(/^ {2}\/\S+ +$/.test(prefix), `行 "${line}" 的 label 列未对齐到第 ${descStartCol} 列`);
  }
});
