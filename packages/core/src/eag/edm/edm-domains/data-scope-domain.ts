/**
 * 数据权限域预定义模型
 *
 * 本模块定义 EAG 方案 §5.7.1 公共内核五域之一的数据权限域。
 * 数据权限域区别于功能权限域（"能否调用 API"），解决"调用 API 后能看到哪些数据"
 * 的问题，包括行级权限（数据范围）与列级权限（字段脱敏）。
 *
 * 设计决策（对齐 §5.7.1 数据权限域行）：
 * - 行级五级模型：
 *   1. 本人（SELF）：仅能看到自己创建的数据
 *   2. 本部门（DEPT）：仅能看到本部门的数据
 *   3. 本部门及下级（DEPT_AND_SUBTREE）：能看到本部门及所有下级部门的数据
 *   4. 自定义组织集（CUSTOM_ORGS）：能看到指定组织集合的数据
 *   5. 全部（ALL）：能看到全部数据（管理员级）
 *   五级模型覆盖 80% 企业数据范围场景，自定义组织集兜底特殊场景
 * - 列级脱敏规则：
 *   - 手机号脱敏：138****1234
 *   - 身份证脱敏：110***********1234
 *   - 银行卡脱敏：************1234
 *   脱敏规则按角色绑定（如"客服"角色看手机号脱敏，"管理员"角色看明文）
 * - 查询改写（query rewriter）实现，而非业务代码 if-else：
 *   理由：业务代码 if-else 会导致权限逻辑散落在每个查询接口，难以维护与审计；
 *   查询改写在 ORM 层或 SQL 拦截器统一注入 WHERE 条件（如 WHERE creator_id = ?）
 *   与 SELECT 改写（如 SELECT mask_phone(phone) AS phone），实现一次生效全局覆盖。
 *   对应 EDM-02 红线：数据权限查询改写必须覆盖全部列表查询接口
 *
 * 不可变保证：
 * - 所有字段 readonly
 * - 顶层常量 Object.freeze 冻结，防止运行期被 LLM 自改
 * - 对齐 §5.12.4 G-A6d 配置冻结原则
 *
 * @module eag/edm/edm-domains/data-scope-domain
 */

import type { EdmDomainDefinition } from "../types";
import { deepFreeze } from "../types";

/**
 * 数据权限域定义常量
 *
 * 使用 Object.freeze 冻结，作为 EDM 信号检测器与骨架生成器的输入数据。
 * 修改本常量需走架构变更评审流程。
 */
const _DATA_SCOPE_DOMAIN = {
  id: "data-scope",
  name: "数据权限域",
  description:
    "企业应用公共内核之数据权限域，解决'调用 API 后能看到哪些数据'的问题。" +
    "行级五级模型：本人/本部门/本部门及下级/自定义组织集/全部；" +
    "列级脱敏规则：手机号/身份证/银行卡等字段按角色绑定掩码规则。" +
    "数据权限以查询改写（query rewriter）实现，禁止业务代码 if-else 散落权限逻辑" +
    "（对应 EDM-02 MAJOR 红线：查询改写必须覆盖全部列表查询接口）。",

  // 聚合：DataScopeAggregate（行级 + 列级数据权限管理）
  aggregates: [
    {
      name: "DataScopeAggregate",
      rootEntity: "DataScopeEntity",
      // 不变式：行级 + 列级权限约束
      invariants: [
        "行级范围合法性约束：scopeType 必须是五级模型之一（SELF/DEPT/DEPT_AND_SUBTREE/CUSTOM_ORGS/ALL）",
        "自定义组织集约束：scopeType=CUSTOM_ORGS 时 customOrgIds 不得为空",
        "全部范围约束：scopeType=ALL 时仅管理员角色可绑定（防止越权）",
        "脱敏规则覆盖约束：FieldMaskRuleEntity 必须覆盖敏感字段（phone/idCard/bankCard）",
        "查询改写覆盖约束：所有列表查询接口必须经过 DataScopeRewriter 改写（对应 EDM-02）",
      ],
      // 内部实体：FieldMaskRuleEntity（字段脱敏规则）
      containedEntities: ["FieldMaskRuleEntity"],
      // 值对象：RowLevelScopeVO（行级五级）、ColumnMaskRuleVO（列级脱敏）
      valueObjects: ["RowLevelScopeVO", "ColumnMaskRuleVO"],
      // 发布的领域事件：数据范围变更 + 脱敏应用
      publishedEvents: ["DataScopeChangedEvent", "FieldMaskAppliedEvent"],
    },
  ],

  // 值对象：2 个核心值对象
  valueObjects: [
    {
      // 行级范围值对象：描述行级五级模型
      name: "RowLevelScopeVO",
      attributes: [
        {
          name: "scopeType",
          type: '"SELF" | "DEPT" | "DEPT_AND_SUBTREE" | "CUSTOM_ORGS" | "ALL"',
          required: true,
        },
        { name: "customOrgIds", type: "ReadonlyArray<string> | null", required: false },
        { name: "selfField", type: "string", required: false },
        { name: "deptField", type: "string", required: false },
        { name: "description", type: "string", required: true },
      ],
      immutabilityGuarantee:
        "构造后所有字段 readonly，Object.freeze 冻结；" + "行级范围变更需创建新实例并触发 DataScopeChangedEvent",
    },
    {
      // 列级脱敏规则值对象：描述字段掩码规则
      name: "ColumnMaskRuleVO",
      attributes: [
        { name: "fieldName", type: "string", required: true },
        {
          name: "fieldType",
          type: '"phone" | "idCard" | "bankCard" | "email" | "address" | "custom"',
          required: true,
        },
        {
          name: "maskStrategy",
          type: '"fixed-length" | "keep-prefix-suffix" | "regex" | "hash"',
          required: true,
        },
        { name: "prefixKeep", type: "number", required: false },
        { name: "suffixKeep", type: "number", required: false },
        { name: "maskChar", type: "string", required: true },
        { name: "customRegex", type: "string | null", required: false },
      ],
      immutabilityGuarantee:
        "构造后所有字段 readonly，Object.freeze 冻结；" + "脱敏规则变更需走数据安全评审（涉及个人信息保护合规）",
    },
  ],

  // 领域事件：数据范围变更 + 脱敏应用
  domainEvents: [
    {
      // 数据范围变更事件：行级权限变更时触发
      // 订阅者需刷新数据权限缓存，否则查询改写器可能使用过期的范围规则
      name: "DataScopeChangedEvent",
      publisher: "DataScopeAggregate",
      subscribers: ["DataScopeCacheInvalidator", "QueryRewriterConfigRefresher", "AuditLogHandler"],
      payload: [
        { name: "roleId", type: "string", required: true },
        { name: "oldScopeType", type: "string", required: false },
        { name: "newScopeType", type: "string", required: true },
        { name: "changedBy", type: "string", required: true },
        { name: "changedAt", type: "Date", required: true },
      ],
    },
    {
      // 字段脱敏应用事件：脱敏规则被应用时触发（用于审计）
      // 记录"谁的数据被如何脱敏"，满足个人信息保护合规审计需求
      name: "FieldMaskAppliedEvent",
      publisher: "DataScopeAggregate",
      subscribers: ["AuditLogHandler", "DataSecurityComplianceHandler"],
      payload: [
        { name: "fieldName", type: "string", required: true },
        { name: "fieldType", type: "string", required: true },
        { name: "roleId", type: "string", required: true },
        { name: "appliedAt", type: "Date", required: true },
        { name: "queryPath", type: "string", required: true },
      ],
    },
  ],

  // 信号词：触发数据权限域纳入的关键词
  // 查询改写是数据权限域的核心实现机制，区别于业务代码 if-else
  signalKeywords: ["数据权限", "行级权限", "列级脱敏", "数据范围", "数据隔离", "查询改写"],
} satisfies EdmDomainDefinition;

/**
 * 数据权限域定义（深度冻结导出）
 *
 * 内部 _DATA_SCOPE_DOMAIN 已通过 `satisfies EdmDomainDefinition` 完整类型校验，
 * deepFreeze 递归冻结全部嵌套对象/数组后对外导出，确保运行期不可被 LLM 自改。
 */
export const DATA_SCOPE_DOMAIN: Readonly<EdmDomainDefinition> = deepFreeze(_DATA_SCOPE_DOMAIN);
