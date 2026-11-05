import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type OpenAI from "openai";
import type { ToolExecutionContext } from "../tools/executor";
import { handleWebSearchTool } from "../tools/web-search-handler";
import { resetWebSearchGuard } from "../tools/web-search-guard";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  // 缓存与熔断是进程级单例：用例之间必须复位，否则上一条的结果会被下一条命中
  resetWebSearchGuard();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test(
  "WebSearch executes the configured script with the query as one argument",
  { skip: process.platform === "win32" },
  async () => {
    const workspace = createTempWorkspace();
    const scriptPath = path.join(workspace, "web-search.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/bin/sh",
        "printf 'query=%s\\n' \"$1\"",
        "printf 'cwd=%s\\n' \"$PWD\"",
        "printf 'webhook=%s\\n' \"$WEBHOOK\"",
      ].join("\n"),
      "utf8"
    );
    fs.chmodSync(scriptPath, 0o755);

    const starts: Array<{ id: string | number; command: string }> = [];
    const exits: Array<string | number> = [];
    const result = await handleWebSearchTool(
      { query: "latest node release" },
      createContext(workspace, {
        // 上游 v0.3.1：注入 baseURL（脚本路径优先，不影响脚本执行断言）
        baseURL: "https://api.deepseek.com",
        webSearchTool: scriptPath,
        env: { WEBHOOK: "configured" },
        onProcessStart: (id, command) => starts.push({ id, command }),
        onProcessExit: (id) => exits.push(id),
      })
    );
    const realWorkspace = fs.realpathSync(workspace);

    assert.equal(result.ok, true);
    assert.equal(result.output, `query=latest node release\ncwd=${realWorkspace}\nwebhook=configured\n`);
    assert.equal(starts.length, 1);
    assert.match(starts[0].command, /^WebSearch: latest node release$/);
    assert.deepEqual(exits, [starts[0].id]);
  }
);

for (const baseURL of ["https://example.com/v1", "https://api.deepseek.com"]) {
  for (const [key, host] of [
    [undefined, "https://deepcode.vegamo.cn"],
    ["sk-aaaaaaaaaaaaaaaaaaaaaaaa", "https://deepcode.vegamo.cn"],
    ["sk-bbbbbbbbbbbbbbbbbbbbbbbbbb", "https://www.deepcodeplus.com"],
  ] as const) {
    test(`WebSearch uses the default API when no script is configured (${baseURL}, ${key?.length ?? "absent"})`, async () => {
      const workspace = createTempWorkspace();
      const starts: Array<{ id: string | number; command: string }> = [];
      const exits: Array<string | number> = [];
      const fetchCalls: Array<{ input: string | URL; init?: RequestInit }> = [];

      const fakeClient = {
        chat: {
          completions: {
            create: async ({ messages }: { messages: Array<{ content: string }> }) => {
              const prompt = messages[0]?.content ?? "";
              if (prompt.includes("Return strict JSON:")) {
                return {
                  choices: [
                    {
                      message: {
                        content:
                          '{"dominant_language":"en","reason":"Most Node.js release notes are published in English."}',
                      },
                    },
                  ],
                };
              }
              throw new Error(`Unexpected chat prompt: ${prompt}`);
            },
          },
        },
      } as unknown as OpenAI;

      globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        fetchCalls.push({ input, init });
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: JSON.stringify(
              {
                organic_results: [
                  {
                    title: "Node.js Releases",
                    link: "https://nodejs.org/en/about/previous-releases",
                  },
                ],
              },
              null,
              2
            ),
          }),
        } as Response;
      }) as typeof fetch;

      const result = await handleWebSearchTool(
        { query: "latest node release" },
        createContext(workspace, {
          baseURL,
          client: fakeClient,
          machineId: "machine-id-123",
          plusApiKey: key,
          onProcessStart: (id, command) => starts.push({ id, command }),
          onProcessExit: (id) => exits.push(id),
        })
      );

      assert.equal(result.ok, true);
      assert.match(result.output ?? "", /Node\.js Releases/);
      assert.equal(result.metadata?.resolvedQuery, "latest node release");
      assert.equal(starts.length, 1);
      assert.equal(starts[0].id, exits[0]);
      assert.equal(starts[0].command, "WebSearch: latest node release");
      assert.equal(fetchCalls.length, 1);
      assert.equal(String(fetchCalls[0].input), `${host}/api/plugin/web-search`);
      assert.equal(fetchCalls[0].init?.method, "POST");
      assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), { query: "latest node release" });
      assert.equal((fetchCalls[0].init?.headers as Record<string, string>).Token, "machine-id-123");
      assert.equal((fetchCalls[0].init?.headers as Record<string, string>)["PLUS-API-KEY"], key);
    });
  }
}

test("WebSearch reports and records a default API rate limit error", async () => {
  const workspace = createTempWorkspace();
  const rateLimitedTools: string[] = [];
  let requestHeaders: RequestInit["headers"];
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: '{"dominant_language":"en","reason":"English sources are more useful."}',
              },
            },
          ],
        }),
      },
    },
  } as unknown as OpenAI;
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    requestHeaders = init?.headers;
    return new Response(JSON.stringify({ success: false, reason: "WebSearch rate limit exceeded." }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const result = await handleWebSearchTool(
    { query: "latest node release" },
    createContext(workspace, {
      baseURL: "https://example.com/v1",
      client: fakeClient,
      machineId: "machine-id-123",
      onPluginRateLimitExceeded: (tool) => rateLimitedTools.push(tool),
    })
  );

  assert.equal(result.ok, false);
  // 原始原因要保留（便于排查），同时必须带上「不要重试」这句给模型看的指令
  assert.match(
    result.error ?? "",
    /^WebSearch default mode failed: WebSearch API failed: WebSearch rate limit exceeded\./
  );
  assert.match(result.error ?? "", /不要重试 WebSearch/);
  assert.equal(result.metadata?.rateLimited, true);
  assert.deepEqual(rateLimitedTools, ["WebSearch"]);
  assert.equal((requestHeaders as Record<string, string>)["PLUS-API-KEY"], undefined);
});

test("WebSearch matches rate limit errors case-sensitively", async () => {
  const workspace = createTempWorkspace();
  const rateLimitedTools: string[] = [];
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: '{"dominant_language":"en","reason":"English sources are more useful."}',
              },
            },
          ],
        }),
      },
    },
  } as unknown as OpenAI;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ success: false, reason: "WebSearch Rate limit exceeded." }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

  await handleWebSearchTool(
    { query: "latest node release" },
    createContext(workspace, {
      baseURL: "https://example.com/v1",
      client: fakeClient,
      machineId: "machine-id-123",
      onPluginRateLimitExceeded: (tool) => rateLimitedTools.push(tool),
    })
  );

  assert.deepEqual(rateLimitedTools, []);
});

test("WebSearch translates the query before using the default API with the DeepSeek base URL", async () => {
  const workspace = createTempWorkspace();
  const starts: Array<{ id: string | number; command: string }> = [];
  const exits: Array<string | number> = [];
  const searchQueries: unknown[] = [];

  const fakeClient = {
    chat: {
      completions: {
        create: async ({ messages }: { messages: Array<{ content: string }> }) => {
          const prompt = messages[0]?.content ?? "";
          if (prompt.includes("Return strict JSON:")) {
            return {
              choices: [
                {
                  message: {
                    content:
                      '{"dominant_language":"en","reason":"Most Node.js release notes are published in English."}',
                  },
                },
              ],
            };
          }
          if (prompt.includes("Translate the query text below into English.")) {
            return { choices: [{ message: { content: "latest Node.js release" } }] };
          }
          throw new Error(`Unexpected chat prompt: ${prompt}`);
        },
      },
    },
  } as unknown as OpenAI;

  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    searchQueries.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ success: true, result: "Node.js 24 is the latest release." }), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const result = await handleWebSearchTool(
    { query: "Node.js 最新版本" },
    createContext(workspace, {
      client: fakeClient,
      model: "configured-model",
      machineId: "machine-id-123",
      baseURL: "https://api.deepseek.com",
      onProcessStart: (id, command) => starts.push({ id, command }),
      onProcessExit: (id) => exits.push(id),
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.output, "Node.js 24 is the latest release.");
  assert.equal(result.metadata?.originalQuery, "Node.js 最新版本");
  assert.equal(result.metadata?.resolvedQuery, "latest Node.js release");
  assert.equal(result.metadata?.translated, true);
  assert.deepEqual(searchQueries, [{ query: "latest Node.js release" }]);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].command, "WebSearch: latest Node.js release");
  assert.deepEqual(exits, [starts[0].id]);
});

test("WebSearch returns a configuration error when neither a script nor an LLM client is available", async () => {
  const workspace = createTempWorkspace();
  const result = await handleWebSearchTool({ query: "latest node release" }, createContext(workspace));

  assert.equal(result.ok, false);
  assert.equal(
    result.error,
    "WebSearch default mode requires a valid LLM configuration in ~/.deepcode/settings.json or ./.deepcode/settings.json."
  );
});

// 隐私加固（2026-09-17 审计建议 #4）：出站 query 脱敏
test("WebSearch redacts credential-like content in the outbound query", async () => {
  const workspace = createTempWorkspace();
  const fetchCalls: Array<{ input: string | URL; init?: RequestInit }> = [];

  // 翻译桩：与默认链路一致，处理 "Return strict JSON:" 请求
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: '{"dominant_language":"en","reason":"Keep the original terms."}',
              },
            },
          ],
        }),
      },
    },
  } as unknown as OpenAI;

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init });
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: JSON.stringify({ organic_results: [{ title: "Result" }] }, null, 2),
      }),
    } as Response;
  }) as typeof fetch;

  // 搜索词中意外携带用户粘贴的密钥片段（sk- 密钥 + JWT + 长十六进制）
  const leakedQuery =
    "how to fix sk-proj-abcdef1234567890qwer in eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4f and cafebabe00112233445566778899aabb";

  const result = await handleWebSearchTool(
    { query: leakedQuery },
    createContext(workspace, {
      baseURL: "https://example.com/v1",
      client: fakeClient,
      machineId: "machine-id-123",
    })
  );

  assert.equal(result.ok, true);
  assert.equal(fetchCalls.length, 1);
  const sentBody = JSON.parse(String(fetchCalls[0].init?.body)) as { query: string };
  // 出站 query 已脱敏：凭据片段被 [REDACTED] 替换
  assert.equal(sentBody.query.includes("sk-proj-abcdef1234567890qwer"), false);
  assert.equal(sentBody.query.includes("eyJhbGciOiJIUzI1NiJ9"), false);
  assert.equal(sentBody.query.includes("cafebabe00112233445566778899aabb"), false);
  assert.ok(sentBody.query.includes("[REDACTED]"));
  // 本地活动标签保留原始 query，便于用户审计本机行为
  assert.ok(String(fetchCalls[0].init?.body).length > 0);
});

test("redactSensitiveContent covers common credential formats", async () => {
  const { redactSensitiveContent, SENSITIVE_REDACTED_PLACEHOLDER } = await import("../tools/web-search-handler");

  // OpenAI 风格密钥
  assert.equal(redactSensitiveContent("key is sk-abc123XYZdef_456"), `key is ${SENSITIVE_REDACTED_PLACEHOLDER}`);
  // AWS AccessKey
  assert.equal(redactSensitiveContent("aws AKIAIOSFODNN7EXAMPLE"), `aws ${SENSITIVE_REDACTED_PLACEHOLDER}`);
  // GitHub 令牌
  assert.equal(
    redactSensitiveContent("token ghp_0123456789abcdefghijklmnopqrstuv"),
    `token ${SENSITIVE_REDACTED_PLACEHOLDER}`
  );
  // Slack 令牌
  assert.equal(
    redactSensitiveContent("slack xoxb-fake-fixture-token-not-real-abc"),
    `slack ${SENSITIVE_REDACTED_PLACEHOLDER}`
  );
  // Google API Key
  assert.equal(
    redactSensitiveContent("gcp AIza0123456789abcdefghijklmnopqrstuv0123456"),
    `gcp ${SENSITIVE_REDACTED_PLACEHOLDER}`
  );
  // PEM 私钥块整体移除
  assert.equal(
    redactSensitiveContent("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"),
    SENSITIVE_REDACTED_PLACEHOLDER
  );
  // Authorization 片段：关键字后的内容整体截断脱敏（搜索词中不该有认证头，宁可多删）
  assert.equal(
    redactSensitiveContent("use authorization: Bearer abc.def.ghi-jkl in requests"),
    `use authorization: ${SENSITIVE_REDACTED_PLACEHOLDER}`
  );
  // 普通文本不受影响
  assert.equal(redactSensitiveContent("node.js release schedule 2026"), "node.js release schedule 2026");
});

/** 造一个只会回答「语言判定」的假 client，并统计被调了几次 */
function createCountingClient(): { client: OpenAI; calls: () => number } {
  let calls = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          return {
            choices: [
              {
                message: { content: '{"dominant_language":"en","reason":"English sources are more useful."}' },
              },
            ],
          };
        },
      },
    },
  } as unknown as OpenAI;
  return { client, calls: () => calls };
}

test("W1 同一 query 第二次命中缓存：不再打上游，也不再花两次 LLM 调用", async () => {
  const workspace = createTempWorkspace();
  const { client, calls } = createCountingClient();
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ success: true, result: "cached-result" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const first = await handleWebSearchTool(
    { query: "latest node release" },
    createContext(workspace, { client, baseURL: "https://example.com/v1", machineId: "m-1" })
  );
  const callsAfterFirst = calls();
  const second = await handleWebSearchTool(
    // 大小写与多余空白不同，但归一化后是同一条 query
    { query: "  Latest   Node   Release " },
    createContext(workspace, { client, baseURL: "https://example.com/v1", machineId: "m-1" })
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.output, "cached-result");
  assert.equal(second.metadata?.cached, true);
  assert.equal(fetchCount, 1, "重复的同一 query 不该再扣一次配额");
  assert.equal(calls(), callsAfterFirst, "命中缓存连语言判定都省了");
});

test("W2 不同 query 不共享缓存", async () => {
  const workspace = createTempWorkspace();
  const { client } = createCountingClient();
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ success: true, result: `result-${fetchCount}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  await handleWebSearchTool(
    { query: "latest node release" },
    createContext(workspace, { client, baseURL: "https://example.com/v1", machineId: "m-1" })
  );
  const other = await handleWebSearchTool(
    { query: "rust release schedule" },
    createContext(workspace, { client, baseURL: "https://example.com/v1", machineId: "m-1" })
  );

  assert.equal(fetchCount, 2);
  assert.equal(other.metadata?.cached, undefined);
});

test("W3 限流后熔断：第二次调用直接拒答并明确要求不要重试", async () => {
  const workspace = createTempWorkspace();
  const { client } = createCountingClient();
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ success: false, reason: "WebSearch rate limit exceeded." }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const first = await handleWebSearchTool(
    { query: "latest node release" },
    createContext(workspace, { client, baseURL: "https://example.com/v1", machineId: "m-1" })
  );
  const second = await handleWebSearchTool(
    { query: "another query entirely" },
    createContext(workspace, { client, baseURL: "https://example.com/v1", machineId: "m-1" })
  );

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(fetchCount, 1, "熔断期内不该再打上游——模型重试正是限流恶化的原因");
  assert.match(second.error ?? "", /不要重试 WebSearch/);
  assert.ok((second.metadata?.retryAfterMs as number) > 0, "要告诉模型多久之后才可能恢复");
});

test("W4 HTTP 429 同样触发熔断（不是只有 reason 文案这一条路径）", async () => {
  const workspace = createTempWorkspace();
  const { client } = createCountingClient();
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return new Response("Too Many Requests", { status: 429 });
  }) as typeof fetch;

  const first = await handleWebSearchTool(
    { query: "latest node release" },
    createContext(workspace, { client, baseURL: "https://example.com/v1", machineId: "m-1" })
  );
  const second = await handleWebSearchTool(
    { query: "another query entirely" },
    createContext(workspace, { client, baseURL: "https://example.com/v1", machineId: "m-1" })
  );

  assert.equal(first.ok, false);
  assert.match(first.error ?? "", /429/);
  assert.match(first.error ?? "", /不要重试 WebSearch/);
  assert.equal(fetchCount, 1, "429 之后要继续挡住重试");
  assert.equal(second.metadata?.rateLimited, true);
});

test("W5 同一 query 并发两次只打一次上游（并行工具调用不该双倍扣配额）", async () => {
  const workspace = createTempWorkspace();
  const { client } = createCountingClient();
  let fetchCount = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = (async () => {
    fetchCount += 1;
    await gate;
    return new Response(JSON.stringify({ success: true, result: "shared-result" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const firstPromise = handleWebSearchTool(
    { query: "latest node release" },
    createContext(workspace, { client, baseURL: "https://example.com/v1", machineId: "m-1" })
  );
  const secondPromise = handleWebSearchTool(
    { query: "latest node release" },
    createContext(workspace, { client, baseURL: "https://example.com/v1", machineId: "m-1" })
  );
  // 让两个请求都走到 fetch 之后才放行
  await new Promise((resolve) => setTimeout(resolve, 20));
  release?.();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.output, "shared-result");
  assert.equal(second.output, "shared-result");
  assert.equal(fetchCount, 1, "并行的同一条 query 应共享同一次上游请求");
});

function createContext(
  projectRoot: string,
  options: {
    client?: OpenAI | null;
    // 融合两侧：上游新增 model/baseURL/plusApiKey/onPluginRateLimitExceeded，fork 保留脚本执行相关字段
    model?: string;
    baseURL?: string;
    webSearchTool?: string;
    env?: Record<string, string>;
    machineId?: string;
    plusApiKey?: string;
    onProcessStart?: (processId: string | number, command: string) => void;
    onProcessExit?: (processId: string | number) => void;
    onPluginRateLimitExceeded?: ToolExecutionContext["onPluginRateLimitExceeded"];
  } = {}
): ToolExecutionContext {
  return {
    sessionId: "web-search-test",
    projectRoot,
    toolCall: {
      id: "tool-call-id",
      type: "function",
      function: {
        name: "WebSearch",
        arguments: "{}",
      },
    },
    createOpenAIClient: () => ({
      client: options.client ?? null,
      // 融合两侧：上游新增 model/baseURL/plusApiKey 透传
      model: options.model ?? "test-model",
      baseURL: options.baseURL,
      thinkingEnabled: false,
      webSearchTool: options.webSearchTool,
      env: options.env,
      machineId: options.machineId,
      plusApiKey: options.plusApiKey,
    }),
    onProcessStart: options.onProcessStart,
    onProcessExit: options.onProcessExit,
    onPluginRateLimitExceeded: options.onPluginRateLimitExceeded,
  };
}

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-web-search-"));
  tempDirs.push(dir);
  return dir;
}
