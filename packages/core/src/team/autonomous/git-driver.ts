/**
 * Git 操作封装（V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/autonomous/git_driver.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 * Karpathy 原则：Simplicity First - 单一职责，封装 git 命令
 * Ponytail 红线：禁止"假装 commit 成功"，必须真实调用 git 并校验
 *
 * 真实实现能力：
 *   1. 真实执行 git 命令（不模拟、不静默）
 *   2. rollback 保留 uncommitted work 到 .deepcodex/runs/<id>/uncommitted/
 *   3. 失败暴露详细错误（不假装成功）
 *   4. 通过环境变量注入 commit 作者（不污染全局 git config）
 *   5. diff_stats 解析（numstat + binary files）
 *   6. sha256 校验（uncommitted work 恢复时）
 *   7. git 命令超时控制
 */

import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// 第一部分：类型定义
// ============================================================================

/** git 操作结果 */
export interface GitOpResult {
  success: boolean;
  stdout: string;
  stderr: string;
  returncode: number;
  errorMessage: string;
}

/** 默认 GitOpResult 工厂 */
export function defaultGitOpResult(): GitOpResult {
  return {
    success: false,
    stdout: "",
    stderr: "",
    returncode: 0,
    errorMessage: "",
  };
}

/** diff 统计 */
export interface DiffStats {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  binaryFiles: number;
}

/** 默认 DiffStats 工厂 */
export function defaultDiffStats(): DiffStats {
  return {
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    binaryFiles: 0,
  };
}

/** Manifest 条目（uncommitted work 元数据） */
interface ManifestEntry {
  path: string;
  status: string;
  sha256?: string;
  size?: number;
  error?: string;
}

/** Manifest 数据 */
interface ManifestData {
  runId: string;
  timestampMs: number;
  files: ManifestEntry[];
}

// ============================================================================
// 第二部分：GitDriver 类
// ============================================================================

/**
 * Ralph 风格 Git 操作封装
 *
 * 设计原则：
 *   1. 真实调用 git 命令（不模拟）
 *   2. 失败有详细错误（不假装成功）
 *   3. rollback 保留 uncommitted work 到 .deepcodex/runs/<id>/uncommitted/
 */
export class GitDriver {
  private readonly repoRoot: string;
  private readonly runId: string;
  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly runDir: string;
  private readonly uncommittedDir: string;
  private readonly gitTimeout: number;
  /** 缓存 is_git_repo 结果 */
  private isRepoCache: boolean | null = null;

  constructor(args: {
    repoRoot: string;
    runId: string;
    authorName?: string;
    authorEmail?: string;
    runDir?: string;
    gitTimeoutSec?: number;
  }) {
    this.repoRoot = path.resolve(args.repoRoot);
    this.runId = args.runId;
    this.authorName = args.authorName ?? "Ralph Autonomous Agent";
    this.authorEmail = args.authorEmail ?? "ralph@trae-multi-agent.local";
    this.runDir = args.runDir ? path.resolve(args.runDir) : path.join(this.repoRoot, ".deepcodex", "runs", this.runId);
    this.uncommittedDir = path.join(this.runDir, "uncommitted");
    this.gitTimeout = Math.max(1.0, Number(args.gitTimeoutSec ?? 30.0));
  }

  // ========================================================================
  // 公共 API
  // ========================================================================

  /**
   * 检测 repoRoot 是否为 git 仓库
   *
   * @returns true = 是 git 仓库
   */
  isGitRepo(): boolean {
    if (this.isRepoCache !== null) {
      return this.isRepoCache;
    }
    const result = this.runGit("rev-parse", "--is-inside-work-tree", false);
    this.isRepoCache = result.success && result.stdout.trim() === "true";
    return this.isRepoCache;
  }

  /**
   * git status --porcelain
   */
  status(): GitOpResult {
    return this.runGit("status", "--porcelain", true);
  }

  /**
   * 获取 diff 统计
   *
   * @param sinceCommit 起始 commit（undefined = 与 HEAD 相比；或 commit hash）
   */
  diffStats(sinceCommit?: string): DiffStats {
    const rangeSpec = sinceCommit ? `${sinceCommit}..HEAD` : "HEAD";
    // 文件列表
    const nameResult = this.runGit("diff", "--name-only", rangeSpec, false);
    if (!nameResult.success) {
      return defaultDiffStats();
    }
    const files = nameResult.stdout.split(/\r?\n/).filter((f) => f.trim().length > 0);
    // 行数统计
    const numstatResult = this.runGit("diff", "--numstat", rangeSpec, false);
    let added = 0;
    let removed = 0;
    let binary = 0;
    if (numstatResult.success) {
      for (const line of numstatResult.stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const a = parts[0] ?? "";
        const r = parts[1] ?? "";
        if (a === "-" && r === "-") {
          binary += 1;
        } else {
          const aNum = parseInt(a, 10);
          const rNum = parseInt(r, 10);
          if (Number.isFinite(aNum)) added += aNum;
          if (Number.isFinite(rNum)) removed += rNum;
        }
      }
    }
    return {
      filesChanged: files.length,
      linesAdded: added,
      linesRemoved: removed,
      binaryFiles: binary,
    };
  }

  /**
   * git add -A
   */
  addAll(): GitOpResult {
    return this.runGit("add", "-A", true);
  }

  /**
   * git commit -m "<message>"
   *
   * 行为：
   *   1. 先 git status --porcelain 检查是否有变更
   *   2. git add -A
   *   3. GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL 环境变量注入作者
   *   4. git commit -m "<message>"
   *   5. 返回 commit hash
   */
  commit(message: string): GitOpResult {
    if (!message || !message.trim()) {
      return {
        ...defaultGitOpResult(),
        errorMessage: "commit message 不能为空",
      };
    }
    // 先检查是否有变更
    const statusResult = this.status();
    if (!statusResult.success) {
      return statusResult;
    }
    if (!statusResult.stdout.trim()) {
      return {
        ...defaultGitOpResult(),
        stderr: statusResult.stderr,
        errorMessage: "工作区干净，无变更可提交",
      };
    }
    // git add -A
    const addResult = this.addAll();
    if (!addResult.success) {
      return addResult;
    }
    // 用环境变量注入作者（不修改全局 git config）
    const env: NodeJS.ProcessEnv = { ...process.env };
    env["GIT_AUTHOR_NAME"] = this.authorName;
    env["GIT_AUTHOR_EMAIL"] = this.authorEmail;
    env["GIT_COMMITTER_NAME"] = this.authorName;
    env["GIT_COMMITTER_EMAIL"] = this.authorEmail;
    return this.runGitWithEnv(env, "commit", "-m", message, true);
  }

  /**
   * 回滚工作区（保留 uncommitted work）
   *
   * 行为：
   *   1. 如果有 uncommitted 变更：
   *      a. 创建 .deepcodex/runs/<run_id>/uncommitted/<timestamp>/ 目录
   *      b. 用 git diff 和 git status 收集所有变更
   *      c. cp 所有 untracked/modified 文件到 uncommitted 目录
   *      d. git checkout -- . 撤销 tracked 变更
   *      e. 保留 untracked 文件
   *   2. 记录 uncommitted 清单到 manifest.json
   */
  rollback(): GitOpResult {
    if (!this.isGitRepo()) {
      return {
        ...defaultGitOpResult(),
        errorMessage: `不是 git 仓库: ${this.repoRoot}`,
      };
    }
    // 检查工作区状态
    const statusResult = this.status();
    if (!statusResult.success) {
      return statusResult;
    }
    const porcelain = statusResult.stdout;
    if (!porcelain.trim()) {
      return {
        success: true,
        stdout: "工作区已经干净，无需回滚",
        stderr: "",
        returncode: 0,
        errorMessage: "",
      };
    }
    // 创建 uncommitted 目录
    const timestamp = Date.now();
    const snapshotDir = path.join(this.uncommittedDir, String(timestamp));
    fs.mkdirSync(snapshotDir, { recursive: true });
    // 解析 porcelain 输出，收集所有变更文件
    const manifest: ManifestEntry[] = [];
    for (const line of porcelain.split(/\r?\n/)) {
      if (!line.trim()) continue;
      // porcelain 格式: "XY filename"（XY = 2 字符状态）
      // 也可能 "XY old -> new"（rename/copy）
      if (line.length < 4) continue;
      const statusCode = line.slice(0, 2);
      let filename = line.slice(3).trim();
      // 处理 rename: "old -> new"
      if (filename.includes(" -> ")) {
        const parts = filename.split(" -> ", 2);
        filename = (parts[1] ?? "").trim().replace(/^"|"$/g, "");
      }
      const srcPath = path.join(this.repoRoot, filename);
      if (!fs.existsSync(srcPath)) continue;
      // 计算 sha256（用于恢复时校验）
      let sha: string;
      try {
        sha = sha256File(srcPath);
      } catch (err) {
        manifest.push({
          path: filename,
          status: statusCode,
          error: `无法读取: ${formatError(err)}`,
        });
        continue;
      }
      // 拷贝到 snapshot 目录
      const dest = path.join(snapshotDir, filename);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(srcPath, dest);
      } catch (err) {
        manifest.push({
          path: filename,
          status: statusCode,
          error: `无法拷贝: ${formatError(err)}`,
        });
        continue;
      }
      const stat = fs.statSync(srcPath);
      manifest.push({
        path: filename,
        status: statusCode,
        sha256: sha,
        size: stat.size,
      });
    }
    // 写 manifest
    const manifestPath = path.join(snapshotDir, "manifest.json");
    const manifestData: ManifestData = {
      runId: this.runId,
      timestampMs: timestamp,
      files: manifest,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), "utf-8");
    // git checkout -- . 撤销 tracked 变更
    const checkoutResult = this.runGit("checkout", "--", ".", true);
    if (!checkoutResult.success) {
      return {
        success: false,
        stdout: checkoutResult.stdout,
        stderr: checkoutResult.stderr,
        returncode: checkoutResult.returncode,
        errorMessage: `git checkout -- . 失败: ${checkoutResult.errorMessage}`,
      };
    }
    // 注意：此处保留 untracked 文件（不调用 clean）以避免误删用户数据
    return {
      success: true,
      stdout: `已回滚，uncommitted work 保留至 ${snapshotDir}`,
      stderr: "",
      returncode: 0,
      errorMessage: "",
    };
  }

  /**
   * 从 manifest 恢复 uncommitted work（供 fix_handler 使用）
   *
   * @param manifestPath manifest.json 路径
   */
  restoreUncommitted(manifestPath: string): GitOpResult {
    if (!fs.existsSync(manifestPath)) {
      return {
        ...defaultGitOpResult(),
        errorMessage: `manifest 不存在: ${manifestPath}`,
      };
    }
    let data: ManifestData;
    try {
      const raw = fs.readFileSync(manifestPath, "utf-8");
      data = JSON.parse(raw) as ManifestData;
    } catch (err) {
      return {
        ...defaultGitOpResult(),
        errorMessage: `无法读取 manifest: ${formatError(err)}`,
      };
    }
    const files = data.files ?? [];
    let restored = 0;
    const errors: string[] = [];
    for (const entry of files) {
      const p = entry.path;
      const sha = entry.sha256;
      if (!p || !sha) continue;
      const src = path.join(path.dirname(manifestPath), p);
      if (!fs.existsSync(src)) {
        errors.push(`${p}: 源文件不存在`);
        continue;
      }
      // 校验 sha256
      let actualSha: string;
      try {
        actualSha = sha256File(src);
      } catch (err) {
        errors.push(`${p}: 读取失败: ${formatError(err)}`);
        continue;
      }
      if (actualSha !== sha) {
        errors.push(`${p}: sha256 不匹配 (期望 ${sha.slice(0, 8)}, 实际 ${actualSha.slice(0, 8)})`);
        continue;
      }
      // 恢复
      const dest = path.join(this.repoRoot, p);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        restored += 1;
      } catch (err) {
        errors.push(`${p}: 恢复失败: ${formatError(err)}`);
      }
    }
    // git add -A（让 git 重新跟踪）
    this.addAll();
    if (errors.length > 0) {
      return {
        success: false,
        stdout: `已恢复 ${restored} 个文件`,
        stderr: "",
        returncode: 0,
        errorMessage: `恢复过程中发生 ${errors.length} 个错误: ${errors.slice(0, 3).join("; ")}`,
      };
    }
    return {
      success: true,
      stdout: `已恢复 ${restored} 个文件`,
      stderr: "",
      returncode: 0,
      errorMessage: "",
    };
  }

  /**
   * git log -n --oneline
   *
   * @param n 取最近 N 条
   */
  logLastN(n: number = 10): string[] {
    const safeN = Math.max(1, n);
    const result = this.runGit("log", `-${safeN}`, "--oneline", false);
    if (!result.success) {
      return [];
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * 获取当前 HEAD commit hash（短格式）
   */
  getCurrentSha(): string {
    const result = this.runGit("rev-parse", "--short", "HEAD", false);
    if (!result.success) {
      return "";
    }
    return result.stdout.trim();
  }

  // ========================================================================
  // 内部辅助
  // ========================================================================

  /**
   * 执行 git 命令
   *
   * @param check true=非零退出码视为失败
   */
  private runGit(arg1: string, arg2: string, check: boolean): GitOpResult;
  private runGit(arg1: string, arg2: string, arg3: string, check: boolean): GitOpResult;
  private runGit(arg1: string, arg2: string, arg3: string, arg4: string, check: boolean): GitOpResult;
  private runGit(...args: unknown[]): GitOpResult {
    // 提取 check 和实际 git 参数
    const check = args[args.length - 1] as boolean;
    const gitArgs = args.slice(0, -1) as string[];
    // 构造环境变量
    const env: NodeJS.ProcessEnv = { ...process.env };
    // 直接调用 spawnSync（绕过重载 spread 类型问题）
    return this.runGitWithEnvImpl(env, gitArgs, check);
  }

  /**
   * runGitWithEnv 的实现版本（接受数组参数，避开重载 spread 问题）
   */
  private runGitWithEnvImpl(env: NodeJS.ProcessEnv, gitArgs: string[], check: boolean): GitOpResult {
    return this.runGitWithEnvCore(env, gitArgs, check);
  }

  /**
   * 使用指定环境变量执行 git 命令
   */
  private runGitWithEnv(env: NodeJS.ProcessEnv, arg1: string, check: boolean): GitOpResult;
  private runGitWithEnv(env: NodeJS.ProcessEnv, arg1: string, arg2: string, check: boolean): GitOpResult;
  private runGitWithEnv(env: NodeJS.ProcessEnv, arg1: string, arg2: string, arg3: string, check: boolean): GitOpResult;
  private runGitWithEnv(
    env: NodeJS.ProcessEnv,
    arg1: string,
    arg2: string,
    arg3: string,
    arg4: string,
    check: boolean
  ): GitOpResult;
  private runGitWithEnv(...args: unknown[]): GitOpResult {
    const env = args[0] as NodeJS.ProcessEnv;
    const check = args[args.length - 1] as boolean;
    const gitArgs = args.slice(1, -1) as string[];
    return this.runGitWithEnvCore(env, gitArgs, check);
  }

  /**
   * runGitWithEnv 的核心实现
   */
  private runGitWithEnvCore(env: NodeJS.ProcessEnv, gitArgs: string[], check: boolean): GitOpResult {
    // 检查 git 是否安装
    const gitPath = whichGit();
    if (!gitPath) {
      return {
        ...defaultGitOpResult(),
        errorMessage: "git 命令未找到，请先安装 git",
      };
    }
    const cmd = [gitPath, "-C", this.repoRoot, ...gitArgs];
    try {
      const proc = child_process.spawnSync(gitPath, ["-C", this.repoRoot, ...gitArgs], {
        env,
        encoding: "utf-8",
        timeout: this.gitTimeout * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const success = proc.status === 0;
      if (check && !success) {
        return {
          success: false,
          stdout: proc.stdout ?? "",
          stderr: proc.stderr ?? "",
          returncode: proc.status ?? -1,
          errorMessage: (proc.stderr ?? "").trim() || `git 退出码 ${proc.status}`,
        };
      }
      return {
        success,
        stdout: proc.stdout ?? "",
        stderr: proc.stderr ?? "",
        returncode: proc.status ?? 0,
        errorMessage: "",
      };
    } catch (err) {
      // spawnSync 抛出的错误（如 ENOENT 超大 buffer）也捕获
      return {
        ...defaultGitOpResult(),
        errorMessage: `无法执行 git: ${formatError(err)}`,
      };
    }
  }
}

// ============================================================================
// 第三部分：辅助函数
// ============================================================================

/**
 * 计算文件的 SHA-256 校验和
 */
function sha256File(p: string): string {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(p, "r");
  try {
    const buffer = Buffer.alloc(65536);
    let bytesRead = fs.readSync(fd, buffer, 0, 65536, null);
    while (bytesRead > 0) {
      h.update(buffer.subarray(0, bytesRead));
      bytesRead = fs.readSync(fd, buffer, 0, 65536, null);
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/**
 * 查找 git 可执行文件路径
 */
function whichGit(): string | null {
  // 直接尝试 spawnSync；若 PATH 中没有 git，会触发 ENOENT
  try {
    const proc = child_process.spawnSync("git", ["--version"], { encoding: "utf-8" });
    if (proc.error) return null;
    if (proc.status === 0) return "git";
  } catch {
    return null;
  }
  return "git";
}

/**
 * 格式化错误对象为可读字符串
 */
function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
