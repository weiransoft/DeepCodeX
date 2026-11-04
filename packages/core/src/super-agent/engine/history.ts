/**
 * Super Agent 历史研判经验召回
 *
 * ## 定位
 *
 * 这是「全局层上下文」（对应 V2 的 `GlobalContext`）在 Super Agent 里的实现——
 * **但它不是一份存储，而是一层投影**。
 *
 * | | V2 双层上下文 | Super Agent |
 * |---|---|---|
 * | 全局层 | `GlobalContext`（落盘 `~/.deepcode/global-context.json`） | 历史研判经验（**从 `decision` 表派生**） |
 * | 任务层 | `TaskContext`（纯内存 `Map`） | 工单上下文（**从 `ticket`/`assignment` 派生**） |
 *
 * **为什么不落库**：`decision` 表已经是「研判结果」的权威事实，
 * 再建一张 `memory_entry` 表只是它的反规范化副本，却要额外承担
 * 「何时写入 / 幂等 / 事务边界」三个问题。派生视图永远与事实一致。
 *
 * ## 召回流程
 *
 * ```
 * 候选触发文本（query）
 *   ↓
 * 派生该 Source 的近期 N 条历史决策（decision ⋈ thread ⋈ trigger_thread ⋈ trigger）
 *   ↓
 * 逐条算 Jaccard（两段式评分，见 `domain/recall.ts`）
 *   ↓
 * 硬门槛过滤（Jaccard < 0.05 直接丢弃）→ 防止 recency 反转排序
 *   ↓
 * 加权排序取 Top-K
 * ```
 *
 * ## 只读（I10）
 *
 * 本模块**只读不写**——召回不产生任何新的持久化领域状态，
 * 因此不需要幂等键、不需要事务边界、也不需要考虑「归档何时发生」。
 *
 * @module super-agent/engine/history
 */

import { recallHistorical, type RecallCandidate } from "../domain/recall.js";
import type { HistoricalDecision } from "../domain/types.js";
import type { SuperAgentRepositories } from "../store/repositories.js";

// ============================================================================
// 常量
// ============================================================================

/**
 * 参与扫描的候选决策条数上限
 *
 * 先取该 Source 最近的 N 条决策，再逐条打分——
 * 避免对全库历史做 Jaccard 计算。
 */
export const DEFAULT_CANDIDATE_LIMIT = 50;

/** 召回返回条数上限 */
export const DEFAULT_RECALL_LIMIT = 5;

// ============================================================================
// 类型
// ============================================================================

/**
 * 召回所需的**最小依赖**
 *
 * 刻意只依赖「仓储 + 时钟」而不是 `EngineContext`：
 * Worker 执行器（`worker/executor.ts`）也需要装配上下文，
 * 而它按设计**不依赖 Engine**（Engine → 执行器 → Engine 会形成构造期循环）。
 *
 * `EngineContext` 天然满足本接口。
 */
export interface RecallDeps {
  /** 仓储 */
  readonly repos: SuperAgentRepositories;
  /** 当前时间（ISO 8601） */
  readonly now: () => string;
}

/** 一条被召回的历史经验 */
export interface HistoricalRecall {
  /** 命中的历史决策（含配对到的触发事件） */
  readonly decision: HistoricalDecision;
  /** 总评分（0-1） */
  readonly totalScore: number;
  /** 关键词维得分（Jaccard） */
  readonly keywordScore: number;
  /** 时间衰减维得分 */
  readonly recencyScore: number;
  /** 决策类型维得分 */
  readonly kindScore: number;
}

/** 召回输入 */
export interface RecallHistoricalInput {
  /** 召回范围（限定 Source——不跨来源串味） */
  readonly sourceId: string;
  /** 召回 query（通常是候选批次的触发文本） */
  readonly query: string;
  /** 参与扫描的候选决策条数上限 */
  readonly candidateLimit?: number;
  /** 返回条数上限 */
  readonly limit?: number;
  /** 当前时间（ISO 8601；缺省用 `ctx.now()`） */
  readonly now?: string;
}

// ============================================================================
// 召回
// ============================================================================

/**
 * 召回历史研判经验
 *
 * 两段式评分（硬门槛 + 加权排序）见 {@link recallHistorical}。
 *
 * @param deps 依赖（仓储 + 时钟）
 * @param input 召回输入
 * @returns 命中列表（按 totalScore 降序）
 */
export function recallHistoricalDecisions(deps: RecallDeps, input: RecallHistoricalInput): HistoricalRecall[] {
  const candidateLimit = input.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const limit = input.limit ?? DEFAULT_RECALL_LIMIT;
  const now = input.now ?? deps.now();

  if (input.query.trim().length === 0) {
    // 空 query 无从匹配——直接返回，避免把所有历史都算一遍
    return [];
  }

  const decisions = deps.repos.listHistoricalDecisions(input.sourceId, candidateLimit);
  if (decisions.length === 0) {
    return [];
  }

  const candidates: RecallCandidate[] = decisions.map((decision) => ({
    id: decision.id,
    kind: decision.kind,
    content: buildMatchContent(decision),
    createdAt: decision.at,
  }));

  const hits = recallHistorical(input.query, candidates, { now, limit });
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));

  const recalls: HistoricalRecall[] = [];
  for (const hit of hits) {
    const decision = byId.get(hit.id);
    // 理论上不会发生（hits 的 id 全部来自 decisions）——防御性跳过而非抛错
    if (decision === undefined) continue;
    recalls.push({
      decision,
      totalScore: hit.totalScore,
      keywordScore: hit.keywordScore,
      recencyScore: hit.recencyScore,
      kindScore: hit.kindScore,
    });
  }
  return recalls;
}

// ============================================================================
// 内部
// ============================================================================

/**
 * 构造参与匹配的内容
 *
 * = `decision.reason`（Router 自写）+ 配对到的触发正文。
 *
 * **为什么两者都要**：`reason` 表达「当时为什么这么判」，
 * 触发正文表达「当时那件事是什么」——召回时要匹配的是后者，
 * 但前者往往包含更凝练的语义锚点。
 *
 * @param decision 历史决策
 * @returns 匹配内容
 */
function buildMatchContent(decision: HistoricalDecision): string {
  const parts: string[] = [decision.reason];
  if (decision.trigger !== null) {
    parts.push(decision.trigger.text);
  }
  return parts.join("\n");
}
