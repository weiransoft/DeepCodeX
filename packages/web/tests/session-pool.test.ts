/**
 * SessionPool 单元测试（src/session-pool.ts）。
 *
 * 注入策略（无 mock 框架）：
 * - createLLMClient 缝合点注入 ScriptedLLMClient（真实实现 LLMClient 接口的受控客户端）；
 * - createOpenAIClient 缝合点注入真实结构的受控连接句柄（activateSession 要求非空）；
 * - SseHub 经 addSink 缝合点挂真实受控 sink 收集 SSE 帧；
 * - projectRoot 使用 mkdtemp 真实目录；磁盘历史用例真实读写 ~/.deepcode/projects（用后清理）。
 *
 * 覆盖：createChat 牢笼校验、事件桥接（llm_delta/assistant_message/tool_progress/status/done）、
 * 202 同步受理契约（sendMessage 立即返回 {chatId, sessionId}，轮次经 SSE done 收尾）、
 * 同 chatId 串行化、interrupt 生效、轮次异常 done(failed) 收尾、
 * listChats 活跃+磁盘历史合并、disposeAll。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { getProjectCode, type LLMStreamEvent } from "@vegamo/deepcode-core";
import { SessionPool } from "../src/session-pool";
import { SseHub, type SseSink } from "../src/events";
import { buildJailRoots } from "../src/jail";
import type { SendMessageInput } from "../src/session-pool";
import { createControlledOpenAIClientHandle, createResolvedSettings, ScriptedLLMClient } from "./helpers";

/** 共享临时项目根（牢笼白名单） */
let tmpRoot: string;
let pool: SessionPool;
let hub: SseHub;
let client: ScriptedLLMClient;

/** 全部用例创建的 hub/pool（全局 after 统一释放，防止心跳定时器/引擎句柄让测试子进程无法退出） */
const createdHubs: SseHub[] = [];
const createdPools: SessionPool[] = [];

/** 受控 sink 收集的全部 SSE 帧（chatId 不分，单池内用例串行执行） */
const frames: Array<{ chatId: string; event: string; data: any }> = [];

/**
 * 构造收集帧的受控 sink（真实 SseSink 实现：write 收集 + close 置位）。
 */
function createCollectingSink(): SseSink {
  return {
    write: (chunk: string | Uint8Array): boolean => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const eventMatch = /event: (.+)\ndata: (.+)\n\n/.exec(text);
      if (eventMatch) {
        let data: any = null;
        try {
          data = JSON.parse(eventMatch[2]);
        } catch {
          data = eventMatch[2];
        }
        frames.push({ chatId: "*", event: eventMatch[1], data });
      }
      return true;
    },
    close: () => undefined,
  };
}

/** 统计指定 chatId + 事件名的已收帧数（共享 frames 按 data.chatId 匹配，chatId 字段恒为 "*"） */
function countFrames(chatId: string, event: string): number {
  return frames.filter((frame) => frame.data?.chatId === chatId && frame.event === event).length;
}

/**
 * 轮询等待共享 frames 中出现指定 chatId + 事件名的帧。
 *
 * 202 异步受理后轮次在后台执行，用例以帧轮询替代旧版 await 返回值等待；
 * 共享 frames 由收集 sink 写入，匹配依据是载荷中的 data.chatId。
 *
 * @param chatId 目标会话 id
 * @param event 事件名
 * @param timeoutMs 超时毫秒（超时 reject 并附带已收事件清单）
 * @returns 匹配的首帧
 */
function waitForFrame(
  chatId: string,
  event: string,
  timeoutMs = 10000
): Promise<{ chatId: string; event: string; data: any }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = frames.find((frame) => frame.data?.chatId === chatId && frame.event === event);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            `等待 SSE 帧 ${event}（chatId=${chatId}）超时 ${timeoutMs}ms；已收事件：${frames.map((f) => f.event).join(",")}`
          )
        );
      }
    }, 10);
  });
}

/**
 * 轮询等待任意条件成立（多帧计数等待用，如「两轮 done 帧」）。
 *
 * @param predicate 条件函数
 * @param timeoutMs 超时毫秒
 * @param description 条件描述（超时报错用）
 */
async function waitForCondition(predicate: () => boolean, timeoutMs = 10000, description = "条件"): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`等待${description}超时 ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 创建挂好收集 sink 的测试池（每个用例独立池与客户端）。
 *
 * @param script LLM 事件脚本
 * @param yieldDelayMs 事件间延时
 * @returns 池实例
 */
async function createTestPool(
  script: LLMStreamEvent[] | ((request: any) => LLMStreamEvent[]),
  yieldDelayMs = 0
): Promise<SessionPool> {
  const settings = createResolvedSettings({ allowRoots: [tmpRoot] });
  const jailRoots = await buildJailRoots(settings.allowRoots);
  const testHub = new SseHub();
  const testClient = new ScriptedLLMClient(script, yieldDelayMs);
  // 保存最后创建的 client/hub 供用例断言
  client = testClient;
  hub = testHub;
  const testPool = new SessionPool(settings, testHub, jailRoots, {
    createLLMClient: () => testClient,
    createOpenAIClient: () => createControlledOpenAIClientHandle(),
  });
  // 记录实例供全局 after 统一释放（心跳定时器与引擎句柄必须清理，否则测试子进程无法退出）
  createdHubs.push(testHub);
  createdPools.push(testPool);
  pool = testPool;
  return testPool;
}

/**
 * 订阅指定 chatId 的事件到共享 frames（createChat 之后调用）。
 *
 * @param p 池实例
 * @param chatId 会话 id
 */
function subscribeFrames(p: SessionPool, chatId: string): void {
  const sink = createCollectingSink();
  // 借用 hub 的 addSink 缝合点（与 server 的 subscribe 相同底层路径）
  hub.addSink(chatId, sink);
  void p;
}

before(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "deepcode-web-pool-"));
});

after(() => {
  // 统一释放全部 hub（清 15s 心跳 interval）与池（dispose 引擎），保证测试子进程事件循环可排空
  for (const createdHub of createdHubs) {
    createdHub.closeAll();
  }
  for (const createdPool of createdPools) {
    try {
      createdPool.disposeAll();
    } catch {
      // 引擎可能已释放，尽力而为
    }
  }
  createdHubs.length = 0;
  createdPools.length = 0;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("pool：createChat 在牢笼内应成功并返回 UUID 与归一根路径", async () => {
  const p = await createTestPool([]);
  const created = await p.createChat(tmpRoot);

  assert.ok(/^[0-9a-f-]{36}$/.test(created.chatId), "chatId 必须是 UUID");
  assert.equal(created.sessionId, null, "首条消息前 sessionId 为 null");
  // 归一断言：macOS /var → /private/var 符号链接必须被 realpath 消解
  assert.equal(created.projectRoot, await realpath(tmpRoot), "projectRoot 必须是 realpath 归一路径");
});

test("pool：createChat 牢笼外 projectRoot 应抛 JailViolationError", async () => {
  const p = await createTestPool([]);
  const outside = mkdtempSync(path.join(tmpdir(), "deepcode-web-pool-outside-"));
  try {
    await assert.rejects(
      () => p.createChat(outside),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "JailViolationError");
        return true;
      }
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("pool：sendMessage 应同步受理并经 SSE 桥接 llm_delta / assistant_message / done", async () => {
  const script: LLMStreamEvent[] = [
    { type: "text_delta", text: "Hello" },
    { type: "text_delta", text: " world" },
    { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } },
  ];
  const p = await createTestPool(script);
  const { chatId } = await p.createChat(tmpRoot);
  subscribeFrames(p, chatId);

  const input: SendMessageInput = { text: "你好" };
  // 202 异步受理：同步返回 {chatId, sessionId}；首轮受理时底层会话尚未创建，sessionId 为 null
  const accepted = p.sendMessage(chatId, input);
  assert.equal(accepted.chatId, chatId);
  assert.equal(accepted.sessionId, null, "首轮受理时 sessionId 必须为 null");

  // 轮次异步执行：等 done 帧收尾（订阅方不悬死）
  const doneFrame = await waitForFrame(chatId, "done");

  // SSE 桥接断言
  const events = frames.filter((frame) => frame.data?.chatId === chatId).map((frame) => frame.event);
  assert.ok(events.includes("llm_delta"), "必须桥接 llm_delta（onLlmStreamProgress）");
  assert.ok(events.includes("assistant_message"), "必须桥接 assistant_message（onAssistantMessage）");
  assert.ok(events.includes("done"), "必须以 done 收尾");

  const assistant = frames.find((frame) => frame.data?.chatId === chatId && frame.event === "assistant_message");
  assert.equal(assistant!.data.content, "Hello world", "assistant_message 内容为流聚合文本");
  // done 载荷：sessionId 已建立、status 为合法引擎状态（脚本正常完成应为 completed）
  assert.ok(doneFrame.data.sessionId, "done 载荷必须携带已建立的 sessionId");
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
    ].includes(doneFrame.data.status),
    `done 载荷 status 必须为合法 SessionStatus（得到 ${doneFrame.data.status}）`
  );
  assert.equal(doneFrame.data.status, "completed", "脚本正常完成时轮次状态应为 completed");

  // 历史消息：包含用户与助手可见消息
  const messages = p.getMessages(chatId);
  assert.ok(messages.length >= 2, "至少含 user + assistant 两条消息");
  assert.ok(messages.some((message) => message.role === "user" && message.content === "你好"));
  assert.ok(messages.some((message) => message.role === "assistant" && message.content === "Hello world"));
  for (const message of messages) {
    assert.equal(typeof message.visible, "boolean");
    assert.ok(message.createTime !== "" && message.updateTime !== "");
  }
});

test("pool：同一 chatId 的并发 sendMessage 应串行执行（第二轮在第一轮结束后开始）", async () => {
  const infiniteScript = (request: any): LLMStreamEvent[] => {
    void request;
    return Array.from({ length: 8 }, (_, index) => ({ type: "text_delta", text: `chunk-${index} ` }) as LLMStreamEvent);
  };
  const p = await createTestPool(infiniteScript, 15); // 每事件 15ms → 单轮约 120ms
  const { chatId } = await p.createChat(tmpRoot);
  subscribeFrames(p, chatId);

  // 同步受理两次：两次调用均立即返回，轮次在串行链内先后执行
  p.sendMessage(chatId, { text: "第一轮" });
  p.sendMessage(chatId, { text: "第二轮" });

  // 等两轮都收尾（2 个 done 帧）
  await waitForCondition(() => countFrames(chatId, "done") >= 2, 10000, "两轮 done 帧");

  assert.equal(client.requestLog.length, 2, "LLM 客户端恰好收到两次请求");
  const [log1, log2] = client.requestLog;
  assert.ok(log1.end !== null, "第一轮必须已结束");
  assert.ok(
    log2.start >= (log1.end as number) - 2,
    `第二轮开始时间（${log2.start}）必须不早于第一轮结束时间（${log1.end}）`
  );
});

test("pool：不同 chatId 的消息可并行执行", async () => {
  const script: LLMStreamEvent[] = [
    { type: "text_delta", text: "ok" },
    { type: "message_end", stopReason: "end_turn", usage: null },
  ];
  const p = await createTestPool(script, 40); // 每事件 40ms，拉长单轮 LLM 流时长以观察时间区间重叠
  const chatA = await p.createChat(tmpRoot);
  const chatB = await p.createChat(tmpRoot);
  // 帧轮询前置：两个 chat 都必须订阅（原版直接 await 返回值无需订阅）
  subscribeFrames(p, chatA.chatId);
  subscribeFrames(p, chatB.chatId);

  // 同步受理两个不同 chatId：各自独立串行链，应并行执行
  p.sendMessage(chatA.chatId, { text: "a" });
  p.sendMessage(chatB.chatId, { text: "b" });
  await waitForCondition(
    () => countFrames(chatA.chatId, "done") >= 1 && countFrames(chatB.chatId, "done") >= 1,
    10000,
    "两个 chatId 的 done 帧"
  );

  // 并行判定（比总耗时阈值更精确）：两个 LLM 请求的时间区间必须重叠；串行时后者的 start ≥ 前者的 end
  assert.equal(client.requestLog.length, 2, "LLM 客户端恰好收到两次请求");
  const [log1, log2] = client.requestLog;
  assert.ok(log1.end !== null, "两次请求都必须已结束");
  assert.ok(log2.end !== null, "两次请求都必须已结束");
  assert.ok(
    log2.start < (log1.end as number),
    `两个 chatId 的 LLM 请求时间区间应重叠（并行）：请求1 [${log1.start},${log1.end}]，请求2 start=${log2.start}`
  );
});

test("pool：interrupt 应中止进行中的轮次并在 5 秒内收尾 done", async () => {
  // 无限流：每次调用都产出源源不断的 text_delta，signal 中断时抛 AbortError
  const endlessScript = (request: any): LLMStreamEvent[] => {
    void request;
    return Array.from(
      { length: 1_000_000 },
      (_, index) => ({ type: "text_delta", text: `t${index} ` }) as LLMStreamEvent
    );
  };
  const p = await createTestPool(endlessScript, 5);
  const { chatId } = await p.createChat(tmpRoot);
  subscribeFrames(p, chatId);

  // 同步受理：轮次立即开始跑无限流
  p.sendMessage(chatId, { text: "开始生成" });
  // 等首个 llm_delta 出现（轮次确实在跑）
  await waitForFrame(chatId, "llm_delta", 5000);

  p.interrupt(chatId);

  // 中断后 done 帧必须在 5 秒内到达（轮次收敛 + 订阅方不悬死）
  const doneFrame = await waitForFrame(chatId, "done", 5000);
  assert.ok(doneFrame.data, "中断后必须推送 done 帧");
});

test("pool：listChats 应合并池内活跃会话与磁盘历史并按 updateTime 降序", async () => {
  const p = await createTestPool([
    { type: "text_delta", text: "hi" },
    { type: "message_end", stopReason: "end_turn", usage: null },
  ]);
  const { chatId, projectRoot } = await p.createChat(tmpRoot);
  // 帧轮询前置：先订阅再受理（原版直接 await 返回值无需订阅）
  subscribeFrames(p, chatId);
  // 同步受理后等轮次收尾，从 done 帧取 sessionId（202 异步受理契约）
  p.sendMessage(chatId, { text: "造一条活跃会话" });
  const doneFrame = await waitForFrame(chatId, "done");
  const sessionId = doneFrame.data.sessionId as string;
  assert.ok(sessionId);

  // 真实写磁盘历史条目（~/.deepcode/projects/<projectCode>/sessions-index.json）
  // projectCode 必须用 realpath 归一后的 projectRoot 计算（与 SessionPool 内部读取路径一致）
  const projectCode = getProjectCode(projectRoot);
  const historyDir = path.join(homedir(), ".deepcode", "projects", projectCode);
  const historyId = `history-${randomUUID()}`;
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(
    path.join(historyDir, "sessions-index.json"),
    JSON.stringify({
      entries: [
        {
          id: historyId,
          summary: "磁盘历史条目",
          status: "completed",
          createTime: "2026-01-01T00:00:00.000Z",
          updateTime: "2026-01-02T00:00:00.000Z",
        },
      ],
    }),
    "utf8"
  );

  try {
    const chats = p.listChats();
    const active = chats.find((chat) => chat.chatId === chatId);
    assert.ok(active, "池内活跃会话必须出现");
    assert.equal(active!.source, "active");
    assert.equal(active!.sessionId, sessionId);

    const history = chats.find((chat) => chat.chatId === historyId);
    assert.ok(history, "磁盘历史条目必须合并进列表");
    assert.equal(history!.source, "history");
    assert.equal(history!.title, "磁盘历史条目");

    // 降序排列：updateTime 新的在前。活跃会话 updateTime 为当前时间（2026-09），
    // 晚于历史条目（2026-01-02），因此活跃条目应排在历史条目之前
    const activeIndex = chats.indexOf(active!);
    const historyIndex = chats.indexOf(history!);
    assert.ok(activeIndex < historyIndex, "updateTime 新的条目应排前面");
  } finally {
    // 清理磁盘历史残留（best-effort）
    rmSync(historyDir, { recursive: true, force: true });
  }
});

test("pool：不存在的 chatId 操作应抛 404 语义 ApiError；disposeAll 后同样", async () => {
  const p = await createTestPool([]);
  const fakeId = randomUUID();
  assert.throws(
    () => p.getChatInfo(fakeId),
    (error: unknown) => {
      assert.ok(error instanceof Error && (error as any).status === 404);
      return true;
    }
  );
  assert.throws(
    () => p.sendMessage(fakeId, { text: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof Error && (error as any).status === 404);
      return true;
    }
  );
  assert.throws(() => p.interrupt(fakeId));

  // disposeAll：清空池后原 chatId 不再可用
  const { chatId } = await p.createChat(tmpRoot);
  p.disposeAll();
  assert.throws(
    () => p.getChatInfo(chatId),
    (error: unknown) => {
      assert.ok(error instanceof Error && (error as any).status === 404);
      return true;
    }
  );
});

test("pool：轮次携带工具调用时应桥接 tool_progress 帧（P1-2）", async () => {
  // 第 1 次请求产出 bash 工具调用（sideEffects=read-in-cwd，默认权限可放行或进入审批，
  // 两种路径下 onSessionEntryUpdated 都会携带 toolCalls），第 2 次请求返回文本收尾；
  // 用外部计数器区分请求序号（ScriptedLLMClient 每次请求都重新求值脚本）
  const bashArguments = JSON.stringify({
    command: "echo tool-progress-ok",
    description: "tool_progress 桥接测试",
    sideEffects: ["read-in-cwd"],
  });
  let requestCount = 0;
  const toolScript = (): LLMStreamEvent[] => {
    requestCount += 1;
    if (requestCount === 1) {
      return [
        { type: "tool_call_start", id: "toolu-pool-tp-1", name: "bash" },
        { type: "tool_call_delta", id: "toolu-pool-tp-1", argumentsJsonDelta: bashArguments },
        { type: "tool_call_end", id: "toolu-pool-tp-1" },
        { type: "message_end", stopReason: "tool_use", usage: { inputTokens: 3, outputTokens: 1 } },
      ];
    }
    return [
      { type: "text_delta", text: "工具执行完成" },
      { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 1 } },
    ];
  };
  const p = await createTestPool(toolScript);
  const { chatId } = await p.createChat(tmpRoot);
  subscribeFrames(p, chatId);

  p.sendMessage(chatId, { text: "跑个命令" });

  // tool_progress 帧：载荷含 chatId/status/toolCalls，toolCalls 元素 id 透传
  const progressFrame = await waitForFrame(chatId, "tool_progress", 15000);
  assert.equal(progressFrame.data.chatId, chatId);
  assert.ok(typeof progressFrame.data.status === "string", "tool_progress 必须携带 status");
  assert.ok(
    Array.isArray(progressFrame.data.toolCalls) && progressFrame.data.toolCalls.length > 0,
    "tool_progress 必须携带非空 toolCalls"
  );
  assert.equal(progressFrame.data.toolCalls[0].id, "toolu-pool-tp-1", "工具调用 id 必须透传");

  // 轮次最终必须以 done 收尾（无论工具执行成功还是进入审批）
  await waitForFrame(chatId, "done", 15000);
});

test("pool：轮次异常时应推送 done(status=failed) 帧（P1-3，订阅方不悬死）", async () => {
  // 脚本产出 error 事件：引擎将本轮标记为 failed（activateSession 外层 catch 吞错不 rethrow），
  // runTurn 正常路径读取 session.status=failed 推 done；若异常逃逸则走 runTurn catch 同样推 failed done
  const errorScript: LLMStreamEvent[] = [
    { type: "text_delta", text: "部分输出" },
    { type: "error", error: new Error("注入的 LLM 流错误") },
  ];
  const p = await createTestPool(errorScript);
  const { chatId } = await p.createChat(tmpRoot);
  subscribeFrames(p, chatId);

  p.sendMessage(chatId, { text: "触发错误" });

  const doneFrame = await waitForFrame(chatId, "done", 15000);
  assert.equal(doneFrame.data.status, "failed", `done 帧 status 必须为 failed（得到 ${doneFrame.data.status}）`);
  assert.ok(doneFrame.data.sessionId, "异常路径下 done 载荷也应携带已归属的 sessionId");
});
