/**
 * 左侧会话侧栏（可折叠）：新建对话 + 项目根选择 + 历史会话列表 + 用户区。
 *
 * 交互（设计文档 §4）：
 * - 「新建对话」按钮：以当前选中的 projectRoot（来自 /api/config 的 allowRoots）创建会话；
 * - 会话列表：标题（title 优先，缺省回退 summary）+ 相对时间，当前会话高亮；
 * - 底部用户区：显示名 + 登出按钮（图标直显）；
 * - 折叠为窄条（仅保留展开按钮），展开/收起状态由 App 持有。
 */
import type { ChatSummary, UserInfo } from "../api";
import { formatTime } from "../format";
import { ChatIcon, FolderIcon, LogoutIcon, PanelLeftIcon, PlusIcon, UserAvatarIcon } from "./icons";

/** SessionSidebar 组件属性 */
export interface SessionSidebarProps {
  /** 是否处于折叠态 */
  collapsed: boolean;
  /** 会话列表 */
  chats: ChatSummary[];
  /** 当前选中会话 id */
  activeChatId: string | null;
  /** 当前登录用户 */
  user: UserInfo | null;
  /** 项目根白名单（新建会话可选的项目目录） */
  allowRoots: string[];
  /** 当前选中的项目根 */
  projectRoot: string;
  /** 展开/折叠切换 */
  onToggleCollapsed: () => void;
  /** 选中会话 */
  onSelectChat: (chatId: string) => void;
  /** 新建对话 */
  onNewChat: () => void;
  /** 切换项目根 */
  onProjectRootChange: (root: string) => void;
  /** 正在创建会话（按钮禁用防连点） */
  creating: boolean;
  /** 登出 */
  onLogout: () => void;
}

/** 取会话展示标题：后端契约为 title（string | null），null/空串时回退"未命名对话" */
function chatTitle(c: ChatSummary): string {
  if (typeof c.title === "string" && c.title !== "") return c.title;
  return "未命名对话";
}

/** SessionSidebar：左侧栏 */
export function SessionSidebar(props: SessionSidebarProps) {
  const {
    collapsed,
    chats,
    activeChatId,
    user,
    allowRoots,
    projectRoot,
    onToggleCollapsed,
    onSelectChat,
    onNewChat,
    onProjectRootChange,
    creating,
    onLogout,
  } = props;

  // 折叠态：窄条仅保留展开按钮（图标直显）
  if (collapsed) {
    return (
      <aside className="sidebar sidebar-collapsed">
        <button type="button" className="icon-btn" title="展开侧栏" onClick={onToggleCollapsed}>
          <PanelLeftIcon size={17} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      {/* 顶部：折叠按钮 + 新建对话 */}
      <div className="sidebar-top">
        <button type="button" className="icon-btn" title="折叠侧栏" onClick={onToggleCollapsed}>
          <PanelLeftIcon size={17} />
        </button>
      </div>

      <div className="sidebar-new">
        <button type="button" className="new-chat-btn" onClick={onNewChat} disabled={creating}>
          <PlusIcon size={15} />
          新建对话
        </button>
        {/* 项目根选择：allowRoots 多于一个时展示（新建会话将落在该目录） */}
        {allowRoots.length > 1 && (
          <label className="project-root-row">
            <FolderIcon size={14} className="project-root-icon" />
            <select
              className="project-root-select"
              value={projectRoot}
              onChange={(e) => onProjectRootChange(e.target.value)}
              title="新对话的项目目录"
            >
              {allowRoots.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        )}
        {/* 空白名单引导（第一次启动未配置 web.allowRoots 时）：明确告知配置方法而非报 400 */}
        {allowRoots.length === 0 && (
          <div className="project-root-empty" title="新建对话前需要先配置允许访问的项目目录">
            未配置项目根目录：请在 ~/.deepcode/settings.json 的 web.allowRoots 中添加目录后重启服务
          </div>
        )}
      </div>

      {/* 历史会话列表（P0-1：主键为 chatId；状态点对齐引擎 SessionStatus 的 processing） */}
      <nav className="chat-list" aria-label="历史会话">
        {chats.length === 0 && <div className="chat-list-empty">暂无历史会话</div>}
        {chats.map((c) => (
          <button
            key={c.chatId}
            type="button"
            className={`chat-item${c.chatId === activeChatId ? " chat-item-active" : ""}`}
            onClick={() => onSelectChat(c.chatId)}
            title={chatTitle(c)}
          >
            <ChatIcon size={15} className="chat-item-icon" />
            <span className="chat-item-main">
              <span className="chat-item-title">{chatTitle(c)}</span>
              <span className="chat-item-time">{formatTime(c.updateTime)}</span>
            </span>
            {/* 执行中的会话显示状态点（引擎状态语义：processing = 生成中） */}
            {c.status === "processing" && <span className="chat-item-dot" title="生成中" />}
          </button>
        ))}
      </nav>

      {/* 底部用户区：默认头像 + 显示名直显 + 登出 */}
      <div className="sidebar-user">
        <UserAvatarIcon size={22} className="sidebar-user-avatar" />
        <span className="sidebar-user-name" title={user?.mail ?? user?.username ?? ""}>
          {user?.displayName !== "" && user?.displayName !== undefined ? user.displayName : (user?.username ?? "")}
        </span>
        <button type="button" className="icon-btn" title="退出登录" onClick={onLogout}>
          <LogoutIcon size={16} />
        </button>
      </div>
    </aside>
  );
}
