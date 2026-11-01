/**
 * 左侧会话侧栏（可折叠）：新建对话 + 工作空间切换/项目根选择 + 历史会话列表 + 用户区。
 *
 * 交互（设计文档 §4；工作空间 ARCH-20261027 T05；web-personal-subworkspace T1）：
 * - 「新建对话」按钮：personalOnly 模式弹出「选择工作区文件夹」面板——浏览个人区
 *   子文件夹、新建文件夹、选当前文件夹作为对话工作区（空选 = 个人区根）；
 *   非 personalOnly 保持旧行为（直接以当前落点创建）；
 * - 工作空间切换器：服务端返回可用空间列表（GET /api/workspaces）非空时展示，
 *   选中后列表仅显示该空间会话（PRD §5.1）；未配置空间的旧部署回退项目根选择；
 * - 会话列表：按 projectRoot 分组（组头 = 工作空间名 / 个人区相对路径 / 目录名），
 *   组内按最后更新降序，组间按组内最新会话排序；当前会话高亮；
 * - 底部用户区：显示名 + 登出按钮（图标直显）；
 * - 折叠为窄条（仅保留展开按钮），展开/收起状态由 App 持有。
 */
import { useCallback, useEffect, useState } from "react";
import type { ChatSummary, UserInfo, WorkspaceInfo, FileEntry } from "../api";
import { listFiles, mkdir } from "../api";
import { formatTime } from "../format";
import {
  BackIcon,
  ChatIcon,
  CloseIcon,
  FolderIcon,
  FolderOpenIcon,
  LogoutIcon,
  PanelLeftIcon,
  PlusIcon,
  RefreshIcon,
  UserAvatarIcon,
} from "./icons";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

/** SessionSidebar 组件属性 */
export interface SessionSidebarProps {
  /** 是否处于折叠态 */
  collapsed: boolean;
  /** 会话列表（App 已按当前工作空间过滤） */
  chats: ChatSummary[];
  /** 当前选中会话 id */
  activeChatId: string | null;
  /** 当前登录用户 */
  user: UserInfo | null;
  /** 项目根白名单（新建会话可选的项目目录；未配置工作空间时使用） */
  allowRoots: string[];
  /** 当前选中的项目根（未配置工作空间时使用） */
  projectRoot: string;
  /** 可用工作空间列表（GET /api/workspaces；空 = 未配置空间，回退项目根选择） */
  workspaces: WorkspaceInfo[];
  /** 当前选中的工作空间 id */
  workspaceId: string;
  /** 个人工作目录模式（docs/dev/web-workspace.md W7）：true 时 ➕ 弹出文件夹选择器 */
  personalOnly: boolean;
  /** 本人个人工作区绝对路径（文件夹选择器与分组的基准根） */
  personalRoot: string;
  /** 展开/折叠切换 */
  onToggleCollapsed: () => void;
  /** 选中会话 */
  onSelectChat: (chatId: string) => void;
  /** 新建对话：personalOnly 模式可携带所选文件夹绝对路径（缺省 = 个人区根） */
  onNewChat: (folderRoot?: string) => void;
  /** 切换项目根（未配置工作空间时使用） */
  onProjectRootChange: (root: string) => void;
  /** 切换工作空间（App 据此重拉过滤后的会话列表并更新新建落点） */
  onWorkspaceChange: (workspaceId: string) => void;
  /** 正在创建会话（按钮禁用防连点） */
  creating: boolean;
  /** 登出 */
  onLogout: () => void;
  /** Web 服务运行版本号（来自 /api/config；空串时不展示版本徽标） */
  version: string;
}

/** 取会话展示标题：后端契约为 title（string | null），null/空串时回退"未命名对话" */
function chatTitle(c: ChatSummary): string {
  if (typeof c.title === "string" && c.title !== "") return c.title;
  return "未命名对话";
}

/** 会话分组（web-personal-subworkspace T1）：label 即分组键（同名合并） */
interface ChatGroup {
  label: string;
  chats: ChatSummary[];
}

/**
 * 会话 projectRoot → 分组展示名：
 * 命中已配置工作空间 → 空间名；位于个人区内 → 相对路径（根 = "个人工作区"）；
 * 空串（个人模式缺省落点回填）→ "个人工作区"；其余 → 末段目录名。
 */
function workspaceLabel(root: string, personalRoot: string, workspaces: WorkspaceInfo[]): string {
  const r = root.replace(/\/+$/, "");
  if (r === "") return "个人工作区";
  for (const w of workspaces) {
    if (w.root.replace(/\/+$/, "") === r) return w.name;
  }
  const base = personalRoot.replace(/\/+$/, "");
  if (base !== "" && (r === base || r.startsWith(base + "/"))) {
    const rel = r === base ? "" : r.slice(base.length + 1);
    return rel === "" ? "个人工作区" : rel;
  }
  const seg = r.split("/").filter(Boolean).pop();
  return seg ?? r;
}

/** 按工作区分组：组内保持入参顺序（服务端已按 updateTime 降序），组间按组内最新会话时间降序 */
function groupChats(chats: ChatSummary[], personalRoot: string, workspaces: WorkspaceInfo[]): ChatGroup[] {
  const map = new Map<string, ChatSummary[]>();
  for (const c of chats) {
    const label = workspaceLabel(c.projectRoot, personalRoot, workspaces);
    const bucket = map.get(label);
    if (bucket === undefined) map.set(label, [c]);
    else bucket.push(c);
  }
  return [...map.entries()]
    .map(([label, group]) => ({ label, chats: group }))
    .sort((a, b) => (a.chats[0]?.updateTime ?? "").localeCompare(b.chats[0]?.updateTime ?? "") * -1);
}

/** 路径拼接（选择器内部用；dir 为空时基准为个人区根） */
function joinPath(dir: string, personalRoot: string, name: string): string {
  const base = (dir !== "" ? dir : personalRoot).replace(/\/+$/, "");
  return `${base}/${name}`;
}

/** 工作区文件夹选择器属性 */
interface FolderPickerProps {
  /** 个人区根（面包屑与缺省基准） */
  personalRoot: string;
  /** 创建中（新建会话防重入） */
  creating: boolean;
  /** 在所选文件夹新建（参数为空 = 个人区根） */
  onChoose: (folderRoot?: string) => void;
  /** 关闭面板 */
  onClose: () => void;
}

/**
 * 工作区文件夹选择器（personalOnly ➕ 面板）：
 * 浏览个人区子文件夹（仅目录项）、新建文件夹（POST /api/files/mkdir）、
 * 「在当前文件夹新建对话」落点为当前浏览目录（根目录时等价缺省落点）。
 */
function FolderPicker({ personalRoot, creating, onChoose, onClose }: FolderPickerProps) {
  /** 当前浏览目录（"" = 个人区根；加载后为服务端归一绝对路径） */
  const [dir, setDir] = useState("");
  /** 当前目录下的子目录条目 */
  const [dirs, setDirs] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /** 新建文件夹名输入 */
  const [newName, setNewName] = useState("");

  const loadDir = useCallback(async (target: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await listFiles(target, "personal");
      setDir(res.path);
      setDirs(res.entries.filter((e) => e.type === "dir"));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "目录加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  // 面板打开即加载个人区根
  useEffect(() => {
    void loadDir("");
  }, [loadDir]);

  const createFolder = async (): Promise<void> => {
    const name = newName.trim();
    if (name === "") return;
    try {
      await mkdir(joinPath(dir, personalRoot, name), "personal");
      setNewName("");
      await loadDir(dir);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "目录创建失败");
    }
  };

  /** 当前目录相对个人区的展示路径（面包屑） */
  const rel =
    personalRoot !== "" && dir.startsWith(personalRoot.replace(/\/+$/, "") + "/")
      ? dir.slice(personalRoot.replace(/\/+$/, "").length + 1)
      : "";

  return (
    <div className="folder-picker" role="dialog" aria-label="选择工作区文件夹">
      <div className="folder-picker-head">
        <span className="folder-picker-crumb" title={dir !== "" ? dir : personalRoot}>
          个人工作区{rel !== "" ? ` / ${rel}` : ""}
        </span>
        <span className="folder-picker-head-spacer" />
        {dir !== "" && (
          <button
            type="button"
            className="icon-btn"
            title="返回上一级"
            onClick={() => void loadDir(dir.slice(0, dir.lastIndexOf("/")) || "")}
          >
            <BackIcon size={13} />
          </button>
        )}
        <button type="button" className="icon-btn" title="刷新" onClick={() => void loadDir(dir)}>
          <RefreshIcon size={13} />
        </button>
        <button type="button" className="icon-btn" title="关闭" onClick={onClose}>
          <CloseIcon size={13} />
        </button>
      </div>

      {error !== "" && <div className="folder-picker-error">{error}</div>}

      <div className="folder-picker-list">
        {loading && <div className="folder-picker-empty">加载中…</div>}
        {!loading && dirs.length === 0 && <div className="folder-picker-empty">暂无子文件夹</div>}
        {dirs.map((d) => (
          <button
            key={d.name}
            type="button"
            className="folder-picker-item"
            title={d.name}
            onDoubleClick={() => void loadDir(joinPath(dir, personalRoot, d.name))}
            onClick={() => void loadDir(joinPath(dir, personalRoot, d.name))}
          >
            <FolderOpenIcon size={14} />
            <span>{d.name}</span>
          </button>
        ))}
      </div>

      <div className="folder-picker-new">
        <input
          className="folder-picker-input"
          placeholder="新建文件夹名称"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void createFolder();
          }}
        />
        <button
          type="button"
          className="cfg-btn cfg-btn-ghost"
          disabled={newName.trim() === ""}
          onClick={() => void createFolder()}
        >
          创建
        </button>
      </div>

      <div className="folder-picker-actions">
        <button
          type="button"
          className="folder-picker-choose"
          disabled={creating}
          onClick={() => onChoose(dir === "" ? undefined : dir)}
        >
          <PlusIcon size={13} />
          {dir === "" ? "在个人工作区根新建对话" : "在此文件夹新建对话"}
        </button>
      </div>
    </div>
  );
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
    workspaces,
    workspaceId,
    personalOnly,
    personalRoot,
    onToggleCollapsed,
    onSelectChat,
    onNewChat,
    onProjectRootChange,
    onWorkspaceChange,
    creating,
    onLogout,
    version,
  } = props;

  /** personalOnly ➕ 面板开关 */
  const [pickerOpen, setPickerOpen] = useState(false);

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

  const groups = groupChats(chats, personalRoot, workspaces);

  /** ➕ 点击：personal 弹出文件夹选择器；其余模式直接新建 */
  const handleNewChatClick = (): void => {
    if (personalOnly) {
      setPickerOpen((v) => !v);
    } else {
      onNewChat();
    }
  };

  /** 选择器内确定落点：建会话并收起面板 */
  const handleChoose = (folderRoot?: string): void => {
    setPickerOpen(false);
    onNewChat(folderRoot);
  };

  return (
    <aside className="sidebar">
      {/* 顶部：折叠按钮 + 新建对话 */}
      <div className="sidebar-top">
        <button type="button" className="icon-btn" title="折叠侧栏" onClick={onToggleCollapsed}>
          <PanelLeftIcon size={17} />
        </button>
      </div>

      <div className="sidebar-new">
        <button type="button" className="new-chat-btn" onClick={handleNewChatClick} disabled={creating}>
          <PlusIcon size={15} />
          新建对话
        </button>
        {/* 工作区文件夹选择器（web-personal-subworkspace T1）：personalOnly 模式下展开 */}
        {pickerOpen && (
          <FolderPicker
            personalRoot={personalRoot}
            creating={creating}
            onChoose={handleChoose}
            onClose={() => setPickerOpen(false)}
          />
        )}
        {/* 工作空间切换器（ARCH-20261027 T05）：服务端配置了可用空间时取代项目根选择——
            选中空间即新建落点，列表按空间过滤（App 经 ?workspaceId= 拉取） */}
        {workspaces.length > 0 && (
          <WorkspaceSwitcher workspaces={workspaces} value={workspaceId} onChange={onWorkspaceChange} />
        )}
        {/* 项目根选择（未配置工作空间的部署回退）：allowRoots 多于一个时展示（新建会话将落在该目录） */}
        {workspaces.length === 0 && allowRoots.length > 1 && (
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
        {workspaces.length === 0 && allowRoots.length === 0 && (
          <div className="project-root-empty" title="新建对话前需要先配置允许访问的项目目录">
            未配置项目根目录：请在 ~/.deepcode/settings.json 的 web.allowRoots 中添加目录后重启服务
          </div>
        )}
      </div>

      {/* 历史会话列表（P0-1：主键为 chatId；按工作区分组，状态点对齐引擎 SessionStatus） */}
      <nav className="chat-list" aria-label="历史会话">
        {chats.length === 0 && <div className="chat-list-empty">暂无历史会话</div>}
        {groups.map((g) => (
          <div key={g.label} className="chat-group">
            <div className="chat-group-head" title={g.label}>
              <FolderIcon size={12} />
              <span className="chat-group-name">{g.label}</span>
              <span className="chat-group-count">{g.chats.length}</span>
            </div>
            {g.chats.map((c) => (
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
                {/* T7 状态语义：interrupted = 中止类终态（显式中断/服务关停），
                    与 failed（引擎真实错误）区分展示；徽标样式复用状态点并灰化 */}
                {c.status === "interrupted" && (
                  <span className="chat-item-dot chat-item-dot-interrupted" title="已中断" />
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>

      {/* 底部用户区：默认头像 + 显示名直显 + 版本号 + 登出 */}
      <div className="sidebar-user">
        <UserAvatarIcon size={22} className="sidebar-user-avatar" />
        <span className="sidebar-user-name" title={user?.mail ?? user?.username ?? ""}>
          {user?.displayName !== "" && user?.displayName !== undefined ? user.displayName : (user?.username ?? "")}
        </span>
        {/* 版本号徽标：来自 /api.config 的 version（后端 package.json），空串（旧后端）时隐藏 */}
        {version !== "" && (
          <span className="sidebar-version" title="DeepCodeX Web 版本">
            v{version}
          </span>
        )}
        <button type="button" className="icon-btn" title="退出登录" onClick={onLogout}>
          <LogoutIcon size={16} />
        </button>
      </div>
    </aside>
  );
}
