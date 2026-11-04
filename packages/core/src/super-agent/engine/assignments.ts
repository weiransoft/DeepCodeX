/**
 * Super Agent 派工与报告
 *
 * ## 报告语义（结构化六值）
 *
 * | 报告 | Assignment | Ticket | Attention |
 * |---|---|---|---|
 * | `progress` | 保持 running | 更新最新报告 | 无 |
 * | `waiting` | 保持 running | 更新最新报告 | 有（非阻塞） |
 * | `ready` | 结束 | 结束（worker，完成） | 无 |
 * | `blocked` | 保持 running | 更新最新报告 | 有（阻塞） |
 * | `failed` | 结束 | 结束（worker，失败） | 有（阻塞） |
 * | `dropped` | 结束 | 结束（worker，无需处理） | 无 |
 *
 * ## 硬约束
 *
 * 🔴 **不得从报告的自由文本推断「需要人决策」**——
 * 需要人参与必须走 `Attention` 结构化字段。这是 DSH 原型的明确要求，
 * 也是本项目「结构化事实优先」纪律的延续。
 *
 * @module super-agent/engine/assignments
 */

import { makeId } from "../domain/ids.js";
import type { Assignment, Attention, Ticket, WorkerReport } from "../domain/types.js";
import type { WorkPlan } from "../planner/types.js";
import { findBlockedSteps, findRunnableSteps, isPlanComplete } from "../planner/waves.js";
import { loadPolicy } from "../policy/policy.js";
import type { StoreTx } from "../store/store.js";
import type { EngineContext } from "./engine.js";

/**
 * 创建一个 pending 状态的 Assignment
 *
 * @param ctx 引擎上下文
 * @param ticketId Ticket ID
 * @returns Assignment
 */
export function createAssignment(ctx: EngineContext, ticketId: string): Assignment {
  return {
    id: makeId("assignment"),
    ticketId,
    state: "pending",
    workerSessionId: null,
    startedAt: null,
    endedAt: null,
    report: null,
  };
}

/**
 * 标记 Assignment 开始运行
 *
 * @param ctx 引擎上下文
 * @param tx 事务句柄
 * @param assignmentId Assignment ID
 * @param workerSessionId Worker 会话 ID
 */
export function markAssignmentRunning(
  ctx: EngineContext,
  tx: StoreTx,
  assignmentId: string,
  workerSessionId: string
): void {
  ctx.repos.updateAssignment(tx, assignmentId, {
    state: "running",
    workerSessionId,
    startedAt: ctx.now(),
  });
}

/**
 * 记录 Worker 报告
 *
 * @param ctx 引擎上下文
 * @param assignmentId Assignment ID
 * @param report 报告
 */
export function applyReport(ctx: EngineContext, assignmentId: string, report: WorkerReport): void {
  ctx.store.write((tx) => {
    const assignment = ctx.repos.findAssignment(assignmentId);
    if (assignment === undefined) {
      throw new Error(`Assignment ${assignmentId} 不存在——报告无法归属。`);
    }
    const ticket = ctx.repos.findTicket(assignment.ticketId);
    if (ticket === undefined) {
      throw new Error(`工单 ${assignment.ticketId} 不存在——报告无法归属。`);
    }

    const isFinal = report.kind === "ready" || report.kind === "failed" || report.kind === "dropped";
    const plan = ctx.repos.findPlan(ticket.id);
    const step = ctx.repos.findPlanStepByAssignment(assignmentId);

    // 1) 更新 Assignment
    ctx.repos.updateAssignment(tx, assignmentId, {
      state: isFinal ? "ended" : "running",
      endedAt: isFinal ? ctx.now() : null,
      report,
    });

    // 2) 更新工单最新报告
    ctx.repos.updateTicketReport(tx, ticket.id, report);

    // 3) 更新计划步骤进度（计划是增强项：没有计划的工单跳过本步）
    if (plan !== undefined && step !== undefined) {
      ctx.repos.updatePlanStep(tx, ticket.id, step.stepId, {
        state: isFinal ? (report.kind === "failed" ? "failed" : "ready") : "running",
        endedAt: isFinal ? ctx.now() : null,
        summary: report.summary,
      });
    }

    // 4) 结构化 Attention（唯一合法的「需要人」通道）
    if (report.attention !== undefined) {
      const attention = createAttention(ctx, tx, ticket.id, report.attention);
      ctx.repos.insertAttention(tx, attention);
      // 阻塞型 Attention 需要唤醒人 → 投递副作用 + 通知消息
      if (attention.blocking) {
        const messageId = makeId("message");
        ctx.repos.insertTicketMessage(tx, {
          id: messageId,
          ticketId: ticket.id,
          direction: "out",
          body: `需要你的决策：${attention.question}`,
          state: "pending",
          attempts: 0,
          createdAt: ctx.now(),
        });
        ctx.enqueueEffect(tx, "reply", `reply:${messageId}`, { messageId, ticketId: ticket.id });
      }
    }

    // 5) 最终报告：推进计划波次，或结束工单
    if (isFinal && ticket.state === "open") {
      if (plan !== undefined && step !== undefined) {
        advancePlan(ctx, tx, ticket, plan, step.stepId, report);
      } else {
        endWithMessage(ctx, tx, ticket, finalReason(report));
      }
    }
  });
}

/**
 * 推进计划：派发下一波步骤，或结束工单
 *
 * ## 判定顺序（先收尾、后派工）
 *
 * 1. 本步失败 → **立即结束**工单（失败不跳过、不重试未知步骤）；
 * 2. 全部步骤就绪 → 结束工单，理由写明完成步数；
 * 3. 仍有可派工的步骤 → 同波并行派工（一步一个 Assignment），工单保持开放；
 * 4. 无步骤可派但计划未完成 → **如实结束**并说明「依赖无法满足」，
 *    不让工单挂在半路无人推进。
 *
 * @param ctx 引擎上下文
 * @param tx 事务句柄
 * @param ticket 工单
 * @param plan 计划
 * @param completedStepId 刚完成的步骤 ID
 * @param report 该步骤的报告
 */
function advancePlan(
  ctx: EngineContext,
  tx: StoreTx,
  ticket: Ticket,
  plan: WorkPlan,
  completedStepId: string,
  report: WorkerReport
): void {
  const completed = plan.steps.find((step) => step.id === completedStepId);
  const title = completed?.title ?? completedStepId;

  if (report.kind === "failed") {
    endWithMessage(ctx, tx, ticket, `步骤 ${completedStepId}「${title}」失败：${report.summary}`);
    return;
  }

  const records = ctx.repos.listPlanSteps(ticket.id);
  const states = new Map(records.map((record) => [record.stepId, record.state] as const));
  const waveOf = new Map(records.map((record) => [record.stepId, record.wave] as const));
  const doneCount = plan.steps.filter((step) => states.get(step.id) === "ready").length;

  if (isPlanComplete(plan.steps, states)) {
    endWithMessage(ctx, tx, ticket, `已完成（${plan.steps.length} 步）：${report.summary}`);
    return;
  }

  // 🔴 同波并行的关键判定：还有步骤「在飞」（运行中，或已派工尚未启动）时，
  // 本步完成**不代表**可以收尾或重复派工——必须等同波其他步骤回报。
  // 缺这一步会导致：先完成的步骤把仍在跑的波次判成「依赖无法满足」而提前结束工单。
  const inFlight = records.filter(
    (record) => record.state === "running" || (record.state === "pending" && record.assignmentId !== null)
  );
  if (inFlight.length > 0) return;

  const assignmentByStep = new Map(records.map((record) => [record.stepId, record.assignmentId] as const));
  const runnable = findRunnableSteps(plan.steps, states).filter((step) => assignmentByStep.get(step.id) === null);

  if (runnable.length === 0) {
    const blocked = findBlockedSteps(plan.steps, states);
    endWithMessage(
      ctx,
      tx,
      ticket,
      blocked.length === 0
        ? `计划无法继续：没有可派工的步骤（已完成 ${doneCount}/${plan.steps.length} 步）。`
        : `计划无法继续：步骤 ${blocked.map((entry) => entry.stepId).join("、")} 的前置无法满足（已完成 ${doneCount}/${plan.steps.length} 步）。`
    );
    return;
  }

  const waveIndex = Math.min(...runnable.map((step) => waveOf.get(step.id) ?? 0));
  for (const step of runnable) {
    const assignment = createAssignment(ctx, ticket.id);
    ctx.repos.insertAssignment(tx, assignment);
    ctx.repos.updatePlanStep(tx, ticket.id, step.id, {
      state: "pending",
      assignmentId: assignment.id,
    });
    ctx.enqueueEffect(tx, "launch", `launch:${assignment.id}`, {
      ticketId: ticket.id,
      assignmentId: assignment.id,
    });
  }

  // 新一波启动后重投积压输入：Worker 未就绪时投递会退避重试，不丢
  if (ctx.repos.listPendingInputs(ticket.id).length > 0) {
    ctx.enqueueEffect(tx, "delivery", `delivery:${ticket.id}`, { ticketId: ticket.id });
  }

  const messageId = makeId("message");
  ctx.repos.insertTicketMessage(tx, {
    id: messageId,
    ticketId: ticket.id,
    direction: "out",
    body: `「${title}」已完成（${doneCount}/${plan.steps.length}）。进入第 ${waveIndex + 1} 波：${runnable
      .map((step) => `${step.id} ${step.title}（${step.role}）`)
      .join("、")}`,
    state: "pending",
    attempts: 0,
    createdAt: ctx.now(),
  });
  ctx.enqueueEffect(tx, "reply", `reply:${messageId}`, { messageId, ticketId: ticket.id });
}

/**
 * 结束工单并发出通知（结束与通知必须在同一事务内，避免「结束了但没人知道」）
 *
 * @param ctx 引擎上下文
 * @param tx 事务句柄
 * @param ticket 工单
 * @param reason 结束原因
 */
function endWithMessage(ctx: EngineContext, tx: StoreTx, ticket: Ticket, reason: string): void {
  ctx.repos.endTicket(tx, ticket.id, "worker", reason, ctx.now());
  const messageId = makeId("message");
  ctx.repos.insertTicketMessage(tx, {
    id: messageId,
    ticketId: ticket.id,
    direction: "out",
    body: `工单已结束：${reason}`,
    state: "pending",
    attempts: 0,
    createdAt: ctx.now(),
  });
  ctx.enqueueEffect(tx, "reply", `reply:${messageId}`, { messageId, ticketId: ticket.id });
}

/**
 * 构造 Attention（应用每日打扰预算）
 *
 * 超出预算时**降级为非阻塞**——DSH 洞察：「噪音是有成本的，人一旦开始忽略通知，
 * 这个系统就失效了。」
 *
 * @param ctx 引擎上下文
 * @param tx 事务句柄
 * @param ticketId Ticket ID
 * @param draft 草稿
 * @returns Attention 实体
 */
function createAttention(
  ctx: EngineContext,
  tx: StoreTx,
  ticketId: string,
  draft: NonNullable<WorkerReport["attention"]>
): Attention {
  const policy = loadPolicy((key) => ctx.repos.getKv(key));
  const budget = policy.dailyAttentionBudget;
  const blocking = draft.blocking;
  if (budget !== null && blocking) {
    const todayCount = countTodayAttentions(ctx);
    if (todayCount >= budget) {
      // 预算用尽：降级为非阻塞，避免打扰过量
      return {
        id: makeId("attention"),
        ticketId,
        question: `${draft.question}（今日打扰预算已用尽，已转为非阻塞）`,
        options: [...draft.options],
        blocking: false,
        createdAt: ctx.now(),
        resolvedAt: null,
        resolution: null,
      };
    }
  }
  return {
    id: makeId("attention"),
    ticketId,
    question: draft.question,
    options: [...draft.options],
    blocking,
    createdAt: ctx.now(),
    resolvedAt: null,
    resolution: null,
  };
}

/**
 * 统计今天已产生的 Attention 数
 *
 * @param ctx 引擎上下文
 * @returns 数量
 */
function countTodayAttentions(ctx: EngineContext): number {
  const today = ctx.now().slice(0, 10);
  return ctx.repos.listOpenAttention().filter((attention) => attention.createdAt.startsWith(today)).length;
}

/**
 * 最终报告对应的结束原因
 *
 * @param report 报告
 * @returns 原因文本
 */
function finalReason(report: WorkerReport): string {
  switch (report.kind) {
    case "ready":
      return "已完成";
    case "failed":
      return "执行失败";
    case "dropped":
      return "无需处理";
    default:
      return report.summary;
  }
}
