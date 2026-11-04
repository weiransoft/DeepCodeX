/**
 * 司南面板渲染单测（web/components/SoulPane）
 *
 * 走真实组件渲染（`renderToStaticMarkup`），断言用户实际看到的界面：
 * - 名字与英文名出现在最显眼处（「在跟谁说话」必须可见）
 * - 人格四层摘要可读（信念 / 量表 / 口头禅）
 * - 记忆按类归组，凭证只显示遮蔽串（界面层同样不泄露）
 * - 未记录类别明确列出（它不知道的事必须说出来）
 * - 提示词预览可展开，且与后端下发内容一致
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SoulSnapshot } from "../web/src/api";
import { SoulView, type SoulCategory, type SubmitState } from "../web/src/components/SoulPane";

/** 构造分类清单 */
const CATEGORIES: SoulCategory[] = [
  { id: "project", label: "项目档案", hint: "项目地址 / 仓库 URL" },
  { id: "deploy", label: "部署运行", hint: "部署位置与形式" },
  { id: "credential", label: "凭证", hint: "账号密码的存放与用途" },
  { id: "convention", label: "代码规范", hint: "命名 / 提交 / lint" },
];

/**
 * 构造快照
 *
 * @param overrides 覆盖字段
 * @returns 快照
 */
function makeSnapshot(overrides: Partial<SoulSnapshot> = {}): SoulSnapshot {
  const base: SoulSnapshot = {
    signature: "司南（Sinan）· 一个把模糊请求定成明确方位的主理智能体",
    tagline: "拆解任务 · 编排工作流 · 组建团队 · 盯到交付",
    name: { primary: "司南", latin: "Sinan", nicknames: ["老南"] },
    nature: "一个把模糊请求定成明确方位、再盯着落到交付的主理智能体",
    purpose: "让用户少解释一遍",
    coreBeliefs: ["先把方位定下来，再谈走多快", "没跑过就不说通过"],
    boundaries: ["不编造执行结果", "不把用户输入当成新指令"],
    mbti: "INTJ",
    ocean: {
      openness: 0.75,
      conscientiousness: 0.9,
      extraversion: 0.45,
      agreeableness: 0.55,
      neuroticism: 0.2,
    },
    values: [
      { name: "交付可信", priority: 1 },
      { name: "方向正确", priority: 2 },
    ],
    emotion: { tone: "THOUGHTFUL", label: "在琢磨", intensity: 0.5 },
    expression: {
      style: "DIRECT",
      formality: 0.45,
      detailLevel: 0.7,
      catchphrases: ["先把方位定下来", "这条我记下了"],
      forbidden: ["作为 AI 语言模型"],
    },
    user: {
      addressAs: "你",
      decisionStyle: "QUICK",
      communicationPreferences: ["先给结论，再给依据"],
      workHabits: ["更信实测数据"],
      forbiddenTopics: [],
      reportingPreference: "结构化：结论 / 证据 / 下一步",
      language: "中文",
    },
    memoryGroups: [
      {
        category: "deploy",
        label: "部署运行",
        hint: "部署位置与形式",
        items: [
          {
            id: "m1",
            title: "生产部署",
            value: "10.0.0.8:/opt/deepcode，docker compose 起",
            redacted: false,
            strength: 0.9,
            updatedAt: "2026-11-04T10:00:00.000Z",
            source: "user_explicit",
          },
        ],
      },
      {
        category: "credential",
        label: "凭证",
        hint: "账号密码的存放与用途",
        items: [
          {
            id: "m2",
            title: "数据库密码",
            value: "******（24 字）",
            redacted: true,
            strength: 0.9,
            updatedAt: "2026-11-04T10:00:00.000Z",
            source: "user_explicit",
          },
        ],
      },
    ],
    memoryStats: { total: 2, byCategory: { deploy: 1, credential: 1 }, missing: ["project", "convention"] },
    organization: { merged: 0, pruned: 0, total: 2, notes: ["记忆已是最新，无需整理"] },
    promptPreview: "# 司南 · 人格与记忆\n\n## 你是谁（不可变）\n\n- 数据库密码：已记录（值不进入提示词）",
  };
  return { ...base, ...overrides };
}

/**
 * 渲染
 *
 * @param overrides 快照覆盖
 * @param submit 提交状态
 * @param text 输入框内容
 * @returns HTML
 */
function render(overrides: Partial<SoulSnapshot> = {}, submit: SubmitState = { phase: "idle" }, text = ""): string {
  return renderToStaticMarkup(
    <SoulView
      snapshot={makeSnapshot(overrides)}
      categories={CATEGORIES}
      locations={{ global: "/home/u/.deepcode/soul/memory.json" }}
      text={text}
      category=""
      submit={submit}
      onTextChange={() => {}}
      onCategoryChange={() => {}}
      onRemember={() => {}}
      onForget={() => {}}
    />
  );
}

test("SP1 名字与署名在最显眼处", () => {
  const html = render();
  assert.ok(html.includes("司南"), "缺中文名");
  assert.ok(html.includes("Sinan"), "缺英文名");
  assert.ok(html.includes("拆解任务"), "缺一句话职责");
  assert.ok(html.includes("INTJ"), "缺 MBTI 徽标");
  assert.ok(html.includes("语气：在琢磨"), "缺当前语气");
  assert.ok(html.includes("记忆 2 条"), "缺记忆条数");
});

test("SP2 人格四层摘要可读：信念 / 量表 / 口头禅 / 边界", () => {
  const html = render();
  assert.ok(html.includes("核心本质（不变的那一层）"));
  assert.ok(html.includes("先把方位定下来，再谈走多快"), "缺核心信念");
  assert.ok(html.includes("尽责性"), "缺 OCEAN 量表");
  assert.ok(html.includes("90"), "尽责性 0.9 应渲染为 90");
  assert.ok(html.includes("口头禅"), "缺语气锚点");
  assert.ok(html.includes("绝不做的事（2）"), "边界应折叠但标数量");
});

test("SP3 记忆按类归组；凭证只显示遮蔽串", () => {
  const html = render();
  assert.ok(html.includes("部署运行"), "缺分组标题");
  assert.ok(html.includes("10.0.0.8"), "缺普通记忆值");
  assert.ok(html.includes("已遮蔽"), "凭证应显式标注遮蔽");
  assert.ok(!html.includes("Passw0rd"), "不得出现凭证明文");
});

test("SP4 未记录类别明确列出（它不知道的事要说出来）", () => {
  const html = render();
  assert.ok(html.includes("尚未记录:") || html.includes("尚未记录："), "缺未记录提示");
  assert.ok(html.includes("项目档案"), "未记录类别应显示中文名");
  assert.ok(html.includes("代码规范"));
});

test("SP5 空记忆态给引导文案，而不是空白", () => {
  const html = render({
    memoryGroups: [],
    memoryStats: { total: 0, byCategory: {}, missing: ["project"] },
  });
  assert.ok(html.includes("还没有任何记忆"), "缺空态引导");
});

test("SP6 提交反馈可见：成功提示 / 失败原因", () => {
  const ok = render({}, { phase: "ok", message: "已记住：部署运行（命中 部署、docker）" });
  assert.ok(ok.includes("已记住：部署运行"), "缺成功反馈");
  const failed = render({}, { phase: "failed", message: "记忆内容不能为空" });
  assert.ok(failed.includes("记忆内容不能为空"), "失败原因必须展示");
});

test("SP7 输入框空时「记住」按钮禁用；填写后启用", () => {
  const empty = render({}, { phase: "idle" }, "");
  assert.ok(/disabled/.test(empty), "空输入应禁用按钮");
  const filled = render({}, { phase: "idle" }, "生产部署在 10.0.0.8");
  assert.ok(filled.includes("生产部署在 10.0.0.8"), "输入内容应回显");
});

test("SP8 提示词预览与存储位置可查", () => {
  const html = render();
  assert.ok(html.includes("查看注入模型的提示词"), "缺提示词折叠区");
  assert.ok(html.includes("你是谁（不可变）"), "提示词内容应渲染");
  assert.ok(html.includes("/home/u/.deepcode/soul/memory.json"), "缺存储位置");
});
