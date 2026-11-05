/**
 * 语音播报队列（句级流水 + 可打断 + 停滞自愈）
 *
 * ## 设计要点
 *
 * 1. **串行合成、预取一句**——TTS 是算力密集型，并发合成会互相拖慢，
 *    反而拉高首字延迟；但完全串行又会让第二句的等待暴露给用户。
 *    折中是"当前句在播时，预取下一句"。
 * 2. **打断即清空**——`stop()` 要同时做四件事：停音频、清队列、标记被截断、
 *    **让正在 await 的播放立刻结束**。最后一条曾经漏掉，见下。
 * 3. **失败不哑**——某句合成失败就跳过并回调错误，其余句继续；
 *    整条链路挂掉时把文本留在气泡里（文本永远是可靠的降级）。
 * 4. **停滞必须自愈**——`HTMLAudioElement` 有一类"僵尸"状态：音频不再出声，
 *    但 `ended` 与 `error` 都不触发。一旦 `playOne` 永久 await，外层
 *    `running` 标志就再也回不来，后续每一次 `enqueue` 都被静默丢弃。
 *    表现就是"只播了前面几秒，之后彻底没声，但界面一直显示在播"。
 *
 * ## 为什么需要看门狗（2026-11-05 修复）
 *
 * 原先的 `playOne` 只等 `onended`，`stop()` 里只做 `pause()` + `src = ""`。
 * 但 `pause()` **既不触发 `ended` 也不触发 `error`**，所以：
 *
 * ```
 * 播报中用户开口 → barge-in 调 stop() → 元素被 pause
 *   → playOne 的 promise 永不 settle
 *   → drain 的 running 永久为 true
 *   → 之后每一句 enqueue 都在 `if (this.running) return` 处被丢掉
 * ```
 *
 * 同一类现象还有别的触发源：切换输出设备/插拔耳机/蓝牙断开、解码到一半
 * 数据异常、浏览器把后台标签页的音频挂起。它们的共同点是**不报错也不结束**。
 *
 * 修法是两条独立保险：
 * - 播放中每 `stallCheckIntervalMs` 检查一次 `currentTime`，超过
 *   `stallLimitMs` 没有任何推进就判定停滞，主动收尾并继续下一句；
 * - `stop()` 通过 `settlePlay` 直接打断当前等待，不再依赖媒体事件。
 *
 * @module web/voice/player
 */

/** 合成函数：文本 → objectURL（由调用方负责回收） */
export type SynthFn = (text: string) => Promise<string>;

/** 播放器可注入的依赖（测试用；生产走默认值） */
export interface SpeechQueueDeps {
  /**
   * 音频元素工厂
   *
   * 抽成依赖是为了能在 node 里测播报队列：`new Audio()` 在无 DOM 环境不存在。
   *
   * @param url objectURL
   * @returns 音频元素
   */
  createAudio?: (url: string) => HTMLAudioElement;
  /** 多久没有任何播放进展就判定停滞（默认 5000ms） */
  stallLimitMs?: number;
  /** 停滞检查间隔（默认 1000ms） */
  stallCheckIntervalMs?: number;
  /** `play()` 启动超时（默认 10000ms；autoplay 被拒时 promise 可能长期 pending） */
  playStartTimeoutMs?: number;
  /** 时钟（测试可注入，默认 performance.now） */
  now?: () => number;
}

/** 一句播完的原因 */
type PlayOutcome =
  /** 正常播完 */
  | "ended"
  /** 媒体元素报错 */
  | "error"
  /** 停滞（无进展超时） */
  | "stalled"
  /** 被 stop() 打断 */
  | "aborted";

/** 播报队列回调 */
export interface SpeechQueueCallbacks {
  /** 开始播某句（UI 显示"正在说"） */
  onSpeakingChange?: (speaking: boolean) => void;
  /** 某句合成/播放失败（不中断后续） */
  onError?: (message: string) => void;
  /** 被打断（用于截断记账） */
  onInterrupted?: (spokenText: string) => void;
}

/** 默认停滞上限：5 秒没有任何 currentTime 推进，就不可能还在正常播放 */
const DEFAULT_STALL_LIMIT_MS = 5000;

/** 默认检查间隔 */
const DEFAULT_STALL_CHECK_MS = 1000;

/** 默认启动超时 */
const DEFAULT_PLAY_START_TIMEOUT_MS = 10_000;

/**
 * 句级播报队列
 */
export class SpeechQueue {
  /** 待合成的句子 */
  private readonly pending: string[] = [];
  /** 已播出的句子（用于截断记账） */
  private spoken: string[] = [];
  /** 当前音频 */
  private audio: HTMLAudioElement | null = null;
  /** 是否正在跑循环 */
  private running = false;
  /** 终止标记（stop 后丢弃在飞结果） */
  private stopped = false;
  /** 已预取的下一句（文本 + 合成 Promise） */
  private prefetch: { text: string; url: Promise<string> } | null = null;
  /**
   * 当前这句的终止器
   *
   * `stop()` 靠它把 `playOne` 从 await 里叫醒——不能指望媒体事件，
   * `pause()` 不触发 ended/error。
   */
  private settlePlay: (() => void) | null = null;
  /** 回调 */
  private readonly callbacks: SpeechQueueCallbacks;
  /** 合成函数 */
  private readonly synth: SynthFn;
  /** 音频工厂 */
  private readonly createAudio: (url: string) => HTMLAudioElement;
  /** 停滞上限 */
  private readonly stallLimitMs: number;
  /** 停滞检查间隔 */
  private readonly stallCheckIntervalMs: number;
  /** 启动超时 */
  private readonly playStartTimeoutMs: number;
  /** 时钟 */
  private readonly now: () => number;

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
    this.createAudio = deps.createAudio ?? ((url: string) => new Audio(url));
    this.stallLimitMs = deps.stallLimitMs ?? DEFAULT_STALL_LIMIT_MS;
    this.stallCheckIntervalMs = deps.stallCheckIntervalMs ?? DEFAULT_STALL_CHECK_MS;
    this.playStartTimeoutMs = deps.playStartTimeoutMs ?? DEFAULT_PLAY_START_TIMEOUT_MS;
    this.now = deps.now ?? (() => performance.now());
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
   * 顺序有讲究：先叫醒 `playOne`（否则它会在 await 里挂到超时），再停元素。
   */
  stop(): void {
    this.stopped = true;
    this.pending.length = 0;
    this.prefetch = null;
    // 先让正在 await 的播放结束，避免它持有 audio 引用继续往下走
    const settle = this.settlePlay;
    this.settlePlay = null;
    settle?.();
    if (this.audio !== null) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio = null;
    }
    this.callbacks.onSpeakingChange?.(false);
    if (this.spoken.length > 0) {
      this.callbacks.onInterrupted?.(this.spoken.join(""));
      this.spoken = [];
    }
  }

  /** 是否正在播 */
  get speaking(): boolean {
    return this.audio !== null || this.pending.length > 0;
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
    try {
      while (this.pending.length > 0 && !this.stopped) {
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
        if (this.stopped) {
          URL.revokeObjectURL(url);
          break;
        }
        // 关键：**播之前**就把下一句送去合成，让合成与播放并行。
        //
        // 原先只在 `playOne` 末尾调 `warmPrefetch()`，那一刻当前句已经播完，
        // 下一句的合成才刚开始。于是每两句之间固定空等一次完整合成时间
        // （实测 RTF≈0.19，一句 3.5s 音频要 0.5~0.9s 合成），听感就是
        // 「前一句说完了，停一下，后一句才出来」。
        //
        // 合成比播放快 5 倍，只要在播放期间就把下一句合成好，句间就没有等待。
        this.warmPrefetch();
        await this.playOne(text, url);
      }
    } finally {
      this.running = false;
      // 无条件回落：stop() 已经发过一次 false，重复发是幂等的；而漏发
      // 会让界面一直停在"正在播报"（这正是本轮要修的 bug 之一）
      this.callbacks.onSpeakingChange?.(false);
    }
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
   * 播一句
   *
   * 四种收尾都必须让 promise settle，否则整个队列会永久卡住。
   *
   * @param text 句子
   * @param url objectURL
   */
  private async playOne(text: string, url: string): Promise<void> {
    this.callbacks.onSpeakingChange?.(true);
    const audio = this.createAudio(url);
    this.audio = audio;

    const outcome = await new Promise<PlayOutcome>((resolve) => {
      let settled = false;
      let started = false;
      /** 最近一次观测到 currentTime 变化的时刻 */
      let lastProgressAt = this.now();
      /** 最近一次观测到的 currentTime */
      let lastTime = -1;
      let watchdog: ReturnType<typeof setInterval> | null = null;
      let startTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = (): void => {
        if (watchdog !== null) clearInterval(watchdog);
        if (startTimer !== null) clearTimeout(startTimer);
        audio.onended = null;
        audio.onerror = null;
        audio.ontimeupdate = null;
        if (this.settlePlay === abort) this.settlePlay = null;
      };

      const settle = (reason: PlayOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(reason);
      };

      /** stop() 用它打断：不依赖任何媒体事件 */
      const abort = (): void => settle("aborted");
      this.settlePlay = abort;

      audio.onended = () => settle("ended");
      audio.onerror = () => settle("error");
      audio.ontimeupdate = () => {
        lastTime = audio.currentTime;
        lastProgressAt = this.now();
      };

      // 启动超时：autoplay 被拒时 play() 的 promise 可能长期 pending，
      // 不设超时就会一直显示"正在播报"却一点声音都没有
      startTimer = setTimeout(() => {
        if (!started) settle("stalled");
      }, this.playStartTimeoutMs);

      void audio.play().then(
        () => {
          started = true;
          lastProgressAt = this.now();
          if (startTimer !== null) {
            clearTimeout(startTimer);
            startTimer = null;
          }
        },
        () => settle("error")
      );

      // 停滞看门狗：currentTime 不推进就是"僵尸播放"——没声音、也没结束事件
      watchdog = setInterval(() => {
        if (settled) return;
        if (audio.ended) {
          settle("ended");
          return;
        }
        const current = audio.currentTime;
        if (current !== lastTime) {
          lastTime = current;
          lastProgressAt = this.now();
          return;
        }
        if (this.now() - lastProgressAt >= this.stallLimitMs) settle("stalled");
      }, this.stallCheckIntervalMs);
    });

    // 收尾：不管哪种结局都要停元素、放 URL、清引用
    audio.pause();
    try {
      audio.removeAttribute("src");
    } catch {
      // 老浏览器/测试桩可能没有 removeAttribute，忽略
    }
    if (this.audio === audio) this.audio = null;
    if (this.settlePlay !== null) this.settlePlay = null;
    URL.revokeObjectURL(url);

    if (outcome === "ended") {
      if (!this.stopped) this.spoken.push(text);
    } else if (outcome === "stalled") {
      // 明确告诉用户"这一句没播完"，而不是静默吞掉——否则用户只会觉得
      // 语音功能时好时坏
      this.callbacks.onError?.("语音播放中断（设备切换或音频解码异常），已跳过这一句");
    } else if (outcome === "error") {
      this.callbacks.onError?.("音频播放失败，已跳过这一句");
    }
    // aborted：被打断是正常路径，不报错

    this.warmPrefetch();
  }
}
