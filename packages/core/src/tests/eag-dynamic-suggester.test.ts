/**
 * EAG 智能建议层单元测试
 *
 * 测试范围（对齐 2026-07-24-eag-llm-dynamic-orchestration.md v1.4）：
 * - EagDynamicSuggester 构造函数参数校验
 * - 上下文校验：空目标、无可用命令
 * - LLM 调用失败 / 输出非 JSON / 未知 action / 低置信度 → 降级为 direct_chat
 * - 各类 action 解析：direct_chat、suggest_command、suggest_autonomous、suggest_graph、ask_clarification
 * - suggest_command 支持多命令体系（eag/team/rules/slash）
 * - commandHint 解析：必须命中可用命令清单
 * - ask_clarification 选项校验：缺少 question 或选项不足时降级
 * - clarification 回注：prompt 中应包含用户上一轮选择
 * - 置信度阈值配置生效
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock：LLMClient 使用真实 createMessage 签名桩，仅返回固定 JSON 文本
 * - 所有输入输出使用 Object.freeze 冻结（对齐不可变优先 §5.12.4 G-A6d）
 *
 * @module tests/eag-dynamic-suggester
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EagDynamicSuggester, createEagDynamicSuggester } from "../eag/dynamic/eag-dynamic-suggester";
import type { DynamicCommandDescriptor } from "../eag/dynamic/eag-dynamic-suggester";
import type { LLMClient, LLMResponse } from "../providers/llm-provider";

// ============================================================================
// 测试辅助
// ============================================================================

/**
 * 默认可用命令描述符清单（覆盖 EAG/Team/Rules/slash 四类命令体系）
 *
 * 用于大部分测试用例，确保建议层能识别全部命令体系。
 */
const ALL_COMMANDS: ReadonlyArray<DynamicCommandDescriptor> = Object.freeze([
  // EAG 命令
  Object.freeze({ category: "eag", id: "eag-design", name: "/eag-design", description: "设计阶段" }),
  Object.freeze({ category: "eag", id: "eag-build", name: "/eag-build", description: "编码实现阶段" }),
  Object.freeze({ category: "eag", id: "eag-autonomous", name: "/eag-autonomous", description: "多阶段自动循环" }),
  Object.freeze({ category: "eag", id: "eag-graph", name: "/eag-graph", description: "图编排入口" }),
  // Team 命令
  Object.freeze({ category: "team", id: "team-dispatch", name: "/team dispatch", description: "分派任务到角色" }),
  Object.freeze({ category: "team", id: "team-autonomous", name: "/team autonomous", description: "Ralph 自主迭代" }),
  // Rules 命令
  Object.freeze({ category: "rules", id: "rules-list", name: "/rules list", description: "列出规则" }),
  // Slash 命令
  Object.freeze({ category: "slash", id: "skills", name: "/skills", description: "列出技能" }),
  Object.freeze({ category: "slash", id: "model", name: "/model", description: "选择模型" }),
]);

/**
 * 构造固定返回的 LLMClient 桩
 *
 * @param content LLM 返回的文本内容（应为 JSON）
 * @returns LLMClient 实例
 */
function createStubLLMClient(content: string): LLMClient {
  return Object.freeze({
    providerName: "openai" as const,
    model: "test-model",
    baseURL: "https://test.example.com",
    supportsThinking: false,
    supportsPromptCaching: false,
    async createMessage(): Promise<LLMResponse> {
      return Object.freeze({
        content,
        thinking: "",
        toolCalls: [],
        stopReason: "stop",
        usage: Object.freeze({ inputTokens: 10, outputTokens: 20 }),
      });
    },
    async *createMessageStream(): AsyncIterable<never> {
      // 决策层不使用流式，空实现
    },
  });
}

/**
 * 构造最小建议器选项
 *
 * @param client LLMClient 桩
 * @param overrides 额外选项
 */
function createSuggesterOptions(
  client: LLMClient,
  overrides: Record<string, unknown> = {}
): ConstructorParameters<typeof EagDynamicSuggester>[0] {
  return Object.freeze({
    createDecisionLLMClient: () => client,
    enabled: true,
    confidenceThreshold: 0.6,
    maxDecisionTokens: 2048,
    ...overrides,
  }) as ConstructorParameters<typeof EagDynamicSuggester>[0];
}

// ============================================================================
// 构造函数与基础校验
// ============================================================================

test("EagDynamicSuggester 构造函数要求 createDecisionLLMClient 为函数", () => {
  assert.throws(
    () => new EagDynamicSuggester({ createDecisionLLMClient: undefined as unknown as () => LLMClient | null }),
    /createDecisionLLMClient 必须为函数/
  );
});

test("createEagDynamicSuggester 工厂函数返回实例", () => {
  const client = createStubLLMClient('{"action":"direct_chat","reasoning":"test"}');
  const suggester = createEagDynamicSuggester(createSuggesterOptions(client));
  assert.ok(suggester instanceof EagDynamicSuggester);
  assert.equal(suggester.isEnabled(), true);
});

test("isEnabled 返回 false 当 enabled 显式设为 false", () => {
  const client = createStubLLMClient('{"action":"direct_chat","reasoning":"test"}');
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client, { enabled: false }));
  assert.equal(suggester.isEnabled(), false);
});

test("空目标降级为 direct_chat", async () => {
  const client = createStubLLMClient('{"action":"suggest_command","commandHint":"/eag-design","confidence":0.9}');
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "direct_chat");
});

test("无可用命令时降级为 direct_chat", async () => {
  const client = createStubLLMClient('{"action":"suggest_command","commandHint":"/eag-design","confidence":0.9}');
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "设计登录模块",
    availableCommands: Object.freeze([]),
  });
  assert.equal(suggestion.type, "direct_chat");
});

test("LLMClient 不可用时降级为 direct_chat", async () => {
  const suggester = new EagDynamicSuggester(
    Object.freeze({
      createDecisionLLMClient: () => null,
      enabled: true,
    })
  );
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "设计登录模块",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "direct_chat");
});

// ============================================================================
// 失败安全降级
// ============================================================================

test("LLM 调用异常时降级为 direct_chat", async () => {
  const client = Object.freeze({
    providerName: "openai" as const,
    model: "test-model",
    baseURL: "https://test.example.com",
    supportsThinking: false,
    supportsPromptCaching: false,
    async createMessage(): Promise<LLMResponse> {
      throw new Error("network timeout");
    },
    async *createMessageStream(): AsyncIterable<never> {},
  });
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "设计登录模块",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "direct_chat");
  assert.match((suggestion as { reasoning: string }).reasoning, /network timeout/);
});

test("LLM 输出非 JSON 时降级为 direct_chat", async () => {
  const client = createStubLLMClient("不是 JSON");
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "设计登录模块",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "direct_chat");
});

test("LLM 返回未知 action 时降级为 direct_chat", async () => {
  const client = createStubLLMClient('{"action":"unknown_action","confidence":0.9}');
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "设计登录模块",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "direct_chat");
});

test("置信度低于阈值时降级为 direct_chat", async () => {
  const client = createStubLLMClient('{"action":"suggest_command","commandHint":"/eag-design","confidence":0.4}');
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client, { confidenceThreshold: 0.6 }));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "设计登录模块",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "direct_chat");
  assert.match((suggestion as { reasoning: string }).reasoning, /0\.4/);
});

test("commandHint 不在可用清单时降级为 direct_chat", async () => {
  const client = createStubLLMClient('{"action":"suggest_command","commandHint":"/eag-unknown","confidence":0.9}');
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "设计登录模块",
    availableCommands: Object.freeze([
      Object.freeze({ category: "eag", id: "eag-design", name: "/eag-design", description: "设计阶段" }),
    ]),
  });
  assert.equal(suggestion.type, "direct_chat");
});

// ============================================================================
// 各 action 正常解析
// ============================================================================

test("direct_chat 建议直接返回", async () => {
  const client = createStubLLMClient('{"action":"direct_chat","reasoning":"这是闲聊","confidence":0.9}');
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "什么是 REST",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "direct_chat");
  assert.equal((suggestion as { reasoning: string }).reasoning, "这是闲聊");
});

test("suggest_command 解析 EAG 命令并映射 commandCategory/commandId", async () => {
  const client = createStubLLMClient(
    JSON.stringify({
      action: "suggest_command",
      commandCategory: "eag",
      commandId: "eag-design",
      commandHint: "/eag-design --spec 登录模块",
      messageToUser: "建议运行 /eag-design",
      reasoning: "单阶段设计任务",
      prerequisites: ["需要提供需求描述"],
      confidence: 0.9,
    })
  );
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "设计登录模块",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "suggest_command");
  if (suggestion.type === "suggest_command") {
    assert.equal(suggestion.commandCategory, "eag");
    assert.equal(suggestion.commandId, "eag-design");
    assert.equal(suggestion.commandHint, "/eag-design --spec 登录模块");
    assert.equal(suggestion.messageToUser, "建议运行 /eag-design");
    assert.equal(suggestion.reasoning, "单阶段设计任务");
    assert.deepEqual([...(suggestion.prerequisites ?? [])], ["需要提供需求描述"]);
  }
});

test("suggest_command 解析 Team 命令（多 token 命令名匹配）", async () => {
  const client = createStubLLMClient(
    JSON.stringify({
      action: "suggest_command",
      commandCategory: "team",
      commandId: "team-dispatch",
      commandHint: "/team dispatch --task 实现登录模块",
      messageToUser: "建议运行 /team dispatch 分派任务",
      reasoning: "需要角色分派",
      confidence: 0.85,
    })
  );
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "帮我实现登录模块",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "suggest_command");
  if (suggestion.type === "suggest_command") {
    assert.equal(suggestion.commandCategory, "team");
    assert.equal(suggestion.commandId, "team-dispatch");
  }
});

test("suggest_command 解析 Rules 命令", async () => {
  const client = createStubLLMClient(
    JSON.stringify({
      action: "suggest_command",
      commandCategory: "rules",
      commandId: "rules-list",
      commandHint: "/rules list",
      messageToUser: "建议运行 /rules list 查看规则",
      reasoning: "用户想查看规则",
      confidence: 0.9,
    })
  );
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "查看当前有哪些规则",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "suggest_command");
  if (suggestion.type === "suggest_command") {
    assert.equal(suggestion.commandCategory, "rules");
    assert.equal(suggestion.commandId, "rules-list");
  }
});

test("suggest_command 解析 Slash 命令", async () => {
  const client = createStubLLMClient(
    JSON.stringify({
      action: "suggest_command",
      commandCategory: "slash",
      commandId: "skills",
      commandHint: "/skills",
      messageToUser: "建议运行 /skills 查看可用技能",
      reasoning: "用户想查看技能",
      confidence: 0.9,
    })
  );
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "有哪些技能可用",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "suggest_command");
  if (suggestion.type === "suggest_command") {
    assert.equal(suggestion.commandCategory, "slash");
    assert.equal(suggestion.commandId, "skills");
  }
});

test("suggest_command 通过 commandHint 前缀降级匹配（缺少 commandCategory/commandId）", async () => {
  const client = createStubLLMClient(
    JSON.stringify({
      action: "suggest_command",
      commandHint: "/team autonomous --goal 实现登录",
      messageToUser: "建议运行 /team autonomous",
      reasoning: "多阶段任务",
      confidence: 0.85,
    })
  );
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "帮我实现一个完整登录系统",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "suggest_command");
  if (suggestion.type === "suggest_command") {
    // 降级匹配应命中 team-autonomous（最长 name 前缀匹配）
    assert.equal(suggestion.commandCategory, "team");
    assert.equal(suggestion.commandId, "team-autonomous");
  }
});

test("suggest_autonomous 正常解析", async () => {
  const client = createStubLLMClient(
    JSON.stringify({
      action: "suggest_autonomous",
      commandHint: "/eag-autonomous --goal 实现登录模块",
      messageToUser: "这是一个多阶段任务，建议运行 /eag-autonomous",
      reasoning: "需求模糊且涉及多个阶段",
      confidence: 0.88,
    })
  );
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "帮我实现一个登录模块",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "suggest_autonomous");
  if (suggestion.type === "suggest_autonomous") {
    assert.equal(suggestion.commandHint, "/eag-autonomous --goal 实现登录模块");
    assert.match(suggestion.messageToUser, /eag-autonomous/);
  }
});

test("suggest_graph 正常解析", async () => {
  const client = createStubLLMClient(
    JSON.stringify({
      action: "suggest_graph",
      commandHint: "/eag-graph --definition graph.json",
      messageToUser: "建议运行 /eag-graph 使用图定义文件",
      reasoning: "用户明确需要 DAG 并行编排",
      prerequisites: ["需要准备图定义 JSON 文件"],
      confidence: 0.9,
    })
  );
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "我需要并行执行多个设计任务，有条件路由",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "suggest_graph");
  if (suggestion.type === "suggest_graph") {
    assert.equal(suggestion.commandHint, "/eag-graph --definition graph.json");
    assert.deepEqual([...(suggestion.prerequisites ?? [])], ["需要准备图定义 JSON 文件"]);
  }
});

test("ask_clarification 正常解析（单选）", async () => {
  const client = createStubLLMClient(
    JSON.stringify({
      action: "ask_clarification",
      messageToUser: "需要确认认证方案",
      reasoning: "任务存在多种技术路径",
      question: "你希望使用哪种认证方案？",
      options: [
        { label: "OAuth 2.0", value: "oauth", description: "适合第三方接入" },
        { label: "JWT", value: "jwt", description: "轻量级方案" },
      ],
      multiSelect: false,
      confidence: 0.8,
    })
  );
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "帮我实现用户认证",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "ask_clarification");
  if (suggestion.type === "ask_clarification") {
    assert.equal(suggestion.question, "你希望使用哪种认证方案？");
    assert.equal(suggestion.options.length, 2);
    assert.equal(suggestion.multiSelect, false);
    assert.equal(suggestion.options[0]!.value, "oauth");
  }
});

test("ask_clarification 选项不足时降级为 direct_chat", async () => {
  const client = createStubLLMClient(
    JSON.stringify({
      action: "ask_clarification",
      messageToUser: "需要确认",
      reasoning: "歧义",
      question: "选哪个？",
      options: [{ label: "选项A", value: "a" }],
      multiSelect: false,
      confidence: 0.8,
    })
  );
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "帮我实现功能",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "direct_chat");
});

test("ask_clarification 缺少 question 时降级为 direct_chat", async () => {
  const client = createStubLLMClient(
    JSON.stringify({
      action: "ask_clarification",
      messageToUser: "需要确认",
      reasoning: "歧义",
      options: [
        { label: "选项A", value: "a" },
        { label: "选项B", value: "b" },
      ],
      multiSelect: false,
      confidence: 0.8,
    })
  );
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "帮我实现功能",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "direct_chat");
});

// ============================================================================
// JSON 提取兼容性
// ============================================================================

test("LLM 输出 markdown 代码块包裹的 JSON 也能正确解析", async () => {
  const client = createStubLLMClient('```json\n{"action":"direct_chat","reasoning":"闲聊","confidence":0.9}\n```');
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "你好",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "direct_chat");
  assert.equal((suggestion as { reasoning: string }).reasoning, "闲聊");
});

test("LLM 输出无语言标记的代码块包裹 JSON 也能正确解析", async () => {
  const client = createStubLLMClient('```\n{"action":"direct_chat","reasoning":"闲聊","confidence":0.9}\n```');
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "你好",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "direct_chat");
});

// ============================================================================
// 置信度边界
// ============================================================================

test("置信度等于阈值时正常返回建议", async () => {
  const client = createStubLLMClient(
    JSON.stringify({
      action: "suggest_command",
      commandCategory: "eag",
      commandId: "eag-design",
      commandHint: "/eag-design",
      messageToUser: "建议",
      reasoning: "设计任务",
      confidence: 0.6,
    })
  );
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client, { confidenceThreshold: 0.6 }));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "设计模块",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "suggest_command");
});

test("自定义置信度阈值生效", async () => {
  const client = createStubLLMClient(
    JSON.stringify({
      action: "suggest_command",
      commandCategory: "eag",
      commandId: "eag-design",
      commandHint: "/eag-design",
      messageToUser: "建议",
      reasoning: "设计任务",
      confidence: 0.7,
    })
  );
  // 阈值设为 0.8，0.7 < 0.8 应降级
  const suggester = new EagDynamicSuggester(createSuggesterOptions(client, { confidenceThreshold: 0.8 }));
  const suggestion = await suggester.suggest({
    sessionId: "s-1",
    projectRoot: "/test",
    goal: "设计模块",
    availableCommands: ALL_COMMANDS,
  });
  assert.equal(suggestion.type, "direct_chat");
});
