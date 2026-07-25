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
import { extractCommandArgument, isResumeTaskCommand } from "../core/slash-commands";
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
import { buildDynamicCommandDescriptors } from "../core/dynamic-commands";
import { writeStdout, writeStdoutLine } from "../../utils/stdio-helpers";

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
  const [nowTick, setNowTick] = useState(0);
  const [mcpStatuses, setMcpStatuses] = useState<ReturnType<typeof sessionManager.getMcpStatus>>([]);
  const [showProcessStdout, setShowProcessStdout] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [pendingPlanImplementation, setPendingPlanImplementation] = useState<string | null>(null);

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

    return new SessionManager({
      projectRoot,
      createOpenAIClient: () => createOpenAIClient(projectRoot),
      getResolvedSettings: () => resolveCurrentSettings(projectRoot),
      renderMarkdown: (text) => text,
      eagDynamicSuggester,
      dynamicCommandDescriptors,
      onAssistantMessage: (message: SessionMessage) => {
        setMessages((prev) => [...prev, message]);
        if (rawModeRef.current === RawMode.Raw) {
          writeStdoutLine("\n");
          writeStdoutLine(renderMessageToStdout(message, rawModeRef.current) + "\n\n");
        }
      },
      onSessionEntryUpdated: (entry) => {
        setStatusLine(buildStatusLine(entry));
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
      void handlePrompt(submission);
    },
    [handlePrompt]
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
      setStatusLine(session ? buildStatusLine(session) : "");
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
      void handlePrompt({
        text: formatAskUserQuestionAnswers(answers),
        imageUrls: [],
      });
    },
    [handlePrompt]
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
          <Text color="red">Error: {errorLine}</Text>
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
// ADR-DI-001 辅助函数（/tasks 命令的表格格式化）
// ============================================================================

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
