/**
 * 内联 SVG 图标集（不引入图标库，满足"图标直显"的 UI 偏好）。
 *
 * 约定：
 * - 统一 16×16 viewBox、currentColor 描边/填充，随文字颜色与主题自适应；
 * - 每个图标均为独立函数组件，可传 size 覆盖默认尺寸。
 */
import type { ReactNode } from "react";

/** 图标通用属性 */
interface IconProps {
  /** 尺寸（px，默认 16） */
  size?: number;
  /** 附加类名 */
  className?: string;
}

/** 图标基础包装：统一 svg 属性（children 为任意 SVG 子元素集合） */
function IconBase({ size = 16, className, children, label }: IconProps & { children: ReactNode; label: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={label}
      aria-hidden={label === "" ? true : undefined}
    >
      {children}
    </svg>
  );
}

/** 新建对话（加号） */
export function PlusIcon(p: IconProps) {
  return (
    <IconBase {...p} label="新建对话">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </IconBase>
  );
}

/** 对话气泡 */
export function ChatIcon(p: IconProps) {
  return (
    <IconBase {...p} label="对话">
      <path
        d="M13.5 8A5.5 5.5 0 1 1 8 2.5 5.5 5.5 0 0 1 13.5 8Zm-1.2 4.3 1.7 1.7-2.8-.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

/** 折叠侧栏 */
export function PanelLeftIcon(p: IconProps) {
  return (
    <IconBase {...p} label="折叠侧栏">
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
    </IconBase>
  );
}

/** 发送（纸飞机） */
export function SendIcon(p: IconProps) {
  return (
    <IconBase {...p} label="发送">
      <path
        d="M2.5 8 13.5 2.8 11.4 13.2 8 9.6 2.5 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <line x1="8" y1="9.6" x2="11.4" y2="3.2" stroke="currentColor" strokeWidth="1.3" />
    </IconBase>
  );
}

/** 停止（方块） */
export function StopIcon(p: IconProps) {
  return (
    <IconBase {...p} label="停止生成">
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </IconBase>
  );
}

/** 附件（回形针） */
export function PaperclipIcon(p: IconProps) {
  return (
    <IconBase {...p} label="附件">
      <path
        d="M10.8 4.2 5.4 9.6a1.9 1.9 0 0 0 2.7 2.7l5.1-5.1a3.2 3.2 0 0 0-4.6-4.6L3.5 7.7a4.5 4.5 0 0 0 6.4 6.4l3.4-3.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </IconBase>
  );
}

/** 文件（普通文件） */
export function FileIcon(p: IconProps) {
  return (
    <IconBase {...p} label="文件">
      <path d="M4 1.8h5l3 3v9.4H4V1.8Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9 1.8v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </IconBase>
  );
}

/** 代码文件（</> 角标） */
export function FileCodeIcon(p: IconProps) {
  return (
    <IconBase {...p} label="代码文件">
      <path d="M4 1.8h5l3 3v9.4H4V1.8Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9 1.8v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path
        d="m6.4 8.4-1.3 1.3 1.3 1.3m3.2-2.6 1.3 1.3-1.3 1.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

/** 图片文件 */
export function FileImageIcon(p: IconProps) {
  return (
    <IconBase {...p} label="图片">
      <rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="5.6" cy="6.4" r="1.1" fill="currentColor" />
      <path
        d="m3.5 11.5 3-3 2.2 2.2 2-2 1.8 2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

/** 文件夹 */
export function FolderIcon(p: IconProps) {
  return (
    <IconBase {...p} label="文件夹">
      <path
        d="M1.8 4.2A1.2 1.2 0 0 1 3 3h3.2l1.4 1.8H13a1.2 1.2 0 0 1 1.2 1.2v6A1.2 1.2 0 0 1 13 13.2H3a1.2 1.2 0 0 1-1.2-1.2V4.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

/** 下载 */
export function DownloadIcon(p: IconProps) {
  return (
    <IconBase {...p} label="下载">
      <path
        d="M8 2.5v7m0 0L5.2 6.7M8 9.5l2.8-2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.8 12.2v.8a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </IconBase>
  );
}

/** 上传 */
export function UploadIcon(p: IconProps) {
  return (
    <IconBase {...p} label="上传">
      <path
        d="M8 9.5v-7m0 0L5.2 5.3M8 2.5l2.8 2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.8 12.2v.8a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </IconBase>
  );
}

/** 关闭（×） */
export function CloseIcon(p: IconProps) {
  return (
    <IconBase {...p} label="关闭">
      <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </IconBase>
  );
}

/** 预览（放大镜）：文件抽屉文本/图片预览入口（docs/dev/web-file-preview.md P2） */
export function PreviewIcon(p: IconProps) {
  return (
    <IconBase {...p} label="预览">
      <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="m10.2 10.2 3.3 3.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </IconBase>
  );
}

/** 返回（左箭头）：预览态返回列表 */
export function BackIcon(p: IconProps) {
  return (
    <IconBase {...p} label="返回">
      <path
        d="M9.5 3.5 5 8l4.5 4.5M5.5 8h7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

/** 作为附件插入（引用箭头） */
export function InsertIcon(p: IconProps) {
  return (
    <IconBase {...p} label="作为附件插入对话">
      <path
        d="M3 8h9m0 0L9 5m3 3-3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M3 3.5v9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </IconBase>
  );
}

/** 权限盾牌（允许） */
export function ShieldCheckIcon(p: IconProps) {
  return (
    <IconBase {...p} label="允许">
      <path
        d="M8 1.8 13 3.6v4c0 3.2-2.1 5.6-5 6.6-2.9-1-5-3.4-5-6.6v-4L8 1.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="m5.7 7.9 1.6 1.6 3-3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

/** 禁止（拒绝） */
export function BanIcon(p: IconProps) {
  return (
    <IconBase {...p} label="拒绝">
      <circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <line x1="4.2" y1="4.2" x2="11.8" y2="11.8" stroke="currentColor" strokeWidth="1.3" />
    </IconBase>
  );
}

/** 工具（扳手） */
export function WrenchIcon(p: IconProps) {
  return (
    <IconBase {...p} label="工具执行">
      <path
        d="M9.8 3.2a3 3 0 0 1 3.9 3.9l-6 6a1.6 1.6 0 0 1-2.3 0l-1.6-1.6a1.6 1.6 0 0 1 0-2.3l6-6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="10.9" cy="5.1" r="1" fill="currentColor" />
    </IconBase>
  );
}

/** 刷新 */
export function RefreshIcon(p: IconProps) {
  return (
    <IconBase {...p} label="刷新">
      <path
        d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.6h-2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

/** 登出 */
export function LogoutIcon(p: IconProps) {
  return (
    <IconBase {...p} label="退出登录">
      <path
        d="M6 2.8H4a1.2 1.2 0 0 0-1.2 1.2v8A1.2 1.2 0 0 0 4 13.2h2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M10 5l3 3-3 3m3-3H6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

/** 展开更多（面板图标） */
export function FolderOpenIcon(p: IconProps) {
  return (
    <IconBase {...p} label="文件目录">
      <path
        d="M1.8 4.2A1.2 1.2 0 0 1 3 3h3.2l1.4 1.8H13a1.2 1.2 0 0 1 1.2 1.2V7H4.4L2.6 12.6a1.2 1.2 0 0 1-.8-1.1V4.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M4.6 7h10l-1.8 5.4a1.2 1.2 0 0 1-1.1.8H3.4a1.2 1.2 0 0 1-1.1-1.6L4.6 7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

/** 默认机器头像（DeepCodeX 引擎/助手消息）：圆形底内机器人脸 */
export function BotAvatarIcon(p: IconProps) {
  return (
    <IconBase {...p} label="DeepCodeX 助手">
      {/* 机器人头部圆角矩形 + 天线 */}
      <rect x="3.2" y="5" width="9.6" height="7" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <line x1="8" y1="2.6" x2="8" y2="5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="2.4" r="0.9" fill="currentColor" />
      {/* 双眼与嘴 */}
      <circle cx="6" cy="8" r="0.9" fill="currentColor" />
      <circle cx="10" cy="8" r="0.9" fill="currentColor" />
      <path d="M6.2 10.2h3.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </IconBase>
  );
}

/** 默认用户头像（登录用户/用户消息）：圆形底内人形剪影 */
export function UserAvatarIcon(p: IconProps) {
  return (
    <IconBase {...p} label="用户">
      {/* 头部圆 + 肩部弧（经典人形剪影） */}
      <circle cx="8" cy="5.6" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M3.4 13.4a4.6 4.6 0 0 1 9.2 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </IconBase>
  );
}
