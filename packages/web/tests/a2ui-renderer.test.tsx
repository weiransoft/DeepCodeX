/**
 * A2UI Renderer（surface 状态机 + React 渲染）单元测试（设计文档 §5.1）。
 *
 * 运行方式：node --import tsx --test（经 packages/web/tests/run-tests.mjs 统一入口）；
 * JSX 转译配置见同目录 tsconfig.json（jsx: react-jsx，tsx 运行时读取）。
 * 测试策略：不使用任何 mock——
 * - 状态机断言直接调用真实 reduceSurface；
 * - 渲染断言用 react-dom/server 的 renderToString 做真实 SSR 渲染，
 *   覆盖 create/update/data/delete 顺序应用、DynamicString 取值、未知组件兜底、
 *   Chart 三型 SVG 生成与 XSS 转义。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import { parseMarkdownToA2ui } from "../web/src/a2ui/parser";
import { A2uiSurface, reduceSurface, resolveDynamicString } from "../web/src/a2ui/renderer";
import type { A2uiMessage, A2uiSurfaceState } from "../web/src/a2ui/types";

test("reduceSurface：begin → surfaceUpdate 按序应用（邻接表合并覆盖）", () => {
  const messages: A2uiMessage[] = [
    { beginRendering: { surfaceId: "s", root: "root" } },
    {
      surfaceUpdate: {
        surfaceId: "s",
        components: [
          { id: "root", component: { Column: { childIds: ["c1"] } } },
          { id: "c1", component: { Text: { text: "第一版" } } },
        ],
      },
    },
  ];
  const afterBegin = reduceSurface(messages.slice(0, 1));
  assert.equal(afterBegin.started, true);
  assert.equal(afterBegin.rootId, "root");
  assert.equal(afterBegin.components.size, 0, "begin 阶段尚无组件");

  const afterUpdate = reduceSurface(messages);
  assert.equal(afterUpdate.components.get("c1")?.component.Text?.text, "第一版");

  // 第二次 update：新 id 追加 + 同 id 覆盖（邻接表合并语义）
  const merged = reduceSurface([
    ...messages,
    {
      surfaceUpdate: {
        surfaceId: "s",
        components: [
          { id: "c1", component: { Text: { text: "覆盖版" } } },
          { id: "c2", component: { Text: { text: "新增" } } },
        ],
      },
    },
  ]);
  assert.equal(merged.components.get("c1")?.component.Text?.text, "覆盖版");
  assert.ok(merged.components.has("c2"));
  assert.equal(merged.components.size, 3);
});

test("reduceSurface：dataModelUpdate 浅合并（顶层键覆盖）→ deleteSurface 清空 → 再次 begin 重建", () => {
  const state1 = reduceSurface([
    { beginRendering: { surfaceId: "s", root: "root" } },
    { dataModelUpdate: { surfaceId: "s", contents: { a: 1, nested: { x: 1 } } } },
    // 顶层键覆盖：a 被覆盖为 2；nested 未提供则保留（浅合并语义）
    { dataModelUpdate: { surfaceId: "s", contents: { a: 2 } } },
  ]);
  assert.equal(state1.dataModel.a, 2);
  assert.deepEqual(state1.dataModel.nested, { x: 1 });

  // deleteSurface：回到未开始空状态
  const state3 = reduceSurface([
    { beginRendering: { surfaceId: "s", root: "root" } },
    { surfaceUpdate: { surfaceId: "s", components: [{ id: "c", component: { Text: { text: "x" } } }] } },
    { deleteSurface: { surfaceId: "s" } },
  ]);
  assert.equal(state3.started, false);
  assert.equal(state3.rootId, null);
  assert.equal(state3.components.size, 0);
  assert.deepEqual(state3.dataModel, {});

  // 再次 begin：等价于重建 surface（组件表已清空后重新累积）
  const state4 = reduceSurface([
    { beginRendering: { surfaceId: "s", root: "root" } },
    { surfaceUpdate: { surfaceId: "s", components: [{ id: "old", component: { Text: { text: "旧" } } }] } },
    { beginRendering: { surfaceId: "s", root: "root2" } },
  ]);
  assert.equal(state4.rootId, "root2");
  assert.equal(state4.components.size, 0, "重新 begin 必须清空旧组件");

  // 未知消息形态：防御性忽略（绝不抛异常）
  const state5 = reduceSurface([{ weird: true } as unknown as A2uiMessage]);
  assert.equal(state5.started, false);
});

test("resolveDynamicString：整串绑定命中/未命中、内嵌替换、数组下标、非字符串值", () => {
  const model = { user: { name: "小明", age: 42 }, rows: [{ name: "首行" }] };
  // 整串单路径：命中取值
  assert.equal(resolveDynamicString("${user.name}", model), "小明");
  // 非字符串原始值字符串化
  assert.equal(resolveDynamicString("${user.age}", model), "42");
  // 整串未命中：保留原始占位串
  assert.equal(resolveDynamicString("${user.missing}", model), "${user.missing}");
  // 内嵌绑定：逐个替换
  assert.equal(resolveDynamicString("共 ${user.age} 项 @ ${user.name}", model), "共 42 项 @ 小明");
  // 内嵌未命中的占位保持原文
  assert.equal(resolveDynamicString("值：${x.y}", model), "值：${x.y}");
  // 数组下标路径
  assert.equal(resolveDynamicString("${rows.0.name}", model), "首行");
  // 无绑定标记快速路径
  assert.equal(resolveDynamicString("纯文本", model), "纯文本");
});

test("renderToString：完整 Markdown 管线真实渲染（标题/代码块/表格），XSS 文本被转义", () => {
  const markdown = [
    "## 分析结果",
    "",
    "结论：<script>alert(1)</script>",
    "",
    "```ts",
    "const ok = true;",
    "```",
    "",
    "| 名称 | 数值 |",
    "| --- | --- |",
    "| 甲 | 12 |",
  ].join("\n");
  const html = renderToString(<A2uiSurface messages={parseMarkdownToA2ui(markdown, "msg-1")} />);

  // 标题真实渲染为 h2
  assert.ok(html.includes("<h2"), "标题必须渲染为 h2 元素");
  assert.ok(html.includes("分析结果"));
  // 代码块内容渲染
  assert.ok(html.includes("const ok = true;"));
  // 表格单元格渲染
  assert.ok(html.includes("甲") && html.includes("12"));
  // XSS 安全：script 标签绝不以可执行元素出现，而是实体转义的文本节点
  assert.ok(!html.includes("<script>"), "绝不允许出现可执行的 <script> 元素");
  assert.ok(html.includes("&lt;script&gt;"), "脚本文本必须以转义文本呈现");
});

test("renderToString：DynamicString 经 dataModelUpdate 取值；未绑定时保留原始占位", () => {
  const base = parseMarkdownToA2ui("当前用户：${user.name}", "msg-2");

  // 无数据模型：占位原样展示（不崩溃）
  const htmlNoModel = renderToString(<A2uiSurface messages={base} />);
  assert.ok(htmlNoModel.includes("${user.name}"), "未绑定的占位串必须原样展示");

  // 追加 dataModelUpdate：占位替换为真实值
  const withModel: A2uiMessage[] = [
    ...base,
    { dataModelUpdate: { surfaceId: "msg-2", contents: { user: { name: "小明" } } } },
  ];
  const html = renderToString(<A2uiSurface messages={withModel} />);
  assert.ok(html.includes("小明"), "绑定命中必须渲染真实值");
  assert.ok(!html.includes("${user.name}"), "命中后不得再出现占位串");
});

test("renderToString：未知组件语义等价兜底（角标 A2UI: <类型>），deleteSurface 后渲染空容器", () => {
  const messages: A2uiMessage[] = [
    { beginRendering: { surfaceId: "s", root: "root" } },
    {
      surfaceUpdate: {
        surfaceId: "s",
        components: [
          { id: "root", component: { Column: { childIds: ["w"] } } },
          { id: "w", component: { MyWidget: { title: "未知原语", value: 7 } } },
        ],
      },
    },
  ];
  // 不抛异常即为"不崩溃"；兜底必须带类型角标（信息不静默丢弃）
  const html = renderToString(<A2uiSurface messages={messages} />);
  // 注意：renderToString 会在相邻文本节点之间插入 <!-- --> 分隔注释，
  // 因此角标实际输出形如 "A2UI: <!-- -->MyWidget"，断言需兼容该分隔符
  assert.match(html, /A2UI:\s*(?:<!--\s*-->)?\s*MyWidget/, "兜底组件必须携带「A2UI: <类型>」角标");
  assert.ok(html.includes("未知原语"), "兜底组件应抽取文本属性展示（信息不丢失）");

  // 追加 deleteSurface：surface 销毁 → 渲染空容器（无 data-a2ui-surface 标记）
  const deleted: A2uiMessage[] = [...messages, { deleteSurface: { surfaceId: "s" } }];
  const htmlDeleted = renderToString(<A2uiSurface messages={deleted} />);
  assert.ok(!htmlDeleted.includes("data-a2ui-surface"), "销毁后不得再渲染组件树");
});

test("renderToString：Chart 三型（bar/line/pie）生成对应 SVG 图元节点", () => {
  const md = [
    "```chart",
    JSON.stringify({ type: "bar", title: "柱状", labels: ["一", "二"], series: [{ name: "A", data: [3, 5] }] }),
    "```",
    "",
    "```chart",
    JSON.stringify({ type: "line", labels: ["一", "二", "三"], series: [{ name: "B", data: [1, 4, 2] }] }),
    "```",
    "",
    "```chart",
    JSON.stringify({ type: "pie", labels: ["甲", "乙"], series: [{ name: "C", data: [3, 1] }] }),
    "```",
  ].join("\n");
  const html = renderToString(<A2uiSurface messages={parseMarkdownToA2ui(md, "msg-3")} />);

  // 三型图均有 SVG 画布
  assert.ok(html.includes("<svg"), "图表必须生成 SVG 画布");
  // 柱状图 → rect 图元；折线图 → polyline + circle 标记；饼图 → path 扇区
  assert.ok(html.includes("<rect"), "柱状图必须生成 <rect> 柱体");
  assert.ok(html.includes("<polyline"), "折线图必须生成 <polyline> 折线");
  assert.ok(html.includes("<circle"), "折线图必须生成 <circle> 数据点");
  assert.ok(html.includes("<path"), "饼图必须生成 <path> 扇区");
  // 图表标题与类目标签进入渲染树
  assert.ok(html.includes("柱状"));
});

/** 类型级自检：状态快照结构与类型契约一致（编译期即校验，运行时兜底断言） */
test("A2uiSurfaceState 快照：reduceSurface 为纯函数（不修改入参消息）", () => {
  const messages: A2uiMessage[] = [
    { beginRendering: { surfaceId: "s", root: "root" } },
    { surfaceUpdate: { surfaceId: "s", components: [{ id: "c", component: { Text: { text: "t" } } }] } },
  ];
  const snapshot: A2uiSurfaceState = reduceSurface(messages);
  const again: A2uiSurfaceState = reduceSurface(messages);
  // 两次归约结果等价（纯函数可复算）
  assert.equal(snapshot.started, again.started);
  assert.equal(snapshot.rootId, again.rootId);
  assert.equal(snapshot.components.get("c")?.component.Text?.text, again.components.get("c")?.component.Text?.text);
  // 入参消息未被修改（深比较序列化快照）
  assert.equal(
    JSON.stringify(messages),
    JSON.stringify([
      { beginRendering: { surfaceId: "s", root: "root" } },
      { surfaceUpdate: { surfaceId: "s", components: [{ id: "c", component: { Text: { text: "t" } } }] } },
    ])
  );
});
