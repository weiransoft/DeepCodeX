/**
 * executeDispatch 输出截断检测与自动续写测试（v2.1.3 验证）
 *
 * 设计文档 §6.1：15 个测试用例（TC-CONT-01 ~ TC-CONT-15）
 *   - TC-CONT-01: finish_reason="stop" 不触发续写（continueCount=0, isPartial=false）
 *   - TC-CONT-02: finish_reason="length" 触发续写（第一次 length，第二次 stop）
 *   - TC-CONT-03: 达到最大续写次数（始终 length → continueCount=3, isPartial=true）
 *   - TC-CONT-04: 续写 API 错误（第二次抛异常 → continueCount=1, isPartial=true）
 *   - TC-CONT-05: 续写返回空内容·length 触发（第二次 content="" → continueCount=1, isPartial=true）
 *   - TC-CONT-06: maxContinueCount=0 禁用续写（length → continueCount=0, isPartial=true）
 *   - TC-CONT-07: 续写内容拼接正确性（"part1" + "part2" = "part1part2"）
 *   - TC-CONT-08: token 用量累加（两次各 100 tokens → total=200）
 *   - TC-CONT-09: 续写消息包含完整上下文（system+user+assistant+user 4 条）
 *   - TC-CONT-10: finish_reason=stop + 继续关键字触发续写（v1.1）
 *   - TC-CONT-11: finish_reason=stop + 无继续关键字不触发续写（v1.1）
 *   - TC-CONT-12: 继续关键字在正文中间不触发续写（v1.1）
 *   - TC-CONT-13: stop+关键字触发 + 续写返回空内容（isPartial=false，token 计入）
 *   - TC-CONT-14: 短续写块（<200 字符）不误触发续写（v1.3 ARCH-08 回归）
 *   - TC-CONT-15: maxContinueCount=1 + stop+关键字 + 空续写（v1.3 ARCH-09 回归）
 *
 * 严格遵循用户规则：
 *   - 禁止 mock：stub client 是真实接口契约的固定响应
 *   - 测试隔离：使用 isolateOpenAIEnv 确保环境变量恢复
 *   - 中文注释，遵循项目代码规范
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { executeDispatch, buildTask } from "../team-adapter.js";
import type { OpenAIClientHandle } from "../../common/openai-client.js";
import { isolateOpenAIEnv } from "./utils/env-isolation.js";

// ============================================================================
// 本地 stub client 工厂（支持 finish_reason + 多次调用返回不同响应）
// ============================================================================

/**
 * 单次 LLM 调用的响应配置
 */
interface StubResponse {
  /** content 字段内容（LLM 输出文本） */
  content?: string;
  /** reasoning_content 字段内容（thinking 模式 fallback） */
  reasoningContent?: string;
  /** finish_reason 字段（stop / length / tool_calls / content_filter） */
  finishReason?: string;
  /** usage 字段（token 用量） */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /** 抛出异常（模拟 API 错误） */
  throw?: Error;
  /** 延迟毫秒数（模拟慢响应） */
  delayMs?: number;
}

/**
 * 构造支持多次调用返回不同响应的 stub client
 *
 * 设计：
 *   - responses 数组按调用顺序消费：第 N 次调用返回 responses[N]
 *   - 超过数组长度的调用返回最后一个 response（防止数组越界）
 *   - 捕获每次调用的 messages，用于断言续写消息构造是否正确
 *
 * @param responses 响应序列（按调用顺序）
 * @returns OpenAIClientHandle + 捕获的调用记录
 */
function buildSequenceStubClient(responses: StubResponse[]): {
  handle: OpenAIClientHandle;
  calls: Array<{ messages: Array<{ role: string; content: string }> }>;
} {
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];

  const handle: OpenAIClientHandle = {
    client: {
      chat: {
        completions: {
          create: async (
            req: { messages: Array<{ role: string; content: string }> },
            _opts?: { signal?: AbortSignal }
          ): Promise<{
            choices: Array<{
              message?: { content?: string | null; reasoning_content?: string | null };
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          }> => {
            // 记录调用信息（用于断言续写消息构造）
            calls.push({
              messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
            });

            // 按 call index 取响应（越界时取最后一个）
            const idx = Math.min(calls.length - 1, responses.length - 1);
            const resp = responses[idx]!;

            // 模拟延迟
            if (resp.delayMs) {
              await new Promise<void>((resolve) => setTimeout(resolve, resp.delayMs));
            }

            // 模拟抛错
            if (resp.throw) {
              throw resp.throw;
            }

            return {
              choices: [
                {
                  message: {
                    content: resp.content ?? "",
                    reasoning_content: resp.reasoningContent,
                  },
                  finish_reason: resp.finishReason ?? "stop",
                },
              ],
              usage: resp.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            };
          },
        },
      },
    },
    model: "stub-continue-model",
    baseURL: "https://stub.local",
    temperature: 0.3,
    thinkingEnabled: false,
  };

  return { handle, calls };
}

// ============================================================================
// TC-CONT-01 ~ TC-CONT-08: 输出截断检测与自动续写测试
// ============================================================================

/**
 * TC-CONT-01: finish_reason="stop" 不触发续写
 *
 * 场景：LLM 正常完成输出（finish_reason="stop"），无需续写
 * 期望：continueCount=0, isPartial=false
 */
test("TC-CONT-01: finish_reason=stop 不触发续写", async () => {
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });
    const { handle, calls } = buildSequenceStubClient([
      {
        content: "完整输出",
        finishReason: "stop",
        usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 },
      },
    ]);

    const result = await executeDispatch(task, { injectedClient: handle });

    // 断言 1：status=succeeded
    assert.equal(result.status, "succeeded", "正常完成应为 succeeded");
    // 断言 2：output 为 stub 返回的完整内容
    assert.equal(result.output, "完整输出");
    // 断言 3：未触发续写
    assert.equal(result.continueCount, 0, "finish_reason=stop 时 continueCount 应为 0");
    // 断言 4：输出完整
    assert.equal(result.isPartial, false, "finish_reason=stop 时 isPartial 应为 false");
    // 断言 5：只调用了一次 LLM
    assert.equal(calls.length, 1, "不应触发续写调用");
  } finally {
    restoreEnv();
  }
});

/**
 * TC-CONT-02: finish_reason="length" 触发续写
 *
 * 场景：第一次调用 finish_reason="length"（被 maxTokens 截断），
 *       第二次调用 finish_reason="stop"（续写完成）
 * 期望：continueCount=1, 内容拼接正确
 */
test("TC-CONT-02: finish_reason=length 触发续写", async () => {
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });
    const { handle, calls } = buildSequenceStubClient([
      {
        content: "前半部分",
        finishReason: "length",
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      },
      {
        content: "后半部分",
        finishReason: "stop",
        usage: { prompt_tokens: 150, completion_tokens: 250, total_tokens: 400 },
      },
    ]);

    const result = await executeDispatch(task, { injectedClient: handle });

    // 断言 1：status=succeeded
    assert.equal(result.status, "succeeded", "续写完成后应为 succeeded");
    // 断言 2：触发了 1 次续写
    assert.equal(result.continueCount, 1, "应触发 1 次续写");
    // 断言 3：输出完整（第二次 finish_reason=stop）
    assert.equal(result.isPartial, false, "续写完成后 isPartial 应为 false");
    // 断言 4：内容正确拼接
    assert.equal(result.output, "前半部分后半部分", "续写内容应直接拼接到已有内容后面");
    // 断言 5：调用了 2 次 LLM（首次 + 1 次续写）
    assert.equal(calls.length, 2, "应调用 2 次 LLM");
    // 断言 6：续写消息包含 assistant 角色（已有部分内容）
    assert.equal(calls[1]!.messages.length, 4, "续写消息应包含 4 条消息");
    assert.equal(calls[1]!.messages[2]!.role, "assistant", "续写消息第 3 条应为 assistant");
    assert.equal(calls[1]!.messages[3]!.role, "user", "续写消息第 4 条应为 user（续写指令）");
  } finally {
    restoreEnv();
  }
});

/**
 * TC-CONT-03: 达到最大续写次数
 *
 * 场景：所有调用都返回 finish_reason="length"，达到 maxContinueCount=3
 * 期望：continueCount=3, isPartial=true
 */
test("TC-CONT-03: 达到最大续写次数", async () => {
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });
    // 4 次响应：首次 + 3 次续写，全部返回 length
    const { handle, calls } = buildSequenceStubClient([
      { content: "part1", finishReason: "length", usage: { total_tokens: 100 } },
      { content: "part2", finishReason: "length", usage: { total_tokens: 100 } },
      { content: "part3", finishReason: "length", usage: { total_tokens: 100 } },
      { content: "part4", finishReason: "length", usage: { total_tokens: 100 } },
    ]);

    const result = await executeDispatch(task, { injectedClient: handle });

    // 断言 1：status=succeeded（虽然 isPartial=true，但不是 failed）
    assert.equal(result.status, "succeeded", "达到最大续写次数仍为 succeeded");
    // 断言 2：触发了 3 次续写（达到上限）
    assert.equal(result.continueCount, 3, "应触发 3 次续写（达到最大值）");
    // 断言 3：输出被标记为部分输出
    assert.equal(result.isPartial, true, "达到最大续写次数时 isPartial 应为 true");
    // 断言 4：error 包含 "最大续写次数" 警告
    assert.ok(result.error?.includes("最大续写次数"), `error 应含 "最大续写次数"，实际: ${result.error}`);
    // 断言 5：内容仍包含所有续写拼接
    assert.equal(result.output, "part1part2part3part4", "应拼接所有续写内容");
    // 断言 6：共调用 4 次 LLM（首次 + 3 次续写）
    assert.equal(calls.length, 4, "应调用 4 次 LLM");
  } finally {
    restoreEnv();
  }
});

/**
 * TC-CONT-04: 续写 API 错误
 *
 * 场景：第一次成功返回 length，第二次（续写）抛异常
 * 期望：continueCount=1, isPartial=true, error 记录失败原因
 *
 * v2.1.3 修正：continueCount 在 try 块开头自增，所以续写失败时 continueCount=1（反映"尝试了 1 次"）
 */
test("TC-CONT-04: 续写 API 错误", async () => {
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });
    const { handle, calls } = buildSequenceStubClient([
      {
        content: "first part",
        finishReason: "length",
        usage: { total_tokens: 100 },
      },
      {
        throw: new TypeError("network error during continuation"),
      },
    ]);

    const result = await executeDispatch(task, { injectedClient: handle });

    // 断言 1：status=succeeded（已有部分输出）
    assert.equal(result.status, "succeeded", "续写失败但有部分输出时仍为 succeeded");
    // 断言 2：尝试了 1 次续写（虽然失败）
    assert.equal(result.continueCount, 1, "应记录 1 次续写尝试");
    // 断言 3：标记为部分输出
    assert.equal(result.isPartial, true, "续写失败时 isPartial 应为 true");
    // 断言 4：error 包含续写失败信息
    assert.ok(
      result.error?.includes("续写") && result.error?.includes("失败"),
      `error 应含 "续写" 和 "失败"，实际: ${result.error}`
    );
    // 断言 5：output 包含首次调用内容
    assert.equal(result.output, "first part", "应保留首次调用的输出");
    // 断言 6：共调用 2 次 LLM
    assert.equal(calls.length, 2, "应调用 2 次 LLM");
  } finally {
    restoreEnv();
  }
});

/**
 * TC-CONT-05: 续写返回空内容（length 截断触发）
 *
 * 场景：第一次返回 length（确定截断），第二次续写返回 content=""
 * 期望：continueCount=1, isPartial=true（确定截断+续写未完成）, error 警告, token 计入
 *
 * v2.1.3 修正：continueCount 在 try 块开头自增，所以续写返回空内容时 continueCount=1
 * 多角色审查 ARCH-01/TEST-02 修正：
 * - length 触发 + 空续写 → 输出确定不完整，isPartial=true（与 types.ts 契约一致）；
 *   stop+关键字触发 + 空续写 → 可能 LLM 主动停止，isPartial=false（见 TC-CONT-13）
 * - 空续写消耗的 token 也必须累加进 tokensConsumed（调用已实际发生）
 */
test("TC-CONT-05: 续写返回空内容（length 触发，isPartial=true）", async () => {
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });
    const { handle, calls } = buildSequenceStubClient([
      {
        content: "partial content",
        finishReason: "length",
        usage: { total_tokens: 100 },
      },
      {
        content: "", // 续写返回空内容
        finishReason: "stop",
        usage: { total_tokens: 50 },
      },
    ]);

    const result = await executeDispatch(task, { injectedClient: handle });

    // 断言 1：status=succeeded
    assert.equal(result.status, "succeeded");
    // 断言 2：尝试了 1 次续写（虽然返回空内容）
    assert.equal(result.continueCount, 1, "应记录 1 次续写尝试");
    // 断言 3：isPartial=true（length 确定截断 + 续写未完成）
    assert.equal(result.isPartial, true, "length 截断 + 空续写时 isPartial 应为 true");
    // 断言 4：error 包含警告信息
    assert.ok(result.error?.includes("空内容"), `error 应含 "空内容" 警告，实际: ${result.error}`);
    // 断言 5：output 保留首次内容
    assert.equal(result.output, "partial content", "应保留首次调用的输出");
    // 断言 6：共调用 2 次 LLM
    assert.equal(calls.length, 2, "应调用 2 次 LLM");
    // 断言 7：空续写消耗的 token 也计入（100 + 50 = 150）
    assert.equal(result.tokensConsumed.total, 150, "空续写的 token 也应计入总量");
  } finally {
    restoreEnv();
  }
});

/**
 * TC-CONT-06: maxContinueCount=0 禁用续写
 *
 * 场景：maxContinueCount=0，LLM 返回 finish_reason="length"
 * 期望：continueCount=0, isPartial=true（截断但未续写）
 */
test("TC-CONT-06: maxContinueCount=0 禁用续写", async () => {
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });
    const { handle, calls } = buildSequenceStubClient([
      {
        content: "truncated content",
        finishReason: "length",
        usage: { total_tokens: 100 },
      },
    ]);

    // 显式禁用续写
    const result = await executeDispatch(task, {
      injectedClient: handle,
      maxContinueCount: 0,
    });

    // 断言 1：status=succeeded
    assert.equal(result.status, "succeeded");
    // 断言 2：未触发续写
    assert.equal(result.continueCount, 0, "maxContinueCount=0 时不应续写");
    // 断言 3：标记为部分输出（finish_reason=length 但未续写）
    assert.equal(result.isPartial, true, "禁用续写且 finish_reason=length 时 isPartial 应为 true");
    // 断言 4：error 包含 "最大续写次数" 警告（达到 0 次）
    assert.ok(result.error?.includes("最大续写次数"), `error 应含 "最大续写次数"，实际: ${result.error}`);
    // 断言 5：只调用了一次 LLM
    assert.equal(calls.length, 1, "应只调用 1 次 LLM");
  } finally {
    restoreEnv();
  }
});

/**
 * TC-CONT-07: 续写内容拼接正确性
 *
 * 场景：第一次返回 "part1" + finish_reason="length"，
 *       第二次返回 "part2" + finish_reason="stop"
 * 期望：output = "part1part2"（直接拼接，无分隔符）
 */
test("TC-CONT-07: 续写内容拼接正确性", async () => {
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });
    const { handle } = buildSequenceStubClient([
      {
        content: "part1",
        finishReason: "length",
        usage: { total_tokens: 50 },
      },
      {
        content: "part2",
        finishReason: "stop",
        usage: { total_tokens: 50 },
      },
    ]);

    const result = await executeDispatch(task, { injectedClient: handle });

    // 断言 1：内容直接拼接（无分隔符）
    assert.equal(result.output, "part1part2", "续写内容应直接拼接，无分隔符");
    // 断言 2：continueCount=1
    assert.equal(result.continueCount, 1);
    // 断言 3：isPartial=false（第二次 finish_reason=stop）
    assert.equal(result.isPartial, false);
  } finally {
    restoreEnv();
  }
});

/**
 * TC-CONT-08: token 用量累加
 *
 * 场景：两次调用各返回 total_tokens=100
 * 期望：tokensConsumed.total = 200（首次 + 续写累加）
 */
test("TC-CONT-08: token 用量累加", async () => {
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });
    const { handle } = buildSequenceStubClient([
      {
        content: "first",
        finishReason: "length",
        usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 },
      },
      {
        content: "second",
        finishReason: "stop",
        usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 },
      },
    ]);

    const result = await executeDispatch(task, { injectedClient: handle });

    // 断言 1：prompt tokens 累加（50 + 60 = 110）
    assert.equal(result.tokensConsumed.prompt, 110, "prompt tokens 应累加");
    // 断言 2：completion tokens 累加（50 + 40 = 90）
    assert.equal(result.tokensConsumed.completion, 90, "completion tokens 应累加");
    // 断言 3：total tokens 累加（100 + 100 = 200）
    assert.equal(result.tokensConsumed.total, 200, "total tokens 应累加");
    // 断言 4：continueCount=1
    assert.equal(result.continueCount, 1);
  } finally {
    restoreEnv();
  }
});

// ============================================================================
// 额外测试：续写消息构造正确性（架构评审 P0-2 验证）
// ============================================================================

/**
 * TC-CONT-09: 续写消息包含完整上下文（system + user + assistant + user）
 *
 * 验证续写请求的消息构造符合 OpenAI Chat Completions 格式：
 *   [system(原始), user(原始), assistant(已有部分), user(续写指令)]
 *
 * 这是架构评审 P0-2 要求：续写时必须保持完整上下文，让 LLM 理解前文
 */
test("TC-CONT-09: 续写消息包含完整上下文（4 条消息）", async () => {
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({
      title: "代码生成任务",
      description: "请生成完整的代码文件",
    });
    const { handle, calls } = buildSequenceStubClient([
      { content: "代码片段A", finishReason: "length", usage: { total_tokens: 100 } },
      { content: "代码片段B", finishReason: "stop", usage: { total_tokens: 100 } },
    ]);

    await executeDispatch(task, { injectedClient: handle });

    // 断言 1：共调用 2 次
    assert.equal(calls.length, 2, "应调用 2 次 LLM");

    // 断言 2：首次调用消息包含 system + user（2 条）
    assert.equal(calls[0]!.messages.length, 2, "首次调用应有 2 条消息");
    assert.equal(calls[0]!.messages[0]!.role, "system");
    assert.equal(calls[0]!.messages[1]!.role, "user");

    // 断言 3：续写调用消息包含 system + user + assistant + user（4 条）
    assert.equal(calls[1]!.messages.length, 4, "续写调用应有 4 条消息");
    assert.equal(calls[1]!.messages[0]!.role, "system", "续写第 1 条应为 system");
    assert.equal(calls[1]!.messages[1]!.role, "user", "续写第 2 条应为 user（原始）");
    assert.equal(calls[1]!.messages[2]!.role, "assistant", "续写第 3 条应为 assistant（已有部分）");
    assert.equal(calls[1]!.messages[3]!.role, "user", "续写第 4 条应为 user（续写指令）");

    // 断言 4：assistant 消息内容为首次调用的完整输出
    assert.equal(calls[1]!.messages[2]!.content, "代码片段A", "assistant 消息应为首次调用的完整输出");

    // 断言 5：续写指令包含 "继续" 关键字
    assert.ok(
      calls[1]!.messages[3]!.content.includes("继续"),
      `续写指令应含 "继续"，实际: ${calls[1]!.messages[3]!.content}`
    );
  } finally {
    restoreEnv();
  }
});

// ============================================================================
// TC-CONT-10 ~ TC-CONT-12: LLM 主动停止+继续关键字检测（v1.1 新增）
// ============================================================================

/**
 * TC-CONT-10: finish_reason="stop" + 继续关键字触发续写
 *
 * 场景：LLM 第一次返回 finish_reason="stop" 但输出末尾含"将继续在下一条消息中完成"，
 *       表示 LLM 主动停止但仍有内容要输出；第二次续写返回 finish_reason="stop" 且
 *       输出末尾无继续关键字，续写完成。
 *
 * 期望：
 *   - continueCount=1（触发 1 次续写）
 *   - isPartial=false（续写后无继续意图）
 *   - output = 第一次内容 + 第二次内容（直接拼接）
 *   - 共调用 2 次 LLM
 *
 * 这是 v1.1 修复的核心场景：实际 E2E 测试中 LLM 输出"由于输出较长,我将继续在下一条消息
 * 中完成商品模块"导致 src/index.ts 缺失，原续写机制仅检测 finish_reason="length" 未触发续写。
 *
 * 测试构造说明：
 *   - 第一次 content 必须 > 200 字符，确保续写拼接后末尾 200 字符落在第二次 content 范围内，
 *     否则 detectContinueIntention 会一直检测到第一次的"将继续"关键字导致无限续写。
 *   - 真实场景中 LLM 输出几千字符代码，续写后末尾 200 字符是续写内容，不含继续关键字，
 *     测试用例需模拟这一真实场景。
 */
test("TC-CONT-10: finish_reason=stop + 继续关键字触发续写", async () => {
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });

    // 第一次：前 250 字符为代码，末尾是继续关键字（模拟真实场景：长代码输出 + 末尾继续声明）
    const firstContent = "a".repeat(250) + "\n\n由于输出较长,我将继续在下一条消息中完成剩余内容";
    // 第二次：续写完成，250 字符代码 + 末尾无继续关键字
    // 长度需 >= 200 字符，确保 fullContent 末尾 200 字符完全落在第二次 content 范围内
    const secondContent = "b".repeat(250) + "\n续写完成";

    const { handle, calls } = buildSequenceStubClient([
      {
        content: firstContent,
        finishReason: "stop",
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      },
      {
        content: secondContent,
        finishReason: "stop",
        usage: { prompt_tokens: 150, completion_tokens: 100, total_tokens: 250 },
      },
    ]);

    const result = await executeDispatch(task, { injectedClient: handle });

    // 断言 1：status=succeeded
    assert.equal(result.status, "succeeded", "续写完成后应为 succeeded");
    // 断言 2：触发 1 次续写（finish_reason=stop + 继续关键字）
    assert.equal(result.continueCount, 1, "应触发 1 次续写");
    // 断言 3：isPartial=false（续写后无继续意图）
    assert.equal(result.isPartial, false, "续写完成后 isPartial 应为 false");
    // 断言 4：output 为两次内容直接拼接
    assert.equal(result.output, firstContent + secondContent, "续写内容应直接拼接到已有内容后面");
    // 断言 5：共调用 2 次 LLM
    assert.equal(calls.length, 2, "应调用 2 次 LLM");
    // 断言 6：续写消息包含 assistant 角色（已有部分内容）
    assert.equal(calls[1]!.messages.length, 4, "续写消息应包含 4 条消息");
    assert.equal(calls[1]!.messages[2]!.role, "assistant", "续写消息第 3 条应为 assistant");
    assert.equal(calls[1]!.messages[3]!.role, "user", "续写消息第 4 条应为 user（续写指令）");
    // 断言 7：续写消息中的 assistant 内容为第一次完整输出
    assert.equal(calls[1]!.messages[2]!.content, firstContent, "assistant 消息应为第一次调用的完整输出");
  } finally {
    restoreEnv();
  }
});

/**
 * TC-CONT-11: finish_reason="stop" + 无继续关键字不触发续写
 *
 * 场景：LLM 正常完成输出（finish_reason="stop"），末尾无任何继续意图关键字
 *
 * 期望：
 *   - continueCount=0（不触发续写）
 *   - isPartial=false（正常完成）
 *   - output = 单次调用内容
 *   - 只调用 1 次 LLM
 */
test("TC-CONT-11: finish_reason=stop + 无继续关键字不触发续写", async () => {
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });
    const { handle, calls } = buildSequenceStubClient([
      {
        // 正常完成：末尾无任何继续关键字
        content: "完整的代码输出，包含所有文件和注释。",
        finishReason: "stop",
        usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 },
      },
    ]);

    const result = await executeDispatch(task, { injectedClient: handle });

    // 断言 1：status=succeeded
    assert.equal(result.status, "succeeded", "正常完成应为 succeeded");
    // 断言 2：未触发续写
    assert.equal(result.continueCount, 0, "无继续关键字时不应触发续写");
    // 断言 3：isPartial=false
    assert.equal(result.isPartial, false, "正常完成时 isPartial 应为 false");
    // 断言 4：output 为单次调用内容
    assert.equal(result.output, "完整的代码输出，包含所有文件和注释。");
    // 断言 5：只调用 1 次 LLM
    assert.equal(calls.length, 1, "不应触发续写调用");
  } finally {
    restoreEnv();
  }
});

/**
 * TC-CONT-12: 继续关键字在正文中间不触发续写
 *
 * 场景：LLM 输出 finish_reason="stop"，内容中含"继续"一词但位于正文中间
 *       （不在末尾 200 字符范围内），属于正文合理使用（如"我们将继续开发其他功能"），
 *       不应误判为继续意图。
 *
 * 期望：
 *   - continueCount=0（不触发续写）
 *   - isPartial=false
 *   - 只调用 1 次 LLM
 *
 * 验证 detectContinueIntention 的"末尾 200 字符"检测范围设计决策：
 *   只检测末尾 200 字符，避免正文中合理使用"继续"一词导致误判。
 */
test("TC-CONT-12: 继续关键字在正文中间不触发续写", async () => {
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });

    // 构造内容：前 100 字符含"继续开发"（正文合理使用），后 250 字符为纯文本
    // 末尾 200 字符内不含任何继续关键字
    const head = "我们将继续开发其他功能，包括用户管理、权限控制等模块。"; // 30 字符，含"继续"
    // 中间填充内容，确保总长度 > 200，使"继续"不在末尾 200 字符内
    const middle = "a".repeat(220);
    // 末尾 200 字符：纯文本，无任何继续关键字
    const tail = "以上是完整的代码实现，所有文件均已包含完整注释。";
    const content = head + middle + tail;

    const { handle, calls } = buildSequenceStubClient([
      {
        content,
        finishReason: "stop",
        usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 },
      },
    ]);

    const result = await executeDispatch(task, { injectedClient: handle });

    // 断言 1：status=succeeded
    assert.equal(result.status, "succeeded", "正常完成应为 succeeded");
    // 断言 2：未触发续写（"继续"在正文中间，不在末尾 200 字符内）
    assert.equal(result.continueCount, 0, "继续关键字在正文中间时不应触发续写");
    // 断言 3：isPartial=false
    assert.equal(result.isPartial, false, "正常完成时 isPartial 应为 false");
    // 断言 4：只调用 1 次 LLM
    assert.equal(calls.length, 1, "不应触发续写调用");
    // 断言 5：output 为完整内容
    assert.equal(result.output, content, "output 应为完整的单次调用内容");
  } finally {
    restoreEnv();
  }
});

/**
 * TC-CONT-13: stop+继续关键字触发续写 + 续写返回空内容（isPartial=false）
 *
 * 场景：第一次 finish_reason="stop" 但末尾含继续关键字（触发续写），
 *       第二次续写返回 content=""（可能为 LLM 主动停止，输出未必截断）
 *
 * 期望（多角色审查 ARCH-01 语义边界锁定）：
 *   - continueCount=1（记录了续写尝试）
 *   - isPartial=false（stop 触发 + 空续写 ≠ 确定截断，不标记 partial）
 *   - error 含"空内容"警告
 *   - output 保留首次内容
 *   - 空续写消耗的 token 也计入 tokensConsumed（TEST-02 修复锁定）
 *
 * 与 TC-CONT-05 的语义对照：
 *   TC-CONT-05 是 length（确定截断）触发 + 空续写 → isPartial=true；
 *   本用例是 stop+关键字（推测截断）触发 + 空续写 → isPartial=false。
 */
test("TC-CONT-13: stop+关键字触发 + 续写返回空内容（isPartial=false）", async () => {
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });

    // 第一次：stop 但末尾含继续关键字（>200 字符确保关键字在末尾 200 内）
    const firstContent = "a".repeat(250) + "\n\n由于输出较长,我将继续在下一条消息中完成剩余内容";

    const { handle, calls } = buildSequenceStubClient([
      {
        content: firstContent,
        finishReason: "stop",
        usage: { total_tokens: 100 },
      },
      {
        content: "", // 续写返回空内容
        finishReason: "stop",
        usage: { total_tokens: 50 },
      },
    ]);

    const result = await executeDispatch(task, { injectedClient: handle });

    // 断言 1：status=succeeded
    assert.equal(result.status, "succeeded");
    // 断言 2：记录了 1 次续写尝试
    assert.equal(result.continueCount, 1, "应记录 1 次续写尝试");
    // 断言 3：isPartial=false（stop 触发 + 空续写，可能为 LLM 主动停止）
    assert.equal(result.isPartial, false, "stop 触发 + 空续写时 isPartial 应为 false");
    // 断言 4：error 含"空内容"警告
    assert.ok(result.error?.includes("空内容"), `error 应含 "空内容" 警告，实际: ${result.error}`);
    // 断言 5：output 保留首次内容
    assert.equal(result.output, firstContent, "应保留首次调用的输出");
    // 断言 6：共调用 2 次 LLM
    assert.equal(calls.length, 2, "应调用 2 次 LLM");
    // 断言 7：空续写消耗的 token 也计入（100 + 50 = 150）
    assert.equal(result.tokensConsumed.total, 150, "空续写的 token 也应计入总量");
  } finally {
    restoreEnv();
  }
});

/**
 * TC-CONT-14: 短续写块（<200 字符）不误触发续写（ARCH-08 回归）
 *
 * 场景（架构师动态复现的真实 bug）：
 *   第一次 finish_reason="stop" 且末尾含继续关键字（283 字符），触发续写；
 *   第二次续写返回短内容"（完）"（4 字符）+ stop——收尾块正常结束。
 *
 * 修复前行为（检测累计 fullContent）：
 *   拼接后 fullContent 末尾 200 字符内仍含首次块的继续关键字，
 *   shouldContinue 误判 true → 多余续写 + "（完）"被重复拼接 + isPartial 误标记
 *   （实测调用 4 次、continueCount=3、isPartial=true）。
 *
 * 期望（ARCH-08 修复后：意图检测针对 lastChunk 最近响应块）：
 *   - 共调用 2 次 LLM（不误触发第 3 次）
 *   - continueCount=1
 *   - isPartial=false
 *   - output = firstContent + "（完）"（无重复拼接）
 */
test("TC-CONT-14: 短续写块（<200 字符）不误触发续写（ARCH-08 回归）", async () => {
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });

    // 首次：stop + 末尾含继续关键字（283 字符）
    const firstContent = "a".repeat(250) + "\n\n由于输出较长,我将继续在下一条消息中完成剩余内容";
    // 续写：短收尾块（4 字符）+ stop——正常结束
    const secondContent = "（完）";

    const { handle, calls } = buildSequenceStubClient([
      { content: firstContent, finishReason: "stop", usage: { total_tokens: 100 } },
      { content: secondContent, finishReason: "stop", usage: { total_tokens: 50 } },
      // 若误判触发第 3 次续写，stub 会越界复用第 2 个响应（finishReason=stop 无关键字），
      // 通过 calls.length 断言可捕获多余调用
    ]);

    const result = await executeDispatch(task, { injectedClient: handle });

    // 断言 1：status=succeeded
    assert.equal(result.status, "succeeded");
    // 断言 2：共调用 2 次 LLM（ARCH-08 修复核心：不误触发第 3 次续写）
    assert.equal(calls.length, 2, "短续写块正常 stop 后不应再触发续写");
    // 断言 3：continueCount=1
    assert.equal(result.continueCount, 1, "应只记录 1 次续写");
    // 断言 4：isPartial=false
    assert.equal(result.isPartial, false, "正常完成不应标记 partial");
    // 断言 5：output 无重复拼接（"（完）"只出现一次）
    assert.equal(result.output, firstContent + secondContent, "短收尾块不应被重复拼接");
    // 断言 6：token 累加正确（100 + 50 = 150）
    assert.equal(result.tokensConsumed.total, 150);
  } finally {
    restoreEnv();
  }
});

/**
 * TC-CONT-15: maxContinueCount=1 + stop+关键字触发 + 空续写（ARCH-09 回归）
 *
 * 场景（边界组合）：
 *   maxContinueCount=1，首次 stop+关键字触发续写，续写恰好返回空内容——
 *   空内容 break 发生在最后一次允许的尝试上。
 *
 * 修复前行为：
 *   循环后"达到最大续写次数"检查不区分退出原因，将 ARCH-01 的
 *   isPartial=false 语义覆盖为 true，且"空内容"警告被替换为通用文案。
 *
 * 期望（ARCH-09 修复后：!partialError 前置，保留已有精确语义）：
 *   - continueCount=1
 *   - isPartial=false（ARCH-01 语义不被循环后检查推翻）
 *   - error 含"空内容"警告（不被"达到最大续写次数"覆盖）
 *   - 空续写 token 计入
 */
test("TC-CONT-15: maxContinueCount=1 + stop+关键字 + 空续写（ARCH-09 回归）", async () => {
  const restoreEnv = isolateOpenAIEnv();
  try {
    const task = buildTask({ title: "测试", description: "描述" });

    const firstContent = "a".repeat(250) + "\n\n由于输出较长,我将继续在下一条消息中完成剩余内容";

    const { handle, calls } = buildSequenceStubClient([
      { content: firstContent, finishReason: "stop", usage: { total_tokens: 100 } },
      { content: "", finishReason: "stop", usage: { total_tokens: 50 } },
    ]);

    const result = await executeDispatch(task, { injectedClient: handle, maxContinueCount: 1 });

    // 断言 1：status=succeeded
    assert.equal(result.status, "succeeded");
    // 断言 2：continueCount=1
    assert.equal(result.continueCount, 1);
    // 断言 3：isPartial=false（ARCH-09 核心：空续写语义不被"达到最大次数"覆盖）
    assert.equal(result.isPartial, false, "stop 触发 + 空续写不应被覆盖为 partial");
    // 断言 4：error 保留"空内容"精确警告（不被通用文案替换）
    assert.ok(result.error?.includes("空内容"), `error 应保留 "空内容" 警告，实际: ${result.error}`);
    // 断言 5：共调用 2 次 LLM
    assert.equal(calls.length, 2);
    // 断言 6：token 计入（100 + 50 = 150）
    assert.equal(result.tokensConsumed.total, 150);
  } finally {
    restoreEnv();
  }
});
