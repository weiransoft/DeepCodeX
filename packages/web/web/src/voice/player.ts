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
export type SynthFn = (text: string) => Promise<string>;

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
 * 后续块小得多。24 字约 6 秒音频、合成 1.1 秒——比原来的 28 字切句阈值
 * 还小一点，换取的是一段完整语义（不会在半句中间断）。
 */
export const FIRST_BLOCK_CHARS = 24;

/**
 * 后续块目标字数
 *
 * TTS 对一段文本是一次自回归：文本越长，句内的语调起伏越自然。把 72 字
 * 合成一次，等于让模型自己决定这 72 字里逗号处该停多久——这正是原来
 * "每 28 字断一次、每次都重新起头"丢掉的东西。
 */
export const BLOCK_CHARS = 72;

/** 单块字数硬上限：再长会让打断粒度变粗、合成排队变长 */
export const MAX_BLOCK_CHARS = 160;

/** 默认停滞上限：5 秒没有任何 currentTime 推进，就不可能还在正常播放 */
const DEFAULT_STALL_LIMIT_MS = 5000;

/** 默认检查间隔 */
const DEFAULT_STALL_CHECK_MS = 1000;

/** 默认启动超时 */
const DEFAULT_PLAY_START_TIMEOUT_MS = 10_000;

/** 流水线里的一块 */
interface InflightClip {
  /** 原文（记账用） */
  text: string;
  /** 排程句柄 */
  clip: ScheduledClip;
}

/** 已合成、待排程的块 */
interface WaitingBlock {
  /** 原文 */
  text: string;
  /** objectURL */
  url: string;
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
 * 块级播报队列
 */
export class SpeechQueue {
  /** 正在攒的句子 */
  private blockBuffer: string[] = [];
  /** 正在攒的字数 */
  private blockChars = 0;
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
  /** 后端是否已通过 prepare 检查 */
  private playerReady = false;
  /** 是否已经降级过（只降一次，避免来回抖） */
  private usedFallback = false;
  /** 回调 */
  private readonly callbacks: SpeechQueueCallbacks;
  /** 合成函数 */
  private readonly synth: SynthFn;
  /** 降级后端工厂 */
  private readonly fallbackFactory: (() => ClipPlayer) | null;
  /** 首块目标字数 */
  private readonly firstBlockChars: number;
  /** 后续块目标字数 */
  private readonly blockCharsTarget: number;
  /** 单块硬上限 */
  private readonly maxBlockChars: number;
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
    this.blockBuffer = [];
    this.blockChars = 0;
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
    return this.playing > 0 || this.blocks.length > 0 || this.waiting.length > 0 || this.blockBuffer.length > 0;
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
    if (text.trim().length === 0) return;
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
    const inflight: InflightClip[] = [];
    try {
      const player = await this.resolvePlayer();
      // 已合成未播的块上限：多留一块，让"下一块"永远在播完前就绪
      const bufferLimit = player.maxLead + 1;
      while (!this.stopped && (this.blocks.length > 0 || this.waiting.length > 0 || inflight.length > 0)) {
        // ① 合成：先落成音频，暂不排程
        while (!this.stopped && this.blocks.length > 0 && this.waiting.length < bufferLimit) {
          const text = this.blocks.shift() as string;
          let url: string;
          try {
            url = await this.synth(text);
          } catch (error) {
            this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
            continue;
          }
          if (this.stopped) {
            URL.revokeObjectURL(url);
            break;
          }
          this.waiting.push({ text, url });
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

        // ③ 排程：最多 maxLead 块在飞，其余继续合成
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
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      this.playing = 0;
      this.running = false;
      // 无条件回落：stop() 已经发过一次 false，重复发是幂等的；而漏发
      // 会让界面一直停在"正在播报"
      this.callbacks.onSpeakingChange?.(false);
    }
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
    if (this.playerReady) return this.player;
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
    this.playerReady = true;
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
