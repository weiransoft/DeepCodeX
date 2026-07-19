/**
 * 增量测试选择器 barrel（EAG-P3 批次 11 §8.2）
 *
 * 本模块是 `eag/testing/incremental/` 目录的 barrel（统一导出），
 * 让外部消费者从 `eag/testing/incremental` 统一导入所有类型与类。
 *
 * 导出内容（对齐 §8.2 模块结构）：
 * - 类型与常量：types.ts 全部导出
 * - GitDiffAnalyzer：git diff 分析器
 * - BlastRadiusBfs：爆炸半径 BFS 算法
 * - RiskScorer：风险评分器
 * - IncrementalTestSelector：增量测试选择器编排器
 *
 * 使用方式：
 * ```typescript
 * import {
 *   GitDiffAnalyzer,
 *   BlastRadiusBfs,
 *   RiskScorer,
 *   IncrementalTestSelector,
 *   type IncrementalTestSelection,
 * } from "./incremental";
 *
 * const selector = new IncrementalTestSelector(
 *   new GitDiffAnalyzer(),
 *   new BlastRadiusBfs(),
 *   new RiskScorer()
 * );
 * const selection: IncrementalTestSelection = selector.select(...);
 * ```
 *
 * @module eag/testing/incremental
 */

// 类型与常量（types.ts）
export * from "./types";

// 类（具体实现）
export { GitDiffAnalyzer } from "./git-diff-analyzer";
export { BlastRadiusBfs } from "./blast-radius-bfs";
export { RiskScorer } from "./risk-scorer";
export { IncrementalTestSelector } from "./incremental-test-selector";
