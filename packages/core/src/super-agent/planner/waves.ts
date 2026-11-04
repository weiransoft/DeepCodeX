/**
 * 波次划分 —— 把步骤 DAG 变成「可以同批执行」的层次
 *
 * ## 为什么是 Kahn 分层而不是完整调度
 *
 * 执行侧只需要回答一个问题：**当前哪些步骤的前置已经全部完成？**
 * 这正是拓扑分层的定义。资源约束、优先级抢占、关键路径都不在本层范围内
 * （Super Agent 的并发上限由 Worker 侧自行控制）。
 *
 * ## 确定性
 *
 * 同一层的步骤按**计划中的原始顺序**排列（而不是按 ID 字典序），
 * 这样模型给出的步骤顺序在展示与派工时保持一致，便于人对照计划阅读。
 *
 * @module super-agent/planner/waves
 */

import type { PlanStep, PlanStepState, PlanWave } from "./types.js";

/**
 * 把步骤划分成波次（拓扑分层）
 *
 * 环上的步骤**不会**出现在任何波次中——调用方应先经 `parsePlan` 校验无环；
 * 此处保持「不抛错、只返回可执行部分」的宽容语义，避免运行时因脏数据整体崩溃。
 *
 * @param steps 步骤列表（顺序即计划顺序）
 * @returns 波次列表（第 0 波为无依赖步骤）
 */
export function planWaves(steps: readonly PlanStep[]): PlanWave[] {
  const order = new Map<string, number>();
  steps.forEach((step, index) => order.set(step.id, index));

  const remaining = new Set(steps.map((step) => step.id));
  const done = new Set<string>();
  const waves: PlanWave[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => {
        const step = steps.find((candidate) => candidate.id === id);
        if (step === undefined) return false;
        return step.dependsOn.every((dependency) => done.has(dependency));
      })
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

    if (ready.length === 0) break; // 剩余步骤成环——交由校验层报告

    waves.push({ index: waves.length, stepIds: ready });
    for (const id of ready) {
      remaining.delete(id);
      done.add(id);
    }
  }

  return waves;
}

/**
 * 取某一步骤所属的波次号
 *
 * @param steps 步骤列表
 * @param stepId 步骤 ID
 * @returns 波次号；未找到返回 -1
 */
export function waveIndexOf(steps: readonly PlanStep[], stepId: string): number {
  for (const wave of planWaves(steps)) {
    if (wave.stepIds.includes(stepId)) return wave.index;
  }
  return -1;
}

/**
 * 找出当前可派工的步骤
 *
 * 判定：状态为 `pending`，且其全部前置步骤状态为 `ready`。
 * （`failed` 的前置不算完成——失败会终止工单，不会继续推进。）
 *
 * @param steps 计划步骤
 * @param states 步骤状态表（key = 步骤 ID）
 * @returns 可派工的步骤（按计划顺序）
 */
export function findRunnableSteps(steps: readonly PlanStep[], states: ReadonlyMap<string, PlanStepState>): PlanStep[] {
  return steps.filter((step) => {
    if ((states.get(step.id) ?? "pending") !== "pending") return false;
    return step.dependsOn.every((dependency) => states.get(dependency) === "ready");
  });
}

/**
 * 找出被阻塞的步骤（用于诊断「计划为什么停住了」）
 *
 * @param steps 计划步骤
 * @param states 步骤状态表
 * @returns 阻塞步骤及其缺失的依赖
 */
export function findBlockedSteps(
  steps: readonly PlanStep[],
  states: ReadonlyMap<string, PlanStepState>
): { readonly stepId: string; readonly missingDependsOn: readonly string[] }[] {
  return steps
    .filter((step) => (states.get(step.id) ?? "pending") === "pending")
    .map((step) => ({
      stepId: step.id,
      missingDependsOn: step.dependsOn.filter((dependency) => states.get(dependency) !== "ready"),
    }))
    .filter((entry) => entry.missingDependsOn.length > 0);
}

/**
 * 计划是否已全部完成
 *
 * @param steps 计划步骤
 * @param states 步骤状态表
 * @returns 全部步骤状态为 `ready` 时返回 true
 */
export function isPlanComplete(steps: readonly PlanStep[], states: ReadonlyMap<string, PlanStepState>): boolean {
  return steps.length > 0 && steps.every((step) => states.get(step.id) === "ready");
}
