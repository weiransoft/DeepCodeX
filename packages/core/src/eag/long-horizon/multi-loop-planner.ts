/**
 * 多 Loop 串联计划生成器（MultiLoopPlanner）—— EAG-P3 批次 10 §4.11
 *
 * 本模块实现 EAG 方案 §5.12.2 多 Loop 串联计划所需的真实逻辑，
 * 基于 spec.md + 用户意图生成多 Loop 串联 DAG，定义 Loop 间自动流转规则与失败回滚策略。
 *
 * 核心职责（对齐设计文档 §4.11.1）：
 * 1. 解析 spec.md 提取模块切分（按模块拆分 CODING Loop 节点）
 * 2. 按依赖关系建立 DAG（如支付依赖订单 → DAG 边）
 * 3. 添加 DESIGN Loop 前置节点（spec 批准 + 用户检查点）
 * 4. 添加 TESTING Loop 后置节点（G-7 通过）
 * 5. 装配 LoopTransition 规则（默认 DEFAULT_LOOP_TRANSITIONS）
 * 6. 提供 DAG 合法性校验（环检测 + 节点可达性）
 * 7. 提供下一可执行节点查询（拓扑序 + 依赖满足判定）
 *
 * 算法（对齐设计文档 §4.11.2）：
 * - 单模块场景：DESIGN → CODING → TESTING（线性 DAG）
 * - 多模块场景：DESIGN → CODING-模块1 / CODING-模块2（按依赖序）→ TESTING
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * @module eag/long-horizon/multi-loop-planner
 */

import type { LoopType } from "../loop/models";
import type {
  DagValidationResult,
  LogCallback,
  LoopTransition,
  MultiLoopNode,
  MultiLoopNodeStatus,
  MultiLoopPlan,
} from "./types";
import { DEFAULT_LOOP_TRANSITIONS } from "./types";

// ============================================================================
// 1. 常量定义
// ============================================================================

/**
 * 模块切分 spec.md 中的标题正则模式
 *
 * 支持 Markdown ATX 标题（# / ## / ###）+ "模块"关键字：
 * - "## 模块：订单管理" → 提取 "订单管理"
 * - "### 模块:支付" → 提取 "支付"
 * - "## 订单模块" → 提取 "订单模块"
 *
 * 注意：冒号支持中英文（：/:），关键字"模块"前后允许任意字符。
 */
const MODULE_HEADING_PATTERN = /^#{1,6}\s*[^#\n]*模块[^#\n]*[:：]\s*([^\n]+?)\s*$/;

/**
 * 模块依赖关系 spec.md 中的依赖声明正则模式
 *
 * 支持"依赖：<模块名>"声明：
 * - "依赖：订单管理" → 当前模块依赖"订单管理"
 * - "依赖:支付,库存" → 当前模块依赖"支付"和"库存"
 *
 * 注意：逗号支持中英文（,，），冒号支持中英文（：/:）。
 */
const MODULE_DEPENDENCY_PATTERN = /^依赖\s*[:：]\s*([^\n]+?)\s*$/;

/**
 * 默认日志空函数（避免 undefined 判空）
 */
function noopLog(_message: string, _level?: "info" | "warn" | "error"): void {
  // 默认无操作
}

// ============================================================================
// 2. 自定义错误类
// ============================================================================

/**
 * 多 Loop 计划生成器错误类型（字面量联合类型）
 *
 * - invalid-request：请求字段非法
 * - spec-parse-failed：spec.md 解析失败
 * - dag-invalid：DAG 校验失败（含环或不可达节点）
 * - node-not-found：nextNode 查询的节点 ID 不存在
 */
export type MultiLoopPlannerErrorKind = "invalid-request" | "spec-parse-failed" | "dag-invalid" | "node-not-found";

/**
 * 多 Loop 计划生成器错误基类
 */
export class MultiLoopPlannerError extends Error {
  /**
   * @param kind 错误类型
   * @param detail 错误详情
   */
  constructor(
    public readonly kind: MultiLoopPlannerErrorKind,
    public readonly detail: string
  ) {
    super(`MultiLoopPlanner 错误 [${kind}]：${detail}`);
    this.name = "MultiLoopPlannerError";
  }
}

// ============================================================================
// 3. 类型定义（plan 方法入参与中间产物）
// ============================================================================

/**
 * 多 Loop 计划生成请求
 *
 * 对应 §4.11 MultiLoopPlanRequest。
 */
export interface MultiLoopPlanRequest {
  /** run-id（与 RunState 一致） */
  readonly runId: string;
  /** 项目根目录（绝对路径或相对路径） */
  readonly projectRoot: string;
  /** spec.md 内容（用于模块切分） */
  readonly specContent: string;
  /** 是否自动流转（默认 false，对齐 §5.12.2 DESIGN→CODING 需用户检查点） */
  readonly autoTransition?: boolean;
  /** 失败是否回滚（默认 true，回滚到上一个 milestone tag） */
  readonly rollbackOnFailure?: boolean;
}

/**
 * 模块切分结果（spec.md 解析中间产物）
 *
 * 每个模块对应一个 CODING Loop 节点，含模块名与依赖列表。
 *
 * 字段全部 readonly。
 */
export interface ModuleSplit {
  /** 模块名称（如 "订单管理"） */
  readonly moduleName: string;
  /** 依赖的模块名列表（如 ["用户管理"]，表示本模块依赖这些模块先完成） */
  readonly dependencies: ReadonlyArray<string>;
}

// ============================================================================
// 4. MultiLoopPlanner 主类
// ============================================================================

/**
 * 多 Loop 串联计划生成器（对齐 §4.11 MultiLoopPlanner）
 *
 * 算法：
 * 1. plan：解析 spec.md → 按模块拆分 CODING 节点 → 装配 DESIGN+TESTING → 返回 MultiLoopPlan
 * 2. validate：DFS 环检测 + BFS 可达性检测 → 返回 DagValidationResult
 * 3. nextNode：拓扑序遍历 + 依赖满足判定 → 返回下一可执行节点
 *
 * 使用方式：
 * ```typescript
 * const planner = new MultiLoopPlanner();
 * const plan = await planner.plan({
 *   runId: "a1b2c3d4e5f6",
 *   projectRoot: "/path/to/project",
 *   specContent: "## 模块：订单管理\n依赖：用户管理\n## 模块：用户管理"
 * });
 * const validation = planner.validate(plan);
 * const nextNode = planner.nextNode(plan, ["design-1"]);
 * ```
 */
export class MultiLoopPlanner {
  /** Loop 转换规则（默认 DEFAULT_LOOP_TRANSITIONS） */
  private readonly transitions: ReadonlyArray<LoopTransition>;
  /** 日志回调 */
  private readonly log: LogCallback;

  /**
   * @param transitions Loop 转换规则（默认 DEFAULT_LOOP_TRANSITIONS）
   * @param logger 日志回调（可选）
   */
  constructor(transitions: ReadonlyArray<LoopTransition> = DEFAULT_LOOP_TRANSITIONS, logger: LogCallback = noopLog) {
    this.transitions = Object.freeze([...transitions]);
    this.log = logger;
  }

  /**
   * 生成多 Loop 串联计划
   *
   * 算法：
   * 1. 校验请求字段（runId / projectRoot / specContent 必填）
   * 2. 解析 spec.md → 提取模块切分列表（ModuleSplit[]）
   * 3. 装配 Loop 节点：
   *    a. 添加 design-1 节点（DESIGN Loop，无依赖）
   *    b. 按模块拆分 CODING 节点（每模块一个 coding-<idx>-<module>，依赖 design-1 + 模块依赖的其他 CODING 节点）
   *    c. 添加 testing-1 节点（TESTING Loop，依赖全部 CODING 节点）
   * 4. 装配 LoopTransition 规则（使用构造时传入的 transitions）
   * 5. 校验 DAG 合法性（含环 + 不可达节点）
   * 6. 返回冻结的 MultiLoopPlan
   *
   * @param request 计划生成请求
   * @returns 多 Loop 计划（冻结）
   * @throws MultiLoopPlannerError 请求非法 / DAG 校验失败
   */
  async plan(request: Readonly<MultiLoopPlanRequest>): Promise<Readonly<MultiLoopPlan>> {
    // 1. 校验请求字段
    this.validateRequest(request);

    this.log(`生成多 Loop 计划：runId=${request.runId}`, "info");

    // 2. 解析 spec.md 提取模块切分
    const modules = this.parseSpecModules(request.specContent);
    this.log(`spec.md 解析完成：模块数=${modules.length}`, "info");

    // 3. 装配 Loop 节点
    const nodes = this.buildNodes(request.runId, modules);

    // 4. 装配 MultiLoopPlan
    const plan: MultiLoopPlan = Object.freeze({
      planId: request.runId,
      projectRoot: request.projectRoot,
      loops: Object.freeze(nodes),
      autoTransition: request.autoTransition ?? false,
      rollbackOnFailure: request.rollbackOnFailure ?? true,
      createdAt: new Date().toISOString(),
    });

    // 5. 校验 DAG 合法性
    const validation = this.validate(plan);
    if (!validation.valid) {
      const cycleMsg =
        validation.cycles.length > 0 ? ` 存在环：${validation.cycles.map((c) => `[${c.join(" → ")}]`).join(" ")}` : "";
      const unreachableMsg =
        validation.unreachableNodes.length > 0 ? ` 不可达节点：${validation.unreachableNodes.join(", ")}` : "";
      throw new MultiLoopPlannerError("dag-invalid", `DAG 校验失败${cycleMsg}${unreachableMsg}`);
    }

    this.log(`多 Loop 计划生成完成：节点数=${nodes.length}`, "info");
    return plan;
  }

  /**
   * 校验计划 DAG 合法性
   *
   * 算法：
   * 1. 环检测：DFS 三色标记法（白/灰/黑），灰色节点表示当前 DFS 路径上的节点，
   *    遇到灰色节点即发现环
   * 2. 不可达节点检测：BFS 从 design-1（或首个无依赖节点）出发，访问所有可达节点，
   *    未访问的节点即为不可达
   *
   * @param plan 多 Loop 计划
   * @returns 校验结果（含环列表 + 不可达节点列表）
   */
  validate(plan: Readonly<MultiLoopPlan>): DagValidationResult {
    // 1. 构建邻接表（nodeId → 依赖的 nodeId 列表）
    const adjacency = new Map<string, ReadonlyArray<string>>();
    const nodeIds = new Set<string>();
    for (const node of plan.loops) {
      adjacency.set(node.nodeId, node.dependencies);
      nodeIds.add(node.nodeId);
    }

    // 2. 环检测：DFS 三色标记法
    // 颜色定义：0=白色（未访问）/ 1=灰色（当前路径）/ 2=黑色（已完成）
    const color = new Map<string, number>();
    for (const id of nodeIds) color.set(id, 0);
    const cycles: string[][] = [];

    /**
     * DFS 检测环
     *
     * @param nodeId 当前节点 ID
     * @param path 当前 DFS 路径（用于回溯环）
     * @returns true 表示发现环
     */
    const dfs = (nodeId: string, path: string[]): boolean => {
      color.set(nodeId, 1); // 标记为灰色
      path.push(nodeId);

      const deps = adjacency.get(nodeId) ?? [];
      for (const dep of deps) {
        if (!nodeIds.has(dep)) {
          // 依赖节点不存在于计划中，跳过（在 nextNode 中会因依赖未满足而阻塞）
          continue;
        }
        const depColor = color.get(dep) ?? 0;
        if (depColor === 1) {
          // 遇到灰色节点 → 发现环，提取环路径
          const cycleStart = path.indexOf(dep);
          const cycle = path.slice(cycleStart).concat([dep]);
          cycles.push(cycle);
        } else if (depColor === 0) {
          dfs(dep, path);
        }
      }

      path.pop();
      color.set(nodeId, 2); // 标记为黑色
      return false;
    };

    for (const id of nodeIds) {
      if (color.get(id) === 0) {
        dfs(id, []);
      }
    }

    // 3. 不可达节点检测：BFS 从入度为 0 的节点出发
    // 入度 = 0 的节点（即 design-1 或无依赖节点）作为起点
    const inDegree = new Map<string, number>();
    for (const id of nodeIds) inDegree.set(id, 0);
    for (const node of plan.loops) {
      for (const dep of node.dependencies) {
        if (nodeIds.has(dep)) {
          inDegree.set(node.nodeId, (inDegree.get(node.nodeId) ?? 0) + 1);
        }
      }
    }

    const roots: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) roots.push(id);
    }

    // BFS 访问所有可达节点
    // 反向邻接表：dep → 依赖它的节点列表（即 dep 完成后哪些节点可以开始）
    const reverseAdjacency = new Map<string, string[]>();
    for (const id of nodeIds) reverseAdjacency.set(id, []);
    for (const node of plan.loops) {
      for (const dep of node.dependencies) {
        if (nodeIds.has(dep)) {
          reverseAdjacency.get(dep)!.push(node.nodeId);
        }
      }
    }

    const visited = new Set<string>();
    const queue: string[] = [...roots];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of reverseAdjacency.get(current) ?? []) {
        if (!visited.has(next)) {
          queue.push(next);
        }
      }
    }

    // 不可达节点 = 全部节点 - 可达节点
    const unreachableNodes: string[] = [];
    for (const id of nodeIds) {
      if (!visited.has(id)) unreachableNodes.push(id);
    }

    // 4. 排序保证测试可重现
    cycles.sort((a, b) => a.join(",").localeCompare(b.join(",")));
    unreachableNodes.sort();

    return Object.freeze({
      valid: cycles.length === 0 && unreachableNodes.length === 0,
      cycles: Object.freeze(cycles.map((c) => Object.freeze([...c]))),
      unreachableNodes: Object.freeze([...unreachableNodes]),
    });
  }

  /**
   * 查询下一可执行节点（拓扑序 + 依赖满足）
   *
   * 算法：
   * 1. 过滤掉已完成节点（completedNodeIds 中的节点）
   * 2. 在剩余节点中查找依赖全部满足的节点（dependencies 全部在 completedNodeIds 中）
   * 3. 返回第一个这样的节点（按 plan.loops 顺序，即拓扑序）
   *
   * @param plan 当前计划
   * @param completedNodeIds 已完成节点 ID 列表
   * @returns 下一可执行节点；null 表示全部完成或无可执行节点
   */
  nextNode(plan: Readonly<MultiLoopPlan>, completedNodeIds: ReadonlyArray<string>): MultiLoopNode | null {
    const completedSet = new Set(completedNodeIds);

    // 按 plan.loops 顺序遍历（拓扑序）
    for (const node of plan.loops) {
      // 跳过已完成节点
      if (completedSet.has(node.nodeId)) continue;

      // 检查依赖是否全部满足
      const depsSatisfied = node.dependencies.every((dep) => completedSet.has(dep));
      if (depsSatisfied) {
        return node;
      }
    }

    // 全部完成或无可执行节点
    return null;
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 校验 plan 请求字段
   *
   * @param request 计划生成请求
   * @throws MultiLoopPlannerError 任一字段非法
   */
  private validateRequest(request: Readonly<MultiLoopPlanRequest>): void {
    if (!request) {
      throw new MultiLoopPlannerError("invalid-request", "request 不能为空");
    }
    if (typeof request.runId !== "string" || request.runId.trim().length === 0) {
      throw new MultiLoopPlannerError("invalid-request", "runId 必须为非空字符串");
    }
    if (typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new MultiLoopPlannerError("invalid-request", "projectRoot 必须为非空字符串");
    }
    if (typeof request.specContent !== "string") {
      throw new MultiLoopPlannerError("invalid-request", "specContent 必须为字符串");
    }
  }

  /**
   * 解析 spec.md 提取模块切分列表
   *
   * 算法：
   * 1. 按行扫描 spec.md
   * 2. 遇到 "## 模块：<名称>" 行 → 开始新模块，记录 moduleName
   * 3. 遇到 "依赖：<模块名>[,<模块名>]" 行 → 记录当前模块的依赖列表
   * 4. 直到下一模块开始或文件结束
   *
   * 若 spec.md 不含任何模块声明，返回空数组（plan 方法会回退到单 CODING 节点）。
   *
   * @param specContent spec.md 内容
   * @returns 模块切分列表
   */
  private parseSpecModules(specContent: string): ReadonlyArray<ModuleSplit> {
    const modules: ModuleSplit[] = [];
    const lines = specContent.split("\n");

    let currentModule: string | null = null;
    let currentDeps: string[] = [];

    for (const line of lines) {
      // 尝试匹配模块标题
      const moduleMatch = line.match(MODULE_HEADING_PATTERN);
      if (moduleMatch) {
        // 保存上一个模块
        if (currentModule) {
          modules.push(
            Object.freeze({
              moduleName: currentModule,
              dependencies: Object.freeze([...currentDeps]),
            })
          );
        }
        // 开始新模块
        currentModule = moduleMatch[1].trim();
        currentDeps = [];
        continue;
      }

      // 尝试匹配依赖声明
      const depMatch = line.match(MODULE_DEPENDENCY_PATTERN);
      if (depMatch && currentModule) {
        // 依赖列表支持中英文逗号分隔
        const deps = depMatch[1]
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        currentDeps = [...currentDeps, ...deps];
      }
    }

    // 保存最后一个模块
    if (currentModule) {
      modules.push(
        Object.freeze({
          moduleName: currentModule,
          dependencies: Object.freeze([...currentDeps]),
        })
      );
    }

    return Object.freeze(modules);
  }

  /**
   * 装配 Loop 节点列表
   *
   * 算法：
   * 1. 添加 design-1 节点（DESIGN Loop，无依赖）
   * 2. 按模块拆分 CODING 节点：
   *    - 单模块或无模块场景：单个 coding-1 节点，依赖 design-1
   *    - 多模块场景：每模块一个 coding-<idx>-<module> 节点，
   *      依赖 design-1 + 同 plan 内其他 CODING 节点（按模块依赖关系映射）
   * 3. 添加 testing-1 节点（TESTING Loop，依赖全部 CODING 节点）
   *
   * @param runId run-id（用于日志）
   * @param modules 模块切分列表
   * @returns Loop 节点列表（按拓扑序）
   */
  private buildNodes(runId: string, modules: ReadonlyArray<ModuleSplit>): MultiLoopNode[] {
    const nodes: MultiLoopNode[] = [];

    // 1. DESIGN Loop 前置节点（无依赖）
    const designNode: MultiLoopNode = Object.freeze({
      nodeId: "design-1",
      loopType: "design",
      dependencies: Object.freeze([]),
      status: "pending" as MultiLoopNodeStatus,
      entryArtifact: "用户原始需求",
      exitCriteria: "spec 批准 + 用户检查点通过",
    });
    nodes.push(designNode);

    // 2. CODING Loop 节点（按模块拆分）
    const codingNodeIds: string[] = [];
    // 模块名 → CODING 节点 ID 映射（用于解析模块依赖）
    const moduleNameToNodeId = new Map<string, string>();

    if (modules.length === 0) {
      // 无模块声明 → 单 CODING 节点
      const codingNode: MultiLoopNode = Object.freeze({
        nodeId: "coding-1",
        loopType: "coding",
        dependencies: Object.freeze(["design-1"]),
        status: "pending" as MultiLoopNodeStatus,
        entryArtifact: "docs/eag/spec.md",
        exitCriteria: "G-5 passed",
      });
      nodes.push(codingNode);
      codingNodeIds.push(codingNode.nodeId);
    } else {
      // 多模块 → 每模块一个 CODING 节点
      for (let i = 0; i < modules.length; i++) {
        const module = modules[i];
        const nodeId = `coding-${i + 1}-${this.sanitizeModuleName(module.moduleName)}`;
        moduleNameToNodeId.set(module.moduleName, nodeId);

        // 依赖：design-1 + 本模块依赖的其他模块对应的 CODING 节点
        // 注意：模块依赖需在所有 CODING 节点 ID 生成后才能解析，
        //       此处先收集模块依赖，稍后统一解析
        const codingNode: MultiLoopNode = Object.freeze({
          nodeId,
          loopType: "coding",
          // 依赖先填 design-1，模块依赖稍后补丁
          dependencies: Object.freeze(["design-1"]),
          status: "pending" as MultiLoopNodeStatus,
          entryArtifact: `docs/eag/spec.md（模块：${module.moduleName}）`,
          exitCriteria: "G-5 passed",
        });
        nodes.push(codingNode);
        codingNodeIds.push(codingNode.nodeId);
      }

      // 补丁：解析模块依赖，更新 CODING 节点的 dependencies 字段
      // 由于 MultiLoopNode 是不可变的，需用新对象替换
      for (let i = 0; i < modules.length; i++) {
        const module = modules[i];
        const nodeId = moduleNameToNodeId.get(module.moduleName)!;
        const moduleDeps: string[] = [];
        for (const dep of module.dependencies) {
          const depNodeId = moduleNameToNodeId.get(dep);
          if (depNodeId) {
            moduleDeps.push(depNodeId);
          } else {
            // 依赖的模块不在 spec 中，记录日志但继续（不阻断计划生成）
            this.log(`模块 "${module.moduleName}" 依赖的模块 "${dep}" 未在 spec.md 中声明，已忽略`, "warn");
          }
        }
        // 找到节点在 nodes 数组中的位置，用新对象替换（保持不可变）
        const nodeIdx = nodes.findIndex((n) => n.nodeId === nodeId);
        if (nodeIdx >= 0) {
          nodes[nodeIdx] = Object.freeze({
            ...nodes[nodeIdx],
            dependencies: Object.freeze(["design-1", ...moduleDeps]),
          });
        }
      }
    }

    // 3. TESTING Loop 后置节点（依赖全部 CODING 节点）
    const testingNode: MultiLoopNode = Object.freeze({
      nodeId: "testing-1",
      loopType: "testing",
      dependencies: Object.freeze(codingNodeIds),
      status: "pending" as MultiLoopNodeStatus,
      entryArtifact: "实现代码目录",
      exitCriteria: "G-7 passed",
    });
    nodes.push(testingNode);

    this.log(`装配 Loop 节点：runId=${runId} 节点数=${nodes.length}`, "info");
    return nodes;
  }

  /**
   * 净化模块名为合法节点 ID 片段
   *
   * 模块名可能含中文/空格/特殊字符，需净化为节点 ID 安全的字符串：
   * - 中文字符保留（Unicode 字母允许）
   * - 空格替换为连字符
   * - 其他特殊字符删除
   * - 转小写
   *
   * @param moduleName 原始模块名
   * @returns 净化后的节点 ID 片段
   */
  private sanitizeModuleName(moduleName: string): string {
    return moduleName
      .trim()
      .replace(/\s+/g, "-") // 空格替换为连字符
      .replace(/[^\p{L}\p{N}-]/gu, "") // 保留字母/数字/连字符（Unicode 字母包含中文）
      .toLowerCase();
  }
}
