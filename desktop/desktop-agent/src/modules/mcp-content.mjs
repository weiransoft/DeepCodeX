/**
 * 工具结果 → MCP content blocks（图像块透传，方案 §3.12）。
 *
 * 为什么需要这一层：MCP 的 `tools/call` 结果可以是一个**内容块数组**，
 * 其中 `{type:"image", data, mimeType}` 会被客户端转成模型的多模态输入。
 * 之前 sidecar 一律把结果 `JSON.stringify` 进单个 text 块——基座模型能读数字，
 * 但看不到像素，「模型看图 → 给坐标」这条链在协议层就断了。
 *
 * 三条硬规则：
 * 1. **base64 不进 text 块**：同一张图既写文本又写图像块，等于把 token 花两遍，
 *    而且几十万字符的 base64 会挤爆上下文。文本块只留元数据（尺寸/字节/是否附带）。
 * 2. **白名单 + 上限**：只认 png/jpeg/webp，超过上限（默认 8M base64 字符 ≈ 6 MB）
 *    就降级为纯文本并**显式标注** `dropped`——让模型知道「这次没给你像素」，
 *    而不是让它以为图上什么都没有。
 * 3. **失败结果不带图**：`ok:false` 的载荷即便误带了 base64 也一律丢弃。
 */

/** MCP 图像块允许的 mime 白名单（主流多模态接口都支持这三种） */
export const ALLOWED_IMAGE_MIME = Object.freeze(["image/png", "image/jpeg", "image/webp"]);

/** base64 字符数上限（≈ 6 MiB 解码后）。超过即降级为文本并标注，不静默截断 */
export const MAX_IMAGE_BASE64_CHARS = 8 * 1024 * 1024;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** base64 字符数 → 解码后字节数（不做真正的解码，避免大图双份内存） */
export function base64Bytes(value) {
  if (typeof value !== "string" || value.length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

/**
 * 把工具返回值拆成「文本载荷 + 可选图像块」。
 * 纯函数，不做 IO；返回结构直接可放进 JSON-RPC 帧。
 *
 * @returns {{ text: string, image: {type:"image",data:string,mimeType:string}|null, dropped: object|null }}
 */
export function splitImagePayload(payload, { maxBase64Chars = MAX_IMAGE_BASE64_CHARS } = {}) {
  const isRecord = payload !== null && typeof payload === "object" && !Array.isArray(payload);
  if (!isRecord) {
    return { text: JSON.stringify(payload ?? null), image: null, dropped: null };
  }

  const { base64, ...rest } = payload;
  const mimeType = typeof payload.mimeType === "string" ? payload.mimeType.toLowerCase() : "";
  let image = null;
  let dropped = null;

  if (typeof base64 === "string" && base64.length > 0 && payload.ok !== false) {
    if (!ALLOWED_IMAGE_MIME.includes(mimeType)) {
      dropped = { reason: "unsupported-mime", mimeType: mimeType || null };
    } else if (base64.length > maxBase64Chars) {
      dropped = { reason: "too-large", base64Chars: base64.length, limit: maxBase64Chars };
    } else if (base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64)) {
      dropped = { reason: "invalid-base64", base64Chars: base64.length };
    } else {
      image = { type: "image", data: base64, mimeType };
    }
  }

  const text = { ...rest };
  if (image) {
    // 只回元数据：模型据此判断图有多大、坐标该怎么换算
    text.image = { mimeType, bytes: base64Bytes(base64), attached: true };
  } else if (dropped) {
    text.image = { ...dropped, attached: false };
  }

  return { text: JSON.stringify(text), image, dropped };
}

/**
 * 工具返回值 → MCP `tools/call` 的 content 数组 + isError。
 * 文本块恒存在（客户端/模型对「只有图没有字」的结果兼容性差）。
 */
export function toMcpContent(payload, options = {}) {
  const { text, image, dropped } = splitImagePayload(payload, options);
  const content = [{ type: "text", text }];
  if (image) content.push(image);
  return {
    content,
    isError: payload?.ok === false,
    imageAttached: Boolean(image),
    dropped,
  };
}
