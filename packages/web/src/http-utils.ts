/**
 * HTTP 通用工具（docs/dev/web-ui.md §3.5）。
 *
 * 提供 JSON 响应写出、请求体读取（带大小上限）与统一 API 错误类型，
 * 供 server.ts 路由分发与各 api 模块复用。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** JSON 请求体统一大小上限：1MB（docs/dev/web-ui.md §3.5） */
export const JSON_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * 统一 API 错误：携带 HTTP 状态码，由 server.ts 顶层 catch 映射为 JSON 错误响应。
 */
export class ApiError extends Error {
  /** HTTP 状态码 */
  readonly status: number;

  /**
   * @param status HTTP 状态码（400/401/403/404/413/500 等）
   * @param message 对外错误文案（中文）
   */
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * 以 JSON 形式写出响应并结束。
 *
 * @param res Node 响应对象
 * @param status HTTP 状态码
 * @param data 序列化为 JSON 的响应体
 */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    // 防 MIME 嗅探（docs/dev/web-ui.md §3.6 安全设计）
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

/**
 * 读取请求体原始字节（带大小上限）。
 *
 * 超过上限时销毁请求连接并抛出 ApiError(413)，防止内存被恶意大请求耗尽。
 *
 * @param req Node 请求对象
 * @param limitBytes 字节上限
 * @returns 完整请求体
 * @throws ApiError 413 当请求体超过上限
 */
export async function readRawBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > limitBytes) {
      // 立即销毁连接，停止继续接收数据
      req.destroy();
      throw new ApiError(413, `请求体超过大小上限（${limitBytes} 字节）`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * 读取并解析 JSON 请求体。
 *
 * @param req Node 请求对象
 * @param limitBytes 字节上限（默认 1MB）
 * @returns 解析后的对象
 * @throws ApiError 400 当 body 不是合法 JSON 或不是对象
 * @throws ApiError 413 当 body 超过上限
 */
export async function readJsonBody<T = Record<string, unknown>>(
  req: IncomingMessage,
  limitBytes: number = JSON_BODY_LIMIT_BYTES
): Promise<T> {
  const raw = await readRawBody(req, limitBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ApiError(400, "请求体不是合法 JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "请求体必须是 JSON 对象");
  }
  return parsed as T;
}
