/**
 * desktop-agent 统一错误模型。
 *
 * 设计依据（docs/desktop/DESKTOP-COMPUTER-USE-PROPOSAL.md §1.2 / §1.6 / §6）：
 * 桌面 GUI 操作的失败必须**可分类、可行动**，不能把「树为空」「ref 失效」
 * 「预算耗尽」「需要人工接管」统统压成一句 "operation failed"。
 * 上层（Verifier / TaskOrchestrator）依赖 code 决定是重取、换通道、重试还是认输。
 */

/** 稳定错误码：与 MCP 工具返回值中的 `code` 字段一一对应 */
export const ErrorCode = Object.freeze({
  /** 快照已失效：界面变化后旧 ref 不可再用，必须重新 snapshot */
  STALE_REF: "STALE_REF",
  /** 目标应用不在授权白名单 / 命中敏感应用黑名单 */
  APP_NOT_ALLOWED: "APP_NOT_ALLOWED",
  /** 动作被策略拒绝（不可逆动作未确认、动作分级不允许等） */
  ACTION_DENIED: "ACTION_DENIED",
  /** 需要人工确认，返回 confirmationToken 供二次调用携带 */
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  /** 步数 / 截图 / token 预算耗尽，熔断 */
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  /** 当前平台或会话不具备该能力（如沙箱内无 UIA、macOS 未授权） */
  CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
  /** 观察失败：树遍历超时、目标窗口不存在、遍历深度耗尽 */
  OBSERVATION_FAILED: "OBSERVATION_FAILED",
  /** 动作后复观察未检测到预期状态变化 */
  VERIFY_FAILED: "VERIFY_FAILED",
  /** 不可恢复异常，必须交还控制权（验证码 / UAC / 锁屏 / 应用崩溃） */
  HANDOFF_REQUIRED: "HANDOFF_REQUIRED",
  /** UI 文本中被检出提示注入特征，动作被拦截 */
  UNTRUSTED_INPUT_BLOCKED: "UNTRUSTED_INPUT_BLOCKED",
  /** 参数非法 */
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  /** 内部错误 */
  INTERNAL: "INTERNAL",
});

/** 可恢复（重取/换通道/有界重试）与不可恢复（明确认输）的分界 */
export const RECOVERABLE_CODES = new Set([
  ErrorCode.STALE_REF,
  ErrorCode.OBSERVATION_FAILED,
  ErrorCode.VERIFY_FAILED,
]);

export class AgentError extends Error {
  constructor(code, message, details = {}, recoverable = RECOVERABLE_CODES.has(code)) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.details = details;
    this.recoverable = recoverable;
  }

  /** 序列化为 MCP 工具返回值（结构化、可机读） */
  toJSON() {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      ...this.details,
    };
  }
}

export function fail(code, message, details) {
  throw new AgentError(code, message, details);
}

/** 把任意异常规范化为 AgentError，避免内部堆栈泄漏到模型上下文 */
export function normalizeError(err) {
  if (err instanceof AgentError) return err;
  return new AgentError(ErrorCode.INTERNAL, "desktop-agent 内部错误", {
    cause: String(err?.message ?? err).slice(0, 300),
  });
}
