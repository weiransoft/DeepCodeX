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
 * ## 打断（barge-in）怎么落地
 *
 * 播报期间持续监测麦克风电平；连续 300ms 超过（阈值的 2 倍，抵消外放回声）
 * 就停播并回调。停播后**不自动开始录音**——用户可能只是路过说了句话，
 * 直接开录会显得很唐突，改为由 UI 提示"继续按住说话"。
 *
 * 被打断时把「已说出来的部分」记进 `lastInterruption`：UI 可以据此提示
 * 「上一句没说完」，也为将来把打断时间戳送进下一轮 prompt 留好出口。
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
import { fetchSoulConfig, fetchVoiceStatus, synthesizeSpeech, transcribeAudio, type VoiceStatus } from "../api";
import { MicCapture, explainMicError } from "./mic";
import { SpeechQueue } from "./player";
import { SentenceStream } from "./sentence";
import { scanVoiceDirective, settleVoiceDirective } from "./directive";
import { TurnDirective } from "./turn-directive";
import { defaultHandsFree, readHandsFree, subscribeHandsFree, writeHandsFree } from "./preference";
import { subscribeSoulConfigChanged } from "./config-events";
import { WakeListener } from "./wake-listener";
import { SILENCE_PEAK, isSignalAbsent, nextSmoothedLevel, quantizeLevel } from "./level";
import { takeWithinBudget } from "./speech-budget";

/** 延迟样本保留条数（够看趋势，不至于无限增长） */
const LATENCY_SAMPLES = 10;

/** thinking 相位的兜底时长：模型/链路异常时不至于永远显示「在想」 */
const THINKING_TIMEOUT_MS = 8000;

/** 开录后多久还没听到任何声音就提示「没检测到声音」 */
const NO_SIGNAL_HINT_MS = 2500;

/** 一轮延迟样本 */
export interface LatencySample {
  /** 用户说完 → 第一个音出声（毫秒） */
  ttfaMs: number;
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
  /** 停止播报（打断） */
  stopSpeaking: () => void;
  /** 是否自动朗读 */
  speakReplies: boolean;
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
  const [speakReplies, setSpeakReplies] = useState(true);
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
  const wakeRef = useRef<WakeListener | null>(null);
  const streamRef = useRef<SentenceStream | null>(null);
  const stopMonitorRef = useRef<(() => void) | null>(null);
  const speechEndAtRef = useRef(0);
  const firstAudioRef = useRef(true);
  /** 最近一次喂入的累积文本（flush 需要它取残句） */
  const lastTextRef = useRef("");
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

  /** 懒建队列（合成函数依赖后端，但只建一次） */
  const queue = useCallback((): SpeechQueue => {
    if (queueRef.current === null) {
      queueRef.current = new SpeechQueue(
        (text) => {
          // 读本轮快照而不是跨轮默认：见 TurnDirective 的说明
          const active = turnDirective.current.current();
          // 指令里的 voice / engine / speed 覆盖配置值；没有指令时走服务端配置
          return synthesizeSpeech(
            text,
            active === null
              ? undefined
              : {
                  ...(active.voice !== undefined ? { voice: active.voice } : {}),
                  ...(active.engine !== undefined ? { engine: active.engine } : {}),
                  ...(active.speed !== undefined ? { speed: active.speed } : {}),
                }
          );
        },
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
                // 首个音开始播 → 记录 TTFA（说话结束到出声的真实间隔）
                const ttfaMs = Math.round(performance.now() - speechEndAtRef.current);
                firstAudioRef.current = false;
                setLatencies((prev) => [...prev.slice(-(LATENCY_SAMPLES - 1)), { ttfaMs }]);
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
            setLastInterruption({ at: performance.now(), spokenText });
          },
        }
      );
    }
    return queueRef.current;
  }, []);

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
        setEnabled(config.voice.enabled);
        setSpeakReplies(config.voice.speakReplies);
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
      stopMonitorRef.current = await micRef.current.startMonitor(() => {
        queueRef.current?.stop();
        setSpeaking(false);
        interruptedRef.current = true;
        if (handsFreeRef.current) void startTalkRef.current?.();
      });
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
    // 识别本身就是「在想」：从这一刻起 UI 该有反馈
    setWaiting(true);
    try {
      const wav = await mic.stopRecording();
      const result = await transcribeAudio(wav);
      const text = result.text.trim();
      if (text.length < 2) {
        setWaiting(false);
        setError("没听清，再说一次？");
        return null;
      }
      return text;
    } catch (e: unknown) {
      setWaiting(false);
      setError(e instanceof Error ? e.message : String(e));
      return null;
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
      const endpoint = handsFree
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
          }
        : {};
      await micRef.current.startRecording(onMaxDuration, { onLevel: handleLevel, ...endpoint });
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

  /** 朗读文本 */
  const speak = useCallback(
    (text: string) => {
      if (!available || !speakReplies) return;
      const stream = new SentenceStream();
      streamRef.current = stream;
      directiveStateRef.current = "unknown";
      directivePrefixRef.current = 0;
      spokenCharsRef.current = 0;
      truncatedRef.current = false;
      // 显式朗读（如点「重播」）要清掉上一轮的打断标记，否则一句都不念
      interruptedRef.current = false;
      for (const sentence of stream.flush(text)) enqueueForSpeech(sentence);
      speechEndAtRef.current = performance.now();
      firstAudioRef.current = true;
    },
    [available, speakReplies, enqueueForSpeech]
  );

  /** 喂流式增量（累积文本） */
  const feed = useCallback(
    (cumulative: string) => {
      if (!available || !speakReplies) return;
      // 本轮已被打断：模型剩下的内容不再送合成（否则 enqueue 会把 stopped
      // 重置回 false，刚被打断的回复又念起来）
      if (interruptedRef.current) return;
      // 空帧直接跳过：`start` 阶段的累积文本是空串，喂进去会白白新建一个
      // SentenceStream 并把 speechEndAt 重置一次，把 TTFA 埋点算成全 0。
      if (cumulative.length === 0) return;
      if (streamRef.current === null) {
        streamRef.current = new SentenceStream();
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
    [available, speakReplies, enqueueForSpeech]
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
    if (stream === null) return;

    // 本轮到此结束：被打断标记只作用于本轮，下一轮要重新放行。
    // 放在这里而不是 feed 开头，是因为被打断后 feed 会一路 return，
    // 永远走不到重置点。
    const interrupted = interruptedRef.current;
    interruptedRef.current = false;

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
    stopSpeaking,
    speakReplies,
    wakeEnabled,
    wakeListening,
  };
}
