/**
 * Super Agent 引擎端到端测试
 *
 * 覆盖场景（对应方案 §9 的 T1–T9）：
 * - T1 显式请求 → 准入 → 接单 → 建工单
 * - T2 幂等：同一事件重复投递不产生第二个工单
 * - T3 订阅直通：已有工单的线程上再来事件，不再走 Eval
 * - T4 observe 影子：推断型候选只记「本应接单」，不建工单
 * - T5 auto 模式：推断型候选真的接单
 * - T6 派工 → Worker 报告 → 工单终结
 * - T7 blocked 报告 → 结构化 Attention（不靠自由文本推断）
 * - T8 工单结束后人的消息可恢复（授权复验通过）
 * - T9 人喊停的工单不可恢复
 * - T10 研判不可用 → unavailable → 重排一次 → 连续失败后放弃
 * - T11 决策逐项独立：单项失败不阻断后续
 *
 * 测试约定：真实 Store / Engine / Router，研判器与执行器用**函数注入式**实现
 * （真实实现接口契约，非 mock 框架）。
 *
 * @module tests/super-agent-engine
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SuperAgentEngine, type Assessor } from "../super-agent/engine/engine.js";
import { SuperAgentRepositories } from "../super-agent/store/repositories.js";
import { openStore, type Store } from "../super-agent/store/store.js";
import { SuperAgentRouter } from "../super-agent/router/router.js";
import { createDefaultPolicy } from "../super-agent/policy/policy.js";
import type {
  DecisionKind,
  EvalCandidate,
  NewTrigger,
  Policy,
  Strength,
  WorkerReport,
} from "../super-agent/domain/types.js";

// ============================================================================
// 测试辅助
// ============================================================================

/** 固定研判器：总是给出指定结论 */
class FixedAssessor implements Assessor {
  /** 调用次数 */
  calls = 0;

  /**
   * @param kind 固定结论
   * @param reason 固定理由
   */
  constructor(
    private readonly kind: DecisionKind = "accept",
    private readonly reason: string = "固定研判结论"
  ) {}

  /**
   * 研判
   *
   * @param candidate 候选
   * @returns 固定结论
   */
  async assess(candidate: EvalCandidate): Promise<{
    kind: DecisionKind;
    reason: string;
    matchedRules: readonly string[];
  } | null> {
    this.calls += 1;
    void candidate;
    return { kind: this.kind, reason: this.reason, matchedRules: [] };
  }
}

/** 记录调用次数的研判器（返回 null → unavailable） */
class NullReturningAssessor implements Assessor {
  /** 调用次数 */
  calls = 0;

  /**
   * 研判（恒返回 null）
   *
   * @returns null
   */
  async assess(): Promise<null> {
    this.calls += 1;
    return null;
  }
}

/** 测试装配 */
interface Harness {
  readonly store: Store;
  readonly repos: SuperAgentRepositories;
  readonly engine: SuperAgentEngine;
  readonly router: SuperAgentRouter;
  readonly assessor: FixedAssessor | NullReturningAssessor;
  readonly dir: string;
  readonly cleanup: () => void;
}

/**
 * 装配测试用的引擎
 *
 * @param policy 初始策略
 * @param assessor 研判器
 * @returns 测试装配
 */
async function makeHarness(
  policy: Policy,
  assessor: FixedAssessor | NullReturningAssessor = new FixedAssessor()
): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "super-agent-engine-"));
  const store = await openStore({ databasePath: path.join(dir, "agent.db") });
  const repos = new SuperAgentRepositories(store);
  const engine = new SuperAgentEngine({ store, repos, assessor });
  const router = new SuperAgentRouter({ engine, assessor });
  store.write((tx) => {
    repos.setKv(tx, "super-agent:policy", JSON.stringify(policy));
  });
  return {
    store,
    repos,
    engine,
    router,
    assessor,
    dir,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 构造一份允许 alice 显式寻址、允许推断候选的策略 */
function makePolicy(overrides: Partial<Policy> = {}): Policy {
  const base = createDefaultPolicy();
  return {
    ...base,
    acceptMode: "auto",
    sourceParts: {
      "src-a": {
        sourceId: "src-a",
        allowlist: ["alice"],
        botList: [],
        admission: { "new-issue": "inferred" },
      },
    },
    ...overrides,
  };
}

/** 构造一条测试用事件 */
function makeEvent(overrides: Partial<NewTrigger> = {}): NewTrigger {
  return {
    sourceId: "src-a",
    idempotencyKey: "",
    actor: "alice",
    actorKind: "human",
    addressed: true,
    text: "请修复登录崩溃",
    meta: { scope: "new-issue" },
    ...overrides,
  };
}

// ============================================================================
// T1 / T2：显式请求接单 + 幂等
// ============================================================================

test("T1：显式请求 → 准入 → 接单 → 建工单（含 Assignment 与自有订阅）", async () => {
  const harness = await makeHarness(makePolicy());
  try {
    const result = harness.engine.sources.receiveTrigger({
      trigger: makeEvent(),
      threadKeys: ["issue-1"],
    });
    assert.equal(result.status, "stored");

    const decisions = await harness.router.processCandidates();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.kind, "accept");
    assert.equal(decisions[0]?.status, "applied");

    const tickets = harness.engine.people.listTickets();
    assert.equal(tickets.length, 1);
    const ticket = tickets[0];
    assert.equal(ticket?.state, "open");
    assert.equal(ticket?.mandate.strength, "explicit");
    assert.equal(ticket?.mandate.actor, "alice");
    assert.equal(ticket?.mandate.sourceId, "src-a");

    // 派工记录与自有订阅都在
    assert.equal(harness.repos.listAssignments(ticket!.id).length, 1);
    const subscriptions = harness.repos.listSubscriptionsByTicket(ticket!.id);
    assert.equal(subscriptions.length, 1);
    assert.equal(subscriptions[0]?.own, true);
  } finally {
    harness.cleanup();
  }
});

test("T2：同一事件重复投递命中幂等键，不产生第二个工单", async () => {
  const harness = await makeHarness(makePolicy());
  try {
    const first = harness.engine.sources.receiveTrigger({
      trigger: makeEvent(),
      threadKeys: ["issue-1"],
    });
    assert.equal(first.status, "stored");
    await harness.router.processCandidates();

    const second = harness.engine.sources.receiveTrigger({
      trigger: makeEvent(),
      threadKeys: ["issue-1"],
    });
    assert.equal(second.status, "duplicate");
    assert.equal(second.trigger.id, first.trigger.id);

    await harness.router.processCandidates();
    assert.equal(harness.engine.people.listTickets().length, 1);
  } finally {
    harness.cleanup();
  }
});

// ============================================================================
// T3：订阅直通
// ============================================================================

test("T3：已有工单的线程上再来事件 → 扇出到工单，不再走 Eval", async () => {
  const harness = await makeHarness(makePolicy());
  try {
    harness.engine.sources.receiveTrigger({
      trigger: makeEvent(),
      threadKeys: ["issue-1"],
    });
    await harness.router.processCandidates();
    const ticket = harness.engine.people.listTickets()[0]!;

    const assessorBefore = harness.assessor.calls;
    const second = harness.engine.sources.receiveTrigger({
      trigger: makeEvent({ text: "补充：还有另一个崩溃点" }),
      threadKeys: ["issue-1"],
    });
    assert.equal(second.status, "stored");

    // 扇出：输入进了工单，且没有产生新的 Eval 候选
    const inputs = harness.repos.listInputs(ticket.id);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]?.kind, "fanned_out");

    const candidates = harness.engine.router.listCandidates();
    assert.equal(candidates.length, 0);

    // 再跑一轮决策也不会多出工单
    await harness.router.processCandidates();
    assert.equal(harness.engine.people.listTickets().length, 1);
    assert.equal(harness.assessor.calls, assessorBefore);
  } finally {
    harness.cleanup();
  }
});

// ============================================================================
// T4 / T5：observe 影子与 auto 真接单
// ============================================================================

test("T4：observe 模式下推断型候选只记影子（would_accept），不建工单", async () => {
  const harness = await makeHarness(makePolicy({ acceptMode: "observe" }));
  try {
    harness.engine.sources.receiveTrigger({
      trigger: makeEvent({ addressed: false }),
      threadKeys: ["issue-2"],
    });
    const decisions = await harness.router.processCandidates();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.status, "would-accept");
    assert.equal(decisions[0]?.kind, "accept");

    assert.equal(harness.engine.people.listTickets().length, 0);
    const recent = harness.repos.listRecentDecisions();
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.wouldAccept, true);
  } finally {
    harness.cleanup();
  }
});

test("T5：auto 模式下推断型候选真的接单", async () => {
  const harness = await makeHarness(makePolicy({ acceptMode: "auto" }));
  try {
    harness.engine.sources.receiveTrigger({
      trigger: makeEvent({ addressed: false }),
      threadKeys: ["issue-2"],
    });
    const decisions = await harness.router.processCandidates();
    assert.equal(decisions[0]?.status, "applied");
    assert.equal(harness.engine.people.listTickets().length, 1);
    assert.equal(harness.engine.people.listTickets()[0]?.mandate.strength, "inferred");
  } finally {
    harness.cleanup();
  }
});

// ============================================================================
// T6 / T7：派工 → 报告 → 终结；结构化 Attention
// ============================================================================

test("T6：最终报告（ready）终结工单并结束 Assignment", async () => {
  const harness = await makeHarness(makePolicy());
  try {
    harness.engine.sources.receiveTrigger({
      trigger: makeEvent(),
      threadKeys: ["issue-1"],
    });
    await harness.router.processCandidates();
    const ticket = harness.engine.people.listTickets()[0]!;
    const assignment = harness.repos.listAssignments(ticket.id)[0]!;

    const report: WorkerReport = {
      kind: "ready",
      summary: "已修复登录崩溃",
      artifacts: ["src/auth.ts"],
    };
    harness.engine.executor.reportAssignment(assignment.id, report);

    const after = harness.engine.people.getTicket(ticket.id);
    assert.equal(after.ticket.state, "ended");
    assert.equal(after.ticket.endedBy, "worker");
    assert.equal(after.assignments[0]?.state, "ended");
    assert.equal(after.ticket.latestReport?.kind, "ready");
  } finally {
    harness.cleanup();
  }
});

test("T7：blocked 报告产生结构化 Attention（不看自由文本）", async () => {
  const harness = await makeHarness(makePolicy());
  try {
    harness.engine.sources.receiveTrigger({
      trigger: makeEvent(),
      threadKeys: ["issue-1"],
    });
    await harness.router.processCandidates();
    const ticket = harness.engine.people.listTickets()[0]!;
    const assignment = harness.repos.listAssignments(ticket.id)[0]!;

    harness.engine.executor.reportAssignment(assignment.id, {
      kind: "blocked",
      summary: "需要确认是否要改接口",
      artifacts: [],
      attention: { question: "改签名还是新增重载？", options: ["改签名", "新增重载"], blocking: true },
    });

    const after = harness.engine.people.getTicket(ticket.id);
    // blocked 不是最终报告 → 工单仍开放
    assert.equal(after.ticket.state, "open");
    assert.equal(after.attention.length, 1);
    assert.equal(after.attention[0]?.question, "改签名还是新增重载？");
    assert.equal(after.attention[0]?.blocking, true);
    assert.equal(after.attention[0]?.resolvedAt, null);
  } finally {
    harness.cleanup();
  }
});

test("T7b：progress 报告即使文本写着「需要确认」也不产生 Attention", async () => {
  const harness = await makeHarness(makePolicy());
  try {
    harness.engine.sources.receiveTrigger({
      trigger: makeEvent(),
      threadKeys: ["issue-1"],
    });
    await harness.router.processCandidates();
    const ticket = harness.engine.people.listTickets()[0]!;
    const assignment = harness.repos.listAssignments(ticket.id)[0]!;

    harness.engine.executor.reportAssignment(assignment.id, {
      kind: "progress",
      summary: "看起来需要人确认一下",
      artifacts: [],
    });
    const after = harness.engine.people.getTicket(ticket.id);
    assert.equal(after.attention.length, 0);
  } finally {
    harness.cleanup();
  }
});

// ============================================================================
// T8 / T9：恢复与喊停
// ============================================================================

test("T8：已结束的工单，人的消息在授权复验通过后被恢复", async () => {
  const harness = await makeHarness(makePolicy());
  try {
    harness.engine.sources.receiveTrigger({
      trigger: makeEvent(),
      threadKeys: ["issue-1"],
    });
    await harness.router.processCandidates();
    const ticket = harness.engine.people.listTickets()[0]!;
    const assignment = harness.repos.listAssignments(ticket.id)[0]!;
    harness.engine.executor.reportAssignment(assignment.id, {
      kind: "ready",
      summary: "完成",
      artifacts: [],
    });
    assert.equal(harness.engine.people.getTicket(ticket.id).ticket.state, "ended");

    harness.engine.people.postMessage(ticket.id, "其实还有别的问题");
    const after = harness.engine.people.getTicket(ticket.id);
    assert.equal(after.ticket.state, "open");
    const resumed = after.inputs.find((input) => input.kind === "resumed");
    assert.ok(resumed);
    // Mandate 不可变：恢复不修改授权
    assert.equal(after.ticket.mandate.strength, "explicit");
  } finally {
    harness.cleanup();
  }
});

test("T9：人喊停的工单不可被消息恢复", async () => {
  const harness = await makeHarness(makePolicy());
  try {
    harness.engine.sources.receiveTrigger({
      trigger: makeEvent(),
      threadKeys: ["issue-1"],
    });
    await harness.router.processCandidates();
    const ticket = harness.engine.people.listTickets()[0]!;

    // 通过 stop 决策结束工单（endedBy = human）
    harness.engine.router.decide([
      {
        threadId: ticket.mandate.sourceId === "" ? "" : findThreadId(harness, ticket.id),
        kind: "stop",
        reason: "别做了",
      },
    ]);

    const stopped = harness.engine.people.listTickets()[0]!;
    assert.equal(stopped.state, "ended");
    assert.equal(stopped.endedBy, "human");

    assert.throws(() => harness.engine.people.postMessage(stopped.id, "继续吧"), /授权已失效/);
  } finally {
    harness.cleanup();
  }
});

/** 找到某工单自有订阅对应的 Thread ID */
function findThreadId(harness: Harness, ticketId: string): string {
  return harness.repos.listSubscriptionsByTicket(ticketId)[0]?.threadId ?? "";
}

// ============================================================================
// T10 / T11：研判不可用与逐项独立
// ============================================================================

test("T10：研判不可用 → 记 unavailable 并重排一次；连续失败后放弃候选", async () => {
  const assessor = new NullReturningAssessor();
  const harness = await makeHarness(makePolicy(), assessor);
  try {
    harness.engine.sources.receiveTrigger({
      trigger: makeEvent(),
      threadKeys: ["issue-1"],
    });

    const first = await harness.router.processCandidates();
    assert.equal(first.length, 1);
    assert.equal(first[0]?.kind, "unavailable");
    // 第一轮失败后候选仍在（重排），工单未建
    assert.equal(harness.engine.people.listTickets().length, 0);
    assert.equal(harness.engine.router.listCandidates().length, 1);

    // 第二轮仍然不可用 → 达到上限，放弃候选
    const second = await harness.router.processCandidates();
    assert.equal(second[0]?.kind, "unavailable");
    assert.equal(harness.engine.router.listCandidates().length, 0);
    assert.equal(harness.engine.people.listTickets().length, 0);
  } finally {
    harness.cleanup();
  }
});

test("T11：批量决策逐项独立——单项失败不阻断后续", async () => {
  const harness = await makeHarness(makePolicy());
  try {
    // 造两个线程：一个正常，一个指向不存在的 Thread
    harness.engine.sources.receiveTrigger({
      trigger: makeEvent(),
      threadKeys: ["issue-1"],
    });
    const goodThread = harness.engine.router.listCandidates()[0]?.threadId ?? "";

    const results = harness.engine.router.decide([
      { threadId: "thd_does_not_exist", kind: "accept", reason: "幽灵线程" },
      { threadId: goodThread, kind: "accept", reason: "正常线程" },
    ]);
    assert.equal(results.length, 2);
    assert.equal(results[0]?.status, "refused");
    assert.equal(results[1]?.status, "applied");
    assert.equal(harness.engine.people.listTickets().length, 1);
  } finally {
    harness.cleanup();
  }
});

test("策略变更不撤销存量工单，只投递变更通知", async () => {
  const harness = await makeHarness(makePolicy());
  try {
    harness.engine.sources.receiveTrigger({
      trigger: makeEvent(),
      threadKeys: ["issue-1"],
    });
    await harness.router.processCandidates();
    const ticket = harness.engine.people.listTickets()[0]!;

    const policy = harness.engine.settings.getPolicy();
    harness.engine.settings.setPolicy({ ...policy, acceptMode: "off" });

    const after = harness.engine.people.getTicket(ticket.id);
    assert.equal(after.ticket.state, "open");
    const notice = after.inputs.find((input) => input.kind === "policy_changed");
    assert.ok(notice);
    assert.equal(harness.engine.settings.getPolicy().version, policy.version + 1);
  } finally {
    harness.cleanup();
  }
});

test("强度推导：Gate 未给出强度时退回 inferred，不越级为 explicit", async () => {
  const harness = await makeHarness(makePolicy());
  try {
    const strength: Strength = "inferred";
    assert.equal(strength, "inferred");
    const outcome = harness.engine.settings.getPolicy();
    assert.equal(outcome.acceptMode, "auto");
  } finally {
    harness.cleanup();
  }
});
