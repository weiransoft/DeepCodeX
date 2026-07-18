/**
 * 功能权限域预定义模型
 *
 * 本模块定义 EAG 方案 §5.7.1 公共内核五域之一的功能权限域。
 * 功能权限域采用三级资源模型（菜单/API/按钮），承载 RBAC 中"角色-权限"关系的
 * "权限"侧，对应 EDM-01 红线（权限判定不得仅在前端）。
 *
 * 设计决策（对齐 §5.7.1 功能权限域行）：
 * - 三级资源模型：
 *   - 菜单（Menu）：控制前端导航可见性（粗粒度）
 *   - API：控制后端接口可调性（中粒度，网关层校验）
 *   - 按钮（Button）：控制页面内操作按钮可操作性（细粒度，前端校验 + 后端兜底）
 *   三级模型覆盖"看见 → 调用 → 操作"完整链路，菜单可见不代表 API 可调，
 *   API 可调不代表按钮可操作（如"查看订单"菜单可见，但"删除订单"按钮不可操作）
 * - 权限判定下沉到 API 网关 + 服务内双层校验：
 *   - 网关层粗粒度校验：基于 API 路径 + HTTP 方法，快速拦截无权请求
 *   - 服务内细粒度校验：基于业务上下文（如"是否本人订单"），防止越权访问他人数据
 *   双层校验对应 EDM-01 红线：仅前端校验或仅网关校验均视为违反
 *
 * 不可变保证：
 * - 所有字段 readonly
 * - 顶层常量 Object.freeze 冻结，防止运行期被 LLM 自改
 * - 对齐 §5.12.4 G-A6d 配置冻结原则
 *
 * @module eag/edm/edm-domains/permission-domain
 */

import type { EdmDomainDefinition } from "../types";
import { deepFreeze } from "../types";

/**
 * 功能权限域定义常量
 *
 * 使用 Object.freeze 冻结，作为 EDM 信号检测器与骨架生成器的输入数据。
 * 修改本常量需走架构变更评审流程。
 */
const _PERMISSION_DOMAIN = {
  id: "permission",
  name: "功能权限域",
  description:
    "企业应用公共内核之功能权限域，采用三级资源模型（菜单/API/按钮）覆盖" +
    "'看见 → 调用 → 操作'完整链路。权限判定下沉到 API 网关（粗粒度）+ 服务内（细粒度）" +
    "双层校验，禁止仅在前端 SPA 判定（对应 EDM-01 BLOCKER 红线）。" +
    "支持 RBAC（基于角色的访问控制）与 ABAC（基于属性的访问控制）混合模型。",

  // 聚合：PermissionAggregate（三级资源管理）
  aggregates: [
    {
      name: "PermissionAggregate",
      rootEntity: "PermissionEntity",
      // 不变式：三级资源一致性约束
      invariants: [
        "三级资源层级约束：按钮必须归属某个 API（按钮触发 API 调用），API 可归属菜单（菜单聚合多个 API）",
        "权限编码唯一性约束：permissionCode 在全局范围内唯一，格式为 'resource:action'（如 'order:create'）",
        "菜单树完整性约束：菜单 parentMenuId 不得形成循环引用",
        "API 路径唯一性约束：method + path 组合在全局范围内唯一",
        "按钮归属约束：buttonCode 在同一 API 范围内唯一（不同 API 可有同名按钮）",
      ],
      // 内部实体：MenuEntity / ApiEntity / ButtonEntity（三级资源）
      containedEntities: ["MenuEntity", "ApiEntity", "ButtonEntity"],
      // 值对象：PermissionResourceVO（资源摘要）、PermissionActionVO（动作枚举）
      valueObjects: ["PermissionResourceVO", "PermissionActionVO"],
      // 发布的领域事件：授权 + 撤销 + 菜单可见性变更
      publishedEvents: ["PermissionGrantedEvent", "PermissionRevokedEvent", "MenuVisibilityChangedEvent"],
    },
  ],

  // 值对象：2 个核心值对象
  valueObjects: [
    {
      // 权限资源摘要值对象：用于权限判定时快速获取资源信息
      name: "PermissionResourceVO",
      attributes: [
        { name: "resourceType", type: '"menu" | "api" | "button"', required: true },
        { name: "resourceCode", type: "string", required: true },
        { name: "resourceName", type: "string", required: true },
        { name: "parentResourceCode", type: "string | null", required: false },
        { name: "metadata", type: "Readonly<Record<string, string>>", required: false },
      ],
      immutabilityGuarantee:
        "构造后所有字段 readonly，Object.freeze 冻结；" + "资源摘要用于权限缓存键，不可变避免缓存脏读",
    },
    {
      // 权限动作值对象：描述允许的动作（CRUD + 自定义）
      name: "PermissionActionVO",
      attributes: [
        {
          name: "action",
          type: '"create" | "read" | "update" | "delete" | "export" | "import" | "approve"',
          required: true,
        },
        { name: "actionDescription", type: "string", required: true },
        { name: "requiresApproval", type: "boolean", required: true },
      ],
      immutabilityGuarantee:
        "构造后所有字段 readonly，Object.freeze 冻结；" + "动作定义是规范契约，变更需走架构变更评审",
    },
  ],

  // 领域事件：授权 + 撤销 + 菜单可见性变更
  domainEvents: [
    {
      // 权限授予事件：角色被授予权限时触发
      name: "PermissionGrantedEvent",
      publisher: "PermissionAggregate",
      subscribers: ["AuditLogHandler", "PermissionCacheInvalidator", "SessionRefreshHandler"],
      payload: [
        { name: "roleId", type: "string", required: true },
        { name: "permissionCode", type: "string", required: true },
        { name: "resourceType", type: '"menu" | "api" | "button"', required: true },
        { name: "grantedBy", type: "string", required: true },
        { name: "grantedAt", type: "Date", required: true },
      ],
    },
    {
      // 权限撤销事件
      name: "PermissionRevokedEvent",
      publisher: "PermissionAggregate",
      subscribers: ["AuditLogHandler", "PermissionCacheInvalidator", "SessionInvalidator"],
      payload: [
        { name: "roleId", type: "string", required: true },
        { name: "permissionCode", type: "string", required: true },
        { name: "revokedBy", type: "string", required: true },
        { name: "revokedAt", type: "Date", required: true },
        { name: "reason", type: "string", required: true },
      ],
    },
    {
      // 菜单可见性变更事件：菜单启用/禁用/隐藏时触发
      // 前端订阅此事件刷新导航树
      name: "MenuVisibilityChangedEvent",
      publisher: "PermissionAggregate",
      subscribers: ["AuditLogHandler", "FrontendCacheInvalidator"],
      payload: [
        { name: "menuCode", type: "string", required: true },
        { name: "visible", type: "boolean", required: true },
        { name: "changedAt", type: "Date", required: true },
        { name: "changedBy", type: "string", required: true },
      ],
    },
  ],

  // 信号词：触发功能权限域纳入的关键词
  // RBAC 是基于角色的访问控制的英文缩写，企业权限管理通用术语
  signalKeywords: ["权限", "菜单", "API 权限", "按钮", "功能权限", "RBAC"],
} satisfies EdmDomainDefinition;

/**
 * 功能权限域定义（深度冻结导出）
 *
 * 内部 _PERMISSION_DOMAIN 已通过 `satisfies EdmDomainDefinition` 完整类型校验，
 * deepFreeze 递归冻结全部嵌套对象/数组后对外导出，确保运行期不可被 LLM 自改。
 */
export const PERMISSION_DOMAIN: Readonly<EdmDomainDefinition> = deepFreeze(_PERMISSION_DOMAIN);
