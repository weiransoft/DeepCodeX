/**
 * A2UI Parser（Markdown → A2UI 消息流）单元测试（设计文档 §5.1）。
 *
 * 运行方式：node --import tsx --test（经 packages/web/tests/run-tests.mjs 统一入口）。
 * 测试策略：不使用任何 mock——直接调用真实解析函数，对产出的标准 A2UI v0.8
 * 消息序列（beginRendering + surfaceUpdate）做结构断言。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isTableSeparatorRow,
  parseChartSpec,
  parseMarkdownBlocks,
  parseMarkdownToA2ui,
  splitTableRow,
} from "../web/src/a2ui/parser";
import type { A2uiMessage, A2uiComponent, A2uiSurfaceUpdateMessage } from "../web/src/a2ui/types";

/** 提取消息序列中的 surfaceUpdate 消息（解析器恒产出恰好一条） */
function findUpdate(messages: A2uiMessage[]): A2uiSurfaceUpdateMessage {
  const found = messages.find((m): m is A2uiSurfaceUpdateMessage => "surfaceUpdate" in m);
  assert.ok(found, "消息序列中必须存在 surfaceUpdate");
  return found;
}

/** 组件判别：取组件的单键类型名与属性对象 */
function typeOf(c: A2uiComponent): { type: string; props: Record<string, unknown> } {
  const entries = Object.entries(c.component);
  const [type, props] = entries[0] ?? ["", {}];
  return { type, props: (props ?? {}) as Record<string, unknown> };
}

test("parseMarkdownToA2ui：产出 beginRendering + surfaceUpdate 两条标准消息，根为 root Column", () => {
  const messages = parseMarkdownToA2ui("# 标题\n\n正文", "surface-1");

  // 消息数量与顺序：先声明 surface，再全量提交组件
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { beginRendering: { surfaceId: "surface-1", root: "root" } });

  // 根组件：id="root" 的 Column，childIds 依序引用两个块
  const update = findUpdate(messages);
  const root = update.surfaceUpdate.components.find((c) => c.id === "root");
  assert.ok(root, "必须存在 id=root 的组件");
  const rootInfo = typeOf(root);
  assert.equal(rootInfo.type, "Column");
  const childIds = rootInfo.props.childIds as string[];
  assert.equal(childIds.length, 2);
  // 顶层块组件 id 均在 components 表中（邻接表完整性）
  for (const id of childIds) {
    assert.ok(
      update.surfaceUpdate.components.some((c) => c.id === id),
      `组件 ${id} 必须已登记`
    );
  }
});

test("parseMarkdownBlocks：标题 / 段落 / 引用 / 分隔线分块正确", () => {
  const blocks = parseMarkdownBlocks("# 大标题\n\n段落第一行\n段落第二行\n> 引用内容\n\n---");
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["heading", "paragraph", "quote", "divider"]
  );
  // 标题级别与文本
  const heading = blocks[0];
  assert.ok(heading.kind === "heading");
  assert.equal(heading.level, 1);
  assert.equal(heading.text, "大标题");
  // 段落保留换行（聊天场景多行合并）
  const para = blocks[1];
  assert.ok(para.kind === "paragraph");
  assert.equal(para.text, "段落第一行\n段落第二行");
  // 引用去前缀
  const quote = blocks[2];
  assert.ok(quote.kind === "quote");
  assert.equal(quote.text, "引用内容");
});

test("代码块 → Card(标题=语言, 复制动作) + Text(monospace)", () => {
  const messages = parseMarkdownToA2ui("```ts\nconst a = 1;\n```", "s");
  const components = findUpdate(messages).surfaceUpdate.components;
  const card = components.map(typeOf).find((t) => t.type === "Card");
  assert.ok(card, "必须产出 Card 组件");
  assert.equal(card.props.title, "ts");
  // 标题栏动作：复制按钮携带完整代码文本
  const action = card.props.headerAction as { type: string; text?: string };
  assert.equal(action.type, "copy");
  assert.equal(action.text, "const a = 1;");
  // 卡片子组件为等宽 Text
  const textIds = card.props.childIds as string[];
  const inner = components.find((c) => c.id === textIds[0]);
  assert.ok(inner);
  const innerInfo = typeOf(inner);
  assert.equal(innerInfo.type, "Text");
  assert.equal(innerInfo.props.variant, "monospace");
  assert.equal(innerInfo.props.text, "const a = 1;");
});

test("表格 → List + Row/Column/Text 结构（表头 Text bold=true，竖线转义还原）", () => {
  const messages = parseMarkdownToA2ui("| 名称 | 说明 |\n| --- | --- |\n| a\\|b | 正文 |", "s");
  const components = findUpdate(messages).surfaceUpdate.components;
  const listComp = components.map(typeOf).find((t) => t.type === "List");
  assert.ok(listComp, "必须产出 List 组件");

  // 表头行与数据行
  const rowIds = listComp.props.childIds as string[];
  assert.equal(rowIds.length, 2, "表头 + 1 条数据行");

  const collectCellTexts = (rowId: string): { text: string; bold: boolean | undefined }[] => {
    const row = components.find((c) => c.id === rowId);
    assert.ok(row);
    const rowInfo = typeOf(row);
    assert.equal(rowInfo.type, "Row");
    return (rowInfo.props.childIds as string[]).map((colId) => {
      const col = components.find((c) => c.id === colId);
      assert.ok(col);
      const colInfo = typeOf(col);
      assert.equal(colInfo.type, "Column");
      const textId = (colInfo.props.childIds as string[])[0];
      const textComp = components.find((c) => c.id === textId);
      assert.ok(textComp);
      const textInfo = typeOf(textComp);
      assert.equal(textInfo.type, "Text");
      return { text: textInfo.props.text as string, bold: textInfo.props.bold as boolean | undefined };
    });
  };

  // 表头加粗
  const headerCells = collectCellTexts(rowIds[0]);
  assert.deepEqual(
    headerCells.map((c) => c.text),
    ["名称", "说明"]
  );
  assert.ok(
    headerCells.every((c) => c.bold === true),
    "表头 Text 必须 bold=true"
  );

  // 数据行不加粗；"\|" 转义还原为字面管道符
  const dataCells = collectCellTexts(rowIds[1]);
  assert.equal(dataCells[0].text, "a|b");
  assert.equal(dataCells[1].text, "正文");
  assert.ok(dataCells.every((c) => c.bold !== true));
});

test("表格分隔行识别与单元格拆分（splitTableRow / isTableSeparatorRow）", () => {
  assert.ok(isTableSeparatorRow("| --- | :---: |"));
  assert.ok(!isTableSeparatorRow("| a | b |"));
  assert.deepEqual(splitTableRow("| a | b |"), ["a", "b"]);
  assert.deepEqual(splitTableRow("a \\| b | c"), ["a | b", "c"]);
});

test("chart 围栏：合法 JSON → Chart 组件（规格内嵌）", () => {
  const spec = { type: "bar", title: "销量", labels: ["一月", "二月"], series: [{ name: "A", data: [1, 2] }] };
  const messages = parseMarkdownToA2ui("```chart\n" + JSON.stringify(spec) + "\n```", "s");
  const chartComp = findUpdate(messages)
    .surfaceUpdate.components.map(typeOf)
    .find((t) => t.type === "Chart");
  assert.ok(chartComp, "必须产出 Chart 组件");
  const chart = chartComp.props.chart as {
    type: string;
    title?: string;
    labels?: string[];
    series: { name?: string; data: number[] }[];
  };
  assert.equal(chart.type, "bar");
  assert.equal(chart.title, "销量");
  assert.deepEqual(chart.series[0].data, [1, 2]);
});

test("畸形 chart JSON 兜底为普通代码块（不崩溃、不丢内容）", () => {
  // 用例 1：非 JSON 文本
  const m1 = parseMarkdownToA2ui("```chart\n这不是 JSON{\n```", "s1");
  const card1 = findUpdate(m1)
    .surfaceUpdate.components.map(typeOf)
    .find((t) => t.type === "Card");
  assert.ok(card1, "畸形 chart 必须兜底为 Card 代码块");
  assert.equal(card1.props.title, "chart", "兜底代码块语言名标为 chart");

  // 用例 2：合法 JSON 但缺 series（校验失败）
  const m2 = parseMarkdownToA2ui('```chart\n{"type":"bar"}\n```', "s2");
  const card2 = findUpdate(m2)
    .surfaceUpdate.components.map(typeOf)
    .find((t) => t.type === "Card");
  assert.ok(card2, "缺 series 的 chart 必须兜底为 Card 代码块");
  // 原文完整保留在代码块中（信息不丢失）
  const textId = (card2.props.childIds as string[])[0];
  const textComp = findUpdate(m2).surfaceUpdate.components.find((c) => c.id === textId);
  assert.ok(textComp);
  assert.equal(typeOf(textComp).props.text, '{"type":"bar"}');

  // 用例 3：type 非法
  assert.equal(parseChartSpec('{"type":"radar","series":[{"data":[1]}]}'), null);
});

test("图片独立成行 → Image 组件；行内图片保持为段落文本", () => {
  const messages = parseMarkdownToA2ui("![替代文本](https://example.com/a.png)", "s");
  const img = findUpdate(messages)
    .surfaceUpdate.components.map(typeOf)
    .find((t) => t.type === "Image");
  assert.ok(img, "独立成行的图片必须产出 Image 组件");
  assert.equal(img.props.url, "https://example.com/a.png");
  assert.equal(img.props.alt, "替代文本");

  // 行内图片不拆块：整段按段落文本保留
  const m2 = parseMarkdownToA2ui("看这张 ![x](https://e.com/b.png) 好图", "s2");
  const types = findUpdate(m2).surfaceUpdate.components.map((c) => typeOf(c).type);
  assert.ok(!types.includes("Image"), "行内图片不得拆为 Image 组件");
  assert.ok(types.includes("Text"));
});

test("XSS 载荷：解析器不产生 HTML 组件路径，脚本文本原样保留（由渲染层转义）", () => {
  // 注：图片 URL 选用不含括号的 javascript:x——Markdown 图片语法本身
  // （url 段 [^)\s]+）无法匹配含 ")" 的地址，含括号载荷会按段落文本处理，
  // 那条路径由"行内图片不得拆为 Image 组件"用例覆盖。
  const xss = "<script>alert(1)</script>";
  const messages = parseMarkdownToA2ui(`${xss}\n\n![x](javascript:x)`, "s");
  const components = findUpdate(messages).surfaceUpdate.components;

  // 组件类型白名单：不存在任何 html/script 之类的注入型组件
  const allowed = new Set(["Text", "Heading", "Card", "Row", "Column", "List", "Divider", "Image", "Button", "Chart"]);
  for (const c of components) {
    assert.ok(allowed.has(typeOf(c).type), `组件类型 ${typeOf(c).type} 超出白名单，存在注入路径`);
  }

  // 脚本文本仅作为 Text 的字面内容存在（渲染层以 React 文本节点转义呈现）
  const textComps = components.map(typeOf).filter((t) => t.type === "Text");
  assert.ok(
    textComps.some((t) => t.props.text === xss),
    "脚本文本必须原样保留在 Text 中"
  );

  // javascript: 协议图片 url 原样进入 Image.url（协议白名单拒绝渲染由渲染层负责，解析不丢失信息）
  const img = components.map(typeOf).find((t) => t.type === "Image");
  assert.ok(img);
  assert.equal(img.props.url, "javascript:x");
});
