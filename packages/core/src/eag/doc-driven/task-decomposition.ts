/**
 * 任务分解 DAG 实现（EAG-P1 批次 5）
 *
 * 本模块实现 `TaskDecomposer` 类，提供 EAG 方案 §5.10.2 任务分解规范的真实逻辑。
 *
 * 核心职责：
 * - decompose：将功能需求分解为任务 DAG（按 5 阶段切分：骨架→领域→服务→API→前端）
 * - topologicalSort：拓扑排序（Kahn 算法）
 * - detectParallelizable：检测可并行任务组（按拓扑层级分组）
 * - validateDag：校验 DAG 合法性（无循环依赖、无悬挂依赖、ID 唯一）
 *
 * §5.10.2 任务分解规范：
 * - 粒度：单任务 ≤ 1 个文件簇（聚合/模块），任务卡含 [REQ-F-xxx] 需求溯源标记
 * - 依赖 DAG：任务间声明依赖（骨架 → 领域实现 → 应用服务 → API → 前端）
 *   Loop 按拓扑序执行，无依赖任务可扇出并行
 * - 验收卡：每任务带可执行验收标准（测试命令/断言），完成判定由评估器执行
 *
 * 设计依据：
 * - EAG 方案 §5.10.2 任务分解规范
 * - Kahn 算法（拓扑排序经典算法）
 *
 * 不可变优先：
 * - decompose 返回冻结的 TaskDag
 * - 中间数据结构使用 readonly 修饰
 *
 * @module eag/doc-driven/task-decomposition
 */

import type { FunctionalRequirement, TaskDag, TaskNode } from "./types";

// ============================================================================
// 任务阶段定义（对齐 §5.10.2 骨架 → 领域 → 服务 → API → 前端）
// ============================================================================

/**
 * 任务阶段（5 阶段，字面量联合类型）
 *
 * 对齐 EAG 方案 §5.10.2 任务分解 DAG 的依赖顺序：
 * - skeleton：骨架（创建文件簇基础结构）
 * - domain：领域实现（聚合/实体/值对象/领域事件）
 * - service：应用服务（用例编排 + 仓储调用）
 * - api：API（HTTP 路由 + 请求/响应 DTO）
 * - frontend：前端（页面 + 组件）
 *
 * 阶段间存在严格依赖：skeleton → domain → service → api → frontend
 * 同一阶段内不同需求/模块的任务可并行执行（detectParallelizable 检测）。
 *
 * 字面量联合而非 string，避免拼写错误。
 */
type TaskPhase = "skeleton" | "domain" | "service" | "api" | "frontend";

/**
 * 任务阶段定义（顺序与依赖关系）
 *
 * TASK_PHASES 数组顺序即阶段依赖顺序：skeleton(0) → domain(1) → service(2) → api(3) → frontend(4)。
 * 后阶段任务依赖前阶段任务（同需求内）。
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
const TASK_PHASES: ReadonlyArray<TaskPhase> = Object.freeze(["skeleton", "domain", "service", "api", "frontend"]);

/**
 * 任务阶段中文名映射（用于生成任务标题）
 *
 * 使用 Object.freeze 冻结。
 */
const TASK_PHASE_CHINESE: Readonly<Record<TaskPhase, string>> = Object.freeze({
  skeleton: "骨架",
  domain: "领域实现",
  service: "应用服务",
  api: "API 接口",
  frontend: "前端",
});

/**
 * 任务阶段对应验收命令片段（用于生成 acceptanceCommand）
 *
 * 使用 Object.freeze 冻结。验收命令格式：`npm test <module>-<phase>`
 */
const TASK_PHASE_TEST_SUFFIX: Readonly<Record<TaskPhase, string>> = Object.freeze({
  skeleton: "skeleton",
  domain: "domain",
  service: "service",
  api: "api",
  frontend: "frontend",
});

// ============================================================================
// 异常类型
// ============================================================================

/**
 * 任务分解错误（DAG 校验失败时抛出）
 *
 * 包含错误类型与详细信息，便于调用方区分处理。
 */
export class TaskDecompositionError extends Error {
  /**
   * @param kind 错误类型（cycle=循环依赖，dangling=悬挂依赖，duplicate-id=ID 重复）
   * @param detail 错误详情
   */
  constructor(
    public readonly kind: "cycle" | "dangling" | "duplicate-id" | "empty-requirements",
    public readonly detail: string
  ) {
    super(`任务分解错误 [${kind}]：${detail}`);
    this.name = "TaskDecompositionError";
  }
}

// ============================================================================
// DAG 校验结果类型
// ============================================================================

/**
 * DAG 校验结果（validateDag 产出）
 *
 * 用于在不抛异常的场景下查询 DAG 合法性。
 *
 * 范例：
 *   {
 *     valid: false,
 *     cycles: [["T-002", "T-003", "T-002"]],
 *     danglingDependencies: ["T-999"],
 *     duplicateIds: []
 *   }
 */
export interface DagValidationResult {
  /** 是否合法（true=无循环/悬挂/重复，false=存在问题） */
  readonly valid: boolean;
  /** 循环依赖路径列表（每条为 ID 序列，如 [["T-002", "T-003", "T-002"]]） */
  readonly cycles: ReadonlyArray<ReadonlyArray<string>>;
  /** 悬挂依赖列表（依赖了不存在的任务 ID） */
  readonly danglingDependencies: ReadonlyArray<string>;
  /** 重复的 ID 列表 */
  readonly duplicateIds: ReadonlyArray<string>;
}

// ============================================================================
// TaskDecomposer 类
// ============================================================================

/**
 * 任务分解器（实现 §5.10.2 任务分解规范）
 *
 * 提供真实分解逻辑（禁止 mock）：
 * - decompose：将 FunctionalRequirement[] 分解为 TaskDag
 *   每条需求生成 5 个阶段任务（skeleton/domain/service/api/frontend），
 *   阶段内任务无依赖（可并行），阶段间任务有依赖（同需求链）。
 * - topologicalSort：Kahn 算法拓扑排序
 * - detectParallelizable：按拓扑层级分组，同层任务可并行
 * - validateDag：校验 DAG 合法性（循环/悬挂/重复）
 *
 * 使用方式：
 * ```typescript
 * const decomposer = new TaskDecomposer();
 * const requirements = [
 *   { id: "F-001", title: "用户登录", priority: "high", module: "UserAggregate",
 *     acceptanceCriteria: ["..."] },
 *   { id: "F-002", title: "订单创建", priority: "high", module: "OrderAggregate",
 *     acceptanceCriteria: ["..."] },
 * ];
 * const dag = decomposer.decompose(requirements);
 * // dag.nodes 包含 10 个任务（2 需求 × 5 阶段）
 * // dag.topologicalOrder 是合法拓扑序
 * ```
 */
export class TaskDecomposer {
  /**
   * 任务 ID 计数器（实例级，确保多次调用 decompose 不冲突）
   *
   * 每次 decompose 重置为 0，按 T-001/T-002/... 递增分配。
   */
  private taskIdCounter: number = 0;

  /**
   * 将功能需求列表分解为任务 DAG
   *
   * 分解规则（§5.10.2）：
   * 1. 每条 FunctionalRequirement 生成 5 个阶段任务（按 TASK_PHASES 顺序）
   * 2. 同需求内的阶段任务按顺序依赖（skeleton → domain → service → api → frontend）
   * 3. 跨需求的同阶段任务无依赖（可并行扇出）
   * 4. fileCluster = requirement.module（单任务 ≤ 1 文件簇约束）
   * 5. acceptanceCommand = `npm test <module>-<phase>`（评估器执行此命令判定完成）
   *
   * 不变性保证：
   * - 任务 ID 唯一（T-001/T-002/... 递增）
   * - 无循环依赖（阶段间严格单向）
   * - 无悬挂依赖（同需求内引用的阶段 ID 必存在）
   * - topologicalOrder 为合法拓扑序
   *
   * @param requirements 功能需求列表
   * @returns 冻结的 TaskDag
   * @throws {TaskDecompositionError} requirements 为空时抛出 empty-requirements
   */
  decompose(requirements: ReadonlyArray<FunctionalRequirement>): TaskDag {
    // 校验入参：requirements 不能为空
    if (requirements.length === 0) {
      throw new TaskDecompositionError("empty-requirements", "功能需求列表不能为空——任务分解至少需要 1 条需求");
    }

    // 重置任务 ID 计数器
    this.taskIdCounter = 0;

    // 收集所有任务节点（按需求 × 阶段生成）
    const nodes: TaskNode[] = [];
    // 记录每个需求各阶段的任务 ID，便于后续建立依赖关系
    // 外层 Map key = requirement.id, 内层 Map key = phase, value = taskId
    const phaseTaskIdsByRequirement = new Map<string, Map<TaskPhase, string>>();

    for (const req of requirements) {
      const phaseTaskIds = new Map<TaskPhase, string>();
      for (const phase of TASK_PHASES) {
        const taskId = this.allocateTaskId();
        const node: TaskNode = {
          id: taskId,
          title: `${req.title} - ${TASK_PHASE_CHINESE[phase]}`,
          requirementId: req.id,
          dependencies: [], // 依赖在第二遍填充
          fileCluster: req.module,
          acceptanceCommand: `npm test ${req.module.toLowerCase()}-${TASK_PHASE_TEST_SUFFIX[phase]}`,
        };
        nodes.push(node);
        phaseTaskIds.set(phase, taskId);
      }
      phaseTaskIdsByRequirement.set(req.id, phaseTaskIds);
    }

    // 第二遍：填充阶段间依赖（同需求内 skeleton → domain → service → api → frontend）
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const phaseTaskIds = phaseTaskIdsByRequirement.get(node.requirementId);
      if (!phaseTaskIds) {
        // 理论不应发生（每个节点的 requirementId 都在 map 中）
        continue;
      }
      // 查找当前节点所属阶段
      const currentPhase = this.findPhaseByTaskId(phaseTaskIds, node.id);
      if (!currentPhase) {
        continue;
      }
      // 当前阶段的上一阶段（依赖来源）
      const prevPhase = this.getPreviousPhase(currentPhase);
      if (prevPhase) {
        const prevTaskId = phaseTaskIds.get(prevPhase);
        if (prevTaskId) {
          // 创建新对象（不可变优先：不修改原节点）
          nodes[i] = {
            ...node,
            dependencies: Object.freeze([prevTaskId]),
          };
        }
      }
    }

    // 校验 DAG 合法性（防止生成异常 DAG）
    const validationResult = this.validateDag(nodes);
    if (!validationResult.valid) {
      // 理论不应发生（分解逻辑保证合法），但作为防御性编程
      throw new TaskDecompositionError("cycle", `任务分解生成非法 DAG：${JSON.stringify(validationResult)}`);
    }

    // 拓扑排序
    const topologicalOrder = this.topologicalSort(nodes);

    // 冻结每个节点并构建 TaskDag
    const frozenNodes = Object.freeze(nodes.map((n) => Object.freeze({ ...n })));
    return Object.freeze({
      nodes: frozenNodes,
      topologicalOrder: Object.freeze([...topologicalOrder]),
    });
  }

  /**
   * 拓扑排序（Kahn 算法）
   *
   * 算法步骤：
   * 1. 计算每个节点的入度（节点 dependencies 中存在于 nodes 的依赖数量）
   * 2. 入度为 0 的节点入队
   * 3. 出队一个节点加入结果，将其所有后继节点入度 -1，入度变为 0 则入队
   * 4. 重复直到队列为空
   *
   * 若结果长度 < 节点总数，说明存在循环依赖（DAG 不合法）。
   *
   * 同层节点（同时入度为 0）按节点 ID 字典序排序，保证结果稳定可重放。
   *
   * 依赖图说明：
   * - 边 B → A 表示 "A 依赖 B"（B 必须先执行）
   * - inDegree[A] = A.dependencies.length（A 的入度 = A 依赖的节点数）
   * - successors[B] = 依赖 B 的节点列表（B 的后继）
   *
   * @param nodes 任务节点列表
   * @returns 拓扑序任务 ID 列表
   */
  topologicalSort(nodes: ReadonlyArray<TaskNode>): string[] {
    // 构建节点 ID → 节点映射
    const nodeById = new Map<string, TaskNode>();
    for (const node of nodes) {
      nodeById.set(node.id, node);
    }

    // 计算每个节点的入度（节点 dependencies 中存在于 nodes 的依赖数量）
    // 入度 = 该节点依赖了多少个其他节点（依赖图中的入边数）
    const inDegree = new Map<string, number>();
    for (const node of nodes) {
      const validDeps = node.dependencies.filter((d) => nodeById.has(d));
      inDegree.set(node.id, validDeps.length);
    }

    // 构建后继节点映射：successors[depId] = 依赖了 depId 的节点 ID 列表
    // 即 depId 的出边所指向的节点（这些节点依赖 depId，depId 完成后才能执行）
    const successors = new Map<string, string[]>();
    for (const node of nodes) {
      successors.set(node.id, []);
    }
    for (const node of nodes) {
      for (const dep of node.dependencies) {
        if (successors.has(dep)) {
          successors.get(dep)!.push(node.id);
        }
      }
    }

    // 入度为 0 的节点入队（按 ID 字典序排序保证稳定）
    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) {
        queue.push(id);
      }
    }
    queue.sort();

    // Kahn 算法主循环
    const result: string[] = [];
    while (queue.length > 0) {
      // 出队一个入度为 0 的节点（字典序最小的）
      const current = queue.shift()!;
      result.push(current);
      // 遍历后继节点，入度 -1（current 完成后，依赖它的节点减少一个未完成依赖）
      const succs = successors.get(current) ?? [];
      // 排序保证稳定
      const sortedSuccs = [...succs].sort();
      for (const succ of sortedSuccs) {
        const newDeg = (inDegree.get(succ) ?? 0) - 1;
        inDegree.set(succ, newDeg);
        if (newDeg === 0) {
          queue.push(succ);
        }
      }
      // 重新排序队列，保证按 ID 字典序处理
      queue.sort();
    }

    return result;
  }

  /**
   * 检测可并行任务组（按拓扑层级分组）
   *
   * 算法：按拓扑层级（Level）分组，同层任务无依赖关系，可并行执行。
   * - Level 0：无依赖任务
   * - Level N：所有依赖都在 Level 0..N-1 中
   *
   * 同层任务可并行扇出（对齐 §5.10.2 "无依赖任务可扇出并行"）。
   *
   * @param nodes 任务节点列表
   * @returns 可并行任务组列表（每组为一个层级的任务 ID 数组）
   */
  detectParallelizable(nodes: ReadonlyArray<TaskNode>): ReadonlyArray<ReadonlyArray<string>> {
    // 构建节点 ID → 节点映射
    const nodeById = new Map<string, TaskNode>();
    for (const node of nodes) {
      nodeById.set(node.id, node);
    }

    // 计算每个节点的层级（最长路径长度）
    // level(node) = 0 if dependencies 为空
    //             = max(level(dep)) + 1 for dep in dependencies
    const levels = new Map<string, number>();

    /**
     * 递归计算节点层级（带缓存避免重复计算）
     *
     * @param id 节点 ID
     * @param visiting 正在访问的节点 ID 集合（用于循环检测）
     * @returns 节点层级
     */
    const computeLevel = (id: string, visiting: Set<string>): number => {
      // 缓存命中
      const cached = levels.get(id);
      if (cached !== undefined) {
        return cached;
      }
      // 循环检测
      if (visiting.has(id)) {
        // 存在循环依赖，返回 0 避免 infinite loop（调用方应通过 validateDag 提前发现）
        return 0;
      }
      visiting.add(id);

      const node = nodeById.get(id);
      if (!node || node.dependencies.length === 0) {
        levels.set(id, 0);
        visiting.delete(id);
        return 0;
      }
      let maxDepLevel = 0;
      for (const dep of node.dependencies) {
        if (nodeById.has(dep)) {
          const depLevel = computeLevel(dep, visiting);
          if (depLevel + 1 > maxDepLevel) {
            maxDepLevel = depLevel + 1;
          }
        }
      }
      levels.set(id, maxDepLevel);
      visiting.delete(id);
      return maxDepLevel;
    };

    // 计算所有节点层级
    for (const node of nodes) {
      computeLevel(node.id, new Set());
    }

    // 按层级分组
    const groupsByLevel = new Map<number, string[]>();
    for (const [id, level] of levels.entries()) {
      if (!groupsByLevel.has(level)) {
        groupsByLevel.set(level, []);
      }
      groupsByLevel.get(level)!.push(id);
    }

    // 按层级排序（0, 1, 2, ...），同层内按 ID 字典序排序
    const sortedLevels = [...groupsByLevel.keys()].sort((a, b) => a - b);
    const result: string[][] = [];
    for (const level of sortedLevels) {
      const ids = groupsByLevel.get(level)!.sort();
      result.push(ids);
    }

    return Object.freeze(result.map((group) => Object.freeze(group)));
  }

  /**
   * 校验 DAG 合法性（无循环依赖、无悬挂依赖、ID 唯一）
   *
   * 校验项：
   * 1. **ID 唯一性**：所有 task.id 必须唯一
   * 2. **无悬挂依赖**：所有 dependencies 引用的 ID 必须存在于 nodes
   * 3. **无循环依赖**：DAG 必须为有向无环图（通过 Kahn 算法检测：
   *    若拓扑排序结果长度 < 节点总数，存在循环）
   *
   * @param nodes 任务节点列表
   * @returns 校验结果（valid=true 表示合法）
   */
  validateDag(nodes: ReadonlyArray<TaskNode>): DagValidationResult {
    // 1. ID 唯一性校验
    const idCount = new Map<string, number>();
    for (const node of nodes) {
      idCount.set(node.id, (idCount.get(node.id) ?? 0) + 1);
    }
    const duplicateIds = [...idCount.entries()].filter(([, count]) => count > 1).map(([id]) => id);

    // 2. 悬挂依赖校验
    const allIds = new Set(nodes.map((n) => n.id));
    const danglingSet = new Set<string>();
    for (const node of nodes) {
      for (const dep of node.dependencies) {
        if (!allIds.has(dep)) {
          danglingSet.add(dep);
        }
      }
    }
    const danglingDependencies = [...danglingSet];

    // 3. 循环依赖校验（基于 DFS 染色法）
    const cycles = this.detectCycles(nodes);

    // 综合判定
    const valid = duplicateIds.length === 0 && danglingDependencies.length === 0 && cycles.length === 0;

    return Object.freeze({
      valid,
      cycles: Object.freeze(cycles),
      danglingDependencies: Object.freeze(danglingDependencies),
      duplicateIds: Object.freeze(duplicateIds),
    });
  }

  // ============================ 私有辅助方法 ============================

  /**
   * 分配新的任务 ID（T-001/T-002/... 递增）
   *
   * @returns 新的任务 ID（如 "T-001"）
   */
  private allocateTaskId(): string {
    this.taskIdCounter += 1;
    // 三位数字补零（T-001/T-002/.../T-999，超出则继续递增 T-1000）
    return `T-${String(this.taskIdCounter).padStart(3, "0")}`;
  }

  /**
   * 根据任务 ID 反查所属阶段
   *
   * @param phaseTaskIds 阶段 → 任务 ID 映射
   * @param taskId 任务 ID
   * @returns 阶段（找不到返回 undefined）
   */
  private findPhaseByTaskId(phaseTaskIds: Map<TaskPhase, string>, taskId: string): TaskPhase | undefined {
    for (const [phase, id] of phaseTaskIds.entries()) {
      if (id === taskId) {
        return phase;
      }
    }
    return undefined;
  }

  /**
   * 获取指定阶段的上一阶段
   *
   * @param phase 当前阶段
   * @returns 上一阶段（若 current 为 skeleton 返回 undefined）
   */
  private getPreviousPhase(phase: TaskPhase): TaskPhase | undefined {
    const idx = TASK_PHASES.indexOf(phase);
    if (idx <= 0) {
      return undefined;
    }
    return TASK_PHASES[idx - 1];
  }

  /**
   * 检测 DAG 中的所有循环依赖（DFS 染色法）
   *
   * 算法：
   * - 白色（未访问）→ 灰色（正在访问，在当前递归栈中）→ 黑色（已完成）
   * - 遇到灰色节点表示发现循环，回溯收集循环路径
   *
   * @param nodes 任务节点列表
   * @returns 循环路径列表（每条为 ID 序列，首尾相同表示闭环）
   */
  private detectCycles(nodes: ReadonlyArray<TaskNode>): string[][] {
    const nodeById = new Map<string, TaskNode>();
    for (const node of nodes) {
      nodeById.set(node.id, node);
    }

    // 节点颜色：white=未访问，gray=正在访问，black=已完成
    const color = new Map<string, "white" | "gray" | "black">();
    for (const node of nodes) {
      color.set(node.id, "white");
    }

    const cycles: string[][] = [];

    /**
     * DFS 遍历（递归）
     *
     * @param id 当前节点 ID
     * @param path 当前递归路径
     */
    const dfs = (id: string, path: string[]): void => {
      const currentColor = color.get(id);
      if (currentColor === "black") {
        return;
      }
      if (currentColor === "gray") {
        // 发现循环：从 path 中找到当前节点首次出现的位置，截取循环部分
        const startIdx = path.indexOf(id);
        if (startIdx >= 0) {
          const cycle = path.slice(startIdx).concat([id]);
          cycles.push(cycle);
        }
        return;
      }

      // 白色节点：标记为灰色，继续 DFS
      color.set(id, "gray");
      path.push(id);

      const node = nodeById.get(id);
      if (node) {
        // 按 ID 字典序遍历依赖（保证结果稳定）
        const sortedDeps = [...node.dependencies].sort();
        for (const dep of sortedDeps) {
          if (nodeById.has(dep)) {
            dfs(dep, path);
          }
        }
      }

      // 完成：标记为黑色，从路径移除
      color.set(id, "black");
      path.pop();
    };

    // 遍历所有节点（按 ID 字典序保证稳定）
    const sortedIds = [...nodeById.keys()].sort();
    for (const id of sortedIds) {
      if (color.get(id) === "white") {
        dfs(id, []);
      }
    }

    return cycles;
  }
}
