/**
 * 请求认证中间件（docs/dev/web-ui.md §3.4 / §3.6）。
 *
 * 认证方式：HttpOnly + SameSite=Strict + Path=/ 的 Cookie `deepcode_web_token`
 * 携带 HS256 JWT；除 /api/auth/login 与静态资源外全部端点要求有效 JWT。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyJWT } from "./jwt";
import type { JwtPayload } from "../types";

/** 认证 Cookie 名称（前端/文档约定的固定值） */
export const AUTH_COOKIE_NAME = "deepcode_web_token";

/**
 * 解析请求 Cookie 头为键值对。
 *
 * 按 RFC 6265 的简化实现：以 ";" 分段、"=" 分键值、两侧去空白、值做 URI 解码。
 *
 * @param req Node 请求对象
 * @returns Cookie 键值映射（无 Cookie 头时为空对象）
 */
export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const segment of header.split(";")) {
    const eqIndex = segment.indexOf("=");
    if (eqIndex < 0) {
      continue;
    }
    const key = segment.slice(0, eqIndex).trim();
    const value = segment.slice(eqIndex + 1).trim();
    if (key === "") {
      continue;
    }
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      // 值不是合法 URI 编码时按原值使用
      cookies[key] = value;
    }
  }
  return cookies;
}

/**
 * 从请求中提取并校验认证 JWT。
 *
 * 读取 Cookie `deepcode_web_token` 并 verifyJWT 校验（签名 + exp），
 * 失败一律返回 null，由调用方统一 401（不泄露具体失败原因）。
 *
 * @param req Node 请求对象
 * @param jwtSecret JWT 共享密钥
 * @returns 校验通过返回载荷；失败返回 null
 */
export function authenticateRequest(req: IncomingMessage, jwtSecret: string): JwtPayload | null {
  const token = parseCookies(req)[AUTH_COOKIE_NAME];
  if (!token) {
    return null;
  }
  return verifyJWT(token, jwtSecret);
}

/**
 * 构造认证 Set-Cookie 值。
 *
 * 属性：HttpOnly（防 XSS 读取）+ SameSite=Strict（防 CSRF）+ Path=/；Max-Age 与 JWT TTL 对齐。
 *
 * @param token 已签发的 JWT
 * @param maxAgeSeconds Cookie 有效期（秒，通常等于 sessionTtlSeconds）
 * @returns Set-Cookie 头的值
 */
export function buildAuthCookie(token: string, maxAgeSeconds: number): string {
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeSeconds)}`;
}

/**
 * 构造清除认证 Cookie 的 Set-Cookie 值（登出用）。
 *
 * @returns Max-Age=0 的 Set-Cookie 头值
 */
export function buildClearAuthCookie(): string {
  return `${AUTH_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * 向响应写入 Set-Cookie（认证成功/登出时使用）。
 *
 * @param res Node 响应对象
 * @param cookieValue Set-Cookie 头值
 */
export function setAuthCookie(res: ServerResponse, cookieValue: string): void {
  const previous = res.getHeader("Set-Cookie");
  // 保留可能已存在的其他 Cookie（追加而非覆盖）
  if (previous === undefined) {
    res.setHeader("Set-Cookie", cookieValue);
  } else if (Array.isArray(previous)) {
    res.setHeader("Set-Cookie", [...previous, cookieValue]);
  } else {
    res.setHeader("Set-Cookie", [String(previous), cookieValue]);
  }
}
