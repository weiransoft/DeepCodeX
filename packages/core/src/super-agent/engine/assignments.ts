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
import type { Assignment, Attention, WorkerReport } from "../domain/types.js";
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

    // 1) 更新 Assignment
    ctx.repos.updateAssignment(tx, assignmentId, {
      state: isFinal ? "ended" : "running",
      endedAt: isFinal ? ctx.now() : null,
      report,
    });

    // 2) 更新工单最新报告
    ctx.repos.updateTicketReport(tx, ticket.id, report);

    // 3) 结构化 Attention（唯一合法的「需要人」通道）
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

    // 4) 最终报告结束工单
    if (isFinal && ticket.state === "open") {
      ctx.repos.endTicket(tx, ticket.id, "worker", finalReason(report), ctx.now());
      const messageId = makeId("message");
      ctx.repos.insertTicketMessage(tx, {
        id: messageId,
        ticketId: ticket.id,
        direction: "out",
        body: `工单已结束：${finalReason(report)}`,
        state: "pending",
        attempts: 0,
        createdAt: ctx.now(),
      });
      ctx.enqueueEffect(tx, "reply", `reply:${messageId}`, { messageId, ticketId: ticket.id });
    }
  });
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
