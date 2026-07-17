/**
 * Resume 插件 - 断点续跑（V3 完整版）
 *
 * 支持从持久化 checkpoint 恢复执行
 * 来源：multi-agent-team skill scripts/plugins/resume.py
 *
 * 真实实现：
 *   1. 从 ctx.state.resumeFrom 加载 checkpoint（路径或 runId）
 *   2. 解析 checkpoint JSON（含 iteration / phaseResults / notes / testResults）
 *   3. 验证 checkpoint 完整性（schema 校验）
 *   4. 恢复到 ctx.state.runState（供后续 plugin 使用）
 *   5. 列出可 resume 的 run（通过 ctx.extensions.tools.listRuns）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BasePlugin } from "./base.js";
import type { DispatchResult, PluginContext } from "../types.js";

/** Checkpoint schema（持久化格式） */
export const CheckpointSchema = z.object({
  version: z.literal("1.0"),
  checkpointId: z.string().uuid(),
  runId: z.string(),
  goalId: z.string().optional(),
  objective: z.string().min(1),
  status: z.enum(["running", "succeeded", "failed", "aborted", "paused"]),
  currentPhase: z.enum(["plan", "dev", "verify", "fix"]).optional(),
  iteration: z.number().int().nonnegative(),
  maxIterations: z.number().int().positive(),
  startedAt: z.string(),
  updatedAt: z.string(),
  notes: z.string().default(""),
  phaseResults: z.record(z.string(), z.unknown()).default({}),
  testResults: z
    .object({
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .default({ passed: 0, failed: 0, total: 0 }),
  debtCount: z.number().int().nonnegative().default(0),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

export class ResumePlugin extends BasePlugin {
  constructor() {
    super();
    this.initializeMeta();
  }

  readonly meta = {
    name: "resume" as const,
    priority: 80,
    description: "Resume execution from persisted checkpoint with full state restoration",
    mutexWith: ["autonomous", "cancel"] as const,
    requiresTask: false,
    version: "1.0.0",
  };

  matches(ctx: PluginContext): boolean {
    return (
      ctx.state["resume"] === true || typeof ctx.state["resumeFrom"] === "string" || ctx.state["resumeLatest"] === true
    );
  }

  async execute(ctx: PluginContext): Promise<DispatchResult> {
    // === 1. dry-run 短路 ===
    if (ctx.dryRun) {
      this.log(ctx, "INFO", "Resume: 开始加载 checkpoint");
      return this.ok(ctx, "Resume: dry-run 短路", []);
    }

    const resumeFrom = (ctx.state["resumeFrom"] as string) ?? null;
    const resumeLatest = (ctx.state["resumeLatest"] as boolean) ?? false;
    const stateDir = (ctx.state["stateDir"] as string) ?? path.join(ctx.projectRoot, ".deepcodex", "runs");

    // === 2. 加载 checkpoint ===
    let checkpoint: Checkpoint | null = null;
    let source: "specified" | "latest" | "state" = "state";

    if (resumeFrom) {
      // 2.1 从指定路径加载
      checkpoint = loadCheckpointFromPath(path.join(stateDir, resumeFrom, "checkpoint.json"));
      source = "specified";
    } else if (resumeLatest) {
      // 2.2 加载最新可 resume 的 run
      checkpoint = loadLatestResumableCheckpoint(stateDir);
      source = "latest";
    } else {
      // 2.3 从 ctx.state 直接恢复（已在内存中）
      const inline = ctx.state["checkpoint"];
      if (inline) {
        const parsed = CheckpointSchema.safeParse(inline);
        if (parsed.success) {
          checkpoint = parsed.data;
        } else {
          this.log(ctx, "WARNING", `Resume: ctx.state.checkpoint 校验失败: ${parsed.error.message}`);
        }
      }
    }

    if (!checkpoint) {
      this.log(ctx, "INFO", "Resume: 无 checkpoint 可恢复，从头开始");
      return this.ok(ctx, "Resume: 无 checkpoint，从头开始", []);
    }

    // === 3. 验证 checkpoint 可恢复性 ===
    if (checkpoint.status === "succeeded") {
      this.log(ctx, "WARNING", `Resume: checkpoint ${checkpoint.checkpointId} 已 succeeded，无需 resume`);
      return this.ok(ctx, `Resume: checkpoint 已 succeeded，无需恢复`, []);
    }

    // === 4. 恢复到 ctx.state ===
    ctx.state["runState"] = {
      runId: checkpoint.runId,
      objective: checkpoint.objective,
      status: "running", // 恢复时重置为 running
      currentPhase: checkpoint.currentPhase ?? "plan",
      iteration: checkpoint.iteration,
      maxIterations: checkpoint.maxIterations,
      startedAt: checkpoint.startedAt,
      updatedAt: new Date().toISOString(),
      notes: checkpoint.notes,
      phaseResults: checkpoint.phaseResults,
      testResults: checkpoint.testResults,
      debtCount: checkpoint.debtCount,
    };

    ctx.state["resumedFrom"] = checkpoint.checkpointId;
    ctx.state["resumeSource"] = source;

    // === 5. 触发事件 ===
    ctx.events.push({
      type: "plugin.checkpoint",
      payload: {
        action: "restored",
        checkpointId: checkpoint.checkpointId,
        runId: checkpoint.runId,
        iteration: checkpoint.iteration,
      },
      timestamp: new Date().toISOString(),
    });

    this.log(
      ctx,
      "INFO",
      `Resume: restored checkpoint ${checkpoint.checkpointId} (runId=${checkpoint.runId}, iter=${checkpoint.iteration}/${checkpoint.maxIterations}, source=${source}`
    );

    return this.ok(ctx, `Resume: restored from ${checkpoint.checkpointId} (iteration ${checkpoint.iteration})`, [
      path.join(stateDir, checkpoint.runId, "checkpoint.json"),
    ]);
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从指定路径加载 checkpoint
 */
function loadCheckpointFromPath(checkpointPath: string): Checkpoint | null {
  try {
    if (!fs.existsSync(checkpointPath)) return null;
    const content = fs.readFileSync(checkpointPath, "utf-8");
    const parsed = JSON.parse(content);
    const validated = CheckpointSchema.safeParse(parsed);
    if (!validated.success) {
      // 校验失败不抛错，调用方降级到 fresh start
      return null;
    }
    return validated.data;
  } catch {
    return null;
  }
}

/**
 * 加载最新可 resume 的 checkpoint
 *
 * 规则：
 *   1. 遍历 stateDir 下所有子目录
 *   2. 读取每个子目录的 checkpoint.json
 *   3. 筛选 status in (running, failed, aborted) 的 checkpoint
 *   4. 按 updatedAt 降序，返回最新一个
 */
function loadLatestResumableCheckpoint(stateDir: string): Checkpoint | null {
  if (!fs.existsSync(stateDir)) return null;
  let latest: { checkpoint: Checkpoint; updatedAt: string } | null = null;

  for (const entry of fs.readdirSync(stateDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cp = loadCheckpointFromPath(path.join(stateDir, entry.name, "checkpoint.json"));
    if (!cp) continue;
    if (cp.status === "succeeded") continue;
    if (!latest || cp.updatedAt > latest.updatedAt) {
      latest = { checkpoint: cp, updatedAt: cp.updatedAt };
    }
  }

  return latest?.checkpoint ?? null;
}
