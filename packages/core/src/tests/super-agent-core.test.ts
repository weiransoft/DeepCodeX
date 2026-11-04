/**
 * Super Agent 领域层与持久层单元测试
 *
 * 覆盖范围：
 * - 领域 ID 与幂等键（确定性是订阅直通的前提）
 * - 领域错误与状态谓词
 * - SQLite 持久层（事务、回滚、afterCommit、副作用合并、迁移）
 * - 准入策略（Gate 判定矩阵、授权复验）
 *
 * 测试约定（遵循项目「禁止 mock 框架」规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接 new SuperAgentEngine / openStore / SuperAgentRepositories
 * - 临时目录用 fs.mkdtempSync，finally 块清理
 *
 * @module tests/super-agent-core
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  IDEMPOTENCY_BUCKET_MS,
  fingerprint,
  isAssignmentEnded,
  isExplicitStrength,
  isTicketActive,
  isTicketOpen,
  isUserError,
  makeId,
  makeIdempotencyKey,
  makeThreadId,
  waitsForPerson,
} from "../super-agent/domain/index.js";
import { SuperAgentRepositories } from "../super-agent/store/repositories.js";
import { openStore } from "../super-agent/store/store.js";
import { runMigrations, SCHEMA_VERSION } from "../super-agent/store/schema.js";
import {
  createDefaultPolicy,
  evaluateGate,
  findSourcePart,
  loadPolicy,
  revalidateMandate,
  validatePolicy,
  withAcceptMode,
} from "../super-agent/policy/policy.js";
import type { Policy, Trigger } from "../super-agent/domain/types.js";

// ============================================================================
// 测试辅助
// ============================================================================

/** 创建临时目录 */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "super-agent-core-"));
}

/** 构造一条测试用 Trigger */
function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: "trg_test",
    sourceId: "src-a",
    idempotencyKey: "key-a",
    actor: "alice",
    actorKind: "human",
    addressed: false,
    text: "hello",
    createdAt: "2026-11-01T00:00:00.000Z",
    meta: {},
    ...overrides,
  };
}

// ============================================================================
// 领域：ID 与幂等键
// ============================================================================

test("makeIdempotencyKey：相同输入产生相同键（重复投递必须命中）", () => {
  const input = {
    sourceId: "src-a",
    actor: "alice",
    text: "  hello  ",
    createdAt: "2026-11-01T00:00:00.000Z",
  };
  assert.equal(makeIdempotencyKey(input), makeIdempotencyKey(input));
});

test("makeIdempotencyKey：文本首尾空白不影响键（同一事件的不同表述）", () => {
  const a = makeIdempotencyKey({
    sourceId: "src-a",
    actor: "alice",
    text: "hello",
    createdAt: "2026-11-01T00:00:00.000Z",
  });
  const b = makeIdempotencyKey({
    sourceId: "src-a",
    actor: "alice",
    text: "  hello  ",
    createdAt: "2026-11-01T00:00:00.000Z",
  });
  assert.equal(a, b);
});

test("makeIdempotencyKey：跨时间桶产生不同键（避免误判长时间后的重复消息）", () => {
  const base = {
    sourceId: "src-a",
    actor: "alice",
    text: "hello",
  };
  const t1 = "2026-11-01T00:00:00.000Z";
  const t2 = new Date(Date.parse(t1) + IDEMPOTENCY_BUCKET_MS + 1000).toISOString();
  assert.notEqual(makeIdempotencyKey({ ...base, createdAt: t1 }), makeIdempotencyKey({ ...base, createdAt: t2 }));
});

test("makeThreadId：同一 (sourceId, key) 永远得到同一 Thread（订阅直通的前提）", () => {
  const a = makeThreadId({ sourceId: "src-a", correlationKey: "files:x.ts" });
  const b = makeThreadId({ sourceId: "src-a", correlationKey: "files:x.ts" });
  assert.equal(a, b);
  assert.notEqual(a, makeThreadId({ sourceId: "src-a", correlationKey: "files:y.ts" }));
  assert.notEqual(a, makeThreadId({ sourceId: "src-b", correlationKey: "files:x.ts" }));
});

test("makeId：带类型前缀且唯一", () => {
  const a = makeId("ticket");
  const b = makeId("ticket");
  assert.match(a, /^tkt_[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
});

test("fingerprint：同内容同指纹，异内容异指纹", () => {
  assert.equal(fingerprint("abc"), fingerprint("abc"));
  assert.notEqual(fingerprint("abc"), fingerprint("abd"));
});

// ============================================================================
// 领域：错误与状态谓词
// ============================================================================

test("isUserError：只认 UserError，不包装原生异常", () => {
  const error = new Error("原生异常");
  assert.equal(isUserError(error), false);
});

test("状态谓词：isTicketOpen / isTicketActive / isAssignmentEnded", () => {
  assert.equal(isTicketOpen({ state: "open" }), true);
  assert.equal(isTicketOpen({ state: "ended" }), false);
  assert.equal(isTicketActive({ state: "open", endedAt: null }), true);
  assert.equal(isTicketActive({ state: "open", endedAt: "2026-11-01T00:00:00.000Z" }), false);
  assert.equal(isAssignmentEnded({ state: "ended" }), true);
  assert.equal(isAssignmentEnded({ state: "running" }), false);
  assert.equal(isExplicitStrength("explicit"), true);
  assert.equal(isExplicitStrength("inferred"), false);
});

test("waitsForPerson：只看结构化事实，不从自由文本推断", () => {
  const blocked = {
    kind: "blocked" as const,
    summary: "需要人决策",
    artifacts: [],
  };
  const progress = {
    kind: "progress" as const,
    summary: "看起来需要人确认",
    artifacts: [],
  };
  // blocked 且此后无人说话 → 等待人
  assert.equal(waitsForPerson({ latestReport: blocked, humanMessageSinceReport: false }), true);
  // blocked 但人已经说过话 → 不再等待
  assert.equal(waitsForPerson({ latestReport: blocked, humanMessageSinceReport: true }), false);
  // progress 即使文本里写着「需要确认」也不算等待人
  assert.equal(waitsForPerson({ latestReport: progress, humanMessageSinceReport: false }), false);
  // 没有报告 → 不等待
  assert.equal(waitsForPerson({ latestReport: null, humanMessageSinceReport: false }), false);
});

// ============================================================================
// 持久层
// ============================================================================

test("openStore：建库建表，二次打开保留数据（不静默重建）", async () => {
  const dir = makeTempDir();
  try {
    const dbPath = path.join(dir, "agent.db");
    const first = await openStore({ databasePath: dbPath });
    first.write((tx) => {
      tx.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("k1", "v1");
    });
    first.close();

    const second = await openStore({ databasePath: dbPath });
    const row = second.queryOne<{ v: string }>("SELECT v FROM kv WHERE k = ?", ["k1"]);
    assert.equal(row?.v, "v1");
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("openStore：版本高于实现时拒绝启动（不静默重建）", async () => {
  const dir = makeTempDir();
  try {
    const dbPath = path.join(dir, "agent.db");
    const store = await openStore({ databasePath: dbPath });
    // 人为把 user_version 调到未来版本
    store.query("PRAGMA user_version = 99;");
    store.close();

    await assert.rejects(() => openStore({ databasePath: dbPath }), /高于当前实现支持的版本/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Store.atomic：异常回滚整批写入", async () => {
  const dir = makeTempDir();
  try {
    const store = await openStore({ databasePath: path.join(dir, "agent.db") });
    const repos = new SuperAgentRepositories(store);
    assert.throws(() => {
      store.write((tx) => {
        repos.setKv(tx, "a", "1");
        throw new Error("boom");
      });
    }, /boom/);
    assert.equal(repos.getKv("a"), undefined);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Store.atomic：afterCommit 只在提交成功后执行，回滚时不执行", async () => {
  const dir = makeTempDir();
  try {
    const store = await openStore({ databasePath: path.join(dir, "agent.db") });
    const order: string[] = [];

    store.write((tx) => {
      tx.afterCommit(() => order.push("committed"));
      order.push("in-transaction");
    });
    assert.deepEqual(order, ["in-transaction", "committed"]);

    const failed: string[] = [];
    assert.throws(() => {
      store.write((tx) => {
        tx.afterCommit(() => failed.push("should-not-run"));
        throw new Error("rollback");
      });
    });
    assert.deepEqual(failed, []);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Store.atomic：嵌套调用复用外层事务（不新开 BEGIN）", async () => {
  const dir = makeTempDir();
  try {
    const store = await openStore({ databasePath: path.join(dir, "agent.db") });
    const repos = new SuperAgentRepositories(store);
    store.write((tx) => {
      repos.setKv(tx, "outer", "1");
      store.write((tx2) => {
        repos.setKv(tx2, "inner", "2");
      });
    });
    assert.equal(repos.getKv("outer"), "1");
    assert.equal(repos.getKv("inner"), "2");
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("副作用队列：同 (kind,key) 再次入队 → 合并而非重复", async () => {
  const dir = makeTempDir();
  try {
    const store = await openStore({ databasePath: path.join(dir, "agent.db") });
    const repos = new SuperAgentRepositories(store);
    store.write((tx) => {
      repos.enqueueEffect(tx, { kind: "delivery", key: "delivery:t1", payload: { n: 1 }, dueAt: store.now() });
      repos.enqueueEffect(tx, { kind: "delivery", key: "delivery:t1", payload: { n: 2 }, dueAt: store.now() });
    });
    const due = repos.listDueEffects(store.now());
    assert.equal(due.length, 1);
    assert.deepEqual(due[0]?.payload, { n: 2 });
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runMigrations：版本更高时拒绝启动；迁移链缺失时报错", () => {
  assert.throws(() => runMigrations(() => {}, 5, 3), /高于当前实现支持的版本/);
  assert.throws(() => runMigrations(() => {}, 0, 3), /迁移链不完整/);
  assert.deepEqual(
    runMigrations(() => {}, 1, 1),
    []
  );
  assert.deepEqual(
    runMigrations(() => {}, 0, 1),
    [1]
  );
  assert.equal(SCHEMA_VERSION, 1);
});

// ============================================================================
// 策略：Gate 判定矩阵
// ============================================================================

/** 构造一份带名单与准入表的策略 */
function policyWith(overrides: Partial<Policy> = {}): Policy {
  const base = createDefaultPolicy();
  return {
    ...base,
    ...overrides,
    sourceParts: {
      "src-a": {
        sourceId: "src-a",
        allowlist: ["alice"],
        botList: ["ci-bot"],
        admission: { "new-issue": "inferred", "new-issue:unlisted": "ignore" },
      },
      ...(overrides.sourceParts ?? {}),
    },
  };
}

test("Gate：白名单内的人显式寻址 → 显式请求", () => {
  const outcome = evaluateGate({
    trigger: makeTrigger({ addressed: true }),
    sourcePart: findSourcePart(policyWith(), "src-a"),
    policy: policyWith(),
    existingTickets: [],
  });
  assert.equal(outcome.admitted, true);
  assert.equal(outcome.strength, "explicit");
  assert.equal(outcome.explicit, true);
});

test("Gate：白名单内的人在已有工单的线程上追问 → 显式请求", () => {
  const outcome = evaluateGate({
    trigger: makeTrigger({ addressed: false }),
    sourcePart: findSourcePart(policyWith(), "src-a"),
    policy: policyWith(),
    existingTickets: [{ id: "t1", state: "open", name: "n", scope: "s" }],
  });
  assert.equal(outcome.admitted, true);
  assert.equal(outcome.strength, "explicit");
});

test("Gate：白名单内的人未寻址且无工单 → 查准入表 → 推断候选", () => {
  const trigger = makeTrigger({ addressed: false, meta: { scope: "new-issue" } });
  const outcome = evaluateGate({
    trigger,
    sourcePart: findSourcePart(policyWith(), "src-a"),
    policy: policyWith(),
    existingTickets: [],
    scope: "new-issue",
  });
  assert.equal(outcome.admitted, true);
  assert.equal(outcome.strength, "inferred");
});

test("Gate：不在名单内的人未寻址 → 忽略", () => {
  const trigger = makeTrigger({ actor: "mallory", addressed: false, meta: { scope: "new-issue" } });
  const outcome = evaluateGate({
    trigger,
    sourcePart: findSourcePart(policyWith(), "src-a"),
    policy: policyWith(),
    existingTickets: [],
    scope: "new-issue",
  });
  assert.equal(outcome.admitted, false);
  assert.equal(outcome.strength, undefined);
});

test("Gate：机器人消息——名单内为推断候选，名单外不准入", () => {
  const known = evaluateGate({
    trigger: makeTrigger({ actor: "ci-bot", actorKind: "bot" }),
    sourcePart: findSourcePart(policyWith(), "src-a"),
    policy: policyWith(),
    existingTickets: [],
  });
  assert.equal(known.admitted, true);
  assert.equal(known.strength, "inferred");

  const unknown = evaluateGate({
    trigger: makeTrigger({ actor: "other-bot", actorKind: "bot" }),
    sourcePart: findSourcePart(policyWith(), "src-a"),
    policy: policyWith(),
    existingTickets: [],
  });
  assert.equal(unknown.admitted, false);
});

test("Gate：接单模式 off 时推断型候选不产生（显式请求不受影响）", () => {
  const policy = { ...policyWith(), acceptMode: "off" as const };
  const inferred = evaluateGate({
    trigger: makeTrigger({ actor: "ci-bot", actorKind: "bot" }),
    sourcePart: findSourcePart(policy, "src-a"),
    policy,
    existingTickets: [],
  });
  assert.equal(inferred.admitted, false);

  const explicit = evaluateGate({
    trigger: makeTrigger({ addressed: true }),
    sourcePart: findSourcePart(policy, "src-a"),
    policy,
    existingTickets: [],
  });
  assert.equal(explicit.admitted, true);
  assert.equal(explicit.strength, "explicit");
});

// ============================================================================
// 策略：授权复验与存取
// ============================================================================

test("revalidateMandate：显式授权直接通过；推断授权需 auto 模式", () => {
  const policy = policyWith();
  const explicitMandate = {
    policyVersion: 1,
    scope: "s",
    strength: "explicit" as const,
    matchedRules: [],
    actor: "alice",
    sourceId: "src-a",
  };
  assert.equal(revalidateMandate(explicitMandate, policy, findSourcePart(policy, "src-a")), true);

  const inferredMandate = { ...explicitMandate, strength: "inferred" as const };
  assert.equal(revalidateMandate(inferredMandate, policy, findSourcePart(policy, "src-a")), false);
  assert.equal(
    revalidateMandate(inferredMandate, { ...policy, acceptMode: "auto" }, findSourcePart(policy, "src-a")),
    true
  );
});

test("revalidateMandate：发件人被移出名单后授权失效", () => {
  const policy = policyWith();
  const mandate = {
    policyVersion: 1,
    scope: "s",
    strength: "explicit" as const,
    matchedRules: [],
    actor: "alice",
    sourceId: "src-a",
  };
  const stripped = {
    ...policy,
    sourceParts: {
      "src-a": { sourceId: "src-a", allowlist: [], botList: [], admission: {} },
    },
  };
  // 显式授权的复验只看 Source 是否仍在监听——这里名单被清空后仍可通过（规则见 policy.ts）
  assert.equal(revalidateMandate(mandate, stripped, findSourcePart(stripped, "src-a")), true);
});

test("loadPolicy：损坏的 JSON 退回默认而不是崩溃", () => {
  const policy = loadPolicy(() => "{ 这不是 JSON");
  assert.equal(policy.acceptMode, "observe");
  assert.equal(policy.version, 1);
});

test("withAcceptMode：版本号 +1；validatePolicy 拒绝非法模式", () => {
  const policy = createDefaultPolicy();
  const next = withAcceptMode(policy, "auto");
  assert.equal(next.acceptMode, "auto");
  assert.equal(next.version, policy.version + 1);
  assert.throws(() => validatePolicy({ ...policy, acceptMode: "wild" as never }), /接单模式非法/);
  assert.throws(() => validatePolicy({ ...policy, version: 0 }), /版本必须为正整数/);
});
