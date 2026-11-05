/**
 * 朗读字数预算：陪伴模式下"不念全部内容"的落点
 *
 * ## 为什么要设上限
 *
 * 流式播报会边出字边合成，模型写多长就念多长。普通问答里这没问题——长回复
 * 本来就该长；但陪伴模式下的长回复有两个具体伤害：
 *
 * 1. **听不完**：中文 TTS 约 4~5 字/秒，800 字要念三分钟。用户早就不听了，
 *    语音却还在自说自话，这时候插话反而像在打断机器
 * 2. **看不见**：念的时候用户注意力在耳朵上，等念完再看屏幕，已经找不到
 *    刚才那句话在哪了
 *
 * 320 字对应 80~95 秒——超过这个长度，用户几乎必然开始做别的事。所以到量
 * 就停在句子边界，屏幕上的文字照旧完整，收尾再补一句"后面还有内容"。
 *
 * ## 为什么截在句子边界而不是字数边界
 *
 * 调用方拿到的是**整句**（`SentenceStream` 已经切好），所以正常情况只会
 * "整句要不要念"，不会真的切半句。只有单句本身就超过剩余预算时才会切一半
 * ——那时宁可切在字数上，也不要整句跳过（跳过会出现语义断裂）。
 *
 * ## 纯函数
 *
 * 预算与文案无关，只跟字数有关，因此抽成纯函数：hook 里那层 useState/ref
 * 的壳没法单测，"正好用完预算"这类边界正是最容易写错的地方。
 *
 * @module web/voice/speech-budget
 */

/** 单轮朗读的字数预算（约 80~95 秒中文朗读） */
export const SPEAK_BUDGET_CHARS = 320;

/** 一次预算判定的结果 */
export interface BudgetSlice {
  /** 实际要念的文本（空串表示这句不念） */
  text: string;
  /** 累计已念字数（把 `text` 计入之后） */
  used: number;
  /**
   * 预算是否已被用尽/超出
   *
   * 只在"确实有内容没念"时为 true —— 正好用完的那一句不算，否则会在
   * 什么都没截的情况下多念一句"后面还有内容"。
   */
  exhausted: boolean;
}

/**
 * 从一句话里取出预算内的部分
 *
 * @param sentence 待念的整句
 * @param used 之前已念的字数
 * @param budget 预算字数
 * @returns 本次要念的文本与更新后的累计字数
 */
export function takeWithinBudget(sentence: string, used: number, budget: number = SPEAK_BUDGET_CHARS): BudgetSlice {
  // 非法累计值不能往下传：NaN 会让 remaining 变成 NaN，比较全 false，
  // 于是每一句都被当成"预算充足"照念，预算等于没设
  const base = Number.isFinite(used) && used > 0 ? used : 0;
  if (sentence.length === 0) return { text: "", used: base, exhausted: false };

  const remaining = budget - base;
  if (remaining <= 0) return { text: "", used: base, exhausted: true };
  if (sentence.length <= remaining) {
    return { text: sentence, used: base + sentence.length, exhausted: false };
  }
  return { text: sentence.slice(0, remaining), used: budget, exhausted: true };
}
