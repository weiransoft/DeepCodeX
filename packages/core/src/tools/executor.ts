import { handleAskUserQuestionTool } from "./ask-user-question-handler";
import { handleBashTool } from "./bash-handler";
import { handleEditTool } from "./edit-handler";
import { handleReadTool } from "./read-handler";
import { handleUpdatePlanTool } from "./update-plan-handler";
import { handleWebSearchTool } from "./web-search-handler";
import { handleWriteTool } from "./write-handler";
// P1-T2：PureShowWidget 工具 handler（dynamic-ui skill 的执行入口）
import { handlePureShowWidget } from "../visualization/widget-tool";
import type { McpManager } from "../mcp/mcp-manager";
import type {
  CreateOpenAIClient,
  CreateLLMClient,
  ToolCall,
  ToolExecutionHooks,
  ToolExecutionResult,
  ToolHandler,
  ToolCallExecution,
} from "../common/tool-types";

export type {
  CreateOpenAIClient,
  CreateLLMClient,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionHooks,
  ToolExecutionResult,
  ToolHandler,
  ToolCallExecution,
  ProcessTimeoutInfo,
  ProcessTimeoutControl,
  BackgroundProcessCompletion,
  ToolExecutionFollowUpMessage,
} from "../common/tool-types";

const BUILT_IN_TOOL_NAME_ALIASES = new Map<string, string>([
  ["Bash", "bash"],
  ["Read", "read"],
  ["Write", "write"],
  ["Edit", "edit"],
]);

/**
 * ToolExecutor 层危险 bash 命令兜底黑名单。
 *
 * P0 安全修复：当调用方未通过 onBeforeToolExecution 注入守卫时，ToolExecutor 自身必须
 * 阻止 rm -rf / 等明显灾难性命令。该列表与 bash-handler 内部守卫保持一致的最小集合。
 */
const DANGEROUS_BASH_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = Object.freeze([
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|--recursive)\s+(-[a-zA-Z]*\s+)*\/(\s|$)/, reason: "forbidden rm -rf /" },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|--recursive)\s+(-[a-zA-Z]*\s+)*\/\*/, reason: "forbidden rm -rf /*" },
  { pattern: /\bmkfs\b/, reason: "forbidden disk formatting" },
  { pattern: /\b(dd|fdisk|parted)\b/, reason: "forbidden disk partitioning/overwrite" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "forbidden system shutdown/reboot" },
  { pattern: /[>|>]\s*\/dev\/sda/, reason: "forbidden block device overwrite" },
  { pattern: /\biptables\s+-F\b/, reason: "forbidden firewall flush" },
]);

/**
 * 检查 bash 命令是否命中危险模式。
 *
 * @param command bash 命令字符串
 * @returns 命中时返回原因，否则返回 null
 */
function checkDangerousBashCommand(command: string): string | null {
  for (const { pattern, reason } of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return reason;
    }
  }
  return null;
}

export class ToolExecutor {
  private readonly projectRoot: string;
  private readonly createOpenAIClient?: CreateOpenAIClient;
  private readonly createLLMClient?: CreateLLMClient;
  private readonly mcpManager?: McpManager;
  private readonly toolHandlers = new Map<string, ToolHandler>();

  /**
   * @param projectRoot 项目根目录
   * @param createOpenAIClient 既有 OpenAI SDK 客户端工厂（主对话流式通路沿用）
   * @param mcpManager MCP 管理器
   * @param createLLMClient B1：统一 LLM 客户端工厂（provider 路由），
   *                        供 edit-handler 等非流式 LLM 辅助调用使用；
   *                        未注入时相关增强能力静默降级（与 createOpenAIClient 缺省语义一致）
   */
  constructor(
    projectRoot: string,
    createOpenAIClient?: CreateOpenAIClient,
    mcpManager?: McpManager,
    createLLMClient?: CreateLLMClient
  ) {
    this.projectRoot = projectRoot;
    this.createOpenAIClient = createOpenAIClient;
    this.mcpManager = mcpManager;
    this.createLLMClient = createLLMClient;
    this.registerToolHandlers();
  }

  async executeToolCalls(
    sessionId: string,
    toolCalls: unknown[],
    hooks?: ToolExecutionHooks
  ): Promise<ToolCallExecution[]> {
    const parsedCalls = toolCalls
      .map((toolCall) => this.parseToolCall(toolCall))
      .filter((toolCall): toolCall is ToolCall => Boolean(toolCall));

    const executions: ToolCallExecution[] = [];
    for (const toolCall of parsedCalls) {
      if (hooks?.shouldStop?.()) {
        break;
      }
      const result = await this.executeToolCall(sessionId, toolCall, hooks);
      executions.push({
        toolCallId: toolCall.id,
        content: this.formatToolResult(result),
        result,
      });
      if (hooks?.shouldStop?.()) {
        break;
      }
    }
    return executions;
  }

  private registerToolHandlers(): void {
    this.toolHandlers.set("bash", handleBashTool);
    this.toolHandlers.set("read", handleReadTool);
    this.toolHandlers.set("write", handleWriteTool);
    this.toolHandlers.set("edit", handleEditTool);
    this.toolHandlers.set("AskUserQuestion", handleAskUserQuestionTool);
    this.toolHandlers.set("UpdatePlan", handleUpdatePlanTool);
    this.toolHandlers.set("WebSearch", handleWebSearchTool);
    // P1-T2：PureShowWidget 工具 handler 注册
    //
    // 说明：handler 与 tool definition 的启用条件可能不一致：
    //   - tool definition：由 getTools(options) 根据 enabledSkills["dynamic-ui"] 条件加入
    //   - handler：始终注册（与 tool definition 解耦）
    // 当 tool 未注册时 LLM 不会发起调用，handler 注册不会产生副作用；
    // 当 tool 已注册时 handler 必须存在，否则会触发 "Unknown tool" 错误。
    // 这里采用「始终注册 handler」策略，简化条件管理，与 V2-P6 codemap 工具扩展模式一致。
    this.toolHandlers.set("pure_show_widget", handlePureShowWidget);
  }

  /**
   * 注册外部工具 handler（公开 API，供 V2 / Phase 4 等扩展模块注入工具）
   *
   * 与私有 registerToolHandlers() 区分：
   * - registerToolHandlers()：私有，构造时批量注册内置工具（bash/read/write/edit 等）
   * - registerToolHandler(name, handler)：公开，运行期动态注册外部工具
   *
   * 使用场景：
   * - V2-P6 Phase 4 codemap 工具注册（codemap_query / impact_analysis /
   *   flow_trace / risk_scan，通过 registerCodemapTools() 调用本方法）
   * - MCP 工具以外的自定义工具扩展
   * - 测试场景注入临时工具 handler
   *
   * 重复注册行为：
   * - 同名工具重复注册时，新 handler 覆盖旧 handler（与 Map.set 语义一致）
   * - 调用方应避免意外覆盖内置工具（bash/read/write/edit 等）
   *
   * 兼容性保证（向后兼容 Phase 1-3）：
   * - 本方法仅追加，不修改现有内置工具注册逻辑
   * - 不影响现有工具调度（executeToolCall 优先查询 toolHandlers Map）
   *
   * @param name 工具名称（与 LLM function calling 的 name 一致）
   * @param handler 工具 handler（(args, context) => Promise<ToolExecutionResult>）
   */
  readonly registerToolHandler = (name: string, handler: ToolHandler): void => {
    // 参数校验：name 必须为非空字符串，handler 必须为函数
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(
        "registerToolHandler 失败：name 必须为非空字符串（Tool handler name must be a non-empty string）"
      );
    }
    if (typeof handler !== "function") {
      throw new Error("registerToolHandler 失败：handler 必须为函数（Tool handler must be a function）");
    }
    // 注册 handler（同名覆盖，与 Map.set 语义一致）
    this.toolHandlers.set(name, handler);
  };

  private parseToolCall(toolCall: unknown): ToolCall | null {
    if (!toolCall || typeof toolCall !== "object") {
      return null;
    }

    const record = toolCall as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };

    if (typeof record.id !== "string") {
      return null;
    }

    const functionRecord = record.function;
    if (!functionRecord || typeof functionRecord !== "object") {
      return null;
    }

    if (typeof functionRecord.name !== "string") {
      return null;
    }

    const rawArguments = typeof functionRecord.arguments === "string" ? functionRecord.arguments : "";

    return {
      id: record.id,
      type: "function",
      function: {
        name: functionRecord.name,
        arguments: rawArguments,
      },
    };
  }

  private async executeToolCall(
    sessionId: string,
    toolCall: ToolCall,
    hooks?: ToolExecutionHooks
  ): Promise<ToolExecutionResult> {
    const toolName = toolCall.function.name;
    const handlerName = BUILT_IN_TOOL_NAME_ALIASES.get(toolName) ?? toolName;
    const handler = this.toolHandlers.get(handlerName);
    if (!handler) {
      if (this.mcpManager?.isMcpTool(toolName)) {
        const parsedArgs = this.parseToolArguments(toolCall.function.arguments);
        const args = parsedArgs.ok ? parsedArgs.args : {};
        return this.mcpManager.executeMcpTool(toolName, args);
      }
      return {
        ok: false,
        name: toolName,
        error: `Unknown tool: ${toolName}`,
      };
    }

    const parsedArgs = this.parseToolArguments(toolCall.function.arguments);
    if (!parsedArgs.ok) {
      return {
        ok: false,
        name: toolName,
        error: parsedArgs.error,
      };
    }

    try {
      // P0 安全修复：对 bash 等高危工具做 fail-closed 兜底校验，避免调用方未注入
      // onBeforeToolExecution 守卫时直接执行危险命令。该检查与 bash-handler 内部守卫
      // 形成双重防线，不替代 EAG-P5 的完整 BlockerGuardChain。
      if (handlerName === "bash") {
        const command = typeof parsedArgs.args.command === "string" ? parsedArgs.args.command : "";
        const guardReason = checkDangerousBashCommand(command);
        if (guardReason) {
          return {
            ok: false,
            name: toolName,
            error: `ToolExecutor guard blocked bash command: ${guardReason}`,
          };
        }
      }

      // V2 钩子：工具执行前审批
      // 在 handler 调用前调用 onBeforeToolExecution 钩子进行审批决策
      // 向后兼容：未提供钩子时（undefined）跳过决策，按原流程执行
      //
      // v2.4 修订（P0-05 修复）：钩子签名升级为 async（返回 Promise），
      // 必须使用 await 解包以支持 V2-P0b side-git 快照创建等异步操作。
      // V1 既有同步钩子需迁移为 async（返回 Promise）。
      if (hooks?.onBeforeToolExecution) {
        const decision = await hooks.onBeforeToolExecution(toolName, parsedArgs.args);
        // deny：审批拒绝，直接返回失败结果（不执行 handler）
        if (decision === "deny") {
          return {
            ok: false,
            name: toolName,
            error: "工具执行被审批门控拒绝（Tool execution denied by approval gate）",
          };
        }
        // ask_user：需要用户确认，返回 awaitUserResponse 标志由调用方处理
        if (decision === "ask_user") {
          return {
            ok: false,
            name: toolName,
            error: "需要用户确认（User confirmation required）",
            awaitUserResponse: true,
          };
        }
        // decision === "approve" → 继续执行 handler
      }

      const result = await handler(parsedArgs.args, {
        sessionId,
        projectRoot: this.projectRoot,
        toolCall,
        createOpenAIClient: this.createOpenAIClient,
        createLLMClient: this.createLLMClient,
        onProcessStart: hooks?.onProcessStart,
        onProcessExit: hooks?.onProcessExit,
        onProcessStdout: hooks?.onProcessStdout,
        onProcessTimeoutControl: hooks?.onProcessTimeoutControl,
        onBackgroundProcessComplete: hooks?.onBackgroundProcessComplete,
        onBeforeFileMutation: hooks?.onBeforeFileMutation,
        onAfterFileMutation: hooks?.onAfterFileMutation,
      });

      // V2 钩子：工具执行结果后处理
      // handler 返回后调用 onAfterToolExecution 钩子，允许对结果进行增强（如 diff 预览增强）
      // 命名说明（V2.3 P1-04）：原名 onToolResult，统一更名与 onBeforeToolExecution 对称，
      // 只在 ToolExecutor 层触发一次，文件级钩子（onAfterFileMutation）不重复处理
      // 向后兼容：未提供钩子时（undefined）直接返回 handler 原始结果
      if (hooks?.onAfterToolExecution) {
        return hooks.onAfterToolExecution(result, { toolName, args: parsedArgs.args });
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        name: toolName,
        error: message,
      };
    }
  }

  private parseToolArguments(
    rawArguments: string
  ): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
    if (!rawArguments) {
      return { ok: true, args: {} };
    }

    try {
      const parsed = JSON.parse(rawArguments);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "InputParseError: Tool arguments must be a JSON object." };
      }
      return { ok: true, args: parsed as Record<string, unknown> };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error:
          `InputParseError: Failed to parse tool arguments: ${message}. ` +
          "Ensure the tool call arguments are valid JSON. Prefer Edit over Write for large existing-file changes.",
      };
    }
  }

  private formatToolResult(result: ToolExecutionResult): string {
    const payload: Record<string, unknown> = {
      ok: result.ok,
      name: result.name,
    };

    if (typeof result.output !== "undefined") {
      payload.output = result.output;
    }

    if (result.error) {
      payload.error = result.error;
    }

    if (result.metadata && Object.keys(result.metadata).length > 0) {
      payload.metadata = result.metadata;
    }

    if (result.awaitUserResponse === true) {
      payload.awaitUserResponse = true;
    }

    return JSON.stringify(payload, null, 2);
  }
}
