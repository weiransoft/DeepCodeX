/**
 * 「工具执行完成后页面全白」回归测试（2026-10-03 事故复盘）。
 *
 * 事故形态：长任务（大量 bash / write / edit 工具调用）执行完成后，
 * web 界面整个瞬间全白。React 18 无错误边界时，任何组件在渲染/提交阶段
 * 抛出未捕获异常都会导致整棵组件树被卸载——SPA 即整页白屏。
 *
 * 本测试以真实数据形态（非 mock）驱动渲染管线全链路：
 * 1. 引擎工具结果 JSON 块（含 output 内嵌引号/花括号/中文/超长输出等
 *    易触发解析边界的形态）→ humanizeEngineContent → parseMarkdownToA2ui
 *    → renderToString，断言零异常且内容不丢；
 * 2. 工具折叠条目（ToolEntry）实时 { event, item } 与历史 { content }
 *    两种 raw 形态真实 SSR 渲染零异常；
 * 3. 与工具条目同源（双写）的正文块移除路径渲染零异常。
 *
 * 运行方式：node --import tsx --test（经 run-tests.mjs 统一入口）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import { ChatPane } from "../web/src/components/ChatPane";
import type { ChatEntry } from "../web/src/chat-model";
import { humanizeEngineContent, setEngineToolEntryHint } from "../web/src/chat-model";
import { parseMarkdownToA2ui } from "../web/src/a2ui/parser";
import { A2uiSurface } from "../web/src/a2ui/renderer";

/**
 * 构造引擎 bash 工具结果 JSON 块（与 core 序列化形态一致）：
 * { ok, name, output, metadata }——output 故意含未转义观感的引号、嵌套
 * 花括号、ANSI 残留、超长行，覆盖括号平衡扫描与可读化的解析边界。
 */
function engineToolBlock(name: string, output: string): string {
  return JSON.stringify({
    ok: true,
    name,
    output,
    metadata: { exitCode: 0, truncated: false, timedOut: false },
  });
}

test("回归：助手正文含大量引擎工具结果块（bash 超长输出/嵌套 JSON/中文引号）渲染零异常", () => {
  // 真实形态模拟：引擎把多轮 bash 结果序列化拼进 assistant 正文
  const nastyOutputA =
    "npm run build\n" +
    "> deepcodex@0.4.3.1 build\n" +
    '{"level":"info","msg":"bundled ok {\\"entry\\":\\"src/main.tsx\\"}"}\n' +
    "bundle.css 128.4kb\n" +
    'warning: "useEffect" 未使用 —— 位置 src/App.tsx:12:5（注意：中文引号"测试"）';
  const nastyOutputB = "构建产物：dist/bundle.js（1.2MB）✓ 完成 {耗时 4.2s}\n下一行含未闭合花括号 {";
  const assistantContent = [
    engineToolBlock("bash", nastyOutputA),
    "",
    "构建通过，继续执行部署步骤：",
    "",
    engineToolBlock("bash", nastyOutputB),
    "",
    "```bash",
    "# 围栏内 JSON 原样保留",
    '{"fence": "必须原样"}',
    "```",
  ].join("\n");

  // 全链路：可读化 → A2UI 解析 → 真实 SSR 渲染，任何一步抛异常测试即失败
  const humanized = humanizeEngineContent(assistantContent);
  const html = renderToString(<A2uiSurface messages={parseMarkdownToA2ui(humanized, "msg-regression-1")} />);

  // 内容不丢：工具输出文本、自然文本、围栏文本全部呈现
  // 注意：SSR 输出中 JSX 文本节点按标记拆分为多段，断言必须用连续子串而非跨标记片段
  assert.ok(html.includes("npm run build"), "首块 output 必须渲染");
  assert.ok(html.includes("构建通过"), "块间自然文本必须保留");
  assert.ok(html.includes("围栏内 JSON 原样保留"), "围栏注释文本必须保留");
  assert.ok(html.includes("fence"), "围栏内 JSON 键名必须保留");
  assert.ok(html.includes("必须原样"), "围栏内 JSON 中文值必须保留");
  // 工具 JSON 外壳移除的判定必须用转义形态（React SSR 文本节点中引号被转义为 &quot;）
  assert.ok(!html.includes("&quot;ok&quot;"), "工具结果块的 JSON 外壳不应泄漏为可读正文");
});

test("回归：ChatPane 混合工具条目（实时 item 形态 + 历史 content 形态）整体 SSR 零异常", () => {
  const historyContent =
    engineToolBlock("bash", "git status --short\n M src/App.tsx") +
    "\n\n" +
    engineToolBlock("write", "已写入文件 src/utils/tty-guard.ts（142 行）");
  const entries: ChatEntry[] = [
    { kind: "user", id: "u1", text: "继续", attachments: [] },
    {
      kind: "tool",
      id: "tool-call-1",
      label: "bash",
      status: "completed",
      raw: {
        event: { chatId: "c", status: "running" },
        item: {
          toolCallId: "call-1",
          name: "bash",
          status: "completed",
          output: "git push origin main\nEverything up-to-date",
        },
      },
    },
    { kind: "tool", id: "h-1", label: "工具执行：bash", status: "completed", raw: { content: historyContent } },
    {
      kind: "tool",
      id: "tool-call-2",
      label: "edit",
      // 失败态（status=failed）：状态映射与失败输出同样不得崩溃
      status: "failed",
      raw: {
        event: { chatId: "c", status: "running" },
        item: { toolCallId: "call-2", name: "edit", status: "failed", output: "编辑冲突：文件已被外部修改 {{unclosed" },
      },
    },
    {
      kind: "assistant",
      id: "a1",
      content: humanizeEngineContent(engineToolBlock("bash", "done ✓")),
      preview: null,
      done: true,
    },
  ];

  const html = renderToString(
    <ChatPane
      entries={entries}
      streaming={false}
      chatTitle="回归会话"
      onDecide={() => undefined}
      onStop={() => undefined}
      onOpenFileDrawer={() => undefined}
      submittingPermIds={new Set()}
    />
  );

  // 各条目关键文本均呈现（无整块丢失 = 无组件级静默崩溃）
  assert.ok(html.includes("git push origin main"), "实时工具条目 output 必须渲染");
  assert.ok(html.includes("git status --short"), "历史混排条目首块 output 必须渲染");
  assert.ok(html.includes("已写入文件"), "历史混排条目第二块 output 必须渲染");
  assert.ok(html.includes("编辑冲突"), "失败态工具条目输出必须渲染");
  assert.ok(html.includes("done ✓"), "助手消息可读化文本必须渲染");
  assert.ok(html.includes("已完成"), "completed 状态必须映射为中文文案");
  assert.ok(html.includes("失败"), "failed 状态必须映射为中文文案");
});

test("回归：双写同源（工具条目承载 + 正文移除）全链路渲染零异常且不重复", () => {
  const block = engineToolBlock("bash", "rsync -avh src/ 已完成（12 files）");
  const entries: ChatEntry[] = [
    { kind: "tool", id: "h-2", label: "工具执行：bash", status: "completed", raw: { content: block } },
    { kind: "assistant", id: "a2", content: `${block}\n\n以上为同步结果。`, preview: null, done: true },
  ];
  const html = renderToString(
    <ChatPane
      entries={entries}
      streaming={false}
      chatTitle="双写回归"
      onDecide={() => undefined}
      onStop={() => undefined}
      onOpenFileDrawer={() => undefined}
      submittingPermIds={new Set()}
    />
  );
  // 工具折叠条目承载该块：output 呈现
  assert.ok(html.includes("rsync -avh"), "工具条目必须承载同源 output");
  // 正文同源块被移除：自然文本仍在
  assert.ok(html.includes("以上为同步结果。"), "正文自然文本必须保留");
  // 去重判定按渲染区段统计：折叠条目区（tool-entry-text）出现 1 次，
  // 「原始事件数据」次级折叠（tool-entry-raw）保留完整 JSON 属信息不丢设计，不计重
  const carryCount = (html.match(/tool-entry-text[^>]*>[^<]*rsync -avh/g) ?? []).length;
  assert.equal(carryCount, 1, "同源 output 文本在折叠条目正文区只渲染一次（双写去重）");
  // 助手正文区不得再出现该 JSON 外壳（同源块已被正文可读化移除；
  // 折叠条目的「原始事件数据」区保留完整 JSON 属信息不丢设计，不在判定区）
  const assistantZone = html.slice(html.indexOf("以上为同步结果"));
  assert.ok(!assistantZone.includes("&quot;ok&quot;"), "助手正文不得残留同源工具 JSON 块");
});

test("回归：humanizeEngineContent 纯函数极端输入（空串/孤立花括号/未闭合围栏）永不抛异常", () => {
  // 极端输入集合：解析器与可读化层在任何输入下都必须返回字符串而非抛出
  const cases: string[] = [
    "",
    "{",
    "}}}",
    '{"ok":true,"name":"bash"', // 截断块（流式中途形态）
    '```\n未闭合围栏 {"x":1}',
    String.raw`"\\\"嵌套转义\\\""`,
    engineToolBlock("bash", "x".repeat(200_000)), // 超长 output 性能与稳定性
  ];
  setEngineToolEntryHint([]);
  for (const input of cases) {
    const out = humanizeEngineContent(input);
    assert.equal(typeof out, "string", `输入必须返回字符串：${input.slice(0, 20)}`);
  }
});
