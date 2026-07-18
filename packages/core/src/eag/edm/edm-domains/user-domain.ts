/**
 * 用户域预定义模型
 *
 * 本模块定义 EAG 方案 §5.7.1 公共内核五域之一的用户域。
 * 用户域是 80% 企业应用的基础内核，承载账号生命周期管理、凭证（多登录方式绑定）、
 * 密码策略（强度/过期/历史去重）等核心能力。
 *
 * 设计决策（对齐 §5.7.1 用户域行）：
 * - 账号生命周期状态机：在职（ACTIVE）/ 停用（SUSPENDED）/ 注销（DEACTIVATED）
 *   状态转换必须符合生命周期约束（如注销态不可直接转回在职，需重新注册）
 * - 凭证与身份分离：UserEntity 仅承载身份属性（username/email/phone），
 *   CredentialVO 承载凭证（密码哈希/OTP 公钥/OAuth ID），支持多登录方式绑定
 *   （同一用户可同时绑定密码 + 短信验证码 + 企业微信扫码）
 * - 密码策略值对象：PasswordPolicyVO 描述密码强度要求、过期天数、历史去重数量，
 *   作为值对象被聚合根持有，避免策略逻辑散落在服务层
 *
 * 不可变保证：
 * - 所有字段 readonly
 * - 顶层常量 Object.freeze 冻结，防止运行期被 LLM 自改
 * - 对齐 §5.12.4 G-A6d 配置冻结原则
 *
 * @module eag/edm/edm-domains/user-domain
 */

import type { EdmDomainDefinition } from "../types";
import { deepFreeze } from "../types";

/**
 * 用户域定义常量
 *
 * 使用 Object.freeze 冻结，作为 EDM 信号检测器与骨架生成器的输入数据。
 * 修改本常量需走架构变更评审流程。
 *
 * 实现说明：先以字面量对象 + `satisfies EdmDomainDefinition` 做完整类型校验
 * 并保留字面量类型（避免 TS widen 为 string），再 Object.freeze 冻结。
 */
const _USER_DOMAIN = {
  id: "user",
  name: "用户域",
  description:
    "企业应用公共内核之用户域，承载账号生命周期管理（在职/停用/注销状态机）、" +
    "凭证与身份分离（支持多登录方式绑定：密码/短信/OAuth/扫码）、" +
    "密码策略值对象（强度/过期/历史去重）。" +
    "用户域是 80% 企业应用的基础内核，避免每个项目重复造账号体系。",

  // 聚合：UserAggregate（聚合根 UserEntity）
  aggregates: [
    {
      name: "UserAggregate",
      rootEntity: "UserEntity",
      // 不变式：账号状态转换必须符合生命周期状态机
      // 状态机：ACTIVE ↔ SUSPENDED（双向，停用可恢复）；ACTIVE/SUSPENDED → DEACTIVATED（单向，注销不可逆）
      invariants: [
        "账号状态转换必须符合生命周期状态机：ACTIVE ↔ SUSPENDED（双向可恢复），" +
          "ACTIVE/SUSPENDED → DEACTIVATED（单向不可逆，注销后需重新注册）",
        "凭证绑定数量上限约束：同一用户同类型凭证最多 1 个，不同类型凭证总数不超过 5 个",
        "密码历史去重约束：新密码不得与最近 N 个历史密码相同（N 由 PasswordPolicyVO.passwordHistoryCount 决定）",
        "用户名唯一性约束：username 在全局范围内唯一，邮箱/手机号在已验证的凭证中唯一",
      ],
      // 内部实体：无（用户域聚合仅含聚合根 + 值对象，无复杂内部实体）
      containedEntities: [],
      // 值对象：CredentialVO（凭证）、UserProfileVO（资料）、PasswordPolicyVO（密码策略）
      valueObjects: ["CredentialVO", "UserProfileVO", "PasswordPolicyVO"],
      // 发布的领域事件：覆盖账号生命周期各阶段 + 凭证绑定
      publishedEvents: [
        "UserCreatedEvent",
        "UserActivatedEvent",
        "UserSuspendedEvent",
        "UserDeactivatedEvent",
        "CredentialBoundEvent",
      ],
    },
  ],

  // 值对象：3 个核心值对象，描述用户域的关键概念
  valueObjects: [
    {
      // 凭证值对象：与身份分离，支持多登录方式绑定
      name: "CredentialVO",
      attributes: [
        { name: "credentialType", type: '"password" | "sms" | "oauth" | "scan"', required: true },
        { name: "credentialValue", type: "string", required: true },
        { name: "verified", type: "boolean", required: true },
        { name: "verifiedAt", type: "Date | null", required: false },
        { name: "lastUsedAt", type: "Date | null", required: false },
      ],
      immutabilityGuarantee:
        "构造后所有字段 readonly，Object.freeze 冻结；" +
        "凭证值存储哈希而非明文（password 类型用 bcrypt 哈希，oauth 类型存 provider+subject）",
    },
    {
      // 用户资料值对象：承载非凭证类的身份属性
      name: "UserProfileVO",
      attributes: [
        { name: "displayName", type: "string", required: true },
        { name: "avatarUrl", type: "string | null", required: false },
        { name: "department", type: "string | null", required: false },
        { name: "title", type: "string | null", required: false },
        { name: "extension", type: "string | null", required: false },
      ],
      immutabilityGuarantee:
        "构造后所有字段 readonly，Object.freeze 冻结；" + "更新资料需创建新的 UserProfileVO 实例并替换聚合根持有引用",
    },
    {
      // 密码策略值对象：描述密码强度/过期/历史去重约束
      name: "PasswordPolicyVO",
      attributes: [
        { name: "minLength", type: "number", required: true },
        { name: "requireUppercase", type: "boolean", required: true },
        { name: "requireLowercase", type: "boolean", required: true },
        { name: "requireDigit", type: "boolean", required: true },
        { name: "requireSpecialChar", type: "boolean", required: true },
        { name: "expireDays", type: "number", required: true },
        { name: "passwordHistoryCount", type: "number", required: true },
      ],
      immutabilityGuarantee:
        "构造后所有字段 readonly，Object.freeze 冻结；" + "策略变更需走配置变更评审流程，运行期不可被 LLM 自改",
    },
  ],

  // 领域事件：覆盖账号生命周期各阶段 + 凭证绑定
  domainEvents: [
    {
      name: "UserCreatedEvent",
      publisher: "UserAggregate",
      subscribers: ["AuditLogHandler", "WelcomeEmailSender", "DefaultPermissionAssigner"],
      payload: [
        { name: "userId", type: "string", required: true },
        { name: "username", type: "string", required: true },
        { name: "createdAt", type: "Date", required: true },
      ],
    },
    {
      name: "UserActivatedEvent",
      publisher: "UserAggregate",
      subscribers: ["AuditLogHandler"],
      payload: [
        { name: "userId", type: "string", required: true },
        { name: "activatedAt", type: "Date", required: true },
        { name: "activatedBy", type: "string", required: true },
      ],
    },
    {
      name: "UserSuspendedEvent",
      publisher: "UserAggregate",
      subscribers: ["AuditLogHandler", "SessionInvalidator"],
      payload: [
        { name: "userId", type: "string", required: true },
        { name: "suspendedAt", type: "Date", required: true },
        { name: "reason", type: "string", required: true },
      ],
    },
    {
      name: "UserDeactivatedEvent",
      publisher: "UserAggregate",
      subscribers: ["AuditLogHandler", "SessionInvalidator", "DataRetentionHandler"],
      payload: [
        { name: "userId", type: "string", required: true },
        { name: "deactivatedAt", type: "Date", required: true },
        { name: "reason", type: "string", required: true },
      ],
    },
    {
      name: "CredentialBoundEvent",
      publisher: "UserAggregate",
      subscribers: ["AuditLogHandler", "SecurityNotificationHandler"],
      payload: [
        { name: "userId", type: "string", required: true },
        { name: "credentialType", type: '"password" | "sms" | "oauth" | "scan"', required: true },
        { name: "boundAt", type: "Date", required: true },
      ],
    },
  ],

  // 信号词：触发用户域纳入的关键词
  // DESIGN Loop 的 Discovery 阶段扫描需求文本，命中任一即建议纳入用户域
  signalKeywords: ["登录", "账号", "用户", "密码", "凭证", "注册"],
} satisfies EdmDomainDefinition;

/**
 * 用户域定义（深度冻结导出）
 *
 * 内部 _USER_DOMAIN 已通过 `satisfies EdmDomainDefinition` 完整类型校验，
 * deepFreeze 递归冻结全部嵌套对象/数组后对外导出，确保运行期不可被 LLM 自改。
 */
export const USER_DOMAIN: Readonly<EdmDomainDefinition> = deepFreeze(_USER_DOMAIN);
