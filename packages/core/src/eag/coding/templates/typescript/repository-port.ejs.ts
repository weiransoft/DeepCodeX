/**
 * 仓储接口 EJS 模板（EAG-P2 批次 9 S1 基础层）
 *
 * 对应 EAG-P2 批次 9 设计 §4.2 templates/typescript/repository-port.ejs。
 * 仓储接口特征：依赖倒置 / 领域层定义 / 基础设施层实现 / 屏蔽持久化细节。
 *
 * 模板变量：
 * - moduleName：模块名
 * - modulePath：模块路径
 * - responsibility：模块职责描述
 * - requirementId：关联需求 ID
 * - taskId：关联任务卡 ID
 * - aggregateName：聚合根类名（如 "OrderAggregate"）
 * - aggregateImportPath：聚合根导入路径（如 "../domain/order/OrderAggregate"）
 * - idType：聚合根 ID 类型（如 "string" / "number" / "UserId"）
 * - queryMethods：查询方法列表 [{ name, description, inputType, outputType }]
 *
 * 占位标记：
 * - TODO(phase-b): 由基础设施层实现仓储接口
 *
 * @module eag/coding/templates/typescript/repository-port
 */

/**
 * 仓储接口 EJS 模板字符串
 *
 * 渲染时由 SkeletonGenerator 调用 ejs.render(REPOSITORY_PORT_TEMPLATE, variables) 输出骨架代码。
 */
export const REPOSITORY_PORT_TEMPLATE = `/**
 * <%- aggregateName %>Repository 仓储接口
 *
 * 模块职责：<%- responsibility %>
 *
 * 关联需求：<%- requirementId %>
 * 关联任务：<%- taskId %>
 *
 * @module <%- modulePath %>
 */

import type { <%- aggregateName %> } from "<%- aggregateImportPath %>";

/**
 * <%- aggregateName %> 仓储接口（依赖倒置原则）
 *
 * <%- responsibility %>
 *
 * 设计原则：
 * - 领域层定义接口，基础设施层实现接口
 * - 屏蔽持久化细节（SQL / NoSQL / 文件系统）
 * - 提供聚合根的增删改查能力
 * - 支持乐观锁（version 字段）
 *
 * 实现方：
 * - 基础设施层 <%- aggregateName %>RepositoryImpl（TypeORM / Prisma / 原生 SQL）
 *
 * // TODO(phase-b): 由基础设施层实现仓储接口
 */
export interface <%- aggregateName %>Repository {
  /**
   * 按 ID 查找聚合根
   *
   * @param id 聚合根 ID
   * @returns 聚合根实例，不存在时返回 null
   */
  findById(id: <%- idType %>): Promise<<%- aggregateName %> | null>;

  /**
   * 查找所有聚合根（分页）
   *
   * @param limit 每页数量（默认 20，上限 100）
   * @param offset 偏移量（默认 0）
   * @returns 聚合根列表
   */
  findAll(limit?: number, offset?: number): Promise<ReadonlyArray<<%- aggregateName %>>>;

  /**
   * 保存聚合根（新增或更新）
   *
   * 实现方职责：
   * 1. 检测聚合根版本号实现乐观锁
   * 2. 持久化聚合根状态
   * 3. 提交事务（与基础设施层事务管理器协同）
   *
   * @param aggregate 聚合根实例
   * @returns 持久化后的聚合根（含新版本号）
   */
  save(aggregate: <%- aggregateName %>): Promise<<%- aggregateName %>>;

  /**
   * 删除聚合根
   *
   * @param id 聚合根 ID
   * @returns 是否删除成功（不存在时返回 false）
   */
  delete(id: <%- idType %>): Promise<boolean>;

<%_ for (const method of queryMethods) { _%>
  /**
   * <%- method.description %>
   *
   * @param input 查询输入
   * @returns 查询输出
   */
  <%- method.name %>(input: <%- method.inputType %>): Promise<<%- method.outputType %>>;

<%_ } _%>
}
`;
