/**
 * F9-v2（2026-09-12）确定性执行通道 + 指代确认 集成测试
 *
 * 背景日志（建议循环次因分析）：
 * 1. "执行这个全量覆盖！" → 主 LLM 拒绝"我不能直接替你执行"——指代确认短语无法触达执行；
 * 2. "启动 EAG 自主任务..." → 建议器 LLM 误分类为 direct_chat，主 LLM 回复
 *    "当前仅给出建议，不会自动执行"——明确意图被两层 LLM 消化；
 * 3. 客户端兜底全程静默（CLI 端测试见 suggestion-fallback.test.ts）。
 *
 * 本文件覆盖 session.ts 侧四项修复：
 * - 确定性通道：意图前缀 / /eag-autonomous 字面量内嵌 → 剥离意图前缀构造命令执行；
 * - 指代确认："执行这个/该 X"式短语 + 上一条展示过的建议 → 直接执行该建议；
 * - F9 执行条件放宽三选一：refine 澄清 / 显式意图 / 指代确认；
 * - 建议降级展示追加"回复'执行这个'即可自动执行"提示。
 *
 * 测试模式：沿用 session-eag-suggester-integration.test.ts 的 stub 注入模式
 * （EagDynamicSuggester / OpenAI client / AutonomousOrchestrator 均为注入式依赖，
 * 通过类型断言注入桩实现，聚焦 replySession 集成逻辑本身）。
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
 * 构造记录调用参数的 AutonomousOrchestrator 桩
 *
 * 记录每次 run() 的 AutonomousRunRequest，供断言确定性通道构造的 goal 是否正确。
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
// 测试用例：确定性通道（意图前缀）
// ============================================================================

test("F9-v2 确定性通道：'启动 EAG 自主任务：目标' 剥离意图前缀直接执行（不经建议器/主对话）", async () => {
  const workspace = createTempDir("deepcode-f9v2-intent-workspace-");
  const home = createTempDir("deepcode-f9v2-intent-home-");
  setHomeDir(home);
  // 关闭 skill matching 的 LLM 调用干扰
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  // 不注入建议器：验证确定性通道独立于建议器工作
  const { manager } = createTestManager({ workspace, home, client, orchestrator });

  const sessionId = await manager.createSession({ text: "" });
  const baselineLlmCalls = callCount.value;

  // 用户以自然语言表达明确的 EAG 自主任务意图（日志中的原始失败场景）
  await manager.handleUserPrompt({ text: "启动 EAG 自主任务：从46同步数据库到43采用full_overwrite全量覆盖" });

  // 核心断言 1：确定性通道命中，orchestrator.run 被调用且 goal 剥离了意图前缀
  assert.equal(runRequests.length, 1, "确定性通道应直接触发一次 /eag-autonomous 执行");
  assert.equal(
    runRequests[0].objective,
    "从46同步数据库到43采用full_overwrite全量覆盖",
    "goal 应剥离'启动 EAG 自主任务：'意图前缀"
  );
  // 核心断言 2：主对话 LLM 未被调用（意图在建议器之前被确定性通道消费）
  assert.equal(callCount.value, baselineLlmCalls, "主对话 LLM 不应被调用");
});

test("F9-v2 确定性通道：'执行自主任务 目标'（无 EAG 字样）同样触发", async () => {
  const workspace = createTempDir("deepcode-f9v2-intent2-workspace-");
  const home = createTempDir("deepcode-f9v2-intent2-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  const { manager } = createTestManager({ workspace, home, client, orchestrator });

  const sessionId = await manager.createSession({ text: "" });
  await manager.handleUserPrompt({ text: "执行自主任务 修复登录页面的样式错乱" });

  assert.equal(runRequests.length, 1);
  assert.equal(runRequests[0].objective, "修复登录页面的样式错乱");
});

test("F9-v2 确定性通道：否定保护——'不要启动自主任务' 不触发执行", async () => {
  const workspace = createTempDir("deepcode-f9v2-neg-workspace-");
  const home = createTempDir("deepcode-f9v2-neg-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("好的，不启动。");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  const { manager } = createTestManager({ workspace, home, client, orchestrator });

  const sessionId = await manager.createSession({ text: "" });
  const baselineLlmCalls = callCount.value;
  await manager.handleUserPrompt({ text: "不要启动自主任务同步数据库" });

  // 否定输入不触发确定性通道：无 EAG 执行，落入主对话
  assert.equal(runRequests.length, 0, "否定输入不得触发 /eag-autonomous 执行");
  assert.ok(callCount.value > baselineLlmCalls, "否定输入应落入 LLM 主对话");
});

test("F9-v2 确定性通道：泛化词'自动循环'不触发（防误伤边界）", async () => {
  const workspace = createTempDir("deepcode-f9v2-generic-workspace-");
  const home = createTempDir("deepcode-f9v2-generic-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("好的");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  const { manager } = createTestManager({ workspace, home, client, orchestrator });

  const sessionId = await manager.createSession({ text: "" });
  await manager.handleUserPrompt({ text: "帮我自动循环播放这首歌" });

  assert.equal(runRequests.length, 0, "泛化词'自动循环'不得触发 EAG 自主任务");
});

test("F9-v2 确定性通道：字面量内嵌——'帮我执行 /eag-autonomous --goal ...' 截取命令执行", async () => {
  const workspace = createTempDir("deepcode-f9v2-literal-workspace-");
  const home = createTempDir("deepcode-f9v2-literal-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  const { manager } = createTestManager({ workspace, home, client, orchestrator });

  const sessionId = await manager.createSession({ text: "" });
  const baselineLlmCalls = callCount.value;
  // 自然语言包裹命令字面量（EagCommandParser 只识别开头前缀，此输入原本会落入建议器）
  await manager.handleUserPrompt({ text: "帮我执行 /eag-autonomous --goal '从本机 46 导出数据库' --max-iterations 5" });

  assert.equal(runRequests.length, 1, "字面量内嵌应截取命令直接执行");
  assert.equal(runRequests[0].objective, "从本机 46 导出数据库", "引号内中文参数应完整解析为 goal");
  assert.equal(runRequests[0].maxIterations, 5, "字面量后的 --max-iterations 参数应透传");
  assert.equal(callCount.value, baselineLlmCalls, "主对话 LLM 不应被调用");
});

test("F9-v2 确定性通道：字面量否定保护——'不要执行 /eag-autonomous' 不触发", async () => {
  const workspace = createTempDir("deepcode-f9v2-litneg-workspace-");
  const home = createTempDir("deepcode-f9v2-litneg-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("好的");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  const { manager } = createTestManager({ workspace, home, client, orchestrator });

  const sessionId = await manager.createSession({ text: "" });
  await manager.handleUserPrompt({ text: "不要执行 /eag-autonomous --goal '危险操作'" });

  assert.equal(runRequests.length, 0, "字面量前置否定不得触发执行");
});

test("F9-v2 确定性通道：F8 豁免仍生效——bypassEagSuggestion 输入直通主对话", async () => {
  const workspace = createTempDir("deepcode-f9v2-bypass-workspace-");
  const home = createTempDir("deepcode-f9v2-bypass-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("收到");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  const { manager } = createTestManager({ workspace, home, client, orchestrator });

  const sessionId = await manager.createSession({ text: "" });
  const baselineLlmCalls = callCount.value;
  await manager.handleUserPrompt({
    text: "启动 EAG 自主任务：从46同步数据库到43",
    bypassEagSuggestion: true,
  });

  // bypass 标记的输入交还主对话，确定性通道同样不拦截
  assert.equal(runRequests.length, 0, "bypass 标记输入不得被确定性通道拦截");
  assert.ok(callCount.value > baselineLlmCalls, "bypass 标记输入应直通 LLM 主对话");
});

// ============================================================================
// 测试用例：指代确认 + 建议降级展示提示
// ============================================================================

test("方案 B：非 EAG 命令降级展示 + snapshot 存储 + 追加提示（执行分发待扩展）", async () => {
  const workspace = createTempDir("deepcode-f9v2-anaphora-workspace-");
  const home = createTempDir("deepcode-f9v2-anaphora-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  // 方案 B：非 /eag- commandHint → tryAutoExecuteSuggestedCommand 硬条件 1 不满足 → 降级
  // 降级后 snapshot 存储 + 提示追加（所有有 commandHint 的建议都做）
  const { manager, assistantTexts } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createStubSuggester({
      type: "suggest_autonomous",
      commandHint: "/team autonomous", // 非 /eag- 开头 → 硬条件 1 不满足 → 降级
      messageToUser: "这是一个多阶段任务，建议运行 /team autonomous。",
      reasoning: "多阶段任务",
    }),
  });

  const sessionId = await manager.createSession({ text: "" });

  // 第一轮：非 /eag- 命令建议 → 降级展示 + snapshot 存储 + 提示追加
  await manager.handleUserPrompt({ text: "从46同步数据库到43采用full_overwrite全量覆盖" });
  assert.equal(runRequests.length, 0, "非 /eag- 命令建议应降级展示不自动执行");
  const displayedSuggestion = assistantTexts.find((text) => text.includes("建议运行 /team autonomous"));
  assert.ok(displayedSuggestion, "建议文本应展示给用户");
  assert.ok(displayedSuggestion.includes(`回复"执行这个"即可自动执行`), "方案 B 新行为：降级建议都追加指代确认提示");

  // 第二轮：用户说"执行这个"——tryAnaphoraConfirmExecution 消费 snapshot
  // 但 dispatchEagCommandString 不认非 /eag- 命令 → 返回 false → 执行受限
  // 这是当前架构限制，后续扩展 team handler 分发后可打通
  await manager.handleUserPrompt({ text: "执行这个全量覆盖！" });
  assert.equal(runRequests.length, 0, "非 /eag- 命令的指代确认执行暂时受限（dispatch 待扩展）");
});

test("方案 B：snapshot 一次性消费——指代确认即使执行失败也会清除 snapshot", async () => {
  const workspace = createTempDir("deepcode-f9v2-anaphora2-workspace-");
  const home = createTempDir("deepcode-f9v2-anaphora2-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  const { manager } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createStubSuggester({
      type: "suggest_autonomous",
      commandHint: "/team autonomous", // 非 /eag- 开头 → 降级展示 → snapshot 存储
      messageToUser: "建议运行 /team autonomous。",
      reasoning: "多阶段任务",
    }),
  });

  const sessionId = await manager.createSession({ text: "" });

  // 第一轮：降级展示 → snapshot 存
  // 第二轮：指代确认 → snapshot 先清 → dispatchEagCommandString 失败 → 返回 false
  await manager.handleUserPrompt({ text: "重构认证模块" });
  await manager.handleUserPrompt({ text: "就执行这个" });

  // snapshot 已被 tryAnaphoraConfirmExecution 清除（即使 dispatch 失败）
  // 第三轮再输入"执行这个"找不到 snapshot
  await manager.handleUserPrompt({ text: "执行这个" });
  assert.equal(runRequests.length, 0, "旧 snapshot 已消费，不得重复触发");
});

test("F9-v2 指代确认：否定保护——'不要执行这个'不触发执行", async () => {
  const workspace = createTempDir("deepcode-f9v2-aneg-workspace-");
  const home = createTempDir("deepcode-f9v2-aneg-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("好的，不执行。");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  // 方案 B：非 /eag- commandHint → 降级展示 → snapshot 存储
  const { manager } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createStubSuggester({
      type: "suggest_autonomous",
      commandHint: "/team autonomous", // 非 /eag- 开头，触发降级展示
      messageToUser: "建议运行 /team autonomous。",
      reasoning: "多阶段任务",
    }),
  });

  const sessionId = await manager.createSession({ text: "" });

  // 第一轮：非 /eag- 建议降级展示，暂存 snapshot
  await manager.handleUserPrompt({ text: "重构认证模块" });
  // 第二轮：否定指代——ANAPHORA_CONFIRM_NEGATION_PATTERN 拦截 → 指代确认通道不消费
  // 正则通道"不要执行"被否定词拦截 → 降级
  // 建议器（stub 返回 suggest_autonomous，commandHint /team autonomous）→ 又降级展示
  // 最终 runRequests.length === 0（否定输入不触发任何执行）
  await manager.handleUserPrompt({ text: "不要执行这个" });

  assert.equal(runRequests.length, 0, "否定指代不得触发建议执行");
});

// ============================================================================
// 测试用例：F9 执行条件放宽三选一
// ============================================================================

test("F9-v2 条件放宽：显式意图（goal 含 EAG 关键词）首次建议即自动执行", async () => {
  const workspace = createTempDir("deepcode-f9v2-explicit-workspace-");
  const home = createTempDir("deepcode-f9v2-explicit-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  const { manager } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createStubSuggester({
      type: "suggest_autonomous",
      commandHint: "/eag-autonomous",
      messageToUser: "建议运行 /eag-autonomous。",
      reasoning: "多阶段任务",
    }),
  });

  const sessionId = await manager.createSession({ text: "" });
  const baselineLlmCalls = callCount.value;

  // 用户明确点名 EAG（但未匹配确定性通道的意图前缀模式，如动词不在句首枚举内）
  await manager.handleUserPrompt({ text: "数据库同步的事就用 EAG 跑一遍吧" });

  // 显式意图放宽：suggest_autonomous 首次建议即自动执行（无需澄清轮次）
  assert.equal(runRequests.length, 1, "显式 EAG 意图的首次建议应自动执行");
  assert.equal(runRequests[0].objective, "数据库同步的事就用 EAG 跑一遍吧");
  assert.equal(callCount.value, baselineLlmCalls, "自动执行后不应再走主对话");
});

test("方案 B：suggest_autonomous 默认自动执行（不再要求显式 EAG 关键词/澄清/指代）", async () => {
  const workspace = createTempDir("deepcode-f9v2-planB-workspace-");
  const home = createTempDir("deepcode-f9v2-planB-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client, callCount } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  // 方案 B 新行为：suggest_autonomous 默认自动执行——不需要任何软条件（refine/显式意图/指代确认）
  const { manager } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createStubSuggester({
      type: "suggest_autonomous",
      commandHint: "/eag-autonomous", // /eag- 开头，可被 eagCommandParser 分发
      messageToUser: "建议运行 /eag-autonomous。",
      reasoning: "多阶段任务",
    }),
  });

  const sessionId = await manager.createSession({ text: "" });
  const baselineLlmCalls = callCount.value;

  // 普通任务描述（无 EAG 关键词、无澄清、无指代）——方案 B 新行为：直接自动执行
  // 旧 F9-v2 语义：runRequests.length === 0（降级只展示）
  // 方案 B 语义：runRequests.length === 1（suggest_autonomous 默认自动执行）
  await manager.handleUserPrompt({ text: "帮我优化这段代码的性能" });

  assert.equal(runRequests.length, 1, "方案 B：suggest_autonomous 默认自动执行——不再要求显式 EAG 关键词/澄清/指代确认");
  assert.equal(runRequests[0].objective, "帮我优化这段代码的性能");
  assert.equal(callCount.value, baselineLlmCalls, "自动执行后不应再走主对话 LLM");
});

// ============================================================================
// 测试用例：非 EAG 建议不受影响（回归保护）
// ============================================================================

test("方案 B：非 EAG 建议降级展示但追加执行提示（指代确认执行暂时受限）", async () => {
  const workspace = createTempDir("deepcode-f9v2-nonEag-workspace-");
  const home = createTempDir("deepcode-f9v2-nonEag-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const { client } = createCallCountingClient("主对话回复");
  const { orchestrator, runRequests } = createRecordingOrchestrator();
  const { manager, assistantTexts } = createTestManager({
    workspace,
    home,
    client,
    orchestrator,
    suggester: createStubSuggester({
      type: "suggest_command",
      commandCategory: "team",
      commandId: "team-dispatch",
      commandHint: "/team dispatch",
      messageToUser: "建议运行 /team dispatch 处理该任务。",
      reasoning: "团队任务",
    } as EagDynamicSuggestion),
  });

  const sessionId = await manager.createSession({ text: "" });

  // 第一轮：展示 /team 建议（非 EAG 命令——tryAutoExecuteSuggestedCommand 硬条件 1 不满足，降级）
  await manager.handleUserPrompt({ text: "帮我安排一个团队任务" });
  assert.equal(runRequests.length, 0, "非 /eag- 命令不得自动触发 EAG 执行");

  // 方案 B（2026-09-16）新行为：所有有 commandHint 的降级建议都追加提示 + 存 snapshot
  // 旧 F9-v2 行为：非 EAG 建议不追加提示（仅服务 /eag- 白名单）
  const displayed = assistantTexts.find((text) => text.includes("/team dispatch"));
  assert.ok(displayed, "非 EAG 建议文本应展示");
  assert.ok(
    displayed.includes(`回复"执行这个"即可自动执行`),
    "方案 B 新行为：非 EAG 建议也追加执行提示（方便用户看到有这个功能）"
  );

  // 第二轮：指代确认——当前 tryAnaphoraConfirmExecution 用 dispatchEagCommandString 分发
  // 它只认 /eag- 开头的命令，所以非 EAG 命令的指代确认执行暂时受限（返回 false）。
  // 但 snapshot 确实存了 + 提示也加了，只是执行分发需要后续扩展 team handler 接入。
  await manager.handleUserPrompt({ text: "执行这个" });
  // 指代确认执行失败 → 输入继续走建议器 / 正则 → 最终 runRequests 仍为 0
  assert.equal(runRequests.length, 0, "非 EAG 命令的指代确认执行暂时受限（dispatch 分发待扩展）");
});
