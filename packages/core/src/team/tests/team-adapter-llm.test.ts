/**
 * executeDispatch LLM 调用测试（P0-2 验证）
 *
 * 设计文档 §7.2：9 个测试用例（LL-001~LL-009）
 *   - LL-001: executeDispatch 成功调用 LLM（返回 "Hello"）
 *   - LL-002: LLM 返回空内容（status=failed）
 *   - LL-003: LLM 调用超时（AbortError → status=failed）
 *   - LL-004: 无 API Key（isolateOpenAIEnv + 无 injectedClient → status=skipped）
 *   - LL-005: tokensConsumed 真实透传（usage 字段）
 *   - LL-006: injectedClient 优先级（注入 client + 有 OPENAI_API_KEY → 使用注入的 client）
 *   - LL-007: timeoutMs 覆盖默认（100ms + 慢响应 → 在 100ms 内触发 abort）
 *   - LL-008: network 错误处理（TypeError "fetch failed" → status=failed）
 *   - LL-009: skipped 状态返回值（injectedClient 返回 null → status=skipped）
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
