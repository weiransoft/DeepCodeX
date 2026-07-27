/**
 * SessionManager Usage / compact / stream / deleteSession 测试套件
 *
 * 覆盖方法群：
 * - Usage 累积：keeps usagePerModel null until response、accumulates response usage、
 *   stores usage per model across model changes
 * - compact：resets active tokens to latest post-compaction、writes summary message、
 *   silently skips when no LLM client credential
 * - stream：streams chat completions and counts reasoning progress
 * - 中断处理：persists session before skill matching cancelled、treats APIUserAbortError as interrupted
 * - deleteSession：removes session entry、removes messages file、returns false when not exist、
 *   does not affect other sessions
 *
 * 共 13 个测试用例。
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { SessionManager, getProjectCode } from "../session";
import type { LLMClient, LLMRequest, LLMResponse } from "../providers/llm-provider";
import {
  createSessionTestEnv,
  createTempDir,
  createSessionManager,
  createMockedClientSessionManager,
  createMockedClientSessionManagerWithClient,
  createChatResponse,
  createSkillMatchingResponse,
  isSkillMatchingRequest,
  createStubLLMClient,
  createLLMTextResponse,
  createChatStreamResponse,
  createSessionAndMessages,
  APIUserAbortError,
} from "./fixtures/session-test-env";

// 每个测试文件持有独立的 env 实例，避免跨文件全局状态污染
const env = createSessionTestEnv();

afterEach(() => {
  env.cleanup();
});

test("SessionManager keeps usagePerModel null until response usage is available", async () => {
  const workspace = createTempDir(env, "deepcode-null-usage-per-model-workspace-");
  const home = createTempDir(env, "deepcode-null-usage-per-model-home-");
  env.setHomeDir(home);

  const manager = createMockedClientSessionManager(workspace, [{ choices: [{ message: { content: "no usage" } }] }]);

  const sessionId = await manager.createSession({ text: "" });

  assert.equal(manager.getSession(sessionId)?.usage, null);
  assert.equal(manager.getSession(sessionId)?.usagePerModel, null);
});

test("SessionManager accumulates response usage while active tokens track the latest response", async () => {
  const workspace = createTempDir(env, "deepcode-usage-workspace-");
  const home = createTempDir(env, "deepcode-usage-home-");
  env.setHomeDir(home);

  const responses = [
    createChatResponse("first", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 7 },
      completion_tokens_details: { reasoning_tokens: 3 },
      prompt_cache_hit_tokens: 7,
      prompt_cache_miss_tokens: 3,
    }),
    createChatResponse("second", {
      prompt_tokens: 20,
      completion_tokens: 7,
      total_tokens: 27,
      prompt_tokens_details: { cached_tokens: 11 },
      completion_tokens_details: { reasoning_tokens: 4 },
      prompt_cache_hit_tokens: 11,
      prompt_cache_miss_tokens: 9,
    }),
  ];
  const manager = createMockedClientSessionManager(workspace, responses);

  const sessionId = await manager.createSession({ text: "" });
  await manager.replySession(sessionId, { text: "" });

  const session = manager.getSession(sessionId);
  const usage = session?.usage as Record<string, any>;
  const usagePerModel = session?.usagePerModel?.["test-model"] as Record<string, any>;
  assert.equal(session?.activeTokens, 27);
  assert.equal(usage.prompt_tokens, 30);
  assert.equal(usage.completion_tokens, 12);
  assert.equal(usage.total_tokens, 42);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 18);
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 7);
  assert.equal(usage.prompt_cache_hit_tokens, 18);
  assert.equal(usage.prompt_cache_miss_tokens, 12);
  assert.equal(usagePerModel.prompt_tokens, 30);
  assert.equal(usagePerModel.completion_tokens, 12);
  assert.equal(usagePerModel.total_tokens, 42);
  assert.equal(usagePerModel.prompt_tokens_details.cached_tokens, 18);
  assert.equal(usagePerModel.completion_tokens_details.reasoning_tokens, 7);
  assert.equal(usagePerModel.prompt_cache_hit_tokens, 18);
  assert.equal(usagePerModel.prompt_cache_miss_tokens, 12);
  assert.equal(usagePerModel.total_reqs, 2);
});

test("SessionManager stores usage per model across model changes", async () => {
  const workspace = createTempDir(env, "deepcode-usage-per-model-workspace-");
  const home = createTempDir(env, "deepcode-usage-per-model-home-");
  env.setHomeDir(home);

  let currentModel = "deepseek-v4-pro";
  const responses = [
    createChatResponse("pro response", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    }),
    createChatResponse("flash response", {
      prompt_tokens: 20,
      completion_tokens: 7,
      total_tokens: 27,
      prompt_cache_hit_tokens: 6,
    }),
  ];
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          if (isSkillMatchingRequest(request)) {
            return createSkillMatchingResponse();
          }
          const response = responses.shift();
          assert.ok(response, "expected a queued chat response");
          return response;
        },
      },
    },
  };
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: currentModel,
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: currentModel }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const sessionId = await manager.createSession({ text: "" });
  currentModel = "deepseek-v4-flash";
  await manager.replySession(sessionId, { text: "" });

  const session = manager.getSession(sessionId);
  assert.deepEqual(Object.keys(session?.usagePerModel ?? {}).sort(), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(session?.usagePerModel?.["deepseek-v4-pro"]?.prompt_tokens, 10);
  assert.equal(session?.usagePerModel?.["deepseek-v4-pro"]?.completion_tokens, 5);
  assert.equal(session?.usagePerModel?.["deepseek-v4-pro"]?.total_reqs, 1);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.prompt_tokens, 20);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.completion_tokens, 7);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.prompt_cache_hit_tokens, 6);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.total_reqs, 1);
  assert.equal(session?.usage?.prompt_tokens, 30);
  assert.equal(session?.usage?.completion_tokens, 12);
  assert.equal(session?.usage?.total_tokens, 42);
});

test("SessionManager resets active tokens to latest post-compaction response usage", async () => {
  const workspace = createTempDir(env, "deepcode-compact-usage-workspace-");
  const home = createTempDir(env, "deepcode-compact-usage-home-");
  env.setHomeDir(home);

  // B1：主对话流式通路仍消费 OpenAI 队列（createSession + compact 后 reply 各一次）；
  // compact 非流式调用改经 createLLMClient 桩消费独立响应队列
  const responses = [
    createChatResponse("large", {
      prompt_tokens: 139_990,
      completion_tokens: 10,
      total_tokens: 140_000,
    }),
    createChatResponse("after compact", {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    }),
  ];
  const compactRequests: LLMRequest[] = [];
  const compactLLMClient = createStubLLMClient(
    [createLLMTextResponse("summary", { inputTokens: 100, outputTokens: 23 })],
    compactRequests
  );
  const manager = createMockedClientSessionManager(workspace, responses, () => compactLLMClient);

  const sessionId = await manager.createSession({ text: "" });
  assert.equal(manager.getSession(sessionId)?.activeTokens, 140_000);

  await manager.replySession(sessionId, { text: "" });

  // compact 调用经 provider 抽象层发起：恰好一次，请求为单条 user 消息
  assert.equal(compactRequests.length, 1);
  assert.equal(compactRequests[0]?.messages.length, 1);
  assert.equal(compactRequests[0]?.messages[0]?.role, "user");

  const session = manager.getSession(sessionId);
  const usage = session?.usage as Record<string, any>;
  const usagePerModel = session?.usagePerModel?.["test-model"] as Record<string, any>;
  assert.equal(session?.activeTokens, 7);
  assert.equal(usage.prompt_tokens, 140_095);
  assert.equal(usage.completion_tokens, 35);
  assert.equal(usage.total_tokens, 140_130);
  assert.equal(usagePerModel.prompt_tokens, 140_095);
  assert.equal(usagePerModel.completion_tokens, 35);
  assert.equal(usagePerModel.total_tokens, 140_130);
  assert.equal(usagePerModel.total_reqs, 3);
});

test("SessionManager compactSession writes summary message and marks earlier messages compacted (B1)", async () => {
  const workspace = createTempDir(env, "deepcode-compact-summary-workspace-");
  const home = createTempDir(env, "deepcode-compact-summary-home-");
  env.setHomeDir(home);

  const responses = [
    createChatResponse("large reply", {
      prompt_tokens: 139_990,
      completion_tokens: 10,
      total_tokens: 140_000,
    }),
    createChatResponse("after compact", {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    }),
  ];
  const compactRequests: LLMRequest[] = [];
  const compactLLMClient = createStubLLMClient(
    [createLLMTextResponse("对话要点总结", { inputTokens: 100, outputTokens: 23 })],
    compactRequests
  );
  const manager = createMockedClientSessionManager(workspace, responses, () => compactLLMClient);

  const sessionId = await manager.createSession({ text: "" });
  await manager.replySession(sessionId, { text: "" });

  // 请求语义：thinkingEnabled 取自统一 settings 解析链（空 settings 下默认模型
  // deepseek-v4-pro → thinking 默认开启）；提示词含被压缩会话内容（原提示词构造逻辑不变）
  assert.equal(compactRequests.length, 1);
  assert.equal(compactRequests[0]?.thinkingEnabled, true);
  const compactPromptContent = compactRequests[0]?.messages[0]?.content;
  assert.equal(typeof compactPromptContent, "string");
  // 上一行 assert.equal 已在运行时保证 compactPromptContent 为 string，
  // 此处使用非空断言告知 TS 类型已收窄（避免 possibly undefined 编译错误）
  assert.ok(compactPromptContent!.includes("large reply"), "compact 提示词应包含会话内容");

  // 持久化语义：生成 isSummary 用户消息；其之前的消息全部标记 compacted
  // Qwen3 兼容修复：summaryMessage role 为 "user"（非 "system"），
  // 避免 flattenMidConversationSystemMessages 将其合并到开头 system 导致缺少 user query
  const messages = manager.listSessionMessages(sessionId);
  const summaryIndex = messages.findIndex((message) => message.meta?.isSummary === true);
  assert.ok(summaryIndex > 0, "应插入 summary 消息");
  assert.ok(messages[summaryIndex]?.content?.includes("对话要点总结"), "summary 消息携带 LLM 总结文本");
  assert.equal(messages[summaryIndex]?.role, "user", "summary 消息 role 应为 user（Qwen3 兼容）");
  for (let i = 0; i < summaryIndex; i += 1) {
    const message = messages[i];
    if (message.role === "system" && !message.meta?.isSummary) {
      continue; // startIndex 之前的 system 消息不参与压缩
    }
    assert.equal(message.compacted, true, `消息 ${message.id} 应被标记 compacted`);
  }
});

test("SessionManager compactSession silently skips when no LLM client credential is available (B1)", async () => {
  const workspace = createTempDir(env, "deepcode-compact-nocred-workspace-");
  const home = createTempDir(env, "deepcode-compact-nocred-home-");
  env.setHomeDir(home);

  const responses = [
    createChatResponse("large reply", {
      prompt_tokens: 139_990,
      completion_tokens: 10,
      total_tokens: 140_000,
    }),
    createChatResponse("without compact", {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    }),
  ];
  // createLLMClient 返回 null（无凭据）：compact 静默跳过，主对话继续
  const manager = createMockedClientSessionManager(workspace, responses, () => null);

  const sessionId = await manager.createSession({ text: "" });
  await manager.replySession(sessionId, { text: "" });

  const messages = manager.listSessionMessages(sessionId);
  assert.equal(
    messages.some((message) => message.meta?.isSummary === true),
    false,
    "不应生成 summary 消息"
  );
  assert.equal(
    messages.some((message) => message.compacted),
    false,
    "不应有消息被标记 compacted"
  );
  // 主对话未受 compact 跳过影响：assistant 正常回复
  assert.ok(messages.some((message) => message.role === "assistant" && message.content === "without compact"));
});

test("SessionManager streams chat completions and counts reasoning progress", async () => {
  const workspace = createTempDir(env, "deepcode-stream-workspace-");
  const home = createTempDir(env, "deepcode-stream-home-");
  env.setHomeDir(home);

  const progressEvents: Array<{
    phase: string;
    estimatedTokens: number;
    formattedTokens: string;
  }> = [];
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          assert.equal(request.stream, true);
          assert.deepEqual(request.stream_options, { include_usage: true });
          assert.equal(request.temperature, 0.25);
          return createChatStreamResponse([
            { choices: [{ delta: { reasoning_content: "思考" } }] },
            { choices: [{ delta: { content: "hello" } }] },
            {
              choices: [],
              usage: {
                prompt_tokens: 2,
                completion_tokens: 3,
                total_tokens: 5,
              },
            },
          ]);
        },
      },
    },
  };

  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      temperature: 0.25,
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onLlmStreamProgress: (progress) => {
      progressEvents.push({
        phase: progress.phase,
        estimatedTokens: progress.estimatedTokens,
        formattedTokens: progress.formattedTokens,
      });
    },
  });

  const sessionId = await manager.createSession({ text: "" });
  const assistantMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "assistant");

  assert.equal(assistantMessage?.content, "hello");
  assert.equal((assistantMessage?.messageParams as any)?.reasoning_content, "思考");
  assert.equal(manager.getSession(sessionId)?.activeTokens, 5);
  assert.deepEqual(
    progressEvents.map((event) => event.phase),
    ["start", "update", "update", "end"]
  );
  assert.equal(progressEvents[1]?.estimatedTokens, 1);
  assert.equal(progressEvents[2]?.formattedTokens, "3");
});

test("SessionManager persists session and user message before skill matching is cancelled", async () => {
  const workspace = createTempDir(env, "deepcode-skill-abort-workspace-");
  const home = createTempDir(env, "deepcode-skill-abort-home-");
  env.setHomeDir(home);

  const skillDir = path.join(home, ".agents", "skills", "demo");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\n# Demo\n", "utf8");

  // eslint-disable-next-line prefer-const -- must be declared before client which references it
  let manager: SessionManager;
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          assert.equal(request.temperature, 0.1);
          return new Promise((_resolve, reject) => {
            const signal = options?.signal;
            signal?.addEventListener("abort", () => reject(new APIUserAbortError()), { once: true });
            queueMicrotask(() => manager.interruptActiveSession());
          });
        },
      },
    },
  };

  manager = createMockedClientSessionManagerWithClient(workspace, client);

  await manager.handleUserPrompt({ text: "please use demo" });

  // Session and user message are persisted before skill matching triggers an abort.
  assert.equal(manager.listSessions().length, 1);
  const [session] = manager.listSessions();
  assert.equal(session?.status, "pending");
  const messages = manager.listSessionMessages(session!.id);
  const userMessage = messages.find((m) => m.role === "user");
  assert.equal(userMessage?.content, "please use demo");
});

test("SessionManager treats OpenAI APIUserAbortError as interrupted", async () => {
  const workspace = createTempDir(env, "deepcode-api-abort-workspace-");
  const home = createTempDir(env, "deepcode-api-abort-home-");
  env.setHomeDir(home);

  let manager: SessionManager;
  const client = {
    chat: {
      completions: {
        create: async (_request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            const signal = options?.signal;
            signal?.addEventListener("abort", () => reject(new APIUserAbortError()), { once: true });
          });
        },
      },
    },
  };

  // eslint-disable-next-line prefer-const -- declared before client, assigned after
  manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onSessionEntryUpdated: (entry) => {
      if (entry.status === "processing") {
        queueMicrotask(() => manager.interruptActiveSession());
      }
    },
  });

  await manager.handleUserPrompt({ text: "" });

  const activeSessionId = manager.getActiveSessionId();
  assert.ok(activeSessionId);
  const session = manager.getSession(activeSessionId);
  assert.equal(session?.status, "interrupted");
  assert.equal(session?.failReason, "interrupted");
});

test("SessionManager.deleteSession removes session entry from the index", () => {
  const workspace = createTempDir(env, "deepcode-delete-workspace-");
  const home = createTempDir(env, "deepcode-delete-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-delete");
  (manager as any).activateSession = async () => {};

  // Create two sessions
  const session1 = createSessionAndMessages(manager, "session-delete-1", "First session");
  const session2 = createSessionAndMessages(manager, "session-delete-2", "Second session");

  assert.equal(manager.listSessions().length, 2);

  // Delete the first session
  const result = manager.deleteSession(session1);
  assert.equal(result, true);

  const remaining = manager.listSessions();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.id, session2);
});

test("SessionManager.deleteSession removes the messages file", () => {
  const workspace = createTempDir(env, "deepcode-delete-msg-workspace-");
  const home = createTempDir(env, "deepcode-delete-msg-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-delete-msg");
  (manager as any).activateSession = async () => {};

  const sessionId = createSessionAndMessages(manager, "session-delete-msg", "Test session");
  const messagePath = path.join(home, ".deepcode", "projects", getProjectCode(workspace), `${sessionId}.jsonl`);

  // Verify messages file exists
  assert.ok(fs.existsSync(messagePath));

  manager.deleteSession(sessionId);

  // Verify messages file is removed
  assert.equal(fs.existsSync(messagePath), false);
});

test("SessionManager.deleteSession returns false when session does not exist", () => {
  const workspace = createTempDir(env, "deepcode-delete-nonexist-workspace-");
  const home = createTempDir(env, "deepcode-delete-nonexist-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-delete-nonexist");

  const result = manager.deleteSession("nonexistent-session-id");
  assert.equal(result, false);
  assert.equal(manager.listSessions().length, 0);
});

test("SessionManager.deleteSession does not affect other sessions", () => {
  const workspace = createTempDir(env, "deepcode-delete-others-workspace-");
  const home = createTempDir(env, "deepcode-delete-others-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-delete-others");
  (manager as any).activateSession = async () => {};

  const session1 = createSessionAndMessages(manager, "session-keep-1", "Keep session 1");
  const session2 = createSessionAndMessages(manager, "session-keep-2", "Keep session 2");

  // Delete non-existent session
  const result = manager.deleteSession("non-existent");
  assert.equal(result, false);
  assert.equal(manager.listSessions().length, 2);

  // Delete one session
  assert.equal(manager.deleteSession(session1), true);
  assert.equal(manager.listSessions().length, 1);
  assert.equal(manager.listSessions()[0]?.id, session2);

  // The remaining session should still have its messages accessible
  const messages = manager.listSessionMessages(session2);
  assert.ok(messages.length > 0);
});
