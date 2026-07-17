/**
 * 审批拒绝错误（ApprovalDeniedError）
 *
 * v2.4 P0-04 新增实现：v2.3 P1-18 在设计文档 §4.2.4 声明但 V2-P0a 未落地。
 *
 * 设计依据：
 * - V2_CONTEXT_MEMORY_TECH_DESIGN.md §4.2.4 ApprovalDeniedError 类定义
 * - V2_CONTEXT_MEMORY_TECH_DESIGN.md §4.3 ToolRouter.route 中两处 throw 调用点
 * - V2_P0B_ARCHITECT_REVIEW.md P0-04 修复建议
 *
 * 核心契约：
 * - 携带完整审批结果（ApprovalResult），供上层 UI 渲染拒绝原因与风险等级；
 * - instanceof 判定在 ES5 编译目标下仍有效（通过 Object.setPrototypeOf 修复原型链）；
 * - 4 处 throw 调用点（详见技术方案 §4.3 核对表）均传递完整 result，不丢失决策上下文。
 *
 * TypeScript 继承内置 Error 在编译目标为 ES5 时原型链会断裂，
 * 必须在构造函数中通过 Object.setPrototypeOf 修复，
 * 否则 `error instanceof ApprovalDeniedError` 判定失效。
 */

import type { ApprovalResult } from "./types";

/**
 * 审批拒绝错误类
 *
 * 当 ApprovalGate.decide 返回 "deny" 决策，或用户在 ask_user 提示中拒绝时，
 * ToolRouter.route() 抛出此错误。错误携带完整 ApprovalResult 对象，
 * 上层 UI 可通过 error.result 获取拒绝原因、风险评估等详情。
 *
 * @example
 * ```typescript
 * try {
 *   await toolRouter.route(ctx);
 * } catch (error) {
 *   if (error instanceof ApprovalDeniedError) {
 *     console.log(`拒绝原因：${error.message}`);
 *     console.log(`风险等级：${error.result.riskAssessment?.level}`);
 *     console.log(`风险评分：${error.result.riskAssessment?.score}`);
 *   }
 * }
 * ```
 */
export class ApprovalDeniedError extends Error {
  /** 错误名称固定为 "ApprovalDeniedError"，便于日志识别与 instanceof 判定 */
  override readonly name = "ApprovalDeniedError";

  /**
   * 构造审批拒绝错误
   *
   * @param message 人类可读的拒绝原因（中文，用于日志和用户提示）
   * @param result 完整审批结果（保留 decision/riskAssessment/snapshotRequired 供 UI 展示拒绝详情）
   */
  constructor(
    message: string,
    /** 完整审批结果（保留 decision/riskAssessment/snapshotRequired 供 UI 展示拒绝详情） */
    readonly result: ApprovalResult
  ) {
    super(message);
    // 修复 ES5 继承原型链，确保 instanceof 正确工作
    // 详见：https://github.com/Microsoft/TypeScript-wiki/blob/master/Breaking-Changes.md#extending-built-ins-like-error-array-and-map-may-no-longer-work
    Object.setPrototypeOf(this, ApprovalDeniedError.prototype);
  }
}
