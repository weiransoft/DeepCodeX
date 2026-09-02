/**
 * AnthropicProvider 流式事件归一化测试（补充验收检查单第 1 条"流式事件全部正常"的覆盖缺口）
 *
 * 覆盖：
 * 1. text / thinking 增量序列归一化（message_start/message_stop 等噪声事件被忽略，
 *    非 tool_use 块的 content_block_stop 不产出任何事件）；
 * 2. 流式 tool_call 完整事件序列（tool_call_start → tool_call_delta × N → tool_call_end →
 *    message_end），且分片 argumentsJsonDelta 可无损拼接为合法 JSON；
 * 3. 守卫分支：无 tool_use 上下文时到达的 input_json_delta 被安全丢弃（currentToolId === null）；
 * 4. 错误归一化：transport 中途抛错 / 抛非 Error 值，均归一化为 error 事件且迭代正常结束不抛出；
 * 5. 流式 usage 聚合（M2）：message_start 携带 input/cache 用量（暂存），
 *    message_delta 仅携带 output_tokens，message_end 合并发出完整 LLMUsage；
 *    无 message_start 时 inputTokens 回退 0。
 *
 * 测试方式：通过 setStreamTransportForTesting 注入真实异步生成器（函数注入桩，
 * 非 mock 框架），供给 SDK 原始 RawMessageStreamEvent 序列，验证归一化逻辑本身。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "../anthropic-provider.js";
import type { AnthropicLLMClient } from "../anthropic-provider.js";
import type { LLMRequest, LLMStreamEvent } from "../llm-provider.js";
import type { ResolvedDeepcodingSettings } from "../../settings.js";
import type { SessionMessage } from "../../session.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}

function assertTrue(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push(`FAIL: ${label}（expected true）`);
}

function suite(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    console.log(`\n=== ${name} ===`);
  });
}

/** 构造 anthropic settings（最小必要字段） */
function makeSettings(): ResolvedDeepcodingSettings {
  return {
    env: { API_KEY: "sk-ant-test-key" },
    apiKey: "sk-ant-test-key",
    baseURL: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    anthropic: { betaFeatures: ["extended-thinking", "prompt-caching"], maxTokens: 8192, thinkingBudgetTokens: 4096 },
    thinkingEnabled: true,
    reasoningEffort: "max",
    timeout: 600,
    contextWindow: 131072,
    // 上游 0.3.1 新增必填字段：自动 compact 阈值、多模态与 Files API 配置（测试夹具默认值）
    autoCompactWindow: 65536,
    multimodal: "default",
    filesApiEnabled: false,
    filesApiTimeoutMs: 60000,
    fileExpiresAfterSeconds: 604800,
    fileRefreshMarginSeconds: 3600,
    fileQuotaCleanupBatch: 100,
    maxRequestFilesBytes: 134217728,
    debugLogEnabled: false,
    telemetryEnabled: false,
    allowPrivateBaseURL: false,
    permissions: {} as ResolvedDeepcodingSettings["permissions"],
    enabledSkills: {},
    statusline: {} as ResolvedDeepcodingSettings["statusline"],
  };
}

/** 构造测试用 SessionMessage（仅填必要字段） */
function msg(role: SessionMessage["role"], content: string | null): SessionMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role,
    content,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: "2026-07-17T00:00:00Z",
    updateTime: "2026-07-17T00:00:00Z",
  };
}

/** 创建注入流式桩的客户端：stub 为真实异步生成器，按序产出 SDK 原始事件 */
function makeStreamClient(sdkEvents: Anthropic.RawMessageStreamEvent[]): AnthropicLLMClient {
  const client = new AnthropicProvider().createClient(makeSettings());
  client.setStreamTransportForTesting(async function* () {
    for (const e of sdkEvents) {
      yield e;
    }
  });
  return client;
}

/** 收集归一化事件流为数组（便于整体断言序列） */
async function collectEvents(client: AnthropicLLMClient): Promise<LLMStreamEvent[]> {
  const request: LLMRequest = { messages: [msg("user", "hi")], thinkingEnabled: true };
  const events: LLMStreamEvent[] = [];
  for await (const ev of client.createMessageStream(request)) {
    events.push(ev);
  }
  return events;
}

/** 构造 message_delta 事件（SDK 0.71.2 的 MessageDeltaUsage 必填字段齐全） */
function messageDeltaEvent(stopReason: Anthropic.StopReason, outputTokens: number): Anthropic.RawMessageStreamEvent {
  return {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: {
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      input_tokens: null,
      output_tokens: outputTokens,
      server_tool_use: null,
    },
  };
}

/** 事件类型序列提取（断言顺序的辅助） */
function eventTypes(events: LLMStreamEvent[]): string[] {
  return events.map((e) => e.type);
}

await suite("text/thinking 增量序列归一化（噪声事件被忽略）", async () => {
  const sdkEvents: Anthropic.RawMessageStreamEvent[] = [
    // message_start 携带完整 Message（SDK 必填字段），归一化层应忽略它
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-6",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_creation: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: null,
        },
      },
    },
    // thinking 块：start + delta + stop（start/stop 对非 tool_use 块不产出事件）
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "sig_1" },
    },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "推理一下" } },
    { type: "content_block_stop", index: 0 },
    // text 块：start + delta + stop
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "", citations: null },
    },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "你好" } },
    { type: "content_block_stop", index: 1 },
    // message_delta 携带 stop_reason 与 usage；message_stop 应被忽略
    messageDeltaEvent("end_turn", 12),
    { type: "message_stop" },
  ];

  const events = await collectEvents(makeStreamClient(sdkEvents));

  // 精确序列：仅 thinking_delta / text_delta / message_end 三个事件，噪声全部被忽略
  assertEqual(events.length, 3, "归一化后仅 3 个有效事件");
  assertEqual(eventTypes(events).join(","), "thinking_delta,text_delta,message_end", "事件类型与顺序");

  const thinkingEv = events[0];
  assertTrue(thinkingEv.type === "thinking_delta" && thinkingEv.thinking === "推理一下", "thinking_delta 内容透传");

  const textEv = events[1];
  assertTrue(textEv.type === "text_delta" && textEv.text === "你好", "text_delta 内容透传");

  const endEv = events[2];
  assertTrue(endEv.type === "message_end" && endEv.stopReason === "end_turn", "stop_reason 透传为 stopReason");
  assertTrue(
    endEv.type === "message_end" && endEv.usage !== null && endEv.usage.outputTokens === 12,
    "message_delta.usage.output_tokens 映射为 outputTokens"
  );
  assertTrue(
    endEv.type === "message_end" && endEv.usage !== null && endEv.usage.inputTokens === 10,
    "M2: message_start.usage.input_tokens 聚合进 message_end.usage.inputTokens"
  );
});

await suite("M2: message_start 的 cache 用量聚合进 message_end.usage", async () => {
  const sdkEvents: Anthropic.RawMessageStreamEvent[] = [
    {
      type: "message_start",
      message: {
        id: "msg_cache",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-6",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 42,
          output_tokens: 0,
          cache_creation: null,
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 35,
          server_tool_use: null,
          service_tier: null,
        },
      },
    },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    messageDeltaEvent("end_turn", 3),
  ];

  const events = await collectEvents(makeStreamClient(sdkEvents));
  const endEv = events[events.length - 1];
  assertTrue(endEv.type === "message_end" && endEv.usage !== null, "message_end 携带 usage");
  if (endEv.type === "message_end" && endEv.usage !== null) {
    assertEqual(endEv.usage.inputTokens, 42, "inputTokens 来自 message_start");
    assertEqual(endEv.usage.outputTokens, 3, "outputTokens 来自 message_delta");
    assertEqual(endEv.usage.cacheCreationInputTokens, 7, "cache_creation_input_tokens 聚合透传");
    assertEqual(endEv.usage.cacheReadInputTokens, 35, "cache_read_input_tokens 聚合透传");
  }
});

await suite("M2: 无 message_start 时 inputTokens 回退 0", async () => {
  const sdkEvents: Anthropic.RawMessageStreamEvent[] = [
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    messageDeltaEvent("end_turn", 8),
  ];

  const events = await collectEvents(makeStreamClient(sdkEvents));
  const endEv = events[events.length - 1];
  assertTrue(
    endEv.type === "message_end" && endEv.usage !== null && endEv.usage.inputTokens === 0,
    "缺失 message_start 时 inputTokens 回退 0"
  );
  assertTrue(
    endEv.type === "message_end" && endEv.usage !== null && endEv.usage.outputTokens === 8,
    "outputTokens 正常透传"
  );
});

await suite("流式 tool_call 完整事件序列（start → delta×2 → end → message_end）", async () => {
  const sdkEvents: Anthropic.RawMessageStreamEvent[] = [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_01", name: "read_file", input: {} },
    },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"src/a.ts"}' } },
    { type: "content_block_stop", index: 0 },
    messageDeltaEvent("tool_use", 30),
  ];

  const events = await collectEvents(makeStreamClient(sdkEvents));

  // 精确序列：tool_call_start → tool_call_delta → tool_call_delta → tool_call_end → message_end
  assertEqual(
    eventTypes(events).join(","),
    "tool_call_start,tool_call_delta,tool_call_delta,tool_call_end,message_end",
    "tool_call 事件序列与顺序"
  );

  const startEv = events[0];
  assertTrue(startEv.type === "tool_call_start" && startEv.id === "toolu_01", "tool_call_start id 透传");
  assertTrue(startEv.type === "tool_call_start" && startEv.name === "read_file", "tool_call_start name 透传");

  // 分片 delta 携带同一 tool id，且可无损拼接回合法 JSON（上层累积语义的关键保证）
  const delta1 = events[1];
  const delta2 = events[2];
  assertTrue(delta1.type === "tool_call_delta" && delta1.id === "toolu_01", "delta1 归属同一 tool id");
  assertTrue(delta2.type === "tool_call_delta" && delta2.id === "toolu_01", "delta2 归属同一 tool id");
  const joined =
    (delta1.type === "tool_call_delta" ? delta1.argumentsJsonDelta : "") +
    (delta2.type === "tool_call_delta" ? delta2.argumentsJsonDelta : "");
  assertEqual(joined, '{"path":"src/a.ts"}', "argumentsJsonDelta 分片可拼接还原");
  assertTrue(JSON.parse(joined) !== null, "拼接结果为合法 JSON");

  const endEv = events[3];
  assertTrue(endEv.type === "tool_call_end" && endEv.id === "toolu_01", "tool_call_end id 透传");

  const msgEnd = events[4];
  assertTrue(msgEnd.type === "message_end" && msgEnd.stopReason === "tool_use", "stopReason=tool_use 透传");
});

await suite("守卫分支：无 tool_use 上下文时 input_json_delta 被安全丢弃", async () => {
  const sdkEvents: Anthropic.RawMessageStreamEvent[] = [
    // text 块进行中（currentToolId 为 null），异常到达一个 input_json_delta
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"x":1}' } },
    { type: "content_block_stop", index: 0 },
    messageDeltaEvent("end_turn", 5),
  ];

  const events = await collectEvents(makeStreamClient(sdkEvents));

  // 孤立 input_json_delta 不应产生任何 tool_call_delta，序列仅剩 message_end
  assertEqual(eventTypes(events).join(","), "message_end", "孤立 input_json_delta 被丢弃");
  assertTrue(!events.some((e) => e.type === "tool_call_delta"), "不产生 tool_call_delta");
});

await suite("错误归一化：transport 中途抛错产出 error 事件且迭代正常结束", async () => {
  const client = new AnthropicProvider().createClient(makeSettings());
  client.setStreamTransportForTesting(async function* () {
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    } as Anthropic.RawMessageStreamEvent;
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "半句" },
    } as Anthropic.RawMessageStreamEvent;
    throw new Error("网络中断");
  });

  const events = await collectEvents(client);

  // 已产出的增量保留，错误归一化为 error 事件收尾，不向上抛出
  assertEqual(eventTypes(events).join(","), "text_delta,error", "错误前增量保留 + error 收尾");
  const errEv = events[1];
  assertTrue(errEv.type === "error" && errEv.error instanceof Error, "error 事件携带 Error 实例");
  assertTrue(errEv.type === "error" && errEv.error.message === "网络中断", "错误 message 透传");
});

await suite("错误归一化：抛出非 Error 值时包装为 Error", async () => {
  const client = new AnthropicProvider().createClient(makeSettings());
  // 模拟底层抛出字符串（非 Error）的极端情况：以 Promise.reject 携带非 Error 值的真实异步迭代器
  client.setStreamTransportForTesting(() => ({
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Anthropic.RawMessageStreamEvent>> {
          return Promise.reject("字符串错误");
        },
      };
    },
  }));

  const events = await collectEvents(client);

  assertEqual(events.length, 1, "仅一个 error 事件");
  const errEv = events[0];
  assertTrue(errEv.type === "error" && errEv.error instanceof Error, "非 Error 值包装为 Error");
  assertTrue(errEv.type === "error" && errEv.error.message === "字符串错误", "String(e) 兜底转换");
});

console.log(`\n=== Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\nFailures:\n${failures.join("\n")}`);
  process.exit(1);
}
