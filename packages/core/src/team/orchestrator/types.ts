/**
 * 自动多角色拆解（L2）类型与预算
 *
 * ## 语义边界
 *
 * 本模块描述的是「一次编排」：用户给一个目标，拆成若干有依赖的子任务，
 * 按层执行，最后汇总。它**不**替换 `executeDispatch`——后者是「一个任务派给
 * 一个角色」的执行单元，编排只是它的调用者。
 *
 * ## 拆解产物为何要做全量校验
 *
 * `subtasks[]` 来自 LLM 输出，属于**不可信输入**：可能含环、悬空依赖、重复 id、
 * 甚至被提示注入诱导写上 `/etc/passwd` 这样的路径。因此 `plan-graph.ts` 把
 * 校验做成独立的纯函数层，编排主流程只消费「已校验的 plan」。
 *
 * @module team/orchestrator/types
 */

import { z } from "zod";

/** 子任务 id 约束：短、可读、出现在日志与报告中不刺眼 */
export const SUBTASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;

/** 单个子任务的描述长度上限（防止拆解器把整篇文档塞进来） */
export const MAX_SUBTASK_DESCRIPTION_LENGTH = 4000;

/**
 * 拆解出的子任务节点
 *
 * 字段全部保守：`roleHint` / `files` / `acceptance` 都可缺省，
 * 缺省时编排照常工作（roleHint 缺失 → 走自动匹配；files 缺失 → 不参与冲突检测）。
 */
export const SubtaskNode = z.object({
  id: z.string(),
  title: z.string().min(1),
  /** 完整任务描述，直接作为 dispatch 的 task.description */
  description: z.string(),
  /** 建议角色 id（命中候选集则转 forceRole，未命中则忽略并走匹配） */
  roleHint: z.string().optional(),
  /** 前置子任务 id 列表 */
  dependsOn: z.array(z.string()).default([]),
  /** 声明会改动的文件（项目内相对路径），用于同层写冲突消解 */
  files: z.array(z.string()).default([]),
  /** 完成判据（仅进入 prompt 与报告，不参与自动判定） */
  acceptance: z.string().optional(),
});
export type SubtaskNode = z.infer<typeof SubtaskNode>;

/** 拆解计划 */
export const OrchestrationPlan = z.object({
  /** 拆解理由（进入报告，帮助用户判断拆得是否合理） */
  rationale: z.string().default(""),
  subtasks: z.array(SubtaskNode),
});
export type OrchestrationPlan = z.infer<typeof OrchestrationPlan>;

/**
 * 编排预算
 *
 * `totalToolRounds` 是硬预算：编排放任 6 个子任务各自跑满 8 轮，
 * 一次误触发的成本不可接受，因此全局配额扣完即停。
 */
export const OrchestrationBudget = z.object({
  maxSubtasks: z.number().int().positive().max(12).default(6),
  maxParallel: z.number().int().positive().max(4).default(2),
  /** 单子任务工具轮次（透传 DispatchOptions.maxToolRounds） */
  maxToolRounds: z.number().int().positive().max(50).default(8),
  /** 全局工具轮次预算（所有子任务合计） */
  totalToolRounds: z.number().int().positive().max(200).default(32),
});
export type OrchestrationBudget = z.infer<typeof OrchestrationBudget>;

/** 子任务终态（不含"running"：结果对象只在结束后产出） */
export type SubtaskStatus = "succeeded" | "failed" | "skipped" | "cancelled";

/** 单个子任务的执行结果 */
export interface OrchestrationSubtaskResult {
  id: string;
  title: string;
  /** 实际执行的 roleId（未执行时为 null） */
  roleId: string | null;
  roleName: string | null;
  status: SubtaskStatus;
  /** 子任务输出（runner 文本 / 单次 LLM 文本） */
  output: string;
  error?: string;
  /** 所属层（从 0 起，按执行顺序） */
  layer: number;
  durationMs: number;
  /** 工具调用次数（runner 模式才有；单次 LLM 为 0） */
  toolCalls: number;
  /** 执行轮次（runner 模式才有） */
  rounds: number;
  /** status=skipped 时说明「因哪些依赖失败」 */
  blockedBy?: string[];
}

/** 因文件写冲突被下移的记录 */
export interface SerializedMove {
  id: string;
  /** 原本所在层 */
  fromLayer: number;
  /** 下移后的层 */
  toLayer: number;
  /** 与层内哪个子任务的文件重叠 */
  conflictsWith: string;
  /** 重叠的文件路径（最多列 3 个，避免报告过长） */
  files: string[];
}

/** 聚合阶段结果 */
export interface OrchestrationAggregate {
  text: string;
  /** false = 走本地拼装降级（LLM 不可用或显式 --no-aggregate） */
  aggregated: boolean;
  error?: string;
}

/** 一次编排的完整结果（宿主渲染 + 单测断言的唯一入口） */
export interface OrchestrationResult {
  goal: string;
  /** 编排级 runId（与子 dispatch 的 runId 不同，子 runId 见 events） */
  runId: string;
  /**
   * orchestrated = 拆解成功，多子任务执行
   * degraded-single = 拆解失败，降级为单任务派单（A 路线行为）
   */
  mode: "orchestrated" | "degraded-single";
  degradationReason?: string;
  /** true 表示只做了拆解与分层，未执行（--dry-run） */
  dryRun?: boolean;
  /** 实际执行的层（已含冲突下移） */
  layers: string[][];
  subtasks: OrchestrationSubtaskResult[];
  serialized: SerializedMove[];
  aggregate: OrchestrationAggregate;
  /**
   * 工作区里出现、但未被任何子任务声明的改动文件
   *
   * 只报告、不回滚：编排无权撤销用户的改动，也不该假装没看见。
   * 非 git 仓库或检测失败时为空数组（不阻塞）。
   */
  undocumentedChanges: string[];
  budget: { usedToolRounds: number; totalToolRounds: number };
  startedAt: string;
  completedAt: string;
  durationMs: number;
  endReason: "completed" | "aborted" | "error" | "max-rounds";
}

/** 拆解失败的分类（决定降级文案，便于用户定位） */
export type DecomposeFailureKind = "llm-unavailable" | "llm-error" | "no-json" | "schema-invalid" | "plan-invalid";

/** 拆解结果 */
export type DecomposeResult =
  | { ok: true; plan: OrchestrationPlan; rationale: string; raw: string }
  | { ok: false; kind: DecomposeFailureKind; message: string; raw?: string };
