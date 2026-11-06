/**
 * DesktopAgent / TaskOrchestrator 的最小实现（方案 §4.2 / §5 L2+L3）。
 *
 * 三级降级链在这里体现为**通道决策**（不是把模型塞进 sidecar）：
 *   ① 接口/连接器/CLI/文件 → 由 core 现有工具承担，本 sidecar 直接返回
 *      `preferInterface` 建议，不启动 GUI；
 *   ② 浏览器 DOM/CDP → browser 类应用返回 `preferBrowser`；
 *   ③ 桌面 GUI → 才进入 observe/act/verify。
 *
 * 职责红线：sidecar 不做任务规划（Plan 在引擎），只提供结构化工具语义、
 * 执行策略与验证结果；模型在引擎侧决定调用哪个工具。
 */

import { assertBackend } from "./backends/contract.mjs";
import { AppRegistry } from "./modules/app-registry.mjs";
import { Perception } from "./modules/perception.mjs";
import { Verifier, Actuator } from "./modules/verifier.mjs";
import { PolicyGuard } from "./modules/policy-guard.mjs";
import { Budget } from "./modules/budget.mjs";
import { Telemetry } from "./modules/telemetry.mjs";
import { ErrorCode, AgentError, normalizeError } from "./errors.mjs";

/** 工具语义清单（方案 §4.1 L3）。schema 直接供 MCP tools/list 使用 */
export const TOOLS = [
  {
    name: "desktop_status",
    description: "查询 desktop-agent 状态、平台能力矩阵、策略与预算用量。只读。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "desktop_list_apps",
    description: "枚举本机可见窗口/应用，返回 appId、分类与建议通道（三级降级链）。只读。",
    inputSchema: {
      type: "object",
      properties: { refresh: { type: "boolean", description: "跳过缓存强制重新枚举" } },
      additionalProperties: false,
    },
  },
  {
    name: "desktop_snapshot",
    description: "取目标应用的 a11y 语义树（骨架+稳定 ref）。树优先，默认不使用视觉。只读。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        maxDepth: { type: "number", description: "深度预算，默认 2" },
        skeleton: { type: "boolean", description: "只返回骨架树" },
        allowVisualFallback: { type: "boolean", description: "树为空时允许截屏兜底（需策略开启）" },
      },
      required: ["appId"],
      additionalProperties: false,
    },
  },
  {
    name: "desktop_drill_down",
    description: "在已有快照内按 rootRef 下钻子树，避免把整棵树塞进上下文。只读。",
    inputSchema: {
      type: "object",
      properties: {
        snapshotId: { type: "string" },
        rootRef: { type: "string" },
        maxDepth: { type: "number" },
      },
      required: ["snapshotId", "rootRef"],
      additionalProperties: false,
    },
  },
  {
    name: "desktop_screenshot",
    description: "视觉兜底截图。默认关闭、不落盘、结果标记 untrusted；需先确认 a11y 树为空。",
    inputSchema: {
      type: "object",
      properties: { appId: { type: "string" }, reason: { type: "string" } },
      required: ["appId", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "desktop_click_ref",
    description: "按快照内 ref 执行元素 invoke（不抢焦点）。走 Observe-Act-Verify 闭环。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        snapshotId: { type: "string" },
        ref: { type: "string" },
        action: { type: "string", enum: ["click_ref", "invoke", "submit", "send", "delete"] },
        value: { type: "string" },
        expectChange: { type: "boolean", description: "默认 true；幂等动作（保存/复制）界面不变时应传 false，成效由副作用自证" },
        confirmationToken: { type: "string", description: "不可逆/manual 动作的二次确认令牌" },
      },
      required: ["appId", "snapshotId", "ref"],
      additionalProperties: false,
    },
  },
  {
    name: "desktop_click_xy",
    description: "坐标点击兜底（自绘界面）。默认关闭，坐标会先吸附到最近 a11y 节点。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        expectChange: { type: "boolean" },
        confirmationToken: { type: "string" },
      },
      required: ["appId", "x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "desktop_type",
    description: "向目标输入文本（优先 ValuePattern，否则键盘注入）。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        snapshotId: { type: "string" },
        ref: { type: "string" },
        value: { type: "string" },
        expectChange: { type: "boolean" },
        confirmationToken: { type: "string" },
      },
      required: ["appId", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "desktop_key",
    description: "发送快捷键组合（如 ^s / {ENTER}）。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        combo: { type: "string" },
        expectChange: { type: "boolean", description: "默认 true；^s 等保存类快捷键界面不变时应传 false" },
        confirmationToken: { type: "string" },
      },
      required: ["appId", "combo"],
      additionalProperties: false,
    },
  },
  {
    name: "desktop_wait_for",
    description: "等待界面就绪（有界超时，不做无限等待）。只读。",
    inputSchema: {
      type: "object",
      properties: { appId: { type: "string" }, predicate: { type: "string" }, timeoutMs: { type: "number" } },
      required: ["appId"],
      additionalProperties: false,
    },
  },
  {
    name: "desktop_events",
    description: "读取脱敏后的结构化事件流（回放/成本看板）。只读。",
    inputSchema: {
      type: "object",
      properties: { since: { type: "number" }, type: { type: "string" } },
      additionalProperties: false,
    },
  },
];

/**
 * 所有带 appId 的工具都支持可选 pid / hwnd：
 * 同一进程名常有多个顶层窗口（浏览器多窗口、多标签、多开应用，甚至资源管理器
 * 的桌面窗口与文件夹窗口共用同一 PID）。只按 appId 取第一个会观察错窗口；
 * pid 仍不唯一时，hwnd 才是能落到具体窗口的标识。
 */
for (const tool of TOOLS) {
  if (tool.inputSchema?.properties?.appId) {
    tool.inputSchema.properties.pid = {
      type: "number",
      description: "可选：目标窗口所属进程 PID；同一 appId 有多个窗口时用于精确定位",
    };
    tool.inputSchema.properties.hwnd = {
      type: "number",
      description: "可选：窗口句柄；同进程多窗口时唯一可区分（取 desktop_list_apps 返回值）",
    };
  }
}

export class DesktopAgent {
  constructor({ backend, policy = {}, limits = {}, telemetryOptions = {} } = {}) {
    this.backend = assertBackend(backend);
    this.telemetry = new Telemetry(telemetryOptions);
    this.policy = new PolicyGuard(policy, {});
    this.budget = new Budget(limits, {});
    this.registry = new AppRegistry(this.backend, { telemetry: this.telemetry });
    this.perception = new Perception(this.backend, {
      policy: this.policy,
      budget: this.budget,
      telemetry: this.telemetry,
      // 观察即测量：把实测树质量回写给注册表，通道判定不再靠进程名猜
      onQuality: (app, quality) => this.registry.noteTreeQuality(app, quality),
    });
    this.actuator = new Actuator(this.backend, {
      perception: this.perception,
      policy: this.policy,
      budget: this.budget,
      telemetry: this.telemetry,
    });
    this.verifier = new Verifier(this.backend, {
      actuator: this.actuator,
      perception: this.perception,
      budget: this.budget,
      telemetry: this.telemetry,
      maxRetries: limits.maxRetries ?? 2,
    });
    this.version = "0.1.0";
  }

  /** 策略/开关变更：热更新，不重建进程（对齐 engine_fingerprint 的保存即生效思路） */
  applyPolicy(patch) {
    const snap = this.policy.update(patch);
    this.budget.limits = {
      ...this.budget.limits,
      ...(patch.maxSteps !== undefined ? { maxSteps: patch.maxSteps } : {}),
      ...(patch.maxScreenshots !== undefined ? { maxScreenshots: patch.maxScreenshots } : {}),
      ...(patch.maxTokens !== undefined ? { maxTokens: patch.maxTokens } : {}),
      ...(patch.maxRetries !== undefined ? { maxRetries: patch.maxRetries } : {}),
    };
    this.telemetry.emit("policy.updated", { enabled: snap.enabled, permissionMode: snap.permissionMode });
    return snap;
  }

  /** 能力矩阵（P0 探针直接消费） */
  async capabilities() {
    return this.backend.capabilities();
  }

  /**
   * 三级降级链决策。返回 { useGui, channel, reason }；
   * useGui=false 时调用方（引擎）应改用接口/浏览器通道，不启动 GUI。
   */
  async decideChannel(app) {
    if (["finance-or-sensitive", "finance", "crypto", "medical", "government"].includes(app.category)) {
      return { useGui: false, channel: "blocked", reason: "敏感应用默认禁用，需人工操作" };
    }
    if (this.policy.policy.preferBrowserChannel && app.category === "browser") {
      return { useGui: false, channel: "browser", reason: "优先 DOM/CDP 通道，复用登录态" };
    }
    if (app.category === "productivity") {
      return {
        useGui: false,
        channel: "interface-first",
        reason: "优先 CLI/文件/连接器；确无接口再降级到 GUI（调用方需显式 forceGui）",
      };
    }
    return { useGui: true, channel: "gui-a11y", reason: "无接口目标，走 a11y 树观察" };
  }

  /** 解析 appId 并做只读授权校验；写动作由 Actuator 再做一次完整校验 */
  async resolveApp(appId, { write = false } = {}) {
    // 缓存优先；仅在未命中时才强制重取一次（避免高频 15s 全量枚举）
    let app = await this.registry.get(appId);
    if (!app) app = await this.registry.get(appId, { refresh: true });
    if (!app) {
      throw new AgentError(ErrorCode.INVALID_ARGUMENT, `应用 ${appId} 不在当前窗口列表中`, {
        hint: "先调用 desktop_list_apps 取有效 appId",
      });
    }
    this.policy.authorize({ app, action: write ? "write" : "list_apps", scope: write ? "write" : "read" });
    return app;
  }

  /**
   * 解析目标窗口：缓存优先，未命中才重取一次；调用方给了 pid 就精确覆盖，
   * 供 UIA 桥按进程定位具体窗口（同 appId 多窗口场景）。
   */
  async _target(args) {
    const hwnd = args.hwnd != null && Number.isFinite(Number(args.hwnd)) ? Number(args.hwnd) : null;
    let app = null;
    if (hwnd) {
      // HWND 是唯一能区分「同进程多窗口」的标识（资源管理器桌面窗口/文件夹窗口、
      // 多标签应用的独立窗口）。先按 hwnd 精确匹配，再退回 appId/pid。
      const apps = await this.registry.list({ refresh: false });
      app = apps.find((a) => Number(a.hwnd) === hwnd) ?? null;
      if (!app) {
        const fresh = await this.registry.list({ refresh: true });
        app = fresh.find((a) => Number(a.hwnd) === hwnd) ?? null;
      }
    }
    if (!app) app = await this.registry.get(args.appId);
    if (!app) app = await this.registry.get(args.appId, { refresh: true });
    if (!app) {
      throw new AgentError(ErrorCode.INVALID_ARGUMENT, `应用 ${args.appId} 不在当前窗口列表中`, {
        hint: "先调用 desktop_list_apps 取有效 appId（同进程多窗口请带 hwnd）",
      });
    }
    const target = { ...app };
    if (args.pid) target.pid = Number(args.pid);
    if (hwnd) target.hwnd = hwnd;
    return target;
  }

  /** 工具分发：统一入口，异常规范化为结构化 code */
  async callTool(name, args = {}) {
    try {
      return await this.dispatch(name, args);
    } catch (err) {
      const e = normalizeError(err);
      this.telemetry.emit("tool.error", { tool: name, code: e.code });
      return e.toJSON();
    }
  }

  async dispatch(name, args) {
    switch (name) {
      case "desktop_status":
        return {
          ok: true,
          version: this.version,
          backend: this.backend.name,
          enabled: this.policy.policy.enabled,
          policy: this.policy.snapshot(),
          budget: this.budget.status(),
          capabilities: await this.capabilities(),
          metrics: this.telemetry.metrics(),
        };

      case "desktop_list_apps": {
        this.policy.authorize({ app: { appId: "__registry__" }, action: "status" });
        // 注册表是只读枚举，绕过按应用白名单（否则无法列出待授权应用）。
        // 默认走 TTL 缓存：tasklist /v 实测约 15s，绝不能每次工具调用都全量枚举；
        // 仅调用方显式传 refresh=true 才强制重取。
        const apps = await this.registry.list({ refresh: Boolean(args.refresh) });
        const matrix = await this.registry.channelMatrix(apps);
        return { ok: true, apps: matrix, count: matrix.length, untrusted: true };
      }

      case "desktop_snapshot": {
        const app = await this._target(args);
        if (!app) throw new AgentError(ErrorCode.INVALID_ARGUMENT, `未知 appId：${args.appId}`);
        const decision = await this.decideChannel(app);
        this.policy.authorize({ app, action: "snapshot", scope: "read" });
        const observation = await this.perception.observe({
          app,
          maxDepth: args.maxDepth ?? 2,
          skeleton: args.skeleton !== false,
          allowVisualFallback: Boolean(args.allowVisualFallback),
        });
        // 把观察文本计入 token 预算（R8）
        this.budget.charge({ tokens: this.budget.estimateTokens(observation.tree ?? []) });
        return { ...observation, channel: decision };
      }

      case "desktop_drill_down":
        return this.perception.drillDown(args.snapshotId, args.rootRef, args.maxDepth ?? 3);

      case "desktop_screenshot": {
        const app = await this._target(args);
        if (!app) throw new AgentError(ErrorCode.INVALID_ARGUMENT, `未知 appId：${args.appId}`);
        this.policy.authorize({ app, action: "screenshot", scope: "read" });
        return this.perception.screenshot({ app, reason: args.reason });
      }

      case "desktop_click_ref": {
        const app = await this._target(args);
        if (!app) throw new AgentError(ErrorCode.INVALID_ARGUMENT, `未知 appId：${args.appId}`);
        return this.verifier.step({
          app,
          action: args.action ?? "click_ref",
          snapshotId: args.snapshotId,
          ref: args.ref,
          value: args.value,
          expectChange: args.expectChange !== false,
          confirmationToken: args.confirmationToken,
        });
      }

      case "desktop_click_xy": {
        const app = await this._target(args);
        if (!app) throw new AgentError(ErrorCode.INVALID_ARGUMENT, `未知 appId：${args.appId}`);
        return this.verifier.step({
          app,
          action: "click_xy",
          x: Number(args.x),
          y: Number(args.y),
          expectChange: args.expectChange !== false,
          confirmationToken: args.confirmationToken,
        });
      }

      case "desktop_type": {
        const app = await this._target(args);
        if (!app) throw new AgentError(ErrorCode.INVALID_ARGUMENT, `未知 appId：${args.appId}`);
        return this.verifier.step({
          app,
          action: "type",
          snapshotId: args.snapshotId,
          ref: args.ref,
          value: args.value,
          expectChange: args.expectChange !== false,
          confirmationToken: args.confirmationToken,
        });
      }

      case "desktop_key": {
        const app = await this._target(args);
        if (!app) throw new AgentError(ErrorCode.INVALID_ARGUMENT, `未知 appId：${args.appId}`);
        return this.verifier.step({
          app,
          action: "key",
          combo: args.combo,
          expectChange: args.expectChange !== false,
          confirmationToken: args.confirmationToken,
        });
      }

      case "desktop_wait_for": {
        const app = await this._target(args);
        if (!app) throw new AgentError(ErrorCode.INVALID_ARGUMENT, `未知 appId：${args.appId}`);
        this.budget.charge({ steps: 1 });
        const res = await this.backend.waitFor({
          predicate: args.predicate ?? "ready",
          timeoutMs: Math.min(args.timeoutMs ?? 1000, 10_000),
        });
        return { ok: true, ...res };
      }

      case "desktop_events":
        return { ok: true, events: this.telemetry.list({ since: args.since ?? 0, type: args.type }) };

      default:
        throw new AgentError(ErrorCode.INVALID_ARGUMENT, `未知工具：${name}`);
    }
  }
}
