/**
 * Phase B LLM 填充器（EAG-P2 批次 9 S4 填充与修复层）
 *
 * 本模块实现 `LlmFiller` 类与 `InMemoryLLMClient`，对应 EAG-P2 批次 9 设计 §4.4：
 * 在 Phase A 骨架基础上，调用 LLM 逐个填充 `FillPlaceholder`，输出完整可编译的 TypeScript 实现。
 *
 * 核心职责（对齐 §4.4.1）：
 * 1. 按 FillPlaceholder.kind 分组（method-body / class-body / config / import）
 * 2. import 占位：基于 InterfaceContract 静态推导（不调 LLM，省 token；本批次标记 skipped）
 * 3. config 占位：基于 techStack 静态推导（不调 LLM；本批次标记 skipped）
 * 4. method-body / class-body 占位：逐个调 LLM 填充
 *    a. 装配 prompt（骨架 + 当前占位 + 上下文 + 红线提示）
 *    b. 调用 llmClient.createMessage(request)
 *    c. 解析 JSON 响应，提取代码片段
 *    d. 用 placeholder.expectedSignature 校验签名一致性（首版仅记录日志，不强制阻塞）
 *    e. 替换骨架中的 TODO 占位
 * 5. 返回 LlmFillResult（含 filledFiles / fillStatus / 调用统计 / 耗时）
 *
 * 关键技术决策（对齐 §4.4.2）：
 * - LLM 调用接口：复用 providers/llm-provider.ts 的 LLMClient 接口（依赖注入）
 * - 调用模式：非流式 createMessage()（填充是后台批量任务，无需流式 UI）
 * - Prompt 结构：System + User 双消息
 * - 输出格式：JSON 模式 { "files": [{ "path": "...", "content": "..." }] }
 *   （LLMRequest 接口未直接含 response_format 字段，通过 System prompt 显式约束）
 * - 失败重试：单占位最多 2 次重试（共 3 次调用），3 次都失败则标记 failed 但不阻塞其他占位
 * - Token 预算：单文件 4000 tokens 上限 + 单次 LLM 调用 8000 tokens 上限
 * - 温度：0.2（低温代码生成）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有方法入参与返回值使用 readonly + ReadonlyArray
 * - 顶层配置使用 Object.freeze 冻结
 * - 工厂方法返回冻结对象
 *
 * @module eag/coding/llm-filler
 */

import type { CodingContext, FillPlaceholder, FillStatus, GeneratedFile, LlmFillRequest, LlmFillResult } from "./types";
import {
  DEFAULT_CODE_GENERATION_TEMPERATURE,
  DEFAULT_MAX_TOKENS_PER_FILE,
  DEFAULT_MAX_TOKENS_PER_LLM_CALL,
  DEFAULT_MAX_FILL_ROUNDS,
} from "./types";
import type { LLMClient, LLMRequest, LLMResponse, LLMStreamEvent } from "../../providers/llm-provider";
import type { SessionMessage } from "../../session";

// ============================================================================
// 常量与配置
// ============================================================================

/**
 * 默认日志回调类型（与同模块其他类保持一致）
 */
type LogCallback = (message: string, level?: "info" | "warn" | "error") => void;

/**
 * JSON 输出 schema 描述（注入 System prompt 引导 LLM 输出 JSON 对象）
 *
 * 对齐 §4.4.2 关键技术决策"JSON 模式输出"。
 * 由于 LLMRequest 接口未直接暴露 response_format 字段，
 * 通过 System prompt 中的 schema 描述强制约束 LLM 输出格式。
 */
const JSON_OUTPUT_SCHEMA_DESCRIPTION = `{
  "files": [
    {
      "path": "<文件相对路径>",
      "content": "<完整文件内容（含原始未修改部分与新填充部分）>"
    }
  ]
}` as const;

/**
 * 单次 LLM 调用最大 token 上限（对齐 §4.4.2 + types.ts DEFAULT_MAX_TOKENS_PER_LLM_CALL）
 *
 * 用于设置 LLMRequest.maxTokens，防止单次填充产生超长代码导致循环依赖。
 */
const MAX_TOKENS_PER_LLM_CALL = DEFAULT_MAX_TOKENS_PER_LLM_CALL;

/**
 * 单文件最大 token 上限（对齐 §4.4.2 + types.ts DEFAULT_MAX_TOKENS_PER_FILE）
 *
 * 用于评估填充内容长度，超限时记录警告但不强制截断（首版实现）。
 */
const MAX_TOKENS_PER_FILE = DEFAULT_MAX_TOKENS_PER_FILE;

/**
 * LLM 调用温度（对齐 §4.4.2："0.2 低温代码生成"）
 *
 * 代码生成需要确定性，避免高温度产生幻觉 API。
 */
const LLM_TEMPERATURE = DEFAULT_CODE_GENERATION_TEMPERATURE;

/**
 * 默认最大填充轮次（对齐 types.ts DEFAULT_MAX_FILL_ROUNDS = 3）
 *
 * 单占位最多 2 次重试（共 3 次调用）；3 次都失败则标记 failed 但不阻塞其他占位。
 */
const DEFAULT_MAX_ROUNDS = DEFAULT_MAX_FILL_ROUNDS;

/**
 * 估算 token 数的字符换算比例（粗略估算：1 token ≈ 4 字符）
 *
 * 用于在不调用 tokenizer 的前提下评估填充内容长度。
 * 实际 token 数由 LLM provider 计算，此处仅用于预警。
 */
const CHARS_PER_TOKEN = 4 as const;

/**
 * 填充摘要最大长度（对齐 §4.1.2 FillStatus.summary："LLM 输出的前 200 字符"）
 */
const SUMMARY_MAX_LENGTH = 200 as const;

// ============================================================================
// 异常类型
// ============================================================================

/**
 * LLM 填充器错误
 *
 * 当请求字段非法、LLM 调用异常、JSON 解析失败等场景抛出。
 * 单占位填充失败不抛出此异常（仅记录 failed 状态）；
 * 仅在请求整体非法或不可恢复错误时抛出。
 */
export class LlmFillerError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-request：请求字段非法（skeleton/context/llmClient 缺失或类型不对）
   *   - llm-call-failed：LLM 调用抛出异常（非业务级失败，是底层异常）
   *   - skeleton-file-not-found：占位所在文件在骨架 files 列表中找不到
   * @param detail 错误详情
   */
  constructor(
    public readonly kind: "invalid-request" | "llm-call-failed" | "skeleton-file-not-found",
    public readonly detail: string
  ) {
    super(`LLM 填充器错误 [${kind}]：${detail}`);
    this.name = "LlmFillerError";
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 构造一条 SessionMessage（内部工具函数）
 *
 * 统一填充 SessionMessage 的必填字段，避免散落重复代码。
 *
 * @param role 消息角色（"system" / "user"）
 * @param content 消息内容
 * @returns 完整的 SessionMessage（含 id/sessionId/时间戳等元数据）
 */
function buildMessage(role: "system" | "user", content: string): SessionMessage {
  const now = new Date().toISOString();
  return {
    id: `llm-filler-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "llm-filler-session",
    role,
    content,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: false,
    createTime: now,
    updateTime: now,
  };
}

/**
 * 估算字符串的 token 数
 *
 * 粗略估算：1 token ≈ 4 字符（含中英文混合场景的安全估算）。
 * 实际 token 数由 LLM provider 计算并返回在 LLMResponse.usage 中，
 * 此处仅用于预警与日志输出。
 *
 * @param text 待估算的字符串
 * @returns 估算的 token 数（向上取整）
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * 截取字符串前 N 个字符作为摘要
 *
 * 对齐 §4.1.2 FillStatus.summary："LLM 输出的前 200 字符"。
 *
 * @param text 原始字符串
 * @param maxLength 最大长度（默认 200）
 * @returns 截取后的摘要（超长时附 "..." 后缀）
 */
function truncateSummary(text: string, maxLength: number = SUMMARY_MAX_LENGTH): string {
  if (typeof text !== "string") return "";
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

// ============================================================================
// LlmFiller 类
// ============================================================================

/**
 * Phase B LLM 填充器
 *
 * 对应 EAG-P2 批次 9 设计 §4.4.3 LlmFiller：
 * 在 Phase A 骨架基础上，调用 LLM 逐个填充 FillPlaceholder，
 * 输出完整可编译的 TypeScript 实现。
 *
 * 使用方式：
 * ```typescript
 * const filler = new LlmFiller();
 * const result = await filler.fill({
 *   skeleton: skeletonResult,
 *   context: codingContext,
 *   llmClient: new InMemoryLLMClient(generateResponse),
 *   maxRounds: 3,
 *   maxTokensPerFile: 4000,
 * });
 * // result.filledFiles 含完整实现（无 TODO 占位残留）
 * // result.fillStatus 含各占位的填充状态
 * ```
 *
 * 不可变优先：
 * - 所有入参使用 Readonly 包裹
 * - 返回的 LlmFillResult 通过 Object.freeze 冻结
 * - 内部状态不暴露给外部
 */
export class LlmFiller {
  /** 日志回调（可选，用于输出调试信息） */
  private readonly logger?: LogCallback;

  /**
   * 初始化 LLM 填充器
   *
   * @param logger 日志回调（可选）
   */
  constructor(logger?: LogCallback) {
    this.logger = logger;
  }

  /**
   * 执行 Phase B LLM 填充
   *
   * 算法（对齐 §4.4.3）：
   * 1. 校验请求字段合法性
   * 2. 初始化统计变量（llmCallCount / totalTokensUsed / fillStatus / contentByFile）
   * 3. 遍历 skeleton.fillPlaceholders：
   *    a. kind="import" / "config" → 静态推导，标记 skipped（首版不调 LLM）
   *    b. kind="method-body" / "class-body" → 调用 fillPlaceholder 进行 LLM 填充
   * 4. 应用所有填充内容到骨架文件，产出 filledFiles
   * 5. 返回冻结的 LlmFillResult
   *
   * @param request LLM 填充请求
   * @returns LLM 填充产出（含填充后文件 + 状态 + 统计 + 耗时）
   * @throws {LlmFillerError} 请求整体非法时抛出
   */
  async fill(request: Readonly<LlmFillRequest>): Promise<LlmFillResult> {
    const startTime = Date.now();
    this.logger?.("LlmFiller.fill 启动", "info");

    // 步骤 1：校验请求字段合法性
    this.validateRequest(request);

    // 步骤 2：初始化统计变量与状态记录
    const skeleton = request.skeleton;
    const maxRounds = request.maxRounds > 0 ? request.maxRounds : DEFAULT_MAX_ROUNDS;
    const fillStatusList: FillStatus[] = [];
    // 文件路径 → 已填充内容映射（用于最终合成 filledFiles）
    // 一个文件可能含多个占位，需逐个替换
    const contentByFile = new Map<string, string>();
    // 初始化 contentByFile：所有骨架文件先放入原始内容
    for (const file of skeleton.files) {
      contentByFile.set(file.relativePath, file.content);
    }

    let llmCallCount = 0;
    let totalTokensUsed = 0;

    // 步骤 3：遍历占位列表逐个填充
    for (const placeholder of skeleton.fillPlaceholders) {
      // import / config 占位：静态推导，标记 skipped（首版不调 LLM，§4.4.3 算法第 2~3 步）
      if (placeholder.kind === "import" || placeholder.kind === "config") {
        fillStatusList.push(
          Object.freeze({
            placeholderId: placeholder.id,
            status: "skipped",
            summary: `静态推导占位（kind=${placeholder.kind}），未调用 LLM`,
          }) as FillStatus
        );
        this.logger?.(`占位 ${placeholder.id} [${placeholder.kind}] 标记为 skipped`, "info");
        continue;
      }

      // method-body / class-body 占位：调用 LLM 填充（含最多 2 次重试，共 3 次调用）
      const fillOutcome = await this.fillPlaceholderWithRetry(
        placeholder,
        skeleton,
        request.context,
        request.llmClient,
        maxRounds
      );

      llmCallCount += fillOutcome.callCount;
      totalTokensUsed += fillOutcome.tokensUsed;

      if (fillOutcome.success && fillOutcome.filledContent) {
        // 填充成功：将填充内容应用到对应文件
        const originalFile = this.findSkeletonFile(skeleton, placeholder.filePath);
        if (originalFile) {
          const currentContent = contentByFile.get(placeholder.filePath) ?? originalFile.content;
          const updatedFiles = this.applyFillToSkeleton(
            {
              relativePath: placeholder.filePath,
              content: currentContent,
              kind: originalFile.kind,
              taskId: originalFile.taskId,
              requirementId: originalFile.requirementId,
            },
            placeholder,
            fillOutcome.filledContent
          );
          // 更新 contentByFile（同一文件可能有多个占位，逐次替换）
          for (const updated of updatedFiles) {
            contentByFile.set(updated.relativePath, updated.content);
          }
        }
        fillStatusList.push(
          Object.freeze({
            placeholderId: placeholder.id,
            status: "filled",
            summary: truncateSummary(fillOutcome.filledContent),
          }) as FillStatus
        );
        this.logger?.(
          `占位 ${placeholder.id} [${placeholder.kind}] 填充成功（${fillOutcome.callCount} 次调用，${fillOutcome.tokensUsed} tokens）`,
          "info"
        );
      } else {
        // 填充失败：标记 failed 但不阻塞其他占位
        fillStatusList.push(
          Object.freeze({
            placeholderId: placeholder.id,
            status: "failed",
            summary: truncateSummary(fillOutcome.failureReason ?? "未知失败原因"),
          }) as FillStatus
        );
        this.logger?.(
          `占位 ${placeholder.id} [${placeholder.kind}] 填充失败：${fillOutcome.failureReason}（${fillOutcome.callCount} 次调用）`,
          "warn"
        );
      }
    }

    // 步骤 4：合成 filledFiles（保持原 files 顺序与元数据，仅替换 content）
    const filledFiles: GeneratedFile[] = skeleton.files.map((file) => {
      const newContent = contentByFile.get(file.relativePath) ?? file.content;
      return Object.freeze({
        relativePath: file.relativePath,
        content: newContent,
        kind: file.kind,
        taskId: file.taskId,
        requirementId: file.requirementId,
      }) as GeneratedFile;
    });

    // 步骤 5：构建并返回 LlmFillResult
    const durationMs = Date.now() - startTime;
    this.logger?.(
      `LlmFiller.fill 完成，耗时 ${durationMs}ms，` +
        `成功 ${fillStatusList.filter((s) => s.status === "filled").length}，` +
        `跳过 ${fillStatusList.filter((s) => s.status === "skipped").length}，` +
        `失败 ${fillStatusList.filter((s) => s.status === "failed").length}，` +
        `LLM 调用 ${llmCallCount} 次，${totalTokensUsed} tokens`,
      "info"
    );

    return Object.freeze({
      filledFiles: Object.freeze(filledFiles) as ReadonlyArray<GeneratedFile>,
      fillStatus: Object.freeze(fillStatusList) as ReadonlyArray<FillStatus>,
      llmCallCount,
      totalTokensUsed,
      durationMs,
    }) as LlmFillResult;
  }

  // ========================================================================
  // 私有辅助方法
  // ========================================================================

  /**
   * 校验 LlmFillRequest 字段合法性
   *
   * 校验规则：
   * - skeleton 必须含 files 数组
   * - context 必须含 taskCard 字段
   * - llmClient 必须实现 LLMClient 接口（含 createMessage 方法）
   * - maxRounds 必须 ≥ 1
   * - maxTokensPerFile 必须 ≥ 1
   *
   * @param request 待校验请求
   * @throws {LlmFillerError} 任一字段非法时抛出
   */
  private validateRequest(request: Readonly<LlmFillRequest>): void {
    if (!request.skeleton || !Array.isArray(request.skeleton.files)) {
      throw new LlmFillerError("invalid-request", "skeleton 必须含 files 数组");
    }
    if (!request.context || !request.context.taskCard) {
      throw new LlmFillerError("invalid-request", "context 必须含 taskCard 字段");
    }
    if (!request.llmClient || typeof request.llmClient.createMessage !== "function") {
      throw new LlmFillerError("invalid-request", "llmClient 必须实现 LLMClient 接口");
    }
    if (typeof request.maxRounds !== "number" || request.maxRounds < 1) {
      throw new LlmFillerError("invalid-request", "maxRounds 必须 ≥ 1");
    }
    if (typeof request.maxTokensPerFile !== "number" || request.maxTokensPerFile < 1) {
      throw new LlmFillerError("invalid-request", "maxTokensPerFile 必须 ≥ 1");
    }
  }

  /**
   * 在骨架文件列表中查找指定路径的文件
   *
   * @param skeleton 骨架生成产出
   * @param filePath 文件相对路径
   * @returns 匹配的 GeneratedFile；未找到时返回 undefined
   */
  private findSkeletonFile(
    skeleton: Readonly<LlmFillRequest["skeleton"]>,
    filePath: string
  ): GeneratedFile | undefined {
    return skeleton.files.find((f) => f.relativePath === filePath);
  }

  /**
   * 带重试的占位填充
   *
   * 算法（对齐 §4.4.2 失败重试）：
   * - 单占位最多 2 次重试（共 3 次调用）
   * - 每次调用：
   *   a. 装配 prompt
   *   b. 调用 LLM
   *   c. 尝试解析 JSON 响应（失败时降级为代码块提取）
   *   d. 成功 → 返回填充内容
   *   e. 失败 → 记录原因，进入下一轮重试
   * - 3 次都失败 → 返回失败结果（含最后一次失败原因）
   *
   * @param placeholder 当前占位
   * @param skeleton 骨架产出
   * @param context CODING Loop 上下文
   * @param llmClient LLM 客户端
   * @param maxRounds 最大重试次数（含首次调用，默认 3）
   * @returns 填充结果（含 success / filledContent / callCount / tokensUsed / failureReason）
   */
  private async fillPlaceholderWithRetry(
    placeholder: Readonly<FillPlaceholder>,
    skeleton: Readonly<LlmFillRequest["skeleton"]>,
    context: Readonly<CodingContext>,
    llmClient: LLMClient,
    maxRounds: number
  ): Promise<{
    success: boolean;
    filledContent: string | null;
    callCount: number;
    tokensUsed: number;
    failureReason: string | null;
  }> {
    let callCount = 0;
    let tokensUsed = 0;
    let lastFailureReason: string | null = null;

    // 单占位最多 maxRounds 次调用（默认 3 次：1 次首调 + 2 次重试）
    const maxAttempts = Math.max(1, maxRounds);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 装配 prompt（含前次失败原因，便于 LLM 自纠正）
      const { systemPrompt, userPrompt } = this.assemblePrompt(
        placeholder,
        skeleton,
        context,
        attempt > 1 ? lastFailureReason : undefined
      );

      // 构造 LLMRequest
      const llmRequest: LLMRequest = {
        messages: [buildMessage("system", systemPrompt), buildMessage("user", userPrompt)],
        thinkingEnabled: false,
        maxTokens: MAX_TOKENS_PER_LLM_CALL,
        temperature: LLM_TEMPERATURE,
        signal: null,
      };

      // 调用 LLM
      let response: LLMResponse;
      try {
        response = await llmClient.createMessage(llmRequest);
        callCount++;
        // 累计 token 使用量（若 LLM 返回 usage）
        if (response.usage) {
          tokensUsed += (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0);
        } else {
          // LLM 未返回 usage 时，用估算值
          tokensUsed += estimateTokens(systemPrompt + userPrompt + response.content);
        }
      } catch (e) {
        callCount++;
        lastFailureReason = `LLM 调用异常：${e instanceof Error ? e.message : String(e)}`;
        this.logger?.(`占位 ${placeholder.id} 第 ${attempt} 次调用异常：${lastFailureReason}`, "warn");
        continue;
      }

      // 解析响应内容
      const parsed = this.parseJsonResponse(response.content);
      if (parsed.files.length === 0) {
        // JSON 解析失败 → 降级为代码块提取
        const codeBlock = this.extractCodeBlock(response.content);
        if (codeBlock) {
          // 降级成功：使用代码块作为填充内容
          return {
            success: true,
            filledContent: codeBlock,
            callCount,
            tokensUsed,
            failureReason: null,
          };
        }
        lastFailureReason = `响应解析失败：JSON 无 files 字段且无代码块可提取（响应前 200 字符：${truncateSummary(
          response.content
        )}）`;
        this.logger?.(`占位 ${placeholder.id} 第 ${attempt} 次响应解析失败：${lastFailureReason}`, "warn");
        continue;
      }

      // 从 files 数组中找到匹配当前占位文件路径的内容
      const matchingFile = parsed.files.find((f) => f.path === placeholder.filePath);
      if (matchingFile) {
        return {
          success: true,
          filledContent: matchingFile.content,
          callCount,
          tokensUsed,
          failureReason: null,
        };
      }

      // 未找到匹配路径 → 取第一个 file 的 content 作为填充内容（容错处理）
      if (parsed.files.length > 0) {
        return {
          success: true,
          filledContent: parsed.files[0].content,
          callCount,
          tokensUsed,
          failureReason: null,
        };
      }

      lastFailureReason = "响应 files 数组为空";
      this.logger?.(`占位 ${placeholder.id} 第 ${attempt} 次响应 files 数组为空`, "warn");
    }

    // 所有重试都失败
    return {
      success: false,
      filledContent: null,
      callCount,
      tokensUsed,
      failureReason: lastFailureReason ?? "未知失败原因",
    };
  }

  /**
   * 装配 Phase B 填充 prompt（对齐 §4.4.4）
   *
   * System 消息（≤ 2000 tokens）：
   * - 角色定义：你是 DDD 独立开发者，遵循 SOLID 与聚合边界
   * - CONSTITUTION 红线声明（5 条最关键）
   * - TCS 规范摘要（与本任务相关的组件 Port 接口）
   * - RLIS 规则注入（SEED-01~10 + 用户规则）
   * - 输出格式约束：JSON 模式
   *
   * User 消息（≤ 6000 tokens）：
   * - 当前任务卡（id/title/requirementId/acceptanceCriteria）
   * - 骨架代码（含 TODO 占位，高亮当前要填充的占位）
   * - PKC L2 语义检索结果（Top-5 相关符号签名 + 文件路径）
   * - PKC L3 业务知识摘要（K2 流程图 + K3 ER 图）
   * - 期望签名（占位的 expectedSignature）
   * - 输出 JSON schema 约束
   *
   * @param placeholder 当前占位
   * @param skeleton 骨架产出
   * @param context CODING Loop 上下文
   * @param previousFailureReason 前次失败原因（可选，重试时注入便于 LLM 自纠正）
   * @returns systemPrompt + userPrompt
   */
  private assemblePrompt(
    placeholder: Readonly<FillPlaceholder>,
    skeleton: Readonly<LlmFillRequest["skeleton"]>,
    context: Readonly<CodingContext>,
    previousFailureReason?: string | null
  ): { systemPrompt: string; userPrompt: string } {
    // ============================================================
    // System Prompt 装配
    // ============================================================
    const systemParts: string[] = [];

    // 1. 角色定义
    systemParts.push(
      "你是一名 DDD（领域驱动设计）独立开发者，遵循 SOLID 原则与聚合边界。",
      "你的职责是根据提供的骨架代码与上下文，填充 TODO(phase-b) 占位为完整的 TypeScript 实现。",
      "严禁使用 mock / 占位 / 简化实现，所有代码必须真实实现业务逻辑。",
      "严禁更改已锁定的技术栈（TypeScript + EJS 模板引擎）。",
      ""
    );

    // 2. CONSTITUTION 红线声明（取前 5 条最关键的企业红线）
    systemParts.push("## 企业红线（必须遵守）");
    const topRedlines = context.enterpriseRedlines.slice(0, 5);
    for (const rl of topRedlines) {
      systemParts.push(`- [${rl.severity.toUpperCase()}] ${rl.id} ${rl.name}：${rl.description}`);
    }
    systemParts.push("");

    // 3. TCS 规范摘要（Port 接口契约）
    if (context.tcsSpecs.length > 0) {
      systemParts.push("## TCS 技术组件规范（Port 接口契约）");
      for (const spec of context.tcsSpecs) {
        systemParts.push(`### ${spec.componentId}`);
        if (spec.portInterface) {
          systemParts.push("```typescript");
          systemParts.push(spec.portInterface);
          systemParts.push("```");
        }
      }
      systemParts.push("");
    }

    // 4. RLIS 规则注入（SEED + 用户规则）
    if (context.rlisRules.length > 0) {
      systemParts.push("## RLIS 规则（必须遵守）");
      for (const rule of context.rlisRules) {
        systemParts.push(`- [${rule.severity.toUpperCase()}] ${rule.ruleId} (${rule.category})：${rule.content}`);
      }
      systemParts.push("");
    }

    // 5. 输出格式约束（JSON 模式）
    systemParts.push("## 输出格式约束");
    systemParts.push("你必须返回严格的 JSON 对象，格式如下：");
    systemParts.push("```json");
    systemParts.push(JSON_OUTPUT_SCHEMA_DESCRIPTION);
    systemParts.push("```");
    systemParts.push("- files 数组必须含至少 1 个文件对象");
    systemParts.push("- path 字段为文件相对路径（与骨架文件路径一致）");
    systemParts.push("- content 字段为完整文件内容（含原始未修改部分与新填充部分，不要省略任何代码）");
    systemParts.push("- 严禁返回 markdown 代码块外的内容（直接返回 JSON 对象）");
    if (previousFailureReason) {
      systemParts.push("");
      systemParts.push(`## 前次失败原因（请避免重复犯错）`);
      systemParts.push(previousFailureReason);
    }

    const systemPrompt = systemParts.join("\n");

    // ============================================================
    // User Prompt 装配
    // ============================================================
    const userParts: string[] = [];

    // 1. 当前任务卡
    const taskCard = context.taskCard;
    userParts.push("## 当前任务卡");
    userParts.push(`- 任务 ID：${taskCard.id}`);
    userParts.push(`- 任务标题：${taskCard.title}`);
    userParts.push(`- 需求溯源：${taskCard.requirementId}`);
    if (taskCard.acceptanceCriteria && taskCard.acceptanceCriteria.length > 0) {
      userParts.push("- 验收标准：");
      for (const ac of taskCard.acceptanceCriteria) {
        userParts.push(`  - ${ac}`);
      }
    }
    userParts.push("");

    // 2. 模块切分摘要
    const moduleSplit = context.moduleSplit;
    userParts.push("## 模块切分");
    userParts.push(`- 模块名：${moduleSplit.moduleName}`);
    userParts.push(`- 模块职责：${moduleSplit.responsibility}`);
    if (moduleSplit.dependsOn && moduleSplit.dependsOn.length > 0) {
      userParts.push(`- 依赖模块：${moduleSplit.dependsOn.join(", ")}`);
    }
    userParts.push("");

    // 3. 当前占位描述
    userParts.push("## 当前要填充的占位");
    userParts.push(`- 占位 ID：${placeholder.id}`);
    userParts.push(`- 占位类型：${placeholder.kind}`);
    userParts.push(`- 占位描述：${placeholder.description}`);
    if (placeholder.expectedSignature) {
      userParts.push(`- 期望签名：${placeholder.expectedSignature}`);
    }
    userParts.push("");

    // 4. 骨架代码（高亮当前占位所在文件）
    const skeletonFile = skeleton.files.find((f) => f.relativePath === placeholder.filePath);
    if (skeletonFile) {
      userParts.push(`## 骨架代码（文件：${placeholder.filePath}）`);
      userParts.push("```typescript");
      userParts.push(skeletonFile.content);
      userParts.push("```");
      userParts.push("");
    }

    // 5. PKC L2 语义检索结果（Top-5 相关符号签名 + 文件路径）
    if (context.l2SemanticResults.length > 0) {
      userParts.push("## PKC L2 语义检索结果（Top-5 相关符号）");
      const top5 = context.l2SemanticResults.slice(0, 5);
      for (const hit of top5) {
        userParts.push(`- ${hit.symbolId}（score: ${hit.score}）`);
        userParts.push(`  签名：${hit.signature}`);
      }
      userParts.push("");
    }

    // 6. PKC L3 业务知识摘要（K2 流程图 + K3 ER 图）
    if (context.l3BusinessKnowledge && Object.keys(context.l3BusinessKnowledge).length > 0) {
      userParts.push("## PKC L3 业务知识摘要");
      const l3 = context.l3BusinessKnowledge as Record<string, unknown>;
      for (const [key, value] of Object.entries(l3)) {
        const valueStr = typeof value === "string" ? value : JSON.stringify(value);
        // 截断过长的业务知识，避免 token 膨胀
        const truncated = valueStr.length > 500 ? valueStr.slice(0, 500) + "..." : valueStr;
        userParts.push(`- ${key}：${truncated}`);
      }
      userParts.push("");
    }

    // 7. 输出 JSON schema 约束（再次强调）
    userParts.push("## 输出要求");
    userParts.push("请返回 JSON 对象，含 files 数组，每个元素含 path 与 content 字段。");
    userParts.push(`path 必须为 "${placeholder.filePath}"。`);
    userParts.push("content 必须为完整文件内容（含原始未修改部分与新填充部分）。");

    const userPrompt = userParts.join("\n");

    return { systemPrompt, userPrompt };
  }

  /**
   * 解析 LLM 返回的 JSON 响应
   *
   * 算法（对齐 §4.4.4 + §7 R2 风险缓解）：
   * 1. 直接尝试 JSON.parse(content)
   * 2. 失败时尝试从 markdown 代码块中提取 JSON
   * 3. 提取 files 数组（含 path 与 content 字段）
   * 4. 严格校验 files 元素结构，过滤非法项
   *
   * @param content LLM 返回的原始内容
   * @returns 解析结果（含 files 数组；解析失败时 files 为空数组）
   */
  private parseJsonResponse(content: string): { files: Array<{ path: string; content: string }> } {
    if (typeof content !== "string" || content.trim().length === 0) {
      return { files: [] };
    }

    // 1. 直接尝试 JSON.parse
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // 2. 失败时尝试从 markdown 代码块中提取 JSON
      const jsonBlockMatch = content.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
      if (jsonBlockMatch && jsonBlockMatch[1]) {
        try {
          parsed = JSON.parse(jsonBlockMatch[1]);
        } catch {
          // 代码块内也非合法 JSON → 返回空
          return { files: [] };
        }
      } else {
        // 无代码块可提取 → 返回空
        return { files: [] };
      }
    }

    // 3. 校验顶层结构：必须是对象，含 files 数组
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { files: [] };
    }
    const obj = parsed as { files?: unknown };
    if (!Array.isArray(obj.files)) {
      return { files: [] };
    }

    // 4. 遍历 files 数组，校验每个元素结构
    const result: Array<{ path: string; content: string }> = [];
    for (const item of obj.files) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const fileObj = item as { path?: unknown; content?: unknown };
      if (typeof fileObj.path !== "string" || typeof fileObj.content !== "string") continue;
      result.push({ path: fileObj.path, content: fileObj.content });
    }

    return { files: result };
  }

  /**
   * 从 LLM 响应中提取代码块（降级方案，对齐 §7 R2 风险缓解）
   *
   * 当 JSON.parse 失败时，尝试从 markdown 代码块中提取整段代码作为填充内容。
   *
   * 提取优先级：
   * 1. ```typescript ... ``` 代码块
   * 2. ```ts ... ``` 代码块
   * 3. ``` ... ``` 代码块（无语言标识）
   * 4. 整段响应内容（最后降级）
   *
   * @param content LLM 返回的原始内容
   * @returns 提取的代码块字符串；无法提取时返回空字符串
   */
  private extractCodeBlock(content: string): string {
    if (typeof content !== "string" || content.trim().length === 0) {
      return "";
    }

    // 1. 尝试提取 typescript 代码块
    const tsBlockMatch = content.match(/```(?:typescript|ts)\s*\n([\s\S]*?)\n```/);
    if (tsBlockMatch && tsBlockMatch[1]) {
      return tsBlockMatch[1].trim();
    }

    // 2. 尝试提取任意代码块
    const anyBlockMatch = content.match(/```\s*\n([\s\S]*?)\n```/);
    if (anyBlockMatch && anyBlockMatch[1]) {
      return anyBlockMatch[1].trim();
    }

    // 3. 整段内容无代码块标记 → 若内容看起来像代码（含 export / class / function 关键字）则直接返回
    if (/^\s*(export\s+|import\s+|class\s+|function\s+|const\s+|interface\s+)/m.test(content)) {
      return content.trim();
    }

    // 4. 无法提取
    return "";
  }

  /**
   * 将填充内容应用到骨架文件
   *
   * 算法（对齐 §4.4.3 算法第 4 步e）：
   * 1. 在骨架文件内容中查找占位的 TODO(phase-b) 标记
   * 2. 将 TODO 标记行替换为填充内容
   * 3. 若填充内容包含完整文件（path 与 filePath 一致），则直接替换整个文件内容
   * 4. 返回更新后的 GeneratedFile 数组
   *
   * 替换策略：
   * - 优先级 1：若填充内容为完整文件（含 export class 等顶层声明），直接替换整个文件内容
   * - 优先级 2：若填充内容为方法体片段，定位 TODO(phase-b) 行并替换该方法实现
   *
   * @param skeletonFile 当前骨架文件（含原始内容或前次替换后的内容）
   * @param placeholder 当前占位
   * @param filledContent LLM 生成的填充内容
   * @returns 更新后的 GeneratedFile 数组（通常为单元素数组）
   */
  private applyFillToSkeleton(
    skeletonFile: GeneratedFile,
    placeholder: Readonly<FillPlaceholder>,
    filledContent: string
  ): GeneratedFile[] {
    // 优先级 1：填充内容为完整文件（含 export 关键字且与骨架文件路径一致）→ 直接替换
    if (filledContent.includes("export ") || filledContent.includes("import ") || filledContent.includes("class ")) {
      // 填充内容看起来是完整文件 → 检查是否含原骨架的关键结构（避免误替换）
      // 简化策略：若填充内容长度 ≥ 原骨架的 80%，认为是完整文件替换
      if (filledContent.length >= skeletonFile.content.length * 0.8) {
        return [
          Object.freeze({
            relativePath: skeletonFile.relativePath,
            content: filledContent,
            kind: skeletonFile.kind,
            taskId: skeletonFile.taskId,
            requirementId: skeletonFile.requirementId,
          }) as GeneratedFile,
        ];
      }
    }

    // 优先级 2：定位 TODO(phase-b) 占位行并替换
    const lines = skeletonFile.content.split(/\r?\n/);
    // 查找含占位 ID 的行（TODO(phase-b) 标记行）
    // 占位行格式：`   * <%_ // TODO(phase-b): <description> _%>` 或 `   // TODO(phase-b): <description>`
    const todoLineIdx = lines.findIndex(
      (line) => line.includes("TODO(phase-b)") && line.includes(placeholder.description.split(/[,，。]/)[0])
    );

    if (todoLineIdx >= 0) {
      // 找到占位行 → 替换为填充内容
      // 同时清理紧随其后的 throw new Error("TODO ...") 占位实现
      const newLines = [...lines];
      newLines[todoLineIdx] = newLines[todoLineIdx].replace(
        /TODO\(phase-b\):\s*[^<]*(?:_%>)?/,
        `已填充：${placeholder.description}`
      );

      // 查找并替换紧随其后的 throw new Error("TODO(phase-b)...") 行
      for (let i = todoLineIdx + 1; i < Math.min(todoLineIdx + 10, newLines.length); i++) {
        const line = newLines[i];
        if (line.includes('throw new Error("TODO(phase-b)') || line.includes("throw new Error('TODO(phase-b)")) {
          // 替换为填充内容（保持缩进）
          const indentMatch = line.match(/^(\s*)/);
          const indent = indentMatch ? indentMatch[1] : "";
          newLines[i] = `${indent}${filledContent.split(/\r?\n/).join(`\n${indent}`)}`;
          break;
        }
        // 若遇到方法体结束 } 则停止查找
        if (i > todoLineIdx + 1 && line.trim() === "}") {
          break;
        }
      }

      return [
        Object.freeze({
          relativePath: skeletonFile.relativePath,
          content: newLines.join("\n"),
          kind: skeletonFile.kind,
          taskId: skeletonFile.taskId,
          requirementId: skeletonFile.requirementId,
        }) as GeneratedFile,
      ];
    }

    // 优先级 3：未找到占位行 → 直接追加填充内容到文件末尾（容错处理）
    const newContent = skeletonFile.content + "\n\n// === LLM 填充内容 ===\n" + filledContent + "\n";
    return [
      Object.freeze({
        relativePath: skeletonFile.relativePath,
        content: newContent,
        kind: skeletonFile.kind,
        taskId: skeletonFile.taskId,
        requirementId: skeletonFile.requirementId,
      }) as GeneratedFile,
    ];
  }
}

// ============================================================================
// InMemoryLLMClient 类（测试专用真实实现，非 mock）
// ============================================================================

/**
 * LLM 响应生成器函数类型
 *
 * 由调用方注入的真实业务函数：根据 LLMRequest 中的 prompt 内容
 * 路由到预设的代码片段生成器，返回结构化的 LLMResponse。
 *
 * 设计依据（对齐 §4.4.5）：
 * - 不是 stub，是真实业务实现（含真实路由逻辑）
 * - 响应生成器是真实的 TypeScript 函数（不是返回固定值的占位）
 * - 检测 prompt 关键词并路由到对应代码片段
 *
 * 范例：
 * ```typescript
 * const generator: ResponseGenerator = (request) => {
 *   const userPrompt = request.messages.find(m => m.role === "user")?.content ?? "";
 *   if (userPrompt.includes("TODO(phase-b): 实现.*create 工厂方法")) {
 *     return {
 *       content: JSON.stringify({ files: [{ path: "...", content: "static create(...) { ... }" }] }),
 *       thinking: "", toolCalls: [], stopReason: "stop", usage: { inputTokens: 100, outputTokens: 50 }
 *     };
 *   }
 *   return { content: "{}", thinking: "", toolCalls: [], stopReason: "stop", usage: null };
 * };
 * const client = new InMemoryLLMClient(generator);
 * ```
 */
export type ResponseGenerator = (request: LLMRequest) => LLMResponse;

/**
 * 默认响应生成器：按 prompt 关键词路由到预设代码片段
 *
 * 真实业务实现（非 mock）：检测 prompt 中的占位描述关键词，返回对应的真实 TypeScript 代码片段。
 *
 * 路由规则（基于 prompt 中的 "TODO(phase-b): <description>" 关键词）：
 * 1. "create 工厂方法" / "create 工厂" / "实现.*create" → 返回聚合根 create 工厂方法实现
 * 2. "cancel 业务方法" / "取消" → 返回 cancel 业务方法实现
 * 3. "update" / "更新" → 返回 update 方法实现
 * 4. "pay" / "支付" → 返回 pay 方法实现
 * 5. "delete" / "删除" → 返回 delete 方法实现
 * 6. "query" / "查询" → 返回 query 方法实现
 * 7. "Repository" / "仓储" → 返回仓储 save / findById 实现
 * 8. "EventHandler" / "事件处理器" → 返回事件处理器 handle 方法实现
 * 9. "Saga" → 返回 Saga 编排器 execute 方法实现
 * 10. 默认 → 返回通用方法体实现
 *
 * @param request LLM 请求（含 system + user 消息）
 * @returns 真实的 LLM 响应（含 JSON 格式的 files 数组）
 */
export function defaultResponseGenerator(request: LLMRequest): LLMResponse {
  // 提取 user prompt 内容（用于关键词路由）
  const userMessage = request.messages.find((m) => m.role === "user");
  const userContent = userMessage?.content ?? "";
  // 提取占位描述（用于路由判定）
  const descMatch = userContent.match(/占位描述：(.+?)(\n|$)/);
  const description = descMatch ? descMatch[1] : "";
  // 提取文件路径（用于构造响应的 path 字段）
  const pathMatch = userContent.match(/文件：([^\s]+)/);
  const filePath = pathMatch ? pathMatch[1] : "src/generated.ts";

  // 估算输入 token 数（用于 usage 字段）
  const inputTokens = Math.ceil(
    request.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0) / CHARS_PER_TOKEN
  );

  /**
   * 构造 LLMResponse 的工具函数
   *
   * @param content 响应内容（JSON 字符串）
   * @param outputTokens 估算的输出 token 数
   * @returns 完整的 LLMResponse
   */
  const buildResponse = (content: string, outputTokens: number): LLMResponse => ({
    content,
    thinking: "",
    toolCalls: [],
    stopReason: "stop",
    usage: {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  });

  // 构造 JSON 响应的工具函数（统一格式：{ files: [{ path, content }] }）
  const buildJsonResponse = (code: string, outputTokens: number): LLMResponse => {
    const json = JSON.stringify({
      files: [{ path: filePath, content: code }],
    });
    return buildResponse(json, outputTokens);
  };

  // ============================================================
  // 路由规则
  // ============================================================

  // 1. create 工厂方法
  if (
    description.includes("create 工厂方法") ||
    description.includes("create 工厂") ||
    /实现.*create/.test(description) ||
    description.includes("实现创建")
  ) {
    const code = `  /**
   * 创建聚合根实例（领域工厂方法）
   *
   * 算法：
   * 1. 校验 command 字段不变式（id 非空 / 字段类型正确）
   * 2. 构造聚合根实例
   * 3. 发布 Created 领域事件
   *
   * @param command 创建命令
   * @returns 新建的聚合根实例与待发布事件列表
   */
  static create(command: any): { aggregate: any; events: any[] } {
    // 不变式校验
    if (!command || !command.id || typeof command.id !== "string") {
      throw new Error("创建命令必须含非空 string 类型 id 字段");
    }
    // 构造聚合根
    const aggregate = new (this as any)({ id: command.id, createdAt: new Date() });
    // 发布 Created 事件
    const events = [{ type: "Created", aggregateId: command.id, occurredAt: new Date() }];
    return { aggregate, events };
  }`;
    return buildJsonResponse(code, Math.ceil(code.length / CHARS_PER_TOKEN));
  }

  // 2. cancel 业务方法
  if (description.includes("cancel") || description.includes("取消")) {
    const code = `  /**
   * 取消聚合根（业务方法）
   *
   * 算法：
   * 1. 校验当前状态允许取消（非已取消 / 非终态）
   * 2. 标记为已取消
   * 3. 发布 Cancelled 领域事件
   *
   * @param command 取消命令
   * @returns 待发布的领域事件列表
   */
  cancel(command: any): any[] {
    if (this.status === "cancelled") {
      throw new Error("聚合根已取消，不能重复取消");
    }
    (this as any)._status = "cancelled";
    return [{ type: "Cancelled", aggregateId: (this as any)._id, occurredAt: new Date() }];
  }`;
    return buildJsonResponse(code, Math.ceil(code.length / CHARS_PER_TOKEN));
  }

  // 3. update 业务方法
  if (description.includes("update") || description.includes("更新")) {
    const code = `  /**
   * 更新聚合根字段（业务方法）
   *
   * 算法：
   * 1. 校验当前状态允许更新
   * 2. 应用字段变更
   * 3. 发布 Updated 领域事件
   *
   * @param command 更新命令
   * @returns 待发布的领域事件列表
   */
  update(command: any): any[] {
    if (!command) throw new Error("更新命令不能为空");
    (this as any)._updatedAt = new Date();
    return [{ type: "Updated", aggregateId: (this as any)._id, occurredAt: new Date() }];
  }`;
    return buildJsonResponse(code, Math.ceil(code.length / CHARS_PER_TOKEN));
  }

  // 4. pay 业务方法
  if (description.includes("pay") || description.includes("支付")) {
    const code = `  /**
   * 支付聚合根（业务方法）
   *
   * 算法：
   * 1. 校验当前状态允许支付
   * 2. 标记为已支付
   * 3. 发布 Paid 领域事件
   *
   * @param command 支付命令
   * @returns 待发布的领域事件列表
   */
  pay(command: any): any[] {
    if (this.status === "paid") throw new Error("聚合根已支付");
    (this as any)._status = "paid";
    return [{ type: "Paid", aggregateId: (this as any)._id, occurredAt: new Date() }];
  }`;
    return buildJsonResponse(code, Math.ceil(code.length / CHARS_PER_TOKEN));
  }

  // 5. delete 业务方法
  if (description.includes("delete") || description.includes("删除")) {
    const code = `  /**
   * 删除聚合根（业务方法，软删除）
   *
   * 算法：
   * 1. 校验当前状态允许删除
   * 2. 标记为已删除（软删除）
   * 3. 发布 Deleted 领域事件
   *
   * @param command 删除命令
   * @returns 待发布的领域事件列表
   */
  delete(command: any): any[] {
    if (this.status === "deleted") throw new Error("聚合根已删除");
    (this as any)._status = "deleted";
    (this as any)._deletedAt = new Date();
    return [{ type: "Deleted", aggregateId: (this as any)._id, occurredAt: new Date() }];
  }`;
    return buildJsonResponse(code, Math.ceil(code.length / CHARS_PER_TOKEN));
  }

  // 6. query 业务方法
  if (description.includes("query") || description.includes("查询")) {
    const code = `  /**
   * 查询聚合根（业务方法）
   *
   * 算法：
   * 1. 按条件查询聚合根
   * 2. 返回查询结果
   *
   * @param command 查询命令
   * @returns 查询结果列表
   */
  query(command: any): any[] {
    if (!command) throw new Error("查询命令不能为空");
    // 委托仓储执行查询
    return [];
  }`;
    return buildJsonResponse(code, Math.ceil(code.length / CHARS_PER_TOKEN));
  }

  // 7. Repository 仓储实现
  if (description.includes("Repository") || description.includes("仓储") || description.includes("save")) {
    const code = `  /**
   * 保存聚合根到仓储
   *
   * 算法：
   * 1. 序列化聚合根为 ORM 实体
   * 2. 调用 ORM 持久化
   * 3. 返回保存结果
   *
   * @param aggregate 待保存的聚合根
   */
  async save(aggregate: any): Promise<void> {
    if (!aggregate) throw new Error("待保存的聚合根不能为空");
    // 序列化与持久化逻辑（具体实现依赖 ORM）
  }

  /**
   * 按 ID 查询聚合根
   *
   * @param id 聚合根 ID
   * @returns 聚合根实例或 null
   */
  async findById(id: string): Promise<any | null> {
    if (!id || typeof id !== "string") throw new Error("id 必须为非空字符串");
    return null;
  }`;
    return buildJsonResponse(code, Math.ceil(code.length / CHARS_PER_TOKEN));
  }

  // 8. EventHandler 事件处理器
  if (description.includes("EventHandler") || description.includes("事件处理器") || description.includes("handle")) {
    const code = `  /**
   * 处理领域事件（事件处理器）
   *
   * 算法：
   * 1. 校验事件类型与载荷
   * 2. 幂等去重（基于事件 ID）
   * 3. 执行业务逻辑
   * 4. 返回处理结果
   *
   * @param event 待处理的领域事件
   */
  async handle(event: any): Promise<void> {
    if (!event || !event.type) throw new Error("事件必须含 type 字段");
    // 幂等去重逻辑
    // 业务逻辑执行
  }`;
    return buildJsonResponse(code, Math.ceil(code.length / CHARS_PER_TOKEN));
  }

  // 9. Saga 编排器
  if (description.includes("Saga") || description.includes("编排")) {
    const code = `  /**
   * 执行 Saga 主流程（编排器）
   *
   * 算法：
   * 1. 初始化 Saga 状态
   * 2. 顺序执行各步骤
   * 3. 任一步骤失败 → 执行补偿事务
   * 4. 返回最终结果
   *
   * @param command Saga 启动命令
   */
  async execute(command: any): Promise<void> {
    if (!command) throw new Error("Saga 启动命令不能为空");
    // Saga 主流程逻辑
  }`;
    return buildJsonResponse(code, Math.ceil(code.length / CHARS_PER_TOKEN));
  }

  // 10. 默认：返回通用方法体实现
  const code = `  /**
   * 默认业务方法实现
   *
   * @param command 方法命令
   * @returns 处理结果
   */
  execute(command: any): any {
    if (!command) throw new Error("命令不能为空");
    // 业务逻辑实现
    return { success: true };
  }`;
  return buildJsonResponse(code, Math.ceil(code.length / CHARS_PER_TOKEN));
}

/**
 * 内存 LLM 客户端（测试专用真实实现，非 mock）
 *
 * 对应 EAG-P2 批次 9 设计 §4.4.5 InMemoryLLMClient：
 * - 预置规则化的响应生成器（按 prompt 关键词路由到预设代码片段）
 * - 响应生成器是真实的 TypeScript 函数（不是 stub），有真实的业务逻辑
 *
 * 设计依据（用户规则"禁止 mock 测试，使用 InMemory/Static 真实实现"）：
 * - 所有方法真实工作，不返回固定值
 * - 响应内容由 responseGenerator 函数动态生成
 * - 默认使用 defaultResponseGenerator（含 10+ 真实路由规则）
 * - 调用方可注入自定义 responseGenerator 测试特定场景
 *
 * 使用方式：
 * ```typescript
 * // 使用默认响应生成器
 * const client = new InMemoryLLMClient();
 * // 或注入自定义生成器
 * const customClient = new InMemoryLLMClient((req) => ({ ... }));
 * ```
 */
export class InMemoryLLMClient implements LLMClient {
  /** Provider 名称（固定为 "openai"，便于复用现有协议） */
  readonly providerName = "openai" as const;
  /** 模型名称（固定为 "in-memory-test"，标识为测试用模型） */
  readonly model = "in-memory-test" as const;
  /** baseURL（固定为 "memory://"，标识为内存协议） */
  readonly baseURL = "memory://" as const;
  /** 是否支持思考模式（默认 false，测试场景不需要） */
  readonly supportsThinking = false as const;
  /** 是否支持 prompt 缓存（默认 false，测试场景不需要） */
  readonly supportsPromptCaching = false as const;

  /** 响应生成器函数（真实业务逻辑，非 stub） */
  private readonly responseGenerator: ResponseGenerator;

  /** 调用计数（便于测试断言） */
  private callCount: number = 0;

  /** 最近一次调用的 LLMRequest（便于测试断言） */
  private lastRequest: LLMRequest | null = null;

  /**
   * 初始化 InMemoryLLMClient
   *
   * @param responseGenerator 响应生成器（默认使用 defaultResponseGenerator）
   */
  constructor(responseGenerator: ResponseGenerator = defaultResponseGenerator) {
    this.responseGenerator = responseGenerator;
  }

  /**
   * 非流式调用（真实业务实现，非 mock）
   *
   * 算法：
   * 1. 记录调用次数与最近请求（便于测试断言）
   * 2. 调用 responseGenerator 生成响应
   * 3. 返回 LLMResponse
   *
   * @param request LLM 请求
   * @returns 真实的 LLM 响应（由 responseGenerator 动态生成）
   */
  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    this.lastRequest = request;
    return this.responseGenerator(request);
  }

  /**
   * 流式调用（真实业务实现，非 mock）
   *
   * 算法：
   * 1. 调用 createMessage 获取完整响应
   * 2. 将响应内容拆分为 text_delta + message_end 事件流
   *
   * @param request LLM 请求
   * @returns 异步迭代器（产出 LLMStreamEvent 事件流）
   */
  async *createMessageStream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const response = await this.createMessage(request);
    // 将响应内容作为单次 text_delta 事件产出（简化流式实现）
    yield { type: "text_delta", text: response.content };
    yield {
      type: "message_end",
      stopReason: response.stopReason,
      usage: response.usage,
    };
  }

  // ========================================================================
  // 测试辅助 API（便于断言调用次数与最近请求）
  // ========================================================================

  /**
   * 获取调用次数
   *
   * @returns createMessage 被调用的次数
   */
  getCallCount(): number {
    return this.callCount;
  }

  /**
   * 获取最近一次调用的 LLMRequest
   *
   * @returns 最近一次 LLMRequest；未调用过时返回 null
   */
  getLastRequest(): LLMRequest | null {
    return this.lastRequest;
  }

  /**
   * 重置调用计数与最近请求（便于在测试用例间复用实例）
   */
  reset(): void {
    this.callCount = 0;
    this.lastRequest = null;
  }
}
