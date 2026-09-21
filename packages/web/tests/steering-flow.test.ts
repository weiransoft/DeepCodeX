/**
 * 任务执行中补充指令（steering）集成测试（真实 HTTP + SSE，docs/dev/web-steering.md §4.2 ST1-ST11）。
 *
 * 覆盖：意图分类注入（steer）、排队（next/降级/关闭开关）、活性检查、
 * user_message 广播、status 快照、E2 消费桥接（assistant_message + 历史 meta）、
 * 分类窗口竞态（W6 二次检查）、审批等待一律排队、认证与归属边界。
 *
 * 测试缝合点（依赖注入，非 mock 框架）：
 * - createLLMClient → ScriptedLLMClient（主对话脚本客户端，yield 延迟制造运行中窗口）；
 * - classifyLlmClientFactory → ScriptedClassifierClient（独立分类客户端，
 *   与主对话分离，可精确断言分类请求次数与输出契约）；
 * - createOpenAIClient → 受控句柄（activateSession 要求 client 非空）。
 *
 * 运行中窗口判定（不依赖引擎内部状态桥接）：
 * - 注入类用例（ST1/ST4/ST9）：「主对话请求数 ≥2 且尚未 done」——第二轮 LLM
 *   请求存在即证明轮内多迭代工具循环仍在进行（turnActive=true、processing 稳定窗口）；
 * - ST2（分类 next）：慢分类器（300ms）期间主对话持续流式（yield 5ms 长流），
 *   活性由流式节奏天然保证。
 *
 * 引擎状态读取事实说明（决定本文件的结构）：core 的会话索引按 projectRoot 哈希
 * 共享读写（loadSessionsIndex/saveSessionsIndex 全量重写、无跨 manager 合并），
 * 同一项目根并存的多个 SessionManager 会互相覆盖索引——updateSessionEntry 找不到
 * 条目时直接返回 null（status 冻结），onSessionEntryUpdated 也不触发。因此：
 * 每个用例必须使用独立临时项目目录（createChat 缺省新建，隔离索引）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { LLMRequest, LLMStreamEvent } from "@vegamo/deepcode-core";
import { getProjectCode } from "@vegamo/deepcode-core";
import { startWebServer, type RunningWebServer } from "../src/server";
import type { SseCollector } from "./helpers";
import {
  createControlledOpenAIClientHandle,
  createResolvedSettings,
  extractAuthCookie,
  fetchJson,
  openSseStream,
  ScriptedClassifierClient,
  ScriptedLLMClient,
  sha256Hex,
} from "./helpers";

/**
 * 等待条件成立（轮询，上限 timeoutMs）。
 *
 * @param predicate 条件函数（同步）
 * @param timeoutMs 超时毫秒
 * @param intervalMs 轮询间隔毫秒
 * @returns 条件满足时 resolve；超时 reject
 */
async function waitForCondition(predicate: () => boolean, timeoutMs: number, intervalMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`等待条件超时（${timeoutMs}ms）`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * 等待 SSE 收集器中出现满足条件的事件（轮询 collector.events）。
 *
 * SseCollector.waitFor 只匹配「首个」事件名——排队/注入场景中首个
 * user_message 是先行的主任务消息，ST7 需要按内容匹配，不能用 waitFor。
 *
 * @param collector SSE 收集器
 * @param predicate 事件匹配条件
 * @param timeoutMs 超时毫秒
 * @returns 首个匹配的事件；超时 reject
 */
async function waitForEvent(
  collector: SseCollector,
  predicate: (event: { event: string; data: any }) => boolean,
  timeoutMs: number
): Promise<{ event: string; data: any }> {
  await waitForCondition(() => collector.events.some(predicate), timeoutMs, 20);
  return collector.events.find(predicate)!;
}

/** 共享服务器的工作区根（所有用例的项目目录都建在它下面，after 统一清理） */
let tmpRoot: string;
/** 用例项目目录登记表（after 逐个清理引擎落盘区 ~/.deepcode/projects/<code>） */
const caseDirs: string[] = [];
let server: RunningWebServer;
let cookie: string;
/** 主对话脚本客户端（per-test setScript 切换） */
let main: ScriptedLLMClient;
/** 独立意图分类客户端（per-test 重赋值；生产回退链每次 createLLMClient 求值） */
let classifier: ScriptedClassifierClient;

before(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-steering-"));
  const settings = createResolvedSettings({
    allowRoots: [tmpRoot],
    uploadDir: path.join(tmpRoot, "uploads"),
    engineHomeRoot: path.join(tmpRoot, "engine-home"),
    auth: {
      jwtSecret: "steering-flow-test-secret",
      sessionTtlSeconds: 3600,
      localUsers: [{ username: "admin", passwordHash: sha256Hex("steering-pass") }],
    },
  });
  main = new ScriptedLLMClient([], 5);
  classifier = new ScriptedClassifierClient('{"intent":"steer","reason":"测试脚本"}');
  server = await startWebServer(settings, {
    createLLMClient: () => main,
    // W2 测试缝合点：独立分类客户端工厂（每次分类求值 → per-test 重赋值 classifier 生效）。
    // 不注入时 core 回退 this.createLLMClient()——测试环境无凭据返回 null，
    // 分类必抛错降级，无法断言 steer 注入链路。
    classifyLlmClientFactory: () => classifier,
    createOpenAIClient: () => createControlledOpenAIClientHandle(),
    registryBaseDir: path.join(tmpRoot, "registry"),
  });

  const login = await fetchJson(server.port, "POST", "/api/auth/login", {
    username: "admin",
    password: "steering-pass",
  });
  assert.equal(login.status, 200, "登录前置条件失败");
  cookie = extractAuthCookie(login.headers)!;
});

after(async () => {
  await server.close();
  // 引擎把会话历史落在 ~/.deepcode/projects/<projectCode>（项目目录删除不影响），
  // 逐用例清理，避免本机残留（与 permission-flow.test.ts 同款收尾）
  for (const dir of caseDirs) {
    const projectCode = getProjectCode(dir);
    rmSync(path.join(homedir(), ".deepcode", "projects", projectCode), { recursive: true, force: true });
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * 创建测试会话——独立临时项目目录（默认）或指定目录。
 *
 * 独立目录是**正确性要求**而非卫生要求：core 会话索引按 projectRoot 哈希共享
 * 读写，同根并存 manager 互相覆盖索引 → updateSessionEntry 找不到条目 →
 * status 冻结、status 事件停更（见文件头注释）。
 *
 * @param projectRoot 指定项目根（省略时在共享根下新建独立 mkdtemp 目录）
 * @returns chatId
 */
async function createChat(projectRoot?: string): Promise<string> {
  const root = projectRoot ?? mkdtempSync(path.join(tmpRoot, "case-"));
  caseDirs.push(root);
  const created = await fetchJson(server.port, "POST", "/api/chats", { projectRoot: root }, cookie);
  assert.equal(created.status, 200, `创建会话失败：${JSON.stringify(created.body)}`);
  return created.body.chatId as string;
}

/**
 * ST3 专用：manual 权限模式项目目录（与 permission-flow.test.ts 同款设置文件，
 * 隔离本机 ~/.deepcode/settings.json 影响；bash 缺省 sideEffects →
 * unknown scope → 必 ask）。审批等待中补充指令一律 queued 的验证必须
 * 真实进入 ask_permission 暂停态，因此仅此用例使用 manual 目录。
 */
function makeManualPermissionRoot(): string {
  const root = mkdtempSync(path.join(tmpRoot, "case-manual-"));
  mkdirSync(path.join(root, ".deepcode"), { recursive: true });
  writeFileSync(
    path.join(root, ".deepcode", "settings.json"),
    JSON.stringify({ permissions: { mode: "manual", allow: [], deny: [], ask: [], defaultMode: "allowAll" } }, null, 2),
    "utf8"
  );
  return root;
}

/**
 * 发送 JSON 文本消息（返回状态码与响应体）。
 *
 * @param chatId 会话 id
 * @param text 消息文本
 */
async function sendText(chatId: string, text: string): Promise<{ status: number; body: any }> {
  return fetchJson(server.port, "POST", `/api/chats/${chatId}/messages`, { text }, cookie);
}

/** 构造一个 end_turn 收敛脚本。 */
function endTurnScript(text: string): LLMStreamEvent[] {
  return [
    { type: "text_delta", text },
    { type: "message_end", stopReason: "end_turn", usage: null },
  ];
}

/**
 * 构造「注入 system 消息落盘则收尾」的脚本（ST1/ST9 专用，持续流模式）。
 *
 * 返回值两种形态：
 * - end_turn 脚本：上下文含注入 system 消息（E2 已 drain）→ 收敛；
 * - "keepalive" 标记：走 ScriptedLLMClient 的持续文本流（事件无限循环，
 *   每事件 yieldDelayMs，轮次全程 processing，无审批节拍）。
 *
 * 为什么只有注入 system 消息才收敛（queued 排队的补充 user 消息不收敛）：
 * steer 路径下补充指令文本经 sendMessage 先上链——若脚本对 user 文本也收敛，
 * 注入 system 消息可能来不及落盘（分类窗口与主流水竞态），E2 drain 的
 * 注入帧断言将不稳定；持续流保证注入必被下一迭代消费。
 *
 * @param injectText 注入指令原文（识别注入 system 消息）
 */
function scriptedStreamUntilSystemInject(injectText: string): (request: LLMRequest) => LLMStreamEvent[] | "keepalive" {
  return (request: LLMRequest) => {
    const drained = request.messages.some(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.includes(injectText)
    );
    if (drained) {
      return endTurnScript("已按补充指令调整");
    }
    return "keepalive";
  };
}

/**
 * 构造「补充文本进入上下文则收尾」的脚本（ST2 queued 语义专用）。
 *
 * 返回值两种形态：
 * - end_turn 脚本：上下文含补充文本（注入 system 消息或 queued 轮 user
 *   消息均算）→ 收敛——queued 补充轮执行本身就是「排队轮照常执行」断言点；
 * - "keepalive" 标记：走 ScriptedLLMClient 持续文本流（同
 *   scriptedStreamUntilSystemInject），处理窗口稳定。
 *
 * ST2 安全性：steer 走不通（分类 next），补充文本只会在排队轮作为 user
 * 消息进入上下文——持续流期间排队不启动，补充文本必然在排队轮收敛。
 *
 * @param injectText 补充指令原文
 */
function scriptedStreamUntilInjected(injectText: string): (request: LLMRequest) => LLMStreamEvent[] | "keepalive" {
  return (request: LLMRequest) => {
    const consumed = request.messages.some(
      (m) =>
        (m.role === "system" || m.role === "user") && typeof m.content === "string" && m.content.includes(injectText)
    );
    if (consumed) {
      return endTurnScript("已按补充指令调整");
    }
    return "keepalive";
  };
}

/**
 * 审批放行（ST3 审批等待场景专用）。
 *
 * 前提：当前会话有待审批的 bash 工具调用（manual 模式首迭代 ask 后 done 收敛）。
 *
 * @param chatId 会话 id
 * @param toolCallId 待放行工具调用 id（来自 permission_request 明细）
 */
async function approveToolCall(chatId: string, toolCallId: string): Promise<void> {
  const approve = await fetchJson(
    server.port,
    "POST",
    `/api/chats/${chatId}/messages`,
    { permissions: [{ toolCallId, permission: "allow" }] },
    cookie
  );
  assert.equal(approve.status, 202, `审批放行应 202：${JSON.stringify(approve.body)}`);
}

/**
 * 等待累计出现 ≥ count 个 done 帧并返回最后一帧。
 *
 * SseCollector.waitFor 只匹配「首个」事件；同流多次 done 时必须按计数等待
 * （permission-flow.test.ts 同款教训）。
 *
 * @param collector SSE 收集器
 * @param count 期望 done 累计数（下限）
 * @param timeoutMs 超时毫秒
 * @returns 最后一个 done 事件帧
 */
async function waitForDoneFrame(
  collector: SseCollector,
  count: number,
  timeoutMs: number
): Promise<{ event: string; data: any }> {
  await waitForCondition(() => collector.countOf("done") >= count, timeoutMs, 20);
  const dones = collector.events.filter((item) => item.event === "done");
  return dones[dones.length - 1];
}

/** 长文本流脚本（yield 延迟制造运行中窗口；text 为每块文本）。 */
function longScript(chunk: string, blocks: number): LLMStreamEvent[] {
  return [
    ...Array.from({ length: blocks }, () => ({ type: "text_delta", text: chunk }) as LLMStreamEvent),
    { type: "message_end", stopReason: "end_turn", usage: null },
  ];
}

/**
 * 启动一个 steering 独立测试服务器（指定项目根、主脚本客户端与分类器工厂）。
 *
 * 注入类用例（ST1/ST4）与既有主服务器互不干扰（独立端口 + 独立 registry），
 * 长流窗口由 slowMain 的 yieldDelayMs 保证。
 *
 * @param projectRoot 该用例专属项目根
 * @param mainClient 主对话脚本客户端
 * @param classifierFactory 分类客户端工厂（每次分类求值）
 * @returns RunningWebServer
 */
async function startSteeringServer(
  projectRoot: string,
  mainClient: ScriptedLLMClient,
  classifierFactory: () => ScriptedClassifierClient
): Promise<RunningWebServer> {
  return startWebServer(
    createResolvedSettings({
      allowRoots: [projectRoot],
      uploadDir: path.join(projectRoot, "uploads"),
      engineHomeRoot: path.join(projectRoot, "engine-home"),
      auth: {
        jwtSecret: "steering-case-secret",
        sessionTtlSeconds: 3600,
        localUsers: [{ username: "admin", passwordHash: sha256Hex("steering-pass") }],
      },
    }),
    {
      createLLMClient: () => mainClient,
      classifyLlmClientFactory: classifierFactory,
      createOpenAIClient: () => createControlledOpenAIClientHandle(),
      registryBaseDir: path.join(projectRoot, "registry"),
    }
  );
}

/** 登录 steering 独立服务器并返回认证 Cookie。 */
async function loginSteering(port: number): Promise<string> {
  const login = await fetchJson(port, "POST", "/api/auth/login", { username: "admin", password: "steering-pass" });
  assert.equal(login.status, 200, "steering 独立服务器登录失败");
  return extractAuthCookie(login.headers)!;
}

/** 在指定服务器创建会话（同一 projectRoot）。 */
async function createChatOn(port: number, cookieValue: string, projectRoot: string): Promise<string> {
  const created = await fetchJson(port, "POST", "/api/chats", { projectRoot }, cookieValue);
  assert.equal(created.status, 200, `创建会话失败：${JSON.stringify(created.body)}`);
  return created.body.chatId as string;
}

/** 关闭 steering 独立服务器并清理引擎落盘区。 */
async function closeSteeringServer(serverToClose: RunningWebServer, dirs: string[]): Promise<void> {
  await serverToClose.close();
  for (const dir of dirs) {
    rmSync(path.join(homedir(), ".deepcode", "projects", getProjectCode(dir)), { recursive: true, force: true });
  }
}

// ============================================================================
// ST1：运行中 + 分类 steer → 202 steered + 注入全链路（E3/E2 消费 + 双帧桥接）
// ST6：注入 system 消息进入会话历史（GET messages 含 meta.steeringInject）
// ============================================================================

test("ST1/ST6：运行中补充指令判定 steer → 202 steered，E2 消费合成注入 system 消息（实时帧 + 历史 meta 双断言）", async () => {
  classifier = new ScriptedClassifierClient('{"intent":"steer","reason":"对当前任务的修正"}');
  const injectText = "改用 pnpm 安装依赖";
  // 持续流保活：注入 system 消息落盘前轮次永不收敛（processing 全程稳定）
  const slowMain = new ScriptedLLMClient(scriptedStreamUntilSystemInject(injectText), 5);
  slowMain.startInfiniteStream([{ type: "text_delta", text: "生成中 " } as LLMStreamEvent]);
  const offClassifier = classifier;
  const chatRoot = mkdtempSync(path.join(tmpRoot, "case-"));
  const caseDirs = [chatRoot];
  const offServer = await startSteeringServer(chatRoot, slowMain, () => offClassifier);
  try {
    const offCookie = await loginSteering(offServer.port);
    const chatId = await createChatOn(offServer.port, offCookie, chatRoot);
    const { collector, controller } = await openSseStream(offServer.port, chatId, offCookie);

    // 第一轮：持续文本流——turnActive/processing 无限稳定，注入窗口完全可控
    const first = await fetchJson(
      offServer.port,
      "POST",
      `/api/chats/${chatId}/messages`,
      { text: "帮我搭一个项目" },
      offCookie
    );
    assert.equal(first.status, 202);
    assert.equal(first.body.mode, "queued");
    await waitForCondition(() => slowMain.requestLog.length >= 1, 15000, 10);

    // 运行中补充指令：分类 steer → 注入（第一次活性检查 + 分类 + 二次检查全通过）
    const second = await fetchJson(
      offServer.port,
      "POST",
      `/api/chats/${chatId}/messages`,
      { text: injectText },
      offCookie
    );
    assert.equal(second.status, 202, `补充指令应 202：${JSON.stringify(second.body)}`);
    assert.equal(second.body.mode, "steered", `分类 steer 应注入：${JSON.stringify(second.body)}`);
    assert.equal(offClassifier.requestLog.length, 1, "steer 路径应恰好一次分类请求");

    // 注入进入下一迭代上下文（E2 drain）→ end_turn → done 收敛
    const finalDone = await waitForDoneFrame(collector, 1, 30000);

    // E2 消费：注入 system 消息经 assistant_message 桥接（role=system + meta.steeringInject + 原文）
    const steeringFrame = collector.events.find(
      (item) =>
        item.event === "assistant_message" && item.data?.role === "system" && item.data?.meta?.steeringInject === true
    );
    assert.ok(
      steeringFrame,
      `未收到注入 system 帧；已收到 assistant_message：${JSON.stringify(
        collector.events.filter((item) => item.event === "assistant_message").map((item) => item.data)
      )}`
    );
    assert.ok(String(steeringFrame!.data.content).includes(injectText), "注入帧必须包含指令原文");

    // E2 drain 落点：注入 system 消息进入收敛迭代的 LLM 请求上下文
    const injectedRequest = slowMain.requestLog.find((entry) =>
      entry.request.messages.some(
        (m) => m.role === "system" && typeof m.content === "string" && m.content.includes(injectText)
      )
    );
    assert.ok(injectedRequest, "注入 system 消息必须出现在后续 LLM 请求上下文（E2 drain）");

    // W4a：注入成功即广播 user_message 帧（role=user + 原文）
    const userFrame = collector.events.find(
      (item) => item.event === "user_message" && item.data?.message?.content === injectText
    );
    assert.ok(userFrame, "注入路径必须广播 user_message 帧（W4a）");
    assert.equal(userFrame!.data.message.role, "user");

    controller.abort();
    assert.equal(finalDone.data.chatId, chatId);

    // ST6：注入 system 消息已落盘进入会话历史（带 meta.steeringInject）
    const messages = await fetchJson(offServer.port, "GET", `/api/chats/${chatId}/messages`, undefined, offCookie);
    assert.equal(messages.status, 200);
    const historyInject = messages.body.messages.find(
      (m: any) => m.role === "system" && m.meta?.steeringInject === true
    );
    assert.ok(historyInject, "历史消息必须含注入 system 消息（meta.steeringInject 持久化，ST6）");
    assert.ok(String(historyInject.content).includes(injectText));
  } finally {
    slowMain.stopInfiniteStream();
    await closeSteeringServer(offServer, caseDirs);
  }
});

// ============================================================================
// ST2：运行中 + 分类 next → queued，串行链执行新轮（done ×2）
// ST7：user_message 帧——第二订阅者实时收到排队消息
// ============================================================================

test("ST2/ST7：运行中补充指令判定 next → queued 排队执行；第二订阅者实时收到 user_message 帧", async () => {
  const nextClassifier = new ScriptedClassifierClient('{"intent":"next","reason":"无关新任务"}');
  const supplementText = "顺便查一下天气";
  // 持续流保活：queued 补充轮执行时（其 user 消息含补充文本）才收敛——
  // 「排队轮照常执行」本身就是断言点；持续流同时保证分类窗口内活性稳定
  const slowMain = new ScriptedLLMClient(scriptedStreamUntilInjected(supplementText), 5);
  slowMain.startInfiniteStream([{ type: "text_delta", text: "生成中 " } as LLMStreamEvent]);
  const chatRoot = mkdtempSync(path.join(tmpRoot, "case-"));
  const caseDirs = [chatRoot];
  const offServer = await startSteeringServer(chatRoot, slowMain, () => nextClassifier);
  try {
    const offCookie = await loginSteering(offServer.port);
    const chatId = await createChatOn(offServer.port, offCookie, chatRoot);
    const { collector, controller } = await openSseStream(offServer.port, chatId, offCookie);
    // 第二订阅者（ST7：排队消息的 user_message 帧实时到达第二订阅者）
    const sub2 = await openSseStream(offServer.port, chatId, offCookie);

    // 第一轮：持续文本流（处理窗口无限稳定）
    const first = await fetchJson(
      offServer.port,
      "POST",
      `/api/chats/${chatId}/messages`,
      { text: "长任务" },
      offCookie
    );
    assert.equal(first.status, 202);
    assert.equal(first.body.mode, "queued");
    await waitForCondition(() => slowMain.requestLog.length >= 1, 15000, 10);

    // 运行中补充指令：活性检查通过 → 分类 next → 排队（不入注入队列）
    const second = await fetchJson(
      offServer.port,
      "POST",
      `/api/chats/${chatId}/messages`,
      { text: supplementText },
      offCookie
    );
    assert.equal(second.status, 202);
    assert.equal(second.body.mode, "queued", `分类 next 应排队：${JSON.stringify(second.body)}`);
    assert.equal(nextClassifier.requestLog.length, 1, "next 路径应恰好一次分类请求");

    // 第二订阅者实时收到排队消息的 user_message 帧（ST7，主轮处理中即广播）。
    // 按内容匹配：第一轮的「长任务」user_message 帧先于补充消息到达，
    // waitFor 只匹配首个事件名会拿到主任务帧，必须用 waitForEvent 按文本过滤。
    const queuedFrame = await waitForEvent(
      sub2.collector,
      (item) => item.event === "user_message" && item.data?.message?.content === supplementText,
      15000
    );
    sub2.controller.abort();
    assert.equal(queuedFrame.data.message.content, supplementText, "排队路径必须向第二订阅者广播补充文本（ST7）");
    assert.equal(queuedFrame.data.message.role, "user");

    // 停持续流：当前轮收敛（done1）→ 排队补充轮执行——脚本对补充文本
    // （user 或注入 system 均算）落盘即 end_turn。分类判 next 时注入队列
    // 未被写入（queued 不入队），补充轮是普通用户轮，无注入 system 消息
    // → 走兜底 end_turn 收敛。done ×2 证明排队轮真正执行过（ST2 串行链）。
    slowMain.stopInfiniteStream();
    const done2 = await waitForDoneFrame(collector, 2, 30000);
    sub2.controller.abort();
    controller.abort();
    assert.equal(done2.data.chatId, chatId);
    assert.equal(collector.countOf("done"), 2, "queued 语义：每排队轮恰好一个 done（ST2）");
  } finally {
    slowMain.stopInfiniteStream();
    await closeSteeringServer(offServer, caseDirs);
  }
});

// ============================================================================
// ST3/ST10：ask_permission 审批等待中发送 → 一律 queued（不分类、不注入）
// ============================================================================

test("ST3/ST10：审批等待中补充指令一律 queued（零分类请求），审批回注后排队轮照常执行", async () => {
  classifier = new ScriptedClassifierClient('{"intent":"steer","reason":"脚本"}');
  // manual 权限模式独立目录：bash 缺省 sideEffects → unknown scope → 必然 ask
  const chatId = await createChat(makeManualPermissionRoot());
  const { collector, controller } = await openSseStream(server.port, chatId, cookie);

  // 脚本：请求未带工具结果 → 请求 bash 工具触发审批等待；带工具结果 → 正常收敛
  main.setScript((request: LLMRequest) => {
    const hasToolResult = request.messages.some((m) => m.role === "tool");
    if (hasToolResult) {
      return endTurnScript("审批后继续完成任务");
    }
    return [
      { type: "tool_call_start", id: "st3-tool", name: "bash" },
      {
        type: "tool_call_delta",
        id: "st3-tool",
        argumentsJsonDelta: JSON.stringify({ command: "echo st3-ok", description: "审批等待测试" }),
      },
      { type: "tool_call_end", id: "st3-tool" },
      { type: "message_end", stopReason: "tool_use", usage: null },
    ];
  });

  const first = await sendText(chatId, "列一下当前目录");
  assert.equal(first.body.mode, "queued");

  // 等引擎进入审批等待（ask_permission 时 runTurn 已结束，turnActive=false）
  const permFrame = await collector.waitFor("permission_request", 20000);
  const requests = permFrame.data.requests as Array<{ toolCallId: string }>;
  assert.ok(Array.isArray(requests) && requests.length > 0, "permission_request 必须携带明细");
  // 审批暂停轮的 done 必须先收敛（runTurn finally 置 turnActive=false 的可靠信号）
  const permDone = await waitForDoneFrame(collector, 1, 20000);
  assert.equal(
    permDone.data.status,
    "ask_permission",
    `审批暂停轮 done 状态应为 ask_permission（实际 ${permDone.data.status}）`
  );

  // 审批等待中补充指令：分类计数不变（第一次活性检查即拦截）
  const classifierBefore = classifier.requestLog.length;
  const supplemental = await sendText(chatId, "顺便加一个 .gitignore");
  assert.equal(supplemental.status, 202);
  assert.equal(supplemental.body.mode, "queued", "审批等待中补充指令必须排队（S3/W4 双保险）");
  assert.equal(classifier.requestLog.length, classifierBefore, "审批等待中零分类请求（W6a 第一次活性检查）");

  // 审批放行 → 当前轮收敛（done）；排队轮接着执行（done ≥2）
  await approveToolCall(chatId, requests[0].toolCallId);
  await waitForCondition(() => collector.countOf("done") >= 2, 30000, 20);

  // 排队消息最终成为新轮：消息历史含该 user 文本
  const messages = await fetchJson(server.port, "GET", `/api/chats/${chatId}/messages`, undefined, cookie);
  const queuedUser = messages.body.messages.find(
    (m: any) => m.role === "user" && String(m.content ?? "").includes("顺便加一个 .gitignore")
  );
  assert.ok(queuedUser, "排队消息在审批后成为新轮（ST3 后半段）");
  controller.abort();
});

// ============================================================================
// ST4：分类器抛错 → queued 降级；ST4b：分类器空 content → 解析失败 → queued
// ============================================================================

test("ST4/ST4b：分类器抛错 / 空输出 → 一律降级 queued（保守安全），当前轮不受影响", async () => {
  // 抛错分类器（ST4）→ 空输出分类器（ST4b）：工厂每次分类求值最新引用
  const badClassifier = new ScriptedClassifierClient("", new Error("classifier down"));
  const emptyClassifier = new ScriptedClassifierClient("");
  const emptyText = "补充指令A";
  const injectText = "输出用中文";
  const slowMain = new ScriptedLLMClient(scriptedStreamUntilSystemInject(injectText), 5);
  slowMain.startInfiniteStream([{ type: "text_delta", text: "生成中 " } as LLMStreamEvent]);
  const chatRoot = mkdtempSync(path.join(tmpRoot, "case-"));
  const caseDirs = [chatRoot];
  const offServer = await startSteeringServer(chatRoot, slowMain, () =>
    badClassifier.requestLog.length === 0 ? badClassifier : emptyClassifier
  );
  try {
    const offCookie = await loginSteering(offServer.port);
    const chatId = await createChatOn(offServer.port, offCookie, chatRoot);
    const { collector, controller } = await openSseStream(offServer.port, chatId, offCookie);

    // 第一轮：持续文本流——处理窗口无限稳定，两个降级分类都有充分节拍
    const first = await fetchJson(
      offServer.port,
      "POST",
      `/api/chats/${chatId}/messages`,
      { text: "帮我搭一个项目" },
      offCookie
    );
    assert.equal(first.status, 202);
    assert.equal(first.body.mode, "queued");
    await waitForCondition(() => slowMain.requestLog.length >= 1, 15000, 10);

    // ST4：运行中补充指令——抛错分类器 → 降级排队（当前轮不受影响、持续流未断）
    const bad1 = await fetchJson(
      offServer.port,
      "POST",
      `/api/chats/${chatId}/messages`,
      { text: emptyText },
      offCookie
    );
    assert.equal(bad1.status, 202);
    assert.equal(bad1.body.mode, "queued", `分类器抛错应降级排队：${JSON.stringify(bad1.body)}`);
    assert.equal(badClassifier.requestLog.length, 1, "ST4 恰一次分类请求（抛错后降级）");
    assert.equal(slowMain.requestLog.length >= 1, true, "降级后当前轮仍在处理（持续流未断）");

    // ST4b：运行中再补一条——空输出分类器 → 解析失败 → 降级排队
    const bad2 = await fetchJson(
      offServer.port,
      "POST",
      `/api/chats/${chatId}/messages`,
      { text: injectText },
      offCookie
    );
    assert.equal(bad2.status, 202);
    assert.equal(bad2.body.mode, "queued", `分类器空输出应解析失败降级排队：${JSON.stringify(bad2.body)}`);
    assert.equal(emptyClassifier.requestLog.length, 1, "ST4b 恰一次分类请求（解析失败降级）");

    // 降级未污染当前轮：无注入帧、无 steered（幽灵注入防御）
    const injectFrames = collector.events.filter(
      (item) => item.event === "assistant_message" && item.data?.meta?.steeringInject === true
    );
    assert.equal(injectFrames.length, 0, "降级路径绝不产生注入帧（ST11 同源防御）");

    // 收尾：停持续流（脚本落回 end_turn）→ 当前轮收敛 + 排队补充轮执行 → done ×3
    slowMain.stopInfiniteStream();
    const done3 = await waitForDoneFrame(collector, 3, 30000);
    controller.abort();
    assert.equal(done3.data.chatId, chatId);
    assert.equal(collector.countOf("done"), 3, "两条排队补充轮 + 当前轮各一个 done（无幽灵等待）");
  } finally {
    slowMain.stopInfiniteStream();
    await closeSteeringServer(offServer, caseDirs);
  }
});

// ============================================================================
// ST5：空闲发送 → queued 且零分类请求（零回归主断言）
// ============================================================================

test("ST5：空闲发送补充消息直接 queued，分类客户端零请求（零回归）", async () => {
  classifier = new ScriptedClassifierClient('{"intent":"steer","reason":"脚本"}');
  main.setScript(endTurnScript("完成"));
  const chatId = await createChat();
  const { collector, controller } = await openSseStream(server.port, chatId, cookie);
  const donePromise = collector.waitFor("done", 15000);

  const before = classifier.requestLog.length;
  const send = await sendText(chatId, "空闲时发的消息");
  assert.equal(send.status, 202);
  assert.equal(send.body.mode, "queued", "空闲发送一律排队（旧语义）");
  assert.equal(classifier.requestLog.length, before, "空闲路径零分类请求（不触达模型）");

  await donePromise;
  controller.abort();
});

// ============================================================================
// ST8：status 快照含 pendingTurns/turnActive（订阅初始快照）
// ============================================================================

test("ST8：SSE 初始快照携带 pendingTurns/turnActive（空闲全 0，W1③）", async () => {
  const chatId = await createChat();
  const idle = await openSseStream(server.port, chatId, cookie);
  const snap = await idle.collector.waitFor("status", 5000);
  assert.equal(typeof snap.data.turnActive, "boolean", "status 快照必须携带 turnActive（W1③）");
  assert.equal(typeof snap.data.pendingTurns, "number", "status 快照必须携带 pendingTurns（W1③）");
  assert.equal(snap.data.turnActive, false, "空闲快照 turnActive 必须 false");
  assert.equal(snap.data.pendingTurns, 0, "空闲快照 pendingTurns 必须 0");
  idle.controller.abort();
});

// ============================================================================
// ST9：注入后当前轮正常收敛 → done.pendingTurns 语义不被破坏（无幽灵等待）
// ============================================================================

test("ST9：注入后当前轮正常收敛，done.pendingTurns 语义不被注入破坏（无幽灵等待）", async () => {
  const steerClassifier = new ScriptedClassifierClient('{"intent":"steer","reason":"修正当前任务"}');
  const injectText = "输出用中文";
  // 持续流保活：注入落盘（E2 drain）才收敛——done 必为注入轮自身，无排队轮干扰
  const slowMain = new ScriptedLLMClient(scriptedStreamUntilSystemInject(injectText), 5);
  slowMain.startInfiniteStream([{ type: "text_delta", text: "生成中 " } as LLMStreamEvent]);
  const chatRoot = mkdtempSync(path.join(tmpRoot, "case-"));
  const caseDirs = [chatRoot];
  const offServer = await startSteeringServer(chatRoot, slowMain, () => steerClassifier);
  try {
    const offCookie = await loginSteering(offServer.port);
    const chatId = await createChatOn(offServer.port, offCookie, chatRoot);
    const { collector, controller } = await openSseStream(offServer.port, chatId, offCookie);

    const first = await fetchJson(
      offServer.port,
      "POST",
      `/api/chats/${chatId}/messages`,
      { text: "写一个排序函数" },
      offCookie
    );
    assert.equal(first.status, 202);
    assert.equal(first.body.mode, "queued");
    await waitForCondition(() => slowMain.requestLog.length >= 1, 15000, 10);

    const second = await fetchJson(
      offServer.port,
      "POST",
      `/api/chats/${chatId}/messages`,
      { text: injectText },
      offCookie
    );
    assert.equal(second.status, 202);
    assert.equal(second.body.mode, "steered", `脚本 steer 应注入：${JSON.stringify(second.body)}`);
    assert.equal(steerClassifier.requestLog.length, 1, "steer 路径应恰好一次分类请求");

    // 注入消费 → end_turn → 当前轮 done：注入不占排队计数，pendingTurns 必为 0
    const done = await waitForDoneFrame(collector, 1, 30000);
    controller.abort();
    assert.equal(done.data.chatId, chatId);
    assert.equal(collector.countOf("done"), 1, "注入轮是唯一 done（steer 不入队）");
    assert.equal(done.data.pendingTurns, 0, "注入不占 pendingTurns，当前轮 done 剩余 0（ST9）");
  } finally {
    slowMain.stopInfiniteStream();
    await closeSteeringServer(offServer, caseDirs);
  }
});

// ============================================================================
// ST11：分类窗口内轮次收敛 → W6 二次检查降级 queued（无幽灵注入）
// ============================================================================

test("ST11：分类窗口内轮次恰好收敛 → 二次检查降级 queued，无幽灵注入帧/steered 回执", async () => {
  const chatId = await createChat();

  // 慢分类器（输出本身合法 steer）：600ms 窗口；短主流水在窗口内必然收敛
  classifier = new ScriptedClassifierClient('{"intent":"steer","reason":"脚本"}', undefined, 600);
  main.setScript(longScript("短", 40));

  const { collector, controller } = await openSseStream(server.port, chatId, cookie);
  const firstDone = collector.waitFor("done", 15000);
  const first = await sendText(chatId, "第一轮");
  assert.equal(first.body.mode, "queued");
  // 等第一个 LLM 请求已开始（turnActive=true）；主流水约 200ms < 分类 600ms
  await waitForCondition(() => main.requestLog.length >= 1, 5000, 5);
  const second = await sendText(chatId, "改一下输出格式");
  assert.equal(second.status, 202);
  // 分类完成时第一轮已收敛 → injectSteering 二次活性检查拒绝 → 降级 queued
  assert.equal(second.body.mode, "queued", `分类窗口竞态必须降级排队：${JSON.stringify(second.body)}`);

  // 无幽灵注入：注入帧绝不出现（steer 判定成立但活性检查兜底）
  const injectFrames = collector.events.filter(
    (item) => item.event === "assistant_message" && item.data?.meta?.steeringInject === true
  );
  assert.equal(injectFrames.length, 0, "竞态路径不得出现注入帧（ST11）");

  await firstDone;
  // 降级排队的补充指令作为新轮执行（done ≥2）
  await waitForCondition(() => collector.countOf("done") >= 2, 30000, 20);
  controller.abort();
});

// ============================================================================
// 配置开关：steeringEnabled=false → 运行中补充一律 queued（回退旧行为）
// ============================================================================

test("steeringEnabled=false：运行中补充消息一律 queued 零分类（web.steeringEnabled 回退开关）", async () => {
  const offRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-steering-off-"));
  const offClassifier = new ScriptedClassifierClient('{"intent":"steer","reason":"脚本"}');
  const offMain = new ScriptedLLMClient(longScript("生成中", 120), 5);
  const offServer = await startWebServer(
    createResolvedSettings({
      allowRoots: [offRoot],
      uploadDir: path.join(offRoot, "uploads"),
      engineHomeRoot: path.join(offRoot, "engine-home"),
      steeringEnabled: false,
      auth: {
        jwtSecret: "steering-off-test-secret",
        sessionTtlSeconds: 3600,
        localUsers: [{ username: "admin", passwordHash: sha256Hex("off-pass") }],
      },
    }),
    {
      createLLMClient: () => offMain,
      classifyLlmClientFactory: () => offClassifier,
      createOpenAIClient: () => createControlledOpenAIClientHandle(),
      registryBaseDir: path.join(offRoot, "registry"),
    }
  );
  try {
    const login = await fetchJson(offServer.port, "POST", "/api/auth/login", {
      username: "admin",
      password: "off-pass",
    });
    assert.equal(login.status, 200, "off 服务器登录失败");
    const offCookie = extractAuthCookie(login.headers)!;
    const created = await fetchJson(offServer.port, "POST", "/api/chats", { projectRoot: offRoot }, offCookie);
    assert.equal(created.status, 200, `off 服务器创建会话失败：${JSON.stringify(created.body)}`);
    const chatId = created.body.chatId as string;

    const send = await fetchJson(offServer.port, "POST", `/api/chats/${chatId}/messages`, { text: "任务" }, offCookie);
    assert.equal(send.body.mode, "queued");
    // 运行中补充：等第一个请求已开始流式（≈600ms 长流）
    await waitForCondition(() => offMain.requestLog.length >= 1, 15000, 20);
    const supplemental = await fetchJson(
      offServer.port,
      "POST",
      `/api/chats/${chatId}/messages`,
      { text: "补充" },
      offCookie
    );
    assert.equal(supplemental.body.mode, "queued", "steeringEnabled=false 一律排队（W7 回退开关）");
    assert.equal(offClassifier.requestLog.length, 0, "steeringEnabled=false 零分类请求");
  } finally {
    await offServer.close();
    // off 用例的引擎落盘区同步清理（offRoot 是 createChat 之外的独立目录）
    rmSync(path.join(homedir(), ".deepcode", "projects", getProjectCode(offRoot)), { recursive: true, force: true });
    rmSync(offRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// 边界：补充指令路径不旁路认证与归属校验
// ============================================================================

test("补充指令路径边界：未认证 401、不存在会话 404（认证/归属不旁路）", async () => {
  const chatId = await createChat();
  const noAuth = await fetchJson(server.port, "POST", `/api/chats/${chatId}/messages`, { text: "x" });
  assert.equal(noAuth.status, 401, "未认证一律 401（补充指令路径不旁路认证）");
  const notFound = await fetchJson(server.port, "POST", "/api/chats/nonexistent-chat/messages", { text: "x" }, cookie);
  assert.equal(notFound.status, 404, "不存在会话一律 404（补充指令路径不旁路归属校验）");
});
