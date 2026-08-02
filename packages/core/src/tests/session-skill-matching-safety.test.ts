/**
 * SessionManager skill matching 安全机制单元测试
 *
 * 覆盖范围：
 * - identifyMatchingSkillNames 对 reasoning 模型（Qwen3 / DeepSeek-R1）显式禁用 thinking
 * - identifyMatchingSkillNames 限制 max_tokens=1024，避免短分类任务产生过长输出
 * - createChatCompletionStream 的 reasoning 内容长度保护：超过阈值时主动中断并抛错
 * - createChatCompletionStream 的流式超时保护：超过 streamTimeoutMs 时主动中断
 * - identifyMatchingSkillNames 在中断/异常时安全降级为空数组
 *
 * 测试基建：真实函数注入桩（OpenAI client 对象 + 异步生成器），无 mock 框架；
 * 文件被 src/tests/run-tests.mjs 以 glob `*.test.ts` 自动发现，纳入 npm test。
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionManager, type SkillInfo } from "../session";

// ============================================================================
// 测试辅助
// ============================================================================

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

/** 跨平台设置 home 目录（Unix: HOME，Windows: USERPROFILE） */
function setHomeDir(dir: string): void {
  process.env.HOME = dir;
  if (process.platform === "win32") {
    process.env.USERPROFILE = dir;
  }
}

afterEach(() => {
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

/** 构造固定 skill 列表 */
function createSampleSkills(): SkillInfo[] {
  return [
    {
      name: "understand-explain",
      path: "bundled:understand-explain/SKILL.md",
      description: "解释项目结构与功能",
    },
    {
      name: "TRAE-code-review",
      path: "bundled:TRAE-code-review/SKILL.md",
      description: "代码审查与问题发现",
    },
    {
      name: "html-report",
      path: "bundled:html-report/SKILL.md",
      description: "生成 HTML 报告",
    },
  ];
}

/**
 * 构造记录请求体并返回流式响应的 OpenAI client 桩
 *
 * @param chunks 流式 chunk 数组
 * @returns client 桩与请求记录
 */
function createRecordingClient(chunks: ReadonlyArray<Record<string, unknown>>): {
  client: unknown;
  requests: Record<string, unknown>[];
} {
  const requests: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          requests.push(request);
          return createChatStreamResponse(chunks);
        },
      },
    },
  };
  return { client, requests };
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
 * 构造返回超长 reasoning 流的 OpenAI client 桩
 *
 * 模拟 Qwen3 等 reasoning 模型在 skill matching 阶段陷入循环，
 * 持续输出 reasoning_content 但无 content。
 */
function createLoopingReasoningClient(
  reasoningChunk: string,
  chunkCount: number
): {
  client: unknown;
  reasoningCallCount: { value: number };
} {
  const reasoningCallCount = { value: 0 };
  const client = {
    chat: {
      completions: {
        create: async (_request: Record<string, unknown>) => {
          reasoningCallCount.value++;
          return (async function* () {
            for (let i = 0; i < chunkCount; i++) {
              yield {
                choices: [
                  {
                    delta: {
                      reasoning_content: reasoningChunk,
                    },
                  },
                ],
              };
            }
          })();
        },
      },
    },
  };
  return { client, reasoningCallCount };
}

/**
 * 构造返回慢速无限流的 OpenAI client 桩
 *
 * 每 delayMs 输出一个 reasoning chunk，模拟流式超时场景。
 * 生成器会监听 options.signal，abort 时立即退出，避免测试卡住。
 */
function createSlowStreamClient(reasoningChunk: string, delayMs: number): { client: unknown } {
  const client = {
    chat: {
      completions: {
        create: async (_request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          const signal = options?.signal;
          return (async function* () {
            while (true) {
              if (signal?.aborted) {
                return;
              }
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, delayMs);
                signal?.addEventListener(
                  "abort",
                  () => {
                    clearTimeout(timer);
                    reject(new Error("aborted"));
                  },
                  { once: true }
                );
              });
              yield {
                choices: [
                  {
                    delta: {
                      reasoning_content: reasoningChunk,
                    },
                  },
                ],
              };
            }
          })();
        },
      },
    },
  };
  return { client };
}

/**
 * 构造 SessionManager 测试实例
 *
 * @param client OpenAI client 桩
 * @param model 模型名称
 * @param baseURL API 地址
 */
function createSessionManager(client: unknown, model: string, baseURL: string): SessionManager {
  return new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: client as any,
      model,
      baseURL,
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

// ============================================================================
// 测试用例
// ============================================================================

test("identifyMatchingSkillNames 对 Qwen3 模型显式禁用 thinking", async () => {
  const home = createTempDir("deepcode-skill-qwen3-home-");
  setHomeDir(home);

  const { client, requests } = createRecordingClient([
    { choices: [{ delta: { content: '{"skillNames": ["understand-explain"]}' } }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]);

  const manager = createSessionManager(client, "Qwen/Qwen3.6-35B-A3B-4bit", "http://127.0.0.1:8000/v1");
  const skills = createSampleSkills();

  const result = await (manager as any).identifyMatchingSkillNames(skills, "阅读全部代码并输出功能研究说明文档");

  assert.deepEqual(result, ["understand-explain"]);
  assert.equal(requests.length, 1, "应只发起一次 skill matching 请求");
  const request = requests[0];
  assert.equal(request.max_tokens, 1024, "skill matching 应限制 max_tokens=1024");
  assert.deepEqual(
    (request as Record<string, unknown>).chat_template_kwargs,
    { enable_thinking: false },
    "Qwen3 模型应显式禁用 thinking"
  );
  assert.ok(!("thinking" in request), "Qwen3 请求不应包含 thinking 字段");
});

test("identifyMatchingSkillNames 对 DeepSeek 模型显式禁用 thinking", async () => {
  const home = createTempDir("deepcode-skill-deepseek-home-");
  setHomeDir(home);

  const { client, requests } = createRecordingClient([
    { choices: [{ delta: { content: '{"skillNames": ["TRAE-code-review"]}' } }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]);

  const manager = createSessionManager(client, "deepseek-v4-pro", "https://api.deepseek.com");
  const skills = createSampleSkills();

  const result = await (manager as any).identifyMatchingSkillNames(skills, "review 当前项目代码");

  assert.deepEqual(result, ["TRAE-code-review"]);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.max_tokens, 1024);
  assert.deepEqual(
    (request as Record<string, unknown>).thinking,
    { type: "disabled" },
    "DeepSeek 模型应显式禁用 thinking"
  );
  assert.ok(!("chat_template_kwargs" in request), "DeepSeek 请求不应包含 chat_template_kwargs 字段");
});

test("createChatCompletionStream 在 reasoning 超长时主动中断并抛错", async () => {
  const home = createTempDir("deepcode-skill-reasoning-limit-home-");
  setHomeDir(home);

  // 每个 chunk 100 字符，共 100 个 chunk，总计 10000 字符，超过阈值 4096
  const chunk = "a".repeat(100);
  const { client, reasoningCallCount } = createLoopingReasoningClient(chunk, 100);

  const manager = createSessionManager(client, "Qwen/Qwen3.6-35B-A3B-4bit", "http://127.0.0.1:8000/v1");

  await assert.rejects(async () => {
    await (manager as any).createChatCompletionStream(
      client,
      { model: "Qwen/Qwen3.6-35B-A3B-4bit", messages: [] },
      { maxReasoningLength: 4096, streamTimeoutMs: 30000 }
    );
  }, /reasoning content exceeded safety limit/);

  // 不应等待全部 100 个 chunk 消费完，应在 41-42 个 chunk 左右中断
  assert.ok(reasoningCallCount.value === 1, "client.chat.completions.create 只应被调用一次");
});

test("createChatCompletionStream 在流式超时时主动中断", async () => {
  const home = createTempDir("deepcode-skill-timeout-home-");
  setHomeDir(home);

  const { client } = createSlowStreamClient("x", 50);
  const manager = createSessionManager(client, "test-model", "http://localhost:8000/v1");

  const startMs = Date.now();
  await assert.rejects(async () => {
    await (manager as any).createChatCompletionStream(
      client,
      { model: "test-model", messages: [] },
      { streamTimeoutMs: 200 }
    );
  }, /aborted|timeout/i);
  const elapsedMs = Date.now() - startMs;

  // 应在 200ms 左右被中断，容差 300ms
  assert.ok(elapsedMs < 500, `流式超时应尽快中断，实际耗时 ${elapsedMs}ms`);
});

test("identifyMatchingSkillNames 在 reasoning 超长时安全降级为空数组", async () => {
  const home = createTempDir("deepcode-skill-fallback-home-");
  setHomeDir(home);

  // 每个 chunk 200 字符，共 50 个 chunk，总计 10000 字符，超过 skill matching 阈值 4096
  const chunk = "b".repeat(200);
  const { client } = createLoopingReasoningClient(chunk, 50);

  const manager = createSessionManager(client, "Qwen/Qwen3.6-35B-A3B-4bit", "http://127.0.0.1:8000/v1");
  const skills = createSampleSkills();

  // 安全降级：返回空数组，不阻塞对话流程
  const result = await (manager as any).identifyMatchingSkillNames(skills, "阅读全部代码并输出详细功能研究说明文档");

  assert.deepEqual(result, [], "reasoning 超长时应降级返回空数组");
});

test("identifyMatchingSkillNames 正常返回时只包含候选 skill 白名单", async () => {
  const home = createTempDir("deepcode-skill-whitelist-home-");
  setHomeDir(home);

  const { client, requests } = createRecordingClient([
    {
      choices: [
        {
          delta: {
            content: '{"skillNames": ["understand-explain", "unknown-skill", "TRAE-code-review"]}',
          },
        },
      ],
    },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } },
  ]);

  const manager = createSessionManager(client, "gpt-4o", "https://api.openai.com/v1");
  const skills = createSampleSkills();

  const result = await (manager as any).identifyMatchingSkillNames(skills, "解释这个项目");

  // unknown-skill 不在候选列表中，应被过滤；顺序保持原样
  assert.deepEqual(result, ["understand-explain", "TRAE-code-review"]);
  const request = requests[0];
  assert.equal(request.max_tokens, 1024);
  // gpt-4o 不是 thinking 模型，不应包含 thinking 相关字段
  assert.ok(!("thinking" in request), "非 thinking 模型不应包含 thinking 字段");
  assert.ok(!("chat_template_kwargs" in request), "非 thinking 模型不应包含 chat_template_kwargs 字段");
});
