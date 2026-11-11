/**
 * jev 循环决策重构测试（2026-11-10，docs/dev/jev-loop-decision-20261110.md）
 *
 * 真实性边界（用户硬性规则：禁止 mock/占位/简化）：
 * - jev HTTP 边界：**本地真实 HTTP 服务器**（node:http）承载 jev 网关替身——
 *   客户端走真实 fetch/TCP/JSON 序列化与解析链路，仅服务端由测试进程提供；
 * - P5 测试：ToolExecutor / bash / 文件系统 / git 全部生产真实实现，
 *   StubLlmClient 为唯一允许的 LLM 替换点（与 eag-p5-no-progress.test.ts 同构）。
 *
 * 覆盖（用例号 TC-JEV-nn）：
 * - C1-C7 客户端契约：禁用快速失败、answers 解析（choice/score/noul）、
 *   请求体契约、401/坏 JSON/超时/断连错误分类；
 * - H1-H3 健康状态机：3 连败降级、恢复探测、single-flight（P2-7）；
 * - D1-D2 摘要构建：密钥脱敏（P1-4）、截断、questions 契约；
 * - T1-T12 TurnGuard jev 集成：stop 咨询、低置信放行、continue 清零、
 *   空轮计数、模式切换清零（P0-1）、降级首轮禁硬终止（P0-1），
 *   T7-T10 本地硬下限（真实死循环收口 / 结果变化不误杀 / 回退开关 / 连续全失败），
 *   T11-T12 session 主链路接线（真实 HTTP 决策 + decideLoopWithJev 叠加硬下限）；
 * - P1-P7 P5 执行器：jev stop → 失败返回、jev continue → 硬熔断不触发（A/B
 *   回退对照）、jev 不可用 → 回落既有无进展熔断，P4-P7 覆盖进展证据门否决误判
 *   stop、jev 主判下真实死循环仍收口、以及 DEEPCODE_JEV_EVIDENCE_GUARD=0 回退。
 *
 * @module core/tests/jev-loop-decision
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";

import { JevDecisionClient, type JevDecisionRequest } from "../common/jev-client";
import {
  JevLoopDecision,
  NUDGE_MESSAGE,
  isJevEmptyTurnVerdict,
  redactDigestText,
  type JevTurnObservation,
} from "../common/jev-loop-decision";
import { TurnGuard } from "../common/loop-guard";
import { SessionManager } from "../session";
import { LlmTaskExecutor } from "../eag/p5/index";
import type { P5TaskExecutionInput } from "../eag/p5/index";
import { StubLlmClient } from "./fixtures/stub-llm-client";

// ============================================================================
// 1. 本地 jev 网关替身（真实 HTTP 服务器）
// ============================================================================

/** 测试服务器捕获到的请求（契约断言用） */
interface CapturedRequest {
  authorization: string;
  body: JevDecisionRequest & Record<string, unknown>;
}

/** 测试服务器句柄 */
interface TestGateway {
  /** baseUrl（含 /v1，直接可配 JevDecisionClient） */
  baseUrl: string;
  /** 捕获的请求列表（时间序） */
  readonly requests: CapturedRequest[];
  /** 设置下一个响应（JSON 体 + 可选延迟毫秒）；未设置时回缺省成功响应 */
  nextResponse: { status: number; body: unknown; delayMs?: number } | null;
  close(): Promise<void>;
}

/** 网关实测成功响应形态（2026-11-10 as1 真机抓包同构） */
const SUCCESS_BODY = {
  model: "NeoHorse-Jev-4B",
  answers: {
    continue_loop: {
      type: "choice",
      choice: "continue",
      probabilities: { continue: 0.808, stop: 0.192 },
      confidence: 0.617,
    },
    is_empty_turn: {
      type: "choice",
      choice: "no",
      probabilities: { yes: 0.3, no: 0.7 },
      confidence: 0.4,
    },
  },
  input_tokens: 37,
};

/** 每轮都判定 stop 的高置信响应（进展证据门否决误判用；缺省仍为 SUCCESS_BODY） */
const ALWAYS_STOP_BODY = {
  model: "NeoHorse-Jev-4B",
  answers: {
    continue_loop: { type: "choice", choice: "stop", probabilities: {}, confidence: 0.95 },
    progress: { type: "score", score: 0.0, legend: {}, probabilities: {}, confidence: 0.9 },
  },
  input_tokens: 30,
};

/** 启动本地 jev 网关替身（真实 TCP 监听）；defaultBody 仅影响「无一次性覆盖」时的缺省响应 */
async function startTestGateway(defaultBody: unknown = SUCCESS_BODY): Promise<TestGateway> {
  const state: { next: TestGateway["nextResponse"] } = { next: null };
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      captured.push({ authorization: String(req.headers.authorization ?? ""), body: body as never });
      const next = state.next;
      state.next = null;
      const respond = () => {
        if (next != null) {
          res.writeHead(next.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(next.body));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(defaultBody));
        }
      };
      if (next?.delayMs != null) {
        setTimeout(respond, next.delayMs);
      } else {
        respond();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: captured,
    get nextResponse() {
      return state.next;
    },
    set nextResponse(value) {
      state.next = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 构造指向测试网关的决策服务 */
function makeJev(gateway: TestGateway, timeoutMs = 1000): JevLoopDecision {
  return new JevLoopDecision(
    new JevDecisionClient({ baseUrl: gateway.baseUrl, apiKey: "test-key", model: "jev", timeoutMs, enabled: true })
  );
}

/** 构造指向已关闭端口的服务（unavailable 场景） */
async function makeClosedPortJev(): Promise<JevLoopDecision> {
  // 先占住一个端口再立即关闭，得到一个确定不可达的端口
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return new JevLoopDecision(
    new JevDecisionClient({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "k",
      model: "jev",
      timeoutMs: 300,
      enabled: true,
    })
  );
}

/** 最小摘要输入 */
function digestInput(
  overrides: Partial<Parameters<JevLoopDecision["buildDigestMessages"]>[0]> = {}
): Parameters<JevLoopDecision["buildDigestMessages"]>[0] {
  return {
    mode: "task",
    turnsCompleted: 3,
    recentTurns: [],
    latestUserText: "修复单元测试",
    ...overrides,
  };
}

// ============================================================================
// 2. C 系列：客户端契约与错误分类
// ============================================================================

test("C1. 未启用（无密钥）→ decide 同步返回 unavailable 且不发起任何网络请求", async () => {
  const gateway = await startTestGateway();
  try {
    const client = new JevDecisionClient({
      baseUrl: gateway.baseUrl,
      apiKey: "",
      model: "jev",
      timeoutMs: 500,
      enabled: false,
    });
    const result = await client.decide("decision", {
      messages: [{ role: "user", content: "x" }],
      state: "s",
      questions: { q: { type: "noul", instructions: "i", criteria: {} } },
    });
    assert.equal(result.ok, false, "未启用必须判失败");
    if (!result.ok) {
      assert.equal(result.status, "unavailable");
    }
    assert.equal(gateway.requests.length, 0, "禁用状态不得产生网络请求");
  } finally {
    await gateway.close();
  }
});

test("C2. 成功响应解析：choice/score 答案字段、模型名、input_tokens、latency", async () => {
  const gateway = await startTestGateway();
  try {
    const jev = makeJev(gateway);
    gateway.nextResponse = {
      status: 200,
      body: {
        model: "NeoHorse-Jev-4B",
        answers: {
          continue_loop: {
            type: "choice",
            choice: "stop",
            probabilities: { continue: 0.2, stop: 0.8 },
            confidence: 0.6,
          },
          progress: {
            type: "score",
            score: 0.85,
            legend: { "0": "无进展", "1": "部分进展", "2": "显著进展" },
            probabilities: { "0": 0.3, "1": 0.4, "2": 0.3 },
            confidence: 0.7,
          },
        },
        input_tokens: 41,
      },
    };
    const decision = await jev.decideProgress(digestInput(), 1);
    assert.equal(decision.result.ok, true, "合法响应必须解析成功");
    if (decision.result.ok) {
      const answers = decision.result.answers;
      assert.equal(answers["continue_loop"]?.type, "choice");
      if (answers["continue_loop"]?.type === "choice") {
        assert.equal(answers["continue_loop"].choice, "stop");
        assert.equal(answers["continue_loop"].confidence, 0.6);
      }
      assert.equal(answers["progress"]?.type, "score");
      if (answers["progress"]?.type === "score") {
        assert.equal(answers["progress"].score, 0.85);
        assert.equal(answers["progress"].legend["2"], "显著进展");
      }
      assert.equal(decision.result.model, "NeoHorse-Jev-4B");
      assert.equal(decision.result.inputTokens, 41);
      assert.ok(decision.result.latencyMs >= 0);
    }
  } finally {
    await gateway.close();
  }
});

test("C3. 请求体契约：model/messages/state/questions + Bearer 鉴权（对齐实测 Pydantic 契约）", async () => {
  const gateway = await startTestGateway();
  try {
    const jev = makeJev(gateway);
    await jev.decideLoop(digestInput(), 1);
    assert.equal(gateway.requests.length, 1);
    const captured = gateway.requests[0]!;
    assert.equal(captured.authorization, "Bearer test-key");
    assert.equal(captured.body.model, "jev");
    assert.ok(Array.isArray(captured.body.messages) && captured.body.messages.length > 0, "messages 必须非空数组");
    assert.ok(typeof captured.body.state === "string" && captured.body.state.length > 0);
    // questions：choice 用字典 criteria，state 串携带观测
    const questions = captured.body.questions as Record<
      string,
      { type: string; criteria: unknown; instructions: string }
    >;
    assert.equal(questions["continue_loop"].type, "choice");
    assert.ok(
      questions["continue_loop"].criteria &&
        typeof questions["continue_loop"].criteria === "object" &&
        !Array.isArray(questions["continue_loop"].criteria),
      "choice criteria 必须为字典"
    );
    assert.equal(questions["is_empty_turn"].type, "choice");
    assert.match(captured.body.state, /mode=task/);
  } finally {
    await gateway.close();
  }
});

test("C4. HTTP 401 → http-error 分类（实测网关 unauthorized 语义）", async () => {
  const gateway = await startTestGateway();
  try {
    gateway.nextResponse = { status: 401, body: { error: { message: "unauthorized" } } };
    const jev = makeJev(gateway);
    const decision = await jev.decideLoop(digestInput(), 1);
    assert.equal(decision.result.ok, false);
    if (!decision.result.ok) {
      assert.equal(decision.result.status, "http-error");
      assert.equal(decision.result.httpStatus, 401);
    }
  } finally {
    await gateway.close();
  }
});

test("C5. 响应缺 answers / answers 含未知 type → invalid-output（脏数据不入主判）", async () => {
  const gateway = await startTestGateway();
  try {
    const jev = makeJev(gateway);
    gateway.nextResponse = { status: 200, body: { model: "NeoHorse-Jev-4B", input_tokens: 1 } };
    const r1 = await jev.decideLoop(digestInput(), 1);
    assert.ok(!r1.result.ok && r1.result.status === "invalid-output");
    gateway.nextResponse = { status: 200, body: { model: "m", answers: { q: { type: "alien" } }, input_tokens: 1 } };
    const r2 = await jev.decideLoop(digestInput(), 2);
    assert.ok(!r2.result.ok && r2.result.status === "invalid-output");
  } finally {
    await gateway.close();
  }
});

test("C6. 超时 → timeout 分类（AbortSignal 全程可中断）", async () => {
  const gateway = await startTestGateway();
  try {
    gateway.nextResponse = { status: 200, body: SUCCESS_BODY, delayMs: 500 };
    const jev = makeJev(gateway, 100); // 100ms 超时 < 500ms 延迟
    const startedAt = Date.now();
    const decision = await jev.decideLoop(digestInput(), 1);
    const elapsed = Date.now() - startedAt;
    assert.ok(!decision.result.ok && decision.result.status === "timeout");
    assert.ok(elapsed < 400, `超时应及时触发（实际 ${elapsed}ms）`);
  } finally {
    await gateway.close();
  }
});

test("C7. 连接不可达 → unavailable 分类", async () => {
  const jev = await makeClosedPortJev();
  const decision = await jev.decideLoop(digestInput(), 1);
  assert.ok(!decision.result.ok && decision.result.status === "unavailable");
});

// ============================================================================
// 3. H 系列：健康状态机（降级 / 恢复 / single-flight）
// ============================================================================

test("H1. 连续 3 次失败 → degraded；恢复探测成功 → healthy", async () => {
  const gateway = await startTestGateway();
  try {
    const jev = makeJev(gateway);
    // 网关替身的 nextResponse 为一次性消费（每次请求后清空回缺省成功），
    // 每次失败调用前必须重设，否则后续调用会收到成功响应。
    gateway.nextResponse = { status: 500, body: { error: "boom" } };
    await jev.decideLoop(digestInput(), 1);
    gateway.nextResponse = { status: 500, body: { error: "boom" } };
    await jev.decideLoop(digestInput(), 2);
    assert.equal(jev.getHealth(), "healthy", "连续 2 次失败仍在容错窗口内");
    gateway.nextResponse = { status: 500, body: { error: "boom" } };
    await jev.decideLoop(digestInput(), 3);
    assert.equal(jev.getHealth(), "degraded", "连续 3 次失败必须降级");
    // 恢复探测：degraded 后下一次调用作为探测，成功即恢复
    gateway.nextResponse = { status: 200, body: SUCCESS_BODY };
    const probe = await jev.decideLoop(digestInput(), 4);
    assert.equal(jev.getHealth(), "healthy", "探测成功必须恢复 healthy");
    assert.equal(probe.result.ok, true, "探测成功的结果必须放行");
  } finally {
    await gateway.close();
  }
});

test("H2. degraded 期间并发探测 single-flight：多个调用只发一个探测请求（P2-7）", async () => {
  const gateway = await startTestGateway();
  try {
    const jev = makeJev(gateway);
    for (let i = 0; i < 3; i++) {
      gateway.nextResponse = { status: 500, body: { error: "boom" } };
      await jev.decideLoop(digestInput(), i + 1);
    }
    assert.equal(jev.getHealth(), "degraded");
    assert.equal(gateway.requests.length, 3);
    // 并发 3 个探测：single-flight 应只发 1 个真实请求
    gateway.nextResponse = { status: 200, body: SUCCESS_BODY, delayMs: 50 };
    const probes = await Promise.all([
      jev.decideLoop(digestInput(), 10),
      jev.decideLoop(digestInput(), 11),
      jev.decideLoop(digestInput(), 12),
    ]);
    assert.equal(gateway.requests.length, 4, "single-flight：并发探测只允许 1 个真实请求");
    assert.ok(
      probes.every((p) => p.result.ok),
      "共享探测结果必须放行所有并发调用"
    );
    assert.equal(jev.getHealth(), "healthy");
  } finally {
    await gateway.close();
  }
});

test("H3. degraded 探测失败：结果判失败、保持 degraded、不产生请求风暴", async () => {
  const gateway = await startTestGateway();
  try {
    const jev = makeJev(gateway);
    for (let i = 0; i < 3; i++) {
      gateway.nextResponse = { status: 503, body: {} };
      await jev.decideLoop(digestInput(), i + 1);
    }
    assert.equal(jev.getHealth(), "degraded");
    const before = gateway.requests.length;
    gateway.nextResponse = { status: 503, body: {} };
    const probe = await jev.decideLoop(digestInput(), 9);
    assert.ok(!probe.result.ok, "探测失败必须判失败");
    assert.equal(jev.getHealth(), "degraded", "探测失败保持降级");
    assert.equal(gateway.requests.length, before + 1, "探测恰发 1 个请求，无风暴");
  } finally {
    await gateway.close();
  }
});

// ============================================================================
// 4. D 系列：摘要构建（脱敏 P1-4 / questions 契约）
// ============================================================================

test("D1. 摘要强制脱敏：sk- 密钥 / Bearer / password 赋值 / PEM 私钥全部 REDACTED，超长截断", () => {
  const redacted = redactDigestText(
    "配置 sk-abc123456789xyz 后 Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcDEF123 使用 password=hunter2 部署"
  );
  assert.ok(!redacted.includes("sk-abc123456789xyz"), "sk 密钥不得进摘要");
  assert.ok(!redacted.includes("hunter2"), "password 赋值不得进摘要");
  assert.ok(redacted.includes("[REDACTED]"));

  const pem = redactDigestText("-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----");
  assert.ok(!pem.includes("MIIB"), "PEM 私钥体不得进摘要");

  const long = redactDigestText("a".repeat(500));
  assert.ok(long.length <= 205, `超长文本必须截断（实际 ${long.length}）`);
});

test("D2. buildDigestMessages：任务目标首位 + 每轮一条摘要 + 轮数窗口 6", () => {
  const jev = new JevLoopDecision(
    new JevDecisionClient({
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "k",
      model: "jev",
      timeoutMs: 100,
      enabled: false,
    })
  );
  const turns: JevTurnObservation[] = [];
  for (let i = 0; i < 8; i++) {
    turns.push({
      visibleText: `第 ${i} 轮说明`,
      hadToolCalls: true,
      toolSucceededCount: 1,
      toolFailedCount: 0,
      toolCallDigests: [`bash:ok`],
    });
  }
  const messages = jev.buildDigestMessages(digestInput({ recentTurns: turns }));
  // 任务目标 1 条 + 最近 6 轮各 1 条 = 7 条
  assert.equal(messages.length, 7, "摘要最多携带最近 6 轮观测");
  assert.match(messages[0]!.content, /任务目标/);
  assert.match(messages[1]!.content, /第 2 轮/, "窗口应丢弃最旧两轮（8 轮只留 3-7）");
  assert.match(messages[6]!.content, /第 7 轮/);
  // 工具行含成败计数与签名
  assert.match(messages[1]!.content, /成功1次\/失败0次/);
  assert.match(messages[1]!.content, /bash:ok/);
});

// ============================================================================
// 5. T 系列：TurnGuard jev 集成
// ============================================================================

/** 构造 jev answers 快捷方式 */
function choiceAnswers(continueLoop: string, confidence: number, isEmptyTurn?: string): Record<string, never> {
  return {
    continue_loop: { type: "choice", choice: continueLoop, probabilities: {}, confidence },
    ...(isEmptyTurn != null
      ? { is_empty_turn: { type: "choice", choice: isEmptyTurn, probabilities: {}, confidence: 0.9 } }
      : {}),
  } as never;
}

test("T1. jev stop（置信度≥0.5）→ consult_user_loop_stop 暂停咨询（可恢复，不硬终止）", () => {
  const guard = new TurnGuard({
    maxConsecutiveFailedTurns: 3,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
    maxConsecutiveEmptyTurns: 5,
  });
  const decision = guard.evaluateJevDecision(choiceAnswers("stop", 0.9) as never);
  assert.equal(decision.allow, false);
  assert.equal(decision.action, "consult_user_loop_stop");
  assert.match(decision.reason, /jev/);
  assert.equal(guard.getState().jevConsecutiveStops, 1);
});

test("T2. jev stop 但置信度<0.5 → 放行（低置信不动作）", () => {
  const guard = new TurnGuard({
    maxConsecutiveFailedTurns: 3,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
    maxConsecutiveEmptyTurns: 5,
  });
  const decision = guard.evaluateJevDecision(choiceAnswers("stop", 0.3) as never);
  assert.equal(decision.allow, true, "低置信 stop 必须放行");
});

test("T3. jev continue → 清零连续 stop 计数（P1-5 清零语义）", () => {
  const guard = new TurnGuard({
    maxConsecutiveFailedTurns: 3,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
    maxConsecutiveEmptyTurns: 5,
  });
  guard.evaluateJevDecision(choiceAnswers("stop", 0.9) as never);
  guard.evaluateJevDecision(choiceAnswers("continue", 0.9) as never);
  assert.equal(guard.getState().jevConsecutiveStops, 0, "continue 必须清零连续 stop 计数");
});

test("T4. jev is_empty_turn=yes 连续 3 次 → consult_user_empty_turns；no → 清零", () => {
  const guard = new TurnGuard({
    maxConsecutiveFailedTurns: 3,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
    maxConsecutiveEmptyTurns: 3,
  });
  assert.equal(guard.evaluateJevDecision(choiceAnswers("continue", 0.9, "yes") as never).allow, true);
  assert.equal(guard.evaluateJevDecision(choiceAnswers("continue", 0.9, "yes") as never).allow, true);
  const third = guard.evaluateJevDecision(choiceAnswers("continue", 0.9, "yes") as never);
  assert.equal(third.allow, false, "连续 3 次空轮判定必须暂停咨询");
  assert.equal(third.action, "consult_user_empty_turns");
  // 用户放行后清零（P1-5：acknowledgeAndContinue 统一清零）
  guard.acknowledgeAndContinue();
  assert.equal(guard.getState().consecutiveEmptyTurns, 0);
  assert.equal(guard.evaluateJevDecision(choiceAnswers("continue", 0.9, "no") as never).allow, true);
});

test("T5. 模式切换清零（P0-1）：jev 主判期间累积的 stale 计数在切回 heuristic 时清零", () => {
  const guard = new TurnGuard({
    maxConsecutiveFailedTurns: 3,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
    maxConsecutiveEmptyTurns: 3,
  });
  // 先进入 jev 主判模式（真实时序：jev 决策成功 → setJevPrimary(true)），
  // 再模拟主判期间累积：2 轮全失败 + 2 轮空转 + 1 次 jev stop
  guard.setJevPrimary(true);
  guard.recordTurn({
    tokensUsed: 10,
    hadToolCalls: true,
    allToolsFailed: true,
    hadVisibleText: false,
    succeededCount: 0,
  });
  guard.recordTurn({
    tokensUsed: 10,
    hadToolCalls: true,
    allToolsFailed: true,
    hadVisibleText: false,
    succeededCount: 0,
  });
  guard.evaluateJevDecision(choiceAnswers("stop", 0.9) as never);
  const before = guard.getState();
  assert.ok(before.consecutiveFailedTurns > 0 || before.jevConsecutiveStops > 0);
  // 切回 heuristic：计数全部清零（新预算窗口）
  guard.setJevPrimary(false);
  const after = guard.getState();
  assert.equal(after.consecutiveFailedTurns, 0, "模式切换必须清零连续失败计数");
  assert.equal(after.consecutiveEmptyTurns, 0, "模式切换必须清零空转计数");
  assert.equal(after.jevConsecutiveStops, 0, "模式切换必须清零 jev stop 计数");
});

test("T6. 降级首轮禁硬终止（P0-1）：stale 签名队列的 terminate 降级为 consult", () => {
  const guard = new TurnGuard({
    maxConsecutiveFailedTurns: 3,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
    maxConsecutiveEmptyTurns: 5,
  });
  // jev 主判期间留下 3 次相同调用签名（jev 模式下不触发硬编码检测）
  guard.setJevPrimary(true);
  const toolCall = { name: "bash", arguments: { command: "true" } };
  guard.recordToolCalls([toolCall], []);
  guard.recordToolCalls([toolCall], []);
  guard.recordToolCalls([toolCall], []);
  assert.equal(guard.decideBeforeIteration().allow, true, "jev 主判期间硬编码检测不得触发");
  // 降级切回 heuristic：签名队列已清空（setJevPrimary 语义）+ 首轮 terminate 禁用
  guard.setJevPrimary(false);
  const first = guard.decideBeforeIteration();
  assert.equal(first.allow, true, "签名队列清空后首轮不应有 stale 死循环判定");
  // 再制造真实 3 次重复：降级首轮 terminate 降级为 consult_user_loop_stop
  guard.recordToolCalls([toolCall], []);
  guard.recordToolCalls([toolCall], []);
  guard.recordToolCalls([toolCall], []);
  // suppressTerminateOnNextDecision 已在 T5 切换后……此处在 setJevPrimary(false) 后
  // 首轮 decideBeforeIteration 已消费标志；重新切换验证降级路径
  guard.setJevPrimary(true);
  guard.setJevPrimary(false);
  guard.recordToolCalls([toolCall], []);
  guard.recordToolCalls([toolCall], []);
  guard.recordToolCalls([toolCall], []);
  const downgraded = guard.decideBeforeIteration();
  assert.equal(downgraded.action, "consult_user_loop_stop", "降级首轮 terminate 必须降级为可恢复咨询");
  assert.notEqual(downgraded.action, "terminate_model_loop", "降级首轮禁止不可恢复硬终止");
  // 标志一次性消费：后续判定恢复正常 heuristic 语义（真实重复 → terminate）
  const second = guard.decideBeforeIteration();
  assert.equal(second.action, "terminate_model_loop", "标志消费后恢复正常 heuristic 硬终止");
});

// ---------------------------------------------------------------------------
// T7-T10：jev 主判期间的本地硬下限（2026-11-10 空转/误判双修）
// ---------------------------------------------------------------------------

test("T7. jev 主判期间相同工具+相同参数+相同结果 → 本地硬下限可恢复咨询", () => {
  const guard = new TurnGuard({
    maxConsecutiveFailedTurns: 3,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
    maxConsecutiveEmptyTurns: 3,
  });
  const call = { name: "bash", arguments: { command: "true" } };
  for (let i = 0; i < 3; i += 1) guard.recordToolCalls([call], ["same-result"]);
  const decision = guard.decideJevHardFloor();
  assert.equal(decision.allow, false, "jev 放行也不能旁路本地可观测死循环证据");
  assert.equal(decision.action, "consult_user_loop_stop", "硬下限只做可恢复咨询");
  assert.notEqual(decision.action, "terminate_model_loop", "jev 主判语境下不得不可恢复硬终止");
});

test("T8. 结果签名逐轮变化（轮询等待服务就绪）→ 硬下限放行，不误杀", () => {
  const guard = new TurnGuard({
    maxConsecutiveFailedTurns: 3,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
    maxConsecutiveEmptyTurns: 3,
  });
  const call = { name: "bash", arguments: { command: "curl health" } };
  for (const signature of ["starting", "warming", "ready"]) {
    guard.recordToolCalls([call], [signature]);
  }
  assert.equal(guard.decideJevHardFloor().allow, true, "输出/状态在推进时不得判死循环");
});

test("T9. 回退开关 =0 → 本地硬下限放行（旧契约 A/B 对照）", () => {
  const previous = process.env.DEEPCODE_JEV_EVIDENCE_GUARD;
  process.env.DEEPCODE_JEV_EVIDENCE_GUARD = "0";
  try {
    const guard = new TurnGuard({ maxRepeatedToolCalls: 3, trackedToolCallHistory: 5 });
    const call = { name: "bash", arguments: { command: "true" } };
    for (let i = 0; i < 3; i += 1) guard.recordToolCalls([call], ["same-result"]);
    assert.equal(guard.decideJevHardFloor().allow, true, "回退后 jev 独占去留权，硬下限不参与");
  } finally {
    if (previous === undefined) delete process.env.DEEPCODE_JEV_EVIDENCE_GUARD;
    else process.env.DEEPCODE_JEV_EVIDENCE_GUARD = previous;
  }
});

test("T10. 连续工具全失败 → 硬下限咨询，jeV continue 不得一路放行", () => {
  const guard = new TurnGuard({
    maxConsecutiveFailedTurns: 3,
    maxRepeatedToolCalls: 0,
    trackedToolCallHistory: 5,
    maxConsecutiveEmptyTurns: 3,
  });
  for (let i = 0; i < 3; i += 1) {
    guard.recordTurn({ tokensUsed: 10, hadToolCalls: true, allToolsFailed: true });
  }
  const decision = guard.decideJevHardFloor();
  assert.equal(decision.allow, false);
  assert.equal(decision.action, "consult_user_consecutive_failures");
});

test("T11. session 接线：jev 主判放行但本地已有真实重复调用证据 → 主链路返回可恢复咨询", async () => {
  const manager = createNudgeTestManager();
  const sessionId = await manager.createSession({ text: "执行任务" });
  const gateway = await startTestGateway();
  try {
    manager.setJevDecision(makeJev(gateway));
    const guard = (manager as unknown as { getOrCreateTurnGuard(id: string): TurnGuard }).getOrCreateTurnGuard(
      sessionId
    );
    // 模拟首次启用 jev 的模式切换（语义内含签名队列清空，P0-1）；之后持续健康
    // 不再切换，签名证据可跨轮累积——这正是真实主链路时序。
    guard.setJevPrimary(true);
    const call = { name: "bash", arguments: { command: "true" } };
    for (let i = 0; i < 3; i += 1) {
      guard.recordToolCalls([call], ["same-result"]);
      guard.recordTurn({
        tokensUsed: 10,
        hadToolCalls: true,
        allToolsFailed: false,
        hadVisibleText: false,
        succeededCount: 1,
      });
    }
    const decision = await (
      manager as unknown as {
        decideLoopWithJev(id: string, g: TurnGuard): Promise<{ allow: boolean; action?: string }>;
      }
    ).decideLoopWithJev(sessionId, guard);
    assert.equal(decision.allow, false, "jev 判 continue 也不能让主链路旁路本地死循环证据");
    assert.equal(decision.action, "consult_user_loop_stop", "硬下限在主链路仍只做可恢复咨询");
    assert.ok(gateway.requests.length >= 1, "决策必须走真实 HTTP 边界并成功返回");
  } finally {
    await gateway.close();
  }
});

test("T12. session 接线：结果签名逐轮变化的轮询 → 主链路放行（正常重复不误杀）", async () => {
  const manager = createNudgeTestManager();
  const sessionId = await manager.createSession({ text: "等待服务就绪" });
  const gateway = await startTestGateway();
  try {
    manager.setJevDecision(makeJev(gateway));
    const guard = (manager as unknown as { getOrCreateTurnGuard(id: string): TurnGuard }).getOrCreateTurnGuard(
      sessionId
    );
    guard.setJevPrimary(true);
    const call = { name: "bash", arguments: { command: "curl health" } };
    for (const signature of ["starting", "warming", "ready"]) {
      guard.recordToolCalls([call], [signature]);
      guard.recordTurn({
        tokensUsed: 10,
        hadToolCalls: true,
        allToolsFailed: false,
        hadVisibleText: false,
        succeededCount: 1,
      });
    }
    const decision = await (
      manager as unknown as {
        decideLoopWithJev(id: string, g: TurnGuard): Promise<{ allow: boolean }>;
      }
    ).decideLoopWithJev(sessionId, guard);
    assert.equal(decision.allow, true, "输出/状态在推进的重复轮询不得被判死循环");
  } finally {
    await gateway.close();
  }
});

// ============================================================================
// 6. P 系列：P5 执行器 jev 集成（真实 ToolExecutor + StubLlmClient）
// ============================================================================

function createGitProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jev-p5-git-"));
  execFileSync("git", ["init", "-q"], { cwd: projectRoot, stdio: "ignore" });
  return projectRoot;
}

function cleanup(projectRoot: string): void {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // 清理失败不影响断言结论
  }
}

function buildInput(projectRoot: string): P5TaskExecutionInput {
  return Object.freeze({
    projectRoot,
    runId: "jev-run-001",
    iterIndex: 0,
    stage: "dev" as const,
    objective: "jev 循环判定用例目标",
    taskId: "T-JEV",
    taskTitle: "jev 循环判定用例",
    acceptanceCriteria: Object.freeze([]) as ReadonlyArray<string>,
    abortFlagPath: path.join(projectRoot, ".eag", "p5", "abort.flag"),
  }) as P5TaskExecutionInput;
}

/** 4 条不同命令、结果相同、工作区无变化（N1 同型空转场景） */
function noopRoundScripts(rounds: number) {
  const commands = ["true", ":", "printf ''", "echo -n ''", "test -z ''", "let x=0"];
  return Array.from({ length: rounds }, (_, i) => ({
    content: "",
    toolCalls: [{ name: "bash", args: { command: commands[i % commands.length]! } }],
  }));
}

test("P1. jev stop（置信度≥0.5）→ 任务失败返回，reason 注明 jev 判定（§4.4）", async () => {
  const projectRoot = createGitProject();
  const gateway = await startTestGateway();
  try {
    gateway.nextResponse = {
      status: 200,
      body: {
        model: "NeoHorse-Jev-4B",
        answers: {
          continue_loop: { type: "choice", choice: "stop", probabilities: {}, confidence: 0.9 },
          progress: { type: "score", score: 0.0, legend: {}, probabilities: {}, confidence: 0.8 },
        },
        input_tokens: 30,
      },
    };
    const client = new StubLlmClient(noopRoundScripts(4));
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 12,
      jevDecision: makeJev(gateway),
    });
    const result = await executor.executeTask(buildInput(projectRoot));
    assert.equal(result.success, false, "jev stop 必须提前失败返回");
    assert.match(result.error ?? "", /jev/, "失败 reason 必须注明 jev 判定来源");
    assert.equal(gateway.requests.length, 1, "第 1 轮决策后即终止，不应有后续决策请求");
  } finally {
    await gateway.close();
    cleanup(projectRoot);
  }
});

test("P2. jev continue 但本地连续无进展 → 状态感知硬下限收口（A/B：=0 回退旧契约）", async () => {
  // A：默认契约。4 轮 noop 空转 + 第 5 轮终态回复，jev 每轮 continue（0.95）。
  // 旧实现里 jev 主判成功即整轮旁路 heuristic、且 continue 清零计数，真实空转
  // 会一路放行到终态成功（漏判死循环）。现在本地证据每轮照常累计，第 4 轮收口。
  {
    const projectRoot = createGitProject();
    const gateway = await startTestGateway();
    try {
      const client = new StubLlmClient([...noopRoundScripts(4), { content: "任务完成", toolCalls: null }]);
      const executor = new LlmTaskExecutor({
        projectRoot,
        createLlmClient: () => client,
        maxToolRounds: 12,
        jevDecision: makeJev(gateway),
      });
      const result = await executor.executeTask(buildInput(projectRoot));
      assert.equal(result.success, false, "jev 持续 continue 时本地硬下限必须拦住真实空转");
      assert.match(result.error ?? "", /无进展熔断|相同调用空转熔断/, "失败原因应为本地状态感知熔断");
    } finally {
      await gateway.close();
      cleanup(projectRoot);
    }
  }

  // B：显式回退。DEEPCODE_JEV_EVIDENCE_GUARD=0 逐字恢复 1454ea34 的「jeV 独占
  // 去留权」契约——同一场景应由终态回复正常成功，硬熔断不得抢跑。
  const previous = process.env.DEEPCODE_JEV_EVIDENCE_GUARD;
  process.env.DEEPCODE_JEV_EVIDENCE_GUARD = "0";
  {
    const projectRoot = createGitProject();
    const gateway = await startTestGateway();
    try {
      const client = new StubLlmClient([...noopRoundScripts(4), { content: "任务完成", toolCalls: null }]);
      const executor = new LlmTaskExecutor({
        projectRoot,
        createLlmClient: () => client,
        maxToolRounds: 12,
        jevDecision: makeJev(gateway),
      });
      const result = await executor.executeTask(buildInput(projectRoot));
      assert.equal(result.success, true, "回退开关下旧契约：jev continue 时硬熔断不得触发");
      assert.equal(gateway.requests.length >= 4, true, "每轮工具执行前都应有 jev 决策请求");
    } finally {
      if (previous === undefined) delete process.env.DEEPCODE_JEV_EVIDENCE_GUARD;
      else process.env.DEEPCODE_JEV_EVIDENCE_GUARD = previous;
      await gateway.close();
      cleanup(projectRoot);
    }
  }
});

test("P3. jev 不可达 → 回落 heuristic：同一空转场景仍由无进展熔断收口（最小硬兜底）", async () => {
  const projectRoot = createGitProject();
  try {
    const client = new StubLlmClient(noopRoundScripts(4));
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 12,
      jevDecision: await makeClosedPortJev(),
    });
    const result = await executor.executeTask(buildInput(projectRoot));
    assert.equal(result.success, false, "jev 不可用时兜底熔断必须生效");
    assert.match(result.error ?? "", /无进展熔断/, "兜底失败 reason 应为既有无进展熔断文案");
  } finally {
    cleanup(projectRoot);
  }
});

test("P4. jev 每轮误判 stop，但重复写同一文件 + bash 输出逐轮推进 → 进展证据门否决、不误杀", async () => {
  const projectRoot = createGitProject();
  // 每轮都返回高置信 stop：预取决策只含上一轮摘要，看不到本轮真实进展
  const gateway = await startTestGateway(ALWAYS_STOP_BODY);
  try {
    const logFile = path.join(projectRoot, "progress.log");
    // 关键：3 轮反复写同一个未跟踪文件，git status 行恒为 `?? progress.log`，
    // 但文件内容在推进；bash 输出也逐轮不同。两者都是真实进展证据。
    const scripts = [1, 2, 3].map((step) => ({
      content: "",
      toolCalls: [
        { name: "bash" as const, args: { command: `echo poll-${step}` } },
        { name: "write" as const, args: { file_path: logFile, content: `step ${step}\n` } },
      ],
    }));
    const client = new StubLlmClient([...scripts, { content: "轮询完成，任务结束", toolCalls: null }]);
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 12,
      jevDecision: makeJev(gateway),
    });
    const result = await executor.executeTask(buildInput(projectRoot));
    assert.equal(result.success, true, "本轮确有进展时 jev stop 必须被否决，任务正常结束");
    assert.equal(fs.readFileSync(logFile, "utf8"), "step 3\n", "三轮写入必须真实落盘且状态推进");
    assert.equal(gateway.requests.length, 3, "三轮有工具调用的轮次都应发起决策，且未被提前终止");
  } finally {
    await gateway.close();
    cleanup(projectRoot);
  }
});

test("P5. jev 每轮 stop 且本轮确实零进展 → 证据门不纵容，仍由 jev 终止", async () => {
  const projectRoot = createGitProject();
  const gateway = await startTestGateway(ALWAYS_STOP_BODY);
  try {
    const client = new StubLlmClient(noopRoundScripts(4));
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 12,
      jevDecision: makeJev(gateway),
    });
    const result = await executor.executeTask(buildInput(projectRoot));
    assert.equal(result.success, false, "无进展证据时 jev stop 必须生效");
    assert.match(result.error ?? "", /jev/, "失败 reason 必须注明 jev 判定来源");
    assert.equal(gateway.requests.length, 1, "第 1 轮即终止，不应有后续决策请求");
  } finally {
    await gateway.close();
    cleanup(projectRoot);
  }
});

test("P6. jev 主判持续 continue 但调用与结果完全相同 → 真实死循环仍被本地熔断收口", async () => {
  const projectRoot = createGitProject();
  const gateway = await startTestGateway();
  try {
    // 真正死循环：逐字符相同的 bash 调用，且输出也完全相同（无任何状态推进）
    const client = new StubLlmClient(
      Array.from({ length: 6 }, () => ({
        content: "",
        toolCalls: [{ name: "bash", args: { command: "echo SAME" } }],
      }))
    );
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 12,
      jevDecision: makeJev(gateway),
    });
    const result = await executor.executeTask(buildInput(projectRoot));
    assert.equal(result.success, false, "jeV 主判不得旁路真实死循环的本地收口");
    assert.match(result.error ?? "", /相同调用空转熔断/, "应由相同调用空转熔断优先收口");
  } finally {
    await gateway.close();
    cleanup(projectRoot);
  }
});

test("P7. 回退开关 =0 时进展证据门关闭：P4 同场景由 jev stop 终止（旧契约）", async () => {
  const previous = process.env.DEEPCODE_JEV_EVIDENCE_GUARD;
  process.env.DEEPCODE_JEV_EVIDENCE_GUARD = "0";
  const projectRoot = createGitProject();
  const gateway = await startTestGateway(ALWAYS_STOP_BODY);
  try {
    const logFile = path.join(projectRoot, "progress.log");
    const client = new StubLlmClient([
      {
        content: "",
        toolCalls: [{ name: "write", args: { file_path: logFile, content: "step 1\n" } }],
      },
      { content: "任务完成", toolCalls: null },
    ]);
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 12,
      jevDecision: makeJev(gateway),
    });
    const result = await executor.executeTask(buildInput(projectRoot));
    assert.equal(result.success, false, "回退后证据门关闭，jev stop 按旧契约直接终止");
    assert.match(result.error ?? "", /jev/);
  } finally {
    if (previous === undefined) delete process.env.DEEPCODE_JEV_EVIDENCE_GUARD;
    else process.env.DEEPCODE_JEV_EVIDENCE_GUARD = previous;
    await gateway.close();
    cleanup(projectRoot);
  }
});

// ============================================================================
// 7. NG 系列：空轮 nudge（校准计划阶段 C，docs/dev/jev-loop-decision-calibration-plan-20261110.md）
// ============================================================================

// ---------------------------------------------------------------------------
// NG6（结构性质，非运行时用例，此处以注释披露）：
// 主循环 nudge 注入块（session.ts call site）为同步代码——构造 SessionMessage
// 后直接 appendSessionMessage（fs.appendFileSync），无新增 await 点；注入路径
// 位于既有 isInterrupted 检查之后，中断安全性由既有检查覆盖（校准计划 NG6 定义）。
// ---------------------------------------------------------------------------

/** NG 系列会话层挂具：HOME 隔离 + 临时目录追踪（LLM client 永不被调用） */
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const ngTempDirs: string[] = [];

function ngSetHomeDir(dir: string): void {
  process.env.HOME = dir;
  if (process.platform === "win32") {
    process.env.USERPROFILE = dir;
  }
}

afterEach(() => {
  // 恢复 HOME（仅 NG4/NG5/NG7 会话层用例会改写），并清理临时目录
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  while (ngTempDirs.length > 0) {
    const dir = ngTempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * 构造最小 SessionManager（会话层 NG 用例专用）
 *
 * 真实性边界：SessionManager 为生产真实实现（真实会话存储/心跳/护栏）。
 * 本组用例只触达决策与观测私有方法、不进入主循环，故 LLM client 仅对
 * createSession 的旁路调用（标题生成等 reportNewPrompt 链路）返回良性空
 * 响应——与 session-ephemeral-auto-deny.test.ts 的受控响应注入挂具同构；
 * 主循环若发起真实对话请求（用例越界）将因空内容而自然失败。
 */
function createNudgeTestManager(): SessionManager {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-ng-workspace-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-ng-home-"));
  ngTempDirs.push(workspace, home);
  ngSetHomeDir(home);
  return new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: {
        chat: {
          completions: {
            // 旁路空响应：createSession 的标题/技能匹配等非主循环请求落到这里
            create: async () => ({ choices: [{ message: { content: "" } }], usage: {} }),
          },
        },
      } as never,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({
      model: "test-model",
      permissions: { allow: [], deny: [], ask: [], defaultMode: "allowAll", addWorkingDirs: [] } as never,
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

/** 构造带自定义 is_empty_turn 置信度的 jev answers（choiceAnswers 的置信度固定 0.9，此处需边界值） */
function emptyTurnAnswers(choice: string, confidence: number, continueLoop = "continue"): Record<string, never> {
  return {
    continue_loop: { type: "choice", choice: continueLoop, probabilities: {}, confidence: 0.9 },
    is_empty_turn: { type: "choice", choice, probabilities: {}, confidence },
  } as never;
}

/** 构造一轮 jev 观测（isLastJevObservationEmpty 种子数据） */
function makeObservation(overrides: Partial<JevTurnObservation> = {}): JevTurnObservation {
  return {
    visibleText: "",
    hadToolCalls: false,
    toolSucceededCount: 0,
    toolFailedCount: 0,
    toolCallDigests: [],
    ...overrides,
  };
}

test("NG1. 空轮自愈链路就绪：jev 判 yes → 放行不咨询 + nudge 预算可用", () => {
  const guard = new TurnGuard({
    maxConsecutiveFailedTurns: 3,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
    maxConsecutiveEmptyTurns: 5,
  });
  // jev 判 is_empty_turn=yes 且 continue_loop=continue：主判放行（自愈而非终止）
  const decision = guard.evaluateJevDecision(emptyTurnAnswers("yes", 0.9) as never);
  assert.equal(decision.allow, true, "空轮判定不得直接终止循环——放行由 nudge 自愈");
  assert.notEqual(decision.action, "consult_user_empty_turns", "单次空轮不得触发咨询");
  // nudge 注入前置条件就绪：预算窗口内可发放
  assert.equal(guard.tryIssueNudge(), true, "首次 nudge 发放必须成功");
  assert.equal(guard.getState().nudgesIssued, 1, "发放后计数必须为 1");
});

test("NG2. 空轮复核通过（no）→ 空轮计数清零但 nudge 预算保留", () => {
  const guard = new TurnGuard({
    maxConsecutiveFailedTurns: 3,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
    maxConsecutiveEmptyTurns: 5,
  });
  // 第 1 轮：yes → 计数 1 + 发放 1 次 nudge
  guard.evaluateJevDecision(emptyTurnAnswers("yes", 0.9) as never);
  assert.equal(guard.tryIssueNudge(), true);
  // 第 2 轮：jev 复核判 no（模型响应了 nudge，产出可见内容）→ 空轮计数清零
  guard.evaluateJevDecision(emptyTurnAnswers("no", 0.9) as never);
  assert.equal(guard.getState().consecutiveEmptyTurns, 0, "no 判定必须清零空轮计数");
  assert.equal(guard.getState().nudgesIssued, 1, "nudge 预算属窗口级，不随单轮复核通过重置");
  // 第 3 轮再次空转：计数重新从 1 开始（独立窗口），nudge 预算继续累计
  guard.evaluateJevDecision(emptyTurnAnswers("yes", 0.9) as never);
  assert.equal(guard.getState().consecutiveEmptyTurns, 1, "清零后重新计数，不得继承旧计数");
  assert.equal(guard.tryIssueNudge(), true);
  assert.equal(guard.getState().nudgesIssued, 2);
});

test("NG3. 空轮咨询上限交还用户 + nudge 硬上限 ≤3 + acknowledgeAndContinue 恢复预算", () => {
  const guard = new TurnGuard({
    maxConsecutiveFailedTurns: 3,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
    maxConsecutiveEmptyTurns: 3,
  });
  // 连续 3 次 yes：第 3 次触发咨询（nudge 自愈失效，交还用户决策路径）
  guard.evaluateJevDecision(emptyTurnAnswers("yes", 0.9) as never);
  guard.evaluateJevDecision(emptyTurnAnswers("yes", 0.9) as never);
  const third = guard.evaluateJevDecision(emptyTurnAnswers("yes", 0.9) as never);
  assert.equal(third.allow, false);
  assert.equal(third.action, "consult_user_empty_turns", "连续空转达上限必须咨询用户，不得无限自愈");
  // nudge 硬上限：窗口内最多 3 次（防重试风暴），第 4 次拒绝
  assert.equal(guard.tryIssueNudge(), true);
  assert.equal(guard.tryIssueNudge(), true);
  assert.equal(guard.tryIssueNudge(), true);
  assert.equal(guard.tryIssueNudge(), false, "超过 MAX_NUDGES_PER_WINDOW=3 必须拒绝发放");
  assert.equal(guard.getState().nudgesIssued, 3);
  // 用户放行（P1-5 统一清零语义）：空轮计数与 nudge 预算同时恢复
  guard.acknowledgeAndContinue();
  assert.equal(guard.getState().consecutiveEmptyTurns, 0);
  assert.equal(guard.getState().nudgesIssued, 0, "acknowledgeAndContinue 必须重置 nudge 预算（新窗口）");
  assert.equal(guard.tryIssueNudge(), true);
});

test("NG4. jev 未启用 → heuristic 路径零 verdict：主循环不得触发 nudge（NG4 防误注入）", async () => {
  const manager = createNudgeTestManager();
  const sessionId = await manager.createSession({ text: "执行任务" });
  // 显式禁用 jev（未配置密钥等价场景）：decideLoopWithJev 必须走 heuristic 硬兜底
  manager.setJevDecision(null);
  const guard = (manager as unknown as { getOrCreateTurnGuard(id: string): TurnGuard }).getOrCreateTurnGuard(sessionId);
  const decision = await (
    manager as unknown as {
      decideLoopWithJev(id: string, g: TurnGuard): Promise<{ allow: boolean; jevEmptyTurnVerdict?: boolean }>;
    }
  ).decideLoopWithJev(sessionId, guard);
  assert.equal(decision.allow, true, "heuristic 兜底对干净会话必须放行");
  assert.equal(
    decision.jevEmptyTurnVerdict,
    undefined,
    "heuristic 路径不得携带 jevEmptyTurnVerdict——主循环据此零 nudge 注入"
  );
});

test("NG5. nudge 消息契约 + isJevEmptyTurnVerdict 边界 + 摘要目标位跳过 nudge", async () => {
  // 契约 1：注入消息必须带 [jev-nudge] 前缀（getLatestUserTextForJev 跳过依据）
  assert.ok(NUDGE_MESSAGE.startsWith("[jev-nudge]"), "nudge 消息必须以 [jev-nudge] 前缀开头");
  assert.ok(NUDGE_MESSAGE.length > "[jev-nudge]".length, "nudge 消息必须包含实际指引文案");

  // 契约 2：isJevEmptyTurnVerdict 边界（yes + 置信度 ≥0.5 才算数）
  assert.equal(isJevEmptyTurnVerdict(emptyTurnAnswers("yes", 0.9)), true, "yes + 高置信 → verdict 成立");
  assert.equal(isJevEmptyTurnVerdict(emptyTurnAnswers("yes", 0.5)), true, "yes + 恰在阈值 → verdict 成立（含边界）");
  assert.equal(isJevEmptyTurnVerdict(emptyTurnAnswers("yes", 0.4)), false, "yes + 低置信 → 不成立（防误注入）");
  assert.equal(isJevEmptyTurnVerdict(emptyTurnAnswers("no", 0.9)), false, "no 判定 → 不成立");
  assert.equal(
    isJevEmptyTurnVerdict({
      continue_loop: { type: "choice", choice: "continue", probabilities: {}, confidence: 0.9 },
    } as never),
    false,
    "缺 is_empty_turn → 不成立"
  );
  assert.equal(isJevEmptyTurnVerdict(null), false, "answers 为 null → 不成立");
  assert.equal(isJevEmptyTurnVerdict(undefined), false, "answers 为 undefined → 不成立");
  assert.equal(
    isJevEmptyTurnVerdict({
      continue_loop: { type: "choice", choice: "continue", probabilities: {}, confidence: 0.9 },
      is_empty_turn: { type: "score", score: 0.9, legend: {}, probabilities: {}, confidence: 0.9 },
    } as never),
    false,
    "is_empty_turn 类型非法（非 choice）→ 不成立"
  );

  // 契约 3（NG5 自反催化防护）：nudge 注入后，摘要「任务目标」位仍取真实用户消息
  const manager = createNudgeTestManager();
  const sessionId = await manager.createSession({ text: "修复单元测试" });
  const m = manager as unknown as {
    appendSessionMessage(id: string, message: Record<string, unknown>): void;
    getLatestUserTextForJev(id: string): string | undefined;
  };
  const now = new Date().toISOString();
  m.appendSessionMessage(sessionId, {
    id: "ng5-nudge",
    sessionId,
    role: "user",
    content: NUDGE_MESSAGE,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: false,
    createTime: now,
    updateTime: now,
  });
  assert.equal(
    m.getLatestUserTextForJev(sessionId),
    "修复单元测试",
    "nudge 注入后摘要目标位必须仍是真实用户消息，不得被 nudge 自反催化"
  );
});

test("NG7. 本地复核 isLastJevObservationEmpty：与 TurnGuard 空转口径一致", () => {
  const manager = createNudgeTestManager();
  const sessionId = "ng7-session";
  const m = manager as unknown as {
    jevTurnObservations: Map<string, JevTurnObservation[]>;
    isLastJevObservationEmpty(id: string): boolean;
  };
  // 无观测历史 → false（保守：无证据不注入）
  assert.equal(m.isLastJevObservationEmpty(sessionId), false, "无观测时必须保守返回 false");
  // 末轮有可见正文 → false
  m.jevTurnObservations.set(sessionId, [makeObservation({ visibleText: "hello" })]);
  assert.equal(m.isLastJevObservationEmpty(sessionId), false, "末轮有可见正文不得判空");
  // 末轮有工具成功 → false
  m.jevTurnObservations.set(sessionId, [makeObservation({ hadToolCalls: true, toolSucceededCount: 1 })]);
  assert.equal(m.isLastJevObservationEmpty(sessionId), false, "末轮有工具成功不得判空");
  // 末轮空转（无正文 + 无工具成功），且仅末尾一轮空转 → true（NG7 防误判核心口径）
  m.jevTurnObservations.set(sessionId, [makeObservation({ visibleText: "中间轮可见回复" }), makeObservation()]);
  assert.equal(m.isLastJevObservationEmpty(sessionId), true, "末轮空转必须判真（nudge 注入的本地复核半边）");
  // 末轮空转但更早轮也空转：口径仍只看末轮（连续空转计数由 TurnGuard 负责）
  m.jevTurnObservations.set(sessionId, [makeObservation(), makeObservation()]);
  assert.equal(m.isLastJevObservationEmpty(sessionId), true);
});
