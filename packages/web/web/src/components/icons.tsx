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

/** 重命名（铅笔） */
export function EditIcon(p: IconProps) {
  return (
    <IconBase {...p} label="重命名">
      <path
        d="M11.3 2.6a1.6 1.6 0 0 1 2.3 2.3L5.8 12.7l-3 1 1-3 7.5-8.1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

/** 删除（垃圾桶） */
export function TrashIcon(p: IconProps) {
  return (
    <IconBase {...p} label="删除">
      <path
        d="M2.5 4.5h11M6.5 2.5h3M4 4.5l.7 8.2a1.3 1.3 0 0 0 1.3 1.2h4a1.3 1.3 0 0 0 1.3-1.2l.7-8.2M6.7 7v4.2M9.3 7v4.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
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

/** 权限盾牌加号（本次会话总是允许） */
export function ShieldPlusIcon(p: IconProps) {
  return (
    <IconBase {...p} label="总是允许">
      <path
        d="M8 1.8 13 3.6v4c0 3.2-2.1 5.6-5 6.6-2.9-1-5-3.4-5-6.6v-4L8 1.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M8 5.6v4.4M5.8 7.8h4.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
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

/** 对话内搜索（放大镜）：工具栏入口与搜索栏前缀共用 */
export function SearchIcon(p: IconProps) {
  return (
    <IconBase {...p} label="搜索对话内容">
      <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.2 10.2 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </IconBase>
  );
}

/** 搜索命中上一条/下一条（上下箭头） */
export function ChevronIcon({ up = false, ...p }: IconProps & { up?: boolean }) {
  return (
    <IconBase {...p} label={up ? "上一个命中" : "下一个命中"}>
      <path
        d={up ? "M4 9.5 8 5.5l4 4" : "M4 6.5l4 4 4-4"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
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

/** 远程连接（显示器 + 插头）：活动栏「远程 SSH」入口 */
export function RemoteIcon(p: IconProps) {
  return (
    <IconBase {...p} label="远程连接">
      <rect x="1.8" y="2.5" width="12.4" height="8.4" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.5 13.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M8 10.9v2.6" stroke="currentColor" strokeWidth="1.2" />
      {/* 屏内 </> 提示远程会话 */}
      <path
        d="m5.6 5.2-1.6 1.5 1.6 1.5m4.8-3 1.6 1.5-1.6 1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

/** 设置（齿轮）：活动栏「系统管理」入口 */
export function GearIcon(p: IconProps) {
  return (
    <IconBase {...p} label="系统管理">
      {/* 经典齿轮轮廓（Lucide settings 同构，24→16 缩放）：
          齿圈 + 中心圆孔，与「太阳」（细长射线）明确区分 */}
      <g transform="scale(0.6667)" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </g>
    </IconBase>
  );
}

/** 引擎状态（心电脉搏线）：与「设置齿轮」明确区分，强调「状态面板」语义 */
export function EngineIcon(p: IconProps) {
  return (
    <IconBase {...p} label="引擎状态">
      <path
        d="M1.5 8h2.8l1.6-4 3 9.5L11 4l1.2 4h2.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

/** 太阳（主题切换：当前浅色，点击切深色） */
export function SunIcon(p: IconProps) {
  return (
    <IconBase {...p} label="浅色主题">
      <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </IconBase>
  );
}

/** 月亮（主题切换：当前深色，点击切浅色） */
export function MoonIcon(p: IconProps) {
  return (
    <IconBase {...p} label="深色主题">
      <path
        d="M13.2 9.6A5.8 5.8 0 0 1 6.4 2.8a5.8 5.8 0 1 0 6.8 6.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
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

/**
 * 应用 Logo（iOS 26 液态玻璃风格：渐变 squircle + 对话气泡 + 代码符号）。
 *
 * 与桌面端应用图标（desktop/src-tauri/icons，AI 生成同款设计）与
 * 服务端 /favicon.svg（server.ts 内置）三方同源：同一几何与配色语言。
 * 独立 viewBox（1024）+ 渐变填充，不随 currentColor 变化。
 */
export function AppLogo({ size = 16, className }: IconProps) {
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} className={className} role="img" aria-label="DeepCode">
      <defs>
        <linearGradient id="dc-app-logo-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2b4df0" />
          <stop offset="0.52" stopColor="#7b3ff2" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
        <linearGradient id="dc-app-logo-glass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.32" />
          <stop offset="0.45" stopColor="#ffffff" stopOpacity="0.04" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* squircle 底：蓝→紫→青对角渐变 */}
      <rect width="1024" height="1024" rx="230" fill="url(#dc-app-logo-grad)" />
      {/* 顶部玻璃高光层 */}
      <path d="M0 0h1024v340c-200 90-420 130-512 130S200 430 0 340Z" fill="url(#dc-app-logo-glass)" />
      {/* 对话气泡（白玻璃描边 + 小尾巴） */}
      <g fill="none" stroke="#ffffff" strokeWidth="46" strokeLinecap="round" strokeLinejoin="round" opacity="0.94">
        <rect x="176" y="236" width="672" height="486" rx="118" />
        <path d="M330 722l-26 118 128-108" />
      </g>
      {/* 代码符号 </> */}
      <g fill="none" stroke="#ffffff" strokeWidth="52" strokeLinecap="round" strokeLinejoin="round">
        <path d="M392 420l-96 100 96 100" />
        <path d="M632 420l96 100-96 100" />
        <path d="M562 372l-96 300" opacity="0.96" />
      </g>
    </svg>
  );
}
