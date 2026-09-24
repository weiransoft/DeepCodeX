/**
 * SSE 断连不杀轮次集成测试（T7：浏览器断开 ≠ 用户中断）。
 *
 * 契约（docs/dev/web-ui.md §3.5 + T7 语义收窄）：
 * - GET /api/chats/:id/stream 的 SSE 连接被客户端关闭时，服务端只做
 *   退订（unsubscribe）与心跳清理，绝不中止引擎轮次——轮次继续在服务端
 *   执行到自然完成（SessionManager 不被打断）；
 * - 「failed」状态语义收窄为引擎真实错误；中止类（interrupt/dispose）
 *   落 status:"interrupted"、failReason:"interrupted"。
 *
 * 测试策略（真实 HTTP + SSE，无 mock 框架）：
 * - 真实 startWebServer（随机端口、localUsers 登录，同 chat-flow.test.ts 模式）；
 * - LLM 经 createLLMClient 缝合点注入 ScriptedLLMClient（真实受控实现）；
 * - 用例 A：轮次进行中主动 abort SSE 连接 → 服务端经 hub.publish 验证
 *   订阅者已剔除（断连确实发生）→ 重开 SSE 订阅等 done 帧 → 断言
 *   status=completed，非 failed/interrupted；
 * - 用例 B（状态语义基线）：显式 POST interrupt → done 帧与活性查询均为
 *   interrupted（证明「中止类落 interrupted」而非 failed）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LLMStreamEvent } from "@vegamo/deepcode-core";
import { startWebServer, type RunningWebServer } from "../src/server";
import {
  createControlledOpenAIClientHandle,
  createResolvedSettings,
  extractAuthCookie,
  fetchJson,
  makeCtx,
  openSseStream,
  ScriptedLLMClient,
  sha256Hex,
} from "./helpers";

/** 运行中的 Web 服务器（真实 HTTP，随机端口） */
let server: RunningWebServer;
/** 临时项目根（牢笼白名单） */
let tmpRoot: string;
/** 登录 Cookie */
let cookie: string;
/** 受控 LLM 客户端（脚本可在用例间切换） */
let client: ScriptedLLMClient;
/** admin 测试用户的认证上下文（与登录 Cookie 同身份，池 API 直接观测用） */
const ctx = makeCtx("admin");

before(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-sse-disconnect-"));
  const settings = createResolvedSettings({
    allowRoots: [tmpRoot],
    uploadDir: path.join(tmpRoot, "uploads"),
    auth: {
      jwtSecret: "sse-disconnect-test-secret",
      sessionTtlSeconds: 3600,
      localUsers: [{ username: "admin", passwordHash: sha256Hex("sse-disconnect-pass") }],
    },
  });
  // yieldDelayMs=8：事件间真实让出，保证「轮次进行中」的观测窗口足够关闭 SSE 连接
  client = new ScriptedLLMClient([], 8);
  server = await startWebServer(settings, {
    createLLMClient: () => client,
    createOpenAIClient: () => createControlledOpenAIClientHandle(),
  });
  const login = await fetchJson(server.port, "POST", "/api/auth/login", {
    username: "admin",
    password: "sse-disconnect-pass",
  });
  assert.equal(login.status, 200, "登录前置条件失败");
  cookie = extractAuthCookie(login.headers)!;
});

after(async () => {
  await server.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * 创建测试会话。
 *
 * @returns chatId
 */
async function createChat(): Promise<string> {
  const created = await fetchJson(server.port, "POST", "/api/chats", { projectRoot: tmpRoot }, cookie);
  assert.equal(created.status, 200, `创建会话失败：${JSON.stringify(created.body)}`);
  return created.body.chatId as string;
}

/**
 * 发送 JSON 文本消息（202 异步受理契约）。
 *
 * @param chatId 会话 id
 * @param text 消息文本
 */
async function sendText(chatId: string, text: string): Promise<void> {
  const send = await fetchJson(server.port, "POST", `/api/chats/${chatId}/messages`, { text }, cookie);
  assert.equal(send.status, 202, `消息应 202 异步受理：${JSON.stringify(send.body)}`);
}

/**
 * 轮询等待条件成立（超时抛错）。
 *
 * @param predicate 条件函数
 * @param timeoutMs 超时毫秒
 * @param description 条件描述（超时报错用）
 */
async function waitFor(predicate: () => boolean, timeoutMs = 20000, description = "条件"): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`等待${description}超时（${timeoutMs}ms）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 读取引擎会话条目（会话状态事实源，经 listChats 公开出口观测）。
 *
 * listChats 的活跃会话条目与 pool.getChatActivity 读的是同一个
 * manager.getSession(sessionId) 快照——status 即引擎条目状态。
 *
 * @param chatId 会话 id
 * @returns 会话摘要（含 status）；不在列表时 null
 */
function findChatSummary(chatId: string): { status: string } | null {
  return server.pool.listChats(ctx).find((chat) => chat.chatId === chatId) ?? null;
}

test("SSE 断连：轮次进行中关闭 SSE 连接不得中止引擎轮次（继续执行至 completed）", async () => {
  // 有限长流脚本：约 120 个 delta × 8ms ≈ 1s 执行窗口，足够在轮次中关闭连接
  client.setScript(
    Array.from({ length: 120 }, (_, index) => ({ type: "text_delta", text: `d${index} ` }) as LLMStreamEvent).concat([
      { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } },
    ])
  );

  const chatId = await createChat();
  const { collector, controller } = await openSseStream(server.port, chatId, cookie);

  await sendText(chatId, "断连不应杀轮次");
  // 确认轮次真的在跑（首个 delta 已达 SSE）
  await collector.waitFor("llm_delta", 15000);

  // —— 客户端主动关闭 SSE 连接（模拟浏览器关页/网络断开）——
  controller.abort();
  // 等服务端真正感知断连（res close → unsubscribe，订阅者清零）
  await waitFor(() => server.hub.subscriberCount(chatId) === 0, 5000, "服务端感知 SSE 断连");

  // 断连后立刻观测：轮次仍应在服务端执行（活性为真，或被后续轮次窗口覆盖；
  // 核心判据是它最终 completed，而非因断连落 failed/interrupted）
  const activity = server.pool.getChatActivity(chatId, ctx);
  void activity; // 活性在断连瞬间允许处于 runTurn 收尾竞态窗口，不作硬性断言

  // 轮次继续执行到自然完成：重开 SSE 订阅，等本轮 done 帧
  const reopened = await openSseStream(server.port, chatId, cookie);
  const doneFrame = await reopened.collector.waitFor("done", 20000);
  reopened.controller.abort();

  // 核心断言：done 状态必须是 completed——既非 failed（客户端断连不得算失败），
  // 也非 interrupted（客户端断连不得被当作中止信号）
  assert.equal(doneFrame.data.status, "completed", "SSE 断连后轮次必须继续执行到 completed");
  assert.equal(doneFrame.data.error, undefined, "completed 的 done 帧不应携带 error");

  // 引擎条目语义核验：断连不是中止，条目终态必须 completed
  const sessionId = doneFrame.data.sessionId as string;
  assert.ok(sessionId, "done 载荷必须携带底层 sessionId");
  const summary = findChatSummary(chatId);
  assert.equal(summary?.status, "completed", "引擎条目终态必须是 completed");
  // 注册表回写与列表观测一致性（done 后注册表状态同为 completed）
  assert.equal(summary?.source, "active", "轮次完成后会话仍应在池内活跃");
});

test("状态语义基线：显式 interrupt 中止落 interrupted（而非 failed）", async () => {
  // 无限流脚本：轮次不会自然收敛，只能经 interrupt 中止收尾
  client.setScript(() =>
    Array.from({ length: 1_000_000 }, (_, index) => ({ type: "text_delta", text: `t${index} ` }) as LLMStreamEvent)
  );

  const chatId = await createChat();
  const { collector, controller } = await openSseStream(server.port, chatId, cookie);

  await sendText(chatId, "长生成等待中止");
  await collector.waitFor("llm_delta", 15000);
  // 首轮 sessionId 要到 runTurn finally 才同步（无限流轮次内不可观测）；
  // 等 llm_delta 请求真正抵达 LLM（requestLog 记录），确保
  // interruptActiveSession 已有活跃会话可中断
  await waitFor(() => client.requestLog.length >= 1, 10000, "LLM 请求抵达");

  // 用户主动停止（区别于 SSE 断连的唯一中止入口）
  const interrupt = await fetchJson(server.port, "POST", `/api/chats/${chatId}/interrupt`, undefined, cookie);
  assert.equal(interrupt.status, 200);

  const doneFrame = await collector.waitFor("done", 15000);
  controller.abort();
  assert.equal(doneFrame.data.status, "interrupted", "显式中止的 done 帧必须落 interrupted");

  // 引擎条目观测（经 listChats 公开出口）：中止后状态必须为 interrupted 而非 failed
  const summary = findChatSummary(chatId);
  assert.equal(summary?.status, "interrupted", "中止后引擎条目 status 必须为 interrupted（T7 语义收窄基线）");
});
