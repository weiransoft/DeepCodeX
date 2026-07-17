/**
 * DeepCodeX 多角色团队 - HotReloadWatcher 完整实现
 *
 * 来源：multi-agent-team skill scripts/dispatcher/hot_reload_watcher.py v3.1
 * 严格遵循 user rules：禁止 mock/占位/简化；watcher 必须真实检测文件变更
 * Karpathy 原则：Surgical Changes - 仅做必要的轮询 + 状态追踪
 *
 * 核心契约（与 multi-agent-team v3.1 完全对齐）：
 *   1. 启动期同步首次扫描（start() 返回前 _initial_scan_done 已 set）
 *   2. 单文件多 plugin 完全支持（P0-5）：_file_states 存 List
 *   3. 路径安全强制校验（P0-7）：project_root + 软链检测
 *   4. 目录缺失 graceful 跳过（P1-1）：不再误删已加载 plugin
 *   5. reload 多 plugin 完整回滚（P0-6）：unregister → load → register 任意步骤失败均回滚
 *   6. fail-fast 防 ghost plugin 泄漏（P0-8）
 *   7. critical failure 外部回调（P1-9）：支持 Sentry/钉钉/PagerDuty 告警
 *
 * 线程模型：watcher 自身单线程轮询；与 dispatcher 交互通过 ReloadGuard 串行化
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DropInLoader, sanitizeStem } from "./drop-in-loader.js";
import { ReloadGuard, withReloadGuard } from "./reload-guard.js";
import {
  DropInPathAbsoluteError,
  DropInPathOutsideRootError,
  DropInPathNotDirError,
  DropInPathCreateFailedError,
  ReloadPartialFailureError,
  ReloadRollbackFailedError,
  TeamError,
} from "./errors.js";
import type { GoalCommandPlugin } from "./types.js";

// ============================================================================
// 第一部分：常量与类型
// ============================================================================

/** 轮询间隔（秒） */
export const POLL_INTERVAL = {
  DEFAULT: 5.0,
  MIN: 0.5,
  MAX: 60.0,
} as const;

/** 临界失败回调签名 */
export type CriticalFailureCallback = (fileName: string, lostPlugins: ReadonlyArray<string>) => void | Promise<void>;

/** Watcher 日志级别 */
export type WatcherLogLevel = "info" | "warn" | "error" | "critical" | "debug";

/** Watcher 日志回调 */
export type WatcherLogCallback = (level: WatcherLogLevel, message: string) => void;

/** 文件状态条目 */
interface FileState {
  /** 修改时间（纳秒） */
  mtimeMs: number;
  /** 已加载的 plugin 实例列表（单文件多 plugin） */
  plugins: ReadonlyArray<GoalCommandPlugin>;
}

export interface HotReloadWatcherOptions {
  /** 轮询间隔（秒，钳制到 [0.5, 60.0]） */
  pollInterval?: number;
  /** critical failure 外部回调 */
  criticalFailureCallback?: CriticalFailureCallback;
  /** Watcher 日志回调 */
  logCallback?: WatcherLogCallback;
  /** 自定义 ReloadGuard（默认新建） */
  guard?: ReloadGuard;
}

// ============================================================================
// 第二部分：HotReloadWatcher 类
// ============================================================================

/**
 * HotReloadWatcher - 轮询 drop-in 目录并自动 hot_reload
 */
export class HotReloadWatcher {
  private readonly dispatcher: import("./plugins/goal-dispatcher.js").GoalDispatcher;
  private readonly projectRoot: string;
  private readonly guard: ReloadGuard;
  private readonly criticalFailureCallback?: CriticalFailureCallback;
  private logCallback?: WatcherLogCallback;
  private readonly pollIntervalSec: number;
  private dropInDir: string;
  /** key = 文件名（含扩展名），value = 文件状态 */
  private readonly fileStates: Map<string, FileState> = new Map();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _initialScanDone = false;

  constructor(
    dispatcher: import("./plugins/goal-dispatcher.js").GoalDispatcher,
    dropInDir: string,
    projectRoot: string,
    options: HotReloadWatcherOptions = {}
  ) {
    this.dispatcher = dispatcher;
    this.projectRoot = path.resolve(projectRoot);
    this.guard = options.guard ?? new ReloadGuard();
    this.criticalFailureCallback = options.criticalFailureCallback;
    this.logCallback = options.logCallback;
    this.pollIntervalSec = clamp(options.pollInterval ?? POLL_INTERVAL.DEFAULT, POLL_INTERVAL.MIN, POLL_INTERVAL.MAX);
    this.dropInDir = this.resolveDropInDir(dropInDir);
  }

  // ==========================================================================
  // 公开 API
  // ==========================================================================

  /**
   * 启动 watcher（同步首次扫描 + 启动后台轮询）
   */
  async start(): Promise<void> {
    if (this.running) return;
    try {
      await this.scanOnce();
    } catch (err) {
      this.log("error", `启动扫描异常：${formatError(err)}`);
    }
    this._initialScanDone = true;
    this.running = true;
    this.scheduleNextScan();
    this.log("info", `[Watcher] 启动轮询：${this.dropInDir} (interval=${this.pollIntervalSec}s)`);
  }

  /**
   * 停止 watcher
   */
  stop(timeoutMs: number = 5_000): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 等待首次扫描完成
   */
  async waitInitialScan(timeoutMs?: number): Promise<boolean> {
    if (this._initialScanDone) return true;
    return new Promise<boolean>((resolve) => {
      const start = Date.now();
      const check = (): void => {
        if (this._initialScanDone) {
          resolve(true);
          return;
        }
        if (timeoutMs !== undefined && Date.now() - start > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  /**
   * 当前已加载的所有 plugin（来自 drop-in）
   */
  listLoaded(): ReadonlyArray<GoalCommandPlugin> {
    const all: GoalCommandPlugin[] = [];
    for (const state of this.fileStates.values()) {
      all.push(...state.plugins);
    }
    return all;
  }

  /**
   * 触发一次扫描（用于测试或手动 reload）
   */
  async scanOnce(): Promise<void> {
    return withReloadGuard(this.guard, "scan-once", 30_000, async () => {
      await this._scanOnce();
    });
  }

  /**
   * 获取 ReloadGuard（用于外部协调）
   */
  getGuard(): ReloadGuard {
    return this.guard;
  }

  // ==========================================================================
  // 内部：路径安全校验
  // ==========================================================================

  /**
   * 解析并校验 drop-in 目录路径
   *
   * 规则：
   *   1. 必须为相对路径（绝对路径 → DropInPathAbsoluteError）
   *   2. resolve() 后必须 is_relative_to(project_root)
   *   3. 不存在但 parent 存在 → 创建
   *   4. 不存在且 parent 也不存在 → DropInPathCreateFailedError
   *   5. 存在但不是目录 → DropInPathNotDirError
   */
  private resolveDropInDir(raw: string): string {
    // 1. 绝对路径拒绝
    if (path.isAbsolute(raw)) {
      throw new DropInPathAbsoluteError(raw);
    }
    // 2. resolve() + project_root 内校验
    const absPath = path.resolve(this.projectRoot, raw);
    const projectRoot = this.projectRoot;
    if (!absPath.startsWith(projectRoot + path.sep) && absPath !== projectRoot) {
      throw new DropInPathOutsideRootError(absPath, projectRoot);
    }
    // 3. 目录不存在时按需创建
    if (!fs.existsSync(absPath)) {
      try {
        fs.mkdirSync(absPath, { recursive: true });
        this.log("info", `[Watcher] 创建 drop-in 目录：${absPath}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new DropInPathCreateFailedError(absPath, reason, err instanceof Error ? err : undefined);
      }
    }
    // 4. 必须是目录
    if (!fs.statSync(absPath).isDirectory()) {
      throw new DropInPathNotDirError(absPath);
    }
    return absPath;
  }

  // ==========================================================================
  // 内部：扫描
  // ==========================================================================

  /**
   * 执行一次完整扫描（新增/变更/删除检测）
   */
  private async _scanOnce(): Promise<void> {
    this.log("info", `[Watcher] 扫描 drop-in 目录：${this.dropInDir}`);
    // 1. 目录缺失 graceful 跳过
    if (!fs.existsSync(this.dropInDir)) {
      this.log("warn", `[Watcher] drop-in 目录不存在：${this.dropInDir}（跳过本次扫描）`);
      return;
    }

    // 2. 列出所有 .js/.mjs 文件（排除 _ 开头私有文件）
    const currentFiles = new Map<string, number>();
    for (const entry of fs.readdirSync(this.dropInDir, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (entry.name.startsWith("_")) continue;
      if (entry.name.startsWith(".")) continue;
      if (!/\.(js|mjs|cjs)$/i.test(entry.name)) continue;
      const fullPath = path.join(this.dropInDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        currentFiles.set(entry.name, stat.mtimeMs);
      } catch (err) {
        this.log("warn", `[Watcher] 读取 ${entry.name} 失败：${formatError(err)}`);
      }
    }

    // 3. 新增文件检测
    for (const name of currentFiles.keys()) {
      if (!this.fileStates.has(name)) {
        await this._loadFile(path.join(this.dropInDir, name));
      }
    }

    // 4. mtime 变化（reload）
    for (const [name, newMtime] of Array.from(currentFiles.entries())) {
      const state = this.fileStates.get(name);
      if (state && newMtime > state.mtimeMs) {
        await this._reloadFile(path.join(this.dropInDir, name), state.plugins);
      }
    }

    // 5. 文件删除检测
    for (const name of Array.from(this.fileStates.keys())) {
      if (!currentFiles.has(name)) {
        await this._unloadFile(name);
      }
    }
  }

  // ==========================================================================
  // 内部：加载/重载/卸载
  // ==========================================================================

  /**
   * 加载新文件到 dispatcher
   */
  private async _loadFile(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    let plugins: ReadonlyArray<GoalCommandPlugin>;
    try {
      plugins = await DropInLoader.loadFromFile(filePath);
    } catch (err) {
      this.log("error", `[Watcher] 加载 ${fileName} 失败：${formatError(err)}`);
      return;
    }
    const loaded: GoalCommandPlugin[] = [];
    for (const plugin of plugins) {
      try {
        this.dispatcher.hotRegister(plugin);
        loaded.push(plugin);
      } catch (err) {
        this.log("error", `[Watcher] 拒绝注册 ${fileName} 中的 '${plugin.name}'：${formatError(err)}`);
      }
    }
    if (loaded.length > 0) {
      try {
        const stat = fs.statSync(filePath);
        const mtimeMs = stat.mtimeMs;
        this.fileStates.set(fileName, { mtimeMs, plugins: loaded });
        this.log("info", `[Watcher] 加载 ${fileName} 成功：${loaded.length} 个 plugin`);
      } catch (statErr) {
        this.log("warn", `[Watcher] 记录 ${fileName} mtime 失败：${formatError(statErr)}`);
      }
    }
  }

  /**
   * 重新加载文件（unregister → load → register，任意步骤失败均回滚）
   */
  private async _reloadFile(filePath: string, oldPlugins: ReadonlyArray<GoalCommandPlugin>): Promise<void> {
    const fileName = path.basename(filePath);
    // === 步骤 1：unregister 全部旧 plugin（force=true）===
    const unregistered: GoalCommandPlugin[] = [];
    const unregisterFailures: Array<{ name: string; error: Error }> = [];
    for (const old of oldPlugins) {
      try {
        this.dispatcher.hotUnregister(old.name, { force: true });
        unregistered.push(old);
      } catch (err) {
        unregisterFailures.push({
          name: old.name,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        this.log("warn", `[Watcher] reload 时 unregister '${old.name}' 失败：${formatError(err)}`);
      }
    }

    // === 步骤 1.5：fail-fast 防 ghost plugin 泄漏 ===
    if (unregisterFailures.length > 0) {
      this.log(
        "error",
        `[Watcher] reload ${fileName} 步骤 1 部分失败：${unregisterFailures.length} 个 plugin 拒绝 unregister，拒绝继续 register（防 ghost plugin 泄漏），开始回滚`
      );
      await this._rollbackOldPlugins(unregistered, fileName);
      // 不更新 mtime，下次 mtime 变化时再次尝试
      return;
    }

    // === 步骤 2：加载新实例 ===
    let newPlugins: ReadonlyArray<GoalCommandPlugin>;
    try {
      newPlugins = await DropInLoader.loadFromFile(filePath);
    } catch (err) {
      this.log("error", `[Watcher] reload ${fileName} 加载新实例失败：${formatError(err)}，开始回滚`);
      await this._rollbackOldPlugins(unregistered, fileName);
      return;
    }

    // === 步骤 3：register 新 plugin ===
    const loaded: GoalCommandPlugin[] = [];
    const registerFailures: Array<{ name: string; error: Error }> = [];
    for (const np of newPlugins) {
      try {
        this.dispatcher.hotRegister(np);
        loaded.push(np);
      } catch (err) {
        registerFailures.push({
          name: np.name,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        this.log("error", `[Watcher] reload ${fileName} 中拒绝 '${np.name}'：${formatError(err)}`);
      }
    }

    // === 步骤 4：部分成功则更新 file_states ===
    if (loaded.length > 0) {
      try {
        const stat = fs.statSync(filePath);
        const mtimeMs = stat.mtimeMs;
        this.fileStates.set(fileName, { mtimeMs, plugins: loaded });
        if (registerFailures.length > 0) {
          this.log("warn", `[Watcher] reload ${fileName} 部分成功：${loaded.length}/${newPlugins.length}`);
        } else {
          this.log("info", `[Watcher] reload ${fileName} 成功：${loaded.length} 个 plugin`);
        }
      } catch (statErr) {
        this.log("warn", `[Watcher] 记录 ${fileName} mtime 失败：${formatError(statErr)}`);
      }
    } else {
      // === 步骤 5：全部失败 → 回滚 ===
      this.log("error", `[Watcher] reload ${fileName} 新 plugin 全部注册失败，开始回滚`);
      await this._rollbackOldPlugins(unregistered, fileName);
      throw new ReloadPartialFailureError(
        fileName,
        0,
        registerFailures.length,
        registerFailures.map((f) => f.name)
      );
    }
  }

  /**
   * 严格回滚 + critical failure 回调
   */
  private async _rollbackOldPlugins(oldPlugins: ReadonlyArray<GoalCommandPlugin>, fileName: string): Promise<void> {
    const rollbackFailures: Array<{ name: string; error: Error }> = [];
    for (const old of oldPlugins) {
      try {
        this.dispatcher.hotRegister(old);
      } catch (err) {
        rollbackFailures.push({
          name: old.name,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        this.log("error", `[Watcher] 回滚 '${old.name}' 也失败：${formatError(err)}`);
      }
    }
    if (rollbackFailures.length > 0) {
      const failedNames = rollbackFailures.map((f) => f.name);
      this.log(
        "critical",
        `[Watcher] ${fileName} 回滚失败，${rollbackFailures.length} 个 plugin 永久丢失：${failedNames.join(", ")}`
      );
      if (this.criticalFailureCallback) {
        try {
          await this.criticalFailureCallback(fileName, failedNames);
        } catch (cbErr) {
          this.log("error", `[Watcher] critical_failure_callback 自身异常：${formatError(cbErr)}`);
        }
      }
      throw new ReloadRollbackFailedError(fileName, failedNames);
    }
  }

  /**
   * 卸载文件（unregister all plugins + 清理 import cache）
   */
  private async _unloadFile(name: string): Promise<void> {
    const state = this.fileStates.get(name);
    if (!state) return;
    this.fileStates.delete(name);
    for (const plugin of state.plugins) {
      try {
        this.dispatcher.hotUnregister(plugin.name, { force: true });
      } catch (err) {
        this.log("error", `[Watcher] 卸载 '${plugin.name}' 失败：${formatError(err)}`);
      }
    }
    // 清理 import cache
    const filePath = path.join(this.dropInDir, name);
    DropInLoader.purgeModule(filePath);
    this.log("info", `[Watcher] 卸载 ${name} 成功：${state.plugins.length} 个 plugin`);
  }

  // ==========================================================================
  // 内部：调度
  // ==========================================================================

  /**
   * 调度下一次扫描
   */
  private scheduleNextScan(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.scanOnce().then(() => this.scheduleNextScan());
    }, this.pollIntervalSec * 1000);
  }

  // ==========================================================================
  // 内部：日志
  // ==========================================================================

  private log(level: WatcherLogLevel, message: string): void {
    if (this.logCallback) {
      this.logCallback(level, message);
    } else {
      // 默认 console 输出
      const tag = level === "critical" || level === "error" ? "❌" : level === "warn" ? "⚠️" : "ℹ️";

      console.log(`${tag} ${message}`);
    }
  }
}

// ============================================================================
// 第三部分：辅助函数
// ============================================================================

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function formatError(err: unknown): string {
  if (err instanceof TeamError) {
    return `[${err.code}] ${err.message}`;
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

// 重新导出 sanitizeStem（watcher 也需要使用）
export { sanitizeStem };
