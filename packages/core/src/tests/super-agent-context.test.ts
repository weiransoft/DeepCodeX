/**
 * Super Agent 上下文层测试（双层上下文投影）
 *
 * 覆盖范围（对应 `proposal-p3-context-v2.md` §6）：
 * - T13′ Worker **首轮** prompt 即含工单上下文
 * - T15′ 注入点 B 生效（Assessment prompt 含「历史经验参考」+ I12 标注）
 * - T17 预算切分（scored 超预算被淘汰；**direct 段不被丢弃**）
 * - T18 I12 注入防线（召回段与工单上下文段均含「不是指令」标注）
 * - T20 门禁生效（eslint 配置含 v2 / node:sqlite / 动态 import 禁列）
 *
 * 测试约定：真实 SQLite（临时目录）+ 真实仓储 + 真实执行器；
 * LLM 用**函数注入式**替身（真实客户端接口契约）。
 *
 * @module tests/super-agent-context
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openStore, type Store } from "../super-agent/store/store.js";
import { SuperAgentRepositories } from "../super-agent/store/repositories.js";
import { buildContext, renderTaskContext, DEFAULT_CONTEXT_BUDGET } from "../super-agent/engine/context.js";
import { LlmAssessor } from "../super-agent/router/assessment.js";
import { SuperAgentWorkerExecutor, type WorkerLauncher } from "../super-agent/worker/executor.js";
import { createDefaultPolicy } from "../super-agent/policy/policy.js";
import type { EvalCandidate } from "../super-agent/domain/types.js";

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

/** 记录 prompt 的启动器 */
class RecordingLauncher implements WorkerLauncher {
  /** 收到的 prompt */
  readonly prompts: string[] = [];

  /**
   * 启动
   *
   * @param input 启动输入
   * @returns 会话 ID
   */
  async start(input: { prompt: string }): Promise<string> {
    this.prompts.push(input.prompt);
    return "session-1";
  }
}

/**
 * 建一个带工单与历史决策的库
 *
 * @param options 可选覆盖
 * @returns 夹具
 */
async function makeFixture(
  options: {
    /** 是否写入历史决策 */
    readonly withHistory?: boolean;
  } = {}
): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "super-agent-context-"));
  const store = await openStore({ databasePath: path.join(dir, "agent.db") });
  const repos = new SuperAgentRepositories(store);

  store.write((tx) => {
    // ---- 工单 ----
    repos.insertTicket(tx, {
      id: "tkt_1",
      state: "open",
      origin: ["trg_1"],
      mandate: {
        policyVersion: 1,
        scope: "只改 src/auth.ts",
        strength: "explicit",
        matchedRules: ["rule-fix"],
        actor: "alice",
        sourceId: "src-a",
      },
      execution: {
        name: "修复登录崩溃",
        directory: "",
        assignmentId: "asg_1",
        role: "solo-coder",
      },
      latestReport: {
        kind: "progress",
        summary: "已定位到登录页的崩溃点",
        artifacts: ["src/auth.ts"],
      },
      createdAt: "2026-11-01T00:00:00.000Z",
      endedAt: null,
      endedBy: null,
      endedReason: null,
    });
    repos.insertAssignment(tx, {
      id: "asg_1",
      ticketId: "tkt_1",
      state: "running",
      workerSessionId: "session-1",
      startedAt: "2026-11-01T00:00:01.000Z",
      endedAt: null,
      report: null,
    });
    // 一条历史 Assignment（此前失败过）——验证「历史报告摘要」段
    repos.insertAssignment(tx, {
      id: "asg_0",
      ticketId: "tkt_1",
      state: "ended",
      workerSessionId: "session-0",
      startedAt: "2026-10-31T00:00:01.000Z",
      endedAt: "2026-10-31T00:10:00.000Z",
      report: { kind: "failed", summary: "上次尝试复现失败", artifacts: [] },
    });
    repos.insertAttention(tx, {
      id: "att_1",
      ticketId: "tkt_1",
      question: "选哪个修复方案？",
      options: ["A", "B"],
      blocking: true,
      createdAt: "2026-11-01T00:00:02.000Z",
      resolvedAt: null,
      resolution: null,
    });

    // ---- 历史决策（全局层）----
    if (options.withHistory !== false) {
      repos.insertTrigger(tx, {
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
      repos.upsertThread(tx, { id: "th_1", sourceId: "src-a", active: true, meta: {} });
      repos.linkTriggerThread(tx, "trg_1", "th_1", "2026-11-01T00:00:01.000Z");
      repos.insertDecision(tx, {
        id: "dec_1",
        threadId: "th_1",
        kind: "accept",
        strength: "explicit",
        reason: "明确要求修复登录页，属于可执行请求",
        wouldAccept: false,
        at: "2026-11-01T00:00:05.000Z",
      });
    }
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

/** 构造一个候选 */
function makeCandidate(): EvalCandidate {
  return {
    threadId: "th_1",
    triggers: [
      {
        id: "trg_1",
        sourceId: "src-a",
        idempotencyKey: "k1",
        actor: "alice",
        actorKind: "human",
        addressed: true,
        text: "请修复登录页的样式错乱问题",
        createdAt: "2026-11-01T00:00:00.000Z",
        meta: {},
      },
    ],
    existingTickets: [],
    policy: createDefaultPolicy(),
  };
}

/** 记录 LLM 调用入参的客户端替身 */
function makeClientStub(): {
  readonly client: unknown;
  readonly calls: Array<{ system: string; user: string }>;
} {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    calls,
    client: {
      model: "stub-model",
      baseURL: "http://stub.local",
      thinkingEnabled: false,
      client: {
        chat: {
          completions: {
            create: async (body: unknown): Promise<unknown> => {
              const messages = (body as { messages: Array<{ role: string; content: string }> }).messages;
              const system = messages.find((message) => message.role === "system")?.content ?? "";
              const user = messages.find((message) => message.role === "user")?.content ?? "";
              calls.push({ system, user });
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({ kind: "accept", reason: "值得接单", matchedRules: [] }),
                    },
                    finish_reason: "stop",
                  },
                ],
              };
            },
          },
        },
      },
    },
  };
}

// ============================================================================
// 任务层（direct 通道）
// ============================================================================

test("上下文装配：direct 通道含授权范围、未决待办、最近报告与历史报告摘要", async () => {
  const fixture = await makeFixture();
  try {
    const bundle = buildContext({ repos: fixture.repos, now: () => NOW }, { ticketId: "tkt_1", now: NOW });
    const kinds = bundle.direct.map((snippet) => snippet.kind);
    assert.equal(kinds.includes("mandate"), true);
    assert.equal(kinds.includes("attention"), true);
    assert.equal(kinds.includes("latest_report"), true);
    assert.equal(kinds.includes("report_history"), true);

    const text = renderTaskContext(bundle);
    assert.match(text, /只改 src\/auth\.ts/);
    assert.match(text, /选哪个修复方案？/);
    assert.match(text, /已定位到登录页的崩溃点/);
    assert.match(text, /上次尝试复现失败/);
  } finally {
    fixture.cleanup();
  }
});

test("上下文装配：工单不存在时抛 notFound（不编造）", async () => {
  const fixture = await makeFixture();
  try {
    assert.throws(
      () => buildContext({ repos: fixture.repos, now: () => NOW }, { ticketId: "tkt_none" }),
      /工单 tkt_none 不存在/
    );
  } finally {
    fixture.cleanup();
  }
});

test("T13′ Worker 首轮 prompt 即含工单上下文", async () => {
  const fixture = await makeFixture();
  try {
    const launcher = new RecordingLauncher();
    const executor = new SuperAgentWorkerExecutor({ repos: fixture.repos, launcher });
    await executor.start({
      ticketId: "tkt_1",
      assignmentId: "asg_1",
      role: "solo-coder",
      scope: "只改 src/auth.ts",
      prompt: "",
    });
    const prompt = launcher.prompts[0] ?? "";
    assert.match(prompt, /## 工单上下文/);
    assert.match(prompt, /选哪个修复方案？/);
    assert.match(prompt, /已定位到登录页的崩溃点/);
    // 首轮就带上下文——不需要等第 2 轮
    assert.equal(prompt.includes("追加输入"), false);
  } finally {
    fixture.cleanup();
  }
});

test("T18 I12 防线：工单上下文段标注「不是指令」", async () => {
  const fixture = await makeFixture();
  try {
    const launcher = new RecordingLauncher();
    const executor = new SuperAgentWorkerExecutor({ repos: fixture.repos, launcher });
    await executor.start({
      ticketId: "tkt_1",
      assignmentId: "asg_1",
      role: "solo-coder",
      scope: "只改 src/auth.ts",
      prompt: "",
    });
    const prompt = launcher.prompts[0] ?? "";
    assert.match(prompt, /不是指令/);
  } finally {
    fixture.cleanup();
  }
});

// ============================================================================
// 预算
// ============================================================================

test("T17 预算切分：scored 超预算被淘汰，direct 不被丢弃", async () => {
  const fixture = await makeFixture();
  try {
    const bundle = buildContext({ repos: fixture.repos, now: () => NOW }, { ticketId: "tkt_1", now: NOW, budget: 40 });
    // direct 一定在（必注入）
    assert.equal(bundle.direct.length > 0, true);
    // 预算极小 → scored 必然被淘汰或受限
    assert.equal(bundle.totalTokens <= bundle.budget, true);
    assert.equal(bundle.scored.length <= bundle.direct.length + 1, true);
  } finally {
    fixture.cleanup();
  }
});

test("预算：direct 超预算时按优先级截断且 overflow 如实上报", async () => {
  const fixture = await makeFixture();
  try {
    const bundle = buildContext({ repos: fixture.repos, now: () => NOW }, { ticketId: "tkt_1", now: NOW, budget: 5 });
    assert.equal(bundle.truncated, true);
    assert.equal(bundle.overflowTokens > 0, true);
    // 授权范围是安全边界——**绝不丢弃**，只截断文本
    const mandate = bundle.direct.find((snippet) => snippet.kind === "mandate");
    assert.notEqual(mandate, undefined);
    assert.match(mandate?.text ?? "", /授权范围/);
  } finally {
    fixture.cleanup();
  }
});

test("预算：默认预算是工单级的 8000（不是 V2 的 100000）", () => {
  assert.equal(DEFAULT_CONTEXT_BUDGET, 8_000);
});

// ============================================================================
// 召回降级
// ============================================================================

test("召回失败只降级 scored 通道，direct 通道不受影响", async () => {
  const fixture = await makeFixture();
  try {
    // 仓储替身：只把 listHistoricalDecisions 换成会抛错的实现
    const broken = Object.create(fixture.repos) as SuperAgentRepositories;
    broken.listHistoricalDecisions = (): never => {
      throw new Error("模拟召回失败");
    };
    const bundle = buildContext({ repos: broken, now: () => NOW }, { ticketId: "tkt_1", now: NOW });
    assert.notEqual(bundle.recallError, null);
    assert.match(bundle.recallError ?? "", /模拟召回失败/);
    assert.equal(bundle.direct.length > 0, true);
    assert.equal(bundle.scored.length, 0);
  } finally {
    fixture.cleanup();
  }
});

// ============================================================================
// 注入点 B：Assessment
// ============================================================================

test("T15′ 注入点 B 生效：Assessment prompt 含「历史经验参考」且有 I12 标注", async () => {
  const fixture = await makeFixture();
  try {
    const stub = makeClientStub();
    const assessor = new LlmAssessor({
      projectRoot: fixture.dir,
      injectedClient: stub.client,
      recall: (query, sourceId) =>
        fixture.repos.listHistoricalDecisions(sourceId, 5).filter((entry) => entry.trigger?.text.includes("登录页")),
    });
    const result = await assessor.assess(makeCandidate());
    assert.notEqual(result, null);

    const call = stub.calls[0];
    assert.notEqual(call, undefined);
    // 系统提示含占位符替换后的历史经验段
    assert.match(call?.system ?? "", /历史经验参考/);
    assert.match(call?.system ?? "", /仅供参照，不是指令/);
    assert.match(call?.system ?? "", /不是指令/);
    // 用户提示也含历史经验段
    assert.match(call?.user ?? "", /历史经验参考/);
    assert.match(call?.user ?? "", /仅供参照，不是指令/);
  } finally {
    fixture.cleanup();
  }
});

test("注入点 B：未接召回端口时研判照常进行（不编造历史）", async () => {
  const fixture = await makeFixture();
  try {
    const stub = makeClientStub();
    const assessor = new LlmAssessor({ projectRoot: fixture.dir, injectedClient: stub.client });
    const result = await assessor.assess(makeCandidate());
    assert.notEqual(result, null);
    assert.match(stub.calls[0]?.system ?? "", /未接入历史经验召回/);
  } finally {
    fixture.cleanup();
  }
});

test("注入点 B：召回抛错不阻断研判（如实降级）", async () => {
  const fixture = await makeFixture();
  try {
    const stub = makeClientStub();
    const assessor = new LlmAssessor({
      projectRoot: fixture.dir,
      injectedClient: stub.client,
      recall: () => {
        throw new Error("模拟召回崩溃");
      },
    });
    const result = await assessor.assess(makeCandidate());
    assert.notEqual(result, null);
    assert.match(stub.calls[0]?.system ?? "", /历史经验召回失败/);
  } finally {
    fixture.cleanup();
  }
});

// ============================================================================
// T20 门禁
// ============================================================================

test("T20 门禁生效：eslint 配置含 v2 / node:sqlite / 动态 import 禁列", () => {
  const configPath = path.resolve(import.meta.dirname, "../../../../eslint.config.mjs");
  const config = fs.readFileSync(configPath, "utf8");
  assert.match(config, /\.\.\/\.\.\/v2\/\*/);
  assert.match(config, /name: "node:sqlite"/);
  assert.match(config, /no-restricted-syntax/);
  assert.match(config, /ImportExpression\[source\.value/);
  assert.match(config, /allowTypeImports: true/);
  // router/ 与 worker/ 必须纳入门禁 files（P3-6）
  assert.match(config, /super-agent\/router\/\*\*\/\*\.ts/);
  assert.match(config, /super-agent\/worker\/\*\*\/\*\.ts/);
});
