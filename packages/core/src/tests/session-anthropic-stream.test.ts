/**
 * Claude 主对话流式接入测试（2026-07-18 设计文档 §7）
 *
 * 覆盖范围：
 * - §7.2 聚合单测：SessionManager.createLlmMessageStream（归一化 LLMStreamEvent → OpenAI 形态契约）
 * - §7.3 主循环集成：provider=anthropic 桩 client 下 activateSession 全链路
 *
 * 测试基建：真实函数注入桩（LLMClient 接口对象 + 真实异步生成器），无 mock 框架；
 * 文件被 src/tests/run-tests.mjs 以 glob `*.test.ts` 自动发现，纳入 npm test。
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionManager, type LlmStreamProgress, type SessionMessage } from "../session";
import type { LLMClient, LLMRequest, LLMResponse, LLMStreamEvent } from "../providers/llm-provider";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

/** 跨平台设置 home 目录（Unix: HOME，Windows: USERPROFILE），与 session.test.ts 同款 */
function setHomeDir(dir: string): void {
  process.env.HOME = dir;
  if (process.platform === "win32") {
    process.env.USERPROFILE = dir;
  }
}

/** 创建临时目录并登记，afterEach 统一清理 */
function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
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

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// 测试基建（真实函数注入桩，非 mock 框架）
// ---------------------------------------------------------------------------

/**
 * 构造聚合单测用 SessionManager：OpenAI 通路不参与（client: null），
 * 仅提供 createLlmMessageStream 依赖的实例方法环境（progress 回调、normalizeLlmToolCalls 等）。
 */
function createUnitManager(progressRecords?: LlmStreamProgress[]): SessionManager {
  return new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "claude-test",
      baseURL: "https://api.anthropic.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "claude-test" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    ...(progressRecords
      ? {
          onLlmStreamProgress: (progress: LlmStreamProgress) => {
            progressRecords.push(progress);
          },
        }
      : {}),
  });
}

/**
 * 构造 Anthropic 形态桩 LLMClient（§7.2）：providerName 为 "anthropic"，
 * createMessageStream 为真实异步生成器，按序产出预置 LLMStreamEvent；
 * streamConsumed 标记用于验证「前置 abort 时不消费任何事件」。
 */
function createAnthropicStreamStub(options: {
  events: LLMStreamEvent[];
  streamConsumed?: { value: boolean };
}): LLMClient {
  return {
    providerName: "anthropic",
    model: "claude-test",
    baseURL: "https://api.anthropic.com",
    supportsThinking: true,
    supportsPromptCaching: true,
    // 聚合单测不触发非流式接口；抛错以便误用时立即暴露
    createMessage: async () => {
      throw new Error("createMessage should not be called in stream aggregation tests");
    },
    createMessageStream: async function* (): AsyncGenerator<LLMStreamEvent> {
      if (options.streamConsumed) {
        options.streamConsumed.value = true;
      }
      for (const event of options.events) {
        yield event;
      }
    },
  };
}

/** 直调私有方法 createLlmMessageStream（聚合单测入口） */
function callAggregate(
  manager: SessionManager,
  client: LLMClient,
  request?: Partial<{
    messages: SessionMessage[];
    tools: Array<{ name: string; description?: string; parameters: Record<string, unknown> }>;
    thinkingEnabled: boolean;
    signal: AbortSignal | null;
  }>
): Promise<{ choices?: Array<{ message?: Record<string, unknown> }>; usage?: unknown }> {
  return (manager as any).createLlmMessageStream(
    client,
    {
      messages: [],
      thinkingEnabled: false,
      ...request,
    },
    "session-anthropic-unit"
  );
}

/** 提取聚合返回体中的 message 对象（带类型断言的便捷访问） */
function aggregateMessage(response: {
  choices?: Array<{ message?: Record<string, unknown> }>;
}): Record<string, unknown> {
  const message = response.choices?.[0]?.message;
  assert.ok(message, "expected aggregated message");
  return message;
}

// ---------------------------------------------------------------------------
// §7.2 聚合单测（用例 1-10）
// ---------------------------------------------------------------------------

test("createLlmMessageStream aggregates plain text deltas and emits full progress sequence", async () => {
  const progressRecords: LlmStreamProgress[] = [];
  const manager = createUnitManager(progressRecords);
  const client = createAnthropicStreamStub({
    events: [
      { type: "text_delta", text: "你好，" },
      { type: "text_delta", text: "世界" },
    ],
  });

  const response = await callAggregate(manager, client);
  const message = aggregateMessage(response);

  // 多 text_delta 顺序拼接；无 message_end 时 usage 保持 null（§4.1 末行）
  assert.equal(message.content, "你好，世界");
  assert.equal(response.usage, null);
  assert.equal("tool_calls" in message, false);
  assert.equal("reasoning_content" in message, false);
  assert.equal("refusal" in message, false);

  // progress 序列完整：start → update×2 → end（§7.2 用例 1）
  assert.deepEqual(
    progressRecords.map((record) => record.phase),
    ["start", "update", "update", "end"]
  );
  assert.equal(progressRecords[progressRecords.length - 1]?.estimatedTokens > 0, true);
});

test("createLlmMessageStream aggregates thinking deltas into reasoning_content", async () => {
  const manager = createUnitManager();
  const client = createAnthropicStreamStub({
    events: [
      { type: "thinking_delta", thinking: "先分析一下" },
      { type: "thinking_delta", thinking: "再给出结论" },
      { type: "text_delta", text: "答案" },
      { type: "message_end", stopReason: "end_turn", usage: null },
    ],
  });

  const response = await callAggregate(manager, client, { thinkingEnabled: true });
  const message = aggregateMessage(response);

  assert.equal(message.reasoning_content, "先分析一下再给出结论");
  assert.equal(message.content, "答案");
  assert.equal(response.usage, null);
});

test("createLlmMessageStream assembles a single tool call into OpenAI tool_calls shape", async () => {
  const manager = createUnitManager();
  const client = createAnthropicStreamStub({
    events: [
      { type: "tool_call_start", id: "toolu_01abc", name: "bash" },
      { type: "tool_call_delta", id: "toolu_01abc", argumentsJsonDelta: '{"comm' },
      { type: "tool_call_delta", id: "toolu_01abc", argumentsJsonDelta: 'and":"ls"}' },
      { type: "tool_call_end", id: "toolu_01abc" },
      {
        type: "message_end",
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
    ],
  });

  const response = await callAggregate(manager, client);
  const message = aggregateMessage(response);

  assert.deepEqual(message.tool_calls, [
    {
      id: "toolu_01abc",
      type: "function",
      function: { name: "bash", arguments: '{"command":"ls"}' },
    },
  ]);
  // usage 经 toModelUsage 转换（无 cache 字段时 prompt_tokens = inputTokens）
  assert.deepEqual(response.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
});

test("createLlmMessageStream keeps multiple tool calls in event order with independent buckets", async () => {
  const manager = createUnitManager();
  const client = createAnthropicStreamStub({
    events: [
      { type: "tool_call_start", id: "toolu_first", name: "read" },
      { type: "tool_call_delta", id: "toolu_first", argumentsJsonDelta: '{"file_path":"a.txt"}' },
      { type: "tool_call_end", id: "toolu_first" },
      { type: "tool_call_start", id: "toolu_second", name: "bash" },
      { type: "tool_call_delta", id: "toolu_second", argumentsJsonDelta: '{"command":"ls"' },
      { type: "tool_call_delta", id: "toolu_second", argumentsJsonDelta: "}" },
      { type: "tool_call_end", id: "toolu_second" },
      { type: "message_end", stopReason: "tool_use", usage: null },
    ],
  });

  const response = await callAggregate(manager, client);
  const message = aggregateMessage(response);

  // 两桶独立累积、数组顺序 = 事件出现序（§4.2 规则 1）
  assert.deepEqual(message.tool_calls, [
    {
      id: "toolu_first",
      type: "function",
      function: { name: "read", arguments: '{"file_path":"a.txt"}' },
    },
    {
      id: "toolu_second",
      type: "function",
      function: { name: "bash", arguments: '{"command":"ls"}' },
    },
  ]);
});

test("createLlmMessageStream assembles interleaved multi-tool streams into independent buckets", async () => {
  const manager = createUnitManager();
  const client = createAnthropicStreamStub({
    events: [
      // 交错序列：两工具的 start/delta/end 交叉产出（§4.2 规则 3：聚合层按 id 索引桶，
      // 天然支持任意交错序列，不做「同时只有一个活跃桶」假设）。
      // 真实 Claude 单条消息内多个 tool_use 块顺序产出（provider 层 currentToolId 单轨
      // 也不会交错），此用例锁定聚合层设计声称的交错健壮性属性，防止后续改动回退为
      // 「单活跃桶」假设而未被发现。
      { type: "tool_call_start", id: "toolu_read", name: "read" },
      { type: "tool_call_start", id: "toolu_bash", name: "bash" },
      { type: "tool_call_delta", id: "toolu_read", argumentsJsonDelta: '{"file_path":' },
      { type: "tool_call_delta", id: "toolu_bash", argumentsJsonDelta: '{"command":"ls' },
      { type: "tool_call_delta", id: "toolu_read", argumentsJsonDelta: '"a.txt"}' },
      // 注意：'"}"' 是 2 字符 JSON 片段（闭合引号 + 闭合花括号），
      // 与首个 delta 拼接成完整 '{"command":"ls"}'
      { type: "tool_call_delta", id: "toolu_bash", argumentsJsonDelta: '"}' },
      // end 顺序与 start 相反：进一步验证闭桶按 id 寻址而非「最近活跃桶」
      { type: "tool_call_end", id: "toolu_bash" },
      { type: "tool_call_end", id: "toolu_read" },
      { type: "message_end", stopReason: "tool_use", usage: null },
    ],
  });

  const response = await callAggregate(manager, client);
  const message = aggregateMessage(response);

  // 交错下两桶仍按 id 独立累积完整 arguments；数组顺序 = 桶创建序
  // （Map 插入序 = start 事件出现序，对等 OpenAI 侧 index 排序后的语义，§4.2 规则 1）
  assert.deepEqual(message.tool_calls, [
    {
      id: "toolu_read",
      type: "function",
      function: { name: "read", arguments: '{"file_path":"a.txt"}' },
    },
    {
      id: "toolu_bash",
      type: "function",
      function: { name: "bash", arguments: '{"command":"ls"}' },
    },
  ]);
});

test('createLlmMessageStream falls back empty tool arguments to "{}"', async () => {
  const manager = createUnitManager();
  const client = createAnthropicStreamStub({
    events: [
      { type: "tool_call_start", id: "toolu_noargs", name: "noop" },
      { type: "tool_call_end", id: "toolu_noargs" },
      { type: "message_end", stopReason: "tool_use", usage: null },
    ],
  });

  const response = await callAggregate(manager, client);
  const message = aggregateMessage(response);

  // 无参工具：executor JSON.parse("") 必败，聚合层兜底 "{}"（§4.2 规则 4）
  assert.deepEqual(message.tool_calls, [
    {
      id: "toolu_noargs",
      type: "function",
      function: { name: "noop", arguments: "{}" },
    },
  ]);
});

test("createLlmMessageStream drops orphan tool_call_delta without creating a bucket", async () => {
  const manager = createUnitManager();
  const client = createAnthropicStreamStub({
    events: [
      { type: "tool_call_delta", id: "toolu_ghost", argumentsJsonDelta: '{"x":1}' },
      { type: "text_delta", text: "ok" },
      { type: "message_end", stopReason: "end_turn", usage: null },
    ],
  });

  const response = await callAggregate(manager, client);
  const message = aggregateMessage(response);

  // 孤立 delta 被丢弃、不产生无名桶（§4.2 规则 2）
  assert.equal("tool_calls" in message, false);
  assert.equal(message.content, "ok");
});

test("createLlmMessageStream maps refusal stop reason to message.refusal", async () => {
  const manager = createUnitManager();
  const withContent = createAnthropicStreamStub({
    events: [
      { type: "text_delta", text: "我不能协助该请求" },
      { type: "message_end", stopReason: "refusal", usage: null },
    ],
  });

  const responseWithContent = await callAggregate(manager, withContent);
  const messageWithContent = aggregateMessage(responseWithContent);
  // 拒绝说明复用已聚合 content；content 字段保持原样（§4.3）
  assert.equal(messageWithContent.refusal, "我不能协助该请求");
  assert.equal(messageWithContent.content, "我不能协助该请求");

  const empty = createAnthropicStreamStub({
    events: [{ type: "message_end", stopReason: "refusal", usage: null }],
  });
  const responseEmpty = await callAggregate(manager, empty);
  const messageEmpty = aggregateMessage(responseEmpty);
  // 空内容极端情况给确定性兜底文案，避免 failed 状态无原因（§4.3）
  assert.equal(messageEmpty.refusal, "模型拒绝回答（Claude stop_reason: refusal）");
  assert.equal(messageEmpty.content, "");
});

test("createLlmMessageStream maps usage with cache fields per corrected toModelUsage semantics", async () => {
  const manager = createUnitManager();
  const client = createAnthropicStreamStub({
    events: [
      { type: "text_delta", text: "ok" },
      {
        type: "message_end",
        stopReason: "end_turn",
        usage: {
          inputTokens: 10,
          cacheCreationInputTokens: 7,
          cacheReadInputTokens: 35,
          outputTokens: 3,
        },
      },
    ],
  });

  const response = await callAggregate(manager, client);

  // §4.4 修正语义的直接断言：prompt_tokens 含 cache 部分（驱动 compact 阈值）
  assert.deepEqual(response.usage, {
    prompt_tokens: 52,
    completion_tokens: 3,
    total_tokens: 55,
    prompt_cache_hit_tokens: 35,
    prompt_cache_miss_tokens: 17,
  });
});

test("createLlmMessageStream rethrows error events with identity preserved", async () => {
  const progressRecords: LlmStreamProgress[] = [];
  const manager = createUnitManager(progressRecords);
  const networkError = new Error("网络中断");
  const client = createAnthropicStreamStub({
    events: [
      { type: "text_delta", text: "半截响应" },
      { type: "error", error: networkError },
    ],
  });

  // error 事件转回抛出（§4.1）：同身份错误，不得静默吞错
  await assert.rejects(callAggregate(manager, client), (error: unknown) => {
    assert.equal(error, networkError);
    return true;
  });
  // finally 进度 end 照发（对齐 OpenAI 路径错误也发 end 的行为）
  assert.equal(progressRecords[progressRecords.length - 1]?.phase, "end");

  class APIUserAbortError extends Error {}
  const abortClient = createAnthropicStreamStub({
    events: [{ type: "error", error: new APIUserAbortError("aborted by user") }],
  });
  await assert.rejects(callAggregate(manager, abortClient), (error: unknown) => {
    // 原样 rethrow 保留 constructor.name，主循环 isAbortLikeError 判定为 abort 语义（§5 AbortError 行）
    assert.equal((manager as any).isAbortLikeError(error), true);
    return true;
  });
});

test("createLlmMessageStream throws AbortError before consuming events when signal is already aborted", async () => {
  const manager = createUnitManager();
  const streamConsumed = { value: false };
  const client = createAnthropicStreamStub({
    events: [{ type: "text_delta", text: "不应被消费" }],
    streamConsumed,
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(callAggregate(manager, client, { signal: controller.signal }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
  // 前置 abort：不消费任何流事件（§7.2 用例 10）
  assert.equal(streamConsumed.value, false);
});

// ---------------------------------------------------------------------------
// §7.3 主循环集成测试基建（createMockedClientSessionManager 模式 + anthropic 桩）
// ---------------------------------------------------------------------------

/** 判断 OpenAI 形态请求是否为技能匹配请求（Task 3 接线前技能匹配仍走 OpenAI 桩） */
function isSkillMatchingRequest(request: any): boolean {
  return request?.response_format?.type === "json_object";
}

/** 判断 LLMRequest 是否为技能匹配请求（system 消息含 skillNames JSON 输出要求） */
function isSkillMatchingLlmRequest(request: LLMRequest): boolean {
  const system = request.messages.find((message) => message.role === "system");
  return typeof system?.content === "string" && system.content.includes("skillNames");
}

/** 构造文本型 LLMResponse（技能匹配应答等非流式场景） */
function createLlmTextResponse(content: string): LLMResponse {
  return {
    content,
    thinking: "",
    toolCalls: [],
    stopReason: "end_turn",
    usage: null,
  };
}

/**
 * 构造 Anthropic 主循环集成桩 client（§7.3，真实函数注入桩，非 mock 框架）：
 * - createMessageStream：按队列回放预置事件序列（真实异步生成器），并记录全部入参；
 * - createMessage：识别技能匹配请求（system 含 skillNames 字样）→ 返回 JSON 文本响应，
 *   其余请求出队 messageResponses；全部入参记录供断言。
 */
function createAnthropicMainLoopStub(options: {
  streams: LLMStreamEvent[][];
  recordedStreams: LLMRequest[];
  recordedMessages: LLMRequest[];
  messageResponses?: LLMResponse[];
}): LLMClient {
  const messageResponses = options.messageResponses ?? [];
  return {
    providerName: "anthropic",
    model: "claude-test",
    baseURL: "https://api.anthropic.com",
    supportsThinking: true,
    supportsPromptCaching: true,
    createMessage: async (request: LLMRequest): Promise<LLMResponse> => {
      options.recordedMessages.push(request);
      if (isSkillMatchingLlmRequest(request)) {
        return createLlmTextResponse(JSON.stringify({ skillNames: [] }));
      }
      const response = messageResponses.shift();
      assert.ok(response, "expected a queued LLM response");
      return response;
    },
    createMessageStream: async function* (request: LLMRequest): AsyncGenerator<LLMStreamEvent> {
      options.recordedStreams.push(request);
      const events = options.streams.shift();
      assert.ok(events, "expected a queued LLM stream");
      for (const event of events) {
        yield event;
      }
    },
  };
}

/**
 * 构造 Anthropic 通路集成测试用 SessionManager：
 * - createOpenAIClient 桩仅服务技能匹配（Task 3 接线前）与 client 空值守卫；
 * - createLLMClient 注入 Anthropic 桩（B1 缝合点），主循环应经 providerName 判定走 Anthropic 通路。
 */
function createAnthropicSessionManager(
  projectRoot: string,
  options: {
    streams: LLMStreamEvent[][];
    recordedStreams: LLMRequest[];
    recordedMessages: LLMRequest[];
    messageResponses?: LLMResponse[];
    permissions?: { allow: any[]; deny: any[]; ask: any[]; defaultMode: "allowAll" | "askAll" };
    onAssistantMessage?: (message: SessionMessage) => void;
  }
): SessionManager {
  const openAiClient = {
    chat: {
      completions: {
        create: async (request: any) => {
          if (isSkillMatchingRequest(request)) {
            return { choices: [{ message: { content: JSON.stringify({ skillNames: [] }) } }] };
          }
          throw new Error("OpenAI stream path must not be used under anthropic provider");
        },
      },
    },
  };

  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: openAiClient as any,
      model: "claude-test",
      baseURL: "https://api.anthropic.com",
      thinkingEnabled: false,
    }),
    createLLMClient: () =>
      createAnthropicMainLoopStub({
        streams: options.streams,
        recordedStreams: options.recordedStreams,
        recordedMessages: options.recordedMessages,
        messageResponses: options.messageResponses,
      }),
    getResolvedSettings: () => ({
      model: "claude-test",
      ...(options.permissions ? { permissions: options.permissions } : {}),
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: (message: SessionMessage) => {
      options.onAssistantMessage?.(message);
    },
  });
}

/** 集成用例通用：创建 workspace/home 并返回 recorded 载体与 manager */
function setupAnthropicIntegration(options: {
  streams: LLMStreamEvent[][];
  permissions?: { allow: any[]; deny: any[]; ask: any[]; defaultMode: "allowAll" | "askAll" };
}): {
  manager: SessionManager;
  recordedStreams: LLMRequest[];
  recordedMessages: LLMRequest[];
  assistantNotices: SessionMessage[];
} {
  const workspace = createTempDir("deepcode-anthropic-stream-workspace-");
  const home = createTempDir("deepcode-anthropic-stream-home-");
  setHomeDir(home);
  const recordedStreams: LLMRequest[] = [];
  const recordedMessages: LLMRequest[] = [];
  const assistantNotices: SessionMessage[] = [];
  const manager = createAnthropicSessionManager(workspace, {
    streams: options.streams,
    recordedStreams,
    recordedMessages,
    permissions: options.permissions,
    onAssistantMessage: (message) => {
      assistantNotices.push(message);
    },
  });
  return { manager, recordedStreams, recordedMessages, assistantNotices };
}

// ---------------------------------------------------------------------------
// §7.3 主循环集成（用例 1-6）
// ---------------------------------------------------------------------------

test("activateSession completes a plain text reply via anthropic stream with cache-aware usage", async () => {
  const { manager, recordedStreams } = setupAnthropicIntegration({
    streams: [
      [
        { type: "text_delta", text: "你好，" },
        { type: "text_delta", text: "世界" },
        {
          type: "message_end",
          stopReason: "end_turn",
          usage: { inputTokens: 10, cacheCreationInputTokens: 7, cacheReadInputTokens: 35, outputTokens: 3 },
        },
      ],
    ],
  });

  const sessionId = await manager.createSession({ text: "" });
  const session = manager.getSession(sessionId);

  // 状态机：completed；assistant 消息落盘内容正确
  assert.equal(session?.status, "completed");
  const assistant = manager.listSessionMessages(sessionId).find((message) => message.role === "assistant");
  assert.equal(assistant?.content, "你好，世界");

  // usage/usagePerModel 累加值与 §4.4 语义一致；activeTokens === total_tokens
  assert.equal(session?.usage?.prompt_tokens, 52);
  assert.equal(session?.usage?.completion_tokens, 3);
  assert.equal(session?.usage?.total_tokens, 55);
  assert.equal(session?.usage?.prompt_cache_hit_tokens, 35);
  assert.equal(session?.usage?.prompt_cache_miss_tokens, 17);
  const perModel = session?.usagePerModel?.["claude-test"];
  assert.equal(perModel?.prompt_tokens, 52);
  assert.equal(perModel?.total_reqs, 1);
  assert.equal(session?.activeTokens, 55);

  // 主循环确实走了 Anthropic 通路（请求为 SessionMessage[] 内部形态）
  assert.equal(recordedStreams.length, 1);
  assert.equal(
    recordedStreams[0]?.messages.some((message) => message.role === "user"),
    true
  );
  assert.equal(recordedStreams[0]?.thinkingEnabled, false);
});

test("activateSession executes anthropic tool call end-to-end and persists OpenAI-shape tool_calls", async () => {
  const bashArguments = JSON.stringify({
    command: "echo hello-from-claude",
    description: "Print greeting",
    sideEffects: ["read-in-cwd"],
  });
  const { manager } = setupAnthropicIntegration({
    permissions: { allow: [], deny: [], ask: [], defaultMode: "allowAll" },
    streams: [
      [
        { type: "tool_call_start", id: "toolu_bash_1", name: "bash" },
        { type: "tool_call_delta", id: "toolu_bash_1", argumentsJsonDelta: bashArguments },
        { type: "tool_call_end", id: "toolu_bash_1" },
        { type: "message_end", stopReason: "tool_use", usage: { inputTokens: 3, outputTokens: 1 } },
      ],
      [
        { type: "text_delta", text: "完成" },
        { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 4, outputTokens: 1 } },
      ],
    ],
  });

  const sessionId = await manager.createSession({ text: "" });
  const session = manager.getSession(sessionId);
  const messages = manager.listSessionMessages(sessionId);

  // 第二轮产出文本 → completed（工具调用多轮循环全链路可用）
  assert.equal(session?.status, "completed");

  // messageParams.tool_calls 为 OpenAI 形态（多轮回放闭环的输入契约）
  const assistantWithTools = messages.find(
    (message) => message.role === "assistant" && (message.messageParams as any)?.tool_calls
  );
  assert.deepEqual((assistantWithTools?.messageParams as any)?.tool_calls, [
    { id: "toolu_bash_1", type: "function", function: { name: "bash", arguments: bashArguments } },
  ]);

  // tool 消息真实执行并落盘
  const toolMessage = messages.find((message) => message.role === "tool");
  assert.ok(toolMessage);
  assert.match(toolMessage.content ?? "", /hello-from-claude/);
});

test("activateSession persists anthropic thinking reply", async () => {
  const { manager } = setupAnthropicIntegration({
    streams: [
      [
        { type: "thinking_delta", thinking: "推理一下" },
        { type: "text_delta", text: "答案" },
        { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 1 } },
      ],
    ],
  });

  const sessionId = await manager.createSession({ text: "" });
  const session = manager.getSession(sessionId);

  assert.equal(session?.status, "completed");
  assert.equal(session?.assistantThinking, "推理一下");
  const assistant = manager.listSessionMessages(sessionId).find((message) => message.role === "assistant");
  assert.equal((assistant?.messageParams as any)?.reasoning_content, "推理一下");
});

test("activateSession marks refusal reply as failed with refusal text as reason", async () => {
  const { manager } = setupAnthropicIntegration({
    streams: [
      [
        { type: "text_delta", text: "我不能协助该请求" },
        { type: "message_end", stopReason: "refusal", usage: { inputTokens: 2, outputTokens: 1 } },
      ],
    ],
  });

  const sessionId = await manager.createSession({ text: "" });
  const session = manager.getSession(sessionId);

  assert.equal(session?.status, "failed");
  assert.equal(session?.failReason, "我不能协助该请求");
});

test("activateSession marks session interrupted when anthropic stream errors with abort-like error", async () => {
  class APIUserAbortError extends Error {}
  const { manager, assistantNotices } = setupAnthropicIntegration({
    streams: [
      [
        { type: "text_delta", text: "半截响应" },
        { type: "error", error: new APIUserAbortError("aborted by user") },
      ],
    ],
  });

  const sessionId = await manager.createSession({ text: "" });
  const session = manager.getSession(sessionId);

  // error → rethrow → 主循环 isAbortLikeError 全链：status interrupted
  assert.equal(session?.status, "interrupted");
  assert.equal(session?.failReason, "interrupted");
  const failureNotice = assistantNotices.find(
    (message) => typeof message.content === "string" && message.content.includes("Request failed")
  );
  assert.equal(failureNotice, undefined);
});

test("activateSession marks session failed when anthropic stream errors with plain error", async () => {
  const { manager, assistantNotices } = setupAnthropicIntegration({
    streams: [
      [
        { type: "text_delta", text: "半截响应" },
        { type: "error", error: new Error("网络中断") },
      ],
    ],
  });

  const sessionId = await manager.createSession({ text: "" });
  const session = manager.getSession(sessionId);

  assert.equal(session?.status, "failed");
  assert.equal(session?.failReason, "网络中断");
  // 「Request failed:」提示经 onAssistantMessage 回调下发（主循环既有行为，不落盘）
  const failureNotice = assistantNotices.find(
    (message) => typeof message.content === "string" && message.content.includes("Request failed:")
  );
  assert.ok(failureNotice);
  assert.match(failureNotice.content ?? "", /Request failed: 网络中断/);
});

// ---------------------------------------------------------------------------
// §7.3 主循环集成（用例 7：技能匹配通路，Task 3）
// ---------------------------------------------------------------------------

test("identifyMatchingSkillNames routes to anthropic createMessage with thinking disabled", async () => {
  const { manager, recordedMessages } = setupAnthropicIntegration({
    streams: [
      [
        { type: "text_delta", text: "好的" },
        { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 1 } },
      ],
    ],
  });

  // bundled skills 存在 → 技能匹配被真实触发（非空 text 才会进入识别流程）
  const sessionId = await manager.createSession({ text: "帮我优化这个工作流程" });
  const session = manager.getSession(sessionId);

  // 桩 createMessage 收到技能匹配请求（§6.2：非流式、合成 SessionMessage、thinkingEnabled 关闭）
  const skillRequest = recordedMessages.find((request) => isSkillMatchingLlmRequest(request));
  assert.ok(skillRequest, "expected skill matching request via anthropic createMessage");
  assert.equal(skillRequest.thinkingEnabled, false);
  assert.deepEqual(
    skillRequest.messages.map((message) => message.role),
    ["system", "user"]
  );
  assert.equal(skillRequest.messages[1]?.content, "帮我优化这个工作流程");

  // 返回 {"skillNames":[]} 后主流程正常继续
  assert.equal(session?.status, "completed");
});
