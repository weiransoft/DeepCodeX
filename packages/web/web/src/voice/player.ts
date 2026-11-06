/**
 * 语音播报队列（句级流水 + 采样级拼接 + 可打断 + 停滞自愈）
 *
 * ## 设计要点
 *
 * 1. **合成串行、播放连续**——TTS 是算力密集型，并发合成会互相拖慢；
 *    但"合成完一句、等它播完、再合成下一句"会让句间暴露完整的一次合成时间。
 *    所以队列维持一条**领先流水线**：最多提前 `maxLead` 句完成合成 + 排程，
 *    再回头等最早的句子播完。
 * 2. **打断即清空**——`stop()` 要同时停音频、清队列、标记被截断、
 *    并让正在 await 的播放立刻结束。
 * 3. **失败不哑**——某句合成失败就跳过并回调错误，其余句继续；
 *    整条链路挂掉时把文本留在气泡里（文本永远是可靠的降级）。
 * 4. **停滞必须自愈**——`HTMLAudioElement` 有一类"僵尸"状态：音频不再出声，
 *    但 `ended` 与 `error` 都不触发，`playOne` 永久 await，外层 `running`
 *    标志再也回不来，之后每一次 `enqueue` 都被静默丢弃。
 *
 * ## 演进史（都是真机上量出来的）
 *
 * - **2026-11-05 僵尸播放**：`stop()` 里的 `pause()` 既不触发 `ended` 也不触发
 *   `error`，promise 永不 settle，队列永久卡死。修法是看门狗 + `settlePlay`，
 *   逻辑搬到了 `playout.ts` 的 `AudioElementClipPlayer`。
 * - **2026-11-06 句间空等**：`warmPrefetch()` 原先在 `playOne` **之后**调，
 *   那一刻当前句已经播完，下一句的合成才刚开始 → 每两句固定空等一次合成。
 *   改成播之前预取。
 * - **2026-11-06 句间卡顿（第二层）**：预取修好后仍有停顿，真机量出两个
 *   与合成无关的来源——TTS 每句自带 88ms 句首 + 47ms 句尾机械静音，以及
 *   每个 `Audio` 元素切换一次的媒体线程开销。解法是把音频搬进
 *   `AudioContext` 时间轴按采样点拼接（见 `playout.ts`），停顿改由标点决定。
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
  /** 开始播某句（UI 显示"正在说"） */
  onSpeakingChange?: (speaking: boolean) => void;
  /** 某句合成/播放失败（不中断后续） */
  onError?: (message: string) => void;
  /** 提示性消息（如后端降级）：不是故障，不该弹红色错误 */
  onNotice?: (message: string) => void;
  /** 被打断（用于截断记账） */
  onInterrupted?: (spokenText: string) => void;
}

/** 默认停滞上限：5 秒没有任何 currentTime 推进，就不可能还在正常播放 */
const DEFAULT_STALL_LIMIT_MS = 5000;

/** 默认检查间隔 */
const DEFAULT_STALL_CHECK_MS = 1000;

/** 默认启动超时 */
const DEFAULT_PLAY_START_TIMEOUT_MS = 10_000;

/** 流水线里的一句 */
interface InflightClip {
  /** 原文（记账用） */
  text: string;
  /** 排程句柄 */
  clip: ScheduledClip;
}

/**
 * 句级播报队列
 */
export class SpeechQueue {
  /** 待合成的句子 */
  private readonly pending: string[] = [];
  /** 已播出的句子（用于截断记账） */
  private spoken: string[] = [];
  /** 是否正在跑循环 */
  private running = false;
  /** 终止标记（stop 后丢弃在飞结果） */
  private stopped = false;
  /** 已预取的下一句（文本 + 合成 Promise） */
  private prefetch: { text: string; url: Promise<string> } | null = null;
  /** 本轮已排程的句数（用来判断"首句不等待"） */
  private scheduledCount = 0;
  /** 已排程但还没播完的句数（`speaking` 用） */
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
  }

  /**
   * 追加一句话（会立刻开始播，若当前空闲）
   *
   * @param text 句子
   */
  enqueue(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.stopped = false;
    this.pending.push(trimmed);
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
    this.pending.length = 0;
    this.prefetch = null;
    this.player.stop();
    this.playing = 0;
    this.scheduledCount = 0;
    this.callbacks.onSpeakingChange?.(false);
    if (this.spoken.length > 0) {
      this.callbacks.onInterrupted?.(this.spoken.join(""));
      this.spoken = [];
    }
  }

  /** 是否正在播 */
  get speaking(): boolean {
    return this.playing > 0 || this.pending.length > 0;
  }

  /** 释放后端资源（页面卸载时调用） */
  dispose(): void {
    this.stop();
    this.player.dispose();
  }

  /**
   * 队列消费循环（同一时刻只允许一个实例在跑）
   *
   * 单句合成失败只跳过该句——整条队列不能因为一句话合不出来就全停，
   * 那会让用户以为语音功能"失灵"。
   */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const inflight: InflightClip[] = [];
    try {
      const player = await this.resolvePlayer();
      while (!this.stopped && (this.pending.length > 0 || inflight.length > 0)) {
        // ① 填满流水线：合成第 N+1 句时，第 N 句已经在播
        while (!this.stopped && this.pending.length > 0 && inflight.length < player.maxLead) {
          const text = this.pending.shift() as string;
          let url: string;
          try {
            url = await this.takeUrl(text);
          } catch {
            // 已在 takeUrl 里回调过 onError，这里继续下一句
            this.prefetch = null;
            this.warmPrefetch();
            continue;
          }
          if (this.stopped) break;
          this.warmPrefetch();
          let clip: ScheduledClip;
          try {
            clip = await player.schedule(url, this.gapFor(text));
          } catch (error) {
            this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
            this.prefetch = null;
            this.warmPrefetch();
            continue;
          }
          this.scheduledCount += 1;
          this.playing += 1;
          this.callbacks.onSpeakingChange?.(true);
          inflight.push({ text, clip });
        }
        if (inflight.length === 0) break;
        // ② 等最早排的那句播完再记账，后面的仍在时间轴上继续排
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
   * 算这句之前的停顿
   *
   * 首句不等——否则用户点一下要"先静 0.3 秒才开口"。
   *
   * @param text 句子
   * @returns 毫秒
   */
  private gapFor(text: string): number {
    return gapBeforeMs(text, this.scheduledCount === 0);
  }

  /**
   * 取当前句的音频地址（命中预取则复用）
   *
   * @param text 句子
   * @returns objectURL
   */
  private async takeUrl(text: string): Promise<string> {
    if (this.prefetch !== null && this.prefetch.text === text) {
      const url = await this.prefetch.url;
      this.prefetch = null;
      this.warmPrefetch();
      return url;
    }
    try {
      return await this.synth(text);
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * 预取下一句（失败静默：真正播到时再报）
   */
  private warmPrefetch(): void {
    if (this.prefetch !== null || this.pending.length === 0 || this.stopped) return;
    const next = this.pending[0];
    const url = this.synth(next);
    // 预取失败不应变成未处理拒绝
    url.catch(() => undefined);
    this.prefetch = { text: next, url };
  }

  /**
   * 一句收尾记账
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
      // 明确告诉用户"这一句没播完"，而不是静默吞掉——否则用户只会觉得
      // 语音功能时好时坏
      this.callbacks.onError?.("语音播放中断（设备切换或音频解码异常），已跳过这一句");
    } else if (outcome === "error") {
      this.callbacks.onError?.("音频播放失败，已跳过这一句");
    }
    // aborted：被打断是正常路径，不报错
  }
}
