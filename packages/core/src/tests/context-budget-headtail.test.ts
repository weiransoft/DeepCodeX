/**
 * 第 0 级 tool 输出截断「头部 + 失败窗口 + 尾部」回归测试
 *
 * 修复背景（dev 阶段空转）：旧第 0 级 head-only（slice(0, maxChars)）把
 * 真实 bash / pytest 输出尾部的 stderr、FAILED、AssertionError、exit code、
 * Traceback 整段砍掉，模型只能盲试换命令形成多轮空转。
 *
 * 本套件同时验证：
 * 1. 纯函数 truncateToolOutput 的边界（短输出 / null / 极小预算 / 失败窗口）；
 * 2. 「尾部最后 maxChars*0.45 字符一定完整出现」这一修复核心；
 * 3. 通过 DeterministicContextBudgetProvider.compactForRequest 走真实压缩
 *    路径的端到端保真（协议配对、条数、其它字段不变、输入只读）。
 *
 * 测试原则（用户规则）：不使用 mock 框架；所有消息均为真实 SessionMessage
 * 结构，压缩走真实 provider。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  truncateToolOutput,
  DeterministicContextBudgetProvider,
  DEFAULT_CONTEXT_BUDGET_CONFIG,
} from "../context-budget";
import type { SessionMessage } from "../session";

const MAX = DEFAULT_CONTEXT_BUDGET_CONFIG.toolOutputMaxChars; // 4000
/** 修复核心硬保证：尾部最后 maxChars*0.45 字符一定完整出现 */
const TAIL_LEN = Math.floor(MAX * 0.45); // 1800

/** 统一时间戳（消息构造用，避免动态时间干扰断言） */
const NOW = "2026-11-08T00:00:00.000Z";

/** 构造最小化 SessionMessage（字段语义与 session.ts 类型对齐） */
function msg(
  id: string,
  role: SessionMessage["role"],
  content: string | null,
  messageParams: Record<string, unknown> | null = null
): SessionMessage {
  return {
    id,
    sessionId: "session-headtail",
    role,
    content,
    contentParams: null,
    messageParams,
    compacted: false,
    visible: true,
    createTime: NOW,
    updateTime: NOW,
  };
}

/** 构造带 assistant.tool_calls ↔ tool.tool_call_id 配对的 assistant 消息 */
function assistantWithToolCalls(id: string, toolCallIds: string[]): SessionMessage {
  return msg(id, "assistant", "", {
    tool_calls: toolCallIds.map((callId) => ({
      id: callId,
      type: "function",
      function: { name: "bash", arguments: "{}" },
    })),
  });
}

// ==========================================================================
// T1：短输出 / null / 非字符串 / 边界长度 → 原样返回
// ==========================================================================
test("T1 短输出与 null/非字符串原样返回（长度 ≤ maxChars 不截断、类型安全）", () => {
  assert.equal(truncateToolOutput(null, MAX), null, "null 应原样返回原值（类型安全，不解引用）");
  assert.equal(truncateToolOutput("", MAX), "", "空串应原样返回");
  assert.equal(truncateToolOutput("short output", MAX), "short output", "短字符串应原样返回");
  // 长度恰好等于 maxChars：仍走透传分支，原样返回
  const exact = "e".repeat(50);
  assert.equal(truncateToolOutput(exact, 50), exact, "长度恰好 = maxChars 应原样返回");
  // 运行时非字符串输入（TS 签名不允许，JS 调用可能发生）：原样返回、不抛异常
  assert.doesNotThrow(() => truncateToolOutput(42 as unknown as string, MAX));
  assert.equal(truncateToolOutput(42 as unknown as string, MAX), 42, "非字符串应原样返回、不崩溃");
});

// ==========================================================================
// T2：长输出（12000 字符，中部大段进度点，尾部 FAILED + AssertionError）
// ==========================================================================
test("T2 长输出尾部失败证据不丢：含 FAILED 用例名与 AssertionError，长度 ≤ 4000，尾部 1800 完整", () => {
  const head = "RUN pytest -q\ncollecting...\n";
  const tailError =
    "\n=== FAILURES ===\nFAILED tests/test_x.py::test_y\n" +
    "AssertionError: expected 1 got 2\n" +
    "1 failed, 23 passed in 0.85s\nprocess exited with exit code 1\n";
  const content = head + ".".repeat(12_000 - head.length - tailError.length) + tailError;
  assert.equal(content.length, 12_000, "构造的输出应为 12000 字符");

  const result = truncateToolOutput(content, MAX);

  assert.ok(result.length <= MAX, `结果长度应 ≤ ${MAX}，实际 ${result.length}`);
  assert.ok(result.includes("FAILED tests/test_x.py::test_y"), "应保留尾部失败用例名");
  assert.ok(result.includes("AssertionError: expected 1 got 2"), "应保留尾部断言错误");
  assert.ok(result.endsWith(content.slice(-TAIL_LEN)), "尾部最后 1800 字符应完整出现（修复核心）");
  assert.ok(result.startsWith(head), "应保留头部上下文");
  assert.ok(result.includes("已截断，原共"), "应保留旧文案子串「已截断，原共」");
});

// ==========================================================================
// T3：失败窗口在中部（前 6000 字符处 AssertionError）→ 窗口文本被保留
// ==========================================================================
test("T3 中部失败窗口被保留（首个失败标记前后各 150 字符）+ 尾部仍完整", () => {
  const prefix = "H".repeat(6000); // 无失败标记，保证首个匹配落在中部窗口
  const windowText = "AssertionError: mid-window failure at step 42";
  const suffix = "T".repeat(12_000 - prefix.length - windowText.length);
  const content = prefix + windowText + suffix;
  assert.equal(content.length, 12_000);

  const result = truncateToolOutput(content, MAX);

  assert.ok(result.includes(windowText), "中部的失败窗口文本应被保留");
  assert.ok(result.endsWith(content.slice(-TAIL_LEN)), "尾部最后 1800 字符仍应完整出现");
  assert.ok(result.length <= MAX, `结果长度应 ≤ ${MAX}，实际 ${result.length}`);
  assert.ok(result.includes("已截断，原共"), "应保留旧文案子串");
});

// ==========================================================================
// T4：无失败标记的长输出 → 头部 + 尾部 + 省略标记
// ==========================================================================
test("T4 无失败标记退化为头部+尾部：两段都在、含省略标记、长度 ≤ 4000", () => {
  const headMark = "HEAD_CONTEXT_MARK";
  const tailMark = "TAIL_SUMMARY_MARK";
  const filler = "z".repeat(12_000 - headMark.length - tailMark.length);
  const content = headMark + filler + tailMark;
  assert.equal(content.length, 12_000);

  const result = truncateToolOutput(content, MAX);

  assert.ok(result.startsWith(headMark), "应保留头部上下文");
  assert.ok(result.endsWith(content.slice(-TAIL_LEN)), "应保留尾部统计段（含 TAIL_SUMMARY_MARK）");
  assert.ok(result.includes("已截断"), "应含省略/截断标记");
  assert.ok(result.includes("省略"), "应标注省略字符数");
  assert.ok(result.length <= MAX, `结果长度应 ≤ ${MAX}，实际 ${result.length}`);
});

// ==========================================================================
// T5：maxChars 极小 / 0 / 负数 / NaN / Infinity → 不抛异常、长度受控
// ==========================================================================
test("T5 极小与非法预算安全退化：50/0/负数/NaN/Infinity 均不抛异常、长度受控", () => {
  const content = "x".repeat(12_000);

  const for50 = truncateToolOutput(content, 50);
  assert.doesNotThrow(() => truncateToolOutput(content, 50));
  assert.equal(typeof for50, "string");
  assert.ok(for50.length <= 50, `maxChars=50 时结果长度应 ≤ 50，实际 ${for50.length}`);
  assert.ok(for50.startsWith("xxxx"), "极小预算仍保留头部原文");

  for (const bad of [0, -5, Number.NaN]) {
    assert.doesNotThrow(() => truncateToolOutput(content, bad), `maxChars=${bad} 不应抛异常`);
    const out = truncateToolOutput(content, bad);
    assert.equal(typeof out, "string", `maxChars=${bad} 应返回 string`);
    assert.equal(out.length, 0, `maxChars=${bad} 应退化为空串（长度受控）`);
  }

  // Infinity：长度 ≤ Infinity 成立 → 透传原文，不抛异常
  assert.doesNotThrow(() => truncateToolOutput(content, Infinity));
  assert.equal(truncateToolOutput(content, Infinity), content, "maxChars=Infinity 应原样透传");
});

// ==========================================================================
// T6：端到端 —— 走 DeterministicContextBudgetProvider.compactForRequest 真实压缩路径
// ==========================================================================
test("T6 真实压缩端到端：tool 消息尾部错误仍在、条数/字段/配对不变、输入只读", () => {
  const tailError =
    "\nFAILED tests/test_x.py::test_y\n" + "AssertionError: expected 1 got 2\n" + "process exited with exit code 1\n";
  const bigTool = "RUN\n" + ".".repeat(12_000 - 4 - tailError.length) + tailError;
  assert.equal(bigTool.length, 12_000);

  const messages: SessionMessage[] = [
    msg("sys", "system", "sys"),
    msg("task", "user", "请修复这批测试"),
    assistantWithToolCalls("asst-1", ["call-1"]),
    msg("tool-1", "tool", bigTool, { tool_call_id: "call-1" }),
    msg("final", "assistant", "done"),
  ];

  const provider = new DeterministicContextBudgetProvider();
  const result = provider.compactForRequest(messages);

  // 端到端核心：尾部真实错误经过真实压缩路径后仍能被模型看到
  const tool = result.find((m) => m.id === "tool-1")!;
  assert.ok(tool.content!.includes("FAILED tests/test_x.py::test_y"), "压缩后应保留尾部失败用例名");
  assert.ok(tool.content!.includes("AssertionError: expected 1 got 2"), "压缩后应保留尾部断言错误");
  assert.ok(tool.content!.endsWith(bigTool.slice(-TAIL_LEN)), "压缩后尾部最后 1800 字符应完整出现");
  assert.ok(tool.content!.length <= MAX, `压缩后 tool 内容应 ≤ ${MAX}，实际 ${tool.content!.length}`);
  assert.ok(tool.content!.includes("已截断，原共"), "压缩后应保留旧文案子串");

  // 第 0 级契约：条数不变、其它消息内容不变、协议配对与其它字段不变
  assert.equal(result.length, messages.length, "消息条数不变");
  assert.equal(result.find((m) => m.id === "sys")!.content, "sys", "system 原文不变");
  assert.equal(result.find((m) => m.id === "task")!.content, "请修复这批测试", "任务卡原文不变");
  assert.equal(result.find((m) => m.id === "final")!.content, "done", "末条 assistant 原文不变");
  assert.deepEqual(tool.messageParams, { tool_call_id: "call-1" }, "tool 的 messageParams 原样保留");
  assert.deepEqual(
    result.find((m) => m.id === "asst-1")!.messageParams,
    messages[2]!.messageParams,
    "assistant.tool_calls 原样保留（协议配对合法）"
  );
  // 输入只读：原始 tool 内容未被篡改
  assert.equal(messages[3]!.content, bigTool, "入参数组与消息对象不应被修改");
});
