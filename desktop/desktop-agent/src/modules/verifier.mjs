/**
 * Verifier + Actuator —— Observe → Act → Verify 单步闭环（方案 §1.4 / §1.6 / R4）。
 *
 * Actuator 只做「怎么动手」：元素 invoke 优先（不抢焦点），坐标点击兜底。
 * Verifier 只做「怎么确认」：动作后**必须复观察**，比对状态变化，
 * 有界重试（budget.maxRetries），不可恢复异常明确认输交还（HANDOFF_REQUIRED）。
 * 两者都不做任务规划（职责红线：L4 不规划）。
 */

import { ErrorCode, AgentError } from "../errors.mjs";
import { diffSignatures } from "./pixel-signature.mjs";

/** 坐标帧过期阈值：窗口挪过之后旧帧就不可信，宁可要求重截 */
const FRAME_MAX_AGE_MS = 120_000;

export class Actuator {
  constructor(backend, deps) {
    this.backend = backend;
    this.perception = deps.perception;
    this.policy = deps.policy;
    this.budget = deps.budget;
    this.telemetry = deps.telemetry;
  }

  /** 统一动作入口；返回后端结果 */
  async act({ app, action, snapshotId, ref, x, y, value, combo, confirmationToken, snapTo, frame, allowOutside, maxSnapDistance }) {
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
          const { resolveClickPoint, frameContains } = await import("./coords.mjs");
          const shot = this.perception.lastShot();
          if (!shot?.frame && (frame ?? "window") === "window") {
            throw new AgentError(ErrorCode.OBSERVATION_FAILED, "还没有可用截图，无法把图像坐标换算成屏幕坐标", {
              hint: "先 desktop_screenshot 再点；或显式传 frame:\"screen\" 直接给屏幕坐标",
              recoverable: true,
            });
          }
          if (shot?.frame && Date.now() - shot.at > FRAME_MAX_AGE_MS) {
            throw new AgentError(ErrorCode.OBSERVATION_FAILED, "截图坐标帧已过期（窗口可能已移动），拒绝按旧坐标点击", {
              hint: "重新 desktop_screenshot 后再点",
              recoverable: true,
            });
          }
          // 1) 坐标帧换算 + 越界拒绝：图像像素 → 屏幕坐标。
          //    这一步没做的话，图像 (0,0) 会被当成屏幕 (0,0)，整块偏移一个窗口原点。
          const point = resolveClickPoint({
            x,
            y,
            frame: frame ?? "window",
            shot: shot?.frame,
            allowOutside: Boolean(allowOutside),
          });
          // 2) 吸附**必须在换算之后**：树的 rect 在屏幕坐标系里，先吸附会吸到错元素
          const nearest = snapToNearestElement(snap?.tree ?? [], point.x, point.y, maxSnapDistance ?? 80);
          const fx = Number.isFinite(nearest.x) ? nearest.x : point.x;
          const fy = Number.isFinite(nearest.y) ? nearest.y : point.y;
          if (!allowOutside && point.windowRect && !frameContains(point.windowRect, fx, fy)) {
            throw new AgentError(ErrorCode.ACTION_DENIED, "吸附后的落点仍在目标窗口外，拒绝点击", {
              hint: "坐标可能来自别的窗口；重新截图确认",
              resolved: { x: fx, y: fy },
              windowRect: point.windowRect,
            });
          }
          const res = await this.backend.clickXY({ ...target, x: fx, y: fy, snapTo: snapTo ?? nearest.snappedTo });
          return {
            ...res,
            // 落点来源要写清楚：converted=做过帧换算；blind=树上没有可吸附节点（纯盲点）
            frame: point.frame,
            converted: point.converted,
            scaleX: point.scaleX,
            windowRect: point.windowRect,
            requested: { x, y },
            resolved: { x: fx, y: fy },
            snapped: nearest.snappedTo ?? null,
            snapDistance: nearest.distance ?? null,
            blind: !nearest.snappedTo,
          };
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
    this.policy = deps.policy;
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

  /**
   * 取 64×64 灰度签名。取不到就返回 null，让验证退回结构证据——
   * 视觉验效是**补强**，不是新依赖：锁屏、安全桌面、策略关闭时不能因此崩掉整步。
   */
  async pixelSignature(app, { activate = false } = {}) {
    if (typeof this.backend.pixelSignature !== "function") return null;
    if (!this.policy?.policy?.allowScreenshot) return null;
    // 不按「截图」计费：签名是 4 KB 灰度网格，不是感知截图；按截图扣会让
    // 视觉兜底在 maxScreenshots=3 的预算下两步就熔断。上界仍由 maxSteps 兜住
    // （每个 click_xy 步固定 2 次），预算并没有因此失去约束。
    try {
      const shot = await this.backend.pixelSignature({
        appId: app?.appId,
        pid: app?.pid,
        hwnd: app?.hwnd,
        activate,
      });
      return shot?.base64 ?? null;
    } catch (err) {
      this.telemetry.emit("verify.pixel_unavailable", { appId: app?.appId, code: err?.code });
      return null;
    }
  }

  /**
   * 动作前后各取一次状态。坐标点击额外挂上像素签名：
   * 这类动作的典型场景就是「树指认不了目标」（任务管理器/字符映射表/系统信息/磁盘清理），
   * 这些应用的树在点击前后**完全一样**，只靠结构证据的话每一步都会被判 verify-failed。
   */
  async readStateFor(app, action, { activate = false, stability = false } = {}) {
    const base = await this.readState();
    if (action !== "click_xy") return base;
    const pixels = await this.pixelSignature(app, { activate });
    if (!pixels) return base;
    const out = { ...(base ?? {}), pixels };
    if (stability) {
      // 再取一帧，用「两帧静止画面之间的差」估计噪声。
      // 界面还在动（窗口刚出现、列表在滚动、动画未结束）时，动作前后的差
      // 根本证明不了是动作造成的——这时必须如实说「像素不可信」，退回结构证据，
      // 而不是把动画当成生效（假阳性）。
      const again = await this.pixelSignature(app, { activate });
      if (again) {
        out.pixelStable = !diffSignatures(pixels, again).changed;
        // 用后一帧当基线：即使略有抖动，也是更接近「动作前一刻」的画面
        out.pixels = again;
      }
    }
    return out;
  }

  /**
   * 逐项比对：结构证据与像素证据分开算，再取「任一有变化」。
   * 分开算是为了让失败可诊断——「结构变了但像素没变」（tooltip）与
   * 「像素变了但结构没变」（自绘界面）是完全不同的两件事。
   */
  compare(before, after) {
    if (!before || !after) return { changed: true, treeChanged: null, pixelChanged: null, evidence: "no-state" };
    const { pixels: pb, pixelStable, ...restB } = before;
    const { pixels: pa, ...restA } = after;
    const treeChanged = JSON.stringify(restB) !== JSON.stringify(restA);
    let pixelChanged = null;
    let pixelNote;
    if (pixelStable === false) {
      // 基线自身在动 → 像素差异没有归因价值
      pixelNote = "unstable-baseline";
    } else if (typeof pb === "string" && typeof pa === "string") {
      try {
        pixelChanged = diffSignatures(pb, pa).changed;
      } catch {
        pixelChanged = null;
        pixelNote = "signature-invalid";
      }
    }
    return {
      changed: treeChanged || pixelChanged === true,
      treeChanged,
      pixelChanged,
      pixelNote,
      evidence: pixelChanged === null ? "tree" : "tree+pixels",
    };
  }

  /** 两个状态是否发生了可观察变化 */
  changed(before, after) {
    return this.compare(before, after).changed;
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

      // 动作前先确保目标在前台：否则 before 与 after 量的是同一个遮挡物，
      // 会得出「改了」或「没改」的随机结论
      const before = await this.readStateFor(app, args.action, { activate: true, stability: true });
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
      const after = await this.readStateFor(app, args.action);
      const diff = this.compare(before, after);
      const changed = diff.changed;
      const ok = !expectChange || changed;
      const observation = await this.perception.observe({ app });
      const result = {
        ok,
        code: ok ? undefined : ErrorCode.VERIFY_FAILED,
        action: {
          ok: true,
          via: actResult?.via,
          ref: args.ref,
          ...(args.action === "click_xy"
            ? {
                frame: actResult?.frame,
                converted: actResult?.converted,
                resolved: actResult?.resolved,
                snapped: actResult?.snapped,
                blind: actResult?.blind,
              }
            : {}),
        },
        verification: {
          changed,
          expectChange,
          // 证据类型与分项结果：像素为 null 表示这一步没有像素通道（只看了结构）
          evidence: diff.evidence,
          treeChanged: diff.treeChanged,
          pixelChanged: diff.pixelChanged,
          pixelNote: diff.pixelNote,
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
      // 「动作成功但界面没变」不等于「已验证」：保存/复制这类幂等动作本来就不改
      // 界面，必须与「确认生效」区分开，由调用方用副作用（文件、剪贴板）自证。
      const outcome = ok ? (changed ? "verified" : "verified-no-change") : "verify-failed";
      return this.finish(result, attempt, outcome);
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
