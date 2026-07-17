/**
 * DeepCodeX 多角色团队 - Plugins 公共 API
 *
 * 统一导出所有插件相关 API
 * 严格遵循 user rules：禁止 mock/占位/简化
 */

// 基类与契约
export { BasePlugin, validatePluginContracts } from "./base.js";
export type { PluginMeta } from "./base.js";

// Dispatcher 与 Registry
export {
  GoalDispatcher,
  PluginRegistry,
  GoalInstance,
  GoalBatch,
  DispatcherOptions,
  topologicalLevels,
  makeGoal,
  makeBatch,
} from "./goal-dispatcher.js";
export type { GoalState, BatchResult } from "./goal-dispatcher.js";

// 7 个内置插件
export { AutonomousPlugin } from "./autonomous.js";
export type {
  RunStateData,
  AutonomousLoopConfig,
  AutonomousPhaseKind,
  PhaseHandler,
  PhaseResult,
} from "./autonomous.js";

export { MultiGoalPlugin } from "./multi-goal.js";
export type { SubGoalSpec } from "./multi-goal.js";

export { GraphPlugin } from "./graph.js";
export type { GraphNode } from "./graph.js";

export { LoopPlugin } from "./loop.js";
export type { LoopStep, ExitPredicate } from "./loop.js";

export { ResumePlugin } from "./resume.js";
export type { Checkpoint } from "./resume.js";
export { CheckpointSchema } from "./resume.js";

export { CancelPlugin } from "./cancel.js";

/**
 * 内置插件注册表（与 multi-agent-team BUILTIN_PLUGINS 对齐）
 *
 * 注意：priority 不可重复（DESTROY 0 / READONLY 10 / STATE_MUTUATION 20-30 / LOOP 40-50 / AUTONOMOUS 200）
 * 当前 6 个插件优先级不冲突
 */
import { AutonomousPlugin } from "./autonomous.js";
import { MultiGoalPlugin } from "./multi-goal.js";
import { GraphPlugin } from "./graph.js";
import { LoopPlugin } from "./loop.js";
import { ResumePlugin } from "./resume.js";
import { CancelPlugin } from "./cancel.js";
import type { GoalCommandPlugin } from "../types.js";

export const BUILTIN_PLUGINS: ReadonlyArray<GoalCommandPlugin> = [
  new AutonomousPlugin(),
  new MultiGoalPlugin(),
  new GraphPlugin(),
  new LoopPlugin(),
  new ResumePlugin(),
  new CancelPlugin(),
];
