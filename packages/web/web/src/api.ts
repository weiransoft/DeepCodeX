/**
 * 后端 REST API 封装（与设计文档 §3.5 API 表逐字段对齐）。
 *
 * 约定：
 * - 认证为 HttpOnly Cookie，全部请求 credentials: "same-origin"；
 * - 统一错误处理：非 2xx 抛出 ApiError（携带 HTTP 状态码与服务端 error 文本）；
 *   401 由 App 捕获后切换到登录页（会话过期/未登录的唯一判定来源）；
 * - JSON 请求带 Content-Type: application/json；FormData 由浏览器自动生成
 *   multipart 边界，绝不手动设置 Content-Type。
 */

/** 权限决策（审批回注） */
export interface PermissionDecision {
  /** 工具调用 id（来自 permission_request 事件） */
  toolCallId: string;
  /** 决策：允许 / 拒绝 */
  permission: "allow" | "deny";
}

/** 当前登录用户信息（GET /api/auth/me） */
export interface UserInfo {
  username: string;
  displayName: string;
  mail: string;
  authSource: string;
}

/** 脱敏配置（GET /api/config，不含任何密钥） */
export interface AppConfig {
  allowRoots: string[];
  maxUploadBytes: number;
  ldapEnabled: boolean;
}

/**
 * 会话摘要（GET /api/chats 列表项）。
 * 字段与后端 packages/web/src/types.ts 的 ChatSummary 逐字一致（P0-1 契约对齐）。
 */
export interface ChatSummary {
  /** Web 会话 id（后端 SessionPool 内部分配；磁盘历史会话为底层 sessionId） */
  chatId: string;
  /** 底层 SessionManager 会话 id（首个消息发出前为 null） */
  sessionId: string | null;
  /** 会话所属项目根目录 */
  projectRoot: string;
  /** 会话标题摘要（可能为 null：尚无摘要时前端展示"未命名对话"） */
  title: string | null;
  /** 引擎状态（SessionStatus：pending / processing / completed / ask_permission 等） */
  status: string;
  /** 创建时间（ISO 字符串） */
  createTime: string;
  /** 最后更新时间（ISO 字符串，列表按此降序） */
  updateTime: string;
  /** 来源：active = 本进程 SessionPool 内活跃；history = 磁盘 sessions-index 历史 */
  source: "active" | "history";
}

/**
 * 历史消息（GET /api/chats/:id/messages 列表项）。
 * 字段与后端 packages/web/src/types.ts 的 ChatMessageDto 逐字一致（P2 契约对齐）。
 */
export interface ChatMessageDto {
  /** 消息唯一 id */
  id: string;
  /** 角色：user / assistant / tool / system（后端为宽松 string，前端按值分发） */
  role: string;
  /** 消息文本（可能为 null：结构化消息无纯文本） */
  content: string | null;
  /** 是否对用户可见（false = 工具执行等内部消息，渲染历史时必须过滤） */
  visible: boolean;
  /** 创建时间（ISO 字符串） */
  createTime: string;
  /** 最后更新时间（ISO 字符串） */
  updateTime: string;
}

/** 目录条目（GET /api/files） */
export interface FileEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  mtime: string;
}

/** 目录列表响应 */
export interface FileListing {
  path: string;
  entries: FileEntry[];
}

/** 发送文本消息载荷（JSON 路径；imageUrls 为图片本地路径/数据地址，见设计文档 §2.1） */
export interface SendTextPayload {
  text: string;
  imageUrls?: string[];
}

/** 审批回注载荷（有权限请求时即"审批回注"消息，见设计文档 §3.5） */
export interface SendPermissionsPayload {
  permissions: PermissionDecision[];
}

/**
 * API 错误：携带 HTTP 状态码与可读信息。
 * status === 401 表示未登录/会话过期；status === 0 表示网络层失败。
 */
export class ApiError extends Error {
  /** HTTP 状态码（0 = 网络错误/请求未达） */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * 统一请求函数。
 * @param method HTTP 方法
 * @param url    相对路径（以 /api 开头）
 * @param body   JSON 对象 / FormData / undefined
 * @returns 解析后的 JSON（响应非 JSON 时返回 undefined）
 */
async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  /** 请求头：仅 JSON 请求显式设置；FormData 必须留给浏览器自动生成边界 */
  const headers: Record<string, string> = {};
  /** 请求体 */
  let fetchBody: BodyInit | undefined;
  if (body !== undefined) {
    if (body instanceof FormData) {
      fetchBody = body;
    } else {
      headers["Content-Type"] = "application/json";
      fetchBody = JSON.stringify(body);
    }
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: fetchBody,
      credentials: "same-origin", // HttpOnly Cookie 认证：同源自动携带
    });
  } catch {
    // fetch 仅在网络层失败时 reject（断网/DNS/中断）
    throw new ApiError(0, "网络错误，请检查连接后重试");
  }

  // 204 / 202 等无内容响应直接返回 undefined
  if (resp.status === 204 || resp.status === 202) {
    return undefined as T;
  }

  // 非 2xx：尝试读取服务端 {error} 字段，取不到则用状态文本
  if (!resp.ok) {
    let message = `请求失败（HTTP ${resp.status}）`;
    try {
      const data = (await resp.json()) as { error?: unknown; message?: unknown };
      if (typeof data?.error === "string" && data.error.length > 0) {
        message = data.error;
      } else if (typeof data?.message === "string" && data.message.length > 0) {
        message = data.message;
      }
    } catch {
      // 响应体不是 JSON：保留默认错误文案
    }
    throw new ApiError(resp.status, message);
  }

  // 成功响应：尽力解析 JSON（空体返回 undefined）
  const text = await resp.text();
  if (text === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(resp.status, "服务端响应格式异常（非 JSON）");
  }
}

/** 登录：成功后由服务端 Set-Cookie 下发 HttpOnly JWT */
export function login(username: string, password: string): Promise<void> {
  return request<void>("POST", "/api/auth/login", { username, password });
}

/** 登出：服务端清除 Cookie */
export function logout(): Promise<void> {
  return request<void>("POST", "/api/auth/logout");
}

/** 当前用户信息；401 表示未登录 */
export function fetchMe(): Promise<UserInfo> {
  return request<UserInfo>("GET", "/api/auth/me");
}

/** 脱敏配置（allowRoots / 上传上限 / LDAP 是否启用） */
export function fetchConfig(): Promise<AppConfig> {
  return request<AppConfig>("GET", "/api/config");
}

/** 会话列表 */
export function listChats(): Promise<{ chats: ChatSummary[] }> {
  return request<{ chats: ChatSummary[] }>("GET", "/api/chats");
}

/** 新建会话（projectRoot 必须位于 allowRoots 内，由服务端校验） */
export function createChat(projectRoot: string, sessionId?: string): Promise<{ chatId: string; sessionId: string }> {
  return request<{ chatId: string; sessionId: string }>("POST", "/api/chats", { projectRoot, sessionId });
}

/** 历史消息（刷新恢复） */
export function fetchMessages(chatId: string): Promise<{ messages: ChatMessageDto[] }> {
  return request<{ messages: ChatMessageDto[] }>("GET", `/api/chats/${encodeURIComponent(chatId)}/messages`);
}

/**
 * 发送消息（文本/图片 JSON 路径）→ 202 已受理，结果经 SSE 推送。
 * 注意：不设置 Content-Type 之外的头；202 无响应体。
 */
export function sendTextMessage(chatId: string, payload: SendTextPayload): Promise<void> {
  return request<void>("POST", `/api/chats/${encodeURIComponent(chatId)}/messages`, payload);
}

/** 审批回注：把 allow/deny 决策作为消息回传引擎 */
export function sendPermissionDecisions(chatId: string, payload: SendPermissionsPayload): Promise<void> {
  return request<void>("POST", `/api/chats/${encodeURIComponent(chatId)}/messages`, payload);
}

/** 发送带附件的消息（multipart/form-data：text 字段 + 多个 file 字段） */
export function sendMessageWithFiles(chatId: string, text: string, files: File[]): Promise<void> {
  const form = new FormData();
  form.append("text", text);
  for (const f of files) {
    form.append("file", f, f.name);
  }
  return request<void>("POST", `/api/chats/${encodeURIComponent(chatId)}/messages`, form);
}

/** 停止生成（interruptActiveSession） */
export function interruptChat(chatId: string): Promise<void> {
  return request<void>("POST", `/api/chats/${encodeURIComponent(chatId)}/interrupt`);
}

/** 目录浏览（路径牢笼由服务端校验；path 为空时由服务端返回默认目录） */
export function listFiles(path: string): Promise<FileListing> {
  const q = path !== "" ? `?path=${encodeURIComponent(path)}` : "";
  return request<FileListing>("GET", `/api/files${q}`);
}

/** 上传文件到指定目录（multipart，多个 file 字段） */
export function uploadFiles(path: string, files: File[]): Promise<void> {
  const form = new FormData();
  for (const f of files) {
    form.append("file", f, f.name);
  }
  return request<void>("POST", `/api/files/upload?path=${encodeURIComponent(path)}`, form);
}

/** 构造下载地址：供 <a download> 直接使用（服务端 Content-Disposition 附件下载） */
export function fileDownloadUrl(path: string): string {
  return `/api/files/download?path=${encodeURIComponent(path)}`;
}
