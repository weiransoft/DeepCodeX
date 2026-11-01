/**
 * P4 单元测试：EvaluationReport 证据状态与分数天花板
 *
 * 测试范围：
 * - T1. EVIDENCE_SCORE_CEILINGS 七级常量表（missing/unobserved/not_applicable ≤59，
 *       present ≤74，wired ≤84，exercised ≤94，outcome-supported =100）
 * - T2. capDimensionScore 单值封顶（含越界夹紧）
 * - T3. capDimensionScores 组封顶（copy-on-write，部分维度缺省）
 * - T4. buildReport 带 evidence：evidenceState/evidenceScore/dimensionScores 落位
 * - T5. buildReport 不带 evidence：新增字段 undefined（旧消费方兼容）
 * - T6. 维度分数不得突破天花板（unobserved 下 95 分被压回 59）
 * - T7. EVIDENCE_STATES / WORK_LOOP_DIMENSIONS 常量完整性
 *
 * 测试约定：node:test + assert/strict，禁止 mock。
 *
 * @module core/tests/eag-evaluator-evidence
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_STATES,
  EVIDENCE_SCORE_CEILINGS,
  WORK_LOOP_DIMENSIONS,
  capDimensionScore,
  capDimensionScores,
  buildReport,
  type EvidenceState,
  type RedlineDefinition,
  type RedlineResult,
} from "../eag/evaluator/types";

/** 构造全通过的红线判定 */
function allPassed(): RedlineResult[] {
  return [{ redlineId: "E1", status: "passed", violations: [] }];
}

/** 构造一条 BLOCKER 红线定义 */
function blockerDef(): RedlineDefinition {
  return {
    id: "E1",
    name: "事务边界",
    description: "多步写入必须事务化",
    severity: "blocker",
    checkMethod: "静态 import 分析",
    checkType: "static",
  };
}

test("T1: EVIDENCE_SCORE_CEILINGS 常量表数值正确", () => {
  assert.equal(EVIDENCE_SCORE_CEILINGS["missing"], 59);
  assert.equal(EVIDENCE_SCORE_CEILINGS["unobserved"], 59);
  assert.equal(EVIDENCE_SCORE_CEILINGS["not_applicable"], 59);
  assert.equal(EVIDENCE_SCORE_CEILINGS["present"], 74);
  assert.equal(EVIDENCE_SCORE_CEILINGS["wired"], 84);
  assert.equal(EVIDENCE_SCORE_CEILINGS["exercised"], 94);
  assert.equal(EVIDENCE_SCORE_CEILINGS["outcome-supported"], 100);
});

test("T2: capDimensionScore 单值封顶与越界夹紧", () => {
  // 未超天花板原样返回
  assert.equal(capDimensionScore("exercised", 90), 90);
  // 超天花板被压回
  assert.equal(capDimensionScore("exercised", 98), 94);
  assert.equal(capDimensionScore("unobserved", 95), 59);
  // 越界夹紧
  assert.equal(capDimensionScore("outcome-supported", 150), 100);
  assert.equal(capDimensionScore("outcome-supported", -5), 0);
});

test("T3: capDimensionScores 组封顶 —— copy-on-write + 部分维度缺省", () => {
  const input = {
    "task-understanding": 90,
    "change-validation": 50,
  };
  const result = capDimensionScores("wired", input);
  assert.equal(result["task-understanding"], 84); // 90 > 84 → 压回
  assert.equal(result["change-validation"], 50); // 50 < 84 → 原样
  assert.equal(result["learning-capture"], undefined); // 未传维度不出现
  // 入参未被突变
  assert.equal(input["task-understanding"], 90);
});

test("T4: buildReport 带 evidence —— 证据字段落位", () => {
  const report = buildReport(allPassed(), [blockerDef()], 5, 0, "备注", {
    state: "exercised",
    dimensionScores: {
      "task-understanding": 80,
      "change-validation": 96,
    },
  });
  assert.equal(report.evidenceState, "exercised");
  // 维度分数按天花板封顶
  assert.equal(report.dimensionScores?.["task-understanding"], 80);
  assert.equal(report.dimensionScores?.["change-validation"], 94);
  // 整体分 = 维度均值 (80+94)/2=87，≤94 天花板
  assert.equal(report.evidenceScore, 87);
  // 原有字段不受影响
  assert.equal(report.verdict, "pass");
});

test("T5: buildReport 不带 evidence —— 新增字段 undefined（旧消费方兼容）", () => {
  const report = buildReport(allPassed(), [blockerDef()], 5, 0);
  assert.equal(report.verdict, "pass");
  assert.equal(report.evidenceState, undefined);
  assert.equal(report.evidenceScore, undefined);
  assert.equal(report.dimensionScores, undefined);
});

test("T6: 维度分数不得突破 unobserved 天花板（95 → 59）", () => {
  const report = buildReport(allPassed(), [blockerDef()], 5, 0, undefined, {
    state: "unobserved",
    dimensionScores: { "task-understanding": 95 },
  });
  assert.equal(report.dimensionScores?.["task-understanding"], 59);
  assert.equal(report.evidenceScore, 59);
});

test("T7: 常量完整性 —— EVIDENCE_STATES 七级 / WORK_LOOP_DIMENSIONS 五维", () => {
  assert.equal(EVIDENCE_STATES.length, 7);
  assert.ok(EVIDENCE_STATES.includes("unobserved" as EvidenceState));
  assert.ok(EVIDENCE_STATES.includes("missing" as EvidenceState));
  assert.equal(WORK_LOOP_DIMENSIONS.length, 5);
  assert.ok(WORK_LOOP_DIMENSIONS.includes("learning-capture"));
});
