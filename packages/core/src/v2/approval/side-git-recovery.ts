/**
 * side-git 仓库恢复器：损坏检测 + 自动重建
 *
 * 设计依据：
 * - V2_CONTEXT_MEMORY_TECH_DESIGN.md §4.4 US-ERR-001 side-git 仓库损坏自动重建（v2.4 修订版）
 * - PRD US-ERR-001：检测到 side-git 仓库损坏时，自动删除并重新初始化
 * - P1-06 修复：IntegrityFailure 枚举补全 refs_corrupt / worktree_missing / config_corrupt
 * - P1-07 修复：rebuild 失败降级机制（degradedMode + 5 分钟退避）
 * - P1-08 修复：rebuild 四步操作各步失败处置
 *
 * 调用契约：
 * - ToolRouter.route() 在 requiresSnapshot 分支前先执行 verifyIntegrityLightweight()；
 * - 失败则 rebuild() 后继续，重建本身不阻断工具执行；
 * - rebuild 失败进入 degradedMode（5 分钟退避），期间跳过 createSnapshot 直接放行工具执行。
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { SideGitManager, SideGitConfig } from "./side-git.js";
import { generateTurnId } from "./side-git.js";

const execFileAsync = promisify(execFile);

/**
 * 完整性失败项枚举：逐项列出损坏证据，便于用户诊断与测试断言
 *
 * v2.4 修订（P1-06 修复）：补全遗漏的 refs_corrupt / worktree_missing / config_corrupt 场景，
 * 覆盖 US-ERR-001 全部可能的损坏模式，确保自动重建机制在所有损坏场景下生效。
 *
 * - git_dir_missing：side-git .git 目录整体缺失
 * - head_corrupt：.git/HEAD 不存在或内容无法解析为合法 ref
 * - index_corrupt：.git/index 损坏（git status 非零退出）
 * - objects_corrupt：对象库损坏（git fsck 报错）
 * - refs_corrupt：refs 文件损坏（.git/refs/heads/* 文件被篡改，HEAD 文件正常但 git rev-parse --verify HEAD 失败）
 * - worktree_missing：workspaceRoot 目录不存在或不可读（用户删除了项目目录）
 * - config_corrupt：.git/config 文件损坏（git config --local --list 非零退出）
 * - git_exec_failed：git 子进程本身执行失败（git 未安装/权限问题）
 * - degraded_mode：rebuild() 失败后进入降级模式（5 分钟退避期内直接返回，跳过实际检查）
 */
export type IntegrityFailure =
  | "git_dir_missing"
  | "head_corrupt"
  | "index_corrupt"
  | "objects_corrupt"
  | "refs_corrupt"
  | "worktree_missing"
  | "config_corrupt"
  | "git_exec_failed"
  | "degraded_mode";

/**
 * 完整性报告：健康时 failures 为空数组
 */
export interface IntegrityReport {
  /** 是否健康（failures 为空即 true） */
  healthy: boolean;
  /** 失败项清单（健康时为空数组） */
  failures: IntegrityFailure[];
  /** 本次执行的是哪一级检查（lightweight/full） */
  checkLevel: "lightweight" | "full";
}

/**
 * side-git 仓库恢复器：损坏检测 + 自动重建
 *
 * 核心能力：
 * - verifyIntegrityLightweight()：轻量完整性检查（每快照执行，毫秒级，不击穿 500ms 快照预算）
 * - verifyIntegrityFull()：完整完整性检查（仅 initialize 或轻量检查失败后的重建前确认执行）
 * - rebuild()：自动重建（备份 → 重建 → 基线快照 → 通知，四步操作各步失败处置一致）
 *
 * 降级模式（P1-07 修复）：
 * - rebuild() 失败后 degradedMode=true 且 degradedUntil=Date.now()+5*60*1000（5 分钟退避）；
 * - 降级模式下 verifyIntegrityLightweight() 直接返回 healthy=false, failures=["degraded_mode"]，跳过实际检查；
 * - 退避到期后 degradedMode=false，重新执行实际检查（重试机制）。
 */
export class SideGitRecovery {
  /**
   * 降级模式标志（P1-07 修复）：
   * rebuild() 失败后设为 true，verifyIntegrityLightweight() 在退避期内直接返回
   * healthy=false, failures=["degraded_mode"]，跳过实际检查，避免每次 turn 都重复失败 rebuild。
   */
  private degradedMode = false;

  /**
   * 降级模式退避到期时间戳（毫秒）：
   * rebuild() 失败后设为 Date.now() + 5 * 60 * 1000（5 分钟退避）。
   * 退避到期后 degradedMode 自动清除，重新执行实际检查（重试机制）。
   */
  private degradedUntil: number = 0;

  constructor(
    /** 既有 side-git 管理器（§4.2.3），重建时复用其 initialize() */
    private readonly sideGit: SideGitManager,
    /** side-git 配置（sideGitDir / workspaceRoot 等） */
    private readonly config: SideGitConfig,
    /** 用户通知回调（接 §9 集成层 onAssistantMessage 通道） */
    private readonly notify: (message: string) => void
  ) {}

  /**
   * 轻量完整性检查（每快照执行，毫秒级，不击穿 500ms 快照预算）
   *
   * v2.4 修订（P1-06 修复）：补全 refs_corrupt / worktree_missing / config_corrupt 检测。
   *
   * 检查项：
   * 1. stat sideGitDir/.git —— 缺失记 git_dir_missing；
   * 2. fs.existsSync(workspaceRoot) —— 不存在记 worktree_missing；
   * 3. 读取 .git/HEAD —— 不存在或内容既不是 "ref: refs/heads/xxx" 也不是 40 位 hash，记 head_corrupt；
   * 4. execFile git rev-parse --verify HEAD（GIT_DIR/GIT_WORK_TREE 环境变量设置同 §4.2.3）—— 非零退出记 refs_corrupt；
   * 5. execFile git status --porcelain —— 非零退出记 index_corrupt；
   * 6. execFile git config --local --list —— 非零退出记 config_corrupt。
   *
   * 约定：任一失败即 healthy=false；本方法自身绝不抛出异常（检测流程不得阻塞路由主流程）。
   *
   * 降级模式（P1-07 修复）：
   * - rebuild() 失败后 degradedMode=true 且 degradedUntil=Date.now()+5*60*1000（5 分钟退避）；
   * - 降级模式下直接返回 healthy=false, failures=["degraded_mode"]，跳过实际检查；
   * - 退避到期后 degradedMode=false，重新执行实际检查（重试机制）。
   */
  async verifyIntegrityLightweight(): Promise<IntegrityReport> {
    // P1-07 修复：降级模式下直接返回 degraded_mode，跳过实际检查
    if (this.degradedMode && Date.now() < this.degradedUntil) {
      return {
        healthy: false,
        failures: ["degraded_mode"],
        checkLevel: "lightweight",
      };
    }

    // 退避到期，清除降级模式（重试机制）
    if (this.degradedMode && Date.now() >= this.degradedUntil) {
      this.degradedMode = false;
    }

    const failures: IntegrityFailure[] = [];

    try {
      // 1. stat sideGitDir/HEAD —— 缺失记 git_dir_missing
      //    注意：sideGitDir 本身就是 git-dir（--git-dir=sideGitDir），不是 sideGitDir/.git
      const gitDirExists = await fs
        .access(path.join(this.config.sideGitDir, "HEAD"))
        .then(() => true)
        .catch(() => false);
      if (!gitDirExists) {
        failures.push("git_dir_missing");
      }

      // 2. fs.existsSync(workspaceRoot) —— 不存在记 worktree_missing
      const worktreeExists = await fs
        .access(this.config.workspaceRoot)
        .then(() => true)
        .catch(() => false);
      if (!worktreeExists) {
        failures.push("worktree_missing");
      }

      // 3. 读取 HEAD —— 不存在或内容不合法记 head_corrupt
      if (gitDirExists) {
        try {
          const headPath = path.join(this.config.sideGitDir, "HEAD");
          const headContent = await fs.readFile(headPath, "utf8");
          const isValidRef =
            headContent.trim().startsWith("ref: refs/heads/") || /^[0-9a-f]{40}$/.test(headContent.trim());
          if (!isValidRef) {
            failures.push("head_corrupt");
          }
        } catch {
          failures.push("head_corrupt");
        }
      }

      // 步骤 4-6 的 git 子进程均以 workspaceRoot 为 cwd，worktree 缺失时必然全部失败。
      // 为避免级联噪声（refs_corrupt/index_corrupt/config_corrupt 掩盖 worktree_missing 根因），
      // worktree 缺失时直接跳过 git 子进程检查，报告保持精确（P1-06 语义对齐）。
      const skipGitExecChecks = !worktreeExists;

      // 4. execFile git rev-parse --verify HEAD —— 非零退出记 refs_corrupt
      if (!skipGitExecChecks && gitDirExists && !failures.includes("head_corrupt")) {
        try {
          await this.runGit(["rev-parse", "--verify", "HEAD"]);
        } catch {
          failures.push("refs_corrupt");
        }
      }

      // 5. execFile git status --porcelain —— 非零退出记 index_corrupt
      if (!skipGitExecChecks && gitDirExists && worktreeExists) {
        try {
          await this.runGit(["status", "--porcelain"]);
        } catch {
          failures.push("index_corrupt");
        }
      }

      // 6. execFile git config --local --list —— 非零退出记 config_corrupt
      if (!skipGitExecChecks && gitDirExists) {
        try {
          await this.runGit(["config", "--local", "--list"]);
        } catch {
          failures.push("config_corrupt");
        }
      }
    } catch (_err) {
      // git 子进程本身执行失败（git 未安装/权限问题）
      failures.push("git_exec_failed");
    }

    return {
      healthy: failures.length === 0,
      failures,
      checkLevel: "lightweight",
    };
  }

  /**
   * 完整完整性检查（仅 initialize 或轻量检查失败后的重建前确认执行）
   *
   * 在轻量检查基础上追加 git fsck --no-dangling，非零退出记 objects_corrupt；
   * git 子进程无法启动（ENOENT/EACCES）记 git_exec_failed。
   */
  async verifyIntegrityFull(): Promise<IntegrityReport> {
    const lightweightReport = await this.verifyIntegrityLightweight();

    if (!lightweightReport.healthy) {
      // 轻量检查已失败，直接返回（无需完整检查）
      return {
        ...lightweightReport,
        checkLevel: "full",
      };
    }

    const failures: IntegrityFailure[] = [...lightweightReport.failures];

    // 追加 git fsck --no-dangling 对象库校验
    try {
      await this.runGit(["fsck", "--no-dangling"]);
    } catch {
      failures.push("objects_corrupt");
    }

    return {
      healthy: failures.length === 0,
      failures,
      checkLevel: "full",
    };
  }

  /**
   * 自动重建（对应 PRD US-ERR-001 三条验收）
   *
   * v2.4 修订（P1-08 修复）：明确四步操作各步失败处置，保证状态一致性。
   *
   * 四步操作流程：
   * 1. 将损坏目录整体重命名为 `<sideGitDir>.corrupted-<timestamp>` 备份
   *    （不直接删除：保留现场可审计、可人工抢救历史快照，等效达成"删除并重新初始化"）；
   * 2. 调用 SideGitManager.initialize() 在原路径重建仓库（git init + 本地 user 配置 + 初始 commit）；
   * 3. 立即对当前工作区创建基线快照（type="pre_turn"，taskId="recovery-baseline"），
   *    保证重建后即刻存在可回滚点；
   * 4. 通过 notify 通知用户「side-git 已重建，历史快照已清除」。
   *
   * 各步失败处置（P1-08 修复）：
   * - 步骤 1 备份失败：保留原损坏目录供人工排查，抛出异常进入 degradedMode；
   * - 步骤 2 重建失败：尝试恢复备份（fs.rename(backupPath, sideGitDir)），抛出异常进入 degradedMode；
   * - 步骤 3 基线快照失败：sideGitDir 已就绪，notify 告警但不视为重建失败，下次 createSnapshot 时再建快照；
   * - 步骤 4 通知失败：不影响重建成功，静默忽略（try/catch 包裹）。
   *
   * 降级模式（P1-07 修复）：
   * - 重建成功：degradedMode = false，清除降级标志；
   * - 重建失败：degradedMode = true，degradedUntil = Date.now() + 5 * 60 * 1000（5 分钟退避），
   *   notify 告警「side-git 重建失败：<原因>，未来 5 分钟跳过快照」，
   *   降级为无快照运行，不阻断 ToolRouter 中的工具执行。
   */
  async rebuild(): Promise<void> {
    let backupPath: string | null = null;

    try {
      // 步骤 1：备份（失败则不重建，保留原损坏目录供人工排查）
      try {
        backupPath = await this.backupCorruptedDir();
      } catch (err) {
        this.safeNotify(`side-git 备份失败：${(err as Error).message}，原目录保留`);
        throw err; // 上层捕获后进入 degradedMode
      }

      // 步骤 2：重建（失败则尝试恢复备份）
      try {
        await this.sideGit.initialize();
      } catch (err) {
        // 重建失败：尝试恢复备份（让原损坏目录回归，至少保留可审计现场）
        if (backupPath) {
          try {
            await fs.rename(backupPath, this.config.sideGitDir);
          } catch {
            // 恢复备份失败，静默忽略
          }
        }
        throw err;
      }

      // 步骤 3：基线快照（失败则 sideGitDir 已就绪，下次 createSnapshot 时再建快照）
      try {
        await this.sideGit.createSnapshot(generateTurnId(), "pre_turn", "recovery-baseline");
      } catch (err) {
        this.safeNotify(`side-git 重建成功但基线快照失败：${(err as Error).message}，下次操作时会创建快照`);
        // 不视为重建失败，继续步骤 4
      }

      // 步骤 4：通知（失败不影响重建成功）
      this.safeNotify("side-git 已重建，历史快照已清除");

      // 重建成功，清除降级标志
      this.degradedMode = false;
    } catch (err) {
      // 重建失败，进入降级模式（P1-07 修复）
      this.degradedMode = true;
      this.degradedUntil = Date.now() + 5 * 60 * 1000; // 5 分钟退避
      this.safeNotify(`side-git 重建失败：${(err as Error).message}，未来 5 分钟跳过快照`);
      // 不抛出异常，降级为无快照运行
    }
  }

  // ========== 私有辅助方法 ==========

  /**
   * 安全通知：notify 回调抛错时静默忽略
   *
   * 契约保护：rebuild() 承诺"不抛出异常，降级为无快照运行"。
   * 若 notify 回调（UI 通道）自身抛错且未被捕获，异常会穿透 rebuild 破坏该契约，
   * 甚至掩盖真正的重建失败原因。因此所有通知统一经此包装。
   */
  private safeNotify(message: string): void {
    try {
      this.notify(message);
    } catch {
      // 静默忽略：通知通道异常不影响重建主流程
    }
  }

  /**
   * 执行 git 命令（与 SideGitManager.runGit 一致）
   */
  private async runGit(userArgs: string[]): Promise<string> {
    const args = [`--git-dir=${this.config.sideGitDir}`, `--work-tree=${this.config.workspaceRoot}`, ...userArgs];
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.config.workspaceRoot,
    });
    return stdout.trim();
  }

  /**
   * 备份损坏目录（步骤 1）
   *
   * 将损坏目录整体重命名为 `<sideGitDir>.corrupted-<timestamp>` 备份
   * （不直接删除：保留现场可审计、可人工抢救历史快照，等效达成"删除并重新初始化"）。
   *
   * @returns 备份目录路径
   */
  private async backupCorruptedDir(): Promise<string> {
    const timestamp = Date.now();
    const backupPath = `${this.config.sideGitDir}.corrupted-${timestamp}`;
    await fs.rename(this.config.sideGitDir, backupPath);
    return backupPath;
  }
}
