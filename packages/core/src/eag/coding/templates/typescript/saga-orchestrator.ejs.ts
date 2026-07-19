/**
 * Saga 编排器 EJS 模板（EAG-P2 批次 9 S1 基础层）
 *
 * 对应 EAG-P2 批次 9 设计 §4.2 templates/typescript/saga-orchestrator.ejs。
 * Saga 编排器特征：跨聚合最终一致 / 补偿事务 / 状态机驱动 / 事件驱动流转。
 *
 * 模板变量：
 * - moduleName：模块名
 * - modulePath：模块路径
 * - responsibility：模块职责描述
 * - requirementId：关联需求 ID
 * - taskId：关联任务卡 ID
 * - sagaName：Saga 类名（如 "OrderPaymentSaga"）
 * - sagaStates：状态列表 ["STARTED", "PAYMENT_PENDING", "PAYMENT_COMPLETED", "COMPLETED", "COMPENSATING", "FAILED"]
 * - steps：步骤列表 [{
 *     name: "processPayment",
 *     description: "处理支付",
 *     action: "调用支付服务",
 *     compensation: "退款"
 *   }]
 *
 * 占位标记：
 * - TODO(phase-b): 实现步骤执行逻辑
 * - TODO(phase-b): 实现补偿事务逻辑
 *
 * @module eag/coding/templates/typescript/saga-orchestrator
 */

/**
 * Saga 编排器 EJS 模板字符串
 *
 * 渲染时由 SkeletonGenerator 调用 ejs.render(SAGA_ORCHESTRATOR_TEMPLATE, variables) 输出骨架代码。
 */
export const SAGA_ORCHESTRATOR_TEMPLATE = `/**
 * <%- sagaName %> Saga 编排器
 *
 * 模块职责：<%- responsibility %>
 *
 * 关联需求：<%- requirementId %>
 * 关联任务：<%- taskId %>
 *
 * @module <%- modulePath %>
 */

/**
 * <%- sagaName %> 状态（状态机驱动）
 *
 * 状态流转：
 * - STARTED → 业务步骤执行中
 * - COMPLETED → 所有步骤成功完成
 * - COMPENSATING → 某步骤失败，执行补偿事务
 * - FAILED → 补偿失败或不可恢复错误
 */
export type <%- sagaName %>State =
<%_ for (const state of sagaStates) { _%>
  | "<%- state %>"
<%_ } _%>
  ;

/**
 * <%- sagaName %> Saga 编排器
 *
 * <%- responsibility %>
 *
 * 设计原则：
 * - 跨聚合最终一致：协调多个聚合根完成跨聚合业务流程
 * - 补偿事务：每步操作定义对应补偿动作，失败时反向执行
 * - 状态机驱动：状态流转由事件触发，状态持久化支持重启恢复
 * - 事件驱动：订阅领域事件触发步骤执行
 *
 * 对齐 E1 红线：跨聚合写必须通过 Saga 模式实现最终一致性。
 */
export class <%- sagaName %> {
  // ============================ 字段 ============================

  /** Saga 实例 ID */
  private readonly sagaId: string;
  /** 当前状态 */
  private state: <%- sagaName %>State;
  /** 已完成步骤（用于补偿时反向执行） */
  private completedSteps: ReadonlyArray<string>;

  // ============================ 构造函数 ============================

  /**
   * 构造 <%- sagaName %> 实例
   *
   * @param sagaId Saga 实例 ID
   */
  constructor(sagaId: string) {
    this.sagaId = sagaId;
    this.state = "STARTED";
    this.completedSteps = [];
  }

  // ============================ 状态机方法 ============================

  /**
   * 获取当前状态
   *
   * @returns 当前 Saga 状态
   */
  getState(): <%- sagaName %>State {
    return this.state;
  }

  // ============================ 业务步骤 ============================

<%_ for (const step of steps) { _%>
  /**
   * <%- step.description %>
   *
   * 执行职责：<%- step.action %>
   * 补偿职责：<%- step.compensation %>
   *
   * 算法：
   * 1. 检查前置状态
   * 2. 执行业务操作
   * 3. 记录已完成步骤（用于补偿）
   * 4. 失败时触发补偿
   *
   * // TODO(phase-b): 实现步骤执行逻辑
   *
   * @param input 步骤输入
   * @returns 步骤输出
   */
  async <%- step.name %>(input: unknown): Promise<unknown> {
    throw new Error("TODO(phase-b): 实现 <%- sagaName %>.<%- step.name %> 步骤执行逻辑");
  }

<%_ } _%>

  // ============================ 补偿事务 ============================

  /**
   * 执行补偿事务（反向执行已完成步骤的补偿动作）
   *
   * 算法：
   * 1. 反向遍历 completedSteps
   * 2. 对每个步骤执行对应补偿动作
   * 3. 记录补偿结果
   * 4. 全部补偿成功 → state=FAILED
   * 5. 补偿失败 → state=FAILED（需人工介入）
   *
   * // TODO(phase-b): 实现补偿事务逻辑
   *
   * @returns 补偿是否成功
   */
  async compensate(): Promise<boolean> {
    throw new Error("TODO(phase-b): 实现 <%- sagaName %>.compensate 补偿事务逻辑");
  }
}
`;
