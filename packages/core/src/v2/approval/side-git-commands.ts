/**
 * side-git slash-commands 注册器
 *
 * 设计依据：
 * - V2_CONTEXT_MEMORY_TECH_DESIGN.md §4.4.5 slash-commands 接入路径（v2.4 新增：P1-10 修复）
 * - 参考 V2-P0a memory-commands.ts 的接入模式
 *
 * 命令说明：
 * - /restore <turnId> [pre|post]：回滚到指定 turn 的 pre-turn 或 post-turn 快照（默认 pre-turn）
 * - /revert_turn <turnId>：软撤销指定 turn 的改动（计算反向 diff 输出预览，不写入工作区）
 * - /snapshot list [--limit=N] [--offset=N] [--type=pre_turn|post_turn] [--task=<taskId>]：
 *   列出历史快照（P2-04：分页与过滤，默认 limit=50）
 * - /snapshot stats：输出运行统计（P2-07：totalSnapshots/avgSnapshotMs/diskUsageBytes 等）
 *
 * 调用契约：
 * - 所有命令处理函数为 async，内部 await SideGitManager 的对应方法；
 * - 命令执行结果通过 CommandResult 返回（ok: boolean, message?: string, data?: unknown）；
 * - 命令执行失败（如 turnId 不存在）返回 ok: false + error message，不抛出异常。
 */

import type { SideGitManager } from "./side-git.js";

/**
 * CLI 命令注册表接口（V1 已有，此处仅展示签名）
 *
 * V1 已实现（参考 packages/core/src/cli/commands.ts），
 * 提供 register(path, handler) 方法注册 slash-commands。
 */
export interface CommandRegistry {
  /**
   * 注册 slash-command
   * @param path 命令路径（如 "/restore"、"/snapshot"）
   * @param handler 命令处理函数（async，返回 CommandResult）
   */
  register(path: string, handler: (args: string[]) => Promise<CommandResult>): void;
}

/**
 * 命令执行结果
 */
export interface CommandResult {
  ok: boolean;
  message?: string;
  error?: string;
  data?: unknown;
}

/**
 * side-git slash-commands 注册器
 *
 * 将 /restore、/revert_turn、/snapshot list 三个命令注册到 CLI 命令注册表。
 *
 * 用法：
 * ```typescript
 * const sideGit = new SideGitManager({
 *   sideGitDir: path.join(os.homedir(), ".deepcode", "side-git", projectHash(projectRoot)),
 *   workspaceRoot: projectRoot,
 *   autoSnapshot: true,
 *   maxSnapshots: 50,
 * });
 * await sideGit.initialize();
 * registerSideGitCommands(sideGit, commandRegistry);
 * ```
 *
 * @param sideGit SideGitManager 实例（已初始化）
 * @param commandRegistry CLI 命令注册表
 */
export function registerSideGitCommands(sideGit: SideGitManager, commandRegistry: CommandRegistry): void {
  // /restore <turnId> [pre|post]
  commandRegistry.register("/restore", async (args: string[]) => {
    const [turnId, type] = args;
    if (!turnId) {
      return { ok: false, error: "用法：/restore <turnId> [pre|post]" };
    }
    const snapshotType = type === "post" ? "post_turn" : "pre_turn";
    try {
      const backupPath = await sideGit.restore(turnId, snapshotType);
      const message = backupPath
        ? `已回滚到 ${turnId} 的 ${snapshotType} 状态，未提交修改已备份到：${backupPath}`
        : `已回滚到 ${turnId} 的 ${snapshotType} 状态`;
      return { ok: true, message };
    } catch (err) {
      return { ok: false, error: `回滚失败：${(err as Error).message}` };
    }
  });

  // /revert_turn <turnId>
  commandRegistry.register("/revert_turn", async (args: string[]) => {
    const [turnId] = args;
    if (!turnId) {
      return { ok: false, error: "用法：/revert_turn <turnId>" };
    }
    try {
      const preview = await sideGit.revertTurn(turnId);
      return {
        ok: true,
        message: `已生成 turn ${turnId} 的反向 diff 预览（未写入工作区）`,
        data: preview, // RevertPreview 类型，含 reverseDiff / affectedFiles / additions / deletions
      };
    } catch (err) {
      return { ok: false, error: `撤销失败：${(err as Error).message}` };
    }
  });

  // /snapshot list [--limit=N] [--offset=N] [--type=pre_turn|post_turn] [--task=<taskId>]
  commandRegistry.register("/snapshot", async (args: string[]) => {
    const [sub, ...rest] = args;
    if (sub === "list") {
      try {
        // P2-04：解析分页/过滤参数（--limit=50 --offset=0 --type=pre_turn --task=task-001）
        const options: {
          limit?: number;
          offset?: number;
          type?: "pre_turn" | "post_turn";
          taskId?: string;
        } = {};
        for (const flag of rest) {
          if (flag.startsWith("--limit=")) {
            const n = Number(flag.slice(8));
            if (Number.isFinite(n) && n > 0) options.limit = n;
          } else if (flag.startsWith("--offset=")) {
            const n = Number(flag.slice(9));
            if (Number.isFinite(n) && n >= 0) options.offset = n;
          } else if (flag.startsWith("--type=")) {
            const t = flag.slice(7);
            if (t === "pre_turn" || t === "post_turn") options.type = t;
          } else if (flag.startsWith("--task=")) {
            options.taskId = flag.slice(7);
          }
        }
        const snapshots = await sideGit.listSnapshots(options);
        return { ok: true, data: snapshots };
      } catch (err) {
        return { ok: false, error: `查询快照列表失败：${(err as Error).message}` };
      }
    }
    if (sub === "stats") {
      // P2-07：/snapshot stats 输出运行统计（可观测性）
      try {
        const stats = await sideGit.getStats();
        return { ok: true, data: stats };
      } catch (err) {
        return { ok: false, error: `查询统计失败：${(err as Error).message}` };
      }
    }
    return {
      ok: false,
      error: `未知子命令：${sub}（支持：list [--limit=N] [--offset=N] [--type=T] [--task=ID]、stats）`,
    };
  });
}
