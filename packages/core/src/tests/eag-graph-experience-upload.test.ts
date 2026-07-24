/**
 * EAG-Graph 经验上送与召回单元测试（Phase 4，对齐设计文档 §13.12.3）
 *
 * 测试范围：
 * - U1.* DefaultNodeExperienceUploader.uploadExperiences 单元测试（6 个）
 *   - U1.1 正常上送 completed 节点的经验（四路写入均生效）
 *   - U1.2 failed 节点不持久化到 ExperienceStore
 *   - U1.3 无 loopReport 时不提取经验（降级）
 *   - U1.4 无决策时不污染 bulletinBoard（空决策降级）
 *   - U1.5 bulletinBoard 超 20 条触发 FIFO
 *   - U1.6 条目不可变性（deepFreeze 生效）
 * - U3.* recallExperiences 单元测试（5 个）
 *   - U3.1 sameRun 排除自身经验
 *   - U3.2 历史经验与同运行经验合并去重（experienceId 去重）
 *   - U3.3 合并后按定义的排序键排列（历史优先 + 同运行次之）
 *   - U3.4 limit=10 截断
 *   - U3.5 ExperienceStore 空时仅返回 sameRun（降级）
 * - U4.* 滑动窗口截断单元测试（4 个）
 *   - U4.1 bulletinBoard 21 条触发 FIFO
 *   - U4.2 collectedExperiences 51 条触发 slice(-50)
 *   - U4.3 nodeSummaries 超 50 个触发截断
 *   - U4.4 deepFreeze 后数组不可变（递归冻结验证）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实闭包实现和真实类型实例
 * - 测试替身命名禁用 Mock 前缀，统一用 Stub / Silent / InMemory
 * - 每个测试用例独立，无共享可变状态
 * - 中文注释详细，符合规范
 *
 * 设计依据：
 * - LOOP-GRAPH-FUSION-DESIGN.md §13.12.3 U1.* / U3.* / U4.* 测试用例
 * - LOOP-GRAPH-FUSION-DESIGN.md §13.6.2 / §13.6.3 经验上送与召回
 * - LOOP-GRAPH-FUSION-DESIGN.md §13.11.1 / §13.11.3 滑动窗口截断
 * - eag/graph/graph-context-helpers.ts 源文件（被测对象）
 * - eag/graph/graph-loop-models.ts 类型定义
 * - eag/graph/graph-loop-protocols.ts 协议定义
 *
 * @module core/tests/eag-graph-experience-upload
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DefaultNodeExperienceUploader, deepFreeze, recallExperiences } from "../eag/graph/graph-context-helpers";
import { DEFAULT_WORK_GRAPH_CONFIG, getGraphGlobalContext } from "../eag/graph/graph-loop-models";
import type {
  /** 图运行上下文 */
  GraphRunContext,
  /** 图节点执行结果 */
  GraphNodeResult,
  /** 图级全局上下文（Layer 0） */
  GraphGlobalContext,
  /** 图级经验条目 */
  GraphExperienceEntry,
  /** 动向广播条目 */
  BulletinEntry,
  /** 节点执行摘要 */
  NodeSummary,
  /** 经验案例（ExperienceStore 存储） */
  ExperienceCase,
  /** 图日志记录器接口 */
  GraphLogger,
  /** 谓词注册表接口 */
  PredicateRegistry,
} from "../eag/graph/graph-loop-models";
import type {
  /** 经验存储协议 */
  ExperienceStoreProtocol,
} from "../eag/graph/graph-loop-protocols";
import type {
  /** Loop 运行报告 */
  LoopRunReport,
  /** Loop 统一事件模型 */
  LoopEvent,
  /** Loop 事件类型 */
  LoopEventType,
} from "../eag/loop/models";
import { PredicateRegistryImpl } from "../eag/graph/predicate-registry";

// ============================================================================
// 辅助：构造测试数据
// ============================================================================

/**
 * 创建不输出日志的 GraphLogger（测试用，避免噪音）
 *
 * @returns 静默日志器实例（所有方法均为空函数）
 */
function makeSilentLogger(): GraphLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * 构造一个 LoopEvent 测试数据
 *
 * @param overrides 字段覆盖（可选）
 * @returns 完整的 LoopEvent 实例
 */
function makeLoopEvent(
  overrides?: Partial<LoopEvent> & {
    eventType?: LoopEventType;
    payload?: Record<string, unknown>;
  }
): LoopEvent {
  return {
    eventId: overrides?.eventId ?? "evt-001",
    eventType: overrides?.eventType ?? "verification_passed",
    phase: overrides?.phase ?? "verification",
    runId: overrides?.runId ?? "run-001",
    iterIndex: overrides?.iterIndex ?? 0,
    payload: overrides?.payload ?? { summary: "测试事件" },
    timestamp: overrides?.timestamp ?? "2026-07-23T00:00:00.000Z",
  };
}

/**
 * 构造一个 LoopRunReport 测试数据
 *
 * @param overrides 字段覆盖（可选）
 * @returns 完整的 LoopRunReport 实例
 */
function makeLoopReport(overrides?: Partial<LoopRunReport> & { events?: LoopEvent[] }): LoopRunReport {
  return {
    runId: overrides?.runId ?? "run-001",
    loopType: overrides?.loopType ?? "coding",
    objective: overrides?.objective ?? "测试目标",
    totalIterations: overrides?.totalIterations ?? 1,
    finalStatus: overrides?.finalStatus ?? "completed",
    events: overrides?.events ?? [],
    tokenUsed: overrides?.tokenUsed ?? 100,
    durationSec: overrides?.durationSec ?? 10,
    committedCount: overrides?.committedCount ?? 0,
    humanCheckpoints: overrides?.humanCheckpoints ?? [],
    finalSummary: overrides?.finalSummary ?? "测试摘要",
  };
}

/**
 * 构造一个 GraphNodeResult 测试数据
 *
 * @param overrides 字段覆盖（可选）
 * @returns 完整的 GraphNodeResult 实例
 */
function makeGraphNodeResult(overrides?: Partial<GraphNodeResult>): GraphNodeResult {
  return {
    nodeId: overrides?.nodeId ?? "node-001",
    nodeType: overrides?.nodeType ?? "loop",
    status: overrides?.status ?? "completed",
    output: overrides?.output ?? { result: "done" },
    loopReport: overrides?.loopReport,
    durationSec: overrides?.durationSec ?? 1.5,
    failureReason: overrides?.failureReason,
    retryCount: overrides?.retryCount ?? 0,
  };
}

/**
 * 构造一个图级全局状态对象（作为 GraphRunContext.globalState，符合 GraphGlobalContext 视图）
 *
 * @param overrides 字段覆盖（可选）
 * @returns 包含 GraphGlobalContext 字段的 globalState 对象
 */
function makeGraphGlobalState(overrides?: Partial<GraphGlobalContext>): Record<string, unknown> {
  return {
    projectGoal: overrides?.projectGoal ?? "测试项目目标",
    projectRoot: overrides?.projectRoot ?? "/test",
    globalConstraints: overrides?.globalConstraints ?? [],
    collectedExperiences: overrides?.collectedExperiences ?? [],
    bulletinBoard: overrides?.bulletinBoard ?? [],
    nodeSummaries: overrides?.nodeSummaries ?? new Map<string, NodeSummary>(),
    runId: overrides?.runId ?? "run-001",
    graphId: overrides?.graphId ?? "graph-001",
    createdAt: overrides?.createdAt ?? "2026-07-23T00:00:00.000Z",
    lastUpdatedAt: overrides?.lastUpdatedAt,
  };
}

/**
 * 构造一个 GraphRunContext 测试数据
 *
 * @param overrides 字段覆盖（可选，globalState / graphId / runId / predicateRegistry）
 * @returns 完整的 GraphRunContext 实例
 */
function makeGraphRunContext(overrides?: {
  globalState?: Record<string, unknown>;
  graphId?: string;
  runId?: string;
  predicateRegistry?: PredicateRegistry;
}): GraphRunContext {
  return {
    runId: overrides?.runId ?? "run-001",
    graphId: overrides?.graphId ?? "graph-001",
    globalState: overrides?.globalState ?? makeGraphGlobalState(),
    visited: new Set<string>(),
    nodeResults: new Map<string, GraphNodeResult>(),
    cancelled: false,
    config: DEFAULT_WORK_GRAPH_CONFIG,
    predicateRegistry: overrides?.predicateRegistry ?? new PredicateRegistryImpl(),
    currentDepth: 0,
    totalTokensUsed: 0,
    startedAtMs: Date.now(),
  };
}

/**
 * 构造一个 GraphExperienceEntry 测试数据
 *
 * @param overrides 字段覆盖（可选）
 * @returns 完整的 GraphExperienceEntry 实例
 */
function makeExperienceEntry(overrides?: Partial<GraphExperienceEntry>): GraphExperienceEntry {
  return {
    experienceId: overrides?.experienceId ?? "exp-001",
    sourceNodeId: overrides?.sourceNodeId ?? "node-001",
    type: overrides?.type ?? "success",
    taskType: overrides?.taskType ?? "coding",
    description: overrides?.description ?? "测试经验",
    solution: overrides?.solution,
    failureReason: overrides?.failureReason,
    lessonLearned: overrides?.lessonLearned,
    createdAt: overrides?.createdAt ?? "2026-07-23T00:00:00.000Z",
  };
}

/**
 * 构造一个 BulletinEntry 测试数据
 *
 * @param overrides 字段覆盖（可选）
 * @returns 完整的 BulletinEntry 实例
 */
function makeBulletinEntry(overrides?: Partial<BulletinEntry>): BulletinEntry {
  return {
    entryId: overrides?.entryId ?? "bul-001",
    sourceNodeId: overrides?.sourceNodeId ?? "node-001",
    type: overrides?.type ?? "decision",
    summary: overrides?.summary ?? "测试决策",
    details: overrides?.details,
    timestamp: overrides?.timestamp ?? "2026-07-23T00:00:00.000Z",
  };
}

// ============================================================================
// InMemoryExperienceStore：内存版经验存储实现（测试替身）
// ============================================================================

/**
 * 内存版经验存储实现（测试替身，不依赖文件系统）
 *
 * 实现 ExperienceStoreProtocol，使用 Map 存储案例。
 * recallSimilar 使用 Jaccard 相似度（离散特征）按相似度降序返回。
 *
 * 设计要点：
 * - 不依赖文件系统，纯内存存储
 * - recallSimilar 按相似度降序排序，相似度相同的按插入顺序（稳定排序）
 * - 过滤相似度=0 的案例（避免无关案例污染召回结果）
 * - 提供 size() 方法用于断言持久化次数
 */
class InMemoryExperienceStore implements ExperienceStoreProtocol {
  /** 案例存储（按 caseId 索引） */
  private readonly cases = new Map<string, ExperienceCase>();
  /** 案例插入顺序（用于稳定排序和 FIFO 淘汰） */
  private readonly insertionOrder: string[] = [];

  /**
   * 查询相似案例（按 Jaccard 相似度降序返回）
   *
   * @param taskFeatures 查询任务特征
   * @param limit 返回案例数上限
   * @returns 相似案例列表（按相似度降序，相似度=0 的被过滤）
   */
  async recallSimilar(
    taskFeatures: Readonly<Record<string, unknown>>,
    limit: number
  ): Promise<ReadonlyArray<ExperienceCase>> {
    // 按插入顺序计算相似度（保证稳定排序）
    const scored = this.insertionOrder.map((caseId, idx) => {
      const caseData = this.cases.get(caseId)!;
      return {
        caseData,
        similarity: this.computeJaccard(taskFeatures, caseData.taskFeatures),
        insertIndex: idx,
      };
    });

    // 过滤相似度=0 的案例（避免无关案例污染召回结果）
    const filtered = scored.filter((s) => s.similarity > 0);

    // 按相似度降序排序（相似度相同的按插入顺序，稳定排序）
    filtered.sort((a, b) => {
      if (b.similarity !== a.similarity) {
        return b.similarity - a.similarity;
      }
      return a.insertIndex - b.insertIndex;
    });

    // 取前 limit 个
    return filtered.slice(0, limit).map((s) => s.caseData);
  }

  /**
   * 写入新案例
   *
   * @param caseData 经验案例
   */
  async storeCase(caseData: Readonly<ExperienceCase>): Promise<void> {
    const caseId = caseData.caseId;
    if (!this.cases.has(caseId)) {
      this.insertionOrder.push(caseId);
    }
    this.cases.set(caseId, caseData);
  }

  /**
   * 获取当前案例库大小（用于断言持久化次数）
   *
   * @returns 案例数量
   */
  size(): number {
    return this.cases.size;
  }

  /**
   * 计算 Jaccard 相似度（离散特征）
   *
   * Jaccard = |交集| / |并集|，按字段等值匹配计算。
   *
   * @param query 查询特征
   * @param candidate 候选案例特征
   * @returns 相似度 [0, 1]
   */
  private computeJaccard(
    query: Readonly<Record<string, unknown>>,
    candidate: Readonly<Record<string, unknown>>
  ): number {
    const allKeys = new Set([...Object.keys(query), ...Object.keys(candidate)]);
    if (allKeys.size === 0) {
      return 0;
    }
    let intersection = 0;
    let union = 0;
    for (const key of allKeys) {
      union++;
      if (query[key] === candidate[key]) {
        intersection++;
      }
    }
    return union > 0 ? intersection / union : 0;
  }
}

// ============================================================================
// U1.* uploadExperiences 单元测试
// ============================================================================

test("U1.1 正常上送 completed 节点的经验（四路写入均生效）", async () => {
  // 构造 loopReport：1 条 verification_passed（→ success 经验）+ 1 条 loop_failed（→ failure 经验 + blocker bulletin）
  // 注：verification_passed 不产生 bulletin，loop_failed 同时产生经验与 bulletin
  const loopReport = makeLoopReport({
    events: [
      makeLoopEvent({
        eventId: "evt-vp-1",
        eventType: "verification_passed",
        payload: { summary: "验证通过", strategy: "strict-evaluator" },
        timestamp: "2026-07-23T00:00:01.000Z",
      }),
      makeLoopEvent({
        eventId: "evt-lf-1",
        eventType: "loop_failed",
        payload: { summary: "Loop 失败", reason: "迭代超限", lesson: "应减少迭代" },
        timestamp: "2026-07-23T00:00:02.000Z",
      }),
    ],
  });

  const nodeResult = makeGraphNodeResult({
    nodeId: "node-completed",
    status: "completed",
    loopReport,
  });

  const context = makeGraphRunContext();
  const store = new InMemoryExperienceStore();
  const uploader = new DefaultNodeExperienceUploader(store, "/test");

  // 执行上送
  await uploader.uploadExperiences("node-completed", nodeResult, context);

  // 通过 getGraphGlobalContext 工具函数读取 GraphGlobalContext 视图
  const globalCtx = getGraphGlobalContext(context);

  // 验证 1：collectedExperiences 新增 2 条（1 success + 1 failure）
  assert.equal(globalCtx.collectedExperiences?.length, 2, "collectedExperiences 应新增 2 条");
  assert.equal(globalCtx.collectedExperiences![0].type, "success", "第 1 条应为 success 经验（verification_passed）");
  assert.equal(globalCtx.collectedExperiences![1].type, "failure", "第 2 条应为 failure 经验（loop_failed）");

  // 验证 2：bulletinBoard 新增 1 条（loop_failed → blocker bulletin）
  assert.equal(globalCtx.bulletinBoard?.length, 1, "bulletinBoard 应新增 1 条");
  assert.equal(globalCtx.bulletinBoard![0].type, "blocker", "应为 blocker 类型（loop_failed 触发）");

  // 验证 3：nodeSummaries 新增 1 条
  assert.equal(globalCtx.nodeSummaries?.size, 1, "nodeSummaries 应新增 1 条");
  assert.ok(globalCtx.nodeSummaries!.has("node-completed"), "应包含 node-completed 摘要");

  // 验证 4：experienceStore.size() 递增 2（仅 completed 节点持久化，2 条经验均 storeCase）
  assert.equal(store.size(), 2, "experienceStore 应递增 2（completed 节点的 2 条经验均持久化）");
});

test("U1.2 failed 节点不持久化到 ExperienceStore", async () => {
  // 构造 failed 节点的 loopReport（含 loop_failed 事件）
  const loopReport = makeLoopReport({
    finalStatus: "failed",
    events: [
      makeLoopEvent({
        eventId: "evt-lf-1",
        eventType: "loop_failed",
        payload: { summary: "Loop 失败", reason: "迭代超限" },
        timestamp: "2026-07-23T00:00:01.000Z",
      }),
    ],
  });

  const nodeResult = makeGraphNodeResult({
    nodeId: "node-failed",
    status: "failed",
    loopReport,
    failureReason: "节点失败",
  });

  const context = makeGraphRunContext();
  const store = new InMemoryExperienceStore();
  const uploader = new DefaultNodeExperienceUploader(store, "/test");

  await uploader.uploadExperiences("node-failed", nodeResult, context);

  const globalCtx = getGraphGlobalContext(context);

  // 验证：collectedExperiences 仍 push（failed 节点经验在图内可见，不持久化但写入图级池）
  assert.ok(
    (globalCtx.collectedExperiences?.length ?? 0) > 0,
    "collectedExperiences 应有 push（failed 节点经验在图内可见）"
  );

  // 验证：experienceStore.size() 不变（failed 节点不持久化）
  assert.equal(store.size(), 0, "experienceStore 应不变（failed 节点不持久化）");
});

test("U1.3 无 loopReport 时不提取经验（降级）", async () => {
  // 构造无 loopReport 的节点结果（task 节点或非 loop 节点）
  const nodeResult = makeGraphNodeResult({
    nodeId: "node-no-loop",
    status: "completed",
    loopReport: undefined,
  });

  const context = makeGraphRunContext();
  const store = new InMemoryExperienceStore();
  const uploader = new DefaultNodeExperienceUploader(store, "/test");

  await uploader.uploadExperiences("node-no-loop", nodeResult, context);

  const globalCtx = getGraphGlobalContext(context);

  // 验证：collectedExperiences 不变（无 loopReport 不提取经验）
  assert.equal(globalCtx.collectedExperiences?.length, 0, "collectedExperiences 应不变（无 loopReport）");

  // 验证：bulletinBoard 不变（无 loopReport 不提取决策）
  assert.equal(globalCtx.bulletinBoard?.length, 0, "bulletinBoard 应不变（无 loopReport）");

  // 验证：nodeSummaries 仍写入（不依赖 loopReport，由 nodeResult.output 生成摘要）
  assert.equal(globalCtx.nodeSummaries?.size, 1, "nodeSummaries 应仍写入");
  assert.ok(globalCtx.nodeSummaries!.has("node-no-loop"), "应包含 node-no-loop 摘要");

  // 验证：experienceStore 不持久化（无经验可存）
  assert.equal(store.size(), 0, "experienceStore 应不变（无经验可存）");
});

test("U1.4 无决策时不污染 bulletinBoard（空决策降级）", async () => {
  // loopReport 只含 verification_passed 事件（产生经验但不产生 bulletin）
  // adaptDecisionsFromLoopReport 对 verification_passed 返回 null → bulletinBoard 不新增
  const loopReport = makeLoopReport({
    events: [
      makeLoopEvent({
        eventId: "evt-vp-1",
        eventType: "verification_passed",
        payload: { summary: "验证通过", strategy: "strict-evaluator" },
        timestamp: "2026-07-23T00:00:01.000Z",
      }),
    ],
  });

  const nodeResult = makeGraphNodeResult({
    nodeId: "node-no-decision",
    status: "completed",
    loopReport,
  });

  const context = makeGraphRunContext();
  const uploader = new DefaultNodeExperienceUploader(undefined, "/test");

  await uploader.uploadExperiences("node-no-decision", nodeResult, context);

  const globalCtx = getGraphGlobalContext(context);

  // 验证：bulletinBoard 不新增（verification_passed 不产生 bulletin）
  assert.equal(globalCtx.bulletinBoard?.length, 0, "bulletinBoard 应不新增（无决策事件）");

  // 验证：nodeSummaries.keyDecisions=[]（adaptDecisionsFromLoopReport 返回 []，映射为空数组）
  const summary = globalCtx.nodeSummaries?.get("node-no-decision");
  assert.ok(summary, "应包含 node-no-decision 摘要");
  assert.deepEqual(summary!.keyDecisions, [], "keyDecisions 应为空数组（无决策）");

  // 验证：collectedExperiences 仍写入（verification_passed 产生 success 经验）
  assert.equal(globalCtx.collectedExperiences?.length, 1, "collectedExperiences 应有 1 条（verification_passed 经验）");
});

test("U1.5 bulletinBoard 超 20 条触发 FIFO", async () => {
  const context = makeGraphRunContext();
  const globalCtx = getGraphGlobalContext(context);

  // 预置 18 条 bulletin（按时间升序，最早的 bul-pre-0）
  const preexistingBulletins: BulletinEntry[] = [];
  for (let i = 0; i < 18; i++) {
    preexistingBulletins.push(
      makeBulletinEntry({
        entryId: `bul-pre-${i}`,
        sourceNodeId: `node-pre-${i}`,
        summary: `预置决策 ${i}`,
        timestamp: `2026-07-23T00:00:${String(i).padStart(2, "0")}.000Z`,
      })
    );
  }
  globalCtx.bulletinBoard = preexistingBulletins;

  // 构造 loopReport：5 个 scheduling_decision 事件（每个产生 1 条 decision bulletin）
  const events: LoopEvent[] = [];
  for (let i = 0; i < 5; i++) {
    events.push(
      makeLoopEvent({
        eventId: `evt-sd-${i}`,
        eventType: "scheduling_decision",
        payload: { summary: `调度决策 ${i}`, decision: `decision-${i}` },
        timestamp: `2026-07-23T00:01:${String(i).padStart(2, "0")}.000Z`,
      })
    );
  }
  const loopReport = makeLoopReport({ events });
  const nodeResult = makeGraphNodeResult({
    nodeId: "node-fifo",
    status: "completed",
    loopReport,
  });

  // 执行上送：18 + 5 = 23 条，FIFO 截断到 20 条（丢弃最早 3 条）
  const uploader = new DefaultNodeExperienceUploader(undefined, "/test");
  await uploader.uploadExperiences("node-fifo", nodeResult, context);

  // 验证：bulletinBoard.length===20（FIFO 截断）
  assert.equal(globalCtx.bulletinBoard?.length, 20, "bulletinBoard 应为 20 条（FIFO 截断）");

  // 验证：丢弃最早 3 条（bul-pre-0, bul-pre-1, bul-pre-2）
  const remainingIds = globalCtx.bulletinBoard!.map((b) => b.entryId);
  assert.ok(!remainingIds.includes("bul-pre-0"), "应丢弃 bul-pre-0（最早）");
  assert.ok(!remainingIds.includes("bul-pre-1"), "应丢弃 bul-pre-1");
  assert.ok(!remainingIds.includes("bul-pre-2"), "应丢弃 bul-pre-2");

  // 验证：保留 bul-pre-3 及之后条目
  assert.ok(remainingIds.includes("bul-pre-3"), "应保留 bul-pre-3");
  assert.ok(remainingIds.includes("bul-pre-17"), "应保留 bul-pre-17（预置最后一条）");

  // 验证：新写入的 5 条 bulletin 均保留（在截断窗口内）
  const newNodeBulletins = globalCtx.bulletinBoard!.filter((b) => b.sourceNodeId === "node-fifo");
  assert.equal(newNodeBulletins.length, 5, "新写入的 5 条 bulletin 应均保留");
});

test("U1.6 条目不可变性（deepFreeze 生效）", async () => {
  // 构造 loopReport：2 条 scheduling_decision（→ 2 条 bulletin）+ 2 条 verification_passed（→ 2 条经验）
  // 多条事件用于验证“所有条目均已冻结”，而非仅最后一条
  const loopReport = makeLoopReport({
    events: [
      makeLoopEvent({
        eventId: "evt-sd-1",
        eventType: "scheduling_decision",
        payload: { summary: "测试决策 1", decision: "dec-1" },
        timestamp: "2026-07-23T00:00:01.000Z",
      }),
      makeLoopEvent({
        eventId: "evt-sd-2",
        eventType: "scheduling_decision",
        payload: { summary: "测试决策 2", decision: "dec-2" },
        timestamp: "2026-07-23T00:00:02.000Z",
      }),
      makeLoopEvent({
        eventId: "evt-vp-1",
        eventType: "verification_passed",
        payload: { summary: "验证通过 1", strategy: "strict-1" },
        timestamp: "2026-07-23T00:00:03.000Z",
      }),
      makeLoopEvent({
        eventId: "evt-vp-2",
        eventType: "verification_passed",
        payload: { summary: "验证通过 2", strategy: "strict-2" },
        timestamp: "2026-07-23T00:00:04.000Z",
      }),
    ],
  });

  // 预置 2 条已冻结的历史经验 + 2 条已冻结的历史 bulletin，验证“预置条目也保持冻结”
  // 设计意图：U1.6 扩展断言要求验证所有条目均已冻结，包括上送前已存在的条目
  // DefaultNodeExperienceUploader 在 push 前对新条目调用 deepFreeze，
  // 但预置条目本身的冻结状态由调用方负责（本测试预置时显式 deepFreeze）
  const nodeResult = makeGraphNodeResult({
    nodeId: "node-freeze",
    status: "completed",
    loopReport,
  });

  const preExistingExperiences: GraphExperienceEntry[] = [
    deepFreeze(
      makeExperienceEntry({
        experienceId: "exp-pre-1",
        sourceNodeId: "node-pre-1",
        createdAt: "2026-07-23T00:00:00.000Z",
      })
    ),
    deepFreeze(
      makeExperienceEntry({
        experienceId: "exp-pre-2",
        sourceNodeId: "node-pre-2",
        createdAt: "2026-07-23T00:00:00.500Z",
      })
    ),
  ];
  const preExistingBulletins: BulletinEntry[] = [
    deepFreeze(
      makeBulletinEntry({
        entryId: "bul-pre-1",
        sourceNodeId: "node-pre-1",
        summary: "预置决策 1",
        timestamp: "2026-07-23T00:00:00.000Z",
      })
    ),
    deepFreeze(
      makeBulletinEntry({
        entryId: "bul-pre-2",
        sourceNodeId: "node-pre-2",
        summary: "预置决策 2",
        timestamp: "2026-07-23T00:00:00.500Z",
      })
    ),
  ];

  const context = makeGraphRunContext({
    globalState: makeGraphGlobalState({
      collectedExperiences: preExistingExperiences,
      bulletinBoard: preExistingBulletins,
    }),
  });
  const uploader = new DefaultNodeExperienceUploader(undefined, "/test");

  await uploader.uploadExperiences("node-freeze", nodeResult, context);

  const globalCtx = getGraphGlobalContext(context);

  // ----------------------------------------------------------------------
  // L1 扩展断言 1：所有 bulletinBoard 条目均已冻结（不只最后一条）
  // ----------------------------------------------------------------------
  const bulletins = globalCtx.bulletinBoard ?? [];
  assert.ok(bulletins.length >= 4, `bulletinBoard 应至少有 4 条（2 预置 + 2 新增），实际 ${bulletins.length} 条`);
  for (let i = 0; i < bulletins.length; i++) {
    assert.equal(
      Object.isFrozen(bulletins[i]),
      true,
      `bulletinBoard[${i}] 应已冻结（entryId=${bulletins[i].entryId}）`
    );
    // 验证嵌套字段不可写（deepFreeze 递归生效）
    assert.throws(
      () => {
        // @ts-expect-error 测试不可变性：故意写入只读字段
        bulletins[i].summary = "modified";
      },
      /Cannot assign to read only property|not extensible|read only/i,
      `bulletinBoard[${i}].summary 应不可写（deepFreeze 递归冻结字段）`
    );
  }

  // ----------------------------------------------------------------------
  // L1 扩展断言 2：所有 collectedExperiences 条目均已冻结（不只最后一条）
  // ----------------------------------------------------------------------
  const experiences = globalCtx.collectedExperiences ?? [];
  assert.ok(
    experiences.length >= 4,
    `collectedExperiences 应至少有 4 条（2 预置 + 2 新增），实际 ${experiences.length} 条`
  );
  for (let i = 0; i < experiences.length; i++) {
    assert.equal(
      Object.isFrozen(experiences[i]),
      true,
      `collectedExperiences[${i}] 应已冻结（experienceId=${experiences[i].experienceId}）`
    );
    // 验证嵌套字段不可写（deepFreeze 递归生效）
    assert.throws(
      () => {
        // @ts-expect-error 测试不可变性：故意写入只读字段
        experiences[i].description = "modified";
      },
      /Cannot assign to read only property|not extensible|read only/i,
      `collectedExperiences[${i}].description 应不可写（deepFreeze 递归冻结字段）`
    );
  }

  // ----------------------------------------------------------------------
  // L1 扩展断言 3：所有 nodeSummaries 条目均已冻结（多节点场景）
  // ----------------------------------------------------------------------
  // 预置 1 个历史节点摘要 + 本次上送 1 个新节点摘要 → 至少 2 个
  const summaries = globalCtx.nodeSummaries ?? new Map();
  assert.ok(summaries.size >= 1, `nodeSummaries 应至少有 1 个（本次上送），实际 ${summaries.size} 个`);
  for (const [nodeId, summary] of summaries) {
    assert.equal(Object.isFrozen(summary), true, `nodeSummaries.get(${nodeId}) 应已冻结`);
    // 验证嵌套数组不可写（keyDecisions 数组应被递归冻结）
    assert.throws(
      () => {
        // @ts-expect-error 测试不可变性：故意写入只读字段
        summary.outputSummary = "modified";
      },
      /Cannot assign to read only property|not extensible|read only/i,
      `nodeSummaries.get(${nodeId}).outputSummary 应不可写（deepFreeze 递归冻结字段）`
    );
    // 验证 keyDecisions 数组本身已冻结
    assert.equal(
      Object.isFrozen(summary.keyDecisions),
      true,
      `nodeSummaries.get(${nodeId}).keyDecisions 数组应已冻结（deepFreeze 递归冻结数组）`
    );
  }

  // ----------------------------------------------------------------------
  // L1 扩展断言 4：预置条目仍保持冻结状态（不被新上送破坏）
  // ----------------------------------------------------------------------
  const preExp1 = experiences.find((e) => e.experienceId === "exp-pre-1");
  assert.ok(preExp1, "应找到预置经验 exp-pre-1");
  assert.equal(Object.isFrozen(preExp1), true, "预置经验 exp-pre-1 应保持冻结");

  const preBul1 = bulletins.find((b) => b.entryId === "bul-pre-1");
  assert.ok(preBul1, "应找到预置 bulletin bul-pre-1");
  assert.equal(Object.isFrozen(preBul1), true, "预置 bulletin bul-pre-1 应保持冻结");
});

// ============================================================================
// U3.* recallExperiences 单元测试
// ============================================================================

test("U3.1 sameRun 排除自身经验", async () => {
  const currentNodeId = "current-node";

  // sameRun 含 3 条（1 条 sourceNodeId===currentNodeId，应被过滤）
  const sameRun: GraphExperienceEntry[] = [
    makeExperienceEntry({
      experienceId: "E1",
      sourceNodeId: "other-node-1",
      createdAt: "2026-07-23T00:00:01.000Z",
    }),
    makeExperienceEntry({
      experienceId: "E2",
      sourceNodeId: currentNodeId, // 自身经验，应被过滤
      createdAt: "2026-07-23T00:00:02.000Z",
    }),
    makeExperienceEntry({
      experienceId: "E3",
      sourceNodeId: "other-node-2",
      createdAt: "2026-07-23T00:00:03.000Z",
    }),
  ];

  const context = makeGraphRunContext({
    globalState: makeGraphGlobalState({ collectedExperiences: sameRun }),
  });

  // 不传 experienceStore（仅测试 sameRun 过滤逻辑）
  const result = await recallExperiences(currentNodeId, "task", context);

  // 验证：返回 2 条（排除自身）
  assert.equal(result.length, 2, "应返回 2 条（排除自身经验）");

  // 验证：不含自身（experienceId !== "E2"）
  const ids = result.map((e) => e.experienceId);
  assert.ok(!ids.includes("E2"), "不应包含自身经验 E2");
  assert.ok(ids.includes("E1"), "应包含 E1");
  assert.ok(ids.includes("E3"), "应包含 E3");
});

test("U3.2 历史经验与同运行经验合并去重（experienceId 去重）", async () => {
  const currentNodeId = "current-node";
  const task = "coding-task";

  // sameRun 含 experienceId="E1"
  const sameRun: GraphExperienceEntry[] = [
    makeExperienceEntry({
      experienceId: "E1",
      sourceNodeId: "other-node",
      createdAt: "2026-07-23T00:00:01.000Z",
    }),
  ];

  const context = makeGraphRunContext({
    globalState: makeGraphGlobalState({ collectedExperiences: sameRun }),
  });

  // historical 含 caseId="E1"（adaptExperienceCase 转换后 experienceId="E1"）和 caseId="E2"
  // recallExperiences 内部调用 recallSimilar({ taskType: task, nodeId: currentNodeId }, 5)
  // 所以查询 taskFeatures = { taskType: "coding-task", nodeId: "current-node" }
  const queryFeatures = { taskType: task, nodeId: currentNodeId };
  const store = new InMemoryExperienceStore();
  await store.storeCase({
    caseId: "E1",
    taskType: "coding",
    taskFeatures: queryFeatures,
    strategy: "strategy-1",
    success: true,
    executionTimeSec: 10,
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  await store.storeCase({
    caseId: "E2",
    taskType: "coding",
    taskFeatures: queryFeatures,
    strategy: "strategy-2",
    success: true,
    executionTimeSec: 20,
    createdAt: "2026-07-22T00:00:00.000Z",
  });

  const result = await recallExperiences(currentNodeId, task, context, store);

  // 验证：返回列表中"E1"只出现 1 次（来自 sameRun，historical 中的 E1 被去重过滤）
  const e1Count = result.filter((e) => e.experienceId === "E1").length;
  assert.equal(e1Count, 1, "E1 应只出现 1 次（experienceId 去重）");

  // 验证：E2 出现 1 次（来自 historical，未被去重）
  const e2Count = result.filter((e) => e.experienceId === "E2").length;
  assert.equal(e2Count, 1, "E2 应出现 1 次（来自历史经验）");
});

/**
 * U3.2b taskType::description 语义去重场景（L2 修复）
 *
 * 验证点（§13.6.3 架构师 M-1）：
 * - 当 historical 经验与 sameRun 经验具有相同的 taskType::description 语义键
 *   但 experienceId 不同时（experienceId 去重无法过滤）
 * - recallExperiences 应按语义键去重，过滤掉 historical 中的相似经验
 * - 避免重试场景产生相似经验污染上下文
 *
 * 场景设计：
 * - sameRun 含 1 条经验 S1（taskType="coding", description="登录功能实现"）
 * - historical 含 2 条经验：
 *   - H1：experienceId="H1"，taskType="coding", description="登录功能实现"
 *     （与 S1 语义键相同，应被语义去重过滤）
 *   - H2：experienceId="H2"，taskType="coding", description="支付功能实现"
 *     （与 S1 语义键不同，应保留）
 * - 验证结果：含 S1 和 H2，不含 H1
 *
 * 注意：H1 的 experienceId="H1" 与 S1 的 experienceId="S1" 不同，
 *       experienceId 去重无法过滤 H1，只能依赖语义去重逻辑
 */
test("U3.2b taskType::description 语义去重（相同语义键不同 experienceId）", async () => {
  const currentNodeId = "current-node";
  const task = "coding-task";
  const queryFeatures = { taskType: task, nodeId: currentNodeId };

  // 1. sameRun 含 1 条经验 S1（taskType="coding", description="登录功能实现"）
  const sameRun: GraphExperienceEntry[] = [
    makeExperienceEntry({
      experienceId: "S1",
      sourceNodeId: "other-node",
      taskType: "coding",
      description: "登录功能实现",
      createdAt: "2026-07-23T00:00:01.000Z",
    }),
  ];

  const context = makeGraphRunContext({
    globalState: makeGraphGlobalState({ collectedExperiences: sameRun }),
  });

  // 2. historical 含 2 条经验：
  //    - H1：与 S1 语义键相同（taskType="coding", description="登录功能实现"），应被语义去重
  //    - H2：与 S1 语义键不同（taskType="coding", description="支付功能实现"），应保留
  //
  //    关键设计：adaptExperienceCase 在 success=true 时使用 strategy 作为 description
  //    所以让 H1.strategy === S1.description，使 H1 转换后的语义键与 S1 相同
  //    而 H2.strategy 与 S1.description 不同，语义键不同
  const store = new InMemoryExperienceStore();
  // H1：strategy="登录功能实现"（与 S1 的 description 相同），success=true
  //     adaptExperienceCase 转换后：description = strategy = "登录功能实现"
  //     语义键 = "coding::登录功能实现" === S1 的语义键 → 应被去重
  await store.storeCase({
    caseId: "H1",
    taskType: "coding",
    taskFeatures: queryFeatures,
    strategy: "登录功能实现",
    success: true,
    executionTimeSec: 10,
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  // H2：strategy="支付功能实现"（与 S1 的 description 不同），success=true
  //     adaptExperienceCase 转换后：description = strategy = "支付功能实现"
  //     语义键 = "coding::支付功能实现" ≠ S1 的语义键 → 应保留
  await store.storeCase({
    caseId: "H2",
    taskType: "coding",
    taskFeatures: queryFeatures,
    strategy: "支付功能实现",
    success: true,
    executionTimeSec: 20,
    createdAt: "2026-07-22T00:00:00.000Z",
  });

  // 3. 调用 recallExperiences（limit=10，足够容纳所有经验）
  const result = await recallExperiences(currentNodeId, task, context, store, 10);

  // 4. 验证：返回结果含 S1 和 H2，不含 H1（语义去重）
  const resultIds = result.map((e) => e.experienceId);
  assert.ok(resultIds.includes("S1"), `应包含 sameRun 经验 S1，实际结果=${resultIds.join(", ")}`);
  assert.ok(
    resultIds.includes("H2"),
    `应包含 historical 经验 H2（语义键不同，未被去重），实际结果=${resultIds.join(", ")}`
  );
  assert.ok(
    !resultIds.includes("H1"),
    `不应包含 historical 经验 H1（taskType::description 语义键与 S1 相同，应被去重），实际结果=${resultIds.join(", ")}`
  );

  // 5. 验证：返回结果恰好 2 条（S1 + H2）
  assert.equal(result.length, 2, `应返回 2 条经验（S1 + H2），实际 ${result.length} 条`);

  // 6. 前置验证：H1 的语义键确实与 S1 相同（确保测试场景正确）
  //    adaptExperienceCase(H1) 的 description = H1.strategy = "登录功能实现"
  const s1SemanticKey = `${sameRun[0].taskType}::${sameRun[0].description}`;
  const h1AdaptedDescription = "登录功能实现";
  const h1SemanticKey = `coding::${h1AdaptedDescription}`;
  assert.equal(
    s1SemanticKey,
    h1SemanticKey,
    `前置验证：S1 与 H1 的语义键应相同（${s1SemanticKey} === ${h1SemanticKey}）`
  );

  // 7. 前置验证：H2 的语义键与 S1 不同（确保测试场景正确）
  const h2AdaptedDescription = "支付功能实现";
  const h2SemanticKey = `coding::${h2AdaptedDescription}`;
  assert.notEqual(
    s1SemanticKey,
    h2SemanticKey,
    `前置验证：S1 与 H2 的语义键应不同（${s1SemanticKey} !== ${h2SemanticKey}）`
  );
});

test("U3.3 合并后按定义的排序键排列（历史优先 + 同运行次之）", async () => {
  const currentNodeId = "current-node";
  const task = "coding-task";
  // recallExperiences 内部查询 taskFeatures = { taskType: task, nodeId: currentNodeId }
  const queryFeatures = { taskType: task, nodeId: currentNodeId };

  // sameRun 5 条（createdAt 升序：S1 最早，S5 最新）
  // recallExperiences 内部按 createdAt 降序排序 → S5, S4, S3, S2, S1
  const sameRun: GraphExperienceEntry[] = [];
  for (let i = 1; i <= 5; i++) {
    sameRun.push(
      makeExperienceEntry({
        experienceId: `S${i}`,
        sourceNodeId: `other-node-${i}`,
        createdAt: `2026-07-23T00:00:0${i}.000Z`,
      })
    );
  }

  const context = makeGraphRunContext({
    globalState: makeGraphGlobalState({ collectedExperiences: sameRun }),
  });

  // historical 5 条（caseId="H1"-"H5"，按插入顺序）
  // recallSimilar 按 Jaccard 相似度降序返回（所有相似度=1.0，按插入顺序稳定排序）→ H1, H2, H3, H4, H5
  const store = new InMemoryExperienceStore();
  for (let i = 1; i <= 5; i++) {
    await store.storeCase({
      caseId: `H${i}`,
      taskType: "coding",
      taskFeatures: queryFeatures,
      strategy: `strategy-H${i}`,
      success: true,
      executionTimeSec: 10 * i,
      createdAt: `2026-07-22T00:00:0${i}.000Z`,
    });
  }

  // limit=10（合并后 historical 5 + sameRun 5 = 10 条，不截断）
  const result = await recallExperiences(currentNodeId, task, context, store, 10);

  // 验证：返回 10 条
  assert.equal(result.length, 10, "应返回 10 条");

  // 验证：前 5 条是历史经验（H1-H5，按插入顺序，相似度降序）
  const first5Ids = result.slice(0, 5).map((e) => e.experienceId);
  assert.deepEqual(first5Ids, ["H1", "H2", "H3", "H4", "H5"], "前 5 条应为历史经验 H1-H5（相似度降序 + 插入顺序）");

  // 验证：后 5 条是同运行经验（S5, S4, S3, S2, S1，按 createdAt 降序）
  const last5Ids = result.slice(5, 10).map((e) => e.experienceId);
  assert.deepEqual(last5Ids, ["S5", "S4", "S3", "S2", "S1"], "后 5 条应为同运行经验 S5-S1（createdAt 降序）");
});

test("U3.4 limit=10 截断", async () => {
  const currentNodeId = "current-node";
  const task = "coding-task";
  const queryFeatures = { taskType: task, nodeId: currentNodeId };

  // sameRun 8 条
  const sameRun: GraphExperienceEntry[] = [];
  for (let i = 1; i <= 8; i++) {
    sameRun.push(
      makeExperienceEntry({
        experienceId: `S${i}`,
        sourceNodeId: `other-node-${i}`,
        createdAt: `2026-07-23T00:00:0${i}.000Z`,
      })
    );
  }

  const context = makeGraphRunContext({
    globalState: makeGraphGlobalState({ collectedExperiences: sameRun }),
  });

  // historical 8 条（但 recallExperiences 内部 recallSimilar 受 HISTORICAL_RECALL_LIMIT=5 限制，只返回 5 条）
  const store = new InMemoryExperienceStore();
  for (let i = 1; i <= 8; i++) {
    await store.storeCase({
      caseId: `H${i}`,
      taskType: "coding",
      taskFeatures: queryFeatures,
      strategy: `strategy-H${i}`,
      success: true,
      executionTimeSec: 10 * i,
      createdAt: `2026-07-22T00:00:0${i}.000Z`,
    });
  }

  // limit=10（合并后 historical 5 + sameRun 8 = 13 条，slice(0,10) 截断到 10 条）
  const result = await recallExperiences(currentNodeId, task, context, store, 10);

  // 验证：返回 10 条（5 historical + 5 sameRun，slice(0,10) 截断）
  assert.equal(result.length, 10, "应返回 10 条（limit=10 截断）");

  // 验证：前 5 条是历史经验（受 HISTORICAL_RECALL_LIMIT=5 限制）
  const historicalCount = result.filter((e) => e.experienceId.startsWith("H")).length;
  assert.equal(historicalCount, 5, "历史经验应为 5 条（HISTORICAL_RECALL_LIMIT=5）");

  // 验证：后 5 条是同运行经验（slice 截断后只剩 5 条）
  const sameRunCount = result.filter((e) => e.experienceId.startsWith("S")).length;
  assert.equal(sameRunCount, 5, "同运行经验应为 5 条（slice 截断）");
});

test("U3.5 ExperienceStore 空时仅返回 sameRun（降级）", async () => {
  const currentNodeId = "current-node";

  // sameRun 3 条（createdAt 升序，降序后为 S3, S2, S1）
  const sameRun: GraphExperienceEntry[] = [
    makeExperienceEntry({
      experienceId: "S1",
      sourceNodeId: "other-node-1",
      createdAt: "2026-07-23T00:00:01.000Z",
    }),
    makeExperienceEntry({
      experienceId: "S2",
      sourceNodeId: "other-node-2",
      createdAt: "2026-07-23T00:00:02.000Z",
    }),
    makeExperienceEntry({
      experienceId: "S3",
      sourceNodeId: "other-node-3",
      createdAt: "2026-07-23T00:00:03.000Z",
    }),
  ];

  const context = makeGraphRunContext({
    globalState: makeGraphGlobalState({ collectedExperiences: sameRun }),
  });

  // experienceStore=undefined（降级：仅返回 sameRun）
  const result = await recallExperiences(currentNodeId, "task", context, undefined);

  // 验证：返回 sameRun 全部（3 条）
  assert.equal(result.length, 3, "应返回 sameRun 全部 3 条");

  // 验证：按 createdAt 降序排列（S3, S2, S1）
  const ids = result.map((e) => e.experienceId);
  assert.deepEqual(ids, ["S3", "S2", "S1"], "应按 createdAt 降序排列");
});

// ============================================================================
// U4.* 滑动窗口截断单元测试
// ============================================================================

test("U4.1 bulletinBoard 21 条触发 FIFO", async () => {
  const context = makeGraphRunContext();
  const globalCtx = getGraphGlobalContext(context);

  // 预置 20 条 bulletin（按时间升序，最早的 bul-pre-0）
  const preexisting: BulletinEntry[] = [];
  for (let i = 0; i < 20; i++) {
    preexisting.push(
      makeBulletinEntry({
        entryId: `bul-pre-${i}`,
        sourceNodeId: `node-pre-${i}`,
        summary: `预置决策 ${i}`,
        timestamp: `2026-07-23T00:00:${String(i).padStart(2, "0")}.000Z`,
      })
    );
  }
  globalCtx.bulletinBoard = preexisting;

  // 构造 loopReport：1 个 scheduling_decision 事件（产生 1 条 bulletin）
  const loopReport = makeLoopReport({
    events: [
      makeLoopEvent({
        eventId: "evt-sd-1",
        eventType: "scheduling_decision",
        payload: { summary: "新决策", decision: "dec-1" },
        timestamp: "2026-07-23T00:01:00.000Z",
      }),
    ],
  });
  const nodeResult = makeGraphNodeResult({
    nodeId: "node-u41",
    status: "completed",
    loopReport,
  });

  // 执行上送：20 + 1 = 21 条，FIFO 截断到 20 条（丢弃最早的 bul-pre-0）
  const uploader = new DefaultNodeExperienceUploader(undefined, "/test");
  await uploader.uploadExperiences("node-u41", nodeResult, context);

  // 验证：length===20（FIFO 截断）
  assert.equal(globalCtx.bulletinBoard?.length, 20, "bulletinBoard 应为 20 条（FIFO 截断）");

  // 验证：丢弃第 1 条（bul-pre-0）
  const remainingIds = globalCtx.bulletinBoard!.map((b) => b.entryId);
  assert.ok(!remainingIds.includes("bul-pre-0"), "应丢弃 bul-pre-0（最早）");
  assert.ok(remainingIds.includes("bul-pre-1"), "应保留 bul-pre-1");

  // 验证：新写入的 bulletin 保留（在截断窗口内）
  const newBulletin = globalCtx.bulletinBoard!.find((b) => b.sourceNodeId === "node-u41");
  assert.ok(newBulletin, "应保留新写入的 bulletin");
});

test("U4.2 collectedExperiences 51 条触发 slice(-50)", async () => {
  const context = makeGraphRunContext();
  const globalCtx = getGraphGlobalContext(context);

  // 预置 50 条 collectedExperiences（按时间升序，最早的 exp-pre-0）
  const preexisting: GraphExperienceEntry[] = [];
  for (let i = 0; i < 50; i++) {
    preexisting.push(
      makeExperienceEntry({
        experienceId: `exp-pre-${i}`,
        sourceNodeId: `node-pre-${i}`,
        createdAt: `2026-07-23T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      })
    );
  }
  globalCtx.collectedExperiences = preexisting;

  // 构造 loopReport：1 个 verification_passed 事件（产生 1 条经验）
  const loopReport = makeLoopReport({
    events: [
      makeLoopEvent({
        eventId: "evt-vp-1",
        eventType: "verification_passed",
        payload: { summary: "验证通过", strategy: "strict" },
        timestamp: "2026-07-23T00:01:00.000Z",
      }),
    ],
  });
  const nodeResult = makeGraphNodeResult({
    nodeId: "node-u42",
    status: "completed",
    loopReport,
  });

  // 执行上送：50 + 1 = 51 条，slice(-50) 截断到 50 条（丢弃最早的 exp-pre-0）
  const uploader = new DefaultNodeExperienceUploader(undefined, "/test");
  await uploader.uploadExperiences("node-u42", nodeResult, context);

  // 验证：length===50（slice(-50) 截断）
  assert.equal(globalCtx.collectedExperiences?.length, 50, "collectedExperiences 应为 50 条（slice(-50) 截断）");

  // 验证：丢弃第 1 条（exp-pre-0）
  const remainingIds = globalCtx.collectedExperiences!.map((e) => e.experienceId);
  assert.ok(!remainingIds.includes("exp-pre-0"), "应丢弃 exp-pre-0（最早）");
  assert.ok(remainingIds.includes("exp-pre-1"), "应保留 exp-pre-1");

  // 验证：新写入的经验保留（在截断窗口内）
  const newExp = globalCtx.collectedExperiences!.find((e) => e.sourceNodeId === "node-u42");
  assert.ok(newExp, "应保留新写入的经验");
});

test("U4.3 nodeSummaries 超 50 个触发截断", async () => {
  const context = makeGraphRunContext();
  const globalCtx = getGraphGlobalContext(context);

  // 预置 60 个 nodeSummaries（completedAt 从 T1 到 T60，T60 最新）
  // 使用 2026-07-22 日期确保新写入的 node-u43（2026-07-23 之后）最新
  const preexisting = new Map<string, NodeSummary>();
  for (let i = 1; i <= 60; i++) {
    preexisting.set(`node-pre-${i}`, {
      nodeId: `node-pre-${i}`,
      nodeType: "task",
      label: `node-pre-${i}`,
      status: "completed",
      outputSummary: `输出 ${i}`,
      keyDecisions: [],
      // completedAt 按字符串升序排列（i 越大越新）
      completedAt: `2026-07-22T00:00:${String(i).padStart(2, "0")}.000Z`,
    });
  }
  globalCtx.nodeSummaries = preexisting;

  // 上送一个新节点（nodeId="node-u43"，completedAt 由 uploadExperiences 内部 new Date().toISOString() 生成，应是最新的）
  const nodeResult = makeGraphNodeResult({
    nodeId: "node-u43",
    status: "completed",
    loopReport: undefined,
  });

  // 执行上送：60 + 1 = 61 个，截断到 50 个（按 completedAt 降序保留前 50 个）
  // 降序排列：node-u43（最新）, node-pre-60, node-pre-59, ..., node-pre-12
  // 丢弃：node-pre-1 到 node-pre-11（共 11 个最早的）
  const uploader = new DefaultNodeExperienceUploader(undefined, "/test");
  await uploader.uploadExperiences("node-u43", nodeResult, context);

  // 验证：length===50（截断到 50 个）
  assert.equal(globalCtx.nodeSummaries?.size, 50, "nodeSummaries 应为 50 个（截断）");

  // 验证：丢弃最早的 11 个（node-pre-1 到 node-pre-11）
  assert.ok(!globalCtx.nodeSummaries!.has("node-pre-1"), "应丢弃 node-pre-1（最早）");
  assert.ok(!globalCtx.nodeSummaries!.has("node-pre-11"), "应丢弃 node-pre-11");

  // 验证：保留 node-pre-12 及之后条目
  assert.ok(globalCtx.nodeSummaries!.has("node-pre-12"), "应保留 node-pre-12");
  assert.ok(globalCtx.nodeSummaries!.has("node-pre-60"), "应保留 node-pre-60（预置最新）");

  // 验证：新写入的 node-u43 保留（completedAt 最新）
  assert.ok(globalCtx.nodeSummaries!.has("node-u43"), "应保留 node-u43（新写入，completedAt 最新）");
});

// 注意：U4.4 已迁移至 dual-layer-graph-snippets.test.ts
// 旧 U4.4（deepFreeze 后数组不可变）与 U1.6 重复，且不符合 §13.12.3 设计要求。
// v3.1-H3 修复：新 U4.4 覆盖 Token 预算截断逻辑（relevance 升序丢弃，保留 1.0 project_goal）。
