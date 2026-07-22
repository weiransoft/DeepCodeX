/**
 * EAG-P5 Phase 5.2 BlockerGuardChain 守护链调度器（TASK-P5-5.2-007）
 *
 * 本模块实现 `BlockerGuardChain` 类，按 A-1 → A-2 → A-3 → A-4 → A-5 → A-6 顺序
 * 调度 6 个 Guard 实例的 check() 方法，任一层 BLOCKER 触发即 fail-closed 短路中止。
 *
 * 核心职责（对齐架构师审查 §4.2 + §6 守护链架构图）：
 * 1. 构造时注入 6 个 Guard 实例（EnvBoundaryGuard / DangerousCommandGuard /
 *    ScopeLockGuard / FakeCompletionGuard / CredentialMisuseGuard /
 *    RuntimeConstraintGuard）
 * 2. execute(context) 按层级顺序调用每个 Guard 的 check()
 * 3. 任一层返回 DENY/ASK 即短路中止，不再执行后续层
 * 4. 返回 GuardChainResult，含 overallDecision / triggeredGuards / firstDenial /
 *    durationMs / allVerdicts
 * 5. DENY 触发时抛出 GuardViolationError（可选，由调用方决定）
 *
 * 守护链调度顺序（严格按 GUARD_LAYER_ORDER）：
 * - A-1 EnvBoundaryGuard：环境边界硬隔离（路径牢笼 / 环境变量 / 生产凭据）
 * - A-2 DangerousCommandGuard：危险命令拦截（黑名单 / 删除分级 / 白名单收敛）
 * - A-3 ScopeLockGuard：任务范围锁（行动依据唯一化 / 清理类意图永禁）
 * - A-4 FakeCompletionGuard：防伪造完成（证据强制 / stop_when 确定性）
 * - A-5 CredentialMisuseGuard：防越权用凭证（凭据文件读取 / commit 前密钥扫描）
 * - A-6 RuntimeConstraintGuard：无人值守运行时约束（确认卡 / 熔断 / 上限不可自改）
 *
 * 短路原则：
 * - 任一层返回 DENY → 立即中止，overallDecision=DENY
 * - 任一层返回 ASK → 立即中止，overallDecision=ASK
 * - 所有层返回 PASS → overallDecision=PASS
 * - 决策优先级：DENY > ASK > PASS
 *
 * 不可变优先原则（NFR-8）：
 * - 所有字段 readonly
 * - guards 数组 ReadonlyArray
 * - 返回结果 Object.freeze
 *
 * @module eag/p5/guards/blocker-guard-chain
 */

import type { GuardContext, GuardChainResult, GuardDecision, GuardLayer, GuardRule, GuardVerdict } from "./types";
import { GuardViolationError, GUARD_LAYER_ORDER } from "./types";
import { EnvBoundaryGuard } from "./env-boundary-guard";
import { DangerousCommandGuard } from "./dangerous-command-guard";
import {
  ScopeLockGuard,
  FakeCompletionGuard,
  CredentialMisuseGuard,
  RuntimeConstraintGuard,
} from "./scope-fake-cred-runtime-guards";

// ============================================================================
// 1. 类型定义
// ============================================================================

/**
 * Guard 实例与所属层级的绑定结构
 *
 * 用于 BlockerGuardChain 内部调度，确保 Guard 顺序与 GUARD_LAYER_ORDER 一致。
 */
interface GuardLayerBinding {
  /** 所属层级 */
  readonly layer: GuardLayer;
  /** Guard 实例（实现 GuardRule 接口） */
  readonly guard: GuardRule;
}

/**
 * 守护链构造选项
 *
 * 用于 BlockerGuardChain 构造时控制行为。
 */
export interface BlockerGuardChainOptions {
  /**
   * 是否在 DENY 触发时抛出 GuardViolationError
   *
   * - true（默认）：DENY 时抛出错误，调用方需 try/catch
   * - false：DENY 时仅返回 GuardChainResult，不抛出错误
   */
  readonly throwOnDeny?: boolean;
}

// ============================================================================
// 2. 默认配置常量
// ============================================================================

/**
 * 默认构造选项（throwOnDeny=true，符合 fail-closed 原则）
 */
const DEFAULT_OPTIONS: Readonly<BlockerGuardChainOptions> = Object.freeze({
  throwOnDeny: true,
});

/**
 * 守护链执行超时上限（毫秒，NFR-7 性能保护）
 *
 * 单次 execute() 总耗时超过此值时，记录警告但不中止（避免误判）。
 *
 * 数值依据：
 * - 6 层 Guard 每层 P99 < 5ms，总计 < 30ms
 * - G-A5b commit 前密钥扫描可能耗时较高（取决于文件数）
 * - 1000ms 留足余量，超过则视为异常
 */
const CHAIN_EXECUTION_TIMEOUT_MS = 1000 as const;

// ============================================================================
// 3. BlockerGuardChain 类
// ============================================================================

/**
 * BlockerGuardChain —— 6 层 15 条 BLOCKER 守护链调度器
 *
 * 用法：
 * ```typescript
 * const chain = new BlockerGuardChain({
 *   envBoundaryGuard: new EnvBoundaryGuard(),
 *   dangerousCommandGuard: new DangerousCommandGuard(),
 *   scopeLockGuard: new ScopeLockGuard(),
 *   fakeCompletionGuard: new FakeCompletionGuard(),
 *   credentialMisuseGuard: new CredentialMisuseGuard(),
 *   runtimeConstraintGuard: new RuntimeConstraintGuard(),
 * });
 *
 * try {
 *   const result = chain.execute(context);
 *   if (result.overallDecision === "PASS") {
 *     // 全部通过，继续执行
 *   } else {
 *     // ASK 转人工
 *   }
 * } catch (e) {
 *   if (e instanceof GuardViolationError) {
 *     // DENY 触发，回滚到上一个里程碑
 *   }
 * }
 * ```
 *
 * 守护链调度顺序（严格按 GUARD_LAYER_ORDER）：
 * 1. A-1 EnvBoundaryGuard
 * 2. A-2 DangerousCommandGuard
 * 3. A-3 ScopeLockGuard
 * 4. A-4 FakeCompletionGuard
 * 5. A-5 CredentialMisuseGuard
 * 6. A-6 RuntimeConstraintGuard
 *
 * 短路原则：任一层 BLOCKER 触发即中止，不再执行后续层。
 */
export class BlockerGuardChain {
  /** Guard 实例与层级的绑定列表（按 GUARD_LAYER_ORDER 顺序） */
  private readonly bindings: ReadonlyArray<GuardLayerBinding>;
  /** 构造选项（冻结） */
  private readonly options: Readonly<BlockerGuardChainOptions>;

  /**
   * 构造 BlockerGuardChain
   *
   * @param guards 6 个 Guard 实例的注入对象
   * @param options 构造选项（可选）
   * @throws {Error} 缺少必需的 Guard 实例时抛出
   */
  constructor(
    guards: {
      readonly envBoundaryGuard: EnvBoundaryGuard;
      readonly dangerousCommandGuard: DangerousCommandGuard;
      readonly scopeLockGuard: ScopeLockGuard;
      readonly fakeCompletionGuard: FakeCompletionGuard;
      readonly credentialMisuseGuard: CredentialMisuseGuard;
      readonly runtimeConstraintGuard: RuntimeConstraintGuard;
    },
    options?: BlockerGuardChainOptions
  ) {
    // 校验所有 Guard 实例已注入
    if (!guards.envBoundaryGuard) {
      throw new Error("BlockerGuardChain: envBoundaryGuard 必需");
    }
    if (!guards.dangerousCommandGuard) {
      throw new Error("BlockerGuardChain: dangerousCommandGuard 必需");
    }
    if (!guards.scopeLockGuard) {
      throw new Error("BlockerGuardChain: scopeLockGuard 必需");
    }
    if (!guards.fakeCompletionGuard) {
      throw new Error("BlockerGuardChain: fakeCompletionGuard 必需");
    }
    if (!guards.credentialMisuseGuard) {
      throw new Error("BlockerGuardChain: credentialMisuseGuard 必需");
    }
    if (!guards.runtimeConstraintGuard) {
      throw new Error("BlockerGuardChain: runtimeConstraintGuard 必需");
    }

    // 按 GUARD_LAYER_ORDER 顺序构建绑定列表
    this.bindings = Object.freeze([
      { layer: "A-1", guard: guards.envBoundaryGuard },
      { layer: "A-2", guard: guards.dangerousCommandGuard },
      { layer: "A-3", guard: guards.scopeLockGuard },
      { layer: "A-4", guard: guards.fakeCompletionGuard },
      { layer: "A-5", guard: guards.credentialMisuseGuard },
      { layer: "A-6", guard: guards.runtimeConstraintGuard },
    ]);

    this.options = Object.freeze({ ...DEFAULT_OPTIONS, ...options });
  }

  /**
   * 执行守护链
   *
   * 执行流程：
   * 1. 记录起始时间戳
   * 2. 按顺序遍历 6 层 Guard
   * 3. 对每层调用 guard.check(context)
   * 4. 处理同步或异步返回值（Promise<GuardVerdict> | GuardVerdict）
   * 5. 记录判定结果到 allVerdicts
   * 6. 若 decision != PASS，记录到 triggeredGuards
   * 7. 若 decision == DENY，记录到 firstDenial 并短路中止
   * 8. 若 decision == ASK，短路中止（不继续后续层）
   * 9. 计算总耗时，构建 GuardChainResult
   * 10. 若 throwOnDeny=true 且 firstDenial 存在，抛出 GuardViolationError
   *
   * @param context 判定上下文
   * @returns 守护链执行结果（含 overallDecision / triggeredGuards / firstDenial / durationMs / allVerdicts）
   * @throws {GuardViolationError} throwOnDeny=true 且 DENY 触发时抛出
   */
  async execute(context: Readonly<GuardContext>): Promise<Readonly<GuardChainResult>> {
    const startTime = Date.now();
    const allVerdicts: GuardVerdict[] = [];
    const triggeredGuards: GuardVerdict[] = [];
    let firstDenial: GuardVerdict | null = null;
    let overallDecision: GuardDecision = "PASS";

    // 按顺序执行 6 层 Guard
    for (const { layer, guard } of this.bindings) {
      // 调用 Guard.check()，处理同步或异步返回值
      const verdictOrPromise = guard.check(context);
      const verdict: GuardVerdict = verdictOrPromise instanceof Promise ? await verdictOrPromise : verdictOrPromise;

      allVerdicts.push(verdict);

      // 非 PASS 时记录到 triggeredGuards
      if (verdict.decision !== "PASS") {
        triggeredGuards.push(verdict);
      }

      // DENY 处理：记录 firstDenial 并短路中止
      if (verdict.decision === "DENY") {
        if (!firstDenial) {
          firstDenial = verdict;
        }
        overallDecision = "DENY";
        break; // 短路中止，不再执行后续层
      }

      // ASK 处理：短路中止（不继续后续层）
      // 注意：此处无需检查 overallDecision !== "DENY"，因为 DENY 分支已 break
      if (verdict.decision === "ASK") {
        overallDecision = "ASK";
        break; // 短路中止，不再执行后续层
      }
    }

    const durationMs = Date.now() - startTime;

    // 构建结果（冻结）
    const result: Readonly<GuardChainResult> = Object.freeze({
      overallDecision,
      triggeredGuards: Object.freeze(triggeredGuards),
      firstDenial: firstDenial ? Object.freeze({ ...firstDenial }) : null,
      durationMs,
      allVerdicts: Object.freeze(allVerdicts),
    });

    // 性能警告（不中止，仅记录到 stderr）
    if (durationMs > CHAIN_EXECUTION_TIMEOUT_MS) {
      console.warn(
        `BlockerGuardChain: 执行耗时 ${durationMs}ms 超过阈值 ${CHAIN_EXECUTION_TIMEOUT_MS}ms（run-id：${context.runId}，迭代：${context.iterIndex}）`
      );
    }

    // throwOnDeny=true 且 DENY 触发时抛出错误
    if (this.options.throwOnDeny && firstDenial) {
      // 找到 firstDenial 对应的层级
      let denialLayer: GuardLayer = "A-1";
      for (const { layer, guard } of this.bindings) {
        if (guard.ruleId === firstDenial.ruleId) {
          denialLayer = layer;
          break;
        }
      }
      throw new GuardViolationError(firstDenial, denialLayer);
    }

    return result;
  }

  /**
   * 同步执行守护链（不等待异步 Guard）
   *
   * 警告：仅当所有 Guard 的 check() 都是同步返回时使用此方法。
   * 若存在异步 Guard，应使用 execute() 异步方法。
   *
   * @param context 判定上下文
   * @returns 守护链执行结果
   * @throws {GuardViolationError} throwOnDeny=true 且 DENY 触发时抛出
   * @throws {Error} Guard 返回 Promise 时抛出（应改用 execute()）
   */
  executeSync(context: Readonly<GuardContext>): Readonly<GuardChainResult> {
    const startTime = Date.now();
    const allVerdicts: GuardVerdict[] = [];
    const triggeredGuards: GuardVerdict[] = [];
    let firstDenial: GuardVerdict | null = null;
    let overallDecision: GuardDecision = "PASS";

    for (const { layer, guard } of this.bindings) {
      const verdictOrPromise = guard.check(context);

      // 校验同步返回
      if (verdictOrPromise instanceof Promise) {
        throw new Error(`BlockerGuardChain.executeSync: ${layer} 层 Guard 返回 Promise，应改用 execute() 异步方法`);
      }

      const verdict = verdictOrPromise;
      allVerdicts.push(verdict);

      if (verdict.decision !== "PASS") {
        triggeredGuards.push(verdict);
      }

      if (verdict.decision === "DENY") {
        if (!firstDenial) {
          firstDenial = verdict;
        }
        overallDecision = "DENY";
        break;
      }

      // ASK 处理：短路中止（不继续后续层）
      // 注意：此处无需检查 overallDecision !== "DENY"，因为 DENY 分支已 break
      if (verdict.decision === "ASK") {
        overallDecision = "ASK";
        break;
      }
    }

    const durationMs = Date.now() - startTime;

    const result: Readonly<GuardChainResult> = Object.freeze({
      overallDecision,
      triggeredGuards: Object.freeze(triggeredGuards),
      firstDenial: firstDenial ? Object.freeze({ ...firstDenial }) : null,
      durationMs,
      allVerdicts: Object.freeze(allVerdicts),
    });

    if (durationMs > CHAIN_EXECUTION_TIMEOUT_MS) {
      console.warn(
        `BlockerGuardChain: 执行耗时 ${durationMs}ms 超过阈值 ${CHAIN_EXECUTION_TIMEOUT_MS}ms（run-id：${context.runId}，迭代：${context.iterIndex}）`
      );
    }

    if (this.options.throwOnDeny && firstDenial) {
      let denialLayer: GuardLayer = "A-1";
      for (const { layer, guard } of this.bindings) {
        if (guard.ruleId === firstDenial.ruleId) {
          denialLayer = layer;
          break;
        }
      }
      throw new GuardViolationError(firstDenial, denialLayer);
    }

    return result;
  }

  /**
   * 获取守护链层级顺序（只读副本）
   *
   * @returns 层级顺序数组（与 GUARD_LAYER_ORDER 一致）
   */
  getLayerOrder(): ReadonlyArray<GuardLayer> {
    return GUARD_LAYER_ORDER;
  }

  /**
   * 获取已注入的 Guard 实例数量
   *
   * @returns Guard 数量（应为 6）
   */
  getGuardCount(): number {
    return this.bindings.length;
  }

  /**
   * 获取构造选项（只读，冻结）
   *
   * @returns 构造选项
   */
  getOptions(): Readonly<BlockerGuardChainOptions> {
    return this.options;
  }
}

// ============================================================================
// 4. 工厂函数
// ============================================================================

/**
 * 创建默认 BlockerGuardChain 实例
 *
 * 使用所有 Guard 的默认构造（无自定义参数）。
 *
 * @param options 构造选项（可选）
 * @returns 默认 BlockerGuardChain 实例
 *
 * 注意：此函数依赖顶层 import 的 Guard 类（EnvBoundaryGuard / DangerousCommandGuard /
 * ScopeLockGuard / FakeCompletionGuard / CredentialMisuseGuard / RuntimeConstraintGuard），
 * 不使用动态 require（ESM 环境下 require 不可用）。
 */
export function createDefaultBlockerGuardChain(options?: BlockerGuardChainOptions): BlockerGuardChain {
  return new BlockerGuardChain(
    {
      envBoundaryGuard: new EnvBoundaryGuard(),
      dangerousCommandGuard: new DangerousCommandGuard(),
      scopeLockGuard: new ScopeLockGuard(),
      fakeCompletionGuard: new FakeCompletionGuard(),
      credentialMisuseGuard: new CredentialMisuseGuard(),
      runtimeConstraintGuard: new RuntimeConstraintGuard(),
    },
    options
  );
}

// ============================================================================
// 5. 导出常量
// ============================================================================

/**
 * 导出守护链执行超时上限（供测试断言）
 */
export { CHAIN_EXECUTION_TIMEOUT_MS as BLOCKER_GUARD_CHAIN_TIMEOUT_MS };
