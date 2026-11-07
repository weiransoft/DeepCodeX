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
import type { LlmStreamTiming, ThinkDepthSnapshot } from "./latency";

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

/**
 * 透传 LLM 流式时序（请求起点 / 首正文 token）
 *
 * 与 `feedVoice` 分开：时序帧可能先于任何正文到达（`start` 帧），也可能在
 * 语音关闭时到达。这里不撤重连看门狗 —— 只有**正文**才证明本轮还活着，
 * 一条 timing 不能证明，否则连接真死了会漏掉补念收尾。
 */
export function noteVoiceLlmTiming(timing: LlmStreamTiming | null | undefined): void {
  if (!timing) return;
  current?.noteLlmTiming(timing);
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

/**
 * 打断事务的「取消在飞生成」处理器
 *
 * 播报被打断时，光 `queue.stop()` 只掐掉了声音：LLM 还在流式输出、ASR 可能
 * 在飞、session-pool 的串行队列还占着本轮。用户马上插话发新消息，就会被
 * 排在旧轮后面 —— 这正是「越聊越迟钝」的一条暗线。
 *
 * 处理器由 `App` 注册（只有它知道 activeChatId），语音层只发一次请求，
 * 不关心 HTTP 细节。刻意**不复用 App 的 `stop()`**：那个入口会调
 * `finishVoice()` 把残句补念出来，而用户打断的含义恰恰是「别念了」。
 */
let interruptHandler: (() => void) | null = null;

/** 注册打断处理器（后注册覆盖，注销只清自己） */
export function setVoiceInterruptHandler(handler: () => void): () => void {
  interruptHandler = handler;
  return () => {
    if (interruptHandler === handler) interruptHandler = null;
  };
}

/** 请求取消在飞生成；无人注册时静默忽略（语音关闭/测试环境） */
export function requestVoiceInterrupt(): void {
  interruptHandler?.();
}

/** 当前是否已注册（测试用） */
export function hasVoiceSink(): boolean {
  return current !== null;
}

// ---------------------------------------------------------------------------
// 语音来源标记与思考深度遥测（按回合思考深度调度的前端信号）
// ---------------------------------------------------------------------------

/**
 * 下一条待提交消息是否来自语音识别（一次性）
 *
 * 为什么不改成 `sendMessage` 的显式参数：所有发送路径（输入框、语音自动提交、
 * steering、新会话首条）最终都收敛到 `App.submitToChat()`，而语音 hook 挂在
 * `Composer` 里。用一次性标记能避免给 `onSend / sendMessage / createNewChat`
 * 三处签名都加参数，也不会漏掉「无会话时自动建会话再发首条」这条路径。
 * 标记由 `submitToChat()` 消费一次后即清除，键盘输入不会误继承。
 */
let voiceOriginPending = false;

/** 标记下一条提交的消息来自语音识别 */
export function markVoiceOrigin(): void {
  voiceOriginPending = true;
}

/** 取出并清除语音来源标记 */
export function consumeVoiceOrigin(): boolean {
  const pending = voiceOriginPending;
  voiceOriginPending = false;
  return pending;
}

/** 仅供测试：清空标记，避免跨用例串扰 */
export function resetVoiceOriginForTesting(): void {
  voiceOriginPending = false;
}

/** 透传本轮思考深度决策，供延迟采样按档位分组 */
export function noteVoiceThinkDepth(depth: ThinkDepthSnapshot | null | undefined): void {
  if (!depth) return;
  // 可选调用：新旧 bundle 混跑时（voice-bus 已更新、useVoiceTalk 仍是旧版）
  // 遥测不该把整帧 llm_delta 抛掉——正文显示比埋点重要得多。
  current?.noteThinkDepth?.(depth);
}
