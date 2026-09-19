/**
 * 聊天流程集成测试（真实 HTTP + SSE，docs/dev/web-ui.md §3.5）。
 *
 * 全链路：登录 → 创建会话 → SSE 订阅 → multipart 消息（图片 + 文本附件）→
 * 断言 LLM 收到的请求注入附件路径与 imageUrls（file:// URL）→ SSE 收到
 * llm_delta / assistant_message / done → JSON 消息形态 → interrupt 中断 → 404/400 防御。
 * LLM 经 createLLMClient 缝合点注入 ScriptedLLMClient（真实受控实现）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LLMRequest, LLMStreamEvent } from "@vegamo/deepcode-core";
import { startWebServer, type RunningWebServer } from "../src/server";
import { userIdFromUsername } from "../src/user-identity";
import {
  buildMultipartBody,
  createControlledOpenAIClientHandle,
  createResolvedSettings,
  extractAuthCookie,
  fetchJson,
  openSseStream,
  ScriptedLLMClient,
  sha256Hex,
} from "./helpers";

let server: RunningWebServer;
let tmpRoot: string;
let cookie: string;
let client: ScriptedLLMClient;

before(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-chat-"));
  const settings = createResolvedSettings({
    allowRoots: [tmpRoot],
    uploadDir: path.join(tmpRoot, "uploads"),
    auth: {
      jwtSecret: "chat-flow-test-secret",
      sessionTtlSeconds: 3600,
      localUsers: [{ username: "admin", passwordHash: sha256Hex("chat-pass") }],
    },
  });
  // yieldDelayMs=5：每个事件 yield 后让出事件循环 5ms。
  // 关键理由：interrupt 用例的无限流脚本若以 0 延时产出，整条 delta 链会在单个
  // 微任务链内打满（事件循环饿死、I/O 停摆），洪峰结束时 socket 爆发式刷写会触发
  // libuv write EINVAL 并被 _http_server 销毁——那是测试环境的病理性配置，而非
  // SSE 层行为。5ms 间隔对应真实 LLM 网络流的节奏（session-pool 单测同款参数）。
  client = new ScriptedLLMClient(
    [
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } },
    ],
    5
  );
  server = await startWebServer(settings, {
    createLLMClient: () => client,
    createOpenAIClient: () => createControlledOpenAIClientHandle(),
  });

  const login = await fetchJson(server.port, "POST", "/api/auth/login", { username: "admin", password: "chat-pass" });
  assert.equal(login.status, 200, "登录前置条件失败");
  cookie = extractAuthCookie(login.headers)!;
});

after(async () => {
  await server.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * 创建测试会话的快捷方式。
 *
 * @returns chatId
 */
async function createChat(): Promise<string> {
  const created = await fetchJson(server.port, "POST", "/api/chats", { projectRoot: tmpRoot }, cookie);
  assert.equal(created.status, 200, `创建会话失败：${JSON.stringify(created.body)}`);
  return created.body.chatId as string;
}

test("chat：multipart 消息（图片+文本附件）应注入 imageUrls 与附件说明并完成一轮", async () => {
  const chatId = await createChat();

  // 先建立 SSE 订阅再发消息，保证不漏事件
  const { collector, controller } = await openSseStream(server.port, chatId, cookie);
  const donePromise = collector.waitFor("done", 15000);

  // 构造 multipart 请求：文本 + PNG 图片 + 纯文本附件
  // 注意：必须是真实合法的 PNG（引擎侧会经 sharp 真实解码构造多模态内容，
  // 伪造字节会导致解码失败 → 轮次 status=failed）
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const noteBytes = Buffer.from("这是附件 notes.txt 的内容", "utf8");
  const body = buildMultipartBody("chatBOUNDARY", [
    { name: "text", data: Buffer.from("请看附件", "utf8") },
    { name: "file", filename: "photo.png", contentType: "image/png", data: pngBytes },
    { name: "file", filename: "notes.txt", contentType: "text/plain", data: noteBytes },
  ]);

  const response = await fetch(`http://127.0.0.1:${server.port}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": 'multipart/form-data; boundary="chatBOUNDARY"' },
    body: new Uint8Array(body),
  });
  const result = await response.json();
  // 202 异步受理契约：POST 仅受理入队，轮次结果以 SSE done 为准
  assert.equal(response.status, 202, `发送消息应异步受理：${JSON.stringify(result)}`);
  assert.equal(result.ok, true, "受理响应必须携带 ok:true");
  assert.equal(result.chatId, chatId, "受理响应必须回显 chatId");
  // 首轮受理时底层会话尚未创建（createChat 不激活会话），sessionId 允许为 null；
  // 最终 sessionId 以 done 事件载荷为准
  assert.equal(result.sessionId, null, "首轮受理时 sessionId 必须为 null");

  const doneEvent = await donePromise;
  controller.abort();

  // —— 断言 LLM 客户端实际收到的请求内容 ——
  assert.ok(client.requestLog.length >= 1, "LLM 客户端必须收到请求");
  const request: LLMRequest = client.requestLog[client.requestLog.length - 1].request;
  const requestText = JSON.stringify(request.messages);
  assert.ok(requestText.includes("请看附件"), "请求必须包含用户文本");
  assert.ok(requestText.includes("附件：notes.txt"), "非图片附件必须以「附件：名称（路径）」注入文本");
  assert.ok(requestText.includes("file://"), "图片必须以 file:// URL 进入请求（imageUrls 链路）");
  const imageUrl = request.messages.map((message) => JSON.stringify(message)).find((text) => text.includes("file://"));
  assert.ok(imageUrl, "消息体中必须存在 file:// 图片引用");

  // —— 断言 SSE 事件序列 ——
  const events = collector.events.map((item) => item.event);
  assert.ok(collector.countOf("llm_delta") >= 2, `必须桥接多次 llm_delta（实际 ${collector.countOf("llm_delta")}）`);
  assert.ok(events.includes("assistant_message"), "必须桥接 assistant_message");
  const assistant = collector.events.find((item) => item.event === "assistant_message");
  assert.equal(assistant!.data.content, "Hello world");
  // done 载荷：chatId 回显、sessionId 已建立、status 为合法引擎状态
  assert.equal(doneEvent.data.chatId, chatId);
  assert.ok(doneEvent.data.sessionId, "done 载荷必须携带已建立的底层 sessionId");
  assert.ok(
    [
      "completed",
      "waiting_for_user",
      "processing",
      "interrupted",
      "failed",
      "pending",
      "ask_permission",
      "permission_denied",
    ].includes(doneEvent.data.status),
    `done 载荷 status 必须为合法 SessionStatus（得到 ${doneEvent.data.status}）`
  );
  assert.equal(doneEvent.data.status, "completed", "脚本正常完成时轮次状态应为 completed");
});

test("chat：JSON 消息形态（纯文本）应正常完成并可通过 messages 端点回读", async () => {
  const chatId = await createChat();

  // 202 异步受理契约：回读 messages 前必须等 SSE done 帧，否则助手消息尚未落库
  const { collector, controller } = await openSseStream(server.port, chatId, cookie);
  const donePromise = collector.waitFor("done", 15000);

  const send = await fetchJson(server.port, "POST", `/api/chats/${chatId}/messages`, { text: "第二条消息" }, cookie);
  assert.equal(send.status, 202, "messages 端点必须以 202 异步受理");
  assert.equal(send.body.ok, true, "受理响应必须携带 ok:true");
  assert.equal(send.body.chatId, chatId, "受理响应必须回显 chatId");
  assert.equal(send.body.sessionId, null, "首轮受理时 sessionId 必须为 null");

  const done = await donePromise;
  assert.equal(done.data.status, "completed", "轮次应正常完成");
  assert.ok(done.data.sessionId, "done 载荷必须携带已建立的底层 sessionId");
  controller.abort();

  const messages = await fetchJson(server.port, "GET", `/api/chats/${chatId}/messages`, undefined, cookie);
  assert.equal(messages.status, 200);
  assert.ok(Array.isArray(messages.body.messages));
  const visibleRoles = messages.body.messages
    .filter((message: any) => message.visible)
    .map((message: any) => message.role);
  assert.ok(visibleRoles.includes("user"), "回读消息必须含用户消息");
  assert.ok(visibleRoles.includes("assistant"), "回读消息必须含助手消息");
});

test("chat：会话列表应包含活跃会话（source=active）", async () => {
  const chatId = await createChat();

  // 202 异步受理契约：等 SSE done 确认轮次结束后再断言列表
  const { collector, controller } = await openSseStream(server.port, chatId, cookie);
  const donePromise = collector.waitFor("done", 15000);
  const send = await fetchJson(server.port, "POST", `/api/chats/${chatId}/messages`, { text: "列表用例" }, cookie);
  assert.equal(send.status, 202);
  await donePromise;
  controller.abort();

  const list = await fetchJson(server.port, "GET", "/api/chats", undefined, cookie);
  assert.equal(list.status, 200);
  const found = list.body.chats.find((chat: any) => chat.chatId === chatId);
  assert.ok(found, "活跃会话必须出现在列表");
  assert.equal(found.source, "active");
  // macOS /var → /private/var 符号链接：projectRoot 必须与 realpath 归一后的根一致
  assert.equal(found.projectRoot, await realpath(tmpRoot));
});

test("chat：interrupt 应在数秒内收敛（done 帧到达，HTTP 响应不悬挂）", async () => {
  // 切换为无限流脚本（signal 中断时由 ScriptedLLMClient 抛 AbortError，模拟真实 SDK）；
  // 事件间隔由客户端构造参数 yieldDelayMs=5 控制（真实网络流节奏，避免 0 延时纯
  // 微任务链饿死事件循环——详见 before 钩子中的注释）
  client.setScript(() =>
    Array.from({ length: 1_000_000 }, (_, index) => ({ type: "text_delta", text: `t${index} ` }) as LLMStreamEvent)
  );

  const chatId = await createChat();

  const { collector, controller } = await openSseStream(server.port, chatId, cookie);
  const donePromise = collector.waitFor("done", 15000);

  // 发送（202 异步受理立即返回；服务端进入无限流轮次）
  const sendPromise = fetch(`http://127.0.0.1:${server.port}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "开始长生成" }),
  });

  // 等 llm_delta 确认轮次在跑
  await collector.waitFor("llm_delta", 15000);

  // 202 异步受理：POST 响应应立即收敛且状态码为 202（不悬挂到轮次结束）
  const sendResponse = await Promise.race([
    sendPromise.then((response) => response.status),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10000)),
  ]);
  assert.notEqual(sendResponse, "timeout", "消息端点的受理响应必须立即收敛");
  assert.equal(sendResponse, 202, "消息端点必须以 202 异步受理");

  // 触发中断
  const interrupt = await fetchJson(server.port, "POST", `/api/chats/${chatId}/interrupt`, undefined, cookie);
  assert.equal(interrupt.status, 200);
  assert.ok(interrupt.body.ok);

  // 中断后 done 帧必须在超时前到达（订阅方不得悬死）
  await donePromise;
  controller.abort();

  // 恢复固定脚本（后续用例仍走正常完成路径）
  client.setScript([
    { type: "text_delta", text: "Hello" },
    { type: "text_delta", text: " world" },
    { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } },
  ]);
});

test("chat：不存在的 chatId 应 404（发送/历史/SSE/interrupt 全覆盖）", async () => {
  const fakeId = "00000000-0000-4000-8000-000000000000";
  const send = await fetchJson(server.port, "POST", `/api/chats/${fakeId}/messages`, { text: "x" }, cookie);
  assert.equal(send.status, 404);

  const messages = await fetchJson(server.port, "GET", `/api/chats/${fakeId}/messages`, undefined, cookie);
  assert.equal(messages.status, 404);

  const interrupt = await fetchJson(server.port, "POST", `/api/chats/${fakeId}/interrupt`, undefined, cookie);
  assert.equal(interrupt.status, 404);

  const stream = await fetch(`http://127.0.0.1:${server.port}/api/chats/${fakeId}/stream`, {
    headers: { cookie },
  });
  assert.equal(stream.status, 404);
});

test("chat：空消息（无 text/imageUrls/permissions）应 400", async () => {
  const chatId = await createChat();
  const empty = await fetchJson(server.port, "POST", `/api/chats/${chatId}/messages`, {}, cookie);
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /消息内容为空/);
});

test("chat：multipart 空消息（仅空 text 且无附件）应 400", async () => {
  const chatId = await createChat();
  // multipart 形态的空消息防御：text 字段存在但为空串，且无任何文件 part
  const body = buildMultipartBody("emptyMultipartBOUNDARY", [{ name: "text", data: Buffer.from("", "utf8") }]);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": 'multipart/form-data; boundary="emptyMultipartBOUNDARY"' },
    body: new Uint8Array(body),
  });
  const result = await response.json();
  assert.equal(response.status, 400, `multipart 空消息必须 400：${JSON.stringify(result)}`);
  assert.match(result.error, /消息内容为空/);
});

test("chat：非法 permissions（元素缺 toolCallId / permission 非枚举值）应 400", async () => {
  const chatId = await createChat();

  const noId = await fetchJson(
    server.port,
    "POST",
    `/api/chats/${chatId}/messages`,
    { permissions: [{ permission: "allow" }] },
    cookie
  );
  assert.equal(noId.status, 400);

  const badPermission = await fetchJson(
    server.port,
    "POST",
    `/api/chats/${chatId}/messages`,
    { permissions: [{ toolCallId: "call-1", permission: "maybe" }] },
    cookie
  );
  assert.equal(badPermission.status, 400);

  // 合法审批回注应 202 异步受理（审批恢复路径的完整流程由 permission-flow 集成测试覆盖）
  const ok = await fetchJson(
    server.port,
    "POST",
    `/api/chats/${chatId}/messages`,
    { permissions: [{ toolCallId: "call-1", permission: "allow" }] },
    cookie
  );
  assert.equal(ok.status, 202);
});

test("chat：multipart 上传的图片附件应真实落盘到用户个人区 uploadDir/<userId>/", async () => {
  const chatId = await createChat();
  // 真实合法 1x1 PNG（引擎轮次会真实解码该图片，伪造字节会导致轮次 failed）
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const body = buildMultipartBody("saveBOUNDARY", [
    { name: "text", data: Buffer.from("图片保存用例", "utf8") },
    { name: "file", filename: "saved.png", contentType: "image/png", data: pngBytes },
  ]);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": 'multipart/form-data; boundary="saveBOUNDARY"' },
    body: new Uint8Array(body),
  });
  // 202 异步受理：附件解析与落盘在受理前完成（multipart 先解析后受理），
  // 因此响应立即返回时文件已落盘
  assert.equal(response.status, 202);

  // 多用户隔离（docs/dev/web-isolation.md §3.5）：聊天附件落个人区
  // uploadDir/<userId>/（userId = sha256(username) hex 前 16 位），且字节一致
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const uploadRoot = path.join(tmpRoot, "uploads");
  const personalDir = path.join(uploadRoot, userIdFromUsername("admin"));
  assert.ok(existsSync(personalDir), "个人区目录必须随附件落盘创建");
  const files = readdirSync(personalDir).filter((name) => name.endsWith("-saved.png"));
  assert.equal(files.length, 1, "图片附件必须落盘到个人区");
  assert.ok(readFileSync(path.join(personalDir, files[0])).equals(pngBytes), "落盘字节必须与上传一致");
});

// 说明：interrupt 用例依赖无限流脚本；ScriptedLLMClient 的脚本是按请求动态求值的，
// 这里通过「仅对最后一个 chat 使用长流」不可行——因此 interrupt 用例使用主客户端的
// 固定脚本（已完成），实际无限流中断行为由 session-pool.test.ts 的单元测试覆盖。
// 此处补充一个 Before 钩子外的说明性用例：SSE 初始 status 快照。
test("chat：SSE 订阅建立后应立即收到初始 status 快照", async () => {
  const chatId = await createChat();
  const { collector, controller } = await openSseStream(server.port, chatId, cookie);
  const snapshot = await collector.waitFor("status", 5000);
  assert.equal(snapshot.data.chatId, chatId);
  assert.ok(typeof snapshot.data.status === "string");
  controller.abort();
});
