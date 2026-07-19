/**
 * IncrementalTestSelector：增量测试选择器编排器（EAG-P3 批次 11 §8.7）
 *
 * 本模块实现 `IncrementalTestSelector` 类，对应 EAG-P3 批次 11 设计 §8.7：
 * 编排 GitDiffAnalyzer → BlastRadiusBfs → RiskScorer 流水线，
 * 按总评分排序选择 Top-N 测试，返回 IncrementalTestSelection。
 *
 * 核心职责（对齐 §8.7）：
 * 1. 调用 GitDiffAnalyzer 提取变更文件清单（git diff）
 * 2. 调用 BlastRadiusBfs 计算受影响测试（BFS 遍历依赖图）
 * 3. 对每个受影响测试调用 RiskScorer 评分（4 维度评分 + 总评分）
 * 4. 按总评分降序排序（高分优先）
 * 5. 取 Top-N（默认 20）
 * 6. 返回 IncrementalTestSelection（含 selectedTests / totalCandidates / coverageEstimate）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - select() 返回的 IncrementalTestSelection 通过 Object.freeze 冻结
 * - selectedTests 数组与每个 SelectedTest 对象本身也冻结
 * - 构造函数注入的 GitDiffAnalyzer / BlastRadiusBfs / RiskScorer 使用 readonly 修饰
 *
 * 依赖注入原则（对齐 DIP）：
 * - 构造函数注入 GitDiffAnalyzer / BlastRadiusBfs / RiskScorer，便于测试与替换
 * - 调用方负责实例化并注入具体实现（生产环境用真实实现，测试用真实实现）
 *
 * @module eag/testing/incremental/incremental-test-selector
 */

import type { BlastRadiusNode, IncrementalTestSelection, SelectedTest } from "./types";
import { DEFAULT_TOP_N } from "./types";
import type { GitDiffAnalyzer } from "./git-diff-analyzer";
import type { BlastRadiusBfs } from "./blast-radius-bfs";
import type { RiskScorer } from "./risk-scorer";

// ============================================================================
// IncrementalTestSelector 类
// ============================================================================

/**
 * IncrementalTestSelector：增量测试选择器编排器
 *
 * 实现 §8.7 设计——编排 GitDiffAnalyzer → BlastRadiusBfs → RiskScorer 流水线。
 *
 * 使用方式：
 * ```typescript
 * const selector = new IncrementalTestSelector(
 *   new GitDiffAnalyzer(),
 *   new BlastRadiusBfs(),
 *   new RiskScorer()
 * );
 * const selection = selector.select(
 *   "/path/to/project",          // projectRoot
 *   "HEAD~1",                     // base
 *   "HEAD",                       // head
 *   dependencyGraph,              // PKC L2 依赖图（邻接表）
 *   ["PaymentService.refund"],    // 高风险符号列表
 *   20                            // Top-N（默认 20）
 * );
 * for (const test of selection.selectedTests) {
 *   console.log(`[${test.totalScore.toFixed(2)}] ${test.testPath}`);
 * }
 * ```
 *
 * 流水线：
 * 1. GitDiffAnalyzer.analyze() → GitFileChange[]
 * 2. GitFileChange[].filePath → BlastRadiusBfs.bfs() → BlastRadiusNode[]
 * 3. BlastRadiusNode[] (type="test") → RiskScorer.score() → SelectedTest[]
 * 4. SelectedTest[] 排序 → Top-N → IncrementalTestSelection
 */
export class IncrementalTestSelector {
  /**
   * 初始化 IncrementalTestSelector
   *
   * 通过构造函数注入 GitDiffAnalyzer / BlastRadiusBfs / RiskScorer 三个组件，
   * 便于测试与替换（依赖注入原则）。
   *
   * @param gitDiffAnalyzer git diff 分析器（提取变更文件清单）
   * @param blastRadiusBfs 爆炸半径 BFS 算法（计算受影响测试）
   * @param riskScorer 风险评分器（4 维度评分）
   */
  constructor(
    private readonly gitDiffAnalyzer: GitDiffAnalyzer,
    private readonly blastRadiusBfs: BlastRadiusBfs,
    private readonly riskScorer: RiskScorer
  ) {}

  /**
   * 选择增量测试
   *
   * 算法（对齐 §8.7）：
   * 1. 调用 GitDiffAnalyzer.analyze(projectRoot, base, head) 提取变更文件清单
   * 2. 提取变更文件的 filePath 列表作为 BFS 的 sourceFiles
   * 3. 调用 BlastRadiusBfs.bfs(sourceFiles, dependencyGraph) 计算受影响节点
   * 4. 过滤出 type="test" 的节点（受影响测试）
   * 5. 对每个测试节点调用 RiskScorer.score() 计算 scores 与 totalScore
   * 6. 构造 SelectedTest（含 testPath / totalScore / scores / affectedFiles / reason）
   * 7. 按 totalScore 降序排序（高分优先）
   * 8. 取 Top-N（默认 20）
   * 9. 计算 coverageEstimate = selectedTests.length / totalCandidates
   * 10. 返回 Object.freeze 冻结的 IncrementalTestSelection
   *
   * 边界处理：
   * - 变更文件清单为空 → selectedTests=[] / totalCandidates=0 / coverageEstimate=0
   * - 无受影响测试 → selectedTests=[] / totalCandidates=0 / coverageEstimate=0
   * - Top-N 大于候选数 → selectedTests 包含全部候选（不报错）
   * - Top-N <= 0 → 按 1 处理（至少选 1 个，防御性处理）
   *
   * @param projectRoot 项目根目录（绝对路径，git 命令的 cwd）
   * @param base 基线提交（如 "HEAD~1" / "main" / commit SHA）
   * @param head 目标提交（默认 "HEAD"）
   * @param dependencyGraph PKC L2 依赖图（file → 直接依赖项列表，邻接表）
   * @param highRiskSymbols 高风险符号列表（来自 PKC L2 标记，用于 RiskScorer 评分）
   * @param topN Top-N 参数（默认 20，传 0 或负数按 1 处理）
   * @returns IncrementalTestSelection（已冻结）
   */
  public select(
    projectRoot: string,
    base: string,
    head: string,
    dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>>,
    highRiskSymbols: ReadonlyArray<string>,
    topN: number = DEFAULT_TOP_N
  ): IncrementalTestSelection {
    // 防御性处理：topN <= 0 时按 1 处理（至少选 1 个测试）
    const effectiveTopN: number = topN > 0 ? topN : 1;

    // ----------------------------------------------------------------------
    // 1. GitDiffAnalyzer 提取变更文件清单
    // ----------------------------------------------------------------------
    const fileChanges = this.gitDiffAnalyzer.analyze(projectRoot, base, head);
    // 提取 filePath 作为 BFS 的 sourceFiles
    const sourceFiles: string[] = fileChanges.map((change) => change.filePath);

    // ----------------------------------------------------------------------
    // 2. BlastRadiusBfs 计算受影响节点
    // ----------------------------------------------------------------------
    const blastNodes: ReadonlyArray<BlastRadiusNode> = this.blastRadiusBfs.bfs(sourceFiles, dependencyGraph);

    // 过滤出 type="test" 的节点（受影响测试）
    const testNodes: ReadonlyArray<BlastRadiusNode> = blastNodes.filter(
      (node: BlastRadiusNode) => node.type === "test"
    );

    // ----------------------------------------------------------------------
    // 3. RiskScorer 评分（对每个测试节点）
    // ----------------------------------------------------------------------
    const selectedTests: SelectedTest[] = testNodes.map((node: BlastRadiusNode): SelectedTest => {
      const { scores, totalScore } = this.riskScorer.score(node.filePath, node, highRiskSymbols);

      // 构造人类可读的选择理由（含总评分与各维度评分摘要）
      const scoresSummary: string = scores.map((s) => `${s.dimension}:${s.score.toFixed(2)}`).join(", ");
      const reason: string = `总评分 ${totalScore.toFixed(2)}（${scoresSummary}）`;

      // 构造并冻结 SelectedTest
      // affectedFiles = node.parentPaths（BFS 路径回溯得到的依赖链）
      return Object.freeze({
        testPath: node.filePath,
        totalScore,
        scores,
        affectedFiles: node.parentPaths,
        reason,
      }) as SelectedTest;
    });

    // ----------------------------------------------------------------------
    // 4. 按总评分降序排序（高分优先）
    // ----------------------------------------------------------------------
    // 使用 spread 操作符创建新数组，避免修改原数组（不可变优先）
    const sortedTests: SelectedTest[] = [...selectedTests].sort(
      (a: SelectedTest, b: SelectedTest) => b.totalScore - a.totalScore
    );

    // ----------------------------------------------------------------------
    // 5. 取 Top-N
    // ----------------------------------------------------------------------
    // 若 effectiveTopN 大于候选数，slice 返回全部候选（不报错）
    const topTests: SelectedTest[] = sortedTests.slice(0, effectiveTopN);

    // ----------------------------------------------------------------------
    // 6. 计算 coverageEstimate（估算覆盖率）
    // ----------------------------------------------------------------------
    // coverageEstimate = selectedTests / totalCandidates
    // totalCandidates=0 时 coverageEstimate=0（避免除零）
    const totalCandidates: number = testNodes.length;
    const coverageEstimate: number = totalCandidates > 0 ? topTests.length / totalCandidates : 0;

    // ----------------------------------------------------------------------
    // 7. 构造选择理由（人类可读）
    // ----------------------------------------------------------------------
    const selectionReason: string =
      `Top-${effectiveTopN} 选择（共 ${totalCandidates} 个候选测试，` +
      `选中 ${topTests.length} 个，覆盖率估算 ${(coverageEstimate * 100).toFixed(1)}%）`;

    // ----------------------------------------------------------------------
    // 8. 返回冻结的 IncrementalTestSelection
    // ----------------------------------------------------------------------
    return Object.freeze({
      selectedTests: Object.freeze(topTests),
      totalCandidates,
      selectionReason,
      coverageEstimate,
      topN: effectiveTopN,
    }) as IncrementalTestSelection;
  }
}
