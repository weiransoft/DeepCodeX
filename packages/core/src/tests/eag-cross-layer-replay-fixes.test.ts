/**
 * 第 5 组：跨层逃生门失败状态 + context-budget 第 1/2/3 级证据保留 定向回归测试
 *
 * 覆盖 6 个场景（本组实现规格「验证」清单）：
 * ① 知情重试（acknowledgeFailedGoal=true）放行后重放命令含【重放约束】且含原 goal；
 * ② handler.execute() 抛异常时落盘记录含真实 abortReason（不再传空 {}）；
 * ③ suggest_* 裸快照 + 存在失败 run → confirm_previous 重放命令含约束（消费方门禁重建）；
 * ④ context-budget 第 2 级压缩后，保护窗外旧 tool 的 stderr/FAILED 尾部仍在占位摘要中；
 * ⑤ 极小预算 + 尾部含 FAILED 时尾部保留（truncateToolOutput 退化分支不再 head-only）；
 * ⑥ N11 两参逐字零回归仍成立（buildAutoExecuteCommand 未改动）。
 *
 * 诚实降级原则：所有诊断数据均来自真实桩值 / 真实错误文本，绝不编造；取不到时
 * 断言显式验证 undefined 降级。不使用 mock 框架，全部走真实 SessionManager /
 * DeterministicContextBudgetProvider 路径。
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionManager } from "../session";
import type { AutonomousGoalRunDetails, SessionMessage } from "../session";
import { buildAutoExecuteCommand } from "../eag/suggestion-auto";
import {
  truncateToolOutput,
  DeterministicContextBudgetProvider,
  DEFAULT_CONTEXT_BUDGET_CONFIG,
} from "../context-budget";
import type { EagDynamicSuggester, EagDynamicSuggestion } from "../eag/dynamic/eag-dynamic-suggester";
import type { AutonomousOrchestrator } from "../eag/p5/autonomous-orchestrator";
import type { AutonomousRunRequest, AutonomousRunResult } from "../eag/p5/autonomous-orchestrator";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

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

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 测试装配（stub 注入式，非 mock 框架）
// ---------------------------------------------------------------------------

async function* createChatStreamResponse(
  chunks: ReadonlyArray<Record<string, unknown>>
): AsyncGenerator<Record<string, unknown>> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/** 固定回复的主对话 OpenAI client 桩（EAG 路径不应触发主对话 LLM） */
function createStubClient(): unknown {
  return {
    chat: {
      completions: {
        create: async () =>
          createChatStreamResponse([
            { choices: [{ delta: { content: "主对话回复" } }] },
            { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
          ]),
      },
    },
  };
}

function createStubSuggester(suggestion: EagDynamicSuggestion): EagDynamicSuggester {
  return {
    isEnabled: () => true,
    suggest: async () => suggestion,
  } as unknown as EagDynamicSuggester;
}

/** 按序返回建议决策的 suggester 桩（超出队列后复用最后一条） */
function createQueuedSuggester(suggestions: ReadonlyArray<EagDynamicSuggestion>): EagDynamicSuggester {
  let call = 0;
  return {
    isEnabled: () => true,
    suggest: async () => {
      const s = suggestions[Math.min(call, suggestions.length - 1)];
      call += 1;
      return s;
    },
  } as unknown as EagDynamicSuggester;
}

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
 * 记录 AutonomousRunRequest 的 orchestrator 桩。
 * throwOnRender 非空时，run() 返回的 runResult 的 milestones 用 getter 抛错，
 * 使 EagAutonomousCommandHandler.formatSuccessReport 抛出 → handler.execute()
 * 自身抛异常 → 触发 session.ts handleEagAutonomousCommand 的 catch 分支。
 */
function createRecordingOrchestrator(options?: { readonly throwOnRender?: string }): {
  orchestrator: AutonomousOrchestrator;
  runRequests: AutonomousRunRequest[];
} {
  const runRequests: AutonomousRunRequest[] = [];
  const orchestrator = {
    run: async (request: AutonomousRunRequest) => {
      runRequests.push(request);
      const runResult: Record<string, unknown> = {
        runId: `run-x5-${runRequests.length}`,
        finalStatus: "failed",
        exitCode: 1,
        completedLoops: [],
        totalIterations: 1,
        totalLlmCallCount: 1,
        totalTokensUsed: 10,
        durationSec: 1,
        triggeredGuards: [],
        finalReport: "诊断桩最终报告",
        blockageReport: undefined,
      };
      if (options?.throwOnRender) {
        Object.defineProperty(runResult, "milestones", {
          enumerable: true,
          get() {
            throw new Error(options.throwOnRender);
          },
        });
      } else {
        runResult.milestones = [];
      }
      return runResult as unknown as AutonomousRunResult;
    },
  } as unknown as AutonomousOrchestrator;
  return { orchestrator, runRequests };
}

function createTestManager(options: {
  workspace: string;
  home: string;
  orchestrator: AutonomousOrchestrator;
  suggester?: EagDynamicSuggester;
}): { manager: SessionManager; assistantTexts: string[] } {
  const assistantTexts: string[] = [];
  const manager = new SessionManager({
    projectRoot: options.workspace,
    createOpenAIClient: () => ({
      client: createStubClient() as any,
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

/** 白盒写入一条带真实诊断的失败终态记录（诚实取真值，不编造） */
function seedFailedRun(
  manager: SessionManager,
  sessionId: string,
  goal: string,
  details: AutonomousGoalRunDetails
): void {
  const writeOutcome = manager as unknown as {
    recordAutonomousRunOutcome: (
      sid: string,
      g: string,
      status: string,
      d?: Readonly<AutonomousGoalRunDetails>
    ) => void;
  };
  writeOutcome.recordAutonomousRunOutcome(sessionId, goal, "failed", details);
}

function setupEnv(): { workspace: string; home: string } {
  const workspace = createTempDir("deepcode-x5-workspace-");
  const home = createTempDir("deepcode-x5-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;
  return { workspace, home };
}

// ===========================================================================
// ① 知情重试放行后重放命令含【重放约束】且含原 goal
// ===========================================================================
test("X1 知情重试放行：命中带真实诊断的失败记录时重放 --goal 含原目标 + 【重放约束】", async () => {
  const { workspace, home } = setupEnv();
  const goal = "跨层知情重试测试目标";
  const abortReason = "连续失败 3 次触发熔断";
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  const { manager } = createTestManager({
    workspace,
    home,
    orchestrator,
    suggester: createStubSuggester(createExecuteDecision(goal, { acknowledgeFailedGoal: true })),
  });

  const sessionId = await manager.createSession({ text: "" });
  // 白盒播种一条带真实诊断的失败记录（真实值，不编造）
  seedFailedRun(manager, sessionId, goal, {
    abortReason,
    failedTestIds: ["tests/test_x1.py::test_replay"],
  });

  // 知情重试（acknowledgeFailedGoal=true）→ 放行，但必须携带上一轮失败约束
  await manager.handleUserPrompt({ text: "配置已修复，重跑同一个目标" });

  assert.equal(runRequests.length, 1, "知情重试必须放行派发");
  const replayed = runRequests[0].objective;
  assert.ok(replayed.startsWith(goal), "重放 --goal 须保留原目标前缀");
  assert.ok(replayed.includes("【重放约束】"), "知情重试重放必须携带上一轮失败约束（第三条通道不再裸重放）");
  assert.ok(replayed.includes(abortReason), "约束含上一轮真实终止原因");
});

// ===========================================================================
// ② handler.execute() 抛异常时落盘记录含真实 abortReason
// ===========================================================================
test("X2 异常终态：handler.execute() 抛异常 → 终态记录含真实 errMsg 作为 abortReason", async () => {
  const { workspace, home } = setupEnv();
  const goal = "异常路径测试目标";
  const excMsg = "诊断桩：渲染里程碑时抛出（复刻 handler 自身异常）";
  const { orchestrator } = createRecordingOrchestrator({ throwOnRender: excMsg });
  const { manager } = createTestManager({ workspace, home, orchestrator });

  const sessionId = await manager.createSession({ text: "" });
  // 原生 /eag-autonomous 命令直达 handleEagAutonomousCommand（不经建议器）
  const command = buildAutoExecuteCommand("/eag-autonomous", goal);
  await manager.handleUserPrompt({ text: command });

  const rec = (manager.getSession(sessionId)?.autonomousGoalRuns ?? [])[0];
  assert.ok(rec, "异常终态必须落盘终态记录");
  assert.equal(rec.finalStatus, "failed");
  // 核心：修复前异常路径传 {}，abortReason 缺失 → buildGoalBlockedDiagnostics 返回空诊断段；
  // 修复后把真实 errMsg（非猜测）作为 details.abortReason 写入。
  assert.equal(rec.abortReason, excMsg, "落盘记录须含真实错误文本作为 abortReason");
});

// ===========================================================================
// ③ suggest_* 裸快照 + 存在失败 run → 重放命令含约束
// ===========================================================================
test("X3 逃生门消费门禁：suggest_autonomous 裸快照 + 失败 run → confirm_previous 重放含约束", async () => {
  const { workspace, home } = setupEnv();
  const goal = "跨层裸快照测试目标";
  const abortReason = "阻塞报告：测试命令不适用";
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  const suggestions: EagDynamicSuggestion[] = [
    {
      type: "suggest_autonomous",
      commandHint: "/eag-autonomous",
      messageToUser: "建议启动自主循环",
      reasoning: "测试桩：仅展示建议",
    },
    { type: "confirm_previous", messageToUser: "正在执行上一条建议。", reasoning: "用户显式确认重放" },
  ];
  const { manager } = createTestManager({
    workspace,
    home,
    orchestrator,
    suggester: createQueuedSuggester(suggestions),
  });

  const sessionId = await manager.createSession({ text: "" });
  // 白盒播种一条带真实诊断的失败记录（真实值）
  seedFailedRun(manager, sessionId, goal, {
    abortReason,
    failedTestIds: ["tests/test_x3.py::test_bare_snapshot"],
  });

  // 第 1 轮：suggest_autonomous 展示 → 存裸快照（无 failureContext）
  await manager.handleUserPrompt({ text: goal });
  assert.equal(runRequests.length, 0, "suggest_* 仅展示，不派发执行");

  // 第 2 轮：confirm_previous 消费裸快照 → 消费方门禁实时重建诊断约束
  await manager.handleUserPrompt({ text: "执行这个" });
  assert.equal(runRequests.length, 1, "confirm_previous 必须消费快照派发");
  const replayed = runRequests[0].objective;
  assert.ok(replayed.startsWith(goal), "重放 --goal 须保留原目标前缀");
  assert.ok(replayed.includes("【重放约束】"), "裸快照经门禁重建后重放必须含约束");
  assert.ok(replayed.includes(abortReason), "约束含上一轮真实终止原因");
});

// ===========================================================================
// ④ context-budget 第 2 级压缩后，保护窗外旧 tool 的尾部 FAILED 仍在占位摘要
// ===========================================================================
test("X4 第 2 级丢弃占位保真：保护窗外旧 tool 的 stderr/FAILED 尾部仍在占位摘要中", () => {
  const MAX = DEFAULT_CONTEXT_BUDGET_CONFIG.toolOutputMaxChars;
  const now = "2026-11-08T00:00:00.000Z";
  const msg = (id: string, role: SessionMessage["role"], content: string | null): SessionMessage => ({
    id,
    sessionId: "session-x4",
    role,
    content,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
  });
  const tailEvidence = (i: number): string =>
    `stderr: command not found\nFAILED tests/test_x4_${i}.py::test_evidence\n` +
    `AssertionError: expected 1 got 2\nprocess exited with exit code 1\n`;
  const bigTool = (i: number): string => `RUN tool-${i}\n` + ".".repeat(6000) + tailEvidence(i);

  const messages: SessionMessage[] = [msg("sys", "system", "system prompt"), msg("task", "user", "任务卡")];
  const TOOL_COUNT = 5;
  for (let i = 0; i < TOOL_COUNT; i += 1) {
    messages.push(msg(`asst-${i}`, "assistant", "", { tool_calls: [{ id: `c-${i}` }] } as any));
    messages.push(msg(`tool-${i}`, "tool", bigTool(i), { tool_call_id: `c-${i}` } as any));
  }
  messages.push(msg("final", "assistant", "任务完成"));

  const provider = new DeterministicContextBudgetProvider({
    toolResultsBudgetChars: 5000, // 强制触发第 2 级（5 条截断后总量约 15.7K 远超预算）
    protectedRecentTools: 1, // 仅最后一条 tool 受保护
    toolOutputMaxChars: MAX,
  });
  const result = provider.compactForRequest(messages);

  // 第 0 条 tool（最老、保护窗外）被整条丢弃为占位，但占位须含真实尾部 FAILED 证据
  const dropped = result.find((m) => m.id === "tool-0")!.content!;
  assert.ok(dropped.startsWith("（上下文压缩：该工具结果"), "第 2 级应把最老 tool 替换为丢弃占位");
  assert.ok(dropped.includes("FAILED tests/test_x4_0.py::test_evidence"), "占位摘要须保留尾部 FAILED 用例名");
  assert.ok(dropped.includes("stderr"), "占位摘要须保留尾部 stderr");
  assert.ok(dropped.includes("已截断，原共"), "占位须保留「已截断，原共」子串");
  assert.ok(dropped.length <= MAX, `占位总长应严格 ≤ toolOutputMaxChars(${MAX})，实际 ${dropped.length}`);
  // 占位不是纯字符数说明：必须含真实内容（与旧 droppedNote 区分）
  assert.ok(!dropped.startsWith("（上下文压缩：该工具结果共"), "占位不得退化为旧「仅字符数」模板");

  // 第 2 级确实生效：至少一条保护窗外 tool 被替换为占位，总量相对原始 tool
  // 结果显著下降（压缩有收益）。此处不设「总量 ≤ 预算」阈值——带证据的占位本身
  // 有体积，droppable 条数有限时 provider 是尽力收敛（既有 CB-03 在大量 tool
  // 场景验证真正收敛），本用例只锁定「占位保留证据」这一修复核心。
  const originalToolChars = messages
    .filter((m) => m.role === "tool")
    .reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  const totalChars = result.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  assert.ok(
    totalChars < originalToolChars,
    `第 2 级丢弃应显著降低 tool 结果总量（${originalToolChars} → ${totalChars}）`
  );
  const droppedCount = result.filter((m) => (m.content ?? "").startsWith("（上下文压缩：该工具结果")).length;
  assert.ok(droppedCount >= 1, "保护窗外旧 tool 应被整条丢弃为占位");
});

// ===========================================================================
// ⑤ 极小预算 + 尾部含 FAILED 时尾部保留
// ===========================================================================
test("X5 极小预算退化：maxChars<200 + 尾部 FAILED → 尾部保留、含「已截断，原共」、长度 ≤ 预算", () => {
  const content = "H".repeat(4000) + "FAILED tests/test_tiny.py::test_tail\nAssertionError: tail\nexit code 1\n";
  const budget = 180;
  const result = truncateToolOutput(content, budget);

  assert.ok(result.length <= budget, `结果长度应 ≤ ${budget}，实际 ${result.length}`);
  assert.ok(result.includes("FAILED tests/test_tiny.py::test_tail"), "极小预算仍须保留尾部 FAILED 证据");
  assert.ok(result.includes("已截断，原共"), "须保留旧文案子串「已截断，原共」");
  assert.ok(result.startsWith("HHHH"), "极小预算仍保留头部原文前缀");

  // 真实尾部（最后若干字符）确实出现在结果末尾
  assert.ok(result.endsWith("exit code 1\n"), "真实尾部应完整出现在结果末尾");
});

// ===========================================================================
// ⑥ N11 两参逐字零回归仍成立
// ===========================================================================
/** 修复前（2 参）buildAutoExecuteCommand 的逐字拷贝，作为零回归唯一判定基准 */
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

test("X6 N11 零回归：buildAutoExecuteCommand 无第三参 / 第三参为空时逐字不变", () => {
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
});

// ===========================================================================
// 用户红线 #3：可回退开关验证（P1-3 唯一无条件改变默认输出的修复）
// ===========================================================================
test("X7 可回退开关：DEEPCODEX_CONTEXT_DROP_EVIDENCE=0 → 第 2 级占位恢复为修复前「仅字符数」模板", () => {
  const now = "2026-11-08T00:00:00.000Z";
  const msg = (id: string, role: SessionMessage["role"], content: string | null): SessionMessage => ({
    id,
    sessionId: "session-x7",
    role,
    content,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
  });
  const tail = (i: number): string => `FAILED tests/test_x7_${i}.py::test_evidence\nAssertionError: x\nexit code 1\n`;
  const bigTool = (i: number): string => `RUN ${i}\n` + ".".repeat(6000) + tail(i);
  const messages: SessionMessage[] = [msg("sys", "system", "s"), msg("task", "user", "任务卡")];
  for (let i = 0; i < 5; i += 1) {
    messages.push(msg(`asst-${i}`, "assistant", ""));
    messages.push(msg(`tool-${i}`, "tool", bigTool(i)));
  }
  messages.push(msg("final", "assistant", "任务完成"));

  const prev = process.env.DEEPCODEX_CONTEXT_DROP_EVIDENCE;
  process.env.DEEPCODEX_CONTEXT_DROP_EVIDENCE = "0";
  try {
    // 构造时读取环境变量：回退到修复前行为
    const provider = new DeterministicContextBudgetProvider({
      toolResultsBudgetChars: 5000,
      protectedRecentTools: 1,
    });
    const result = provider.compactForRequest(messages);
    const dropped = result.find((m) => m.id === "tool-0")!.content!;
    assert.ok(dropped.startsWith("（上下文压缩：该工具结果共"), "回退后应为修复前「仅字符数」占位");
    assert.ok(dropped.includes("已省略"), "回退后占位保留旧「已省略」文案");
    assert.ok(!dropped.includes("FAILED"), "回退后占位不含证据摘要");
    assert.ok(!dropped.includes("已截断，原共"), "回退后占位不含修复期新增的截断标记");
  } finally {
    if (prev === undefined) {
      delete process.env.DEEPCODEX_CONTEXT_DROP_EVIDENCE;
    } else {
      process.env.DEEPCODEX_CONTEXT_DROP_EVIDENCE = prev;
    }
  }
});
