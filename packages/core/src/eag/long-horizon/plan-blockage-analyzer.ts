/**
 * 依赖图阻塞分析器（EAG-P3 批次 12 C1）
 *
 * 本模块实现 `PlanBlockageAnalyzer` 类，对应 EAG 方案 §5.12.2 "阻塞分析报告"的依赖图分析维度：
 * 基于 MultiLoopPlan DAG + 资源访问图 + 门禁状态，识别 5 类阻塞：
 * 1. circular-dependency：循环依赖（复用 MultiLoopPlanner.validate 的 DFS 三色标记法）
 * 2. resource-contention：资源竞争（构建资源访问图，识别多节点并行访问同一资源）
 * 3. deadlock-risk：死锁风险（构建等待图，检测环）
 * 4. missing-dependency：缺失依赖（比对节点 dependencies 与 plan.loops 节点 ID 集合）
 * 5. gate-blocked：门禁阻塞（查询 GateStatusSnapshot，识别 passed=false 的门禁）
 *
 * 设计依据：
 * - EAG 方案 §5.12.2 阻塞分析报告
 * - EAG-P3 批次 12 设计 §3 C1 阻塞分析增强
 * - 既有 BlockageAnalyzer（批次 10）的根因分析维度互补
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 *
 * @module eag/long-horizon/plan-blockage-analyzer
 */

import type { LogCallback } from "./types";
import type {
  ActionEffort,
  ActionPriority,
  BlockageAnalysisReport,
  BlockageRecord,
  BlockageSeverity,
  BlockageType,
  GateStatusSnapshot,
  MultiLoopPlan,
  PlanBlockageAnalyzeRequest,
  ResourceAccessGraph,
  SuggestedAction,
} from "./types";
import type { MultiLoopPlanner } from "./multi-loop-planner";

// ============================================================================
// 1. 自定义错误类
// ============================================================================

/**
 * PlanBlockageAnalyzer 错误类型字面量联合
 *
 * - invalid-request：请求参数非法
 * - planner-error：MultiLoopPlanner.validate 调用异常
 */
export type PlanBlockageAnalyzerErrorKind = "invalid-request" | "planner-error";

/**
 * PlanBlockageAnalyzer 错误
 *
 * 自定义错误类，含 kind（错误类型）+ 原始异常（cause）便于上层诊断。
 */
export class PlanBlockageAnalyzerError extends Error {
  /** 错误类型字面量（便于程序化分支处理） */
  public readonly kind: PlanBlockageAnalyzerErrorKind;

  /**
   * @param kind 错误类型
   * @param message 错误消息
   * @param cause 原始异常（可选）
   */
  constructor(
    kind: PlanBlockageAnalyzerErrorKind,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "PlanBlockageAnalyzerError";
    this.kind = kind;
  }
}

// ============================================================================
// 2. 默认日志函数
// ============================================================================

/**
 * 空日志函数（默认值，避免每次调用都判断 null）
 *
 * 对齐 blockage-analyzer.ts 中的 noopLog 模式。
 */
function noopLog(_message: string, _level?: "info" | "warn" | "error"): void {
  // 默认不输出日志
}

// ============================================================================
// 3. PlanBlockageAnalyzer 主类
// ============================================================================

/**
 * 依赖图阻塞分析器（EAG-P3 批次 12 C1）
 *
 * 与既有 `BlockageAnalyzer`（批次 10）正交：
 * - `BlockageAnalyzer`：基于"人工介入记录"维度的根因分析（rootCauseHypotheses / suggestedSolutions / requiredDecisions）
 * - `PlanBlockageAnalyzer`：基于"依赖图 + 资源访问 + 门禁状态"维度的阻塞识别（blockageRecords / overallBlocked / suggestedActions）
 *
 * 使用方式：
 * ```typescript
 * const analyzer = new PlanBlockageAnalyzer(new MultiLoopPlanner());
 * const report = await analyzer.analyze({
 *   runId: "a1b2c3d4e5f6",
 *   plan,
 *   runState,
 *   gateStatusSnapshot,        // 可选
 *   resourceAccessGraph,       // 可选
 * });
 * if (report.overallBlocked) {
 *   // 触发 HUMAN_CHECKPOINT
 * }
 * ```
 *
 * 设计约束：
 * - 5 个检测通道串行执行，互不依赖（除资源竞争与死锁风险共享资源访问图）
 * - 报告全部字段使用 Object.freeze 深冻结（对齐 §5.12.4 G-A6d）
 * - 既有 BlockageReport 字段填充空数组（rootCauseHypotheses / suggestedSolutions / requiredDecisions / relatedInterventions），
 *   理由：PlanBlockageAnalyzer 专注于依赖图维度，根因维度由 BlockageAnalyzer 负责
 */
export class PlanBlockageAnalyzer {
  // ============================ 依赖组件 ============================

  /** 多 Loop 计划生成器（必填，复用其 validate 方法进行环检测） */
  private readonly planner: MultiLoopPlanner;
  /** 日志回调 */
  private readonly log: LogCallback;

  /**
   * @param planner 多 Loop 计划生成器（必填，复用其 validate 方法）
   * @param logger 日志回调（可选，默认 noop）
   */
  constructor(planner: MultiLoopPlanner, logger: LogCallback = noopLog) {
    if (!planner) {
      throw new PlanBlockageAnalyzerError("invalid-request", "planner 必填");
    }
    this.planner = planner;
    this.log = logger;
  }

  // ============================ 公共 API ============================

  /**
   * 分析依赖图阻塞并生成报告
   *
   * 算法（5 个检测通道，串行执行）：
   * 1. 循环依赖检测（detectCircularDependencies）
   *    - 调用 planner.validate(plan) 获取 DagValidationResult
   *    - 每个 cycle 生成 1 条 BlockageRecord（type=circular-dependency, severity=blocker）
   * 2. 缺失依赖检测（detectMissingDependencies）
   *    - 构建 plan.loops 全部节点 ID 集合
   *    - 遍历每节点 dependencies，缺失的 ID 生成 BlockageRecord（type=missing-dependency, severity=blocker）
   * 3. 资源竞争检测（detectResourceContention，需要 resourceAccessGraph）
   *    - 按资源 ID 分组资源访问记录
   *    - 同一资源被 ≥2 个无依赖关系的节点访问 → BlockageRecord（type=resource-contention, severity=major）
   * 4. 死锁风险检测（detectDeadlockRisk，需要 resourceAccessGraph）
   *    - 构建等待图：节点 A 等待节点 B 持有的资源（B 已 write/read-write，A 想要 write/read-write）
   *    - DFS 检测等待图环 → BlockageRecord（type=deadlock-risk, severity=blocker）
   * 5. 门禁阻塞检测（detectGateBlockage，需要 gateStatusSnapshot）
   *    - 遍历 gateResults，passed=false 的门禁 → BlockageRecord（type=gate-blocked, severity=gateResult.severity）
   *
   * 报告生成：
   * - overallBlocked = 任一 blockageRecord.severity === "blocker"
   * - suggestedActions = 每条 BlockageRecord 生成 1 个 SuggestedAction
   * - 既有 BlockageReport 字段填充空数组（rootCauseHypotheses / suggestedSolutions / requiredDecisions / relatedInterventions）
   *    理由：PlanBlockageAnalyzer 专注于依赖图维度，根因维度由 BlockageAnalyzer 负责
   *
   * @param request 分析请求
   * @returns 阻塞分析报告（含 blockageRecords + overallBlocked + suggestedActions）
   * @throws PlanBlockageAnalyzerError 请求非法
   */
  async analyze(request: Readonly<PlanBlockageAnalyzeRequest>): Promise<Readonly<BlockageAnalysisReport>> {
    // 1. 校验请求字段
    this.validateRequest(request);

    this.log(`分析依赖图阻塞：runId=${request.runId} 节点数=${request.plan.loops.length}`, "info");

    // 2. 执行 5 个检测通道
    const blockageRecords: BlockageRecord[] = [];

    // 通道 1：循环依赖检测
    const circularBlockages = this.detectCircularDependencies(request.plan);
    blockageRecords.push(...circularBlockages);
    this.log(`循环依赖检测：${circularBlockages.length} 条`, "info");

    // 通道 2：缺失依赖检测
    const missingBlockages = this.detectMissingDependencies(request.plan);
    blockageRecords.push(...missingBlockages);
    this.log(`缺失依赖检测：${missingBlockages.length} 条`, "info");

    // 通道 3：资源竞争检测（可选）
    if (request.resourceAccessGraph) {
      const contentionBlockages = this.detectResourceContention(request.plan, request.resourceAccessGraph);
      blockageRecords.push(...contentionBlockages);
      this.log(`资源竞争检测：${contentionBlockages.length} 条`, "info");
    }

    // 通道 4：死锁风险检测（可选）
    if (request.resourceAccessGraph) {
      const deadlockBlockages = this.detectDeadlockRisk(request.plan, request.resourceAccessGraph);
      blockageRecords.push(...deadlockBlockages);
      this.log(`死锁风险检测：${deadlockBlockages.length} 条`, "info");
    }

    // 通道 5：门禁阻塞检测（可选）
    if (request.gateStatusSnapshot) {
      const gateBlockages = this.detectGateBlockage(request.gateStatusSnapshot);
      blockageRecords.push(...gateBlockages);
      this.log(`门禁阻塞检测：${gateBlockages.length} 条`, "info");
    }

    // 3. 生成建议动作
    const suggestedActions = this.generateSuggestedActions(blockageRecords);

    // 4. 判定 overallBlocked
    const overallBlocked = blockageRecords.some((r) => r.severity === "blocker");

    // 5. 构造 BlockageAnalysisReport（深冻结）
    const report: BlockageAnalysisReport = Object.freeze({
      // 既有 BlockageReport 字段（填充空数组，根因维度由 BlockageAnalyzer 负责）
      runId: request.runId,
      generatedAt: new Date().toISOString(),
      blockedLoop: request.runState.currentLoop,
      blockedIteration: request.runState.currentIteration,
      rootCauseHypotheses: Object.freeze([]),
      suggestedSolutions: Object.freeze([]),
      requiredDecisions: Object.freeze([]),
      relatedInterventions: Object.freeze([]),
      // 新增 3 字段
      blockageRecords: Object.freeze(blockageRecords.map((r) => Object.freeze({ ...r }))),
      overallBlocked,
      suggestedActions: Object.freeze(suggestedActions.map((a) => Object.freeze({ ...a }))),
    });

    return report;
  }

  // ============================ 私有方法：校验 ============================

  /**
   * 校验分析请求字段
   *
   * 校验规则：
   * - request 必须为对象
   * - runId 必须为非空字符串
   * - plan 必须为对象且 loops 为数组
   * - runState 必须为对象
   *
   * @param request 分析请求
   * @throws PlanBlockageAnalyzerError 任一字段非法
   */
  private validateRequest(request: Readonly<PlanBlockageAnalyzeRequest>): void {
    if (!request || typeof request !== "object") {
      throw new PlanBlockageAnalyzerError("invalid-request", "request 必须为对象");
    }
    if (typeof request.runId !== "string" || request.runId.trim().length === 0) {
      throw new PlanBlockageAnalyzerError("invalid-request", "runId 必须为非空字符串");
    }
    if (!request.plan || !Array.isArray(request.plan.loops)) {
      throw new PlanBlockageAnalyzerError("invalid-request", "plan.loops 必须为数组");
    }
    if (!request.runState || typeof request.runState !== "object") {
      throw new PlanBlockageAnalyzerError("invalid-request", "runState 必须为对象");
    }
  }

  // ============================ 私有方法：通道 1 循环依赖检测 ============================

  /**
   * 通道 1：循环依赖检测
   *
   * 算法：
   * 1. 调用 planner.validate(plan) 获取 DagValidationResult
   *    - validate 内部使用 DFS 三色标记法（白/灰/黑）检测环
   *    - 灰色节点表示当前 DFS 路径上的节点，遇到灰色节点即发现环
   * 2. 每个 cycle 生成 1 条 BlockageRecord
   *    - type: "circular-dependency"
   *    - severity: "blocker"（环必然阻塞执行）
   *    - affectedNodes: cycle 中的全部节点 ID
   *    - rootCause: "CODING Loop 节点形成环：{cycle 链}"
   *    - mitigation: "重新审视 spec.md 模块切分，移除环中节点的循环依赖"
   *
   * @param plan 多 Loop 计划
   * @returns 循环依赖阻塞记录列表
   */
  private detectCircularDependencies(plan: Readonly<MultiLoopPlan>): BlockageRecord[] {
    const validation = this.planner.validate(plan);
    const records: BlockageRecord[] = [];

    for (let i = 0; i < validation.cycles.length; i++) {
      const cycle = validation.cycles[i];
      const blockageId = `blk-circular-${String(i + 1).padStart(3, "0")}`;
      const cycleChain = cycle.join(" → ");
      // 修复建议：建议从环的最后一跳（cycle[last] → cycle[0]）开始切断
      const lastIdx = cycle.length - 1;
      const fromNode = lastIdx >= 0 ? cycle[lastIdx] : "";
      const toNode = cycle.length > 0 ? cycle[0] : "";
      records.push(
        Object.freeze({
          blockageId,
          type: "circular-dependency",
          severity: "blocker",
          affectedNodes: Object.freeze([...cycle]),
          rootCause: `CODING Loop 节点形成环：${cycleChain}`,
          mitigation: `重新审视 spec.md 模块切分，移除环中节点的循环依赖（建议从 ${fromNode} → ${toNode} 的依赖开始）`,
        }) as BlockageRecord
      );
    }

    return records;
  }

  // ============================ 私有方法：通道 2 缺失依赖检测 ============================

  /**
   * 通道 2：缺失依赖检测
   *
   * 算法：
   * 1. 构建 plan.loops 全部节点 ID 集合（Set<string>）
   * 2. 遍历每节点的 dependencies
   * 3. 不在节点 ID 集合中的依赖 ID → 记录为缺失依赖
   * 4. 同一节点多个缺失依赖合并为 1 条 BlockageRecord
   *    - type: "missing-dependency"
   *    - severity: "blocker"（缺失依赖必然阻塞）
   *    - affectedNodes: 当前节点 ID
   *    - rootCause: "节点 {nodeId} 依赖不存在的节点：{缺失依赖列表}"
   *    - mitigation: "在 spec.md 中补充缺失的模块声明，或移除该节点的无效依赖"
   *
   * @param plan 多 Loop 计划
   * @returns 缺失依赖阻塞记录列表
   */
  private detectMissingDependencies(plan: Readonly<MultiLoopPlan>): BlockageRecord[] {
    // 1. 构建全部节点 ID 集合
    const nodeIds = new Set<string>();
    for (const node of plan.loops) {
      nodeIds.add(node.nodeId);
    }

    const records: BlockageRecord[] = [];
    let blockageIdx = 1;

    // 2. 遍历每节点，检查 dependencies 是否全部存在
    for (const node of plan.loops) {
      const missingDeps: string[] = [];
      for (const dep of node.dependencies) {
        if (!nodeIds.has(dep)) {
          missingDeps.push(dep);
        }
      }
      if (missingDeps.length > 0) {
        const blockageId = `blk-missing-${String(blockageIdx).padStart(3, "0")}`;
        blockageIdx += 1;
        records.push(
          Object.freeze({
            blockageId,
            type: "missing-dependency",
            severity: "blocker",
            affectedNodes: Object.freeze([node.nodeId]),
            rootCause: `节点 ${node.nodeId} 依赖不存在的节点：${missingDeps.join(", ")}`,
            mitigation: `在 spec.md 中补充缺失的模块声明（${missingDeps.join(", ")}），或移除 ${node.nodeId} 对这些节点的依赖`,
          }) as BlockageRecord
        );
      }
    }

    return records;
  }

  // ============================ 私有方法：通道 3 资源竞争检测 ============================

  /**
   * 通道 3：资源竞争检测
   *
   * 算法：
   * 1. 按资源 ID 分组资源访问记录（resourceId → Set<nodeId>）
   * 2. 对每个资源：
   *    a. 提取访问该资源的全部节点 ID（去重）
   *    b. 若节点数 < 2，跳过（无竞争）
   *    c. 检查这些节点之间是否存在依赖关系（任一节点是另一节点的依赖）
   *    d. 若存在 ≥2 个无依赖关系的节点访问同一资源 → 资源竞争
   * 3. 同一资源的竞争生成 1 条 BlockageRecord
   *    - type: "resource-contention"
   *    - severity: "major"（影响并发性能但非必然阻塞）
   *    - affectedNodes: 竞争节点列表
   *    - rootCause: "{资源 ID} 被 {N} 个并行节点访问：{节点列表}"
   *    - mitigation: "串行化竞争节点，或为资源引入锁机制"
   *
   * @param plan 多 Loop 计划
   * @param graph 资源访问图
   * @returns 资源竞争阻塞记录列表
   */
  private detectResourceContention(
    plan: Readonly<MultiLoopPlan>,
    graph: Readonly<ResourceAccessGraph>
  ): BlockageRecord[] {
    // 1. 按资源 ID 分组（resourceId → Set<nodeId>）
    const resourceToNodes = new Map<string, Set<string>>();
    for (const access of graph.accesses) {
      const nodeSet = resourceToNodes.get(access.resourceId) ?? new Set<string>();
      nodeSet.add(access.nodeId);
      resourceToNodes.set(access.resourceId, nodeSet);
    }

    // 2. 构建节点依赖关系索引（nodeId → 依赖的 nodeId 集合）
    const nodeDeps = new Map<string, Set<string>>();
    for (const node of plan.loops) {
      nodeDeps.set(node.nodeId, new Set(node.dependencies));
    }

    // 3. 检测竞争
    const records: BlockageRecord[] = [];
    let blockageIdx = 1;

    for (const [resourceId, nodeSet] of resourceToNodes.entries()) {
      if (nodeSet.size < 2) continue;

      const nodes = [...nodeSet];
      // 检查是否存在无依赖关系的节点对
      let hasContention = false;
      const contentionNodes: string[] = [];
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const depsI = nodeDeps.get(nodes[i]) ?? new Set<string>();
          const depsJ = nodeDeps.get(nodes[j]) ?? new Set<string>();
          // 若 i 不是 j 的依赖，且 j 不是 i 的依赖 → 并行节点
          if (!depsI.has(nodes[j]) && !depsJ.has(nodes[i])) {
            hasContention = true;
            if (!contentionNodes.includes(nodes[i])) contentionNodes.push(nodes[i]);
            if (!contentionNodes.includes(nodes[j])) contentionNodes.push(nodes[j]);
          }
        }
      }

      if (hasContention) {
        const blockageId = `blk-contention-${String(blockageIdx).padStart(3, "0")}`;
        blockageIdx += 1;
        // 排序保证测试可重现
        const sortedNodes = [...contentionNodes].sort();
        records.push(
          Object.freeze({
            blockageId,
            type: "resource-contention",
            severity: "major",
            affectedNodes: Object.freeze(sortedNodes),
            rootCause: `资源 ${resourceId} 被 ${contentionNodes.length} 个并行节点访问：${sortedNodes.join(", ")}`,
            mitigation: `串行化竞争节点（在 spec.md 中声明依赖关系），或为资源 ${resourceId} 引入锁机制`,
          }) as BlockageRecord
        );
      }
    }

    return records;
  }

  // ============================ 私有方法：通道 4 死锁风险检测 ============================

  /**
   * 通道 4：死锁风险检测
   *
   * 算法（经典 Wait-for Graph + hold-and-wait 条件）：
   * 1. 构建资源持有者索引：resourceId → 持有者节点 ID 列表（write 或 read-write 模式）
   * 2. 构建节点持有资源索引：nodeId → 持有的资源 ID 集合（用于 hold-and-wait 条件判定）
   * 3. 构建等待图（Wait-for Graph）：
   *    - 节点 B 想要访问资源 R（write 或 read-write 模式）
   *    - 节点 A 持有资源 R（write 或 read-write 模式）
   *    - A 与 B 无依赖关系（并行）
   *    - **hold-and-wait 条件**：B 必须持有至少一个 OTHER 资源（R' != R）
   *      → 仅当 B 在持有的同时还想获取其他资源，才视为真正等待
   *      → 此条件避免将"2 节点竞争同一资源"误判为死锁（该场景由通道 3 资源竞争检测处理）
   *    - 等待图边：B → A（B 等待 A 释放 R）
   * 4. DFS 三色标记法检测等待图环
   * 5. 每个环生成 1 条 BlockageRecord
   *    - type: "deadlock-risk"
   *    - severity: "blocker"（死锁必然阻塞）
   *    - affectedNodes: 环中全部节点 ID
   *    - rootCause: "节点形成循环等待：{环链}"
   *    - mitigation: "重构资源访问顺序，破坏循环等待（建议按资源 ID 全序获取锁）"
   *
   * @param plan 多 Loop 计划
   * @param graph 资源访问图
   * @returns 死锁风险阻塞记录列表
   */
  private detectDeadlockRisk(plan: Readonly<MultiLoopPlan>, graph: Readonly<ResourceAccessGraph>): BlockageRecord[] {
    // 1. 构建资源持有者索引：resourceId → 持有者节点 ID 列表（write 或 read-write 模式）
    const resourceHolders = new Map<string, string[]>();
    for (const access of graph.accesses) {
      if (access.accessMode === "write" || access.accessMode === "read-write") {
        const holders = resourceHolders.get(access.resourceId) ?? [];
        holders.push(access.nodeId);
        resourceHolders.set(access.resourceId, holders);
      }
    }

    // 2. 构建节点持有资源索引：nodeId → 持有的资源 ID 集合
    //    用于判定 hold-and-wait 条件（B 必须持有 OTHER 资源才算真正等待）
    const nodeHolds = new Map<string, Set<string>>();
    for (const access of graph.accesses) {
      if (access.accessMode === "write" || access.accessMode === "read-write") {
        const holds = nodeHolds.get(access.nodeId) ?? new Set<string>();
        holds.add(access.resourceId);
        nodeHolds.set(access.nodeId, holds);
      }
    }

    // 3. 构建节点依赖关系索引
    const nodeDeps = new Map<string, Set<string>>();
    for (const node of plan.loops) {
      nodeDeps.set(node.nodeId, new Set(node.dependencies));
    }

    // 4. 构建等待图：waitFor.get(B) = A 集合（B 等待 A 释放资源）
    const waitFor = new Map<string, Set<string>>();
    for (const access of graph.accesses) {
      // 节点 access.nodeId 想要 write/read-write 资源 access.resourceId
      if (access.accessMode === "write" || access.accessMode === "read-write") {
        const holders = resourceHolders.get(access.resourceId) ?? [];
        // 获取 B 持有的全部资源（用于 hold-and-wait 条件判定）
        const bHolds = nodeHolds.get(access.nodeId) ?? new Set<string>();
        for (const holder of holders) {
          if (holder === access.nodeId) continue; // 自己持有自己等待，跳过
          // hold-and-wait 条件：B 必须持有至少一个 OTHER 资源（不是当前想要的资源）
          // 否则仅是单纯竞争同一资源，由通道 3 资源竞争检测处理，不在此重复标记
          const holdsOtherResource = [...bHolds].some((r) => r !== access.resourceId);
          if (!holdsOtherResource) continue;
          // 检查是否并行（无依赖关系）
          const depsB = nodeDeps.get(access.nodeId) ?? new Set<string>();
          const depsA = nodeDeps.get(holder) ?? new Set<string>();
          if (!depsB.has(holder) && !depsA.has(access.nodeId)) {
            // B 等待 A
            const waits = waitFor.get(access.nodeId) ?? new Set<string>();
            waits.add(holder);
            waitFor.set(access.nodeId, waits);
          }
        }
      }
    }

    // 5. DFS 三色标记法检测环
    // 颜色定义：0=白色（未访问）/ 1=灰色（当前路径）/ 2=黑色（已完成）
    const color = new Map<string, number>();
    const allNodes = new Set<string>();
    for (const [b, aSet] of waitFor.entries()) {
      allNodes.add(b);
      for (const a of aSet) allNodes.add(a);
    }
    for (const id of allNodes) color.set(id, 0);

    const cycles: string[][] = [];

    /**
     * DFS 检测环（内部函数）
     *
     * @param nodeId 当前节点
     * @param path 当前路径
     */
    const dfs = (nodeId: string, path: string[]): void => {
      color.set(nodeId, 1); // 标记为灰色
      path.push(nodeId);

      const waits = waitFor.get(nodeId) ?? new Set<string>();
      for (const target of waits) {
        const targetColor = color.get(target) ?? 0;
        if (targetColor === 1) {
          // 遇到灰色节点 → 发现环，提取环路径
          const cycleStart = path.indexOf(target);
          const cycle = path.slice(cycleStart).concat([target]);
          cycles.push(cycle);
        } else if (targetColor === 0) {
          dfs(target, path);
        }
      }

      path.pop();
      color.set(nodeId, 2); // 标记为黑色
    };

    for (const id of allNodes) {
      if (color.get(id) === 0) {
        dfs(id, []);
      }
    }

    // 6. 生成 BlockageRecord
    const records: BlockageRecord[] = [];
    for (let i = 0; i < cycles.length; i++) {
      const cycle = cycles[i];
      const blockageId = `blk-deadlock-${String(i + 1).padStart(3, "0")}`;
      const cycleChain = cycle.join(" → ");
      records.push(
        Object.freeze({
          blockageId,
          type: "deadlock-risk",
          severity: "blocker",
          affectedNodes: Object.freeze([...cycle]),
          rootCause: `节点形成循环等待：${cycleChain}`,
          mitigation: "重构资源访问顺序，破坏循环等待（建议按资源 ID 全序获取锁）",
        }) as BlockageRecord
      );
    }

    return records;
  }

  // ============================ 私有方法：通道 5 门禁阻塞检测 ============================

  /**
   * 通道 5：门禁阻塞检测
   *
   * 算法：
   * 1. 遍历 gateStatusSnapshot.gateResults
   * 2. 每条 passed=false 的 GateResult 生成 1 条 BlockageRecord
   *    - type: "gate-blocked"
   *    - severity: 复用 gateResult.severity（blocker/major/warning）
   *    - affectedNodes: 空数组（门禁不直接对应 DAG 节点）
   *    - rootCause: "门禁 {gateResult.gate} 未通过：{gateResult.reason}"
   *    - mitigation: gateResult.guidance（复用门禁检查器的引导消息）
   *
   * @param snapshot 门禁状态快照
   * @returns 门禁阻塞记录列表
   */
  private detectGateBlockage(snapshot: Readonly<GateStatusSnapshot>): BlockageRecord[] {
    const records: BlockageRecord[] = [];
    let blockageIdx = 1;

    for (const gateResult of snapshot.gateResults) {
      if (gateResult.passed) continue;

      const blockageId = `blk-gate-${String(blockageIdx).padStart(3, "0")}`;
      blockageIdx += 1;

      // 映射 GateSeverity 到 BlockageSeverity（同构，运行时校验保证字面量合法）
      const severity = this.mapGateSeverityToBlockageSeverity(gateResult.severity);

      records.push(
        Object.freeze({
          blockageId,
          type: "gate-blocked",
          severity,
          affectedNodes: Object.freeze([]),
          rootCause: `门禁 ${gateResult.gate} 未通过：${gateResult.reason}`,
          mitigation: gateResult.guidance ?? `修复门禁 ${gateResult.gate} 的未通过项后重试`,
        }) as BlockageRecord
      );
    }

    return records;
  }

  /**
   * 将 GateSeverity 映射到 BlockageSeverity
   *
   * GateSeverity 与 BlockageSeverity 同构（blocker/major/warning），
   * 但通过显式映射函数避免类型断言可能掩盖字段不一致的风险。
   *
   * @param gateSeverity 门禁严重性
   * @returns 阻塞严重性
   */
  private mapGateSeverityToBlockageSeverity(gateSeverity: "blocker" | "major" | "warning"): BlockageSeverity {
    switch (gateSeverity) {
      case "blocker":
        return "blocker";
      case "major":
        return "major";
      case "warning":
        return "warning";
      default: {
        // 防御性：未来若 GateSeverity 扩展，此分支触发明确错误
        const exhaustive: never = gateSeverity;
        throw new PlanBlockageAnalyzerError("invalid-request", `未支持的 GateSeverity 值：${String(exhaustive)}`);
      }
    }
  }

  // ============================ 私有方法：建议动作生成 ============================

  /**
   * 生成建议动作列表
   *
   * 算法：每条 BlockageRecord 生成 1 个 SuggestedAction。
   * - priority：blocker → critical / major → high / warning → medium
   * - estimatedEffort：基于 type 推断
   *   - circular-dependency → medium（需重新审视 spec.md）
   *   - resource-contention → medium（需引入锁或串行化）
   *   - deadlock-risk → high（需重构资源访问顺序）
   *   - missing-dependency → low（补充声明或移除依赖）
   *   - gate-blocked → low（修复门禁未通过项）
   *
   * @param blockageRecords 阻塞记录列表
   * @returns 建议动作列表
   */
  private generateSuggestedActions(blockageRecords: ReadonlyArray<BlockageRecord>): SuggestedAction[] {
    const actions: SuggestedAction[] = [];

    for (let i = 0; i < blockageRecords.length; i++) {
      const record = blockageRecords[i];
      const actionId = `act-${String(i + 1).padStart(3, "0")}`;

      // 优先级映射（基于 severity）
      const priority: ActionPriority = this.mapSeverityToPriority(record.severity);

      // 成本映射（基于 type）
      const effort: ActionEffort = this.mapTypeToEffort(record.type);

      actions.push(
        Object.freeze({
          actionId,
          targetBlockageId: record.blockageId,
          action: record.mitigation,
          priority,
          estimatedEffort: effort,
        }) as SuggestedAction
      );
    }

    return actions;
  }

  /**
   * 将 BlockageSeverity 映射到 ActionPriority
   *
   * - blocker → critical（必须立即执行）
   * - major → high（建议尽快执行）
   * - warning → medium（可在适当时机执行）
   *
   * @param severity 阻塞严重性
   * @returns 动作优先级
   */
  private mapSeverityToPriority(severity: BlockageSeverity): ActionPriority {
    switch (severity) {
      case "blocker":
        return "critical";
      case "major":
        return "high";
      case "warning":
        return "medium";
      default: {
        const exhaustive: never = severity;
        throw new PlanBlockageAnalyzerError("invalid-request", `未支持的 BlockageSeverity 值：${String(exhaustive)}`);
      }
    }
  }

  /**
   * 将 BlockageType 映射到 ActionEffort
   *
   * - circular-dependency → medium（需重新审视 spec.md）
   * - resource-contention → medium（需引入锁或串行化）
   * - deadlock-risk → high（需重构资源访问顺序）
   * - missing-dependency → low（补充声明或移除依赖）
   * - gate-blocked → low（修复门禁未通过项）
   *
   * @param type 阻塞类型
   * @returns 动作成本
   */
  private mapTypeToEffort(type: BlockageType): ActionEffort {
    switch (type) {
      case "circular-dependency":
        return "medium";
      case "resource-contention":
        return "medium";
      case "deadlock-risk":
        return "high";
      case "missing-dependency":
        return "low";
      case "gate-blocked":
        return "low";
      default: {
        const exhaustive: never = type;
        throw new PlanBlockageAnalyzerError("invalid-request", `未支持的 BlockageType 值：${String(exhaustive)}`);
      }
    }
  }
}
