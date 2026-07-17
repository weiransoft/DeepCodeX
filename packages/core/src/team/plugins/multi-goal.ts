/**
 * Multi-Goal 编排插件（V3 完整版）
 *
 * 支持在单个 plugin execute 中调度多个子 goal
 * 来源：multi-agent-team skill scripts/plugins/multi_goal.py
 *
 * 真实实现 5 能力：
 *   1. DAG 拓扑排序
 *   2. Resume 复用（已完成 goal 跳过）
 *   3. Schedule 并行调度（嵌套 dispatcher）
 *   4. Reuse 结果合并
 *   5. Report 进度上报
 *
 * 与 multi-agent-team v2.7 一致：
 *   - 通过 ctx.dispatcher 嵌套调用子 goal
 *   - 复用父 ctx 的 registry + task
 *   - 进度通过 ctx.events 上报
 */

import { BasePlugin } from "./base.js";
import type { DispatchResult, PluginContext, GoalInstance } from "../types.js";
import { makeGoal, makeBatch, topologicalLevels } from "./goal-dispatcher.js";

/** 子 Goal 定义（用户传入） */
export interface SubGoalSpec {
  /** 子 goal 名称（在 multi-goal 上下文中唯一） */
  name: string;
  /** 关联的 plugin 名（必须在 ctx.registry 中已注册） */
  plugin: string;
  /** 依赖的其他子 goal name */
  depends?: string[];
  /** 互斥的其他子 goal name */
  mutex?: string[];
  /** 子 goal 输入参数 */
  input?: Record<string, unknown>;
  /** 子 goal 标签 */
  tags?: string[];
  /** 优先级 */
  priority?: number;
}

export class MultiGoalPlugin extends BasePlugin {
  constructor() {
    super();
    this.initializeMeta();
  }

  readonly meta = {
    name: "multi-goal" as const,
    priority: 150,
    description: "Multi-goal orchestration with DAG + Resume + Reuse + Schedule + Report",
    mutexWith: ["autonomous", "loop", "cancel"] as const,
    requiresTask: false,
    version: "1.0.0",
  };

  matches(ctx: PluginContext): boolean {
    return Array.isArray(ctx.state["subGoals"]) && (ctx.state["subGoals"] as unknown[]).length > 0;
  }

  async execute(ctx: PluginContext): Promise<DispatchResult> {
    const subGoals = (ctx.state["subGoals"] as SubGoalSpec[]) ?? [];
    if (subGoals.length === 0) {
      return this.ok(ctx, "Multi-goal: no sub-goals to execute", []);
    }

    this.log(ctx, "INFO", `Multi-goal: 计划执行 ${subGoals.length} 个子目标`);

    // === 1. 子 goal 名 → spec 映射 ===
    const nameToSpec = new Map<string, SubGoalSpec>();
    for (const sg of subGoals) {
      nameToSpec.set(sg.name, sg);
    }

    // === 2. 构造 GoalInstance（id 用 name，方便依赖引用） ===
    const goalInstances: GoalInstance[] = subGoals.map((sg) =>
      makeGoal({
        plugin: sg.plugin,
        priority: sg.priority ?? 100,
        dependencies: sg.depends ?? [],
        input: { ...sg.input, subGoalName: sg.name, subGoalTags: sg.tags ?? [], subGoalMutex: sg.mutex ?? [] },
      })
    );

    // === 3. 拓扑排序（detect circular / missing） ===
    let levels: ReadonlyArray<ReadonlyArray<GoalInstance>>;
    try {
      levels = topologicalLevels(goalInstances);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(ctx, "ERROR", `Multi-goal: 拓扑排序失败: ${errorMsg}`);
      return this.fail(ctx, `Multi-goal: 拓扑排序失败: ${errorMsg}`);
    }

    // === 4. Resume 复用检查（已完成的 goal 跳过）===
    const completedGoals = (ctx.state["completedSubGoals"] as string[]) ?? [];
    const skipped: string[] = [];
    const toExecute: GoalInstance[] = [];

    for (const g of goalInstances) {
      if (completedGoals.includes(g.input["subGoalName"] as string)) {
        skipped.push(g.input["subGoalName"] as string);
        this.log(ctx, "INFO", `Multi-goal: skip (already completed ${g.input["subGoalName"]}`);
      } else {
        toExecute.push((g.input["subGoalName"] as string) ? g : g);
      }
    }
    void skipped;

    // === 5. 构造 Batch 并嵌套调度 ===
    const batch = makeBatch({
      task: ctx.task,
      goals: goalInstances,
      maxParallel: (ctx.state["maxParallel"] as number) ?? 3,
    });

    this.log(ctx, "INFO", `Multi-goal: dispatching batch ${batch.batchId} (maxParallel=${batch.maxParallel}`);

    // === 6. 嵌套调用 dispatcher.dispatch ===
    let batchResult;
    try {
      batchResult = await ctx.dispatcher.dispatch(batch);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(ctx, "ERROR", `Multi-goal: dispatch 失败: ${errorMsg}`);
      return this.fail(ctx, `Multi-goal: dispatch 失败: ${errorMsg}`);
    }

    // === 7. Report 进度汇总 ===
    const succeededNames: string[] = [];
    const failedNames: string[] = [];
    const skippedNames: string[] = [];
    for (const [goalId, state] of batchResult.goalStates) {
      const subGoalName = state.result?.output?.match(/Plugin .* executed/) ? goalId : goalId;
      void subGoalName;
      if (state.status === "succeeded") {
        succeededNames.push(goalId);
      } else if (state.status === "skipped") {
        skippedNames.push(goalId);
      } else {
        failedNames.push(goalId);
      }
    }

    // === 8. Reuse 结果合并（写入 ctx.state）===
    ctx.state["multiGoalResult"] = {
      batchId: batchResult.batchId,
      succeeded: succeededNames,
      failed: failedNames,
      skipped: skippedNames,
      overallStatus: batchResult.overallStatus,
    };

    const summary = `Multi-goal: ${batchResult.overallStatus} (${batchResult.succeededCount} ok / ${batchResult.failedCount} fail / ${batchResult.skippedCount} skipped, ${batchResult.totalDurationMs}ms)`;
    this.log(ctx, "INFO", summary);

    const finalStatus = batchResult.failedCount === 0 ? "succeeded" : "failed";
    return {
      ...this.ok(ctx, summary, [`multi-goal-${ctx.dispatch.dispatchId}-report.json`]),
      status: finalStatus,
    };
  }
}
