/**
 * 事件处理器 EJS 模板（EAG-P2 批次 9 S1 基础层）
 *
 * 对应 EAG-P2 批次 9 设计 §4.2 templates/typescript/event-handler.ejs。
 * 事件处理器特征：异步消费 / 幂等去重 / 死信处理 / 不阻塞发布方 / 错误重试。
 *
 * 模板变量：
 * - moduleName：模块名
 * - modulePath：模块路径
 * - responsibility：模块职责描述
 * - requirementId：关联需求 ID
 * - taskId：关联任务卡 ID
 * - handlerClassName：处理器类名（如 "OrderCreatedHandler"）
 * - eventName：处理的事件名（如 "OrderCreated"）
 * - eventImportPath：事件导入路径
 * - dependencies：依赖列表 [{ name, type, importPath }]
 *
 * 占位标记：
 * - TODO(phase-b): 实现事件处理逻辑
 * - TODO(phase-b): 实现幂等去重（对齐 E2 红线）
 *
 * @module eag/coding/templates/typescript/event-handler
 */

/**
 * 事件处理器 EJS 模板字符串
 *
 * 渲染时由 SkeletonGenerator 调用 ejs.render(EVENT_HANDLER_TEMPLATE, variables) 输出骨架代码。
 */
export const EVENT_HANDLER_TEMPLATE = `/**
 * <%- handlerClassName %> 事件处理器
 *
 * 模块职责：<%- responsibility %>
 *
 * 关联需求：<%- requirementId %>
 * 关联任务：<%- taskId %>
 *
 * @module <%- modulePath %>
 */

import type { <%- eventName %> } from "<%- eventImportPath %>";
<%_ for (const dep of dependencies) { _%>
import type { <%- dep.type %> } from "<%- dep.importPath %>";
<%_ } _%>

/**
 * <%- handlerClassName %> 事件处理器
 *
 * <%- responsibility %>
 *
 * 设计原则：
 * - 异步消费：通过消息队列异步消费领域事件
 * - 幂等去重：基于 eventId 去重，重复事件不重复处理（对齐 E2 红线）
 * - 死信处理：处理失败的事件转入死信队列，人工介入
 * - 不阻塞发布方：事件处理失败不影响发布方事务
 * - 错误重试：指数退避重试（默认 3 次）
 */
export class <%- handlerClassName %> {
  // ============================ 依赖注入 ============================

<%_ for (const dep of dependencies) { _%>
  /** <%- dep.type %> 依赖 */
  private readonly <%- dep.name %>: <%- dep.type %>;

<%_ } _%>

  // ============================ 构造函数 ============================

  /**
   * 构造 <%- handlerClassName %> 实例
   *
   * @param dependencies 依赖注入参数
   */
  constructor(<%_ for (const dep of dependencies) { _%><%- dep.name %>: <%- dep.type %>, <%_ } _%>) {
<%_ for (const dep of dependencies) { _%>
    this.<%- dep.name %> = <%- dep.name %>;
<%_ } _%>
  }

  // ============================ 事件处理 ============================

  /**
   * 处理 <%- eventName %> 事件
   *
   * 处理流程：
   * 1. 校验事件 ID（幂等去重，对齐 E2 红线）
   * 2. 解析事件载荷
   * 3. 执行业务副作用（如更新读模型、发送通知、调用外部服务）
   * 4. 记录处理结果（成功 / 失败）
   * 5. 失败时按重试策略重试
   *
   * // TODO(phase-b): 实现事件处理逻辑
   *
   * @param event 领域事件
   * @returns 处理结果（成功 / 失败 / 跳过）
   */
  async handle(event: <%- eventName %>): Promise<{ success: boolean; reason?: string }> {
    throw new Error("TODO(phase-b): 实现 <%- handlerClassName %>.handle 事件处理逻辑");
  }

  // ============================ 幂等去重 ============================

  /**
   * 校验事件是否已处理（幂等去重，对齐 E2 红线）
   *
   * 实现职责：
   * 1. 查询幂等表（event_id → 处理结果）
   * 2. 已处理则返回上次结果
   * 3. 未处理则记录并继续
   *
   * // TODO(phase-b): 实现幂等去重（对齐 E2 红线）
   *
   * @param eventId 事件 ID
   * @returns 是否首次处理（true=首次，false=已处理过）
   */
  private async checkIdempotency(eventId: string): Promise<boolean> {
    throw new Error("TODO(phase-b): 实现 <%- handlerClassName %>.checkIdempotency 幂等去重");
  }

  // ============================ 死信处理 ============================

  /**
   * 将处理失败的事件转入死信队列
   *
   * 实现职责：
   * 1. 记录失败事件与异常堆栈
   * 2. 发送至死信队列
   * 3. 触发告警（通知运维人工介入）
   *
   * @param event 处理失败的事件
   * @param error 异常对象
   */
  private async sendToDeadLetterQueue(event: <%- eventName %>, error: Error): Promise<void> {
    // 死信队列写入逻辑由 Phase B 实现
    throw new Error("TODO(phase-b): 实现 <%- handlerClassName %>.sendToDeadLetterQueue 死信处理");
  }
}
`;
