/**
 * 跨平台 Sleep 防护（V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/autonomous/sleep_guard.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 * Karpathy 原则：Simplicity First - 单职责，跨平台防休眠
 * Ponytail 红线：try/finally 严格 release，atexit 兜底
 *
 * 真实实现能力：
 *   1. macOS: caffeinate -i（阻止空闲休眠）
 *   2. Linux: systemd-inhibit（如果可用）
 *   3. Windows / 其他: no-op
 *   4. process exit 兜底（即使异常退出也 release）
 *   5. SIGTERM/SIGINT 优雅 release
 *   6. 后端启动失败时降级为 no-op（不阻塞主流程）
 */

import * as child_process from "node:child_process";
import * as os from "node:os";

/** Sleep 防护模式 */
export type SleepGuardMode = "on" | "off";

/** Sleep 防护后端类型 */
export type SleepGuardBackend = "caffeinate" | "systemd-inhibit" | "noop" | "uninitialized";

/** Sleep 防护句柄（内部使用） */
export interface SleepGuardHandle {
  mode: SleepGuardMode;
  process: child_process.ChildProcess | null;
  backend: SleepGuardBackend;
}

/** 日志回调签名 */
export type SleepGuardLogCallback = (message: string) => void;

/** 默认空日志 */
const NULL_LOG: SleepGuardLogCallback = () => {};

/** process exit 钩子是否已注册 */
let atexitRegistered = false;
/** 全局已注册的 SleepGuard 列表（atexit 时统一 release） */
const registeredGuards: Set<SleepGuard> = new Set();

/**
 * 注册 process exit 钩子（仅一次）
 */
function ensureAtexitRegistered(): void {
  if (atexitRegistered) return;
  atexitRegistered = true;
  const handler = (): void => {
    for (const guard of registeredGuards) {
      try {
        guard.release();
      } catch {
        // 静默吞掉异常（atexit 阶段不能再抛）
      }
    }
  };
  process.on("exit", handler);
  // process.on('beforeExit') 不能保证执行；用 'exit' 兜底
}

/**
 * 跨平台 Sleep 防护
 *
 * 设计原则：
 *   1. macOS 优先用 caffeinate -i（阻止空闲休眠）
 *   2. Linux 优先用 systemd-inhibit（如果可用）
 *   3. Windows 与未知平台 no-op
 *   4. process exit 兜底（即使异常退出也 release）
 *   5. SIGTERM/SIGINT 优雅 release
 */
export class SleepGuard {
  private readonly mode: SleepGuardMode;
  private readonly log: SleepGuardLogCallback;
  private handle: SleepGuardHandle | null = null;
  private signalHooksRegistered = false;

  constructor(mode: SleepGuardMode = "on", log?: SleepGuardLogCallback) {
    this.mode = mode;
    this.log = log ?? NULL_LOG;
  }

  // ========================================================================
  // 公共 API
  // ========================================================================

  /**
   * 启动防休眠子进程
   *
   * 行为：
   *   1. 检测平台
   *   2. 启动对应后端子进程
   *   3. 注册 process exit 钩子
   *   4. 注册 SIGTERM/SIGINT 钩子
   */
  acquire(): SleepGuardHandle {
    if (this.mode === "off") {
      this.log("[SleepGuard] 模式为 OFF，跳过防休眠");
      this.handle = { mode: "off", process: null, backend: "noop" };
      return this.handle;
    }
    const backend = this.detectBackend();
    if (backend === "noop") {
      this.log(`[SleepGuard] 平台 ${process.platform} 不支持防休眠，使用 no-op`);
      this.handle = { mode: "on", process: null, backend: "noop" };
      return this.handle;
    }
    // 启动子进程
    const cmd = buildCommand(backend);
    if (cmd.length === 0) {
      this.handle = { mode: "on", process: null, backend: "noop" };
      return this.handle;
    }
    let proc: child_process.ChildProcess;
    try {
      proc = child_process.spawn(cmd[0]!, cmd.slice(1), {
        stdio: ["ignore", "ignore", "ignore"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      this.log(`[SleepGuard] 启动 ${backend} 失败: ${formatError(err)}，降级为 no-op`);
      this.handle = { mode: "on", process: null, backend: "noop" };
      return this.handle;
    }
    // 监听进程异常退出
    proc.on("error", (err) => {
      this.log(`[SleepGuard] ${backend} 异常退出: ${err.message}`);
      this.handle = null;
    });
    this.handle = { mode: "on", process: proc, backend };
    this.log(`[SleepGuard] 已启动 ${backend}（pid=${proc.pid ?? "?"}）`);
    // 注册全局 process exit 钩子
    ensureAtexitRegistered();
    registeredGuards.add(this);
    // 注册信号钩子（仅首次）
    if (!this.signalHooksRegistered) {
      this.registerSignalHooks();
      this.signalHooksRegistered = true;
    }
    return this.handle;
  }

  /**
   * 释放防休眠子进程（优雅关闭）
   *
   * 行为：
   *   1. 如果 handle 是 None → no-op
   *   2. 如果 process 存在且 alive → terminate + wait
   *   3. 设置 handle = null（避免重复 release）
   */
  release(): void {
    if (this.handle === null) {
      return;
    }
    const proc = this.handle.process;
    const backend = this.handle.backend;
    if (proc !== null && proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill("SIGTERM");
        // 给子进程 5 秒优雅退出
        const exitPromise = new Promise<void>((resolve) => {
          proc.once("exit", () => resolve());
        });
        const timeoutPromise = new Promise<void>((resolve) => {
          setTimeout(resolve, 5_000);
        });
        Promise.race([exitPromise, timeoutPromise]).then(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            try {
              proc.kill("SIGKILL");
            } catch {
              // 静默
            }
          }
        });
        this.log(`[SleepGuard] 已停止 ${backend}（pid=${proc.pid ?? "?"}）`);
      } catch (err) {
        this.log(`[SleepGuard] 停止 ${backend} 失败: ${formatError(err)}`);
      }
    }
    this.handle = null;
    registeredGuards.delete(this);
  }

  /**
   * 是否正在防护
   */
  isActive(): boolean {
    if (this.handle === null) return false;
    if (this.handle.process === null) return false;
    return this.handle.process.exitCode === null && this.handle.process.signalCode === null;
  }

  /**
   * 实际后端名称
   */
  backendName(): SleepGuardBackend {
    if (this.handle === null) return "uninitialized";
    return this.handle.backend;
  }

  /**
   * 检测当前平台支持的后端（不实际启动）
   */
  static detectPlatformBackend(): SleepGuardBackend {
    const system = os.platform();
    if (system === "darwin") {
      return whichCommand("caffeinate") ? "caffeinate" : "noop";
    }
    if (system === "linux") {
      return whichCommand("systemd-inhibit") ? "systemd-inhibit" : "noop";
    }
    return "noop";
  }

  /**
   * 检测可用后端（实例方法，等价于静态方法）
   */
  private detectBackend(): SleepGuardBackend {
    return SleepGuard.detectPlatformBackend();
  }

  /**
   * 注册 SIGTERM/SIGINT 钩子
   */
  private registerSignalHooks(): void {
    const releaseHandler = (): void => {
      this.release();
    };
    process.on("SIGTERM", releaseHandler);
    process.on("SIGINT", releaseHandler);
    process.on("SIGHUP", releaseHandler);
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 构建后端启动命令
 */
function buildCommand(backend: SleepGuardBackend): string[] {
  if (backend === "caffeinate") {
    return ["caffeinate", "-i", "-w", String(process.pid)];
  }
  if (backend === "systemd-inhibit") {
    return [
      "systemd-inhibit",
      "--what=idle:sleep",
      "--who=deepcodex-ralph",
      "--why=Ralph autonomous run",
      "--mode=block",
      "sleep",
      "infinity",
    ];
  }
  return [];
}

/**
 * 检查命令是否在 PATH 中
 */
function whichCommand(cmd: string): boolean {
  try {
    const proc = child_process.spawnSync(cmd, ["--version"], { encoding: "utf-8" });
    return !proc.error && (proc.status === 0 || proc.status === null);
  } catch {
    return false;
  }
}

/**
 * 格式化错误对象为可读字符串
 */
function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
