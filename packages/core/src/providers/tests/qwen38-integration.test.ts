/**
 * Qwen3.8 适配场景集成测试（v1.2，provider 级）
 *
 * 对应设计文档 docs/qwen38-adaptation.md §5.6（验收标准第 2、3、5 条）：
 *   S1  Qwen3.8 thinking=true 端到端请求体：顶层 chat_template_kwargs
 *       {enable_thinking: true, preserve_thinking: true} + reasoning_effort 映射
 *   S2  thinking=false 负向：请求体恰好仅含 enable_thinking: false，无残留字段
 *   S3  流式双字段 fallback：delta.reasoning_content 与 delta.reasoning
 *       两种字段均产出 thinking_delta 事件（D6）
 *   S4  多轮回放 + preserve_thinking 同现：历史 assistant reasoning_content
 *       回放与 preserve_thinking: true 在同一请求体中共现（语义一致性）
 *
 * 测试方式（禁止 mock / 简化）：沿用 openai-stream.test.ts 的
 * TestableOpenAILLMClient 模式——子类化 OpenAILLMClient 覆写公开的
 * getUnderlyingOpenAI()，注入记录参数的桩客户端（真实异步迭代器、
 * 真实接口契约的固定响应），验证请求构建与事件归一化逻辑本身，
 * 不绕过构造器、不手写假 LLM 实例。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import { OpenAILLMClient } from "../openai-provider.js";
import type { LLMRequest, LLMStreamEvent } from "../llm-provider.js";
import type { ResolvedDeepcodingSettings } from "../../settings.js";
import type { SessionMessage } from "../../session.js";

/** 构造 Qwen3.8 settings 夹具（最小必要字段，model 为 3.8+ 模型） */
function makeSettings(
  overrides: Partial<Pick<ResolvedDeepcodingSettings, "thinkingEnabled" | "reasoningEffort" | "model">> = {}
): ResolvedDeepcodingSettings {
  return {
    env: { API_KEY: "sk-test" },
    apiKey: "sk-test",
    baseURL: "http://localhost:8000/v1",
    model: "qwen3.8-plus",
    provider: "openai",
    thinkingEnabled: true,
    reasoningEffort: "xhigh",
    timeout: 600,
    contextWindow: 262144,
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
    ...overrides,
  };
}

/** 构造测试用 SessionMessage（仅填必要字段，messageParams 可注入 reasoning_content） */
function msg(
  role: SessionMessage["role"],
  content: string | null,
  messageParams: Record<string, unknown> | null = null
): SessionMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role,
    content,
    contentParams: null,
    messageParams,
    compacted: false,
    visible: true,
    createTime: "2026-09-03T00:00:00Z",
    updateTime: "2026-09-03T00:00:00Z",
  };
}

/** 桩客户端捕获的调用现场 */
type RecordedCall = {
  params: Record<string, unknown>;
};

/** 桩流可配置的 delta chunk 序列类型（真实响应形状） */
type StubChunk = { choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }> };

/**
 * 可测试的 OpenAILLMClient 子类：覆写 getUnderlyingOpenAI 注入桩实例。
 * 桩的 chat.completions.create 记录请求参数，并按传入的 chunk 序列
 * 返回真实异步生成器（真实接口契约的固定响应，非 mock 框架）。
 */
class TestableOpenAILLMClient extends OpenAILLMClient {
  /** 测试侧读取：每次 chat.completions.create 的请求参数 */
  readonly recorded: RecordedCall[] = [];

  /** 桩流产出的 delta chunk 序列（由用例配置） */
  stubChunks: StubChunk[] = [];

  override getUnderlyingOpenAI(): OpenAI | null {
    const recorded = this.recorded;
    const chunks = this.stubChunks;
    const stub = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            recorded.push({ params });
            // 真实异步生成器：逐帧产出用例配置的 chunk（真实流式响应形状）
            return (async function* () {
              for (const chunk of chunks) {
                yield chunk;
              }
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

test("S1: Qwen3.8 thinking=true 请求体下发 preserve_thinking 与映射后的顶层 reasoning_effort", async () => {
  const client = new TestableOpenAILLMClient(
    makeSettings({ model: "qwen3.8-plus", thinkingEnabled: true, reasoningEffort: "xhigh" })
  );
  const request: LLMRequest = { messages: [msg("user", "hi")], thinkingEnabled: true };

  await collectEvents(client, request);

  assert.equal(client.recorded.length, 1, "chat.completions.create 被调用一次");
  const params = client.recorded[0]?.params ?? {};
  assert.equal(params.model, "qwen3.8-plus", "model 透传");
  // 对应验收标准第 2 条：thinking=true 时下发 preserve_thinking + 顶层 reasoning_effort
  assert.deepStrictEqual(
    params.chat_template_kwargs,
    { enable_thinking: true, preserve_thinking: true },
    "chat_template_kwargs 应含 enable_thinking=true 与 preserve_thinking=true"
  );
  assert.equal(params.reasoning_effort, "xhigh", "settings.reasoningEffort=xhigh 应直传为顶层 reasoning_effort");
});

test("S2: Qwen3.8 thinking=false 请求体仅含 enable_thinking=false，无残留字段", async () => {
  const client = new TestableOpenAILLMClient(
    makeSettings({ model: "qwen3.8-plus", thinkingEnabled: false, reasoningEffort: "xhigh" })
  );
  const request: LLMRequest = { messages: [msg("user", "hi")], thinkingEnabled: false };

  await collectEvents(client, request);

  const params = client.recorded[0]?.params ?? {};
  // 对应验收标准第 3 条：仅 enable_thinking: false
  assert.deepStrictEqual(
    params.chat_template_kwargs,
    { enable_thinking: false },
    "thinking=false 时 chat_template_kwargs 应恰好仅含 enable_thinking=false"
  );
  // 负向断言：不得残留 reasoning_effort / preserve_thinking 字段
  assert.ok(!("reasoning_effort" in params), "thinking=false 不应包含顶层 reasoning_effort");
  assert.ok(
    !("preserve_thinking" in (params.chat_template_kwargs as object)),
    "thinking=false 不应包含 preserve_thinking"
  );
});

test("S3: 流式 reasoning_content 与 reasoning 两种字段均产出 thinking_delta 事件（D6 双字段 fallback）", async () => {
  const client = new TestableOpenAILLMClient(makeSettings());
  // 桩流依次产出两种部署风格的思考增量字段：reasoning_content（vLLM）与 reasoning（部分部署）
  client.stubChunks = [
    { choices: [{ delta: { reasoning_content: "A" }, finish_reason: null }] },
    { choices: [{ delta: { reasoning: "B" }, finish_reason: null }] },
    { choices: [{ delta: { content: "答案" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
  const request: LLMRequest = { messages: [msg("user", "hi")], thinkingEnabled: true };

  const events = await collectEvents(client, request);

  // 对应验收标准第 5 条：两种字段均归一化为 thinking_delta
  const thinkingEvents = events.filter((e) => e.type === "thinking_delta");
  assert.equal(thinkingEvents.length, 2, "应产出两个 thinking_delta 事件");
  assert.equal(
    thinkingEvents[0]?.type === "thinking_delta" && thinkingEvents[0].thinking,
    "A",
    "reasoning_content 字段内容透传"
  );
  assert.equal(
    thinkingEvents[1]?.type === "thinking_delta" && thinkingEvents[1].thinking,
    "B",
    "reasoning 字段内容透传（fallback 生效）"
  );
});

test("S4: 历史 assistant reasoning_content 回放与 preserve_thinking=true 在同一请求体中共现", async () => {
  const client = new TestableOpenAILLMClient(
    makeSettings({ model: "qwen3.8-plus", thinkingEnabled: true, reasoningEffort: "xhigh" })
  );
  // 多轮场景：历史 assistant 消息携带上一轮思考块（messageParams.reasoning_content）
  const history = msg("assistant", "上轮结论", { reasoning_content: "上一轮思考" });
  const request: LLMRequest = { messages: [msg("user", "问"), history, msg("user", "继续")], thinkingEnabled: true };

  await collectEvents(client, request);

  const params = client.recorded[0]?.params ?? {};
  const messages = params.messages as Array<{ role: string; content: unknown; reasoning_content?: string }>;
  // 对应验收标准第 2 条语义一致性：历史思考块回放与 preserve_thinking 同现
  const replayed = messages.find((m) => m.role === "assistant");
  assert.ok(replayed, "请求 messages 中应包含历史 assistant 消息");
  assert.equal(replayed?.reasoning_content, "上一轮思考", "历史 assistant 消息应回放 reasoning_content");
  assert.equal(
    (params.chat_template_kwargs as Record<string, unknown>)?.preserve_thinking,
    true,
    "同一请求体应包含 preserve_thinking: true（与回放语义一致）"
  );
});
