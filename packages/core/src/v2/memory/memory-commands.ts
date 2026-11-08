/**
 * /memory 命令处理器
 *
 * 处理 /memory list、/memory delete、/memory delete-all、/memory review、/memory export、/memory search、/memory help 等子命令。
 * 该命令在 CLI 层处理，不发送给 LLM（用户隐私：用户应能直接管理自己的记忆）。
 *
 * 命令格式：
 *   /memory                    显示帮助（等价于 /memory help）
 *   /memory list               列出所有记忆（可加类型过滤：/memory list user_global）
 *   /memory delete <id>        删除指定 ID 的记忆
 *   /memory delete-all         提示用户使用 /memory delete-all DELETE ALL 二次确认
 *   /memory delete-all DELETE ALL   删除全部记忆文件（需严格匹配 "DELETE ALL" 令牌）
 *   /memory review             审查最近提取的记忆（显示最近 10 条）
 *   /memory export             导出所有记忆为 JSON 字符串
 *   /memory search <query>     按需检索长期记忆（外部 memsearch CLI，L1 摘要）
 *   /memory help               显示帮助信息
 *
 * 设计依据：
 * - V2 PRD §US-MEM-001：用户可查看和管理自己的记忆
 * - V2 PRD §US-PRIV-002：用户可删除全部记忆（需二次确认）
 * - V2 测试方案 §2.9 MEM-10（/memory list 命令）
 * - V2 技术方案 §8.7 隐私管理（MemoryPrivacyManager.deleteAll）
 *
 * @module v2/memory/memory-commands
 */

import type { MemoryStore } from "./memory-store";
import type { MemoryEntry, MemoryType } from "./types";
import type { MemoryPrivacyManager } from "./privacy-manager";
import { InvalidConfirmTokenError, type DeleteReport } from "./privacy-manager";

/**
 * 检索结果的结构化契约（与 common/memsearch-bridge 的 MemsearchSearchOutcome 兼容）。
 * V2.3 P1-05 单一入口约束：V2 模块不得直接 import V1 文件，故此处用结构化类型而非导入。
 */
export interface MemorySearchOutcomeLike {
  readonly ok: boolean;
  readonly status: string;
  readonly reason: string;
  readonly hint: string;
  readonly results: ReadonlyArray<{
    readonly chunk_hash: string;
    readonly content: string;
    readonly source: string;
    readonly heading: string;
    readonly start_line: number;
    readonly end_line: number;
    readonly score: number;
  }>;
}

/** 按需检索函数（由宿主注入，避免 core 命令处理器硬绑定外部进程） */
export type MemorySearchFn = (query: string, topK?: number) => Promise<MemorySearchOutcomeLike>;

/**
 * 命令处理结果
 *
 * 包含成功/失败状态、显示给用户的文本输出以及可选的结构化数据。
 * CLI 层根据 success 决定是否以错误码退出，output 用于直接打印。
 */
export interface MemoryCommandResult {
  /** 是否处理成功（语法/参数错误、记忆不存在等返回 false） */
  success: boolean;
  /** 显示给用户的文本（多行字符串，已格式化） */
  output: string;
  /** 结构化数据（可选，供调用方进一步处理） */
  data?: unknown;
}

/** /memory review 默认显示的最近条目数 */
const REVIEW_RECENT_COUNT = 10;

/** 支持的 MemoryType 集合（用于 /memory list <type> 参数校验） */
const VALID_MEMORY_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>([
  "user_global",
  "project",
  "task",
  "experience",
]);

/**
 * delete-all 子命令的确认令牌
 *
 * 用户必须输入完全一致的 "DELETE ALL"（大写、空格分隔、无前后空格）才会触发删除。
 * 与 privacy-manager.ts 的 DELETE_CONFIRM_TOKEN 保持一致（架构师审查 P0-2 建议）。
 */
const DELETE_ALL_CONFIRM_TOKEN = "DELETE ALL";

/**
 * 处理 /memory 命令
 *
 * 解析子命令并路由到对应的处理函数。
 * 空字符串或 "help" 显示帮助；未知子命令返回失败。
 *
 * v2.8 P0-2 修复（架构师审查 2026-07-21）：
 *   - 签名改为 async（因 delete-all 调用 MemoryPrivacyManager.deleteAll 异步方法）
 *   - 新增可选第三参数 privacyManager，用于执行 delete-all 物理删除
 *   - delete-all 子命令需严格匹配 "DELETE ALL" 令牌，否则捕获 InvalidConfirmTokenError
 *
 * @param args 命令参数字符串（如 "list"、"delete <id>"、"delete-all DELETE ALL"、"help"）
 * @param store 记忆存储实例（用于 list / delete / review / export）
 * @param privacyManager 可选的隐私管理器实例（用于 delete-all 物理删除全部记忆文件）
 * @param searchFn 可选的按需检索函数（2026-11-08：/memory search 走外部 memsearch CLI）
 * @returns 命令处理结果的 Promise（调用方需 await）
 */
export async function handleMemoryCommand(
  args: string,
  store: MemoryStore,
  privacyManager?: MemoryPrivacyManager,
  searchFn?: MemorySearchFn
): Promise<MemoryCommandResult> {
  // 参数清洗：去除首尾空白，按空白拆分为 token 数组
  const trimmed = (args ?? "").trim();
  const parts = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  const subcommand = (parts[0] ?? "").toLowerCase();
  const rest = parts.slice(1);

  switch (subcommand) {
    case "":
      // 无子命令 → 显示帮助
      return handleHelp();
    case "list":
      return handleList(rest, store);
    case "delete":
      return handleDelete(rest, store);
    case "delete-all":
      // delete-all 子命令调用异步处理函数（需二次确认令牌）
      return await handleDeleteAll(rest, privacyManager);
    case "review":
      return handleReview(store);
    case "export":
      return handleExport(store);
    case "search":
      return await handleSearch(rest, searchFn);
    case "help":
      return handleHelp();
    default:
      return {
        success: false,
        output:
          `未知的 /memory 子命令: ${subcommand}\n` +
          `可用子命令: list, delete, delete-all, review, export, search, help`,
      };
  }
}

// ============================================================================
// 子命令处理函数
// ============================================================================

/**
 * /memory list - 列出所有记忆
 *
 * 支持可选的类型过滤参数：/memory list user_global
 *
 * @param args 命令参数（第一个元素可选为类型过滤器）
 * @param store 记忆存储实例
 * @returns 命令处理结果
 */
function handleList(args: string[], store: MemoryStore): MemoryCommandResult {
  // 解析可选的类型过滤器
  let typeFilter: MemoryType | undefined;
  if (args.length > 0) {
    const candidate = args[0]!.toLowerCase();
    if (VALID_MEMORY_TYPES.has(candidate as MemoryType)) {
      typeFilter = candidate as MemoryType;
    } else {
      return {
        success: false,
        output: `无效的记忆类型: ${args[0]}\n` + `可用类型: user_global, project, task, experience`,
      };
    }
  }

  const list = store.list(typeFilter);

  // 空记忆的特殊提示
  if (list.total === 0) {
    const hint = typeFilter ? `暂无 ${typeFilter} 类型的记忆。` : "暂无记忆。使用对话或显式声明来添加记忆。";
    return {
      success: true,
      output: hint,
      data: list,
    };
  }

  // 按类型分组输出（便于阅读）
  const byType: Record<string, MemoryEntry[]> = {};
  for (const entry of list.entries) {
    if (!byType[entry.type]) {
      byType[entry.type] = [];
    }
    byType[entry.type]!.push(entry);
  }

  const lines: string[] = [];
  lines.push(`共 ${list.total} 条记忆：`);
  // 类型统计行
  const typeStats = Object.entries(list.byType)
    .filter(([, count]) => count > 0)
    .map(([t, count]) => `${t}=${count}`)
    .join("  ");
  if (typeStats) {
    lines.push(`类型统计: ${typeStats}`);
  }
  lines.push("");

  // 按类型分组输出
  const typeOrder: MemoryType[] = ["user_global", "project", "task", "experience"];
  for (const type of typeOrder) {
    const entries = byType[type];
    if (!entries || entries.length === 0) {
      continue;
    }
    lines.push(`【${type}】（${entries.length} 条）`);
    entries.forEach((entry, idx) => {
      lines.push(formatMemoryEntry(entry, idx));
    });
    lines.push("");
  }

  return {
    success: true,
    output: lines.join("\n").trimEnd(),
    data: list,
  };
}

/**
 * /memory delete <id> - 删除指定记忆
 *
 * 必须提供记忆 ID 参数。
 *
 * @param args 命令参数（第一个元素为记忆 ID）
 * @param store 记忆存储实例
 * @returns 命令处理结果
 */
function handleDelete(args: string[], store: MemoryStore): MemoryCommandResult {
  if (args.length === 0) {
    return {
      success: false,
      output: "用法: /memory delete <id>\n" + "提示: 使用 /memory list 查看记忆 ID。",
    };
  }

  const id = args[0]!;
  const result = store.delete(id);

  if (!result.deleted) {
    return {
      success: false,
      output: `删除失败: ${result.reason ?? "未知原因"}\n` + `提示: 使用 /memory list 查看现有记忆 ID。`,
    };
  }

  const entry = result.deletedEntry!;
  return {
    success: true,
    output:
      `删除成功:\n` +
      `  ID: ${entry.id}\n` +
      `  类型: ${entry.type}\n` +
      `  键: ${entry.key}\n` +
      `  值: ${entry.value}`,
    data: result,
  };
}

/**
 * /memory delete-all [confirmToken] - 删除全部记忆文件
 *
 * 行为分支：
 *   1. 未提供 confirmToken（args 为空）：
 *      返回提示信息，告知用户使用 `/memory delete-all DELETE ALL` 二次确认。
 *      不执行任何删除操作（success=false，提示性失败，非错误）。
 *
 *   2. confirmToken === "DELETE ALL"（严格匹配，区分大小写）：
 *      调用 MemoryPrivacyManager.deleteAll 执行物理删除，
 *      返回 DeleteReport（含已删除文件清单与计数）。
 *
 *   3. confirmToken !== "DELETE ALL"：
 *      MemoryPrivacyManager.deleteAll 抛出 InvalidConfirmTokenError，
 *      捕获后返回失败信息（零文件被删除，由 privacy-manager 保证）。
 *
 *   4. 未提供 privacyManager（调用方未注入）：
 *      返回失败信息 "delete-all 不可用：未配置 MemoryPrivacyManager"，
 *      不执行任何删除操作（避免在无隐私管理器时静默成功）。
 *
 * @param args 命令参数（第一个元素为可选的确认令牌）
 * @param privacyManager 可选的隐私管理器实例
 * @returns 命令处理结果的 Promise
 */
async function handleDeleteAll(args: string[], privacyManager?: MemoryPrivacyManager): Promise<MemoryCommandResult> {
  // 分支 4：未注入 privacyManager，直接返回失败（不可用）
  if (!privacyManager) {
    return {
      success: false,
      output:
        "delete-all 不可用：未配置 MemoryPrivacyManager。\n" +
        "提示：请通过 CLI 入口注入 MemoryPrivacyManager 实例后再使用此命令。",
    };
  }

  // 分支 1：未提供确认令牌，提示用户使用二次确认
  if (args.length === 0) {
    return {
      success: false,
      output:
        "此操作将永久删除全部记忆文件且不可恢复。\n" +
        `如要确认删除，请使用：/memory delete-all ${DELETE_ALL_CONFIRM_TOKEN}\n` +
        '（必须严格输入大写 "DELETE ALL"，区分大小写、不带前后空格）',
    };
  }

  // 取得用户输入的确认令牌：将 args 数组用单空格重新连接
  // （"DELETE ALL" 经 split(/\s+/) 后变为 ["DELETE", "ALL"]，需还原为 "DELETE ALL"）
  // 注意：不做 trim、不做大小写转换，保持用户原始输入形式
  const confirmToken = args.join(" ");

  // 分支 2 & 3：调用 privacyManager.deleteAll，捕获 InvalidConfirmTokenError
  try {
    const report: DeleteReport = await privacyManager.deleteAll(confirmToken);
    return {
      success: true,
      output:
        `已删除全部记忆文件：\n` +
        `  已删除文件数: ${report.deletedCount}\n` +
        `  文件清单:\n` +
        report.deletedFiles.map((f) => `    - ${f}`).join("\n"),
      data: report,
    };
  } catch (error) {
    // 分支 3：InvalidConfirmTokenError → 返回失败（零文件被删除）
    if (error instanceof InvalidConfirmTokenError) {
      return {
        success: false,
        output:
          `删除失败：确认令牌无效。\n` + `${error.message}\n` + `提示：请严格输入大写 "DELETE ALL" 作为确认令牌。`,
      };
    }
    // 其他未知错误：向上抛出（不应被静默吞掉）
    throw error;
  }
}

/**
 * /memory review - 审查最近提取的记忆
 *
 * 显示最近添加的 N 条记忆（按 createdAt 降序），便于用户快速审查。
 *
 * @param store 记忆存储实例
 * @returns 命令处理结果
 */
function handleReview(store: MemoryStore): MemoryCommandResult {
  const list = store.list();

  if (list.total === 0) {
    return {
      success: true,
      output: "暂无记忆可供审查。",
      data: list,
    };
  }

  // 按 createdAt 降序排列（最新在前）
  const sorted = [...list.entries].sort((a, b) => {
    const ta = a.createdAt || "";
    const tb = b.createdAt || "";
    if (ta === tb) return 0;
    return ta > tb ? -1 : 1;
  });

  const recent = sorted.slice(0, REVIEW_RECENT_COUNT);
  const lines: string[] = [];
  lines.push(`最近 ${recent.length} 条记忆（共 ${list.total} 条）：`);
  lines.push("");

  recent.forEach((entry, idx) => {
    lines.push(formatMemoryEntry(entry, idx));
  });

  return {
    success: true,
    output: lines.join("\n").trimEnd(),
    data: { reviewed: recent.length, total: list.total, entries: recent },
  };
}

/**
 * /memory export - 导出所有记忆为 JSON
 *
 * 输出 MemoryStore.export() 的结果（格式化 JSON 字符串）。
 *
 * @param store 记忆存储实例
 * @returns 命令处理结果
 */
function handleExport(store: MemoryStore): MemoryCommandResult {
  const json = store.export();
  return {
    success: true,
    output: json,
    data: { format: "json", length: json.length },
  };
}

/**
 * /memory search - 按需检索长期记忆（外部 memsearch CLI 桥接）
 *
 * 2026-11-08 新增：返回 L1 摘要 + chunk_hash，完整章节可用
 * `deepcode memsearch expand <hash>` 获取。检索函数由宿主注入，
 * 未注入或检索失败时如实报错，不伪造命中。
 */
async function handleSearch(rest: readonly string[], searchFn?: MemorySearchFn): Promise<MemoryCommandResult> {
  let topK = 5;
  const queryParts: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--top-k") {
      const n = Number.parseInt(rest[i + 1] ?? "", 10);
      if (Number.isFinite(n) && n >= 1) {
        topK = Math.min(n, 50);
        i += 1;
        continue;
      }
    }
    queryParts.push(rest[i]);
  }
  const query = queryParts.join(" ").trim();
  if (query.length === 0) {
    return { success: false, output: "用法: /memory search <查询文本> [--top-k n]" };
  }
  if (!searchFn) {
    return {
      success: false,
      output:
        "memsearch 检索未启用：宿主未注入检索函数。\n" +
        "安装官方 CLI：uv tool install memsearch --default-index https://pypi.tuna.tsinghua.edu.cn/simple",
    };
  }

  let outcome: MemorySearchOutcomeLike;
  try {
    outcome = await searchFn(query, topK);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: `/memory search 执行失败：${message}` };
  }
  if (!outcome.ok) {
    const hint = outcome.hint ? `\n修复建议：${outcome.hint}` : "";
    return { success: false, output: `[${outcome.status}] ${outcome.reason}${hint}` };
  }

  const lines = [`# 记忆检索：${query}（${outcome.results.length} 条）`, ""];
  outcome.results.forEach((r, i) => {
    lines.push(
      `${i + 1}. [${r.score.toFixed(4)}] ${r.heading || "(无标题)"}  ${r.source}:${r.start_line}-${r.end_line}`
    );
    lines.push(`   hash: ${r.chunk_hash}`);
    const flat = r.content.replace(/\s+/g, " ").slice(0, 200);
    lines.push(`   ${flat}${r.content.length > 200 ? "…" : ""}`);
  });
  if (outcome.results.length === 0) {
    lines.push("（无命中；请确认已 index 对应 markdown 语料）");
  }
  return { success: true, output: lines.join("\n"), data: outcome.results };
}

/**
 * /memory help - 显示帮助
 *
 * @returns 命令处理结果
 */
function handleHelp(): MemoryCommandResult {
  const output = [
    "/memory - 记忆管理命令",
    "",
    "用法:",
    "  /memory                       显示此帮助",
    "  /memory list [type]           列出所有记忆（可选类型过滤）",
    "  /memory delete <id>           删除指定 ID 的记忆",
    "  /memory delete-all            提示二次确认（不可直接删除）",
    "  /memory delete-all DELETE ALL 删除全部记忆文件（需严格匹配令牌）",
    "  /memory review                审查最近提取的记忆",
    "  /memory export                导出所有记忆为 JSON",
    "  /memory search <query>        按需检索长期记忆（可选 --top-k n，返回 L1 摘要）",
    "  /memory help                  显示此帮助",
    "",
    "记忆类型:",
    "  user_global   用户全局记忆（跨项目）",
    "  project       项目记忆",
    "  task          任务临时记忆（会话内）",
    "  experience    经验记忆",
    "",
    "示例:",
    "  /memory list",
    "  /memory list user_global",
    "  /memory search 无进展熔断阈值",
    "  /memory delete 550e8400-e29b-41d4-a716-446655440000",
    "  /memory delete-all DELETE ALL",
  ].join("\n");
  return { success: true, output };
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 格式化记忆条目为显示文本（单条多行）
 *
 * @param entry 记忆条目
 * @param index 序号（从 0 开始）
 * @returns 格式化后的多行字符串
 */
function formatMemoryEntry(entry: MemoryEntry, index: number): string {
  const lines: string[] = [];
  lines.push(`  [${index + 1}] ${entry.key} = ${entry.value}`);
  lines.push(`      ID: ${entry.id}`);
  lines.push(`      类型: ${entry.type}  置信度: ${entry.confidence.toFixed(2)}  来源: ${entry.source}`);
  lines.push(`      创建: ${entry.createdAt}  更新: ${entry.updatedAt}`);
  if (entry.tags && entry.tags.length > 0) {
    lines.push(`      标签: ${entry.tags.join(", ")}`);
  }
  return lines.join("\n");
}
