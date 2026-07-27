/**
 * SessionManager.buildOpenAIMessages 测试套件
 *
 * 覆盖方法群：
 * - 基础结构：系统消息 image_url、多模态过滤、reasoning_content 兼容
 * - 中断/孤儿/重复/多工具修复：missing tool、interrupted placeholder、
 *   orphan tool、later paired tool、multi-tool happy path、real failed tool、
 *   mixed badcase、tool before assistant
 * - 消息构造：addBackgroundProcessCompletionMessage、buildToolMessage params
 *   （UpdatePlan/Write/LLM 工具调用 ID 生成）
 *
 * 共 18 个测试用例。
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { SessionManager, type SessionMessage } from "../session";
import {
  createSessionTestEnv,
  createTempDir,
  createSessionManager,
  createMockedClientSessionManager,
  createChatResponse,
  buildTestMessage,
  escapeRegExp,
} from "./fixtures/session-test-env";

// 每个测试文件持有独立的 env 实例，避免跨文件全局状态污染
const env = createSessionTestEnv();

afterEach(() => {
  env.cleanup();
});

test("SessionManager preserves structured system content when building OpenAI messages", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const messages: SessionMessage[] = [
    {
      id: "system-image",
      sessionId: "session-1",
      role: "system",
      content: "The read tool has loaded `pixel.png`.",
      contentParams: [
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,abc123" },
        },
      ],
      messageParams: null,
      compacted: false,
      visible: false,
      createTime: "2026-01-01T00:00:00.000Z",
      updateTime: "2026-01-01T00:00:00.000Z",
    },
  ];

  const openAIMessages = (manager as any).buildOpenAIMessages(messages, false, "test-model") as Array<{
    role: string;
    content: unknown;
  }>;

  assert.equal(openAIMessages.length, 1);
  assert.equal(openAIMessages[0]?.role, "system");
  assert.deepEqual(openAIMessages[0]?.content, [
    { type: "text", text: "The read tool has loaded `pixel.png`." },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,abc123" },
    },
  ]);
});

test("SessionManager appends failed background log tail as XML", () => {
  const workspace = createTempDir(env, "deepcode-background-log-workspace-");
  const home = createTempDir(env, "deepcode-background-log-home-");
  env.setHomeDir(home);
  const outputPath = path.join(workspace, "background.log");
  fs.writeFileSync(outputPath, ["before", "failure <line> & one", "failure line two"].join("\n"), "utf8");
  let systemMessage: SessionMessage | null = null;
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: (message) => {
      systemMessage = message;
    },
  });

  (manager as any).addBackgroundProcessCompletionMessage("session-background-fail", {
    command: "npm test",
    outputPath,
    ok: false,
    exitCode: 1,
    signal: null,
    startedAtMs: 0,
    completedAtMs: 1200,
  });

  assert.ok(systemMessage);
  const message = systemMessage as SessionMessage;
  assert.equal(message.role, "system");
  const content = message.content ?? "";
  assert.match(content, /Background command "npm test" failed with exit code 1/);
  assert.match(content, new RegExp(`<background_task_failure_log path="${escapeRegExp(outputPath)}">`));
  assert.match(content, /failure <line> & one[\s\S]*failure line two/);
  assert.doesNotMatch(content, /failure &lt;line&gt; &amp; one/);
  assert.doesNotMatch(content, /<output_path>/);
  assert.doesNotMatch(content, /<tail>/);
});

test("SessionManager filters image content for non-multimodal models", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "deepseek-chat",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "deepseek-chat" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const messages: SessionMessage[] = [
    {
      id: "system-image",
      sessionId: "session-1",
      role: "system",
      content: "The read tool has loaded `pixel.png`.",
      contentParams: [
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,abc123" },
        },
      ],
      messageParams: null,
      compacted: false,
      visible: false,
      createTime: "2026-01-01T00:00:00.000Z",
      updateTime: "2026-01-01T00:00:00.000Z",
    },
  ];

  const openAIMessages = (manager as any).buildOpenAIMessages(messages, false, "deepseek-chat") as Array<{
    role: string;
    content: unknown;
  }>;

  assert.equal(openAIMessages.length, 1);
  assert.deepEqual(openAIMessages[0]?.content, [{ type: "text", text: "The read tool has loaded `pixel.png`." }]);
});

test("SessionManager preserves empty reasoning content on assistant tool calls", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const message = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: "{}" },
      },
    ],
    ""
  ) as SessionMessage;

  assert.deepEqual(message.messageParams, {
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: "{}" },
      },
    ],
    reasoning_content: "",
  });

  const openAIMessages = (manager as any).buildOpenAIMessages([message], true, "test-model") as Array<{
    reasoning_content?: string;
  }>;

  assert.equal(openAIMessages[0]?.reasoning_content, "");
});

test("SessionManager repairs legacy thinking tool calls missing reasoning content", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const messages: SessionMessage[] = [
    {
      id: "assistant-tool",
      sessionId: "session-1",
      role: "assistant",
      content: "",
      contentParams: null,
      messageParams: {
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
      compacted: false,
      visible: false,
      createTime: "2026-01-01T00:00:00.000Z",
      updateTime: "2026-01-01T00:00:00.000Z",
    },
  ];

  const thinkingMessages = (manager as any).buildOpenAIMessages(messages, true, "test-model") as Array<{
    reasoning_content?: string;
  }>;
  const nonThinkingMessages = (manager as any).buildOpenAIMessages(messages, false, "test-model") as Array<{
    reasoning_content?: string;
  }>;

  assert.equal(thinkingMessages[0]?.reasoning_content, "");
  assert.equal(Object.prototype.hasOwnProperty.call(nonThinkingMessages[0] ?? {}, "reasoning_content"), false);
});

test("SessionManager replays normal assistant messages with reasoning content in thinking mode", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const messages: SessionMessage[] = [
    {
      id: "assistant-final",
      sessionId: "session-1",
      role: "assistant",
      content: "Final answer",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: "2026-01-01T00:00:00.000Z",
      updateTime: "2026-01-01T00:00:00.000Z",
    },
  ];

  const thinkingMessages = (manager as any).buildOpenAIMessages(messages, true, "test-model") as Array<{
    reasoning_content?: string;
  }>;
  const nonThinkingMessages = (manager as any).buildOpenAIMessages(messages, false, "test-model") as Array<{
    reasoning_content?: string;
  }>;

  assert.equal(thinkingMessages[0]?.reasoning_content, "");
  assert.equal(Object.prototype.hasOwnProperty.call(nonThinkingMessages[0] ?? {}, "reasoning_content"), false);
});

test("buildOpenAIMessages inserts interrupted results for missing tool messages", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-missing-tool");
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "I will run a tool.",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"sleep 100"}' },
      },
    ],
    ""
  ) as SessionMessage;
  const userMessage = buildTestMessage("user-after-tool-call", "session-1", "user", "continue");

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [assistantMessage, userMessage],
    false,
    "test-model"
  ) as Array<{
    role: string;
    content: string;
    tool_call_id?: string;
  }>;

  assert.equal(openAIMessages.length, 3);
  assert.equal(openAIMessages[0]?.role, "assistant");
  assert.equal(openAIMessages[1]?.role, "tool");
  assert.equal(openAIMessages[1]?.tool_call_id, "call-1");
  assert.match(openAIMessages[1]?.content ?? "", /Previous tool call did not complete/);
  assert.equal(openAIMessages[2]?.role, "user");
});

test("buildOpenAIMessages keeps only the first non-interrupted tool result for a tool call", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-duplicate-tool");
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"date"}' },
      },
    ],
    ""
  ) as SessionMessage;
  const successToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({ ok: true, name: "bash", output: "2026-05-07 星期四\n" }),
    { name: "bash", arguments: '{"command":"date"}' }
  ) as SessionMessage;
  const interruptedToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({
      ok: false,
      name: "bash",
      error: "Previous tool call did not complete.",
      metadata: { interrupted: true },
    }),
    { name: "bash", arguments: '{"command":"date"}' }
  ) as SessionMessage;

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [assistantMessage, successToolMessage, interruptedToolMessage],
    false,
    "test-model"
  ) as Array<{ role: string; content: string; tool_call_id?: string }>;
  const toolMessages = openAIMessages.filter((message) => message.role === "tool");

  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0]?.tool_call_id, "call-1");
  assert.match(toolMessages[0]?.content ?? "", /2026-05-07/);
  assert.doesNotMatch(toolMessages[0]?.content ?? "", /Previous tool call did not complete/);
});

test("buildOpenAIMessages prefers a later real tool result over an earlier interrupted placeholder", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-prefer-real-tool");
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"date"}' },
      },
    ],
    ""
  ) as SessionMessage;
  const interruptedToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({
      ok: false,
      name: "bash",
      error: "Previous tool call did not complete.",
      metadata: { interrupted: true },
    }),
    { name: "bash", arguments: '{"command":"date"}' }
  ) as SessionMessage;
  const successToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({ ok: true, name: "bash", output: "real result" }),
    { name: "bash", arguments: '{"command":"date"}' }
  ) as SessionMessage;

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [assistantMessage, interruptedToolMessage, successToolMessage],
    false,
    "test-model"
  ) as Array<{ role: string; content: string; tool_call_id?: string }>;
  const toolMessages = openAIMessages.filter((message) => message.role === "tool");

  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0]?.tool_call_id, "call-1");
  assert.match(toolMessages[0]?.content ?? "", /real result/);
});

test("buildOpenAIMessages ignores orphan tool messages", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-orphan-tool");
  const userMessage = buildTestMessage("user-1", "session-1", "user", "hello");
  const orphanToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-orphan",
    JSON.stringify({ ok: true, name: "bash", output: "orphan" }),
    { name: "bash", arguments: '{"command":"echo orphan"}' }
  ) as SessionMessage;

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [userMessage, orphanToolMessage],
    false,
    "test-model"
  ) as Array<{
    role: string;
  }>;

  assert.deepEqual(
    openAIMessages.map((message) => message.role),
    ["user"]
  );
});

test("buildOpenAIMessages moves a later paired tool message behind its assistant", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-later-tool");
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"date"}' },
      },
    ],
    ""
  ) as SessionMessage;
  const userMessage = buildTestMessage("user-between", "session-1", "user", "continue");
  const toolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({ ok: true, name: "bash", output: "paired later" }),
    { name: "bash", arguments: '{"command":"date"}' }
  ) as SessionMessage;

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [assistantMessage, userMessage, toolMessage],
    false,
    "test-model"
  ) as Array<{ role: string; content: string }>;

  assert.deepEqual(
    openAIMessages.map((message) => message.role),
    ["assistant", "tool", "user"]
  );
  assert.match(openAIMessages[1]?.content ?? "", /paired later/);
});

test("buildOpenAIMessages preserves a complete multi-tool happy path", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-multi-tool-happy");
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: '{"file_path":"/tmp/a.txt"}' },
      },
      {
        id: "call-2",
        type: "function",
        function: { name: "bash", arguments: '{"command":"pwd"}' },
      },
    ],
    ""
  ) as SessionMessage;
  const firstToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({ ok: true, name: "read", content: "file content" }),
    { name: "read", arguments: '{"file_path":"/tmp/a.txt"}' }
  ) as SessionMessage;
  const secondToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-2",
    JSON.stringify({ ok: true, name: "bash", output: "/tmp\n" }),
    { name: "bash", arguments: '{"command":"pwd"}' }
  ) as SessionMessage;
  const userMessage = buildTestMessage("user-after-complete-tools", "session-1", "user", "thanks");

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [assistantMessage, firstToolMessage, secondToolMessage, userMessage],
    false,
    "test-model"
  ) as Array<{ role: string; content: string; tool_call_id?: string }>;

  assert.deepEqual(
    openAIMessages.map((message) => message.role),
    ["assistant", "tool", "tool", "user"]
  );
  assert.deepEqual(
    openAIMessages.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
    ["call-1", "call-2"]
  );
  assert.equal(
    openAIMessages.some((message) => message.content.includes("Previous tool call did not complete.")),
    false
  );
});

test("buildOpenAIMessages preserves a real failed tool result", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-real-failed-tool");
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"false"}' },
      },
    ],
    ""
  ) as SessionMessage;
  const failedToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({ ok: false, name: "bash", error: "Command failed", metadata: { exitCode: 1 } }),
    { name: "bash", arguments: '{"command":"false"}' }
  ) as SessionMessage;

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [assistantMessage, failedToolMessage],
    false,
    "test-model"
  ) as Array<{
    role: string;
    content: string;
    tool_call_id?: string;
  }>;

  assert.deepEqual(
    openAIMessages.map((message) => message.role),
    ["assistant", "tool"]
  );
  assert.equal(openAIMessages[1]?.tool_call_id, "call-1");
  assert.match(openAIMessages[1]?.content ?? "", /Command failed/);
  assert.doesNotMatch(openAIMessages[1]?.content ?? "", /Previous tool call did not complete/);
});

test("UpdatePlan tool params only show explanation when provided", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-update-plan-params");
  const plan = "## Task List\n\n- [ ] Inspect project";

  const withExplanation = (manager as any).buildToolMessage(
    "session-1",
    "call-plan-1",
    JSON.stringify({ ok: true, name: "UpdatePlan", output: "Plan updated." }),
    { name: "UpdatePlan", arguments: JSON.stringify({ plan, explanation: "Start planning" }) }
  ) as SessionMessage;
  const withoutExplanation = (manager as any).buildToolMessage(
    "session-1",
    "call-plan-2",
    JSON.stringify({ ok: true, name: "UpdatePlan", output: "Plan updated." }),
    { name: "UpdatePlan", arguments: JSON.stringify({ plan }) }
  ) as SessionMessage;

  assert.equal(withExplanation.meta?.paramsMd, "Start planning");
  assert.equal(withoutExplanation.meta?.paramsMd, "");
});

test("Write tool params prefer file_path even when content appears first", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-write-params");
  const filePath = path.join(process.cwd(), "index.html");

  const toolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-write-1",
    JSON.stringify({ ok: true, name: "write", output: "Created file." }),
    {
      name: "write",
      arguments: JSON.stringify({
        content: "// === entry ===\nconsole.log('demo');\n",
        file_path: filePath,
      }),
    }
  ) as SessionMessage;

  assert.equal(toolMessage.meta?.paramsMd, filePath);
});

test("LLM tool calls without ids receive generated 32 character ids", async () => {
  const workspace = createTempDir(env, "deepcode-tool-call-id-workspace-");
  const home = createTempDir(env, "deepcode-tool-call-id-home-");
  env.setHomeDir(home);

  const filePath = path.join(workspace, "note.txt");
  fs.writeFileSync(filePath, "hello\n", "utf8");
  const plan = "## Task List\n\n- [ ] Inspect current behavior";
  const manager = createMockedClientSessionManager(workspace, [
    {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "",
                type: "function",
                function: {
                  name: "UpdatePlan",
                  arguments: JSON.stringify({ plan, explanation: "Initial plan" }),
                },
              },
              {
                type: "function",
                function: {
                  name: "read",
                  arguments: JSON.stringify({ file_path: filePath }),
                },
              },
            ],
          },
        },
      ],
    },
    createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ]);

  const sessionId = await manager.createSession({ text: "inspect note" });
  const assistantMessage = manager
    .listSessionMessages(sessionId)
    .find((message) => message.role === "assistant" && (message.messageParams as any)?.tool_calls);
  const toolCalls = (assistantMessage?.messageParams as { tool_calls?: Array<{ id?: unknown }> } | null)?.tool_calls;

  assert.equal(toolCalls?.length, 2);
  assert.match(String(toolCalls?.[0]?.id), /^[0-9a-f]{32}$/);
  assert.match(String(toolCalls?.[1]?.id), /^[0-9a-f]{32}$/);
  assert.notEqual(toolCalls?.[0]?.id, toolCalls?.[1]?.id);

  const toolMessages = manager.listSessionMessages(sessionId).filter((message) => message.role === "tool");
  assert.deepEqual(
    toolMessages.map((message) => (message.messageParams as { tool_call_id?: unknown } | null)?.tool_call_id),
    toolCalls?.map((toolCall) => toolCall.id)
  );

  const readToolMessage = toolMessages.find((message) => JSON.parse(message.content ?? "{}").name === "read");
  assert.equal((readToolMessage?.meta?.function as { name?: string } | undefined)?.name, "read");
  assert.equal(readToolMessage?.meta?.paramsMd, "note.txt");
});

test("buildOpenAIMessages repairs mixed missing duplicate and orphan tool messages", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-mixed-tool-badcase");
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: '{"file_path":"/tmp/missing.txt"}' },
      },
      {
        id: "call-2",
        type: "function",
        function: { name: "bash", arguments: '{"command":"pwd"}' },
      },
    ],
    ""
  ) as SessionMessage;
  const orphanToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-orphan",
    JSON.stringify({ ok: true, name: "bash", output: "orphan" }),
    { name: "bash", arguments: '{"command":"echo orphan"}' }
  ) as SessionMessage;
  const pairedToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-2",
    JSON.stringify({ ok: true, name: "bash", output: "/tmp\n" }),
    { name: "bash", arguments: '{"command":"pwd"}' }
  ) as SessionMessage;
  const duplicateToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-2",
    JSON.stringify({ ok: true, name: "bash", output: "duplicate" }),
    { name: "bash", arguments: '{"command":"pwd"}' }
  ) as SessionMessage;
  const userMessage = buildTestMessage("user-after-mixed-tools", "session-1", "user", "continue");

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [assistantMessage, orphanToolMessage, pairedToolMessage, duplicateToolMessage, userMessage],
    false,
    "test-model"
  ) as Array<{ role: string; content: string; tool_call_id?: string }>;
  const toolMessages = openAIMessages.filter((message) => message.role === "tool");

  assert.deepEqual(
    openAIMessages.map((message) => message.role),
    ["assistant", "tool", "tool", "user"]
  );
  assert.deepEqual(
    toolMessages.map((message) => message.tool_call_id),
    ["call-1", "call-2"]
  );
  assert.match(toolMessages[0]?.content ?? "", /Previous tool call did not complete/);
  assert.match(toolMessages[1]?.content ?? "", /\/tmp/);
  assert.equal(
    openAIMessages.some((message) => message.content.includes("orphan")),
    false
  );
  assert.equal(
    openAIMessages.some((message) => message.content.includes("duplicate")),
    false
  );
});

test("buildOpenAIMessages ignores tool messages that appear before their assistant", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-tool-before-assistant");
  const earlyToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({ ok: true, name: "bash", output: "too early" }),
    { name: "bash", arguments: '{"command":"date"}' }
  ) as SessionMessage;
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"date"}' },
      },
    ],
    ""
  ) as SessionMessage;

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [earlyToolMessage, assistantMessage],
    false,
    "test-model"
  ) as Array<{
    role: string;
    content: string;
    tool_call_id?: string;
  }>;

  assert.deepEqual(
    openAIMessages.map((message) => message.role),
    ["assistant", "tool"]
  );
  assert.equal(openAIMessages[1]?.tool_call_id, "call-1");
  assert.match(openAIMessages[1]?.content ?? "", /Previous tool call did not complete/);
  assert.doesNotMatch(openAIMessages[1]?.content ?? "", /too early/);
});
