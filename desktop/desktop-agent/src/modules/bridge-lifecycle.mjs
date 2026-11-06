/**
 * UIA 桥进程生命周期策略（纯逻辑、可注入时钟，便于单测）。
 *
 * 为什么需要它：桥是长驻 `powershell.exe`，一旦初始化成功但随后反复崩溃
 * （典型场景：UIA 在锁屏/会话切换/Secure Desktop 下抛异常），「下一次调用
 * 惰性重启」会变成无限重启风暴——每 200 ms 拉起一个 PowerShell 进程，
 * 既拖垮宿主也刷满日志，而且永远拿不到可用桥。所以必须：
 *   1. 重启要有**指数退避**，不能紧贴崩溃点立刻重拉；
 *   2. 时间窗内崩溃超过上限就**停止自动重启**（`bridge-crash-loop`），
 *      明确交还人工，而不是假装还能用；
 *   3. 桥证明自己稳定（连续存活超过 `stableAfterMs`）后重置窗口，
 *      避免「几天里偶发崩 3 次」被误判成崩溃循环；
 *   4. 连续 ping 失败到阈值就判定**无响应**（进程还在但管道僵死），
 *      需要主动回收重建。
 *
 * 所有判定都返回结构化结果，供 `desktop_capabilities` 的 bridge 段落暴露，
 * 上层据此决定重试 / 降级 / HANDOFF。
 */

export const LIFECYCLE_DEFAULTS = Object.freeze({
  /** 时间窗内允许的最大崩溃重启次数 */
  maxRestarts: 3,
  /** 崩溃计数窗口 */
  restartWindowMs: 120_000,
  /** 连续存活超过该时长即视为稳定，清空崩溃窗口 */
  stableAfterMs: 60_000,
  /** 首次重试退避基数，按 2^n 递增 */
  backoffBaseMs: 200,
  /** 退避上限，避免无限增长 */
  backoffMaxMs: 5_000,
  /** 连续 ping 失败到该次数判定桥无响应 */
  maxConsecutivePingFailures: 3,
});

export class BridgeLifecycle {
  constructor(options = {}) {
    const cfg = { ...LIFECYCLE_DEFAULTS };
    for (const [k, v] of Object.entries(options)) {
      if (v !== undefined && v !== null) cfg[k] = v;
    }
    this.maxRestarts = cfg.maxRestarts;
    this.restartWindowMs = cfg.restartWindowMs;
    this.stableAfterMs = cfg.stableAfterMs;
    this.backoffBaseMs = cfg.backoffBaseMs;
    this.backoffMaxMs = cfg.backoffMaxMs;
    this.maxConsecutivePingFailures = cfg.maxConsecutivePingFailures;
    this.now = cfg.now ?? (() => Date.now());

    /** 窗口内的崩溃时间戳（仅崩溃，不含正常退出） */
    this.crashTimes = [];
    this.totalStarts = 0;
    this.totalCrashes = 0;
    this.totalCleanExits = 0;
    this.startedAt = 0;
    this.lastCrash = null;
    this.lastPing = { ok: null, at: 0, latencyMs: null };
    this.consecutivePingFailures = 0;
    /** 非空表示已停止自动重启：{reason, message, at, crashes, windowMs} */
    this.blocked = null;
  }

  _prune() {
    const cutoff = this.now() - this.restartWindowMs;
    this.crashTimes = this.crashTimes.filter((t) => t >= cutoff);
  }

  /**
   * 启动前的准入判定。首次启动永远放行且不退避；崩溃后的重启受窗口上限与
   * 指数退避约束。`allowed:false` 时调用方必须拒绝启动并抛出可行动错误。
   */
  admitRestart(reason = "unknown") {
    this._prune();
    if (this.blocked) {
      return { allowed: false, reason: "bridge-crash-loop", blocked: { ...this.blocked } };
    }
    if (this.totalStarts === 0) {
      return { allowed: true, firstStart: true, delayMs: 0, crashesInWindow: 0, maxRestarts: this.maxRestarts };
    }
    const crashes = this.crashTimes.length;
    if (crashes >= this.maxRestarts) {
      this.blocked = {
        reason: "bridge-crash-loop",
        message:
          `UIA 桥在 ${Math.round(this.restartWindowMs / 1000)}s 内崩溃 ${crashes} 次，` +
          `已停止自动重启（上限 ${this.maxRestarts}）。请检查交互式桌面会话 / 是否被 UAC、锁屏打断，` +
          `处理后调用 desktop_capabilities 查看，或重启引擎。`,
        at: this.now(),
        crashes,
        windowMs: this.restartWindowMs,
        lastCrashReason: this.lastCrash?.reason ?? null,
      };
      return { allowed: false, reason: "bridge-crash-loop", blocked: { ...this.blocked } };
    }
    // 窗口内没有崩溃 → 无需退避；有崩溃则按 200/400/800ms 递增
    const delayMs =
      crashes === 0 ? 0 : Math.min(this.backoffBaseMs * 2 ** Math.max(0, crashes - 1), this.backoffMaxMs);
    return { allowed: true, delayMs, crashesInWindow: crashes, attempt: crashes + 1, maxRestarts: this.maxRestarts, reason };
  }

  noteStart() {
    this.totalStarts += 1;
    this.startedAt = this.now();
  }

  /** 异常退出（崩溃）：计入窗口；正常退出（shutdown/close）只计数不计入 */
  noteCrash(reason = "unknown") {
    const at = this.now();
    this.totalCrashes += 1;
    this.crashTimes.push(at);
    this.lastCrash = {
      at,
      reason: String(reason).slice(0, 300),
      uptimeMs: this.startedAt ? at - this.startedAt : 0,
    };
    this.startedAt = 0;
  }

  noteCleanExit() {
    this.totalCleanExits += 1;
    this.startedAt = 0;
  }

  /** 稳定运行足够久 → 清空崩溃窗口（返回是否清空过） */
  noteStable() {
    const uptime = this.uptimeMs();
    if (!this.startedAt || uptime < this.stableAfterMs) return false;
    const cleared = this.crashTimes.length > 0;
    this.crashTimes = [];
    // 已证明稳定，解除崩溃循环封锁（例如用户已解锁屏幕后手动重试）
    if (this.blocked) this.blocked = null;
    return cleared;
  }

  notePing(ok, latencyMs = null) {
    this.lastPing = { ok, at: this.now(), latencyMs };
    if (ok) this.consecutivePingFailures = 0;
    else this.consecutivePingFailures += 1;
    return this.consecutivePingFailures;
  }

  /** 进程还在但管道僵死：连续 ping 失败达阈值即应回收重建 */
  shouldRecycle() {
    return this.consecutivePingFailures >= this.maxConsecutivePingFailures;
  }

  uptimeMs() {
    if (!this.startedAt) return 0;
    return Math.max(0, this.now() - this.startedAt);
  }

  isBlocked() {
    return Boolean(this.blocked);
  }

  status() {
    this._prune();
    return {
      healthy: Boolean(this.startedAt) && !this.blocked && this.consecutivePingFailures === 0,
      blocked: Boolean(this.blocked),
      blockedReason: this.blocked?.reason ?? null,
      blockedMessage: this.blocked?.message ?? null,
      totalStarts: this.totalStarts,
      totalCrashes: this.totalCrashes,
      totalCleanExits: this.totalCleanExits,
      crashesInWindow: this.crashTimes.length,
      maxRestarts: this.maxRestarts,
      windowMs: this.restartWindowMs,
      uptimeMs: this.uptimeMs(),
      lastCrash: this.lastCrash,
      lastPing: this.lastPing,
      consecutivePingFailures: this.consecutivePingFailures,
    };
  }

  /** 人工干预后重置（脚本/诊断用，不作为 MCP 工具暴露） */
  reset({ keepCounters = true } = {}) {
    this.crashTimes = [];
    this.blocked = null;
    this.consecutivePingFailures = 0;
    this.lastPing = { ok: null, at: 0, latencyMs: null };
    if (!keepCounters) {
      this.totalStarts = 0;
      this.totalCrashes = 0;
      this.totalCleanExits = 0;
      this.lastCrash = null;
    }
  }
}
