/**
 * 外部策略加载 + 硬化（方案 §4.4「授权在壳」的 sidecar 侧对应实现）。
 *
 * 契约：壳把开关/授权写到 `~/.deepcode/desktop-agent.json`，sidecar 启动时读取，
 * 并**在每个工具调用前重判一次**（`PolicyReloader`）——壳拿不到 sidecar 的进程
 * 句柄，文件是唯一通道；撤销授权必须即时生效，不能等到引擎重启。
 * 但**落盘文件是不可信输入**——壳侧 harden() 已经复位过一次，这里每次重载都
 * 再独立复位一次（纵深防御）：即便用户手工改文件、或换了一个没跑壳的启动方式，
 * 也不能通过策略文件放宽敏感分类、视觉/坐标通道、权限模式与预算上限。
 *
 * 优先级：DEEPCODE_AGENT_POLICY（显式指定）> 壳落盘策略 > 仓库内默认策略。
 * 任何解析失败都回落到「默认关闭」的安全基线（fail-closed），而不是抛错让进程
 * 带病启动、或沿用上一次的有效授权。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultPolicy, DEFAULT_DENIED_CATEGORIES } from "./policy-guard.mjs";

export const DEEPCODE_DIR = ".deepcode";
export const SHELL_POLICY_FILE = "desktop-agent.json";
export const MAX_ENTRIES = 64;

/**
 * 视觉通道授权的时限（与 `desktop/src-tauri/src/desktop_agent.rs` 完全对齐）。
 * 两侧必须同口径：壳侧写、sidecar 读，任何一侧放宽都等于开了后门。
 */
export const VISION_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const VISION_MIN_TTL_MS = 60 * 1000;
export const VISION_CHALLENGE_TTL_MS = 5 * 60 * 1000;

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
 * 视觉授权规范化：**过期、空清单、非法 appId、授权时刻可疑、超长**一律作废。
 * 与 Rust 侧 `normalize_vision()` 逐条对齐（这是同一份契约的两个实现）。
 *
 * @returns {{apps:string[],allowCoordinateInput:boolean,grantedAt:number,expiresAt:number,grantId:string}|null}
 */
export function normalizeVision(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const apps = [];
  for (const item of Array.isArray(raw.apps) ? raw.apps : []) {
    if (!validId(item)) continue;
    const id = item.trim();
    if (!apps.includes(id)) apps.push(id);
    if (apps.length >= MAX_ENTRIES) break;
  }
  if (apps.length === 0) return null;

  const grantedAt = Number(raw.grantedAt);
  const expiresAt = Number(raw.expiresAt);
  if (!Number.isFinite(grantedAt) || grantedAt <= 0) return null;
  // 授权时刻在"未来"（超过令牌有效期）说明时钟可疑，不认
  if (grantedAt > now + VISION_CHALLENGE_TTL_MS) return null;
  if (!Number.isFinite(expiresAt) || expiresAt <= grantedAt) return null;

  const capped = Math.min(expiresAt, grantedAt + VISION_MAX_TTL_MS);
  if (capped <= now) return null;

  const grantId = typeof raw.grantId === "string" && raw.grantId.trim() ? raw.grantId.trim() : "legacy";
  return {
    apps,
    allowCoordinateInput: raw.allowCoordinateInput === true,
    grantedAt,
    expiresAt: capped,
    grantId,
  };
}

/**
 * 白名单式构造：只保留已知字段，未知键（含 `_comment`）一律丢弃。
 * 锁定字段与 desktop_agent.rs::harden() 完全对齐，避免两侧口径漂移。
 */
export function hardenExternalPolicy(raw = {}, now = Date.now()) {
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

  const vision = normalizeVision(src.vision, now);

  return {
    enabled: src.enabled === true,
    permissionMode: src.permissionMode === "auto" ? "auto" : "manual", // bypass 降级
    allowedApps,
    deniedApps,
    deniedCategories: [...DEFAULT_DENIED_CATEGORIES],
    preferBrowserChannel: true,
    // 视觉通道由限时授权派生：没有有效授权，两个开关就是 false（不是可写字段）
    allowCoordinateInput: vision?.allowCoordinateInput === true,
    allowScreenshot: vision !== null,
    visionApps: vision?.apps ?? [],
    visionExpiresAt: vision?.expiresAt ?? 0,
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

/**
 * 策略热重载：「文件即真源」，每次工具调用前重判一次。
 *
 * 为什么需要它（而不只是"麻烦一点、重启引擎就好了"）：
 * 壳与 sidecar 之间只有策略文件这一条通道（sidecar 由引擎 McpManager 拉起，
 * 壳拿不到它的进程句柄）。授权后不重启只是体验问题，但**撤销后不重启是漏洞**：
 * 长驻 sidecar 仍握着旧的 visionApps / allowScreenshot，用户点了撤销、
 * 到引擎重启之间照样能读屏和代点击。所以撤销必须在下一次动作前生效。
 *
 * 三条不变式：
 * 1. 每次重解析都走 `hardenExternalPolicy(raw, now)`——手改 JSON 放宽不了，
 *    且 `now` 是调用时刻，到期授权在重解析时连开关一起收回；
 * 2. **fail-closed**：文件消失 / 写了一半 / JSON 损坏 → 回落「默认全关」，
 *    绝不保留上一次的有效授权（否则删掉文件反而绕过了撤销）；
 * 3. 用**内容签名**而非 mtime 判变更：编辑器原子写、mtime 精度、时钟回拨
 *    都会让 mtime 探测漏判；策略文件只有几百字节，每次读全文算 sha256 更可靠。
 *
 * 不引入后台定时器：没有工具调用时策略新旧无所谓，而定时器在 stdio 进程里
 * 只会带来「重载到一半」的中间态。同步、按调用触发，最容易被测试锁住。
 */
export class PolicyReloader {
  constructor({
    path,
    source = "shell",
    read = readFileSync,
    clock = () => Date.now(),
    onReload = null,
    onError = null,
  } = {}) {
    if (!path || typeof path !== "string") throw new Error("PolicyReloader 需要策略文件路径");
    this.path = path;
    this.source = source;
    this.read = read;
    this.clock = clock;
    this.onReload = onReload;
    this.onError = onError;
    /** 上次成功解析的内容签名（null = 无有效缓存，下次必须重新解析） */
    this.signature = null;
    this.policy = null;
    this.revision = 0;
    this.lastFailure = null;
  }

  static hash(text) {
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
  }

  /** 视觉授权到期后要连「开关」一起收回，不能只靠 PolicyGuard 在动作时拒绝 */
  #visionExpired() {
    const expiresAt = Number(this.policy?.visionExpiresAt) || 0;
    return expiresAt > 0 && this.clock() >= expiresAt;
  }

  /** @returns {{changed:boolean, policy:object, reason:string, revision:number, failed:boolean}} */
  #fail(reason) {
    const first = this.lastFailure !== reason;
    this.lastFailure = reason;
    // 缓存作废是这里最关键的一行：文件恢复后必须重新解析，不能沿用旧授权
    this.signature = null;
    this.policy = defaultPolicy();
    if (first) {
      this.revision += 1;
      this.onError?.(reason);
    }
    return {
      changed: first,
      policy: this.policy,
      reason: `fail-closed:${reason}`,
      revision: this.revision,
      failed: true,
    };
  }

  current() {
    let text;
    try {
      text = this.read(this.path, "utf8");
    } catch (e) {
      return this.#fail(`unreadable:${e?.code ?? e?.message ?? "unknown"}`);
    }
    if (typeof text !== "string") return this.#fail("non-string-content");

    const signature = PolicyReloader.hash(text);
    const needParse =
      this.policy === null || signature !== this.signature || this.#visionExpired();
    if (!needParse) {
      return { changed: false, policy: this.policy, reason: "unchanged", revision: this.revision, failed: false };
    }

    let policy;
    try {
      policy = hardenExternalPolicy(JSON.parse(text), this.clock());
    } catch (e) {
      return this.#fail(`invalid-policy:${e?.message ?? String(e)}`);
    }

    const reason =
      this.policy === null
        ? "initial"
        : signature === this.signature
          ? "vision-expired"
          : "content-changed";
    this.signature = signature;
    this.policy = policy;
    this.lastFailure = null;
    this.revision += 1;
    this.onReload?.({
      revision: this.revision,
      reason,
      enabled: policy.enabled,
      allowScreenshot: policy.allowScreenshot,
      allowCoordinateInput: policy.allowCoordinateInput,
      visionAppCount: policy.visionApps.length,
    });
    return { changed: true, policy, reason, revision: this.revision, failed: false };
  }
}
