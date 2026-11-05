/**
 * T-025: /new 命令 — 开始新对话
 *
 * 语义（对齐 docs/quickstart.md「/new 开始新对话」）：
 *  1. 结束当前会话上下文（返回一个全新的空白上下文标识）
 *  2. 按需归档旧会话，并回调 store 以持久化「新会话」状态
 * 不抛错：即使没有进行中的会话，也应返回成功（幂等）。
 *
 * T-051 扩展（2026-11-02）：新增「文件模式」入口 runNew({ cwd })，作用于
 * `.eag/context.json`——把当前上下文整体归档为 `.eag/context-archive-<ts>.json`，
 * 然后把 context.json 的 history 重置为空数组（新上下文起点）。
 * 归档命名含 "archive" 子串，供下游按文件名识别备份。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface NewSessionResult {
  ok: true;
  sessionId: string;
  message: string;
}

export interface NewCommandStore {
  /** 归档当前会话（可选）；返回被归档的会话 id */
  archiveCurrent?(): Promise<string | null> | string | null;
  /** 创建新会话（可选）；返回新会话 id */
  createSession?(): Promise<string> | string;
}

export interface NewCommandOptions {
  store?: NewCommandStore;
  /** 会话 id 生成器，便于测试注入固定值 */
  createId?: () => string;
}

function defaultCreateId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 文件模式选项（T-051）：cwd 下 `.eag/context.json` 即切换目标 */
export interface NewFileOptions {
  cwd: string;
}

/** 文件模式结果：ok=false 时 error 说明原因；archivedPath 为归档文件路径（有旧上下文时） */
export interface NewFileResult {
  ok: boolean;
  sessionId: string;
  message: string;
  archivedPath?: string;
  error?: string;
}

const CONTEXT_FILE_REL = path.join(".eag", "context.json");

/**
 * /new 的文件模式实现（T-051）：
 * 1. 读取 `{cwd}/.eag/context.json`（不存在视为空上下文，仍成功——幂等语义）
 * 2. 若 history 非空 → 整体复制为 `.eag/context-archive-<时间戳>.json`（归档）
 * 3. 回写 context.json：保留其他顶层字段，history 置空数组，记录 newAt
 *
 * @param opts cwd 项目根
 * @returns 新会话标识与归档路径；读取/写盘失败时 ok=false 且尽量不留半成品
 */
export async function newContextFile(opts: NewFileOptions): Promise<NewFileResult> {
  const sessionId = defaultCreateId();
  const ctxDir = path.join(opts.cwd, ".eag");
  const ctxPath = path.join(opts.cwd, CONTEXT_FILE_REL);

  let raw: string | null = null;
  if (fs.existsSync(ctxPath)) {
    try {
      raw = fs.readFileSync(ctxPath, "utf8");
    } catch (e) {
      return { ok: false, sessionId, message: "", error: `context 文件不可读：${String(e)}` };
    }
  }

  let obj: Record<string, unknown> = {};
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, sessionId, message: "", error: `context 文件 JSON 解析失败：${String(e)}` };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, sessionId, message: "", error: "context 文件顶层必须是对象" };
    }
    obj = parsed as Record<string, unknown>;
  }

  const history = Array.isArray(obj.history) ? (obj.history as unknown[]) : [];
  let archivedPath: string | undefined;
  try {
    if (history.length > 0) {
      fs.mkdirSync(ctxDir, { recursive: true });
      archivedPath = path.join(ctxDir, `context-archive-${Date.now()}.json`);
      fs.writeFileSync(archivedPath, JSON.stringify(obj), "utf8");
    }
    fs.mkdirSync(ctxDir, { recursive: true });
    const next: Record<string, unknown> = { ...obj, history: [], newAt: new Date().toISOString() };
    fs.writeFileSync(ctxPath, JSON.stringify(next), "utf8");
  } catch (e) {
    return { ok: false, sessionId, message: "", archivedPath, error: `context 切换写盘失败：${String(e)}` };
  }

  const message = archivedPath
    ? `已开始新对话 ${sessionId}（上一上下文已归档至 ${path.basename(archivedPath)}）`
    : `已开始新对话 ${sessionId}`;
  return { ok: true, sessionId, message, archivedPath };
}

/**
 * /new 的命令入口（重载，T-051）：
 * - 入参含 cwd：文件模式——归档 `.eag/context.json` 并重置 history。
 * - 其余（含无参）：内存模式——归档旧会话 → 创建新会话 → 返回提示（行为不变）。
 */
export function runNew(opts?: NewCommandOptions): Promise<NewSessionResult>;
export function runNew(input: NewFileOptions): Promise<NewFileResult>;
export async function runNew(input?: NewCommandOptions | NewFileOptions): Promise<NewSessionResult | NewFileResult> {
  if (input && typeof (input as NewFileOptions).cwd === "string") {
    return newContextFile(input as NewFileOptions);
  }
  const opts = input as NewCommandOptions | undefined;
  const store = opts?.store;
  const createId = opts?.createId ?? defaultCreateId;

  const archived = store?.archiveCurrent ? await store.archiveCurrent() : null;
  const sessionId = store?.createSession ? await store.createSession() : createId();

  const message = archived ? `已开始新对话 ${sessionId}（上一会话 ${archived} 已归档）` : `已开始新对话 ${sessionId}`;

  return { ok: true, sessionId, message };
}
