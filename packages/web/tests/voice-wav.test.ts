/**
 * WAV 编码单测（web/voice/wav）
 *
 * 这段代码只有 100 行，但错了就是「上传了但 Whisper 说没有音频」——
 * 一个字节序写反，整个语音链路静默失效。所以这里直接读回二进制断言，
 * 而不是只看「返回了 Blob」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWav, wavDurationMs } from "../web/src/voice/wav";

/**
 * 读回 ArrayBuffer 的工具
 *
 * @param blob 待读 Blob
 * @returns 字节视图
 */
async function readBytes(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

/**
 * 读 ASCII 片段
 *
 * @param view 字节视图
 * @param offset 起点
 * @param length 长度
 * @returns 字符串
 */
function ascii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

test("W1 RIFF/WAVE/fmt/data 四个标记必须就位", async () => {
  const blob = encodeWav(new Float32Array(100), 16000);
  const view = await readBytes(blob);
  assert.equal(ascii(view, 0, 4), "RIFF");
  assert.equal(ascii(view, 8, 4), "WAVE");
  assert.equal(ascii(view, 12, 4), "fmt ");
  assert.equal(ascii(view, 36, 4), "data");
  assert.equal(blob.type, "audio/wav");
});

test("W2 头字段与采样率/声道/位深一致", async () => {
  const sampleRate = 24000;
  const blob = encodeWav(new Float32Array(480), sampleRate);
  const view = await readBytes(blob);

  assert.equal(view.getUint32(16, true), 16, "fmt 块长度");
  assert.equal(view.getUint16(20, true), 1, "编码格式必须是 PCM");
  assert.equal(view.getUint16(22, true), 1, "必须单声道");
  assert.equal(view.getUint32(24, true), sampleRate);
  assert.equal(view.getUint32(28, true), sampleRate * 2, "字节率 = 采样率×块对齐");
  assert.equal(view.getUint16(32, true), 2, "块对齐 = 1 声道 × 16bit/8");
  assert.equal(view.getUint16(34, true), 16, "位深");
});

test("W3 两处长度字段必须自洽（RIFF 总长与 data 段长）", async () => {
  const frames = 1234;
  const blob = encodeWav(new Float32Array(frames), 16000);
  const view = await readBytes(blob);
  assert.equal(view.getUint32(40, true), frames * 2, "data 段字节数");
  assert.equal(view.getUint32(4, true), 36 + frames * 2, "RIFF 长度 = 头余量 + data");
  assert.equal(blob.size, 44 + frames * 2, "总字节数 = 44 头 + PCM");
});

test("W4 采样值映射：端点不溢出，静音严格为 0", async () => {
  const samples = new Float32Array([0, 1, -1, 0.5, -0.5, 2, -2]);
  const view = await readBytes(encodeWav(samples, 16000));
  const at = (index: number): number => view.getInt16(44 + index * 2, true);

  assert.equal(at(0), 0, "0 必须编成 0");
  assert.equal(at(1), 32767, "1.0 映射到正满幅 32767");
  assert.equal(at(2), -32768, "-1.0 映射到负满幅 -32768（不是 -32767）");
  // 超范围要夹住，而不是回绕成噪音
  assert.equal(at(5), 32767, "大于 1 的值必须夹到正满幅");
  assert.equal(at(6), -32768, "小于 -1 的值必须夹到负满幅");
  // 0.5 应落在半幅附近（允许 ±1 的取整误差）
  assert.ok(Math.abs(at(3) - 16384) <= 1, "0.5 应接近半幅");
});

test("W5 时长换算与编码器对齐（往返一致）", async () => {
  const sampleRate = 16000;
  const seconds = 1.5;
  const frames = Math.round(sampleRate * seconds);
  const blob = encodeWav(new Float32Array(frames), sampleRate);
  assert.equal(wavDurationMs(blob.size, sampleRate), 1500, "1.5 秒应还原成 1500ms");
});

test("W6 非法输入不崩：空样本与非法采样率", async () => {
  const empty = encodeWav(new Float32Array(0), 16000);
  assert.equal(empty.size, 44, "空音频只剩头");
  assert.equal(wavDurationMs(44, 16000), 0, "没有数据段时时长为 0");
  assert.equal(wavDurationMs(0, 16000), 0);
  assert.equal(wavDurationMs(1000, 0), 0, "采样率非法返回 0 而不是 Infinity");
});
