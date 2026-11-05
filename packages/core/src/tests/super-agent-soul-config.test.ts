/**
 * 形象与声音配置的校验测试（core/super-agent/soul/config）
 *
 * ## 为什么这份配置需要这么多「坏输入」用例
 *
 * 它的写入口不止一个：Web 设置面板、手改 JSON、CLI、旧版本升级。
 * 任何一处写错都会让**整个设置页 500**——用户从此改不了任何配置。
 * 所以这里的原则是：读配置永远不抛错，坏字段逐项降级。
 *
 * 另一类风险是安全问题：endpoint 若允许 http 之外的协议，
 * 后端代理就变成任意协议转发器（SSRF）；avatar 若是任意字符串，
 * 前端 `src` 就能被写进 `javascript:` 伪协议。两条都在这里锁死。
 *
 * @module tests/super-agent-soul-config
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AVATAR_DATA_URL_MAX,
  DEFAULT_SOUL_CONFIG,
  DEFAULT_VOICE_DESCRIPTION,
  DEFAULT_VOICE_ENDPOINT,
  VOICE_SPEED_MAX,
  VOICE_SPEED_MIN,
  findVoicePreset,
  normalizeAvatarConfig,
  normalizeSoulConfig,
  normalizeVoiceConfig,
} from "../super-agent/soul/config.js";

test("C1 非对象输入整份降级为默认值", () => {
  for (const bad of [null, undefined, 42, "x", true]) {
    const config = normalizeSoulConfig(bad, "tok");
    assert.equal(config.avatar.kind, "default");
    assert.equal(config.voice.endpoint, DEFAULT_VOICE_ENDPOINT);
    assert.equal(config.voice.token, "tok", "兜底 token 必须落到结果里");
  }
});

test("C2 整份是数组也算坏输入（JSON 里 [] 很常见）", () => {
  const config = normalizeSoulConfig([], "tok");
  assert.equal(config.avatar.kind, "default");
  assert.equal(config.voice.speed, 1);
});

test("C3 语音默认值跟随平台（有本地语音模型的平台才默认开）", () => {
  // 缺省时取平台默认：macOS 有本机 MLX 语音，默认开；其余平台默认关。
  // 这里用注入的平台断言，不依赖测试跑在什么机器上。
  assert.equal(normalizeSoulConfig({}, "tok", "darwin").voice.enabled, true);
  assert.equal(normalizeSoulConfig({}, "tok", "win32").voice.enabled, false, "Windows 缺省必须是关闭");
  // 字符串 "true" 不算（手改 JSON 很容易写成字符串）：在 Windows 默认关的平台上验，
  // 这样"没被当成 true"才看得出来
  assert.equal(normalizeVoiceConfig({ enabled: "true" }, "", "win32").enabled, false);
  assert.equal(normalizeVoiceConfig({ enabled: true }, "", "win32").enabled, true);
});

test("C4 speed 夹取到 [0.5, 2]；非数字回落 1", () => {
  assert.equal(normalizeVoiceConfig({ speed: 99 }).speed, VOICE_SPEED_MAX);
  assert.equal(normalizeVoiceConfig({ speed: 0.01 }).speed, VOICE_SPEED_MIN);
  assert.equal(normalizeVoiceConfig({ speed: -3 }).speed, VOICE_SPEED_MIN);
  assert.equal(normalizeVoiceConfig({ speed: 1.4 }).speed, 1.4, "合法值必须原样保留");
  for (const bad of ["fast", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    assert.equal(normalizeVoiceConfig({ speed: bad }).speed, 1, `speed=${String(bad)} 应回落 1`);
  }
});

test("C5 endpoint 只接受 http://，且去掉末尾斜杠", () => {
  assert.equal(normalizeVoiceConfig({ endpoint: "http://127.0.0.1:8791/" }).endpoint, "http://127.0.0.1:8791");
  // 非 http 协议一律回落——否则后端代理就能被拿去请求任意协议
  for (const bad of ["https://evil.com", "file:///etc/passwd", "javascript:alert(1)", "ftp://x", "127.0.0.1:8791"]) {
    assert.equal(normalizeVoiceConfig({ endpoint: bad }).endpoint, DEFAULT_VOICE_ENDPOINT, `${bad} 必须被拒`);
  }
});

test("C6 未知引擎回落 qwen3-voicedesign，未知音色预设返回 undefined", () => {
  assert.equal(normalizeVoiceConfig({ engine: "cosyvoice2" }).engine, "qwen3-voicedesign", "已下线的引擎名要回落");
  assert.equal(normalizeVoiceConfig({ engine: "qwen3-voicedesign" }).engine, "qwen3-voicedesign");
  assert.equal(normalizeVoiceConfig({ engine: "kokoro" }).engine, "kokoro");
  assert.ok(findVoicePreset("yujie"), "御姐预设必须存在");
  assert.equal(findVoicePreset("nope"), undefined);
});

test("C7 音色为空串时回落御姐描述（不能把空串送进 TTS）", () => {
  assert.equal(normalizeVoiceConfig({ voice: "   " }).voice, DEFAULT_VOICE_DESCRIPTION);
  assert.equal(normalizeVoiceConfig({ voice: "" }).voice, DEFAULT_VOICE_DESCRIPTION);
  assert.equal(normalizeVoiceConfig({ voice: "低沉男声" }).voice, "低沉男声");
});

test("C8 头像只接受 data:image/*;base64，其余回落默认兔狲", () => {
  const ok = normalizeAvatarConfig({ kind: "custom", dataUrl: "data:image/png;base64,AAAA" });
  assert.equal(ok.kind, "custom");

  // 破图不如默认图：宁可显示兔狲，也不要显示裂图
  for (const bad of [
    { kind: "custom", dataUrl: "javascript:alert(1)" },
    { kind: "custom", dataUrl: "https://example.com/a.png" },
    { kind: "custom", dataUrl: "data:text/html;base64,AAAA" },
    { kind: "custom" },
    { kind: "custom", dataUrl: 123 },
    { kind: "weird", dataUrl: "data:image/png;base64,AAAA" },
  ]) {
    assert.equal(normalizeAvatarConfig(bad).kind, "default", `${JSON.stringify(bad)} 应回落默认`);
  }
});

test("C9 超大头像被拒（避免把 300KB 塞进 400KB 上限之外的 base64）", () => {
  const huge = "data:image/png;base64," + "A".repeat(AVATAR_DATA_URL_MAX);
  assert.equal(normalizeAvatarConfig({ kind: "custom", dataUrl: huge }).kind, "default");
});

test("C10 speakReplies 缺省跟随平台，只有显式布尔才算数", () => {
  // macOS 默认开、Windows 默认关（见 soul/platform.ts）
  assert.equal(normalizeVoiceConfig({}, "", "darwin").speakReplies, true);
  assert.equal(normalizeVoiceConfig({}, "", "win32").speakReplies, false);
  assert.equal(normalizeVoiceConfig({ speakReplies: false }, "", "darwin").speakReplies, false);
  // 字符串不算：在默认关的平台上才看得出"没被当成 true"
  assert.equal(normalizeVoiceConfig({ speakReplies: "false" }, "", "darwin").speakReplies, true, "字符串不算");
  assert.equal(normalizeVoiceConfig({ speakReplies: "true" }, "", "win32").speakReplies, false, "字符串不算");
});

test("C11 token 两端行为：有值保留，空值用兜底", () => {
  assert.equal(normalizeVoiceConfig({ token: "abc" }, "fallback").token, "abc");
  assert.equal(normalizeVoiceConfig({ token: "" }, "fallback").token, "fallback");
  assert.equal(normalizeVoiceConfig({}, "fallback").token, "fallback");
});

test("C12 默认配置本身是合法输入（幂等）", () => {
  const once = normalizeSoulConfig(DEFAULT_SOUL_CONFIG, "");
  const twice = normalizeSoulConfig(once, "");
  assert.deepEqual(twice, once, "规范化必须幂等，否则每次保存都会漂移");
});
