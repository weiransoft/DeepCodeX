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
      return { ...a, channel, reason };
    });
  }
}
