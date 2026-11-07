/**
 * 语音播报队列（块级预生成 + 采样级拼接 + 可打断 + 停滞自愈）
 *
 * ## 设计要点
 *
 * 1. **块内合并、块间预生成**——TTS 每收到一次请求都会重新起头：同一段话
 *    被切成四段打四次请求，就会得到四种韵律。所以这里先把连续句子攒成
 *    "块"（默认首块 24 字、后续 72 字）再一次请求，块数从十几降到四五个。
 * 2. **先合成、再排程**——块合并后先落成音频，攒够开播门槛才进时间轴，
 *    避免"合成一块播一块"时把合成抖动暴露给耳朵。
 * 3. **打断即清空**——`stop()` 要同时停音频、清队列、标记被截断、
 *    并让正在 await 的播放立刻结束。
 * 4. **失败不哑**——某块合成失败就跳过并回调错误，其余块继续；
 *    整条链路挂掉时把文本留在气泡里（文本永远是可靠的降级）。
 * 5. **停滞必须自愈**——`HTMLAudioElement` 有一类"僵尸"状态：音频不再出声，
 *    但 `ended` 与 `error` 都不触发，等待永久挂住，之后每一次 `enqueue`
 *    都被静默丢弃。
 *
 * ## 演进史（都是真机上量出来的）
 *
 * - **2026-11-05 僵尸播放**：`stop()` 里的 `pause()` 既不触发 `ended` 也不触发
 *   `error`，promise 永不 settle，队列永久卡死。修法是看门狗 + `settlePlay`，
 *   逻辑搬到了 `playout.ts` 的 `AudioElementClipPlayer`。
 * - **2026-11-06 句间空等**：`warmPrefetch()` 原先在 `playOne` **之后**调，
 *   那一刻当前句已经播完，下一句的合成才刚开始 → 每两句固定空等一次合成。
 *   改成播之前预取。
 * - **2026-11-06 句间卡顿（第二层）**：真机量出 TTS 每句自带 88ms 句首 +
 *   46~49ms 句尾机械静音，以及每个 `Audio` 元素切换一次的媒体线程开销。
 *   解法是把音频搬进 `AudioContext` 时间轴按采样点拼接（见 `playout.ts`）。
 * - **2026-11-06 音色句句不同**：定位到两件事——① `sentence.ts` 的弱断句
 *   阈值只有 28 字，长句在逗号处被切成三四段，每段都是一次独立的 TTS 请求，
 *   每次请求都重新起韵律；② 服务端 CustomVoice 分支漏传 `temperature`，
 *   一直用模型默认的高温采样。修法是这里的**块级合并**（减少请求次数）
 *   加上服务端补温度。
 *
 * @module web/voice/player
 */

import {
  AudioElementClipPlayer,
  SinkUnavailableError,
  createDefaultPlayer,
  createFallbackPlayer as defaultFallbackPlayer,
  gapBeforeMs,
  type ClipPlayer,
  type PlayOutcome,
  type ScheduledClip,
} from "./playout";

/** 合成函数：文本 → objectURL（由后端负责回收） */
export type SynthFn = (text: string, signal?: AbortSignal) => Promise<string>;

/**
 * 流式合成函数：边生成边回调独立 WAV 块
 *
 * 与 `SynthFn` 的关键区别是**它不必等整段生成完**：模型每解出一小段音频
 * 就 `onChunk` 一次，队列可以把这段立刻排进时间轴，首字延迟从"整段生成
 * 耗时"降到"第一块到达耗时"（实测 1.92s → 0.39s）。
 *
 * 返回 0 块表示"这条路这次不走"（例如服务端不支持流式或用户关了开关），
 * 队列据此自动回退整块合成，不报错、不哑。
 *
 * @param text 待合成文本
 * @param onChunk 音频块到达（`url` 所有权交给队列，由播放后端回收）
 * @param signal 打断信号：`stop()` 会 abort，实现方应停止读取响应流
 * @returns 实际交付的块数
 */
export type StreamSynthFn = (
  text: string,
  onChunk: (url: string, index: number) => void,
  signal: AbortSignal
) => Promise<number>;

/** 播放器可注入的依赖（测试用；生产走默认值） */
export interface SpeechQueueDeps {
  /**
   * 音频元素工厂
   *
   * 给出它就等同于强制走元素后端（测试用：`new Audio()` 在 node 里不存在）。
   *
   * @param url objectURL
   * @returns 音频元素
   */
  createAudio?: (url: string) => HTMLAudioElement;
  /** 播报后端（生产默认 Web Audio，不可用时降级） */
  player?: ClipPlayer;
  /** 降级后端工厂（默认元素播放） */
  createFallbackPlayer?: () => ClipPlayer;
  /** 首块目标字数（默认 24） */
  firstBlockChars?: number;
  /** 后续块目标字数（默认 72） */
  blockChars?: number;
  /** 单块字数硬上限（默认 160） */
  maxBlockChars?: number;
  /** 单块最短等效发音单元数（默认 10，低于此值不单独发合成请求） */
  minBlockUnits?: number;
  /** 开播前至少缓存多少字（默认与首块目标一致） */
  warmupChars?: number;
  /** 多久没有任何播放进展就判定停滞（默认 5000ms，仅元素后端用） */
  stallLimitMs?: number;
  /** 停滞检查间隔（默认 1000ms，仅元素后端用） */
  stallCheckIntervalMs?: number;
  /** `play()` 启动超时（默认 10000ms，仅元素后端用） */
  playStartTimeoutMs?: number;
  /** 时钟（测试可注入，默认 performance.now） */
  now?: () => number;
  /**
   * 流式合成函数（给了就走流式播放分支）
   *
   * 不给就完全是原来的「整块合成 → 排程」路径，589 条既有用例的行为
   * 一个字都不变。这样新路径的风险不会外溢到已经稳定的链路。
   */
  streamSynth?: StreamSynthFn;
}

/** 播报队列回调 */
export interface SpeechQueueCallbacks {
  /** 开始播某块（UI 显示"正在说"） */
  onSpeakingChange?: (speaking: boolean) => void;
  /** 某块合成/播放失败（不中断后续） */
  onError?: (message: string) => void;
  /** 提示性消息（如后端降级）：不是故障，不该弹红色错误 */
  onNotice?: (message: string) => void;
  /** 被打断（用于截断记账） */
  onInterrupted?: (spokenText: string) => void;
}

/**
 * 首块目标字数
 *
 * 首块的合成时长直接等于"点下去到听见第一个音"的间隔（TTFA），所以它比
 * 后续块小得多。24 字约 6 秒音频、合成 1.1 秒；按实测语速 4.1 字/秒折算，
 * 14 字约 3.4 秒音频、合成约 0.6 秒，首字延迟少一半。
 *
 * 为什么敢再压：音色一致性靠的是"块内一次自回归 + 音色锁在 speaker 上"，
 * 首块短一点只是多一个块边界，不会像以前按 28 字切句那样每句重新起头。
 * 代价是首块语义可能停在逗号处，所以要求切句器优先在句末断（见 sentence.ts）。
 */
export const FIRST_BLOCK_CHARS = 14;

/**
 * 后续块目标字数
 *
 * 提到与服务端安全上限一致（48）：长文本专项实测（2026-11-07，316/421 字
 * 真实回复）显示，前端每多切一个块就多一次独立自回归生成，块越多音色
 * 起伏越大——13 个块的时间窗 F0 极差 54%，而整段一次请求只有 25%。
 * 首块仍单独压到 14 字保 TTFA，后续块尽量吃满上限以减少重新起头。
 */
export const BLOCK_CHARS = 48;

/**
 * 单块最短等效发音单元数
 *
 * 几字碎片是长文本「忽然换人」的元凶：实测 3 字块 F0 300Hz / 质心
 * 4998Hz、13 字块 12.4 字/秒，而正常块 F0 210~250Hz、语速 4.9 单元/秒。
 * 模型会把极短文本当短促感叹句起头。低于这个量的块要么继续攒、要么
 * 并入相邻块，绝不单独发一次合成请求。
 *
 * 阈值只覆盖真正的碎片：中英混排 48 字符折算后常只有 15~20 单元，定 20
 * 会把正常块全误判成碎片（A/B 实测语速极差反而从 21% 涨到 63%）。
 */
export const MIN_BLOCK_UNITS = 10;

/** 与服务端口径一致的可断句标点 */
const SPLIT_PUNCT = "。！？!?；;，,、：:";

/**
 * 切分点的自然度：0=标点后，1=空格/中英交界，2=词中间（最差）
 *
 * 硬切拉丁单词会把 `openai-provider` 拆成 `opena` + `i-provider`，两块各自
 * 起头念，听感比原来的短碎片还糟。达标切分点里必须先把词边界挑出来。
 */
function splitBoundaryClass(text: string, cut: number): number {
  const before = text[cut - 1] ?? "";
  const after = text[cut] ?? "";
  if (SPLIT_PUNCT.includes(before)) return 0;
  if (/\s/u.test(before) || /\s/u.test(after)) return 1;
  if (before.charCodeAt(0) > 127 !== after.charCodeAt(0) > 127) return 1;
  return 2;
}

/**
 * 把「前一块 + 过短碎片」重划切分点，让两块都达到最短发音量
 *
 * **借多少必须按等效发音单元算**（2026-11-07 第四轮真机复测的最后一处漏洞）：
 * 旧实现拿 `minUnits - speechUnits(short)` 当「字符数」往前借，中英混排里
 * 1 个字符常常只值 0.36 单元，缺 3 单元只借 3 字符，借完仍是 7~8 单元的
 * 碎片，照样单独发一次自回归生成（实测 `和 anthropic-provider。` 22 字符 /
 * 7.07 单元，把整条语料的单元语速极差从 1.38% 拉到 21.27%）。
 *
 * 这里枚举合法切分点（左右都 ≤ limit 字），只保留两段都 >= minUnits 的，
 * 优先标点、其次空格 / 中英交界、再其次贴近原切分点；发音量实在撑不起
 * 两块时退化成让较小那段尽量大。纯拼接，不吞字不重复。
 *
 * @param prev 前一块
 * @param short 过短的碎片
 * @param minUnits 每块最短等效发音单元数
 * @param limit 单块字数硬上限
 * @returns 1~2 块，拼接后逐字等于 prev + short
 */
export function rebalanceShortBlock(prev: string, short: string, minUnits: number, limit: number): string[] {
  const merged = prev + short;
  if (merged.length <= limit || prev.length === 0) return [merged];
  const lo = Math.max(1, merged.length - limit);
  const hi = Math.min(limit, merged.length - 1);
  if (lo > hi) return [merged.slice(0, limit), merged.slice(limit)];

  const cuts: number[] = [];
  for (let c = lo; c <= hi; c += 1) cuts.push(c);
  const minSide = (c: number): number => Math.min(speechUnits(merged.slice(0, c)), speechUnits(merged.slice(c)));
  const prefer = (a: number, b: number): number =>
    splitBoundaryClass(merged, a) - splitBoundaryClass(merged, b) ||
    Math.abs(a - prev.length) - Math.abs(b - prev.length);

  const valid = cuts.filter((c) => minSide(c) >= minUnits);
  let best: number;
  if (valid.length > 0) {
    best = valid.reduce((a, b) => (prefer(a, b) <= 0 ? a : b));
  } else {
    best = cuts.reduce((a, b) => {
      const delta = minSide(b) - minSide(a);
      if (delta > 1e-9) return b;
      if (delta < -1e-9) return a;
      return prefer(a, b) <= 0 ? a : b;
    });
  }
  return [merged.slice(0, best), merged.slice(best)];
}

/** 与服务端 `speech_units()` 同规则：标点 0、汉字 1、拉丁 2.8 字母 1、数字每位 0.9 */
export function speechUnits(text: string): number {
  const LATIN = /[A-Za-z]/;
  const DIGIT = /[\p{Nd}]/u;
  const NON_SPEECH = /[\p{P}\p{Z}\p{S}\p{C}]/u;
  let units = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (NON_SPEECH.test(ch)) {
      i += 1;
      continue;
    }
    if (LATIN.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z'’]/.test(text[j])) j += 1;
      const word = text.slice(i, j);
      const letters = (word.match(/[A-Za-z]/g) ?? []).length;
      const isAbbrev = letters > 0 && letters <= 6 && word === word.toUpperCase();
      units += isAbbrev ? letters * 0.9 : Math.max(1, letters / 2.8);
      i = j;
      continue;
    }
    if (DIGIT.test(ch)) {
      let j = i;
      let digits = 0;
      let dots = 0;
      while (j < text.length) {
        const c = text[j];
        if (DIGIT.test(c)) digits += 1;
        else if (".,:/-".includes(c) && DIGIT.test(text[j + 1] ?? "")) dots += 1;
        else break;
        j += 1;
      }
      units += Math.max(0.5, digits * 0.9 + dots * 0.5);
      i = j;
      continue;
    }
    units += 1;
    i += 1;
  }
  return units;
}

/**
 * 单块字数硬上限
 *
 * **这个值是被真机反馈逼出来的**（2026-11-06「前后两句语速不一样 /
 * 第二段讲了几句就中断」）。同一句文本走 `/tts` 全链路实测：
 *
 * | 字数 | 折合语速 | 最长连续静音 |
 * |---|---|---|
 * | 41 | 4.92 字/秒 | 0.66s |
 * | 55 | 3.28 字/秒 | 4.67s |
 * | 96 | 3.28 字/秒 | 21.49s |
 * | 164 | 3.28 字/秒 | 21.51s |
 *
 * 超过约 50 字，Qwen3-TTS 就会退化成「一路生成到 max_tokens 上限」，
 * 多出来的 token 全解成尾部静音。退化后语速恒定 3.28 = 4.92 / 1.5
 * （正好是生成上限的安全余量），于是短块与长块语速差一半，且长块
 * 播到一半开始放十几秒空白——听起来就是「讲了几句没声了」。
 *
 * 48 字留了一点标点余量；服务端另有 `trim_degenerate_tail` 兜底。
 */
export const MAX_BLOCK_CHARS = 48;

/** 默认停滞上限：5 秒没有任何 currentTime 推进，就不可能还在正常播放 */
const DEFAULT_STALL_LIMIT_MS = 5000;

/** 默认检查间隔 */
const DEFAULT_STALL_CHECK_MS = 1000;

/** 默认启动超时 */
const DEFAULT_PLAY_START_TIMEOUT_MS = 10_000;

/**
 * 待合成块的上限（有界队列）
 *
 * 生成速度远快于 TTS 时，无界 `blocks` 会让用户听到几分钟前的旧内容，
 * 而且每一轮都把新请求排到队尾——表现就是「越聊越迟钝」。业界做法是
 * 有界队列 + 背压；这里没有向 LLM 反向施压的通道，所以用「丢最旧块」
 * 兜底：宁可漏掉过期内容，也不能让延迟无限累加。24 块 ≈ 4 分钟音频，
 * 正常对话不会触发。
 */
const MAX_PENDING_BLOCKS = 24;

/** 流水线里的一块 */
interface InflightClip {
  /** 原文（记账用） */
  text: string;
  /** 排程句柄 */
  clip: ScheduledClip;
}

/** 已合成、待排程的块 */
interface WaitingBlock {
  /** 原文（流式块只有第 0 块带原文，其余为空串） */
  text: string;
  /** objectURL */
  url: string;
  /** 流式连续块：不裁静音、不加停顿、不补尾音 */
  continuous: boolean;
}

/**
 * 拼接块内的句子
 *
 * 切句是人为在标点处切开的，中文直接拼回去等于原文；西文需要补一个空格，
 * 否则 `Hello.How are you` 会被念成连读的一串。
 *
 * @param parts 句子
 * @returns 拼接后的文本
 */
export function joinSentences(parts: readonly string[]): string {
  let out = "";
  for (const part of parts) {
    if (out.length === 0) {
      out = part;
      continue;
    }
    const needSpace = /[A-Za-z0-9,.!?;:)\]]$/.test(out) && /^[A-Za-z0-9([]/.test(part);
    out += needSpace ? ` ${part}` : part;
  }
  return out;
}

/**
 * 把超长文本切成 ≤limit 字的块，优先在标点处断
 *
 * 为什么还要这一层：`sealIfReady()` 是按"累计字数到阈值"封块的，模型一次
 * 吐出一段没有标点的长文本时，整段会一次性进 `pushBlock`。不二次切分就会
 * 出现 180 字单块（真机日志实测过），触发 TTS 退化并播十几秒静音。
 *
 * @param text 待切分文本
 * @param limit 每块字数上限
 * @returns 按原文顺序的块（不会丢字）
 */
export function splitLongText(text: string, limit: number, minUnits = MIN_BLOCK_UNITS): string[] {
  const out: string[] = [];
  let rest = text.trim();
  const punct = "。！？!?；;，,、：:";
  const min = Math.max(1, Math.floor(limit * 0.6));
  while (rest.length > limit) {
    let cut = -1;
    // 从上限往前找标点，别把一句话拦腰切断；找不到就按字数硬切
    for (let i = limit; i >= min; i -= 1) {
      if (punct.includes(rest[i - 1] ?? "")) {
        cut = i;
        break;
      }
    }
    if (cut < 0) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  // 尾段平衡：几字碎片单独合成会被模型当成短促感叹句（实测 F0 冲到 300Hz）。
  // 借多少按等效发音单元算（见 rebalanceShortBlock），不能拿单元缺口当字符数：
  // 中英混排 1 字符常只有 0.36 单元，按字符借会留下 7~8 单元的碎片。
  if (rest.length > 0 && out.length > 0 && speechUnits(rest) < minUnits) {
    const balanced = rebalanceShortBlock(out[out.length - 1], rest, minUnits, limit);
    out[out.length - 1] = balanced[0];
    rest = balanced[1] ?? "";
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/**
 * 块级播报队列
 */
export class SpeechQueue {
  /** 正在攒的句子 */
  private blockBuffer: string[] = [];
  /** 正在攒的字数 */
  private blockChars = 0;
  /** 太短、又没赶上尚未消费的前块的碎片：先攒着，等下一块 / flush 结算 */
  private pendingShort = "";
  /** 已封块、待合成 */
  private blocks: string[] = [];
  /** 已合成、待排程 */
  private waiting: WaitingBlock[] = [];
  /** 已合成未排程的字数（开播门槛用） */
  private waitingChars = 0;
  /** 已封块数（决定首块还是常规块） */
  private sealedCount = 0;
  /** 句子流是否结束 */
  private endOfStream = false;
  /** 是否已经开播 */
  private startedPlaying = false;
  /** 已播出的块文本（用于截断记账） */
  private spoken: string[] = [];
  /** 是否正在跑循环 */
  private running = false;
  /** 终止标记（stop 后丢弃在飞结果） */
  private stopped = false;
  /** 本轮已排程的块数（用来判断"首块不等待"） */
  private scheduledCount = 0;
  /** 已排程但还没播完的块数（`speaking` 用） */
  private playing = 0;
  /** 后端 */
  private player: ClipPlayer;
  /** 是否已经降级过（只降一次，避免来回抖） */
  private usedFallback = false;
  /** 回调 */
  private readonly callbacks: SpeechQueueCallbacks;
  /** 整块合成函数 */
  private readonly synth: SynthFn;
  /** 流式合成函数（null = 走整块路径） */
  private readonly streamSynth: StreamSynthFn | null;
  /** 在飞的合成任务数（流式分支用；`speaking` 也要算上它） */
  private activeSynth = 0;
  /** 打断代数：stop 后丢弃还在飞的结果，避免旧一轮的音频串到新一轮 */
  private generation = 0;
  /** 当前流式请求的终止器 */
  private streamAbort: AbortController | null = null;
  /** 等待"队列有变化"的唤醒器（生产者-消费者的条件变量） */
  private wake: (() => void) | null = null;
  /** notify 早于 wait 时记一笔，避免丢唤醒 */
  private wakePending = false;
  /** 降级后端工厂 */
  private readonly fallbackFactory: (() => ClipPlayer) | null;
  /** 首块目标字数 */
  private readonly firstBlockChars: number;
  /** 后续块目标字数 */
  private readonly blockCharsTarget: number;
  /** 单块硬上限 */
  private readonly maxBlockChars: number;
  /** 单块最短等效发音单元数 */
  private readonly minBlockUnits: number;
  /** 开播门槛字数 */
  private readonly warmupChars: number;

  /**
   * 构造
   *
   * @param synth 合成函数
   * @param callbacks 回调
   * @param deps 可注入依赖（测试用）
   */
  constructor(synth: SynthFn, callbacks: SpeechQueueCallbacks = {}, deps: SpeechQueueDeps = {}) {
    this.synth = synth;
    this.streamSynth = deps.streamSynth ?? null;
    this.callbacks = callbacks;
    const now = deps.now ?? (() => performance.now());
    const elementPlayer =
      deps.createAudio === undefined
        ? null
        : new AudioElementClipPlayer(
            deps.createAudio,
            deps.stallLimitMs ?? DEFAULT_STALL_LIMIT_MS,
            deps.stallCheckIntervalMs ?? DEFAULT_STALL_CHECK_MS,
            deps.playStartTimeoutMs ?? DEFAULT_PLAY_START_TIMEOUT_MS,
            now
          );
    this.player = deps.player ?? elementPlayer ?? createDefaultPlayer();
    // 给了元素工厂就不再降级（已经是最低层），避免二次切换互相覆盖
    this.fallbackFactory = elementPlayer !== null ? null : (deps.createFallbackPlayer ?? defaultFallbackPlayer);
    this.firstBlockChars = deps.firstBlockChars ?? FIRST_BLOCK_CHARS;
    this.blockCharsTarget = deps.blockChars ?? BLOCK_CHARS;
    this.maxBlockChars = deps.maxBlockChars ?? MAX_BLOCK_CHARS;
    this.minBlockUnits = deps.minBlockUnits ?? MIN_BLOCK_UNITS;
    this.warmupChars = deps.warmupChars ?? this.firstBlockChars;
  }

  /**
   * 追加一句话
   *
   * 不会立刻合成：先攒进当前块，够字数才封块。
   *
   * @param text 句子
   */
  enqueue(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.stopped = false;
    this.blockBuffer.push(trimmed);
    this.blockChars += trimmed.length;
    this.sealIfReady();
    // 流式循环可能正挂在 waitForChange() 上：新句子到达必须叫醒它
    this.notify();
    void this.drain();
  }

  /**
   * 通知"句子流结束"
   *
   * 必须调：否则最后不满一块的尾巴永远不合成、不播。调用方在流收尾
   * （`finishFeed`）与整段朗读（`speak`）两处触发。
   */
  flush(): void {
    this.endOfStream = true;
    // stop() 之后可能只来 flush（尾巴封块）而没有新的 enqueue：不复位
    // stopped 的话整个消费循环都进不来，最后一块永远不播。
    this.stopped = false;
    while (this.blockBuffer.length > 0) {
      const parts: string[] = [];
      let size = 0;
      while (this.blockBuffer.length > 0 && size + this.blockBuffer[0].length <= this.maxBlockChars) {
        const next = this.blockBuffer.shift() as string;
        parts.push(next);
        size += next.length;
      }
      // 单句本身超上限：只能整句成块，否则会卡在这里
      if (parts.length === 0) parts.push(this.blockBuffer.shift() as string);
      this.pushBlock(joinSentences(parts));
    }
    this.blockChars = 0;
    // 流结束了，攒着的短碎片必须现在结算：能并回最后一块就并，实在已经
    // 全部进了时间轴也只能放行这一小段（诚实边界，不静默丢字）。
    if (this.pendingShort) {
      const tail = this.pendingShort;
      this.pendingShort = "";
      if (this.blocks.length > 0) {
        this.absorbShortIntoLast(tail);
      } else {
        this.appendBlock(tail);
      }
    }
    // 尾巴封块 + endOfStream 都要让流式循环立刻看见，不能等下一次网络事件
    this.notify();
    void this.drain();
  }

  /**
   * 打断：停音频、清队列、记截断
   *
   * 顺序有讲究：先叫醒正在 await 的播放（否则它会在 await 里挂到超时），
   * 再停后端。
   */
  stop(): void {
    this.stopped = true;
    // 先断代再 abort：在飞的 onChunk / synth.then 用 generation 判活，
    // 即使它们晚到也不会把旧一轮的音频排进新一轮时间轴
    this.generation += 1;
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.activeSynth = 0;
    this.cancelWake();
    this.blockBuffer = [];
    this.blockChars = 0;
    this.pendingShort = "";
    this.blocks = [];
    for (const item of this.waiting) URL.revokeObjectURL(item.url);
    this.waiting = [];
    this.waitingChars = 0;
    this.endOfStream = false;
    this.startedPlaying = false;
    this.sealedCount = 0;
    this.player.stop();
    this.playing = 0;
    this.scheduledCount = 0;
    this.callbacks.onSpeakingChange?.(false);
    if (this.spoken.length > 0) {
      this.callbacks.onInterrupted?.(this.spoken.join(""));
      this.spoken = [];
    }
  }

  /** 是否正在播（或还有内容待播） */
  get speaking(): boolean {
    return (
      this.playing > 0 ||
      this.activeSynth > 0 ||
      this.blocks.length > 0 ||
      this.waiting.length > 0 ||
      this.blockBuffer.length > 0
    );
  }

  /** 释放后端资源（页面卸载时调用） */
  dispose(): void {
    this.stop();
    this.player.dispose();
  }

  /** 当前块的目标字数 */
  private blockTarget(): number {
    return this.sealedCount === 0 ? this.firstBlockChars : this.blockCharsTarget;
  }

  /** 攒够就封块 */
  private sealIfReady(): void {
    if (this.blockChars < this.blockTarget() && this.blockChars < this.maxBlockChars) return;
    // 非首块必须达到最短发音量：几字碎片会被模型当短促感叹句，用高音区 /
    // 快语速念出来。首块豁免，否则 TTFA 会被拖长（实测见 MIN_BLOCK_UNITS）。
    if (this.sealedCount > 0 && speechUnits(joinSentences(this.blockBuffer)) < this.minBlockUnits) {
      return;
    }
    this.pushBlock(joinSentences(this.blockBuffer));
    this.blockBuffer = [];
    this.blockChars = 0;
  }

  /**
   * 记录一个块
   *
   * @param text 块文本
   */
  private pushBlock(text: string): void {
    // 上一轮攒着的短碎片接在新文本前面：只是把切分点往回挪，逐字可逆。
    const trimmed = (this.pendingShort + text.trim()).trim();
    this.pendingShort = "";
    if (trimmed.length === 0) return;
    // 硬上限必须在这里兜住：超过 48 字的单块会让 TTS 退化出十几秒静音，
    // 详见 MAX_BLOCK_CHARS 的实测说明。服务端裁尾只是第二道保险。
    const parts =
      trimmed.length <= this.maxBlockChars ? [trimmed] : splitLongText(trimmed, this.maxBlockChars, this.minBlockUnits);
    for (const part of parts) {
      const clean = part.trim();
      if (clean.length === 0) continue;
      // 首块豁免：它决定 TTFA，短一点是刻意的（见 FIRST_BLOCK_CHARS）。
      const isFirstBlock = this.sealedCount === 0 && this.blocks.length === 0;
      if (!isFirstBlock && speechUnits(clean) < this.minBlockUnits) {
        if (this.blocks.length === 0) {
          // 前一块已经被消费进合成 / 时间轴，没得可并：攒着跟下一块一起发，
          // 绝不为了几字碎片单独起一次自回归生成。flush() 会兜底结算。
          this.pendingShort += clean;
          continue;
        }
        this.absorbShortIntoLast(clean);
        continue;
      }
      this.appendBlock(clean);
    }
  }

  /** 把短碎片并入最后一块；并不下时按等效发音单元重划切分点 */
  private absorbShortIntoLast(short: string): void {
    const last = this.blocks[this.blocks.length - 1];
    const balanced = rebalanceShortBlock(last, short, this.minBlockUnits, this.maxBlockChars);
    this.blocks[this.blocks.length - 1] = balanced[0];
    if (balanced[1]) this.appendBlock(balanced[1]);
  }

  /** 入队（同时守住有界队列） */
  private appendBlock(text: string): void {
    if (this.blocks.length >= MAX_PENDING_BLOCKS) {
      this.blocks.shift();
      this.callbacks.onNotice?.(`播报积压超过 ${MAX_PENDING_BLOCKS} 块，已丢弃最早一块`);
    }
    this.blocks.push(text);
    this.sealedCount += 1;
  }

  /**
   * 队列消费循环（同一时刻只允许一个实例在跑）
   *
   * 单块合成失败只跳过该块——整条队列不能因为一块合不出来就全停，
   * 那会让用户以为语音功能"失灵"。
   */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelWake();
    try {
      // 两条路径互不影响：没注入 streamSynth 就走原来那条经过 589 条用例
      // 验证的整块链路；注入了才启用生产者-消费者。这样即使流式这条路
      // 出问题，也能一眼关掉而不必回滚整块逻辑。
      if (this.streamSynth !== null) await this.drainStreaming();
      else await this.drainBuffered();
    } catch (error) {
      // 异常退出时把已合成未播的 objectURL 收掉，别在"没有声音"之上再叠内存泄漏
      for (const item of this.waiting) URL.revokeObjectURL(item.url);
      this.waiting = [];
      this.waitingChars = 0;
      this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      this.playing = 0;
      this.activeSynth = 0;
      this.streamAbort = null;
      this.running = false;
      // 无条件回落：stop() 已经发过一次 false，重复发是幂等的；而漏发
      // 会让界面一直停在"正在播报"
      this.callbacks.onSpeakingChange?.(false);
      // 补跑一轮：分派到 drainBuffered/drainStreaming 多加了一层 await，
      // 无块可消费时 finally 会晚一个 microtask 才执行。这期间到达的
      // enqueue/flush 被 `if (this.running) return` 挡住，新封的块就没
      // 人接手（表现为第二句之后再也不合成）。释放 running 后补一次即可。
      // 只看已封块 / 待排程：blockBuffer 是还没凑够字数的残句，本来就
      // 要等下一句，算进来会造成无进展的忙循环。
      if (!this.stopped && (this.blocks.length > 0 || this.waiting.length > 0)) void this.drain();
    }
  }

  /**
   * 整块路径：合成一块、排一块，领先 maxLead 块预取
   *
   * 这是接流式之前的稳定实现，保持原样。
   */
  private async drainBuffered(): Promise<void> {
    const inflight: InflightClip[] = [];
    // 整块路径也要能被 stop() 掐断：否则打断后当前这句仍占着 sidecar 的
    // 推理锁，后面几轮全在排队。stop() 会 abort 这个 controller。
    const abort = new AbortController();
    this.streamAbort = abort;
    // 合成**不能**依赖播放后端：后端 prepare() 一旦卡住（例如 AudioContext
    // 在无用户手势时 resume 永久 pending），把 resolvePlayer() 放在循环开头
    // 会让队列连一次 synth() 都发不出来，表现为"毫无声音、也不报错"。
    // 先按当前后端的领先量估算预取上限；随后若降级（maxLead 3→1），
    // 只是多预取一两块，不影响正确性。
    const bufferLimit = this.player.maxLead + 1;
    while (!this.stopped && (this.blocks.length > 0 || this.waiting.length > 0 || inflight.length > 0)) {
      // ① 合成：先落成音频，暂不排程
      while (!this.stopped && this.blocks.length > 0 && this.waiting.length < bufferLimit) {
        const text = this.blocks.shift() as string;
        let url: string;
        try {
          url = await this.synth(text, abort.signal);
        } catch (error) {
          // 主动打断不是故障：别把 AbortError 弹成「语音合成超时」
          if (this.stopped || abort.signal.aborted) break;
          this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
          continue;
        }
        if (this.stopped) {
          URL.revokeObjectURL(url);
          break;
        }
        this.waiting.push({ text, url, continuous: false });
        this.waitingChars += text.length;
      }
      if (this.stopped) break;

      // ② 开播门槛：攒够字数或流已结束才进时间轴。
      //    不到门槛就退出循环，等下一句 enqueue 再进来（已合成的不浪费）
      if (!this.startedPlaying) {
        if (this.waiting.length === 0) break;
        if (this.waitingChars < this.warmupChars && !this.endOfStream) break;
        this.startedPlaying = true;
      }

      // ③ 排程：到这一步才需要后端。最多 maxLead 块在飞，其余继续合成
      if (this.stopped) break;
      const player = await this.resolvePlayer();
      while (!this.stopped && this.waiting.length > 0 && inflight.length < player.maxLead) {
        const item = this.waiting.shift() as WaitingBlock;
        this.waitingChars -= item.text.length;
        let clip: ScheduledClip;
        try {
          clip = await player.schedule(item.url, this.gapFor(item.text));
        } catch (error) {
          this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
          continue;
        }
        this.scheduledCount += 1;
        this.playing += 1;
        this.callbacks.onSpeakingChange?.(true);
        inflight.push({ text: item.text, clip });
      }

      if (inflight.length === 0) {
        if (this.blocks.length === 0 && this.waiting.length === 0) break;
        continue;
      }
      // ④ 等最早排的那块播完再记账，后面的仍在时间轴上继续排
      const head = inflight.shift() as InflightClip;
      const outcome = await head.clip.done;
      this.playing = Math.max(0, this.playing - 1);
      this.settleClip(head.text, outcome);
    }
  }

  /**
   * 流式路径：生产者-消费者
   *
   * 与整块路径的区别只有一件——**合成任务不再被 await 卡在循环里**：
   * `streamSynth` 每吐出一块就 push 进 waiting 并 notify，消费侧只要在
   * 时间轴上还有空位就立刻排程。于是"点下去到第一个音"只等第一块生成，
   * 而不是等整段（实测 1.92s → 0.39s）。
   *
   * 顺序保证：同一时刻只跑一个块的流式合成，块按文本顺序启动；块内 chunk
   * 按到达顺序 push。所以时间轴顺序永远等于原文顺序。
   *
   * 诚实降级：流式请求失败或返回 0 块（服务端不支持、开关关闭），把该块
   * 文本转交整块 `synth()` 重试，**不报错、不哑**；只有整块也失败才回调错误。
   */
  private async drainStreaming(): Promise<void> {
    const streamSynth = this.streamSynth;
    if (streamSynth === null) return;
    const abort = new AbortController();
    this.streamAbort = abort;
    const gen = this.generation;
    const alive = (): boolean => !this.stopped && this.generation === gen;
    const inflight: InflightClip[] = [];
    /** 流式没走通、待整块重试的文本 */
    const fallback: string[] = [];
    // 流式块比整块小得多（实测 0.8s/块），领先窗口放宽一点才吃得下
    // 生成比播放快 4 倍带来的块洪峰；上限仍有限，避免一次排到几十秒之后。
    const bufferLimit = Math.max(8, this.player.maxLead * 3);

    /** 启动一个块的流式合成（后台跑，不阻塞消费循环） */
    const startBlock = (text: string): void => {
      this.activeSynth += 1;
      void streamSynth(
        text,
        (url, index) => {
          if (!alive()) {
            URL.revokeObjectURL(url);
            return;
          }
          this.waiting.push({ text: index === 0 ? text : "", url, continuous: true });
          if (index === 0) this.waitingChars += text.length;
          this.notify();
          // 消费循环可能已经退出（hasNoPendingWork 判定为真时 break）；
          // 这时到达的 chunk 只 notify 是没人接的，必须重新拉起 drain。
          void this.drain();
        },
        abort.signal
      ).then(
        (count) => {
          // 旧代的迟到回调不能减新代的计数：否则新一轮刚启动的块会被
          // 误判成「没有在飞任务」，hasNoPendingWork 提前为真，chunk 堆在
          // waiting 里无人排程。
          if (this.generation === gen) this.activeSynth = Math.max(0, this.activeSynth - 1);
          // 0 块 = 这条路本次不走（引擎不支持 / 用户关了开关）：静默回退整块
          if (alive() && count === 0) fallback.push(text);
          this.notify();
        },
        (error: unknown) => {
          if (this.generation === gen) this.activeSynth = Math.max(0, this.activeSynth - 1);
          if (alive() && !abort.signal.aborted) {
            const reason = error instanceof Error ? error.message : String(error);
            this.callbacks.onNotice?.(`流式合成不可用（${reason}），已回退整块合成`);
            fallback.push(text);
          }
          this.notify();
        }
      );
    };

    /** 整块兜底任务同样后台跑，不能把消费循环卡住 */
    const startFallback = (text: string): void => {
      this.activeSynth += 1;
      // 整块兜底同样要能被 stop() 掐断：否则打断后还会继续占着 sidecar 的
      // 推理锁，后面几轮全在排队（表现就是「越聊越迟钝」）。
      void this.synth(text, abort.signal).then(
        (url) => {
          if (this.generation === gen) this.activeSynth = Math.max(0, this.activeSynth - 1);
          if (!alive()) {
            URL.revokeObjectURL(url);
            return;
          }
          this.waiting.push({ text, url, continuous: false });
          this.waitingChars += text.length;
          this.notify();
        },
        (error: unknown) => {
          if (this.generation === gen) this.activeSynth = Math.max(0, this.activeSynth - 1);
          if (alive()) this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
          this.notify();
        }
      );
    };

    while (alive()) {
      // ① 先把流式失败的块转成整块请求（优先级高于新块，避免顺序错乱）
      while (fallback.length > 0 && this.waiting.length < bufferLimit) {
        startFallback(fallback.shift() as string);
      }

      // ② 启动下一个块的流式合成。一次只跑一个块：块间顺序才有保证。
      if (this.activeSynth === 0 && this.blocks.length > 0 && this.waiting.length < bufferLimit) {
        startBlock(this.blocks.shift() as string);
      }

      // ③ 开播门槛：首块的第一片音频到了就开播，不必等这一块全部生成完
      if (!this.startedPlaying) {
        if (this.waiting.length === 0 || (this.waitingChars < this.warmupChars && !this.endOfStream)) {
          // 门槛未到：等下一片音频 / 下一句 / flush
          if (this.hasNoPendingWork(inflight, fallback, this.blocks)) break;
          await this.waitForChange();
          this.cancelWake();
          continue;
        }
        this.startedPlaying = true;
      }

      // ④ 消费：能排多少排多少，连续块之间不留任何停顿
      if (this.waiting.length > 0 && inflight.length < this.player.maxLead) {
        const player = await this.resolvePlayer();
        while (alive() && this.waiting.length > 0 && inflight.length < player.maxLead) {
          const item = this.waiting.shift() as WaitingBlock;
          this.waitingChars -= item.text.length;
          let clip: ScheduledClip;
          try {
            clip = await player.schedule(item.url, item.continuous ? 0 : this.gapFor(item.text), {
              continuous: item.continuous,
            });
          } catch (error) {
            this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
            continue;
          }
          this.scheduledCount += 1;
          this.playing += 1;
          this.callbacks.onSpeakingChange?.(true);
          inflight.push({ text: item.text, clip });
        }
      }

      // ⑤ 收工判定：全都处理完才退出；流未结束时也要退出，等下一句 enqueue
      if (this.hasNoPendingWork(inflight, fallback, this.blocks)) break;

      // ⑥ 等待两种事件里先到的那个：最早那块播完，或队列有新进展。
      //    只等 clip.done 会在"生成比播放慢"时堵住新块的启动，只等 notify
      //    又会在"生成比播放快"时空转——必须 race。
      if (inflight.length > 0) {
        const head = inflight[0];
        // 用对象包一层：赋值发生在回调里，TS 的控制流分析容易把裸 let
        // 误判成"永远是 null"，包成属性就不会被收窄
        const state: { outcome: PlayOutcome | null } = { outcome: null };
        const tracked = head.clip.done.then((value) => {
          state.outcome = value;
          return value;
        });
        await Promise.race([tracked, this.waitForChange()]);
        this.cancelWake();
        if (state.outcome !== null) {
          inflight.shift();
          this.playing = Math.max(0, this.playing - 1);
          this.settleClip(head.text, state.outcome);
        }
      } else {
        await this.waitForChange();
        this.cancelWake();
      }
    }
  }

  /** 是否还有任何未处理的工作（收工判定） */
  private hasNoPendingWork(
    inflight: readonly InflightClip[],
    fallback: readonly string[],
    blocks: readonly string[]
  ): boolean {
    return (
      inflight.length === 0 &&
      fallback.length === 0 &&
      blocks.length === 0 &&
      this.waiting.length === 0 &&
      this.activeSynth === 0
    );
  }

  /** 唤醒正在等待队列变化的消费者 */
  private notify(): void {
    if (this.wake !== null) {
      const resolve = this.wake;
      this.wake = null;
      resolve();
    } else {
      this.wakePending = true;
    }
  }

  /** 等一次队列变化（chunk 到达 / 合成完成 / enqueue / flush / stop） */
  private async waitForChange(): Promise<void> {
    if (this.wakePending) {
      this.wakePending = false;
      return;
    }
    await new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  /** 取消挂起的等待（race 结束或 stop 时必须调，别留悬挂 promise） */
  private cancelWake(): void {
    if (this.wake !== null) {
      const resolve = this.wake;
      this.wake = null;
      resolve();
    }
    this.wakePending = false;
  }

  /**
   * 确认后端可用（必要时降级）
   *
   * `AudioContext` 在自动播报场景可能恢复不了（没有用户手势）。这时不能
   * 直接哑掉，要切到元素播放——换来的是有元素切换开销，但一定出声。
   *
   * @returns 可用的后端
   */
  private async resolvePlayer(): Promise<ClipPlayer> {
    // 每次排程前都重新 prepare：AudioContext 可能在长会话中途被系统挂起
    // （切后台、切输出设备、App Nap）。旧代码只在首次检查，之后仍把
    // source.start() 排到 suspended 的时间轴上——currentTime 不走、
    // onended 不来、声音也没有，界面却显示「正在播报」。prepare() 幂等，
    // running 状态下只是读一次 state，开销可忽略。
    try {
      await this.player.prepare();
    } catch (error) {
      if (!(error instanceof SinkUnavailableError) || this.usedFallback || this.fallbackFactory === null) {
        throw error;
      }
      this.usedFallback = true;
      this.callbacks.onNotice?.(`采样级播放不可用（${error.message}），已自动切回兼容播放`);
      this.player.dispose();
      this.player = this.fallbackFactory();
      await this.player.prepare();
    }
    return this.player;
  }

  /**
   * 算这块之前的停顿
   *
   * 首块不等——否则用户点一下要"先静 0.3 秒才开口"。
   *
   * @param text 块文本
   * @returns 毫秒
   */
  private gapFor(text: string): number {
    return gapBeforeMs(text, this.scheduledCount === 0);
  }

  /**
   * 一块收尾记账
   *
   * @param text 原文
   * @param outcome 结局
   */
  private settleClip(text: string, outcome: PlayOutcome): void {
    if (outcome === "ended") {
      if (!this.stopped) this.spoken.push(text);
      return;
    }
    if (outcome === "stalled") {
      // 明确告诉用户"这一块没播完"，而不是静默吞掉——否则用户只会觉得
      // 语音功能时好时坏
      this.callbacks.onError?.("语音播放中断（设备切换或音频解码异常），已跳过这一句");
    } else if (outcome === "error") {
      this.callbacks.onError?.("音频播放失败，已跳过这一句");
    }
    // aborted：被打断是正常路径，不报错
  }
}
