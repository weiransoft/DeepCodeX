/**
 * 「thinking 结束后助手气泡空白」回归测试（2026-10-05 事故复盘）。
 *
 * 事故形态：本地 mlx 小模型轮次以「纯 thinking、正文零输出」收敛时，
 * 引擎把 content 为空的 assistant_message 广播并落盘（visible=true）。
 * 前端 ChatPane 对 content="" 的固化态走 AssistantA2ui 分支：
 * 空文本 → parseMarkdownToA2ui 产出空块 → A2UI 根 Column 零子节点 →
 * 气泡只剩一个不可见的空白容器——用户看到「thinking 过了，然后白屏」，
 * 且刷新后依然空白（历史恢复同样空）。
 *
 * 双重缺陷：
 * ① 渲染层（ChatPane 助手分支）：content 可读化后为空白时零渲染，
 *    无任何兜底提示；
 * ② 数据层（引擎/会话池）：空 content 的助手消息被持久化为可见消息
 *    （本测试仅覆盖前端渲染归因与修复，数据层留 TODO 注明）。
 *
 * 运行方式：node --import tsx --test（经 run-tests.mjs 统一入口）。
 */
import "./jsx-runtime-shim";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import { ChatPane } from "../web/src/components/ChatPane";
import type { ChatEntry } from "../web/src/chat-model";

/** 渲染对话面板并返回 HTML */
function renderPane(entries: ChatEntry[], streaming = false): string {
  return renderToString(
    <ChatPane
      entries={entries}
      streaming={streaming}
      chatTitle="回归会话"
      onDecide={() => undefined}
      onStop={() => undefined}
      onOpenFileDrawer={() => undefined}
      submittingPermIds={new Set()}
    />
  );
}

test("固化态回归：content 为空白的助手消息必须渲染兜底提示而非空白容器", () => {
  const entries: ChatEntry[] = [
    { kind: "user", id: "u1", text: "详细分析这个项目的架构，分五点说明", attachments: [], createTime: "" },
    // 引擎「纯 thinking 轮次」收敛后的固化消息：content 空字符串、visible=true
    { kind: "assistant", id: "h-empty", content: "", preview: null, done: true },
  ];
  const html = renderPane(entries);
  // 缺陷现场：仅有空 a2ui-surface/chat-assistant-body 容器，无任何可见文本
  const assistantRow = html.slice(html.indexOf("msg-row-assistant"));
  const visibleText = assistantRow
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  assert.ok(visibleText.length > 0, "空白助手消息渲染后零可见文本（白屏本体）：必须出现兜底提示文案");
  // 兜底文案要求明确告知「无正文输出」，而不是空白或含糊符号
  assert.match(visibleText, /无文|无回复|无输出|empty|空白/iu, `兜底提示语义不符：${visibleText.slice(0, 60)}`);
});

test("固化态回归：content 仅含工具双写块（条目同源）不得以裸 JSON 巨块呈现", () => {
  // 助手正文 = 与工具折叠条目同源的引擎块（引擎双写）。当前可读化基线：
  // 无正文前缀的纯引擎块原样保留（信息不丢），但裸 JSON 巨块是白屏/
  // 可读性事故形态——必须不出现未转义花括号起始的裸文本巨块。
  const engineBlock = JSON.stringify({
    ok: true,
    name: "bash",
    output: "file1\nfile2",
    metadata: { durationMs: 12 },
  });
  const entries: ChatEntry[] = [
    { kind: "user", id: "u1", text: "ls", attachments: [], createTime: "" },
    {
      kind: "tool",
      id: "t1",
      label: "工具执行：bash",
      status: "completed",
      raw: { content: engineBlock },
    },
    { kind: "assistant", id: "h-dual", content: engineBlock, preview: null, done: true },
  ];
  const html = renderPane(entries);
  const assistantSections = html.split("msg-row-assistant").length - 1;
  assert.equal(assistantSections, 1, "助手气泡应存在");
  const body = html.slice(html.lastIndexOf("msg-assistant-body-wrapper"));
  const visibleText = body
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  assert.ok(visibleText.length > 0, "双写块场景助手气泡零文本（白屏变体）");
  // 基线守护：渲染不得以未转义 '{' 起始的裸 JSON 文本形态泄漏外壳
  assert.ok(!visibleText.startsWith("{"), `引擎 JSON 外壳不得裸文本泄漏：${visibleText.slice(0, 40)}`);
});

test("正常固化态不受影响：有正文的助手消息照常渲染", () => {
  const entries: ChatEntry[] = [
    { kind: "user", id: "u1", text: "你好", attachments: [], createTime: "" },
    { kind: "assistant", id: "h-ok", content: "你好！我是 Deep Code。", preview: null, done: true },
  ];
  const html = renderPane(entries);
  assert.match(html, /你好！我是 Deep Code。/u);
  assert.doesNotMatch(html, /无文本回复|无回复|无输出/u, "正常消息不应出现兜底提示");
});

test("事故复现场景：thinking 流式结束后空 content 固化（浏览器实测形态）", () => {
  // 2026-10-05 内置浏览器复现的完整事故链路：
  // ① llm_delta 推 thinkingText → 流式条目 content=null + thinking 有值
  //    （ChatPane 渲染可折叠「思考过程」，用户看到 thinking 在动）；
  // ② 模型「纯 thinking 零正文」收敛 → assistant_message content=""
  //    → App.tsx 归并把 stream 条目升级为 { content: "", done: true }；
  // ③ ChatPane 助手分支走 AssistantA2ui：修复前空文本 → A2UI 零块 →
  //    气泡只剩空白容器，thinking 折叠区同时消失 → 「thinking 过后白屏」。
  // 修复后：固化空消息必须渲染 .assistant-empty-hint 兜底文案。
  const entries: ChatEntry[] = [
    { kind: "user", id: "u1", text: "你好", attachments: [], createTime: "" },
    // 归并后的固化态：与 App.tsx onAssistantMessage 中
    // `{ content: e.content, preview: null, done: true }` 完全同构
    { kind: "assistant", id: "msg-real-001", content: "", preview: null, done: true },
  ];
  const html = renderPane(entries);
  // 兜底文案必须在助手行内出现（修复前此处零可见文本 → 白屏）
  const assistantRow = html.slice(html.indexOf("msg-row-assistant"));
  const visibleText = assistantRow
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  assert.ok(visibleText.length > 0, "thinking 后空固化消息渲染零可见文本（白屏复现）");
  assert.match(assistantRow, /assistant-empty-hint/u, "必须命中空内容兜底分支");
  // 兜底文案须引导用户查看思考过程（与 trae 显示效果对齐：思考可见、正文有交代）
  assert.match(visibleText, /思考/u, `兜底文案应提示思考过程：${visibleText.slice(0, 60)}`);
  // 不得残留 A2UI 空 surface（兜底分支替换整个容器，杜绝零内容空白节点）
  assert.doesNotMatch(assistantRow, /chat-assistant-body/u, "空消息不应再渲染 A2UI 空容器");
});
