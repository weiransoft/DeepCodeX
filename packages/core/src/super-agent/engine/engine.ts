/**
 * Super Agent Engine —— 领域状态的**唯一写入者**
 *
 * ## 角色受限视图（I1）
 *
 * Engine 内部持有一切领域方法，但对外只暴露**按角色裁剪**的视图：
 *
 * | 视图 | 给谁 | 能做什么 |
 * |---|---|---|
 * | `EngineForSources` | Source 插件 | 投递 Trigger、绑定 Thread、结束 Thread |
 * | `EngineForRouter` | Router | 取候选、批量决策 |
 * | `EngineForPeople` | 人（CLI / Web） | 看工单、发消息、解决 Attention |
 * | `EngineForExecutor` | Worker | 回报执行结果 |
 * | `EngineForSettings` | 设置 | 读写 Policy |
 *
 * 任何角色都拿不到不该有的方法——**这是编译期保证，不是约定**。
 *
 * ## 事务边界（I2）
 *
 * 每个公开命令在**一个事务**内修改聚合；外部副作用（启动 Worker、投递消息）
 * 经 `afterCommit` 登记，只在事务提交后执行。
 *
 * @module super-agent/engine/engine
 */

import { invalidRequest, notFound, stateConflict } from "../domain/errors.js";
import { makeId } from "../domain/ids.js";
import type {
  Assignment,
  Attention,
  Decision,
  DecisionKind,
  EvalCandidate,
  IntakeResult,
  NewTrigger,
  Policy,
  Strength,
  Ticket,
  TicketInput,
  TicketMessage,
  TicketState,
  Trigger,
  WorkerReport,
} from "../domain/types.js";
import { loadPolicy, validatePolicy } from "../policy/policy.js";
import type { SuperAgentRepositories } from "../store/repositories.js";
import type { Store, StoreTx } from "../store/store.js";
import { applyReport, createAssignment } from "./assignments.js";
import { collectDueCandidates, decideBatch } from "./evals.js";
import { receiveTrigger } from "./intake.js";
import { acceptTicket, endTicket, resumeTicket } from "./tickets.js";

// ============================================================================
// 引擎上下文
// ============================================================================

/** 副作用类型 */
export type EffectKind = "assessment" | "launch" | "delivery" | "relay" | "reply";

/** Assessor 端口 —— LLM 研判（可注入 stub，便于确定性测试） */
export interface Assessor {
  /**
   * 对一批候选做研判
   *
   * @param candidate 候选上下文
   * @returns 研判结论；不可用时返回 null（本轮记 unavailable）
   */
  assess(candidate: EvalCandidate): Promise<{
    kind: DecisionKind;
    reason: string;
    matchedRules: readonly string[];
  } | null>;
}

/** Worker 启动端口 —— 外部执行（可注入 stub） */
export interface WorkerExecutor {
  /**
   * 启动一个 Worker
   *
   * @param input 启动输入
   * @returns Worker 会话 ID
   */
  start(input: {
    readonly ticketId: string;
    readonly assignmentId: string;
    readonly role: string;
    readonly scope: string;
    readonly prompt: string;
  }): Promise<string>;
}

/** 引擎上下文（各 part 模块共享） */
export interface EngineContext {
  /** 持久层 */
  readonly store: Store;
  /** 仓储 */
  readonly repos: SuperAgentRepositories;
  /** LLM 研判端口（null = 不具备研判能力，推断型一律 ignore） */
  readonly assessor: Assessor | null;
  /** Worker 启动端口（null = 无法执行，只建 Ticket 不派工） */
  readonly executor: WorkerExecutor | null;
  /** 当前时间（ISO 8601） */
  readonly now: () => string;
  /** 在事务内入队副作用 */
  readonly enqueueEffect: (tx: StoreTx, kind: EffectKind, key: string, payload: unknown, dueAt?: string) => void;
}

// ============================================================================
// 角色受限接口
// ============================================================================

/** Source 侧接口 */
export interface EngineForSources {
  /** 投递一个事件 */
  receiveTrigger(input: {
    readonly trigger: NewTrigger;
    /** 该事件归属的 Thread 相关键（Source 决定） */
    readonly threadKeys: readonly string[];
  }): IntakeResult;
  /** 把一个 Thread 绑定到某 Ticket（只有自有 Thread 才可以） */
  bindThread(threadId: string, ticketId: string): void;
}

/** Router 侧接口 */
export interface EngineForRouter {
  /** 取待研判的候选 */
  listCandidates(): EvalCandidate[];
  /** 批量决策（逐项独立，单项失败不阻断后续） */
  decide(items: readonly DecisionInput[]): DecisionResult[];
}

/** 人侧接口 */
export interface EngineForPeople {
  /** 列出工单 */
  listTickets(state?: TicketState): Ticket[];
  /** 取工单详情 */
  getTicket(id: string): TicketDetail;
  /** 发送一条消息到工单（人的消息可恢复已结束的工单） */
  postMessage(ticketId: string, body: string): void;
  /** 解决一个 Attention */
  resolveAttention(attentionId: string, resolution: string): void;
  /** 列出未解决的 Attention */
  listOpenAttention(ticketId?: string): Attention[];
}

/** Worker 侧接口 */
export interface EngineForExecutor {
  /** 回报执行结果 */
  reportAssignment(assignmentId: string, report: WorkerReport): void;
}

/** 设置侧接口 */
export interface EngineForSettings {
  /** 读取当前 Policy */
  getPolicy(): Policy;
  /** 写入 Policy（版本 +1，投递变更通知） */
  setPolicy(policy: Policy): void;
}

/** 工单详情（聚合视图） */
export interface TicketDetail {
  readonly ticket: Ticket;
  readonly assignments: readonly Assignment[];
  readonly inputs: readonly TicketInput[];
  readonly messages: readonly TicketMessage[];
  readonly attention: readonly Attention[];
  readonly decisions: readonly Decision[];
}

/** 决策输入（Router 提交） */
export interface DecisionInput {
  /** 目标 Thread */
  readonly threadId: string;
  /** 决策种类 */
  readonly kind: DecisionKind;
  /** 理由 */
  readonly reason: string;
  /** 强度（缺省由 Gate 推导） */
  readonly strength?: Strength;
  /** 匹配到的规则 */
  readonly matchedRules?: readonly string[];
  /** 授权范围（缺省用触发文本摘要） */
  readonly scope?: string;
  /** 请求者身份（缺省从触发者推导） */
  readonly actor?: string;
  /** 来源 Source ID（缺省从 Thread 推导） */
  readonly sourceId?: string;
  /** 触发本次决策的 Trigger ID */
  readonly triggerIds?: readonly string[];
}

/** 决策结果 */
export interface DecisionResult {
  readonly threadId: string;
  readonly kind: DecisionKind;
  /** applied = 已落地；refused = 被拒；would-accept = 影子模式记录，未接单 */
  readonly status: "applied" | "refused" | "would-accept";
  readonly ticketId?: string;
  readonly reason: string;
}

// ============================================================================
// Engine 实现
// ============================================================================

/** Engine 构造选项 */
export interface SuperAgentEngineOptions {
  readonly store: Store;
  readonly repos: SuperAgentRepositories;
  readonly assessor?: Assessor | null;
  readonly executor?: WorkerExecutor | null;
  /** Eval 超时（毫秒），默认 30 秒 */
  readonly evalTimeoutMs?: number;
}

/**
 * SuperAgentEngine —— 领域状态的唯一写入者
 */
export class SuperAgentEngine {
  /** 引擎上下文 */
  private readonly ctx: EngineContext;
  /** Eval 超时 */
  private readonly evalTimeoutMs: number;

  /**
   * 构造 Engine
   *
   * @param options 构造选项
   */
  constructor(options: SuperAgentEngineOptions) {
    this.evalTimeoutMs = options.evalTimeoutMs ?? 30_000;
    this.ctx = {
      store: options.store,
      repos: options.repos,
      assessor: options.assessor ?? null,
      executor: options.executor ?? null,
      now: () => options.store.now(),
      enqueueEffect: (tx, kind, key, payload, dueAt) => {
        // 在**调用方的事务内**入队——不新开事务，保证「命令 = 一个事务」（I2）
        options.repos.enqueueEffect(tx, {
          kind,
          key,
          payload,
          dueAt: dueAt ?? options.store.now(),
        });
      },
    };
  }

  /** 取当前 Policy（从 KV 读取） */
  private currentPolicy(): Policy {
    return loadPolicy((key) => this.ctx.repos.getKv(key));
  }

  // ------------------------------------------------------------ Sources 视图

  /** Source 侧视图 */
  get sources(): EngineForSources {
    return {
      receiveTrigger: (input) => receiveTrigger(this.ctx, input, this.evalTimeoutMs),
      bindThread: (threadId, ticketId) => this.bindThreadInternal(threadId, ticketId),
    };
  }

  // ------------------------------------------------------------- Router 视图

  /** Router 侧视图 */
  get router(): EngineForRouter {
    return {
      listCandidates: () => collectDueCandidates(this.ctx),
      decide: (items) => decideBatch(this.ctx, items),
    };
  }

  // -------------------------------------------------------------- People 视图

  /** 人侧视图 */
  get people(): EngineForPeople {
    return {
      listTickets: (state) => this.ctx.repos.listTickets(state),
      getTicket: (id) => this.getTicketDetail(id),
      postMessage: (ticketId, body) => this.postMessageInternal(ticketId, body),
      resolveAttention: (attentionId, resolution) => this.resolveAttentionInternal(attentionId, resolution),
      listOpenAttention: (ticketId) => this.ctx.repos.listOpenAttention(ticketId),
    };
  }

  // ------------------------------------------------------------ Executor 视图

  /** Worker 侧视图 */
  get executor(): EngineForExecutor {
    return {
      reportAssignment: (assignmentId, report) => applyReport(this.ctx, assignmentId, report),
    };
  }

  // ------------------------------------------------------------ Settings 视图

  /** 设置侧视图 */
  get settings(): EngineForSettings {
    return {
      getPolicy: () => this.currentPolicy(),
      setPolicy: (policy) => this.setPolicyInternal(policy),
    };
  }

  // ------------------------------------------------------------ 内部实现

  /**
   * 绑定 Thread 到 Ticket
   *
   * 只有 Ticket **自己开启**的 Thread 才允许被绑定（`own` 语义）。
   *
   * @param threadId Thread ID
   * @param ticketId Ticket ID
   */
  private bindThreadInternal(threadId: string, ticketId: string): void {
    const ticket = this.ctx.repos.findTicket(ticketId);
    if (ticket === undefined) {
      throw notFound(`工单 ${ticketId} 不存在。`);
    }
    this.ctx.store.write((tx) => {
      this.ctx.repos.insertSubscription(tx, { ticketId, threadId, own: true });
    });
  }

  /**
   * 取工单详情
   *
   * @param id Ticket ID
   * @returns 聚合详情
   */
  private getTicketDetail(id: string): TicketDetail {
    const ticket = this.ctx.repos.findTicket(id);
    if (ticket === undefined) {
      throw notFound(`工单 ${id} 不存在。`);
    }
    return {
      ticket,
      assignments: this.ctx.repos.listAssignments(id),
      inputs: this.ctx.repos.listInputs(id),
      messages: this.ctx.repos.listTicketMessages(id),
      attention: this.ctx.repos.listAttention(id),
      decisions: this.ctx.repos.listDecisions(this.ctx.repos.listSubscriptionsByTicket(id)[0]?.threadId ?? ""),
    };
  }

  /**
   * 发送消息到工单
   *
   * 人的消息可以**恢复已结束的工单**（按原 Mandate 复验通过后）；
   * 已被授权的工单则作为输入投递给 Worker。
   *
   * @param ticketId Ticket ID
   * @param body 消息正文
   */
  private postMessageInternal(ticketId: string, body: string): void {
    const text = body.trim();
    if (text.length === 0) {
      throw invalidRequest("消息正文不能为空。");
    }
    const ticket = this.ctx.repos.findTicket(ticketId);
    if (ticket === undefined) {
      throw notFound(`工单 ${ticketId} 不存在。`);
    }

    this.ctx.store.write((tx) => {
      // 已结束的工单：先复验授权，通过则恢复
      if (ticket.state === "ended") {
        const resumed = resumeTicket(this.ctx, tx, ticketId, text);
        if (!resumed) {
          throw stateConflict(`工单 ${ticketId} 的授权已失效，需重新接单。`);
        }
        return;
      }
      // 开放中的工单：作为输入投递
      this.ctx.repos.insertTicketInput(tx, {
        id: makeId("input"),
        ticketId,
        kind: "text",
        body: text,
        deliveredAt: null,
        createdAt: this.ctx.now(),
      });
      this.ctx.enqueueEffect(tx, "delivery", `delivery:${ticketId}`, { ticketId });
    });
  }

  /**
   * 解决 Attention
   *
   * @param attentionId Attention ID
   * @param resolution 解决方案
   */
  private resolveAttentionInternal(attentionId: string, resolution: string): void {
    const at = this.ctx.now();
    this.ctx.store.write((tx) => {
      const resolved = this.ctx.repos.listOpenAttention().find((attention) => attention.id === attentionId);
      if (resolved === undefined) {
        throw notFound(`Attention ${attentionId} 不存在或已解决。`);
      }
      this.ctx.repos.resolveAttention(tx, attentionId, resolution, at);
      // 解决后唤醒对应工单的 Worker
      this.ctx.enqueueEffect(tx, "delivery", `delivery:${resolved.ticketId}`, {
        ticketId: resolved.ticketId,
      });
    });
  }

  /**
   * 写入 Policy
   *
   * 版本 +1，并向受影响的活动工单投递 `policy_changed` 输入（**不撤销**存量 Mandate）。
   *
   * @param policy 新 Policy
   */
  private setPolicyInternal(policy: Policy): void {
    validatePolicy(policy);
    const next: Policy = { ...policy, version: policy.version + 1 };
    this.ctx.store.write((tx) => {
      this.ctx.repos.setKv(tx, "super-agent:policy", JSON.stringify(next));
      // 变更通知：只发给开放中的工单；已结束的不打扰
      for (const ticket of this.ctx.repos.listTickets("open")) {
        this.ctx.repos.insertTicketInput(tx, {
          id: makeId("input"),
          ticketId: ticket.id,
          kind: "policy_changed",
          body: `策略已更新至版本 ${next.version}（接单模式：${next.acceptMode}）。授权不因此撤销。`,
          deliveredAt: null,
          createdAt: this.ctx.now(),
        });
      }
    });
  }

  // ------------------------------------------------------------- 供 part 使用

  /** 暴露上下文给同层 part 模块（仅限 super-agent 内部） */
  get context(): EngineContext {
    return this.ctx;
  }

  /** 当前 Eval 超时 */
  get evalTimeout(): number {
    return this.evalTimeoutMs;
  }
}

/**
 * 便捷构造：接收一个 Trigger 并返回结果（供 Source 插件直接调用）
 *
 * @param engine Engine
 * @param input 事件输入
 * @returns Intake 结果
 */
export function receive(
  engine: SuperAgentEngine,
  input: {
    readonly trigger: NewTrigger;
    readonly threadKeys: readonly string[];
  }
): IntakeResult {
  return engine.sources.receiveTrigger(input);
}

/**
 * 便捷构造：派工（供 Engine 内部与测试使用）
 *
 * @param ctx 引擎上下文
 * @param tx 事务句柄
 * @param ticket 工单
 * @returns Assignment
 */
export { createAssignment, acceptTicket, endTicket };

/**
 * 导出 Trigger 类型以便调用方引用
 */
export type { Trigger };
