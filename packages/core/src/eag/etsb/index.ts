/**
 * ETSB（Enterprise Tech Stack Blueprint，企业技术栈蓝图）模块入口
 *
 * 本模块是 EAG（企业应用生成）体系 §5.6（技术选型与企业架构蓝图）的统一对外入口，
 * 汇总 ETSB 全部子模块的公开 API，作为外部消费者的唯一导入源。
 *
 * 设计依据：
 * - EAG 方案 §5.6.1 技术选型矩阵（4 语言 × 10 层 = 40 单元格）
 * - EAG 方案 §5.6.2 部署蓝图（三套拓扑模板）
 * - EAG 方案 §5.6 选型决策流程（需求信号 → 矩阵候选过滤 → 决策表 → HUMAN_CHECKPOINT → 锁定）
 * - EAG 方案 SEED-06 规则（技术栈锁定后变更必须用户显式批准）
 *
 * 模块结构：
 * - types.ts：ETSB 数据模型（语言/层/矩阵/决策表/蓝图/锁定/输入信号）
 * - tech-stack-registry.ts：技术选型矩阵注册表（4 语言 × 10 层 + 查询 API）
 * - deployment-blueprints.ts：3 套部署蓝图 + 信号匹配选择函数
 * - tech-stack-selector.ts：TechStackSelector 类（纯规则匹配，不依赖 LLM）
 * - tech-stack-lock.ts：SEED-06 锁定/解锁/校验逻辑
 *
 * 公开 API（barrel 导出）：
 * - 类型：TechLanguage / TechLayer / TechStackOption / TechStackMatrixCell /
 *         TechStackMatrix / TechStackDecision / TechStackDecisionTable /
 *         DeploymentBlueprintId / DeploymentBlueprint / TechStackLock /
 *         TechStackSelectionInput
 * - 常量：TECH_LANGUAGES / TECH_LAYERS / DEPLOYMENT_BLUEPRINT_IDS /
 *         TECH_STACK_MATRIX / DEPLOYMENT_BLUEPRINTS
 * - 矩阵查询：getTechStackOptions / getAllLayers / getAllLanguages / getMatrixCellCount
 * - 蓝图查询：getDeploymentBlueprintById / selectDeploymentBlueprint
 * - 选型决策：TechStackSelector 类
 * - 锁定管理：lockTechStack / unlockTechStack / validateDependencyChange / TechStackLockError
 *
 * @module eag/etsb
 */

// ============================================================================
// 类型与常量（from types.ts）
// ============================================================================

export type {
  TechLanguage,
  TechLayer,
  TechStackOption,
  TechStackMatrixCell,
  TechStackMatrix,
  TechStackDecision,
  TechStackDecisionTable,
  DeploymentBlueprintId,
  DeploymentBlueprint,
  TechStackLock,
  TechStackSelectionInput,
} from "./types";

export { TECH_LANGUAGES, TECH_LAYERS, DEPLOYMENT_BLUEPRINT_IDS } from "./types";

// ============================================================================
// 技术选型矩阵注册表（from tech-stack-registry.ts）
// ============================================================================

export {
  TECH_STACK_MATRIX,
  getTechStackOptions,
  getAllLayers,
  getAllLanguages,
  getMatrixCellCount,
} from "./tech-stack-registry";

// ============================================================================
// 部署蓝图（from deployment-blueprints.ts）
// ============================================================================

export { DEPLOYMENT_BLUEPRINTS, getDeploymentBlueprintById, selectDeploymentBlueprint } from "./deployment-blueprints";

export type { DeploymentBlueprintSignals } from "./deployment-blueprints";

// ============================================================================
// 技术选型决策器（from tech-stack-selector.ts）
// ============================================================================

export { TechStackSelector } from "./tech-stack-selector";

// ============================================================================
// SEED-06 锁定管理（from tech-stack-lock.ts）
// ============================================================================

export { lockTechStack, unlockTechStack, validateDependencyChange, TechStackLockError } from "./tech-stack-lock";

export type { DependencyValidationResult } from "./tech-stack-lock";
