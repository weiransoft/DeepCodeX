/**
 * 外部策略加载 + 硬化（方案 §4.4「授权在壳」的 sidecar 侧对应实现）。
 *
 * 契约：壳把开关/授权写到 `~/.deepcode/desktop-agent.json`，sidecar 启动时读取。
 * 但**落盘文件是不可信输入**——壳侧 harden() 已经复位过一次，这里再独立复位
 * 一次（纵深防御）：即便用户手工改文件、或换了一个没跑壳的启动方式，
 * 也不能通过策略文件放宽敏感分类、视觉/坐标通道、权限模式与预算上限。
 *
 * 优先级：DEEPCODE_AGENT_POLICY（显式指定）> 壳落盘策略 > 仓库内默认策略。
 * 任何解析失败都回落到「默认关闭」的安全基线，而不是抛错让进程带病启动。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultPolicy, DEFAULT_DENIED_CATEGORIES } from "./policy-guard.mjs";

export const DEEPCODE_DIR = ".deepcode";
export const SHELL_POLICY_FILE = "desktop-agent.json";
export const MAX_ENTRIES = 64;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : lo));

function validId(s) {
  return (
    typeof s === "string" &&
    s.trim().length > 0 &&
    s.length <= 128 &&
    ![...s].some((c) => c === "/" || c === "\\" || c.charCodeAt(0) < 0x20)
  );
}

export function shellPolicyPath(home = homedir()) {
  return join(home, DEEPCODE_DIR, SHELL_POLICY_FILE);
}

export function bundledPolicyPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "policy.default.json");
}

/** 只做路径决策，不读文件，便于测试注入 */
export function resolvePolicyPath({ env = process.env, home = homedir(), exists = existsSync } = {}) {
  if (env.DEEPCODE_AGENT_POLICY) {
    return { path: resolve(env.DEEPCODE_AGENT_POLICY), source: "env" };
  }
  const shell = shellPolicyPath(home);
  if (exists(shell)) return { path: shell, source: "shell" };
  return { path: bundledPolicyPath(), source: "bundled" };
}

/**
 * 白名单式构造：只保留已知字段，未知键（含 `_comment`）一律丢弃。
 * 锁定字段与 desktop_agent.rs::harden() 完全对齐，避免两侧口径漂移。
 */
export function hardenExternalPolicy(raw = {}) {
  const base = defaultPolicy();
  const src = raw && typeof raw === "object" ? raw : {};
  const allowedApps = (Array.isArray(src.allowedApps) ? src.allowedApps : [])
    .filter((g) => g && validId(g.appId))
    .slice(0, MAX_ENTRIES)
    .map((g) => ({
      appId: g.appId.trim(),
      always: g.always === true,
      scopes: (Array.isArray(g.scopes) ? g.scopes : []).filter((s) => s === "read" || s === "write"),
    }));
  const deniedApps = (Array.isArray(src.deniedApps) ? src.deniedApps : [])
    .filter(validId)
    .slice(0, MAX_ENTRIES)
    .map((s) => s.trim());

  return {
    enabled: src.enabled === true,
    permissionMode: src.permissionMode === "auto" ? "auto" : "manual", // bypass 降级
    allowedApps,
    deniedApps,
    deniedCategories: [...DEFAULT_DENIED_CATEGORIES],
    preferBrowserChannel: true,
    allowCoordinateInput: false,
    allowScreenshot: false,
    maxSteps: clamp(src.maxSteps ?? base.maxSteps, 1, 100),
    maxScreenshots: clamp(src.maxScreenshots ?? base.maxScreenshots, 0, 10),
    maxTokens: clamp(src.maxTokens ?? base.maxTokens, 1_000, 200_000),
    maxRetries: clamp(src.maxRetries ?? base.maxRetries, 0, 5),
  };
}

/** @returns {{policy:object, source:string, path:string, error:string|null}} */
export function loadPolicy({ env = process.env, home = homedir(), read = readFileSync, exists = existsSync } = {}) {
  const { path, source } = resolvePolicyPath({ env, home, exists });
  try {
    return { policy: hardenExternalPolicy(JSON.parse(read(path, "utf8"))), source, path, error: null };
  } catch (e) {
    return { policy: defaultPolicy(), source: "fallback", path, error: e?.message ?? String(e) };
  }
}
