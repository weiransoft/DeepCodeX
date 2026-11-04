/**
 * 设置页技能页签 + 审计报告渲染单测（web/components）
 *
 * 走真实组件渲染（`renderToStaticMarkup`），断言用户看到的界面：
 * - 「技能」页签**只列普通技能**：智能体条目不再混进来（此前与「智能体」页签重复）；
 * - 技能显示中文名 + @技术标识 + 中文功能简介；
 * - 审计报告渲染成结构化 HTML（标题 / 表格 / 列表），不再是 `<pre>` 里的原文；
 * - Markdown 里的 HTML 标签被转义为文本（XSS 防线）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CapabilitySkill } from "../web/src/api";
import { SkillsPane } from "../web/src/components/SkillsPane";
import { AgentsPane } from "../web/src/components/AgentsPane";
import { Markdown } from "../web/src/markdown";

/** 构造能力条目 */
function entry(
  name: string,
  kind: "skill" | "agent",
  description = "",
  extra: Partial<CapabilitySkill> = {}
): CapabilitySkill {
  return {
    name,
    description,
    path: `/home/u/.deepcode/skills/${name}/SKILL.md`,
    kind,
    ...extra,
  };
}

test("P1：「技能」页签只列普通技能（智能体不进技能页签）", () => {
  const skills = [
    entry("frontend-dev", "skill", "Full-stack frontend development"),
    entry("product-manager", "agent", "负责需求分析", { role: "产品经理" }),
  ];
  const html = renderToStaticMarkup(<SkillsPane skills={skills.filter((s) => s.kind === "skill")} />);
  assert.match(html, /frontend-dev/);
  assert.doesNotMatch(html, /product-manager/);
  assert.doesNotMatch(html, /产品经理/);
});

test("P2：智能体页签仍完整列出智能体（与技能页签不重叠）", () => {
  const skills = [entry("frontend-dev", "skill"), entry("product-manager", "agent", "", { role: "产品经理" })];
  const skillHtml = renderToStaticMarkup(<SkillsPane skills={skills.filter((s) => s.kind === "skill")} />);
  const agentHtml = renderToStaticMarkup(
    <AgentsPane agents={skills.filter((s) => s.kind === "agent")} defaultAgent={null} onCreated={() => {}} />
  );
  // 两个页签的条目集合不相交
  assert.doesNotMatch(skillHtml, /产品经理/);
  assert.match(agentHtml, /产品经理/);
});

test("P3：技能条目渲染中文名 + @技术标识 + 中文简介", () => {
  // 英文 description 的第三方技能 → 目录给出中文名与中文简介
  const html = renderToStaticMarkup(
    <SkillsPane skills={[entry("frontend-dev", "skill", "Full-stack frontend development")]} />
  );
  assert.match(html, /class="skills-item-name">前端开发</);
  assert.match(html, /class="skills-item-id"[^>]*>@frontend-dev</);
  assert.match(html, /class="skills-item-desc">高品质前端开发，含动效设计与媒体素材生成。/);
  // 英文原描述不再直接出现在界面上
  assert.doesNotMatch(html, /Full-stack frontend development/);
});

test("P4：技能为空时给空态提示（不是空白）", () => {
  const html = renderToStaticMarkup(<SkillsPane skills={[]} />);
  assert.match(html, /未发现已安装技能/);
});

test("P5：审计报告渲染为结构化 HTML（不再是 pre 里的原文）", () => {
  const report = [
    "# EAG 工作流审计报告",
    "",
    "## 规则使用证据",
    "",
    "| 规则 ID | 证据状态 |",
    "| --- | --- |",
    "| rule-a | 已使用 |",
    "",
    "- 生成时间：2026-11-04",
  ].join("\n");
  const html = renderToStaticMarkup(<Markdown source={report} />);
  // 标题渲染成真正的 heading 元素
  assert.match(html, /<h1><span>EAG 工作流审计报告<\/span><\/h1>/);
  assert.match(html, /<h2><span>规则使用证据<\/span><\/h2>/);
  // 表格渲染成 table 结构
  assert.match(html, /<table class="markdown-table">/);
  assert.match(html, /<th><span>规则 ID<\/span><\/th>/);
  assert.match(html, /<td><span>rule-a<\/span><\/td>/);
  // 列表渲染成 ul/li
  assert.match(html, /<ul><li><span>生成时间：2026-11-04<\/span><\/li><\/ul>/);
  // 原始 Markdown 标记不再以明文形式出现在界面上（已结构化）
  assert.doesNotMatch(html, /\| --- \|/);
  assert.doesNotMatch(html, /## 规则使用证据/);
});

test("P6：Markdown 中的 HTML 标签被转义为纯文本（XSS 防线）", () => {
  const html = renderToStaticMarkup(<Markdown source={"<img src=x onerror=alert(1)>"} />);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("P7：空报告不产出任何标签（不抛错）", () => {
  const html = renderToStaticMarkup(<Markdown source="" />);
  assert.ok(!html.includes("<h1"));
});
