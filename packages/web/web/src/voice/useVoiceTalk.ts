/**
 * 语音对话 hook：按住说话 + 朗读 + 打断
 *
 * ## 职责边界
 *
 * 这个 hook 只管"音频 ↔ 文本"，**不管发送**。识别出文本后交给调用方决定
 * 是填进输入框还是直接发送——Composer 的发送路径里还有附件、@ 提及、
 * 流式占位等逻辑，语音不该另开一条。
 *
 * ## 打断（barge-in）怎么落地
 *
 * 播报期间持续监测麦克风电平；连续 300ms 超过（阈值的 2 倍，抵消外放回声）
 * 就停播并回调。停播后**不自动开始录音**——用户可能只是路过说了句话，
 * 直接开录会显得很唐突，改为由 UI 提示"继续按住说话"。
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

/** 延迟样本保留条数（够看趋势，不至于无限增长） */
const LATENCY_SAMPLES = 10;

/** 一轮延迟样本 */
export interface LatencySample {
  /** 用户说完 → 第一个音出声（毫秒） */
  ttfaMs: number;
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
  /** 语音链路状态（未探测为 null） */
  status: VoiceStatus | null;
  /** 最近若干轮 TTFA */
  latencies: readonly LatencySample[];
  /** 错误提示（可执行文案） */
  error: string | null;
  /** 清空错误 */
  clearError: () => void;
  /** 开始录音 */
  startTalk: () => Promise<void>;
  /** 结束录音并返回识别文本（空文本返回 null） */
  stopTalk: () => Promise<string | null>;
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
}

/**
 * 语音对话 hook
 *
 * @returns 语音能力与操作
 */
export function useVoiceTalk(): VoiceTalk {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(true);
  const [recording, setRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [latencies, setLatencies] = useState<LatencySample[]>([]);
  const [error, setError] = useState<string | null>(null);

  const micRef = useRef<MicCapture | null>(null);
  const queueRef = useRef<SpeechQueue | null>(null);
  const streamRef = useRef<SentenceStream | null>(null);
  const stopMonitorRef = useRef<(() => void) | null>(null);
  const speechEndAtRef = useRef(0);
  const firstAudioRef = useRef(true);
  /** 最近一次喂入的累积文本（flush 需要它取残句） */
  const lastTextRef = useRef("");

  /** 懒建队列（合成函数依赖后端，但只建一次） */
  const queue = useCallback((): SpeechQueue => {
    if (queueRef.current === null) {
      queueRef.current = new SpeechQueue((text) => synthesizeSpeech(text), {
        onSpeakingChange: (value) => {
          setSpeaking(value);
          if (value && firstAudioRef.current && speechEndAtRef.current > 0) {
            // 首个音开始播 → 记录 TTFA（说话结束到出声的真实间隔）
            const ttfaMs = Math.round(performance.now() - speechEndAtRef.current);
            firstAudioRef.current = false;
            setLatencies((prev) => [...prev.slice(-(LATENCY_SAMPLES - 1)), { ttfaMs }]);
          }
        },
        onError: (message) => setError(message),
      });
    }
    return queueRef.current;
  }, []);

  /** 探测配置与状态（进入页面时一次） */
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchSoulConfig(), fetchVoiceStatus().catch(() => null)])
      .then(([config, voiceStatus]) => {
        if (cancelled) return;
        setEnabled(config.voice.enabled);
        setSpeakReplies(config.voice.speakReplies);
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

  /**
   * 播报期间开启打断监测
   *
   * 不做成"播报回调里启动"：那会让 `queue` 与 `startBargeIn` 互相依赖，
   * 变成先有鸡还是先有蛋。改用 `speaking` 状态驱动的 effect，依赖方向单向。
   */
  const startBargeIn = useCallback(async () => {
    if (micRef.current === null) micRef.current = new MicCapture();
    try {
      stopMonitorRef.current = await micRef.current.startMonitor(() => {
        queueRef.current?.stop();
        setSpeaking(false);
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

  /** 开始录音 */
  const startTalk = useCallback(async () => {
    setError(null);
    queue().stop();
    stopBargeIn();
    if (micRef.current === null) micRef.current = new MicCapture();
    try {
      await micRef.current.startRecording(() => {
        // 到达上限自动收尾，走同一条 stopTalk 路径由调用方处理
        setRecording(false);
      });
      setRecording(true);
    } catch (e: unknown) {
      setError(explainMicError(e));
      setRecording(false);
    }
  }, [queue, stopBargeIn]);

  /** 结束录音并识别 */
  const stopTalk = useCallback(async (): Promise<string | null> => {
    setRecording(false);
    const mic = micRef.current;
    if (mic === null) return null;
    try {
      const wav = await mic.stopRecording();
      const result = await transcribeAudio(wav);
      const text = result.text.trim();
      if (text.length < 2) {
        setError("没听清，再说一次？");
        return null;
      }
      return text;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  /** 朗读文本 */
  const speak = useCallback(
    (text: string) => {
      if (!available || !speakReplies) return;
      const stream = new SentenceStream();
      streamRef.current = stream;
      for (const sentence of stream.flush(text)) queue().enqueue(sentence);
      speechEndAtRef.current = performance.now();
      firstAudioRef.current = true;
    },
    [available, speakReplies, queue]
  );

  /** 喂流式增量（累积文本） */
  const feed = useCallback(
    (cumulative: string) => {
      if (!available || !speakReplies) return;
      if (streamRef.current === null) {
        streamRef.current = new SentenceStream();
        speechEndAtRef.current = performance.now();
        firstAudioRef.current = true;
      }
      lastTextRef.current = cumulative;
      for (const sentence of streamRef.current.push(cumulative)) queue().enqueue(sentence);
    },
    [available, speakReplies, queue]
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
    for (const sentence of stream.flush(lastTextRef.current)) queue().enqueue(sentence);
    lastTextRef.current = "";
  }, [queue]);

  /** 停止播报 */
  const stopSpeaking = useCallback(() => {
    queue().stop();
    setSpeaking(false);
  }, [queue]);

  /** 卸载时释放麦克风与音频 */
  useEffect(() => {
    return () => {
      queueRef.current?.stop();
      micRef.current?.release();
    };
  }, []);

  return {
    available,
    enabled,
    recording,
    speaking,
    status,
    latencies,
    error,
    clearError: () => setError(null),
    startTalk,
    stopTalk,
    speak,
    feed,
    finishFeed,
    stopSpeaking,
    speakReplies,
  };
}
