/**
 * /history 命令处理器（一期 US-EH-005 + 二期 US-EH-008 双向关联）
 *
 * 处理 /history list、/history show、/history search、/history prune、/history help 等子命令。
 * 该命令在 CLI 层处理，不发送给 LLM——用户应能直接查看和管理自己的执行历史。
 *
 * 命令格式：
 *   /history                           显示帮助（等价于 /history help）
 *   /history list                      列出最近 50 条执行历史（表格格式）
 *   /history list --session <id>      只看指定 session 的历史
 *   /history list --tool bash          只看 bash 工具
 *   /history list --days 7             最近 7 天
 *   /history list --failed             只看失败记录
 *   /history show <recordId>           显示单条完整记录（含输出摘要、关联产出物、二期关联 MemoryEntry）
 *   /history search <keyword>          关键词搜索（args/output/cwd 模糊匹配）
 *   /history prune                     执行自动裁剪（每 session 限 500 条 + age ≤ 100 天）
 *   /history help                      显示帮助信息
 *
 * 设计依据：
 * - PRD §US-EH-005：CLI /history 命令实现
 * - PRD §US-EH-008 二期：/history show 同时显示关联 MemoryEntry 摘要
 * - 风格对齐：memory-commands.ts（/memory 命令处理器）
 *
 * @module v2/memory/history-commands
 */

import type { ExecutionHistoryStore } from "./execution-history-store";
import type { ExecutionHistoryQuery, ExecutionRecord } from "./execution-history-types";

// 二期双向打通——HistoryCommandHandler 依赖二期模块，一期可以不传（MemoryStore 可选）
import type { MemoryStore } from "./memory-store";

/** /history list 默认返回条数 */
const DEFAULT_LIST_LIMIT = 50;
/** /history search 默认返回条数 */
const DEFAULT_SEARCH_LIMIT = 100;

/**
 * 命令处理结果
 * —— 对齐 MemoryCommandResult 风格
 */
export interface HistoryCommandResult {
  /** 是否处理成功 */
  success: boolean;
  /** 显示给用户的文本（多行字符串，已格式化） */
  output: string;
}

/**
 * 处理 /history 命令
 *
 * @param args 命令参数字符串（如 "list"、"show abc123"、"search build"）
 * @param store 执行历史存储实例
 * @param memoryStore 可选——二期 US-EH-008 双向关联时传入；一期不传则关联 section 跳过
 * @returns 命令处理结果的 Promise
 */
export async function handleHistoryCommand(
  args: string,
  store: ExecutionHistoryStore,
  memoryStore?: MemoryStore
): Promise<HistoryCommandResult> {
  const trimmed = args.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);

  if (tokens.length === 0 || tokens[0] === "help" || tokens[0] === "-h") {
    return { success: true, output: buildHelpText() };
  }

  const subcommand = tokens[0];
  const rest = tokens.slice(1).join(" ");

  switch (subcommand) {
    case "list":
      return handleList(rest, store);
    case "show":
      return handleShow(rest, store, memoryStore);
    case "search":
      return handleSearch(rest, store);
    case "prune":
      return handlePrune(store);
    default:
      return {
        success: false,
        output: `✖ 未知的 /history 子命令: ${subcommand}\n\n${buildHelpText()}`,
      };
  }
}

// ========== /history list ==========

async function handleList(args: string, store: ExecutionHistoryStore): Promise<HistoryCommandResult> {
  const query = parseListArgs(args);
  const records = store.query(query);

  if (records.length === 0) {
    return {
      success: true,
      output:
        "📋 执行历史为空\n\n" + "本项目暂无执行历史记录。\n" + "使用 LLM 执行 bash/write/edit 工具后，历史会自动记录。",
    };
  }

  return { success: true, output: formatListTable(records) };
}

/** 解析 /history list 的参数——支持 --session / --tool / --days / --failed / --limit */
function parseListArgs(args: string): ExecutionHistoryQuery {
  const query: ExecutionHistoryQuery = {};
  const tokens = args.split(/\s+/).filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = () => tokens[++i];

    switch (token) {
      case "--session":
        query.sessionId = next();
        break;
      case "--tool":
      case "--toolName":
        query.toolName = next();
        break;
      case "--days":
      case "--lastDays": {
        const days = parseInt(next() ?? "", 10);
        if (!Number.isNaN(days) && days > 0) query.lastDays = days;
        break;
      }
      case "--failed":
        query.ok = false;
        break;
      case "--ok":
        query.ok = true;
        break;
      case "--limit": {
        const limit = parseInt(next() ?? "", 10);
        if (!Number.isNaN(limit) && limit > 0) query.limit = limit;
        break;
      }
      case "--asc":
        query.order = "asc";
        break;
    }
  }

  if (!query.limit) query.limit = DEFAULT_LIST_LIMIT;
  return query;
}

/**
 * 格式化列表表格输出
 * —— 7 列：DATE / SESSION / TOOL / OK / EXIT / DURATION / CWD
 */
function formatListTable(records: ExecutionRecord[]): string {
  // 表头
  const header = "DATE        SESSION          TOOL           OK     EXIT   DURATION   CWD";
  const separator = "──────────  ────────────────  ──────────────  ─────  ────  ─────────  ──────────────";
  const rows = records.map((r) => {
    const date = r.date.padEnd(10, " ");
    const session = truncate(r.sessionId, 16).padEnd(16, " ");
    const tool = truncate(r.toolName, 14).padEnd(14, " ");
    const ok = (r.ok ? "✓" : "✗").padEnd(5, " ");
    const exit = (r.exitCode !== undefined && r.exitCode !== null ? String(r.exitCode) : "-").padEnd(4, " ");
    const dur = formatDuration(r.durationMs).padEnd(8, " ");
    const cwd = truncate(r.cwd ?? "-", 14).padEnd(14, " ");
    return `${date}  ${session}  ${tool}  ${ok}  ${exit}  ${dur}  ${cwd}`;
  });

  // 汇总脚注
  const totalSessions = new Set(records.map((r) => r.sessionId)).size;
  const successCount = records.filter((r) => r.ok).length;
  const failCount = records.length - successCount;
  const footer =
    `\n📊 共 ${records.length} 条 · ${totalSessions} 个 session · ` +
    `成功 ${successCount} · 失败 ${failCount} · 文件 ${records.filter((r) => r.outputs?.length ?? 0).length} 条带产出物`;

  return `${header}\n${separator}\n${rows.join("\n")}${footer}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "-";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = (sec % 60).toFixed(0);
  return `${min}m${remSec}s`;
}

// ========== /history show ==========

async function handleShow(
  args: string,
  store: ExecutionHistoryStore,
  memoryStore?: MemoryStore
): Promise<HistoryCommandResult> {
  const recordId = args.trim();
  if (!recordId) {
    return { success: false, output: "✖ 请提供 recordId，例如: /history show abc123" };
  }

  // 先查本 session 缓存 + 文件——query 用 keyword 匹配 id
  const all = store.query({ limit: 5000 });
  const record = all.find((r) => r.id === recordId);
  if (!record) {
    return { success: false, output: `✖ 找不到 recordId = ${recordId} 的历史记录` };
  }

  let output = formatRecordDetail(record);

  // 二期：如果有 memoryEntryIds + memoryStore，追加关联 MemoryEntry 摘要
  if (record.memoryEntryIds && record.memoryEntryIds.length > 0 && memoryStore) {
    output += "\n\n🔗 关联经验 (MemoryStore)：";
    for (const memId of record.memoryEntryIds) {
      try {
        const entry = memoryStore.getById(memId);
        if (entry) {
          output += `\n  • [${entry.type}] ${entry.value.slice(0, 100)}`;
        }
      } catch {
        // MemoryStore.getById 可能不存在或抛错——跳过
      }
    }
  }

  return { success: true, output };
}

function formatRecordDetail(r: ExecutionRecord): string {
  const lines: string[] = [];
  lines.push(`## 📜 ExecutionRecord ${r.id}`);
  lines.push("");
  lines.push(
    `**Session**: ${r.sessionId}  **Turn**: ${r.turnIndex}  **Date**: ${r.date}  **Timestamp**: ${r.timestamp}`
  );
  lines.push(`**Tool**: \`${r.toolName}\`  **OK**: ${r.ok ? "✓ Success" : "✗ Fail"}`);
  lines.push("");

  if (r.toolName === "bash") {
    lines.push("### Bash Meta");
    lines.push(`- Exit Code: ${r.exitCode ?? "-"}`);
    lines.push(`- Signal: ${r.signal ?? "-"}`);
    lines.push(`- CWD: ${r.cwd ?? "-"}`);
    lines.push(`- Timeout: ${r.timedOut ? "Yes" : "No"}`);
    lines.push(`- Duration: ${formatDuration(r.durationMs)}`);
    lines.push(`- PID: ${r.pid ?? "-"}`);
    lines.push("");
  }

  if (r.argsSnippet) {
    lines.push("### Args");
    lines.push("```json");
    lines.push(r.argsSnippet.slice(0, 2000));
    lines.push("```");
    lines.push("");
  }

  if (r.outputSnippet) {
    lines.push("### Output");
    lines.push("```");
    lines.push(r.outputSnippet.slice(0, 3000));
    lines.push("```");
    lines.push("");
  }

  if (r.errorSnippet) {
    lines.push("### Error");
    lines.push("```");
    lines.push(r.errorSnippet.slice(0, 2000));
    lines.push("```");
    lines.push("");
  }

  if (r.outputs && r.outputs.length > 0) {
    lines.push(`### 📦 Outputs / Artifacts (${r.outputs.length})`);
    for (const artifact of r.outputs) {
      const kindIcon = { created: "📝", modified: "✏️", deleted: "🗑️", "bash-output": "📦" }[artifact.kind] ?? "•";
      const sizeInfo =
        artifact.afterSize !== undefined
          ? ` (${(artifact.afterSize / 1024).toFixed(1)}KB)`
          : artifact.beforeSize !== undefined
            ? ` (from ${(artifact.beforeSize / 1024).toFixed(1)}KB)`
            : "";
      const desc = artifact.description ? ` — ${artifact.description}` : "";
      lines.push(`- ${kindIcon} \`${artifact.path}\${sizeInfo}${desc}`);
    }
    lines.push("");
  }

  // 二期字段
  if (r.memoryEntryIds && r.memoryEntryIds.length > 0) {
    lines.push(`**🔗 MemoryEntry IDs**: ${r.memoryEntryIds.join(", ")}`);
  }
  if (r.fixedByExecutionId) {
    lines.push(`**🔧 Fixed By**: ${r.fixedByExecutionId}`);
  }

  return lines.join("\n");
}

// ========== /history search ==========

async function handleSearch(args: string, store: ExecutionHistoryStore): Promise<HistoryCommandResult> {
  const keyword = args.trim();
  if (!keyword) {
    return { success: false, output: "✖ 请提供搜索关键词，例如: /history search build" };
  }

  const records = store.query({ keyword, limit: DEFAULT_SEARCH_LIMIT });
  if (records.length === 0) {
    return { success: true, output: `🔍 未找到匹配 "${keyword}" 的执行历史记录` };
  }

  const header = `🔍 搜索 "${keyword}" — 找到 ${records.length} 条`;
  const table = formatListTable(records);
  return { success: true, output: `${header}\n\n${table}` };
}

// ========== /history prune ==========

async function handlePrune(store: ExecutionHistoryStore): Promise<HistoryCommandResult> {
  const stats = store.prune();
  return {
    success: true,
    output:
      `✂️ 裁剪完成\n\n` +
      `• 按 session 超量裁剪: ${stats.prunedBySession} 条\n` +
      `• 按 age 超龄裁剪: ${stats.prunedByAge} 条\n` +
      `• 裁剪后剩余: ${stats.totalRemaining} 条`,
  };
}

// ========== Help ==========

function buildHelpText(): string {
  return [
    "## 📜 /history 执行历史命令",
    "",
    "查看和管理本项目的工具执行历史（bash / write / edit / skill 等）。",
    "",
    "### 子命令",
    "",
    "| 命令 | 说明 |",
    "|---|---|",
    "| `/history` / `/history help` | 显示本帮助 |",
    "| `/history list` | 列出最近 50 条（可加参数过滤） |",
    "| `/history list --session <id>` | 只看指定 session |",
    "| `/history list --tool bash` | 只看指定工具 |",
    "| `/history list --days 7` | 最近 7 天 |",
    "| `/history list --failed` | 只看失败记录 |",
    "| `/history show <recordId>` | 显示单条完整记录 |",
    "| `/history search <keyword>` | 关键词搜索（args / output / cwd 模糊匹配） |",
    "| `/history prune` | 执行自动裁剪（每 session ≤ 500 条 + age ≤ 100 天） |",
    "",
    "### 文件位置",
    "",
    "```",
    "~/.deepcode/projects/<projectCode>/execution-history.jsonl",
    "```",
    "",
    "（JSON Lines 格式，每行一条记录；二期 US-EH-008 支持与 /memory 双向关联）",
  ].join("\n");
}
