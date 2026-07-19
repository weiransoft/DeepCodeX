/**
 * G-6 TESTING Loop 进入门禁检查器（EAG-P3 批次 10 §4.8.2）
 *
 * 本模块实现 `GateG6Checker` 类，对应 EAG-P3 批次 10 设计 §4.8.2 G-6 门禁：
 * "TESTING Loop 进入门禁——CODING Loop 已退出（G-5 通过）+ 单测全过 + spec.md 已批准 + 实现根目录非空"。
 *
 * 核心职责（对齐 §4.8.2）：
 * G-6 校验 TESTING Loop 启动前的 4 个前置条件：
 * 1. g5Passed === true（CODING Loop 退出门禁 G-5 已通过证据）
 * 2. unitTestsPassed === true（npm test 退出码 0，单测全过）
 * 3. specStatus === "approved"（spec.md 文档状态机已批准）
 * 4. implementationRoot 非空字符串（CODING Loop 产出目录，用于 TESTING Loop 读取被测代码）
 *
 * 任一失败 → 返回 passed=false, severity=blocker，并附引导消息"修复后重试"
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计 §4.8.1 设计依据（G-6/G-7 同构外推 G-4/G-5）
 * - EAG-P3 批次 10 设计 §4.8.2 G-6 门禁判定规则
 * - EAG-P3 批次 10 设计 §4.8.4 GateG6Context 扩展字段
 * - EAG 方案 §5.10.5 三 Loop 时序（TESTING Loop 在 CODING Loop 退出后启动）
 *
 * 与 testing-orchestrator.ts 中内联 checkGateG6 的关系：
 * - 设计文档明确允许"独立类 + 内联实现共存"（§4.8.1）
 * - 本类为 P3 批次 10 抽取的独立实现，供 GateOrchestrator 统一编排
 * - testing-orchestrator.ts 中的内联 checkGateG6 作为兜底保留（已通过 259 个测试）
 * - 两者判定规则完全对齐，差异仅在结果结构（GateResult vs GateG6Result）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 公开方法返回冻结对象（Object.freeze）
 * - check() 返回的 GateResult 通过 Object.freeze 冻结
 * - 类字段使用 readonly 修饰
 *
 * @module eag/gate/gate-g6-checker
 */

import type { GateChecker, GateContext, GateResult, GateG6Context } from "./gate-types";

// ============================================================================
// 常量
// ============================================================================

/**
 * G-6 门禁失败时的引导消息（建议修复未通过项后重试）
 *
 * 对齐 §4.8.2 G-6 门禁失败处置：当任一前置条件不满足时，TESTING Loop 不得启动，
 * 应回退修复 CODING Loop 退出门禁（G-5）/ 单测失败 / spec.md 未批准 / 实现目录缺失等问题。
 */
const G6_FAILURE_GUIDANCE: string =
  "建议修复未通过项（G-5 未通过 / 单测失败 / spec.md 未批准 / implementationRoot 为空）后重试 G-6 门禁";

// ============================================================================
// GateG6Checker 类
// ============================================================================

/**
 * G-6 门禁检查器
 *
 * 实现 §4.8.2 G-6 门禁：TESTING Loop 进入门禁。
 *
 * 检查规则（对齐 §4.8.2 判定规则，多重失败一次性收集到 failures 列表）：
 * 1. context.g5Passed === true
 * 2. context.unitTestsPassed === true
 * 3. context.specStatus === "approved"
 * 4. context.implementationRoot 为非空字符串（trim 后长度 > 0）
 *
 * 任一失败 → 返回 passed=false, severity=blocker
 * 全部通过 → 返回 passed=true, severity=blocker
 *
 * 使用方式：
 * ```typescript
 * const checker = new GateG6Checker();
 * const result = checker.check(g6Context);
 * if (!result.passed) {
 *   // 阻止进入 TESTING Loop，按 guidance 修复后重试
 * }
 * ```
 *
 * 注：G-6 上下文（GateG6Context）继承自 GateContext，扩展了
 * g5Passed / unitTestsPassed / implementationRoot 字段。
 * 调用方在装配 GateG6Context 时应确保所有字段已填充。
 */
export class GateG6Checker implements GateChecker {
  /** 门禁 ID（固定为 "G-6"） */
  public readonly gateId = "G-6" as const;

  /**
   * 初始化 G-6 门禁检查器
   *
   * G-6 不依赖外部服务（覆盖率门禁由 G-7 校验，G-6 仅做前置条件检查），
   * 因此构造函数无参数。
   */
  constructor() {
    // 无外部依赖注入
  }

  /**
   * 执行 G-6 门禁检查
   *
   * 检查顺序（多重失败一次性收集，便于调用方一次性看到全部未通过项）：
   * 1. g5Passed === true
   * 2. unitTestsPassed === true
   * 3. specStatus === "approved"
   * 4. implementationRoot 非空字符串
   *
   * 与 G-1~G-5 短路求值不同，G-6 采用"一次性收集全部失败"策略：
   * - 优势：调用方一次看到全部未通过项，避免逐项修复-重试循环
   * - 设计依据：G-6 是 TESTING Loop 进入门禁，前置条件较多（4 项），
   *   一次性展示全部失败更高效
   *
   * @param context 门禁上下文（GateG6Context，含 G-6 扩展字段）
   * @returns 门禁判定结果（passed=true 表示通过，false 表示未通过，含全部失败原因）
   */
  public check(context: GateContext): GateResult {
    // G-6 上下文需为 GateG6Context（含扩展字段）
    // 由于 GateChecker 协议定义 check(context: GateContext)，此处需类型断言
    const g6Context = context as GateG6Context;

    // 多重失败一次性收集到 failures 列表
    const failures: string[] = [];

    // 检查 1：g5Passed === true（CODING Loop 退出门禁 G-5 已通过证据）
    if (g6Context.g5Passed !== true) {
      failures.push("G-5 门禁未通过（CODING Loop 未退出，TESTING Loop 不得启动）");
    }

    // 检查 2：unitTestsPassed === true（npm test 退出码 0，单测全过）
    if (g6Context.unitTestsPassed !== true) {
      failures.push("单元测试未全过（npm test 退出码非 0，需修复失败用例后方可进入 TESTING Loop）");
    }

    // 检查 3：specStatus === "approved"（spec.md 文档状态机已批准）
    if (g6Context.specStatus !== "approved") {
      failures.push(`spec.md 文档状态非 approved（当前：${g6Context.specStatus}，TESTING Loop 要求 spec.md 已批准）`);
    }

    // 检查 4：implementationRoot 非空字符串（CODING Loop 产出目录）
    if (typeof g6Context.implementationRoot !== "string" || g6Context.implementationRoot.trim().length === 0) {
      failures.push("implementationRoot 为空或非字符串（CODING Loop 产出目录必填，TESTING Loop 据此读取被测代码）");
    }

    // 任一失败 → 返回 passed=false, severity=blocker
    if (failures.length > 0) {
      return Object.freeze({
        passed: false,
        gate: "G-6",
        reason: `G-6 门禁未通过，共 ${failures.length} 项失败：${failures.join("；")}`,
        guidance: G6_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 全部通过
    return Object.freeze({
      passed: true,
      gate: "G-6",
      reason:
        `G-6 门禁通过：G-5 已通过，单测全过，spec.md 状态 approved，` +
        `implementationRoot="${g6Context.implementationRoot}"`,
      severity: "blocker",
    }) as GateResult;
  }
}
