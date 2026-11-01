import { spawn, type SpawnOptions } from "child_process";
import { findGitBashPath } from "./shell-utils";

type NotifyChildProcess = {
  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): NotifyChildProcess;
  unref(): void;
};

export type NotifySpawn = (
  command: string,
  args: string[],
  options: Pick<SpawnOptions, "cwd" | "detached" | "env" | "stdio">
) => NotifyChildProcess;

/**
 * 按平台解析通知脚本的启动方式。
 *
 * 2026-11-01 跨平台补齐：Windows 的 CreateProcess 不认 shebang，
 * 直接 spawn 一个 .sh 通知脚本必然 ENOEXEC/EINVAL，而原实现的
 * /bin/sh 回退又被 `process.platform === "win32"` 提前 return 掉，
 * 结果是"配了通知脚本但 Windows 上静默不执行"。
 * 这里对 .sh/.bash 显式改走 Git Bash（Windows 上 bash 工具本就依赖它）。
 *
 * @param scriptPath 用户配置的通知脚本路径
 * @param platform 目标平台（默认 process.platform，测试可注入）
 * @param findBash Git Bash 定位函数（默认 findGitBashPath，测试可注入）
 * @returns 实际启动的 command 与 args
 */
export function resolveNotifySpawnPlan(
  scriptPath: string,
  platform: NodeJS.Platform = process.platform,
  findBash: () => string = findGitBashPath
): { command: string; args: string[] } {
  if (platform !== "win32") {
    return { command: scriptPath, args: [] };
  }
  if (!/\.(sh|bash)$/i.test(scriptPath)) {
    return { command: scriptPath, args: [] };
  }
  try {
    return { command: findBash(), args: [scriptPath] };
  } catch {
    // 未安装 Git Bash：退回直接 spawn，由 error 事件静默吞掉（与原行为一致）
    return { command: scriptPath, args: [] };
  }
}

export function formatDurationSeconds(durationMs: number): string {
  const safeMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  return String(Math.floor(safeMs / 1000));
}

export type NotifyContext = {
  status?: string;
  failReason?: string;
  body?: string;
  title?: string;
};

export function buildNotifyEnv(
  durationMs: number,
  baseEnv: NodeJS.ProcessEnv = process.env,
  context: NotifyContext = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    DURATION: formatDurationSeconds(durationMs),
  };
  delete env.STATUS;
  delete env.FAIL_REASON;
  delete env.BODY;
  delete env.TITLE;

  if (context.status) {
    env.STATUS = context.status;
  }
  if (context.failReason) {
    env.FAIL_REASON = context.failReason;
  }
  if (context.body) {
    env.BODY = context.body;
  }
  if (context.title) {
    env.TITLE = context.title;
  }
  return env;
}

export function launchNotifyScript(
  notifyPath: string | undefined,
  durationMs: number,
  workingDirectory?: string,
  spawnProcess: NotifySpawn = spawn as unknown as NotifySpawn,
  configuredEnv: Record<string, string> = {},
  context: NotifyContext = {}
): void {
  const commandPath = notifyPath?.trim();
  if (!commandPath) {
    return;
  }

  const options = {
    cwd: workingDirectory,
    detached: process.platform !== "win32",
    env: buildNotifyEnv(durationMs, { ...process.env, ...configuredEnv }, context),
    stdio: "ignore" as const,
  };

  try {
    const spawnPlan = resolveNotifySpawnPlan(commandPath);
    const child = spawnProcess(spawnPlan.command, spawnPlan.args, options);
    child.once("error", (error) => {
      if (process.platform === "win32") {
        return;
      }
      if (error.code !== "EACCES" && error.code !== "ENOEXEC") {
        return;
      }

      // Fall back to /bin/sh so plain shell scripts still run without execute permissions.
      try {
        const fallbackChild = spawnProcess("/bin/sh", [commandPath], options);
        fallbackChild.once("error", () => undefined);
        fallbackChild.unref();
      } catch {
        // Ignore notification failures.
      }
    });
    child.unref();
  } catch {
    // Ignore notification failures.
  }
}
