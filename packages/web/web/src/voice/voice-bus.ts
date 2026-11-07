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
 * - 连接级错误不在总线上立刻收尾，而是走「重连边沿看门狗」（见下）。
 *
 * ## 为什么连接错误不能立刻 finishVoice()
 *
 * `EventSource.onerror` 只说明**这一条连接**断了，不说明这一轮生成结束了。
 * 内建重连成功后，服务端可能继续推同一轮的 `llm_delta`。若错误边沿立刻
 * `finishFeed()`，`SentenceStream` 会被置空；下一帧累积文本又是同前缀的
 * 完整正文，新建的切句器游标从 0 起，会把已经念过的句子**从头再念一遍**。
 *
 * 反过来，若连接真的死了，`done` / `assistant_message` 永远不会到，最后一块
 * 不满字数的音频会一直挂在 `blockBuffer` 里不播——「讲了几句就断了」。
 * 沉默是稳定状态，不会超时也不会报错，所以必须主动兜底。
 *
 * 折中是宽限期看门狗：连接出错先不收尾；期间只要再来一帧正文（轮次还活着）
 * 或连接恢复，就撤表；宽限期到了仍无动静，才判定本轮已丢失并补一次收尾。
 * 宽限期只挂在「连接出错」之后，正常生成里的工具等待、模型长停顿不会触发。
 *
 * @module web/voice/voice-bus
 */

import type { VoiceTalk } from "./useVoiceTalk";

/** 连接断开后判定「本轮已丢失」的宽限期（毫秒） */
export const VOICE_RECONNECT_GRACE_MS = 4000;

/** 重连宽限期定时器（模块级单例，与单实例桥一致） */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** 撤掉宽限期（任何确定的轮次信号、新正文、连接恢复都要调） */
function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

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
  // 旧实例遗留的宽限期不能落到新实例头上
  clearReconnectTimer();
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
  // 又来了一帧正文：本轮还活着，宽限期撤表，别在生成中途把尾巴封掉
  clearReconnectTimer();
  current?.feed(cumulative);
}

/** 本轮结束（把残句读出来） */
export function finishVoice(): void {
  clearReconnectTimer();
  current?.finishFeed();
}

/**
 * 连接级错误（EventSource 自动重连中）
 *
 * 不立刻收尾，只起表。宽限期内有新正文 / 连接恢复 / 确定轮次边界都会撤表。
 * `graceMs` 仅用于测试缩短等待；生产走 `VOICE_RECONNECT_GRACE_MS`。
 *
 * @param graceMs 宽限期（毫秒）
 */
export function noteVoiceConnectionLost(graceMs: number = VOICE_RECONNECT_GRACE_MS): void {
  if (current === null) return;
  clearReconnectTimer();
  reconnectTimer = setTimeout(
    () => {
      reconnectTimer = null;
      finishVoice();
    },
    Math.max(0, graceMs)
  );
}

/** 连接恢复（EventSource onopen）：轮次还有机会继续，撤掉宽限期 */
export function noteVoiceConnectionRestored(): void {
  clearReconnectTimer();
}

/**
 * 显式开启新一轮（用户发出新消息 / 切换会话时调用）
 *
 * `finishVoice` 是「补念尾巴 + 封块」，语义上是收尾；这里是「清状态」，
 * 不需要等上一轮的 `assistant_message`。二者都幂等，可以按顺序各调一次。
 * 有了它，即使上一轮的收尾事件被引擎丢掉，新一轮也有确定的起点。
 */
export function beginVoiceTurn(): void {
  clearReconnectTimer();
  current?.beginTurn();
}

/** 当前是否已注册（测试用） */
export function hasVoiceSink(): boolean {
  return current !== null;
}
