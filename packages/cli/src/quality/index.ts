/**
 * Quality 模块导出汇总
 *
 * 将 quality-cmd 主 handler 及其依赖适配器统一导出，
 * 供 packages/cli/src/ui/views/App.tsx 等调用方使用。
 *
 * 导出内容：
 *   - 主 handler：executeQualityCommand + parseQualityArgs
 *   - 类型定义：QualityCommandArgs / QualityCommandResult / QualityHandlerContext / QualitySubcommand
 *   - 适配器：FileBackedPageLike / SharpImageAdapter（供测试或高级用法直接引用）
 *   - 格式化器：formatCodeMapReport / formatUIUXReport / formatVisualReport / formatCombinedReport
 *
 * @module cli/quality
 */

// ============================================================================
// 主 handler 与类型定义
// ============================================================================
export { executeQualityCommand, parseQualityArgs } from "./quality-cmd.js";
export type {
  QualitySubcommand,
  QualityCommandArgs,
  QualityCommandResult,
  QualityHandlerContext,
} from "./quality-cmd.js";

// ============================================================================
// 适配器（供测试或高级用法直接引用）
// ============================================================================
export { FileBackedPageLike, FileBackedPageLikeError, resolveDomFilePath } from "./file-backed-page-like.js";
export { SharpImageAdapter, SharpImageAdapterError } from "./sharp-image-adapter.js";

// ============================================================================
// 报告格式化器
// ============================================================================
export {
  formatCodeMapReport,
  formatUIUXReport,
  formatVisualReport,
  formatCombinedReport,
  type ReportFormat,
} from "./quality-formatter.js";
