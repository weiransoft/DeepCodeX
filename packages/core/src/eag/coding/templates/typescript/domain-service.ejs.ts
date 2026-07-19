/**
 * 领域服务 EJS 模板（EAG-P2 批次 9 S1 基础层）
 *
 * 对应 EAG-P2 批次 9 设计 §4.2 templates/typescript/domain-service.ejs。
 * 领域服务特征：跨聚合业务逻辑 / 无状态 / 操作聚合根与值对象 / 不持有数据。
 *
 * 模板变量：
 * - moduleName：模块名
 * - modulePath：模块路径
 * - responsibility：模块职责描述
 * - requirementId：关联需求 ID
 * - taskId：关联任务卡 ID
 * - serviceClassName：服务类名（如 "PaymentDomainService" / "OrderDomainService"）
 * - dependencies：依赖列表 [{ name, type, importPath }]（依赖的仓储或聚合）
 * - methods：服务方法列表 [{ name, description, inputType, outputType }]
 *
 * 占位标记：
 * - TODO(phase-b): 实现跨聚合业务逻辑
 *
 * @module eag/coding/templates/typescript/domain-service
 */

/**
 * 领域服务 EJS 模板字符串
 *
 * 渲染时由 SkeletonGenerator 调用 ejs.render(DOMAIN_SERVICE_TEMPLATE, variables) 输出骨架代码。
 */
export const DOMAIN_SERVICE_TEMPLATE = `/**
 * <%- serviceClassName %> 领域服务
 *
 * 模块职责：<%- responsibility %>
 *
 * 关联需求：<%- requirementId %>
 * 关联任务：<%- taskId %>
 *
 * @module <%- modulePath %>
 */
<%_ for (const dep of dependencies) { _%>
import type { <%- dep.type %> } from "<%- dep.importPath %>";
<%_ } _%>

/**
 * <%- serviceClassName %> 领域服务
 *
 * <%- responsibility %>
 *
 * 设计原则：
 * - 无状态：服务实例不持有业务数据，所有状态由聚合根管理
 * - 跨聚合：协调多个聚合根完成跨聚合业务逻辑
 * - 事务边界：单聚合内强一致，跨聚合最终一致（通过领域事件）
 * - 依赖倒置：依赖仓储接口而非具体实现
 */
export class <%- serviceClassName %> {
  // ============================ 依赖注入 ============================

<%_ for (const dep of dependencies) { _%>
  /** <%- dep.type %> 依赖（通过构造函数注入） */
  private readonly <%- dep.name %>: <%- dep.type %>;

<%_ } _%>

  // ============================ 构造函数 ============================

  /**
   * 构造 <%- serviceClassName %> 实例
   *
   * @param dependencies 依赖注入参数
   */
  constructor(<%_ for (const dep of dependencies) { _%><%- dep.name %>: <%- dep.type %>, <%_ } _%>) {
<%_ for (const dep of dependencies) { _%>
    this.<%- dep.name %> = <%- dep.name %>;
<%_ } _%>
  }

  // ============================ 领域服务方法 ============================

<%_ for (const method of methods) { _%>
  /**
   * <%- method.description %>
   *
   * 职责：
   * 1. 加载相关聚合根（通过仓储）
   * 2. 执行跨聚合业务逻辑
   * 3. 持久化聚合根变更（通过仓储）
   * 4. 返回业务结果
   *
   * // TODO(phase-b): 实现跨聚合业务逻辑
   *
   * @param input 业务输入
   * @returns 业务输出
   */
  async <%- method.name %>(input: <%- method.inputType %>): Promise<<%- method.outputType %>> {
    throw new Error("TODO(phase-b): 实现 <%- serviceClassName %>.<%- method.name %> 领域服务方法");
  }

<%_ } _%>
}
`;
