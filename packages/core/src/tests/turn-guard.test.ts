/**
 * 需求123/124 单元测试：TurnGuard 普通会话循环护栏
 *
 * 测试范围：
 * - A. 默认配置（DEFAULT_TURN_GUARD_CONFIG）与构造覆盖/冻结
 * - B. decideBeforeIteration() 判定优先级（模型死循环硬终止 > 连续失败咨询 > 轮数咨询）
 * - C. recordTurn() 状态更新（轮数递增 / Token 累计观测 / 连续失败计数与清零）
 * - D. acknowledgeAndContinue() 咨询-确认闭环（轮数/连续失败清零、Token 保留观测）
 * - E. 需求123 场景还原（40 轮未解决 → consult_user_max_turns，用户确认后继续）
 * - F. 需求124 场景还原（连续 3 轮工具全失败 → 咨询用户）
 * - G. 边界条件（maxTurns=0 / Token 配额移除后大消耗不终止 / 负 Token 钳制）
 * - H. replySession 恢复路径模拟（session.ts 护栏暂停后新指令放行闭环）
 * - J. 模型循环检测（2026-10-19 新增）
 *
 * 2026-10-19 需求变更：Token 配额硬终止线（terminate_token_budget / maxTokenBudget）
 * 已移除——上下文压力由"自动压缩 + 新任务切新上下文"策略接管（session.ts），
 * 本文件相应用例改为验证"任何 Token 消耗都不再触发终止"。
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 TurnGuard 实例
 * - 每个测试用例独立构造 TurnGuard，无共享可变状态
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

test("A3. Token 配额已移除：默认配置不再包含 maxTokenBudget 字段", () => {
  assert.equal(
    "maxTokenBudget" in DEFAULT_TURN_GUARD_CONFIG,
    false,
    "2026-10-19 需求变更：Token 配额硬终止线移除，配置不得残留 maxTokenBudget"
  );
});

test("A4. 构造缺省回落默认配置且冻结不可改", () => {
  const guard = new TurnGuard();
  const config = guard.getConfig();
  assert.equal(config.maxTurns, DEFAULT_TURN_GUARD_CONFIG.maxTurns);
  assert.equal(config.maxConsecutiveFailedTurns, DEFAULT_TURN_GUARD_CONFIG.maxConsecutiveFailedTurns);
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

test("B2. Token 配额移除后：大量 Token 消耗不再触发任何终止（由自动压缩接管）", () => {
  const guard = new TurnGuard({ maxTurns: 100, maxConsecutiveFailedTurns: 100 });
  guard.recordTurn({ tokensUsed: 2_000_000, hadToolCalls: false, allToolsFailed: false });
  const decision = guard.decideBeforeIteration();
  assert.equal(decision.allow, true, "Token 消耗不再终止会话——上下文压力由自动压缩/新任务切新上下文接管");
});

test("B3. 模型死循环与连续失败同时满足时，死循环硬终止优先于连续失败咨询", () => {
  const guard = new TurnGuard({ maxConsecutiveFailedTurns: 2, maxRepeatedToolCalls: 3 });
  for (let i = 0; i < 3; i++) {
    guard.recordTurn({ tokensUsed: 50, hadToolCalls: true, allToolsFailed: true });
    guard.recordToolCalls([{ name: "bash", arguments: { cmd: "retry" } }]);
  }
  const decision = guard.decideBeforeIteration();
  assert.equal(decision.allow, false);
  assert.equal(decision.action, "terminate_model_loop", "死循环硬终止优先于连续失败咨询线");
});

test("B4. 连续失败触达上限 → consult_user_consecutive_failures", () => {
  const guard = new TurnGuard({ maxConsecutiveFailedTurns: 3, maxTurns: 100 });
  for (let i = 0; i < 3; i++) {
    guard.recordTurn({ tokensUsed: 1, hadToolCalls: true, allToolsFailed: true });
  }
  const decision = guard.decideBeforeIteration();
  assert.equal(decision.allow, false);
  assert.equal(decision.action, "consult_user_consecutive_failures");
  assert.match(decision.reason, /连续 3 轮工具调用全部失败/);
});

test("B5. 轮数触达上限 → consult_user_max_turns", () => {
  const guard = new TurnGuard({ maxTurns: 5, maxConsecutiveFailedTurns: 100 });
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

test("C5. 负 Token 输入钳制为 0（防脏数据使观测值倒扣）", () => {
  const guard = new TurnGuard();
  guard.recordTurn({ tokensUsed: -500, hadToolCalls: false, allToolsFailed: false });
  assert.equal(guard.getState().tokensConsumed, 0);
});

// ============================================================================
// D. acknowledgeAndContinue() 咨询-确认闭环
// ============================================================================

test("D1. 确认继续清零轮数与连续失败，Token 累计保留作观测", () => {
  const guard = new TurnGuard({ maxTurns: 5, maxConsecutiveFailedTurns: 2 });
  guard.recordTurn({ tokensUsed: 300, hadToolCalls: true, allToolsFailed: true });
  guard.recordTurn({ tokensUsed: 300, hadToolCalls: true, allToolsFailed: true });
  // 触达连续失败线
  assert.equal(guard.decideBeforeIteration().action, "consult_user_consecutive_failures");
  // 用户确认继续
  guard.acknowledgeAndContinue();
  const state = guard.getState();
  assert.equal(state.turnsCompleted, 0);
  assert.equal(state.consecutiveFailedTurns, 0);
  assert.equal(state.tokensConsumed, 600, "Token 累计仅作观测保留，不参与判定");
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

// ============================================================================
// G. 边界条件
// ============================================================================

test("G1. maxTurns=0：首轮即咨询（上限设为 0 表示立即需要用户确认）", () => {
  const guard = new TurnGuard({ maxTurns: 0, maxConsecutiveFailedTurns: 100 });
  const d = guard.decideBeforeIteration();
  assert.equal(d.allow, false);
  assert.equal(d.action, "consult_user_max_turns");
});

test("G2. Token 配额移除后：任何 Token 累计都允许（原 maxTokenBudget=0 语义已成为唯一行为）", () => {
  const guard = new TurnGuard({ maxTurns: 1000, maxConsecutiveFailedTurns: 1000 });
  guard.recordTurn({ tokensUsed: 999_999_999, hadToolCalls: false, allToolsFailed: false });
  assert.equal(guard.decideBeforeIteration().allow, true);
});

test("G3. maxConsecutiveFailedTurns=0：首轮即咨询连续失败线", () => {
  const guard = new TurnGuard({ maxConsecutiveFailedTurns: 0, maxTurns: 1000 });
  const d = guard.decideBeforeIteration();
  assert.equal(d.allow, false);
  assert.equal(d.action, "consult_user_consecutive_failures");
});

// ============================================================================
// H. replySession 恢复路径模拟（session.ts 护栏暂停后新指令放行闭环）
// ============================================================================

/**
 * 模拟 session.ts replySession 入口的护栏暂停消费逻辑（与生产代码同构）：
 * 暂停态判定采用会话状态门控（架构审查缺陷1修复）——
 * 护栏咨询暂停时主循环把会话置为 "waiting_for_user"，
 * replySession 在 updateSessionEntry 覆盖 status 之前捕获该旧状态；
 * 新指令（非 continue/权限回复）在暂停态下进入 turn 时清零轮数与连续失败计数，
 * 使新指令获得完整预算窗口。
 *
 * 注意：此前版本以"全历史是否存在 [执行护栏] 消息"判定暂停态，
 * 导致曾触发过护栏的长会话中任何普通新指令都会误清零计数——已废弃。
 */
function simulateReplySessionGuardConsume(
  guard: TurnGuard,
  isWaitingForUser: boolean,
  isPermissionReply: boolean,
  isContinue: boolean
): void {
  if (
    !isPermissionReply &&
    !isContinue &&
    isWaitingForUser &&
    (guard.getState().turnsCompleted > 0 || guard.getState().consecutiveFailedTurns > 0)
  ) {
    guard.acknowledgeAndContinue();
  }
}

test("H1. 护栏咨询暂停后新指令进入 turn → 计数清零恢复放行", () => {
  const guard = new TurnGuard({ maxConsecutiveFailedTurns: 3, maxTurns: 40 });
  // 连续 3 轮全失败 → 咨询暂停
  for (let i = 0; i < 3; i++) {
    guard.recordTurn({ tokensUsed: 1000, hadToolCalls: true, allToolsFailed: true });
  }
  assert.equal(guard.decideBeforeIteration().allow, false);
  // 用户回复新指令（会话处于 waiting_for_user 暂停态）→ replySession 消费暂停态
  simulateReplySessionGuardConsume(guard, true, false, false);
  assert.equal(guard.decideBeforeIteration().allow, true, "新指令必须获得完整预算窗口");
});

test("H2. 非 waiting_for_user 状态时新指令不清零（缺陷1回归：长会话误清零防护）", () => {
  const guard = new TurnGuard({ maxConsecutiveFailedTurns: 10, maxTurns: 40 });
  guard.recordTurn({ tokensUsed: 1000, hadToolCalls: true, allToolsFailed: true });
  // 会话未暂停（status 非 waiting_for_user，即使历史上曾触发过护栏消息）
  simulateReplySessionGuardConsume(guard, false, false, false);
  assert.equal(guard.getState().turnsCompleted, 1, "非护栏暂停态不清零轮数计数");
});

test("H3. continue 指令不在 replySession 入口清零（由主循环 acknowledgeAndContinue 处理）", () => {
  const guard = new TurnGuard({ maxConsecutiveFailedTurns: 3, maxTurns: 40 });
  for (let i = 0; i < 3; i++) {
    guard.recordTurn({ tokensUsed: 1000, hadToolCalls: true, allToolsFailed: true });
  }
  assert.equal(guard.decideBeforeIteration().allow, false);
  // continue 走主循环路径放行，入口逻辑必须跳过
  simulateReplySessionGuardConsume(guard, true, false, true);
  assert.equal(guard.decideBeforeIteration().allow, false, "入口不清零；主循环收到 permissionPrompt=continue 后才放行");
});

test("H4. 新指令恢复后连续失败重新从 0 累计（预算窗口语义回归）", () => {
  const guard = new TurnGuard({ maxConsecutiveFailedTurns: 3, maxTurns: 40 });
  for (let i = 0; i < 3; i++) {
    guard.recordTurn({ tokensUsed: 3500, hadToolCalls: true, allToolsFailed: true });
  }
  assert.equal(guard.decideBeforeIteration().action, "consult_user_consecutive_failures");
  // 恢复后新指令：计数清零，重新累计 2 轮仍允许
  simulateReplySessionGuardConsume(guard, true, false, false);
  assert.equal(guard.getState().consecutiveFailedTurns, 0);
  guard.recordTurn({ tokensUsed: 3500, hadToolCalls: true, allToolsFailed: true });
  guard.recordTurn({ tokensUsed: 3500, hadToolCalls: true, allToolsFailed: true });
  assert.equal(guard.decideBeforeIteration().allow, true, "恢复后未重新触线，允许执行");
});

// ============================================================================
// J. 模型循环检测（2026-10-19 新增）
// ============================================================================

test("J1. 同一工具 + 相同参数连续 maxRepeatedToolCalls 次 → terminate_model_loop", () => {
  const guard = new TurnGuard({
    maxTurns: 100,
    maxConsecutiveFailedTurns: 100,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
  });
  const sameArgs = { path: "/etc/passwd", recursive: false };
  // 连续 3 次相同工具 + 相同参数
  for (let i = 0; i < 3; i++) {
    guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: true });
    guard.recordToolCalls([{ name: "bash", arguments: sameArgs }]);
  }
  const decision = guard.decideBeforeIteration();
  assert.equal(decision.allow, false);
  assert.equal(decision.action, "terminate_model_loop");
  assert.match(decision.reason, /死循环/);
  assert.match(decision.reason, /bash/);
});

test("J2. 不同工具 → 不触发循环检测", () => {
  const guard = new TurnGuard({
    maxTurns: 100,
    maxConsecutiveFailedTurns: 100,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
  });
  // 3 次不同工具
  guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: true });
  guard.recordToolCalls([{ name: "bash", arguments: { cmd: "ls" } }]);
  guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: true });
  guard.recordToolCalls([{ name: "read_file", arguments: { path: "a.txt" } }]);
  guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: true });
  guard.recordToolCalls([{ name: "bash", arguments: { cmd: "cat" } }]);
  const decision = guard.decideBeforeIteration();
  assert.equal(decision.allow, true, "不同工具不应触发循环检测");
});

test("J3. 同一工具但不同参数 → 不触发循环检测", () => {
  const guard = new TurnGuard({
    maxTurns: 100,
    maxConsecutiveFailedTurns: 100,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
  });
  // 3 次同工具但不同参数
  guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: true });
  guard.recordToolCalls([{ name: "bash", arguments: { cmd: "ls /a" } }]);
  guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: true });
  guard.recordToolCalls([{ name: "bash", arguments: { cmd: "ls /b" } }]);
  guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: true });
  guard.recordToolCalls([{ name: "bash", arguments: { cmd: "ls /c" } }]);
  const decision = guard.decideBeforeIteration();
  assert.equal(decision.allow, true, "同工具但不同参数不应触发循环检测");
});

test("J4. maxRepeatedToolCalls=0 → 禁用循环检测", () => {
  const guard = new TurnGuard({
    maxTurns: 100,
    maxConsecutiveFailedTurns: 100,
    maxRepeatedToolCalls: 0,
  });
  // 5 次相同工具（历史超限也不触发）
  for (let i = 0; i < 5; i++) {
    guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: true });
    guard.recordToolCalls([{ name: "bash", arguments: { cmd: "ls" } }]);
  }
  assert.equal(guard.decideBeforeIteration().allow, true, "maxRepeatedToolCalls=0 时禁用检测");
});

test("J5. 默认配置 maxRepeatedToolCalls=3 自动生效", () => {
  const guard = new TurnGuard({ maxTurns: 100, maxConsecutiveFailedTurns: 100 });
  assert.equal(guard.getConfig().maxRepeatedToolCalls, 3);
  assert.equal(guard.getConfig().trackedToolCallHistory, 5);
  // 连续 3 次相同 → 触发
  for (let i = 0; i < 3; i++) {
    guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: false });
    guard.recordToolCalls([{ name: "bash", arguments: { cmd: "retry" } }]);
  }
  assert.equal(guard.decideBeforeIteration().action, "terminate_model_loop");
});

test("J6. 混合轮：不同轮交替 → 不触发循环检测", () => {
  const guard = new TurnGuard({
    maxTurns: 100,
    maxConsecutiveFailedTurns: 100,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
  });
  // A B A B A：尾部是 A，需要 3 个连续 A，不满足
  guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: false });
  guard.recordToolCalls([{ name: "bash", arguments: { cmd: "A" } }]);
  guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: false });
  guard.recordToolCalls([{ name: "bash", arguments: { cmd: "B" } }]);
  guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: false });
  guard.recordToolCalls([{ name: "bash", arguments: { cmd: "A" } }]);
  guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: false });
  guard.recordToolCalls([{ name: "bash", arguments: { cmd: "B" } }]);
  guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: false });
  guard.recordToolCalls([{ name: "bash", arguments: { cmd: "A" } }]);
  assert.equal(guard.decideBeforeIteration().allow, true, "交替序列不应触发循环检测");
});

test("J7. 多工具轮：一轮内多个 tool call，循环检测跟踪所有", () => {
  const guard = new TurnGuard({
    maxTurns: 100,
    maxConsecutiveFailedTurns: 100,
    maxRepeatedToolCalls: 3,
    trackedToolCallHistory: 5,
  });
  // 每轮 2 个相同工具 → 连续 3 次（跨轮）
  guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: false });
  guard.recordToolCalls([
    { name: "bash", arguments: { cmd: "same" } },
    { name: "bash", arguments: { cmd: "same" } },
  ]);
  // 再 1 轮 1 个相同 → 总 3 个连续
  guard.recordTurn({ tokensUsed: 100, hadToolCalls: true, allToolsFailed: false });
  guard.recordToolCalls([{ name: "bash", arguments: { cmd: "same" } }]);
  assert.equal(guard.decideBeforeIteration().allow, false);
  assert.equal(guard.decideBeforeIteration().action, "terminate_model_loop");
});
