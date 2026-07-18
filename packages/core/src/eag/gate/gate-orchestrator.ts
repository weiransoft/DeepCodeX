/**
 * 方案先行门禁编排器实现（EAG-P2 批次 8）
 *
 * 本模块实现 `GateOrchestrator` 类，对应 EAG 方案 §5.12.1 方案先行门禁编排逻辑：
 * 按 LoopType 决定执行哪些门禁，并按顺序编排 G-1 → G-2 → G-3。
 *
 * 核心职责：
 * - 接收 GateContext，按 context.loopType 决定门禁编排策略
 * - 对 coding Loop 依次执行 G-1 → G-2 → G-3（短路求值，首个失败即停止）
 * - 对 design / testing Loop 跳过所有门禁（DESIGN Loop 是方案产出阶段，TESTING Loop 验证已实施代码）
 * - 返回 GateOrchestrationResult，含全部门禁结果、是否全部通过、首个未通过门禁
 *
 * 设计依据：
 * - EAG 方案 §5.12.1 方案先行门禁
 * - §5.10 三 Loop 编排（design / coding / testing）
 * - §5.12.4 A-3 任务范围锁（autonomous 强化 G-3）
 *
 * 编排策略表：
 * | LoopType | G-1 | G-2 | G-3 | 说明 |
 * |----------|-----|-----|-----|------|
 * | design   | 跳过 | 跳过 | 跳过 | DESIGN Loop 产出 spec.md，无门禁 |
 * | coding   | 执行 | 执行 | 执行 | CODING Loop 启动前依次执行 G-1→G-2→G-3 |
 * | testing  | 跳过 | 跳过 | 跳过 | TESTING Loop 验证已实施代码，无方案门禁 |
 *
 * 短路求值：
 * - coding Loop 中若 G-1 失败，立即停止，不执行 G-2 / G-3
 * - coding Loop 中若 G-2 失败，立即停止，不执行 G-3
 * - coding Loop 中 G-1 与 G-2 均通过后执行 G-3
 *
 * 不可变优先：
 * - 公开方法返回冻结对象
 *
 * @module eag/gate/gate-orchestrator
 */

import { GateG1Checker } from "./gate-g1-checker";
import { GateG2Checker } from "./gate-g2-checker";
import { GateG3Checker } from "./gate-g3-checker";
import type { GateChecker, GateContext, GateId, GateOrchestrationResult, GateResult, LoopType } from "./gate-types";

// ============================================================================
// 常量与配置
// ============================================================================

/**
 * LoopType → 是否跳过门禁的映射表
 *
 * 对齐 EAG 三 Loop 编排策略：
 * - design：跳过（DESIGN Loop 是方案产出阶段，无门禁）
 * - coding：执行（CODING Loop 启动前依次执行 G-1→G-2→G-3）
 * - testing：跳过（TESTING Loop 验证已实施代码，无方案门禁）
 */
const LOOP_GATE_STRATEGY: Readonly<Record<LoopType, boolean>> = Object.freeze({
  design: false, // false=跳过门禁
  coding: true, // true=执行门禁
  testing: false, // false=跳过门禁
});

/**
 * 门禁检查器执行顺序（按 G-1 → G-2 → G-3 顺序）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改顺序。
 */
const GATE_EXECUTION_ORDER: ReadonlyArray<GateId> = Object.freeze(["G-1", "G-2", "G-3"]);

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
 * 并按 G-1 → G-2 → G-3 顺序编排（短路求值，首个失败即停止）。
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
 */
export class GateOrchestrator {
  /** 门禁检查器列表（按 G-1 → G-2 → G-3 顺序） */
  private readonly checkers: ReadonlyArray<GateChecker>;

  /**
   * @param options 编排器配置选项
   *   - checkers：自定义门禁检查器列表（缺省时使用默认 G-1/G-2/G-3 检查器）
   * @throws {GateOrchestratorError} 当传入的自定义检查器协议违反时（gateId 不在 GATE_EXECUTION_ORDER 中）抛出。
   *   协议校验在构造时一次性完成，避免每次 run() 都重复校验浪费性能。
   */
  constructor(options?: { readonly checkers?: ReadonlyArray<GateChecker> }) {
    // 缺省时使用默认 G-1/G-2/G-3 检查器
    const checkers =
      options?.checkers ?? Object.freeze([new GateG1Checker(), new GateG2Checker(), new GateG3Checker()]);

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
   * 3. 若为 true（执行门禁），按 GATE_EXECUTION_ORDER 依次执行检查器
   * 4. 短路求值：首个失败即停止，不执行后续门禁
   * 5. 收集所有结果，计算 allPassed 与 firstFailedGate
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

    // 按顺序执行门禁检查器（短路求值）
    const results: GateResult[] = [];
    let firstFailedGate: GateId | null = null;

    for (const checker of this.checkers) {
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
