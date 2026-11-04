/**
 * PCM16 WAV 编码（浏览器侧）
 *
 * ## 为什么在前端编码成 WAV
 *
 * `MediaRecorder` 给的是 webm/opus，而 Whisper 侧要的是 PCM。两条路：
 * 一是在 sidecar 里装 ffmpeg 解码，二是浏览器用 `decodeAudioData` 直接
 * 拿到 Float32 PCM 再打包成 WAV。后者零额外依赖、零外部进程，代价是
 * 上传体积大一些（48k 单声道 PCM16 ≈ 5.5MB/分钟）。
 *
 * 回环链路上体积不是瓶颈，**少一个外部依赖**才是更值钱的事。
 *
 * ## 为什么不在这里重采样到 16k
 *
 * 自写重采样要处理抗混叠滤波，是易错的 DSP。交给 sidecar 的
 * librosa/whisper 处理——它们已经做了很多年。
 *
 * @module web/voice/wav
 */

/** WAV 头长度（44 字节标准 RIFF 头） */
const HEADER_SIZE = 44;

/**
 * 把多声道 Float32 混成单声道
 *
 * @param channels 各声道样本
 * @param frameCount 帧数
 * @returns 单声道样本
 */
function mixdown(channels: Float32Array[], frameCount: number): Float32Array {
  if (channels.length === 1) return channels[0];
  const mono = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    mono[i] = sum / channels.length;
  }
  return mono;
}

/**
 * 编码为 PCM16 WAV
 *
 * @param samples 单声道样本（-1~1）
 * @param sampleRate 采样率
 * @returns WAV Blob（`audio/wav`）
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(HEADER_SIZE + samples.length * 2);
  const view = new DataView(buffer);

  /** 写 ASCII（RIFF/WAVE 标记） */
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率 = 采样率 × 块对齐
  view.setUint16(32, 2, true); // 块对齐 = 声道数 × 位深/8
  view.setUint16(34, 16, true); // 位深
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  // Float32 → Int16：先夹到 [-1,1]，负半轴用 0x8000 保证 -1 映射到 -32768
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(HEADER_SIZE + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * 把 `AudioBuffer` 编码成单声道 PCM16 WAV
 *
 * @param audio 解码后的音频
 * @returns WAV Blob
 */
export function encodeAudioBuffer(audio: AudioBuffer): Blob {
  const channels: Float32Array[] = [];
  for (let i = 0; i < audio.numberOfChannels; i += 1) channels.push(audio.getChannelData(i));
  return encodeWav(mixdown(channels, audio.length), audio.sampleRate);
}

/**
 * 估算 WAV 时长（毫秒）
 *
 * @param bytes WAV 字节数
 * @param sampleRate 采样率
 * @returns 毫秒；非法头返回 0
 */
export function wavDurationMs(bytes: number, sampleRate: number): number {
  const dataBytes = bytes - HEADER_SIZE;
  if (dataBytes <= 0 || sampleRate <= 0) return 0;
  return Math.round((dataBytes / 2 / sampleRate) * 1000);
}
