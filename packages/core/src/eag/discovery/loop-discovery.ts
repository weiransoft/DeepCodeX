/**
 * LoopDiscovery —— 重复工作流发现（P5，Better Harness 增强方案 §P5）
 *
 * 职责：对执行历史（P2 evidence-bundle 的同源数据：ExecutionHistoryStore）做
 * 命令/工具序列 n-gram 挖掘，识别跨会话重复出现的工作流，产出 record-only 建议
 * （只报告、不自动落库、不自动创建资产）。
 *
 * 设计约定：
 * - 纯函数优先：discoverRepeatedFlows(records, options) 不碰 IO，便于 fixture 回归；
 * - 归一化步骤：bash 以 argsSnippet 首词归一（build/test/lint…），其余用 toolName；
 * - 跨会话才算「重复工作」：同会话内的连续重复属 TurnGuard 循环护栏职责（不越界）；
 * - 平凡序列过滤：n-gram 内 distinct 步骤 < 2 的（如 bash×3）不算工作流；
 * - 覆盖阶梯（最小跃迁）：先匹配已知资产（skill/rule 名称 token 重叠）→ 建议
 *   extend（扩展现有资产）；无匹配 → create（新建）；绝不越过阶梯直接造新资产；
 * - 建议上限：单次产出 ≤ maxSuggestions（默认 5，共识 C5 量化验收）。
 *
 * @module eag/discovery/loop-discovery
 */

import * as crypto from "node:crypto";
import type { ExecutionRecord } from "../../v2/memory/execution-history-types";

/** 覆盖阶梯建议等级（最小跃迁：优先复用/扩展，最后才新建） */
export type LoopCoverageLadder = "extend" | "create";

/** 单条重复工作流建议（record-only：仅报告） */
export type LoopFlowSuggestion = {
  /** 建议实例 id（发现侧分配） */
  id: string;
  /** 归一化序列指纹（sha256，跨窗口去重键） */
  fingerprint: string;
  /** 归一化步骤序列（如 ["bash:build", "bash:test", "edit", "bash:lint"]） */
  sequence: string[];
  /** 窗口内出现次数 */
  occurrences: number;
  /** 覆盖的会话数 */
  distinctSessions: number;
  /** 覆盖阶梯结论 */
  coverageLadder: LoopCoverageLadder;
  /** ladder=extend 时匹配到的已知资产名 */
  matchedAsset?: string;
  /** 给用户看的中文建议理由 */
  rationale: string;
};

/** 发现选项（全部有默认值） */
export type LoopDiscoveryOptions = {
  /** 时间窗（天），默认 7（共识：7 天内 ≥3 次可比序列） */
  windowDays?: number;
  /** 序列出现次数阈值，默认 3 */
  minOccurrences?: number;
  /** 跨会话数阈值，默认 2（同会话重复不算跨会话工作流） */
  minDistinctSessions?: number;
  /** n-gram 窗口长度范围，默认 [3, 5] */
  ngramRange?: [number, number];
  /** 已知资产名（skill/rule 名单，用于覆盖阶梯匹配） */
  knownAssetNames?: readonly string[];
  /** 单次建议上限，默认 5 */
  maxSuggestions?: number;
};

/** 默认选项（导出供调用方/测试对齐口径） */
export const DEFAULT_LOOP_DISCOVERY_OPTIONS: Readonly<Required<Omit<LoopDiscoveryOptions, "knownAssetNames">>> =
  Object.freeze({
    windowDays: 7,
    minOccurrences: 3,
    minDistinctSessions: 2,
    ngramRange: [3, 5] as [number, number],
    maxSuggestions: 5,
  });

/**
 * 归一化单条执行记录为步骤标识。
 *
 * bash 以 argsSnippet 首词归一（如 bash:build）；其余工具直接用 toolName。
 */
export function normalizeStep(record: Pick<ExecutionRecord, "toolName" | "argsSnippet">): string {
  const tool = record.toolName || "unknown";
  if (tool === "bash") {
    const first = (record.argsSnippet ?? "").trim().split(/\s+/)[0] ?? "";
    if (first) {
      return `bash:${first.toLowerCase().slice(0, 40)}`;
    }
  }
  return tool;
}

/** 归一化序列指纹（sha256 十六进制） */
export function computeSequenceFingerprint(sequence: readonly string[]): string {
  return crypto.createHash("sha256").update(sequence.join("→"), "utf8").digest("hex");
}

/** 已知资产 token 重叠匹配（覆盖阶梯：找 extend 目标） */
function matchKnownAsset(sequence: readonly string[], knownAssetNames: readonly string[]): string | undefined {
  if (knownAssetNames.length === 0) {
    return undefined;
  }
  // 序列 token 集合（bash:build → build；edit → edit）
  const seqTokens = new Set<string>();
  for (const step of sequence) {
    for (const part of step.split(":")) {
      if (part) {
        seqTokens.add(part);
      }
    }
  }
  let best: { name: string; overlap: number } | undefined;
  for (const name of knownAssetNames) {
    const assetTokens = name
      .toLowerCase()
      .split(/[-_/]/)
      .filter((t) => t.length > 1);
    let overlap = 0;
    for (const token of assetTokens) {
      if (seqTokens.has(token)) {
        overlap += 1;
      }
    }
    if (overlap > 0 && (!best || overlap > best.overlap)) {
      best = { name, overlap };
    }
  }
  return best?.name;
}

/**
 * 从执行记录中发现跨会话重复工作流（纯函数，record-only）。
 *
 * @param records 执行记录（任意顺序；内部按 session 分组 + 时间排序）
 * @param options 发现选项
 * @returns 建议数组（按 occurrences 降序，≤ maxSuggestions）
 */
export function discoverRepeatedFlows(
  records: readonly ExecutionRecord[],
  options: LoopDiscoveryOptions = {}
): LoopFlowSuggestion[] {
  const opts = { ...DEFAULT_LOOP_DISCOVERY_OPTIONS, ...options };
  const [minN, maxN] = opts.ngramRange;

  // 1. 按 session 分组 + 时间排序
  const bySession = new Map<string, ExecutionRecord[]>();
  for (const record of records) {
    if (!record || !record.sessionId || !record.toolName) {
      continue;
    }
    let list = bySession.get(record.sessionId);
    if (!list) {
      list = [];
      bySession.set(record.sessionId, list);
    }
    list.push(record);
  }

  // 2. 每会话提取归一化 n-gram；全局聚合同一序列的出现位置
  type Hit = { sessions: Set<string>; count: number; sequence: string[] };
  const hits = new Map<string, Hit>();
  for (const [, sessionRecords] of bySession) {
    const steps = sessionRecords
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(normalizeStep);
    for (let n = minN; n <= maxN; n += 1) {
      if (steps.length < n) {
        break;
      }
      for (let start = 0; start + n <= steps.length; start += 1) {
        const gram = steps.slice(start, start + n);
        // 平凡序列过滤：distinct < 2（如 bash×3）不是工作流
        if (new Set(gram).size < 2) {
          continue;
        }
        const fingerprint = computeSequenceFingerprint(gram);
        let hit = hits.get(fingerprint);
        if (!hit) {
          hit = { sessions: new Set(), count: 0, sequence: gram };
          hits.set(fingerprint, hit);
        }
        hit.count += 1;
        hit.sessions.add(sessionRecords[0]?.sessionId ?? "");
      }
    }
  }

  // 3. 阈值过滤 + 覆盖阶梯
  const suggestions: LoopFlowSuggestion[] = [];
  for (const hit of hits.values()) {
    if (hit.count < opts.minOccurrences || hit.sessions.size < opts.minDistinctSessions) {
      continue;
    }
    const matchedAsset = matchKnownAsset(hit.sequence, opts.knownAssetNames ?? []);
    suggestions.push({
      id: crypto.randomUUID(),
      fingerprint: computeSequenceFingerprint(hit.sequence),
      sequence: hit.sequence,
      occurrences: hit.count,
      distinctSessions: hit.sessions.size,
      coverageLadder: matchedAsset ? "extend" : "create",
      matchedAsset,
      rationale: matchedAsset
        ? `近 ${opts.windowDays} 天该流程重复出现 ${hit.count} 次（${hit.sessions.size} 个会话），已有资产「${matchedAsset}」可扩展承载`
        : `近 ${opts.windowDays} 天该流程重复出现 ${hit.count} 次（${hit.sessions.size} 个会话），建议沉淀为可复用资产`,
    });
  }

  // 4. 排序 + 上限
  suggestions.sort((a, b) => b.occurrences - a.occurrences || b.distinctSessions - a.distinctSessions);
  return suggestions.slice(0, opts.maxSuggestions);
}

/**
 * 便捷入口：直接从 ExecutionHistoryStore 查询窗口内记录并发现。
 *
 * @param store 已构造的 ExecutionHistoryStore
 * @param options 发现选项（windowDays 同时作用于 store 查询）
 */
export function discoverFromStore(
  store: { query(query?: { lastDays?: number }): ExecutionRecord[] },
  options: LoopDiscoveryOptions = {}
): LoopFlowSuggestion[] {
  const opts = { ...DEFAULT_LOOP_DISCOVERY_OPTIONS, ...options };
  const records = store.query({ lastDays: opts.windowDays });
  return discoverRepeatedFlows(records, options);
}
