/**
 * memory-search-tool.ts — memory_search LLM 工具（按需记忆召回）
 *
 * 与「会话创建时静态注入 Top-N 记忆」互补：LLM 手里有当前问题，可自主决定
 * 何时检索。L1 返回带 score 的摘要 + chunk_hash，L2 用 expand_hash 展开完整章节。
 *
 * 诚实降级：外部 CLI 缺失/超时/失败时返回 ok:false + 具体 status/reason/hint，
 * 绝不返回空结果伪装成功。
 */

import type { ToolDefinition } from "../prompt";
import { expandMemories, searchMemories, type MemsearchRunner } from "../common/memsearch-bridge";

/** 注入依赖：测试可传 runner 替身，生产留空走真实 spawn */
export interface MemorySearchHandlerDeps {
  readonly runner?: MemsearchRunner;
  readonly bin?: string;
  readonly timeoutMs?: number;
  /** 默认 collection（未指定时由 ~/.memsearch/config.toml 决定） */
  readonly collection?: string;
  /** per-user 隔离前缀 */
  readonly sourcePrefix?: string;
}

/** L1 摘要里单条 content 的预览长度，完整内容走 L2 expand */
const PREVIEW_CHARS = 300;

export function getMemorySearchToolDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "Search the user's long-term memory (indexed markdown knowledge base) with hybrid BM25 + dense retrieval. " +
        "Use this when you need facts about past decisions, project conventions, prior fixes, or user preferences " +
        "that are not in the current conversation. Returns ranked excerpts with chunk_hash; pass a chunk_hash " +
        "back via expand_hash to read the full section (progressive disclosure). " +
        "If the tool reports ok:false, say the memory backend was unavailable — do NOT invent recalled facts.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language search query. Required unless expand_hash is provided.",
          },
          top_k: {
            type: "number",
            description: "Max number of results, 1-50. Default: 5.",
          },
          expand_hash: {
            type: "string",
            description: "chunk_hash from a previous memory_search result; expands the full heading section (L2).",
          },
          collection: {
            type: "string",
            description: "Optional Milvus collection override. Defaults to ~/.memsearch/config.toml.",
          },
        },
        additionalProperties: false,
      },
    },
  };
}

function toPreview(content: string): string {
  return content.length > PREVIEW_CHARS ? `${content.slice(0, PREVIEW_CHARS)}…` : content;
}

export function createMemorySearchHandler(deps: MemorySearchHandlerDeps = {}) {
  return async function memorySearchHandler(
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; name: string; output?: string; error?: string }> {
    const name = "memory_search";
    const expandHash = typeof args.expand_hash === "string" ? args.expand_hash.trim() : "";
    const collection =
      typeof args.collection === "string" && args.collection.trim().length > 0
        ? args.collection.trim()
        : deps.collection;
    const common = {
      runner: deps.runner,
      bin: deps.bin,
      timeoutMs: deps.timeoutMs,
      collection,
    };

    try {
      if (expandHash.length > 0) {
        const outcome = await expandMemories({ ...common, chunkHash: expandHash });
        return {
          ok: outcome.ok,
          name,
          output: JSON.stringify(
            {
              ok: outcome.ok,
              status: outcome.status,
              reason: outcome.reason,
              hint: outcome.hint,
              cliVersion: outcome.cliVersion,
              action: "expand",
              expansion: outcome.expansion,
            },
            null,
            2
          ),
          error: outcome.ok
            ? undefined
            : `[${outcome.status}] ${outcome.reason}${outcome.hint ? ` | ${outcome.hint}` : ""}`,
        };
      }

      const query = typeof args.query === "string" ? args.query.trim() : "";
      const topK = typeof args.top_k === "number" && Number.isFinite(args.top_k) ? args.top_k : 5;
      const outcome = await searchMemories({
        ...common,
        query,
        topK,
        sourcePrefix: deps.sourcePrefix,
      });
      return {
        ok: outcome.ok,
        name,
        output: JSON.stringify(
          {
            ok: outcome.ok,
            status: outcome.status,
            reason: outcome.reason,
            hint: outcome.hint,
            cliVersion: outcome.cliVersion,
            action: "search",
            query,
            droppedCount: outcome.droppedCount,
            results: outcome.results.map((r) => ({
              chunk_hash: r.chunk_hash,
              heading: r.heading,
              source: r.source,
              score: r.score,
              start_line: r.start_line,
              end_line: r.end_line,
              preview: toPreview(r.content),
            })),
          },
          null,
          2
        ),
        error: outcome.ok
          ? undefined
          : `[${outcome.status}] ${outcome.reason}${outcome.hint ? ` | ${outcome.hint}` : ""}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, name, error: `memory_search failed: ${message}` };
    }
  };
}
