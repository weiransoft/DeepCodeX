/**
 * G-3 门禁检查器实现（EAG-P2 批次 8）
 *
 * 本模块实现 `GateG3Checker` 类，对应 EAG 方案 §5.12.1 G-3 门禁：
 * "方案偏离检测（任务卡声明变更 vs 实际变更）"。
 *
 * 核心职责：
 * - 对比 context.actualChanges 中每个 FileChange 的 declaredSymbolIds 与 actualSymbolIds
 * - 统计符号级偏离数（actualSymbolIds 中存在但 declaredSymbolIds 中不存在的符号）
 * - 偏离数 ≥ G3_DEVIATION_THRESHOLD（3）时返回 blocker 级失败结果
 * - 失败时附引导消息（建议更新 plan.md 与 tasks.md 后重新评审）
 *
 * 设计依据：
 * - EAG 方案 §5.12.1 G-3 门禁（方案偏离检测）
 * - §5.12.4 A-3 任务范围锁（autonomous 强化：变更波及任务卡未声明的符号 ≥3 个即触发 HUMAN_CHECKPOINT）
 * - SEED-10 规则（方案先行——实际变更必须与声明一致）
 *
 * 偏离定义：
 * - 符号级偏离：actualSymbolIds 中存在但 declaredSymbolIds 中不存在的符号 ID
 * - 一个符号在一个文件中计 1 个偏离（去重）
 * - 跨文件累计偏离数 ≥ G3_DEVIATION_THRESHOLD（3）即触发 BLOCKER
 *
 * 不可变优先：
 * - 公开方法返回冻结对象
 *
 * @module eag/gate/gate-g3-checker
 */

import {
  G3_DEVIATION_THRESHOLD,
  type FileChange,
  type GateChecker,
  type GateContext,
  type GateResult,
} from "./gate-types";

// ============================================================================
// 常量
// ============================================================================

/**
 * G-3 门禁失败时的引导消息（建议更新 plan.md 与 tasks.md 后重新评审）
 *
 * 对齐 §5.12.1 G-3 门禁失败处置：当实际变更与任务卡声明偏离 ≥ 阈值时，
 * 应更新 plan.md 与 tasks.md 以反映真实变更范围，并重新评审方案。
 */
const G3_FAILURE_GUIDANCE: string = "建议更新 plan.md 与 tasks.md 以反映真实变更范围，并重新评审方案（A-3 任务范围锁）";

// ============================================================================
// 内部辅助函数
// ============================================================================

/**
 * 计算单个文件变更的符号级偏离数
 *
 * 偏离定义：actualSymbolIds 中存在但 declaredSymbolIds 中不存在的符号 ID。
 * 同一符号在 actual 与 declared 中均出现视为"已声明"，不计偏离。
 *
 * @param change 文件变更记录
 * @returns 偏离符号 ID 列表（actualSymbolIds 中存在但 declaredSymbolIds 中不存在的符号）
 */
function computeDeviations(change: FileChange): string[] {
  // 将 declaredSymbolIds 转为 Set 加速查询
  const declaredSet = new Set<string>(change.declaredSymbolIds);
  const deviations: string[] = [];
  // 遍历 actualSymbolIds，找出未声明的符号
  for (const symbolId of change.actualSymbolIds) {
    if (!declaredSet.has(symbolId)) {
      deviations.push(symbolId);
    }
  }
  return deviations;
}

/**
 * 格式化偏离详情为人类可读字符串
 *
 * @param deviationDetails 偏离详情列表（每项含 filePath 与偏离符号列表）
 * @returns 人类可读的偏离详情字符串
 */
function formatDeviationDetails(
  deviationDetails: ReadonlyArray<{ readonly filePath: string; readonly deviations: ReadonlyArray<string> }>
): string {
  return deviationDetails
    .map((d) => `  - ${d.filePath}：${d.deviations.length} 个偏离符号（${d.deviations.join(", ")}）`)
    .join("\n");
}

// ============================================================================
// GateG3Checker 类
// ============================================================================

/**
 * G-3 门禁检查器
 *
 * 实现 §5.12.1 G-3 门禁：方案偏离检测（任务卡声明变更 vs 实际变更）。
 *
 * 检查规则：
 * 1. 遍历 context.actualChanges，对每个 FileChange 计算符号级偏离数
 * 2. 累计所有文件的偏离数
 * 3. 累计偏离数 ≥ G3_DEVIATION_THRESHOLD（3）时返回 blocker 级失败结果
 * 4. 否则返回 passed=true（含偏离详情，便于审计）
 *
 * 特殊场景：
 * - actualChanges 为空数组时直接通过（无变更无偏离）
 * - 单个文件的偏离计入累计，不要求单文件偏离 ≥ 阈值
 *
 * 使用方式：
 *   const checker = new GateG3Checker();
 *   const result = checker.check(context);
 *   if (!result.passed) {
 *     // 触发 HUMAN_CHECKPOINT，要求更新 plan.md 与 tasks.md
 *   }
 */
export class GateG3Checker implements GateChecker {
  /** 门禁 ID（固定为 "G-3"） */
  public readonly gateId = "G-3" as const;

  /**
   * 执行 G-3 门禁检查
   *
   * 检查流程：
   * 1. 遍历 context.actualChanges，收集每个文件的偏离符号列表
   * 2. 累计所有文件的偏离总数
   * 3. 偏离总数 ≥ G3_DEVIATION_THRESHOLD 时返回失败
   * 4. 否则返回通过（含偏离详情用于审计）
   *
   * @param context 门禁上下文（含 actualChanges）
   * @returns 门禁判定结果
   */
  public check(context: GateContext): GateResult {
    const changes = context.actualChanges;

    // 特殊场景：无变更直接通过
    if (changes.length === 0) {
      return Object.freeze({
        passed: true,
        gate: "G-3",
        reason: "无实际变更，无方案偏离",
        severity: "blocker",
      }) as GateResult;
    }

    // 收集每个文件的偏离详情
    const deviationDetails: Array<{
      readonly filePath: string;
      readonly deviations: ReadonlyArray<string>;
    }> = [];
    let totalDeviations = 0;

    for (const change of changes) {
      const deviations = computeDeviations(change);
      if (deviations.length > 0) {
        deviationDetails.push(
          Object.freeze({
            filePath: change.filePath,
            deviations: Object.freeze(deviations) as ReadonlyArray<string>,
          })
        );
        totalDeviations += deviations.length;
      }
    }

    // 偏离总数 ≥ 阈值，返回 blocker 失败
    if (totalDeviations >= G3_DEVIATION_THRESHOLD) {
      const details = formatDeviationDetails(deviationDetails);
      return Object.freeze({
        passed: false,
        gate: "G-3",
        reason: `符号级偏离 ${totalDeviations} ≥ ${G3_DEVIATION_THRESHOLD}（A-3 任务范围锁触发 HUMAN_CHECKPOINT）\n偏离详情：\n${details}`,
        guidance: G3_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 偏离总数 < 阈值——通过（若有偏离，附 warning 提示）
    if (totalDeviations > 0) {
      const details = formatDeviationDetails(deviationDetails);
      return Object.freeze({
        passed: true,
        gate: "G-3",
        reason: `符号级偏离 ${totalDeviations} < ${G3_DEVIATION_THRESHOLD}（允许范围内，但建议关注以下偏离）：\n${details}`,
        severity: "warning",
      }) as GateResult;
    }

    // 无偏离——完全通过
    return Object.freeze({
      passed: true,
      gate: "G-3",
      reason: `实际变更与任务卡声明完全一致（${changes.length} 个文件均无偏离）`,
      severity: "blocker",
    }) as GateResult;
  }
}
