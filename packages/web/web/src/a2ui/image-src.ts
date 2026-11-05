/**
 * 图片地址归一：把「本地文件路径」翻译成可渲染的站内地址
 *
 * ## 为什么需要这一层
 *
 * 助手生成图片后，回复里给的是**磁盘路径**（`/Users/x/out.png`、`chart.svg`）。
 * `<img src>` 拿这种路径什么也画不出来——浏览器会当成相对 URL 去服务端找，
 * 而服务端静态目录里没有这个文件。于是用户看到的只有一行路径文字，
 * 明明图就在机器上，对话里却看不见。
 *
 * 这里把本地路径改写成 `/api/files/raw?path=...`：真正的读取、牢笼校验、
 * 类型白名单都在服务端（见 `files-api.ts` 的 `handleInlineFile`）。
 * 前端只做字符串翻译，**不做任何文件访问**，因此不存在路径穿越面。
 *
 * ## 什么样的地址要翻译
 *
 * - 已经是网络地址（http/https）、内嵌数据（data:）、对象地址（blob:）：不动
 * - 已经是站内接口（`/api/...`）：不动，避免二次包装
 * - 锚点（`#...`）：不动
 * - 其余且扩展名是图片：视为本地文件
 *
 * 扩展名必须命中图片白名单，是为了避免把 `README.md` 这种正文链接
 * 也伪装成图片去请求服务端（服务端会 415，但没必要发出这个请求）。
 *
 * @module web/a2ui/image-src
 */

/** 本地图片路径的扩展名白名单（与后端 INLINE_IMAGE_TYPES 保持一致） */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i;

/** 已经自带协议、不该改写的地址 */
const ABSOLUTE_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * 判断一个图片地址是否指向本地文件
 *
 * @param url 原始地址
 * @returns 需要走 `/api/files/raw` 时返回 true
 */
export function isLocalImagePath(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return false;
  if (ABSOLUTE_SCHEME.test(trimmed)) return false;
  // 站内接口地址（含本函数自己产出的）不再包装
  if (trimmed.startsWith("/api/")) return false;
  // 查询串/锚点不参与扩展名判定：`a.png?raw=1` 仍是图片
  const pathPart = trimmed.split(/[?#]/)[0] ?? "";
  return IMAGE_EXT.test(pathPart);
}

/**
 * 把本地图片路径翻译成内联读取地址
 *
 * @param url 本地路径（绝对路径、`./` / `../` 相对路径、或裸文件名）
 * @param scope `shared`（白名单根）或 `personal`（个人区）
 * @returns `/api/files/raw?...` 形式的地址
 */
export function localImageSrc(url: string, scope: "shared" | "personal" = "shared"): string {
  return `/api/files/raw?scope=${scope}&path=${encodeURIComponent(url.trim())}`;
}

/**
 * 归一图片地址（本地路径 → 内联地址，其余原样返回）
 *
 * @param url 原始地址
 * @param scope 作用域
 * @returns 可直接交给 `<img src>` 的地址
 */
export function resolveImageSrc(url: string, scope: "shared" | "personal" = "shared"): string {
  return isLocalImagePath(url) ? localImageSrc(url, scope) : url;
}
