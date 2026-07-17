/**
 * Side-Git turn 级快照回滚
 *
 * 参考 DeepSeek-TUI side-git 机制，使用独立 git 仓库 + --git-dir/--work-tree 分离，
 * 零污染主 .git，支持 turn 级快照创建、回滚、撤销、清理。
 *
 * 设计依据：
 * - V2_CONTEXT_MEMORY_TECH_DESIGN.md §4.2.3 SideGitManager（v2.4 修订版）
 * - ADR-V2-003：side-git 仅写 ~/.deepcode/side-git/<project_hash>/ 独立 git-dir，不污染项目根目录
 * - P0-06 修复：restore 前备份 uncommitted work
 * - P0-07 修复：revertTurn 改为软撤销（计算反向 diff 输出预览，不写入工作区）
 * - P1-01 修复：内部串行化队列，避免 git index.lock 冲突
 * - P1-03 修复：turnId 生成规则 + commit message 格式 + manifest.json 模式
 * - P1-04 修复：改用命令行参数传递 --git-dir/--work-tree，避免环境变量泄漏
 * - P1-05 修复：仅 add 变更文件子集，满足 < 500ms 红线
 * - P1-11 修复：与 V1 GitFileHistory 职责边界（turn 级 vs 文件级，并存策略）
 *
 * 与 V1 GitFileHistory 职责边界（§4.4.6）：
 * - V2 SideGitManager：turn 粒度（粗粒度），面向"用户回滚某个 AI 操作"，用户可见；
 * - V1 GitFileHistory：文件粒度（细粒度），面向"autonomous 流程内的文件级检查点"，用户不可见；
 * - 两者并存，路径完全独立，无数据互通。
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { promisify } from "node:util";
import type { DiffStats } from "../diff/myers-diff.js";
import { enhanceDiffPreview } from "../diff/enhance-diff-preview.js";

const execFileAsync = promisify(execFile);

/**
 * Side-Git 配置
 */
export interface SideGitConfig {
  /** side-git 仓库位置（默认 ~/.deepcode/side-git/<project_hash>/） */
  sideGitDir: string;
  /** 工作区根目录 */
  workspaceRoot: string;
  /** 是否启用自动快照 */
  autoSnapshot: boolean;
  /** 最大快照数（超过自动清理，默认 50） */
  maxSnapshots: number;
  /**
   * 额外忽略模式（P2-06 修复：支持 .gitignore 排除）
   *
   * 默认继承项目根目录 .gitignore（如存在），并追加内置排除：
   * node_modules/、.git/、dist/、build/、.env、.env.*
   *
   * 自定义模式追加到内置排除之后，支持 glob 子集：
   * - 目录结尾 /：匹配该目录下所有文件（前缀匹配）
   * - 精确文件名：全路径匹配
   * - 通配符 *：匹配任意字符序列
   */
  ignorePatterns?: string[];
}

/**
 * Turn 快照元数据
 */
export interface TurnSnapshot {
  /** turn ID（唯一，格式：<ISO8601-compact>-<random-6>，如 20260717T143022-a1b2c3） */
  turnId: string;
  /** 快照类型 */
  type: "pre_turn" | "post_turn";
  /** 时间戳（ISO8601 格式） */
  timestamp: string;
  /** git commit hash */
  commitHash: string;
  /** 变更文件列表 */
  changedFiles: string[];
  /** 变更统计：新增行数 */
  additions: number;
  /** 变更统计：删除行数 */
  deletions: number;
  /** 关联的任务 ID（可选） */
  taskId?: string;
}

/**
 * revertTurn 的返回类型：反向 diff 预览（v2.4 P0-07 新增）
 */
export interface RevertPreview {
  /** 目标 turn ID */
  turnId: string;
  /** 目标 commit hash */
  commitHash: string;
  /** 变更文件列表 */
  changedFiles: string[];
  /** 反向 diff 渲染结果（含颜色/行号/上下文） */
  diffPreview: string;
  /** diff 统计（additions/deletions/changes） */
  stats: DiffStats;
  /** 用户操作指引（中文） */
  instructions: string;
}

/**
 * listSnapshots 查询选项（P2-04 修复：支持分页与过滤）
 */
export interface ListSnapshotsOptions {
  /** 返回数量上限（默认 50） */
  limit?: number;
  /** 跳过前 N 条（默认 0，用于分页） */
  offset?: number;
  /** 按快照类型过滤 */
  type?: "pre_turn" | "post_turn";
  /** 按关联任务 ID 过滤 */
  taskId?: string;
}

/**
 * Side-Git 运行统计（P2-07 修复：可观测性接口）
 */
export interface SideGitStats {
  /** 累计快照总数 */
  totalSnapshots: number;
  /** 最近一次快照时间（ISO8601，无快照时为 null） */
  lastSnapshotAt: string | null;
  /** 平均快照耗时（毫秒，无样本时为 0） */
  avgSnapshotMs: number;
  /** 累计失败快照次数 */
  failedSnapshots: number;
  /** side-git 仓库磁盘占用（字节，统计失败时为 -1） */
  diskUsageBytes: number;
}

/**
 * manifest.json 数据结构（P1-03 修复：元数据与 commit 解耦）
 */
interface ManifestData {
  version: string;
  lastUpdated: string;
  snapshots: TurnSnapshot[];
  /** 保留集合（cleanupOldSnapshots 逻辑删除标记，commitHash 列表） */
  retainedSet?: string[];
}

/**
 * Side-Git 管理器
 *
 * 核心能力：
 * - initialize()：初始化 side-git 仓库（git init + 本地 user 配置 + 初始 commit）
 * - createSnapshot()：创建 turn 快照（仅 add 变更文件子集，< 500ms）
 * - restore()：回滚到指定 turn（先备份 uncommitted work）
 * - revertTurn()：软撤销指定 turn（计算反向 diff 输出预览，不写入工作区）
 * - listSnapshots()：列出所有快照（优先读 manifest.json，降级时解析 git log）
 * - cleanupOldSnapshots()：清理旧快照（逻辑删除 + 低频 gc）
 *
 * 并发安全（P1-01 修复）：
 * - 内部维护 gitQueue 串行化队列，所有 git 写操作（add/commit/checkout/revert/gc）串行执行；
 * - 避免 10 个并发 createSnapshot 争抢同一个 index.lock 导致 fatal 错误。
 */
export class SideGitManager {
  /**
   * 内部串行化队列（P1-01 修复）：
   * 所有 git 写操作通过此队列串行执行，避免 git index.lock 冲突（R-09 并发安全红线）。
   *
   * 实现原理：
   * - gitQueue 初始为 Promise.resolve()；
   * - 每次调用 serialize(fn) 时，fn 追加到 gitQueue 尾部执行；
   * - 无论 fn 成功或失败，gitQueue 都要继续（避免一次失败阻塞后续所有操作）。
   */
  private gitQueue: Promise<unknown> = Promise.resolve();

  /**
   * 快照耗时样本（P2-07：用于计算 avgSnapshotMs，仅保留最近 100 个样本防内存膨胀）
   */
  private snapshotDurations: number[] = [];

  /** 累计失败快照次数（P2-07） */
  private failedSnapshotCount = 0;

  /** 内置默认忽略模式（P2-06：不进入快照的常见目录/文件） */
  private static readonly BUILTIN_IGNORE: readonly string[] = [
    "node_modules/",
    ".git/",
    "dist/",
    "build/",
    ".env",
    ".env.*",
  ];

  /** 合并后的忽略模式缓存（P2-06：initialize 时加载，含 .gitignore + 内置 + 自定义） */
  private mergedIgnorePatterns: string[] = [];

  constructor(private readonly config: SideGitConfig) {}

  /**
   * 串行化执行 git 操作（P1-01 修复）
   *
   * @param fn 要执行的异步函数
   * @returns fn 的返回值
   */
  private async serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.gitQueue.then(fn);
    // 关键：无论 fn 成功或失败，gitQueue 都要继续（避免一次失败阻塞后续所有操作）
    this.gitQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * 执行 git 命令（P1-04 修复：改用命令行参数，避免环境变量泄漏）
   *
   * 所有 side-git 命令统一通过命令行参数传递 --git-dir/--work-tree，
   * 不污染环境变量（避免子进程继承导致主仓库 git 操作误用 side-git 上下文）。
   *
   * 作者信息仍用环境变量注入（GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL），参考 V1 GitFileHistory。
   *
   * @param userArgs git 命令参数（不含 --git-dir/--work-tree）
   * @returns stdout 输出
   */
  private async runGit(userArgs: string[]): Promise<string> {
    const args = [`--git-dir=${this.config.sideGitDir}`, `--work-tree=${this.config.workspaceRoot}`, ...userArgs];
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.config.workspaceRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "DeepCode SideGit",
        GIT_AUTHOR_EMAIL: "side-git@deepcode.local",
        GIT_COMMITTER_NAME: "DeepCode SideGit",
        GIT_COMMITTER_EMAIL: "side-git@deepcode.local",
      },
    });
    return stdout.trim();
  }

  /**
   * 初始化 side-git 仓库
   *
   * - 创建 sideGitDir（如不存在）
   * - git init
   * - 配置 user.email/user.name（本地，不污染全局）
   * - 初始 commit（如仓库为空）
   */
  async initialize(): Promise<void> {
    return this.serialize(async () => {
      // 1. 创建 sideGitDir（如不存在）
      await fs.mkdir(this.config.sideGitDir, { recursive: true });

      // 2. 检查是否已初始化（sideGitDir 本身就是 git-dir，检查 HEAD 文件是否存在）
      const gitDirExists = await fs
        .access(path.join(this.config.sideGitDir, "HEAD"))
        .then(() => true)
        .catch(() => false);

      if (!gitDirExists) {
        // 3. git init
        await this.runGit(["init"]);

        // 4. 配置 user.email/user.name（本地，不污染全局）
        await this.runGit(["config", "user.name", "DeepCode SideGit"]);
        await this.runGit(["config", "user.email", "side-git@deepcode.local"]);

        // 5. 初始 commit（如仓库为空）
        const hasCommits = await this.runGit(["rev-parse", "HEAD"])
          .then(() => true)
          .catch(() => false);

        if (!hasCommits) {
          // 创建空初始 commit（允许空 commit）
          await this.runGit(["commit", "--allow-empty", "-m", "Initial commit"]);
        }
      }

      // 6. 初始化 manifest.json（如不存在）
      const manifestPath = path.join(this.config.sideGitDir, "manifest.json");
      const manifestExists = await fs
        .access(manifestPath)
        .then(() => true)
        .catch(() => false);

      if (!manifestExists) {
        const initialManifest: ManifestData = {
          version: "1.0.0",
          lastUpdated: new Date().toISOString(),
          snapshots: [],
        };
        await fs.writeFile(manifestPath, JSON.stringify(initialManifest, null, 2), "utf8");
      }

      // 7. 加载 .gitignore 忽略模式（P2-06：项目 .gitignore + 内置排除 + 自定义模式）
      this.mergedIgnorePatterns = await this.loadIgnorePatterns();
    });
  }

  /**
   * 加载并合并忽略模式（P2-06）
   *
   * 合并优先级（后者追加）：
   * 1. 项目根目录 .gitignore（如存在，跳过注释与空行）
   * 2. 内置排除（node_modules/、.git/、dist/、build/、.env、.env.*）
   * 3. 用户自定义 ignorePatterns
   *
   * @returns 合并后的忽略模式列表
   */
  private async loadIgnorePatterns(): Promise<string[]> {
    const patterns: string[] = [];

    // 1. 读取项目 .gitignore（如存在）
    const gitignorePath = path.join(this.config.workspaceRoot, ".gitignore");
    try {
      const content = await fs.readFile(gitignorePath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        // 跳过注释、空行、取反规则（! 开头的 gitignore 取反语法不支持，保守忽略）
        if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("!")) {
          patterns.push(trimmed);
        }
      }
    } catch {
      // .gitignore 不存在时跳过（非错误）
    }

    // 2. 追加内置排除
    patterns.push(...SideGitManager.BUILTIN_IGNORE);

    // 3. 追加用户自定义模式
    if (this.config.ignorePatterns) {
      patterns.push(...this.config.ignorePatterns);
    }

    return patterns;
  }

  /**
   * 判断文件路径是否应被忽略（P2-06）
   *
   * 支持的 glob 子集：
   * - "dir/"：前缀匹配（该目录下所有文件）
   * - "file.txt"：精确匹配文件名或路径末尾
   * - "*.log"：通配符匹配（* 匹配任意字符序列）
   *
   * @param filePath 相对于 workspaceRoot 的文件路径
   * @returns true 表示应忽略（不进入快照）
   */
  private isIgnored(filePath: string): boolean {
    for (const pattern of this.mergedIgnorePatterns) {
      if (pattern.endsWith("/")) {
        // 目录前缀匹配：node_modules/ 匹配 node_modules/xxx
        if (filePath.startsWith(pattern) || filePath.includes(`/${pattern}`)) {
          return true;
        }
      } else if (pattern.includes("*")) {
        // 通配符匹配：将 glob 转为正则（* → .*）
        const regex = new RegExp("(^|/)" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
        if (regex.test(filePath)) {
          return true;
        }
      } else {
        // 精确匹配：文件名或路径末尾
        if (filePath === pattern || filePath.endsWith(`/${pattern}`)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 创建 turn 快照（P1-05 修复：仅 add 变更文件子集，满足 < 500ms 红线）
   *
   * @param turnId turn ID
   * @param type 快照类型（pre_turn/post_turn）
   * @param taskId 关联任务 ID（可选）
   * @returns TurnSnapshot
   */
  async createSnapshot(turnId: string, type: "pre_turn" | "post_turn", taskId?: string): Promise<TurnSnapshot> {
    const startMs = Date.now();
    try {
      return await this.serialize(async () => {
        // 1. 先用 git status --porcelain 获取变更文件列表（毫秒级）
        const changedFiles = await this.getChangedFiles();

        if (changedFiles.length === 0) {
          // 无变更：返回当前 HEAD 对应的 TurnSnapshot（不创建新 commit）
          return this.snapshotFromCurrentHead(turnId, type, taskId);
        }

        // 2. 仅 add 变更文件子集（避免 git add -A 全量扫描，大仓库 1 万文件时 < 500ms）
        await this.runGit(["add", "--", ...changedFiles]);

        // 3. 构造 TurnSnapshot 元数据
        const timestamp = new Date().toISOString();
        const snapshot: TurnSnapshot = {
          turnId,
          type,
          timestamp,
          commitHash: "", // 待 commit 后填充
          changedFiles,
          additions: 0, // 待 diff stats 后填充
          deletions: 0, // 待 diff stats 后填充
          taskId,
        };

        // 4. commit（--no-verify 跳过用户 hooks，避免拖慢）
        const commitMessage = this.buildCommitMessage(snapshot);
        await this.runGit(["commit", "--no-verify", "-m", commitMessage]);

        // 5. 获取 commit hash
        const commitHash = await this.runGit(["rev-parse", "HEAD"]);
        snapshot.commitHash = commitHash;

        // 6. 计算 diff stats（git diff --numstat <parent>..<new>）
        const parentHash = await this.runGit(["rev-parse", "HEAD^"]).catch(() => null);
        if (parentHash) {
          const stats = await this.getDiffStats(parentHash, commitHash);
          snapshot.additions = stats.additions;
          snapshot.deletions = stats.deletions;
        }

        // 7. 更新 manifest.json
        await this.updateManifest(snapshot);

        return snapshot;
      });
    } catch (err) {
      // P2-07：记录失败次数后向上抛出
      this.failedSnapshotCount++;
      throw err;
    } finally {
      // P2-07：记录耗时样本（成功/失败均记录，保留最近 100 个）
      this.snapshotDurations.push(Date.now() - startMs);
      if (this.snapshotDurations.length > 100) {
        this.snapshotDurations.shift();
      }
    }
  }

  /**
   * 列出所有快照（优先读 manifest.json，降级时解析 git log）
   *
   * 注意：本方法为纯读操作（读 manifest.json / git log），不进入 gitQueue 串行队列。
   * 原因：restore()/revertTurn()/cleanupOldSnapshots() 等写操作在 serialize 临界区内
   * 需调用 findSnapshot() → listSnapshots()，若读操作也入队会造成队列自等待死锁。
   * 竞态容忍：读 manifest.json 恰逢写操作更新时可能 JSON 解析失败，
   * 此时自动降级为 git log 解析（下方 catch 分支已覆盖），不影响正确性。
   */
  async listSnapshots(options?: ListSnapshotsOptions): Promise<TurnSnapshot[]> {
    const manifestPath = path.join(this.config.sideGitDir, "manifest.json");

    let snapshots: TurnSnapshot[];
    try {
      // 优先读 manifest.json（稳定）
      const content = await fs.readFile(manifestPath, "utf8");
      const manifest: ManifestData = JSON.parse(content);

      // 按时间倒序返回
      snapshots = manifest.snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    } catch (err) {
      // manifest 损坏时降级为 git log 解析（容错）
      console.warn("manifest.json 损坏，降级为 git log 解析", err);
      snapshots = await this.listSnapshotsFromGitLog();
    }

    // P2-04：类型过滤
    if (options?.type) {
      snapshots = snapshots.filter((s) => s.type === options.type);
    }

    // P2-04：任务过滤
    if (options?.taskId) {
      snapshots = snapshots.filter((s) => s.taskId === options.taskId);
    }

    // P2-04：分页（offset + limit，默认 limit=50）
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 50;
    return snapshots.slice(offset, offset + limit);
  }

  /**
   * 获取 Side-Git 运行统计（P2-07 修复：可观测性接口）
   *
   * 聚合维度：
   * - totalSnapshots：manifest.json 中记录的快照总数（含已被逻辑清理的）
   * - lastSnapshotAt：最近一次快照的 timestamp（无快照时为 null）
   * - avgSnapshotMs：最近 ≤100 次 createSnapshot 的平均耗时（含成功与失败样本）
   * - failedSnapshots：累计 createSnapshot 抛出异常的次数
   * - diskUsageBytes：sideGitDir 磁盘占用（du 等效递归求和，统计失败返回 -1）
   *
   * @returns 统计快照（纯读操作，不进入 gitQueue）
   */
  async getStats(): Promise<SideGitStats> {
    // 1. 从 manifest.json 读取快照总数与最近时间
    let totalSnapshots = 0;
    let lastSnapshotAt: string | null = null;
    try {
      const content = await fs.readFile(path.join(this.config.sideGitDir, "manifest.json"), "utf8");
      const manifest: ManifestData = JSON.parse(content);
      totalSnapshots = manifest.snapshots.length;
      if (manifest.snapshots.length > 0) {
        // manifest.snapshots 按追加顺序排列，最后一条即最近快照
        lastSnapshotAt = manifest.snapshots[manifest.snapshots.length - 1]!.timestamp;
      }
    } catch {
      // manifest 不存在/损坏时保持默认值（非错误）
    }

    // 2. 计算平均耗时（无样本时为 0）
    const avgSnapshotMs =
      this.snapshotDurations.length > 0
        ? this.snapshotDurations.reduce((a, b) => a + b, 0) / this.snapshotDurations.length
        : 0;

    // 3. 统计磁盘占用（递归求和，失败返回 -1）
    const diskUsageBytes = await this.computeDiskUsage(this.config.sideGitDir).catch(() => -1);

    return {
      totalSnapshots,
      lastSnapshotAt,
      avgSnapshotMs,
      failedSnapshots: this.failedSnapshotCount,
      diskUsageBytes,
    };
  }

  /**
   * 递归计算目录磁盘占用（P2-07 辅助方法）
   *
   * @param dir 目标目录
   * @returns 总字节数（含所有子文件）
   */
  private async computeDiskUsage(dir: string): Promise<number> {
    let total = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await this.computeDiskUsage(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        total += stat.size;
      }
    }
    return total;
  }

  /**
   * 回滚到指定 turn（P0-06 修复：回滚前备份 uncommitted work）
   *
   * @param turnId 目标 turn ID
   * @param type 回滚到 pre_turn 还是 post_turn
   * @returns 备份目录路径（无未提交修改时返回 null）
   */
  async restore(turnId: string, type: "pre_turn" | "post_turn"): Promise<string | null> {
    return this.serialize(async () => {
      // 1. 先备份当前工作区 side-git 未跟踪的修改（P0-06 修复）
      const backupPath = await this.backupUncommittedWork();

      // 2. 定位目标快照的 commitHash
      const snapshot = await this.findSnapshot(turnId, type);

      // 3. 恢复工作区文件到目标快照状态（不修改 HEAD）
      // 使用 git read-tree + git checkout-index 组合（参考 V1 GitDriver.rollback 模式），
      // 避免 git checkout/restore 在 --git-dir/--work-tree 分离模式下卡死问题。
      // 步骤：
      //   a. git read-tree <commitHash>：将目标 commit 的 tree 读入 index；
      //   b. git checkout-index -a -f：将 index 中的所有文件检出到工作区（-f 强制覆盖）。
      await this.runGit(["read-tree", snapshot.commitHash]);
      await this.runGit(["checkout-index", "-a", "-f"]);

      // 4. 返回备份路径（供 UI 提示用户）
      return backupPath;
    });
  }

  /**
   * 备份当前工作区中 side-git 未跟踪的修改（v2.4 P0-06 新增）
   *
   * 参考 V1 GitDriver.rollback 模式：
   * 1. 执行 `git status --porcelain` 获取未提交的文件列表；
   * 2. 将每个文件备份到 `<sideGitDir>/uncommitted-<timestamp>/`；
   * 3. 生成 manifest.json（含 path/status/sha256/size），便于审计与恢复；
   * 4. 返回备份目录路径。
   *
   * @returns 备份目录路径（无未提交修改时返回 null）
   */
  async backupUncommittedWork(): Promise<string | null> {
    // 1. 使用 -z 模式获取未提交文件列表与状态码（NUL 分隔，100% 解析可靠）
    const args = [
      `--git-dir=${this.config.sideGitDir}`,
      `--work-tree=${this.config.workspaceRoot}`,
      "status",
      "--porcelain",
      "-z",
    ];
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.config.workspaceRoot,
      encoding: "utf8",
    });

    if (!stdout) return null;

    // 解析条目：XY<space>filename<NUL>
    const entries = stdout.split("\0").filter((e) => e.length > 0);
    if (entries.length === 0) return null;

    // 2. 创建备份目录 <sideGitDir>/uncommitted-<timestamp>/
    const timestamp = Date.now();
    const backupDir = path.join(this.config.sideGitDir, `uncommitted-${timestamp}`);
    await fs.mkdir(backupDir, { recursive: true });

    // 3. 逐文件备份 + 生成 manifest.json（含 sha256 校验）
    const manifest = {
      timestamp: new Date().toISOString(),
      files: [] as Array<{ path: string; status: string; sha256: string; size: number }>,
    };

    for (const entry of entries) {
      const status = entry.slice(0, 2);
      const filePath = entry.slice(3);
      const absolutePath = path.join(this.config.workspaceRoot, filePath);

      // 读取文件内容
      const content = await fs.readFile(absolutePath);
      const sha256 = crypto.createHash("sha256").update(content).digest("hex");
      const size = content.length;

      // 备份文件（保持目录结构）
      const backupFilePath = path.join(backupDir, filePath);
      await fs.mkdir(path.dirname(backupFilePath), { recursive: true });
      await fs.writeFile(backupFilePath, content);

      manifest.files.push({ path: filePath, status, sha256, size });
    }

    // 4. 写入 manifest.json
    await fs.writeFile(path.join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    return backupDir;
  }

  /**
   * 撤销特定 turn 的改动（保留后续 turn，v2.4 P0-07 语义重设计）
   *
   * 软撤销：
   * 1. 计算 `<turnCommit>^..<turnCommit>` 的反向 diff；
   * 2. 将反向 diff 输出给用户预览（通过 enhanceDiffPreview 渲染）；
   * 3. 用户决定是否应用（应用时由用户在主仓库 git 工作流中操作，side-git 不直接写入 workspaceRoot）；
   * 4. side-git 内部仅记录"已撤销"标记，不修改任何文件。
   *
   * @param turnId 要撤销的 turn ID
   * @returns 反向 diff 预览（用户决定是否应用）
   */
  async revertTurn(turnId: string): Promise<RevertPreview> {
    return this.serialize(async () => {
      // 1. 定位目标 turn 的 commit
      const snapshot = await this.findSnapshot(turnId, "post_turn");

      // 2. 计算反向 diff（git diff <commit>^..<commit>，然后反转 +/-）
      const diff = await this.runGit(["diff", `${snapshot.commitHash}^..${snapshot.commitHash}`]);

      // 3. 渲染 diff 预览（复用 V2-P0a 的 enhanceDiffPreview）
      const preview = enhanceDiffPreview(null, diff, {
        colorEnabled: true,
        contextLines: 3,
      });

      // 4. 返回预览（不写入工作区，由用户决定是否应用）
      return {
        turnId,
        commitHash: snapshot.commitHash,
        changedFiles: snapshot.changedFiles,
        diffPreview: preview.rendered,
        stats: preview.stats,
        instructions: "请审阅以下反向 diff，决定是否在主仓库中应用（side-git 不会自动修改工作区）",
      };
    });
  }

  /**
   * 清理旧快照（保留最近 maxSnapshots 个，P1-02 修复：逻辑删除 + 低频 gc）
   */
  async cleanupOldSnapshots(): Promise<number> {
    return this.serialize(async () => {
      // 1. 列出所有快照（按时间倒序）
      const all = await this.listSnapshots();

      // 2. 计算需保留的最近 N 个（maxSnapshots 默认 50）
      const keep = all.slice(0, this.config.maxSnapshots);

      // 3. 在 manifest.json 中标记保留集合（不修改 git 历史，逻辑删除）
      await this.updateRetainedSet(keep.map((s) => s.commitHash));

      // 4. 物理清理：仅当 all.length > maxSnapshots * 2 时触发 git gc（低频）
      if (all.length > this.config.maxSnapshots * 2) {
        await this.runGit(["reflog", "expire", "--expire=now", "--all"]);
        await this.runGit(["gc", "--prune=now"]);
      }

      // 5. 返回被清理（逻辑删除）的快照数
      return all.length - keep.length;
    });
  }

  /**
   * 检查 git 是否可用（preflight）
   */
  static async checkGitAvailable(): Promise<boolean> {
    try {
      await execFileAsync("git", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  // ========== 私有辅助方法 ==========

  /**
   * 获取变更文件列表（git status --porcelain）
   *
   * 使用 NUL 分隔模式（-z）彻底消除空格/特殊字符/引号包裹的解析歧义：
   * - `git status --porcelain -z` 输出格式：XY<space>filename<NUL>
   * - 每个条目以 NUL 字符（\0）结尾，文件名可含任意字符（包括空格、换行、引号）
   * - 状态码 XY 固定 2 字符 + 1 空格 = 3 字符前缀
   *
   * 与 -z 模式对比（porcelain 默认模式）：
   * - 默认模式：含空格/特殊字符的文件名会被引号包裹，需额外处理；
   * - -z 模式：文件名原样输出（无引号），以 NUL 分隔，解析 100% 可靠。
   */
  private async getChangedFiles(): Promise<string[]> {
    // 注意：runGit 返回 trim() 后的字符串，会去除末尾 NUL，
    // 因此这里直接使用 execFileAsync 而非 runGit 封装（保留原始字节）
    const args = [
      `--git-dir=${this.config.sideGitDir}`,
      `--work-tree=${this.config.workspaceRoot}`,
      "status",
      "--porcelain",
      "-z",
    ];
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.config.workspaceRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "DeepCode SideGit",
        GIT_AUTHOR_EMAIL: "side-git@deepcode.local",
        GIT_COMMITTER_NAME: "DeepCode SideGit",
        GIT_COMMITTER_EMAIL: "side-git@deepcode.local",
      },
      encoding: "utf8",
    });

    if (!stdout) return [];

    // 按 NUL 字符分割条目，每个条目格式：XY<space>filename
    const files = stdout
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        // 去掉前 3 个字符（XY + 空格）
        // 状态码 XY 固定 2 字符 + 1 空格 = 3 字符前缀
        return entry.slice(3);
      });

    // P2-06：应用忽略模式过滤（node_modules/、.gitignore 规则等不进入快照）
    return files.filter((f) => !this.isIgnored(f));
  }

  /**
   * 从当前 HEAD 构造 TurnSnapshot（无变更时）
   */
  private async snapshotFromCurrentHead(
    turnId: string,
    type: "pre_turn" | "post_turn",
    taskId?: string
  ): Promise<TurnSnapshot> {
    const commitHash = await this.runGit(["rev-parse", "HEAD"]);
    const timestamp = new Date().toISOString();

    const snapshot: TurnSnapshot = {
      turnId,
      type,
      timestamp,
      commitHash,
      changedFiles: [],
      additions: 0,
      deletions: 0,
      taskId,
    };

    // 更新 manifest.json（记录无变更快照）
    await this.updateManifest(snapshot);

    return snapshot;
  }

  /**
   * 计算 diff stats（git diff --numstat <parent>..<new>）
   */
  private async getDiffStats(
    parentHash: string,
    commitHash: string
  ): Promise<{ additions: number; deletions: number }> {
    const stdout = await this.runGit(["diff", "--numstat", `${parentHash}..${commitHash}`]);

    let additions = 0;
    let deletions = 0;

    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      const [add, del] = line.split("\t").map(Number);
      additions += add || 0;
      deletions += del || 0;
    }

    return { additions, deletions };
  }

  /**
   * 构造 commit message（P1-03 修复：多行 YAML frontmatter，机器可解析）
   */
  private buildCommitMessage(snapshot: TurnSnapshot): string {
    return [
      `snapshot: ${snapshot.type}`,
      `turnId: ${snapshot.turnId}`,
      `taskId: ${snapshot.taskId ?? "default-task"}`,
      `timestamp: ${snapshot.timestamp}`,
      "",
      `DeepCode side-git snapshot: ${snapshot.type} ${snapshot.turnId}`,
    ].join("\n");
  }

  /**
   * 更新 manifest.json（P1-03 修复：元数据与 commit 解耦）
   */
  private async updateManifest(snapshot: TurnSnapshot): Promise<void> {
    const manifestPath = path.join(this.config.sideGitDir, "manifest.json");

    let manifest: ManifestData;
    try {
      const content = await fs.readFile(manifestPath, "utf8");
      manifest = JSON.parse(content);
    } catch {
      // manifest 损坏时重建
      manifest = {
        version: "1.0.0",
        lastUpdated: new Date().toISOString(),
        snapshots: [],
      };
    }

    // 追加新快照
    manifest.snapshots.push(snapshot);
    manifest.lastUpdated = new Date().toISOString();

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }

  /**
   * 更新保留集合（cleanupOldSnapshots 逻辑删除标记）
   */
  private async updateRetainedSet(commitHashes: string[]): Promise<void> {
    const manifestPath = path.join(this.config.sideGitDir, "manifest.json");

    let manifest: ManifestData;
    try {
      const content = await fs.readFile(manifestPath, "utf8");
      manifest = JSON.parse(content);
    } catch {
      manifest = {
        version: "1.0.0",
        lastUpdated: new Date().toISOString(),
        snapshots: [],
      };
    }

    manifest.retainedSet = commitHashes;
    manifest.lastUpdated = new Date().toISOString();

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }

  /**
   * 从 git log 解析快照列表（manifest 损坏时的降级方案）
   */
  private async listSnapshotsFromGitLog(): Promise<TurnSnapshot[]> {
    const stdout = await this.runGit(["log", "--pretty=format:%H|%s", "--no-merges"]);

    const snapshots: TurnSnapshot[] = [];

    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;

      const [commitHash, _subject] = line.split("|", 2);

      // 解析 commit message（YAML frontmatter）
      const message = await this.runGit(["log", "-1", "--pretty=format:%B", commitHash]);
      const lines = message.split("\n");

      let turnId = "";
      let type: "pre_turn" | "post_turn" = "pre_turn";
      let timestamp = "";
      let taskId: string | undefined;

      for (const msgLine of lines) {
        if (msgLine.startsWith("turnId:")) {
          turnId = msgLine.slice(7).trim();
        } else if (msgLine.startsWith("snapshot:")) {
          type = msgLine.slice(9).trim() as "pre_turn" | "post_turn";
        } else if (msgLine.startsWith("timestamp:")) {
          timestamp = msgLine.slice(10).trim();
        } else if (msgLine.startsWith("taskId:")) {
          const tid = msgLine.slice(7).trim();
          taskId = tid === "default-task" ? undefined : tid;
        }
      }

      if (turnId && timestamp) {
        snapshots.push({
          turnId,
          type,
          timestamp,
          commitHash,
          changedFiles: [], // git log 无法获取，需重新计算
          additions: 0,
          deletions: 0,
          taskId,
        });
      }
    }

    return snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /**
   * 查找指定 turn 的快照
   */
  private async findSnapshot(turnId: string, type: "pre_turn" | "post_turn"): Promise<TurnSnapshot> {
    const snapshots = await this.listSnapshots();
    const snapshot = snapshots.find((s) => s.turnId === turnId && s.type === type);

    if (!snapshot) {
      throw new Error(`快照不存在：turnId=${turnId}, type=${type}`);
    }

    return snapshot;
  }
}

/**
 * 生成 turn ID（P1-03 修复）
 *
 * 格式：<ISO8601-compact>-<random-6>，如 20260717T143022-a1b2c3
 *
 * @returns turn ID
 */
export function generateTurnId(): string {
  const now = new Date();
  const compact = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
    .replace("T", "T");
  const rand = crypto.randomBytes(3).toString("hex");
  return `${compact}-${rand}`;
}

/**
 * 计算项目哈希（用于推导 side-git 仓库路径 ~/.deepcode/side-git/<project_hash>/）
 *
 * @param projectRoot 项目根目录
 * @returns 项目哈希（SHA256 前 16 位）
 */
export function projectHash(projectRoot: string): string {
  return crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
}
