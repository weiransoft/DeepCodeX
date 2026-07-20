/**
 * Loop Engineering 核心数据模型（TypeScript 移植版）
 *
 * 本模块定义 Loop Engineering 运行过程中所需的全部结构化数据类型，
 * 保持与现有模块解耦，便于独立测试和复用。
 *
 * 移植来源：multi-agent-team skill scripts/loop_engineering/models.py
 * 移植原则（评审 T-2 共识：行为等价限定在纯函数层）：
 * - Python dataclass → TypeScript interface（不可变优先：readonly 字段）
 * - Python Enum(str) → TypeScript 字面量联合类型 + ReadonlyArray 常量
 * - Python Path → TypeScript string（保持序列化友好）
 * - Python Dict[str, Any] → TypeScript Record<string, unknown>（避免 any）
 * - Python Optional[X] → TypeScript X | null（明确区分 null 与 undefined）
 *
 * 命名冲突说明（重要）：
 * - EAG-P0 的 `packages/core/src/eag/evaluator/types.ts` 已定义
 *   `EvaluationVerdict` 为字符串字面量联合 `"pass" | "fix" | "human_checkpoint" | "stop_failure"`
 *   用于 IndependentEvaluator 协议产出。
 * - 本模块移植 Python 的 `EvaluationVerdict` 数据类（含 passed/evaluator_id/reason/findings/
 *   severity/suggested_fix/sampled_artifacts 等字段），两者语义不同——
 *   为避免命名冲突，本模块将 Python 的 EvaluationVerdict 重命名为 `LoopEvaluationVerdict`，
 *   并通过 JSDoc 显式说明与 P0 EvaluationVerdict 的关系：
 *     - LoopEvaluationVerdict.passed=true  ≈ P0 EvaluationVerdict="pass"
 *     - LoopEvaluationVerdict.passed=false + severity="blocker"  ≈ P0 EvaluationVerdict="fix"
 *     - LoopEvaluationVerdict.passed=false + requires_human=true  ≈ P0 EvaluationVerdict="human_checkpoint"
 *   后续 Phase 由 scheduler/kernel 负责将 LoopEvaluationVerdict 映射为 P0 EvaluationVerdict。
 *
 * @module eag/loop/models
 */

// ============================================================================
// 枚举（字符串字面量联合 + ReadonlyArray 常量）
// ============================================================================

/**
 * 业务 Loop 类型
 *
 * - design：设计 Loop，产出或更新架构/需求/接口设计文档
 * - coding：编码 Loop，完成代码实现、测试、提交
 * - testing：测试 Loop，补充/运行/修复测试并提升覆盖率
 * - deploy：部署 Loop（EAG-P4 批次 13 新增），完成 IaC 生成 + 部署执行 + 健康检查 + 烟雾测试 + G-8 门禁校验
 *
 * 设计依据：EAG-P4 批次 13 设计文档 §3.3.2 LoopType 扩展说明（B-10 修复）
 */
export type LoopType = "design" | "coding" | "testing" | "deploy";

/** LoopType 全部合法值（用于运行时枚举与测试断言） */
export const LOOP_TYPES: ReadonlyArray<LoopType> = Object.freeze(["design", "coding", "testing", "deploy"]);

/**
 * Discovery 阶段工作模式
 *
 * - auto：自动感知项目上下文、历史记录、相关 skills
 * - manual：仅使用用户输入，不主动扫描项目
 * - off：关闭 Discovery（仅调试用，生产不推荐）
 */
export type DiscoveryMode = "auto" | "manual" | "off";

/** DiscoveryMode 全部合法值 */
export const DISCOVERY_MODES: ReadonlyArray<DiscoveryMode> = Object.freeze(["auto", "manual", "off"]);

/**
 * 独立 Evaluator 的严格程度
 *
 * - strict：必须独立 Evaluator 通过才算成功（推荐生产环境）
 * - standard：允许 Generator 自评 + 独立 Evaluator 抽检
 * - off：关闭独立 Evaluator（仅调试用，生产不推荐）
 */
export type EvaluatorMode = "strict" | "standard" | "off";

/** EvaluatorMode 全部合法值 */
export const EVALUATOR_MODES: ReadonlyArray<EvaluatorMode> = Object.freeze(["strict", "standard", "off"]);

/**
 * Loop 运行过程中产生的事件类型（12 种，对应 Python LoopEventType 枚举）
 *
 * 事件按五步闭环 + 终态组织：
 * - Discovery 阶段：DISCOVERY_STARTED / DISCOVERY_COMPLETED
 * - Handoff 阶段：HANDOFF_CREATED / HANDOFF_DISPATCHED
 * - Verification 阶段：VERIFICATION_STARTED / VERIFICATION_PASSED / VERIFICATION_REJECTED
 * - Persistence 阶段：PERSISTENCE_WRITTEN
 * - Scheduling 阶段：SCHEDULING_DECISION / HUMAN_CHECKPOINT
 * - 终态：LOOP_COMPLETED / LOOP_FAILED
 */
export type LoopEventType =
  | "discovery_started"
  | "discovery_completed"
  | "handoff_created"
  | "handoff_dispatched"
  | "verification_started"
  | "verification_rejected"
  | "verification_passed"
  | "persistence_written"
  | "scheduling_decision"
  | "human_checkpoint"
  | "loop_completed"
  | "loop_failed";

/** LoopEventType 全部合法值（共 12 种，用于运行时枚举与测试断言） */
export const LOOP_EVENT_TYPES: ReadonlyArray<LoopEventType> = Object.freeze([
  "discovery_started",
  "discovery_completed",
  "handoff_created",
  "handoff_dispatched",
  "verification_started",
  "verification_rejected",
  "verification_passed",
  "persistence_written",
  "scheduling_decision",
  "human_checkpoint",
  "loop_completed",
  "loop_failed",
]);

/**
 * LoopScheduler 的决策动作
 *
 * - continue：继续下一轮（验证通过且未达停止条件）
 * - fix：基于验证结果修复后重试（验证未通过）
 * - human_checkpoint：触发人类检查点（连续失败或高风险事件）
 * - stop_success：目标达成，正常停止
 * - stop_failure：达到上限或连续失败，失败停止
 */
export type SchedulingAction = "continue" | "fix" | "human_checkpoint" | "stop_success" | "stop_failure";

/** SchedulingAction 全部合法值 */
export const SCHEDULING_ACTIONS: ReadonlyArray<SchedulingAction> = Object.freeze([
  "continue",
  "fix",
  "human_checkpoint",
  "stop_success",
  "stop_failure",
]);

// ============================================================================
// 配置
// ============================================================================

/**
 * 默认 stage_order（编码 Loop 内部阶段顺序）
 *
 * 对应 Python `["plan", "dev", "verify", "fix"]`：
 * - plan：计划（任务分解、依赖排序）
 * - dev：开发（实现代码）
 * - verify：验证（单测/静态扫描）
 * - fix：修复（依据评估意见回灌）
 */
export const DEFAULT_STAGE_ORDER: ReadonlyArray<string> = Object.freeze(["plan", "dev", "verify", "fix"]);

// 类型导入：MultiLoopPlan（type-only import 避免运行期循环依赖）
// 对齐 EAG-P3 批次 10 §4.17.2：LoopEngineeringConfig 新增可选 multiLoopPlan 字段，
// 由 LoopKernel.scheduleMultiLoop() 消费，向后兼容（未提供时按单 Loop 执行 run()）
import type { MultiLoopPlan } from "../long-horizon/types";

/**
 * Loop Engineering 专属配置
 *
 * 字段优先从 CLI args 获取，未提供时 fallback 到项目级
 * `.deepcode/eag.yml` 中的 loop_* 字段（不依赖 multi-agent-team skill 的 .trae/autonomous.yml）。
 *
 * 复用关系：
 * - max_iterations / max_tokens 字段语义对齐 P0 `common/loop-guard.ts` 的 LoopGuardConfig
 *   （EAG 方案 §5.2.1 评审 A-3/A-4 共识：上限保护策略提取为共享模块）
 * - 实际硬上限由调用方（LoopKernel）在构造时映射到 LoopGuard 配置；
 *   本配置仅作为 Loop 工程层面的"业务可调旋钮"，不替代 LoopGuard 的运行时检查。
 *
 * 配置冻结保证（§5.12.4 G-A6d）：
 * - 构造时通过 `createLoopEngineeringConfig` 工厂函数 Object.freeze 冻结
 * - 运行期不可修改（LLM 在循环内不可自改上限）
 * - 配置变更需退出 Loop 后重新构造
 *
 * 扩展字段（EAG-P3 批次 10 §4.17.2 向后兼容扩展）：
 * - multiLoopPlan：可选，多 Loop 串联计划。未提供时按单 Loop 执行 run()；
 *   提供时由 LoopKernel.scheduleMultiLoop() 消费，串联执行 DESIGN → CODING → TESTING 三 Loop。
 *   该字段对既有调用方透明——既有代码不读取此字段即不受影响。
 */
export interface LoopEngineeringConfig {
  /** 业务 Loop 类型 */
  readonly loopType: LoopType;
  /** Discovery 工作模式 */
  readonly discoveryMode: DiscoveryMode;
  /** Evaluator 严格程度 */
  readonly evaluatorMode: EvaluatorMode;
  /** 最大迭代次数（硬上限，避免无限循环，必须 >= 1） */
  readonly maxIterations: number;
  /** 最大 token 消耗预算（硬上限，必须 >= 1） */
  readonly maxTokens: number;
  /** 每 N 轮触发一次人类检查点，0 表示关闭（必须 >= 0） */
  readonly humanCheckpointEvery: number;
  /** 抽样阅读比例（0.0-1.0，Evaluator 抽样阅读 artifacts 时使用） */
  readonly samplingReadRatio: number;
  /** 自然语言停止条件，供 Scheduler 参考（空字符串表示无显式停止条件） */
  readonly stopWhen: string;
  /** 编码 Loop 内部阶段顺序（默认 ["plan","dev","verify","fix"]） */
  readonly stageOrder: ReadonlyArray<string>;
  /** 项目根目录（绝对路径或相对路径字符串） */
  readonly projectRoot: string;
  /** run 状态目录（相对 projectRoot） */
  readonly runDir: string;
  /** notes.md 路径（相对 projectRoot） */
  readonly notesPath: string;
  /** 测试命令 */
  readonly testCommand: string;
  /** 测试超时秒数 */
  readonly testTimeoutSec: number;
  /** 安全分析器标识 */
  readonly securityAnalyzer: string;
  /** 验证通过后是否自动 git commit */
  readonly autoCommit: boolean;
  /**
   * 多 Loop 串联计划（EAG-P3 批次 10 §4.17.2 新增可选字段，向后兼容）
   *
   * - 未提供（undefined）：按单 Loop 执行 run()，既有行为不变
   * - 提供：由 LoopKernel.scheduleMultiLoop(plan, store?) 消费，
   *   串联执行 DESIGN → CODING → TESTING 三 Loop DAG
   *
   * 字段为 readonly + Readonly 包装，运行期不可修改（§5.12.4 G-A6d 配置冻结）
   */
  readonly multiLoopPlan?: Readonly<MultiLoopPlan>;
  /** 扩展字段（供未来插件使用，如 max_consecutive_failures / backoff_base_sec 等可调参数） */
  readonly extra: Readonly<Record<string, unknown>>;
}

/**
 * 默认 Loop Engineering 配置（对应 Python dataclass 默认值）
 *
 * 数值依据：
 * - loopType="coding"：默认走编码 Loop（最常用场景）
 * - discoveryMode="auto"：默认自动感知上下文
 * - evaluatorMode="strict"：默认 STRICT 模式（保守策略，EAG 默认模式）
 * - maxIterations=50：与 DEFAULT_LOOP_GUARD_CONFIG.maxIterations 对齐
 * - maxTokens=500_000：Python 母本默认值，覆盖大型生成任务
 * - humanCheckpointEvery=5：每 5 轮触发人类检查点
 * - samplingReadRatio=0.1：抽样 10% artifacts 阅读
 *
 * 扩展字段（EAG-P3 批次 10 §4.17.2）：
 * - multiLoopPlan: undefined：默认不启用多 Loop 串联模式，保持既有单 Loop 行为不变。
 *   调用方需多 Loop 串联时通过 createLoopEngineeringConfig({ multiLoopPlan: ... }) 显式注入。
 */
export const DEFAULT_LOOP_ENGINEERING_CONFIG: Readonly<LoopEngineeringConfig> = Object.freeze({
  loopType: "coding",
  discoveryMode: "auto",
  evaluatorMode: "strict",
  maxIterations: 50,
  maxTokens: 500_000,
  humanCheckpointEvery: 5,
  samplingReadRatio: 0.1,
  stopWhen: "",
  stageOrder: DEFAULT_STAGE_ORDER,
  projectRoot: ".",
  runDir: ".gnhf/runs",
  notesPath: "notes.md",
  testCommand: "python3 -m unittest discover -s tests -p 'test_*.py'",
  testTimeoutSec: 600.0,
  securityAnalyzer: "builtin",
  autoCommit: true,
  // 多 Loop 串联计划默认未启用（§4.17.2 向后兼容：既有调用方不受影响）
  multiLoopPlan: undefined,
  extra: Object.freeze({}) as Readonly<Record<string, unknown>>,
});

/**
 * 配置校验错误
 *
 * 当 LoopEngineeringConfig 的字段非法时抛出（对应 Python `__post_init__` 中的 ValueError）。
 */
export class LoopEngineeringConfigError extends Error {
  /**
   * @param field 非法字段名
   * @param value 非法字段值
   * @param reason 非法原因
   */
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    public readonly reason: string
  ) {
    super(`LoopEngineeringConfig 字段非法：${field}=${String(value)}，${reason}`);
    this.name = "LoopEngineeringConfigError";
  }
}

/**
 * 创建 LoopEngineeringConfig 实例（带字段校验 + 冻结）
 *
 * 工厂函数模式：调用方传入部分字段覆盖默认值，工厂函数完成校验并 Object.freeze 冻结。
 * 对应 Python `__post_init__` 中的字段合法性校验逻辑。
 *
 * 校验规则：
 * - maxIterations 必须 >= 1（否则抛 LoopEngineeringConfigError）
 * - maxTokens 必须 >= 1
 * - samplingReadRatio 必须在 [0, 1] 之间
 * - humanCheckpointEvery 必须 >= 0
 *
 * @param overrides 覆盖字段（缺省字段使用 DEFAULT_LOOP_ENGINEERING_CONFIG）
 * @returns 冻结后的配置对象
 * @throws {LoopEngineeringConfigError} 任一字段非法时抛出
 */
export function createLoopEngineeringConfig(
  overrides?: Partial<LoopEngineeringConfig>
): Readonly<LoopEngineeringConfig> {
  // 合并默认值与覆盖值
  const merged: LoopEngineeringConfig = {
    ...DEFAULT_LOOP_ENGINEERING_CONFIG,
    ...overrides,
    // extra 单独处理：浅合并而非整体覆盖（保持扩展字段可叠加）
    extra: Object.freeze({
      ...DEFAULT_LOOP_ENGINEERING_CONFIG.extra,
      ...(overrides?.extra ?? {}),
    }),
    // stageOrder 单独处理：冻结为 ReadonlyArray
    stageOrder: Object.freeze(
      overrides?.stageOrder ? [...overrides.stageOrder] : [...DEFAULT_LOOP_ENGINEERING_CONFIG.stageOrder]
    ),
  };

  // 字段合法性校验（对应 Python __post_init__）
  if (!Number.isInteger(merged.maxIterations) || merged.maxIterations < 1) {
    throw new LoopEngineeringConfigError("maxIterations", merged.maxIterations, "必须为整数且 >= 1");
  }
  if (!Number.isInteger(merged.maxTokens) || merged.maxTokens < 1) {
    throw new LoopEngineeringConfigError("maxTokens", merged.maxTokens, "必须为整数且 >= 1");
  }
  if (
    typeof merged.samplingReadRatio !== "number" ||
    Number.isNaN(merged.samplingReadRatio) ||
    merged.samplingReadRatio < 0.0 ||
    merged.samplingReadRatio > 1.0
  ) {
    throw new LoopEngineeringConfigError("samplingReadRatio", merged.samplingReadRatio, "必须在 [0, 1] 之间");
  }
  if (!Number.isInteger(merged.humanCheckpointEvery) || merged.humanCheckpointEvery < 0) {
    throw new LoopEngineeringConfigError("humanCheckpointEvery", merged.humanCheckpointEvery, "必须为整数且 >= 0");
  }

  return Object.freeze(merged);
}

// ============================================================================
// Discovery 阶段产物
// ============================================================================

/**
 * Discovery 阶段产物（对应 Python DiscoveryResult dataclass）
 *
 * 由 DiscoveryProbe 协议实现产出，描述本轮 Discovery 感知到的：
 * - 明确化的目标（objective）
 * - 项目上下文特征（contextFeatures）
 * - 相关 skills / 风险 / 建议（agents/patterns/artifacts）
 */
export interface DiscoveryResult {
  /** 本轮明确后的目标描述 */
  readonly objective: string;
  /** 原始输入上下文（用户需求、任务描述等） */
  readonly inputs: Readonly<Record<string, unknown>>;
  /** 提取的项目上下文特征 */
  readonly contextFeatures: Readonly<Record<string, unknown>>;
  /** 识别到的相关 skill 名称列表 */
  readonly relevantSkills: ReadonlyArray<string>;
  /** 识别到的风险列表（非空时应优先处理） */
  readonly detectedRisks: ReadonlyArray<string>;
  /** 推断出的可验证目标 */
  readonly inferredGoal: string;
  /** 是否需要 worktree 隔离 */
  readonly worktreeRequired: boolean;
  /** 建议调用的智能体角色列表 */
  readonly suggestedAgents: ReadonlyArray<string>;
  /** 建议使用的动态工作流模式列表 */
  readonly suggestedPatterns: ReadonlyArray<string>;
  /** 建议读取的工件路径列表 */
  readonly artifactsToRead: ReadonlyArray<string>;
  /** Discovery 完成时间 ISO 格式 */
  readonly timestamp: string;
}

// ============================================================================
// Handoff 阶段产物
// ============================================================================

/**
 * Handoff 阶段生成的工作项（对应 Python HandoffItem dataclass）
 *
 * 由 HandoffAdapter.createWorkItems 产出，描述一个可分派给 Generator 角色执行的工作单元。
 */
export interface HandoffItem {
  /** 工作项唯一标识 */
  readonly itemId: string;
  /** 执行该工作项的智能体角色（如 architect / solo-coder） */
  readonly agentType: string;
  /** 任务描述 */
  readonly task: string;
  /** 验收标准列表 */
  readonly acceptanceCriteria: ReadonlyArray<string>;
  /** 工作树路径（如使用隔离，null 表示不使用 worktree） */
  readonly worktreePath: string | null;
  /** 依赖的其他工作项 ID 列表 */
  readonly dependencies: ReadonlyArray<string>;
  /** 扩展元数据 */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Generator 执行结果（对应 Python `Dict[str, Any]` GeneratorResult）
 *
 * 约定字段（评估器按此约定读取客观指标）：
 * - success: boolean —— Generator 是否声明执行成功
 * - test_result: { passed: boolean; summary: string } —— 测试命令结果
 * - lint_result: { passed: boolean; summary: string } —— 静态检查结果
 * - security_result: { severity: "info"|"warning"|"blocker"|"critical"|"high"; summary: string } —— 安全扫描结果
 * - modified_files: string[] —— 修改的文件路径列表
 * - committed_count: number —— 本次提交次数
 *
 * 使用 Record<string, unknown> 而非 any，调用方按约定字段名读取并做类型守卫。
 */
export type GeneratorResult = Readonly<Record<string, unknown>>;

// ============================================================================
// Evaluation 阶段产物
// ============================================================================

/**
 * 严重级别（用于 LoopEvaluationVerdict.severity 字段）
 *
 * 与 P0 evaluator/types.ts 的 RedlineSeverity 字段语义对齐但命名空间独立：
 * - "info"：信息级，无影响
 * - "warning"：警告级，建议关注
 * - "blocker"：阻断级，必须修复
 */
export type VerdictSeverity = "info" | "warning" | "blocker";

/**
 * 独立 Evaluator 判定结果（对应 Python EvaluationVerdict dataclass）
 *
 * 命名说明（重要）：
 * 本接口移植自 Python `loop_engineering.models.EvaluationVerdict` dataclass，
 * 因 EAG-P0 的 `packages/core/src/eag/evaluator/types.ts` 已定义同名
 * `EvaluationVerdict` 字符串字面量联合（"pass"|"fix"|"human_checkpoint"|"stop_failure"），
 * 为避免命名冲突，本接口重命名为 `LoopEvaluationVerdict`。
 *
 * 与 P0 EvaluationVerdict 的映射关系（由 scheduler 负责转换）：
 * - passed=true  →  P0 "pass"
 * - passed=false + severity="blocker"  →  P0 "fix"
 * - passed=false + requires_human=true  →  P0 "human_checkpoint"
 * - 连续失败超上限  →  P0 "stop_failure"（由 scheduler 根据 consecutiveFailures 判定）
 */
export interface LoopEvaluationVerdict {
  /** 是否通过 */
  readonly passed: boolean;
  /** 执行评估的 Evaluator 标识 */
  readonly evaluatorId: string;
  /** 判定理由（人类可读） */
  readonly reason: string;
  /** 发现的具体问题列表 */
  readonly findings: ReadonlyArray<string>;
  /** 严重级别（info / warning / blocker） */
  readonly severity: VerdictSeverity;
  /** 建议修复方案 */
  readonly suggestedFix: string;
  /** 抽样阅读的工件路径列表（调试用） */
  readonly sampledArtifacts: ReadonlyArray<string>;
}

// ============================================================================
// 事件与 Memory
// ============================================================================

/**
 * 统一事件模型（对应 Python LoopEvent dataclass）
 *
 * 用于 Memory 写入、审计和可视化。每步五步闭环均产生事件并写入 Memory。
 */
export interface LoopEvent {
  /** 事件唯一标识 */
  readonly eventId: string;
  /** 事件类型 */
  readonly eventType: LoopEventType;
  /** 所属阶段（discovery / handoff / verification / persistence / scheduling） */
  readonly phase: string;
  /** 所属运行 ID */
  readonly runId: string;
  /** 迭代轮次索引（从 0 开始） */
  readonly iterIndex: number;
  /** 事件负载数据 */
  readonly payload: Readonly<Record<string, unknown>>;
  /** 事件发生时间 ISO 格式 */
  readonly timestamp: string;
}

/**
 * 统一 Memory 查询参数（对应 Python MemoryQuery dataclass）
 *
 * 查询类型：
 * - recent：最近 N 条事件
 * - similar：与给定任务相似的历史案例
 * - risk：高风险事件
 * - event：按事件类型过滤
 */
export interface MemoryQuery {
  /** 查询类型 */
  readonly queryType: "recent" | "similar" | "risk" | "event";
  /** 额外过滤条件（如 event_type / agent_type / passed） */
  readonly filters: Readonly<Record<string, unknown>>;
  /** 返回条数上限 */
  readonly limit: number;
  /** 查询 section（如 notes 中的某个章节），null 表示不限定 */
  readonly section: string | null;
  /** 相似度阈值（similar 查询用） */
  readonly minSimilarity: number;
  /** 用于相似度计算的目标描述（similar 查询用） */
  readonly objective: string;
}

// ============================================================================
// Scheduling 阶段产物
// ============================================================================

/**
 * LoopScheduler 的决策结果（对应 Python SchedulingDecision dataclass）
 *
 * 由 LoopScheduler.decideNext 产出，描述下一轮循环的动作与退避策略。
 */
export interface SchedulingDecision {
  /** 决策动作 */
  readonly action: SchedulingAction;
  /** 决策理由（人类可读） */
  readonly reason: string;
  /** 下一轮 Loop 类型（如需切换），null 表示保持当前类型 */
  readonly nextLoopType: LoopType | null;
  /** 下一轮阶段顺序（编码 Loop 用），null 表示保持当前顺序 */
  readonly nextStageOrder: ReadonlyArray<string> | null;
  /** 下一轮执行前的退避秒数 */
  readonly backoffSeconds: number;
  /** 是否需要人类输入才能继续 */
  readonly requiresHumanInput: boolean;
}

/**
 * 人类检查点响应（对应 Python HumanCheckpointResponse dataclass）
 *
 * 由 LoopKernel.requestHumanCheckpoint 产出，描述人类对检查点的响应。
 * 默认实现自动批准（非交互式环境）。
 */
export interface HumanCheckpointResponse {
  /** 是否批准继续 */
  readonly approved: boolean;
  /** 人类反馈文本 */
  readonly feedback: string;
  /** 是否中止整个 Loop */
  readonly abort: boolean;
}

// ============================================================================
// 单轮与整轮报告
// ============================================================================

/**
 * 单轮五步闭环的执行结果（对应 Python LoopCycleResult dataclass）
 *
 * 由 LoopKernel.runOneCycle 产出，描述一轮 Discovery→Handoff→Verification→Persistence→Scheduling 的全部产物。
 */
export interface LoopCycleResult {
  /** 迭代轮次索引 */
  readonly iterIndex: number;
  /** Discovery 结果 */
  readonly discovery: DiscoveryResult;
  /** 生成的工作项列表 */
  readonly handoffItems: ReadonlyArray<HandoffItem>;
  /** Generator 执行结果（任意结构化数据） */
  readonly generatorResult: GeneratorResult;
  /** 独立 Evaluator 判定 */
  readonly verdict: LoopEvaluationVerdict;
  /** 本轮产生的事件列表 */
  readonly events: ReadonlyArray<LoopEvent>;
  /** 本轮估算 token 消耗 */
  readonly tokenUsed: number;
  /** 本轮耗时秒数 */
  readonly durationSec: number;
  /** 调度决策 */
  readonly schedulingDecision: SchedulingDecision;
}

/**
 * 完整 Loop Engineering 运行的最终报告（对应 Python LoopRunReport dataclass）
 *
 * 由 LoopKernel.run 产出，描述整个 Loop 运行的最终状态与统计信息。
 */
export interface LoopRunReport {
  /** 运行唯一标识 */
  readonly runId: string;
  /** 业务 Loop 类型 */
  readonly loopType: LoopType;
  /** 运行目标 */
  readonly objective: string;
  /** 总迭代轮数 */
  readonly totalIterations: number;
  /**
   * 最终状态
   * - "completed"：正常完成（STOP_SUCCESS）
   * - "failed"：失败停止（STOP_FAILURE / 上限触发）
   * - "aborted"：人类中止（HumanCheckpointResponse.abort=true）
   */
  readonly finalStatus: "completed" | "failed" | "aborted";
  /** 全部事件列表 */
  readonly events: ReadonlyArray<LoopEvent>;
  /** 总 token 消耗估算 */
  readonly tokenUsed: number;
  /** 总耗时秒数 */
  readonly durationSec: number;
  /** 成功持久化（如 commit）次数 */
  readonly committedCount: number;
  /** 人类检查点记录 */
  readonly humanCheckpoints: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** 最终摘要 */
  readonly finalSummary: string;
}

// ============================================================================
// 类型别名
// ============================================================================

/**
 * 日志回调函数类型
 *
 * - 第一个参数：日志消息
 * - 第二个参数：日志级别（"INFO" / "WARN"）
 *
 * 对应 Python `Optional[Callable[[str, str], None]]`，
 * TypeScript 中 null | undefined 表示不输出日志。
 */
export type LogCallback = ((message: string, level: "INFO" | "WARN") => void) | null;
