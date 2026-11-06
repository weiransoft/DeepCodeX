/**
 * AppRegistry —— 应用/窗口枚举与分类（方案 §5 L4）。
 *
 * 分类不是装饰：它直接决定三级降级链的第 ② 级（browser → DOM/CDP）
 * 与敏感应用硬拦截（finance → 默认禁用），是「哪些场景不该走 GUI」
 * 负面清单的数据来源（P0 交付物）。
 */

export class AppRegistry {
  constructor(backend, options = {}) {
    this.backend = backend;
    this.telemetry = options.telemetry;
    this.cache = null;
    this.cachedAt = 0;
    this.ttlMs = options.ttlMs ?? 2000;
    this.clock = options.clock ?? (() => Date.now());
    /** 实测树质量：key = `${appId}#${hwnd ?? pid}`，由 Perception 观察后回写 */
    this.quality = new Map();
  }

  /**
   * 记录一次实测树质量。按 hwnd 优先、pid 次之区分同进程多窗口——
   * 同一个 exe 的「设置窗口」可能树很全，「主界面」却是自绘的，
   * 只按 appId 记会把两者混为一谈。
   */
  noteTreeQuality(app, quality) {
    if (!app || !quality) return;
    const key = `${app.appId}#${app.hwnd ?? app.pid ?? 0}`;
    this.quality.set(key, { ...quality, at: this.clock() });
    this.telemetry?.emit("registry.tree_quality", {
      appId: app.appId,
      verdict: quality.verdict,
      namedActionableCount: quality.namedActionableCount,
    });
  }

  qualityFor(app) {
    if (!app) return null;
    return (
      this.quality.get(`${app.appId}#${app.hwnd ?? app.pid ?? 0}`) ??
      this.quality.get(`${app.appId}#${app.pid ?? 0}`) ??
      null
    );
  }

  async list({ refresh = false } = {}) {
    if (!refresh && this.cache && this.clock() - this.cachedAt < this.ttlMs) return this.cache;
    const apps = await this.backend.listApps();
    this.cache = apps;
    this.cachedAt = this.clock();
    this.telemetry?.emit("registry.list", { count: apps.length });
    return apps;
  }

  async get(appId, { refresh = false } = {}) {
    const apps = await this.list({ refresh });
    return apps.find((a) => a.appId === appId) ?? null;
  }

  /**
   * 生成 P0 探针所需的「通道建议」：把每个应用归入
   * interface / browser / gui-a11y / gui-visual / blocked 之一。
   */
  async channelMatrix(apps) {
    // 允许传入已有快照：桌面窗口是动态的，两次独立枚举之间数量可能变化，
    // 矩阵必须与它描述的那一次观察严格对应（探针报告的可复现性要求）。
    const list = apps ?? (await this.list({ refresh: true }));
    return list.map((a) => {
      let channel = "gui-a11y";
      let reason = "桌面应用，默认 a11y 树观察";
      // 兼容两套后端的分类命名（windows 用 *-or-* 后缀，mock/未来平台用简名）
      if (["finance-or-sensitive", "finance", "crypto", "medical", "government"].includes(a.category)) {
        channel = "blocked";
        reason = "敏感分类默认禁用，人工操作";
      } else if (a.category === "browser") {
        channel = "browser";
        reason = "应走 DOM/CDP 通道，GUI 只是最后手段";
      } else if (["selfdrawn-likely", "selfdrawn"].includes(a.category)) {
        channel = "gui-visual";
        reason = "自绘/Electron 树常为空，预期需视觉兜底（默认关闭，需显式开启）";
      } else if (a.category === "productivity") {
        channel = "interface-or-gui";
        reason = "优先文件/CLI 接口；无接口再退 GUI";
      }
      // 实测优先于分类启发式：只要观察过且树确认残缺（sparse/empty），无论
      // 进程名像不像 Electron 都改判视觉通道——否则模型会一直在残缺树里找目标。
      // deferred 不改判：那只是「还没看全」，下钻即可，换通道是误判。
      const quality = this.qualityFor(a);
      if (channel !== "blocked" && quality && ["sparse", "empty"].includes(quality.verdict)) {
        channel = "gui-visual";
        reason = `实测树残缺（${quality.verdict}：${quality.reason}），需视觉兜底或换通道`;
      }
      return { ...a, channel, reason, treeQuality: quality ?? null };
    });
  }
}
