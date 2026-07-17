/**
 * /memory 命令处理器
 *
 * 处理 /memory list、/memory delete、/memory review、/memory export、/memory help 等子命令。
 * 该命令在 CLI 层处理，不发送给 LLM（用户隐私：用户应能直接管理自己的记忆）。
 *
 * 命令格式：
 *   /memory                    显示帮助（等价于 /memory help）
 *   /memory list               列出所有记忆（可加类型过滤：/memory list user_global）
 *   /memory delete <id>        删除指定 ID 的记忆
 *   /memory review             审查最近提取的记忆（显示最近 10 条）
 *   /memory export             导出所有记忆为 JSON 字符串
 *   /memory help               显示帮助信息
 *
 * 设计依据：
 * - V2 PRD §US-MEM-001：用户可查看和管理自己的记忆
 * - V2 测试方案 §2.9 MEM-10（/memory list 命令）
 *
 * @module v2/memory/memory-commands
 */

import type { MemoryStore } from "./memory-store";
import type { MemoryEntry, MemoryType } from "./types";

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
 * 处理 /memory 命令
 *
 * 解析子命令并路由到对应的处理函数。
 * 空字符串或 "help" 显示帮助；未知子命令返回失败。
 *
 * @param args 命令参数字符串（如 "list"、"delete <id>"、"help"）
 * @param store 记忆存储实例
 * @returns 命令处理结果
 */
export function handleMemoryCommand(args: string, store: MemoryStore): MemoryCommandResult {
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
    case "review":
      return handleReview(store);
    case "export":
      return handleExport(store);
    case "help":
      return handleHelp();
    default:
      return {
        success: false,
        output: `未知的 /memory 子命令: ${subcommand}\n` + `可用子命令: list, delete, review, export, help`,
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
    "  /memory review                审查最近提取的记忆",
    "  /memory export                导出所有记忆为 JSON",
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
    "  /memory delete 550e8400-e29b-41d4-a716-446655440000",
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
