/**
 * 唤醒词监听：常驻分段录音 → 识别 → 匹配
 *
 * ## 为什么用「连续分段」而不是「先检测人声再开录」
 *
 * 直觉做法是先用能量检测确认有人说话，再打开录音。但那要 300ms 才能确认
 * 人声（`VAD_MIN_SPEECH_MS`），**头一个字必然被切掉**——喊「司南」只剩
 * 「南」，唤醒率直接对半砍。
 *
 * 所以这里反过来：录音一直在跑，靠「静音收尾」切段（复用 `Endpointer`）。
 * 段与段之间只在静音时才短暂断开，没有内容丢失。
 *
 * ## 空段为什么不送识别
 *
 * 连续静音如果一直录到 60s 上限，就是把整分钟静音送去跑一次 Whisper——
 * 又慢又费电。`Endpointer` 的 `idleMs` 在「一帧人声都没有」时提前收尾，
 * 这类段直接丢弃，不进识别。
 *
 * ## 代价（写在明处）
 *
 * - **麦克风常开**：这是唤醒的固有代价，所以默认关闭、由用户显式打开；
 * - **每段都要过一次 ASR**：热态约 287ms，一段 2~3 秒的人声代价可接受，
 *   但确实比「专用唤醒词模型」贵一个量级（后者只在本地跑几十 KB 的模型）。
 *   真要省，下一步是接 openWakeWord 之类的专用检测器，这里留了
 *   `transcribe` 注入点，替换检测方式不需要改编排。
 *
 * @module web/voice/wake-listener
 */

import { MicCapture } from "./mic";
import type { EndpointOptions, EndpointVerdict } from "./endpointing";
import { matchWakeWord } from "./wake";

/** 空段超时（毫秒）：这么久没听到人声就丢掉这一段 */
export const WAKE_IDLE_MS = 3_000;

/**
 * 采集器的最小接口
 *
 * 抽出来是为了能脱开浏览器测循环：真机拿不到"麦克风",但"切段 → 识别 →
 * 匹配 → 唤醒"这段编排是可以断言的（用假的采集器喂预置片段）。
 * `MicCapture` 结构上满足这个接口，不需要适配层。
 */
export interface WakeCapture {
  open(): Promise<unknown>;
  startRecording(
    onMax?: () => void,
    options?: { onEndpoint?: (verdict: EndpointVerdict) => void; endpoint?: EndpointOptions }
  ): Promise<void>;
  stopRecording(): Promise<Blob>;
  release(): void;
}

/** 唤醒监听参数 */
export interface WakeListenerOptions {
  /** 把一段音频识别成文本（注入便于测试与替换检测方式） */
  transcribe: (audio: Blob) => Promise<string>;
  /** 唤醒词 */
  wakeWord: string;
  /** 命中唤醒词（在监听已停止之后调用） */
  onWake: (transcript: string) => void;
  /** 出错（文案已可读）；出错后监听会自行停止，避免错误风暴 */
  onError?: (message: string) => void;
  /** 空段超时（默认 `WAKE_IDLE_MS`） */
  idleMs?: number;
  /** 采集器工厂（默认真麦克风；测试注入假实现） */
  createCapture?: () => WakeCapture;
}

/** 一段录音的结果 */
type Segment = { idle: true; audio: null } | { idle: false; audio: Blob };

/**
 * 唤醒词监听器
 *
 * 生命周期：`start()` → 循环 → 命中或 `stop()`。
 * `stop()` 可随时调用（幂等），循环会在当前段结束后退出。
 */
export class WakeListener {
  private readonly options: WakeListenerOptions;
  private mic: WakeCapture | null = null;
  private active = false;
  /** 循环是否已在跑（防止重复 start 起两条循环） */
  private looping = false;

  /**
   * @param options 参数（识别函数、唤醒词、回调）
   */
  constructor(options: WakeListenerOptions) {
    this.options = options;
  }

  /** 是否正在监听 */
  get listening(): boolean {
    return this.active;
  }

  /**
   * 开始监听（幂等）
   *
   * 麦克风打不开时直接回调 `onError` 并保持未监听状态——
   * 唤醒失败不该拖垮整个语音功能。
   */
  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.mic = (this.options.createCapture ?? (() => new MicCapture()))();
    try {
      await this.mic.open();
    } catch (error) {
      this.active = false;
      this.mic.release();
      this.mic = null;
      this.options.onError?.(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!this.active) return;
    if (this.looping) return;
    this.looping = true;
    void this.loop();
  }

  /** 停止监听（幂等） */
  stop(): void {
    this.active = false;
    const mic = this.mic;
    this.mic = null;
    if (mic !== null) {
      // 正在录的那一段会被丢掉：此刻用户要么在跟助手说话，要么在播报
      try {
        void mic.stopRecording().catch(() => undefined);
      } catch {
        // 未在录音
      }
      mic.release();
    }
  }

  /**
   * 主循环：切段 → 识别 → 匹配
   *
   * 任何一步失败都停止监听而不是重试：唤醒是"锦上添花"的能力，
   * 连续失败重试只会刷屏报错并且持续占用麦克风。
   */
  private async loop(): Promise<void> {
    try {
      while (this.active) {
        const segment = await this.nextSegment();
        if (!this.active) return;
        if (segment === null) return;
        if (segment.idle) continue;

        let text = "";
        try {
          text = await this.options.transcribe(segment.audio);
        } catch (error) {
          this.active = false;
          this.options.onError?.(error instanceof Error ? error.message : String(error));
          return;
        }
        if (!this.active) return;

        if (matchWakeWord(text, this.options.wakeWord).hit) {
          this.stop();
          this.options.onWake(text);
          return;
        }
      }
    } finally {
      this.looping = false;
    }
  }

  /**
   * 录一段并返回（空段返回 `{idle:true}`）
   *
   * @returns 段结果；麦克风失效时返回 null
   */
  private async nextSegment(): Promise<Segment | null> {
    const mic = this.mic;
    if (mic === null) return null;

    const verdict = await new Promise<EndpointVerdict | null>((resolve) => {
      mic
        .startRecording(
          // 到录音上限：当作有声段处理（宁可多识别一次，也不吞掉真实语音）
          // 录音到上限的兜底：没有真实帧，threshold 记 0 表示"非自适应判定"
          () => resolve({ active: false, done: true, idle: false, speechMs: 0, silenceMs: 0, threshold: 0 }),
          { onEndpoint: (result) => resolve(result), endpoint: { idleMs: this.options.idleMs ?? WAKE_IDLE_MS } }
        )
        .catch(() => resolve(null));
    });
    if (verdict === null) return null;

    let audio: Blob;
    try {
      audio = await mic.stopRecording();
    } catch {
      // 没录到音频（刚开就停）：当作空段继续，不算错误
      return { idle: true, audio: null };
    }
    if (verdict.idle) return { idle: true, audio: null };
    return { idle: false, audio };
  }
}
