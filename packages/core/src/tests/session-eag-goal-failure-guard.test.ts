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
import {
  SessionManager,
  extractGoalFromCommandString,
  normalizeGoalFingerprint,
  startsWithConfirmExecutePhrase,
} from "../session";
import type { AutonomousGoalRunDetails, AutonomousGoalRunRecord } from "../session";
import { buildAutoExecuteCommand } from "../eag/suggestion-auto";
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

test("N5. execute_command 通道：LLM 知情重试（acknowledgeFailedGoal=true）放行失败目标重放，且重放命令含【重放约束】", async () => {
  const workspace = createTempDir("deepcode-goalguard-ack-workspace-");
  const home = createTempDir("deepcode-goalguard-ack-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("主对话回复");
  // 修复前用 createSequencedOrchestrator（无诊断数据）复刻「知情重试 = 裸重放」；
  // 现改用带真实诊断的桩，使知情重试放行后 buildGoalBlockedDiagnostics 能产出
  // 真实约束（诚实取真值，不编造）。这是「修正锁死裸重放的旧断言」而非放宽刷绿：
  // 断言从 === goal（等于把「不可拼约束」锁死）改为「含原 goal 且含【重放约束】」。
  const ackAbortReason = "迭代次数用尽（10 轮）仍未达成完成条件";
  const { orchestrator, runRequests } = createDiagnosticOrchestrator({
    finalStatuses: ["aborted", "aborted"],
    abortReason: ackAbortReason,
    failedTestIds: ["tests/test_ack.py::test_replay_guard"],
  });
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

  // 第一次：运行以 aborted 终态结束（带真实诊断的失败记录落盘）
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 1);
  // 前置条件：失败记录确实携带真实诊断（否则约束会诚实降级为 undefined）
  const rec = (manager.getSession(sessionId)?.autonomousGoalRuns ?? [])[0] as AutonomousGoalRunRecord | undefined;
  assert.equal(rec?.abortReason, ackAbortReason, "前置条件：失败记录含真实终止原因");

  // 第二次：同一失败目标 + 知情重试标记 → 守卫放行，直接派发
  const baselineLlmCalls = callCount.value;
  await manager.handleUserPrompt({ text: "配置已修复，重跑同一个目标" });
  assert.equal(runRequests.length, 2, "知情重试（acknowledgeFailedGoal=true）必须放行重放");
  // 修正旧断言：知情重试不再是无失败状态的第三条裸重放通道——重放 --goal 必须
  // 同时含原目标与上一轮真实失败约束（约束来自 buildGoalBlockedDiagnostics 真值）。
  const replayed = runRequests[1].objective;
  assert.ok(replayed.startsWith(goal), "重放 --goal 须保留原目标前缀");
  assert.ok(replayed.includes("【重放约束】"), "知情重试重放必须携带上一轮失败约束（修正锁死裸重放的旧断言）");
  assert.ok(replayed.includes(ackAbortReason), "约束含上一轮真实终止原因");
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

/**
 * 构造按用户输入路由决策的 EagDynamicSuggester 桩（事故 LLM 行为复刻）
 *
 * 触发层决策 LLM 看不到拦截语境（修复前）时的典型漏判形态：确认短语
 * "执行这个"被误判为同目标的 execute_command（而非 confirm_previous），
 * 迫使确认落到 direct_chat 分支验证逃生门确定性通道。
 *
 * @param defaultDecision 非确认输入的默认决策
 * @param confirmDecision 确认短语（startsWithConfirmExecutePhrase 命中）的决策
 * @returns EagDynamicSuggester 桩实例
 */
function createRoutingStubSuggester(
  defaultDecision: EagDynamicSuggestion,
  confirmDecision: EagDynamicSuggestion
): EagDynamicSuggester {
  return {
    isEnabled: () => true,
    suggest: async (context: { goal: string }) =>
      startsWithConfirmExecutePhrase(context.goal) ? confirmDecision : defaultDecision,
  } as unknown as EagDynamicSuggester;
}

// ============================================================================
// N8 拦截确认逃生门死循环修复（2026-10-07 附录 C）：纯函数 + direct_chat 通道
// ============================================================================

test("N8a. startsWithConfirmExecutePhrase：确认短语前缀命中与拒绝判定", () => {
  // 命中：拦截提示指引的标准应答与同义确认短语
  assert.ok(startsWithConfirmExecutePhrase("执行这个"));
  assert.ok(startsWithConfirmExecutePhrase(" 执行这个，这次加上 --test-command "), "前缀命中即可，允许附加说明");
  assert.ok(startsWithConfirmExecutePhrase("重新执行该任务"));
  assert.ok(startsWithConfirmExecutePhrase("确认重试"));
  assert.ok(startsWithConfirmExecutePhrase("确认执行"));
  // 拒绝：空文本、无关输入、否定应答、短语在句中而非开头
  assert.ok(!startsWithConfirmExecutePhrase(""));
  assert.ok(!startsWithConfirmExecutePhrase("   "));
  assert.ok(!startsWithConfirmExecutePhrase("不要执行这个"));
  assert.ok(!startsWithConfirmExecutePhrase("继续"));
  assert.ok(!startsWithConfirmExecutePhrase("先别执行这个任务"));
  assert.ok(!startsWithConfirmExecutePhrase("我想了解执行这个会发生什么"));
});

test("N8b. 事故复刻：触发层连续误判 + 主对话接管，'执行这个'经 direct_chat 确认通道确定性放行", async () => {
  const workspace = createTempDir("deepcode-goalguard-escape-loop-workspace-");
  const home = createTempDir("deepcode-goalguard-escape-loop-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复：已确认重试");
  const { orchestrator, runRequests } = createSequencedOrchestrator(["aborted", "completed"]);
  // 事故 LLM 行为复刻：确认短语"执行这个"被触发层误判为同目标的
  // execute_command（而非 confirm_previous）→ 触发层拦截 return true，
  // direct_chat 确认通道不触发 → 死循环（修复前的真实行为）。
  // 修复后触发层（prompt 优先级规则）或 direct_chat 通道任一路闭合即可；
  // 本用例用 direct_chat 桩验证第二道确定性闭合。
  const { manager, assistantTexts } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createRoutingStubSuggester(
      createExecuteDecision("从46同步数据库到43采用full_overwrite全量覆盖"),
      // 触发层误判形态：确认短语也输出 execute_command（无知情标记）→ 守卫再拦截
      createExecuteDecision("从46同步数据库到43采用full_overwrite全量覆盖")
    ),
  });

  await manager.createSession({ text: "" });
  const goal = "从46同步数据库到43采用full_overwrite全量覆盖";

  // 第一轮：执行 → aborted 终态落盘
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 1);

  // 第二轮：同目标 execute_command → 守卫硬拦截（拦截提示落盘）
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 1);
  assert.ok(
    assistantTexts.some((t) => t.includes("已拦截")),
    "前置条件：拦截提示已推送"
  );

  // 第三轮：确认输入但触发层仍误判 execute_command——修复前此处形成
  // "再拦截"死循环（本用例该桩即修复前行为复刻：拦截计数 +1）
  await manager.handleUserPrompt({ text: "执行这个" });
  assert.equal(runRequests.length, 1, "触发层误判 execute_command 时 direct_chat 通道不介入");
  assert.equal(assistantTexts.filter((t) => t.includes("已拦截")).length, 2, "修复前复刻：触发层误判导致再拦截");

  // 第四轮：触发层按修复后规则输出 direct_chat（未识别为确认，交回主对话）——
  // direct_chat 确定性确认通道必须消费逃生门快照并派发（打破死循环）
  const directChatSuggester = createRoutingStubSuggester(
    { type: "direct_chat", reasoning: "主对话" },
    { type: "direct_chat", reasoning: "主对话" }
  );
  (manager as unknown as { eagDynamicSuggester: EagDynamicSuggester }).eagDynamicSuggester = directChatSuggester;
  await manager.handleUserPrompt({ text: "执行这个" });
  assert.equal(runRequests.length, 2, "确认应答必须经 direct_chat 确认通道派发（逃生门确定性闭合）");
  assert.equal(runRequests[1].objective, goal, "重放 goal 必须与快照目标一致");
  assert.equal(assistantTexts.filter((t) => t.includes("已拦截")).length, 2, "确认轮不得产生第三条拦截提示");

  // 第五轮：逃生门已一次性消费——再次"执行这个"无快照，不得重复派发
  await manager.handleUserPrompt({ text: "执行这个" });
  assert.equal(runRequests.length, 2, "确认通道一次性消费：重复确认不得重复派发");
});

test("N8c. 拦截提示落盘（双写）：供触发层 recentMessages 与主对话上下文可见", async () => {
  const workspace = createTempDir("deepcode-goalguard-persist-workspace-");
  const home = createTempDir("deepcode-goalguard-persist-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  const { orchestrator } = createSequencedOrchestrator(["aborted"]);
  const { manager, assistantTexts } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createStubSuggester(createExecuteDecision("从46同步数据库到43采用full_overwrite全量覆盖")),
  });

  const sessionId = await manager.createSession({ text: "" });
  const goal = "从46同步数据库到43采用full_overwrite全量覆盖";

  await manager.handleUserPrompt({ text: goal });
  await manager.handleUserPrompt({ text: goal });

  // 拦截提示必须持久化到会话消息历史（修复前只 onAssistantMessage 阅后即焚）
  const persisted = manager
    .listSessionMessages(sessionId)
    .filter((m) => m.role === "assistant" && (m.content ?? "").includes("已拦截"));
  assert.equal(persisted.length, 1, "拦截提示必须落盘且只落盘一条（双写不得产生重复）");
  assert.ok(
    assistantTexts.some((t) => t.includes("已拦截")),
    "拦截提示同时推送给宿主"
  );
});

// ============================================================================
// N9-N12 失败目标「执行这个」裸重放修复（2026-11）：
// 逃生门重放必须携带上一轮失败约束，否则必然逐字重演同一失败。
// 设计文档：docs/research/2026-10-eag-auto-loop-trigger-guard.md
// ============================================================================

/**
 * 修复前（2 参）buildAutoExecuteCommand 实现的逐字拷贝——R3「无第三参零回归」oracle。
 * 新实现带可选第三参，但无第三参（含 undefined / 空串 / 纯空白）时必须与
 * 本函数对全部输入逐字一致；拷贝旧实现作为唯一判定基准，避免自证循环。
 */
function legacyBuildAutoExecuteCommand(commandHint: string, goal: string): string {
  const escapedGoal = goal.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ").trim();
  const trimmedCommand = commandHint.trim();
  if (trimmedCommand === "/eag-autonomous") {
    return escapedGoal.length > 0
      ? `/eag-autonomous --goal "${escapedGoal}" --max-iterations 10 --confirmation smart`
      : "/eag-autonomous";
  }
  if (trimmedCommand === "/eag-design") {
    return escapedGoal.length > 0 ? `/eag-design --requirement "${escapedGoal}" --paradigm ddd-layered` : "/eag-design";
  }
  const goalCommands = ["/eag-build", "/eag-test", "/eag-run", "/eag-deploy"];
  if (goalCommands.includes(trimmedCommand)) {
    return escapedGoal.length > 0 ? `${trimmedCommand} --goal "${escapedGoal}"` : trimmedCommand;
  }
  return trimmedCommand;
}

/**
 * 构造带真实诊断数据的 AutonomousOrchestrator 桩（R2/R4 集成用）。
 *
 * runResult 携带真实 blockageReport.summary（终止原因）与 failedTestIds
 * （verify 阶段失败用例，经 extractAutonomousRunDetails 的运行时结构检查取值）。
 * 富信息桩模拟「编排器透出 verify artifacts」的形态；真实生产编排器目前不
 * 透出 failedTestIds（见 verify-stage-handler.ts 的 P5StageResult.artifacts），
 * 该字段会诚实降级为 undefined，本桩仅用于在集成链路验证展示/约束路径。
 */
function createDiagnosticOrchestrator(options: {
  finalStatuses: string[];
  abortReason: string;
  failedTestIds: string[];
}): { orchestrator: AutonomousOrchestrator; runRequests: AutonomousRunRequest[] } {
  const runRequests: AutonomousRunRequest[] = [];
  const orchestrator = {
    run: async (request: AutonomousRunRequest) => {
      runRequests.push(request);
      const status = options.finalStatuses[Math.min(runRequests.length - 1, options.finalStatuses.length - 1)];
      const runId = `run-diag-${runRequests.length}`;
      const runResult = {
        runId,
        finalStatus: status as AutonomousRunResult["finalStatus"],
        exitCode: status === "completed" ? 0 : 1,
        completedLoops: [],
        milestones: [],
        totalIterations: 1,
        totalLlmCallCount: 1,
        totalTokensUsed: 100,
        durationSec: 1,
        finalReport: "诊断桩最终报告",
        blockageReport: {
          runId,
          generatedAt: new Date().toISOString(),
          blockedLoop: "coding",
          blockedIteration: 0,
          blockedStage: "verify",
          rootCauseHypotheses: ["测试命令不适用"],
          suggestedSolutions: ["更换测试命令或先修复基线失败"],
          summary: options.abortReason,
        },
        // 富信息桩：模拟 verify artifacts 透出，供写侧提取真实失败用例
        failedTestIds: options.failedTestIds,
        triggeredGuards: [],
      } as unknown as AutonomousRunResult;
      return runResult;
    },
  } as unknown as AutonomousOrchestrator;
  return { orchestrator, runRequests };
}

test("N9. R1 写侧落盘：details 全字段写入终态记录；无 details 时字段缺失不报错（旧会话兼容）", async () => {
  const workspace = createTempDir("deepcode-goalguard-r1-workspace-");
  const home = createTempDir("deepcode-goalguard-r1-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  const { orchestrator } = createSequencedOrchestrator(["completed"]);
  const { manager } = createTestManager({ workspace, home, client, orchestrator });

  const sessionId = await manager.createSession({ text: "" });
  // 白盒单测写侧私有方法：直接调用真实 recordAutonomousRunOutcome
  const writeOutcome = manager as unknown as {
    recordAutonomousRunOutcome: (
      sid: string,
      goal: string,
      status: string,
      details?: Readonly<AutonomousGoalRunDetails>
    ) => void;
  };

  // 1. 带完整 details → 记录含全部 5 个诊断字段（值取真值，非编造）
  const goalA = "诊断明细写入目标 A";
  const details: AutonomousGoalRunDetails = {
    abortReason: "Token 预算耗尽：199221 >= 200000",
    failedTestIds: ["tests/test_a.py::test_x", "tests/test_b.py::test_y"],
    testCommand: "pytest -q",
    projectRoot: workspace,
    runId: "run-r1-001",
  };
  writeOutcome.recordAutonomousRunOutcome(sessionId, goalA, "failed", details);
  const recA = (manager.getSession(sessionId)?.autonomousGoalRuns ?? []).find(
    (r) => r.goalFingerprint === normalizeGoalFingerprint(goalA)
  ) as AutonomousGoalRunRecord | undefined;
  assert.ok(recA, "带 details 的终态记录必须落盘");
  assert.equal(recA.abortReason, details.abortReason);
  assert.deepEqual(recA.failedTestIds, details.failedTestIds);
  assert.equal(recA.testCommand, details.testCommand);
  assert.equal(recA.projectRoot, details.projectRoot);
  assert.equal(recA.runId, details.runId);

  // 2. 无 details（旧会话 / 异常路径）→ 5 个诊断字段全部缺失，4 个原始字段仍在，不报错
  const goalB = "旧会话兼容目标 B";
  writeOutcome.recordAutonomousRunOutcome(sessionId, goalB, "aborted");
  const recB = (manager.getSession(sessionId)?.autonomousGoalRuns ?? []).find(
    (r) => r.goalFingerprint === normalizeGoalFingerprint(goalB)
  ) as AutonomousGoalRunRecord | undefined;
  assert.ok(recB, "无 details 时记录仍应正常落盘（不报错）");
  assert.equal(recB.abortReason, undefined, "旧记录无 abortReason 字段");
  assert.equal(recB.failedTestIds, undefined, "旧记录无 failedTestIds 字段");
  assert.equal(recB.testCommand, undefined, "旧记录无 testCommand 字段");
  assert.equal(recB.projectRoot, undefined, "旧记录无 projectRoot 字段");
  assert.equal(recB.runId, undefined, "旧记录无 runId 字段");
  assert.equal(recB.finalStatus, "aborted");
  assert.ok(recB.endedAt.length > 0);
  assert.ok(!Object.prototype.hasOwnProperty.call(recB, "abortReason"), "不得落盘 undefined 键（键集合与修复前一致）");
});

test("N10. R2 拦截提示含「上一轮诊断」与失败用例名，且保留「执行这个」逃生门文案", async () => {
  const workspace = createTempDir("deepcode-goalguard-r2-workspace-");
  const home = createTempDir("deepcode-goalguard-r2-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  const abortReason = "迭代次数用尽（10 轮）仍未达成完成条件";
  const failedIds = ["tests/test_lin.py::test_binary_missing", "tests/test_api.py::test_refund"];
  const { orchestrator, runRequests } = createDiagnosticOrchestrator({
    finalStatuses: ["failed"],
    abortReason,
    failedTestIds: failedIds,
  });
  const { manager, assistantTexts } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createStubSuggester(createExecuteDecision("从46同步数据库到43采用full_overwrite全量覆盖")),
  });

  const sessionId = await manager.createSession({ text: "" });
  const goal = "从46同步数据库到43采用full_overwrite全量覆盖";

  // 第一轮：execute_command → 写侧落盘（诊断明细取真实 result/request 值）
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 1);
  const rec = (manager.getSession(sessionId)?.autonomousGoalRuns ?? [])[0] as AutonomousGoalRunRecord | undefined;
  assert.ok(rec, "终态记录必须落盘");
  assert.equal(rec.abortReason, abortReason, "终止原因取真实 blockageReport.summary");
  assert.deepEqual(rec.failedTestIds, failedIds, "失败用例取真实 verify artifacts");
  assert.equal(rec.testCommand, "npm test", "测试命令取真实请求值");
  assert.equal(rec.projectRoot, workspace, "工作目录取真实 projectRoot");
  assert.equal(rec.runId, "run-diag-1", "runId 取真实 runResult.runId");

  // 第二轮：同一失败目标被硬拦截 → 可见提示追加「上一轮诊断」
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 1, "失败目标不得被自动重放");
  const blocked = assistantTexts.find((t) => t.includes("已拦截"));
  assert.ok(blocked, "必须推送可见拦截说明");
  assert.ok(blocked.includes("上一轮诊断"), "可见提示必须追加「上一轮诊断」段");
  assert.ok(blocked.includes("终止原因"), "诊断段含终止原因行");
  assert.ok(blocked.includes(abortReason), "诊断段回显真实终止原因");
  assert.ok(blocked.includes(failedIds[0]), "诊断段含失败用例名");
  assert.ok(blocked.includes(failedIds[1]), "诊断段含第二个失败用例名");
  assert.ok(blocked.includes("测试命令"), "诊断段含测试命令行");
  assert.ok(blocked.includes("工作目录"), "诊断段含工作目录行");
  assert.ok(blocked.includes("runId"), "诊断段含 runId 行");
  assert.ok(blocked.includes("执行这个"), "既有 N3/N5 逃生门文案不得破坏");
  assert.ok(blocked.includes("failed"), "既有 N3/N5 终态回显不得破坏");
});

test("N11. R3 buildAutoExecuteCommand：无第三参逐字零回归；带 failureContext 追加约束且双引号/换行已转义", () => {
  // 1. 无第三参（含 undefined / 空串 / 纯空白）→ 与修复前实现逐字一致（全输入矩阵）
  const hints = [
    "/eag-autonomous",
    "/eag-design",
    "/eag-build",
    "/eag-test",
    "/eag-run",
    "/eag-deploy",
    "/eag-graph",
    "  /eag-autonomous  ",
  ];
  const goals = ["修复登录失败问题", "", '修复 "登录" 模块\n路径 C:\\tmp', "  带前后空白  ", 'a\\b"c\nd'];
  for (const hint of hints) {
    for (const g of goals) {
      assert.equal(
        buildAutoExecuteCommand(hint, g),
        legacyBuildAutoExecuteCommand(hint, g),
        `无第三参零回归：${hint} / ${JSON.stringify(g)}`
      );
    }
  }
  for (const emptyCtx of [undefined, "", "   "]) {
    assert.equal(
      buildAutoExecuteCommand("/eag-autonomous", "修复登录失败问题", emptyCtx),
      legacyBuildAutoExecuteCommand("/eag-autonomous", "修复登录失败问题"),
      `第三参为空(${JSON.stringify(emptyCtx)})时仍逐字零回归`
    );
  }

  // 2. 带 failureContext → 约束追加进 --goal，goal 与约束走同一套转义，命令结构不破坏
  const trickyGoal = '修复 "登录"\n改用 C:\\tmp 目录';
  const ctx =
    '【重放约束】上一轮因 测试命令 "npm test" 不适用 终止；' +
    "失败用例：tests/test_a.py::test_x；请先确认目标与工作目录匹配。";
  const full = buildAutoExecuteCommand("/eag-autonomous", trickyGoal, ctx);
  assert.ok(!full.includes("\n"), "命令字符串不得含裸换行（--goal 不支持多行参数）");
  assert.ok(full.includes('\\"'), '原始命令中双引号必须以 \\" 形式转义');
  assert.ok(full !== legacyBuildAutoExecuteCommand("/eag-autonomous", trickyGoal), "带约束时输出必须与裸重放不同");

  const restored = extractGoalFromCommandString(full);
  assert.ok(restored !== null, "--goal 必须是结构完整的单一转义串（命令结构不破坏）");
  const value = restored as string;
  assert.ok(value.startsWith('修复 "登录" 改用 C:\\tmp 目录'), "原 goal 保留在 --goal 前缀且特殊字符正确还原");
  assert.ok(value.includes("【重放约束】"), "约束文本追加进 --goal");
  assert.ok(value.includes('"npm test"'), "约束文本内的双引号走同一套转义后又能正确还原");
  assert.ok(value.includes("tests/test_a.py::test_x"), "约束文本内的失败用例保留");
});

test("N12. R4 逃生门重放：拦截后回复'执行这个' → 分发命令含上一轮失败约束；一次性消费不回归", async () => {
  const workspace = createTempDir("deepcode-goalguard-r4-workspace-");
  const home = createTempDir("deepcode-goalguard-r4-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createDiagnosticOrchestrator({
    finalStatuses: ["failed", "failed"],
    abortReason: "迭代次数用尽（10 轮）仍未达成完成条件",
    failedTestIds: ["tests/test_lin.py::test_binary_missing"],
  });
  const suggestCalls = { value: 0 };
  const goal = "从46同步数据库到43采用full_overwrite全量覆盖";
  const suggestions: EagDynamicSuggestion[] = [
    createExecuteDecision(goal), // 第一轮：执行（播种 failed 记录）
    createExecuteDecision(goal), // 第二轮：拦截（存带 failureContext 的快照）
    { type: "confirm_previous", messageToUser: "正在执行上一条建议。", reasoning: "用户显式确认重放" },
    { type: "confirm_previous", messageToUser: "正在执行上一条建议。", reasoning: "重复确认（一次性消费验证）" },
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

  // 第一轮：execute_command 派发，failed 终态 + 诊断明细落盘
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 1);

  // 第二轮：同一失败目标硬拦截（存逃生门快照）
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 1);
  assert.ok(
    assistantTexts.some((t) => t.includes("已拦截")),
    "前置条件：拦截提示已推送"
  );

  // 第三轮：用户显式确认重放 → 分发的命令 --goal 必须携带上一轮失败约束
  await manager.handleUserPrompt({ text: "执行这个" });
  assert.equal(runRequests.length, 2, "显式确认（confirm_previous 决策）必须放行重放");
  const replayed = runRequests[1].objective;
  assert.ok(replayed.startsWith(goal), "原目标仍保留在重放 --goal 前缀");
  assert.ok(replayed.includes("【重放约束】"), "重放命令必须含失败约束（修复前为裸 goal）");
  assert.ok(replayed.includes("迭代次数用尽"), "约束含上一轮终止原因");
  assert.ok(replayed.includes("tests/test_lin.py::test_binary_missing"), "约束含失败用例");
  assert.ok(replayed.includes("npm test"), "约束含测试命令");
  assert.ok(replayed.includes(workspace), "约束含工作目录");
  assert.ok(replayed.includes("请先确认目标与工作目录匹配"), "约束含避免重复上一轮做法的指引");

  // 第四轮：逃生门一次性消费——无快照不得重复派发（一次性语义不回归）
  await manager.handleUserPrompt({ text: "执行这个" });
  assert.equal(runRequests.length, 2, "逃生门一次性消费：重复确认不得重复派发");
  assert.ok(manager.getSession(sessionId), "会话仍可用");
});

test("N13. 补充：direct_chat 确认通道同样透传 failureContext（两条逃生路径均覆盖）；无失败用例真值时不编造该段", async () => {
  const workspace = createTempDir("deepcode-goalguard-directchat-workspace-");
  const home = createTempDir("deepcode-goalguard-directchat-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createDiagnosticOrchestrator({
    finalStatuses: ["failed", "failed"],
    abortReason: "连续失败 3 次触发熔断",
    failedTestIds: [], // 无失败用例真值：诚实降级（不显示该行），但终止原因仍触发约束
  });
  const goal = "从46同步数据库到43采用full_overwrite全量覆盖";
  const suggestCalls = { value: 0 };
  const suggestions: EagDynamicSuggestion[] = [
    createExecuteDecision(goal), // 第一轮：执行（播种 failed 记录）
    createExecuteDecision(goal), // 第二轮：拦截（存带 failureContext 的快照）
    { type: "direct_chat", reasoning: "触发层降级，交回主对话" }, // 第三轮：direct_chat 确定性确认通道
    { type: "direct_chat", reasoning: "触发层降级，交回主对话" }, // 第四轮：一次性消费验证
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

  await manager.createSession({ text: "" });

  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 1);
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 1);
  assert.ok(
    assistantTexts.some((t) => t.includes("已拦截")),
    "前置条件：拦截提示已推送"
  );

  // 第三轮：direct_chat 降级 → session.ts:5152 确定性确认闭合 → 同一 consume 方法
  await manager.handleUserPrompt({ text: "执行这个" });
  assert.equal(runRequests.length, 2, "direct_chat 确认通道必须消费快照派发");
  const replayed = runRequests[1].objective;
  assert.ok(replayed.includes("【重放约束】"), "direct_chat 路径重放同样须含失败约束");
  assert.ok(replayed.includes("连续失败 3 次触发熔断"), "约束含上一轮终止原因");
  assert.ok(!replayed.includes("失败用例："), "无失败用例真值时不得编造该段（诚实降级）");

  await manager.handleUserPrompt({ text: "执行这个" });
  assert.equal(runRequests.length, 2, "一次性消费：重复确认不得重复派发");
});
