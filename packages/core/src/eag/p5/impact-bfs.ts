/**
 * ImpactBFS —— 爆炸半径有界最优分数松弛 BFS（EAG-P5 Phase 5.1 TASK-P5-1.1-005）
 *
 * 本模块实现 `ImpactBFS` 类，提供基于 TypeScript 的爆炸半径 BFS 遍历能力，
 * 是 EAG-P5 符号级偏离检测（FR-3.4）与风险驱动用例生成（FR-3.4）的核心算法。
 *
 * 核心职责（对齐架构师审查 §7.3.1 + 任务分解 TASK-P5-1.1-005）：
 * 1. 有界最优分数松弛 BFS（纯 TS 实现，不依赖 SQL 递归 CTE）
 * 2. 边权重×深度衰减：weight × confidence × 0.6^depth（每层衰减 0.6）
 * 3. 硬上限保护：MAX_DEPTH=2 / MAX_NODES=500（防止图过大）
 * 4. 权重阈值剪枝：低于 0.01 的路径不再扩展（避免无意义遍历）
 * 5. recall ≥ 0.9（50 条已知调用链基准集验证，DOD-4 S2）
 * 6. P99 查询延迟 < 50ms（NFR-3）
 *
 * 与 SymbolGraphStore.getExplosionRadius 的关系：
 * - getExplosionRadius 使用 SQLite 递归 CTE 实现（SQL 层）
 * - ImpactBFS 使用纯 TS 实现（应用层），提供更灵活的选项（边类型过滤、自定义阈值等）
 * - 两者返回相同的 ImpactResult 类型，消费方可按需选择
 *
 * 算法（有界最优分数松弛 BFS）：
 * 1. 初始化：起始符号 depth=0, weight=1.0，加入优先队列（按权重降序）
 * 2. 出队：取出权重最大的节点
 * 3. 扩展：查询该节点的入边（谁调用了它），计算新权重
 *    - new_weight = current_weight × edge.confidence × 0.6（每层衰减 0.6）
 *    - 若 new_weight > 0.01 且 new_depth <= MAX_DEPTH：加入队列
 * 4. 终止：队列空 或 已访问节点数 >= MAX_NODES
 * 5. 返回：所有受影响符号及其最大权重和路径
 *
 * 不可变优先：
 * - 所有接口字段 readonly
 * - 数组 ReadonlyArray<T>
 * - 返回结果 Object.freeze
 *
 * @module eag/p5/impact-bfs
 */

import type { EdgeKind, EdgeRecord, ImpactPath, ImpactResult, SymbolGraphStore } from "./symbol-graph-store";

// ============================================================================
// 1. 常量定义（对齐架构师审查 §7.3.1）
// ============================================================================

/**
 * 默认最大 BFS 深度（对齐架构师审查 §7.3.1）
 *
 * 数值依据：
 * - 深度 2 覆盖大多数企业项目的"源符号 → 直接调用者 → 二级调用者"链路
 * - 深度过大会导致受影响符号过多（爆炸半径过大），失去精准定位价值
 * - 深度过小会遗漏间接依赖，导致回归漏测
 *
 * 使用 Object.freeze 冻结。
 */
const DEFAULT_MAX_DEPTH = 2 as const;

/**
 * 默认最大节点数（对齐架构师审查 §7.3.1）
 *
 * 数值依据：
 * - 500 个节点覆盖大多数企业项目的单次变更影响范围
 * - 过大会导致 BFS 遍历时间过长（NFR-3 要求 P99 < 50ms）
 * - 过小会截断重要的高权重节点
 */
const DEFAULT_MAX_NODES = 500 as const;

/**
 * 深度衰减系数（对齐架构师审查 §7.3.1）
 *
 * 每深一层，权重乘以 0.6。
 * 总权重公式：weight = (product of edge confidences) × 0.6^depth
 *
 * 数值依据：
 * - 0.6 是经验值，平衡"近邻高权重"与"远邻低权重"
 * - 0.6^2 = 0.36，二级依赖权重衰减到约 1/3，合理地降低远距离影响
 * - 0.6^3 = 0.216，三级依赖权重低于 0.25，可忽略
 */
const DEPTH_DECAY_FACTOR = 0.6 as const;

/**
 * 默认权重阈值（对齐架构师审查 §7.3.1）
 *
 * 低于此权重的路径不再扩展（剪枝），避免无意义遍历。
 * 数值依据：0.01 = 1%，低于 1% 的影响可忽略。
 */
const DEFAULT_MIN_WEIGHT = 0.01 as const;

// ============================================================================
// 2. 类型定义
// ============================================================================

/**
 * ImpactBFS 查询选项
 *
 * 所有字段可选，缺省时使用默认值。
 */
export interface ImpactBFSOptions {
  /** 最大 BFS 深度（默认 2，上限 10） */
  readonly maxDepth?: number;
  /** 最大节点数（默认 500，上限 5000） */
  readonly maxNodes?: number;
  /** 边类型过滤（不传则包含所有类型） */
  readonly edgeKinds?: ReadonlyArray<EdgeKind>;
  /** 权重阈值（低于此值的路径不扩展，默认 0.01） */
  readonly minWeight?: number;
  /** 遍历方向（"incoming"=反向找调用者，"outgoing"=正向找被调用者，默认 "incoming"） */
  readonly direction?: "incoming" | "outgoing";
}

/**
 * BFS 队列节点（内部中间状态）
 */
interface BFSNode {
  /** 当前符号 ID */
  readonly symbolId: string;
  /** BFS 深度（起始节点 = 0） */
  readonly depth: number;
  /** 累积权重（起始节点 = 1.0） */
  readonly weight: number;
  /** 路径（从起始节点到当前节点的符号 ID 序列） */
  readonly path: ReadonlyArray<string>;
  /** 来源边（起始节点为 null） */
  readonly fromEdge: EdgeRecord | null;
}

/**
 * BFS 结果节点（聚合后）
 */
interface BFSResultNode {
  /** 符号 ID */
  readonly symbolId: string;
  /** 最大深度（多条路径到达同一节点时取最大深度） */
  readonly maxDepth: number;
  /** 最大权重（多条路径到达同一节点时取最大权重） */
  readonly maxWeight: number;
  /** 影响路径详情 */
  readonly paths: ReadonlyArray<ImpactPath>;
}

// ============================================================================
// 3. ImpactBFS 类
// ============================================================================

/**
 * ImpactBFS —— 爆炸半径有界最优分数松弛 BFS
 *
 * 使用方式：
 * ```typescript
 * const bfs = new ImpactBFS();
 * const result = bfs.computeImpact(graphStore, ["src/services/UserService.ts:UserService"], {
 *   maxDepth: 2,
 *   maxNodes: 500,
 *   edgeKinds: ["CALLS", "INHERITS"],
 * });
 * console.log(`受影响符号数：${result.impactedSymbolIds.length}`);
 * console.log(`查询耗时：${result.durationMs}ms`);
 * ```
 *
 * 算法特点：
 * - 优先队列 BFS：按权重降序处理节点，确保高权重节点优先扩展
 * - 分数松弛：同一节点可能被多条路径到达，保留最大权重
 * - 有界剪枝：MAX_DEPTH + MAX_NODES + MIN_WEIGHT 三重剪枝
 * - 路径追踪：记录完整路径，便于调试与可视化
 *
 * 性能保证（NFR-3）：
 * - 1000 文件项目 P99 < 50ms
 * - 优化点：优先队列避免全量遍历、权重阈值剪枝、节点数硬上限
 */
export class ImpactBFS {
  /**
   * 计算爆炸半径（有界最优分数松弛 BFS）
   *
   * 执行流程：
   * 1. 参数校验与默认值填充
   * 2. 初始化优先队列（起始符号 depth=0, weight=1.0）
   * 3. 初始化结果映射（symbolId → BFSResultNode）
   * 4. BFS 主循环：
   *    a. 从优先队列取出权重最大的节点
   *    b. 若已达 MAX_NODES 或队列空，终止
   *    c. 查询该节点的入边（或出边，取决于 direction）
   *    d. 对每条边计算新权重 = current_weight × edge.confidence × 0.6
   *    e. 若新权重 > minWeight 且新深度 <= maxDepth，加入队列与结果
   * 5. 聚合结果，返回 ImpactResult
   *
   * @param graphStore 符号图谱存储（提供 getEdges 查询能力）
   * @param rootSymbolIds 起始符号 ID 列表
   * @param options 查询选项（可选）
   * @returns 爆炸半径查询结果（含受影响符号列表与路径详情）
   */
  computeImpact(
    graphStore: SymbolGraphStore,
    rootSymbolIds: ReadonlyArray<string>,
    options?: ImpactBFSOptions
  ): Readonly<ImpactResult> {
    const startTime = Date.now();

    // === 阶段 1：参数校验与默认值填充 ===
    if (rootSymbolIds.length === 0) {
      return this.buildEmptyResult(rootSymbolIds, startTime);
    }

    const maxDepth = this.clamp(options?.maxDepth ?? DEFAULT_MAX_DEPTH, 1, 10, "maxDepth");
    const maxNodes = this.clamp(options?.maxNodes ?? DEFAULT_MAX_NODES, 1, 5000, "maxNodes");
    const minWeight = options?.minWeight ?? DEFAULT_MIN_WEIGHT;
    const direction = options?.direction ?? "incoming";
    const edgeKindFilter = options?.edgeKinds;

    if (typeof minWeight !== "number" || minWeight < 0 || minWeight > 1) {
      throw new Error(`ImpactBFS: minWeight 必须在 0~1 之间，实际值：${minWeight}`);
    }

    // === 阶段 2：初始化优先队列与结果映射 ===
    // 优先队列：按权重降序排列（使用数组 + sort 模拟，maxNodes <= 5000 时性能足够）
    const queue: BFSNode[] = [];
    // 结果映射：symbolId → BFSResultNode（聚合最大深度、最大权重、路径列表）
    const resultMap = new Map<string, BFSResultNode>();
    // 已入队集合（避免重复入队）
    const enqueued = new Set<string>();

    // 将起始符号加入队列（depth=0, weight=1.0）
    for (const symbolId of rootSymbolIds) {
      if (enqueued.has(symbolId)) continue;
      enqueued.add(symbolId);

      const startNode: BFSNode = {
        symbolId,
        depth: 0,
        weight: 1.0,
        path: Object.freeze([symbolId]),
        fromEdge: null,
      };
      queue.push(startNode);

      // 起始节点也加入结果
      resultMap.set(symbolId, {
        symbolId,
        maxDepth: 0,
        maxWeight: 1.0,
        paths: Object.freeze([]),
      });
    }

    // === 阶段 3：BFS 主循环 ===
    while (queue.length > 0 && resultMap.size < maxNodes) {
      // 按权重降序排序队列（优先处理高权重节点）
      queue.sort((a, b) => b.weight - a.weight);

      // 出队权重最大的节点
      const current = queue.shift()!;
      const currentResult = resultMap.get(current.symbolId);
      if (!currentResult) {
        // 当前节点不在结果中（可能被剪枝了），跳过
        continue;
      }

      // 达到最大深度，不再扩展
      if (current.depth >= maxDepth) {
        continue;
      }

      // === 阶段 3a：查询当前节点的边 ===
      const edges = this.queryEdges(graphStore, current.symbolId, direction, edgeKindFilter);

      // === 阶段 3b：遍历边，计算新权重 ===
      for (const edge of edges) {
        // 确定下一跳符号 ID（取决于遍历方向）
        const nextSymbolId = direction === "incoming" ? edge.sourceSymbolId : edge.targetSymbolId;

        // 跳过自环（避免循环）
        if (nextSymbolId === current.symbolId) continue;

        // 计算新权重：current_weight × edge.confidence × DEPTH_DECAY_FACTOR
        const newWeight = current.weight * edge.confidence * DEPTH_DECAY_FACTOR;
        const newDepth = current.depth + 1;

        // 权重阈值剪枝：低于 minWeight 不扩展
        if (newWeight < minWeight) continue;

        // 深度限制：超过 maxDepth 不扩展
        if (newDepth > maxDepth) continue;

        // 构建新路径
        const newPath = Object.freeze([...current.path, nextSymbolId]);

        // 构建路径详情
        const impactPath: ImpactPath = Object.freeze({
          from: current.symbolId,
          to: nextSymbolId,
          edgeKind: edge.kind,
          confidence: edge.confidence,
          depth: newDepth,
          weight: newWeight,
        }) as ImpactPath;

        // 更新结果映射（分数松弛：保留最大权重）
        const existing = resultMap.get(nextSymbolId);
        if (!existing) {
          // 新节点
          resultMap.set(nextSymbolId, {
            symbolId: nextSymbolId,
            maxDepth: newDepth,
            maxWeight: newWeight,
            paths: Object.freeze([impactPath]),
          });
        } else {
          // 已存在节点：更新最大权重与路径
          const updatedPaths =
            newWeight > existing.maxWeight
              ? Object.freeze([impactPath, ...existing.paths])
              : Object.freeze([...existing.paths, impactPath]);
          resultMap.set(nextSymbolId, {
            symbolId: nextSymbolId,
            maxDepth: Math.max(existing.maxDepth, newDepth),
            maxWeight: Math.max(existing.maxWeight, newWeight),
            paths: updatedPaths,
          });
        }

        // 加入队列（避免重复入队：仅当新权重 > 已记录权重时入队）
        if (!enqueued.has(nextSymbolId) || newWeight > (resultMap.get(nextSymbolId)?.maxWeight ?? 0)) {
          // 注意：此处可能有重复入队，但优先队列 + 结果映射的分数松弛机制可正确处理
          // 避免过度去重导致复杂度上升
          if (!enqueued.has(nextSymbolId)) {
            enqueued.add(nextSymbolId);
          }
          queue.push({
            symbolId: nextSymbolId,
            depth: newDepth,
            weight: newWeight,
            path: newPath,
            fromEdge: edge,
          });
        }

        // 节点数硬上限检查
        if (resultMap.size >= maxNodes) {
          break;
        }
      }
    }

    // === 阶段 4：聚合结果 ===
    const durationMs = Date.now() - startTime;

    // 按权重降序排列结果节点
    const sortedResults = [...resultMap.values()].sort((a, b) => b.maxWeight - a.maxWeight);

    // 构建受影响符号 ID 列表（排除起始符号）
    const rootSet = new Set(rootSymbolIds);
    const impactedSymbolIds = sortedResults.filter((r) => !rootSet.has(r.symbolId)).map((r) => r.symbolId);

    // 构建路径详情列表（展开所有结果节点的路径）
    const allPaths: ImpactPath[] = [];
    for (const result of sortedResults) {
      for (const p of result.paths) {
        allPaths.push(p);
      }
    }

    return Object.freeze({
      sourceSymbolIds: Object.freeze([...rootSymbolIds]),
      impactedSymbolIds: Object.freeze(impactedSymbolIds),
      paths: Object.freeze(allPaths),
      durationMs,
    }) as ImpactResult;
  }

  // ============================ 私有辅助方法 ============================

  /**
   * 查询符号的边（按方向与类型过滤）
   *
   * @param graphStore 符号图谱存储
   * @param symbolId 符号 ID
   * @param direction 遍历方向（incoming=入边/反向，outgoing=出边/正向）
   * @param edgeKindFilter 边类型过滤（可选）
   * @returns 边列表
   */
  private queryEdges(
    graphStore: SymbolGraphStore,
    symbolId: string,
    direction: "incoming" | "outgoing",
    edgeKindFilter?: ReadonlyArray<EdgeKind>
  ): ReadonlyArray<EdgeRecord> {
    // 如果有边类型过滤，逐个类型查询并合并
    if (edgeKindFilter && edgeKindFilter.length > 0) {
      const allEdges: EdgeRecord[] = [];
      for (const kind of edgeKindFilter) {
        const edges = graphStore.getEdges(symbolId, direction, kind);
        allEdges.push(...edges);
      }
      return Object.freeze(allEdges);
    }

    // 无过滤：查询指定方向的全部边
    return graphStore.getEdges(symbolId, direction);
  }

  /**
   * 构建空结果（起始符号列表为空时返回）
   *
   * @param rootSymbolIds 起始符号 ID 列表
   * @param startTime 查询开始时间戳
   * @returns 空的 ImpactResult
   */
  private buildEmptyResult(rootSymbolIds: ReadonlyArray<string>, startTime: number): Readonly<ImpactResult> {
    return Object.freeze({
      sourceSymbolIds: Object.freeze([...rootSymbolIds]),
      impactedSymbolIds: Object.freeze([]),
      paths: Object.freeze([]),
      durationMs: Date.now() - startTime,
    }) as ImpactResult;
  }

  /**
   * 数值范围限制（clamp）
   *
   * 将输入值限制在 [min, max] 范围内，超出范围时抛出错误。
   *
   * @param value 输入值
   * @param min 最小值
   * @param max 最大值
   * @param fieldName 字段名（用于错误消息）
   * @returns 限制后的值
   * @throws {Error} 值超出范围时抛出
   */
  private clamp(value: number, min: number, max: number, fieldName: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`ImpactBFS: ${fieldName} 必须为有效数字，实际值：${value}`);
    }
    if (value < min || value > max) {
      throw new Error(`ImpactBFS: ${fieldName} 必须在 ${min}~${max} 之间，实际值：${value}`);
    }
    return value;
  }
}

// ============================================================================
// 4. 工具函数
// ============================================================================

/**
 * 计算指定深度的衰减权重
 *
 * 公式：weight = baseWeight × 0.6^depth
 *
 * @param baseWeight 基础权重（通常为 1.0）
 * @param depth BFS 深度
 * @returns 衰减后的权重
 */
export function computeDepthDecayedWeight(baseWeight: number, depth: number): number {
  if (depth < 0) {
    throw new Error(`computeDepthDecayedWeight: depth 必须为非负整数，实际值：${depth}`);
  }
  return baseWeight * Math.pow(DEPTH_DECAY_FACTOR, depth);
}

/**
 * 计算单条边的扩展权重
 *
 * 公式：newWeight = currentWeight × edgeConfidence × 0.6
 *
 * @param currentWeight 当前节点的累积权重
 * @param edgeConfidence 边的置信度（1.0 / 0.6 / 0.2）
 * @returns 扩展后的新权重
 */
export function computeEdgeWeight(currentWeight: number, edgeConfidence: number): number {
  return currentWeight * edgeConfidence * DEPTH_DECAY_FACTOR;
}
