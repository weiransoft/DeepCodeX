/**
 * HS256 JWT 签发与校验（docs/dev/web-ui.md §3.4）。
 *
 * 使用 node:crypto 的 HMAC-SHA256 自实现，无外部依赖；
 * 格式为标准的 header.payload.signature 三段 base64url。
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { JwtPayload } from "../types";

/** JWT header 固定值：HS256 算法（本模块只签发/校验 HS256） */
const JWT_HEADER_B64 = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));

/**
 * 将任意 UTF-8 字符串编码为 base64url（RFC 4648 §5，无填充）。
 *
 * @param value 原始字符串
 * @returns base64url 编码结果
 */
function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * 将 base64url 字符串解码为 UTF-8 字符串。
 *
 * @param value base64url 编码字符串
 * @returns 解码后的字符串（非法输入返回空串）
 */
function base64UrlDecode(value: string): string {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * 计算指定数据的 HMAC-SHA256 签名（base64url 形式）。
 *
 * @param data 待签名数据（header.payload）
 * @param secret 共享密钥
 * @returns base64url 签名
 */
function hmacSign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * 签发 JWT（HS256）。
 *
 * 载荷字段由调用方给定（sub/displayName/mail/dn/authSource），
 * iat 取当前时间，exp = iat + ttlSeconds。
 *
 * @param payload 业务载荷（不含 iat/exp，由本函数补全）
 * @param secret 共享密钥
 * @param ttlSeconds 有效期（秒）
 * @returns 序列化后的 JWT 字符串
 */
export function signJWT(payload: Omit<JwtPayload, "iat" | "exp">, secret: string, ttlSeconds: number): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = { ...payload, iat: issuedAt, exp: issuedAt + Math.floor(ttlSeconds) };
  const body = `${JWT_HEADER_B64}.${base64UrlEncode(JSON.stringify(fullPayload))}`;
  return `${body}.${hmacSign(body, secret)}`;
}

/**
 * 校验并解析 JWT。
 *
 * 校验内容：
 * 1. 三段式结构合法；
 * 2. header.algorithm === "HS256"（防算法替换攻击）；
 * 3. 签名与 HMAC-SHA256 结果一致（timingSafeEqual 防时序侧信道）；
 * 4. exp 未过期。
 *
 * 任何一种失败（过期/篡改/错密钥/格式错误）统一返回 null，不抛异常，
 * 供中间件直接映射 401，同时避免向调用方泄露具体失败原因。
 *
 * @param token 待校验的 JWT 字符串
 * @param secret 共享密钥
 * @returns 校验通过返回载荷；失败返回 null
 */
export function verifyJWT(token: string, secret: string): JwtPayload | null {
  // 结构校验：必须恰好三段
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  // header 校验：仅接受 HS256，拒绝 none/其他算法
  let header: { alg?: string } | null = null;
  try {
    header = JSON.parse(base64UrlDecode(headerB64)) as { alg?: string };
  } catch {
    return null;
  }
  if (!header || header.alg !== "HS256") {
    return null;
  }

  // 签名校验：常量时间比较，防篡改与错密钥
  const body = `${headerB64}.${payloadB64}`;
  const expected = Buffer.from(hmacSign(body, secret));
  const actual = Buffer.from(signatureB64);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  // 载荷解析
  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64)) as JwtPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.sub !== "string" || typeof payload.exp !== "number") {
    return null;
  }

  // 过期校验（exp 为秒级 Unix 时间戳）
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}
