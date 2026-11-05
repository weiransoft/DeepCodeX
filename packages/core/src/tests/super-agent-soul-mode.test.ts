/**
 * 陪伴模式测试 —— 覆盖层、提示词与配置归一化
 *
 * ## 覆盖
 *
 * - M1 缺省是工作模式，渲染不出现模式段
 * - M2 陪伴模式覆盖 Layer 2/3/4，但 Layer 1（本质与边界）逐字不变
 * - M3 陪伴段包含「先接情绪」「不迎合」「不假装是人类」与危机热线 12356
 * - M4 配置归一化：非法模式回落 work、滑杆夹取、称呼截断
 * - M5 关闭「鼓励现实连接」后提示词不再有那一条
 * - M6 快照暴露 mode / modeLabel（界面能看出当前模式）
 * - M7 引擎情感自适应仍以陪伴基线为准（体谅 → 不因为一句报错就绷紧）
 *
 * @module tests/super-agent-soul-mode
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSinanSoul } from "../super-agent/soul/presets.js";
import { applySoulMode, renderModeSection } from "../super-agent/soul/modes.js";
import { normalizeSoulConfig, soulModeOptions } from "../super-agent/soul/config.js";
import { buildSoulSnapshot, renderSoulPrompt } from "../super-agent/soul/render.js";
import { SoulEngine } from "../super-agent/soul/engine.js";

/** 默认陪伴配置（与 core 默认一致，测试内显式写出便于阅读） */
const COMPANION = { addressAs: "", warmth: 0.85, proactivity: 0.55, encourageHumanContact: true };

// ============================================================================
// M1–M3 覆盖与渲染
// ============================================================================

test("M1 缺省工作模式：不渲染模式段", () => {
  const soul = createSinanSoul();
  const prompt = renderSoulPrompt(soul);
  assert.ok(!prompt.includes("当前模式：陪伴"), "工作模式不该出现陪伴段");
  assert.equal(renderModeSection("work", COMPANION), "");
});

test("M2 陪伴模式覆盖人格与表达，但不改核心本质与边界", () => {
  const base = createSinanSoul();
  const companion = applySoulMode(base, "companion", COMPANION);

  assert.equal(companion.mode, "companion");
  assert.equal(companion.personality.mbti, "ENFJ");
  assert.ok(companion.personality.ocean.extraversion > base.personality.ocean.extraversion);
  assert.ok(companion.personality.ocean.agreeableness > base.personality.ocean.agreeableness);
  assert.equal(companion.expression.communicationStyle, "SUPPORTIVE");
  assert.equal(companion.emotion.baseline, "EMPATHETIC");

  // Layer 1：原样（同一个对象引用——不允许被“模式”改写）
  assert.equal(companion.essence, base.essence);
  assert.deepEqual(companion.essence.inviolableBoundaries, base.essence.inviolableBoundaries);
});

test("M3 陪伴段覆盖情绪优先、不迎合、非人与危机热线", () => {
  const soul = applySoulMode(createSinanSoul(), "companion", COMPANION);
  const prompt = renderSoulPrompt(soul);

  for (const needle of ["当前模式：陪伴", "先接情绪", "不迎合", "不假装是人类", "不制造依赖", "12356", "110 / 120"]) {
    assert.ok(prompt.includes(needle), `提示词应包含「${needle}」`);
  }
  // 热情也要如实：技术问题不许含糊
  assert.ok(prompt.includes("陪伴不等于哄"));

  // 规划器 / Worker 显式按工作模式渲染：陪伴段不得混进派工提示词
  assert.ok(!renderSoulPrompt(soul, { mode: "work" }).includes("当前模式：陪伴"));
});

// ============================================================================
// M4–M5 配置
// ============================================================================

test("M4 配置归一化：非法模式回落、滑杆夹取、称呼截断", () => {
  const config = normalizeSoulConfig({
    mode: "party",
    companion: { addressAs: "  一个特别特别长的称呼会被截断掉一些字  ", warmth: 9, proactivity: -3 },
  });
  assert.equal(config.mode, "work", "未知模式必须回落工作模式");
  assert.equal(config.companion.warmth, 1);
  assert.equal(config.companion.proactivity, 0);
  assert.ok(config.companion.addressAs.length <= 24);
  assert.equal(config.companion.encourageHumanContact, true, "防依赖开关默认开");

  // 旧配置（没有 mode 字段）升级后仍是工作模式，行为零变化
  const legacy = normalizeSoulConfig({ avatar: { kind: "default" } });
  assert.equal(legacy.mode, "work");
});

test("M5 关闭现实连接建议后提示词不再含那条", () => {
  const soul = applySoulMode(createSinanSoul(), "companion", { ...COMPANION, encourageHumanContact: false });
  const prompt = renderSoulPrompt(soul);
  assert.ok(!prompt.includes("该把人交回现实"));
});

// ============================================================================
// M6–M7 快照与情感
// ============================================================================

test("M6 快照暴露当前模式（界面与注入同源）", () => {
  const engine = new SoulEngine({ mode: "companion", companion: COMPANION });
  const snapshot = engine.snapshot();
  assert.equal(snapshot.mode, "companion");
  assert.equal(snapshot.modeLabel, "陪伴模式");
  assert.ok(snapshot.promptPreview.includes("当前模式：陪伴"));

  assert.equal(soulModeOptions().length, 2);
  assert.deepEqual(
    soulModeOptions().map((item) => item.id),
    ["work", "companion"]
  );
});

test("M7 陪伴模式下情感基线是体谅：普通报错不绷紧，真事故仍严肃", () => {
  const engine = new SoulEngine({ mode: "companion", companion: COMPANION });
  assert.equal(engine.soul().emotion.baseline, "EMPATHETIC");
  const after = engine.adapt("构建失败了，报错一大堆");
  assert.equal(after.current, "EMPATHETIC");
  assert.ok(after.intensity <= 0.95);

  // 真的紧急（线上挂了）仍要回到严肃——情绪优先不等于对危险迟钝
  assert.equal(engine.adapt("线上挂了，用户进不来").current, "SERIOUS");
});

test("M8 陪伴段约束「短」与「能被念出来」：默认 2~3 句、少用列表", () => {
  const soul = applySoulMode(createSinanSoul(), "companion", COMPANION);
  const section = renderModeSection("companion", COMPANION);

  // 长度：明确给出 2~3 句的默认值，并留一个「被要求展开才展开」的出口
  assert.ok(section.includes("2~3 句"), "必须给出可执行的句数上限，否则模型仍会写长");
  assert.ok(section.includes("对方要细节再展开"), "要留出被要求展开的出口");

  // 形态：语音场景下列表/表格/代码块是噪音
  assert.ok(section.includes("会被念出来"), "必须点明这段话会被朗读");
  assert.ok(section.includes("少用列表"), "必须要求少用列表/编号/表格");

  // 陪伴不等于一切从简：被问「详细说说」时仍要能展开（约束不能反噬内容）
  assert.ok(soul.expression.communicationStyle === "SUPPORTIVE");
  assert.ok(!section.includes("不要超过一句"), "不能写成硬截断——技术问题该讲清楚时仍要讲清楚");
});

test("M9 陪伴段有正面示范：短不等于生硬、不用书面腔", () => {
  const section = renderModeSection("companion", COMPANION);

  // 只有禁令没有示范时，模型容易「按规则表演」而更僵。示范是最有效的手段。
  assert.ok(section.includes("听起来应该像这样"), "缺少正面示例小节");
  assert.ok(section.includes("连着三天到十一点"), "缺少具体的语气示范");

  // 「短」曾经把回复压成「嗯，确实」——那是另一种生硬，必须显式排除
  assert.ok(section.includes("短不等于生硬"), "必须说明短 ≠ 敷衍");
  assert.ok(section.includes("放之四海皆准"), "必须点名「万能短句」的问题");

  // 书面连接词是「生硬」最可辨识的指纹
  assert.ok(section.includes("首先 / 其次"), "必须禁掉结构化连接词");
  assert.ok(section.includes("不在开头复述对方的问题"), "必须禁掉复述式开头");

  // 示范不能变成模板：明确要求不照抄
  assert.ok(section.includes("不要照抄内容"), "示范必须标注为语气而非内容模板");
});
