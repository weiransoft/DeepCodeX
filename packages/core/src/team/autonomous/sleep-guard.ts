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
 *   3. Windows: PowerShell 常驻进程调用 kernel32!SetThreadExecutionState
 *      （ES_CONTINUOUS | ES_SYSTEM_REQUIRED），线程存活期间系统不休眠
 *   4. 其他平台: no-op
 *   5. process exit 兜底（即使异常退出也 release）
 *   6. SIGTERM/SIGINT 优雅 release
 *   7. 后端启动失败时降级为 no-op（不阻塞主流程）
 */

import * as child_process from "node:child_process";
import * as os from "node:os";

/** Sleep 防护模式 */
export type SleepGuardMode = "on" | "off";

/** Sleep 防护后端类型 */
export type SleepGuardBackend = "caffeinate" | "systemd-inhibit" | "windows-execution-state" | "noop" | "uninitialized";

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
 * Windows PowerShell 可执行文件缓存
 *
 * undefined = 尚未探测；null = 探测失败（无可用 PowerShell）；string = 绝对可用的命令名。
 * 探测会真实 spawn 一次，故只做一次并缓存。
 */
let cachedWindowsPowerShell: string | null | undefined;

/** Windows 候选 PowerShell（Windows PowerShell 5.1 优先，powerShell 7 兜底） */
const WINDOWS_POWERSHELL_CANDIDATES: readonly string[] = ["powershell.exe", "pwsh.exe"];

/**
 * ES_CONTINUOUS | ES_SYSTEM_REQUIRED = 0x80000001
 *
 * ES_SYSTEM_REQUIRED 声明"需要系统保持可用"，ES_CONTINUOUS 让该要求持续生效直到线程
 * 重置执行状态或线程退出（无需反复轮询）。两个标志合起来等价于"我这个进程还活着就别睡"。
 */
const WINDOWS_EXECUTION_STATE_FLAGS = 2147483649;

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
 *   3. Windows 用 PowerShell 常驻进程持有 ES_CONTINUOUS|ES_SYSTEM_REQUIRED
 *   4. 其他未知平台 no-op
 *   5. process exit 兜底（即使异常退出也 release）
 *   6. SIGTERM/SIGINT 优雅 release
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
    let cmd: string[];
    try {
      cmd = buildCommand(backend);
    } catch (err) {
      this.log(`[SleepGuard] ${backend} 初始化失败: ${formatError(err)}，降级为 no-op`);
      this.handle = { mode: "on", process: null, backend: "noop" };
      return this.handle;
    }
    if (cmd.length === 0) {
      this.handle = { mode: "on", process: null, backend: "noop" };
      return this.handle;
    }
    let proc: child_process.ChildProcess;
    try {
      proc = child_process.spawn(cmd[0]!, cmd.slice(1), {
        stdio: ["ignore", "ignore", "ignore"],
        detached: process.platform !== "win32",
        // Windows 上避免弹出控制台窗口（桌面壳内启动时尤其明显）
        windowsHide: true,
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
    if (system === "win32") {
      // 仅确认 PowerShell 可启动；SetThreadExecutionState 是否真可用由 acquire() 的
      // 同步探针判定，探针失败时 acquire() 自行降级为 no-op
      return resolveWindowsPowerShell() ? "windows-execution-state" : "noop";
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
 *
 * @throws Windows 后端初始化失败（未找到 PowerShell 或 API 探针失败）时抛出，
 *         由 acquire() 捕获后降级为 no-op
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
  if (backend === "windows-execution-state") {
    return buildWindowsExecutionStateCommand();
  }
  return [];
}

// ============================================================================
// Windows 后端：SetThreadExecutionState 常驻守护
// ============================================================================

/**
 * 解析可用的 PowerShell 命令名（结果缓存）
 *
 * 不用 `where.exe`：在精简容器 / PATH 异常环境下 where 不一定在 PATH 上，
 * 直接 spawn 一次 `-Command "exit 0"` 最能反映"能不能用"。
 */
function resolveWindowsPowerShell(): string | null {
  if (cachedWindowsPowerShell !== undefined) {
    return cachedWindowsPowerShell;
  }
  cachedWindowsPowerShell = null;
  for (const candidate of WINDOWS_POWERSHELL_CANDIDATES) {
    try {
      const probe = child_process.spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
        stdio: "ignore",
        timeout: 15_000,
        windowsHide: true,
      });
      if (!probe.error && probe.status === 0) {
        cachedWindowsPowerShell = candidate;
        break;
      }
    } catch {
      // 候选不可用，继续下一个
    }
  }
  return cachedWindowsPowerShell;
}

/** 生成 import kernel32!SetThreadExecutionState 的 PowerShell 头部（探针与常驻脚本共用） */
function buildExecutionStatePreamble(): string[] {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$signature = @'",
    '[DllImport("kernel32.dll", SetLastError = true)]',
    "public static extern uint SetThreadExecutionState(uint esFlags);",
    "'@",
    "$guardType = Add-Type -MemberDefinition $signature -Name 'DcxSleepGuard' -Namespace 'DeepCodeX' -PassThru",
    "if ($null -eq $guardType) { exit 2 }",
  ];
}

/**
 * 同步探针脚本：确认 SetThreadExecutionState 在本机真实可用
 *
 * 为什么调用两次：该 API 成功时返回"上一次的执行状态"，失败时返回 0。新线程第一次调用
 * 的返回值在部分 Windows 版本上也是 0，无法区分成败；第二次调用必然返回刚设置的值，
 * 以此作为成功判据才可靠。
 */
function buildExecutionStateProbeScript(): string {
  return [
    ...buildExecutionStatePreamble(),
    `[void]$guardType::SetThreadExecutionState([uint32]${WINDOWS_EXECUTION_STATE_FLAGS})`,
    `$previous = $guardType::SetThreadExecutionState([uint32]${WINDOWS_EXECUTION_STATE_FLAGS})`,
    `if ($previous -ne ${WINDOWS_EXECUTION_STATE_FLAGS}) { exit 3 }`,
    // ES_CONTINUOUS 单独设置即清除 ES_SYSTEM_REQUIRED，探针进程退出前主动复位
    "[void]$guardType::SetThreadExecutionState([uint32]2147483648)",
    "exit 0",
  ].join("\n");
}

/**
 * 常驻脚本：先设置执行状态，再低频复设（防其他程序把状态清掉），直到进程被杀
 */
function buildExecutionStateKeepAliveScript(): string {
  return [
    ...buildExecutionStatePreamble(),
    "while ($true) {",
    `  [void]$guardType::SetThreadExecutionState([uint32]${WINDOWS_EXECUTION_STATE_FLAGS})`,
    "  Start-Sleep -Seconds 25",
    "}",
  ].join("\n");
}

/** 把 PowerShell 脚本编码为 -EncodedCommand 需要的 UTF-16LE Base64（彻底规避引号转义） */
function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * 构建 Windows 防休眠命令
 *
 * @throws PowerShell 不可用或 API 探针失败时抛出
 */
function buildWindowsExecutionStateCommand(): string[] {
  const exe = resolveWindowsPowerShell();
  if (!exe) {
    throw new Error("未找到 powershell.exe / pwsh.exe");
  }

  // 探针：真实调用 API，失败即抛（调用方降级 no-op），绝不假装已生效
  const probe = child_process.spawnSync(
    exe,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(buildExecutionStateProbeScript())],
    {
      stdio: "ignore",
      timeout: 30_000,
      windowsHide: true,
    }
  );
  if (probe.error) {
    throw new Error(`SetThreadExecutionState 探针无法执行: ${probe.error.message}`);
  }
  if (probe.status !== 0) {
    throw new Error(`SetThreadExecutionState 探针失败（退出码 ${probe.status ?? "null"}）`);
  }

  return [
    exe,
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-EncodedCommand",
    encodePowerShellCommand(buildExecutionStateKeepAliveScript()),
  ];
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
