/**
 * 用户身份上下文（docs/dev/web-isolation.md §3.2）。
 *
 * 职责：
 * 1. 定义 AuthContext：JWT 载荷 + 派生 userId（隔离维度的唯一主键）；
 * 2. userIdFromUsername：将任意（可能含特殊字符的 LDAP）用户名映射为
 *    固定长度 hex 目录安全标识（sha256 前 16 位），杜绝用户名注入路径。
 */

import { createHash } from "node:crypto";
import type { JwtPayload } from "./types";

/**
 * 认证上下文：server.ts 认证门禁构造一次，向下传递给全部业务 handler。
 *
 * 在 JwtPayload 基础上追加 userId（隔离目录名 / 注册表文件名的主键）。
 */
export type AuthContext = JwtPayload & {
  /** 用户隔离标识：sha256(username) hex 前 16 位（路径安全，见 userIdFromUsername） */
  userId: string;
};

/**
 * 由用户名派生路径安全的隔离标识。
 *
 * 设计要点：
 * - 固定输出 16 位 hex（0-9a-f），可安全用作目录名与文件名，天然防路径穿越
 *   （无论用户名含 `/`、`..`、控制字符还是超长字符串，输出空间不变）；
 * - 不可逆：目录名不泄露用户名明文；
 * - 大小写敏感：LDAP uid 语义保留（"Alice" 与 "alice" 为不同隔离域），
 *   若部署方需要大小写归一，应在 LDAP 搜索层完成（本模块不做隐性折叠）。
 *
 * @param username 登录用户名（JWT sub）
 * @returns 16 位 hex 字符串
 */
export function userIdFromUsername(username: string): string {
  return createHash("sha256").update(username, "utf8").digest("hex").slice(0, 16);
}

/**
 * 从 JWT 载荷构造完整认证上下文（server.ts 认证门禁专用）。
 *
 * @param payload 已验签的 JWT 载荷
 * @returns 附加 userId 的认证上下文
 */
export function buildAuthContext(payload: JwtPayload): AuthContext {
  return { ...payload, userId: userIdFromUsername(payload.sub) };
}
