import { test } from "node:test";
import assert from "node:assert/strict";
import { getPromptCursorPlacement, parseTerminalInput, renderBufferWithCursor } from "../ui/PromptInput";

test("parseTerminalInput treats DEL bytes as backspace", () => {
  const { input, key } = parseTerminalInput("\u007F");
  assert.equal(input, "");
  assert.equal(key.backspace, true);
  assert.equal(key.delete, false);
});

test("parseTerminalInput treats CSI 3 tilde as forward delete", () => {
  const { input, key } = parseTerminalInput("\u001B[3~");
  assert.equal(input, "");
  assert.equal(key.delete, true);
  assert.equal(key.backspace, false);
});

test("parseTerminalInput does not mark plain arrow keys as meta", () => {
  const { key } = parseTerminalInput("\u001B[A");
  assert.equal(key.upArrow, true);
  assert.equal(key.meta, false);
});

test("parseTerminalInput recognizes home and end keys", () => {
  const home = parseTerminalInput("\u001B[H");
  const end = parseTerminalInput("\u001B[F");
  assert.equal(home.key.home, true);
  assert.equal(home.key.meta, false);
  assert.equal(end.key.end, true);
  assert.equal(end.key.meta, false);
});

test("parseTerminalInput recognizes word navigation modifiers", () => {
  const ctrlLeft = parseTerminalInput("\u001B[1;5D");
  const metaRight = parseTerminalInput("\u001Bf");
  assert.equal(ctrlLeft.key.leftArrow, true);
  assert.equal(ctrlLeft.key.ctrl, true);
  assert.equal(ctrlLeft.key.meta, false);
  assert.equal(metaRight.input, "f");
  assert.equal(metaRight.key.rightArrow, true);
  assert.equal(metaRight.key.meta, true);
});

test("parseTerminalInput recognizes shifted return sequences", () => {
  const { input, key } = parseTerminalInput("\u001B\r");
  assert.equal(input, "\r");
  assert.equal(key.return, true);
  assert.equal(key.shift, true);
  assert.equal(key.meta, false);
});

test("parseTerminalInput recognizes terminal focus events", () => {
  const focusIn = parseTerminalInput("\u001B[I");
  const focusOut = parseTerminalInput("\u001B[O");
  assert.equal(focusIn.key.focusIn, true);
  assert.equal(focusIn.key.meta, false);
  assert.equal(focusOut.key.focusOut, true);
  assert.equal(focusOut.key.meta, false);
});

test("renderBufferWithCursor hides the simulated cursor when unfocused", () => {
  assert.equal(renderBufferWithCursor({ text: "hello", cursor: 5 }, false), "hello");
  assert.equal(renderBufferWithCursor({ text: "hello", cursor: 1 }, false), "hello");
});

test("renderBufferWithCursor draws the simulated cursor when focused", () => {
  assert.equal(renderBufferWithCursor({ text: "", cursor: 0 }, true), " ");
  assert.equal(renderBufferWithCursor({ text: "hello", cursor: 5 }, true), "hello ");
  assert.equal(renderBufferWithCursor({ text: "hello", cursor: 1 }, true), "hello");
  assert.equal(renderBufferWithCursor({ text: "hello\n", cursor: 6 }, true), "hello\n ");
  assert.equal(renderBufferWithCursor({ text: "\n", cursor: 1 }, true), "\n ");
});

test("getPromptCursorPlacement targets the prompt row above divider and footer", () => {
  const placement = getPromptCursorPlacement({ text: "hello", cursor: 5 }, 80, "❯ ", "Enter send");
  assert.deepEqual(placement, { rowsUp: 3, column: 7 });
});

test("getPromptCursorPlacement targets the reserved row after a trailing newline", () => {
  const placement = getPromptCursorPlacement({ text: "hello\n", cursor: 6 }, 80, "❯ ", "Enter send");
  assert.deepEqual(placement, { rowsUp: 3, column: 2 });
});

test("getPromptCursorPlacement accounts for CJK character width", () => {
  const placement = getPromptCursorPlacement({ text: "你好", cursor: 2 }, 80, "❯ ", "Enter send");
  assert.equal(placement.column, 6);
});

test("getPromptCursorPlacement accounts for multiline buffer rows", () => {
  const placement = getPromptCursorPlacement({ text: "hello\nworld", cursor: 11 }, 80, "❯ ", "Enter send");
  assert.deepEqual(placement, { rowsUp: 3, column: 7 });
  const middle = getPromptCursorPlacement({ text: "hello\nworld", cursor: 2 }, 80, "❯ ", "Enter send");
  assert.deepEqual(middle, { rowsUp: 4, column: 4 });
});
