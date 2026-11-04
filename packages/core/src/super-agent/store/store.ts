/**
 * Super Agent 持久层 —— SQLite 事实来源
 *
 * ## 核心不变量（I2：事务与副作用严格分离）
 *
 * - **Store 是唯一持有 SQLite 连接的角色**。领域层永远拿不到连接。
 * - **`atomic(fn)`**：fn 内的所有写入在**同一个事务**里；fn 抛错 → 整体回滚。
 * - **`afterCommit(fn)`**：外部副作用（启动 Worker、投递消息）登记在此，
 *   **只在事务成功提交后**才执行。事务回滚 → 副作用不发生。
 *   这是「不出现「事务回滚了但 Worker 已经启动」这类幽灵状态」的唯一保证。
 *
 * ## 诚实降级（D2）
 *
 * `node:sqlite` 需要 Node ≥ 22.13。不可用时 **启动即报错退出**，
 * 给出明确升级命令——**绝不用内存假 Store 冒充持久化**。
 *
 * @module super-agent/store/store
 */

import * as path from "node:path";
import { runMigrations, SCHEMA_VERSION } from "./schema.js";

// ============================================================================
// node:sqlite 最小类型声明
// ============================================================================

/** node:sqlite 的最小结构（避免依赖 @types/node 的实验性类型） */
interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

/** Store 构造选项 */
export interface StoreOptions {
  /** 数据库文件路径（绝对路径） */
  readonly databasePath: string;
  /** 当前时间提供者（测试可注入固定时钟） */
  readonly now?: () => Date;
}

/** 事务内可用的句柄 */
export interface StoreTx {
  /** 执行多语句 SQL */
  exec(sql: string): void;
  /** 准备语句 */
  prepare(sql: string): SqliteStatement;
  /** 在事务内登记「提交后执行」的副作用 */
  afterCommit(fn: () => void): void;
}

/**
 * 判断 `node:sqlite` 是否可用
 *
 * @returns 可用返回 true；不可用返回 false
 */
export async function isSqliteAvailable(): Promise<boolean> {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

/**
 * 打开 Super Agent 持久层
 *
 * @param options 构造选项
 * @returns 已完成迁移的 Store 实例
 * @throws {Error} `node:sqlite` 不可用 / 版本高于实现 / 迁移链不完整
 */
export async function openStore(options: StoreOptions): Promise<Store> {
  let sqlite: NodeSqliteModule;
  try {
    // 动态 import：node:sqlite 为 Node 22.13+ 内置模块，esbuild 对 node: 前缀保持 external
    sqlite = (await import("node:sqlite")) as unknown as NodeSqliteModule;
  } catch {
    throw new Error(
      "Super Agent 需要 Node.js ≥ 22.13（内置 node:sqlite 模块）。" +
        "当前运行时不支持 node:sqlite，请升级 Node 后重试。" +
        "（本项目不会用内存假 Store 冒充持久化——领域状态丢失的代价高于功能不可用。）"
    );
  }

  const dbPath = path.resolve(options.databasePath);
  const db = new sqlite.DatabaseSync(dbPath);

  // WAL + busy_timeout：并发读不阻塞写，多进程写冲突时自动等待而非立即报错
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA foreign_keys = ON;");
  } catch {
    // WAL 在某些文件系统（如部分网络盘）不可用——降级为默认日志模式，不阻断启动
  }

  const currentVersion = readUserVersion(db);
  runMigrations((sql) => db.exec(sql), currentVersion);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);

  return new Store(db, dbPath, options.now ?? (() => new Date()));
}

/** 读取当前 schema 版本 */
function readUserVersion(db: SqliteDatabase): number {
  try {
    const rows = db.prepare("PRAGMA user_version;").all() as Array<Record<string, unknown>>;
    const raw = rows[0]?.["user_version"];
    return typeof raw === "number" ? raw : Number(raw ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Store —— Super Agent 的唯一持久层入口
 *
 * 领域层通过它读写状态；**拿不到底层连接**（除 `prepare` 外的全部能力都经由
 * `atomic` / `afterCommit` 约束）。
 */
export class Store {
  /** 底层连接（仅本类内部使用） */
  private readonly db: SqliteDatabase;
  /** 数据库文件路径 */
  readonly databasePath: string;
  /** 当前时间提供者 */
  private readonly nowFn: () => Date;
  /** 事务提交后待执行的副作用 */
  private afterCommitQueue: Array<() => void> = [];
  /** 事务深度（支持嵌套调用，内层复用外层事务） */
  private txDepth = 0;
  /** 是否已关闭 */
  private closed = false;

  /**
   * 构造 Store
   *
   * @param db 底层连接
   * @param databasePath 数据库文件路径
   * @param nowFn 当前时间提供者
   */
  constructor(db: SqliteDatabase, databasePath: string, nowFn: () => Date) {
    this.db = db;
    this.databasePath = databasePath;
    this.nowFn = nowFn;
  }

  /** 当前时间（ISO 8601） */
  now(): string {
    return this.nowFn().toISOString();
  }

  /**
   * 在事务中执行一组写入
   *
   * 嵌套调用时内层不新开事务（SQLite 不支持嵌套 BEGIN），
   * 但 `afterCommit` 仍只在**最外层**提交后执行。
   *
   * @param fn 事务体；返回值原样透出
   * @returns fn 的返回值
   */
  atomic<T>(fn: (tx: StoreTx) => T): T {
    if (this.closed) throw new Error("Store 已关闭，无法执行事务。");
    if (this.txDepth > 0) {
      // 已在事务中：复用外层事务，副作用仍挂到最外层的队列
      this.txDepth += 1;
      try {
        return fn(this.tx);
      } finally {
        this.txDepth -= 1;
      }
    }

    const queue: Array<() => void> = [];
    this.db.exec("BEGIN IMMEDIATE;");
    this.txDepth = 1;
    this.afterCommitQueue = queue;
    try {
      const result = fn(this.tx);
      this.db.exec("COMMIT;");
      this.txDepth = 0;
      this.afterCommitQueue = [];
      // 提交成功后执行副作用；单个副作用抛错不影响已提交的数据
      for (const effect of queue) {
        try {
          effect();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[super-agent] 提交后副作用执行失败: ${message}`);
        }
      }
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // 回滚失败说明连接已不可用——原异常更有价值，不再覆盖
      }
      this.txDepth = 0;
      this.afterCommitQueue = [];
      throw error;
    }
  }

  /** 事务句柄（供 atomic 内部使用） */
  private get tx(): StoreTx {
    return {
      exec: (sql: string) => this.db.exec(sql),
      prepare: (sql: string) => this.db.prepare(sql),
      afterCommit: (fn: () => void) => {
        this.afterCommitQueue.push(fn);
      },
    };
  }

  /**
   * 只读查询（**永不写状态**）
   *
   * @param sql 查询语句
   * @param params 绑定参数
   * @returns 行数组
   */
  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    if (this.closed) throw new Error("Store 已关闭，无法查询。");
    return this.db.prepare(sql).all(...params) as T[];
  }

  /**
   * 只读单行查询
   *
   * @param sql 查询语句
   * @param params 绑定参数
   * @returns 行或 undefined
   */
  queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    if (this.closed) throw new Error("Store 已关闭，无法查询。");
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  /**
   * 在事务中执行写入
   *
   * @param fn 事务体
   * @returns fn 的返回值
   */
  write<T>(fn: (tx: StoreTx) => T): T {
    return this.atomic(fn);
  }

  /** 关闭连接 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // 连接已断开——关闭失败不影响进程退出
    }
  }
}

/**
 * 把布尔值转成 SQLite 可存储的整数
 *
 * `node:sqlite` 不接受 JS boolean 绑定，必须显式转换。
 *
 * @param value 布尔值
 * @returns 0 或 1
 */
export function toSqliteInt(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * 把 SQLite 整数转回布尔值
 *
 * @param value 整数
 * @returns 布尔值
 */
export function fromSqliteInt(value: unknown): boolean {
  return value === 1 || value === "1" || value === true;
}
