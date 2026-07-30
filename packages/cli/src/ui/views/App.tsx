import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useStdout, useWindowSize } from "ink";
import chalk from "chalk";
import { createOpenAIClient } from "@vegamo/deepcode-core";
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
import { buildExitSummaryText, buildResumeHintText } from "../exit-summary";
import { RawMode, useRawModeContext } from "../contexts";
import { renderMessageToStdout } from "../components/MessageView/utils";
import {
  buildPromptDraftFromSessionMessage,
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
// ADR-DI-001 动态注入与后台子 Agent 命令辅助函数
import { extractCommandArgument, isResumeTaskCommand, BUILTIN_SLASH_COMMANDS } from "../core/slash-commands";
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
import { buildDynamicCommandDescriptors } from "../core/dynamic-commands";
import { writeStdout, writeStdoutLine } from "../../utils/stdio-helpers";
// 导入 TeamCommandArgs 类型，用于 parseTeamArgs 返回值类型标注
// 注意：仅导入类型（import type），不导入运行时值，避免增加启动开销
import type { TeamCommandArgs, TeamSubcommand } from "../../team/team-cmd";

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

function App({ projectRoot, initialPrompt, resumeSessionId, onRestart }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout, write } = useStdout();
  const { columns, rows } = useWindowSize();
  const { mode, setMode } = useRawModeContext();
  const initialPromptSubmittedRef = useRef(false);
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
  // 用于 buildStatusLine 生成带模型名 + token 占比的状态栏。
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
  // 处理期间输入队列：允许用户在 LLM 回复过程中继续打字/回车，消息排入队列并在当前回合结束后自动连续发送
  const pendingQueueRef = useRef<PromptSubmission[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const isProcessingRef = useRef(false);
  const handlePromptRef = useRef<(submission: PromptSubmission) => Promise<void>>(async () => {});

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

    return new SessionManager({
      projectRoot,
      createOpenAIClient: () => createOpenAIClient(projectRoot),
      getResolvedSettings: () => resolveCurrentSettings(projectRoot),
      renderMarkdown: (text) => text,
      eagDynamicSuggester,
      dynamicCommandDescriptors,
      // V2 Session 上下文钩子注入
      contextHook,
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
        setStatusLine(buildStatusLine(entry, statusLineOptions));
        setRunningProcesses(entry.processes);
        setActiveStatus(entry.status);
        setActiveAskPermissions(entry.askPermissions);
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
          // FIX-12（多角色审查 2026-07-29）：超限时追加一次截断提示，避免静默丢弃
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
        // /review <subcommand> [args] —— 解析并调用 executeReviewCommand
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

      // 从此处开始进入真正的 LLM 回合，设置处理中标记以阻塞新的并发 LLM 调用
      isProcessingRef.current = true;
      setBusy(true);
      setErrorLine(null);
      const activeProcesses = activeSessionId ? (sessionManager.getSession(activeSessionId)?.processes ?? null) : null;
      setRunningProcesses(activeProcesses);
      setShowProcessStdout(false);
      if (!activeProcesses || activeProcesses.size === 0) {
        processStdoutRef.current.clear();
      }
      try {
        await sessionManager.handleUserPrompt(prompt);
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorLine(message);
      } finally {
        setBusy(false);
        setStreamProgress(null);
        const finalActiveSessionId = sessionManager.getActiveSessionId();
        setRunningProcesses(
          finalActiveSessionId ? (sessionManager.getSession(finalActiveSessionId)?.processes ?? null) : null
        );
        // 当前 LLM 回合结束，自动消费队列中的下一条消息
        const next = pendingQueueRef.current.shift();
        if (next) {
          setQueuedCount(pendingQueueRef.current.length);
          await handlePromptRef.current(next);
        } else {
          isProcessingRef.current = false;
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
      planMode,
    ]
  );

  // 将 memoized handlePrompt 暴露给 ref，供队列递归调用，避免 useCallback 自引用依赖循环
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
    [sessionManager, resetStaticView, pendingPermissionReply, refreshSkills]
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
      // Step 1: Resume session if requested
      if (resumeSessionId) {
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
    }

    void run();
  }, [handleSubmit, handleSelectSession, initialPrompt, navigateToSubView, refreshSessionsList, resumeSessionId]);

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
  const promptHistory = useMemo(() => {
    return messages
      .filter((message) => message.role === "user" && typeof message.content === "string")
      .map((message) => (message.content ?? "").trim())
      .filter((content) => content.length > 0);
  }, [messages]);
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
    (answers: AskUserQuestionAnswers) => {
      const answerText = formatAskUserQuestionAnswers(answers);
      const suggestedCommand = pendingQuestion?.suggestedCommand;
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
      // 无 suggestedCommand 或解析失败：保持现有行为（仅发送回答文本）
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
          {/* FIX-11（多角色审查 2026-07-29）：errorLine 写入处已自带 ✖ 前缀，渲染层不再重复加 "Error: " */}
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
    return `无效的 /review 命令: ${text}`;
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

/**
 * 解析 /team 命令参数为 TeamCommandArgs 对象
 *
 * 支持的参数：
 * - subcommand（位置参数）：list / match / dispatch / autonomous / full-lifecycle（默认 list）
 * - --role <roleId>          强制指定角色
 * - --task <text>            任务描述
 * - --task-file <path>       任务文件路径
 * - --goal <text>             项目目标
 * - --keywords <kw1,kw2,...>  关键词（match 模式，逗号分隔）
 * - --max-iterations <n>      最大迭代次数
 * - --force-role              禁用自动匹配
 * - --consensus               共识模式
 * - --fail-fast                失败时中止
 * - --project-root <path>     项目根目录
 * - --resume-run               断点续跑
 * - --use-loop                 启用循环模式
 * - --prd-path <path>          PRD 文档路径
 * - --architecture-path <path> 架构文档路径
 * - --test-plan-path <path>    测试计划路径
 * - --test-command <cmd>       测试命令
 *
 * @param tokens 命令 tokens（去除 "team" 前缀后的参数数组）
 * @returns TeamCommandArgs 对象（subcommand 必填，其他字段按需填充）
 */
function parseTeamArgs(tokens: string[]): TeamCommandArgs {
  // 使用 Record<string, unknown> 中间存储，最后构造 TeamCommandArgs
  const raw: Record<string, unknown> = {};

  // 第一个 token 是子命令（默认 "list"）
  let subcommand: TeamSubcommand = "list";
  if (tokens.length > 0 && !tokens[0]!.startsWith("--")) {
    const first = tokens[0]!;
    // 校验子命令合法性（与 team-cmd.ts 的 TeamSubcommand 类型对齐）
    if (
      first === "list" ||
      first === "match" ||
      first === "dispatch" ||
      first === "autonomous" ||
      first === "full-lifecycle"
    ) {
      subcommand = first;
      tokens = tokens.slice(1);
    } else {
      // 未知子命令，仍保留原值让 executeTeamCommand 报错（exhaustiveness check）
      subcommand = first as TeamSubcommand;
      tokens = tokens.slice(1);
    }
  }
  raw.subcommand = subcommand;

  // 解析 --key value 参数
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const nextToken = tokens[i + 1];
      if (nextToken && !nextToken.startsWith("--")) {
        // 值参数
        raw[key] = nextToken;
        i++;
      } else {
        // 布尔参数
        raw[key] = true;
      }
    }
  }

  // --keywords 逗号分隔转数组（match 子命令使用）
  if (typeof raw.keywords === "string") {
    raw.keywords = (raw.keywords as string)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // --max-iterations 字符串转数字
  if (typeof raw.maxIterations === "string") {
    const n = Number.parseInt(raw.maxIterations as string, 10);
    if (!Number.isNaN(n)) {
      raw.maxIterations = n;
    } else {
      delete raw.maxIterations;
    }
  }

  // camelCase 转换：CLI 风格参数名转 TeamCommandArgs 字段名
  // --task-file → taskFile, --max-iterations → maxIterations（已转）,
  // --force-role → forceRole, --fail-fast → failFast,
  // --project-root → projectRoot, --resume-run → resumeRun,
  // --use-loop → useLoop, --prd-path → prdPath, --architecture-path → architecturePath,
  // --test-plan-path → testPlanPath, --test-command → testCommand
  const kebabToCamelMap: Record<string, string> = {
    "task-file": "taskFile",
    "force-role": "forceRole",
    "fail-fast": "failFast",
    "project-root": "projectRoot",
    "resume-run": "resumeRun",
    "use-loop": "useLoop",
    "prd-path": "prdPath",
    "architecture-path": "architecturePath",
    "test-plan-path": "testPlanPath",
    "test-command": "testCommand",
  };
  for (const [kebab, camel] of Object.entries(kebabToCamelMap)) {
    if (raw[kebab] !== undefined) {
      raw[camel] = raw[kebab];
      delete raw[kebab];
    }
  }

  // 构造 TeamCommandArgs 对象（仅包含已解析的字段，避免 undefined 字段污染）
  // 注意：此处使用对象展开 + 条件包含，确保类型安全
  const args: TeamCommandArgs = { subcommand };
  if (typeof raw.role === "string") {
    args.role = raw.role as TeamCommandArgs["role"];
  }
  if (typeof raw.task === "string") {
    args.task = raw.task;
  }
  if (typeof raw.taskFile === "string") {
    args.taskFile = raw.taskFile;
  }
  if (typeof raw.goal === "string") {
    args.goal = raw.goal;
  }
  if (Array.isArray(raw.keywords)) {
    args.keywords = raw.keywords as string[];
  }
  if (typeof raw.maxIterations === "number") {
    args.maxIterations = raw.maxIterations;
  }
  if (raw.forceRole === true) {
    args.forceRole = true;
  }
  if (raw.consensus === true) {
    args.consensus = true;
  }
  if (raw.failFast === true) {
    args.failFast = true;
  }
  if (typeof raw.projectRoot === "string") {
    args.projectRoot = raw.projectRoot;
  }
  if (raw.resumeRun === true) {
    args.resumeRun = true;
  }
  if (raw.useLoop === true) {
    args.useLoop = true;
  }
  if (typeof raw.prdPath === "string") {
    args.prdPath = raw.prdPath;
  }
  if (typeof raw.architecturePath === "string") {
    args.architecturePath = raw.architecturePath;
  }
  if (typeof raw.testPlanPath === "string") {
    args.testPlanPath = raw.testPlanPath;
  }
  if (typeof raw.testCommand === "string") {
    args.testCommand = raw.testCommand;
  }

  return args;
}

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
