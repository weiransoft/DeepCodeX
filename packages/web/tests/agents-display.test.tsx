/**
 * 智能体展示名单测（web/components/AgentsPane + SedimentationCard）
 *
 * 走真实组件渲染（`renderToStaticMarkup`），断言用户看到的名字是中文：
 * - 有 `role` 的智能体显示中文名（剥纯英文括注），技术标识 `@name` 作为次要线索并存；
 * - 没有 `role` 的自建智能体回退技术标识，不出现空白名；
 * - 「默认智能体」提示把 settings 里的技术标识翻成中文名；
 * - 分组徽标、描述不与名称渲染互相挤掉（防回归）；
 * - 沉淀建议卡片的 Agent 草稿标题同样用中文角色身份（技术名保留在提示里）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CapabilitySkill } from "../web/src/api";
import type { SedimentationSuggestion } from "../web/src/chat-model";
import { AgentsPane } from "../web/src/components/AgentsPane";
import { SedimentationCard } from "../web/src/components/SedimentationCard";

/** 构造能力条目（path 参与 key，给每条唯一值） */
function agent(name: string, role?: string, group?: string, preset?: boolean): CapabilitySkill {
  return {
    name,
    description: `${name} 的说明`,
    path: `/home/u/.deepcode/skills/${name}/SKILL.md`,
    kind: "agent",
    ...(role !== undefined ? { role } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(preset === true ? { preset: true } : {}),
  };
}

/** 渲染页签（onCreated 不会被调用，给个空实现即可） */
function render(agents: CapabilitySkill[], defaultAgent: string | null = null): string {
  return renderToStaticMarkup(<AgentsPane agents={agents} defaultAgent={defaultAgent} onCreated={() => {}} />);
}

test("A1：预置智能体显示中文名（剥英文括注）+ @name 并存", () => {
  const html = render([agent("product-manager", "产品经理（Product Manager）", "core", true)]);
  // 中文名（英文括注已剥）
  assert.match(html, /class="agents-item-name">产品经理</);
  // 技术标识仍在（@ 提及要用户自己敲得出来）
  assert.match(html, /class="agents-item-id"[^>]*>@product-manager</);
  // 不出现「用英文名当标题」的旧渲染
  assert.doesNotMatch(html, /class="agents-item-name">product-manager</);
});

test("A2：中文括注保留（业务限定有信息量）", () => {
  const html = render([agent("domain-product-manager", "产品经理（业务需求分析）", "业务需求", true)]);
  assert.match(html, /class="agents-item-name">产品经理（业务需求分析）</);
  assert.match(html, /class="agents-item-group">业务需求</);
});

test("A3：无 role 的自建智能体回退技术标识，不回退成空白", () => {
  const html = render([agent("code-reviewer")]);
  assert.match(html, /class="agents-item-name">code-reviewer</);
  // 回退时标识仍然只出现一次，不重复渲染 @name
  assert.match(html, /class="agents-item-id"[^>]*>@code-reviewer</);
});

test("A4：默认智能体提示显示中文名", () => {
  const html = render([agent("product-manager", "产品经理（Product Manager）", "core", true)], "product-manager");
  assert.match(html, /默认智能体：<strong>产品经理<\/strong>/);
});

test("A5：默认智能体不在列表中时原样显示标识（不隐藏信息）", () => {
  const html = render([agent("code-reviewer")], "ghost-agent");
  assert.match(html, /默认智能体：<strong>ghost-agent<\/strong>/);
});

test("A6：预置与自建分区计数不受改名影响", () => {
  const html = render([
    agent("product-manager", "产品经理（Product Manager）", "core", true),
    agent("code-reviewer", "资深代码评审工程师"),
  ]);
  assert.match(html, /预置智能体（1）/);
  assert.match(html, /自建智能体（1）/);
  // 自建条目有 role 时同样显示中文
  assert.match(html, /class="agents-item-name">资深代码评审工程师</);
});

/** 构造沉淀建议（agent 草稿带 role；skill 草稿不带） */
function sedimentSuggestion(kind: "agent" | "skill", name: string, role?: string): SedimentationSuggestion {
  return {
    id: "s1",
    fingerprint: "fp-1",
    rationale: "对话里出现了可复用的评审流程",
    draft: {
      kind,
      name,
      description: "把评审要点固化为可复用能力",
      ...(role !== undefined ? { role } : {}),
      content: "- 逐条给出问题",
    },
  };
}

/** 渲染沉淀卡片 */
function renderCard(suggestion: SedimentationSuggestion): string {
  return renderToStaticMarkup(
    <SedimentationCard
      suggestions={[suggestion]}
      resolvedPaths={{}}
      submittingIds={new Set<string>()}
      onConfirm={() => {}}
      onDismiss={() => {}}
    />
  );
}

test("A7：沉淀建议的 Agent 草稿标题显示中文角色身份，技术名保留在 title 提示", () => {
  const html = renderCard(sedimentSuggestion("agent", "code-review-helper", "代码评审助手（Code Review Assistant）"));
  assert.match(html, /class="sediment-card-title"[^>]*>代码评审助手</);
  // 技术名不丢：仍在 title 属性里，且 Agent 徽标保留
  assert.match(html, /title="code-review-helper"/);
  assert.match(html, />Agent</);
});

test("A8：技能草稿仍显示原名（只有智能体才翻译）", () => {
  const html = renderCard(sedimentSuggestion("skill", "release-checklist"));
  assert.match(html, /class="sediment-card-title"[^>]*>release-checklist</);
  assert.match(html, />Skill</);
});
