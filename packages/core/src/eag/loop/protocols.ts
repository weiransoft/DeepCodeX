/**
 * Loop Engineering 组件协议（TypeScript 移植版）
 *
 * 本模块定义 LoopKernel 所依赖的各阶段组件的抽象接口。
 * Phase 3+ 将提供这些协议的具体实现（DiscoveryProbe / UnifiedMemoryLayer / IndependentEvaluator）。
 * 通过 interface 而非抽象类，可以在不修改 LoopKernel 的情况下替换实现，
 * 同时支持测试时注入轻量级真实对象（非 mock，遵循项目"禁止 mock"规则）。
 *
 * 移植来源：multi-agent-team skill scripts/loop_engineering/protocols.py
 * 移植原则：
 * - Python Protocol → TypeScript interface（鸭子类型 → 结构子类型）
 * - Python `def method(self, ...) -> X` → TypeScript `method(...): X`（接口仅描述对外契约）
 * - Python 自引用（如 `memory: "UnifiedMemoryLayerProtocol"`）→ TypeScript 接口前置声明（无循环依赖）
 *
 * @module eag/loop/protocols
 */

import type {
  DiscoveryResult,
  GeneratorResult,
  HandoffItem,
  LoopEngineeringConfig,
  LoopEvent,
  LoopEvaluationVerdict,
  MemoryQuery,
} from "./models";

// ============================================================================
// 前置声明：UnifiedMemoryLayerProtocol
// ============================================================================

/**
 * Persistence 阶段协议：统一读写记忆
 *
 * 本接口需被 DiscoveryProbeProtocol.discover 的 memory 参数引用，
 * 因此在 DiscoveryProbeProtocol 之前声明（TypeScript interface 支持结构子类型，
 * 实现方无需显式 implements，只要结构匹配即可被接受）。
 *
 * 职责：
 * - persistEvent：持久化单个 Loop 事件（用于审计、可视化、跨会话恢复）
 * - query：按查询参数检索历史事件 / 案例笔记
 * - estimateTokenUsage：估算当前累计 token 消耗（用于上限保护与预算守门）
 */
export interface UnifiedMemoryLayerProtocol {
  /**
   * 持久化单个 Loop 事件
   *
   * @param event 待持久化的 Loop 事件
   */
  persistEvent(event: LoopEvent): void;

  /**
   * 统一查询记忆
   *
   * @param query 查询参数（recent / similar / risk / event 四种类型）
   * @returns 查询结果列表（每条记录为结构化对象）
   */
  query(query: MemoryQuery): Array<Readonly<Record<string, unknown>>>;

  /**
   * 估算当前累计 token 消耗
   *
   * 用于 LoopKernel 在每轮 Scheduling 阶段向 Scheduler 提供累计消耗，
   * Scheduler 据此判定是否触达 max_tokens 硬上限。
   *
   * @returns 累计 token 消耗估算值
   */
  estimateTokenUsage(): number;
}

// ============================================================================
// Discovery 阶段协议
// ============================================================================

/**
 * Discovery 阶段协议：感知需求、上下文、风险、可用 skill
 *
 * 实现方负责：
 * 1. 接收本轮目标（objective）与历史事件（prevEvents）
 * 2. 通过 memory 查询相关历史案例 / 风险事件
 * 3. 输出结构化 DiscoveryResult（明确化目标 + 风险清单 + 建议角色/pattern/artifacts）
 *
 * LoopKernel.Step1 调用此协议完成 Discovery 阶段。
 */
export interface DiscoveryProbeProtocol {
  /**
   * 执行 Discovery，返回结构化结果
   *
   * @param objective 本轮目标描述（来自 LoopKernel.run 入参）
   * @param prevEvents 历史事件列表（供 Discovery 参考前序轮次结果）
   * @param memory 统一 Memory 层（供 Discovery 查询历史案例 / 风险事件）
   * @returns Discovery 阶段结构化产物
   */
  discover(
    objective: string,
    prevEvents: ReadonlyArray<LoopEvent>,
    memory: UnifiedMemoryLayerProtocol
  ): DiscoveryResult;
}

// ============================================================================
// Handoff 阶段协议
// ============================================================================

/**
 * Handoff 阶段协议：将 Discovery 结果转换为工作项并分发执行
 *
 * 实现方负责：
 * 1. createWorkItems：根据 DiscoveryResult 生成 HandoffItem 列表（任务分解 + 角色分派）
 * 2. execute：执行工作项，返回 GeneratorResult（含客观指标：测试通过/lint/安全扫描等）
 *
 * LoopKernel.Step2 调用此协议完成 Handoff 阶段。
 *
 * 设计约束：
 * - execute 必须返回包含约定字段的 GeneratorResult（success/test_result/lint_result 等），
 *   供 IndependentEvaluator 按约定字段读取客观指标。
 * - Generator 与 Evaluator 严格分离（§5.1.3 红线分级 + §5.2.1 Generator/Evaluator 分离原则），
 *   HandoffAdapter 不得在 execute 中调用评估逻辑。
 */
export interface HandoffAdapterProtocol {
  /**
   * 根据 Discovery 结果生成工作项列表
   *
   * @param discovery Discovery 阶段产物
   * @param loopType 当前 Loop 类型（design / coding / testing，影响工作项粒度与角色分派）
   * @returns 工作项列表（每个工作项描述一个可分派给 Generator 角色执行的工作单元）
   */
  createWorkItems(discovery: DiscoveryResult, loopType: string): HandoffItem[];

  /**
   * 执行工作项，返回 Generator 执行结果
   *
   * @param items 待执行的工作项列表
   * @param config Loop Engineering 配置（含测试命令、安全分析器等执行参数）
   * @returns Generator 执行结果（含约定字段 success/test_result/lint_result/security_result 等）
   */
  execute(items: ReadonlyArray<HandoffItem>, config: LoopEngineeringConfig): GeneratorResult;
}

// ============================================================================
// Verification 阶段协议
// ============================================================================

/**
 * Verification 阶段协议：独立评估 Generator 产出
 *
 * 实现方负责：
 * 1. 接收 handoffItems + generatorResult + context
 * 2. 按红线清单 + 客观指标对 Generator 产出进行独立判定
 * 3. 输出 LoopEvaluationVerdict（passed / reason / findings / severity / suggestedFix）
 *
 * LoopKernel.Step3 调用此协议完成 Verification 阶段。
 *
 * 与 EAG-P0 IndependentEvaluator 的关系：
 * - P0 的 `eag/evaluator/types.ts` 定义了 `IndependentEvaluator` 接口（evaluate 返回 Promise<EvaluationReport>）
 * - 本接口为 Loop 层的同步评估契约（evaluate 返回 LoopEvaluationVerdict）
 * - 两者职责对齐但签名不同：P0 用于异步重型评估（含 LLM judge），本接口用于 Loop 内同步快速判定
 * - Phase 3+ 可提供适配器将 P0 IndependentEvaluator 包装为本协议实现
 */
export interface IndependentEvaluatorProtocol {
  /**
   * 对 Generator 产出进行独立评估并返回判定
   *
   * @param handoffItems 工作项列表（评估器可参考任务描述与验收标准）
   * @param generatorResult Generator 执行结果（评估器按约定字段读取客观指标）
   * @param context 上下文信息（objective / loop_type 等）
   * @returns 独立判定结果（LoopEvaluationVerdict）
   */
  evaluate(
    handoffItems: ReadonlyArray<HandoffItem>,
    generatorResult: GeneratorResult,
    context: Readonly<Record<string, unknown>>
  ): LoopEvaluationVerdict;
}

// ============================================================================
// 协议清单说明
// ============================================================================

/**
 * 协议清单（对应 Python `__all__`，TS 接口通过 `export interface` 已直接导出，无需重复声明）
 *
 * 4 个协议接口构成 LoopKernel 的可注入依赖契约：
 * - DiscoveryProbeProtocol：Discovery 阶段
 * - HandoffAdapterProtocol：Handoff 阶段
 * - IndependentEvaluatorProtocol：Verification 阶段
 * - UnifiedMemoryLayerProtocol：Persistence 阶段
 */
