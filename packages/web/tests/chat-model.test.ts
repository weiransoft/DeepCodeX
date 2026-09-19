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
import {
  extractToolText,
  parseLeadingJsonBlock,
  humanizeEngineContent,
  extractJsonPayload,
} from "../web/src/chat-model";

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

test("chat-model：humanizeEngineContent 应把引擎拼接的工具结果块转为 output 文本", () => {
  // 真实形态：多个工具结果 JSON 块 + 尾部助手自然文本（无围栏）
  const block1 = JSON.stringify({
    ok: true,
    name: "bash",
    output: "Filesystem   Size\n/dev/vda2 2.0G\n",
    metadata: { exitCode: 0 },
  });
  const block2 = JSON.stringify({ ok: true, name: "bash", output: "70G\t/home/hguser\n", metadata: { exitCode: 0 } });
  const content = `${block1}\n${block2}\n/var/lib/docker 无权限读取。继续深挖：\n`;
  const out = humanizeEngineContent(content);
  assert.ok(out.includes("Filesystem   Size"), "块 1 output 必须直显");
  assert.ok(out.includes("70G\t/home/hguser"), "块 2 output 必须直显");
  assert.ok(out.includes("继续深挖"), "助手自然文本必须保留");
  assert.ok(!out.includes('"ok"') && !out.includes('"metadata"'), "JSON 壳必须剥离");
});

test("chat-model：humanizeEngineContent 必须保留围栏代码与非工具结果 JSON", () => {
  const toolBlock = JSON.stringify({ ok: true, name: "bash", output: "hello\n" });
  const content = [
    "结果如下：",
    toolBlock,
    "```json",
    '{"name": "bash", "output": "围栏内不应被改写"}',
    "```",
    "模型输出的配置示例：",
    '{"name": "myapp", "port": 8080}',
    "完。",
  ].join("\n");
  const out = humanizeEngineContent(content);
  // 围栏内 JSON 原样（模型主动输出，不是引擎拼接物）
  assert.ok(out.includes('{"name": "bash", "output": "围栏内不应被改写"}'), "围栏内代码必须原样保留");
  // 非工具结果特征（无 output 字段）的裸 JSON 原样
  assert.ok(out.includes('{"name": "myapp", "port": 8080}'), "非工具结果 JSON 必须原样保留");
  // 工具结果块被可读化
  assert.ok(out.includes("hello\n") || out.includes("hello"), "工具结果块应转为文本");
  assert.ok(!out.includes('"ok"'), "工具结果 JSON 壳剥离");
});

test("chat-model：humanizeEngineContent 纯文本与截断块应零改动直通", () => {
  // 纯自然文本（快速路径）
  assert.equal(humanizeEngineContent("普通回答，没有任何 JSON。"), "普通回答，没有任何 JSON。");
  // 截断 JSON 块（流式中间态）：解析失败原样保留
  const truncated = '执行中 {"ok": true, "name": "bas';
  assert.equal(humanizeEngineContent(truncated), truncated);
  // 空串
  assert.equal(humanizeEngineContent(""), "");
});

test("chat-model：extractJsonPayload 应解包双重序列化 JSON 为格式化文本", () => {
  // 双重序列化形态：output 本身就是序列化 JSON（query_execution_history 类工具）
  const inner = JSON.stringify({ ok: true, totalCount: 23, records: [{ id: "mu46", sessionId: "2f2f" }] });
  const formatted = extractJsonPayload(inner);
  assert.ok(formatted !== null, "合法 JSON 载荷必须解包");
  assert.ok(formatted.includes('"totalCount": 23'), "必须为缩进格式化文本");
  assert.ok(!formatted.includes('\\"'), "不得残留转义壳");
  // 引号包裹的序列化字符串再解一层
  const quoted = JSON.stringify(inner);
  assert.ok(extractJsonPayload(quoted) !== null, "引号包裹的序列化 JSON 必须再解一层");
  // 普通文本 / JSON 标量 / 截断 JSON → null（按原文显示）
  assert.equal(extractJsonPayload("Filesystem   Size"), null);
  assert.equal(extractJsonPayload("42"), null);
  assert.equal(extractJsonPayload('{"name": "abc'), null);
});

test("chat-model：humanizeEngineContent 应处理无 output 的形态二引擎块（UpdatePlan/write）", () => {
  // 形态二 A（UpdatePlan）：有 output 短文本 → 直显文本，JSON 壳剥离
  const planBlock = JSON.stringify({
    ok: true,
    name: "UpdatePlan",
    output: "Plan updated.",
    metadata: { plan: ["核对实现", "补齐测试"], explanation: "按需求逐项核对" },
  });
  const outA = humanizeEngineContent(`${planBlock}\n以上是计划更新。`);
  assert.ok(outA.includes("Plan updated."), "UpdatePlan 的 output 文本必须直显");
  assert.ok(outA.includes("以上是计划更新。"), "块外自然文本必须保留");
  assert.ok(!outA.includes('"ok"') && !outA.includes('"metadata"'), "UpdatePlan JSON 壳必须剥离");
  // 形态二 B（write）：无 output，信息全在 metadata → 格式化缩进显示（不再原样密集单行）
  const writeBlock = JSON.stringify({
    ok: true,
    name: "write",
    metadata: { type: "file_write", file_path: "/tmp/a.txt", bytesWritten: 128, diff_preview: "+hello" },
  });
  const outB = humanizeEngineContent(writeBlock);
  assert.ok(outB.includes('"file_path": "/tmp/a.txt"'), "write 块 metadata 必须格式化键值分行显示");
  assert.ok(outB.includes('"bytesWritten": 128'), "格式化后信息不丢");
  assert.ok(outB.includes("\n  "), "必须为缩进多行形态而非原始单行密集 JSON");
  // 非引擎形态的裸 JSON（缺 ok/name/metadata 指纹）仍原样保留，不被误伤
  const plain = '{"name": "myapp", "port": 8080}';
  assert.equal(humanizeEngineContent(plain), plain, "非引擎指纹 JSON 必须原样直通");
});

test("chat-model：humanizeEngineContent 应格式化双重序列化 output 并吸收失步残留", () => {
  // 真实缺陷形态（output 内嵌大 JSON 导致括号扫描失步后页面泄漏转义 JSON）：
  // query_execution_history 的 output 是序列化 JSON，其后紧跟其他工具块
  const innerPayload = JSON.stringify({ ok: true, totalCount: 2, records: [{ id: "a1" }, { id: "b2" }] });
  const block = JSON.stringify({ ok: true, name: "query_execution_history", output: innerPayload });
  const out = humanizeEngineContent(`${block}\n后续文本`);
  // 内层转义壳必须全部消除（\n 转义形态不得残留）
  assert.ok(!out.includes("\\n"), "不得残留转义换行壳");
  assert.ok(out.includes('"totalCount": 2'), "内层 JSON 必须格式化直显");
  assert.ok(out.includes("后续文本"), "块外自然文本必须保留");
});
