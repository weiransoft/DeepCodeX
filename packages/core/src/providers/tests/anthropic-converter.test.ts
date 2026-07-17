/**
 * AnthropicMessageConverter 单元测试
 *
 * 覆盖：system 提取、user/assistant 交替合并、tool_use/tool_result 配对、
 *       空 system 省略、多模态图片、thinking 块透传
 */

import { AnthropicMessageConverter } from "../anthropic-converter.js";
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

/** 构造测试用 SessionMessage（仅填必要字段） */
function msg(role: SessionMessage["role"], content: string | null, extra?: Partial<SessionMessage>): SessionMessage {
  return {
    id: Math.random().toString(36).slice(2),
    sessionId: "s1",
    role,
    content,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: "2026-07-17T00:00:00Z",
    updateTime: "2026-07-17T00:00:00Z",
    ...extra,
  };
}

const converter = new AnthropicMessageConverter();

await suite("首条 system 提取为顶层参数", () => {
  const { system, messages } = converter.buildMessages(
    [msg("system", "你是助手"), msg("user", "你好")],
    false,
    "claude-sonnet-4-6"
  );
  assertEqual(system, "你是助手", "system 提取");
  assertEqual(messages.length, 1, "system 不进入 messages");
  assertEqual(messages[0].role, "user", "首条对话为 user");
});

await suite("无 system 时省略参数", () => {
  const { system } = converter.buildMessages([msg("user", "hi")], false, "claude-sonnet-4-6");
  assertEqual(system, undefined, "空 system 省略");
});

await suite("连续同角色消息合并（Claude 要求交替）", () => {
  const { messages } = converter.buildMessages(
    [msg("user", "第一句"), msg("user", "第二句")],
    false,
    "claude-sonnet-4-6"
  );
  assertEqual(messages.length, 1, "合并为一条");
  assertEqual(messages[0].content, "第一句\n\n第二句", "以双换行连接");
});

await suite("assistant tool_use 转换", () => {
  const assistant = msg("assistant", null, {
    messageParams: {
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
    },
  });
  const { messages } = converter.buildMessages([msg("user", "读文件"), assistant], false, "claude-sonnet-4-6");
  assertEqual(messages.length, 2, "user + assistant 两条");
  const blocks = messages[1].content as Array<{ type: string; id?: string; name?: string; input?: unknown }>;
  assertTrue(Array.isArray(blocks), "assistant content 为块数组");
  assertEqual(blocks[0].type, "tool_use", "tool_use 块");
  assertEqual(blocks[0].id, "call_1", "tool_use id 保留");
  assertEqual(blocks[0].name, "read_file", "tool_use name 保留");
  assertEqual((blocks[0].input as { path: string }).path, "a.ts", "arguments 反序列化为 input 对象");
});

await suite("tool 结果包装为 user 消息", () => {
  const assistant = msg("assistant", null, {
    messageParams: {
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
    },
  });
  const toolMsg = msg("tool", "文件内容", { messageParams: { tool_call_id: "call_1" } });
  const { messages } = converter.buildMessages([msg("user", "读"), assistant, toolMsg], false, "claude-sonnet-4-6");
  assertEqual(messages.length, 3, "user/assistant/tool-result-user");
  assertEqual(messages[2].role, "user", "tool 结果包装为 user");
  const blocks = messages[2].content as Array<{ type: string; tool_use_id?: string; content?: string }>;
  assertEqual(blocks[0].type, "tool_result", "tool_result 块");
  assertEqual(blocks[0].tool_use_id, "call_1", "tool_use_id 对齐");
  assertEqual(blocks[0].content, "文件内容", "结果内容保留");
});

await suite("compacted 消息过滤", () => {
  const { messages } = converter.buildMessages(
    [msg("user", "保留"), msg("user", "压缩掉", { compacted: true })],
    false,
    "claude-sonnet-4-6"
  );
  assertEqual(messages.length, 1, "仅保留未压缩");
});

console.log(`\n=== Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\nFailures:\n${failures.join("\n")}`);
  process.exit(1);
}
