/**
 * 语音默认值的平台差异（core/super-agent/soul/platform + config）
 *
 * ## 为什么这件事要单独测
 *
 * 「Mac 开、Windows 关」不是一个审美选择，而是一个**能力事实**：
 * 语音链路依赖本机 MLX sidecar（`mlx_whisper` / `mlx_audio`），
 * 只有 Apple Silicon 能跑。Windows 上默认打开，等于给用户一个
 * 永远点不通的麦克风——点下去要等到超时才被告知「未就绪」。
 *
 * 而默认值一旦写错，影响的是**所有新用户的第一印象**，且很难被发现
 * （开发机是 Mac，永远看到的是"打开"那一侧）。所以这里把两个平台
 * 都注入进来断言，不依赖测试跑在什么机器上。
 *
 * ## 另一半同样重要：不能覆盖用户的选择
 *
 * 显式写过 `enabled: false` 的配置必须保持 false。升级不该把用户
 * 手动关掉的语音又打开——那是比默认值错更严重的事。
 *
 * @module tests/super-agent-soul-platform
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WAKE_WORD,
  WAKE_WORD_MAX_LENGTH,
  defaultVoiceConfig,
  normalizeVoiceConfig,
} from "../super-agent/soul/config.js";
import { defaultSpeakReplies, defaultVoiceEnabled, isVoiceCapablePlatform } from "../super-agent/soul/platform.js";

test("P1 只有 macOS 具备本机语音能力", () => {
  assert.equal(isVoiceCapablePlatform("darwin"), true);
  assert.equal(isVoiceCapablePlatform("win32"), false);
  assert.equal(isVoiceCapablePlatform("linux"), false);
  // 其他未列出的平台一律按「没有」处理，别提前放开
  assert.equal(isVoiceCapablePlatform("freebsd"), false);
});

test("P2 语音开关与自动朗读默认值跟随平台", () => {
  assert.equal(defaultVoiceEnabled("darwin"), true);
  assert.equal(defaultVoiceEnabled("win32"), false);
  assert.equal(defaultSpeakReplies("darwin"), true);
  assert.equal(defaultSpeakReplies("win32"), false);
});

test("P3 缺省配置按平台取值（音频相关字段一并给全）", () => {
  const mac = defaultVoiceConfig("darwin");
  const win = defaultVoiceConfig("win32");
  assert.equal(mac.enabled, true);
  assert.equal(win.enabled, false);
  assert.equal(mac.speakReplies, true);
  assert.equal(win.speakReplies, false);
  // 唤醒是隐私选择：不跟平台走，一律默认关
  assert.equal(mac.wakeEnabled, false);
  assert.equal(win.wakeEnabled, false);
  assert.equal(mac.wakeWord, DEFAULT_WAKE_WORD);
});

test("P4 字段缺失时吃平台默认，显式值必须尊重", () => {
  // 旧配置里没有 enabled 字段 → 按平台
  const missingOnMac = normalizeVoiceConfig({}, "", "darwin");
  const missingOnWin = normalizeVoiceConfig({}, "", "win32");
  assert.equal(missingOnMac.enabled, true);
  assert.equal(missingOnWin.enabled, false);
  assert.equal(missingOnMac.speakReplies, true);
  assert.equal(missingOnWin.speakReplies, false);

  // 用户显式关掉 → 仍是关（升级不该把语音又打开）
  assert.equal(normalizeVoiceConfig({ enabled: false }, "", "darwin").enabled, false);
  // 用户显式打开 → Windows 上也是开（用户自己承担装模型的成本）
  assert.equal(normalizeVoiceConfig({ enabled: true }, "", "win32").enabled, true);
  assert.equal(normalizeVoiceConfig({ speakReplies: false }, "", "darwin").speakReplies, false);
  assert.equal(normalizeVoiceConfig({ speakReplies: true }, "", "win32").speakReplies, true);
});

test("P5 唤醒词规范化：空值兜底、去空白、截断", () => {
  assert.equal(normalizeVoiceConfig({ wakeWord: "" }, "", "darwin").wakeWord, DEFAULT_WAKE_WORD);
  assert.equal(normalizeVoiceConfig({ wakeWord: "   " }, "", "darwin").wakeWord, DEFAULT_WAKE_WORD);
  assert.equal(normalizeVoiceConfig({ wakeWord: 123 }, "", "darwin").wakeWord, DEFAULT_WAKE_WORD);
  assert.equal(normalizeVoiceConfig({ wakeWord: " 小 南 " }, "", "darwin").wakeWord, "小南");
  assert.equal(
    normalizeVoiceConfig({ wakeWord: "一二三四五六七八九十十一十二十三" }, "", "darwin").wakeWord.length,
    WAKE_WORD_MAX_LENGTH
  );
  // 唤醒开关必须是显式 true 才开
  assert.equal(normalizeVoiceConfig({ wakeEnabled: "true" }, "", "darwin").wakeEnabled, false);
  assert.equal(normalizeVoiceConfig({ wakeEnabled: true }, "", "darwin").wakeEnabled, true);
});
