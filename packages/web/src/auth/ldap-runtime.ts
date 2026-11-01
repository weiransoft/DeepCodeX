/**
 * LDAP 配置运行期热读（LDAP 开关免重启生效）。
 *
 * 背景：LDAP 启停开关此前只在引擎启动时 resolve 一次，系统管理里切换开关
 * 必须重启引擎才生效（重启会中断进行中的会话）。本模块在登录请求路径上
 * 以短 TTL 缓存动态读取 settings.json 的 web.ldap 子树：
 *
 * - 合并顺序与 resolveWebSettings 一致：用户级 < 项目级（ldap 子节浅合并）；
 * - 仅热读非密钥字段；bindPassword 恒用启动值（来自 env 注入，文件不明文存储）；
 * - 任何读取/解析/归一失败一律回退启动基线（fail-safe，绝不因热读抛错阻断登录）；
 * - TTL 缓存（默认 5s）：登录为低频操作，文件 IO 开销可忽略。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ResolvedWebSettings } from "../types";

/** LDAP 配置类型别名（ResolvedWebSettings.ldap） */
export type LdapRuntimeConfig = ResolvedWebSettings["ldap"];

/** 热读缓存 TTL（毫秒）：开关切换最迟一个 TTL 后生效 */
export const LDAP_RUNTIME_TTL_MS = 5_000;

/** 缓存条目：读到的配置 + 读取时间戳 */
let cache: { config: LdapRuntimeConfig; fetchedAt: number } | null = null;

/** 测试隔离：清空热读缓存 */
export function resetLdapRuntimeCacheForTest(): void {
  cache = null;
}

/**
 * 读取单个 settings.json 的原始对象（不存在/损坏返回 null，不抛错）。
 *
 * @param file settings.json 绝对路径
 * @returns 解析后的顶层对象；失败返回 null
 */
function readSettingsJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 把原始 ldap 子节归一为可用的 LdapConfig；单个字段非法时逐项回退基线。
 *
 * bindPassword 不从文件读取（env 注入语义），恒取基线值。
 *
 * @param raw settings.json 合并后的 web.ldap 原始值
 * @param baseline 启动时 resolve 的 LDAP 配置（回退兜底）
 * @returns 归一后的配置
 */
function normalizeLdap(raw: unknown, baseline: LdapRuntimeConfig): LdapRuntimeConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return baseline;
  }
  const obj = raw as Record<string, unknown>;
  const config: LdapRuntimeConfig = { ...baseline };

  if (typeof obj["enabled"] === "boolean") {
    config.enabled = obj["enabled"];
  }
  if (typeof obj["server"] === "string" && obj["server"].trim() !== "") {
    config.server = obj["server"].trim();
  }
  if (typeof obj["port"] === "number" && Number.isInteger(obj["port"]) && obj["port"] >= 1 && obj["port"] <= 65535) {
    config.port = obj["port"];
  }
  if (typeof obj["useSsl"] === "boolean") {
    config.useSsl = obj["useSsl"];
  }
  if (typeof obj["bindDn"] === "string" && obj["bindDn"].trim() !== "") {
    config.bindDn = obj["bindDn"].trim();
  }
  if (typeof obj["baseDn"] === "string" && obj["baseDn"].trim() !== "") {
    config.baseDn = obj["baseDn"].trim();
  }
  if (typeof obj["userFilter"] === "string") {
    config.userFilter = obj["userFilter"];
  }
  if (typeof obj["timeoutMs"] === "number" && Number.isFinite(obj["timeoutMs"]) && obj["timeoutMs"] >= 1000) {
    config.timeoutMs = Math.floor(obj["timeoutMs"]);
  }
  if (obj["attrs"] !== null && typeof obj["attrs"] === "object" && !Array.isArray(obj["attrs"])) {
    const attrs: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj["attrs"] as Record<string, unknown>)) {
      if (typeof value === "string") {
        attrs[key] = value;
      }
    }
    config.attrs = attrs;
  }
  return config;
}

/**
 * 读取 LDAP 运行期配置（带 TTL 缓存；读取失败回退启动基线）。
 *
 * 用户级 settings 路径优先级：显式 options > 基线 userSettingsPath（resolveWebSettings
 * 注入的来源文件）> 默认 ~/.deepcode/settings.json；项目级恒为 <projectRoot>/.deepcode/settings.json。
 *
 * @param baseline 启动时 resolve 的完整 Web 配置（提供 ldap 基线、projectRoot 与来源路径）
 * @param options 测试注入点：settings 文件路径覆盖
 * @returns 当前生效的 LDAP 配置
 */
export function readLdapRuntimeConfig(
  baseline: ResolvedWebSettings,
  options: { userSettingsPath?: string; projectSettingsPath?: string } = {}
): LdapRuntimeConfig {
  const now = Date.now();
  if (cache !== null && now - cache.fetchedAt < LDAP_RUNTIME_TTL_MS) {
    return cache.config;
  }

  try {
    const userFile =
      options.userSettingsPath ?? baseline.userSettingsPath ?? path.join(homedir(), ".deepcode", "settings.json");
    const projectFile = options.projectSettingsPath ?? path.join(baseline.projectRoot, ".deepcode", "settings.json");

    const userWeb = (readSettingsJson(userFile)?.["web"] ?? null) as Record<string, unknown> | null;
    const projectWeb = (readSettingsJson(projectFile)?.["web"] ?? null) as Record<string, unknown> | null;
    // 与 resolveWebSettings 合并顺序一致：用户级 < 项目级（ldap 浅合并）
    const mergedLdap = { ...(userWeb?.["ldap"] ?? {}), ...(projectWeb?.["ldap"] ?? {}) };
    const config = normalizeLdap(mergedLdap, baseline.ldap);
    cache = { config, fetchedAt: now };
    return config;
  } catch {
    // 任何意外错误：回退基线并缓存，避免每个请求重复失败 IO
    cache = { config: baseline.ldap, fetchedAt: now };
    return baseline.ldap;
  }
}
