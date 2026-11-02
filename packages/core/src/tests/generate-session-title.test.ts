/**
 * 会话标题自动生成——core 侧单测（docs/dev/web-chat-manage.md §3.1）。
 *
 * 覆盖：
 * - T1 parseGeneratedTitle：纯文本 / 引号书名号剥离 / 多行取首行 / 超长截断 / 空输出；
 * - T2 generateSessionTitle：注入脚本客户端 → 返回清洗后的标题 + 请求契约断言
 *   （system 提示词语义 / 用户消息携带首条消息与回复节选 / signal 透传 / 无工具定义）；
 * - T3 输出为空或纯空白 → 抛错（调用方降级保持原标题）；
 * - T4 客户端抛错原样透传；
 * - T5 未注入 classifyLlmClientFactory → 回退 createLLMClient（null → 明确抛错）。
 *
 * 测试纪律（用户硬性规则）：无 mock 框架——LLM 为脚本化真实类实现（实现
 * LLMClient 接口）；目录为 mkdtemp 真实磁盘。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseGeneratedTitle, SessionManager } from "../session";
import type { LLMClient, LLMRequest, LLMResponse, LLMStreamEvent } from "../providers/llm-provider";

// ============================================================================
// 测试基建
// ============================================================================

/** 本文件创建的临时目录（用例末尾统一清理） */
const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "title-gen-"));
  tempDirs.push(dir);
  return dir;
}

// 全局统一清理临时目录
test.after?.(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 脚本化非流式标题客户端（真实类实现，非 mock 框架）。
 *
 * content：createMessage 固定返回值；throwError：createMessage 抛错；
 * 记录最近一次请求供契约断言（提示词语义 / 内容 / signal 透传）。
 */
class ScriptedTitleClient implements LLMClient {
  readonly providerName = "openai" as const;
  readonly model = "title-gen-test";
  readonly baseURL = "https://title.test";
  readonly supportsThinking = false;
  readonly supportsPromptCaching = false;

  /** 已收到的请求日志（含 signal 引用，断言透传） */
  readonly requests: LLMRequest[] = [];

  constructor(
    private readonly content: string,
    private readonly throwError?: Error
  ) {}

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    if (this.throwError) {
      throw this.throwError;
    }
    return { content: this.content, thinking: "", toolCalls: [], stopReason: "stop", usage: null };
  }

  /** 标题路径不触达流式；调用即失败（保证测试只走 createMessage 契约） */
  createMessageStream(_request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    throw new Error("标题生成不应触达流式调用");
  }
}

/** 构造带脚本标题客户端的 SessionManager（会话数据落临时目录） */
function createManager(titleClient: LLMClient | null, homeDir: string): SessionManager {
  const projectRoot = createTempDir("title-project-");
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
    // 未注入 titleClient 时留空 factory → generateSessionTitle 回退 createLLMClient
    classifyLlmClientFactory: titleClient ? () => titleClient : undefined,
  });
}

// ============================================================================
// T1：parseGeneratedTitle（解析内核）
// ============================================================================

test("T1-01: parseGeneratedTitle 纯文本 / 引号书名号剥离 / 多行取首行", () => {
  assert.equal(parseGeneratedTitle("修复登录页白屏问题"), "修复登录页白屏问题", "纯文本原样返回");
  assert.equal(parseGeneratedTitle('"修复登录页白屏问题"'), "修复登录页白屏问题", "英文双引号应剥离");
  assert.equal(parseGeneratedTitle("「修复登录页白屏」"), "修复登录页白屏", "中文直角引号应剥离");
  assert.equal(parseGeneratedTitle("《修复登录页白屏》"), "修复登录页白屏", "书名号应剥离");
  assert.equal(parseGeneratedTitle("  修复登录页白屏\n附注：仅供参考  "), "修复登录页白屏", "多行输出应取首个非空行");
  assert.equal(parseGeneratedTitle("  修复登录页白屏  "), "修复登录页白屏", "首尾空白应清洗");
});

test("T1-02: parseGeneratedTitle 超长截断与空输出", () => {
  const long = "超".repeat(80);
  const parsed = parseGeneratedTitle(long);
  assert.ok(parsed !== null && parsed.length === 50, "超 50 字符必须硬截断到 50");
  assert.equal(parseGeneratedTitle(""), null, "空串非法");
  assert.equal(parseGeneratedTitle("   \n  \n"), null, "纯空白非法");
  assert.equal(parseGeneratedTitle('""'), null, "剥引号后为空非法");
});

// ============================================================================
// T2 ~ T5：generateSessionTitle
// ============================================================================

test("T2-01: 注入脚本客户端 → 返回清洗标题 + 请求契约断言", async () => {
  const titleClient = new ScriptedTitleClient('"修复登录页白屏问题"');
  const manager = createManager(titleClient, createTempDir("title-home-"));

  const title = await manager.generateSessionTitle(
    "登录页打开后一片空白，控制台报 undefined，帮我排查",
    "已定位为路由守卫异步时序问题，修复方案如下……",
    AbortSignal.timeout(5000)
  );
  assert.equal(title, "修复登录页白屏问题", "引号必须被清洗");

  // 请求契约：非流式单请求；system 为标题生成语义；用户消息携带首条消息与回复节选；无工具定义
  assert.equal(titleClient.requests.length, 1, "标题生成只发一次非流式请求");
  const request = titleClient.requests[0];
  assert.equal(request.messages[0].role, "system");
  assert.ok(request.messages[0].content?.includes("会话标题生成器"), "system 提示词必须是标题生成语义");
  assert.ok(request.messages[1].content?.includes("登录页打开后一片空白"), "用户消息必须携带首条消息原文");
  assert.ok(request.messages[1].content?.includes("路由守卫异步时序"), "用户消息必须携带助手回复节选");
  assert.equal(request.tools, undefined, "标题请求不得携带工具定义");
  assert.equal(request.thinkingEnabled, false);
  assert.ok(request.signal !== null, "调用方 signal 必须透传");
});

test("T3-01: 输出为空 / 纯空白 → 抛错（调用方降级保持原标题）", async () => {
  const empty = createManager(new ScriptedTitleClient(""), createTempDir("title-home-"));
  await assert.rejects(() => empty.generateSessionTitle("x", "y"), /输出为空/);

  const blank = createManager(new ScriptedTitleClient("   \n \n"), createTempDir("title-home-"));
  await assert.rejects(() => blank.generateSessionTitle("x", "y"), /输出为空/);
});

test("T4-01: 客户端抛错原样透传（不被吞）", async () => {
  const failure = new Error("title llm down");
  const manager = createManager(new ScriptedTitleClient("", failure), createTempDir("title-home-"));
  await assert.rejects(() => manager.generateSessionTitle("x", "y"), /title llm down/);
});

test("T5-01: 未注入分类工厂 → 回退 createLLMClient（null → 明确抛错）", async () => {
  const home = createTempDir("title-home-fallback-");
  const projectRoot = createTempDir("title-project-fallback-");
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
  await assert.rejects(() => manager.generateSessionTitle("x", "y"), /无可用 LLM 客户端/);
});
