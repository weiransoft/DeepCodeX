/**
 * Perception —— 观察层（方案 §1.2 / §3.3 结论 3）。
 *
 * 三条硬规则：
 * 1. **默认不用视觉**：先 snapshot（a11y 树）；只有树为空 / 自绘界面 /
 *    策略允许，才 screenshot，并把坐标吸附到最近的 a11y 节点。
 * 2. **稳定 ref 绑定 snapshotId**：跨快照复用旧 ref 一律 STALE_REF，
 *    绝不按旧坐标盲点（R4 不可逆误动作）。
 * 3. **骨架 + 下钻 + 局部观察**：大窗口先给浅层骨架，超深度预算返回
 *    boundary 标记而不是硬失败。
 */

import { ErrorCode, AgentError } from "../errors.mjs";
import { detectInjection } from "./policy-guard.mjs";
import { assessTree } from "./tree-quality.mjs";

function flatten(nodes, out = []) {
  for (const n of nodes ?? []) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
}

/** 收集树里的可见文本，供 PolicyGuard 做提示注入扫描（只传文本，不传整棵树） */
export function collectUntrustedTexts(tree) {
  return flatten(tree)
    .map((n) => [n.name, n.value].filter((v) => typeof v === "string" && v.length > 0).join(" "))
    .filter(Boolean);
}

/**
 * 把视觉预测坐标吸附到最近的 a11y bounding box（方案 §1.2 双流融合）。
 * 返回 { x, y, snappedTo, distance }；树为空时原样返回并标注未吸附。
 */
export function snapToNearestElement(tree, x, y, maxDistance = 80) {
  const candidates = flatten(tree).filter(
    (n) => n.rect && n.rect.width > 0 && n.rect.height > 0
  );
  if (candidates.length === 0) return { x, y, snappedTo: null, distance: null };
  let best = null;
  for (const n of candidates) {
    const r = n.rect;
    const cx = Math.min(Math.max(x, r.x), r.x + r.width);
    const cy = Math.min(Math.max(y, r.y), r.y + r.height);
    const d = Math.hypot(x - cx, y - cy);
    if (!best || d < best.distance) {
      best = { ref: n.ref, name: n.name, x: cx, y: cy, distance: d };
    }
  }
  if (!best || best.distance > maxDistance) return { x, y, snappedTo: null, distance: best?.distance ?? null };
  return { x: best.x, y: best.y, snappedTo: best.ref, distance: best.distance };
}

export class Perception {
  constructor(backend, options = {}) {
    this.backend = backend;
    this.policy = options.policy;
    this.budget = options.budget;
    this.telemetry = options.telemetry;
    /** snapshotId -> {appId, tree, createdAt, texts}；LRU 上限防止无限增长 */
    this.snapshots = new Map();
    this.maxSnapshots = options.maxSnapshots ?? 8;
    this.current = null;
    /** 观察后回写树质量（registry 据此修正通道判定），签名 (app, quality) */
    this.onQuality = options.onQuality ?? null;
  }

  /** 当前有效快照 id（Verifier 与 Actuator 据此判定 ref 新鲜度） */
  currentSnapshotId() {
    return this.current;
  }

  invalidate(snapshotId) {
    this.snapshots.delete(snapshotId);
    if (this.current === snapshotId) this.current = null;
  }

  invalidateAll() {
    this.snapshots.clear();
    this.current = null;
    if (typeof this.backend.invalidateSnapshots === "function") this.backend.invalidateSnapshots();
  }

  /** 取观察：树优先，空树时按策略决定是否视觉兜底 */
  async observe({ app, maxDepth = 2, skeleton = true, allowVisualFallback = false } = {}) {
    const started = Date.now();
    this.budget?.charge({ steps: 1 });

    let result;
    try {
      result = await this.backend.snapshot({ appId: app.appId, pid: app.pid, hwnd: app.hwnd, maxDepth, skeleton });
    } catch (err) {
      if (err?.code === ErrorCode.OBSERVATION_FAILED || err?.code === ErrorCode.CAPABILITY_UNAVAILABLE) {
        this.telemetry?.emit("observe.fallback", { appId: app.appId, code: err.code });
        return {
          ok: false,
          code: err.code,
          message: err.message,
          recoverable: err.recoverable !== false,
          hint: "重取观察 / 换通道 / 明确认输交还控制权",
          elapsedMs: Date.now() - started,
        };
      }
      throw err;
    }

    const tree = result.tree ?? [];
    this.snapshots.set(result.snapshotId, {
      appId: app.appId,
      /** 送进模型上下文的可见树（骨架） */
      tree,
      /** 内部完整树：只用于 rootRef 下钻，绝不回传模型（token 治理） */
      fullTree: result.fullTree ?? tree,
      /** 可见 ref 集合：模型只能操作它「看到过」的元素（防越权点击） */
      visibleRefs: new Set(flatten(tree).map((n) => n.ref)),
      createdAt: result.createdAt ?? Date.now(),
    });
    if (this.snapshots.size > this.maxSnapshots) {
      this.snapshots.delete(this.snapshots.keys().next().value);
    }
    this.current = result.snapshotId;

    const texts = collectUntrustedTexts(tree);
    const injections = texts.flatMap(detectInjection);
    // 用实测树质量判定通道，而不是靠进程名猜（Electron 应用的进程名里
    // 并没有 "electron"，猜不出来）。结论回写注册表，后续 channelMatrix 生效。
    // 判定依据用**完整树**（桥已回传，比骨架深 2 层），避免骨架截断造成的
    // 假阳性；只有节点预算被耗尽（真没看全）才降级为 deferred。
    const qualityTree = result.fullTree ?? tree;
    const treeQuality = assessTree(qualityTree, {
      complete: (result.nodeCount ?? flatten(qualityTree).length) < 1400,
    });
    this.onQuality?.(app, treeQuality);
    this.telemetry?.emit("observe.snapshot", {
      appId: app.appId,
      snapshotId: result.snapshotId,
      source: result.source,
      nodeCount: result.nodeCount,
      truncated: Boolean(result.truncated),
      injectionHits: injections.length,
      treeVerdict: treeQuality.verdict,
      elapsedMs: result.elapsedMs ?? Date.now() - started,
    });

    const payload = {
      ok: true,
      snapshotId: result.snapshotId,
      appId: app.appId,
      source: result.source,
      tree,
      nodeCount: result.nodeCount,
      truncated: Boolean(result.truncated),
      boundary: result.boundary,
      /** 实测树质量：sparse/empty 时必须换通道或视觉兜底，别硬按名字点 */
      treeQuality,
      /** UI 文本进入模型上下文前必须按不可信内容处理（R1） */
      untrusted: true,
      injectionHits: injections.length,
      elapsedMs: Date.now() - started,
    };

    // 空树 → 视觉兜底（默认关闭，需策略显式允许）
    if (tree.length === 0) {
      payload.emptyTree = true;
      payload.hint = "a11y 树为空（自绘/Electron/游戏）；按三级降级链考虑视觉兜底或换通道";
      if (allowVisualFallback && this.policy?.policy?.allowScreenshot) {
        payload.visualFallback = await this.screenshot({ app, reason: "a11y-tree-empty" });
      }
    } else if (treeQuality.verdict === "sparse") {
      // 树非空但指认不了目标：换通道（视觉）或明确拒绝，别在同一棵树里反复重试
      payload.hint = `${treeQuality.reason}；可先 drillDown 展开容器，或改走视觉通道`;
    } else if (treeQuality.verdict === "deferred") {
      // 还没看全：先下钻，此时换视觉通道是浪费（也是误判）
      payload.hint = `${treeQuality.reason}；请对容器节点 drillDown 后再找目标`;
    }
    return payload;
  }

  /**
   * 按 rootRef 下钻：从**内部完整树**取子树，不重新遍历 OS，也不把整棵树
   * 塞进上下文（token 治理）。下钻展开的节点才加入 visibleRefs——模型
   * 只能操作它「看到过」的元素，防止拿隐藏 ref 越权点击。
   */
  drillDown(snapshotId, rootRef, maxDepth = 3) {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) {
      throw new AgentError(ErrorCode.STALE_REF, `快照 ${snapshotId} 已失效，请重新 snapshot`);
    }
    if (!snap.visibleRefs.has(rootRef)) {
      throw new AgentError(ErrorCode.OBSERVATION_FAILED, `rootRef ${rootRef} 尚未在可见树中，请先展开其父节点`);
    }
    const source = snap.fullTree ?? snap.tree;
    const root = flatten(source).find((n) => n.ref === rootRef);
    if (!root) {
      throw new AgentError(ErrorCode.OBSERVATION_FAILED, `rootRef ${rootRef} 不在快照中`);
    }
    const cut = (n, d) => ({
      ...n,
      children: d < maxDepth ? (n.children ?? []).map((c) => cut(c, d + 1)) : [],
      truncated: d >= maxDepth && (n.children ?? []).length > 0,
    });
    const subtree = [cut(root, 0)];
    for (const n of flatten(subtree)) snap.visibleRefs.add(n.ref);
    // 同步更新可见树，保证后续 assertFresh 与下钻结果一致
    const visibleNode = flatten(snap.tree).find((n) => n.ref === rootRef);
    if (visibleNode) {
      visibleNode.children = subtree[0].children;
      delete visibleNode.truncated;
    }
    this.telemetry?.emit("observe.drilldown", {
      snapshotId,
      rootRef,
      maxDepth,
      visibleRefs: snap.visibleRefs.size,
    });
    return { ok: true, snapshotId, rootRef, tree: subtree, untrusted: true };
  }

  /** 截图：默认不落盘、不把 base64 写进事件流 */
  async screenshot({ app, reason = "" } = {}) {
    if (!this.policy?.policy?.allowScreenshot) {
      throw new AgentError(ErrorCode.CAPABILITY_UNAVAILABLE, "截屏通道默认关闭（树优先）", {
        hint: "仅在 a11y 树为空 / 自绘界面时开启 allowScreenshot",
      });
    }
    this.budget?.charge({ screenshots: 1, steps: 1 });
    const shot = await this.telemetry.measure("observe.screenshot", { appId: app?.appId, reason }, () =>
      this.backend.screenshot({ reason, appId: app?.appId, pid: app?.pid, hwnd: app?.hwnd })
    );
    // 只回传元数据；base64 交给调用方按需消费，绝不经 Telemetry 落盘
    this.current && this.snapshots.has(this.current) && (this.snapshots.get(this.current).lastScreenshot = {
      width: shot.width,
      height: shot.height,
      bytes: shot.bytes ?? Buffer.byteLength(shot.base64 ?? "", "utf8"),
    });
    return {
      ok: true,
      width: shot.width,
      height: shot.height,
      mimeType: shot.mimeType,
      persisted: false,
      untrusted: true,
      /** 视觉定位后应吸附到最近 a11y 节点 */
      snapHint: "调用 snapToNearestElement(tree, x, y) 后再点击，避免坐标漂移",
    };
  }

  /** 校验 ref 是否属于当前有效快照 */
  assertFresh(snapshotId, ref) {
    if (!this.snapshots.has(snapshotId) || snapshotId !== this.current) {
      throw new AgentError(ErrorCode.STALE_REF, `快照 ${snapshotId} 已失效`, {
        hint: "重新 snapshot 获取新 ref（不要复用旧坐标）",
        ref,
      });
    }
    const snap = this.snapshots.get(snapshotId);
    const hit = flatten(snap.tree).find((n) => n.ref === ref);
    if (!hit) {
      throw new AgentError(ErrorCode.OBSERVATION_FAILED, `ref ${ref} 不在快照 ${snapshotId} 中`);
    }
    return hit;
  }
}
