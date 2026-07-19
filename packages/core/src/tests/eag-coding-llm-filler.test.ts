/**
 * EAG-P2 批次 9 S4 单元测试：Phase B LLM 填充器（LlmFiller + InMemoryLLMClient）
 *
 * 测试范围：
 * - T1. LlmFiller 实例化与构造
 *   - T1a. 默认构造（无 logger）→ 实例化成功
 *   - T1b. 注入 logger → 实例化成功
 * - T2. fill 成功路径
 *   - T2a. 单占位 method-body → 填充成功
 *   - T2b. 多占位混合（method-body / class-body）→ 全部填充成功
 *   - T2c. 返回 LlmFillResult 含全部字段
 *   - T2d. durationMs >= 0
 * - T3. fill 占位跳过
 *   - T3a. import 占位 → 标记 skipped（不调 LLM）
 *   - T3b. config 占位 → 标记 skipped（不调 LLM）
 * - T4. fill 失败处理
 *   - T4a. JSON 解析失败 → 降级为代码块提取
 *   - T4b. 3 次调用都失败 → 标记 failed
 *   - T4c. LLM 调用抛异常 → 重试后失败
 *   - T4d. 单占位失败不影响其他占位
 * - T5. fill 重试机制
 *   - T5a. 单占位 1 次失败后第 2 次成功 → 标记 filled
 *   - T5b. 单占位 2 次失败后第 3 次成功 → 标记 filled
 *   - T5c. 单占位 3 次都失败 → 标记 failed
 * - T6. InMemoryLLMClient 行为
 *   - T6a. 默认构造使用 defaultResponseGenerator
 *   - T6b. 自定义 responseGenerator 注入
 *   - T6c. getCallCount 计数正确
 *   - T6d. getLastRequest 返回最近请求
 *   - T6e. reset 清空状态
 *   - T6f. createMessageStream 流式输出
 * - T7. defaultResponseGenerator 路由规则
 *   - T7a. create 工厂方法关键词 → 返回 create 实现
 *   - T7b. cancel/取消 关键词 → 返回 cancel 实现
 *   - T7c. update/更新 关键词 → 返回 update 实现
 *   - T7d. pay/支付 关键词 → 返回 pay 实现
 *   - T7e. Repository/仓储 关键词 → 返回 save/findById 实现
 *   - T7f. Saga 关键词 → 返回 execute 实现
 *   - T7g. 默认 → 返回通用方法体
 * - T8. LlmFillerError 错误类
 *   - T8a. invalid-request 错误
 *   - T8b. 错误消息格式正确
 * - T9. fill 多文件场景
 *   - T9a. 跨多文件占位 → 各自填充正确文件
 *   - T9b. 单文件多占位 → 顺序替换
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象（InMemoryLLMClient 真实实现 + 真实 ResponseGenerator 函数）
 * - 每个测试用例独立构造 fixture，避免相互依赖
 *
 * @module core/tests/eag-coding-llm-filler
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmFiller, LlmFillerError, InMemoryLLMClient, defaultResponseGenerator } from "../eag/coding/llm-filler";
import type { ResponseGenerator } from "../eag/coding/llm-filler";
import type {
  CodingContext,
  FillPlaceholder,
  GeneratedFile,
  LlmFillRequest,
  SkeletonGenerationResult,
} from "../eag/coding/types";
import type { LLMRequest, LLMResponse, LLMStreamEvent } from "../providers/llm-provider";
import type { RedlineDefinition } from "../eag/evaluator/types";
import type { TaskCard, ModuleSplit } from "../eag/doc-driven/types";

// ============================================================================
// 辅助函数：构造测试 fixture
// ============================================================================

/**
 * 构造测试用 RedlineDefinition
 *
 * @param overrides 覆盖字段
 * @returns 完整的 RedlineDefinition
 */
function createRedline(overrides: Partial<RedlineDefinition> = {}): RedlineDefinition {
  return {
    id: "E1",
    name: "测试红线",
    description: "测试用红线",
    severity: "blocker",
    checkMethod: "静态扫描",
    checkType: "static",
    fixGuidance: "修复建议",
    ...overrides,
  };
}

/**
 * 构造测试用 TaskCard
 *
 * @param overrides 覆盖字段
 * @returns 完整的 TaskCard
 */
function createTaskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: "T-001",
    title: "测试任务",
    requirementId: "F-001",
    dependencies: [],
    acceptanceCriteria: ["验收标准 1"],
    status: "in-progress",
    declaredSymbols: [],
    ...overrides,
  } as TaskCard;
}

/**
 * 构造测试用 ModuleSplit
 *
 * @param overrides 覆盖字段
 * @returns 完整的 ModuleSplit
 */
function createModuleSplit(overrides: Partial<ModuleSplit> = {}): ModuleSplit {
  return {
    moduleName: "TestModule",
    responsibility: "测试模块",
    dependsOn: [],
    keyFiles: [],
    ...overrides,
  };
}

/**
 * 构造测试用 CodingContext
 *
 * @param overrides 覆盖字段
 * @returns 完整的 CodingContext
 */
function createCodingContext(overrides: Partial<CodingContext> = {}): CodingContext {
  return {
    l1GlobalView: {},
    l2SemanticResults: [],
    l3BusinessKnowledge: {},
    tcsSpecs: [],
    rlisRules: [],
    enterpriseRedlines: [createRedline()],
    taskCard: createTaskCard(),
    moduleSplit: createModuleSplit(),
    ...overrides,
  } as CodingContext;
}

/**
 * 构造测试用 FillPlaceholder
 *
 * @param overrides 覆盖字段
 * @returns 完整的 FillPlaceholder
 */
function createPlaceholder(overrides: Partial<FillPlaceholder> = {}): FillPlaceholder {
  return {
    id: "PH-001",
    filePath: "src/test.ts",
    line: 10,
    kind: "method-body",
    description: "实现 create 工厂方法",
    expectedSignature: "static create(command: any): { aggregate: any; events: any[] }",
    ...overrides,
  };
}

/**
 * 构造测试用 GeneratedFile
 *
 * @param overrides 覆盖字段
 * @returns 完整的 GeneratedFile
 */
function createGeneratedFile(overrides: Partial<GeneratedFile> = {}): GeneratedFile {
  return {
    relativePath: "src/test.ts",
    content: `export class TestClass {
  // TODO(phase-b): 实现 create 工厂方法
  throw new Error("TODO(phase-b): 未实现");
}
`,
    kind: "aggregate",
    taskId: "T-001",
    requirementId: "F-001",
    ...overrides,
  };
}

/**
 * 构造测试用 SkeletonGenerationResult
 *
 * @param overrides 覆盖字段
 * @returns 完整的 SkeletonGenerationResult
 */
function createSkeleton(overrides: Partial<SkeletonGenerationResult> = {}): SkeletonGenerationResult {
  return {
    files: [createGeneratedFile()],
    templateVariables: {},
    fillPlaceholders: [createPlaceholder()],
    durationMs: 100,
    ...overrides,
  } as SkeletonGenerationResult;
}

/**
 * 构造测试用 LlmFillRequest
 *
 * @param overrides 覆盖字段
 * @returns 完整的 LlmFillRequest
 */
function createLlmFillRequest(overrides: Partial<LlmFillRequest> = {}): LlmFillRequest {
  return {
    skeleton: createSkeleton(),
    context: createCodingContext(),
    llmClient: new InMemoryLLMClient(),
    maxRounds: 3,
    maxTokensPerFile: 4000,
    ...overrides,
  } as LlmFillRequest;
}

/**
 * 构造自定义响应生成器：返回指定 JSON 内容
 *
 * 真实业务实现：根据传入的 files 数组生成对应的 JSON 响应。
 *
 * @param files 文件列表（path + content）
 * @returns ResponseGenerator 函数
 */
function createFixedResponseGenerator(files: Array<{ path: string; content: string }>): ResponseGenerator {
  return (_request: LLMRequest): LLMResponse => {
    const json = JSON.stringify({ files });
    return {
      content: json,
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    };
  };
}

/**
 * 构造失败响应生成器：始终抛出异常
 *
 * 真实业务实现：模拟 LLM 调用失败的场景（如网络异常、服务不可用）。
 *
 * @param errorMsg 异常消息
 * @returns ResponseGenerator 函数
 */
function createFailingResponseGenerator(errorMsg: string = "LLM 服务不可用"): ResponseGenerator {
  return (_request: LLMRequest): LLMResponse => {
    throw new Error(errorMsg);
  };
}

/**
 * 构造计数响应生成器：前 N 次失败，之后成功
 *
 * 真实业务实现：模拟 LLM 服务恢复过程（首次失败 → 重试成功）。
 *
 * @param failCount 失败次数
 * @param successContent 成功时的响应内容
 * @returns ResponseGenerator 函数
 */
function createRetryResponseGenerator(
  failCount: number,
  successContent: string
): ResponseGenerator & { getCallCount: () => number } {
  let callCount = 0;
  const generator = (_request: LLMRequest): LLMResponse => {
    callCount++;
    if (callCount <= failCount) {
      throw new Error(`第 ${callCount} 次调用失败（模拟临时故障）`);
    }
    return {
      content: successContent,
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    };
  };
  // 附加 getCallCount 方法便于测试断言
  (generator as ResponseGenerator & { getCallCount: () => number }).getCallCount = () => callCount;
  return generator as ResponseGenerator & { getCallCount: () => number };
}

/**
 * 构造代码块响应生成器：返回 markdown 代码块格式的内容
 *
 * 真实业务实现：模拟 LLM 返回非 JSON 但含代码块的场景，测试降级逻辑。
 *
 * @param codeBlock 代码块内容
 * @param lang 代码块语言标识（typescript/ts/空）
 * @returns ResponseGenerator 函数
 */
function createCodeBlockResponseGenerator(codeBlock: string, lang: string = "typescript"): ResponseGenerator {
  return (_request: LLMRequest): LLMResponse => {
    const content = "以下是实现：\n\n```" + lang + "\n" + codeBlock + "\n```\n";
    return {
      content,
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    };
  };
}

// ============================================================================
// T1. LlmFiller 实例化与构造
// ============================================================================

test("T1a. 默认构造（无 logger）→ 实例化成功", () => {
  const filler = new LlmFiller();
  assert.ok(filler instanceof LlmFiller);
});

test("T1b. 注入 logger → 实例化成功", () => {
  const logs: Array<{ message: string; level: string }> = [];
  const logger = (message: string, level: "info" | "warn" | "error" = "info") => {
    logs.push({ message, level });
  };
  const filler = new LlmFiller(logger);
  assert.ok(filler instanceof LlmFiller);
});

// ============================================================================
// T2. fill 成功路径
// ============================================================================

test("T2a. 单占位 method-body → 填充成功", async () => {
  const llmClient = new InMemoryLLMClient();
  const request = createLlmFillRequest({ llmClient });
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  assert.ok(result.fillStatus.length > 0);
  assert.equal(result.fillStatus[0].status, "filled");
});

test("T2b. 多占位混合（method-body / class-body）→ 全部填充成功", async () => {
  const skeleton = createSkeleton({
    files: [
      createGeneratedFile({
        relativePath: "src/order.ts",
        content: `export class Order {
  // TODO(phase-b): 实现 create 工厂方法
  throw new Error("TODO(phase-b): 未实现");
}
`,
      }),
      createGeneratedFile({
        relativePath: "src/user.ts",
        content: `export class User {
  // TODO(phase-b): 实现 User 类体字段
  throw new Error("TODO(phase-b): 未实现");
}
`,
        kind: "aggregate",
      }),
    ],
    fillPlaceholders: [
      createPlaceholder({
        id: "PH-001",
        filePath: "src/order.ts",
        description: "实现 create 工厂方法",
      }),
      createPlaceholder({
        id: "PH-002",
        filePath: "src/user.ts",
        kind: "class-body",
        description: "实现 User 类体字段",
      }),
    ],
  });
  const request = createLlmFillRequest({ skeleton });
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  assert.equal(result.fillStatus.length, 2);
  assert.equal(result.fillStatus[0].status, "filled");
  assert.equal(result.fillStatus[1].status, "filled");
});

test("T2c. 返回 LlmFillResult 含全部字段", async () => {
  const request = createLlmFillRequest();
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  assert.ok(Array.isArray(result.filledFiles));
  assert.ok(Array.isArray(result.fillStatus));
  assert.equal(typeof result.llmCallCount, "number");
  assert.equal(typeof result.totalTokensUsed, "number");
  assert.equal(typeof result.durationMs, "number");
});

test("T2d. durationMs >= 0", async () => {
  const request = createLlmFillRequest();
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  assert.ok(result.durationMs >= 0);
});

// ============================================================================
// T3. fill 占位跳过
// ============================================================================

test("T3a. import 占位 → 标记 skipped（不调 LLM）", async () => {
  const skeleton = createSkeleton({
    files: [createGeneratedFile()],
    fillPlaceholders: [
      createPlaceholder({
        id: "PH-001",
        kind: "import",
        description: "导入 OSS 模块",
      }),
    ],
  });
  const llmClient = new InMemoryLLMClient();
  const request = createLlmFillRequest({ skeleton, llmClient });
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  assert.equal(result.fillStatus[0].status, "skipped");
  // 验证未调用 LLM
  assert.equal(llmClient.getCallCount(), 0);
});

test("T3b. config 占位 → 标记 skipped（不调 LLM）", async () => {
  const skeleton = createSkeleton({
    files: [createGeneratedFile()],
    fillPlaceholders: [
      createPlaceholder({
        id: "PH-001",
        kind: "config",
        description: "配置依赖注入",
      }),
    ],
  });
  const llmClient = new InMemoryLLMClient();
  const request = createLlmFillRequest({ skeleton, llmClient });
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  assert.equal(result.fillStatus[0].status, "skipped");
  assert.equal(llmClient.getCallCount(), 0);
});

// ============================================================================
// T4. fill 失败处理
// ============================================================================

test("T4a. JSON 解析失败 → 降级为代码块提取", async () => {
  // 构造 LLM 返回非 JSON 内容（含代码块）
  const validCode = `export class TestClass {
  static create() {
    return new TestClass();
  }
}`;
  const generator = createCodeBlockResponseGenerator(validCode, "typescript");
  const llmClient = new InMemoryLLMClient(generator);
  const request = createLlmFillRequest({ llmClient });
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  // 降级成功 → 标记 filled
  assert.equal(result.fillStatus[0].status, "filled");
  // 验证内容确实包含提取的代码
  assert.ok(result.filledFiles[0].content.includes("static create"));
});

test("T4b. 3 次调用都失败 → 标记 failed", async () => {
  const generator = createFailingResponseGenerator("LLM 服务不可用");
  const llmClient = new InMemoryLLMClient(generator);
  const request = createLlmFillRequest({ llmClient });
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  assert.equal(result.fillStatus[0].status, "failed");
  // 验证调用次数为 3（maxRounds=3）
  assert.equal(llmClient.getCallCount(), 3);
});

test("T4c. LLM 调用抛异常 → 重试后失败", async () => {
  const generator = createFailingResponseGenerator("网络异常");
  const llmClient = new InMemoryLLMClient(generator);
  const request = createLlmFillRequest({ llmClient });
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  assert.equal(result.fillStatus[0].status, "failed");
  assert.ok(result.fillStatus[0].summary.includes("LLM 调用异常"));
});

test("T4d. 单占位失败不影响其他占位", async () => {
  // 第一个占位失败（generator 抛异常），第二个占位成功
  let callCount = 0;
  const generator: ResponseGenerator = (request: LLMRequest): LLMResponse => {
    callCount++;
    const userMessage = request.messages.find((m) => m.role === "user");
    const userContent = userMessage?.content ?? "";
    if (userContent.includes("PH-FAIL")) {
      throw new Error("模拟失败");
    }
    return {
      content: JSON.stringify({
        files: [{ path: "src/test.ts", content: "export class Success {}" }],
      }),
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  };
  const llmClient = new InMemoryLLMClient(generator);
  const skeleton = createSkeleton({
    files: [
      createGeneratedFile({
        relativePath: "src/fail.ts",
        content: `export class Fail {
  // TODO(phase-b): PH-FAIL 实现
  throw new Error("TODO(phase-b): 未实现");
}
`,
      }),
      createGeneratedFile({
        relativePath: "src/success.ts",
        content: `export class Success {
  // TODO(phase-b): 实现成功方法
  throw new Error("TODO(phase-b): 未实现");
}
`,
      }),
    ],
    fillPlaceholders: [
      createPlaceholder({
        id: "PH-FAIL",
        filePath: "src/fail.ts",
        description: "PH-FAIL 实现",
      }),
      createPlaceholder({
        id: "PH-SUCCESS",
        filePath: "src/success.ts",
        description: "实现成功方法",
      }),
    ],
  });
  const request = createLlmFillRequest({ skeleton, llmClient });
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  assert.equal(result.fillStatus.length, 2);
  assert.equal(result.fillStatus[0].status, "failed");
  assert.equal(result.fillStatus[1].status, "filled");
});

// ============================================================================
// T5. fill 重试机制
// ============================================================================

test("T5a. 单占位 1 次失败后第 2 次成功 → 标记 filled", async () => {
  const successContent = JSON.stringify({
    files: [{ path: "src/test.ts", content: "export class Retry { static create() {} }" }],
  });
  const generator = createRetryResponseGenerator(1, successContent);
  const llmClient = new InMemoryLLMClient(generator);
  const request = createLlmFillRequest({ llmClient });
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  assert.equal(result.fillStatus[0].status, "filled");
  // 验证调用次数为 2（1 次失败 + 1 次成功）
  assert.equal(generator.getCallCount(), 2);
});

test("T5b. 单占位 2 次失败后第 3 次成功 → 标记 filled", async () => {
  const successContent = JSON.stringify({
    files: [{ path: "src/test.ts", content: "export class Retry { static create() {} }" }],
  });
  const generator = createRetryResponseGenerator(2, successContent);
  const llmClient = new InMemoryLLMClient(generator);
  const request = createLlmFillRequest({ llmClient });
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  assert.equal(result.fillStatus[0].status, "filled");
  // 验证调用次数为 3（2 次失败 + 1 次成功）
  assert.equal(generator.getCallCount(), 3);
});

test("T5c. 单占位 3 次都失败 → 标记 failed", async () => {
  const successContent = JSON.stringify({
    files: [{ path: "src/test.ts", content: "export class Retry {}" }],
  });
  const generator = createRetryResponseGenerator(3, successContent);
  const llmClient = new InMemoryLLMClient(generator);
  const request = createLlmFillRequest({ llmClient });
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  assert.equal(result.fillStatus[0].status, "failed");
  // 验证调用次数为 3（maxRounds 上限）
  assert.equal(generator.getCallCount(), 3);
});

// ============================================================================
// T6. InMemoryLLMClient 行为
// ============================================================================

test("T6a. 默认构造使用 defaultResponseGenerator", async () => {
  const client = new InMemoryLLMClient();
  // 构造含 "create 工厂方法" 的 prompt，验证默认生成器路由
  const request: LLMRequest = {
    messages: [
      {
        id: "1",
        sessionId: "s1",
        role: "user",
        content: "占位描述：实现 create 工厂方法",
        contentParams: null,
        messageParams: null,
        compacted: false,
        visible: false,
        createTime: new Date().toISOString(),
        updateTime: new Date().toISOString(),
      },
    ],
    thinkingEnabled: false,
  };
  const response = await client.createMessage(request);
  assert.ok(response.content.includes("files"));
  assert.ok(response.content.includes("static create"));
});

test("T6b. 自定义 responseGenerator 注入", async () => {
  const customGenerator: ResponseGenerator = (_req: LLMRequest): LLMResponse => ({
    content: "自定义响应",
    thinking: "",
    toolCalls: [],
    stopReason: "stop",
    usage: null,
  });
  const client = new InMemoryLLMClient(customGenerator);
  const response = await client.createMessage({
    messages: [],
    thinkingEnabled: false,
  });
  assert.equal(response.content, "自定义响应");
});

test("T6c. getCallCount 计数正确", async () => {
  const client = new InMemoryLLMClient();
  assert.equal(client.getCallCount(), 0);
  await client.createMessage({ messages: [], thinkingEnabled: false });
  assert.equal(client.getCallCount(), 1);
  await client.createMessage({ messages: [], thinkingEnabled: false });
  assert.equal(client.getCallCount(), 2);
});

test("T6d. getLastRequest 返回最近请求", async () => {
  const client = new InMemoryLLMClient();
  assert.equal(client.getLastRequest(), null);
  const req: LLMRequest = {
    messages: [
      {
        id: "1",
        sessionId: "s1",
        role: "user",
        content: "测试请求",
        contentParams: null,
        messageParams: null,
        compacted: false,
        visible: false,
        createTime: new Date().toISOString(),
        updateTime: new Date().toISOString(),
      },
    ],
    thinkingEnabled: false,
  };
  await client.createMessage(req);
  const lastRequest = client.getLastRequest();
  assert.ok(lastRequest !== null);
  assert.equal(lastRequest.messages[0].content, "测试请求");
});

test("T6e. reset 清空状态", async () => {
  const client = new InMemoryLLMClient();
  await client.createMessage({ messages: [], thinkingEnabled: false });
  assert.equal(client.getCallCount(), 1);
  assert.ok(client.getLastRequest() !== null);
  client.reset();
  assert.equal(client.getCallCount(), 0);
  assert.equal(client.getLastRequest(), null);
});

test("T6f. createMessageStream 流式输出", async () => {
  const client = new InMemoryLLMClient();
  const events: LLMStreamEvent[] = [];
  const stream = client.createMessageStream({ messages: [], thinkingEnabled: false });
  for await (const event of stream) {
    events.push(event);
  }
  // 至少产出 text_delta 与 message_end 两个事件
  assert.ok(events.length >= 2);
  assert.equal(events[0].type, "text_delta");
  // 最后一个事件应为 message_end
  const lastEvent = events[events.length - 1];
  assert.equal(lastEvent.type, "message_end");
});

// ============================================================================
// T7. defaultResponseGenerator 路由规则
// ============================================================================

/**
 * 构造含指定占位描述的 LLMRequest
 *
 * @param description 占位描述
 * @param filePath 文件路径（默认 "src/test.ts"）
 * @returns LLMRequest
 */
function buildRequestWithDescription(description: string, filePath: string = "src/test.ts"): LLMRequest {
  return {
    messages: [
      {
        id: "1",
        sessionId: "s1",
        role: "user",
        content: `## 当前要填充的占位
- 占位描述：${description}
## 骨架代码（文件：${filePath}）
\`\`\`typescript
// placeholder
\`\`\``,
        contentParams: null,
        messageParams: null,
        compacted: false,
        visible: false,
        createTime: new Date().toISOString(),
        updateTime: new Date().toISOString(),
      },
    ],
    thinkingEnabled: false,
  };
}

test("T7a. create 工厂方法关键词 → 返回 create 实现", () => {
  const request = buildRequestWithDescription("实现 create 工厂方法");
  const response = defaultResponseGenerator(request);
  const parsed = JSON.parse(response.content);
  assert.ok(parsed.files[0].content.includes("static create"));
  assert.ok(parsed.files[0].content.includes("Created"));
});

test("T7b. cancel/取消 关键词 → 返回 cancel 实现", () => {
  const request = buildRequestWithDescription("实现 cancel 取消业务方法");
  const response = defaultResponseGenerator(request);
  const parsed = JSON.parse(response.content);
  assert.ok(parsed.files[0].content.includes("cancel"));
  assert.ok(parsed.files[0].content.includes("Cancelled"));
});

test("T7c. update/更新 关键词 → 返回 update 实现", () => {
  const request = buildRequestWithDescription("实现 update 更新业务方法");
  const response = defaultResponseGenerator(request);
  const parsed = JSON.parse(response.content);
  assert.ok(parsed.files[0].content.includes("update"));
  assert.ok(parsed.files[0].content.includes("Updated"));
});

test("T7d. pay/支付 关键词 → 返回 pay 实现", () => {
  const request = buildRequestWithDescription("实现 pay 支付业务方法");
  const response = defaultResponseGenerator(request);
  const parsed = JSON.parse(response.content);
  assert.ok(parsed.files[0].content.includes("pay"));
  assert.ok(parsed.files[0].content.includes("Paid"));
});

test("T7e. Repository/仓储 关键词 → 返回 save/findById 实现", () => {
  const request = buildRequestWithDescription("实现 Repository 仓储 save");
  const response = defaultResponseGenerator(request);
  const parsed = JSON.parse(response.content);
  assert.ok(parsed.files[0].content.includes("save"));
  assert.ok(parsed.files[0].content.includes("findById"));
});

test("T7f. Saga 关键词 → 返回 execute 实现", () => {
  const request = buildRequestWithDescription("实现 Saga 编排器");
  const response = defaultResponseGenerator(request);
  const parsed = JSON.parse(response.content);
  assert.ok(parsed.files[0].content.includes("execute"));
});

test("T7g. 默认 → 返回通用方法体", () => {
  const request = buildRequestWithDescription("未知业务方法");
  const response = defaultResponseGenerator(request);
  const parsed = JSON.parse(response.content);
  assert.ok(parsed.files[0].content.includes("execute"));
});

// ============================================================================
// T8. LlmFillerError 错误类
// ============================================================================

test("T8a. invalid-request 错误 - skeleton 字段非法", async () => {
  const invalidRequest = createLlmFillRequest({
    skeleton: { files: "not-array" as unknown as GeneratedFile[] } as SkeletonGenerationResult,
  });
  const filler = new LlmFiller();
  await assert.rejects(
    () => filler.fill(invalidRequest),
    (err: unknown) => {
      assert.ok(err instanceof LlmFillerError);
      assert.equal((err as LlmFillerError).kind, "invalid-request");
      return true;
    }
  );
});

test("T8b. invalid-request 错误 - maxRounds 字段非法", async () => {
  const invalidRequest = createLlmFillRequest({
    maxRounds: 0,
  });
  const filler = new LlmFiller();
  await assert.rejects(
    () => filler.fill(invalidRequest),
    (err: unknown) => {
      assert.ok(err instanceof LlmFillerError);
      assert.equal((err as LlmFillerError).kind, "invalid-request");
      assert.ok((err as Error).message.includes("maxRounds"));
      return true;
    }
  );
});

test("T8c. invalid-request 错误 - llmClient 字段非法", async () => {
  const invalidRequest = createLlmFillRequest({
    llmClient: { notCreateMessage: true } as unknown as InMemoryLLMClient,
  });
  const filler = new LlmFiller();
  await assert.rejects(
    () => filler.fill(invalidRequest),
    (err: unknown) => {
      assert.ok(err instanceof LlmFillerError);
      assert.equal((err as LlmFillerError).kind, "invalid-request");
      assert.ok((err as Error).message.includes("llmClient"));
      return true;
    }
  );
});

test("T8d. 错误消息格式正确", () => {
  const err = new LlmFillerError("invalid-request", "测试详情");
  assert.equal(err.name, "LlmFillerError");
  assert.ok(err.message.includes("invalid-request"));
  assert.ok(err.message.includes("测试详情"));
});

// ============================================================================
// T9. fill 多文件场景
// ============================================================================

test("T9a. 跨多文件占位 → 各自填充正确文件", async () => {
  const skeleton = createSkeleton({
    files: [
      createGeneratedFile({
        relativePath: "src/order.ts",
        content: `export class Order {
  // TODO(phase-b): 实现 create 工厂方法
  throw new Error("TODO(phase-b): 未实现");
}
`,
      }),
      createGeneratedFile({
        relativePath: "src/user.ts",
        content: `export class User {
  // TODO(phase-b): 实现 update 业务方法
  throw new Error("TODO(phase-b): 未实现");
}
`,
        kind: "aggregate",
      }),
    ],
    fillPlaceholders: [
      createPlaceholder({
        id: "PH-001",
        filePath: "src/order.ts",
        description: "实现 create 工厂方法",
      }),
      createPlaceholder({
        id: "PH-002",
        filePath: "src/user.ts",
        description: "实现 update 业务方法",
      }),
    ],
  });
  const request = createLlmFillRequest({ skeleton });
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  // 两个占位都填充成功
  assert.equal(result.fillStatus[0].status, "filled");
  assert.equal(result.fillStatus[1].status, "filled");
  // 验证两个文件都被更新
  const orderFile = result.filledFiles.find((f) => f.relativePath === "src/order.ts");
  const userFile = result.filledFiles.find((f) => f.relativePath === "src/user.ts");
  assert.ok(orderFile !== undefined);
  assert.ok(userFile !== undefined);
  // 验证内容含 create / update 关键字
  assert.ok(orderFile.content.includes("static create") || orderFile.content.includes("create"));
  assert.ok(userFile.content.includes("update"));
});

test("T9b. 单文件多占位 → 顺序替换", async () => {
  const skeleton = createSkeleton({
    files: [
      createGeneratedFile({
        relativePath: "src/test.ts",
        content: `export class Test {
  // TODO(phase-b): 实现 create 工厂方法
  throw new Error("TODO(phase-b): 未实现");

  // TODO(phase-b): 实现 cancel 取消业务方法
  throw new Error("TODO(phase-b): 未实现");
}
`,
      }),
    ],
    fillPlaceholders: [
      createPlaceholder({
        id: "PH-001",
        filePath: "src/test.ts",
        description: "实现 create 工厂方法",
      }),
      createPlaceholder({
        id: "PH-002",
        filePath: "src/test.ts",
        description: "实现 cancel 取消业务方法",
      }),
    ],
  });
  const request = createLlmFillRequest({ skeleton });
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  // 两个占位都填充成功
  assert.equal(result.fillStatus[0].status, "filled");
  assert.equal(result.fillStatus[1].status, "filled");
  // 验证文件被更新
  assert.equal(result.filledFiles.length, 1);
  assert.equal(result.filledFiles[0].relativePath, "src/test.ts");
});

// ============================================================================
// T10. 不可变优先与配置冻结
// ============================================================================

test("T10a. fill 返回的 LlmFillResult 不可变（Object.isFrozen）", async () => {
  const request = createLlmFillRequest();
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  assert.ok(Object.isFrozen(result), "LlmFillResult 应被冻结");
  assert.ok(Object.isFrozen(result.filledFiles), "filledFiles 应被冻结");
  assert.ok(Object.isFrozen(result.fillStatus), "fillStatus 应被冻结");
});

test("T10b. fill 返回的 GeneratedFile 不可变", async () => {
  const request = createLlmFillRequest();
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  for (const file of result.filledFiles) {
    assert.ok(Object.isFrozen(file), "GeneratedFile 应被冻结");
  }
});

test("T10c. fill 返回的 FillStatus 不可变", async () => {
  const request = createLlmFillRequest();
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  for (const status of result.fillStatus) {
    assert.ok(Object.isFrozen(status), "FillStatus 应被冻结");
  }
});

test("T10d. llmCallCount 累计正确（含重试）", async () => {
  // 1 个占位，3 次重试都失败 → llmCallCount=3
  const generator = createFailingResponseGenerator();
  const llmClient = new InMemoryLLMClient(generator);
  const request = createLlmFillRequest({ llmClient });
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  assert.equal(result.llmCallCount, 3);
});

test("T10e. totalTokensUsed 累计正确（含估算）", async () => {
  // LLM 调用成功，但返回的 usage 为 null → 使用 estimateTokens 估算
  const customGenerator: ResponseGenerator = (_req: LLMRequest): LLMResponse => ({
    content: JSON.stringify({ files: [{ path: "src/test.ts", content: "export class T {}" }] }),
    thinking: "",
    toolCalls: [],
    stopReason: "stop",
    usage: null, // 显式 null 触发估算
  });
  const llmClient = new InMemoryLLMClient(customGenerator);
  const request = createLlmFillRequest({ llmClient });
  const filler = new LlmFiller();
  const result = await filler.fill(request);
  assert.ok(result.totalTokensUsed > 0);
});

// ============================================================================
// T11. logger 注入验证
// ============================================================================

test("T11a. logger 在填充成功时输出 info 级别日志", async () => {
  const logs: Array<{ message: string; level: string }> = [];
  const logger = (message: string, level: "info" | "warn" | "error" = "info") => {
    logs.push({ message, level });
  };
  const request = createLlmFillRequest();
  const filler = new LlmFiller(logger);
  await filler.fill(request);
  // 至少有启动日志与完成日志
  assert.ok(logs.length > 0);
  const infoLogs = logs.filter((l) => l.level === "info");
  assert.ok(infoLogs.length > 0);
});

test("T11b. logger 在填充失败时输出 warn 级别日志", async () => {
  const logs: Array<{ message: string; level: string }> = [];
  const logger = (message: string, level: "info" | "warn" | "error" = "info") => {
    logs.push({ message, level });
  };
  const generator = createFailingResponseGenerator();
  const llmClient = new InMemoryLLMClient(generator);
  const request = createLlmFillRequest({ llmClient });
  const filler = new LlmFiller(logger);
  await filler.fill(request);
  const warnLogs = logs.filter((l) => l.level === "warn");
  assert.ok(warnLogs.length > 0);
});
