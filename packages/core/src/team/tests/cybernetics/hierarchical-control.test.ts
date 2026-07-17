/**
 * HierarchicalControl 三层控制架构测试
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ControlLevel,
  ALL_CONTROL_LEVELS,
  isValidControlLevel,
  HierarchicalControlError,
  ROLE_CAPABILITIES,
  ALL_ROLE_IDS,
  createStrategicPlan,
  strategicPlanToDict,
  StrategicController,
  TacticalController,
  ExecutionController,
  HierarchicalControlManager,
} from "../../cybernetics/hierarchical-control.js";

test("ControlLevel has 3 levels", () => {
  assert.equal(ALL_CONTROL_LEVELS.length, 3);
  assert.equal(ControlLevel.STRATEGIC, "strategic");
  assert.equal(ControlLevel.TACTICAL, "tactical");
  assert.equal(ControlLevel.EXECUTION, "execution");
});

test("isValidControlLevel accepts valid levels", () => {
  for (const l of ALL_CONTROL_LEVELS) {
    assert.ok(isValidControlLevel(l));
  }
  assert.equal(isValidControlLevel("invalid"), false);
});

test("ROLE_CAPABILITIES has role entries", () => {
  assert.ok(ALL_ROLE_IDS.length > 0);
  for (const r of ALL_ROLE_IDS) {
    const caps = ROLE_CAPABILITIES[r];
    assert.ok(caps !== undefined);
  }
});

test("createStrategicPlan captures plan fields", () => {
  const p = createStrategicPlan({
    plan_id: "plan-1",
    task_type: "test",
    recommended_roles: ["architect", "solo-coder"],
    role_config: {},
    execution_strategy: "sequential",
    estimated_time: 100,
    risk_assessment: { level: "low" },
  });
  assert.equal(p.plan_id, "plan-1");
  assert.equal(p.recommended_roles.length, 2);
  assert.equal(p.execution_strategy, "sequential");
});

test("strategicPlanToDict serializes", () => {
  const p = createStrategicPlan({
    plan_id: "p1",
    task_type: "t",
    recommended_roles: [],
    role_config: {},
    execution_strategy: "s",
    estimated_time: 0,
    risk_assessment: {},
  });
  const dict = strategicPlanToDict(p);
  assert.equal(dict["plan_id"], "p1");
});

test("StrategicController.plan returns a plan", async () => {
  const ctrl = new StrategicController();
  const plan = await ctrl.plan({ complexity: "medium" });
  assert.ok(plan !== null);
  assert.equal(typeof plan.plan_id, "string");
});

test("TacticalController.decide returns a decision", async () => {
  const ctrl = new TacticalController();
  const decision = await ctrl.decide({ planId: "p1" });
  assert.ok(decision !== null);
  assert.equal(typeof decision.decision_id, "string");
});

test("ExecutionController.execute runs task", async () => {
  const ctrl = new ExecutionController();
  const metrics = await ctrl.execute({ id: "t1" }, "explore", []);
  assert.ok(metrics !== null);
});

test("HierarchicalControlManager.executeTask runs all 3 layers", async () => {
  const mgr = new HierarchicalControlManager();
  let executed = false;
  const result = await mgr.executeTask({ id: "t1" }, async (task) => {
    executed = true;
    // ExecutionController 通过 result["success"] 判定成功，必须返回 success: true
    return { ...task, success: true, completed: true };
  });
  assert.equal(executed, true);
  // executeTask 返回 control record + executor result，成功时 success=true
  assert.equal((result as { success: boolean }).success, true);
});
