import type OpenAI from "openai";
import type { ReasoningEffort } from "../settings";

export type CreateOpenAIClient = () => {
  client: OpenAI | null;
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
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ToolExecutionContext = {
  sessionId: string;
  projectRoot: string;
  toolCall: ToolCall;
  createOpenAIClient?: CreateOpenAIClient;
  onProcessStart?: (processId: string | number, command: string) => void;
  onProcessExit?: (processId: string | number) => void;
  onProcessStdout?: (processId: string | number, chunk: string) => void;
  onProcessTimeoutControl?: (processId: string | number, control: ProcessTimeoutControl | null) => void;
  onBackgroundProcessComplete?: (completion: BackgroundProcessCompletion) => void;
  onBeforeFileMutation?: (filePath: string) => void;
  onAfterFileMutation?: (filePath: string) => void;
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
  role: "system";
  content: string;
  contentParams?: unknown | null;
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
