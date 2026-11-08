/**
 * EAG 全量审查修复（2026-11-08）补测：跨层诊断段 + 报告失败用例渲染
 *
 * 覆盖第 5 组实现但未验证的两项：
 * - D1~D3：SessionManager.getFailedAutonomousRunDiagnostics（Web 拦截提示的
 *   core 单一事实源）：命中真实失败记录时返回真实终止原因 / 失败用例；
 *   无记录 / 目标不匹配 / 真实诊断为空时返回空串（诚实降级，绝不编造）。
 * - R1~R4：EagAutonomousCommandHandler.formatSuccessReport 对
 *   AutonomousRunResult.failedTestIds 的渲染：合法非空数组输出「## 失败用例」；
 *   字段缺失 / 非数组 / 空数组 / 含非字符串或空白串时不编造该段。
 *
 * 测试策略：真实 SessionManager + 真实 EagAutonomousCommandHandler，
 * orchestrator 用实现接口的最小桩（与既有测试同构），不 mock 框架、不复制生产实现。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../session";
import type { AutonomousGoalRunDetails } from "../session";
import { EagAutonomousCommandHandler } from "../eag/cli/eag-autonomous-command";
import type { EagAutonomousRequest } from "../eag/cli/eag-autonomous-command";
import type { AutonomousOrchestrator } from "../eag/p5/autonomous-orchestrator";
import type { AutonomousRunRequest, AutonomousRunResult } from "../eag/p5/autonomous-orchestrator";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

function setHomeDir(dir: string): void {
  process.env.HOME = dir;
  if (process.platform === "win32") {
    process.env.USERPROFILE = dir;
  }
}

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** 构造真实 SessionManager（orchestrator 仅用于装配，本文件不驱动 run） */
function createManager(): SessionManager {
  const workspace = createTempDir("deepcode-diag-workspace-");
  const home = createTempDir("deepcode-diag-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const orchestrator = {
    run: async (_request: AutonomousRunRequest) => ({}) as AutonomousRunResult,
  } as unknown as AutonomousOrchestrator;

  return new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: {} as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text: string) => text,
    onAssistantMessage: () => {
      // 本文件不关心主会话输出
    },
    autonomousOrchestrator: orchestrator,
  });
}

/** 白盒播种终态记录（复用既有测试的私有方法可观察方式） */
function seedOutcome(
  manager: SessionManager,
  sessionId: string,
  goal: string,
  details?: Readonly<AutonomousGoalRunDetails>
): void {
  const writeOutcome = manager as unknown as {
    recordAutonomousRunOutcome: (
      sid: string,
      goal: string,
      status: string,
      details?: Readonly<AutonomousGoalRunDetails>
    ) => void;
  };
  writeOutcome.recordAutonomousRunOutcome(sessionId, goal, "failed", details);
}

// ============================================================================
// D 组：Web 拦截提示诊断段的 core 单一事实源
// ============================================================================

test("D1. 命中带真实诊断的失败 run → 诊断段含真实终止原因与失败用例名", async () => {
  const manager = createManager();
  const sessionId = await manager.createSession({ text: "" });
  const goal = "修复登录态过期问题";
  const details: AutonomousGoalRunDetails = {
    abortReason: "Token 预算耗尽：199221 >= 200000",
    failedTestIds: ["tests/test_auth.py::test_expired", "tests/test_auth.py::test_refresh"],
    testCommand: "pytest -q",
    runId: "run-diag-001",
  };
  seedOutcome(manager, sessionId, goal, details);

  const block = manager.getFailedAutonomousRunDiagnostics(sessionId, goal);
  assert.ok(block.includes("【上一轮诊断】"), "必须含诊断段标题");
  assert.ok(block.includes(details.abortReason!), "必须含真实终止原因，不得编造");
  assert.ok(block.includes("tests/test_auth.py::test_expired"), "必须含真实失败用例名");
  assert.ok(block.includes("tests/test_auth.py::test_refresh"), "必须含第二个真实失败用例名");
  assert.ok(block.includes("pytest -q"), "必须含真实测试命令");
  assert.equal(manager.hasFailedAutonomousRun(sessionId, goal), true, "守卫本身也应命中同一记录");
});

test("D2. 无失败记录 / 目标指纹不匹配 → 返回空串（诚实降级）", async () => {
  const manager = createManager();
  const sessionId = await manager.createSession({ text: "" });

  assert.equal(manager.getFailedAutonomousRunDiagnostics(sessionId, "从未运行过的目标"), "");

  seedOutcome(manager, sessionId, "目标 A", {
    abortReason: "确定性失败熔断",
    failedTestIds: ["tests/test_a.py::test_1"],
  });
  assert.equal(
    manager.getFailedAutonomousRunDiagnostics(sessionId, "完全不同的目标 B"),
    "",
    "goal 指纹不匹配时不得把别人的诊断挂到本目标上"
  );
});

test("D3. 失败记录存在但无真实诊断（旧会话）→ 返回空串，绝不编造终止原因", async () => {
  const manager = createManager();
  const sessionId = await manager.createSession({ text: "" });
  const goal = "旧会话遗留目标";
  seedOutcome(manager, sessionId, goal); // 无 details：abortReason / failedTestIds 均缺失

  assert.equal(manager.hasFailedAutonomousRun(sessionId, goal), true, "守卫仍能命中失败记录");
  const block = manager.getFailedAutonomousRunDiagnostics(sessionId, goal);
  assert.equal(block, "", "无真实诊断时不得输出任何编造的终止原因或用例名");
});

// ============================================================================
// R 组：formatSuccessReport 失败用例渲染（经 handler.execute 真实入口）
// ============================================================================

const BASE_REQUEST: EagAutonomousRequest = Object.freeze({
  goal: "验证失败用例报告渲染",
  maxIterations: 3,
  confirmation: "smart",
  testCommand: "npm test",
  stopWhen: "",
  maxTokens: 200000,
  testTimeoutSec: 600,
  consecutiveFailureAbort: 3,
});

/** 构造返回指定 runResult 的 orchestrator 桩（真实实现接口，非 mock 框架） */
function createOrchestratorReturning(overrides: Record<string, unknown>): AutonomousOrchestrator {
  const base: AutonomousRunResult = {
    runId: "run-render-001",
    finalStatus: "completed",
    exitCode: 0,
    completedLoops: [],
    milestones: [],
    totalIterations: 1,
    totalLlmCallCount: 1,
    totalTokensUsed: 100,
    durationSec: 1,
    finalReport: "测试桩最终报告",
    triggeredGuards: [],
  };
  const runResult = { ...base, ...overrides } as unknown as AutonomousRunResult;
  return {
    run: async (_request: AutonomousRunRequest) => runResult,
  } as unknown as AutonomousOrchestrator;
}

async function renderReport(overrides: Record<string, unknown>): Promise<string> {
  const handler = new EagAutonomousCommandHandler(createOrchestratorReturning(overrides));
  const projectRoot = createTempDir("deepcode-render-workspace-");
  const result = await handler.execute(BASE_REQUEST, projectRoot);
  assert.equal(result.success, true, "handler 必须真实执行成功（否则报告路径未触达）");
  return result.markdownReport;
}

test("R1. failedTestIds 含 2 个真实用例名 → 报告输出「## 失败用例」并逐条列出", async () => {
  const report = await renderReport({
    failedTestIds: ["tests/test_a.py::test_x", "tests/test_b.py::test_y"],
  });
  assert.ok(report.includes("## 失败用例"), "报告必须含失败用例段");
  assert.ok(report.includes("- tests/test_a.py::test_x"), "必须逐条列出第一个用例名");
  assert.ok(report.includes("- tests/test_b.py::test_y"), "必须逐条列出第二个用例名");
  assert.ok(report.includes("# [EAG Autonomous Loop] 执行结果"), "主报告其余部分不得被破坏");
});

test("R2. failedTestIds 缺失 / 空数组 → 不编造失败用例段", async () => {
  const missing = await renderReport({});
  assert.ok(!missing.includes("## 失败用例"), "字段缺失时不得输出该段");

  const empty = await renderReport({ failedTestIds: [] });
  assert.ok(!empty.includes("## 失败用例"), "空数组时不得输出该段");
});

test("R3. failedTestIds 非数组 → 不编造失败用例段", async () => {
  const notArray = await renderReport({ failedTestIds: "tests/test_a.py::test_x" });
  assert.ok(!notArray.includes("## 失败用例"), "字符串不得被当作用例清单渲染");

  const nullValue = await renderReport({ failedTestIds: null });
  assert.ok(!nullValue.includes("## 失败用例"), "null 不得被当作用例清单渲染");
});

test("R4. failedTestIds 含非字符串 / 空白串 → 过滤后按真实值渲染，全脏时不输出该段", async () => {
  const mixed = await renderReport({
    failedTestIds: [42, "  ", "", "tests/test_real.py::test_ok", null],
  });
  assert.ok(mixed.includes("## 失败用例"), "仍含 1 个合法用例名时应保留该段");
  assert.ok(mixed.includes("- tests/test_real.py::test_ok"), "必须列出真实合法用例名");
  assert.ok(!mixed.includes("- 42"), "不得把非字符串当用例名渲染");
  assert.ok(!mixed.includes("-   "), "不得把空白串当用例名渲染");

  const allDirty = await renderReport({ failedTestIds: [42, "  ", "", null] });
  assert.ok(!allDirty.includes("## 失败用例"), "无任何合法用例名时不得输出空段");
});
