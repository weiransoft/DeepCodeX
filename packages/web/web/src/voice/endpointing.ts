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
 * - **人声阈值不是常数**：原来写死 `rms >= 0.05`，麦克风增益低的人说话只有
 *   0.02~0.04，永远判不成人声（免按住模式下表现成「点了就结束」）；环境吵
 *   的地方底噪 0.05 以上，又永远等不到静音。现在改成「噪声底 × 2.5」，由
 *   `NoiseFloorTracker` 按环境实时估计，取值范围夹在 `[0.012, 0.09]`。
 *
 * ## 纯状态机，不碰麦克风
 *
 * 判定与采集分开：`MicCapture` 每 50ms 采一帧 RMS 喂进来，这里只回答
 * 「现在算不算说完了」。这样判定逻辑可以脱开浏览器单测，调参也不用改采集。
 *
 * @module web/voice/endpointing
 */

import { NoiseFloorTracker, rmsThreshold } from "./noise-floor";

/** 分析帧长（毫秒），与打断监测保持一致 */
export const ENDPOINT_FRAME_MS = 50;

/** 判定「说完」需要的连续静音（毫秒） */
export const ENDPOINT_SILENCE_MS = 900;

/**
 * 轮次判停档位
 *
 * - `legacy`：固定 900ms（`Endpointer` 默认，保证既有单测与行为零回归）。
 * - `adaptive`：按**已说时长**动态取窗 —— 正常一句话 600ms，短语与长叙述
 *   仍保持 900ms。这是默认档，省 300ms 而不动两类最易误切的边缘情况。
 * - `fast`：正常句子压到 350ms，供真机 A/B；没有语义判停时不建议默认开。
 *
 * 为什么按「已说时长」而不是语义：当前链路是整段录音后一次性 ASR，
 * 判停时**没有部分转写文本**，无法知道是数字串还是「嗯」。业界
 * `semantic_vad` / Smart Turn 需要流式 ASR，属于 P1；这里只用确定可得
 * 的信号做保守近似，绝不假装有语义。
 */
export type EndpointProfile = "legacy" | "adaptive" | "fast";

/** 自适应档：正常句子的静默窗 */
export const ENDPOINT_ADAPTIVE_SILENCE_MS = 600;
/** 激进档：正常句子的静默窗（A/B 用，默认不开） */
export const ENDPOINT_FAST_SILENCE_MS = 350;
/** 短于此人声时长视为短语（可能只是「嗯 / 好的」），保持保守窗 */
export const ENDPOINT_SHORT_SPEECH_MS = 600;
/** 长于此人声时长视为长叙述，句内停顿更长，保持保守窗 */
export const ENDPOINT_LONG_SPEECH_MS = 3000;

/** 一句有效话的最短人声累计（毫秒） */
export const ENDPOINT_MIN_SPEECH_MS = 300;

/**
 * 人声阈值下限（RMS）
 *
 * 噪声底压到 0 时的兜底：数字静默也有底噪，阈值不能跟着归零。
 * 定成人声阈值的**下界**而不是固定值，见 `voice/noise-floor.ts`。
 */
export const ENDPOINT_RMS_THRESHOLD_MIN = 0.012;

/** 人声阈值上限（RMS）：噪声底被估高时的兜底，避免把轻声说话也判成静音 */
export const ENDPOINT_RMS_THRESHOLD_MAX = 0.09;

/**
 * 固定人声阈值（RMS）
 *
 * @deprecated 自适应阈值之前的常量，现在只在显式传 `threshold` 时才会用到；
 * 保留导出是为了兼容既有调用与文档引用。
 */
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
  /** 本帧实际使用的阈值（自适应结果，便于诊断与单测） */
  threshold: number;
  /** 本帧实际使用的静默窗（动态档位下会随已说时长变化，便于诊断与单测） */
  silenceGoalMs: number;
}

/** 判定参数（全部可选，测试与调参只改这里） */
export interface EndpointOptions {
  /** 帧长（毫秒） */
  frameMs?: number;
  /** 连续静音多久算说完（毫秒） */
  silenceMs?: number;
  /** 至少说多久才算一句（毫秒） */
  minSpeechMs?: number;
  /**
   * 固定人声阈值（RMS）
   *
   * 给了就**关闭自适应**、原样使用该值——测试与特殊场景（比如录音棚里
   * 需要精确复现）用。不传则按环境噪声底自适应。
   */
  threshold?: number;
  /**
   * 噪声底跟踪器
   *
   * 由采集层（`MicCapture`）注入并跨轮持有：同一间屋子里的第二轮对话
   * 不必重新标定。不传则自建一个（只在单测里发生）。
   */
  noiseFloor?: NoiseFloorTracker;
  /**
   * 空段超时（毫秒）：从头到尾没说过话、连续静音达到该值即收尾。
   *
   * 0（默认）表示关闭——按住说话的场景有 60s 上限兜底，不需要它。
   * 唤醒监听需要：否则一段纯静音会一直录到上限，再把几十秒静音送去识别。
   */
  idleMs?: number;
  /**
   * 轮次判停档位（缺省 `legacy` = 固定 900ms）
   *
   * 显式传 `silenceMs` 时始终以它为准，档位不生效 —— 单测与特殊场景的
   * 精确复现优先。
   */
  profile?: EndpointProfile;
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
  /** 是否显式指定了静默窗（显式值永远压过档位） */
  private readonly explicitSilence: boolean;
  private readonly profile: EndpointProfile;
  private readonly minSpeechMs: number;
  /** 固定阈值；null 表示自适应 */
  private readonly fixedThreshold: number | null;
  private readonly idleGoal: number;
  private readonly noiseFloor: NoiseFloorTracker;

  /** 累计人声毫秒 */
  private speechMs = 0;
  /** 当前连续静音毫秒 */
  private silenceMs = 0;
  /** 是否已经判定过（防重复触发） */
  private fired = false;
  /** 标定期缓存的帧（标定一结束要用新阈值重判这批帧） */
  private pending: number[] = [];
  /** 是否已完成标定（固定阈值时为 true） */
  private calibrated: boolean;

  /**
   * @param options 判定参数
   */
  constructor(options: EndpointOptions = {}) {
    this.frameMs = options.frameMs ?? ENDPOINT_FRAME_MS;
    this.explicitSilence = options.silenceMs !== undefined;
    this.silenceGoal = options.silenceMs ?? ENDPOINT_SILENCE_MS;
    this.profile = options.profile ?? "legacy";
    this.minSpeechMs = options.minSpeechMs ?? ENDPOINT_MIN_SPEECH_MS;
    this.idleGoal = options.idleMs ?? 0;
    this.fixedThreshold = options.threshold ?? null;
    this.noiseFloor = options.noiseFloor ?? new NoiseFloorTracker();
    // 跟踪器可能在本轮之前就标定过了（采集器跨轮持有），此时无需缓冲
    this.calibrated = this.fixedThreshold !== null || !this.noiseFloor.calibrating;
  }

  /**
   * 本帧生效的静默窗
   *
   * 只在**人声帧**上可能变化（`speechMs` 只在 active 时增长，且增长会把
   * `silenceMs` 归零），所以静音等待期间档位不会来回跳、不会把一次停顿
   * 用两个不同的窗口判。
   */
  private silenceGoalFor(): number {
    if (this.explicitSilence || this.profile === "legacy") return this.silenceGoal;
    // 短语（可能只是「嗯 / 好的」）与长叙述（句内停顿更长）都保持 900ms，
    // 只把「正常一句话」这一段最容易优化、也最不容易误切的区间压短。
    if (this.speechMs < ENDPOINT_SHORT_SPEECH_MS || this.speechMs > ENDPOINT_LONG_SPEECH_MS) {
      return this.silenceGoal;
    }
    const normal = this.profile === "fast" ? ENDPOINT_FAST_SILENCE_MS : ENDPOINT_ADAPTIVE_SILENCE_MS;
    return Math.min(normal, this.silenceGoal);
  }

  /** 当前使用的人声阈值（自适应或固定） */
  private currentThreshold(): number {
    if (this.fixedThreshold !== null) return this.fixedThreshold;
    return rmsThreshold(this.noiseFloor.value, undefined, ENDPOINT_RMS_THRESHOLD_MIN, ENDPOINT_RMS_THRESHOLD_MAX);
  }

  /**
   * 按给定阈值把一帧计入计数
   *
   * @param rms 本帧 RMS
   * @param threshold 本帧使用的阈值
   * @returns 是否算人声
   */
  private classify(rms: number, threshold: number): boolean {
    const active = rms >= threshold;
    if (active) {
      this.speechMs += this.frameMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += this.frameMs;
    }
    return active;
  }

  /**
   * 标定结束时，用学到的阈值重判标定期的那些帧
   *
   * 不做这一步会有一个隐蔽的误判：噪声底的标定需要 300ms，这 300ms 里阈值
   * 只能用初始值（最低档），于是"吵闹房间的底噪"会被整段算成人声——刚好
   * 凑满 300ms 的最短人声要求，等 900ms 静音一到就把一段纯噪声送去识别。
   * 重判之后，这 300ms 会按真实环境阈值重新归类，噪声归噪声。
   */
  private reclassify(): void {
    this.calibrated = true;
    const frames = this.pending;
    this.pending = [];
    if (frames.length === 0) return;
    this.speechMs = 0;
    this.silenceMs = 0;
    const threshold = this.currentThreshold();
    for (const rms of frames) this.classify(rms, threshold);
  }

  /**
   * 喂一帧 RMS
   *
   * @param rms 这一帧的均方根幅度（0~1）
   * @returns 判定结果
   */
  push(rms: number): EndpointVerdict {
    const before = this.currentThreshold();
    const wasActive = this.classify(rms, before);

    if (this.fixedThreshold === null) {
      // 先用"上一帧学到的环境"判这一帧，再更新噪声底。顺序反了会让同一帧
      // 既是输入又是输出，边界行为无法解释
      this.noiseFloor.observe(rms, wasActive);
      if (!this.calibrated) {
        this.pending.push(rms);
        if (!this.noiseFloor.calibrating) this.reclassify();
      }
    }

    // 阈值可能刚因标定结束而改变，本帧的 active 以最终阈值为准
    const threshold = this.currentThreshold();
    const active = rms >= threshold;

    const silenceGoalMs = this.silenceGoalFor();
    let done = false;
    let idle = false;
    if (!this.fired) {
      if (this.speechMs >= this.minSpeechMs && this.silenceMs >= silenceGoalMs) {
        this.fired = true;
        done = true;
      } else if (this.idleGoal > 0 && this.speechMs === 0 && this.silenceMs >= this.idleGoal) {
        // 从头到尾一帧人声都没有：这是空段，不该送去识别
        this.fired = true;
        done = true;
        idle = true;
      }
    }

    return { active, done, idle, speechMs: this.speechMs, silenceMs: this.silenceMs, threshold, silenceGoalMs };
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
    this.pending = [];
    this.noiseFloor.reset();
  }
}
