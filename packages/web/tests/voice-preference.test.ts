/**
 * 流式播报偏好测试（默认开 + 旧键迁移）
 *
 * ## 为什么单测这个
 *
 * 流式曾因为「逐块独立 WSOLA 边界失真」被改成默认关。现在服务端改成
 * 整个请求共用一条有状态变速时间轴（`test_streaming_wsola.py` 锁住分块喂入
 * 与整段一次变速逐样本相等），默认重新打开。
 *
 * 但只改 `defaultStreamPlayback()` 不够：上一版可能留下过显式的 `"0"`，
 * 不迁移的话老客户端永远回不到默认开。这里把「默认值 / 迁移 / 显式关
 * 仍被尊重」三件事钉成断言。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STREAM_PLAYBACK_KEY,
  defaultStreamPlayback,
  readStreamPlayback,
  writeStreamPlayback,
} from "../web/src/voice/preference";

/** 上一版（逐块独立变速时代）的存储键 */
const LEGACY_KEY = "dcx.voice.streamPlayback";

type FakeStore = Map<string, string>;

/** 临时替换 globalThis.localStorage，用完精确还原 */
function withStorage(initial: Record<string, string>, run: (store: FakeStore) => void): void {
  const store: FakeStore = new Map(Object.entries(initial));
  const fake = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
    clear: (): void => {
      store.clear();
    },
    key: (): string | null => null,
    get length(): number {
      return store.size;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true, writable: true });
  try {
    run(store);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

test("P1 流式播报默认开", () => {
  assert.equal(defaultStreamPlayback(), true);
});

test("P2 没有存储值时读到默认开", () => {
  withStorage({}, () => {
    assert.equal(readStreamPlayback(), true);
  });
});

test("P3 上一版残留的显式关闭不继承，且旧键被一次性清理", () => {
  withStorage({ [LEGACY_KEY]: "0" }, (store) => {
    assert.equal(readStreamPlayback(), true, "旧值不该压住新默认");
    assert.equal(store.has(LEGACY_KEY), false, "旧键应被清掉，避免每次读都做无用判断");
  });
});

test("P4 新键的显式关闭仍然被尊重", () => {
  withStorage({ [STREAM_PLAYBACK_KEY]: "0" }, () => {
    assert.equal(readStreamPlayback(), false);
  });
});

test("P5 新键的显式开启仍然被尊重", () => {
  withStorage({ [STREAM_PLAYBACK_KEY]: "1" }, () => {
    assert.equal(readStreamPlayback(), true);
  });
});

test("P6 写入只落新键，读回一致", () => {
  withStorage({}, (store) => {
    writeStreamPlayback(false);
    assert.equal(store.get(STREAM_PLAYBACK_KEY), "0");
    assert.equal(readStreamPlayback(), false);
    writeStreamPlayback(true);
    assert.equal(store.get(STREAM_PLAYBACK_KEY), "1");
    assert.equal(readStreamPlayback(), true);
  });
});

test("P7 迁移后手动关闭不会被下一次读取重置", () => {
  withStorage({ [LEGACY_KEY]: "0" }, (store) => {
    assert.equal(readStreamPlayback(), true);
    writeStreamPlayback(false);
    assert.equal(readStreamPlayback(), false);
    assert.equal(readStreamPlayback(), false);
    assert.equal(store.has(LEGACY_KEY), false);
  });
});

test("P8 fallback 参数仍可覆盖默认值（供测试/嵌入式场景）", () => {
  withStorage({}, () => {
    assert.equal(readStreamPlayback(false), false);
  });
});
