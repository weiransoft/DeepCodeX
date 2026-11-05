/**
 * 语音指令行单测（web/voice/directive）
 *
 * 两个失败模式最伤体验：
 *
 * 1. **把 JSON 念出来**——用户听到「大括号 引号 voice 冒号」；
 * 2. **吞掉正常回答**——回复恰好以 `{` 开头（讲一段 JSON 示例）时整段没声音。
 *
 * 所以断言两头都要卡：真指令必须剥干净，非指令必须原样保留。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVoiceDirectiveLine, scanVoiceDirective, settleVoiceDirective } from "../web/src/voice/directive";

test("D1 首行指令 → 剥离并按字段解析", () => {
  const text = '{"voice":"低沉男声","speed":0.9}\n今天辛苦了，先歇一会儿。';
  const scan = scanVoiceDirective(text);
  assert.equal(scan.kind, "applied");
  if (scan.kind !== "applied") return;
  assert.equal(scan.directive.voice, "低沉男声");
  assert.equal(scan.directive.speed, 0.9);
  assert.equal(scan.directive.once, false, "没有 once 时是持久设置");
  assert.equal(scan.text, "今天辛苦了，先歇一会儿。", "指令行必须从朗读文本里消失");
});

test("D2 首行还没收完 → pending（不能提前送 TTS，也不能判定没有指令）", () => {
  assert.equal(scanVoiceDirective('{"spe').kind, "pending");
  assert.equal(scanVoiceDirective('{"speed":0.9').kind, "pending");
  assert.equal(scanVoiceDirective("   {").kind, "pending", "前导空白不影响判定");
});

test("D3 非法 JSON 首行 → 当正文（原样朗读）", () => {
  const text = "{这不是 JSON}\n随便说说。";
  assert.equal(scanVoiceDirective(text).kind, "none");
});

test("D4 合法 JSON 但没有可识别字段 → 当正文（不吞内容）", () => {
  const text = '{"foo":1}\n这是示例。';
  assert.equal(scanVoiceDirective(text).kind, "none");
  assert.equal(parseVoiceDirectiveLine('{"foo":1}'), null);
});

test("D5 语速越界夹到合法区间，而不是整条丢弃", () => {
  const slow = parseVoiceDirectiveLine('{"speed":0.1}');
  const fast = parseVoiceDirectiveLine('{"speed":9}');
  assert.equal(slow?.speed, 0.5);
  assert.equal(fast?.speed, 2);
});

test("D6 兼容 voice_id / voiceId 与 rate 别名", () => {
  assert.equal(parseVoiceDirectiveLine('{"voice_id":"v1"}')?.voice, "v1");
  assert.equal(parseVoiceDirectiveLine('{"voiceId":"v2"}')?.voice, "v2");
  assert.equal(parseVoiceDirectiveLine('{"rate":1.2}')?.speed, 1.2);
});

test("D7 未知引擎名被忽略（不能把拼错的值传到 sidecar）", () => {
  const directive = parseVoiceDirectiveLine('{"engine":"cosyvoice2","speed":1}');
  assert.equal(directive?.engine, undefined);
  assert.equal(directive?.speed, 1, "其它合法字段仍生效");
});

test("D8 首行不是 JSON → none（正常回答不受影响）", () => {
  assert.equal(scanVoiceDirective("今天天气不错。").kind, "none");
  assert.equal(scanVoiceDirective("  code: print('hi')").kind, "none");
});

test("D9 收尾：单行指令没有换行时也要能识别", () => {
  const settled = settleVoiceDirective('{"speed":1.1,"once":true}');
  assert.equal(settled.kind, "applied");
  if (settled.kind !== "applied") return;
  assert.equal(settled.directive.speed, 1.1);
  assert.equal(settled.directive.once, true);
});

test("D10 收尾：不是指令时保留原文（宁可多念一句，也不能整段没声音）", () => {
  const settled = settleVoiceDirective("{不是指令但以括号开头");
  assert.equal(settled.kind, "none");
});
