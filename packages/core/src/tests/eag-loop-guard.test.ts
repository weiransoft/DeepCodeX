/**
 * EAG-P0 单元测试：LoopGuard 共享上限保护模块
 *
 * 测试范围：
 * - A. 默认配置（DEFAULT_LOOP_GUARD_CONFIG）与初始状态（INITIAL_LOOP_GUARD_STATE）
 * - B. LoopGuard 构造函数（默认配置 / 自定义覆盖 / 冻结保证）
 * - C. check() 终止条件优先级（手动终止 > 连续失败 > 迭代上限 > Token 上限）
 * - D. recordIteration() 状态更新（成功/失败/重置）
 * - E. abort() 手动终止
 * - F. getState() / getConfig() 快照只读
 * - G. calculateBackoff() 指数退避 + jitter（通过 check().suggestedWaitMs 间接验证）
 * - H. 边界条件（0 上限 / 极大值 / 首次检查）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 LoopGuard 实例
 * - 每个测试用例独立构造 LoopGuard，无共享可变状态
 *
 * 设计依据：
 * - EAG 方案 §5.2.1 五步闭环上限保护
 * - EAG 方案 §5.12.3 AU-5 硬上限（LLM 不可自改）
 * - EAG 方案 §5.12.4 G-A6d 配置冻结保证
 * - common/loop-guard.ts 源文件（被测对象）
 *
 * @module core/tests/eag-loop-guard
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LoopGuard,
  DEFAULT_LOOP_GUARD_CONFIG,
  INITIAL_LOOP_GUARD_STATE,
  type LoopGuardConfig,
  type LoopGuardState,
  type GuardCheckResult,
  type GuardStopReason,
} from "../common/loop-guard";

// ============================================================================
// A. 默认配置与初始状态测试
// ============================================================================

test("A1. DEFAULT_LOOP_GUARD_CONFIG.maxIterations 默认 50", () => {
  assert.equal(DEFAULT_LOOP_GUARD_CONFIG.maxIterations, 50);
});

test("A2. DEFAULT_LOOP_GUARD_CONFIG.maxTokens 默认 200000", () => {
  assert.equal(DEFAULT_LOOP_GUARD_CONFIG.maxTokens, 200_000);
});

test("A3. DEFAULT_LOOP_GUARD_CONFIG.maxConsecutiveFailures 默认 3", () => {
  assert.equal(DEFAULT_LOOP_GUARD_CONFIG.maxConsecutiveFailures, 3);
});

test("A4. DEFAULT_LOOP_GUARD_CONFIG 退避参数默认值正确", () => {
  assert.equal(DEFAULT_LOOP_GUARD_CONFIG.initialBackoffMs, 1_000);
  assert.equal(DEFAULT_LOOP_GUARD_CONFIG.maxBackoffMs, 30_000);
  assert.equal(DEFAULT_LOOP_GUARD_CONFIG.backoffMultiplier, 2.0);
  assert.equal(DEFAULT_LOOP_GUARD_CONFIG.jitterRatio, 0.1);
});

test("A5. DEFAULT_LOOP_GUARD_CONFIG 已冻结（Object.isFrozen）", () => {
  assert.ok(Object.isFrozen(DEFAULT_LOOP_GUARD_CONFIG));
});

test("A6. INITIAL_LOOP_GUARD_STATE 所有字段初始为 0", () => {
  assert.equal(INITIAL_LOOP_GUARD_STATE.iterationsCompleted, 0);
  assert.equal(INITIAL_LOOP_GUARD_STATE.tokensConsumed, 0);
  assert.equal(INITIAL_LOOP_GUARD_STATE.consecutiveFailures, 0);
  assert.equal(INITIAL_LOOP_GUARD_STATE.totalFailures, 0);
  assert.equal(INITIAL_LOOP_GUARD_STATE.backoffLevel, 0);
  assert.equal(INITIAL_LOOP_GUARD_STATE.lastFailureTime, undefined);
});

test("A7. INITIAL_LOOP_GUARD_STATE 已冻结", () => {
  assert.ok(Object.isFrozen(INITIAL_LOOP_GUARD_STATE));
});

// ============================================================================
// B. LoopGuard 构造函数测试
// ============================================================================

test("B8. 无参构造使用默认配置", () => {
  const guard = new LoopGuard();
  const config = guard.getConfig();
  assert.equal(config.maxIterations, 50);
  assert.equal(config.maxTokens, 200_000);
  assert.equal(config.maxConsecutiveFailures, 3);
});

test("B9. 自定义全部字段覆盖默认", () => {
  const custom: Partial<LoopGuardConfig> = {
    maxIterations: 10,
    maxTokens: 50_000,
    maxConsecutiveFailures: 5,
    initialBackoffMs: 500,
    maxBackoffMs: 10_000,
    backoffMultiplier: 1.5,
    jitterRatio: 0.2,
  };
  const guard = new LoopGuard(custom);
  const config = guard.getConfig();
  assert.equal(config.maxIterations, 10);
  assert.equal(config.maxTokens, 50_000);
  assert.equal(config.maxConsecutiveFailures, 5);
  assert.equal(config.initialBackoffMs, 500);
  assert.equal(config.maxBackoffMs, 10_000);
  assert.equal(config.backoffMultiplier, 1.5);
  assert.equal(config.jitterRatio, 0.2);
});

test("B10. 部分覆盖配置保留未覆盖字段为默认值", () => {
  const guard = new LoopGuard({ maxIterations: 5 });
  const config = guard.getConfig();
  assert.equal(config.maxIterations, 5);
  // 未覆盖的字段保持默认
  assert.equal(config.maxTokens, 200_000);
  assert.equal(config.maxConsecutiveFailures, 3);
});

test("B11. getConfig() 返回的配置已冻结", () => {
  const guard = new LoopGuard({ maxIterations: 5 });
  const config = guard.getConfig();
  assert.ok(Object.isFrozen(config));
});

test("B12. 构造后初始状态与 INITIAL_LOOP_GUARD_STATE 一致", () => {
  const guard = new LoopGuard();
  const state = guard.getState();
  assert.equal(state.iterationsCompleted, 0);
  assert.equal(state.tokensConsumed, 0);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.totalFailures, 0);
  assert.equal(state.backoffLevel, 0);
  assert.equal(state.lastFailureTime, undefined);
});

// ============================================================================
// C. check() 终止条件优先级测试
// ============================================================================

test("C13. 初始 check() 允许继续（allowed=true）", () => {
  const guard = new LoopGuard();
  const check = guard.check();
  assert.equal(check.allowed, true);
  assert.equal(check.stopReason, undefined);
});

test("C14. 初始 check() 无退避建议（suggestedWaitMs undefined）", () => {
  const guard = new LoopGuard();
  const check = guard.check();
  assert.equal(check.suggestedWaitMs, undefined);
});

test("C15. check() 返回剩余迭代次数正确", () => {
  const guard = new LoopGuard({ maxIterations: 10 });
  guard.recordIteration(100, true);
  guard.recordIteration(100, true);
  const check = guard.check();
  assert.equal(check.remainingIterations, 8);
});

test("C16. check() 返回剩余 Token 预算正确", () => {
  const guard = new LoopGuard({ maxTokens: 1_000 });
  guard.recordIteration(300, true);
  const check = guard.check();
  assert.equal(check.remainingTokens, 700);
});

test("C17. check() 终止优先级：手动终止 > 连续失败", () => {
  // 同时满足手动终止和连续失败超上限时，手动终止优先
  const guard = new LoopGuard({ maxConsecutiveFailures: 2 });
  guard.recordIteration(100, false);
  guard.recordIteration(100, false);
  guard.abort();
  const check = guard.check();
  assert.equal(check.allowed, false);
  assert.equal(check.stopReason, "manually_aborted");
});

test("C18. check() 终止优先级：连续失败 > 迭代上限", () => {
  // 同时满足连续失败和迭代上限时，连续失败优先
  const guard = new LoopGuard({
    maxIterations: 1,
    maxConsecutiveFailures: 2,
  });
  guard.recordIteration(100, false);
  guard.recordIteration(100, false);
  // 此时 iterationsCompleted=2（超 maxIterations=1），consecutiveFailures=2（超上限）
  const check = guard.check();
  assert.equal(check.allowed, false);
  assert.equal(check.stopReason, "max_consecutive_failures");
});

test("C19. check() 终止优先级：迭代上限 > Token 上限", () => {
  // 同时满足迭代上限和 Token 上限时，迭代上限优先
  const guard = new LoopGuard({
    maxIterations: 1,
    maxTokens: 100,
  });
  guard.recordIteration(200, true);
  // iterationsCompleted=1（达 maxIterations），tokensConsumed=200（超 maxTokens）
  const check = guard.check();
  assert.equal(check.allowed, false);
  assert.equal(check.stopReason, "max_iterations_exceeded");
});

test("C20. check() 触发 max_consecutive_failures", () => {
  const guard = new LoopGuard({ maxConsecutiveFailures: 2 });
  guard.recordIteration(100, false);
  guard.recordIteration(100, false);
  const check = guard.check();
  assert.equal(check.allowed, false);
  assert.equal(check.stopReason, "max_consecutive_failures");
});

test("C21. check() 触发 max_iterations_exceeded", () => {
  const guard = new LoopGuard({ maxIterations: 2 });
  guard.recordIteration(100, true);
  guard.recordIteration(100, true);
  const check = guard.check();
  assert.equal(check.allowed, false);
  assert.equal(check.stopReason, "max_iterations_exceeded");
});

test("C22. check() 触发 max_tokens_exceeded", () => {
  const guard = new LoopGuard({ maxTokens: 500 });
  guard.recordIteration(600, true);
  const check = guard.check();
  assert.equal(check.allowed, false);
  assert.equal(check.stopReason, "max_tokens_exceeded");
});

test("C23. check() 返回 state 是当前状态的快照", () => {
  const guard = new LoopGuard();
  guard.recordIteration(100, true);
  const check = guard.check();
  assert.equal(check.state.iterationsCompleted, 1);
  assert.equal(check.state.tokensConsumed, 100);
});

// ============================================================================
// D. recordIteration() 状态更新测试
// ============================================================================

test("D24. recordIteration 成功迭代递增 iterationsCompleted", () => {
  const guard = new LoopGuard();
  guard.recordIteration(100, true);
  assert.equal(guard.getState().iterationsCompleted, 1);
  guard.recordIteration(100, true);
  assert.equal(guard.getState().iterationsCompleted, 2);
});

test("D25. recordIteration 累加 tokensConsumed", () => {
  const guard = new LoopGuard();
  guard.recordIteration(100, true);
  guard.recordIteration(200, true);
  guard.recordIteration(300, true);
  assert.equal(guard.getState().tokensConsumed, 600);
});

test("D26. recordIteration 失败递增 consecutiveFailures 和 totalFailures", () => {
  const guard = new LoopGuard();
  guard.recordIteration(100, false);
  assert.equal(guard.getState().consecutiveFailures, 1);
  assert.equal(guard.getState().totalFailures, 1);
  guard.recordIteration(100, false);
  assert.equal(guard.getState().consecutiveFailures, 2);
  assert.equal(guard.getState().totalFailures, 2);
});

test("D27. recordIteration 成功重置 consecutiveFailures", () => {
  const guard = new LoopGuard();
  guard.recordIteration(100, false);
  guard.recordIteration(100, false);
  assert.equal(guard.getState().consecutiveFailures, 2);
  // 成功一次后重置
  guard.recordIteration(100, true);
  assert.equal(guard.getState().consecutiveFailures, 0);
  // totalFailures 不重置
  assert.equal(guard.getState().totalFailures, 2);
});

test("D28. recordInterval 失败更新 lastFailureTime（ISO 8601 字符串）", () => {
  const guard = new LoopGuard();
  assert.equal(guard.getState().lastFailureTime, undefined);
  guard.recordIteration(100, false);
  const lft = guard.getState().lastFailureTime;
  assert.ok(typeof lft === "string");
  // 应为合法的 ISO 8601 时间
  const parsed = new Date(lft!);
  assert.ok(!Number.isNaN(parsed.getTime()));
});

test("D29. recordIteration 失败递增 backoffLevel", () => {
  const guard = new LoopGuard();
  assert.equal(guard.getState().backoffLevel, 0);
  guard.recordIteration(100, false);
  assert.equal(guard.getState().backoffLevel, 1);
  guard.recordIteration(100, false);
  assert.equal(guard.getState().backoffLevel, 2);
});

test("D30. recordIteration 成功重置 backoffLevel", () => {
  const guard = new LoopGuard();
  guard.recordIteration(100, false);
  guard.recordIteration(100, false);
  assert.equal(guard.getState().backoffLevel, 2);
  guard.recordIteration(100, true);
  assert.equal(guard.getState().backoffLevel, 0);
});

test("D31. recordIteration tokensUsed=0 不增加消耗", () => {
  const guard = new LoopGuard();
  guard.recordIteration(0, true);
  assert.equal(guard.getState().tokensConsumed, 0);
  assert.equal(guard.getState().iterationsCompleted, 1);
});

// ============================================================================
// E. abort() 手动终止测试
// ============================================================================

test("E32. abort() 后 check() 返回 allowed=false", () => {
  const guard = new LoopGuard();
  guard.abort();
  const check = guard.check();
  assert.equal(check.allowed, false);
});

test("E33. abort() 后 stopReason='manually_aborted'", () => {
  const guard = new LoopGuard();
  guard.abort();
  const check = guard.check();
  assert.equal(check.stopReason, "manually_aborted");
});

test("E34. abort() 多次调用幂等", () => {
  const guard = new LoopGuard();
  guard.abort();
  guard.abort();
  guard.abort();
  const check = guard.check();
  assert.equal(check.allowed, false);
  assert.equal(check.stopReason, "manually_aborted");
});

test("E35. abort() 优先级最高（覆盖所有其他条件）", () => {
  const guard = new LoopGuard({ maxIterations: 100 });
  guard.recordIteration(100, true);
  guard.recordIteration(100, true);
  guard.abort();
  const check = guard.check();
  // 即使迭代次数未超上限，手动终止仍然生效
  assert.equal(check.allowed, false);
  assert.equal(check.stopReason, "manually_aborted");
});

// ============================================================================
// F. getState() / getConfig() 快照只读测试
// ============================================================================

test("F36. getState() 返回快照（修改不影响内部状态）", () => {
  const guard = new LoopGuard();
  guard.recordIteration(100, true);
  const state1 = guard.getState();
  // 尝试修改返回的快照
  (state1 as LoopGuardState).iterationsCompleted = 999;
  // 内部状态不受影响
  const state2 = guard.getState();
  assert.equal(state2.iterationsCompleted, 1);
});

test("F37. getConfig() 返回冻结的配置（修改抛错或无效）", () => {
  const guard = new LoopGuard({ maxIterations: 5 });
  const config = guard.getConfig();
  // 严格模式下修改冻结对象抛 TypeError
  assert.throws(() => {
    (config as LoopGuardConfig).maxIterations = 999;
  }, TypeError);
});

test("F38. getState() 每次返回新对象（深拷贝）", () => {
  const guard = new LoopGuard();
  const state1 = guard.getState();
  const state2 = guard.getState();
  assert.notEqual(state1, state2);
  assert.deepEqual(state1, state2);
});

// ============================================================================
// G. calculateBackoff() 指数退避 + jitter 测试（通过 check().suggestedWaitMs 间接验证）
// ============================================================================

test("G39. backoffLevel=0 时无退避建议", () => {
  const guard = new LoopGuard();
  const check = guard.check();
  assert.equal(check.suggestedWaitMs, undefined);
});

test("G40. 首次失败后 backoffLevel=1 退避约 initialBackoffMs", () => {
  // 自定义较小的退避参数便于验证
  const guard = new LoopGuard({
    initialBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    backoffMultiplier: 2.0,
    jitterRatio: 0, // 关闭 jitter 便于精确验证
  });
  guard.recordIteration(100, false);
  const check = guard.check();
  assert.ok(check.suggestedWaitMs !== undefined);
  // backoffLevel=1: 1000 * 2^0 = 1000
  assert.equal(check.suggestedWaitMs, 1_000);
});

test("G41. 指数退避：backoffLevel=2 延迟翻倍", () => {
  const guard = new LoopGuard({
    initialBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    backoffMultiplier: 2.0,
    jitterRatio: 0,
  });
  guard.recordIteration(100, false);
  guard.recordIteration(100, false);
  const check = guard.check();
  // backoffLevel=2: 1000 * 2^1 = 2000
  assert.equal(check.suggestedWaitMs, 2_000);
});

test("G42. 指数退避：backoffLevel=3 延迟再翻倍", () => {
  const guard = new LoopGuard({
    initialBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    backoffMultiplier: 2.0,
    jitterRatio: 0,
    maxConsecutiveFailures: 100, // 避免连续失败终止，专注于退避计算验证
  });
  guard.recordIteration(100, false);
  guard.recordIteration(100, false);
  guard.recordIteration(100, false);
  const check = guard.check();
  // backoffLevel=3: 1000 * 2^2 = 4000
  assert.equal(check.suggestedWaitMs, 4_000);
});

test("G43. 退避上限截断为 maxBackoffMs", () => {
  // initialBackoffMs=10000, multiplier=2.0, level=5 → 10000*2^4=160000 > maxBackoffMs=30000
  const guard = new LoopGuard({
    initialBackoffMs: 10_000,
    maxBackoffMs: 30_000,
    backoffMultiplier: 2.0,
    jitterRatio: 0,
    maxConsecutiveFailures: 100, // 防止连续失败终止
  });
  for (let i = 0; i < 5; i++) {
    guard.recordIteration(100, false);
  }
  const check = guard.check();
  // 应被截断为 maxBackoffMs=30000
  assert.equal(check.suggestedWaitMs, 30_000);
});

test("G44. jitter 在 ±jitterRatio 范围内", () => {
  // 多次采样验证 jitter 范围
  const guard = new LoopGuard({
    initialBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    backoffMultiplier: 2.0,
    jitterRatio: 0.1,
  });
  guard.recordIteration(100, false);
  // 基础延迟 1000，jitter 范围 [900, 1100]
  for (let i = 0; i < 20; i++) {
    const check = guard.check();
    assert.ok(check.suggestedWaitMs !== undefined);
    assert.ok(
      check.suggestedWaitMs! >= 900 && check.suggestedWaitMs! <= 1100,
      `jitter ${check.suggestedWaitMs} 超出 [900, 1100] 范围`
    );
  }
});

test("G45. 成功迭代重置 backoffLevel 后无退避建议", () => {
  const guard = new LoopGuard({
    initialBackoffMs: 1_000,
    jitterRatio: 0,
  });
  guard.recordIteration(100, false);
  guard.recordIteration(100, false);
  // 此时 backoffLevel=2
  // 成功一次后重置
  guard.recordIteration(100, true);
  const check = guard.check();
  assert.equal(check.suggestedWaitMs, undefined);
});

// ============================================================================
// H. 边界条件测试
// ============================================================================

test("H46. maxIterations=0 时首次 check 立即终止", () => {
  const guard = new LoopGuard({ maxIterations: 0 });
  const check = guard.check();
  // iterationsCompleted=0 >= maxIterations=0 → 终止
  assert.equal(check.allowed, false);
  assert.equal(check.stopReason, "max_iterations_exceeded");
});

test("H47. maxTokens=0 时首次 check 立即终止", () => {
  const guard = new LoopGuard({
    maxTokens: 0,
    maxIterations: 100, // 排除迭代上限干扰
  });
  const check = guard.check();
  // tokensConsumed=0 >= maxTokens=0 → 终止
  assert.equal(check.allowed, false);
  assert.equal(check.stopReason, "max_tokens_exceeded");
});

test("H48. 剩余迭代/Token 不会出现负数（Math.max 兜底）", () => {
  const guard = new LoopGuard({ maxIterations: 1, maxTokens: 100 });
  guard.recordIteration(200, true); // tokensConsumed=200 > maxTokens=100
  const check = guard.check();
  // remainingTokens 不应为负
  assert.ok(check.remainingTokens >= 0);
  assert.equal(check.remainingTokens, 0);
});

test("H49. 多次成功迭代后状态持续累积", () => {
  const guard = new LoopGuard({ maxIterations: 100, maxTokens: 10_000 });
  for (let i = 0; i < 10; i++) {
    guard.recordIteration(500, true);
  }
  const state = guard.getState();
  assert.equal(state.iterationsCompleted, 10);
  assert.equal(state.tokensConsumed, 5_000);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.totalFailures, 0);
  // 仍然允许继续
  const check = guard.check();
  assert.equal(check.allowed, true);
});

test("H50. 交错成功/失败迭代后 consecutiveFailures 正确重置", () => {
  const guard = new LoopGuard({ maxConsecutiveFailures: 100 });
  // 失败2次
  guard.recordIteration(100, false);
  guard.recordIteration(100, false);
  assert.equal(guard.getState().consecutiveFailures, 2);
  // 成功1次 → 重置
  guard.recordIteration(100, true);
  assert.equal(guard.getState().consecutiveFailures, 0);
  // 再失败1次 → consecutiveFailures=1（非3）
  guard.recordIteration(100, false);
  assert.equal(guard.getState().consecutiveFailures, 1);
  assert.equal(guard.getState().totalFailures, 3);
});
