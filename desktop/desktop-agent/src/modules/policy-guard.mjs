/**
 * PolicyGuard —— 执行前的最后一道硬校验（方案 §4.4 / R1 / R3 / R4）。
 *
 * 职责红线：**不依赖模型自觉**。即便编排层（模型）被截图/UI 文本里的
 * 提示注入诱导，这里仍会按「应用白名单 + 动作分级 + 不可逆确认 +
 * 敏感应用默认禁用」把越权动作挡下来。
 *
 * 与现有 core PermissionMode 的语义对齐：
 *   manual → 写动作逐次确认；auto → 白名单内放行；bypass → 仍保留硬拦截
 *   （对齐 checkDangerousBashCommand 的哲学：bypass 不等于关闭安全底线）。
 */

import { ErrorCode, AgentError } from "../errors.mjs";

/**
 * 纯诊断面：只读、无副作用、不返回画面内容（窗口清单 / 能力矩阵 / 预算用量）。
 * 即便能力开关关闭也必须可查，否则用户无法诊断「为什么不能用」，
 * P0 探针也无法采集平台能力矩阵。
 */
export const DIAGNOSTIC_ACTIONS = new Set(["status", "list_apps", "events"]);

/** 只读动作：无需确认，但观察结果仍标记 untrusted */
export const READ_ACTIONS = new Set([
  "snapshot",
  "screenshot",
  "wait_for",
  "verify",
  "observe_state",
]);

/** 不可逆 / 有真实后果的动作：强制逐次确认，且不受「始终允许」豁免 */
export const IRREVERSIBLE_ACTIONS = new Set([
  "submit",
  "send",
  "delete",
  "purchase",
  "pay",
  "confirm",
  "transfer",
]);

/** 敏感分类：默认禁用（方案 §4.4 建议对齐 Claude 的投资/交易/加密默认禁用） */
export const DEFAULT_DENIED_CATEGORIES = new Set([
  "finance",
  "crypto",
  "medical",
  "government",
  "finance-or-sensitive",
]);

/** 提示注入特征：UI 文本中出现即视为不可信指令，动作前拦截 */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(the\s+)?(system|developer|previous)/i,
  /(you are now|act as|new instruction|system prompt)/i,
  /(忽略|无视)(之前|以上|所有|前面).{0,6}(指令|提示|要求)/,
  /(现在你是|请执行以下|把.{0,8}(密码|密钥|token).{0,8}(发送|填|上传))/,
  /(click|press|type|send)\s+.{0,30}(password|token|api[_ -]?key|credential)/i,
];

/** 扫描 UI 文本中的注入特征；返回命中列表（不把原文回灌给模型） */
export function detectInjection(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const hits = [];
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) hits.push(re.source.slice(0, 60));
  }
  return hits;
}

export function defaultPolicy() {
  return {
    enabled: false, // 默认关闭：能力必须显式开启（最小权限）
    permissionMode: "manual",
    allowedApps: [], // [{ appId, always: boolean, scopes: ["read","write"] }]
    deniedApps: [],
    deniedCategories: [...DEFAULT_DENIED_CATEGORIES],
    /** 浏览器类应用默认不走 GUI（方案 §4.2 三级降级链） */
    preferBrowserChannel: true,
    allowCoordinateInput: false, // 视觉/坐标点击默认关闭（P2 才启用）
    allowScreenshot: false, // 默认不用视觉（方案 §3.3 结论 3）
    /** 视觉授权覆盖的应用清单（壳侧限时授权派生；空 = 未授权） */
    visionApps: [],
    /** 视觉授权到期时刻（Unix 毫秒；0 = 未授权） */
    visionExpiresAt: 0,
    /** 单次任务预算 */
    maxSteps: 25,
    maxScreenshots: 3,
    maxTokens: 60_000,
    maxRetries: 2,
  };
}

/**
 * 策略归一化：外部配置（JSON / IPC / 测试）里 deniedCategories 是数组，
 * 内部统一用 Set 做 O(1) 判定。避免「数组.has 不是函数」这类运行期错误。
 */
function normalizePolicy(p) {
  const cats = p.deniedCategories;
  return {
    ...p,
    deniedCategories: cats instanceof Set ? cats : new Set(Array.isArray(cats) ? cats : DEFAULT_DENIED_CATEGORIES),
  };
}

export class PolicyGuard {
  constructor(policy = {}, options = {}) {
    this.policy = normalizePolicy({ ...defaultPolicy(), ...policy });
    this.clock = options.clock ?? (() => Date.now());
    /** confirmationToken -> { appId, action, expiresAt }，一次性 */
    this.pending = new Map();
    this.tokenSeq = 0;
  }

  update(patch) {
    this.policy = normalizePolicy({ ...this.policy, ...patch });
    return this.snapshot();
  }

  /** 只读快照（不含 token 明文；Set 转回数组以便 JSON 序列化） */
  snapshot() {
    return {
      ...this.policy,
      deniedCategories: [...this.policy.deniedCategories],
      pendingConfirmations: this.pending.size,
    };
  }

  isAllowedApp(appId) {
    const { allowedApps, deniedApps } = this.policy;
    if (deniedApps.includes(appId)) return false;
    return allowedApps.some((a) => a.appId === appId);
  }

  /**
   * 视觉授权是**按应用**的（方案 §3.12 闸门）：授权清单非空时，只有清单内的
   * 应用能截图/坐标点击。清单为空（未授权）不在这里拦——`allowScreenshot` /
   * `allowCoordinateInput` 已经把路堵死了，这里只补"授权了 A 就不许截 B"。
   */
  assertVisionScope(appId, action) {
    if (action !== "screenshot" && action !== "click_xy") return;
    // 到期要「立刻」失效：读盘时判过一次，但 sidecar 是长驻进程，在这里不判
    // 就等于「授权一次、管到进程重启」——限时授权也就名存实亡了
    const expiresAt = Number(this.policy.visionExpiresAt) || 0;
    if (expiresAt > 0 && this.clock() >= expiresAt) {
      throw new AgentError(ErrorCode.CAPABILITY_UNAVAILABLE, "视觉授权已过期", {
        hint: "重新走 desktop_agent_vision_challenge → vision_grant",
        expiresAt,
      });
    }
    const apps = Array.isArray(this.policy.visionApps) ? this.policy.visionApps : [];
    if (apps.length === 0) return;
    if (!apps.includes(appId)) {
      throw new AgentError(ErrorCode.CAPABILITY_UNAVAILABLE, `应用 ${appId} 不在视觉授权清单内`, {
        hint: `当前视觉授权仅覆盖：${apps.join(", ")}`,
      });
    }
  }

  /**
   * 生成一次性确认令牌（供前端 AskUserQuestion / 授权面板使用）。
   * 令牌只在内存里、带 5 分钟过期，不落盘。
   */
  createConfirmation(appId, action) {
    const token = `cfm-${++this.tokenSeq}-${this.clock().toString(36)}`;
    this.pending.set(token, { appId, action, expiresAt: this.clock() + 5 * 60_000 });
    return token;
  }

  consumeConfirmation(token, appId, action) {
    const rec = this.pending.get(token);
    if (!rec) return false;
    this.pending.delete(token); // 一次性
    return rec.expiresAt > this.clock() && rec.appId === appId && rec.action === action;
  }

  /**
   * 执行前校验。
   * @returns {{allowed:boolean, confirmationToken?:string, reason?:string}}
   * @throws {AgentError}
   */
  authorize({ app, action, reversible = true, confirmationToken, observedTexts = [], scope = "read" }) {
    if (DIAGNOSTIC_ACTIONS.has(action)) return { allowed: true, diagnostic: true };
    if (!this.policy.enabled) {
      throw new AgentError(ErrorCode.ACTION_DENIED, "desktop-agent 能力未开启", {
        hint: "经 desktop_agent_toggle 开启后再试",
      });
    }
    if (!app || !app.appId) {
      throw new AgentError(ErrorCode.INVALID_ARGUMENT, "缺少目标应用 appId");
    }
    const appId = app.appId;

    // 1) 敏感分类硬拦截（R2/R3）：**先于**只读分支，确保截屏/取树也不会
    //    在敏感应用上先执行再判断；bypass 模式同样不能豁免。
    if (app.category && this.policy.deniedCategories.has(app.category)) {
      throw new AgentError(ErrorCode.APP_NOT_ALLOWED, `应用分类 ${app.category} 默认禁用`, {
        hint: "敏感应用不提供自动放行；请人工操作",
      });
    }

    // 2) 提示注入扫描（R1）——观察文本命中特征时，本次写动作一律硬拦截
    const injections = observedTexts.flatMap(detectInjection);
    if (injections.length > 0 && !READ_ACTIONS.has(action)) {
      throw new AgentError(
        ErrorCode.UNTRUSTED_INPUT_BLOCKED,
        "界面文本中检出疑似提示注入指令，写动作被拦截",
        { patternCount: injections.length, hint: "请人工核对界面内容后重试" }
      );
    }

    // 3) 只读动作：只需应用已授权（观察也不允许对敏感应用随便截屏）
    if (READ_ACTIONS.has(action)) {
      if (!this.isAllowedApp(appId)) {
        throw new AgentError(ErrorCode.APP_NOT_ALLOWED, `应用 ${appId} 未授权`, {
          hint: "经 desktop_agent_permissions_set 加入白名单",
        });
      }
      if (action === "screenshot" && !this.policy.allowScreenshot) {
        throw new AgentError(ErrorCode.CAPABILITY_UNAVAILABLE, "截屏通道默认关闭", {
          hint: "壳侧走 desktop_agent_vision_grant 限时授权后才能截图",
        });
      }
      this.assertVisionScope(appId, action);
      return { allowed: true };
    }

    // 4) 应用白名单（分类硬拦截已在第 1 步统一执行）
    if (!this.isAllowedApp(appId)) {
      throw new AgentError(ErrorCode.APP_NOT_ALLOWED, `应用 ${appId} 未授权`, {
        hint: "首次操作需按应用确认",
      });
    }
    if (this.policy.preferBrowserChannel && app.category === "browser") {
      throw new AgentError(ErrorCode.ACTION_DENIED, "浏览器目标应走 DOM/CDP 通道，而非 GUI", {
        hint: "三级降级链第 ② 级",
      });
    }
    if (action === "click_xy" && !this.policy.allowCoordinateInput) {
      throw new AgentError(ErrorCode.CAPABILITY_UNAVAILABLE, "坐标输入通道默认关闭", {
        hint: "优先使用 a11y 元素 invoke；确需坐标点击需壳侧视觉授权（含坐标）",
      });
    }
    this.assertVisionScope(appId, action);

    // 5) 不可逆动作强制逐次确认，不受「始终允许」豁免
    if (!reversible || IRREVERSIBLE_ACTIONS.has(action)) {
      if (!confirmationToken || !this.consumeConfirmation(confirmationToken, appId, action)) {
        const token = this.createConfirmation(appId, action);
        throw new AgentError(ErrorCode.CONFIRMATION_REQUIRED, "该动作不可逆，需人工逐次确认", {
          confirmationToken: token,
          appId,
          action,
          hint: "请向用户展示目标与后果，确认后携带 confirmationToken 重试",
        });
      }
      return { allowed: true, confirmed: true };
    }

    // 6) 与 PermissionMode 对齐
    const allowedApp = this.policy.allowedApps.find((a) => a.appId === appId);
    if (this.policy.permissionMode === "manual" && !(allowedApp?.always && allowedApp?.scopes?.includes(scope))) {
      const token = this.createConfirmation(appId, action);
      throw new AgentError(ErrorCode.CONFIRMATION_REQUIRED, "manual 模式：写动作需逐次确认", {
        confirmationToken: token,
        appId,
        action,
      });
    }
    return { allowed: true };
  }
}
