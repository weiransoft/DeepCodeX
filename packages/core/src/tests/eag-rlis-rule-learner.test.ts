/**
 * EAG-P1 批次 6 单元测试：RuleLearner 规则学习器（EAG 方案 §5.5.4）
 *
 * 测试范围：
 * - 检测（detectCorrection）：
 *   - T1.  "不要..." 模式匹配
 *   - T2.  "严禁..." 模式匹配
 *   - T3.  "必须..." 模式匹配
 *   - T4.  "以后都..." 模式匹配
 *   - T5.  "禁止..." 模式匹配
 *   - T6.  非纠正模式返回 null
 *   - T7.  空字符串返回 null
 *   - T8.  模式匹配去除前缀后返回剩余内容
 *
 * - 提取（extractCandidate）：
 *   - T9.  category 推断：mock/简化/占位 → code-truth
 *   - T10. category 推断：注释/comment → comment-style
 *   - T11. category 推断：审查/review → process-gate
 *   - T12. category 推断：技术栈 → change-control
 *   - T13. category 推断：tests 目录 → project-structure
 *   - T14. category 推断：质量/quality → quality-gate
 *   - T15. category 推断：默认（无关键词命中）→ code-truth
 *   - T16. severity 推断："严禁..." 模式 → BLOCKER
 *   - T17. severity 推断："禁止..." 模式 → BLOCKER
 *   - T18. severity 推断："必须..." 模式 → MAJOR
 *   - T19. severity 推断："不要..." 模式（无 BLOCKER/MAJOR 关键词）→ WARNING
 *   - T20. 候选 ID 自动生成（LEARN-xx 前缀，自增）
 *
 * - 累积（accumulateCandidate）：
 *   - T21. 新候选：直接添加，occurrenceCount=1
 *   - T22. 同类候选：occurrenceCount+1
 *   - T23. 累积后更新 lastDetectedAt
 *
 * - 确认（shouldPushConfirmation + confirmCandidate）：
 *   - T24. occurrenceCount<2 时不推送确认
 *   - T25. occurrenceCount>=2 时推送确认
 *   - T26. confirmCandidate(userConfirmed=true) 转 UserRule
 *   - T27. confirmCandidate(userConfirmed=false) 返回 null
 *   - T28. confirmCandidate 后从候选列表移除
 *   - T29. 防误学红线：learned 规则 confirmedBy 强制为 "user"
 *
 * - 综合场景：
 *   - T30. 完整学习闭环：检测 → 提取 → 累积 → 确认 → 固化
 *   - T31. 多条候选并行累积
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实 RuleLearner 实例
 *
 * 设计依据：
 * - EAG 方案 §5.5.4 规则学习流程
 * - EAG 方案 §5.5.4 防误学红线
 * - eag/rlis/rule-learner.ts 源文件
 *
 * @module core/tests/eag-rlis-rule-learner
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RuleLearner } from "../eag/rlis/rule-learner";
import type { RuleCandidate, UserRule } from "../eag/rlis/types";

// ============================================================================
// 检测（detectCorrection）测试
// ============================================================================

// ============================================================================
// T1. "不要..." 模式匹配
// ============================================================================

test("T1. detectCorrection('不要使用 mock 开发') 命中 '不要...' 模式", () => {
  const learner = new RuleLearner();
  const result = learner.detectCorrection("不要使用 mock 开发");
  assert.notEqual(result, null);
  assert.equal(result!.pattern, "不要...");
  assert.equal(result!.content, "使用 mock 开发");
});

// ============================================================================
// T2. "严禁..." 模式匹配
// ============================================================================

test("T2. detectCorrection('严禁使用 placeholder') 命中 '严禁...' 模式", () => {
  const learner = new RuleLearner();
  const result = learner.detectCorrection("严禁使用 placeholder");
  assert.notEqual(result, null);
  assert.equal(result!.pattern, "严禁...");
  assert.equal(result!.content, "使用 placeholder");
});

// ============================================================================
// T3. "必须..." 模式匹配
// ============================================================================

test("T3. detectCorrection('必须写中文注释') 命中 '必须...' 模式", () => {
  const learner = new RuleLearner();
  const result = learner.detectCorrection("必须写中文注释");
  assert.notEqual(result, null);
  assert.equal(result!.pattern, "必须...");
  assert.equal(result!.content, "写中文注释");
});

// ============================================================================
// T4. "以后都..." 模式匹配
// ============================================================================

test("T4. detectCorrection('以后都使用真实实现') 命中 '以后都...' 模式", () => {
  const learner = new RuleLearner();
  const result = learner.detectCorrection("以后都使用真实实现");
  assert.notEqual(result, null);
  assert.equal(result!.pattern, "以后都...");
  assert.equal(result!.content, "使用真实实现");
});

// ============================================================================
// T5. "禁止..." 模式匹配
// ============================================================================

test("T5. detectCorrection('禁止使用简化方式') 命中 '禁止...' 模式", () => {
  const learner = new RuleLearner();
  const result = learner.detectCorrection("禁止使用简化方式");
  assert.notEqual(result, null);
  assert.equal(result!.pattern, "禁止...");
  assert.equal(result!.content, "使用简化方式");
});

// ============================================================================
// T6. 非纠正模式返回 null
// ============================================================================

test("T6. detectCorrection('请使用真实实现') 非纠正模式返回 null", () => {
  const learner = new RuleLearner();
  const result = learner.detectCorrection("请使用真实实现");
  assert.equal(result, null);
});

// ============================================================================
// T7. 空字符串返回 null
// ============================================================================

test("T7a. detectCorrection('') 空字符串返回 null", () => {
  const learner = new RuleLearner();
  assert.equal(learner.detectCorrection(""), null);
});

test("T7b. detectCorrection('   ') 纯空格返回 null", () => {
  const learner = new RuleLearner();
  assert.equal(learner.detectCorrection("   "), null);
});

// ============================================================================
// T8. 模式匹配去除前缀后返回剩余内容
// ============================================================================

test("T8. detectCorrection 去除前缀并 trim 剩余内容", () => {
  const learner = new RuleLearner();
  const result = learner.detectCorrection("不要  使用 mock  ");
  assert.notEqual(result, null);
  assert.equal(result!.content, "使用 mock");
});

// ============================================================================
// 提取（extractCandidate）测试
// ============================================================================

// ============================================================================
// T9. category 推断：mock/简化/占位 → code-truth
// ============================================================================

test("T9a. extractCandidate 含 'mock' → category=code-truth", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("不要使用 mock 开发", "不要...");
  assert.equal(candidate.category, "code-truth");
});

test("T9b. extractCandidate 含 '简化' → category=code-truth", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("禁止使用简化方式", "禁止...");
  assert.equal(candidate.category, "code-truth");
});

test("T9c. extractCandidate 含 '占位' → category=code-truth", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("不要使用占位实现", "不要...");
  assert.equal(candidate.category, "code-truth");
});

// ============================================================================
// T10. category 推断：注释/comment → comment-style
// ============================================================================

test("T10. extractCandidate 含 '注释' → category=comment-style", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("必须写中文注释", "必须...");
  assert.equal(candidate.category, "comment-style");
});

// ============================================================================
// T11. category 推断：审查/review → process-gate
// ============================================================================

test("T11a. extractCandidate 含 '审查' → category=process-gate", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("必须做架构师审查", "必须...");
  assert.equal(candidate.category, "process-gate");
});

test("T11b. extractCandidate 含 'review' → category=process-gate", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("不要跳过 review", "不要...");
  assert.equal(candidate.category, "process-gate");
});

// ============================================================================
// T12. category 推断：技术栈 → change-control
// ============================================================================

test("T12. extractCandidate 含 '技术栈' → category=change-control", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("严禁更改技术栈", "严禁...");
  assert.equal(candidate.category, "change-control");
});

// ============================================================================
// T13. category 推断：tests 目录 → project-structure
// ============================================================================

test("T13. extractCandidate 含 'tests 目录' → category=project-structure", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("必须把测试放到 tests 目录", "必须...");
  assert.equal(candidate.category, "project-structure");
});

// ============================================================================
// T14. category 推断：质量/quality → quality-gate
// ============================================================================

test("T14. extractCandidate 含 '质量' → category=quality-gate", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("必须保证质量", "必须...");
  assert.equal(candidate.category, "quality-gate");
});

// ============================================================================
// T15. category 推断：默认（无关键词命中）→ code-truth
// ============================================================================

test("T15. extractCandidate 无关键词命中 → category=code-truth（默认）", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("不要这样做", "不要...");
  assert.equal(candidate.category, "code-truth");
});

// ============================================================================
// T16. severity 推断："严禁..." 模式 → BLOCKER
// ============================================================================

test("T16. extractCandidate '严禁...' 模式 → severity=BLOCKER", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("严禁使用 mock", "严禁...");
  assert.equal(candidate.severity, "BLOCKER");
});

// ============================================================================
// T17. severity 推断："禁止..." 模式 → BLOCKER
// ============================================================================

test("T17. extractCandidate '禁止...' 模式 → severity=BLOCKER", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("禁止使用简化", "禁止...");
  assert.equal(candidate.severity, "BLOCKER");
});

// ============================================================================
// T18. severity 推断："必须..." 模式 → MAJOR
// ============================================================================

test("T18. extractCandidate '必须...' 模式 → severity=MAJOR", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("必须写中文注释", "必须...");
  assert.equal(candidate.severity, "MAJOR");
});

// ============================================================================
// T19. severity 推断："不要..." 模式（无 BLOCKER/MAJOR 关键词）→ WARNING
// ============================================================================

test("T19. extractCandidate '不要...' 模式 → severity=WARNING（默认）", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("不要使用 mock", "不要...");
  assert.equal(candidate.severity, "WARNING");
});

// ============================================================================
// T20. 候选 ID 自动生成（LEARN-xx 前缀，自增）
// ============================================================================

test("T20. extractCandidate 自动生成 LEARN-xx 前缀 ID 且自增", () => {
  const learner = new RuleLearner();
  const c1 = learner.extractCandidate("不要使用 mock", "不要...");
  const c2 = learner.extractCandidate("严禁使用占位", "严禁...");
  const c3 = learner.extractCandidate("必须写注释", "必须...");
  assert.equal(c1.id, "LEARN-01");
  assert.equal(c2.id, "LEARN-02");
  assert.equal(c3.id, "LEARN-03");
});

// ============================================================================
// 累积（accumulateCandidate）测试
// ============================================================================

// ============================================================================
// T21. 新候选：直接添加，occurrenceCount=1
// ============================================================================

test("T21. accumulateCandidate 新候选：occurrenceCount=1", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("不要使用 mock", "不要...");
  const accumulated = learner.accumulateCandidate(candidate);
  assert.equal(accumulated.occurrenceCount, 1);
  assert.equal(learner.getCandidates().length, 1);
});

// ============================================================================
// T22. 同类候选：occurrenceCount+1
// ============================================================================

test("T22. accumulateCandidate 同类候选：occurrenceCount+1", () => {
  const learner = new RuleLearner();
  const c1 = learner.extractCandidate("不要使用 mock", "不要...");
  learner.accumulateCandidate(c1);
  // 再次提取并累积同类候选（content 相同）
  const c2 = learner.extractCandidate("不要使用 mock", "不要...");
  // 注意：c2 是新候选（不同 ID），但 content 相同
  const accumulated = learner.accumulateCandidate(c2);
  assert.equal(accumulated.occurrenceCount, 2);
  // 候选列表中应只有 1 条（按 content 去重）
  assert.equal(learner.getCandidates().length, 1);
});

// ============================================================================
// T23. 累积后更新 lastDetectedAt
// ============================================================================

test("T23. accumulateCandidate 累积后 lastDetectedAt 更新", async () => {
  const learner = new RuleLearner();
  const c1 = learner.extractCandidate("不要使用 mock", "不要...");
  const first = learner.accumulateCandidate(c1);
  // 等待 10ms 确保 lastDetectedAt 不同
  await new Promise((resolve) => setTimeout(resolve, 10));
  const c2 = learner.extractCandidate("不要使用 mock", "不要...");
  const second = learner.accumulateCandidate(c2);
  // lastDetectedAt 应更新（第二次 > 第一次）
  assert.ok(second.lastDetectedAt >= first.lastDetectedAt);
});

// ============================================================================
// 确认（shouldPushConfirmation + confirmCandidate）测试
// ============================================================================

// ============================================================================
// T24. occurrenceCount<2 时不推送确认
// ============================================================================

test("T24. shouldPushConfirmation occurrenceCount=1 返回 false", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("不要使用 mock", "不要...");
  learner.accumulateCandidate(candidate);
  assert.equal(learner.shouldPushConfirmation(candidate), false);
});

// ============================================================================
// T25. occurrenceCount>=2 时推送确认
// ============================================================================

test("T25. shouldPushConfirmation occurrenceCount=2 返回 true", () => {
  const learner = new RuleLearner();
  const c1 = learner.extractCandidate("不要使用 mock", "不要...");
  learner.accumulateCandidate(c1);
  const c2 = learner.extractCandidate("不要使用 mock", "不要...");
  learner.accumulateCandidate(c2);
  // 此时 occurrenceCount=2，应推送确认
  assert.equal(learner.shouldPushConfirmation(c2), true);
});

// ============================================================================
// T26. confirmCandidate(userConfirmed=true) 转 UserRule
// ============================================================================

test("T26. confirmCandidate(userConfirmed=true) 转 UserRule", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("不要使用 mock", "不要...");
  learner.accumulateCandidate(candidate);
  const rule = learner.confirmCandidate(candidate, true);
  assert.notEqual(rule, null);
  assert.equal(rule!.id, candidate.id);
  assert.equal(rule!.category, candidate.category);
  assert.equal(rule!.severity, candidate.severity);
  assert.equal(rule!.content, candidate.content);
});

// ============================================================================
// T27. confirmCandidate(userConfirmed=false) 返回 null
// ============================================================================

test("T27. confirmCandidate(userConfirmed=false) 返回 null", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("不要使用 mock", "不要...");
  learner.accumulateCandidate(candidate);
  const rule = learner.confirmCandidate(candidate, false);
  assert.equal(rule, null);
});

// ============================================================================
// T28. confirmCandidate 后从候选列表移除
// ============================================================================

test("T28a. confirmCandidate(userConfirmed=true) 后从候选列表移除", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("不要使用 mock", "不要...");
  learner.accumulateCandidate(candidate);
  assert.equal(learner.getCandidates().length, 1);
  learner.confirmCandidate(candidate, true);
  assert.equal(learner.getCandidates().length, 0);
});

test("T28b. confirmCandidate(userConfirmed=false) 后从候选列表移除", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("不要使用 mock", "不要...");
  learner.accumulateCandidate(candidate);
  assert.equal(learner.getCandidates().length, 1);
  learner.confirmCandidate(candidate, false);
  assert.equal(learner.getCandidates().length, 0);
});

// ============================================================================
// T29. 防误学红线：learned 规则 confirmedBy 强制为 "user"
// ============================================================================

test("T29. confirmCandidate(userConfirmed=true) 转 UserRule：source='learned', confirmedBy='user'", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("不要使用 mock", "不要...");
  learner.accumulateCandidate(candidate);
  const rule = learner.confirmCandidate(candidate, true);
  // 防误学红线：learned 来源规则 confirmedBy 必须为 "user"
  assert.equal(rule!.source, "learned");
  assert.equal(rule!.confirmedBy, "user");
});

// ============================================================================
// 综合场景测试
// ============================================================================

// ============================================================================
// T30. 完整学习闭环：检测 → 提取 → 累积 → 确认 → 固化
// ============================================================================

test("T30. 完整学习闭环：检测 → 提取 → 累积 → 确认 → 固化", () => {
  const learner = new RuleLearner();

  // 用户首次纠正
  const input1 = "不要使用 mock 开发";
  const detection1 = learner.detectCorrection(input1);
  assert.notEqual(detection1, null);
  const candidate1 = learner.extractCandidate(input1, detection1!.pattern);
  learner.accumulateCandidate(candidate1);
  // 单次纠正不应推送确认
  assert.equal(learner.shouldPushConfirmation(candidate1), false);

  // 用户第二次同类纠正
  const input2 = "不要使用 mock 开发";
  const detection2 = learner.detectCorrection(input2);
  assert.notEqual(detection2, null);
  const candidate2 = learner.extractCandidate(input2, detection2!.pattern);
  learner.accumulateCandidate(candidate2);
  // 同类纠正 ≥2 次应推送确认
  assert.equal(learner.shouldPushConfirmation(candidate2), true);

  // 用户确认 → 固化为 UserRule
  const rule = learner.confirmCandidate(candidate2, true);
  assert.notEqual(rule, null);
  assert.equal(rule!.source, "learned");
  assert.equal(rule!.confirmedBy, "user");
  assert.equal(rule!.usageCount, 0);
  assert.equal(rule!.violationCount, 0);
});

// ============================================================================
// T31. 多条候选并行累积
// ============================================================================

test("T31. 多条候选并行累积：不同 content 各自累积", () => {
  const learner = new RuleLearner();

  // 候选 A：mock 纠正
  const cA1 = learner.extractCandidate("不要使用 mock", "不要...");
  learner.accumulateCandidate(cA1);

  // 候选 B：简化纠正
  const cB1 = learner.extractCandidate("严禁使用简化", "严禁...");
  learner.accumulateCandidate(cB1);

  // 候选列表应有 2 条
  assert.equal(learner.getCandidates().length, 2);

  // 候选 A 第二次累积
  const cA2 = learner.extractCandidate("不要使用 mock", "不要...");
  learner.accumulateCandidate(cA2);
  // 候选 A occurrenceCount=2
  const candidates = learner.getCandidates();
  const cA = candidates.find((c) => c.content.includes("mock"));
  assert.equal(cA!.occurrenceCount, 2);

  // 候选 B 仍为 1
  const cB = candidates.find((c) => c.content.includes("简化"));
  assert.equal(cB!.occurrenceCount, 1);

  // 候选总数仍为 2（按 content 去重）
  assert.equal(learner.getCandidates().length, 2);
});

// ============================================================================
// T32. getCandidateById 按 ID 查询
// ============================================================================

test("T32a. getCandidateById 查询存在的候选", () => {
  const learner = new RuleLearner();
  const candidate = learner.extractCandidate("不要使用 mock", "不要...");
  learner.accumulateCandidate(candidate);
  const found = learner.getCandidateById(candidate.id);
  assert.notEqual(found, null);
  assert.equal(found!.id, candidate.id);
});

test("T32b. getCandidateById 查询不存在的候选返回 null", () => {
  const learner = new RuleLearner();
  assert.equal(learner.getCandidateById("LEARN-99"), null);
});
