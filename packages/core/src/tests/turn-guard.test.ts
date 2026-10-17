/**
 * 需求123/124 单元测试：TurnGuard 普通会话循环护栏
 *
 * 测试范围：
 * - A. 默认配置（DEFAULT_TURN_GUARD_CONFIG）与构造覆盖/冻结
 * - B. decideBeforeIteration() 判定优先级（Token 硬终止 > 连续失败咨询 > 轮数咨询）
 * - C. recordTurn() 状态更新（轮数递增 / Token 累计 / 连续失败计数与清零）
 * - D. acknowledgeAndContinue() 咨询-确认闭环（轮数/连续失败清零、Token 保留）
 * - E. 需求123 场景还原（40 轮未解决 → consult_user_max_turns，用户确认后继续）
 * - F. 需求124 场景还原（连续 3 轮工具全失败 → 咨询用户；Token 预算触达 → 硬终止）
 * - G. 边界条件（maxTurns=0 / maxTokenBudget=0 禁用 Token 线 / 负 Token 钳制）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 TurnGuard 实例
 * - 每个测试用例独立构造 TurnGuard，无共享可变状态
 *
 * 设计依据：
 * - 需求123：复杂任务 40 轮内未解决 → 暂停咨询（不死循环、不崩溃）
 * - 需求124：反复处理无果（连续 3 轮全失败）→ 咨询用户是否继续，Token 预算硬兜底
 * - common/loop-guard.ts TurnGuard 类（被测对象）
 *
 * @module core/tests/turn-guard
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TurnGuard,
  DEFAULT_TURN_GUARD_CONFIG,
  type TurnGuardConfig,
  type LoopGuardTurnDecision,
} from "../common/loop-guard";

// ============================================================================
// A. 默认配置与构造
// ============================================================================

test("A1. DEFAULT_TURN_GUARD_CONFIG.maxTurns 默认 40（需求123 的 40 轮上限）", () => {
  assert.equal(DEFAULT_TURN_GUARD_CONFIG.maxTurns, 40);
});

test("A2. DEFAULT_TURN_GUARD_CONFIG.maxConsecutiveFailedTurns 默认 3（需求124 的 3-5 次咨询线）", () => {
  assert.equal(DEFAULT_TURN_GUARD_CONFIG.maxConsecutiveFailedTurns, 3);
});

test("A3. DEFAULT_TURN_GUARD_CONFIG.maxTokenBudget 默认 2000000", () => {
  assert.equal(DEFAULT_TURN_GUARD_CONFIG.maxTokenBudget, 2_000_000);
});

test("A4. 构造缺省回落默认配置且冻结不可改", () => {
  const guard = new TurnGuard();
  const config = guard.getConfig();
  assert.equal(config.maxTurns, DEFAULT_TURN_GUARD_CONFIG.maxTurns);
  assert.equal(config.maxConsecutiveFailedTurns, DEFAULT_TURN_GUARD_CONFIG.maxConsecutiveFailedTurns);
  assert.equal(config.maxTokenBudget, DEFAULT_TURN_GUARD_CONFIG.maxTokenBudget);
  assert.ok(Object.isFrozen(config), "getConfig() 返回值必须冻结（LLM 不可自改上限）");
});

test("A5. 构造支持部分字段覆盖，未覆盖字段保留默认", () => {
  const override: Partial<TurnGuardConfig> = { maxTurns: 10 };
  const guard = new TurnGuard(override);
  assert.equal(guard.getConfig().maxTurns, 10);
  assert.equal(guard.getConfig().maxConsecutiveFailedTurns, DEFAULT_TURN_GUARD_CONFIG.maxConsecutiveFailedTurns);
});

// ============================================================================
// B. decideBeforeIteration() 判定优先级
// ============================================================================

test("B1. 全新 guard 首轮允许执行", () => {
  const guard = new TurnGuard();
  const decision = guard.decideBeforeIteration();
  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "");
});

test("B2. Token 预算触达 → terminate_token_budget（硬终止优先于其他咨询判定）", () => {
  const guard = new TurnGuard({ maxTokenBudget: 1000, maxTurns: 100, maxConsecutiveFailedTurns: 100 });
  guard.recordTurn({ tokensUsed: 1000, hadToolCalls: false, allToolsFailed: false });
  const decision = guard.decideBeforeIteration();
  assert.equal(decision.allow, false);
  assert.equal(decision.action, "terminate_token_budget");
  assert.match(decision.reason, /Token 消耗已达预算上限/);
});

test("B3. Token 触达与连续失败同时满足时，Token 硬终止优先（不可咨询恢复）", () => {
  const guard = new TurnGuard({ maxTokenBudget: 100, maxTurns: 100, maxConsecutiveFailedTurns: 2 });
  guard.recordTurn({ tokensUsed: 50, hadToolCalls: true, allToolsFailed: true });
  guard.recordTurn({ tokensUsed: 50, hadToolCalls: true, allToolsFailed: true });
  const decision = guard.decideBeforeIteration();
  assert.equal(decision.allow, false);
  assert.equal(decision.action, "terminate_token_budget", "Token 线优先于连续失败咨询线");
});

test("B4. 连续失败触达上限 → consult_user_consecutive_failures", () => {
  const guard = new TurnGuard({ maxConsecutiveFailedTurns: 3, maxTurns: 100, maxTokenBudget: 0 });
  for (let i = 0; i < 3; i++) {
    guard.recordTurn({ tokensUsed: 1, hadToolCalls: true, allToolsFailed: true });
  }
  const decision = guard.decideBeforeIteration();
  assert.equal(decision.allow, false);
  assert.equal(decision.action, "consult_user_consecutive_failures");
  assert.match(decision.reason, /连续 3 轮工具调用全部失败/);
});

test("B5. 轮数触达上限 → consult_user_max_turns", () => {
  const guard = new TurnGuard({ maxTurns: 5, maxConsecutiveFailedTurns: 100, maxTokenBudget: 0 });
  for (let i = 0; i < 5; i++) {
    guard.recordTurn({ tokensUsed: 10, hadToolCalls: true, allToolsFailed: false });
  }
  const decision = guard.decideBeforeIteration();
  assert.equal(decision.allow, false);
  assert.equal(decision.action, "consult_user_max_turns");
  assert.match(decision.reason, /已执行 5 轮迭代/);
});

// ============================================================================
// C. recordTurn() 状态更新
// ============================================================================

test("C1. recordTurn 轮数递增与 Token 累计", () => {
  const guard = new TurnGuard();
  guard.recordTurn({ tokensUsed: 120, hadToolCalls: false, allToolsFailed: false });
  guard.recordTurn({ tokensUsed: 80, hadToolCalls: false, allToolsFailed: false });
  const state = guard.getState();
  assert.equal(state.turnsCompleted, 2);
  assert.equal(state.tokensConsumed, 200);
});

test("C2. 有工具且全部失败 → 连续失败计数递增", () => {
  const guard = new TurnGuard();
  guard.recordTurn({ tokensUsed: 1, hadToolCalls: true, allToolsFailed: true });
  guard.recordTurn({ tokensUsed: 1, hadToolCalls: true, allToolsFailed: true });
  assert.equal(guard.getState().consecutiveFailedTurns, 2);
});

test("C3. 任一工具成功 → 连续失败计数清零（问题在推进不算拨通无果）", () => {
  const guard = new TurnGuard();
  guard.recordTurn({ tokensUsed: 1, hadToolCalls: true, allToolsFailed: true });
  guard.recordTurn({ tokensUsed: 1, hadToolCalls: true, allToolsFailed: true });
  guard.recordTurn({ tokensUsed: 1, hadToolCalls: true, allToolsFailed: false });
  assert.equal(guard.getState().consecutiveFailedTurns, 0);
});

test("C4. 无工具调用轮（最终回复轮）不影响连续失败计数", () => {
  const guard = new TurnGuard();
  guard.recordTurn({ tokensUsed: 1, hadToolCalls: true, allToolsFailed: true });
  guard.recordTurn({ tokensUsed: 1, hadToolCalls: false, allToolsFailed: false });
  assert.equal(guard.getState().consecutiveFailedTurns, 1, "无工具轮不清零");
});

test("C5. 负 Token 输入钳制为 0（防脏数据使预算倒扣）", () => {
  const guard = new TurnGuard();
  guard.recordTurn({ tokensUsed: -500, hadToolCalls: false, allToolsFailed: false });
  assert.equal(guard.getState().tokensConsumed, 0);
});

// ============================================================================
// D. acknowledgeAndContinue() 咨询-确认闭环
// ============================================================================

test("D1. 确认继续清零轮数与连续失败，但保留 Token 累计", () => {
  const guard = new TurnGuard({ maxTurns: 5, maxConsecutiveFailedTurns: 2, maxTokenBudget: 0 });
  guard.recordTurn({ tokensUsed: 300, hadToolCalls: true, allToolsFailed: true });
  guard.recordTurn({ tokensUsed: 300, hadToolCalls: true, allToolsFailed: true });
  // 触达连续失败线
  assert.equal(guard.decideBeforeIteration().action, "consult_user_consecutive_failures");
  // 用户确认继续
  guard.acknowledgeAndContinue();
  const state = guard.getState();
  assert.equal(state.turnsCompleted, 0);
  assert.equal(state.consecutiveFailedTurns, 0);
  assert.equal(state.tokensConsumed, 600, "Token 总预算不咨询恢复（硬兜底保留）");
  // 清零后重新允许执行
  assert.equal(guard.decideBeforeIteration().allow, true);
});

// ============================================================================
// E. 需求123 场景还原
// ============================================================================

test("E1. 需求123：默认 40 轮上限，40 轮未解决转咨询用户", () => {
  const guard = new TurnGuard();
  const decisions: LoopGuardTurnDecision[] = [];
  for (let i = 0; i < 41; i++) {
    const d = guard.decideBeforeIteration();
    decisions.push(d);
    if (!d.allow) break;
    // 模拟每轮有工具调用但任务未收敛（工具非全失败——纯循环）
    guard.recordTurn({ tokensUsed: 5000, hadToolCalls: true, allToolsFailed: false });
  }
  assert.equal(decisions.length, 41);
  assert.equal(decisions[40].allow, false);
  assert.equal(decisions[40].action, "consult_user_max_turns");
});

test("E2. 需求123：用户确认继续后获得新的 40 轮预算窗口", () => {
  const guard = new TurnGuard();
  for (let i = 0; i < 40; i++) {
    guard.recordTurn({ tokensUsed: 5000, hadToolCalls: true, allToolsFailed: false });
  }
  assert.equal(guard.decideBeforeIteration().allow, false);
  guard.acknowledgeAndContinue();
  // 新窗口：再跑 39 轮仍允许
  for (let i = 0; i < 39; i++) {
    assert.equal(guard.decideBeforeIteration().allow, true);
    guard.recordTurn({ tokensUsed: 5000, hadToolCalls: true, allToolsFailed: false });
  }
});

// ============================================================================
// F. 需求124 场景还原
// ============================================================================

test("F1. 需求124：同一命令连续 3 轮全失败后咨询用户（不再盲目烧到 41 次）", () => {
  const guard = new TurnGuard();
  // 模拟 dev 阶段：LLM 反复执行同一失败命令，前 2 轮允许、第 4 次判定前咨询
  const seq: boolean[] = [];
  for (let i = 0; i < 4; i++) {
    const d = guard.decideBeforeIteration();
    seq.push(d.allow);
    if (!d.allow) break;
    guard.recordTurn({ tokensUsed: 8000, hadToolCalls: true, allToolsFailed: true });
  }
  assert.deepEqual(seq, [true, true, true, false], "第 4 次请求前（连续失败=3）必须暂停咨询");
});

test("F2. 需求124：用户放行（新消息/确认）后清零并再给 3 次机会", () => {
  const guard = new TurnGuard();
  for (let i = 0; i < 3; i++) {
    guard.recordTurn({ tokensUsed: 8000, hadToolCalls: true, allToolsFailed: true });
  }
  assert.equal(guard.decideBeforeIteration().action, "consult_user_consecutive_failures");
  guard.acknowledgeAndContinue();
  // 用户放行后新一轮：允许执行 3 次
  for (let i = 0; i < 3; i++) {
    assert.equal(guard.decideBeforeIteration().allow, true);
    guard.recordTurn({ tokensUsed: 8000, hadToolCalls: true, allToolsFailed: true });
  }
  // 再次全失败 3 轮 → 再次咨询
  assert.equal(guard.decideBeforeIteration().action, "consult_user_consecutive_failures");
});

test("F3. 需求124：Token 触达预算后即使连续失败清零也不再放行（硬终止）", () => {
  const guard = new TurnGuard({ maxTokenBudget: 10_000 });
  guard.recordTurn({ tokensUsed: 10_000, hadToolCalls: true, allToolsFailed: true });
  const d1 = guard.decideBeforeIteration();
  assert.equal(d1.action, "terminate_token_budget");
  // 确认继续（正常场景不会发生，但验证 Token 硬线不受咨询恢复影响）
  guard.acknowledgeAndContinue();
  const d2 = guard.decideBeforeIteration();
  assert.equal(d2.allow, false);
  assert.equal(d2.action, "terminate_token_budget");
});

// ============================================================================
// G. 边界条件
// ============================================================================

test("G1. maxTurns=0：首轮即咨询（上限设为 0 表示立即需要用户确认）", () => {
  const guard = new TurnGuard({ maxTurns: 0, maxConsecutiveFailedTurns: 100, maxTokenBudget: 0 });
  const d = guard.decideBeforeIteration();
  assert.equal(d.allow, false);
  assert.equal(d.action, "consult_user_max_turns");
});

test("G2. maxTokenBudget=0：禁用 Token 硬终止线（任何 Token 累计都允许）", () => {
  const guard = new TurnGuard({ maxTokenBudget: 0, maxTurns: 1000, maxConsecutiveFailedTurns: 1000 });
  guard.recordTurn({ tokensUsed: 999_999_999, hadToolCalls: false, allToolsFailed: false });
  assert.equal(guard.decideBeforeIteration().allow, true);
});

test("G3. maxConsecutiveFailedTurns=0：首轮即咨询连续失败线", () => {
  const guard = new TurnGuard({ maxConsecutiveFailedTurns: 0, maxTurns: 1000, maxTokenBudget: 0 });
  const d = guard.decideBeforeIteration();
  assert.equal(d.allow, false);
  assert.equal(d.action, "consult_user_consecutive_failures");
});

// ============================================================================
// H. replySession 恢复路径模拟（session.ts 护栏暂停后新指令放行闭环）
// ============================================================================

/**
 * 模拟 session.ts replySession 入口的护栏暂停消费逻辑（与生产代码同构）：
 * 护栏咨询暂停后（消息历史中存在 "[执行护栏]" system 消息），
 * 新指令（非 continue/权限回复）进入 turn 时清零轮数与连续失败计数，
 * 使新指令获得完整预算窗口；Token 预算保持不清零。
 */
function simulateReplySessionGuardConsume(
  guard: TurnGuard,
  hasGuardPauseMessage: boolean,
  isPermissionReply: boolean,
  isContinue: boolean
): void {
  if (
    !isPermissionReply &&
    !isContinue &&
    (guard.getState().turnsCompleted > 0 || guard.getState().consecutiveFailedTurns > 0) &&
    hasGuardPauseMessage
  ) {
    guard.acknowledgeAndContinue();
  }
}

test("H1. 护栏咨询暂停后新指令进入 turn → 计数清零恢复放行", () => {
  const guard = new TurnGuard({ maxConsecutiveFailedTurns: 3, maxTurns: 40, maxTokenBudget: 0 });
  // 连续 3 轮全失败 → 咨询暂停
  for (let i = 0; i < 3; i++) {
    guard.recordTurn({ tokensUsed: 1000, hadToolCalls: true, allToolsFailed: true });
  }
  assert.equal(guard.decideBeforeIteration().allow, false);
  // 用户回复新指令（消息历史含护栏消息）→ replySession 消费暂停态
  simulateReplySessionGuardConsume(guard, true, false, false);
  assert.equal(guard.decideBeforeIteration().allow, true, "新指令必须获得完整预算窗口");
});

test("H2. 无护栏暂停消息时新指令不清零（防止误放行仍在推进的任务计数）", () => {
  const guard = new TurnGuard({ maxConsecutiveFailedTurns: 10, maxTurns: 40, maxTokenBudget: 0 });
  guard.recordTurn({ tokensUsed: 1000, hadToolCalls: true, allToolsFailed: true });
  // 多轮消息（历史无护栏消息）
  simulateReplySessionGuardConsume(guard, false, false, false);
  assert.equal(guard.getState().turnsCompleted, 1, "非护栏暂停态不清零轮数计数");
});

test("H3. continue 指令不在 replySession 入口清零（由主循环 acknowledgeAndContinue 处理）", () => {
  const guard = new TurnGuard({ maxConsecutiveFailedTurns: 3, maxTurns: 40, maxTokenBudget: 0 });
  for (let i = 0; i < 3; i++) {
    guard.recordTurn({ tokensUsed: 1000, hadToolCalls: true, allToolsFailed: true });
  }
  assert.equal(guard.decideBeforeIteration().allow, false);
  // continue 走主循环路径放行，入口逻辑必须跳过
  simulateReplySessionGuardConsume(guard, true, false, true);
  assert.equal(guard.decideBeforeIteration().allow, false, "入口不清零；主循环收到 permissionPrompt=continue 后才放行");
});

test("H4. 新指令恢复后 Token 预算保持累计（硬兜底跨指令生效）", () => {
  const guard = new TurnGuard({ maxConsecutiveFailedTurns: 3, maxTurns: 40, maxTokenBudget: 20_000 });
  for (let i = 0; i < 3; i++) {
    guard.recordTurn({ tokensUsed: 3500, hadToolCalls: true, allToolsFailed: true });
  }
  // 当前 Token=10500 未触线 → 触发的是连续失败咨询（非 Token 终止）
  assert.equal(guard.decideBeforeIteration().action, "consult_user_consecutive_failures");
  // 恢复后用户新指令再烧 12000 → 累计 22500 超 20000 硬线
  simulateReplySessionGuardConsume(guard, true, false, false);
  guard.recordTurn({ tokensUsed: 12000, hadToolCalls: true, allToolsFailed: false });
  // 计数虽清零，但 Token 已 22500 > 20000 → 下一轮立即 Token 硬终止
  assert.equal(guard.getState().consecutiveFailedTurns, 0);
  assert.equal(guard.decideBeforeIteration().action, "terminate_token_budget", "Token 硬兜底必须跨指令保持");
});
