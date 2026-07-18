/**
 * EAG-P1 批次 5 单元测试：文档状态机 + 工作流校验
 *
 * 测试范围：
 * - T1. canTransition 合法状态转换判定
 *   - T1a. draft → reviewing = true
 *   - T1b. reviewing → approved = true
 *   - T1c. reviewing → rejected = true
 *   - T1d. rejected → reviewing = true
 * - T2. canTransition 非法状态转换判定
 *   - T2a. draft → approved = false（跳过 reviewing）
 *   - T2b. approved → reviewing = false（终态不可回退）
 *   - T2c. approved → rejected = false（终态不可回退）
 *   - T2d. rejected → approved = false（跳过 reviewing）
 * - T3. transition 状态转换正确性
 *   - T3a. draft → reviewing 返回新对象（state/version/updatedAt 更新）
 *   - T3b. 不修改原对象（不可变优先）
 *   - T3c. 返回对象已冻结
 *   - T3d. version 递增
 *   - T3e. 非法转换抛 DocumentStateMachineError
 * - T4. isApproved 门禁判定
 *   - T4a. approved 状态返回 true
 *   - T4b. draft 状态返回 false
 *   - T4c. reviewing 状态返回 false
 *   - T4d. rejected 状态返回 false
 * - T5. validateWorkflow 工作流校验（SEED-10 落地）
 *   - T5a. constitution + spec 均 approved → canStartCoding=true
 *   - T5b. spec 未 approved → canStartCoding=false（SEED-10）
 *   - T5c. spec 缺失 → canStartCoding=false
 *   - T5d. constitution 未 approved → canStartCoding=false
 *   - T5e. missingApprovals 含 spec
 *   - T5f. 返回结果已冻结
 * - T6. createInitialDocument 工厂函数
 *   - T6a. 默认状态为 draft
 *   - T6b. 默认版本为 1
 *   - T6c. 路径使用 DOCUMENT_PATHS
 *   - T6d. 返回对象已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实 DocumentStateMachine
 *
 * @module core/tests/eag-doc-driven-state-machine
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DocumentStateMachine,
  DocumentStateMachineError,
  createInitialDocument,
} from "../eag/doc-driven/document-state-machine";
import { DOCUMENT_PATHS } from "../eag/doc-driven/types";
import type { EagDocument } from "../eag/doc-driven/types";

// ============================================================================
// 辅助函数：构造测试用文档
// ============================================================================

/**
 * 构造测试用文档（指定类型与状态）
 *
 * @param type 文档类型
 * @param state 文档状态
 * @param content 文档内容（可选，默认 "# test"）
 * @returns EagDocument 对象
 */
function createTestDocument(
  type: EagDocument["type"],
  state: EagDocument["state"],
  content: string = "# test"
): EagDocument {
  return {
    type,
    path: DOCUMENT_PATHS[type],
    state,
    content,
    version: 1,
    createdAt: "2026-07-18T10:00:00.000Z",
    updatedAt: "2026-07-18T10:00:00.000Z",
  };
}

// ============================================================================
// T1. canTransition 合法状态转换判定
// ============================================================================

test("T1a. canTransition draft → reviewing = true", () => {
  const sm = new DocumentStateMachine();
  assert.equal(sm.canTransition("draft", "reviewing"), true);
});

test("T1b. canTransition reviewing → approved = true", () => {
  const sm = new DocumentStateMachine();
  assert.equal(sm.canTransition("reviewing", "approved"), true);
});

test("T1c. canTransition reviewing → rejected = true", () => {
  const sm = new DocumentStateMachine();
  assert.equal(sm.canTransition("reviewing", "rejected"), true);
});

test("T1d. canTransition rejected → reviewing = true", () => {
  const sm = new DocumentStateMachine();
  assert.equal(sm.canTransition("rejected", "reviewing"), true);
});

// ============================================================================
// T2. canTransition 非法状态转换判定
// ============================================================================

test("T2a. canTransition draft → approved = false（跳过 reviewing）", () => {
  const sm = new DocumentStateMachine();
  assert.equal(sm.canTransition("draft", "approved"), false);
});

test("T2b. canTransition approved → reviewing = false（终态不可回退）", () => {
  const sm = new DocumentStateMachine();
  assert.equal(sm.canTransition("approved", "reviewing"), false);
});

test("T2c. canTransition approved → rejected = false（终态不可回退）", () => {
  const sm = new DocumentStateMachine();
  assert.equal(sm.canTransition("approved", "rejected"), false);
});

test("T2d. canTransition rejected → approved = false（跳过 reviewing）", () => {
  const sm = new DocumentStateMachine();
  assert.equal(sm.canTransition("rejected", "approved"), false);
});

// ============================================================================
// T3. transition 状态转换正确性
// ============================================================================

test("T3a. transition draft → reviewing 返回新对象（state/version/updatedAt 更新）", () => {
  const sm = new DocumentStateMachine();
  const draft = createTestDocument("spec", "draft");
  const reviewing = sm.transition(draft, "reviewing");

  assert.equal(reviewing.state, "reviewing");
  assert.equal(reviewing.version, draft.version + 1);
  assert.notEqual(reviewing.updatedAt, draft.updatedAt);
  // 其他字段保持不变
  assert.equal(reviewing.type, draft.type);
  assert.equal(reviewing.path, draft.path);
  assert.equal(reviewing.content, draft.content);
  assert.equal(reviewing.createdAt, draft.createdAt);
});

test("T3b. transition 不修改原对象（不可变优先）", () => {
  const sm = new DocumentStateMachine();
  const draft = createTestDocument("spec", "draft");
  const originalState = draft.state;
  const originalVersion = draft.version;
  sm.transition(draft, "reviewing");

  // 原对象保持不变
  assert.equal(draft.state, originalState);
  assert.equal(draft.version, originalVersion);
});

test("T3c. transition 返回对象已冻结", () => {
  const sm = new DocumentStateMachine();
  const draft = createTestDocument("spec", "draft");
  const reviewing = sm.transition(draft, "reviewing");
  assert.equal(Object.isFrozen(reviewing), true);
});

test("T3d. transition 多次调用 version 持续递增", () => {
  const sm = new DocumentStateMachine();
  const draft = createTestDocument("spec", "draft");
  const reviewing = sm.transition(draft, "reviewing");
  const approved = sm.transition(reviewing, "approved");

  assert.equal(reviewing.version, 2);
  assert.equal(approved.version, 3);
  assert.equal(approved.state, "approved");
});

test("T3e. transition 非法转换抛 DocumentStateMachineError", () => {
  const sm = new DocumentStateMachine();
  const draft = createTestDocument("spec", "draft");

  assert.throws(
    () => sm.transition(draft, "approved"),
    (err: unknown) => {
      assert.ok(err instanceof DocumentStateMachineError);
      assert.equal((err as DocumentStateMachineError).fromState, "draft");
      assert.equal((err as DocumentStateMachineError).toState, "approved");
      return true;
    }
  );
});

// ============================================================================
// T4. isApproved 门禁判定
// ============================================================================

test("T4a. isApproved approved 状态返回 true", () => {
  const sm = new DocumentStateMachine();
  const doc = createTestDocument("spec", "approved");
  assert.equal(sm.isApproved(doc), true);
});

test("T4b. isApproved draft 状态返回 false", () => {
  const sm = new DocumentStateMachine();
  const doc = createTestDocument("spec", "draft");
  assert.equal(sm.isApproved(doc), false);
});

test("T4c. isApproved reviewing 状态返回 false", () => {
  const sm = new DocumentStateMachine();
  const doc = createTestDocument("spec", "reviewing");
  assert.equal(sm.isApproved(doc), false);
});

test("T4d. isApproved rejected 状态返回 false", () => {
  const sm = new DocumentStateMachine();
  const doc = createTestDocument("spec", "rejected");
  assert.equal(sm.isApproved(doc), false);
});

// ============================================================================
// T5. validateWorkflow 工作流校验（SEED-10 落地）
// ============================================================================

test("T5a. validateWorkflow constitution + spec 均 approved → canStartCoding=true", () => {
  const sm = new DocumentStateMachine();
  const constitution = createTestDocument("constitution", "approved");
  const spec = createTestDocument("spec", "approved");
  const result = sm.validateWorkflow([constitution, spec]);

  assert.equal(result.canStartCoding, true);
  assert.equal(result.missingApprovals.length, 0);
  assert.ok(result.reason.includes("通过"));
});

test("T5b. validateWorkflow spec 未 approved → canStartCoding=false（SEED-10）", () => {
  const sm = new DocumentStateMachine();
  const constitution = createTestDocument("constitution", "approved");
  const spec = createTestDocument("spec", "draft");
  const result = sm.validateWorkflow([constitution, spec]);

  assert.equal(result.canStartCoding, false);
  assert.ok(result.missingApprovals.includes("spec"));
  assert.ok(result.reason.includes("SEED-10"));
});

test("T5c. validateWorkflow spec 缺失 → canStartCoding=false", () => {
  const sm = new DocumentStateMachine();
  const constitution = createTestDocument("constitution", "approved");
  const result = sm.validateWorkflow([constitution]);

  assert.equal(result.canStartCoding, false);
  assert.ok(result.missingApprovals.includes("spec"));
});

test("T5d. validateWorkflow constitution 未 approved → canStartCoding=false", () => {
  const sm = new DocumentStateMachine();
  const constitution = createTestDocument("constitution", "reviewing");
  const spec = createTestDocument("spec", "approved");
  const result = sm.validateWorkflow([constitution, spec]);

  assert.equal(result.canStartCoding, false);
  assert.ok(result.missingApprovals.includes("constitution"));
});

test("T5e. validateWorkflow reason 包含未批准文档类型", () => {
  const sm = new DocumentStateMachine();
  const result = sm.validateWorkflow([]);
  // constitution 与 spec 均缺失
  assert.ok(result.reason.includes("constitution"));
  assert.ok(result.reason.includes("spec"));
});

test("T5f. validateWorkflow 返回结果已冻结", () => {
  const sm = new DocumentStateMachine();
  const result = sm.validateWorkflow([]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.missingApprovals), true);
});

// ============================================================================
// T6. createInitialDocument 工厂函数
// ============================================================================

test("T6a. createInitialDocument 默认状态为 draft", () => {
  const doc = createInitialDocument("spec", "# spec content");
  assert.equal(doc.state, "draft");
});

test("T6b. createInitialDocument 默认版本为 1", () => {
  const doc = createInitialDocument("spec", "# spec content");
  assert.equal(doc.version, 1);
});

test("T6c. createInitialDocument 路径使用 DOCUMENT_PATHS", () => {
  const doc = createInitialDocument("constitution", "# constitution");
  assert.equal(doc.path, DOCUMENT_PATHS.constitution);
});

test("T6d. createInitialDocument 返回对象已冻结", () => {
  const doc = createInitialDocument("spec", "# spec");
  assert.equal(Object.isFrozen(doc), true);
});

test("T6e. createInitialDocument 接受自定义路径映射", () => {
  const customPaths = {
    constitution: "custom/CONSTITUTION.md",
    spec: "custom/spec.md",
    plan: "custom/plan.md",
    tasks: "custom/tasks.md",
  } as const;
  const doc = createInitialDocument("spec", "# spec", customPaths);
  assert.equal(doc.path, "custom/spec.md");
});
