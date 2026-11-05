/**
 * 句级切分（流式语音播报的入口）
 *
 * ## 为什么要"流式切句"而不是"等整段"
 *
 * 业界共识：把 LLM 回复按句送 TTS，是首字延迟从 2~4s 降到 0.6~1.2s 的
 * 单一最大收益项。等整段生成完再合成，等于把模型生成时间全额加在用户等待上。
 *
 * ## 为什么切句要剥 Markdown
 *
 * 司南的输出可能带代码块、行内代码、链接、表格。把这些朗读出来是灾难：
 * 用户会听到"三个反引号 bash 换行 npm install"。这里在**送出前**做保守剥离：
 * 只剥代码块与行内代码、URL，其余原样——过度清洗会把正常句子吃掉。
 *
 * ## 为什么用"累积文本 + 游标"而不是"增量拼缓冲"
 *
 * SSE 的 `llm_delta` 给的是**累积**文本（previewText），不是增量片段。
 * 用游标记住"已经送出去到哪"，天然幂等：同一条 event 重放也不会重复朗读。
 *
 * @module web/voice/sentence
 */

/** 强断句符（出现即断） */
const STRONG_BREAKS = new Set(["。", "！", "？", "!", "?", "；", ";", "…"]);

/**
 * 弱断句符（句长超过阈值才断）
 *
 * 只在长句上启用：中文里逗号太密，见逗号就断会得到一堆两字短句，
 * 合成出来的语气碎得像电报。
 */
const WEAK_BREAKS = new Set(["，", ",", "、", "：", ":"]);

/** 弱断句的最短句长（字符） */
const WEAK_BREAK_MIN_LENGTH = 28;

/**
 * 首句的弱断句阈值（比后续句子短得多）
 *
 * 首句的合成时长直接等于用户按下到听见第一个音的间隔（TTFA）。等一个
 * 28 字的从句攒够再合成，等于把"模型写到第 28 个字"的时间全额加在等待上。
 * 首句放到 12 字就在最近的逗号处断一次，能让出声时间明显提前——代价是
 * 第一句可能偏短、语气略碎，后续句子恢复 28 字找回节奏。
 *
 * 这是 OpenClaw 用「流式播放」达到同一个目标的本机替代：我们没有增量音频，
 * 但可以缩短第一块音频的长度。
 */
export const FIRST_WEAK_BREAK_MIN_LENGTH = 12;

/** 单句朗读上限：超长句子在下次弱断句强制切开，避免一句读 30 秒 */
const MAX_SENTENCE_LENGTH = 120;

/**
 * 切句结果
 */
export interface SplitResult {
  /** 本次新完成的句子（已剥 Markdown、已 trim、非空） */
  readonly sentences: readonly string[];
  /** 新的游标（下次从这里继续） */
  readonly consumed: number;
}

/**
 * 流式切句
 *
 * @param text 累积文本（`llm_delta` 的 previewText）
 * @param from 上次返回的游标
 * @param flush 是否收尾（流结束时为 true，把剩余残句也吐出来）
 * @param weakMinLength 弱断句的最短句长（首句用更短的值以降 TTFA）
 * @returns 新完成的句子 + 新游标
 */
export function takeSentences(
  text: string,
  from = 0,
  flush = false,
  weakMinLength = WEAK_BREAK_MIN_LENGTH
): SplitResult {
  const sentences: string[] = [];
  let start = from;
  /**
   * 是否处在围栏代码块内部
   *
   * 这一位必须在这里维护，不能只靠 `stripForSpeech` 事后剥离：
   * 代码块内部同样有换行和标点，逐字符扫描会在块内断句，
   * 断出来的碎片已经不含 ``` 标记，剥离函数无从判断它属于代码。
   * 结果是 `print('hi')` 被念出来——这是真实发生过的失败模式。
   */
  let inFence = false;

  for (let i = from; i < text.length; i += 1) {
    // 围栏标记：进入/退出代码块。标记本身留在区间内，由剥离函数一并吃掉，
    // 这样 fence 未闭合时 consumed 停在块前，下次重扫能重新识别状态（幂等）。
    if (text.startsWith("```", i)) {
      inFence = !inFence;
      i += 2;
      continue;
    }
    if (inFence) continue;

    const char = text[i];
    const length = i - start + 1;
    const isStrong = STRONG_BREAKS.has(char);
    // 省略号「……」是连续两个 …，读到第一个就断会产生空句，交给下一次迭代
    const isWeak = !isStrong && WEAK_BREAKS.has(char) && length >= weakMinLength;
    const isNewline = char === "\n";
    const isOverflow = length >= MAX_SENTENCE_LENGTH;

    if (!isStrong && !isWeak && !isNewline && !isOverflow) continue;

    // 强断句符后面紧跟同类符号（"！！"、"……"）时，把这一串一起吃掉
    let end = i;
    while (end + 1 < text.length && STRONG_BREAKS.has(text[end + 1]) && STRONG_BREAKS.has(char)) {
      end += 1;
    }
    const raw = text.slice(start, end + 1);
    const cleaned = stripForSpeech(raw);
    if (cleaned.length > 0) sentences.push(cleaned);
    start = end + 1;
    i = end;
  }

  // 收尾：把没有断句符的尾巴也读出来（否则最后一句永远不播）
  // 若收尾时仍在代码块内，`stripForSpeech` 的未闭合围栏规则会把它整段剥掉。
  if (flush && start < text.length) {
    const cleaned = stripForSpeech(text.slice(start));
    if (cleaned.length > 0) sentences.push(cleaned);
    return { sentences, consumed: text.length };
  }

  return { sentences, consumed: start };
}

/**
 * 剥掉不该朗读的部分
 *
 * 处理顺序很重要：先整块删围栏代码块（否则其中的行内反引号会打乱后续匹配），
 * 再删行内代码与 URL，最后压空白。
 *
 * @param text 原始片段
 * @returns 可朗读文本
 */
export function stripForSpeech(text: string): string {
  return (
    text
      // 围栏代码块（```lang ... ```），连同语言标记一起删
      .replace(/```[\s\S]*?```/g, "")
      // 未闭合的围栏（流式下常见：只收到前半个```）
      .replace(/```[\s\S]*$/g, "")
      // 行内代码
      .replace(/`[^`\n]*`/g, "")
      // Markdown 链接 → 只留文字
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // 裸 URL（朗读一串路径没有意义）
      .replace(/https?:\/\/\S+/g, "")
      // 标题/列表/引用符号
      .replace(/^\s*[#>\-*+]+\s*/gm, "")
      // 表格分隔线
      .replace(/^\s*\|?[\s:|-]{4,}\|?\s*$/gm, "")
      // 压缩空白
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * 句级切分器（带游标状态）
 *
 * 给 UI 用的小封装：每条 delta 调一次 `push`，`flush` 在流结束时调一次。
 */
export class SentenceStream {
  /** 已送出到的位置 */
  private consumed = 0;
  /** 已送出的句子数（决定用首句阈值还是常规阈值） */
  private emitted = 0;

  /**
   * 喂一段累积文本
   *
   * @param cumulative 累积文本
   * @returns 新完成的句子
   */
  push(cumulative: string): readonly string[] {
    const result = takeSentences(cumulative, this.consumed, false, this.weakMin());
    this.consumed = result.consumed;
    this.emitted += result.sentences.length;
    return result.sentences;
  }

  /**
   * 收尾：吐出剩余残句
   *
   * @param cumulative 累积文本
   * @returns 剩余句子
   */
  flush(cumulative: string): readonly string[] {
    const result = takeSentences(cumulative, this.consumed, true, this.weakMin());
    this.consumed = result.consumed;
    this.emitted += result.sentences.length;
    return result.sentences;
  }

  /** 当前该用的弱断句阈值：一句还没送出去时用更短的首句阈值 */
  private weakMin(): number {
    return this.emitted === 0 ? FIRST_WEAK_BREAK_MIN_LENGTH : WEAK_BREAK_MIN_LENGTH;
  }

  /** 复位（新一轮回复开始时调用） */
  reset(): void {
    this.consumed = 0;
    this.emitted = 0;
  }
}
