/**
 * SessionPool：Web 会话池（docs/dev/web-ui.md §3.1 D1/D4，核心模块）。
 *
 * 职责：
 * 1. 维护 Map<chatId, ChatSession>，每个 Web 聊天对应一个进程内 SessionManager
 *    （nonInteractive: true，与 CLI 共用同一引擎与配置来源）；
 * 2. 同一 chatId 的 handleUserPrompt 调用经 Promise 链串行化（引擎非线程安全），
 *    不同 chatId 之间并行；
 * 3. 引擎事件桥接为 SSE：
 *    - onAssistantMessage → "assistant_message"
 *    - onLlmStreamProgress → "llm_delta"（phase + previewText，映射前端 token 流）
 *    - onSessionEntryUpdated → "status"（含 askPermissions 明细）；
 *      entry.toolCalls 非空时额外桥接 "tool_progress"（工具执行进度，安全序列化）
 * 4. sendMessage 为 202 异步受理语义：同步受理入队立即返回 {chatId, sessionId}
 *    （sessionId 允许 null），轮次的全部事件经 SSE 推送；轮次结束（含异常）时
 *    推 "done" {chatId, sessionId, status}（异常 status=failed），订阅方不悬死；
 * 5. listChats 合并池内活跃会话与各 allowRoot 项目的磁盘历史（sessions-index.json），
 *    去重键统一为底层 sessionId（entry.id），同一会话绝不出现两条记录。
 *
 * 测试缝合点（依赖注入，非 mock）：
 * - createLLMClient：core 官方缝合点，注入受控真实 LLMClient（返回 null 表示无凭据）；
 * - createOpenAIClient：core 官方缝合点，注入受控真实 OpenAI 连接句柄
 *   （SessionManager.activateSession 要求 client 非空，测试环境无凭据时注入受控句柄，
 *   与 packages/core/src/tests/session-anthropic-stream-safety.test.ts 的注入方式一致）。
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  SessionManager,
  createOpenAIClient as createDefaultOpenAIClient,
  getProjectCode,
  resolveCurrentSettings,
  type AskPermissionRequest,
  type LLMClient,
  type SessionStatus,
  type UserPromptContent,
  type UserToolPermission,
  type PermissionScope,
} from "@vegamo/deepcode-core";
import { ApiError } from "./http-utils";
import { resolveInJail } from "./jail";
import type { SseHub } from "./events";
import type { ChatMessageDto, ChatSummary, DoneEvent, ResolvedWebSettings } from "./types";

/** OpenAI 连接句柄类型（createOpenAIClient 的返回结构） */
type OpenAIClientHandle = ReturnType<typeof createDefaultOpenAIClient>;

/** 池内单个聊天会话 */
type ChatSession = {
  /** Web 会话 id（池内分配的 UUID，与底层 sessionId 解耦） */
  chatId: string;
  /** 进程内引擎实例 */
  manager: SessionManager;
  /** 项目根目录（已 realpath 归一） */
  projectRoot: string;
  /** 底层引擎会话 id（首个消息前为 null；恢复会话时创建即设置） */
  sessionId: string | null;
  /** 创建时间（ISO） */
  createTime: string;
  /** 串行化 Promise 链尾（恒不 reject，错误在 runTurn 内收敛） */
  busy: Promise<void>;
};

/** sendMessage 入参（已由 API 层校验过的强类型） */
export type SendMessageInput = {
  text?: string;
  imageUrls?: string[];
  permissions?: UserToolPermission[];
  alwaysAllows?: PermissionScope[];
};

/** sendMessage 受理结果（202 异步受理：轮次结果经 SSE done 事件推送，本结果不含 status） */
export type SendMessageAcceptance = {
  /** Web 会话 id */
  chatId: string;
  /**
   * 受理时已知的底层 SessionManager 会话 id。
   * 允许为 null：首轮消息受理时底层会话尚未创建（或历史恢复失败）；
   * 最终 sessionId 以 SSE done 事件载荷为准。
   */
  sessionId: string | null;
};

/** 创建会话结果 */
export type CreateChatResult = {
  chatId: string;
  sessionId: string | null;
  projectRoot: string;
};

/** SessionPool 构造选项（依赖注入缝合点定义） */
export type SessionPoolOptions = {
  /**
   * 受控 LLM 客户端工厂（core 官方缝合点 SessionManagerOptions.createLLMClient 透传）。
   * 返回 null 表示无凭据（静默降级语义）。
   */
  createLLMClient?: () => LLMClient | null;
  /**
   * 受控 OpenAI 连接句柄工厂（core 官方缝合点 SessionManagerOptions.createOpenAIClient 覆写）。
   * 未注入时使用默认 createOpenAIClient(projectRoot)。
   */
  createOpenAIClient?: (projectRoot: string) => OpenAIClientHandle;
};

/**
 * Web 会话池。
 */
export class SessionPool {
  /** chatId → 聊天会话 */
  private readonly chats = new Map<string, ChatSession>();
  /** 受控工厂（可选） */
  private readonly createLLMClient?: () => LLMClient | null;
  private readonly createOpenAIClientOverride?: (projectRoot: string) => OpenAIClientHandle;

  /**
   * @param settings 归一后的 Web 配置
   * @param hub SSE 事件总线（事件桥接目标）
   * @param jailRoots realpath 归一后的 allowRoots 白名单（server 启动时经 buildJailRoots 构建）
   * @param options 依赖注入缝合点（测试注入受控实现）
   */
  constructor(
    private readonly settings: ResolvedWebSettings,
    private readonly hub: SseHub,
    private readonly jailRoots: string[],
    options: SessionPoolOptions = {}
  ) {
    this.createLLMClient = options.createLLMClient;
    this.createOpenAIClientOverride = options.createOpenAIClient;
  }

  /**
   * 创建新的 Web 聊天会话。
   *
   * 流程：projectRoot 牢笼校验（必须在 allowRoots 内）→ 构造 SessionManager
   * （nonInteractive + renderMarkdown 透传 + 事件桥接回调）→ initMcpServers →
   * 可选恢复指定 sessionId。
   *
   * @param projectRoot 项目根目录（必须位于 allowRoots 白名单内）
   * @param sessionId 可选：恢复既有底层会话（刷新后恢复历史）
   * @returns chatId / sessionId / projectRoot
   * @throws JailViolationError projectRoot 越出白名单（映射 403）
   * @throws ApiError 404 指定 sessionId 在该项目下不存在
   */
  async createChat(projectRoot: string, sessionId?: string): Promise<CreateChatResult> {
    // 牢笼校验：消解符号链接后必须落在某个 allowRoot 内（否则 403）
    const resolvedRoot = await resolveInJail(this.jailRoots, projectRoot);

    const chatId = randomUUID();
    const createTime = new Date().toISOString();
    const settings = resolveCurrentSettings(resolvedRoot);

    const manager = new SessionManager({
      projectRoot: resolvedRoot,
      // OpenAI 连接工厂：测试经 SessionPoolOptions 注入受控句柄；生产走 core 默认实现
      createOpenAIClient: () =>
        this.createOpenAIClientOverride
          ? this.createOpenAIClientOverride(resolvedRoot)
          : createDefaultOpenAIClient(resolvedRoot),
      // LLM 工厂缝合点：测试注入受控 LLMClient；未注入时 undefined 走 core 默认路由
      ...(this.createLLMClient ? { createLLMClient: this.createLLMClient } : {}),
      // 配置直读：与 CLI 同源（resolveCurrentSettings 透传）
      getResolvedSettings: () => resolveCurrentSettings(resolvedRoot),
      renderMarkdown: (text) => text,
      nonInteractive: true,
      // —— 事件桥接（chatId 闭包绑定）——
      onAssistantMessage: (message) => {
        this.hub.publish(chatId, "assistant_message", {
          chatId,
          messageId: message.id,
          content: message.content ?? "",
        });
      },
      onLlmStreamProgress: (progress) => {
        this.hub.publish(chatId, "llm_delta", {
          chatId,
          phase: progress.phase,
          previewText: progress.previewText,
        });
      },
      onSessionEntryUpdated: (entry) => {
        this.hub.publish(chatId, "status", {
          chatId,
          status: entry.status,
          askPermissions: entry.askPermissions ?? null,
        });
        // P1-2 tool_progress 桥接：引擎条目携带工具调用列表时额外推送进度帧，
        // 供前端渲染「工具执行中」卡片（status 事件保留，二者载荷互补）；
        // toolCalls 为引擎透传的 unknown[]，必须经安全序列化才能进 SSE 载荷
        if (Array.isArray(entry.toolCalls) && entry.toolCalls.length > 0) {
          this.hub.publish(chatId, "tool_progress", {
            chatId,
            status: entry.status,
            toolCalls: serializeToolCallsForSse(entry.toolCalls),
          });
        }
      },
    });

    // MCP 服务器装配（与 exec-runner 同款：settings.mcpServers 直传）
    await manager.initMcpServers(settings.mcpServers);

    const chat: ChatSession = {
      chatId,
      manager,
      projectRoot: resolvedRoot,
      sessionId: null,
      createTime,
      busy: Promise.resolve(),
    };

    // 可选恢复：校验会话在当前项目索引中存在后 setActiveSessionId
    if (sessionId !== undefined) {
      const entry = manager.getSession(sessionId);
      if (!entry) {
        manager.dispose();
        throw new ApiError(404, `会话 ${sessionId} 在项目 ${resolvedRoot} 下不存在，无法恢复`);
      }
      manager.setActiveSessionId(sessionId);
      chat.sessionId = sessionId;
    }

    this.chats.set(chatId, chat);
    return { chatId, sessionId: chat.sessionId, projectRoot: resolvedRoot };
  }

  /**
   * 发送一条用户消息（同一 chatId 串行化执行；202 异步受理语义）。
   *
   * 执行序：同步校验 → 入队 Promise 链 → 立即返回受理结果。
   * handleUserPrompt 的整轮执行在后台异步进行（串行链保证同 chatId 顺序），
   * 本轮全部事件（assistant_message / llm_delta / tool_progress /
   * permission_request / status / done）均经 SSE 推送；
   * 轮次结束（含异常）时推 "done"（异常路径 status=failed，见 runTurn），
   * 保证 SSE 订阅方不会被悬死。
   *
   * @param chatId Web 会话 id
   * @param input 消息内容（text / imageUrls / 审批回注 permissions / alwaysAllows）
   * @returns 受理结果 {chatId, sessionId}（sessionId 允许 null）
   * @throws ApiError 404 会话不存在
   */
  sendMessage(chatId: string, input: SendMessageInput): SendMessageAcceptance {
    const chat = this.chats.get(chatId);
    if (!chat) {
      throw new ApiError(404, `会话 ${chatId} 不存在或已关闭`);
    }
    // Promise 链串行化：同一 chatId 的轮次按调用顺序依次执行，不同 chatId 并行
    const run = chat.busy.then(() => this.runTurn(chat, input));
    // 链尾吞错：错误已在 runTurn 内经 SSE done 收敛，这里仅防止污染后续轮次入队
    chat.busy = run.then(
      () => undefined,
      () => undefined
    );
    // fire-and-forget 兜底：runTurn 自身不向上抛错（catch 内收敛），此 catch 仅防御
    // 未来改动引入的逃逸异常，避免 unhandledRejection
    run.catch(() => undefined);
    // 202 异步受理：立即返回，本轮最终状态以 SSE done 载荷为准
    return { chatId: chat.chatId, sessionId: chat.sessionId };
  }

  /**
   * 执行单个对话轮次（在串行链内调用；不向调用方抛错）。
   *
   * @param chat 目标聊天
   * @param input 已校验的消息内容
   */
  private async runTurn(chat: ChatSession, input: SendMessageInput): Promise<void> {
    // 组装 UserPromptContent（仅携带非空字段，权限回注轮次可以没有 text）
    const prompt: UserPromptContent = {};
    if (input.text !== undefined && input.text !== "") {
      prompt.text = input.text;
    }
    if (input.imageUrls !== undefined && input.imageUrls.length > 0) {
      prompt.imageUrls = input.imageUrls;
    }
    if (input.permissions !== undefined && input.permissions.length > 0) {
      prompt.permissions = input.permissions;
    }
    if (input.alwaysAllows !== undefined && input.alwaysAllows.length > 0) {
      prompt.alwaysAllows = input.alwaysAllows;
    }

    // JS 语义：catch 先于 finally 执行。turnError 暂存异常，finally 同步 sessionId
    // 后统一收敛，保证异常路径同样推送 done 帧（订阅方不悬死）
    let turnError: unknown = null;
    try {
      await chat.manager.handleUserPrompt(prompt);
    } catch (error) {
      turnError = error;
    } finally {
      // 成败都同步 sessionId（异常路径下会话可能已创建，状态为 failed）
      chat.sessionId = chat.manager.getActiveSessionId() ?? chat.sessionId;
    }

    if (turnError !== null) {
      // P1-3：轮次异常必须推送 failed done 帧，否则前端等待本轮结束的订阅方悬死；
      // error 摘要随帧携带（DoneEvent 契约：仅 failed 时存在），再记录服务端日志
      const message = turnError instanceof Error ? turnError.message : String(turnError);
      const doneEvent: DoneEvent = {
        chatId: chat.chatId,
        sessionId: chat.sessionId,
        status: "failed",
        error: message,
      };
      this.hub.publish(chat.chatId, "done", doneEvent);
      console.error(`[session-pool] 轮次执行失败 chatId=${chat.chatId}: ${message}`);
      return;
    }

    const session = chat.sessionId ? chat.manager.getSession(chat.sessionId) : null;
    const status: SessionStatus = session?.status ?? "failed";

    // 权限审批请求：引擎暂停等待决策，推送明细供前端渲染审批卡片
    if (session?.status === "ask_permission" && session.askPermissions && session.askPermissions.length > 0) {
      this.hub.publish(chat.chatId, "permission_request", {
        chatId: chat.chatId,
        requests: session.askPermissions,
      });
    }

    // 轮次结束信号（前端据此收起停止按钮/刷新状态）
    this.hub.publish(chat.chatId, "done", {
      chatId: chat.chatId,
      sessionId: chat.sessionId,
      status,
    });
  }

  /**
   * 中断当前生成（对应引擎 interruptActiveSession，docs/dev/web-ui.md R8）。
   *
   * 不等待引擎收尾：handleUserPrompt 会随中断信号自行结束并经事件桥接推送 status/done。
   *
   * @param chatId Web 会话 id
   * @throws ApiError 404 会话不存在
   */
  interrupt(chatId: string): void {
    const chat = this.chats.get(chatId);
    if (!chat) {
      throw new ApiError(404, `会话 ${chatId} 不存在或已关闭`);
    }
    chat.manager.interruptActiveSession();
  }

  /**
   * 查询会话元信息（chat-api 响应组装用）。
   *
   * @param chatId Web 会话 id
   * @returns chatId / sessionId / projectRoot
   * @throws ApiError 404 会话不存在
   */
  getChatInfo(chatId: string): { chatId: string; sessionId: string | null; projectRoot: string } {
    const chat = this.chats.get(chatId);
    if (!chat) {
      throw new ApiError(404, `会话 ${chatId} 不存在或已关闭`);
    }
    return { chatId: chat.chatId, sessionId: chat.sessionId, projectRoot: chat.projectRoot };
  }

  /**
   * 读取会话历史消息（刷新恢复用）。
   *
   * @param chatId Web 会话 id
   * @returns 消息 DTO 列表（尚未产生底层会话时为空数组）
   * @throws ApiError 404 会话不存在
   */
  getMessages(chatId: string): ChatMessageDto[] {
    const chat = this.chats.get(chatId);
    if (!chat) {
      throw new ApiError(404, `会话 ${chatId} 不存在或已关闭`);
    }
    if (!chat.sessionId) {
      return [];
    }
    return chat.manager.listSessionMessages(chat.sessionId).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      visible: message.visible,
      createTime: message.createTime,
      updateTime: message.updateTime,
    }));
  }

  /**
   * 会话列表：池内活跃会话 + 各 allowRoot 项目磁盘历史合并，按 updateTime 降序。
   *
   * 去重规则：同一底层 sessionId 以池内活跃记录为准（历史记录跳过）。
   *
   * @returns 会话摘要列表
   */
  listChats(): ChatSummary[] {
    /** sessionId/chatId → 摘要 */
    const merged = new Map<string, ChatSummary>();

    // 1. 池内活跃会话
    for (const chat of this.chats.values()) {
      const entry = chat.sessionId ? chat.manager.getSession(chat.sessionId) : null;
      // P1-4 去重键统一为底层 sessionId：下方历史条目以 entry.id（即 sessionId）为键，
      // 活跃会话若已绑定 sessionId 必须使用同一键合并，否则同一底层会话会同时出现
      // 「活跃」与「历史」两条记录；尚无底层会话的活跃 chat 用 chatId 兜底（不可能冲突）
      const mergeKey = chat.sessionId ?? chat.chatId;
      merged.set(mergeKey, {
        chatId: chat.chatId,
        sessionId: chat.sessionId,
        projectRoot: chat.projectRoot,
        title: entry?.summary ?? null,
        status: entry?.status ?? "pending",
        createTime: chat.createTime,
        updateTime: entry?.updateTime ?? chat.createTime,
        source: "active",
      });
    }

    // 2. 磁盘历史：扫描各 allowRoot 的 sessions-index.json
    for (const root of this.jailRoots) {
      for (const entry of readProjectSessionIndex(root)) {
        // 同一 sessionId 已有活跃记录时以活跃为准
        if (merged.has(entry.id)) {
          continue;
        }
        merged.set(entry.id, {
          chatId: entry.id,
          sessionId: entry.id,
          projectRoot: root,
          title: entry.summary ?? null,
          status: entry.status,
          createTime: entry.createTime,
          updateTime: entry.updateTime,
          source: "history",
        });
      }
    }

    // 3. updateTime 降序
    return [...merged.values()].sort((a, b) =>
      a.updateTime < b.updateTime ? 1 : a.updateTime > b.updateTime ? -1 : 0
    );
  }

  /**
   * 释放全部会话（服务器优雅关闭时调用）：逐个 dispose 引擎并清空池。
   */
  disposeAll(): void {
    for (const chat of this.chats.values()) {
      try {
        chat.manager.dispose();
      } catch {
        // 引擎可能已释放，尽力而为
      }
    }
    this.chats.clear();
  }
}

/**
 * 对引擎透传的 toolCalls 做安全序列化（SSE 帧载荷必须可 JSON 化）。
 *
 * 引擎侧类型为 unknown[]，可能携带 Map / Set / BigInt / 函数 / 循环引用等
 * 无法直接 JSON.stringify 的结构；这里先经 replacer 兜底转换，再经序列化往返
 * 得到纯 JSON 数据；往返仍失败（如循环引用）时降级为计数描述，绝不抛出阻断事件流。
 *
 * @param toolCalls 引擎 SessionEntry.toolCalls 原始数组（调用方已保证非空数组）
 * @returns 可安全 JSON 序列化的数组
 */
function serializeToolCallsForSse(toolCalls: unknown[]): unknown[] {
  try {
    return JSON.parse(
      JSON.stringify(toolCalls, (_key, value: unknown) => {
        // BigInt 无 JSON 表示：降级为字符串（保留数值信息）
        if (typeof value === "bigint") {
          return value.toString();
        }
        // 函数无数据语义：替换为占位描述
        if (typeof value === "function") {
          return "[function]";
        }
        // Map / Set：转为可 JSON 化的普通结构
        if (value instanceof Map) {
          return Object.fromEntries(value);
        }
        if (value instanceof Set) {
          return Array.from(value);
        }
        return value;
      })
    ) as unknown[];
  } catch {
    // 循环引用等极端情况：降级为计数描述，保证 SSE 帧可发送
    return [{ toolCallCount: toolCalls.length, note: "toolCalls 含不可序列化结构，已降级展示" }];
  }
}

/**
 * 读取指定项目根的磁盘会话索引（sessions-index.json）。
 *
 * 路径约定与 core 一致：~/.deepcode/projects/<projectCode>/sessions-index.json。
 * 文件缺失/损坏时返回空数组（历史扫描是尽力而为，不阻断列表）。
 *
 * @param projectRoot 项目根目录
 * @returns 会话条目列表
 */
function readProjectSessionIndex(projectRoot: string): Array<{
  id: string;
  summary: string | null;
  status: SessionStatus;
  createTime: string;
  updateTime: string;
}> {
  const indexPath = path.join(homedir(), ".deepcode", "projects", getProjectCode(projectRoot), "sessions-index.json");
  if (!existsSync(indexPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as {
      entries?: Array<{
        id: string;
        summary: string | null;
        status: SessionStatus;
        createTime: string;
        updateTime: string;
      }>;
    };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

/** 导出 AskPermissionRequest 类型别名（api 层组装 permission_request 载荷用） */
export type { AskPermissionRequest };
