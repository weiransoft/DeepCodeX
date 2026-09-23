/**
 * Web 后端 API DTO 类型与配置解析产物类型（docs/dev/web-ui.md §3.3 / §3.5）。
 *
 * 本文件只承载类型定义，不含运行时逻辑；
 * ResolvedWebSettings 由 src/config.ts 的 resolveWebSettings 产出。
 */

import type { SessionStatus, WebLocalUserSettings } from "@vegamo/deepcode-core";

/**
 * Web 配置解析产物（全部默认值已归一、路径已展开）。
 *
 * 由 resolveWebSettings(projectRoot, env) 构造；
 * jwtSecret 已通过 env（DEEPCODE_WEB_JWT_SECRET）覆盖归一，启动前保证非空。
 */
export type ResolvedWebSettings = {
  /** 配置解析时使用的项目根目录（决定项目级 settings.json 位置） */
  projectRoot: string;
  /** 是否允许 `deepcode web` 启动（默认 false，显式开启才允许） */
  enabled: boolean;
  /** 监听地址（默认 127.0.0.1，仅本机） */
  host: string;
  /** 监听端口（默认 3210） */
  port: number;
  /**
   * 目录浏览/上传/下载白名单根目录（已做 ~ 展开 + path.resolve）。
   * 空数组合法，此时文件类端点一律 403。
   */
  allowRoots: string[];
  /** 聊天附件暂存目录（默认 ~/.deepcode/web-uploads） */
  uploadDir: string;
  /**
   * 个人工作目录模式（docs/dev/web-workspace.md W1，默认 true）：
   * 开启后所有会话锁定在个人工作区 `<uploadDir>/<userId>/`，
   * scope=shared 端点一律 403；关闭后回退旧共享浏览行为（allowRoots + 客户端指定 projectRoot）。
   */
  personalOnly: boolean;
  /**
   * 引擎数据家目录根（docs/dev/web-workspace.md W1）：每个用户的引擎数据
   * （会话索引/记忆/日志）落在 `<engineHomeRoot>/<userId>/` 下，
   * 不在任何 allowRoot / personal 牢笼内，Web 文件 API 不可达。
   * 缺省 = `<uploadDir>/.engine-home`。
   */
  engineHomeRoot: string;
  /** 单文件上传上限（字节，默认 50MB） */
  maxUploadBytes: number;
  /**
   * 文本预览读取上限（字节，默认 2MiB，docs/dev/web-file-preview.md P1）：
   * GET /api/files/preview 读取的字节上限，超限 413 引导下载。
   */
  maxPreviewBytes: number;
  /**
   * 任务执行中补充指令（steering）开关（docs/dev/web-steering.md W7，默认 true）：
   * 开启后轮次运行中收到的补充消息经 LLM 意图分类（steer→立即注入当前任务 /
   * next→排队）；关闭后一律串行排队（回退旧行为）。
   */
  steeringEnabled: boolean;
  /** 认证配置（已归一） */
  auth: {
    /** JWT 签名密钥（启动 fail-fast 保证非空） */
    jwtSecret: string;
    /** 会话有效期（秒，默认 28800 即 8 小时） */
    sessionTtlSeconds: number;
    /** 本地兜底用户列表（LDAP 未启用/失败时使用；为空时首次启动自动生成默认用户） */
    localUsers: WebLocalUserSettings[];
    /**
     * 首次启动自动生成的默认用户明文密码（仅生成当次非空，供启动日志一次性展示；
     * 凭据落盘 bootstrap-admin.json（0600，仅存哈希），明文不再出现于后续启动）
     */
    bootstrapPassword?: string;
  };
  /** LDAP 配置（已归一） */
  ldap: {
    /** 是否启用 LDAP 登录 */
    enabled: boolean;
    /** LDAP 服务器主机名/IP */
    server: string;
    /** 端口（默认 useSsl ? 636 : 389） */
    port: number;
    /** 是否使用 ldaps:// */
    useSsl: boolean;
    /** 服务账号 DN（未配置时匿名 bind） */
    bindDn?: string;
    /** 服务账号密码（可被 DEEPCODE_WEB_LDAP_BIND_PASSWORD 覆盖） */
    bindPassword?: string;
    /** 搜索基准 DN */
    baseDn: string;
    /** 用户过滤模板（支持 %s 占位，默认 "(uid=%s)"） */
    userFilter: string;
    /** 连接/操作超时（毫秒，默认 10000） */
    timeoutMs: number;
    /** 属性映射（LDAP 属性名 → 展示字段） */
    attrs: Record<string, string>;
  };
};

/** POST /api/auth/login 请求体 */
export type LoginRequest = {
  username?: unknown;
  password?: unknown;
};

/** 登录成功响应 / GET /api/auth/me 响应体 */
export type LoginResponse = {
  username: string;
  displayName?: string;
  mail?: string;
  /** 认证来源：ldap = LDAP 目录认证；local = settings.json 本地兜底用户 */
  authSource: "ldap" | "local";
};

/**
 * JWT 载荷（HS256，node:crypto 自实现）。
 *
 * sub 为登录用户名；dn/displayName/mail 来自 LDAP 属性；authSource 供 /me 回显。
 */
export type JwtPayload = {
  sub: string;
  dn?: string;
  displayName?: string;
  mail?: string;
  authSource?: "ldap" | "local";
  iat: number;
  exp: number;
};

/** GET /api/chats 返回的会话摘要 */
export type ChatSummary = {
  /** Web 会话 id（SessionPool 内部分配，与底层 sessionId 不同） */
  chatId: string;
  /** 底层 SessionManager 会话 id（首个消息发出前为 null） */
  sessionId: string | null;
  /** 会话所属项目根目录 */
  projectRoot: string;
  /** 会话标题摘要（取 SessionEntry.summary，可能为 null） */
  title: string | null;
  /** 底层引擎状态 */
  status: SessionStatus;
  createTime: string;
  updateTime: string;
  /** 来源：active = 本进程 SessionPool 内活跃；history = 磁盘 sessions-index.json 历史 */
  source: "active" | "history";
};

/** GET/POST /api/chats/:id/messages 中的消息 DTO */
export type ChatMessageDto = {
  id: string;
  role: string;
  /** 消息文本（可能为 null） */
  content: string | null;
  /** 是否对用户可见（工具执行等隐藏消息为 false） */
  visible: boolean;
  createTime: string;
  updateTime: string;
  /**
   * 引擎消息元信息（docs/dev/web-steering.md W1①：桥接补充）。
   * 前端据 meta.steeringInject 把注入指令的 system 消息渲染为「指令注入」样式；
   * meta.steeringText 为注入指令用户原文（docs/dev/web-thinking-display.md W2），
   * 注入条优先展示原文；历史恢复（GET messages）与实时 user_message 帧共用本
   * DTO——后者无 meta 时缺省。
   */
  meta?: { steeringInject?: true; steeringText?: string } & Record<string, unknown>;
};

/** POST /api/chats/:id/messages 请求体（JSON 形态） */
export type SendMessageRequest = {
  text?: unknown;
  imageUrls?: unknown;
  permissions?: unknown;
  alwaysAllows?: unknown;
};

/**
 * POST /api/chats/:id/messages 响应体（202 异步受理，docs/dev/web-ui.md §3.5）。
 *
 * POST 返回 202 仅表示「受理成功」：整轮 handleUserPrompt 已入队
 * session-pool 串行队列异步执行，本轮全部事件（llm_delta / assistant_message /
 * tool_progress / permission_request / status / done）经 SSE 推送，
 * 最终引擎状态以 SSE done 事件载荷为准（本响应不含 status 字段）。
 */
export type SendMessageResponse = {
  /** 受理成功标志（恒为 true） */
  ok: true;
  /** Web 会话 id */
  chatId: string;
  /**
   * 受理时已知的底层 SessionManager 会话 id。
   * 允许为 null：首轮消息受理时底层会话尚未创建（或历史恢复失败），
   * 此刻没有可归属的底层会话；最终 sessionId 以 SSE done 事件载荷为准，
   * 前端不得假定本字段一定非空。
   */
  sessionId: string | null;
  /**
   * 消息受理模式（docs/dev/web-steering.md W6）：
   * - "steered"：补充指令已被注入运行中的当前任务（不产生独立 done、不改 pendingTurns，
   *   终结信号由当前轮既有 done 帧承载）；
   * - "queued"：消息进入该会话串行队列（含空闲即时执行、分类降级、审批等待等全部旧语义）。
   * 缺省（旧客户端/旧服务）视为 "queued"。
   */
  mode: "steered" | "queued";
};

/**
 * SSE done 事件载荷（本轮 handleUserPrompt 结束时推送，docs/dev/web-ui.md §3.5）。
 *
 * 承诺语义：无论轮次成功、中断还是异常，订阅方都必然收到一帧 done，
 * 不会悬死等待（异常路径 status 固定 "failed" 并携带 error 摘要）。
 */
export type DoneEvent = {
  /** Web 会话 id */
  chatId: string;
  /**
   * 底层引擎会话 id：允许为 null——轮次在引擎创建底层会话之前即失败等场景下，
   * 没有可归属的底层会话；前端不应假定该字段一定非空。
   */
  sessionId: string | null;
  /** 本轮结束时的引擎状态（轮次异常路径固定为 "failed"） */
  status: SessionStatus;
  /**
   * 本轮收敛后该会话仍在排队的轮次数（同会话连发任务的串行排队场景）。
   * 大于 0 表示串行链上还有后续轮次待执行——前端不应据此 done 帧复位
   * 「生成中」状态；缺省（旧契约）视为 0。
   */
  pendingTurns?: number;
  /** 仅 status="failed" 时携带：错误摘要（中文），供前端提示展示 */
  error?: string;
};

/**
 * SSE 事件名（docs/dev/web-ui.md §3.5）。
 *
 * - llm_delta：LLM 流式增量（phase: start|update|end + previewText 正文预览
 *   + thinkingText 思考过程，thinkingText 换行保留供前端 Markdown 折叠渲染，
 *   docs/dev/web-thinking-display.md W1）
 * - assistant_message：完整助手消息（载荷含 role/meta——注入指令的 system 消息
 *   经 meta.steeringInject 标记，docs/dev/web-steering.md W1①）
 * - user_message：用户消息实时广播（排队受理与 steering 注入两路径均广播，
 *   多订阅者与 SSE 重连场景实时可见，docs/dev/web-steering.md W3/W4a）
 * - tool_progress：工具执行进度（来自 onSessionEntryUpdated 的通用状态流，保留扩展点）
 * - permission_request：引擎请求权限审批（askPermissions 明细）
 * - status：会话状态变化（快照载荷含 pendingTurns/turnActive，docs/dev/web-steering.md W1③）
 * - done：本轮 handleUserPrompt 结束
 */
export type SseEventName =
  | "llm_delta"
  | "assistant_message"
  | "user_message"
  | "tool_progress"
  | "permission_request"
  | "status"
  | "done";

/**
 * SSE user_message 事件载荷（docs/dev/web-steering.md W3/W4a）。
 *
 * role 恒为 "user"；消息为服务端受理时合成的 DTO（无引擎 id，
 * id 用合成 uuid 占位，仅作前端 React key 用）。
 */
export type UserMessageEvent = {
  chatId: string;
  message: ChatMessageDto;
};

/** GET /api/files?scope= 的作用域（docs/dev/web-isolation.md §3.5） */
export type FileScope = "shared" | "personal";

/** GET /api/files?path= 返回的目录条目 */
export type FileEntry = {
  name: string;
  /** dir = 目录；file = 普通文件 */
  type: "file" | "dir";
  /** 文件大小（字节；目录为 0） */
  size: number;
  /** 最后修改时间（ISO 字符串） */
  mtime: string;
};

/** GET /api/config 响应体（脱敏，绝不返回密钥） */
export type PublicWebConfig = {
  enabled: boolean;
  /** 已展开的绝对路径白名单 */
  allowRoots: string[];
  maxUploadBytes: number;
  /** 文本预览上限（字节，docs/dev/web-file-preview.md P1）：前端据此预判可预览文件 */
  maxPreviewBytes: number;
  ldapEnabled: boolean;
  /** 个人工作目录模式（docs/dev/web-workspace.md W7）：前端据此隐藏共享区入口 */
  personalOnly: boolean;
  /** 任务执行中补充指令开关（docs/dev/web-steering.md W7）：false 时前端回退运行中禁用输入 */
  steeringEnabled: boolean;
  /**
   * 个人工作区绝对路径（<uploadDir>/<userId>，docs/dev/web-workspace.md W1 同款派生）。
   * 仅当前认证用户可见：前端「我的文件」面包屑在列表加载前据此显示完整路径
   * （与 GET /api/files personal scope 返回的归一 path 完全一致）。
   */
  personalRoot: string;
};
