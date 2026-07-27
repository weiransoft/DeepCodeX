/**
 * Review 模块导出汇总
 *
 * 将 review-cmd 主 handler 及其格式化器统一导出，
 * 供 packages/cli/src/ui/views/App.tsx 等调用方使用。
 *
 * 导出内容：
 *   - 主 handler：executeReviewCommand + parseReviewArgs + formatReviewHelp
 *   - 类型定义：ReviewSubcommand / ReviewCommandArgs / ReviewCommandResult / ReviewHandlerContext
 *   - 辅助函数：detectProjectType / getToolCommands
 *   - 错误类型：ReviewArgsError
 *   - 格式化器：formatReviewReport + ReviewReportSection
 *
 * @module cli/review
 */

// ============================================================================
// 主 handler 与类型定义
// ============================================================================
export {
  executeReviewCommand,
  parseReviewArgs,
  formatReviewHelp,
  detectProjectType,
  getToolCommands,
  ReviewArgsError,
} from "./review-cmd.js";
export type {
  ReviewSubcommand,
  ReviewCommandArgs,
  ReviewCommandResult,
  ReviewHandlerContext,
  RunToolCommandOptions,
  ToolCommandRecord,
  ProjectType,
} from "./review-cmd.js";

// ============================================================================
// 报告格式化器
// ============================================================================
export { formatReviewReport } from "./review-formatter.js";
export type { ReviewReportSection, FormatReviewReportArgs } from "./review-formatter.js";
