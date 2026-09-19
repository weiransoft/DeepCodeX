/**
 * 权限审批流集成测试（docs/dev/web-ui.md §5.2，真实 HTTP + SSE + 真实 bash 执行）。
 *
 * 全链路（受控 LLM 依赖注入，非 mock 框架）：
 *   登录 → 创建会话 → SSE 订阅 → 发送文本消息（202 异步受理）→
 *   受控 LLM 返回 bash 工具调用（arguments 故意缺省 sideEffects → 引擎归一为
 *   ["unknown"] scope → manual 权限模式下必然 ask）→ SSE 收 permission_request
 *   （含 toolCallId/name/command/scopes 审批明细）+ done(status=ask_permission) →
 *   POST messages 回注 {permissions:[{toolCallId, permission:"allow"}]}（202）→
 *   引擎恢复执行真实 bash（echo permission-flow-ok）→ 第 2 次 LLM 请求返回文本收尾 →
 *   SSE 收 done(status=completed) → messages 端点回读 user/tool/assistant 消息，
 *   工具消息必须包含真实命令输出。
 *
 * 权限模式隔离：项目级 <projectRoot>/.deepcode/settings.json 显式 mode:"manual"
 * （项目设置优先于用户级，见 core settings PM-U04 合并语义），保证测试不受本机
 * 用户级设置（如 bypass 全放行）干扰。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { LLMStreamEvent } from "@vegamo/deepcode-core";
import { getProjectCode } from "@vegamo/deepcode-core";
import { startWebServer, type RunningWebServer } from "../src/server";
import type { SseCollector } from "./helpers";
import {
  createControlledOpenAIClientHandle,
  createResolvedSettings,
  extractAuthCookie,
  fetchJson,
  openSseStream,
  ScriptedLLMClient,
  sha256Hex,
} from "./helpers";

/** 受控 LLM 首轮返回的工具调用 id（审批请求与回注决策以此关联） */
const TOOL_CALL_ID = "toolu-web-perm-01";
/** 受控 bash 命令（审批放行后真实执行，输出作为工具消息断言依据） */
const BASH_COMMAND = "echo permission-flow-ok";
/** 受控 bash 命令的真实输出（echo 原样回显） */
const BASH_OUTPUT = "permission-flow-ok";

let server: RunningWebServer;
let tmpRoot: string;
let cookie: string;
let client: ScriptedLLMClient;

before(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-perm-"));
  // 项目级权限设置：强制 manual 模式（项目优先于用户级，隔离本机 ~/.deepcode/settings.json 影响）。
  // 受控 bash 工具调用缺省 sideEffects → 引擎 parseBashSideEffects 归一为 ["unknown"]，
  // manual 模式下未入 allow 白名单的 scope 一律 ask（core permissions.ts evaluatePermissionScopes）
  mkdirSync(path.join(tmpRoot, ".deepcode"), { recursive: true });
  writeFileSync(
    path.join(tmpRoot, ".deepcode", "settings.json"),
    JSON.stringify({ permissions: { mode: "manual", allow: [], deny: [], ask: [], defaultMode: "allowAll" } }, null, 2),
    "utf8"
  );

  const settings = createResolvedSettings({
    allowRoots: [tmpRoot],
    uploadDir: path.join(tmpRoot, "uploads"),
    auth: {
      jwtSecret: "permission-flow-test-secret",
      sessionTtlSeconds: 3600,
      localUsers: [{ username: "admin", passwordHash: sha256Hex("perm-pass") }],
    },
  });

  // 受控 LLM 脚本（外部计数器区分请求序号，ScriptedLLMClient 每次请求重新求值脚本）：
  // 第 1 次：bash 工具调用（无 sideEffects → unknown scope → 必然进入审批暂停）；
  // 第 2 次：审批放行、工具真实执行后的收尾文本（end_turn 正常完成）。
  // yieldDelayMs=5 模拟真实网络流节奏（与 chat-flow / session-pool 同款参数）。
  let requestCount = 0;
  client = new ScriptedLLMClient((): LLMStreamEvent[] => {
    requestCount += 1;
    if (requestCount === 1) {
      return [
        { type: "tool_call_start", id: TOOL_CALL_ID, name: "bash" },
        {
          type: "tool_call_delta",
          id: TOOL_CALL_ID,
          argumentsJsonDelta: JSON.stringify({ command: BASH_COMMAND, description: "权限审批流测试" }),
        },
        { type: "tool_call_end", id: TOOL_CALL_ID },
        { type: "message_end", stopReason: "tool_use", usage: { inputTokens: 3, outputTokens: 1 } },
      ];
    }
    return [
      { type: "text_delta", text: "工具执行完成" },
      { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 1 } },
    ];
  }, 5);

  server = await startWebServer(settings, {
    createLLMClient: () => client,
    createOpenAIClient: () => createControlledOpenAIClientHandle(),
  });

  const login = await fetchJson(server.port, "POST", "/api/auth/login", { username: "admin", password: "perm-pass" });
  assert.equal(login.status, 200, "登录前置条件失败");
  cookie = extractAuthCookie(login.headers)!;
});

after(async () => {
  // 引擎会把会话历史落盘到 ~/.deepcode/projects/<projectCode>，测试后清理；
  // projectCode 必须按归一化（realpath）后的项目根计算（macOS /var → /private/var 符号链接）
  const projectCode = getProjectCode(realpathSync(tmpRoot));
  await server.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(path.join(homedir(), ".deepcode", "projects", projectCode), { recursive: true, force: true });
});

/**
 * 轮询等待收集中出现 ≥ count 个指定事件。
 *
 * SseCollector.waitFor 只匹配「首个」事件；同一事件名出现多次（如两轮 done）时
 * 必须按计数等待，否则会立即返回旧事件造成假阳性。
 *
 * @param collector SSE 收集器
 * @param event 事件名
 * @param count 期望出现次数（下限）
 * @param timeoutMs 超时毫秒（超时抛错并列出已收事件序列辅助定位）
 */
async function waitForEventCount(
  collector: SseCollector,
  event: string,
  count: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (collector.countOf(event) < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `等待 ${count} 个 ${event} 事件超时（${timeoutMs}ms）；实际 ${collector.countOf(event)} 个；` +
          `已收到事件序列：${collector.events.map((item) => item.event).join(",")}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("permission-flow：工具调用应触发审批（permission_request → allow 回注 → 恢复执行 → done completed）", async () => {
  // 创建会话
  const created = await fetchJson(server.port, "POST", "/api/chats", { projectRoot: tmpRoot }, cookie);
  assert.equal(created.status, 200, `创建会话失败：${JSON.stringify(created.body)}`);
  const chatId = created.body.chatId as string;

  // 先建立 SSE 订阅再发消息，保证不漏事件
  const { collector, controller } = await openSseStream(server.port, chatId, cookie);

  // —— 第一轮：发送文本消息，受控 LLM 返回 bash 工具调用，进入审批暂停 ——
  // 202 异步受理契约：POST 仅受理入队立即返回，本轮事件全部经 SSE 推送
  const send = await fetchJson(server.port, "POST", `/api/chats/${chatId}/messages`, { text: "帮我跑个命令" }, cookie);
  assert.equal(send.status, 202, `发送消息应异步受理：${JSON.stringify(send.body)}`);
  assert.equal(send.body.ok, true, "受理响应必须携带 ok:true");
  assert.equal(send.body.chatId, chatId, "受理响应必须回显 chatId");
  assert.equal(send.body.sessionId, null, "首轮受理时底层会话尚未创建，sessionId 必须为 null");

  // permission_request 帧：携带审批明细（引擎暂停在 ask_permission 状态等待决策）
  const permissionRequest = await collector.waitFor("permission_request", 20000);
  assert.equal(permissionRequest.data.chatId, chatId);
  assert.ok(
    Array.isArray(permissionRequest.data.requests) && permissionRequest.data.requests.length > 0,
    "审批请求列表必须非空"
  );
  const askRequest = permissionRequest.data.requests[0];
  assert.equal(askRequest.toolCallId, TOOL_CALL_ID, "审批请求必须关联受控工具调用 id");
  assert.equal(askRequest.name, "bash", "审批请求必须携带工具名");
  assert.equal(askRequest.command, BASH_COMMAND, "审批请求必须携带待执行命令");
  assert.ok(
    Array.isArray(askRequest.scopes) && askRequest.scopes.includes("unknown"),
    `unknown scope 必须触发审批（实际 scopes：${JSON.stringify(askRequest.scopes)}）`
  );

  // 第一轮 done：状态收敛为 ask_permission，且此时底层 sessionId 已建立
  const firstDone = await collector.waitFor("done", 10000);
  assert.equal(firstDone.data.chatId, chatId);
  assert.equal(
    firstDone.data.status,
    "ask_permission",
    `审批暂停时轮次状态应为 ask_permission（实际 ${firstDone.data.status}）`
  );
  assert.ok(firstDone.data.sessionId, "done 载荷必须携带已建立的底层 sessionId");
  const establishedSessionId = firstDone.data.sessionId as string;

  // tool_progress 帧（P1-2 桥接）：审批暂停前引擎条目携带工具调用列表
  await waitForEventCount(collector, "tool_progress", 1, 10000);
  const progress = collector.events.find((item) => item.event === "tool_progress")!;
  assert.equal(progress.data.chatId, chatId);
  assert.ok(
    Array.isArray(progress.data.toolCalls) && progress.data.toolCalls.length > 0,
    "tool_progress 必须携带非空 toolCalls"
  );
  assert.equal(progress.data.toolCalls[0].id, TOOL_CALL_ID, "tool_progress 必须透传工具调用 id");

  // —— 第二轮：回注审批决策（allow），引擎恢复执行真实 bash ——
  const approve = await fetchJson(
    server.port,
    "POST",
    `/api/chats/${chatId}/messages`,
    { permissions: [{ toolCallId: TOOL_CALL_ID, permission: "allow" }] },
    cookie
  );
  assert.equal(approve.status, 202, `审批回注应异步受理：${JSON.stringify(approve.body)}`);
  assert.equal(approve.body.ok, true, "审批回注受理响应必须携带 ok:true");
  // 受理时底层会话已建立（第一轮 done 携带的 sessionId），回执应回显同一会话
  assert.equal(approve.body.sessionId, establishedSessionId, "审批回注受理应回显已建立的 sessionId");

  // 第二轮 done：工具真实执行 → 第 2 次 LLM 请求收尾 → completed
  await waitForEventCount(collector, "done", 2, 20000);
  const dones = collector.events.filter((item) => item.event === "done");
  const finalDone = dones[dones.length - 1];
  assert.equal(finalDone.data.chatId, chatId);
  assert.equal(finalDone.data.status, "completed", `审批放行后轮次应正常完成（实际 ${finalDone.data.status}）`);

  // 收尾助手消息（受控 LLM 第 2 次响应文本经 assistant_message 帧推送）
  const assistantMessages = collector.events.filter((item) => item.event === "assistant_message");
  assert.ok(assistantMessages.length > 0, "恢复执行后必须推送助手消息");
  assert.equal(assistantMessages[assistantMessages.length - 1].data.content, "工具执行完成");

  // 受控 LLM 必须实际收到至少 2 次请求（首轮工具调用 + 恢复后的收尾请求）
  assert.ok(client.requestLog.length >= 2, `LLM 必须收到 2 次请求（实际 ${client.requestLog.length} 次）`);

  controller.abort();

  // messages 端点回读：user / tool / assistant 角色齐全，工具消息含真实 bash 输出
  const messages = await fetchJson(server.port, "GET", `/api/chats/${chatId}/messages`, undefined, cookie);
  assert.equal(messages.status, 200);
  assert.ok(Array.isArray(messages.body.messages), "回读消息必须是数组");
  const roles = new Set<string>(messages.body.messages.map((message: any) => message.role as string));
  assert.ok(roles.has("user"), "回读消息必须含用户消息");
  assert.ok(roles.has("assistant"), "回读消息必须含助手消息");
  assert.ok(roles.has("tool"), "回读消息必须含工具执行消息");
  const toolContent = messages.body.messages
    .filter((message: any) => message.role === "tool")
    .map((message: any) => String(message.content ?? ""))
    .join("\n");
  assert.match(toolContent, new RegExp(BASH_OUTPUT), "工具消息必须包含真实 bash 执行输出");
});
