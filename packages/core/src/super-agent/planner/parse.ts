/**
 * 计划解析与校验 —— 把模型的自由文本变成可用、可审计的 DAG
 *
 * ## 为什么要「校验 + 降级」而不是「信任模型输出」
 *
 * 模型输出是**不可信输入**（与 Trigger 正文同级）。一个坏计划会让工单
 * 派给不存在的角色、引用不存在的前置、或形成环——任何一种都会让执行卡死。
 * 因此解析层做三件事：
 *
 * 1. **结构归一**：从可能带代码块的文本中取出 JSON，字段逐项兜底；
 * 2. **语义校验**：角色存在性、依赖引用完整性、无自依赖、无环、步数上限；
 * 3. **可审计降级**：任何被修正的地方写入 `warnings`，**不静默吞掉**；
 *    彻底不可用时降级为**单步计划**（行为等价于旧版单角色执行）。
 *
 * ## 硬约束
 *
 * - 步骤数上限 `MAX_PLAN_STEPS`（默认 8）：计划不是越长越好，长计划意味着
 *   每步上下文都被稀释；宁可少拆几步，也不要拆成二十个碎片。
 * - 角色必须来自**注册表**：不存在的角色名无法取到提示词，等于无人执行。
 *
 * @module super-agent/planner/parse
 */

import type { PlanParseResult, PlanStep, PlanStepState, TeamMember, WorkPlan } from "./types.js";

/** 默认步骤上限 */
export const MAX_PLAN_STEPS = 8;

/** 默认降级角色 */
export const FALLBACK_ROLE = "solo-coder";

/** 解析选项 */
export interface ParsePlanOptions {
  /** 目标（缺省目标：模型未给出可用目标时使用） */
  readonly objective: string;
  /** 生成时间（ISO 8601） */
  readonly createdAt: string;
  /** 允许的角色 ID 集合（来自角色注册表） */
  readonly allowedRoles: readonly string[];
  /** 角色显示名（ID → 中文名），用于构建团队成员 */
  readonly roleNames?: Readonly<Record<string, string>>;
  /** 降级角色（默认 `solo-coder`） */
  readonly fallbackRole?: string;
  /** 步骤上限（默认 {@link MAX_PLAN_STEPS}） */
  readonly maxSteps?: number;
}

/**
 * 解析并校验计划
 *
 * @param raw 模型原始输出（可含代码块或前后缀）
 * @param options 解析选项
 * @returns 成功返回规范化计划；失败返回原因
 */
export function parsePlan(raw: string, options: ParsePlanOptions): PlanParseResult {
  const warnings: string[] = [];
  const json = extractPlanJsonObject(raw);
  if (json === null) {
    return { ok: false, reason: "输出中找不到 JSON 对象。" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch (error) {
    return { ok: false, reason: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: "JSON 根节点不是对象。" };
  }
  const record = payload as Record<string, unknown>;

  const version = typeof record["version"] === "number" ? record["version"] : 1;
  if (version !== 1) {
    return { ok: false, reason: `不支持的计划版本 ${String(version)}（本实现只支持 v1）。` };
  }

  const rawSteps = record["steps"];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { ok: false, reason: "steps 为空或不是数组。" };
  }

  const maxSteps = options.maxSteps ?? MAX_PLAN_STEPS;
  const trimmedSteps = rawSteps.slice(0, maxSteps);
  if (rawSteps.length > maxSteps) {
    warnings.push(`步骤数 ${rawSteps.length} 超过上限 ${maxSteps}，已截断到 ${maxSteps} 步。`);
  }

  // 第一遍：收集 ID 映射（模型可能给出非标准 ID，需要重写为 s1..sn）
  const idMapping = new Map<number, string>();
  const usedIds = new Set<string>();
  trimmedSteps.forEach((_step, index) => {
    const candidate = trimmedSteps[index];
    const rawId =
      typeof candidate === "object" && candidate !== null ? (candidate as Record<string, unknown>)["id"] : undefined;
    const normalized = typeof rawId === "string" ? rawId.trim() : "";
    if (normalized.length > 0 && !usedIds.has(normalized)) {
      idMapping.set(index, normalized);
      usedIds.add(normalized);
    } else {
      if (normalized.length > 0) {
        warnings.push(`第 ${index + 1} 步的 ID "${normalized}" 重复或不可用，已改写为 s${index + 1}。`);
      }
      let fallbackId = `s${index + 1}`;
      while (usedIds.has(fallbackId)) fallbackId = `${fallbackId}x`;
      idMapping.set(index, fallbackId);
      usedIds.add(fallbackId);
    }
  });

  const allowedRoles = new Set(options.allowedRoles);
  const fallbackRole = options.fallbackRole ?? FALLBACK_ROLE;
  if (!allowedRoles.has(fallbackRole)) {
    allowedRoles.add(fallbackRole);
  }

  // 第二遍：规范化每个步骤
  const steps: PlanStep[] = [];
  trimmedSteps.forEach((candidate, index) => {
    const step = (typeof candidate === "object" && candidate !== null ? candidate : {}) as Record<string, unknown>;
    const id = idMapping.get(index) ?? `s${index + 1}`;

    const rawTitle = typeof step["title"] === "string" ? step["title"].trim() : "";
    const title = rawTitle.length > 0 ? truncate(rawTitle, 120) : `第 ${index + 1} 步`;
    if (rawTitle.length === 0) {
      warnings.push(`步骤 ${id} 缺少标题，已使用占位标题。`);
    } else if (rawTitle.length > 120) {
      warnings.push(`步骤 ${id} 的标题超过 120 字，已截断。`);
    }

    const rawRole = typeof step["role"] === "string" ? step["role"].trim() : "";
    let role = rawRole;
    if (!allowedRoles.has(role)) {
      role = fallbackRole;
      warnings.push(
        rawRole.length === 0
          ? `步骤 ${id} 未指定角色，已回落为 ${fallbackRole}。`
          : `步骤 ${id} 的角色 "${rawRole}" 不在注册表中，已回落为 ${fallbackRole}。`
      );
    }

    const deliverable =
      typeof step["deliverable"] === "string" && step["deliverable"].trim().length > 0
        ? truncate(step["deliverable"].trim(), 200)
        : `完成「${title}」并给出可复核的结论`;

    const rawDependsOn = Array.isArray(step["dependsOn"]) ? step["dependsOn"] : [];
    steps.push({
      id,
      title,
      role,
      dependsOn: rawDependsOn.filter((value): value is string => typeof value === "string"),
      deliverable,
    });
  });

  // 第三遍：依赖引用校验（此时全部 ID 已确定）
  const idSet = new Set(steps.map((step) => step.id));
  const sanitized: PlanStep[] = steps.map((step) => {
    const dependsOn: string[] = [];
    for (const dependency of step.dependsOn) {
      const target = dependency.trim();
      if (target === step.id) {
        warnings.push(`步骤 ${step.id} 依赖自身，已移除该依赖。`);
        continue;
      }
      if (!idSet.has(target)) {
        warnings.push(`步骤 ${step.id} 依赖了不存在的步骤 "${target}"，已移除该依赖。`);
        continue;
      }
      if (!dependsOn.includes(target)) dependsOn.push(target);
    }
    return { ...step, dependsOn };
  });

  const cycle = findCycle(sanitized);
  if (cycle !== null) {
    return { ok: false, reason: `计划存在循环依赖：${cycle.join(" → ")}` };
  }

  const objective = readText(record["objective"], options.objective, 400, "objective", warnings);
  const strategy = readText(record["strategy"], "", 600, "strategy", warnings);

  return {
    ok: true,
    plan: {
      version: 1,
      objective,
      strategy,
      steps: sanitized,
      team: buildTeam(sanitized, options.roleNames ?? {}),
      source: "llm",
      warnings,
      createdAt: options.createdAt,
    },
  };
}

/**
 * 构造降级为单步的计划
 *
 * **这不是错误路径的敷衍**：旧版 Super Agent 的执行语义就是「一单一角色」，
 * 降级计划保持完全一致的行为，区别只是把「为什么降级」写进 `warnings` 与 `strategy`，
 * 让人在 `super plan` 里看得见。
 *
 * @param input 目标、原因、时间等
 * @returns 单步计划
 */
export function buildFallbackPlan(input: {
  readonly objective: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly role?: string;
  readonly roleName?: string;
}): WorkPlan {
  const role = input.role ?? FALLBACK_ROLE;
  const objective = input.objective.trim().length > 0 ? truncate(input.objective.trim(), 400) : "（未指定目标）";
  return {
    version: 1,
    objective,
    strategy: `降级为单步执行：${input.reason}`,
    steps: [
      {
        id: "s1",
        title: truncate(objective, 120),
        role,
        dependsOn: [],
        deliverable: "完成授权范围内的任务并给出可复核的结论",
      },
    ],
    team: [
      {
        role,
        name: input.roleName ?? role,
        responsibility: truncate(objective, 120),
        stepIds: ["s1"],
      },
    ],
    source: "fallback",
    warnings: [input.reason],
    createdAt: input.createdAt,
  };
}

/**
 * 把计划渲染成 Markdown（供 CLI 与 Worker 提示复用）
 *
 * @param plan 计划
 * @param states 步骤状态表（可选；提供时附带进度）
 * @returns Markdown 文本
 */
export function renderPlan(plan: WorkPlan, states?: ReadonlyMap<string, PlanStepState>): string {
  const lines: string[] = [];
  lines.push(`目标：${plan.objective}`);
  if (plan.strategy.length > 0) lines.push(`策略：${plan.strategy}`);
  lines.push(`来源：${plan.source === "llm" ? "模型分解" : "降级单步"} · 步骤：${plan.steps.length}`);
  if (plan.warnings.length > 0) {
    lines.push("告警：");
    for (const warning of plan.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");
  lines.push("步骤：");
  for (const step of plan.steps) {
    const marker = states === undefined ? "" : `［${states.get(step.id) ?? "pending"}］`;
    const depends = step.dependsOn.length > 0 ? `（前置 ${step.dependsOn.join("、")}）` : "（首波）";
    lines.push(`  ${marker}${step.id} ${step.title} — 角色 ${step.role}${depends}`);
    lines.push(`      交付：${step.deliverable}`);
  }
  if (plan.team.length > 0) {
    lines.push("");
    lines.push("团队：");
    for (const member of plan.team) {
      lines.push(`  - ${member.name}（${member.role}）：${member.stepIds.join("、")} — ${member.responsibility}`);
    }
  }
  return lines.join("\n");
}

/**
 * 从可能带代码块 / 前后缀的文本中取出 JSON 对象
 *
 * @param raw 原始文本
 * @returns JSON 子串；找不到返回 null
 */
export function extractPlanJsonObject(raw: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced !== null && fenced[1] !== undefined ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

/**
 * 按角色聚合团队
 *
 * @param steps 步骤
 * @param roleNames 角色显示名
 * @returns 团队成员
 */
function buildTeam(steps: readonly PlanStep[], roleNames: Readonly<Record<string, string>>): TeamMember[] {
  const byRole = new Map<string, { stepIds: string[]; titles: string[] }>();
  for (const step of steps) {
    const entry = byRole.get(step.role) ?? { stepIds: [], titles: [] };
    entry.stepIds.push(step.id);
    entry.titles.push(step.title);
    byRole.set(step.role, entry);
  }
  return [...byRole.entries()].map(([role, entry]) => ({
    role,
    name: roleNames[role] ?? role,
    responsibility: truncate(entry.titles.join("；"), 120),
    stepIds: entry.stepIds,
  }));
}

/**
 * 检测环（Kahn）
 *
 * @param steps 步骤
 * @returns 环上的步骤序列；无环返回 null
 */
function findCycle(steps: readonly PlanStep[]): string[] | null {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    indegree.set(step.id, step.dependsOn.length);
    for (const dependency of step.dependsOn) {
      const list = dependents.get(dependency) ?? [];
      list.push(step.id);
      dependents.set(dependency, list);
    }
  }
  const queue = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    visited.add(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (visited.size === steps.length) return null;
  return steps.filter((step) => !visited.has(step.id)).map((step) => step.id);
}

/**
 * 读取文本字段并做长度约束
 *
 * @param value 原始值
 * @param fallback 缺省值
 * @param max 上限
 * @param field 字段名（告警用）
 * @param warnings 告警收集器
 * @returns 文本
 */
function readText(value: unknown, fallback: string, max: number, field: string, warnings: string[]): string {
  if (typeof value !== "string") return truncate(fallback, max);
  const trimmed = value.trim();
  if (trimmed.length === 0) return truncate(fallback, max);
  if (trimmed.length > max) {
    warnings.push(`${field} 超过 ${max} 字，已截断。`);
    return truncate(trimmed, max);
  }
  return trimmed;
}

/**
 * 按字符数截断（保留省略号）
 *
 * @param text 文本
 * @param max 上限
 * @returns 截断结果
 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
