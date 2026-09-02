/**
 * SessionManager 测试环境与共享 Helper 模块
 *
 * 本模块封装两类共享资源，供拆分后的 7 个 session-*.test.ts 文件复用：
 *
 * 1. 全局状态隔离（SessionTestEnv）
 *    原始 session.test.ts 通过模块级 afterEach hook 重置以下全局状态：
 *      - globalThis.fetch
 *      - console.warn
 *      - process.env.HOME
 *      - process.env.USERPROFILE
 *      - tempDirs[]（临时目录列表）
 *    拆分后每个测试文件独立调用 createSessionTestEnv() 创建独立 env 实例，
 *    避免跨文件污染（特别是 fetch / console.warn 等可变全局）。
 *
 * 2. 共享测试 Helper 函数
 *    包括 SessionManager 装配、Mocked LLM Client 构造、file-history 工具、
 *    通知记录脚本、断言工具等。所有函数保留完整 TypeScript 类型标注。
 *
 * 注意：本模块禁止引入 mock 框架，所有"桩"实现均为函数注入式真实组件装配。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitFileHistory } from "../../common/file-history";
import { getProjectCode, SessionManager, type SessionMessage } from "../../session";
import type { LLMClient, LLMRequest, LLMResponse } from "../../providers/llm-provider";

/** Plan Mode 开启时插入的会话状态消息（与 session.ts 保持一致） */
export const PLAN_MODE_ON_STATUS_MESSAGE = "  └ Set Plan Mode on. Awaiting <proposed_plan>.";
/** Plan Mode 关闭时插入的会话状态消息（与 session.ts 保持一致） */
export const PLAN_MODE_OFF_STATUS_MESSAGE = "  └ Set Plan Mode off.";

/**
 * SessionManager 测试环境接口
 *
 * 每个拆分后的测试文件持有独立的 SessionTestEnv 实例，用于隔离全局状态。
 */
export interface SessionTestEnv {
  /** 原始 fetch 函数（cleanup 时恢复） */
  originalFetch: typeof globalThis.fetch;
  /** 原始 console.warn 函数（cleanup 时恢复） */
  originalConsoleWarn: typeof console.warn;
  /** 原始 HOME 环境变量（cleanup 时恢复） */
  originalHome: string | undefined;
  /** 原始 USERPROFILE 环境变量（cleanup 时恢复） */
  originalUserProfile: string | undefined;
  /** 临时目录列表（cleanup 时递归删除） */
  tempDirs: string[];
  /** 设置 HOME 目录，跨平台兼容（Unix 改 HOME，Windows 同时改 USERPROFILE） */
  setHomeDir: (dir: string) => void;
  /** 跟踪临时目录，便于 cleanup 时统一清理 */
  trackTempDir: (dir: string) => string;
  /** 清理所有全局状态（afterEach 调用） */
  cleanup: () => void;
}

/**
 * 创建独立的 SessionManager 测试环境实例
 *
 * 每个测试文件应在顶部调用一次：
 *   const env = createSessionTestEnv();
 *   afterEach(() => env.cleanup());
 *
 * 这样确保各拆分文件之间全局状态互不污染。
 */
export function createSessionTestEnv(): SessionTestEnv {
  // 捕获原始全局状态（必须在测试修改之前快照）
  const originalFetch = globalThis.fetch;
  const originalConsoleWarn = console.warn;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  // 临时目录列表：测试运行中创建，afterEach 时统一删除
  const tempDirs: string[] = [];

  return {
    originalFetch,
    originalConsoleWarn,
    originalHome,
    originalUserProfile,
    tempDirs,
    /** 跨平台设置用户主目录（HOME / USERPROFILE） */
    setHomeDir: (dir: string): void => {
      process.env.HOME = dir;
      if (process.platform === "win32") {
        process.env.USERPROFILE = dir;
      }
    },
    /** 跟踪一个临时目录到 env，cleanup 时递归删除 */
    trackTempDir: (dir: string): string => {
      tempDirs.push(dir);
      return dir;
    },
    /** 恢复全局状态并清理所有临时目录 */
    cleanup: (): void => {
      globalThis.fetch = originalFetch;
      console.warn = originalConsoleWarn;
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
    },
  };
}

/**
 * 在系统临时目录下创建带前缀的临时目录，并注册到 env 以便 afterEach 自动清理
 *
 * @param env 当前测试文件的 SessionTestEnv 实例
 * @param prefix 临时目录名前缀（os.tmpdir() 下创建）
 * @returns 临时目录绝对路径
 */
export function createTempDir(env: SessionTestEnv, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  env.trackTempDir(dir);
  return dir;
}

/**
 * 检测系统是否安装 git 可执行文件（用于 file-history 相关测试跳过判定）
 */
export function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 file-history 仓库中创建一个 checkpoint 提交
 *
 * @param home 用户主目录（.deepcode/projects/<projectCode>/file-history/.git 所在）
 * @param workspace 项目工作区
 * @param sessionId 会话 ID（对应 file-history 分支名）
 * @param files 相对路径 -> 文件内容的映射
 * @returns 提交哈希（checkpointHash）
 */
export function createFileHistoryCommit(
  home: string,
  workspace: string,
  sessionId: string,
  files: Record<string, string>
): string {
  const projectCode = getProjectCode(workspace);
  const gitDir = path.join(home, ".deepcode", "projects", projectCode, "file-history", ".git");
  const fileHistory = new GitFileHistory(workspace, gitDir);
  fileHistory.ensureSession(sessionId);

  const filePaths: string[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(workspace, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    filePaths.push(filePath);
  }
  const commitHash = fileHistory.recordCheckpoint(sessionId, filePaths, "checkpoint");
  assert.ok(commitHash);
  return commitHash;
}

/** 获取 file-history 仓库的 .git 目录绝对路径 */
export function getFileHistoryGitDir(home: string, workspace: string): string {
  const projectCode = getProjectCode(workspace);
  return path.join(home, ".deepcode", "projects", projectCode, "file-history", ".git");
}

/** 读取指定 checkpoint 下的 file-history manifest 文件内容 */
export function readFileHistoryManifest(home: string, workspace: string, checkpointHash: string): any {
  const gitDir = getFileHistoryGitDir(home, workspace);
  return JSON.parse(
    runFileHistoryGit(gitDir, workspace, ["cat-file", "blob", `${checkpointHash}:.deepcode-file-history.json`])
  );
}

/**
 * 在指定 file-history 仓库中执行 git 命令
 *
 * @param gitDir .git 目录路径
 * @param workspace 工作区路径
 * @param args git 子命令参数
 * @param input 标准输入（可选）
 * @param env 环境变量（可选）
 * @returns git 命令的标准输出（utf8 解码）
 */
export function runFileHistoryGit(
  gitDir: string,
  workspace: string,
  args: string[],
  input = "",
  env: NodeJS.ProcessEnv = process.env
): string {
  return execFileSync(
    "git",
    ["-c", "core.autocrlf=false", "-c", "core.eol=lf", `--git-dir=${gitDir}`, `--work-tree=${workspace}`, ...args],
    {
      encoding: "utf8",
      input,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
}

/**
 * 构造一个最小化的 SessionManager 实例（client 为 null，仅用于不触发实际 LLM 调用的测试）
 *
 * @param projectRoot 项目根目录
 * @param machineId 机器 ID（用于 reporting token）
 */
export function createSessionManager(projectRoot: string, machineId: string): SessionManager {
  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      machineId,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

/** 统计已加载到会话消息中的指定 skill 数量（用于技能加载断言） */
export function countLoadedSkillMessages(messages: SessionMessage[], skillName: string): number {
  return messages.filter((message) => message.role === "system" && message.meta?.skill?.name === skillName).length;
}

/**
 * 构造一个具备 notify 脚本配置的 SessionManager（用于完成通知测试）
 *
 * @param projectRoot 项目根目录
 * @param responses 出队响应列表（Error 实例会被 throw 出去模拟失败）
 * @param notifyPath 通知脚本路径
 * @param notifyOutput 通知输出文件路径
 */
export function createNotifyingSessionManager(
  projectRoot: string,
  responses: unknown[],
  notifyPath: string,
  notifyOutput: string
): SessionManager {
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          // 技能匹配请求路径，返回空技能列表
          if (isSkillMatchingRequest(request)) {
            return createSkillMatchingResponse();
          }
          const response = responses.shift();
          assert.ok(response, "expected a queued chat response");
          if (response instanceof Error) {
            throw response;
          }
          return response;
        },
      },
    },
  };

  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      notify: notifyPath,
      env: {
        NOTIFY_OUTPUT: notifyOutput,
        STATUS: "stale-status",
        FAIL_REASON: "stale-failure",
        BODY: "stale-body",
        TITLE: "stale-title",
      },
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

/**
 * 将测试用 raw OpenAI client（chat.completions.create 形态）适配为 B1 LLMClient 接口
 *
 * 背景：合并上游 0.3.1 后，compact 非流式调用在 fork 中改经 createLLMClient
 * （provider 抽象层）发起；上游测试假定 compact 与主对话消费同一 raw client 队列。
 * 此适配器让未显式注入 createLLMClient 桩的测试自动获得与上游一致的语义：
 * compact 非流式调用与主对话流式调用共用同一响应队列。
 *
 * @param rawClient 测试用 raw OpenAI client（含 chat.completions.create）
 * @param model 模型名（默认 test-model）
 * @param baseURL API 端点（默认与主对话桩一致）
 */
export function createRawClientLLMClient(
  rawClient: unknown,
  model = "test-model",
  baseURL = "https://api.deepseek.com"
): LLMClient {
  return {
    providerName: "openai",
    model,
    baseURL,
    supportsThinking: false,
    supportsPromptCaching: false,
    /**
     * 非流式调用：把统一 LLMRequest（SessionMessage 形态）降级为 OpenAI
     * chat.completions.create 所需的最小消息形态（role + content），透传 temperature；
     * 响应映射回统一 LLMResponse（usage 按 prompt/completion tokens 对齐）。
     */
    createMessage: async (request: LLMRequest): Promise<LLMResponse> => {
      const response = (await (rawClient as any).chat.completions.create({
        model,
        messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      })) as any;
      const choice = response?.choices?.[0]?.message;
      const usage = response?.usage ?? null;
      return {
        content: typeof choice?.content === "string" ? choice.content : "",
        thinking: "",
        toolCalls: [],
        stopReason: "stop",
        // OpenAI usage（prompt_tokens/completion_tokens）→ 统一 LLMUsage（inputTokens/outputTokens）
        usage:
          usage != null
            ? {
                inputTokens: Number(usage.prompt_tokens ?? 0),
                outputTokens: Number(usage.completion_tokens ?? 0),
              }
            : null,
      };
    },
    // 非流式测试场景不消费流式接口，返回空事件流即可（接口完整性要求实现）
    createMessageStream: async function* () {},
  };
}

/**
 * 构造一个 Mocked OpenAI Client 的 SessionManager（用于主对话流式通路测试）
 *
 * @param projectRoot 项目根目录
 * @param responses OpenAI 队列响应列表
 * @param options 第三参数兼容两种形态（合并上游 0.3.1 后的兼容处理）：
 *   - 函数：B1 compact 非流式调用的 LLMClient 工厂（fork 语义，null 表示无凭据静默跳过）
 *   - 数字：autoCompactWindow 阈值（上游 0.3.1 测试语义，如 500）
 *   未注入函数时自动把 raw client 适配为 LLMClient，使 compact 消费同一响应队列（对齐上游）。
 */
export function createMockedClientSessionManager(
  projectRoot: string,
  responses: unknown[],
  options?: (() => LLMClient | null) | number
): SessionManager {
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          // 技能匹配请求路径，返回空技能列表
          if (isSkillMatchingRequest(request)) {
            return createSkillMatchingResponse();
          }
          const response = responses.shift();
          assert.ok(response, "expected a queued chat response");
          return response;
        },
      },
    },
  };

  // 第三参数按类型分流：函数 → createLLMClient 桩；数字 → autoCompactWindow 阈值
  const createLLMClient = typeof options === "function" ? options : undefined;
  const autoCompactWindow = typeof options === "number" ? options : undefined;

  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    // B1：compact 非流式调用走 createLLMClient（provider 路由缝合点）；
    // 未显式注入时回退为 raw client 适配器（compact 与主对话共用队列，对齐上游语义）
    createLLMClient: createLLMClient ?? (() => createRawClientLLMClient(client)),
    getResolvedSettings: () => ({
      model: "test-model",
      ...(autoCompactWindow !== undefined ? { autoCompactWindow } : {}),
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

/**
 * 构造 B1 测试用 LLMClient 桩（函数注入，非 mock 框架）：
 * createMessage 依次出队返回预置 LLMResponse，并记录全部入参供断言。
 *
 * @param responses 预置 LLMResponse 队列
 * @param recorded 入参记录数组（测试断言用）
 * @param model 模型名（默认 test-model）
 */
export function createStubLLMClient(responses: LLMResponse[], recorded: LLMRequest[], model = "test-model"): LLMClient {
  return {
    providerName: "openai",
    model,
    baseURL: "https://api.deepseek.com",
    supportsThinking: true,
    supportsPromptCaching: false,
    createMessage: async (request: LLMRequest): Promise<LLMResponse> => {
      recorded.push(request);
      const response = responses.shift();
      assert.ok(response, "expected a queued LLM response");
      return response;
    },
    // 非流式测试场景不消费流式接口，返回空事件流即可（接口完整性要求实现）
    createMessageStream: async function* () {},
  };
}

/** 构造文本型 LLMResponse（B1 测试数据） */
export function createLLMTextResponse(
  content: string,
  usage?: { inputTokens: number; outputTokens: number }
): LLMResponse {
  return {
    content,
    thinking: "",
    toolCalls: [],
    stopReason: "stop",
    usage: usage ?? null,
  };
}

/**
 * 构造一个配置了 permissions 的 SessionManager（用于权限测试）
 *
 * @param projectRoot 项目根目录
 * @param responses OpenAI 队列响应列表
 * @param permissions 权限配置（allow/deny/ask/defaultMode）
 */
export function createPermissionSessionManager(
  projectRoot: string,
  responses: unknown[],
  permissions: {
    allow: any[];
    deny: any[];
    ask: any[];
    defaultMode: "allowAll" | "askAll";
  }
): SessionManager {
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          if (isSkillMatchingRequest(request)) {
            return createSkillMatchingResponse();
          }
          const response = responses.shift();
          assert.ok(response, "expected a queued chat response");
          return response;
        },
      },
    },
  };

  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model", permissions }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

/**
 * 构造一个使用外部传入 client 的 SessionManager（用于需要自定义 client 行为的测试）
 *
 * 合并上游 0.3.1 后，compact 非流式调用在 fork 中经 createLLMClient（provider 抽象层）
 * 发起；此处自动把外部 raw client 适配为 LLMClient，保持上游语义
 * （compact 与主对话/技能匹配消费同一 client 队列）。
 */
export function createMockedClientSessionManagerWithClient(projectRoot: string, client: unknown): SessionManager {
  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    // B1 缝合点：raw client 自动适配为 LLMClient，compact 调用与主对话共用同一队列
    createLLMClient: () => createRawClientLLMClient(client),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

/**
 * 自定义 AbortError 类，用于模拟 OpenAI SDK 的 APIUserAbortError
 * （避免引入实际 SDK 依赖，仅模仿其类型）
 */
export class APIUserAbortError extends Error {}

/** 判断 OpenAI 请求是否为技能匹配请求（response_format 为 json_object） */
export function isSkillMatchingRequest(request: any): boolean {
  return request?.response_format?.type === "json_object";
}

/** 构造技能匹配 LLM 响应（返回指定技能名列表） */
export function createSkillMatchingResponse(skillNames: string[] = []): unknown {
  return { choices: [{ message: { content: JSON.stringify({ skillNames }) } }] };
}

/** 构造一个 OpenAI Chat Completion 响应（含 usage） */
export function createChatResponse(content: string, usage: Record<string, unknown>): unknown {
  return {
    choices: [{ message: { content } }],
    usage,
  };
}

/** 构造一个带 tool_calls 的 OpenAI Chat Completion 响应 */
export function createToolCallResponse(toolCalls: unknown[], usage: Record<string, unknown>): unknown {
  return {
    choices: [{ message: { content: "", tool_calls: toolCalls } }],
    usage,
  };
}

/**
 * 构造一个最小化的 SessionMessage（用于 buildOpenAIMessages 等纯消息构造测试）
 */
export function buildTestMessage(
  id: string,
  sessionId: string,
  role: SessionMessage["role"],
  content: string
): SessionMessage {
  return {
    id,
    sessionId,
    role,
    content,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: "2026-01-01T00:00:00.000Z",
    updateTime: "2026-01-01T00:00:00.000Z",
  };
}

/** 构造一个 OpenAI Chat Completion 流式响应（按 chunks 顺序 yield） */
export async function* createChatStreamResponse(
  chunks: Record<string, unknown>[]
): AsyncGenerator<Record<string, unknown>> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/**
 * Helper: 创建一个会话并写入若干消息，用于测试 deleteSession 是否同时删除索引项与消息文件
 */
export function createSessionAndMessages(manager: SessionManager, sessionId: string, summary: string): string {
  const now = new Date().toISOString();
  const index = (manager as any).loadSessionsIndex();
  index.entries.push({
    id: sessionId,
    summary,
    assistantReply: null,
    assistantThinking: null,
    assistantRefusal: null,
    toolCalls: null,
    status: "completed",
    failReason: null,
    usage: null,
    usagePerModel: null,
    activeTokens: 0,
    createTime: now,
    updateTime: now,
    processes: null,
  });
  (manager as any).saveSessionsIndex(index);

  // 写入若干消息到消息文件，验证 deleteSession 会删除该文件
  const projectDir = (manager as any).getProjectStorage().projectDir;
  const messagePath = path.join(projectDir, `${sessionId}.jsonl`);
  const msg = JSON.stringify({
    id: "msg-1",
    sessionId,
    role: "user",
    content: summary,
    visible: true,
    createTime: now,
    updateTime: now,
  });
  fs.writeFileSync(messagePath, `${msg}\n`, "utf8");

  return sessionId;
}

/**
 * 创建一个 notify 录制脚本（Node.js 脚本），将环境变量持久化到 NOTIFY_OUTPUT 文件
 *
 * @param dir 脚本存放目录
 * @returns 脚本绝对路径
 */
export function createNotifyRecorderScript(dir: string): string {
  const scriptPath = path.join(dir, "notify-recorder.cjs");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("fs");
const keys = ["DURATION", "STATUS", "FAIL_REASON", "BODY", "TITLE"];
const record = {};
for (const key of keys) {
  record[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null;
}
fs.appendFileSync(process.env.NOTIFY_OUTPUT, JSON.stringify(record) + "\\n", "utf8");
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/**
 * 等待 notify 输出文件中达到 expectedCount 条记录
 *
 * @param outputPath 输出文件路径
 * @param expectedCount 期望记录数
 * @returns 解析后的记录数组
 */
export async function waitForNotifyRecords(
  outputPath: string,
  expectedCount: number
): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(outputPath)) {
      const records = fs
        .readFileSync(outputPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      if (records.length >= expectedCount) {
        return records;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`expected ${expectedCount} notify records in ${outputPath}`);
}

/**
 * 等待 MCP 服务器状态变为 expectedStatus（轮询 100 次 × 20ms）
 */
export async function waitForMcpStatus(manager: SessionManager, expectedStatus: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.getMcpStatus()[0]?.status === expectedStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`expected MCP status ${expectedStatus}`);
}

/** 转义字符串中的正则元字符，用于构造安全正则表达式 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 刷新微任务队列，用于等待异步上报完成 */
export async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
