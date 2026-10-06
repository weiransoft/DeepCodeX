/**
 * 跨 run 失败守卫集成测试（修复 2026-10-06 第二条指令空转事故）
 *
 * 事故链路：/eag-autonomous 以 aborted/failed 终态结束后运行结果不落盘，
 * 下一条短指令（"继续"）被触发层把同一历史目标重新炒成执行决策
 * 无条件自动执行 → 逐字重演上一轮 12 轮空转。
 *
 * 修复语义（设计文档 docs/research/2026-10-eag-auto-loop-trigger-guard.md +
 * 0.4.3.11 触发层 LLM 化改造 docs/research/2026-10-eag-llm-intent-trigger.md）：
 * - 写侧：run 终态（goal 指纹 + finalStatus）落盘 SessionEntry.autonomousGoalRuns；
 * - 读侧：触发层 execute_command 决策派发前查询失败记录，命中且 LLM 未输出
 *   acknowledgeFailedGoal=true（知情重试）即硬拦截（D2 决策：硬拦截 + LLM 知情确认）；
 * - 逃生门：confirm_previous 决策（LLM 识别"执行这个"确认语义）= 用户显式知情重放，放行；
 * - completed 目标不拦（合法重放）。
 *
 * 测试模式：stub 注入（AutonomousOrchestrator / OpenAI client / EagDynamicSuggester
 * 均为注入式依赖），聚焦 replySession → handleUserPrompt 集成链路的守卫行为本身。
 * 注入确定性通道已随 0.4.3.11 删除，播种改经 execute_command 决策桩派发。
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionManager, extractGoalFromCommandString, normalizeGoalFingerprint } from "../session";
import type { EagDynamicSuggester, EagDynamicSuggestion } from "../eag/dynamic/eag-dynamic-suggester";
import type { AutonomousOrchestrator } from "../eag/p5/autonomous-orchestrator";
import type { AutonomousRunRequest, AutonomousRunResult } from "../eag/p5/autonomous-orchestrator";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * 构造固定返回的 EagDynamicSuggester 桩
 *
 * @param suggestion 预设的建议结果
 * @returns EagDynamicSuggester 桩实例
 */
function createStubSuggester(suggestion: EagDynamicSuggestion): EagDynamicSuggester {
  return {
    isEnabled: () => true,
    suggest: async () => suggestion,
  } as unknown as EagDynamicSuggester;
}

/**
 * 构造 execute_command 决策（0.4.3.11：LLM 判定的"第一次指令"）
 *
 * @param goal LLM 动态规划的目标文本
 * @param overrides 覆盖字段（如 acknowledgeFailedGoal 知情重试标记）
 * @returns execute_command 决策对象
 */
function createExecuteDecision(
  goal: string,
  overrides: Partial<Extract<EagDynamicSuggestion, { type: "execute_command" }>> = {}
): EagDynamicSuggestion {
  return {
    type: "execute_command",
    commandHint: "/eag-autonomous",
    goal,
    messageToUser: "即将执行 /eag-autonomous。",
    reasoning: "测试桩：明确可执行意图",
    ...overrides,
  };
}

/**
 * 构造按序返回终态的 AutonomousOrchestrator 桩
 *
 * run() 每次调用记录 AutonomousRunRequest 并从 finalStatuses 队列取一个终态
 * 返回（耗尽后复用最后一个），用于驱动写侧把不同终态落盘。
 *
 * @param finalStatuses 按序返回的终态列表（如 ["aborted", "failed"]）
 * @returns 包含 orchestrator 桩与 runRequests 记录数组的对象
 */
function createSequencedOrchestrator(finalStatuses: string[]): {
  orchestrator: AutonomousOrchestrator;
  runRequests: AutonomousRunRequest[];
} {
  const runRequests: AutonomousRunRequest[] = [];
  const orchestrator = {
    run: async (request: AutonomousRunRequest) => {
      runRequests.push(request);
      // 终态队列耗尽后复用最后一个（多次重放场景的桩语义）
      const status = finalStatuses[Math.min(runRequests.length - 1, finalStatuses.length - 1)];
      const runResult: AutonomousRunResult = {
        runId: `run-test-${runRequests.length}`,
        finalStatus: status as AutonomousRunResult["finalStatus"],
        exitCode: status === "completed" ? 0 : 1,
        completedLoops: [],
        milestones: [],
        totalIterations: 1,
        totalLlmCallCount: 1,
        totalTokensUsed: 100,
        durationSec: 1,
        finalReport: "测试桩最终报告",
        triggeredGuards: [],
      };
      return runResult;
    },
  } as unknown as AutonomousOrchestrator;
  return { orchestrator, runRequests };
}

/**
 * 构造固定回复的 OpenAI client 桩（主对话 LLM，守卫命中时不应被调用）
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
 * 构造测试用 SessionManager（收集 assistant 消息文本，便于断言拦截提示可见性）
 *
 * @param options.workspace 工作区临时目录
 * @param options.home home 临时目录
 * @param options.client OpenAI client 桩
 * @param options.orchestrator AutonomousOrchestrator 桩
 * @param options.suggester EagDynamicSuggester 桩（可选）
 * @returns SessionManager 实例与收集到的 assistant 消息文本数组
 */
function createTestManager(options: {
  workspace: string;
  home: string;
  client: unknown;
  orchestrator: AutonomousOrchestrator;
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
// N1 纯函数单元：指纹归一化 + 命令 --goal 提取
// ============================================================================

test("N1a. normalizeGoalFingerprint：空白折叠与大小写归一（格式抖动不漏判）", () => {
  // 连续空白折叠为单空格 + 小写化：同一目标的格式抖动必须得到同一指纹
  assert.equal(
    normalizeGoalFingerprint("  修复  登录 FAILED 问题 \t "),
    normalizeGoalFingerprint("修复 登录 failed 问题")
  );
  assert.equal(normalizeGoalFingerprint("A  B"), normalizeGoalFingerprint("a b"));
  // 中文目标不受 toLowerCase 影响
  assert.equal(normalizeGoalFingerprint("从46同步数据库到43"), normalizeGoalFingerprint("从46同步数据库到43"));
});

test("N1b. extractGoalFromCommandString：转义引号/反斜杠反向还原", () => {
  // 常规提取
  assert.equal(
    extractGoalFromCommandString('/eag-autonomous --goal "部署到远程服务器" --max-iterations 10 --confirmation smart'),
    "部署到远程服务器"
  );
  // buildAutoExecuteCommand 的转义还原：\\" → "，\\\\ → \
  assert.equal(extractGoalFromCommandString('/eag-autonomous --goal "说 \\"你好\\""'), '说 "你好"');
  assert.equal(extractGoalFromCommandString('/eag-autonomous --goal "路径 C:\\\\tmp"'), "路径 C:\\tmp");
  // 裸命令（无 --goal）返回 null
  assert.equal(extractGoalFromCommandString("/eag-autonomous"), null);
  // 不含 --goal 的其他命令返回 null
  assert.equal(extractGoalFromCommandString('/eag-design --requirement "ddd"'), null);
});

// ============================================================================
// N2 写侧：终态落盘 + 同指纹 upsert
// ============================================================================

test("N2. 写侧终态落盘：abort 后记录写入，同目标重跑 upsert 保留最新终态", async () => {
  const workspace = createTempDir("deepcode-goalguard-write-workspace-");
  const home = createTempDir("deepcode-goalguard-write-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  // 第一次 aborted、第二次 failed：验证 upsert 保留最新终态
  const { orchestrator, runRequests } = createSequencedOrchestrator(["aborted", "failed"]);
  // 触发层决策桩：execute_command 派发第一次运行（0.4.3.11 起唯一执行通道）
  const { manager } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createStubSuggester(createExecuteDecision("从46同步数据库到43采用full_overwrite全量覆盖")),
  });

  const sessionId = await manager.createSession({ text: "" });
  const goal = "从46同步数据库到43采用full_overwrite全量覆盖";

  // 第一次运行：execute_command 决策 → orchestrator.run → 终态 aborted 落盘
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 1);

  const session1 = manager.getSession(sessionId);
  const history1 = session1?.autonomousGoalRuns ?? [];
  assert.equal(history1.length, 1, "同一目标只保留一条记录（upsert 语义）");
  assert.equal(history1[0].finalStatus, "aborted", "第一次运行终态应为 aborted");
  assert.equal(history1[0].goalFingerprint, normalizeGoalFingerprint(goal));
  assert.ok(history1[0].endedAt.length > 0, "终态时间必须落盘");

  // 第二次运行（用户显式手输命令放行）：终态 failed 覆盖 aborted
  await manager.handleUserPrompt({ text: `/eag-autonomous --goal "${goal}" --max-iterations 10 --confirmation smart` });
  assert.equal(runRequests.length, 2);

  const session2 = manager.getSession(sessionId);
  const history2 = session2?.autonomousGoalRuns ?? [];
  assert.equal(history2.length, 1, "同指纹重跑不得产生第二条记录");
  assert.equal(history2[0].finalStatus, "failed", "upsert 必须保留最新终态");
});

// ============================================================================
// N3 execute_command 通道：失败目标拦截（设计文档 T6）
// ============================================================================

test("N3. execute_command 通道：已 abort 目标被重炒为执行决策 → 硬拦截 + 可见提示，orchestrator 零新增调用", async () => {
  const workspace = createTempDir("deepcode-goalguard-suggest-workspace-");
  const home = createTempDir("deepcode-goalguard-suggest-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createSequencedOrchestrator(["aborted"]);
  // 触发层决策桩：把任何输入都决策为同一历史目标的 execute_command（事故中的重放形态）
  const { manager, assistantTexts } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createStubSuggester(createExecuteDecision("从46同步数据库到43采用full_overwrite全量覆盖")),
  });

  const sessionId = await manager.createSession({ text: "" });
  const goal = "从46同步数据库到43采用full_overwrite全量覆盖";

  // 第一次：execute_command 决策启动，运行以 aborted 终态结束
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 1);
  // LLM 调用基线：以第一轮结束后的计数为准（对齐既有测试的相对断言风格）
  const baselineLlmCalls = callCount.value;

  // 第二次：短指令"继续"——决策桩再次输出同一目标的 execute_command（无知情标记）
  await manager.handleUserPrompt({ text: "继续" });

  // 核心断言：硬拦截生效——orchestrator.run 未被新增调用，不进入空转循环
  assert.equal(runRequests.length, 1, "失败目标不得被 execute_command 决策自动重放");
  // 拦截提示必须可见（含终态与逃生门指引），且主对话 LLM 未被调用（触发层已收敛本轮）
  const blockedMessage = assistantTexts.find((t) => t.includes("已拦截"));
  assert.ok(blockedMessage, "必须推送可见的拦截说明");
  assert.ok(blockedMessage.includes("aborted"), "拦截说明必须回显上一轮终态");
  assert.ok(blockedMessage.includes("执行这个"), "拦截说明必须给出逃生门指引");
  assert.equal(callCount.value, baselineLlmCalls, "拦截轮不得再消耗主对话 LLM 调用");
});

// ============================================================================
// N4 execute_command 通道：completed 目标不拦（合法重放）
// ============================================================================

test("N4. execute_command 通道：completed 目标重放不拦（'再跑一次'属合法场景）", async () => {
  const workspace = createTempDir("deepcode-goalguard-done-workspace-");
  const home = createTempDir("deepcode-goalguard-done-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createSequencedOrchestrator(["completed"]);
  const { manager } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createStubSuggester(createExecuteDecision("从46同步数据库到43采用full_overwrite全量覆盖")),
  });

  const sessionId = await manager.createSession({ text: "" });
  const goal = "从46同步数据库到43采用full_overwrite全量覆盖";

  // 第一次：execute_command 决策启动，completed 终态落盘
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 1);

  // 第二次：决策桩重炒同一目标——completed 记录不构成失败守卫，放行重放
  await manager.handleUserPrompt({ text: "继续" });
  assert.equal(runRequests.length, 2, "成功完成的目标允许被自动重放");
});

// ============================================================================
// N5 execute_command 通道：LLM 知情重试放行（设计文档 T7）
// ============================================================================

test("N5. execute_command 通道：LLM 知情重试（acknowledgeFailedGoal=true）放行失败目标重放", async () => {
  const workspace = createTempDir("deepcode-goalguard-ack-workspace-");
  const home = createTempDir("deepcode-goalguard-ack-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createSequencedOrchestrator(["aborted", "aborted"]);
  // 决策桩：带知情重试标记的 execute_command——LLM 结合运行终态历史判定
  // 用户输入明确表达知情重试（如"我改好配置了，重跑同一个目标"）
  const { manager, assistantTexts } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createStubSuggester(
      createExecuteDecision("从46同步数据库到43采用full_overwrite全量覆盖", { acknowledgeFailedGoal: true })
    ),
  });

  const sessionId = await manager.createSession({ text: "" });
  const goal = "从46同步数据库到43采用full_overwrite全量覆盖";

  // 第一次：运行以 aborted 终态结束（失败记录落盘）
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 1);

  // 第二次：同一失败目标 + 知情重试标记 → 守卫放行，直接派发
  const baselineLlmCalls = callCount.value;
  await manager.handleUserPrompt({ text: "配置已修复，重跑同一个目标" });
  assert.equal(runRequests.length, 2, "知情重试（acknowledgeFailedGoal=true）必须放行重放");
  assert.equal(runRequests[1].objective, goal, "重放 goal 必须与失败记录目标一致");
  assert.equal(assistantTexts.filter((t) => t.includes("已拦截")).length, 0, "知情重试不得触发拦截提示");
  assert.equal(callCount.value, baselineLlmCalls, "放行轮不得再消耗主对话 LLM 调用");
});

// ============================================================================
// N6 逃生门：confirm_previous 决策消费快照重放放行（设计文档 T8）
// ============================================================================

test("N6. 逃生门：拦截后用户回复'执行这个' → confirm_previous 决策消费快照放行重放", async () => {
  const workspace = createTempDir("deepcode-goalguard-escape-workspace-");
  const home = createTempDir("deepcode-goalguard-escape-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createSequencedOrchestrator(["aborted", "aborted"]);
  // 决策队列：第一轮执行（播种 aborted）→ 第二轮执行（拦截 + 存逃生门快照）→ 第三轮确认语义
  const suggestCalls = { value: 0 };
  const suggestions: EagDynamicSuggestion[] = [
    createExecuteDecision("从46同步数据库到43采用full_overwrite全量覆盖"),
    createExecuteDecision("从46同步数据库到43采用full_overwrite全量覆盖"),
    { type: "confirm_previous", messageToUser: "正在执行上一条建议。", reasoning: "用户显式确认重放" },
  ];
  const suggester = {
    isEnabled: () => true,
    suggest: async () => {
      const suggestion = suggestions[Math.min(suggestCalls.value, suggestions.length - 1)];
      suggestCalls.value++;
      return suggestion;
    },
  } as unknown as EagDynamicSuggester;
  const { manager, assistantTexts } = createTestManager({ workspace, home, client, orchestrator, suggester });

  const sessionId = await manager.createSession({ text: "" });
  const goal = "从46同步数据库到43采用full_overwrite全量覆盖";

  // 第一次：execute_command 决策启动，aborted 终态落盘
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 1);

  // 第二次：同一目标被硬拦截（存逃生门快照）
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 1);
  assert.ok(
    assistantTexts.some((t) => t.includes("已拦截")),
    "前置条件：拦截提示已推送"
  );

  // 第三次：用户显式确认重放——LLM 识别确认语义输出 confirm_previous，消费快照放行
  await manager.handleUserPrompt({ text: "执行这个" });
  assert.equal(runRequests.length, 2, "显式确认（confirm_previous 决策）必须放行重放");
  assert.equal(runRequests[1].objective, goal, "重放的 goal 必须与快照目标一致");
});

// ============================================================================
// N7 零回归：无失败记录的目标 execute_command 通道行为与改动前一致
// ============================================================================

test("N7. 零回归：无失败记录时 execute_command 决策照常派发执行", async () => {
  const workspace = createTempDir("deepcode-goalguard-baseline-workspace-");
  const home = createTempDir("deepcode-goalguard-baseline-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createSequencedOrchestrator(["completed"]);
  const { manager } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createStubSuggester(createExecuteDecision("帮我优化这段代码的性能")),
  });

  await manager.createSession({ text: "" });
  // 首次任务（无任何运行历史）：execute_command 决策直接派发
  await manager.handleUserPrompt({ text: "帮我优化这段代码的性能" });
  assert.equal(runRequests.length, 1, "无失败记录时 execute_command 决策必须正常派发");
  assert.equal(runRequests[0].objective, "帮我优化这段代码的性能");
});
