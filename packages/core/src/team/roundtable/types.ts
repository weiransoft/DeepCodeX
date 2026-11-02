/**
 * 多角色群聊协作（Roundtable）领域类型
 *
 * 设计文档：`docs/team-roundtable-design-20261102.md`
 *
 * 与既有形态的边界：
 * - `/team dispatch --consensus`：单轮并行评审 + 一次聚合，无状态、无台账；
 * - `/team auto`：拆 DAG → 分层并行 → 聚合，是流水线；
 * - 本模块：**协商**——多轮讨论、规则判共识、分工、各角色自更新任务、并行执行、疑问回流。
 *
 * @module team/roundtable/types
 */

import type { RoleDefinition } from "../types.js";

/** 角色对当前草案的立场（每个角色每轮必须给一个） */
export type RoundtablePosture = "support" | "refine" | "object";

/** 整次 roundtable 的终态 */
export type RoundtableStatus =
  /** 达成共识且执行结束 */
  | "consensus"
  /** 讨论轮用尽仍未收敛（不假装成功） */
  | "unresolved"
  /** 达成分歧度可接受的结果，但有效发言覆盖率不足（由 note 说明） */
  | "degraded"
  /** 无模型凭据，未执行 */
  | "skipped"
  /** 编排层异常 */
  | "failed"
  /** 外部中止 */
  | "aborted";

/** 消息类别（决定宿主怎么渲染，不参与判定逻辑） */
export type RoundtableMessageKind =
  | "opening"
  | "speech"
  | "focus"
  | "decision"
  | "assignment"
  | "task-update"
  | "execution"
  | "question"
  | "amendment"
  | "note";

/** 单条房间消息（transcript 的最小单位） */
export interface RoundtableMessage {
  /** 房间内唯一 id（`m1`、`m2`…），供角色 `replyTo` 引用 */
  id: string;
  /** 所属轮次：0 = 开场陈述，>=1 = 讨论轮 */
  round: number;
  kind: RoundtableMessageKind;
  roleId: string;
  roleName: string;
  content: string;
  posture?: RoundtablePosture;
  blocking?: boolean;
  replyTo?: string;
  createdAt: string;
}

/**
 * 一次发言的解析结果
 *
 * `unparsed` 为 true 表示模型没给出可解析的 JSON——按设计文档第九节，
 * 这类发言一律按 `refine` 计入（保守：不当成同意），并计入质量指标。
 */
export interface RoundtableSpeech {
  roleId: string;
  roleName: string;
  posture: RoundtablePosture;
  blocking: boolean;
  replyTo?: string;
  keyPoints: string[];
  questions: string[];
  content: string;
  /** 模型输出无法解析为约定 JSON */
  unparsed?: boolean;
  /** 发言调用本身失败（超时 / 报错 / 空响应）——该角色本轮记为 silent */
  error?: string;
}

/** 一条任务分工（由主持人从共识中产出） */
export interface RoundtableAssignment {
  roleId: string;
  roleName: string;
  /** 执行边界：允许改动的范围（文件/模块/目录） */
  scope: string;
  /** 交付物 */
  deliverable: string;
  /** 验收标准（角色自证方式） */
  acceptance: string;
  /** 依赖的角色（这些角色应先完成；空数组表示无依赖） */
  dependsOn: string[];
}

/** 共识决议 */
export interface RoundtableDecision {
  /** 达成本决议时的轮次 */
  round: number;
  /** 决议正文 */
  summary: string;
  /** 逐条决议 */
  decisions: string[];
  /** 仍未决、留给人类的问题 */
  openQuestions: string[];
  /** 任务台账 */
  assignments: RoundtableAssignment[];
}

/** 角色对「自己那条 assignment」的再表达（执行前的自检） */
export interface RoundtableTaskUpdate {
  /** 我理解我的任务是…… */
  restated: string;
  steps: string[];
  acceptance: string;
  /** 自检发现共识有洞 → 先回流讨论，不进入执行 */
  needDiscussion: boolean;
  question: string;
}

/** 共识判定结果（由规则产出，不由模型宣布） */
export interface RoundtableVerdict {
  kind: "consensus" | "converging" | "diverging";
  /** 阻断性反对（一票否决） */
  blocking: Array<{ roleId: string; roleName: string; reason: string }>;
  /** 非阻断反对 */
  dissent: Array<{ roleId: string; roleName: string; reason: string }>;
  /** 本轮未给出有效发言的角色 */
  silent: string[];
  /** 有效发言覆盖率 = 有效发言数 / 参与角色数 */
  coverage: number;
}

/** 单个角色的执行报告 */
export interface RoundtableExecution {
  roleId: string;
  roleName: string;
  status: "completed" | "failed" | "aborted" | "skipped";
  /** 执行摘要（模型自述） */
  summary: string;
  /** 执行中被改动的文件（模型自报，用于人工复核；不是安全边界） */
  filesTouched: string[];
  /** 执行中提出的、需要群里回答的问题（触发回流） */
  questions: string[];
  /** 因「后台无人审批」被自动拒绝的工具（沿用 D2 的语义） */
  deniedTools: Array<{ tool: string; reason: string }>;
  /**
   * 执行模式：
   * - tool：注入了 runner，具备真实工具能力
   * - text：未注入 runner，只产出文本建议（不是"改完了"，报告里必须标注）
   */
  mode: "tool" | "text";
  error?: string;
}

/** 疑问回流产生的共识修订 */
export interface RoundtableAmendment {
  id: string;
  /** 触发本次修订的提问角色 */
  triggeredBy: string[];
  /** 问题原文（多个问题以换行合并） */
  question: string;
  /** 对共识的修订内容 */
  change: string;
  /** 需要按修订重跑的角色 */
  affectedRoles: string[];
  createdAt: string;
}

/** 编排选项 */
export interface RoundtableOptions {
  projectRoot: string;
  /** 会议目标（用户原话） */
  task: string;
  /** 参与者（不含主持人） */
  participants: ReadonlyArray<RoleDefinition>;
  /** 主持人：推进议程、起草决议，但**无权宣布共识** */
  moderator: RoleDefinition;
  /** 讨论轮次上限（默认 3） */
  maxRounds?: number;
  /** 回流次数上限（默认 1） */
  maxEscalations?: number;
  /** 单次发言超时（默认 120s） */
  speakTimeoutMs?: number;
  /** 执行阶段单角色工具轮次上限（默认 8，与 dispatch 默认一致） */
  maxToolRounds?: number;
  /** 注入的 LLM 句柄（测试专用；生产由 createOpenAIClient 构造） */
  injectedClient?: unknown;
  /** 工具执行器（宿主注入；未注入则执行阶段降级为文本建议） */
  runner?: unknown;
  /** 每条消息产出即回调（宿主用于实时渲染） */
  onMessage?: (message: RoundtableMessage) => void;
  /** 人类可读进度（宿主用于进度条/日志） */
  onProgress?: (message: string) => void;
  /** 外部中止 */
  signal?: AbortSignal;
}

/** 编排结果 */
export interface RoundtableResult {
  status: RoundtableStatus;
  /** 未达成共识时为 null */
  decision: RoundtableDecision | null;
  executions: RoundtableExecution[];
  amendments: RoundtableAmendment[];
  messages: RoundtableMessage[];
  /** 实际消耗的讨论轮次 */
  rounds: number;
  /** 实际消耗的回流次数 */
  escalations: number;
  durationMs: number;
  /** 未结构化发言数（质量指标） */
  unparsedSpeeches: number;
  /** 降级/未达成的说明（status 非 consensus 时必有） */
  note?: string;
}
