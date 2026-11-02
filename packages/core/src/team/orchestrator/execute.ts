/**
 * 分层执行器：按拓扑层推进子任务，层内并发
 *
 * ## 三条不可让步的规则
 *
 * 1. **依赖失败必须传播**：一个子任务失败，依赖它的后继一律 `skipped`（带 `blockedBy`），
 *    不允许"假装成功"继续跑——那会让最终报告把半成品当成品。
 * 2. **预算必须硬扣**：`totalToolRounds` 是全局配额，扣完即停。编排可以少做事，
 *    不能默默多烧十倍成本。
 * 3. **单点失败不许炸整层**：`executeDispatch` 抛异常只标记该子任务 failed，
 *    同层兄弟继续。编排的价值就在于"部分成功也有产出"。
 *
 * ## 为什么轮次用闭包捕获而不是扩展 `DispatchResult`
 *
 * `executeDispatch` 的返回值不带 rounds / toolCalls（那是 runner 才知道的）。
 * 给它加字段会动 `team/types.ts` 的共享 schema，牵到 A 路线全部已验收路径。
 * 这里改成**每个子任务包一个自己的 runner 闭包**捕获这两个数——零侵入，
 * 且并发安全（每个子任务一个闭包，不共享变量）。
 *
 * @module team/orchestrator/execute
 */

import type { DispatchEventLog } from "../dispatch-event-log.js";
import { buildTask, executeDispatch, type DispatchOptions, type DispatchRunner } from "../team-adapter.js";
import type { RoleDefinition } from "../types.js";
import type {
  OrchestrationBudget,
  OrchestrationPlan,
  OrchestrationSubtaskResult,
  SubtaskNode,
  SubtaskStatus,
} from "./types.js";

/** 子任务进度事件（编排层 → 宿主） */
export type SubtaskProgressEvent =
  | { type: "subtask-start"; id: string; title: string; layer: number; totalLayers: number }
  | {
      type: "subtask-end";
      id: string;
      title: string;
      layer: number;
      status: SubtaskStatus;
      roleName: string | null;
      durationMs: number;
    };

/** 执行参数 */
export interface ExecuteLayersParams {
  plan: OrchestrationPlan;
  /** 实际执行的层（已含文件冲突下移） */
  layers: string[][];
  projectRoot: string;
  budget: OrchestrationBudget;
  /** 角色候选集（含运行时角色）；未传则仅内置 5 角色 */
  candidates?: ReadonlyArray<RoleDefinition>;
  /** 带工具轮次的执行器；未传则每个子任务退化为单次 LLM 调用 */
  runner?: DispatchRunner;
  injectedClient?: unknown;
  /** 编排级事件日志（子任务事件也可写入，靠 payload 区分） */
  eventLog?: DispatchEventLog | null;
  onProgress?: (event: SubtaskProgressEvent) => void;
  /** 中止信号（用户取消 / 宿主关闭） */
  signal?: AbortSignal;
}

/** 执行结果 */
export interface ExecuteLayersResult {
  results: OrchestrationSubtaskResult[];
  usedToolRounds: number;
}

/**
 * 执行全部层
 *
 * 返回的 `results` 按「实际执行顺序」排列（层优先，层内按声明顺序），
 * 便于报告与单测做确定断言。
 */
export async function executeLayers(params: ExecuteLayersParams): Promise<ExecuteLayersResult> {
  const { plan, layers, projectRoot, budget, candidates, runner, injectedClient, eventLog, onProgress } = params;

  const nodeById = new Map<string, SubtaskNode>(plan.subtasks.map((node) => [node.id, node]));
  const roleIds = new Set<string>((candidates ?? []).map((role) => role.roleId));
  /** 各子任务终态（用于依赖判定） */
  const statusById = new Map<string, SubtaskStatus>();
  const results: OrchestrationSubtaskResult[] = [];
  let remainingRounds = budget.totalToolRounds;
  let usedToolRounds = 0;

  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
    const layer = layers[layerIndex]!.filter((id) => nodeById.has(id));
    if (layer.length === 0) continue;

    await runWithConcurrency(layer, budget.maxParallel, async (id) => {
      const node = nodeById.get(id)!;
      const startedAt = Date.now();

      // ---- 中止检查：用户取消后不再发起新的派单 ------------------------------
      if (params.signal?.aborted) {
        const result: OrchestrationSubtaskResult = {
          id,
          title: node.title,
          roleId: null,
          roleName: null,
          status: "cancelled",
          output: "",
          error: "编排已被中止，该子任务未执行",
          layer: layerIndex,
          durationMs: 0,
          toolCalls: 0,
          rounds: 0,
        };
        statusById.set(id, "cancelled");
        results.push(result);
        onProgress?.({
          type: "subtask-end",
          id,
          title: node.title,
          layer: layerIndex,
          status: "cancelled",
          roleName: null,
          durationMs: 0,
        });
        return;
      }

      // ---- 依赖检查：任一前置未成功 → skipped --------------------------------
      const blockedBy = node.dependsOn.filter((dep) => {
        const status = statusById.get(dep);
        return status !== undefined && status !== "succeeded";
      });
      if (blockedBy.length > 0) {
        const result: OrchestrationSubtaskResult = {
          id,
          title: node.title,
          roleId: null,
          roleName: null,
          status: "skipped",
          output: "",
          error: `依赖未成功完成: ${blockedBy.join(", ")}`,
          layer: layerIndex,
          durationMs: 0,
          toolCalls: 0,
          rounds: 0,
          blockedBy,
        };
        statusById.set(id, "skipped");
        results.push(result);
        onProgress?.({
          type: "subtask-end",
          id,
          title: node.title,
          layer: layerIndex,
          status: "skipped",
          roleName: null,
          durationMs: 0,
        });
        return;
      }

      // ---- 预算：预扣后再执行 --------------------------------------------------
      // 必须在 await 之前**同步**预扣，否则并发的两个子任务会同时读到
      // `remaining > 0` 再各自扣减，超发最多 (maxParallel - 1) × maxToolRounds 轮。
      // 预扣额 = min(单任务上限, 剩余)；结束后按实际用量退还差额，
      // 既不超发，也不会因为「先占满额」而让后面的子任务假性饿死。
      const reservation = Math.min(budget.maxToolRounds, remainingRounds);
      if (reservation <= 0) {
        const result: OrchestrationSubtaskResult = {
          id,
          title: node.title,
          roleId: null,
          roleName: null,
          status: "skipped",
          output: "",
          error: `全局工具轮次预算已耗尽（totalToolRounds=${budget.totalToolRounds}）`,
          layer: layerIndex,
          durationMs: 0,
          toolCalls: 0,
          rounds: 0,
        };
        statusById.set(id, "skipped");
        results.push(result);
        onProgress?.({
          type: "subtask-end",
          id,
          title: node.title,
          layer: layerIndex,
          status: "skipped",
          roleName: null,
          durationMs: 0,
        });
        return;
      }
      remainingRounds -= reservation;

      // ---- 正常执行 --------------------------------------------------------
      onProgress?.({
        type: "subtask-start",
        id,
        title: node.title,
        layer: layerIndex,
        totalLayers: layers.length,
      });

      // roleHint 只有在候选集里真实存在时才转 forceRole：
      // dispatchToRole 对不存在的 forceRole 会抛错，而 roleHint 是 LLM 给的，
      // 幻觉角色名不该让整个子任务失败——退化为自动匹配即可。
      const forceRole =
        node.roleHint && roleIds.has(node.roleHint) ? { roleId: node.roleHint, reason: "拆解器建议角色" } : undefined;

      let capturedRounds = 0;
      let capturedToolCalls = 0;
      const wrappedRunner: DispatchRunner | undefined = runner
        ? async (context) => {
            const runResult = await runner(context);
            capturedRounds = runResult.rounds;
            capturedToolCalls = runResult.toolCalls.length;
            return runResult;
          }
        : undefined;

      const task = buildTask({
        title: node.title,
        description: node.description,
        ...(node.acceptance ? { constraints: [`完成判据: ${node.acceptance}`] } : {}),
      });

      const options: Partial<DispatchOptions> = {
        projectRoot,
        maxToolRounds: reservation,
        ...(candidates && candidates.length > 0 ? { candidates: [...candidates] } : {}),
        ...(wrappedRunner ? { runner: wrappedRunner } : {}),
        ...(injectedClient !== undefined ? { injectedClient } : {}),
        ...(forceRole ? { forceRole } : {}),
      };

      let result: OrchestrationSubtaskResult;
      try {
        const dispatchResult = await executeDispatch(task, options);
        const status = normalizeStatus(dispatchResult.status);
        // 实际消耗：runner 模式取真实轮次；单次 LLM 模式按 1 轮计（它确实调了一次模型）。
        // 不用 maxToolRounds 顶格计——那会让「3 个子任务各跑 2 轮」被记成 24 轮，预算假性耗尽。
        const consumed = capturedRounds > 0 ? capturedRounds : 1;
        // 退还预扣差额（consumed 可能大于 reservation——runner 自己也可能超限，
        // 此时差额为负，remaining 变负，后续子任务自然被跳过，仍不会无限超发）
        remainingRounds += reservation - consumed;
        usedToolRounds += consumed;

        result = {
          id,
          title: node.title,
          roleId: dispatchResult.matchedRole.roleId,
          roleName: dispatchResult.matchedRole.roleName,
          status,
          output: dispatchResult.output ?? "",
          ...(dispatchResult.error ? { error: dispatchResult.error } : {}),
          layer: layerIndex,
          durationMs: Date.now() - startedAt,
          toolCalls: capturedToolCalls,
          rounds: capturedRounds,
        };
      } catch (error) {
        // 异常路径没有可靠的轮次数据，整笔退还预扣（宁可少算，不可让后续子任务饿死）
        remainingRounds += reservation;
        const message = error instanceof Error ? error.message : String(error);
        result = {
          id,
          title: node.title,
          roleId: forceRole?.roleId ?? null,
          roleName: null,
          status: "failed",
          output: "",
          error: `派单异常: ${message}`,
          layer: layerIndex,
          durationMs: Date.now() - startedAt,
          toolCalls: 0,
          rounds: 0,
        };
      }

      statusById.set(id, result.status);
      results.push(result);
      onProgress?.({
        type: "subtask-end",
        id,
        title: node.title,
        layer: layerIndex,
        status: result.status,
        roleName: result.roleName,
        durationMs: result.durationMs,
      });

      try {
        eventLog?.append("orchestrate/subtask-end", {
          id,
          layer: layerIndex,
          status: result.status,
          roleId: result.roleId,
          rounds: result.rounds,
          toolCalls: result.toolCalls,
          durationMs: result.durationMs,
          ...(result.error ? { error: result.error } : {}),
        });
      } catch {
        // 审计设施不拖垮业务
      }
    });
  }

  // 稳定排序：层优先、层内按声明顺序（并发完成顺序不确定，报告不能因此抖动）
  const orderIndex = new Map<string, number>();
  plan.subtasks.forEach((node, index) => orderIndex.set(node.id, index));
  results.sort((a, b) => {
    if (a.layer !== b.layer) return a.layer - b.layer;
    return (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0);
  });

  return { results, usedToolRounds };
}

/** DispatchStatus → SubtaskStatus（pending/running 属于未完成，按 failed 处理） */
function normalizeStatus(status: string): SubtaskStatus {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      return "failed";
  }
}

/**
 * 并发受限的 map（worker pool）
 *
 * 不用 `Promise.all(chunks)`：分块会让「快任务等慢任务」拖长尾延迟，
 * worker pool 在任一 worker 空出时立刻取下一个。
 */
async function runWithConcurrency<T>(
  items: ReadonlyArray<T>,
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const workers = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) continue;
      await task(item);
    }
  });
  await Promise.all(workers);
}
