/**
 * chat-model.ts 工具条目文本提取单测（extractToolText / parseLeadingJsonBlock）。
 *
 * 覆盖真实数据形态（无 mock）：
 * - 磁盘历史 content：「多个序列化工具结果 JSON 块 + 尾部自然文本」混排
 *   （引擎把 bash 等工具结果序列化为 { ok, name, output, metadata } 存入历史消息）；
 * - 实时 tool_progress：raw = { event, item } 形态；
 * - JSON 兜底：无可读文本字段时返回 null（调用方回退渲染原始 JSON）；
 * - 括号平衡扫描：字符串内的引号/转义括号不干扰块边界。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractToolText, parseLeadingJsonBlock } from "../web/src/chat-model";

test("chat-model：extractToolText 应解析混排 content 中的多个 JSON 块为 output 文本", () => {
  // 模拟真实历史 content：两个 bash 结果 JSON 块 + 尾部助手自然文本
  const block1 = JSON.stringify({
    ok: true,
    name: "bash",
    output: "Filesystem   Size  Used\n/dev/vda2    2.0G  259M\n",
    metadata: { exitCode: 0, truncated: false },
  });
  const block2 = JSON.stringify({
    ok: true,
    name: "bash",
    output: "70G\t/home/hguser\n19G\t/home/hguser/.trae-cn-server\n",
    metadata: { exitCode: 0 },
  });
  const raw = { content: `${block1}\n${block2}\n--- 可读性测试 ---\nalternatives.log\n` };
  const text = extractToolText(raw);
  assert.ok(text !== null);
  // output 字段直显，JSON 壳与字段名不再出现
  assert.ok(text.includes("Filesystem   Size  Used"));
  assert.ok(text.includes("70G\t/home/hguser"));
  // 尾部自然文本原样保留
  assert.ok(text.includes("--- 可读性测试 ---"));
  // JSON 壳不应出现（ok/name/metadata 字段名已被剥离）
  assert.ok(!text.includes('"ok"'));
  assert.ok(!text.includes('"metadata"'));
});

test("chat-model：extractToolText 应为异常 metadata 附加注记", () => {
  const block = JSON.stringify({
    ok: false,
    name: "bash",
    output: "cat: /var/log/secure: Permission denied\n",
    metadata: { exitCode: 1, signal: null, truncated: true, timedOut: false },
  });
  const text = extractToolText({ content: block });
  assert.ok(text !== null);
  assert.ok(text.endsWith("[退出码 1，输出已截断]"), `实际：${text}`);
  // signal=null（空值）不产生噪音注记
  assert.ok(!text.includes("信号"));
});

test("chat-model：extractToolText 应容忍 output 内含引号与花括号（括号平衡扫描）", () => {
  const block = JSON.stringify({
    ok: true,
    name: "bash",
    output: 'echo "{\\"key\\": 1}" done\n',
    metadata: { exitCode: 0 },
  });
  const text = extractToolText({ content: block });
  assert.ok(text !== null);
  assert.equal(text, 'echo "{\\"key\\": 1}" done\n');
});

test("chat-model：extractToolText 应在无完整 JSON 块时原样保留文本", () => {
  // 截断的 JSON（括号不平衡）与普通文本
  const raw = { content: '{"ok": true, "name": "bas\nsome plain text\nplain line 2\n' };
  const text = extractToolText(raw);
  assert.ok(text !== null);
  assert.ok(text.includes("some plain text"));
  assert.ok(text.includes("plain line 2"));
});

test("chat-model：extractToolText 实时形态应优先提取 item 的 output 字段", () => {
  const event = { chatId: "c1", status: "processing", toolCalls: [] };
  const item = { toolCallId: "t1", name: "bash", output: "hello world\n" };
  const text = extractToolText({ event, item });
  assert.equal(text, "hello world\n");
});

test("chat-model：extractToolText 无可读文本时应返回 null（回退 JSON 渲染）", () => {
  // ask_permission 类对象无 output/result/content 文本字段
  const raw = { event: { chatId: "c1", status: "ask_permission" } };
  assert.equal(extractToolText(raw), null);
  // 空对象与空 content 同样回退
  assert.equal(extractToolText({}), null);
  assert.equal(extractToolText({ content: "" }), null);
});

test("chat-model：parseLeadingJsonBlock 应解析首块并容忍块前空白", () => {
  const block = JSON.stringify({ ok: true, name: "bash", output: "x" });
  const parsed = parseLeadingJsonBlock(`\n  ${block}\n后续文本`);
  assert.ok(parsed !== null);
  assert.equal(parsed.name, "bash");
  // 非 JSON 开头
  assert.equal(parseLeadingJsonBlock("普通文本\n{not json"), null);
  // 截断块
  assert.equal(parseLeadingJsonBlock('{"name": "abc'), null);
});
