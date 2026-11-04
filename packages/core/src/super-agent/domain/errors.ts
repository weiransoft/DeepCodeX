/**
 * Super Agent 领域错误
 *
 * ## 设计约定
 *
 * - **可预期的拒绝**（参数非法、状态不允许、授权失效）→ `UserError`，
 *   携带可展示的 `reason` 与稳定的 `code`。
 * - **不可预期的失败**（DB 崩了、文件读不了）→ 直接抛原生异常，**不做包装**——
 *   包装会掩盖真实故障点，违背本项目「诚实降级」纪律。
 *
 * 参照既有实现：`packages/core/src/v2/approval/approval-denied-error.ts`
 * 与 `packages/core/src/team/errors.ts`。
 *
 * @module super-agent/domain/errors
 */

/** 可预期的用户侧错误码 */
export type UserErrorCode =
  | "invalid-request" // 请求参数非法
  | "not-found" // 目标不存在
  | "state-conflict" // 当前状态不允许该操作
  | "authorization-revoked" // 授权已失效（Policy 复验失败）
  | "budget-exceeded" // 超出预算/打扰上限
  | "store-unavailable"; // 持久层不可用

/** 全部可预期的用户侧错误码（单一数据源，供 CLI 展示与测试复用） */
export const USER_ERROR_CODES: readonly UserErrorCode[] = Object.freeze([
  "invalid-request",
  "not-found",
  "state-conflict",
  "authorization-revoked",
  "budget-exceeded",
  "store-unavailable",
]);

/** 可预期的用户侧错误 */
export class UserError extends Error {
  /** 稳定错误码 */
  readonly code: UserErrorCode;
  /** 面向用户的可展示原因 */
  readonly reason: string;

  /**
   * 构造用户错误
   *
   * @param code 错误码
   * @param reason 面向用户的说明
   */
  constructor(code: UserErrorCode, reason: string) {
    super(`${code}: ${reason}`);
    this.name = "UserError";
    this.code = code;
    this.reason = reason;
  }
}

/** 判断是否为 UserError */
export function isUserError(error: unknown): error is UserError {
  return error instanceof UserError;
}

/** 便捷构造：非法请求 */
export function invalidRequest(reason: string): UserError {
  return new UserError("invalid-request", reason);
}

/** 便捷构造：目标不存在 */
export function notFound(reason: string): UserError {
  return new UserError("not-found", reason);
}

/** 便捷构造：状态冲突 */
export function stateConflict(reason: string): UserError {
  return new UserError("state-conflict", reason);
}

/** 便捷构造：授权已失效 */
export function authorizationRevoked(reason: string): UserError {
  return new UserError("authorization-revoked", reason);
}

/** 便捷构造：超出预算 / 打扰上限 */
export function budgetExceeded(reason: string): UserError {
  return new UserError("budget-exceeded", reason);
}

/** 便捷构造：持久层不可用 */
export function storeUnavailable(reason: string): UserError {
  return new UserError("store-unavailable", reason);
}
