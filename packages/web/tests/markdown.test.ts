/**
 * 极简 Markdown 渲染器单测（web/markdown）
 *
 * 守三件事：
 * 1. **语法子集解析正确**：标题 / 列表 / 表格 / 强调 / 行内代码 / 水平线，
 *    覆盖 `eag/report-render.ts` 产出的确定性报告语法。
 * 2. **XSS 防线不破**：Markdown 里的 HTML 标签必须按纯文本展示，
 *    绝不产生 HTML 注入（本实现全程走 React 文本节点）。
 * 3. **不吞内容**：未支持的语法按纯文本回退，原文信息不丢。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, parseInline } from "../web/src/markdown";

test("M1：ATX 标题按层级解析", () => {
  const blocks = parseMarkdown("# 一级\n\n## 二级\n\n### 三级");
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], { kind: "heading", level: 1, text: "一级" });
  assert.deepEqual(blocks[1], { kind: "heading", level: 2, text: "二级" });
  assert.deepEqual(blocks[2], { kind: "heading", level: 3, text: "三级" });
});

test("M2：无序列表与有序列表", () => {
  const blocks = parseMarkdown("- 第一项\n- 第二项");
  assert.deepEqual(blocks[0], { kind: "list", ordered: false, items: ["第一项", "第二项"] });

  const ordered = parseMarkdown("1. 甲\n2. 乙");
  assert.deepEqual(ordered[0], { kind: "list", ordered: true, items: ["甲", "乙"] });
});

test("M3：表格解析（表头 + 分隔行 + 数据行）", () => {
  const blocks = parseMarkdown("| 规则 ID | 证据状态 |\n| --- | --- |\n| r1 | 已使用 |\n| r2 | 已配置 |");
  assert.equal(blocks.length, 1);
  const table = blocks[0];
  assert.equal(table.kind, "table");
  if (table.kind !== "table") return;
  assert.deepEqual(table.header, ["规则 ID", "证据状态"]);
  assert.deepEqual(table.rows, [
    ["r1", "已使用"],
    ["r2", "已配置"],
  ]);
});

test("M4：行内强调与行内代码", () => {
  const inline = parseInline("这是 **粗体** 和 *斜体* 还有 `code`");
  assert.deepEqual(inline, [
    { kind: "text", value: "这是 " },
    { kind: "strong", value: "粗体" },
    { kind: "text", value: " 和 " },
    { kind: "em", value: "斜体" },
    { kind: "text", value: " 还有 " },
    { kind: "code", value: "code" },
  ]);
});

test("M5：水平线与空行处理", () => {
  const blocks = parseMarkdown("上段\n\n---\n\n下段");
  assert.equal(blocks.length, 3);
  assert.equal(blocks[1].kind, "hr");
  assert.equal(blocks[2].kind, "paragraph");
});

test("M6：段落内的软换行合并为空格（不丢内容）", () => {
  const blocks = parseMarkdown("第一行\n第二行");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "paragraph");
  if (blocks[0].kind !== "paragraph") return;
  assert.equal(blocks[0].text, "第一行 第二行");
});

test("M7：HTML 标签按纯文本处理（XSS 防线——不产生 HTML 注入）", () => {
  const blocks = parseMarkdown("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
  const texts: string[] = [];
  for (const b of blocks) {
    if (b.kind === "paragraph") texts.push(b.text);
  }
  // 原文被保留为纯文本（渲染层由 React 文本节点转义）
  assert.ok(texts.some((t) => t.includes("<script>")));
  assert.ok(texts.some((t) => t.includes("<img src=x onerror=alert(1)>")));
});

test("M8：未闭合的强调符号不吞内容", () => {
  const inline = parseInline("未闭合的 **强调");
  assert.equal(inline.length, 1);
  assert.equal(inline[0].kind, "text");
  if (inline[0].kind !== "text") return;
  assert.equal(inline[0].value, "未闭合的 **强调");
});

test("M9：空输入返回空块数组", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("   \n\n  "), []);
});

test("M10：真实审计报告语法全覆盖（report-render.ts 产出形态）", () => {
  const report = [
    "# EAG 工作流审计报告",
    "",
    "- 生成时间：2026-11-04T00:00:00.000Z",
    "",
    "## 证据窗口",
    "",
    "2026-10-25 ~ 2026-11-01（7 天）",
    "",
    "## 规则使用证据",
    "",
    "| 规则 ID | 证据状态 | 使用次数 | 违规次数 |",
    "| --- | --- | --- | --- |",
    "| rule-a | exercised | 3 | 0 |",
    "",
    "## 重复工作流发现",
    "",
    "_（窗口内未发现跨会话重复工作流）_",
    "",
    "## 干预台账",
    "",
    "- 2026-11-01 f1（owner: me）预期效果：修复缺陷",
    "  - 追溯：verification=outcome-supported（verifiedAt 2026-11-02）",
    "",
    "## 结论",
    "",
    "整体通过。",
  ].join("\n");

  const blocks = parseMarkdown(report);
  const kinds = blocks.map((b) => b.kind);
  assert.ok(kinds.includes("heading"));
  assert.ok(kinds.includes("list"));
  assert.ok(kinds.includes("table"));
  assert.ok(kinds.includes("paragraph"));

  // 必备章节全部解析为二级标题
  const headings = blocks.filter((b) => b.kind === "heading").map((b) => (b.kind === "heading" ? b.text : ""));
  for (const section of ["证据窗口", "规则使用证据", "重复工作流发现", "干预台账", "结论"]) {
    assert.ok(headings.includes(section), `应解析出章节：${section}`);
  }

  // 表格数据行被解析（不是原文残留）
  const table = blocks.find((b) => b.kind === "table");
  assert.ok(table !== undefined);
  if (table === undefined || table.kind !== "table") return;
  assert.deepEqual(table.header, ["规则 ID", "证据状态", "使用次数", "违规次数"]);
  assert.equal(table.rows.length, 1);
});
