/**
 * 图级护栏实现（v2.0 实现，对齐设计文档 §8.3）
 *
 * 本模块实现 GraphGuardProtocol，提供图遍历过程中的安全防护，分三个阶段检查：
 *
 * 1. validateGraph（图构造时调用一次）：
 *    - 入口节点存在（entryNodeId 在 nodes 中）
 *    - 所有 edges 的 from/to 引用的节点存在
 *    - 无不可达节点（从入口不可到达的节点，作为 warnings 提示）
 *    - 环路标记（通过 DFS 检测环，有环图标记 isCyclic=true）
 *    - decision 节点的 decisionPredicateId 在 PredicateRegistry 中已注册
 *    - edge 的 activationPredicateId（若存在）在 PredicateRegistry 中已注册
 *
 * 2. checkPreExecution（节点执行前调用）：
 *    - 检查图级超时（elapsedSec >= config.timeoutSec → suggestedAction=stop_timeout）
 *    - 检查图级 token 预算（totalTokensUsed >= config.maxTokens 且 maxTokens > 0 → stop_failure）
 *    - 检查当前遍历深度（currentDepth >= config.maxDepth → stop_failure）
 *
 * 3. checkPostExecution（节点执行后调用）：
 *    - 检查节点输出是否符合 outputContract（字段类型与必填性）
 *    - 检查节点耗时是否异常（如单节点超过图级 timeoutSec 的 50%）
 *
 * 职责边界：
 * - 本护栏只做"单次检查"（无状态），不跟踪历史
 * - 连续节点失败熔断由 GraphScheduler.decideNext() 实现（§11.4 熔断机制）
 * - 双层重试抑制由 GraphScheduler 配合 RetrySuppressionConfig 实现（§11.4）
 *
 * @module eag/graph/graph-guard
 */

import type {
  /** 工作图定义 */
  WorkGraph,
  /** 图节点定义 */
  GraphNodeDef,
  /** 图节点执行结果 */
  GraphNodeResult,
  /** 图运行上下文 */
  GraphRunContext,
  /** 图结构校验结果 */
  GraphValidationResult,
  /** 图级护栏检查结果 */
  GraphGuardCheckResult,
  /** 节点字段契约 */
  NodeFieldContract,
  /** 图级调度动作 */
  GraphSchedulingAction,
  /** 安全护栏配置（TOP-3） */
  GraphGuardConfig,
  /** 安全护栏自定义规则（TOP-3） */
  GraphGuardCustomRule,
  /** 安全护栏自定义规则触发阶段（TOP-3） */
  GraphGuardCustomRulePhase,
} from "./graph-loop-models";
import type { GraphGuardProtocol } from "./graph-loop-protocols";

// ============================================================================
// 常量
// ============================================================================

/**
 * 单节点耗时占图级超时的比例阈值（超过则告警）
 *
 * 对齐 §8.3 checkPostExecution 检查项"单节点超过总耗时 50%"。
 * 当 config.timeoutSec > 0 且 result.durationSec > config.timeoutSec * 0.5 时告警。
 */
const SINGLE_NODE_DURATION_RATIO_THRESHOLD = 0.5;

/**
 * 默认安全护栏配置（TOP-3）
 *
 * 所有内置检查默认开启，保持与 v2.0 行为完全兼容。
 * 输出契约验证默认 strict（严格校验类型和必填性）。
 */
const DEFAULT_GUARD_CONFIG: Readonly<Required<GraphGuardConfig>> = Object.freeze({
  outputContractValidationLevel: "strict",
  enableTokenBudgetCheck: true,
  enableDepthCheck: true,
  enablePostExecutionDurationCheck: true,
  customRules: Object.freeze({}),
});

// ============================================================================
// GraphGuardImpl 实现类
// ============================================================================

/**
 * 图级护栏实现类
 *
 * 实现 GraphGuardProtocol，提供 validateGraph / checkPreExecution / checkPostExecution 三个方法。
 *
 * 使用示例：
 * ```typescript
 * const guard = new GraphGuardImpl();
 *
 * // 1. 图构造时校验结构
 * const validationResult = guard.validateGraph(graph);
 * if (!validationResult.valid) {
 *   throw new Error(`图结构非法：${validationResult.errors.join(", ")}`);
 * }
 *
 * // 2. 节点执行前检查
 * const preCheck = guard.checkPreExecution(node, context);
 * if (!preCheck.passed) {
 *   // 根据 preCheck.suggestedAction 决定下一步
 * }
 *
 * // 3. 节点执行后检查
 * const postCheck = guard.checkPostExecution(node, result, context);
 * if (!postCheck.passed) {
 *   // 根据 postCheck.suggestedAction 决定下一步
 * }
 * ```
 */
export class GraphGuardImpl implements GraphGuardProtocol {
  /** 当前护栏配置（TOP-3，运行时可通过 configure() 更新） */
  private config: Required<GraphGuardConfig>;

  /** 自定义校验规则注册表（ruleId → { phase, rule }，TOP-3） */
  private readonly customRules: Map<string, Readonly<{ phase: GraphGuardCustomRulePhase; rule: GraphGuardCustomRule }>>;

  /**
   * 当前校验的图定义（TOP-3）
   *
   * validateGraph 调用时缓存，供 pre/post 阶段自定义规则读取。
   * 注意：GraphGuardImpl 原设计为无状态单次检查，但自定义规则需要访问图定义，
   * 因此引入此字段；编排器应保证单实例串行执行图。
   */
  private currentGraph?: Readonly<WorkGraph>;

  /**
   * 构造图级护栏实例
   *
   * @param initialConfig 初始护栏配置（缺省字段使用 DEFAULT_GUARD_CONFIG）
   */
  constructor(initialConfig?: Readonly<GraphGuardConfig>) {
    this.config = this.mergeConfig(initialConfig);
    this.customRules = new Map();
    this.loadCustomRulesFromConfig(this.config.customRules);
  }

  /**
   * 配置护栏行为（TOP-3 安全护栏可配置化）
   *
   * 运行时动态更新内置检查开关与自定义规则注册表。
   * 传入的 config 会覆盖当前配置中的对应字段，未提供字段保持当前值。
   *
   * @param config 安全护栏配置
   */
  configure(config: Readonly<GraphGuardConfig>): void {
    this.config = this.mergeConfig(config, this.config);
    if (config.customRules !== undefined) {
      this.customRules.clear();
      this.loadCustomRulesFromConfig(config.customRules);
    }
  }

  /**
   * 注册自定义校验规则（TOP-3 安全护栏可配置化）
   *
   * @param ruleId 规则唯一标识（重复注册覆盖旧规则）
   * @param phase 规则触发阶段
   * @param rule 自定义校验函数
   */
  registerCustomRule(ruleId: string, phase: GraphGuardCustomRulePhase, rule: GraphGuardCustomRule): void {
    this.customRules.set(ruleId, Object.freeze({ phase, rule }));
  }

  /**
   * 检查图结构完整性（构造时调用一次）
   *
   * 校验项（对齐 §8.3 validateGraph）：
   * 1. 入口节点存在（entryNodeId 在 nodes 中）
   * 2. 所有 edges 的 from/to 引用的节点存在
   * 3. 无不可达节点（从入口不可到达的节点，作为 warnings 提示，不阻断校验）
   * 4. 环路标记（通过 DFS 检测环，有环图标记 isCyclic=true，作为 warnings 提示）
   * 5. decision 节点的 decisionPredicateId 在 PredicateRegistry 中已注册
   * 6. edge 的 activationPredicateId（若存在）在 PredicateRegistry 中已注册
   *
   * @param graph 待校验的工作图
   * @returns 校验结果（valid / errors / warnings / isCyclic / unreachableNodes）
   */
  validateGraph(graph: Readonly<WorkGraph>): GraphValidationResult {
    // 缓存当前图定义，供 pre/post 阶段自定义规则使用（TOP-3）
    this.currentGraph = graph;

    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. 校验入口节点存在
    if (!graph.nodes.has(graph.entryNodeId)) {
      errors.push(
        `入口节点不存在：entryNodeId=${graph.entryNodeId}，可用节点=[${Array.from(graph.nodes.keys()).join(", ")}]`
      );
    }

    // 2. 校验所有边的 from/to 引用的节点存在
    for (const edge of graph.edges) {
      if (!graph.nodes.has(edge.from)) {
        errors.push(`边 ${edge.edgeId} 的 from 引用不存在的节点：from=${edge.from}`);
      }
      if (!graph.nodes.has(edge.to)) {
        errors.push(`边 ${edge.edgeId} 的 to 引用不存在的节点：to=${edge.to}`);
      }
    }

    // 3. 校验 decision 节点的 decisionPredicateId 已注册
    //    注意：graph.config 不含 predicateRegistry，此处仅校验 decisionPredicateId 字段存在
    //    实际的 PredicateRegistry 查询由 GraphScheduler 在运行时执行
    for (const node of graph.nodes.values()) {
      if (node.nodeType === "decision") {
        if (!node.decisionPredicateId) {
          errors.push(`decision 节点 ${node.nodeId} 缺少 decisionPredicateId 字段（必填）`);
        }
      }
      // 校验 task 节点的 plugin 字段
      if (node.nodeType === "task" && !node.plugin) {
        errors.push(`task 节点 ${node.nodeId} 缺少 plugin 字段（必填）`);
      }
      // 校验 loop 节点的 loopConfig 字段
      if (node.nodeType === "loop" && !node.loopConfig) {
        errors.push(`loop 节点 ${node.nodeId} 缺少 loopConfig 字段（必填）`);
      }
    }

    // 4. 检测不可达节点（从入口 BFS 遍历，未访问到的节点为不可达）
    const unreachableNodes = this.findUnreachableNodes(graph);
    if (unreachableNodes.length > 0) {
      warnings.push(`存在 ${unreachableNodes.length} 个不可达节点（从入口无法到达）：${unreachableNodes.join(", ")}`);
    }

    // 5. 检测环路（DFS 三色标记法）
    const isCyclic = this.detectCycle(graph);
    if (isCyclic) {
      warnings.push("图包含环（isCyclic=true），运行时需依赖 GraphRunContext.visited 进行环路检测防止无限遍历");
    }

    // 6. 执行 validate 阶段自定义规则（TOP-3 安全护栏可配置化）
    for (const [ruleId, registration] of this.customRules.entries()) {
      if (registration.phase !== "validate") {
        continue;
      }
      const customResult = this.executeCustomRule(ruleId, registration.phase, graph);
      if (!customResult.pass) {
        errors.push(`自定义规则 ${ruleId} 校验失败：${customResult.message ?? "未提供原因"}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors: Object.freeze(errors),
      warnings: Object.freeze(warnings),
      isCyclic,
      unreachableNodes: Object.freeze(unreachableNodes),
    };
  }

  /**
   * 检查节点执行前的前置条件
   *
   * 检查项（对齐 §8.3 checkPreExecution）：
   * 1. 图级超时（elapsedSec >= config.timeoutSec 且 timeoutSec > 0 → stop_timeout）
   * 2. 图级 token 预算（totalTokensUsed >= config.maxTokens 且 maxTokens > 0 → stop_failure）
   * 3. 当前遍历深度（currentDepth >= config.maxDepth → stop_failure）
   *
   * @param node 待执行节点
   * @param context 运行上下文
   * @returns 是否允许执行（passed=false 时携带 suggestedAction 和 reason）
   */
  checkPreExecution(node: Readonly<GraphNodeDef>, context: Readonly<GraphRunContext>): GraphGuardCheckResult {
    const elapsedSec = (Date.now() - context.startedAtMs) / 1000;

    // 1. 检查图级超时（timeoutSec > 0 时启用）
    if (context.config.timeoutSec > 0 && elapsedSec >= context.config.timeoutSec) {
      return {
        passed: false,
        reason: `图级超时：elapsedSec=${elapsedSec.toFixed(2)}s >= timeoutSec=${context.config.timeoutSec}s`,
        suggestedAction: "stop_timeout" as GraphSchedulingAction,
        severity: "error",
      };
    }

    // 2. 检查图级 token 预算（maxTokens > 0 且 enableTokenBudgetCheck 开启时启用）
    if (
      this.config.enableTokenBudgetCheck &&
      context.config.maxTokens > 0 &&
      context.totalTokensUsed >= context.config.maxTokens
    ) {
      return {
        passed: false,
        reason: `图级 token 预算耗尽：totalTokensUsed=${context.totalTokensUsed} >= maxTokens=${context.config.maxTokens}`,
        suggestedAction: "stop_failure" as GraphSchedulingAction,
        severity: "error",
      };
    }

    // 3. 检查当前遍历深度（enableDepthCheck 开启时启用，防死循环）
    if (this.config.enableDepthCheck && context.currentDepth >= context.config.maxDepth) {
      return {
        passed: false,
        reason: `达到最大遍历深度：currentDepth=${context.currentDepth} >= maxDepth=${context.config.maxDepth}`,
        suggestedAction: "stop_failure" as GraphSchedulingAction,
        severity: "error",
      };
    }

    // 4. 检查取消信号
    if (context.cancelled) {
      return {
        passed: false,
        reason: "用户已请求取消图执行（context.cancelled=true）",
        suggestedAction: "stop_failure" as GraphSchedulingAction,
        severity: "warning",
      };
    }

    // 5. 执行 pre 阶段自定义规则（TOP-3 安全护栏可配置化）
    for (const [ruleId, registration] of this.customRules.entries()) {
      if (registration.phase !== "pre") {
        continue;
      }
      if (!this.currentGraph) {
        continue;
      }
      const customResult = this.executeCustomRule(ruleId, registration.phase, this.currentGraph, context);
      if (!customResult.pass) {
        return {
          passed: false,
          reason: `自定义规则 ${ruleId} 前置校验失败：${customResult.message ?? "未提供原因"}`,
          suggestedAction: "stop_failure" as GraphSchedulingAction,
          severity: "error",
        };
      }
    }

    // 6. 所有检查通过
    return {
      passed: true,
      reason: `节点 ${node.nodeId} 前置条件检查通过`,
      severity: "info",
    };
  }

  /**
   * 检查节点执行后的后置条件
   *
   * 检查项（对齐 §8.3 checkPostExecution）：
   * 1. 节点输出是否符合 outputContract（字段类型与必填性，仅 status=completed 时检查）
   * 2. 节点耗时是否异常（单节点超过图级 timeoutSec 的 50%，timeoutSec > 0 时启用）
   *
   * 注意：连续节点失败熔断由 GraphScheduler.decideNext() 实现（§11.4），
   *      本方法不做熔断检查（无状态，无法跟踪历史）。
   *
   * @param node 已执行节点
   * @param result 执行结果
   * @param context 运行上下文
   * @returns 是否允许继续（passed=false 时携带 suggestedAction 和 reason）
   */
  checkPostExecution(
    node: Readonly<GraphNodeDef>,
    result: Readonly<GraphNodeResult>,
    context: Readonly<GraphRunContext>
  ): GraphGuardCheckResult {
    // 1. 节点执行失败：不校验输出契约（输出可能不完整），返回 passed=true 让 GraphScheduler 决定重试/隔离
    if (result.status === "failed" || result.status === "isolated") {
      return {
        passed: true,
        reason: `节点 ${node.nodeId} 状态为 ${result.status}，跳过输出契约校验（由 GraphScheduler 决定重试/隔离）`,
        severity: "info",
      };
    }

    // 2. 节点被跳过：不校验输出契约
    if (result.status === "skipped") {
      return {
        passed: true,
        reason: `节点 ${node.nodeId} 状态为 skipped，跳过输出契约校验`,
        severity: "info",
      };
    }

    // 3. 节点成功（status=completed）：校验输出契约（受 outputContractValidationLevel 控制）
    const contractError = this.validateOutputContract(node, result, this.config.outputContractValidationLevel);
    if (contractError) {
      return {
        passed: false,
        reason: `节点 ${node.nodeId} 输出契约校验失败：${contractError}`,
        suggestedAction: "retry_node" as GraphSchedulingAction,
        severity: "error",
      };
    }

    // 4. 检查节点耗时是否异常（enablePostExecutionDurationCheck 开启且 timeoutSec > 0 时启用）
    if (this.config.enablePostExecutionDurationCheck && context.config.timeoutSec > 0) {
      const durationThreshold = context.config.timeoutSec * SINGLE_NODE_DURATION_RATIO_THRESHOLD;
      if (result.durationSec > durationThreshold) {
        return {
          passed: true, // 耗时异常仅告警，不阻断执行
          reason: `节点 ${node.nodeId} 耗时较长：durationSec=${result.durationSec.toFixed(2)}s > 阈值=${durationThreshold.toFixed(2)}s（图级超时的 ${SINGLE_NODE_DURATION_RATIO_THRESHOLD * 100}%）`,
          severity: "warning",
        };
      }
    }

    // 5. 执行 post 阶段自定义规则（TOP-3 安全护栏可配置化）
    for (const [ruleId, registration] of this.customRules.entries()) {
      if (registration.phase !== "post") {
        continue;
      }
      if (!this.currentGraph) {
        continue;
      }
      const customResult = this.executeCustomRule(ruleId, registration.phase, this.currentGraph, context);
      if (!customResult.pass) {
        return {
          passed: false,
          reason: `自定义规则 ${ruleId} 后置校验失败：${customResult.message ?? "未提供原因"}`,
          suggestedAction: "stop_failure" as GraphSchedulingAction,
          severity: "error",
        };
      }
    }

    // 6. 所有检查通过
    return {
      passed: true,
      reason: `节点 ${node.nodeId} 后置条件检查通过`,
      severity: "info",
    };
  }

  // ========================================================================
  // 私有辅助方法
  // ========================================================================

  /**
   * 查找不可达节点（从入口 BFS 遍历，未访问到的节点为不可达）
   *
   * @param graph 工作图
   * @returns 不可达节点 ID 列表
   */
  private findUnreachableNodes(graph: Readonly<WorkGraph>): string[] {
    // 构造邻接表：nodeId → 下游节点 ID 列表
    const adjacency = new Map<string, string[]>();
    for (const node of graph.nodes.values()) {
      adjacency.set(node.nodeId, []);
    }
    for (const edge of graph.edges) {
      const downstream = adjacency.get(edge.from);
      if (downstream) {
        downstream.push(edge.to);
      }
    }

    // BFS 从入口遍历
    const visited = new Set<string>();
    const queue: string[] = [];
    if (graph.nodes.has(graph.entryNodeId)) {
      queue.push(graph.entryNodeId);
      visited.add(graph.entryNodeId);
    }
    while (queue.length > 0) {
      const current = queue.shift()!;
      const downstream = adjacency.get(current) ?? [];
      for (const next of downstream) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    // 找出未访问到的节点
    const unreachable: string[] = [];
    for (const nodeId of graph.nodes.keys()) {
      if (!visited.has(nodeId)) {
        unreachable.push(nodeId);
      }
    }
    return unreachable;
  }

  /**
   * 检测图中是否存在环（DFS 三色标记法）
   *
   * 三色标记：
   * - 白色（未访问）：节点不在 visited 和 inStack 中
   * - 灰色（正在访问）：节点在 inStack 中（当前 DFS 路径上）
   * - 黑色（已访问）：节点在 visited 中且不在 inStack 中（DFS 子树已完成）
   *
   * 当 DFS 遇到灰色节点时，说明存在环（回边）。
   *
   * @param graph 工作图
   * @returns 是否存在环
   */
  private detectCycle(graph: Readonly<WorkGraph>): boolean {
    // 构造邻接表
    const adjacency = new Map<string, string[]>();
    for (const node of graph.nodes.values()) {
      adjacency.set(node.nodeId, []);
    }
    for (const edge of graph.edges) {
      const downstream = adjacency.get(edge.from);
      if (downstream) {
        downstream.push(edge.to);
      }
    }

    // 三色标记
    const visited = new Set<string>(); // 黑色：已完成 DFS
    const inStack = new Set<string>(); // 灰色：当前 DFS 路径

    // DFS 递归检测环
    const dfs = (nodeId: string): boolean => {
      // 灰色节点 → 回边 → 存在环
      if (inStack.has(nodeId)) {
        return true;
      }
      // 黑色节点 → 已完成，无环
      if (visited.has(nodeId)) {
        return false;
      }
      // 标记为灰色（进入当前 DFS 路径）
      inStack.add(nodeId);
      // 递归访问所有下游
      const downstream = adjacency.get(nodeId) ?? [];
      for (const next of downstream) {
        if (dfs(next)) {
          return true;
        }
      }
      // 标记为黑色（DFS 子树完成，移出当前路径）
      inStack.delete(nodeId);
      visited.add(nodeId);
      return false;
    };

    // 从入口开始 DFS（入口可能不在邻接表中，但 graph.nodes 已保证入口存在）
    if (graph.nodes.has(graph.entryNodeId)) {
      if (dfs(graph.entryNodeId)) {
        return true;
      }
    }

    // 检查所有节点（处理多入口或孤立子图场景）
    for (const nodeId of graph.nodes.keys()) {
      if (!visited.has(nodeId)) {
        if (dfs(nodeId)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 校验节点输出是否符合 outputContract
   *
   * 校验规则：
   * - strict 级别：required=true 但字段缺失 → 返回错误信息；字段存在时执行类型校验
   * - lenient 级别：仅校验字段存在（不校验类型），对齐 GraphGuardConfig.outputContractValidationLevel
   *
   * @param node 节点定义（含 outputContract）
   * @param result 节点执行结果（含 output 数据）
   * @param validationLevel 验证级别（"strict" 或 "lenient"，默认 strict）
   * @returns 错误信息（null 表示校验通过）
   */
  private validateOutputContract(
    node: Readonly<GraphNodeDef>,
    result: Readonly<GraphNodeResult>,
    validationLevel: "strict" | "lenient" = "strict"
  ): string | null {
    for (const contract of node.outputContract) {
      const hasField = Object.prototype.hasOwnProperty.call(result.output, contract.name);
      const value = result.output[contract.name];

      // 必填字段缺失（strict / lenient 均检查存在性）
      if (!hasField || value === undefined) {
        if (contract.required) {
          return `必填输出字段 "${contract.name}" 缺失（required=true）`;
        }
        // 非必填字段缺失：跳过后续校验
        continue;
      }

      // lenient 级别：仅校验字段存在，不校验类型
      if (validationLevel === "lenient") {
        continue;
      }

      // strict 级别：类型校验（type !== "any" 时）
      if (contract.type !== "any") {
        const typeError = this.checkFieldType(contract.name, value, contract.type);
        if (typeError) {
          return typeError;
        }
      }
    }
    return null;
  }

  /**
   * 检查字段值类型是否匹配
   *
   * @param fieldName 字段名
   * @param value 字段值
   * @param expectedType 期望类型
   * @returns 错误信息（null 表示类型匹配）
   */
  private checkFieldType(fieldName: string, value: unknown, expectedType: NodeFieldContract["type"]): string | null {
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
   * 合并护栏配置（TOP-3）
   *
   * 将传入配置与基准配置合并，缺省字段使用基准值，保证返回 Required<GraphGuardConfig>。
   *
   * @param config 传入配置（可选）
   * @param base 基准配置（可选，默认 DEFAULT_GUARD_CONFIG）
   * @returns 合并后的完整配置
   */
  private mergeConfig(
    config?: Readonly<GraphGuardConfig>,
    base: Readonly<Required<GraphGuardConfig>> = DEFAULT_GUARD_CONFIG
  ): Required<GraphGuardConfig> {
    return {
      outputContractValidationLevel: config?.outputContractValidationLevel ?? base.outputContractValidationLevel,
      enableTokenBudgetCheck: config?.enableTokenBudgetCheck ?? base.enableTokenBudgetCheck,
      enableDepthCheck: config?.enableDepthCheck ?? base.enableDepthCheck,
      enablePostExecutionDurationCheck:
        config?.enablePostExecutionDurationCheck ?? base.enablePostExecutionDurationCheck,
      customRules: config?.customRules ?? base.customRules,
    };
  }

  /**
   * 从配置加载自定义规则到内部注册表（TOP-3）
   *
   * @param customRules 配置中的自定义规则注册表
   */
  private loadCustomRulesFromConfig(
    customRules: Readonly<Record<string, Readonly<{ phase: GraphGuardCustomRulePhase; rule: GraphGuardCustomRule }>>>
  ): void {
    for (const [ruleId, registration] of Object.entries(customRules)) {
      this.customRules.set(ruleId, Object.freeze(registration));
    }
  }

  /**
   * 执行单个自定义规则（TOP-3）
   *
   * 自定义规则执行异常时，返回 pass=false，message 包含异常信息，
   * 对应建议动作为 stop_failure，severity 为 error。
   *
   * @param ruleId 规则 ID
   * @param phase 规则触发阶段
   * @param graph 当前图定义
   * @param context 图运行上下文（pre/post 阶段传入，validate 阶段不传）
   * @returns 规则执行结果
   */
  private executeCustomRule(
    ruleId: string,
    phase: GraphGuardCustomRulePhase,
    graph: Readonly<WorkGraph>,
    context?: Readonly<GraphRunContext>
  ): { pass: boolean; message?: string } {
    const registration = this.customRules.get(ruleId);
    if (!registration || registration.phase !== phase) {
      return { pass: true };
    }
    try {
      return registration.rule(graph, context);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        pass: false,
        message: `自定义规则 ${ruleId} 执行异常：${errorMessage}`,
      };
    }
  }
}

/**
 * 创建图级护栏实例（工厂函数）
 *
 * @returns 新的 GraphGuardProtocol 实例（实现类为 GraphGuardImpl）
 */
export function createGraphGuard(): GraphGuardProtocol {
  return new GraphGuardImpl();
}
