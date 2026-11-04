/**
 * Super Agent Worker 报告 —— 结构化产出
 *
 * ## 硬约束
 *
 * 🔴 **不得从报告的自由文本推断状态**。Worker 必须显式输出结构化 JSON；
 * 解析失败时**降级为 `failed`**并如实说明「输出无法解析」——
 * 绝不猜测成功与否。
 *
 * @module super-agent/worker/report
 */

import type { WorkerReport, WorkerReportKind } from "../domain/types.js";

/** Worker 输出契约（Worker 必须按此格式回话） */
export const WORKER_OUTPUT_CONTRACT = `你必须在最终回复中输出一个 JSON 对象（不要有代码块以外的解释），格式：

{
  "kind": "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped",
  "summary": "一句话说明当前状态",
  "artifacts": ["本次产出的文件路径 / 命令 / 链接"],
  "attention": {
    "question": "需要人来回答的具体问题",
    "options": ["可选答案1", "可选答案2"],
    "blocking": true
  }
}

其中：
- "kind" 必须取上述六值之一；
- "artifacts" 可为空数组；
- "attention" 仅在确实需要人来决策时给出，否则省略该字段；
- 不要在 JSON 前后添加任何解释性文字。`;

/** 合法的报告种类 */
const REPORT_KINDS: readonly WorkerReportKind[] = ["progress", "waiting", "ready", "blocked", "failed", "dropped"];

/**
 * 构造进展报告
 *
 * @param summary 一句话说明
 * @param artifacts 产物引用
 * @returns WorkerReport
 */
export function buildProgressReport(summary: string, artifacts: readonly string[] = []): WorkerReport {
  return { kind: "progress", summary, artifacts: [...artifacts] };
}

/**
 * 构造就绪报告
 *
 * @param summary 一句话说明
 * @param artifacts 产物引用
 * @returns WorkerReport
 */
export function buildReadyReport(summary: string, artifacts: readonly string[] = []): WorkerReport {
  return { kind: "ready", summary, artifacts: [...artifacts] };
}

/**
 * 构造失败报告
 *
 * @param summary 失败原因
 * @param artifacts 已有产物（部分完成时）
 * @returns WorkerReport
 */
export function buildFailedReport(summary: string, artifacts: readonly string[] = []): WorkerReport {
  return { kind: "failed", summary, artifacts: [...artifacts] };
}

/**
 * 构造需要人决策的报告
 *
 * @param summary 一句话说明
 * @param attention 结构化问题
 * @param artifacts 产物引用
 * @returns WorkerReport
 */
export function buildAttentionReport(
  summary: string,
  attention: { question: string; options?: readonly string[]; blocking?: boolean },
  artifacts: readonly string[] = []
): WorkerReport {
  return {
    kind: attention.blocking === false ? "waiting" : "blocked",
    summary,
    artifacts: [...artifacts],
    attention: {
      question: attention.question,
      options: [...(attention.options ?? [])],
      blocking: attention.blocking !== false,
    },
  };
}

/**
 * 解析 Worker 输出为结构化报告
 *
 * @param text Worker 的原始输出
 * @returns 结构化报告（解析失败时返回 failed）
 */
export function parseWorkerReport(text: string): WorkerReport {
  const jsonText = extractJson(text);
  if (jsonText === null) {
    return {
      kind: "failed",
      summary: "Worker 输出无法解析为结构化报告（缺少 JSON 对象）。",
      artifacts: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {
      kind: "failed",
      summary: "Worker 输出不是合法 JSON。",
      artifacts: [],
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "failed", summary: "Worker 输出不是 JSON 对象。", artifacts: [] };
  }

  const record = parsed as Record<string, unknown>;
  const rawKind = record["kind"];
  const kind = REPORT_KINDS.find((candidate) => candidate === rawKind);
  if (kind === undefined) {
    return {
      kind: "failed",
      summary: `Worker 输出的 kind 非法：${String(rawKind)}`,
      artifacts: [],
    };
  }

  const summary = typeof record["summary"] === "string" ? record["summary"] : "";
  const rawArtifacts = record["artifacts"];
  const artifacts = Array.isArray(rawArtifacts)
    ? rawArtifacts.filter((item): item is string => typeof item === "string")
    : [];

  const rawAttention = record["attention"];
  if (rawAttention !== undefined && rawAttention !== null && typeof rawAttention === "object") {
    const attentionRecord = rawAttention as Record<string, unknown>;
    const question = typeof attentionRecord["question"] === "string" ? attentionRecord["question"] : "";
    if (question.trim().length > 0) {
      const rawOptions = attentionRecord["options"];
      const options = Array.isArray(rawOptions)
        ? rawOptions.filter((item): item is string => typeof item === "string")
        : [];
      const blocking = attentionRecord["blocking"] !== false;
      return {
        kind: kind === "progress" ? "waiting" : kind,
        summary,
        artifacts,
        attention: { question, options, blocking },
      };
    }
  }

  return { kind, summary, artifacts };
}

/**
 * 从文本中抽取 JSON 对象
 *
 * @param content 原始文本
 * @returns JSON 文本或 null
 */
function extractJson(content: string): string | null {
  const trimmed = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}
