/**
 * Mock 感知/动作后端。
 *
 * 用途：在**无桌面会话、无系统权限**的环境（CI / 当前受限沙箱）里，
 * 完整驱动 Observe → Act → Verify、STALE_REF、树为空降级、预算熔断、
 * 提示注入拦截等全部逻辑的测试。它模拟的是「界面状态」，不是假的返回值：
 * invokeRef / typeText 会真的改变内部状态，Verifier 的复观察能看到变化。
 *
 * 生产运行时不会选中该后端（index.mjs 默认 windows / auto）。
 */

const APPS = [
  { appId: "notepad", processName: "Notepad.exe", title: "无标题 - 记事本", category: "productivity" },
  { appId: "explorer", processName: "explorer.exe", title: "文件资源管理器", category: "filesystem" },
  { appId: "browser", processName: "msedge.exe", title: "示例页面 - Edge", category: "browser" },
  { appId: "canvas-app", processName: "selfdrawn.exe", title: "自绘界面应用", category: "selfdrawn-likely" },
  { appId: "banking", processName: "bankclient.exe", title: "网上银行", category: "finance" },
];

/** 构造一棵带语义的 a11y 树（自绘应用刻意返回空树） */
function buildTree(appId, { treeEmpty = false } = {}) {
  if (treeEmpty || appId === "canvas-app") return [];
  const mk = (ref, role, name, x, y, w, h, extra = {}) => ({
    ref,
    role,
    name,
    rect: { x, y, width: w, height: h },
    depth: 0,
    children: [],
    ...extra,
  });
  const root = mk("w1", "window", appId, 0, 0, 1280, 800);
  const toolbar = mk("t1", "toolbar", "工具栏", 0, 0, 1280, 48);
  toolbar.children = [
    mk("b1", "button", "新建", 8, 8, 80, 32, { enabled: true }),
    mk("b2", "button", "保存", 96, 8, 80, 32, { enabled: true }),
  ];
  const body = mk("p1", "pane", "内容区", 0, 48, 1280, 752);
  body.children = [
    mk("e1", "edit", "文本输入", 16, 64, 900, 40, {
      value: "",
      focused: true,
      controlType: "edit",
    }),
    mk("b3", "button", "提交", 940, 64, 120, 40, { enabled: true }),
    mk("l1", "text", "状态：就绪", 16, 120, 400, 24),
  ];
  root.children = [toolbar, body];
  const setDepth = (n, d) => {
    n.depth = d;
    for (const c of n.children) setDepth(c, d + 1);
  };
  setDepth(root, 0);
  return [root];
}

function flatten(nodes, out = []) {
  for (const n of nodes) {
    out.push(n);
    flatten(n.children ?? [], out);
  }
  return out;
}

function cloneTree(nodes) {
  return nodes.map((n) => ({ ...n, rect: { ...n.rect }, children: cloneTree(n.children ?? []) }));
}

export class MockBackend {
  constructor(options = {}) {
    this.name = "mock";
    this.clock = options.clock ?? (() => Date.now());
    /** 坐标帧用的窗口矩形：测试可以给它一个非原点 origin，验证坐标换算真的在算 */
    this.rect = options.rect ?? { x: 0, y: 0, width: 1280, height: 800 };
    this.snapshotSeq = 0;
    this.snapshots = new Map();
    this.state = {
      text: "",
      status: "就绪",
      submitted: false,
      clicks: 0,
      keys: [],
    };
    /** 故障注入：测试可精确制造方案 §1.6 的可恢复/不可恢复异常 */
    this.faults = {
      treeEmpty: false,
      failNextAction: 0,
      observeThrows: "",
      handoffOnAction: "",
      injectionText: "",
      mutateOnObserve: false,
      /** 窗口在会话中途被关闭：观察/动作都 OBSERVATION_FAILED（可恢复） */
      windowClosed: false,
      /** 目标进程崩溃退出：HANDOFF_REQUIRED（不可恢复，必须交还人工） */
      appExited: false,
      /** 坐标点击「点了但界面没变」：模拟点空 / 点错，验证视觉验效会不会误报通过 */
      silentClick: false,
      /** 每次签名都不同：模拟界面还在动画/渲染，用来验证「基线不稳就不信像素」 */
      signatureJitter: false,
    };
    this.appTrees = new Map();
  }

  /**
   * 会话中途目标消失的统一出口。
   * 「窗口关了」和「进程崩了」处置不同：前者可重开重试，后者必须交还
   * 控制权（可能伴随数据丢失），错误码混用会让上层做出错误决策。
   */
  async _assertAlive() {
    if (this.faults.appExited) {
      const { AgentError, ErrorCode } = await import("../errors.mjs");
      throw new AgentError(ErrorCode.HANDOFF_REQUIRED, "目标进程已退出，交还人工确认");
    }
    if (this.faults.windowClosed) {
      const { AgentError, ErrorCode } = await import("../errors.mjs");
      throw new AgentError(ErrorCode.OBSERVATION_FAILED, "目标窗口已关闭，需重新打开");
    }
  }

  capabilities() {
    return {
      platform: "mock",
      appEnumeration: { supported: true, reason: "in-memory app registry" },
      a11yTree: { supported: true, reason: "synthetic semantic tree" },
      screenshot: { supported: true, reason: "synthetic placeholder (no pixels)" },
      pixelDiff: { supported: true, reason: "state-derived 64×64 grayscale signature", grid: 64 },
      elementInvoke: { supported: true, reason: "in-memory state mutation" },
      coordinateInput: { supported: true, reason: "in-memory state mutation" },
      foregroundControl: { supported: false, reason: "not applicable" },
      uacAwareness: { supported: false, reason: "not applicable" },
    };
  }

  async listApps() {
    return APPS.map((a) => ({ ...a, pid: 1000 + APPS.indexOf(a), hwnd: `0x${(100 + APPS.indexOf(a)).toString(16)}` }));
  }

  async snapshot({ appId = "notepad", maxDepth = 2, skeleton = false } = {}) {
    await this._assertAlive();
    if (this.faults.observeThrows) {
      const code = this.faults.observeThrows;
      this.faults.observeThrows = "";
      const { AgentError } = await import("../errors.mjs");
      throw new AgentError(code, `mock 注入观察失败：${code}`);
    }
    if (this.faults.mutateOnObserve) this.state.status = `已变更-${this.clock()}`;

    const raw = cloneTree(buildTree(appId, { treeEmpty: this.faults.treeEmpty }));
    const snapshotId = `snap-${++this.snapshotSeq}`;

    // 骨架树：只保留到 maxDepth，被裁掉的节点记入 boundary（方案 §1.2 局部观察）
    const limit = (nodes, d) =>
      nodes.map((n) => {
        const kept = { ...n, children: [] };
        if (d < maxDepth) kept.children = limit(n.children ?? [], d + 1);
        else if ((n.children ?? []).length > 0) kept.truncated = true;
        return kept;
      });
    const tree = skeleton ? limit(raw, 0) : limit(raw, 0);
    const all = flatten(raw);
    const visible = flatten(tree);
    const truncated = visible.length < all.length;

    if (this.faults.injectionText) {
      const target = visible.find((n) => n.role === "text") ?? visible[0];
      if (target) {
        target.name = `${target.name} ${this.faults.injectionText}`;
        target.untrusted = true;
      }
    }

    this.snapshots.set(snapshotId, {
      appId,
      createdAt: this.clock(),
      refs: new Set(visible.map((n) => n.ref)),
      tree: raw,
    });
    return {
      snapshotId,
      appId,
      source: tree.length === 0 ? "empty" : "a11y",
      tree,
      /** 完整树留在 sidecar 内部供 rootRef 下钻，**不**送进模型上下文 */
      fullTree: raw,
      nodeCount: visible.length,
      totalNodeCount: all.length,
      truncated,
      boundary: truncated ? "depth-budget-exhausted; call snapshot with rootRef to drill down" : null,
      elapsedMs: 1,
      untrusted: true, // UI 文本一律标记不可信（R1）
    };
  }

  async screenshot({ reason = "" } = {}) {
    // 不产生真实像素、不落盘（R2）。返回元数据 + 占位，供上层做「视觉兜底」流程测试。
    // rect 必须给：坐标帧换算（图像坐标 → 屏幕坐标）全靠它。
    return {
      mimeType: "image/png",
      // 1×1 透明 PNG：假像素，但真 base64——includeImage 这条路径要能真跑通。
      // bytes 必须与 base64 解码后长度一致（70），否则上层按元数据算的字节数是假的
      bytes: 70,
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      // 图像尺寸 = 窗口矩形尺寸（缩放比 1）：mock 不模拟高 DPI，缩放换算由单测覆盖
      width: this.rect.width,
      height: this.rect.height,
      rect: { ...this.rect },
      coords: "image-pixel; origin at rect.x/rect.y",
      reason,
      persisted: false,
      untrusted: true,
    };
  }

  /**
   * 由内部状态派生 64×64 灰度签名：状态变了签名就变，状态没变签名稳定。
   * 这样「像素验效」这条路径在无桌面会话的环境里也能被测到，而不是只能靠真机。
   */
  async pixelSignature() {
    await this._assertAlive();
    const grid = 64;
    this.signatureSeq = (this.signatureSeq ?? 0) + 1;
    const seed = JSON.stringify([
      this.state.status,
      this.state.text,
      this.state.clicks,
      this.state.submitted,
      this.faults.signatureJitter ? this.signatureSeq : 0,
    ]);
    let h = 2166136261;
    for (let i = 0; i < seed.length; i += 1) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    const gray = new Uint8Array(grid * grid);
    for (let i = 0; i < gray.length; i += 1) {
      const x = i % grid;
      const y = (i / grid) | 0;
      let v = 32 + ((x * 7 + y * 13 + (h & 0xff)) % 24);
      if (((x >> 3) + (y >> 3) + (h % 3)) % 5 === 0) v += 90;
      gray[i] = v & 0xff;
    }
    return {
      ok: true,
      grid,
      base64: Buffer.from(gray).toString("base64"),
      width: this.rect.width,
      height: this.rect.height,
      rect: { ...this.rect },
      untrusted: true,
    };
  }

  _resolveRef(snapshotId, ref) {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) {
      return { error: "STALE_REF", message: `快照 ${snapshotId} 不存在或已过期` };
    }
    if (!snap.refs.has(ref)) {
      return { error: "ELEMENT_NOT_FOUND", message: `ref ${ref} 不在当前快照中` };
    }
    return { snap, node: flatten(snap.tree).find((n) => n.ref === ref) };
  }

  async invokeRef({ snapshotId, ref, action = "invoke", value = "" } = {}) {
    await this._assertAlive();
    if (this.faults.handoffOnAction) {
      const { AgentError } = await import("../errors.mjs");
      const { ErrorCode } = await import("../errors.mjs");
      const msg = this.faults.handoffOnAction;
      this.faults.handoffOnAction = "";
      throw new AgentError(ErrorCode.HANDOFF_REQUIRED, msg, { hint: "请人工完成该步骤后继续" });
    }
    if (this.faults.failNextAction > 0) {
      this.faults.failNextAction -= 1;
      return { ok: false, error: "ACTION_NO_EFFECT", message: "mock 注入动作失败" };
    }
    const r = this._resolveRef(snapshotId, ref);
    if (r.error) return r;

    this.state.clicks += 1;
    if (ref === "b3" || action === "submit") {
      this.state.submitted = true;
      this.state.status = "已提交";
    } else if (ref === "b1") {
      this.state.text = "";
      this.state.status = "已新建";
    } else if (ref === "b2") {
      this.state.status = "已保存";
    } else {
      this.state.status = `已点击 ${r.node?.name ?? ref}`;
    }
    if (value) this.state.text = value;
    return {
      ok: true,
      via: "a11y-invoke", // 不抢焦点（方案 §1.3 首选通道）
      ref,
      action,
      foregroundRequired: false,
    };
  }

  async clickXY({ x = 0, y = 0, snapTo } = {}) {
    await this._assertAlive();
    if (this.faults.failNextAction > 0) {
      this.faults.failNextAction -= 1;
      return { ok: false, error: "ACTION_NO_EFFECT" };
    }
    if (this.faults.silentClick) {
      // 点了、后端也说成功，但界面什么都没变——这正是视觉兜底最需要识别的假成功
      return { ok: true, via: "coordinate-input", foregroundRequired: true, snappedTo: snapTo ?? null, silent: true };
    }
    this.state.clicks += 1;
    this.state.status = `已点击坐标 (${x},${y})`;
    return {
      ok: true,
      via: "coordinate-input",
      foregroundRequired: true,
      snappedTo: snapTo ?? null,
    };
  }

  async typeText({ text = "", ref } = {}) {
    await this._assertAlive();
    this.state.text = text;
    this.state.status = `已输入 ${text.length} 字符`;
    return { ok: true, via: ref ? "value-pattern" : "keyboard", chars: text.length };
  }

  async sendKey({ combo = "" } = {}) {
    await this._assertAlive();
    this.state.keys.push(combo);
    return { ok: true, combo };
  }

  async waitFor({ predicate = "status-changed", timeoutMs = 1000 } = {}) {
    return { ok: true, predicate, waitedMs: Math.min(1, timeoutMs) };
  }

  /** 读回界面状态，供 Verifier 复观察比对 */
  async observeState() {
    return { ...this.state };
  }

  /** 使当前所有快照失效（模拟界面变化后旧 ref 不可用） */
  invalidateSnapshots() {
    this.snapshots.clear();
  }
}

export function createMockBackend(options) {
  return new MockBackend(options);
}
