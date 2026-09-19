/**
 * 认证端点（docs/dev/web-ui.md §3.4 / §3.5）。
 *
 * - POST /api/auth/login：LDAP enabled 先走 LDAP；失败且有 localUsers 时兜底本地
 *   （sha256 hex + timingSafeEqual 恒时比较）；全失败统一 401 文案 + 500ms 固定延迟防暴力破解。
 * - POST /api/auth/logout：清除认证 Cookie。
 * - GET /api/auth/me：返回当前登录用户（由认证中间件保证已登录）。
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LdapService } from "../auth/ldap-service";
import { signJWT } from "../auth/jwt";
import { buildAuthCookie, buildClearAuthCookie, setAuthCookie } from "../auth/middleware";
import { readJsonBody, sendJson, ApiError } from "../http-utils";
import type { ResolvedWebSettings } from "../types";

/** 登录失败固定延迟（毫秒），防暴力破解（docs/dev/web-ui.md §3.6） */
const LOGIN_FAILURE_DELAY_MS = 500;

/** 本地兜底用户校验成功结果 */
type LocalUserMatch = {
  username: string;
  displayName?: string;
};

/**
 * 本地兜底用户校验：sha256(password) hex 与 passwordHash 恒时比较。
 *
 * @param users settings 中的 localUsers 列表
 * @param username 登录用户名
 * @param password 明文密码
 * @returns 匹配成功返回用户信息；不匹配返回 null
 */
function matchLocalUser(
  users: ResolvedWebSettings["auth"]["localUsers"],
  username: string,
  password: string
): LocalUserMatch | null {
  const user = users.find((item) => item.username === username);
  if (!user) {
    return null;
  }
  // 计算 sha256 hex，并规范化为小写后比较（用户配置可能用大写 hex）
  const digest = createHash("sha256").update(password, "utf8").digest("hex").toLowerCase();
  const configured = user.passwordHash.trim().toLowerCase();
  // 长度不一致（配置非法/被篡改）直接视为不匹配，避免 timingSafeEqual 抛错
  const digestBuf = Buffer.from(digest, "utf8");
  const configuredBuf = Buffer.from(configured, "utf8");
  if (digestBuf.length !== configuredBuf.length) {
    return null;
  }
  if (!timingSafeEqual(digestBuf, configuredBuf)) {
    return null;
  }
  return { username: user.username, displayName: user.displayName };
}

/**
 * 处理 POST /api/auth/login。
 *
 * 认证顺序：LDAP enabled → LDAP 认证；LDAP 失败/未启用且有 localUsers → 本地兜底。
 * 全部失败：固定延迟 500ms 后统一 401（文案不区分失败原因，防账号枚举）。
 *
 * @param req 请求对象
 * @param res 响应对象
 * @param settings 归一后的 Web 配置（jwtSecret / sessionTtlSeconds / ldap / localUsers）
 */
export async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  settings: ResolvedWebSettings
): Promise<void> {
  const body = await readJsonBody<{ username?: unknown; password?: unknown }>(req);
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (username.trim() === "" || password === "") {
    throw new ApiError(400, "请求体必须包含非空 username 与 password");
  }

  /** 认证成功后的响应载荷 */
  let authenticated: { username: string; displayName?: string; mail?: string; authSource: "ldap" | "local" } | null =
    null;

  // 1. LDAP 认证（enabled 时优先）
  if (settings.ldap.enabled) {
    try {
      const result = await new LdapService(settings.ldap).authenticate(username, password);
      authenticated = {
        username: result.username,
        displayName: result.displayName,
        mail: result.mail,
        authSource: "ldap",
      };
    } catch {
      // LDAP 失败（不可达/超时/凭据错误等一切异常）统一吞掉：继续走本地兜底或落入 401，
      // 不向客户端区分失败原因（防账号枚举与内部信息泄露，LdapAuthError 文案本身已收敛）
    }
  }

  // 2. 本地兜底用户校验（LDAP 未启用或失败时）
  if (!authenticated) {
    const local = matchLocalUser(settings.auth.localUsers, username, password);
    if (local) {
      authenticated = {
        username: local.username,
        displayName: local.displayName,
        authSource: "local",
      };
    }
  }

  // 3. 全部失败：固定延迟 + 统一 401
  if (!authenticated) {
    await new Promise<void>((resolve) => setTimeout(resolve, LOGIN_FAILURE_DELAY_MS));
    sendJson(res, 401, { error: "用户名或密码错误" });
    return;
  }

  // 4. 签发 JWT 并写入 HttpOnly Cookie（TTL 与 sessionTtlSeconds 对齐）
  const token = signJWT(
    {
      sub: authenticated.username,
      displayName: authenticated.displayName,
      mail: authenticated.mail,
      authSource: authenticated.authSource,
    },
    settings.auth.jwtSecret,
    settings.auth.sessionTtlSeconds
  );
  setAuthCookie(res, buildAuthCookie(token, settings.auth.sessionTtlSeconds));
  sendJson(res, 200, {
    username: authenticated.username,
    displayName: authenticated.displayName,
    mail: authenticated.mail,
    authSource: authenticated.authSource,
  });
}

/**
 * 处理 POST /api/auth/logout：清除认证 Cookie（无需认证，幂等）。
 *
 * @param _req 请求对象（未使用）
 * @param res 响应对象
 */
export function handleLogout(_req: IncomingMessage, res: ServerResponse): void {
  setAuthCookie(res, buildClearAuthCookie());
  sendJson(res, 200, { ok: true });
}

/**
 * 处理 GET /api/auth/me：返回当前登录用户信息（认证中间件已保证 JWT 有效）。
 *
 * @param res 响应对象
 * @param payload 认证中间件解析出的 JWT 载荷
 */
export function handleMe(
  res: ServerResponse,
  payload: { sub: string; displayName?: string; mail?: string; authSource?: "ldap" | "local" }
): void {
  sendJson(res, 200, {
    username: payload.sub,
    displayName: payload.displayName,
    mail: payload.mail,
    // 旧版本签发的 Token 可能缺 authSource，按 unknown 回显避免误标
    authSource: payload.authSource ?? "unknown",
  });
}
