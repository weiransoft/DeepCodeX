/**
 * 工作区进展快照（循环/死循环判定共用）。
 *
 * 仅 `git status --porcelain` 不足以判断状态是否推进：反复写同一个未跟踪文件时，
 * 路径与状态码始终为 `?? file`，但文件内容（计数器、日志、服务状态）在逐轮变化。
 * 本工具在状态行之外附加变更文件的内容摘要，让「输出/状态确实变化」成为可核验的
 * 进展证据；只读取项目内文件，超限截断，不回传文件内容本身。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_TRACKED_FILES = 64;
const MAX_BYTES_PER_SIDE = 32 * 1024;

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const separator = path.sep;
  return candidate.startsWith(`${root}${separator}`);
}

function statusPath(statusLine: string): string | null {
  let raw = statusLine.slice(3).trim();
  if (raw.length === 0) return null;
  // rename/copy: `R  old -> new`
  const arrow = raw.lastIndexOf(" -> ");
  if (arrow >= 0) raw = raw.slice(arrow + 4).trim();
  if (raw.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "string") return null;
      raw = parsed;
    } catch {
      return null;
    }
  }
  return raw.length > 0 ? raw : null;
}

function hashChangedFile(line: string, absolutePath: string, realRoot: string): string {
  const itemHash = createHash("sha256").update(line);
  try {
    const realPath = fs.realpathSync(absolutePath);
    if (!isInside(realRoot, realPath)) {
      return `${line}|out-of-root`;
    }
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) return `${line}|non-file`;
    // 首尾摘要覆盖日志追加、计数器改写；大文件不整读，避免循环判定拖慢主链路。
    const fd = fs.openSync(realPath, "r");
    try {
      const headLength = Math.min(MAX_BYTES_PER_SIDE, stat.size);
      const head = Buffer.alloc(headLength);
      fs.readSync(fd, head, 0, headLength, 0);
      itemHash.update(head);
      const tailLength = Math.min(MAX_BYTES_PER_SIDE, Math.max(0, stat.size - MAX_BYTES_PER_SIDE));
      if (tailLength > 0 && stat.size > MAX_BYTES_PER_SIDE) {
        const tail = Buffer.alloc(tailLength);
        fs.readSync(fd, tail, 0, tailLength, stat.size - tailLength);
        itemHash.update(tail);
      }
    } finally {
      fs.closeSync(fd);
    }
    return `${line}|${itemHash.digest("hex").slice(0, 16)}`;
  } catch {
    return `${line}|missing`;
  }
}

/**
 * 采集工作区状态 + 变更文件内容摘要。
 *
 * @returns 规范化快照字符串；非 git 仓库/超时/无 projectRoot 时返回 null（诚实降级）
 */
export function captureWorkspaceProgressSnapshot(
  projectRoot?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): string | null {
  if (!projectRoot || projectRoot.trim().length === 0) return null;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(path.resolve(projectRoot));
  } catch {
    return null;
  }
  let stdout: string;
  try {
    stdout = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: realRoot,
      timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const lines = stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .sort();
  const entries = lines.slice(0, MAX_TRACKED_FILES).map((line) => {
    const relativePath = statusPath(line);
    if (relativePath === null) return line;
    return hashChangedFile(line, path.resolve(realRoot, relativePath), realRoot);
  });
  // 干净仓库返回空字符串（与旧 `git status --porcelain` 行为一致，仍可比较）；
  // null 专用于「git 不可用 / 超时 / 无 projectRoot」这一诚实降级语义。
  return lines.length > MAX_TRACKED_FILES
    ? `${entries.join("\n")}\n+truncated:${lines.length - MAX_TRACKED_FILES}`
    : entries.join("\n");
}
