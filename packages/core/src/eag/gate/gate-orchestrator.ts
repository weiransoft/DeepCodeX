/**
 * 方案先行门禁编排器实现（EAG-P2 批次 8 + 批次 9 + EAG-P3 批次 10）
 *
 * 本模块实现 `GateOrchestrator` 类，对应 EAG 方案 §5.12.1 方案先行门禁编排逻辑：
 * 按 LoopType 决定执行哪些门禁，并按顺序编排 G-1 → G-2 → G-3 → G-4 → G-5 → G-6 → G-7。
 *
 * 核心职责：
 * - 接收 GateContext，按 context.loopType 决定门禁编排策略
 * - 对 coding Loop 依次执行 G-1 → G-2 → G-3 → G-4 → G-5（短路求值，首个失败即停止）
 * - 对 testing Loop 依次执行 G-6 → G-7（短路求值，首个失败即停止）
 * - 对 design Loop 跳过所有门禁（DESIGN Loop 是方案产出阶段，无门禁）
 * - 返回 GateOrchestrationResult，含全部门禁结果、是否全部通过、首个未通过门禁
 *
 * 设计依据：
 * - EAG 方案 §5.12.1 方案先行门禁
 * - §5.10 三 Loop 编排（design / coding / testing）
 * - §5.12.4 A-3 任务范围锁（autonomous 强化 G-3）
 * - EAG-P2 批次 9 §4.8 G-4/G-5 CODING Loop 进入与退出门禁
 * - EAG-P3 批次 10 §4.8.5 G-6/G-7 TESTING Loop 进入与退出门禁
 *
 * 编排策略表（对齐 §4.8.5）：
 * | LoopType | 启用门禁                 | 说明 |
 * |----------|--------------------------|------|
 * | design   | 跳过所有门禁              | DESIGN Loop 产出 spec.md，无门禁 |
 * | coding   | G-1 → G-2 → G-3 → G-4 → G-5 | CODING Loop 启动前依次执行 G-1~G-4，退出时执行 G-5 |
 * | testing  | G-6 → G-7                | TESTING Loop 启动前执行 G-6，退出时执行 G-7（批次 10 新增） |
 *
 * 短路求值：
 * - coding Loop 中若 G-1 失败，立即停止，不执行 G-2 / G-3 / G-4 / G-5
 * - coding Loop 中若 G-2 失败，立即停止，不执行 G-3 / G-4 / G-5
 * - 以此类推
 * - testing Loop 中若 G-6 失败，立即停止，不执行 G-7
 *
 * 向后兼容策略（对齐 §4.8.5）：
 * - 若调用方传入普通 GateContext（非 GateG6Context/GateG7Context），
 *   run() 跳过 G-6/G-7 校验（通过 duck-typing 检查扩展字段是否存在）
 * - 这保证既有调用方（如批次 8/9 的测试）传入 GateContext 时不会因 G-6/G-7 而失败
 *
 * 不可变优先：
 * - 公开方法返回冻结对象
 * - 常量 LOOP_GATE_STRATEGY / LOOP_GATE_IDS / GATE_EXECUTION_ORDER 均使用 Object.freeze 冻结
 *
 * @module eag/gate/gate-orchestrator
 */

import { GateG1Checker } from "./gate-g1-checker";
import { GateG2Checker } from "./gate-g2-checker";
import { GateG3Checker } from "./gate-g3-checker";
import { GateG6Checker } from "./gate-g6-checker";
import { GateG7Checker } from "./gate-g7-checker";
import type { GateChecker, GateContext, GateId, GateOrchestrationResult, GateResult, LoopType } from "./gate-types";

// ============================================================================
// 常量与配置
// ============================================================================

/**
 * LoopType → 是否启用门禁的映射表
 *
 * 对齐 EAG 四 Loop 编排策略：
 * - design：跳过（DESIGN Loop 是方案产出阶段，无门禁）
 * - coding：执行（CODING Loop 启动前依次执行 G-1~G-4，退出时执行 G-5）
 * - testing：执行（TESTING Loop 启动前执行 G-6，退出时执行 G-7）
 * - deploy：跳过 GateOrchestrator 编排（DEPLOY Loop 的 G-8 门禁由 DevOpsOrchestrator 独立调用，
 *   不通过 GateOrchestrator.run() 编排，因为 G-8 需要 IaC 模板 + 部署结果 + 健康检查 + 烟雾测试
 *   等运行期数据，与 G-1~G-7 的静态文档门禁模型不同）
 *
 * 注意：批次 10 将 testing 从 false 改为 true（启用 TESTING Loop 门禁）。
 * 注意：批次 13 新增 deploy 键，固定为 false（G-8 由 DevOpsOrchestrator 独立调用）。
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 */
const LOOP_GATE_STRATEGY: Readonly<Record<LoopType, boolean>> = Object.freeze({
  design: false, // false=跳过门禁
  coding: true, // true=执行门禁
  testing: true, // true=执行门禁（批次 10 修改：从 false 改为 true）
  deploy: false, // false=跳过 GateOrchestrator 编排（批次 13 新增：G-8 由 DevOpsOrchestrator 独立调用）
});

/**
 * LoopType → 启用的 GateId 列表（按执行顺序）
 *
 * 用于 run() 根据 loopType 过滤要执行的 checkers：
 * - design：[] → 跳过所有门禁
 * - coding：["G-1", "G-2", "G-3", "G-4", "G-5"] → CODING Loop 进入与退出门禁
 * - testing：["G-6", "G-7"] → TESTING Loop 进入与退出门禁
 * - deploy：[] → 跳过 GateOrchestrator 编排（G-8 由 DevOpsOrchestrator 独立调用）
 *
 * 设计依据：§4.8.5 明确"testing：执行 G-6（进入） + G-7（退出）"，
 * 即 testing Loop 只执行 G-6/G-7，不执行 G-1~G-5。
 *
 * 设计依据：批次 13 §3.6 明确 G-8 由 DevOpsOrchestrator 在部署完成后独立调用，
 * 不通过 GateOrchestrator.run() 编排，因此 deploy Loop 的 GateId 列表为空。
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改。
 */
const LOOP_GATE_IDS: Readonly<Record<LoopType, ReadonlyArray<GateId>>> = Object.freeze({
  design: Object.freeze([] as GateId[]),
  coding: Object.freeze(["G-1", "G-2", "G-3", "G-4", "G-5"] as GateId[]),
  testing: Object.freeze(["G-6", "G-7"] as GateId[]),
  deploy: Object.freeze([] as GateId[]), // 批次 13 新增：G-8 由 DevOpsOrchestrator 独立调用
});

/**
 * 门禁检查器执行顺序（按 G-1 → G-2 → G-3 → G-4 → G-5 → G-6 → G-7 → G-8 顺序）
 *
 * 包含全部 8 道门禁的合法 ID，用于：
 * - 构造时校验自定义检查器的 gateId 是否合法
 * - 文档化门禁执行顺序
 *
 * 实际执行时，run() 会根据 LOOP_GATE_IDS[loopType] 过滤要执行的 checkers，
 * 此处仅用于协议校验。
 *
 * 注意：G-8 不通过 GateOrchestrator.run() 编排（由 DevOpsOrchestrator 独立调用），
 * 但仍纳入 GATE_EXECUTION_ORDER 用于协议校验与文档化。
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改顺序。
 */
const GATE_EXECUTION_ORDER: ReadonlyArray<GateId> = Object.freeze([
  "G-1",
  "G-2",
  "G-3",
  "G-4",
  "G-5",
  "G-6",
  "G-7",
  "G-8",
]);

// ============================================================================
// 异常类型
// ============================================================================

/**
 * 门禁编排错误
 *
 * 当 GateContext 非法或门禁检查器协议违反时抛出。
 */
export class GateOrchestratorError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-loop-type：loopType 非法
   *   - checker-protocol-violation：检查器协议违反（gateId 不匹配等）
   * @param detail 错误详情
   */
  constructor(
    public readonly kind: "invalid-loop-type" | "checker-protocol-violation",
    public readonly detail: string
  ) {
    super(`门禁编排错误 [${kind}]：${detail}`);
    this.name = "GateOrchestratorError";
  }
}

// ============================================================================
// GateOrchestrator 类
// ============================================================================

/**
 * 方案先行门禁编排器
 *
 * 实现 §5.12.1 方案先行门禁的编排逻辑：按 LoopType 决定执行哪些门禁，
 * 并按 G-1 → G-2 → G-3 → G-4 → G-5 → G-6 → G-7 顺序编排（短路求值，首个失败即停止）。
 *
 * 使用方式：
 *   const orchestrator = new GateOrchestrator();
 *   const result = orchestrator.run(context);
 *   if (!result.allPassed) {
 *     // 阻止进入对应 Loop，按 firstFailedGate 引导用户处置
 *   }
 *
 * 自定义检查器：
 *   const orchestrator = new GateOrchestrator({
 *     checkers: [new GateG1Checker(), new GateG2Checker(), new GateG3Checker()],
 *   });
 *   // 测试场景可注入自定义检查器（如 InMemoryGateChecker）
 *
 * 向后兼容（批次 10 新增）：
 *   - 若调用方传入普通 GateContext（非 GateG6Context/GateG7Context），
 *     run() 跳过 G-6/G-7 校验（通过 duck-typing 检查扩展字段是否存在）
 *   - 这保证既有调用方传入 GateContext 时不会因 G-6/G-7 而失败
 */
export class GateOrchestrator {
  /** 门禁检查器列表（按注入顺序保留，run() 时按 LOOP_GATE_IDS 过滤） */
  private readonly checkers: ReadonlyArray<GateChecker>;

  /**
   * @param options 编排器配置选项
   *   - checkers：自定义门禁检查器列表（缺省时使用默认 G-1/G-2/G-3/G-6/G-7 检查器）
   * @throws {GateOrchestratorError} 当传入的自定义检查器协议违反时（gateId 不在 GATE_EXECUTION_ORDER 中）抛出。
   *   协议校验在构造时一次性完成，避免每次 run() 都重复校验浪费性能。
   */
  constructor(options?: { readonly checkers?: ReadonlyArray<GateChecker> }) {
    // 缺省时使用默认检查器列表：
    // - G-1/G-2/G-3：CODING Loop 进入门禁（批次 8）
    // - G-6/G-7：TESTING Loop 进入与退出门禁（批次 10 新增）
    // 注：G-4/G-5 不在默认列表中，需调用方按需注入（与批次 9 设计一致）
    const checkers =
      options?.checkers ??
      Object.freeze([
        new GateG1Checker(),
        new GateG2Checker(),
        new GateG3Checker(),
        new GateG6Checker(),
        new GateG7Checker(),
      ]);

    // 协议校验：构造时一次性校验所有检查器的 gateId 必须在 GATE_EXECUTION_ORDER 中
    // 对齐性能优化原则——避免每次 run() 都重复校验所有检查器
    for (const checker of checkers) {
      if (!GATE_EXECUTION_ORDER.includes(checker.gateId)) {
        throw new GateOrchestratorError(
          "checker-protocol-violation",
          `检查器 gateId="${checker.gateId}" 不在合法门禁 ID 列表中（合法值：${GATE_EXECUTION_ORDER.join("/")})`
        );
      }
    }

    this.checkers = checkers;
  }

  /**
   * 执行门禁编排
   *
   * 编排逻辑：
   * 1. 校验 context.loopType 合法性
   * 2. 若 LOOP_GATE_STRATEGY[loopType] 为 false（跳过门禁），返回空结果
   * 3. 若为 true（执行门禁），按 LOOP_GATE_IDS[loopType] 过滤要执行的 checkers
   * 4. 对 G-6/G-7 checker，检查 context 是否含扩展字段（向后兼容）：
   *    - G-6：检查 context.g5Passed 是否为 boolean（GateG6Context 扩展字段）
   *    - G-7：检查 context.coverageReport 是否存在（GateG7Context 扩展字段）
   *    - 若无扩展字段 → 跳过该 checker（不计入 results）
   * 5. 短路求值：首个失败即停止，不执行后续门禁
   * 6. 收集所有结果，计算 allPassed 与 firstFailedGate
   *
   * 注：检查器协议校验已移至 constructor，run() 仅校验 context.loopType 合法性
   *
   * @param context 门禁上下文
   * @returns 门禁编排结果
   * @throws {GateOrchestratorError} loopType 非法时抛出
   */
  public run(context: GateContext): GateOrchestrationResult {
    // 校验 loopType 合法性
    const loopType = context.loopType;
    if (!(loopType in LOOP_GATE_STRATEGY)) {
      throw new GateOrchestratorError(
        "invalid-loop-type",
        `context.loopType="${loopType}" 不合法，合法值为 design/coding/testing`
      );
    }

    // 若 LoopType 跳过门禁，返回空结果
    if (!LOOP_GATE_STRATEGY[loopType]) {
      return Object.freeze({
        results: Object.freeze([]) as ReadonlyArray<GateResult>,
        allPassed: true,
        firstFailedGate: null,
        loopType,
      }) as GateOrchestrationResult;
    }

    // 获取当前 LoopType 启用的 GateId 列表（按执行顺序）
    const enabledGateIds = LOOP_GATE_IDS[loopType];

    // 按顺序执行门禁检查器（短路求值）
    // 仅执行 gateId 在 enabledGateIds 中的 checkers
    const results: GateResult[] = [];
    let firstFailedGate: GateId | null = null;

    for (const checker of this.checkers) {
      // 过滤：仅执行当前 LoopType 启用的门禁
      if (!enabledGateIds.includes(checker.gateId)) {
        continue;
      }

      // 向后兼容：对 G-6/G-7 checker，检查 context 是否含扩展字段
      // 若调用方传入普通 GateContext（非 GateG6Context/GateG7Context），
      // 跳过 G-6/G-7 校验，保证既有调用方不受影响
      if (!isGateG6Context(context) && checker.gateId === "G-6") {
        continue;
      }
      if (!isGateG7Context(context) && checker.gateId === "G-7") {
        continue;
      }

      const result = checker.check(context);
      results.push(result);
      // 短路求值：首个失败即停止
      if (!result.passed && firstFailedGate === null) {
        firstFailedGate = result.gate;
        break;
      }
    }

    // 计算是否全部通过
    const allPassed = firstFailedGate === null;

    return Object.freeze({
      results: Object.freeze(results) as ReadonlyArray<GateResult>,
      allPassed,
      firstFailedGate,
      loopType,
    }) as GateOrchestrationResult;
  }

  /**
   * 获取编排器配置的门禁检查器列表（用于审计与测试断言）
   *
   * @returns 检查器列表的只读副本
   */
  public getCheckers(): ReadonlyArray<GateChecker> {
    return this.checkers;
  }
}

// ============================================================================
// 向后兼容辅助函数：duck-typing 检查扩展字段
// ============================================================================

/**
 * 判断 context 是否为 GateG6Context（duck-typing 检查 g5Passed 字段）
 *
 * 向后兼容策略：若调用方传入普通 GateContext（不含 G-6 扩展字段），
 * run() 跳过 G-6 校验，避免既有调用方因新增门禁而失败。
 *
 * 判定依据：GateG6Context 扩展了 g5Passed: boolean 字段，
 * 通过检查 context 是否含 boolean 类型的 g5Passed 字段来判定。
 *
 * @param context 门禁上下文
 * @returns true 表示 context 是 GateG6Context（含扩展字段），false 表示普通 GateContext
 */
function isGateG6Context(context: GateContext): boolean {
  // 使用类型断言访问扩展字段（运行时 duck-typing）
  const g6 = context as Partial<Pick<import("./gate-types").GateG6Context, "g5Passed">>;
  return typeof g6.g5Passed === "boolean";
}

/**
 * 判断 context 是否为 GateG7Context（duck-typing 检查 coverageReport 字段）
 *
 * 向后兼容策略：若调用方传入普通 GateContext（不含 G-7 扩展字段），
 * run() 跳过 G-7 校验，避免既有调用方因新增门禁而失败。
 *
 * 判定依据：GateG7Context 扩展了 coverageReport: Readonly<CoverageReport> 字段，
 * 通过检查 context 是否含非空 coverageReport 对象来判定。
 *
 * @param context 门禁上下文
 * @returns true 表示 context 是 GateG7Context（含扩展字段），false 表示普通 GateContext
 */
function isGateG7Context(context: GateContext): boolean {
  // 使用类型断言访问扩展字段（运行时 duck-typing）
  const g7 = context as Partial<Pick<import("./gate-types").GateG7Context, "coverageReport">>;
  return (
    g7.coverageReport !== null && typeof g7.coverageReport === "object" && typeof g7.coverageReport.passed === "boolean"
  );
}
