/**
 * 历史经验召回与相关性评分
 *
 * ## 两段式评分（为什么不是单一线性加权）
 *
 * v1 方案曾用单一线性加权：
 * ```
 * total = 0.5 * jaccard + 0.2 * recency + 0.3 * (importance / 10)
 * ```
 *
 * 独立开发者实测证明该公式会**排序反转**：
 * 「相关但旧（48h）」vs「无关但新（1h）」——24h 半衰期下前者 0.2615 < 后者 0.3557，
 * **不相关的更新条目反而排在相关条目之前**。
 *
 * 根因有两条，都可量化：
 *
 * 1. **中文逐字分词让 Jaccard 绝对值极小**——相关条目 65 token、query 8 token，
 *    交集后 Jaccard 仅 0.1231，关键词维实际贡献 `0.5 × 0.1231 = 0.0616`；
 *    而 recency 维摆幅是 `0.2 × (1-0) = 0.2`，**是关键词维实际摆幅的 3~5 倍**。
 *    任何大于约 0.06 的关键词差都能被时间差盖过。
 * 2. **`importance` 恒为 5** → 该维贡献恒 0.15，对所有条目相同，**零区分度**。
 *
 * 本模块改用**两段式**：
 *
 * ```
 * 阶段一 · 相关性门槛（硬过滤）
 *   jaccard(query, content) < MIN_JACCARD → 直接丢弃（根本不进排序）
 *
 * 阶段二 · 排序（仅对通过门槛的条目）
 *   total = 0.65 * jaccard + 0.15 * recency + 0.20 * kindWeight
 * ```
 *
 * 门槛把「不相关」的条目挡在排序之外，recency 只在**已相关的条目之间**做微调，
 * 无法再反转顺序。
 *
 * ## 移植来源
 *
 * - Jaccard 匹配：`v2/context/relevance-scorer.ts:319-350`（纯计算）
 * - 时间衰减：`v2/context/relevance-scorer.ts:352-369`（纯计算）
 * - token 估算：`eag/rlis/rule-injector.ts:196-202`（CJK 感知口径）
 *
 * **语义差异**：V2 的 30 分钟半衰期是「文件访问时间衰减」，
 * 与「历史经验」的时效语义完全不同——这里取 **30 天**。
 *
 * @module super-agent/domain/recall
 */

import { tokenize } from "./tokenize.js";

// ============================================================================
// 常量
// ============================================================================

/** 相关性门槛：Jaccard 低于此值直接丢弃（不进排序） */
export const MIN_JACCARD = 0.05;

/** 关键词维权重 */
export const KEYWORD_WEIGHT = 0.65;

/** 时间衰减维权重 */
export const RECENCY_WEIGHT = 0.15;

/** 决策类型维权重 */
export const KIND_WEIGHT = 0.2;

/** 时间衰减半衰期（30 天） */
export const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** ASCII 折算系数（4 字符/token） */
const TOKEN_ESTIMATE_RATIO = 4;

/** CJK 字符正则（与 `eag/rlis/rule-injector.ts` 同口径） */
const CJK_CHAR_PATTERN = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;

/**
 * 决策类型的参考权重
 *
 * `accept` 的历史最值得参考——它代表「这类事件确实该接」；
 * `ignore` 次之（代表「这类通常不必管」）；
 * `stop` 权重低（停止是少数场景）；
 * `unavailable` 最低（那不是结论，是「没研判出来」）。
 */
export const KIND_WEIGHTS: Readonly<Record<string, number>> = {
  accept: 1.0,
  ignore: 0.6,
  stop: 0.4,
  unavailable: 0.2,
};

// ============================================================================
// 领域类型
// ============================================================================

/** 参与召回的历史条目 */
export interface RecallCandidate {
  /** 条目 ID（用于回指来源） */
  readonly id: string;
  /** 决策类型（accept / ignore / stop / unavailable） */
  readonly kind: string;
  /** 参与匹配的内容（决策理由 + 触发文本） */
  readonly content: string;
  /** 创建时间（ISO 8601） */
  readonly createdAt: string;
}

/** 召回结果 */
export interface RecallHit {
  /** 条目 ID */
  readonly id: string;
  /** 决策类型 */
  readonly kind: string;
  /** 内容 */
  readonly content: string;
  /** 创建时间 */
  readonly createdAt: string;
  /** 总评分（0-1） */
  readonly totalScore: number;
  /** 关键词维得分 */
  readonly keywordScore: number;
  /** 时间衰减维得分 */
  readonly recencyScore: number;
  /** 决策类型维得分 */
  readonly kindScore: number;
}

// ============================================================================
// 算法
// ============================================================================

/**
 * Jaccard 相似度（token 交集 / 并集）
 *
 * @param a 文本 A
 * @param b 文本 B
 * @returns 相似度（0-1）；任一方为空或无公共 token 时返回 0
 */
export function jaccard(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.length === 0 || tokensB.length === 0) {
    return 0;
  }
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) {
    return 0;
  }
  return intersection / union;
}

/**
 * 时间衰减得分
 *
 * `score = 0.5 ^ (elapsedMs / halfLifeMs)`
 *
 * @param createdAt 创建时间（ISO 8601）
 * @param now 当前时间（ISO 8601）
 * @param halfLifeMs 半衰期（毫秒）
 * @returns 衰减得分（0-1）
 */
export function recencyScore(createdAt: string, now: string, halfLifeMs = RECENCY_HALF_LIFE_MS): number {
  const created = Date.parse(createdAt);
  const current = Date.parse(now);
  if (Number.isNaN(created) || Number.isNaN(current)) {
    return 0;
  }
  const elapsed = Math.max(0, current - created);
  return 0.5 ** (elapsed / halfLifeMs);
}

/**
 * 估算字符串 token 数（CJK 感知）
 *
 * 与 `eag/rlis/rule-injector.ts:196-202` 同口径：
 * CJK 字符按 1 字符 ≈ 1 token，其余按 4 字符/token。
 * （一刀切 `length / 4` 会把中文低估约 4 倍。）
 *
 * @param text 字符串
 * @returns 估算 token 数
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkMatch = text.match(CJK_CHAR_PATTERN);
  const cjkCount = cjkMatch === null ? 0 : cjkMatch.length;
  const nonCjkCount = text.length - cjkCount;
  return Math.ceil(cjkCount + nonCjkCount / TOKEN_ESTIMATE_RATIO);
}

/**
 * 决策类型的参考权重
 *
 * @param kind 决策类型
 * @returns 权重（0-1）；未知类型返回 0.2
 */
export function kindWeight(kind: string): number {
  return KIND_WEIGHTS[kind] ?? 0.2;
}

// ============================================================================
// 召回
// ============================================================================

/**
 * 召回历史条目
 *
 * 两段式：先按相关性门槛硬过滤，再对通过者排序取 Top-K。
 *
 * @param query 查询文本（触发文本 / 工单范围等）
 * @param candidates 候选条目
 * @param options 选项
 * @returns 召回结果（按 totalScore 降序）
 */
export function recallHistorical(
  query: string,
  candidates: readonly RecallCandidate[],
  options: {
    /** 当前时间（ISO 8601） */
    readonly now: string;
    /** 返回条数上限 */
    readonly limit?: number;
    /** 相关性门槛 */
    readonly minJaccard?: number;
    /** 半衰期（毫秒） */
    readonly halfLifeMs?: number;
  }
): RecallHit[] {
  const limit = options.limit ?? 5;
  const threshold = options.minJaccard ?? MIN_JACCARD;
  const halfLife = options.halfLifeMs ?? RECENCY_HALF_LIFE_MS;

  // ---- 阶段一：相关性门槛（硬过滤） ----
  const passed: RecallHit[] = [];
  for (const candidate of candidates) {
    const keyword = jaccard(query, candidate.content);
    if (keyword < threshold) {
      // 不相关的条目**根本不进排序**——这是防止 recency 反转排序的关键
      continue;
    }
    const recency = recencyScore(candidate.createdAt, options.now, halfLife);
    const kind = kindWeight(candidate.kind);
    const total = KEYWORD_WEIGHT * keyword + RECENCY_WEIGHT * recency + KIND_WEIGHT * kind;
    passed.push({
      id: candidate.id,
      kind: candidate.kind,
      content: candidate.content,
      createdAt: candidate.createdAt,
      totalScore: total,
      keywordScore: keyword,
      recencyScore: recency,
      kindScore: kind,
    });
  }

  // ---- 阶段二：排序 + 截断 ----
  passed.sort((a, b) => b.totalScore - a.totalScore);
  return passed.slice(0, limit);
}
