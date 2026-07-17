/**
 * @deepcodex/quality 统一导出入口
 *
 * 质量门禁系统（Quality Gate System）：
 *   - UIUXAnalyzer：UI/UX 4 维度巡检分析（可访问性 / 交互质量 / 布局响应式 / UX 反模式）
 *   - VisualRegression：视觉回归测试 + 数据显示完整性检测 + 显示错误检测
 *   - CodeMapGenerator：代码地图生成器（模块依赖图 + 复杂度评估 + 死代码检测）
 *
 * 来源：multi-agent-team skill 全部移植为 TypeScript
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 设计原则：
 *   - 标准库优先：仅依赖 Node 内置 + 跨包类型
 *   - 失败安全：任何检测项异常不影响其他检查
 *   - 可执行建议：每条问题都给出明确的修复方案
 */

// ============================================================================
// UI/UX 巡检分析器
// ============================================================================
export { UIUXAnalyzer } from "./uiux-analyzer.js";
export type { DOMAuditData, ContrastSample, PageLike, UIUXReport } from "./uiux-analyzer.js";

// ============================================================================
// 视觉回归比对器
// ============================================================================
export { VisualRegression } from "./visual-regression.js";
export type { PixelRGBA, ImageAdapter, ImageData, DOMSignals, VisualRegressionOptions } from "./visual-regression.js";

// ============================================================================
// 代码地图生成器
// ============================================================================
export { CodeMapGenerator } from "./codemap/generator.js";
export type { CodeNode, CodeEdge, CodeMap, CodeMapStats, CodeMapOptions } from "./codemap/generator.js";
