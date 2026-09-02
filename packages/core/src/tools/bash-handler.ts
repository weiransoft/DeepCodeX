import { spawn } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_BASH_TIMEOUT_MS, clampBashTimeoutMs } from "../common/bash-timeout";
// P0 安全修复依赖：isPathInProject 用于 CWD 越界校验（上游无此安全机制，保留 fork 侧导入）
import { isPathInProject } from "../common/permissions";
import { killProcessTree } from "../common/process-tree";
import type { ProcessTimeoutControl, ProcessTimeoutInfo, ToolExecutionContext, ToolExecutionResult } from "./executor";
import {
  buildDisableExtglobCommand,
  buildShellEnv,
  buildShellInitCommand,
  resolveShellPath,
  rewriteWindowsNullRedirect,
  toNativeCwd,
} from "../common/shell-utils";

const MAX_OUTPUT_CHARS = 30000;
const MAX_CAPTURE_CHARS = 10 * 1024 * 1024;
const BACKGROUND_OUTPUT_DIR = path.join(os.tmpdir(), "deepcode-background");
const TRAILING_BACKGROUND_OPERATOR_PATTERN = /(^|[^\\&])\s*&\s*$/;
const sessionWorkingDirs = new Map<string, string>();

export function clearSessionWorkingDir(sessionId: string): void {
  if (!sessionId) {
    return;
  }
  sessionWorkingDirs.delete(sessionId);
}

type ToolCommandResult = {
  ok: boolean;
  output: string;
  cwd: string | null;
  exitCode: number | null;
  signal: string | null;
  truncated: boolean;
  shellPath?: string;
  startCwd?: string;
  timedOut?: boolean;
  timeoutMs?: number;
  deadlineAt?: string;
};

/**
 * 基础危险命令黑名单（ToolExecutor 未注入守卫时的 fail-closed 兜底）。
 *
 * 与 EAG-P5 DangerousCommandGuard 的关系：
 * - EAG 场景使用完整 6 层 BlockerGuardChain；
 * - 此列表仅作为 bash-handler 的最后一道防线，防止调用方绕过 ToolExecutor 的
 *   onBeforeToolExecution 钩子直接执行 rm -rf / 等明显灾难性命令。
 */
const BUILTIN_DANGEROUS_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = Object.freeze([
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|--recursive)\s+(-[a-zA-Z]*\s+)*\/(\s|$)/, reason: "禁止 rm -rf /" },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|--recursive)\s+(-[a-zA-Z]*\s+)*\/\*/, reason: "禁止 rm -rf /*" },
  { pattern: /\bmkfs\b/, reason: "禁止格式化磁盘" },
  { pattern: /\b(dd|fdisk|parted)\b/, reason: "禁止磁盘分区/覆写" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "禁止系统关机/重启" },
  { pattern: /[>|>]\s*\/dev\/sda/, reason: "禁止覆写块设备" },
  { pattern: /\biptables\s+-F\b/, reason: "禁止清空防火墙" },
]);

/**
 * 检查命令是否命中内置危险模式。
 *
 * @param command 待检查命令
 * @returns 命中时返回拦截原因，否则返回 null
 */
function checkBuiltinDangerousCommand(command: string): string | null {
  for (const { pattern, reason } of BUILTIN_DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return reason;
    }
  }
  return null;
}

export async function handleBashTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const rawCommand = typeof args.command === "string" ? args.command : "";
  const runInBackground = isTrue(args.run_in_background);
  const command = runInBackground ? stripTrailingBackgroundOperator(rawCommand) : rawCommand;
  if (!command.trim()) {
    return {
      ok: false,
      name: "bash",
      error: 'Missing required "command" string.',
    };
  }

  // P0 安全修复（fork）：bash-handler 自身做危险命令 fail-closed 拦截，避免调用方绕过 ToolExecutor 守卫。
  const dangerReason = checkBuiltinDangerousCommand(command);
  if (dangerReason) {
    return {
      ok: false,
      name: "bash",
      error: `Command blocked by built-in guard: ${dangerReason}`,
    };
  }

  const startCwd = getSessionCwd(context.sessionId, context.projectRoot);
  const { shellPath, shellArgs, marker } = buildShellCommand(command);

  if (runInBackground) {
    return startBackgroundShellCommand(shellPath, shellArgs, startCwd, command, marker, context);
  }

  const execution = await executeShellCommand(shellPath, shellArgs, startCwd, command, context);
  const result = buildToolCommandResult(
    execution.stdout,
    execution.stderr,
    marker,
    execution.exitCode,
    execution.signal,
    shellPath,
    startCwd,
    execution.timedOut,
    execution.timeoutMs,
    execution.deadlineAtMs
  );
  // P0 安全修复（fork）：CWD 必须位于 projectRoot 子树内，防止命令输出伪造 marker 行将 session CWD 切换到项目外。
  const safeCwd = validateCwdWithinProjectRoot(result.cwd, context.projectRoot, startCwd);
  updateSessionCwd(context.sessionId, startCwd, safeCwd);

  if (execution.error || result.exitCode !== 0 || result.signal !== null) {
    const errorMessage = buildErrorMessage(result.exitCode, result.signal, execution.error, execution.timedOut);
    return formatResult({ ...result, ok: false, cwd: safeCwd }, "bash", errorMessage);
  }

  return formatResult({ ...result, cwd: safeCwd }, "bash");
}

function isTrue(value: unknown): boolean {
  return value === true || value === "true";
}

function stripTrailingBackgroundOperator(command: string): string {
  return command.replace(TRAILING_BACKGROUND_OPERATOR_PATTERN, "$1").trimEnd();
}

function getSessionCwd(sessionId: string, fallback: string): string {
  return sessionWorkingDirs.get(sessionId) ?? fallback;
}

function updateSessionCwd(sessionId: string, fallback: string, cwd: string | null): void {
  const nextCwd = cwd ?? fallback;
  sessionWorkingDirs.set(sessionId, nextCwd);
}

function buildShellCommand(command: string): {
  shellPath: string;
  shellArgs: string[];
  marker: string;
} {
  const shellPath = resolveShellPath();
  const marker = buildMarker();
  const initCommand = buildShellInitCommand(shellPath);
  const disableExtglobCommand = buildDisableExtglobCommand(shellPath);
  const normalizedCommand = rewriteWindowsNullRedirect(command);
  const wrappedParts = [];
  if (initCommand) {
    wrappedParts.push(initCommand);
  }
  if (disableExtglobCommand) {
    wrappedParts.push(disableExtglobCommand);
  }
  wrappedParts.push(
    normalizedCommand,
    "__DEEPCODE_STATUS__=$?",
    `printf '%s%s\\n' "${marker}" "$PWD"`,
    "exit $__DEEPCODE_STATUS__"
  );
  const wrappedCommand = `{ ${wrappedParts.join("; ")}; } < /dev/null`;
  return { shellPath, shellArgs: ["-c", wrappedCommand], marker };
}

async function executeShellCommand(
  shellPath: string,
  shellArgs: string[],
  cwd: string,
  command: string,
  context: ToolExecutionContext
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  error?: string;
  timedOut: boolean;
  timeoutMs: number;
  deadlineAtMs: number;
}> {
  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const configuredEnv = context.createOpenAIClient?.().env ?? {};
    const minTimeoutMs = context.bashMinTimeoutMs;
    const initialTimeoutMs = clampBashTimeoutMs(context.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS, minTimeoutMs);
    const startedAtMs = Date.now();
    let timeoutMs = initialTimeoutMs;
    let deadlineAtMs = startedAtMs + timeoutMs;
    let timedOut = false;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const child = spawn(shellPath, shellArgs, {
      cwd,
      env: buildShellEnv(shellPath, configuredEnv),
      detached,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;

    const getTimeoutInfo = (): ProcessTimeoutInfo => ({
      timeoutMs,
      startedAtMs,
      deadlineAtMs,
      timedOut,
    });
    const stopTimeoutTimer = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };
    const triggerTimeout = () => {
      if (settled || timedOut || typeof pid !== "number") {
        return;
      }
      timedOut = true;
      stopTimeoutTimer();
      killProcessTree(pid, "SIGKILL");
    };
    const scheduleTimeout = () => {
      stopTimeoutTimer();
      if (settled) {
        return;
      }
      const remainingMs = Math.max(0, deadlineAtMs - Date.now());
      timeoutTimer = setTimeout(triggerTimeout, remainingMs);
    };
    const timeoutControl: ProcessTimeoutControl = {
      getInfo: getTimeoutInfo,
      setTimeoutMs: (nextTimeoutMs) => {
        timeoutMs = clampBashTimeoutMs(nextTimeoutMs, minTimeoutMs);
        deadlineAtMs = startedAtMs + timeoutMs;
        if (deadlineAtMs <= Date.now()) {
          triggerTimeout();
        } else {
          scheduleTimeout();
        }
        return getTimeoutInfo();
      },
    };

    if (typeof pid === "number") {
      context.onProcessStart?.(pid, command);
      context.onProcessTimeoutControl?.(pid, timeoutControl);
      scheduleTimeout();
    }

    let stdout = "";
    let stderr = "";
    let error: string | undefined;

    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdout = appendChunk(stdout, chunk);
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      context.onProcessStdout?.(pid as number, text);
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderr = appendChunk(stderr, chunk);
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      context.onProcessStdout?.(pid as number, text);
    });

    child.on("error", (spawnError) => {
      error = spawnError.message;
    });

    child.on("close", (code, signal) => {
      settled = true;
      stopTimeoutTimer();
      if (typeof pid === "number") {
        context.onProcessTimeoutControl?.(pid, null);
        context.onProcessExit?.(pid);
      }
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === "number" ? code : null,
        signal: signal ?? null,
        error,
        timedOut,
        timeoutMs,
        deadlineAtMs,
      });
    });
  });
}

function startBackgroundShellCommand(
  shellPath: string,
  shellArgs: string[],
  cwd: string,
  command: string,
  marker: string,
  context: ToolExecutionContext
): ToolExecutionResult {
  fs.mkdirSync(BACKGROUND_OUTPUT_DIR, { recursive: true });
  const taskId = `bash-${randomUUID()}`;
  const outputPath = path.join(BACKGROUND_OUTPUT_DIR, `${taskId}.log`);
  const startedAtMs = Date.now();
  const detached = process.platform !== "win32";
  const configuredEnv = context.createOpenAIClient?.().env ?? {};
  const child = spawn(shellPath, shellArgs, {
    cwd,
    env: buildShellEnv(shellPath, configuredEnv),
    detached,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  const processId = typeof pid === "number" ? pid : -1;
  const stopCommand = typeof pid === "number" ? buildStopBackgroundProcessCommand(pid) : null;

  let stdout = "";
  let stderr = "";
  let error: string | undefined;

  const appendOutputFile = (chunk: string | Buffer) => {
    try {
      fs.appendFileSync(outputPath, chunk);
    } catch {
      // Keep the background process running even if temp-file writes fail.
    }
  };

  if (typeof pid === "number") {
    context.onProcessStart?.(pid, command);
  }

  child.stdout?.on("data", (chunk: string | Buffer) => {
    stdout = appendChunk(stdout, chunk);
    appendOutputFile(chunk);
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (typeof pid === "number") {
      context.onProcessStdout?.(pid, text);
    }
  });
  child.stderr?.on("data", (chunk: string | Buffer) => {
    stderr = appendChunk(stderr, chunk);
    appendOutputFile(chunk);
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (typeof pid === "number") {
      context.onProcessStdout?.(pid, text);
    }
  });

  child.on("error", (spawnError) => {
    error = spawnError.message;
  });

  child.on("close", (code, signal) => {
    const markerResult = stripMarker(stdout, marker);
    const finalOutput = joinOutput(markerResult.output, stderr);
    const result = buildToolCommandResult(
      stdout,
      stderr,
      marker,
      typeof code === "number" ? code : null,
      signal ?? null,
      shellPath,
      cwd
    );
    // P0 安全修复（fork）：后台任务同样需要做 CWD 边界校验。
    const safeCwd = validateCwdWithinProjectRoot(result.cwd, context.projectRoot, cwd);
    updateSessionCwd(context.sessionId, cwd, safeCwd);
    writeFinalBackgroundOutput(outputPath, finalOutput);
    if (typeof pid === "number") {
      context.onProcessExit?.(pid);
    }
    const ok = !error && result.exitCode === 0 && result.signal === null;
    context.onBackgroundProcessComplete?.({
      taskId,
      processId,
      command,
      outputPath,
      ok,
      exitCode: result.exitCode,
      signal: result.signal,
      error: ok ? undefined : buildErrorMessage(result.exitCode, result.signal, error),
      cwd: result.cwd,
      shellPath,
      startedAtMs,
      completedAtMs: Date.now(),
    });
  });

  return {
    ok: true,
    name: "bash",
    output: buildBackgroundStartMessage(taskId, outputPath, stopCommand),
    metadata: {
      backgroundTaskId: taskId,
      processId: typeof pid === "number" ? pid : null,
      outputPath,
      stopCommand,
      cwd,
      shellPath,
      startCwd: cwd,
      runInBackground: true,
    },
  };
}

function buildBackgroundStartMessage(taskId: string, outputPath: string, stopCommand: string | null): string {
  const parts = [`Command running in background with ID: ${taskId}.`];
  if (stopCommand) {
    parts.push(`Stop it with: ${stopCommand}`);
  }
  parts.push(`Output is being written to: ${outputPath}`);
  return parts.join(" ");
}

function buildStopBackgroundProcessCommand(processId: number): string {
  if (process.platform === "win32") {
    return `cmd.exe /c "taskkill /PID ${processId} /T /F"`;
  }
  return `kill -- -${processId}`;
}

function writeFinalBackgroundOutput(outputPath: string, output: string | undefined): void {
  try {
    fs.writeFileSync(outputPath, output ?? "", "utf8");
  } catch {
    // Ignore notification/output persistence failures; the tool result already returned.
  }
}

function appendChunk(existing: string, chunk: string | Buffer): string {
  if (existing.length >= MAX_CAPTURE_CHARS) {
    return existing;
  }
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const remaining = MAX_CAPTURE_CHARS - existing.length;
  return `${existing}${text.slice(0, remaining)}`;
}

/**
 * 生成不可预测的 CWD marker，用于从子 shell 输出中解析当前工作目录。
 *
 * P0 安全修复（fork）：使用 CSPRNG（randomUUID）替代 Math.random，防止攻击者猜测或伪造 marker 行。
 */
function buildMarker(): string {
  const token = randomUUID();
  return `__DEEPCODE_PWD__${token}__`;
}

/**
 * 校验 shell 解析出的 cwd 是否仍位于项目根目录子树内。
 *
 * 如果命令输出被污染并包含伪造的 marker 行，可能导致 session CWD 被篡改为 /etc 等目录。
 * 此函数作为 fail-safe：越界时返回 fallbackCwd，不更新 session CWD。
 *
 * @param cwd shell 解析出的候选 cwd
 * @param projectRoot 项目根目录
 * @param fallbackCwd 校验失败时的回退 cwd
 * @returns 安全 cwd
 */
function validateCwdWithinProjectRoot(cwd: string | null, projectRoot: string, fallbackCwd: string): string | null {
  if (!cwd) {
    return cwd;
  }
  if (isPathInProject(projectRoot, cwd)) {
    return cwd;
  }
  // CWD 越界：保留回退值，避免 session 逃逸到项目外。
  return fallbackCwd;
}

function buildToolCommandResult(
  stdout: string,
  stderr: string,
  marker: string,
  exitCode: number | null,
  signal: string | null,
  shellPath: string,
  startCwd: string,
  timedOut: boolean = false,
  timeoutMs?: number,
  deadlineAtMs?: number
): ToolCommandResult {
  const { output: cleanedStdout, cwd } = stripMarker(stdout, marker);
  const combined = joinOutput(cleanedStdout, stderr);
  const { text, truncated } = truncateOutput(combined);
  return {
    ok: exitCode === 0 && signal === null,
    output: text,
    cwd,
    exitCode,
    signal,
    truncated,
    shellPath,
    startCwd,
    timedOut,
    timeoutMs,
    deadlineAt: typeof deadlineAtMs === "number" ? new Date(deadlineAtMs).toISOString() : undefined,
  };
}

function stripMarker(stdout: string, marker: string): { output: string; cwd: string | null } {
  if (!stdout) {
    return { output: "", cwd: null };
  }

  const lines = stdout.split(/\r?\n/);
  let markerIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith(marker)) {
      markerIndex = i;
      break;
    }
  }

  if (markerIndex === -1) {
    return { output: stdout, cwd: null };
  }

  const markerLine = lines[markerIndex];
  const shellCwd = markerLine.slice(marker.length).trim();
  const cwd = shellCwd ? toNativeCwd(shellCwd) : null;
  lines.splice(markerIndex, 1);
  return { output: lines.join("\n"), cwd };
}

function joinOutput(stdout: string, stderr: string): string {
  const trimmedStdout = stdout ?? "";
  const trimmedStderr = stderr ?? "";
  if (trimmedStdout && trimmedStderr) {
    return `${trimmedStdout}\n${trimmedStderr}`;
  }
  return trimmedStdout || trimmedStderr;
}

function truncateOutput(output: string): { text: string; truncated: boolean } {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return { text: output, truncated: false };
  }
  return { text: output.slice(0, MAX_OUTPUT_CHARS), truncated: true };
}

function buildErrorMessage(exitCode: number | null, signal: string | null, error?: string, timedOut = false): string {
  if (error) {
    return error;
  }
  if (timedOut) {
    return "Command timed out.";
  }
  if (signal) {
    return `Command terminated by signal ${signal}.`;
  }
  if (exitCode !== null) {
    return `Command failed with exit code ${exitCode}.`;
  }
  return "Command failed.";
}

function formatResult(result: ToolCommandResult, name: string, errorMessage?: string): ToolExecutionResult {
  const metadata: Record<string, unknown> = {
    exitCode: result.exitCode,
    signal: result.signal,
    cwd: result.cwd,
    truncated: result.truncated,
    shellPath: result.shellPath,
    startCwd: result.startCwd,
  };
  if (typeof result.timedOut === "boolean") {
    metadata.timedOut = result.timedOut;
  }
  if (typeof result.timeoutMs === "number") {
    metadata.timeoutMs = result.timeoutMs;
  }
  if (result.deadlineAt) {
    metadata.deadlineAt = result.deadlineAt;
  }

  const outputValue = result.output ? result.output : undefined;

  return {
    ok: result.ok,
    name,
    output: outputValue,
    error: errorMessage,
    metadata,
  };
}
