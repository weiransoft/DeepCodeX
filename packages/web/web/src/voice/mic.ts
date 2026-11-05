/**
 * 麦克风采集：说话（可自动收尾）+ 播报期打断监测
 *
 * ## 为什么用 MediaRecorder + decodeAudioData，而不是 AudioWorklet
 *
 * AudioWorklet 能拿到实时 PCM，但要写处理器文件、处理模块加载时序，
 * 对一个"按住说话"的场景是过度设计。MediaRecorder 录完整段后一次性
 * 解码成 PCM，代码量小一个数量级，延迟代价只有解码那几十毫秒。
 *
 * ## 打断阈值为什么是这几个数
 *
 * - **帧 50ms / RMS > 0.05**：正常说话在 0.1~0.3；键盘敲击通常是
 *   单个尖峰（1~2 帧），环境噪声在 0.02 以下。0.05 能落在空档里。
 * - **持续 300ms**：把"咳一声""碰一下桌子"过滤掉，只认人声。
 * - **播报期阈值 ×2**：扬声器外放会被麦克风拾到，不抬阈值就会"自己打断自己"。
 *
 * 这三个数都做成导出常量，测试与调参改一处即可。
 *
 * **打断监测的阈值仍是固定的**：它工作在"助手正在外放"这个特殊时段，麦克风
 * 听到的既有用户也有扬声器回声，噪声底估计会被回声污染。改成自适应反而可能
 * 让阈值在播报开头降到过低、自己打断自己，因此这里保持绝对值。代价是增益
 * 很低的麦克风难以用说话打断——这一项需要真机实测后再定，不靠推理改。
 *
 * 录音期的「说完判定」则走自适应阈值（见 `voice/noise-floor.ts`）：那个场景
 * 没有回声，只有环境噪声与麦克风增益两件事。
 *
 * ## 免按住：录音期静音收尾（对标 OpenClaw Talk Mode）
 *
 * `startRecording` 可以额外挂一个「说完判定」（见 `endpointing.ts`）：录音同时
 * 每 50ms 算一次 RMS，连续静音够久就回调 `onEndpoint`，由调用方走正常的
 * 停止+识别+发送路径。这样用户只需点一下开始，不用一直按着。
 *
 * 判定器与采集分开：这边只负责按帧喂 RMS，判「说没说完」在纯状态机里，
 * 可以脱开浏览器单测。
 *
 * ## 电平外报（`onLevel`）
 *
 * 录音期的 RMS 原本只喂给判定器，算完就丢——结果界面上"正在录音"只有一个
 * 静态的按钮变色，用户根本看不出麦克风有没有真的在收东西。现在同一帧的
 * RMS 会额外通过 `onLevel` 报出去，UI 用它画检测条。
 *
 * **电平与判定共用一个采样循环**：拆成两个 `AudioContext` 会对同一路音频
 * 建两条图、两个定时器，既费电又可能因为两次采样不同步让"条在动"和
 * "判定说静音"互相矛盾。一帧算一次、喂两处，从根上消除这种不一致。
 *
 * 只在 `onEndpoint` 存在时才起循环是不够的——按住说话模式没有判定器，
 * 但同样需要看见电平，所以起循环的条件是「两个回调有一个存在」。
 *
 * @module web/voice/mic
 */

import { Endpointer, type EndpointOptions, type EndpointVerdict } from "./endpointing";
import { NoiseFloorTracker } from "./noise-floor";

/** 分析帧长（毫秒） */
export const VAD_FRAME_MS = 50;

/** 基础 RMS 阈值（安静环境下人声） */
export const VAD_BASE_THRESHOLD = 0.05;

/** 播报期阈值倍数（外放回声抑制） */
export const VAD_PLAYBACK_FACTOR = 2;

/** 判定为"人声开始"需要持续的毫秒数 */
export const VAD_MIN_SPEECH_MS = 300;

/** 录音上限（毫秒）：防止用户按住不放生成超大文件 */
export const MAX_RECORD_MS = 60_000;

/**
 * 一帧电平原值回调
 *
 * 收到的是未平滑的瞬时 RMS，平滑与量化由 `voice/level.ts` 负责——
 * 采集层不该知道"UI 想要几档"。
 */
export type LevelHandler = (rms: number) => void;

/** 录音选项 */
export interface RecordingOptions {
  /** 说完判定回调（存在才会跑静音检测） */
  onEndpoint?: (verdict: EndpointVerdict) => void;
  /** 说完判定参数 */
  endpoint?: EndpointOptions;
  /** 每帧电平回调（存在才会跑采样循环；与判定共用同一循环） */
  onLevel?: LevelHandler;
}

/**
 * 麦克风错误的人类可读翻译
 *
 * `getUserMedia` 的异常名对用户毫无意义，必须翻译成"下一步做什么"。
 *
 * @param error 原始异常
 * @returns 可展示文案
 */
export function explainMicError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "麦克风权限被拒绝。桌面端需使用**打包版**（开发态 tauri dev 读不到 Info.plist 里的用途说明）；浏览器端请在地址栏左侧的权限里允许麦克风";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "没有找到麦克风设备";
  }
  if (name === "NotReadableError") {
    return "麦克风被其他应用占用（会议软件、录音工具）";
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 麦克风采集器
 */
export class MicCapture {
  /** 当前媒体流（录音与电平监测共用） */
  private stream: MediaStream | null = null;
  /** 录音器 */
  private recorder: MediaRecorder | null = null;
  /** 已收集的分片 */
  private chunks: BlobPart[] = [];
  /** 电平监测上下文 */
  private audioContext: AudioContext | null = null;
  /** 电平监测循环句柄 */
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  /** 录音期「电平 + 说完判定」的音频上下文（与打断监测分开，避免互相关闭） */
  private levelContext: AudioContext | null = null;
  /** 录音期电平/判定采样循环 */
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  /** 录音超时句柄 */
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 环境噪声底（跨轮持有）
   *
   * 放在采集器上而不是判定器里：判定器每次开录都新建，噪声底却是「这间
   * 屋子有多吵」这个慢变量的估计。每轮重建会让第二轮又从 0.004 开始，
   * 第一句永远按最低阈值判。见 `voice/noise-floor.ts`。
   */
  private readonly noiseFloor = new NoiseFloorTracker();

  /**
   * 打开麦克风（幂等）
   *
   * @returns 媒体流
   */
  async open(): Promise<MediaStream> {
    if (this.stream !== null && this.stream.active) return this.stream;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // 系统级 AEC 与降噪是免费的：按住说话本无回声，但噪声抑制能显著减少误判
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    return this.stream;
  }

  /**
   * 开始录音
   *
   * @param onMaxDuration 达到上限时的回调（自动停止）
   * @param options 说完判定 + 电平外报（两者都没给就不起采样循环）
   */
  async startRecording(onMaxDuration?: () => void, options: RecordingOptions = {}): Promise<void> {
    const stream = await this.open();
    this.chunks = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.start();
    this.recorder = recorder;
    this.maxTimer = setTimeout(() => onMaxDuration?.(), MAX_RECORD_MS);
    if (options.onEndpoint !== undefined || options.onLevel !== undefined) {
      this.watchLevels(stream, options);
    }
  }

  /**
   * 录音期电平采样（同时驱动说完判定）
   *
   * 一帧算一次 RMS，先报电平、再喂判定器。判定逻辑全在 `Endpointer` 里，
   * 这里只负责按帧送数，判「说完了」之后停掉自己的采样（`onEndpoint`
   * 之后调用方通常会立刻 stopRecording，提前停掉避免两个定时器同时读同一路音频）。
   *
   * @param stream 媒体流
   * @param options 电平回调与判定回调
   */
  private watchLevels(stream: MediaStream, options: RecordingOptions): void {
    this.stopLevelWatch();
    const context = new AudioContext();
    this.levelContext = context;
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    // 部分浏览器把新建的 AudioContext 置为 suspended，不 resume 会一直读 0
    void context.resume().catch(() => {});

    const buffer = new Float32Array(analyser.fftSize);
    const endpointer =
      options.onEndpoint === undefined ? null : new Endpointer({ ...options.endpoint, noiseFloor: this.noiseFloor });
    const frameMs = options.endpoint?.frameMs ?? VAD_FRAME_MS;

    this.levelTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
      const rms = Math.sqrt(sum / buffer.length);
      options.onLevel?.(rms);
      if (endpointer === null || options.onEndpoint === undefined) return;
      const verdict = endpointer.push(rms);
      if (verdict.done) {
        this.stopLevelWatch();
        options.onEndpoint(verdict);
      }
    }, frameMs);
  }

  /** 停掉录音期电平采样（幂等） */
  private stopLevelWatch(): void {
    if (this.levelTimer !== null) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    if (this.levelContext !== null) {
      void this.levelContext.close();
      this.levelContext = null;
    }
  }

  /**
   * 停止录音并解码为 WAV
   *
   * @returns WAV Blob（无有效音频时抛错）
   */
  async stopRecording(): Promise<Blob> {
    this.stopLevelWatch();
    const recorder = this.recorder;
    this.recorder = null;
    if (this.maxTimer !== null) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    if (recorder === null) throw new Error("尚未开始录音");

    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await stopped;

    const raw = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
    this.chunks = [];
    if (raw.size === 0) throw new Error("没有录到音频");

    const { encodeAudioBuffer } = await import("./wav");
    const context = new AudioContext();
    try {
      const audio = await context.decodeAudioData(await raw.arrayBuffer());
      return encodeAudioBuffer(audio);
    } finally {
      void context.close();
    }
  }

  /**
   * 开始人声监测（播报期打断用）
   *
   * @param onSpeech 判定为人声时回调（已满足持续时长）
   * @param options 参数（阈值倍数）
   * @returns 停止函数
   */
  async startMonitor(onSpeech: () => void, options: { playback?: boolean } = {}): Promise<() => void> {
    const stream = await this.open();
    const context = new AudioContext();
    this.audioContext = context;
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const threshold = VAD_BASE_THRESHOLD * (options.playback === false ? 1 : VAD_PLAYBACK_FACTOR);
    const buffer = new Float32Array(analyser.fftSize);
    /** 连续超阈值的累计毫秒 */
    let hot = 0;
    let fired = false;

    this.monitorTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
      const rms = Math.sqrt(sum / buffer.length);
      if (rms >= threshold) {
        hot += VAD_FRAME_MS;
        if (hot >= VAD_MIN_SPEECH_MS && !fired) {
          fired = true;
          onSpeech();
        }
      } else {
        // 掉下去就清零：要求"连续"而不是"累计"，否则偶尔的噪声会攒够时长
        hot = 0;
        fired = false;
      }
    }, VAD_FRAME_MS);

    return () => this.stopMonitor();
  }

  /** 停止人声监测 */
  stopMonitor(): void {
    if (this.monitorTimer !== null) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    if (this.audioContext !== null) {
      void this.audioContext.close();
      this.audioContext = null;
    }
  }

  /** 释放麦克风（页面卸载/关闭语音模式时调用） */
  release(): void {
    this.stopMonitor();
    this.stopLevelWatch();
    if (this.recorder !== null) {
      try {
        this.recorder.stop();
      } catch {
        // 已停止
      }
      this.recorder = null;
    }
    if (this.maxTimer !== null) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    if (this.stream !== null) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }
}
