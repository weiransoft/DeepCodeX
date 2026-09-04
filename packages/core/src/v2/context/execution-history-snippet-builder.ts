/**
 * execution-history-snippet-builder.ts — 二期 US-EH-006：execution_history ContextSnippet 构建入口
 *
 * 轻量封装：dual-layer-manager.ts 4.11 块调用它，拿到 ContextSnippet
 * （type = "execution_history"）后与其他 4 类片段同通道收集，最终由 injectSnippets
 * 统一拼成一个 system 消息注入 V2 上下文。
 *
 * Anchor 文件零改动：不依赖 executor/prompt/tool-types
 */

import type { ContextSnippet } from "../integration/session-hook";
import type { ExecutionHistoryStore } from "../memory/execution-history-store";
import type { ExecutionTaskType } from "../memory/execution-history-summary-builder";
import { ExecutionHistorySummaryBuilder } from "../memory/execution-history-summary-builder";

/**
 * 构建 execution_history ContextSnippet
 * —— 传入 store + taskType，返回 { type: "execution_history", content: "...", relevance: N }
 * —— 如果 store 为空或 summary 无内容，返回 null（dual-layer-manager 跳过这一类）
 */
export function buildExecutionHistorySnippet(
  store: ExecutionHistoryStore | null | undefined,
  taskType: ExecutionTaskType = "general",
  projectRoot: string = ""
): ContextSnippet | null {
  if (!store) return null;

  try {
    const builder = ExecutionHistorySummaryBuilder.get();
    const { entries, totalTokens } = builder.buildForContext(store, taskType);

    if (entries.length === 0) return null;

    // 格式化 ContextSnippet.content（简短 markdown，每条一行）
    const lines: string[] = ["## 最近执行历史（execution history）", ""];
    for (const entry of entries) {
      lines.push(`- \`${entry.trigger}\` → **${entry.result}** (${entry.date})`);
    }
    lines.push("");
    lines.push(`_共 ${entries.length} 条，估算 ${totalTokens} tokens_`);

    return {
      type: "execution_history",
      source: projectRoot || "execution-history",
      content: lines.join("\n"),
      relevance: 0.7, // relevance 字段（对齐 ContextSnippet 接口）
    };
  } catch {
    // fail-safe：SummaryBuilder 抛错时返回 null，不让整个 buildOptimizedContext 崩溃
    return null;
  }
}
