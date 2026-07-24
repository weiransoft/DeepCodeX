/**
 * 图上下文工具函数统一模块测试（TOP-4 上下文拼接工具函数统一化）
 *
 * 测试范围：
 * - graph-context-utils.ts 中 5 个工具函数的行为正确性
 * - graph-context-helpers.ts 的导出兼容性（deepFreeze 仍可导入）
 * - graph-loop-models.ts 的导出兼容性（getGraphGlobalContext / isGraphGlobalContextInitialized 仍可导入）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实对象和闭包
 * - 测试替身命名禁用 Mock 前缀
 * - 每个测试用例独立，无共享可变状态
 * - 中文注释详细，符合规范
 *
 * @module core/tests/graph-context-utils
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  /** 图上下文工具函数 */
  deepFreeze,
  deepClone,
  getGraphGlobalContext,
  isGraphGlobalContextInitialized,
  redactSensitiveFields,
  mergeBranchGlobalState,
} from "../eag/graph/graph-context-utils";
import { deepFreeze as deepFreezeFromHelpers } from "../eag/graph/graph-context-helpers";
import {
  getGraphGlobalContext as getGraphGlobalContextFromModels,
  isGraphGlobalContextInitialized as isGraphGlobalContextInitializedFromModels,
} from "../eag/graph/graph-loop-models";
import type { GraphRunContext } from "../eag/graph/graph-loop-models";

// ============================================================================
// deepFreeze 测试
// ============================================================================

test("deepFreeze: 基本对象递归冻结，禁止修改嵌套属性", () => {
  const obj = { a: 1, nested: { b: 2 }, arr: [1, 2, { c: 3 }] };
  const frozen = deepFreeze(obj);

  // 同一引用返回
  assert.strictEqual(frozen, obj);
  // 对象已冻结
  assert.strictEqual(Object.isFrozen(frozen), true);
  // 嵌套对象已冻结
  assert.strictEqual(Object.isFrozen(frozen.nested), true);
  // 数组已冻结
  assert.strictEqual(Object.isFrozen(frozen.arr), true);
  // 数组元素对象已冻结
  assert.strictEqual(Object.isFrozen(frozen.arr[2]), true);
  // 禁止修改（运行时抛出 TypeError）
  assert.throws(() => {
    (frozen as Record<string, unknown>).a = 100;
  }, TypeError);
  assert.throws(() => {
    (frozen.nested as Record<string, unknown>).b = 100;
  }, TypeError);
});

test("deepFreeze: null / undefined / 基本类型直接返回", () => {
  assert.strictEqual(deepFreeze(null), null);
  assert.strictEqual(deepFreeze(undefined), undefined);
  assert.strictEqual(deepFreeze(42), 42);
  assert.strictEqual(deepFreeze("hello"), "hello");
});

// ============================================================================
// deepClone 测试
// ============================================================================

test("deepClone: 深拷贝对象，修改副本不影响原对象", () => {
  const original = { a: 1, nested: { b: 2 }, arr: [1, 2, 3] };
  const cloned = deepClone(original);

  assert.notStrictEqual(cloned, original);
  assert.notStrictEqual(cloned.nested, original.nested);
  assert.notStrictEqual(cloned.arr, original.arr);
  assert.deepStrictEqual(cloned, original);

  cloned.nested.b = 999;
  cloned.arr[0] = 999;
  assert.strictEqual(original.nested.b, 2);
  assert.strictEqual(original.arr[0], 1);
});

test("deepClone: 支持 Map 深拷贝", () => {
  const original = new Map<string, unknown>([
    ["key1", { value: 1 }],
    ["key2", [1, 2, 3]],
  ]);
  const cloned = deepClone(original);

  assert.notStrictEqual(cloned, original);
  assert.strictEqual(cloned.get("key1") !== original.get("key1"), true);
  assert.deepStrictEqual(cloned.get("key1"), { value: 1 });
});

// ============================================================================
// getGraphGlobalContext / isGraphGlobalContextInitialized 测试
// ============================================================================

test("getGraphGlobalContext: 从 GraphRunContext.globalState 返回 GraphGlobalContext 视图", () => {
  const context: GraphRunContext = {
    runId: "run-1",
    graphId: "graph-1",
    globalState: { projectGoal: "测试目标", customField: 123 },
    nodeResults: new Map(),
    visited: new Set(),
    totalTokensUsed: 0,
    totalLlmCallCount: 0,
    startedAtMs: Date.now(),
    config: {
      maxDepth: 10,
      maxParallelism: 1,
      maxTokens: 0,
      timeoutSec: 0,
      enableExperienceRecall: false,
      enableAutoIsolation: true,
      nodeRetryLimit: 3,
    },
    cancelled: false,
    predicateRegistry: {} as unknown as GraphRunContext["predicateRegistry"],
  };

  const globalCtx = getGraphGlobalContext(context);
  assert.strictEqual(globalCtx.projectGoal, "测试目标");
  assert.strictEqual((globalCtx as Record<string, unknown>).customField, 123);
});

test("isGraphGlobalContextInitialized: 通过 projectGoal 字段判断初始化状态", () => {
  const initialized: GraphRunContext = {
    runId: "run-1",
    graphId: "graph-1",
    globalState: { projectGoal: "有目标" },
    nodeResults: new Map(),
    visited: new Set(),
    totalTokensUsed: 0,
    totalLlmCallCount: 0,
    startedAtMs: Date.now(),
    config: {
      maxDepth: 10,
      maxParallelism: 1,
      maxTokens: 0,
      timeoutSec: 0,
      enableExperienceRecall: false,
      enableAutoIsolation: true,
      nodeRetryLimit: 3,
    },
    cancelled: false,
    predicateRegistry: {} as unknown as GraphRunContext["predicateRegistry"],
  };
  const uninitialized: GraphRunContext = {
    runId: "run-2",
    graphId: "graph-2",
    globalState: { otherField: 1 },
    nodeResults: new Map(),
    visited: new Set(),
    totalTokensUsed: 0,
    totalLlmCallCount: 0,
    startedAtMs: Date.now(),
    config: {
      maxDepth: 10,
      maxParallelism: 1,
      maxTokens: 0,
      timeoutSec: 0,
      enableExperienceRecall: false,
      enableAutoIsolation: true,
      nodeRetryLimit: 3,
    },
    cancelled: false,
    predicateRegistry: {} as unknown as GraphRunContext["predicateRegistry"],
  };

  assert.strictEqual(isGraphGlobalContextInitialized(initialized), true);
  assert.strictEqual(isGraphGlobalContextInitialized(uninitialized), false);
});

// ============================================================================
// redactSensitiveFields 测试
// ============================================================================

test("redactSensitiveFields: 脱敏敏感字段，保留非敏感字段", () => {
  const obj: Record<string, unknown> = {
    apiKey: "secret-123",
    authToken: "token-456",
    userPassword: "pwd-789",
    awsCredentials: { accessKeyId: "AKIA" },
    normalField: "visible",
    count: 42,
  };
  redactSensitiveFields(obj);

  assert.strictEqual(obj.apiKey, "[REDACTED]");
  assert.strictEqual(obj.authToken, "[REDACTED]");
  assert.strictEqual(obj.userPassword, "[REDACTED]");
  // awsCredentials 这个 key 本身包含 credential 敏感词，因此整个字段被脱敏
  assert.strictEqual(obj.awsCredentials, "[REDACTED]");
  assert.strictEqual(obj.normalField, "visible");
  assert.strictEqual(obj.count, 42);
});

test("redactSensitiveFields: 空对象无副作用", () => {
  const obj: Record<string, unknown> = {};
  redactSensitiveFields(obj);
  assert.deepStrictEqual(obj, {});
});

// ============================================================================
// mergeBranchGlobalState 测试
// ============================================================================

function createMainState(): Record<string, unknown> {
  return {
    projectGoal: "主目标",
    nodeSummaries: new Map<string, unknown>([["node-1", { nodeId: "node-1" }]]),
    collectedExperiences: [{ experienceId: "exp-1" }],
    bulletinBoard: [{ entryId: "b-1" }],
    sharedArtifacts: { version: "v1" },
    lastUpdatedAt: "2024-01-01T00:00:00Z",
    runId: "run-main",
  };
}

test("mergeBranchGlobalState: Map / Array / Object 字段做 entry 级合并", () => {
  const main = createMainState();
  const branch: Record<string, unknown> = {
    nodeSummaries: new Map<string, unknown>([["node-2", { nodeId: "node-2" }]]),
    collectedExperiences: [{ experienceId: "exp-2" }],
    bulletinBoard: [{ entryId: "b-2" }],
    sharedArtifacts: { version: "v2", newKey: "newValue" },
    lastUpdatedAt: "2024-01-02T00:00:00Z",
    tempField: "should-not-merge",
  };

  mergeBranchGlobalState(main, branch);

  // nodeSummaries entry 级合并
  const mainSummaries = main.nodeSummaries as Map<string, unknown>;
  assert.strictEqual(mainSummaries.has("node-1"), true);
  assert.strictEqual(mainSummaries.has("node-2"), true);

  // collectedExperiences 追加
  const mainExperiences = main.collectedExperiences as Array<{ experienceId: string }>;
  assert.strictEqual(mainExperiences.length, 2);
  assert.strictEqual(mainExperiences[1].experienceId, "exp-2");

  // bulletinBoard 追加
  const mainBulletins = main.bulletinBoard as Array<{ entryId: string }>;
  assert.strictEqual(mainBulletins.length, 2);
  assert.strictEqual(mainBulletins[1].entryId, "b-2");

  // sharedArtifacts 字段级合并
  assert.strictEqual((main.sharedArtifacts as Record<string, unknown>).version, "v2");
  assert.strictEqual((main.sharedArtifacts as Record<string, unknown>).newKey, "newValue");

  // lastUpdatedAt 已更新
  assert.notStrictEqual(main.lastUpdatedAt, "2024-01-01T00:00:00Z");
  // tempField 不在白名单，不应被合并
  assert.strictEqual((main as Record<string, unknown>).tempField, undefined);
  // runId 等溯源字段不应被覆盖
  assert.strictEqual(main.runId, "run-main");
});

test("mergeBranchGlobalState: 经验 experienceId 防御性去重", () => {
  const main = createMainState();
  const branch: Record<string, unknown> = {
    collectedExperiences: [{ experienceId: "exp-1" }, { experienceId: "exp-3" }],
  };

  mergeBranchGlobalState(main, branch);

  const mainExperiences = main.collectedExperiences as Array<{ experienceId: string }>;
  assert.strictEqual(mainExperiences.length, 2);
  assert.strictEqual(mainExperiences[0].experienceId, "exp-1");
  assert.strictEqual(mainExperiences[1].experienceId, "exp-3");
});

test("mergeBranchGlobalState: 主 state 未初始化集合时直接复制分支集合", () => {
  const main: Record<string, unknown> = { projectGoal: "主目标" };
  const branch: Record<string, unknown> = {
    nodeSummaries: new Map<string, unknown>([["node-b", { nodeId: "node-b" }]]),
    collectedExperiences: [{ experienceId: "exp-b" }],
    bulletinBoard: [{ entryId: "b-b" }],
  };

  mergeBranchGlobalState(main, branch);

  assert.strictEqual((main.nodeSummaries as Map<string, unknown>).has("node-b"), true);
  assert.strictEqual((main.collectedExperiences as Array<{ experienceId: string }>)[0].experienceId, "exp-b");
  assert.strictEqual((main.bulletinBoard as Array<{ entryId: string }>)[0].entryId, "b-b");
});

test("mergeBranchGlobalState: 允许通过 options 扩展标量字段白名单", () => {
  const main: Record<string, unknown> = { customScalar: "old" };
  const branch: Record<string, unknown> = { customScalar: "new" };

  mergeBranchGlobalState(main, branch, { allowedScalarKeys: new Set(["customScalar"]) });
  assert.strictEqual(main.customScalar, "new");
});

test("mergeBranchGlobalState: 默认白名单仅包含 lastUpdatedAt", () => {
  const main: Record<string, unknown> = {};
  const branch: Record<string, unknown> = { lastUpdatedAt: "2024-12-31T00:00:00Z", extraScalar: "x" };

  mergeBranchGlobalState(main, branch);
  // lastUpdatedAt 在白名单中，但函数末尾会刷新为当前时间（标记合并完成时间）
  assert.strictEqual(typeof main.lastUpdatedAt, "string");
  assert.notStrictEqual(main.lastUpdatedAt, "2024-12-31T00:00:00Z");
  // extraScalar 不在白名单，不应被合并
  assert.strictEqual((main as Record<string, unknown>).extraScalar, undefined);
});

// ============================================================================
// 导出兼容性测试
// ============================================================================

test("graph-context-helpers.ts 仍导出 deepFreeze 且行为一致", () => {
  const obj = { nested: { value: 1 } };
  const frozen = deepFreezeFromHelpers(obj);
  assert.strictEqual(frozen, obj);
  assert.strictEqual(Object.isFrozen(frozen.nested), true);
});

test("graph-loop-models.ts 仍导出 getGraphGlobalContext / isGraphGlobalContextInitialized", () => {
  const context: GraphRunContext = {
    runId: "run-compat",
    graphId: "graph-compat",
    globalState: { projectGoal: "兼容测试" },
    nodeResults: new Map(),
    visited: new Set(),
    totalTokensUsed: 0,
    totalLlmCallCount: 0,
    startedAtMs: Date.now(),
    config: {
      maxDepth: 10,
      maxParallelism: 1,
      maxTokens: 0,
      timeoutSec: 0,
      enableExperienceRecall: false,
      enableAutoIsolation: true,
      nodeRetryLimit: 3,
    },
    cancelled: false,
    predicateRegistry: {} as unknown as GraphRunContext["predicateRegistry"],
  };

  assert.strictEqual(getGraphGlobalContextFromModels(context).projectGoal, "兼容测试");
  assert.strictEqual(isGraphGlobalContextInitializedFromModels(context), true);
});
