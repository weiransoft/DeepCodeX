/**
 * 结果聚合：把 N 个子任务的产出合成一份对用户有用的报告
 *
 * ## 为什么聚合也要有降级
 *
 * 聚合是一次附加的 LLM 调用——它能让报告读起来像"人总结的"，
 * 但它失败不该让用户拿不到结果。所以 `aggregateResults` 在三种情况
 * （显式关闭 / LLM 不可用 / 调用失败）下一律回落到 `renderLocalReport`，
 * 只把 `aggregated` 标为 false，报告结构不变。
 *
 * ## 为什么截断而不是全量喂
 *
 * 6 个子任务 × 完整输出可能几万 token。聚合的价值在"归纳"，不在"复述"；
 * 每个子任务保留前 1200 字符足以让模型判断做了什么、卡在哪。
 *
 * @module team/orchestrator/aggregate
 */

import type { OpenAIClientHandle } from "../../common/openai-client.js";
import { callLlmOnce } from "./llm-once.js";
import type { OrchestrationAggregate, OrchestrationSubtaskResult } from "./types.js";

/** 单个子任务输出进入聚合 prompt 的截断长度 */
const OUTPUT_EXCERPT_IN_PROMPT = 1200;

/** 报告里单个子任务输出摘录长度 */
const OUTPUT_EXCERPT_IN_REPORT = 600;

/** 聚合器系统提示 */
export const AGGREGATE_SYSTEM_PROMPT = [
  "你是一个多角色协作的结果汇总者。多个角色分别完成了同一个目标的子任务，现在需要你写一份汇总报告。",
  "",
  "要求：",
  "1. 只用中文，Markdown 格式，控制在 800 字以内。",
  "2. 结构固定为四节：## 完成了什么 / ## 关键改动与产出 / ## 未完成与风险 / ## 建议的下一步。",
  "3. 严格基于给定信息，不要编造没有出现的文件名、函数名或结论。",
  "4. 失败或被跳过的子任务必须在「未完成与风险」里点名，说明它挡住了什么。",
  "5. 不要复述每个子任务的全文，只做归纳。",
].join("\n");

/** 状态中文标签 */
const STATUS_LABELS: Record<OrchestrationSubtaskResult["status"], string> = {
  succeeded: "成功",
  failed: "失败",
  skipped: "跳过",
  cancelled: "已取消",
};

/** 构造聚合用 user prompt */
export function buildAggregateUserPrompt(params: {
  goal: string;
  rationale: string;
  results: ReadonlyArray<OrchestrationSubtaskResult>;
}): string {
  const { goal, rationale, results } = params;
  const blocks = results.map((result) => {
    const excerpt = truncate(result.output, OUTPUT_EXCERPT_IN_PROMPT);
    const lines = [
      `### 子任务 ${result.id}：${result.title}`,
      `- 角色: ${result.roleName ?? "(未派单)"}`,
      `- 状态: ${STATUS_LABELS[result.status]}`,
      `- 轮次/工具调用: ${result.rounds}/${result.toolCalls}`,
      result.error ? `- 错误: ${result.error}` : "",
      result.blockedBy && result.blockedBy.length > 0 ? `- 被阻塞于: ${result.blockedBy.join(", ")}` : "",
      excerpt ? `- 输出摘录:\n${excerpt}` : "- 输出摘录: (无)",
    ];
    return lines.filter((line) => line !== "").join("\n");
  });

  return [`目标: ${goal}`, rationale ? `拆解理由: ${rationale}` : "", "", ...blocks]
    .filter((line) => line !== "")
    .join("\n\n");
}

/**
 * 本地拼装报告（降级路径）
 *
 * 刻意做成"即使没有 LLM 也能交付"的形态：用户至少能看到每个子任务的状态、
 * 谁做的、卡在哪。这比返回一句"聚合失败"有用得多。
 */
export function renderLocalReport(params: {
  goal: string;
  rationale: string;
  results: ReadonlyArray<OrchestrationSubtaskResult>;
  serializedNote?: string;
  undocumentedChanges?: ReadonlyArray<string>;
}): string {
  const { goal, rationale, results, serializedNote, undocumentedChanges } = params;
  const succeeded = results.filter((result) => result.status === "succeeded");
  const unfinished = results.filter((result) => result.status !== "succeeded");

  const lines: string[] = [`## 编排结果：${goal}`, ""];
  if (rationale) {
    lines.push(`**拆解思路**：${rationale}`, "");
  }

  lines.push(
    "| 子任务 | 角色 | 状态 | 轮次 | 工具调用 | 耗时 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${r.id} ${escapeCell(r.title)} | ${escapeCell(r.roleName ?? "-")} | ${STATUS_LABELS[r.status]} | ${r.rounds} | ${r.toolCalls} | ${r.durationMs}ms |`
    ),
    ""
  );

  lines.push("### 关键产出", "");
  if (succeeded.length === 0) {
    lines.push("（没有子任务成功完成）", "");
  } else {
    for (const result of succeeded) {
      const excerpt = truncate(result.output, OUTPUT_EXCERPT_IN_REPORT);
      lines.push(`**${result.id} ${result.title}**`, "", excerpt || "(无输出)", "");
    }
  }

  if (unfinished.length > 0) {
    lines.push("### 未完成与风险", "");
    for (const result of unfinished) {
      const reason = result.error ?? result.blockedBy?.join(", ") ?? "";
      lines.push(`- **${result.id} ${result.title}**（${STATUS_LABELS[result.status]}）：${reason || "无说明"}`);
    }
    lines.push("");
  }

  if (serializedNote) {
    lines.push("### 并发调整", "", serializedNote, "");
  }

  if (undocumentedChanges && undocumentedChanges.length > 0) {
    lines.push(
      "### 未声明的改动（需人工确认）",
      "",
      "以下文件被修改，但没有任何子任务声明它们——可能是子任务顺手改的，也可能是原本就有的改动：",
      "",
      ...undocumentedChanges.slice(0, 20).map((file) => `- \`${file}\``),
      undocumentedChanges.length > 20 ? `- ……共 ${undocumentedChanges.length} 个` : "",
      ""
    );
  }

  return lines
    .filter((line) => line !== undefined)
    .join("\n")
    .trimEnd();
}

/** 聚合入口 */
export async function aggregateResults(params: {
  goal: string;
  rationale: string;
  results: ReadonlyArray<OrchestrationSubtaskResult>;
  handle: OpenAIClientHandle | null;
  /** false = 显式跳过 LLM 聚合（--no-aggregate） */
  enabled: boolean;
  serializedNote?: string;
  undocumentedChanges?: ReadonlyArray<string>;
  timeoutMs?: number;
}): Promise<OrchestrationAggregate> {
  const { goal, rationale, results, handle, enabled, serializedNote, undocumentedChanges } = params;

  const fallback = (error?: string): OrchestrationAggregate => ({
    text: renderLocalReport({ goal, rationale, results, serializedNote, undocumentedChanges }),
    aggregated: false,
    ...(error ? { error } : {}),
  });

  if (!enabled) return fallback();
  if (handle === null) return fallback("LLM 不可用，聚合已降级为本地拼装");

  const userPrompt = buildAggregateUserPrompt({ goal, rationale, results });
  const response = await callLlmOnce(handle, AGGREGATE_SYSTEM_PROMPT, userPrompt, params.timeoutMs);

  if (!response.ok) {
    return fallback(`聚合调用失败: ${response.message}`);
  }

  // LLM 版报告后面追加"并发调整 / 未声明改动"两节：
  // 这两类信息属于编排事实，不该指望模型忠实转述，直接由代码补上更可靠。
  const appendix: string[] = [];
  if (serializedNote) appendix.push("### 并发调整", "", serializedNote, "");
  if (undocumentedChanges && undocumentedChanges.length > 0) {
    appendix.push(
      "### 未声明的改动（需人工确认）",
      "",
      ...undocumentedChanges.slice(0, 20).map((file) => `- \`${file}\``),
      ""
    );
  }

  return {
    text: [response.content, ...appendix].join("\n").trim(),
    aggregated: true,
  };
}

/** 按字符截断并加省略标记 */
function truncate(text: string, limit: number): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}\n…（已截断，原文 ${trimmed.length} 字符）`;
}

/** 转义 Markdown 表格单元格里的竖线 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
