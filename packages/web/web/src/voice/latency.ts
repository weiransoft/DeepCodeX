/**
 * 语音交互端到端延迟：五时间戳与分段汇总（纯函数，可脱开浏览器单测）
 *
 * ## 为什么需要一条统一时间轴
 *
 * 之前只有 `speechEnd → firstAudio` 一个 TTFA 数字（用 `performance.now()`
 * 单调时钟测得）。它足够稳定，但一旦变慢就无法回答**慢在哪一段**：
 * 是 ASR/提交排队、LLM 首 token、切句后 TTS 排队，还是解码排程？
 *
 * 这里把五个时刻统一到 epoch 毫秒（`Date.now()` 口径），与 core 经 SSE
 * 透传的 `LlmStreamTiming.startedAtMs` 是同一时钟，因此可以直接相减。
 * TTFA 原值继续用单调时钟单独测，两条口径互不干扰、互为校验。
 *
 * ## 五个时刻
 *
 * 1. `speechEndAtMs` 用户说完（录音结束）
 * 2. `llmStartAtMs` LLM 请求发起（core）
 * 3. `llmFirstContentAtMs` 首个**可朗读**正文 token（core TTFT）
 * 4. `ttsFirstByteAtMs` 首个音频块到达浏览器
 * 5. `firstAudioAtMs` 首个音真正排进播放时间轴
 *
 * `endpointAtMs` / `submitAtMs` 是后续接入语义判停与提交埋点的预留位：
 * 现在没有可靠来源就**留空**，绝不填一个猜测值冒充实测。
 *
 * ## 诚实边界
 *
 * 任一环节时刻缺失，对应分段返回 `undefined` 而不是 0；时钟乱序（例如
 * 服务端与浏览器时钟有偏差）也不产出负数。没测到就说没测到。
 *
 * @module web/voice/latency
 */

/** core `LlmStreamProgress.timing` 经 SSE 透传后的载荷 */
export interface LlmStreamTiming {
  /** LLM 请求发起时刻（epoch ms） */
  startedAtMs: number;
  /** 本帧距请求发起的毫秒数（本模块不使用，仅保留契约完整） */
  elapsedMs: number;
  /** 首正文 token 距请求发起的毫秒数；还没出正文时缺省 */
  firstContentMs?: number;
}

/** 一轮语音交互的五个时刻（全部可选，缺失即「没测到」） */
export interface VoiceTurnTiming {
  /** 用户说完（录音结束） */
  speechEndAtMs?: number;
  /** 端点判停（语义/静音窗满足）——预留，当前无可靠来源 */
  endpointAtMs?: number;
  /** 消息提交——预留，当前无可靠来源 */
  submitAtMs?: number;
  /** LLM 请求发起 */
  llmStartAtMs?: number;
  /** 首正文 token */
  llmFirstContentAtMs?: number;
  /** 首个音频块到达 */
  ttsFirstByteAtMs?: number;
  /** 首个音排进播放时间轴 */
  firstAudioAtMs?: number;
}

/** 分段延迟（毫秒）；`undefined` = 该段缺少端点，未测到 */
export interface VoiceTurnLatency {
  /** 端点判停等待（需 endpointAtMs） */
  endpointMs?: number;
  /** 用户说完 → LLM 请求发起：ASR + 提交 + 服务端排队 */
  asrSubmitMs?: number;
  /** LLM 首正文 token 延迟（TTFT） */
  llmTtftMs?: number;
  /** 首正文 token → 首音频块：切句 + TTS 合成排队 */
  ttsQueueMs?: number;
  /** 首音频块 → 首音出声：解码 + WebAudio 排程 */
  ttsTtfaMs?: number;
  /** 用户说完 → 首音出声（端到端） */
  e2eMs?: number;
  /** 实际填入的时刻数（便于判断是否完整可观测） */
  observedTimestamps: number;
}

function delta(end?: number, start?: number): number | undefined {
  if (typeof end !== "number" || typeof start !== "number") return undefined;
  if (!Number.isFinite(end) || !Number.isFinite(start)) return undefined;
  const value = end - start;
  // 时钟偏差/乱序不产出负数：宁可标成未测到，也不给一个假的 0ms
  return value >= 0 ? Math.round(value) : undefined;
}

/** 当前 epoch 毫秒（浏览器与 core 共用墙上时钟） */
export function nowEpochMs(): number {
  return Date.now();
}

/**
 * 汇总一轮的分段延迟
 *
 * 纯函数：不读全局时钟、不写状态，方便用合成时间戳回归。
 */
export function summarizeVoiceTurnLatency(trace: VoiceTurnTiming): VoiceTurnLatency {
  const keys: Array<keyof VoiceTurnTiming> = [
    "speechEndAtMs",
    "endpointAtMs",
    "submitAtMs",
    "llmStartAtMs",
    "llmFirstContentAtMs",
    "ttsFirstByteAtMs",
    "firstAudioAtMs",
  ];
  const observedTimestamps = keys.filter((key) => typeof trace[key] === "number" && Number.isFinite(trace[key])).length;
  const result: VoiceTurnLatency = { observedTimestamps };

  const endpointMs = delta(trace.endpointAtMs, trace.speechEndAtMs);
  const asrSubmitMs = delta(trace.llmStartAtMs, trace.speechEndAtMs);
  const llmTtftMs = delta(trace.llmFirstContentAtMs, trace.llmStartAtMs);
  const ttsQueueMs = delta(trace.ttsFirstByteAtMs, trace.llmFirstContentAtMs);
  const ttsTtfaMs = delta(trace.firstAudioAtMs, trace.ttsFirstByteAtMs);
  const e2eMs = delta(trace.firstAudioAtMs, trace.speechEndAtMs);
  if (endpointMs !== undefined) result.endpointMs = endpointMs;
  if (asrSubmitMs !== undefined) result.asrSubmitMs = asrSubmitMs;
  if (llmTtftMs !== undefined) result.llmTtftMs = llmTtftMs;
  if (ttsQueueMs !== undefined) result.ttsQueueMs = ttsQueueMs;
  if (ttsTtfaMs !== undefined) result.ttsTtfaMs = ttsTtfaMs;
  if (e2eMs !== undefined) result.e2eMs = e2eMs;
  return result;
}

/**
 * 把 SSE 的 LLM 时序合并进本轮 trace（不修改传入对象）
 *
 * `firstContentMs` 是**相对** `startedAtMs` 的偏移，这里换算成绝对时刻。
 * 首帧（只有 startedAtMs、还没有正文）只写起点，后续帧补上首 token。
 */
export function mergeLlmTiming(trace: VoiceTurnTiming, timing: LlmStreamTiming | null | undefined): VoiceTurnTiming {
  if (!timing || !Number.isFinite(timing.startedAtMs)) return { ...trace };
  const next: VoiceTurnTiming = { ...trace, llmStartAtMs: timing.startedAtMs };
  if (typeof timing.firstContentMs === "number" && Number.isFinite(timing.firstContentMs)) {
    next.llmFirstContentAtMs = timing.startedAtMs + Math.max(0, timing.firstContentMs);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 按档位分组的效率指标（思考深度调度的可验证面）
// ---------------------------------------------------------------------------

/** core `LlmStreamProgress.thinkDepth` 经 SSE 透传后的精简快照 */
export interface ThinkDepthSnapshot {
  scene: string;
  level: "off" | "light" | "balanced" | "full";
  effort: string;
  thinkingEnabled: boolean;
  control: "effort" | "binary" | "budget" | "none";
  effective: boolean;
  fallback: boolean;
  reasons?: string[];
}

/** 单轮效率样本（语音延迟采样 + 本轮档位） */
export interface DepthEfficiencySample {
  thinkDepth?: ThinkDepthSnapshot;
  breakdown?: VoiceTurnLatency;
  ttfaMs?: number;
}

/** 某档位的延迟分位（缺段一律留空，绝不填 0） */
export interface DepthLatencyGroup {
  count: number;
  ttftP50Ms?: number;
  ttftP95Ms?: number;
  e2eP50Ms?: number;
  ttfaP50Ms?: number;
}

/** 效率汇总 */
export interface DepthEfficiencyReport {
  /** 总样本数 */
  total: number;
  /** 有档位标记的样本数 */
  grouped: number;
  /** 降档样本占已分组样本的比例 */
  downgradedRatio: number;
  /** 兜底（调度关闭/异常）样本数 */
  fallbackCount: number;
  /** 按档位分组的延迟 */
  byLevel: Partial<Record<ThinkDepthSnapshot["level"], DepthLatencyGroup>>;
  /** full 档与最轻档 TTFT P50 之差；任一侧缺实测值时留空 */
  ttftSavingP50Ms?: number;
}

function percentileOf(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 按思考档位汇总实测 TTFT / E2E / TTFA
 *
 * 这是「减少冗余思考是否真的缩短了首响应时间」的验收入口：同一份 golden
 * 语料分别以 `DCX_THINK_DEPTH=off`（静态基线）与默认自适应跑一遍，把两批
 * `DepthEfficiencySample` 喂进来对比 `byLevel.full.ttftP50Ms` 与
 * `byLevel.off.ttftP50Ms`。没测到就留 `undefined`，不编造收益。
 *
 * @param samples 采样
 * @returns 汇总
 */
export function summarizeDepthEfficiency(samples: readonly DepthEfficiencySample[]): DepthEfficiencyReport {
  const byLevel: DepthEfficiencyReport["byLevel"] = {};
  const ttft = new Map<string, number[]>();
  const e2e = new Map<string, number[]>();
  const ttfa = new Map<string, number[]>();
  let total = 0;
  let grouped = 0;
  let downgraded = 0;
  let fallbackCount = 0;

  for (const sample of samples ?? []) {
    total += 1;
    const level = sample?.thinkDepth?.level;
    if (level === undefined) continue;
    grouped += 1;
    if (level !== "full") downgraded += 1;
    if (sample.thinkDepth?.fallback === true) fallbackCount += 1;
    const group = byLevel[level] ?? { count: 0 };
    group.count += 1;
    byLevel[level] = group;
    const push = (map: Map<string, number[]>, value: unknown): void => {
      const ms = finite(value);
      if (ms === undefined) return;
      const list = map.get(level) ?? [];
      list.push(ms);
      map.set(level, list);
    };
    push(ttft, sample.breakdown?.llmTtftMs);
    push(e2e, sample.breakdown?.e2eMs);
    push(ttfa, sample.ttfaMs);
  }

  for (const [level, group] of Object.entries(byLevel) as Array<[ThinkDepthSnapshot["level"], DepthLatencyGroup]>) {
    const p50 = percentileOf(ttft.get(level) ?? [], 50);
    const p95 = percentileOf(ttft.get(level) ?? [], 95);
    if (p50 !== undefined) group.ttftP50Ms = Math.round(p50);
    if (p95 !== undefined) group.ttftP95Ms = Math.round(p95);
    const e2eP50 = percentileOf(e2e.get(level) ?? [], 50);
    if (e2eP50 !== undefined) group.e2eP50Ms = Math.round(e2eP50);
    const ttfaP50 = percentileOf(ttfa.get(level) ?? [], 50);
    if (ttfaP50 !== undefined) group.ttfaP50Ms = Math.round(ttfaP50);
  }

  const fullP50 = byLevel.full?.ttftP50Ms;
  const lightP50 = byLevel.off?.ttftP50Ms ?? byLevel.light?.ttftP50Ms;
  return {
    total,
    grouped,
    downgradedRatio: grouped === 0 ? 0 : Math.round((downgraded / grouped) * 1000) / 1000,
    fallbackCount,
    byLevel,
    ...(fullP50 !== undefined && lightP50 !== undefined ? { ttftSavingP50Ms: Math.round(fullP50 - lightP50) } : {}),
  };
}
