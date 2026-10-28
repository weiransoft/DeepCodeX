/**
 * EAG-P5 任务卡租约（task-lease）回归测试（2026-10-20 R3 修复配套）
 *
 * 事故背景（run 68acea2de182 × 90611ca5db4e）：并发 run 的 plan 3.5 AUTO 守卫把
 * 对方在途执行的 AUTO 卡 blocked 落盘，blocked 在本地规则下是单向门，被误伤的
 * run 下一轮 plan 直接判 tasks-blocked 死锁。
 *
 * 覆盖：
 * - LEASE-1 writeP5TaskLease / readForeignActiveLeaseTaskIds / removeP5TaskLease 全链路；
 * - LEASE-2 僵尸租约（mtime 超 TTL）不再避让；
 * - LEASE-3 自身租约排除；损坏租约文件跳过；目录缺失返回空集；
 * - LEASE-4 plan 3.5 守卫端到端：他 run 存活租约声明的无关 AUTO 卡不被 blocked，
 *   本 run fail-closed 透出"他 run 在途"诚实成因。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  writeP5TaskLease,
  removeP5TaskLease,
  readForeignActiveLeaseTaskIds,
  p5LeasePath,
  P5_LEASE_TTL_MS,
} from "../eag/p5/task-lease";
import { P5PlanStageHandler } from "../eag/p5/handlers/plan-stage-handler";
import { createDefaultBlockerGuardChain } from "../eag/p5/guards/blocker-guard-chain";
import { P5SmartConfirmation } from "../eag/p5/smart-confirmation";
import type { P5StageContext } from "../eag/p5/handlers/types";

// ============================================================================
// 工具
// ============================================================================

function createTempProject(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, ".eag", "p5"), { recursive: true });
  return dir;
}

function cleanup(projectRoot: string): void {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

// ============================================================================
// LEASE-1 全链路：写入 → 他 run 可见 → 删除后不可见
// ============================================================================

test("LEASE-1 租约写入→外部可见→删除后不可见", () => {
  const projectRoot = createTempProject("eag-lease-1-");
  try {
    writeP5TaskLease(projectRoot, { runId: "runA", objective: "目标A", taskCardId: "T-033", iterIndex: 0 });
    const leaseFile = p5LeasePath(projectRoot, "runA");
    assert.ok(fs.existsSync(leaseFile), "租约文件必须落盘");

    // 从 runB 视角：runA 的在途卡可见
    const foreign = readForeignActiveLeaseTaskIds(projectRoot, "runB");
    assert.ok(foreign.has("T-033"), "他 run 存活租约的在途卡必须可见");

    // runA 自身视角：排除自身
    const self = readForeignActiveLeaseTaskIds(projectRoot, "runA");
    assert.equal(self.size, 0, "自身租约必须排除");

    removeP5TaskLease(projectRoot, "runA");
    const after = readForeignActiveLeaseTaskIds(projectRoot, "runB");
    assert.equal(after.size, 0, "删除后不可见");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// LEASE-2 僵尸租约过期不再避让
// ============================================================================

test("LEASE-2 mtime 超过 TTL 的僵尸租约不再计入在途集合", () => {
  const projectRoot = createTempProject("eag-lease-2-");
  try {
    writeP5TaskLease(projectRoot, { runId: "runDead", objective: "崩溃 run", taskCardId: "T-009", iterIndex: 3 });
    const leaseFile = p5LeasePath(projectRoot, "runDead");
    // 把 mtime 拨到 TTL + 60s 之前，模拟崩溃残留
    const stale = (Date.now() - P5_LEASE_TTL_MS - 60_000) / 1000;
    fs.utimesSync(leaseFile, stale, stale);

    const foreign = readForeignActiveLeaseTaskIds(projectRoot, "runLive");
    assert.equal(foreign.size, 0, "僵尸租约（mtime 超 TTL）必须视为无主");

    // 显式 TTL 放宽后仍可见（TTL 参数生效）
    const widened = readForeignActiveLeaseTaskIds(projectRoot, "runLive", P5_LEASE_TTL_MS * 2);
    assert.ok(widened.has("T-009"), "放宽 TTL 后同一租约应重新可见");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// LEASE-3 容错：目录缺失 / 损坏文件 / 非法内容
// ============================================================================

test("LEASE-3 容错：目录缺失返回空集；损坏租约跳过；null taskCardId 不计入", () => {
  const projectRoot = createTempProject("eag-lease-3-");
  try {
    // 目录缺失
    assert.equal(readForeignActiveLeaseTaskIds(projectRoot, "runX").size, 0, "目录缺失 → 空集");

    fs.mkdirSync(path.join(projectRoot, ".eag", "p5", "leases"), { recursive: true });
    // 损坏 JSON
    fs.writeFileSync(path.join(projectRoot, ".eag", "p5", "leases", "bad.json"), "{ not json", "utf8");
    // 合法但 taskCardId=null（存活声明）
    fs.writeFileSync(
      path.join(projectRoot, ".eag", "p5", "leases", "null.json"),
      JSON.stringify({ runId: "runNull", objective: "", taskCardId: null, iterIndex: 0, updatedAt: "" }),
      "utf8"
    );
    // 正常租约
    writeP5TaskLease(projectRoot, { runId: "runOk", objective: "ok", taskCardId: "T-100", iterIndex: 0 });

    const foreign = readForeignActiveLeaseTaskIds(projectRoot, "runSelf");
    assert.deepEqual([...foreign], ["T-100"], "损坏/null 租约跳过，正常租约计入");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// LEASE-4 plan 3.5 守卫端到端：他 run 在途的无关 AUTO 卡不被 blocked
// ============================================================================

test("LEASE-4 plan 3.5 守卫：他 run 存活租约在途卡不被 blocked，fail-closed 透出在途成因", async () => {
  const projectRoot = createTempProject("eag-lease-4-");
  try {
    // 与本轮 objective 完全无关的旧 AUTO 卡（旧行为：3.5 守卫直接 blocked 落盘）
    fs.writeFileSync(
      path.join(projectRoot, ".eag", "p5", "tasks.md"),
      [
        "# 任务清单",
        "",
        "## T-001 拉取最新 deepcodex 代码并编译安装",
        "- requirement: AUTO",
        "- status: pending",
        "- dependencies:",
        "",
      ].join("\n"),
      "utf8"
    );
    // 他 run 声明 T-001 在途
    writeP5TaskLease(projectRoot, {
      runId: "other-run",
      objective: "另一目标",
      taskCardId: "T-001",
      iterIndex: 0,
    });

    const handler = new P5PlanStageHandler();
    const ctx = Object.freeze({
      runId: "self-run",
      iterIndex: 0,
      stage: "plan",
      projectRoot,
      worktreePath: projectRoot,
      objective: "为订单服务增加退款接口",
      currentPlan: "",
      notesSnapshot: "",
      prevResults: Object.freeze([]),
      // 2026-10-21 起避让路径可继续走到护栏上下文构造（buildGuardContext 读
      // runState.maxIterations），夹具必须给完整 runState（真实运行由编排器注入）
      runState: Object.freeze({
        runId: "self-run",
        projectRoot,
        objective: "为订单服务增加退款接口",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentLoop: "coding",
        iterIndex: 0,
        currentStage: "plan",
        completedStages: Object.freeze([]),
        completedLoops: Object.freeze([]),
        totalLlmCallCount: 0,
        totalTokensUsed: 0,
        consecutiveFailures: 0,
        maxIterations: 10,
        maxTokens: 200000,
        stopWhen: "",
        status: "running",
        lastGuardTriggered: null,
        localChecksum: "sha256:test",
        cumulativeChecksum: "sha256:test",
      }),
      guardChain: createDefaultBlockerGuardChain({ throwOnDeny: false }),
      smartConfirmation: new P5SmartConfirmation(),
      tasksFilePath: path.join(projectRoot, ".eag", "p5", "tasks.md"),
      testCommand: "",
      testTimeoutSec: 30,
      loopType: "coding" as const,
      taskExecutor: null,
      abortFlagPath: path.join(projectRoot, ".eag", "p5", "abort.flag"),
      logger: null,
    }) as unknown as P5StageContext;

    const result = await handler.handle(ctx);

    // 核心断言 1：T-001 在磁盘上必须仍是 pending（未被 blocked）
    const disk = fs.readFileSync(path.join(projectRoot, ".eag", "p5", "tasks.md"), "utf8");
    assert.ok(disk.includes("- status: pending"), "在途卡不得被 blocked 落盘（磁盘必须仍 pending）");
    assert.ok(!disk.includes("- status: blocked"), "磁盘不得出现 blocked");

    // 核心断言 2（2026-10-21 语义演进，双并发 E2E 驱动）：避让不等于空转——
    // 本 run 视野剔除在途卡后无卡可做时，走合成路径为本 run 的 objective 落
    // 新卡并选中执行（两 run 并行推进），而不是 fail-closed 空转被熔断冤杀。
    assert.equal(result.kind, "success", `避让后必须为本 run 合成目标卡并成功选卡，实际 ${result.kind}`);
    const taskCard = result.artifacts["taskCard"] as { id: string; title: string } | null;
    assert.ok(
      taskCard !== null && taskCard.title.includes("退款接口"),
      `必须选中本 run 目标的合成卡，实际：${JSON.stringify(taskCard)}`
    );
    assert.ok(
      !disk.includes("T-001") || /## T-001[\s\S]*?- status: pending/.test(disk),
      "新卡落盘不得改动对方在途卡状态"
    );
  } finally {
    cleanup(projectRoot);
  }
});
