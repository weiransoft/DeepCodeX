/**
 * EAG-P5 VerifyStageHandler P0 安全修复单元测试
 *
 * 覆盖范围：
 * - P0-7 verify-stage-handler 移除 shell:true，阻止命令注入
 * - 测试命令程序白名单校验
 * - 引号内元字符允许（合法 JS/Python 表达式）
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实的 P5VerifyStageHandler + 最小真实上下文
 * - 中文注释
 *
 * @module core/tests/verify-stage-handler-safety
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { P5VerifyStageHandler } from "../eag/p5/handlers/verify-stage-handler";
import type { createPassVerdict } from "../eag/p5/guards/types";
import type { P5StageContext, P5StageResult } from "../eag/p5/handlers/types";
import type { BlockerGuardChain } from "../eag/p5/guards/blocker-guard-chain";
import type { GuardChainResult, GuardContext, GuardRule } from "../eag/p5/guards/types";
import type { P5SmartConfirmation } from "../eag/p5/smart-confirmation";
import type { P5RunState } from "../eag/p5/run-state-store";

// ============================================================================
// 1. 最小上下文构造
// ============================================================================

function createTempProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eag-verify-safety-"));
  fs.mkdirSync(path.join(projectRoot, ".eag", "p5"), { recursive: true });
  return projectRoot;
}

function cleanupTempProject(projectRoot: string): void {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

function createFakeGuardChain(): BlockerGuardChain {
  return {
    execute: async (_ctx: GuardContext): Promise<GuardChainResult> =>
      Object.freeze({
        overallDecision: "PASS",
        triggeredGuards: [],
        firstDenial: undefined,
        durationMs: 0,
        allVerdicts: [],
      }),
    registerGuard: (_layer: string, _guard: GuardRule) => {},
  } as unknown as BlockerGuardChain;
}

function createFakeSmartConfirmation(): P5SmartConfirmation {
  return {
    decide: (_verdict: ReturnType<typeof createPassVerdict>, _command?: string) =>
      Object.freeze({ decision: "auto-approve" as const, reason: "" }),
  } as unknown as P5SmartConfirmation;
}

function createMinimalContext(
  projectRoot: string,
  testCommand: string,
  overrides?: Partial<P5StageContext>
): P5StageContext {
  const runState: P5RunState = {
    runId: "verify-safety-run",
    projectRoot,
    objective: "安全测试",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentLoop: "coding",
    iterIndex: 0,
    currentStage: "verify",
    completedStages: ["plan", "dev"],
    completedLoops: [],
    totalLlmCallCount: 0,
    totalTokensUsed: 0,
    maxIterations: 3,
    maxTokens: 50000,
    testCommand,
    testTimeoutSec: 30,
    loopReport: undefined,
  } as unknown as P5RunState;

  return {
    runId: "verify-safety-run",
    iterIndex: 0,
    stage: "verify",
    projectRoot,
    worktreePath: projectRoot,
    objective: "安全测试",
    currentPlan: "T-001 测试安全修复",
    notesSnapshot: "",
    prevResults: [],
    runState,
    guardChain: createFakeGuardChain(),
    smartConfirmation: createFakeSmartConfirmation(),
    tasksFilePath: path.join(projectRoot, ".eag", "p5", "tasks.md"),
    testCommand,
    testTimeoutSec: 30,
    loopType: "coding",
    ...overrides,
  } as P5StageContext;
}

// ============================================================================
// 2. P0-7 命令注入防护
// ============================================================================

test("P5VerifyStageHandler 正常执行 node 测试命令", async () => {
  const projectRoot = createTempProject();
  try {
    const handler = new P5VerifyStageHandler();
    const ctx = createMinimalContext(projectRoot, `node -e 'console.log("Tests: 1 passed, 0 failed")'`);
    const result = (await handler.handle(ctx)) as P5StageResult;
    assert.equal(result.kind, "success");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P5VerifyStageHandler 拒绝含分号命令链的测试命令", async () => {
  const projectRoot = createTempProject();
  try {
    const handler = new P5VerifyStageHandler();
    const ctx = createMinimalContext(projectRoot, `node -e 'console.log("ok")'; rm -rf /`);
    const result = (await handler.handle(ctx)) as P5StageResult;
    assert.equal(result.kind, "fatal");
    assert.match(result.error ?? "", /shell/);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P5VerifyStageHandler 拒绝含 && 命令链的测试命令", async () => {
  const projectRoot = createTempProject();
  try {
    const handler = new P5VerifyStageHandler();
    const ctx = createMinimalContext(projectRoot, `node -e 'console.log("ok")' && rm -rf /`);
    const result = (await handler.handle(ctx)) as P5StageResult;
    assert.equal(result.kind, "fatal");
    assert.match(result.error ?? "", /shell/);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P5VerifyStageHandler 拒绝含管道符的测试命令", async () => {
  const projectRoot = createTempProject();
  try {
    const handler = new P5VerifyStageHandler();
    const ctx = createMinimalContext(projectRoot, `node -e 'console.log("ok")' | cat`);
    const result = (await handler.handle(ctx)) as P5StageResult;
    assert.equal(result.kind, "fatal");
    assert.match(result.error ?? "", /shell/);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P5VerifyStageHandler 拒绝含 $() 命令替换的测试命令", async () => {
  const projectRoot = createTempProject();
  try {
    const handler = new P5VerifyStageHandler();
    const ctx = createMinimalContext(projectRoot, `node -e 'console.log("ok")' $(rm -rf /)`);
    const result = (await handler.handle(ctx)) as P5StageResult;
    assert.equal(result.kind, "fatal");
    assert.match(result.error ?? "", /shell/);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P5VerifyStageHandler 拒绝不在白名单的测试程序", async () => {
  const projectRoot = createTempProject();
  try {
    const handler = new P5VerifyStageHandler();
    const ctx = createMinimalContext(projectRoot, `curl http://example.com`);
    const result = (await handler.handle(ctx)) as P5StageResult;
    assert.equal(result.kind, "fatal");
    assert.match(result.error ?? "", /白名单/);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("P5VerifyStageHandler 允许引号内包含括号的合法 JS 表达式", async () => {
  const projectRoot = createTempProject();
  try {
    const handler = new P5VerifyStageHandler();
    const ctx = createMinimalContext(
      projectRoot,
      `node -e 'console.log("Tests: 1 passed, 0 failed"); function f() { return 1; }'`
    );
    const result = (await handler.handle(ctx)) as P5StageResult;
    assert.equal(result.kind, "success");
  } finally {
    cleanupTempProject(projectRoot);
  }
});
