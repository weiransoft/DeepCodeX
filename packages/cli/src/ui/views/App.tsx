import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useStdout, useWindowSize } from "ink";
import chalk from "chalk";
// fork：保留 node 内置模块与 getDeepCodeXLogDir 依赖（动态注入/后台任务/团队命令需要）
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { createOpenAIClient, getDeepCodeXLogDir } from "@vegamo/deepcode-core";
import type { PermissionScope } from "@vegamo/deepcode-core";
import { type ModelConfigSelection } from "@vegamo/deepcode-core";
import { type PromptDraft, PromptInput, type PromptSubmission } from "./PromptInput";
import { MessageView, RawModeExitPrompt } from "../components";
import { SessionList } from "./SessionList";
import { type UndoRestoreMode, UndoSelector } from "./UndoSelector";
import { buildLoadingText } from "../core/loading-text";
import { findExpandedThinkingId } from "../core/thinking-state";
import { WelcomeScreen } from "./WelcomeScreen";
import { AskUserQuestionPrompt } from "./AskUserQuestionPrompt";
import { McpStatusList } from "./McpStatusList";
import { ProcessStdoutView } from "./ProcessStdoutView";
import {
  type AskUserQuestionAnswers,
  findPendingAskUserQuestion,
  formatAskUserQuestionAnswers,
} from "../core/ask-user-question";
import { PermissionPrompt, type PermissionPromptResult } from "./PermissionPrompt";
import { PlanImplementationPrompt, extractProposedPlan, getImplementationPrompt } from "./PlanImplementationPrompt";
// 上游 v0.3.1 新增 buildPluginRateLimitHintText：插件工具限流（429）退出提示
import { buildExitSummaryText, buildPluginRateLimitHintText, buildResumeHintText } from "../exit-summary";
import { RawMode, useRawModeContext } from "../contexts";
import { renderMessageToStdout } from "../components/MessageView/utils";
import {
  buildPromptDraftFromSessionMessage,
  // fork：buildSyntheticAssistantMessage 用于注入类合成消息；上游新增 buildPromptHistory（exec 模式历史构建）
  buildPromptHistory,
  buildStatusLine,
  buildSyntheticAssistantMessage,
  buildSyntheticUserMessage,
  formatModelConfig,
  isCurrentSessionEmpty,
  renderRawModeMessages,
} from "../utils";
import { resolveCurrentSettings, writeModelConfigSelection } from "@vegamo/deepcode-core";
import { useStatusLine } from "../hooks";
import type { SessionInfo } from "../statusline";
import { isCollapsedThinking } from "../core/thinking-state";
import { ANSI_CLEAR_SCREEN } from "../constants";
// ADR-DI-001 动态注入与后台子 Agent 命令辅助函数（fork 特有，保留）
import { extractCommandArgument, isResumeTaskCommand, BUILTIN_SLASH_COMMANDS } from "../core/slash-commands";
// 建议循环客户端兜底（2026-09-03）：从回合收尾文本提取"建议执行 /xxx"命令 + 可自动执行白名单
import { AUTO_EXECUTABLE_COMMAND_KINDS, extractSuggestedCommandText } from "../core/suggestion-fallback";
import type {
  LlmStreamProgress,
  MessageMeta,
  SessionEntry,
  SessionMessage,
  SessionStatus,
  SkillInfo,
  UndoTarget,
  UserPromptContent,
} from "@vegamo/deepcode-core";
import { SessionManager } from "@vegamo/deepcode-core";
// fork：以下大段为 fork 特有依赖（动态注入/后台任务/EAG 编排/团队命令），整体保留
import { getCompactPromptTokenThreshold } from "@vegamo/deepcode-core";
import {
  createEagDynamicSuggester,
  ProviderFactory,
  type DynamicCommandDescriptor,
  type EagDynamicSuggester,
} from "@vegamo/deepcode-core";
// ADR-DI-001 动态指令注入与后台子 Agent 组件 + V2 上下文钩子工厂
import {
  InterruptQueue,
  TaskRegistry,
  BackgroundTaskRunner,
  DefaultSessionContextHook,
  createDualLayerContextHook,
  buildV2Config,
} from "@vegamo/deepcode-core";
// V2 上下文钩子相关类型
import type { SessionContextHook, V2Config } from "@vegamo/deepcode-core";
// EAG P5 编排器装配（2026-07-31 新特性集成审查 FIX-1/FIX-2）：
// 真实构造 AutonomousOrchestrator 与 GraphLoopOrchestratorOptions 并注入 SessionManager，
// 使 /eag-autonomous 三命令与 /eag-graph 在生产 CLI 可用（此前从未接线，命令 fail-closed）
// S3.2（2026-08-19）：追加 buildDesignOrchestrator，装配 DESIGN Loop 三角色编排器
// （LlmProductManager + FeedbackAwareArchitect + FeedbackCapturingEvaluator），
// 使 /eag-design 命令在生产 CLI 可用（此前 PM/Architect 协议无生产实现，命令 fail-closed）
import {
  buildAutonomousOrchestrator,
  buildGraphLoopOrchestratorOptions,
  buildDesignOrchestrator,
  type AssemblyLogCallback,
} from "../core/eag-orchestrator-assembly";
import { buildDynamicCommandDescriptors } from "../core/dynamic-commands";
import { writeStdout, writeStdoutLine } from "../../utils/stdio-helpers";
// 导入 TeamCommandArgs 类型，用于 team 命令调用参数类型标注
// 注意：仅导入类型（import type），不导入运行时值，避免增加启动开销
import type { TeamCommandArgs } from "../../team/team-cmd";
// S2（2026-08-19）：parseTeamArgs 从本文件抽取到 ui/core/parse-team-args.ts，
// 使 TUI 参数解析可独立单测，并修复 failFast 三态语义（--no-fail-fast 此前不可达）
import { parseTeamArgs } from "../core/parse-team-args";

type View = "chat" | "session-list" | "undo" | "mcp-status";

/**
 * ADR-DI-001 中断能力扩展接口（SessionManager 的可选能力）
 *
 * SessionManager 通过可选注入 InterruptQueue / TaskRegistry / BackgroundTaskRunner
 * 获得这些能力（§7.1 改动 1-3）。未注入对应组件时方法不存在，App 层需做防御性检查。
 *
 * 具体实现由 `packages/core/src/session.ts` 的 SessionManager 类扩展（另一个子代理实现）。
 * 此接口在 CLI 层本地定义，避免与 core 内部类型耦合（仅声明 CLI 所需的最小方法集）。
 */
interface InterruptibleSession {
  /** 向当前任务追加指令（/inject 入口） */
  injectInstruction?(text: string, source?: "user" | "llm"): void;
  /** 后台启动新子 agent（/bg + background_task 工具入口） */
  startBackgroundTask?(
    prompt: { text?: string },
    kind?: "chat" | "autonomous"
  ): Promise<{ taskId: string; sessionId: string }>;
  /** 列出所有任务（/tasks + list_tasks 工具入口） */
  listTasks?(filter?: { includeHistory?: boolean }): ReadonlyArray<{
    id: string;
    kind: "chat" | "autonomous";
    state: string;
    progress: number;
    stats: { durationMs: number };
    initialPromptText: string;
  }>;
  /** 切换前台关注（/fg 入口） */
  setForegroundTask?(taskId: string): void;
  /** 取消指定任务（/cancel + cancel_task 工具入口） */
  cancelTask?(taskId: string, reason?: string): void;
  /** 暂停当前前台任务（/pause 入口） */
  pauseActiveTask?(): void;
  /** 恢复暂停的任务（/resume <taskId> 入口） */
  resumeTask?(taskId: string): Promise<void>;
}

const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * 当前 LLM 正在执行时，判断提交是否属于“控制类命令”。
 *
 * 这类命令不占用 LLM 回合，可以直接执行：
 * - exit / new / resume / undo / mcp / rules / team
 * - 任务管理：inject / bg / tasks / fg / cancel / pause
 *
 * 可能触发新 LLM 调用的命令（/init、非空会话的 /continue 等）以及普通文本默认不通过这里判断，
 * 而是由 isUrgentIntervention 进一步决定是插队中断还是排队。
 */
function isImmediateControlCommand(
  submission: { command?: string; text?: string },
  sessionManager: SessionManager
): boolean {
  const IMMEDIATE_COMMANDS = new Set([
    "exit",
    "new",
    "resume",
    "undo",
    "mcp",
    "rules",
    "team",
    "inject",
    "bg",
    "tasks",
    "fg",
    "cancel",
    "pause",
  ]);
  const cmd = submission.command;
  if (!cmd) return false;
  if (cmd === "continue") {
    return isCurrentSessionEmpty(sessionManager);
  }
  return IMMEDIATE_COMMANDS.has(cmd);
}

/**
 * 判断提交是否属于对当前正在运行的 LLM 回合的“紧急干预”。
 *
 * 当 LLM 正在思考/执行但明显出错，或用户需要立即纠正、停止、重试时，
 * 应当立刻中断当前回合，并用该消息重新驱动。
 *
 * 命中规则包括（中英混合，不区分大小写）：
 * - 停止/取消：stop / cancel / abort / halt / quit / enough、别 / 停 / 取消 / 停止 / 放弃 / 终止 / 够了 / 不要
 * - 纠正/重试：wrong / incorrect / mistake / fix / retry / redo / rewind / rethink、
 *   错了 / 不对 / 不正确 / 有误 / 改一下 / 修改 / 修正 / 纠正 / 重新 / 重来 / 重试 / 应该 / 不是 / 要用 / 改为 / 换成 / check / think again / 反思
 * - 紧急优先：urgent / immediate / asap、马上 / 立即 / 立刻 / 优先
 */
function isUrgentIntervention(submission: { command?: string; text?: string }): boolean {
  if (submission.command === "inject") return true;
  const text = submission.text?.trim().toLowerCase() ?? "";
  if (!text) return false;
  const URGENT_PATTERNS = [
    "stop",
    "cancel",
    "abort",
    "halt",
    "quit",
    "enough",
    "别",
    "停",
    "取消",
    "停止",
    "放弃",
    "终止",
    "够了",
    "不要",
    "wrong",
    "incorrect",
    "mistake",
    "fix",
    "retry",
    "redo",
    "rewind",
    "rethink",
    "错了",
    "不对",
    "不正确",
    "有误",
    "改一下",
    "修改",
    "修正",
    "纠正",
    "重新",
    "重来",
    "重试",
    "应该",
    "不是",
    "要用",
    "改为",
    "换成",
    "check",
    "think again",
    "反思",
    "urgent",
    "immediate",
    "asap",
    "马上",
    "立即",
    "立刻",
    "优先",
  ];
  return URGENT_PATTERNS.some((pattern) => text.includes(pattern));
}

type AppProps = {
  projectRoot: string;
  initialPrompt?: string;
  resumeSessionId?: string | true;
  // 上游 v0.3.1 新增：/fork 会话分叉的源会话 ID
  forkSessionId?: string;
  onRestart?: () => void;
};

const StatusLine = React.memo(function StatusLine({
  busy,
  text,
}: {
  busy: boolean;
  text?: string;
}): React.ReactElement {
  const [spinnerIndex, setSpinnerIndex] = useState(0);

  useEffect(() => {
    if (!busy) {
      setSpinnerIndex(0);
      return;
    }

    const timer = setInterval(() => {
      setSpinnerIndex((index) => (index + 1) % STATUS_SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, [busy]);

  return (
    <Box>
      {busy ? (
        <Box marginRight={1}>
          <Text color="yellow">{STATUS_SPINNER_FRAMES[spinnerIndex]}</Text>
        </Box>
      ) : null}
      {text ? <Text dimColor>{text}</Text> : null}
    </Box>
  );
});

// 上游 v0.3.1：函数签名新增 forkSessionId（会话分叉）
function App({ projectRoot, initialPrompt, resumeSessionId, forkSessionId, onRestart }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout, write } = useStdout();
  const { columns, rows } = useWindowSize();
  const { mode, setMode } = useRawModeContext();
  const initialPromptSubmittedRef = useRef(false);
  // 上游 v0.3.1 新增：resume 会话去重标记；fork 保留截断提示去重（FIX-12）
  const resumeSessionIdRef = useRef(false);
  const startupDoneRef = useRef(false);
  const processStdoutRef = useRef<Map<number, string>>(new Map());
  // FIX-12（多角色审查 2026-07-29）：记录已追加截断提示的进程 PID，避免重复提示
  const truncatedPidsRef = useRef<Set<number>>(new Set());
  const rawModeRef = useRef<RawMode>(mode);
  const writeRef = useRef(write);
  const lastRenderedColumnsRef = useRef<number | null>(null);
  const messagesRef = useRef<SessionMessage[]>([]);
  const [view, setView] = useState<View>("chat");
  const [busy, setBusy] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [undoTargets, setUndoTargets] = useState<UndoTarget[]>([]);
  const [promptDraft, setPromptDraft] = useState<PromptDraft | null>(null);
  const [statusLine, setStatusLine] = useState<string>("");
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [streamProgress, setStreamProgress] = useState<LlmStreamProgress | null>(null);
  const [runningProcesses, setRunningProcesses] = useState<SessionEntry["processes"]>(null);
  const [activeStatus, setActiveStatus] = useState<SessionStatus | null>(null);
  const [activeAskPermissions, setActiveAskPermissions] = useState<SessionEntry["askPermissions"]>(undefined);
  const [pendingPermissionReply, setPendingPermissionReply] = useState<{
    sessionId: string;
    permissions: PermissionPromptResult["permissions"];
    alwaysAllows: PermissionScope[];
  } | null>(null);
  const [dismissedQuestionIds, setDismissedQuestionIds] = useState<Set<string>>(() => new Set());
  const [isExiting, setIsExiting] = useState(false);
  const [showWelcome, setShowWelcome] = useState(true);
  const [welcomeNonce, setWelcomeNonce] = useState(0);
  const [resolvedSettings, setResolvedSettings] = useState(() => resolveCurrentSettings(projectRoot));
  // FIX-19（多角色审查 2026-07-29）：缓存当前模型与最大上下文窗口，
  // 用于 buildStatusLine 生成带模型名 + token 占比的状态栏（fork 特有，保留）
  const statusLineOptions = useMemo(() => {
    const model = resolvedSettings.model || "";
    const maxContextTokens = getCompactPromptTokenThreshold(model, resolvedSettings.contextWindow);
    return { model, maxContextTokens };
  }, [resolvedSettings]);
  const [nowTick, setNowTick] = useState(0);
  const [mcpStatuses, setMcpStatuses] = useState<ReturnType<typeof sessionManager.getMcpStatus>>([]);
  const [showProcessStdout, setShowProcessStdout] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [pendingPlanImplementation, setPendingPlanImplementation] = useState<string | null>(null);
  // fork：处理期间输入队列——允许用户在 LLM 回复过程中继续打字/回车，
  // 消息排入队列并在当前回合结束后自动连续发送（核心特性，保留）
  const pendingQueueRef = useRef<PromptSubmission[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const isProcessingRef = useRef(false);
  const handlePromptRef = useRef<(submission: PromptSubmission) => Promise<void>>(async () => {});
  // 建议循环客户端兜底（2026-09-03）：各会话已自动执行过的命令 kind 记录（sessionId → Set<kind>），
  // 同一 kind 每个会话只自动执行一次，防止"模型反复建议 → 反复注入"的无限循环
  const autoExecutedCommandsRef = useRef<Map<string, Set<string>>>(new Map());

  rawModeRef.current = mode;
  messagesRef.current = messages;

  const sessionManager = useMemo(() => {
    // 构造全局动态编排建议层
    // - createDecisionLLMClient 复用项目级 LLM 客户端
    // - 动态命令描述符由 CLI 层从真实命令来源（team/rules/slash）构造后注入
    const eagDynamicSuggester: EagDynamicSuggester = createEagDynamicSuggester({
      createDecisionLLMClient: () => {
        // 复用项目级 LLM 客户端：与 session.ts createLLMClient 同源
        // 通过 resolveCurrentSettings 解析 settings，再由 ProviderFactory 路由创建 LLMClient
        const settings = resolveCurrentSettings(projectRoot);
        if (!settings.apiKey) {
          return null;
        }
        return ProviderFactory.create(settings);
      },
      enabled: true,
      confidenceThreshold: 0.6,
      maxDecisionTokens: 2048,
    });

    // 构造外部命令描述符（team/rules/slash），注入 SessionManager
    const dynamicCommandDescriptors: ReadonlyArray<DynamicCommandDescriptor> = buildDynamicCommandDescriptors();

    // V2 Session 上下文钩子：根据 settings.json 与环境变量构造 DualLayerContextHook
    // 未启用 V2 总开关或上下文子开关时，createDualLayerContextHook 内部降级为
    // DefaultSessionContextHook，preBuildContext 返回空数组，行为与 v1 完全一致（零回归）
    const v2Config = buildV2Config(projectRoot);
    const contextHook: SessionContextHook = createDualLayerContextHook(projectRoot, v2Config);

    // EAG P5 编排器装配（2026-07-31 新特性集成审查 FIX-1/FIX-2）
    // 真实构造 AutonomousOrchestrator 与 GraphLoopOrchestratorOptions，
    // 注入主 SessionManager 使 /eag-autonomous 三命令与 /eag-graph 生产可用。
    // 失败安全：装配异常时返回 undefined，session.ts 维持 fail-closed 降级（命令报"未注入"），
    // 主对话循环行为完全不变（零回归），装配失败详情见 ~/.deepcodex/logs/eag-assembly.log。
    const eagAssemblyLog = createEagAssemblyLogger();
    const autonomousOrchestrator = buildAutonomousOrchestrator(eagAssemblyLog);
    const graphLoopOrchestratorOptions = buildGraphLoopOrchestratorOptions(projectRoot, eagAssemblyLog);
    // S3.2（2026-08-19）：DESIGN Loop 三角色编排器装配（/eag-design 执行体）。
    // LLM 客户端工厂与 eagDynamicSuggester.createDecisionLLMClient 同源：
    // 每次角色调用时惰性解析 settings 并经 ProviderFactory 路由创建，
    // 无凭据时返回 null（角色抛 DesignRoleError，session.ts 通知用户后标记 failed）。
    // 失败安全：装配异常时返回 undefined，/eag-design 维持 fail-closed 降级。
    const designOrchestrator = buildDesignOrchestrator(() => {
      const settings = resolveCurrentSettings(projectRoot);
      if (!settings.apiKey) {
        return null;
      }
      return ProviderFactory.create(settings);
    }, eagAssemblyLog);

    // ADR-DI-001 动态指令注入与后台子 Agent 组件
    // 所有组件均为可选注入；未注入时对应命令不可用，主对话循环行为完全不变（零回归）
    const taskRegistry = new TaskRegistry({
      onTaskStateChanged: () => {
        // 任务状态变更时刷新 UI 中的任务列表（如未来支持任务视图）
        // 当前最小实现：仅触发一次状态更新以确保 React 捕获变更
        setNowTick((tick) => tick + 1);
      },
    });
    const interruptQueue = new InterruptQueue();
    const backgroundRunner = new BackgroundTaskRunner({
      sharedSessionOptions: {
        sessionManagerFactory: (_taskId, _controller) => {
          // 后台任务使用独立的 SessionManager 实例（D-1 决策）
          // 独立 InterruptQueue / AbortController / contextHook，避免影响前台
          // 注意：_controller 由 BackgroundTaskRunner 提供，当前 SessionManager.handleUserPrompt
          // 内部自行创建 AbortController，因此此处暂不将外部 controller 接入主循环取消链路
          // （后续可在 SessionManager 增加外部 controller 注入点以完善后台任务取消语义）
          const bgInterruptQueue = new InterruptQueue();
          const bgContextHook = new DefaultSessionContextHook();
          const bgManager = new SessionManager({
            projectRoot,
            createOpenAIClient: () => createOpenAIClient(projectRoot),
            getResolvedSettings: () => resolveCurrentSettings(projectRoot),
            renderMarkdown: (text) => text,
            isForeground: false,
            interruptQueue: bgInterruptQueue,
            taskRegistry,
            contextHook: bgContextHook,
            // EAG P5 编排器注入（2026-07-31 FIX-1/FIX-2）：
            // 后台任务共享前台已装配的编排器实例——AutonomousOrchestrator 按 runId
            // 隔离运行状态（P5RunStateStore JSONL 持久化），GraphLoopOrchestratorOptions
            // 为不可变装配配置，二者均可安全跨会话共享
            // S3.2（2026-08-19）：designOrchestrator 同样可跨会话共享——run() 入口
            // 重置运行时状态，FeedbackAwareArchitect 反馈与 requirement 对象引用绑定
            autonomousOrchestrator,
            graphLoopOrchestratorOptions,
            designOrchestrator,
            onAssistantMessage: () => {
              // 后台任务的助手消息不写入前台 UI，由 TaskRegistry 状态间接反映进度
            },
            onSessionEntryUpdated: () => {
              // 后台任务会话状态变更不刷新前台状态栏
            },
            onLlmStreamProgress: () => {
              // 后台任务流式进度不展示到前台
            },
          });
          return {
            handleUserPrompt: async (prompt: string) => {
              await bgManager.handleUserPrompt({ text: prompt });
            },
          };
        },
      },
      registry: taskRegistry,
      onTaskStateChange: () => {
        setNowTick((tick) => tick + 1);
      },
    });

    // fork：以上为动态注入/后台任务/EAG 编排装配逻辑，整体保留
    return new SessionManager({
      projectRoot,
      createOpenAIClient: () => createOpenAIClient(projectRoot),
      getResolvedSettings: () => resolveCurrentSettings(projectRoot),
      renderMarkdown: (text) => text,
      // fork：EAG 动态建议层、外部命令描述符、V2 上下文钩子、EAG 编排器与
      // ADR-DI-001 动态注入/后台子 Agent 组件注入（fork 特有，保留）
      eagDynamicSuggester,
      dynamicCommandDescriptors,
      // V2 Session 上下文钩子注入
      contextHook,
      // EAG P5 编排器注入（2026-07-31 FIX-1/FIX-2）：
      // /eag-autonomous 三命令与 /eag-graph 的生产执行体（此前未注入，命令 fail-closed）
      // S3.2（2026-08-19）：designOrchestrator 为 /eag-design 的生产执行体
      // （DESIGN Loop：PM 结构化需求 → 架构师设计 → 评估器判定 → 失败带反馈重试）
      autonomousOrchestrator,
      graphLoopOrchestratorOptions,
      designOrchestrator,
      // ADR-DI-001 动态指令注入与后台子 Agent 注入
      interruptQueue,
      taskRegistry,
      backgroundRunner,
      onAssistantMessage: (message: SessionMessage) => {
        setMessages((prev) => [...prev, message]);
        if (rawModeRef.current === RawMode.Raw) {
          writeStdoutLine("\n");
          writeStdoutLine(renderMessageToStdout(message, rawModeRef.current) + "\n\n");
        }
      },
      onSessionEntryUpdated: (entry) => {
        // fork：使用带模型名 + token 占比的状态栏（FIX-19），并处理 ask_permission 死锁
        setStatusLine(buildStatusLine(entry, statusLineOptions));
        setRunningProcesses(entry.processes);
        setActiveStatus(entry.status);
        setActiveAskPermissions(entry.askPermissions);
        // FIX：当会话进入 ask_permission 状态时，需要把 busy 置为 false，
        // 否则 PermissionPrompt 的渲染条件包含 !busy，会导致权限确认框无法显示，
        // 从而阻塞 handleUserPrompt 的返回，形成死锁。
        if (entry.status === "ask_permission") {
          setBusy(false);
          setStreamProgress(null);
        }
      },
      onLlmStreamProgress: (progress) => {
        if (progress.phase === "end") {
          setStreamProgress(null);
          return;
        }
        setStreamProgress(progress);
      },
      onMcpStatusChanged: () => {
        // 当 MCP 状态变更时，如果当前正在查看 MCP 状态页面，则更新显示
        setMcpStatuses(sessionManager.getMcpStatus());
      },
      onProcessStdout: (pid, chunk) => {
        const buf = processStdoutRef.current;
        const current = buf.get(pid) ?? "";
        // Cap at 1 MB per process to avoid unbounded memory growth
        // on noisy or long-running commands like `yes` or verbose builds.
        const MAX_STDOUT_BUFFER = 1_000_000;
        if (current.length >= MAX_STDOUT_BUFFER) {
          // FIX-12（多角色审查 2026-07-29）：超限时追加一次截断提示，避免静默丢弃（fork 特有，保留）
          if (!truncatedPidsRef.current.has(pid)) {
            truncatedPidsRef.current.add(pid);
            buf.set(pid, current + "\n... [输出超 1MB 已截断]\n");
          }
          return;
        }
        const text = typeof chunk === "string" ? chunk : String(chunk);
        const available = MAX_STDOUT_BUFFER - current.length;
        buf.set(pid, current + text.slice(0, available));
      },
    });
  }, [projectRoot]);

  /**
   * Navigate to a sub-view.
   */
  const navigateToSubView = useCallback((targetView: View) => {
    setShowWelcome(false);
    setView(targetView);
  }, []);

  /**
   * Reset the static view to the welcome screen.
   */
  const resetStaticView = useCallback(
    (loadedMessages: SessionMessage[], options?: { clearScreen?: boolean }): Promise<void> => {
      if (options?.clearScreen) {
        writeStdout(ANSI_CLEAR_SCREEN);
      }
      setMessages([]);
      setWelcomeNonce((n) => n + 1);
      navigateToSubView("chat");
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          setMessages(loadedMessages);
          setShowWelcome(true);
          resolve();
        }, 0);
      });
    },
    [navigateToSubView]
  );

  useEffect(() => {
    if (!busy) {
      return;
    }
    const id = setInterval(() => setNowTick((tick) => tick + 1), 500);
    return () => clearInterval(id);
  }, [busy]);

  function loadVisibleMessages(manager: SessionManager, sessionId: string): SessionMessage[] {
    return manager.listSessionMessages(sessionId).filter((m) => m.visible);
  }

  const refreshSessionsList = useCallback((): void => {
    setSessions(sessionManager.listSessions());
  }, [sessionManager]);

  const refreshSkills = useCallback(
    async (sessionId?: string): Promise<void> => {
      try {
        const list = await sessionManager.listSkills(sessionId ?? sessionManager.getActiveSessionId() ?? undefined);
        setSkills(list);
      } catch {
        // ignore
      }
    },
    [sessionManager]
  );

  /**
   * Reset the app to the welcome screen.
   */
  const resetToWelcome = useCallback(async () => {
    writeRef.current(ANSI_CLEAR_SCREEN);
    sessionManager.setActiveSessionId(null);
    setStatusLine("");
    setErrorLine(null);
    setRunningProcesses(null);
    setActiveStatus(null);
    setActiveAskPermissions(undefined);
    setPendingPermissionReply(null);
    setPlanMode(false);
    setPendingPlanImplementation(null);
    setDismissedQuestionIds(new Set());
    await resetStaticView([]);
    await refreshSkills();
  }, [sessionManager, resetStaticView, refreshSkills]);

  /**
   * Refresh the list of sessions.
   */
  useEffect(() => {
    refreshSessionsList();
    void refreshSkills();
  }, [refreshSessionsList, refreshSkills]);

  // Eagerly create the OpenAI client on mount so the TCP+TLS connection
  // warmup (fire-and-forget inside createOpenAIClient) starts before the
  // user sends their first prompt.
  useEffect(() => {
    createOpenAIClient(projectRoot);
  }, [projectRoot]);

  /**
   * Initialize MCP servers.
   */
  useLayoutEffect(() => {
    const settings = resolveCurrentSettings(projectRoot);
    void sessionManager.initMcpServers(settings.mcpServers);
  }, [projectRoot, sessionManager]);

  /**
   * Dispose the session manager on unmount.
   */
  useEffect(() => {
    return () => {
      sessionManager.dispose();
    };
  }, [sessionManager]);

  writeRef.current = write;
  const handleExit = useCallback(
    ({ showCommand, showSummary }: { showCommand: boolean; showSummary: boolean }) => {
      setIsExiting(true);
      setTimeout(() => {
        const activeSessionId = sessionManager.getActiveSessionId();
        const session = activeSessionId ? sessionManager.getSession(activeSessionId) : null;
        const resumeHint = buildResumeHintText(activeSessionId ?? undefined);
        // 上游 v0.3.1 新增：插件工具限流（429）提示文本
        const rateLimitHint = buildPluginRateLimitHintText(session);

        writeStdoutLine("\n");
        if (showCommand) {
          writeStdoutLine(chalk.rgb(34, 154, 195)(" > /exit "));
          writeStdoutLine("\n");
        }
        if (showSummary) {
          const summary = buildExitSummaryText({ session, sessionId: activeSessionId ?? undefined });
          writeStdoutLine(summary);
          writeStdoutLine("\n");
        }
        if (resumeHint) {
          writeStdoutLine(resumeHint);
          // 上游 v0.3.1 新增：存在限流提示时追加输出
          if (rateLimitHint) {
            writeStdoutLine(rateLimitHint);
          }
          writeStdoutLine("\n");
        }

        sessionManager.dispose();
        exit();
      }, 0);
    },
    [exit, sessionManager]
  );

  const handlePrompt = useCallback(
    async (submission: PromptSubmission) => {
      if (submission.command === "exit") {
        handleExit({ showCommand: true, showSummary: true });
        return;
      }
      if (submission.command === "new") {
        if (onRestart) {
          onRestart();
        } else {
          await resetToWelcome();
          refreshSessionsList();
        }
        return;
      }
      if (submission.command === "resume") {
        // ADR-DI-001：检查是否为恢复暂停任务的场景（/resume <taskId>）
        if (isResumeTaskCommand(submission.text)) {
          const taskId = extractCommandArgument(submission.text, "resume");
          if (!taskId) {
            setErrorLine("✖ /resume <taskId> 缺少任务 ID 参数");
            return;
          }
          try {
            const interruptible = sessionManager as unknown as InterruptibleSession;
            if (typeof interruptible.resumeTask !== "function") {
              setErrorLine("✖ 任务恢复功能未启用（SessionManager 未注入 taskRegistry）");
              return;
            }
            await interruptible.resumeTask(taskId);
            setMessages((prev) => [
              ...prev,
              buildSyntheticUserMessage(submission.text, submission.imageUrls.length),
              buildSyntheticAssistantMessage(`[resume] Task ${taskId} resumed`),
            ]);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setErrorLine(`✖ 恢复任务失败：${message}`);
          }
          return;
        }
        // 原有行为：显示会话列表，选择恢复之前的对话
        refreshSessionsList();
        navigateToSubView("session-list");
        return;
      }
      // 上游 v0.3.1 新增：/fork 会话分叉命令——基于当前会话创建可独立演进的新会话
      if (submission.command === "fork") {
        const sourceSessionId = sessionManager.getActiveSessionId();
        if (!sourceSessionId) {
          setErrorLine("No active session to fork.");
          return;
        }
        try {
          const sessionId = sessionManager.forkSession(sourceSessionId);
          sessionManager.setActiveSessionId(sessionId);
          await resetStaticView(loadVisibleMessages(sessionManager, sessionId), { clearScreen: true });
          const session = sessionManager.getSession(sessionId);
          // fork：状态栏使用带模型名 + token 占比的 statusLineOptions（FIX-19）
          setStatusLine(session ? buildStatusLine(session, statusLineOptions) : "");
          setRunningProcesses(null);
          setActiveStatus(session?.status ?? null);
          setActiveAskPermissions(undefined);
          setPlanMode(session?.planMode === true);
          setPendingPlanImplementation(null);
          setPendingPermissionReply(null);
          setErrorLine(null);
          refreshSessionsList();
          await refreshSkills(sessionId);
        } catch (error) {
          setErrorLine(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (submission.command === "continue" && isCurrentSessionEmpty(sessionManager)) {
        refreshSessionsList();
        navigateToSubView("session-list");
        return;
      }
      if (submission.command === "undo") {
        const activeSessionId = sessionManager.getActiveSessionId();
        if (!activeSessionId) {
          setErrorLine("No active session to undo.");
          return;
        }
        setUndoTargets(sessionManager.listUndoTargets(activeSessionId));
        navigateToSubView("undo");
        return;
      }
      if (submission.command === "mcp") {
        setMcpStatuses(sessionManager.getMcpStatus());
        navigateToSubView("mcp-status");
        return;
      }
      // ===== fork 特有命令处理（rules/team/quality-check/review/memory/help + ADR-DI-001 注入/后台任务）=====
      if (submission.command === "rules") {
        // /rules <subcommand> [args] —— 解析并调用 executeRulesCommand
        // 将输出作为合成助手消息展示在会话中（不走完整 LLM 流程）
        const rulesResult = await handleRulesSlashCommand(submission.text);
        setMessages((prev) => [
          ...prev,
          buildSyntheticUserMessage(submission.text, submission.imageUrls.length),
          buildSyntheticAssistantMessage(rulesResult),
        ]);
        return;
      }
      if (submission.command === "team") {
        // /team <subcommand> [args] 或 /<role> <task> —— 解析并调用 executeTeamCommand
        // 将输出作为合成助手消息展示在会话中（不走完整 LLM 流程）。
        // 该入口承接 PromptInput.handleSlashSelection 中所有 team/architect/pm/coder/tester/ui
        // kind 统一映射的 command: "team" 提交，避免每个角色单独建分支。
        const teamResult = await handleTeamSlashCommand(submission.text);
        setMessages((prev) => [
          ...prev,
          buildSyntheticUserMessage(submission.text, submission.imageUrls.length),
          buildSyntheticAssistantMessage(teamResult),
        ]);
        return;
      }
      if (submission.command === "quality-check") {
        // /quality-check <subcommand> [args] —— 解析并调用 executeQualityCommand
        // 将输出作为合成助手消息展示在会话中（不走完整 LLM 流程）。
        // 子命令：codemap / uiux / visual / all / help
        const qualityResult = await handleQualitySlashCommand(submission.text);
        setMessages((prev) => [
          ...prev,
          buildSyntheticUserMessage(submission.text, submission.imageUrls.length),
          buildSyntheticAssistantMessage(qualityResult),
        ]);
        return;
      }
      if (submission.command === "review") {
        // /review 命令同时支持两种语义：
        //   1. 工具验证模式：/review [typecheck|lint|format|full|help] [options]
        //   2. 自然语言审查请求：/review 当前项目全部代码，并对照 gold comments ...
        // 对于自然语言请求，应交回 LLM 主流程；否则调用 executeReviewCommand 执行工具检查。
        const { extractReviewNaturalLanguageTask, buildReviewNaturalLanguagePrompt } =
          await import("../../review/review-cmd.js");
        const nlTask = extractReviewNaturalLanguageTask(submission.text);
        if (nlTask !== undefined) {
          // 将自然语言请求转换为结构化提示，继续走下方 LLM 主流程
          // F3：模板内置"立即执行 + 禁止建议命令 + 证据纪律"硬约束，
          // 防止模型收到任务后回复"建议执行 /review"形成建议循环
          submission.text = buildReviewNaturalLanguagePrompt(projectRoot, nlTask);
          // F8（2026-09-04）：转换后的结构化提示带 bypass 标记重入主对话。
          // 根因铁证：建议文本只走 UI 不持久化、建议器调用独立计数——说明"建议执行 /xxx"
          // 不是主模型发的（它看不到系统提示词纪律），而是 EAG 建议器把结构化任务文本
          // 当作 goal 拦截了。设置 bypass 标记后该输入直达主对话，堵住"mes 会话
          // /review xxx 被再建议"的循环
          submission.bypassDynamicSuggestion = true;
        } else {
          // 工具验证模式：解析并调用 executeReviewCommand
          // 工具验证优先：所有数字必须有真实命令输出作为证据
          // 子命令：typecheck / lint / format / full / help
          const reviewResult = await handleReviewSlashCommand(submission.text);
          setMessages((prev) => [
            ...prev,
            buildSyntheticUserMessage(submission.text, submission.imageUrls.length),
            buildSyntheticAssistantMessage(reviewResult),
          ]);
          return;
        }
      }
      if (submission.command === "memory") {
        // /memory <subcommand> [args] —— 解析并调用 V2 记忆体系 handleMemoryCommand
        // 子命令：list / delete / delete-all / review / export / help
        // 设计依据：V2 PRD §US-MEM-001（用户可直接管理自己的记忆，命令不发送给 LLM）
        const memoryResult = await handleMemorySlashCommand(submission.text, projectRoot);
        setMessages((prev) => [
          ...prev,
          buildSyntheticUserMessage(submission.text, submission.imageUrls.length),
          buildSyntheticAssistantMessage(memoryResult),
        ]);
        return;
      }
      if (submission.command === "help") {
        // /help —— 渲染内置命令清单（FIX-06：与 CLI --help EPILOG 同一数据源 BUILTIN_SLASH_COMMANDS）
        const { formatBuiltinCommandList } = await import("../core/slash-commands.js");
        setMessages((prev) => [
          ...prev,
          buildSyntheticUserMessage(submission.text, submission.imageUrls.length),
          buildSyntheticAssistantMessage(`可用命令：\n${formatBuiltinCommandList()}`),
        ]);
        return;
      }
      // ===== ADR-DI-001 动态注入与后台子 Agent 命令处理 =====
      // 所有命令通过 InterruptibleSession 接口调用 SessionManager 的扩展方法。
      // 未注入对应组件时方法不存在，给出明确的 "功能未启用" 错误提示。
      const interruptible = sessionManager as unknown as InterruptibleSession;
      if (submission.command === "inject") {
        // /inject <指令文本> —— 向当前正在执行的任务追加指令（软中断）
        const instructionText = extractCommandArgument(submission.text, "inject");
        if (!instructionText) {
          setErrorLine("✖ /inject <指令文本> 缺少指令文本参数\n用法: /inject 在认证失败时返回 401");
          return;
        }
        if (typeof interruptible.injectInstruction !== "function") {
          setErrorLine("✖ 指令注入功能未启用（SessionManager 未注入 interruptQueue）");
          return;
        }
        try {
          interruptible.injectInstruction(instructionText, "user");
          setMessages((prev) => [
            ...prev,
            buildSyntheticUserMessage(submission.text, submission.imageUrls.length),
            buildSyntheticAssistantMessage(`[inject] Added 1 instruction to queue`),
          ]);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setErrorLine(`✖ 注入指令失败：${message}`);
        }
        return;
      }
      if (submission.command === "bg") {
        // /bg <任务描述> —— 后台启动新子 agent 执行独立任务
        const taskPrompt = extractCommandArgument(submission.text, "bg");
        if (!taskPrompt) {
          setErrorLine("✖ /bg <任务描述> 缺少任务描述参数\n用法: /bg 调研 React 19 新特性");
          return;
        }
        if (typeof interruptible.startBackgroundTask !== "function") {
          setErrorLine("✖ 后台任务功能未启用（SessionManager 未注入 backgroundRunner）");
          return;
        }
        try {
          const result = await interruptible.startBackgroundTask({ text: taskPrompt }, "chat");
          setMessages((prev) => [
            ...prev,
            buildSyntheticUserMessage(submission.text, submission.imageUrls.length),
            buildSyntheticAssistantMessage(`[bg] Started task ${result.taskId}, use /tasks to check status`),
          ]);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setErrorLine(`✖ 启动后台任务失败：${message}`);
        }
        return;
      }
      if (submission.command === "tasks") {
        // /tasks —— 列出所有运行中和已完成的任务
        if (typeof interruptible.listTasks !== "function") {
          setErrorLine("✖ 任务列表功能未启用（SessionManager 未注入 taskRegistry）");
          return;
        }
        try {
          const tasks = interruptible.listTasks({ includeHistory: true });
          if (tasks.length === 0) {
            setMessages((prev) => [
              ...prev,
              buildSyntheticUserMessage("/tasks", 0),
              buildSyntheticAssistantMessage("📋 No tasks found."),
            ]);
            return;
          }
          // 格式化任务列表为可读文本表格
          const lines = tasks.map((task) => {
            const progress = `${Math.round(task.progress * 100)}%`;
            const duration = formatDuration(task.stats.durationMs);
            const text = truncateText(task.initialPromptText, 30);
            return `  ${task.id}  [${task.kind}/${task.state}]  ${progress}  ${duration}  ${text}`;
          });
          const table = `📋 Task List (${tasks.length} tasks):\n${lines.join("\n")}`;
          setMessages((prev) => [
            ...prev,
            buildSyntheticUserMessage("/tasks", 0),
            buildSyntheticAssistantMessage(table),
          ]);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setErrorLine(`✖ 查询任务列表失败：${message}`);
        }
        return;
      }
      if (submission.command === "fg") {
        // /fg <taskId> —— 切换前台关注到指定任务
        const taskId = extractCommandArgument(submission.text, "fg");
        if (!taskId) {
          setErrorLine("✖ /fg <taskId> 缺少任务 ID 参数\n用法: /fg t-abc123");
          return;
        }
        if (typeof interruptible.setForegroundTask !== "function") {
          setErrorLine("✖ 前台切换功能未启用（SessionManager 未注入 taskRegistry）");
          return;
        }
        try {
          interruptible.setForegroundTask(taskId);
          setMessages((prev) => [
            ...prev,
            buildSyntheticUserMessage(submission.text, submission.imageUrls.length),
            buildSyntheticAssistantMessage(`[fg] Switched foreground to task ${taskId}`),
          ]);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setErrorLine(`✖ 切换前台任务失败：${message}`);
        }
        return;
      }
      if (submission.command === "cancel") {
        // /cancel <taskId> —— 取消指定任务（硬中断）
        const taskId = extractCommandArgument(submission.text, "cancel");
        if (!taskId) {
          setErrorLine("✖ /cancel <taskId> 缺少任务 ID 参数\n用法: /cancel t-abc123");
          return;
        }
        if (typeof interruptible.cancelTask !== "function") {
          setErrorLine("✖ 任务取消功能未启用（SessionManager 未注入 taskRegistry）");
          return;
        }
        try {
          interruptible.cancelTask(taskId, "user cancelled");
          setMessages((prev) => [
            ...prev,
            buildSyntheticUserMessage(submission.text, submission.imageUrls.length),
            buildSyntheticAssistantMessage(`[cancel] Task ${taskId} cancelled`),
          ]);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setErrorLine(`✖ 取消任务失败：${message}`);
        }
        return;
      }
      if (submission.command === "pause") {
        // /pause —— 暂停当前前台任务
        if (typeof interruptible.pauseActiveTask !== "function") {
          setErrorLine("✖ 任务暂停功能未启用（SessionManager 未注入 taskRegistry）");
          return;
        }
        try {
          interruptible.pauseActiveTask();
          setMessages((prev) => [
            ...prev,
            buildSyntheticUserMessage("/pause", 0),
            buildSyntheticAssistantMessage("[pause] Task paused, use /resume <id> to continue"),
          ]);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setErrorLine(`✖ 暂停任务失败：${message}`);
        }
        return;
      }

      const prompt: UserPromptContent = {
        text: submission.text,
        imageUrls: submission.imageUrls,
        skills:
          submission.selectedSkills && submission.selectedSkills.length > 0 ? submission.selectedSkills : undefined,
        permissions: submission.permissions,
        alwaysAllows: submission.alwaysAllows,
        planMode: submission.planMode ?? planMode,
        // F8（2026-09-04）：透传旁路建议层标记（/review NL 任务等已确定交主模型的输入）
        bypassEagSuggestion: submission.bypassDynamicSuggestion,
      };
      const activeSessionId = sessionManager.getActiveSessionId();
      const permissionReply =
        pendingPermissionReply && activeSessionId === pendingPermissionReply.sessionId ? pendingPermissionReply : null;
      if (permissionReply) {
        prompt.permissions = permissionReply.permissions;
        prompt.alwaysAllows = permissionReply.alwaysAllows;
      }

      const trimmedText = (submission.text ?? "").trim();
      const selectedSkillNames = submission.selectedSkills?.map((skill) => skill.name).filter(Boolean) ?? [];
      const userDisplayContent =
        trimmedText ||
        (selectedSkillNames.length > 0 ? `Use skills: ${selectedSkillNames.join(", ")}` : "") ||
        (submission.imageUrls.length > 0 ? "[Image]" : "");

      if (userDisplayContent && submission.command !== "continue") {
        setMessages((prev) => [...prev, buildSyntheticUserMessage(userDisplayContent, submission.imageUrls.length)]);
      }

      // fork：从此处开始进入真正的 LLM 回合，设置处理中标记以阻塞新的并发 LLM 调用
      isProcessingRef.current = true;
      setBusy(true);
      setErrorLine(null);
      const activeProcesses = activeSessionId ? (sessionManager.getSession(activeSessionId)?.processes ?? null) : null;
      setRunningProcesses(activeProcesses);
      setShowProcessStdout(false);
      if (!activeProcesses || activeProcesses.size === 0) {
        processStdoutRef.current.clear();
      }
      // 建议循环客户端兜底（2026-09-03）：本次调用的 LLM 主流程状态机。
      // "not-run" = 走了某个 slash 分支提前 return（未进入 LLM）；
      // "completed" = LLM 回合正常结束；"error" = LLM 回合抛错。
      // 兜底注入必须基于"本次调用真的跑完了 LLM 回合"，否则会误用上一回合的残留 assistantReply。
      let llmTurnState: "not-run" | "completed" | "error" = "not-run";
      // 本回合是否产生了待确认的计划（PlanImplementationPrompt 待用户选择），有待确认计划时不做自动注入
      let hasPendingPlan = false;
      try {
        await sessionManager.handleUserPrompt(prompt);
        llmTurnState = "completed";
        if (permissionReply) {
          setPendingPermissionReply(null);
        }
        await refreshSkills();
        refreshSessionsList();
        const completedSession = sessionManager.getSession(sessionManager.getActiveSessionId() ?? "");
        const proposedPlan =
          prompt.planMode && completedSession?.status === "completed"
            ? extractProposedPlan(completedSession.assistantReply)
            : null;
        setPendingPlanImplementation(proposedPlan);
        hasPendingPlan = proposedPlan !== null;
      } catch (error) {
        llmTurnState = "error";
        const message = error instanceof Error ? error.message : String(error);
        setErrorLine(message);
      } finally {
        setBusy(false);
        setStreamProgress(null);
        const finalActiveSessionId = sessionManager.getActiveSessionId();
        setRunningProcesses(
          finalActiveSessionId ? (sessionManager.getSession(finalActiveSessionId)?.processes ?? null) : null
        );
        // fork：当前 LLM 回合结束，自动消费队列中的下一条消息（连续排队发送）
        const next = pendingQueueRef.current.shift();
        if (next) {
          setQueuedCount(pendingQueueRef.current.length);
          await handlePromptRef.current(next);
        } else {
          isProcessingRef.current = false;
          // 建议循环客户端兜底（2026-09-03）：仅当本次调用真实跑完 LLM 回合且无异常、
          // 回合以纯文本结束（无工具调用，status=completed）、无待确认计划、无排队用户消息时，
          // 才扫描回复尾部的"建议执行 /xxx"句式并自动注入执行（复用 parseSlashCommandKind 校验）。
          if (llmTurnState === "completed" && !hasPendingPlan && finalActiveSessionId) {
            const finalSession = sessionManager.getSession(finalActiveSessionId);
            const suggestedCommand =
              finalSession?.status === "completed" && finalSession.assistantReply
                ? extractSuggestedCommandText(finalSession.assistantReply)
                : null;
            const suggestedKind = suggestedCommand ? parseSlashCommandKind(suggestedCommand) : undefined;
            const executedKinds = autoExecutedCommandsRef.current.get(finalActiveSessionId) ?? new Set<string>();
            if (
              suggestedCommand &&
              suggestedKind &&
              AUTO_EXECUTABLE_COMMAND_KINDS.has(suggestedKind) &&
              !executedKinds.has(suggestedKind)
            ) {
              // 先标记再执行：自动注入回合的 finally 会再次走到本兜底逻辑，
              // 届时标记已就位，即使模型仍回复"建议执行 /xxx"也会被一次性守卫拦截，确保防循环
              executedKinds.add(suggestedKind);
              autoExecutedCommandsRef.current.set(finalActiveSessionId, executedKinds);
              // 在状态栏显示自动执行提示，让用户感知到命令注入（与 suggestedCommand 路径一致）
              setStatusLine(`▶ 自动执行：${suggestedCommand}`);
              await handlePromptRef.current({ text: suggestedCommand, imageUrls: [], command: suggestedKind });
            }
          }
        }
      }
    },
    [
      sessionManager,
      pendingPermissionReply,
      handleExit,
      onRestart,
      refreshSkills,
      refreshSessionsList,
      navigateToSubView,
      resetToWelcome,
      // 上游 v0.3.1：/fork 分支引入 resetStaticView 与 projectRoot 依赖
      resetStaticView,
      planMode,
      projectRoot,
      // 建议循环客户端兜底：finally 块自动注入前显示状态栏提示
      setStatusLine,
    ]
  );

  // fork：将 memoized handlePrompt 暴露给 ref，供队列递归调用，避免 useCallback 自引用依赖循环
  handlePromptRef.current = handlePrompt;

  const handleInterrupt = useCallback(() => {
    sessionManager.interruptActiveSession();
  }, [sessionManager]);

  const handleToggleProcessStdout = useCallback(() => {
    setShowProcessStdout(true);
  }, []);

  const handleDismissProcessStdout = useCallback(() => {
    setShowProcessStdout(false);
  }, []);

  const handleAdjustBashTimeout = useCallback(
    (deltaMs: number) => sessionManager.adjustActiveBashTimeout(deltaMs),
    [sessionManager]
  );

  const handleModelConfigChange = useCallback(
    (selection: ModelConfigSelection): string => {
      const current = resolveCurrentSettings(projectRoot);
      const { changed } = writeModelConfigSelection(selection, current, projectRoot);
      const next = resolveCurrentSettings(projectRoot);
      setResolvedSettings(next);

      if (!changed) {
        return "Model settings unchanged";
      }

      const activeSessionId = sessionManager.getActiveSessionId();
      const meta: MessageMeta = {
        isModelChange: true,
      };
      const content = `/model\n└ Set model to ${selection.model} (${selection?.thinkingEnabled ? selection?.reasoningEffort : "no thinking"})`;

      if (activeSessionId) {
        sessionManager.addSessionSystemMessage(activeSessionId, content, true, meta);
        // 上游 v0.3.1 新增：模型切换后立即刷新状态栏
        const activeSession = sessionManager.getSession(activeSessionId);
        setStatusLine(activeSession ? buildStatusLine(activeSession, next) : "");
      } else {
        const now = new Date().toISOString();
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            sessionId: "local",
            role: "system" as const,
            content,
            contentParams: null,
            messageParams: null,
            compacted: false,
            visible: true,
            createTime: now,
            updateTime: now,
            meta,
          },
        ]);
      }

      return `Model settings updated: ${formatModelConfig(current)} → ${formatModelConfig(next)}`;
    },
    [projectRoot, sessionManager]
  );

  const handleSubmit = useCallback(
    (submission: PromptSubmission) => {
      // fork：LLM 处理期间的输入队列语义（核心特性，替代上游的简单直发）
      // 当前没有 LLM 回合时直接发送
      if (!isProcessingRef.current) {
        void handlePromptRef.current(submission);
        return;
      }

      // 1. 控制类命令不占用 LLM 回合，可直接执行（例如 /exit /pause /tasks /inject 等）
      if (isImmediateControlCommand(submission, sessionManager)) {
        void handlePromptRef.current(submission);
        return;
      }

      // 2. 紧急干预：用户明显在纠正当前运行中的错误、要求停止/重试/立即修改时，
      //    将消息插到队列最前面，并立即中断当前 LLM 回合，让该消息优先执行
      if (isUrgentIntervention(submission)) {
        pendingQueueRef.current.unshift(submission);
        setQueuedCount(pendingQueueRef.current.length);
        sessionManager.interruptActiveSession();
        return;
      }

      // 3. 普通后续指令排队，当前回合结束后自动连续发送
      pendingQueueRef.current.push(submission);
      setQueuedCount(pendingQueueRef.current.length);
    },
    [sessionManager]
  );

  const handlePlanImplementationChoice = useCallback(
    (choice: "implement" | "stay" | "default") => {
      const proposedPlan = pendingPlanImplementation;
      setPendingPlanImplementation(null);
      if (choice === "stay") {
        return;
      }
      setPlanMode(false);
      if (choice === "implement" && proposedPlan) {
        handleSubmit({
          text: getImplementationPrompt(proposedPlan),
          imageUrls: [],
          planMode: false,
        });
      }
    },
    [handleSubmit, pendingPlanImplementation]
  );

  const handleExitShortcut = useCallback(() => {
    handleExit({ showCommand: false, showSummary: false });
  }, [handleExit]);

  const reloadActiveSessionView = useCallback(
    (sessionId: string): void => {
      resetStaticView(loadVisibleMessages(sessionManager, sessionId), { clearScreen: true });
    },
    [resetStaticView, sessionManager]
  );

  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      sessionManager.setActiveSessionId(sessionId);
      // Clear first so <Static> resets its index to 0.
      await resetStaticView(loadVisibleMessages(sessionManager, sessionId), { clearScreen: true });
      const session = sessionManager.getSession(sessionId);
      // fork：使用带模型名 + token 占比的状态栏（FIX-19）
      setStatusLine(session ? buildStatusLine(session, statusLineOptions) : "");
      setRunningProcesses(session?.processes ?? null);
      setActiveStatus(session?.status ?? null);
      setActiveAskPermissions(session?.askPermissions);
      setPlanMode(session?.planMode === true);
      setPendingPlanImplementation(null);
      if (pendingPermissionReply && pendingPermissionReply.sessionId !== sessionId) {
        setPendingPermissionReply(null);
      }
      await refreshSkills(sessionId);
    },
    [sessionManager, resetStaticView, pendingPermissionReply, refreshSkills, statusLineOptions]
  );

  /**
   * Coordinated startup effect: handle --resume and --prompt together.
   * When both are present, resume the session first, then submit the prompt.
   */
  useEffect(() => {
    if (startupDoneRef.current) {
      return;
    }
    startupDoneRef.current = true;

    async function run() {
      // 上游 v0.3.1：启动时优先处理 --fork（会话分叉），再处理 --resume，并用 try/catch 捕获启动错误
      try {
        // Step 1: Resume or fork a session if requested
        if (forkSessionId) {
          const sessionId = sessionManager.forkSession(forkSessionId);
          await handleSelectSession(sessionId);
        } else if (resumeSessionId) {
          resumeSessionIdRef.current = true;
          if (resumeSessionId === true) {
            // Bare --resume — show session picker; prompt makes no sense here
            refreshSessionsList();
            navigateToSubView("session-list");
            return;
          }
          await handleSelectSession(resumeSessionId);
        }

        // Step 2: Submit prompt if provided
        if (initialPrompt && initialPrompt.trim()) {
          initialPromptSubmittedRef.current = true;
          handleSubmit({
            text: initialPrompt,
            imageUrls: [],
            selectedSkills: undefined,
          });
        }
      } catch (error) {
        setErrorLine(error instanceof Error ? error.message : String(error));
      }
    }

    void run();
    // 上游 v0.3.1：依赖数组新增 forkSessionId 与 sessionManager
  }, [
    forkSessionId,
    handleSubmit,
    handleSelectSession,
    initialPrompt,
    navigateToSubView,
    refreshSessionsList,
    resumeSessionId,
    sessionManager,
  ]);

  const handleDeleteSession = useCallback(
    async (id: string): Promise<void> => {
      const isActiveSession = sessionManager.getActiveSessionId() === id;

      // If the deleted session is the active one, clear the active session first
      if (isActiveSession) {
        sessionManager.setActiveSessionId(null);
      }

      sessionManager.deleteSession(id);
      refreshSessionsList();

      if (isActiveSession) {
        await resetToWelcome();
      }
    },
    [sessionManager, refreshSessionsList, resetToWelcome]
  );

  const handleUndoRestore = useCallback(
    async (target: UndoTarget, restoreMode: UndoRestoreMode): Promise<void> => {
      const sessionId = sessionManager.getActiveSessionId();
      if (!sessionId) {
        setErrorLine("No active session to undo.");
        setView("chat");
        setShowWelcome(true);
        return;
      }

      const errors: string[] = [];
      if (restoreMode === "code-and-conversation") {
        try {
          sessionManager.restoreSessionCode(sessionId, target.message.id);
        } catch (error) {
          errors.push(`Code restore failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      let conversationRestored = false;
      try {
        sessionManager.restoreSessionConversation(sessionId, target.message.id);
        conversationRestored = true;
      } catch (error) {
        errors.push(`Conversation restore failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      refreshSessionsList();
      await refreshSkills(sessionId);
      setView("chat");
      setErrorLine(errors.length > 0 ? errors.join(" ") : null);
      if (conversationRestored) {
        setPromptDraft(buildPromptDraftFromSessionMessage(target.message, Date.now()));
      }
      reloadActiveSessionView(sessionId);
    },
    [reloadActiveSessionView, refreshSessionsList, refreshSkills, sessionManager]
  );

  const handleRawModeChange = useCallback(
    (nextMode: string) => {
      const activeSessionId = sessionManager.getActiveSessionId();
      setMode(nextMode as RawMode);
      // Reset chat view state synchronously so the transition frame does not
      // re-render a stale welcome screen before handleSelectSession runs.
      setShowWelcome(false);
      setMessages([]);
      // Clear screen to remove stale formatted text.
      writeStdout(ANSI_CLEAR_SCREEN);

      setTimeout(() => {
        if (nextMode === RawMode.Raw) {
          // Write all messages directly to stdout for raw scrollback mode.
          const allMessages = activeSessionId ? loadVisibleMessages(sessionManager, activeSessionId) : [];
          renderRawModeMessages(allMessages, nextMode);
        } else if (activeSessionId) {
          // Switch to chat view to render messages.
          handleSelectSession(activeSessionId);
        } else {
          // No active session: just show the welcome screen once.
          setWelcomeNonce((n) => n + 1);
          setShowWelcome(true);
        }
      }, 200);
    },
    [handleSelectSession, sessionManager, setMode]
  );

  useEffect(() => {
    if (!stdout?.isTTY) {
      return;
    }
    if (columns <= 0) {
      return;
    }
    if (lastRenderedColumnsRef.current === null) {
      lastRenderedColumnsRef.current = columns;
      return;
    }
    if (lastRenderedColumnsRef.current === columns) {
      return;
    }
    lastRenderedColumnsRef.current = columns;

    if (mode === RawMode.Raw) {
      // In raw mode, re-render all messages directly to stdout at the new width.
      // Use direct stdout instead of writeRef to avoid Ink interference.
      writeStdout(ANSI_CLEAR_SCREEN);
      const activeSessionId = sessionManager.getActiveSessionId();
      const allMessages = activeSessionId ? loadVisibleMessages(sessionManager, activeSessionId) : [];
      renderRawModeMessages(allMessages, mode);
      return;
    }

    // Force full redraw on terminal resize to avoid stale wrapped rows.
    writeRef.current("\u001B[2J\u001B[H");

    setMessages([]);
    setShowWelcome(false);
    setWelcomeNonce((n) => n + 1);

    const activeSessionId = sessionManager.getActiveSessionId();
    const nextMessages =
      activeSessionId && !busy ? loadVisibleMessages(sessionManager, activeSessionId) : messagesRef.current;
    setTimeout(() => {
      setMessages(nextMessages);
      setShowWelcome(true);
    }, 0);
  }, [busy, mode, sessionManager, columns, stdout]);

  const screenWidth = useMemo(() => columns ?? stdout?.columns ?? 80, [columns, stdout]);
  const screenHeight = useMemo(() => rows ?? stdout?.rows ?? 24, [rows, stdout]);
  const getSessionInfo = useCallback((): SessionInfo | null => {
    const activeSessionId = sessionManager.getActiveSessionId();
    const settings = resolveCurrentSettings(projectRoot);
    const model = settings.model || "";
    const thinkingEnabled = settings.thinkingEnabled;
    const reasoningEffort = settings.reasoningEffort;
    // fork：使用压缩阈值计算有效上下文窗口（与状态栏 token 占比一致）
    const maxContextTokens = getCompactPromptTokenThreshold(model, settings.contextWindow);
    if (!activeSessionId) {
      return {
        activeSessionId: null,
        messageCount: 0,
        requestCount: 0,
        totalTokens: 0,
        activeTokens: 0,
        maxContextTokens,
        model,
        thinkingEnabled,
        reasoningEffort,
        toolUsage: {},
      };
    }
    const session = sessionManager.getSession(activeSessionId);
    const messages = sessionManager.listSessionMessages(activeSessionId);
    const usage = session?.usage;
    const totalTokens =
      usage && typeof (usage as { total_tokens?: unknown }).total_tokens === "number"
        ? ((usage as { total_tokens: number }).total_tokens ?? 0)
        : 0;
    const requestCount =
      usage && typeof (usage as { total_reqs?: unknown }).total_reqs === "number"
        ? ((usage as { total_reqs: number }).total_reqs ?? 0)
        : 0;
    const toolUsage: Record<string, number> = {};
    for (const msg of messages) {
      if (msg.role === "tool" && msg.meta?.function) {
        const fn = msg.meta.function as { name?: string };
        if (fn.name) {
          toolUsage[fn.name] = (toolUsage[fn.name] || 0) + 1;
        }
      }
    }
    return {
      activeSessionId,
      messageCount: messages.length,
      requestCount,
      totalTokens,
      activeTokens: session?.activeTokens ?? 0,
      maxContextTokens,
      model,
      thinkingEnabled,
      reasoningEffort,
      toolUsage,
    };
  }, [sessionManager, projectRoot]);
  const statusLineSegments = useStatusLine(resolvedSettings.statusline, projectRoot, getSessionInfo);
  // 上游 v0.3.1：promptHistory 改用共享 buildPromptHistory（支持 exec 模式历史构建）
  const promptHistory = useMemo(() => buildPromptHistory(messages), [messages]);
  const expandedThinkingId = findExpandedThinkingId(messages);
  const pendingQuestion = useMemo(() => findPendingAskUserQuestion(messages, activeStatus), [activeStatus, messages]);
  const shouldShowQuestionPrompt = Boolean(pendingQuestion && !dismissedQuestionIds.has(pendingQuestion.messageId));
  const loadingText = useMemo(
    () => (busy ? buildLoadingText({ progress: streamProgress, processes: runningProcesses, now: Date.now() }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nowTick forces periodic recalculation for spinner animation
    [busy, streamProgress, runningProcesses, nowTick]
  );

  const welcomeItem: SessionMessage = useMemo(
    () => ({
      id: `__welcome__${welcomeNonce}`,
      sessionId: "",
      role: "system",
      content: "",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: "",
      updateTime: "",
    }),
    [welcomeNonce]
  );
  const staticItems = useMemo(() => {
    if (mode === RawMode.Raw) {
      return [];
    }
    if (showWelcome && view === "chat") {
      return [welcomeItem, ...messages];
    }
    return messages;
  }, [mode, showWelcome, view, messages, welcomeItem]);
  const promptCursorLayoutKey = useMemo(() => {
    const lastStaticItem = staticItems.at(-1);
    return [
      view,
      busy ? "busy" : "idle",
      statusLine,
      errorLine ?? "",
      showProcessStdout ? "stdout" : "main",
      activeStatus ?? "",
      staticItems.length,
      lastStaticItem?.id ?? "",
      lastStaticItem?.updateTime ?? "",
      shouldShowQuestionPrompt ? (pendingQuestion?.messageId ?? "") : "",
      activeAskPermissions?.length ?? 0,
      pendingPermissionReply ? "pending-permission-reply" : "no-pending-permission-reply",
    ].join("\u001E");
  }, [
    activeAskPermissions,
    activeStatus,
    busy,
    errorLine,
    pendingPermissionReply,
    pendingQuestion,
    shouldShowQuestionPrompt,
    showProcessStdout,
    staticItems,
    statusLine,
    view,
  ]);

  const handleQuestionAnswers = useCallback(
    // fork：保留 suggestedCommand 二次确认与自动执行流程（含安全校验降级）
    (answers: AskUserQuestionAnswers, allowSuggestedCommand: boolean) => {
      const answerText = formatAskUserQuestionAnswers(answers);
      const suggestedCommand = allowSuggestedCommand ? pendingQuestion?.suggestedCommand : undefined;
      if (suggestedCommand) {
        // 有 suggestedCommand：解析命令种类（如 "/team dispatch ..." → command: "team"）
        // 合并方案：直接以 slash 命令方式调用 handlePrompt，
        // command 字段让 handlePrompt 路由到 team 分支，text 用于显示和参数解析。
        // 这避免了原实现中"先发送回答 + queueMicrotask 异步注入命令"导致的：
        //   1. SessionManager 状态机竞态（两次并发 handlePrompt 调用）
        //   2. slash 命令不被路由（command 字段未传，走默认 LLM 流程）
        const commandKind = parseSlashCommandKind(suggestedCommand.command);
        if (commandKind) {
          // 在状态栏显示自动执行提示，让用户感知到命令注入
          setStatusLine(`▶ 自动执行：${suggestedCommand.command}`);
          void handlePrompt({
            text: suggestedCommand.command,
            imageUrls: [],
            command: commandKind,
          });
          return;
        }
        // 解析失败降级：仅发送回答，不自动执行（安全失败）
        // suggestedCommand.command 不在 BUILTIN_SLASH_COMMANDS 中，可能是 LLM 幻觉
      }
      // 无 suggestedCommand、用户选择跳过或解析失败：保持现有行为（仅发送回答文本）
      void handlePrompt({ text: answerText, imageUrls: [] });
    },
    [handlePrompt, pendingQuestion, setStatusLine]
  );

  const handleQuestionCancel = useCallback(() => {
    if (!pendingQuestion) {
      return;
    }
    setDismissedQuestionIds((prev) => new Set(prev).add(pendingQuestion.messageId));
  }, [pendingQuestion]);

  const handlePermissionResult = useCallback(
    (result: PermissionPromptResult) => {
      const sessionId = sessionManager.getActiveSessionId();
      if (!sessionId) {
        return;
      }
      setPromptDraft(null);
      if (result.hasDeny) {
        setPendingPermissionReply({
          sessionId,
          permissions: result.permissions,
          alwaysAllows: result.alwaysAllows,
        });
        setStatusLine("Permission denied. Add a reply, then press Enter to continue.");
        sessionManager.denySessionPermission(sessionId);
        return;
      }
      void handlePrompt({
        text: "/continue",
        imageUrls: [],
        command: "continue",
        permissions: result.permissions,
        alwaysAllows: result.alwaysAllows,
      });
    },
    [handlePrompt, sessionManager]
  );

  const handlePermissionCancel = useCallback(() => {
    sessionManager.interruptActiveSession();
    setActiveStatus("interrupted");
    setActiveAskPermissions(undefined);
    setPromptDraft(null);
    refreshSessionsList();
  }, [refreshSessionsList, sessionManager]);

  if (mode === RawMode.Raw) {
    return <RawModeExitPrompt onExit={(prev) => handleRawModeChange(prev)} />;
  }

  return (
    <Box flexDirection="column" width={screenWidth} minWidth={80} overflowX={"visible"}>
      <Static items={staticItems}>
        {(item) => {
          if (item.id.startsWith("__welcome__")) {
            return (
              <WelcomeScreen
                key={item.id}
                projectRoot={projectRoot}
                settings={resolvedSettings}
                skills={skills}
                width={screenWidth}
              />
            );
          }
          return (
            <MessageView
              key={item.id}
              message={item}
              collapsed={isCollapsedThinking(item, expandedThinkingId)}
              width={screenWidth}
            />
          );
        }}
      </Static>
      {(busy || statusLine) && !isExiting ? <StatusLine busy={busy} text={statusLine} /> : null}
      {errorLine ? (
        <Box>
          {/* fork FIX-11（多角色审查 2026-07-29）：errorLine 写入处已自带 ✖ 前缀，渲染层不再重复加 "Error: " */}
          <Text color="red">{errorLine}</Text>
        </Box>
      ) : null}
      {showProcessStdout ? (
        <ProcessStdoutView
          processStdoutRef={processStdoutRef}
          runningProcesses={runningProcesses}
          onDismiss={handleDismissProcessStdout}
          onAdjustTimeout={handleAdjustBashTimeout}
          screenWidth={screenWidth}
          screenHeight={screenHeight}
        />
      ) : view === "session-list" ? (
        <SessionList
          sessions={sessions}
          onSelect={(id) => void handleSelectSession(id)}
          onCancel={() => setView("chat")}
          onDelete={(id) => {
            void handleDeleteSession(id);
          }}
          onRename={(id, newName) => {
            if (sessionManager.renameSession(id, newName)) {
              refreshSessionsList();
              setStatusLine(`Session renamed to "${newName}".`);
            } else {
              setErrorLine("Failed to rename session.");
            }
          }}
        />
      ) : view === "undo" ? (
        <UndoSelector
          targets={undoTargets}
          onSelect={(target, restoreMode) => void handleUndoRestore(target, restoreMode)}
          onCancel={() => {
            setPromptDraft(null);
            setView("chat");
          }}
        />
      ) : view === "mcp-status" ? (
        <McpStatusList
          statuses={mcpStatuses}
          onCancel={() => setView("chat")}
          onReconnect={(name) => {
            const latest = resolveCurrentSettings(projectRoot);
            void sessionManager.reconnectMcpServer(name, latest.mcpServers?.[name]);
          }}
        />
      ) : shouldShowQuestionPrompt && pendingQuestion && !busy ? (
        <AskUserQuestionPrompt
          questions={pendingQuestion.questions}
          // fork：传递建议命令（带安全校验），由 AskUserQuestionPrompt 二次确认
          suggestedCommand={pendingQuestion.suggestedCommand}
          onSubmit={handleQuestionAnswers}
          onCancel={handleQuestionCancel}
        />
      ) : activeStatus === "ask_permission" &&
        activeAskPermissions &&
        activeAskPermissions.length > 0 &&
        !pendingPermissionReply &&
        !busy ? (
        <PermissionPrompt
          requests={activeAskPermissions}
          onSubmit={handlePermissionResult}
          onCancel={handlePermissionCancel}
        />
      ) : pendingPlanImplementation && !busy ? (
        <PlanImplementationPrompt onSelect={handlePlanImplementationChoice} />
      ) : isExiting ? null : (
        <PromptInput
          projectRoot={projectRoot}
          screenWidth={screenWidth}
          skills={skills}
          modelConfig={resolvedSettings}
          promptHistory={promptHistory}
          busy={busy}
          // fork：排队输入数量，busy 状态栏显示 queued N 提示
          queuedCount={queuedCount}
          cursorLayoutKey={promptCursorLayoutKey}
          loadingText={loadingText}
          runningProcesses={runningProcesses}
          promptDraft={promptDraft}
          onSubmit={handleSubmit}
          onModelConfigChange={handleModelConfigChange}
          onRawModeChange={handleRawModeChange}
          onInterrupt={handleInterrupt}
          onToggleProcessStdout={handleToggleProcessStdout}
          onExitShortcut={handleExitShortcut}
          placeholder="Type your message..."
          statusLineSegments={statusLineSegments}
          statusLineSeparator={resolvedSettings.statusline.separator}
          planMode={planMode}
          onPlanModeChange={setPlanMode}
        />
      )}
    </Box>
  );
}
// fork：以下为 TUI slash 命令的解析与执行辅助函数（rules/team/quality/review/memory/inject 等），
// 均为 fork 特有实现，上游 v0.3.1 无对应内容，整体保留
// ============================================================================
// /rules 命令处理（TUI slash 命令模式）
// ============================================================================

/**
 * 解析并执行 /rules slash 命令
 *
 * 支持的格式：
 * - /rules            → 等价于 /rules list
 * - /rules list       → 列出所有生效规则
 * - /rules add <text> → 添加用户规则
 * - /rules remove <id> → 移除规则
 * - /rules show <id>  → 查看规则详情
 * - /rules path       → 显示规则文件路径
 *
 * 解析逻辑：
 * 1. 去除前导 "/"
 * 2. 按空白拆分，首段为 "rules"，次段为 subcommand，其余为 args
 * 3. add 子命令：args 用空格拼接作为 content
 * 4. remove/show 子命令：args 首项作为 ruleId
 *
 * @param text 用户输入的完整文本（如 "/rules list"）
 * @returns 命令输出文本（合并 stdout + stderr）
 */
async function handleRulesSlashCommand(text: string): Promise<string> {
  // 动态导入避免启动开销
  const { executeRulesCommand } = await import("../../rules/rules-cmd.js");
  const trimmed = text.trim();

  // 去除前导 "/" 得到 "rules list" 等
  const body = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const tokens = body.split(/\s+/).filter(Boolean);

  // tokens[0] 应为 "rules"
  if (tokens.length === 0 || tokens[0] !== "rules") {
    return `无效的 /rules 命令: ${text}`;
  }

  // 子命令：tokens[1]，默认 "list"
  const subcommand = (tokens[1] ?? "list") as "list" | "add" | "remove" | "show" | "path";
  const args = tokens.slice(2);

  // 校验子命令合法性
  const validSubs = ["list", "add", "remove", "show", "path"];
  if (!validSubs.includes(subcommand)) {
    return `未知的 /rules 子命令: ${subcommand}\n可用子命令: ${validSubs.join(", ")}`;
  }

  // 按子命令构造参数
  let content: string | undefined;
  let ruleId: string | undefined;

  if (subcommand === "add") {
    // add 子命令：args 全部拼接为 content
    if (args.length === 0) {
      return "✖ /rules add 需要 <内容> 参数\n用法: /rules add 禁止使用 console.log";
    }
    content = args.join(" ");
  } else if (subcommand === "remove" || subcommand === "show") {
    // remove / show 子命令：args 首项为 ruleId
    if (args.length === 0) {
      return `✖ /rules ${subcommand} 需要 <规则ID> 参数\n用法: /rules ${subcommand} SEED-01`;
    }
    ruleId = args[0];
  }

  // 调用 executeRulesCommand（不直接打印，返回输出文本）
  const result = await executeRulesCommand(
    {
      subcommand,
      content,
      ruleId,
      projectRoot: process.cwd(),
    },
    false
  );

  // 合并 stdout + stderr（stderr 用红色标记）
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return output;
}

// ============================================================================
// /team 命令处理（TUI slash 命令模式）
// ============================================================================

/**
 * 解析并执行 /team slash 命令
 *
 * 支持的格式（与 packages/cli/src/team/team-cmd.ts 对齐）：
 * - /team                                → 等价于 /team list
 * - /team list                           → 列出所有可用角色
 * - /team match --keywords <kw1,kw2>     → 关键词匹配角色
 * - /team dispatch --task <task>         → 分派任务（自动匹配或 --role 强制）
 * - /team dispatch --task-file <path>    → 从文件读取任务描述
 * - /team autonomous --goal <goal>       → 启动 Ralph 自主迭代
 * - /team full-lifecycle --project <name>→ 8 阶段全流程
 *
 * 此外也承接 /architect /pm /coder /tester /ui 等角色快捷命令，
 * 它们在 PromptInput.handleSlashSelection 中已被统一映射为 command: "team"，
 * 文本形如 "/architect <task>"，本函数会将其重写为 "/team dispatch --role <role> --task <task>"。
 *
 * 解析逻辑：
 * 1. 去除前导 "/"
 * 2. 按空白拆分，首段为命令名（team / architect / pm / coder / tester / ui）
 * 3. 若首段不是 team，则转换为 team dispatch --role <roleId> 形式
 * 4. 调用 executeTeamCommand 执行（拦截 stdout/stderr 捕获输出，不在 TUI 中直接打印）
 *
 * @param text 用户输入的完整文本（如 "/team list" 或 "/architect 设计用户认证模块"）
 * @returns 命令输出文本（合并 stdout + stderr）
 */
async function handleTeamSlashCommand(text: string): Promise<string> {
  // 动态导入避免启动开销，且避免与 CLI 入口（cli.tsx）的 team 命令处理耦合
  const { executeTeamCommand } = await import("../../team/team-cmd.js");
  const trimmed = text.trim();

  // 去除前导 "/" 得到 "team list" 等
  const body = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const tokens = body.split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return `无效的 /team 命令: ${text}`;
  }

  // 解析命令名与参数：处理 /architect /pm /coder /tester /ui 等角色快捷命令
  const commandName = tokens[0]!;
  let args: TeamCommandArgs;

  if (commandName === "team") {
    // /team <subcommand> [args] 形式，直接解析 tokens[1:] 作为 TeamCommandArgs
    args = parseTeamArgs(tokens.slice(1));
  } else {
    // /<role> <task description> 形式，转换为 dispatch 子命令
    const roleId = teamShortcutToRoleId(commandName);
    if (roleId === null) {
      return `未知的 /team 子命令或角色快捷命令: ${commandName}\n可用: /team list | /team match | /team dispatch | /team autonomous | /team full-lifecycle | /architect | /pm | /coder | /tester | /ui`;
    }
    // /<role> 后续 tokens 拼接为 task 描述
    const taskDescription = tokens.slice(1).join(" ");
    if (!taskDescription) {
      return `✖ /${commandName} 需要 <任务描述> 参数\n用法: /${commandName} 设计用户认证模块`;
    }
    args = {
      subcommand: "dispatch",
      role: roleId,
      task: taskDescription,
      forceRole: true,
    };
  }

  // executeTeamCommand 直接调用 writeStdoutLine/writeStderrLine 写入 process.stdout/stderr，
  // 在 TUI 模式下会破坏 Ink 渲染。这里通过临时拦截 process.stdout.write / process.stderr.write
  // 将输出重定向到内存缓冲，调用结束后恢复原始方法。
  // 注意：handlePrompt 已通过 setBusy(true) 阻塞后续输入，此处不存在并发竞态。
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  // 类型安全的 write 拦截器：捕获字符串/Buffer/Uint8Array 输出
  const interceptedStdoutWrite = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void
  ): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    stdoutChunks.push(text);
    // 兼容 Node.js write 三种重载：(chunk, cb) / (chunk, encoding, cb) / (chunk, encoding, fd, cb)
    if (typeof encoding === "function") {
      encoding(null);
    } else if (typeof callback === "function") {
      callback(null);
    }
    return true;
  };
  const interceptedStderrWrite = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void
  ): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    stderrChunks.push(text);
    if (typeof encoding === "function") {
      encoding(null);
    } else if (typeof callback === "function") {
      callback(null);
    }
    return true;
  };

  process.stdout.write = interceptedStdoutWrite as typeof process.stdout.write;
  process.stderr.write = interceptedStderrWrite as typeof process.stderr.write;

  let exitCode: number;
  try {
    // args 已是 TeamCommandArgs 类型（parseTeamArgs 返回值），无需类型断言
    exitCode = await executeTeamCommand(args);
  } catch (err) {
    exitCode = 1;
    stderrChunks.push(`✖ 执行 /team 命令失败：${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    // 必须在 finally 中恢复原始 write，避免泄漏影响后续渲染
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  // 合并捕获的输出，附带退出码作为前缀（失败时显式标注）
  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");
  const parts: string[] = [];
  if (stdout) {
    parts.push(stdout);
  }
  if (stderr) {
    parts.push(stderr);
  }
  if (exitCode !== 0 && parts.length === 0) {
    parts.push(`✖ /team 命令失败（退出码 ${exitCode}）`);
  } else if (exitCode !== 0) {
    parts.push(`\n[退出码: ${exitCode}]`);
  }
  return parts.join("\n").trim() || "(无输出)";
}

/**
 * /quality-check 命令包装函数
 *
 * 在 TUI 模式下承接 App.tsx 的 submission.command === "quality-check" 分支，
 * 解析用户输入并调用 executeQualityCommand 执行。
 *
 * 与 handleTeamSlashCommand 的区别：
 *   - executeQualityCommand 已通过返回值（exitCode + stdout + stderr）设计为
 *     可被 TUI 调用，不需要拦截 process.stdout.write
 *   - 直接使用 dynamic import 加载 quality-cmd 模块，避免启动开销
 *
 * 流程：
 *   1. 动态导入 executeQualityCommand + parseQualityArgs
 *   2. 去除前导 "/" 并 split tokens
 *   3. 调用 parseQualityArgs 解析参数
 *   4. 调用 executeQualityCommand（printToTerminal=false，避免破坏 Ink 渲染）
 *   5. 合并 stdout + stderr + 退出码作为合成消息返回
 *
 * @param text 用户输入的完整文本（如 "/quality-check codemap ./path"）
 * @returns 合成消息文本（包含报告内容 + 退出码）
 */
async function handleQualitySlashCommand(text: string): Promise<string> {
  // 动态导入避免启动开销，且避免与 CLI 入口的 quality 命令处理耦合
  const { executeQualityCommand, parseQualityArgs } = await import("../../quality/quality-cmd.js");
  const trimmed = text.trim();

  // 去除前导 "/" 得到 "quality-check codemap ./path" 等
  const body = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const tokens = body.split(/\s+/).filter(Boolean);

  if (tokens.length === 0 || tokens[0] !== "quality-check") {
    return `无效的 /quality-check 命令: ${text}`;
  }

  // 解析参数（tokens[0] 是 "quality-check"，去除后传入 parseQualityArgs）
  const args = parseQualityArgs(tokens.slice(1));

  // 执行（TUI 模式不直接打印，由调用方作为合成消息展示）
  const result = await executeQualityCommand(args, undefined, false);

  // 合并输出，附带退出码作为前缀（失败时显式标注）
  const parts: string[] = [];
  if (result.stdout) {
    parts.push(result.stdout);
  }
  if (result.stderr) {
    parts.push(result.stderr);
  }
  if (result.exitCode !== 0 && parts.length === 0) {
    parts.push(`✖ /quality-check 命令失败（退出码 ${result.exitCode}）`);
  } else if (result.exitCode !== 0) {
    parts.push(`\n[退出码: ${result.exitCode}]`);
  }
  return parts.join("\n").trim() || "(无输出)";
}

/**
 * /review 命令包装函数
 *
 * 在 TUI 模式下承接 App.tsx 的 submission.command === "review" 分支，
 * 解析用户输入并调用 executeReviewCommand 执行。
 *
 * 与 handleQualitySlashCommand 的区别：
 *   - /review 强制工具验证优先，所有数字必须有真实命令输出作为证据
 *   - 直接使用 dynamic import 加载 review-cmd 模块，避免启动开销
 *
 * 流程：
 *   1. 动态导入 executeReviewCommand + parseReviewArgs
 *   2. 去除前导 "/" 并 split tokens
 *   3. 调用 parseReviewArgs 解析参数（捕获 ReviewArgsError 返回 exitCode=2）
 *   4. 调用 executeReviewCommand（printToTerminal=false，避免破坏 Ink 渲染）
 *   5. 合并 stdout + stderr + 退出码作为合成消息返回
 *
 * @param text 用户输入的完整文本（如 "/review typecheck" 或 "/review full --quiet"）
 * @returns 合成消息文本（包含报告内容 + 退出码）
 */
async function handleReviewSlashCommand(text: string): Promise<string> {
  // 动态导入避免启动开销，且避免与 CLI 入口的 review 命令处理耦合
  const { executeReviewCommand, parseReviewArgs, ReviewArgsError, formatReviewHelp } =
    await import("../../review/review-cmd.js");
  const trimmed = text.trim();

  // 去除前导 "/" 得到 "review typecheck" 等
  const body = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const tokens = body.split(/\s+/).filter(Boolean);

  if (tokens.length === 0 || tokens[0] !== "review") {
    // F5：区分"命令不完整"与"完全无效"两种报错——
    // 残缺前缀（如 "/revi"）给出补全提示，避免误导用户以为命令不存在而反复重试
    const firstToken = tokens[0] ?? "";
    const isPrefix = firstToken.startsWith("rev");
    if (isPrefix) {
      return `命令不完整: ${text}\n请键入完整命令 /review（输入 / 后可在菜单中 Tab/Enter 补全）\n用法: /review <typecheck|lint|format|full|help>`;
    }
    return `无效的 /review 命令: ${text}\n用法: /review <typecheck|lint|format|full|help>`;
  }

  // 去除 "review" 前缀，剩余 tokens 传给 parseReviewArgs
  const remainingTokens = tokens.slice(1);

  // help 子命令直接返回帮助文本（不走 parseReviewArgs，避免无子命令时默认 full）
  if (remainingTokens[0] === "help") {
    return formatReviewHelp();
  }

  // 解析参数（捕获 ReviewArgsError 返回参数错误提示）
  let args;
  try {
    args = parseReviewArgs(remainingTokens);
  } catch (error) {
    if (error instanceof ReviewArgsError) {
      return `✖ 参数错误：${error.message}\n\n使用 /review help 查看帮助`;
    }
    throw error;
  }

  // 执行（TUI 模式不直接打印，由调用方作为合成消息展示）
  const result = await executeReviewCommand(args, undefined, false);

  // 合并输出，附带退出码作为前缀（失败时显式标注）
  const parts: string[] = [];
  if (result.stdout) {
    parts.push(result.stdout);
  }
  if (result.stderr) {
    parts.push(result.stderr);
  }
  if (result.exitCode !== 0 && parts.length === 0) {
    parts.push(`✖ /review 命令失败（退出码 ${result.exitCode}）`);
  } else if (result.exitCode !== 0) {
    parts.push(`\n[退出码: ${result.exitCode}]`);
  }
  return parts.join("\n").trim() || "(无输出)";
}

/**
 * 创建 EAG 编排器装配日志器（2026-07-31 FIX-1/FIX-2）
 *
 * 装配期日志（尤其装配失败）需要可观测，但 Ink TUI 下 console 输出会破屏，
 * 因此写入独立日志文件 ~/.deepcodex/logs/eag-assembly.log。
 * 日志写入本身失败时静默降级（装配流程不受日志故障影响）。
 *
 * @returns AssemblyLogCallback 装配日志回调
 */
function createEagAssemblyLogger(): AssemblyLogCallback {
  return (message, level = "info") => {
    try {
      const logDir = getDeepCodeXLogDir();
      nodeFs.mkdirSync(logDir, { recursive: true });
      const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
      nodeFs.appendFileSync(nodePath.join(logDir, "eag-assembly.log"), line, "utf8");
    } catch {
      // 日志写入失败静默降级：装配可观测性不阻断主流程
    }
  };
}

/**
 * /memory 命令包装函数（FIX-05，多角色审查 2026-07-29）
 *
 * 在 TUI 模式下承接 App.tsx 的 submission.command === "memory" 分支，
 * 接线 V2 记忆体系的 handleMemoryCommand（core v2/memory/memory-commands.ts）。
 *
 * 设计依据：
 *   - V2 PRD §US-MEM-001：用户可查看和管理自己的记忆
 *   - V2 PRD §US-PRIV-002：用户可删除全部记忆（需二次确认）
 *   - 该命令在 CLI 层处理，不发送给 LLM（用户隐私）
 *
 * 流程：
 *   1. 动态导入 MemoryStore / MemoryPrivacyManager / handleMemoryCommand，避免启动开销
 *   2. 构造 MemoryStore（聚合 ~/.deepcode/memory/ 全局记忆 + <projectRoot>/.deepcode/memory/ 项目记忆）
 *   3. 构造 MemoryPrivacyManager（用于 delete-all 物理删除全部记忆文件）
 *   4. 去除 "/memory" 前缀得到子命令参数串，调用 handleMemoryCommand
 *   5. 返回格式化的处理结果文本（失败时带 ✖ 前缀）
 *
 * @param text 用户输入的完整文本（如 "/memory list" 或 "/memory delete <id>"）
 * @param projectRoot 项目根目录（用于定位项目级记忆目录）
 * @returns 合成消息文本
 */
async function handleMemorySlashCommand(text: string, projectRoot: string): Promise<string> {
  // 动态导入避免启动开销；MemoryStore / MemoryPrivacyManager / handleMemoryCommand
  // 均为 core v2 公开导出（见 packages/core/src/v2/index.ts）
  const [{ MemoryStore, MemoryPrivacyManager, handleMemoryCommand }, nodePath, nodeOs] = await Promise.all([
    import("@vegamo/deepcode-core"),
    import("node:path"),
    import("node:os"),
  ]);

  const trimmed = text.trim();
  // 去除前导 "/" 得到 "memory list" 等
  const body = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const tokens = body.split(/\s+/).filter(Boolean);

  if (tokens.length === 0 || tokens[0] !== "memory") {
    return `无效的 /memory 命令: ${text}`;
  }

  // 去除 "memory" 前缀，剩余部分作为子命令参数串（如 "list user_global"）
  const argsText = tokens.slice(1).join(" ");

  // 记忆目录布局（与 MemoryStore / MemoryPrivacyManager 内部约定一致）：
  //   全局记忆目录：~/.deepcode/memory/
  //   项目记忆目录：<projectRoot>/.deepcode/memory/
  const globalMemoryDir = nodePath.join(nodeOs.homedir(), ".deepcode", "memory");
  const projectMemoryDir = nodePath.join(projectRoot, ".deepcode", "memory");

  const store = new MemoryStore(projectRoot);
  const privacyManager = new MemoryPrivacyManager(globalMemoryDir, projectMemoryDir);

  try {
    const result = await handleMemoryCommand(argsText, store, privacyManager);
    if (result.success) {
      return result.output;
    }
    return `✖ ${result.output}`;
  } catch (error) {
    // delete-all 之外的未知错误（如磁盘 I/O 异常）不应静默吞掉
    const message = error instanceof Error ? error.message : String(error);
    return `✖ /memory 命令执行失败：${message}`;
  }
}

/**
 * 从命令字符串解析 slash 命令种类
 *
 * 用于 handleQuestionAnswers 自动注入 suggestedCommand 时，识别命令种类。
 * 例如 "/team dispatch --role architect" → "team"，"/architect 设计模块" → "architect"。
 *
 * 识别逻辑：
 * 1. 命令必须以 "/" 开头
 * 2. 提取首个 token（如 "/team"），去除 "/" 得到命令名（如 "team"）
 * 3. 在 BUILTIN_SLASH_COMMANDS 中查找匹配的 kind
 *
 * 注意：返回的 kind 是 PromptSubmission.command 联合类型的成员。
 * 对于 architect/pm/coder/tester/ui 等角色快捷命令，返回对应的 kind 字符串，
 * 但由于 PromptSubmission.command 中只有 "team"，调用方（handleQuestionAnswers）
 * 需要在传给 handlePrompt 前将其统一转换为 "team"。
 * 此处先返回原始 kind，由调用方决定是否转换。
 *
 * @param commandText 命令字符串（如 "/team dispatch ..." 或 "/architect 设计模块"）
 * @returns slash 命令 kind（如 "team"、"architect"、"rules"），或 undefined（无法识别）
 */
function parseSlashCommandKind(commandText: string): PromptSubmission["command"] | undefined {
  const trimmed = commandText.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  // 提取首个 token（如 "/team"）
  const firstToken = trimmed.split(/\s+/, 1)[0];
  if (!firstToken) {
    return undefined;
  }
  // 去除前导 "/" 得到命令名（如 "team"）
  const commandName = firstToken.slice(1);
  if (!commandName) {
    return undefined;
  }
  // 在 BUILTIN_SLASH_COMMANDS 中查找对应的 kind
  const item = BUILTIN_SLASH_COMMANDS.find((cmd) => cmd.name === commandName);
  if (!item) {
    return undefined;
  }
  // 将 SlashCommandKind 映射为 PromptSubmission.command 联合类型成员
  // 多角色团队命令（team/architect/pm/coder/tester/ui）统一映射为 "team"
  // 其他命令（rules/exit/new/undo/mcp/inject/bg/tasks/fg/cancel/pause/resume/continue）保持原值
  switch (item.kind) {
    case "team":
    case "architect":
    case "pm":
    case "coder":
    case "tester":
    case "ui":
      return "team";
    case "rules":
      return "rules";
    case "exit":
      return "exit";
    case "new":
      return "new";
    case "undo":
      return "undo";
    case "mcp":
      return "mcp";
    case "inject":
      return "inject";
    case "bg":
      return "bg";
    case "tasks":
      return "tasks";
    case "fg":
      return "fg";
    case "cancel":
      return "cancel";
    case "pause":
      return "pause";
    case "quality-check":
      return "quality-check";
    case "review":
      return "review";
    // FIX-05（多角色审查 2026-07-29）：/memory 命令接线，不再 fallthrough 为 undefined
    case "memory":
      return "memory";
    // FIX-06（多角色审查 2026-07-29）：/help 命令接线，渲染内置命令清单
    case "help":
      return "help";
    case "resume":
      return "resume";
    case "continue":
      return "continue";
    // 以下 kind 不是 PromptSubmission.command 的成员，无法自动执行
    // （skill/skills/model/plan/init/raw 等），返回 undefined 让调用方降级
    default:
      return undefined;
  }
}

/**
 * 将 /<role> 角色快捷命令名映射为 RoleId
 *
 * 与 packages/cli/src/ui/core/slash-commands.ts 中的 teamCommandToRoleId 保持一致。
 * 此处独立实现一份，避免在 App.tsx 顶部新增对 slash-commands 模块的导入。
 *
 * @param commandName 命令名（不含 "/"，如 "architect" / "pm" / "coder" / "tester" / "ui"）
 * @returns 对应的 RoleId，或 null（不是角色快捷命令）
 */
function teamShortcutToRoleId(commandName: string): import("@vegamo/deepcode-core").RoleId | null {
  switch (commandName) {
    case "architect":
      return "architect";
    case "pm":
      return "product-manager";
    case "coder":
      return "solo-coder";
    case "tester":
      return "test-expert";
    case "ui":
      return "ui-designer";
    default:
      return null;
  }
}

// parseTeamArgs 已于 S2（2026-08-19）抽取至 ui/core/parse-team-args.ts（含 failFast
// 三态归一修正），本文件经顶部 import 使用；此处不再保留内联实现

/**
 * 格式化任务时长（毫秒 → 人类可读）
 *
 * 例如：
 * - 5000 → "5s"
 * - 65000 → "1m 5s"
 * - 3725000 → "1h 2m 5s"
 *
 * @param durationMs 时长（毫秒）
 * @returns 人类可读的时长字符串
 */
function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * 截断文本到指定长度（超出部分用 "..." 表示）
 *
 * @param text 原始文本
 * @param maxLength 最大长度（含 "..." 后缀）
 * @returns 截断后的文本
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

export default App;
