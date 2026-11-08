/**
 * AgentFinding —— Finding 四要素契约（P3，Better Harness 增强方案 §P3）
 *
 * 职责：为沉淀建议（SedimentationSuggestion）提供 Finding-bound 契约：
 * 每条「建议升级为资产」的结论必须携带证据（可回放引用 P2 evidence-bundle）、
 * 有界影响（impact）、最小修复/落库范围（minFixScope）与验证路径（verifyRoute）。
 *
 * 设计约定（与 Better Harness 对齐）：
 * - 证据引用而非证据正文：evidence[].ref 指向 P2 bundle 中的可回放条目
 *   （execution-history 记录 id / v2 事件 id），禁止把对话原文塞进 Finding；
 * - 无证据候选不丢弃：进入 deferred 池（partitionByEvidence），保留工作理由
 *   （rationale），待后续窗口补齐证据再升级（"deferred ≠ rejected"）；
 * - 证据状态复用 P4 的七级 EvidenceState（eag/evaluator/types.ts），单一事实来源；
 * - 校验函数 validateFinding 是唯一 schema 关卡：writer 白名单、suggester 抽取
 *   与落盘前校验全部复用，非法 Finding 一律丢弃（不静默截断）。
 *
 * @module eag/dynamic/finding
 */

import type { EvidenceState } from "../evaluator/types";
import { EVIDENCE_STATES } from "../evaluator/types";

/** Finding 严重级别（与 BH Finding 模型对齐：blocker/major/warning/info） */
export type FindingSeverity = "blocker" | "major" | "warning" | "info";

/** 合法严重级别集合（运行时校验用） */
export const FINDING_SEVERITIES: ReadonlyArray<FindingSeverity> = Object.freeze([
  "blocker",
  "major",
  "warning",
  "info",
]);

/** 单条证据引用（可回放：ref 指向 P2 bundle / execution-history 的稳定标识） */
export type FindingEvidenceRef = {
  /** 证据来源类型：execution-history 记录 / v2 事件 / evidence-bundle 清单条目 */
  source: "execution-history" | "v2-event" | "evidence-bundle";
  /** 稳定引用标识（记录 id / 事件 id / bundle 内键），凭此可回放 */
  ref: string;
  /** 可选：一句话说明该证据支撑什么（中文，禁止携带对话原文与 PII） */
  note?: string;
};

/** AgentFinding —— 沉淀建议的 Finding 四要素契约 */
export type AgentFinding = {
  /** Finding 实例 id（建议生成侧分配；格式不限但必须非空） */
  id: string;
  /** 证据引用数组（至少 1 条才算 evidence-bound） */
  evidence: FindingEvidenceRef[];
  /** 有界影响：该模式重复发生造成的具体代价（中文，≤500 字） */
  impact: string;
  /** 最小修复/落库范围：最小可行动作（中文，≤500 字） */
  minFixScope: string;
  /** 验证路径：落库后如何验证生效（中文，≤500 字） */
  verifyRoute: string;
  /** 证据状态（七级，复用 P4 定义；Finding 侧最低要求 present） */
  evidenceState: EvidenceState;
  /** 严重级别 */
  severity: FindingSeverity;
};

/** Finding 文本字段长度上限（impact/minFixScope/verifyRoute 共用） */
export const FINDING_TEXT_MAX_CHARS = 500;

/** Finding 单条证据 note 长度上限 */
export const FINDING_NOTE_MAX_CHARS = 200;

/** evidence ref 字符长度上限（防把原文整段塞进来） */
export const FINDING_REF_MAX_CHARS = 200;

/**
 * 校验并规范化 Finding（唯一 schema 关卡）。
 *
 * 非法返回 undefined（调用方丢弃，不静默截断）：
 * - id 非空字符串；
 * - evidence 为非空数组且每条 source/ref 合法（ref 非空、≤200 字）；
 * - impact/minFixScope/verifyRoute 非空且 ≤500 字；
 * - evidenceState ∈ EVIDENCE_STATES；
 * - severity ∈ FINDING_SEVERITIES。
 *
 * @param raw 任意形态输入（LLM 原始输出/反序列化结果）
 * @returns 规范化后的 AgentFinding；非法返回 undefined
 */
export function validateFinding(raw: unknown): AgentFinding | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;

  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  if (!id || id.length > FINDING_REF_MAX_CHARS) {
    return undefined;
  }

  if (!Array.isArray(obj.evidence) || obj.evidence.length === 0) {
    return undefined;
  }
  const evidence: FindingEvidenceRef[] = [];
  for (const item of obj.evidence) {
    if (!item || typeof item !== "object") {
      return undefined;
    }
    const e = item as Record<string, unknown>;
    if (e.source !== "execution-history" && e.source !== "v2-event" && e.source !== "evidence-bundle") {
      return undefined;
    }
    const ref = typeof e.ref === "string" ? e.ref.trim() : "";
    if (!ref || ref.length > FINDING_REF_MAX_CHARS) {
      return undefined;
    }
    // P2 修复：note 是有界辅助说明字段，超长时保尾截断（尾部说明通常更关键），
    // 不再 head-only 丢尾。结构化字段（id/ref/impact...）非法仍一律拒绝，不静默截断。
    const note = typeof e.note === "string" ? e.note.trim().slice(-FINDING_NOTE_MAX_CHARS) : undefined;
    evidence.push(note ? { source: e.source, ref, note } : { source: e.source, ref });
  }

  const impact = typeof obj.impact === "string" ? obj.impact.trim() : "";
  const minFixScope = typeof obj.minFixScope === "string" ? obj.minFixScope.trim() : "";
  const verifyRoute = typeof obj.verifyRoute === "string" ? obj.verifyRoute.trim() : "";
  if (
    !impact ||
    impact.length > FINDING_TEXT_MAX_CHARS ||
    !minFixScope ||
    minFixScope.length > FINDING_TEXT_MAX_CHARS ||
    !verifyRoute ||
    verifyRoute.length > FINDING_TEXT_MAX_CHARS
  ) {
    return undefined;
  }

  const evidenceState = obj.evidenceState as EvidenceState;
  if (!EVIDENCE_STATES.includes(evidenceState)) {
    return undefined;
  }

  const severity = obj.severity as FindingSeverity;
  if (!FINDING_SEVERITIES.includes(severity)) {
    return undefined;
  }

  return { id, evidence, impact, minFixScope, verifyRoute, evidenceState, severity };
}

/** partitionByEvidence 的返回结构 */
export type FindingPartition<T> = {
  /** 携带合法 Finding 的建议（evidence-bound，可进入落库流程） */
  bound: Array<T & { finding: AgentFinding }>;
  /** 无证据候选（deferred 池：保留建议与理由，待补证据后升级） */
  deferred: T[];
};

/**
 * 按证据绑定状态划分建议集合（deferred 池入口）。
 *
 * - 携带合法 Finding 的建议 → bound；
 * - Finding 缺失或非法的建议 → deferred（不丢弃，保留 rationale）。
 *
 * @param suggestions 建议数组（元素须含可选 finding 字段）
 */
export function partitionByEvidence<T extends { finding?: AgentFinding }>(
  suggestions: readonly T[]
): FindingPartition<T> {
  const bound: Array<T & { finding: AgentFinding }> = [];
  const deferred: T[] = [];
  for (const suggestion of suggestions) {
    // P2 修复：仅判 truthy 不足——外部可能传入未过 schema 的 finding 对象。
    // 统一走 validateFinding 唯一 schema 关卡，非法 finding 降级进 deferred（不丢弃建议）。
    const validated = suggestion.finding ? validateFinding(suggestion.finding) : undefined;
    if (validated) {
      bound.push({ ...suggestion, finding: validated });
    } else {
      deferred.push(suggestion);
    }
  }
  return { bound, deferred };
}
