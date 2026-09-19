/**
 * ChatPane 页面渲染回归测试（真实 SSR，无 mock）。
 *
 * 目标：验证工具条目页面不再显示 JSON 壳（用户反馈回归防线）——
 * - 历史混排 content（多个 { ok, name, output, metadata } JSON 块 + 尾部自然文本）
 *   渲染为 output 文本直显，JSON 字段名（"ok"/"metadata"）不出现在展示正文；
 * - 异常 metadata 附加中文注记；无文本字段时回退 JSON；
 * - 原始事件数据收进次级折叠「原始事件数据」（信息不丢）；
 * - 历史工具条目标签为「工具执行：bash」而非 "{"。
 *
 * 运行方式：tests/scripts/run-chatpane-render-test.sh
 * （tsx loader 对 JSX 仅 classic 转译，故本文件经 esbuild --jsx=automatic
 *   打包为 CJS 后由 node 执行；HTML 转义说明：renderToString 输出中
 *   双引号转义为 &quot;，断言按转义后文本匹配。）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import { ChatPane } from "../../web/src/components/ChatPane";
import type { ChatEntry } from "../../web/src/chat-model";

/** 构造真实形态的历史混排 content：两个 bash 结果 JSON 块 + 尾部助手自然文本 */
function buildMixedContent(): string {
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
  return `${block1}\n${block2}\n--- 可读性测试 ---\nalternatives.log\n`;
}

/** ChatPane 最小真实 props（submittingPermIds 为空集合，无审批卡片提交中） */
function buildProps(entries: ChatEntry[]) {
  return {
    entries,
    streaming: false,
    chatTitle: "渲染测试会话",
    onDecide: () => undefined,
    onStop: () => undefined,
    onOpenFileDrawer: () => undefined,
    submittingPermIds: new Set<string>(),
  };
}

test("ChatPane：历史工具条目应渲染 output 文本且正文不含 JSON 壳", () => {
  const entries: ChatEntry[] = [
    { kind: "tool", id: "h-1", label: "工具执行：bash", status: "completed", raw: { content: buildMixedContent() } },
  ];
  // renderToString 输出 details 全部子节点，可静态断言正文内容
  const html = renderToString(<ChatPane {...buildProps(entries)} />);
  assert.ok(html.includes("Filesystem   Size  Used"), "df 表格 output 必须直显");
  assert.ok(html.includes("70G\t/home/hguser"), "du 输出必须直显");
  assert.ok(html.includes("--- 可读性测试 ---"), "块间自然文本必须保留");
  // JSON 壳不再出现在展示层：字段名经转义后为 &quot;ok&quot; 等
  assert.ok(!html.includes("&quot;ok&quot;"), "不得渲染 JSON 字段名 ok");
  assert.ok(!html.includes("&quot;metadata&quot;"), "不得渲染 JSON 字段名 metadata");
  assert.ok(!html.includes("&quot;exitCode&quot;"), "不得渲染 JSON 字段名 exitCode");
  // 原始事件数据次级折叠保留（信息不丢），折叠行标签为友好工具名
  assert.ok(html.includes("原始事件数据"), "必须保留原始数据折叠入口");
  assert.ok(html.includes("工具执行：bash"), "折叠行标签为友好工具名");
});

test("ChatPane：异常 metadata 应渲染中文注记", () => {
  const block = JSON.stringify({
    ok: false,
    name: "bash",
    output: "cat: /var/log/secure: Permission denied\n",
    metadata: { exitCode: 1, signal: null, truncated: true, timedOut: false },
  });
  const entries: ChatEntry[] = [
    { kind: "tool", id: "h-2", label: "工具执行：bash", status: "completed", raw: { content: block } },
  ];
  const html = renderToString(<ChatPane {...buildProps(entries)} />);
  assert.ok(html.includes("cat: /var/log/secure: Permission denied"), "错误 output 直显");
  assert.ok(html.includes("[退出码 1，输出已截断]"), "异常注记必须渲染");
});

test("ChatPane：无可读文本时应回退 JSON 渲染且仍有原始数据折叠", () => {
  const entries: ChatEntry[] = [
    {
      kind: "tool",
      id: "h-3",
      label: "工具执行",
      status: "processing",
      raw: { event: { chatId: "c1", status: "processing" } },
    },
  ];
  const html = renderToString(<ChatPane {...buildProps(entries)} />);
  // 回退形态：正文出现 JSON（事件级字段），次级折叠仍保留
  assert.ok(html.includes("&quot;chatId&quot;"), "回退形态应渲染原始 JSON");
  assert.ok(html.includes("原始事件数据"), "次级折叠仍保留");
});

test("ChatPane：助手消息正文中的引擎拼接 JSON 块应渲染为 output 文本", () => {
  // 真实形态：引擎 nonInteractive 把工具结果 JSON 拼进 assistant content
  const block = JSON.stringify({
    ok: true,
    name: "bash",
    output: "Filesystem   Size  Used\n/dev/vda2    2.0G  259M\n",
    metadata: { exitCode: 0 },
  });
  const entries: ChatEntry[] = [
    {
      kind: "assistant",
      id: "h-a9",
      content: `${block}\n/var/lib/docker 无权限读取，继续深挖可读区域：\n`,
      preview: null,
      done: true,
    },
  ];
  const html = renderToString(<ChatPane {...buildProps(entries)} />);
  assert.ok(html.includes("Filesystem   Size  Used"), "output 表格必须直显");
  assert.ok(html.includes("继续深挖可读区域"), "助手自然文本必须保留");
  // JSON 壳不得出现在助手消息正文
  assert.ok(!html.includes("&quot;ok&quot;"), "助手正文不得渲染 JSON 字段名 ok");
  assert.ok(!html.includes("&quot;metadata&quot;"), "助手正文不得渲染 JSON 字段名 metadata");
});

test("ChatPane：流式 preview 中的工具结果 JSON 同样可读化", () => {
  const block = JSON.stringify({ ok: true, name: "bash", output: "788M\t/var/log\n", metadata: { exitCode: 0 } });
  const entries: ChatEntry[] = [{ kind: "assistant", id: "h-a10", content: null, preview: `${block}\n`, done: false }];
  const html = renderToString(<ChatPane {...buildProps(entries)} />);
  assert.ok(html.includes("788M\t/var/log"), "流式 preview 的 output 必须直显");
  assert.ok(!html.includes("&quot;ok&quot;"), "流式 preview 不得渲染 JSON 壳");
});

test("ChatPane：双重序列化 output（转义 JSON）应格式化渲染且无转义壳泄漏", () => {
  // 真实缺陷形态：query_execution_history 的 output 本身是序列化 JSON，
  // 修复前页面直接显示 {\n \"ok\": true... 大片转义 JSON
  const innerPayload = JSON.stringify({ ok: true, totalCount: 55, records: [{ id: "mu6mxkqif38c" }] });
  const block = JSON.stringify({ ok: true, name: "query_execution_history", output: innerPayload });
  const entries: ChatEntry[] = [
    { kind: "assistant", id: "h-a11", content: `${block}\n检索完成，继续分析。`, preview: null, done: true },
  ];
  const html = renderToString(<ChatPane {...buildProps(entries)} />);
  // 转义壳（\n \" 形态经 HTML 转义后为 \\n &quot;）不得出现
  assert.ok(!html.includes("\\n"), "不得出现转义换行壳");
  assert.ok(html.includes("totalCount"), "内层 JSON 字段必须直显");
  assert.ok(html.includes("检索完成"), "自然文本必须保留");
});

test("ChatPane：用户/助手消息行与头像随工具条目正常共渲染", () => {
  const entries: ChatEntry[] = [
    { kind: "user", id: "h-u1", text: "查看磁盘占用", attachments: [], createTime: "2026-09-19T12:00:00.000Z" },
    {
      kind: "tool",
      id: "h-t1",
      label: "工具执行：bash",
      status: "completed",
      raw: { content: JSON.stringify({ ok: true, name: "bash", output: "788M\t/var/log\n" }) },
    },
    { kind: "assistant", id: "h-a1", content: "/var/log 占用 788M。", preview: null, done: true },
  ];
  const html = renderToString(<ChatPane {...buildProps(entries)} />);
  assert.ok(html.includes("查看磁盘占用"), "用户消息渲染");
  assert.ok(html.includes("788M\t/var/log"), "工具 output 文本渲染");
  assert.ok(html.includes("/var/log 占用 788M。"), "助手消息渲染");
  // 头像（SVG aria-label）随消息行出现
  assert.ok(html.includes('aria-label="DeepCodeX 助手"'), "助手机器头像渲染");
  assert.ok(html.includes('aria-label="用户"'), "用户头像渲染");
});
