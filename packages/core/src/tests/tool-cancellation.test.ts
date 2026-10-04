import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type OpenAI from "openai";
import { ToolExecutor, type ToolExecutionContext } from "../tools/executor";
import { handleReadTool } from "../tools/read-handler";
import { handleEditTool } from "../tools/edit-handler";
import { handleBashTool } from "../tools/bash-handler";
import { handleWebSearchTool } from "../tools/web-search-handler";
import { handleUnderstandImageTool } from "../tools/understand-image-handler";

function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tool-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const context: ToolExecutionContext = {
    projectRoot: root,
    sessionId: root,
    signal: controller.signal,
    toolCall: { id: "call", type: "function", function: { name: "edit", arguments: "{}" } },
  };
  return { root, controller, context };
}

for (const stage of ["diagnosis", "escape", "language", "translation", "search", "image", "responses"] as const) {
  test(`cancellation reaches pending ${stage} request`, { timeout: 3000 }, async (t) => {
    const { root, controller, context } = setup(t);
    let calls = 0;
    const pending = (_body: unknown, options?: { signal?: AbortSignal | null }) => {
      if (stage !== "diagnosis" && stage !== "escape") {
        assert.equal(options?.signal, controller.signal);
      }
      calls++;
      return new Promise<never>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
        controller.abort();
      });
    };
    let chatCalls = 0;
    const client = {
      chat: {
        completions: {
          create: (body: unknown, options: { signal?: AbortSignal }) => {
            chatCalls++;
            // 隐私加固（2026-09-17 审计）后 UnderstandImage 走 LLM 多模态通道：
            // image 阶段取消点从外部 fetch 迁移到 chat.completions.create（pending 桩）
            if (["search", "responses"].includes(stage) || (stage === "translation" && chatCalls === 1)) {
              return Promise.resolve({ choices: [{ message: { content: '{"dominant_language":"en"}' } }] });
            }
            return pending(body, options);
          },
        },
      },
      responses: { create: pending },
    } as unknown as OpenAI;
    context.createOpenAIClient = () => ({
      client,
      model: "test",
      machineId: "test-machine",
      thinkingEnabled: false,
      baseURL: stage === "responses" ? "https://api.deepseek.com" : "https://example.com",
    });
    // B1 迁移（2026-09）：edit 的 diagnosis / escape 辅助调用从 OpenAI SDK 直连
    // （createOpenAIClient → chat.completions）迁至统一 LLM 客户端（provider 路由），
    // 取消语义改为 createMessage 内部检查 signal（throwIfAborted）+ catch 再检查：
    // abort 后必然以 AbortError reject。pending 桩在 abort 时以 signal.reason
    // reject，与 throwIfAborted 的 reason 语义一致。
    if (stage === "diagnosis" || stage === "escape") {
      context.createLLMClient = () =>
        ({
          createMessage: ({ signal }: { signal?: AbortSignal | null }) => pending(null, { signal }),
        }) as unknown as ToolExecutionContext["createLLMClient"];
    }
    const originalFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    globalThis.fetch = pending as typeof fetch;
    let result: Promise<unknown>;
    if (stage === "diagnosis" || stage === "escape") {
      const file = path.join(root, "file.txt");
      const content = 'value = "hello"\n';
      fs.writeFileSync(file, content);
      const read = await handleReadTool({ file_path: file }, context);
      result = handleEditTool(
        {
          snippet_id: (read.metadata!.snippet as { id: string }).id,
          old_string: stage === "escape" ? 'value = \\"hello\\"\n' : "absent",
          new_string: "updated",
        },
        context
      );
      await assert.rejects(result, { name: "AbortError" });
      assert.equal(fs.readFileSync(file, "utf8"), content);
    } else if (stage === "image") {
      const file = path.join(root, "image.png");
      fs.writeFileSync(file, "image");
      result = handleUnderstandImageTool({ prompt: "describe", image_path: file }, context);
      await assert.rejects(result, { name: "AbortError" });
    } else {
      result = handleWebSearchTool({ query: stage === "translation" ? "中文" : "query" }, context);
      await assert.rejects(result, { name: "AbortError" });
    }
    assert.equal(calls, 1);
  });
}

for (const tool of ["bash", "search"] as const) {
  test(
    `${tool} cancellation kills its process and settles`,
    { timeout: 3000, skip: process.platform === "win32" },
    async (t) => {
      const { root, controller, context } = setup(t);
      let exited = false;
      context.onProcessStart = () => controller.abort();
      context.onProcessExit = () => {
        exited = true;
      };
      const script = path.join(root, "search.sh");
      fs.writeFileSync(script, "#!/bin/sh\nsleep 60\n", { mode: 0o755 });
      context.createOpenAIClient = () => ({
        client: null,
        model: "test",
        thinkingEnabled: false,
        webSearchTool: script,
      });
      await assert.rejects(
        tool === "bash"
          ? handleBashTool({ command: "sleep 60" }, context)
          : handleWebSearchTool({ query: "query" }, context),
        { name: "AbortError" }
      );
      assert.equal(exited, true);
    }
  );
}

test("executor propagates cancellation and never starts the next tool", async (t) => {
  const { root, controller } = setup(t);
  const executor = new ToolExecutor(root);
  const target = path.join(root, "should-not-exist");
  await assert.rejects(
    executor.executeToolCalls(
      root,
      [
        { id: "bash", type: "function", function: { name: "bash", arguments: '{"command":"sleep 60"}' } },
        {
          id: "write",
          type: "function",
          function: { name: "write", arguments: JSON.stringify({ file_path: target, content: "late" }) },
        },
      ],
      { signal: controller.signal, onProcessStart: () => controller.abort() }
    ),
    { name: "AbortError" }
  );
  assert.equal(fs.existsSync(target), false);
});
