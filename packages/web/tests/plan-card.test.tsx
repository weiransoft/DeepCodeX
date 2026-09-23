/**
 * 执行计划卡片（UpdatePlan → plan 条目）单测。
 *
 * 覆盖三层（无 mock，真实数据形态）：
 * 1. chat-model：extractPlanFromToolContent——历史 content 标准形态、退化顶层
 *    plan 形态、explanation 提取、失败块/非 UpdatePlan/空 plan 拒绝；
 * 2. chat-model：parsePlanTasks——复选框三态（[x]/[>]/[ ]）、有序/无序列表、
 *    嵌套缩进深度、非列表行忽略；
 * 3. 渲染层：PlanCard 经 renderToString 输出进度统计 / 任务行 / 完成态类名 /
 *    explanation 区块（真实组件渲染，非快照臆测）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { extractPlanFromToolContent, parsePlanTasks, type ChatEntry } from "../web/src/chat-model";
import { PlanCard } from "../web/src/components/ChatPane";

/** 计划条目构造（测试便捷：kind/id 固定，业务字段按需覆盖） */
function planEntry(plan: string, explanation?: string): Extract<ChatEntry, { kind: "plan" }> {
  return { kind: "plan", id: "plan-latest", plan, explanation };
}

/** 引擎 UpdatePlan 工具结果的标准序列化形态（与 core/handleUpdatePlanTool 一致） */
function engineUpdatePlanBlock(plan: string, explanation?: string): string {
  return JSON.stringify({
    ok: true,
    name: "UpdatePlan",
    output: "Plan updated.",
    metadata: { plan, ...(explanation ? { explanation } : {}) },
  });
}

test("plan：extractPlanFromToolContent 应提取 metadata.plan 与 explanation（历史标准形态）", () => {
  const content = engineUpdatePlanBlock("- [x] 梳理需求\n- [>] 编写解析器\n- [ ] 补齐单测", "按需求逐项核对");
  const payload = extractPlanFromToolContent(content);
  assert.ok(payload !== null, "标准形态必须提取出计划");
  assert.equal(payload.plan, "- [x] 梳理需求\n- [>] 编写解析器\n- [ ] 补齐单测");
  assert.equal(payload.explanation, "按需求逐项核对");
});

test("plan：extractPlanFromToolContent 应兼容 plan 直挂顶层的退化形态", () => {
  // 退化形态：metadata 丢失但 plan 在顶层（防御性兼容，信息不丢）
  const content = JSON.stringify({ ok: true, name: "UpdatePlan", plan: "1. 步骤一\n2. 步骤二" });
  const payload = extractPlanFromToolContent(content);
  assert.ok(payload !== null, "退化形态必须可提取");
  assert.equal(payload.plan, "1. 步骤一\n2. 步骤二");
  assert.equal(payload.explanation, undefined, "缺省 explanation 必须为 undefined");
});

test("plan：extractPlanFromToolContent 应拒绝失败块/非 UpdatePlan/空 plan", () => {
  // 失败块（ok=false）：执行失败无有效计划态
  const failed = JSON.stringify({ ok: false, name: "UpdatePlan", metadata: { plan: "- [ ] 任意" } });
  assert.equal(extractPlanFromToolContent(failed), null, "失败块不得出计划卡");
  // 非 UpdatePlan：bash 结果同带 plan 字段也不得误判
  const bash = JSON.stringify({ ok: true, name: "bash", output: "x", metadata: { plan: "- [ ] 任意" } });
  assert.equal(extractPlanFromToolContent(bash), null, "非 UpdatePlan 块必须拒绝");
  // 空 plan / 纯空白 plan
  assert.equal(extractPlanFromToolContent(engineUpdatePlanBlock("")), null);
  assert.equal(extractPlanFromToolContent(engineUpdatePlanBlock("   \n  ")), null);
  // 非 JSON / 截断 JSON
  assert.equal(extractPlanFromToolContent("Plan updated."), null);
  assert.equal(extractPlanFromToolContent('{"name": "UpdatePlan", "metadata": {"pl'), null);
});

test("plan：parsePlanTasks 应解析复选框三态 / 有序列表 / 嵌套深度并忽略非列表行", () => {
  const plan = [
    "## 实施计划",
    "- [x] 已完成任务",
    "  - [x] 嵌套已完成",
    "- [>] 进行中任务",
    "    - [ ] 深层待办",
    "- [ ] 待办任务",
    "- 无复选框的无序任务",
    "1. 有序任务一",
    "2. 有序任务二",
    "普通段落文本，不是任务行",
  ].join("\n");
  const tasks = parsePlanTasks(plan);
  assert.equal(tasks.length, 8, "标题与段落不得解析为任务行");
  const byText = new Map(tasks.map((t) => [t.text, t]));
  assert.equal(byText.get("已完成任务")?.status, "done");
  assert.equal(byText.get("嵌套已完成")?.status, "done");
  assert.equal(byText.get("嵌套已完成")?.depth, 1, "2 空格缩进 → depth 1");
  assert.equal(byText.get("进行中任务")?.status, "active");
  assert.equal(byText.get("深层待办")?.depth, 2, "4 空格缩进 → depth 2");
  assert.equal(byText.get("待办任务")?.status, "pending");
  assert.equal(byText.get("无复选框的无序任务")?.status, "pending", "无复选框按待办处理");
  assert.equal(byText.get("有序任务一")?.status, "pending", "有序列表行同样解析");
  assert.ok(!byText.has("普通段落文本，不是任务行"), "段落行不得混入任务清单");
});

test("plan：PlanCard 渲染任务清单、进度统计与当前步骤", () => {
  const html = renderToStaticMarkup(
    <PlanCard entry={planEntry("- [x] 梳理需求\n- [>] 编写渲染卡片\n- [ ] 补齐单测", "按需求逐项核对")} />
  );
  // 进度统计：1/3（done 数 / 总数）
  assert.ok(html.includes("1/3"), "必须渲染完成数/总数");
  // 当前步骤：进行中任务直接暴露在头部
  assert.ok(html.includes("编写渲染卡片"), "进行中任务必须可见");
  // 三态类名齐全
  assert.ok(html.includes("plan-task-done"), "done 任务类名");
  assert.ok(html.includes("plan-task-active"), "active 任务类名");
  assert.ok(html.includes("plan-task-pending"), "pending 任务类名");
  // explanation 区块展示
  assert.ok(html.includes("按需求逐项核对"), "explanation 必须展示");
  // 复选框标记符不得残留（已转图标）
  assert.ok(!html.includes("[x]") && !html.includes("[>]"), "标记符必须转为图标，不残留原文");
});

test("plan：PlanCard 全部完成时显示完成态进度", () => {
  const html = renderToStaticMarkup(<PlanCard entry={planEntry("- [x] 任务A\n- [x] 任务B")} />);
  assert.ok(html.includes("2/2"), "完成数=总数");
  assert.ok(html.includes("plan-card-progress-done"), "全完成必须加完成态类名");
  // 进度条 100%
  assert.ok(html.includes("width:100%") || html.includes("width: 100%"), "全完成进度条必须满宽");
});

test("plan：PlanCard 无列表行计划回退 A2UI 渲染（信息不丢）", () => {
  const html = renderToStaticMarkup(<PlanCard entry={planEntry("第一步先做调研\n第二步再实施")} />);
  // 兜底：整段进 A2UI（段落文本必须可见）
  assert.ok(html.includes("第一步先做调研"), "无列表行计划必须整段渲染");
  assert.ok(html.includes("data-a2ui-surface"), "兜底必须走 A2UI surface");
});

// ---------- 归并语义与 SSE 契约场景（复刻 App.tsx 归并纯逻辑 + 真实帧形状） ----------

/** 历史 DTO 形状（与 web/src/types.ts ChatMessageDto 对齐的最小字段集） */
interface HistoryDtoLike {
  id: string;
  role: string;
  content: string | null;
  visible?: boolean;
  meta?: Record<string, unknown> | null;
}

/**
 * convertHistory 的 plan 归并语义复刻（App.tsx 同构纯函数，仅测试用）：
 * role=tool 且 content 以 { 开头 → extractPlanFromToolContent → plan-latest
 * 条目（后到覆盖旧计划）；提取失败保持普通工具折叠条目。
 */
function mergeHistoryPlan(dtos: HistoryDtoLike[]): ChatEntry[] {
  const result: ChatEntry[] = [];
  for (const d of dtos) {
    if (d.visible === false) continue;
    const content = typeof d.content === "string" ? d.content : "";
    if (content === "") continue;
    if (d.role === "tool" && content.startsWith("{")) {
      const payload = extractPlanFromToolContent(content);
      if (payload !== null) {
        const withoutPlan = result.filter((x) => x.kind !== "plan");
        withoutPlan.push({ kind: "plan", id: "plan-latest", ...payload });
        result.length = 0;
        result.push(...withoutPlan);
        continue;
      }
    }
    if (d.role === "tool") {
      result.push({ kind: "tool", id: `h-${d.id}`, label: "工具执行", status: "completed", raw: { content } });
    } else if (d.role === "user") {
      result.push({ kind: "user", id: `h-${d.id}`, text: content, attachments: [] });
    } else {
      result.push({ kind: "assistant", id: `h-${d.id}`, content, preview: null, done: true });
    }
  }
  return result;
}

test("plan：历史多条 UpdatePlan 消息应归并为单一最新态卡片（引擎覆盖协议）", () => {
  const dtos: HistoryDtoLike[] = [
    { id: "1", role: "user", content: "帮我做个任务" },
    { id: "2", role: "tool", content: engineUpdatePlanBlock("- [ ] 步骤一\n- [ ] 步骤二", "初版计划") },
    { id: "3", role: "assistant", content: "先规划一下" },
    { id: "4", role: "tool", content: engineUpdatePlanBlock("- [x] 步骤一\n- [>] 步骤二", "步骤一完成") },
  ];
  const entries = mergeHistoryPlan(dtos);
  const planEntries = entries.filter((x) => x.kind === "plan");
  assert.equal(planEntries.length, 1, "多条 UpdatePlan 历史必须归并为单一最新态卡片");
  const plan = planEntries[0];
  assert.ok(plan.kind === "plan");
  assert.equal(plan.id, "plan-latest");
  assert.ok(plan.plan.includes("[x] 步骤一"), "必须取最新一次计划内容");
  assert.equal(plan.explanation, "步骤一完成", "必须取最新一次 explanation");
  // 非 plan 条目顺序保持（用户气泡 + 助手气泡都在）
  assert.deepEqual(
    entries.filter((x) => x.kind !== "plan").map((x) => x.kind),
    ["user", "assistant"]
  );
});

test("plan：非 UpdatePlan 工具历史消息不得生成计划卡（保持普通折叠条目）", () => {
  const bashBlock = JSON.stringify({ ok: true, name: "bash", output: "ok\n", metadata: { exitCode: 0 } });
  const entries = mergeHistoryPlan([{ id: "9", role: "tool", content: bashBlock }]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "tool", "普通工具结果必须仍按折叠条目归并");
});

test("plan：真实引擎 UpdatePlan 结果序列化经 SSE 字符串化后仍可提取（形状契约）", () => {
  // 引擎 appendToolMessages 中 tool 消息 content 为工具结果的 JSON 序列化；
  // SSE 桥接（session-pool onAssistantMessage）原样透传字符串——
  // 本用例固定「引擎结果 → 序列化 → 前端提取」的形状契约，防止协议漂移。
  const planMarkdown = ["## 实施计划", "- [x] chat-model 计划提取", "- [>] 计划卡片渲染", "- [ ] 场景测试补齐"].join(
    "\n"
  );
  const engineResult = {
    ok: true,
    name: "UpdatePlan",
    output: "Plan updated.",
    metadata: { plan: planMarkdown, explanation: "按用户任务拆解" },
  };
  // 引擎真实序列化形态（无缩进紧凑 JSON）
  const wireContent = JSON.stringify(engineResult);
  const payload = extractPlanFromToolContent(wireContent);
  assert.ok(payload !== null, "引擎标准结果序列化后必须可提取");
  assert.equal(payload.plan, planMarkdown, "计划 Markdown 必须逐字节还原（换行不丢）");
  assert.equal(payload.explanation, "按用户任务拆解");
  // 渲染层直接消费提取结果（进度 1/3 + 当前步骤）
  const html = renderToStaticMarkup(<PlanCard entry={{ kind: "plan", id: "plan-latest", ...payload }} />);
  assert.ok(html.includes("1/3"), "进度统计必须来自解析结果");
  assert.ok(html.includes("计划卡片渲染"), "进行中步骤必须可见");
});
