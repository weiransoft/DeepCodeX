/**
 * 唤醒词匹配
 *
 * ## 为什么不是「转写里包含唤醒词」就完了
 *
 * ASR 不会把「司南」稳定写成「司南」。实测同一段音频里出现过
 * 「语音 → 雨音」这种同音替换，唤醒词同样会被写成「思南」「司楠」。
 * 只做字符串包含，等于要求用户每次都被识别得一模一样——那是撞运气。
 *
 * 所以匹配分两档：
 *
 * 1. **精确**：归一化后直接包含，命中即唤醒；
 * 2. **近似**：编辑距离 ≤ 1（漏一个字、错一个字），但**只在句子开头附近**找。
 *
 * ## 为什么近似匹配要限制在开头
 *
 * 短唤醒词（两个字）距离 1 意味着允许一半字符不同：「思念」「四年」都可能
 * 落到「司南」附近。真在长句中间模糊匹配，误唤醒会多到没法用。
 * 而人喊唤醒词几乎总是开口第一句——把窗口收在开头前 6 个字，
 * 误唤醒率降下来，正常使用几乎不受影响。
 *
 * ## 归一化做什么
 *
 * 全角转半角（NFKC）、去标点空白、去大小写。ASR 输出常带逗号句号，
 * 「司南，」和「司南」必须等价。
 *
 * @module web/voice/wake
 */

/** 近似匹配允许的最大编辑距离（1 = 错/漏一个字） */
export const WAKE_MATCH_MAX_DISTANCE = 1;

/** 近似匹配只看开头这么多个字（精确匹配不限位置） */
export const WAKE_HEAD_WINDOW = 6;

/** 匹配方式 */
export type WakeMatchKind = "exact" | "fuzzy";

/** 匹配结果 */
export interface WakeMatchResult {
  /** 是否命中 */
  hit: boolean;
  /** 命中方式（未命中为 null） */
  kind: WakeMatchKind | null;
  /** 命中位置（归一化字符串中的下标；未命中为 -1） */
  index: number;
}

/** 未命中的结果（复用同一对象，避免热路径反复分配） */
const MISS: WakeMatchResult = { hit: false, kind: null, index: -1 };

/**
 * 归一化文本（去标点/空白、全角转半角、小写）
 *
 * @param text 原始文本
 * @returns 归一化结果（保留字母与数字，含 CJK）
 */
export function normalizeForWake(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

/**
 * 编辑距离（带上限的 Levenshtein）
 *
 * 超过上限就提前返回，避免为明显不相似的窗口算完整矩阵。
 *
 * @param a 字符串 a
 * @param b 字符串 b
 * @param max 上限（超过即返回 max + 1）
 * @returns 编辑距离
 */
export function editDistance(a: string, b: string, max = WAKE_MATCH_MAX_DISTANCE): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    // 整行都超过上限：后面只会更大，直接放弃
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * 在转写文本里找唤醒词
 *
 * @param transcript ASR 转写文本
 * @param wakeWord 唤醒词
 * @param options 参数（可收紧近似匹配）
 * @returns 匹配结果
 */
export function matchWakeWord(
  transcript: string,
  wakeWord: string,
  options: { maxDistance?: number; headWindow?: number } = {}
): WakeMatchResult {
  const word = normalizeForWake(wakeWord);
  if (word.length === 0) return MISS;
  const text = normalizeForWake(transcript);
  if (text.length === 0) return MISS;

  const exact = text.indexOf(word);
  if (exact >= 0) return { hit: true, kind: "exact", index: exact };

  // 单字唤醒词不做近似：一个字错一个字，等于另一个词
  if (word.length < 2) return MISS;

  const maxDistance = options.maxDistance ?? WAKE_MATCH_MAX_DISTANCE;
  const headWindow = Math.max(0, options.headWindow ?? WAKE_HEAD_WINDOW);
  const lastStart = Math.min(headWindow - 1, text.length - word.length + 1);
  for (let start = 0; start <= lastStart; start += 1) {
    // 长度允许 ±1：ASR 可能多吐一个字或少吐一个字
    for (const length of [word.length, word.length - 1, word.length + 1]) {
      if (length <= 1 || start + length > text.length) continue;
      const window = text.slice(start, start + length);
      if (editDistance(window, word, maxDistance) <= maxDistance) {
        return { hit: true, kind: "fuzzy", index: start };
      }
    }
  }
  return MISS;
}
