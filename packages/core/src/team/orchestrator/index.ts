/**
 * 自动多角色拆解（L2）主流程
 *
 * 目标 → 拆解 → 分层 → 执行 → 聚合。四阶段各自可降级，任何一环失败都不让
 * 用户的目标没人接：
 *
 * | 失败点 | 行为 |
 * | --- | --- |
 * | 拆解失败 | 降级为单任务派单（等同 `/team dispatch --task <goal>`） |
 * | 单个子任务失败 | 标记 failed，依赖它的后继 skipped，同层兄弟继续 |
 * | 聚合失败 | 回落本地拼装报告，结构不变 |
 * | 事件日志写入失败 | 静默跳过（审计设施不拖垮业务） |
 *
 * 设计文档：`docs/proposals/agent-team-enhancement/l2-orchestration.md`
 *
 * @module team/orchestrator
 */

import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import type { OpenAIClientHandle } from "../../common/openai-client.js";
import { DispatchEventLog } from "../dispatch-event-log.js";
import { ROLE_REGISTRY } from "../role-registry.js";
import type { DispatchRunner } from "../team-adapter.js";
import type { RoleDefinition } from "../types.js";
import { aggregateResults, renderLocalReport } from "./aggregate.js";
import { decomposeGoal, type RoleBrief } from "./decompose.js";
import { executeLayers } from "./execute.js";
import { resolveLlmHandle } from "./llm-once.js";
import { serializeFileConflicts, topologicalLayers } from "./plan-graph.js";
import {
  OrchestrationBudget,
  type OrchestrationPlan,
  type OrchestrationResult,
  type OrchestrationSubtaskResult,
  type SerializedMove,
  type SubtaskNode,
} from "./types.js";

export * from "./types.js";
export { decomposeGoal, buildDecomposeUserPrompt, DECOMPOSE_SYSTEM_PROMPT, type RoleBrief } from "./decompose.js";
export {
  executeLayers,
  type ExecuteLayersParams,
  type ExecuteLayersResult,
  type SubtaskProgressEvent,
} from "./execute.js";
export { aggregateResults, renderLocalReport, AGGREGATE_SYSTEM_PROMPT } from "./aggregate.js";
export {
  validatePlan,
  topologicalLayers,
  serializeFileConflicts,
  normalizeProjectPath,
  extractJsonObject,
} from "./plan-graph.js";
export { callLlmOnce, resolveLlmHandle, type LlmOnceResult } from "./llm-once.js";

/** 编排进度事件（编排层自有类型；commands 层负责适配成宿主用的 TeamProgressEvent） */
export interface OrchestrationProgressEvent {
  phase: "decompose" | "plan" | "execute" | "aggregate" | "end";
  level: "info" | "success" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}

/** 编排参数 */
export interface OrchestrateParams {
  /** 用户目标（自然语言） */
  goal: string;
  projectRoot: string;
  budget?: Partial<OrchestrationBudget>;
  /** 角色候选集（含运行时角色）；未传则仅内置 5 角色 */
  candidates?: ReadonlyArray<RoleDefinition>;
  /** 带工具轮次的执行器 */
  runner?: DispatchRunner;
  injectedClient?: unknown;
  /** 只拆解 + 分层，不执行（验收工具） */
  dryRun?: boolean;
  /** 跳过 LLM 聚合，直接本地拼装 */
  skipAggregate?: boolean;
  /** 编排事件日志：默认开启；false 关闭；{ dir } 自定义目录 */
  eventLog?: boolean | { dir?: string };
  onProgress?: (event: OrchestrationProgressEvent) => void;
  signal?: AbortSignal;
  /** 显式注入 LLM 句柄（测试用；undefined 表示按 projectRoot 解析） */
  llmHandle?: OpenAIClientHandle | null;
  timeoutMs?: number;
}

/** 生成编排 runId（与子 dispatch 的 runId 区分，便于日志里一眼分辨层级） */
export function generateOrchestrationRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `orchestrate-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * 执行一次完整编排
 *
 * 不抛异常：所有失败路径都以 `OrchestrationResult` 返回（`endReason` 表明结果）。
 * 唯一例外是调用方传入非法 budget 时的 zod 错误——那是编程错误，不是运行时故障。
 */
export async function orchestrate(params: OrchestrateParams): Promise<OrchestrationResult> {
  const budget = OrchestrationBudget.parse(params.budget ?? {});
  const runId = generateOrchestrationRunId();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const progress = (event: OrchestrationProgressEvent): void => {
    try {
      params.onProgress?.(event);
    } catch {
      // 宿主渲染失败不影响编排
    }
  };

  // ---- 编排级事件日志（endType 必须是 orchestrate/end，否则 open() 会误判崩溃）----
  let eventLog: DispatchEventLog | null = null;
  if (params.eventLog !== false) {
    try {
      const customDir = typeof params.eventLog === "object" ? params.eventLog.dir : undefined;
      eventLog = new DispatchEventLog(
        runId,
        customDir ?? DispatchEventLog.defaultDir(params.projectRoot, runId),
        "orchestrate/end"
      );
      eventLog.open();
    } catch {
      eventLog = null;
    }
  }

  const finish = (result: OrchestrationResult, reason: OrchestrationResult["endReason"]): OrchestrationResult => {
    try {
      eventLog?.end(reason, {
        mode: result.mode,
        subtasks: result.subtasks.length,
        succeeded: result.subtasks.filter((s) => s.status === "succeeded").length,
        failed: result.subtasks.filter((s) => s.status === "failed").length,
        skipped: result.subtasks.filter((s) => s.status === "skipped").length,
        usedToolRounds: result.budget.usedToolRounds,
        aggregated: result.aggregate.aggregated,
      });
    } catch {
      // 终态写入失败不影响返回
    }
    return result;
  };

  const handle =
    params.llmHandle !== undefined ? params.llmHandle : resolveLlmHandle(params.projectRoot, params.injectedClient);

  // ==========================================================================
  // 阶段 1：拆解
  // ==========================================================================
  progress({ phase: "decompose", level: "info", message: "正在拆解目标…" });
  const roles = buildRoleBriefs(params.candidates);
  const decomposition = await decomposeGoal({
    goal: params.goal,
    handle,
    roles,
    budget,
    projectRoot: params.projectRoot,
    timeoutMs: params.timeoutMs,
  });

  /** 拆解失败 → 单任务计划（复用同一条执行 + 聚合路径，避免两套代码漂移） */
  let plan: OrchestrationPlan;
  let mode: OrchestrationResult["mode"] = "orchestrated";
  let degradationReason: string | undefined;

  if (decomposition.ok) {
    plan = decomposition.plan;
  } else {
    mode = "degraded-single";
    degradationReason = `${decomposition.kind}: ${decomposition.message}`;
    plan = {
      rationale: "拆解失败，已降级为单角色派单",
      subtasks: [
        {
          id: "t1",
          title: truncateGoal(params.goal),
          description: params.goal,
          dependsOn: [],
          files: [],
        },
      ],
    };
    progress({
      phase: "decompose",
      level: "warn",
      message: `拆解失败（${decomposition.kind}），已降级为单角色派单：${decomposition.message}`,
      data: { kind: decomposition.kind },
    });
  }

  // ==========================================================================
  // 阶段 2：分层 + 文件写冲突消解
  // ==========================================================================
  const layered = topologicalLayers(plan.subtasks);
  // 已通过 validatePlan，理论上有环不会到这里；降级计划是单节点，也必然可分层。
  // 仍做兜底：真出现环时串成单列，保证"能跑完"而不是崩在编排层。
  const baseLayers = layered.ok ? layered.layers : plan.subtasks.map((node) => [node.id]);
  const filesById = new Map<string, ReadonlyArray<string>>(plan.subtasks.map((node) => [node.id, node.files]));
  const { layers, serialized } = serializeFileConflicts(baseLayers, filesById);
  const serializedNote = formatSerializedNote(serialized);

  progress({
    phase: "plan",
    level: "info",
    message: `已拆解为 ${plan.subtasks.length} 个子任务，分 ${layers.length} 层执行${
      serialized.length > 0 ? `（${serialized.length} 个子任务因文件冲突改为串行）` : ""
    }`,
    data: { layers: layers.length, subtasks: plan.subtasks.length, serialized: serialized.length },
  });

  try {
    eventLog?.append("orchestrate/plan", {
      mode,
      ...(degradationReason ? { degradationReason } : {}),
      rationale: plan.rationale,
      subtasks: plan.subtasks.map((node) => ({
        id: node.id,
        title: node.title,
        dependsOn: node.dependsOn,
        files: node.files,
        ...(node.roleHint ? { roleHint: node.roleHint } : {}),
      })),
      layers,
      serialized: serialized.map((move) => ({
        id: move.id,
        fromLayer: move.fromLayer,
        toLayer: move.toLayer,
        conflictsWith: move.conflictsWith,
      })),
    });
  } catch {
    // 日志失败不影响主链路
  }

  // ==========================================================================
  // 阶段 2.5：dry-run 出口（只给计划，不动工作区）
  // ==========================================================================
  if (params.dryRun === true) {
    progress({ phase: "plan", level: "success", message: "dry-run：仅生成计划，不执行" });
    const preview = renderPlanPreview({
      goal: params.goal,
      plan,
      layers,
      serialized,
      budget,
      degradationReason,
    });
    return finish(
      {
        goal: params.goal,
        runId,
        mode,
        ...(degradationReason ? { degradationReason } : {}),
        dryRun: true,
        layers,
        subtasks: [],
        serialized,
        aggregate: { text: preview, aggregated: false },
        undocumentedChanges: [],
        budget: { usedToolRounds: 0, totalToolRounds: budget.totalToolRounds },
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        endReason: "completed",
      },
      "completed"
    );
  }

  // ==========================================================================
  // 阶段 3：执行（层内并发，层间串行）
  // ==========================================================================
  // 执行前后各取一次 git status，差集才是「本次编排引入的改动」——
  // 否则用户原本就有的未提交改动会被误报成"未声明的改动"。
  const before = snapshotChangedFiles(params.projectRoot);

  const { results, usedToolRounds } = await executeLayers({
    plan,
    layers,
    projectRoot: params.projectRoot,
    budget,
    ...(params.candidates ? { candidates: params.candidates } : {}),
    ...(params.runner ? { runner: params.runner } : {}),
    ...(params.injectedClient !== undefined ? { injectedClient: params.injectedClient } : {}),
    eventLog,
    ...(params.signal ? { signal: params.signal } : {}),
    onProgress: (event) => {
      if (event.type === "subtask-start") {
        progress({
          phase: "execute",
          level: "info",
          message: `[第 ${event.layer + 1}/${event.totalLayers} 层] 开始 ${event.id}：${event.title}`,
          data: { id: event.id, layer: event.layer, kind: "start" },
        });
      } else {
        progress({
          phase: "execute",
          level: event.status === "succeeded" ? "success" : event.status === "skipped" ? "warn" : "error",
          message: `[${event.id}] ${event.title} → ${event.status}${event.roleName ? `（${event.roleName}）` : ""}，${event.durationMs}ms`,
          data: { id: event.id, layer: event.layer, status: event.status, kind: "end" },
        });
      }
    },
  });

  const after = snapshotChangedFiles(params.projectRoot);
  const undocumentedChanges = detectUndocumentedChanges(before, after, plan.subtasks);

  // ==========================================================================
  // 阶段 4：聚合
  // ==========================================================================
  progress({ phase: "aggregate", level: "info", message: "正在汇总各子任务结果…" });
  const aggregate = await aggregateResults({
    goal: params.goal,
    rationale: plan.rationale,
    results,
    handle,
    enabled: params.skipAggregate !== true,
    ...(serializedNote ? { serializedNote } : {}),
    undocumentedChanges,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  });

  try {
    eventLog?.append("orchestrate/aggregate", {
      aggregated: aggregate.aggregated,
      ...(aggregate.error ? { error: aggregate.error } : {}),
      length: aggregate.text.length,
    });
  } catch {
    // 日志失败不影响主链路
  }

  const failed = results.filter((result) => result.status === "failed").length;
  const cancelled = results.filter((result) => result.status === "cancelled").length;
  const endReason: OrchestrationResult["endReason"] =
    cancelled > 0 && failed === 0 ? "aborted" : failed > 0 ? "error" : "completed";

  progress({
    phase: "end",
    level: endReason === "completed" ? "success" : endReason === "aborted" ? "warn" : "error",
    message: `编排结束：${results.filter((r) => r.status === "succeeded").length} 成功 / ${failed} 失败 / ${
      results.filter((r) => r.status === "skipped").length
    } 跳过，共消耗 ${usedToolRounds} 轮工具预算`,
  });

  return finish(
    {
      goal: params.goal,
      runId,
      mode,
      ...(degradationReason ? { degradationReason } : {}),
      layers,
      subtasks: results,
      serialized,
      aggregate,
      undocumentedChanges,
      budget: { usedToolRounds, totalToolRounds: budget.totalToolRounds },
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      endReason,
    },
    endReason
  );
}

// ============================================================================
// 辅助
// ============================================================================

/** 候选集 → 拆解 prompt 用的角色摘要（未注入候选时退回 5 个内置角色） */
export function buildRoleBriefs(candidates?: ReadonlyArray<RoleDefinition>): RoleBrief[] {
  const pool = candidates && candidates.length > 0 ? candidates : ROLE_REGISTRY;
  return pool.map((role) => ({
    roleId: role.roleId,
    name: role.name,
    ...(role.metadata?.group ? { group: role.metadata.group } : {}),
    capabilities: role.capabilities,
  }));
}

/** 冲突下移的人类可读说明 */
export function formatSerializedNote(serialized: ReadonlyArray<SerializedMove>): string {
  if (serialized.length === 0) return "";
  return serialized
    .map(
      (move) =>
        `- \`${move.id}\` 与 \`${move.conflictsWith}\` 都要改 ${move.files
          .map((file) => `\`${file}\``)
          .join("、")}，已从第 ${move.fromLayer + 1} 层下移到第 ${move.toLayer + 1} 层串行执行`
    )
    .join("\n");
}

/** dry-run 的计划预览 */
function renderPlanPreview(params: {
  goal: string;
  plan: OrchestrationPlan;
  layers: string[][];
  serialized: ReadonlyArray<SerializedMove>;
  budget: OrchestrationBudget;
  degradationReason?: string;
}): string {
  const { goal, plan, layers, serialized, budget, degradationReason } = params;
  const nodeById = new Map<string, SubtaskNode>(plan.subtasks.map((node) => [node.id, node]));

  const lines: string[] = [`## 编排计划（dry-run，未执行）：${goal}`, ""];
  if (degradationReason) {
    lines.push(`> ⚠️ 拆解失败，已降级为单任务：${degradationReason}`, "");
  }
  if (plan.rationale) {
    lines.push(`**拆解思路**：${plan.rationale}`, "");
  }

  lines.push("| 子任务 | 标题 | 建议角色 | 依赖 | 声明文件 | 层 |", "| --- | --- | --- | --- | --- | --- |");
  for (let index = 0; index < layers.length; index++) {
    for (const id of layers[index]!) {
      const node = nodeById.get(id);
      if (!node) continue;
      lines.push(
        `| ${node.id} | ${node.title.replace(/\|/g, "\\|")} | ${node.roleHint ?? "-"} | ${
          node.dependsOn.join(", ") || "-"
        } | ${node.files.map((file) => `\`${file}\``).join("<br>") || "-"} | ${index + 1} |`
      );
    }
  }
  lines.push("");

  lines.push("**执行顺序**：", "");
  layers.forEach((layer, index) => {
    lines.push(
      `${index + 1}. 第 ${index + 1} 层（可并行 ${Math.min(layer.length, budget.maxParallel)} 个）：${layer.join(", ")}`
    );
  });
  lines.push("");

  const note = formatSerializedNote(serialized);
  if (note) {
    lines.push("**并发调整**：", "", note, "");
  }

  lines.push(
    `**预算**：子任务上限 ${budget.maxSubtasks} / 并发 ${budget.maxParallel} / 单任务 ${budget.maxToolRounds} 轮 / 全局 ${budget.totalToolRounds} 轮`
  );

  return lines.join("\n").trim();
}

/** git 变更文件快照；非 git 仓库或失败返回 null（调用方跳过检测） */
function snapshotChangedFiles(projectRoot: string): Set<string> | null {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const files = new Set<string>();
    for (const line of output.split("\n")) {
      const trimmed = line.replace(/\r$/, "");
      if (trimmed.trim() === "") continue;
      // 格式：XY <path>；重命名/复制为 "XY <old> -> <new>"
      const pathPart = trimmed.slice(3).trim();
      const arrowIndex = pathPart.indexOf(" -> ");
      const file = arrowIndex >= 0 ? pathPart.slice(arrowIndex + 4) : pathPart;
      const cleaned = file.replace(/^"|"$/g, "").trim();
      if (cleaned !== "") files.add(cleaned.toLowerCase());
    }
    return files;
  } catch {
    return null;
  }
}

/**
 * 计算「本次编排引入、且未被任何子任务声明」的改动
 *
 * 只报告、不回滚：编排无权撤销用户的改动，也不该假装没看见。
 * 任意一侧快照失败（非 git 仓库 / git 不可用）都返回空数组，不阻塞。
 */
function detectUndocumentedChanges(
  before: Set<string> | null,
  after: Set<string> | null,
  subtasks: ReadonlyArray<SubtaskNode>
): string[] {
  if (before === null || after === null) return [];
  const declared = new Set<string>();
  for (const node of subtasks) {
    for (const file of node.files) declared.add(file.toLowerCase());
  }
  return Array.from(after)
    .filter((file) => !before.has(file))
    .filter((file) => !declared.has(file))
    .sort();
}

/**
 * 目标 → 单任务降级时的标题
 *
 * 截断而不是整段塞进 title：`buildTask` 的 title 会进入 prompt 首行与报告表格，
 * 太长会破坏排版；完整目标仍在 description 里。
 */
function truncateGoal(goal: string): string {
  const firstLine = goal.split("\n").find((line) => line.trim() !== "") ?? goal;
  const trimmed = firstLine.trim();
  return trimmed.length <= 40 ? trimmed : `${trimmed.slice(0, 40)}…`;
}

/** 供宿主直接渲染的纯文本报告（不含 dry-run） */
export function renderOrchestrationReport(result: OrchestrationResult): string {
  if (result.aggregate.text.trim() !== "") return result.aggregate.text;

  // 理论上 aggregate 一定产出文本（最差也是本地拼装）；这里是最后一道兜底
  return renderLocalReport({
    goal: result.goal,
    rationale: "",
    results: result.subtasks as OrchestrationSubtaskResult[],
    undocumentedChanges: result.undocumentedChanges,
  });
}
