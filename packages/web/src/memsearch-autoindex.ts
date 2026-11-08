/**
 * memsearch-autoindex.ts — Web 常驻服务启动时的「自动增量索引」
 *
 * ## 设计约束（2026-11-08，实测定稿）
 *
 * 1. **不造 mtime manifest**：官方 `memsearch index` 自带内容哈希级增量
 *    （chunk_hash = hash(source:line:contentHash:model)，非 --force 时只 embed
 *    新增/变化的 chunk，并清理已删除文件的陈旧 chunk）。实测语料无变化时
 *    `Indexed 0 chunks` / 3s / 0 次 embedding 请求，因此启动时跑一次增量
 *    index 的成本可忽略。**绝不传 --force**（那会每次全量重嵌入）。
 * 2. **必须显式配置语料根才启用**：未配置时完全不 spawn 子进程，保证
 *    既有 15+ 个 `startWebServer` 集成测试零回归、零污染。
 * 3. **单一事实源**：`DEEPCODE_WEB_MEMSEARCH_CORPUS_DIRS` 既是自动索引的
 *    语料根，也是 Web 检索允许的共享前缀（见 memory-search-api.ts），
 *    避免「索引了却查不到」或「允许查询却没索引」。
 * 4. **fire-and-forget**：不 await、不阻塞 listen；失败只记录状态，
 *    既不阻断启动也绝不伪装成功。
 * 5. **日志脱敏**：只输出结构化状态字段，绝不输出子进程 stderr / reason /
 *    env（上游 embedding 服务可能在错误响应里回显凭据）。
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { indexMemories, probeMemsearch, type MemsearchRunner } from "@vegamo/deepcode-core";

/** 语料根（同时也是 Web 检索允许的共享前缀），path.delimiter 分隔的绝对路径 */
export const MEMSEARCH_CORPUS_DIRS_ENV = "DEEPCODE_WEB_MEMSEARCH_CORPUS_DIRS";
/** 设为 "0" 显式关闭；缺省启用，但仍需配置语料根才会真正执行 */
export const MEMSEARCH_AUTOINDEX_ENV = "DEEPCODE_WEB_MEMSEARCH_AUTOINDEX";
export const MEMSEARCH_COLLECTION_ENV = "DEEPCODE_WEB_MEMSEARCH_COLLECTION";
export const MEMSEARCH_EXCLUDES_ENV = "DEEPCODE_WEB_MEMSEARCH_EXCLUDES";
export const MEMSEARCH_BATCH_SIZE_ENV = "DEEPCODE_WEB_MEMSEARCH_BATCH_SIZE";

export const DEFAULT_MEMSEARCH_COLLECTION = "deepcodex_memory";
/**
 * OpenAI provider 默认 batch=256；as1 qwen3-embedding 上下文 32768，
 * 实测超宽表格文件会让单 batch 累计 38545 tokens 而 400 失败，16 稳定。
 */
export const DEFAULT_MEMSEARCH_BATCH_SIZE = 16;
/** 116 篇语料首次全量实测 57s，给 3 分钟余量 */
export const DEFAULT_MEMSEARCH_INDEX_TIMEOUT_MS = 180_000;

export type AutoIndexStatus = "disabled" | "aborted" | "unavailable" | "no-valid-dirs" | "partial" | "error" | "ok";

export interface AutoIndexConfig {
  readonly enabled: boolean;
  readonly skipReason: "disabled-by-env" | "no-corpus-dirs" | "";
  readonly corpusDirs: readonly string[];
  readonly collection: string;
  readonly excludePatterns: readonly string[];
  readonly batchSize: number;
  readonly timeoutMs: number;
}

/** 只含结构化状态，不含任何可能携带凭据的文本 */
export interface AutoIndexReport {
  readonly status: AutoIndexStatus;
  readonly skipReason: string;
  readonly indexedChunks: number | null;
  readonly failedFiles: number;
  readonly dirCount: number;
  readonly durationMs: number;
}

export interface AutoIndexRunOptions {
  readonly config: AutoIndexConfig;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly bin?: string;
  /** 注入式 runner，用于确定性单测（不 spawn 真实进程） */
  readonly runner?: MemsearchRunner;
}

/** 解析 path.delimiter 分隔的绝对路径列表；相对路径一律拒绝，去重后保序 */
export function parseAbsoluteDirs(raw: string | undefined | null): readonly string[] {
  if (!raw) return Object.freeze([]);
  const out: string[] = [];
  for (const part of raw.split(path.delimiter)) {
    const trimmed = part.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) continue;
    const normalized = path.normalize(trimmed);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return Object.freeze(out);
}

function parseCsv(raw: string | undefined | null): readonly string[] {
  if (!raw) return Object.freeze([]);
  return Object.freeze(
    raw
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  );
}

function parsePositiveInt(raw: string | undefined | null, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** 从环境变量解析自动索引配置；不读取、不打印任何凭据 */
export function resolveAutoIndexConfig(env: NodeJS.ProcessEnv = process.env): AutoIndexConfig {
  const corpusDirs = parseAbsoluteDirs(env[MEMSEARCH_CORPUS_DIRS_ENV]);
  const disabled = env[MEMSEARCH_AUTOINDEX_ENV] === "0";
  const collection = (env[MEMSEARCH_COLLECTION_ENV] ?? "").trim() || DEFAULT_MEMSEARCH_COLLECTION;
  return {
    enabled: !disabled && corpusDirs.length > 0,
    skipReason: disabled ? "disabled-by-env" : corpusDirs.length === 0 ? "no-corpus-dirs" : "",
    corpusDirs,
    collection,
    excludePatterns: parseCsv(env[MEMSEARCH_EXCLUDES_ENV]),
    batchSize: parsePositiveInt(env[MEMSEARCH_BATCH_SIZE_ENV], DEFAULT_MEMSEARCH_BATCH_SIZE, 256),
    timeoutMs: DEFAULT_MEMSEARCH_INDEX_TIMEOUT_MS,
  };
}

function isDirectory(value: string): boolean {
  try {
    return existsSync(value) && statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function emptyReport(config: AutoIndexConfig, status: AutoIndexStatus, started: number): AutoIndexReport {
  return {
    status,
    skipReason: config.skipReason,
    indexedChunks: null,
    failedFiles: 0,
    dirCount: 0,
    durationMs: Date.now() - started,
  };
}

/**
 * 执行一次增量索引。所有失败路径都返回明确 status，绝不返回「假成功」。
 * 调用方应自行决定是否 await；server.ts 以 fire-and-forget 方式使用。
 */
export async function runMemsearchAutoIndex(options: AutoIndexRunOptions): Promise<AutoIndexReport> {
  const { config, signal } = options;
  const started = Date.now();
  if (!config.enabled) return emptyReport(config, "disabled", started);
  if (signal?.aborted) return emptyReport(config, "aborted", started);

  const dirs = config.corpusDirs.filter(isDirectory);
  if (dirs.length === 0) {
    return {
      ...emptyReport(config, "no-valid-dirs", started),
      dirCount: config.corpusDirs.length,
    };
  }

  const probe = await probeMemsearch({
    bin: options.bin,
    runner: options.runner,
    env: options.env,
  });
  if (!probe.ok) {
    return { ...emptyReport(config, "unavailable", started), dirCount: dirs.length };
  }
  if (signal?.aborted) {
    return { ...emptyReport(config, "aborted", started), dirCount: dirs.length };
  }

  const outcome = await indexMemories({
    paths: dirs,
    collection: config.collection,
    excludePatterns: config.excludePatterns,
    batchSize: config.batchSize,
    timeoutMs: config.timeoutMs,
    bin: options.bin,
    runner: options.runner,
    env: options.env,
  });
  const report: AutoIndexReport = {
    status: outcome.partial ? "partial" : outcome.ok ? "ok" : "error",
    skipReason: "",
    indexedChunks: outcome.indexedChunks,
    failedFiles: outcome.failedFiles,
    dirCount: dirs.length,
    durationMs: Date.now() - started,
  };
  return report;
}

/** 日志只输出受控结构化字段，不含 reason / stderr / env */
export function formatAutoIndexReport(report: AutoIndexReport): string {
  const chunks = report.indexedChunks === null ? "n/a" : String(report.indexedChunks);
  const skip = report.skipReason ? ` skipReason=${report.skipReason}` : "";
  return `[memsearch-autoindex] status=${report.status} dirs=${report.dirCount} chunks=${chunks} failedFiles=${report.failedFiles} durationMs=${report.durationMs}${skip}`;
}

export interface AutoIndexHandle {
  readonly cancel: () => void;
  readonly done: Promise<AutoIndexReport>;
}

export interface StartAutoIndexOptions extends Omit<AutoIndexRunOptions, "config" | "signal"> {
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: (line: string) => void;
}

/**
 * 启动后台自动索引。返回句柄但**不 await**，因此 listen 与 startWebServer
 * 的返回完全不被 embedding 网络调用拖住；close() 时调用 cancel()。
 */
export function startMemsearchAutoIndex(options: StartAutoIndexOptions = {}): AutoIndexHandle {
  const controller = new AbortController();
  const config = resolveAutoIndexConfig(options.env ?? process.env);
  const logger = options.logger ?? ((line: string): void => console.log(line));
  const done = runMemsearchAutoIndex({
    config,
    signal: controller.signal,
    env: options.env,
    bin: options.bin,
    runner: options.runner,
  })
    .catch(
      (): AutoIndexReport => ({
        status: "error",
        skipReason: "",
        indexedChunks: null,
        failedFiles: 0,
        dirCount: config.corpusDirs.length,
        durationMs: 0,
      })
    )
    .then((report) => {
      // 未启用时静默，避免每个 web 集成测试都打一行日志
      if (report.status !== "disabled" && report.skipReason !== "no-corpus-dirs") {
        logger(formatAutoIndexReport(report));
      }
      return report;
    });
  return { cancel: (): void => controller.abort(), done };
}
