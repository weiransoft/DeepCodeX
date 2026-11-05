/**
 * 名字可配置（core/super-agent/identity + soul/config + soul/presets）
 *
 * ## 为什么名字值得单独测
 *
 * 名字同时进四个地方：提示词里的自称、消息署名、界面标题、唤醒词默认值。
 * 任何一个没跟上，用户看到的都是「我改了名，但它好像还是叫司南」。
 * 而这类不一致**不会报错**，只会让人觉得"这软件不太对劲"。
 *
 * ## 重点测三条边界
 *
 * 1. 没设过名字 → 一切保持原样（含「老南」这种从读音派生的昵称）；
 * 2. 改了名字 → 昵称必须清掉。"小北"被叫"老南"比不改名更怪；
 * 3. 名字要清洗——它会拼进提示词，换行和 Markdown 结构符不能放进来。
 *
 * @module tests/super-agent-soul-identity
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SUPER_AGENT_IDENTITY, resolveAgentName } from "../super-agent/identity.js";
import { NAME_MAX_CHARS, normalizeIdentityConfig, normalizeSoulConfig } from "../super-agent/soul/config.js";
import { createSinanSoul } from "../super-agent/soul/presets.js";
import { renderSoulPrompt } from "../super-agent/soul/render.js";

test("I1 不传覆盖时，名字、英文名、昵称全部沿用默认", () => {
  const name = resolveAgentName();
  assert.equal(name.primary, SUPER_AGENT_IDENTITY.name);
  assert.equal(name.latin, SUPER_AGENT_IDENTITY.nameEn);
  assert.deepEqual(name.nicknames, ["老南", "南工"]);
});

test("I2 改中文名后，英文名与昵称都不再保留旧值", () => {
  const name = resolveAgentName({ name: "小北" });
  assert.equal(name.primary, "小北");
  // 「Sinan」是「司南」的音译，配「小北」是莫名其妙的一半英文
  assert.equal(name.latin, undefined);
  // 「老南」「南工」同理：换了名字，这些称呼就不成立了
  assert.equal(name.nicknames, undefined);
});

test("I3 只填英文名时中文名保持默认", () => {
  const name = resolveAgentName({ nameEn: "North" });
  assert.equal(name.primary, SUPER_AGENT_IDENTITY.name);
  assert.equal(name.latin, "North");
});

test("I4 中文名首尾空白被裁剪，纯空白视为没设置", () => {
  assert.equal(resolveAgentName({ name: "  小北  " }).primary, "小北");
  assert.equal(resolveAgentName({ name: "   " }).primary, SUPER_AGENT_IDENTITY.name);
  assert.equal(resolveAgentName({ name: "" }).latin, SUPER_AGENT_IDENTITY.nameEn);
});

test("I5 名字清洗：换行、制表、Markdown 结构符都去掉", () => {
  const config = normalizeIdentityConfig({ name: "小#北\n*南*", nameEn: "`Nor\rth`" });
  assert.equal(config.name, "小北南");
  assert.equal(config.nameEn, "North");
});

test("I6 名字超长时截断，不会把整段话塞进提示词", () => {
  const long = "名".repeat(NAME_MAX_CHARS + 8);
  const config = normalizeIdentityConfig({ name: long });
  assert.equal([...config.name].length, NAME_MAX_CHARS);
});

test("I7 坏输入不抛错，回落成空串（交由默认值兜底）", () => {
  for (const bad of [null, undefined, 42, "小北", [], { name: 123 }]) {
    const config = normalizeIdentityConfig(bad);
    assert.equal(config.name, "");
    assert.equal(config.nameEn, "");
  }
});

test("I8 normalizeSoulConfig 缺省时 identity 为空（不把默认名写进配置）", () => {
  const config = normalizeSoulConfig({});
  assert.deepEqual(config.identity, { name: "", nameEn: "" });
});

test("I9 createSinanSoul 传名字后，提示词里的称呼跟着改", () => {
  const soul = createSinanSoul([], { name: "小北", nameEn: "North" });
  assert.equal(soul.essence.name.primary, "小北");
  const prompt = renderSoulPrompt(soul);
  assert.ok(prompt.includes("名称：小北（North）"), "提示词应写入新名字");
  assert.ok(!prompt.includes("名称：司南"), "提示词不能残留旧名字");
});

test("I10 createSinanSoul 不传名字时完全是原来的司南", () => {
  const soul = createSinanSoul();
  assert.equal(soul.essence.name.primary, SUPER_AGENT_IDENTITY.name);
  assert.deepEqual(soul.essence.name.nicknames, ["老南", "南工"]);
});
