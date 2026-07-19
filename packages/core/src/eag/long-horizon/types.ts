/**
 * 长程任务自动化全部数据模型（EAG-P3 批次 10 §4.9）
 *
 * 本模块定义 EAG 方案 §5.12.2 长程任务自动化所需的全部结构化数据类型，
 * 涵盖 RunState 持久化、Milestone 里程碑、Blockage 阻塞分析、MultiLoopPlan 多 Loop 串联
 * 四大子模块所需的全部契约。
 *
 * 设计依据：
 * - EAG 方案 §5.12.2 长程任务自动化（跨 Loop 续跑 + 多 Loop 串联 + 里程碑 + 阻塞分析）
 * - EAG 方案 §5.10.5 三 Loop 完整编排时序（DESIGN → CODING → TESTING）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - EAG-P3 批次 10 设计 §4.9 长程自动化数据模型
 * - EAG-P3 批次 10 设计 §4.17 LoopKernel multi-loop 扩展
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层配置常量使用 Object.freeze 冻结，防止运行期被 LLM 自改
 * - 工厂函数 createXxxRequest 统一返回 Object.freeze 冻结对象
 *
 * 外部类型复用：
 * - LoopType：从 ../loop/models 导入（design/coding/testing 三种 Loop 类型）
 * - LoopEvent：从 ../loop/models 导入（用于 multi-loop 执行报告事件流）
 *
 * @module eag/long-horizon/types
 */

// ============================================================================
// 1. 外部类型导入（仅 type-only import，避免运行期循环依赖）
// ============================================================================

import type { LoopType, LoopEvent, LoopRunReport } from "../loop/models";

// ============================================================================
// 2. RunState 长程任务状态
// ============================================================================

/**
 * RunState 状态枚举（字面量联合类型）
 *
 * 对应 EAG 方案 §5.12.2 RunState.status 字段：
 * - running：运行中（Loop 正常执行）
 * - paused：已暂停（累计 3 次人工介入未解决时自动暂停）
 * - completed：已完成（全部 Loop 节点 status=completed）
 * - failed：已失败（不可恢复错误或 LoopGuard 触达上限）
 * - human-checkpoint：等待人工决策（如 spec.md 待批准 / 范式不一致待确认）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type RunStateStatus = "running" | "paused" | "completed" | "failed" | "human-checkpoint";

/**
 * RUN_STATE_STATUSES 全部合法值（用于运行时枚举与测试断言）
 *
 * 使用 Object.freeze 冻结。顺序按状态机自然流转顺序：
 * running → human-checkpoint → running → ... → completed / failed / paused
 */
export const RUN_STATE_STATUSES: ReadonlyArray<RunStateStatus> = Object.freeze([
  "running",
  "paused",
  "completed",
  "failed",
  "human-checkpoint",
]);

/**
 * RunState 长程任务状态（对齐 §5.12.2 跨 Loop 续跑）
 *
 * 持久化为 JSONL 文件（每行一个事件），路径：
 *   `<projectRoot>/.eag/run-state/<run-id>.jsonl`
 *
 * 防腐化机制（§4.10）：
 * - SHA256 累积校验和（每事件含局部 SHA256 + 全文件累积 SHA256）
 * - 文件锁（自实现 flock，基于 fs.openSync + O_EXCL 原子创建）
 * - 原子追加（appendFileSync + O_APPEND 标志）
 *
 * 字段全部 readonly——RunState 一经重建即不可变，状态变更通过追加事件表达。
 *
 * 范例：
 *   {
 *     runId: "a1b2c3d4e5f6",
 *     projectRoot: "/path/to/project",
 *     startedAt: "2026-07-19T10:00:00.000Z",
 *     updatedAt: "2026-07-19T11:30:00.000Z",
 *     currentLoop: "coding",
 *     currentIteration: 3,
 *     completedLoops: ["design"],
 *     completedTaskIds: ["T-001", "T-002"],
 *     pendingDeleteFiles: ["tmp/old-config.json"],
 *     milestones: [{ index: 1, name: "DESIGN Loop 完成", ... }],
 *     humanInterventions: [{ intervenedAt: "...", loopType: "coding", ... }],
 *     humanInterventionCount: 1,
 *     totalLlmCallCount: 28,
 *     totalTokensUsed: 64200,
 *     status: "running",
 *     checksum: "sha256:abcdef..."
 *   }
 */
export interface RunState {
  /** run-id（12 位 UUID 前缀，与 RunStateStore 文件名对应） */
  readonly runId: string;
  /** 项目根目录（绝对路径，用于解析 .eag/run-state/ 目录） */
  readonly projectRoot: string;
  /** 启动时间（ISO 8601 字符串，如 "2026-07-19T10:00:00.000Z"） */
  readonly startedAt: string;
  /** 最近更新时间（ISO 8601 字符串，每次追加事件时更新） */
  readonly updatedAt: string;
  /** 当前 Loop 类型（design/coding/testing，由 currentLoop 字段表示进度位置） */
  readonly currentLoop: LoopType;
  /** 当前 Loop 的当前迭代号（从 1 开始计数，0 表示尚未开始） */
  readonly currentIteration: number;
  /** 已完成的 Loop 列表（按完成顺序，如 ["design"] 表示 DESIGN Loop 已完成） */
  readonly completedLoops: ReadonlyArray<LoopType>;
  /** 已完成的任务 ID 列表（TaskNode.id，按拓扑序完成） */
  readonly completedTaskIds: ReadonlyArray<string>;
  /** 待删除文件清单（对齐 §5.10.4 删除纪律——延迟到 RunState 收尾阶段批量删除） */
  readonly pendingDeleteFiles: ReadonlyArray<string>;
  /** 里程碑列表（按时间顺序，每个 Loop 完成 = 一个里程碑） */
  readonly milestones: ReadonlyArray<MilestoneRecord>;
  /** 人工介入记录列表（每次 HUMAN_CHECKPOINT 触发时记录） */
  readonly humanInterventions: ReadonlyArray<HumanInterventionRecord>;
  /** 累计人工介入次数（= humanInterventions.length，冗余字段便于快速查询） */
  readonly humanInterventionCount: number;
  /** 累计 LLM 调用次数（DESIGN + CODING + TESTING 全流程汇总） */
  readonly totalLlmCallCount: number;
  /** 累计 token 消耗（input + output，用于成本核算与 SLA 评估） */
  readonly totalTokensUsed: number;
  /** 当前状态（running/paused/completed/failed/human-checkpoint） */
  readonly status: RunStateStatus;
  /** 当前阻塞点（status != running 时填写，描述具体阻塞原因） */
  readonly blockedReason?: string;
  /** SHA256 校验和（累积所有事件，加载时校验完整性） */
  readonly checksum: string;
}

// ============================================================================
// 3. 里程碑记录
// ============================================================================

/**
 * 里程碑记录（对齐 §5.12.2 "里程碑检查点"）
 *
 * 每个 Loop 完成 = 一个里程碑，自动生成 git tag：`eag/<run-id>/m<n>`
 *
 * 字段全部 readonly——里程碑一经创建即不可变，变更通过创建新里程碑表达。
 *
 * 范例：
 *   {
 *     index: 1,
 *     name: "DESIGN Loop 完成",
 *     loopType: "design",
 *     completedAt: "2026-07-19T10:23:00.000Z",
 *     tagName: "eag/a1b2c3d4e5f6/m1",
 *     commitSha: "abc123def456...",
 *     regressionResult: { totalTests: 50, passedTests: 50, failedTests: 0, exitCode: 0, durationSec: 12.5 },
 *     healthScore: 0.95
 *   }
 */
export interface MilestoneRecord {
  /** 里程碑序号（从 1 开始计数，m1, m2, m3...） */
  readonly index: number;
  /** 里程碑名称（如 "DESIGN Loop 完成" / "CODING Loop T-001 完成"） */
  readonly name: string;
  /** 完成的 Loop 类型（design/coding/testing） */
  readonly loopType: LoopType;
  /** 完成时间（ISO 8601 字符串） */
  readonly completedAt: string;
  /** git tag 名（格式：eag/<run-id>/m<n>，由 MilestoneTagger 生成） */
  readonly tagName: string;
  /** git commit SHA（tag 指向的提交，用于 rollback 时 reset 目标） */
  readonly commitSha: string;
  /** 该里程碑的测试回归结果（创建 tag 后触发回归测试得来） */
  readonly regressionResult?: Readonly<RegressionResult>;
  /** 健康度（0~1，综合测试通过率 + 红线通过率 + 覆盖率） */
  readonly healthScore: number;
}

/**
 * 回归测试结果（里程碑创建后触发）
 *
 * 对齐 §5.12.2 "里程碑检查点"——创建 milestone tag 后，
 * 自动运行所有已有 milestone 的测试，验证回归不破坏既有功能。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     totalTests: 50,
 *     passedTests: 50,
 *     failedTests: 0,
 *     exitCode: 0,
 *     durationSec: 12.5
 *   }
 */
export interface RegressionResult {
  /** 执行的测试用例总数 */
  readonly totalTests: number;
  /** 通过用例数 */
  readonly passedTests: number;
  /** 失败用例数 */
  readonly failedTests: number;
  /** 退出码（0=全过，非 0=有失败） */
  readonly exitCode: number;
  /** 执行耗时（秒） */
  readonly durationSec: number;
}

// ============================================================================
// 4. 人工介入记录
// ============================================================================

/**
 * 人工介入记录（对齐 §5.12.2 阻塞分析触发条件）
 *
 * 每次 HUMAN_CHECKPOINT 触发时记录一条，累计 3 次未解决时触发 BlockageAnalyzer。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     intervenedAt: "2026-07-19T10:30:00.000Z",
 *     loopType: "coding",
 *     reason: "FIX 失败 3 次",
 *     decision: "放宽 E7 评估器规则",
 *     resolved: true
 *   }
 */
export interface HumanInterventionRecord {
  /** 介入时间（ISO 8601 字符串） */
  readonly intervenedAt: string;
  /** 介入的 Loop 类型 */
  readonly loopType: LoopType;
  /** 介入原因（如 "G-3 偏离检测" / "FIX 失败 3 次" / "覆盖率连续 2 次 BLOCKER"） */
  readonly reason: string;
  /** 用户的决策内容（自然语言描述） */
  readonly decision: string;
  /** 是否已解决（用户决策后再次运行该 Loop 验证是否通过） */
  readonly resolved: boolean;
}

// ============================================================================
// 5. 多 Loop 串联计划
// ============================================================================

/**
 * 多 Loop 节点状态（字面量联合类型）
 *
 * 对应 §4.9 MultiLoopNode.status 字段：
 * - pending：待执行（依赖未满足或调度未到达）
 * - running：执行中（当前正在执行该节点）
 * - completed：已完成（Loop 通过 + milestone 已创建）
 * - failed：失败（Loop 失败且无法自动回滚）
 * - human-checkpoint：等待人工决策（如 spec.md 待批准）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type MultiLoopNodeStatus = "pending" | "running" | "completed" | "failed" | "human-checkpoint";

/**
 * MULTI_LOOP_NODE_STATUSES 全部合法值（用于运行时枚举与测试断言）
 *
 * 使用 Object.freeze 冻结。
 */
export const MULTI_LOOP_NODE_STATUSES: ReadonlyArray<MultiLoopNodeStatus> = Object.freeze([
  "pending",
  "running",
  "completed",
  "failed",
  "human-checkpoint",
]);

/**
 * 多 Loop 串联计划（对齐 §5.12.2 "多 Loop 串联计划"）
 *
 * DAG 结构：DESIGN → CODING → TESTING（按 EAG 三 Loop 时序）
 * 每个 Loop 节点含独立的 spec/plan/tasks 与验收卡。
 *
 * 字段全部 readonly——计划一经生成即不可变，节点状态变更通过创建新计划版本表达。
 *
 * 范例：
 *   {
 *     planId: "a1b2c3d4e5f6",
 *     projectRoot: "/path/to/project",
 *     loops: [
 *       { nodeId: "design-1", loopType: "design", dependencies: [], status: "completed", ... },
 *       { nodeId: "coding-1", loopType: "coding", dependencies: ["design-1"], status: "running", ... },
 *       { nodeId: "testing-1", loopType: "testing", dependencies: ["coding-1"], status: "pending", ... }
 *     ],
 *     autoTransition: false,
 *     rollbackOnFailure: true,
 *     createdAt: "2026-07-19T10:00:00.000Z"
 *   }
 */
export interface MultiLoopPlan {
  /** 计划 ID（与 run-id 一致，便于 RunStateStore 关联） */
  readonly planId: string;
  /** 项目根目录（绝对路径） */
  readonly projectRoot: string;
  /** Loop 节点列表（按拓扑序，DESIGN 在前，TESTING 在后） */
  readonly loops: ReadonlyArray<MultiLoopNode>;
  /** 自动流转规则（前一 Loop 成功后是否自动进入下一 Loop） */
  readonly autoTransition: boolean;
  /** 失败回滚策略（true=恢复到上一个 milestone tag，false=仅记录失败不回滚） */
  readonly rollbackOnFailure: boolean;
  /** 创建时间（ISO 8601 字符串） */
  readonly createdAt: string;
}

/**
 * 多 Loop 计划节点（DAG 中的一个节点）
 *
 * 对应 §4.9 MultiLoopNode：
 * 单个 Loop 在 DAG 中的节点表示，含依赖关系与状态。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     nodeId: "coding-1",
 *     loopType: "coding",
 *     dependencies: ["design-1"],
 *     status: "running",
 *     entryArtifact: "docs/eag/spec.md",
 *     exitCriteria: "G-5 passed"
 *   }
 */
export interface MultiLoopNode {
  /** 节点 ID（如 "design-1" / "coding-1" / "testing-1"，在 plan 内唯一） */
  readonly nodeId: string;
  /** Loop 类型（design/coding/testing） */
  readonly loopType: LoopType;
  /** 依赖节点 ID 列表（拓扑序前置，必须全部 completed 才能启动本节点） */
  readonly dependencies: ReadonlyArray<string>;
  /** 当前节点状态（pending/running/completed/failed/human-checkpoint） */
  readonly status: MultiLoopNodeStatus;
  /** Loop 入口文档（DESIGN: 用户需求 / CODING: spec.md / TESTING: 实现代码目录） */
  readonly entryArtifact: string;
  /** Loop 退出验收卡（DESIGN: spec 批准 / CODING: G-5 通过 / TESTING: G-7 通过） */
  readonly exitCriteria: string;
}

/**
 * Loop 阶段（用于 multi-loop 调度状态机）
 *
 * 对应 §4.9 LoopPhase：
 * - discovery：发现阶段（DiscoveryProbe 扫描项目上下文）
 * - handoff：分发阶段（HandoffAdapter 创建工作项并调用 Generator）
 * - verification：验证阶段（IndependentEvaluator 评估产出）
 * - persistence：持久化阶段（Memory 写入事件 + commit）
 * - scheduling：调度阶段（Scheduler 决定下一步动作）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type LoopPhase = "discovery" | "handoff" | "verification" | "persistence" | "scheduling";

/**
 * LOOP_PHASES 全部合法值（用于运行时枚举与测试断言）
 *
 * 使用 Object.freeze 冻结。顺序对齐五步闭环自然执行顺序。
 */
export const LOOP_PHASES: ReadonlyArray<LoopPhase> = Object.freeze([
  "discovery",
  "handoff",
  "verification",
  "persistence",
  "scheduling",
]);

/**
 * Loop 转换规则（multi-loop 调度依据）
 *
 * 对应 §4.9 LoopTransition：
 * 描述从一个 Loop 转换到另一个 Loop 的条件与是否自动。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     from: "design",
 *     to: "coding",
 *     condition: "spec-approved + user-approval",
 *     automatic: false
 *   }
 */
export interface LoopTransition {
  /** 源 Loop 类型 */
  readonly from: LoopType;
  /** 目标 Loop 类型 */
  readonly to: LoopType;
  /** 转换条件（如 "G-5 passed" / "spec-approved + user-approval"） */
  readonly condition: string;
  /** 是否自动转换（true=满足条件自动进入下一 Loop，false=需用户检查点确认） */
  readonly automatic: boolean;
}

/**
 * 默认多 Loop 转换规则（DESIGN → CODING → TESTING）
 *
 * 对应 §4.9 DEFAULT_LOOP_TRANSITIONS：
 * - DESIGN → CODING：需 spec 批准 + 用户检查点（非自动）
 * - CODING → TESTING：G-5 通过即自动（autoTransition=true 时）
 * - TESTING → DESIGN：G-7 失败需用户检查点重新设计（非自动）
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改。
 */
export const DEFAULT_LOOP_TRANSITIONS: ReadonlyArray<LoopTransition> = Object.freeze([
  { from: "design", to: "coding", condition: "spec-approved + user-approval", automatic: false },
  { from: "coding", to: "testing", condition: "G-5 passed", automatic: true },
  { from: "testing", to: "design", condition: "G-7 failed + user-approval", automatic: false },
]);

// ============================================================================
// 6. 阻塞分析报告
// ============================================================================

/**
 * 阻塞分析报告（对齐 §5.12.2 "阻塞分析报告"）
 *
 * 累计 3 次人工介入未解决时自动生成，含根因假设 + 建议方案 + 所需决策清单。
 *
 * 字段全部 readonly——报告一经生成即不可变，新报告通过重新分析生成。
 *
 * 范例：
 *   {
 *     runId: "a1b2c3d4e5f6",
 *     generatedAt: "2026-07-19T11:00:00.000Z",
 *     blockedLoop: "coding",
 *     blockedIteration: 5,
 *     rootCauseHypotheses: [{ hypothesisId: "rc-001", description: "...", confidence: 0.8, ... }],
 *     suggestedSolutions: [{ solutionId: "sol-001", description: "...", ... }],
 *     requiredDecisions: [{ decisionId: "dec-001", description: "...", options: [...], ... }],
 *     relatedInterventions: [{ intervenedAt: "...", loopType: "coding", ... }]
 *   }
 */
export interface BlockageReport {
  /** run-id（关联 RunState） */
  readonly runId: string;
  /** 生成时间（ISO 8601 字符串） */
  readonly generatedAt: string;
  /** 阻塞的 Loop 类型 */
  readonly blockedLoop: LoopType;
  /** 阻塞的迭代号（currentIteration） */
  readonly blockedIteration: number;
  /** 根因假设列表（基于历史失败模式 + LLM 推断双通道） */
  readonly rootCauseHypotheses: ReadonlyArray<RootCauseHypothesis>;
  /** 建议方案列表（基于 RLIS 规则库 + LLM 补全） */
  readonly suggestedSolutions: ReadonlyArray<SuggestedSolution>;
  /** 所需决策清单（人工介入选项） */
  readonly requiredDecisions: ReadonlyArray<RequiredDecision>;
  /** 相关历史介入记录（关联 RunState.humanInterventions） */
  readonly relatedInterventions: ReadonlyArray<HumanInterventionRecord>;
}

/**
 * 根因假设来源（字面量联合类型）
 *
 * 对应 §4.16 RootCauseHypothesis.source：
 * - rule-based：规则匹配（基于 DEFAULT_ROOT_CAUSE_RULES 4 条规则，confidence 0.6~0.8）
 * - llm-inferred：LLM 推断（开放性根因，confidence ≤0.6 上限防幻觉）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type RootCauseSource = "rule-based" | "llm-inferred";

/**
 * ROOT_CAUSE_SOURCES 全部合法值（用于运行时枚举与测试断言）
 *
 * 使用 Object.freeze 冻结。
 */
export const ROOT_CAUSE_SOURCES: ReadonlyArray<RootCauseSource> = Object.freeze(["rule-based", "llm-inferred"]);

/**
 * 根因假设
 *
 * 对应 §4.16 RootCauseHypothesis：
 * 描述阻塞的一个可能根因，含置信度与支持证据。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     hypothesisId: "rc-001",
 *     description: "评估器规则过严或代码确实违规",
 *     confidence: 0.8,
 *     evidence: ["E7 红线连续 3 次 violated", "FIX 轮次 1 修复后仍违反"],
 *     source: "rule-based"
 *   }
 */
export interface RootCauseHypothesis {
  /** 假设 ID（如 "rc-001"，在 BlockageReport 内唯一） */
  readonly hypothesisId: string;
  /** 假设描述（如"评估器规则过严"/"LLM 上下文不足"/"任务卡声明模糊"） */
  readonly description: string;
  /** 置信度（0~1，rule-based 0.6~0.8，llm-inferred ≤0.6 防幻觉） */
  readonly confidence: number;
  /** 支持证据（历史介入记录 + 失败模式匹配，每条为人类可读描述） */
  readonly evidence: ReadonlyArray<string>;
  /** 假设来源（rule-based 规则匹配 / llm-inferred LLM 推断） */
  readonly source: RootCauseSource;
}

/**
 * 建议方案实施成本（字面量联合类型）
 *
 * 对应 §4.16 SuggestedSolution.cost：
 * - low：低成本（如调整评估器参数、补充上下文）
 * - medium：中成本（如修改任务卡声明、扩大 LLM 上下文窗口）
 * - high：高成本（如重构代码、重新设计模块切分）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type SolutionCost = "low" | "medium" | "high";

/**
 * SOLUTION_COSTS 全部合法值（用于运行时枚举与测试断言）
 *
 * 使用 Object.freeze 冻结。按成本从低到高排序。
 */
export const SOLUTION_COSTS: ReadonlyArray<SolutionCost> = Object.freeze(["low", "medium", "high"]);

/**
 * 建议方案
 *
 * 对应 §4.16 SuggestedSolution：
 * 针对一个根因假设的具体修复方案，含预期效果与实施成本。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     solutionId: "sol-001",
 *     description: "放宽 E7 评估器规则，允许值对象不含业务方法",
 *     targetHypothesisId: "rc-001",
 *     rlisRuleId: "SEED-01",
 *     expectedEffect: "评估器规则放宽后可能放过贫血模型",
 *     cost: "low"
 *   }
 */
export interface SuggestedSolution {
  /** 方案 ID（如 "sol-001"，在 BlockageReport 内唯一） */
  readonly solutionId: string;
  /** 方案描述（自然语言，含具体操作步骤） */
  readonly description: string;
  /** 关联的根因假设 ID（targetHypothesisId 必须存在于 rootCauseHypotheses） */
  readonly targetHypothesisId: string;
  /** 关联的 RLIS 规则 ID（如适用，用于规则溯源） */
  readonly rlisRuleId?: string;
  /** 预期效果（如"评估器规则放宽"/"上下文窗口扩大"） */
  readonly expectedEffect: string;
  /** 实施成本（low/medium/high） */
  readonly cost: SolutionCost;
}

/**
 * 所需决策
 *
 * 对应 §4.16 RequiredDecision：
 * 需要用户做出的决策，含 2~4 个选项 + 推荐选项。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     decisionId: "dec-001",
 *     description: "是否放宽 E7 评估器规则",
 *     options: [
 *       { optionId: "opt-1", description: "维持现状", impact: "可能继续 FIX 失败" },
 *       { optionId: "opt-2", description: "放宽规则", impact: "可能放过贫血模型" }
 *     ],
 *     recommendedOptionId: "opt-2"
 *   }
 */
export interface RequiredDecision {
  /** 决策 ID（如 "dec-001"，在 BlockageReport 内唯一） */
  readonly decisionId: string;
  /** 决策描述（如"是否放宽评估器规则 E7"/"是否扩大 LLM 上下文窗口"） */
  readonly description: string;
  /** 决策选项（2~4 个） */
  readonly options: ReadonlyArray<DecisionOption>;
  /** 推荐选项 ID（必须存在于 options） */
  readonly recommendedOptionId: string;
}

/**
 * 决策选项
 *
 * 对应 §4.16 DecisionOption：
 * 单个决策的可选项，含描述与影响。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     optionId: "opt-1",
 *     description: "维持现状",
 *     impact: "可能继续 FIX 失败"
 *   }
 */
export interface DecisionOption {
  /** 选项 ID（如 "opt-1"，在 RequiredDecision 内唯一） */
  readonly optionId: string;
  /** 选项描述（自然语言） */
  readonly description: string;
  /** 选项影响（如"评估器规则放宽后可能放过贫血模型"） */
  readonly impact: string;
}

// ============================================================================
// 7. 根因规则（BlockageAnalyzer 规则匹配器输入）
// ============================================================================

/**
 * 根因规则
 *
 * 对应 §4.16 RootCauseRule：
 * 描述一条根因识别规则，含模式标识 + 描述 + 置信度。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     ruleId: "rc-001",
 *     pattern: "same-redline-3-failures",
 *     description: "同一红线连续 3 次失败 → 评估器规则过严或代码确实违规",
 *     confidence: 0.8
 *   }
 */
export interface RootCauseRule {
  /** 规则 ID（如 "rc-001"，在规则库内唯一） */
  readonly ruleId: string;
  /** 模式标识（如 "same-redline-3-failures"，用于 RootCauseRuleMatcher 路由） */
  readonly pattern: string;
  /** 规则描述（人类可读，含触发条件与根因假设） */
  readonly description: string;
  /** 置信度（0~1，rule-based 假设的置信度上限 0.8） */
  readonly confidence: number;
}

/**
 * 默认根因规则（4 条，可扩展）
 *
 * 对应 §4.16 DEFAULT_ROOT_CAUSE_RULES：
 * - rc-001：同一红线连续 3 次失败 → 评估器规则过严（confidence 0.8）
 * - rc-002：同一任务卡 FIX 失败 3 次 → 任务卡声明模糊（confidence 0.75）
 * - rc-003：覆盖率连续 2 次 BLOCKER → 覆盖率阈值过严（confidence 0.7）
 * - rc-004：多次 LLM 调用超时 → LLM 上下文不足（confidence 0.6）
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改。
 */
export const DEFAULT_ROOT_CAUSE_RULES: ReadonlyArray<RootCauseRule> = Object.freeze([
  {
    ruleId: "rc-001",
    pattern: "same-redline-3-failures",
    description: "同一红线连续 3 次失败 → 评估器规则过严或代码确实违规",
    confidence: 0.8,
  },
  {
    ruleId: "rc-002",
    pattern: "same-task-fix-exhausted",
    description: "同一任务卡 FIX 失败 3 次 → 任务卡声明模糊或 LLM 上下文不足",
    confidence: 0.75,
  },
  {
    ruleId: "rc-003",
    pattern: "coverage-blocker-2-consecutive",
    description: "覆盖率连续 2 次 BLOCKER → 覆盖率阈值过严或代码不可测",
    confidence: 0.7,
  },
  {
    ruleId: "rc-004",
    pattern: "llm-timeout-multiple",
    description: "多次 LLM 调用超时 → LLM 上下文不足或网络问题",
    confidence: 0.6,
  },
]);

/**
 * 触发阻塞分析的累计人工介入次数阈值
 *
 * 对应 §5.12.2 "累计 3 次人工介入未解决 → 自动暂停并输出阻塞分析报告"。
 *
 * 使用 `as const` 字面量断言（数字本身已是不可变原始值）。
 */
export const BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD = 3 as const;

/**
 * LLM 推断根因假设的置信度上限（防幻觉）
 *
 * 对应 §4.16 "LLM 推断 confidence ≤0.6 上限防幻觉"。
 *
 * 使用 `as const` 字面量断言。
 */
export const LLM_INFERRED_CONFIDENCE_CAP = 0.6 as const;

// ============================================================================
// 8. DAG 校验结果
// ============================================================================

/**
 * DAG 校验结果（MultiLoopPlanner.validate 产出）
 *
 * 对应 §4.11 DagValidationResult：
 * 描述多 Loop 计划 DAG 的合法性校验结果，含环检测与节点可达性。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     valid: true,
 *     cycles: [],
 *     unreachableNodes: []
 *   }
 */
export interface DagValidationResult {
  /** 是否合法（true=无环 + 全部节点可达，false=有环或存在不可达节点） */
  readonly valid: boolean;
  /** 检测到的环列表（每个环为节点 ID 数组，空数组表示无环） */
  readonly cycles: ReadonlyArray<ReadonlyArray<string>>;
  /** 不可达节点列表（从 design-1 出发无法到达的节点 ID，空数组表示全部可达） */
  readonly unreachableNodes: ReadonlyArray<string>;
}

// ============================================================================
// 9. MultiLoopRunReport（LoopKernel.scheduleMultiLoop 产出）
// ============================================================================

/**
 * 多 Loop 执行最终状态（字面量联合类型）
 *
 * 对应 §4.17 MultiLoopRunReport.finalStatus：
 * - completed：全部节点完成（所有 Loop 通过 + milestone 已创建）
 * - failed：至少一个节点失败且无法自动回滚
 * - human-checkpoint：等待用户决策（如 spec.md 待批准）
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type MultiLoopFinalStatus = "completed" | "failed" | "human-checkpoint";

/**
 * MULTI_LOOP_FINAL_STATUSES 全部合法值（用于运行时枚举与测试断言）
 *
 * 使用 Object.freeze 冻结。
 */
export const MULTI_LOOP_FINAL_STATUSES: ReadonlyArray<MultiLoopFinalStatus> = Object.freeze([
  "completed",
  "failed",
  "human-checkpoint",
]);

/**
 * 单节点最终状态（字面量联合类型）
 *
 * 对应 §4.17 MultiLoopNodeResult.status：
 * - completed：节点已完成（Loop 通过 + milestone 已创建）
 * - failed：节点失败（Loop 失败且无法自动回滚）
 * - human-checkpoint：节点等待用户决策
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type MultiLoopNodeFinalStatus = "completed" | "failed" | "human-checkpoint";

/**
 * MULTI_LOOP_NODE_FINAL_STATUSES 全部合法值（用于运行时枚举与测试断言）
 *
 * 使用 Object.freeze 冻结。
 */
export const MULTI_LOOP_NODE_FINAL_STATUSES: ReadonlyArray<MultiLoopNodeFinalStatus> = Object.freeze([
  "completed",
  "failed",
  "human-checkpoint",
]);

/**
 * 多 Loop 执行报告（LoopKernel.scheduleMultiLoop 产出）
 *
 * 对应 §4.17 MultiLoopRunReport：
 * 描述多 Loop 计划的完整执行结果，含各节点结果与汇总统计。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     planId: "a1b2c3d4e5f6",
 *     nodeResults: [{ nodeId: "design-1", loopType: "design", status: "completed", ... }],
 *     finalStatus: "completed",
 *     totalIterations: 5,
 *     totalLlmCallCount: 28,
 *     totalTokensUsed: 64200,
 *     durationSec: 120.5
 *   }
 */
export interface MultiLoopRunReport {
  /** 计划 ID（关联 MultiLoopPlan.planId） */
  readonly planId: string;
  /** 各节点执行结果（按拓扑序） */
  readonly nodeResults: ReadonlyArray<MultiLoopNodeResult>;
  /** 最终状态（completed/failed/human-checkpoint） */
  readonly finalStatus: MultiLoopFinalStatus;
  /** 总迭代次数（所有节点 LoopKernel.run().totalIterations 汇总） */
  readonly totalIterations: number;
  /** 总 LLM 调用次数（所有节点汇总） */
  readonly totalLlmCallCount: number;
  /** 总 token 消耗（所有节点汇总） */
  readonly totalTokensUsed: number;
  /** 总耗时（秒） */
  readonly durationSec: number;
}

/**
 * 单节点执行结果（multi-loop 调度中单个 Loop 节点的执行结果）
 *
 * 对应 §4.17 MultiLoopNodeResult：
 * 描述单个节点在 multi-loop 调度中的执行结果，含 Loop 报告与状态。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     nodeId: "design-1",
 *     loopType: "design",
 *     status: "completed",
 *     loopReport: { runId: "...", loopType: "design", ... },
 *     failureReason: undefined
 *   }
 */
export interface MultiLoopNodeResult {
  /** 节点 ID（对应 MultiLoopNode.nodeId） */
  readonly nodeId: string;
  /** Loop 类型 */
  readonly loopType: LoopType;
  /** 节点状态（completed/failed/human-checkpoint） */
  readonly status: MultiLoopNodeFinalStatus;
  /** 单 Loop 执行报告（LoopKernel.run() 产出，节点成功时填写） */
  readonly loopReport?: Readonly<LoopRunReport>;
  /** 失败原因（status != completed 时填写） */
  readonly failureReason?: string;
}

// ============================================================================
// 10. 类型复用导出
// ============================================================================

/**
 * 复用 loop/models 中的 LoopType 与 LoopEvent
 *
 * 长程自动化模块依赖 LoopType（design/coding/testing）与 LoopEvent（事件流），
 * 通过 re-export 让外部模块可从 long-horizon/types 统一导入。
 */
export type { LoopType, LoopEvent, LoopRunReport };

// ============================================================================
// 11. 默认配置常量
// ============================================================================

/**
 * 默认最大 multi-loop 迭代次数
 *
 * 数值依据（§4.17 + §5.2.1）：
 * - 30 次迭代覆盖大多数企业任务的 multi-loop 需求
 * - 单 Loop 默认 10 次迭代 × 3 Loop = 30 次
 * - 上限由 LoopGuard 强制执行，LLM 不可自改
 *
 * 使用 `as const` 字面量断言。
 */
export const DEFAULT_MAX_MULTI_LOOP_ITERATIONS = 30 as const;

/**
 * 默认 RunState 存储目录（相对 projectRoot）
 *
 * 对应 §4.10 "<projectRoot>/.eag/run-state/<run-id>.jsonl"。
 *
 * 使用 `as const` 字面量断言。
 */
export const DEFAULT_RUN_STATE_DIR = ".eag/run-state" as const;

/**
 * 默认里程碑 tag 前缀
 *
 * 对应 §4.15 "eag/<run-id>/m<n>"。
 *
 * 使用 `as const` 字面量断言。
 */
export const DEFAULT_MILESTONE_TAG_PREFIX = "eag" as const;

/**
 * 健康度计算权重（对齐 §4.15.3 健康度计算公式）
 *
 * 公式：healthScore = testPassRate * 0.5 + redlinePassRate * 0.3 + coverageRate * 0.2
 *
 * 数值依据（D-14 决策）：
 * - 测试通过率权重 0.5（最重要）
 * - 红线通过率权重 0.3
 * - 覆盖率权重 0.2
 * - 三者之和 = 1.0
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改。
 */
export const HEALTH_SCORE_WEIGHTS: Readonly<{
  readonly testPassRate: number;
  readonly redlinePassRate: number;
  readonly coverageRate: number;
}> = Object.freeze({
  testPassRate: 0.5,
  redlinePassRate: 0.3,
  coverageRate: 0.2,
});

/**
 * 长程自动化默认配置汇总（含所有默认值的只读快照）
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 * 调用方可从此处获取所有默认值，避免散落引用。
 */
export const LONG_HORIZON_DEFAULTS: Readonly<{
  readonly maxMultiLoopIterations: number;
  readonly runStateDir: string;
  readonly milestoneTagPrefix: string;
  readonly blockageTriggerThreshold: number;
  readonly llmInferredConfidenceCap: number;
  readonly healthScoreWeights: Readonly<{
    readonly testPassRate: number;
    readonly redlinePassRate: number;
    readonly coverageRate: number;
  }>;
}> = Object.freeze({
  maxMultiLoopIterations: DEFAULT_MAX_MULTI_LOOP_ITERATIONS,
  runStateDir: DEFAULT_RUN_STATE_DIR,
  milestoneTagPrefix: DEFAULT_MILESTONE_TAG_PREFIX,
  blockageTriggerThreshold: BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD,
  llmInferredConfidenceCap: LLM_INFERRED_CONFIDENCE_CAP,
  healthScoreWeights: HEALTH_SCORE_WEIGHTS,
});

// ============================================================================
// 12. 日志回调类型
// ============================================================================

/**
 * 日志回调函数类型
 *
 * - 第一个参数：日志消息
 * - 第二个参数：日志级别（"info" / "warn" / "error"）
 *
 * 与 testing/types.ts 中的 LogCallback 保持一致，
 * 便于跨模块复用日志实现。
 */
export type LogCallback = (message: string, level?: "info" | "warn" | "error") => void;
