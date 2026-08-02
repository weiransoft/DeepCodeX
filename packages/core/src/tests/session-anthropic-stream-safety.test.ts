/**
 * SessionManager Anthropic 流式调用安全测试
 *
 * 测试目标：
 * - createLlmMessageStream 支持 streamTimeoutMs，LLM 长期无响应时主动 abort
 * - createLlmMessageStream 支持 maxReasoningLength，reasoning 超长时主动 abort
 * - 正常流在阈值内可完整聚合并返回
 *
 * 测试框架：node:test + node:assert/strict
 * 测试隔离：每个用例独立构造 SessionManager 与 LLMClient 桩，不依赖外部状态；
 *          严禁使用 mock，LLMClient 桩为真实对象实现接口。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../session";
import type { LLMClient, LLMStreamEvent } from "../providers/llm-provider";

/**
 * 构造持有 Anthropic 协议 LLMClient 桩的 SessionManager
 *
 * @param client 自定义 LLMClient 桩
 * @returns 配置最小依赖的 SessionManager 实例
 */
function createSessionManagerWithLlmClient(client: LLMClient): SessionManager {
  return new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: { chat: { completions: { create: async () => ({}) } } } as unknown as any,
      model: "test-openai-model",
      baseURL: "http://localhost:8000/v1",
      thinkingEnabled: false,
      reasoningEffort: undefined,
      temperature: 0.7,
      debugLogEnabled: false,
      notify: false,
      env: {},
    }),
    createLLMClient: () => client,
    getResolvedSettings: () => ({ model: "test-model", timeout: 600 }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

/**
 * 构造可控制事件序列的 Anthropic LLMClient 桩
 *
 * 该桩完全实现 LLMClient 接口，createMessageStream 按顺序产出事件；
 * 当请求 signal 已 abort 时，模拟真实 SDK 行为抛出错误。
 *
 * @param events 事件序列；也可以传入返回事件序列的函数以支持无限流
 * @param yieldDelayMs 每次 yield 后让出事件循环的毫秒数，避免同步死循环阻塞 setTimeout
 * @returns LLMClient 桩
 */
function createStubLlmClient(events: LLMStreamEvent[] | (() => LLMStreamEvent[]), yieldDelayMs = 0): LLMClient {
  const eventList = typeof events === "function" ? events() : events;
  return {
    providerName: "anthropic",
    model: "claude-test",
    baseURL: "http://localhost:8000/v1",
    supportsThinking: true,
    supportsPromptCaching: false,

    async createMessage() {
      return {
        content: "",
        thinking: "",
        toolCalls: [],
        stopReason: null,
        usage: null,
      };
    },

    async *createMessageStream(request) {
      for (const event of eventList) {
        if (request.signal?.aborted) {
          throw new Error("AbortError: stream aborted by consumer");
        }
        yield event;
        if (yieldDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, yieldDelayMs));
        }
      }
    },
  };
}

/**
 * 带硬 guard 的 rejects 包装：防止测试用例本身挂起
 *
 * @param promise 被测试的 Promise
 * @param timeoutMs 最大等待时间
 * @returns reject 后的错误对象
 */
async function rejectsWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<unknown> {
  return Promise.race([
    promise.then(
      () => {
        throw new Error(`expected promise to reject, but it resolved within ${timeoutMs}ms`);
      },
      (err) => err
    ),
    new Promise<unknown>((_, reject) =>
      setTimeout(() => reject(new Error(`promise did not reject within ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

// ============================================================================
// TC-1：streamTimeoutMs 触发后应中断无限流
// 期望：50ms 超时后 createLlmMessageStream 拒绝，且不处理完全部事件
// ============================================================================
test("TC-1: streamTimeoutMs 应中断长期无响应的 Anthropic 流", async () => {
  const eventIndex = { value: 0 };
  const client = createStubLlmClient(() => {
    const events: LLMStreamEvent[] = [];
    for (let i = 0; i < 1_000_000; i++) {
      events.push({ type: "text_delta", text: `chunk-${i} ` });
    }
    return events;
  }, 10);

  // 重写 createMessageStream 以记录实际被消费的事件数
  const originalStream = client.createMessageStream.bind(client);
  client.createMessageStream = async function* (request) {
    for await (const event of originalStream(request)) {
      eventIndex.value++;
      yield event;
    }
  };

  const manager = createSessionManagerWithLlmClient(client);

  const err = await rejectsWithin(
    (manager as unknown as { createLlmMessageStream: typeof manager.createLlmMessageStream }).createLlmMessageStream(
      client,
      { messages: [], thinkingEnabled: false },
      { streamTimeoutMs: 50, maxReasoningLength: 100_000 }
    ),
    500
  );

  assert.ok(err instanceof Error, "应抛出 Error");
  assert.ok(eventIndex.value < 1_000_000, "超时后不应消费完全部事件");
  assert.ok(eventIndex.value > 0, "应至少消费一个事件才会触发超时");
});

// ============================================================================
// TC-2：maxReasoningLength 触发后应中断超长 reasoning 流
// 期望：reasoning 累计长度超过阈值时立即抛出超限错误
// ============================================================================
test("TC-2: maxReasoningLength 应中断超长 reasoning 流", async () => {
  const reasoningChunk = "0123456789"; // 10 字符
  const client = createStubLlmClient(
    Array.from({ length: 20 }, () => ({ type: "thinking_delta", thinking: reasoningChunk }) as LLMStreamEvent)
  );
  const manager = createSessionManagerWithLlmClient(client);

  const err = await rejectsWithin(
    (manager as unknown as { createLlmMessageStream: typeof manager.createLlmMessageStream }).createLlmMessageStream(
      client,
      { messages: [], thinkingEnabled: false },
      { maxReasoningLength: 25 }
    ),
    500
  );

  assert.ok(err instanceof Error, "应抛出 Error");
  assert.match((err as Error).message, /reasoning content exceeded safety limit \(25 chars\)/);
});

// ============================================================================
// TC-3：正常流在阈值内应完整返回
// 期望：不触发超时与 reasoning 限制，返回聚合后的文本与 usage
// ============================================================================
test("TC-3: 正常 Anthropic 流应完整聚合返回", async () => {
  const client = createStubLlmClient([
    { type: "text_delta", text: "Hello" },
    { type: "text_delta", text: " world" },
    { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } },
  ]);
  const manager = createSessionManagerWithLlmClient(client);

  const result = await (
    manager as unknown as { createLlmMessageStream: typeof manager.createLlmMessageStream }
  ).createLlmMessageStream(client, { messages: [], thinkingEnabled: false }, { maxReasoningLength: 100_000 });

  assert.equal(result.choices?.[0]?.message?.content, "Hello world");
});
