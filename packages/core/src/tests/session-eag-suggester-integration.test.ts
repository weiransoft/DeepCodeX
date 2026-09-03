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

// ============================================================================
// F8（2026-09-04）：建议层门禁豁免——反建议循环
// 铁证：建议文本只走 UI 不持久化（jsonl 无建议消息）、建议器调用独立计数（total_reqs 停在 5）、
// entry 在答案写入后仅 4ms 置 completed（建议器路径特征）——"建议执行 /xxx"不是主模型发的，
// 而是 EAG 建议器拦截了不该拦截的输入。F4/F6/F7 修复全部打偏（约束错了对象 / 检查错了字段）。
// 本组测试锁定三类豁免：bypass 标记 / AskUserQuestion 答案 / 权限回复。
// ============================================================================

/** 建议器拦截时的固定建议（suggest_command，模拟"建议执行 /team dispatch"死文字） */
function createInterceptingSuggestion(): EagDynamicSuggestion {
  return {
    type: "suggest_command",
    commandCategory: "team" as any,
    commandId: "team-dispatch",
    commandHint: "/team dispatch",
    messageToUser: "建议执行 /team dispatch 分派任务",
    reasoning: "拦截测试",
  };
}

/**
 * 构造带调用计数的 suggester stub
 *
 * 按调用次序返回预设建议序列（超出序列后重复最后一项），
 * suggestCalls.value 用于断言建议器是否被（错误地）调用。
 */
function createCountingSuggester(suggestions: EagDynamicSuggestion[]): {
  suggester: EagDynamicSuggester;
  suggestCalls: { value: number };
} {
  const suggestCalls = { value: 0 };
  const suggester = {
    isEnabled: () => true,
    suggest: async () => {
      const suggestion = suggestions[Math.min(suggestCalls.value, suggestions.length - 1)];
      suggestCalls.value++;
      return suggestion;
    },
  } as unknown as EagDynamicSuggester;
  return { suggester, suggestCalls };
}

/**
 * 构造按响应队列工作的 LLM client 桩（支持 tool_calls / 文本混合响应）
 *
 * 技能匹配请求返回空响应避免干扰；其余请求按顺序出队。
 */
function isSkillMatchingRequest(request: any): boolean {
  return request?.response_format?.type === "json_object";
}

function createQueuedClient(responses: unknown[]): { client: unknown; callCount: { value: number } } {
  const queue = [...responses];
  const callCount = { value: 0 };
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          callCount.value++;
          if (isSkillMatchingRequest(request)) {
            return {
              choices: [{ message: { content: "" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            };
          }
          const response = queue.shift();
          assert.ok(response, "expected a queued chat response");
          return response;
        },
      },
    },
  };
  return { client, callCount };
}

test("F8: bypassEagSuggestion 标记使输入跳过建议器直达主对话", async () => {
  // 场景：/review NL 任务转换后的结构化提示带 bypass 标记重入。
  // 建议器始终返回 suggest_command（模拟拦截一切的结构化文本）：
  // 不带标记的输入被拦截（对照组，证明 stub 有效），带标记的输入必须直达主对话。
  const workspace = createTempDir("deepcode-eag-bypass-workspace-");
  const home = createTempDir("deepcode-eag-bypass-home-");
  setHomeDir(home);

  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("已按结构化任务开始审查代码。");
  const { suggester, suggestCalls } = createCountingSuggester([createInterceptingSuggestion()]);

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
    eagDynamicSuggester: suggester,
  });

  const sessionId = await manager.createSession({ text: "" });
  const createCallCount = callCount.value;

  // 对照组：不带 bypass 标记 → 被建议器拦截，主对话不调用
  await manager.handleUserPrompt({ text: "/review 审查全部代码（未带标记的对照输入）" });
  assert.equal(callCount.value, createCallCount, "不带 bypass 标记时输入应被建议器拦截");
  assert.equal(suggestCalls.value, 1, "对照组建议器应被调用 1 次");

  // 实验组：带 bypassEagSuggestion 标记 → 直达主对话
  await manager.handleUserPrompt({ text: "结构化审查任务提示（带 bypass 标记）", bypassEagSuggestion: true });
  assert.ok(
    callCount.value > createCallCount,
    `带 bypass 标记时 LLM 主对话应被调用（createCallCount=${createCallCount}, total=${callCount.value}）`
  );
  assert.equal(suggestCalls.value, 1, "带 bypass 标记时建议器不应被再次调用");
  assert.equal(manager.getSession(sessionId)?.status, "completed", "bypass 输入完成后会话应为 completed");
});

test("F8: AskUserQuestion 答案豁免建议器直达主对话", async () => {
  // 场景：主模型（第一轮 LLM）调用 AskUserQuestion 向用户提问 → turn 以 waiting_for_user 结束
  // → 用户的答案必须交还主模型继续任务，严禁被建议器拦截为"建议执行 /xxx"。
  // suggester 第一轮放行（direct_chat），之后若被调用则拦截——F8 生效时答案不应触发第二次调用。
  const workspace = createTempDir("deepcode-eag-askanswer-workspace-");
  const home = createTempDir("deepcode-eag-askanswer-home-");
  setHomeDir(home);

  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createQueuedClient([
    // createSession({text:""}) 也会发起一次主对话 LLM 调用（消耗一个响应）
    { choices: [{ message: { content: "" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    // 第一轮：主模型发起 AskUserQuestion 工具调用
    {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call-ask",
                type: "function",
                function: {
                  name: "AskUserQuestion",
                  arguments: JSON.stringify({
                    questions: [{ question: "选择哪种方案？", options: [{ label: "方案A" }, { label: "方案B" }] }],
                  }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    // 第二轮：答案到达后主模型继续任务
    {
      choices: [{ message: { content: "收到答案，按方案A继续执行。" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]);
  const { suggester, suggestCalls } = createCountingSuggester([
    { type: "direct_chat", reasoning: "首轮放行" },
    createInterceptingSuggestion(),
  ]);

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
    eagDynamicSuggester: suggester,
  });

  const sessionId = await manager.createSession({ text: "" });
  const createCallCount = callCount.value;

  // 第一轮：用户输入触发主模型提问
  await manager.handleUserPrompt({ text: "帮我实现功能，先问我选哪种方案" });
  assert.equal(suggestCalls.value, 1, "第一轮输入建议器应放行（direct_chat）");
  assert.equal(manager.getSession(sessionId)?.status, "waiting_for_user", "主模型提问后 turn 应挂起等待答案");

  // 第二轮：用户答案——F8 豁免生效，直达主对话
  await manager.handleUserPrompt({ text: "方案A" });
  assert.equal(suggestCalls.value, 1, "答案严禁触发建议器（应保持 1 次调用）");
  assert.ok(
    callCount.value > createCallCount + 1,
    `答案必须交还主模型继续任务（createCallCount=${createCallCount}, total=${callCount.value}）`
  );
  assert.equal(manager.getSession(sessionId)?.status, "completed", "答案处理完成后会话应为 completed");
});

test("F8: 权限回复豁免建议器直达主对话", async () => {
  // 场景：主模型发起需要授权的工具调用（bash + read-in-cwd → ask_permission 挂起）→
  // 用户批准回复（带 permissions）必须直达主对话继续工具执行，严禁被建议器拦截。
  // L2406 的 hasTrailingPendingToolCalls 直达路径最终也会落到建议层门禁，必须同样放行。
  const workspace = createTempDir("deepcode-eag-permreply-workspace-");
  const home = createTempDir("deepcode-eag-permreply-home-");
  setHomeDir(home);

  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createQueuedClient([
    // createSession({text:""}) 也会发起一次主对话 LLM 调用（消耗一个响应）
    { choices: [{ message: { content: "" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    // 第一轮：主模型发起 bash 工具调用（read-in-cwd 需要授权）
    {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call-bash",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command: "echo perm-reply-test",
                    description: "Echo test",
                    sideEffects: ["read-in-cwd"],
                  }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    // 第二轮：授权后主模型继续任务
    {
      choices: [{ message: { content: "工具已执行，任务继续。" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]);
  const { suggester, suggestCalls } = createCountingSuggester([
    { type: "direct_chat", reasoning: "首轮放行" },
    createInterceptingSuggestion(),
  ]);

  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({
      model: "test-model",
      permissions: { allow: [], deny: [], ask: ["read-in-cwd"], defaultMode: "allowAll" as const },
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    eagDynamicSuggester: suggester,
  });

  const sessionId = await manager.createSession({ text: "" });
  const createCallCount = callCount.value;

  // 第一轮：主模型发起工具调用 → ask_permission 挂起
  await manager.handleUserPrompt({ text: "请运行 echo 命令" });
  assert.equal(suggestCalls.value, 1, "第一轮输入建议器应放行（direct_chat）");
  assert.equal(manager.getSession(sessionId)?.status, "ask_permission", "需要授权的工具调用应挂起等待批准");

  // 第二轮：权限批准回复（带 permissions 字段）——F8 豁免生效，直达主对话
  await manager.replySession(sessionId, {
    text: "批准执行",
    permissions: [{ toolCallId: "call-bash", permission: "allow" as const }],
  });
  assert.equal(suggestCalls.value, 1, "权限回复严禁触发建议器（应保持 1 次调用）");
  assert.ok(
    callCount.value > createCallCount + 1,
    `权限回复必须交还主模型继续任务（createCallCount=${createCallCount}, total=${callCount.value}）`
  );
  assert.equal(manager.getSession(sessionId)?.status, "completed", "权限回复处理完成后会话应为 completed");
});
