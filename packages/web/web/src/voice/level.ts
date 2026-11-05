/**
 * 采集电平的平滑与量化（纯函数）
 *
 * ## 为什么电平不能直接上屏
 *
 * `AnalyserNode` 每 50ms 给出一个瞬时 RMS，真实说话时光看这个数字会得到一条
 * 抖动剧烈的线：同一句话里音量从 0.03 跳到 0.28 再掉回 0.05。直接绑到 UI 上，
 * 检测条会"抽搐"——那不是灵敏，是噪声。
 *
 * 所以中间要过两道：
 *
 * 1. **平滑**（`nextSmoothedLevel`）：上升快、下降慢。上升快保证第一个字就被
 *    看见（否则用户已经开口了、条还没动）；下降慢让字与字之间的气口不至于把
 *    条打回零，视觉上是一条连续的"在说话"。
 * 2. **量化**（`quantizeLevel`）：阶跃到 12 档。一来阶梯条本来就是一格一格亮，
 *    二来**只有跨档才触发 React 重渲染**——静音时一次都不触发。
 *
 * ## 满量程为什么是 0.35 而不是 1.0
 *
 * 常态说话 RMS 落在 0.05~0.3，喊话才接近 0.6，1.0 几乎只有气流声才会碰到。
 * 按 1.0 归一化的话，正常说话条只走到 10%~20%，看起来像"没在收"；按 0.5 也
 * 只到 40% 上下，仍然偏弱。取 0.35：正常说话走到 40%~70%，稍大点声就接近
 * 满格——这是"够用即可"的标定，不追求和物理声压级对应。
 *
 * ## 无信号判定
 *
 * 这是用户最需要的一句提示：点了麦克风、条不动，可能是静音键、选错了输入设备、
 * 或者被别的应用占用。判定看**峰值**而不是末帧——用户可能只是停顿了一下。
 * 阈值 0.02 落在环境底噪（通常 <0.015）之上、人声（>0.05）之下。
 *
 * @module web/voice/level
 */

/** 电平档数（阶梯条的格数） */
export const LEVEL_BUCKETS = 12;

/** 满量程对应的 RMS（见模块注释：按"正常说话"标定，不是按物理满幅） */
export const LEVEL_FULL_SCALE = 0.35;

/** 上升系数：越大越跟手（0.6 ≈ 两帧到位） */
export const LEVEL_ATTACK = 0.6;

/** 下降系数：越小越"黏"，用来抹掉字间气口 */
export const LEVEL_RELEASE = 0.18;

/** 判定"完全没信号"的峰值阈值（环境底噪之下、人声之上） */
export const SILENCE_PEAK = 0.02;

/**
 * 静音时的底座高度（占满格的比例）
 *
 * 不留底座的话，安静的瞬间整排会消失，用户会以为"检测条没了"——而它其实
 * 一直在，只是当前没声音。留 16% 让"检测条存在"这件事始终可见。
 */
export const BAR_FLOOR = 0.16;

/**
 * 平滑一帧电平
 *
 * @param prev 上一帧的平滑值（0 起）
 * @param rms 本帧原始 RMS
 * @returns 平滑后的值（未裁剪）
 */
export function nextSmoothedLevel(prev: number, rms: number): number {
  // 非有限值必须挡住：一旦 NaN 进到累加器里，后面每一帧都是 NaN，
  // 检测条会永久死在零位，比"这一帧不准"严重得多。
  if (!Number.isFinite(prev) || !Number.isFinite(rms)) return 0;
  const factor = rms > prev ? LEVEL_ATTACK : LEVEL_RELEASE;
  return prev + (rms - prev) * factor;
}

/**
 * 把电平压到 12 档并归一到 0..1
 *
 * 返回值只会是 `0`、`1/12`、`2/12`…`1` 这些离散值——这正是"只在跨档时重渲染"
 * 的依据，调用方直接拿它和上一次比。
 *
 * @param level 平滑后的电平（可超过满量程）
 * @returns 量化后的 0..1
 */
export function quantizeLevel(level: number): number {
  // 只挡 NaN：它和任何数比较都为 false，会一路穿过 Math.min 污染样式
  if (Number.isNaN(level) || level <= 0) return 0;
  const normalized = Math.min(1, level / LEVEL_FULL_SCALE);
  return Math.round(normalized * LEVEL_BUCKETS) / LEVEL_BUCKETS;
}

/**
 * 是否在整段录音里都没听到人声
 *
 * @param peak 本段录音出现过的最大原始 RMS
 * @returns 是否无信号
 */
export function isSignalAbsent(peak: number): boolean {
  return peak < SILENCE_PEAK;
}

/**
 * 阶梯条的每格高度系数（中间高、两侧低，看起来像波形而不是音量柱）
 *
 * 纯展示用，抽出来是为了让 UI 与测试共用同一份映射——否则"第 3 格该多高"
 * 会散落在 JSX 和断言里各写一遍。
 *
 * @param index 格序号（从 0 开始）
 * @param count 总格数
 * @returns 该格的权重（中心 1、边缘约 0.35）
 */
export function barWeight(index: number, count: number): number {
  if (count <= 1) return 1;
  const center = (count - 1) / 2;
  const distance = Math.abs(index - center) / center;
  return 1 - distance * 0.65;
}

/**
 * 某一格最终的高度（BAR_FLOOR..1）
 *
 * @param index 格序号
 * @param count 总格数
 * @param level 量化后的电平（0..1）
 * @returns 高度系数
 */
export function barHeight(index: number, count: number, level: number): number {
  const scaled = Math.min(1, level * barWeight(index, count));
  return BAR_FLOOR + scaled * (1 - BAR_FLOOR);
}
