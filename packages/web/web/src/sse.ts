/**
 * SSE（EventSource）封装：per-chat 自动订阅 / 事件分发 / 生命周期管理。
 *
 * 设计要点（设计文档 §3.5）：
 * - 每个聊天会话一条 GET /api/chats/:id/stream 连接；
 * - 事件名与载荷字段与后端契约逐字一致：
 *   llm_delta / assistant_message / tool_progress / permission_request / status / done；
 * - EventSource 自带断线自动重连；连接级错误通过 onError 上抛，由上层决定是否关闭；
 * - 所有事件 data 均为 JSON：解析失败的事件防御性忽略（不中断连接）。
 */

/** 权限请求（permission_request 事件中的单个请求项） */
export interface PermissionRequest {
  toolCallId: string;
  name: string;
  /** 命令内容（如 shell 命令行；无命令的工具可缺省） */
  command?: string;
  description?: string;
  /** 申请的权限范围（如 write-in-cwd） */
  scopes?: string[];
}

/** llm_delta 事件载荷：流式文本增量 */
export interface LlmDeltaEvent {
  chatId: string;
  /** start=开始生成 / update=内容更新 / end=生成结束 */
  phase: "start" | "update" | "end";
  /** 当前累积的预览文本（纯文本，未完成 Markdown 不做半截解析） */
  previewText: string;
}

/** assistant_message 事件载荷：完整助手消息 */
export interface AssistantMessageEvent {
  chatId: string;
  messageId: string;
  /** 完整 Markdown 文本 → 交给 A2UI 渲染管线 */
  content: string;
}

/** tool_progress 事件中的单个工具调用进度项 */
export interface ToolCallProgress {
  /** 工具调用 id（折叠条目归并主键；异常缺失时由渲染层退化为固定 id 合并展示） */
  toolCallId?: string;
  /** 工具展示名（name 为主，toolName 为兼容别名） */
  name?: string;
  /** 工具展示名（兼容别名） */
  toolName?: string;
  /** 单项执行状态（缺省时回退事件级 status） */
  status?: string;
  /** 进度说明文本（如"正在读取文件…"） */
  message?: string;
  /** 后端附加的扩展字段，渲染层原样保留（信息不丢失） */
  [key: string]: unknown;
}

/**
 * tool_progress 事件载荷：工具执行进度（P1-2 契约：{chatId, status, toolCalls}）。
 * 每个工具调用项渲染为一个折叠条目，按 toolCallId 归并更新。
 */
export interface ToolProgressEvent {
  chatId: string;
  /** 事件级状态（本轮工具执行整体状态；单项缺省 status 时回退使用） */
  status: string;
  /** 工具调用明细列表 */
  toolCalls?: ToolCallProgress[];
  /** 后端附加的扩展字段（保留原始键值，防御性兼容） */
  [key: string]: unknown;
}

/** permission_request 事件载荷 */
export interface PermissionRequestEvent {
  chatId: string;
  requests: PermissionRequest[];
}

/** status 事件载荷：会话状态变化 */
export interface StatusEvent {
  chatId: string;
  status: string;
  /** 处于 ask_permission 状态时携带待审批列表（订阅初始快照可能为 null） */
  askPermissions?: PermissionRequest[] | null;
}

/** done 事件载荷：一轮对话结束（P2：sessionId 在首个消息前可能为 null） */
export interface DoneEvent {
  chatId: string;
  sessionId: string | null;
  status: string;
}

/** 事件回调集合：App 层按事件类型分发状态更新 */
export interface SseCallbacks {
  onLlmDelta: (e: LlmDeltaEvent) => void;
  onAssistantMessage: (e: AssistantMessageEvent) => void;
  onToolProgress: (e: ToolProgressEvent) => void;
  onPermissionRequest: (e: PermissionRequestEvent) => void;
  onStatus: (e: StatusEvent) => void;
  onDone: (e: DoneEvent) => void;
  /** 连接级错误（EventSource 自动重连中；上层可据此提示或关闭） */
  onConnectionError: () => void;
  /** 连接建立成功（可选） */
  onOpen?: () => void;
}

/** 安全解析 SSE data JSON：畸形数据返回 null（调用方忽略） */
function parseEventData<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * ChatStream：单个聊天会话的 SSE 连接管理器。
 * - connect(chatId)：同会话幂等（已连接直接复用），切换会话先关旧连；
 * - close()：主动断开（仅切换会话 / 组件卸载 / 登出时调用；done 后订阅保留，P0-2）。
 */
export class ChatStream {
  /** 当前 EventSource 实例 */
  private es: EventSource | null = null;
  /** 当前连接的 chatId */
  private currentChatId: string | null = null;

  /** 当前已连接的 chatId（未连接时为 null） */
  get connectedChatId(): string | null {
    return this.currentChatId;
  }

  /**
   * 建立（或复用）指定会话的事件流订阅。
   * @param chatId 目标会话
   * @param cb     事件回调集合
   */
  connect(chatId: string, cb: SseCallbacks): void {
    // 同一会话重复调用：直接复用现有连接（避免重复订阅导致事件重复）
    if (this.currentChatId === chatId && this.es !== null) return;
    this.close();

    const es = new EventSource(`/api/chats/${encodeURIComponent(chatId)}/stream`, {
      withCredentials: false, // 同源 Cookie 自动携带；无需跨域凭据
    });
    this.es = es;
    this.currentChatId = chatId;

    es.onopen = () => cb.onOpen?.();
    es.onerror = () => {
      // 连接错误：EventSource 内建重连；仅在上层回调中通知（可提示"重连中"）
      cb.onConnectionError();
    };

    /** 注册具名事件并安全分发 */
    const on = <T>(name: string, handler: (e: T) => void): void => {
      es.addEventListener(name, (ev) => {
        const data = parseEventData<T>((ev as MessageEvent<string>).data);
        if (data !== null) handler(data);
      });
    };

    on<LlmDeltaEvent>("llm_delta", cb.onLlmDelta);
    on<AssistantMessageEvent>("assistant_message", cb.onAssistantMessage);
    on<ToolProgressEvent>("tool_progress", cb.onToolProgress);
    on<PermissionRequestEvent>("permission_request", cb.onPermissionRequest);
    on<StatusEvent>("status", cb.onStatus);
    on<DoneEvent>("done", cb.onDone);
  }

  /** 关闭当前连接（幂等） */
  close(): void {
    if (this.es !== null) {
      this.es.close();
      this.es = null;
    }
    this.currentChatId = null;
  }
}
