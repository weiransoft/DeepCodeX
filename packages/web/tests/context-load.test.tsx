/**
 * 定义加载提示条（智能体 / 技能注入）单测。
 *
 * ## 背景
 *
 * 引擎把 `buildAgentPrompt` / `buildSkillPrompt` 的产出作为 system 消息注入会话
 * （`meta.skill` 记录来源）。那是**给模型的角色约束**——整份行为准则与红线清单，
 * 不是对话内容。此前 Web 把这类 system 消息当助手气泡渲染，用户看到的就是一大段
 * 「The following custom agent definition has been loaded…」+ 几千字定义。
 *
 * 覆盖三层（无 mock，真实数据形态）：
 * 1. chat-model：`parseContextLoadMeta` 的识别与拒绝（agent / skill / 缺字段 / 空名）；
 * 2. 渲染层：收起态只显示「已加载智能体 · 中文名 · @token」，定义原文收在折叠区；
 * 3. 搜索：只索引名称与 `@token`，定义原文不产生命中（避免几千字噪音灌进结果）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseContextLoadMeta, type ChatEntry } from "../web/src/chat-model";
import { buildSearchDocuments, searchDocuments } from "../web/src/search";
import { ChatPane } from "../web/src/components/ChatPane";

/**
 * 引擎注入的真实文本形态（core `AgentRegistry.buildAgentPrompt`）。
 * 用「Karpathy / Ponytail / R-01」这类定义独有的词做噪音隔离断言。
 */
const AGENT_RAW = [
  "The following custom agent definition has been loaded. Adopt its role identity and follow its behavioral constraints when handling the current task.",
  "",
  '<agent_content name="domain-digital-transformation" role="数字化转型顾问（企业数字化转型）">',
  "",
  "## 行为准则（Karpathy 四大核心原则，强制执行）",
  "",
  "1. Think Before Coding（三思而后行）",
  "2. Simplicity First（简单优先）",
  "",
  "## Ponytail 16 条不可简化红线（强制）",
  "",
  "- R-01 输入校验：所有外部输入必须 zod 验证",
  "- R-02 错误处理：try/catch 必须显式处理或向上层传播",
  "",
  "</agent_content>",
].join("\n");

/** 技能注入的文本形态（core `SkillManager.buildSkillPrompt`，用 <skill_content> 包裹） */
const SKILL_RAW = '<skill_content name="release-notes">\n## 步骤\n1. 收集 commit\n</skill_content>';

/** ChatPane 必填回调的测试桩（只验证渲染，不触发交互） */
function chatPaneProps(entries: ChatEntry[]): React.ComponentProps<typeof ChatPane> {
  return {
    chatTitle: "测试会话",
    entries,
    streaming: false,
    onOpenFileDrawer: () => {},
    onDecide: () => {},
    onStop: () => {},
    submittingPermIds: new Set<string>(),
  };
}

// ---------- 1. 识别 ----------

test("parseContextLoadMeta：识别智能体定义加载（kind / name / role）", () => {
  const info = parseContextLoadMeta({
    skill: {
      kind: "agent",
      name: "domain-digital-transformation",
      role: "数字化转型顾问（企业数字化转型）",
      isLoaded: true,
    },
  });
  assert.ok(info !== null, "agent 定义加载必须识别成功");
  assert.equal(info.source, "agent");
  assert.equal(info.name, "domain-digital-transformation");
  assert.equal(info.role, "数字化转型顾问（企业数字化转型）");
});

test("parseContextLoadMeta：识别技能加载（无 role）", () => {
  const info = parseContextLoadMeta({ skill: { kind: "skill", name: "release-notes" } });
  assert.ok(info !== null);
  assert.equal(info.source, "skill");
  assert.equal(info.name, "release-notes");
  assert.equal(info.role, undefined, "技能没有角色身份");
});

test("parseContextLoadMeta：非定义加载消息一律返回 null（不误吞正常 system 消息）", () => {
  // 缺 meta / meta 为 null / meta 无 skill 字段
  assert.equal(parseContextLoadMeta(undefined), null);
  assert.equal(parseContextLoadMeta(null), null);
  assert.equal(parseContextLoadMeta({}), null);
  // 别的 meta 通道（steering / 技能目录 / 智能体索引）不得被当定义加载
  assert.equal(parseContextLoadMeta({ steeringInject: true, steeringText: "补充一句" }), null);
  assert.equal(parseContextLoadMeta({ skillCatalog: [{ name: "x", description: "y" }] }), null);
  assert.equal(parseContextLoadMeta({ agentIndex: [{ name: "x", role: "y", description: "z" }] }), null);
  // skill 不是对象
  assert.equal(parseContextLoadMeta({ skill: "release-notes" }), null);
  assert.equal(parseContextLoadMeta({ skill: null }), null);
});

test("parseContextLoadMeta：name 缺失 / 空白 / 非字符串视为非定义加载", () => {
  assert.equal(parseContextLoadMeta({ skill: { kind: "agent" } }), null);
  assert.equal(parseContextLoadMeta({ skill: { kind: "agent", name: "   " } }), null);
  assert.equal(parseContextLoadMeta({ skill: { kind: "agent", name: 42 } }), null);
});

test("parseContextLoadMeta：role 空白串不产生 role 字段", () => {
  const info = parseContextLoadMeta({ skill: { kind: "agent", name: "code-reviewer", role: "  " } });
  assert.ok(info !== null);
  assert.equal(info.role, undefined);
  assert.equal("role" in info, false, "空 role 不应留下键（避免渲染出空名）");
});

// ---------- 2. 渲染 ----------

test("渲染：智能体注入收起态只显示中文名与 @token，定义原文不进可见区", () => {
  const html = renderToStaticMarkup(
    <ChatPane
      {...chatPaneProps([
        {
          kind: "contextLoad",
          id: "load-1",
          source: "agent",
          name: "domain-digital-transformation",
          role: "数字化转型顾问（企业数字化转型）",
          raw: AGENT_RAW,
        },
      ])}
    />
  );
  // 提示条存在
  assert.ok(html.includes("context-load"), "必须渲染定义加载提示条");
  assert.ok(html.includes("已加载智能体"), "必须标明这是智能体激活");
  // 中文名（括注含中文 → 原样保留）
  assert.ok(html.includes("数字化转型顾问（企业数字化转型）"), "必须显示中文角色身份");
  // 技术标识并存（用户后续要手敲 @token）
  assert.ok(html.includes("@domain-digital-transformation"), "必须显示 @ 技术标识");
  // 原文保留在折叠区（可展开查看，信息不丢）
  assert.ok(html.includes("行为准则"), "定义原文必须保留在折叠区");
  // 关键：原文不得出现在 summary（收起时唯一可见的那一行）
  const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(html)?.[1] ?? "";
  assert.ok(summary !== "", "提示条必须有 summary");
  assert.ok(!summary.includes("行为准则"), "收起态不得露出定义原文");
  assert.ok(!summary.includes("custom agent definition"), "收起态不得露出注入提示语");
});

test("渲染：技能注入显示「已加载技能」且不套用智能体名解析", () => {
  const html = renderToStaticMarkup(
    <ChatPane
      {...chatPaneProps([
        { kind: "contextLoad", id: "load-2", source: "skill", name: "release-notes", raw: SKILL_RAW },
      ])}
    />
  );
  assert.ok(html.includes("已加载技能"), "技能加载用「已加载技能」文案");
  assert.ok(!html.includes("已加载智能体"), "技能不得误标为智能体");
  assert.ok(html.includes("release-notes"), "显示技能技术标识");
});

test("渲染：多条加载提示条并存，顺序与 entries 一致", () => {
  const html = renderToStaticMarkup(
    <ChatPane
      {...chatPaneProps([
        {
          kind: "contextLoad",
          id: "load-a",
          source: "agent",
          name: "code-reviewer",
          role: "代码评审工程师",
          raw: AGENT_RAW,
        },
        { kind: "contextLoad", id: "load-b", source: "skill", name: "release-notes", raw: SKILL_RAW },
      ])}
    />
  );
  const first = html.indexOf("代码评审工程师");
  const second = html.indexOf("release-notes");
  assert.ok(first > 0 && second > 0, "两条提示条都要渲染");
  assert.ok(first < second, "顺序必须与 entries 一致");
});

// ---------- 3. 搜索 ----------

test("搜索：提示条只索引名称与 @token，定义原文不产生命中", () => {
  const entries: ChatEntry[] = [
    {
      kind: "contextLoad",
      id: "load-1",
      source: "agent",
      name: "domain-digital-transformation",
      role: "数字化转型顾问（企业数字化转型）",
      raw: AGENT_RAW,
    },
  ];
  const docs = buildSearchDocuments(entries);
  assert.equal(docs.length, 1, "一条提示条产出一条文档");
  assert.equal(docs[0].label, "已加载智能体");

  // 中文名与 token 可检索（用户记得「数字化转型顾问」或 @token）
  assert.equal(searchDocuments(docs, "数字化转型顾问").length, 1);
  assert.equal(searchDocuments(docs, "domain-digital-transformation").length, 1);

  // 定义正文里的词不命中——几千字的准则清单入索引会让每个常见词都灌满结果，
  // 与把定义折叠起来的初衷相悖
  assert.equal(searchDocuments(docs, "Karpathy").length, 0, "定义正文不得入索引");
  assert.equal(searchDocuments(docs, "Ponytail").length, 0, "定义正文不得入索引");
  assert.equal(searchDocuments(docs, "R-01").length, 0, "定义正文不得入索引");
});
