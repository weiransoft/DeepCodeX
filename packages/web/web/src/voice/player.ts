/**
 * 语音播报队列（句级流水 + 可打断）
 *
 * ## 设计要点
 *
 * 1. **串行合成、预取一句**——TTS 是算力密集型，并发合成会互相拖慢，
 *    反而拉高首字延迟；但完全串行又会让第二句的等待暴露给用户。
 *    折中是"当前句在播时，预取下一句"。
 * 2. **打断即清空**——`stop()` 要同时做三件事：停音频、清队列、标记被截断。
 *    只停音频不清队列的话，下一句会接着播，用户会以为它"没听话"。
 * 3. **失败不哑**——某句合成失败就跳过并回调错误，其余句继续；
 *    整条链路挂掉时把文本留在气泡里（文本永远是可靠的降级）。
 *
 * @module web/voice/player
 */

/** 合成函数：文本 → objectURL（由调用方负责回收） */
export type SynthFn = (text: string) => Promise<string>;

/** 播报队列回调 */
export interface SpeechQueueCallbacks {
  /** 开始播某句（UI 显示"正在说"） */
  onSpeakingChange?: (speaking: boolean) => void;
  /** 某句合成/播放失败（不中断后续） */
  onError?: (message: string) => void;
  /** 被打断（用于截断记账） */
  onInterrupted?: (spokenText: string) => void;
}

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
  /** 回调 */
  private readonly callbacks: SpeechQueueCallbacks;
  /** 合成函数 */
  private readonly synth: SynthFn;

  /**
   * 构造
   *
   * @param synth 合成函数
   * @param callbacks 回调
   */
  constructor(synth: SynthFn, callbacks: SpeechQueueCallbacks = {}) {
    this.synth = synth;
    this.callbacks = callbacks;
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
   */
  stop(): void {
    this.stopped = true;
    this.pending.length = 0;
    this.prefetch = null;
    if (this.audio !== null) {
      this.audio.pause();
      this.audio.src = "";
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
        await this.playOne(text, url);
      }
    } finally {
      this.running = false;
      if (!this.stopped) this.callbacks.onSpeakingChange?.(false);
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
   * @param text 句子
   * @param url objectURL
   */
  private async playOne(text: string, url: string): Promise<void> {
    try {
      this.callbacks.onSpeakingChange?.(true);
      const audio = new Audio(url);
      this.audio = audio;
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("音频播放失败"));
        void audio.play().catch(reject);
      });
      if (!this.stopped) this.spoken.push(text);
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      this.audio = null;
      URL.revokeObjectURL(url);
      this.warmPrefetch();
    }
  }
}
