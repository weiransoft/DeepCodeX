/**
 * 应用服务 EJS 模板（EAG-P2 批次 9 S1 基础层）
 *
 * 对应 EAG-P2 批次 9 设计 §4.2 templates/typescript/application-service.ejs。
 * 应用服务特征：用例编排 / 事务脚本 / DTO 转换 / 协调领域服务与仓储 / 不含业务规则。
 *
 * 模板变量：
 * - moduleName：模块名
 * - modulePath：模块路径
 * - responsibility：模块职责描述
 * - requirementId：关联需求 ID
 * - taskId：关联任务卡 ID
 * - serviceClassName：应用服务类名（如 "OrderApplicationService"）
 * - dependencies：依赖列表 [{ name, type, importPath }]
 * - useCases：用例方法列表 [{ name, description, inputDto, outputDto }]
 *
 * 占位标记：
 * - TODO(phase-b): 实现用例编排逻辑
 *
 * @module eag/coding/templates/typescript/application-service
 */

/**
 * 应用服务 EJS 模板字符串
 *
 * 渲染时由 SkeletonGenerator 调用 ejs.render(APPLICATION_SERVICE_TEMPLATE, variables) 输出骨架代码。
 */
export const APPLICATION_SERVICE_TEMPLATE = `/**
 * <%- serviceClassName %> 应用服务
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
 * <%- serviceClassName %> 应用服务
 *
 * <%- responsibility %>
 *
 * 设计原则：
 * - 用例编排：协调领域服务、仓储、事件发布器完成用例
 * - 事务脚本：管理事务边界（单聚合强一致，跨聚合最终一致）
 * - DTO 转换：将输入 DTO 转换为领域命令，将领域对象转换为输出 DTO
 * - 无业务规则：业务规则由领域层负责，应用服务仅编排
 * - 幂等性：通过幂等键参数保证用例幂等（对齐 E2 红线）
 */
export class <%- serviceClassName %> {
  // ============================ 依赖注入 ============================

<%_ for (const dep of dependencies) { _%>
  /** <%- dep.type %> 依赖 */
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

  // ============================ 用例方法 ============================

<%_ for (const useCase of useCases) { _%>
  /**
   * <%- useCase.description %>
   *
   * 用例编排步骤：
   * 1. 校验幂等键（对齐 E2 红线）
   * 2. 将输入 DTO 转换为领域命令
   * 3. 调用领域服务或聚合根执行业务操作
   * 4. 通过仓储持久化聚合根变更
   * 5. 发布领域事件（异步）
   * 6. 将领域对象转换为输出 DTO
   *
   * // TODO(phase-b): 实现用例编排逻辑
   *
   * @param input 输入 DTO
   * @returns 输出 DTO
   */
  async <%- useCase.name %>(input: <%- useCase.inputDto %>): Promise<<%- useCase.outputDto %>> {
    throw new Error("TODO(phase-b): 实现 <%- serviceClassName %>.<%- useCase.name %> 用例编排逻辑");
  }

<%_ } _%>
}
`;
