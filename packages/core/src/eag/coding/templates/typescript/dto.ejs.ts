/**
 * DTO EJS 模板（EAG-P2 批次 9 S1 基础层）
 *
 * 对应 EAG-P2 批次 9 设计 §4.2 templates/typescript/dto.ejs。
 * DTO 特征：数据传输对象 / 输入校验 / 序列化标注 / 无业务逻辑 / 跨层传输。
 *
 * 模板变量：
 * - moduleName：模块名
 * - modulePath：模块路径
 * - responsibility：模块职责描述
 * - requirementId：关联需求 ID
 * - taskId：关联任务卡 ID
 * - dtoName：DTO 类名（如 "CreateOrderInputDto" / "OrderOutputDto"）
 * - dtoType：DTO 类型（"input" | "output"）
 * - fields：字段列表 [{ name, type, description, validationRule }]
 *
 * 占位标记：
 * - TODO(phase-b): 应用 class-validator 装饰器（对齐 E5 红线）
 * - TODO(phase-b): 应用序列化装饰器（如 @Expose / @Exclude）
 *
 * @module eag/coding/templates/typescript/dto
 */

/**
 * DTO EJS 模板字符串
 *
 * 渲染时由 SkeletonGenerator 调用 ejs.render(DTO_TEMPLATE, variables) 输出骨架代码。
 */
export const DTO_TEMPLATE = `/**
 * <%- dtoName %> DTO
 *
 * 模块职责：<%- responsibility %>
 *
 * 关联需求：<%- requirementId %>
 * 关联任务：<%- taskId %>
 *
 * @module <%- modulePath %>
 */

/**
 * <%- dtoName %> <%- dtoType === "input" ? "输入" : "输出" %> DTO
 *
 * <%- responsibility %>
 *
 * 设计原则：
 * - 输入校验：使用 class-validator 装饰器声明校验规则（对齐 E5 红线）
 * - 序列化：使用 class-transformer 装饰器控制序列化字段
 * - 不可变：所有字段 readonly
 * - 无业务逻辑：DTO 仅承载数据，不包含业务方法
 *
 * 校验规则覆盖：
<%_ for (const field of fields) { _%>
 * - <%- field.name %>：<%- field.validationRule %>
<%_ } _%>
 *
 * // TODO(phase-b): 应用 class-validator 装饰器（对齐 E5 红线）
 */
export class <%- dtoName %> {
<%_ for (const field of fields) { _%>
  /**
   * <%- field.description %>
   *
   * 校验规则：<%- field.validationRule %>
   */
  // TODO(phase-b): @IsXxx() 装饰器待应用（对齐 E5 红线）
  readonly <%- field.name %>: <%- field.type %>;

<%_ } _%>

  // ============================ 构造函数 ============================

  /**
   * 构造 <%- dtoName %> 实例
   *
   * @param props DTO 属性
   */
  constructor(props: Omit<<%- dtoName %>, "">) {
<%_ for (const field of fields) { _%>
    this.<%- field.name %> = props.<%- field.name %>;
<%_ } _%>
  }

  // ============================ 序列化 ============================

  /**
   * 序列化为 JSON 对象
   *
   * // TODO(phase-b): 应用序列化装饰器（如 @Expose / @Exclude）
   *
   * @returns JSON 对象表示
   */
  toJSON(): Record<string, unknown> {
    return {
<%_ for (const field of fields) { _%>
      <%- field.name %>: this.<%- field.name %>,
<%_ } _%>
    };
  }
}
`;
