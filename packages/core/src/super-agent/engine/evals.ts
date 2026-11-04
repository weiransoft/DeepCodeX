/**
 * Super Agent 评估与决策
 *
 * ## 两层结构
 *
 * ```
 * Eval（评估）
 *   ├─ Gate（准入）—— 纯确定性，零 LLM
 *   └─ Assessment（研判）—— LLM 给出建议
 *          ↓
 * Router（路由）—— 批量决策，逐项独立（I4）
 * ```
 *
 * ## 决策落地规则
 *
 * | 强度 | 接单模式 | 结果 |
 * |---|---|---|
 * | explicit | 任意 | **接单** |
 * | inferred | auto | **接单** |
 * | inferred | observe | **影子记录**（`would_accept=true`，不建工单） |
 * | inferred | off | 忽略 |
 *
 * @module super-agent/engine/evals
 */

import { makeId } from "../domain/ids.js";
import { evaluateGate, findSourcePart, loadPolicy } from "../policy/policy.js";
import type { Decision, DecisionKind, EvalCandidate, Strength, TicketSummary, Trigger } from "../domain/types.js";
import type { EngineContext, DecisionInput, DecisionResult } from "./engine.js";
import { acceptTicket, endTicket, resolveAcceptOutcome } from "./tickets.js";

/** Eval 最多自动重排次数（超过则放弃本批次，等人重新发消息） */
const MAX_EVAL_ATTEMPTS = 2;

/** Eval 重排延迟（毫秒）——避免模型不可用时热循环 */
const EVAL_RETRY_DELAY_MS = 30_000;

/**
 * 收集待研判的候选
 *
 * @param ctx 引擎上下文
 * @returns 候选列表
 */
export function collectDueCandidates(ctx: EngineContext): EvalCandidate[] {
  const policy = loadPolicy((key) => ctx.repos.getKv(key));
  const candidates: EvalCandidate[] = [];

  for (const state of ctx.repos.listEvalStates()) {
    if (state.batch.length === 0) continue;
    const thread = ctx.repos.findThread(state.threadId);
    if (thread === undefined) continue;

    const triggers = state.batch
      .map((triggerId) => ctx.repos.findTrigger(triggerId))
      .filter((trigger): trigger is Trigger => trigger !== undefined);
    if (triggers.length === 0) continue;

    const existingTickets = ctx.repos
      .listSubscriptionsByThread(state.threadId)
      .map((subscription) => ctx.repos.findTicket(subscription.ticketId))
      .filter((ticket): ticket is NonNullable<typeof ticket> => ticket !== undefined)
      .map<TicketSummary>((ticket) => ({
        id: ticket.id,
        state: ticket.state,
        name: ticket.execution.name,
        scope: ticket.mandate.scope,
      }));

    candidates.push({
      threadId: state.threadId,
      triggers,
      existingTickets,
      policy,
    });
  }

  return candidates;
}

/**
 * 批量决策（**逐项独立，单项失败不阻断后续** —— I4）
 *
 * @param ctx 引擎上下文
 * @param items 决策输入列表
 * @returns 决策结果列表（顺序与输入一致）
 */
export function decideBatch(ctx: EngineContext, items: readonly DecisionInput[]): DecisionResult[] {
  const results: DecisionResult[] = [];
  for (const item of items) {
    try {
      results.push(decideOne(ctx, item));
    } catch (error) {
      // 单项失败不阻断后续——这是 I4 的核心保障
      results.push({
        threadId: item.threadId,
        kind: item.kind,
        status: "refused",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/**
 * 执行单个决策
 *
 * @param ctx 引擎上下文
 * @param item 决策输入
 * @returns 决策结果
 */
function decideOne(ctx: EngineContext, item: DecisionInput): DecisionResult {
  const policy = loadPolicy((key) => ctx.repos.getKv(key));

  if (item.kind === "unavailable") {
    // 本轮未能完成判断（研判超时 / 模型不可用）：**重排一次**，连续两次失败才放弃。
    // 目的是既不丢候选，也不因模型不可用而热循环。
    const attempt = bumpExpiredCount(ctx, item.threadId);
    recordDecision(ctx, item, "unavailable", item.strength ?? "inferred", false);
    if (attempt >= MAX_EVAL_ATTEMPTS) {
      // 连续失败达上限：清理 Eval 状态，候选不再自动复活（人可重新发消息触发）
      clearEval(ctx, item.threadId);
    } else {
      const dueAt = new Date(Date.parse(ctx.now()) + EVAL_RETRY_DELAY_MS).toISOString();
      ctx.store.write((tx) => {
        // key 带重试序号——避免与正在执行的那条 assessment 副作用同键合并后被误删
        ctx.enqueueEffect(
          tx,
          "assessment",
          `assessment:${item.threadId}#retry${attempt}`,
          { threadId: item.threadId },
          dueAt
        );
      });
    }
    return {
      threadId: item.threadId,
      kind: "unavailable",
      status: "applied",
      reason: item.reason,
    };
  }

  if (item.kind === "ignore") {
    recordDecision(ctx, item, "ignore", item.strength ?? "inferred", false);
    clearEval(ctx, item.threadId);
    return {
      threadId: item.threadId,
      kind: "ignore",
      status: "applied",
      reason: item.reason,
    };
  }

  if (item.kind === "stop") {
    // 停止：撤回该 Thread 上相关工单的授权
    const stopped = stopThreadTickets(ctx, item.threadId, item.reason);
    recordDecision(ctx, item, "stop", item.strength ?? "explicit", false);
    clearEval(ctx, item.threadId);
    return {
      threadId: item.threadId,
      kind: "stop",
      status: "applied",
      ticketId: stopped,
      reason: item.reason,
    };
  }

  // accept 分支
  // 接单前必须确认 Thread 仍存在——否则会造出「没有归属线程」的工单，
  // 订阅直通与恢复语义都会失效（工单找不到自己的 Thread 就无法判断关闭）。
  if (ctx.repos.findThread(item.threadId) === undefined) {
    recordDecision(ctx, item, "ignore", item.strength ?? "inferred", false);
    clearEval(ctx, item.threadId);
    return {
      threadId: item.threadId,
      kind: "ignore",
      status: "refused",
      reason: `线程 ${item.threadId} 不存在——无法接单。`,
    };
  }

  const strength = item.strength ?? deriveStrength(ctx, item);
  const outcome = resolveAcceptOutcome(strength, policy.acceptMode);

  if (outcome === "reject") {
    recordDecision(ctx, item, "ignore", strength, false);
    clearEval(ctx, item.threadId);
    return {
      threadId: item.threadId,
      kind: "ignore",
      status: "refused",
      reason: `接单模式为 off，推断型候选不接单（${item.reason}）`,
    };
  }

  if (outcome === "shadow") {
    // 影子模式：只记录「本应接单」，不建工单——这是 G2′ 的首期交付物
    recordDecision(ctx, item, "ignore", strength, true);
    clearEval(ctx, item.threadId);
    return {
      threadId: item.threadId,
      kind: "accept",
      status: "would-accept",
      reason: `影子模式记录（接单模式 observe）：${item.reason}`,
    };
  }

  // 真正接单
  const ticket = ctx.store.write((tx) => {
    const trigger = item.triggerIds?.[0] !== undefined ? ctx.repos.findTrigger(item.triggerIds[0]) : undefined;
    const actor = item.actor ?? trigger?.actor ?? "";
    const sourceId = item.sourceId ?? trigger?.sourceId ?? "";
    const mandate = {
      policyVersion: policy.version,
      scope: item.scope ?? trigger?.text.slice(0, 200) ?? "",
      strength,
      matchedRules: [...(item.matchedRules ?? [])],
      actor,
      sourceId,
    };
    const created = acceptTicket(ctx, tx, {
      origin: item.triggerIds ?? [],
      mandate,
      name: buildTicketName(ctx, item, trigger),
      directory: "",
      role: "solo-coder",
      threadId: item.threadId,
    });
    recordDecisionInTx(ctx, tx, item, "accept", strength, false);
    return created;
  });
  clearEval(ctx, item.threadId);

  return {
    threadId: item.threadId,
    kind: "accept",
    status: "applied",
    ticketId: ticket.id,
    reason: item.reason,
  };
}

/**
 * 推导决策强度
 *
 * 优先用触发事件跑一遍 Gate；没有可用事件时退回报送值。
 *
 * @param ctx 引擎上下文
 * @param item 决策输入
 * @returns 强度
 */
function deriveStrength(ctx: EngineContext, item: DecisionInput): Strength {
  const triggerId = item.triggerIds?.[0];
  if (triggerId === undefined) return "inferred";
  const trigger = ctx.repos.findTrigger(triggerId);
  if (trigger === undefined) return "inferred";

  const policy = loadPolicy((key) => ctx.repos.getKv(key));
  const sourcePart = findSourcePart(policy, trigger.sourceId);
  const existingTickets = ctx.repos
    .listSubscriptionsByThread(item.threadId)
    .map((subscription) => ctx.repos.findTicket(subscription.ticketId))
    .filter((ticket): ticket is NonNullable<typeof ticket> => ticket !== undefined)
    .map<TicketSummary>((ticket) => ({
      id: ticket.id,
      state: ticket.state,
      name: ticket.execution.name,
      scope: ticket.mandate.scope,
    }));

  const gate = evaluateGate({
    trigger,
    sourcePart,
    policy,
    existingTickets,
  });
  return gate.strength ?? "inferred";
}

/**
 * 累加某 Thread 的连续失败次数
 *
 * @param ctx 引擎上下文
 * @param threadId Thread ID
 * @returns 累加后的次数
 */
function bumpExpiredCount(ctx: EngineContext, threadId: string): number {
  const state = ctx.repos.findEvalState(threadId);
  const next = (state?.expiredCount ?? 0) + 1;
  if (state === undefined) return next;
  ctx.store.write((tx) => {
    ctx.repos.upsertEvalState(tx, { ...state, expiredCount: next });
  });
  return next;
}

/**
 * 记录 Decision（独立事务）
 *
 * @param ctx 引擎上下文
 * @param item 决策输入
 * @param kind 决策种类
 * @param strength 强度
 * @param wouldAccept 是否为影子记录
 */
function recordDecision(
  ctx: EngineContext,
  item: DecisionInput,
  kind: DecisionKind,
  strength: Strength,
  wouldAccept: boolean
): void {
  ctx.store.write((tx) => {
    recordDecisionInTx(ctx, tx, item, kind, strength, wouldAccept);
  });
}

/**
 * 在既有事务内记录 Decision
 *
 * @param ctx 引擎上下文
 * @param tx 事务句柄
 * @param item 决策输入
 * @param kind 决策种类
 * @param strength 强度
 * @param wouldAccept 是否为影子记录
 */
function recordDecisionInTx(
  ctx: EngineContext,
  tx: Parameters<EngineContext["repos"]["insertDecision"]>[0],
  item: DecisionInput,
  kind: DecisionKind,
  strength: Strength,
  wouldAccept: boolean
): void {
  const decision: Decision = {
    id: makeId("decision"),
    threadId: item.threadId,
    kind,
    strength,
    reason: item.reason,
    wouldAccept,
    at: ctx.now(),
  };
  ctx.repos.insertDecision(tx, decision);
}

/**
 * 清除某 Thread 的 Eval 状态（决策已完成）
 *
 * @param ctx 引擎上下文
 * @param threadId Thread ID
 */
function clearEval(ctx: EngineContext, threadId: string): void {
  ctx.store.write((tx) => {
    ctx.repos.deleteEvalState(tx, threadId);
  });
}

/**
 * 停止某 Thread 上的工单
 *
 * @param ctx 引擎上下文
 * @param threadId Thread ID
 * @param reason 停止原因
 * @returns 被停止的工单 ID
 */
function stopThreadTickets(ctx: EngineContext, threadId: string, reason: string): string | undefined {
  const subscriptions = ctx.repos.listSubscriptionsByThread(threadId);
  let stopped: string | undefined;
  ctx.store.write((tx) => {
    for (const subscription of subscriptions) {
      const ticket = ctx.repos.findTicket(subscription.ticketId);
      if (ticket === undefined || ticket.state === "ended") continue;
      endTicket(ctx, tx, ticket.id, "human", reason);
      stopped = ticket.id;
    }
  });
  return stopped;
}

/**
 * 构造工单名称
 *
 * @param ctx 引擎上下文
 * @param item 决策输入
 * @param trigger 触发事件
 * @returns 名称
 */
function buildTicketName(ctx: EngineContext, item: DecisionInput, trigger: Trigger | undefined): string {
  void ctx;
  const text = item.scope ?? trigger?.text ?? "";
  const firstLine = text.split("\n")[0] ?? text;
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}
