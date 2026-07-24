/**
 * 图级上下文辅助函数与默认经验上送器（对齐设计文档 §13.6.2 / §13.6.3）
 *
 * 本模块提供双层滑动窗口上下文与图编排有机集成所需的核心辅助函数：
 * - deepFreeze：递归冻结对象，保证不可变优先原则（架构师 M-4）
 * - extractExperiencesFromLoopReport：从 LoopRunReport.events 提取经验条目
 * - adaptDecisionsFromLoopReport：从 LoopRunReport.events 提取决策 → BulletinEntry
 * - summarizeOutput：摘要化节点输出，避免上下文膨胀
 * - adaptExperienceCase：ExperienceCase → GraphExperienceEntry 类型适配（架构师 B-1）
 * - recallExperiences：合并同图经验 + 历史经验，双重去重（架构师 M-1 + 测试专家 M1）
 * - DefaultNodeExperienceUploader：NodeExperienceUploader 协议的默认实现
 *
 * 依赖方向（对齐 §13.13.2 B-2 / B-3 共识）：
 * - eag/graph → eag/loop（合法，复用 LoopRunReport / LoopEvent 数据模型）
 * - eag/graph → eag/graph/graph-loop-models（合法，同模块内类型依赖）
 * - eag/graph → eag/graph/graph-loop-protocols（合法，同模块内协议依赖）
 * - 禁止依赖 eag/p5（通过 NodeExperienceUploader 协议解耦）
 *
 * @module eag/graph/graph-context-helpers
 */

import type {
  /** 图运行上下文 */
  GraphRunContext,
  /** 图节点执行结果 */
  GraphNodeResult,
  /** 经验案例（ExperienceStore 存储） */
  ExperienceCase,
  /** 节点执行摘要 */
  NodeSummary,
  /** 图级经验条目 */
  GraphExperienceEntry,
  /** 动向广播条目 */
  BulletinEntry,
  /** 图级全局上下文（Layer 0） */
  GraphGlobalContext,
} from "./graph-loop-models";
import {
  /** 从 GraphRunContext.globalState 安全读取 GraphGlobalContext */
  getGraphGlobalContext,
} from "./graph-loop-models";
// TOP-4 上下文拼接工具函数统一化：deepFreeze 从统一工具模块重新导出，保持 API 不变
import { deepFreeze } from "./graph-context-utils";
import type {
  /** 经验存储协议 */
  ExperienceStoreProtocol,
  /** 节点经验上送协议 */
  NodeExperienceUploader,
} from "./graph-loop-protocols";
import type {
  /** Loop 运行报告 */
  LoopRunReport,
  /** Loop 统一事件模型 */
  LoopEvent,
} from "../loop/models";

// ============================================================================
// 常量（对齐 §13.6.2 / §13.7.1 滑动窗口截断）
// ============================================================================

/**
 * 动向广播板滑动窗口上限（对齐 §13.7.1：保留最近 20 条通知，FIFO 淘汰）
 */
const MAX_BULLETIN_ENTRIES = 20;

/**
 * 经验汇总池滑动窗口上限（对齐 §13.6.2 架构师 M-2：保留最近 50 条经验）
 */
const MAX_COLLECTED_EXPERIENCES = 50;

/**
 * 节点摘要滑动窗口上限（保留最近 50 个节点摘要，按 completedAt 降序）
 */
const MAX_NODE_SUMMARIES = 50;

/**
 * 历史经验召回上限（recallSimilar 调用时的 limit 参数）
 */
const HISTORICAL_RECALL_LIMIT = 5;

/**
 * 默认经验召回合并上限（recallExperiences 的默认 limit 参数）
 */
const DEFAULT_RECALL_LIMIT = 10;

/**
 * 节点输出摘要每个值的最大字符数（避免上下文膨胀）
 */
const OUTPUT_SUMMARY_MAX_CHARS = 200;

// ============================================================================
// deepFreeze 工具函数（对齐 §13.6.2 架构师 M-4）
// ============================================================================

// TOP-4 上下文拼接工具函数统一化：deepFreeze 实现已迁移到 graph-context-utils.ts，
// 本模块通过 import { deepFreeze } 重新导出，保持外部 API 完全不变。

// ============================================================================
// 经验提取函数（对齐 §13.6.2）
// ============================================================================

/**
 * 从 LoopRunReport 提取经验条目
 *
 * 经验来源：LoopRunReport.events 中的成功/失败事件
 * - verification_passed 事件 → success 经验（验证通过，记录成功策略）
 * - verification_rejected 事件 → failure 经验（验证失败，记录失败原因）
 * - loop_completed 事件 → success 总结经验（Loop 正常完成）
 * - loop_failed 事件 → failure 总结经验（Loop 失败停止）
 * - 兜底：根据 finalStatus 生成一条总结性经验（当无上述事件时）
 *
 * @param nodeId 节点 ID（作为 sourceNodeId）
 * @param loopReport Loop 运行报告
 * @returns 经验条目数组（未冻结，由调用方决定是否 deepFreeze）
 */
export function extractExperiencesFromLoopReport(nodeId: string, loopReport: LoopRunReport): GraphExperienceEntry[] {
  const experiences: GraphExperienceEntry[] = [];
  const now = new Date().toISOString();

  // 遍历事件，提取经验
  for (const event of loopReport.events) {
    const experience = adaptEventToExperience(nodeId, event, loopReport.loopType);
    if (experience) {
      experiences.push(experience);
    }
  }

  // 兜底：若无经验事件，根据 finalStatus 生成一条总结性经验
  if (experiences.length === 0) {
    experiences.push({
      experienceId: `${nodeId}-summary-${loopReport.runId}`,
      sourceNodeId: nodeId,
      type: loopReport.finalStatus === "completed" ? "success" : "failure",
      taskType: loopReport.loopType,
      description: loopReport.objective,
      solution: loopReport.finalStatus === "completed" ? loopReport.finalSummary : undefined,
      failureReason: loopReport.finalStatus === "completed" ? undefined : loopReport.finalSummary,
      lessonLearned: loopReport.finalStatus === "completed" ? undefined : loopReport.finalSummary,
      createdAt: now,
    });
  }

  return experiences;
}

/**
 * 将单个 LoopEvent 适配为 GraphExperienceEntry（若该事件类型可转换为经验）
 *
 * 事件类型映射：
 * - verification_passed → success 经验
 * - verification_rejected → failure 经验
 * - loop_completed → success 总结经验
 * - loop_failed → failure 总结经验
 * - 其他事件类型 → 返回 null（不转换为经验）
 *
 * @param nodeId 节点 ID
 * @param event Loop 事件
 * @param taskType 任务类型（loopType）
 * @returns 经验条目或 null
 */
function adaptEventToExperience(nodeId: string, event: LoopEvent, taskType: string): GraphExperienceEntry | null {
  // 从 payload 提取描述信息
  const payload = event.payload as Readonly<Record<string, unknown>>;
  const description =
    (payload["summary"] as string) ??
    (payload["objective"] as string) ??
    (payload["reason"] as string) ??
    `事件 ${event.eventType}（迭代 ${event.iterIndex}）`;

  switch (event.eventType) {
    case "verification_passed":
      return {
        experienceId: `${nodeId}-vp-${event.eventId}`,
        sourceNodeId: nodeId,
        type: "success",
        taskType,
        description: `验证通过：${description}`,
        solution: (payload["strategy"] as string) ?? "verify-passed",
        createdAt: event.timestamp,
      };

    case "verification_rejected":
      return {
        experienceId: `${nodeId}-vr-${event.eventId}`,
        sourceNodeId: nodeId,
        type: "failure",
        taskType,
        description: `验证失败：${description}`,
        failureReason: (payload["reason"] as string) ?? "verify-rejected",
        lessonLearned: (payload["lesson"] as string) ?? (payload["reason"] as string) ?? "verify-rejected",
        createdAt: event.timestamp,
      };

    case "loop_completed":
      return {
        experienceId: `${nodeId}-lc-${event.eventId}`,
        sourceNodeId: nodeId,
        type: "success",
        taskType,
        description: `Loop 完成：${description}`,
        solution: (payload["strategy"] as string) ?? "loop-completed",
        createdAt: event.timestamp,
      };

    case "loop_failed":
      return {
        experienceId: `${nodeId}-lf-${event.eventId}`,
        sourceNodeId: nodeId,
        type: "failure",
        taskType,
        description: `Loop 失败：${description}`,
        failureReason: (payload["reason"] as string) ?? "loop-failed",
        lessonLearned: (payload["lesson"] as string) ?? (payload["reason"] as string) ?? "loop-failed",
        createdAt: event.timestamp,
      };

    default:
      // 其他事件类型不转换为经验
      return null;
  }
}

// ============================================================================
// 决策提取函数（对齐 §13.6.2）
// ============================================================================

/**
 * 从 LoopRunReport 提取决策 → 转换为 BulletinEntry
 *
 * 替代原伪代码中 notesMemory.getDecisions() 的职责，
 * 从 loopReport.events 中识别决策类事件：
 * - scheduling_decision 事件 → BulletinEntry (type="decision")
 * - discovery_completed 事件 → BulletinEntry (type="discovery")
 * - handoff_dispatched 事件 → BulletinEntry (type="milestone")
 * - persistence_written 事件 → BulletinEntry (type="milestone")
 * - loop_failed 事件 → BulletinEntry (type="blocker")
 *
 * @param nodeId 节点 ID
 * @param loopReport Loop 运行报告
 * @returns BulletinEntry 数组（type 为 decision / discovery / milestone / blocker）
 */
export function adaptDecisionsFromLoopReport(nodeId: string, loopReport: LoopRunReport): BulletinEntry[] {
  const bulletins: BulletinEntry[] = [];

  for (const event of loopReport.events) {
    const bulletin = adaptEventToBulletin(nodeId, event);
    if (bulletin) {
      bulletins.push(bulletin);
    }
  }

  return bulletins;
}

/**
 * 将单个 LoopEvent 适配为 BulletinEntry（若该事件类型可转换为动向通知）
 *
 * @param nodeId 节点 ID
 * @param event Loop 事件
 * @returns 动向广播条目或 null
 */
function adaptEventToBulletin(nodeId: string, event: LoopEvent): BulletinEntry | null {
  const payload = event.payload as Readonly<Record<string, unknown>>;
  const summary =
    (payload["summary"] as string) ??
    (payload["decision"] as string) ??
    (payload["action"] as string) ??
    `事件 ${event.eventType}（迭代 ${event.iterIndex}）`;
  const details = payload["details"] as string | undefined;

  switch (event.eventType) {
    case "scheduling_decision":
      return {
        entryId: `${nodeId}-sd-${event.eventId}`,
        sourceNodeId: nodeId,
        type: "decision",
        summary,
        details,
        timestamp: event.timestamp,
      };

    case "discovery_completed":
      return {
        entryId: `${nodeId}-dc-${event.eventId}`,
        sourceNodeId: nodeId,
        type: "discovery",
        summary,
        details,
        timestamp: event.timestamp,
      };

    case "handoff_dispatched":
    case "persistence_written":
      return {
        entryId: `${nodeId}-${event.eventType}-${event.eventId}`,
        sourceNodeId: nodeId,
        type: "milestone",
        summary,
        details,
        timestamp: event.timestamp,
      };

    case "loop_failed":
      return {
        entryId: `${nodeId}-lf-${event.eventId}`,
        sourceNodeId: nodeId,
        type: "blocker",
        summary,
        details,
        timestamp: event.timestamp,
      };

    default:
      return null;
  }
}

// ============================================================================
// 输出摘要函数（对齐 §13.6.2）
// ============================================================================

/**
 * 摘要化节点输出
 *
 * 取 output 的 key 列表 + 每个值的类型与摘要（前 OUTPUT_SUMMARY_MAX_CHARS 字符），
 * 避免将完整 output 放入 NodeSummary 导致上下文膨胀。
 *
 * @param output 节点输出数据
 * @returns 摘要字符串（格式：key1(type1):摘要1; key2(type2):摘要2; ...）
 */
export function summarizeOutput(output: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(output);
  if (keys.length === 0) {
    return "(空输出)";
  }

  const parts: string[] = [];
  for (const key of keys) {
    const value = output[key];
    const type = typeof value;
    // 根据类型生成摘要
    let valueSummary: string;
    if (value === null) {
      valueSummary = "null";
    } else if (value === undefined) {
      valueSummary = "undefined";
    } else if (typeof value === "string") {
      valueSummary = value.slice(0, OUTPUT_SUMMARY_MAX_CHARS);
    } else if (typeof value === "object") {
      try {
        valueSummary = JSON.stringify(value).slice(0, OUTPUT_SUMMARY_MAX_CHARS);
      } catch {
        valueSummary = "[object]";
      }
    } else {
      valueSummary = String(value).slice(0, OUTPUT_SUMMARY_MAX_CHARS);
    }
    parts.push(`${key}(${type}):${valueSummary}`);
  }

  return parts.join("; ");
}

// ============================================================================
// 类型适配函数（对齐 §13.6.3 架构师 B-1）
// ============================================================================

/**
 * 将 ExperienceCase 适配为 GraphExperienceEntry
 *
 * ExperienceCase 字段：{ caseId, taskType, taskFeatures, strategy, success,
 *   executionTimeSec, failureReason?, nodeId?, graphRunId?, createdAt }
 *
 * GraphExperienceEntry 字段：{ experienceId, sourceNodeId, type, taskType,
 *   description, solution?, failureReason?, lessonLearned?, createdAt }
 *
 * 适配规则：
 * - experienceId ← caseId
 * - sourceNodeId ← nodeId ?? "historical"（历史经验无源节点标记）
 * - type ← success ? "success" : "failure"
 * - description ← success ? strategy : failureReason
 * - solution ← success ? strategy : undefined
 * - failureReason ← success ? undefined : failureReason
 * - lessonLearned ← success ? undefined : failureReason（失败教训兜底）
 * - createdAt ← createdAt
 *
 * @param caseData 经验案例
 * @returns GraphExperienceEntry 格式的经验条目
 */
export function adaptExperienceCase(caseData: ExperienceCase): GraphExperienceEntry {
  return {
    experienceId: caseData.caseId,
    sourceNodeId: caseData.nodeId ?? "historical",
    type: caseData.success ? "success" : "failure",
    taskType: caseData.taskType,
    description: caseData.success ? caseData.strategy : (caseData.failureReason ?? caseData.strategy),
    solution: caseData.success ? caseData.strategy : undefined,
    failureReason: caseData.success ? undefined : caseData.failureReason,
    lessonLearned: caseData.success ? undefined : caseData.failureReason,
    createdAt: caseData.createdAt,
  };
}

// ============================================================================
// 经验召回函数（对齐 §13.6.3）
// ============================================================================

/**
 * 召回与当前节点任务相关的经验
 *
 * 合并两个来源：
 * 1. sameRunExperiences：当前图执行内已收集的经验（从 globalState.collectedExperiences）
 * 2. historicalExperiences：跨图执行的历史经验（从 ExperienceStore.recallSimilar）
 *
 * 排序规则（修正测试专家 M1 指出的 bug）：
 * - 历史经验优先（按相似度降序，recallSimilar 已排序）
 * - 同运行经验次之（按 createdAt 降序，最近的在前）
 * - 合并后取前 limit 条（默认 10）
 *
 * 去重规则（架构师 M-1）：
 * - 按 experienceId 去重（避免同图执行内已持久化的经验重复注入）
 * - 按 taskType::description 语义去重（避免重试场景产生相似经验）
 *
 * 降级语义：
 * - ExperienceStore 未注入时，仅返回 sameRunExperiences
 * - ExperienceStore.recallSimilar 抛错时，降级为仅返回 sameRunExperiences
 *
 * @param nodeId 当前节点 ID（排除自身经验）
 * @param task 当前任务描述（用于 ExperienceStore 相似度查询）
 * @param context 图运行上下文
 * @param experienceStore 经验存储（可选，未注入时仅返回 sameRun）
 * @param limit 返回上限（默认 10）
 * @returns 合并去重排序后的经验条目数组
 */
export async function recallExperiences(
  nodeId: string,
  task: string,
  context: GraphRunContext,
  experienceStore?: ExperienceStoreProtocol,
  limit: number = DEFAULT_RECALL_LIMIT
): Promise<GraphExperienceEntry[]> {
  const globalCtx = getGraphGlobalContext(context);

  // 1. 从图级经验汇总池中召回（同图执行内的经验，排除自身）
  // 按 createdAt 降序排序（最近的在前）
  const sameRunExperiences = (globalCtx.collectedExperiences ?? [])
    .filter((exp) => exp.sourceNodeId !== nodeId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // 2. 从 ExperienceStore 中召回（跨图执行的历史经验）
  let historicalExperiences: GraphExperienceEntry[] = [];
  if (experienceStore) {
    try {
      // 修正签名（架构师 B-1）：taskFeatures 是键值对，不是 { task, nodeId }
      const historicalCases = await experienceStore.recallSimilar({ taskType: task, nodeId }, HISTORICAL_RECALL_LIMIT);
      historicalExperiences = historicalCases.map(adaptExperienceCase);
      // historicalExperiences 已按相似度降序（recallSimilar 内部排序）
    } catch (err) {
      // ExperienceStore 召回失败时降级为仅返回 sameRun
      // v4-H4 修复：增加 console.warn 日志保证降级路径可观测（生产环境故障可定位）
      console.warn("[recallExperiences] ExperienceStore recallSimilar 失败，降级为仅返回 sameRun:", err);
      historicalExperiences = [];
    }
  }

  // 3. 去重：按 experienceId 去重（避免同图执行内已持久化的经验重复注入）
  const seenIds = new Set(sameRunExperiences.map((e) => e.experienceId));
  const dedupedHistorical = historicalExperiences.filter((e) => !seenIds.has(e.experienceId));

  // 4. 去重：按 taskType::description 语义去重（避免重试场景产生相似经验）
  const seenSemanticKeys = new Set(sameRunExperiences.map((e) => `${e.taskType}::${e.description}`));
  const semanticDedupedHistorical = dedupedHistorical.filter((e) => {
    const key = `${e.taskType}::${e.description}`;
    if (seenSemanticKeys.has(key)) return false;
    seenSemanticKeys.add(key);
    return true;
  });

  // 5. 合并 + 排序：历史经验优先（相似度降序）+ 同运行经验次之（createdAt 降序）
  const merged = [...semanticDedupedHistorical, ...sameRunExperiences];

  // 6. 截断到 limit
  return merged.slice(0, limit);
}

// ============================================================================
// DefaultNodeExperienceUploader：默认经验上送器实现（对齐 §13.6.2）
// ============================================================================

/**
 * 默认经验上送器实现（对齐 §13.6.2）
 *
 * 经验来源：
 * - 从 nodeResult.loopReport.events 提取成功/失败事件 → GraphExperienceEntry
 * - 从 nodeResult.loopReport 中提取决策事件 → BulletinEntry
 * - 从 nodeResult.output 提取摘要 → NodeSummary
 *
 * 持久化策略：
 * - 仅 status="completed" 的节点经验持久化到 ExperienceStore（由调用方注入）
 * - failed 节点的经验仅在图内可见（写入 collectedExperiences），不持久化
 *
 * 滑动窗口截断：
 * - bulletinBoard：保留最近 20 条（FIFO）
 * - collectedExperiences：保留最近 50 条
 * - nodeSummaries：保留最近 50 个（按 completedAt 降序）
 *
 * 不可变性：
 * - 每条 GraphExperienceEntry / BulletinEntry / NodeSummary 在写入前调用 deepFreeze() 递归冻结
 *
 * 逻辑 bug 修正（架构师 M-4）：
 * - 先收集本节点新增经验到临时列表 newExperiences，push 后直接用 newExperiences 做 storeCase
 * - 避免原伪代码 push 后 filter 导致当前节点新 push 的经验也算入 storeCase 范围
 */
export class DefaultNodeExperienceUploader implements NodeExperienceUploader {
  /**
   * @param experienceStore 经验存储（可选，未注入时跳过持久化）
   * @param projectRoot 项目根目录（用于溯源，可选）
   */
  constructor(
    /** 经验存储（可选，未注入时跳过持久化） */
    private readonly experienceStore?: ExperienceStoreProtocol,
    /** 项目根目录（用于溯源） */
    private readonly projectRoot?: string
  ) {}

  /**
   * 上送节点执行经验到全局上下文
   *
   * 执行流程：
   * 1. 懒初始化集合字段（首次写入时创建）
   * 2. 从 loopReport 提取经验 → deepFreeze → 收集到临时列表 → push 到 collectedExperiences
   * 3. 从 loopReport 提取决策 → deepFreeze → push 到 bulletinBoard
   * 4. 生成节点摘要 → deepFreeze → 写入 nodeSummaries
   * 5. 持久化到 ExperienceStore（仅 completed 节点，使用临时列表避免逻辑 bug）
   * 6. bulletinBoard 滑动窗口截断（保留最近 20 条）
   * 7. collectedExperiences 滑动窗口截断（保留最近 50 条）
   * 8. nodeSummaries 滑动窗口截断（保留最近 50 个）
   * 9. 更新 lastUpdatedAt 时间戳
   *
   * @param nodeId 节点 ID
   * @param nodeResult 节点执行结果
   * @param context 图运行上下文
   */
  async uploadExperiences(nodeId: string, nodeResult: GraphNodeResult, context: GraphRunContext): Promise<void> {
    const globalCtx = getGraphGlobalContext(context);

    // 1. 懒初始化集合字段（首次写入时创建）
    if (!globalCtx.collectedExperiences) {
      globalCtx.collectedExperiences = [];
    }
    if (!globalCtx.bulletinBoard) {
      globalCtx.bulletinBoard = [];
    }
    if (!globalCtx.nodeSummaries) {
      globalCtx.nodeSummaries = new Map();
    }

    // 2. 从 loopReport 提取经验（仅 loop 节点有 loopReport）
    const newExperiences: GraphExperienceEntry[] = [];
    if (nodeResult.loopReport) {
      const extracted = extractExperiencesFromLoopReport(nodeId, nodeResult.loopReport);
      // deepFreeze 每条经验后收集到临时列表（避免 push 后 filter 的逻辑 bug）
      for (const exp of extracted) {
        const frozen = deepFreeze(exp);
        newExperiences.push(frozen);
        globalCtx.collectedExperiences.push(frozen);
      }
    }

    // 3. 从 loopReport 提取决策 → 写入 bulletinBoard
    if (nodeResult.loopReport) {
      const decisions = adaptDecisionsFromLoopReport(nodeId, nodeResult.loopReport);
      for (const decision of decisions) {
        globalCtx.bulletinBoard.push(deepFreeze(decision));
      }
    }

    // 4. 写入节点执行摘要
    // 注意：GraphNodeResult 当前不携带 label 字段，使用 nodeId 兜底
    const decisionsForSummary = nodeResult.loopReport
      ? adaptDecisionsFromLoopReport(nodeId, nodeResult.loopReport).map((d) => d.summary)
      : [];
    const summary: NodeSummary = {
      nodeId,
      nodeType: nodeResult.nodeType,
      label: nodeId,
      status: nodeResult.status,
      outputSummary: summarizeOutput(nodeResult.output),
      keyDecisions: decisionsForSummary,
      completedAt: new Date().toISOString(),
    };
    globalCtx.nodeSummaries.set(nodeId, deepFreeze(summary));

    // 5. 持久化到 ExperienceStore（仅 completed 节点）
    // 修正：使用 newExperiences 临时列表，而非 push 后再 filter（避免逻辑歧义）
    if (nodeResult.status === "completed" && this.experienceStore && newExperiences.length > 0) {
      for (const exp of newExperiences) {
        await this.experienceStore.storeCase({
          caseId: exp.experienceId,
          taskType: exp.taskType,
          taskFeatures: { nodeId, graphId: context.graphId },
          strategy: exp.solution ?? "loop-with-verify",
          success: exp.type === "success",
          executionTimeSec: nodeResult.durationSec,
          createdAt: exp.createdAt,
        });
      }
    }

    // 6. bulletinBoard 滑动窗口截断（FIFO，保留最近 20 条）
    // v4-M5 说明：slice 重新赋值会断开旧数组引用，这是设计预期行为（控制内存）。
    //            外部应通过 getGraphGlobalContext() 重新获取引用，不应缓存旧引用。
    if (globalCtx.bulletinBoard.length > MAX_BULLETIN_ENTRIES) {
      globalCtx.bulletinBoard = globalCtx.bulletinBoard.slice(-MAX_BULLETIN_ENTRIES);
    }

    // 7. collectedExperiences 滑动窗口截断（保留最近 50 条）
    // v4-M5 说明：slice 重新赋值会断开旧数组引用，这是设计预期行为（控制内存）。
    //            外部应通过 getGraphGlobalContext() 重新获取引用，不应缓存旧引用。
    if (globalCtx.collectedExperiences.length > MAX_COLLECTED_EXPERIENCES) {
      globalCtx.collectedExperiences = globalCtx.collectedExperiences.slice(-MAX_COLLECTED_EXPERIENCES);
    }

    // 8. nodeSummaries 截断（保留最近 50 个，按 completedAt 降序）
    if (globalCtx.nodeSummaries.size > MAX_NODE_SUMMARIES) {
      const entries = [...globalCtx.nodeSummaries.entries()]
        .sort(([, a], [, b]) => b.completedAt.localeCompare(a.completedAt))
        .slice(0, MAX_NODE_SUMMARIES);
      globalCtx.nodeSummaries = new Map(entries);
    }

    // 9. 更新 lastUpdatedAt 时间戳
    globalCtx.lastUpdatedAt = new Date().toISOString();
  }
}

// TOP-4 上下文拼接工具函数统一化：将统一工具模块的 deepFreeze 重新导出，保持外部 API 不变
export { deepFreeze };
