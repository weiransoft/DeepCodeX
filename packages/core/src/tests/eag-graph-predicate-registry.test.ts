/**
 * EAG-Graph Phase 2 单元测试：谓词注册表（predicate-registry.ts）
 *
 * 测试范围：
 * - R1. register + lookup + has 基本流程
 * - R2. register 重复 ID 抛错
 * - R3. register 空 ID 抛错
 * - R4. register 非函数 predicate 抛错
 * - R5. lookup 未注册 ID 抛错（含已注册列表提示）
 * - R6. has 未注册 ID 返回 false
 * - R7. list 返回所有已注册 ID（按注册顺序）
 * - R8. clear 清空注册表
 * - R9. size 返回已注册数量
 * - R10. createPredicateRegistry 工厂函数
 * - R11. 谓词函数执行（decision 返回边 ID / 边条件返回 boolean）
 * - R12. 多谓词共存（不同 ID 互不干扰）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象和真实函数
 * - 测试用例独立，每个测试使用新 registry 实例
 *
 * 设计依据：
 * - LOOP-GRAPH-FUSION-DESIGN.md §7.6 PredicateRegistry 接口
 * - §13.4 PredicateRegistry 安全规范（禁止 fn: 表达式，消除 RCE 风险）
 *
 * @module core/tests/eag-graph-predicate-registry
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PredicateRegistryImpl, createPredicateRegistry } from "../eag/graph/predicate-registry";
import type { PredicateRegistry, PredicateFunction } from "../eag/graph/graph-loop-models";

// ============================================================================
// R1. register + lookup + has 基本流程
// ============================================================================

test("R1a: register 注册谓词后 has 返回 true", () => {
  const registry = new PredicateRegistryImpl();
  const fn: PredicateFunction = () => true;
  registry.register("is-active", fn);
  assert.equal(registry.has("is-active"), true);
});

test("R1b: register 注册谓词后 lookup 返回原函数", () => {
  const registry = new PredicateRegistryImpl();
  const fn: PredicateFunction = () => "edge-1";
  registry.register("choose-branch", fn);
  const looked = registry.lookup("choose-branch");
  assert.equal(looked, fn, "lookup 必须返回 register 时传入的原函数引用");
});

test("R1c: 未注册的 ID has 返回 false", () => {
  const registry = new PredicateRegistryImpl();
  assert.equal(registry.has("non-existent"), false);
});

// ============================================================================
// R2. register 重复 ID 抛错
// ============================================================================

test("R2: register 重复 ID 抛错（避免覆盖已有谓词）", () => {
  const registry = new PredicateRegistryImpl();
  registry.register("dup", () => true);
  assert.throws(() => registry.register("dup", () => false), /谓词 ID 已存在.*id=dup/);
});

// ============================================================================
// R3. register 空 ID 抛错
// ============================================================================

test("R3a: register 空字符串 ID 抛错", () => {
  const registry = new PredicateRegistryImpl();
  assert.throws(() => registry.register("", () => true), /id 必须是非空字符串/);
});

test("R3b: register 非字符串 ID 抛错（类型守卫）", () => {
  const registry = new PredicateRegistryImpl();
  // 模拟类型错误：强制传入非字符串
  assert.throws(() => registry.register(123 as any, () => true), /id 必须是非空字符串/);
});

// ============================================================================
// R4. register 非函数 predicate 抛错
// ============================================================================

test("R4: register 非函数 predicate 抛错", () => {
  const registry = new PredicateRegistryImpl();
  assert.throws(() => registry.register("bad", "not-a-function" as any), /predicate 必须是函数/);
});

// ============================================================================
// R5. lookup 未注册 ID 抛错（含已注册列表提示）
// ============================================================================

test("R5a: lookup 未注册 ID 抛错", () => {
  const registry = new PredicateRegistryImpl();
  assert.throws(() => registry.lookup("missing"), /谓词 ID 未注册.*id=missing/);
});

test("R5b: lookup 未注册 ID 时错误信息包含已注册列表", () => {
  const registry = new PredicateRegistryImpl();
  registry.register("alpha", () => true);
  registry.register("beta", () => false);
  try {
    registry.lookup("missing");
    assert.fail("应该抛出错误");
  } catch (err) {
    const msg = (err as Error).message;
    assert.ok(msg.includes("alpha"), "错误信息应包含已注册的 alpha");
    assert.ok(msg.includes("beta"), "错误信息应包含已注册的 beta");
  }
});

test("R5c: lookup 空注册表时错误信息提示空", () => {
  const registry = new PredicateRegistryImpl();
  try {
    registry.lookup("anything");
    assert.fail("应该抛出错误");
  } catch (err) {
    const msg = (err as Error).message;
    assert.ok(msg.includes("<空>"), "空注册表时应提示 <空>");
  }
});

// ============================================================================
// R6. has 未注册 ID 返回 false
// ============================================================================

test("R6: has 对未注册 ID 返回 false", () => {
  const registry = new PredicateRegistryImpl();
  registry.register("exists", () => true);
  assert.equal(registry.has("exists"), true);
  assert.equal(registry.has("not-exists"), false);
});

// ============================================================================
// R7. list 返回所有已注册 ID（按注册顺序）
// ============================================================================

test("R7a: list 返回所有已注册 ID", () => {
  const registry = new PredicateRegistryImpl();
  registry.register("first", () => true);
  registry.register("second", () => true);
  registry.register("third", () => true);
  const ids = registry.list();
  assert.equal(ids.length, 3);
  assert.deepEqual(ids, ["first", "second", "third"]);
});

test("R7b: list 空注册表返回空数组", () => {
  const registry = new PredicateRegistryImpl();
  const ids = registry.list();
  assert.equal(ids.length, 0);
  assert.ok(Array.isArray(ids));
});

test("R7c: list 返回新数组（修改不影响内部状态）", () => {
  const registry = new PredicateRegistryImpl();
  registry.register("a", () => true);
  const ids1 = registry.list();
  ids1.push("b");
  const ids2 = registry.list();
  assert.equal(ids2.length, 1, "修改 list 返回的数组不应影响内部状态");
});

// ============================================================================
// R8. clear 清空注册表
// ============================================================================

test("R8: clear 清空注册表", () => {
  const registry = new PredicateRegistryImpl();
  registry.register("a", () => true);
  registry.register("b", () => true);
  assert.equal(registry.size(), 2);
  registry.clear();
  assert.equal(registry.size(), 0);
  assert.equal(registry.has("a"), false);
});

// ============================================================================
// R9. size 返回已注册数量
// ============================================================================

test("R9: size 返回已注册数量", () => {
  const registry = new PredicateRegistryImpl();
  assert.equal(registry.size(), 0);
  registry.register("a", () => true);
  assert.equal(registry.size(), 1);
  registry.register("b", () => true);
  assert.equal(registry.size(), 2);
});

// ============================================================================
// R10. createPredicateRegistry 工厂函数
// ============================================================================

test("R10a: createPredicateRegistry 返回 PredicateRegistry 实例", () => {
  const registry = createPredicateRegistry();
  assert.ok(registry instanceof PredicateRegistryImpl);
  assert.equal(typeof registry.register, "function");
  assert.equal(typeof registry.lookup, "function");
  assert.equal(typeof registry.has, "function");
});

test("R10b: createPredicateRegistry 返回空注册表", () => {
  const registry = createPredicateRegistry();
  assert.equal(registry.size(), 0);
});

// ============================================================================
// R11. 谓词函数执行（decision 返回边 ID / 边条件返回 boolean）
// ============================================================================

test("R11a: decision 谓词返回边 ID（字符串）", () => {
  const registry = new PredicateRegistryImpl();
  registry.register("choose-by-score", (input) => {
    const score = input.score as number;
    return score >= 80 ? "edge-fast" : "edge-slow";
  });
  const fn = registry.lookup("choose-by-score");
  assert.equal(fn({ score: 90 }, {} as never), "edge-fast");
  assert.equal(fn({ score: 50 }, {} as never), "edge-slow");
});

test("R11b: 边条件谓词返回 boolean", () => {
  const registry = new PredicateRegistryImpl();
  registry.register("is-high-priority", (input) => input.priority === "high");
  const fn = registry.lookup("is-high-priority");
  assert.equal(fn({ priority: "high" }, {} as never), true);
  assert.equal(fn({ priority: "low" }, {} as never), false);
});

// ============================================================================
// R12. 多谓词共存（不同 ID 互不干扰）
// ============================================================================

test("R12: 多谓词共存，互不干扰", () => {
  const registry = new PredicateRegistryImpl();
  registry.register("a", () => "edge-a");
  registry.register("b", () => "edge-b");
  registry.register("c", () => true);

  assert.equal(registry.size(), 3);
  assert.equal(registry.lookup("a")({}, {} as never), "edge-a");
  assert.equal(registry.lookup("b")({}, {} as never), "edge-b");
  assert.equal(registry.lookup("c")({}, {} as never), true);
});
