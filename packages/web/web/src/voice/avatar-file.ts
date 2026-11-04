/**
 * 头像文件读取与校验
 *
 * ## 为什么前端就要卡体积
 *
 * 头像以 dataUrl 存在 `soul/config.json` 里（明文 JSON，0600）。
 * 一张 5MB 的手机照片转 dataUrl 后是 6.7MB——每次读写配置都要序列化这一坨，
 * 面板会明显卡顿，还可能撑爆后端的长度校验。所以在选文件时就挡住。
 *
 * 压缩不做：浏览器侧缩放要写 canvas 缩放 + 编码，收益不如「让用户自己选一张小图」
 * 直接。这里只做**校验 + 明确告知**，超限给可执行提示。
 *
 * @module web/voice/avatar-file
 */

/** 头像体积上限（字节；256px PNG 约 10KB，给到 300KB 足够放一张大图缩略） */
export const AVATAR_MAX_BYTES = 300 * 1024;

/** 允许的 MIME */
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * 读取头像文件为 dataUrl
 *
 * @param file 用户选择的文件
 * @returns dataUrl
 * @throws 类型不支持或体积超限
 */
export function readAvatarFile(file: File): Promise<string> {
  if (!ALLOWED_TYPES.has(file.type)) {
    return Promise.reject(new Error(`不支持的图片格式：${file.type || "未知"}（支持 PNG / JPEG / WebP）`));
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return Promise.reject(
      new Error(`图片过大（${Math.round(file.size / 1024)}KB），上限 ${Math.round(AVATAR_MAX_BYTES / 1024)}KB`)
    );
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new Error("读取图片失败"));
    };
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}
