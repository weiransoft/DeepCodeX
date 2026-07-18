/**
 * PKC（项目知识上下文）模块入口（EAG-P1 批次 5）
 *
 * 本模块是 EAG（企业应用生成）体系 §5.11 PKC（项目知识上下文）层的统一对外入口，
 * 汇总 PKC 全部子模块的公开 API，作为外部消费者的唯一导入源。
 *
 * 设计依据：
 * - EAG 方案 §5.11 PKC 项目知识上下文
 * - §5.11.1 L1 全局视野层（目录树 + 模块职责 + 技术栈指纹 + 入口点 + 分层架构）
 *
 * 当前实施范围（P1 批次 5）：
 * - 仅实施 L1 全局视野层（基础能力）
 * - 不实施 §5.11.6 符号级知识图谱与爆炸半径分析（由 V2-P4 实施）
 *
 * 模块结构：
 * - types.ts：PKC 数据模型（层级/仓库地图/入口点/技术栈指纹/分层架构）
 * - l1-global-view.ts：L1GlobalViewBuilder 类（目录扫描 + 仓库地图构建）
 * - entry-point-detector.ts：EntryPointDetector 类（4 类入口点检测）
 * - tech-stack-fingerprint.ts：TechStackFingerprintExtractor 类
 *   （技术栈指纹提取 + 分层架构识别）
 *
 * 公开 API（barrel 导出）：
 * - 类型：PkcLayer / RepositoryMap / DirectoryNode / FileNode / EntryPoint /
 *         EntryPointType / TechStackFingerprint / LayeredArchitecture /
 *         LayeredArchitectureParadigm / L1GlobalView
 * - 常量：PKC_LAYERS / IMPLEMENTED_PKC_LAYERS / ENTRY_POINT_TYPES /
 *         DEFAULT_IGNORED_DIRECTORIES / DEFAULT_IGNORED_EXTENSIONS
 * - 类：L1GlobalViewBuilder / EntryPointDetector / TechStackFingerprintExtractor
 * - 异常：L1GlobalViewError
 * - 解析结果类型：PackageJsonParseResult / PomXmlParseResult /
 *                 RequirementsTxtParseResult / GoModParseResult
 *
 * @module eag/pkc
 */

// ============================================================================
// 类型与常量（from types.ts）
// ============================================================================

export type {
  PkcLayer,
  RepositoryMap,
  DirectoryNode,
  FileNode,
  EntryPoint,
  EntryPointType,
  TechStackFingerprint,
  LayeredArchitecture,
  LayeredArchitectureParadigm,
  L1GlobalView,
} from "./types";

export {
  PKC_LAYERS,
  IMPLEMENTED_PKC_LAYERS,
  ENTRY_POINT_TYPES,
  DEFAULT_IGNORED_DIRECTORIES,
  DEFAULT_IGNORED_EXTENSIONS,
} from "./types";

// ============================================================================
// L1 全局视野构建器（from l1-global-view.ts）
// ============================================================================

export { L1GlobalViewBuilder, L1GlobalViewError } from "./l1-global-view";

// ============================================================================
// 入口点检测器（from entry-point-detector.ts）
// ============================================================================

export { EntryPointDetector } from "./entry-point-detector";

// ============================================================================
// 技术栈指纹提取器（from tech-stack-fingerprint.ts）
// ============================================================================

export { TechStackFingerprintExtractor } from "./tech-stack-fingerprint";

export type {
  PackageJsonParseResult,
  PomXmlParseResult,
  RequirementsTxtParseResult,
  GoModParseResult,
} from "./tech-stack-fingerprint";
