/**
 * 工作空间切换器（ARCH-20261027 T05，PRD §5.1）：
 * 侧栏顶部的空间下拉——选中后历史会话列表仅显示该空间的会话，
 * 新建对话默认落在当前选中空间。
 *
 * 数据源为 GET /api/workspaces（personalOnly 模式首项恒为本人个人区）；
 * 仅在服务端配置了可用空间（列表非空）时由 SessionSidebar 渲染，
 * 未配置工作空间的旧部署保持原「项目根选择」行为零回归。
 */
import type { WorkspaceInfo } from "../api";
import { FolderIcon } from "./icons";

/** WorkspaceSwitcher 组件属性 */
export interface WorkspaceSwitcherProps {
  /** 可用空间列表（GET /api/workspaces 响应） */
  workspaces: WorkspaceInfo[];
  /** 当前选中的空间 id */
  value: string;
  /** 切换空间（App 据此重新拉取过滤后的会话列表） */
  onChange: (workspaceId: string) => void;
}

/** WorkspaceSwitcher：侧栏顶部空间下拉 */
export function WorkspaceSwitcher(props: WorkspaceSwitcherProps) {
  const { workspaces, value, onChange } = props;
  return (
    <label className="workspace-switcher">
      <FolderIcon size={14} className="workspace-switcher-icon" />
      <select
        className="workspace-switcher-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title="工作空间：切换后历史会话列表与新对话落点随之切换"
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </label>
  );
}
