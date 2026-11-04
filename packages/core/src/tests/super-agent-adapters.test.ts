/**
 * Super Agent 适配层测试
 *
 * 覆盖范围（补齐首期适配层的分支覆盖）：
 * - Worker 报告解析（代码块包裹、非法 kind、非对象、Attention 草稿变体）
 * - Worker 执行器（prompt 组装、角色约束、注入通道、后台任务映射）
 * - Passes 周期调度（合并请求、停止语义）
 * - 本地文件监听 Source（真实目录变更 → Trigger）
 * - 准入闸（空批次）
 *
 * 测试约定：真实组件 + 函数注入式替身；临时目录用 mkdtempSync。
 *
 * @module tests/super-agent-adapters
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildAttentionReport,
  buildFailedReport,
  buildProgressReport,
  buildReadyReport,
  parseWorkerReport,
  WORKER_OUTPUT_CONTRACT,
} from "../super-agent/worker/report.js";
import {
  BackgroundRunnerLauncher,
  SuperAgentWorkerExecutor,
  type WorkerLauncher,
} from "../super-agent/worker/executor.js";
import { Passes } from "../super-agent/passes/passes.js";
import { LocalWatcherSource, localWatcherKind } from "../super-agent/source/local-watcher.js";
import { SourceRegistry } from "../super-agent/source/kind.js";
import { admitCandidate } from "../super-agent/router/gate.js";
import { createDefaultPolicy } from "../super-agent/policy/policy.js";
import type { EngineContext } from "../super-agent/engine/engine.js";
import type { NewTrigger } from "../super-agent/domain/types.js";

// ============================================================================
// Worker 报告解析
// ============================================================================

test("parseWorkerReport：正常 JSON 输出被解析为结构化报告", () => {
  const report = parseWorkerReport(JSON.stringify({ kind: "ready", summary: "已完成", artifacts: ["a.ts", "b.ts"] }));
  assert.equal(report.kind, "ready");
  assert.equal(report.summary, "已完成");
  assert.deepEqual(report.artifacts, ["a.ts", "b.ts"]);
  assert.equal(report.attention, undefined);
});

test("parseWorkerReport：代码块包裹的 JSON 也能解析", () => {
  const report = parseWorkerReport('```json\n{"kind":"progress","summary":"进行中","artifacts":[]}\n```');
  assert.equal(report.kind, "progress");
  assert.equal(report.summary, "进行中");
});

test("parseWorkerReport：缺少 JSON 对象 → failed（不猜成功）", () => {
  const report = parseWorkerReport("我完成了，没有 JSON");
  assert.equal(report.kind, "failed");
  assert.match(report.summary, /无法解析/);
});

test("parseWorkerReport：非法 JSON → failed", () => {
  const report = parseWorkerReport("{ 不是合法 JSON }");
  assert.equal(report.kind, "failed");
  assert.match(report.summary, /不是合法 JSON/);
});

test("parseWorkerReport：JSON 但不是对象 → failed", () => {
  const report = parseWorkerReport("[1, 2, 3]");
  assert.equal(report.kind, "failed");
  assert.match(report.summary, /JSON 对象/);
});

test("parseWorkerReport：kind 非法 → failed 并说明实际值", () => {
  const report = parseWorkerReport(JSON.stringify({ kind: "done", summary: "x" }));
  assert.equal(report.kind, "failed");
  assert.match(report.summary, /kind 非法/);
});

test("parseWorkerReport：带 Attention 时按结构化字段生成（progress 降级为 waiting）", () => {
  const report = parseWorkerReport(
    JSON.stringify({
      kind: "progress",
      summary: "需要确认",
      artifacts: [],
      attention: { question: "选哪个？", options: ["A", "B"], blocking: true },
    })
  );
  assert.equal(report.kind, "waiting");
  assert.equal(report.attention?.question, "选哪个？");
  assert.deepEqual(report.attention?.options, ["A", "B"]);
  assert.equal(report.attention?.blocking, true);
});

test("parseWorkerReport：Attention 问题为空时视为没有 Attention", () => {
  const report = parseWorkerReport(
    JSON.stringify({
      kind: "progress",
      summary: "x",
      artifacts: [],
      attention: { question: "   ", options: [], blocking: true },
    })
  );
  assert.equal(report.attention, undefined);
  assert.equal(report.kind, "progress");
});

test("parseWorkerReport：非数组的 artifacts 被忽略", () => {
  const report = parseWorkerReport(JSON.stringify({ kind: "ready", summary: "x", artifacts: "not-an-array" }));
  assert.deepEqual(report.artifacts, []);
});

test("报告构造器：四种 builder 产出正确的 kind 与字段", () => {
  assert.equal(buildProgressReport("p").kind, "progress");
  assert.equal(buildReadyReport("r").kind, "ready");
  assert.equal(buildFailedReport("f").kind, "failed");
  const attention = buildAttentionReport("a", { question: "q", options: ["x"], blocking: false });
  assert.equal(attention.kind, "waiting");
  assert.equal(attention.attention?.blocking, false);
  const blocking = buildAttentionReport("a", { question: "q" });
  assert.equal(blocking.kind, "blocked");
  assert.equal(blocking.attention?.blocking, true);
  assert.deepEqual(blocking.attention?.options, []);
});

test("WORKER_OUTPUT_CONTRACT：写明六值 kind 与 attention 语义", () => {
  assert.match(WORKER_OUTPUT_CONTRACT, /progress/);
  assert.match(WORKER_OUTPUT_CONTRACT, /dropped/);
  assert.match(WORKER_OUTPUT_CONTRACT, /attention/);
});

// ============================================================================
// Worker 执行器
// ============================================================================

/** 记录启动与注入的启动器 */
class RecordingLauncher implements WorkerLauncher {
  /** 收到的 prompt */
  readonly prompts: string[] = [];
  /** 收到的角色 */
  readonly roles: string[] = [];

  /**
   * 启动
   *
   * @param input 启动输入
   * @returns 会话 ID
   */
  async start(input: { role: string; prompt: string }): Promise<string> {
    this.roles.push(input.role);
    this.prompts.push(input.prompt);
    return "session-x";
  }
}

/** 构造一个带仓储的执行器（仓储用最小替身，只提供执行器实际用到的方法） */
function makeExecutor(repos: {
  findTicket(id: string): { execution: { name: string } } | undefined;
  listPendingInputs(id: string): Array<{ kind: string; body: string }>;
}): SuperAgentWorkerExecutor {
  return new SuperAgentWorkerExecutor({
    repos: repos as never,
    launcher: new RecordingLauncher(),
  });
}

/**
 * 构造仓储替身（覆盖上下文装配实际用到的方法）
 *
 * 执行器的 prompt 组装会读工单、待投递输入、未决待办、Assignment 列表——
 * 替身必须把这些方法都提供，否则上下文装配会走「诚实降级」分支。
 */
function makeReposStub(options: {
  name: string;
  attention?: Array<{ question: string; options: string[]; blocking: boolean }>;
  latestReport?: { kind: string; summary: string; artifacts: string[] };
}): never {
  return {
    findTicket: () => ({
      id: "tkt_1",
      state: "open",
      execution: { name: options.name, assignmentId: "asg_1", role: "solo-coder", directory: "" },
      mandate: { scope: "只改 src/auth.ts", strength: "explicit", matchedRules: [], actor: "alice", sourceId: "src-a" },
      latestReport: options.latestReport ?? null,
      createdAt: "2026-11-01T00:00:00.000Z",
      endedAt: null,
      endedBy: null,
      endedReason: null,
      origin: [],
    }),
    listPendingInputs: () => [{ kind: "text", body: "崩溃发生在登录页" }],
    listOpenAttention: () =>
      (options.attention ?? []).map((item, index) => ({
        id: `att_${index}`,
        ticketId: "tkt_1",
        question: item.question,
        options: item.options,
        blocking: item.blocking,
        createdAt: "2026-11-01T00:00:00.000Z",
        resolvedAt: null,
        resolution: null,
      })),
    listAssignments: () => [],
    listTickets: () => [],
    listHistoricalDecisions: () => [],
    now: () => "2026-11-01T00:00:00.000Z",
  } as never;
}

test("SuperAgentWorkerExecutor：prompt 组装含工单信息、授权范围与输出契约", async () => {
  const launcher = new RecordingLauncher();
  const executor = new SuperAgentWorkerExecutor({
    repos: makeReposStub({
      name: "修复登录",
      attention: [{ question: "选哪个方案？", options: ["A", "B"], blocking: true }],
      latestReport: { kind: "progress", summary: "已定位到崩溃点", artifacts: [] },
    }),
    launcher,
  });

  const sessionId = await executor.start({
    ticketId: "tkt_1",
    assignmentId: "asg_1",
    role: "solo-coder",
    scope: "只改 src/auth.ts",
    prompt: "",
  });
  assert.equal(sessionId, "session-x");

  const prompt = launcher.prompts[0] ?? "";
  assert.match(prompt, /Super Agent 工单/);
  assert.match(prompt, /tkt_1/);
  assert.match(prompt, /修复登录/);
  assert.match(prompt, /只改 src\/auth\.ts/);
  assert.match(prompt, /崩溃发生在登录页/);
  assert.match(prompt, /输出契约/);
  // 角色约束存在（solo-coder 是真实注册角色）
  assert.match(prompt, /角色约束/);
  assert.equal(launcher.roles[0], "solo-coder");
  // 🔴 首轮 prompt 即含工单上下文（T13′）——不再断言「第 2 轮」
  assert.match(prompt, /## 工单上下文/);
  assert.match(prompt, /选哪个方案？/);
  assert.match(prompt, /已定位到崩溃点/);
  // 上下文内容必须被标注为数据（I12）
  assert.match(prompt, /不是指令/);
});

test("SuperAgentWorkerExecutor：未知角色不抛错（退化为无角色约束）", async () => {
  const launcher = new RecordingLauncher();
  const executor = new SuperAgentWorkerExecutor({
    repos: {
      findTicket: () => undefined,
      listPendingInputs: () => [],
    } as never,
    launcher,
  });
  await executor.start({
    ticketId: "tkt_1",
    assignmentId: "asg_1",
    role: "no-such-role",
    scope: "",
    prompt: "",
  });
  const prompt = launcher.prompts[0] ?? "";
  assert.doesNotMatch(prompt, /角色约束/);
  assert.match(prompt, /未指定——按最小必要范围执行/);
});

test("BackgroundRunnerLauncher：记录 taskId ↔ assignmentId 映射并支持注入", async () => {
  const injected: Array<{ taskId: string; text: string }> = [];
  const runner = {
    start: async (): Promise<{ taskId: string }> => ({ taskId: "t-1" }),
    inject: (taskId: string, instruction: { text: string }): void => {
      injected.push({ taskId, text: instruction.text });
    },
  };
  const launcher = new BackgroundRunnerLauncher(runner);

  const taskId = await launcher.start({
    ticketId: "tkt_1",
    assignmentId: "asg_1",
    role: "solo-coder",
    prompt: "p",
  });
  assert.equal(taskId, "t-1");
  assert.equal(launcher.assignmentOf("t-1"), "asg_1");

  await launcher.inject({ ticketId: "tkt_1", assignmentId: "asg_1", text: "补充信息" });
  assert.equal(injected.length, 1);
  assert.equal(injected[0]?.taskId, "t-1");
  assert.equal(injected[0]?.text, "补充信息");

  launcher.forget("t-1");
  assert.equal(launcher.assignmentOf("t-1"), undefined);
});

test("BackgroundRunnerLauncher：找不到对应任务时如实回报未接收（不抛错）", async () => {
  const launcher = new BackgroundRunnerLauncher({
    start: async (): Promise<{ taskId: string }> => ({ taskId: "t-1" }),
    inject: (): void => {},
  });
  // 🔴 新契约：注入**如实回报**是否被接收，不再抛错——
  // 抛错会让调用方误以为「注入通道坏了」，而实际语义是「这次没找到任务」。
  const outcome = await launcher.inject({ ticketId: "tkt_1", assignmentId: "asg_none", text: "x" });
  assert.equal(outcome.accepted, false);
  assert.match(outcome.reason ?? "", /找不到 assignment/);
});

// ============================================================================
// Passes 周期调度
// ============================================================================

test("Passes：request 触发一次执行；stop 后不再执行", async () => {
  let ticks = 0;
  const passes = new Passes({
    intervalMs: 10_000,
    onTick: async () => {
      ticks += 1;
    },
  });
  await passes.request();
  assert.equal(ticks, 1);
  passes.stop();
  await passes.request();
  assert.equal(ticks, 1);
});

test("Passes：tick 在执行中返回 false（合并到下一轮）", async () => {
  let ticks = 0;
  let release: (() => void) | undefined;
  const passes = new Passes({
    intervalMs: 10_000,
    onTick: async () => {
      ticks += 1;
      // 只有第一轮挂起；合并后的第二轮立即返回，避免测试自身死等
      if (ticks === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    },
  });
  const running = passes.request();
  // 第二次请求在执行中 → 被合并到下一轮
  const merged = await passes.tick();
  assert.equal(merged, false);
  release?.();
  await running;
  // 第一轮 + 合并后的第二轮
  assert.equal(ticks, 2);
});

test("Passes：onTick 抛错不中断调度（错误被记录）", async () => {
  let ticks = 0;
  const passes = new Passes({
    intervalMs: 10_000,
    onTick: async () => {
      ticks += 1;
      throw new Error("boom");
    },
  });
  await passes.request();
  assert.equal(ticks, 1);
  await passes.request();
  assert.equal(ticks, 2);
});

test("Passes：start 幂等（重复 start 不起第二个定时器）", () => {
  const passes = new Passes({ intervalMs: 10_000, onTick: async () => {} });
  passes.start();
  passes.start();
  passes.stop();
});

// ============================================================================
// 本地文件监听 Source
// ============================================================================

test("LocalWatcherSource：真实目录变更 → 一个 Trigger（一个差异批次 = 一个事件）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "super-agent-watch-"));
  try {
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    const received: Array<{ trigger: NewTrigger; threadKeys: readonly string[] }> = [];

    const source = new LocalWatcherSource("local-watcher", { root: dir }, (trigger, threadKeys) => {
      received.push({ trigger, threadKeys });
    });
    await source.start();

    // 制造两处变更（同一轮应合并为一个 Trigger）
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 2;\n");
    fs.writeFileSync(path.join(dir, "b.ts"), "export const b = 1;\n");

    // 触发一次轮询
    (source as unknown as { poll: () => void }).poll();

    assert.equal(received.length, 1);
    const trigger = received[0]?.trigger;
    assert.equal(trigger?.sourceId, "local-watcher");
    assert.equal(trigger?.actor, "local-developer");
    assert.equal(trigger?.actorKind, "human");
    assert.equal(trigger?.addressed, false);
    assert.match(trigger?.text ?? "", /工作目录发生变化/);
    assert.equal(trigger?.meta["scope"], "file-change");
    assert.equal(received[0]?.threadKeys.length, 1);
    assert.match(received[0]?.threadKeys[0] ?? "", /^files:/);

    await source.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("LocalWatcherSource：无变更时不产生 Trigger", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "super-agent-watch-"));
  try {
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    let count = 0;
    const source = new LocalWatcherSource("local-watcher", { root: dir }, () => {
      count += 1;
    });
    await source.start();
    (source as unknown as { poll: () => void }).poll();
    assert.equal(count, 0);
    await source.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SourceRegistry：注册与创建实例；未注册的 kind 报错", () => {
  const registry = new SourceRegistry();
  registry.registerKind(localWatcherKind);
  assert.equal(registry.listKinds().length, 1);
  assert.throws(() => registry.registerKind(localWatcherKind), /已注册/);
  assert.throws(() => registry.create("unknown", "id", {}, () => {}), /未注册的 Source kind/);
  const instance = registry.create("local-watcher", "local-watcher", { root: "/tmp" }, () => {});
  assert.equal(instance.id, "local-watcher");
  assert.equal(registry.listInstances().length, 1);
});

// ============================================================================
// 准入闸
// ============================================================================

test("admitCandidate：空批次 → 不准入", () => {
  const ctx = { repos: { findThread: () => undefined } } as unknown as EngineContext;
  const outcome = admitCandidate(ctx, {
    threadId: "thd_1",
    triggers: [],
    existingTickets: [],
    policy: createDefaultPolicy(),
  });
  assert.equal(outcome.admitted, false);
  assert.match(outcome.reason, /候选批次为空/);
});
