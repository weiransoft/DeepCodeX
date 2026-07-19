/**
 * E2E 测试生成器（E2eTestGenerator）—— EAG-P3 批次 10 §4.3
 *
 * 职责：
 * - 基于 PKC L3 K2 业务流程图 + 用户故事，调用 LLM 生成端到端测试代码
 * - 每个验收标准至少 1 个 E2E 场景（对齐 §5.2.4 评估器判定）
 *
 * 关键技术决策（对齐 §4.3.2）：
 * - K2 流程图置信度过滤：仅消费 confidence=documented/verified
 *   inferred 流程转 HUMAN_CHECKPOINT 队列由用户确认
 * - 用户故事来源：spec.md 中 F-NNN 验收标准 + LLM 推断组合
 * - 测试框架：Node.js 内置 node:test（零新增依赖）
 * - 步骤到断言映射：LLM 生成 + 静态校验
 *   每步骤 ≥1 断言；expectedOutput 字段强制映射为断言
 * - 状态机断言：强制 stateTransition 字段断言
 *
 * 不可变优先原则：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 工厂函数返回冻结对象
 *
 * @module eag/testing/e2e-test-generator
 */

// ============================================================================
// 1. 外部依赖与类型导入
// ============================================================================

import { z } from "zod";
import type { LLMClient, LLMRequest, LLMResponse } from "../../providers/llm-provider";
import type { SessionMessage } from "../../session";
import type {
  AcceptanceCriterion,
  E2eFlowConfidence,
  E2eTestSpec,
  GeneratedTestFile,
  LogCallback,
  PkcAccessor,
} from "./types";
import {
  DEFAULT_E2E_TEST_OUTPUT_DIR,
  DEFAULT_MAX_TOKENS_PER_TEST_FILE,
  DEFAULT_MAX_TOKENS_PER_TEST_LLM_CALL,
  DEFAULT_TEST_GENERATION_TEMPERATURE,
  E2E_FLOW_CONFIDENCES,
} from "./types";

// ============================================================================
// 2. 常量定义
// ============================================================================

/**
 * 默认 E2E 测试模板注册表
 *
 * 与 contract-test-generator 对齐设计，使用内置模板字符串生成骨架。
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 */
const DEFAULT_E2E_TEST_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  "e2e-test-default": [
    "/**",
    " * E2E 测试：{{flowName}}",
    " *",
    " * 自动生成：EAG-P3 批次 10 E2eTestGenerator",
    " * 关联需求：{{requirementId}}",
    " */",
    "",
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    "",
    'test("should complete flow: {{flowName}}", async () => {',
    "  // TODO: 由 LLM 填充具体步骤与断言",
    "  assert.ok(true);",
    "});",
  ].join("\n"),
});

/**
 * E2E 流程置信度过滤白名单
 *
 * 仅消费 documented / verified，inferred 转 HUMAN_CHECKPOINT。
 * 对齐 §4.3.2 "K2 流程图置信度过滤"决策。
 */
const ACCEPTED_CONFIDENCES: ReadonlyArray<E2eFlowConfidence> = Object.freeze(["documented", "verified"]);

// ============================================================================
// 3. 自定义错误类
// ============================================================================

/**
 * E2E 测试生成器错误基类
 */
export class E2eTestGeneratorError extends Error {
  /**
   * @param kind 错误类型（pkc-query / llm-format / assertion-missing / state-transition-missing）
   * @param message 错误消息
   * @param cause 原始错误（可选）
   */
  constructor(
    public readonly kind: "pkc-query" | "llm-format" | "assertion-missing" | "state-transition-missing",
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "E2eTestGeneratorError";
  }
}

// ============================================================================
// 4. 请求与产出类型定义
// ============================================================================

/**
 * E2E 测试生成请求
 *
 * 对应设计文档 §4.3.3 E2eTestGenerationRequest。
 * 字段全部 readonly——请求一经组装即不可变。
 */
export interface E2eTestGenerationRequest {
  /** 项目根目录（绝对路径） */
  readonly projectRoot: string;
  /** LLM 客户端 */
  readonly llmClient: LLMClient;
  /** PKC 知识库访问器（查询 K2 业务流程图） */
  readonly pkcAccessor: PkcAccessor;
  /** 验收标准列表（从 spec.md 解析） */
  readonly acceptanceCriteria: ReadonlyArray<AcceptanceCriterion>;
  /** 输出目录（相对 projectRoot，默认 "tests/e2e/"） */
  readonly outputDir: string;
  /** 单文件最大 token 上限（默认 4000） */
  readonly maxTokensPerFile: number;
}

/**
 * E2E 测试生成产出
 *
 * 含生成的测试文件列表 + 需人工确认的流程列表（inferred 置信度）。
 */
export interface E2eTestGenerationResult {
  /** 生成的 E2E 测试文件列表 */
  readonly testFiles: ReadonlyArray<GeneratedTestFile>;
  /** 需人工确认的流程列表（confidence=inferred） */
  readonly humanCheckpointFlows: ReadonlyArray<E2eTestSpec>;
}

// ============================================================================
// 5. E2eTestGenerator 实现
// ============================================================================

/**
 * E2E 测试生成器
 *
 * 算法（对齐 §4.3.3）：
 * 1. 从 pkcAccessor.queryBusinessFlows() 获取 K2 业务流程图（E2eTestSpec[]）
 * 2. 过滤 confidence=inferred 的流程 → 转 HUMAN_CHECKPOINT 队列
 * 3. 对每个 documented/verified 流程：
 *    a. 装配 LLM prompt（流程步骤 + 用户故事 + 验收标准 + 风险热点）
 *    b. 调用 LLM 生成 E2E 测试代码（JSON 模式）
 *    c. 静态校验：每步骤 ≥1 断言 + stateTransition 字段强制断言
 *    d. 用 zod schema 校验生成代码结构
 * 4. 返回 E2eTestGenerationResult（含 testFiles + humanCheckpointFlows）
 */
export class E2eTestGenerator {
  /**
   * 初始化 E2E 测试生成器
   *
   * @param templateRegistry 测试模板注册表（默认使用内置 e2e-test-template）
   * @param logger 日志回调（可选）
   */
  constructor(
    private readonly templateRegistry: Readonly<Record<string, string>> = DEFAULT_E2E_TEST_TEMPLATES,
    private readonly logger?: LogCallback
  ) {}

  /**
   * 生成 E2E 测试
   *
   * @param request 生成请求
   * @returns 生成结果（含测试文件列表 + 需人工确认的流程列表）
   * @throws {E2eTestGeneratorError} LLM 生成格式非法或步骤-断言映射失败
   */
  async generate(request: Readonly<E2eTestGenerationRequest>): Promise<E2eTestGenerationResult> {
    this.log("开始生成 E2E 测试", "info");

    // 1. 校验请求字段
    this.validateRequest(request);

    // 2. 从 PKC 查询 K2 业务流程图
    let flows: ReadonlyArray<E2eTestSpec>;
    try {
      flows = await request.pkcAccessor.queryBusinessFlows(request.projectRoot);
    } catch (e) {
      throw new E2eTestGeneratorError(
        "pkc-query",
        `查询 K2 业务流程图失败：${e instanceof Error ? e.message : String(e)}`,
        e
      );
    }

    this.log(`获取到 ${flows.length} 个业务流程图`, "info");

    // 3. 过滤 confidence=inferred 的流程 → 转 HUMAN_CHECKPOINT 队列
    const humanCheckpointFlows: E2eTestSpec[] = [];
    const acceptedFlows: E2eTestSpec[] = [];

    for (const flow of flows) {
      if (ACCEPTED_CONFIDENCES.includes(flow.confidence)) {
        acceptedFlows.push(flow);
      } else {
        // inferred 流程转 HUMAN_CHECKPOINT
        humanCheckpointFlows.push(flow);
        this.log(`流程 "${flow.flowName}" 置信度为 ${flow.confidence}，转 HUMAN_CHECKPOINT`, "warn");
      }
    }

    this.log(`已接受 ${acceptedFlows.length} 个流程，${humanCheckpointFlows.length} 个流程转 HUMAN_CHECKPOINT`, "info");

    // 4. 对每个 documented/verified 流程生成 E2E 测试
    const testFiles: GeneratedTestFile[] = [];
    for (const flow of acceptedFlows) {
      try {
        const testFile = await this.generateSingleTest(flow, request);
        testFiles.push(testFile);
      } catch (e) {
        // 单个流程生成失败：记录错误并继续处理其他流程（fail-soft 策略）
        const errorMsg = e instanceof Error ? e.message : String(e);
        this.log(`生成 E2E 测试失败：${flow.flowName} - ${errorMsg}`, "error");

        // 若是 LLM 格式或断言映射错误，向上抛出（避免静默失败）
        if (e instanceof E2eTestGeneratorError) {
          throw e;
        }
      }
    }

    this.log(`E2E 测试生成完成，共 ${testFiles.length} 个文件`, "info");

    // 5. 组装并冻结产出
    return Object.freeze({
      testFiles: Object.freeze(testFiles),
      humanCheckpointFlows: Object.freeze(humanCheckpointFlows),
    }) as E2eTestGenerationResult;
  }

  /**
   * 校验请求字段合法性
   *
   * @param request 生成请求
   * @throws {E2eTestGeneratorError} 字段非法时抛出
   */
  private validateRequest(request: Readonly<E2eTestGenerationRequest>): void {
    if (typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new E2eTestGeneratorError("pkc-query", "projectRoot 必须为非空字符串");
    }
    if (!request.llmClient || typeof request.llmClient.createMessage !== "function") {
      throw new E2eTestGeneratorError("pkc-query", "llmClient 必须实现 LLMClient 接口");
    }
    if (!request.pkcAccessor || typeof request.pkcAccessor.queryBusinessFlows !== "function") {
      throw new E2eTestGeneratorError("pkc-query", "pkcAccessor 必须实现 PkcAccessor 接口");
    }
    if (!Array.isArray(request.acceptanceCriteria)) {
      throw new E2eTestGeneratorError("pkc-query", "acceptanceCriteria 必须为数组");
    }
    if (typeof request.outputDir !== "string" || request.outputDir.trim().length === 0) {
      throw new E2eTestGeneratorError("pkc-query", "outputDir 必须为非空字符串");
    }
    if (typeof request.maxTokensPerFile !== "number" || request.maxTokensPerFile < 1) {
      throw new E2eTestGeneratorError("pkc-query", "maxTokensPerFile 必须为 ≥1 的数字");
    }
  }

  /**
   * 为单个业务流程生成 E2E 测试文件
   *
   * 算法：
   * 1. 装配 LLM prompt（system + user 消息）
   * 2. 调用 llmClient.createMessage() 生成测试代码
   * 3. 解析 LLM 响应（JSON 模式）
   * 4. 静态校验：每步骤 ≥1 断言 + stateTransition 强制断言
   * 5. 转换为 GeneratedTestFile
   *
   * @param flow 业务流程图
   * @param request 生成请求
   * @returns 生成的测试文件
   */
  private async generateSingleTest(
    flow: E2eTestSpec,
    request: Readonly<E2eTestGenerationRequest>
  ): Promise<GeneratedTestFile> {
    // 1. 装配 LLM prompt
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(flow, request.acceptanceCriteria);

    // 2. 构造 LLMRequest
    const llmRequest: LLMRequest = this.buildLlmRequest(systemPrompt, userPrompt, request.maxTokensPerFile);

    // 3. 调用 LLM
    let response: LLMResponse;
    try {
      response = await request.llmClient.createMessage(llmRequest);
    } catch (e) {
      throw new E2eTestGeneratorError(
        "llm-format",
        `LLM 调用失败：${flow.flowName} - ${e instanceof Error ? e.message : String(e)}`,
        e
      );
    }

    // 4. 解析 LLM 响应
    const generatedContent = this.parseLlmResponse(response, flow);

    // 5. 静态校验：每步骤 ≥1 断言
    this.validateAssertionsPerStep(generatedContent, flow);

    // 6. 静态校验：stateTransition 强制断言
    this.validateStateTransitionAssertions(generatedContent, flow);

    // 7. 提取测试用例描述
    const testCaseDescriptions = this.extractTestCaseDescriptions(generatedContent, flow);

    // 8. 统计测试用例数
    const testCaseCount = this.countTestCases(generatedContent);

    // 9. 构建文件路径
    const relativePath = this.buildTestFilePath(flow, request.outputDir);

    // 10. 组装并冻结 GeneratedTestFile
    return Object.freeze({
      relativePath,
      content: generatedContent,
      kind: "e2e" as const,
      requirementId: flow.requirementId,
      sourceId: flow.flowId,
      testCaseCount,
      testCaseDescriptions: Object.freeze([...testCaseDescriptions]),
    }) as GeneratedTestFile;
  }

  /**
   * 构建 LLM system prompt
   *
   * 对齐 §4.3.4 Prompt 装配策略：
   * - 角色定义：测试专家
   * - 测试框架约束：node:test + node:assert/strict
   * - 输出格式约束：JSON 模式
   * - 强制断言规则：每步骤 ≥1 断言；stateTransition 必须断言
   *
   * @returns system prompt 字符串
   */
  private buildSystemPrompt(): string {
    return [
      "你是测试专家，遵循测试金字塔与契约优先原则。",
      "",
      "测试框架约束：",
      "- 使用 Node.js 内置 node:test + node:assert/strict",
      "- 禁止引入 Jest / Mocha / Chai 等第三方测试框架",
      "- 每个 it/test 用例必须含至少 1 个 assert/expect 断言",
      "",
      "输出格式约束：",
      '- 必须返回 JSON 格式：{ "files": [{ "path": "...", "content": "..." }] }',
      "- path 字段为文件相对路径（如 tests/e2e/order-flow.e2e.test.ts）",
      "- content 字段为完整 TypeScript 测试代码（含 import / describe / it / 断言）",
      "- content 中的换行符使用 \\n 转义",
      "",
      "强制断言规则：",
      "- 每个流程步骤必须对应至少 1 个 assert/expect 断言",
      "- stateTransition 字段必须断言（状态机错误是 DDD 系统最常见 bug）",
      "- expectedOutput 字段必须映射为断言",
      "- 用户故事 Given/When/Then 必须全部覆盖",
    ].join("\n");
  }

  /**
   * 构建 LLM user prompt
   *
   * 对齐 §4.3.4 User 消息装配：
   * - K2 业务流程图（节点 + 边 + 状态转换）
   * - 用户故事（Gherkin）
   * - 验收标准（F-NNN）
   * - 输出 JSON schema 约束
   *
   * @param flow 业务流程图
   * @param acceptanceCriteria 验收标准列表
   * @returns user prompt 字符串
   */
  private buildUserPrompt(flow: E2eTestSpec, acceptanceCriteria: ReadonlyArray<AcceptanceCriterion>): string {
    const lines: string[] = [
      "请为以下业务流程生成 E2E 测试：",
      "",
      "## 流程信息",
      `- 流程 ID：${flow.flowId}`,
      `- 流程名称：${flow.flowName}`,
      `- 关联需求：${flow.requirementId}`,
      `- 置信度：${flow.confidence}`,
      "",
      "## 用户故事",
      "```gherkin",
      flow.userStory,
      "```",
      "",
      "## 流程步骤",
    ];

    for (const step of flow.steps) {
      lines.push(
        `### 步骤 ${step.order}`,
        `- 执行者：${step.actor}`,
        `- 动作：${step.action}`,
        `- 输入：${JSON.stringify(step.input)}`,
        `- 期望输出：${JSON.stringify(step.expectedOutput)}`
      );
      if (step.stateTransition) {
        lines.push(`- 状态转换：${step.stateTransition}`);
      }
      lines.push("");
    }

    // 关联验收标准
    const relatedCriteria = acceptanceCriteria.filter((c) => c.requirementId === flow.requirementId);
    if (relatedCriteria.length > 0) {
      lines.push("## 关联验收标准（必须覆盖）");
      for (const criterion of relatedCriteria) {
        lines.push(`- ${criterion.requirementId} (${criterion.moduleName})：${criterion.description}`);
      }
      lines.push("");
    }

    lines.push(
      "## 输出要求",
      "返回 JSON 格式：",
      "```json",
      '{ "files": [{ "path": "tests/e2e/xxx.e2e.test.ts", "content": "..." }] }',
      "```",
      "",
      "content 字段要求：",
      "- 完整的 TypeScript 测试代码",
      "- 使用 node:test 与 node:assert/strict",
      "- 每个流程步骤对应至少 1 个 it/test 节点",
      "- stateTransition 字段必须断言",
      "- expectedOutput 字段必须映射为断言"
    );

    return lines.join("\n");
  }

  /**
   * 构建 LLMRequest
   *
   * @param systemPrompt system 消息内容
   * @param userPrompt user 消息内容
   * @param maxTokensPerFile 单文件最大 token 上限
   * @returns LLMRequest 对象
   */
  private buildLlmRequest(systemPrompt: string, userPrompt: string, maxTokensPerFile: number): LLMRequest {
    const now = new Date().toISOString();
    const sessionId = `e2e-test-${Date.now()}`;

    const systemMessage: SessionMessage = {
      id: `msg-system-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      role: "system",
      content: systemPrompt,
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    };

    const userMessage: SessionMessage = {
      id: `msg-user-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      role: "user",
      content: userPrompt,
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    };

    return {
      messages: [systemMessage, userMessage],
      thinkingEnabled: false,
      maxTokens: Math.min(maxTokensPerFile, DEFAULT_MAX_TOKENS_PER_TEST_LLM_CALL),
      temperature: DEFAULT_TEST_GENERATION_TEMPERATURE,
    };
  }

  /**
   * 解析 LLM 响应（JSON 模式）
   *
   * @param response LLM 响应
   * @param flow 业务流程图（用于错误消息）
   * @returns 生成的测试代码内容
   * @throws {E2eTestGeneratorError} LLM 响应格式非法
   */
  private parseLlmResponse(response: LLMResponse, flow: E2eTestSpec): string {
    if (!response || typeof response.content !== "string") {
      throw new E2eTestGeneratorError("llm-format", `LLM 响应格式非法（content 非字符串）：${flow.flowName}`);
    }

    const content = response.content.trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new E2eTestGeneratorError(
        "llm-format",
        `LLM 响应 JSON 解析失败：${flow.flowName} - ${e instanceof Error ? e.message : String(e)}`,
        e
      );
    }

    const responseSchema = z.object({
      files: z
        .array(
          z.object({
            path: z.string().min(1),
            content: z.string(),
          })
        )
        .min(1),
    });

    const validationResult = responseSchema.safeParse(parsed);
    if (!validationResult.success) {
      throw new E2eTestGeneratorError(
        "llm-format",
        `LLM 响应结构校验失败：${flow.flowName} - ${validationResult.error.message}`,
        validationResult.error
      );
    }

    const firstFile = validationResult.data.files[0];
    return firstFile.content.replace(/\\n/g, "\n");
  }

  /**
   * 静态校验：每步骤 ≥1 断言
   *
   * 算法：
   * 1. 统计生成的测试代码中的 assert/expect 断言数
   * 2. 比对流程步骤数：断言数 ≥ 步骤数 → 通过
   * 3. 否则抛出 assertion-missing 错误
   *
   * @param content 生成的测试代码
   * @param flow 业务流程图
   * @throws {E2eTestGeneratorError} 断言数不足
   */
  private validateAssertionsPerStep(content: string, flow: E2eTestSpec): void {
    const assertionCount = this.countAssertions(content);
    const stepCount = flow.steps.length;

    if (assertionCount < stepCount) {
      throw new E2eTestGeneratorError(
        "assertion-missing",
        `E2E 测试 "${flow.flowName}" 的断言数 ${assertionCount} 小于步骤数 ${stepCount}——` +
          `每个流程步骤必须对应至少 1 个 assert/expect 断言`
      );
    }
  }

  /**
   * 静态校验：stateTransition 强制断言
   *
   * 算法：
   * 1. 收集流程中所有非空 stateTransition 字段
   * 2. 对每个 stateTransition（如 "pending→paid"），检查测试代码中是否出现该状态字符串
   * 3. 若任一 stateTransition 未被断言引用 → 抛出 state-transition-missing 错误
   *
   * @param content 生成的测试代码
   * @param flow 业务流程图
   * @throws {E2eTestGeneratorError} stateTransition 未被断言
   */
  private validateStateTransitionAssertions(content: string, flow: E2eTestSpec): void {
    const stateTransitions = flow.steps
      .map((s) => s.stateTransition)
      .filter((st): st is string => typeof st === "string" && st.length > 0);

    if (stateTransitions.length === 0) {
      // 流程无 stateTransition 字段，跳过校验
      return;
    }

    const missingTransitions: string[] = [];
    for (const transition of stateTransitions) {
      // 检查测试代码中是否引用了该状态转换字符串
      // 简化判定：直接检查 transition 字符串是否在测试代码中出现
      // 或拆分为前后状态分别检查（如 "pending→paid" → 检查 "pending" 与 "paid"）
      const states = transition.split(/[→\->]+/).map((s) => s.trim());
      const allStatesReferenced = states.every(
        (state) => content.includes(`"${state}"`) || content.includes(`'${state}'`)
      );

      if (!allStatesReferenced) {
        missingTransitions.push(transition);
      }
    }

    if (missingTransitions.length > 0) {
      throw new E2eTestGeneratorError(
        "state-transition-missing",
        `E2E 测试 "${flow.flowName}" 中以下 stateTransition 未被断言引用：` +
          `${missingTransitions.join(", ")}——状态机错误是 DDD 系统最常见 bug，必须断言`
      );
    }
  }

  /**
   * 统计测试代码中的断言调用数
   *
   * @param content 测试代码内容
   * @returns 断言调用数
   */
  private countAssertions(content: string): number {
    const lines = content.split(/\r?\n/);
    let count = 0;

    for (const line of lines) {
      // 跳过注释行
      if (/^\s*\/\//.test(line)) continue;
      if (/^\s*\*/.test(line)) continue;

      // 匹配 assert.* / expect.* 调用
      const matches = line.match(/\b(?:assert|expect)\b\s*(?:\.\w+)*\s*\(/g);
      if (matches) {
        count += matches.length;
      }
    }

    return count;
  }

  /**
   * 从生成的测试代码提取测试用例描述
   *
   * @param content 测试代码内容
   * @param flow 业务流程图（用于兜底描述）
   * @returns 测试用例描述列表
   */
  private extractTestCaseDescriptions(content: string, flow: E2eTestSpec): string[] {
    const descriptions: string[] = [];
    const lines = content.split(/\r?\n/);

    const testCaseRe = /\b(?:it|test)\b(?:\.(?:skip|todo|only))?\s*\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/;

    for (const line of lines) {
      if (/^\s*\/\//.test(line)) continue;
      if (/^\s*\*/.test(line)) continue;

      const m = line.match(testCaseRe);
      if (m) {
        const desc = m[1] ?? m[2] ?? m[3] ?? "";
        if (desc.length > 0) {
          descriptions.push(desc);
        }
      }
    }

    // 兜底：若无提取到描述，使用流程步骤作为描述
    if (descriptions.length === 0) {
      for (const step of flow.steps) {
        descriptions.push(`步骤 ${step.order}: ${step.action}`);
      }
    }

    return descriptions;
  }

  /**
   * 统计测试代码中的 it/test 节点数
   *
   * @param content 测试代码内容
   * @returns 测试用例数
   */
  private countTestCases(content: string): number {
    const lines = content.split(/\r?\n/);
    let count = 0;

    const testCaseRe = /^\s*\b(it|test)\b(\.(?:skip|todo|only))?\s*\(/;

    for (const line of lines) {
      if (/^\s*\/\//.test(line)) continue;
      if (/^\s*\*/.test(line)) continue;

      if (testCaseRe.test(line)) {
        count++;
      }
    }

    return count;
  }

  /**
   * 构建测试文件相对路径
   *
   * @param flow 业务流程图
   * @param outputDir 输出目录
   * @returns 测试文件相对路径
   */
  private buildTestFilePath(flow: E2eTestSpec, outputDir: string): string {
    // 将 flowId 转换为文件名片段
    const flowFragment = flow.flowId
      .replace(/[^A-Za-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();

    const normalizedDir = outputDir.replace(/\/$/, "");
    return `${normalizedDir}/${flowFragment}.e2e.test.ts`;
  }

  /**
   * 日志回调
   *
   * @param message 日志消息
   * @param level 日志级别（默认 info）
   */
  private log(message: string, level: "info" | "warn" | "error" = "info"): void {
    if (this.logger) {
      this.logger(message, level);
    }
  }
}

// ============================================================================
// 6. 工厂函数
// ============================================================================

/**
 * 创建默认 E2E 测试生成器实例
 *
 * @param logger 日志回调（可选）
 * @returns E2eTestGenerator 实例
 */
export function createDefaultE2eTestGenerator(logger?: LogCallback): E2eTestGenerator {
  return new E2eTestGenerator(DEFAULT_E2E_TEST_TEMPLATES, logger);
}

// ============================================================================
// 7. 常量与默认值重导出
// ============================================================================

export { DEFAULT_E2E_TEST_TEMPLATES };

export {
  DEFAULT_E2E_TEST_OUTPUT_DIR,
  DEFAULT_MAX_TOKENS_PER_TEST_FILE,
  DEFAULT_TEST_GENERATION_TEMPERATURE,
  E2E_FLOW_CONFIDENCES,
} from "./types";
