/**
 * 计划层领域类型 —— 动态分解、工作流与团队
 *
 * ## 与既有概念的边界
 *
 * | 概念 | 归属 | 含义 |
 * |---|---|---|
 * | `Ticket` | 领域 | 一份被授权的工作单元（一个请求 = 一张工单） |
 * | `WorkPlan` | 本模块 | 工单内部的**执行计划**：把工单目标拆成步骤并组队 |
 * | `PlanStep` | 本模块 | 计划中的一步：一个角色、一个交付物、一组前置依赖 |
 * | `Assignment` | 领域 | 某个步骤的**一次执行**（重试会产生新 Assignment） |
 *
 * 换句话说：工单回答「这件事被授权了吗」，计划回答「这件事怎么做」，
 * Assignment 回答「这一刻谁在做」。
 *
 * ## 为什么不做第三套拓扑排序
 *
 * 方案 §1.2 明确不复用 `team/orchestrator/plan-graph.ts` / `goal-dispatcher.ts`
 * 的拓扑实现，也**不新增**第三套通用图算法——本模块只做**波次划分**
 * （Kahn 分层，见 `planner/waves.ts`），因为执行语义只需要「哪些步骤可以同批跑」，
 * 不需要完整的任务图调度（无资源约束、无优先级抢占、无关键路径）。
 *
 * @module super-agent/planner/types
 */

/** 步骤执行状态 */
export type PlanStepState =
  /** 尚未派工（依赖未满足） */
  | "pending"
  /** 已派工，Worker 运行中 */
  | "running"
  /** 已交付（Worker 报告 ready/dropped） */
  | "ready"
  /** 失败（Worker 报告 failed） */
  | "failed";

/** 计划中的一步 */
export interface PlanStep {
  /** 步骤 ID（`s1` / `s2` …，由解析器生成，稳定用于依赖引用） */
  readonly id: string;
  /** 步骤标题（人可读，≤ 120 字） */
  readonly title: string;
  /** 承担角色 ID（必须存在于角色注册表，否则回落 `solo-coder`） */
  readonly role: string;
  /** 前置步骤 ID 列表（空 = 首波） */
  readonly dependsOn: readonly string[];
  /** 交付物描述（写给「下游步骤」看的交接口径） */
  readonly deliverable: string;
}

/** 团队成员（由步骤的角色聚合而来，不单独持久化） */
export interface TeamMember {
  /** 角色 ID */
  readonly role: string;
  /** 角色显示名 */
  readonly name: string;
  /** 该成员在本次计划中的职责摘要 */
  readonly responsibility: string;
  /** 该成员承担的步骤 ID */
  readonly stepIds: readonly string[];
}

/**
 * 执行计划
 *
 * **不可变**（`readonly`）：计划一旦落库就不再改写；步骤进度记录在 `plan_step` 表，
 * 与计划本身分离——这样「计划是什么」与「做到哪了」是两个可独立审计的事实。
 */
export interface WorkPlan {
  /** 计划格式版本（结构变更时递增；解析器拒绝未知版本） */
  readonly version: 1;
  /** 目标（一句话，来自授权范围） */
  readonly objective: string;
  /** 整体策略（为什么这样拆） */
  readonly strategy: string;
  /** 步骤列表（DAG，无环、无自依赖） */
  readonly steps: readonly PlanStep[];
  /** 团队（按角色聚合） */
  readonly team: readonly TeamMember[];
  /** 计划来源：`llm` = 模型生成；`fallback` = 降级为单步（行为与旧版一致） */
  readonly source: PlanSource;
  /** 生成过程中的告警（如角色不存在被回落、字段被截断）——**不静默丢弃** */
  readonly warnings: readonly string[];
  /** 生成时间（ISO 8601） */
  readonly createdAt: string;
}

/** 计划来源 */
export type PlanSource = "llm" | "fallback";

/** 一个执行波次（同批可并行的步骤） */
export interface PlanWave {
  /** 波次序号（0 起） */
  readonly index: number;
  /** 本波步骤 ID（按计划顺序） */
  readonly stepIds: readonly string[];
}

/** 步骤运行时状态（`plan_step` 表的行） */
export interface PlanStepStateRecord {
  /** 工单 ID */
  readonly ticketId: string;
  /** 步骤 ID */
  readonly stepId: string;
  /** 所属波次 */
  readonly wave: number;
  /** 状态 */
  readonly state: PlanStepState;
  /** 角色（冗余存储，便于不加载计划就能展示进度） */
  readonly role: string;
  /** 承担该步骤的 Assignment（`null` = 尚未派工） */
  readonly assignmentId: string | null;
  /** 开始时间 */
  readonly startedAt: string | null;
  /** 结束时间 */
  readonly endedAt: string | null;
  /** 该步骤的交付摘要（Worker 报告的 summary） */
  readonly summary: string | null;
}

/** 计划解析 / 校验结果 */
export type PlanParseResult =
  | { readonly ok: true; readonly plan: WorkPlan }
  | { readonly ok: false; readonly reason: string };

/** 计划生成输入 */
export interface PlanRequest {
  /** 工单 ID（仅用于提示与日志） */
  readonly ticketId: string;
  /** 工单名称（通常是请求首行） */
  readonly ticketName: string;
  /** 授权范围（**计划的边界**：不得规划超出范围的工作） */
  readonly scope: string;
}

/** 未满足依赖（诊断用） */
export interface BlockedStep {
  /** 步骤 ID */
  readonly stepId: string;
  /** 尚未完成的依赖 */
  readonly missingDependsOn: readonly string[];
}
