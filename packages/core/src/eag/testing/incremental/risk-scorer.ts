/**
 * RiskScorer：风险评分器（EAG-P3 批次 11 §8.6）
 *
 * 本模块实现 `RiskScorer` 类，对应 EAG-P3 批次 11 设计 §8.6：
 * 按 4 个评分维度对测试文件评分（架构师审查 B3-M9 修复：depth 衰减独立为单独维度），
 * 加权计算总评分，返回 RiskScore 列表 + totalScore。
 *
 * 核心职责（对齐 §8.6）：
 * 1. 按 4 个评分维度对测试文件评分：
 *    - 维度 1：direct（depth=0）或 indirect（depth>0）
 *    - 维度 2：high-risk-symbol（+0.3，影响链中含高风险符号）
 *    - 维度 3：domain-layer（+0.2，影响链中含 src/domain/ 文件）
 *    - 维度 4：depth-decay（每跳 -0.1，下限 -1.0，独立维度——架构师审查 B3-M9 + B3-M3 修复）
 * 2. 加权计算总评分（所有维度评分之和，上限 1.0，下限 0——B3-M3 修复）
 * 3. 返回 RiskScore 列表（含各维度评分明细）+ totalScore
 *
 * 评分维度与权重：
 * - direct（直接修改）：1.0 权重（depth=0 时触发）
 * - indirect（间接影响）：0.5 权重（depth>0 时触发）
 * - high-risk-symbol（高风险符号）：+0.3 权重（影响链含高风险符号）
 * - domain-layer（领域层代码）：+0.2 权重（影响链含 src/domain/）
 * - depth-decay（距离衰减）：每跳 -0.1（下限 -1.0，独立 dimension，B3-M3 修复允许负数衰减）
 *
 * 架构师审查 B3-M9 修复说明：
 * - 原设计将 depth 衰减合并到 indirect 维度（dimension="indirect"），导致 RiskScore 数组中
 *   出现两个 dimension="indirect" 的项（基础分 + 衰减分），违反联合类型设计意图
 * - 修复后：depth 衰减独立为 dimension="depth-decay"，与 indirect 基础分分开记录
 *
 * 架构师审查 B3-M3 修复说明：
 * - 原 WEIGHTS.minScore=0.1（正数）兜底导致 depth-decay 维度 score 永远为 0.1（正数），
 *   未起到"距离越远风险越低"的衰减作用（depth=1/2/5 时 score 均为 0.1）
 * - 修复后：WEIGHTS.minScore=-1.0（允许负数衰减），depth-decay 真正起到衰减作用
 *   - depth=1 → indirect(0.5) + depth-decay(-0.1) = 0.4
 *   - depth=2 → indirect(0.5) + depth-decay(-0.2) = 0.3
 *   - depth=5 → indirect(0.5) + depth-decay(-0.5) = 0.0
 * - 总评分增加下限保护 Math.max(0, ...)，避免负数衰减导致 totalScore 为负
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - score() 返回的 RiskScore 列表通过 Object.freeze 冻结
 * - 每个 RiskScore 对象本身也通过 Object.freeze 冻结
 * - WEIGHTS 常量使用 Object.freeze 冻结
 *
 * @module eag/testing/incremental/risk-scorer
 */

import type { BlastRadiusNode, RiskScore } from "./types";
import { DOMAIN_LAYER_PREFIX } from "./types";

// ============================================================================
// 常量
// ============================================================================

/**
 * 评分权重常量
 *
 * 各维度的权重值（对齐 §8.6 设计）：
 * - direct：直接修改的权重（depth=0 触发，1.0）
 * - indirect：间接影响的权重（depth>0 触发，0.5）
 * - highRiskSymbol：高风险符号加分权重（+0.3）
 * - domainLayer：领域层加分权重（+0.2）
 * - depthDecay：距离衰减系数（每跳 -0.1，负数）
 * - minScore：评分下限（depth-decay 计算结果取 max(minScore, depth*depthDecay)，
 *   架构师审查 B3-M3 修复：从 0.1 改为 -1.0，允许 depth-decay 维度产生负数衰减，
 *   实现"距离越远风险越低"的衰减效果；-1.0 为绝对下限，正常 depth≤5 时最低为 -0.5）
 * - maxTotalScore：总评分上限（1.0，所有维度评分之和上限）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
const WEIGHTS: Readonly<{
  readonly direct: number;
  readonly indirect: number;
  readonly highRiskSymbol: number;
  readonly domainLayer: number;
  readonly depthDecay: number;
  readonly minScore: number;
  readonly maxTotalScore: number;
}> = Object.freeze({
  direct: 1.0,
  indirect: 0.5,
  highRiskSymbol: 0.3,
  domainLayer: 0.2,
  depthDecay: -0.1,
  // B3-M3 修复：minScore 从 0.1 改为 -1.0，允许 depth-decay 产生负数衰减
  // 原 0.1 兜底导致 depth=1/2/5 时 score 均为 0.1，未起到衰减作用
  minScore: -1.0,
  maxTotalScore: 1.0,
});

// ============================================================================
// RiskScorer 类
// ============================================================================

/**
 * RiskScorer：风险评分器
 *
 * 实现 §8.6 设计——按 4 个维度对测试文件评分，加权计算总评分。
 *
 * 使用方式：
 * ```typescript
 * const scorer = new RiskScorer();
 * const blastRadiusNode: BlastRadiusNode = {
 *   type: "test",
 *   filePath: "tests/contract/payment.contract.test.ts",
 *   depth: 2,
 *   parentPaths: ["src/domain/Payment.ts", "src/services/PaymentService.ts"],
 * };
 * const highRiskSymbols = ["PaymentService.refund"];
 * const { scores, totalScore } = scorer.score(
 *   blastRadiusNode.filePath,
 *   blastRadiusNode,
 *   highRiskSymbols
 * );
 * ```
 *
 * 评分逻辑：
 * - direct 与 indirect 互斥（depth=0 → direct；depth>0 → indirect）
 * - high-risk-symbol 与 domain-layer 为加分项（命中即加分）
 * - depth-decay 为独立维度（depth>0 时触发，每跳 -0.1，下限 -1.0，B3-M3 修复）
 * - totalScore = 所有维度评分之和，上限 1.0，下限 0（B3-M3 修复增加下限保护）
 */
export class RiskScorer {
  /**
   * 初始化 RiskScorer
   *
   * RiskScorer 不依赖外部服务（仅消费调用方传入的 BlastRadiusNode 与 highRiskSymbols），
   * 构造函数无参数。
   */
  constructor() {
    // 无外部依赖注入
  }

  /**
   * 为单个测试文件评分
   *
   * 评分维度（对齐 §8.6 + B3-M9 修复 + B3-M3 修复）：
   * 1. direct / indirect（互斥）：
   *    - depth=0 → direct，score=1.0
   *    - depth>0 → indirect，score=0.5
   * 2. high-risk-symbol（加分项）：
   *    - 若 blastRadiusNode.parentPaths 中任一路径含 highRiskSymbols 中任一符号 → +0.3
   *    - 否则不加入 scores 列表
   * 3. domain-layer（加分项）：
   *    - 若 blastRadiusNode.parentPaths 中任一路径以 "src/domain/" 开头 → +0.2
   *    - 否则不加入 scores 列表
   * 4. depth-decay（独立维度，仅 depth>0 时触发，B3-M3 修复允许负数衰减）：
   *    - score = max(-1.0, depth * -0.1)
   *    - depth=1 → -0.1
   *    - depth=2 → -0.2
   *    - depth=3 → -0.3
   *    - depth=5 → -0.5（不再被 0.1 兜底，真正起到衰减作用）
   *    - 下限 -1.0 仅在 depth≥10 时触发（实际 depth≤5，故 -1.0 永不触发，仅作绝对防御）
   *
   * 总评分（B3-M3 修复增加下限保护）：
   * - totalScore = max(0, min(1.0, 所有维度 score 之和))
   * - 上限 1.0（maxTotalScore）
   * - 下限 0（避免 depth 较大时负数衰减导致 totalScore 为负）
   *
   * 期望效果（B3-M3 修复后，无 high-risk-symbol 与 domain-layer 加分时）：
   * - depth=1：indirect(0.5) + depth-decay(-0.1) = 0.4
   * - depth=2：indirect(0.5) + depth-decay(-0.2) = 0.3
   * - depth=3：indirect(0.5) + depth-decay(-0.3) = 0.2
   * - depth=5：indirect(0.5) + depth-decay(-0.5) = 0.0
   *
   * @param testPath 测试文件路径（仅用于日志，实际评分基于 blastRadiusNode）
   * @param blastRadiusNode BFS 节点（含 depth 与 parentPaths）
   * @param highRiskSymbols 高风险符号列表（来自 PKC L2 标记，如 "PaymentService.refund"）
   * @returns RiskScore 列表（已冻结）+ 总评分（0~1，上限 1.0，下限 0）
   */
  public score(
    testPath: string,
    blastRadiusNode: BlastRadiusNode,
    highRiskSymbols: ReadonlyArray<string>
  ): { scores: ReadonlyArray<RiskScore>; totalScore: number } {
    // 屏蔽未使用参数告警（testPath 仅用于日志/调试，实际评分基于 blastRadiusNode）
    void testPath;

    // 各维度评分明细列表
    const scores: RiskScore[] = [];

    // ----------------------------------------------------------------------
    // 维度 1：direct / indirect（互斥）
    // ----------------------------------------------------------------------
    // depth=0 → direct（测试文件直接被修改）
    // depth>0 → indirect（测试文件间接受影响）
    const isDirect: boolean = blastRadiusNode.depth === 0;
    if (isDirect) {
      scores.push(
        Object.freeze({
          dimension: "direct",
          score: WEIGHTS.direct,
          reason: "测试文件直接被修改（depth=0）",
        }) as RiskScore
      );
    } else {
      scores.push(
        Object.freeze({
          dimension: "indirect",
          score: WEIGHTS.indirect,
          reason: `受影响（距离 ${blastRadiusNode.depth} 跳）`,
        }) as RiskScore
      );
    }

    // ----------------------------------------------------------------------
    // 维度 2：high-risk-symbol（加分项，命中即加分）
    // ----------------------------------------------------------------------
    // 检查 parentPaths 中任一路径是否含 highRiskSymbols 中任一符号
    // 符号匹配规则：path.includes(symbol)
    // 例：parentPaths=["src/services/PaymentService.ts"], symbols=["PaymentService.refund"]
    //     → "src/services/PaymentService.ts".includes("PaymentService.refund")=false
    //     但 "src/services/PaymentService.ts:PaymentService.refund".includes("PaymentService.refund")=true
    // 因此调用方传入 highRiskSymbols 时应包含完整的"文件路径:符号名"格式
    const hasHighRiskSymbol: boolean = blastRadiusNode.parentPaths.some((path: string) =>
      highRiskSymbols.some((symbol: string) => path.includes(symbol))
    );
    if (hasHighRiskSymbol) {
      scores.push(
        Object.freeze({
          dimension: "high-risk-symbol",
          score: WEIGHTS.highRiskSymbol,
          reason: "受影响文件包含高风险符号",
        }) as RiskScore
      );
    }

    // ----------------------------------------------------------------------
    // 维度 3：domain-layer（加分项，命中即加分）
    // ----------------------------------------------------------------------
    // 检查 parentPaths 中任一路径是否以 "src/domain/" 开头（领域层代码）
    // 领域层是业务核心，修改领域层代码的风险高于修改 interfaces/infrastructure 层
    const hasDomainLayer: boolean = blastRadiusNode.parentPaths.some((path: string) =>
      path.startsWith(DOMAIN_LAYER_PREFIX)
    );
    if (hasDomainLayer) {
      scores.push(
        Object.freeze({
          dimension: "domain-layer",
          score: WEIGHTS.domainLayer,
          reason: "受影响文件位于领域层",
        }) as RiskScore
      );
    }

    // ----------------------------------------------------------------------
    // 维度 4：depth-decay（独立维度，仅 depth>0 时触发）
    // ----------------------------------------------------------------------
    // 架构师审查 B3-M9 修复：
    // - 原设计 dimension="indirect"，导致 RiskScore 数组中出现两个 dimension="indirect" 的项
    // - 修复后 dimension="depth-decay"，与 indirect 基础分分开记录
    //
    // 架构师审查 B3-M3 修复：
    // - 原 minScore=0.1 兜底导致 depth-decay 维度 score 永远为 0.1（正数），
    //   未起到"距离越远风险越低"的衰减作用
    // - 修复后：minScore=-1.0（允许负数衰减），depth-decay 真正起到衰减作用
    // - 评分：depth * -0.1，下限 -1.0（绝对防御，实际 depth≤5 时最低为 -0.5）
    //   - depth=1 → -0.1
    //   - depth=2 → -0.2
    //   - depth=3 → -0.3
    //   - depth=5 → -0.5（真正起到衰减作用）
    if (blastRadiusNode.depth > 0) {
      const depthDecay: number = Math.max(WEIGHTS.minScore, blastRadiusNode.depth * WEIGHTS.depthDecay);
      scores.push(
        Object.freeze({
          dimension: "depth-decay",
          score: depthDecay,
          reason: `距离衰减 ${depthDecay.toFixed(2)}（depth=${blastRadiusNode.depth}）`,
        }) as RiskScore
      );
    }

    // ----------------------------------------------------------------------
    // 总评分 = 所有维度评分之和（上限 1.0，下限 0）
    // ----------------------------------------------------------------------
    // B3-M3 修复：增加下限保护 Math.max(0, ...)
    // 原因：depth-decay 现在可产生负数（如 depth=5 → -0.5），
    //       若 indirect(0.5) + depth-decay(-0.5) = 0.0 仍合理，
    //       但若叠加多维度负数（理论不会出现，仅 depth-decay 可负），
    //       下限保护确保 totalScore ≥ 0，避免出现负数风险评分。
    const rawTotal: number = scores.reduce((sum: number, s: RiskScore) => sum + s.score, 0);
    const totalScore: number = Math.max(0, Math.min(WEIGHTS.maxTotalScore, rawTotal));

    // 返回冻结的 RiskScore 列表 + 总评分
    return {
      scores: Object.freeze(scores),
      totalScore,
    };
  }
}
