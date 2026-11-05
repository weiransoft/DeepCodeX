/**
 * 说完判定（endpointing）：把「静音」变成「可以发送了」
 *
 * ## 为什么需要它
 *
 * 按住说话要求用户用**手**告诉系统"我说完了"——但真实对话里，人是用
 * **停顿**表达这件事的。手一直按着，等于让用户一边组织语言一边维持一个
 * 机械动作；松开早了一句话被截断，松开晚了一直在录。
 *
 * 参考 OpenClaw 的 Talk Mode：它维护的是「听 → 想 → 说」的连续循环，
 * 靠静音窗口（silence window）自动提交，而不是按键。这个类就是那个窗口
 * 的判定器。
 *
 * ## 为什么阈值是这样
 *
 * - **帧 50ms**：与打断监测同粒度，复用同一套 RMS 计算，不引入第二个采样循环。
 * - **至少说够 300ms 才算一句**：咳嗽、碰桌子、开关门都是短促的，不该被提交成
 *   「没听清」。没说过话就一直是纯静音，此时**不**触发（由调用方按上限收尾）。
 * - **连续静音 900ms 才算说完**：中文句内逗号停顿通常 200~500ms，句间停顿
 *   600ms 以上。取 900ms 落在这两者之间：不切断一句话，也不让人等太久。
 *   这个值必须大于句内停顿的上界，否则一句话会被切成两段送出去。
 *
 * ## 纯状态机，不碰麦克风
 *
 * 判定与采集分开：`MicCapture` 每 50ms 采一帧 RMS 喂进来，这里只回答
 * 「现在算不算说完了」。这样判定逻辑可以脱开浏览器单测，调参也不用改采集。
 *
 * @module web/voice/endpointing
 */

/** 分析帧长（毫秒），与打断监测保持一致 */
export const ENDPOINT_FRAME_MS = 50;

/** 判定「说完」需要的连续静音（毫秒） */
export const ENDPOINT_SILENCE_MS = 900;

/** 一句有效话的最短人声累计（毫秒） */
export const ENDPOINT_MIN_SPEECH_MS = 300;

/** 人声 RMS 阈值（与打断监测同源，安静环境下的正常说话在 0.1~0.3） */
export const ENDPOINT_RMS_THRESHOLD = 0.05;

/** 一帧的判定结果 */
export interface EndpointVerdict {
  /** 这一帧是否达到人声阈值 */
  active: boolean;
  /** 是否在此帧判定为「说完了」（只会为 true 一次） */
  done: boolean;
  /** 本次判定是不是「没人说话」的空段（配合 `idleMs` 使用） */
  idle: boolean;
  /** 累计人声毫秒 */
  speechMs: number;
  /** 当前连续静音毫秒 */
  silenceMs: number;
}

/** 判定参数（全部可选，测试与调参只改这里） */
export interface EndpointOptions {
  /** 帧长（毫秒） */
  frameMs?: number;
  /** 连续静音多久算说完（毫秒） */
  silenceMs?: number;
  /** 至少说多久才算一句（毫秒） */
  minSpeechMs?: number;
  /** 人声阈值（RMS） */
  threshold?: number;
  /**
   * 空段超时（毫秒）：从头到尾没说过话、连续静音达到该值即收尾。
   *
   * 0（默认）表示关闭——按住说话的场景有 60s 上限兜底，不需要它。
   * 唤醒监听需要：否则一段纯静音会一直录到上限，再把几十秒静音送去识别。
   */
  idleMs?: number;
}

/**
 * 说完判定器
 *
 * 用法：每帧 `push(rms)`，看到 `done === true` 就收尾；`done` 只会返回一次，
 * 后续帧即使继续静音也不会重复触发（避免重复提交同一句话）。
 */
export class Endpointer {
  private readonly frameMs: number;
  private readonly silenceGoal: number;
  private readonly minSpeechMs: number;
  private readonly threshold: number;
  private readonly idleGoal: number;

  /** 累计人声毫秒 */
  private speechMs = 0;
  /** 当前连续静音毫秒 */
  private silenceMs = 0;
  /** 是否已经判定过（防重复触发） */
  private fired = false;

  /**
   * @param options 判定参数
   */
  constructor(options: EndpointOptions = {}) {
    this.frameMs = options.frameMs ?? ENDPOINT_FRAME_MS;
    this.silenceGoal = options.silenceMs ?? ENDPOINT_SILENCE_MS;
    this.minSpeechMs = options.minSpeechMs ?? ENDPOINT_MIN_SPEECH_MS;
    this.threshold = options.threshold ?? ENDPOINT_RMS_THRESHOLD;
    this.idleGoal = options.idleMs ?? 0;
  }

  /**
   * 喂一帧 RMS
   *
   * @param rms 这一帧的均方根幅度（0~1）
   * @returns 判定结果
   */
  push(rms: number): EndpointVerdict {
    const active = rms >= this.threshold;
    if (active) {
      this.speechMs += this.frameMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += this.frameMs;
    }

    let done = false;
    let idle = false;
    if (!this.fired) {
      if (this.speechMs >= this.minSpeechMs && this.silenceMs >= this.silenceGoal) {
        this.fired = true;
        done = true;
      } else if (this.idleGoal > 0 && this.speechMs === 0 && this.silenceMs >= this.idleGoal) {
        // 从头到尾一帧人声都没有：这是空段，不该送去识别
        this.fired = true;
        done = true;
        idle = true;
      }
    }

    return { active, done, idle, speechMs: this.speechMs, silenceMs: this.silenceMs };
  }

  /** 是否已经说过话（用于区分「还没开口」与「说完了」） */
  get hasSpeech(): boolean {
    return this.speechMs >= this.minSpeechMs;
  }

  /** 复位（下一轮开始时调用） */
  reset(): void {
    this.speechMs = 0;
    this.silenceMs = 0;
    this.fired = false;
  }
}
