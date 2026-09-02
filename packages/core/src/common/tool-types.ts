import type OpenAI from "openai";
import type sharp from "sharp";
import type { ReasoningEffort } from "../settings";
import type { LLMClient } from "../providers/llm-provider";

export type CreateOpenAIClient = () => {
  client: OpenAI | null;
  /** 上游 v0.3.1 新增：当前生效的 API Key（供调用方区分主 Key 与 plusApiKey 场景） */
  apiKey?: string;
  model: string;
  baseURL?: string;
  temperature?: number;
  thinkingEnabled: boolean;
  reasoningEffort?: ReasoningEffort;
  debugLogEnabled?: boolean;
  telemetryEnabled?: boolean;
  notify?: string;
  webSearchTool?: string;
  env?: Record<string, string>;
  machineId?: string;
  /** 上游 v0.3.1 新增：PLUS_API_KEY 对应的备用密钥（插件增强能力专用） */
  plusApiKey?: string;
};

/**
 * 统一 LLM 客户端工厂（B1：provider 路由入口）
 *
 * 返回 null 表示无可用凭据（对齐 CreateOpenAIClient 中 client:null 的静默降级语义），
 * 调用方按「LLM 辅助能力不可用」处理（跳过增强逻辑，不报错）。
 */
export type CreateLLMClient = () => LLMClient | null;

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

/** 上游 v0.3.1 新增：受插件限流影响的工具名单（图片理解 / 网络搜索） */
export type PluginRateLimitedTool = "UnderstandImage" | "WebSearch";

/** 上游 v0.3.1 新增：sharp 模块懒加载器（图片工具按需加载，避免 CLI 启动期强依赖） */
export type SharpLoader = () => Promise<typeof sharp>;

export type ToolExecutionContext = {
  sessionId: string;
  projectRoot: string;
  toolCall: ToolCall;
  createOpenAIClient?: CreateOpenAIClient;
  /** B1：统一 LLM 客户端工厂（provider 路由），edit-handler 等 LLM 辅助调用经此发起 */
  createLLMClient?: CreateLLMClient;
  /** 上游 v0.3.1 新增：sharp 懒加载器，ReadImage/UnderstandImage 图片工具使用 */
  loadSharp?: SharpLoader;
  onProcessStart?: (processId: string | number, command: string) => void;
  onProcessExit?: (processId: string | number) => void;
  onProcessStdout?: (processId: string | number, chunk: string) => void;
  onProcessTimeoutControl?: (processId: string | number, control: ProcessTimeoutControl | null) => void;
  onBackgroundProcessComplete?: (completion: BackgroundProcessCompletion) => void;
  onBeforeFileMutation?: (filePath: string) => void;
  onAfterFileMutation?: (filePath: string) => void;
  /** 上游 v0.3.1 新增：插件限流触发回调（UnderstandImage/WebSearch 命中限流时通知 UI） */
  onPluginRateLimitExceeded?: (tool: PluginRateLimitedTool) => void;
  /** 上游 v0.3.1 新增：技能加载回调，skill-handler 通过它按需加载技能内容 */
  onLoadSkill?: (skillName: string) => Promise<ToolExecutionResult>;
  bashTimeoutMs?: number;
  bashMinTimeoutMs?: number;
};

export type ToolExecutionHooks = {
  onProcessStart?: (processId: string | number, command: string) => void;
  onProcessExit?: (processId: string | number) => void;
  onProcessStdout?: (processId: string | number, chunk: string) => void;
  onProcessTimeoutControl?: (processId: string | number, control: ProcessTimeoutControl | null) => void;
  onBackgroundProcessComplete?: (completion: BackgroundProcessCompletion) => void;
  onBeforeFileMutation?: (filePath: string) => void;
  onAfterFileMutation?: (filePath: string) => void;
  /** 上游 v0.3.1 新增：插件限流触发回调（UnderstandImage/WebSearch 命中限流时通知 UI） */
  onPluginRateLimitExceeded?: (tool: PluginRateLimitedTool) => void;
  /** 上游 v0.3.1 新增：技能加载回调，skill-handler 通过它按需加载技能内容 */
  onLoadSkill?: (skillName: string) => Promise<ToolExecutionResult>;
  shouldStop?: () => boolean;
  /**
   * V2 新增：工具执行前的审批钩子
   *
   * 在 handler 调用之前执行，用于 ApprovalGate 决策。
   * 钩子返回值决定后续行为：
   * - "approve"：放行，继续执行 handler
   * - "deny"：拒绝执行，executor 直接返回失败结果
   * - "ask_user"：需要用户确认，executor 返回 awaitUserResponse=true 的结果
   *
   * v2.4 修订（P0-05 修复）：钩子签名从同步升级为 async（返回 Promise），
   * 支持 V2-P0b side-git 快照创建（SideGitManager.createSnapshot 为 async）。
   * ToolRouter.route() 内部需 await SideGitRecovery + SideGitManager，
   * 因此钩子必须 async 化以支持此调用链。
   *
   * 向后兼容：
   * - 未提供此钩子时（undefined），executor 按原流程直接执行 handler；
   * - 钩子返回 Promise 时 executor.ts 用 await 解包；
   * - V1 既有同步钩子需迁移为 async（返回 Promise）。
   *
   * @param toolName 工具名称（已应用别名映射前的原始名称）
   * @param args 工具参数（已解析的 JSON 对象）
   * @returns 审批决策的 Promise（async 支持内部 await side-git 操作）
   */
  onBeforeToolExecution?: (toolName: string, args: Record<string, unknown>) => Promise<"approve" | "deny" | "ask_user">;
  /**
   * V2 新增：工具执行结果后处理钩子
   *
   * 在 handler 返回后执行，可修改返回结果。
   * 典型用途：edit-handler-hook 在 edit/write 工具成功后，
   * 使用 enhanceDiffPreview 生成增强的 diff 预览替换原 diff_preview 字段。
   *
   * 命名说明（V2.3 P1-04）：原名 onToolResult，统一更名为 onAfterToolExecution，
   * 与 onBeforeToolExecution 及 V1 文件级钩子（onBeforeFileMutation /
   * onAfterFileMutation）前缀对称；本钩子只在 ToolExecutor 层触发一次，
   * edit 的 diff 增强仅由本钩子执行，文件级钩子不重复处理
   *（详见技术方案 §9.0 钩子命名与触发表）。
   *
   * 向后兼容：未提供此钩子时（undefined），executor 直接返回 handler 原始结果。
   *
   * @param result 工具执行结果（handler 返回的原始结果）
   * @param context 工具执行上下文（工具名称和参数）
   * @returns 处理后的结果（可能被修改，也可能原样返回）
   */
  onAfterToolExecution?: (
    result: ToolExecutionResult,
    context: { toolName: string; args: Record<string, unknown> }
  ) => ToolExecutionResult;
};

export type BackgroundProcessCompletion = {
  taskId: string;
  processId: number;
  command: string;
  outputPath: string;
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  error?: string;
  cwd: string | null;
  shellPath: string;
  startedAtMs: number;
  completedAtMs: number;
};

export type ProcessTimeoutInfo = {
  timeoutMs: number;
  startedAtMs: number;
  deadlineAtMs: number;
  timedOut: boolean;
};

export type ProcessTimeoutControl = {
  getInfo: () => ProcessTimeoutInfo;
  setTimeoutMs: (timeoutMs: number) => ProcessTimeoutInfo;
};

export type ToolExecutionResult = {
  ok: boolean;
  name: string;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  awaitUserResponse?: boolean;
  followUpMessages?: ToolExecutionFollowUpMessage[];
};

export type ToolExecutionFollowUpMessage = {
  // 上游 v0.3.1 扩展：role 放宽为 "system" | "user"，新增 visible 控制是否对用户可见
  role: "system" | "user";
  content: string;
  contentParams?: unknown | null;
  visible?: boolean;
};

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext
) => Promise<ToolExecutionResult>;

export type ToolCallExecution = {
  toolCallId: string;
  content: string;
  result: ToolExecutionResult;
};
