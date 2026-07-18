/**
 * EAG-P1 批次 5 单元测试：文档驱动开发 Loop 数据模型
 *
 * 测试范围：
 * - T1. DocumentType 字面量联合完整性
 * - T2. DocumentState 字面量联合完整性
 * - T3. DOCUMENT_PATHS 常量映射正确性
 * - T4. EagDocument 接口字段完整性
 * - T5. FunctionalRequirement 接口字段完整性
 * - T6. TaskNode 接口字段完整性
 * - T7. TaskDag 接口字段完整性
 * - T8. CommitType 字面量联合完整性
 * - T9. GitProcessConfig 接口字段完整性
 * - T10. DEFAULT_GIT_PROCESS_CONFIG 默认值
 * - T11. createDefaultGitProcessConfig 默认配置
 * - T12. createDefaultGitProcessConfig 部分覆盖
 * - T13. createDefaultGitProcessConfig 冻结保证
 * - T14. createDefaultGitProcessConfig 非法 branchPrefix
 * - T15. createDefaultGitProcessConfig 非法 enableAutoPr
 * - T16. createDefaultGitProcessConfig 非法 snapshotPerTurn
 * - T17. ConstitutionInput 接口字段完整性
 * - T18. NonNegotiableItems 接口字段完整性
 * - T19. WorkflowValidationResult 接口字段完整性
 * - T20. 不可变保证：常量 Object.isFrozen
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 * - 测试用例独立、可重复
 *
 * @module core/tests/eag-doc-driven-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOCUMENT_TYPES,
  DOCUMENT_STATES,
  DOCUMENT_PATHS,
  COMMIT_TYPES,
  DEFAULT_GIT_PROCESS_CONFIG,
  createDefaultGitProcessConfig,
  GitProcessConfigError,
} from "../eag/doc-driven/types";
import type {
  DocumentType,
  DocumentState,
  EagDocument,
  FunctionalRequirement,
  TaskNode,
  TaskDag,
  CommitType,
  GitProcessConfig,
  ConstitutionInput,
  NonNegotiableItems,
  WorkflowValidationResult,
  RequirementPriority,
} from "../eag/doc-driven/types";

// ============================================================================
// T1. DocumentType 字面量联合完整性
// ============================================================================

test("T1a. DocumentType 包含 4 个合法值", () => {
  assert.equal(DOCUMENT_TYPES.length, 4);
});

test("T1b. DocumentType 含 constitution/spec/plan/tasks", () => {
  const expected: ReadonlyArray<DocumentType> = ["constitution", "spec", "plan", "tasks"];
  assert.deepEqual([...DOCUMENT_TYPES], [...expected]);
});

test("T1c. DOCUMENT_TYPES 常量已冻结", () => {
  assert.equal(Object.isFrozen(DOCUMENT_TYPES), true);
});

// ============================================================================
// T2. DocumentState 字面量联合完整性
// ============================================================================

test("T2a. DocumentState 包含 4 个合法值", () => {
  assert.equal(DOCUMENT_STATES.length, 4);
});

test("T2b. DocumentState 含 draft/reviewing/approved/rejected", () => {
  const expected: ReadonlyArray<DocumentState> = ["draft", "reviewing", "approved", "rejected"];
  assert.deepEqual([...DOCUMENT_STATES], [...expected]);
});

test("T2c. DOCUMENT_STATES 常量已冻结", () => {
  assert.equal(Object.isFrozen(DOCUMENT_STATES), true);
});

// ============================================================================
// T3. DOCUMENT_PATHS 常量映射正确性
// ============================================================================

test("T3a. DOCUMENT_PATHS constitution 路径", () => {
  assert.equal(DOCUMENT_PATHS.constitution, "docs/eag/CONSTITUTION.md");
});

test("T3b. DOCUMENT_PATHS spec 路径", () => {
  assert.equal(DOCUMENT_PATHS.spec, "docs/eag/spec.md");
});

test("T3c. DOCUMENT_PATHS plan 路径", () => {
  assert.equal(DOCUMENT_PATHS.plan, "docs/eag/plan.md");
});

test("T3d. DOCUMENT_PATHS tasks 路径", () => {
  assert.equal(DOCUMENT_PATHS.tasks, "docs/eag/tasks.md");
});

test("T3e. DOCUMENT_PATHS 常量已冻结", () => {
  assert.equal(Object.isFrozen(DOCUMENT_PATHS), true);
});

// ============================================================================
// T4. EagDocument 接口字段完整性
// ============================================================================

test("T4. EagDocument 接口字段完整性——构造完整对象", () => {
  const doc: EagDocument = {
    type: "spec",
    path: "docs/eag/spec.md",
    state: "approved",
    content: "# spec",
    version: 3,
    createdAt: "2026-07-18T10:00:00.000Z",
    updatedAt: "2026-07-18T15:30:00.000Z",
  };
  assert.equal(doc.type, "spec");
  assert.equal(doc.path, "docs/eag/spec.md");
  assert.equal(doc.state, "approved");
  assert.equal(doc.content, "# spec");
  assert.equal(doc.version, 3);
  assert.equal(doc.createdAt, "2026-07-18T10:00:00.000Z");
  assert.equal(doc.updatedAt, "2026-07-18T15:30:00.000Z");
});

// ============================================================================
// T5. FunctionalRequirement 接口字段完整性
// ============================================================================

test("T5. FunctionalRequirement 接口字段完整性", () => {
  const req: FunctionalRequirement = {
    id: "F-001",
    title: "用户登录",
    priority: "high",
    module: "UserAggregate",
    acceptanceCriteria: ["Given 用户已注册，When 输入正确凭证，Then 返回 JWT"],
  };
  assert.equal(req.id, "F-001");
  assert.equal(req.title, "用户登录");
  assert.equal(req.priority, "high");
  assert.equal(req.module, "UserAggregate");
  assert.equal(req.acceptanceCriteria.length, 1);
});

test("T5b. RequirementPriority 三级优先级", () => {
  const priorities: RequirementPriority[] = ["high", "medium", "low"];
  assert.equal(priorities.length, 3);
  assert.ok(priorities.includes("high"));
  assert.ok(priorities.includes("medium"));
  assert.ok(priorities.includes("low"));
});

// ============================================================================
// T6. TaskNode 接口字段完整性
// ============================================================================

test("T6. TaskNode 接口字段完整性", () => {
  const task: TaskNode = {
    id: "T-001",
    title: "UserAggregate 骨架",
    requirementId: "F-001",
    dependencies: [],
    fileCluster: "UserAggregate",
    acceptanceCommand: "npm test user-aggregate",
  };
  assert.equal(task.id, "T-001");
  assert.equal(task.title, "UserAggregate 骨架");
  assert.equal(task.requirementId, "F-001");
  assert.equal(task.dependencies.length, 0);
  assert.equal(task.fileCluster, "UserAggregate");
  assert.equal(task.acceptanceCommand, "npm test user-aggregate");
});

// ============================================================================
// T7. TaskDag 接口字段完整性
// ============================================================================

test("T7. TaskDag 接口字段完整性", () => {
  const dag: TaskDag = {
    nodes: [
      {
        id: "T-001",
        title: "骨架",
        requirementId: "F-001",
        dependencies: [],
        fileCluster: "UserAggregate",
        acceptanceCommand: "npm test",
      },
    ],
    topologicalOrder: ["T-001"],
  };
  assert.equal(dag.nodes.length, 1);
  assert.equal(dag.topologicalOrder.length, 1);
  assert.equal(dag.topologicalOrder[0], "T-001");
});

// ============================================================================
// T8. CommitType 字面量联合完整性
// ============================================================================

test("T8a. CommitType 包含 6 个合法值", () => {
  assert.equal(COMMIT_TYPES.length, 6);
});

test("T8b. CommitType 含 feat/fix/docs/chore/test/refactor", () => {
  const expected: ReadonlyArray<CommitType> = ["feat", "fix", "docs", "chore", "test", "refactor"];
  assert.deepEqual([...COMMIT_TYPES], [...expected]);
});

// ============================================================================
// T9. GitProcessConfig 接口字段完整性
// ============================================================================

test("T9. GitProcessConfig 接口字段完整性", () => {
  const config: GitProcessConfig = {
    branchPrefix: "feature/eag-",
    enableAutoPr: true,
    snapshotPerTurn: true,
  };
  assert.equal(config.branchPrefix, "feature/eag-");
  assert.equal(config.enableAutoPr, true);
  assert.equal(config.snapshotPerTurn, true);
});

// ============================================================================
// T10. DEFAULT_GIT_PROCESS_CONFIG 默认值
// ============================================================================

test("T10a. DEFAULT_GIT_PROCESS_CONFIG.branchPrefix 默认值", () => {
  assert.equal(DEFAULT_GIT_PROCESS_CONFIG.branchPrefix, "feature/eag-");
});

test("T10b. DEFAULT_GIT_PROCESS_CONFIG.enableAutoPr 默认值", () => {
  assert.equal(DEFAULT_GIT_PROCESS_CONFIG.enableAutoPr, true);
});

test("T10c. DEFAULT_GIT_PROCESS_CONFIG.snapshotPerTurn 默认值", () => {
  assert.equal(DEFAULT_GIT_PROCESS_CONFIG.snapshotPerTurn, true);
});

test("T10d. DEFAULT_GIT_PROCESS_CONFIG 常量已冻结", () => {
  assert.equal(Object.isFrozen(DEFAULT_GIT_PROCESS_CONFIG), true);
});

// ============================================================================
// T11. createDefaultGitProcessConfig 默认配置
// ============================================================================

test("T11. createDefaultGitProcessConfig 默认配置与 DEFAULT_GIT_PROCESS_CONFIG 一致", () => {
  const config = createDefaultGitProcessConfig();
  assert.equal(config.branchPrefix, DEFAULT_GIT_PROCESS_CONFIG.branchPrefix);
  assert.equal(config.enableAutoPr, DEFAULT_GIT_PROCESS_CONFIG.enableAutoPr);
  assert.equal(config.snapshotPerTurn, DEFAULT_GIT_PROCESS_CONFIG.snapshotPerTurn);
});

// ============================================================================
// T12. createDefaultGitProcessConfig 部分覆盖
// ============================================================================

test("T12. createDefaultGitProcessConfig 部分覆盖——仅覆盖 branchPrefix", () => {
  const config = createDefaultGitProcessConfig({ branchPrefix: "feature/custom-" });
  assert.equal(config.branchPrefix, "feature/custom-");
  // 未覆盖的字段使用默认值
  assert.equal(config.enableAutoPr, DEFAULT_GIT_PROCESS_CONFIG.enableAutoPr);
  assert.equal(config.snapshotPerTurn, DEFAULT_GIT_PROCESS_CONFIG.snapshotPerTurn);
});

// ============================================================================
// T13. createDefaultGitProcessConfig 冻结保证
// ============================================================================

test("T13. createDefaultGitProcessConfig 返回冻结对象", () => {
  const config = createDefaultGitProcessConfig();
  assert.equal(Object.isFrozen(config), true);
});

// ============================================================================
// T14. createDefaultGitProcessConfig 非法 branchPrefix
// ============================================================================

test("T14a. createDefaultGitProcessConfig 空字符串 branchPrefix 抛错", () => {
  assert.throws(
    () => createDefaultGitProcessConfig({ branchPrefix: "" }),
    (err: unknown) => {
      assert.ok(err instanceof GitProcessConfigError);
      assert.equal((err as GitProcessConfigError).field, "branchPrefix");
      return true;
    }
  );
});

test("T14b. createDefaultGitProcessConfig 空白 branchPrefix 抛错", () => {
  assert.throws(
    () => createDefaultGitProcessConfig({ branchPrefix: "   " }),
    (err: unknown) => err instanceof GitProcessConfigError
  );
});

// ============================================================================
// T15. createDefaultGitProcessConfig 非法 enableAutoPr
// ============================================================================

test("T15. createDefaultGitProcessConfig 非法 enableAutoPr 抛错", () => {
  // TypeScript 类型系统会拒绝非 boolean 值，但运行时仍需校验
  // 通过类型断言绕过编译期检查，模拟 LLM 自改配置场景
  assert.throws(
    () =>
      createDefaultGitProcessConfig({
        enableAutoPr: "true" as unknown as boolean,
      }),
    (err: unknown) => {
      assert.ok(err instanceof GitProcessConfigError);
      assert.equal((err as GitProcessConfigError).field, "enableAutoPr");
      return true;
    }
  );
});

// ============================================================================
// T16. createDefaultGitProcessConfig 非法 snapshotPerTurn
// ============================================================================

test("T16. createDefaultGitProcessConfig 非法 snapshotPerTurn 抛错", () => {
  assert.throws(
    () =>
      createDefaultGitProcessConfig({
        snapshotPerTurn: 1 as unknown as boolean,
      }),
    (err: unknown) => err instanceof GitProcessConfigError
  );
});

// ============================================================================
// T17. ConstitutionInput 接口字段完整性
// ============================================================================

test("T17. ConstitutionInput 接口字段完整性", () => {
  const input: ConstitutionInput = {
    vision: "构建企业级订单管理系统",
    techPrinciples: ["DDD 分层架构优先"],
    businessPrinciples: ["业务规则内聚到领域层"],
    qualityPrinciples: ["单元测试覆盖率 >= 80%"],
    nonNegotiableItems: {
      techStackLocks: ["TypeScript"],
      complianceRequirements: ["GDPR"],
      redlines: ["禁止使用 mock"],
    },
  };
  assert.equal(input.vision, "构建企业级订单管理系统");
  assert.equal(input.techPrinciples.length, 1);
  assert.equal(input.businessPrinciples.length, 1);
  assert.equal(input.qualityPrinciples.length, 1);
  assert.equal(input.nonNegotiableItems.techStackLocks.length, 1);
});

// ============================================================================
// T18. NonNegotiableItems 接口字段完整性
// ============================================================================

test("T18. NonNegotiableItems 接口字段完整性", () => {
  const items: NonNegotiableItems = {
    techStackLocks: ["TypeScript", "NestJS", "PostgreSQL"],
    complianceRequirements: ["GDPR", "等保三级"],
    redlines: ["禁止 mock", "禁止简化"],
  };
  assert.equal(items.techStackLocks.length, 3);
  assert.equal(items.complianceRequirements.length, 2);
  assert.equal(items.redlines.length, 2);
});

// ============================================================================
// T19. WorkflowValidationResult 接口字段完整性
// ============================================================================

test("T19. WorkflowValidationResult 接口字段完整性", () => {
  const result: WorkflowValidationResult = {
    canStartCoding: false,
    missingApprovals: ["spec"],
    reason: "spec.md 未批准，CODING Loop 不得启动（SEED-10）",
  };
  assert.equal(result.canStartCoding, false);
  assert.equal(result.missingApprovals.length, 1);
  assert.equal(result.missingApprovals[0], "spec");
  assert.ok(result.reason.includes("SEED-10"));
});

// ============================================================================
// T20. 不可变保证：常量 Object.isFrozen
// ============================================================================

test("T20. 所有顶层常量已 Object.freeze 冻结", () => {
  assert.equal(Object.isFrozen(DOCUMENT_TYPES), true);
  assert.equal(Object.isFrozen(DOCUMENT_STATES), true);
  assert.equal(Object.isFrozen(DOCUMENT_PATHS), true);
  assert.equal(Object.isFrozen(COMMIT_TYPES), true);
  assert.equal(Object.isFrozen(DEFAULT_GIT_PROCESS_CONFIG), true);
});
