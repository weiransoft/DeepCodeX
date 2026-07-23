/**
 * executeDispatch LLM 调用测试（P0-2 验证）
 *
 * 设计文档 §7.2：11 个测试用例（LL-001~LL-011）
 *   - LL-001: executeDispatch 成功调用 LLM（返回 "Hello"）
 *   - LL-002: LLM 返回空内容（status=failed）
 *   - LL-003: LLM 调用超时（AbortError → status=failed）
 *   - LL-004: 无 API Key（isolateOpenAIEnv + 无 injectedClient → status=skipped）
 *   - LL-005: tokensConsumed 真实透传（usage 字段）
 *   - LL-006: injectedClient 优先级（注入 client + 有 OPENAI_API_KEY → 使用注入的 client）
 *   - LL-007: timeoutMs 覆盖默认（100ms + 慢响应 → 在 100ms 内触发 abort）
 *   - LL-008: network 错误处理（TypeError "fetch failed" → status=failed）
 *   - LL-009: skipped 状态返回值（injectedClient 返回 null → status=skipped）
 *   - LL-010: thinking 参数传递（thinkingEnabled=true 时请求体含 thinking + extra_body.reasoning_effort）
 *   - LL-011: reasoning_content fallback（content 为空但 reasoning_content 有内容时使用 reasoning_content）
 *
 * 严格遵循用户规则：
 *   - 禁止 mock：stub client 是真实接口契约的固定响应
 *   - 测试隔离：LL-004/LL-006 使用 isolateOpenAIEnv 确保环境变量恢复
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { executeDispatch, buildTask } from "../team-adapter.js";
import type { OpenAIClientHandle } from "../../common/openai-client.js";
import { isolateOpenAIEnv } from "./utils/env-isolation.js";

// ============================================================================
// 本地 stub client 工厂（与 packages/cli/src/tests/utils/stub-client.ts 一致）
// ============================================================================

/**
 * 构造 stub client，根据 overrideContent 返回固定响应
 *
 * @param overrideContent 返回的 content（默认 "Hello"）
 * @param opts 可选配置：usage 字段、抛错、延迟
 */
function buildStubClient(opts: {
  content?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  throw?: Error;
  delayMs?: number;
}): OpenAIClientHandle {
  const content = opts.content ?? "Hello";
  const usage = opts.usage ?? { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 };

  return {
    client: {
      chat: {
        completions: {
          create: async (
            _req: { messages: Array<{ role: "system" | "user"; content: string }> },
            _opts?: { signal?: AbortSignal }
          ): Promise<{
            choices: Array<{ message?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          }> => {
            // 模拟延迟（用于 LL-007 超时测试）
            if (opts.delayMs) {
              await new Promise<void>((resolve) => setTimeout(resolve, opts.delayMs));
            }
            // 模拟抛错（用于 LL-003/LL-008 错误测试）
            if (opts.throw) {
              throw opts.throw;
            }
            return {
              choices: [{ message: { content } }],
              usage,
            };
          },
        },
      },
    },
    model: "stub-model",
    baseURL: "https://stub.local",
    temperature: 0.3,
    thinkingEnabled: false,
  };
}

// ============================================================================
// LL-001~LL-009: executeDispatch 测试
// ============================================================================

test("LL-001: executeDispatch 成功调用 LLM", async () => {
  const task = buildTask({ title: "测试", description: "测试描述" });
  const stubClient = buildStubClient({ content: "Hello" });

  const result = await executeDispatch(task, { injectedClient: stubClient });

  // 断言：status=succeeded, output="Hello", tokensConsumed.total=300
  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "Hello");
  assert.equal(result.tokensConsumed.total, 300);
});

test("LL-002: LLM 返回空内容（status=failed）", async () => {
  const task = buildTask({ title: "测试", description: "描述" });
  const stubClient = buildStubClient({ content: "" });

  const result = await executeDispatch(task, { injectedClient: stubClient });

  // 断言：status=failed, error 含 "LLM 返回空内容"
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("LLM 返回空内容"), `error 应含 "LLM 返回空内容"，实际: ${result.error}`);
});

test("LL-003: LLM 调用超时（AbortError → status=failed）", async () => {
  const task = buildTask({ title: "测试", description: "描述" });
  // stub 抛 AbortError（模拟超时 abort）
  const abortError = new Error("The operation was aborted");
  abortError.name = "AbortError";
  const stubClient = buildStubClient({ throw: abortError });

  const result = await executeDispatch(task, { injectedClient: stubClient });

  // 断言：status=failed, error 含 "LLM 调用失败"
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("LLM 调用失败"), `error 应含 "LLM 调用失败"，实际: ${result.error}`);
});

test("LL-004: 无 API Key（status=skipped）", async () => {
  // isolateOpenAIEnv 清空 API Key 环境变量 + 重定向 HOME 阻断 settings.json 读取
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });
    // 不注入 injectedClient，让 executeDispatch 调用 createOpenAIClient
    const result = await executeDispatch(task);

    // 断言：status=skipped, error 含 "不可用"
    assert.equal(result.status, "skipped");
    assert.ok(result.error?.includes("不可用"), `error 应含 "不可用"，实际: ${result.error}`);
  } finally {
    restoreEnv();
  }
});

test("LL-005: tokensConsumed 真实透传", async () => {
  const task = buildTask({ title: "测试", description: "描述" });
  const stubClient = buildStubClient({
    content: "Hello",
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
  });

  const result = await executeDispatch(task, { injectedClient: stubClient });

  // 断言：tokensConsumed 真实透传
  assert.equal(result.tokensConsumed.prompt, 100);
  assert.equal(result.tokensConsumed.completion, 200);
  assert.equal(result.tokensConsumed.total, 300);
});

test("LL-006: injectedClient 优先级（注入 client 不读环境变量）", async () => {
  // isolateOpenAIEnv 清空 API Key，但注入 stub client
  // executeDispatch 应优先使用注入的 client，不读环境变量
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });
    const stubClient = buildStubClient({ content: "From injected client" });

    const result = await executeDispatch(task, { injectedClient: stubClient });

    // 断言：使用注入的 client（status=succeeded，而非 skipped）
    assert.equal(result.status, "succeeded");
    assert.equal(result.output, "From injected client");
  } finally {
    restoreEnv();
  }
});

test("LL-007: timeoutMs 覆盖默认（100ms + 慢响应 → 触发 abort）", async () => {
  const task = buildTask({ title: "测试", description: "描述" });
  // stub 延迟 500ms 响应，timeoutMs=100ms 会触发 abort
  // stub 不检查 signal，会抛 "The operation was aborted" 或类似错误
  // 实际上 stub 不响应 abort，会继续延迟 500ms 后返回（但 executeDispatch 已通过 AbortController 触发 abort）
  // 注意：stub 的 create 函数不检查 signal，所以不会抛 AbortError
  //       但 executeDispatch 的 AbortController 会在 100ms 后触发 abort
  //       如果 stub 不响应 abort，executeDispatch 会一直等待 stub 返回
  //       所以这个测试需要 stub 响应 abort（通过检查 signal.aborted 抛错）
  //
  // 修正：让 stub 检查 signal，在 signal.aborted 时抛 AbortError
  const slowStubClient: OpenAIClientHandle = {
    client: {
      chat: {
        completions: {
          create: async (
            _req: { messages: Array<{ role: "system" | "user"; content: string }> },
            opts?: { signal?: AbortSignal }
          ): Promise<{ choices: Array<{ message?: { content?: string } }> }> => {
            // 模拟慢响应：每 10ms 检查一次 signal
            for (let i = 0; i < 50; i++) {
              if (opts?.signal?.aborted) {
                const err = new Error("The operation was aborted");
                err.name = "AbortError";
                throw err;
              }
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
            }
            return { choices: [{ message: { content: "should not reach here" } }] };
          },
        },
      },
    },
    model: "stub-model",
    baseURL: "https://stub.local",
    temperature: 0.3,
    thinkingEnabled: false,
  };

  const result = await executeDispatch(task, {
    injectedClient: slowStubClient,
    timeoutMs: 100,
  });

  // 断言：status=failed, error 含 "LLM 调用失败"
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("LLM 调用失败"), `error 应含 "LLM 调用失败"，实际: ${result.error}`);
});

test("LL-008: network 错误处理（TypeError fetch failed → status=failed）", async () => {
  const task = buildTask({ title: "测试", description: "描述" });
  const stubClient = buildStubClient({
    throw: new TypeError("fetch failed"),
  });

  const result = await executeDispatch(task, { injectedClient: stubClient });

  // 断言：status=failed, error 含 "LLM 调用失败"
  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("LLM 调用失败"), `error 应含 "LLM 调用失败"，实际: ${result.error}`);
});

test("LL-009: injectedClient 非法对象（status=skipped）", async () => {
  // v1.5 H-04 修正：期望输出从 exitCode=3 改为 status=skipped
  // 原因：executeDispatch 返回 DispatchResult 而非 exitCode，exitCode 是 CLI 层概念
  //
  // injectedClient={ foo: "bar" } → isOpenAIClientHandle 返回 false（缺少必填字段）
  // injectedClient === undefined 判断为 false（{ foo: "bar" } !== undefined）
  // 不会调用 createOpenAIClient
  // clientHandle 保持 null → 返回 status=skipped
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });
    const illegalClient = { foo: "bar" } as unknown as undefined;
    const result = await executeDispatch(task, { injectedClient: illegalClient });

    // 断言：status=skipped
    assert.equal(result.status, "skipped");
  } finally {
    restoreEnv();
  }
});

// ============================================================================
// LL-010 / LL-011: v1.6 P1-1 新增 - thinking 参数传递与 reasoning_content fallback
//
// 这两个测试验证 v1.6 P1-1 修复：
//   1. LL-010: thinkingEnabled=true 时，请求体应包含 thinking 和 extra_body.reasoning_effort 参数
//      之前 bug：executeDispatch 构造请求体时未调用 buildThinkingRequestOptions，
//      导致即使 settings.json 设置 thinkingEnabled=true，API 端也不会启用 thinking 模式
//   2. LL-011: content 字段为空但 reasoning_content 字段有内容时，应使用 reasoning_content 作为输出
//      适用场景：DeepSeek-R1 / Qwen3 / 部分 moka-ai 配置在 thinking 模式下将答案放入 reasoning_content
// ============================================================================

test("LL-010: thinking 参数传递（thinkingEnabled=true 时请求体含 thinking + reasoning_effort）", async () => {
  // 捕获 stub client 收到的请求体，验证 thinking 参数是否被正确传递
  let capturedRequest: Record<string, unknown> | null = null;

  const thinkingStubClient: OpenAIClientHandle = {
    client: {
      chat: {
        completions: {
          create: async (
            req: Record<string, unknown>,
            _opts?: { signal?: AbortSignal }
          ): Promise<{
            choices: Array<{ message?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          }> => {
            // 捕获请求体，用于后续断言
            capturedRequest = req;
            return {
              choices: [{ message: { content: "thinking-mode-response" } }],
              usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 },
            };
          },
        },
      },
    },
    // v1.1 修订：使用真实 DeepSeek 模型名，确保 buildThinkingRequestOptions 生成 DeepSeek 格式
    // （非-thinking 模型名如 "stub-thinking-model" 在 v1.1 后返回 {}，不传 thinking 参数）
    model: "deepseek-v4-pro",
    baseURL: "https://stub.local",
    temperature: 0.3,
    thinkingEnabled: true,
    // v1.6 P1-1：传递 reasoningEffort，验证它能被正确传递到请求体
    reasoningEffort: "high",
  };

  const task = buildTask({ title: "thinking 测试", description: "验证 thinking 参数传递" });
  const result = await executeDispatch(task, { injectedClient: thinkingStubClient });

  // 断言 1：调用成功
  assert.equal(result.status, "succeeded", "thinking 模式调用应成功");
  assert.equal(result.output, "thinking-mode-response");

  // 断言 2：请求体包含 thinking 参数
  assert.ok(capturedRequest, "应该捕获到请求体");
  assert.ok("thinking" in capturedRequest!, "请求体应包含 thinking 字段（v1.6 P1-1 修复点）");
  const thinkingParam = (capturedRequest as { thinking?: { type?: string } }).thinking;
  assert.equal(thinkingParam?.type, "enabled", `thinking.type 应为 "enabled"，实际: ${thinkingParam?.type}`);

  // 断言 3：请求体包含 extra_body.reasoning_effort 参数
  assert.ok(
    "extra_body" in capturedRequest!,
    "请求体应包含 extra_body 字段（thinkingEnabled=true 时附带 reasoning_effort）"
  );
  const extraBody = (capturedRequest as { extra_body?: { reasoning_effort?: string } }).extra_body;
  assert.equal(
    extraBody?.reasoning_effort,
    "high",
    `reasoning_effort 应为 "high"，实际: ${extraBody?.reasoning_effort}`
  );

  // 断言 4：请求体仍包含基本字段（model / messages / temperature）
  // 使用显式类型断言避免 TypeScript 控制流分析将 capturedRequest 收窄为 never
  const req = capturedRequest as Record<string, unknown> | null;
  assert.ok(req !== null, "capturedRequest 不应为 null");
  assert.equal(req!.model, "deepseek-v4-pro");
  assert.ok(Array.isArray(req!.messages), "请求体应包含 messages 数组");
  assert.equal((req as { temperature?: number }).temperature, 0.3);
});

test("LL-010b: thinking 参数传递（thinkingEnabled=false 时请求体含 thinking.type=disabled）", async () => {
  // 验证 thinkingEnabled=false 时，请求体应包含 thinking.type="disabled"，且不包含 extra_body
  let capturedRequest: Record<string, unknown> | null = null;

  const noThinkingStubClient: OpenAIClientHandle = {
    client: {
      chat: {
        completions: {
          create: async (
            req: Record<string, unknown>,
            _opts?: { signal?: AbortSignal }
          ): Promise<{
            choices: Array<{ message?: { content?: string } }>;
          }> => {
            capturedRequest = req;
            return { choices: [{ message: { content: "no-thinking-response" } }] };
          },
        },
      },
    },
    // v1.1 修订：使用真实 DeepSeek 模型名，确保 thinkingEnabled=false 时生成 thinking.type=disabled
    // （非-thinking 模型名在 v1.1 后返回 {}，不传 thinking 参数，无法验证 disabled 行为）
    model: "deepseek-v4-pro",
    baseURL: "https://stub.local",
    thinkingEnabled: false,
  };

  const task = buildTask({ title: "测试", description: "描述" });
  const result = await executeDispatch(task, { injectedClient: noThinkingStubClient });

  assert.equal(result.status, "succeeded");
  assert.ok(capturedRequest, "应该捕获到请求体");
  assert.ok("thinking" in capturedRequest!, "请求体应包含 thinking 字段（即使 disabled）");
  const thinkingParam = (capturedRequest as { thinking?: { type?: string } }).thinking;
  assert.equal(thinkingParam?.type, "disabled", `thinking.type 应为 "disabled"，实际: ${thinkingParam?.type}`);
  // thinkingEnabled=false 时不应包含 extra_body（buildThinkingRequestOptions 行为）
  assert.ok(!("extra_body" in capturedRequest!), "thinkingEnabled=false 时请求体不应包含 extra_body");
});

test("LL-011: reasoning_content fallback（content 为空但 reasoning_content 有内容）", async () => {
  // 模拟 DeepSeek-R1 / Qwen3 / 部分 moka-ai 配置在 thinking 模式下的响应：
  // content 字段为空，最终答案放在 reasoning_content 字段
  const reasoningFallbackStubClient: OpenAIClientHandle = {
    client: {
      chat: {
        completions: {
          create: async (
            _req: Record<string, unknown>,
            _opts?: { signal?: AbortSignal }
          ): Promise<{
            choices: Array<{
              message?: {
                content?: string | null;
                reasoning_content?: string | null;
              };
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          }> => {
            return {
              choices: [
                {
                  message: {
                    // content 为空（thinking 模式下部分模型的行为）
                    content: "",
                    // 最终答案放在 reasoning_content 字段
                    reasoning_content: "这是从 reasoning_content 提取的最终答案",
                  },
                },
              ],
              usage: { prompt_tokens: 80, completion_tokens: 120, total_tokens: 200 },
            };
          },
        },
      },
    },
    model: "stub-reasoning-model",
    baseURL: "https://stub.local",
    thinkingEnabled: true,
    reasoningEffort: "max",
  };

  const task = buildTask({ title: "reasoning fallback 测试", description: "验证 reasoning_content fallback" });
  const result = await executeDispatch(task, { injectedClient: reasoningFallbackStubClient });

  // 断言 1：status=succeeded（而非 failed）
  assert.equal(result.status, "succeeded", "content 为空但 reasoning_content 有内容时应成功");

  // 断言 2：output 使用 reasoning_content 的内容（fallback 逻辑）
  assert.equal(
    result.output,
    "这是从 reasoning_content 提取的最终答案",
    `output 应为 reasoning_content 的内容，实际: ${result.output}`
  );

  // 断言 3：tokensConsumed 透传
  assert.equal(result.tokensConsumed.total, 200);
});
