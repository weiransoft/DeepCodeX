/**
 * 噪声底估计：把"人声阈值"从绝对值改成环境自适应
 *
 * ## 为什么绝对阈值不够用
 *
 * 原来判人声用的是一句话：`rms >= 0.05`。这个数是在"安静房间 + 正常增益
 * 麦克风"下标定出来的，而真实环境有三类偏差，每一类都会让判定失效：
 *
 * - **麦克风增益低**（外接耳机麦、笔记本远场、系统音量拉低）：正常说话
 *   RMS 只有 0.02~0.04，永远够不到 0.05 → 判定器认为用户没开口。免按住
 *   模式下表现为"点了就结束"；按住说话模式下 `speechMs` 一直是 0，静音
 *   收尾与打断都失灵
 * - **环境噪声高**（空调、风扇、路噪）：底噪 0.04~0.06 直接越过阈值 →
 *   判定器认为一直在说话，永远等不到 900ms 静音 → 只能靠 60s 上限收尾
 * - **两者同时存在**：区间被压成一条缝，任何固定阈值都必然踩一边
 *
 * 所以阈值必须跟着环境走：**先听清楚背景有多吵，再决定多大声算说话**。
 *
 * ## 估计方法
 *
 * 噪声底就是"环境自己有多响"，它不是某一帧的值，而是一个缓慢变化的量。
 * 这里用「最小值跟踪 + 缓慢上浮」：
 *
 * 1. **标定期（前 300ms / 6 帧）**：取窗口内的**最小** RMS 作为初始噪声底。
 *    取最小值而不是平均值，是因为用户可能在按下录音的瞬间就开口了——平均值
 *    会被说话拉高，最小值则大概率落在开口前的静默或字间气口上。
 * 2. **下探（立即）**：任何一帧比当前噪声底低，立刻跟下去。安静下来要马上
 *    反映出来，否则刚放完音乐的房间还会维持高阈值好几秒。
 * 3. **上浮（缓慢）**：环境变吵时缓慢抬升，且**永远不超过当帧 RMS**——
 *    这条不变式保证噪声底不会被一次喊话顶到天上。上浮速度分两档：
 *    - 判定为静音的帧：1.2e-3/帧（约 1 秒收敛），静音时学快一点没有代价
 *    - 判定为人声的帧：1e-4/帧（约 14 秒才到上限），避免连续说话把阈值
 *      一路推高，最后把自己的后半句判成静音
 *
 * ## 为什么阈值要夹在 [0.012, 0.09] 之间
 *
 * - **下限 0.012**：数字静默也有底噪（dither），噪声底压到 0 时阈值不能跟着
 *   归零，否则一帧杂波就算人声
 * - **上限 0.09**：噪声底估高了（比如用户在标定期正好说话）时，阈值不能高到
 *   把 0.1 的轻声说话也判成静音。上限让这种误估的代价有界——最坏退化成
 *   "比原来严格一点"，而不是彻底听不见
 *
 * ## 不改采集，只改判定
 *
 * 这个模块是纯计算：喂 RMS、返回噪声底。麦克风采集、电平可视化都不受影响，
 * 判定逻辑因此仍可脱开浏览器单测。
 *
 * @module web/voice/noise-floor
 */

/** 噪声底初始值（标定完成前的占位，约等于安静房间的底噪） */
export const NOISE_FLOOR_INITIAL = 0.004;

/** 标定帧数：6 帧 × 50ms = 300ms */
export const NOISE_FLOOR_CALIBRATION_FRAMES = 6;

/** 人声阈值 = 噪声底 × 该倍数 */
export const NOISE_FLOOR_FACTOR = 2.5;

/** 判为静音的帧上，噪声底每帧上浮量（快档） */
export const NOISE_FLOOR_DRIFT_IDLE = 1.2e-3;

/** 判为人声的帧上，噪声底每帧上浮量（慢档：连续说话不该把阈值推高） */
export const NOISE_FLOOR_DRIFT_ACTIVE = 1e-4;

/** 噪声底本身的上限（与 `ENDPOINT_RMS_MAX / NOISE_FLOOR_FACTOR` 对齐） */
export const NOISE_FLOOR_CAP = 0.036;

/**
 * 把噪声底换算成人声阈值
 *
 * @param floor 噪声底（RMS）
 * @param factor 倍数（默认 2.5）
 * @param min 阈值下限（默认 0.012）
 * @param max 阈值上限（默认 0.09）
 * @returns 夹在 `[min, max]` 内的阈值
 */
export function rmsThreshold(floor: number, factor = NOISE_FLOOR_FACTOR, min = 0.012, max = 0.09): number {
  if (!Number.isFinite(floor) || floor <= 0) return min;
  const scaled = floor * factor;
  if (!Number.isFinite(scaled)) return min;
  return Math.min(max, Math.max(min, scaled));
}

/**
 * 噪声底跟踪器
 *
 * 用法：每帧先按当前阈值判 `active`，再把 `(rms, active)` 交给 `observe`。
 * `active` 参与上浮速度的选择，所以要传；标定期的帧传什么都行。
 */
export class NoiseFloorTracker {
  /** 当前噪声底 */
  private floor: number;
  /** 标定期已采集的帧 */
  private readonly samples: number[] = [];

  /**
   * @param initial 初始噪声底
   */
  constructor(initial: number = NOISE_FLOOR_INITIAL) {
    this.floor = initial;
  }

  /**
   * 喂一帧
   *
   * @param rms 本帧 RMS（0~1）
   * @param active 本帧是否被判为人声（决定上浮速度）
   * @returns 更新后的噪声底
   */
  observe(rms: number, active: boolean): number {
    // 非有限值必须挡住：NaN 一旦进到 floor，之后每帧阈值都是 NaN，
    // 比较恒为 false → 整段录音永远"没人说话"，比"这一帧不准"严重得多
    if (!Number.isFinite(rms) || rms < 0) return this.floor;

    if (this.samples.length < NOISE_FLOOR_CALIBRATION_FRAMES) {
      this.samples.push(rms);
      if (this.samples.length === NOISE_FLOOR_CALIBRATION_FRAMES) {
        // 标定结束：取窗口内最小值（用户可能一按下就开口，最小值更接近背景）。
        // 同样要过上限：用户正好在标定期大声说话时，不能让阈值跟着冲到天上
        this.floor = Math.min(Math.min(...this.samples), NOISE_FLOOR_CAP);
      }
      return this.floor;
    }

    if (rms < this.floor) {
      // 立即下探：环境安静下来必须马上反映，否则高阈值会多维持好几秒
      this.floor = rms;
    } else {
      // 缓慢上浮，且永远不超过当帧 RMS —— 一次喊话不能把噪声底顶上去
      const drift = active ? NOISE_FLOOR_DRIFT_ACTIVE : NOISE_FLOOR_DRIFT_IDLE;
      this.floor = Math.min(rms, this.floor + drift);
    }
    this.floor = Math.min(this.floor, NOISE_FLOOR_CAP);
    return this.floor;
  }

  /** 当前噪声底 */
  get value(): number {
    return this.floor;
  }

  /** 是否还在标定期（此时阈值应取下限，宁可多算人声也不漏第一个字） */
  get calibrating(): boolean {
    return this.samples.length < NOISE_FLOOR_CALIBRATION_FRAMES;
  }

  /**
   * 复位
   *
   * 清空标定窗口，但**保留已学到的噪声底**：标定期间用的是旧底，等新窗口
   * 采满才换成新值。这样同一间屋子里的连续几轮对话不会每轮都从 0.004
   * 重新开始（否则第一句永远按最低阈值判，噪声也容易被当人声）。
   */
  reset(): void {
    this.samples.length = 0;
  }
}
