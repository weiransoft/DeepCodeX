/**
 * 结构感知分块（P0）跨语言一致性 + 开关契约测试
 *
 * 原子区间判定在 Python（`scripts/voice/atomic_chunks.py`）与 TS
 * （`web/src/voice/atomic.ts`）各有一份实现：Python 供门禁探针复刻前端，
 * TS 是生产链路。两份一旦漂移，门禁测的就不是真实行为。本测试用同一份
 * `scripts/voice/atomic-parity-fixtures.json` 逐案比对纯函数输出。
 *
 * 同时锁住「默认关」契约：不传 `atomicChunk` 时，`splitLongText` /
 * `rebalanceShortBlock` / `takeSentences` 必须与 031f1cc2 完全一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicSpans, cutOk, charInside, nearestOkCut, atomEndAfter } from "../web/src/voice/atomic";
import { splitLongText, rebalanceShortBlock, speechUnits, SpeechQueue } from "../web/src/voice/player";
import type { ClipPlayer, PlayOutcome, ScheduledClip } from "../web/src/voice/playout";
import { takeSentences, SentenceStream } from "../web/src/voice/sentence";
import { ATOMIC_CHUNK_KEY, readAtomicChunk, writeAtomicChunk } from "../web/src/voice/preference";

interface ParityCase {
  readonly name: string;
  readonly text: string;
  readonly spans: readonly [number, number][];
  readonly splitOff: readonly string[];
  readonly splitOn: readonly string[];
}
interface RebalanceCase {
  readonly prev: string;
  readonly short: string;
  readonly off: readonly string[];
  readonly on: readonly string[];
}
interface Fixtures {
  readonly version: string;
  readonly limit: number;
  readonly minUnits: number;
  readonly cases: readonly ParityCase[];
  readonly rebalance: readonly RebalanceCase[];
}

const candidates = [
  // runner 的 cwd = packages/web/tests
  path.resolve(process.cwd(), "../../../scripts/voice/atomic-parity-fixtures.json"),
  // 从仓库根单独跑 node --test 时
  path.resolve(process.cwd(), "scripts/voice/atomic-parity-fixtures.json"),
  // 从 packages/web 单独跑时
  path.resolve(process.cwd(), "../../scripts/voice/atomic-parity-fixtures.json"),
];
const fixturePath = candidates.find((p) => existsSync(p));
assert.ok(fixturePath, `找不到 parity fixture，候选：${candidates.join(" / ")}`);
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixtures;
const { limit, minUnits } = fixtures;

test("parity fixture 自身完整", () => {
  assert.equal(fixtures.version, "atomic-parity-v1");
  assert.equal(limit, 48);
  assert.equal(minUnits, 10);
  assert.ok(fixtures.cases.length >= 6);
  assert.ok(fixtures.rebalance.length >= 3);
});

for (const c of fixtures.cases) {
  test(`原子区间 parity: ${c.name}`, () => {
    const got = atomicSpans(c.text).map((s) => [s.start, s.end]);
    assert.deepEqual(
      got,
      c.spans.map(([a, b]) => [a, b])
    );
  });

  test(`切分 parity（关闭 / 开启）: ${c.name}`, () => {
    assert.deepEqual(splitLongText(c.text, limit, minUnits, false), [...c.splitOff]);
    assert.deepEqual(splitLongText(c.text, limit, minUnits, true), [...c.splitOn]);
    // 默认不传开关 = 关闭态，逐字等于历史基线
    assert.deepEqual(splitLongText(c.text, limit, minUnits), [...c.splitOff]);
    assert.equal(c.splitOn.join(""), c.text.trim(), "开启态必须逐字可逆");
    assert.equal(c.splitOff.join(""), c.text.trim(), "关闭态必须逐字可逆");
  });
}

for (const [i, r] of fixtures.rebalance.entries()) {
  test(`尾段重划 parity #${i}（关闭 / 开启）`, () => {
    assert.deepEqual(rebalanceShortBlock(r.prev, r.short, minUnits, limit, false), [...r.off]);
    assert.deepEqual(rebalanceShortBlock(r.prev, r.short, minUnits, limit, true), [...r.on]);
    assert.deepEqual(rebalanceShortBlock(r.prev, r.short, minUnits, limit), [...r.off]);
    assert.equal(r.off.join(""), r.prev + r.short);
    assert.equal(r.on.join(""), r.prev + r.short);
  });
}

test("原子边界工具：切点、回扫、原子尾", () => {
  const text = "见 https://127.0.0.1:8791/tts/stream 的说明。";
  const spans = atomicSpans(text);
  assert.equal(spans.length, 1);
  const { start, end } = spans[0];
  assert.ok(text.slice(start, end).startsWith("https://"));
  assert.ok(charInside(spans, start + 5));
  assert.ok(!charInside(spans, end));
  assert.ok(!cutOk(spans, start + 5));
  assert.ok(cutOk(spans, start));
  assert.ok(cutOk(spans, end));
  assert.equal(nearestOkCut(spans, start + 5, 0), start);
  assert.equal(atomEndAfter(spans, start + 5, 200), end);
  assert.equal(atomEndAfter(spans, start + 5, start + 6), -1);
});

test("切句：结构内部的逗号 / 冒号不再触发断句", () => {
  // 前缀必须把弱断句阈值（28 字）撑满，否则 JSON 内的逗号在关闭态本来
  // 也不会触发断句，就测不出结构保护的差异。
  const text =
    "这一段前缀专门用来把弱断句阈值二十八字符撑满，请求体是 {text, engine, voice, speed}，" +
    "别漏。返回 {ok: true, model: {asr, tts}}，超时 3000ms。";
  const off = takeSentences(text, 0, true, 28, false);
  const on = takeSentences(text, 0, true, 28, true);
  // 关闭态会在 JSON 内的逗号处断句；开启态必须把完整结构留在同一句里。
  // 句子**数量不一定变**（结构外的句号仍会断），所以断言内容而不是计数。
  assert.ok(
    off.sentences.some((s) => s.includes("{text,") && !s.includes("speed}")),
    `关闭态必须在 JSON 内部逗号处断句：${JSON.stringify(off.sentences)}`
  );
  assert.equal(
    on.sentences.some((s) => s.includes("{text, engine, voice, speed}")),
    true
  );
  // 关闭态在 `{text,` 后断句，下一段被 stripForSpeech 的 trim 吃掉一个前导
  // 空格（既有行为，不是 atomic 引入）；所以按「去空白后逐字相等」判不吞字。
  const strip = (s: string): string => s.replace(/\s+/gu, "");
  assert.equal(strip(on.sentences.join("")), strip(off.sentences.join("")), "两态都不吞字");
  assert.equal(off.consumed, text.length);
  assert.equal(on.consumed, text.length);
  // 默认不传开关 = 关闭态
  assert.deepEqual(takeSentences(text, 0, true, 28).sentences, off.sentences);
});

test("SentenceStream：构造开关透传，且逐字可逆", () => {
  const text = "先看 {text: hello, engine: qwen3} 这段配置，再说后面的内容。";
  const off = new SentenceStream(false).flush(text);
  const on = new SentenceStream(true).flush(text);
  assert.equal(on.join("").length >= off.join("").length, true);
  assert.equal(new SentenceStream().flush(text).join(""), off.join(""), "默认构造必须等同关闭态");
  // 未闭合结构保护到末尾：不断句，flush 时整段一次性吐出
  const unclosed = "配置是 {text: hello, engine: qwen3 还没写完";
  assert.equal(new SentenceStream(true).flush(unclosed).length, 1);
});

test("偏好开关：默认关，写入后可读，非法值回落", () => {
  const store = new Map<string, string>();
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
  });
  try {
    assert.equal(readAtomicChunk(), false, "默认必须关");
    writeAtomicChunk(true);
    assert.equal(store.get(ATOMIC_CHUNK_KEY), "1");
    assert.equal(readAtomicChunk(), true);
    writeAtomicChunk(false);
    assert.equal(readAtomicChunk(), false);
    store.set(ATOMIC_CHUNK_KEY, "garbage");
    assert.equal(readAtomicChunk(), false);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original });
  }
});

/** 立即播完的假后端：只为让合成请求跑完，不测播放时间轴 */
const instantPlayer: ClipPlayer = {
  maxLead: 3,
  prepare: () => Promise.resolve(),
  schedule: (_url: string, _gap: number): Promise<ScheduledClip> =>
    Promise.resolve({ done: Promise.resolve<PlayOutcome>("ended") }),
  stop: () => undefined,
  dispose: () => undefined,
};

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 走真实 SpeechQueue（含 pushBlock / absorbShortIntoLast），收集合成请求文本 */
async function collectBlocks(text: string, atomicChunk?: boolean): Promise<string[]> {
  const texts: string[] = [];
  const deps =
    atomicChunk === undefined
      ? { player: instantPlayer, warmupChars: 0 }
      : { player: instantPlayer, warmupChars: 0, atomicChunk };
  const queue = new SpeechQueue(
    (t) => {
      texts.push(t);
      return Promise.resolve(`blob:${texts.length}`);
    },
    {},
    deps
  );
  queue.enqueue(text);
  queue.flush();
  await waitFor(() => texts.length >= 2);
  return texts;
}

test("SpeechQueue：atomicChunk 依赖确实透传到真实封块链路", async () => {
  const c = fixtures.cases.find((x) => x.name === "code_short_json");
  assert.ok(c);
  const off = await collectBlocks(c.text, false);
  const on = await collectBlocks(c.text, true);
  const defaulted = await collectBlocks(c.text);
  assert.deepEqual(defaulted, off, "不传开关 = 关闭态，必须与旧版逐字一致");
  assert.equal(off.join("").replace(/\s+/gu, ""), on.join("").replace(/\s+/gu, ""), "两态都不吞字");
  assert.notDeepEqual(off, on, "开关必须改变真实封块结果（deps 未透传就会完全相同）");
  // pushBlock 对每块做 .trim()（既有行为），按去空白后逐字比对纯函数结果。
  const strip = (s: string): string => s.replace(/\s+/gu, "");
  assert.deepEqual(off.map(strip), c.splitOff.map(strip), "关闭态队列封块 = 基线 splitLongText");
  assert.deepEqual(on.map(strip), c.splitOn.map(strip), "开启态队列封块 = atomic splitLongText");
  assert.ok(
    on.some((b) => b.includes("{text, engine, voice, speed}")),
    `开启态必须把完整 JSON 留在同一请求：${JSON.stringify(on)}`
  );
});

test("speechUnits 与服务端同规则（等效发音单元）", () => {
  assert.equal(speechUnits(""), 0);
  assert.equal(speechUnits("中文"), 2);
  assert.ok(speechUnits("abc") > 0 && speechUnits("abc") < 2);
  assert.ok(speechUnits("123") > speechUnits("1"));
  assert.equal(speechUnits("，。："), 0);
});
