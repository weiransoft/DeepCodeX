/**
 * 司南头像
 *
 * 默认是应用图标里的兔狲脸（`/manul-avatar.png`，由构建从
 * `web/public/` 拷进 `dist/`）；用户可在「设置 → 司南」里上传自定义图。
 *
 * ## 为什么不是内联 SVG
 *
 * 头像要和桌面图标**看起来是同一个人**。内联 SVG 只能靠手绘还原，
 * 而手绘的猫和图标里的猫一定不是同一只。这里直接用从图标裁出的
 * 同一张 PNG——零失真，代价是它固定为品牌蓝、不随主题变色（头像本就不该变色）。
 *
 * @module web/components/SoulAvatar
 */

import type { SoulAvatarConfig } from "../api";

/** 默认兔狲头像路径（构建产物根目录下的静态资产） */
export const DEFAULT_AVATAR_SRC = "/manul-avatar.png";

export interface SoulAvatarProps {
  /** 头像配置（缺省 → 默认兔狲） */
  avatar?: SoulAvatarConfig;
  /** 尺寸（px，默认 22 —— 对话气泡的视觉重心） */
  size?: number;
  /** 附加类名 */
  className?: string;
  /** 读屏用的名字（跟随用户设置；缺省「司南」） */
  name?: string;
}

/**
 * 渲染司南头像
 *
 * @param props 属性
 * @returns img 元素
 */
export function SoulAvatar({ avatar, size = 22, className, name = "司南" }: SoulAvatarProps) {
  const custom = avatar?.kind === "custom" && typeof avatar.dataUrl === "string" ? avatar.dataUrl : null;
  const src = custom ?? DEFAULT_AVATAR_SRC;
  const style = { width: `${size}px`, height: `${size}px` };
  return (
    <img
      className={`soul-avatar${className !== undefined ? ` ${className}` : ""}`}
      src={src}
      style={style}
      alt={name}
      // 头像是装饰性的：读屏读「名字」两个字就够，不需要描述图片
      role="img"
      draggable={false}
    />
  );
}
