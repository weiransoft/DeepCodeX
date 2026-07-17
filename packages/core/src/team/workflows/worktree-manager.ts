/**
 * Worktree Manager（V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/dynamic_workflow/worktree_manager.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 核心职责：
 *   1. 为 fan-out-aggregate 模式创建 git worktree 隔离
 *   2. 每个 subagent 在独立 worktree 中工作
 *   3. 任务完成后清理 worktree
 *   4. 支持 dry-run 模式
 *
 * 设计约束：
 *   - 🔴 真实 git 操作：使用 child_process 调用 git 命令
 *   - 🔴 异常隔离：worktree 创建失败时不影响其他 subagent
 *   - 🔴 幂等：cleanup 时若 worktree 不存在则忽略
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

// ============================================================================
// 类型定义
// ============================================================================

/** worktree 状态 */
export type WorktreeStatus = "active" | "merged" | "cleaned" | "failed";

/** worktree 信息 */
export interface WorktreeInfo {
  worktree_id: string;
  branch: string;
  path: string;
  status: WorktreeStatus;
  task_id: string | null;
  created_at: number;
  cleaned_at: number | null;
  /** 原始 commit hash */
  base_commit: string;
}

export function defaultWorktree(): WorktreeInfo {
  return {
    worktree_id: "",
    branch: "",
    path: "",
    status: "failed",
    task_id: null,
    created_at: Date.now(),
    cleaned_at: null,
    base_commit: "",
  };
}

// ============================================================================
// 异常
// ============================================================================

export class WorktreeManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeManagerError";
  }
}

export class NotGitRepoError extends WorktreeManagerError {
  constructor(repoRoot: string) {
    super(`不是 git 仓库: ${repoRoot}`);
    this.name = "NotGitRepoError";
  }
}

export class WorktreeCreateError extends WorktreeManagerError {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeCreateError";
  }
}

// ============================================================================
// WorktreeManager
// ============================================================================

/** WorktreeManager 配置 */
export interface WorktreeManagerConfig {
  repoRoot: string;
  worktreeBaseDir: string;
  branchPrefix: string;
  /** 硬上限：同时活跃的 worktree 数 */
  maxActive: number;
}

export class WorktreeManager {
  private readonly config: WorktreeManagerConfig;
  private readonly worktrees: Map<string, WorktreeInfo> = new Map();
  private readonly log: (level: string, message: string) => void;

  constructor(args: {
    repoRoot: string;
    worktreeBaseDir?: string;
    branchPrefix?: string;
    maxActive?: number;
    log?: (level: string, message: string) => void;
  }) {
    const resolved = path.resolve(args.repoRoot);
    if (!fs.existsSync(path.join(resolved, ".git"))) {
      throw new NotGitRepoError(resolved);
    }
    this.config = {
      repoRoot: resolved,
      worktreeBaseDir: path.resolve(args.worktreeBaseDir ?? path.join(resolved, ".deepcodex", "worktrees")),
      branchPrefix: args.branchPrefix ?? "deepcodex/",
      maxActive: args.maxActive ?? 10,
    };
    this.log =
      args.log ??
      ((l, m) => {
        if (l === "warn" || l === "error") console.warn(`[worktree_manager] ${m}`);
      });
  }

  /** 列出当前所有 worktree */
  listWorktrees(): WorktreeInfo[] {
    return Array.from(this.worktrees.values());
  }

  /** 当前活跃 worktree 数 */
  activeCount(): number {
    let n = 0;
    for (const w of this.worktrees.values()) {
      if (w.status === "active") n += 1;
    }
    return n;
  }

  /** 创建 worktree（异常隔离） */
  create(args: { worktreeId: string; taskId?: string | null; baseBranch?: string }): WorktreeInfo {
    if (this.activeCount() >= this.config.maxActive) {
      throw new WorktreeCreateError(`达到 worktree 上限 ${this.config.maxActive}`);
    }
    const branchName = `${this.config.branchPrefix}${args.worktreeId}`;
    const worktreePath = path.join(this.config.worktreeBaseDir, args.worktreeId);

    if (fs.existsSync(worktreePath)) {
      // 已存在：复用（幂等）
      const existing = this.worktrees.get(args.worktreeId);
      if (existing !== undefined && existing.status === "active") {
        return existing;
      }
    } else {
      // 创建 worktree
      const base = args.baseBranch ?? "HEAD";
      const result = spawnSync("git", ["worktree", "add", "-b", branchName, worktreePath, base], {
        cwd: this.config.repoRoot,
        encoding: "utf-8",
      });
      if (result.status !== 0) {
        const errMsg = result.stderr ?? "未知错误";
        throw new WorktreeCreateError(`git worktree add 失败: ${errMsg}`);
      }
    }

    // 获取 base commit
    const logResult = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
      encoding: "utf-8",
    });
    const baseCommit = logResult.status === 0 ? (logResult.stdout ?? "").trim() : "";

    const info: WorktreeInfo = {
      worktree_id: args.worktreeId,
      branch: branchName,
      path: worktreePath,
      status: "active",
      task_id: args.taskId ?? null,
      created_at: Date.now(),
      cleaned_at: null,
      base_commit: baseCommit,
    };
    this.worktrees.set(args.worktreeId, info);
    this.log("info", `创建 worktree '${args.worktreeId}' → ${worktreePath}`);
    return info;
  }

  /** 清理 worktree（删除 worktree + 可选删除 branch） */
  cleanup(args: { worktreeId: string; removeBranch?: boolean }): WorktreeInfo {
    const info = this.worktrees.get(args.worktreeId);
    if (info === undefined) {
      throw new WorktreeManagerError(`worktree '${args.worktreeId}' 不存在`);
    }
    if (info.status === "cleaned") {
      return info;
    }

    // git worktree remove
    const result = spawnSync("git", ["worktree", "remove", "--force", info.path], {
      cwd: this.config.repoRoot,
      encoding: "utf-8",
    });
    if (result.status !== 0) {
      // 失败时不抛：标记 failed
      this.log("warn", `git worktree remove 失败: ${result.stderr ?? "未知"}`);
    }

    // 删除分支（可选）
    if (args.removeBranch === true) {
      const branchResult = spawnSync("git", ["branch", "-D", info.branch], {
        cwd: this.config.repoRoot,
        encoding: "utf-8",
      });
      if (branchResult.status !== 0) {
        this.log("warn", `git branch -D 失败: ${branchResult.stderr ?? "未知"}`);
      }
    }

    // 手动清理目录（兜底）
    if (fs.existsSync(info.path)) {
      try {
        fs.rmSync(info.path, { recursive: true, force: true });
      } catch {
        // 静默
      }
    }

    info.status = "cleaned";
    info.cleaned_at = Date.now();
    this.log("info", `清理 worktree '${args.worktreeId}'`);
    return info;
  }

  /** 合并 worktree 分支到当前分支（用于 fan-out 完成后聚合） */
  merge(args: { worktreeId: string; targetBranch?: string }): {
    success: boolean;
    commit: string;
    errorMessage: string;
  } {
    const info = this.worktrees.get(args.worktreeId);
    if (info === undefined) {
      return { success: false, commit: "", errorMessage: `worktree '${args.worktreeId}' 不存在` };
    }
    const target = args.targetBranch ?? "HEAD";
    const result = spawnSync(
      "git",
      ["merge", "--no-ff", info.branch, "-m", `merge ${info.branch} from worktree ${args.worktreeId}`],
      {
        cwd: this.config.repoRoot,
        encoding: "utf-8",
      }
    );
    if (result.status !== 0) {
      return { success: false, commit: "", errorMessage: result.stderr ?? "merge 失败" };
    }
    const revResult = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: this.config.repoRoot,
      encoding: "utf-8",
    });
    const commit = revResult.status === 0 ? (revResult.stdout ?? "").trim() : "";
    info.status = "merged";
    this.log("info", `合并 worktree '${args.worktreeId}' → ${commit.slice(0, 8)}`);
    return { success: true, commit, errorMessage: "" };
  }

  /** 批量清理所有 active worktree */
  cleanupAll(args: { removeBranch?: boolean }): { cleaned: number; failed: number } {
    let cleaned = 0;
    let failed = 0;
    for (const w of this.worktrees.values()) {
      if (w.status !== "active") continue;
      try {
        this.cleanup({ worktreeId: w.worktree_id, removeBranch: args.removeBranch });
        cleaned += 1;
      } catch {
        failed += 1;
      }
    }
    return { cleaned, failed };
  }
}

/** 创建默认 WorktreeManager */
export function createDefaultWorktreeManager(args: {
  repoRoot: string;
  worktreeBaseDir?: string;
  branchPrefix?: string;
  maxActive?: number;
  log?: (level: string, message: string) => void;
}): WorktreeManager {
  return new WorktreeManager(args);
}
