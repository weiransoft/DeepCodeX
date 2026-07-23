/**
 * AnthropicProvider 单元测试
 *
 * 覆盖：客户端创建（配置映射）、能力标记、请求构建（thinking/cache）、
 *       响应解析（content/toolCalls/usage）、错误透传
 */

import { AnthropicProvider } from "../anthropic-provider.js";
import type { ResolvedDeepcodingSettings } from "../../settings.js";
import type { LLMRequest } from "../llm-provider.js";
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
function makeSettings(overrides?: Partial<ResolvedDeepcodingSettings>): ResolvedDeepcodingSettings {
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
    debugLogEnabled: false,
    telemetryEnabled: false,
    permissions: {} as ResolvedDeepcodingSettings["permissions"],
    enabledSkills: {},
    statusline: {} as ResolvedDeepcodingSettings["statusline"],
    ...overrides,
  };
}

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

await suite("provider 标识与能力标记", () => {
  const provider = new AnthropicProvider();
  assertEqual(provider.name, "anthropic", "name");
  const client = provider.createClient(makeSettings());
  assertEqual(client.providerName, "anthropic", "client.providerName");
  assertEqual(client.model, "claude-sonnet-4-6", "model 映射");
  assertTrue(client.supportsThinking, "支持 extended thinking");
  assertTrue(client.supportsPromptCaching, "支持 prompt caching");
});

await suite("API_KEY 缺失时 fail-fast", () => {
  const provider = new AnthropicProvider();
  let threw = false;
  try {
    provider.createClient(makeSettings({ apiKey: undefined, env: {} }));
  } catch (e) {
    threw = true;
    assertTrue(e instanceof Error && e.message.includes("API_KEY"), "错误信息含 API_KEY 提示");
  }
  assertTrue(threw, "应抛出配置错误");
});

await suite("请求构建：thinking 与 maxTokens 注入", () => {
  const provider = new AnthropicProvider();
  // 最小适配：本套件断言 system 为字符串，故 settings 仅启用 extended-thinking
  // （prompt-caching 启用时 system 按设计转为 cache_control 块数组，由下一套件覆盖）
  const client = provider.createClient(
    makeSettings({
      anthropic: { betaFeatures: ["extended-thinking"], maxTokens: 8192, thinkingBudgetTokens: 4096 },
    })
  );
  // 通过构建器验证请求体（不发起网络调用）
  const params = client.buildRequestParams({
    messages: [msg("system", "sys"), msg("user", "hi")],
    thinkingEnabled: true,
  } as LLMRequest);
  assertEqual(params.model, "claude-sonnet-4-6", "model");
  assertEqual(params.max_tokens, 8192, "max_tokens 来自 anthropic.maxTokens");
  assertEqual(params.system, "sys", "system 提取");
  const thinking = params.thinking as { type: string; budget_tokens: number } | undefined;
  assertEqual(thinking?.type, "enabled", "thinking enabled");
  assertEqual(thinking?.budget_tokens, 4096, "thinking 预算");
});

await suite("请求构建：prompt caching 在 system 上打 cache_control", () => {
  const provider = new AnthropicProvider();
  const client = provider.createClient(makeSettings());
  const params = client.buildRequestParams({
    messages: [msg("system", "长系统提示"), msg("user", "hi")],
    thinkingEnabled: false,
  } as LLMRequest);
  const system = params.system as Array<{ type: string; cache_control?: { type: string } }>;
  assertTrue(Array.isArray(system), "cache 模式 system 为块数组");
  assertEqual(system[0].cache_control?.type, "ephemeral", "cache_control ephemeral");
});

await suite("非流式响应解析", async () => {
  const provider = new AnthropicProvider();
  const client = provider.createClient(makeSettings());
  // 注入 fake transport（测试桩，验证解析逻辑而非网络）
  client.setTransportForTesting(async () => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "思考一下", signature: "sig" },
      // 最小适配：SDK 0.71.2 的 TextBlock.citations 为必填字段（可为 null），补齐
      { type: "text", text: "答案", citations: null },
      { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.ts" } },
    ],
    model: "claude-sonnet-4-6",
    stop_reason: "tool_use",
    // 最小适配：SDK 0.71.2 的 Message.stop_sequence 与 Usage 的
    // cache_creation/cache_creation_input_tokens/server_tool_use/service_tier
    // 为必填字段（可为 null），计划测试桩未包含，按类型要求补齐 null 值
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: 80,
      server_tool_use: null,
      service_tier: null,
    },
  }));
  const resp = await client.createMessage({ messages: [msg("user", "hi")], thinkingEnabled: true });
  assertEqual(resp.content, "答案", "text 聚合");
  assertEqual(resp.thinking, "思考一下", "thinking 聚合");
  assertEqual(resp.toolCalls.length, 1, "一个 toolCall");
  assertEqual(resp.toolCalls[0].name, "read_file", "toolCall name");
  assertEqual(resp.toolCalls[0].argumentsJson, '{"path":"a.ts"}', "input 序列化为 argumentsJson");
  assertEqual(resp.stopReason, "tool_use", "stopReason 透传");
  assertEqual(resp.usage?.inputTokens, 100, "inputTokens 映射");
  assertEqual(resp.usage?.cacheReadInputTokens, 80, "cacheRead 透传");
});

console.log(`\n=== Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\nFailures:\n${failures.join("\n")}`);
  process.exit(1);
}
