/**
 * EAG 触发层统一 LLM 决策集成测试（0.4.3.11：LLM 意图识别 + 任务动态规划）
 *
 * 设计文档：docs/research/2026-10-eag-llm-intent-trigger.md §4.1（T1-T17）
 *
 * 背景（0.4.3.11 改造）：原"确定性正则通道（tryDeterministicEagExecution：意图前缀 /
 * 字面量内嵌 / 指代确认短语）+ 建议层自动执行（Plan B）"两层结构已合并删除——
 * 第一次指令（execute_command）与第二次指令（confirm_previous）统一由
 * EagDynamicSuggester 单次 LLM 决策输出，不再依赖关键字/短语规则命中；
 * LLM 不可用/输出非法时降级 direct_chat（不自动执行，D1 决策）。
 *
 * 本文件覆盖 session.ts 侧触发层行为（用例编号对齐设计文档 §4.1）：
 * - T1  execute_command 派发 + 快照清除
 * - T2  direct_chat 走主对话
 * - T3  confirm_previous 消费快照（一次性语义）
 * - T4  快照被澄清问题清除后 confirm_previous 不执行
 * - T5  决策 LLM 不可用（D1）→ direct_chat 不自动执行
 * - T9  纯状态标签 direct_chat 不执行（LLM 语义判定）
 * - T10 execute_command 路由到 /eag-build（dispatch kind 分发）
 * - T11 execute_command 非 /eag- hint → 降级展示 + 存快照
 * - T12 否定输入 direct_chat 不执行
 * - T13 澄清轮选择后 execute_command 直接执行（refine，用户消息不重复记录）
 * - T14 P5 执行器重入守卫（p5TaskExecutionStorage=true 触发层整体跳过）
 * - T15 execute_command 派发失败（eag-graph 未接线）→ 降级展示 + 存快照（架构师 A2）
 * - T16 建议器未注入 → 跳过触发层走主对话
 * - T17 buildEagSuggestionPrompt 上下文区块注入（快照/运行历史/命令清单/澄清答案）
 *
 * T6/T7/T8（跨 run 失败守卫 + 知情确认 + 逃生门）见 session-eag-goal-failure-guard.test.ts。
 *
 * 测试模式：stub 注入（EagDynamicSuggester / OpenAI client / AutonomousOrchestrator
 * 均为注入式依赖，通过类型断言注入桩实现，聚焦 replySession 集成逻辑本身）。
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionManager } from "../session";
import type { EagDynamicSuggester, EagDynamicSuggestion } from "../eag/dynamic/eag-dynamic-suggester";
import type { AutonomousOrchestrator } from "../eag/p5/autonomous-orchestrator";
import type { AutonomousRunRequest, AutonomousRunResult } from "../eag/p5/autonomous-orchestrator";
import { p5TaskExecutionStorage } from "../eag/p5/executors/llm-task-executor";
import { buildEagSuggestionPrompt } from "../eag/dynamic/prompts/eag-suggestion-prompt";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

/** 跨平台设置 home 目录（Unix 用 HOME，Windows 用 USERPROFILE） */
function setHomeDir(dir: string): void {
  process.env.HOME = dir;
  if (process.platform === "win32") {
    process.env.USERPROFILE = dir;
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** 创建临时目录并自动注册清理 */
function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 构造按调用次序返回建议的 EagDynamicSuggester 桩
 *
 * suggest() 每次调用按序从队列取一个建议（耗尽后重复最后一项，对齐既有
 * createCountingSuggester 桩语义），同时记录调用次数供断言触发层是否被跳过。
 *
 * @param suggestions 按序返回的建议列表
 * @returns 包含 suggester 桩与 suggestCalls 计数的对象
 */
function createQueueSuggester(suggestions: EagDynamicSuggestion[]): {
  suggester: EagDynamicSuggester;
  suggestCalls: { value: number };
} {
  const suggestCalls = { value: 0 };
  const suggester = {
    isEnabled: () => true,
    suggest: async () => {
      const suggestion = suggestions[Math.min(suggestCalls.value, suggestions.length - 1)];
      suggestCalls.value++;
      return suggestion;
    },
  } as unknown as EagDynamicSuggester;
  return { suggester, suggestCalls };
}

/**
 * 构造记录调用参数的 AutonomousOrchestrator 桩
 *
 * run() 每次调用记录 AutonomousRunRequest 并返回 completed 终态
 * （失败终态场景见 session-eag-goal-failure-guard.test.ts 的 createSequencedOrchestrator）。
 *
 * @returns 包含 orchestrator 桩与 runRequests 记录数组的对象
 */
function createRecordingOrchestrator(): {
  orchestrator: AutonomousOrchestrator;
  runRequests: AutonomousRunRequest[];
} {
  const runRequests: AutonomousRunRequest[] = [];
  const runResult: AutonomousRunResult = {
    runId: "run-test-001",
    finalStatus: "completed",
    exitCode: 0,
    completedLoops: [],
    milestones: [],
    totalIterations: 1,
    totalLlmCallCount: 1,
    totalTokensUsed: 100,
    durationSec: 1,
    finalReport: "测试桩最终报告",
    triggeredGuards: [],
  };
  const orchestrator = {
    run: async (request: AutonomousRunRequest) => {
      runRequests.push(request);
      return runResult;
    },
  } as unknown as AutonomousOrchestrator;
  return { orchestrator, runRequests };
}

/**
 * 构造记录调用次数的 OpenAI client 桩（主对话 LLM 调用计数）
 *
 * @param responseContent LLM 返回的文本内容
 * @returns 包含 client 和 callCount 引用的 client 桩
 */
function createCallCountingClient(responseContent: string): {
  client: unknown;
  callCount: { value: number };
} {
  const callCount = { value: 0 };
  const client = {
    chat: {
      completions: {
        create: async (_request: Record<string, unknown>) => {
          callCount.value++;
          return createChatStreamResponse([
            { choices: [{ delta: { content: responseContent } }] },
            {
              choices: [],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          ]);
        },
      },
    },
  };
  return { client, callCount };
}

/** 构造流式响应 AsyncGenerator */
async function* createChatStreamResponse(
  chunks: ReadonlyArray<Record<string, unknown>>
): AsyncGenerator<Record<string, unknown>> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/**
 * 构造测试用 SessionManager（收集 assistant 消息文本，便于断言展示内容）
 *
 * @param options.workspace 工作区临时目录
 * @param options.home home 临时目录
 * @param options.client OpenAI client 桩
 * @param options.orchestrator AutonomousOrchestrator 桩（可选）
 * @param options.suggester EagDynamicSuggester 桩（可选）
 * @returns SessionManager 实例与收集到的 assistant 消息文本数组
 */
function createTestManager(options: {
  workspace: string;
  home: string;
  client: unknown;
  orchestrator?: AutonomousOrchestrator;
  suggester?: EagDynamicSuggester;
}): { manager: SessionManager; assistantTexts: string[] } {
  const assistantTexts: string[] = [];
  const manager = new SessionManager({
    projectRoot: options.workspace,
    createOpenAIClient: () => ({
      client: options.client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text: string) => text,
    onAssistantMessage: (message: { content?: string }) => {
      assistantTexts.push(message.content ?? "");
    },
    autonomousOrchestrator: options.orchestrator,
    eagDynamicSuggester: options.suggester,
  });
  return { manager, assistantTexts };
}

// ============================================================================
// T1：第一次指令——execute_command 派发 + 快照清除
// ============================================================================

test("T1. execute_command：LLM 判定的第一次指令直接派发，快照一次性清除", async () => {
  const workspace = createTempDir("deepcode-eagtrigger-t1-workspace-");
  const home = createTempDir("deepcode-eagtrigger-t1-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  // 决策队列：第一轮 execute_command（立即执行），第二轮 confirm_previous（验证快照已被清除）
  const { suggester } = createQueueSuggester([
    {
      type: "execute_command",
      commandHint: "/eag-autonomous",
      goal: "从46同步数据库到43采用full_overwrite全量覆盖",
      messageToUser: "即将执行 /eag-autonomous。",
      reasoning: "用户明确表达可执行意图",
    },
    { type: "confirm_previous", messageToUser: "确认执行。", reasoning: "确认语义" },
  ]);
  const { manager } = createTestManager({ workspace, home, client, orchestrator, suggester });

  const sessionId = await manager.createSession({ text: "" });
  const baselineLlmCalls = callCount.value;

  // 第一轮：自然语言第一次指令 → LLM 决策 execute_command → 派发
  await manager.handleUserPrompt({ text: "启动 EAG 自主任务：从46同步数据库到43" });
  assert.equal(runRequests.length, 1, "execute_command 决策应派发一次 /eag-autonomous");
  assert.equal(
    runRequests[0].objective,
    "从46同步数据库到43采用full_overwrite全量覆盖",
    "goal 应来自 LLM 动态规划输出的独立字段"
  );
  assert.equal(callCount.value, baselineLlmCalls, "执行轮不应再走主对话 LLM");

  // 第二轮：confirm_previous 决策——快照已在执行时清除 → 无快照可确认 → 交回主对话
  await manager.handleUserPrompt({ text: "执行这个" });
  assert.equal(runRequests.length, 1, "快照已清除，confirm_previous 不得重复执行");
  assert.ok(callCount.value > baselineLlmCalls, "无快照的 confirm_previous 应交回主对话");
});

// ============================================================================
// T2 / T9 / T12：direct_chat 语义（泛化请求 / 状态标签 / 否定输入）
// ============================================================================

test("T2. direct_chat：泛化请求不派发，走 LLM 主对话", async () => {
  const workspace = createTempDir("deepcode-eagtrigger-t2-workspace-");
  const home = createTempDir("deepcode-eagtrigger-t2-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("这只是普通对话，无需自动编排。");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  const { manager } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createQueueSuggester([{ type: "direct_chat", reasoning: "泛化请求不构成可执行意图" }]).suggester,
  });

  const sessionId = await manager.createSession({ text: "" });
  const baselineLlmCalls = callCount.value;
  await manager.handleUserPrompt({ text: "帮我自动循环播放音乐" });

  assert.equal(runRequests.length, 0, "direct_chat 决策不得触发任何 EAG 执行");
  assert.ok(callCount.value > baselineLlmCalls, "direct_chat 应走 LLM 主对话");
});

test("T9. 纯状态标签：LLM 判定 direct_chat 不执行（0.4.3.11 后由 prompt 规则保证）", async () => {
  const workspace = createTempDir("deepcode-eagtrigger-t9-workspace-");
  const home = createTempDir("deepcode-eagtrigger-t9-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("这是历史状态记录，无需重新执行。");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  const { manager } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createQueueSuggester([{ type: "direct_chat", reasoning: "纯终态状态标签无实质可执行意图" }]).suggester,
  });

  const sessionId = await manager.createSession({ text: "" });
  await manager.handleUserPrompt({ text: "继续 —— 已完成（2026-10-04 人工接管并实测验证）" });

  assert.equal(runRequests.length, 0, "状态标签输入不得触发自动执行");
  const session = manager.getSession(sessionId);
  assert.equal(session?.status, "completed", "主对话处理后应正常收敛");
});

test("T12. 否定输入：LLM 判定 direct_chat 不执行", async () => {
  const workspace = createTempDir("deepcode-eagtrigger-t12-workspace-");
  const home = createTempDir("deepcode-eagtrigger-t12-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("好的，不启动。");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  const { manager } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createQueueSuggester([{ type: "direct_chat", reasoning: "否定表述不构成执行意图" }]).suggester,
  });

  const sessionId = await manager.createSession({ text: "" });
  const baselineLlmCalls = callCount.value;
  await manager.handleUserPrompt({ text: "不要启动自主任务同步数据库" });

  assert.equal(runRequests.length, 0, "否定输入不得触发 /eag-autonomous 执行");
  assert.ok(callCount.value > baselineLlmCalls, "否定输入应走 LLM 主对话");
});

// ============================================================================
// T3 / T4：第二次指令——confirm_previous 消费快照
// ============================================================================

test("T3. confirm_previous：第二次指令消费快照执行，一次性语义", async () => {
  const workspace = createTempDir("deepcode-eagtrigger-t3-workspace-");
  const home = createTempDir("deepcode-eagtrigger-t3-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  // 决策队列：第一轮仅展示建议（0.4.3.11：suggest_* 不再自动执行），第二轮确认执行
  const { suggester } = createQueueSuggester([
    {
      type: "suggest_autonomous",
      commandHint: "/eag-autonomous",
      messageToUser: "建议启动自主任务处理该目标。",
      reasoning: "多阶段任务",
    },
    { type: "confirm_previous", messageToUser: "正在执行上一条建议。", reasoning: "用户确认语义" },
  ]);
  const { manager } = createTestManager({ workspace, home, client, orchestrator, suggester });

  const sessionId = await manager.createSession({ text: "" });
  const goal = "从46同步数据库到43采用full_overwrite全量覆盖";

  // 第一轮：建议展示（不执行），快照存储
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 0, "suggest_autonomous 新语义仅展示，不自动执行");

  // 第二轮：第二次指令 → confirm_previous → 消费快照执行
  await manager.handleUserPrompt({ text: "执行这个全量覆盖！" });
  assert.equal(runRequests.length, 1, "确认语义应消费快照派发执行");
  assert.equal(runRequests[0].objective, goal, "重放 goal 必须与快照目标一致");

  // 第三轮：快照已一次性消费 → 再次确认不再执行
  await manager.handleUserPrompt({ text: "再执行一次" });
  assert.equal(runRequests.length, 1, "快照一次性消费，不得重复执行");
});

test("T4. 快照被澄清问题清除后，confirm_previous 不执行", async () => {
  const workspace = createTempDir("deepcode-eagtrigger-t4-workspace-");
  const home = createTempDir("deepcode-eagtrigger-t4-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  // 决策队列：建议展示 → 澄清问题（清除快照成为新焦点）→ 确认语义
  const { suggester, suggestCalls } = createQueueSuggester([
    {
      type: "suggest_autonomous",
      commandHint: "/eag-autonomous",
      messageToUser: "建议启动自主任务。",
      reasoning: "多阶段任务",
    },
    {
      type: "ask_clarification",
      question: "目标环境是哪两台机器？",
      options: [
        { value: "46-43", label: "46 → 43" },
        { value: "43-46", label: "43 → 46" },
      ],
      multiSelect: false,
      messageToUser: "需要澄清目标环境",
      reasoning: "需求模糊",
    },
    { type: "confirm_previous", messageToUser: "确认执行。", reasoning: "确认语义" },
  ]);
  const { manager } = createTestManager({ workspace, home, client, orchestrator, suggester });

  const sessionId = await manager.createSession({ text: "" });

  // 第一轮：建议展示 → 快照存储
  await manager.handleUserPrompt({ text: "同步数据库" });
  // 第二轮：澄清问题 → 快照被清除（澄清问题取代建议成为当前焦点）
  await manager.handleUserPrompt({ text: "1" });
  // 第三轮：确认语义——快照已被澄清清除 → 无快照 → 交回主对话
  await manager.handleUserPrompt({ text: "执行这个" });

  assert.equal(suggestCalls.value, 3, "三轮输入均应经过触发层 LLM 决策");
  assert.equal(runRequests.length, 0, "快照已被澄清清除，confirm_previous 不得执行");
  assert.ok(callCount.value > 0, "无快照确认应交回 LLM 主对话");
});

// ============================================================================
// T5：D1 降级——决策 LLM 不可用 → direct_chat 不自动执行
// ============================================================================

test("T5. D1 降级：决策 LLM 不可用时 direct_chat 走主对话，不自动执行", async () => {
  const workspace = createTempDir("deepcode-eagtrigger-t5-workspace-");
  const home = createTempDir("deepcode-eagtrigger-t5-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("决策服务暂不可用，我先直接回复你。");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  // 真实 EagDynamicSuggester + 决策 LLM 工厂返回 null（LLM 不可用形态）
  const realSuggester = new (await import("../eag/dynamic/eag-dynamic-suggester")).EagDynamicSuggester({
    createDecisionLLMClient: () => null,
    enabled: true,
  });
  const { manager } = createTestManager({ workspace, home, client, orchestrator, suggester: realSuggester });

  const sessionId = await manager.createSession({ text: "" });
  const baselineLlmCalls = callCount.value;
  // 输入是明确的 EAG 执行意图——但决策 LLM 不可用，必须降级 direct_chat（D1：无正则兜底）
  await manager.handleUserPrompt({ text: "启动 EAG 自主任务：从46同步数据库到43" });

  assert.equal(runRequests.length, 0, "LLM 不可用时绝不自动执行（D1 决策）");
  assert.ok(callCount.value > baselineLlmCalls, "D1 降级应走 LLM 主对话");
});

// ============================================================================
// T10 / T11 / T15：execute_command 派发路径（kind 路由 / 非 EAG hint / 派发失败降级）
// ============================================================================

test("T10. execute_command 指向 /eag-build：前置文档缺失无法内联派发 → 降级展示 + 快照逃生门", async () => {
  const workspace = createTempDir("deepcode-eagtrigger-t10-workspace-");
  const home = createTempDir("deepcode-eagtrigger-t10-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  // 决策队列：第一轮 execute_command 指向 /eag-build（LLM 违反 prompt 前置约束的防御场景），
  // 第二轮 confirm_previous 验证逃生门快照已存
  const { suggester } = createQueueSuggester([
    {
      type: "execute_command",
      commandHint: "/eag-build",
      goal: "实现用户登录模块",
      messageToUser: "即将执行 /eag-build。",
      reasoning: "编码实现意图",
    },
    { type: "confirm_previous", messageToUser: "确认执行。", reasoning: "确认语义" },
  ]);
  const { manager, assistantTexts } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester,
  });

  const sessionId = await manager.createSession({ text: "" });
  const baselineLlmCalls = callCount.value;
  await manager.handleUserPrompt({ text: "帮我实现用户登录模块" });

  // CodingLoopRequest 必须经 messageParams 预装配（spec/plan/tasks/taskDag），
  // EagCommandParser 对 /eag-build 为严格匹配（不支持内联 --goal）→ dispatch false
  // → 降级展示 + 存快照（架构师 A2：降级必须保逃生门）。本回合被消费：主对话不被调用
  assert.equal(runRequests.length, 0, "/eag-build 无预装配 payload，不得派发自主编排器");
  assert.equal(callCount.value, baselineLlmCalls, "降级展示消费的回合不应再走主对话 LLM");
  const displayed = assistantTexts.find((t) => t.includes("/eag-build"));
  assert.ok(displayed, "派发失败应降级展示建议文本");
  assert.ok(displayed.includes("本轮未能自动执行"), "降级展示应说明未执行原因");
  assert.ok(displayed.includes("确认无误请回复"), "降级展示应附确认指引（A2 逃生门）");
  assert.equal(manager.getSession(sessionId)?.status, "completed", "降级展示后应正常收敛");

  // 第二轮：confirm_previous 消费逃生门快照 → buildAutoExecuteCommand("/eag-build", goal)
  // 同样无法经 parser 派发 → warn 后 return false 交回主对话（快照一次性消费，不残留）
  await manager.handleUserPrompt({ text: "执行这个" });
  assert.equal(runRequests.length, 0, "逃生门重放同样不得派发（无预装配 payload）");
  assert.ok(callCount.value > baselineLlmCalls, "逃生门重放失败应交回主对话");
});

test("T11. execute_command 非 /eag- hint：降级展示 + 存快照（逃生门语义完整）", async () => {
  const workspace = createTempDir("deepcode-eagtrigger-t11-workspace-");
  const home = createTempDir("deepcode-eagtrigger-t11-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  // 决策队列：第一轮 execute_command 但 hint 指向非 EAG 命令体系；第二轮确认语义
  const { suggester } = createQueueSuggester([
    {
      type: "execute_command",
      commandHint: "/team autonomous",
      goal: "多阶段重构任务",
      messageToUser: "建议运行 /team autonomous。",
      reasoning: "多角色任务",
    },
    { type: "confirm_previous", messageToUser: "确认执行。", reasoning: "确认语义" },
  ]);
  const { manager, assistantTexts } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester,
  });

  const sessionId = await manager.createSession({ text: "" });

  // 第一轮：非 /eag- hint → 降级展示（架构师 A2：必须存快照保逃生门）
  await manager.handleUserPrompt({ text: "多阶段重构任务" });
  assert.equal(runRequests.length, 0, "非 /eag- hint 不得派发");
  const displayed = assistantTexts.find((t) => t.includes("/team autonomous"));
  assert.ok(displayed, "降级时应展示建议文本");
  assert.ok(displayed.includes("确认无误请回复"), "降级展示应附确认指引");

  // 第二轮：confirm_previous 消费快照——buildAutoExecuteCommand 产出 /team 命令，
  // dispatchEagCommandString 无法识别 → return false → 交回主对话
  const baselineLlmCalls = callCount.value;
  await manager.handleUserPrompt({ text: "执行这个" });
  assert.equal(runRequests.length, 0, "非 EAG 命令确认执行仍受限（dispatch 待扩展）");
  assert.ok(callCount.value > baselineLlmCalls, "派发失败的确认应交回主对话");
});

test("T15. execute_command 派发失败（eag-graph 未接线）：降级展示 + 存快照（A2）", async () => {
  const workspace = createTempDir("deepcode-eagtrigger-t15-workspace-");
  const home = createTempDir("deepcode-eagtrigger-t15-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  const { manager, assistantTexts } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createQueueSuggester([
      {
        type: "execute_command",
        commandHint: "/eag-graph",
        goal: "生成依赖图谱",
        messageToUser: "即将执行 /eag-graph。",
        reasoning: "图谱编排意图",
      },
    ]).suggester,
  });

  const sessionId = await manager.createSession({ text: "" });
  await manager.handleUserPrompt({ text: "帮我生成依赖图谱" });

  // eag-graph kind 未在 dispatchEagCommandString 接线 → dispatch false → 降级展示 + 存快照
  assert.equal(runRequests.length, 0, "未接线 kind 不得派发");
  const displayed = assistantTexts.find((t) => t.includes("/eag-graph"));
  assert.ok(displayed, "派发失败应降级展示建议文本");
  assert.ok(displayed.includes("确认无误请回复"), "降级展示应附确认指引（A2 逃生门）");
});

// ============================================================================
// T13：澄清轮选择后 refine 直接执行
// ============================================================================

test("T13. 澄清轮选择后 execute_command 直接执行，refine goal 为澄清前原始目标", async () => {
  const workspace = createTempDir("deepcode-eagtrigger-t13-workspace-");
  const home = createTempDir("deepcode-eagtrigger-t13-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  // 决策队列：第一轮追问澄清；第二轮（用户选择后 refine）execute_command
  const { suggester } = createQueueSuggester([
    {
      type: "ask_clarification",
      question: "采用哪种覆盖策略？",
      options: [
        { value: "full_overwrite", label: "全量覆盖" },
        { value: "incremental", label: "增量同步" },
      ],
      multiSelect: false,
      messageToUser: "需要澄清覆盖策略",
      reasoning: "策略分歧",
    },
    {
      type: "execute_command",
      commandHint: "/eag-autonomous",
      goal: "从46同步数据库到43采用full_overwrite全量覆盖",
      messageToUser: "即将执行 /eag-autonomous。",
      reasoning: "澄清完成，意图充分",
    },
  ]);
  const { manager } = createTestManager({ workspace, home, client, orchestrator, suggester });

  const sessionId = await manager.createSession({ text: "" });

  // 第一轮：澄清问题展示
  await manager.handleUserPrompt({ text: "从46同步数据库到43" });
  // 第二轮：用户选择选项 1 → refine 直接执行（goal 合并为澄清前原始目标 + 澄清答案上下文）
  await manager.handleUserPrompt({ text: "1" });

  assert.equal(runRequests.length, 1, "澄清选择后的 execute_command 应直接派发");
  assert.equal(runRequests[0].objective, "从46同步数据库到43采用full_overwrite全量覆盖");

  // 用户消息记录断言：execute 路径跳过预记录（handler 记录命令字符串形态），
  // 用户的选择文本"1"不得作为独立用户消息重复出现
  const messages = manager.listSessionMessages(sessionId);
  const selectAnswers = messages.filter((msg) => msg.role === "user" && msg.content === "1");
  assert.equal(selectAnswers.length, 0, "execute 路径跳过预记录，用户选择文本不得重复入史");
});

// ============================================================================
// T14：P5 执行器重入守卫（p5TaskExecutionStorage=true）
// ============================================================================

test("T14. P5 重入守卫：p5TaskExecutionStorage=true 时触发层整体跳过走主对话", async () => {
  const workspace = createTempDir("deepcode-eagtrigger-t14-workspace-");
  const home = createTempDir("deepcode-eagtrigger-t14-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  // 决策桩：任何调用都返回 execute_command——若触发层未被守卫跳过将派发执行
  const { suggester, suggestCalls } = createQueueSuggester([
    {
      type: "execute_command",
      commandHint: "/eag-autonomous",
      goal: "重入目标",
      messageToUser: "即将执行。",
      reasoning: "回显触发",
    },
  ]);
  const { manager } = createTestManager({ workspace, home, client, orchestrator, suggester });

  const sessionId = await manager.createSession({ text: "" });
  const baselineLlmCalls = callCount.value;

  // 在 P5 任务执行器 AsyncLocalStorage 上下文内发起输入（模型回显触发语义）
  await p5TaskExecutionStorage.run(true, async () => {
    await manager.handleUserPrompt({ text: "启动 EAG 自主任务：重入目标" });
  });

  assert.equal(suggestCalls.value, 0, "P5 重入上下文中触发层 LLM 决策不得被调用");
  assert.equal(runRequests.length, 0, "P5 重入上下文中不得嵌套启动编排器");
  assert.ok(callCount.value > baselineLlmCalls, "重入输入应走 LLM 主对话");
});

// ============================================================================
// T16：建议器未注入 → 跳过触发层
// ============================================================================

test("T16. 建议器未注入：跳过触发层，输入直达 LLM 主对话", async () => {
  const workspace = createTempDir("deepcode-eagtrigger-t16-workspace-");
  const home = createTempDir("deepcode-eagtrigger-t16-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  // 不注入 suggester（options.suggester 为 undefined）
  const { manager } = createTestManager({ workspace, home, client, orchestrator });

  const sessionId = await manager.createSession({ text: "" });
  const baselineLlmCalls = callCount.value;
  await manager.handleUserPrompt({ text: "启动 EAG 自主任务：从46同步数据库到43" });

  assert.equal(runRequests.length, 0, "无建议器时不得触发任何自动执行");
  assert.ok(callCount.value > baselineLlmCalls, "无建议器时输入应直达 LLM 主对话");
});

// ============================================================================
// T17：buildEagSuggestionPrompt 上下文区块注入（prompt 单测）
// ============================================================================

test("T17. buildEagSuggestionPrompt：输出含快照/运行历史/命令清单/澄清答案四类上下文区块", () => {
  const messages = buildEagSuggestionPrompt({
    goal: "执行这个",
    availableCommands: [
      { category: "eag", id: "eag-autonomous", name: "/eag-autonomous", description: "多阶段自动循环" },
    ],
    clarification: ["全量覆盖"],
    previousSuggestion: { commandHint: "/eag-autonomous", goal: "从46同步数据库到43" },
    autonomousGoalRuns: [{ goal: "从46同步数据库到43", finalStatus: "aborted", endedAt: "2026-10-06T00:00:00.000Z" }],
    recentMessages: [{ role: "user", content: "从46同步数据库到43" }],
  });

  // 消息结构：system（角色 + 决策规则 + 命令清单）+ user（上下文区块 + 目标）
  assert.equal(messages.length, 2, "prompt 应为 system + user 两条消息");
  const systemText = messages[0].content;
  const userText = messages[1].content;

  // 区块 1：命令清单（system 内，含 /eag-autonomous 描述）
  assert.ok(systemText.includes("/eag-autonomous"), "命令清单应包含可用命令名");
  assert.ok(systemText.includes("触发层统一决策助手"), "system 角色应为触发层统一决策助手");
  // 区块 2：上一条建议快照（confirm_previous 指代确认识别依据）
  assert.ok(userText.includes("上一条展示过的建议快照"), "应注入建议快照区块");
  assert.ok(userText.includes("/eag-autonomous"), "快照区块应含命令提示");
  assert.ok(userText.includes("从46同步数据库到43"), "快照区块应含目标文本");
  // 区块 3：自主运行终态历史（知情重试判定依据）
  assert.ok(userText.includes("自主运行终态历史"), "应注入运行终态历史区块");
  assert.ok(userText.includes("aborted"), "历史区块应含终态标签");
  // 区块 4：澄清答案（refine 流程）
  assert.ok(userText.includes("上一轮澄清选择"), "应注入澄清答案区块");
  assert.ok(userText.includes("全量覆盖"), "澄清区块应含用户选择");
});
