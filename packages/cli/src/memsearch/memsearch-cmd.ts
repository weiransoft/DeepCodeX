/**
 * memsearch-cmd.ts — `deepcode memsearch` 子命令
 *
 * 官方 memsearch CLI 的 DeepCodeX 入口：search / index / expand / stats。
 * 契约对齐 eag-cmd.ts：human-first 摘要 + --format json 机器模式；
 * 失败只写 stderr（绝不输出半成品 JSON），错误隔离不抛给调用方。
 */

import {
  MEMSEARCH_INSTALL_HINT,
  expandMemories,
  indexMemories,
  memsearchStats,
  searchMemories,
  type MemsearchOutcomeBase,
} from "@vegamo/deepcode-core";

export type MemsearchSubcommand = "search" | "index" | "expand" | "stats" | "help";

export interface MemsearchCommandArgs {
  readonly subcommand: MemsearchSubcommand;
  /** 位置参数：search 的查询词、index 的路径、expand 的 chunk_hash */
  readonly query: readonly string[];
  readonly topK?: number;
  readonly collection?: string;
  readonly sourcePrefix?: string;
  readonly force?: boolean;
  readonly format?: "summary" | "json";
}

export interface MemsearchCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const PREVIEW_CHARS = 240;

export function formatMemsearchHelp(): string {
  return [
    "用法：deepcode memsearch <subcommand> [args] [options]",
    "",
    "基于官方 memsearch CLI 的三层渐进记忆召回（Markdown 为源，Milvus 影子索引）。",
    "",
    "子命令：",
    "  search <query...>       混合检索（BM25 + dense + RRF），返回带 chunk_hash 的摘要",
    "  expand <chunk_hash>     展开命中 chunk 的完整 heading 章节（L2）",
    "  index <path...>         索引 markdown 文件或目录",
    "  stats                   查询索引规模",
    "  help                    显示此帮助",
    "",
    "选项：",
    "  --top-k <n>             返回条数，1-50（默认 5）",
    "  --collection <name>     覆盖 Milvus collection（默认读 ~/.memsearch/config.toml）",
    "  --source-prefix <path>  只检索 source 以该前缀开头的 chunk（用于 per-user 隔离）",
    "  --force                 index 时强制全量重嵌入",
    "  --format <summary|json> 输出格式（默认 summary）",
    "",
    "示例：",
    "  deepcode memsearch search 无进展熔断阈值",
    '  deepcode memsearch search "语音 TNS" --top-k 10 --format json',
    "  deepcode memsearch expand 3ae1e0f660051529",
    "  deepcode memsearch index ./docs",
    "  deepcode memsearch stats",
    "",
    "依赖：需安装官方 CLI —— " + MEMSEARCH_INSTALL_HINT,
    "",
  ].join("\n");
}

function fail(message: string, exitCode = 1): MemsearchCommandResult {
  process.stderr.write(message + "\n");
  return { exitCode, stdout: "", stderr: message };
}

function emit(text: string): MemsearchCommandResult {
  process.stdout.write(text + "\n");
  return { exitCode: 0, stdout: text, stderr: "" };
}

function jsonOut(payload: unknown): MemsearchCommandResult {
  return emit(JSON.stringify(payload, null, 2));
}

function baseFields(outcome: MemsearchOutcomeBase): Record<string, unknown> {
  return {
    ok: outcome.ok,
    status: outcome.status,
    reason: outcome.reason,
    hint: outcome.hint,
    cliVersion: outcome.cliVersion,
    durationMs: outcome.durationMs,
  };
}

function preview(content: string): string {
  return content.length > PREVIEW_CHARS ? `${content.slice(0, PREVIEW_CHARS)}…` : content;
}

export async function executeMemsearchCommand(args: MemsearchCommandArgs): Promise<MemsearchCommandResult> {
  if (args.subcommand === "help") return emit(formatMemsearchHelp());

  const positional = args.query.filter((p) => p.trim().length > 0);
  const asJson = args.format === "json";
  const common = { collection: args.collection };

  if (args.subcommand === "search") {
    const query = positional.join(" ").trim();
    if (!query) return fail("[memsearch] search 需要查询文本", 2);
    const outcome = await searchMemories({
      ...common,
      query,
      topK: args.topK,
      sourcePrefix: args.sourcePrefix,
    });
    if (!outcome.ok)
      return fail(`[memsearch] ${outcome.status}: ${outcome.reason}${outcome.hint ? ` | ${outcome.hint}` : ""}`);
    if (asJson)
      return jsonOut({ ...baseFields(outcome), results: outcome.results, droppedCount: outcome.droppedCount });
    const lines = [`# memsearch 检索：${query}（${outcome.results.length} 条）`, ""];
    for (const [i, r] of outcome.results.entries()) {
      lines.push(
        `${i + 1}. [${r.score.toFixed(4)}] ${r.heading || "(无标题)"}  ${r.source}:${r.start_line}-${r.end_line}`
      );
      lines.push(`   hash: ${r.chunk_hash}`);
      lines.push(`   ${preview(r.content).replace(/\n/g, " ")}`);
    }
    if (outcome.results.length === 0) lines.push("（无命中；请确认已 index 对应 markdown 语料）");
    return emit(lines.join("\n"));
  }

  if (args.subcommand === "expand") {
    const hash = positional[0] ?? "";
    if (!hash) return fail("[memsearch] expand 需要 chunk_hash", 2);
    const outcome = await expandMemories({ ...common, chunkHash: hash });
    if (!outcome.ok)
      return fail(`[memsearch] ${outcome.status}: ${outcome.reason}${outcome.hint ? ` | ${outcome.hint}` : ""}`);
    if (asJson) return jsonOut({ ...baseFields(outcome), expansion: outcome.expansion });
    return emit(outcome.expansion?.content ?? "(空章节)");
  }

  if (args.subcommand === "index") {
    if (positional.length === 0) return fail("[memsearch] index 需要至少一个路径", 2);
    const outcome = await indexMemories({ ...common, paths: positional, force: args.force });
    if (!outcome.ok)
      return fail(`[memsearch] ${outcome.status}: ${outcome.reason}${outcome.hint ? ` | ${outcome.hint}` : ""}`);
    if (asJson) return jsonOut({ ...baseFields(outcome), indexedChunks: outcome.indexedChunks });
    return emit(outcome.reason);
  }

  if (args.subcommand === "stats") {
    const outcome = await memsearchStats(common);
    if (!outcome.ok)
      return fail(`[memsearch] ${outcome.status}: ${outcome.reason}${outcome.hint ? ` | ${outcome.hint}` : ""}`);
    if (asJson) return jsonOut({ ...baseFields(outcome), totalChunks: outcome.totalChunks });
    return emit(outcome.reason);
  }

  return fail(`[memsearch] 未知子命令：${String(args.subcommand)}`, 2);
}
