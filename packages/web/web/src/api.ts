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

import type { SedimentationSuggestion } from "./chat-model";

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
  /** 个人工作目录模式（docs/dev/web-workspace.md W7）：true 时共享区禁用、会话锁定个人区 */
  personalOnly: boolean;
  /** 补充指令开关（docs/dev/web-steering.md W7）：false 时前端回退「运行中禁用输入」旧行为 */
  steeringEnabled: boolean;
  /** 文本预览上限（字节，docs/dev/web-file-preview.md P1）：前端据此预判可预览文件 */
  maxPreviewBytes: number;
  /**
   * 本人个人工作区绝对路径（<uploadDir>/<userId>）：「我的文件」面包屑在
   * 列表加载前据此显示完整路径（与 GET /api/files personal 归一 path 一致）。
   */
  personalRoot: string;
  /** Web 服务运行版本号（后端 package.json 的 version）：侧栏底部/登录页品牌区展示 */
  version: string;
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
  /**
   * 引擎消息元信息（docs/dev/web-steering.md W1①）：
   * meta.steeringInject === true 标记「执行中补充指令」注入的 system 消息，
   * meta.steeringText 为用户注入原文（docs/dev/web-thinking-display.md W2，
   * 注入条优先展示原文）；历史恢复据此渲染「指令注入」样式（F4），
   * 其余消息缺省。
   */
  meta?: { steeringInject?: true; steeringText?: string } & Record<string, unknown>;
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

/**
 * 文本预览响应（GET /api/files/preview，docs/dev/web-file-preview.md P1）。
 * 字段与后端 packages/web/src/api/files-api.ts 的 FilePreviewResult 逐字一致。
 */
export interface FilePreviewResult {
  /** 服务端归一后的真实绝对路径 */
  path: string;
  /** 文件名（basename） */
  name: string;
  /** 文件字节大小 */
  size: number;
  /** 最后修改时间（ISO） */
  mtime: string;
  /** 预览文本（UTF-8；truncated 为 true 时按上限截断） */
  text: string;
  /** 是否因超过 maxPreviewBytes 被截断 */
  truncated: boolean;
}

/** 发送文本消息载荷（JSON 路径；imageUrls 为图片本地路径/数据地址，见设计文档 §2.1） */
export interface SendTextPayload {
  text: string;
  imageUrls?: string[];
}

/** 审批回注载荷（有权限请求时即"审批回注"消息，见设计文档 §3.5） */
export interface SendPermissionsPayload {
  permissions: PermissionDecision[];
  /**
   * 声明「本次会话总是允许」的 toolCallId 列表（Web 审批三态 docs/dev/web-approval.md）：
   * 对应决策必须同时是 allow；服务端把该待审批项的申请 scopes 登记进
   * 会话级总是允许集合（仅本会话生命周期，不落盘任何配置）。
   */
  sessionAlwaysAllowToolCallIds?: string[];
}

/**
 * 发送消息受理响应（POST /messages → 202 带 JSON 体，docs/dev/web-steering.md W6）。
 *
 * 注意：202 在本封装里不走「无内容短路」分支——必须解析响应体拿 mode，
 * 因此 request() 对 202 会先读 body（空体时返回 undefined，调用方缺省 queued）。
 */
export interface SendMessageResult {
  /** Web 会话 id */
  chatId: string;
  /** 受理时已知的底层会话 id（可为 null，最终以 SSE done 为准） */
  sessionId: string | null;
  /**
   * 受理模式：steered = 已注入运行中的当前任务（不产生独立 done）；
   * queued = 进入串行队列。缺省（旧服务/空体）视为 queued。
   */
  mode: "steered" | "queued";
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

  // 204 等真正无内容响应直接返回 undefined。
  // 202 例外：POST /messages 的受理响应携带 mode（steered/queued，docs/dev/web-steering.md W6），
  // 必须走下方 JSON 解析；空体时 text === "" 自然返回 undefined，调用方缺省 queued。
  if (resp.status === 204) {
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

/** 技能/Agent 条目（GET /api/capabilities，web-capability T1） */
export interface CapabilitySkill {
  name: string;
  description: string;
  path: string;
  /** "skill" 普通技能 / "agent" 自定义 Agent 定义 */
  kind: "skill" | "agent";
  /** 是否预置智能体（决定界面是否显示「预置」徽标） */
  preset?: boolean;
  /** 分组名（预置智能体按业务类别分组） */
  group?: string;
  /**
   * agent 专属：中文角色身份（frontmatter `role`）
   *
   * 展示中文名唯一来源——`name` 是技术标识（kebab-case，@ 提及 token 与目录名
   * 同源），不能直接展示。经 `agent-display.ts` 的 `agentDisplayName()` 取值。
   */
  role?: string;
}

/** MCP 服务器条目（脱敏：不含 env 值） */
export interface CapabilityMcpServer {
  name: string;
  command: string;
  args?: string[];
}

/** 能力发现响应（@ 提及补全与设置抽屉「技能」页签数据源） */
export interface Capabilities {
  skills: CapabilitySkill[];
  mcpServers: CapabilityMcpServer[];
  /** 默认智能体（settings.agents.default；未配置为 null） */
  defaultAgent?: string | null;
}

/** Agent 创建结果（POST /api/agents；失败抛 ApiError，message 为结构化中文原因） */
export interface AgentWriteResult {
  ok: boolean;
  /** 落盘文件绝对路径（成功时） */
  path?: string;
}

/**
 * 创建自定义智能体（POST /api/agents）：
 * 服务端经 SedimentationWriter 五条安全门槛落盘 `~/.deepcode/skills/<name>/SKILL.md`
 * （frontmatter type: agent），落盘后 @ 提及补全、智能体列表、引擎 agent 索引自动可见。
 * 同名已存在（409）/ 非法 name（400）等失败以 ApiError.message 返回结构化中文原因。
 */
export function createAgent(draft: {
  name: string;
  description: string;
  role: string;
  content: string;
}): Promise<AgentWriteResult> {
  return request<AgentWriteResult>("POST", "/api/agents", draft);
}

/** AI 生成草稿响应（POST /api/agents/draft；失败抛 ApiError） */
export interface AgentDraftResult {
  ok: boolean;
  draft: {
    name: string;
    description: string;
    role: string;
    content: string;
  };
}

/**
 * AI 一句话生成智能体草稿（POST /api/agents/draft）：
 * 参考 WorkBuddy 创建专家的方式——用户一句话意图，服务端 LLM 产出
 * name/description/role/content 四件套草稿。只生成不落盘，
 * 前端填入表单供用户审阅修改后再走 createAgent 落盘。
 */
export function draftAgent(prompt: string): Promise<AgentDraftResult> {
  return request<AgentDraftResult>("POST", "/api/agents/draft", { prompt });
}

/** 预置智能体导入结果（POST /api/agents/presets） */
export interface PresetImportResult {
  ok: boolean;
  /** 预置总数（5 核心角色 + 30 领域专家） */
  total: number;
  /** 本次新写入数 */
  written: number;
  /** 已存在未覆盖数 */
  skipped: number;
  /** 失败项：[名称, 原因] */
  failed: Array<[string, string]>;
}

/**
 * 导入 / 修复预置智能体（POST /api/agents/presets）。
 *
 * 落盘位置 `~/.deepcode/skills/<name>/SKILL.md`，与用户自建智能体同构，
 * 导入后自动出现在能力发现、@ 提及与 agent 工具中（无需重启引擎）。
 *
 * @param overwrite true = 覆盖同名文件（会丢弃用户对该文件的修改）
 */
export function importPresetAgents(overwrite = false): Promise<PresetImportResult> {
  return request<PresetImportResult>("POST", "/api/agents/presets", { overwrite });
}

/**
 * 设置 / 清除默认智能体（POST /api/agents/default）。
 *
 * 写入 `~/.deepcode/settings.json` 的 `agents.default`；引擎每轮重新解析设置，
 * 因此**下一轮起生效、无需重启**。传空串表示清除默认。
 */
export function setDefaultAgent(name: string): Promise<{ ok: boolean; defaultAgent: string | null }> {
  return request<{ ok: boolean; defaultAgent: string | null }>("POST", "/api/agents/default", { name });
}

/**
 * 能力发现（GET /api/capabilities）：当前引擎可用的技能 / Agent / MCP 脱敏清单。
 * 数据与引擎技能注入同源（core SkillManager），保证「看到的」=「能加载的」。
 */
export function fetchCapabilities(): Promise<Capabilities> {
  return request<Capabilities>("GET", "/api/capabilities");
}

// ============================================================================
// 全局规则（设置抽屉「全局规则」页签）：注入到每次新会话的系统提示
// ============================================================================

/** 全局规则条目（与服务端 UserRule 对齐，前端只消费展示字段） */
export interface GlobalRuleInfo {
  /** 规则 ID（USER-xxx） */
  id: string;
  /** 规则正文 */
  content: string;
  /** 严重级别（BLOCKER / MAJOR / WARNING） */
  severity: string;
  /** 规则分类（code-truth 等 6 类） */
  category: string;
  /** 创建时间（ISO 8601） */
  createdAt: string;
}

/** 添加全局规则（POST /api/rules）；失败抛 ApiError（400 空内容/超长/超上限） */
export function createRule(input: { content: string; severity?: string; category?: string }): Promise<{
  rule: GlobalRuleInfo;
}> {
  return request<{ rule: GlobalRuleInfo }>("POST", "/api/rules", input);
}

/** 全局规则列表（GET /api/rules） */
export function fetchRules(): Promise<{ rules: GlobalRuleInfo[] }> {
  return request<{ rules: GlobalRuleInfo[] }>("GET", "/api/rules");
}

/** 删除全局规则（DELETE /api/rules/:id）；404 规则不存在 */
export function deleteRule(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("DELETE", `/api/rules/${encodeURIComponent(id)}`);
}

// ============================================================================
// EAG 工作流审计（设置抽屉「审计」页签，P6）：规则证据 + 干预台账 + 确定性报告
// ============================================================================

/** 审计响应（与服务端 AuditResponse 对齐） */
export interface AuditInfo {
  /** 规则使用证据（按 ruleId 排序） */
  rules: Array<{
    ruleId: string;
    evidenceState: string;
    usageCount: number;
    violationCount: number;
  }>;
  /** 干预台账条目（按 appliedAt 排序） */
  ledger: Array<{
    findingId: string;
    appliedAt: string;
    owner: string;
    expectedEffect: string;
    assetPath?: string;
    verification?: {
      verifiedAt: string;
      state: "outcome-supported" | "partial" | "blocked";
      note?: string;
    };
  }>;
  /** 确定性 Markdown 审计报告 */
  report: string;
  /** 报告生成时间（ISO 8601） */
  generatedAt: string;
}

/** 拉取工作流审计聚合（GET /api/eag/audit，只读） */
export function fetchAudit(): Promise<AuditInfo> {
  return request<AuditInfo>("GET", "/api/eag/audit");
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

/**
 * 由用户名派生与后端一致的隔离标识（sha256 hex 前 16 位）。
 *
 * 用途：前端展示「我的文件」面包屑时还原个人工作区实际路径段
 * （个人区 = <uploadDir>/<userId>）。与后端 userIdFromUsername 同算法；
 * 该值为单向哈希、登录前即已知的用户名派生物，纯展示辅助，无安全语义。
 *
 * 实现：Web Crypto SHA-256（浏览器安全上下文/SubtleCrypto 可用）。
 *
 * @param username 登录用户名（JWT sub，/api/auth/me 返回）
 * @returns 16 位小写 hex 字符串
 */
export async function deriveUserId(username: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(username));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** 脱敏配置（allowRoots / 上传上限 / LDAP 是否启用） */
export function fetchConfig(): Promise<AppConfig> {
  return request<AppConfig>("GET", "/api/config");
}

/** 会话列表（可按工作空间过滤，ARCH-20261027 T05） */
export function listChats(workspaceId?: string): Promise<{ chats: ChatSummary[] }> {
  const q = workspaceId !== undefined && workspaceId !== "" ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<{ chats: ChatSummary[] }>(`GET`, `/api/chats${q}`);
}

/**
 * 新建会话。
 *
 * - 共享模式（personalOnly=false）：projectRoot 必须位于 allowRoots 内，由服务端校验；
 * - 个人工作目录模式（personalOnly=true）：projectRoot 可传空串，服务端自动落到
 *   当前用户的个人工作区（docs/dev/web-workspace.md W3）；
 * - workspaceId（ARCH-20261027 T04/T05）：指定 web.workspaces 配置的工作空间时，
 *   服务端以其 root 为落点（projectRoot 忽略）。
 */
export function createChat(
  projectRoot: string,
  sessionId?: string,
  workspaceId?: string
): Promise<{ chatId: string; sessionId: string }> {
  const body: Record<string, unknown> = { projectRoot, sessionId };
  if (workspaceId !== undefined && workspaceId !== "") {
    body["workspaceId"] = workspaceId;
  }
  return request<{ chatId: string; sessionId: string }>("POST", "/api/chats", body);
}

/** 工作空间条目（GET /api/workspaces，ARCH-20261027 T04/T05） */
export interface WorkspaceInfo {
  /** 空间标识：个人区固定为 "personal"，配置空间为 web.workspaces[].id */
  id: string;
  /** 展示名 */
  name: string;
  /** 空间根目录（个人区为服务端拼接的 <uploadDir>/<userId>） */
  root: string;
  /** 种类：personal = 本人个人区；workspace = web.workspaces 配置的共享空间 */
  kind: "personal" | "workspace";
}

/** 当前用户可用工作空间列表（空间切换器数据源；旧后端 404 时调用方降级为空列表） */
export function listWorkspaces(): Promise<{ workspaces: WorkspaceInfo[] }> {
  return request<{ workspaces: WorkspaceInfo[] }>("GET", "/api/workspaces");
}

/** 沉淀建议确认落盘结果（与后端 core WriteResult 契约对齐） */
export interface SedimentationWriteResult {
  /** 是否落盘成功 */
  ok: boolean;
  /** 成功时的落盘绝对路径 */
  path?: string;
  /** 失败原因码（invalid-name / path-escapes-root / duplicate-name / io-error 等） */
  reason?: string;
  /** 失败说明（中文） */
  message?: string;
}

/** 拉取会话待处置沉淀建议（刷新恢复数据源；SSE 断连窗口的兜底通道） */
export function fetchSedimentationSuggestions(chatId: string): Promise<{ suggestions: SedimentationSuggestion[] }> {
  return request<{ suggestions: SedimentationSuggestion[] }>(
    "GET",
    `/api/sedimentation/suggestions?chatId=${encodeURIComponent(chatId)}`
  );
}

/**
 * 确认沉淀建议并落盘（scope=user 落 ~/.deepcode/skills，scope=project 落
 * 会话项目 .deepcode/skills；安全门槛由服务端执行，ok=false 时 message 为中文原因）。
 */
export function confirmSedimentation(
  chatId: string,
  suggestionId: string,
  scope: "user" | "project"
): Promise<SedimentationWriteResult> {
  return request<SedimentationWriteResult>("POST", "/api/sedimentation/confirm", { chatId, suggestionId, scope });
}

/** 忽略沉淀建议（204：移出待处置集合，同指纹本会话不再建议） */
export function dismissSedimentation(chatId: string, suggestionId: string): Promise<void> {
  return request<void>("POST", "/api/sedimentation/dismiss", { chatId, suggestionId });
}

/** 历史消息（刷新恢复） */
export function fetchMessages(chatId: string): Promise<{ messages: ChatMessageDto[] }> {
  return request<{ messages: ChatMessageDto[] }>("GET", `/api/chats/${encodeURIComponent(chatId)}/messages`);
}

/**
 * 发送消息（文本/图片 JSON 路径）→ 202 受理，结果经 SSE 推送。
 * 返回受理响应（mode 区分注入/排队，docs/dev/web-steering.md F2）；
 * 旧服务空体时 mode 缺省 queued。
 * 注意：不设置 Content-Type 之外的头。
 */
export function sendTextMessage(chatId: string, payload: SendTextPayload): Promise<SendMessageResult> {
  return request<SendMessageResult>("POST", `/api/chats/${encodeURIComponent(chatId)}/messages`, payload);
}

/** 审批回注：把 allow/deny 决策作为消息回传引擎（无 mode 语义，响应体忽略） */
export function sendPermissionDecisions(chatId: string, payload: SendPermissionsPayload): Promise<void> {
  return request<void>("POST", `/api/chats/${encodeURIComponent(chatId)}/messages`, payload);
}

/**
 * 发送带附件的消息（multipart/form-data：text 字段 + 多个 file 字段）。
 * 带附件的消息一律走排队（不参与 steering 注入，docs/dev/web-steering.md W6），
 * 响应体同 sendTextMessage（mode 恒为 queued，缺省亦可）。
 */
export function sendMessageWithFiles(chatId: string, text: string, files: File[]): Promise<SendMessageResult> {
  const form = new FormData();
  form.append("text", text);
  for (const f of files) {
    form.append("file", f, f.name);
  }
  return request<SendMessageResult>("POST", `/api/chats/${encodeURIComponent(chatId)}/messages`, form);
}

/** 停止生成（interruptActiveSession） */
export function interruptChat(chatId: string): Promise<void> {
  return request<void>("POST", `/api/chats/${encodeURIComponent(chatId)}/interrupt`);
}

/**
 * 文件区作用域（docs/dev/web-isolation.md §3.5）：
 * shared = 管理员配置的共享 allowRoots；personal = 当前用户个人上传区。
 */
export type FileScope = "shared" | "personal";

/** 目录浏览（scope 分流共享区/个人区；路径牢笼由服务端校验；path 为空时由服务端返回默认目录） */
export function listFiles(path: string, scope: FileScope = "shared"): Promise<FileListing> {
  const q = `?scope=${scope}${path !== "" ? `&path=${encodeURIComponent(path)}` : ""}`;
  return request<FileListing>("GET", `/api/files${q}`);
}

/** 上传文件到指定目录（multipart，多个 file 字段；scope 决定共享区/个人区） */
export function uploadFiles(path: string, files: File[], scope: FileScope = "shared"): Promise<void> {
  const form = new FormData();
  for (const f of files) {
    form.append("file", f, f.name);
  }
  return request<void>("POST", `/api/files/upload?scope=${scope}&path=${encodeURIComponent(path)}`, form);
}

/**
 * 在牢笼内幂等创建目录（web-personal-subworkspace T1）：
 * 「新建对话 → 选择文件夹 → 新建文件夹」用；目录已存在视为成功。
 * @returns 服务端归一后的真实绝对路径
 */
export function mkdir(path: string, scope: FileScope = "personal"): Promise<{ path: string }> {
  return request<{ path: string }>("POST", `/api/files/mkdir?scope=${scope}&path=${encodeURIComponent(path)}`);
}

/** 构造下载地址：供 <a download> 直接使用（服务端 Content-Disposition 附件下载；scope 分流） */
export function fileDownloadUrl(path: string, scope: FileScope = "shared"): string {
  return `/api/files/download?scope=${scope}&path=${encodeURIComponent(path)}`;
}

/**
 * 文本文件预览（GET /api/files/preview，docs/dev/web-file-preview.md P1）。
 * 牢笼与 scope 校验在服务端完成；413（超限）/415（二进制）等错误经
 * request() 统一抛 ApiError，由预览层展示错误引导。
 */
export function fetchPreview(path: string, scope: FileScope = "shared"): Promise<FilePreviewResult> {
  return request<FilePreviewResult>("GET", `/api/files/preview?scope=${scope}&path=${encodeURIComponent(path)}`);
}
