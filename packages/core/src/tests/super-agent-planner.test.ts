/**
 * 计划层测试 —— 动态分解 / 校验降级 / 波次划分 / 身份
 *
 * 覆盖：
 * - P1 合法计划解析（字段归一、团队成员按角色聚合）
 * - P2 代码块包裹 / 前后缀干扰下仍能取出 JSON
 * - P3 角色不在注册表 → 回落 + 告警（不静默）
 * - P4 依赖引用不存在 / 自依赖 → 移除 + 告警
 * - P5 循环依赖 → 拒绝（不允许把环带进执行）
 * - P6 步骤超上限 → 截断 + 告警
 * - P7 结构不可用 → 拒绝，由调用方降级
 * - P8 降级单步计划（旧语义等价）
 * - P9 波次分层：同层并行、跨层串行、顺序稳定
 * - P10 可派工判定：只有前置全部完成的步骤才能派
 * - P11 无模型凭据 → 计划器降级（不抛错）
 * - P12 身份：名字 / 署名 / 人格前导
 *
 * @module tests/super-agent-planner
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { SUPER_AGENT_IDENTITY, buildIdentityPreamble, superAgentSignature } from "../super-agent/identity.js";
import {
  buildFallbackPlan,
  extractPlanJsonObject,
  parsePlan,
  renderPlan,
  FALLBACK_ROLE,
} from "../super-agent/planner/parse.js";
import { LlmWorkflowPlanner, NullPlanner, StaticPlanner } from "../super-agent/planner/planner.js";
import { findBlockedSteps, findRunnableSteps, isPlanComplete, planWaves } from "../super-agent/planner/waves.js";
import type { PlanStep, WorkPlan } from "../super-agent/planner/types.js";

/** 解析选项（角色取真实注册表的 5 个） */
const OPTIONS = {
  objective: "修复登录崩溃并补回归测试",
  createdAt: "2026-11-04T00:00:00.000Z",
  allowedRoles: ["product-manager", "architect", "solo-coder", "test-expert", "ui-designer"],
  roleNames: { "solo-coder": "独立开发者", architect: "架构师", "test-expert": "测试专家" },
} as const;

/**
 * 构造合法计划的 JSON 文本
 *
 * @returns JSON 字符串
 */
function validPlanJson(): string {
  return JSON.stringify({
    version: 1,
    objective: "修复登录崩溃",
    strategy: "先定位再修复最后回归",
    steps: [
      { id: "s1", title: "定位崩溃点", role: "architect", dependsOn: [], deliverable: "崩溃根因说明" },
      { id: "s2", title: "修复实现", role: "solo-coder", dependsOn: ["s1"], deliverable: "补丁" },
      { id: "s3", title: "补回归测试", role: "test-expert", dependsOn: ["s2"], deliverable: "测试用例" },
    ],
  });
}

// ============================================================================
// P1–P8：解析与校验
// ============================================================================

test("P1 合法计划：字段归一 + 团队按角色聚合", () => {
  const result = parsePlan(validPlanJson(), OPTIONS);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.steps.length, 3);
  assert.equal(result.plan.source, "llm");
  assert.equal(result.plan.objective, "修复登录崩溃");
  assert.deepEqual(result.plan.warnings, []);
  assert.deepEqual(
    result.plan.team.map((member) => member.role),
    ["architect", "solo-coder", "test-expert"]
  );
  assert.equal(result.plan.team[0]?.name, "架构师");
  assert.deepEqual(result.plan.team[1]?.stepIds, ["s2"]);
});

test("P2 代码块与前后缀：仍能取出 JSON 对象", () => {
  const wrapped = `这是计划：\n\`\`\`json\n${validPlanJson()}\n\`\`\`\n以上。`;
  const json = extractPlanJsonObject(wrapped);
  assert.ok(json !== null);
  const result = parsePlan(wrapped, OPTIONS);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.plan.steps[2]?.id, "s3");
});

test("P3 角色不在注册表：回落 solo-coder 并写告警", () => {
  const raw = JSON.stringify({
    steps: [{ id: "s1", title: "写代码", role: "hacker", dependsOn: [] }],
  });
  const result = parsePlan(raw, OPTIONS);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.steps[0]?.role, FALLBACK_ROLE);
  assert.ok(result.plan.warnings.some((warning) => warning.includes("不在注册表")));
});

test("P4 依赖不存在 / 自依赖：移除并写告警", () => {
  const raw = JSON.stringify({
    steps: [
      { id: "s1", title: "第一步", role: "architect", dependsOn: ["s1", "s9"] },
      { id: "s2", title: "第二步", role: "solo-coder", dependsOn: ["s1"] },
    ],
  });
  const result = parsePlan(raw, OPTIONS);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.plan.steps[0]?.dependsOn, []);
  assert.equal(result.plan.warnings.length, 2);
  assert.ok(result.plan.warnings.some((warning) => warning.includes("依赖自身")));
  assert.ok(result.plan.warnings.some((warning) => warning.includes("不存在的步骤")));
});

test("P5 循环依赖：拒绝整份计划", () => {
  const raw = JSON.stringify({
    steps: [
      { id: "s1", title: "A", role: "architect", dependsOn: ["s2"] },
      { id: "s2", title: "B", role: "solo-coder", dependsOn: ["s1"] },
    ],
  });
  const result = parsePlan(raw, OPTIONS);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /循环依赖/);
});

test("P6 步骤超上限：截断并写告警", () => {
  const steps = Array.from({ length: 10 }, (_, index) => ({
    id: `s${index + 1}`,
    title: `步骤 ${index + 1}`,
    role: "solo-coder",
    dependsOn: index === 0 ? [] : [`s${index}`],
  }));
  const result = parsePlan(JSON.stringify({ steps }), { ...OPTIONS, maxSteps: 8 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.steps.length, 8);
  assert.ok(result.plan.warnings.some((warning) => warning.includes("超过上限")));
});

test("P7 结构不可用：steps 缺失 / 非 JSON / 版本未知均拒绝", () => {
  assert.equal(parsePlan("没有 JSON", OPTIONS).ok, false);
  assert.equal(parsePlan("{", OPTIONS).ok, false);
  assert.equal(parsePlan(JSON.stringify({ steps: [] }), OPTIONS).ok, false);
  const versioned = parsePlan(JSON.stringify({ version: 2, steps: [{ id: "s1", role: "solo-coder" }] }), OPTIONS);
  assert.equal(versioned.ok, false);
  if (!versioned.ok) assert.match(versioned.reason, /不支持的计划版本/);
});

test("P8 降级单步计划：单步、零依赖、写明原因", () => {
  const plan = buildFallbackPlan({
    objective: "修复登录崩溃",
    reason: "未配置模型凭据",
    createdAt: "2026-11-04T00:00:00.000Z",
    roleName: "独立开发者",
  });
  assert.equal(plan.source, "fallback");
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(plan.steps[0]?.dependsOn, []);
  assert.equal(plan.team[0]?.name, "独立开发者");
  assert.match(plan.strategy, /未配置模型凭据/);
  assert.deepEqual(plan.warnings, ["未配置模型凭据"]);
});

// ============================================================================
// P9–P10：波次
// ============================================================================

/** 构造步骤 */
function step(id: string, dependsOn: string[]): PlanStep {
  return { id, title: id, role: "solo-coder", dependsOn, deliverable: id };
}

test("P9 波次分层：同层并行、跨层串行、顺序稳定", () => {
  const steps = [step("s1", []), step("s2", ["s1"]), step("s3", ["s1"]), step("s4", ["s2", "s3"])];
  const waves = planWaves(steps);
  assert.deepEqual(
    waves.map((wave) => wave.stepIds),
    [["s1"], ["s2", "s3"], ["s4"]]
  );
});

test("P10 可派工判定：前置全完成才可派；未完成时被阻塞", () => {
  const steps = [step("s1", []), step("s2", ["s1"]), step("s3", ["s1", "s2"])];
  const none = new Map(steps.map((s) => [s.id, "pending" as const]));
  assert.deepEqual(
    findRunnableSteps(steps, none).map((s) => s.id),
    ["s1"]
  );

  const s1Done = new Map([
    ["s1", "ready" as const],
    ["s2", "pending" as const],
    ["s3", "pending" as const],
  ]);
  assert.deepEqual(
    findRunnableSteps(steps, s1Done).map((s) => s.id),
    ["s2"]
  );
  assert.deepEqual(
    findBlockedSteps(steps, s1Done).map((entry) => entry.stepId),
    ["s3"]
  );
  assert.equal(isPlanComplete(steps, s1Done), false);
  assert.equal(
    isPlanComplete(
      steps,
      new Map([
        ["s1", "ready" as const],
        ["s2", "ready" as const],
        ["s3", "ready" as const],
      ])
    ),
    true
  );
});

// ============================================================================
// P11：计划器降级
// ============================================================================

test("P11 无模型凭据：计划器降级为单步，不抛错", async () => {
  const planner = new LlmWorkflowPlanner({
    projectRoot: "/nonexistent-project-root",
    injectedClient: {}, // 不是合法的 handle → resolveLlmHandle 返回 null
  });
  assert.equal(planner.available(), false);
  const plan = await planner.plan({ ticketId: "th_1", ticketName: "修复登录崩溃", scope: "请修复登录崩溃" });
  assert.equal(plan.source, "fallback");
  assert.match(plan.strategy, /未配置模型凭据/);
});

test("P11b NullPlanner 与 StaticPlanner 的能力标记", async () => {
  const nullPlanner = new NullPlanner();
  assert.equal(nullPlanner.available(), false);
  const plan = await nullPlanner.plan({ ticketId: "t", ticketName: "n", scope: "s" });
  assert.equal(plan.steps.length, 1);

  const workPlan = buildFallbackPlan({
    objective: "x",
    reason: "固定",
    createdAt: "2026-11-04T00:00:00.000Z",
  });
  const staticPlanner = new StaticPlanner(() => workPlan);
  assert.equal(staticPlanner.available(), true);
  assert.deepEqual(await staticPlanner.plan({ ticketId: "t", ticketName: "n", scope: "s" }), workPlan);
});

// ============================================================================
// P12：身份与渲染
// ============================================================================

test("P12 身份：名字、署名与人格前导一致", () => {
  assert.equal(SUPER_AGENT_IDENTITY.name, "司南");
  assert.match(superAgentSignature(), /司南（Sinan）· 常驻主理智能体/);
  const preamble = buildIdentityPreamble();
  assert.match(preamble, /先分解，再执行/);
  assert.match(preamble, /不越权/);
  assert.match(preamble, /不编造/);
});

test("P12b 计划渲染：带进度时逐步骤标注状态", () => {
  const plan: WorkPlan = buildFallbackPlan({
    objective: "修复登录崩溃",
    reason: "固定",
    createdAt: "2026-11-04T00:00:00.000Z",
  });
  const text = renderPlan(plan, new Map([["s1", "ready" as const]]));
  assert.match(text, /目标：修复登录崩溃/);
  assert.match(text, /［ready］s1/);
  assert.match(text, /团队/);
});
