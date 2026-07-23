/**
 * OpenAIProvider 流式调用测试（M3：流式参数与非流式 createMessage 对齐）
 *
 * 覆盖：
 * 1. createMessageStream 请求参数携带 tools（request.tools 映射为 function 工具）与
 *    temperature（若提供），与非流式 createMessage 参数语义一致；
 * 2. 未提供 tools/temperature 时不发送对应字段（保持服务端默认行为）；
 * 3. 基础事件归一化链路可用（text_delta → message_end），确保流式消费正常触发请求。
 *
 * 测试方式：子类化 OpenAILLMClient 覆写公开的 getUnderlyingOpenAI()，
 * 注入记录参数的桩客户端（真实异步迭代器，非 mock 框架），验证请求构建与归一化逻辑本身。
 */

import type OpenAI from "openai";
import { OpenAILLMClient } from "../openai-provider.js";
import type { LLMRequest, LLMStreamEvent, LLMToolDefinition } from "../llm-provider.js";
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

/** 构造 openai settings（最小必要字段） */
function makeSettings(): ResolvedDeepcodingSettings {
  return {
    env: { API_KEY: "sk-test" },
    apiKey: "sk-test",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    provider: "openai",
    thinkingEnabled: true,
    reasoningEffort: "max",
    timeout: 600,
    debugLogEnabled: false,
    telemetryEnabled: false,
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

/** 桩客户端捕获的调用现场（参数 + 选项） */
type RecordedCall = {
  params: Record<string, unknown>;
};

/**
 * 可测试的 OpenAILLMClient 子类：覆写 getUnderlyingOpenAI 注入桩实例。
 * 桩的 chat.completions.create 记录请求参数并返回真实异步迭代器（一个 text chunk + finish chunk）。
 */
class TestableOpenAILLMClient extends OpenAILLMClient {
  /** 测试侧读取：最后一次 chat.completions.create 的请求参数 */
  readonly recorded: RecordedCall[] = [];

  override getUnderlyingOpenAI(): OpenAI | null {
    const recorded = this.recorded;
    const stub = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            recorded.push({ params });
            // 真实异步生成器：先产出文本增量，再产出 finish_reason 结束帧
            return (async function* () {
              yield { choices: [{ delta: { content: "你好" }, finish_reason: null }] };
              yield { choices: [{ delta: {}, finish_reason: "stop" }] };
            })();
          },
        },
      },
    };
    return stub as unknown as OpenAI;
  }
}

/** 收集归一化事件流为数组 */
async function collectEvents(client: OpenAILLMClient, request: LLMRequest): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  for await (const ev of client.createMessageStream(request)) {
    events.push(ev);
  }
  return events;
}

const demoTools: LLMToolDefinition[] = [
  {
    name: "read_file",
    description: "读取文件内容",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

await suite("M3: 流式请求携带 tools（function 映射）与 temperature", async () => {
  const client = new TestableOpenAILLMClient(makeSettings());
  const request: LLMRequest = {
    messages: [msg("user", "hi")],
    thinkingEnabled: true,
    tools: demoTools,
    temperature: 0.5,
  };

  const events = await collectEvents(client, request);

  assertEqual(client.recorded.length, 1, "chat.completions.create 被调用一次");
  const params = client.recorded[0]?.params ?? {};
  assertEqual(params.stream, true, "stream: true");
  assertEqual(params.model, "deepseek-v4-pro", "model 透传");
  assertEqual(params.temperature, 0.5, "temperature 透传");

  const tools = params.tools as Array<{
    type: string;
    function: { name: string; description?: string; parameters: unknown };
  }>;
  assertTrue(Array.isArray(tools) && tools.length === 1, "tools 字段存在且长度为 1");
  assertEqual(tools[0]?.type, "function", "工具 type 映射为 function");
  assertEqual(tools[0]?.function.name, "read_file", "工具 name 透传");
  assertEqual(tools[0]?.function.description, "读取文件内容", "工具 description 透传");
  assertEqual(
    JSON.stringify(tools[0]?.function.parameters),
    JSON.stringify(demoTools[0]?.parameters),
    "工具 parameters 原样透传"
  );

  // 基础归一化链路：text_delta → message_end
  assertEqual(events.map((e) => e.type).join(","), "text_delta,message_end", "事件序列");
  const textEv = events[0];
  assertTrue(textEv.type === "text_delta" && textEv.text === "你好", "text_delta 内容透传");
  const endEv = events[1];
  assertTrue(endEv.type === "message_end" && endEv.stopReason === "stop", "finish_reason 映射为 stopReason");
});

await suite("M3: 未提供 tools/temperature 时不发送对应字段", async () => {
  const client = new TestableOpenAILLMClient(makeSettings());
  const request: LLMRequest = { messages: [msg("user", "hi")], thinkingEnabled: true };

  await collectEvents(client, request);

  const params = client.recorded[0]?.params ?? {};
  assertTrue(!("tools" in params), "无 tools 字段");
  assertTrue(!("temperature" in params), "无 temperature 字段");
  assertEqual(params.stream, true, "stream: true 保持");
});

console.log(`\n=== Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\nFailures:\n${failures.join("\n")}`);
  process.exit(1);
}
