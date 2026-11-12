/**
 * 稳态分块（第十四轮，2026-11-11）
 *
 * 用户反馈「第一、第二差异比较大，第二、第三差异不大，后面都差不多」。
 * `scripts/voice/timbre_probe.py` 真机逐块音色指纹证实：最大两个相邻跳变
 * 正好是 19 字首块（8.597dB）与 18 字尾块（6.997dB），中间 31~45 字块
 * 两两只有 1.5~5.2dB；同文本重复生成 / 换请求位置逐位相同，排除随机漂移。
 *
 * 这里的契约有三条，缺一不可：
 *  1. 默认**关**——`SpeechQueue` 既有分块契约（031f1cc2）不许被悄悄改掉；
 *     新行为由生产装配 `useVoiceTalk` 显式注入。
 *  2. 打开后首块抬到 32 字、尾块与前块重划，且**拼接逐字守恒**。
 *  3. 设备偏好**默认关**（A/B 不足以支撑改默认），写 "1" 才灰度开启。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STEADY_FIRST_BLOCK_CHARS,
  STEADY_MIN_TAIL_CHARS,
  SpeechQueue,
  resplitSteadyPair,
} from "../web/src/voice/player";
import { STEADY_BLOCKS_KEY, readSteadyBlocks, writeSteadyBlocks } from "../web/src/voice/preference";
import type { ClipPlayer, PlayOutcome, ScheduledClip } from "../web/src/voice/playout";

class InstantPlayer implements ClipPlayer {
  readonly maxLead = 3;

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  schedule(): Promise<ScheduledClip> {
    return Promise.resolve({ done: Promise.resolve<PlayOutcome>("ended") });
  }

  stop(): void {
    // 无状态
  }

  dispose(): void {
    // 无资源
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const SENTENCES = [
  "今天天气不错。",
  "我们出去走走吧。",
  "顺便买点东西回来。",
  "晚上一起做饭吃。",
  "再把桌子收拾一下。",
  "最后看会儿书。",
  "明天还要早起。",
  "所以别熬太晚。",
  "记得把窗户关好。",
  "灯也顺手关了吧。",
];
const FULL = SENTENCES.join("");

/** 跑一遍队列，返回合成函数实际收到的文本块 */
async function collect(deps: Record<string, unknown>): Promise<string[]> {
  const texts: string[] = [];
  const states: boolean[] = [];
  const queue = new SpeechQueue(
    async (text: string) => {
      texts.push(text);
      return `blob:${texts.length}`;
    },
    { onSpeakingChange: (v: boolean) => states.push(v) },
    { player: new InstantPlayer(), ...deps }
  );
  for (const sentence of SENTENCES) queue.enqueue(sentence);
  queue.flush();
  await waitFor(() => states.at(-1) === false && texts.length > 0);
  return texts;
}

test("S1 resplitSteadyPair：拼接逐字守恒，两块都够长", () => {
  const prev = "前面是一段足够长的文字，用来模拟倒数第二块的内容。";
  const short = "尾巴很短。";
  const pair = resplitSteadyPair(prev, short, STEADY_MIN_TAIL_CHARS, 48);
  assert.ok(pair, "应当能找到合法切点");
  assert.equal(pair.join(""), prev + short, "不许吞字、不许重复");
  for (const part of pair) {
    assert.ok(part.length >= STEADY_MIN_TAIL_CHARS || pair.length === 1, `碎片仍有 ${part.length} 字`);
    assert.ok(part.length <= 48 || pair.length === 1, "单块不得超过硬上限");
  }
});

test("S2 resplitSteadyPair：合法区间里有标点时优先落在标点后", () => {
  // minChars 取 10 放宽候选区间，确保 lo..hi 内确实存在标点切点
  const prev = "第一句，第二句，第三句，第四句，第五句，第六句，第七句，第八句。";
  const short = "第九句，第十句，第十一句，第十二句。";
  const pair = resplitSteadyPair(prev, short, 10, 48);
  assert.ok(pair);
  assert.equal(pair.join(""), prev + short);
  if (pair.length === 2) {
    assert.ok(/[。！？；;，,、：:]/u.test(pair[0].at(-1) ?? ""), "应优先在标点后切");
  }
});

test("S3 resplitSteadyPair：合起来不超上限就合成一块", () => {
  assert.deepEqual(resplitSteadyPair("前面十字左右。", "尾巴。", 30, 48), ["前面十字左右。尾巴。"]);
});

test("S4 resplitSteadyPair：撑不起两块时返回 null（诚实降级，不硬切）", () => {
  // 两块合起来 100 字，limit=48 时最多切出 48+52，右块必然超上限
  const prev = "甲".repeat(50);
  const short = "乙".repeat(50);
  assert.equal(resplitSteadyPair(prev, short, 30, 48), null);
});

test("S5 偏好：默认关，显式 1 才开启，localStorage 不可用仍默认关", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  };
  Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true, writable: true });
  try {
    assert.equal(readSteadyBlocks(), false, "默认必须关（A/B 不足以改默认）");
    writeSteadyBlocks(true);
    assert.equal(store.get(STEADY_BLOCKS_KEY), "1");
    assert.equal(readSteadyBlocks(), true, "写 1 才灰度开启");
    writeSteadyBlocks(false);
    assert.equal(readSteadyBlocks(), false, "写 0 应回退到 v13 行为");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
  // 无 localStorage（隐私模式）时 fail-closed 回退到 v13
  assert.equal(readSteadyBlocks(), false);
});

test("S6 默认关：不传 steadyBlocks 与显式 false 逐字一致", async () => {
  const off = await collect({});
  const explicit = await collect({ steadyBlocks: false });
  assert.deepEqual(explicit, off, "回退路径必须逐字复现旧分块");
  assert.equal(off.join(""), FULL, "拼接必须逐字守恒");
});

test("S7 打开后首块抬到 32 字、拼接仍逐字守恒", async () => {
  const off = await collect({ steadyBlocks: false });
  const on = await collect({ steadyBlocks: true });
  assert.equal(on.join(""), FULL, "稳态分块不许吞字、不许重复");
  assert.ok(on[0].length >= STEADY_FIRST_BLOCK_CHARS - 2, `首块只有 ${on[0].length} 字`);
  assert.ok(on[0].length > off[0].length, `稳态首块(${on[0].length})应大于旧首块(${off[0].length})`);
  assert.ok(on.at(-1)!.length >= STEADY_MIN_TAIL_CHARS || on.length === 1, `尾块只有 ${on.at(-1)!.length} 字`);
});

test("S8 显式 firstBlockChars 让调用方完全接管分块（稳态整体关闭）", async () => {
  const on = await collect({ steadyBlocks: true, firstBlockChars: 12 });
  const off = await collect({ steadyBlocks: false, firstBlockChars: 12 });
  assert.equal(on.join(""), FULL);
  assert.deepEqual(on, off, "显式锁定首块字数后，30 字下限不得再改写任何切分");
  assert.ok(on[0].length < STEADY_FIRST_BLOCK_CHARS, "不应被抬到 32 字");
});
