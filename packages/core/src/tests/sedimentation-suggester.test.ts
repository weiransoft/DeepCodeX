/**
 * SedimentationSuggester 单元测试（T02）
 *
 * 测试覆盖（对应 T02 验收①③）：
 *   ① analyze 产出合法草稿（含指纹），LLM 失败/空输出/null → 空数组不抛错；
 *   ③ dismiss 后同指纹不再建议（会话内去重）；
 *   - 草稿校验：非法条目（name 非 kebab / 缺 description / agent 缺 role）被丢弃；
 *   - markdown 代码块包裹的 JSON 输出可解析。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { LLMClient, LLMRequest, LLMResponse } from "../providers/llm-provider";
import type { SessionMessage } from "../session";
import { SedimentationSuggester, computeSedimentationFingerprint } from "../eag/dynamic/sedimentation-suggester";

// ============================================================================
// 测试 fixture
// ============================================================================

/** 构造最小 SessionMessage */
function message(role: "user" | "assistant", content: string): SessionMessage {
  const now = new Date().toISOString();
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    sessionId: "test-session",
    role,
    content,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
  };
}

/** 构造最小 LLMResponse */
function response(content: string): LLMResponse {
  return { content } as unknown as LLMResponse;
}

/** 返回固定内容的 LLMClient 桩 */
function stubLLMClient(reply: string, calls: LLMRequest[] = []): LLMClient {
  return {
    createMessage: async (request: LLMRequest) => {
      calls.push(request);
      return response(reply);
    },
  } as unknown as LLMClient;
}

/** 合法建议 JSON（markdown 代码块包裹，验证解析兼容性） */
const VALID_REPLY =
  "```json\n" +
  JSON.stringify({
    suggestions: [
      {
        kind: "skill",
        name: "troubleshoot-api",
        description: "API 排查三步法",
        content: "# 排查步骤\n1. 看日志\n2. 查配置\n3. 复现",
        rationale: "对话中三次按同一流程排查 API 问题",
      },
    ],
  }) +
  "\n```";

/** 记录日志事件的 spy */
function createLogSpy() {
  const events: Array<Record<string, unknown>> = [];
  return { events, log: (event: Record<string, unknown>) => void events.push(event) };
}

// ============================================================================
// 正常产出
// ============================================================================

test("analyze 产出合法草稿（含指纹/rationale，代码块 JSON 可解析）", async () => {
  const calls: LLMRequest[] = [];
  const suggester = new SedimentationSuggester({
    createLLMClient: async () => stubLLMClient(VALID_REPLY, calls),
  });

  const suggestions = await suggester.analyze("session-a", [
    message("user", "API 又 502 了，怎么排查来着"),
    message("assistant", "按三步法：1. 看日志 2. 查配置 3. 复现"),
  ]);

  assert.equal(suggestions.length, 1);
  const suggestion = suggestions[0];
  assert.ok(suggestion);
  assert.equal(suggestion.draft.kind, "skill");
  assert.equal(suggestion.draft.name, "troubleshoot-api");
  assert.equal(suggestion.draft.description, "API 排查三步法");
  // 指纹：64 位十六进制，且与公开口径一致（sha256(name+description+content)）
  assert.match(suggestion.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(suggestion.fingerprint, computeSedimentationFingerprint(suggestion.draft));
  assert.match(suggestion.rationale, /三次/);
  // id 非空
  assert.ok(suggestion.id.length > 0);
  // prompt 消息包含对话轮次内容
  assert.equal(calls.length, 1);
});

test("analyze 空转录 / 非 user-assistant 消息不触发 LLM 调用", async () => {
  let callCount = 0;
  const suggester = new SedimentationSuggester({
    createLLMClient: async () => {
      callCount += 1;
      return stubLLMClient(VALID_REPLY);
    },
  });

  assert.deepEqual(await suggester.analyze("session-b", []), []);
  assert.deepEqual(
    await suggester.analyze("session-b", [
      {
        ...message("user", "系统消息不算轮次"),
        role: "system",
      } as unknown as SessionMessage,
    ]),
    []
  );
  assert.equal(callCount, 0, "无可分析轮次时不应调用 LLM");
});

// ============================================================================
// 失败安全（T02 验收①）
// ============================================================================

test("analyze：LLM 工厂返回 null → 空数组不抛错", async () => {
  const spy = createLogSpy();
  const suggester = new SedimentationSuggester({ createLLMClient: async () => null, log: spy.log });

  const suggestions = await suggester.analyze("session-c", [message("user", "随便聊聊")]);
  assert.deepEqual(suggestions, []);
  const skipEvents = spy.events.filter((event) => event.event === "sediment-analyze-skip");
  assert.equal(skipEvents.length, 1, "null 降级应有结构化日志");
});

test("analyze：LLM 调用抛异常 → 空数组不抛错（degrade 日志）", async () => {
  const spy = createLogSpy();
  const suggester = new SedimentationSuggester({
    createLLMClient: async () => {
      throw new Error("网络超时");
    },
    log: spy.log,
  });

  const suggestions = await suggester.analyze("session-d", [message("user", "随便聊聊")]);
  assert.deepEqual(suggestions, []);
  const degradeEvents = spy.events.filter((event) => event.event === "sediment-analyze-degrade");
  assert.equal(degradeEvents.length, 1);
});

test("analyze：LLM 客户端 createMessage 抛异常 → 空数组不抛错", async () => {
  const suggester = new SedimentationSuggester({
    createLLMClient: async () =>
      ({
        createMessage: async () => {
          throw new Error("rate limited");
        },
      }) as unknown as LLMClient,
  });

  const suggestions = await suggester.analyze("session-e", [message("user", "随便聊聊")]);
  assert.deepEqual(suggestions, []);
});

test("analyze：空输出 / 非法 JSON / 缺 suggestions 字段 → 空数组", async () => {
  for (const badReply of ["", "不是 JSON", '{"foo": 1}', '{"suggestions": "not-array"}']) {
    const suggester = new SedimentationSuggester({ createLLMClient: async () => stubLLMClient(badReply) });
    const suggestions = await suggester.analyze("session-f", [message("user", "随便聊聊")]);
    assert.deepEqual(suggestions, [], `回复「${badReply}」应降级为空数组`);
  }
});

test("analyze：非法草稿条目被丢弃，合法条目保留", async () => {
  const reply = JSON.stringify({
    suggestions: [
      { kind: "skill", name: "Bad_Name", description: "非法名称", content: "x" },
      { kind: "skill", name: "no-desc", description: "", content: "x" },
      { kind: "agent", name: "no-role-agent", description: "缺 role", content: "x" },
      { kind: "unknown-kind", name: "kind-bad", description: "未知种类", content: "x" },
      { kind: "agent", name: "good-agent", description: "合法 agent", role: "排错专家", content: "# 约束" },
      { kind: "skill", name: "no-content", description: "缺正文", content: "  " },
    ],
  });
  const suggester = new SedimentationSuggester({ createLLMClient: async () => stubLLMClient(reply) });

  const suggestions = await suggester.analyze("session-g", [message("user", "教我排错")]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.draft.kind, "agent");
  assert.equal(suggestions[0]?.draft.name, "good-agent");
  assert.equal(suggestions[0]?.draft.role, "排错专家");
});

// ============================================================================
// 会话内去重（T02 验收③）
// ============================================================================

test("同一指纹重复 analyze 不再建议（会话内去重）", async () => {
  const suggester = new SedimentationSuggester({ createLLMClient: async () => stubLLMClient(VALID_REPLY) });
  const transcript = [message("user", "API 排查"), message("assistant", "三步法")];

  const first = await suggester.analyze("session-h", transcript);
  assert.equal(first.length, 1);
  const second = await suggester.analyze("session-h", transcript);
  assert.deepEqual(second, [], "同会话重复模式不应重复建议");
});

test("dismiss 后同指纹不再建议，其他指纹不受影响", async () => {
  const reply = JSON.stringify({
    suggestions: [
      { kind: "skill", name: "pattern-a", description: "模式 A", content: "A 正文", rationale: "反复出现 A" },
      { kind: "skill", name: "pattern-b", description: "模式 B", content: "B 正文", rationale: "反复出现 B" },
    ],
  });
  const suggester = new SedimentationSuggester({ createLLMClient: async () => stubLLMClient(reply) });
  const transcript = [message("user", "继续排错")];

  const first = await suggester.analyze("session-i", transcript);
  assert.equal(first.length, 2);
  const dismissed = first.find((suggestion) => suggestion.draft.name === "pattern-a");
  assert.ok(dismissed);
  suggester.dismiss("session-i", dismissed.fingerprint);

  const second = await suggester.analyze("session-i", transcript);
  // pattern-b 也已建议过（指纹已入集合），第二次均为空——两者都不再重复建议
  assert.deepEqual(second, []);

  // 新会话不受影响（去重按会话隔离）
  const other = await suggester.analyze("session-j", transcript);
  assert.equal(other.length, 2);
});

test("dismiss 未曾建议的指纹不影响后续建议", async () => {
  const suggester = new SedimentationSuggester({ createLLMClient: async () => stubLLMClient(VALID_REPLY) });
  suggester.dismiss("session-k", "0".repeat(64));
  const suggestions = await suggester.analyze("session-k", [message("user", "API 排查")]);
  assert.equal(suggestions.length, 1);
});
