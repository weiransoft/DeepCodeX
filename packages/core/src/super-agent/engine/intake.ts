/**
 * Super Agent 准入（Intake）—— 事件进入领域的唯一入口
 *
 * ## 流程（对齐 DSH `docs/001-domain.md` 的 Intake 语义）
 *
 * ```
 * Trigger
 *   ├─ 幂等命中 → duplicate（不产生第二个 Ticket）
 *   ├─ 存储 + 关联 Thread
 *   ├─ 扇出：命中订阅的 Ticket → 记为 fanned_out，**不再进入 Eval**
 *   └─ 未扇出 → 在主 Thread 上排队 Eval
 * ```
 *
 * ## 关键判定：扇出优先
 *
 * DSH 原文：「一个人的消息若以此路径到达某个 Ticket，就留在该 Ticket；
 * 其余 Trigger 进入 Eval。」——**扇出优先于 Eval**是订阅直通的语义基础。
 *
 * @module super-agent/engine/intake
 */

import { makeId, makeIdempotencyKey, makeThreadId } from "../domain/ids.js";
import type { Disposition, IntakeResult, NewTrigger, TicketInput, Trigger } from "../domain/types.js";
import type { EngineContext } from "./engine.js";

/**
 * 接收一个事件
 *
 * @param ctx 引擎上下文
 * @param input 事件输入（含 Source 决定的 Thread 相关键）
 * @param evalTimeoutMs Eval 超时（毫秒）
 * @returns Intake 结果
 */
export function receiveTrigger(
  ctx: EngineContext,
  input: { readonly trigger: NewTrigger; readonly threadKeys: readonly string[] },
  evalTimeoutMs: number
): IntakeResult {
  const createdAt = ctx.now();
  const idempotencyKey = makeIdempotencyKey({
    sourceId: input.trigger.sourceId,
    actor: input.trigger.actor,
    text: input.trigger.text,
    createdAt,
  });

  // 幂等：同一 (sourceId, idempotencyKey) 只接受一次
  const existing = ctx.repos.findTriggerByIdempotency(input.trigger.sourceId, idempotencyKey);
  if (existing !== undefined) {
    return { status: "duplicate", trigger: existing };
  }

  const trigger: Trigger = {
    ...input.trigger,
    id: makeId("trigger"),
    idempotencyKey,
    createdAt,
  };

  const threadIds = input.threadKeys.map((key) => makeThreadId({ sourceId: trigger.sourceId, correlationKey: key }));
  const primaryThreadId = threadIds[0];

  ctx.store.write((tx) => {
    ctx.repos.insertTrigger(tx, trigger);

    for (const threadId of threadIds) {
      ctx.repos.linkTriggerThread(tx, trigger.id, threadId, createdAt);
      const thread = ctx.repos.findThread(threadId);
      if (thread === undefined) {
        ctx.repos.upsertThread(tx, {
          id: threadId,
          sourceId: trigger.sourceId,
          active: true,
          meta: {},
        });
      }
    }

    // 扇出：命中订阅的 Ticket 直接收到上下文，不再进入 Eval
    let fannedOut = false;
    for (const threadId of threadIds) {
      for (const subscription of ctx.repos.listSubscriptionsByThread(threadId)) {
        const ticket = ctx.repos.findTicket(subscription.ticketId);
        if (ticket === undefined) continue;
        // 已被人喊停的工单不接收任何输入
        if (ticket.state === "ended" && ticket.endedBy === "human") continue;
        const inputRecord: TicketInput = {
          id: makeId("input"),
          ticketId: ticket.id,
          kind: "fanned_out",
          body: renderFannedOut(trigger),
          deliveredAt: null,
          createdAt,
        };
        ctx.repos.insertTicketInput(tx, inputRecord);
        recordDisposition(ctx, tx, trigger.id, "fanned_out", { threadId, ticketId: ticket.id });
        fannedOut = true;
        // 触发投递副作用
        ctx.enqueueEffect(tx, "delivery", `delivery:${ticket.id}`, { ticketId: ticket.id });
      }
    }

    if (fannedOut) {
      recordDisposition(ctx, tx, trigger.id, "acked", { reason: "已扇出到订阅工单" });
      return;
    }

    // 未扇出：排队 Eval
    if (primaryThreadId !== undefined) {
      queueEval(ctx, tx, primaryThreadId, trigger.id, createdAt, evalTimeoutMs);
      recordDisposition(ctx, tx, trigger.id, "evaluated", { threadId: primaryThreadId });
      // 唤醒研判：同 Thread 上已有批次会与本条合并（key 相同 → 合并语义）
      ctx.enqueueEffect(tx, "assessment", `assessment:${primaryThreadId}`, {
        threadId: primaryThreadId,
      });
    }
  });

  return { status: "stored", trigger };
}

/**
 * 把 Trigger 加入某个 Thread 的 Eval 批次
 *
 * 同 Thread 上已有的批次会被**合并**（而不是覆盖）——这正是「批量攒批」的基础。
 *
 * @param ctx 引擎上下文
 * @param tx 事务句柄
 * @param threadId Thread ID
 * @param triggerId Trigger ID
 * @param at 时间
 * @param evalTimeoutMs Eval 超时
 */
export function queueEval(
  ctx: EngineContext,
  tx: Parameters<EngineContext["repos"]["upsertEvalState"]>[0],
  threadId: string,
  triggerId: string,
  at: string,
  evalTimeoutMs: number
): void {
  const current = ctx.repos.findEvalState(threadId);
  const batch = current === undefined ? [triggerId] : [...current.batch, triggerId];
  const deadlineAt = current?.deadlineAt ?? new Date(Date.parse(at) + evalTimeoutMs).toISOString();
  ctx.repos.upsertEvalState(tx, {
    threadId,
    batch,
    deadlineAt,
    candidateDelivered: current?.candidateDelivered ?? false,
    expiredCount: current?.expiredCount ?? 0,
  });
}

/**
 * 记录处置轨迹
 *
 * @param ctx 引擎上下文
 * @param tx 事务句柄
 * @param triggerId Trigger ID
 * @param kind 处置种类
 * @param detail 详情
 */
export function recordDisposition(
  ctx: EngineContext,
  tx: Parameters<EngineContext["repos"]["insertDisposition"]>[0],
  triggerId: string,
  kind: Disposition["kind"],
  detail: Record<string, unknown>
): void {
  const disposition: Disposition = {
    id: makeId("disposition"),
    triggerId,
    kind,
    at: ctx.now(),
    detail,
  };
  ctx.repos.insertDisposition(tx, disposition);
}

/**
 * 渲染扇出给 Ticket 的上下文文本
 *
 * @param trigger 触发事件
 * @returns 可读文本
 */
function renderFannedOut(trigger: Trigger): string {
  const prefix = trigger.actorKind === "human" ? "人" : "机器人";
  return `[${prefix}:${trigger.actor}] ${trigger.text}`;
}
