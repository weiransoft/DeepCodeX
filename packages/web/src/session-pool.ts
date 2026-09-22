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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  InterruptQueue,
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
import { buildJailRoots, resolveInJail } from "./jail";
import { personalUploadRoot } from "./user-files";
import { findChatBySessionId, loadUserChats, upsertUserChat } from "./chat-registry";
import type { AuthContext } from "./user-identity";
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
  /**
   * 已受理尚未收敛的轮次计数（含正在执行的）。
   * sendMessage 受理入队时 +1，runTurn 收敛（成功/异常）时 -1；
   * done 帧携带收敛后的剩余值，供前端区分「本轮结束但仍有排队轮次」
   * 与「整条串行链已空闲」（旧轮次 done 不得误复位新受理轮次的生成状态）。
   */
  pendingTurns: number;
  /**
   * 当前是否有轮次正在引擎内执行（docs/dev/web-steering.md W5）。
   * runTurn 入口置 true、finally 收敛置 false（同步赋值，无 await 竞态）；
   * steering 注入的活性检查依赖本标志：false 时一律排队，严禁向无轮次消费的
   * 内存队列注入（InterruptQueue 不持久化，注入即滞留丢失）。
   */
  turnActive: boolean;
  /**
   * 本聊天专属的中断指令队列（docs/dev/web-steering.md W2）。
   * 与 SessionManager 注入的是同一实例；steering 判定为 steer 时经
   * injectSteering 入队，引擎 E3/E2 扩展点在轮内消费。
   */
  interruptQueue: InterruptQueue;
  /** 归属者用户名（JWT sub；多用户隔离：仅本人可操作，docs/dev/web-isolation.md §3.3） */
  owner: string;
  /** 归属者隔离标识（注册表文件名主键，userIdFromUsername 产物） */
  ownerUserId: string;
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
  /** 受理模式：本方法恒为 "queued"（steered 路径走 injectSteering，不经过串行链） */
  mode: "steered" | "queued";
};

/** injectSteering 结果（docs/dev/web-steering.md W4） */
export type InjectSteeringResult = {
  /** 是否成功注入当前运行中的任务 */
  injected: boolean;
  /**
   * 未注入原因（injected=false 时必有）：
   * - "inactive"：轮次不活跃（turnActive=false 或引擎状态非 processing）——调用方降级排队；
   * - "queue"：注入被引擎拒绝（interruptQueue 未注入 / 队列已满 / 文本非法）——调用方降级排队。
   */
  reason?: "inactive" | "queue";
  /** 当前已知的底层 sessionId（响应组装用） */
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
  /**
   * 用户会话注册表根目录覆写（docs/dev/web-isolation.md §3.4 测试缝合点）。
   * 生产缺省 ~/.deepcode/web/chats；测试注入临时目录避免污染真实用户目录。
   */
  registryBaseDir?: string;
  /**
   * steering 意图分类客户端工厂覆写（docs/dev/web-steering.md W2 测试缝合点）。
   * 透传给 SessionManagerOptions.classifyLlmClientFactory；未注入时 core 内部
   * 回退 createLLMClient()（凭据/provider 路由单一事实源）。
   * 测试注入独立受控分类客户端，与主对话 ScriptedLLMClient 分离，
   * 可精确断言分类请求次数与输出契约。
   */
  classifyLlmClientFactory?: () => LLMClient | null;
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
  /** steering 分类客户端工厂覆写（W2 测试缝合点；未注入时 core 回退 createLLMClient 链） */
  private readonly classifyLlmClientFactory?: () => LLMClient | null;
  /** 用户注册表根目录注入点（测试用；默认 ~/.deepcode/web/chats，docs/dev/web-isolation.md §3.4） */
  private readonly registryBaseDir?: string;

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
    this.classifyLlmClientFactory = options.classifyLlmClientFactory;
    this.registryBaseDir = options.registryBaseDir;
  }

  /**
   * 创建新的 Web 聊天会话。
   *
   * 流程（docs/dev/web-workspace.md W2/W3/W6）：
   * 1. personalOnly=true（默认）：忽略客户端 projectRoot，服务端强制拼接个人
   *    工作区 `<uploadDir>/<userId>` 作为 projectRoot（不经 ~ 展开、不接受外部输入拼接）；
   *    显式传入 projectRoot 时仅允许等于本人个人区，否则 403（明确拒绝，不静默改写）。
   *    personalOnly=false：回退旧行为——projectRoot 牢笼校验（必须在 allowRoots 内）。
   * 2. personalOnly=true 时 SessionManager 注入 per-user 引擎数据根
   *    `homeDir=<engineHomeRoot>/<userId>` + `ignoreProjectSettings=true`
   *    （个人区可写，绝不作为凭据/MCP/权限模式来源），并把 bash 子进程 HOME
   *    覆写为 homeDir（家目录写入落引擎区，个人区内 `~` 无危害）。
   * 3. 构造 SessionManager（nonInteractive + 事件桥接）→ initMcpServers →
   *    可选恢复指定 sessionId。
   *
   * @param projectRoot 项目根目录（personalOnly 模式下必须缺省或等于本人个人区）
   * @param ctx 认证上下文（会话归属者；多用户隔离，docs/dev/web-isolation.md §3.3）
   * @param sessionId 可选：恢复既有底层会话（刷新后恢复历史；仅归属者可恢复）
   * @returns chatId / sessionId / projectRoot
   * @throws ApiError 403 personalOnly 模式下请求了个人区之外的目录
   * @throws JailViolationError projectRoot 越出白名单（personalOnly=false 旧路径，映射 403）
   * @throws ApiError 404 指定 sessionId 不存在或不属于当前用户
   */
  async createChat(projectRoot: string, ctx: AuthContext, sessionId?: string): Promise<CreateChatResult> {
    // 个人工作目录模式（docs/dev/web-workspace.md R1/R2）：服务端拼接个人区，
    // 绝不经 ~ 展开或 allowRoots 解析，从源头杜绝越界与路径注入
    const personalRoot = personalUploadRoot(this.settings.uploadDir, ctx.userId);
    // per-user 引擎数据根（R3/R4）：记忆/日志/会话索引落此目录，Web 文件 API 不可达
    const engineHomeDir = path.join(this.settings.engineHomeRoot, ctx.userId);
    if (this.settings.personalOnly) {
      // 尽力确保两级目录就绪（个人区 + 引擎区；mkdir 幂等）
      mkdirSync(personalRoot, { recursive: true });
      mkdirSync(engineHomeDir, { recursive: true });
    }

    // 牢笼校验：personalOnly 模式下 personalRoot 拼接自服务端可信配置，
    // 仍走 resolveInJail（个人区在其自身牢笼内必然通过，同时消解 symlink）；
    // personalOnly=false 走 allowRoots 白名单旧路径。
    // 必须先于旧历史迁移计算：恢复路径 = realpath 归一后的 resolvedRoot
    //（Mac 上 /var→/private/var 等符号链接形态），迁移的目标 projectCode、
    // 注册表改写值必须与之一致，否则数据迁入「影子目录」——迁移显示
    // 成功但 getSession 按归一形态找不到索引（404）。
    const resolvedRoot = this.settings.personalOnly
      ? await resolveInJail(await buildJailRoots([personalRoot]), personalRoot)
      : await resolveInJail(this.jailRoots, projectRoot);

    // W6 旧历史迁移 + 恢复防御（docs/dev/web-workspace.md 补充需求）：
    // personalOnly 模式下，恢复目标在本人注册表中的 projectRoot 落在个人区之外
    // （旧共享模式 / 工作区重建时代的历史）时——先尝试把该会话的聊天数据
    // （索引条目 + jsonl + 图片）与全局记忆一次性拷贝进本人引擎数据根，并把
    // 注册表条目改写为个人区根，之后按个人区正常恢复。
    //
    // 必须位于 W3 显式 projectRoot 校验**之前**：前端恢复历史会话时必然携带
    // 旧 projectRoot（点击的是注册表记录的旧项目根），若先做 W3 校验，
    // 旧会话恢复永远走不到迁移通路（恒 403）。
    // 注册表命中本身即证明该 sessionId 归当前用户所有，其携带的旧根
    // 属于「合法恢复意图」而非越界尝试；未命中注册表的任意 projectRoot
    // 仍被下方 W3 校验拒绝。
    let legacyMigrated = false;
    if (this.settings.personalOnly && sessionId !== undefined) {
      const registryHit = findChatBySessionId(ctx.userId, sessionId, this.registryBaseDir);
      if (registryHit && path.resolve(registryHit.projectRoot) !== resolvedRoot) {
        legacyMigrated = true;
        // 迁移后注册表条目已改写为个人区根（resolvedRoot 形态）；旧根会话的
        // 聊天数据与记忆已拷贝。后续恢复一律按个人区进行，不再使用客户端
        // 携带的旧根。迁移目标按 resolvedRoot（realpath 归一值）计算——
        // getProjectCode 对路径逐字节敏感，未归一形态（如 /var 与
        // /private/var）会算出不同 projectCode，数据迁入影子目录导致
        // 迁移显示成功但恢复 404。
        const migrated = this.migrateLegacySession(ctx.userId, sessionId, resolvedRoot, engineHomeDir);
        if (!migrated) {
          legacyMigrated = false;
          throw new ApiError(403, "历史会话所在目录不在个人工作区内，无法恢复");
        }
        console.log(`[session-pool] 旧会话 ${sessionId} 已迁移至个人工作区（聊天数据与记忆拷贝完成）`);
      }
    }

    if (this.settings.personalOnly && !legacyMigrated) {
      // W3：显式传入 projectRoot 时只接受本人个人区（明确 403，不静默改写）；
      // 归一后比较，允许尾斜杠 / 相对等价写法等表达同一目录
      const requested = (projectRoot ?? "").trim();
      if (requested !== "" && path.resolve(requested) !== personalRoot) {
        throw new ApiError(403, "个人工作目录模式：会话只能在你的个人工作区内创建，无法访问其他目录");
      }
    }

    // 恢复归属校验（R2/AC3）：目标 sessionId 必须属于当前用户——
    // 注册表中有记录，或池内该用户活跃会话已绑定该 sessionId（轮次进行中刷新场景）。
    // 校验失败复用「不存在」文案与 404 状态码，不区分「不存在」与「无权」（R5 防枚举）
    if (sessionId !== undefined) {
      const registryHit = findChatBySessionId(ctx.userId, sessionId, this.registryBaseDir);
      const activeHit = [...this.chats.values()].some(
        (chat) => chat.ownerUserId === ctx.userId && chat.sessionId === sessionId
      );
      if (!registryHit && !activeHit) {
        throw new ApiError(404, `会话 ${sessionId} 在项目 ${resolvedRoot} 下不存在，无法恢复`);
      }
    }

    const chatId = randomUUID();
    const createTime = new Date().toISOString();
    // steering 中断队列（docs/dev/web-steering.md W2）：每聊天一个实例，
    // 与 CLI 同款无回调构造（onEnqueue 无对齐义务——E3 本就是下一 chunk 生效）
    const interruptQueue = new InterruptQueue();
    // 引擎设置解析：personalOnly 时忽略项目级 settings（个人区可写区不得注入
    // 凭据 / mcpServers / 权限模式，docs/dev/web-workspace.md R5 P0 防线）
    const ignoreProjectSettings = this.settings.personalOnly;
    const settings = resolveCurrentSettings(resolvedRoot, { ignoreProjectSettings });

    // 事件桥接闭包引用：status 帧需要读取最新 pendingTurns/turnActive（W1③），
    // 用 const 包裹 chat 对象，闭包内读取的是属性最新值（chat 先于首帧事件存在）
    const chatRef: ChatSession = {
      chatId,
      manager: undefined as unknown as SessionManager,
      projectRoot: resolvedRoot,
      sessionId: null,
      createTime,
      busy: Promise.resolve(),
      pendingTurns: 0,
      turnActive: false,
      interruptQueue,
      owner: ctx.sub,
      ownerUserId: ctx.userId,
    };

    const manager = new SessionManager({
      projectRoot: resolvedRoot,
      // W2 牢笼注入：per-user 引擎数据根（记忆/日志/会话索引按用户物理分离）
      // 与项目级 settings 忽略开关（personalOnly=false 时两者缺省 = 旧行为）
      ...(this.settings.personalOnly ? { homeDir: engineHomeDir, ignoreProjectSettings: true } : {}),
      // ADR-DI-001 动态指令注入接线（docs/dev/web-steering.md W2）：注入后
      // E3 流式检查点/E2 主循环头部才生效；未注入时引擎行为零变化。
      interruptQueue,
      // OpenAI 连接工厂：测试经 SessionPoolOptions 注入受控句柄；生产走 core 默认实现。
      // personalOnly 时在外层再包一层 HOME 覆写：bash 子进程（buildShellEnv 合并
      // createOpenAIClient().env）与引擎内 os.homedir() 的家目录写入全部落
      // <engineHomeRoot>/<userId>，进程级 HOME 不动（并发安全，审查 P0-2）。
      createOpenAIClient: () => {
        const base = this.createOpenAIClientOverride
          ? this.createOpenAIClientOverride(resolvedRoot)
          : createDefaultOpenAIClient(resolvedRoot);
        if (!this.settings.personalOnly) {
          return base;
        }
        return { ...base, env: { ...base.env, HOME: engineHomeDir } };
      },
      // LLM 工厂缝合点：测试注入受控 LLMClient；未注入时 undefined 走 core 默认路由
      ...(this.createLLMClient ? { createLLMClient: this.createLLMClient } : {}),
      // steering 意图分类客户端工厂（W2 测试缝合点；未注入时 core 内部
      // 回退 createLLMClient()——凭据/provider 路由/ignoreProjectSettings 单一事实源）
      ...(this.classifyLlmClientFactory ? { classifyLlmClientFactory: this.classifyLlmClientFactory } : {}),
      // 配置直读：与 CLI 同源（resolveCurrentSettings 透传；
      // personalOnly 时同样忽略项目级 settings，与 SessionManager 内部解析一致）
      getResolvedSettings: () => resolveCurrentSettings(resolvedRoot, { ignoreProjectSettings }),
      renderMarkdown: (text) => text,
      nonInteractive: true,
      // —— 事件桥接（chatId 闭包绑定）——
      onAssistantMessage: (message) => {
        // steering W1①：载荷补 role + meta——注入指令的 system 消息带
        // meta.steeringInject 标记（core C1②），前端据此渲染「指令注入」样式，
        // 替代脆弱的内容前缀匹配
        this.hub.publish(chatId, "assistant_message", {
          chatId,
          messageId: message.id,
          role: message.role,
          content: message.content ?? "",
          meta: message.meta ?? null,
        });
      },
      onLlmStreamProgress: (progress) => {
        // docs/dev/web-thinking-display.md W1：thinkingText 独立透传——
        // 前端渲染可折叠「思考过程」（换行保留的 Markdown 源文本）
        this.hub.publish(chatId, "llm_delta", {
          chatId,
          phase: progress.phase,
          previewText: progress.previewText,
          thinkingText: progress.thinkingText,
        });
      },
      onSessionEntryUpdated: (entry) => {
        // steering W1③：status 快照补 pendingTurns/turnActive——前端与
        // SSE 重连快照可感知排队深度与轮次活性（无需等 done 帧）
        this.hub.publish(chatId, "status", {
          chatId,
          status: entry.status,
          askPermissions: entry.askPermissions ?? null,
          pendingTurns: chatRef.pendingTurns,
          turnActive: chatRef.turnActive,
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

    // 回填 manager 引用（chatRef 已在上面建好，事件桥接闭包即可安全引用）
    chatRef.manager = manager;
    const chat = chatRef;
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
    // 注册表登记（R2）：创建即落盘归属记录（sessionId 尚为 null，轮次 done 后回写补全），
    // 进程重启后历史列表与恢复校验均以本表为准。
    // 写盘失败不抛出：池内会话已建立，失败仅影响重启后恢复能力，与轮次回写同收敛策略
    try {
      upsertUserChat(
        ctx.userId,
        {
          chatId,
          sessionId: chat.sessionId,
          projectRoot: resolvedRoot,
          title: null,
          status: "pending",
          createTime,
          updateTime: createTime,
        },
        this.registryBaseDir
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[session-pool] 注册表登记失败 chatId=${chatId}: ${message}`);
    }
    return { chatId, sessionId: chat.sessionId, projectRoot: resolvedRoot };
  }

  /**
   * 把旧（个人区之外）引擎数据根下的一次性会话数据迁移进本人引擎数据根
   * （docs/dev/web-workspace.md 补充需求：个人工作目录模式启用前的历史会话，
   * 聊天数据与全局记忆都要拷贝到个人工作区，之后记忆只使用个人区副本）。
   *
   * 迁移内容（全部复制、绝不移动/删除旧数据——共享模式下其他用户可能仍依赖）：
   * 1. 会话聊天数据：`<sourceHome>/.deepcode/projects/<sourceCode>/` 内该会话的
   *    sessions-index.json 条目、`<sessionId>.jsonl` 消息流、`images/<sessionId>/`
   *    图片目录 → 合并/复制到 `<engineHome>/.deepcode/projects/<personalCode>/`；
   * 2. 全局记忆（一次性拷贝）：`<sourceHome>/.deepcode/` 的 memory 目录、
   *    global-context.json、AGENTS.md → 本人引擎数据根，**目标已存在时跳过**
   *    （记忆隔离语义：个人区一旦有自己的记忆，绝不与共享区旧记忆混合）。
   *
   * 安全边界：
   * - sessionId 必须是 UUID 形态（jsonl 文件名直接拼接，防路径注入）；
   * - 个人引擎区（engineHomeRoot 及其子树、projects 下 `.` 前缀目录）一律
   *   不作为迁移源——防止把某个用户的个人引擎区当作源拷贝（越权读取他人数据）；
   * - 注册表条目 projectRoot 改写为个人区根后立即原子落盘（tmp+rename），
   *   后续恢复归属校验与列表展示均以改写后的记录为准。
   *
   * @param userId 归属者隔离标识（注册表读写主键）
   * @param sessionId 待迁移的底层引擎会话 id
   * @param personalRoot 本人个人工作区根（改写注册表条目的目标 projectRoot）
   * @param engineHome 本人引擎数据根（迁移目标 `<engineHomeRoot>/<userId>`）
   * @returns true=迁移完成（调用方按个人区正常恢复）；false=无法安全迁移
   */
  private migrateLegacySession(userId: string, sessionId: string, personalRoot: string, engineHome: string): boolean {
    try {
      // ① sessionId 合法性：引擎会话 id 恒为 UUID；强校验后文件名可安全直接拼接
      const entry = loadUserChats(userId, this.registryBaseDir).find((item) => item.sessionId === sessionId);
      if (!entry || !/^[0-9a-fA-F-]{36}$/.test(sessionId)) {
        return false;
      }
      // ② 注册表条目中的旧项目根（已确认落在个人区之外，调用方保证）
      const legacyRoot = path.resolve(entry.projectRoot);
      // ③ 旧引擎数据根推导：引擎会话数据的锚点是 `<引擎数据根>/.deepcode/projects/
      //    <projectCode>/`，旧共享时代的引擎数据根 = 旧服务进程家目录，
      //    无法从配置精确还原，按合理性依次尝试：
      //    a) legacyRoot 直接作为引擎数据根（旧进程家目录被直接用作工作目录）；
      //    b) legacyRoot 的父目录链（旧工作目录位于家目录下一/二/三级是常见布局，
      //       3 层封顶 + 必须真存在，防无界上溯）；
      //    c) 服务进程家目录（共享时代从未改过引擎区的部署）。
      //    个人引擎区（engineHomeRoot 及其任何子树——含 uploadDir/<userId> 个人区）
      //    一律不作为源，杜绝跨用户读取。
      const engineRootAbs = path.resolve(this.settings.engineHomeRoot);
      const insideEngineRoot = (target: string): boolean =>
        target === engineRootAbs || target.startsWith(engineRootAbs + path.sep);
      const legacyHomeCandidates: string[] = [];
      const pushCandidate = (candidate: string): void => {
        const abs = path.resolve(candidate);
        if (!insideEngineRoot(abs) && existsSync(abs) && !legacyHomeCandidates.includes(abs)) {
          legacyHomeCandidates.push(abs);
        }
      };
      pushCandidate(legacyRoot);
      let ancestor = path.dirname(legacyRoot);
      for (let depth = 0; depth < 3; depth += 1) {
        pushCandidate(ancestor);
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          break; // 到达文件系统根，停止上溯
        }
        ancestor = parent;
      }
      pushCandidate(homedir());
      // ④ 源选择：收集**全部**含该会话索引条目的候选源。
      // 多源歧义（同一 sessionId 的索引散落在多个候选家目录，开发机上
      // 常见——真实进程家目录与旧部署引擎目录并存）时按候选顺序优先：
      // 旧项目根自身及其祖先链（精确推导，记忆与聊天数据同根）排在
      // 进程家目录（默认布局影子源）之前，先命中先裁决。
      type SourceCandidate = { home: string; projects: string };
      const sourceMatches: SourceCandidate[] = [];
      const indexHasSession = (indexPath: string): boolean => {
        if (!existsSync(indexPath)) {
          return false;
        }
        try {
          const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as { entries?: Array<{ id?: string }> };
          return Array.isArray(parsed.entries) && parsed.entries.some((item) => item?.id === sessionId);
        } catch {
          // 索引损坏：视为未命中，交给下一个候选
          return false;
        }
      };
      for (const home of legacyHomeCandidates) {
        const projectsDir = path.join(home, ".deepcode", "projects");
        if (!existsSync(projectsDir)) {
          continue;
        }
        let codes: string[];
        try {
          codes = readdirSync(projectsDir);
        } catch {
          continue;
        }
        for (const code of codes) {
          // 个人引擎区的 projectCode 目录形态（`.` 前缀隐藏目录）不作为迁移源
          if (code.startsWith(".")) {
            continue;
          }
          if (indexHasSession(path.join(projectsDir, code, "sessions-index.json"))) {
            sourceMatches.push({ home, projects: path.join(projectsDir, code) });
            break; // 同一 home 只取一个命中目录
          }
        }
      }
      if (sourceMatches.length === 0) {
        // 兜底（共享时代引擎从未改过引擎区的部署）：legacyRoot 被用作工作
        // 目录，但会话数据按默认布局直接落在服务进程家目录（家目录候选
        // 即便已扫过，上一步也只扫家目录的 projects，而非按旧根推导的
        // projectCode 路径——该场景下家目录扫描同样命中，此处仅为家目录
        // 不在候选列表（等于个人引擎区，极端配置）时留一条按默认布局
        // 定位的通路）。个人引擎区仍被排除，跨用户读取不可能发生。
        const homeAbs = path.resolve(homedir());
        const legacyCode = getProjectCode(legacyRoot);
        if (!insideEngineRoot(homeAbs) && !legacyCode.startsWith(".")) {
          const directProjects = path.join(homeAbs, ".deepcode", "projects", legacyCode);
          if (indexHasSession(path.join(directProjects, "sessions-index.json"))) {
            sourceMatches.push({ home: homeAbs, projects: directProjects });
          }
        }
      }
      if (sourceMatches.length === 0) {
        // 源数据必须真实存在且含该会话索引条目——无源可迁时绝不进入注册表
        // 改写，绝不出现「条目已改写但数据未迁移」半态。
        return false;
      }
      // 多源歧义裁决：候选顺序第一个命中（旧项目根/祖先链优先于进程家目录）
      const chosenSource = sourceMatches[0];
      const sourceProjects = chosenSource.projects;
      const sourceHome = chosenSource.home;

      // ⑤ 目标项目目录（个人区根的 projectCode）与数据复制。
      // 必须按引擎恢复时的 projectRoot 计算（调用方传入的 resolvedRoot =
      // realpath 归一值）——getProjectCode 对路径逐字节敏感，未归一形态
      // （如 /var 与 /private/var）可能算出不同 projectCode，数据迁入
      // 「影子目录」会导致迁移成功但恢复 404。
      // 引擎 saveSessionsIndex 落盘时写 originalPath=projectRoot，load 时
      // 信任该值——迁移条目同样改写，保持与目标区原生条目一致。
      const targetCode = getProjectCode(personalRoot);
      const targetDir = path.join(engineHome, ".deepcode", "projects", targetCode);
      mkdirSync(targetDir, { recursive: true });
      // 消息流 jsonl（目标已存在同名文件时不覆盖——个人区数据优先）
      const sourceJsonl = path.join(sourceProjects, `${sessionId}.jsonl`);
      const targetJsonl = path.join(targetDir, `${sessionId}.jsonl`);
      if (existsSync(sourceJsonl) && !existsSync(targetJsonl)) {
        cpSync(sourceJsonl, targetJsonl);
      }
      // 会话图片目录（递归复制，force=false 保证同名不覆盖）
      const sourceImages = path.join(sourceProjects, "images", sessionId);
      const targetImages = path.join(targetDir, "images", sessionId);
      if (existsSync(sourceImages)) {
        cpSync(sourceImages, targetImages, { recursive: true, force: false, errorOnExist: false });
      }
      // 会话索引条目合并：源条目原样追加；同 id 条目以目标（个人区）为准。
      // 读失败/结构非法时目标索引保持原样，会话将因条目缺失回退 403（不静默造数据）
      const sourceIndex = JSON.parse(readFileSync(path.join(sourceProjects, "sessions-index.json"), "utf8")) as {
        entries: Array<Record<string, unknown>>;
      };
      const targetIndexPath = path.join(targetDir, "sessions-index.json");
      let targetEntries: Array<Record<string, unknown>> = [];
      if (existsSync(targetIndexPath)) {
        try {
          const parsedTarget = JSON.parse(readFileSync(targetIndexPath, "utf8")) as { entries?: unknown };
          if (Array.isArray(parsedTarget.entries)) {
            targetEntries = parsedTarget.entries as Array<Record<string, unknown>>;
          }
        } catch {
          // 目标索引损坏：以空表重建（仅含迁入条目），损坏文件先备份
          cpSync(targetIndexPath, `${targetIndexPath}.corrupted.${Date.now()}`);
        }
      }
      const targetIds = new Set(targetEntries.map((item) => String(item["id"] ?? "")));
      for (const item of sourceIndex.entries ?? []) {
        if (String(item["id"] ?? "") === sessionId && !targetIds.has(sessionId)) {
          targetEntries.push(item);
        }
      }
      // sourceIndex.entries 全部校验通过后原子写入（tmp+rename）
      const tmpIndex = `${targetIndexPath}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmpIndex, JSON.stringify({ version: 1, entries: targetEntries }, null, 2), "utf8");
      renameSync(tmpIndex, targetIndexPath);

      // ⑥ 全局记忆一次性拷贝（逐文件：个人区已有同名文件即跳过——个人区
      // 记忆独立，绝不与共享区旧记忆混合；memory 目录可能已被个人区活动
      // 创建（如 redaction.log），整目录跳过会丢失旧记忆文件，故平铺复制）
      const legacyDeepcode = path.join(sourceHome, ".deepcode");
      const targetDeepcode = path.join(engineHome, ".deepcode");
      const copyFileIfMissing = (src: string, dst: string): void => {
        if (!existsSync(src) || existsSync(dst)) {
          return;
        }
        mkdirSync(path.dirname(dst), { recursive: true });
        cpSync(src, dst, { force: false, errorOnExist: false });
      };
      const legacyMemory = path.join(legacyDeepcode, "memory");
      if (existsSync(legacyMemory)) {
        try {
          for (const name of readdirSync(legacyMemory)) {
            copyFileIfMissing(path.join(legacyMemory, name), path.join(targetDeepcode, "memory", name));
          }
        } catch {
          // 目录不可读：记忆拷贝尽力而为，失败不影响聊天数据迁移结论
        }
      }
      copyFileIfMissing(
        path.join(legacyDeepcode, "global-context.json"),
        path.join(targetDeepcode, "global-context.json")
      );
      copyFileIfMissing(path.join(legacyDeepcode, "AGENTS.md"), path.join(targetDeepcode, "AGENTS.md"));

      // ⑦ 注册表条目改写：projectRoot → 个人区根（其余字段原样保留）
      upsertUserChat(userId, { ...entry, projectRoot: personalRoot }, this.registryBaseDir);
      return true;
    } catch (error) {
      // 迁移失败绝不部分生效后才继续恢复：任何异常收敛为 false → 调用方 403
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[session-pool] 旧会话迁移失败 sessionId=${sessionId}: ${message}`);
      return false;
    }
  }

  /**
   * 取会话并校验归属（多用户隔离统一入口，docs/dev/web-isolation.md §3.3）。
   *
   * 归属不符时复用「不存在」文案与 404 状态码（R5 防枚举：不泄露他人会话存在性）。
   *
   * @param chatId Web 会话 id
   * @param ctx 认证上下文
   * @returns 归属校验通过的聊天会话
   * @throws ApiError 404 会话不存在或不属于当前用户
   */
  private getOwnedChat(chatId: string, ctx: AuthContext): ChatSession {
    const chat = this.chats.get(chatId);
    if (!chat || chat.ownerUserId !== ctx.userId) {
      throw new ApiError(404, `会话 ${chatId} 不存在或已关闭`);
    }
    return chat;
  }

  /**
   * 发送一条用户消息（同一 chatId 串行化执行；202 异步受理语义）。
   *
   * 执行序：归属与存在校验 → 入队 Promise 链 → 立即返回受理结果。
   * handleUserPrompt 的整轮执行在后台异步进行（串行链保证同 chatId 顺序），
   * 本轮全部事件（assistant_message / llm_delta / tool_progress /
   * permission_request / status / done）均经 SSE 推送；
   * 轮次结束（含异常）时推 "done"（异常路径 status=failed，见 runTurn），
   * 保证 SSE 订阅方不会被悬死。
   *
   * @param chatId Web 会话 id
   * @param input 消息内容（text / imageUrls / 审批回注 permissions / alwaysAllows）
   * @param ctx 认证上下文（归属校验）
   * @returns 受理结果 {chatId, sessionId}（sessionId 允许 null）
   * @throws ApiError 404 会话不存在或不属于当前用户
   */
  sendMessage(chatId: string, input: SendMessageInput, ctx: AuthContext): SendMessageAcceptance {
    const chat = this.getOwnedChat(chatId, ctx);
    // 受理计数：入队即 +1（runTurn 收敛时 -1，done 帧携带剩余值）
    chat.pendingTurns += 1;
    // W3：排队受理即广播 user_message 帧——多订阅者与 SSE 重连场景实时可见
    //（发送者前端乐观上屏，其余订阅者靠本帧补齐；文本消息才广播，
    //  纯审批回注 permissions 轮次没有用户文本，不广播）
    if (input.text !== undefined && input.text !== "") {
      this.publishUserMessage(chatId, input.text);
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
    return { chatId: chat.chatId, sessionId: chat.sessionId, mode: "queued" };
  }

  /**
   * 广播一条用户消息到该会话的全部 SSE 订阅者（W3/W4a 共用）。
   *
   * 消息为服务端受理时合成的 DTO：无引擎 id（尚未落盘），id 用合成 uuid 占位
   * （仅作前端 React key）；引擎轮内真正落盘的 user 消息在历史恢复时以引擎 id 为准。
   *
   * @param chatId Web 会话 id
   * @param text 用户消息文本
   */
  private publishUserMessage(chatId: string, text: string): void {
    const now = new Date().toISOString();
    this.hub.publish(chatId, "user_message", {
      chatId,
      message: {
        id: randomUUID(),
        role: "user",
        content: text,
        visible: true,
        createTime: now,
        updateTime: now,
      },
    });
  }

  /**
   * 向运行中的任务注入补充指令（docs/dev/web-steering.md W4）。
   *
   * 调用前提：chat-api 层已完成意图分类（steer）与第一次活性检查；
   * 本方法内做**二次活性检查**（分类窗口内轮次可能恰好收敛——竞态消除）
   * 后才入队。绝不在非 processing 状态注入：InterruptQueue 纯内存不持久化，
   * 无轮次消费的注入会永久滞留、进程重启即丢。
   *
   * @param chatId Web 会话 id
   * @param text 补充指令原文
   * @param ctx 认证上下文（归属校验）
   * @returns injected=true 已入队（引擎 E3/E2 轮内消费）；否则 reason 说明降级原因
   * @throws ApiError 404 会话不存在或不属于当前用户
   */
  injectSteering(chatId: string, text: string, ctx: AuthContext): InjectSteeringResult {
    const chat = this.getOwnedChat(chatId, ctx);
    // W4② 活性检查（P0）：注入的消费前提是引擎 E2 主循环正在执行本会话
    // （注入队列有消费方）。唯一可靠判据 = 引擎内存运行时事实：
    // getActiveRuntimeSessionId 非空即主循环在跑（createSession 首轮路径
    // chat.sessionId 尚未绑定、索引条目状态亦有落盘滞后，两者均不可信）。
    // 分类窗口内轮次若恰好收敛（activateSession finally 已注销运行时），
    // 纯内存的 InterruptQueue 注入将永久滞留，必须拒绝 → 调用方降级排队。
    if (chat.manager.getActiveRuntimeSessionId() === null) {
      return { injected: false, reason: "inactive", sessionId: chat.sessionId };
    }
    try {
      // 委托 core 公开入口入队（内部校验非空 + MAX_QUEUE_SIZE 上限）
      chat.manager.injectInstruction(text);
    } catch {
      // 队列满 / 文本非法等引擎拒绝：保守降级排队，不污染运行中轮次
      return { injected: false, reason: "queue", sessionId: chat.sessionId };
    }
    // W4a：注入成功后广播 user_message 帧——注入消息与排队消息在订阅者视角同等可见
    this.publishUserMessage(chatId, text);
    return { injected: true, sessionId: chat.sessionId };
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
    // W5 轮次活性标志：入口置 true、finally 置 false（同步赋值，无 await 竞态）
    // steering 注入的二次活性检查依赖本标志（分类窗口内轮次可能恰好收敛）
    chat.turnActive = true;
    try {
      await chat.manager.handleUserPrompt(prompt);
    } catch (error) {
      turnError = error;
    } finally {
      // 成败都同步 sessionId（异常路径下会话可能已创建，状态为 failed）
      chat.sessionId = chat.manager.getActiveSessionId() ?? chat.sessionId;
      chat.turnActive = false;
    }

    if (turnError !== null) {
      const message = turnError instanceof Error ? turnError.message : String(turnError);
      // P1-3：轮次异常必须推送 failed done 帧，否则前端等待本轮结束的订阅方悬死；
      // error 摘要随帧携带（DoneEvent 契约：仅 failed 时存在），再记录服务端日志
      // 收敛计数先行递减：done 帧的 pendingTurns = 本轮收敛后仍在排队的轮次数
      chat.pendingTurns = Math.max(0, chat.pendingTurns - 1);
      const doneEvent: DoneEvent = {
        chatId: chat.chatId,
        sessionId: chat.sessionId,
        status: "failed",
        error: message,
        pendingTurns: chat.pendingTurns,
      };
      this.hub.publish(chat.chatId, "done", doneEvent);
      // 注册表回写：失败轮次同样落盘（AC7 状态一致性；sessionId 可能已创建）
      this.persistChatRegistration(chat, null);
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

    // 轮次结束信号（前端据此收起停止按钮/刷新状态）。
    // 收敛计数先行递减：旧轮次 done 携带 pendingTurns>0 时，前端可知仍有
    // 排队轮次（同会话连发任务的串行排队场景），不得复位「生成中」状态
    chat.pendingTurns = Math.max(0, chat.pendingTurns - 1);
    this.hub.publish(chat.chatId, "done", {
      chatId: chat.chatId,
      sessionId: chat.sessionId,
      status,
      pendingTurns: chat.pendingTurns,
    });

    // 注册表回写（R2）：轮次收敛点落盘归属记录（成功与异常路径均覆盖），
    // 进程重启后该用户的列表 / 恢复校验以注册表为准
    this.persistChatRegistration(chat, session);
  }

  /**
   * 将会话当前状态回写至归属用户的注册表（docs/dev/web-isolation.md §3.3）。
   *
   * 标题 / 状态 / updateTime 取引擎条目快照；引擎条目不可用（如失败早于建会话）时
   * 保留注册表现值语义（title 传 null 即覆盖为 null——轮次失败场景状态必须如实为 failed）。
   *
   * @param chat 目标聊天（ownerUserId 决定写入哪份注册表）
   * @param session 引擎会话条目（可能为 null）
   */
  private persistChatRegistration(chat: ChatSession, session: ReturnType<SessionManager["getSession"]>): void {
    try {
      upsertUserChat(
        chat.ownerUserId,
        {
          chatId: chat.chatId,
          sessionId: chat.sessionId,
          projectRoot: chat.projectRoot,
          title: session?.summary ?? null,
          status: session?.status ?? "failed",
          createTime: chat.createTime,
          updateTime: session?.updateTime ?? new Date().toISOString(),
        },
        this.registryBaseDir
      );
    } catch (error) {
      // 注册表写失败不阻断对话主链路：仅影响重启后历史可见性，记录日志即可
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[session-pool] 注册表回写失败 chatId=${chat.chatId}: ${message}`);
    }
  }

  /**
   * 中断当前生成（对应引擎 interruptActiveSession，docs/dev/web-ui.md R8）。
   *
   * 不等待引擎收尾：handleUserPrompt 会随中断信号自行结束并经事件桥接推送 status/done。
   *
   * @param chatId Web 会话 id
   * @param ctx 认证上下文（归属校验）
   * @throws ApiError 404 会话不存在或不属于当前用户
   */
  interrupt(chatId: string, ctx: AuthContext): void {
    const chat = this.getOwnedChat(chatId, ctx);
    chat.manager.interruptActiveSession();
  }

  /**
   * 查询会话活性快照（docs/dev/web-steering.md W6 判定链依据 / W1③ 快照载荷）。
   *
   * chat-api 在 handleSendMessage 分类前做第一次活性检查、SSE 订阅初始快照
   * 组装都用本方法——turnActive（串行链上是否有轮次在引擎内执行）与
   * pendingTurns（排队深度）的唯一读取出口。
   *
   * @param chatId Web 会话 id
   * @param ctx 认证上下文（归属校验）
   * @returns turnActive / pendingTurns / 引擎状态（无底层会话时 null）
   * @throws ApiError 404 会话不存在或不属于当前用户
   */
  getChatActivity(
    chatId: string,
    ctx: AuthContext
  ): { turnActive: boolean; pendingTurns: number; status: SessionStatus | null } {
    const chat = this.getOwnedChat(chatId, ctx);
    // 运行中优先：引擎 E2 主循环执行期间（getActiveRuntimeSessionId 非空）
    // 状态必为 processing——磁盘索引条目要到 updateSessionEntry 落盘才可见
    // （createSession 首轮 sessionId 甚至尚未绑定），读盘在此窗口内滞后。
    // 引擎内存运行时是唯一可靠的「轮次在跑」事实源。
    // 注意：本方法服务外部可见性（判定链第一次检查 / SSE 快照）——
    // 运行中透出 processing 不构成注入授权，注入的实际判据在 injectSteering。
    const runtimeActive = chat.manager.getActiveRuntimeSessionId() !== null;
    const status: SessionStatus | null = runtimeActive
      ? "processing"
      : chat.sessionId
        ? (chat.manager.getSession(chat.sessionId)?.status ?? null)
        : null;
    // turnActive：池轮次标志（runTurn 入口/finally 同步读写）——比运行时
    // 窗口更宽（覆盖 handleUserPrompt 中 activateSession 前后的准备段），
    // 运行中事实取两者并集（链上排队轮尚未启动时二者皆 false）
    const turnActive = chat.turnActive || runtimeActive;
    return { turnActive, pendingTurns: chat.pendingTurns, status };
  }

  /**
   * 补充指令意图分类（docs/dev/web-steering.md W6 判定链的分类环节）。
   *
   * chat-api 层在「轮次活跃 + steeringEnabled + 纯文本消息」时调用本方法：
   * 一次由引擎客户端工厂构建的非流式 LLM 调用（core
   * SessionManager.classifySteeringIntent——凭据/provider 路由单一事实源），
   * 3 秒超时由 AbortSignal.timeout 控制。
   *
   * 分类失败（凭据缺失/网络错误/超时/非法输出）**一律抛错**——保守安全，
   * 由调用方（chat-api）降级排队，绝不猜测意图污染运行中轮次。
   *
   * @param chatId Web 会话 id
   * @param text 用户补充指令原文
   * @param ctx 认证上下文（归属校验）
   * @returns intent=steer（立即注入）| next（排队为新任务）+ 模型理由
   * @throws ApiError 404 会话不存在或不属于当前用户
   * @throws Error 分类客户端不可用 / 调用失败 / 输出非法 / 3 秒超时
   */
  async classifySteering(
    chatId: string,
    text: string,
    ctx: AuthContext
  ): Promise<{ intent: "steer" | "next"; reason: string }> {
    const chat = this.getOwnedChat(chatId, ctx);
    // 最近上下文摘要：分类发生在运行中轮次内，此刻 chat.sessionId 可能尚未
    // 绑定（createSession 首轮要等 runTurn finally 才同步）——以引擎内存
    // 运行时 id 为准（无活跃轮次时回退 chat.sessionId，再空则占位提示）。
    const sessionIdForContext = chat.manager.getActiveRuntimeSessionId() ?? chat.sessionId;
    let recentContext = "";
    if (sessionIdForContext) {
      const messages = chat.manager
        .listSessionMessages(sessionIdForContext)
        .filter((message) => message.visible && message.content)
        .slice(-6);
      recentContext = messages.map((message) => `${message.role}: ${(message.content ?? "").slice(0, 200)}`).join("\n");
    }
    if (recentContext === "") {
      recentContext = "（无可见历史，仅有本条补充指令）";
    }
    // 3 秒硬超时（S3：超时 → 调用方降级排队）
    return chat.manager.classifySteeringIntent(text, recentContext, AbortSignal.timeout(3000));
  }

  /**
   * 查询会话元信息（chat-api 响应组装用）。
   *
   * @param chatId Web 会话 id
   * @param ctx 认证上下文（归属校验）
   * @returns chatId / sessionId / projectRoot
   * @throws ApiError 404 会话不存在或不属于当前用户
   */
  getChatInfo(chatId: string, ctx: AuthContext): { chatId: string; sessionId: string | null; projectRoot: string } {
    const chat = this.getOwnedChat(chatId, ctx);
    return { chatId: chat.chatId, sessionId: chat.sessionId, projectRoot: chat.projectRoot };
  }

  /**
   * 读取会话历史消息（刷新恢复用）。
   *
   * @param chatId Web 会话 id
   * @param ctx 认证上下文（归属校验）
   * @returns 消息 DTO 列表（尚未产生底层会话时为空数组）
   * @throws ApiError 404 会话不存在或不属于当前用户
   */
  getMessages(chatId: string, ctx: AuthContext): ChatMessageDto[] {
    const chat = this.getOwnedChat(chatId, ctx);
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
      // W1①：桥接 meta（含 steeringInject）——历史恢复路径与实时帧同判据渲染注入样式
      ...(message.meta ? { meta: message.meta } : {}),
    }));
  }

  /**
   * 会话列表（按用户隔离，docs/dev/web-isolation.md §3.3）：当前用户的池内活跃会话
   * + 其私有注册表历史合并，按 updateTime 降序。
   *
   * 去重规则：同一底层 sessionId 以池内活跃记录为准（历史记录跳过）；
   * 磁盘历史不再扫描 sessions-index.json（无归属者信息，全量忽略），
   * 仅取该用户注册表（chat-registry）。
   *
   * @param ctx 认证上下文（决定可见集合）
   * @returns 会话摘要列表
   */
  listChats(ctx: AuthContext): ChatSummary[] {
    /** sessionId/chatId → 摘要 */
    const merged = new Map<string, ChatSummary>();

    // 1. 池内活跃会话（仅本人：ownerUserId 匹配）
    for (const chat of this.chats.values()) {
      if (chat.ownerUserId !== ctx.userId) {
        continue;
      }
      const entry = chat.sessionId ? chat.manager.getSession(chat.sessionId) : null;
      // P1-4 去重键统一为底层 sessionId：历史条目以 sessionId 为键，
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

    // 2. 磁盘历史：当前用户私有注册表（R2 历史归属）
    for (const entry of loadUserChats(ctx.userId, this.registryBaseDir)) {
      // 同一 sessionId 已有活跃记录时以活跃为准（chatId 兜底键同理）
      if (merged.has(entry.sessionId ?? entry.chatId)) {
        continue;
      }
      merged.set(entry.sessionId ?? entry.chatId, {
        chatId: entry.chatId,
        sessionId: entry.sessionId,
        projectRoot: entry.projectRoot,
        title: entry.title,
        status: entry.status,
        createTime: entry.createTime,
        updateTime: entry.updateTime,
        source: "history",
      });
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

/** 导出 AskPermissionRequest 类型别名（api 层组装 permission_request 载荷用） */
export type { AskPermissionRequest };
