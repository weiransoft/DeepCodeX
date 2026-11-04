/**
 * Super Agent 仓储层 —— 领域实体与持久化之间的唯一映射
 *
 * ## 边界
 *
 * - 仓储只做**行 ↔ 领域对象**的映射与 CRUD，**不含业务规则**（业务规则在 Engine）。
 * - 仓储**不自己开事务**——由 Engine 通过 `store.atomic()` 统一控制（I2）。
 * - 读路径（`listXxx`）与写路径（`xxx`）分离，读方法**永不写状态**。
 *
 * @module super-agent/store/repositories
 */

import type {
  Assignment,
  AssignmentState,
  Attention,
  Decision,
  DecisionKind,
  Disposition,
  DispositionKind,
  EvalState,
  HistoricalDecision,
  Strength,
  Subscription,
  Thread,
  Ticket,
  TicketInput,
  TicketInputKind,
  TicketMessage,
  TicketMessageDirection,
  TicketMessageState,
  TicketState,
  Trigger,
  TriggerActorKind,
  WorkerReport,
} from "../domain/types.js";
import { fromSqliteInt, toSqliteInt, type Store, type StoreTx } from "./store.js";

// ============================================================================
// 行映射
// ============================================================================

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  return String(row[key] ?? "");
}

function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function num(row: Row, key: string): number {
  return Number(row[key] ?? 0);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 损坏的 JSON 不让整个读路径崩溃——退回默认值，由调用方按缺失处理
    return fallback;
  }
}

function mapTrigger(row: Row): Trigger {
  return {
    id: str(row, "id"),
    sourceId: str(row, "source_id"),
    idempotencyKey: str(row, "idempotency_key"),
    actor: str(row, "actor"),
    actorKind: str(row, "actor_kind") as TriggerActorKind,
    addressed: fromSqliteInt(row["addressed"]),
    text: str(row, "text"),
    createdAt: str(row, "created_at"),
    meta: parseJson<Record<string, unknown>>(row["meta"], {}),
  };
}

function mapThread(row: Row): Thread {
  return {
    id: str(row, "id"),
    sourceId: str(row, "source_id"),
    active: fromSqliteInt(row["active"]),
    meta: parseJson<Record<string, unknown>>(row["meta"], {}),
  };
}

function mapDisposition(row: Row): Disposition {
  return {
    id: str(row, "id"),
    triggerId: str(row, "trigger_id"),
    kind: str(row, "kind") as DispositionKind,
    at: str(row, "at"),
    detail: parseJson<Record<string, unknown>>(row["detail"], {}),
  };
}

function mapTicket(row: Row): Ticket {
  return {
    id: str(row, "id"),
    state: str(row, "state") as TicketState,
    origin: parseJson<string[]>(row["origin"], []),
    mandate: parseJson(row["mandate"], {
      policyVersion: 0,
      scope: "",
      strength: "inferred" as Strength,
      matchedRules: [] as string[],
      actor: "",
      sourceId: "",
    }),
    execution: parseJson(row["execution"], {
      name: "",
      directory: "",
      assignmentId: null as string | null,
      role: "solo-coder",
    }),
    latestReport: row["latest_report"] ? parseJson<WorkerReport | null>(row["latest_report"], null) : null,
    createdAt: str(row, "created_at"),
    endedAt: strOrNull(row, "ended_at"),
    endedBy: strOrNull(row, "ended_by"),
    endedReason: strOrNull(row, "ended_reason"),
  };
}

function mapAssignment(row: Row): Assignment {
  return {
    id: str(row, "id"),
    ticketId: str(row, "ticket_id"),
    state: str(row, "state") as AssignmentState,
    workerSessionId: strOrNull(row, "worker_session_id"),
    startedAt: strOrNull(row, "started_at"),
    endedAt: strOrNull(row, "ended_at"),
    report: row["report"] ? parseJson<WorkerReport | null>(row["report"], null) : null,
  };
}

function mapDecision(row: Row): Decision {
  return {
    id: str(row, "id"),
    threadId: str(row, "thread_id"),
    kind: str(row, "kind") as DecisionKind,
    strength: str(row, "strength") as Strength,
    reason: str(row, "reason"),
    wouldAccept: fromSqliteInt(row["would_accept"]),
    at: str(row, "at"),
  };
}

/**
 * 映射历史研判经验行
 *
 * `trigger_*` 列由 LEFT JOIN 派生，可能全为 NULL → `trigger` 为 null。
 */
function mapHistoricalDecision(row: Row): HistoricalDecision {
  const triggerId = strOrNull(row, "trigger_id");
  const triggerText = strOrNull(row, "trigger_text");
  const triggerCreatedAt = strOrNull(row, "trigger_created_at");
  const triggerActorKind = strOrNull(row, "trigger_actor_kind");
  const triggerAddressed = row["trigger_addressed"];

  return {
    id: str(row, "decision_id"),
    threadId: str(row, "thread_id"),
    sourceId: str(row, "source_id"),
    kind: str(row, "kind") as DecisionKind,
    strength: str(row, "strength") as Strength,
    reason: str(row, "reason"),
    wouldAccept: fromSqliteInt(row["would_accept"]),
    at: str(row, "at"),
    trigger:
      triggerId === null || triggerText === null || triggerCreatedAt === null
        ? null
        : {
            id: triggerId,
            sourceId: str(row, "source_id"),
            idempotencyKey: str(row, "trigger_idempotency_key"),
            actor: str(row, "trigger_actor"),
            // `trigger.actor_kind` 是 NOT NULL 列——只有数据被外部破坏时才可能为空
            actorKind: (triggerActorKind === "bot" ? "bot" : "human") as TriggerActorKind,
            addressed:
              triggerAddressed === null || triggerAddressed === undefined ? false : fromSqliteInt(triggerAddressed),
            text: triggerText,
            createdAt: triggerCreatedAt,
            meta: parseJson<Record<string, unknown>>(row["trigger_meta"], {}),
          },
  };
}

function mapEvalState(row: Row): EvalState {
  return {
    threadId: str(row, "thread_id"),
    batch: parseJson<string[]>(row["batch"], []),
    deadlineAt: strOrNull(row, "deadline_at"),
    candidateDelivered: fromSqliteInt(row["candidate_delivered"]),
    expiredCount: num(row, "expired_count"),
  };
}

function mapTicketInput(row: Row): TicketInput {
  return {
    id: str(row, "id"),
    ticketId: str(row, "ticket_id"),
    kind: str(row, "kind") as TicketInputKind,
    body: str(row, "body"),
    deliveredAt: strOrNull(row, "delivered_at"),
    createdAt: str(row, "created_at"),
  };
}

function mapAttention(row: Row): Attention {
  return {
    id: str(row, "id"),
    ticketId: str(row, "ticket_id"),
    question: str(row, "question"),
    options: parseJson<string[]>(row["options"], []),
    blocking: fromSqliteInt(row["blocking"]),
    createdAt: str(row, "created_at"),
    resolvedAt: strOrNull(row, "resolved_at"),
    resolution: strOrNull(row, "resolution"),
  };
}

function mapTicketMessage(row: Row): TicketMessage {
  return {
    id: str(row, "id"),
    ticketId: str(row, "ticket_id"),
    direction: str(row, "direction") as TicketMessageDirection,
    body: str(row, "body"),
    state: str(row, "state") as TicketMessageState,
    attempts: num(row, "attempts"),
    createdAt: str(row, "created_at"),
  };
}

// ============================================================================
// 仓储
// ============================================================================

/**
 * SuperAgentRepositories —— 领域实体的持久化入口
 *
 * 所有写操作都要求调用方提供 `StoreTx`（由 Engine 在 `store.atomic()` 内传入），
 * **仓储自身不开事务**——这是 I2「事务与副作用分离」得以成立的前提。
 */
export class SuperAgentRepositories {
  /** 底层 Store（只用于读路径与取时钟） */
  private readonly store: Store;

  /**
   * 构造仓储
   *
   * @param store 底层 Store
   */
  constructor(store: Store) {
    this.store = store;
  }

  /**
   * 当前时间（ISO 8601）
   *
   * 供**只读派生层**（上下文装配、历史召回）取时钟——
   * 这样它们只依赖仓储，不必反向依赖 Engine（Engine 依赖执行器，
   * 执行器再回指 Engine 会形成构造期循环）。
   *
   * @returns ISO 8601 时间串
   */
  now(): string {
    return this.store.now();
  }

  // ---------------------------------------------------------------- Trigger

  /**
   * 按幂等键查找 Trigger
   *
   * @param sourceId 来源 Source ID
   * @param idempotencyKey 幂等键
   * @returns Trigger 或 undefined
   */
  findTriggerByIdempotency(sourceId: string, idempotencyKey: string): Trigger | undefined {
    const row = this.store.queryOne<Row>("SELECT * FROM trigger WHERE source_id = ? AND idempotency_key = ?", [
      sourceId,
      idempotencyKey,
    ]);
    return row === undefined ? undefined : mapTrigger(row);
  }

  /**
   * 按 ID 查找 Trigger
   *
   * @param id Trigger ID
   * @returns Trigger 或 undefined
   */
  findTrigger(id: string): Trigger | undefined {
    const row = this.store.queryOne<Row>("SELECT * FROM trigger WHERE id = ?", [id]);
    return row === undefined ? undefined : mapTrigger(row);
  }

  /**
   * 插入 Trigger
   *
   * @param tx 事务句柄
   * @param trigger Trigger 实体
   */
  insertTrigger(tx: StoreTx, trigger: Trigger): void {
    tx.prepare(
      `INSERT INTO trigger
         (id, source_id, idempotency_key, actor, actor_kind, addressed, text, created_at, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      trigger.id,
      trigger.sourceId,
      trigger.idempotencyKey,
      trigger.actor,
      trigger.actorKind,
      toSqliteInt(trigger.addressed),
      trigger.text,
      trigger.createdAt,
      JSON.stringify(trigger.meta)
    );
  }

  // ----------------------------------------------------------------- Thread

  /**
   * 按 ID 查找 Thread
   *
   * @param id Thread ID
   * @returns Thread 或 undefined
   */
  findThread(id: string): Thread | undefined {
    const row = this.store.queryOne<Row>("SELECT * FROM thread WHERE id = ?", [id]);
    return row === undefined ? undefined : mapThread(row);
  }

  /**
   * 列出全部活跃 Thread
   *
   * @returns Thread 列表
   */
  listActiveThreads(): Thread[] {
    return this.store.query<Row>("SELECT * FROM thread WHERE active = 1 ORDER BY rowid ASC").map(mapThread);
  }

  /**
   * 插入或更新 Thread
   *
   * @param tx 事务句柄
   * @param thread Thread 实体
   */
  upsertThread(tx: StoreTx, thread: Thread): void {
    tx.prepare(
      `INSERT INTO thread (id, source_id, active, meta)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source_id = excluded.source_id,
         active = excluded.active,
         meta = excluded.meta`
    ).run(thread.id, thread.sourceId, toSqliteInt(thread.active), JSON.stringify(thread.meta));
  }

  /**
   * 更新 Thread 的活跃标志
   *
   * @param tx 事务句柄
   * @param threadId Thread ID
   * @param active 是否活跃
   */
  setThreadActive(tx: StoreTx, threadId: string, active: boolean): void {
    tx.prepare("UPDATE thread SET active = ? WHERE id = ?").run(toSqliteInt(active), threadId);
  }

  // ------------------------------------------------------- Trigger ↔ Thread

  /**
   * 关联 Trigger 与 Thread
   *
   * @param tx 事务句柄
   * @param triggerId Trigger ID
   * @param threadId Thread ID
   * @param at 关联时间
   */
  linkTriggerThread(tx: StoreTx, triggerId: string, threadId: string, at: string): void {
    tx.prepare("INSERT OR IGNORE INTO trigger_thread (trigger_id, thread_id, at) VALUES (?, ?, ?)").run(
      triggerId,
      threadId,
      at
    );
  }

  /**
   * 列出某 Thread 下的 Trigger
   *
   * @param threadId Thread ID
   * @param limit 数量上限
   * @returns Trigger 列表（按时间正序）
   */
  listThreadTriggers(threadId: string, limit = 50): Trigger[] {
    return this.store
      .query<Row>(
        `SELECT t.* FROM trigger t
         JOIN trigger_thread tt ON tt.trigger_id = t.id
         WHERE tt.thread_id = ?
         ORDER BY t.created_at ASC, t.rowid ASC
         LIMIT ?`,
        [threadId, limit]
      )
      .map(mapTrigger);
  }

  // ------------------------------------------------------------ Disposition

  /**
   * 插入处置轨迹
   *
   * @param tx 事务句柄
   * @param disposition Disposition 实体
   */
  insertDisposition(tx: StoreTx, disposition: Disposition): void {
    tx.prepare("INSERT INTO disposition (id, trigger_id, kind, at, detail) VALUES (?, ?, ?, ?, ?)").run(
      disposition.id,
      disposition.triggerId,
      disposition.kind,
      disposition.at,
      JSON.stringify(disposition.detail)
    );
  }

  /**
   * 列出某 Trigger 的处置轨迹
   *
   * @param triggerId Trigger ID
   * @returns Disposition 列表
   */
  listDispositions(triggerId: string): Disposition[] {
    return this.store
      .query<Row>("SELECT * FROM disposition WHERE trigger_id = ? ORDER BY at ASC, rowid ASC", [triggerId])
      .map(mapDisposition);
  }

  /**
   * 统计某类处置的数量（**只读**）
   *
   * `fanned_out` 即「订阅直通」——触发事件命中订阅中的工单，
   * **不经过 Router 决策**。这是 `proposal-final.md` §5.2 的
   * `routed_via_subscription` 可观测量的真实来源。
   *
   * `evaluated` 即「进入 Eval」——触发事件成为待研判候选。
   *
   * @param kind 处置类型
   * @param since 只统计该时刻之后发生的（ISO 8601；缺省统计全部）
   * @returns 数量
   */
  countDispositionsByKind(kind: DispositionKind, since?: string): number {
    const row =
      since === undefined
        ? this.store.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM disposition WHERE kind = ?", [kind])
        : this.store.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM disposition WHERE kind = ? AND at >= ?", [
            kind,
            since,
          ]);
    return row?.n ?? 0;
  }

  // ---------------------------------------------------------------- Ticket

  /**
   * 按 ID 查找 Ticket
   *
   * @param id Ticket ID
   * @returns Ticket 或 undefined
   */
  findTicket(id: string): Ticket | undefined {
    const row = this.store.queryOne<Row>("SELECT * FROM ticket WHERE id = ?", [id]);
    return row === undefined ? undefined : mapTicket(row);
  }

  /**
   * 列出 Ticket
   *
   * @param state 状态过滤；undefined = 全部
   * @param limit 数量上限
   * @returns Ticket 列表（按创建时间倒序）
   */
  listTickets(state?: TicketState, limit = 200): Ticket[] {
    const rows =
      state === undefined
        ? this.store.query<Row>("SELECT * FROM ticket ORDER BY created_at DESC, rowid DESC LIMIT ?", [limit])
        : this.store.query<Row>("SELECT * FROM ticket WHERE state = ? ORDER BY created_at DESC, rowid DESC LIMIT ?", [
            state,
            limit,
          ]);
    return rows.map(mapTicket);
  }

  /**
   * 插入 Ticket
   *
   * @param tx 事务句柄
   * @param ticket Ticket 实体
   */
  insertTicket(tx: StoreTx, ticket: Ticket): void {
    tx.prepare(
      `INSERT INTO ticket
         (id, state, origin, mandate, execution, latest_report, created_at, ended_at, ended_by, ended_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      ticket.id,
      ticket.state,
      JSON.stringify(ticket.origin),
      JSON.stringify(ticket.mandate),
      JSON.stringify(ticket.execution),
      ticket.latestReport === null ? null : JSON.stringify(ticket.latestReport),
      ticket.createdAt,
      ticket.endedAt,
      ticket.endedBy,
      ticket.endedReason
    );
  }

  /**
   * 更新 Ticket 的最新报告
   *
   * @param tx 事务句柄
   * @param ticketId Ticket ID
   * @param report 报告
   */
  updateTicketReport(tx: StoreTx, ticketId: string, report: WorkerReport): void {
    tx.prepare("UPDATE ticket SET latest_report = ? WHERE id = ?").run(JSON.stringify(report), ticketId);
  }

  /**
   * 更新 Ticket 的执行信息
   *
   * @param tx 事务句柄
   * @param ticketId Ticket ID
   * @param execution 执行信息
   */
  updateTicketExecution(tx: StoreTx, ticketId: string, execution: Ticket["execution"]): void {
    tx.prepare("UPDATE ticket SET execution = ? WHERE id = ?").run(JSON.stringify(execution), ticketId);
  }

  /**
   * 结束 Ticket
   *
   * @param tx 事务句柄
   * @param ticketId Ticket ID
   * @param by 结束者（"human" / "system" / "worker"）
   * @param reason 结束原因
   * @param at 结束时间
   */
  endTicket(tx: StoreTx, ticketId: string, by: string, reason: string, at: string): void {
    tx.prepare("UPDATE ticket SET state = 'ended', ended_at = ?, ended_by = ?, ended_reason = ? WHERE id = ?").run(
      at,
      by,
      reason,
      ticketId
    );
  }

  /**
   * 重新开放 Ticket（人的消息恢复）
   *
   * @param tx 事务句柄
   * @param ticketId Ticket ID
   */
  reopenTicket(tx: StoreTx, ticketId: string): void {
    tx.prepare(
      "UPDATE ticket SET state = 'open', ended_at = NULL, ended_by = NULL, ended_reason = NULL WHERE id = ?"
    ).run(ticketId);
  }

  // ------------------------------------------------------------ Assignment

  /**
   * 按 ID 查找 Assignment
   *
   * @param id Assignment ID
   * @returns Assignment 或 undefined
   */
  findAssignment(id: string): Assignment | undefined {
    const row = this.store.queryOne<Row>("SELECT * FROM assignment WHERE id = ?", [id]);
    return row === undefined ? undefined : mapAssignment(row);
  }

  /**
   * 列出某 Ticket 的 Assignment
   *
   * @param ticketId Ticket ID
   * @returns Assignment 列表
   */
  listAssignments(ticketId: string): Assignment[] {
    return this.store
      .query<Row>("SELECT * FROM assignment WHERE ticket_id = ? ORDER BY rowid ASC", [ticketId])
      .map(mapAssignment);
  }

  /**
   * 插入 Assignment
   *
   * @param tx 事务句柄
   * @param assignment Assignment 实体
   */
  insertAssignment(tx: StoreTx, assignment: Assignment): void {
    tx.prepare(
      `INSERT INTO assignment
         (id, ticket_id, state, worker_session_id, started_at, ended_at, report)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      assignment.id,
      assignment.ticketId,
      assignment.state,
      assignment.workerSessionId,
      assignment.startedAt,
      assignment.endedAt,
      assignment.report === null ? null : JSON.stringify(assignment.report)
    );
  }

  /**
   * 更新 Assignment 状态
   *
   * @param tx 事务句柄
   * @param id Assignment ID
   * @param patch 待更新字段
   */
  updateAssignment(
    tx: StoreTx,
    id: string,
    patch: {
      readonly state?: AssignmentState;
      readonly workerSessionId?: string | null;
      readonly startedAt?: string | null;
      readonly endedAt?: string | null;
      readonly report?: WorkerReport | null;
    }
  ): void {
    const current = this.findAssignment(id);
    if (current === undefined) return;
    tx.prepare(
      `UPDATE assignment
       SET state = ?, worker_session_id = ?, started_at = ?, ended_at = ?, report = ?
       WHERE id = ?`
    ).run(
      patch.state ?? current.state,
      patch.workerSessionId === undefined ? current.workerSessionId : patch.workerSessionId,
      patch.startedAt === undefined ? current.startedAt : patch.startedAt,
      patch.endedAt === undefined ? current.endedAt : patch.endedAt,
      patch.report === undefined
        ? current.report === null
          ? null
          : JSON.stringify(current.report)
        : patch.report === null
          ? null
          : JSON.stringify(patch.report),
      id
    );
  }

  // ----------------------------------------------------------- Subscription

  /**
   * 插入订阅
   *
   * @param tx 事务句柄
   * @param subscription Subscription 实体
   */
  insertSubscription(tx: StoreTx, subscription: Subscription): void {
    tx.prepare("INSERT OR IGNORE INTO subscription (ticket_id, thread_id, own) VALUES (?, ?, ?)").run(
      subscription.ticketId,
      subscription.threadId,
      toSqliteInt(subscription.own)
    );
  }

  /**
   * 列出订阅了某 Thread 的 Ticket
   *
   * @param threadId Thread ID
   * @returns Subscription 列表
   */
  listSubscriptionsByThread(threadId: string): Subscription[] {
    return this.store.query<Row>("SELECT * FROM subscription WHERE thread_id = ?", [threadId]).map((row) => ({
      ticketId: str(row, "ticket_id"),
      threadId: str(row, "thread_id"),
      own: fromSqliteInt(row["own"]),
    }));
  }

  /**
   * 列出某 Ticket 的订阅
   *
   * @param ticketId Ticket ID
   * @returns Subscription 列表
   */
  listSubscriptionsByTicket(ticketId: string): Subscription[] {
    return this.store.query<Row>("SELECT * FROM subscription WHERE ticket_id = ?", [ticketId]).map((row) => ({
      ticketId: str(row, "ticket_id"),
      threadId: str(row, "thread_id"),
      own: fromSqliteInt(row["own"]),
    }));
  }

  /**
   * 删除某 Thread 上某 Ticket 的订阅
   *
   * @param tx 事务句柄
   * @param ticketId Ticket ID
   * @param threadId Thread ID
   */
  removeSubscription(tx: StoreTx, ticketId: string, threadId: string): void {
    tx.prepare("DELETE FROM subscription WHERE ticket_id = ? AND thread_id = ?").run(ticketId, threadId);
  }

  // ------------------------------------------------------------ TicketInput

  /**
   * 插入 Ticket 输入
   *
   * @param tx 事务句柄
   * @param input TicketInput 实体
   */
  insertTicketInput(tx: StoreTx, input: TicketInput): void {
    tx.prepare(
      `INSERT INTO ticket_input (id, ticket_id, kind, body, delivered_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(input.id, input.ticketId, input.kind, input.body, input.deliveredAt, input.createdAt);
  }

  /**
   * 列出某 Ticket 尚未投递的输入
   *
   * @param ticketId Ticket ID
   * @returns TicketInput 列表
   */
  listPendingInputs(ticketId: string): TicketInput[] {
    return this.store
      .query<Row>(
        "SELECT * FROM ticket_input WHERE ticket_id = ? AND delivered_at IS NULL ORDER BY created_at ASC, rowid ASC",
        [ticketId]
      )
      .map(mapTicketInput);
  }

  /**
   * 标记输入已投递
   *
   * @param tx 事务句柄
   * @param inputId 输入 ID
   * @param deliveredAt 投递时间
   */
  markInputDelivered(tx: StoreTx, inputId: string, deliveredAt: string): void {
    tx.prepare("UPDATE ticket_input SET delivered_at = ? WHERE id = ?").run(deliveredAt, inputId);
  }

  /**
   * 列出某 Ticket 的全部输入
   *
   * @param ticketId Ticket ID
   * @returns TicketInput 列表
   */
  listInputs(ticketId: string): TicketInput[] {
    return this.store
      .query<Row>("SELECT * FROM ticket_input WHERE ticket_id = ? ORDER BY created_at ASC, rowid ASC", [ticketId])
      .map(mapTicketInput);
  }

  // --------------------------------------------------------------- Decision

  /**
   * 列出全部 Thread（含已结束的）
   *
   * @returns Thread 列表
   */
  listAllThreads(): Thread[] {
    return this.store.query<Row>("SELECT * FROM thread ORDER BY rowid ASC").map(mapThread);
  }

  /**
   * 列出最近的决策（跨全部 Thread）
   *
   * 用于 CLI 展示「本应接单但被影子记录」的候选——observe 模式的核心交付物。
   *
   * @param limit 数量上限
   * @returns Decision 列表（按时间倒序）
   */
  listRecentDecisions(limit = 50): Decision[] {
    return this.store
      .query<Row>("SELECT * FROM decision ORDER BY at DESC, rowid DESC LIMIT ?", [limit])
      .map(mapDecision);
  }

  /**
   * 插入 Decision
   *
   * @param tx 事务句柄
   * @param decision Decision 实体
   */
  insertDecision(tx: StoreTx, decision: Decision): void {
    tx.prepare(
      `INSERT INTO decision (id, thread_id, kind, strength, reason, would_accept, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      decision.id,
      decision.threadId,
      decision.kind,
      decision.strength,
      decision.reason,
      toSqliteInt(decision.wouldAccept),
      decision.at
    );
  }

  /**
   * 列出某 Thread 的 Decision 历史
   *
   * @param threadId Thread ID
   * @returns Decision 列表
   */
  listDecisions(threadId: string): Decision[] {
    return this.store
      .query<Row>("SELECT * FROM decision WHERE thread_id = ? ORDER BY at ASC, rowid ASC", [threadId])
      .map(mapDecision);
  }

  /**
   * 列出某 Source 的历史研判经验（**派生视图，零 schema 变更**）
   *
   * ## 派生来源
   *
   * `decision` ⋈ `thread`（按 Source 过滤）⋈ `trigger_thread` ⋈ `trigger`。
   * **不新增任何表、不改 `SCHEMA_VERSION`**——历史经验是既有事实的投影。
   *
   * ## Trigger 配对
   *
   * `decision` 表只有 `thread_id`，没有 `trigger_id`。配对规则见
   * {@link HistoricalDecision} 的文档注释：
   * 1. 该 Thread 中 `created_at <= decision.at` 的最近一条 Trigger；
   * 2. 没有则退化为该 Thread 最早的一条；
   * 3. 都没有则 `trigger` 为 null（该条历史仍会被召回流程按 Jaccard 门槛自然淘汰）。
   *
   * ## 只读
   *
   * 本方法只 `SELECT`，不写任何状态（I10：上下文只读）。
   *
   * @param sourceId Source ID
   * @param limit 数量上限（按决策时间倒序取前 N 条）
   * @returns 历史研判经验列表
   */
  listHistoricalDecisions(sourceId: string, limit = 50): HistoricalDecision[] {
    return this.store
      .query<Row>(
        `WITH recent_decisions AS (
           SELECT d.id AS decision_id, d.thread_id, d.kind, d.strength, d.reason,
                  d.would_accept, d.at, th.source_id AS source_id
           FROM decision d
           JOIN thread th ON th.id = d.thread_id
           WHERE th.source_id = ?
           ORDER BY d.at DESC, d.rowid DESC
           LIMIT ?
         ),
         paired AS (
           SELECT rd.*,
                  t.id AS trigger_id,
                  t.text AS trigger_text,
                  t.created_at AS trigger_created_at,
                  t.actor AS trigger_actor,
                  t.actor_kind AS trigger_actor_kind,
                  t.addressed AS trigger_addressed,
                  t.idempotency_key AS trigger_idempotency_key,
                  t.meta AS trigger_meta,
                  ROW_NUMBER() OVER (
                    PARTITION BY rd.decision_id
                    ORDER BY
                      -- 优先取决策时刻之前的 Trigger（按时间倒序 = 最近的在前）
                      CASE WHEN t.created_at <= rd.at THEN t.created_at END DESC,
                      -- 其次取决策时刻之后的（按时间正序 = 最早的在前）作为兜底
                      CASE WHEN t.created_at > rd.at THEN t.created_at END ASC
                  ) AS rn
           FROM recent_decisions rd
           LEFT JOIN trigger_thread tt ON tt.thread_id = rd.thread_id
           LEFT JOIN trigger t ON t.id = tt.trigger_id AND t.source_id = rd.source_id
         )
         SELECT decision_id, thread_id, source_id, kind, strength, reason, would_accept, at,
                trigger_id, trigger_text, trigger_created_at, trigger_actor, trigger_actor_kind,
                trigger_addressed, trigger_idempotency_key, trigger_meta
         FROM paired
         WHERE rn = 1
         ORDER BY at DESC`,
        [sourceId, limit]
      )
      .map(mapHistoricalDecision);
  }

  // --------------------------------------------------------------- EvalState

  /**
   * 按 Thread 查找 Eval 状态
   *
   * @param threadId Thread ID
   * @returns EvalState 或 undefined
   */
  findEvalState(threadId: string): EvalState | undefined {
    const row = this.store.queryOne<Row>("SELECT * FROM eval_state WHERE thread_id = ?", [threadId]);
    return row === undefined ? undefined : mapEvalState(row);
  }

  /**
   * 列出全部 Eval 状态
   *
   * @returns EvalState 列表
   */
  listEvalStates(): EvalState[] {
    return this.store.query<Row>("SELECT * FROM eval_state").map(mapEvalState);
  }

  /**
   * 写入（或覆盖）Eval 状态
   *
   * @param tx 事务句柄
   * @param state EvalState 实体
   */
  upsertEvalState(tx: StoreTx, state: EvalState): void {
    tx.prepare(
      `INSERT INTO eval_state (thread_id, batch, deadline_at, candidate_delivered, expired_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         batch = excluded.batch,
         deadline_at = excluded.deadline_at,
         candidate_delivered = excluded.candidate_delivered,
         expired_count = excluded.expired_count`
    ).run(
      state.threadId,
      JSON.stringify(state.batch),
      state.deadlineAt,
      toSqliteInt(state.candidateDelivered),
      state.expiredCount
    );
  }

  /**
   * 删除 Eval 状态
   *
   * @param tx 事务句柄
   * @param threadId Thread ID
   */
  deleteEvalState(tx: StoreTx, threadId: string): void {
    tx.prepare("DELETE FROM eval_state WHERE thread_id = ?").run(threadId);
  }

  // ----------------------------------------------------------------- Effect

  /**
   * 入队一个副作用
   *
   * 同 (kind, key) 再次入队 → **合并**（payload 覆盖、due_at 立即到期、seq 保留）。
   * 这是「按 kind/key 合并」语义的实现——直接 INSERT 会撞唯一约束。
   *
   * @param tx 事务句柄
   * @param effect 副作用载荷
   */
  enqueueEffect(
    tx: StoreTx,
    effect: {
      readonly kind: string;
      readonly key: string;
      readonly payload: unknown;
      readonly dueAt: string;
    }
  ): void {
    tx.prepare(
      `INSERT INTO effect (kind, key, payload, due_at, attempts, last_error)
       VALUES (?, ?, ?, ?, 0, NULL)
       ON CONFLICT(kind, key) DO UPDATE SET
         payload = excluded.payload,
         due_at = excluded.due_at,
         attempts = 0,
         last_error = NULL`
    ).run(effect.kind, effect.key, JSON.stringify(effect.payload), effect.dueAt);
  }

  /**
   * 列出到期的副作用
   *
   * @param now 当前时间（ISO 8601）
   * @param limit 数量上限
   * @returns Effect 行
   */
  listDueEffects(
    now: string,
    limit = 50
  ): Array<{
    seq: number;
    kind: string;
    key: string;
    payload: unknown;
    attempts: number;
  }> {
    return this.store
      .query<Row>("SELECT seq, kind, key, payload, attempts FROM effect WHERE due_at <= ? ORDER BY seq ASC LIMIT ?", [
        now,
        limit,
      ])
      .map((row) => ({
        seq: num(row, "seq"),
        kind: str(row, "kind"),
        key: str(row, "key"),
        payload: parseJson<unknown>(row["payload"], null),
        attempts: num(row, "attempts"),
      }));
  }

  /**
   * 标记副作用完成（删除队列行）
   *
   * @param tx 事务句柄
   * @param seq 队列序号
   */
  deleteEffect(tx: StoreTx, seq: number): void {
    tx.prepare("DELETE FROM effect WHERE seq = ?").run(seq);
  }

  /**
   * 标记副作用失败（累加次数、记录错误、按退避延后）
   *
   * @param tx 事务句柄
   * @param seq 队列序号
   * @param error 错误信息
   * @param nextDueAt 下次到期时间
   */
  markEffectFailed(tx: StoreTx, seq: number, error: string, nextDueAt: string): void {
    tx.prepare("UPDATE effect SET attempts = attempts + 1, last_error = ?, due_at = ? WHERE seq = ?").run(
      error,
      nextDueAt,
      seq
    );
  }

  /**
   * 统计队列积压
   *
   * @returns 各 kind 的待处理数量
   */
  countEffectsByKind(): Record<string, number> {
    const rows = this.store.query<Row>("SELECT kind, COUNT(*) AS n FROM effect GROUP BY kind ORDER BY kind ASC");
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[str(row, "kind")] = num(row, "n");
    }
    return result;
  }

  // ---------------------------------------------------------- TicketMessage

  /**
   * 插入写侧消息
   *
   * @param tx 事务句柄
   * @param message TicketMessage 实体
   */
  insertTicketMessage(tx: StoreTx, message: TicketMessage): void {
    tx.prepare(
      `INSERT INTO ticket_message (id, ticket_id, direction, body, state, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      message.id,
      message.ticketId,
      message.direction,
      message.body,
      message.state,
      message.attempts,
      message.createdAt
    );
  }

  /**
   * 列出某 Ticket 的消息
   *
   * @param ticketId Ticket ID
   * @returns TicketMessage 列表
   */
  listTicketMessages(ticketId: string): TicketMessage[] {
    return this.store
      .query<Row>("SELECT * FROM ticket_message WHERE ticket_id = ? ORDER BY created_at ASC, rowid ASC", [ticketId])
      .map(mapTicketMessage);
  }

  /**
   * 更新消息状态
   *
   * @param tx 事务句柄
   * @param id 消息 ID
   * @param state 新状态
   */
  updateTicketMessageState(tx: StoreTx, id: string, state: TicketMessageState): void {
    tx.prepare("UPDATE ticket_message SET state = ? WHERE id = ?").run(state, id);
  }

  // --------------------------------------------------------------- Attention

  /**
   * 插入 Attention
   *
   * @param tx 事务句柄
   * @param attention Attention 实体
   */
  insertAttention(tx: StoreTx, attention: Attention): void {
    tx.prepare(
      `INSERT INTO attention (id, ticket_id, question, options, blocking, created_at, resolved_at, resolution)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      attention.id,
      attention.ticketId,
      attention.question,
      JSON.stringify(attention.options),
      toSqliteInt(attention.blocking),
      attention.createdAt,
      attention.resolvedAt,
      attention.resolution
    );
  }

  /**
   * 列出未解决的 Attention
   *
   * @param ticketId Ticket ID；undefined = 全部
   * @returns Attention 列表
   */
  listOpenAttention(ticketId?: string): Attention[] {
    const rows =
      ticketId === undefined
        ? this.store.query<Row>("SELECT * FROM attention WHERE resolved_at IS NULL ORDER BY created_at ASC, rowid ASC")
        : this.store.query<Row>(
            "SELECT * FROM attention WHERE ticket_id = ? AND resolved_at IS NULL ORDER BY created_at ASC, rowid ASC",
            [ticketId]
          );
    return rows.map(mapAttention);
  }

  /**
   * 列出某 Ticket 的全部 Attention
   *
   * @param ticketId Ticket ID
   * @returns Attention 列表
   */
  listAttention(ticketId: string): Attention[] {
    return this.store
      .query<Row>("SELECT * FROM attention WHERE ticket_id = ? ORDER BY created_at ASC, rowid ASC", [ticketId])
      .map(mapAttention);
  }

  /**
   * 解决 Attention
   *
   * @param tx 事务句柄
   * @param id Attention ID
   * @param resolution 解决方案
   * @param resolvedAt 解决时间
   */
  resolveAttention(tx: StoreTx, id: string, resolution: string, resolvedAt: string): void {
    tx.prepare("UPDATE attention SET resolved_at = ?, resolution = ? WHERE id = ?").run(resolvedAt, resolution, id);
  }

  // --------------------------------------------------------------------- KV

  /**
   * 读取 KV
   *
   * @param key 键
   * @returns 值或 undefined
   */
  getKv(key: string): string | undefined {
    const row = this.store.queryOne<Row>("SELECT v FROM kv WHERE k = ?", [key]);
    return row === undefined ? undefined : str(row, "v");
  }

  /**
   * 写入 KV
   *
   * @param tx 事务句柄
   * @param key 键
   * @param value 值
   */
  setKv(tx: StoreTx, key: string, value: string): void {
    tx.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(key, value);
  }

  /**
   * 列出全部 KV 键
   *
   * @returns 键列表
   */
  listKvKeys(): string[] {
    return this.store.query<Row>("SELECT k FROM kv ORDER BY k ASC").map((row) => str(row, "k"));
  }
}
