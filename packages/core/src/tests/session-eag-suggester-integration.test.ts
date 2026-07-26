/**
 * SessionManager 与 EagDynamicSuggester 集成测试
 *
 * 测试范围：
 * - BUGFIX 2026-07-26：验证 direct_chat 场景下 replySession 继续执行 LLM 主对话
 *   根因：replySession 第 2274-2276 行原实现无条件 return，阻断了 direct_chat
 *   场景下的 LLM 主对话调用，导致用户输入"保存到文档"等普通消息后 LLM 永远不被调用。
 * - 验证 direct_chat 场景下用户消息不重复追加
 * - 验证 ask_clarification / suggest_command 场景下 LLM 主对话不被调用
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock：OpenAI client 使用真实 chat.completions.create 签名桩
 * - EagDynamicSuggester 使用 stub 对象（通过类型断言注入），避免 LLM 调用
 *
 * @module tests/session-eag-suggester-integration
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionManager, type SessionMessage } from "../session";
import type { EagDynamicSuggester } from "../eag/dynamic/eag-dynamic-suggester";
import { type EagDynamicSuggestion } from "../eag/dynamic/eag-dynamic-suggester";

// ============================================================================
// 测试辅助
// ============================================================================

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

/** 跨平台设置 home 目录（Unix 用 HOME，Windows 用 USERPROFILE） */
function setHomeDir(dir: string): void {
  process.env.HOME = dir;
  if (process.platform === "win32") {
    process.env.USERPROFILE = dir;
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
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

/** 创建临时目录并自动注册清理 */
function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * 构造固定返回的 EagDynamicSuggester stub
 *
 * 避免真实 LLM 调用，直接返回预设的 EagDynamicSuggestion。
 * 通过类型断言注入 SessionManager，保证测试聚焦于 replySession 集成逻辑。
 *
 * @param suggestion 预设的建议结果
 * @returns EagDynamicSuggester stub 实例
 */
function createStubSuggester(suggestion: EagDynamicSuggestion): EagDynamicSuggester {
  return {
    isEnabled: () => true,
    suggest: async () => suggestion,
  } as unknown as EagDynamicSuggester;
}

/**
 * 构造记录调用次数的 OpenAI client 桩
 *
 * 简化 mock：仅记录调用次数和返回流式响应，不做 request 断言（避免干扰）
 * 注意：callCount 使用对象包装（{ value: number }），避免 number 原始类型值传递导致闭包失效
 *
 * @param responseContent LLM 返回的文本内容
 * @returns 包含 client 和 callCount 引用的 client 桩
 */
function createCallCountingClient(responseContent: string): {
  client: unknown;
  callCount: { value: number };
} {
  const callCount = { value: 0 };
  const client = {
    chat: {
      completions: {
        create: async (_request: Record<string, unknown>) => {
          callCount.value++;
          // 返回最小化的流式响应：一个 content chunk + usage
          return createChatStreamResponse([
            { choices: [{ delta: { content: responseContent } }] },
            {
              choices: [],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          ]);
        },
      },
    },
  };
  return { client, callCount };
}

/** 构造流式响应 AsyncGenerator（对齐 session.test.ts 中的 createChatStreamResponse） */
async function* createChatStreamResponse(
  chunks: ReadonlyArray<Record<string, unknown>>
): AsyncGenerator<Record<string, unknown>> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// ============================================================================
// 测试用例
// ============================================================================

test("BUGFIX 2026-07-26: direct_chat 场景下 replySession 继续执行 LLM 主对话", async () => {
  // 场景：用户输入"保存到文档"，suggester 判定为 direct_chat，
  // replySession 应继续执行 LLM 主对话（activateSession 被调用）
  const workspace = createTempDir("deepcode-eag-direct-chat-workspace-");
  const home = createTempDir("deepcode-eag-direct-chat-home-");
  setHomeDir(home);

  // 关闭 skill matching 的 LLM 调用干扰（通过空 settings）
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("好的，我来帮你保存到文档。");

  const manager = new SessionManager({
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
    eagDynamicSuggester: createStubSuggester({
      type: "direct_chat",
      reasoning: "用户想要保存文档，属于普通对话",
    }),
  });

  // 用空文本创建会话（避免 skill matching 的 LLM 调用干扰），然后再 reply
  // createSession({ text: "" }) 会跳过 identifyMatchingSkillNames，直接调用 activateSession
  const sessionId = await manager.createSession({ text: "" });
  // createSession({text:""}) 会调用一次 LLM（activateSession 中 createChatCompletionStream）
  const createCallCount = callCount.value;

  // 用户输入"保存到文档"（非空文本，触发 replySession + eagDynamicSuggester）
  await manager.handleUserPrompt({ text: "保存到文档" });

  // 核心断言：direct_chat 场景下 LLM 主对话应被调用
  // callCount 应大于 createSession 时的调用次数
  assert.ok(
    callCount.value > createCallCount,
    `direct_chat 场景下 LLM 主对话应被调用，但 callCount 未增加（createSession=${createCallCount}, total=${callCount.value}）`
  );

  // 验证会话状态为 completed
  const session = manager.getSession(sessionId);
  assert.equal(session?.status, "completed", "direct_chat 后会话应为 completed 状态");
});

test("BUGFIX 2026-07-26: direct_chat 场景下用户消息不重复追加", async () => {
  // 场景：用户输入"保存到文档"，suggester 返回 direct_chat，
  // handleEagDynamicSuggestion 不追加用户消息（由 replySession 统一追加），
  // 验证会话日志中用户消息只出现一次
  const workspace = createTempDir("deepcode-eag-no-dup-workspace-");
  const home = createTempDir("deepcode-eag-no-dup-home-");
  setHomeDir(home);

  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("好的");

  const manager = new SessionManager({
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
    eagDynamicSuggester: createStubSuggester({
      type: "direct_chat",
      reasoning: "普通对话",
    }),
  });

  const sessionId = await manager.createSession({ text: "" });

  // 用户输入"保存到文档"
  await manager.handleUserPrompt({ text: "保存到文档" });

  // 获取所有会话消息
  const messages = manager.listSessionMessages(sessionId);

  // 统计 content === "保存到文档" 的用户消息数量
  const userMessages = messages.filter((msg: SessionMessage) => msg.role === "user" && msg.content === "保存到文档");

  assert.equal(userMessages.length, 1, `用户消息"保存到文档"应只追加一次，实际追加 ${userMessages.length} 次`);
});

test("ask_clarification 场景下 LLM 主对话不被调用", async () => {
  // 场景：用户输入"我要做一个订单系统"，suggester 返回 ask_clarification，
  // replySession 应直接返回（不调用 activateSession / LLM 主对话）
  const workspace = createTempDir("deepcode-eag-clarify-workspace-");
  const home = createTempDir("deepcode-eag-clarify-home-");
  setHomeDir(home);

  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("不应被调用");

  const manager = new SessionManager({
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
    eagDynamicSuggester: createStubSuggester({
      type: "ask_clarification",
      messageToUser: "请问您需要哪种技术栈？",
      reasoning: "需要澄清技术栈",
      question: "请问您需要哪种技术栈？",
      options: [
        { id: "react", label: "React" },
        { id: "vue", label: "Vue" },
      ],
      multiSelect: false,
    }),
  });

  const sessionId = await manager.createSession({ text: "" });
  const createCallCount = callCount.value;

  // 用户输入"我要做一个订单系统"
  await manager.handleUserPrompt({ text: "我要做一个订单系统" });

  // 核心断言：ask_clarification 场景下 LLM 主对话不应被调用
  assert.equal(callCount.value, createCallCount, "ask_clarification 场景下 LLM 主对话不应被调用");

  // 验证会话状态为 completed（ask_clarification 设置为 completed）
  const session = manager.getSession(sessionId);
  assert.equal(session?.status, "completed", "ask_clarification 后会话应为 completed 状态");
});

test("suggest_command 场景下 LLM 主对话不被调用", async () => {
  // 场景：用户输入"设计微服务架构"，suggester 返回 suggest_command，
  // replySession 应直接返回（不调用 activateSession / LLM 主对话）
  const workspace = createTempDir("deepcode-eag-suggest-cmd-workspace-");
  const home = createTempDir("deepcode-eag-suggest-cmd-home-");
  setHomeDir(home);

  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("不应被调用");

  const manager = new SessionManager({
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
    eagDynamicSuggester: createStubSuggester({
      type: "suggest_command",
      commandCategory: "team" as any,
      commandId: "team-dispatch",
      commandHint: "/team dispatch",
      messageToUser: "建议使用 /team dispatch 分派任务",
      reasoning: "用户需要架构设计，建议分派给架构师",
    }),
  });

  const sessionId = await manager.createSession({ text: "" });
  const createCallCount = callCount.value;

  // 用户输入"设计微服务架构"
  await manager.handleUserPrompt({ text: "设计微服务架构" });

  // 核心断言：suggest_command 场景下 LLM 主对话不应被调用
  assert.equal(callCount.value, createCallCount, "suggest_command 场景下 LLM 主对话不应被调用");

  // 验证会话状态为 completed
  const session = manager.getSession(sessionId);
  assert.equal(session?.status, "completed", "suggest_command 后会话应为 completed 状态");
});

test("suggester 异常时 replySession 降级为 LLM 主对话", async () => {
  // 场景：suggester.suggest() 抛出异常，replySession 应降级为 LLM 主对话
  // 验证异常安全降级：handleEagDynamicSuggestion catch 返回 false，replySession 继续主对话
  const workspace = createTempDir("deepcode-eag-exception-workspace-");
  const home = createTempDir("deepcode-eag-exception-home-");
  setHomeDir(home);

  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("降级回复");

  // 创建会抛异常的 suggester stub
  const exceptionSuggester = {
    isEnabled: () => true,
    suggest: async () => {
      throw new Error("LLM 决策调用失败");
    },
  } as unknown as EagDynamicSuggester;

  const manager = new SessionManager({
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
    eagDynamicSuggester: exceptionSuggester,
  });

  const sessionId = await manager.createSession({ text: "" });
  const createCallCount = callCount.value;

  // 用户输入"任意内容"，suggester 抛异常
  await manager.handleUserPrompt({ text: "帮我分析代码" });

  // 核心断言：suggester 异常时 LLM 主对话应被调用（降级处理）
  assert.ok(
    callCount.value > createCallCount,
    `suggester 异常时 LLM 主对话应被调用（降级），但 callCount 未增加（createSession=${createCallCount}, total=${callCount.value}）`
  );

  // 验证会话状态为 completed
  const session = manager.getSession(sessionId);
  assert.equal(session?.status, "completed", "异常降级后会话应为 completed 状态");
});
