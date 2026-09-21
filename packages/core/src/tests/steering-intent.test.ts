/**
 * 任务执行中补充指令——core 侧单测（docs/dev/web-steering.md §4.1 CT1 ~ CT5）。
 *
 * 覆盖：
 * - CT1 classifySteeringIntent：注入脚本分类客户端 → 正确解析 steer/next；
 * - CT2 非法输出（非 JSON / 缺字段 / 非法 intent / 空 content）→ 抛错；
 * - CT3 signal 透传（LLMRequest.signal 收到调用方信号）与客户端抛错透传；
 * - CT4 未注入 classifyLlmClientFactory → 回退 createLLMClient 链
 *       （凭据缺失 → 明确抛「无可用 LLM 客户端」）；
 * - CT5 E2 注入消息 meta.steeringInject 标记（InterruptQueue 注入 →
 *       轮次内合成 system 消息 → onAssistantMessage 载荷与落盘 JSONL 均含标记）。
 *
 * 测试纪律（用户硬性规则）：无 mock 框架——LLM 为脚本化真实类实现（实现
 * LLMClient 接口）；目录为 mkdtemp 真实磁盘。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSteeringIntentJson, SessionManager, getProjectCode } from "../session";
import { InterruptQueue } from "../interrupts/index";
import type { LLMClient, LLMRequest, LLMResponse, LLMStreamEvent } from "../providers/llm-provider";
// OpenAI SDK 客户端桩类型（CT5 需要非 null 的 client 绕过凭据早退检查）
import type OpenAI from "openai";

// ============================================================================
// 测试基建
// ============================================================================

/** 本文件创建的临时目录（用例末尾统一清理） */
const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * 脚本化非流式分类客户端（真实类实现，非 mock 框架）。
 *
 * response：createMessage 固定返回值；throwError：createMessage 抛错（CT3）；
 * 记录最近一次请求供断言（system 提示词 / signal 透传 / 消息内容）。
 */
class ScriptedClassifierClient implements LLMClient {
  readonly providerName = "openai" as const;
  readonly model = "classifier-test";
  readonly baseURL = "https://classifier.test";
  readonly supportsThinking = false;
  readonly supportsPromptCaching = false;

  /** 已收到的请求日志（含 signal 引用，断言透传） */
  readonly requests: LLMRequest[] = [];

  constructor(
    private readonly response?: Partial<LLMResponse>,
    private readonly throwError?: Error
  ) {}

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    if (this.throwError) {
      throw this.throwError;
    }
    return {
      content: this.response?.content ?? "",
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: null,
    };
  }

  /** 分类路径不触达流式；调用即失败（保证测试只走 createMessage 契约） */
  createMessageStream(_request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    throw new Error("steering 分类不应触达流式调用");
  }
}

/**
 * 脚本化流式客户端（真实类实现，非 mock 框架）。
 *
 * 主对话流：脚本由调用方函数按 request.messages 内容动态产出
 * （注入 system 消息进入上下文后停止，保证轮次确定性收敛）；
 * 分类路径：response content 为固定 JSON。
 */
class ScriptedTurnClient implements LLMClient {
  readonly providerName = "anthropic" as const;
  readonly model = "turn-test";
  readonly baseURL = "https://turn.test";
  readonly supportsThinking = false;
  readonly supportsPromptCaching = false;

  constructor(
    private readonly script: (request: LLMRequest) => LLMStreamEvent[],
    private readonly classifierContent = ""
  ) {}

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    return { content: this.classifierContent, thinking: "", toolCalls: [], stopReason: "stop", usage: null };
  }

  async *createMessageStream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    for (const event of this.script(request)) {
      yield event;
    }
  }
}

/** 构造带脚本分类客户端的 SessionManager（会话数据落临时目录） */
function createManager(classifier: LLMClient | null, homeDir: string): SessionManager {
  const projectRoot = createTempDir("steering-project-");
  return new SessionManager({
    projectRoot,
    homeDir,
    createOpenAIClient: () => ({
      client: null,
      model: "test",
      baseURL: "https://api.test.com",
      thinkingEnabled: false,
      reasoningEffort: undefined,
      debugLogEnabled: false,
      env: {},
    }),
    getResolvedSettings: () => ({ model: "test" }),
    renderMarkdown: (text: string) => text,
    onAssistantMessage: () => {},
    // 未注入 classifier 时留空 factory → classifySteeringIntent 回退 createLLMClient
    classifyLlmClientFactory: classifier ? () => classifier : undefined,
  });
}

// ============================================================================
// parseSteeringIntentJson：契约解析函数（classifySteeringIntent 的解析内核）
// ============================================================================

test("CT-parse-01: parseSteeringIntentJson 合法输出与 markdown 代码壳均可解析", () => {
  assert.deepEqual(parseSteeringIntentJson('{"intent":"steer","reason":"修正当前任务"}'), {
    intent: "steer",
    reason: "修正当前任务",
  });
  assert.deepEqual(
    parseSteeringIntentJson('```json\n{"intent":"next","reason":"独立新任务"}\n```'),
    { intent: "next", reason: "独立新任务" },
    "markdown 围栏壳应被剥除后解析"
  );
  assert.deepEqual(
    parseSteeringIntentJson('  {"intent":"next","reason":"r"}  '),
    { intent: "next", reason: "r" },
    "首尾空白应被容忍"
  );
});

test("CT-parse-02: parseSteeringIntentJson 非法输入一律返回 null", () => {
  assert.equal(parseSteeringIntentJson(""), null, "空串非法");
  assert.equal(parseSteeringIntentJson("not json"), null, "非 JSON 非法");
  assert.equal(parseSteeringIntentJson('{"intent":"other","reason":"r"}'), null, "intent 枚举外非法");
  assert.equal(parseSteeringIntentJson('{"intent":"steer"}'), null, "缺 reason 非法");
  assert.equal(parseSteeringIntentJson('{"reason":"r"}'), null, "缺 intent 非法");
  assert.equal(parseSteeringIntentJson('{"intent":"steer","reason":42}'), null, "reason 非字符串非法");
  assert.equal(parseSteeringIntentJson("[1,2]"), null, "数组非法");
  assert.equal(parseSteeringIntentJson("null"), null, "null 非法");
});

// ============================================================================
// CT1 / CT2 / CT3 / CT4：classifySteeringIntent
// ============================================================================

test("CT1-01: 注入脚本分类客户端输出 steer → resolve {intent:steer,reason}", async () => {
  const classifier = new ScriptedClassifierClient({ content: '{"intent":"steer","reason":"补充要求"}' });
  const manager = createManager(classifier, createTempDir("steering-home-"));

  const result = await manager.classifySteeringIntent("记得加上错误处理", "用户：写一个爬虫\n助手：正在创建 spider.py");
  assert.equal(result.intent, "steer");
  assert.equal(result.reason, "补充要求");

  // 请求契约：非流式单请求；含分类系统提示词与补充指令原文；无工具定义
  assert.equal(classifier.requests.length, 1, "分类只发一次非流式请求");
  const request = classifier.requests[0];
  assert.equal(request.messages[0].role, "system");
  assert.ok(request.messages[0].content?.includes("意图分类器"), "system 提示词必须是分类器语义");
  assert.ok(request.messages[1].content?.includes("记得加上错误处理"), "用户消息必须携带补充指令原文");
  assert.equal(request.tools, undefined, "分类请求不得携带工具定义");
  assert.equal(request.thinkingEnabled, false);
});

test("CT1-02: 分类客户端输出 next → resolve {intent:next}", async () => {
  const classifier = new ScriptedClassifierClient({ content: '```json\n{"intent":"next","reason":"无关任务"}\n```' });
  const manager = createManager(classifier, createTempDir("steering-home-"));

  const result = await manager.classifySteeringIntent("顺便帮我查一下天气", "当前任务：重构登录模块");
  assert.equal(result.intent, "next");
  assert.equal(result.reason, "无关任务");
});

test("CT2-01: 非法 JSON / 非法 intent 输出 → 抛错（调用方降级排队）", async () => {
  const badJson = createManager(
    new ScriptedClassifierClient({ content: "我觉得是 steer" }),
    createTempDir("steering-home-")
  );
  await assert.rejects(() => badJson.classifySteeringIntent("x", "ctx"), /非法/);

  const badIntent = createManager(
    new ScriptedClassifierClient({ content: '{"intent":"now","reason":"r"}' }),
    createTempDir("steering-home-")
  );
  await assert.rejects(() => badIntent.classifySteeringIntent("x", "ctx"), /非法/);
});

test("CT2-02: 分类客户端返回空 content（空壳语义）→ 解析失败抛错", async () => {
  // 与 web 测试 ScriptedLLMClient.createMessage 空壳返回同语义：content=""
  const empty = createManager(new ScriptedClassifierClient(), createTempDir("steering-home-"));
  await assert.rejects(() => empty.classifySteeringIntent("x", "ctx"), /非法/);
});

test("CT3-01: signal 透传至 LLMRequest.signal；客户端抛错原样透传", async () => {
  const classifier = new ScriptedClassifierClient({ content: '{"intent":"steer","reason":"r"}' });
  const manager = createManager(classifier, createTempDir("steering-home-"));
  const controller = new AbortController();
  await manager.classifySteeringIntent("x", "ctx", controller.signal);
  assert.equal(classifier.requests[0].signal, controller.signal, "调用方 signal 必须透传到分类请求");
});

test("CT3-02: 分类客户端网络抛错 → 原样透传（不被吞）", async () => {
  const failure = new Error("network down");
  const classifier = new ScriptedClassifierClient(undefined, failure);
  const manager = createManager(classifier, createTempDir("steering-home-"));
  await assert.rejects(() => manager.classifySteeringIntent("x", "ctx"), /network down/);
});

test("CT4-01: 未注入分类工厂 → 回退 createLLMClient（凭据缺失明确抛错）", async () => {
  // createLLMClient override 返回 null（同凭据缺失语义）：工厂回退链命中 null 分支
  const home = createTempDir("steering-home-empty-");
  const projectRoot = createTempDir("steering-project-empty-");
  const manager = new SessionManager({
    projectRoot,
    homeDir: home,
    createOpenAIClient: () => ({
      client: null,
      model: "test",
      baseURL: "https://api.test.com",
      thinkingEnabled: false,
      reasoningEffort: undefined,
      debugLogEnabled: false,
      env: {},
    }),
    // B1 工厂置空 = 无凭据环境的确定性表达（避免测试依赖本机用户级凭据）
    createLLMClient: () => null,
    getResolvedSettings: () => ({ model: "test" }),
    renderMarkdown: (text: string) => text,
    onAssistantMessage: () => {},
  });
  await assert.rejects(() => manager.classifySteeringIntent("x", "ctx"), /无可用 LLM 客户端/);
});

// ============================================================================
// CT5：E2 注入消息 meta.steeringInject 标记（InterruptQueue 全链路）
// ============================================================================

test("CT5-01: 注入指令被轮内消费 → 合成 system 消息带 steeringInject（回调与落盘 JSONL 双断言）", async () => {
  const homeDir = createTempDir("steering-home-ct5-");
  const projectRoot = createTempDir("steering-project-ct5-");
  const queue = new InterruptQueue();

  // 记录注入消费的 system 消息（E2 经 onAssistantMessage 通知 UI）
  const injectedMessages: Array<{ role: string; content: string | null; meta?: { steeringInject?: boolean } }> = [];

  // 主对话脚本：上下文已含注入 system 消息（E2 已消费）→ 纯文本收尾；
  // 首轮（注入尚未进入上下文）：只回文本 + end_turn——核心主循环在
  // stop=end_turn 时会再次进入迭代头部，此时 drain 注入并合成 system 消息，
  // 第二次请求带注入 → 断言的 steeringInject 通知与 JSONL 落盘均发生，
  // 随后 end_turn 且无 tool_calls → 轮次确定性收敛为 completed。
  const turnClient = new ScriptedTurnClient((request: LLMRequest): LLMStreamEvent[] => {
    const hasInject = request.messages.some(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("改用 pnpm 安装依赖")
    );
    if (!hasInject) {
      // 首轮（注入尚未进入上下文——E2 尚未执行）：回文本收尾，轮次继续
      return [
        { type: "text_delta", text: "开始处理" },
        { type: "message_end", stopReason: "end_turn", usage: null },
      ];
    }
    // 注入已进入上下文（E2 已消费）：回文本收尾，轮次收敛
    return [
      { type: "text_delta", text: "已收到追加指令，改用 pnpm" },
      { type: "message_end", stopReason: "end_turn", usage: null },
    ];
  });

  // OpenAI SDK 客户端哑对象：activateSession 的 `!client` 凭据检查在 E2 之前，
  // client=null 会「API key not found」早退而永远走不到注入消费路径。
  // provider 判定走 createLLMClient（anthropic），主对话不会触碰此桩的任何方法。
  const dumbOpenAi = {
    chat: { completions: { create: async () => ({}) } },
  } as unknown as OpenAI;

  const manager = new SessionManager({
    projectRoot,
    homeDir,
    interruptQueue: queue,
    createOpenAIClient: () => ({
      client: dumbOpenAi,
      apiKey: "test-key",
      model: "test",
      baseURL: "https://api.test.com",
      thinkingEnabled: false,
      reasoningEffort: undefined,
      debugLogEnabled: false,
      env: {},
    }),
    // B1 缝合点注入脚本客户端（provider=anthropic → 主对话走流式脚本）
    createLLMClient: () => turnClient,
    getResolvedSettings: () => ({ model: "test" }),
    renderMarkdown: (text: string) => text,
    onAssistantMessage: (message) => {
      injectedMessages.push({ role: message.role, content: message.content, meta: message.meta });
    },
  });

  // 注入一条指令（injectInstruction 与轮次无关，纯内存入队）
  manager.injectInstruction("改用 pnpm 安装依赖");
  assert.equal(queue.size, 1, "注入即入队");

  // 发起一轮对话：首迭代头部 E2 drain 注入 → 合成 system 消息 → 脚本收尾
  await manager.handleUserPrompt({ text: "帮我搭一个项目" }).catch(() => undefined);

  // 注入消息已被 E2 消费：onAssistantMessage 载荷 role=system + meta.steeringInject
  const injectMsg = injectedMessages.find((m) => m.meta?.steeringInject === true);
  assert.ok(injectMsg, "E2 注入消息必须带 meta.steeringInject 标记并经 onAssistantMessage 通知");
  assert.equal(injectMsg.role, "system");
  assert.ok(injectMsg.content?.includes("改用 pnpm 安装依赖"), "注入消息必须包含指令原文");
  // W2：meta.steeringText 携带注入原文（多条指令以空行合并，本用例单条即原文）
  assert.equal(injectMsg.meta?.steeringText, "改用 pnpm 安装依赖", "注入消息 meta 必须携带用户原文 steeringText");

  // 落盘 JSONL 同样持久化 meta 标记（历史恢复路径可用）
  // 注：SessionManager 内部用未经 realpath 的 projectRoot 原样计算 projectCode
  // （this.projectRoot = options.projectRoot），测试侧同法直接传原路径。
  const projectCode = getProjectCode(projectRoot);
  const projectsDir = path.join(homeDir, ".deepcode", "projects", projectCode);
  assert.ok(fs.existsSync(projectsDir), "会话目录必须落注入的 homeDir");
  const jsonlFiles = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".jsonl"));
  const persisted = jsonlFiles.flatMap((f) =>
    fs
      .readFileSync(path.join(projectsDir, f), "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { role: string; content: string | null; meta?: { steeringInject?: boolean } })
  );
  const persistedInject = persisted.find((m) => m.meta?.steeringInject === true);
  assert.ok(persistedInject, "注入消息的 meta.steeringInject 必须持久化到 JSONL");
  assert.equal(persistedInject.role, "system");

  // 队列已清空（drain 不重放）
  assert.equal(queue.size, 0, "注入消费后队列必须清空");
});
