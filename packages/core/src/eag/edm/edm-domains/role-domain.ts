/**
 * 角色域预定义模型
 *
 * 本模块定义 EAG 方案 §5.7.1 公共内核五域之一的角色域。
 * 角色域是 RBAC（基于角色的访问控制）的核心，承载角色-权限多对多关系、
 * 角色继承（高级角色含低级权限集）、SoD 互斥约束（职责分离）。
 *
 * 设计决策（对齐 §5.7.1 角色域行）：
 * - 角色-权限多对多：一个角色可关联多个权限，一个权限可被多个角色关联
 *   这是 RBAC 的基础模型，比 ACL（用户-权限直接映射）更易管理
 * - 角色继承：高级角色（如"管理员"）自动包含低级角色（如"操作员"）的权限集
 *   理由：避免重复授权，角色继承关系形成 DAG（有向无环图）
 * - SoD 互斥约束（职责分离）：互斥角色不得同时授予同一用户
 *   典型场景："制单"与"审批"互斥（避免自己审批自己创建的单据）
 *   SoD 是企业内控（SOX 法案合规）的核心约束，授权时必须校验
 *
 * 不可变保证：
 * - 所有字段 readonly
 * - 顶层常量 Object.freeze 冻结，防止运行期被 LLM 自改
 * - 对齐 §5.12.4 G-A6d 配置冻结原则
 *
 * @module eag/edm/edm-domains/role-domain
 */

import type { EdmDomainDefinition } from "../types";
import { deepFreeze } from "../types";

/**
 * 角色域定义常量
 *
 * 使用 Object.freeze 冻结，作为 EDM 信号检测器与骨架生成器的输入数据。
 * 修改本常量需走架构变更评审流程。
 */
const _ROLE_DOMAIN = {
  id: "role",
  name: "角色域",
  description:
    "企业应用公共内核之角色域，承载 RBAC 模型的角色管理。" +
    "核心能力：角色-权限多对多关系、角色继承（高级角色含低级权限集，DAG 结构）、" +
    "SoD 互斥约束（职责分离，如'制单'与'审批'互斥，授权时强制校验）。" +
    "SoD 是企业内控（SOX 合规）的核心约束，对应 EDM-03 红线。",

  // 聚合：RoleAggregate（角色继承 + SoD 互斥）
  aggregates: [
    {
      name: "RoleAggregate",
      rootEntity: "RoleEntity",
      // 不变式：角色继承 DAG + SoD 互斥约束
      invariants: [
        "角色继承关系必须是 DAG（有向无环图）：禁止循环继承（如 A→B→A）",
        "SoD 互斥约束：互斥角色（如'制单'与'审批'）不得同时授予同一用户",
        "角色编码唯一性约束：roleCode 在全局范围内唯一",
        "角色禁用约束：已禁用的角色不得新授予用户，但已授予的保留（避免历史数据失效）",
        "继承深度约束：角色继承链长度不得超过上限（默认 10，防止无限继承导致权限爆炸）",
      ],
      // 内部实体：RoleAssignmentEntity（角色分配记录）
      // 记录 userId ↔ roleId 的分配关系，含分配时间、分配人、状态
      containedEntities: ["RoleAssignmentEntity"],
      // 值对象：RoleHierarchyVO（继承关系）、SoDConstraintVO（互斥约束）
      valueObjects: ["RoleHierarchyVO", "SoDConstraintVO"],
      // 发布的领域事件：角色生命周期 + 分配/撤销 + 继承变更
      publishedEvents: ["RoleCreatedEvent", "RoleAssignedEvent", "RoleRevokedEvent", "RoleInheritanceChangedEvent"],
    },
  ],

  // 值对象：2 个核心值对象
  valueObjects: [
    {
      // 角色继承关系值对象：描述角色间的继承 DAG
      name: "RoleHierarchyVO",
      attributes: [
        { name: "parentRoleId", type: "string", required: true },
        { name: "childRoleId", type: "string", required: true },
        { name: "inheritanceType", type: '"full" | "partial"', required: true },
        { name: "inheritedPermissionIds", type: "ReadonlyArray<string> | null", required: false },
      ],
      immutabilityGuarantee:
        "构造后所有字段 readonly，Object.freeze 冻结；" + "继承关系变更需走架构变更评审，运行期不可被 LLM 自改",
    },
    {
      // SoD 互斥约束值对象：描述互斥角色对
      name: "SoDConstraintVO",
      attributes: [
        { name: "roleIdA", type: "string", required: true },
        { name: "roleIdB", type: "string", required: true },
        { name: "constraintType", type: '"mutual-exclusion" | "approval-separation"', required: true },
        { name: "description", type: "string", required: true },
      ],
      immutabilityGuarantee:
        "构造后所有字段 readonly，Object.freeze 冻结；" + "约束变更需走内控合规评审（SoD 涉及 SOX 合规）",
    },
  ],

  // 领域事件：角色生命周期 + 分配/撤销 + 继承变更
  domainEvents: [
    {
      name: "RoleCreatedEvent",
      publisher: "RoleAggregate",
      subscribers: ["AuditLogHandler", "PermissionCacheInvalidator"],
      payload: [
        { name: "roleId", type: "string", required: true },
        { name: "roleCode", type: "string", required: true },
        { name: "roleName", type: "string", required: true },
        { name: "createdAt", type: "Date", required: true },
      ],
    },
    {
      // 角色分配事件：用户被授予角色时触发
      // SoD 校验必须在分配前完成（EDM-03 红线要求）
      name: "RoleAssignedEvent",
      publisher: "RoleAggregate",
      subscribers: ["AuditLogHandler", "PermissionCacheInvalidator", "SessionRefreshHandler"],
      payload: [
        { name: "roleId", type: "string", required: true },
        { name: "userId", type: "string", required: true },
        { name: "assignedBy", type: "string", required: true },
        { name: "assignedAt", type: "Date", required: true },
        { name: "sodChecked", type: "boolean", required: true },
      ],
    },
    {
      // 角色撤销事件
      name: "RoleRevokedEvent",
      publisher: "RoleAggregate",
      subscribers: ["AuditLogHandler", "PermissionCacheInvalidator", "SessionInvalidator"],
      payload: [
        { name: "roleId", type: "string", required: true },
        { name: "userId", type: "string", required: true },
        { name: "revokedBy", type: "string", required: true },
        { name: "revokedAt", type: "Date", required: true },
        { name: "reason", type: "string", required: true },
      ],
    },
    {
      // 角色继承变更事件：继承关系调整将导致权限缓存失效
      name: "RoleInheritanceChangedEvent",
      publisher: "RoleAggregate",
      subscribers: ["AuditLogHandler", "PermissionCacheInvalidator"],
      payload: [
        { name: "parentRoleId", type: "string", required: true },
        { name: "childRoleId", type: "string", required: true },
        { name: "changeType", type: '"add" | "remove"', required: true },
        { name: "changedAt", type: "Date", required: true },
      ],
    },
  ],

  // 信号词：触发角色域纳入的关键词
  // 包含 SoD（职责分离的英文缩写，企业内控术语）
  signalKeywords: ["角色", "权限角色", "角色继承", "职责分离", "SoD", "互斥"],
} satisfies EdmDomainDefinition;

/**
 * 角色域定义（深度冻结导出）
 *
 * 内部 _ROLE_DOMAIN 已通过 `satisfies EdmDomainDefinition` 完整类型校验，
 * deepFreeze 递归冻结全部嵌套对象/数组后对外导出，确保运行期不可被 LLM 自改。
 */
export const ROLE_DOMAIN: Readonly<EdmDomainDefinition> = deepFreeze(_ROLE_DOMAIN);
