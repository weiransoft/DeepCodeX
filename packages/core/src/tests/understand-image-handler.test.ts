/**
 * UnderstandImage 工具单元测试（隐私加固后版本）
 *
 * 背景（2026-09-17 审计）：
 * - 旧实现将用户图片整文件上传至 https://deepcode.vegamo.cn/api/plugin/understand-image；
 * - 加固后图片以 base64 data URI 进入用户已配置 LLM 的多模态请求，
 *   不再向任何外部插件地址发起请求，也不携带 machineId / PLUS-API-KEY 凭据。
 *
 * 测试策略：注入函数式 OpenAI 兼容桩客户端记录请求入参；
 * 同时劫持 globalThis.fetch 断言其零调用，确保"不外发"这一硬性约束。
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ToolExecutionContext } from "../tools/executor";
import { handleUnderstandImageTool } from "../tools/understand-image-handler";

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("UnderstandImage 通过已配置 LLM 的多模态通道分析图片，且不发起任何外部请求", async () => {
  const workspace = createTempDir("deepcode-understand-image-");
  const imagePath = path.join(workspace, "pixel.png");
  const imageBytes = Buffer.from([1, 2, 3]);
  fs.writeFileSync(imagePath, imageBytes);

  const starts: Array<{ id: string | number; command: string }> = [];
  const exits: Array<string | number> = [];
  const recorded: Array<{ body: unknown; options: unknown }> = [];

  // 劫持 fetch：任何外部请求都视为违反隐私约束，直接记录计数
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    throw new Error("external request must not happen");
  }) as typeof fetch;

  const controller = new AbortController();
  const fakeClient = {
    chat: {
      completions: {
        create: async (body: unknown, options: unknown) => {
          recorded.push({ body, options });
          return {
            choices: [{ message: { content: "a tiny test image" } }],
          };
        },
      },
    },
  };

  const context = createContext(workspace, {
    client: fakeClient,
    model: "vision-model",
    signal: controller.signal,
    onProcessStart: (id, command) => starts.push({ id, command }),
    onProcessExit: (id) => exits.push(id),
  });

  const result = await handleUnderstandImageTool({ prompt: "Describe it", image_path: imagePath }, context);

  assert.equal(result.ok, true);
  assert.equal(result.output, "a tiny test image");
  assert.equal(fetchCount, 0, "加固后不得发起任何外部 fetch 请求");
  assert.equal(recorded.length, 1);

  // 请求体断言：文本指令 + base64 data URI 图片，走用户配置的 model
  const body = recorded[0].body as {
    model: string;
    messages: Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
  };
  assert.equal(body.model, "vision-model");
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content[0].type, "text");
  assert.equal(body.messages[0].content[0].text, "Describe it");
  assert.equal(body.messages[0].content[1].type, "image_url");
  assert.equal(body.messages[0].content[1].image_url?.url, `data:image/png;base64,${imageBytes.toString("base64")}`);

  // 中断信号透传断言
  assert.equal((recorded[0].options as { signal?: AbortSignal }).signal, controller.signal);

  // 活动生命周期断言
  assert.equal(starts[0]?.command, "UnderstandImage: pixel.png");
  assert.deepEqual(exits, [starts[0]?.id]);
});

test("UnderstandImage 拼接分段 content 响应并对空响应报错", async () => {
  const workspace = createTempDir("deepcode-understand-image-parts-");
  const imagePath = path.join(workspace, "pixel.webp");
  fs.writeFileSync(imagePath, Buffer.from([1]));

  const emptyClient = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: "" } }] }) } },
  };
  const emptyResult = await handleUnderstandImageTool(
    { prompt: "Describe it", image_path: imagePath },
    createContext(workspace, { client: emptyClient })
  );
  assert.equal(emptyResult.ok, false);
  assert.match(emptyResult.error ?? "", /response was empty/);

  const partsClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: [
                  { type: "text", text: "part one" },
                  { type: "text", text: "part two" },
                ],
              },
            },
          ],
        }),
      },
    },
  };
  const partsResult = await handleUnderstandImageTool(
    { prompt: "Describe it", image_path: imagePath },
    createContext(workspace, { client: partsClient })
  );
  assert.equal(partsResult.ok, true);
  assert.equal(partsResult.output, "part one\npart two");
});

test("UnderstandImage 将 LLM API 错误转换为工具错误且不崩溃", async () => {
  const workspace = createTempDir("deepcode-understand-image-llm-error-");
  const imagePath = path.join(workspace, "pixel.jpg");
  fs.writeFileSync(imagePath, Buffer.from([1]));

  const failingClient = {
    chat: {
      completions: {
        create: async () => {
          throw new Error("401 model does not support vision");
        },
      },
    },
  };

  const result = await handleUnderstandImageTool(
    { prompt: "Describe it", image_path: imagePath },
    createContext(workspace, { client: failingClient })
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /UnderstandImage request failed/);
  assert.match(result.error ?? "", /401 model does not support vision/);
});

test("UnderstandImage 在未配置 LLM 客户端时报错而非外发", async () => {
  const workspace = createTempDir("deepcode-understand-image-no-client-");
  const imagePath = path.join(workspace, "pixel.png");
  fs.writeFileSync(imagePath, Buffer.from([1]));

  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    throw new Error("external request must not happen");
  }) as typeof fetch;

  const result = await handleUnderstandImageTool(
    { prompt: "Describe it", image_path: imagePath },
    createContext(workspace, { client: null })
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /requires a configured LLM client/);
  assert.equal(fetchCount, 0);
});

test("UnderstandImage 校验绝对路径、格式与大小，且校验失败时不触碰 LLM", async () => {
  const workspace = createTempDir("deepcode-understand-image-validation-");
  const unsupportedPath = path.join(workspace, "pixel.gif");
  const emptyPath = path.join(workspace, "empty.png");
  const oversizedPath = path.join(workspace, "oversized.jpg");
  fs.writeFileSync(unsupportedPath, Buffer.from([1]));
  fs.writeFileSync(emptyPath, Buffer.alloc(0));
  fs.writeFileSync(oversizedPath, Buffer.alloc(1));
  fs.truncateSync(oversizedPath, 10 * 1024 * 1024 + 1);

  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    throw new Error("external request must not happen");
  }) as typeof fetch;

  let createCalls = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          createCalls += 1;
          return { choices: [{ message: { content: "unused" } }] };
        },
      },
    },
  };

  const relative = await handleUnderstandImageTool(
    { prompt: "Describe it", image_path: "pixel.png" },
    createContext(workspace, { client })
  );
  const unsupported = await handleUnderstandImageTool(
    { prompt: "Describe it", image_path: unsupportedPath },
    createContext(workspace, { client })
  );
  const empty = await handleUnderstandImageTool(
    { prompt: "Describe it", image_path: emptyPath },
    createContext(workspace, { client })
  );
  const oversized = await handleUnderstandImageTool(
    { prompt: "Describe it", image_path: oversizedPath },
    createContext(workspace, { client })
  );

  assert.match(relative.error ?? "", /absolute path/);
  assert.match(unsupported.error ?? "", /Only JPEG, PNG, and WebP/);
  assert.match(empty.error ?? "", /must not be empty/);
  assert.match(oversized.error ?? "", /exceeds the 10 MiB limit/);
  assert.equal(fetchCount, 0, "校验失败阶段也不得发起外部请求");
  assert.equal(createCalls, 0, "校验失败阶段不得调用 LLM");
});

interface CreateContextHooks {
  client: unknown;
  model?: string;
  signal?: AbortSignal;
  onProcessStart?: ToolExecutionContext["onProcessStart"];
  onProcessExit?: ToolExecutionContext["onProcessExit"];
}

function createContext(projectRoot: string, hooks: CreateContextHooks): ToolExecutionContext {
  return {
    sessionId: "understand-image-test",
    projectRoot,
    signal: hooks.signal,
    toolCall: {
      id: "tool-call-id",
      type: "function",
      function: { name: "UnderstandImage", arguments: "{}" },
    },
    createOpenAIClient: () => ({
      client: hooks.client as never,
      model: hooks.model ?? "vision-model",
      baseURL: "https://api.example.com/v1",
      thinkingEnabled: false,
    }),
    ...(hooks.onProcessStart ? { onProcessStart: hooks.onProcessStart } : {}),
    ...(hooks.onProcessExit ? { onProcessExit: hooks.onProcessExit } : {}),
  } as ToolExecutionContext;
}

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
