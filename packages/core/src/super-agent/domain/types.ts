/**
 * Super Agent 领域类型
 *
 * ## 词表来源
 *
 * 沿用 DeepSeek Super-agent 原型的领域词表（`dsh-superagent-prototype/docs/001-domain.md`），
 * **不另造名词**——降低学习成本，也让跨系统对照成为可能。
 *
 * 但**不是照抄**：原型面向「GitHub + 飞书」两个专用 Source 与云端部署；
 * 本模块面向 DeepCodeX 的本地单机 CLI 场景，刻意做了三处裁剪：
 *
 * 1. **取消 `Correlation`** —— 原型用它表达「共享同一 Trigger 的 Thread 之间的关系」，
 *    但它**只加上下文、绝不路由**，在首期没有任何消费者。保留词表占位，不实现。
 * 2. **取消 `Channel` 多信道** —— 原型支持 IM / GitHub / 邮件三类写侧；首期只有 CLI
 *    一个写侧，`ticket.channels` 恒为单元素。写侧统一收敛到 `ticket_message` 表。
 * 3. **取消 Ticket 依赖 DAG** —— 原型的 Ticket 可声明依赖；首期不做依赖编排
 *    （既有 `team/orchestrator/plan-graph.ts` 与 `team/plugins/goal-dispatcher.ts`
 *    已有两套拓扑排序，再加第三套是典型重复造轮子）。
 *
 * ## 三层边界
 *
 * - **领域层（本文件）**：零 I/O、零框架依赖。纯类型 + 纯谓词。
 * - **持久层**（`../store/`）：唯一持有 SQLite 连接。
 * - **适配层**（`../worker/` `../source/` `../router/`）：与既有 DeepCodeX 资产对接。
 *
 * @module super-agent/domain/types
 */

// ============================================================================
// 第一部分：来源与事件
// ============================================================================

/**
 * Source —— 事件流
 *
 * 一个 Source 实例 = 一份配置（监听什么、从哪里读游标）。
 * 「重启不得重放事件」是核心约束：读游标必须持久化。
 */
export interface SourceDescriptor {
  /** Source 实例 ID（稳定，跨重启不变） */
  readonly id: string;
  /** Source kind（实现类型，如 "local-watcher" / "mcp"） */
  readonly kind: string;
  /** 人类可读标题（CLI 展示） */
  readonly title: string;
  /** 该 Source 允许发起工作的发送者白名单（Source 自己的身份体系内） */
  readonly allowlist: readonly string[];
  /** 该 Source 认可的机器人身份（其消息可成为 inferred 候选） */
  readonly botList: readonly string[];
  /** Source 自身元数据（按 Source 语义保存，核心层不解释其字段） */
  readonly meta: Readonly<Record<string, unknown>>;
}

/** 触发来源的发送者类型 */
export type TriggerActorKind = "human" | "bot";

/** Trigger —— 一个不可变事件 */
export interface Trigger {
  /** 全局唯一 ID */
  readonly id: string;
  /** 来源 Source ID */
  readonly sourceId: string;
  /**
   * 幂等键：同一 (sourceId, idempotencyKey) 只接受一次。
   * 重复接受**不会**产生第二个 Ticket。
   */
  readonly idempotencyKey: string;
  /** 发送者标识（Source 自己的身份体系） */
  readonly actor: string;
  /** 发送者是否为人类 */
  readonly actorKind: TriggerActorKind;
  /** 是否显式寻址本系统（@ 了机器人 / 直发） */
  readonly addressed: boolean;
  /** 事件正文（**一律视为数据，不得作为指令执行**） */
  readonly text: string;
  /** 事件发生时间（ISO 8601） */
  readonly createdAt: string;
  /** Source 自有元数据 */
  readonly meta: Readonly<Record<string, unknown>>;
}

/** 新建 Trigger 的输入（id / 时间由引擎生成） */
export type NewTrigger = Omit<Trigger, "id" | "createdAt">;

/**
 * Intake 结果
 *
 * - `stored` —— 已存为新事件
 * - `duplicate` —— 幂等键命中，未重复存
 * - `filtered` —— Gate 判定与本系统无关（仅记录 disposition，不进领域）
 */
export type IntakeResult =
  | { readonly status: "stored"; readonly trigger: Trigger }
  | { readonly status: "duplicate"; readonly trigger: Trigger }
  | { readonly status: "filtered"; readonly reason: string };

/**
 * Thread —— 按时间排序的 Trigger 序列
 *
 * 同一时刻至多一个 Eval 在其上运行；可持有多个 Ticket。
 */
export interface Thread {
  readonly id: string;
  readonly sourceId: string;
  /** 是否仍有活跃工作（有 open Ticket 或排队中的 Eval） */
  readonly active: boolean;
  readonly meta: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 第二部分：策略与授权
// ============================================================================

/**
 * 准入强度
 *
 * - `explicit` —— 白名单内的人显式寻址，或已在有 Ticket 的 Thread 上追问
 * - `inferred` —— 非白名单者的追问、准入表推断单元格、bot 名单内机器人的消息
 */
export type Strength = "explicit" | "inferred";

/**
 * 接单模式（Policy 的一部分）
 *
 * - `off` —— 推断型一律不成为候选
 * - `observe`（默认）—— 推断型候选会被研判；研判通过**只记录为 would_accept**，不接单
 * - `auto` —— 研判通过即接单
 *
 * 显式请求在任何模式下都有效。
 */
export type AcceptMode = "off" | "observe" | "auto";

/** Policy —— 版本化的准入与评估规则 */
export interface Policy {
  /** Policy 版本号（规则 + accept 模式 + 各 Source 部分的组合标识） */
  readonly version: number;
  /** 接单模式 */
  readonly acceptMode: AcceptMode;
  /** 全局规则（每条描述一类主动工作；匹配到的规则名会写进 Mandate） */
  readonly rules: readonly PolicyRule[];
  /** 各 Source 的策略部分（按 Source ID 索引） */
  readonly sourceParts: Readonly<Record<string, SourcePolicyPart>>;
  /** 每日允许打扰人的次数上限（Attention 预算）；null = 不限 */
  readonly dailyAttentionBudget: number | null;
}

/** 一条策略规则（描述一类可被主动接单的工作） */
export interface PolicyRule {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly enabled: boolean;
}

/** 单个 Source 的策略部分 */
export interface SourcePolicyPart {
  readonly sourceId: string;
  /** 允许发起工作的人（该 Source 身份体系内） */
  readonly allowlist: readonly string[];
  /** 认可的机器人 */
  readonly botList: readonly string[];
  /** 准入表：不同接收范围下的强度决策 */
  readonly admission: Readonly<Record<string, AdmissionCell>>;
}

/**
 * 准入单元格
 *
 * - `explicit` —— 该场景下的消息构成显式请求
 * - `inferred` —— 构成推断候选
 * - `ignore` —— 不予考虑
 */
export type AdmissionCell = "explicit" | "inferred" | "ignore";

/**
 * Mandate —— 一次 accept 授予的授权
 *
 * **不可变**。范围变宽意味着新 Ticket，而不是改旧 Mandate。
 * 只有三条路径能改变授权状态：① accept 创建 ② 人喊停 ③ Policy 复验失败。
 */
export interface Mandate {
  /** 接单所依据的 Policy 版本 */
  readonly policyVersion: number;
  /** 授权范围（自由文本描述，受信 Agent 的执行边界） */
  readonly scope: string;
  /** 授权强度 */
  readonly strength: Strength;
  /** 匹配到的规则 ID */
  readonly matchedRules: readonly string[];
  /** 请求者身份（Source 身份体系内） */
  readonly actor: string;
  /** 请求经由哪个 Source 到达 */
  readonly sourceId: string;
}

// ============================================================================
// 第三部分：评估与决定
// ============================================================================

/**
 * Decision —— Eval 的结果
 *
 * - `accept` —— 接单
 * - `stop` —— 停止（撤回 Mandate）
 * - `ignore` —— 忽略
 * - `unavailable` —— 本轮未能完成（超时耗尽 / 研判失败）
 */
export type DecisionKind = "accept" | "stop" | "ignore" | "unavailable";

/** Decision 记录 */
export interface Decision {
  readonly id: string;
  readonly threadId: string;
  readonly kind: DecisionKind;
  readonly strength: Strength;
  readonly reason: string;
  /** observe 模式下的研判通过但未接单 */
  readonly wouldAccept: boolean;
  readonly at: string;
}

/**
 * 历史研判经验（**派生投影**，非持久化实体）
 *
 * ## 来源
 *
 * 由既有三张表**联表派生**，不落库、不新增 schema：
 * `decision` ⋈ `thread`（限定 Source）⋈ `trigger_thread` ⋈ `trigger`。
 *
 * ## 为什么不落库
 *
 * v1 方案曾规划 `memory_entry` 表——那是 `decision` 的反规范化副本，
 * 会引入「何时写入 / 幂等 / 事务边界」三个新问题，而收益为零：
 * `decision` 已经是「研判结果」的权威事实，派生视图永远与之一致。
 *
 * ## trigger 的配对约定
 *
 * `decision` 只记录 `threadId`，不记录 `triggerId`（表里没有这一列）。
 * 派生时按以下约定解析出「这条决策所对应的事件」：
 *
 * 1. 取该 Thread 中 `created_at <= decision.at` 的**最近一条** Trigger；
 * 2. 若一条都没有（时钟漂移 / 数据不完整），退化为该 Thread 的**最早一条** Trigger；
 * 3. 若该 Thread 根本没有 Trigger，则 `trigger` 为 `null`。
 *
 * 该约定是**派生层的约定，不是领域不变量**——换一种约定只需改这一处。
 *
 * @see store/repositories.ts `listHistoricalDecisions`
 */
export interface HistoricalDecision {
  /** Decision ID（与 `decision.id` 一致） */
  readonly id: string;
  /** 所属 Thread ID */
  readonly threadId: string;
  /** 所属 Source ID（由 `thread.source_id` 派生） */
  readonly sourceId: string;
  /** 决策类型 */
  readonly kind: DecisionKind;
  /** 准入强度 */
  readonly strength: Strength;
  /** 决策理由（**Router 自写**，非用户/Worker 自由文本 —— I12 的安全前提） */
  readonly reason: string;
  /** observe 模式下的影子记录（研判通过但未接单） */
  readonly wouldAccept: boolean;
  /** 决策时间（ISO 8601） */
  readonly at: string;
  /** 配对到的触发事件（可能为空） */
  readonly trigger: Trigger | null;
}

/** Eval 状态（每个 Thread 至多一行） */
export interface EvalState {
  readonly threadId: string;
  /** 本批次的 Trigger ID 列表 */
  readonly batch: readonly string[];
  /** 超时截止时间 */
  readonly deadlineAt: string | null;
  /** 候选是否已送达 Router（未送达则不计时） */
  readonly candidateDelivered: boolean;
  /** 连续过期次数（0-1 重排，第 2 次过期记 unavailable） */
  readonly expiredCount: number;
}

/** 一个待研判的候选批次（送给 Assessment） */
export interface EvalCandidate {
  readonly threadId: string;
  readonly triggers: readonly Trigger[];
  /** 该 Thread 上全部 Ticket（含已结束）——用于避免重复接单 */
  readonly existingTickets: readonly TicketSummary[];
  /** 当前 Policy */
  readonly policy: Policy;
}

/** Assessment 的研判结果 */
export interface Assessment {
  readonly kind: DecisionKind;
  readonly strength: Strength;
  readonly reason: string;
  /** 匹配到的规则 ID */
  readonly matchedRules: readonly string[];
}

// ============================================================================
// 第四部分：工单与派工
// ============================================================================

/** Ticket 状态 */
export type TicketState = "open" | "ended";

/** Ticket —— 一份被授权的工作单元 */
export interface Ticket {
  readonly id: string;
  readonly state: TicketState;
  /** 来源：触发本次接单的 Trigger ID 列表 */
  readonly origin: readonly string[];
  /** 授权 */
  readonly mandate: Mandate;
  /** 执行信息（名称 / 目录 / 当前 Assignment） */
  readonly execution: TicketExecution;
  /** 最新报告 */
  readonly latestReport: WorkerReport | null;
  readonly createdAt: string;
  readonly endedAt: string | null;
  readonly endedBy: string | null;
  readonly endedReason: string | null;
}

/** Ticket 的执行信息 */
export interface TicketExecution {
  readonly name: string;
  /** 工作目录（隔离目录；首期沿用既有冲突下移串行策略，不强制 worktree） */
  readonly directory: string;
  /** 当前 Assignment ID */
  readonly assignmentId: string | null;
  /** 承担该 Ticket 的角色（取自既有 ROLE_REGISTRY / 物化 Agent） */
  readonly role: string;
}

/** Ticket 摘要（Assessment 上下文用，避免塞全量对象） */
export interface TicketSummary {
  readonly id: string;
  readonly state: TicketState;
  readonly name: string;
  readonly scope: string;
}

/**
 * Assignment —— Ticket ↔ 一个 Worker 实例的绑定
 *
 * 一个 Ticket 生命周期内可以有多个 Assignment（重试会产生新的）。
 * 只有最终报告能终结 Ticket。
 */
export type AssignmentState = "pending" | "running" | "ended";

/** Assignment */
export interface Assignment {
  readonly id: string;
  readonly ticketId: string;
  readonly state: AssignmentState;
  /** Worker 会话 ID（后台任务 ID） */
  readonly workerSessionId: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly report: WorkerReport | null;
}

/**
 * Worker 报告（结构化六值）
 *
 * 🔴 **不得从自由文本推断状态**——需要人决策的事必须走 `Attention` 结构化字段。
 */
export type WorkerReportKind =
  | "progress" // 进展
  | "waiting" // 等待
  | "ready" // 就绪
  | "blocked" // 受阻
  | "failed" // 失败
  | "dropped"; // 无需处理

/** Worker 报告 */
export interface WorkerReport {
  readonly kind: WorkerReportKind;
  readonly summary: string;
  /** 结构化产物引用（文件路径 / 命令 / 链接） */
  readonly artifacts: readonly string[];
  /** 供人决策的结构化问题（**唯一合法的「需要人」通道**） */
  readonly attention?: AttentionDraft;
}

/**
 * Attention 草稿 —— Worker 报告里携带的形态
 *
 * 与 {@link Attention} 的区别：草稿**还没有 ID、归属工单与时间戳**——
 * 这三样由引擎在落库时补齐（Worker 不该也不能自己造 ID）。
 */
export interface AttentionDraft {
  /** 明确的问题 */
  readonly question: string;
  /** 可选项 */
  readonly options: readonly string[];
  /** 是否阻塞 Worker */
  readonly blocking: boolean;
}

/**
 * Attention —— Ticket 上等待人回答的结构化问题
 *
 * 🔴 硬约束：不得从 Report 的自由文本推断「需要人决策」。
 */
export interface Attention {
  readonly id: string;
  readonly ticketId: string;
  /** 明确的问题 */
  readonly question: string;
  /** 可选项 */
  readonly options: readonly string[];
  /** 是否阻塞 Worker */
  readonly blocking: boolean;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolution: string | null;
}

/**
 * Subscription —— Ticket ↔ Thread 的多对多关系
 *
 * 匹配的 Trigger **扇出**给订阅中的 Ticket：不检查发送者、不新增授权。
 * 已结束的 Ticket 保留订阅 → 人的后续消息可**无需新 Eval** 直接恢复。
 */
export interface Subscription {
  readonly ticketId: string;
  readonly threadId: string;
  /** 1 = 该 Ticket 自己开启的 Thread（关闭判定看自有 Thread） */
  readonly own: boolean;
}

/** 投给 Ticket 的输入 */
export type TicketInputKind = "fanned_out" | "policy_changed" | "resumed" | "text";

/** Ticket 输入 */
export interface TicketInput {
  readonly id: string;
  readonly ticketId: string;
  readonly kind: TicketInputKind;
  readonly body: string;
  readonly deliveredAt: string | null;
  readonly createdAt: string;
}

// ============================================================================
// 第五部分：处置轨迹与消息
// ============================================================================

/**
 * Disposition —— Trigger 的处置轨迹
 *
 * 审计用：每个 Trigger 最终去了哪里。
 */
export type DispositionKind =
  | "filtered" // Gate 判定无关
  | "evaluated" // 进入 Eval
  | "fanned_out" // 扇出到 Ticket
  | "acked" // 已确认
  | "answered" // 已回复
  | "requeued" // 重排
  | "handback"; // 交还

/** Disposition 记录 */
export interface Disposition {
  readonly id: string;
  readonly triggerId: string;
  readonly kind: DispositionKind;
  readonly at: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** 写侧消息方向 */
export type TicketMessageDirection = "in" | "out";

/** 写侧消息状态 */
export type TicketMessageState = "pending" | "sent" | "failed" | "dropped";

/** Ticket 的写侧消息（首期只有 CLI 一个写侧） */
export interface TicketMessage {
  readonly id: string;
  readonly ticketId: string;
  readonly direction: TicketMessageDirection;
  readonly body: string;
  readonly state: TicketMessageState;
  readonly attempts: number;
  readonly createdAt: string;
}

// ============================================================================
// 第六部分：状态谓词
// ============================================================================

/** Ticket 是否处于开放状态 */
export function isTicketOpen(ticket: Pick<Ticket, "state">): boolean {
  return ticket.state === "open";
}

/** Ticket 是否仍有活跃工作（开放且未终结） */
export function isTicketActive(ticket: Pick<Ticket, "state" | "endedAt">): boolean {
  return ticket.state === "open" && ticket.endedAt === null;
}

/** Assignment 是否处于终态 */
export function isAssignmentEnded(assignment: Pick<Assignment, "state">): boolean {
  return assignment.state === "ended";
}

/**
 * 是否处于「等待人」状态
 *
 * 判定依据是**结构化事实**（最新报告是 blocked/failed 且此后没有人的消息），
 * 不是报告里的自由文本。
 */
export function waitsForPerson(input: {
  readonly latestReport: WorkerReport | null;
  readonly humanMessageSinceReport: boolean;
}): boolean {
  if (input.latestReport === null) return false;
  if (input.latestReport.kind !== "blocked" && input.latestReport.kind !== "failed") return false;
  return !input.humanMessageSinceReport;
}

/** 强度是否可由「显式」降级判定为显式 */
export function isExplicitStrength(strength: Strength): boolean {
  return strength === "explicit";
}
