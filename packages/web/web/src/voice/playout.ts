/**
 * 播报的音频后端：Web Audio 采样级排程 + 静音裁剪
 *
 * ## 为什么还需要这一层（2026-11-06）
 *
 * 前一轮把预取挪到 `playOne` 之前后，"合成跟不上"的等待已经消失（实测
 * RTF≈0.19，一句 3.5s 音频只要 0.6s 合成）。但用户仍反馈"前一句后一句
 * 中间卡顿"。真机量出来的原因是两件与合成无关的事：
 *
 * 1. **TTS 每句自带机械静音**：实测句首 88ms、句尾 46~49ms（24kHz 单声道
 *    Qwen3-TTS）。这不是语义停顿，是模型输出的 padding；三句连播就多出
 *    约 400ms 的"空转"。
 * 2. **每个 `HTMLAudioElement` 换一次就是一次解码器重建**。`pause()` +
 *    换 `src` + `play()` 的开销在几十毫秒量级，且它在媒体线程上，不受
 *    主线程控制——无法与其他句的尾巴重叠。
 *
 * 这两件事都只能靠"把音频搬进 AudioContext 时间轴"解决：一次解码成
 * `AudioBuffer`，用 `start(when, offset, duration)` 把它排到**上一句结束的
 * 采样点上**。句间不再有元素切换，静音可以精确裁到只剩语义停顿。
 *
 * 这也是主流语音助手的做法（流式 TTS 之外的"gapless scheduling"）：句级
 * 音频在客户端拼成一根连续时间轴，停顿由标点决定而不是由模型 padding 决定。
 *
 * ## 为什么保留 HTMLAudioElement 后端
 *
 * `AudioContext` 在自动播报场景可能被浏览器挂起（没有用户手势），`resume()`
 * 也可能被拒。这一层不能"要么全好要么全哑"：Web Audio 不可用时降级回
 * 元素播放，行为等价于上一版（有元素切换开销，但一定出声）。降级由
 * `SpeechQueue` 在 `prepare()` 失败时切换，见 `player.ts`。
 *
 * @module web/voice/playout
 */

/** 一句播完的结局 */
export type PlayOutcome = "ended" | "error" | "stalled" | "aborted";

/** 一次排程的句柄 */
export interface ScheduledClip {
  /** 播完/失败的承诺（一定 settle，见各实现） */
  readonly done: Promise<PlayOutcome>;
}

/**
 * 排程选项
 *
 * 流式分块和整句音频是**两种不同性质的音频**，不能套同一套处理：
 * - 整句：模型在首尾加了机械 padding，需要裁掉、补 60ms 尾音、按标点加停顿；
 * - 流式块：同一段音频被按时间切开，块内静音是模型本来生成的语义停顿，
 *   块边界本来就是连续的，裁了反而会吞字、加停顿会听出一串吞吐。
 *
 * `continuous: true` 就是「按采样点直接接在前一块后面」：不裁、不加 gap、
 * 不补尾音。实测 41 字 / speed 1.2 时 11 块合计 8.399s ≈ 整块 8.333s，
 * 边界样本跳变中位数仅 2.8% 峰值，直接相接与整块等价。
 */
export interface ScheduleOptions {
  /** 是否作为流式连续块排程（默认 false = 整句音频） */
  readonly continuous?: boolean;
}

/**
 * 播报后端
 *
 * `speechQueue` 只依赖这个接口，不关心是 AudioBuffer 还是元素。
 */
export interface ClipPlayer {
  /**
   * 允许领先排程几句
   *
   * Web Audio 可以提前把后面几句排进时间轴（3 句足够覆盖合成抖动），
   * 元素播放做不到——它只能老老实实一句一句来，所以是 1。
   */
  readonly maxLead: number;

  /**
   * 检查后端是否可用（幂等）
   *
   * 抛 `SinkUnavailableError` 表示这一路不可用，调用方应切换后端。
   */
  prepare(): Promise<void>;

  /**
   * 排程一句
   *
   * **url 的所有权转移给后端**：实现方负责 `URL.revokeObjectURL`。
   *
   * @param url 音频 objectURL
   * @param gapBeforeMs 这句之前要留的停顿（毫秒）；`continuous` 时忽略
   * @param options 排程选项（流式连续块见 `ScheduleOptions`）
   */
  schedule(url: string, gapBeforeMs: number, options?: ScheduleOptions): Promise<ScheduledClip>;

  /** 立刻停掉所有正在播/已排程的音频 */
  stop(): void;

  /** 释放资源 */
  dispose(): void;
}

/** 后端不可用（需降级） */
export class SinkUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SinkUnavailableError";
  }
}

/** 判定"有声"的峰值比例（约 -34dB） */
export const SILENCE_PEAK_RATIO = 0.02;

/**
 * 尾部保留的静音（毫秒）
 *
 * 实测 TTS 句尾本来只有 46~49ms，全裁掉会听出"被掐断"；留 60ms 略多于原值，
 * 手感上是自然收尾而不是硬切。
 */
export const TAIL_KEEP_MS = 60;

/**
 * 句末停顿（毫秒）
 *
 * 与保留下来的 60ms 尾音合计约 140ms，**刻意对齐实测量到的现状**
 * （前句尾 47ms + 后句首 88ms ≈ 135ms）。这一层不是"让停顿变短"，而是把
 * 原来由模型 padding + 元素切换凑出来的、抖动量几十毫秒的空档，换成确定值。
 */
export const GAP_SENTENCE_MS = 80;

/** 逗号级停顿：句内模型已自带停顿，只补一点 */
export const GAP_CLAUSE_MS = 20;

/** 无明显标点时（前端可能按长度硬切）的停顿 */
export const GAP_PLAIN_MS = 40;

/** 首句之前的停顿（不该等，否则一开口先哑 0.3 秒） */
export const GAP_FIRST_MS = 0;

/** Web Audio 领先排程句数 */
export const WEB_AUDIO_MAX_LEAD = 3;

/**
 * 等待 `AudioContext.resume()` 的上限（毫秒）
 *
 * 自动播报没有用户手势时，WebKit/Chromium 的 `resume()` **可能既不 resolve
 * 也不 reject，永久 pending**（不是"被拒绝"，注释里以前写错了）。没有超时
 * 的话 `prepare()` 永不返回，`SpeechQueue.drain()` 会卡在第一步，连一次
 * TTS 请求都发不出来——表现就是"完全没有声音、也不报错"。
 * 超时后按"这一路不可用"降级到元素播放，宁可损失无缝也要出声。
 */
export const RESUME_TIMEOUT_MS = 1200;

/**
 * 一块音频 fetch + decodeAudioData 的上限（毫秒）
 *
 * `decodeAudioData` 在设备切换 / 坏 WAV / 上下文挂起时可能**永不 settle 也不
 * 抛错**。SpeechQueue 的 `running` 互斥会把之后所有 enqueue 静默丢弃，
 * 于是「前面几句正常、之后彻底不说话」。这里给解码加硬超时，让上层能
 * 捕获错误、跳过这一块并继续跑队列。
 */
export const DECODE_TIMEOUT_MS = 5000;

/** 给一个 promise 加超时；超时后底层任务仍可能继续，由调用方接住其失败 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** 排程到"现在"的最小提前量（秒）：给 ctx 一点调度余量，避免 start 落在过去 */
const MIN_START_LEAD_S = 0.02;

/** onended 迟迟不来时的兜底余量（毫秒） */
const ENDED_GUARD_MS = 1500;

/**
 * 找出一段 PCM 里有声的区间
 *
 * 用相对峰值的阈值而不是绝对 dB：TTS 音量整体偏小或偏大都不影响判定。
 * 全静音返回 `{start: 0, end: 0}`，由调用方决定怎么处理。
 *
 * @param samples 单声道样本
 * @param ratio 判定阈值（相对峰值）
 * @returns 有声区间 `[start, end)`
 */
export function findSpeechBounds(
  samples: Float32Array,
  ratio: number = SILENCE_PEAK_RATIO
): { start: number; end: number } {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  if (peak === 0) return { start: 0, end: 0 };
  const threshold = peak * ratio;
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) < threshold) start += 1;
  let end = samples.length;
  while (end > start && Math.abs(samples[end - 1]) < threshold) end -= 1;
  return { start, end };
}

/**
 * 按句末标点算这句之前的停顿
 *
 * 只认最后一个非空白、非引号收尾字符。引号/括号要跳过，否则
 * 「他说："好。"」会判成标点不对的普通句。
 *
 * @param text 句子
 * @param isFirst 是否是本轮第一句
 * @returns 停顿毫秒
 */
export function gapBeforeMs(text: string, isFirst: boolean): number {
  if (isFirst) return GAP_FIRST_MS;
  const trimmed = text.trim().replace(/[”’」』）)】》"'）]+$/u, "");
  const last = trimmed.slice(-1);
  if (last === "") return GAP_PLAIN_MS;
  if ("。！？!?".includes(last)) return GAP_SENTENCE_MS;
  if ("，、；：,;:".includes(last)) return GAP_CLAUSE_MS;
  if ("…—~～".includes(last)) return GAP_CLAUSE_MS + 60;
  return GAP_PLAIN_MS;
}

/** AudioContext 构造器类型 */
type AudioContextCtor = new () => AudioContext;

/**
 * 找出可用的 AudioContext 构造器（含 Safari 前缀）
 *
 * @returns 构造器；环境不支持返回 null
 */
function resolveAudioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * Web Audio 后端：解码一次、裁掉机械静音、按采样点排到时间轴上
 */
export class WebAudioClipPlayer implements ClipPlayer {
  readonly maxLead = WEB_AUDIO_MAX_LEAD;

  private ctx: AudioContext | null = null;
  /** 时间轴游标（秒）：上一句结束的时刻 */
  private cursor = 0;
  /** 已排程但未播完的 source */
  private readonly active = new Set<AudioBufferSourceNode>();
  /** stop() 代数：用来把被打断的 onended 判成 aborted 而不是 ended */
  private generation = 0;

  /**
   * @param createContext 上下文工厂（测试注入；默认按环境自动创建）
   * @param resumeTimeoutMs 等待 resume 的上限（测试可设很小的值）
   * @param decodeTimeoutMs 等待一块音频解码的上限（测试可设很小的值）
   */
  constructor(
    private readonly createContext?: () => AudioContext,
    private readonly resumeTimeoutMs: number = RESUME_TIMEOUT_MS,
    private readonly decodeTimeoutMs: number = DECODE_TIMEOUT_MS
  ) {}

  /**
   * 给 `resume()` 套一层超时
   *
   * 不能简单用 Promise.race 就完事：resume 晚到时还要忽略它的结果，
   * 否则降级后一个迟来的 resolve 会把状态搅乱。
   *
   * @param ctx 已挂起的上下文
   * @returns resume 完成；超时抛 SinkUnavailableError
   */
  private resumeWithTimeout(ctx: AudioContext): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        fn();
      };
      timer = setTimeout(() => {
        finish(() =>
          reject(
            new SinkUnavailableError(
              `AudioContext.resume() ${this.resumeTimeoutMs}ms 内未返回（多半缺少用户手势），切回兼容播放`
            )
          )
        );
      }, this.resumeTimeoutMs);
      try {
        void ctx.resume().then(
          () => finish(resolve),
          (error: unknown) => finish(() => reject(error))
        );
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  /**
   * 建上下文并确认它真的在跑
   *
   * `resume()` 在没有用户手势时可能被拒绝，**也可能永久挂起**；两种情况
   * 都要在有限时间内给出结论，让调用方降级。
   */
  async prepare(): Promise<void> {
    if (this.ctx === null) {
      try {
        if (this.createContext !== undefined) {
          this.ctx = this.createContext();
        } else {
          const Ctor = resolveAudioContextCtor();
          if (Ctor === null) throw new SinkUnavailableError("当前环境不支持 Web Audio");
          this.ctx = new Ctor();
        }
      } catch (error) {
        if (error instanceof SinkUnavailableError) throw error;
        throw new SinkUnavailableError(
          `AudioContext 创建失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const ctx = this.ctx;
    if (ctx.state === "closed") throw new SinkUnavailableError("AudioContext 已关闭");
    if (ctx.state === "suspended") {
      try {
        await this.resumeWithTimeout(ctx);
      } catch (error) {
        if (error instanceof SinkUnavailableError) throw error;
        throw new SinkUnavailableError(
          `AudioContext 无法恢复（可能缺少用户手势）：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (ctx.state !== "running") throw new SinkUnavailableError(`AudioContext 状态异常：${ctx.state}`);
  }

  /**
   * 排程一句
   *
   * @param url 音频 objectURL（本方法负责回收）
   * @param gapBeforeMs 句前停顿（连续块忽略）
   * @param options 连续块不裁静音、不加停顿、不补尾音
   * @returns 句柄
   */
  async schedule(url: string, gapBeforeMs: number, options?: ScheduleOptions): Promise<ScheduledClip> {
    const ctx = this.ctx;
    if (ctx === null) throw new SinkUnavailableError("AudioContext 未初始化");
    const continuous = options?.continuous === true;

    let buffer: AudioBuffer;
    try {
      const decode = (async (): Promise<AudioBuffer> => {
        const response = await fetch(url);
        const data = await response.arrayBuffer();
        return await ctx.decodeAudioData(data);
      })();
      // 超时后底层任务仍在跑：接住它的失败，别变成未处理的 rejection
      void decode.catch(() => undefined);
      buffer = await withTimeout(decode, this.decodeTimeoutMs, "音频解码");
    } finally {
      // 解码后原始字节就没用了，先放掉再算时间轴
      URL.revokeObjectURL(url);
    }

    const sampleRate = buffer.sampleRate;
    let offset = 0;
    let duration = buffer.duration;
    if (continuous) {
      // 流式块首尾是同一条波形的切点：块内的"静音"是模型生成的语义停顿，
      // 用 findSpeechBounds 裁会把停顿和字一起吞掉；尾音也不能补，否则
      // 11 块就多出 660ms 空转。直接整块接在 cursor 上。
      if (duration <= 0) throw new Error("流式音频块为空，已跳过");
    } else {
      const samples = buffer.getChannelData(0);
      const bounds = findSpeechBounds(samples);
      if (bounds.end <= bounds.start) throw new Error("语音音频里没有人声，已跳过");
      offset = bounds.start / sampleRate;
      const keepTail = TAIL_KEEP_MS / 1000;
      duration = Math.min(buffer.duration - offset, (bounds.end - bounds.start) / sampleRate + keepTail);
    }

    const generation = this.generation;
    const now = ctx.currentTime;
    // cursor 落后于 now（合成或解码拖慢了）时不能把当次排到过去，
    // 否则 start 会被钳到"立刻"，缝隙就暴露出来——只能从 now 起算
    const base = Math.max(now + MIN_START_LEAD_S, this.cursor);
    const when = base + (continuous ? 0 : gapBeforeMs / 1000);
    const endAt = when + duration;
    this.cursor = endAt;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(when, offset, duration);
    this.active.add(source);

    const done = new Promise<PlayOutcome>((resolve) => {
      let settled = false;
      let guard: ReturnType<typeof setTimeout> | null = null;
      const settle = (outcome: PlayOutcome): void => {
        if (settled) return;
        settled = true;
        if (guard !== null) clearTimeout(guard);
        this.active.delete(source);
        try {
          source.disconnect();
        } catch {
          // 已断开或上下文已关闭，忽略
        }
        resolve(outcome);
      };
      // 兜底：切输出设备时 onended 可能永远不来，不能让队列挂在 await 上
      guard = setTimeout(() => settle("stalled"), Math.max(0, (endAt - ctx.currentTime) * 1000) + ENDED_GUARD_MS);
      source.onended = () => settle(this.generation === generation ? "ended" : "aborted");
    });

    return { done };
  }

  /** 停掉所有排程并把时间轴清零 */
  stop(): void {
    this.generation += 1;
    for (const source of this.active) {
      try {
        source.stop();
      } catch {
        // 还没 start 或已经结束
      }
    }
    this.active.clear();
    this.cursor = 0;
  }

  /** 关闭上下文 */
  dispose(): void {
    this.stop();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx !== null && ctx.state !== "closed") void ctx.close().catch(() => undefined);
  }
}

/**
 * HTMLAudioElement 后端（兜底）
 *
 * 行为与 2026-11-05 那一版的 `playOne` 完全一致，包括僵尸状态看门狗——
 * 那套逻辑救过"只播几秒就没声"的线上问题，不能因为换了默认后端就丢掉。
 */
export class AudioElementClipPlayer implements ClipPlayer {
  /** 元素播放无法提前排程，只能一句一句来 */
  readonly maxLead = 1;

  private audio: HTMLAudioElement | null = null;
  /** 当前这句的终止器（`stop()` 靠它叫醒等待） */
  private settlePlay: (() => void) | null = null;

  /**
   * @param createAudio 元素工厂（测试注入）
   * @param stallLimitMs 停滞上限
   * @param stallCheckIntervalMs 停滞检查间隔
   * @param playStartTimeoutMs 启动超时
   * @param now 时钟
   */
  constructor(
    private readonly createAudio: (url: string) => HTMLAudioElement = (url) => new Audio(url),
    private readonly stallLimitMs = 5000,
    private readonly stallCheckIntervalMs = 1000,
    private readonly playStartTimeoutMs = 10_000,
    private readonly now: () => number = () => performance.now()
  ) {}

  /** 元素播放总能试一下：真正的失败在 play() 时暴露 */
  prepare(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 播一句
   *
   * 四种收尾都必须让 promise settle，否则整个队列会永久卡住。
   *
   * @param url 音频 objectURL（本方法负责回收）
   * @param _gapBeforeMs 忽略：元素播放无法精确控制停顿
   * @param _options 忽略：降级后端做不到采样级拼接，逐块播仍保证出声
   * @returns 句柄
   */
  schedule(url: string, _gapBeforeMs: number, _options?: ScheduleOptions): Promise<ScheduledClip> {
    const audio = this.createAudio(url);
    this.audio = audio;

    const done = new Promise<PlayOutcome>((resolve) => {
      let settled = false;
      let started = false;
      let lastProgressAt = this.now();
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

    // 句柄必须**立刻**返回：调用方还要接着合成下一句，不能在这里等到播完
    // （元素后端的 maxLead 是 1，外层会马上 await `done`，行为与逐句播放等价）
    const clip: ScheduledClip = {
      done: done.then((outcome) => {
        audio.pause();
        try {
          audio.removeAttribute("src");
        } catch {
          // 老浏览器/测试桩可能没有 removeAttribute，忽略
        }
        if (this.audio === audio) this.audio = null;
        if (this.settlePlay !== null) this.settlePlay = null;
        URL.revokeObjectURL(url);
        return outcome;
      }),
    };
    return Promise.resolve(clip);
  }

  /** 打断当前句 */
  stop(): void {
    const settle = this.settlePlay;
    this.settlePlay = null;
    settle?.();
    if (this.audio !== null) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio = null;
    }
  }

  /** 无额外资源 */
  dispose(): void {
    this.stop();
  }
}

/**
 * 按环境选默认后端
 *
 * 顺带在页面装上"一次手势解锁"：浏览器要求 `AudioContext.resume()` 发生在
 * 用户手势里，而语音播报常常是模型自动回复触发的（那一刻没有手势）。
 * 尽早挂监听把它解锁掉，免得第一句自动播报时才 resume 被拒、白降一次级。
 *
 * @returns 有 AudioContext 就上 Web Audio，否则元素播放
 */
export function createDefaultPlayer(): ClipPlayer {
  if (resolveAudioContextCtor() === null) return new AudioElementClipPlayer();
  const player = new WebAudioClipPlayer();
  const scope = globalThis as unknown as {
    addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void;
  };
  if (typeof scope.addEventListener === "function") {
    const unlock = (): void => {
      void player.prepare().catch(() => undefined);
    };
    // 两种手势都挂：桌面端点一下、键盘敲一下都算
    scope.addEventListener("pointerdown", unlock, { once: true });
    scope.addEventListener("keydown", unlock, { once: true });
  }
  return player;
}

/** 兜底后端工厂（Web Audio 不可用时由队列切换过去） */
export function createFallbackPlayer(): ClipPlayer {
  return new AudioElementClipPlayer();
}
