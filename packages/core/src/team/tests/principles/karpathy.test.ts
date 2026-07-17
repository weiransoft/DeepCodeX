/**
 * Karpathy 四大核心原则常量测试
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KARPATHY_PRINCIPLE_IDS,
  ALL_KARPATHY_PRINCIPLES,
  isValidKarpathyPrinciple,
  THINK_BEFORE_CODING,
  SIMPLICITY_FIRST,
  SURGICAL_CHANGES,
  GOAL_DRIVEN_EXECUTION,
  KARPATHY_4_PRINCIPLES_FULL,
  getKarpathyPrinciples,
  getKarpathyPrinciple,
  getKarpathyPrincipleName,
} from "../../principles/karpathy.js";

test("KARPATHY_PRINCIPLE_IDS has 4 IDs", () => {
  assert.equal(ALL_KARPATHY_PRINCIPLES.length, 4);
  assert.equal(KARPATHY_PRINCIPLE_IDS.THINK_BEFORE_CODING, "think_before_coding");
  assert.equal(KARPATHY_PRINCIPLE_IDS.SIMPLICITY_FIRST, "simplicity_first");
  assert.equal(KARPATHY_PRINCIPLE_IDS.SURGICAL_CHANGES, "surgical_changes");
  assert.equal(KARPATHY_PRINCIPLE_IDS.GOAL_DRIVEN, "goal_driven");
});

test("isValidKarpathyPrinciple accepts valid", () => {
  for (const p of ALL_KARPATHY_PRINCIPLES) {
    assert.ok(isValidKarpathyPrinciple(p));
  }
  assert.equal(isValidKarpathyPrinciple("invalid"), false);
});

test("THINK_BEFORE_CODING constant has Chinese content", () => {
  assert.ok(THINK_BEFORE_CODING.includes("Think Before Coding"));
  assert.ok(THINK_BEFORE_CODING.includes("三思而后行"));
});

test("SIMPLICITY_FIRST constant has Chinese content", () => {
  assert.ok(SIMPLICITY_FIRST.includes("Simplicity First"));
  assert.ok(SIMPLICITY_FIRST.includes("简单优先"));
});

test("SURGICAL_CHANGES constant has Chinese content", () => {
  assert.ok(SURGICAL_CHANGES.includes("Surgical Changes"));
  assert.ok(SURGICAL_CHANGES.includes("精准修改"));
});

test("GOAL_DRIVEN_EXECUTION constant has Chinese content", () => {
  assert.ok(GOAL_DRIVEN_EXECUTION.includes("Goal-Driven"));
  assert.ok(GOAL_DRIVEN_EXECUTION.includes("目标驱动"));
});

test("KARPATHY_4_PRINCIPLES_FULL contains all 4 principles", () => {
  assert.ok(KARPATHY_4_PRINCIPLES_FULL.includes("Think Before Coding"));
  assert.ok(KARPATHY_4_PRINCIPLES_FULL.includes("Simplicity First"));
  assert.ok(KARPATHY_4_PRINCIPLES_FULL.includes("Surgical Changes"));
  assert.ok(KARPATHY_4_PRINCIPLES_FULL.includes("Goal-Driven"));
});

test("getKarpathyPrinciples() with no arg returns all 4", () => {
  const text = getKarpathyPrinciples();
  assert.ok(text.includes("Think Before Coding"));
  assert.ok(text.includes("Simplicity First"));
  assert.ok(text.includes("Surgical Changes"));
  assert.ok(text.includes("Goal-Driven"));
});

test("getKarpathyPrinciples with subset", () => {
  const text = getKarpathyPrinciples([KARPATHY_PRINCIPLE_IDS.SIMPLICITY_FIRST]);
  assert.ok(text.includes("Simplicity First"));
  // 不应包含其它原则的标题
  assert.equal(text.includes("Surgical Changes"), false);
});

test("getKarpathyPrinciple returns single principle", () => {
  const text = getKarpathyPrinciple(KARPATHY_PRINCIPLE_IDS.SURGICAL_CHANGES);
  assert.equal(text, SURGICAL_CHANGES);
});

test("getKarpathyPrincipleName returns Chinese name", () => {
  assert.equal(
    getKarpathyPrincipleName(KARPATHY_PRINCIPLE_IDS.THINK_BEFORE_CODING),
    "Think Before Coding（三思而后行）"
  );
});
