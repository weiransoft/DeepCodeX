/**
 * 节点内循环内核实现（v2.0 实现，对齐设计文档 §10）
 *
 * 本模块实现 NodeLoopKernel，是 Layer 1 的核心组件，采用方案 C：
 * - **不复用 eag/loop/LoopKernel 类**（其构造函数要求 4 个协议实例，无生产实现）
 * - **复用 eag/loop/LoopScheduler** 做节点内迭代决策（CONTINUE/FIX/STOP）
 * - **复用 eag/loop/models 数据模型**（LoopEngineeringConfig/LoopEvent/SchedulingDecision/LoopEvaluationVerdict）
 * - **独立实现五步闭环逻辑**（Discovery→Handoff→Verification→Persistence→Scheduling）
 *
 * 五步闭环流程（对齐 §10.2）：
 * 1. Discovery：从 input + context 提取任务特征，构造本轮目标
 * 2. Handoff：调用外部注入的 executor 回调执行任务（回调内部可以是 LLM 调用/plugin 调用）
 * 3. Verification：调用外部注入的 evaluator 回调验证结果（回调内部可以是测试运行/lint/契约校验）
 * 4. Persistence：将本轮结果写入内部 events 数组（供输出提取和审计）
 * 5. Scheduling：复用 LoopScheduler.decideNext() 决策下一轮（CONTINUE/FIX/STOP）
 *
 * 依赖注入设计：
 * - executor 和 evaluator 通过构造函数注入，NodeLoopKernel 本身不依赖 LLM 客户端或测试框架
 * - 这使得 NodeLoopKernel 保持纯粹（仅负责迭代控制），具体的执行和验证逻辑由调用方提供
 *
 * 关键设计决策（对齐 §10.3）：
 * - NodeLoopKernel 不继承 LoopKernel，而是独立实现五步闭环
 * - 实例在节点内创建，不复用（避免跨节点状态污染）
 * - 输出提取：从内部 events 序列中提取最后轮次的 generatorResult 作为节点输出
 * - 经验召回：如果 enableExperienceRecall=true，在 Discovery 阶段前查询 ExperienceStore（Phase 4 集成）
 *
 * @module eag/graph/node-loop-kernel
 */

import type {
  /** 图节点定义 */
  GraphNodeDef,
  /** 图节点执行结果 */
  GraphNodeResult,
  /** 图运行上下文 */
  GraphRunContext,
  /** 节点内 Loop 配置 */
  NodeLoopConfig,
  /** 节点字段契约 */
  NodeFieldContract,
  /** 经验案例 */
  ExperienceCase,
  /** 图日志记录器接口 */
  GraphLogger,
} from "./graph-loop-models";
// 协议接口导入：ExperienceStoreProtocol（Phase 4 经验召回集成）
import type { ExperienceStoreProtocol } from "./graph-loop-protocols";
// 类型导入：复用 eag/loop/ 的数据模型和 LoopScheduler（方案 C）
import type {
  /** Loop Engineering 配置（复用） */
  LoopEngineeringConfig,
  /** Loop 事件（复用） */
  LoopEvent,
  /** 调度决策（复用） */
  SchedulingDecision,
  /** 独立 Evaluator 判定结果（复用） */
  LoopEvaluationVerdict,
  /** Generator 执行结果（复用） */
  GeneratorResult,
} from "../loop/models";
/** LoopScheduler 类（复用，做节点内迭代决策） */
import { LoopScheduler } from "../loop/scheduler";
import {
  /** 工厂函数：创建 LoopEngineeringConfig（复用） */
  createLoopEngineeringConfig,
  /** 默认 stage order（复用，编码 Loop 内部阶段顺序） */
  DEFAULT_STAGE_ORDER,
} from "../loop/models";

// ============================================================================
// 回调函数类型定义
// ============================================================================

/**
 * Loop 执行回调（Handoff 阶段调用）
 *
 * 由调用方注入，负责实际执行任务（如 LLM 调用、plugin 调用）。
 * NodeLoopKernel 本身不依赖 LLM 客户端，通过此回调将执行逻辑外包。
 *
 * @param iteration 当前迭代轮次（从 1 开始）
 * @param input 节点输入数据（来自 EdgeResolver，每轮相同）
 * @param context 图运行上下文（含全局状态、取消信号等）
 * @param feedback 上一轮验证反馈（修复轮使用，首轮为 undefined）
 * @returns Generator 执行结果（按约定字段返回 success/test_result/lint_result 等）
 */
export type LoopExecutorCallback = (
  iteration: number,
  input: Readonly<Record<string, unknown>>,
  context: Readonly<GraphRunContext>,
  feedback?: Readonly<LoopEvaluationVerdict>
) => Promise<GeneratorResult>;

/**
 * Loop 验证回调（Verification 阶段调用）
 *
 * 由调用方注入，负责验证 executor 产出的结果（如运行测试、lint 检查、契约校验）。
 * NodeLoopKernel 本身不依赖测试框架，通过此回调将验证逻辑外包。
 *
 * @param iteration 当前迭代轮次（从 1 开始）
 * @param generatorResult executor 产出的结果
 * @param input 节点输入数据
 * @param context 图运行上下文
 * @returns 独立 Evaluator 判定结果（passed/findings/severity/suggestedFix 等）
 */
export type LoopEvaluatorCallback = (
  iteration: number,
  generatorResult: GeneratorResult,
  input: Readonly<Record<string, unknown>>,
  context: Readonly<GraphRunContext>
) => Promise<LoopEvaluationVerdict>;

// ============================================================================
// NodeLoopKernelOptions 构造选项
// ============================================================================

/**
 * NodeLoopKernel 构造选项
 *
 * 通过依赖注入方式传入所有协作组件，便于测试和扩展。
 *
 * 必需组件：
 * - node：图节点定义（含 loopConfig / inputContract / outputContract）
 * - input：输入数据（来自 EdgeResolver，符合 inputContract）
 * - context：图运行上下文（含全局状态、取消信号、谓词注册表等）
 * - executor：执行回调（Handoff 阶段调用）
 * - evaluator：验证回调（Verification 阶段调用）
 *
 * 可选组件：
 * - experienceStore：经验存储（Phase 4 集成，配合 context.config.enableExperienceRecall 启用召回）
 * - logger：日志记录器（默认使用 console）
 */
export interface NodeLoopKernelOptions {
  /** 图节点定义（含 loopConfig / inputContract / outputContract） */
  readonly node: Readonly<GraphNodeDef>;
  /** 输入数据（来自 EdgeResolver，符合 inputContract） */
  readonly input: Readonly<Record<string, unknown>>;
  /** 图运行上下文（含全局状态、取消信号、谓词注册表等） */
  readonly context: GraphRunContext;
  /** 执行回调（Handoff 阶段调用，返回 GeneratorResult） */
  readonly executor: LoopExecutorCallback;
  /** 验证回调（Verification 阶段调用，返回 LoopEvaluationVerdict） */
  readonly evaluator: LoopEvaluatorCallback;
  /**
   * 经验存储（可选，Phase 4 集成）
   *
   * 当此字段存在且 context.config.enableExperienceRecall === true 时，
   * NodeLoopKernel 在 Discovery 阶段前调用 recallSimilar() 查询相似案例，
   * 并将结果存入 context.globalState.__experienceRecall 供 executor 读取。
   *
   * 召回失败不影响主流程（仅记录警告日志）。
   */
  readonly experienceStore?: ExperienceStoreProtocol;
  /** 日志记录器（可选，默认使用 console） */
  readonly logger?: GraphLogger;
}

// ============================================================================
// NodeLoopKernel 实现类
// ============================================================================

/**
 * 节点内循环内核
 *
 * 包装 LoopScheduler + 数据模型（方案 C），独立实现五步闭环逻辑。
 *
 * 使用示例：
 * ```typescript
 * const kernel = new NodeLoopKernel({
 *   node: graphNode,
 *   input: { requirement: "实现登录功能" },
 *   context: runContext,
 *   executor: async (iter, input, ctx, feedback) => {
 *     // 调用 LLM 执行任务
 *     return { success: true, modified_files: ["src/login.ts"] };
 *   },
 *   evaluator: async (iter, result, input, ctx) => {
 *     // 运行测试验证
 *     return { passed: true, evaluatorId: "test-runner", reason: "all tests passed", findings: [], severity: "info", suggestedFix: "", sampledArtifacts: [] };
 *   },
 * });
 * const result = await kernel.run();
 * // result.status === "completed" | "failed" | "aborted"
 * ```
 */
export class NodeLoopKernel {
  /** 图节点定义 */
  private readonly node: Readonly<GraphNodeDef>;
  /** 输入数据（来自 EdgeResolver） */
  private readonly input: Readonly<Record<string, unknown>>;
  /** 图运行上下文 */
  private readonly context: GraphRunContext;
  /** 执行回调（Handoff 阶段调用） */
  private readonly executor: LoopExecutorCallback;
  /** 验证回调（Verification 阶段调用） */
  private readonly evaluator: LoopEvaluatorCallback;
  /** 日志记录器 */
  private readonly logger: GraphLogger;
  /** 经验存储（可选，Phase 4 集成，配合 context.config.enableExperienceRecall 启用召回） */
  private readonly experienceStore?: ExperienceStoreProtocol;

  /** Loop Engineering 配置（从 node.loopConfig 映射，复用 eag/loop/models） */
  private readonly loopConfig: Readonly<LoopEngineeringConfig>;
  /** LoopScheduler 实例（复用 eag/loop/scheduler，做迭代决策） */
  private readonly scheduler: LoopScheduler;

  /** 内部事件序列（记录每轮五步闭环的产物，供输出提取和审计） */
  private readonly events: LoopEvent[] = [];
  /** 累计 token 消耗（节点级隔离，不与其他节点共享） */
  private cumulativeTokens: number = 0;
  /** 连续失败次数（不含当前轮，传给 LoopScheduler.decideNext） */
  private consecutiveFailures: number = 0;
  /** 最后一次 Generator 结果（用于输出提取） */
  private lastGeneratorResult: GeneratorResult | null = null;
  /** 最后一次验证判定（用于输出提取和修复轮反馈） */
  private lastVerdict: LoopEvaluationVerdict | null = null;
  /** 运行开始时间戳（毫秒） */
  private readonly startedAtMs: number;
  /**
   * 经验召回的相似案例列表（Phase 4 集成）
   *
   * 在 run() 主循环开始前由 runExperienceRecall() 填充，
   * 供 runDiscovery() 在每轮 Discovery 阶段引用，避免重复召回。
   * 空数组表示未启用召回或召回无结果。
   */
  private recalledCases: ReadonlyArray<ExperienceCase> = [];

  /**
   * 构造节点内循环内核
   *
   * @param options 构造选项（含节点定义、输入数据、上下文、执行回调、验证回调、可选经验存储）
   * @throws {Error} 当 node.loopConfig 缺失（loop 节点必填）时抛出
   * @throws {Error} 当 inputContract 校验失败时抛出
   */
  constructor(options: NodeLoopKernelOptions) {
    this.node = options.node;
    this.input = options.input;
    this.context = options.context;
    this.executor = options.executor;
    this.evaluator = options.evaluator;
    // 经验存储（可选，Phase 4 集成）
    this.experienceStore = options.experienceStore;
    // 日志记录器缺省使用 console
    this.logger = options.logger ?? createConsoleLogger();
    this.startedAtMs = Date.now();

    // 校验 loop 节点必须提供 loopConfig
    if (!this.node.loopConfig) {
      throw new Error(`NodeLoopKernel: loop 节点 ${this.node.nodeId} 缺少 loopConfig（必填）`);
    }

    // 校验输入数据符合 inputContract
    this.validateInputContract();

    // 从 NodeLoopConfig 映射为 LoopEngineeringConfig（复用 eag/loop/models 工厂函数）
    this.loopConfig = this.buildLoopEngineeringConfig(this.node.loopConfig);

    // 创建 LoopScheduler 实例（复用 eag/loop/scheduler，做迭代决策）
    this.scheduler = new LoopScheduler(this.loopConfig, (msg, level) => {
      if (level === "INFO") {
        this.logger.info(`[NodeLoopKernel:${this.node.nodeId}] ${msg}`);
      } else {
        this.logger.warn(`[NodeLoopKernel:${this.node.nodeId}] ${msg}`);
      }
    });
  }

  /**
   * 执行五步闭环（主入口）
   *
   * 流程（对齐 §10.2）：
   * 1. 循环（直到 STOP_SUCCESS / STOP_FAILURE / 用户取消）：
   *    a. 检查取消信号（context.cancelled=true → 返回 aborted）
   *    b. Discovery：从 input + context 提取任务特征
   *    c. Handoff：调用 executor 回调执行任务
   *    d. Verification：调用 evaluator 回调验证结果
   *    e. Persistence：将本轮结果写入 events 数组
   *    f. Scheduling：调用 LoopScheduler.decideNext() 决策
   *    g. 根据 decision.action 决定继续/修复/停止
   * 2. 校验 outputContract
   * 3. 构造 GraphNodeResult 返回
   *
   * @returns 节点执行结果（status: completed/failed/aborted）
   */
  async run(): Promise<GraphNodeResult> {
    const nodeId = this.node.nodeId;
    this.logger.info(`[NodeLoopKernel:${nodeId}] 开始执行五步闭环`, {
      loopType: this.loopConfig.loopType,
      maxIterations: this.loopConfig.maxIterations,
    });

    let iteration = 0;
    // 节点级 status 只有 completed/failed/skipped/isolated（对齐 §7.5 GraphNodeResult）
    // 用户取消时标记为 failed 并填写 failureReason，由图级编排器决定是否停止整个图
    let finalStatus: "completed" | "failed" = "failed";
    let failureReason: string | undefined;

    try {
      // 经验召回（Phase 4 集成，对齐 §12.3）
      // 在主循环开始前查询 ExperienceStore 获取相似案例，供 Discovery 阶段和 executor 引用
      // 召回失败不影响主流程（仅记录警告日志），recalledCases 保持空数组
      await this.runExperienceRecall();

      // 主循环
      while (iteration < this.loopConfig.maxIterations) {
        // 1. 检查取消信号
        if (this.context.cancelled) {
          this.logger.warn(`[NodeLoopKernel:${nodeId}] 用户取消，终止 Loop`);
          // 节点级 status 无 aborted，用户取消标记为 failed，由图级编排器决定是否停止整个图
          finalStatus = "failed";
          failureReason = "用户取消（context.cancelled=true）";
          break;
        }

        iteration++;

        // 2. Discovery 阶段：从 input + context 提取任务特征
        const discoveryResult = this.runDiscovery(iteration);

        // 3. Handoff 阶段：调用 executor 回调执行任务
        //    修复轮（iteration > 1 且上一轮验证失败）传入 lastVerdict 作为反馈
        const generatorResult = await this.runHandoff(iteration, discoveryResult.feedback);
        this.lastGeneratorResult = generatorResult;

        // 4. Verification 阶段：调用 evaluator 回调验证结果
        const verdict = await this.runVerification(iteration, generatorResult);
        this.lastVerdict = verdict;

        // 5. Persistence 阶段：将本轮结果写入 events 数组
        this.runPersistence(iteration, discoveryResult, generatorResult, verdict);

        // 6. Scheduling 阶段：调用 LoopScheduler.decideNext() 决策
        const decision = this.runScheduling(iteration, verdict);

        this.logger.info(`[NodeLoopKernel:${nodeId}] 迭代 ${iteration} 决策：${decision.action}`, {
          reason: decision.reason,
          backoffSeconds: decision.backoffSeconds,
        });

        // 7. 根据决策动作处理
        if (decision.action === "stop_success") {
          finalStatus = "completed";
          break;
        }
        if (decision.action === "stop_failure") {
          finalStatus = "failed";
          failureReason = decision.reason;
          break;
        }
        if (decision.action === "human_checkpoint") {
          // 图场景默认自动批准人工检查点（避免阻塞图遍历）
          // 真实场景应由上层调用方处理 human_checkpoint
          this.logger.warn(`[NodeLoopKernel:${nodeId}] 迭代 ${iteration} 触发人类检查点，图场景自动批准继续`);
        }

        // continue / fix / human_checkpoint：更新连续失败计数并进入下一轮
        if (verdict.passed) {
          this.consecutiveFailures = 0;
        } else {
          this.consecutiveFailures++;
        }

        // 退避等待（fix / human_checkpoint 时按 decision.backoffSeconds 退避）
        if (decision.backoffSeconds > 0) {
          this.logger.debug(`[NodeLoopKernel:${nodeId}] 退避 ${decision.backoffSeconds}s 后进入下一轮`);
          await sleep(decision.backoffSeconds * 1000);
        }
      }

      // 达到最大迭代次数仍未终止
      if (iteration >= this.loopConfig.maxIterations && finalStatus === "failed") {
        if (this.lastVerdict?.passed) {
          finalStatus = "completed";
        } else {
          failureReason = `达到最大迭代次数 ${this.loopConfig.maxIterations} 且最后一轮验证未通过`;
        }
      }
    } catch (err) {
      // 执行过程中抛出异常 → 标记为失败
      finalStatus = "failed";
      failureReason = `Loop 执行异常：${err instanceof Error ? err.message : String(err)}`;
      this.logger.error(`[NodeLoopKernel:${nodeId}] ${failureReason}`);
    }

    // 构造节点输出数据（从 lastGeneratorResult 提取）
    const output = this.extractOutput();

    // 校验输出契约（completed 状态才校验，failed/aborted 跳过）
    if (finalStatus === "completed") {
      const contractError = this.validateOutputContract(output);
      if (contractError) {
        this.logger.warn(`[NodeLoopKernel:${nodeId}] 输出契约校验失败：${contractError}（降级为 failed）`);
        finalStatus = "failed";
        failureReason = contractError;
      }
    }

    const durationSec = (Date.now() - this.startedAtMs) / 1000;

    this.logger.info(`[NodeLoopKernel:${nodeId}] 五步闭环结束`, {
      finalStatus,
      iteration,
      durationSec,
      cumulativeTokens: this.cumulativeTokens,
    });

    // 构造 GraphNodeResult 返回
    const result: GraphNodeResult = {
      nodeId,
      nodeType: this.node.nodeType,
      status: finalStatus,
      output: Object.freeze(output),
      durationSec,
      failureReason,
      retryCount: 0, // retryCount 由 NodeExecutor 维护（图级重试），NodeLoopKernel 内部不计
    };

    return result;
  }

  // ========================================================================
  // 五步闭环各阶段实现
  // ========================================================================

  /**
   * Discovery 阶段：从 input + context 提取任务特征
   *
   * 本阶段不调用外部 LLM，仅从已有数据中提取任务特征：
   * - 任务目标：node.task（节点定义的任务描述）
   * - 输入数据：this.input（来自 EdgeResolver）
   * - 全局状态：context.globalState（图级共享状态）
   * - 反馈信息：上一轮验证反馈（修复轮使用）
   * - 召回案例：this.recalledCases（Phase 4 集成，由 runExperienceRecall 填充）
   *
   * @param iteration 当前迭代轮次
   * @returns Discovery 结果（含本轮目标、反馈、召回案例）
   */
  private runDiscovery(iteration: number): {
    objective: string;
    feedback: LoopEvaluationVerdict | undefined;
    recalledCases: ReadonlyArray<ExperienceCase>;
  } {
    // 首轮无反馈，修复轮使用上一轮验证反馈
    const feedback = iteration > 1 && this.lastVerdict ? this.lastVerdict : undefined;

    return {
      objective: this.node.task,
      feedback,
      // 经验召回的相似案例（Phase 4 集成，对齐 §12.3）
      // 由 run() 主循环开始前的 runExperienceRecall() 填充
      recalledCases: this.recalledCases,
    };
  }

  /**
   * 经验召回（Phase 4 集成，对齐 §12.3）
   *
   * 在主循环开始前查询 ExperienceStore 获取相似案例，供 Discovery 阶段和 executor 引用。
   *
   * 启用条件（两者必须同时满足）：
   * 1. context.config.enableExperienceRecall === true（图级配置开关）
   * 2. this.experienceStore 存在（依赖注入）
   *
   * 召回流程：
   * 1. 提取任务特征（extractTaskFeatures）
   * 2. 调用 experienceStore.recallSimilar(features, 5) 查询相似案例
   * 3. 将结果存入 this.recalledCases（供 runDiscovery 引用）
   * 4. 同步写入 context.globalState.__experienceRecall（供 executor 读取）
   *
   * 容错策略：
   * - 召回异常时不影响主流程（仅记录警告日志），recalledCases 保持空数组
   * - 未启用召回时直接返回（recalledCases 保持空数组）
   *
   * @returns Promise<void>（无返回值，结果存入 this.recalledCases）
   */
  private async runExperienceRecall(): Promise<void> {
    // 1. 检查启用条件：图级配置开关 + 经验存储注入
    if (!this.context.config.enableExperienceRecall) {
      this.logger.debug(`[NodeLoopKernel:${this.node.nodeId}] 经验召回未启用（config.enableExperienceRecall=false）`);
      return;
    }
    if (!this.experienceStore) {
      this.logger.warn(`[NodeLoopKernel:${this.node.nodeId}] 经验召回已启用但未注入 experienceStore，跳过召回`);
      return;
    }

    // 2. 提取任务特征
    const taskFeatures = this.extractTaskFeatures();
    this.logger.info(`[NodeLoopKernel:${this.node.nodeId}] 开始经验召回`, {
      taskFeatures,
    });

    try {
      // 3. 查询相似案例（对齐 §14.1 召回策略：取前 K=5 个）
      const RECALL_LIMIT = 5;
      const cases = await this.experienceStore.recallSimilar(taskFeatures, RECALL_LIMIT);

      // 4. 存入 recalledCases（供 runDiscovery 引用）
      this.recalledCases = cases;

      // 5. 同步写入 context.globalState.__experienceRecall（供 executor 读取）
      //    使用 Object.freeze 浅冻结数组防止 executor push/pop/splice；
      //    ExperienceCase 接口字段均为 readonly，浅冻结 + readonly 字段共同保证不可变性
      this.context.globalState["__experienceRecall"] = Object.freeze([...cases]);

      this.logger.info(`[NodeLoopKernel:${this.node.nodeId}] 经验召回完成：返回 ${cases.length} 个相似案例`, {
        caseIds: cases.map((c) => c.caseId),
        similarities: cases.map((c) => ({
          caseId: c.caseId,
          taskType: c.taskType,
          success: c.success,
        })),
      });
    } catch (err) {
      // 容错：召回异常不影响主流程，recalledCases 保持空数组
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[NodeLoopKernel:${this.node.nodeId}] 经验召回异常，跳过召回：${errMsg}`);
      this.recalledCases = [];
      // 清理可能残留的全局状态
      delete this.context.globalState["__experienceRecall"];
    }
  }

  /**
   * 提取任务特征（Phase 4 集成，对齐 §14.1）
   *
   * 从节点定义和输入数据中提取用于相似度匹配的任务特征。
   *
   * 特征提取策略：
   * 1. 必填特征：
   *    - taskType：从 node.loopConfig.loopType 提取（如 "coding" / "design" / "testing"）
   *    - nodeType：节点类型（如 "loop" / "task"）
   * 2. 可选特征（从 node.overrides 合并）：
   *    - 跳过以 __ 开头的内部字段
   *    - 保留所有基本类型和对象类型字段
   *    - 设计意图：overrides 是用户显式配置的任务特征，应完整保留
   * 3. 可选特征（从 input 合并）：
   *    - 跳过以 __ 开头的内部字段
   *    - 只保留基本类型（string / number / boolean），避免复杂对象污染特征空间
   *    - 设计意图：input 是隐式数据流（可能含文件内容、配置对象等复杂结构），
   *      保留所有类型会污染特征空间，因此仅保留基本类型
   *
   * overrides vs input 类型策略差异说明：
   * - overrides 保留所有类型：因为 overrides 是用户显式声明的特征配置，对象类型字段
   *   （如 { tags: ["a", "b"] }）可能是有效的特征
   * - input 仅保留基本类型：因为 input 是数据流，复杂对象（如文件内容、大配置对象）
   *   不应作为相似度匹配的特征
   *
   * @returns 任务特征字典（键值对形式，供 computeSimilarity 计算）
   */
  private extractTaskFeatures(): Record<string, unknown> {
    const features: Record<string, unknown> = {};

    // 1. 必填特征：taskType / nodeType
    features["taskType"] = this.node.loopConfig?.loopType ?? "unknown";
    features["nodeType"] = this.node.nodeType;

    // 2. 合并 node.overrides 中的特征字段（跳过内部字段）
    if (this.node.overrides) {
      for (const [key, value] of Object.entries(this.node.overrides)) {
        if (key.startsWith("__")) continue;
        features[key] = value;
      }
    }

    // 3. 合并 input 中的基本类型特征字段（跳过内部字段）
    //    只保留 string / number / boolean，避免复杂对象污染特征空间
    for (const [key, value] of Object.entries(this.input)) {
      if (key.startsWith("__")) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        features[key] = value;
      }
    }

    return features;
  }

  /**
   * Handoff 阶段：调用 executor 回调执行任务
   *
   * 将 Discovery 阶段的目标和反馈传递给 executor 回调，
   * executor 内部负责实际执行（LLM 调用 / plugin 调用等）。
   *
   * @param iteration 当前迭代轮次
   * @param feedback 上一轮验证反馈（修复轮使用，首轮为 undefined）
   * @returns Generator 执行结果（按约定字段返回 success/test_result 等）
   */
  private async runHandoff(iteration: number, feedback: LoopEvaluationVerdict | undefined): Promise<GeneratorResult> {
    this.logger.debug(`[NodeLoopKernel:${this.node.nodeId}] Handoff 阶段：调用 executor`, {
      iteration,
      hasFeedback: feedback !== undefined,
    });

    const generatorResult = await this.executor(iteration, this.input, this.context, feedback);

    // 累计 token 消耗（从 generatorResult.token_used 读取，约定字段）
    const tokenUsed = this.readNumberField(generatorResult, "token_used");
    if (tokenUsed > 0) {
      this.cumulativeTokens += tokenUsed;
      this.context.totalTokensUsed += tokenUsed;
    }

    return generatorResult;
  }

  /**
   * Verification 阶段：调用 evaluator 回调验证结果
   *
   * 将 executor 产出的 generatorResult 传递给 evaluator 回调，
   * evaluator 内部负责实际验证（测试运行 / lint 检查 / 契约校验等）。
   *
   * @param iteration 当前迭代轮次
   * @param generatorResult executor 产出的结果
   * @returns 独立 Evaluator 判定结果（passed/findings/severity 等）
   */
  private async runVerification(iteration: number, generatorResult: GeneratorResult): Promise<LoopEvaluationVerdict> {
    this.logger.debug(`[NodeLoopKernel:${this.node.nodeId}] Verification 阶段：调用 evaluator`, { iteration });

    return this.evaluator(iteration, generatorResult, this.input, this.context);
  }

  /**
   * Persistence 阶段：将本轮结果写入 events 数组
   *
   * 记录本轮五步闭环的产物到内部 events 数组，供：
   * - 输出提取（从最后轮次的 generatorResult 提取输出）
   * - 审计和调试（事件序列可追溯每轮执行过程）
   *
   * @param iteration 当前迭代轮次
   * @param discovery Discovery 阶段结果（含目标、反馈、召回案例）
   * @param generatorResult Handoff 阶段产出的结果
   * @param verdict Verification 阶段的判定结果
   */
  private runPersistence(
    iteration: number,
    discovery: {
      objective: string;
      feedback: LoopEvaluationVerdict | undefined;
      recalledCases: ReadonlyArray<ExperienceCase>;
    },
    generatorResult: GeneratorResult,
    verdict: LoopEvaluationVerdict
  ): void {
    // 构造 LoopEvent 并写入 events 数组（对齐 eag/loop/models LoopEvent 接口）
    // payload 中包含 recalledCases（Phase 4 集成），便于审计追溯召回案例对每轮执行的影响
    const event: LoopEvent = {
      eventId: `${this.context.runId}-${this.node.nodeId}-${iteration}`,
      eventType: verdict.passed ? "verification_passed" : "verification_rejected",
      phase: "verification",
      runId: this.context.runId,
      iterIndex: iteration - 1, // iterIndex 从 0 开始
      payload: Object.freeze({
        objective: discovery.objective,
        generatorResult,
        verdict,
        // 经验召回的相似案例（Phase 4 集成，对齐 §12.3）
        recalledCases: discovery.recalledCases,
      }),
      timestamp: new Date().toISOString(),
    };
    this.events.push(event);
  }

  /**
   * Scheduling 阶段：调用 LoopScheduler.decideNext() 决策
   *
   * 复用 eag/loop/scheduler 的决策逻辑：
   * - Token 预算硬上限 → STOP_FAILURE
   * - 最大迭代次数硬上限 → STOP_SUCCESS / STOP_FAILURE
   * - 验证通过 + 满足停止条件 → STOP_SUCCESS
   * - 验证通过 + 未满足停止条件 → CONTINUE
   * - 验证未通过 + 连续失败 < 3 → FIX
   * - 验证未通过 + 连续失败 >= 3 → HUMAN_CHECKPOINT
   * - 验证未通过 + 连续失败 >= 5 → STOP_FAILURE
   *
   * @param iteration 当前迭代轮次
   * @param verdict 本轮验证判定
   * @returns 调度决策（CONTINUE / FIX / HUMAN_CHECKPOINT / STOP_SUCCESS / STOP_FAILURE）
   */
  private runScheduling(iteration: number, verdict: LoopEvaluationVerdict): SchedulingDecision {
    return this.scheduler.decideNext(
      iteration - 1, // currentIter 从 0 开始
      verdict,
      this.events,
      this.cumulativeTokens,
      this.consecutiveFailures
    );
  }

  // ========================================================================
  // 辅助方法
  // ========================================================================

  /**
   * 从 NodeLoopConfig 映射为 LoopEngineeringConfig
   *
   * 复用 eag/loop/models 的 createLoopEngineeringConfig 工厂函数，
   * 将图场景的简化配置（NodeLoopConfig）映射为完整的 LoopEngineeringConfig。
   *
   * 缺省字段：
   * - projectRoot / runDir / notesPath / testCommand 等：使用默认值（图场景不依赖这些字段）
   * - samplingReadRatio：使用默认值 0.1
   * - extra：空对象
   *
   * @param nodeLoopConfig 节点内 Loop 配置
   * @returns 完整的 LoopEngineeringConfig（冻结）
   */
  private buildLoopEngineeringConfig(nodeLoopConfig: Readonly<NodeLoopConfig>): Readonly<LoopEngineeringConfig> {
    return createLoopEngineeringConfig({
      loopType: nodeLoopConfig.loopType,
      discoveryMode: nodeLoopConfig.discoveryMode,
      evaluatorMode: nodeLoopConfig.evaluatorMode,
      maxIterations: nodeLoopConfig.maxIterations,
      maxTokens: nodeLoopConfig.maxTokens,
      humanCheckpointEvery: nodeLoopConfig.humanCheckpointEvery,
      samplingReadRatio: 0.1, // 默认抽样 10%
      stopWhen: nodeLoopConfig.stopWhen,
      stageOrder: nodeLoopConfig.stageOrder ?? [...DEFAULT_STAGE_ORDER],
      projectRoot: ".", // 图场景不依赖 projectRoot，使用默认值
      runDir: ".gnhf/runs", // 默认 run 目录
      notesPath: "notes.md", // 默认 notes 路径
      testCommand: "echo 'no test command'", // 图场景由 evaluator 回调负责测试
      testTimeoutSec: 600,
      securityAnalyzer: "builtin",
      autoCommit: nodeLoopConfig.autoCommit,
      extra: Object.freeze({}),
    });
  }

  /**
   * 校验输入数据是否符合 inputContract
   *
   * 校验规则：
   * - required=true 但字段缺失 → 抛出 Error
   * - 字段存在时执行类型校验（type !== "any" 时）
   *
   * @throws {Error} 当必填字段缺失或类型不匹配时抛出
   */
  private validateInputContract(): void {
    for (const contract of this.node.inputContract) {
      const hasField = Object.prototype.hasOwnProperty.call(this.input, contract.name);
      const value = this.input[contract.name];

      if (!hasField || value === undefined) {
        if (contract.required && contract.defaultValue === undefined) {
          throw new Error(
            `NodeLoopKernel: 节点 ${this.node.nodeId} 的必填输入字段 "${contract.name}" 缺失（required=true 且无 defaultValue）`
          );
        }
        continue;
      }

      // 类型校验
      if (contract.type !== "any") {
        this.checkFieldType(contract.name, value, contract.type);
      }
    }
  }

  /**
   * 校验输出数据是否符合 outputContract
   *
   * @param output 节点输出数据
   * @returns 错误信息（null 表示校验通过）
   */
  private validateOutputContract(output: Record<string, unknown>): string | null {
    for (const contract of this.node.outputContract) {
      const hasField = Object.prototype.hasOwnProperty.call(output, contract.name);
      const value = output[contract.name];

      if (!hasField || value === undefined) {
        if (contract.required) {
          return `必填输出字段 "${contract.name}" 缺失（required=true）`;
        }
        continue;
      }

      if (contract.type !== "any") {
        const typeError = this.checkFieldTypeReturnError(contract.name, value, contract.type);
        if (typeError) {
          return typeError;
        }
      }
    }
    return null;
  }

  /**
   * 检查字段值类型是否匹配（校验输入时直接抛错）
   *
   * @param fieldName 字段名
   * @param value 字段值
   * @param expectedType 期望类型
   * @throws {Error} 当类型不匹配时抛出
   */
  private checkFieldType(fieldName: string, value: unknown, expectedType: NodeFieldContract["type"]): void {
    const error = this.checkFieldTypeReturnError(fieldName, value, expectedType);
    if (error) {
      throw new Error(`NodeLoopKernel: 节点 ${this.node.nodeId} 的 ${error}`);
    }
  }

  /**
   * 检查字段值类型是否匹配（返回错误信息，不抛错）
   *
   * @param fieldName 字段名
   * @param value 字段值
   * @param expectedType 期望类型
   * @returns 错误信息（null 表示类型匹配）
   */
  private checkFieldTypeReturnError(
    fieldName: string,
    value: unknown,
    expectedType: NodeFieldContract["type"]
  ): string | null {
    let typeMatched = false;
    switch (expectedType) {
      case "string":
        typeMatched = typeof value === "string";
        break;
      case "number":
        typeMatched = typeof value === "number" && !Number.isNaN(value);
        break;
      case "boolean":
        typeMatched = typeof value === "boolean";
        break;
      case "object":
        typeMatched = typeof value === "object" && value !== null && !Array.isArray(value);
        break;
      case "array":
        typeMatched = Array.isArray(value);
        break;
      case "any":
        typeMatched = true;
        break;
    }
    if (!typeMatched) {
      const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      return `字段 "${fieldName}" 类型不匹配，期望=${expectedType}，实际=${actualType}`;
    }
    return null;
  }

  /**
   * 从 lastGeneratorResult 提取节点输出数据
   *
   * 输出提取规则（对齐 §10.3）：
   * - 优先从 generatorResult.output 提取（约定字段）
   * - 若 generatorResult 无 output 字段，则使用整个 generatorResult 作为输出
   *
   * @returns 节点输出数据
   */
  private extractOutput(): Record<string, unknown> {
    if (!this.lastGeneratorResult) {
      return {};
    }

    // 优先从 generatorResult.output 提取
    const outputField = this.lastGeneratorResult["output"];
    if (outputField && typeof outputField === "object" && !Array.isArray(outputField)) {
      return { ...(outputField as Record<string, unknown>) };
    }

    // 退化：使用整个 generatorResult 作为输出
    return { ...this.lastGeneratorResult };
  }

  /**
   * 从对象中读取数值字段（带类型守卫）
   *
   * @param obj 源对象
   * @param key 字段名
   * @returns 数值（不存在或非数值时返回 0）
   */
  private readNumberField(obj: Readonly<Record<string, unknown>>, key: string): number {
    const raw = obj[key];
    if (typeof raw === "number" && !Number.isNaN(raw)) {
      return raw;
    }
    return 0;
  }

  /**
   * 获取内部事件序列（用于审计和调试）
   *
   * @returns 事件序列的只读快照
   */
  getEvents(): ReadonlyArray<LoopEvent> {
    return [...this.events];
  }

  /**
   * 获取累计 token 消耗
   *
   * @returns 累计 token 数
   */
  getCumulativeTokens(): number {
    return this.cumulativeTokens;
  }

  /**
   * 获取经验召回的相似案例列表（Phase 4 集成，用于测试和审计）
   *
   * 在 run() 执行前返回空数组，run() 执行后返回召回结果（可能为空数组）。
   *
   * @returns 召回案例列表的只读快照
   */
  getRecalledCases(): ReadonlyArray<ExperienceCase> {
    return [...this.recalledCases];
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 创建基于 console 的默认日志记录器
 *
 * @returns GraphLogger 实例（使用 console 输出日志）
 */
function createConsoleLogger(): GraphLogger {
  return {
    debug: (message, context) => console.debug(message, context ?? ""),
    info: (message, context) => console.info(message, context ?? ""),
    warn: (message, context) => console.warn(message, context ?? ""),
    error: (message, context) => console.error(message, context ?? ""),
  };
}

/**
 * Sleep 工具函数
 *
 * @param ms 毫秒数
 * @returns Promise（ms 毫秒后 resolve）
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
