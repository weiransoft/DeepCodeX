/**
 * 组织域预定义模型
 *
 * 本模块定义 EAG 方案 §5.7.1 公共内核五域之一的组织域。
 * 组织域承载企业组织架构管理，是权限/数据权限域的基础（数据权限的"本部门及下级"
 * 依赖组织树结构）。
 *
 * 设计决策（对齐 §5.7.1 组织域行 + §5.8.3 查询优化）：
 * - 组织树双写：物化路径（materialized path，如 "/root/dept-a/team-1"）+ 左右值（nested set）
 *   双写理由：物化路径适合查找祖先/后代（前缀匹配），左右值适合范围查询子树；
 *   两种结构各有所长，双写可在不同查询场景选择最优结构（§5.8.3 查询优化要求）
 * - 组织变更发布 OrgChangedEvent：权限缓存失效驱动
 *   理由：组织变更影响"本部门及下级"数据权限判定，缓存必须失效避免脏数据
 * - 岗位（Position）与汇报关系（ReportingLine）独立实体
 *   理由：岗位是组织节点的属性（如"研发部-前端组长"），汇报关系是节点间的关系
 *   （员工 A 汇报给员工 B），两者分离避免耦合
 *
 * 不可变保证：
 * - 所有字段 readonly
 * - 顶层常量 Object.freeze 冻结，防止运行期被 LLM 自改
 * - 对齐 §5.12.4 G-A6d 配置冻结原则
 *
 * @module eag/edm/edm-domains/org-domain
 */

import type { EdmDomainDefinition } from "../types";
import { deepFreeze } from "../types";

/**
 * 组织域定义常量
 *
 * 使用 Object.freeze 冻结，作为 EDM 信号检测器与骨架生成器的输入数据。
 * 修改本常量需走架构变更评审流程。
 */
const _ORG_DOMAIN = {
  id: "org",
  name: "组织域",
  description:
    "企业应用公共内核之组织域，承载组织树管理（物化路径 + 左右值双写优化查询）、" +
    "岗位（Position）与汇报关系（ReportingLine）管理。" +
    "组织变更是权限/数据权限缓存失效的源头事件，OrgChangedEvent 驱动下游缓存刷新。" +
    "是数据权限'本部门及下级'判定的结构基础。",

  // 聚合：OrgUnitAggregate（树形聚合根，物化路径 + 左右值双写）
  aggregates: [
    {
      name: "OrgUnitAggregate",
      rootEntity: "OrgUnitEntity",
      // 不变式：组织树结构完整性约束
      invariants: [
        "组织树不得出现循环引用：节点的祖先链中不得出现自身（物化路径前缀匹配自检）",
        "物化路径与左右值必须双写一致：path 前缀关系与 lft/rgt 范围包含关系必须对应",
        "根节点唯一性约束：组织树有且仅有一个根节点（parentId 为 null）",
        "组织编码唯一性约束：orgCode 在全局范围内唯一",
        "删除约束：含有子节点或岗位的节点不得删除（需先迁移子节点与岗位）",
      ],
      // 内部实体：PositionEntity（岗位）、ReportingLineEntity（汇报关系）
      // 岗位挂在组织节点下（一个节点可有多个岗位），汇报关系跨组织节点（员工 A→员工 B）
      containedEntities: ["PositionEntity", "ReportingLineEntity"],
      // 值对象：MaterializedPathVO（物化路径）、OrgNodeVO（节点摘要）
      valueObjects: ["MaterializedPathVO", "OrgNodeVO"],
      // 发布的领域事件：组织变更 + 节点创建 + 岗位变更
      publishedEvents: ["OrgChangedEvent", "OrgUnitCreatedEvent", "PositionChangedEvent"],
    },
  ],

  // 值对象：2 个核心值对象
  valueObjects: [
    {
      // 物化路径值对象：承载路径字符串与解析能力
      name: "MaterializedPathVO",
      attributes: [
        { name: "path", type: "string", required: true },
        { name: "depth", type: "number", required: true },
        { name: "ancestorIds", type: "ReadonlyArray<string>", required: true },
      ],
      immutabilityGuarantee:
        "构造后所有字段 readonly，Object.freeze 冻结；" +
        "路径变更需创建新的 MaterializedPathVO 实例（子树移动时整体重建）",
    },
    {
      // 组织节点摘要值对象：用于权限判定时快速获取节点信息
      name: "OrgNodeVO",
      attributes: [
        { name: "orgId", type: "string", required: true },
        { name: "orgCode", type: "string", required: true },
        { name: "orgName", type: "string", required: true },
        { name: "orgType", type: '"company" | "department" | "team" | "group"', required: true },
        { name: "path", type: "MaterializedPathVO", required: true },
        { name: "lft", type: "number", required: true },
        { name: "rgt", type: "number", required: true },
      ],
      immutabilityGuarantee:
        "构造后所有字段 readonly，Object.freeze 冻结；" + "节点摘要用于权限缓存，不可变避免缓存脏读",
    },
  ],

  // 领域事件：组织变更 + 节点创建 + 岗位变更
  domainEvents: [
    {
      // 组织变更事件：权限缓存失效的源头事件
      // 触发场景：节点移动、节点删除、节点重命名（重命名不影响权限但影响展示）
      name: "OrgChangedEvent",
      publisher: "OrgUnitAggregate",
      subscribers: ["PermissionCacheInvalidator", "DataScopeCacheInvalidator", "AuditLogHandler"],
      payload: [
        { name: "orgId", type: "string", required: true },
        { name: "changeType", type: '"move" | "delete" | "rename"', required: true },
        { name: "changedAt", type: "Date", required: true },
        { name: "changedBy", type: "string", required: true },
      ],
    },
    {
      // 组织节点创建事件
      name: "OrgUnitCreatedEvent",
      publisher: "OrgUnitAggregate",
      subscribers: ["AuditLogHandler", "DefaultPermissionAssigner"],
      payload: [
        { name: "orgId", type: "string", required: true },
        { name: "parentOrgId", type: "string | null", required: false },
        { name: "orgName", type: "string", required: true },
        { name: "createdAt", type: "Date", required: true },
      ],
    },
    {
      // 岗位变更事件：员工调岗/晋升时触发
      name: "PositionChangedEvent",
      publisher: "OrgUnitAggregate",
      subscribers: ["AuditLogHandler", "SalarySystemNotifier", "PermissionRecalculator"],
      payload: [
        { name: "positionId", type: "string", required: true },
        { name: "userId", type: "string", required: true },
        { name: "oldPosition", type: "string | null", required: false },
        { name: "newPosition", type: "string", required: true },
        { name: "changedAt", type: "Date", required: true },
      ],
    },
  ],

  // 信号词：触发组织域纳入的关键词
  signalKeywords: ["部门", "组织", "组织架构", "汇报", "岗位", "组织树"],
} satisfies EdmDomainDefinition;

/**
 * 组织域定义（深度冻结导出）
 *
 * 内部 _ORG_DOMAIN 已通过 `satisfies EdmDomainDefinition` 完整类型校验，
 * deepFreeze 递归冻结全部嵌套对象/数组后对外导出，确保运行期不可被 LLM 自改。
 */
export const ORG_DOMAIN: Readonly<EdmDomainDefinition> = deepFreeze(_ORG_DOMAIN);
