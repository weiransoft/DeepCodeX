/**
 * 本轮语音指令快照（voice/turn-directive）
 *
 * ## 这个测试守的是什么
 *
 * 用户的实际抱怨是「同一条回复里，声音的语速和音色前后不一致」。根因不在
 * 合成模型，而在**清除时机**：播报队列惰性合成，流结束时队列里还有句子没
 * 送去合成，而旧实现恰好在流结束就清掉了 `once` 指令——于是后半篇退回默认音色。
 *
 * 因此这里的核心断言只有一条（T3）：**收尾之后，本轮参数仍然可读**。
 * 次要断言是 T4：下一轮不能继承上一轮的 once。
 *
 * @module tests/voice-turn-directive
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnDirective } from "../web/src/voice/turn-directive";

test("T1 没有指令时，合成参数读不到任何覆盖", () => {
  const state = new TurnDirective();
  state.beginTurn();
  assert.equal(state.current(), null);
});

test("T2 收到指令后本轮立刻生效（首句就要用上）", () => {
  const state = new TurnDirective();
  state.beginTurn();
  state.apply({ voice: "御姐音", speed: 1.2, once: true });
  assert.equal(state.current()?.speed, 1.2);
  assert.equal(state.current()?.voice, "御姐音");
});

test("T3 收尾清的是跨轮默认，本轮快照仍可读（后半段不换音色）", () => {
  const state = new TurnDirective();
  state.beginTurn();
  state.apply({ speed: 0.9, once: true });

  state.endTurn();

  // 这一条是整个修复的核心：队列里没合成完的句子，此刻还要用它
  assert.equal(state.current()?.speed, 0.9, "收尾后本轮参数不能被清掉");
});

test("T4 下一轮不再继承上一轮的 once 指令", () => {
  const state = new TurnDirective();
  state.beginTurn();
  state.apply({ speed: 0.9, once: true });
  state.endTurn();

  state.beginTurn();
  assert.equal(state.current(), null, "once 的指令只影响那一条回复");
});

test("T5 不带 once 的指令成为后续回复的默认", () => {
  const state = new TurnDirective();
  state.beginTurn();
  state.apply({ voice: "温柔", once: false });
  state.endTurn();

  state.beginTurn();
  assert.equal(state.current()?.voice, "温柔", "非 once 指令应跨轮保留");
});

test("T6 每轮结束只影响 once，不误清跨轮默认", () => {
  const state = new TurnDirective();
  state.beginTurn();
  state.apply({ speed: 1.1, once: false });
  state.endTurn();

  // 第二轮又收到一条 once 指令，收尾后跨轮默认应回到「温柔」那套，而不是空
  state.beginTurn();
  state.apply({ speed: 1.5, once: true });
  state.endTurn();

  state.beginTurn();
  assert.equal(state.current()?.speed, 1.1, "第二轮结束时不该把基础默认一起清掉");
});
