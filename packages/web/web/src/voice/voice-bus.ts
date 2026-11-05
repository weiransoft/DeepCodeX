/**
 * 语音喂句总线（单实例桥）
 *
 * ## 为什么需要它
 *
 * 流式文本在 `App`（`onLlmDelta` 在这里），语音播放器的实例在 `Composer`
 * （麦克风与播报都属于输入区）。两个组件隔着好几层，把语音实例提到 `App`
 * 再逐层传下去会改一串 props；而如果**两边各建一个实例**，就会开两个麦克风
 * 采集、两个播报队列——那是最坏的结果。
 *
 * 折中是一条极窄的桥：`Composer` 注册自己的实例，`App` 只管往里喂文本。
 * 桥只存一个引用、只暴露两个动作，不承担任何状态。
 *
 * ## 纪律
 *
 * - 只允许一个注册（后注册覆盖先注册，并调用先注册者的释放）。
 * - `feed` / `finish` 在无人注册时**静默忽略**——语音关掉时这正是常态。
 *
 * @module web/voice/voice-bus
 */

import type { VoiceTalk } from "./useVoiceTalk";

/** 喂句能力（只取需要的两个方法，避免调用方拿到整个实例） */
export interface VoiceSink {
  /** 喂累积文本 */
  feed: (cumulative: string) => void;
  /** 本轮结束 */
  finishFeed: () => void;
}

/** 当前注册的实例 */
let current: VoiceTalk | null = null;

/**
 * 注册语音实例
 *
 * @param voice 实例
 * @returns 注销函数（仅当仍是当前实例时生效，防旧实例卸载时误清）
 */
export function registerVoice(voice: VoiceTalk): () => void {
  current = voice;
  return () => {
    if (current === voice) current = null;
  };
}

/**
 * 喂一段累积文本（无人注册时静默忽略）
 *
 * 这里是 SSE → 语音的**边界**，因此要挡脏值：`llm_delta` 的 `previewText`
 * 在 `start` 帧与纯 thinking 增量上是 undefined（core 契约允许缺省）。
 * 不挡的话它会一路传进 `scanVoiceDirective` 的 `cumulative.replace(...)`，
 * 抛 TypeError——而这条调用发生在 `onLlmDelta` 里 `setEntries` 之前，
 * 一抛就整帧跳过，表现为「开了语音之后某些回复的正文根本不显示」。
 *
 * @param cumulative 累积正文（可能缺省）
 */
export function feedVoice(cumulative?: string): void {
  if (typeof cumulative !== "string" || cumulative.length === 0) return;
  current?.feed(cumulative);
}

/** 本轮结束（把残句读出来） */
export function finishVoice(): void {
  current?.finishFeed();
}

/** 当前是否已注册（测试用） */
export function hasVoiceSink(): boolean {
  return current !== null;
}
