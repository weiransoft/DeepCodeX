/**
 * SessionManager V2 上下文钩子集成测试
 *
 * 验证 `SessionManager.handleUserPrompt` 在 turn 入口调用
 * `contextHook.refreshContextAsync(sessionId)`，将 V2 上下文缓存刷新
 * 接入主对话循环（repair-plan.md §3.1）。
 *
 * 测试范围：
 * - T1. handleUserPrompt 创建新会话后调用 refreshContextAsync
 * - T2. handleUserPrompt 回复已有会话后调用 refreshContextAsync
 * - T3. 未注入 contextHook 时 handleUserPrompt 不抛错（零回归）
 * - T4. refreshContextAsync 异常不阻塞主对话流程（降级无注入）
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock：使用真实 SessionManager + 桩 LLM 客户端 + 内存级 contextHook
 * - 通过记录 refreshContextAsync 调用参数进行断言
 *
 * @module core/tests/session-v2-context-hook
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../session";
import type { SessionContextHook, ContextSnippet } from "../v2/integration/session-hook";
import {
  createSessionTestEnv,
  createTempDir,
  createChatResponse,
  createSkillMatchingResponse,
} from "./fixtures/session-test-env";

// 每个测试文件持有独立的 env 实例，避免跨文件全局状态污染
const env = createSessionTestEnv();

afterEach(() => {
  env.cleanup();
});

/**
 * 构造一个记录 refreshContextAsync 调用的内存级 context hook
 *
 * @param options.behavior 控制 refreshContextAsync 行为："resolve" / "reject" / "noop"
 * @returns SessionContextHook 实例与调用记录
 */
function createRecordingContextHook(behavior: "resolve" | "reject" | "noop" = "resolve"): {
  hook: SessionContextHook;
  calls: Array<{ sessionId: string }>;
} {
  const calls: Array<{ sessionId: string }> = [];
  const snippets: Record<string, ContextSnippet[]> = {};

  return {
    hook: {
      preBuildContext(messages) {
        const sessionId = messages[0]?.sessionId;
        if (!sessionId) return [];
        return snippets[sessionId] ?? [];
      },
      async refreshContextAsync(sessionId: string) {
        calls.push({ sessionId });
        if (behavior === "reject") {
          throw new Error("intentional refresh failure");
        }
        if (behavior === "resolve") {
          snippets[sessionId] = [{ type: "test", content: "test context snippet", source: "test" }];
        }
      },
    },
    calls,
  };
}

/**
 * 构造一个带桩 LLM 客户端的 SessionManager，用于测试 handleUserPrompt 主对话流
 *
 * @param projectRoot 项目根目录
 * @param contextHook V2 上下文钩子（可选）
 * @returns SessionManager 实例
 */
function createSessionManagerWithStubClient(projectRoot: string, contextHook?: SessionContextHook): SessionManager {
  const responses: unknown[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          // 技能匹配请求路径，返回空技能列表
          if (request?.response_format?.type === "json_object") {
            return createSkillMatchingResponse([]);
          }
          const response = responses.shift();
          if (response === undefined) {
            // 默认返回一条普通 assistant 回复
            return createChatResponse("assistant reply", { prompt_tokens: 10, completion_tokens: 5 });
          }
          return response;
        },
      },
    },
  };

  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    ...(contextHook ? { contextHook } : {}),
  });
}

test("T1: handleUserPrompt 创建新会话后调用 refreshContextAsync", async () => {
  const projectRoot = createTempDir(env, "deepcode-v2-context-hook-");
  const { hook, calls } = createRecordingContextHook();
  const manager = createSessionManagerWithStubClient(projectRoot, hook);

  await manager.handleUserPrompt({ text: "hello", images: [] });

  assert.equal(calls.length, 1, "应调用一次 refreshContextAsync");
  assert.ok(calls[0]?.sessionId, "应使用有效 sessionId 调用");
  assert.equal(calls[0]?.sessionId, manager.getActiveSessionId(), "sessionId 应与当前活动会话一致");
});

test("T2: handleUserPrompt 回复已有会话后调用 refreshContextAsync", async () => {
  const projectRoot = createTempDir(env, "deepcode-v2-context-hook-");
  const { hook, calls } = createRecordingContextHook();
  const manager = createSessionManagerWithStubClient(projectRoot, hook);

  // 第一次调用创建会话
  await manager.handleUserPrompt({ text: "hello", images: [] });
  assert.equal(calls.length, 1);
  const firstSessionId = calls[0]?.sessionId;

  // 第二次调用回复同一会话
  calls.length = 0;
  await manager.handleUserPrompt({ text: "follow up", images: [] });

  assert.equal(calls.length, 1, "回复会话后应再次调用 refreshContextAsync");
  assert.equal(calls[0]?.sessionId, firstSessionId, "应使用同一个 sessionId");
});

test("T3: 未注入 contextHook 时 handleUserPrompt 不抛错（零回归）", async () => {
  const projectRoot = createTempDir(env, "deepcode-v2-context-hook-");
  const manager = createSessionManagerWithStubClient(projectRoot);

  await assert.doesNotReject(async () => {
    await manager.handleUserPrompt({ text: "hello without context hook", images: [] });
  }, "未注入 contextHook 时主对话流程应保持正常");
});

test("T4: refreshContextAsync 异常不阻塞主对话流程（降级无注入）", async () => {
  const projectRoot = createTempDir(env, "deepcode-v2-context-hook-");
  const { hook, calls } = createRecordingContextHook("reject");
  const manager = createSessionManagerWithStubClient(projectRoot, hook);

  await assert.doesNotReject(async () => {
    await manager.handleUserPrompt({ text: "hello with failing context hook", images: [] });
  }, "contextHook.refreshContextAsync 抛错不应阻塞主对话");

  assert.equal(calls.length, 1, "即使 refreshContextAsync 失败，也应被调用一次");
});
