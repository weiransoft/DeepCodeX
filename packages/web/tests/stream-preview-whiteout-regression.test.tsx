/**
 * 「思考/流式 bash 命令执行后页面白屏」回归测试（2026-10-04 事故复盘）。
 *
 * 事故形态：EAG-P5 自主循环执行期间，思考过程与 bash 命令输出经 llm_delta
 * 流式推送到前端；流式中途的累积文本含**未闭合**引擎工具 JSON 块
 * （bash 结果 { ok, name, output, ... 闭合 '}' 尚未到达），旧实现：
 * 1. thinking 通道完全不做可读化，裸 JSON 直接进 A2UI 管线；
 * 2. preview 通道 humanizeEngineContent 对未闭合残留原样透传；
 * 而助手正文经 `<div class="a2ui-surface">` 渲染且无 white-space 保留样式，
 * 换行折叠成整行巨块 → 超长文本渲染崩坏，页面白屏不显示。
 *
 * 本测试以真实流式中途形态（非 mock）验证修复：
 * 1. humanizeStreamPreview 对流式裸 JSON 前缀（闭合/未闭合）以占位符替代；
 * 2. thinking 通道经归一化后不再泄漏裸 JSON；
 * 3. ChatPane 流式态（含未闭合块的 thinking + preview）整体 SSR 零异常、
 *    可见文本不丢、无巨块裸 JSON。
 *
 * 运行方式：node --import tsx --test（经 run-tests.mjs 统一入口）。
 */
import "./jsx-runtime-shim";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import { ChatPane } from "../web/src/components/ChatPane";
import type { ChatEntry } from "../web/src/chat-model";
import { humanizeStreamPreview, setEngineToolEntryHint } from "../web/src/chat-model";

/**
 * 构造引擎工具结果 JSON 块（与 core 序列化形态一致）：
 * { ok, name, output, metadata }——用于模拟流式正文中的引擎双写块。
 */
function engineToolBlock(name: string, output: string): string {
  return JSON.stringify({
    ok: true,
    name,
    output,
    metadata: { exitCode: 0, truncated: false, timedOut: false },
  });
}

test("流式白屏回归：humanizeStreamPreview 对未闭合引擎块前缀必须以占位符替代", () => {
  setEngineToolEntryHint([]);
  // 真实流式中途形态：bash 结果块正在逐 token 拼进正文，闭合 '}' 未到
  const unterminated = '{"ok":true,"name":"bash","output":"npm run build\\n> deepcodex build\\n';
  const out = humanizeStreamPreview(unterminated);
  assert.ok(!out.includes("{"), "未闭合裸 JSON 不得以花括号起始泄漏为整行巨块");
  assert.ok(out.includes("流式输出中"), "未闭合块必须以占位符提示替代");
  // 整段以 '{' 起始的裸 JSON（无任何正文前缀）同样被占位保护
  const pure = '{"level":"info","msg":"bundled ok {\\"entry\\":\\"src/main.tsx\\"}';
  const out2 = humanizeStreamPreview(pure);
  assert.ok(!out2.includes("{"), "裸 JSON 巨块必须被占位符替代");
});

test("流式白屏回归：thinking 通道含引擎工具进度 JSON（闭合形态）可读化不泄漏 JSON 壳", () => {
  setEngineToolEntryHint([]);
  // EAG-P5 执行器进度经 thinkingText 通道推送：含工具结果混排 JSON 的累积文本
  const block = engineToolBlock("bash", "git status --short\n M src/App.tsx\n");
  const thinking = `先检查仓库状态：\n${block}\n确认变更范围后继续。`;
  const out = humanizeStreamPreview(thinking);
  assert.ok(out.includes("先检查仓库状态"), "思考文本前缀必须保留");
  assert.ok(out.includes("git status --short"), "闭合块 output 必须可读化直显");
  assert.ok(out.includes("确认变更范围"), "思考文本尾段必须保留");
  assert.ok(!out.includes("&quot;ok&quot;") && !out.includes('"ok":'), "工具 JSON 外壳不得泄漏");
});

test("流式白屏回归：ChatPane 流式态（未闭合 thinking/preview 巨块）SSR 零异常且内容不丢", () => {
  setEngineToolEntryHint([]);
  const unterminatedBig =
    '{"ok":true,"name":"bash","output":"' +
    "构建日志行A\n构建日志行B\n".repeat(500) + // 超长未闭合输出（真实 bash 大输出中途形态）
    '{"nested":{"deep":{"x":1}}}';
  const closedBlock = engineToolBlock("bash", "rsync -avh src/ 已完成（12 files）");
  const entries: ChatEntry[] = [
    { kind: "user", id: "u1", text: "部署到预发环境", attachments: [] },
    {
      kind: "assistant",
      id: "stream",
      content: null,
      preview: `开始同步产物：\n${closedBlock}`,
      thinking: `先分析改动面：\n${unterminatedBig}`,
      done: false,
    },
  ];
  const html = renderToString(
    <ChatPane
      entries={entries}
      streaming={true}
      chatTitle="白屏回归"
      onDecide={() => undefined}
      onStop={() => undefined}
      onOpenFileDrawer={() => undefined}
      submittingPermIds={new Set()}
    />
  );
  // 可见文本不丢
  assert.ok(html.includes("开始同步产物"), "preview 正文前缀必须渲染");
  assert.ok(html.includes("rsync -avh"), "闭合工具块 output 必须可读化渲染");
  assert.ok(html.includes("先分析改动面"), "thinking 文本前缀必须渲染");
  assert.ok(html.includes("思考过程"), "思考折叠区必须上屏");
  // 未闭合巨块 JSON 不得以裸文本形态出现在渲染结果中（超长裸 JSON 是白屏触发形态）
  assert.ok(!html.includes("&quot;nested&quot;"), "未闭合嵌套 JSON 巨块不得泄漏为正文");
  assert.ok(html.includes("流式输出中"), "未闭合块必须以占位符呈现");
});

test("流式白屏回归：humanizeStreamPreview 极端输入（空串/孤立花括号/纯正文）永不抛异常", () => {
  setEngineToolEntryHint([]);
  const cases: string[] = [
    "",
    "{",
    "}}}",
    "纯文本正文，无 JSON",
    '{"ok":true,"name":"bash"', // 截断块（流式起始形态）
    '```\n未闭合围栏 {"x":1}', // 围栏内 JSON：围栏语义保护，原样保留
    engineToolBlock("bash", "x".repeat(200_000)), // 超长闭合块（性能与稳定性）
  ];
  for (const input of cases) {
    const out = humanizeStreamPreview(input);
    assert.equal(typeof out, "string", `输入必须返回字符串：${input.slice(0, 20)}`);
  }
});
