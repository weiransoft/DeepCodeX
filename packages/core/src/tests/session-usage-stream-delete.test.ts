/**
 * SessionManager Usage / compact / stream / deleteSession 测试套件
 *
 * 覆盖方法群：
 * - Usage 累积：keeps usagePerModel null until response、accumulates response usage、
 *   stores usage per model across model changes
 * - compact：resets active tokens to latest post-compaction、writes summary message、
 *   silently skips when no LLM client credential
 * - stream：streams chat completions and counts reasoning progress
 * - 中断处理：persists session before skill matching cancelled、treats APIUserAbortError as interrupted
 * - deleteSession：removes session entry、removes messages file、returns false when not exist、
 *   does not affect other sessions
 *
 * 共 13 个测试用例。
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { SessionManager, getProjectCode } from "../session";
import type { LLMClient, LLMRequest, LLMResponse } from "../providers/llm-provider";
import {
  createSessionTestEnv,
  createTempDir,
  createSessionManager,
  createMockedClientSessionManager,
  createMockedClientSessionManagerWithClient,
  createChatResponse,
  createSkillMatchingResponse,
  isSkillMatchingRequest,
  createStubLLMClient,
  createLLMTextResponse,
  createChatStreamResponse,
  createSessionAndMessages,
  APIUserAbortError,
} from "./fixtures/session-test-env";

// 每个测试文件持有独立的 env 实例，避免跨文件全局状态污染
const env = createSessionTestEnv();

afterEach(() => {
  env.cleanup();
});

/**
 * T8 测试辅助：读取 compact 事件日志（JSONL）并逐行解析
 *
 * compact.log 由 common/compact-logger.ts 写入 `<home>/.deepcodex/logs/compact.log`。
 * 每行必须是合法 JSON（解析失败直接抛错 = 断言"每行合法 JSON"）。
 *
 * @param home 测试用家目录（env.setHomeDir 注入的临时目录）
 * @returns 解析后的事件行数组（文件不存在时返回空数组）
 */
function readCompactLogLines(home: string): Array<Record<string, any>> {
  const logPath = path.join(home, ".deepcodex", "logs", "compact.log");
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

// ---------------------------------------------------------------------------
// T2/T5：flushSedimentation 公开 API（沉淀兜底 + sedimentation.log 结构化事件）
// ---------------------------------------------------------------------------

/**
 * T2/T5 测试辅助：读取沉淀事件日志（JSONL）并逐行解析
 *
 * sedimentation.log 由 common/sediment-logger.ts 写入 `<home>/.deepcodex/logs/sedimentation.log`。
 * 每行必须是合法 JSON（解析失败直接抛错 = 断言"每行合法 JSON"）。
 *
 * @param home 测试用家目录（env.setHomeDir 注入的临时目录）
 * @returns 解析后的事件行数组（文件不存在时返回空数组）
 */
function readSedimentLogLines(home: string): Array<Record<string, any>> {
  const logPath = path.join(home, ".deepcodex", "logs", "sedimentation.log");
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

test("SD-01 flushSedimentation syncs store records to experience.json and logs flush event (T2/T5)", async () => {
  const workspace = createTempDir(env, "deepcode-flush-sediment-workspace-");
  const home = createTempDir(env, "deepcode-flush-sediment-home-");
  env.setHomeDir(home);

  // 受控 LLM 桩：一轮无 toolCalls 的最终回复（主对话自然收尾 → finally 沉淀）
  const responses = [createChatResponse("sediment ok", { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })];
  const manager = createMockedClientSessionManager(workspace, responses);

  const sessionId = await manager.createSession({ text: "" });
  await manager.replySession(sessionId, { text: "" });

  // 经 SessionManager 内部 executionHistoryStore 直写一条成功命令执行记录
  // （沿用既有私有字段访问测试模式，见 session.test.ts 对内部状态的直接操作）
  const store = (manager as any).executionHistoryStore as {
    record: (inputs: Record<string, unknown>) => Promise<void>;
  };
  assert.ok(store, "SessionManager 应初始化 executionHistoryStore");
  await store.record({
    sessionId,
    toolName: "bash",
    ok: true,
    exitCode: 0,
    argsSnippet: JSON.stringify({ command: "npm test" }),
    cwd: workspace,
  });

  // flushSedimentation：closeSync 落盘 pending + 沉淀 + logSedimentEvent(type:"flush")
  const stats = manager.flushSedimentation(sessionId);
  assert.ok(stats.successCount >= 1, `flush 应沉淀至少 1 条成功命令，实际 ${stats.successCount}`);
  assert.equal(typeof stats.linkedCount, "number", "返回应含 T4 linkedCount 字段");

  // experience.json 出现条目（MemoryStore experience 持久化，锚定测试 HOME）
  const experiencePath = path.join(home, ".deepcode", "memory", "experience.json");
  assert.ok(fs.existsSync(experiencePath), "experience.json 应存在");
  const experienceData = JSON.parse(fs.readFileSync(experiencePath, "utf8"));
  assert.ok(
    Array.isArray(experienceData.entries) && experienceData.entries.length >= 1,
    "experience.json 应含沉淀条目"
  );

  // 重复 flush 幂等：dedupKey 不新增条目（usageCount 递增由 v2 sync 测试锁定）
  const entriesBefore = experienceData.entries.length as number;
  manager.flushSedimentation(sessionId);
  const experienceData2 = JSON.parse(fs.readFileSync(experiencePath, "utf8"));
  assert.equal(experienceData2.entries.length, entriesBefore, "重复 flush 不应新增 dedupKey 条目");

  // sedimentation.log：每行合法 JSON；finally 写 sync 事件、flush API 写 flush 事件
  const logLines = readSedimentLogLines(home);
  assert.ok(logLines.length >= 3, `应至少有 finally sync ×1 + flush ×2 事件，实际 ${logLines.length}`);
  for (const line of logLines) {
    assert.equal(typeof line.ts, "string", "每行应携带 ISO 时间戳 ts");
    assert.equal(typeof line.type, "string", "每行应携带事件类型 type");
  }
  const types = logLines.map((line) => line.type);
  assert.ok(types.includes("sync"), `事件应含 finally sync 类型，实际：${types.join(" → ")}`);
  assert.ok(types.includes("flush"), `事件应含 flush 类型，实际：${types.join(" → ")}`);
  const flushEvent = logLines.filter((line) => line.type === "flush")[0];
  assert.equal(flushEvent.sessionId, sessionId, "flush 事件应关联 sessionId");
  assert.ok((flushEvent.successCount as number) >= 1, `flush 事件 successCount 应 ≥1，实际 ${flushEvent.successCount}`);
});

// ---------------------------------------------------------------------------
// T8：compact 链路进度日志（compact.log 事件序列 / 耗时打点 / 跳过观测）
// ---------------------------------------------------------------------------

test("CP-01 compact chain logs compact_start/summary_start/summary_done/compact_done with durations (T8)", async () => {
  const workspace = createTempDir(env, "deepcode-compact-log-cp01-workspace-");
  const home = createTempDir(env, "deepcode-compact-log-cp01-home-");
  env.setHomeDir(home);

  const responses = [
    createChatResponse("large reply", {
      prompt_tokens: 139_990,
      completion_tokens: 10,
      total_tokens: 140_000,
    }),
    createChatResponse("after compact", {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    }),
  ];
  const compactRequests: LLMRequest[] = [];
  // 摘要响应延迟 15ms 返回，使 summary_done 的 durationMs 可被观测（> 0）
  const summaryStartedAtMarker = { value: 0 };
  const summaryLLMClient: LLMClient = {
    providerName: "openai",
    model: "test-model",
    baseURL: "https://api.deepseek.com",
    supportsThinking: true,
    supportsPromptCaching: false,
    createMessage: async (request: LLMRequest): Promise<LLMResponse> => {
      compactRequests.push(request);
      summaryStartedAtMarker.value = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 15));
      return createLLMTextResponse("T8 摘要文本", { inputTokens: 100, outputTokens: 23 });
    },
    createMessageStream: async function* () {},
  };
  // 复用既有 compact 触发夹具：显式固定阈值 131072 保证自动触发
  const manager = createMockedClientSessionManager(workspace, responses, {
    createLLMClient: () => summaryLLMClient,
    autoCompactWindow: 131_072,
  });

  const sessionId = await manager.createSession({ text: "" });
  await manager.replySession(sessionId, { text: "" });

  // compact.log 存在且每行合法 JSON（readCompactLogLines 解析失败会直接抛错）
  const logPath = path.join(home, ".deepcodex", "logs", "compact.log");
  assert.ok(fs.existsSync(logPath), "compact.log 应存在");
  const logLines = readCompactLogLines(home);
  assert.ok(logLines.length > 0, "compact.log 应至少包含一条事件");
  for (const line of logLines) {
    assert.equal(typeof line.ts, "string", "每行应携带 ISO 时间戳 ts");
    assert.equal(typeof line.type, "string", "每行应携带事件类型 type");
    assert.equal(line.sessionId, sessionId, "每行应关联当前会话 ID");
  }

  // 事件序列：compact_start → summary_start → summary_done → compact_done（相对顺序）
  const types = logLines.map((line) => line.type);
  const indexOfType = (type: string): number => types.indexOf(type);
  for (const required of ["compact_start", "summary_start", "summary_done", "compact_done"]) {
    assert.ok(indexOfType(required) !== -1, `事件序列应包含 ${required}，实际：${types.join(" → ")}`);
  }
  assert.ok(
    indexOfType("compact_start") < indexOfType("summary_start") &&
      indexOfType("summary_start") < indexOfType("summary_done") &&
      indexOfType("summary_done") < indexOfType("compact_done"),
    `事件相对顺序应为 compact_start → summary_start → summary_done → compact_done，实际：${types.join(" → ")}`
  );

  // compact_start：观测字段完整（阈值/估算 token/消息区间）
  const startEvent = logLines[indexOfType("compact_start")];
  assert.equal(startEvent.threshold, 131_072, "compact_start 应记录生效的 compact 阈值");
  assert.equal(typeof startEvent.tokensBefore, "number", "compact_start 应记录触发时估算 token 数");
  assert.equal(typeof startEvent.rangeStart, "number", "compact_start 应记录压缩区间起点");
  assert.equal(typeof startEvent.rangeEnd, "number", "compact_start 应记录压缩区间终点");

  // summary_done：durationMs 与 summaryChars 打点存在且合理
  const summaryDone = logLines[indexOfType("summary_done")];
  assert.equal(typeof summaryDone.durationMs, "number", "summary_done 应记录摘要请求耗时");
  assert.ok(
    summaryDone.durationMs >= 10,
    `summary_done.durationMs 应反映真实请求耗时（打桩延迟 15ms），实际 ${summaryDone.durationMs}`
  );
  assert.equal(typeof summaryDone.summaryChars, "number", "summary_done 应记录摘要字符数");
  assert.equal(summaryDone.summaryChars, "T8 摘要文本".length, "summaryChars 应等于摘要文本长度");

  // compact_done：总耗时与落盘消息数
  const doneEvent = logLines[indexOfType("compact_done")];
  assert.equal(typeof doneEvent.durationMs, "number", "compact_done 应记录压缩总耗时");
  assert.ok(doneEvent.durationMs >= summaryDone.durationMs, "compact_done 总耗时应不小于摘要请求耗时");
  assert.equal(typeof doneEvent.messageCount, "number", "compact_done 应记录落盘消息总数");
  // 事件序列表征测试：完整主对话循环会在 compact 之后同轮再发起一次主对话
  // 请求并追加 assistant/tool 消息（既有语义，见 usage 测试的 total_reqs 断言），
  // 因此 messageCount 断言"落盘时消息数 ≥ 压缩区间终点 + summary 消息"，
  // 精确落盘一致性由 CP-01c 直接调用 compactSession 验证
  assert.ok(
    doneEvent.messageCount >= doneEvent.rangeEnd + 1,
    `messageCount（${doneEvent.messageCount}）应至少覆盖压缩区间终点 + summary 消息（${doneEvent.rangeEnd + 1}）`
  );

  // 成功路径不应出现 summary_fail
  assert.equal(types.includes("summary_fail"), false, "成功压缩不应记录 summary_fail");
});

test("CP-01b summary request failure logs summary_fail and compact still throws original error (T8)", async () => {
  const workspace = createTempDir(env, "deepcode-compact-log-cp01b-workspace-");
  const home = createTempDir(env, "deepcode-compact-log-cp01b-home-");
  env.setHomeDir(home);

  const responses = [
    createChatResponse("large reply", {
      prompt_tokens: 139_990,
      completion_tokens: 10,
      total_tokens: 140_000,
    }),
  ];
  // 摘要请求抛错桩：验证 summary_fail 打点后错误按原语义继续传播（不吞不抛新行为）
  const failingLLMClient: LLMClient = {
    providerName: "openai",
    model: "test-model",
    baseURL: "https://api.deepseek.com",
    supportsThinking: true,
    supportsPromptCaching: false,
    createMessage: async (): Promise<LLMResponse> => {
      throw new Error("summary boom");
    },
    createMessageStream: async function* () {},
  };
  const manager = createMockedClientSessionManager(workspace, responses, {
    createLLMClient: () => failingLLMClient,
    autoCompactWindow: 131_072,
  });

  const sessionId = await manager.createSession({ text: "" });
  // compact 在 activateSession 内抛出 → 会话进入 failed 终态（既有语义），主循环不崩
  await manager.replySession(sessionId, { text: "" });

  const logLines = readCompactLogLines(home);
  const types = logLines.map((line) => line.type);
  assert.ok(types.includes("compact_start"), "应记录 compact_start");
  assert.ok(types.includes("summary_start"), "应记录 summary_start");
  const failIndex = types.indexOf("summary_fail");
  assert.ok(failIndex !== -1, "摘要失败应记录 summary_fail");
  assert.ok(types.indexOf("compact_start") < types.indexOf("summary_start"), "compact_start 应先于 summary_start");
  assert.ok(types.indexOf("summary_start") < failIndex, "summary_start 应先于 summary_fail");
  const failEvent = logLines[failIndex];
  assert.equal(typeof failEvent.durationMs, "number", "summary_fail 应记录失败前耗时");
  assert.ok(String(failEvent.error).includes("summary boom"), "summary_fail.error 应携带错误原文");
  assert.equal(types.includes("compact_done"), false, "摘要失败不应落 compact_done");
  // 原语义验证：compact 抛错导致会话 failed（错误未被日志层吞掉）
  assert.equal(manager.getSession(sessionId)?.status, "failed", "摘要失败错误应按原语义传播（会话 failed）");
});

test("CP-01c compactSession落盘完成事件 messageCount 与消息文件精确一致 (T8)", async () => {
  const workspace = createTempDir(env, "deepcode-compact-log-cp01c-workspace-");
  const home = createTempDir(env, "deepcode-compact-log-cp01c-home-");
  env.setHomeDir(home);

  const responses = [
    createChatResponse("large reply", {
      prompt_tokens: 139_990,
      completion_tokens: 10,
      total_tokens: 140_000,
    }),
  ];
  const compactRequests: LLMRequest[] = [];
  const compactLLMClient = createStubLLMClient([createLLMTextResponse("落盘一致性摘要")], compactRequests);
  const manager = createMockedClientSessionManager(workspace, responses, {
    createLLMClient: () => compactLLMClient,
    autoCompactWindow: 131_072,
  });

  const sessionId = await manager.createSession({ text: "" });
  // 直接调用 compactSession（不经过完整主对话循环），落盘后消息数不再变化，
  // 可精确断言 compact_done.messageCount === 落盘消息总数（与 CP-01 的
  // ≥ rangeEnd+1 下限断言互补，验证落盘事件字段的精确语义）
  await manager.compactSession(sessionId);

  assert.equal(compactRequests.length, 1, "应发起一次摘要请求");
  const logLines = readCompactLogLines(home);
  const types = logLines.map((line) => line.type);
  const doneEvent = logLines[types.lastIndexOf("compact_done")];
  assert.ok(doneEvent, "应记录 compact_done 事件");
  assert.equal(
    doneEvent.messageCount,
    manager.listSessionMessages(sessionId).length,
    "messageCount 应与落盘消息数精确一致"
  );
  assert.equal(logLines.filter((line) => line.type === "compact_done").length, 1, "直接调用应恰好落一条 compact_done");
});

test("CP-02 below-threshold session logs compact_skip and never starts summary request (T8)", async () => {
  const workspace = createTempDir(env, "deepcode-compact-log-cp02-workspace-");
  const home = createTempDir(env, "deepcode-compact-log-cp02-home-");
  env.setHomeDir(home);

  // 响应 usage 仅 42 token，远低于阈值 1000：自动触发点应记录 below-threshold 跳过
  const responses = [
    createChatResponse("small reply", {
      prompt_tokens: 40,
      completion_tokens: 2,
      total_tokens: 42,
    }),
  ];
  const compactRequests: LLMRequest[] = [];
  const compactLLMClient = createStubLLMClient([createLLMTextResponse("不应被请求")], compactRequests);
  const manager = createMockedClientSessionManager(workspace, responses, {
    createLLMClient: () => compactLLMClient,
    autoCompactWindow: 1_000,
  });

  const sessionId = await manager.createSession({ text: "" });
  await manager.replySession(sessionId, { text: "" });

  const logLines = readCompactLogLines(home);
  const skipEvents = logLines.filter((line) => line.type === "compact_skip");
  assert.ok(
    skipEvents.some(
      (line) => line.reason === "below-threshold" && line.threshold === 1_000 && line.tokensBefore === 42
    ),
    "低于阈值应记录 compact_skip（below-threshold，含 tokensBefore/threshold 观测字段）"
  );
  const types = logLines.map((line) => line.type);
  assert.equal(types.includes("compact_start"), false, "低于阈值不应记录 compact_start");
  assert.equal(types.includes("summary_start"), false, "低于阈值不应发起摘要请求打点");
  // 不发起摘要请求的硬断言：LLMClient 桩零调用 + 无 summary 消息
  assert.equal(compactRequests.length, 0, "低于阈值不应发起摘要 LLM 请求");
  const messages = manager.listSessionMessages(sessionId);
  assert.equal(
    messages.some((message) => message.meta?.isSummary === true),
    false,
    "低于阈值不应生成 summary 消息"
  );
});

test("SessionManager keeps usagePerModel null until response usage is available", async () => {
  const workspace = createTempDir(env, "deepcode-null-usage-per-model-workspace-");
  const home = createTempDir(env, "deepcode-null-usage-per-model-home-");
  env.setHomeDir(home);

  const manager = createMockedClientSessionManager(workspace, [{ choices: [{ message: { content: "no usage" } }] }]);

  const sessionId = await manager.createSession({ text: "" });

  assert.equal(manager.getSession(sessionId)?.usage, null);
  assert.equal(manager.getSession(sessionId)?.usagePerModel, null);
});

test("SessionManager accumulates response usage while active tokens track the latest response", async () => {
  const workspace = createTempDir(env, "deepcode-usage-workspace-");
  const home = createTempDir(env, "deepcode-usage-home-");
  env.setHomeDir(home);

  const responses = [
    createChatResponse("first", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 7 },
      completion_tokens_details: { reasoning_tokens: 3 },
      prompt_cache_hit_tokens: 7,
      prompt_cache_miss_tokens: 3,
    }),
    createChatResponse("second", {
      prompt_tokens: 20,
      completion_tokens: 7,
      total_tokens: 27,
      prompt_tokens_details: { cached_tokens: 11 },
      completion_tokens_details: { reasoning_tokens: 4 },
      prompt_cache_hit_tokens: 11,
      prompt_cache_miss_tokens: 9,
    }),
  ];
  const manager = createMockedClientSessionManager(workspace, responses);

  const sessionId = await manager.createSession({ text: "" });
  await manager.replySession(sessionId, { text: "" });

  const session = manager.getSession(sessionId);
  const usage = session?.usage as Record<string, any>;
  const usagePerModel = session?.usagePerModel?.["test-model"] as Record<string, any>;
  assert.equal(session?.activeTokens, 27);
  assert.equal(usage.prompt_tokens, 30);
  assert.equal(usage.completion_tokens, 12);
  assert.equal(usage.total_tokens, 42);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 18);
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 7);
  assert.equal(usage.prompt_cache_hit_tokens, 18);
  assert.equal(usage.prompt_cache_miss_tokens, 12);
  assert.equal(usagePerModel.prompt_tokens, 30);
  assert.equal(usagePerModel.completion_tokens, 12);
  assert.equal(usagePerModel.total_tokens, 42);
  assert.equal(usagePerModel.prompt_tokens_details.cached_tokens, 18);
  assert.equal(usagePerModel.completion_tokens_details.reasoning_tokens, 7);
  assert.equal(usagePerModel.prompt_cache_hit_tokens, 18);
  assert.equal(usagePerModel.prompt_cache_miss_tokens, 12);
  assert.equal(usagePerModel.total_reqs, 2);
});

test("SessionManager stores usage per model across model changes", async () => {
  const workspace = createTempDir(env, "deepcode-usage-per-model-workspace-");
  const home = createTempDir(env, "deepcode-usage-per-model-home-");
  env.setHomeDir(home);

  let currentModel = "deepseek-v4-pro";
  const responses = [
    createChatResponse("pro response", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    }),
    createChatResponse("flash response", {
      prompt_tokens: 20,
      completion_tokens: 7,
      total_tokens: 27,
      prompt_cache_hit_tokens: 6,
    }),
  ];
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
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: currentModel,
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: currentModel }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const sessionId = await manager.createSession({ text: "" });
  currentModel = "deepseek-v4-flash";
  await manager.replySession(sessionId, { text: "" });

  const session = manager.getSession(sessionId);
  assert.deepEqual(Object.keys(session?.usagePerModel ?? {}).sort(), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(session?.usagePerModel?.["deepseek-v4-pro"]?.prompt_tokens, 10);
  assert.equal(session?.usagePerModel?.["deepseek-v4-pro"]?.completion_tokens, 5);
  assert.equal(session?.usagePerModel?.["deepseek-v4-pro"]?.total_reqs, 1);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.prompt_tokens, 20);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.completion_tokens, 7);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.prompt_cache_hit_tokens, 6);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.total_reqs, 1);
  assert.equal(session?.usage?.prompt_tokens, 30);
  assert.equal(session?.usage?.completion_tokens, 12);
  assert.equal(session?.usage?.total_tokens, 42);
});

test("SessionManager resets active tokens to latest post-compaction response usage", async () => {
  const workspace = createTempDir(env, "deepcode-compact-usage-workspace-");
  const home = createTempDir(env, "deepcode-compact-usage-home-");
  env.setHomeDir(home);

  // B1：主对话流式通路仍消费 OpenAI 队列（createSession + compact 后 reply 各一次）；
  // compact 非流式调用改经 createLLMClient 桩消费独立响应队列
  const responses = [
    createChatResponse("large", {
      prompt_tokens: 139_990,
      completion_tokens: 10,
      total_tokens: 140_000,
    }),
    createChatResponse("after compact", {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    }),
  ];
  const compactRequests: LLMRequest[] = [];
  const compactLLMClient = createStubLLMClient(
    [createLLMTextResponse("summary", { inputTokens: 100, outputTokens: 23 })],
    compactRequests
  );
  // v1.3 D9：默认压缩比例 50% → 80% 后，140K 用量不再超过默认阈值（209715）；
  // 本用例验证压缩机制本身，显式固定阈值 131072（原 50% 语义）以保持触发场景
  const manager = createMockedClientSessionManager(workspace, responses, {
    createLLMClient: () => compactLLMClient,
    autoCompactWindow: 131_072,
  });

  const sessionId = await manager.createSession({ text: "" });
  assert.equal(manager.getSession(sessionId)?.activeTokens, 140_000);

  await manager.replySession(sessionId, { text: "" });

  // compact 调用经 provider 抽象层发起：恰好一次，请求为单条 user 消息
  assert.equal(compactRequests.length, 1);
  assert.equal(compactRequests[0]?.messages.length, 1);
  assert.equal(compactRequests[0]?.messages[0]?.role, "user");

  const session = manager.getSession(sessionId);
  const usage = session?.usage as Record<string, any>;
  const usagePerModel = session?.usagePerModel?.["test-model"] as Record<string, any>;
  assert.equal(session?.activeTokens, 7);
  assert.equal(usage.prompt_tokens, 140_095);
  assert.equal(usage.completion_tokens, 35);
  assert.equal(usage.total_tokens, 140_130);
  assert.equal(usagePerModel.prompt_tokens, 140_095);
  assert.equal(usagePerModel.completion_tokens, 35);
  assert.equal(usagePerModel.total_tokens, 140_130);
  assert.equal(usagePerModel.total_reqs, 3);
});

test("SessionManager compactSession writes summary message and marks earlier messages compacted (B1)", async () => {
  const workspace = createTempDir(env, "deepcode-compact-summary-workspace-");
  const home = createTempDir(env, "deepcode-compact-summary-home-");
  env.setHomeDir(home);

  const responses = [
    createChatResponse("large reply", {
      prompt_tokens: 139_990,
      completion_tokens: 10,
      total_tokens: 140_000,
    }),
    createChatResponse("after compact", {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    }),
  ];
  const compactRequests: LLMRequest[] = [];
  const compactLLMClient = createStubLLMClient(
    [createLLMTextResponse("对话要点总结", { inputTokens: 100, outputTokens: 23 })],
    compactRequests
  );
  // v1.3 D9：同上，显式固定阈值 131072 保持压缩触发场景
  const manager = createMockedClientSessionManager(workspace, responses, {
    createLLMClient: () => compactLLMClient,
    autoCompactWindow: 131_072,
  });

  const sessionId = await manager.createSession({ text: "" });
  await manager.replySession(sessionId, { text: "" });

  // 请求语义：thinkingEnabled 取自统一 settings 解析链（空 settings 下默认模型
  // deepseek-v4-pro → thinking 默认开启）；提示词含被压缩会话内容（原提示词构造逻辑不变）
  assert.equal(compactRequests.length, 1);
  assert.equal(compactRequests[0]?.thinkingEnabled, true);
  const compactPromptContent = compactRequests[0]?.messages[0]?.content;
  assert.equal(typeof compactPromptContent, "string");
  // 上一行 assert.equal 已在运行时保证 compactPromptContent 为 string，
  // 此处使用非空断言告知 TS 类型已收窄（避免 possibly undefined 编译错误）
  assert.ok(compactPromptContent!.includes("large reply"), "compact 提示词应包含会话内容");

  // 持久化语义：生成 isSummary 用户消息；其之前的消息全部标记 compacted
  // Qwen3 兼容修复：summaryMessage role 为 "user"（非 "system"），
  // 避免 flattenMidConversationSystemMessages 将其合并到开头 system 导致缺少 user query
  const messages = manager.listSessionMessages(sessionId);
  const summaryIndex = messages.findIndex((message) => message.meta?.isSummary === true);
  assert.ok(summaryIndex > 0, "应插入 summary 消息");
  assert.ok(messages[summaryIndex]?.content?.includes("对话要点总结"), "summary 消息携带 LLM 总结文本");
  assert.equal(messages[summaryIndex]?.role, "user", "summary 消息 role 应为 user（Qwen3 兼容）");
  for (let i = 0; i < summaryIndex; i += 1) {
    const message = messages[i];
    if (message.role === "system" && !message.meta?.isSummary) {
      continue; // startIndex 之前的 system 消息不参与压缩
    }
    assert.equal(message.compacted, true, `消息 ${message.id} 应被标记 compacted`);
  }
});

test("SessionManager compactSession silently skips when no LLM client credential is available (B1)", async () => {
  const workspace = createTempDir(env, "deepcode-compact-nocred-workspace-");
  const home = createTempDir(env, "deepcode-compact-nocred-home-");
  env.setHomeDir(home);

  const responses = [
    createChatResponse("large reply", {
      prompt_tokens: 139_990,
      completion_tokens: 10,
      total_tokens: 140_000,
    }),
    createChatResponse("without compact", {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    }),
  ];
  // createLLMClient 返回 null（无凭据）：compact 静默跳过，主对话继续
  const manager = createMockedClientSessionManager(workspace, responses, () => null);

  const sessionId = await manager.createSession({ text: "" });
  await manager.replySession(sessionId, { text: "" });

  // T8 联动断言：无凭据（createLLMClient 返回 null）时 compactSession 在入口即
  // 返回（不进入消息判定），落 compact_skip 事件（reason=no-llm-client）
  await manager.compactSession(sessionId);
  const logLines = readCompactLogLines(home);
  assert.ok(
    logLines.some((line) => line.type === "compact_skip" && line.reason === "no-llm-client"),
    "无凭据应记录 compact_skip（no-llm-client）事件"
  );

  const messages = manager.listSessionMessages(sessionId);
  assert.equal(
    messages.some((message) => message.meta?.isSummary === true),
    false,
    "不应生成 summary 消息"
  );
  assert.equal(
    messages.some((message) => message.compacted),
    false,
    "不应有消息被标记 compacted"
  );
  // 主对话未受 compact 跳过影响：assistant 正常回复
  assert.ok(messages.some((message) => message.role === "assistant" && message.content === "without compact"));
});

test("SessionManager streams chat completions and counts reasoning progress", async () => {
  const workspace = createTempDir(env, "deepcode-stream-workspace-");
  const home = createTempDir(env, "deepcode-stream-home-");
  env.setHomeDir(home);

  const progressEvents: Array<{
    phase: string;
    estimatedTokens: number;
    formattedTokens: string;
  }> = [];
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          assert.equal(request.stream, true);
          assert.deepEqual(request.stream_options, { include_usage: true });
          assert.equal(request.temperature, 0.25);
          return createChatStreamResponse([
            { choices: [{ delta: { reasoning_content: "思考" } }] },
            { choices: [{ delta: { content: "hello" } }] },
            {
              choices: [],
              usage: {
                prompt_tokens: 2,
                completion_tokens: 3,
                total_tokens: 5,
              },
            },
          ]);
        },
      },
    },
  };

  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      temperature: 0.25,
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onLlmStreamProgress: (progress) => {
      progressEvents.push({
        phase: progress.phase,
        estimatedTokens: progress.estimatedTokens,
        formattedTokens: progress.formattedTokens,
      });
    },
  });

  const sessionId = await manager.createSession({ text: "" });
  const assistantMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "assistant");

  assert.equal(assistantMessage?.content, "hello");
  assert.equal((assistantMessage?.messageParams as any)?.reasoning_content, "思考");
  assert.equal(manager.getSession(sessionId)?.activeTokens, 5);
  assert.deepEqual(
    progressEvents.map((event) => event.phase),
    ["start", "update", "update", "end"]
  );
  assert.equal(progressEvents[1]?.estimatedTokens, 1);
  assert.equal(progressEvents[2]?.formattedTokens, "3");
});

test("SessionManager persists session and user message before skill matching is cancelled", async () => {
  const workspace = createTempDir(env, "deepcode-skill-abort-workspace-");
  const home = createTempDir(env, "deepcode-skill-abort-home-");
  env.setHomeDir(home);

  const skillDir = path.join(home, ".agents", "skills", "demo");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\n# Demo\n", "utf8");

  // eslint-disable-next-line prefer-const -- must be declared before client which references it
  let manager: SessionManager;
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          assert.equal(request.temperature, 0.1);
          return new Promise((_resolve, reject) => {
            const signal = options?.signal;
            signal?.addEventListener("abort", () => reject(new APIUserAbortError()), { once: true });
            queueMicrotask(() => manager.interruptActiveSession());
          });
        },
      },
    },
  };

  manager = createMockedClientSessionManagerWithClient(workspace, client);

  await manager.handleUserPrompt({ text: "please use demo" });

  // Session and user message are persisted before skill matching triggers an abort.
  assert.equal(manager.listSessions().length, 1);
  const [session] = manager.listSessions();
  assert.equal(session?.status, "pending");
  const messages = manager.listSessionMessages(session!.id);
  const userMessage = messages.find((m) => m.role === "user");
  assert.equal(userMessage?.content, "please use demo");
});

test("SessionManager treats OpenAI APIUserAbortError as interrupted", async () => {
  const workspace = createTempDir(env, "deepcode-api-abort-workspace-");
  const home = createTempDir(env, "deepcode-api-abort-home-");
  env.setHomeDir(home);

  let manager: SessionManager;
  const client = {
    chat: {
      completions: {
        create: async (_request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            const signal = options?.signal;
            signal?.addEventListener("abort", () => reject(new APIUserAbortError()), { once: true });
          });
        },
      },
    },
  };

  // eslint-disable-next-line prefer-const -- declared before client, assigned after
  manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onSessionEntryUpdated: (entry) => {
      if (entry.status === "processing") {
        queueMicrotask(() => manager.interruptActiveSession());
      }
    },
  });

  await manager.handleUserPrompt({ text: "" });

  const activeSessionId = manager.getActiveSessionId();
  assert.ok(activeSessionId);
  const session = manager.getSession(activeSessionId);
  assert.equal(session?.status, "interrupted");
  assert.equal(session?.failReason, "interrupted");
});

test("SessionManager.deleteSession removes session entry from the index", () => {
  const workspace = createTempDir(env, "deepcode-delete-workspace-");
  const home = createTempDir(env, "deepcode-delete-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-delete");
  (manager as any).activateSession = async () => {};

  // Create two sessions
  const session1 = createSessionAndMessages(manager, "session-delete-1", "First session");
  const session2 = createSessionAndMessages(manager, "session-delete-2", "Second session");

  assert.equal(manager.listSessions().length, 2);

  // Delete the first session
  const result = manager.deleteSession(session1);
  assert.equal(result, true);

  const remaining = manager.listSessions();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.id, session2);
});

test("SessionManager.deleteSession removes the messages file", () => {
  const workspace = createTempDir(env, "deepcode-delete-msg-workspace-");
  const home = createTempDir(env, "deepcode-delete-msg-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-delete-msg");
  (manager as any).activateSession = async () => {};

  const sessionId = createSessionAndMessages(manager, "session-delete-msg", "Test session");
  const messagePath = path.join(home, ".deepcode", "projects", getProjectCode(workspace), `${sessionId}.jsonl`);

  // Verify messages file exists
  assert.ok(fs.existsSync(messagePath));

  manager.deleteSession(sessionId);

  // Verify messages file is removed
  assert.equal(fs.existsSync(messagePath), false);
});

test("SessionManager.deleteSession returns false when session does not exist", () => {
  const workspace = createTempDir(env, "deepcode-delete-nonexist-workspace-");
  const home = createTempDir(env, "deepcode-delete-nonexist-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-delete-nonexist");

  const result = manager.deleteSession("nonexistent-session-id");
  assert.equal(result, false);
  assert.equal(manager.listSessions().length, 0);
});

test("SessionManager.deleteSession does not affect other sessions", () => {
  const workspace = createTempDir(env, "deepcode-delete-others-workspace-");
  const home = createTempDir(env, "deepcode-delete-others-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-delete-others");
  (manager as any).activateSession = async () => {};

  const session1 = createSessionAndMessages(manager, "session-keep-1", "Keep session 1");
  const session2 = createSessionAndMessages(manager, "session-keep-2", "Keep session 2");

  // Delete non-existent session
  const result = manager.deleteSession("non-existent");
  assert.equal(result, false);
  assert.equal(manager.listSessions().length, 2);

  // Delete one session
  assert.equal(manager.deleteSession(session1), true);
  assert.equal(manager.listSessions().length, 1);
  assert.equal(manager.listSessions()[0]?.id, session2);

  // The remaining session should still have its messages accessible
  const messages = manager.listSessionMessages(session2);
  assert.ok(messages.length > 0);
});
