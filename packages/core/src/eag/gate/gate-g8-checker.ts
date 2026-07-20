/**
 * G-8 门禁检查器实现（EAG-P4 批次 13 Phase 2）
 *
 * 本模块实现 `GateG8CheckerImpl` 类，对应 EAG-P4 批次 13 设计文档 §3.6 D1-3 GateG8Checker 部署门禁：
 * "G-8 部署就绪门禁——校验 IaC 模板 + 健康检查 + 烟雾测试 + 监控告警 + 回滚预案 5 项条件"。
 *
 * 核心职责：
 * - 校验部署就绪状态，确保部署产物满足生产环境要求
 * - 与 G-1~G-7 同构（遵循 GateChecker 协议，gateId + check() 方法）
 * - 任一未通过时返回 blocker 级失败结果，并附引导消息（逐项修复后重新触发部署）
 *
 * 校验 5 项（对齐设计文档 §3.6 L2591-L2595）：
 * - G-8-1: IaC 模板完整性（模板数量 > 0 且全部校验通过）
 * - G-8-2: 健康检查就绪（healthCheckResult.healthy = true）
 * - G-8-3: 烟雾测试通过（smokeTestResult.passed = true）
 * - G-8-4: 监控告警就位（monitoringReady = true，批次 13 暂固定为 true，批次 14 实现 Prometheus scrape 校验）
 * - G-8-5: 回滚预案存在（rollbackPlanExists = true，批次 13 暂固定为 true，批次 14 实现 RollbackPlan 文件存在性校验）
 *
 * 设计依据：
 * - EAG-P4 批次 13 设计文档 §3.6 D1-3 GateG8Checker 部署门禁
 * - EAG 方案 §5.12.1 门禁体系（G-1~G-7 既有 7 道门禁 + G-8 新增部署门禁）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结原则（不可变优先，返回值 Object.freeze）
 * - 架构师审查 P2-1 修复 v1.4：实现类命名为 GateG8CheckerImpl 以避免与接口 GateG8Checker 声明合并
 *
 * 与 DevOpsOrchestrator 的关系（§3.6 + §3.4）：
 * - G-8 门禁不通过 GateOrchestrator.run() 编排（因 G-8 需要 IaC 模板 + 部署结果 +
 *   健康检查 + 烟雾测试等运行期数据，与 G-1~G-7 的静态文档门禁模型不同）
 * - G-8 由 DevOpsOrchestrator 在部署完成后独立调用：
 *     const g8Result = gateG8Checker.check(devOpsContext as GateG8Context);
 *     if (!g8Result.passed) { // 阻止 devops-completed 事件发射，触发回滚
 *
 * 不可变优先：
 * - 公开方法 check() 返回 Object.freeze 冻结的 GateResult
 * - 类字段 gateId 使用 readonly 修饰
 *
 * @module eag/gate/gate-g8-checker
 */

import type { GateG8Checker, GateG8Context } from "../devops/types";
import type { GateResult } from "./gate-types";

// ============================================================================
// 常量
// ============================================================================

/**
 * G-8 门禁失败时的引导消息（建议逐项修复后重新触发部署）
 *
 * 对齐设计文档 §3.6 L2649：失败时引导用户根据 failures 列表逐项修复，
 * 修复后重新触发部署（而非直接回滚——回滚由 DeployStage 在 4 步阶段失败时触发）。
 */
const G8_FAILURE_GUIDANCE: string = "请根据 failures 列表逐项修复，修复后重新触发部署";

/**
 * G-8 门禁通过时的引导消息（部署就绪，可进入生产环境）
 *
 * 对齐设计文档 §3.6 L2648：通过时表示部署就绪，可进入生产环境。
 */
const G8_SUCCESS_GUIDANCE: string = "部署就绪，可进入生产环境";

// ============================================================================
// GateG8CheckerImpl 类
// ============================================================================

/**
 * G-8 门禁检查器实现类
 *
 * 实现 §3.6 D1-3 GateG8Checker 部署门禁：校验部署就绪状态 5 项条件。
 *
 * 命名说明（架构师审查 P2-1 修复 v1.4）：
 * - 接口名：GateG8Checker（定义在 devops/types.ts）
 * - 实现类名：GateG8CheckerImpl（本文件）
 * - 命名分离原则：TypeScript 虽允许类与接口同名（会产生声明合并），但不推荐使用，
 *   推荐接口与实现类不同名以避免混淆
 *
 * 检查规则（对齐设计文档 §3.6 L2591-L2595）：
 * 1. G-8-1: IaC 模板完整性——iacTemplates 数组非空（length > 0）
 * 2. G-8-2: 健康检查就绪——healthCheckResult.healthy = true
 * 3. G-8-3: 烟雾测试通过——smokeTestResult.passed = true
 * 4. G-8-4: 监控告警就位——monitoringReady = true（批次 13 暂固定为 true，批次 14 实现）
 * 5. G-8-5: 回滚预案存在——rollbackPlanExists = true（批次 13 暂固定为 true，批次 14 实现）
 *
 * 检查方式（与 G-1~G-7 的差异）：
 * - G-1~G-7：短路求值，首个失败即返回
 * - G-8：收集全部失败项，一次性返回完整 failures 列表（便于用户一次性修复所有问题，
 *   避免多次往返触发部署）
 *
 * 使用方式：
 *   const checker = new GateG8CheckerImpl();
 *   const result = checker.check(gateG8Context);
 *   if (!result.passed) {
 *     // 阻止 devops-completed 事件发射，触发回滚或提示用户修复
 *     // result.reason 含全部 failures 的分号分隔列表
 *   }
 */
export class GateG8CheckerImpl implements GateG8Checker {
  /**
   * 门禁 ID（固定为 "G-8"）
   *
   * 使用 readonly + as const 确保运行期不可修改且类型收窄为字面量 "G-8"
   * （对齐 GateG8Checker 接口的 gateId: "G-8" 字段类型）
   */
  public readonly gateId = "G-8" as const;

  /**
   * 执行 G-8 门禁检查
   *
   * 检查顺序（收集全部失败项，非短路求值）：
   * 1. G-8-1: IaC 模板完整性——iacTemplates 数组非空
   * 2. G-8-2: 健康检查就绪——healthCheckResult.healthy = true
   * 3. G-8-3: 烟雾测试通过——smokeTestResult.passed = true
   * 4. G-8-4: 监控告警就位——monitoringReady = true
   * 5. G-8-5: 回滚预案存在——rollbackPlanExists = true
   *
   * 非短路求值理由：
   * - 部署门禁失败后，用户希望一次性看到所有未通过项，便于批量修复
   * - 避免多次往返触发部署（每次部署都有成本，特别是 blue-green / canary 策略）
   * - 与 G-1~G-7 的短路求值不同（G-1~G-7 是进入 Loop 前的静态门禁，失败后回退到
   *   上游 Loop；G-8 是部署后的运行期门禁，失败后需要修复并重新部署）
   *
   * @param context G-8 门禁上下文（含 iacTemplates / deployResult / healthCheckResult /
   *                smokeTestResult / monitoringReady / rollbackPlanExists）
   * @returns 门禁判定结果（passed=true 表示通过，false 表示未通过，含完整 failures 列表）
   */
  public check(context: GateG8Context): GateResult {
    // 收集全部失败项（非短路求值，便于用户一次性修复）
    const failures: string[] = [];

    // G-8-1: IaC 模板完整性——模板数量必须 > 0
    // 防御性检查：虽然 TypeScript 类型系统保证 iacTemplates 为 ReadonlyArray<IaCTemplate>，
    // 但运行期可能通过类型断言绕过（如 `as GateG8Context`），因此保留空值检查
    if (!context.iacTemplates || context.iacTemplates.length === 0) {
      failures.push("G-8-1: IaC 模板为空（至少需要 1 个 IaC 模板）");
    }

    // G-8-2: 健康检查就绪——healthCheckResult.healthy 必须为 true
    // 防御性检查：同上，保留空值检查
    if (!context.healthCheckResult || !context.healthCheckResult.healthy) {
      failures.push("G-8-2: 健康检查未就绪（healthCheckResult.healthy != true）");
    }

    // G-8-3: 烟雾测试通过——smokeTestResult.passed 必须为 true
    // 防御性检查：同上，保留空值检查
    if (!context.smokeTestResult || !context.smokeTestResult.passed) {
      failures.push("G-8-3: 烟雾测试未通过（smokeTestResult.passed != true）");
    }

    // G-8-4: 监控告警就位——monitoringReady 必须为 true
    // 批次 13 暂固定为 true（设计文档 §3.6 L2594 + 风险登记 R-P4-9）：
    // 批次 13 不实现 Prometheus scrape 配置校验，由 DevOpsOrchestrator 构造上下文时固定为 true；
    // 批次 14 实现 Prometheus scrape 配置校验 + Alertmanager 规则存在性校验
    if (!context.monitoringReady) {
      failures.push("G-8-4: 监控告警未就位（monitoringReady != true）");
    }

    // G-8-5: 回滚预案存在——rollbackPlanExists 必须为 true
    // 批次 13 暂固定为 true（设计文档 §3.6 L2595 + 风险登记 R-P4-9）：
    // 批次 13 不实现 RollbackPlan 文件存在性校验，由 DevOpsOrchestrator 构造上下文时固定为 true；
    // 批次 14 实现 RollbackPlan 文件存在性校验（由 K8sRollbackManager / HelmRollbackManager 生成）
    if (!context.rollbackPlanExists) {
      failures.push("G-8-5: 回滚预案不存在（rollbackPlanExists != true）");
    }

    // 计算是否全部通过
    const passed = failures.length === 0;

    // 构造门禁判定结果（对齐设计文档 §3.6 L2641-L2652）
    const result: GateResult = {
      gate: "G-8",
      passed,
      reason: passed
        ? "G-8 部署门禁通过：IaC 完整 + 健康就绪 + 烟雾通过 + 监控就位 + 回滚预案存在"
        : `G-8 部署门禁未通过：${failures.join("; ")}`,
      guidance: passed ? G8_SUCCESS_GUIDANCE : G8_FAILURE_GUIDANCE,
      // M-6 修复（对齐设计文档 §3.6 L2650-L2651）：
      // 与既有 G-1~G-7 同构，门禁本身为 blocker 级别（通过时不降级为 warning）
      severity: "blocker",
    };

    // 不可变优先：返回冻结对象（对齐 §5.12.4 G-A6d）
    return Object.freeze(result) as GateResult;
  }
}
