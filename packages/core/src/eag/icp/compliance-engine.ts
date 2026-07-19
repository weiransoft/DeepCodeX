/**
 * ComplianceEngine：合规检查编排器
 *
 * 职责：
 * - 加载指定的合规包（GMP / CFR / ALCOA）
 * - 并行执行所有规则的检查器（静态规则并行 / 动态规则串行避免资源竞争）
 * - 聚合各规则结果为 ComplianceEvidenceReport
 *
 * 设计原则（对齐 Karpathy Simplicity First 与 §5.12.4 G-A6d 不可变优先）：
 * - 无状态：engine 本身不持有运行期状态，每次 run() 调用独立
 * - 不可变优先：返回的 ComplianceEvidenceReport 通过 Object.freeze 冻结
 * - 错误隔离：单条规则失败不影响其他规则执行（catch 后记录为 passed=false）
 * - 静态优先：混合规则先执行静态检查，静态失败即短路（不执行动态检查）
 *
 * 编排算法（对齐设计文档 §6.5）：
 * 1. 加载合规包（从内置 pack 注册表查询）
 * 2. 分离静态规则与动态规则
 * 3. 静态规则并行执行（Promise.all）
 * 4. 动态规则串行执行（避免数据库 / API 并发冲突）
 * 5. 混合规则：先静态后动态（静态失败即短路）
 * 6. 聚合结果，计算 overallPassed（所有 blocker + major 规则通过）
 * 7. 生成摘要文本
 * 8. 返回 Object.freeze 冻结的 ComplianceEvidenceReport
 *
 * overallPassed 判定规则（对齐 §6.5）：
 * - 所有 severity=blocker 的规则必须通过
 * - 所有 severity=major 的规则必须通过
 * - severity=warning 的规则不通过不影响 overallPassed（仅警告）
 *
 * @module eag/icp/compliance-engine
 */

import type {
  ComplianceCheckContext,
  ComplianceEvidenceReport,
  CompliancePack,
  CompliancePackId,
  ComplianceRule,
  ComplianceRuleResult,
  ComplianceSeverity,
} from "./types";
import { COMPLIANCE_PACK_IDS } from "./types";
import { GMP_PACK } from "./packs/gmp-pack";
import { CFR_PART_11_PACK } from "./packs/cfr-part11-pack";
import { ALCOA_PLUS_PACK } from "./packs/alcoa-plus-pack";

// ============================================================================
// 1. 内部 pack 注册表
// ============================================================================

/**
 * PACK_REGISTRY：内置合规包注册表
 *
 * 将 packId 映射到具体的 CompliancePack 实例。使用 Object.freeze 冻结，
 * 防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 *
 * 注册表内容：
 * - GMP → GMP_PACK（6 条 GMP 规则）
 * - CFR → CFR_PART_11_PACK（5 条 CFR 规则）
 * - ALCOA → ALCOA_PLUS_PACK（9 条 ALCOA+ 规则）
 */
const PACK_REGISTRY: Readonly<Record<CompliancePackId, CompliancePack>> = Object.freeze({
  GMP: GMP_PACK,
  CFR: CFR_PART_11_PACK,
  ALCOA: ALCOA_PLUS_PACK,
}) as Readonly<Record<CompliancePackId, CompliancePack>>;

// ============================================================================
// 2. ComplianceEngine 类
// ============================================================================

/**
 * ComplianceEngine：合规检查编排器
 *
 * 使用方式：
 * ```typescript
 * const engine = new ComplianceEngine();
 * const context = createComplianceCheckContext({ ... });
 * const report = await engine.run("GMP", context, "run-001");
 * if (!report.overallPassed) {
 *   // 阻止 PR 合并，按报告修复
 * }
 * ```
 *
 * 设计说明：
 * - 引擎实例无状态，可被多次并发调用
 * - 引擎不持有任何运行期状态，所有状态通过参数传递
 * - 所有规则执行错误被捕获并转为 ComplianceRuleResult.passed=false，不向上抛出
 */
export class ComplianceEngine {
  /**
   * 执行合规检查
   *
   * 算法（对齐设计文档 §6.5）：
   * 1. 加载合规包（从 PACK_REGISTRY 查询）
   * 2. 分离静态规则与动态规则
   * 3. 静态规则并行执行（Promise.all）
   * 4. 动态规则串行执行（避免数据库 / API 并发冲突）
   * 5. 混合规则：先静态后动态（静态失败即短路）
   * 6. 聚合结果，计算 overallPassed
   * 7. 生成摘要文本
   * 8. 返回 Object.freeze 冻结的 ComplianceEvidenceReport
   *
   * 错误隔离：
   * - 单条规则执行抛出异常时，通过 handleRuleError 转为 passed=false 结果
   * - 不影响其他规则执行
   * - 异常信息保留在 reason 字段中便于调试
   *
   * @param packId 合规包 ID（GMP / CFR / ALCOA）
   * @param context 合规检查上下文（含 projectRoot / fileMap / testRunner 等）
   * @param runId 运行 ID（关联 RunState，便于跨 Loop 事件流溯源）
   * @returns 冻结的 ComplianceEvidenceReport
   * @throws {Error} packId 非法时抛出
   */
  async run(
    packId: CompliancePackId,
    context: ComplianceCheckContext,
    runId: string
  ): Promise<Readonly<ComplianceEvidenceReport>> {
    // 1. 加载合规包
    const pack = this.loadPack(packId);

    // 2. 分离静态规则与动态规则
    // 注：混合规则（hybrid）单独处理——先静态后动态
    const staticRules = pack.rules.filter((r) => r.checkKind === "static" && r.staticChecker);
    const dynamicRules = pack.rules.filter((r) => r.checkKind === "dynamic" && r.dynamicChecker);
    const hybridRules = pack.rules.filter((r) => r.checkKind === "hybrid" && r.staticChecker && r.dynamicChecker);

    // 3. 静态规则并行执行（Promise.all）
    // 注：静态检查器是同步函数，但通过 Promise.all 包装可实现并发
    // 错误隔离：catch 后记录为 passed=false
    const staticResults = await Promise.all(
      staticRules.map(async (rule) => {
        try {
          // 静态检查器是同步函数，直接调用
          return rule.staticChecker!(context);
        } catch (e) {
          return this.handleRuleError(rule, e);
        }
      })
    );

    // 4. 动态规则串行执行（避免数据库 / API 并发冲突）
    // 注：动态检查器是异步函数，必须串行执行避免资源竞争
    const dynamicResults: ComplianceRuleResult[] = [];
    for (const rule of dynamicRules) {
      try {
        const result = await rule.dynamicChecker!(context);
        dynamicResults.push(result);
      } catch (e) {
        dynamicResults.push(this.handleRuleError(rule, e));
      }
    }

    // 5. 混合规则：先静态后动态（静态失败即短路）
    const hybridResults: ComplianceRuleResult[] = [];
    for (const rule of hybridRules) {
      try {
        // 先执行静态检查
        const staticResult = rule.staticChecker!(context);
        if (!staticResult.passed) {
          // 静态失败即短路，不再执行动态检查
          hybridResults.push(staticResult);
          continue;
        }
        // 静态通过，继续执行动态检查
        const dynamicResult = await rule.dynamicChecker!(context);
        hybridResults.push(dynamicResult);
      } catch (e) {
        hybridResults.push(this.handleRuleError(rule, e));
      }
    }

    // 6. 聚合结果
    // 注：按 ruleId 升序排序，便于下游消费者稳定读取
    const allResults = [...staticResults, ...dynamicResults, ...hybridResults].sort((a, b) =>
      a.ruleId.localeCompare(b.ruleId)
    );

    // 计算 overallPassed（所有 blocker + major 规则通过，warning 不影响）
    const overallPassed = this.calculateOverallPassed(allResults, pack);

    // 7. 生成摘要文本
    const summary = this.generateSummary(pack, allResults);

    // 8. 返回冻结的 ComplianceEvidenceReport
    return Object.freeze({
      packId: pack.packId,
      runId,
      generatedAt: new Date().toISOString(),
      ruleResults: Object.freeze(allResults),
      overallPassed,
      summary,
    }) as ComplianceEvidenceReport;
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 加载合规包
   *
   * 从 PACK_REGISTRY 查询指定 packId 的 CompliancePack 实例。
   *
   * @param packId 合规包 ID（GMP / CFR / ALCOA）
   * @returns CompliancePack 实例
   * @throws {Error} packId 非法时抛出
   */
  private loadPack(packId: CompliancePackId): CompliancePack {
    if (!COMPLIANCE_PACK_IDS.includes(packId)) {
      throw new Error(`非法的 packId：${packId}，必须为 ${COMPLIANCE_PACK_IDS.join("/")} 之一`);
    }
    const pack = PACK_REGISTRY[packId];
    if (!pack) {
      // 理论上不会发生（COMPLIANCE_PACK_IDS 已校验），但作为防御性编程
      throw new Error(`合规包未注册：${packId}`);
    }
    return pack;
  }

  /**
   * 处理规则执行错误
   *
   * 当规则执行抛出异常时，将异常转为 ComplianceRuleResult.passed=false，
   * 异常信息保留在 reason 字段中便于调试。
   *
   * 错误隔离原则：
   * - 不向上抛出异常，避免单条规则失败影响其他规则执行
   * - 异常信息保留在 reason 字段中，便于下游消费者（如 G-7 门禁）诊断
   *
   * @param rule 触发异常的规则
   * @param error 异常对象
   * @returns 冻结的 ComplianceRuleResult（passed=false）
   */
  private handleRuleError(rule: ComplianceRule, error: unknown): ComplianceRuleResult {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      ruleId: rule.ruleId,
      passed: false,
      severity: rule.severity,
      evidence: Object.freeze([]),
      reason: `规则 ${rule.ruleId} 执行异常：${errorMessage}`,
    }) as ComplianceRuleResult;
  }

  /**
   * 获取规则严重性
   *
   * 从 CompliancePack 中查找指定 ruleId 的规则，返回其 severity。
   * 用于 overallPassed 计算时根据 ruleId 反查 severity（虽然 ComplianceRuleResult
   * 已携带 severity，但本方法保留作为兜底查询，便于规则升级后保持一致性）。
   *
   * @param ruleId 规则 ID
   * @param pack 合规包
   * @returns 严重性（找不到时默认为 blocker，作为保守策略）
   */
  private getRuleSeverity(ruleId: string, pack: CompliancePack): ComplianceSeverity {
    const rule = pack.rules.find((r) => r.ruleId === ruleId);
    return rule ? rule.severity : "blocker";
  }

  /**
   * 计算 overallPassed
   *
   * 判定规则（对齐设计文档 §6.5）：
   * - 所有 severity=blocker 的规则必须通过
   * - 所有 severity=major 的规则必须通过
   * - severity=warning 的规则不通过不影响 overallPassed
   *
   * @param results 所有规则结果列表
   * @param pack 合规包（用于查询规则严重性，作为兜底）
   * @returns 整体是否通过
   */
  private calculateOverallPassed(results: ReadonlyArray<ComplianceRuleResult>, pack: CompliancePack): boolean {
    return results.every((r) => {
      // 优先使用 result 自带的 severity，兜底从 pack 查询
      const severity = r.severity ?? this.getRuleSeverity(r.ruleId, pack);
      // warning 级规则不通过不影响 overallPassed
      if (severity === "warning") return true;
      // blocker + major 级规则必须通过
      return r.passed;
    });
  }

  /**
   * 生成摘要文本
   *
   * 摘要格式：
   *   "<packName> 合规包 <N> 条规则：<M> 通过 / <K> 失败（blocker: <通过>/<总数>, major: <通过>/<总数>, warning: <通过>/<总数>）"
   *
   * @param pack 合规包
   * @param results 所有规则结果列表
   * @returns 人类可读的摘要文本
   */
  private generateSummary(pack: CompliancePack, results: ReadonlyArray<ComplianceRuleResult>): string {
    const totalCount = results.length;
    const passedCount = results.filter((r) => r.passed).length;
    const failedCount = totalCount - passedCount;

    // 按严重性分组统计
    const blockerResults = results.filter((r) => r.severity === "blocker");
    const majorResults = results.filter((r) => r.severity === "major");
    const warningResults = results.filter((r) => r.severity === "warning");

    const blockerPassed = blockerResults.filter((r) => r.passed).length;
    const majorPassed = majorResults.filter((r) => r.passed).length;
    const warningPassed = warningResults.filter((r) => r.passed).length;

    return (
      `${pack.packName} 合规包 ${totalCount} 条规则：${passedCount} 通过 / ${failedCount} 失败` +
      `（blocker: ${blockerPassed}/${blockerResults.length}, ` +
      `major: ${majorPassed}/${majorResults.length}, ` +
      `warning: ${warningPassed}/${warningResults.length}）`
    );
  }
}

// ============================================================================
// 3. 模块导出
// ============================================================================

/**
 * PACK_REGISTRY 导出（供测试与外部消费者查询可用合规包列表）
 *
 * 注：PACK_REGISTRY 本身为 Object.freeze 冻结的只读对象，
 * 外部消费者仅可读取不可修改。
 */
export { PACK_REGISTRY };
