/**
 * 语音播报队列测试（SpeechQueue）
 *
 * ## 为什么要测这个
 *
 * 2026-11-05 用户报「只播了前面几秒，后面没声音，却显示还在播」。根因是
 * `playOne` 只等 `onended`，而 `stop()` 里的 `pause()` 既不触发 `ended`
 * 也不触发 `error`——promise 永不 settle，`drain` 的 `running` 永久为 true，
 * 之后每一次 `enqueue` 都被 `if (this.running) return` 静默丢弃。
 *
 * 这一层的 bug 在真机上表现为"语音时好时坏"，极难复现；用假音频元素把
 * 「不 ended / 不 error / 不推进」这三种僵尸状态显式造出来才能钉住。
 *
 * ## 假元素怎么用
 *
 * `createAudio` 是注入点（生产默认 `new Audio(url)`）。测试用三种模式：
 * - `ok`：自动推进 currentTime，末尾触发 ended
 * - `stall`：什么都不做（模拟设备切换/后台挂起：没声音、也没结束事件）
 * - `reject`：`play()` 直接拒绝（模拟 autoplay 被拦）
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SpeechQueue } from "../web/src/voice/player";

/** 播放模式 */
type Mode = "ok" | "stall" | "reject";

/**
 * 假音频元素
 *
 * 只实现 SpeechQueue 用到的那部分 HTMLAudioElement 表面。
 */
class FakeAudio {
  currentTime = 0;
  ended = false;
  paused = true;
  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  /** pause 被调用的次数（断言收尾确实停了元素） */
  pauseCalls = 0;

  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param url objectURL
   * @param mode 行为模式
   * @param step 每次推进的秒数
   * @param hooks 观测钩子（用于断言事件顺序）
   */
  constructor(
    url: string,
    private readonly mode: Mode,
    private readonly step = 0.05,
    private readonly hooks: { onEnd?: () => void } = {}
  ) {
    this.src = url;
  }

  /**
   * 开始播放
   *
   * @returns 与真实元素一致：开始播放时就 resolve（不是播完）
   */
  play(): Promise<void> {
    if (this.mode === "reject") return Promise.reject(new Error("NotAllowedError"));
    if (this.mode === "stall") {
      // 元素"在播"但时间永远不推进
      this.paused = false;
      return Promise.resolve();
    }
    this.paused = false;
    this.timer = setInterval(() => {
      this.currentTime += this.step;
      this.ontimeupdate?.();
      if (this.currentTime >= 0.15) {
        this.ended = true;
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        this.hooks.onEnd?.();
        this.onended?.();
      }
    }, 10);
    return Promise.resolve();
  }

  /** 暂停（真实元素 pause 不会触发 ended/error，这里如实模拟） */
  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** 移除 src（真实元素会有类似效果） */
  removeAttribute(): void {
    this.src = "";
  }
}

/**
 * 装上 URL.createObjectURL 桩
 *
 * node 里没有可靠实现，且我们只关心"是否被回收"。
 *
 * @returns 回收记录与卸载函数
 */
function stubObjectUrl(): { revoked: string[]; restore: () => void } {
  const revoked: string[] = [];
  const origin = globalThis.URL as unknown as Record<string, unknown>;
  const prevCreate = origin.createObjectURL;
  const prevRevoke = origin.revokeObjectURL;
  origin.createObjectURL = () => "blob:fake";
  origin.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  return {
    revoked,
    restore: () => {
      origin.createObjectURL = prevCreate;
      origin.revokeObjectURL = prevRevoke;
    },
  };
}

/**
 * 等到条件成立
 *
 * @param predicate 条件
 * @param timeoutMs 超时
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("P1 正常播放：逐句播完并回落 speaking，URL 全部回收", async () => {
  const url = stubObjectUrl();
  try {
    const spoken: string[] = [];
    const states: boolean[] = [];
    const made: FakeAudio[] = [];
    const queue = new SpeechQueue(
      async (text) => {
        spoken.push(text);
        return `blob:${text}`;
      },
      { onSpeakingChange: (v) => states.push(v) },
      {
        createAudio: (u) => {
          const audio = new FakeAudio(u, "ok");
          made.push(audio);
          return audio as unknown as HTMLAudioElement;
        },
      }
    );

    queue.enqueue("第一句。");
    queue.enqueue("第二句。");
    await waitFor(() => states.length > 0 && states[states.length - 1] === false);

    assert.deepEqual(spoken, ["第一句。", "第二句。"], "两句都要合成");
    assert.equal(made.length, 2, "两句都要播");
    assert.equal(states[0], true, "先进入播报态");
    assert.equal(states[states.length - 1], false, "播完必须回落");
    assert.ok(url.revoked.length >= 2, `每句的 objectURL 都要回收，实际 ${url.revoked.length}`);
    assert.ok(
      made.every((a) => a.pauseCalls > 0),
      "每句收尾都要 pause，不能把元素留在播放中"
    );
  } finally {
    url.restore();
  }
});

test("P2 停滞自愈：音频不推进也没结束事件 → 超时后跳过并继续下一句", async () => {
  const url = stubObjectUrl();
  try {
    const errors: string[] = [];
    const states: boolean[] = [];
    let created = 0;
    const queue = new SpeechQueue(
      async (text) => `blob:${text}`,
      { onSpeakingChange: (v) => states.push(v), onError: (m) => errors.push(m) },
      {
        createAudio: (u) => {
          created += 1;
          // 第一句造僵尸：不推进、不 ended、不 error
          return new FakeAudio(u, created === 1 ? "stall" : "ok") as unknown as HTMLAudioElement;
        },
        stallLimitMs: 60,
        stallCheckIntervalMs: 10,
        playStartTimeoutMs: 200,
      }
    );

    queue.enqueue("卡住的一句。");
    queue.enqueue("后面的一句。");
    await waitFor(() => created === 2 && states[states.length - 1] === false);

    assert.equal(created, 2, "第一句卡住后必须继续播第二句（否则就是 queue 死锁）");
    assert.ok(
      errors.some((m) => m.includes("中断")),
      `停滞要给出可读提示，实际 ${JSON.stringify(errors)}`
    );
    assert.equal(states[states.length - 1], false, "停滞收尾后 speaking 必须回落");
  } finally {
    url.restore();
  }
});

test("P3 打断：播放中 stop() 立刻结束等待，speaking 回落", async () => {
  const url = stubObjectUrl();
  try {
    const states: boolean[] = [];
    let audio: FakeAudio | null = null;
    const queue = new SpeechQueue(
      async () => "blob:x",
      { onSpeakingChange: (v) => states.push(v) },
      {
        createAudio: (u) => {
          audio = new FakeAudio(u, "stall");
          return audio as unknown as HTMLAudioElement;
        },
        // 停滞上限给得很长：证明结束是靠 stop() 而不是靠超时
        stallLimitMs: 60_000,
        stallCheckIntervalMs: 10,
        playStartTimeoutMs: 60_000,
      }
    );

    queue.enqueue("一句很长的话。");
    await waitFor(() => audio !== null);
    await new Promise((r) => setTimeout(r, 20));

    queue.stop();
    await waitFor(() => states[states.length - 1] === false, 500);

    assert.equal(states[states.length - 1], false, "stop 必须让播放态回落");
    assert.ok(audio !== null);
    // stop() 自己停一次、playOne 收尾再停一次，幂等重复是有意的双保险
    assert.ok((audio as FakeAudio).pauseCalls >= 1, "stop 要真的把元素停掉");
  } finally {
    url.restore();
  }
});

test("P4 打断后还能继续播（回归：stop 曾把队列永久卡死）", async () => {
  const url = stubObjectUrl();
  try {
    const spoken: string[] = [];
    const states: boolean[] = [];
    let audio: FakeAudio | null = null;
    const queue = new SpeechQueue(
      async (text) => {
        spoken.push(text);
        return `blob:${text}`;
      },
      { onSpeakingChange: (v) => states.push(v) },
      {
        createAudio: (u) => {
          audio = new FakeAudio(u, "stall");
          return audio as unknown as HTMLAudioElement;
        },
        stallLimitMs: 60_000,
        stallCheckIntervalMs: 10,
        playStartTimeoutMs: 60_000,
      }
    );

    // 第一轮：播到一半被打断
    queue.enqueue("被打断的话。");
    await waitFor(() => audio !== null);
    queue.stop();
    await waitFor(() => states[states.length - 1] === false, 500);

    // 第二轮：打断之后新消息必须还能播出来
    const before = spoken.length;
    queue.enqueue("打断之后的新消息。");
    await waitFor(() => spoken.length > before, 1000);

    assert.ok(spoken.includes("打断之后的新消息。"), `打断后必须能重新开播，实际合成过 ${JSON.stringify(spoken)}`);
    assert.equal(states[states.length - 1], true, "新一轮已经开始播（仍在播报态）");
  } finally {
    url.restore();
  }
});

test("P5 合成失败只跳过该句，后续照播", async () => {
  const url = stubObjectUrl();
  try {
    const errors: string[] = [];
    const states: boolean[] = [];
    const played: string[] = [];
    const queue = new SpeechQueue(
      async (text) => {
        if (text.includes("坏")) throw new Error("合成服务不可用");
        return `blob:${text}`;
      },
      { onSpeakingChange: (v) => states.push(v), onError: (m) => errors.push(m) },
      {
        createAudio: (u) => {
          played.push(u);
          return new FakeAudio(u, "ok") as unknown as HTMLAudioElement;
        },
      }
    );

    queue.enqueue("坏句子。");
    queue.enqueue("好句子。");
    await waitFor(() => states.length > 0 && states[states.length - 1] === false);

    assert.ok(
      errors.some((m) => m.includes("合成服务不可用")),
      "合成失败要上报"
    );
    assert.deepEqual(played, ["blob:好句子。"], "失败的句子跳过，好的那句照播");
  } finally {
    url.restore();
  }
});

test("P6 play() 被拒（autoplay 拦截）不卡死，继续下一句", async () => {
  const url = stubObjectUrl();
  try {
    const errors: string[] = [];
    const states: boolean[] = [];
    let created = 0;
    const queue = new SpeechQueue(
      async () => "blob:x",
      { onSpeakingChange: (v) => states.push(v), onError: (m) => errors.push(m) },
      {
        createAudio: (u) => {
          created += 1;
          return new FakeAudio(u, created === 1 ? "reject" : "ok") as unknown as HTMLAudioElement;
        },
        stallLimitMs: 2000,
        stallCheckIntervalMs: 10,
        playStartTimeoutMs: 2000,
      }
    );

    queue.enqueue("第一句。");
    queue.enqueue("第二句。");
    await waitFor(() => created === 2 && states[states.length - 1] === false);

    assert.equal(created, 2, "被拒的句子不能让队列停下");
    assert.ok(
      errors.some((m) => m.includes("播放失败")),
      `要提示播放失败，实际 ${JSON.stringify(errors)}`
    );
  } finally {
    url.restore();
  }
});

test("P7 预取与播放并行：下一句在第一句播完之前就开始合成（回归：句间空等一次合成）", async () => {
  // 实测 TTS 的 RTF≈0.19（合成比播放快 5 倍），所以只要在**播放期间**把下一句
  // 送去合成，句间就不该有任何等待。原实现的 warmPrefetch() 在 playOne 末尾
  // 才调用——那一刻当前句已经播完，下一句的合成才刚开始，于是每两句之间
  // 固定空等一次完整合成时间（实测 0.5~0.9 秒），听感就是"前一句说完了，
  // 停一下，后一句才出来"。
  const url = stubObjectUrl();
  try {
    const events: string[] = [];
    const queue = new SpeechQueue(
      async (text) => {
        events.push(`synth:${text}`);
        return `blob:${text}`;
      },
      {},
      {
        createAudio: (u) => {
          const label = u.replace("blob:", "");
          // step 放慢，让"第一句播放期间"这个窗口足够宽，事件顺序才有区分度
          const audio = new FakeAudio(u, "ok", 0.01, { onEnd: () => events.push(`end:${label}`) });
          events.push(`play:${label}`);
          return audio as unknown as HTMLAudioElement;
        },
      }
    );

    queue.enqueue("第一句。");
    queue.enqueue("第二句。");
    await waitFor(() => events.includes("end:第二句。"));

    const synthSecond = events.indexOf("synth:第二句。");
    const endFirst = events.indexOf("end:第一句。");
    assert.ok(synthSecond >= 0 && endFirst >= 0, `事件不全：${events.join(" → ")}`);
    assert.ok(synthSecond < endFirst, `第二句应在第一句播完前就开始合成，实际顺序：${events.join(" → ")}`);
  } finally {
    url.restore();
  }
});
