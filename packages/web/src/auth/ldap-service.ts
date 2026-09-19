/**
 * LDAP 认证服务（docs/dev/web-ui.md §3.4，流程对齐 qa-audit ldap_service.py :422-520）。
 *
 * 认证流程：
 * 1. 组装 URI：ldaps://|ldap://server:port（连接/操作超时 timeoutMs）；
 * 2. 服务账号 bind（bindDn/bindPassword；未配置则匿名 bind）；
 * 3. search baseDn，filter = buildUserFilter(userFilter, username)（RFC 4515 转义防注入）；
 * 4. 取用户 entry.dn 与属性（displayName/mail，映射关系来自 attrs 配置）；
 * 5. 用户 DN + 密码二次 bind 验证（qa-audit 同款，确保密码真正有效）；
 * 6. 返回 { dn, username, displayName?, mail? }。
 *
 * 安全约定：所有失败统一抛 LdapAuthError（文案不含内部 DN/服务器细节），供上层映射 401。
 */

import { Client } from "ldapts";
import type { ResolvedWebSettings } from "../types";

/** LDAP 配置类型别名（来自 ResolvedWebSettings.ldap） */
export type LdapConfig = ResolvedWebSettings["ldap"];

/** LDAP 认证成功结果 */
export type LdapAuthResult = {
  /** 用户在 LDAP 目录中的完整 DN */
  dn: string;
  /** 登录用户名（原样回传） */
  username: string;
  /** 展示名（来自 attrs 映射的 displayName 字段，可选） */
  displayName?: string;
  /** 邮箱（来自 attrs 映射的 mail 字段，可选） */
  mail?: string;
};

/**
 * LDAP 认证失败类型化错误。
 *
 * message 固定为统一文案（不携带服务器/DN 细节），可选 cause 保留原始错误便于服务端排查日志。
 */
export class LdapAuthError extends Error {
  /** 原始错误（仅用于服务端日志，不进入对外响应） */
  readonly cause?: unknown;

  /**
   * @param message 统一对外错误文案
   * @param cause 原始错误对象（可选）
   */
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "LdapAuthError";
    this.cause = cause;
  }
}

/**
 * RFC 4515 LDAP filter 值转义（防 LDAP 注入，docs/dev/web-ui.md §3.6）。
 *
 * 五种特殊字符必须转义：
 * - `\` → `\5c`
 * - `*` → `\2a`
 * - `(` → `\28`
 * - `)` → `\29`
 * - NUL（\0）→ `\00`
 *
 * @param value 用户输入的原始值（如登录用户名）
 * @returns 转义后可安全拼入 filter 的值
 */
export function escapeLdapFilterValue(value: string): string {
  return value
    .replaceAll("\\", "\\5c")
    .replaceAll("*", "\\2a")
    .replaceAll("(", "\\28")
    .replaceAll(")", "\\29")
    .replaceAll("\0", "\\00");
}

/**
 * 构造用户搜索 filter（对齐 qa-audit _build_auth_search_filter :383-420）。
 *
 * 两种风格兼容：
 * 1. userFilter 含 %s 占位：替换为转义后的用户名，如 "(uid=%s)" → "(uid=alice)"；
 * 2. userFilter 不含 %s（复合 filter）：剥离最外层成对括号后 AND 上 (uid=<escaped>)，
 *    如 "(&(objectClass=user)(!(objectClass=computer)))"
 *    → "(&(objectClass=user)(!(objectClass=computer))(uid=alice))"。
 *
 * @param userFilter 配置的过滤模板（空串视为 "(uid=%s)"）
 * @param username 登录用户名（内部先做 RFC 4515 转义）
 * @returns 可直接用于 search 的 filter 字符串
 */
export function buildUserFilter(userFilter: string, username: string): string {
  // 空模板兜底为最简默认，避免生成非法 filter
  const template = userFilter.trim() !== "" ? userFilter.trim() : "(uid=%s)";
  const safeUsername = escapeLdapFilterValue(username);

  // 情形 1：含 %s 占位 → 直接替换（全部占位统一替换）
  if (template.includes("%s")) {
    return template.replaceAll("%s", safeUsername);
  }

  // 情形 2：不含占位 → 剥离最外层成对括号后与 (uid=...) 组合为 AND
  let inner = template;
  if (inner.startsWith("(") && inner.endsWith(")")) {
    inner = inner.slice(1, -1).trim();
  }
  return `(&(${inner})(uid=${safeUsername}))`;
}

/**
 * 从 LDAP entry 属性取第一个字符串值。
 *
 * ldapts 属性值可能是 string / string[] / Buffer，统一取第一个可读值。
 *
 * @param entry 搜索返回的条目
 * @param attributeName LDAP 属性名
 * @returns 第一个字符串值（不存在时返回 undefined）
 */
function readEntryAttr(entry: { [key: string]: unknown }, attributeName: string): string | undefined {
  const value = entry[attributeName];
  if (typeof value === "string" && value !== "") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string" && value[0] !== "") {
    return value[0] as string;
  }
  return undefined;
}

/**
 * LDAP 认证服务（每次认证创建独立连接，认证完成即 unbind，避免跨请求复用绑定态）。
 */
export class LdapService {
  private readonly config: LdapConfig;

  /**
   * @param config 归一后的 LDAP 配置（ResolvedWebSettings.ldap）
   */
  constructor(config: LdapConfig) {
    this.config = config;
  }

  /**
   * 组装 LDAP 服务器 URI（对齐 qa-audit _build_server_uri :84-115）。
   *
   * 规则：useSsl → ldaps://，否则 ldap://；端口显式取配置（默认值已在 config 归一）。
   *
   * @returns 形如 "ldap://host:port" 的 URI
   */
  buildServerUri(): string {
    const scheme = this.config.useSsl ? "ldaps" : "ldap";
    return `${scheme}://${this.config.server}:${this.config.port}`;
  }

  /**
   * 验证用户凭据（完整认证流程见模块注释）。
   *
   * @param username 登录用户名（拼入 filter 前会做 RFC 4515 转义）
   * @param password 用户密码（仅用于 bind，绝不落盘/日志）
   * @returns 认证成功时的用户信息（dn/username/displayName/mail）
   * @throws LdapAuthError 任何失败（服务器不可达/超时/凭据错误/用户不存在）统一抛出，
   *         文案固定不泄露内部细节，供 auth-api 统一映射 401
   */
  async authenticate(username: string, password: string): Promise<LdapAuthResult> {
    // 空密码无法完成 simple_bind（服务端必拒），直接拒绝，省一次无意义连接
    if (password === "") {
      throw new LdapAuthError("LDAP 认证失败：用户名或密码错误");
    }

    const uri = this.buildServerUri();
    const client = new Client({
      url: uri,
      // 连接建立与单次操作的超时均取配置 timeoutMs
      connectTimeout: this.config.timeoutMs,
      timeout: this.config.timeoutMs,
    });

    try {
      // 步骤 1：服务账号 bind（未配置 bindDn 时尝试匿名 bind，部分目录允许匿名搜索）
      if (this.config.bindDn) {
        await client.bind(this.config.bindDn, this.config.bindPassword ?? "");
      } else {
        // 匿名 bind：空 DN + 空密码（RFC 4513 anonymous authentication，
        // 部分目录服务器允许匿名搜索，凭据错误时由 bind 抛错统一处理）
        await client.bind("", "");
      }

      // 步骤 2：按用户名搜索条目（filter 已转义，防注入）
      const searchFilter = buildUserFilter(this.config.userFilter, username);
      // 需要取回的属性：attrs 映射的键 + 常规兜底属性
      const attributes = Array.from(new Set([...Object.keys(this.config.attrs), "uid", "mail", "displayName", "cn"]));
      const { searchEntries } = await client.search(this.config.baseDn, {
        scope: "sub",
        filter: searchFilter,
        attributes,
      });

      // 过滤 referral 等无 dn 条目，取第一个真实用户（qa-audit 同款策略）
      const entry = searchEntries.find((item) => typeof item.dn === "string" && item.dn !== "");
      if (!entry) {
        // 用户不存在与密码错误统一文案，避免账号枚举
        throw new LdapAuthError("LDAP 认证失败：用户名或密码错误");
      }
      const userDn = entry.dn;

      // 步骤 3：用户 DN + 密码二次 bind 验证（验证密码真实有效，而非仅搜索到条目）
      await client.bind(userDn, password);

      // 步骤 4：按 attrs 映射读取展示字段（displayName/mail）
      const displayNameAttr = this.config.attrs["displayName"] ?? "displayName";
      const mailAttr = this.config.attrs["mail"] ?? "mail";
      const result: LdapAuthResult = {
        dn: userDn,
        username,
      };
      const displayName = readEntryAttr(entry, displayNameAttr);
      const mail = readEntryAttr(entry, mailAttr);
      if (displayName !== undefined) {
        result.displayName = displayName;
      }
      if (mail !== undefined) {
        result.mail = mail;
      }
      return result;
    } catch (error) {
      // 统一收敛为类型化错误：对外文案固定，原始错误挂 cause 供服务端日志排查
      if (error instanceof LdapAuthError) {
        throw error;
      }
      throw new LdapAuthError("LDAP 认证失败：用户名或密码错误", error);
    } finally {
      // 无论成败都断开连接，防止连接泄漏
      try {
        await client.unbind();
      } catch {
        // unbind 失败不影响认证结果
      }
    }
  }
}
