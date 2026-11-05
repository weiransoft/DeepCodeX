/**
 * T-025: /compact 命令 — 长会话手动压缩
 *
 * 与自动压缩（context-compressor 的阈值触发）互补：用户可在任意时刻主动触发，
 * 保持最近 keepRecent 条消息不动，将其余历史标记为 compacted（软删除，原始
 * 消息仍保留在 JSONL 中用于审计，对齐 docs/session-persistence.md 的压缩语义）。
 *
 * T-051 扩展（2026-11-02）：新增「文件模式」入口 runCompact({ cwd })，作用于
 * `.eag/context.json` 的 history 数组——规划器/自主任务以文件形态持有上下文时，
 * 命令自身完成 读取 → 压缩 → 落盘 闭环，并在文件上打 compressed 标记
 * （下游据此判断该上下文已被手动压缩）。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface CompactResult {
  compactedCount: number;
  summary: string;
}

export interface CompactOptions {
  /** 保持不压缩的最近消息条数（默认 6） */
  keepRecent?: number;
}

/** 会话消息的最小结构（避免与 packages/core 的具体类型耦合，便于测试注入） */
export interface CompactableMessage {
  role: string;
  content?: string;
  compacted?: boolean;
}

/**
 * 文件模式选项（T-051）：cwd 下 `.eag/context.json` 即压缩目标。
 * instructions 为压缩侧重点提示（如 "keep API changes"），透传进摘要文本，
 * 供下游/人工审计；本命令不做 LLM 摘要，保持确定性与离线可用。
 */
export interface CompactFileOptions {
  cwd: string;
  instructions?: string;
  keepRecent?: number;
}

/** 文件模式结果：ok=false 时 error 说明原因（缺文件/坏 JSON/结构不符/写回失败） */
export interface CompactFileResult {
  ok: boolean;
  compactedCount: number;
  summary: string;
  error?: string;
}

/** 文件模式的上下文文件相对路径 */
const CONTEXT_FILE_REL = path.join(".eag", "context.json");

/** 被压缩消息的内容替换前缀（幂等判定也依赖该前缀） */
const COMPACTED_PREFIX = "[context compacted]";

/**
 * 计算需要压缩的消息索引：仅压缩未压缩过、且不属于最近 keepRecent 条的消息。
 */
export function selectCompactableIndices(messages: CompactableMessage[], keepRecent = 6): number[] {
  const keep = Math.max(1, Math.floor(keepRecent));
  const boundary = messages.length - keep;
  const indices: number[] = [];
  for (let i = 0; i < boundary; i++) {
    if (!messages[i]?.compacted) indices.push(i);
  }
  return indices;
}

/** 为被压缩的消息生成一行摘要说明（不依赖 LLM，保证离线可用与确定性） */
export function buildCompactSummary(messages: CompactableMessage[], indices: number[]): string {
  if (indices.length === 0) return "";
  let userTurns = 0;
  let assistantTurns = 0;
  for (const i of indices) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "user") userTurns++;
    else if (m.role === "assistant") assistantTurns++;
  }
  const first = messages[indices[0]];
  const preview = (first?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  const head =
    `[context compacted] 已压缩 ${indices.length} 条历史消息` +
    `（用户 ${userTurns} / 助手 ${assistantTurns}），从"${preview}"开始。`;
  return head;
}

/**
 * 纯函数版压缩：返回新数组（被选中消息标记 compacted: true）与结果元数据。
 * 不修改入参，便于调用方在其之上做持久化。
 */
export function compactMessages<T extends CompactableMessage>(
  messages: T[],
  opts?: CompactOptions
): { messages: T[]; result: CompactResult } {
  const indices = selectCompactableIndices(messages, opts?.keepRecent ?? 6);
  const summary = buildCompactSummary(messages, indices);
  const marked = new Set(indices);
  const next = messages.map((m, i) => (marked.has(i) ? { ...m, compacted: true } : m));
  return { messages: next, result: { compactedCount: indices.length, summary } };
}

/** 依赖注入的持久化钩子，未提供时仅返回计算结果（便于无状态 CLI 测试） */
export interface CompactStore {
  markCompacted?(indices: number[]): Promise<void> | void;
  appendSummary?(summary: string): Promise<void> | void;
}

/**
 * /compact 的文件模式实现（T-051）：读取 {cwd}/.eag/context.json，
 * 压缩 history 中较旧消息（内容替换为带预览的压缩标记，置 compacted 位），
 * 保留最近的消息原文，并写回 compressed/compactedAt/compressionSummary。
 *
 * 保留条数口径：keep = clamp(min(keepRecent ?? 6, floor(len / 2)), 1, ∞)——
 * 手动压缩的语义是"确有收缩"：若历史本身不长（len ≤ keepRecent），纯按
 * keepRecent 会 0 条命中、文件原样回写（用户明确要求压缩却无任何效果）。
 * 因此至多保留一半（向下取整，且至少最近 1 条），保证 len ≥ 2 时必有压缩收益。
 * 已带压缩标记前缀或 compacted 位的消息不重复处理（幂等）。
 *
 * @param opts cwd 项目根；instructions 写入摘要；keepRecent 保留条数上限
 * @returns ok=false 时不产生任何文件副作用；ok=true 含 compactedCount 与摘要
 */
export async function compactContextFile(opts: CompactFileOptions): Promise<CompactFileResult> {
  const ctxPath = path.join(opts.cwd, CONTEXT_FILE_REL);
  let raw: string;
  try {
    raw = fs.readFileSync(ctxPath, "utf8");
  } catch {
    return { ok: false, compactedCount: 0, summary: "", error: `context 文件不存在或不可读：${ctxPath}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, compactedCount: 0, summary: "", error: `context 文件 JSON 解析失败：${String(e)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, compactedCount: 0, summary: "", error: "context 文件顶层必须是对象" };
  }
  const obj = parsed as Record<string, unknown>;
  const history: unknown = obj.history;
  if (!Array.isArray(history)) {
    return { ok: false, compactedCount: 0, summary: "", error: "context.history 缺失或不是数组" };
  }
  const messages = history as CompactableMessage[];
  // keep 口径见函数头注释：min(请求值, 一半) 且下限 1
  const requestedKeep = Math.max(1, Math.floor(opts.keepRecent ?? 6));
  const keep = Math.max(1, Math.min(requestedKeep, Math.floor(messages.length / 2)));
  const boundary = messages.length - keep;
  const indices: number[] = [];
  for (let i = 0; i < boundary; i += 1) {
    const m = messages[i];
    if (!m || m.compacted) continue;
    if (typeof m.content === "string" && m.content.startsWith(COMPACTED_PREFIX)) continue;
    indices.push(i);
  }
  if (indices.length === 0) {
    // 无命中（历史过短或全部已压缩）：成功但零副作用，不写 compressed 标记
    return { ok: true, compactedCount: 0, summary: "无需压缩：可压缩的历史消息不足。" };
  }
  const summary =
    buildCompactSummary(messages, indices) + (opts.instructions ? `（压缩要求：${opts.instructions}）` : "");
  const marked = new Set(indices);
  const next = messages.map((m, i) => {
    if (!marked.has(i)) return m;
    const preview = (m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    return { ...m, content: `${COMPACTED_PREFIX} ${preview}`, compacted: true };
  });
  const output: Record<string, unknown> = {
    ...obj,
    history: next,
    compressed: true,
    compactedAt: new Date().toISOString(),
    compressionSummary: summary,
  };
  try {
    fs.writeFileSync(ctxPath, JSON.stringify(output), "utf8");
  } catch (e) {
    return { ok: false, compactedCount: 0, summary: "", error: `context 文件写回失败：${String(e)}` };
  }
  return { ok: true, compactedCount: indices.length, summary };
}

/**
 * /compact 的命令入口（重载，T-051）：
 * - 入参为消息数组：内存模式——压缩历史、按需持久化标记、返回提示文本；
 *   无可压缩内容时返回提示且不产生任何副作用（行为与历史版本完全一致）。
 * - 入参为 { cwd }：文件模式——作用于 `.eag/context.json`，读取 → 压缩 → 落盘。
 */
export function runCompact(
  messages: CompactableMessage[],
  opts?: CompactOptions & { store?: CompactStore }
): Promise<CompactResult>;
export function runCompact(input: CompactFileOptions): Promise<CompactFileResult>;
export async function runCompact(
  input: CompactableMessage[] | CompactFileOptions,
  opts?: CompactOptions & { store?: CompactStore }
): Promise<CompactResult | CompactFileResult> {
  if (!Array.isArray(input)) {
    return compactContextFile(input);
  }
  const messages = input;
  const { messages: next, result } = compactMessages(messages, opts);
  if (result.compactedCount === 0) {
    return { compactedCount: 0, summary: "无需压缩：可压缩的历史消息不足。" };
  }
  const store = opts?.store;
  if (store?.markCompacted) {
    const marked: number[] = [];
    next.forEach((m, i) => {
      if (m.compacted && !messages[i]?.compacted) marked.push(i);
    });
    await store.markCompacted(marked);
  }
  if (store?.appendSummary && result.summary) await store.appendSummary(result.summary);
  return result;
}
