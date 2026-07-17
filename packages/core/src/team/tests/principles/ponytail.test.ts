/**
 * Ponytail 决策梯测试
 *
 * 覆盖：
 * 1. 模式枚举与解析
 * 2. 角色强度映射
 * 3. 规则集引擎 getInjectionPrompt（按角色 + 按模式）
 * 4. OFF 模式不注入
 * 5. Ultra/Lite 模式追加条款
 * 6. 红线列表完整性
 * 7. 引擎无状态（线程安全）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PonytailMode,
  ALL_PONYTAIL_MODES,
  isValidPonytailMode,
  ponytailModeFromStr,
  PONYTAIL_ROLE_IDS,
  ALL_PONYTAIL_ROLE_IDS,
  isValidPonytailRole,
  ROLE_INTENSITY,
  getRoleIntensity,
  LADDER_BODY,
  RED_LINES,
  RED_LINE_LIST,
  OUTPUT_SPEC,
  ULTRA_EXTRA,
  LITE_EXTRA,
  PonytailRulesetEngine,
  DEFAULT_PONYTAIL_ENGINE,
} from "../../principles/ponytail.js";

test("PonytailMode enum has 4 values", () => {
  assert.equal(ALL_PONYTAIL_MODES.length, 4);
  assert.equal(PonytailMode.OFF, "off");
  assert.equal(PonytailMode.LITE, "lite");
  assert.equal(PonytailMode.FULL, "full");
  assert.equal(PonytailMode.ULTRA, "ultra");
});

test("isValidPonytailMode accepts all valid modes", () => {
  for (const m of ALL_PONYTAIL_MODES) {
    assert.ok(isValidPonytailMode(m));
  }
  assert.equal(isValidPonytailMode("invalid"), false);
});

test("ponytailModeFromStr parses case-insensitive", () => {
  assert.equal(ponytailModeFromStr("OFF"), PonytailMode.OFF);
  assert.equal(ponytailModeFromStr("off"), PonytailMode.OFF);
  assert.equal(ponytailModeFromStr("Lite"), PonytailMode.LITE);
  assert.equal(ponytailModeFromStr("FULL"), PonytailMode.FULL);
  assert.equal(ponytailModeFromStr("Ultra"), PonytailMode.ULTRA);
  // 未知值默认为 FULL
  assert.equal(ponytailModeFromStr("xyz"), PonytailMode.FULL);
});

test("PONYTAIL_ROLE_IDS has 5 roles", () => {
  assert.equal(ALL_PONYTAIL_ROLE_IDS.length, 5);
});

test("isValidPonytailRole accepts all valid roles", () => {
  for (const r of ALL_PONYTAIL_ROLE_IDS) {
    assert.ok(isValidPonytailRole(r));
  }
  assert.equal(isValidPonytailRole("admin"), false);
});

test("ROLE_INTENSITY mapping matches architect review", () => {
  assert.equal(ROLE_INTENSITY[PONYTAIL_ROLE_IDS.ARCHITECT], PonytailMode.FULL);
  assert.equal(ROLE_INTENSITY[PONYTAIL_ROLE_IDS.SOLO_CODER], PonytailMode.FULL);
  assert.equal(ROLE_INTENSITY[PONYTAIL_ROLE_IDS.TEST_EXPERT], PonytailMode.LITE);
  assert.equal(ROLE_INTENSITY[PONYTAIL_ROLE_IDS.UI_DESIGNER], PonytailMode.LITE);
  assert.equal(ROLE_INTENSITY[PONYTAIL_ROLE_IDS.PRODUCT_MANAGER], PonytailMode.OFF);
});

test("getRoleIntensity returns OFF for unknown role", () => {
  assert.equal(getRoleIntensity("unknown"), PonytailMode.OFF);
  assert.equal(getRoleIntensity(""), PonytailMode.OFF);
});

test("LADDER_BODY has 6 steps", () => {
  assert.ok(LADDER_BODY.includes("【YAGNI】"));
  assert.ok(LADDER_BODY.includes("【标准库优先】"));
  assert.ok(LADDER_BODY.includes("【平台原生】"));
  assert.ok(LADDER_BODY.includes("【复用现有】"));
  assert.ok(LADDER_BODY.includes("【一行优先】"));
  assert.ok(LADDER_BODY.includes("【最小可行】"));
});

test("RED_LINES has 16 red lines", () => {
  // 按 "数字." 模式计数
  const matches = RED_LINES.match(/^\d+\./gm);
  assert.ok(matches !== null);
  assert.equal(matches.length, 16);
});

test("RED_LINE_LIST has 16 items", () => {
  assert.equal(RED_LINE_LIST.length, 16);
});

test("PonytailRulesetEngine returns empty string for OFF mode", () => {
  const engine = new PonytailRulesetEngine("/tmp/test");
  const result = engine.getInjectionPrompt(PONYTAIL_ROLE_IDS.SOLO_CODER, PonytailMode.OFF);
  assert.equal(result, "");
});

test("PonytailRulesetEngine returns full prompt for solo_coder", () => {
  const engine = new PonytailRulesetEngine();
  const result = engine.getInjectionPrompt(PONYTAIL_ROLE_IDS.SOLO_CODER, PonytailMode.FULL);
  assert.ok(result.includes("Ponytail 决策梯"));
  assert.ok(result.includes("模式：full"));
  assert.ok(result.includes("角色：solo-coder"));
  assert.ok(result.includes("【YAGNI】"));
  assert.ok(result.includes("不可简化红线"));
  assert.ok(result.includes("输出规范"));
  // FULL 模式不追加 ultra/lite
  assert.equal(result.includes("Ultra 模式追加条款"), false);
  assert.equal(result.includes("Lite 模式追加条款"), false);
});

test("PonytailRulesetEngine appends ULTRA extra when mode is ultra", () => {
  const engine = new PonytailRulesetEngine();
  const result = engine.getInjectionPrompt(PONYTAIL_ROLE_IDS.SOLO_CODER, PonytailMode.ULTRA);
  assert.ok(result.includes("Ultra 模式追加条款"));
  assert.ok(result.includes("YAGNI 极端主义"));
  assert.equal(result.includes("Lite 模式追加条款"), false);
});

test("PonytailRulesetEngine appends LITE extra when mode is lite", () => {
  const engine = new PonytailRulesetEngine();
  const result = engine.getInjectionPrompt(PONYTAIL_ROLE_IDS.SOLO_CODER, PonytailMode.LITE);
  assert.ok(result.includes("Lite 模式追加条款"));
  assert.equal(result.includes("Ultra 模式追加条款"), false);
});

test("PonytailRulesetEngine uses role default when mode is null", () => {
  const engine = new PonytailRulesetEngine();
  // product-manager 默认 OFF → 空字符串
  const pmResult = engine.getInjectionPrompt(PONYTAIL_ROLE_IDS.PRODUCT_MANAGER, null);
  assert.equal(pmResult, "");
  // solo-coder 默认 FULL → 有内容
  const scResult = engine.getInjectionPrompt(PONYTAIL_ROLE_IDS.SOLO_CODER, null);
  assert.ok(scResult.includes("Ponytail 决策梯"));
  // test-expert 默认 LITE → 包含 Lite 追加
  const teResult = engine.getInjectionPrompt(PONYTAIL_ROLE_IDS.TEST_EXPERT, null);
  assert.ok(teResult.includes("Lite 模式追加条款"));
  // ui-designer 默认 LITE → 包含 Lite 追加
  const uiResult = engine.getInjectionPrompt(PONYTAIL_ROLE_IDS.UI_DESIGNER, null);
  assert.ok(uiResult.includes("Lite 模式追加条款"));
  // architect 默认 FULL → 完整 prompt
  const archResult = engine.getInjectionPrompt(PONYTAIL_ROLE_IDS.ARCHITECT, null);
  assert.ok(archResult.includes("Ponytail 决策梯"));
  assert.equal(archResult.includes("Lite 模式追加条款"), false);
  assert.equal(archResult.includes("Ultra 模式追加条款"), false);
});

test("PonytailRulesetEngine.getRedLines returns full text", () => {
  const engine = new PonytailRulesetEngine();
  const lines = engine.getRedLines();
  assert.equal(lines, RED_LINES);
});

test("PonytailRulesetEngine.getLadderBody returns 6-step body", () => {
  const engine = new PonytailRulesetEngine();
  const body = engine.getLadderBody();
  assert.equal(body, LADDER_BODY);
  assert.ok(body.includes("【YAGNI】"));
});

test("PonytailRulesetEngine.getRedLineList returns 16 items", () => {
  const engine = new PonytailRulesetEngine();
  const list = engine.getRedLineList();
  assert.equal(list.length, 16);
});

test("PonytailRulesetEngine.getOutputSpec returns output spec", () => {
  const engine = new PonytailRulesetEngine();
  const spec = engine.getOutputSpec();
  assert.equal(spec, OUTPUT_SPEC);
});

test("PonytailRulesetEngine.getUltraExtra returns ultra extra", () => {
  const engine = new PonytailRulesetEngine();
  const extra = engine.getUltraExtra();
  assert.equal(extra, ULTRA_EXTRA);
  assert.ok(extra.includes("YAGNI 极端主义"));
});

test("PonytailRulesetEngine.getLiteExtra returns lite extra", () => {
  const engine = new PonytailRulesetEngine();
  const extra = engine.getLiteExtra();
  assert.equal(extra, LITE_EXTRA);
  assert.ok(extra.includes("按要求构建"));
});

test("PonytailRulesetEngine.getSkillRoot returns constructor param", () => {
  const engine1 = new PonytailRulesetEngine("/my/skill/root");
  assert.equal(engine1.getSkillRoot(), "/my/skill/root");
  const engine2 = new PonytailRulesetEngine();
  assert.equal(engine2.getSkillRoot(), null);
});

test("PonytailRulesetEngine is stateless (multiple calls return same content)", () => {
  const engine = new PonytailRulesetEngine();
  const r1 = engine.getInjectionPrompt(PONYTAIL_ROLE_IDS.SOLO_CODER, PonytailMode.FULL);
  const r2 = engine.getInjectionPrompt(PONYTAIL_ROLE_IDS.SOLO_CODER, PonytailMode.FULL);
  assert.equal(r1, r2);
  // 调用多次不修改内部状态
  const r3 = engine.getInjectionPrompt(PONYTAIL_ROLE_IDS.ARCHITECT, PonytailMode.ULTRA);
  assert.ok(r3.includes("Ultra 模式追加条款"));
  // 再次调用 solo_coder FULL 仍得到原始内容
  const r4 = engine.getInjectionPrompt(PONYTAIL_ROLE_IDS.SOLO_CODER, PonytailMode.FULL);
  assert.equal(r4, r1);
});

test("DEFAULT_PONYTAIL_ENGINE is a usable instance", () => {
  const result = DEFAULT_PONYTAIL_ENGINE.getInjectionPrompt(PONYTAIL_ROLE_IDS.SOLO_CODER, PonytailMode.FULL);
  assert.ok(result.length > 100);
});
