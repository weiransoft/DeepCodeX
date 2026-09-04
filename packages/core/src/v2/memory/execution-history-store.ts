/**
 * execution-history-store.ts — 执行历史存储层
 *
 * 核心设计：
 * 1. 以 jsonl（JSON Lines）格式持久化，路径 ~/.deepcode/projects/<projectCode>/execution-history.jsonl
 *    —— 与 session.jsonl 独立文件、零侵入
 *    —— 用 session.ts 已有的 getProjectCode() 计算路径，保证同一项目走同一目录
 * 2. record() 返回 Promise 但 session hooks 用 fire-and-forget 调用
 *    —— 设计约束：onAfterToolExecution 钩子签名是同步的（tool-types.ts），
 *       钩子内调用必须 `void store.record(...).catch(() => {})`
 *    —— 内部用 pending 写缓冲队列 + 100ms flush 定时器，合并 burst writes 为单次 fs 操作
 * 3. turnIndex 内部自增：
 *    —— session 首次 record 时从文件扫一次现有该 session 最大 turnIndex + 1
 *    —— 后续 record 用内存 Map<sessionId, number> 计数器 O(1) 获取并递增
 *    —— Advisor 建议：session.executeToolCalls 逐条调用（每次传 [toolCall] 单元素），
 *       每条工具执行触发一次 onAfterToolExecution，所以 turnIndex 不能依赖批次序号
 * 4. 内存缓存 + 自动裁剪：
 *    —— 缓存结构：Map<sessionId, ExecutionRecord[]>，按 session 聚合
 *    —— 查询时优先查缓存；缓存 miss 才读文件并填充缓存
 *    —— prune() 裁剪：每 session 最多 500 条、全局 age ≤ 100 天
 * 5. fail-safe 降级（对齐 PRD §5）：
 *    —— fs 写异常 → console.error + 静默降级，主流程继续
 *    —— jsonl 解析异常 → backupCorruptedFile + 返回空数组 + invalidateCache
 *    —— query() 历史库不存在 → 返回空数组（fail-safe）
 *
 * Anchor 文件零改动：本文件不依赖 executor.ts / prompt.ts / tool-types.ts
 * （仅依赖 session.ts 的 getProjectCode 纯函数，且 session.ts 不 import 本模块——无循环依赖）
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  ArtifactEntry,
  ExecutionHistoryQuery,
  ExecutionHistoryRecordInputs,
  ExecutionHistoryStoreOptions,
  ExecutionRecord,
  LOW_VALUE_BASH_COMMANDS,
} from "./execution-history-types";
// V2 模块禁止直接 import V1 文件（P1-05 单一入口约束），getProjectCode 经
// v1-adapters 统一 re-export（§15）
import { getProjectCode } from "../integration/v1-adapters";

/** 默认配置常量（对齐 PRD 默认值） */
const DEFAULT_MAX_RECORDS_PER_SESSION = 500;
const DEFAULT_MAX_AGE_DAYS = 100;
const DEFAULT_CACHE_MAX = 2000;
/** 单条 ExecutionRecord 落盘 payload 上限（字节）——超出时静默截断 args/outputSnippet/errorSnippet */
const MAX_RECORD_PAYLOAD_BYTES = 64 * 1024; // 64KB
/** 写缓冲 flush 合并窗口（ms）——合并 burst writes 为单次 fs appendFile */
const WRITE_BUFFER_FLUSH_DELAY_MS = 100;

/** ExecutionHistoryStore 类 */
export class ExecutionHistoryStore {
  /** 存储目录（~/.deepcode/projects/<projectCode>/） */
  private readonly projectDir: string;
  /** 历史记录文件完整路径 */
  private readonly historyFilePath: string;

  /** 配置参数 */
  private readonly options: Required<
    Pick<ExecutionHistoryStoreOptions, "maxRecordsPerSession" | "maxAgeDays" | "cacheMax">
  >;

  /** 内存缓存：Map<sessionId, ExecutionRecord[]> */
  private readonly cache = new Map<string, ExecutionRecord[]>();
  /** 是否已缓存完整文件（文件扫描至少做过一次）——避免每次 query 都读文件 */
  private isFullyLoaded = false;
  /** 文件是否不存在过（缓存此状态——不存在=空库，不重复触发 readFile） */
  private fileMissing = false;

  // ========== 写缓冲队列 ==========
  /** 待写入文件的 record 队列（顺序追加） */
  private pendingWrites: ExecutionRecord[] = [];
  /** flush 定时器引用（null = 没在排队 flush） */
  private flushTimer: NodeJS.Timeout | null = null;
  /** 是否正在 flush（防止重入） */
  private flushing = false;

  // ========== 内部 turnIndex 自增计数器 ==========
  /** sessionId → 当前最大 turnIndex，每次 record 时 +1 */
  private readonly sessionTurnIndex = new Map<string, number>();

  constructor(options: ExecutionHistoryStoreOptions) {
    const projectCode = getProjectCode(options.projectRoot);
    this.projectDir = path.join(os.homedir(), ".deepcode", "projects", projectCode);
    this.historyFilePath = path.join(this.projectDir, "execution-history.jsonl");

    this.options = {
      maxRecordsPerSession: options.maxRecordsPerSession ?? DEFAULT_MAX_RECORDS_PER_SESSION,
      maxAgeDays: options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS,
      cacheMax: options.cacheMax ?? DEFAULT_CACHE_MAX,
    };
  }

  // ========== 生命周期 ==========

  /**
   * 确保存储目录存在
   * —— 构造函数不立即创建目录（避免无 session 启动时就产生 .deepcode 目录）
   * —— 首次 record() 或 query() 时按需创建
   */
  private ensureDir(): void {
    if (fs.existsSync(this.projectDir)) return;
    try {
      fs.mkdirSync(this.projectDir, { recursive: true });
    } catch {
      // fs.mkdirSync 失败（权限问题等）——静默降级，后续 fs 写会再次失败并 console.error
    }
  }

  /** 关闭存储——flush 所有 pending writes（同步阻塞调用，用于进程退出前） */
  closeSync(): void {
    // 清除定时器，确保不再触发后续 flush
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // 同步 flush 队列（fs 调用，阻塞当前线程）
    if (this.pendingWrites.length > 0) {
      this.flushPendingWritesSync();
    }
  }

  // ========== 写入核心：record() ==========

  /**
   * 记录一条执行历史
   *
   * 内部实现：同步部分（id 生成 / payload 截断 / 入写缓冲队列）→ 异步部分（fs appendFile 在 flush 定时器里执行）
   * 外部调用规范：必须 fire-and-forget
   *   - session hooks: void store.record({...}).catch(() => {})
   *   - 钩子内 return result 原样返回，不修改 ToolExecutionResult
   *   - 这是因为 onAfterToolExecution 钩子签名是同步返回 ToolExecutionResult（tool-types.ts L128-131）
   *
   * @param inputs 执行记录输入（不含 id/turnIndex/date 等内部字段）
   */
  record(inputs: ExecutionHistoryRecordInputs): Promise<void> {
    // 生成唯一 id：时间戳毫秒 + 3 位十六进制随机后缀
    const recordId = `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;

    // turnIndex：首次为 0，后续 +1
    // 计算逻辑：从 sessionTurnIndex 取已有值，没有则从文件扫现有最大值；然后 +1 作为本次的 turnIndex
    let turnIndex = this.sessionTurnIndex.get(inputs.sessionId);
    if (turnIndex === undefined) {
      // 首次出现该 session——从文件扫一次现有最大 turnIndex
      turnIndex = this.computeSessionTurnIndexFromFile(inputs.sessionId);
    }
    turnIndex = turnIndex + 1; // 总是 +1：首次 compute 返回 -1 → +1 = 0；后续返回上次值 → +1 = 下一个
    this.sessionTurnIndex.set(inputs.sessionId, turnIndex);

    // 构建 ExecutionRecord（对齐 types.ts）
    // timestamp / date 优先用 inputs 传入值（测试控制时序），否则 Date.now() 自动生成
    const now = inputs.timestamp ?? Date.now();
    const dateStr = inputs.date ?? new Date(now).toISOString().slice(0, 10);
    const record: ExecutionRecord = {
      id: recordId,
      sessionId: inputs.sessionId,
      turnIndex,
      timestamp: now,
      date: dateStr, // YYYY-MM-DD
      toolName: inputs.toolName,
      ok: inputs.ok,
      argsSnippet: this.truncateSnippet(inputs.argsSnippet, 4000),
      outputSnippet: this.truncateSnippet(inputs.outputSnippet, 4000),
      errorSnippet: this.truncateSnippet(inputs.errorSnippet, 2000),
      exitCode: inputs.exitCode ?? null,
      signal: inputs.signal ?? null,
      cwd: inputs.cwd ?? null,
      timedOut: inputs.timedOut,
      pid: inputs.pid ?? null,
      durationMs: inputs.durationMs,
      outputs: inputs.outputs,
      // 二期字段保持 undefined（一期读写时忽略）
    };

    // 入写缓冲队列 + 更新内存缓存
    this.pendingWrites.push(record);
    this.cacheRecordToMemory(record);

    // 启动/重启 flush 定时器（合并 burst writes 为单次 fs appendFile）
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        // flush 是 async 的——fire-and-forget，不阻塞 record() 调用方
        void this.flushPendingWritesAsync().catch((err) => {
          console.error("[execution-history] flush failed:", err);
        });
      }, WRITE_BUFFER_FLUSH_DELAY_MS);
    }

    // 返回立即 resolve 的 Promise——让调用方可以 .catch() 但不会 await 阻塞
    return Promise.resolve();
  }

  /**
   * 从文件中计算指定 session 当前最大 turnIndex（首次 record 时调用一次）
   * —— 用 fs.readFileSync 同步读取一次性数据（只在 session 首次出现时触发）
   * —— 如果缓存已加载则从缓存计算
   */
  private computeSessionTurnIndexFromFile(sessionId: string): number {
    const cached = this.cache.get(sessionId);
    if (cached && cached.length > 0) {
      return Math.max(...cached.map((r) => r.turnIndex));
    }
    // 缓存 miss —— 触发文件扫描（async flush 之前 record 先触发，所以必须同步读）
    try {
      this.ensureDir();
      if (!fs.existsSync(this.historyFilePath)) return -1;
      const fileContent = fs.readFileSync(this.historyFilePath, "utf8");
      let maxTurn = -1;
      for (const line of fileContent.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec: ExecutionRecord = JSON.parse(line);
          if (rec.sessionId === sessionId && rec.turnIndex > maxTurn) {
            maxTurn = rec.turnIndex;
          }
        } catch {
          // 跳过损坏行
        }
      }
      return maxTurn;
    } catch {
      return -1;
    }
  }

  /**
   * 截断 snippet 到指定最大字符数（防止单条 payload 爆炸）
   */
  private truncateSnippet(snippet: string | undefined | null, maxChars: number): string | undefined {
    if (snippet === undefined || snippet === null) return undefined;
    if (snippet.length <= maxChars) return snippet;
    return `${snippet.slice(0, maxChars)}...(truncated ${snippet.length - maxChars} chars)`;
  }

  // ========== 写缓冲 flush ==========

  /**
   * 异步 flush pending 队列到文件
   * —— 串行 fs appendFile 调用（一次 flush = 一次 appendFile）
   * —— flushing 标志防止 flush 过程中再次触发
   */
  private async flushPendingWritesAsync(): Promise<void> {
    if (this.flushing || this.pendingWrites.length === 0) return;
    this.flushing = true;
    try {
      const recordsToWrite = this.pendingWrites.splice(0, this.pendingWrites.length);
      await this.appendToFileAsync(recordsToWrite);
    } catch (err) {
      console.error("[execution-history] async flush error:", err);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 同步 flush（closeSync() 用）——进程退出前保证数据不丢
   */
  private flushPendingWritesSync(): void {
    if (this.pendingWrites.length === 0) return;
    const recordsToWrite = this.pendingWrites.splice(0, this.pendingWrites.length);
    this.appendToFileSync(recordsToWrite);
  }

  /**
   * 异步追加多条 record 到 jsonl 文件
   * —— 如果单条 payload 超 64KB，静默截断后再写入
   */
  private async appendToFileAsync(records: ExecutionRecord[]): Promise<void> {
    if (records.length === 0) return;
    this.ensureDir();
    const lines = records
      .map((r) => this.safeSerialize(r))
      .filter((s): s is string => s !== null)
      .map((s) => `${s}\n`)
      .join("");
    try {
      await fs.promises.appendFile(this.historyFilePath, lines, "utf8");
      this.fileMissing = false;
    } catch (err) {
      console.error("[execution-history] appendFile failed:", err);
      // 静默降级——内存缓存仍保留数据，进程重启前 query 还能查到
    }
  }

  /** 同步追加（closeSync 用） */
  private appendToFileSync(records: ExecutionRecord[]): void {
    if (records.length === 0) return;
    this.ensureDir();
    const lines = records
      .map((r) => this.safeSerialize(r))
      .filter((s): s is string => s !== null)
      .map((s) => `${s}\n`)
      .join("");
    try {
      fs.appendFileSync(this.historyFilePath, lines, "utf8");
      this.fileMissing = false;
    } catch (err) {
      console.error("[execution-history] appendFileSync failed:", err);
    }
  }

  /**
   * 安全序列化 ExecutionRecord
   * —— 如果单条 JSON 串超 64KB（MAX_RECORD_PAYLOAD_BYTES），截断 argsSnippet/outputSnippet 后重试
   * —— 最终如果还是超，返回 null（跳过这条，防止拖垮整个历史库）
   */
  private safeSerialize(record: ExecutionRecord): string | null {
    try {
      let json = JSON.stringify(record);
      if (Buffer.byteLength(json, "utf8") <= MAX_RECORD_PAYLOAD_BYTES) return json;
      // 超了——尝试截断 outputSnippet + argsSnippet
      const narrowed = { ...record };
      narrowed.outputSnippet = this.truncateSnippet(record.outputSnippet, 1000);
      narrowed.argsSnippet = this.truncateSnippet(record.argsSnippet, 1000);
      narrowed.errorSnippet = this.truncateSnippet(record.errorSnippet, 500);
      json = JSON.stringify(narrowed);
      if (Buffer.byteLength(json, "utf8") <= MAX_RECORD_PAYLOAD_BYTES) return json;
      // 还超——跳过这条
      console.warn("[execution-history] record payload exceeded 64KB, skipping record id=", record.id);
      return null;
    } catch {
      return null;
    }
  }

  // ========== 内存缓存管理 ==========

  private cacheRecordToMemory(record: ExecutionRecord): void {
    let sessionRecords = this.cache.get(record.sessionId);
    if (!sessionRecords) {
      sessionRecords = [];
      this.cache.set(record.sessionId, sessionRecords);
    }
    sessionRecords.push(record);

    // LRU 淘汰：缓存总条数超 cacheMax 时淘汰最旧 session
    let totalCount = 0;
    for (const recs of this.cache.values()) totalCount += recs.length;
    if (totalCount > this.options.cacheMax) {
      // 找到最旧的 sessionId（按该 session 最旧 record 的 timestamp 排序）
      let oldestSession: string | null = null;
      let oldestTs = Infinity;
      for (const [sid, recs] of this.cache) {
        const oldestInSession = recs.reduce((min, r) => Math.min(min, r.timestamp), Infinity);
        if (oldestInSession < oldestTs) {
          oldestTs = oldestInSession;
          oldestSession = sid;
        }
      }
      if (oldestSession) this.cache.delete(oldestSession);
    }
  }

  private invalidateCache(): void {
    this.cache.clear();
    this.isFullyLoaded = false;
  }

  // ========== 查询核心：query() ==========

  /**
   * 查询执行历史
   * —— 优先查内存缓存；缓存 miss 才读文件
   * —— 支持 sessionId / toolName / lastDays / ok / keyword 多维度过滤
   */
  query(query: ExecutionHistoryQuery = {}): ExecutionRecord[] {
    // 如果还没加载过文件，先全量加载一次
    if (!this.isFullyLoaded) {
      this.loadFileToCache();
    }

    let records = this.getAllRecordsFromCache();

    // 维度过滤
    if (query.sessionId) {
      records = records.filter((r) => r.sessionId === query.sessionId);
    }
    if (query.toolName) {
      records = records.filter((r) => r.toolName === query.toolName);
    }
    if (query.lastDays !== undefined) {
      const cutoff = Date.now() - query.lastDays * 24 * 60 * 60 * 1000;
      records = records.filter((r) => r.timestamp >= cutoff);
    }
    if (query.ok !== undefined) {
      records = records.filter((r) => r.ok === query.ok);
    }
    if (query.keyword) {
      const kw = query.keyword.toLowerCase();
      records = records.filter((r) => {
        return (
          (r.argsSnippet && r.argsSnippet.toLowerCase().includes(kw)) ||
          (r.outputSnippet && r.outputSnippet.toLowerCase().includes(kw)) ||
          (r.cwd && r.cwd.toLowerCase().includes(kw)) ||
          r.toolName.toLowerCase().includes(kw)
        );
      });
    }

    // 排序（默认最新在前）
    const order = query.order ?? "desc";
    records.sort((a, b) => {
      const diff = b.timestamp - a.timestamp;
      return order === "desc" ? diff : -diff;
    });

    // 分页
    const start = query.offset ?? 0;
    const limit = query.limit ?? 200;
    return records.slice(start, start + limit);
  }

  /** 读文件 → 填充缓存（损坏文件自动备份） */
  private loadFileToCache(): void {
    this.isFullyLoaded = true;
    // 关键：先清空 cache——record() 已经把未 flush 的数据写进 cache 了，
    // loadFileToCache 又从文件扫一遍，会造成双倍数据。
    // 清空后让文件成为唯一数据源，保证唯一性。
    this.cache.clear();

    this.ensureDir();
    if (!fs.existsSync(this.historyFilePath)) {
      this.fileMissing = true;
      return;
    }
    this.fileMissing = false;
    try {
      const content = fs.readFileSync(this.historyFilePath, "utf8");
      let validCount = 0;
      const corruptedLines: string[] = [];
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record: ExecutionRecord = JSON.parse(line);
          this.cacheRecordToMemory(record);
          validCount++;
        } catch {
          corruptedLines.push(line);
        }
      }
      if (corruptedLines.length > 0) {
        console.warn(
          `[execution-history] 发现 ${corruptedLines.length} 条损坏记录（有效 ${validCount} 条），备份损坏行`
        );
        this.backupCorruptedLines(corruptedLines);
      }
    } catch (err) {
      console.error("[execution-history] 读文件失败:", err);
      // 读失败 → 不抛错，返回空数组，fail-safe
    }
  }

  /**
   * 备份损坏行到同目录 .corrupted 后缀文件
   * —— 对齐 MemoryStore 的损坏处理范式
   */
  private backupCorruptedLines(lines: string[]): void {
    try {
      const backupPath = `${this.historyFilePath}.corrupted.${Date.now()}.log`;
      fs.appendFileSync(backupPath, lines.join("\n") + "\n", "utf8");
    } catch {
      // 备份也失败 → 静默，至少不会影响主流程
    }
  }

  /** 从缓存聚合所有记录（按 timestamp 全局排序） */
  private getAllRecordsFromCache(): ExecutionRecord[] {
    const all: ExecutionRecord[] = [];
    for (const recs of this.cache.values()) {
      all.push(...recs);
    }
    return all;
  }

  // ========== 裁剪：prune() ==========

  /**
   * 自动裁剪（对齐 PRD 约束）
   * 1. 每 session 最多保留 maxRecordsPerSession（默认 500）条
   * 2. 全局 age 超过 maxAgeDays（默认 100 天）的全部删除
   * —— 裁剪后需要 fs 重写整个文件（jsonl 格式不方便就地删除行）
   */
  prune(): { prunedBySession: number; prunedByAge: number; totalRemaining: number } {
    // 确保缓存已加载
    if (!this.isFullyLoaded) this.loadFileToCache();

    let prunedBySession = 0;
    let prunedByAge = 0;

    // 裁剪 age
    const ageCutoff = Date.now() - this.options.maxAgeDays * 24 * 60 * 60 * 1000;

    // 按 session 聚合后裁剪
    const prunedCache = new Map<string, ExecutionRecord[]>();
    for (const [sessionId, records] of this.cache) {
      // age 裁剪
      const ageFiltered = records.filter((r) => r.timestamp >= ageCutoff);
      prunedByAge += records.length - ageFiltered.length;

      // session 量裁剪（最新在前保留）
      const sortedDesc = [...ageFiltered].sort((a, b) => b.turnIndex - a.turnIndex);
      const sessionFiltered = sortedDesc.slice(0, this.options.maxRecordsPerSession);
      prunedBySession += ageFiltered.length - sessionFiltered.length;

      prunedCache.set(sessionId, sessionFiltered);
    }
    this.cache.clear();
    for (const [sid, recs] of prunedCache) {
      this.cache.set(sid, recs);
    }

    // 重写文件（jsonl 格式不方便就地删除行）
    this.rewriteFileFromCache();

    const totalRemaining = this.getAllRecordsFromCache().length;
    return { prunedBySession, prunedByAge, totalRemaining };
  }

  /** 用缓存全量重写文件（fs 原子写模式：先写 .tmp 再 rename） */
  private rewriteFileFromCache(): void {
    const allRecords = this.getAllRecordsFromCache();
    if (allRecords.length === 0) {
      // 空了——删文件
      try {
        if (fs.existsSync(this.historyFilePath)) fs.unlinkSync(this.historyFilePath);
      } catch {
        // 静默
      }
      return;
    }
    const content =
      allRecords
        .map((r) => this.safeSerialize(r))
        .filter((s): s is string => s !== null)
        .join("\n") + "\n";
    try {
      this.ensureDir();
      // 原子写：先写 .tmp，再 rename 覆盖原文件
      const tmpPath = `${this.historyFilePath}.tmp`;
      fs.writeFileSync(tmpPath, content, "utf8");
      fs.renameSync(tmpPath, this.historyFilePath);
      this.fileMissing = false;
    } catch (err) {
      console.error("[execution-history] rewriteFile failed:", err);
    }
  }

  // ========== 查询工具：LLM query_execution_history 用 ==========

  /**
   * 构建 query_execution_history LLM 工具的 QueryResult
   * —— query() 过滤后，对敏感字段做额外截断（比内部 record 更短）
   * —— 返回结果直接喂给 LLM（JSON 可读）
   */
  buildToolQueryResult(query: ExecutionHistoryQuery = {}): {
    ok: boolean;
    totalCount: number;
    returnedCount: number;
    records: Array<{
      id: string;
      sessionId: string;
      date: string;
      toolName: string;
      ok: boolean;
      exitCode?: number | null;
      cwd?: string | null;
      durationMs?: number;
      args: string;
      output: string;
      outputCount: number;
    }>;
    error?: string;
  } {
    let rawRecords: ExecutionRecord[] = [];
    try {
      rawRecords = this.query(query);
    } catch (err) {
      return {
        ok: false,
        totalCount: 0,
        returnedCount: 0,
        records: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // 如果历史库完全空（query 返回空数组），ok=true + count=0
    const totalCount = rawRecords.length;
    const limit = query.limit ?? 200;
    const returned = rawRecords.slice(0, limit);

    return {
      ok: true,
      totalCount,
      returnedCount: returned.length,
      records: returned.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        date: r.date,
        toolName: r.toolName,
        ok: r.ok,
        exitCode: r.exitCode,
        cwd: r.cwd,
        durationMs: r.durationMs,
        args: (r.argsSnippet ?? "").slice(0, 500),
        output: (r.outputSnippet ?? "").slice(0, 1000),
        outputCount: r.outputs?.length ?? 0,
      })),
    };
  }

  // ========== 只读辅助方法 ==========

  /** 获取存储目录（供 session 确认路径正确） */
  getProjectDir(): string {
    return this.projectDir;
  }

  /** 获取历史记录文件路径 */
  getHistoryFilePath(): string {
    return this.historyFilePath;
  }

  /** 获取当前内存缓存状态（测试/调试用） */
  getCacheState(): { sessionCount: number; totalRecords: number; isFullyLoaded: boolean } {
    let total = 0;
    for (const recs of this.cache.values()) total += recs.length;
    return {
      sessionCount: this.cache.size,
      totalRecords: total,
      isFullyLoaded: this.isFullyLoaded,
    };
  }
}
