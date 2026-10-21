/**
 * EAG-P5 双并发 run 端到端回归测试（2026-10-21，R3 租约修复的事故 1:1 复演）
 *
 * 事故（run 68acea2de182 × 90611ca5db4e）：同一 projectRoot 两个 /eag-autonomous
 * run 并发，plan 3.5 AUTO 守卫把对方正在 dev 执行的 AUTO 卡 blocked 落盘，
 * blocked 是单向门 → 被误伤的 run 下一轮判 tasks-blocked 死锁。
 *
 * 复演：Run A 慢速执行 T-001（stub executor sleep 4s，期间租约声明在途）；
 * Run B（无关 objective）在 A 在途窗口内启动。修复后必须：
 * 1. T-001 全程不被 B 写 blocked（含 150ms 瞬态采样）；
 * 2. B 触发租约避让，并排除在途卡后并行执行自己的合成卡（真正并发推进）；
 * 3. 两 run 都 completed，退出后租约清空（finally 清理生效）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { AutonomousOrchestrator } from "../eag/p5/autonomous-orchestrator";
import { createP5LoopExecutorFromHandlers } from "../eag/p5/loop-executor";
import { P5PlanStageHandler } from "../eag/p5/handlers/plan-stage-handler";
import { createDevStageHandler } from "../eag/p5/handlers/dev-stage-handler";
import { createVerifyStageHandler } from "../eag/p5/handlers/verify-stage-handler";
import { createFixStageHandler } from "../eag/p5/handlers/fix-stage-handler";
import { P5RunStateStore } from "../eag/p5/run-state-store";
import { P5NotesMemory } from "../eag/p5/notes-memory";
import { createDefaultBlockerGuardChain } from "../eag/p5/guards/blocker-guard-chain";
import { P5SmartConfirmation } from "../eag/p5/smart-confirmation";
import type { P5TaskExecutor } from "../eag/p5/handlers/task-executor-port";
import type { P5TaskExecutionResult } from "../eag/p5/handlers/task-executor-port";

const OBJECTIVE_A = "为订单服务实现退款接口并补齐单元测试";
const OBJECTIVE_B = "把站内所有页面的页脚版权年份更新为 2026";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("E2E-CONC 双并发 run：A 在途期间 B 租约避让不 blocked 对方卡，且各自并行完成（run 68acea2de182 事故复演）", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eag-conc-e2e-"));
  fs.mkdirSync(path.join(projectRoot, ".eag", "p5"), { recursive: true });
  // 单张 AUTO 卡：标题 = objective A（B 视角完全无关——复刻"两 objective
  // 互视对方卡为无关旧卡"的事故局面）
  fs.writeFileSync(
    path.join(projectRoot, ".eag", "p5", "tasks.md"),
    [
      "# 任务清单",
      "",
      `## T-001 ${OBJECTIVE_A}`,
      "- requirement: AUTO",
      "- status: pending",
      "- dependencies:",
      "",
    ].join("\n"),
    "utf8"
  );

  const makeExecutor = (devDelayMs: number): P5TaskExecutor =>
    ({
      async executeTask(input: { taskId: string }): Promise<P5TaskExecutionResult> {
        await sleep(devDelayMs);
        return {
          success: true,
          summary: `任务 ${input.taskId} 已由替身执行完成`,
          tokensUsed: 100,
          tokensEstimated: true,
          llmRequests: 1,
          changedFiles: ["src/generated-by-stub.ts"],
        } as P5TaskExecutionResult;
      },
    }) as unknown as P5TaskExecutor;

  const makeOrchestrator = (logs: string[]): AutonomousOrchestrator => {
    const orch = new AutonomousOrchestrator({
      loopExecutor: createP5LoopExecutorFromHandlers(
        new P5PlanStageHandler(),
        createDevStageHandler(),
        createVerifyStageHandler(),
        createFixStageHandler()
      ),
      runStateStore: new P5RunStateStore(),
      notesMemory: new P5NotesMemory(),
      guardChain: createDefaultBlockerGuardChain({ throwOnDeny: false }),
      smartConfirmation: new P5SmartConfirmation(),
      defaultTestCommand: 'node -e "process.exit(0)"',
      defaultTestTimeoutSec: 10,
      logger: (msg: string, level: string) => {
        logs.push(`[${level}] ${msg}`);
      },
    });
    return orch;
  };

  const logsA: string[] = [];
  const logsB: string[] = [];
  const orchA = makeOrchestrator(logsA);
  const orchB = makeOrchestrator(logsB);
  orchA.bindTaskExecutor(makeExecutor(4000)); // A：慢速 dev，拉长在途窗口
  orchB.bindTaskExecutor(makeExecutor(200));

  const tasksPath = path.join(projectRoot, ".eag", "p5", "tasks.md");
  // 瞬态采样：每 150ms 检查 T-001 是否被写 blocked（含"写了又改回"的瞬态）
  const blockedSamples: number[] = [];
  const sampler = setInterval(() => {
    try {
      const m = /## T-001[\s\S]*?- status: (\S+)/.exec(fs.readFileSync(tasksPath, "utf8"));
      if (m && m[1] === "blocked") blockedSamples.push(Date.now());
    } catch {
      // 半截文件窗口忽略
    }
  }, 150);

  try {
    const runAPromise = orchA.run({ projectRoot, objective: OBJECTIVE_A, maxIterations: 3 });
    // B 延迟启动：确保 A 已选中 T-001 进入 dev（租约声明在途）
    const runBPromise = sleep(1200).then(() => orchB.run({ projectRoot, objective: OBJECTIVE_B, maxIterations: 3 }));
    const [resultA, resultB] = await Promise.all([runAPromise, runBPromise]);

    const finalTasks = fs.readFileSync(tasksPath, "utf8");
    const bLog = logsB.join("\n");
    const leasesDir = path.join(projectRoot, ".eag", "p5", "leases");
    const leasesRemaining = fs.existsSync(leasesDir)
      ? fs.readdirSync(leasesDir).filter((f) => f.endsWith(".json"))
      : [];

    // 1. 对方在途卡全程不被 blocked（含瞬态）
    assert.equal(blockedSamples.length, 0, `T-001 在并发期被写 blocked ${blockedSamples.length} 次（租约避让失效）`);
    // 2. B 触发租约避让留痕
    assert.ok(bLog.includes("租约避让"), `B 必须走租约避让路径，B 日志尾部：${bLog.slice(-400)}`);
    // 3. 两个 run 都真实完成（各自消费各自的卡，互不干扰）
    assert.equal(
      resultA.finalStatus,
      "completed",
      `A 必须 completed，实际 ${resultA.finalStatus}：${logsA.slice(-4).join(";")}`
    );
    assert.equal(
      resultB.finalStatus,
      "completed",
      `B 必须 completed（避让后并行执行自己的卡），实际 ${resultB.finalStatus}：${bLog.slice(-400)}`
    );
    assert.match(finalTasks, /## T-001[\s\S]*?- status: completed/, "A 的目标卡必须真实执行并标 completed");
    assert.match(
      finalTasks,
      /## T-002[\s\S]*?- status: completed/,
      "B 的合成卡必须真实执行并标 completed（并发推进证据）"
    );
    // 4. run 退出后租约清空（finally 清理）
    assert.deepEqual(leasesRemaining, [], "两 run 退出后不得残留租约文件");
  } finally {
    clearInterval(sampler);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
