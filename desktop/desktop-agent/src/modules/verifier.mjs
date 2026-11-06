/**
 * Verifier + Actuator —— Observe → Act → Verify 单步闭环（方案 §1.4 / §1.6 / R4）。
 *
 * Actuator 只做「怎么动手」：元素 invoke 优先（不抢焦点），坐标点击兜底。
 * Verifier 只做「怎么确认」：动作后**必须复观察**，比对状态变化，
 * 有界重试（budget.maxRetries），不可恢复异常明确认输交还（HANDOFF_REQUIRED）。
 * 两者都不做任务规划（职责红线：L4 不规划）。
 */

import { ErrorCode, AgentError } from "../errors.mjs";

export class Actuator {
  constructor(backend, deps) {
    this.backend = backend;
    this.perception = deps.perception;
    this.policy = deps.policy;
    this.budget = deps.budget;
    this.telemetry = deps.telemetry;
  }

  /** 统一动作入口；返回后端结果 */
  async act({ app, action, snapshotId, ref, x, y, value, combo, confirmationToken, snapTo }) {
    // 1) 取当前观察文本做提示注入扫描（R1）
    const snap = this.perception.snapshots.get(this.perception.currentSnapshotId());
    let texts = [];
    if (snap) {
      const { collectUntrustedTexts } = await import("./perception.mjs");
      texts = collectUntrustedTexts(snap.tree);
    }

    // 2) 策略硬校验（应用白名单 / 动作分级 / 不可逆确认）
    const reversible = !(action === "submit" || action === "send" || action === "delete");
    this.policy.authorize({
      app,
      action,
      reversible,
      confirmationToken,
      observedTexts: texts,
      scope: "write",
    });

    // 3) 预算预扣
    this.budget.charge({ steps: 1 });

    // 4) ref 新鲜度（STALE_REF 硬拦）
    if (ref) this.perception.assertFresh(snapshotId, ref);

    const common = { appId: app.appId, action };
    const target = { appId: app.appId, pid: app.pid, hwnd: app.hwnd, snapshotId };
    return this.telemetry.measure("act", common, async () => {
      switch (action) {
        case "click_ref":
        case "invoke":
          return this.backend.invokeRef({ ...target, ref, action, value });
        case "click_xy": {
          const { snapToNearestElement } = await import("./perception.mjs");
          const tree = snap?.tree ?? [];
          const nearest = snapToNearestElement(tree, x, y);
          return this.backend.clickXY({
            ...target,
            x: Number.isFinite(nearest.x) ? nearest.x : x,
            y: Number.isFinite(nearest.y) ? nearest.y : y,
            snapTo: snapTo ?? nearest.snappedTo,
          });
        }
        case "type":
          return this.backend.typeText({ ...target, text: String(value ?? ""), ref });
        case "key":
          return this.backend.sendKey({ ...target, combo: String(combo ?? "") });
        default:
          throw new AgentError(ErrorCode.INVALID_ARGUMENT, `未知动作：${action}`);
      }
    });
  }
}

export class Verifier {
  constructor(backend, deps) {
    this.backend = backend;
    this.actuator = deps.actuator;
    this.perception = deps.perception;
    this.budget = deps.budget;
    this.telemetry = deps.telemetry;
    this.maxRetries = deps.maxRetries ?? 2;
  }

  /** 快照当前界面状态；后端不支持时退化为「动作返回 ok 即算通过」 */
  async readState() {
    if (typeof this.backend.observeState !== "function") return null;
    try {
      return await this.backend.observeState();
    } catch {
      return null;
    }
  }

  /** 两个状态是否发生了可观察变化 */
  changed(before, after) {
    if (!before || !after) return true;
    return JSON.stringify(before) !== JSON.stringify(after);
  }

  /**
   * 单步闭环：观察 → 动作 → 复观察 → 验证。
   * 失败时按错误类型决定：重取观察 / 有界重试 / 明确认输。
   */
  async step(args) {
    const { app, expectChange = true } = args;

    // 入口硬拦：调用方显式携带的 snapshotId 必须仍是当前快照。
    // 界面可能已变化，旧 ref 在新界面里可能指向完全不同的元素（例如
    // 旧 b1 是「保存」、新 b1 是「删除」），因此**不允许**静默重取后
    // 复用旧 ref 执行。重取与目标再确认的决策上交给编排层（STALE_REF）。
    if (args.snapshotId && args.snapshotId !== this.perception.currentSnapshotId()) {
      const stale = new AgentError(ErrorCode.STALE_REF, "快照已失效，请重新 snapshot 并确认目标", {
        hint: "界面可能已变化；不要复用旧 ref 或旧坐标",
      });
      this.telemetry.emit("verify.stale_ref", { appId: app.appId, snapshotId: args.snapshotId });
      return this.finish(stale.toJSON(), 1, "stale-ref");
    }

    let attempt = 0;

    for (;;) {
      attempt += 1;
      // 每次重试前重新取观察，避免用旧 ref 盲点（STALE_REF 的正确处置）
      if (attempt > 1) {
        this.perception.invalidateAll();
        const fresh = await this.perception.observe({ app });
        if (!fresh.ok) {
          return this.finish(fresh, attempt, "observe-failed");
        }
        args.snapshotId = fresh.snapshotId;
      }

      const before = await this.readState();
      let actResult;
      try {
        actResult = await this.actuator.act(args);
      } catch (err) {
        if (err instanceof AgentError && !err.recoverable) {
          // 不可恢复：验证码/UAC/授权/注入/预算 → 明确认输交还
          this.telemetry.emit("verify.handoff", { appId: app.appId, code: err.code, attempt });
          return this.finish(err.toJSON(), attempt, "handoff");
        }
        if (err instanceof AgentError && err.code === ErrorCode.STALE_REF && attempt <= this.maxRetries) {
          this.budget.charge({ retries: 1 });
          continue;
        }
        throw err;
      }

      if (actResult?.ok === false) {
        if (attempt <= this.maxRetries) {
          this.telemetry.emit("verify.retry", { appId: app.appId, attempt, reason: actResult.error });
          this.budget.charge({ retries: 1 });
          continue;
        }
        return this.finish(
          { ok: false, code: ErrorCode.VERIFY_FAILED, message: "动作未生效且重试用尽", action: actResult },
          attempt,
          "verify-failed"
        );
      }

      // 复观察：动作后必须确认状态真的变了（R4）
      const after = await this.readState();
      const ok = !expectChange || this.changed(before, after);
      const observation = await this.perception.observe({ app });
      const result = {
        ok,
        code: ok ? undefined : ErrorCode.VERIFY_FAILED,
        action: { ok: true, via: actResult?.via, ref: args.ref },
        verification: {
          changed: this.changed(before, after),
          expectChange,
          postActionSnapshotId: observation?.snapshotId,
        },
        attempts: attempt,
        untrusted: true,
      };
      if (!ok && attempt <= this.maxRetries) {
        this.telemetry.emit("verify.retry", { appId: app.appId, attempt, reason: "no-state-change" });
        this.budget.charge({ retries: 1 });
        continue;
      }
      return this.finish(result, attempt, ok ? "verified" : "verify-failed");
    }
  }

  finish(result, attempts, outcome) {
    this.telemetry.emit("verify.step", {
      outcome,
      attempts,
      ok: result?.ok === true,
      code: result?.code,
    });
    // attempts 是「有界重试 / 明确认输」的可观测凭证，所有出口统一注入
    return { ...result, attempts, outcome };
  }
}
