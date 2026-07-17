/**
 * AnthropicMessageConverter 边界与容错分支测试（补充健壮性覆盖缺口）
 *
 * 覆盖主测试文件未触及的防御/容错分支（要求：不崩溃、语义可预期）：
 * 1. 空 messages 数组 → 空产出；
 * 2. 全部 compacted（含 system）→ 空产出，system 不被提取；
 * 3. assistant tool_calls 缺 id / 缺 function.name → 该项跳过，不崩溃；
 * 4. messageParams.tool_calls 非数组 → 按无工具调用处理；
 * 5. arguments 非法 JSON / JSON 数组 → input 回退空对象（parseArguments 容错）；
 * 6. tool 消息缺 tool_call_id → "unknown_tool_call" 占位（extractToolCallId 容错）；
 * 7. 首个 system 被提取后，其余 system 残留并入对话为 user 文本（防信息丢失）；
 * 8. content 为 null 的 system 不提取为顶层参数，转入对话流；
 * 9. 连续 assistant 混合合并：块数组 + 纯文本 → 统一展平为块数组（concatContent 块路径）。
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
const MODEL = "claude-sonnet-4-6";

await suite("空 messages 数组：空产出且不崩溃", () => {
  const { system, messages } = converter.buildMessages([], false, MODEL);
  assertEqual(system, undefined, "system 未定义");
  assertEqual(messages.length, 0, "messages 为空数组");
});

await suite("全部 compacted（含 system）：空产出且 system 不提取", () => {
  const { system, messages } = converter.buildMessages(
    [
      msg("system", "被压缩的系统提示", { compacted: true }),
      msg("user", "被压缩的用户消息", { compacted: true }),
      msg("assistant", "被压缩的回复", { compacted: true }),
    ],
    false,
    MODEL
  );
  assertEqual(system, undefined, "compacted 的 system 不参与顶层提取");
  assertEqual(messages.length, 0, "全部 compacted 时 messages 为空");
});

await suite("assistant tool_calls 缺 id：该项跳过，不崩溃", () => {
  const assistant = msg("assistant", "正文", {
    messageParams: {
      tool_calls: [
        // 缺 id 的非法项：extractToolCalls 的 continue 分支
        { type: "function", function: { name: "read_file", arguments: "{}" } },
        // 合法项：正常转换
        { id: "call_ok", type: "function", function: { name: "write_file", arguments: "{}" } },
      ],
    },
  });
  const { messages } = converter.buildMessages([msg("user", "操作"), assistant], false, MODEL);
  assertEqual(messages.length, 2, "user + assistant 两条");
  const blocks = messages[1].content as Array<{ type: string; id?: string; name?: string }>;
  assertTrue(Array.isArray(blocks), "assistant content 为块数组");
  // 正文 text 块 + 仅 1 个合法 tool_use 块（缺 id 项被跳过）
  assertEqual(blocks.length, 2, "text + 1 个合法 tool_use（缺 id 项跳过）");
  assertEqual(blocks[0].type, "text", "首块为正文 text");
  assertEqual(blocks[1].type, "tool_use", "次块为 tool_use");
  assertEqual(blocks[1].id, "call_ok", "合法 tool_use id 保留");
});

await suite("assistant tool_calls 缺 function.name：该项跳过", () => {
  const assistant = msg("assistant", null, {
    messageParams: {
      tool_calls: [
        // function.name 非字符串：extractToolCalls 的 continue 分支
        { id: "call_1", type: "function", function: { arguments: "{}" } },
      ],
    },
  });
  // 全部 tool_calls 无效时，assistant 退化为纯文本形态（content null → 空串）
  const { messages } = converter.buildMessages([msg("user", "操作"), assistant], false, MODEL);
  assertEqual(messages.length, 2, "user + assistant 两条");
  assertEqual(messages[1].content, "", "无有效 tool_calls 时退化为空串纯文本");
});

await suite("messageParams.tool_calls 非数组：按无工具调用处理", () => {
  const assistant = msg("assistant", "普通回复", {
    // tool_calls 被污染为对象而非数组：extractToolCalls 的 !Array.isArray 分支
    messageParams: { tool_calls: { id: "call_1" } },
  });
  const { messages } = converter.buildMessages([msg("user", "问"), assistant], false, MODEL);
  assertEqual(messages[1].content, "普通回复", "非数组 tool_calls 按纯文本处理");
});

await suite("arguments 非法 JSON：input 回退空对象", () => {
  const assistant = msg("assistant", null, {
    messageParams: {
      tool_calls: [{ id: "call_bad", type: "function", function: { name: "read_file", arguments: "{未闭合" } }],
    },
  });
  const { messages } = converter.buildMessages([msg("user", "读"), assistant], false, MODEL);
  const blocks = messages[1].content as Array<{ type: string; input?: unknown }>;
  assertEqual(blocks[0].type, "tool_use", "tool_use 块仍产出");
  assertEqual(JSON.stringify(blocks[0].input), "{}", "非法 JSON 回退空对象（parseArguments catch 分支）");
});

await suite("arguments 为 JSON 数组：input 回退空对象", () => {
  const assistant = msg("assistant", null, {
    messageParams: {
      tool_calls: [
        // 合法 JSON 但为数组：parseArguments 的 Array.isArray 排除分支
        { id: "call_arr", type: "function", function: { name: "batch", arguments: "[1,2,3]" } },
      ],
    },
  });
  const { messages } = converter.buildMessages([msg("user", "批处理"), assistant], false, MODEL);
  const blocks = messages[1].content as Array<{ type: string; input?: unknown }>;
  assertEqual(JSON.stringify(blocks[0].input), "{}", "JSON 数组回退空对象（Claude input 必须是对象）");
});

await suite("tool 消息缺 tool_call_id：占位 unknown_tool_call", () => {
  // messageParams 缺失（null）：extractToolCallId 容错分支
  // 注意：tool 转 user 后会与紧邻的 user 合并，故中间隔一条 assistant 以独立断言该消息
  const toolMsg = msg("tool", "结果内容");
  const { messages } = converter.buildMessages([msg("user", "问"), msg("assistant", "好"), toolMsg], false, MODEL);
  assertEqual(messages.length, 3, "user/assistant/tool-result-user 三条");
  const blocks = messages[2].content as Array<{ type: string; tool_use_id?: string }>;
  assertEqual(blocks[0].type, "tool_result", "tool_result 块仍产出");
  assertEqual(blocks[0].tool_use_id, "unknown_tool_call", "缺失 id 时占位符兜底，不崩溃");
});

await suite("第二条 system 残留并入对话为 user 文本（防信息丢失）", () => {
  // 提取逻辑针对"首个出现的 system 消息"（不限位置），其后的 system 残留并入对话
  const { system, messages } = converter.buildMessages(
    [msg("system", "主系统提示"), msg("user", "第一句"), msg("system", "中途插入的系统补充")],
    false,
    MODEL
  );
  assertEqual(system, "主系统提示", "首个 system 顶层提取");
  // user 与残留 system 均为 user 角色，连续合并为一条
  assertEqual(messages.length, 1, "连续 user 合并为一条");
  assertEqual(messages[0].content, "第一句\n\n中途插入的系统补充", "残留 system 文本并入 user 流");
});

await suite("content 为 null 的 system 不提取，转入对话流", () => {
  // 首条 system 但 content 非字符串：typeof m.content === "string" 守卫不通过
  const { system, messages } = converter.buildMessages([msg("system", null), msg("assistant", "回复")], false, MODEL);
  assertEqual(system, undefined, "null content 的 system 不提取");
  assertEqual(messages.length, 2, "残留 system 转 user 空文本 + assistant");
  assertEqual(messages[0].role, "user", "残留 system 落入 user 角色");
});

await suite("连续 assistant 混合合并：块数组 + 纯文本展平为块数组", () => {
  const withTool = msg("assistant", null, {
    messageParams: {
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
    },
  });
  const plainText = msg("assistant", "补充说明");
  const { messages } = converter.buildMessages([msg("user", "问"), withTool, plainText], false, MODEL);
  assertEqual(messages.length, 2, "user + 合并后 assistant 共两条");
  const blocks = messages[1].content as Array<{ type: string; text?: string }>;
  assertTrue(Array.isArray(blocks), "合并结果为块数组（concatContent 块路径）");
  assertEqual(blocks.length, 2, "tool_use 块 + 文本块展平拼接");
  assertEqual(blocks[0].type, "tool_use", "首块保留 tool_use");
  assertEqual(blocks[1].type, "text", "纯文本包装为 text 块追加");
  assertEqual(blocks[1].text, "补充说明", "文本内容保留");
});

console.log(`\n=== Test Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\nFailures:\n${failures.join("\n")}`);
  process.exit(1);
}
