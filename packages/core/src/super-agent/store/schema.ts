/**
 * Super Agent 持久层 schema 与迁移
 *
 * ## 为什么用 `node:sqlite` 而不是 `better-sqlite3`
 *
 * 评审实测结论（见 `docs/proposals/super-agent/consensus-report.md` C1）：
 *
 * 1. `better-sqlite3` 是原生模块，**本机 binding 是 Linux ELF 而宿主是 darwin arm64**，
 *    `require` 必崩 `ERR_DLOPEN_FAILED`；
 * 2. CLI 走 esbuild 打包（`scripts/esbuild.config.js:31` 仅 `external: ["sharp"]`），
 *    原生模块会被打进 bundle 导致路径失效；
 * 3. CI 矩阵是 3 OS × Node 22/24，`better-sqlite3@^11` 没有 node-v137（Node 24）prebuild，
 *    会回落到 node-gyp 源码编译。
 *
 * `node:sqlite` 是 **Node 22.13+ 内置模块**，零新增依赖、零原生编译。
 * 本仓已有先例：`packages/web/src/server.ts:676` 的 `await import("node:sqlite")`。
 *
 * ## 迁移策略
 *
 * - 版本记录在 `PRAGMA user_version`（SQLite 内建，无额外表）。
 * - **只增**：迁移函数按版本号顺序执行。
 * - 版本 > 当前实现 → **拒绝启动**（明确报错，不静默重建，避免丢领域状态）。
 * - 版本 < 当前 → 依次执行迁移脚本。
 *
 * @module super-agent/store/schema
 */

/** 当前 schema 版本（只增） */
export const SCHEMA_VERSION = 2;

/**
 * 迁移脚本表
 *
 * key = 迁移后达到的版本号；value = 该迁移的 SQL 批次。
 */
export const MIGRATIONS: ReadonlyMap<number, string> = new Map([
  [
    1,
    `
CREATE TABLE IF NOT EXISTS trigger (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  addressed INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS trigger_idem ON trigger(source_id, idempotency_key);
CREATE INDEX IF NOT EXISTS trigger_source ON trigger(source_id, created_at);

CREATE TABLE IF NOT EXISTS thread (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS thread_active ON thread(active);

CREATE TABLE IF NOT EXISTS trigger_thread (
  trigger_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (trigger_id, thread_id)
);
CREATE INDEX IF NOT EXISTS trigger_thread_thread ON trigger_thread(thread_id);

CREATE TABLE IF NOT EXISTS disposition (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS disposition_trigger ON disposition(trigger_id);

CREATE TABLE IF NOT EXISTS ticket (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  origin TEXT NOT NULL,
  mandate TEXT NOT NULL,
  execution TEXT NOT NULL,
  latest_report TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  ended_by TEXT,
  ended_reason TEXT
);
CREATE INDEX IF NOT EXISTS ticket_state ON ticket(state);
CREATE INDEX IF NOT EXISTS ticket_created ON ticket(created_at);

CREATE TABLE IF NOT EXISTS assignment (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  state TEXT NOT NULL,
  worker_session_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  report TEXT
);
CREATE INDEX IF NOT EXISTS assignment_ticket ON assignment(ticket_id);

CREATE TABLE IF NOT EXISTS subscription (
  ticket_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  own INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ticket_id, thread_id)
);
CREATE INDEX IF NOT EXISTS subscription_thread ON subscription(thread_id);

CREATE TABLE IF NOT EXISTS ticket_input (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_input_ticket ON ticket_input(ticket_id, delivered_at);

CREATE TABLE IF NOT EXISTS decision (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  strength TEXT NOT NULL,
  reason TEXT NOT NULL,
  would_accept INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread_id, at);

CREATE TABLE IF NOT EXISTS eval_state (
  thread_id TEXT PRIMARY KEY,
  batch TEXT NOT NULL,
  deadline_at TEXT,
  candidate_delivered INTEGER NOT NULL DEFAULT 0,
  expired_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS effect (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  payload TEXT NOT NULL,
  due_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE (kind, key)
);
CREATE INDEX IF NOT EXISTS effect_due ON effect(due_at);

CREATE TABLE IF NOT EXISTS ticket_message (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_message_ticket ON ticket_message(ticket_id, state);

CREATE TABLE IF NOT EXISTS attention (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  blocking INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS attention_ticket ON attention(ticket_id, resolved_at);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`,
  ],
  // v2（2026-11-04）：动态计划层
  //
  // 只新增两张表，**不改动任何既有表**——v1 的库可以直接升级，
  // 升级后旧工单没有计划行，执行语义自动回到「一单一角色」。
  [
    2,
    `
CREATE TABLE IF NOT EXISTS ticket_plan (
  ticket_id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  strategy TEXT NOT NULL,
  source TEXT NOT NULL,
  plan TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_step (
  ticket_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  wave INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  role TEXT NOT NULL,
  assignment_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  summary TEXT,
  PRIMARY KEY (ticket_id, step_id)
);
CREATE INDEX IF NOT EXISTS plan_step_ticket ON plan_step(ticket_id, wave);
CREATE INDEX IF NOT EXISTS plan_step_assignment ON plan_step(assignment_id);
`,
  ],
]);

/**
 * 执行迁移到目标版本
 *
 * @param exec SQL 执行器（由 Store 注入）
 * @param currentVersion 库中当前版本
 * @param targetVersion 目标版本（默认 {@link SCHEMA_VERSION}）
 * @returns 实际应用的迁移版本列表（空数组表示已是最新）
 * @throws {Error} 当前版本高于目标版本（拒绝启动，不静默重建）
 */
export function runMigrations(
  exec: (sql: string) => void,
  currentVersion: number,
  targetVersion: number = SCHEMA_VERSION
): number[] {
  if (currentVersion > targetVersion) {
    throw new Error(
      `Super Agent 数据库版本 ${currentVersion} 高于当前实现支持的版本 ${targetVersion}。` +
        `请升级 DeepCodeX 后再运行；拒绝在旧实现上操作新版本数据（避免丢领域状态）。`
    );
  }
  const applied: number[] = [];
  for (let version = currentVersion + 1; version <= targetVersion; version += 1) {
    const script = MIGRATIONS.get(version);
    if (script === undefined) {
      throw new Error(`缺少版本 ${version} 的迁移脚本——迁移链不完整，拒绝启动。`);
    }
    exec(script);
    applied.push(version);
  }
  return applied;
}
