/**
 * SymbolGraphStore —— better-sqlite3 符号图谱存储主模块（EAG-P5 Phase 5.1 TASK-P5-1.1-003）
 *
 * 本模块实现 `SymbolGraphStore` 类，提供基于 better-sqlite3 的符号级代码图谱持久化能力，
 * 是 EAG-P5 Autonomous 无人值守模式跨会话续跑（FR-3.1）与符号级偏离检测（FR-3.4）的
 * 核心基础设施。
 *
 * 核心职责（对齐架构师审查文档 §4.3 + §7）：
 * 1. SQLite 连接管理（WAL 模式 + PRAGMA 调优 + 连接生命周期）
 * 2. Schema 初始化与迁移（6 表 + FTS5 虚拟表 + 3 triggers + 4 类索引 + PRAGMA user_version）
 * 3. 符号与边的 CRUD（addSymbol / addEdge / queryByName / queryByKind / getEdges）
 * 4. 爆炸半径 BFS 查询（getExplosionRadius，递归 CTE 实现，深度衰减 0.6）
 * 5. 图谱统计（getStats，含 dbFileSizeBytes）
 * 6. isGraphStoreAvailable 模块级单例探测（三重保障的第 3 重：消费方降级）
 *
 * 三重保障机制（对齐 ADR-P4-001 §2.1）：
 * - 保障 1：optionalDependencies 声明（package.json，安装失败不阻断 npm install）
 * - 保障 2：try/catch 动态加载（本模块顶层，better-sqlite3 缺失时不崩溃）
 * - 保障 3：isGraphStoreAvailable() 降级（消费方调用前判断，false 时静默降级到 P4 行为）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * 性能目标（NFR-3）：
 * - 符号搜索 P99 < 50ms（FTS5 BM25）
 * - 爆炸半径 BFS P99 < 50ms（递归 CTE + 深度衰减剪枝）
 * - 风险 Top-N P99 < 30ms（idx_risk_total 索引）
 *
 * @module eag/p5/symbol-graph-store
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

// ============================================================================
// 1. better-sqlite3 动态加载（保障 2：try/catch 探测）
// ============================================================================

/**
 * Node.js ESM 环境下的 require 函数
 *
 * better-sqlite3 是 CommonJS 模块，在 ESM 项目中需通过 createRequire 加载。
 * 此处一次性创建 require 函数，避免重复调用 createRequire。
 */
const dynamicRequire = createRequire(import.meta.url);

/**
 * better-sqlite3 Database 实例的最小类型声明
 *
 * 由于 better-sqlite3 通过 optionalDependencies 声明（可能未安装），
 * 此处声明使用到的 API 子集，避免直接 import 类型导致模块加载失败。
 * 完整 API 见：https://github.com/WiseLibs/better-sqlite3/blob/master/docs/API.md
 */
interface BetterSqlite3Database {
  /** 预编译 SQL 语句 */
  prepare(sql: string): BetterSqlite3Statement;
  /** 执行 SQL（无参数绑定，用于 DDL） */
  exec(sql: string): void;
  /** 查询 PRAGMA 值 */
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  /** 创建事务包装函数 */
  transaction<T>(fn: () => T): () => T;
  /** 关闭数据库连接 */
  close(): void;
  /** 数据库是否已打开 */
  readonly open: boolean;
}

/**
 * better-sqlite3 预编译语句接口
 */
interface BetterSqlite3Statement {
  /** 执行 INSERT/UPDATE/DELETE，返回变更信息 */
  run(...params: unknown[]): BetterSqlite3RunResult;
  /** 查询单行 */
  get(...params: unknown[]): unknown;
  /** 查询多行 */
  all(...params: unknown[]): unknown[];
}

/**
 * better-sqlite3 run() 返回结果
 */
interface BetterSqlite3RunResult {
  /** 受影响的行数 */
  changes: number;
  /** 最后插入的 rowid */
  lastInsertRowid: number | bigint;
}

/**
 * better-sqlite3 构造函数接口
 */
interface BetterSqlite3Constructor {
  new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }): BetterSqlite3Database;
}

/**
 * 已加载的 better-sqlite3 模块（null 表示未加载）
 *
 * 模块级单例，首次调用 isGraphStoreAvailable() 时加载，之后缓存。
 */
let betterSqlite3Module: BetterSqlite3Constructor | null = null;

/**
 * better-sqlite3 可用性探测缓存（null = 未探测，true/false = 探测结果）
 *
 * 模块级单例，确保运行期只探测一次（对齐架构师审查 §2.2.3）。
 */
let graphStoreAvailable: boolean | null = null;

/**
 * 探测 better-sqlite3 是否可用（三重保障的第 3 重：消费方降级判断）
 *
 * 实现方式（对齐架构师审查 §2.2.3）：
 * - 模块级单例缓存，首次调用时 try-load better-sqlite3
 * - 成功则缓存 true，失败缓存 false
 * - 运行期不重复探测（native 模块加载是进程级状态，不会从"可用"变"不可用"）
 *
 * 消费方使用模式：
 * ```typescript
 * if (isGraphStoreAvailable()) {
 *   const store = new SymbolGraphStore(dbPath);
 *   // 走 better-sqlite3 符号级图谱路径
 * } else {
 *   // 降级到 P4 既有行为（文件级 dependencyGraph）
 * }
 * ```
 *
 * @returns better-sqlite3 是否可用（true=可用，false=不可用，消费方应降级）
 */
export function isGraphStoreAvailable(): boolean {
  // 已探测过，直接返回缓存结果
  if (graphStoreAvailable !== null) {
    return graphStoreAvailable;
  }

  // 首次探测：尝试动态加载 better-sqlite3
  try {
    const mod = dynamicRequire("better-sqlite3");
    // better-sqlite3 的导出可能是函数（CommonJS default export）或对象（含 default 属性）
    const ctor = typeof mod === "function" ? mod : (mod.default as BetterSqlite3Constructor | undefined);
    if (typeof ctor !== "function") {
      throw new Error("better-sqlite3 导出不是可调用构造函数");
    }
    betterSqlite3Module = ctor;
    graphStoreAvailable = true;
  } catch {
    // 加载失败：better-sqlite3 未安装或 native 模块不兼容
    betterSqlite3Module = null;
    graphStoreAvailable = false;
  }

  return graphStoreAvailable;
}

// ============================================================================
// 2. 类型定义（对齐架构师审查 §4.3）
// ============================================================================

/**
 * 符号类型（字面量联合类型，与 SQLite schema CHECK 约束一致）
 *
 * 对齐架构师审查文档 §7.2 symbols 表的 kind 字段 CHECK 约束：
 * - class：类声明
 * - interface：接口声明
 * - function：顶层函数声明
 * - method：类方法
 * - field：类字段/成员变量
 * - enum：枚举声明
 * - type-alias：类型别名（type T = ...）
 *
 * 注意：与 eag/pkc/l2-types.ts 的 SymbolKind 不同（l2 含 variable/property，不含 field），
 * P5 符号图谱严格遵循 SQLite schema 约束，仅支持上述 7 种类型。
 */
export type SymbolKind = "class" | "interface" | "function" | "method" | "field" | "enum" | "type-alias";

/**
 * 边类型（4 类，与 SQLite schema CHECK 约束一致）
 *
 * - CALLS：调用边（A 调用 B 的方法/函数）
 * - INHERITS：继承边（A 继承 B）
 * - IMPLEMENTS：实现边（A 实现 B 接口）
 * - TESTED_BY：测试边（A 被 B 测试）
 */
export type EdgeKind = "CALLS" | "INHERITS" | "IMPLEMENTS" | "TESTED_BY";

/**
 * 边置信度标签（三级，与 SQLite schema CHECK 约束一致）
 *
 * - EXTRACTED：静态可判（同文件内 import / extends / implements），置信度 1.0
 * - AMBIGUOUS：推断（跨文件调用关系，签名匹配），置信度 0.6
 * - UNRESOLVED：未解析（命名匹配但无法确认），置信度 0.2，宁多勿漏低权重参与
 */
export type EdgeConfidence = "EXTRACTED" | "AMBIGUOUS" | "UNRESOLVED";

/** EXTRACTED 边的置信度数值（1.0，全权重参与 BFS） */
export const CONFIDENCE_EXTRACTED = 1.0 as const;
/** AMBIGUOUS 边的置信度数值（0.6，0.6 衰减参与 BFS） */
export const CONFIDENCE_AMBIGUOUS = 0.6 as const;
/** UNRESOLVED 边的置信度数值（0.2，低权重参与 BFS，不丢弃） */
export const CONFIDENCE_UNRESOLVED = 0.2 as const;

/**
 * 置信度标签 → 数值映射表（用于 addEdge 时校验与转换）
 *
 * 使用 Object.freeze 冻结，防止运行期篡改。
 */
export const CONFIDENCE_VALUE_MAP: Readonly<Record<EdgeConfidence, number>> = Object.freeze({
  EXTRACTED: CONFIDENCE_EXTRACTED,
  AMBIGUOUS: CONFIDENCE_AMBIGUOUS,
  UNRESOLVED: CONFIDENCE_UNRESOLVED,
});

/**
 * 符号记录（对应 SQLite symbols 表的一行）
 *
 * 所有字段 readonly——符号一经插入即不可变，代码变更通过增量更新
 * （删除旧符号 + 插入新符号）实现，而非原地修改。
 */
export interface SymbolRecord {
  /** 符号唯一 ID（格式：filePath:fullyQualifiedName） */
  readonly symbolId: string;
  /** 符号名（不含类前缀，如 "login"、"UserService"） */
  readonly name: string;
  /** 符号类型（7 种之一） */
  readonly kind: SymbolKind;
  /** 文件相对路径（相对于 projectRoot，使用 POSIX 分隔符） */
  readonly filePath: string;
  /** 起始行号（1-based） */
  readonly lineStart: number;
  /** 结束行号（1-based，含） */
  readonly lineEnd: number;
  /** 源代码 SHA-256（用于增量差分，避免未变更文件重复解析） */
  readonly sourceHash: string;
  /** 符号签名（截断到 200 字符，FTS5 索引字段） */
  readonly signature: string;
  /** 符号摘要（首行注释或符号名描述，FTS5 索引字段） */
  readonly summary: string;
}

/**
 * 边记录（对应 SQLite edges 表的一行）
 *
 * 所有字段 readonly——边一经插入即不可变。
 */
export interface EdgeRecord {
  /** 边自增 ID */
  readonly edgeId: number;
  /** 源符号 ID（调用方/子类/实现类/被测符号） */
  readonly sourceSymbolId: string;
  /** 目标符号 ID（被调用方/父类/接口/测试符号） */
  readonly targetSymbolId: string;
  /** 边类型（4 种之一） */
  readonly kind: EdgeKind;
  /** 置信度数值（1.0 / 0.6 / 0.2） */
  readonly confidence: number;
  /** 置信度标签（EXTRACTED / AMBIGUOUS / UNRESOLVED） */
  readonly confidenceLabel: EdgeConfidence;
  /** 创建时间（ISO 8601） */
  readonly createdAt: string;
}

/**
 * 爆炸半径查询结果（getExplosionRadius 返回值）
 *
 * 包含受影响符号列表与影响路径详情。
 */
export interface ImpactResult {
  /** 查询的起始符号 ID 列表 */
  readonly sourceSymbolIds: ReadonlyArray<string>;
  /** 受影响符号 ID 列表（BFS 遍历结果，按权重降序） */
  readonly impactedSymbolIds: ReadonlyArray<string>;
  /** 影响路径详情（每条边含 from/to/kind/confidence/depth/weight） */
  readonly paths: ReadonlyArray<Readonly<ImpactPath>>;
  /** 查询耗时（毫秒，用于性能监控 NFR-3） */
  readonly durationMs: number;
}

/**
 * 单条影响路径（BFS 遍历的一条边）
 */
export interface ImpactPath {
  /** 起点符号 ID */
  readonly from: string;
  /** 终点符号 ID */
  readonly to: string;
  /** 边类型 */
  readonly edgeKind: EdgeKind;
  /** 边置信度（1.0 / 0.6 / 0.2） */
  readonly confidence: number;
  /** BFS 深度（0 = 起始节点，1 = 直接依赖，2 = 二级依赖） */
  readonly depth: number;
  /** 深度衰减后的权重 = confidence × 0.6^depth */
  readonly weight: number;
}

/**
 * 图谱统计信息（getStats 返回值）
 *
 * 对齐架构师审查 §4.3 GraphStats 接口。
 */
export interface GraphStats {
  /** 符号总数 */
  readonly totalSymbols: number;
  /** 边总数 */
  readonly totalEdges: number;
  /** 各类型边数量 */
  readonly edgesByKind: Readonly<Record<EdgeKind, number>>;
  /** 各置信度边数量 */
  readonly edgesByConfidence: Readonly<Record<EdgeConfidence, number>>;
  /** 已索引文件数 */
  readonly totalIndexedFiles: number;
  /** 图谱 SQLite 文件大小（字节，用于监控） */
  readonly dbFileSizeBytes: number;
  /** Schema 版本（PRAGMA user_version） */
  readonly schemaVersion: number;
}

// ============================================================================
// 3. Schema DDL 与 PRAGMA 常量（对齐架构师审查 §7.2）
// ============================================================================

/**
 * SQLite PRAGMA 配置（对齐架构师审查 §7.2）
 *
 * - WAL 模式：读写并发 + 崩溃恢复
 * - synchronous=NORMAL：WAL 模式下安全且性能优
 * - foreign_keys=ON：启用外键约束（CASCADE 删除）
 * - cache_size=-64000：64MB 缓存（负值=KB）
 * - temp_store=MEMORY：临时表存内存
 * - mmap_size=268435456：256MB 内存映射
 */
const PRAGMA_CONFIG = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size = -64000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
`.trim();

/**
 * Schema DDL（对齐架构师审查 §7.2 完整定义）
 *
 * 包含：
 * - 6 张核心表：symbols / edges / communities / risk_scores / file_hashes / query_log
 * - FTS5 虚拟表：symbols_fts（外部内容表模式，通过 triggers 同步）
 * - 3 个 triggers：symbols_ai / symbols_ad / symbols_au
 * - 4 类索引：idx_symbols_* / idx_edges_* / idx_risk_* / idx_query_log_*
 *
 * 所有 DDL 使用 IF NOT EXISTS，确保重复执行不报错。
 */
const SCHEMA_DDL = `
-- ============================================================================
-- 表 1：symbols（符号表）
-- ============================================================================
CREATE TABLE IF NOT EXISTS symbols (
    symbol_id       TEXT    PRIMARY KEY,
    name            TEXT    NOT NULL,
    kind            TEXT    NOT NULL CHECK (kind IN ('class','interface','function','method','field','enum','type-alias')),
    file_path       TEXT    NOT NULL,
    line_start      INTEGER NOT NULL CHECK (line_start >= 1),
    line_end        INTEGER NOT NULL CHECK (line_end >= line_start),
    source_hash     TEXT    NOT NULL,
    signature       TEXT,
    summary         TEXT,
    embedding       BLOB,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

-- ============================================================================
-- 表 2：edges（符号边表，4 类边 + 三级置信度）
-- ============================================================================
CREATE TABLE IF NOT EXISTS edges (
    edge_id             INTEGER PRIMARY KEY AUTOINCREMENT,
    source_symbol_id    TEXT    NOT NULL,
    target_symbol_id    TEXT    NOT NULL,
    kind                TEXT    NOT NULL CHECK (kind IN ('CALLS','INHERITS','IMPLEMENTS','TESTED_BY')),
    confidence          REAL    NOT NULL CHECK (confidence IN (1.0, 0.6, 0.2)),
    confidence_label    TEXT    NOT NULL CHECK (confidence_label IN ('EXTRACTED','AMBIGUOUS','UNRESOLVED')),
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (source_symbol_id) REFERENCES symbols(symbol_id) ON DELETE CASCADE,
    FOREIGN KEY (target_symbol_id) REFERENCES symbols(symbol_id) ON DELETE CASCADE,
    UNIQUE (source_symbol_id, target_symbol_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_confidence ON edges(confidence);

-- ============================================================================
-- 表 3：communities（社区聚类结果，Louvain 算法输出）
-- ============================================================================
CREATE TABLE IF NOT EXISTS communities (
    symbol_id           TEXT    PRIMARY KEY,
    community_id        INTEGER NOT NULL,
    modularity_class    REAL    NOT NULL,
    FOREIGN KEY (symbol_id) REFERENCES symbols(symbol_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_communities_id ON communities(community_id);

-- ============================================================================
-- 表 4：risk_scores（6 因子风险评分）
-- ============================================================================
CREATE TABLE IF NOT EXISTS risk_scores (
    symbol_id               TEXT    PRIMARY KEY,
    flow_participation      REAL    NOT NULL CHECK (flow_participation BETWEEN 0 AND 1),
    cross_community_calls   INTEGER NOT NULL CHECK (cross_community_calls >= 0),
    test_coverage           REAL    NOT NULL CHECK (test_coverage BETWEEN 0 AND 1),
    security_keywords       INTEGER NOT NULL CHECK (security_keywords >= 0),
    caller_count            INTEGER NOT NULL CHECK (caller_count >= 0),
    churn                   INTEGER NOT NULL CHECK (churn >= 0),
    total_score             REAL    NOT NULL CHECK (total_score BETWEEN 0 AND 100),
    updated_at              TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (symbol_id) REFERENCES symbols(symbol_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_risk_total ON risk_scores(total_score DESC);
CREATE INDEX IF NOT EXISTS idx_risk_coverage ON risk_scores(test_coverage);

-- ============================================================================
-- 表 5：file_hashes（文件 SHA-256 缓存，增量差分用）
-- ============================================================================
CREATE TABLE IF NOT EXISTS file_hashes (
    file_path           TEXT    PRIMARY KEY,
    sha256              TEXT    NOT NULL,
    last_indexed_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_file_hashes_path ON file_hashes(file_path);

-- ============================================================================
-- 表 6：query_log（查询日志，性能监控与慢查询分析）
-- ============================================================================
CREATE TABLE IF NOT EXISTS query_log (
    log_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    query_type      TEXT    NOT NULL CHECK (query_type IN ('search','impact','risk','flows','stats')),
    query_text      TEXT,
    result_count    INTEGER NOT NULL CHECK (result_count >= 0),
    latency_ms      INTEGER NOT NULL CHECK (latency_ms >= 0),
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_query_log_created ON query_log(created_at);
CREATE INDEX IF NOT EXISTS idx_query_log_type ON query_log(query_type);

-- ============================================================================
-- FTS5 虚拟表：symbols_fts（全文检索，BM25 评分）
-- ============================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
    symbol_id UNINDEXED,
    name,
    signature,
    summary,
    content='symbols',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

-- Triggers：保持 symbols_fts 与 symbols 表同步
CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
    INSERT INTO symbols_fts(symbol_id, name, signature, summary)
    VALUES (new.symbol_id, new.name, new.signature, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
    INSERT INTO symbols_fts(symbols_fts, symbol_id, name, signature, summary)
    VALUES ('delete', old.symbol_id, old.name, old.signature, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
    INSERT INTO symbols_fts(symbols_fts, symbol_id, name, signature, summary)
    VALUES ('delete', old.symbol_id, old.name, old.signature, old.summary);
    INSERT INTO symbols_fts(symbol_id, name, signature, summary)
    VALUES (new.symbol_id, new.name, new.signature, new.summary);
END;
`.trim();

/**
 * 当前 Schema 版本（对齐架构师审查 §7.2 PRAGMA user_version = 1）
 *
 * 后续 schema 升级时递增此版本号，并在 initSchema 中编写迁移逻辑。
 */
const CURRENT_SCHEMA_VERSION = 1 as const;

/**
 * 爆炸半径 BFS 默认参数（对齐架构师审查 §7.3.1）
 *
 * - MAX_DEPTH=2：深度限制防止图过大（起始节点 → 直接依赖 → 二级依赖）
 * - MAX_NODES=500：节点数硬上限（防止图过大导致性能问题）
 * - 深度衰减系数 0.6：每深一层权重乘以 0.6
 * - 权重阈值 0.01：低于此值的路径不再扩展（避免无意义遍历）
 */
const DEFAULT_MAX_DEPTH = 2 as const;
const DEFAULT_MAX_NODES = 500 as const;
const DEPTH_DECAY_FACTOR = 0.6 as const;
const WEIGHT_THRESHOLD = 0.01 as const;

// ============================================================================
// 4. 错误类型
// ============================================================================

/**
 * 符号图谱存储错误类型（字面量联合类型）
 *
 * - unavailable：better-sqlite3 不可用（未安装或 native 模块加载失败）
 * - init-failed：Schema 初始化失败
 * - invalid-argument：参数校验失败
 * - io-failed：底层 SQLite I/O 失败
 * - not-found：查询的符号或边不存在
 */
export type SymbolGraphStoreErrorKind = "unavailable" | "init-failed" | "invalid-argument" | "io-failed" | "not-found";

/**
 * 符号图谱存储错误基类
 *
 * 所有 SymbolGraphStore 相关错误均继承自此基类，
 * 调用方可通过 instanceof SymbolGraphStoreError 统一捕获，
 * 也可通过 err.kind 区分具体错误类型分别处理。
 */
export class SymbolGraphStoreError extends Error {
  /**
   * @param kind 错误类型（SymbolGraphStoreErrorKind 之一）
   * @param detail 错误详情（人类可读）
   */
  constructor(
    public readonly kind: SymbolGraphStoreErrorKind,
    public readonly detail: string
  ) {
    super(`符号图谱存储错误 [${kind}]：${detail}`);
    this.name = "SymbolGraphStoreError";
  }
}

// ============================================================================
// 5. SymbolGraphStore 类
// ============================================================================

/**
 * SymbolGraphStore —— better-sqlite3 符号图谱存储
 *
 * 提供符号级代码图谱的持久化与查询能力，是 EAG-P5 跨会话续跑与符号级偏离检测的核心。
 *
 * 使用方式：
 * ```typescript
 * import { isGraphStoreAvailable, SymbolGraphStore } from "./symbol-graph-store";
 *
 * if (isGraphStoreAvailable()) {
 *   const store = new SymbolGraphStore("/project/.eag/codemap/graph.db");
 *   store.initSchema();
 *   store.addSymbol({ symbolId: "src/A.ts:Foo", name: "Foo", kind: "class", ... });
 *   store.addEdge({ sourceSymbolId: "src/A.ts:Foo", targetSymbolId: "src/B.ts:Bar", kind: "CALLS", confidenceLabel: "EXTRACTED" });
 *   const impact = store.getExplosionRadius(["src/A.ts:Foo"]);
 *   store.close();
 * } else {
 *   // 降级到 P4 既有行为
 * }
 * ```
 *
 * 线程安全：
 * - better-sqlite3 是同步 API，单进程内天然线程安全（无并发竞争）
 * - 多进程访问同一 SQLite 文件需依赖 WAL 模式的并发读 + 文件锁
 *
 * 不可变优先：
 * - 所有返回的对象通过 Object.freeze 冻结
 * - SymbolRecord / EdgeRecord 等接口字段全部 readonly
 */
export class SymbolGraphStore {
  /** SQLite 数据库文件路径（绝对路径） */
  private readonly dbPath: string;
  /** better-sqlite3 Database 实例（initSchema 后非 null） */
  private db: BetterSqlite3Database | null = null;
  /** 是否已初始化 schema（避免重复执行 DDL） */
  private schemaInitialized: boolean = false;

  /**
   * 构造 SymbolGraphStore
   *
   * 注意：构造函数不立即打开数据库连接，需显式调用 initSchema() 完成连接与 schema 初始化。
   * 这样设计的好处是：
   * 1. 构造函数无副作用，便于测试
   * 2. 调用方可控制初始化时机（如先检查 isGraphStoreAvailable() 再构造）
   *
   * @param dbPath SQLite 数据库文件路径（建议为 .eag/codemap/graph.db）
   * @throws {SymbolGraphStoreError} better-sqlite3 不可用时抛出 unavailable 错误
   */
  constructor(dbPath: string) {
    // 校验入参
    if (typeof dbPath !== "string" || dbPath.trim().length === 0) {
      throw new SymbolGraphStoreError("invalid-argument", "dbPath 必须为非空字符串");
    }

    // 校验 better-sqlite3 可用性（三重保障的第 3 重：消费方降级）
    if (!isGraphStoreAvailable()) {
      throw new SymbolGraphStoreError(
        "unavailable",
        "better-sqlite3 不可用（未安装或 native 模块加载失败），请运行 npm run rebuild:sqlite 或降级到 P4 既有行为"
      );
    }

    this.dbPath = dbPath;
    this.schemaInitialized = false;
  }

  /**
   * 初始化数据库连接与 Schema
   *
   * 执行流程：
   * 1. 确保数据库文件所在目录存在（递归创建）
   * 2. 打开 SQLite 连接（如果文件不存在会自动创建）
   * 3. 执行 PRAGMA 配置（WAL 模式 + 缓存 + 外键等）
   * 4. 检查 PRAGMA user_version，若为 0 则执行完整 DDL 并设置 user_version=1
   * 5. 若 user_version 已为当前版本，跳过 DDL（避免重复执行）
   *
   * 幂等性：多次调用 initSchema 安全，schemaInitialized 标志避免重复初始化。
   *
   * @throws {SymbolGraphStoreError} 连接失败或 DDL 执行失败时抛出
   */
  initSchema(): void {
    // 幂等检查：已初始化则直接返回
    if (this.schemaInitialized && this.db !== null) {
      return;
    }

    // 确保数据库文件所在目录存在
    const dbDir = path.dirname(this.dbPath);
    try {
      fs.mkdirSync(dbDir, { recursive: true });
    } catch (err) {
      throw new SymbolGraphStoreError("init-failed", `创建数据库目录失败：${dbDir}（${(err as Error).message}）`);
    }

    // 打开 SQLite 连接（如果文件不存在会自动创建）
    // 保障 3：消费方应通过 isGraphStoreAvailable() 判断后再调用 initSchema，
    // 但此处仍做防御性检查，确保 better-sqlite3 未加载时抛出明确错误（而非 undefined 调用）
    if (betterSqlite3Module === null) {
      throw new SymbolGraphStoreError("unavailable", "better-sqlite3 模块未加载");
    }

    // 使用局部变量 dbCtor 携带非空类型信息，便于 TS 控制流分析
    // （TS 无法跨 if 语句窄化模块级 let 变量，但局部 const 可在 if 后保持窄化）
    const dbCtor: BetterSqlite3Constructor = betterSqlite3Module;
    let dbInstance: BetterSqlite3Database;
    try {
      dbInstance = new dbCtor(this.dbPath);
    } catch (err) {
      throw new SymbolGraphStoreError(
        "init-failed",
        `打开 SQLite 数据库失败：${this.dbPath}（${(err as Error).message}）`
      );
    }

    // 执行 PRAGMA 配置（使用局部变量 dbInstance，TS 可正确推断为非 null）
    try {
      dbInstance.exec(PRAGMA_CONFIG);
    } catch (err) {
      // PRAGMA 失败时关闭已打开的连接，避免资源泄漏
      try {
        dbInstance.close();
      } catch {
        // 关闭失败时忽略，确保原始 PRAGMA 错误不被掩盖
      }
      throw new SymbolGraphStoreError("init-failed", `PRAGMA 配置失败：${(err as Error).message}`);
    }

    // 检查 schema 版本（使用局部变量 dbInstance，TS 可正确推断为非 null）
    const userVersionResult = dbInstance.pragma("user_version", { simple: true }) as number;
    if (userVersionResult === 0) {
      // 全新数据库：执行完整 DDL
      try {
        dbInstance.exec(SCHEMA_DDL);
      } catch (err) {
        try {
          dbInstance.close();
        } catch {
          // 关闭失败时忽略，确保原始 DDL 错误不被掩盖
        }
        throw new SymbolGraphStoreError("init-failed", `Schema DDL 执行失败：${(err as Error).message}`);
      }
      // 设置 schema 版本
      dbInstance.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};`);
    } else if (userVersionResult < CURRENT_SCHEMA_VERSION) {
      // 旧版本数据库：此处暂不实现迁移逻辑（P5 初版仅 user_version=1）
      // 后续升级时在此处添加 ALTER TABLE / 迁移脚本
      try {
        dbInstance.close();
      } catch {
        // 关闭失败时忽略，确保原始版本错误不被掩盖
      }
      throw new SymbolGraphStoreError(
        "init-failed",
        `Schema 版本 ${userVersionResult} 低于当前版本 ${CURRENT_SCHEMA_VERSION}，暂不支持自动迁移`
      );
    }
    // userVersionResult === CURRENT_SCHEMA_VERSION：版本一致，跳过 DDL

    // 所有初始化成功后，将局部变量赋值给实例属性
    this.db = dbInstance;
    this.schemaInitialized = true;
  }

  /**
   * 添加符号到图谱
   *
   * 如果 symbolId 已存在，则更新所有字段（INSERT OR REPLACE 语义）。
   * 写入操作在事务内执行，确保原子性。
   *
   * @param symbol 符号记录
   * @throws {SymbolGraphStoreError} 未初始化或写入失败时抛出
   */
  addSymbol(symbol: SymbolRecord): void {
    this.ensureInitialized();

    // 参数校验
    this.validateSymbolRecord(symbol);

    const sql = `
      INSERT INTO symbols (symbol_id, name, kind, file_path, line_start, line_end, source_hash, signature, summary)
      VALUES (@symbol_id, @name, @kind, @file_path, @line_start, @line_end, @source_hash, @signature, @summary)
      ON CONFLICT(symbol_id) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        file_path = excluded.file_path,
        line_start = excluded.line_start,
        line_end = excluded.line_end,
        source_hash = excluded.source_hash,
        signature = excluded.signature,
        summary = excluded.summary,
        updated_at = datetime('now')
    `;

    const stmt = this.db!.prepare(sql);
    const tx = this.db!.transaction(() => {
      stmt.run({
        symbol_id: symbol.symbolId,
        name: symbol.name,
        kind: symbol.kind,
        file_path: symbol.filePath,
        line_start: symbol.lineStart,
        line_end: symbol.lineEnd,
        source_hash: symbol.sourceHash,
        signature: symbol.signature,
        summary: symbol.summary,
      });
    });
    tx();
  }

  /**
   * 批量添加符号（事务原子写入）
   *
   * 在单个事务内批量插入，性能优于逐条 addSymbol。
   *
   * @param symbols 符号记录列表
   * @throws {SymbolGraphStoreError} 未初始化或写入失败时抛出
   */
  addSymbols(symbols: ReadonlyArray<SymbolRecord>): void {
    this.ensureInitialized();

    if (symbols.length === 0) {
      return;
    }

    // 预校验全部符号（避免部分写入后失败导致数据不一致）
    for (const symbol of symbols) {
      this.validateSymbolRecord(symbol);
    }

    const sql = `
      INSERT INTO symbols (symbol_id, name, kind, file_path, line_start, line_end, source_hash, signature, summary)
      VALUES (@symbol_id, @name, @kind, @file_path, @line_start, @line_end, @source_hash, @signature, @summary)
      ON CONFLICT(symbol_id) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        file_path = excluded.file_path,
        line_start = excluded.line_start,
        line_end = excluded.line_end,
        source_hash = excluded.source_hash,
        signature = excluded.signature,
        summary = excluded.summary,
        updated_at = datetime('now')
    `;

    const stmt = this.db!.prepare(sql);
    const tx = this.db!.transaction(() => {
      for (const symbol of symbols) {
        stmt.run({
          symbol_id: symbol.symbolId,
          name: symbol.name,
          kind: symbol.kind,
          file_path: symbol.filePath,
          line_start: symbol.lineStart,
          line_end: symbol.lineEnd,
          source_hash: symbol.sourceHash,
          signature: symbol.signature,
          summary: symbol.summary,
        });
      }
    });
    tx();
  }

  /**
   * 添加边到图谱
   *
   * 如果 (source_symbol_id, target_symbol_id, kind) 组合已存在，则更新置信度（INSERT OR REPLACE 语义）。
   * source_symbol_id 和 target_symbol_id 必须已存在于 symbols 表中（外键约束）。
   *
   * @param sourceSymbolId 源符号 ID
   * @param targetSymbolId 目标符号 ID
   * @param kind 边类型（CALLS / INHERITS / IMPLEMENTS / TESTED_BY）
   * @param confidenceLabel 置信度标签（EXTRACTED / AMBIGUOUS / UNRESOLVED）
   * @throws {SymbolGraphStoreError} 未初始化、参数非法或写入失败时抛出
   */
  addEdge(sourceSymbolId: string, targetSymbolId: string, kind: EdgeKind, confidenceLabel: EdgeConfidence): void {
    this.ensureInitialized();

    // 参数校验
    if (typeof sourceSymbolId !== "string" || sourceSymbolId.trim().length === 0) {
      throw new SymbolGraphStoreError("invalid-argument", "sourceSymbolId 必须为非空字符串");
    }
    if (typeof targetSymbolId !== "string" || targetSymbolId.trim().length === 0) {
      throw new SymbolGraphStoreError("invalid-argument", "targetSymbolId 必须为非空字符串");
    }

    const confidence = CONFIDENCE_VALUE_MAP[confidenceLabel];

    const sql = `
      INSERT INTO edges (source_symbol_id, target_symbol_id, kind, confidence, confidence_label)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_symbol_id, target_symbol_id, kind) DO UPDATE SET
        confidence = excluded.confidence,
        confidence_label = excluded.confidence_label
    `;

    const stmt = this.db!.prepare(sql);
    const tx = this.db!.transaction(() => {
      stmt.run(sourceSymbolId, targetSymbolId, kind, confidence, confidenceLabel);
    });
    tx();
  }

  /**
   * 批量添加边（事务原子写入）
   *
   * @param edges 边数据列表（不含 edgeId 和 createdAt，由数据库自动生成）
   * @throws {SymbolGraphStoreError} 未初始化或写入失败时抛出
   */
  addEdges(
    edges: ReadonlyArray<{
      readonly sourceSymbolId: string;
      readonly targetSymbolId: string;
      readonly kind: EdgeKind;
      readonly confidenceLabel: EdgeConfidence;
    }>
  ): void {
    this.ensureInitialized();

    if (edges.length === 0) {
      return;
    }

    const sql = `
      INSERT INTO edges (source_symbol_id, target_symbol_id, kind, confidence, confidence_label)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_symbol_id, target_symbol_id, kind) DO UPDATE SET
        confidence = excluded.confidence,
        confidence_label = excluded.confidence_label
    `;

    const stmt = this.db!.prepare(sql);
    const tx = this.db!.transaction(() => {
      for (const edge of edges) {
        const confidence = CONFIDENCE_VALUE_MAP[edge.confidenceLabel];
        stmt.run(edge.sourceSymbolId, edge.targetSymbolId, edge.kind, confidence, edge.confidenceLabel);
      }
    });
    tx();
  }

  /**
   * 按符号名查询（FTS5 全文检索）
   *
   * 使用 FTS5 BM25 评分排序，支持模糊匹配。
   *
   * @param name 查询的符号名（支持 FTS5 MATCH 语法，如 "User*" 前缀匹配）
   * @param limit 返回数上限（默认 20）
   * @returns 符号记录列表（按 BM25 相关性降序）
   */
  queryByName(name: string, limit: number = 20): ReadonlyArray<SymbolRecord> {
    this.ensureInitialized();

    if (typeof name !== "string" || name.trim().length === 0) {
      return Object.freeze([]);
    }

    // FTS5 MATCH 查询：将查询字符串中的特殊字符转义为 FTS5 字符串字面量
    // 用双引号包裹查询字符串，避免 FTS5 把 PascalCase 拆分为多个 token
    const ftsQuery = `"${name.replace(/"/g, '""')}"`;

    const sql = `
      SELECT s.symbol_id, s.name, s.kind, s.file_path, s.line_start, s.line_end, s.source_hash, s.signature, s.summary
      FROM symbols_fts fts
      JOIN symbols s ON s.rowid = fts.rowid
      WHERE symbols_fts MATCH ?
      ORDER BY bm25(symbols_fts)
      LIMIT ?
    `;

    const stmt = this.db!.prepare(sql);
    const rows = stmt.all(ftsQuery, limit) as Array<{
      symbol_id: string;
      name: string;
      kind: SymbolKind;
      file_path: string;
      line_start: number;
      line_end: number;
      source_hash: string;
      signature: string | null;
      summary: string | null;
    }>;

    return Object.freeze(
      rows.map(
        (row) =>
          Object.freeze({
            symbolId: row.symbol_id,
            name: row.name,
            kind: row.kind,
            filePath: row.file_path,
            lineStart: row.line_start,
            lineEnd: row.line_end,
            sourceHash: row.source_hash,
            signature: row.signature ?? "",
            summary: row.summary ?? "",
          }) as SymbolRecord
      )
    );
  }

  /**
   * 按符号类型查询
   *
   * 使用 idx_symbols_kind 索引加速查询。
   *
   * @param kind 符号类型
   * @param limit 返回数上限（默认 100）
   * @returns 符号记录列表
   */
  queryByKind(kind: SymbolKind, limit: number = 100): ReadonlyArray<SymbolRecord> {
    this.ensureInitialized();

    const sql = `
      SELECT symbol_id, name, kind, file_path, line_start, line_end, source_hash, signature, summary
      FROM symbols
      WHERE kind = ?
      LIMIT ?
    `;

    const stmt = this.db!.prepare(sql);
    const rows = stmt.all(kind, limit) as Array<{
      symbol_id: string;
      name: string;
      kind: SymbolKind;
      file_path: string;
      line_start: number;
      line_end: number;
      source_hash: string;
      signature: string | null;
      summary: string | null;
    }>;

    return Object.freeze(
      rows.map(
        (row) =>
          Object.freeze({
            symbolId: row.symbol_id,
            name: row.name,
            kind: row.kind,
            filePath: row.file_path,
            lineStart: row.line_start,
            lineEnd: row.line_end,
            sourceHash: row.source_hash,
            signature: row.signature ?? "",
            summary: row.summary ?? "",
          }) as SymbolRecord
      )
    );
  }

  /**
   * 查询符号的边（出边或入边）
   *
   * 使用 idx_edges_source 或 idx_edges_target 索引加速查询。
   *
   * @param symbolId 符号 ID
   * @param direction 方向（"outgoing"=出边，"incoming"=入边，"both"=双向，默认 "both"）
   * @param kindFilter 边类型过滤（可选，不传则返回所有类型）
   * @returns 边记录列表
   */
  getEdges(
    symbolId: string,
    direction: "outgoing" | "incoming" | "both" = "both",
    kindFilter?: EdgeKind
  ): ReadonlyArray<EdgeRecord> {
    this.ensureInitialized();

    if (typeof symbolId !== "string" || symbolId.trim().length === 0) {
      return Object.freeze([]);
    }

    // 构建 SQL（根据 direction 和 kindFilter 动态拼接 WHERE 子句）
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (direction === "outgoing") {
      conditions.push("source_symbol_id = ?");
      params.push(symbolId);
    } else if (direction === "incoming") {
      conditions.push("target_symbol_id = ?");
      params.push(symbolId);
    } else {
      // both：出边或入边
      conditions.push("(source_symbol_id = ? OR target_symbol_id = ?)");
      params.push(symbolId, symbolId);
    }

    if (kindFilter !== undefined) {
      conditions.push("kind = ?");
      params.push(kindFilter);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT edge_id, source_symbol_id, target_symbol_id, kind, confidence, confidence_label, created_at
      FROM edges
      ${whereClause}
      ORDER BY edge_id
    `;

    const stmt = this.db!.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      edge_id: number;
      source_symbol_id: string;
      target_symbol_id: string;
      kind: EdgeKind;
      confidence: number;
      confidence_label: EdgeConfidence;
      created_at: string;
    }>;

    return Object.freeze(
      rows.map(
        (row) =>
          Object.freeze({
            edgeId: row.edge_id,
            sourceSymbolId: row.source_symbol_id,
            targetSymbolId: row.target_symbol_id,
            kind: row.kind,
            confidence: row.confidence,
            confidenceLabel: row.confidence_label,
            createdAt: row.created_at,
          }) as EdgeRecord
      )
    );
  }

  /**
   * 爆炸半径查询（有界最优分数松弛 BFS，对齐架构师审查 §7.3.1）
   *
   * 算法：
   * 1. 从起始符号出发，反向遍历 edges 表（找谁调用了起始符号）
   * 2. 边权重 = confidence × 0.6^depth（深度衰减）
   * 3. 深度限制 MAX_DEPTH=2，节点数限制 MAX_NODES=500
   * 4. 权重阈值 0.01（低于此值不再扩展）
   *
   * 实现方式：SQLite 递归 CTE（Common Table Expression）
   *
   * @param sourceSymbolIds 起始符号 ID 列表
   * @param maxDepth 最大深度（默认 2）
   * @param maxNodes 最大节点数（默认 500）
   * @returns 爆炸半径查询结果（含受影响符号列表与路径详情）
   */
  getExplosionRadius(
    sourceSymbolIds: ReadonlyArray<string>,
    maxDepth: number = DEFAULT_MAX_DEPTH,
    maxNodes: number = DEFAULT_MAX_NODES
  ): Readonly<ImpactResult> {
    this.ensureInitialized();

    // 参数校验
    if (sourceSymbolIds.length === 0) {
      return Object.freeze({
        sourceSymbolIds: Object.freeze([]),
        impactedSymbolIds: Object.freeze([]),
        paths: Object.freeze([]),
        durationMs: 0,
      }) as ImpactResult;
    }

    if (maxDepth < 1 || maxDepth > 10) {
      throw new SymbolGraphStoreError("invalid-argument", `maxDepth 必须在 1~10 之间，实际值：${maxDepth}`);
    }
    if (maxNodes < 1 || maxNodes > 5000) {
      throw new SymbolGraphStoreError("invalid-argument", `maxNodes 必须在 1~5000 之间，实际值：${maxNodes}`);
    }

    const startTime = Date.now();

    // 构建递归 CTE SQL（对齐架构师审查 §7.3.1）
    // 动态生成 IN 子句的参数占位符
    const placeholders = sourceSymbolIds.map(() => "?").join(",");

    // 第一阶段：递归 CTE 遍历，收集所有受影响符号及其路径
    const cteSql = `
      WITH RECURSIVE impact_bfs(symbol_id, depth, weight, path, parent_symbol_id, edge_kind, edge_confidence) AS (
        -- 起始节点（depth=0，weight=1.0）
        SELECT symbol_id, 0, 1.0, symbol_id, NULL, NULL, NULL
        FROM symbols
        WHERE symbol_id IN (${placeholders})

        UNION ALL

        -- 反向遍历：找谁调用了当前符号（edges.target = current.symbol_id）
        SELECT
          e.source_symbol_id,
          b.depth + 1,
          b.weight * e.confidence * ${DEPTH_DECAY_FACTOR},
          b.path || '->' || e.source_symbol_id,
          b.symbol_id,
          e.kind,
          e.confidence
        FROM impact_bfs b
        JOIN edges e ON e.target_symbol_id = b.symbol_id
        WHERE b.depth < ?
          AND b.weight * e.confidence * ${DEPTH_DECAY_FACTOR} > ${WEIGHT_THRESHOLD}
      )
      SELECT
        symbol_id,
        depth,
        weight,
        path,
        parent_symbol_id,
        edge_kind,
        edge_confidence
      FROM impact_bfs
      ORDER BY weight DESC
      LIMIT ?
    `;

    const cteStmt = this.db!.prepare(cteSql);
    const cteParams: unknown[] = [...sourceSymbolIds, maxDepth, maxNodes];
    const cteRows = cteStmt.all(...cteParams) as Array<{
      symbol_id: string;
      depth: number;
      weight: number;
      path: string;
      parent_symbol_id: string | null;
      edge_kind: EdgeKind | null;
      edge_confidence: number | null;
    }>;

    // 构建受影响符号 ID 列表（去重，保留首次出现的顺序）
    const impactedSet = new Set<string>();
    const impactedList: string[] = [];
    for (const row of cteRows) {
      if (!impactedSet.has(row.symbol_id)) {
        impactedSet.add(row.symbol_id);
        impactedList.push(row.symbol_id);
      }
    }

    // 构建路径详情列表（仅包含有 parent 的行，即非起始节点的边）
    const paths: ImpactPath[] = [];
    for (const row of cteRows) {
      if (row.parent_symbol_id !== null && row.edge_kind !== null && row.edge_confidence !== null) {
        paths.push(
          Object.freeze({
            from: row.parent_symbol_id,
            to: row.symbol_id,
            edgeKind: row.edge_kind,
            confidence: row.edge_confidence,
            depth: row.depth,
            weight: row.weight,
          }) as ImpactPath
        );
      }
    }

    const durationMs = Date.now() - startTime;

    return Object.freeze({
      sourceSymbolIds: Object.freeze([...sourceSymbolIds]),
      impactedSymbolIds: Object.freeze(impactedList),
      paths: Object.freeze(paths),
      durationMs,
    }) as ImpactResult;
  }

  /**
   * 获取图谱统计信息
   *
   * 返回符号总数、边总数、各类型边数量、各置信度边数量、
   * 已索引文件数、SQLite 文件大小、schema 版本。
   *
   * @returns 图谱统计信息（冻结对象）
   */
  getStats(): Readonly<GraphStats> {
    this.ensureInitialized();

    // 查询符号总数
    const symbolCountRow = this.db!.prepare("SELECT COUNT(*) AS cnt FROM symbols").get() as { cnt: number };
    const totalSymbols = symbolCountRow.cnt;

    // 查询边总数
    const edgeCountRow = this.db!.prepare("SELECT COUNT(*) AS cnt FROM edges").get() as { cnt: number };
    const totalEdges = edgeCountRow.cnt;

    // 查询各类型边数量
    const edgesByKindRows = this.db!.prepare("SELECT kind, COUNT(*) AS cnt FROM edges GROUP BY kind").all() as Array<{
      kind: EdgeKind;
      cnt: number;
    }>;
    const edgesByKind: Record<EdgeKind, number> = {
      CALLS: 0,
      INHERITS: 0,
      IMPLEMENTS: 0,
      TESTED_BY: 0,
    };
    for (const row of edgesByKindRows) {
      edgesByKind[row.kind] = row.cnt;
    }

    // 查询各置信度边数量
    const edgesByConfidenceRows = this.db!.prepare(
      "SELECT confidence_label, COUNT(*) AS cnt FROM edges GROUP BY confidence_label"
    ).all() as Array<{ confidence_label: EdgeConfidence; cnt: number }>;
    const edgesByConfidence: Record<EdgeConfidence, number> = {
      EXTRACTED: 0,
      AMBIGUOUS: 0,
      UNRESOLVED: 0,
    };
    for (const row of edgesByConfidenceRows) {
      edgesByConfidence[row.confidence_label] = row.cnt;
    }

    // 查询已索引文件数（file_hashes 表的行数）
    const fileCountRow = this.db!.prepare("SELECT COUNT(*) AS cnt FROM file_hashes").get() as { cnt: number };
    const totalIndexedFiles = fileCountRow.cnt;

    // 查询 schema 版本
    const schemaVersion = this.db!.pragma("user_version", { simple: true }) as number;

    // 获取 SQLite 文件大小（字节）
    let dbFileSizeBytes = 0;
    try {
      const stat = fs.statSync(this.dbPath);
      dbFileSizeBytes = stat.size;
    } catch {
      // 文件不存在或无法访问时返回 0
      dbFileSizeBytes = 0;
    }

    return Object.freeze({
      totalSymbols,
      totalEdges,
      edgesByKind: Object.freeze(edgesByKind),
      edgesByConfidence: Object.freeze(edgesByConfidence),
      totalIndexedFiles,
      dbFileSizeBytes,
      schemaVersion,
    }) as GraphStats;
  }

  /**
   * 更新文件哈希缓存（file_hashes 表）
   *
   * 用于增量更新场景：比对文件 SHA-256，未变更则跳过重新解析。
   *
   * @param filePath 文件相对路径
   * @param sha256 文件 SHA-256 哈希值
   */
  updateFileHash(filePath: string, sha256: string): void {
    this.ensureInitialized();

    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new SymbolGraphStoreError("invalid-argument", "filePath 必须为非空字符串");
    }
    if (typeof sha256 !== "string" || sha256.trim().length === 0) {
      throw new SymbolGraphStoreError("invalid-argument", "sha256 必须为非空字符串");
    }

    const sql = `
      INSERT INTO file_hashes (file_path, sha256, last_indexed_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(file_path) DO UPDATE SET
        sha256 = excluded.sha256,
        last_indexed_at = datetime('now')
    `;

    const stmt = this.db!.prepare(sql);
    stmt.run(filePath, sha256);
  }

  /**
   * 查询文件哈希缓存
   *
   * @param filePath 文件相对路径
   * @returns SHA-256 哈希值（不存在返回 null）
   */
  getFileHash(filePath: string): string | null {
    this.ensureInitialized();

    const sql = "SELECT sha256 FROM file_hashes WHERE file_path = ?";
    const row = this.db!.prepare(sql).get(filePath) as { sha256: string } | undefined;
    return row?.sha256 ?? null;
  }

  /**
   * 删除指定文件的全部符号（CASCADE 级联删除关联 edges）
   *
   * 用于增量更新场景：删除变更文件的旧符号后重新解析。
   *
   * @param filePath 文件相对路径
   * @returns 删除的符号数量
   */
  removeSymbolsByFile(filePath: string): number {
    this.ensureInitialized();

    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      return 0;
    }

    const sql = "DELETE FROM symbols WHERE file_path = ?";
    const result = this.db!.prepare(sql).run(filePath) as BetterSqlite3RunResult;
    return result.changes;
  }

  /**
   * 关闭数据库连接
   *
   * 关闭后不可再调用任何方法（除 isGraphStoreAvailable）。
   * 幂等：多次调用 close 安全。
   */
  close(): void {
    if (this.db !== null) {
      try {
        this.db.close();
      } catch {
        // 关闭失败时忽略（可能已关闭），确保不阻塞调用方
      }
      this.db = null;
      this.schemaInitialized = false;
    }
  }

  // ============================ 私有辅助方法 ============================

  /**
   * 确保数据库已初始化
   *
   * 所有公共方法在执行前调用此方法，确保 initSchema 已完成。
   *
   * @throws {SymbolGraphStoreError} 未初始化时抛出
   */
  private ensureInitialized(): void {
    if (this.db === null || !this.schemaInitialized) {
      throw new SymbolGraphStoreError("init-failed", "SymbolGraphStore 未初始化，请先调用 initSchema()");
    }
  }

  /**
   * 校验 SymbolRecord 字段合法性
   *
   * @param symbol 待校验的符号记录
   * @throws {SymbolGraphStoreError} 校验失败时抛出
   */
  private validateSymbolRecord(symbol: SymbolRecord): void {
    if (typeof symbol.symbolId !== "string" || symbol.symbolId.trim().length === 0) {
      throw new SymbolGraphStoreError("invalid-argument", "symbol.symbolId 必须为非空字符串");
    }
    if (typeof symbol.name !== "string" || symbol.name.trim().length === 0) {
      throw new SymbolGraphStoreError("invalid-argument", "symbol.name 必须为非空字符串");
    }
    if (typeof symbol.filePath !== "string" || symbol.filePath.trim().length === 0) {
      throw new SymbolGraphStoreError("invalid-argument", "symbol.filePath 必须为非空字符串");
    }
    if (!Number.isInteger(symbol.lineStart) || symbol.lineStart < 1) {
      throw new SymbolGraphStoreError(
        "invalid-argument",
        `symbol.lineStart 必须为 >= 1 的整数，实际值：${symbol.lineStart}`
      );
    }
    if (!Number.isInteger(symbol.lineEnd) || symbol.lineEnd < symbol.lineStart) {
      throw new SymbolGraphStoreError(
        "invalid-argument",
        `symbol.lineEnd 必须为 >= lineStart(${symbol.lineStart}) 的整数，实际值：${symbol.lineEnd}`
      );
    }
    if (typeof symbol.sourceHash !== "string" || symbol.sourceHash.trim().length === 0) {
      throw new SymbolGraphStoreError("invalid-argument", "symbol.sourceHash 必须为非空字符串");
    }
  }
}

// ============================================================================
// 6. 工具函数
// ============================================================================

/**
 * 计算字符串的 SHA-256 哈希值（用于 sourceHash 字段）
 *
 * @param content 待哈希的字符串内容
 * @returns SHA-256 十六进制哈希值（64 字符）
 */
export function computeSha256(content: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(content, "utf-8");
  return hash.digest("hex");
}

/**
 * 生成符号 ID（格式：filePath:fullyQualifiedName）
 *
 * @param filePath 文件相对路径
 * @param name 符号名
 * @param lineStart 起始行号（可选，用于消歧同名符号）
 * @returns 符号 ID
 */
export function generateSymbolId(filePath: string, name: string, lineStart?: number): string {
  if (lineStart !== undefined && lineStart > 0) {
    return `${filePath}:${name}:${lineStart}`;
  }
  return `${filePath}:${name}`;
}
