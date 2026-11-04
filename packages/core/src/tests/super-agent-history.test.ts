/**
 * Super Agent 历史研判经验测试（全局层上下文）
 *
 * 覆盖范围（对应 `proposal-p3-context-v2.md` §6）：
 * - T14′ 历史经验可被召回（派生自 `decision` ⋈ `trigger`，**零新表**）
 * - T16′ 硬门槛防排序反转（不相关但更新的历史**不出现**）
 * - T19 迁移链（v1 → v2 只追加计划表；既有数据保留；迁移幂等）
 * - I10 召回只读（调用前后领域状态不变）
 *
 * 测试约定：真实 SQLite（临时目录）+ 真实仓储；无 mock 框架。
 *
 * @module tests/super-agent-history
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openStore, type Store } from "../super-agent/store/store.js";
import { SuperAgentRepositories } from "../super-agent/store/repositories.js";
import { runMigrations, SCHEMA_VERSION } from "../super-agent/store/schema.js";
import { recallHistoricalDecisions } from "../super-agent/engine/history.js";
import { estimateTokens, jaccard, kindWeight, MIN_JACCARD } from "../super-agent/domain/recall.js";
import type { DecisionKind } from "../super-agent/domain/types.js";

// ============================================================================
// 测试夹具
// ============================================================================

/** 固定时钟 */
const NOW = "2026-11-11T00:00:00.000Z";

/** 夹具 */
interface Fixture {
  readonly store: Store;
  readonly repos: SuperAgentRepositories;
  readonly dir: string;
  cleanup(): void;
}

/**
 * 建一个带历史决策的库
 *
 * 数据布局：
 * - `src-a` / `th_1`：两条 trigger，决策 `dec_1`（accept，与查询高度相似）
 * - `src-a` / `th_4`：一条无关 trigger，决策 `dec_4`（ignore，**更新**——门槛必须挡掉它）
 * - `src-b` / `th_2`：另一来源，决策 `dec_2`（ignore，**跨来源必须不可见**）
 * - `src-a` / `th_3`：无 trigger 的线程，决策 `dec_3`（unavailable，trigger 必须为 null）
 */
async function makeFixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "super-agent-history-"));
  const store = await openStore({ databasePath: path.join(dir, "agent.db") });
  const repos = new SuperAgentRepositories(store);

  store.write((tx) => {
    // ---- src-a / th_1 ----
    repos.insertTrigger(tx, {
      id: "trg_a1",
      sourceId: "src-a",
      idempotencyKey: "k1",
      actor: "alice",
      actorKind: "human",
      addressed: true,
      text: "请修复登录页的样式错乱问题",
      createdAt: "2026-11-01T00:00:00.000Z",
      meta: {},
    });
    repos.insertTrigger(tx, {
      id: "trg_a2",
      sourceId: "src-a",
      idempotencyKey: "k2",
      actor: "alice",
      actorKind: "human",
      addressed: true,
      text: "另外还有移动端适配",
      createdAt: "2026-11-02T00:00:00.000Z",
      meta: {},
    });
    repos.upsertThread(tx, { id: "th_1", sourceId: "src-a", active: true, meta: {} });
    repos.linkTriggerThread(tx, "trg_a1", "th_1", "2026-11-01T00:00:01.000Z");
    repos.linkTriggerThread(tx, "trg_a2", "th_1", "2026-11-02T00:00:01.000Z");
    repos.insertDecision(tx, {
      id: "dec_1",
      threadId: "th_1",
      kind: "accept",
      strength: "explicit",
      reason: "明确要求修复登录页，属于可执行请求",
      wouldAccept: false,
      at: "2026-11-02T00:00:05.000Z",
    });

    // ---- src-a / th_4（无关但更新）----
    repos.insertTrigger(tx, {
      id: "trg_a4",
      sourceId: "src-a",
      idempotencyKey: "k4",
      actor: "bob",
      actorKind: "human",
      addressed: false,
      text: "今天天气不错适合出门散步",
      createdAt: "2026-11-10T00:00:00.000Z",
      meta: {},
    });
    repos.upsertThread(tx, { id: "th_4", sourceId: "src-a", active: true, meta: {} });
    repos.linkTriggerThread(tx, "trg_a4", "th_4", "2026-11-10T00:00:01.000Z");
    repos.insertDecision(tx, {
      id: "dec_4",
      threadId: "th_4",
      kind: "ignore",
      strength: "inferred",
      reason: "闲聊内容，没有明确产出",
      wouldAccept: false,
      at: "2026-11-10T00:00:05.000Z",
    });

    // ---- src-b / th_2（另一来源）----
    repos.insertTrigger(tx, {
      id: "trg_b1",
      sourceId: "src-b",
      idempotencyKey: "k2",
      actor: "carol",
      actorKind: "bot",
      addressed: false,
      text: "请修复登录页的样式错乱问题",
      createdAt: "2026-11-01T00:00:00.000Z",
      meta: {},
    });
    repos.upsertThread(tx, { id: "th_2", sourceId: "src-b", active: true, meta: {} });
    repos.linkTriggerThread(tx, "trg_b1", "th_2", "2026-11-01T00:00:01.000Z");
    repos.insertDecision(tx, {
      id: "dec_2",
      threadId: "th_2",
      kind: "ignore",
      strength: "inferred",
      reason: "另一个来源的相似决策",
      wouldAccept: false,
      at: "2026-11-03T00:00:05.000Z",
    });

    // ---- src-a / th_3（无 trigger）----
    repos.upsertThread(tx, { id: "th_3", sourceId: "src-a", active: true, meta: {} });
    repos.insertDecision(tx, {
      id: "dec_3",
      threadId: "th_3",
      kind: "unavailable",
      strength: "inferred",
      reason: "本轮研判超时，未能完成判断",
      wouldAccept: false,
      at: "2026-11-04T00:00:05.000Z",
    });
  });

  return {
    store,
    repos,
    dir,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ============================================================================
// 存储层：派生查询
// ============================================================================

test("历史经验：按 Source 隔离（跨来源不可见）", async () => {
  const fixture = await makeFixture();
  try {
    const a = fixture.repos.listHistoricalDecisions("src-a", 50);
    const b = fixture.repos.listHistoricalDecisions("src-b", 50);
    assert.deepEqual(a.map((entry) => entry.id).sort(), ["dec_1", "dec_3", "dec_4"]);
    assert.deepEqual(
      b.map((entry) => entry.id),
      ["dec_2"]
    );
    assert.equal(
      a.every((entry) => entry.sourceId === "src-a"),
      true
    );
  } finally {
    fixture.cleanup();
  }
});

test("历史经验：Trigger 配对取「决策时刻之前最近的一条」", async () => {
  const fixture = await makeFixture();
  try {
    const entries = fixture.repos.listHistoricalDecisions("src-a", 50);
    const dec1 = entries.find((entry) => entry.id === "dec_1");
    assert.notEqual(dec1, undefined);
    // dec_1.at = 11-02T00:00:05 → 应配到 trg_a2（11-02T00:00:00），而不是 trg_a1
    assert.equal(dec1?.trigger?.id, "trg_a2");
    assert.equal(dec1?.trigger?.text, "另外还有移动端适配");
    assert.equal(dec1?.trigger?.sourceId, "src-a");
  } finally {
    fixture.cleanup();
  }
});

test("历史经验：无 Trigger 的线程 → trigger 为 null（不编造）", async () => {
  const fixture = await makeFixture();
  try {
    const entries = fixture.repos.listHistoricalDecisions("src-a", 50);
    const dec3 = entries.find((entry) => entry.id === "dec_3");
    assert.notEqual(dec3, undefined);
    assert.equal(dec3?.trigger, null);
    assert.equal(dec3?.kind, "unavailable");
    assert.equal(dec3?.reason, "本轮研判超时，未能完成判断");
  } finally {
    fixture.cleanup();
  }
});

test("历史经验：limit 生效（按时间倒序取前 N 条）", async () => {
  const fixture = await makeFixture();
  try {
    const one = fixture.repos.listHistoricalDecisions("src-a", 1);
    assert.equal(one.length, 1);
    assert.equal(one[0]?.id, "dec_4");
  } finally {
    fixture.cleanup();
  }
});

// ============================================================================
// 召回
// ============================================================================

test("T14′ 历史经验可被召回（相关的那条命中）", async () => {
  const fixture = await makeFixture();
  try {
    const hits = recallHistoricalDecisions(
      { repos: fixture.repos, now: () => NOW },
      { sourceId: "src-a", query: "请修复登录页的样式错乱问题", now: NOW }
    );
    const ids = hits.map((hit) => hit.decision.id);
    assert.equal(ids.includes("dec_1"), true, `期望命中 dec_1，实际 ${ids.join(",")}`);
    const hit = hits.find((candidate) => candidate.decision.id === "dec_1");
    assert.equal((hit?.keywordScore ?? 0) > MIN_JACCARD, true);
    assert.equal(hit?.kindScore, kindWeight("accept"));
  } finally {
    fixture.cleanup();
  }
});

test("T16′ 硬门槛防排序反转：不相关但更新的历史不出现", async () => {
  const fixture = await makeFixture();
  try {
    const hits = recallHistoricalDecisions(
      { repos: fixture.repos, now: () => NOW },
      { sourceId: "src-a", query: "请修复登录页的样式错乱问题", now: NOW }
    );
    const ids = hits.map((hit) => hit.decision.id);
    // dec_4 更晚（11-10），若没有硬门槛会被 recency 维顶上来
    assert.equal(ids.includes("dec_4"), false, `无关条目不应出现，实际 ${ids.join(",")}`);
  } finally {
    fixture.cleanup();
  }
});

test("召回：跨来源的历史不可见（只查本 Source）", async () => {
  const fixture = await makeFixture();
  try {
    const hits = recallHistoricalDecisions(
      { repos: fixture.repos, now: () => NOW },
      { sourceId: "src-a", query: "请修复登录页的样式错乱问题", now: NOW }
    );
    assert.equal(
      hits.some((hit) => hit.decision.id === "dec_2"),
      false
    );
  } finally {
    fixture.cleanup();
  }
});

test("召回：空 query 直接返回空（不做无谓计算）", async () => {
  const fixture = await makeFixture();
  try {
    const hits = recallHistoricalDecisions(
      { repos: fixture.repos, now: () => NOW },
      { sourceId: "src-a", query: "   ", now: NOW }
    );
    assert.equal(hits.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("召回：kindWeight 让 accept 优先于 ignore（同类内容）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "super-agent-kind-"));
  const store = await openStore({ databasePath: path.join(dir, "agent.db") });
  try {
    const repos = new SuperAgentRepositories(store);
    store.write((tx) => {
      repos.insertTrigger(tx, {
        id: "trg_1",
        sourceId: "src-a",
        idempotencyKey: "k1",
        actor: "alice",
        actorKind: "human",
        addressed: true,
        text: "修复登录页样式问题",
        createdAt: "2026-11-01T00:00:00.000Z",
        meta: {},
      });
      repos.upsertThread(tx, { id: "th_1", sourceId: "src-a", active: true, meta: {} });
      repos.linkTriggerThread(tx, "trg_1", "th_1", "2026-11-01T00:00:01.000Z");
      repos.insertDecision(tx, {
        id: "dec_accept",
        threadId: "th_1",
        kind: "accept",
        strength: "explicit",
        reason: "修复登录页样式问题",
        wouldAccept: false,
        at: "2026-11-01T00:00:02.000Z",
      });
      repos.insertDecision(tx, {
        id: "dec_ignore",
        threadId: "th_1",
        kind: "ignore",
        strength: "inferred",
        reason: "修复登录页样式问题",
        wouldAccept: false,
        at: "2026-11-01T00:00:03.000Z",
      });
    });

    const hits = recallHistoricalDecisions(
      { repos, now: () => NOW },
      { sourceId: "src-a", query: "修复登录页样式问题", now: NOW }
    );
    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.decision.id, "dec_accept");
    assert.equal((hits[0]?.totalScore ?? 0) > (hits[1]?.totalScore ?? 0), true);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 只读与零迁移
// ============================================================================

test("I10 召回只读：调用前后领域状态不变", async () => {
  const fixture = await makeFixture();
  try {
    const before = fixture.repos.listRecentDecisions(100).length;
    recallHistoricalDecisions(
      { repos: fixture.repos, now: () => NOW },
      { sourceId: "src-a", query: "请修复登录页的样式错乱问题", now: NOW }
    );
    const after = fixture.repos.listRecentDecisions(100).length;
    assert.equal(after, before);
    assert.equal(before, 4);
  } finally {
    fixture.cleanup();
  }
});

test("T19 迁移链：v1 库升级到 v2 只追加计划表，既有数据保留", async () => {
  assert.equal(SCHEMA_VERSION, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "super-agent-migrate-"));
  try {
    const dbPath = path.join(dir, "agent.db");
    // 第一段：写入 v1 时期的数据（决策记录）
    const first = await openStore({ databasePath: dbPath });
    const firstRepos = new SuperAgentRepositories(first);
    first.write((tx) => {
      firstRepos.insertTrigger(tx, {
        id: "trg_1",
        sourceId: "src-a",
        idempotencyKey: "k1",
        actor: "alice",
        actorKind: "human",
        addressed: true,
        text: "请修复登录页的样式错乱问题",
        createdAt: "2026-11-01T00:00:00.000Z",
        meta: {},
      });
      firstRepos.upsertThread(tx, { id: "th_1", sourceId: "src-a", active: true, meta: {} });
      firstRepos.linkTriggerThread(tx, "trg_1", "th_1", "2026-11-01T00:00:01.000Z");
      firstRepos.insertDecision(tx, {
        id: "dec_1",
        threadId: "th_1",
        kind: "accept",
        strength: "explicit",
        reason: "可执行请求",
        wouldAccept: false,
        at: "2026-11-01T00:00:02.000Z",
      });
    });
    // 回退成 v1 形态：删掉 v2 新增的两张表，版本置 1
    first.write((tx) => {
      tx.exec("DROP TABLE IF EXISTS plan_step;");
      tx.exec("DROP TABLE IF EXISTS ticket_plan;");
      tx.exec("PRAGMA user_version = 1;");
    });
    first.close();

    // 第二段：重开 → 自动应用 v2 迁移，既有数据仍在，计划表可用
    const second = await openStore({ databasePath: dbPath });
    const secondRepos = new SuperAgentRepositories(second);
    const entries = secondRepos.listHistoricalDecisions("src-a", 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, "dec_1");

    second.write((tx) => {
      secondRepos.insertPlan(tx, "tkt_x", {
        version: 1,
        objective: "验证迁移后的计划表可用",
        strategy: "",
        steps: [{ id: "s1", title: "写一行", role: "solo-coder", dependsOn: [], deliverable: "一行代码" }],
        team: [],
        source: "fallback",
        warnings: [],
        createdAt: "2026-11-11T00:00:00.000Z",
      });
    });
    assert.equal(secondRepos.findPlan("tkt_x")?.steps.length, 1);

    // 迁移幂等：已是最新版本时不再有可应用的迁移
    assert.deepEqual(
      runMigrations(() => {
        throw new Error("已是最新版本，不应再执行迁移");
      }, SCHEMA_VERSION),
      []
    );
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 领域算法
// ============================================================================

test("estimateTokens：CJK 感知（中文不被低估 4 倍）", () => {
  // 10 个汉字 ≈ 10 token（一刀切 length/4 只会给 2.5）
  assert.equal(estimateTokens("修复登录页面样式错乱"), 10);
  // 纯 ASCII：4 字符 ≈ 1 token
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens(""), 0);
});

test("jaccard：完全相同为 1，无交集为 0", () => {
  assert.equal(jaccard("修复登录页", "修复登录页"), 1);
  assert.equal(jaccard("修复登录页", "今天散步"), 0);
});

test("kindWeight：未知类型有兜底值", () => {
  assert.equal(kindWeight("accept"), 1);
  assert.equal(kindWeight("ignore"), 0.6);
  assert.equal(kindWeight("stop"), 0.4);
  assert.equal(kindWeight("unavailable"), 0.2);
  assert.equal(kindWeight("不存在的类型"), 0.2);
});

test("DecisionKind 全集与 kindWeight 对齐", () => {
  const kinds: DecisionKind[] = ["accept", "ignore", "stop", "unavailable"];
  for (const kind of kinds) {
    assert.equal(kindWeight(kind) > 0, true);
  }
});
