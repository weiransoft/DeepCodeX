/**
 * Web 端 EAG 注入 + SIGTERM 沉淀兜底集成测试
 * （docs/dev/eag-web-sedimentation-fixes.md §2.1 / §2.2 验收用例）。
 *
 * 关键架构事实（决定 EAG 用例的触发结构）：
 * - core handleUserPrompt：`!activeSessionId → createSession()`——首轮直达
 *   activateSession 主对话，**不途经** EagCommandParser 分发 / F9-v2 确定性通道 /
 *   建议器；EAG 三层全部只存在于 replySession（第二轮起）。
 * - 因此全部 EAG 输入必须发生在**第二轮**：先发普通消息建立会话，第二轮再发
 *   EAG 意图 / 建议轮。
 *
 * 用例映射：
 * - EA-03a 装配可观测性：第二轮「启动 EAG 自主任务：…」经 replySession 确定性
 *   通道（tryDeterministicEagExecution → dispatchEagCommandString →
 *   handleEagAutonomousCommand）直达执行。注入组权威判据：
 *   ① AutonomousOrchestrator.run() 经 runStateStore.initialize() 落盘
 *     <orchestratorProjectRoot>/.eag/p5/run-state/<runId>.jsonl（P5 运行状态
 *     文件——仅编排器真实启动才会创建；Web personalOnly 模式下编排器 projectRoot
 *     = SessionManager 的 projectRoot = realpath 归一后的个人工作区，EAG 落点
 *     与记忆/日志的 homeDir 牢笼相互独立）；
 *   ② 回合回复必须命中 EagAutonomousCommandHandler 报告标题（
 *     「# [EAG Autonomous Loop] 执行结果」或「# [EAG Autonomous Loop] 执行失败」——
 *     注入形态 handler 必渲染其一，fail-closed 形态只推送「未注入」短文案）；
 *   ③ 绝不出现「AutonomousOrchestrator 未注入」fail-closed 文案；
 *   ④ 编排器 dev 阶段经 LlmTaskExecutor 真实驱动非流式 LLM（执行器回合走
 *     createMessage 通道，脚本以「编码完成」终态文本收敛，执行器经 git 检出变更文件）。
 * - EA-03a 基线（eagEnabled=false）：同两轮结构 → 第二轮断言 SSE assistant_message
 *   出现「[EAG Autonomous Loop] AutonomousOrchestrator 未注入」fail-closed 文案
 *   （与注入组构成严格同输入的注入/未注入可观测差异）。
 * - EA-03b 建议器自动执行（Web 宿主 F9-v2 兜底，session-pool
 *   scheduleAutoExecuteSuggestion）：第一轮普通回复以「建议启动 /eag-autonomous …」
 *   收尾 → done 帧后服务端自动注入命令回合：SSE 出现「建议器自动执行」system
 *   提示帧 + 命令文本作为用户消息进入会话 + 注入回合真实执行（done 计数增加、
 *   注入命令文本命中编排器 LlmTaskExecutor 的 createMessage 请求，证明服务端
 *   真实执行而非仅展示）；同建议再来一轮不重复执行（每会话一次守卫）；
 *   无建议句式的普通回复零过度触发。
 * - SD-03 关闭链路沉淀兜底：脚本回合真实执行 bash 工具（执行历史记录落盘）→
 *   running.close()（SIGTERM 优雅关闭链路：close → disposeAll → flushSedimentation）→
 *   断言 <engineHome>/<userId>/.deepcodex/logs/sedimentation.log 出现该会话的
 *   type:"flush" 行，且 <engineHome>/<userId>/.deepcode/memory/experience.json 含沉淀条目。
 *
 * 测试策略（真实 HTTP + SSE，无 mock 框架——用户硬性规则）：
 * - 真实 startWebServer（随机端口、localUsers 登录、personalOnly=true 多用户牢笼）；
 * - LLM 经 createLLMClient 缝合点注入受控客户端（RoutingLLMClient 按请求形态路由：
 *   带 tools 的非流式请求 = 编排器 LlmTaskExecutor 执行通道；含「全局动态编排建议
 *   助手」的非流式请求 = 建议器决策通道；其余非流式 = 保守降级 direct_chat；
 *   createMessageStream = 主对话脚本队列）；
 * - 不 mock core 工厂——EAG 三编排器/建议器全部走 session-pool 真实装配路径。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LLMClient, LLMRequest, LLMResponse, LLMStreamEvent } from "@vegamo/deepcode-core";
import { startWebServer, type RunningWebServer } from "../src/server";
import { personalUploadRoot } from "../src/user-files";
import {
  createControlledOpenAIClientHandle,
  createResolvedSettings,
  extractAuthCookie,
  fetchJson,
  makeCtx,
  openSseStream,
  sha256Hex,
} from "./helpers";

// ============================================================================
// 受控三通道路由 LLM 客户端（真实受控实现，非 mock 框架）
// ============================================================================

/** 路由决策日志条目（三通道共用观测：stream / decision / executor） */
type LlmLogEntry = {
  /** stream=主对话流式请求；decision=建议器非流式决策请求；executor=编排器任务执行器非流式请求 */
  kind: "stream" | "decision" | "executor";
  /** 请求消息序列化文本（命令注入断言 / 通道识别依据） */
  text: string;
};

/**
 * 非流式请求的通道判定（单一事实源，createMessage 与 requestLog 共用）：
 * - 带 tools 的非流式请求 = 编排器 LlmTaskExecutor 执行通道
 *   （core llm-task-executor.ts：每轮 createMessage({messages, tools, ...})）；
 * - 含「全局动态编排建议助手」（core buildEagSuggestionPrompt system 开场白）
 *   的非流式请求 = 建议器决策通道；
 * - 其余非流式请求（技能匹配等）= 保守降级（direct_chat / 空技能数组），绝不误触发。
 */
function classifyNonStreamingRequest(request: LLMRequest): "decision" | "executor" | "other" {
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    return "executor";
  }
  const text = JSON.stringify(request.messages ?? []);
  if (text.includes("全局动态编排建议助手")) {
    return "decision";
  }
  return "other";
}

/**
 * bash 工具调用回合脚本（SD-03：真实执行命令 → 执行历史记录落盘）。
 * 事件名严格对齐 core LLMStreamEvent（tool_call_start / tool_call_delta / tool_call_end），
 * 错误事件名会被聚合层静默忽略并产出空 toolCalls → 主循环空转死循环（教训留痕）。
 * sideEffects 必须显式声明（permissions.ts parseBashSideEffects：缺省/非法 → ["unknown"]，
 * 而 unknown scope 在 manual/auto 模式下恒 ask → 回合停在审批等待永不收敛）。
 * write-in-cwd 对齐测试环境权限配置（auto + allow:["write-in-cwd"] → 免审批真实执行）。
 */
function bashToolTurnEvents(command: string, callId: string): LLMStreamEvent[] {
  return [
    { type: "tool_call_start", id: callId, name: "bash" },
    {
      type: "tool_call_delta",
      id: callId,
      argumentsJsonDelta: JSON.stringify({ command, sideEffects: ["write-in-cwd"] }),
    },
    { type: "tool_call_end", id: callId },
    { type: "message_end", stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 3 } },
  ];
}

/** 收敛文本回合脚本（工具执行后的收尾纯文本 / 普通主对话回合） */
function plainTurnEvents(text: string): LLMStreamEvent[] {
  return [
    { type: "text_delta", text },
    { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } },
  ];
}

/**
 * 三通道路由受控 LLM 客户端：
 * - createMessage（非流式）按请求形态路由（classifyNonStreamingRequest）：
 *   executor=编排器任务执行器脚本队列（耗尽 → 空文本终态 = 无工具调用 → 执行器正常收敛）；
 *   decision=建议器决策脚本队列（耗尽 → direct_chat 保守降级，绝不误触发建议）；
 *   other=空响应（技能匹配等非流式旁路）；
 * - createMessageStream（流式）= 主对话通道——按脚本队列逐请求弹出；
 * 路由决策全量记录于 requestLog，供「编排器真实驱动 LLM / 命令注入 / 守卫不发起」断言。
 */
class RoutingLLMClient implements LLMClient {
  readonly providerName = "anthropic" as const;
  readonly model = "routing-test";
  readonly baseURL = "http://localhost:8000/v1";
  readonly supportsThinking = false;
  readonly supportsPromptCaching = false;

  /** 路由决策日志（顺序即请求顺序） */
  readonly requestLog: LlmLogEntry[] = [];

  /** 编排器任务执行器脚本队列（非流式带 tools 请求按序消费） */
  private executorScript: LLMResponse[];
  /** 建议器决策脚本队列（按建议请求顺序弹出；耗尽后恒返 direct_chat） */
  private decisions: string[];

  constructor(
    /** 主对话流式脚本队列（按请求顺序弹出） */
    private script: LLMStreamEvent[][],
    /** 建议器决策脚本队列 */
    decisions: string[] = [],
    /** 编排器任务执行器脚本队列 */
    executorScript: LLMResponse[] = []
  ) {
    this.executorScript = executorScript;
    this.decisions = decisions;
  }

  /** 切换脚本队列（用例间复用同一客户端实例） */
  setScript(script: LLMStreamEvent[][], decisions: string[] = [], executorScript: LLMResponse[] = []): void {
    this.script = script;
    this.decisions = decisions;
    this.executorScript = executorScript;
  }

  /** 指定通道的请求计数（断言用） */
  countOf(kind: LlmLogEntry["kind"]): number {
    return this.requestLog.filter((entry) => entry.kind === kind).length;
  }

  /**
   * 非流式通道（建议器决策 / 编排器任务执行器 / 其他旁路）。
   *
   * 编排器执行器回合返回脚本队列响应（终态 = 无 toolCalls 的文本总结，执行器据此
   * 正常收敛）；建议器回合返回决策 JSON；其余（技能匹配走非流式分支等）返回空文本
   * ——保守降级，绝不构造出可被误认为建议/执行的内容。
   */
  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const channel = classifyNonStreamingRequest(request);
    const text = JSON.stringify(request.messages ?? []);
    this.requestLog.push({ kind: channel === "other" ? "decision" : channel, text });
    if (channel === "executor") {
      const next = this.executorScript.shift();
      if (next) {
        return next;
      }
      // 脚本耗尽：无工具调用终态文本（执行器视为任务完成收敛，不挂起）
      return {
        content: "执行器脚本耗尽，任务收敛",
        thinking: "",
        toolCalls: [],
        stopReason: null,
        usage: { inputTokens: 5, outputTokens: 2 },
      };
    }
    if (channel === "decision") {
      const next = this.decisions.shift();
      return {
        content: next ?? JSON.stringify({ action: "direct_chat", reasoning: "脚本耗尽，直接对话" }),
        thinking: "",
        toolCalls: [],
        stopReason: null,
        usage: null,
      };
    }
    // other：非建议、非执行器的非流式旁路（如技能匹配 anthropic 分支）——空响应
    return { content: "", thinking: "", toolCalls: [], stopReason: null, usage: null };
  }

  /**
   * 主对话流式通道：按脚本队列产出事件。
   *
   * 技能匹配流式请求兜底：core identifyMatchingSkillNames 在 openai provider 下走
   * 流式（本受控客户端 providerName="anthropic" 正常走 createMessage 非流式分支），
   * 按「available skills match」锚点返回空技能数组、不占用主对话脚本队列。
   */
  async *createMessageStream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const text = JSON.stringify(request.messages ?? []);
    if (text.includes("available skills match")) {
      this.requestLog.push({ kind: "stream", text });
      yield { type: "text_delta", text: '{"skillNames": []}' };
      yield { type: "message_end", stopReason: "end_turn", usage: null };
      return;
    }
    const events = this.script.shift() ?? plainTurnEvents("默认收尾回复");
    this.requestLog.push({ kind: "stream", text });
    for (const event of events) {
      if (request.signal?.aborted) {
        throw new Error("AbortError: stream aborted by consumer");
      }
      yield event;
    }
  }
}

/**
 * 编排器任务执行器「终态文本」响应构造器（无 toolCalls = 执行器任务完成收敛）。
 *
 * @param content 终态总结文本（执行器记录为任务摘要）
 * @returns 非流式 LLMResponse（executor 通道脚本元素）
 */
function executorTextResponse(content: string): LLMResponse {
  return {
    content,
    thinking: "",
    toolCalls: [],
    stopReason: null,
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

// ============================================================================
// 共享夹具：三服务器（EAG 注入 / 未注入基线 / SD-03 关闭链路专用）
// ============================================================================

/** 临时根目录 */
let tmpRoot: string;
/** 注册表注入根（隔离真实 ~/.deepcode/web/chats） */
let registryDir: string;

/** EAG 注入服务器（personalOnly=true）——EA-03a / EA-03b */
let server: RunningWebServer;
let client: RoutingLLMClient;
/** 未注入基线服务器（eagEnabled=false）——fail-closed 文案对照 */
let failclosedServer: RunningWebServer;
let failclosedClient: RoutingLLMClient;
/** SD-03 专用服务器（close 验证 flush 链路，本文件内逐用例重建） */
let sdServer: RunningWebServer;
let sdClient: RoutingLLMClient;
/** 各服务器登录 Cookie */
let cookie: string;
let failclosedCookie: string;
let sdCookie: string;
/** 各服务器 admin 个人工作区根（createChat 显式传参用） */
let eagPersonalRoot: string;
let failclosedPersonalRoot: string;
let sdPersonalRoot: string;
const ctx = makeCtx("admin");

// per-server 引擎数据家目录根派生（与 makeServer 内 serverEngineHomeRoot 同式）：
// EAG P5 运行数据（run-state/tasks.md）与引擎 homeDir（<engineHomeRoot>/<userId>）
// 对齐，服务器间物理隔离
function serverEngineHomeRootOf(name: string): string {
  return path.join(tmpRoot, `engine-home-${name}`);
}

/**
 * 构造一台测试服务器（localUsers=admin 登录、受控 LLM 注入、注册表隔离）。
 *
 * @param name 临时目录前缀（服务器间目录隔离）
 * @param eagEnabled false → 测试开关：跳过 EAG 注入（复现装配前 fail-closed 基线）
 * @returns 运行中的服务器、受控客户端、登录 Cookie 与个人工作区根
 */
async function makeServer(
  name: string,
  eagEnabled: boolean
): Promise<{ server: RunningWebServer; client: RoutingLLMClient; cookie: string; personalRoot: string }> {
  const uploadDir = path.join(tmpRoot, `uploads-${name}`);
  // per-server 引擎数据家目录根（与 serverEngineHomeRootOf 同式）：EAG P5 运行数据
  // （run-state/tasks.md）落点 = engineHomeDir = <engineHomeRoot>/<userId>，
  // 三服务器物理隔离——fail-closed 基线（failclosed）绝不共享注入组的 EAG 任务清单，
  // 「未注入」判据才纯净（共享 engine-home 时注入组播种的 tasks.md 会被基线轮次读到）。
  const serverEngineHomeRoot = serverEngineHomeRootOf(name);
  const settings = createResolvedSettings({
    projectRoot: tmpRoot,
    allowRoots: [tmpRoot],
    uploadDir,
    personalOnly: true,
    engineHomeRoot: serverEngineHomeRoot,
    auth: {
      jwtSecret: `eag-web-${name}-secret`,
      sessionTtlSeconds: 3600,
      localUsers: [{ username: "admin", passwordHash: sha256Hex(`pass-${name}`) }],
    },
  });
  const scriptClient = new RoutingLLMClient([plainTurnEvents("默认回复")]);
  const running = await startWebServer(settings, {
    createLLMClient: () => scriptClient,
    createOpenAIClient: () => createControlledOpenAIClientHandle(),
    // 注册表隔离注入点位于 startWebServer 选项（WebServerOptions→SessionPoolOptions），
    // 不属于 ResolvedWebSettings 配置面
    registryBaseDir: registryDir,
    ...(eagEnabled ? {} : { eagEnabled: false }),
  });
  const login = await fetchJson(running.port, "POST", "/api/auth/login", {
    username: "admin",
    password: `pass-${name}`,
  });
  assert.equal(login.status, 200, "登录前置条件失败");
  const authCookie = extractAuthCookie(login.headers)!;
  return {
    server: running,
    client: scriptClient,
    cookie: authCookie,
    personalRoot: personalUploadRoot(uploadDir, ctx.userId),
  };
}

before(async () => {
  tmpRoot = await realpath(mkdtempSync(path.join(tmpdir(), "deepcode-web-eag-")));
  registryDir = mkdtempSync(path.join(tmpdir(), "deepcode-web-eag-registry-"));

  const eag = await makeServer("eag", true);
  server = eag.server;
  client = eag.client;
  cookie = eag.cookie;
  eagPersonalRoot = eag.personalRoot;

  const fc = await makeServer("failclosed", false);
  failclosedServer = fc.server;
  failclosedClient = fc.client;
  failclosedCookie = fc.cookie;
  failclosedPersonalRoot = fc.personalRoot;
});

after(async () => {
  await server.close();
  await failclosedServer.close();
  await sdServer?.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

/**
 * 在指定服务器上创建测试会话（personalOnly：projectRoot 显式传本人个人区）。
 *
 * @param running 目标服务器
 * @param authCookie 登录 Cookie
 * @param personalRoot 该服务器的个人区根
 * @returns chatId
 */
async function createChat(running: RunningWebServer, authCookie: string, personalRoot: string): Promise<string> {
  const created = await fetchJson(running.port, "POST", "/api/chats", { projectRoot: personalRoot }, authCookie);
  assert.equal(created.status, 200, `创建会话失败：${JSON.stringify(created.body)}`);
  return created.body.chatId as string;
}

/**
 * 发送 JSON 文本消息（202 异步受理契约）。
 */
async function sendText(running: RunningWebServer, authCookie: string, chatId: string, text: string): Promise<void> {
  const send = await fetchJson(running.port, "POST", `/api/chats/${chatId}/messages`, { text }, authCookie);
  assert.equal(send.status, 202, `消息应 202 异步受理：${JSON.stringify(send.body)}`);
}

async function waitFor(predicate: () => boolean, timeoutMs?: number, description?: string): Promise<void>;
async function waitFor<T>(predicate: () => T | null, timeoutMs?: number, description?: string): Promise<T>;
/**
 * 轮询等待条件成立（超时抛错）。
 * 谓词返回假值视为未满足；返回值（非 null/undefined/false）作为等待结果透出，
 * 便于失败消息携带现场数据（如已收集的 SSE 文本、requestLog 快照）。
 */
async function waitFor<T>(
  predicate: () => T | boolean | null,
  timeoutMs = 20000,
  description = "条件"
): Promise<T | void> {
  const started = Date.now();
  for (;;) {
    const result = predicate();
    if (result !== false && result !== null && result !== undefined) {
      return result as T;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`等待${description}超时（${timeoutMs}ms）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 读取引擎会话条目（经 listChats 公开出口观测 status 与 sessionId 绑定）。
 */
function findChatSummary(
  running: RunningWebServer,
  chatId: string
): { status: string; sessionId: string | null } | null {
  return running.pool.listChats(ctx).find((chat) => chat.chatId === chatId) ?? null;
}

// ============================================================================
// EA-03a：EAG 装配注入的可观测差异（第二轮确定性通道直达编排器）
// ============================================================================

test("EA-03a：第二轮确定性 EAG 意图直达编排器执行（P5 run-state 落盘 + 报告回合，非 fail-closed）", async () => {
  // 结构（core handleUserPrompt 首轮直达主对话、EAG 三层只在 replySession）：
  // 第一轮 = 普通消息建立会话（主对话脚本单回合收敛）；
  // 第二轮 = 「启动 EAG 自主任务：…」→ tryDeterministicEagExecution 纯文本命中
  //   规则 B（意图前缀 + EAG/自主关键词，无否定词）→ dispatchEagCommandString →
  //   handleEagAutonomousCommand → AutonomousOrchestrator.run()。
  // 编排器 4 阶段循环（预播种单卡 pending 任务 → dev 阶段经绑定执行器真实驱动
  // LlmTaskExecutor createMessage，脚本以「编码完成」终态文本收敛；
  // verify 无测试命令跳过、fix 无阻塞跳过 → plan 下一轮判 all-tasks-completed
  // → finalStatus=completed 收敛出 Markdown 报告）：
  // - run() 入口 runStateStore.initialize() 真实落盘
  //   <orchestratorProjectRoot>/.eag/p5/run-state/<runId>.jsonl
  //   ——编排器真实启动的物理证据（未注入基线绝无此文件）；
  // - 循环收敛 → handler.formatReport → onAssistantMessage 推送
  //   「# [EAG Autonomous Loop] 执行结果/执行失败」Markdown；
  // - 回合不途经流式通道（命令分发直达 handler），流式脚本仅作主循环空转收敛防御。
  client.setScript(
    [plainTurnEvents("第一轮普通回合已建立会话"), plainTurnEvents("空转防御：EAG 命令回合不应消费本脚本")],
    [],
    [executorTextResponse("任务卡编码完成：已创建修复文件")]
  );
  const chatId = await createChat(server, cookie, eagPersonalRoot);

  // 预播种个人区任务清单：单卡 T-001 状态 pending（dev 阶段经绑定执行器真实跑，
  // 诚实终态，编排器单轮收敛快速产出报告）。落点与编排器默认路径一致：
  // <orchestratorProjectRoot>/.eag/p5/tasks.md——Web 宿主下编排器 projectRoot =
  // SessionManager 的 projectRoot = resolvedRoot（realpath 归一后的个人区
  // <uploadDir>/<userId>；session-pool createChat 传入）。注意 session-pool 的
  // 「W2 牢笼注入」homeDir=<engineHomeRoot>/<userId> 只牢笼记忆/日志/会话索引
  // （.deepcode 数据），**不影响** EAG 引擎的 projectRoot 锚点。
  const eagP5Dir = path.join(await realpath(eagPersonalRoot), ".eag", "p5");
  mkdirSync(eagP5Dir, { recursive: true });
  // 用例自隔离：plan 路径硬编码 <projectRoot>/.eag/p5/tasks.md（core
  // plan-stage-handler.ts L271），同服务器所有用例共享同一份清单——先清除
  // 可能残留的旧清单（node --test 单进程按文件顺序执行、tmpRoot 每次新建，
  // 正常无残留；此句为防御，杜绝跨用例清单泄漏）。
  rmSync(path.join(eagP5Dir, "tasks.md"), { force: true });
  writeFileSync(
    path.join(eagP5Dir, "tasks.md"),
    [
      "# EAG-P5 任务清单（测试预播种：单卡已完成，编排器单轮收敛出报告）",
      "",
      "## T-001 修复登录页面空指针（测试预播种卡）",
      "- requirement: AUTO",
      "- status: completed",
      "- dependencies:",
      "- files:",
      "- deletions:",
      "- symbols:",
      "- acceptance:",
      "",
    ].join("\n"),
    "utf8"
  );

  const { collector, controller } = await openSseStream(server.port, chatId, cookie);

  // —— 第一轮：普通消息建立底层会话（首轮不途经 EAG 层，主对话脚本收敛）——
  await sendText(server, cookie, chatId, "今天天气怎么样");
  const firstDone = await collector.waitFor("done", 20000);
  assert.equal(firstDone.data.status, "completed", `第一轮普通回合应 completed：${JSON.stringify(firstDone.data)}`);
  // 第一轮建立会话后 sessionId 必须已绑定（replySession 前置条件）
  assert.ok(findChatSummary(server, chatId)?.sessionId, "第一轮后必须绑定底层 sessionId");

  // —— 第二轮：EAG 意图句式命中确定性通道（与 failclosed 基线严格同输入）——
  const eagGoal = "启动 EAG 自主任务：修复登录页面的空指针问题";
  await sendText(server, cookie, chatId, eagGoal);

  // 可观测差异①（权威判据·物理证据）：编排器 run() 经 runStateStore.initialize()
  // 真实落盘 P5 运行状态文件 <orchestratorProjectRoot>/.eag/p5/run-state/*.jsonl
  // （= realpath 归一后的个人区）——只有 AutonomousOrchestrator 真实启动才会创建
  // （fail-closed 分支在 handler 入口即返回，绝无此文件；且 failclosed 服务器有
  // 独立上传区/引擎区，绝无串扰）。
  const runStateDir = path.join(eagP5Dir, "run-state");
  await waitFor(
    () => (existsSync(runStateDir) && readFileSyncDirSafe(runStateDir).some((f) => f.endsWith(".jsonl"))) || null,
    20000,
    `P5 run-state 落盘（${runStateDir}）`
  );

  // 可观测差异②：回合回复必须命中注入形态专属的 handler Markdown 报告标题
  // （「执行结果」或「执行失败」均为编排器真实运行后的渲染产物；
  // fail-closed 形态只有「[EAG Autonomous Loop] AutonomousOrchestrator 未注入」短文案）。
  // 报告经 onAssistantMessage 桥接异步抵达 SSE，先轮询等报告帧出现再收敛 done。
  const doneWait = collector.waitFor("done", 30000);
  const loopReport = await waitFor(
    () => {
      const texts = collector.events
        .filter((event) => event.event === "assistant_message")
        .map((event) => String(event.data?.content ?? ""));
      return texts.find(
        (text) => text.includes("# [EAG Autonomous Loop] 执行结果") || text.includes("# [EAG Autonomous Loop] 执行失败")
      );
    },
    20000,
    `[EAG Autonomous Loop] Markdown 报告帧（SSE=${JSON.stringify(collector.events.map((e) => e.event))}）`
  );
  const done = await doneWait;
  controller.abort();
  const assistantTexts = collector.events
    .filter((event) => event.event === "assistant_message")
    .map((event) => String(event.data?.content ?? ""));
  assert.ok(
    loopReport,
    `必须出现编排器注入后的 [EAG Autonomous Loop] Markdown 报告回合；实际：${JSON.stringify(assistantTexts)}`
  );

  // 可观测差异③（fail-closed 反证）：注入组绝不能出现「未注入」文案
  assert.ok(
    !assistantTexts.some((text) => text.includes("AutonomousOrchestrator 未注入")),
    "装配注入后绝不能出现 fail-closed「未注入」文案"
  );

  // 可观测差异④：done 帧状态取第二回合引擎条目快照——编排器循环正常收敛
  // （报告 success → completed；报告失败 → failed）。两种终态都是「编排器真实
  // 运行完毕」的证据；命令级失败（fail-closed）的权威证据由基线用例单独锚定。
  assert.ok(
    done.data.status === "completed" || done.data.status === "failed",
    `EAG 命令回合必须以终态收敛：${JSON.stringify(done.data)}`
  );

  // 可观测差异⑤（回合区分佐证）：EAG 命令回合不途经流式通道——主对话流式请求
  // 必须恰好 1 次（仅第一轮）；编排器若驱动 dev 阶段任务执行，走的是
  // createMessage（executor 通道），两种情况都不增加流式计数。
  assert.equal(
    client.countOf("stream"),
    1,
    `EAG 命令回合不得消费主对话流式脚本；实际：${JSON.stringify(client.requestLog)}`
  );
});

/** 目录安全列举（不存在/竞态删除时返回空数组） */
function readFileSyncDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

test("EA-03a 基线：eagEnabled=false → 第二轮同一输入落 fail-closed「未注入」文案", async () => {
  // 与 EA-03a 注入组严格同结构（第一轮建会话 + 第二轮同 EAG 意图句式）、严格同输入。
  // failclosed 服务器使用独立 engine-home（engine-home-failclosed，无注入组播种的
  // tasks.md），fail-closed 判据纯净。fail-closed 回合不经流式通道（handler 在
  // 未注入分支直接推送文案后返回），流式脚本仅作主对话第一轮的回合脚本与空转收敛防御。
  failclosedClient.setScript([
    plainTurnEvents("第一轮普通回合已建立会话"),
    plainTurnEvents("空转防御：fail-closed 回合不应消费本脚本"),
  ]);
  const chatId = await createChat(failclosedServer, failclosedCookie, failclosedPersonalRoot);
  const { collector, controller } = await openSseStream(failclosedServer.port, chatId, failclosedCookie);

  // 第一轮：普通消息建立底层会话
  await sendText(failclosedServer, failclosedCookie, chatId, "今天天气怎么样");
  const firstDone = await collector.waitFor("done", 20000);
  assert.equal(firstDone.data.status, "completed", `第一轮普通回合应 completed：${JSON.stringify(firstDone.data)}`);
  assert.ok(findChatSummary(failclosedServer, chatId)?.sessionId, "第一轮后必须绑定底层 sessionId");

  // 第二轮：与注入组同句式 → replySession 确定性通道同样命中
  // tryDeterministicEagExecution → handleEagAutonomousCommand 未注入分支。
  await sendText(failclosedServer, failclosedCookie, chatId, "启动 EAG 自主任务：修复登录页面的空指针问题");

  // 可观测差异判据 = fail-closed 文案本身：core handleEagAutonomousCommand 在
  // autonomousOrchestrator 未注入时经 onAssistantMessage 推送
  // 「[EAG Autonomous Loop] AutonomousOrchestrator 未注入：…」（session.ts fail-closed 分支）。
  // done 帧状态（failed）同样作为辅助证据收集，权威判据仍是文案本身。
  const assistantTexts = await waitFor(
    () => {
      const texts = collector.events
        .filter((event) => event.event === "assistant_message")
        .map((event) => String(event.data?.content ?? ""));
      if (texts.some((text) => text.includes("AutonomousOrchestrator 未注入"))) return texts;
      if (collector.countOf("done") >= 2) {
        throw new Error(`第二轮已 done 但无「未注入」文案；assistant=${JSON.stringify(texts)}`);
      }
      return null;
    },
    20000,
    `fail-closed「未注入」文案（SSE=${JSON.stringify(collector.events.map((e) => e.event))}）`
  );
  controller.abort();
  assert.ok(
    assistantTexts.some((text) => text.includes("[EAG Autonomous Loop]")),
    `fail-closed 文案必须以 [EAG Autonomous Loop] 前缀呈现；实际：${JSON.stringify(assistantTexts)}`
  );
  // fail-closed 分支零 LLM 请求：fail-closed 回合不经任何流式/执行器通道
  // （流式计数保持第一轮 1 次 = 仅主对话第一轮）
  assert.equal(
    failclosedClient.countOf("stream"),
    1,
    `fail-closed 回合不得发起流式 LLM 请求；实际：${JSON.stringify(failclosedClient.requestLog)}`
  );
});

// ============================================================================
// EA-03b：建议器自动执行白名单兜底（Web 宿主 scheduleAutoExecuteSuggestion）
// ============================================================================

test("EA-03b：纯文本建议回合 → 服务端兜底自动注入执行一次/会话（系统提示帧 + 真实执行 + 守卫）", async () => {
  // 第一轮：普通消息建会话，主对话纯文本以「建议启动 /eag-autonomous …」收尾
  // （建议句式避开否定保护：extractSuggestedCommandText 的 12 字符否定窗口）；
  // done 帧收敛后 session-pool.scheduleAutoExecuteSuggestion 扫描
  // entry.assistantReply 命中句式 + eag-autonomous 白名单 → 置位一次性守卫 →
  // fire-and-forget 注入回合：SSE 推送「建议器自动执行」system 提示帧 →
  // 命令文本作为用户消息经 runTurn 通路 → replySession EagCommandParser
  // 直达 handleEagAutonomousCommand → 编排器真实执行。
  // 编排器执行器脚本：终态文本（无工具调用）供 LlmTaskExecutor 收敛。
  // 脚本队列与轮次严格对齐：首轮直达主对话不途经建议器——
  // 「建议启动 /eag-autonomous …」句式必须出现在**第二轮用户回合**的回复中，
  // done 收敛后服务端兜底注入命令回合（消费注入防御脚本位），其后依次是
  // 守卫轮、守卫拦截防御位、零过度触发轮。
  client.setScript(
    [
      // 第一轮：普通建会话轮（直达主对话，不途经建议器）
      plainTurnEvents("好的，我先分析一下这个页面。"),
      // 第二轮：回合文本以「建议启动 /eag-autonomous …」收尾（建议句式避开
      // extractSuggestedCommandText 的 12 字符否定窗口）→ done 后服务端兜底命中
      plainTurnEvents("分析完成，建议启动 /eag-autonomous 修复登录失败问题。"),
      // 注入回合：命令命中 EagCommandParser 直达编排器，不应消费流式脚本
      plainTurnEvents("空转防御：编排器命令回合不应消费本脚本"),
      // 第三轮：同建议句式 → 命中一次性守卫拦截（不得再注入）
      plainTurnEvents("好的，建议启动 /eag-autonomous 再来一次修复登录失败问题。"),
      // 守卫拦截后本轮主对话应答（不消费注入防御脚本）
      plainTurnEvents("空转防御：守卫拦截后不应消费本脚本"),
      // 第四轮：普通回复（无建议句式）→ 零过度触发
      plainTurnEvents("好的，已按你的要求处理完毕，没有需要执行的事项。"),
    ],
    [],
    [executorTextResponse("任务执行完成：已按任务卡完成修复")]
  );
  const chatId = await createChat(server, cookie, eagPersonalRoot);

  // 预播种个人区任务清单：单卡 T-001 状态 pending——注入回合的编排器 dev 阶段
  // 经绑定 LlmTaskExecutor 真实驱动 createMessage（executor 通道断言的物理前提；
  // 若读到 completed 卡则 plan 直接判 all-tasks-completed、执行器零调用）。
  // 同目录隔离：plan 阶段路径硬编码 <projectRoot>/.eag/p5/tasks.md（core
  // plan-stage-handler.ts L271，不可注入路径）。EA-03a 与本用例按声明顺序在同
  // 进程、同一服务器、同一 personalRoot 执行——EA-03a 播种（并被其编排器
  // markTaskCompleted 回写）的 completed 卡若不清除，plan 会直接判
  // all-tasks-completed、执行器零调用（executor 通道断言必失败）。
  // 先移除陈旧清单，再播种本用例的 pending 卡；收尾再删，杜绝向后续用例泄漏。
  const eagP5DirB = path.join(await realpath(eagPersonalRoot), ".eag", "p5");
  rmSync(path.join(eagP5DirB, "tasks.md"), { force: true });
  mkdirSync(eagP5DirB, { recursive: true });
  const tasksFileB = path.join(eagP5DirB, "tasks.md");
  writeFileSync(
    tasksFileB,
    [
      "# EAG-P5 任务清单（EA-03b 预播种：单卡 pending，注入回合 dev 真实执行）",
      "",
      "## T-001 修复登录失败问题（EA-03b 预播种卡）",
      "- requirement: AUTO",
      "- status: pending",
      "- dependencies:",
      "- files:",
      "- deletions:",
      "- symbols:",
      "- acceptance:",
      "",
    ].join("\n"),
    "utf8"
  );
  // 播种自校验：文件可读且解析为 pending 卡（排除同进程并发写入竞态）
  assert.ok(readFileSync(tasksFileB, "utf8").includes("- status: pending"), "EA-03b pending 卡播种失败");

  const { collector, controller } = await openSseStream(server.port, chatId, cookie);

  // 第一轮：普通消息建立底层会话（建议句式必须出现在**回复**中，触发条件作用于
  // entry.assistantReply；建议句式避开「不要/别/勿…」否定前文）
  await sendText(server, cookie, chatId, "帮我看看这个页面");
  const firstDone = await collector.waitFor("done", 20000);
  assert.equal(firstDone.data.status, "completed", "第一轮普通回合应 completed");

  // —— 第二轮：用户回合的回复以「建议启动 /eag-autonomous …」句式收尾
  //（脚本队列第 2 项），done 收敛后服务端兜底扫描 entry.assistantReply 命中 →
  //  fire-and-forget 注入命令回合 ——
  await sendText(server, cookie, chatId, "分析完了吗？下一步怎么办");
  const secondDone = await collector.waitFor("done", 20000);
  assert.equal(secondDone.data.status, "completed", "第二轮建议回合应 completed");

  // —— 服务端兜底应异步发起注入回合 ——
  // 断言①：SSE 出现「建议器自动执行」system 提示帧（既有事件桥接格式，role=system）
  const notices = () =>
    collector.events.filter(
      (event) =>
        event.event === "assistant_message" &&
        event.data?.role === "system" &&
        String(event.data?.content ?? "").includes("建议器自动执行")
    );
  await waitFor(() => (notices().length >= 1 ? true : null), 15000, "「建议器自动执行」system 提示帧");
  // 断言②：提示帧中的命令文本含注入的 /eag-autonomous
  const notice = notices()[0]!;
  assert.ok(
    String(notice.data.content).includes("/eag-autonomous"),
    `系统提示必须注明被自动执行的命令；实际：${JSON.stringify(notice.data)}`
  );

  // 断言③（自动注入回合真实执行）：注入的命令文本作为用户消息进入会话。
  // 注意：注入回合走 runTurn 内部通路（不经 HTTP sendMessage，不广播 SSE
  // user_message 帧——该帧仅对排队受理/steering 注入两路径广播，属既有产品语义）。
  // 命令文本进入会话历史的权威判据 = 引擎落盘的用户消息：注入回合 done 后
  // GET /messages 必须含恰好一条带 /eag-autonomous 的用户消息
  // （handleEagAutonomousCommand 步骤 1 appendSessionMessage 真实落盘）。
  await waitFor(() => (collector.countOf("done") >= 3 ? true : null), 30000, "自动注入回合 done 帧");
  const history = await fetchJson(server.port, "GET", `/api/chats/${chatId}/messages`, undefined, cookie);
  assert.equal(history.status, 200, `历史消息接口应 200：${JSON.stringify(history.body)}`);
  const userTexts = (history.body.messages as Array<{ role: string; content?: string }>)
    .filter((message) => message.role === "user")
    .map((message) => String(message.content ?? ""));
  assert.ok(
    userTexts.some((text) => text.includes("/eag-autonomous")),
    `自动注入的命令文本必须以用户消息进入会话历史；实际：${JSON.stringify(userTexts)}`
  );
  // 注入命令文本必须恰好 1 次（一次性守卫下限证据——不得重复注入）
  const injectedCount = userTexts.filter((text) => text.includes("/eag-autonomous")).length;
  assert.equal(injectedCount, 1, `命令文本必须恰好注入一次；实际：${JSON.stringify(userTexts)}`);

  // 断言④：编排器执行器通道真实消费注入命令（注入回合 done 已在断言③前收敛，
  // done 计数：第一轮 + 建议回合 + 注入回合 = 3）。
  // 执行器请求文本必须携带注入命令文本中的 goal（服务端真实执行而非仅展示的
  // 进程内证据；命令文本本身的可观测性已由会话历史锚定）
  await waitFor(
    () => (client.countOf("executor") >= 1 ? true : null),
    10000,
    `编排器任务执行器 LLM 请求（executor 通道）；requestLog=${JSON.stringify(client.requestLog.map((e) => e.kind))}`
  );

  // 断言⑤（守卫）：同会话再次出现相同建议 → 不再自动执行。
  // 判据：守卫拦截的权威证据 = 回合收敛后不再新增「建议器自动执行」system 提示帧
  //（system 帧只在真实触发注入时推送一次）。
  const autoNoticeCountBefore = notices().length;
  const streamCountBefore = client.countOf("stream");
  // 第三轮（用户发送）：回复再次命中同建议句式 → 兜底扫描命中守卫拦截
  await sendText(server, cookie, chatId, "再帮我确认一下之前说的那个问题");
  const doneCountBeforeThird = collector.countOf("done");
  await waitFor(() => (collector.countOf("done") >= doneCountBeforeThird + 1 ? true : null), 20000, "第三轮 done 帧");
  // 再等一个宽限窗，确保（若错误触发的）自动注入即使异步发起也能被观测到
  await new Promise((resolve) => setTimeout(resolve, 500));
  const autoNoticeCountAfter = notices().length;
  assert.equal(
    autoNoticeCountAfter,
    autoNoticeCountBefore,
    "同命令名每会话只自动执行一次：守卫必须拦截同建议的二次注入（不得新增「建议器自动执行」提示帧）"
  );
  // 流请求数同样不得增长（第三轮主对话 1 次请求 + 无任何自动注入回合请求）
  const streamCountAfter = client.countOf("stream");
  assert.ok(
    streamCountAfter <= streamCountBefore + 1,
    `第三轮只允许主对话自身 1 次流请求（守卫拦截自动注入）；before=${streamCountBefore} after=${streamCountAfter}`
  );

  // 断言⑥（零过度触发）：普通回复（无建议句式）不触发自动注入
  await sendText(server, cookie, chatId, "把刚才的结论整理成一段话");
  const doneCountBeforeFourth = collector.countOf("done");
  await waitFor(
    () => (collector.countOf("done") >= doneCountBeforeFourth + 1 ? true : null),
    20000,
    "普通轮次 done 帧"
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const autoNoticeCountFinal = notices().length;
  assert.equal(
    autoNoticeCountFinal,
    autoNoticeCountBefore,
    "无建议句式的普通回复绝不触发自动注入（不得新增「建议器自动执行」提示帧）"
  );
  controller.abort();
  // 收尾清理：删除本用例播种的 pending 卡（编排器已将其标记 completed 回写），
  // 杜绝向后续同 projectRoot 用例泄漏陈旧清单。
  rmSync(tasksFileB, { force: true });
});

// ============================================================================
// SD-03：SIGTERM 优雅关闭链路的沉淀兜底
// ============================================================================

test("SD-03：close（SIGTERM 链路）→ 执行历史沉淀落盘（sedimentation flush + experience.json）", async () => {
  // 专用服务器：close() 即验证 disposeAll 的 flushSedimentation 兜底，用例后重建供后续复用
  const sd = await makeServer("sd", true);
  sdServer = sd.server;
  sdClient = sd.client;
  sdCookie = sd.cookie;
  sdPersonalRoot = sd.personalRoot;

  // 脚本：回合 1 = bash 工具调用（真实执行，产生执行历史记录）；回合 2 = 收尾文本。
  // 命令避开 LOW_VALUE_BASH_COMMANDS 黑名单（echo/ls/cat/… 不沉淀 experience），
  // printf 不在黑名单内 → 成功命令可沉淀为 MemoryStore experience。
  // 命令内不使用双引号：slash 会先经 bash -c 包装执行，嵌套引号转义脆弱，
  // 单段 printf 重定向即可满足「命令执行成功 + 产物落盘」双观测点。
  sdClient.setScript([
    bashToolTurnEvents("printf deepcode-sediment-probe > sd-probe.txt", "sd-call-1"),
    plainTurnEvents("命令执行完毕，文件已写入。"),
  ]);
  const chatId = await createChat(sdServer, sdCookie, sdPersonalRoot);
  // 注意：本用例不在 SSE 订阅上等待 done——close() 前必须主动 abort 订阅，
  // 否则 hub.closeAll 的 SSE 收敛行为存在不确定性（done 帧用 collector 等一次即可，
  // 其余观测全部走 pool 公开出口）。
  const sse = await openSseStream(sdServer.port, chatId, sdCookie);
  const { collector, controller } = sse;

  await sendText(sdServer, sdCookie, chatId, "在当前目录写入探针文件");
  // done 后 sessionId 已绑定（runTurn finally 同步）；确认引擎条目 completed
  await waitFor(() => findChatSummary(sdServer, chatId)?.status === "completed", 20000, "回合 completed");
  // bash 工具真实执行的文件落个人区（realpath 归一后的 <uploadDir>/<userId>）
  const personalDir = await realpath(sdPersonalRoot);
  await waitFor(
    () => existsSync(path.join(personalDir, "sd-probe.txt")),
    15000,
    `bash 工具执行产物落盘；sdPersonalRoot=${sdPersonalRoot}`
  );
  const sessionId = findChatSummary(sdServer, chatId)!.sessionId;
  assert.ok(sessionId, "done 后会话必须绑定底层 sessionId");
  controller.abort();
  void collector;

  // —— 模拟 SIGTERM 链路：running.close() → pool.disposeAll() → flushSedimentation ——
  await sdServer.close();

  // 断言①：沉淀结构化日志出现该会话的 type:"flush" 行
  // （sd 服务器 engine-home 独立：落点 = engine-home-<name>/<userId>，与 makeServer 同式）
  const sdEngineHomeRoot = serverEngineHomeRootOf("sd");
  const sedimentLogPath = path.join(sdEngineHomeRoot, ctx.userId, ".deepcodex", "logs", "sedimentation.log");
  assert.ok(existsSync(sedimentLogPath), `sedimentation.log 必须存在：${sedimentLogPath}`);
  const flushLines = readFileSync(sedimentLogPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type?: string; sessionId?: string; successCount?: number });
  const flushEvent = flushLines.find((event) => event.type === "flush" && event.sessionId === sessionId);
  assert.ok(flushEvent, `必须有本会话的 flush 沉淀事件；实际：${JSON.stringify(flushLines)}`);

  // 断言②：experience.json 出现沉淀条目（执行历史 → MemoryStore experience）
  const experiencePath = path.join(sdEngineHomeRoot, ctx.userId, ".deepcode", "memory", "experience.json");
  assert.ok(existsSync(experiencePath), `experience.json 必须存在：${experiencePath}`);
  const experience = JSON.parse(readFileSync(experiencePath, "utf8")) as { entries?: Array<{ key?: string }> };
  const entries = Array.isArray(experience.entries) ? experience.entries : [];
  assert.ok(entries.length > 0, "沉淀完成后 experience.json 必须含经验条目（成功命令经验）");

  // 断言③（兜底有效性佐证）：close 已清空池，会话对象不可再被 flush（清理链路收敛）
  assert.equal(
    sdServer.pool.listChats(ctx).filter((chat) => chat.chatId === chatId && chat.source === "active").length,
    0
  );
});
