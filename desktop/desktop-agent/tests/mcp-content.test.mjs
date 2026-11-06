/**
 * MCP 图像内容块（方案 §3.12「把图喂给模型」）。
 *
 * 这一层要证明的是**协议帧里真的有图**，而不是「sidecar 说它能截图」：
 * text 块只留元数据、base64 只出现在 image 块、超限/非法一律降级并标注。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { base64Bytes, splitImagePayload, toMcpContent, MAX_IMAGE_BASE64_CHARS } from "../src/modules/mcp-content.mjs";
import { createMockBackend } from "../src/backends/mock.mjs";
import { DesktopAgent } from "../src/agent.mjs";
import { defaultPolicy } from "../src/modules/policy-guard.mjs";
import { createMcpServer } from "../src/mcp-server.mjs";

/** mock 后端的 1×1 透明 PNG（真 base64，解码后 70 字节） */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function makeAgent(policy = {}) {
  return new DesktopAgent({
    backend: createMockBackend(),
    policy: {
      ...defaultPolicy(),
      enabled: true,
      permissionMode: "auto",
      allowScreenshot: true,
      allowedApps: [{ appId: "notepad", always: true, scopes: ["read", "write"] }],
      ...policy,
    },
  });
}

function capture() {
  const frames = [];
  return {
    frames,
    output: { write: (s) => frames.push(JSON.parse(s.trim())) },
    log: () => {},
  };
}

test("base64 字节数：1×1 PNG 算出 70 字节，空串/非串为 0", () => {
  assert.equal(base64Bytes(PNG_1X1), 70);
  assert.equal(base64Bytes(""), 0);
  assert.equal(base64Bytes(undefined), 0);
  assert.equal(base64Bytes("QQ=="), 1);
  assert.equal(base64Bytes("QUI="), 2);
  assert.equal(base64Bytes("QUJD"), 3);
});

test("splitImagePayload：text 块不含 base64，只留元数据", () => {
  const payload = {
    ok: true,
    width: 1280,
    height: 800,
    mimeType: "image/png",
    base64: PNG_1X1,
    frame: { x: 0, y: 0, width: 1280, height: 800, scaleX: 1, scaleY: 1 },
  };
  const { text, image, dropped } = splitImagePayload(payload);
  assert.equal(dropped, null);
  assert.equal(image.type, "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, PNG_1X1);
  assert.equal(text.includes(PNG_1X1), false, "text 块不能重复携带 base64");
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.image, { mimeType: "image/png", bytes: 70, attached: true });
  assert.deepEqual(parsed.frame, payload.frame);
});

test("splitImagePayload：无 base64 时不产生图像块", () => {
  const { text, image } = splitImagePayload({ ok: true, width: 10, height: 10, mimeType: "image/png" });
  assert.equal(image, null);
  assert.equal("image" in JSON.parse(text), false);
});

test("超限图降级为文本并显式标注 too-large（不静默截断）", () => {
  const big = "A".repeat(MAX_IMAGE_BASE64_CHARS + 4);
  const { text, image, dropped } = splitImagePayload({ ok: true, mimeType: "image/png", base64: big });
  assert.equal(image, null);
  assert.equal(dropped.reason, "too-large");
  const parsed = JSON.parse(text);
  assert.equal(parsed.image.attached, false);
  assert.equal(parsed.image.reason, "too-large");
  assert.equal(parsed.image.limit, MAX_IMAGE_BASE64_CHARS);
});

test("非白名单 mime 与坏 base64 都不进图像块", () => {
  const bmp = splitImagePayload({ ok: true, mimeType: "image/bmp", base64: PNG_1X1 });
  assert.equal(bmp.image, null);
  assert.equal(bmp.dropped.reason, "unsupported-mime");

  const broken = splitImagePayload({ ok: true, mimeType: "image/png", base64: "not base64!!" });
  assert.equal(broken.image, null);
  assert.equal(broken.dropped.reason, "invalid-base64");

  // 长度不是 4 的倍数同样是坏 base64（解码端会算出错误字节数）
  const misaligned = splitImagePayload({ ok: true, mimeType: "image/png", base64: "QUJDR" });
  assert.equal(misaligned.image, null);
  assert.equal(misaligned.dropped.reason, "invalid-base64");
});

test("失败结果（ok:false）即便带 base64 也不附图像块", () => {
  const { image, dropped } = splitImagePayload({
    ok: false,
    code: "ACTION_DENIED",
    mimeType: "image/png",
    base64: PNG_1X1,
  });
  assert.equal(image, null);
  assert.equal(dropped, null);
});

test("toMcpContent：content[0] 恒为 text，isError 跟随 ok", () => {
  const ok = toMcpContent({ ok: true, width: 1, height: 1, mimeType: "image/png", base64: PNG_1X1 });
  assert.equal(ok.content.length, 2);
  assert.equal(ok.content[0].type, "text");
  assert.equal(ok.content[1].type, "image");
  assert.equal(ok.isError, false);
  assert.equal(ok.imageAttached, true);

  const bad = toMcpContent({ ok: false, code: "CAPABILITY_UNAVAILABLE", message: "截屏通道默认关闭" });
  assert.equal(bad.content.length, 1);
  assert.equal(bad.isError, true);
  assert.equal(bad.imageAttached, false);
});

test("MCP tools/call：desktop_screenshot includeImage=true 时帧里带 image 块，且能解回 PNG", async () => {
  const c = capture();
  const server = createMcpServer(makeAgent(), { input: process.stdin, output: c.output, log: c.log });
  await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "desktop_screenshot", arguments: { appId: "notepad", reason: "unit", includeImage: true } },
  });
  const frame = c.frames[0];
  assert.equal(frame.result.isError, false);
  assert.equal(frame.result.content.length, 2);

  const textPayload = JSON.parse(frame.result.content[0].text);
  assert.equal(textPayload.image.attached, true);
  assert.equal(textPayload.frame.width, textPayload.width);
  assert.equal(frame.result.content[0].text.includes(PNG_1X1), false);

  const image = frame.result.content[1];
  assert.equal(image.type, "image");
  assert.equal(image.mimeType, "image/png");
  const bytes = Buffer.from(image.data, "base64");
  // PNG 魔数：89 50 4E 47
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(bytes.length, 70);
  server.close();
});

test("MCP tools/call：默认（includeImage=false）仍只回 text，协议面无变化", async () => {
  const c = capture();
  const server = createMcpServer(makeAgent(), { input: process.stdin, output: c.output, log: c.log });
  await server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "desktop_screenshot", arguments: { appId: "notepad", reason: "unit" } },
  });
  const frame = c.frames[0];
  assert.equal(frame.result.content.length, 1);
  assert.equal("base64" in JSON.parse(frame.result.content[0].text), false);
  server.close();
});

test("MCP tools/call：非截图工具不受影响（还是单 text 块）", async () => {
  const c = capture();
  const server = createMcpServer(makeAgent(), { input: process.stdin, output: c.output, log: c.log });
  await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "desktop_status", arguments: {} } });
  const frame = c.frames[0];
  assert.equal(frame.result.content.length, 1);
  assert.equal(JSON.parse(frame.result.content[0].text).ok, true);
  server.close();
});
