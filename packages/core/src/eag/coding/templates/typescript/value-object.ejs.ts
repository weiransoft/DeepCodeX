/**
 * 值对象 EJS 模板（EAG-P2 批次 9 S1 基础层）
 *
 * 对应 EAG-P2 批次 9 设计 §4.2 templates/typescript/value-object.ejs。
 * 值对象特征：不可变 / 无标识 / 全字段 readonly / 通过工厂方法创建 / 值相等比较。
 *
 * 模板变量：
 * - moduleName：模块名
 * - modulePath：模块路径
 * - responsibility：模块职责描述
 * - requirementId：关联需求 ID
 * - taskId：关联任务卡 ID
 * - valueObjectName：值对象类名（如 "Money" / "Address"）
 * - fields：字段列表 [{ name, type, description }]
 *
 * 占位标记：
 * - TODO(phase-b): 实现工厂方法校验逻辑
 * - TODO(phase-b): 实现值相等比较逻辑
 *
 * @module eag/coding/templates/typescript/value-object
 */

/**
 * 值对象 EJS 模板字符串
 *
 * 渲染时由 SkeletonGenerator 调用 ejs.render(VALUE_OBJECT_TEMPLATE, variables) 输出骨架代码。
 */
export const VALUE_OBJECT_TEMPLATE = `/**
 * <%- moduleName %> 值对象
 *
 * 模块职责：<%- responsibility %>
 *
 * 关联需求：<%- requirementId %>
 * 关联任务：<%- taskId %>
 *
 * @module <%- modulePath %>
 */

/**
 * <%- valueObjectName %> 属性接口
 */
export interface <%- valueObjectName %>Props {
<%_ for (const field of fields) { _%>
  /** <%- field.description %> */
  readonly <%- field.name %>: <%- field.type %>;
<%_ } _%>
}

/**
 * <%- valueObjectName %> 值对象
 *
 * <%- responsibility %>
 *
 * 值对象特征：
 * - 不可变：所有字段 readonly，创建后不可修改
 * - 无标识：通过字段值而非 ID 判等
 * - 全字段相等：所有字段值相等即判定为同一值对象
 */
export class <%- valueObjectName %> {
  // ============================ 字段 ============================

<%_ for (const field of fields) { _%>
  /** <%- field.description %> */
  private readonly _<%- field.name %>: <%- field.type %>;

<%_ } _%>

  // ============================ 构造函数 ============================

  /**
   * 构造 <%- valueObjectName %> 实例（私有，仅通过工厂方法创建）
   *
   * @param props 值对象属性
   */
  private constructor(props: <%- valueObjectName %>Props) {
<%_ for (const field of fields) { _%>
    this._<%- field.name %> = props.<%- field.name %>;
<%_ } _%>
  }

  // ============================ 工厂方法 ============================

  /**
   * 创建 <%- valueObjectName %> 值对象
   *
   * 职责：
   * 1. 校验字段非空与合法性
   * 2. 应用业务规则（如金额非负、字符串长度限制）
   * 3. 返回不可变值对象实例
   *
   * // TODO(phase-b): 实现工厂方法校验逻辑
   *
   * @param props 值对象属性
   * @returns 新建的值对象实例
   */
  static create(props: <%- valueObjectName %>Props): <%- valueObjectName %> {
    throw new Error("TODO(phase-b): 实现 <%- valueObjectName %>.create 工厂方法");
  }

  // ============================ 值相等比较 ============================

  /**
   * 判断两个值对象是否相等（基于字段值，而非引用）
   *
   * // TODO(phase-b): 实现值相等比较逻辑
   *
   * @param other 另一个值对象
   * @returns 是否值相等
   */
  equals(other: <%- valueObjectName %>): boolean {
    throw new Error("TODO(phase-b): 实现 <%- valueObjectName %>.equals 值相等比较");
  }

  // ============================ 访问器 ============================

<%_ for (const field of fields) { _%>
  /** 获取 <%- field.description %> */
  get <%- field.name %>(): <%- field.type %> {
    return this._<%- field.name %>;
  }

<%_ } _%>

  // ============================ 序列化 ============================

  /**
   * 序列化为 JSON 对象
   *
   * @returns JSON 对象表示
   */
  toJSON(): {<%_ for (const field of fields) { _%> <%- field.name %>: <%- field.type %>; <%_ } _%>} {
    return {
<%_ for (const field of fields) { _%>
      <%- field.name %>: this._<%- field.name %>,
<%_ } _%>
    };
  }
}
`;
