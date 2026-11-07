/**
 * 结构感知分块：不可切分的「原子区间」与合法切点判定
 *
 * ## 为什么需要它
 *
 * 服务端 TNS 是**单点规则**：`apply_tns(整个请求文本) → split_long_text()`。
 * 只要一个请求里能看到完整的 `{...}`，JSON 就能被还原成中文再切分。
 * 但前端 `sentence.ts` 的弱断句符含 `,` / `:`，`player.ts` 无标点时按 48 字
 * 硬切，于是 `POST https://127.0.0.1:8791/tts/stream` 和 `{text, engine,
 * voice, speed}` 会被切成两三个请求——服务端每次只看到半截 JSON，TNS
 * 无从还原，块间语速极差实测 43.71%（2026-11-07 25 格矩阵 `code:xl`）。
 *
 * 结论不是「在 TS 里再写一份 TNS」（对照实验只降到 27.39%，还把 `voice`
 * 切成 `v`/`oice`），而是**前端别把原子结构切碎**。本模块只回答「哪些位置
 * 不能下刀」，不改写任何文本，因此天然幂等、逐字可逆。
 *
 * 与 `scripts/voice/atomic_chunks.py` 是同一套规则，跨语言一致性由
 * `scripts/voice/atomic-parity-fixtures.json` + 两侧单测保证。
 *
 * ## 索引口径
 *
 * 按 UTF-16 码元索引，与 `String.prototype.slice` / `.length` 一致；
 * Python 侧按 Unicode 码点。BMP 语料（中文、ASCII、常见标点）完全一致，
 * 代理对字符（emoji）不参与 parity 断言——这是既有链路的口径，不在此扩大。
 *
 * @module web/voice/atomic
 */

/** 不可切分区间（闭开） */
export interface AtomicSpan {
  readonly start: number;
  readonly end: number;
}

const PAIRS: Readonly<Record<string, string>> = { "{": "}", "[": "]", "(": ")" };
const CLOSERS = new Set(["}", "]", ")"]);

/** URL 只吃 ASCII：允许中文会一路吞到后面的正文，把「URL 完整结束」误判成切断原子 */
const URL_RE = /(?:https?|ftp):\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/giu;
/** POSIX 路径；`(?!...)` 前的否定环视对齐 Python 的 `(?<![\w:/])`（`\w` 为 Unicode 字母数字下划线） */
const PATH_RE = /(?<![\p{L}\p{N}_:/])(?:~\/|\/)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*/gu;
const LATIN_RE = /[A-Za-z][A-Za-z0-9_.'’-]*/gu;
const NUM_RE = /[0-9][0-9.,:+\-/]*[0-9]|[0-9]/gu;

/** 返回不可切分的原子区间（已排序、已合并、互不重叠） */
export function atomicSpans(text: string): AtomicSpan[] {
  const spans: AtomicSpan[] = [];
  const stack: { opener: string; start: number }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (PAIRS[ch] !== undefined) {
      stack.push({ opener: ch, start: i });
    } else if (CLOSERS.has(ch) && stack.length > 0 && PAIRS[stack[stack.length - 1].opener] === ch) {
      const item = stack.pop() as { opener: string; start: number };
      spans.push({ start: item.start, end: i + 1 });
    }
  }
  // 流式下结构可能尚未闭合：整段尾巴都保护起来（下次重扫会重新识别）
  while (stack.length > 0) {
    const item = stack.pop() as { opener: string; start: number };
    spans.push({ start: item.start, end: text.length });
  }
  for (const rx of [URL_RE, PATH_RE, LATIN_RE, NUM_RE]) {
    rx.lastIndex = 0;
    for (const m of text.matchAll(rx)) {
      spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: AtomicSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    } else {
      merged.push(span);
    }
  }
  return merged;
}

/** 下标 i 的字符是否落在原子内部（禁止结构内标点触发断句） */
export function charInside(spans: readonly AtomicSpan[], i: number): boolean {
  for (const span of spans) {
    if (span.start <= i && i < span.end) return true;
    if (span.start > i) break;
  }
  return false;
}

/** 切点 cut（slice 位置）是否合法：不能落在原子内部，落在边界可以 */
export function cutOk(spans: readonly AtomicSpan[], cut: number): boolean {
  for (const span of spans) {
    if (span.start < cut && cut < span.end) return false;
    if (span.start >= cut) break;
  }
  return true;
}

/** 从 want 往前找合法切点；找不到返回 -1（调用方决定如何诚实降级） */
export function nearestOkCut(spans: readonly AtomicSpan[], want: number, lo: number): number {
  for (let cut = want; cut >= lo; cut -= 1) {
    if (cutOk(spans, cut)) return cut;
  }
  return -1;
}

/** 横跨 cut 的原子的尾部；超过 maxLen 返回 -1（调用方降级硬切） */
export function atomEndAfter(spans: readonly AtomicSpan[], cut: number, maxLen: number): number {
  for (const span of spans) {
    if (span.start < cut && cut < span.end) return span.end <= maxLen ? span.end : -1;
    if (span.start >= cut) break;
  }
  return -1;
}
