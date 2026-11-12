/**
 * 语音对话 hook：说话 + 朗读 + 打断 + 说完自动提交
 *
 * ## 职责边界
 *
 * 这个 hook 只管"音频 ↔ 文本"，**不管发送**。识别出文本后交给调用方决定
 * 是填进输入框还是直接发送——Composer 的发送路径里还有附件、@ 提及、
 * 流式占位等逻辑，语音不该另开一条。
 *
 * ## 三相位（对标 OpenClaw Talk Mode）
 *
 * `idle → listening → thinking → speaking → idle`。之前只有 `recording` /
 * `speaking` 两个布尔，中间那段时间（已松手、模型还在想、音频还没出声）在
 * UI 上是**完全空白**的：用户不知道是没听见、在思考、还是卡住了。
 * 显式的 `thinking` 相位就是补这一段——它不是一个动画，而是一个承诺：
 * "你的话我收到了，正在处理"。
 *
 * ## 免按住（hands-free）
 *
 * 点一下开始，说话时不必一直按着；麦克风侧检测到连续静音（默认 900ms）
 * 就自动收尾、识别、交给 `onUtterance`。判定逻辑在 `voice/endpointing.ts`。
 * 这是 OpenClaw Talk Mode 的核心体验：**用停顿表达"说完了"，而不是用手指**。
 *
 * 按住说话仍然可用（`startTalk` / `stopTalk` 语义不变），只是不再是唯一路径。
 *
 * ## 打断（barge-in）是一次事务
 *
 * 播报期间持续监测麦克风电平；连续 300ms 超过（阈值的 2 倍，抵消外放回声）
 * 就触发。一次打断同时撤三条链路：播放队列（含在飞 TTS）、在飞 ASR、
 * 在飞 LLM 生成（经 `voice-bus` 交给 App 发 `/interrupt`）。只停声音会让
 * 旧回复继续占住 session-pool 串行队列，新插话排在后面 → 越聊越迟钝。
 *
 * 免按住模式下打断即自动开录（用户正在说的这句继续收进去，说完自动提交）；
 * 按住说话模式不自动开录 —— 那种模式要求一直按着，自动开录只会让人莫名。
 *
 * 刻意**不复用** App 的 `stop()`：它带 `finishVoice()`，会把残句补念出来，
 * 而用户打断的意思正是「别念了」。
 *
 * 被打断时把「已说出来的部分」与 `turnId` 记进 `lastInterruption`。
 * 注意：服务端会话历史仍记完整回复文本，「只记实际听到的音频」需要改
 * 消息协议，属于 P1，当前**未实现**。
 *
 * ## 语音指令行
 *
 * 回复首行若是 `{"voice":..., "speed":..., "once":true}`，解析出来用于本次
 * 合成，并且**不朗读该行**（详见 `voice/directive.ts`）。
 *
 * ## 延迟埋点
 *
 * 每轮记录 `speechEnd → firstAudio`（TTFA）。验收标准是 < 1.5s，
 * 没有数字就没法验收，所以这里必须留痕而不是"感觉挺快"。
 *
 * @module web/voice/useVoiceTalk
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchSoulConfig,
  fetchVoiceStatus,
  saveSoulConfig,
  streamSpeech,
  synthesizeSpeech,
  transcribeAudio,
  type VoiceStatus,
} from "../api";
import { MicCapture, explainMicError } from "./mic";
import { MIN_BLOCK_UNITS, SpeechQueue } from "./player";
import { SentenceStream, isNewTurnText } from "./sentence";
import { scanVoiceDirective, settleVoiceDirective } from "./directive";
import { TurnDirective } from "./turn-directive";
import {
  defaultHandsFree,
  readAtomicChunk,
  readBackchannelHold,
  readEndpointProfile,
  readHandsFree,
  readSteadyBlocks,
  readStreamPlayback,
  subscribeHandsFree,
  writeHandsFree,
} from "./preference";
import { notifySoulConfigChanged, subscribeSoulConfigChanged } from "./config-events";
import { WakeListener } from "./wake-listener";
import { SILENCE_PEAK, isSignalAbsent, nextSmoothedLevel, quantizeLevel } from "./level";
import { takeWithinBudget } from "./speech-budget";
import { requestVoiceInterrupt } from "./voice-bus";
import {
  mergeLlmTiming,
  nowEpochMs,
  summarizeVoiceTurnLatency,
  type LlmStreamTiming,
  type ThinkDepthSnapshot,
  type VoiceTurnLatency,
  type VoiceTurnTiming,
} from "./latency";

/** 延迟样本保留条数（够看趋势，不至于无限增长） */
const LATENCY_SAMPLES = 10;

/** 用户说完时刻的有效期：超过就当陈旧值丢弃，不污染新轮次的分段延迟 */
const VOICE_TRACE_MAX_AGE_MS = 30_000;

/** thinking 相位的兜底时长：模型/链路异常时不至于永远显示「在想」 */
const THINKING_TIMEOUT_MS = 8000;

/** 开录后多久还没听到任何声音就提示「没检测到声音」 */
const NO_SIGNAL_HINT_MS = 2500;

/** 一轮延迟样本 */
export interface LatencySample {
  /** 用户说完 → 第一个音出声（毫秒，单调时钟原值） */
  ttfaMs: number;
  /**
   * 同一轮的分段延迟（epoch 时钟，可能缺段）
   *
   * 与 `ttfaMs` 口径不同、互为校验：前者稳定可比，后者回答「慢在哪一段」。
   * 非语音输入（打字）或缺 SSE 时序的旧服务端没有完整分段。
   */
  breakdown?: VoiceTurnLatency;
  /** 本轮思考深度档位（用于按档位分组统计 TTFT / E2E） */
  thinkDepth?: ThinkDepthSnapshot;
}

/**
 * 单条回复的朗读字数预算见 `voice/speech-budget.ts`：中文朗读约 200~250
 * 字/分钟，320 字约合 80~95 秒。超过这个长度，用户通常已经走神或转去读
 * 屏幕了——继续念只是占着麦克风、挡住下一轮对话。
 *
 * 超预算后不再入队，并在收尾时说一句「后面还有内容」，让用户知道不是
 * 被截断出错，而是可以自己看。要让模型少写，得靠陪伴模式的提示词约束；
 * 这里是最后一道保险，防止某次模型抽风写出两千字被完整念完。
 */

/** 语音相位 */
export type VoicePhase = "idle" | "listening" | "thinking" | "speaking";

/** 被打断的一次记录 */
export interface VoiceInterruption {
  /** 打断发生的时刻（performance.now） */
  at: number;
  /** 被打断前已经念出来的部分（可能是空串） */
  spokenText: string;
  /**
   * 本轮标识（仅前端记账）
   *
   * 为后续「历史只记用户实际听到的音频」留锚点。当前**尚未**把打断位置
   * 回注服务端会话历史 —— 那需要改消息协议，属于 P1，不要误以为已实现。
   */
  turnId: string;
}

/** hook 选项 */
export interface VoiceTalkOptions {
  /**
   * 免按住模式下识别出的完整一句话
   *
   * 只在静音自动收尾时回调；手动 `stopTalk` 的返回值仍由调用方自己处理，
   * 避免同一次说话被提交两遍。
   */
  onUtterance?: (text: string) => void;
  /** 免按住开关的初始值（缺省 true） */
  handsFree?: boolean;
}

/** hook 返回值 */
export interface VoiceTalk {
  /** 语音是否可用（配置开启 + 服务就绪） */
  available: boolean;
  /** 是否可用但未启用 */
  enabled: boolean;
  /** 是否正在录音 */
  recording: boolean;
  /** 是否正在播报 */
  speaking: boolean;
  /** 当前相位（UI 用它区分「在听」「在想」「在说」） */
  phase: VoicePhase;
  /** 实时电平（0..1，已平滑并量化到 12 档；静音时为 0） */
  level: number;
  /** 开录后一直没听到声音（提示用户查静音键 / 输入设备 / 占用） */
  noSignal: boolean;
  /** 是否免按住（点一下开始，静音自动提交） */
  handsFree: boolean;
  /** 语音链路状态（未探测为 null） */
  status: VoiceStatus | null;
  /** 最近若干轮 TTFA */
  latencies: readonly LatencySample[];
  /** 最近一次被打断的记录（未被打断为 null） */
  lastInterruption: VoiceInterruption | null;
  /** 错误提示（可执行文案） */
  error: string | null;
  /** 清空错误 */
  clearError: () => void;
  /** 开始录音 */
  startTalk: () => Promise<void>;
  /** 结束录音并返回识别文本（空文本返回 null） */
  stopTalk: () => Promise<string | null>;
  /** 免按住切换：没在录就开始，正在录就结束（返回识别文本） */
  toggleTalk: () => Promise<string | null>;
  /** 切换免按住开关 */
  setHandsFree: (value: boolean) => void;
  /** 朗读一段文本（内部按句切分） */
  speak: (text: string) => void;
  /** 喂流式增量（累积文本） */
  feed: (cumulative: string) => void;
  /** 本轮结束（吐出残句） */
  finishFeed: () => void;
  /**
   * 显式开启新一轮（用户发出新消息时调用）
   *
   * 与 `finishFeed` 的区别：它只复位轮次状态，不补念尾巴、不动队列。
   * 用于「上一轮的收尾事件可能缺席」时给状态机一个确定的起点。
   */
  beginTurn: () => void;
  /**
   * 记录本轮 LLM 时序（由 App 的 `llm_delta` 经语音总线透传）
   *
   * 只写时间戳，不改播放状态；语音关闭或旧服务端没有 timing 时为空操作。
   */
  noteLlmTiming: (timing: LlmStreamTiming) => void;
  /**
   * 记录本轮思考深度决策（由 App 的 `llm_delta` 经语音总线透传）
   *
   * 只写一份快照，不改播放状态；旧服务端没有该字段时为空操作。
   */
  noteThinkDepth: (depth: ThinkDepthSnapshot) => void;
  /** 停止播报（打断） */
  stopSpeaking: () => void;
  /** 是否自动朗读 */
  speakReplies: boolean;
  /**
   * 切换自动朗读（落盘到 soul 配置）
   *
   * 关掉时立刻停掉正在播的内容——只改开关不停音频的话，用户按了"关"
   * 却还在听它说话，会以为开关坏了。
   */
  setSpeakReplies: (next: boolean) => void;
  /** 是否开启了语音唤醒 */
  wakeEnabled: boolean;
  /** 是否正在等唤醒词 */
  wakeListening: boolean;
}

/**
 * 语音对话 hook
 *
 * @param options 选项（免按住回调等）
 * @returns 语音能力与操作
 */
export function useVoiceTalk(options: VoiceTalkOptions = {}): VoiceTalk {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [speakReplies, setSpeakRepliesState] = useState(true);
  const [recording, setRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [handsFree, setHandsFreeState] = useState(() => readHandsFree(options.handsFree ?? defaultHandsFree()));
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [latencies, setLatencies] = useState<LatencySample[]>([]);
  const [lastInterruption, setLastInterruption] = useState<VoiceInterruption | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 实时电平（量化后的 0..1）与「一直没声音」提示 */
  const [level, setLevel] = useState(0);
  const [noSignal, setNoSignal] = useState(false);
  /** 唤醒词与开关（来自服务端配置；默认关，用户显式打开才常驻监听） */
  const [wakeEnabled, setWakeEnabled] = useState(false);
  const [wakeWord, setWakeWord] = useState("");
  const [wakeListening, setWakeListening] = useState(false);

  const micRef = useRef<MicCapture | null>(null);
  const queueRef = useRef<SpeechQueue | null>(null);
  /**
   * 结构感知分块开关的**单份冻结快照**。
   *
   * `SpeechQueue` 在首次 `queue()` 时构造一次并长期复用，`SentenceStream`
   * 却每轮新建。若两处各自读 localStorage，用户中途改偏好就会出现
   * 「切句按新值、封块按旧值」的半生效状态。这里首次读一次后冻结，
   * 两条链路永远看到同一个值；改偏好需刷新页面（与其它队列级配置一致）。
   */
  const atomicChunkRef = useRef<boolean | null>(null);
  const wakeRef = useRef<WakeListener | null>(null);
  const streamRef = useRef<SentenceStream | null>(null);
  const stopMonitorRef = useRef<(() => void) | null>(null);
  const speechEndAtRef = useRef(0);
  const firstAudioRef = useRef(true);
  /** 本轮五时间戳（epoch ms，与 core 透传的 LLM 时序同一时钟） */
  const traceRef = useRef<VoiceTurnTiming>({});
  /** 本轮思考深度档位快照（随 TTFA 采样落盘） */
  const thinkDepthRef = useRef<ThinkDepthSnapshot | null>(null);
  /**
   * 用户说完的墙上时刻，等待下一轮 `feed` 采纳
   *
   * 不直接写 `traceRef`：`Composer.doSend()` 会调 `beginVoiceTurn()` →
   * `resetTurnState()`，而它发生在识别完成之后，会把整条 trace 清空。
   * 先在独立 ref 里过一道，首帧正文到达时再合并，并加 30s 新鲜度上限，
   * 避免 ASR 失败或切会话后残留的旧时刻污染下一轮。
   */
  const speechEndEpochRef = useRef(0);
  /** 最近一次喂入的累积文本（flush 需要它取残句） */
  const lastTextRef = useRef("");
  /**
   * 本轮喂过的**原始**累积文本（未剥首行指令）
   *
   * 用它识别轮次边界：`llm_delta.previewText` 在同一轮里单调递增且前缀稳定，
   * 一旦回退或前缀对不上就是新回复。不能拿 `lastTextRef` 代替——那是剥掉
   * 指令行之后的正文，长度与原文不同。
   */
  const turnTextRef = useRef("");
  /** 本轮已送去合成的字数（对着 `voice/speech-budget.ts` 的预算记账） */
  const spokenCharsRef = useRef(0);
  /** 本轮是否已经因为预算而截断（收尾时补一句提示） */
  const truncatedRef = useRef(false);
  /**
   * 本轮是否已被用户打断
   *
   * 打断只停音频是不够的：模型还在流式输出，下一条 `feed` 会带来新句子，
   * 而 `enqueue` 内部会把 `stopped` 重置为 false —— 于是刚被打断的回复
   * 又接着念起来，用户会觉得"它根本没听我的"。这里在 feed 入口做闸门，
   * 让本轮的后续内容一律不再送合成。
   */
  const interruptedRef = useRef(false);
  /** 打断后自动开录的入口（startTalk 定义在后面，用 ref 打破循环依赖） */
  const startTalkRef = useRef<(() => Promise<void>) | null>(null);
  /** 在飞的 ASR 请求（打断事务里要一并取消，见 startBargeIn） */
  const asrAbortRef = useRef<AbortController | null>(null);
  /** 前端轮次序号，用于给打断记录一个稳定的 turnId */
  const turnSeqRef = useRef(0);
  /**
   * 语音指令状态（跨轮默认 + 本轮快照）
   *
   * 语义细节见 `voice/turn-directive.ts`：核心是「本轮快照在合成前不被清掉」，
   * 否则同一回复的后半段会换音色/换语速。
   */
  const turnDirective = useRef(new TurnDirective());
  /** 首行指令的解析状态：unknown=还没判断，resolved=已判断 */
  const directiveStateRef = useRef<"unknown" | "resolved">("unknown");
  /** 首行指令被剥掉后，正文在累积文本里的起点 */
  const directivePrefixRef = useRef(0);
  /** options 的稳定引用（避免把回调塞进 useCallback 依赖导致整链重建） */
  const optionsRef = useRef(options);
  optionsRef.current = options;
  /** 免按住开关的最新值（打断回调里要读，不能用闭包里的旧 state） */
  const handsFreeRef = useRef(handsFree);
  handsFreeRef.current = handsFree;
  /** 播报开关的最新值（设置页会绕过 setSpeakReplies 直接落盘） */
  const speakRepliesRef = useRef(speakReplies);
  speakRepliesRef.current = speakReplies;

  /** thinking 兜底定时器 */
  const thinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 电平可视化用的一组 ref
   *
   * 全部走 ref 而不是 state，是因为 `onLevel` 每 50ms 被调一次：如果每帧都
   * setState，整个 Composer（千行级）要重渲染 20 次/秒，打字会明显发涩。
   * 这里的策略是「ref 里算、只在跨档时 setState」——静音时一次都不触发。
   */
  const levelSmoothRef = useRef(0);
  const levelBucketRef = useRef(0);
  const levelPeakRef = useRef(0);
  const noSignalRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 清掉「没检测到声音」的定时器 */
  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  /** 重置电平可视化状态（开录/收尾各一次） */
  const resetLevelMeter = useCallback(() => {
    clearSilenceTimer();
    levelSmoothRef.current = 0;
    levelBucketRef.current = 0;
    levelPeakRef.current = 0;
    noSignalRef.current = false;
    setLevel(0);
    setNoSignal(false);
  }, [clearSilenceTimer]);

  /**
   * 采集电平的一帧
   *
   * 顺序有讲究：先记峰值、再判「声音回来了」、最后才更新条高。这样一旦用户
   * 开口，提示语会立刻撤掉，而不是等这一段录完。
   *
   * @param rms 本帧原始 RMS（来自 `MicCapture`）
   */
  const handleLevel = useCallback((rms: number) => {
    if (rms > levelPeakRef.current) levelPeakRef.current = rms;
    if (noSignalRef.current && rms >= SILENCE_PEAK) {
      // 声音回来了：提示必须马上消失，否则会和"条在动"自相矛盾
      noSignalRef.current = false;
      setNoSignal(false);
    }
    const smoothed = nextSmoothedLevel(levelSmoothRef.current, rms);
    levelSmoothRef.current = smoothed;
    const bucket = quantizeLevel(smoothed);
    if (bucket !== levelBucketRef.current) {
      levelBucketRef.current = bucket;
      setLevel(bucket);
    }
  }, []);

  /** 写入免按住偏好（设置面板与输入框共用同一份存储） */
  const setHandsFree = useCallback((value: boolean) => {
    setHandsFreeState(value);
    writeHandsFree(value);
  }, []);

  /** 跟随设置面板的改动（同页事件 + 跨标签页 storage） */
  useEffect(() => subscribeHandsFree(setHandsFreeState), []);

  /** 结构感知分块开关：首次读取后冻结，供队列与切句器共用 */
  const atomicChunk = useCallback((): boolean => {
    if (atomicChunkRef.current === null) atomicChunkRef.current = readAtomicChunk();
    return atomicChunkRef.current;
  }, []);

  /** 懒建队列（合成函数依赖后端，但只建一次） */
  const queue = useCallback((): SpeechQueue => {
    if (queueRef.current === null) {
      /**
       * 本轮语音指令覆盖（voice / engine / speed）
       *
       * 读本轮快照而不是跨轮默认：见 TurnDirective 的说明。整块与流式两条
       * 路径必须共用它，否则同一回复里关掉流式会换音色。
       */
      const voiceOverride = () => {
        const active = turnDirective.current.current();
        return active === null
          ? undefined
          : {
              ...(active.voice !== undefined ? { voice: active.voice } : {}),
              ...(active.engine !== undefined ? { engine: active.engine } : {}),
              ...(active.speed !== undefined ? { speed: active.speed } : {}),
            };
      };
      queueRef.current = new SpeechQueue(
        (text, signal) =>
          synthesizeSpeech(text, voiceOverride(), signal).then((url) => {
            // 整块模式：整段 WAV 到手即「首字节」；流式模式在下面按首块记
            if (traceRef.current.ttsFirstByteAtMs === undefined) {
              traceRef.current.ttsFirstByteAtMs = nowEpochMs();
            }
            return url;
          }),
        {
          onSpeakingChange: (value) => {
            setSpeaking(value);
            if (value) {
              setWaiting(false);
              if (thinkingTimerRef.current !== null) {
                clearTimeout(thinkingTimerRef.current);
                thinkingTimerRef.current = null;
              }
              if (firstAudioRef.current && speechEndAtRef.current > 0) {
                // 首个音开始播 → 记录 TTFA（单调时钟）与同一轮的分段延迟
                const ttfaMs = Math.round(performance.now() - speechEndAtRef.current);
                firstAudioRef.current = false;
                traceRef.current.firstAudioAtMs = nowEpochMs();
                const breakdown = summarizeVoiceTurnLatency(traceRef.current);
                const thinkDepth = thinkDepthRef.current ?? undefined;
                setLatencies((prev) => [
                  ...prev.slice(-(LATENCY_SAMPLES - 1)),
                  { ttfaMs, breakdown, ...(thinkDepth ? { thinkDepth } : {}) },
                ]);
              }
            }
          },
          onError: (message) => setError(message),
          onNotice: (message) => {
            // 采样级播放不可用时的降级说明：这不是故障（声音照常出），
            // 弹红条只会让人以为语音坏了，所以只记控制台
            console.warn("语音播报降级", message);
          },
          onInterrupted: (spokenText) => {
            turnSeqRef.current += 1;
            setLastInterruption({
              at: performance.now(),
              spokenText,
              turnId: `voice-turn-${turnSeqRef.current}`,
            });
          },
        },
        {
          /**
           * 长文本护栏：低于 10 等效发音单元的碎片不单独发合成请求。
           * 实测几字块会被模型当短促感叹句（F0 冲到 300Hz、语速翻倍），
           * 是长回复「忽然换人」的主要来源。首块仍按 14 字豁免保 TTFA。
           */
          minBlockUnits: MIN_BLOCK_UNITS,
          /**
           * 稳态分块（第十四轮，**默认关的灰度项**）：首块 32 字、所有块
           * 下限 30 字。真机 A/B 是双向的（纯中文 1↔2 改善 52% 但 2↔3 退化，
           * 中英混排整体退化），不足以改默认，故由设备偏好显式开启。
           * `dcx.voice.steadyBlocks.v1` 写 "1" 开启，写 "0"/删除即回退 v13。
           */
          steadyBlocks: readSteadyBlocks(),
          /**
           * 结构感知分块：默认关。偏好 `dcx.voice.atomicChunk.v1` 打开后，
           * 切句与封块都不再切断 JSON / URL / 拉丁词 / 数字串，让服务端
           * TNS 能看到完整结构。关闭时与 031f1cc2 逐字一致。
           */
          atomicChunk: atomicChunk(),
          /**
           * 流式合成：模型每解出一小段就交给队列排程，首字延迟从"整段
           * 生成完"降到"第一块到达"。返回 0 块表示开关关了，队列会静默
           * 回退整块合成，不需要这里报错。
           */
          streamSynth: (text, onChunk, signal) => {
            if (!readStreamPlayback()) return Promise.resolve(0);
            let first = true;
            return streamSpeech(
              text,
              (url, index) => {
                if (first) {
                  first = false;
                  if (traceRef.current.ttsFirstByteAtMs === undefined) {
                    traceRef.current.ttsFirstByteAtMs = nowEpochMs();
                  }
                }
                onChunk(url, index);
              },
              voiceOverride(),
              signal
            );
          },
        }
      );
    }
    return queueRef.current;
  }, [atomicChunk]);

  /**
   * 拉取配置与链路状态
   *
   * 进入页面时一次；之后由设置页的变更事件触发重读——语音开关与唤醒开关
   * 必须立刻生效，否则会出现「界面说开了、实际没在听」。
   */
  const syncConfig = useCallback(() => {
    let cancelled = false;
    Promise.all([fetchSoulConfig(), fetchVoiceStatus().catch(() => null)])
      .then(([config, voiceStatus]) => {
        if (cancelled) return;
        // 设置页的「自动朗读回复」直接落盘，不经过本 hook 的 setSpeakReplies，
        // 关→开时没有清打断标记：这里补一次，否则界面显示开、实际整轮静默。
        if (config.voice.speakReplies && !speakRepliesRef.current) {
          interruptedRef.current = false;
          truncatedRef.current = false;
        }
        setEnabled(config.voice.enabled);
        setSpeakRepliesState(config.voice.speakReplies);
        setWakeEnabled(config.voice.wakeEnabled);
        setWakeWord(config.voice.wakeWord);
        setStatus(voiceStatus);
        setAvailable(voiceStatus !== null && voiceStatus.reachable && voiceStatus.asr.ready && voiceStatus.tts.ready);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(syncConfig, [syncConfig]);

  /** 设置页保存成功后重读配置（同页即时生效） */
  useEffect(() => subscribeSoulConfigChanged(() => void syncConfig()), [syncConfig]);

  /**
   * 播报期间开启打断监测
   *
   * 不做成"播报回调里启动"：那会让 `queue` 与 `startBargeIn` 互相依赖，
   * 变成先有鸡还是先有蛋。改用 `speaking` 状态驱动的 effect，依赖方向单向。
   *
   * ## 打断之后做什么（2026-11-05 改成真正的插话）
   *
   * 原来只做 `queue.stop()`：用户得再点一次麦克风才能说话，"插话"断成两截。
   * 现在免按住模式（hands-free）下打断即开录——用户正在说的这句话会继续被
   * 收进去，说完停顿自动提交，这才是自然的插话。
   *
   * 按住说话模式（handsFree=false）不自动开录：那种模式下录音要求一直按着，
   * 自动开录只会让用户莫名其妙。
   */
  const startBargeIn = useCallback(async () => {
    if (micRef.current === null) micRef.current = new MicCapture();
    try {
      stopMonitorRef.current = await micRef.current.startMonitor(
        () => {
          // 一次打断是**事务**：同时撤掉播放、在飞 ASR、在飞 LLM 三条链路。
          // 只停声音会让旧回复继续生成并占住 session-pool 串行队列，
          // 用户紧接着插话时新消息排在旧轮后面，表现成「越聊越迟钝」。
          queueRef.current?.stop();
          asrAbortRef.current?.abort();
          requestVoiceInterrupt();
          setSpeaking(false);
          interruptedRef.current = true;
          if (handsFreeRef.current) void startTalkRef.current?.();
        },
        // 回馈语 HOLD 默认关：开启会多等 200ms，由用户真机 A/B 决定
        { holdBackchannels: readBackchannelHold() }
      );
    } catch {
      // 麦克风不可用时不阻断播报：只是没有打断能力
    }
  }, []);

  /** 停打断监测 */
  const stopBargeIn = useCallback(() => {
    stopMonitorRef.current?.();
    stopMonitorRef.current = null;
  }, []);

  /** 播报开始 → 监测打断；播报结束 → 关监测（省电、避免无谓占用麦克风） */
  useEffect(() => {
    if (!speaking) {
      stopBargeIn();
      return;
    }
    void startBargeIn();
  }, [speaking, startBargeIn, stopBargeIn]);

  /** 结束录音并识别 */
  const stopTalk = useCallback(async (): Promise<string | null> => {
    setRecording(false);
    resetLevelMeter();
    const mic = micRef.current;
    if (mic === null) return null;
    // 用户说完的时刻（端到端延迟的起点）；由下一轮 feed 采纳，见 ref 注释
    speechEndEpochRef.current = nowEpochMs();
    // 识别本身就是「在想」：从这一刻起 UI 该有反馈
    setWaiting(true);
    // 打断事务：新的一轮说话顶掉仍在飞的旧 ASR，避免两轮识别结果交错。
    // 打断回调也会 abort 同一个 controller（见 startBargeIn）。
    const abort = new AbortController();
    asrAbortRef.current?.abort();
    asrAbortRef.current = abort;
    try {
      const wav = await mic.stopRecording();
      const result = await transcribeAudio(wav, abort.signal);
      const text = result.text.trim();
      if (text.length < 2) {
        setWaiting(false);
        setError("没听清，再说一次？");
        return null;
      }
      return text;
    } catch (e: unknown) {
      setWaiting(false);
      // 主动取消不是错误：打断后用户马上要说下一句，弹红条只会挡路
      if (abort.signal.aborted) return null;
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      if (asrAbortRef.current === abort) asrAbortRef.current = null;
    }
  }, [resetLevelMeter]);

  /** 开始录音 */
  const startTalk = useCallback(async () => {
    setError(null);
    queue().stop();
    stopBargeIn();
    resetLevelMeter();
    if (micRef.current === null) micRef.current = new MicCapture();
    try {
      const onMaxDuration = () => {
        // 到达上限自动收尾，走同一条 stopTalk 路径由调用方处理
        setRecording(false);
      };
      const handsFreeOptions = handsFree
        ? {
            // 免按住：静音即收尾，识别完直接交给调用方提交
            // 成功后**不清** thinking：真正的下一站是模型回复（播报开始的
            // onSpeakingChange 会清掉），中间这段等待本来就该显示"在想"。
            onEndpoint: () => {
              void stopTalk().then((text) => {
                if (text === null) {
                  setWaiting(false);
                  return;
                }
                optionsRef.current.onUtterance?.(text);
              });
            },
            // 动态判停档位：默认 adaptive（正常句 600ms，短语/长叙述仍 900ms）。
            // 没有流式 ASR 就没有语义判停，只能按已说时长保守近似；
            // localStorage 设 legacy 可完整回滚、fast 供真机 A/B。
            endpoint: { profile: readEndpointProfile() },
          }
        : {};
      await micRef.current.startRecording(onMaxDuration, { onLevel: handleLevel, ...handsFreeOptions });
      setRecording(true);
      // 开录一段时间后仍然一点声音都没有：多半是静音键、选错设备或被占用。
      // 这条提示只在真的没信号时出现，用户一开口就撤（见 handleLevel）。
      clearSilenceTimer();
      silenceTimerRef.current = setTimeout(() => {
        silenceTimerRef.current = null;
        if (isSignalAbsent(levelPeakRef.current)) {
          noSignalRef.current = true;
          setNoSignal(true);
        }
      }, NO_SIGNAL_HINT_MS);
    } catch (e: unknown) {
      setError(explainMicError(e));
      setRecording(false);
      resetLevelMeter();
    }
  }, [queue, stopBargeIn, stopTalk, handsFree, handleLevel, resetLevelMeter, clearSilenceTimer]);
  // 打断回调要用到最新的 startTalk（它依赖 handsFree 等 state，不能进 [] 依赖）
  startTalkRef.current = startTalk;

  /** 免按住切换 */
  const toggleTalk = useCallback(async (): Promise<string | null> => {
    if (recording) return stopTalk();
    await startTalk();
    return null;
  }, [recording, startTalk, stopTalk]);

  /**
   * 语音唤醒：常驻监听 → 命中唤醒词 → 直接开录
   *
   * 只在「真的能听」的时候挂着：语音已启用、链路可达、且当前没在录音/播报。
   * 录音或播报一开始就把监听拆掉——两台采集器抢同一个麦克风，
   * 而且用户此刻已经在对话里，不需要再唤醒一次。
   *
   * 命中之后走 `startTalk()` 而不是自己录：唤醒只是"替用户点一下麦克风"，
   * 后续的静音收尾、识别、提交全复用同一条路径，避免两套逻辑各说各话。
   */
  useEffect(() => {
    const shouldListen = wakeEnabled && enabled && available && !recording && !speaking && wakeWord.length > 0;
    if (!shouldListen) {
      wakeRef.current?.stop();
      wakeRef.current = null;
      setWakeListening(false);
      return;
    }
    if (wakeRef.current?.listening === true) return;

    const listener = new WakeListener({
      transcribe: async (audio) => (await transcribeAudio(audio)).text.trim(),
      wakeWord,
      onWake: () => {
        setWakeListening(false);
        void startTalk();
      },
      onError: (message) => {
        setWakeListening(false);
        setError(`语音唤醒已停止：${message}`);
      },
    });
    wakeRef.current = listener;
    setWakeListening(true);
    void listener.start().then(() => {
      // start() 内部失败会置为未监听，这里同步一下状态
      if (!listener.listening) setWakeListening(false);
    });
    return () => {
      listener.stop();
      if (wakeRef.current === listener) wakeRef.current = null;
      setWakeListening(false);
    };
  }, [wakeEnabled, enabled, available, recording, speaking, wakeWord, startTalk]);

  /**
   * 送去合成（带字数预算）
   *
   * 为什么不直接把句子丢给 queue：一条长回复切出来可能有几十句，全念完
   * 要几分钟。用户在语音场景里等不了那么久，也没必要——屏幕上有全文。
   *
   * 超预算时不再入队，只置标记；收尾时由 `finishFeed` 补一句说明。
   *
   * @param sentence 已剥 Markdown 的句子
   */
  const enqueueForSpeech = useCallback(
    (sentence: string) => {
      if (truncatedRef.current) return;
      const slice = takeWithinBudget(sentence, spokenCharsRef.current);
      spokenCharsRef.current = slice.used;
      // 这句被截断 / 预算已用尽：后面的都不念了
      if (slice.exhausted) truncatedRef.current = true;
      if (slice.text.length > 0) queue().enqueue(slice.text);
    },
    [queue]
  );

  /**
   * 复位一轮的所有流式状态（不补念、不碰队列、不切换音色快照）
   *
   * 这是「聊多了就不说话」的总闸。原先只有 `finishFeed()` 做复位，而它只挂在
   * `assistant_message` 一条 SSE 事件上：工具轮（引擎丢弃 visible=false）、
   * 用户打断、断线重连、切会话都可能让这一帧缺席。只要缺一次，
   * `SentenceStream` 的游标就停在上一轮末尾；下一轮文本更短时切句器循环
   * 一次都不进，连一次 TTS 请求都不会发，并且会**持续静默很多轮**。
   *
   * 这里刻意不动 `turnDirective`：本轮快照要留到队列里剩下的句子都合成完，
   * 提前 `beginTurn()` 会让同一回复的后半段换音色/换语速。`feed` 在真正
   * 新建切句器时才冻结新快照。
   */
  const resetTurnState = useCallback(() => {
    traceRef.current = {};
    thinkDepthRef.current = null;
    streamRef.current = null;
    turnTextRef.current = "";
    lastTextRef.current = "";
    directiveStateRef.current = "unknown";
    directivePrefixRef.current = 0;
    spokenCharsRef.current = 0;
    truncatedRef.current = false;
    // 打断只作用于本轮：新一轮必须放行，否则标记会跨轮残留
    interruptedRef.current = false;
    // TTFA 基准由下一次 feed 重新起算，不把上一次发送的耗时算进来
    speechEndAtRef.current = 0;
    firstAudioRef.current = true;
  }, []);

  /**
   * 记录 LLM 时序（SSE → 语音总线 → 这里）
   *
   * 只写时间戳，不改播放状态。用 `mergeLlmTiming` 纯函数合并，首帧只带
   * `startedAtMs` 也安全：后续带 `firstContentMs` 的帧会补上首正文时刻。
   */
  const noteLlmTiming = useCallback((timing: LlmStreamTiming): void => {
    traceRef.current = mergeLlmTiming(traceRef.current, timing);
  }, []);

  /** 记录本轮思考深度（同一轮多帧 SSE 只保留最后一份，字段相同） */
  const noteThinkDepth = useCallback((depth: ThinkDepthSnapshot): void => {
    thinkDepthRef.current = depth;
  }, []);

  /** 朗读文本 */
  const speak = useCallback(
    (text: string) => {
      if (!available || !speakReplies) return;
      const stream = new SentenceStream(atomicChunk());
      streamRef.current = stream;
      directiveStateRef.current = "unknown";
      directivePrefixRef.current = 0;
      spokenCharsRef.current = 0;
      truncatedRef.current = false;
      // 显式朗读（如点「重播」）要清掉上一轮的打断标记，否则一句都不念
      interruptedRef.current = false;
      for (const sentence of stream.flush(text)) enqueueForSpeech(sentence);
      // 整段文本一次给完：告诉队列"没有更多句子了"，否则最后不满一块的
      // 尾巴会一直等下一句（见 SpeechQueue.flush 的说明）
      queue().flush();
      // 整段朗读完就不再留着这个流：否则下一次对话的 feed 会复用它的游标，
      // 而游标已经停在本文末尾，新一轮更短的文本会一句都切不出来。
      streamRef.current = null;
      turnTextRef.current = "";
      lastTextRef.current = "";
      speechEndAtRef.current = performance.now();
      firstAudioRef.current = true;
      // 显式朗读/重播没有「用户说完」时刻，别把上一次语音输入的旧值算进来
      speechEndEpochRef.current = 0;
    },
    [available, speakReplies, enqueueForSpeech, queue, atomicChunk]
  );

  /** 喂流式增量（累积文本） */
  const feed = useCallback(
    (cumulative: string) => {
      if (!available || !speakReplies) return;
      // 空帧直接跳过：`start` 阶段的累积文本是空串，喂进去会白白新建一个
      // SentenceStream 并把 speechEndAt 重置一次，把 TTFA 埋点算成全 0。
      if (cumulative.length === 0) return;

      // 轮次边界自检（不依赖 SSE 收尾事件）：累积文本回退 / 前缀对不上，
      // 说明已经是一条新回复。先复位再放行，缺了上一轮 finishFeed 也不会
      // 把游标、打断标记、字数预算残留到这一轮。判断必须在 interruptedRef
      // 闸门之前——被打断那轮的后续帧仍属同一轮，但下一轮必须解除打断。
      if (isNewTurnText(turnTextRef.current, cumulative)) resetTurnState();
      turnTextRef.current = cumulative;

      // 本轮已被打断：模型剩下的内容不再送合成（否则 enqueue 会把 stopped
      // 重置回 false，刚被打断的回复又念起来）
      if (interruptedRef.current) return;
      if (streamRef.current === null) {
        streamRef.current = new SentenceStream(atomicChunk());
        directiveStateRef.current = "unknown";
        directivePrefixRef.current = 0;
        // 新一轮开始：朗读预算与截断标记都归零
        spokenCharsRef.current = 0;
        truncatedRef.current = false;
        // 新一轮开始：把跨轮默认（可能为 null）重新冻结成本轮快照。
        // 上一轮的 once 指令已在这里失效，不会被这一轮继承。
        turnDirective.current.beginTurn();
        speechEndAtRef.current = performance.now();
        firstAudioRef.current = true;
        // 采纳本轮「用户说完」时刻；打字轮次没有，分段延迟如实留空
        const spokenAt = speechEndEpochRef.current;
        speechEndEpochRef.current = 0;
        if (spokenAt > 0 && nowEpochMs() - spokenAt <= VOICE_TRACE_MAX_AGE_MS) {
          traceRef.current.speechEndAtMs = spokenAt;
        }
      }

      // 首行指令：必须先判定「这行要不要念」，否则用户会听到一串 JSON
      let body = cumulative;
      if (directiveStateRef.current === "unknown") {
        const scan = scanVoiceDirective(cumulative);
        if (scan.kind === "pending") {
          // 首行还没收完：挂起，等下一批增量（此时一个字都不送 TTS）
          return;
        }
        directiveStateRef.current = "resolved";
        if (scan.kind === "applied") {
          // 本轮立刻生效：首句就是指令之后的正文，不能等下一轮
          turnDirective.current.apply(scan.directive);
          body = scan.text;
          directivePrefixRef.current = cumulative.length - scan.text.length;
        }
      } else if (directivePrefixRef.current > 0) {
        body = cumulative.slice(directivePrefixRef.current);
      }

      lastTextRef.current = body;
      for (const sentence of streamRef.current.push(body)) enqueueForSpeech(sentence);
    },
    [available, speakReplies, enqueueForSpeech, resetTurnState, atomicChunk]
  );

  /**
   * 本轮收尾：把最后一句没断句符的尾巴也读出来
   *
   * 必须传入完整的累积文本——`flush` 需要它才能取出游标之后的残句。
   * 传空串会让最后一句永远不播（这是流式播报最容易漏的一处）。
   */
  const finishFeed = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    // 收尾后本轮的累积文本基线必须清空，否则下一轮第一帧会被误判成
    // 「同轮回退」，白白多复位一次（不影响播报，但会破坏 TTFA 埋点）。
    turnTextRef.current = "";

    // 本轮到此结束：被打断标记只作用于本轮，下一轮要重新放行。
    // **必须无条件复位**：feed 被 interruptedRef 拦住时 streamRef 可能一直是
    // null，若在下面 `stream === null` 处提前 return，标记会永久卡住，
    // 之后每一轮回复都不播报、连一次 TTS 请求都不发（"完全没有声音"）。
    // 放在这里而不是 feed 开头，是因为被打断后 feed 会一路 return，
    // 永远走不到重置点。
    const interrupted = interruptedRef.current;
    interruptedRef.current = false;

    if (stream === null) return;

    let body = lastTextRef.current;
    if (directiveStateRef.current === "unknown") {
      // 整段都没有换行：再试一次是不是「一行指令」，解析不了就当正文念
      const settled = settleVoiceDirective(body);
      if (settled.kind === "applied") {
        turnDirective.current.apply(settled.directive);
        body = settled.text;
      }
      directiveStateRef.current = "resolved";
    }

    // 被打断就不补念尾巴了——用户已经明确不要听
    if (!interrupted) {
      for (const sentence of stream.flush(body)) enqueueForSpeech(sentence);
      // 因字数预算没念完：补一句说明，别让用户以为语音坏了
      if (truncatedRef.current) {
        truncatedRef.current = false;
        queue().enqueue("后面还有内容，我已经放到屏幕上了。");
      }
      // 本轮句子流到此结束：让队列把剩下的句子封块合成，否则最后一块
      // 不满目标字数时会一直等"下一句"而永远不播
      queue().flush();
    }
    lastTextRef.current = "";

    // once 的指令只影响这一条回复：清的是**跨轮默认**，不是本轮快照。
    // 本轮快照要留到队列里剩下的句子都合成完（下一轮 feed 才重置），
    // 否则「清得太早」会让同一回复的后半段换音色/换语速。
    turnDirective.current.endTurn();
  }, [enqueueForSpeech, queue]);

  /** 停止播报 */
  const stopSpeaking = useCallback(() => {
    // 手动停也视为打断：模型剩下的内容不该接着念
    interruptedRef.current = true;
    queue().stop();
    setSpeaking(false);
  }, [queue]);

  /**
   * 一键开关语音播报
   *
   * 三件事的先后顺序是有意的：
   * 1. **先本地翻状态**——按钮必须立刻响应，等一个 RTT 才变色会让人重复点；
   * 2. **关掉时先停音频**——「按了关还在念」是最刺眼的失败；
   * 3. **再落盘**——失败则回滚并报错，不能让界面显示关着而配置还是开。
   *
   * 重新打开时要清掉 `interruptedRef`：关闭走的是 stopSpeaking()，它会把
   * 本轮标记为"已打断"。若这之后没有一次完整回复来触发 finishFeed，标记
   * 会残留，下一轮 feed 全部被拦——表现为开关明明是开、却永远没声音。
   * 打断只该作用于**本轮**，新的一次开启就是新的一轮。
   *
   * 落盘成功后广播 `dcx:soul-config-changed`，人设面板与其它用到配置的
   * 地方会各自重读，不会出现两处开关互相打脸。
   */
  const setSpeakReplies = useCallback(
    (next: boolean) => {
      setSpeakRepliesState(next);
      if (!next) stopSpeaking();
      else interruptedRef.current = false;
      saveSoulConfig({ voice: { speakReplies: next } })
        .then(() => notifySoulConfigChanged())
        .catch((error: unknown) => {
          setSpeakRepliesState(!next);
          setError(`语音播报开关保存失败：${error instanceof Error ? error.message : String(error)}`);
        });
    },
    [stopSpeaking]
  );

  /** thinking 兜底：超过上限自动落回 idle，避免一直显示「在想」 */
  useEffect(() => {
    if (!waiting) {
      if (thinkingTimerRef.current !== null) {
        clearTimeout(thinkingTimerRef.current);
        thinkingTimerRef.current = null;
      }
      return;
    }
    thinkingTimerRef.current = setTimeout(() => setWaiting(false), THINKING_TIMEOUT_MS);
    return () => {
      if (thinkingTimerRef.current !== null) {
        clearTimeout(thinkingTimerRef.current);
        thinkingTimerRef.current = null;
      }
    };
  }, [waiting]);

  /** 卸载时释放麦克风与音频 */
  useEffect(() => {
    return () => {
      queueRef.current?.stop();
      micRef.current?.release();
      if (silenceTimerRef.current !== null) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
    };
  }, []);

  /** 相位：说的话 > 在想 > 在说（录音中不会再播报，顺序天然互斥） */
  const phase: VoicePhase = recording ? "listening" : waiting ? "thinking" : speaking ? "speaking" : "idle";

  return {
    available,
    enabled,
    recording,
    speaking,
    phase,
    level,
    noSignal,
    handsFree,
    status,
    latencies,
    lastInterruption,
    error,
    clearError: () => setError(null),
    startTalk,
    stopTalk,
    toggleTalk,
    setHandsFree,
    speak,
    feed,
    finishFeed,
    beginTurn: resetTurnState,
    noteLlmTiming,
    noteThinkDepth,
    stopSpeaking,
    speakReplies,
    setSpeakReplies,
    wakeEnabled,
    wakeListening,
  };
}
