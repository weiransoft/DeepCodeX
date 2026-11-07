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

import { atomicSpans, charInside, cutOk, nearestOkCut, type AtomicSpan } from "./atomic";

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
 * @param atomicChunk 结构感知分块（默认关）：`{}`/URL/拉丁词/数字串内部的
 *   标点一律不断句，且切点回退到最近的原子边界；关闭时行为与旧版逐字一致
 * @returns 新完成的句子 + 新游标
 */
export function takeSentences(
  text: string,
  from = 0,
  flush = false,
  weakMinLength = WEAK_BREAK_MIN_LENGTH,
  atomicChunk = false
): SplitResult {
  const sentences: string[] = [];
  let start = from;
  /**
   * 原子区间按**整段累积文本**计算（绝对下标），与 `from` 游标无关。
   * 流式下未闭合的 `{` 会把尾巴保护到末尾，本帧因此不断句；下一帧文本
   * 变长、结构闭合后会重新扫描并补断——游标停在结构前，不会重复朗读。
   */
  const spans: readonly AtomicSpan[] = atomicChunk ? atomicSpans(text) : [];
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

    // JSON 里的 `true,` 与 `": "` 不是句子边界；结构内部（含溢出触发点）
    // 一律跳过，等结构闭合后再断。这是 `code:xl` 43.71% 的第一处根因。
    if (atomicChunk && charInside(spans, i)) continue;
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
    let cut = end + 1;
    if (atomicChunk && !cutOk(spans, cut)) {
      // 断句符后面紧跟半个原子（如 `:` 后是 JSON 内的字符串）：把切点
      // 回退到最近的原子边界；实在找不到就整句留到下一帧重扫。
      const alt = nearestOkCut(spans, cut, start + 1);
      if (alt < 0) continue;
      cut = alt;
    }
    const raw = text.slice(start, cut);
    const cleaned = stripForSpeech(raw);
    if (cleaned.length > 0) sentences.push(cleaned);
    start = cut;
    i = cut - 1;
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
      // 表格正文行：`| 名称 | 数值 |` 念出来是"名称 数值"的碎片，意义为零。
      // 只删以竖线开头且以竖线结尾的整行，避免误伤正文里的竖线。
      .replace(/^\s*\|.*\|\s*$/gm, "")
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
  /** 结构感知分块开关（构造时冻结，默认关；改偏好下次开录生效） */
  private readonly atomicChunk: boolean;

  /** @param atomicChunk 结构感知分块，默认关 */
  constructor(atomicChunk = false) {
    this.atomicChunk = atomicChunk;
  }

  /**
   * 喂一段累积文本
   *
   * @param cumulative 累积文本
   * @returns 新完成的句子
   */
  push(cumulative: string): readonly string[] {
    const result = takeSentences(cumulative, this.consumed, false, this.weakMin(), this.atomicChunk);
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
    const result = takeSentences(cumulative, this.consumed, true, this.weakMin(), this.atomicChunk);
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

/**
 * 判定「累积文本」是否已经翻到新一轮
 *
 * SSE 的 `previewText` 是**累积**文本：同一轮里长度单调递增，且始终以本轮
 * 开头那几个字为前缀。因此下一帧只要出现「变短」或「前缀对不上」，就说明
 * 已经是一条新回复了——这是不依赖收尾事件也能识别轮次边界的可靠信号。
 *
 * 为什么需要它：轮次状态原本只在 `finishFeed()` 复位，而 `finishFeed` 只挂在
 * `assistant_message` 上。工具轮（引擎丢弃 `visible=false`）、用户打断、断线
 * 重连、切会话都可能让这一帧缺席；残留的游标停在上一轮末尾，下一轮文本
 * 比它短时 `takeSentences` 循环一次都不进，连一次 TTS 请求都不会发——
 * 也就是「聊着聊着就再也不说话了」。这里做兜底，让 feed 自己能开新一轮。
 *
 * @param prev 本轮上一次喂入的累积文本（空串表示本轮还没喂过）
 * @param next 本次收到的累积文本
 * @returns true 表示应先把轮次状态复位再处理 next
 */
export function isNewTurnText(prev: string, next: string): boolean {
  if (prev.length === 0 || next.length === 0) return false;
  // 同一轮不会变短；变短只可能是新一轮从头开始（或事件重放）
  if (next.length < prev.length) return true;
  // 长度没回退也要防「上一轮很短、新一轮第一帧就已经更长」：比对开头片段
  const head = prev.slice(0, Math.min(12, prev.length));
  return !next.startsWith(head);
}
