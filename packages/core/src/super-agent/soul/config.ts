/**
 * 司南的形象与声音配置：默认值、白名单校验、音色预设
 *
 * ## 为什么需要逐字段兜底
 *
 * 这份配置的写入口不止一个：设置面板、手改 JSON、CLI、旧版本升级。
 * 任何一个字段都可能变成 `"fast"`、`999`、`null` 或整份是数组。
 * 读配置**不能让页面 500**——所以这里把「坏输入」统一下调成默认值，
 * 而不是抛错。抛错只适用于「写」。
 *
 * ## 为什么音色是描述文本
 *
 * 「御姐音」不是某个现存音色 id，而是一组声学倾向：基频偏低、语速稳、
 * 气声略多、句尾下沉。CosyVoice2 的 instruct 模式与 Qwen3-TTS 的
 * VoiceDesign 都能吃自然语言描述，因此把描述做成可编辑配置，
 * 比硬编码一个音色 id 更接近用户想要的东西。
 *
 * @module super-agent/soul/config
 */

import { DEFAULT_COMPANION_CONFIG, COMPANION_PRESETS, SOUL_MODES, parseSoulMode, soulModeLabel } from "./modes";
import type {
  SoulAvatarConfig,
  SoulCompanionConfig,
  SoulConfig,
  SoulMode,
  SoulVoiceConfig,
  VoiceEngine,
} from "./types";

/** 自定义头像 dataUrl 上限（字符数，约 300KB 图；256px 头像 base64 约 10KB） */
export const AVATAR_DATA_URL_MAX = 400_000;

/** 默认 sidecar 地址（仅回环） */
export const DEFAULT_VOICE_ENDPOINT = "http://127.0.0.1:8791";

/** 支持的语音引擎（与 sidecar `/tts` 的 engine 取值一一对应） */
export const VOICE_ENGINES: readonly VoiceEngine[] = ["qwen3-voicedesign", "qwen3-customvoice", "kokoro"];

/** 语速可调范围 */
export const VOICE_SPEED_MIN = 0.5;
/** 语速可调范围 */
export const VOICE_SPEED_MAX = 2;

/**
 * 默认音色描述：御姐音
 *
 * 三段式写法（性别年龄 / 音区语速 / 气质）比单个形容词更容易被
 * VoiceDesign 正确理解——「御姐」对模型是抽象词，"中低音区、
 * 语速稳、克制不撒娇"才是可执行的声学指令。
 *
 * 英文补充不是凑字数：这个模型的训练语料以英文描述为主，
 * 中英并列能显著提高「低沉、克制」这类音色倾向的还原度（本机实测对比）。
 */
export const DEFAULT_VOICE_DESCRIPTION =
  "成熟女性，中低音区，语速平稳，略带气声，克制不撒娇，句尾下沉（mature female, low-mid register, steady pace, slightly breathy, restrained）";

/** 音色预设（降低空白输入的心理成本；用户可自由改写） */
export const VOICE_PRESETS: readonly { id: string; label: string; description: string }[] = [
  { id: "yujie", label: "御姐", description: DEFAULT_VOICE_DESCRIPTION },
  {
    id: "wenrou",
    label: "温柔",
    description:
      "成年女性，中音区，语速偏慢，气息柔和，耐心，句尾轻收（warm, gentle female voice, medium pitch, slow pace, soft）",
  },
  {
    id: "ganlian",
    label: "干练",
    description:
      "成年女性，中高音区，语速偏快，吐字清晰，利落，不拖尾音（crisp professional female voice, slightly higher pitch, brisk, no trailing）",
  },
];

/** 默认配置：语音默认关闭（模型没装时不该出现麦克风）；模式默认工作 */
export const DEFAULT_SOUL_CONFIG: SoulConfig = {
  avatar: { kind: "default" },
  voice: {
    enabled: false,
    engine: "qwen3-voicedesign",
    voice: DEFAULT_VOICE_DESCRIPTION,
    speed: 1,
    endpoint: DEFAULT_VOICE_ENDPOINT,
    token: "",
    speakReplies: true,
  },
  mode: "work",
  companion: DEFAULT_COMPANION_CONFIG,
};

/**
 * 数值夹取（非数字 → 默认值）
 *
 * @param raw 原始值
 * @param min 下界
 * @param max 上界
 * @param fallback 非数字时的兜底
 * @returns 夹取后的数值
 */
function clampNumber(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

/**
 * 校验并规范化头像配置
 *
 * 自定义头像必须是 `data:image/<type>;base64,` 开头的字符串且不超上限；
 * 否则回落默认兔狲——宁可显示默认头像，也不要显示一个破图。
 *
 * @param raw 原始值
 * @returns 合法头像配置
 */
export function normalizeAvatarConfig(raw: unknown): SoulAvatarConfig {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SOUL_CONFIG.avatar;
  const record = raw as Record<string, unknown>;
  if (record.kind !== "custom") return { kind: "default" };
  const dataUrl = typeof record.dataUrl === "string" ? record.dataUrl.trim() : "";
  const valid =
    dataUrl.startsWith("data:image/") && dataUrl.includes(";base64,") && dataUrl.length <= AVATAR_DATA_URL_MAX;
  return valid ? { kind: "custom", dataUrl } : { kind: "default" };
}

/**
 * 校验并规范化语音配置
 *
 * @param raw 原始值
 * @param fallbackToken 未配置 token 时使用的兜底（由适配层生成并持有）
 * @returns 合法语音配置
 */
export function normalizeVoiceConfig(raw: unknown, fallbackToken = ""): SoulVoiceConfig {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_SOUL_CONFIG.voice, token: fallbackToken };
  }
  const record = raw as Record<string, unknown>;
  const engine = VOICE_ENGINES.includes(record.engine as VoiceEngine)
    ? (record.engine as VoiceEngine)
    : DEFAULT_SOUL_CONFIG.voice.engine;
  const voice =
    typeof record.voice === "string" && record.voice.trim().length > 0
      ? record.voice.trim()
      : DEFAULT_SOUL_CONFIG.voice.voice;
  const endpoint =
    typeof record.endpoint === "string" && /^http:\/\/[^\s]+$/.test(record.endpoint.trim())
      ? record.endpoint.trim().replace(/\/+$/, "")
      : DEFAULT_VOICE_ENDPOINT;
  const token = typeof record.token === "string" && record.token.length > 0 ? record.token : fallbackToken;
  return {
    enabled: record.enabled === true,
    engine,
    voice,
    speed: clampNumber(record.speed, VOICE_SPEED_MIN, VOICE_SPEED_MAX, 1),
    endpoint,
    token,
    speakReplies: record.speakReplies !== false,
  };
}

/**
 * 校验并规范化陪伴配置
 *
 * 称呼限长 24 字（再长会被模型当成一句话复述出来）；两个滑杆夹到 0~1；
 * 防依赖开关默认开，只有显式 `false` 才关——这一项不该被「手滑」关掉。
 *
 * @param raw 原始值
 * @returns 合法陪伴配置
 */
export function normalizeCompanionConfig(raw: unknown): SoulCompanionConfig {
  if (typeof raw !== "object" || raw === null) return DEFAULT_COMPANION_CONFIG;
  const record = raw as Record<string, unknown>;
  const addressAs = typeof record.addressAs === "string" ? record.addressAs.trim().slice(0, 24) : "";
  return {
    addressAs,
    warmth: clampNumber(record.warmth, 0, 1, DEFAULT_COMPANION_CONFIG.warmth),
    proactivity: clampNumber(record.proactivity, 0, 1, DEFAULT_COMPANION_CONFIG.proactivity),
    encourageHumanContact: record.encourageHumanContact !== false,
  };
}

/**
 * 校验并规范化整份配置
 *
 * @param raw 原始值（可能来自磁盘、请求体或旧版本）
 * @param fallbackToken 未配置 token 时的兜底
 * @returns 合法配置
 */
export function normalizeSoulConfig(raw: unknown, fallbackToken = ""): SoulConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      avatar: { kind: "default" },
      voice: { ...DEFAULT_SOUL_CONFIG.voice, token: fallbackToken },
      mode: DEFAULT_SOUL_CONFIG.mode,
      companion: DEFAULT_COMPANION_CONFIG,
    };
  }
  const record = raw as Record<string, unknown>;
  return {
    avatar: normalizeAvatarConfig(record.avatar),
    voice: normalizeVoiceConfig(record.voice, fallbackToken),
    mode: parseSoulMode(record.mode),
    companion: normalizeCompanionConfig(record.companion),
  };
}

/**
 * 取得某个音色预设
 *
 * @param id 预设 id
 * @returns 预设（不存在返回 undefined）
 */
export function findVoicePreset(id: string): { id: string; label: string; description: string } | undefined {
  return VOICE_PRESETS.find((preset) => preset.id === id);
}

/**
 * 取得某个陪伴风格预设
 *
 * @param id 预设 id
 * @returns 预设（不存在返回 undefined）
 */
export function findCompanionPreset(
  id: string
): { id: string; label: string; description: string; config: SoulCompanionConfig } | undefined {
  return COMPANION_PRESETS.find((preset) => preset.id === id);
}

/**
 * 模式清单（转出，供 Web / CLI 展示）
 *
 * @returns 模式 id / 名称 / 一句话
 */
export function soulModeOptions(): readonly { id: SoulMode; label: string; tagline: string }[] {
  return SOUL_MODES;
}

/** 模式中文名（转出，避免调用方各自维护映射） */
export { soulModeLabel };
