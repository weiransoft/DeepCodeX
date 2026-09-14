/**
 * EAG-P5 LLM 任务执行器（方案 A §3.8，架构师审查 P0-6 选型）
 *
 * 修复前问题：
 * - dev/fix 阶段不调用任何 LLM，只盘点文件/生成建议就返回 success，
 *   AutonomousOrchestrator 因此空转：0 次 LLM 调用、0 秒耗时却报 completed。
 *
 * 选型结论（架构师审查否决"新建子 SessionManager"方案后的替代设计）：
 * - 不创建会话条目、不碰 sessions-index.json、不跑 skill 匹配/compact/建议器，
 *   避免共享索引无锁读改写淘汰主会话、权限挂起信号私有不可达等 6 个 P0 硬伤；
 * - 在本类内实现精简的「LLM ↔ 工具」循环：
 *   固定 system/user 提示词 → 非流式 createMessage → 真实 ToolExecutor 执行
 *   read/write/edit/UpdatePlan → 工具结果回灌 → 直到模型给出无工具调用的终态文本；
 * - 进程内权限硬判（onBeforeToolExecution）：白名单 + 路径牢笼 + 凭据模式，
 *   越权一律 deny 并把失败结果回灌模型——不挂起、不询问、不落盘 settings.json；
 * - 工具循环轮数硬上限（默认 12），模型无法自行放宽；
 * - 每轮轮询 abort 标志文件，命中即中止。
 *
 * 真实性约束（用户硬性规则：禁止 mock/占位/简化）：
 * - LLM 客户端、ToolExecutor、文件系统、git 全部为生产真实实现；
 * - 唯一允许的测试替换点是 createLlmClient 工厂（测试中返回桩 LLMClient 控制 HTTP 响应），
 *   工具执行与文件落盘在测试中仍走真实 ToolExecutor。
 *
 * @module eag/p5/executors/llm-task-executor
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { ToolExecutor } from "../../../tools/executor";
import { getTools } from "../../../prompt";
import { clearSessionState, getSnippet } from "../../../common/state";
import type { ToolCallExecution } from "../../../common/tool-types";
import type { LLMClient, LLMToolDefinition, LLMToolCall } from "../../../providers/llm-provider";
import type { SessionMessage } from "../../../session";
import type { P5TaskExecutor, P5TaskExecutionInput, P5TaskExecutionResult } from "../handlers/task-executor-port";

// ============================================================================
// 1. 常量定义（Object.freeze 冻结，运行期不可被模型/外部修改）
// ============================================================================

/**
 * P5 任务执行重入标志的 AsyncLocalStorage。
 *
 * 纵深防御（架构师 P1-1）：任务执行全程在 storage.run(true, ...) 中运行。
 * F9-v2 确定性通道入口（tryDeterministicEagExecution）读取此标志，
 * 若发现自身是被任务执行链路中的 LLM 文本间接触发，则拒绝再次进入自主循环。
 * 当前精简循环不经过 SessionManager，物理上不会触发；该存储用于防止未来接线回归。
 */
export const p5TaskExecutionStorage = new AsyncLocalStorage<boolean>();

/**
 * 允许任务执行器使用的工具白名单。
 *
 * - read：读取项目内文件（同样受路径牢笼与凭据模式约束，防止读密钥后外泄）；
 * - write：整文件创建/覆盖（足以完成新建与改写）；
 * - edit：基于 snippet 的精确替换（依赖先 read 获取 snippet_id，状态按合成 sessionId 隔离）；
 * - UpdatePlan：无副作用的计划更新工具，帮助模型组织步骤。
 *
 * 明确不开放：
 * - bash：命令执行统一归 verify 阶段真实测试，任务执行阶段硬隔离，杜绝 rm/网络/安装等副作用；
 * - AskUserQuestion：无人值守循环无人应答，开放只会造成挂起；
 * - skill / WebSearch / 图片工具 / MCP / codemap：超出"按卡编码"职责面。
 */
const ALLOWED_TOOL_NAMES: ReadonlySet<string> = Object.freeze(new Set<string>(["read", "write", "edit", "UpdatePlan"]));

/**
 * 凭据文件模式黑名单（与 dev-stage-handler.ts 的 G-A5a 预检同源，保持独立副本，
 * 避免执行器反向依赖阶段处理器；两处模式需同步维护）。
 *
 * 命中任一模式的文件禁止 read/write/edit：
 * .env 系列、.ssh/.aws/.gnupg 目录、secrets/credentials/token/password 关键词、
 * .pem/.key/.p12/.pfx 证书密钥、.npmrc/.pypirc/.git-credentials 包管理器与 Git 凭据。
 */
const CREDENTIAL_FILE_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\.env(\.|$)/i,
  /\.ssh[\\/]/i,
  /\.aws[\\/]/i,
  /\.gnupg[\\/]/i,
  /secrets?/i,
  /credentials?/i,
  /\btoken\b/i,
  /\bpassword\b/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.npmrc$/i,
  /\.pypirc$/i,
  /\.git-credentials$/i,
]);

/** 单任务工具循环默认最大轮数（每轮一次真实 LLM 请求 + 一批工具调用） */
const DEFAULT_MAX_TOOL_ROUNDS = 12;

/** 单次 LLM 请求最大输出 token 数（执行循环不需要长篇解释） */
const EXECUTION_MAX_TOKENS = 8192;

/** 终态摘要最大保留字符数 */
const MAX_SUMMARY_CHARS = 2000;

/** git status 子命令超时（毫秒），超时/非 git 仓库按"无变更"降级，不使任务失败 */
const GIT_STATUS_TIMEOUT_MS = 10000;

/** 无 usage 回包时的字符→token 估算系数（保守 3.5 字符/token） */
const CHARS_PER_TOKEN_ESTIMATE = 3.5;

/**
 * 执行器系统提示词。
 *
 * 刻意避免出现"EAG/自主任务/无人值守/自动循环"等 F9 确定性通道触发词（架构师 P1-1），
 * 防止模型回显文本时在重入场景下误触发命令解析。
 */
const SYSTEM_PROMPT = [
  "你是一名在指定项目目录内工作的编码执行代理。你将收到一张明确的任务卡，",
  "必须通过工具调用真实完成文件改动，而不是仅给出建议或代码片段。",
  "",
  "硬性规则：",
  "1. 只能操作任务指定项目目录内的文件；项目目录之外的任何路径一律不要尝试。",
  "2. 禁止读取或写入环境变量文件、密钥、证书、凭据（如 .env、.ssh、.aws、secrets、*.pem、*.key）。",
  "3. 禁止删除文件、执行 shell 命令、安装依赖或访问网络；你只有 read/write/edit 与计划工具。",
  "4. 修改既有文件前先 read 读取内容；新文件用 write 直接创建，内容必须完整可用。",
  "5. 完成全部改动后，用一条不含工具调用的简短文本回复总结：实际创建/修改了哪些文件、",
  "   每个文件的核心改动、如何验证。不要在终态回复中贴大段代码。",
  "6. 如果任务信息不足以安全动手，同样以无工具调用的文本回复说明缺少什么。",
].join("\n");

// ============================================================================
// 2. 构造选项与工厂
// ============================================================================

/** LlmTaskExecutor 构造选项（不可变） */
export interface LlmTaskExecutorOptions {
  /** 项目根目录绝对路径：路径牢笼边界，也是 ToolExecutor 的工作目录 */
  readonly projectRoot: string;
  /**
   * LLM 客户端工厂。
   * SessionManager 绑定时传 `() => this.createLLMClient()`（闭包内可达同类私有方法）；
   * 工厂返回 null 表示未配置凭据，executeTask 必须零请求失败（fail-closed）。
   */
  readonly createLlmClient: () => LLMClient | null;
  /** 模型名（仅用于 getTools 的多模态裁剪等，实际请求模型由 client 自身决定） */
  readonly model?: string;
  /** 可选日志回调（与 AutonomousOrchestrator 日志同构，此处结构化复制避免跨层类型依赖） */
  readonly logger?: (message: string, level?: "info" | "warn" | "error") => void;
  /** 单任务工具循环最大轮数，默认 12；测试可收窄 */
  readonly maxToolRounds?: number;
}

// ============================================================================
// 3. 执行器实现
// ============================================================================

/**
 * 基于精简 LLM↔工具循环的 P5 任务执行器（生产实现）。
 *
 * 生命周期：由 SessionManager 构造一次，bindTaskExecutor 注入 orchestrator，
 * 多次 run 复用（实例无任务级可变状态，任务级状态全部在 executeTask 调用栈内）。
 */
export class LlmTaskExecutor implements P5TaskExecutor {
  private readonly projectRoot: string;
  private readonly createLlmClient: () => LLMClient | null;
  private readonly model: string | undefined;
  private readonly log: (message: string, level?: "info" | "warn" | "error") => void;
  private readonly maxToolRounds: number;

  constructor(options: Readonly<LlmTaskExecutorOptions>) {
    this.projectRoot = options.projectRoot;
    this.createLlmClient = options.createLlmClient;
    this.model = options.model;
    this.log = options.logger ?? (() => undefined);
    const rounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    if (!Number.isInteger(rounds) || rounds <= 0) {
      throw new Error(`LlmTaskExecutor maxToolRounds 必须为正整数，实际：${String(rounds)}`);
    }
    this.maxToolRounds = rounds;
  }

  /**
   * 执行单张任务卡（端口实现）。
   *
   * 全程包在 p5TaskExecutionStorage 重入标志中；任何异常都收敛为
   * success=false 结果（不向编排器抛出，避免单任务异常击穿循环）。
   */
  async executeTask(input: Readonly<P5TaskExecutionInput>): Promise<Readonly<P5TaskExecutionResult>> {
    return p5TaskExecutionStorage.run(true, () => this.runLoop(input));
  }

  // ==========================================================================
  // 3.1 主循环
  // ==========================================================================

  /**
   * 工具循环主体（executeTask 的重入标志包裹版本）。
   */
  private async runLoop(input: Readonly<P5TaskExecutionInput>): Promise<Readonly<P5TaskExecutionResult>> {
    // 合成 sessionId：仅供 ToolExecutor 的 snippet/文件状态按执行次隔离，
    // 绝不写入 sessions-index.json，执行结束立即 clearSessionState 释放模块级状态。
    const toolSessionId = `p5-${input.runId}-i${input.iterIndex}-${input.stage}`;
    const abortController = new AbortController();

    // 自有 ToolExecutor：不传 openAIClient 与 mcpManager，
    // 构造函数内 registerToolHandlers() 注册全部内置真实文件工具（零 mock）。
    const toolExecutor = new ToolExecutor(this.projectRoot, undefined, undefined, this.createLlmClient);

    // 白名单工具定义（仅向 LLM 暴露这 4 个工具的 schema）
    const toolDefinitions = this.buildAllowedToolDefinitions();

    // 会话消息序列（system + user 起始，随后 assistant/tool 交替追加）
    const messages: SessionMessage[] = [
      this.buildSessionMessage("system", SYSTEM_PROMPT, null),
      this.buildSessionMessage("user", this.buildUserPrompt(input), null),
    ];

    let llmRequests = 0;
    let inputTokensTotal = 0;
    let outputTokensTotal = 0;
    let estimatedCharsTotal = 0;
    let sawUsage = false;

    try {
      // 进入循环前先取一次客户端：无凭据直接 fail-closed，不发起任何请求
      const client = this.createLlmClient();
      if (client === null || client === undefined) {
        return this.failure("LLM 客户端不可用：未配置 API 凭据（请检查 settings.json 与环境变量）", llmRequests);
      }

      for (let round = 1; round <= this.maxToolRounds; round += 1) {
        // 每轮顶部双重 abort 检查：标志文件（跨进程 stop）+ AbortSignal（进程内）
        if (this.isAbortRequested(input.abortFlagPath) || abortController.signal.aborted) {
          return this.failure("aborted：任务执行被中止信号中断", llmRequests);
        }

        // 真实非流式 LLM 请求（简单、usage 直接可得、无 skill 预请求缝隙）
        const response = await client.createMessage({
          messages,
          tools: toolDefinitions,
          thinkingEnabled: false,
          maxTokens: EXECUTION_MAX_TOKENS,
          signal: abortController.signal,
        });
        llmRequests += 1;

        // usage 累计（部分网关不回 usage：记录字符数，结束时估算保底）
        if (response.usage) {
          sawUsage = true;
          inputTokensTotal += response.usage.inputTokens;
          outputTokensTotal += response.usage.outputTokens;
        } else {
          estimatedCharsTotal += this.lastUserishContentChars(messages) + response.content.length;
        }

        // 无工具调用 = 模型终态回复：任务执行正常结束
        if (response.toolCalls.length === 0) {
          const changedFiles = this.listGitChangedFiles(input.projectRoot);
          const tokensUsed = this.resolveTokensUsed(
            sawUsage,
            inputTokensTotal + outputTokensTotal,
            estimatedCharsTotal
          );
          return Object.freeze({
            success: true,
            summary: (response.content || "").slice(0, MAX_SUMMARY_CHARS),
            tokensUsed: tokensUsed.tokens,
            tokensEstimated: tokensUsed.estimated,
            llmRequests,
            changedFiles: Object.freeze(changedFiles),
          });
        }

        // 追加 assistant 工具调用消息（OpenAI tool_calls 形态，双 converter 均识别）
        messages.push(this.buildAssistantToolCallMessage(response.toolCalls, response.content));

        // 真实执行工具调用（越权由 onBeforeToolExecution 进程内硬判，deny 结果原样回灌）
        const executions: ToolCallExecution[] = await toolExecutor.executeToolCalls(
          toolSessionId,
          response.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.argumentsJson },
          })),
          {
            signal: abortController.signal,
            shouldStop: () => this.isAbortRequested(input.abortFlagPath),
            onBeforeToolExecution: (toolName, args) => this.authorizeToolCall(toolName, args, toolSessionId),
          }
        );

        // 每个工具结果作为独立 tool 消息（tool_call_id 与调用一一配对）
        for (const execution of executions) {
          messages.push(
            this.buildSessionMessage("tool", execution.content, Object.freeze({ tool_call_id: execution.toolCallId }))
          );
        }
      }

      // 达到轮数上限仍在持续调用工具：诚实判失败，交回编排器决定 fix/abort
      return this.failure(`工具循环达上限（${this.maxToolRounds} 轮）仍未给出终态回复`, llmRequests);
    } catch (error) {
      // AbortError：用户/编排器主动中止
      if (error instanceof Error && error.name === "AbortError") {
        return this.failure("aborted：任务执行被中止信号中断", llmRequests);
      }
      const message = error instanceof Error ? error.message : String(error);
      this.log(`任务执行异常：${message}`, "error");
      return this.failure(`任务执行异常：${message}`, llmRequests);
    } finally {
      // 释放合成 sessionId 在 common/state 模块级 Map 中累积的 snippet/文件状态
      clearSessionState(toolSessionId);
    }
  }

  // ==========================================================================
  // 3.2 权限硬判（白名单 + 路径牢笼 + 凭据模式）
  // ==========================================================================

  /**
   * 工具执行前的进程内审批钩子（不挂起、不询问、不落盘）。
   *
   * @param toolName 工具原名（别名映射前）
   * @param args 已解析的工具参数
   * @param toolSessionId 合成 sessionId（edit 无 file_path 时反查 snippet 归属文件）
   * @returns approve 放行 / deny 拒绝（拒绝结果由 ToolExecutor 回灌模型）
   */
  private async authorizeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    toolSessionId: string
  ): Promise<"approve" | "deny" | "ask_user"> {
    // 第一层：工具白名单（schema 已只暴露 4 个，这里防模型/调用方注入其他工具名）
    if (!ALLOWED_TOOL_NAMES.has(toolName)) {
      this.log(`工具被白名单拒绝：${toolName}`, "warn");
      return "deny";
    }

    // UpdatePlan 无文件参数，直接放行
    if (toolName === "UpdatePlan") {
      return "approve";
    }

    // 第二层：解析目标文件路径。
    // read/write 必须携带 file_path；edit 允许仅给 snippet_id（先 read 后 edit 的正常流程），
    // 此时从 snippet 状态反查文件路径，确保 edit 目标同样受牢笼约束。
    let targetPath = typeof args.file_path === "string" ? args.file_path : "";
    if (!targetPath && toolName === "edit" && typeof args.snippet_id === "string") {
      targetPath = getSnippet(toolSessionId, args.snippet_id)?.filePath ?? "";
    }
    if (!targetPath) {
      this.log(`${toolName} 缺少可定位的文件路径（file_path 或有效 snippet_id）`, "warn");
      return "deny";
    }

    // 第三层：路径牢笼（与 dev-stage-handler G-A1a 同构：resolve 后前缀校验）
    const resolvedRoot = path.resolve(this.projectRoot);
    const resolvedTarget = path.resolve(this.projectRoot, targetPath);
    const relativePath = path.relative(resolvedRoot, resolvedTarget);
    const isInside = relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
    if (!isInside) {
      this.log(`路径越界被拒绝：${targetPath}（牢笼：${resolvedRoot}）`, "warn");
      return "deny";
    }

    // 第四层：凭据模式（对项目根内的 .env/密钥等同名文件同样拒绝，纵深防御）
    if (CREDENTIAL_FILE_PATTERNS.some((re) => re.test(relativePath))) {
      this.log(`凭据文件访问被拒绝：${relativePath}`, "warn");
      return "deny";
    }

    return "approve";
  }

  // ==========================================================================
  // 3.3 消息与提示词构造
  // ==========================================================================

  /**
   * 从 getTools() 全量内置工具中筛选白名单并映射为 provider 无关的 LLMToolDefinition。
   * nonInteractive:true 使 getTools 不注册 AskUserQuestion（无人应答）。
   */
  private buildAllowedToolDefinitions(): LLMToolDefinition[] {
    const allTools = getTools({ model: this.model, nonInteractive: true }, []);
    const allowed: LLMToolDefinition[] = [];
    for (const tool of allTools) {
      const name = tool.function.name;
      if (ALLOWED_TOOL_NAMES.has(name)) {
        allowed.push({
          name,
          description: tool.function.description,
          parameters: tool.function.parameters as Record<string, unknown>,
        });
      }
    }
    return allowed;
  }

  /**
   * 构造 user 提示词：任务背景 + 卡 ID/标题 + 验收标准 + fix 阶段失败反馈。
   */
  private buildUserPrompt(input: Readonly<P5TaskExecutionInput>): string {
    const lines: string[] = [
      `工作目录（绝对路径，所有文件操作的牢笼）：${input.projectRoot}`,
      `任务目标背景：${input.objective}`,
      `任务卡：${input.taskId} ${input.taskTitle}`,
    ];
    if (input.acceptanceCriteria.length > 0) {
      lines.push("验收标准：");
      for (const criterion of input.acceptanceCriteria) {
        lines.push(`- ${criterion}`);
      }
    } else {
      lines.push("验收标准：任务卡未显式列出，请按标题与目标背景做出完整、可用的实现。");
    }
    if (input.stage === "fix") {
      lines.push("", "本任务此前的验证失败反馈（请据此修复，不要重复导致失败的做法）：");
      lines.push(input.feedback ?? "（未提供具体失败反馈，请重新审查实现与测试结果）");
    }
    lines.push("", "现在开始：需要读取文件就调用 read，确认改动方案后用 write/edit 真实落盘，全部完成后给出终态文本。");
    return lines.join("\n");
  }

  /**
   * 构造一条最小合法 SessionMessage（不含持久化语义，仅供 provider 转换请求）。
   */
  private buildSessionMessage(role: SessionMessage["role"], content: string, messageParams: unknown): SessionMessage {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      sessionId: "p5-task-execution",
      role,
      content,
      contentParams: null,
      messageParams,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    };
  }

  /**
   * 构造带工具调用的 assistant 消息。
   * messageParams.tool_calls 使用 OpenAI 形态：
   * {id,type:"function",function:{name,arguments}}，
   * OpenAIMessageConverter 与 AnthropicMessageConverter 均从此字段提取工具调用。
   */
  private buildAssistantToolCallMessage(toolCalls: ReadonlyArray<LLMToolCall>, text: string): SessionMessage {
    return this.buildSessionMessage(
      "assistant",
      text || "",
      Object.freeze({
        tool_calls: Object.freeze(
          toolCalls.map((tc) =>
            Object.freeze({
              id: tc.id,
              type: "function" as const,
              function: Object.freeze({ name: tc.name, arguments: tc.argumentsJson }),
            })
          )
        ),
      })
    );
  }

  // ==========================================================================
  // 3.4 abort / token / git 辅助
  // ==========================================================================

  /**
   * 检查跨进程 abort 标志文件是否存在。
   * 路径为空（未注入）时跳过文件检查，仅依赖 AbortSignal。
   */
  private isAbortRequested(abortFlagPath: string): boolean {
    if (!abortFlagPath) {
      return false;
    }
    try {
      return fs.existsSync(abortFlagPath);
    } catch {
      // 标志文件探测本身失败（权限等）不阻断执行，下一轮继续探测
      return false;
    }
  }

  /**
   * 结算真实 token 用量。
   * - 网关回了 usage：直接用累计值；
   * - 全程无 usage：按字符数估算保底 ≥1（保证 orchestrator 的 llmCallCount 凭证成立），
   *   并标 tokensEstimated=true（架构师 P1-6：计数与 token 解耦，估算不伪装成真实值）。
   */
  private resolveTokensUsed(
    sawUsage: boolean,
    realTokens: number,
    estimatedChars: number
  ): { tokens: number; estimated: boolean } {
    if (sawUsage && realTokens > 0) {
      return { tokens: realTokens, estimated: false };
    }
    const estimated = Math.max(1, Math.ceil(estimatedChars / CHARS_PER_TOKEN_ESTIMATE));
    return { tokens: estimated, estimated: true };
  }

  /**
   * 估算上一轮对话字符规模（仅在网关不回 usage 时使用）：
   * 取当前消息序列总字符，近似覆盖输入侧规模。
   */
  private lastUserishContentChars(messages: ReadonlyArray<SessionMessage>): number {
    let total = 0;
    for (const message of messages) {
      if (typeof message.content === "string") {
        total += message.content.length;
      }
    }
    return total;
  }

  /**
   * 真实执行 `git status --porcelain` 检出变更文件（相对路径）。
   * 非 git 仓库 / git 不存在 / 超时：返回空数组，不因此判任务失败
   * （变更文件只用于制品与报告，成功与否由 verify 阶段裁定）。
   *
   * 必须带 `--untracked-files=all`：porcelain 默认会把未跟踪【目录】折叠成
   * "?? src/"（目录名 + 斜杠），而 LLM 执行任务最常见的产物正是新建文件，
   * 折叠会导致 changedFiles 只剩目录前缀、dev 阶段 changeDiff 失真。
   * `-uall` 强制展开到每个未跟踪文件（如 "?? src/answer.js"）。
   */
  private listGitChangedFiles(projectRoot: string): string[] {
    try {
      const stdout = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: projectRoot,
        timeout: GIT_STATUS_TIMEOUT_MS,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const files: string[] = [];
      for (const rawLine of stdout.split("\n")) {
        const line = rawLine.trimEnd();
        if (!line) {
          continue;
        }
        // porcelain：前两位为状态码，第 4 列起为路径；重命名形如 "old -> new"
        let filePath = line.slice(3);
        if (filePath.includes(" -> ")) {
          filePath = filePath.split(" -> ")[1] ?? filePath;
        }
        // 含空格/特殊字符的路径可能被引号包裹
        if (filePath.startsWith('"') && filePath.endsWith('"')) {
          filePath = filePath.slice(1, -1);
        }
        if (filePath) {
          files.push(filePath);
        }
      }
      return files;
    } catch {
      return [];
    }
  }

  /**
   * 构造失败结果（不报告变更文件：失败语义下 changedFiles 无消费意义，
   * 残留改动可由下一轮 plan/dev 的真实盘点与 git status 重新检出）。
   */
  private failure(error: string, llmRequests: number): Readonly<P5TaskExecutionResult> {
    return Object.freeze({
      success: false,
      summary: "",
      tokensUsed: 0,
      tokensEstimated: false,
      llmRequests,
      changedFiles: Object.freeze([]),
      error,
    });
  }
}
