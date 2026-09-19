/**
 * App：登录态路由 + 布局骨架 + 会话选择 + SSE 事件归并（应用唯一状态容器）。
 *
 * 登录态路由：GET /api/auth/me → 200 进入主布局；401 渲染登录页（不引入路由库）。
 * SSE 归并：ChatStream 回调把六类事件归并为 ChatEntry 流（乐观上屏 / 流式预览 /
 * 工具折叠条目 / 权限卡片），全部使用函数式 setState + ref，避免陈旧闭包。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChat,
  fetchConfig,
  fetchMe,
  fetchMessages,
  interruptChat,
  listChats,
  logout as apiLogout,
  sendPermissionDecisions,
  sendMessageWithFiles,
  sendTextMessage,
  ApiError,
  type AppConfig,
  type ChatMessageDto,
  type ChatSummary,
  type UserInfo,
} from "./api";
import type { ChatEntry, UserAttachment } from "./chat-model";
import { ChatPane } from "./components/ChatPane";
import { Composer } from "./components/Composer";
import { FileDrawer } from "./components/FileDrawer";
import { LoginView } from "./components/LoginView";
import { SessionSidebar } from "./components/SessionSidebar";
import {
  ChatStream,
  type DoneEvent,
  type LlmDeltaEvent,
  type PermissionRequestEvent,
  type StatusEvent,
  type ToolProgressEvent,
  type AssistantMessageEvent,
} from "./sse";

/** 登录态三阶段：checking=启动检查中；authed=已登录；anon=未登录/会话过期 */
type AuthState = "checking" | "authed" | "anon";

/** App 根组件 */
export function App() {
  // ---------- 登录与配置 ----------
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [user, setUser] = useState<UserInfo | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);

  // ---------- 会话与对话流 ----------
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [creatingChat, setCreatingChat] = useState(false);
  /** 新建对话选用的项目根（默认第一个白名单根） */
  const [projectRoot, setProjectRoot] = useState("");

  // ---------- 布局与交互 ----------
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [fileDrawerOpen, setFileDrawerOpen] = useState(false);
  /** 文件抽屉"作为附件插入对话"的服务器路径附件 */
  const [serverFiles, setServerFiles] = useState<UserAttachment[]>([]);
  /** 全局轻提示（错误/重连提示，4 秒自动消失） */
  const [toast, setToast] = useState<string | null>(null);
  /** 决策提交中的 toolCallId 集合（禁用对应卡片按钮） */
  const [submittingPermIds, setSubmittingPermIds] = useState<Set<string>>(new Set());

  // ---------- refs：SSE 回调与异步流程中读取"当前值"，避免陈旧闭包 ----------
  const streamRef = useRef<ChatStream | null>(null);
  const activeChatIdRef = useRef<string | null>(null);
  const streamingRef = useRef(false);
  /** 乐观条目自增序号（保证 key 稳定唯一） */
  const seqRef = useRef(0);

  /** 展示轻提示（替换式单条） */
  const showToast = useCallback((msg: string): void => {
    setToast(msg);
    window.setTimeout(() => {
      setToast((cur) => (cur === msg ? null : cur));
    }, 4000);
  }, []);

  /** 统一的流式状态写入（同步镜像到 ref，供 SSE 错误回调判断） */
  const applyStreaming = useCallback((v: boolean): void => {
    streamingRef.current = v;
    setStreaming(v);
  }, []);

  /** 401 统一处理：切换到登录页并清理会话状态 */
  const handleUnauthorized = useCallback((): void => {
    setAuthState("anon");
    setUser(null);
    setActiveChatId(null);
    activeChatIdRef.current = null;
    setEntries([]);
    applyStreaming(false);
    streamRef.current?.close();
  }, [applyStreaming]);

  // ---------- SSE 事件归并（全部走函数式 setState，仅依赖稳定引用） ----------

  /** llm_delta：流式预览（start 建泡 / update·end 更新 previewText + 光标） */
  const onLlmDelta = useCallback(
    (e: LlmDeltaEvent): void => {
      if (e.chatId !== activeChatIdRef.current) return; // 丢弃旧会话残余事件
      applyStreaming(true);
      setEntries((prev) => {
        const idx = prev.findIndex((x) => x.kind === "assistant" && x.id === "stream");
        if (idx >= 0) {
          // 已有流式气泡：更新预览文本
          const next = [...prev];
          next[idx] = { kind: "assistant", id: "stream", content: null, preview: e.previewText, done: false };
          return next;
        }
        // start（或漏收 start）：新建流式气泡
        return [...prev, { kind: "assistant", id: "stream", content: null, preview: e.previewText, done: false }];
      });
    },
    [applyStreaming]
  );

  /** assistant_message：完整内容到达 → 用 messageId 固化气泡并进入 A2UI 管线 */
  const onAssistantMessage = useCallback((e: AssistantMessageEvent): void => {
    if (e.chatId !== activeChatIdRef.current) return;
    setEntries((prev) => {
      const streamIdx = prev.findIndex((x) => x.kind === "assistant" && x.id === "stream");
      if (streamIdx >= 0) {
        // 流式气泡升级为正式消息（换 id，触发 A2UI 解析）
        const next = [...prev];
        next[streamIdx] = { kind: "assistant", id: e.messageId, content: e.content, preview: null, done: true };
        return next;
      }
      const existIdx = prev.findIndex((x) => x.kind === "assistant" && x.id === e.messageId);
      if (existIdx >= 0) {
        // 同 id 消息更新（重放/修正）
        const next = [...prev];
        next[existIdx] = { kind: "assistant", id: e.messageId, content: e.content, preview: null, done: true };
        return next;
      }
      return [...prev, { kind: "assistant", id: e.messageId, content: e.content, preview: null, done: true }];
    });
  }, []);

  /**
   * tool_progress：工具执行进度（P1-2 契约：载荷 {chatId, status, toolCalls}）。
   * 每个工具调用项渲染为一个折叠条目，按 toolCallId 归并（同 id 后到覆盖前到）；
   * toolCalls 缺失/非数组时防御性退化为把整个事件视为单项（扩展字段不丢失）。
   */
  const onToolProgress = useCallback((e: ToolProgressEvent): void => {
    if (e.chatId !== activeChatIdRef.current) return;
    // 归一化为单项列表：toolCalls 为数组时逐项展开，否则整体视为一项
    const items: Record<string, unknown>[] = Array.isArray(e.toolCalls)
      ? (e.toolCalls as Record<string, unknown>[])
      : [e as unknown as Record<string, unknown>];
    setEntries((prev) => {
      let next = prev;
      for (const item of items) {
        // 展示名：item.name / item.toolName 优先，均缺省时"工具执行"
        const name =
          typeof item.name === "string" && item.name !== ""
            ? item.name
            : typeof item.toolName === "string" && item.toolName !== ""
              ? item.toolName
              : "工具执行";
        // 归并主键：toolCallId 稳定归并；缺失时退化为固定 id（无名多项合并为一条展示）
        const id =
          typeof item.toolCallId === "string" && item.toolCallId !== "" ? `tool-${item.toolCallId}` : "tool-anon";
        // 单项状态优先，回退事件级 status
        const status = typeof item.status === "string" && item.status !== "" ? item.status : e.status;
        // raw 同时保留事件级与单项数据（信息不丢失，展开可见全部字段）
        const entry: ChatEntry = { kind: "tool", id, label: name, status, raw: { event: e, item } };
        const idx = next.findIndex((x) => x.id === id);
        if (idx >= 0) {
          next = [...next];
          next[idx] = entry;
        } else {
          next = [...next, entry];
        }
      }
      return next;
    });
  }, []);

  /** permission_request：内联审批卡片（幂等追加） */
  const onPermissionRequest = useCallback((e: PermissionRequestEvent): void => {
    if (e.chatId !== activeChatIdRef.current) return;
    setEntries((prev) => {
      const additions: ChatEntry[] = [];
      for (const req of e.requests ?? []) {
        const id = `perm-${req.toolCallId}`;
        if (!prev.some((x) => x.id === id) && !additions.some((x) => x.id === id)) {
          additions.push({ kind: "permission", id, request: req, submitting: false });
        }
      }
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
  }, []);

  /** status：运行状态同步（后端 SessionStatus 语义：processing = 执行中）；askPermissions 兜底建卡 */
  const onStatus = useCallback(
    (e: StatusEvent): void => {
      if (e.chatId !== activeChatIdRef.current) return;
      // 与引擎状态对齐（P0-1）：SessionStatus 无 "running"，执行中为 "processing"
      if (e.status === "processing") applyStreaming(true);
      if (Array.isArray(e.askPermissions) && e.askPermissions.length > 0) {
        onPermissionRequest({ chatId: e.chatId, requests: e.askPermissions });
      }
    },
    [applyStreaming, onPermissionRequest]
  );

  /**
   * done：一轮对话结束 → 复位流式状态、刷新列表状态。
   * P0-2：订阅保留不关闭（仅在切换会话/组件卸载/登出时断开），
   * 避免每轮重建 EventSource 的开销与订阅空窗期事件丢失。
   */
  const onDone = useCallback(
    (e: DoneEvent): void => {
      if (e.chatId !== activeChatIdRef.current) return;
      applyStreaming(false);
      // P0-1/P2：列表项主键为 chatId；done 携带的 sessionId 可为 null（首个消息前），null 时保留原值
      setChats((prev) =>
        prev.map((c) => (c.chatId === e.chatId ? { ...c, status: e.status, sessionId: e.sessionId ?? c.sessionId } : c))
      );
    },
    [applyStreaming]
  );

  /** SSE 连接错误：EventSource 自动重连；生成中时给出轻提示 */
  const onConnectionError = useCallback((): void => {
    if (streamingRef.current) showToast("连接中断，正在自动重连…");
  }, [showToast]);

  /** 稳定的 SSE 回调集合（connect 复用连接时不会重挂监听，故必须稳定） */
  const sseCallbacksRef = useRef({
    onLlmDelta,
    onAssistantMessage,
    onToolProgress,
    onPermissionRequest,
    onStatus,
    onDone,
    onConnectionError,
  });
  // 每次渲染刷新回调引用（useCallback 已保证多数为稳定引用）
  sseCallbacksRef.current = {
    onLlmDelta,
    onAssistantMessage,
    onToolProgress,
    onPermissionRequest,
    onStatus,
    onDone,
    onConnectionError,
  };

  /** 建立/复用指定会话的事件流 */
  const ensureStream = useCallback((chatId: string): void => {
    if (streamRef.current === null) streamRef.current = new ChatStream();
    streamRef.current.connect(chatId, {
      get onLlmDelta() {
        return sseCallbacksRef.current.onLlmDelta;
      },
      get onAssistantMessage() {
        return sseCallbacksRef.current.onAssistantMessage;
      },
      get onToolProgress() {
        return sseCallbacksRef.current.onToolProgress;
      },
      get onPermissionRequest() {
        return sseCallbacksRef.current.onPermissionRequest;
      },
      get onStatus() {
        return sseCallbacksRef.current.onStatus;
      },
      get onDone() {
        return sseCallbacksRef.current.onDone;
      },
      get onConnectionError() {
        return sseCallbacksRef.current.onConnectionError;
      },
    });
  }, []);

  // ---------- 会话操作 ----------

  /**
   * 历史消息 → ChatEntry 归并（P2）：
   * - 过滤 visible === false（工具执行等对用户不可见的内部消息）；
   * - 过滤 content 为空（null / 空串）的条目；
   * - role 分发：user → 用户气泡；tool → 折叠工具条目；其余（assistant/system）→ A2UI 管线。
   */
  const convertHistory = useCallback((dtos: ChatMessageDto[]): ChatEntry[] => {
    const result: ChatEntry[] = [];
    for (const d of dtos) {
      // 不可见消息不渲染（后端契约为必填布尔，缺省视为可见以兼容宽松实现）
      if (d.visible === false) continue;
      // 空内容消息不渲染（null / 空串）
      const content = typeof d.content === "string" ? d.content : "";
      if (content === "") continue;
      if (d.role === "user") {
        result.push({ kind: "user", id: `h-${d.id}`, text: content, attachments: [], createTime: d.createTime });
      } else if (d.role === "tool") {
        // 历史工具条目：展示名取 content 首行（截断到 60 字符），全文保留在 raw 中不丢信息
        const firstLine = content.split("\n", 1)[0] ?? "";
        const label = firstLine === "" ? "工具执行" : firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
        result.push({ kind: "tool", id: `h-${d.id}`, label, status: "completed", raw: { content } });
      } else {
        // assistant / system：统一按助手内容进 A2UI 管线（system 不静默丢弃）
        result.push({ kind: "assistant", id: `h-${d.id}`, content, preview: null, done: true });
      }
    }
    return result;
  }, []);

  /**
   * 选择会话：先建立持久 SSE 订阅（P0-2：订阅即建立，done 后不关闭），
   * 再拉取历史并合并——订阅窗口内已到达的实时事件不丢：
   * 历史条目前插，同源助手消息（历史 id 为 h-<id>、实时 id 为 messageId）去重保留实时版本。
   */
  const selectChat = useCallback(
    (chatId: string): void => {
      if (chatId === activeChatIdRef.current) return;
      activeChatIdRef.current = chatId;
      setActiveChatId(chatId);
      setEntries([]);
      applyStreaming(false);
      setServerFiles([]); // 切换会话清空未发送的抽屉附件
      // 持久订阅：connect 内部会先关闭旧会话连接再订阅新会话（同会话幂等复用）
      ensureStream(chatId);
      fetchMessages(chatId)
        .then(({ messages }) => {
          // 仅当仍是当前会话时应用（防止快速切换竞态覆盖）
          if (activeChatIdRef.current !== chatId) return;
          const history = convertHistory(messages);
          setEntries((prev) => {
            if (prev.length === 0) return history;
            // 订阅窗口内已有实时事件：历史前插 + 同源助手消息去重（h-<id> 对比实时 messageId）
            const liveIds = new Set(prev.filter((x) => x.kind === "assistant").map((x) => x.id));
            const deduped = history.filter((h) => h.kind !== "assistant" || !liveIds.has(h.id.slice(2)));
            return [...deduped, ...prev];
          });
        })
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 401) {
            handleUnauthorized();
            return;
          }
          showToast(e instanceof Error ? e.message : "历史消息加载失败");
        });
    },
    [applyStreaming, convertHistory, ensureStream, handleUnauthorized, showToast]
  );

  /** 新建对话（projectRoot 来自侧栏选择；本地列表项字段与后端 ChatSummary 契约对齐） */
  const newChat = useCallback((): void => {
    if (creatingChat) return;
    // 空根防御（第一次启动 allowRoots 未配置时 projectRoot 为空字符串）：
    // 不发必然 400 的请求，直接提示配置方法（docs/dev/web-ui.md §3.3 allowRoots 说明）
    if (projectRoot === "") {
      showToast("未配置可用的项目根目录：请在 ~/.deepcode/settings.json 的 web.allowRoots 中添加目录后重启");
      return;
    }
    setCreatingChat(true);
    createChat(projectRoot)
      .then(({ chatId }) => {
        const now = new Date().toISOString();
        // POST /api/chats 仅返回 {chatId, sessionId}；列表项按后端契约本地补全
        // （status 用引擎合法状态 pending；sessionId 在首个消息发出前为 null）
        setChats((prev) => [
          {
            chatId,
            sessionId: null,
            projectRoot,
            title: null,
            status: "pending",
            createTime: now,
            updateTime: now,
            source: "active",
          },
          ...prev,
        ]);
        activeChatIdRef.current = chatId;
        setActiveChatId(chatId);
        setEntries([]);
        applyStreaming(false);
        setServerFiles([]);
        ensureStream(chatId);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          handleUnauthorized();
          return;
        }
        showToast(e instanceof Error ? e.message : "新建对话失败");
      })
      .finally(() => setCreatingChat(false));
  }, [applyStreaming, creatingChat, ensureStream, handleUnauthorized, projectRoot, showToast]);

  /**
   * 发送消息：乐观上屏 → 按附件形态选择 JSON / multipart 通道。
   * P1-1：POST /messages 为 202 异步受理（fire-and-forget）——返回 2xx 即视为受理成功，
   * 不等待整轮完成；流式文本 / 工具进度 / 审批卡片 / done 复位全部由持久 SSE 订阅驱动。
   * P0-2：发送前确保事件流已订阅（connect 对同一会话幂等复用，不重复建连）。
   */
  const sendMessage = useCallback(
    (text: string, localFiles: File[], serverAttachments: UserAttachment[]): void => {
      const chatId = activeChatIdRef.current;
      if (chatId === null) return;
      // 发送前确保已订阅（P0-2）：订阅断线/未建连时由 connect 兜底补建
      ensureStream(chatId);

      // 乐观用户消息（先上屏，受理后等待 SSE 流式回包）
      const attachments: UserAttachment[] = [
        ...localFiles.map((f) => ({ name: f.name, source: "local" as const, image: f.type.startsWith("image/") })),
        ...serverAttachments,
      ];
      const entryId = `user-${seqRef.current++}`;
      setEntries((prev) => [
        ...prev,
        { kind: "user", id: entryId, text, attachments, createTime: new Date().toISOString() },
      ]);
      applyStreaming(true);

      // 服务器路径附件中的非图片文件：并入文本引用（agent 可经工具读取该路径）
      const pathMentions = serverAttachments
        .filter((sf) => !sf.image)
        .map((sf) => `\n[文件: ${sf.name}]`)
        .join("");
      const serverImagePaths = serverAttachments.filter((sf) => sf.image).map((sf) => sf.name);

      /** 受理成功（202/200）：仅清理抽屉附件；streaming 复位交给 done 事件（P0-2 订阅保留） */
      const finish = (): void => {
        setServerFiles([]); // 已随消息发出，清空抽屉附件
      };
      const fail = (e: unknown): void => {
        applyStreaming(false);
        if (e instanceof ApiError && e.status === 401) {
          handleUnauthorized();
          return;
        }
        showToast(e instanceof Error ? e.message : "消息发送失败");
      };

      if (localFiles.length > 0) {
        // 本地附件：multipart（text 字段 + 多个 file 字段）；服务器图片路径并入文本
        const mentionImages = serverImagePaths.map((p) => `\n[图片: ${p}]`).join("");
        sendMessageWithFiles(chatId, `${text}${mentionImages}${pathMentions}`, localFiles).then(finish).catch(fail);
      } else if (serverImagePaths.length > 0) {
        // 服务器图片：JSON {text, imageUrls}（设计文档 §2.1：本地路径可传入 imageUrls）
        sendTextMessage(chatId, { text: `${text}${pathMentions}`, imageUrls: serverImagePaths })
          .then(finish)
          .catch(fail);
      } else {
        // 纯文本（可能含服务器文件路径引用）
        sendTextMessage(chatId, { text: `${text}${pathMentions}` })
          .then(finish)
          .catch(fail);
      }
    },
    [applyStreaming, ensureStream, handleUnauthorized, showToast]
  );

  /**
   * 权限决策回注（P1-1）：POST {permissions:[...]} → 202 受理即成功（fire-and-forget），
   * 卡片立即进入已决策只读态；决策后的续跑事件（流式文本 / 后续审批 / done 复位）
   * 全部由持久 SSE 订阅推送，无需在此重建订阅（P0-2）。
   */
  const decide = useCallback(
    (toolCallId: string, decision: "allow" | "deny"): void => {
      const chatId = activeChatIdRef.current;
      if (chatId === null) return;
      setSubmittingPermIds((prev) => new Set(prev).add(toolCallId));
      sendPermissionDecisions(chatId, { permissions: [{ toolCallId, permission: decision }] })
        .then(() => {
          // 202 受理成功：卡片置为已决策只读态（submitting 复位）
          setEntries((prev) =>
            prev.map((x) =>
              x.kind === "permission" && x.request.toolCallId === toolCallId
                ? { ...x, decided: decision, submitting: false }
                : x
            )
          );
        })
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 401) {
            handleUnauthorized();
            return;
          }
          showToast(e instanceof Error ? e.message : "审批提交失败");
        })
        .finally(() => {
          setSubmittingPermIds((prev) => {
            const next = new Set(prev);
            next.delete(toolCallId);
            return next;
          });
        });
    },
    [handleUnauthorized, showToast]
  );

  /** 停止生成 */
  const stop = useCallback((): void => {
    const chatId = activeChatIdRef.current;
    if (chatId === null) return;
    interruptChat(chatId).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 401) {
        handleUnauthorized();
        return;
      }
      showToast(e instanceof Error ? e.message : "停止失败");
    });
  }, [handleUnauthorized, showToast]);

  /** 登出：清 Cookie 并复位全部状态 */
  const logout = useCallback((): void => {
    apiLogout()
      .catch(() => undefined) // 登出接口失败也不阻塞本地登出
      .finally(() => handleUnauthorized());
  }, [handleUnauthorized]);

  /** 文件抽屉：作为附件插入对话 */
  const insertAttachment = useCallback((path: string, isImage: boolean): void => {
    setServerFiles((prev) =>
      prev.some((sf) => sf.name === path) ? prev : [...prev, { name: path, source: "server", image: isImage }]
    );
  }, []);

  // ---------- 启动 / 登录成功后的初始化 ----------

  const init = useCallback((): void => {
    setAuthState("checking");
    fetchMe()
      .then((me) => {
        setUser(me);
        setAuthState("authed");
      })
      .catch((e: unknown) => {
        // 401 → 登录页；其它错误也回退登录页（无用户态无法使用）
        if (!(e instanceof ApiError)) console.warn("用户态检查失败", e);
        setAuthState("anon");
      });
  }, []);

  // authed 后拉取配置与会话列表
  useEffect(() => {
    if (authState !== "authed") return;
    fetchConfig()
      .then((cfg) => {
        setConfig(cfg);
        setProjectRoot((cur) => (cur !== "" ? cur : (cfg.allowRoots[0] ?? "")));
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          handleUnauthorized();
          return;
        }
        showToast(e instanceof Error ? e.message : "配置加载失败");
      });
    listChats()
      .then(({ chats: list }) => setChats(list))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          handleUnauthorized();
          return;
        }
        showToast(e instanceof Error ? e.message : "会话列表加载失败");
      });
  }, [authState, handleUnauthorized, showToast]);

  // 首次挂载：检查登录态
  useEffect(() => {
    init();
  }, [init]);

  // 卸载清理：关闭 SSE
  useEffect(() => {
    return () => streamRef.current?.close();
  }, []);

  // ---------- 渲染 ----------

  // 启动检查：极简 splash
  if (authState === "checking") {
    return (
      <div className="app-splash">
        <span className="app-splash-brand">DeepCodeX</span>
      </div>
    );
  }

  // 未登录：登录页
  if (authState === "anon" || user === null) {
    return <LoginView ldapEnabled={config?.ldapEnabled ?? null} onSuccess={init} />;
  }

  // P0-1：会话主键为 chatId（与后端 ChatSummary 契约一致）
  const activeChat = chats.find((c) => c.chatId === activeChatId) ?? null;

  return (
    <div className="app">
      {/* 左侧栏 */}
      <SessionSidebar
        collapsed={sidebarCollapsed}
        chats={chats}
        activeChatId={activeChatId}
        user={user}
        allowRoots={config?.allowRoots ?? []}
        projectRoot={projectRoot}
        creating={creatingChat}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
        onSelectChat={selectChat}
        onNewChat={newChat}
        onProjectRootChange={setProjectRoot}
        onLogout={logout}
      />

      {/* 主区：对话流 + 输入框 */}
      <div className="main-area">
        <ChatPane
          entries={entries}
          streaming={streaming}
          chatTitle={activeChat !== null ? (activeChat.title ?? "未命名对话") : null}
          onDecide={decide}
          onStop={stop}
          onOpenFileDrawer={() => setFileDrawerOpen(true)}
          submittingPermIds={submittingPermIds}
        />
        <Composer
          disabled={activeChatId === null}
          streaming={streaming}
          maxUploadBytes={config?.maxUploadBytes ?? 0}
          serverFiles={serverFiles}
          onRemoveServerFile={(i) => setServerFiles((prev) => prev.filter((_, idx) => idx !== i))}
          onSend={sendMessage}
          onStop={stop}
        />
      </div>

      {/* 右侧文件抽屉 */}
      <FileDrawer
        open={fileDrawerOpen}
        allowRoots={config?.allowRoots ?? []}
        onClose={() => setFileDrawerOpen(false)}
        onInsertAttachment={insertAttachment}
      />

      {/* 全局轻提示 */}
      {toast !== null && <div className="toast">{toast}</div>}
    </div>
  );
}
