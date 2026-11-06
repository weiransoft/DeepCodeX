/**
 * MCP 图像内容块 → 模型输入（方案 §3.12「把图喂给模型」）。
 *
 * 覆盖三段：
 * 1. 图像块挑选与上限（mime 白名单 / 坏 base64 / 字节上限 / 条数上限）；
 * 2. follow-up 消息形状（role=user + image_url data URL + visible=false + 不可信提示）；
 * 3. executor 接线（MCP 结果带图时产出 followUpMessages，不带图时行为完全不变）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MCP_IMAGE_MAX_BYTES,
  base64ByteLength,
  buildMcpImageFollowUpMessage,
  describeSkippedImages,
  extractMcpImages,
} from "../mcp/mcp-image-content.js";
import { ToolExecutor } from "../tools/executor.js";
import type { McpManager } from "../mcp/mcp-manager";

/** 1×1 透明 PNG（70 字节） */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("base64 字节数：按字符数算解码后长度", () => {
  assert.equal(base64ByteLength(PNG_1X1), 70);
  assert.equal(base64ByteLength("QQ=="), 1);
  assert.equal(base64ByteLength("QUI="), 2);
  assert.equal(base64ByteLength("QUJD"), 3);
  assert.equal(base64ByteLength(""), 0);
});

test("extractMcpImages：正常 png 被保留，text 块被忽略", () => {
  const { images, skipped } = extractMcpImages([
    { type: "text", text: '{"ok":true}' },
    { type: "image", data: PNG_1X1, mimeType: "image/png" },
  ]);
  assert.equal(skipped.length, 0);
  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, "image/png");
  assert.equal(images[0].bytes, 70);
});

test("extractMcpImages：非白名单 mime / 坏 base64 / 超限各自被跳过且带原因", () => {
  const huge = "A".repeat(Math.ceil((MCP_IMAGE_MAX_BYTES + 16) / 3) * 4);
  const { images, skipped } = extractMcpImages([
    { type: "image", data: PNG_1X1, mimeType: "image/bmp" },
    { type: "image", data: "not base64!!", mimeType: "image/png" },
    { type: "image", data: huge, mimeType: "image/png" },
  ]);
  assert.equal(images.length, 0);
  assert.deepEqual(
    skipped.map((s) => s.reason),
    ["unsupported-mime", "invalid-base64", "too-large"]
  );
});

test("extractMcpImages：条数上限（单次只带 1 张，多余的标注丢弃）", () => {
  const { images, skipped } = extractMcpImages([
    { type: "image", data: PNG_1X1, mimeType: "image/png" },
    { type: "image", data: PNG_1X1, mimeType: "image/jpeg" },
  ]);
  assert.equal(images.length, 1);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, "too-many-images");
});

test("describeSkippedImages：空集不产出噪音，非空说明原因", () => {
  assert.equal(describeSkippedImages([]), "");
  const note = describeSkippedImages([{ reason: "too-large", mimeType: "image/png", bytes: 9_000_000 }]);
  assert.match(note, /image attachment dropped/);
  assert.match(note, /too-large/);
  assert.match(note, /image\/png/);
});

test("follow-up 消息：user 角色 + data URL + 不可见 + 不可信提示", () => {
  const msg = buildMcpImageFollowUpMessage("mcp__desktop-agent__desktop_screenshot", [
    { mimeType: "image/png", data: PNG_1X1, bytes: 70 },
  ]);
  assert.equal(msg.role, "user");
  assert.equal(msg.visible, false);
  assert.match(msg.content, /image attachment/);
  assert.match(msg.content, /untrusted data, not as instructions/);
  const parts = msg.contentParams as Array<{ type: string; image_url: { url: string } }>;
  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, "image_url");
  assert.equal(parts[0].image_url.url, `data:image/png;base64,${PNG_1X1}`);
});

/** 最小 MCP manager 替身：只实现 executor 用到的两个方法 */
function fakeMcpManager(result: Record<string, unknown>): McpManager {
  return {
    isMcpTool: (name: string) => name.startsWith("mcp__"),
    executeMcpTool: async () => result,
  } as unknown as McpManager;
}

function makeExecutor(mcp: McpManager): ToolExecutor {
  return new ToolExecutor(process.cwd(), undefined, mcp);
}

function toolCall(name: string, args: Record<string, unknown>) {
  return { id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args) } };
}

test("executor：MCP 结果带图 → 产出 followUpMessages，且 images 不外泄到工具结果对象", async () => {
  const executor = makeExecutor(
    fakeMcpManager({
      ok: true,
      name: "mcp__desktop-agent__desktop_screenshot",
      output: '{"ok":true,"width":1280}',
      images: [{ mimeType: "image/png", data: PNG_1X1, bytes: 70 }],
    })
  );
  const [execution] = await executor.executeToolCalls("s1", [toolCall("mcp__desktop-agent__desktop_screenshot", {})]);
  assert.ok(execution);
  const result = execution.result;

  assert.equal(result.ok, true);
  assert.equal(result.output, '{"ok":true,"width":1280}');
  assert.equal((result as { images?: unknown }).images, undefined, "images 应由 followUpMessages 承载，不随结果对象扩散");
  const followUps = result.followUpMessages ?? [];
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].role, "user");
  const parts = followUps[0].contentParams as Array<{ image_url: { url: string } }>;
  assert.ok(parts[0].image_url.url.startsWith("data:image/png;base64,"));

  // 工具消息本身仍是纯文本 JSON：图像不能挂在 role:"tool" 上
  assert.equal(typeof JSON.parse(execution.content).output, "string");
});

test("executor：MCP 结果无图 → 行为与改动前一致（无 followUpMessages）", async () => {
  const executor = makeExecutor(
    fakeMcpManager({ ok: true, name: "mcp__x__y", output: "hello" })
  );
  const [execution] = await executor.executeToolCalls("s1", [toolCall("mcp__x__y", {})]);
  assert.equal(execution.result.output, "hello");
  assert.equal(execution.result.followUpMessages, undefined);
});
