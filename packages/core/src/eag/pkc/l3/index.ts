/**
 * PKC L3 业务知识层模块入口（EAG-P2 批次 8）
 *
 * 本模块是 EAG（企业应用生成）体系 §5.11.2 L3 业务知识层的统一对外入口，
 * 汇总 L3 全部子模块的公开 API，作为外部消费者的唯一导入源。
 *
 * 设计依据：
 * - EAG 方案 §5.11.2 L3 业务知识五项子能力（K2~K5）
 * - K2 业务流程还原：HTTP 路由 + 调用链 + MQ 生产/消费 → 业务流程
 * - K3 数据库结构理解：schema 解析 + 迁移工具历史 + 表-代码双向溯源
 * - K4 业务数据理解：字典表/枚举/常量类识别 + 字段语义推断 + 敏感字段标注
 * - K5 周边系统关联：配置文件/env/docker-compose/k8s 解析 + 交互矩阵
 *
 * 模块结构：
 * - l3-types.ts：L3 数据模型（K2 流程/K3 数据库/K4 数据字典/K5 周边系统）
 * - business-flow-discoverer.ts：BusinessFlowDiscoverer 类（K2 业务流程还原）
 * - database-schema-analyzer.ts：DatabaseSchemaAnalyzer 类（K3 数据库结构理解）
 * - data-dictionary-extractor.ts：DataDictionaryExtractor 类（K4 业务数据理解）
 * - peripheral-system-analyzer.ts：PeripheralSystemAnalyzer 类（K5 周边系统关联）
 *
 * 公开 API（barrel 导出）：
 * - 类型：FlowStep / FlowStepType / FlowBranch / AsyncBoundary / StateMachine /
 *         StateTransition / FlowResult / StateMachineResult /
 *         DatabaseTable / DatabaseColumn / DatabaseIndex / DatabaseForeignKey /
 *         DatabaseMigration / TableCodeTrace / SchemaAnalysisResult /
 *         BusinessEnum / BusinessEnumValue / DictionaryTable / FieldSemantics /
 *         SensitiveField / DataDictionary /
 *         PeripheralDependencyType / PeripheralDependency /
 *         InteractionMatrixEntry / ConfigInventoryEntry / PeripheralAnalysisResult
 * - 类：BusinessFlowDiscoverer / DatabaseSchemaAnalyzer /
 *       DataDictionaryExtractor / PeripheralSystemAnalyzer
 * - 异常：BusinessFlowDiscovererError / DatabaseSchemaAnalyzerError /
 *         DataDictionaryExtractorError / PeripheralSystemAnalyzerError
 *
 * @module eag/pkc/l3
 */

// ============================================================================
// 类型定义（from l3-types.ts）
// ============================================================================

export type {
  // K2 业务流程还原类型
  FlowStep,
  FlowStepType,
  FlowBranch,
  AsyncBoundary,
  StateMachine,
  StateTransition,
  FlowResult,
  StateMachineResult,
  // K3 数据库结构理解类型
  DatabaseTable,
  DatabaseColumn,
  DatabaseIndex,
  DatabaseForeignKey,
  DatabaseMigration,
  TableCodeTrace,
  SchemaAnalysisResult,
  // K4 业务数据理解类型
  BusinessEnum,
  BusinessEnumValue,
  DictionaryTable,
  FieldSemantics,
  SensitiveField,
  DataDictionary,
  // K5 周边系统关联类型
  PeripheralDependencyType,
  PeripheralDependency,
  InteractionMatrixEntry,
  ConfigInventoryEntry,
  PeripheralAnalysisResult,
} from "./l3-types";

// ============================================================================
// K2 业务流程还原器（from business-flow-discoverer.ts）
// ============================================================================

export { BusinessFlowDiscoverer, BusinessFlowDiscovererError } from "./business-flow-discoverer";

// ============================================================================
// K3 数据库结构理解器（from database-schema-analyzer.ts）
// ============================================================================

export { DatabaseSchemaAnalyzer, DatabaseSchemaAnalyzerError } from "./database-schema-analyzer";

// ============================================================================
// K4 业务数据理解器（from data-dictionary-extractor.ts）
// ============================================================================

export { DataDictionaryExtractor, DataDictionaryExtractorError } from "./data-dictionary-extractor";

// ============================================================================
// K5 周边系统关联分析器（from peripheral-system-analyzer.ts）
// ============================================================================

export { PeripheralSystemAnalyzer, PeripheralSystemAnalyzerError } from "./peripheral-system-analyzer";
