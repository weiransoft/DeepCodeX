/**
 * 感知/动作后端契约（L4 执行层与平台实现之间的边界）。
 *
 * 方案 §2.4 / R9 / R10：平台能力差异必须**显式声明**，不能靠运行时猜。
 * 每个后端实现以下接口；不支持的能力返回 supported:false + reason，
 * 由 Perception 决定降级（树 → 视觉）或直接 CAPABILITY_UNAVAILABLE。
 *
 * 这样 sidecar 主体（策略/编排/验证/审计）与 OS API 完全解耦：
 * - 单元测试用 mock 后端跑通全链路，不需要桌面会话与系统权限；
 * - Windows 真实后端可独立编译/下发，macOS AX 后端后续按同一契约接入；
 * - 平台能力矩阵可直接由 capabilities() 汇总进 P0 探针报告。
 */

/** 后端必须实现的方法名（用于启动期契约校验） */
export const BACKEND_METHODS = Object.freeze([
  "capabilities",
  "listApps",
  "snapshot",
  "screenshot",
  "invokeRef",
  "clickXY",
  "typeText",
  "sendKey",
  "waitFor",
]);

/**
 * 校验后端是否满足契约；缺失方法直接抛错，避免运行到一半才发现。
 * @param {object} backend
 * @returns {object} backend
 */
export function assertBackend(backend) {
  if (!backend || typeof backend !== "object") {
    throw new TypeError("backend must be an object");
  }
  const missing = BACKEND_METHODS.filter((m) => typeof backend[m] !== "function");
  if (missing.length > 0) {
    throw new TypeError(`backend is missing methods: ${missing.join(", ")}`);
  }
  return backend;
}

/** 能力项的标准形态（探针报告直接消费） */
export function capability(supported, reason = "") {
  return { supported: Boolean(supported), reason };
}

/**
 * 树节点标准形态。ref 是**快照内**稳定引用，不是 OS 句柄：
 * 跨 snapshotId 复用必须被 Perception 判为 STALE_REF。
 */
export function nodeShape() {
  return {
    ref: "string",
    role: "string",
    name: "string",
    rect: { x: 0, y: 0, width: 0, height: 0 },
    depth: 0,
    children: "array<node>",
    // 可选：value / enabled / focused / controlType / untrusted
  };
}
