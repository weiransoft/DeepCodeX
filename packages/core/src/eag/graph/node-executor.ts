/**
 * 图节点执行器实现（v2.0 实现，对齐设计文档 §8.1）
 *
 * NodeExecutorImpl 是 NodeExecutorProtocol 的生产实现，负责根据 GraphNodeDef.nodeType
 * 将单个图节点分派到对应的执行路径：
 * - loop 节点：创建 NodeLoopKernel，通过 LoopHandoffAdapter 注入 executor / evaluator 回调，
 *   执行五步闭环（Discovery→Handoff→Verification→Persistence→Scheduling）。
 * - task 节点：通过注入的 GoalDispatcher 调度单 Goal 批次，调用已注册的 team plugin。
 * - decision / merge / fork / end 节点：由图级调度器 GraphScheduler 负责路由/并行/汇聚，
 *   节点执行器仅做透传，返回 completed 并将输入作为输出。
 *
 * 依赖注入设计：
 * - GoalDispatcher：task 节点调度必需，由调用方装配好 plugin 注册表后注入。
 * - LoopHandoffAdapter：loop 节点必需，负责构造真实 Handoff / Verification 回调。
 * - ExperienceStoreProtocol（可选）：启用 loop 节点经验召回（Phase 4）。
 * - GraphLogger（可选）：运行期日志输出。
 *
 * 错误处理策略：
 * - execute() 内部捕获所有异常，返回 status="failed" 的 GraphNodeResult，绝不向上抛异常。
 * - 节点缺少必要配置（loop 节点无 loopConfig / task 节点无 plugin）直接返回 failed。
 * - 取消信号由 NodeLoopKernel 内部处理；执行器入口也做防御性检查。
 *
 * @module eag/graph/node-executor
 */

import * as crypto from "crypto";
import type {
  /** 节点执行器协议 */
  NodeExecutorProtocol,
  /** Loop 节点 Handoff 回调适配器协议 */
  LoopHandoffAdapter,
  /** 经验存储协议（可选） */
  ExperienceStoreProtocol,
} from "./graph-loop-protocols";
import type {
  /** 图节点定义 */
  GraphNodeDef,
  /** 图节点执行结果 */
  GraphNodeResult,
  /** 图运行上下文 */
  GraphRunContext,
  /** 图日志记录器接口 */
  GraphLogger,
} from "./graph-loop-models";
/** Loop 运行报告（定义在 eag/loop/models，graph-loop-models 复用导出） */
import type { LoopRunReport } from "../loop/models";
/** 节点内循环内核 */
import { NodeLoopKernel } from "./node-loop-kernel";
import type {
  /** Goal 调度器 */
  GoalDispatcher,
  /** 批次执行结果 */
  BatchResult,
  /** Goal 执行状态 */
  GoalState,
} from "../../team/plugins/goal-dispatcher.js";
/** Goal 构造工厂函数 */
import { makeGoal, makeBatch } from "../../team/plugins/goal-dispatcher.js";
import type { TaskRequirement } from "../../team/types.js";

// ============================================================================
// NodeExecutorImpl 构造选项
// ============================================================================

/**
 * NodeExecutorImpl 构造选项
 *
 * 通过依赖注入方式传入所有协作组件，便于测试替换和 CLI 层装配。
 *
 * 必需组件：
 * - goalDispatcher：task 节点调度器（需预先注册好 plugin）
 * - loopHandoffAdapter：loop 节点回调适配器
 *
 * 可选组件：
 * - experienceStore：经验存储（启用 loop 节点经验召回）
 * - logger：日志记录器（默认使用 console）
 */
export interface NodeExecutorImplOptions {
  /** task 节点调度器（必需） */
  readonly goalDispatcher: GoalDispatcher;
  /** loop 节点 Handoff 回调适配器（必需） */
  readonly loopHandoffAdapter: LoopHandoffAdapter;
  /**
   * 经验存储（可选）
   *
   * 当提供且图级配置 enableExperienceRecall=true 时，NodeLoopKernel 会在 Discovery 阶段前
   * 调用 recallSimilar 查询相似案例。
   */
  readonly experienceStore?: ExperienceStoreProtocol;
  /** 日志记录器（可选，默认使用 console） */
  readonly logger?: GraphLogger;
}

// ============================================================================
// NodeExecutorImpl 实现类
// ============================================================================

/**
 * 图节点执行器实现类
 *
 * 实现 NodeExecutorProtocol，根据节点类型分派执行逻辑：
 * - loop：NodeLoopKernel + LoopHandoffAdapter
 * - task：GoalDispatcher + makeGoal/makeBatch
 * - decision / merge / fork / end：透传 completed
 *
 * 使用示例：
 * ```typescript
 * const executor = new NodeExecutorImpl({
 *   goalDispatcher,
 *   loopHandoffAdapter,
 *   experienceStore,
 *   logger,
 * });
 * const result = await executor.execute(node, input, context);
 * ```
 */
export class NodeExecutorImpl implements NodeExecutorProtocol {
  /** task 节点调度器 */
  private readonly goalDispatcher: GoalDispatcher;
  /** loop 节点 Handoff 回调适配器 */
  private readonly loopHandoffAdapter: LoopHandoffAdapter;
  /** 经验存储（可选） */
  private readonly experienceStore?: ExperienceStoreProtocol;
  /** 日志记录器 */
  private readonly logger: GraphLogger;

  /**
   * 构造节点执行器
   *
   * @param options 构造选项
   * @throws {Error} 当缺少 goalDispatcher 或 loopHandoffAdapter 时抛出
   */
  constructor(options: NodeExecutorImplOptions) {
    if (!options) {
      throw new Error("NodeExecutorImpl 构造失败：options 必填");
    }
    if (!options.goalDispatcher) {
      throw new Error("NodeExecutorImpl 构造失败：goalDispatcher 必填");
    }
    if (!options.loopHandoffAdapter) {
      throw new Error("NodeExecutorImpl 构造失败：loopHandoffAdapter 必填");
    }
    this.goalDispatcher = options.goalDispatcher;
    this.loopHandoffAdapter = options.loopHandoffAdapter;
    this.experienceStore = options.experienceStore;
    this.logger = options.logger ?? createConsoleLogger();
  }

  /**
   * 执行单个图节点
   *
   * 根据 node.nodeType 分派到对应执行路径，所有异常均在内部捕获并返回 failed 结果。
   *
   * @param node 节点定义
   * @param input 边解析后的输入数据
   * @param context 图运行上下文
   * @returns 节点执行结果
   */
  async execute(
    node: Readonly<GraphNodeDef>,
    input: Readonly<Record<string, unknown>>,
    context: Readonly<GraphRunContext>
  ): Promise<GraphNodeResult> {
    const startedAtMs = Date.now();
    const nodeId = node.nodeId;

    this.logger.info(`[NodeExecutorImpl:${nodeId}] 开始执行 ${node.nodeType} 节点`, {
      nodeType: node.nodeType,
      task: node.task,
    });

    // 防御性取消检查：若图已取消，直接返回 failed（NodeLoopKernel 内部也会再次检查）
    if (context.cancelled) {
      const reason = "用户取消（context.cancelled=true）";
      this.logger.warn(`[NodeExecutorImpl:${nodeId}] ${reason}`);
      return this.buildFailedResult(node, reason, startedAtMs);
    }

    try {
      switch (node.nodeType) {
        case "loop":
          return await this.executeLoopNode(node, input, context, startedAtMs);
        case "task":
          return await this.executeTaskNode(node, input, context, startedAtMs);
        case "decision":
        case "merge":
        case "fork":
        case "end":
          // 这些节点的路由/并行/汇聚逻辑由 GraphScheduler 负责，执行器仅透传输入
          return this.buildCompletedResult(node, input, startedAtMs);
        default:
          // 枚举 exhaustive 兜底：遇到未知节点类型返回 failed
          return this.buildFailedResult(node, `不支持的节点类型：${(node as GraphNodeDef).nodeType}`, startedAtMs);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`[NodeExecutorImpl:${nodeId}] 执行异常：${reason}`);
      return this.buildFailedResult(node, `执行异常：${reason}`, startedAtMs);
    }
  }

  // ========================================================================
  // 各类型节点执行逻辑
  // ========================================================================

  /**
   * 执行 loop 节点
   *
   * 流程：
   * 1. 校验 node.loopConfig 存在
   * 2. 通过 LoopHandoffAdapter 构造 executor / evaluator 回调
   * 3. 创建 NodeLoopKernel 并执行 run()
   * 4. 从 kernel 提取事件序列、迭代次数、累计 token
   * 5. 构造 LoopRunReport 并附加到 GraphNodeResult.loopReport
   * 6. 设置 llmCallCount=0（NodeLoopKernel 不统计 LLM 调用次数）
   *
   * @param node loop 节点定义
   * @param input 节点输入数据
   * @param context 图运行上下文
   * @param startedAtMs 执行开始时间戳（毫秒）
   * @returns 节点执行结果
   */
  private async executeLoopNode(
    node: Readonly<GraphNodeDef>,
    input: Readonly<Record<string, unknown>>,
    context: Readonly<GraphRunContext>,
    startedAtMs: number
  ): Promise<GraphNodeResult> {
    if (!node.loopConfig) {
      return this.buildFailedResult(node, `loop 节点 ${node.nodeId} 缺少 loopConfig（必填）`, startedAtMs);
    }

    // 通过适配器构造 Loop 回调
    const executor = this.loopHandoffAdapter.createLoopExecutor(node, input, context);
    const evaluator = this.loopHandoffAdapter.createLoopEvaluator(node, input, context);

    // NodeLoopKernel 运行时会修改 context.totalTokensUsed / globalState，因此解除 readonly 类型约束
    const mutableContext = context as GraphRunContext;

    const kernel = new NodeLoopKernel({
      node,
      input,
      context: mutableContext,
      executor,
      evaluator,
      experienceStore: this.experienceStore,
      logger: this.logger,
    });

    const result = await kernel.run();
    const events = kernel.getEvents();
    const totalIterations = events.length;
    const cumulativeTokens = kernel.getCumulativeTokens();

    // 构造 LoopRunReport（对齐 eag/loop/models LoopRunReport 字段）
    const loopReport: LoopRunReport = {
      runId: context.runId,
      loopType: node.loopConfig.loopType,
      objective: node.task,
      totalIterations,
      finalStatus: result.status === "completed" ? "completed" : "failed",
      events,
      tokenUsed: cumulativeTokens,
      durationSec: result.durationSec,
      committedCount: 0, // 图场景由上层编排器统一控制提交，节点内核不自动 commit
      humanCheckpoints: [], // 图场景默认自动批准人工检查点
      finalSummary: result.status === "completed" ? node.task : (result.failureReason ?? node.task),
    };

    this.logger.info(`[NodeExecutorImpl:${node.nodeId}] loop 节点执行完成`, {
      status: result.status,
      totalIterations,
      cumulativeTokens,
    });

    return {
      ...result,
      loopReport: Object.freeze(loopReport),
      llmCallCount: 0, // NodeLoopKernel 不直接统计 LLM 调用次数，由适配器回调内部维护
    };
  }

  /**
   * 执行 task 节点
   *
   * 流程：
   * 1. 校验 node.plugin 存在
   * 2. 将 node.task 映射为 TaskRequirement
   * 3. 使用 makeGoal / makeBatch 构造单 Goal 批次
   * 4. 调用 GoalDispatcher.dispatch() 执行 plugin
   * 5. 将 BatchResult 映射为 GraphNodeResult
   *
   * 结果映射规则：
   * - overallStatus === "succeeded" → status="completed"
   * - 其他（failed / partial / cancelled）→ status="failed"
   * - output = { output: goalState.result?.output, artifacts: goalState.result?.artifacts }
   *
   * @param node task 节点定义
   * @param input 节点输入数据
   * @param context 图运行上下文
   * @param startedAtMs 执行开始时间戳（毫秒）
   * @returns 节点执行结果
   */
  private async executeTaskNode(
    node: Readonly<GraphNodeDef>,
    input: Readonly<Record<string, unknown>>,
    context: Readonly<GraphRunContext>,
    startedAtMs: number
  ): Promise<GraphNodeResult> {
    const pluginName = node.plugin;
    if (!pluginName) {
      return this.buildFailedResult(node, `task 节点 ${node.nodeId} 未配置 plugin（必填）`, startedAtMs);
    }

    // 构造 TaskRequirement：将节点任务描述映射为团队调度所需的任务需求
    const taskRequirement: TaskRequirement = {
      taskId: crypto.randomUUID(),
      title: node.task.slice(0, 200) || `task-${node.nodeId}`,
      description: node.task || `task ${node.nodeId}`,
      requiredCapabilities: [],
      preferredSkills: [],
      constraints: [],
      attachments: [],
      upstreamContext: {},
      priority: "medium",
      timeoutMs: 0,
      createdAt: new Date().toISOString(),
      domainTags: [],
    };

    // 构造单 Goal 批次：将节点输入数据透传给 plugin execute 的 PluginContext.state
    const goal = makeGoal({
      plugin: pluginName,
      input: {
        ...input,
        task: node.task,
        nodeId: node.nodeId,
      },
    });
    const batch = makeBatch({ task: taskRequirement, goals: [goal] });

    this.logger.info(`[NodeExecutorImpl:${node.nodeId}] task 节点调度 plugin：${pluginName}`);

    let batchResult: BatchResult;
    try {
      batchResult = await this.goalDispatcher.dispatch(batch);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return this.buildFailedResult(node, `GoalDispatcher 调度异常：${reason}`, startedAtMs);
    }

    // 取第一个（也是唯一一个）Goal 状态
    const goalStates = Array.from(batchResult.goalStates.values());
    const goalState: GoalState | undefined = goalStates[0];
    const status: GraphNodeResult["status"] = batchResult.overallStatus === "succeeded" ? "completed" : "failed";
    const durationSec = (Date.now() - startedAtMs) / 1000;

    // 构造输出：提取 DispatchResult 中的 output 与 artifacts
    const output: Record<string, unknown> = {};
    const dispatchResult = goalState?.result;
    if (dispatchResult) {
      if (dispatchResult.output !== undefined) {
        output.output = dispatchResult.output;
      }
      if (dispatchResult.artifacts !== undefined && Array.isArray(dispatchResult.artifacts)) {
        output.artifacts = dispatchResult.artifacts;
      }
    }

    this.logger.info(`[NodeExecutorImpl:${node.nodeId}] task 节点执行完成`, {
      plugin: pluginName,
      overallStatus: batchResult.overallStatus,
      durationSec,
    });

    return {
      nodeId: node.nodeId,
      nodeType: node.nodeType,
      status,
      output: Object.freeze(output),
      durationSec,
      failureReason:
        status === "failed"
          ? (goalState?.error ?? `任务执行失败：overallStatus=${batchResult.overallStatus}`)
          : undefined,
      retryCount: goalState?.retryCount ?? 0,
    };
  }

  // ========================================================================
  // 结果构造辅助方法
  // ========================================================================

  /**
   * 构造 completed 状态的 GraphNodeResult
   *
   * 用于 decision / merge / fork / end 等透传节点，输出默认携带输入数据副本。
   *
   * @param node 节点定义
   * @param input 节点输入数据
   * @param startedAtMs 执行开始时间戳（毫秒）
   * @returns completed 状态结果
   */
  private buildCompletedResult(
    node: Readonly<GraphNodeDef>,
    input: Readonly<Record<string, unknown>>,
    startedAtMs: number
  ): GraphNodeResult {
    return {
      nodeId: node.nodeId,
      nodeType: node.nodeType,
      status: "completed",
      output: Object.freeze({ ...input }),
      durationSec: (Date.now() - startedAtMs) / 1000,
      retryCount: 0,
    };
  }

  /**
   * 构造 failed 状态的 GraphNodeResult
   *
   * 所有失败路径统一使用此方法，确保字段完整且输出不可变。
   *
   * @param node 节点定义
   * @param reason 失败原因
   * @param startedAtMs 执行开始时间戳（毫秒）
   * @returns failed 状态结果
   */
  private buildFailedResult(node: Readonly<GraphNodeDef>, reason: string, startedAtMs: number): GraphNodeResult {
    return {
      nodeId: node.nodeId,
      nodeType: node.nodeType,
      status: "failed",
      output: Object.freeze({}),
      durationSec: (Date.now() - startedAtMs) / 1000,
      failureReason: reason,
      retryCount: 0,
    };
  }
}

/**
 * 创建 NodeExecutorImpl 实例的工厂函数
 *
 * @param options 构造选项
 * @returns NodeExecutorImpl 实例
 */
export function createNodeExecutor(options: NodeExecutorImplOptions): NodeExecutorImpl {
  return new NodeExecutorImpl(options);
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 创建基于 console 的默认日志记录器
 *
 * @returns GraphLogger 实例
 */
function createConsoleLogger(): GraphLogger {
  return {
    debug: (message: string, context?: Record<string, unknown>) => console.debug(message, context ?? ""),
    info: (message: string, context?: Record<string, unknown>) => console.info(message, context ?? ""),
    warn: (message: string, context?: Record<string, unknown>) => console.warn(message, context ?? ""),
    error: (message: string, context?: Record<string, unknown>) => console.error(message, context ?? ""),
  };
}
