/**
 * 仓储实现 EJS 模板（EAG-P2 批次 9 S1 基础层）
 *
 * 对应 EAG-P2 批次 9 设计 §4.2 templates/typescript/repository-impl.ejs。
 * 仓储实现特征：基础设施层 / 实现领域层接口 / 屏蔽持久化细节 / 乐观锁实现。
 *
 * 模板变量：
 * - moduleName：模块名
 * - modulePath：模块路径
 * - responsibility：模块职责描述
 * - requirementId：关联需求 ID
 * - taskId：关联任务卡 ID
 * - aggregateName：聚合根类名
 * - aggregateImportPath：聚合根导入路径
 * - portImportPath：仓储接口导入路径
 * - idType：聚合根 ID 类型
 * - ormType：ORM 类型（如 "TypeORM" / "Prisma" / "Knex"）
 * - ormEntityName：ORM 实体名（如 "OrderEntity"）
 * - ormEntityImportPath：ORM 实体导入路径
 *
 * 占位标记：
 * - TODO(phase-b): 实现聚合根与 ORM 实体的双向映射
 * - TODO(phase-b): 实现乐观锁检测
 * - TODO(phase-b): 实现持久化逻辑
 *
 * @module eag/coding/templates/typescript/repository-impl
 */

/**
 * 仓储实现 EJS 模板字符串
 *
 * 渲染时由 SkeletonGenerator 调用 ejs.render(REPOSITORY_IMPL_TEMPLATE, variables) 输出骨架代码。
 */
export const REPOSITORY_IMPL_TEMPLATE = `/**
 * <%- aggregateName %>RepositoryImpl 仓储实现
 *
 * 模块职责：<%- responsibility %>
 *
 * 关联需求：<%- requirementId %>
 * 关联任务：<%- taskId %>
 *
 * @module <%- modulePath %>
 */

import type { <%- aggregateName %> } from "<%- aggregateImportPath %>";
import type { <%- aggregateName %>Repository } from "<%- portImportPath %>";
import type { <%- ormEntityName %> } from "<%- ormEntityImportPath %>";

/**
 * <%- aggregateName %> 仓储实现（<%- ormType %> 实现）
 *
 * <%- responsibility %>
 *
 * 实现职责：
 * - 实现领域层 <%- aggregateName %>Repository 接口
 * - 屏蔽 <%- ormType %> 持久化细节
 * - 实现聚合根与 ORM 实体的双向映射
 * - 实现乐观锁（基于 version 字段）
 * - 与基础设施层事务管理器协同
 *
 * 注意事项：
 * - 严禁在仓储实现中包含业务逻辑（业务逻辑属于领域层）
 * - 严禁跨聚合联表查询（跨聚合通过领域服务协调）
 * - 严禁直接暴露 ORM 实体给领域层（必须经过映射）
 */
export class <%- aggregateName %>RepositoryImpl implements <%- aggregateName %>Repository {
  // ============================ 构造函数 ============================

  /**
   * 构造 <%- aggregateName %>RepositoryImpl 实例
   *
   * @param ormClient <%- ormType %> 客户端（由依赖注入容器提供）
   */
  constructor(
    private readonly ormClient: unknown
  ) {}

  // ============================ 仓储接口实现 ============================

  /**
   * 按 ID 查找聚合根
   *
   * 实现步骤：
   * 1. 通过 ORM 客户端查询 <%- ormEntityName %>
   * 2. 将 ORM 实体映射为聚合根
   * 3. 不存在时返回 null
   *
   * @param id 聚合根 ID
   * @returns 聚合根实例，不存在时返回 null
   */
  async findById(id: <%- idType %>): Promise<<%- aggregateName %> | null> {
    throw new Error("TODO(phase-b): 实现 <%- aggregateName %>RepositoryImpl.findById 持久化逻辑");
  }

  /**
   * 查找所有聚合根（分页）
   *
   * @param limit 每页数量
   * @param offset 偏移量
   * @returns 聚合根列表
   */
  async findAll(limit: number = 20, offset: number = 0): Promise<ReadonlyArray<<%- aggregateName %>>> {
    throw new Error("TODO(phase-b): 实现 <%- aggregateName %>RepositoryImpl.findAll 持久化逻辑");
  }

  /**
   * 保存聚合根（新增或更新）
   *
   * 实现步骤：
   * 1. 将聚合根映射为 ORM 实体
   * 2. 检测聚合根版本号实现乐观锁
   * 3. 持久化 ORM 实体
   * 4. 返回持久化后的聚合根（含新版本号）
   *
   * @param aggregate 聚合根实例
   * @returns 持久化后的聚合根
   */
  async save(aggregate: <%- aggregateName %>): Promise<<%- aggregateName %>> {
    throw new Error("TODO(phase-b): 实现 <%- aggregateName %>RepositoryImpl.save 持久化逻辑与乐观锁检测");
  }

  /**
   * 删除聚合根
   *
   * @param id 聚合根 ID
   * @returns 是否删除成功
   */
  async delete(id: <%- idType %>): Promise<boolean> {
    throw new Error("TODO(phase-b): 实现 <%- aggregateName %>RepositoryImpl.delete 持久化逻辑");
  }

  // ============================ 映射方法（私有） ============================

  /**
   * 将 ORM 实体映射为聚合根
   *
   * // TODO(phase-b): 实现聚合根与 ORM 实体的双向映射
   *
   * @param entity ORM 实体
   * @returns 聚合根实例
   */
  private toAggregate(entity: <%- ormEntityName %>): <%- aggregateName %> {
    throw new Error("TODO(phase-b): 实现 <%- ormEntityName %> → <%- aggregateName %> 映射");
  }

  /**
   * 将聚合根映射为 ORM 实体
   *
   * @param aggregate 聚合根实例
   * @returns ORM 实体
   */
  private toEntity(aggregate: <%- aggregateName %>): <%- ormEntityName %> {
    throw new Error("TODO(phase-b): 实现 <%- aggregateName %> → <%- ormEntityName %> 映射");
  }
}
`;
