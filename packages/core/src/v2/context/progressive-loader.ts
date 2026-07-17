/**
 * 渐进式三层加载器（ProgressiveContextLoader）—— F-FOCUS-03
 *
 * 对抗"中间迷失"问题：将上下文按优先级分三层加载，
 * 确保高优先级信息（任务元数据）在低优先级信息（资源细节）之前注入。
 *
 * 设计依据：
 * - V2_P2_IMPLEMENTATION_PLAN.md §3.2
 * - V2 技术方案 §6.6 ProgressiveContextLoader
 * - V2 测试方案 §2.7（编号 PCL-01/02/03，避免与 V2-P1 SW-05~10 冲突）
 * - 参考 WoAgent ProgressiveContextLoader.java
 *
 * 三层语义（§6.6）：
 * - Metadata 层（10% 预算）：始终加载，含任务类型、目标、思考数量
 *   → 确保 LLM 始终知道"在做什么任务"
 * - Instruction 层（40% 预算）：按需加载，含任务目标、需求、约束、最近 3 条思考摘要
 *   → 提供任务执行的详细指导信息
 * - Resource 层（50% 预算）：执行时加载，含最近 5 条中间结果
 *   → 提供任务执行的具体资源信息
 *
 * TaskContext 字段映射（types.ts as-built 确认，无需新增字段）：
 * - 任务类型 → taskContext.taskDefinition.taskType
 * - 任务目标 → taskContext.taskDefinition.goals
 * - 需求 → taskContext.taskDefinition.description（语义映射，TaskDefinition 无独立 requirements 字段）
 * - 约束 → taskContext.taskDefinition.constraints
 * - 思考数量 → taskContext.workingMemory.thoughtHistory.length
 * - 思考摘要 → taskContext.workingMemory.thoughtHistory.slice(-3)
 * - 中间结果 → taskContext.workingMemory.intermediateResults.slice(-5)
 *
 * 预算分配（§6.5）：
 * - Metadata 层：10%（默认 0.1）
 * - Instruction 层：40%（默认 0.4）
 * - Resource 层：50%（默认 0.5）
 * - 三层比例可配置，但总和应为 1.0（不强制校验，由调用方保证）
 *
 * @module v2/context/progressive-loader
 */

import type { TaskContext } from "./types";
import type { ContextSnippet } from "../integration/session-hook";

/**
 * 渐进式三层加载器配置
 *
 * 三层预算比例（与 SlidingWindowConfig 对齐，技术方案 §6.5）：
 * - Metadata 层：10%（任务类型、目标、思考数量）
 * - Instruction 层：40%（任务目标、需求、约束、最近 3 条思考摘要）
 * - Resource 层：50%（最近 5 条中间结果）
 */
export interface ProgressiveLoaderConfig {
  /** 总 Token 预算 */
  tokenBudget: number;
  /** Metadata 层预算占比（默认 0.1） */
  metadataBudgetRatio: number;
  /** Instruction 层预算占比（默认 0.4） */
  instructionBudgetRatio: number;
  /** Resource 层预算占比（默认 0.5） */
  resourceBudgetRatio: number;
  /** 字符→token 估算系数（默认 4，与 SlidingWindowManager 一致） */
  charsPerToken: number;
  /** Instruction 层保留最近 N 条思考摘要（默认 3） */
  recentThoughtsCount: number;
  /** Resource 层保留最近 N 条中间结果（默认 5） */
  recentIntermediatesCount: number;
}

/**
 * 三层加载结果
 *
 * 由 loadAll 方法返回，含三层各自片段和累计 Token 估算。
 */
export interface ProgressiveLoadResult {
  /** Metadata 层片段（始终非空，至少 1 个片段） */
  metadata: ContextSnippet[];
  /** Instruction 层片段（始终非空，至少 1 个片段） */
  instruction: ContextSnippet[];
  /** Resource 层片段（无中间结果时为空数组） */
  resource: ContextSnippet[];
  /** 三层累计估算 Token 数 */
  totalTokens: number;
}

/**
 * 渐进式三层加载器（F-FOCUS-03）
 *
 * 使用方式：
 * ```typescript
 * const loader = new ProgressiveContextLoader({ tokenBudget: 10000 });
 * const result = await loader.loadAll(taskContext);
 * // result.metadata / result.instruction / result.resource
 * ```
 *
 * 三层加载顺序（§6.6）：
 * 1. Metadata 层（最高优先级，始终加载）
 * 2. Instruction 层（中优先级，按需加载）
 * 3. Resource 层（低优先级，执行时加载）
 *
 * loadAll 并行加载三层（Promise.all），不保证顺序但返回值按固定结构组织。
 */
export class ProgressiveContextLoader {
  private readonly config: ProgressiveLoaderConfig;

  /** 默认配置（三层比例 10%/40%/50%，技术方案 §6.5） */
  private static readonly DEFAULT_CONFIG: ProgressiveLoaderConfig = {
    tokenBudget: 100_000,
    metadataBudgetRatio: 0.1,
    instructionBudgetRatio: 0.4,
    resourceBudgetRatio: 0.5,
    charsPerToken: 4,
    recentThoughtsCount: 3,
    recentIntermediatesCount: 5,
  };

  /**
   * @param config 可选的配置覆盖（缺省字段使用 DEFAULT_CONFIG）
   */
  constructor(config: Partial<ProgressiveLoaderConfig> = {}) {
    this.config = { ...ProgressiveContextLoader.DEFAULT_CONFIG, ...config };
  }

  /**
   * 加载 Metadata 层（10% 预算）
   *
   * 始终加载：任务类型、目标、思考数量。
   * 这是最高优先级层，确保 LLM 始终知道"在做什么任务"。
   *
   * 产出片段格式：
   * ```
   * [Metadata 层]
   * 任务类型: bugfix
   * 任务目标: 修复登录; 优化性能
   * 思考数量: 5
   * ```
   *
   * @param taskContext 当前任务上下文
   * @returns Metadata 层片段列表（1 个片段）
   */
  async loadMetadataLayer(taskContext: TaskContext): Promise<ContextSnippet[]> {
    const td = taskContext.taskDefinition;
    const wm = taskContext.workingMemory;
    const lines: string[] = [
      `[Metadata 层]`,
      `任务类型: ${td.taskType}`,
      `任务目标: ${td.goals.join("; ")}`,
      `思考数量: ${wm.thoughtHistory.length}`,
    ];
    return [
      {
        type: "progressive_metadata",
        content: lines.join("\n"),
        source: `progressive:metadata:${taskContext.taskId}`,
        relevance: 1.0,
      },
    ];
  }

  /**
   * 加载 Instruction 层（40% 预算）
   *
   * 按需加载：任务目标、需求、约束、最近 3 条思考摘要。
   * 这层提供任务执行的详细指导信息。
   *
   * 产出片段格式：
   * ```
   * [Instruction 层]
   * 任务目标: 修复登录
   * 需求: 用户报告登录后跳转错误页面
   * 约束: 零依赖; 不影响现有功能
   * 最近思考摘要:
   *   - [分析] 定位到路由配置错误
   *   - [实现] 修改 router.ts
   * ```
   *
   * @param taskContext 当前任务上下文
   * @returns Instruction 层片段列表（1 个片段）
   */
  async loadInstructionLayer(taskContext: TaskContext): Promise<ContextSnippet[]> {
    const td = taskContext.taskDefinition;
    const wm = taskContext.workingMemory;
    const lines: string[] = [
      `[Instruction 层]`,
      `任务目标: ${td.goals.join("; ")}`,
      `需求: ${td.description}`,
      `约束: ${td.constraints.join("; ")}`,
    ];
    // 最近 N 条思考摘要（默认 3 条）
    const recentThoughts = wm.thoughtHistory.slice(-this.config.recentThoughtsCount);
    if (recentThoughts.length > 0) {
      lines.push(`最近思考摘要:`);
      for (const t of recentThoughts) {
        lines.push(`  - [${t.stage}] ${t.thought}`);
      }
    }
    return [
      {
        type: "progressive_instruction",
        content: lines.join("\n"),
        source: `progressive:instruction:${taskContext.taskId}`,
        relevance: 0.9,
      },
    ];
  }

  /**
   * 加载 Resource 层（50% 预算）
   *
   * 执行时加载：最近 5 条中间结果。
   * 这层提供任务执行的具体资源信息。
   *
   * 产出片段格式：
   * ```
   * [Resource 层]
   * 最近中间结果:
   *   - [grep] 找到 3 处路由配置
   *   - [edit] 已修改 router.ts
   * ```
   *
   * 边界处理：
   * - 无中间结果 → 返回空数组（不产出空片段）
   *
   * @param taskContext 当前任务上下文
   * @returns Resource 层片段列表（0 或 1 个片段）
   */
  async loadResourceLayer(taskContext: TaskContext): Promise<ContextSnippet[]> {
    const wm = taskContext.workingMemory;
    const recentIntermediates = wm.intermediateResults.slice(-this.config.recentIntermediatesCount);
    if (recentIntermediates.length === 0) {
      // 无中间结果：返回空数组（不产出空片段，避免挤占预算）
      return [];
    }
    const lines: string[] = [`[Resource 层]`, `最近中间结果:`];
    for (const i of recentIntermediates) {
      lines.push(`  - [${i.source}] ${i.result}`);
    }
    return [
      {
        type: "progressive_resource",
        content: lines.join("\n"),
        source: `progressive:resource:${taskContext.taskId}`,
        relevance: 0.7,
      },
    ];
  }

  /**
   * 完整三层加载
   *
   * 按 Metadata → Instruction → Resource 顺序加载，返回三层片段聚合。
   * 内部使用 Promise.all 并行加载三层（无相互依赖，提升性能）。
   *
   * @param taskContext 当前任务上下文
   * @returns 三层加载结果（含每层片段与累计 Token）
   */
  async loadAll(taskContext: TaskContext): Promise<ProgressiveLoadResult> {
    const [metadata, instruction, resource] = await Promise.all([
      this.loadMetadataLayer(taskContext),
      this.loadInstructionLayer(taskContext),
      this.loadResourceLayer(taskContext),
    ]);
    const allSnippets = [...metadata, ...instruction, ...resource];
    const totalTokens = this.estimateTokens(allSnippets);
    return { metadata, instruction, resource, totalTokens };
  }

  /**
   * 获取三层预算分配（供测试断言，PCL-05 / SW-COMPRESS-03）
   *
   * 返回三层各自的 Token 预算数（按 config 比例 * tokenBudget 计算）。
   *
   * @returns 三层预算 Token 数
   */
  getBudgetAllocation(): { metadata: number; instruction: number; resource: number } {
    return {
      metadata: Math.floor(this.config.tokenBudget * this.config.metadataBudgetRatio),
      instruction: Math.floor(this.config.tokenBudget * this.config.instructionBudgetRatio),
      resource: Math.floor(this.config.tokenBudget * this.config.resourceBudgetRatio),
    };
  }

  /**
   * 获取当前配置（供 SlidingWindowManager 透传使用）
   *
   * @returns 配置对象（只读视图）
   */
  getConfig(): Readonly<ProgressiveLoaderConfig> {
    return this.config;
  }

  // ========================================================================
  // 私有辅助方法
  // ========================================================================

  /**
   * 估算片段列表的 Token 数
   *
   * 估算公式：tokenCount = sum(ceil(content.length / charsPerToken))
   * 与 SlidingWindowManager.estimateTokens 一致（4 字符≈1 token）。
   *
   * @param snippets 片段列表
   * @returns 估算 Token 数
   */
  private estimateTokens(snippets: ContextSnippet[]): number {
    let totalChars = 0;
    for (const snippet of snippets) {
      totalChars += snippet.content.length;
    }
    return Math.ceil(totalChars / this.config.charsPerToken);
  }
}
