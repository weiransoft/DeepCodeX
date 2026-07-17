/**
 * V2 Session 上下文钩子集成测试
 *
 * 测试覆盖：
 * - SH-01 ~ SH-10: DefaultSessionContextHook 单元测试
 *   - 缓存命中/未命中/过期/副本隔离/空 sessionId/refreshContextAsync no-op/TTL
 * - SH-11 ~ SH-18: OpenAIMessageConverter 与 contextHook 集成测试
 *   - V2 未启用向后兼容 / V2 启用注入 / 空片段不注入 / null content 不注入 /
 *     注入格式正确 / 同步签名 / 多 system message 只注入首条 / 不影响其他消息
 *
 * 所有测试使用真实的 DefaultSessionContextHook 与 OpenAIMessageConverter 实例，
 * 无 mock（遵循项目测试规范）。
 *
 * 设计依据：V2 技术方案 §9.1
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DefaultSessionContextHook,
  type ContextSnippet,
  type SessionContextHook,
} from "../../integration/session-hook";
import { OpenAIMessageConverter } from "../../../common/openai-message-converter";
import type { SessionMessage } from "../../../session";

/**
 * 构造测试用 SessionMessage
 *
 * 仅填充测试所需字段，其余使用合理默认值。
 *
 * @param overrides 覆盖字段（sessionId / role / content 等最常用）
 * @returns 完整的 SessionMessage 对象
 */
function makeMessage(overrides: Partial<SessionMessage> & Pick<SessionMessage, "sessionId" | "role">): SessionMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    content: null,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: "2026-01-01T00:00:00.000Z",
    updateTime: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * 构造测试用上下文片段
 */
function makeSnippet(overrides: Partial<ContextSnippet> = {}): ContextSnippet {
  return {
    type: "file_content",
    content: "sample context content",
    source: "/path/to/file.ts",
    ...overrides,
  };
}

// ============================================================================
// DefaultSessionContextHook 单元测试
// ============================================================================

test("SH-01: preBuildContext 空消息数组返回空数组（防御性降级）", () => {
  const hook = new DefaultSessionContextHook();
  // 空消息数组无法提取 sessionId，应返回空数组（不抛错）
  const result = hook.preBuildContext([]);
  assert.deepEqual(result, []);
});

test("SH-02: preBuildContext 缓存未命中返回空数组（§9.1 未命中降级约定）", () => {
  const hook = new DefaultSessionContextHook();
  const messages = [makeMessage({ sessionId: "sess-no-cache", role: "system", content: "sys" })];
  // 未调用 setSnippets，缓存为空，应返回空数组（不抛错、不触发隐式 async）
  const result = hook.preBuildContext(messages);
  assert.deepEqual(result, []);
});

test("SH-03: setSnippets + preBuildContext 缓存命中返回片段", () => {
  const hook = new DefaultSessionContextHook();
  const sessionId = "sess-hit";
  const snippets = [
    makeSnippet({ type: "file_content", source: "/a.ts", content: "content A" }),
    makeSnippet({ type: "memory", source: "mem-1", content: "memory B" }),
  ];

  // 写入缓存
  hook.setSnippets(sessionId, snippets);

  // 读取缓存：messages 首条消息的 sessionId 用于查找
  const messages = [makeMessage({ sessionId, role: "system", content: "sys" })];
  const result = hook.preBuildContext(messages);

  assert.equal(result.length, 2);
  assert.deepEqual(result, snippets);
});

test("SH-04: preBuildContext 缓存过期返回空数组", () => {
  // 使用极短 TTL（1ms）验证过期逻辑
  const hook = new DefaultSessionContextHook(1);
  const sessionId = "sess-expired";
  hook.setSnippets(sessionId, [makeSnippet()]);

  // 等待 TTL 过期（留足 50ms 余量，避免时间精度问题导致 flaky）
  const waitMs = 50;
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    // busy wait
  }

  const messages = [makeMessage({ sessionId, role: "system", content: "sys" })];
  const result = hook.preBuildContext(messages);
  // 过期后应返回空数组（降级无注入，不抛错）
  assert.deepEqual(result, []);
});

test("SH-05: preBuildContext 返回副本（外部修改不影响缓存内部状态）", () => {
  const hook = new DefaultSessionContextHook();
  const sessionId = "sess-copy-out";
  const original = [makeSnippet({ content: "original" })];
  hook.setSnippets(sessionId, original);

  const messages = [makeMessage({ sessionId, role: "system", content: "sys" })];
  const result = hook.preBuildContext(messages);

  // 修改返回的数组与元素
  result.push(makeSnippet({ content: "injected" }));
  result[0].content = "mutated";

  // 再次读取：缓存应不受影响（返回原始内容，长度仍为 1）
  const result2 = hook.preBuildContext(messages);
  assert.equal(result2.length, 1);
  assert.equal(result2[0].content, "original");
});

test("SH-06: setSnippets 写入副本（外部修改不影响缓存内容）", () => {
  const hook = new DefaultSessionContextHook();
  const sessionId = "sess-copy-in";
  const snippets = [makeSnippet({ content: "before" })];
  hook.setSnippets(sessionId, snippets);

  // 修改原数组与元素
  snippets.push(makeSnippet({ content: "extra" }));
  snippets[0].content = "after";

  // 读取缓存：应返回写入时的快照（长度 1，内容 "before"）
  const messages = [makeMessage({ sessionId, role: "system", content: "sys" })];
  const result = hook.preBuildContext(messages);
  assert.equal(result.length, 1);
  assert.equal(result[0].content, "before");
});

test("SH-07: setSnippets 空 sessionId 不写入缓存", () => {
  const hook = new DefaultSessionContextHook();
  // 空 sessionId 不应写入缓存（避免空键污染 Map）
  hook.setSnippets("", [makeSnippet()]);
  hook.setSnippets(undefined as unknown as string, [makeSnippet()]);

  // 验证：以空 sessionId 构造的消息读取应返回空数组
  const messages = [makeMessage({ sessionId: "", role: "system", content: "sys" })];
  const result = hook.preBuildContext(messages);
  assert.deepEqual(result, []);
});

test("SH-08: refreshContextAsync V2-P0a 阶段为 no-op（不抛错、不改缓存）", async () => {
  const hook = new DefaultSessionContextHook();
  const sessionId = "sess-refresh";
  hook.setSnippets(sessionId, [makeSnippet({ content: "preset" })]);

  // 调用 refreshContextAsync：V2-P0a 阶段为空实现，不应抛错
  await hook.refreshContextAsync(sessionId);

  // 缓存内容应保持不变（refreshContextAsync 不应清空或修改缓存）
  const messages = [makeMessage({ sessionId, role: "system", content: "sys" })];
  const result = hook.preBuildContext(messages);
  assert.equal(result.length, 1);
  assert.equal(result[0].content, "preset");
});

test("SH-09: 默认 TTL 为 30 分钟（1800000ms）", () => {
  // 通过反射验证默认 TTL 值（与 V2Config.context.globalTtlMs 默认值一致，§9.1）
  // 使用自定义子类暴露 ttlMs 以便断言
  class ProbeHook extends DefaultSessionContextHook {
    getTtlMs(): number {
      return (this as unknown as { ttlMs: number }).ttlMs;
    }
  }
  const hook = new ProbeHook();
  assert.equal(hook.getTtlMs(), 30 * 60 * 1000);
});

test("SH-10: 自定义 TTL 生效", () => {
  class ProbeHook extends DefaultSessionContextHook {
    getTtlMs(): number {
      return (this as unknown as { ttlMs: number }).ttlMs;
    }
  }
  const customTtl = 5 * 60 * 1000; // 5 分钟
  const hook = new ProbeHook(customTtl);
  assert.equal(hook.getTtlMs(), customTtl);
});

test("SH-10b: preBuildContext 从首条消息提取 sessionId（不同 sessionId 隔离）", () => {
  const hook = new DefaultSessionContextHook();
  hook.setSnippets("sess-A", [makeSnippet({ content: "A" })]);
  hook.setSnippets("sess-B", [makeSnippet({ content: "B" })]);

  // sess-A 的消息应返回 A 的片段
  const resultA = hook.preBuildContext([makeMessage({ sessionId: "sess-A", role: "system", content: "s" })]);
  assert.equal(resultA.length, 1);
  assert.equal(resultA[0].content, "A");

  // sess-B 的消息应返回 B 的片段
  const resultB = hook.preBuildContext([makeMessage({ sessionId: "sess-B", role: "system", content: "s" })]);
  assert.equal(resultB.length, 1);
  assert.equal(resultB[0].content, "B");
});

test("SH-10c: preBuildContext 首条消息 sessionId 缺失时返回空数组", () => {
  const hook = new DefaultSessionContextHook();
  hook.setSnippets("sess-X", [makeSnippet()]);

  // 构造 sessionId 为空字符串的首条消息
  const messages = [makeMessage({ sessionId: "", role: "system", content: "s" })];
  const result = hook.preBuildContext(messages);
  assert.deepEqual(result, []);
});

// ============================================================================
// OpenAIMessageConverter 与 contextHook 集成测试
// ============================================================================

test("SH-11: V2 未启用（无 contextHook）行为不变（向后兼容）", () => {
  // 不注入 contextHook
  const converter = new OpenAIMessageConverter();
  const originalContent = "You are a helpful assistant.";
  const messages: SessionMessage[] = [
    makeMessage({ sessionId: "s1", role: "system", content: originalContent }),
    makeMessage({ sessionId: "s1", role: "user", content: "hello" }),
  ];

  const result = converter.buildMessages(messages, false, "gpt-4");

  // system message 内容应保持原样，不包含 "## V2 Context"
  const sysMsg = result.find((m) => m.role === "system");
  assert.ok(sysMsg, "应存在 system message");
  const content = typeof sysMsg.content === "string" ? sysMsg.content : "";
  assert.equal(content, originalContent, "system content 应未被修改");
  assert.ok(!content.includes("## V2 Context"), "未启用 V2 时不应包含 V2 Context 区块");
});

test("SH-12: V2 启用 + 有 snippets → 注入到首条 system message", () => {
  const hook = new DefaultSessionContextHook();
  const sessionId = "sess-v2-on";
  hook.setSnippets(sessionId, [
    makeSnippet({ type: "file_content", source: "/src/a.ts", content: "file A content" }),
    makeSnippet({ type: "memory", source: "mem-1", content: "memory content" }),
  ]);

  const converter = new OpenAIMessageConverter({ contextHook: hook });
  const originalContent = "You are a helpful assistant.";
  const messages: SessionMessage[] = [
    makeMessage({ sessionId, role: "system", content: originalContent }),
    makeMessage({ sessionId, role: "user", content: "hello" }),
  ];

  const result = converter.buildMessages(messages, false, "gpt-4");

  const sysMsg = result.find((m) => m.role === "system");
  assert.ok(sysMsg);
  const content = typeof sysMsg.content === "string" ? sysMsg.content : "";

  // 验证：原内容保留 + V2 Context 区块追加
  assert.ok(content.startsWith(originalContent), "原 system content 应保留在开头");
  assert.ok(content.includes("## V2 Context"), "应包含 V2 Context 区块标题");
  assert.ok(content.includes("--- file_content: /src/a.ts ---"), "应包含 file_content 片段头部");
  assert.ok(content.includes("file A content"), "应包含 file_content 片段内容");
  assert.ok(content.includes("--- memory: mem-1 ---"), "应包含 memory 片段头部");
  assert.ok(content.includes("memory content"), "应包含 memory 片段内容");
});

test("SH-13: V2 启用 + snippets 为空 → 不注入（保持原样）", () => {
  const hook = new DefaultSessionContextHook();
  // 不调用 setSnippets，preBuildContext 返回空数组
  const converter = new OpenAIMessageConverter({ contextHook: hook });
  const originalContent = "You are a helpful assistant.";
  const messages: SessionMessage[] = [
    makeMessage({ sessionId: "sess-empty", role: "system", content: originalContent }),
    makeMessage({ sessionId: "sess-empty", role: "user", content: "hi" }),
  ];

  const result = converter.buildMessages(messages, false, "gpt-4");
  const sysMsg = result.find((m) => m.role === "system");
  assert.ok(sysMsg);
  const content = typeof sysMsg.content === "string" ? sysMsg.content : "";
  assert.equal(content, originalContent, "snippets 为空时 system content 应未被修改");
});

test("SH-14: V2 启用 + system message content 为 null → 不注入（不抛错）", () => {
  const hook = new DefaultSessionContextHook();
  hook.setSnippets("sess-null", [makeSnippet()]);
  const converter = new OpenAIMessageConverter({ contextHook: hook });

  // system message content 为 null（防御性场景）
  const messages: SessionMessage[] = [
    makeMessage({ sessionId: "sess-null", role: "system", content: null }),
    makeMessage({ sessionId: "sess-null", role: "user", content: "hello" }),
  ];

  // 不应抛错
  const result = converter.buildMessages(messages, false, "gpt-4");
  const sysMsg = result.find((m) => m.role === "system");
  assert.ok(sysMsg);
  // content 为 null 时不应注入，renderContent 返回 ""（message.content ?? ""）
  const content = typeof sysMsg.content === "string" ? sysMsg.content : "";
  assert.equal(content, "", "content 为 null 时 renderContent 返回空字符串，且不注入 V2 Context");
  assert.ok(!content.includes("## V2 Context"), "content 为 null 时不应注入 V2 Context");
});

test("SH-15: 注入格式正确（## V2 Context 区块结构与分隔符）", () => {
  const hook = new DefaultSessionContextHook();
  const sessionId = "sess-format";
  hook.setSnippets(sessionId, [makeSnippet({ type: "task_context", source: "task-001", content: "task body" })]);

  const converter = new OpenAIMessageConverter({ contextHook: hook });
  const messages: SessionMessage[] = [makeMessage({ sessionId, role: "system", content: "BASE" })];

  const result = converter.buildMessages(messages, false, "gpt-4");
  const sysMsg = result.find((m) => m.role === "system");
  assert.ok(sysMsg);
  const content = typeof sysMsg.content === "string" ? sysMsg.content : "";

  // 验证完整格式：原内容 + 空行 + "## V2 Context" + 空行 + "--- type: source ---" + 换行 + 内容
  const expected = "BASE\n\n## V2 Context\n\n--- task_context: task-001 ---\ntask body";
  assert.equal(content, expected, "注入格式应严格匹配约定");
});

test("SH-16: buildMessages 保持同步签名（返回值非 Promise）", () => {
  const hook = new DefaultSessionContextHook();
  hook.setSnippets("sess-sync", [makeSnippet()]);
  const converter = new OpenAIMessageConverter({ contextHook: hook });

  const messages: SessionMessage[] = [makeMessage({ sessionId: "sess-sync", role: "system", content: "sys" })];

  const result = converter.buildMessages(messages, false, "gpt-4");
  // NP-01 修复验证：返回值应为数组，非 Promise
  assert.ok(Array.isArray(result), "buildMessages 应返回数组（同步签名）");
  assert.ok(!(result instanceof Promise), "buildMessages 返回值不应是 Promise");
});

test("SH-17: 多个 system messages 只注入到首条 system message", () => {
  const hook = new DefaultSessionContextHook();
  const sessionId = "sess-multi-sys";
  hook.setSnippets(sessionId, [makeSnippet({ content: "INJECTED" })]);

  const converter = new OpenAIMessageConverter({ contextHook: hook });
  const firstSys = "FIRST SYSTEM";
  const secondSys = "SECOND SYSTEM";
  const messages: SessionMessage[] = [
    makeMessage({ sessionId, role: "system", content: firstSys }),
    makeMessage({ sessionId, role: "system", content: secondSys }),
    makeMessage({ sessionId, role: "user", content: "hi" }),
  ];

  const result = converter.buildMessages(messages, false, "gpt-4");
  const sysMsgs = result.filter((m) => m.role === "system");

  // 首条 system message 应被注入
  const firstContent = typeof sysMsgs[0].content === "string" ? sysMsgs[0].content : "";
  assert.ok(firstContent.includes("## V2 Context"), "首条 system message 应包含 V2 Context");
  assert.ok(firstContent.includes("INJECTED"), "首条 system message 应包含注入内容");

  // 第二条 system message 不应被注入（messages.find 只取首条）
  const secondContent = typeof sysMsgs[1].content === "string" ? sysMsgs[1].content : "";
  assert.ok(!secondContent.includes("## V2 Context"), "第二条 system message 不应包含 V2 Context");
  assert.ok(!secondContent.includes("INJECTED"), "第二条 system message 不应包含注入内容");
});

test("SH-18: V2 注入不影响 user/assistant 消息（仅注入 system message）", () => {
  const hook = new DefaultSessionContextHook();
  const sessionId = "sess-isolation";
  hook.setSnippets(sessionId, [makeSnippet({ content: "CTX" })]);

  const converter = new OpenAIMessageConverter({ contextHook: hook });
  const userContent = "user question";
  const messages: SessionMessage[] = [
    makeMessage({ sessionId, role: "system", content: "sys" }),
    makeMessage({ sessionId, role: "user", content: userContent }),
  ];

  const result = converter.buildMessages(messages, false, "gpt-4");
  const userMsg = result.find((m) => m.role === "user");
  assert.ok(userMsg);
  const content = typeof userMsg.content === "string" ? userMsg.content : "";
  assert.equal(content, userContent, "user 消息内容不应被注入影响");
  assert.ok(!content.includes("## V2 Context"), "user 消息不应包含 V2 Context");
});

test("SH-19: 自定义 SessionContextHook 实现（接口契约验证）", () => {
  // 验证接口可被外部实现，且 OpenAIMessageConverter 能正确调用
  let preBuildCallCount = 0;
  const customSnippets: ContextSnippet[] = [{ type: "custom", content: "custom content", source: "custom-source" }];

  const customHook: SessionContextHook = {
    preBuildContext(_messages) {
      preBuildCallCount += 1;
      return customSnippets;
    },
    async refreshContextAsync(_sessionId) {
      // 自定义实现的 refresh：no-op
    },
  };

  const converter = new OpenAIMessageConverter({ contextHook: customHook });
  const messages: SessionMessage[] = [makeMessage({ sessionId: "sess-custom", role: "system", content: "base" })];

  const result = converter.buildMessages(messages, false, "gpt-4");

  // 验证 preBuildContext 被调用一次
  assert.equal(preBuildCallCount, 1, "preBuildContext 应被调用一次");

  // 验证注入了自定义片段
  const sysMsg = result.find((m) => m.role === "system");
  assert.ok(sysMsg);
  const content = typeof sysMsg.content === "string" ? sysMsg.content : "";
  assert.ok(content.includes("## V2 Context"), "应注入 V2 Context 区块");
  assert.ok(content.includes("--- custom: custom-source ---"), "应包含自定义片段头部");
  assert.ok(content.includes("custom content"), "应包含自定义片段内容");
});
