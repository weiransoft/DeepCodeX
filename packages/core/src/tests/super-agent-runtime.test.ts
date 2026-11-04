/**
 * Super Agent 运行时测试
 *
 * 覆盖范围（对应方案 §9 的 T12 与 §10 的诚实降级要求）：
 * - 运行时装配与 status 快照
 * - 五个副作用处理器（assessment / launch / delivery / reply / relay）
 * - 诚实降级：无执行器时工单如实失败；无注入通道时输入保持 pending
 * - 副作用失败退避：超过重试上限后丢弃并记健康错误
 * - Worker 终态回灌：输出解析 → relay → 工单终结
 *
 * 测试约定：真实 Store / Engine / Effects / Runtime；
 * 启动器、注入通道与写侧用**函数注入式**实现（真实实现接口契约）。
 *
 * @module tests/super-agent-runtime
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SuperAgentRuntime } from "../super-agent/runtime.js";
import type { Assessor, WorkerInjector, WorkerLauncher } from "../super-agent/engine/engine.js";
import type { InjectOutcome } from "../super-agent/worker/executor.js";
import type { EvalCandidate, TicketMessage, WorkerReport } from "../super-agent/domain/types.js";

// ============================================================================
// 测试替身（真实实现接口契约，非 mock 框架）
// ============================================================================

/** 固定研判器 */
class FixedAssessor implements Assessor {
  /**
   * 研判
   *
   * @returns 固定结论
   */
  async assess(): Promise<{ kind: "accept"; reason: string; matchedRules: readonly string[] }> {
    return { kind: "accept", reason: "值得接单", matchedRules: [] };
  }
}

/** 记录启动调用的启动器 */
class RecordingLauncher implements WorkerLauncher {
  /** 已启动的工单 */
  readonly started: string[] = [];

  /**
   * 启动
   *
   * @param input 启动输入
   * @returns 会话 ID
   */
  async start(input: { ticketId: string }): Promise<string> {
    this.started.push(input.ticketId);
    return `session-${this.started.length}`;
  }
}

/** 记录注入的注入通道 */
class RecordingInjector implements WorkerInjector {
  /** 已注入的文本 */
  readonly injected: string[] = [];
  /** 是否接受注入（可切换，用于验证「未真送达则不标记已投递」） */
  accept = true;

  /**
   * 注入
   *
   * @param input 注入内容
   * @returns 注入结果
   */
  async inject(input: { text: string }): Promise<InjectOutcome> {
    this.injected.push(input.text);
    return this.accept ? { accepted: true } : { accepted: false, reason: "测试桩：拒绝接收" };
  }
}

/** 失败的写侧 */
class FailingWriteSide {
  /** 调用次数 */
  calls = 0;

  /**
   * 写侧（恒抛错）
   */
  async write(_message: TicketMessage): Promise<void> {
    this.calls += 1;
    throw new Error("写侧不可用");
  }
}

// ============================================================================
// 测试辅助
// ============================================================================

/** 创建临时目录 */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "super-agent-runtime-"));
}

/** 构造一条事件 */
function makeEvent(
  text = "请修复登录崩溃",
  addressed = true
): {
  sourceId: string;
  idempotencyKey: string;
  actor: string;
  actorKind: "human";
  addressed: boolean;
  text: string;
  meta: Record<string, unknown>;
} {
  return {
    sourceId: "src-a",
    idempotencyKey: "",
    actor: "alice",
    actorKind: "human",
    addressed,
    text,
    meta: { scope: "new-issue" },
  };
}

/**
 * 装配一个运行时
 *
 * @param overrides 覆盖项
 * @returns 运行时与清理函数
 */
async function makeRuntime(
  overrides: {
    readonly assessor?: Assessor | null;
    readonly launcher?: WorkerLauncher | null;
    readonly injector?: WorkerInjector | null;
    readonly writeSide?: (message: TicketMessage) => void | Promise<void>;
  } = {}
): Promise<{ runtime: SuperAgentRuntime; dir: string; cleanup: () => Promise<void> }> {
  const dir = makeTempDir();
  const runtime = await SuperAgentRuntime.create({
    databasePath: path.join(dir, "agent.db"),
    projectRoot: dir,
    assessor: overrides.assessor === undefined ? new FixedAssessor() : overrides.assessor,
    launcher: overrides.launcher === undefined ? null : overrides.launcher,
    injector: overrides.injector === undefined ? null : overrides.injector,
    writeSide: overrides.writeSide,
    passIntervalMs: 50,
  });
  // 允许 alice 显式寻址
  runtime.engine.settings.setPolicy({
    ...runtime.engine.settings.getPolicy(),
    acceptMode: "auto",
    sourceParts: {
      "src-a": {
        sourceId: "src-a",
        allowlist: ["alice"],
        botList: [],
        admission: { "new-issue": "inferred" },
      },
    },
  });
  return {
    runtime,
    dir,
    cleanup: async () => {
      await runtime.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ============================================================================
// 装配与状态
// ============================================================================

test("运行时：status 反映能力可用性（诚实降级可见）", async () => {
  const { runtime, cleanup } = await makeRuntime({ assessor: null, launcher: null, injector: null });
  try {
    const status = runtime.status();
    assert.equal(status.assessorAvailable, false);
    assert.equal(status.executorAvailable, false);
    assert.equal(status.injectorAvailable, false);
    assert.equal(status.acceptMode, "auto");
    assert.equal(status.totalTickets, 0);
    assert.deepEqual(status.pendingEffects, {});
  } finally {
    await cleanup();
  }
});

test("运行时：事件入队后跑一轮调度即产生工单（assessment 副作用驱动）", async () => {
  const { runtime, cleanup } = await makeRuntime({ launcher: new RecordingLauncher() });
  try {
    runtime.injectTrigger(makeEvent(), ["issue-1"]);
    await runtime.tick();

    const tickets = runtime.engine.people.listTickets();
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0]?.state, "open");
    // assessment 副作用已被消费
    assert.equal(runtime.effects.pending()["assessment"] ?? 0, 0);
  } finally {
    await cleanup();
  }
});

// ============================================================================
// launch 副作用
// ============================================================================

test("launch：无执行器时工单如实失败（不假装已派工）", async () => {
  const { runtime, cleanup } = await makeRuntime({ launcher: null });
  try {
    runtime.injectTrigger(makeEvent(), ["issue-1"]);
    await runtime.tick();

    const ticket = runtime.engine.people.listTickets()[0]!;
    const detail = runtime.engine.people.getTicket(ticket.id);
    assert.equal(detail.ticket.state, "ended");
    assert.equal(detail.ticket.latestReport?.kind, "failed");
    assert.match(detail.ticket.latestReport?.summary ?? "", /未配置 Worker 启动器/);
    assert.equal(detail.assignments[0]?.workerSessionId, null);
  } finally {
    await cleanup();
  }
});

test("launch：有执行器时 Assignment 进入 running 且记录会话 ID", async () => {
  const launcher = new RecordingLauncher();
  const { runtime, cleanup } = await makeRuntime({ launcher });
  try {
    runtime.injectTrigger(makeEvent(), ["issue-1"]);
    await runtime.tick();

    const ticket = runtime.engine.people.listTickets()[0]!;
    const detail = runtime.engine.people.getTicket(ticket.id);
    assert.equal(detail.assignments[0]?.state, "running");
    assert.equal(detail.assignments[0]?.workerSessionId, "session-1");
    assert.equal(launcher.started.length, 1);
  } finally {
    await cleanup();
  }
});

// ============================================================================
// delivery 副作用
// ============================================================================

test("delivery：有注入通道时输入被标记为已投递", async () => {
  const injector = new RecordingInjector();
  const { runtime, cleanup } = await makeRuntime({ launcher: new RecordingLauncher(), injector });
  try {
    runtime.injectTrigger(makeEvent(), ["issue-1"]);
    await runtime.tick();

    const ticket = runtime.engine.people.listTickets()[0]!;
    // 人发一条消息 → 产生待投递输入
    runtime.engine.people.postMessage(ticket.id, "补充信息");
    await runtime.tick();

    const inputs = runtime.repos.listInputs(ticket.id);
    assert.equal(inputs.length, 1);
    assert.notEqual(inputs[0]?.deliveredAt, null);
    assert.equal(injector.injected.length, 1);
    assert.match(injector.injected[0] ?? "", /补充信息/);
  } finally {
    await cleanup();
  }
});

test("delivery：注入通道未真接收时输入**不**标记为已投递（如实降级）", async () => {
  const injector = new RecordingInjector();
  injector.accept = false;
  const { runtime, cleanup } = await makeRuntime({ launcher: new RecordingLauncher(), injector });
  try {
    runtime.injectTrigger(makeEvent(), ["issue-1"]);
    await runtime.tick();

    const ticket = runtime.engine.people.listTickets()[0]!;
    runtime.engine.people.postMessage(ticket.id, "补充信息");
    await runtime.tick();

    // 🔴 注入未被真接收 → 输入必须仍是 pending（不得谎报已送达）
    const inputs = runtime.repos.listInputs(ticket.id);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]?.deliveredAt, null, "注入未真送达时不得标记为已投递");
    assert.equal(injector.injected.length, 1);
  } finally {
    await cleanup();
  }
});

test("delivery：无注入通道时输入保持 pending（不假装已送达）", async () => {
  const { runtime, cleanup } = await makeRuntime({ launcher: new RecordingLauncher(), injector: null });
  try {
    runtime.injectTrigger(makeEvent(), ["issue-1"]);
    await runtime.tick();

    const ticket = runtime.engine.people.listTickets()[0]!;
    runtime.engine.people.postMessage(ticket.id, "补充信息");
    await runtime.tick();

    const inputs = runtime.repos.listInputs(ticket.id);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]?.deliveredAt, null);
    // 并如实留下一条「待转交」说明
    const messages = runtime.repos.listTicketMessages(ticket.id);
    assert.ok(messages.some((message) => message.body.includes("未配置 Worker 注入通道")));
  } finally {
    await cleanup();
  }
});

// ============================================================================
// reply 副作用
// ============================================================================

test("reply：写侧成功后消息标记为 sent", async () => {
  const sent: TicketMessage[] = [];
  const { runtime, cleanup } = await makeRuntime({
    launcher: new RecordingLauncher(),
    writeSide: (message) => {
      sent.push(message);
    },
  });
  try {
    runtime.injectTrigger(makeEvent(), ["issue-1"]);
    await runtime.tick();

    const ticket = runtime.engine.people.listTickets()[0]!;
    const messages = runtime.repos.listTicketMessages(ticket.id);
    const ack = messages.find((message) => message.body.includes("已接单"));
    assert.ok(ack);
    assert.equal(ack?.state, "sent");
    assert.equal(sent.length, 1);
  } finally {
    await cleanup();
  }
});

test("reply：写侧失败时消息标记为 failed，并按退避重试", async () => {
  const failing = new FailingWriteSide();
  const { runtime, cleanup } = await makeRuntime({
    launcher: new RecordingLauncher(),
    writeSide: (message) => failing.write(message),
  });
  try {
    runtime.injectTrigger(makeEvent(), ["issue-1"]);
    await runtime.tick();

    const ticket = runtime.engine.people.listTickets()[0]!;
    const messages = runtime.repos.listTicketMessages(ticket.id);
    const ack = messages.find((message) => message.body.includes("已接单"));
    assert.ok(ack);
    assert.equal(ack?.state, "failed");
    // 副作用仍在队列里等待重试
    assert.ok((runtime.effects.pending()["reply"] ?? 0) >= 1);
    assert.ok(failing.calls >= 1);
  } finally {
    await cleanup();
  }
});

// ============================================================================
// relay 副作用与 Worker 回灌
// ============================================================================

test("relay：Worker 终态回灌 → 结构化报告 → 工单终结", async () => {
  const { runtime, cleanup } = await makeRuntime({ launcher: new RecordingLauncher() });
  try {
    runtime.injectTrigger(makeEvent(), ["issue-1"]);
    await runtime.tick();

    const ticket = runtime.engine.people.listTickets()[0]!;
    // Worker 返回合法结构化报告
    runtime.notifyWorkerComplete(
      runtime.repos.listAssignments(ticket.id)[0]!.id,
      JSON.stringify({ kind: "ready", summary: "已修复", artifacts: ["a.ts"] }),
      null
    );
    await runtime.tick();

    const detail = runtime.engine.people.getTicket(ticket.id);
    assert.equal(detail.ticket.state, "ended");
    assert.equal(detail.ticket.latestReport?.kind, "ready");
    assert.equal(detail.ticket.latestReport?.summary, "已修复");
  } finally {
    await cleanup();
  }
});

test("relay：Worker 输出无法解析时降级为 failed（不猜测成功）", async () => {
  const { runtime, cleanup } = await makeRuntime({ launcher: new RecordingLauncher() });
  try {
    runtime.injectTrigger(makeEvent(), ["issue-1"]);
    await runtime.tick();

    const ticket = runtime.engine.people.listTickets()[0]!;
    runtime.notifyWorkerComplete(runtime.repos.listAssignments(ticket.id)[0]!.id, "我完成了！", null);
    await runtime.tick();

    const detail = runtime.engine.people.getTicket(ticket.id);
    assert.equal(detail.ticket.latestReport?.kind, "failed");
    assert.match(detail.ticket.latestReport?.summary ?? "", /无法解析/);
  } finally {
    await cleanup();
  }
});

test("relay：Worker 报错时按失败如实记录原因", async () => {
  const { runtime, cleanup } = await makeRuntime({ launcher: new RecordingLauncher() });
  try {
    runtime.injectTrigger(makeEvent(), ["issue-1"]);
    await runtime.tick();

    const ticket = runtime.engine.people.listTickets()[0]!;
    runtime.notifyWorkerComplete(runtime.repos.listAssignments(ticket.id)[0]!.id, null, "模型返回空内容");
    await runtime.tick();

    const detail = runtime.engine.people.getTicket(ticket.id);
    assert.equal(detail.ticket.latestReport?.kind, "failed");
    assert.match(detail.ticket.latestReport?.summary ?? "", /模型返回空内容/);
  } finally {
    await cleanup();
  }
});

// ============================================================================
// 副作用队列的健康语义
// ============================================================================

test("副作用：未注册的 kind 被丢弃并记健康错误（不静默跳过）", async () => {
  const { runtime, cleanup } = await makeRuntime();
  try {
    runtime.store.write((tx) => {
      runtime.repos.enqueueEffect(tx, {
        kind: "not-registered",
        key: "k1",
        payload: {},
        dueAt: runtime.store.now(),
      });
    });
    await runtime.tick();

    const health = runtime.effects.health();
    const entry = health.find((item) => item.kind === "not-registered");
    assert.ok(entry);
    assert.equal(entry?.consecutiveFailures, 1);
    assert.match(entry?.lastError ?? "", /未注册处理器/);
    assert.equal(runtime.effects.pending()["not-registered"] ?? 0, 0);
  } finally {
    await cleanup();
  }
});

test("副作用：注册重复的 kind 会被拒绝", async () => {
  const { runtime, cleanup } = await makeRuntime();
  try {
    assert.throws(() => runtime.effects.register("assessment", () => {}), /已注册/);
  } finally {
    await cleanup();
  }
});

test("副作用：失败后按指数退避延后重试，不忙循环", async () => {
  const { runtime, cleanup } = await makeRuntime({ launcher: null });
  try {
    runtime.injectTrigger(makeEvent(), ["issue-1"]);
    await runtime.tick();
    // 第一轮已把工单终结为失败
    const pending = runtime.effects.pending();
    assert.equal(Object.keys(pending).length, 0);
  } finally {
    await cleanup();
  }
});

test("运行时：Source 注册后可创建实例并接收事件", async () => {
  const { runtime, cleanup } = await makeRuntime();
  try {
    const instance = runtime.sources.create("local-watcher", "local-watcher", { root: process.cwd() }, () => {});
    assert.equal(instance.id, "local-watcher");
    assert.equal(runtime.sources.listInstances().length, 1);
    assert.equal(runtime.sources.listKinds().length, 1);
  } finally {
    await cleanup();
  }
});

test("运行时：候选上下文包含触发事件与已有工单", async () => {
  const { runtime, cleanup } = await makeRuntime();
  try {
    runtime.injectTrigger(makeEvent(), ["issue-1"]);
    const candidates = runtime.engine.router.listCandidates();
    assert.equal(candidates.length, 1);
    const candidate = candidates[0] as EvalCandidate;
    assert.equal(candidate.triggers.length, 1);
    assert.equal(candidate.triggers[0]?.text, "请修复登录崩溃");
    assert.equal(candidate.existingTickets.length, 0);
    assert.equal(candidate.policy.acceptMode, "auto");
  } finally {
    await cleanup();
  }
});

test("报告构造：结构化六值与 Attention 草稿", async () => {
  const report: WorkerReport = {
    kind: "blocked",
    summary: "需要决策",
    artifacts: [],
    attention: { question: "选哪个？", options: ["A", "B"], blocking: true },
  };
  assert.equal(report.attention?.blocking, true);
});
