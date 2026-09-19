/**
 * Web 配置节解析与校验（docs/dev/web-ui.md §3.3）。
 *
 * 职责：
 * 1. 读取用户级（~/.deepcode/settings.json）与项目级（<project>/.deepcode/settings.json）
 *    的 `web` 配置节，项目级覆盖用户级（各子节浅合并）；
 * 2. 归一全部默认值（host/port/uploadDir/maxUploadBytes/sessionTtlSeconds/ldap.* 等）；
 * 3. 应用环境变量覆盖（DEEPCODE_WEB_JWT_SECRET / DEEPCODE_WEB_LDAP_BIND_PASSWORD）；
 * 4. 启动期 fail-fast 校验（jwtSecret 缺失、port/host 非法、ldap 启用但缺 server/baseDn）。
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  getProjectSettingsPath,
  getUserSettingsPath,
  type DeepcodingSettings,
  type WebSettings,
} from "@vegamo/deepcode-core";
import type { ResolvedWebSettings } from "./types";

/** 单文件上传上限默认值：50MB（docs/dev/web-ui.md §3.3） */
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** JWT 会话有效期默认值：28800 秒（8 小时） */
const DEFAULT_SESSION_TTL_SECONDS = 28800;
/** LDAP 连接/操作超时默认值：10000 毫秒 */
const DEFAULT_LDAP_TIMEOUT_MS = 10000;
/** LDAP 用户过滤模板默认值（支持 %s 占位） */
const DEFAULT_LDAP_USER_FILTER = "(uid=%s)";

/**
 * 读取并解析单个 settings.json 文件。
 *
 * 文件不存在或为空视为空配置；JSON 解析失败时抛出带中文说明的错误，
 * 避免静默吞掉配置错误导致行为不可预期。
 *
 * @param filePath settings.json 绝对路径
 * @returns 解析出的配置对象（文件缺失时为空对象）
 */
function readSettingsFile(filePath: string): DeepcodingSettings {
  if (!existsSync(filePath)) {
    return {};
  }
  const raw = readFileSync(filePath, "utf8");
  if (raw.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(raw) as DeepcodingSettings;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`配置文件 ${filePath} 不是合法 JSON：${message}`);
  }
}

/**
 * 展开 ~ 开头的路径为用户主目录绝对路径，并做 path.resolve 归一。
 *
 * 仅处理以 "~" 或 "~/" 开头的路径（Windows 风格 ~user 不在支持范围），
 * 其余路径原样经 path.resolve 归一。
 *
 * @param rawPath 原始路径配置
 * @returns 展开归一后的绝对路径
 */
export function expandHomePath(rawPath: string): string {
  if (rawPath === "~") {
    return homedir();
  }
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return path.resolve(homedir(), rawPath.slice(2));
  }
  return path.resolve(rawPath);
}

/**
 * 校验监听端口合法性：必须为 1-65535 的整数。
 *
 * @param port 待校验端口
 * @param source 值来源描述（用于错误信息，如 "settings" / "cli --port"）
 * @returns 校验通过的端口
 */
export function validatePort(port: number, source: string): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`web.port 配置非法（来源：${source}，值：${String(port)}）：必须是 1-65535 之间的整数`);
  }
  return port;
}

/**
 * 校验监听地址合法性：必须为非空且不含空白字符的主机名/IP。
 *
 * @param host 待校验地址
 * @returns 校验通过的地址
 */
export function validateHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed === "" || /\s/.test(trimmed)) {
    throw new Error(`web.host 配置非法（值：${JSON.stringify(host)}）：必须是非空且不含空白字符的主机名或 IP`);
  }
  return trimmed;
}

/**
 * 解析 Web 配置（docs/dev/web-ui.md §3.3 的完整实现）。
 *
 * 合并顺序：用户级 web 节 < 项目级 web 节（各子节 auth/ldap 浅合并），
 * 之后应用环境变量覆盖并归一默认值，最后执行启动期校验（fail-fast）。
 *
 * @param projectRoot 当前项目根目录（决定项目级 settings.json 位置）
 * @param env 环境变量对象（默认 process.env；测试可注入受控 env，避免污染进程环境）
 * @returns 归一后的 ResolvedWebSettings
 * @throws Error 当 jwtSecret 缺失、port/host 非法或 LDAP 配置不完整时抛出带中文说明的错误
 */
export function resolveWebSettings(projectRoot: string, env: NodeJS.ProcessEnv = process.env): ResolvedWebSettings {
  // 1. 读取用户级与项目级 settings.json，提取 web 节（项目级覆盖用户级，子节浅合并）
  const userSettings = readSettingsFile(getUserSettingsPath());
  const projectSettings = readSettingsFile(getProjectSettingsPath(projectRoot));
  const userWeb: WebSettings = userSettings.web ?? {};
  const projectWeb: WebSettings = projectSettings.web ?? {};
  const merged: WebSettings = {
    ...userWeb,
    ...projectWeb,
    auth: { ...userWeb.auth, ...projectWeb.auth },
    ldap: { ...userWeb.ldap, ...projectWeb.ldap },
  };

  // 2. 环境变量覆盖密钥类配置（settings.json 中允许缺省，由 env 注入）
  const envJwtSecret = env["DEEPCODE_WEB_JWT_SECRET"];
  const jwtSecret = typeof envJwtSecret === "string" && envJwtSecret !== "" ? envJwtSecret : merged.auth?.jwtSecret;
  const envBindPassword = env["DEEPCODE_WEB_LDAP_BIND_PASSWORD"];
  const bindPassword =
    typeof envBindPassword === "string" && envBindPassword !== "" ? envBindPassword : merged.ldap?.bindPassword;

  // 3. 基础字段归一
  const host = validateHost(merged.host ?? "127.0.0.1");
  const port = validatePort(merged.port ?? 3210, "settings.json web.port");
  const maxUploadBytes = merged.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const sessionTtlSeconds = merged.auth?.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const useSsl = merged.ldap?.useSsl ?? false;

  // 4. 数值合法性校验（fail-fast，避免启动后行为异常）
  if (!Number.isFinite(maxUploadBytes) || maxUploadBytes <= 0) {
    throw new Error(`web.maxUploadBytes 配置非法（值：${String(maxUploadBytes)}）：必须是正数（字节）`);
  }
  if (!Number.isFinite(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    throw new Error(`web.auth.sessionTtlSeconds 配置非法（值：${String(sessionTtlSeconds)}）：必须是正数（秒）`);
  }

  // 5. allowRoots 逐项 ~ 展开 + path.resolve；目录不存在时尽力创建（mkdir 可选，失败不阻断启动）
  const allowRoots = (merged.allowRoots ?? []).map((raw) => {
    const resolved = expandHomePath(raw);
    try {
      mkdirSync(resolved, { recursive: true });
    } catch {
      // 创建失败不视为致命错误：目录浏览端点会在运行期给出更精确的错误
    }
    return resolved;
  });

  // 6. uploadDir 归一并尽力创建（上传端点运行期还会兜底 mkdir）
  const uploadDir = expandHomePath(merged.uploadDir ?? path.join(homedir(), ".deepcode", "web-uploads"));
  try {
    mkdirSync(uploadDir, { recursive: true });
  } catch {
    // 同 allowRoots：延迟到上传时再报错
  }

  // 7. JWT 密钥校验（启动 fail-fast：密钥缺失直接拒绝启动，防止无签名服务裸奔）
  if (typeof jwtSecret !== "string" || jwtSecret.trim() === "") {
    throw new Error(
      "web.auth.jwtSecret 未配置：请在 ~/.deepcode/settings.json 或 <project>/.deepcode/settings.json 的 " +
        "web.auth.jwtSecret 中设置密钥，或通过环境变量 DEEPCODE_WEB_JWT_SECRET 注入后重试"
    );
  }

  // 8. LDAP 配置校验：启用时 server 与 baseDn 必填
  if (merged.ldap?.enabled === true) {
    const server = (merged.ldap.server ?? "").trim();
    const baseDn = (merged.ldap.baseDn ?? "").trim();
    if (server === "" || baseDn === "") {
      throw new Error("web.ldap.enabled 为 true 时必须同时配置 web.ldap.server 与 web.ldap.baseDn");
    }
  }

  return {
    projectRoot,
    enabled: merged.enabled ?? false,
    host,
    port,
    allowRoots,
    uploadDir,
    maxUploadBytes,
    auth: {
      jwtSecret,
      sessionTtlSeconds,
      localUsers: merged.auth?.localUsers ?? [],
    },
    ldap: {
      enabled: merged.ldap?.enabled ?? false,
      server: (merged.ldap?.server ?? "").trim(),
      // 端口默认随 useSsl 切换：636（ldaps）或 389（ldap）
      port: merged.ldap?.port ?? (useSsl ? 636 : 389),
      useSsl,
      bindDn: merged.ldap?.bindDn,
      bindPassword,
      baseDn: (merged.ldap?.baseDn ?? "").trim(),
      userFilter:
        (merged.ldap?.userFilter ?? "").trim() !== ""
          ? (merged.ldap?.userFilter as string).trim()
          : DEFAULT_LDAP_USER_FILTER,
      timeoutMs: merged.ldap?.timeoutMs ?? DEFAULT_LDAP_TIMEOUT_MS,
      attrs: merged.ldap?.attrs ?? {},
    },
  };
}
