/**
 * 语音指令行：让回复自己决定怎么念
 *
 * ## 它解决什么
 *
 * 同一句话在不同情境下该用不同语速与音色：用户说「今天有点累」时，回答应该
 * 慢一点、低一点；说「快讲讲这个 bug」时应该利落。但音色与语速目前只能在设置里
 * 手动调——用户得先中断对话去改配置，再回来接着说。
 *
 * 参考 OpenClaw 的 Talk Mode：它允许模型在回复**第一行**放一行 JSON 来控制
 * voice / model / speed / stability，解析后这一行**不进入 TTS**，用户听不到它。
 * 也就是说，模型自己可以决定「这句该慢慢说」。
 *
 * ## 为什么只认第一行
 *
 * 放宽到「任意位置」会让正文里的代码示例被误判成指令；限定首行则天然排除了
 * 正常内容——回复的第一行几乎不可能是合法 JSON。仍然加一道白名单校验：
 * 必须至少含 `voice` / `engine` / `speed` / `once` 里的一个合法字段，否则按
 * 普通文本处理，免得以 `{` 开头的正常回答被整行吞掉。
 *
 * ## 流式的坑：首行可能还没收完
 *
 * SSE 逐字到达时，第一批可能只有 `{"spe`。此时**不能**把它当文本送去合成
 * （用户会听到「大括号引号 spe」），也不能判定为「没有指令」（等真指令到了
 * 已经被念出来了）。因此返回第三种状态 `pending`：先挂起，等下一批增量；
 * 挂起窗口受 `DIRECTIVE_MAX_CHARS` 限制，超长就认定它不是指令。
 *
 * @module web/voice/directive
 */

import type { VoiceEngine } from "../api";

/** 首行指令的最大长度：超过这个长度不可能是「一行 JSON 参数」，按正文处理 */
export const DIRECTIVE_MAX_CHARS = 200;

/** 语速边界（与 core 的 VOICE_SPEED_MIN / VOICE_SPEED_MAX 一致） */
const SPEED_MIN = 0.5;
const SPEED_MAX = 2;

/** 可切换的引擎（与 core 的 VOICE_ENGINES 一致） */
const ENGINES: readonly VoiceEngine[] = ["qwen3-voicedesign", "qwen3-customvoice", "kokoro"];

/** 一条已解析的语音指令 */
export interface VoiceDirective {
  /** 音色描述或音色 id（自由文本，VoiceDesign 会当声学指令用） */
  voice?: string;
  /** 合成引擎 */
  engine?: VoiceEngine;
  /** 语速倍率（0.5~2） */
  speed?: number;
  /** 只对当前这一条回复生效（否则成为本轮会话的新默认） */
  once: boolean;
}

/** 扫描结果 */
export type VoiceDirectiveScan =
  /** 首行还没收完，暂不朗读，等下一批增量 */
  | { kind: "pending" }
  /** 没有指令，按原文处理 */
  | { kind: "none" }
  /** 有指令：`text` 是剥掉指令行之后的正文 */
  | { kind: "applied"; text: string; directive: VoiceDirective };

/**
 * 解析一行 JSON 指令（不合法返回 null）
 *
 * @param line 候选行（不含换行）
 * @returns 指令；无可识别字段时返回 null
 */
export function parseVoiceDirectiveLine(line: string): VoiceDirective | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;
  const directive: VoiceDirective = { once: record.once === true };
  let recognized = false;

  // 音色：兼容 voice / voice_id / voiceId 三种写法（OpenClaw 的字段名演化史）
  const voice = record.voice ?? record.voice_id ?? record.voiceId;
  if (typeof voice === "string" && voice.trim().length > 0) {
    directive.voice = voice.trim().slice(0, 400);
    recognized = true;
  }

  // 引擎：只接受已知值，避免把拼错的引擎名传到 sidecar 触发 400
  if (typeof record.engine === "string" && ENGINES.includes(record.engine as VoiceEngine)) {
    directive.engine = record.engine as VoiceEngine;
    recognized = true;
  }

  // 语速：兼容 speed / rate 两种写法；越界直接夹到合法区间而不是丢弃
  const speed = record.speed ?? record.rate;
  if (typeof speed === "number" && Number.isFinite(speed)) {
    directive.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
    recognized = true;
  }

  // 只有 once 没有其它参数时也算有效（「这条别用默认音色」的场景）
  if (record.once === true) recognized = true;
  if (!recognized) return null;

  return directive;
}

/**
 * 扫描累积文本的首行
 *
 * @param cumulative 累积文本（`llm_delta` 的 previewText）
 * @returns 扫描结果
 */
export function scanVoiceDirective(cumulative: string): VoiceDirectiveScan {
  const head = cumulative.replace(/^\s+/, "");
  if (!head.startsWith("{")) return { kind: "none" };

  const newlineAt = head.indexOf("\n");
  if (newlineAt < 0) {
    // 还没有换行：首行未收完。短的先挂起，长的认定不是指令。
    return head.length <= DIRECTIVE_MAX_CHARS ? { kind: "pending" } : { kind: "none" };
  }

  const firstLine = head.slice(0, newlineAt);
  const directive = parseVoiceDirectiveLine(firstLine);
  if (directive === null) return { kind: "none" };

  // 指令行连同其换行一起去掉；正文从下一行开始（保留原始缩进）
  const text = head.slice(newlineAt + 1);
  return { kind: "applied", text, directive };
}

/**
 * 收尾时处理仍处于 pending 的首行
 *
 * 模型偶尔会把指令写在没有换行的一行里（整段就一句），此时 `scanVoiceDirective`
 * 一直返回 pending。流结束时再试一次：能解析就应用，不能就把它当正文读出去——
 * 宁可多念一句，也不能让整段回复没声音。
 *
 * @param cumulative 累积文本
 * @returns 与 `scanVoiceDirective` 同形（但不会再返回 pending）
 */
export function settleVoiceDirective(cumulative: string): Exclude<VoiceDirectiveScan, { kind: "pending" }> {
  const head = cumulative.replace(/^\s+/, "");
  if (!head.startsWith("{")) return { kind: "none" };
  const directive = parseVoiceDirectiveLine(head);
  if (directive === null) return { kind: "none" };
  return { kind: "applied", text: "", directive };
}
