/**
 * LLM 流式时序（纯函数，可脱开 SessionManager 单测）
 *
 * ## 为什么单独一个模块
 *
 * 「反应迟钝」必须先能测量才能优化。此前 `LlmStreamProgress` 只有
 * `startedAt`（ISO 字符串）和 token 估算，宿主能算出「已经跑了多久」，
 * 却算不出**首正文 token 延迟（TTFT）** —— 而 TTFT 是语音对话里唯一
 * 真正决定「多久开始出声」的 LLM 指标。
 *
 * 这里只负责把「一帧进度」变成可外发的时序数据，不碰网络、不碰 SDK。
 * 时间一律用 epoch 毫秒（`Date.now()` 口径），这样浏览器把 SSE 帧里的
 * `startedAtMs` 和自己记录的 `Date.now()` 放进同一条时间轴时，不需要
 * 处理 `performance.now()` 与墙上时钟的换算。
 *
 * ## 首正文 token 的口径
 *
 * 只有 `phase === "update"` 且 `previewText` 非空才算。thinking/reasoning
 * 增量走 `thinkingText` 独立通道，不计入 —— 它们不能拿去合成语音，把
 * 思考首帧当成 TTFT 会把「多久开始说话」算得偏乐观。
 *
 * @module core/llm-stream-timing
 */

/** 流式进度帧携带的时序（对外契约，Web 经 SSE 原样透传） */
export type LlmStreamTiming = {
  /** 本次 LLM 请求发起时刻（epoch ms） */
  startedAtMs: number;
  /** 本帧距请求发起的毫秒数 */
  elapsedMs: number;
  /** 首个**正文** token 距请求发起的毫秒数；还没出正文时缺省 */
  firstContentMs?: number;
};

/** 单个 requestId 的时序累计状态（由 SessionManager 按 requestId 持有） */
export type LlmStreamTimingState = {
  startedAtMs: number;
  firstContentMs: number | null;
};

/** 流式进度相位（与 `LlmStreamProgress["phase"]` 保持字面量一致） */
export type LlmStreamPhase = "start" | "update" | "end";

/**
 * 推进一帧进度并返回本帧应外发的时序
 *
 * @param state 该 requestId 上一帧的状态；`null` 表示首帧（自动用 startedAt 初始化）
 * @param startedAtIso 请求发起时刻（ISO 字符串，`SessionManager` 既有参数）
 * @param phase 本帧相位
 * @param previewText 本帧原始累积正文（未格式化，可能 undefined）
 * @param nowMs 当前 epoch 毫秒（注入便于单测，不做隐式 `Date.now()`）
 * @returns 新状态与本帧时序；`end` 帧返回的状态由调用方删除
 */
export function advanceLlmStreamTiming(
  state: LlmStreamTimingState | null,
  startedAtIso: string,
  phase: LlmStreamPhase,
  previewText: string | undefined,
  nowMs: number
): { state: LlmStreamTimingState; timing: LlmStreamTiming } {
  const parsed = Date.parse(startedAtIso);
  const next: LlmStreamTimingState = state ?? {
    startedAtMs: Number.isFinite(parsed) ? parsed : nowMs,
    firstContentMs: null,
  };

  if (next.firstContentMs === null && phase === "update" && typeof previewText === "string" && previewText.length > 0) {
    next.firstContentMs = Math.max(0, nowMs - next.startedAtMs);
  }

  const timing: LlmStreamTiming = {
    startedAtMs: next.startedAtMs,
    elapsedMs: Math.max(0, nowMs - next.startedAtMs),
    ...(next.firstContentMs !== null ? { firstContentMs: next.firstContentMs } : {}),
  };
  return { state: next, timing };
}
