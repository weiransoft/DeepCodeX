/**
 * 企业通用域模型包（EDM, Enterprise Data Model）模块入口
 *
 * 本模块是 EAG（企业应用生成）体系 §5.7 企业通用域模型包的统一对外入口，
 * 汇总 EDM 全部子模块的公开 API，作为外部消费者的唯一导入源。
 *
 * 设计依据：
 * - EAG 方案 §5.7 企业通用域模型包
 * - §5.7.1 公共内核五域（用户域/组织域/角色域/功能权限域/数据权限域）
 * - §5.7.2 EDM 纳入机制（信号检测 + 骨架模板 + 领域模型 + 迁移脚本三件套 + 3 条红线）
 *
 * 模块结构：
 * - types.ts：EDM 核心类型定义（EdmDomainId / EdmDomainDefinition / EdmDetectionResult / EdmRedlineViolation 等）
 * - edm-domains/：5 个公共内核域预定义模型（user/org/role/permission/data-scope）
 * - edm-detector.ts：信号检测器（EdmSignalDetector 类）
 * - edm-redlines.ts：3 条 EDM 专属红线判定器（EDM-01/02/03）
 *
 * 公开 API（barrel 导出）：
 * - 类型：EdmDomainId / EdmDomainDefinition / EdmAggregateDefinition / EdmValueObjectDefinition / EdmDomainEventDefinition / EdmAttributeDefinition / EdmDetectionResult / EdmRedlineId / EdmRedlineSeverity / EdmRedlineViolation
 * - 常量：EDM_DOMAIN_IDS / EDM_REDLINE_IDS / EDM_REDLINE_SEVERITY_MAP / 5 个域定义常量 / EDM_ALL_DOMAINS / EDM_REDLINE_CHECKERS
 * - 类：EdmSignalDetector
 * - 函数：checkEdm01FrontendOnlyPermission / checkEdm02DataScopeQueryRewriteCoverage / checkEdm03RoleMutualExclusionCheck
 * - 工件类型：Edm01Artifacts / Edm02Artifacts / Edm03Artifacts
 *
 * @module eag/edm
 */

// ============================================================================
// 类型定义（from types.ts）
// ============================================================================

export type {
  EdmDomainId,
  EdmAttributeDefinition,
  EdmAggregateDefinition,
  EdmValueObjectDefinition,
  EdmDomainEventDefinition,
  EdmDomainDefinition,
  EdmDetectionResult,
  EdmRedlineId,
  EdmRedlineSeverity,
  EdmRedlineViolation,
} from "./types";

export { EDM_DOMAIN_IDS, EDM_REDLINE_IDS, EDM_REDLINE_SEVERITY_MAP, deepFreeze } from "./types";

// ============================================================================
// 5 个公共内核域预定义模型（from edm-domains/）
// ============================================================================

export { USER_DOMAIN } from "./edm-domains/user-domain";
export { ORG_DOMAIN } from "./edm-domains/org-domain";
export { ROLE_DOMAIN } from "./edm-domains/role-domain";
export { PERMISSION_DOMAIN } from "./edm-domains/permission-domain";
export { DATA_SCOPE_DOMAIN } from "./edm-domains/data-scope-domain";

// ============================================================================
// 信号检测器（from edm-detector.ts）
// ============================================================================

export { EdmSignalDetector, EDM_ALL_DOMAINS } from "./edm-detector";

// ============================================================================
// 红线判定器（from edm-redlines.ts）
// ============================================================================

export type { Edm01Artifacts, Edm02Artifacts, Edm03Artifacts, EdmRedlineChecker } from "./edm-redlines";

export {
  checkEdm01FrontendOnlyPermission,
  checkEdm02DataScopeQueryRewriteCoverage,
  checkEdm03RoleMutualExclusionCheck,
  EDM_REDLINE_CHECKERS,
} from "./edm-redlines";
