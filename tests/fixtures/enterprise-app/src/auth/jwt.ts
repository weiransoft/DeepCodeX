/**
 * JWT 认证模块
 * 提供 token 签发、验证和中间件功能
 */

import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { AuthenticationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// JWT 配置 (仅用于测试 fixture)
const JWT_SECRET = "test-secret-key";
const JWT_EXPIRES_IN = 3600; // 1 小时

// 测试用户凭证
const VALID_USERNAME = "admin";
const VALID_PASSWORD = "admin123";

/**
 * 签发 JWT token
 * @param payload token 载荷
 */
export function signToken(payload: { username: string }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * 验证 JWT token
 * @param token JWT 字符串
 * @throws AuthenticationError 验证失败时抛出
 */
export function verifyToken(token: string): { username: string; iat: number } {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { username: string; iat: number };
    return decoded;
  } catch {
    // jwt.verify 抛出的任何异常（过期/签名错误/格式错误）统一转为 AuthenticationError
    throw new AuthenticationError("Invalid or expired token");
  }
}

/**
 * 带认证用户信息的 Request（authMiddleware 验证通过后附加 user 字段）
 *
 * Express 标准扩展模式：中间件向下游 handler 传递认证上下文
 */
interface AuthenticatedRequest extends Request {
  /** JWT 验证通过后附加的用户载荷 */
  user?: { username: string; iat: number };
}

/**
 * Express 中间件: 验证 JWT token
 * 从 Authorization 头提取 Bearer token 并验证
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  try {
    // 提取 Authorization 头
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      throw new AuthenticationError("No authorization header");
    }

    // 解析 Bearer token
    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      throw new AuthenticationError("Invalid authorization header format");
    }

    const token = parts[1];
    const payload = verifyToken(token);

    // 将用户信息附加到 request 对象（类型化扩展，替代 any 断言）
    (req as AuthenticatedRequest).user = payload;

    logger.debug(`Authenticated user: ${payload.username}`);
    next();
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
    } else {
      res.status(401).json({ error: "Authentication failed" });
    }
  }
}

/**
 * 登录处理函数
 * POST /api/auth/login
 *
 * v2.1.3 E2E 修复：增加参数缺失校验，返回 400 Bad Request
 * 原实现中 username/password 缺失时会落入 `username !== VALID_USERNAME` 判断，
 * 返回 401 Unauthorized。但按 HTTP 语义，参数缺失应返回 400 Bad Request，
 * 凭证错误才返回 401 Unauthorized。
 */
export function loginHandler(req: Request, res: Response): void {
  try {
    const { username, password } = req.body;

    // 参数校验：缺失 username 或 password 返回 400 Bad Request
    if (!username || !password) {
      res.status(400).json({ error: "Username and password are required" });
      return;
    }

    // 校验用户名密码（凭证错误返回 401 Unauthorized）
    if (username !== VALID_USERNAME || password !== VALID_PASSWORD) {
      throw new AuthenticationError("Invalid credentials");
    }

    // 签发 token
    const token = signToken({ username });

    logger.info(`User logged in: ${username}`);
    res.status(200).json({
      token,
      expiresIn: JWT_EXPIRES_IN,
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
    } else {
      res.status(500).json({ error: "Internal server error" });
    }
  }
}
