/**
 * Super Agent 工单生命周期
 *
 * ## 状态机
 *
 * ```
 *   (创建) ──> open ──> ended
 *              ^         │
 *              └─────────┘   人的消息 + 授权复验通过 → 恢复
 * ```
 *
 * ## 三条硬规则
 *
 * 1. **只有 Eval 能创建工单**——外部不能凭空造工单。
 * 2. **Mandate 不可变**——恢复不修改授权；范围变宽意味着**新工单**。
 * 3. **只有最终报告能终结工单**——Worker 的一次中间报告不结束工单。
 *
 * @module super-agent/engine/tickets
 */

import { notFound } from "../domain/errors.js";
import { makeId } from "../domain/ids.js";
import { findSourcePart, loadPolicy, revalidateMandate } from "../policy/policy.js";
import type { Assignment, Mandate, Policy, Strength, Ticket, TicketExecution } from "../domain/types.js";
import type { WorkPlan } from "../planner/types.js";
import { planWaves } from "../planner/waves.js";
import type { StoreTx } from "../store/store.js";
import type { EngineContext } from "./engine.js";

/** 接单输入 */
export interface AcceptTicketInput {
  /** 触发的 Trigger ID 列表 */
  readonly origin: readonly string[];
  /** 授权 */
  readonly mandate: Mandate;
  /** 工单名称 */
  readonly name: string;
  /** 工作目录（空串表示由执行器决定） */
  readonly directory: string;
  /** 承担角色 */
  readonly role: string;
  /** 订阅的 Thread（自有） */
  readonly threadId: string;
  /**
   * 执行计划（可选）
   *
   * 提供时：按**首波**步骤派工（同波多步 = 多人并行），并把全部步骤进度落库；
   * 不提供时：保持既有语义「一单一角色」——计划是增强项，不是接单的前提。
   */
  readonly plan?: WorkPlan;
}

/**
 * 接受一个决策并创建工单
 *
 * 原子完成：Ticket + Assignment + Subscription + 派工副作用 + 确认消息。
 *
 * @param ctx 引擎上下文
 * @param tx 事务句柄
 * @param input 接单输入
 * @returns 新建的工单
 */
export function acceptTicket(ctx: EngineContext, tx: StoreTx, input: AcceptTicketInput): Ticket {
  const createdAt = ctx.now();
  const ticketId = makeId("ticket");

  const plan = input.plan !== undefined && input.plan.steps.length > 0 ? input.plan : undefined;
  const waves = plan === undefined ? [] : planWaves(plan.steps);
  const firstWave = waves[0]?.stepIds ?? [];
  const dispatchable =
    plan === undefined
      ? [{ stepId: null as string | null, role: input.role }]
      : plan.steps.filter((step) => firstWave.includes(step.id)).map((step) => ({ stepId: step.id, role: step.role }));

  // 首波每个步骤一个 Assignment；无计划时保持「一个 Assignment」的旧语义
  const dispatches = dispatchable.map((entry) => ({
    stepId: entry.stepId,
    role: entry.role,
    assignment: createAssignmentRecord(ctx, ticketId),
  }));

  const execution: TicketExecution = {
    name: input.name,
    directory: input.directory,
    assignmentId: dispatches[dispatches.length - 1]?.assignment.id ?? null,
    // 展示用角色：取计划首步（多角色时由 `super plan` 展开具体分工）
    role: plan?.steps[0]?.role ?? input.role,
  };

  const ticket: Ticket = {
    id: ticketId,
    state: "open",
    origin: [...input.origin],
    mandate: input.mandate,
    execution,
    latestReport: null,
    createdAt,
    endedAt: null,
    endedBy: null,
    endedReason: null,
  };

  ctx.repos.insertTicket(tx, ticket);
  for (const dispatch of dispatches) {
    ctx.repos.insertAssignment(tx, dispatch.assignment);
  }
  // 自有订阅：工单自己开启的 Thread——关闭判定与恢复都看它
  ctx.repos.insertSubscription(tx, { ticketId, threadId: input.threadId, own: true });

  // 计划：快照 + 步骤进度（全部步骤先落 pending，首波绑定 Assignment）
  if (plan !== undefined) {
    ctx.repos.insertPlan(tx, ticketId, plan);
    const waveOf = new Map<string, number>();
    for (const wave of waves) for (const stepId of wave.stepIds) waveOf.set(stepId, wave.index);
    const assignmentByStep = new Map<string, string>();
    for (const dispatch of dispatches) {
      if (dispatch.stepId !== null) assignmentByStep.set(dispatch.stepId, dispatch.assignment.id);
    }
    for (const step of plan.steps) {
      ctx.repos.insertPlanStep(tx, {
        ticketId,
        stepId: step.id,
        wave: waveOf.get(step.id) ?? 0,
        state: "pending",
        role: step.role,
        assignmentId: assignmentByStep.get(step.id) ?? null,
        startedAt: null,
        endedAt: null,
        summary: null,
      });
    }
  }

  // 派工副作用：事务提交后才真正启动 Worker（I2）
  for (const dispatch of dispatches) {
    ctx.enqueueEffect(tx, "launch", `launch:${dispatch.assignment.id}`, {
      ticketId,
      assignmentId: dispatch.assignment.id,
    });
  }

  // 确认消息：告诉人「已接单」（带计划摘要，让「怎么做」第一眼可见）
  const messageId = makeId("message");
  const planSummary =
    plan === undefined
      ? ""
      : `（计划 ${plan.steps.length} 步 / 团队 ${plan.team.length} 角色 / 首波 ${dispatches.length} 人）`;
  ctx.repos.insertTicketMessage(tx, {
    id: messageId,
    ticketId,
    direction: "out",
    body: `已接单：${input.name}${planSummary}`,
    state: "pending",
    attempts: 0,
    createdAt,
  });
  ctx.enqueueEffect(tx, "reply", `reply:${messageId}`, { messageId, ticketId });

  return ticket;
}

/**
 * 构造一条 pending 状态的 Assignment
 *
 * @param ctx 引擎上下文
 * @param ticketId Ticket ID
 * @returns Assignment
 */
export function createAssignmentRecord(ctx: EngineContext, ticketId: string): Assignment {
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
 * 结束工单
 *
 * @param ctx 引擎上下文
 * @param tx 事务句柄
 * @param ticketId Ticket ID
 * @param by 结束者（"human" / "system" / "worker"）
 * @param reason 结束原因
 * @returns 是否成功结束（false = 工单不存在或已结束）
 */
export function endTicket(ctx: EngineContext, tx: StoreTx, ticketId: string, by: string, reason: string): boolean {
  const ticket = ctx.repos.findTicket(ticketId);
  if (ticket === undefined) {
    throw notFound(`工单 ${ticketId} 不存在。`);
  }
  if (ticket.state === "ended") {
    return false;
  }
  ctx.repos.endTicket(tx, ticketId, by, reason, ctx.now());
  // 结束通知：只注入不唤醒（I9）
  const messageId = makeId("message");
  ctx.repos.insertTicketMessage(tx, {
    id: messageId,
    ticketId,
    direction: "out",
    body: `工单已结束：${reason}`,
    state: "pending",
    attempts: 0,
    createdAt: ctx.now(),
  });
  ctx.enqueueEffect(tx, "reply", `reply:${messageId}`, { messageId, ticketId });
  return true;
}

/**
 * 恢复一个已结束的工单
 *
 * 恢复前**必须复验授权**：Policy 变了、发件人被移出名单、模式被关掉，
 * 都可能导致旧授权失效——此时工单保持结束，等待的消息需要重新走 Eval。
 *
 * @param ctx 引擎上下文
 * @param tx 事务句柄
 * @param ticketId Ticket ID
 * @param reason 恢复原因（人的消息正文）
 * @returns 恢复成功返回 true；授权失效返回 false
 */
export function resumeTicket(ctx: EngineContext, tx: StoreTx, ticketId: string, reason: string): boolean {
  const ticket = ctx.repos.findTicket(ticketId);
  if (ticket === undefined) {
    throw notFound(`工单 ${ticketId} 不存在。`);
  }
  if (ticket.state === "open") {
    // 已开放：作为普通输入处理
    ctx.repos.insertTicketInput(tx, {
      id: makeId("input"),
      ticketId,
      kind: "text",
      body: reason,
      deliveredAt: null,
      createdAt: ctx.now(),
    });
    ctx.enqueueEffect(tx, "delivery", `delivery:${ticketId}`, { ticketId });
    return true;
  }

  // 人喊停的工单不可恢复
  if (ticket.endedBy === "human") {
    return false;
  }

  const policy = loadPolicyFromRepo(ctx);
  const sourcePart = findSourcePart(policy, ticket.mandate.sourceId);
  if (!revalidateMandate(ticket.mandate, policy, sourcePart)) {
    return false;
  }

  ctx.repos.reopenTicket(tx, ticketId);
  ctx.repos.insertTicketInput(tx, {
    id: makeId("input"),
    ticketId,
    kind: "resumed",
    body: reason,
    deliveredAt: null,
    createdAt: ctx.now(),
  });
  ctx.enqueueEffect(tx, "delivery", `delivery:${ticketId}`, { ticketId });
  return true;
}

/**
 * 判定某个强度下是否应真正接单
 *
 * - `explicit` → 任何模式都接
 * - `inferred` → 只有 `auto` 模式接；`observe` 只记影子；`off` 不接
 *
 * @param strength 强度
 * @param acceptMode 接单模式
 * @returns "accept" | "shadow" | "reject"
 */
export function resolveAcceptOutcome(
  strength: Strength,
  acceptMode: "off" | "observe" | "auto"
): "accept" | "shadow" | "reject" {
  if (strength === "explicit") return "accept";
  if (acceptMode === "auto") return "accept";
  if (acceptMode === "observe") return "shadow";
  return "reject";
}

/**
 * 从仓储读取当前 Policy
 *
 * @param ctx 引擎上下文
 * @returns Policy
 */
export function loadPolicyFromRepo(ctx: EngineContext): Policy {
  return loadPolicy((key) => ctx.repos.getKv(key));
}
