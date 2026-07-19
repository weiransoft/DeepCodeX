/**
 * 聚合根 EJS 模板（EAG-P2 批次 9 S1 基础层）
 *
 * 对应 EAG-P2 批次 9 设计 §4.2.4 EJS 模板示例（aggregate.ejs）。
 * 本文件以 TypeScript 字符串常量形式导出 EJS 模板，避免 Node ESM 读取 .ejs 文件的路径问题（D-12）。
 *
 * 模板变量：
 * - moduleName：模块名（如 "OrderAggregate"）
 * - modulePath：模块路径（如 "domain/order/OrderAggregate"）
 * - responsibility：模块职责描述
 * - requirementId：关联需求 ID（如 "F-001"）
 * - taskId：关联任务卡 ID（如 "T-001"）
 * - aggregateName：聚合根类名（如 "OrderAggregate"）
 * - domainEventFileName：领域事件文件名（如 "OrderCreated"）
 * - fields：字段列表 [{ name, type, description }]
 * - businessMethods：业务方法列表 [{ name, description, commandType }]
 *
 * 占位标记：
 * - TODO(phase-b): 实现创建逻辑，包含不变式校验与领域事件发布
 * - TODO(phase-b): 实现业务逻辑，遵循聚合内强一致 + 跨聚合最终一致
 *
 * @module eag/coding/templates/typescript/aggregate
 */

/**
 * 聚合根 EJS 模板字符串
 *
 * 使用反引号包裹避免转义；EJS 语法 <%- %> 与 <%_ _%> 不会与 TypeScript 模板字符串冲突。
 * 渲染时由 SkeletonGenerator 调用 ejs.render(AGGREGATE_TEMPLATE, variables) 输出骨架代码。
 */
export const AGGREGATE_TEMPLATE = `/**
 * <%- moduleName %> 聚合根
 *
 * 模块职责：<%- responsibility %>
 *
 * 关联需求：<%- requirementId %>
 * 关联任务：<%- taskId %>
 *
 * @module <%- modulePath %>
 */

import type { DomainEvent } from "./<%- domainEventFileName %>";

/**
 * <%- aggregateName %> 属性接口（工厂方法入参）
 */
export interface <%- aggregateName %>Props {
<%_ for (const field of fields) { _%>
  /** <%- field.description %> */
  readonly <%- field.name %>: <%- field.type %>;
<%_ } _%>
}

/**
 * <%- aggregateName %> 创建命令
 */
export interface <%- aggregateName %>CreateCommand {
<%_ for (const field of fields) { _%>
  /** <%- field.description %> */
  readonly <%- field.name %>: <%- field.type %>;
<%_ } _%>
}

/**
 * <%- aggregateName %> 聚合根
 *
 * <%- responsibility %>
 *
 * 不变式约束（由 Phase B 实现）：
 * - 字段非空校验
 * - 业务规则一致性校验
 * - 跨字段不变式校验
 */
export class <%- aggregateName %> {
  // ============================ 字段 ============================

<%_ for (const field of fields) { _%>
  /** <%- field.description %> */
  private readonly _<%- field.name %>: <%- field.type %>;

<%_ } _%>

  // ============================ 构造函数 ============================

  /**
   * 构造 <%- aggregateName %> 实例（私有，仅通过工厂方法创建）
   *
   * @param props 聚合根属性
   */
  private constructor(props: <%- aggregateName %>Props) {
<%_ for (const field of fields) { _%>
    this._<%- field.name %> = props.<%- field.name %>;
<%_ } _%>
  }

  // ============================ 工厂方法 ============================

  /**
   * 创建 <%- aggregateName %>（领域工厂方法）
   *
   * 职责：
   * 1. 校验命令参数（不变式约束）
   * 2. 构造聚合根实例
   * 3. 发布领域事件（如 <%- aggregateName %>Created）
   *
   * // TODO(phase-b): 实现创建逻辑，包含不变式校验与领域事件发布
   *
   * @param command 创建命令
   * @returns 新建的聚合根实例与待发布事件列表
   */
  static create(command: <%- aggregateName %>CreateCommand): { aggregate: <%- aggregateName %>; events: DomainEvent[] } {
    throw new Error("TODO(phase-b): 实现 <%- aggregateName %>.create 工厂方法");
  }

  // ============================ 业务方法 ============================

<%_ for (const method of businessMethods) { _%>
  /**
   * <%- method.description %>
   *
   * 职责：
   * 1. 校验操作前置条件
   * 2. 修改聚合状态（保持不变式）
   * 3. 发布相关领域事件
   *
   * // TODO(phase-b): 实现业务逻辑，遵循聚合内强一致 + 跨聚合最终一致
   *
   * @param command 方法命令
   * @returns 待发布的领域事件列表
   */
  <%- method.name %>(command: <%- method.commandType %>): DomainEvent[] {
    throw new Error("TODO(phase-b): 实现 <%- aggregateName %>.<%- method.name %> 业务方法");
  }

<%_ } _%>

  // ============================ 访问器 ============================

<%_ for (const field of fields) { _%>
  /** 获取 <%- field.description %> */
  get <%- field.name %>(): <%- field.type %> {
    return this._<%- field.name %>;
  }

<%_ } _%>
}
`;
