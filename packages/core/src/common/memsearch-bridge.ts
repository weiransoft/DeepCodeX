/**
 * memsearch-bridge.ts — 外部 memsearch CLI 的 TypeScript 桥接层
 *
 * 设计：官方 zilliztech/memsearch（Python CLI）是唯一检索实现，本层只负责
 * 子进程调用与结果解析，不在 TypeScript 里复刻向量库 / embedding / 分块。
 *
 * 诚实降级纪律（对齐 voice-api.ts 的可选外部依赖范式）：
 * - CLI 不存在、超时、非零退出、JSON 非法、字段不合规，一律 ok:false + 明确 status，
 *   绝不用空结果伪装成功，绝不把 stderr 吞掉。
 * - 只有真正拿到合法结果（含合法的空数组）才 ok:true。
 * - 可执行文件可用 DEEPCODE_MEMSEARCH_BIN 覆盖；GUI 启动时 PATH 可能不含
 *   ~/.local/bin，因此额外探测该绝对路径。
 *
 * 三层渐进召回：searchMemories (L1) → expandMemories (L2) → transcript (L3，CLI 直调)。
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** 安装提示：国内 pypi 镜像，避免官方源在本机超时 */
export const MEMSEARCH_INSTALL_HINT =
  "uv tool install memsearch --default-index https://pypi.tuna.tsinghua.edu.cn/simple";

/** 单次调用默认超时（含 embedding 远程调用与 Milvus 检索） */
export const MEMSEARCH_DEFAULT_TIMEOUT_MS = 30_000;

/** stdout/stderr 保留上限，防止恶意/异常输出撑爆内存；取尾部保留错误上下文 */
const MAX_CAPTURED_CHARS = 512_000;

export type MemsearchStatus = "ok" | "unavailable" | "error" | "timeout" | "invalid-output";

/** L1 search 的单条命中（字段来自 `memsearch search --json-output` 实测契约） */
export interface MemsearchChunk {
  readonly chunk_hash: string;
  readonly content: string;
  readonly source: string;
  readonly heading: string;
  readonly heading_level: number;
  readonly start_line: number;
  readonly end_line: number;
  readonly score: number;
}

/** L2 expand 的完整章节（字段来自 `memsearch expand --json-output` 实测契约） */
export interface MemsearchExpansion {
  readonly chunk_hash: string;
  readonly source: string;
  readonly heading: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly content: string;
}

export interface MemsearchOutcomeBase {
  /** 只有真正完成检索并解析出合法结果才为 true */
  readonly ok: boolean;
  readonly status: MemsearchStatus;
  /** 人可读结论；失败原因必须具体，禁止泛化模板 */
  readonly reason: string;
  /** 修复建议；成功时为空串 */
  readonly hint: string;
  readonly durationMs: number;
  readonly cliVersion: string | null;
}

export interface MemsearchSearchOutcome extends MemsearchOutcomeBase {
  readonly results: readonly MemsearchChunk[];
  /** 因字段不合规被丢弃的结果条数 */
  readonly droppedCount: number;
}

export interface MemsearchExpandOutcome extends MemsearchOutcomeBase {
  readonly expansion: MemsearchExpansion | null;
}

export interface MemsearchIndexOutcome extends MemsearchOutcomeBase {
  readonly indexedChunks: number | null;
  /**
   * 官方 CLI 对单文件 embedding 失败是「logger.exception + skipping」并仍以 exit 0 结束。
   * 这里显式统计 stderr 中的失败文件数，避免把「部分失败」误报成完整成功。
   */
  readonly failedFiles: number;
  /** 部分成功：有文件失败但已写入若干 chunk */
  readonly partial: boolean;
}

export interface MemsearchStatsOutcome extends MemsearchOutcomeBase {
  readonly totalChunks: number | null;
}

/** 子进程原始结果，可注入替身用于确定性单测 */
export interface MemsearchCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string;
  readonly timedOut: boolean;
}

export interface MemsearchRunOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type MemsearchRunner = (
  bin: string,
  args: readonly string[],
  options: MemsearchRunOptions
) => Promise<MemsearchCommandResult>;

export interface MemsearchEnv {
  readonly runner?: MemsearchRunner;
  /** 显式指定可执行文件；未指定时按 candidates 逐个探测 */
  readonly bin?: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface MemsearchSearchOptions extends MemsearchEnv {
  readonly query: string;
  readonly topK?: number;
  readonly collection?: string;
  /** per-user 隔离：只检索 source 路径以该前缀开头的 chunk */
  readonly sourcePrefix?: string;
}

export interface MemsearchExpandOptions extends MemsearchEnv {
  readonly chunkHash: string;
  readonly collection?: string;
}

export interface MemsearchIndexOptions extends MemsearchEnv {
  readonly paths: readonly string[];
  readonly collection?: string;
  readonly force?: boolean;
  /** gitignore 风格排除模式，逐项传给 --exclude */
  readonly excludePatterns?: readonly string[];
  /**
   * embedding batch 上限。OpenAI provider 默认 256，在 as1 qwen3-embedding
   * （上下文 32768）上一次 batch 累计可超 38k tokens 而 400 失败，实测 16 稳定。
   */
  readonly batchSize?: number;
}

export interface MemsearchStatsOptions extends MemsearchEnv {
  readonly collection?: string;
}

interface ProbeResult {
  readonly bin: string;
  readonly version: string | null;
  readonly ok: boolean;
  readonly reason: string;
}

function appendCapped(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > MAX_CAPTURED_CHARS ? next.slice(-MAX_CAPTURED_CHARS) : next;
}

/**
 * 子进程 stderr 可能回显上游 embedding 服务的凭据（api_key / Bearer token）。
 * 进入 reason（会被上层日志/HTTP 响应消费）前做最小脱敏。
 */
function redactSecrets(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1<redacted>")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "<redacted>")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)\S+/gi, "$1<redacted>");
}

/** 默认 runner：真实 spawn，带超时与 SIGKILL 兜底 */
export function createSpawnRunner(): MemsearchRunner {
  return (bin, args, options) =>
    new Promise((resolve) => {
      const timeoutMs = options.timeoutMs ?? MEMSEARCH_DEFAULT_TIMEOUT_MS;
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const child = spawn(bin, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const finish = (result: MemsearchCommandResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        const killer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        killer.unref();
      }, timeoutMs);
      timer.unref();

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout = appendCapped(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = appendCapped(stderr, chunk);
      });
      child.on("error", (err: Error) => {
        clearTimeout(timer);
        finish({ status: null, stdout, stderr, error: err.message, timedOut });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        finish({ status: code, stdout, stderr, error: "", timedOut });
      });
    });
}

/** 可执行文件候选：显式值 > PATH > uv tool 默认安装位置 */
export function memsearchBinCandidates(explicit?: string): readonly string[] {
  const list: string[] = [];
  const override = explicit?.trim() || process.env.DEEPCODE_MEMSEARCH_BIN?.trim();
  if (override) list.push(override);
  list.push("memsearch", join(homedir(), ".local", "bin", "memsearch"));
  return Object.freeze([...new Set(list)]);
}

function parseVersion(stdout: string): string | null {
  const match = /version\s+([0-9][0-9A-Za-z.-]*)/.exec(stdout);
  return match ? match[1] : null;
}

/** 探测 CLI 是否可用；所有候选都失败才返回 ok:false */
export async function probeMemsearch(options: MemsearchEnv = {}): Promise<ProbeResult> {
  const runner = options.runner ?? createSpawnRunner();
  const failures: string[] = [];
  for (const bin of memsearchBinCandidates(options.bin)) {
    const result = await runner(bin, ["--version"], {
      timeoutMs: Math.min(options.timeoutMs ?? MEMSEARCH_DEFAULT_TIMEOUT_MS, 5_000),
      cwd: options.cwd,
      env: options.env,
    });
    if (!result.error && result.status === 0) {
      return {
        bin,
        version: parseVersion(result.stdout),
        ok: true,
        reason: `memsearch CLI 可用（${bin}）`,
      };
    }
    failures.push(`${bin}: ${result.error || result.stderr.trim() || `exit=${String(result.status)}`}`);
  }
  return {
    bin: "",
    version: null,
    ok: false,
    reason: `memsearch CLI 不可用（${failures.join("；")}）`,
  };
}

interface RawOutcome extends MemsearchOutcomeBase {
  readonly stdout: string;
  readonly stderr: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 统一执行入口：探测 → 组装参数 → spawn → 判定退出态 */
async function runMemsearch(args: readonly string[], options: MemsearchEnv): Promise<RawOutcome> {
  const started = Date.now();
  const probe = await probeMemsearch(options);
  const base = {
    durationMs: Date.now() - started,
    cliVersion: probe.version,
  };
  if (!probe.ok) {
    return {
      ...base,
      ok: false,
      status: "unavailable",
      reason: probe.reason,
      hint: `安装：${MEMSEARCH_INSTALL_HINT}；或设置 DEEPCODE_MEMSEARCH_BIN 指向可执行文件`,
      stdout: "",
      stderr: "",
    };
  }

  const runner = options.runner ?? createSpawnRunner();
  const result = await runner(probe.bin, args, {
    timeoutMs: options.timeoutMs ?? MEMSEARCH_DEFAULT_TIMEOUT_MS,
    cwd: options.cwd,
    env: options.env,
  });
  const elapsed = Date.now() - started;

  if (result.timedOut) {
    return {
      ok: false,
      status: "timeout",
      reason: `memsearch 调用超时（${String(options.timeoutMs ?? MEMSEARCH_DEFAULT_TIMEOUT_MS)}ms）`,
      hint: "检查 embedding 服务可达性，或调大 timeoutMs",
      durationMs: elapsed,
      cliVersion: probe.version,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  if (result.error || result.status !== 0) {
    const detail = redactSecrets(result.error || result.stderr.trim() || "无 stderr 输出").slice(-800);
    return {
      ok: false,
      status: "error",
      reason: `memsearch 退出码 ${String(result.status)}：${detail}`,
      hint: "确认 ~/.memsearch/config.toml 的 embedding 配置与网络可达性",
      durationMs: elapsed,
      cliVersion: probe.version,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return {
    ok: true,
    status: "ok",
    reason: "memsearch 调用完成",
    hint: "",
    durationMs: elapsed,
    cliVersion: probe.version,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parseJson(raw: RawOutcome, label: string): { value: unknown | null; outcome: RawOutcome | null } {
  try {
    return { value: JSON.parse(raw.stdout) as unknown, outcome: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      value: null,
      outcome: {
        ...raw,
        ok: false,
        status: "invalid-output",
        reason: `${label} 输出不是合法 JSON：${message}`,
        hint: "确认 memsearch 版本 >= 0.4.23 且使用了 --json-output",
      },
    };
  }
}

/** L1：混合检索（BM25 + dense + RRF），返回按 score 排序的 chunk 列表 */
export async function searchMemories(options: MemsearchSearchOptions): Promise<MemsearchSearchOutcome> {
  const query = options.query?.trim() ?? "";
  const started = Date.now();
  if (query.length === 0) {
    return {
      ok: false,
      status: "error",
      reason: "查询文本为空",
      hint: "提供非空 query",
      durationMs: 0,
      cliVersion: null,
      results: Object.freeze([]),
      droppedCount: 0,
    };
  }

  const topK = Math.min(Math.max(Math.trunc(options.topK ?? 5), 1), 50);
  const args = ["search", query, "--json-output", "--top-k", String(topK)];
  if (options.collection) args.push("--collection", options.collection);
  if (options.sourcePrefix) args.push("--source-prefix", options.sourcePrefix);

  const raw = await runMemsearch(args, options);
  if (!raw.ok) {
    return { ...stripRaw(raw), results: Object.freeze([]), droppedCount: 0 };
  }

  const parsed = parseJson(raw, "search");
  if (parsed.outcome) {
    return { ...stripRaw(parsed.outcome), results: Object.freeze([]), droppedCount: 0 };
  }
  if (!Array.isArray(parsed.value)) {
    return {
      ...stripRaw({
        ...raw,
        ok: false,
        status: "invalid-output",
        reason: "search 输出不是数组",
        hint: "确认 memsearch 版本 >= 0.4.23 且使用了 --json-output",
      }),
      results: Object.freeze([]),
      droppedCount: 0,
    };
  }

  const results: MemsearchChunk[] = [];
  let droppedCount = 0;
  for (const item of parsed.value) {
    if (!isRecord(item)) {
      droppedCount += 1;
      continue;
    }
    const hash = stringOrEmpty(item.chunk_hash).trim();
    const content = stringOrEmpty(item.content);
    const source = stringOrEmpty(item.source);
    if (!hash || !content || !source) {
      droppedCount += 1;
      continue;
    }
    results.push({
      chunk_hash: hash,
      content,
      source,
      heading: stringOrEmpty(item.heading),
      heading_level: numberOrZero(item.heading_level),
      start_line: numberOrZero(item.start_line),
      end_line: numberOrZero(item.end_line),
      score: numberOrZero(item.score),
    });
  }

  if (parsed.value.length > 0 && results.length === 0) {
    return {
      ...stripRaw({
        ...raw,
        ok: false,
        status: "invalid-output",
        reason: `search 返回 ${parsed.value.length} 条结果但字段全部不合规`,
        hint: "检查 memsearch 版本的 --json-output 字段契约",
      }),
      results: Object.freeze([]),
      droppedCount,
    };
  }

  return {
    ...stripRaw({
      ...raw,
      reason:
        droppedCount > 0
          ? `检索完成，返回 ${results.length} 条，丢弃 ${droppedCount} 条字段不合规结果`
          : `检索完成，返回 ${results.length} 条`,
    }),
    results: Object.freeze(results),
    droppedCount,
    durationMs: Date.now() - started,
  };
}

/** L2：按 chunk_hash 展开完整 heading 章节 */
export async function expandMemories(options: MemsearchExpandOptions): Promise<MemsearchExpandOutcome> {
  const hash = options.chunkHash?.trim() ?? "";
  if (hash.length === 0) {
    return {
      ok: false,
      status: "error",
      reason: "chunk_hash 为空",
      hint: "先调用 searchMemories 取得 chunk_hash",
      durationMs: 0,
      cliVersion: null,
      expansion: null,
    };
  }
  const args = ["expand", hash, "--json-output"];
  if (options.collection) args.push("--collection", options.collection);

  const raw = await runMemsearch(args, options);
  if (!raw.ok) return { ...stripRaw(raw), expansion: null };

  const parsed = parseJson(raw, "expand");
  if (parsed.outcome) return { ...stripRaw(parsed.outcome), expansion: null };
  if (!isRecord(parsed.value)) {
    return {
      ...stripRaw({
        ...raw,
        ok: false,
        status: "invalid-output",
        reason: "expand 输出不是对象",
        hint: "确认 memsearch 版本 >= 0.4.23",
      }),
      expansion: null,
    };
  }
  const value = parsed.value;
  const content = stringOrEmpty(value.content);
  const source = stringOrEmpty(value.source);
  if (!content || !source) {
    return {
      ...stripRaw({
        ...raw,
        ok: false,
        status: "invalid-output",
        reason: "expand 输出缺少 content/source",
        hint: "检查 chunk_hash 是否属于当前 collection",
      }),
      expansion: null,
    };
  }
  return {
    ...stripRaw({ ...raw, reason: "章节展开完成" }),
    expansion: Object.freeze({
      chunk_hash: stringOrEmpty(value.chunk_hash) || hash,
      source,
      heading: stringOrEmpty(value.heading),
      start_line: numberOrZero(value.start_line),
      end_line: numberOrZero(value.end_line),
      content,
    }),
  };
}

/** 索引 markdown 语料；stats 是纯文本输出，解析不到数量时如实返回 null */
export async function indexMemories(options: MemsearchIndexOptions): Promise<MemsearchIndexOutcome> {
  const paths = (options.paths ?? []).filter((p) => typeof p === "string" && p.trim().length > 0);
  if (paths.length === 0) {
    return {
      ok: false,
      status: "error",
      reason: "索引路径为空",
      hint: "提供至少一个 markdown 目录或文件路径",
      durationMs: 0,
      cliVersion: null,
      indexedChunks: null,
      failedFiles: 0,
      partial: false,
    };
  }
  const args = ["index", ...paths];
  if (options.collection) args.push("--collection", options.collection);
  if (options.force === true) args.push("--force");
  for (const pattern of options.excludePatterns ?? []) {
    const trimmed = pattern.trim();
    if (trimmed.length > 0) args.push("--exclude", trimmed);
  }
  if (typeof options.batchSize === "number" && Number.isInteger(options.batchSize) && options.batchSize > 0) {
    args.push("--batch-size", String(options.batchSize));
  }

  const raw = await runMemsearch(args, options);
  if (!raw.ok) return { ...stripRaw(raw), indexedChunks: null, failedFiles: 0, partial: false };
  const match = /Indexed\s+(\d+)\s+chunks?/i.exec(raw.stdout);
  if (!match) {
    return {
      ...stripRaw({
        ...raw,
        ok: false,
        status: "invalid-output",
        reason: `index 输出无法解析条数：${raw.stdout.trim().slice(-200) || "(空)"}`,
        hint: "检查 memsearch 版本的 index 输出格式",
      }),
      indexedChunks: null,
      failedFiles: 0,
      partial: false,
    };
  }

  // 2026-11-08 生产实测：官方 CLI 在 1 个文件 embedding 超长时输出
  // "Failed to index <path>, skipping" 却仍以 exit 0 结束并报 "Indexed 2602 chunks"。
  // 只看退出码与 stdout 会把这次部分失败伪装成完整成功，必须消费 stderr 证据。
  const failedFiles = countFailedIndexFiles(raw.stderr);
  const indexedChunks = Number(match[1]);
  const partial = failedFiles > 0;
  return {
    ...stripRaw({
      ...raw,
      ok: !partial,
      status: partial ? "error" : "ok",
      reason: partial
        ? `索引部分失败：${failedFiles} 个文件未写入（已写入 ${indexedChunks} 个 chunk），不得视为完整成功`
        : `索引完成，写入 ${indexedChunks} 个 chunk`,
      hint: partial ? "检查 embedding 服务的 batch/上下文限制，修复后重新执行增量 index" : "",
    }),
    indexedChunks,
    failedFiles,
    partial,
  };
}

/** 统计 "Failed to index ..., skipping" 告警的文件数（按路径去重，堆栈重复行不重复计数） */
function countFailedIndexFiles(stderr: string): number {
  const paths = new Set<string>();
  for (const line of stderr.split(/\r?\n/)) {
    const match = /Failed to index\s+(.+?),\s*skipping/.exec(line);
    if (match) paths.add(match[1]);
  }
  return paths.size;
}

/** 查询索引规模 */
export async function memsearchStats(options: MemsearchStatsOptions = {}): Promise<MemsearchStatsOutcome> {
  const args = ["stats"];
  if (options.collection) args.push("--collection", options.collection);
  const raw = await runMemsearch(args, options);
  if (!raw.ok) return { ...stripRaw(raw), totalChunks: null };
  const match = /Total indexed chunks:\s*(\d+)/i.exec(raw.stdout);
  if (!match) {
    return {
      ...stripRaw({
        ...raw,
        ok: false,
        status: "invalid-output",
        reason: `stats 输出无法解析条数：${raw.stdout.trim().slice(-200) || "(空)"}`,
        hint: "检查 memsearch 版本的 stats 输出格式",
      }),
      totalChunks: null,
    };
  }
  return {
    ...stripRaw({ ...raw, reason: `索引共 ${match[1]} 个 chunk` }),
    totalChunks: Number(match[1]),
  };
}

function stripRaw(raw: RawOutcome): MemsearchOutcomeBase {
  return {
    ok: raw.ok,
    status: raw.status,
    reason: raw.reason,
    hint: raw.hint,
    durationMs: raw.durationMs,
    cliVersion: raw.cliVersion,
  };
}
