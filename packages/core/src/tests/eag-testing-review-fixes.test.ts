/**
 * EAG 全量审查修复定向测试（第 2 组：testing 失败证据链 / coverage-gate PKC 吞错 / dependency-scanner 诚实降级）
 *
 * 覆盖：
 * - ① 测试子进程 stderr 含 AssertionError 时 TestExecutionResult 保留 stderr / 失败用例名，
 *   并进入 G-7 上下文（buildGateG7Context）与 PR 描述（generatePrDescription）；
 *   JSON 解析失败时保留原始 stdout/stderr 片段而不是「failedCount=1 却不带原因」。
 * - ② PKC 查询抛错时 highRiskSymbols 维度不判达标、CoverageReport 标注「PKC 不可用」、
 *   门禁不误通过（passed=false）。
 * - ③ 全部 package.json 解析失败时 DependencyScanner 返回 status="unknown"（含 evidence），
 *   绝不返回 passed。
 * - ④ P0-4 收尾：默认 tap reporter / EAG_LEGACY_JSON_REPORTER=1 回退 json；
 *   真实 node --test --test-reporter=tap 输出（TAP13，含 YAML 诊断块）喂入
 *   buildTestExecutionResult 能解析出失败用例名与 AssertionError 证据。
 * - 附带回归：PKC 正常返回空时旧语义不变；各环境变量回退开关；PR 头部展示层；
 *   CoverageGapChecker 按 unknown 处理；pkcQueryRiskHotspotsSafe 真正接入 PKC；
 *   LLM 真实用量包装器累加计数。
 *
 * 测试约定：node:test + node:assert/strict；使用真实 InMemory* 实现与真实 fs I/O，
 * 不放宽任何断言、不伪造通过。
 *
 * @module core/tests/eag-testing-review-fixes
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

import {
  TestingOrchestrator,
  buildTestExecutionResult,
  buildTestRunnerArgs,
} from "../eag/testing/testing-orchestrator";
import { CoverageGate, computeHighRiskSymbolsCoverage, type CoverageGateRequest } from "../eag/testing/coverage-gate";
import { GateG6Checker } from "../eag/gate/gate-g6-checker";
import { GateG7Checker } from "../eag/gate/gate-g7-checker";
import { CoverageGapChecker } from "../eag/testing/static-checkers/coverage-gap-checker";
import { DependencyScanner } from "../eag/coding/static-checkers/dependency-scanner";
import type { GateG7Context } from "../eag/gate/gate-types";
import type { RedlineDefinition } from "../eag/evaluator/types";
import type { LLMClient, LLMRequest, LLMUsage } from "../providers/llm-provider";
import type {
  AcceptanceCriterion,
  CoverageReport,
  E2eTestSpec,
  GeneratedTestFile,
  PkcAccessor,
  TestExecutionResultWithEvidence,
  TestQualityResult,
  TestingLoopRequest,
  UncoveredSymbol,
} from "../eag/testing/types";
import { DEFAULT_COVERAGE_THRESHOLD } from "../eag/testing/types";
import { InMemoryLLMClient } from "../eag/coding/llm-filler";
import {
  InMemoryPkcAccessor,
  createE2eTestSpec,
  createTestingLoopRequest,
  unifiedRealResponseGenerator,
} from "./fixtures/eag-testing-orch-fixtures";

// ============================================================================
// 共享夹具
// ============================================================================

/**
 * 在仓库根目录内创建临时目录。
 *
 * 原因：executeSingleTestFile 以 `cwd=projectRoot` 执行 `node --import tsx ...`，
 * ESM 会从 cwd 逐级向上查找 node_modules；放在仓库根目录内才能解析到 tsx。
 * 若放到 os.tmpdir() 则 tsx 解析失败，测不到「真实子进程」路径。
 */
function createRepoTmpDir(): string {
  return fs.mkdtempSync(path.join(process.cwd(), ".eag-review-fixes-"));
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

/** 构造最小可用的 CoverageReport（各测试按需覆写） */
function makeCoverageReport(overrides: Partial<CoverageReport> = {}): CoverageReport {
  return {
    lines: 95,
    branches: 90,
    functions: 95,
    highRiskSymbols: 100,
    uncoveredHighRiskSymbols: [],
    uncoveredFiles: [],
    passed: true,
    failedDimensions: [],
    rawReport: {},
    ...overrides,
  };
}

/** 构造合法 c8 JSON 报告（各数值维度均高于默认阈值，便于隔离 PKC 维度） */
function makeC8RawReport(): string {
  return JSON.stringify({
    total: { lines: 100, statements: 100, functions: 50, branches: 80 },
    covered: { lines: 95, statements: 95, functions: 48, branches: 78 },
    pct: { lines: 95, statements: 95, functions: 95, branches: 90 },
    uncoveredFiles: [],
  });
}

function makeCoverageGateRequest(overrides: Partial<CoverageGateRequest> = {}): CoverageGateRequest {
  return {
    projectRoot: "/tmp/eag-review-fixes-project",
    testDir: "tests/",
    implementationRoot: "src/",
    topN: 10,
    consecutiveFailureCount: 0,
    // 注入预采集 c8 报告，跳过 c8 spawn（本环境未安装 c8），确定性覆盖门禁判定
    c8RawReport: makeC8RawReport(),
    ...overrides,
  };
}

/**
 * 真实抛错的 PKC 访问器（非 mock：真实实现 PkcAccessor 协议，方法真实抛错）
 */
class ThrowingPkcAccessor implements PkcAccessor {
  async queryBusinessFlows(): Promise<ReadonlyArray<E2eTestSpec>> {
    throw new Error("PKC 数据库连接失败");
  }
  async queryRiskHotspots(): Promise<ReadonlyArray<UncoveredSymbol>> {
    throw new Error("PKC 数据库连接失败");
  }
  async queryL1GlobalView(): Promise<Readonly<Record<string, unknown>>> {
    throw new Error("PKC 数据库连接失败");
  }
}

/** 构造一个携带失败证据链的执行结果（真实结构，不伪造通过） */
function makeEvidenceResult(): TestExecutionResultWithEvidence {
  const report = JSON.stringify({
    tests: [
      { name: "should reject invalid order", status: "fail" },
      { name: "should accept valid order", status: "pass" },
    ],
  });
  const stderr = [
    "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
    "",
    "1 !== 2",
    "",
    "    at TestContext.<anonymous> (order.contract.test.ts:12:5)",
  ].join("\n");
  return buildTestExecutionResult("tests/contract/order.contract.test.ts", 1, 128, report, stderr);
}

/**
 * 访问 TestingOrchestrator 私有方法的结构类型（只用于单测，不修改生产可见性）
 */
type OrchestratorPrivates = {
  executeSingleTestFile(filePath: string, projectRoot: string): Promise<TestExecutionResultWithEvidence>;
  generatePrDescription(input: {
    readonly contractTests: ReadonlyArray<GeneratedTestFile>;
    readonly e2eTests: ReadonlyArray<GeneratedTestFile>;
    readonly coverageReport: CoverageReport;
    readonly compatibilityReport: null;
    readonly acceptanceCriteria: ReadonlyArray<AcceptanceCriterion>;
    readonly humanCheckpointFlows: ReadonlyArray<E2eTestSpec>;
    readonly testQualityResults: ReadonlyArray<TestQualityResult>;
    readonly contractTestResults?: ReadonlyArray<TestExecutionResultWithEvidence>;
    readonly e2eTestResults?: ReadonlyArray<TestExecutionResultWithEvidence>;
  }): string;
  buildGateG7Context(
    request: TestingLoopRequest,
    overrides: {
      readonly coverageReport: CoverageReport;
      readonly contractTests: ReadonlyArray<GeneratedTestFile>;
      readonly contractTestResults: ReadonlyArray<TestExecutionResultWithEvidence>;
      readonly e2eTests: ReadonlyArray<GeneratedTestFile>;
      readonly e2eTestResults: ReadonlyArray<TestExecutionResultWithEvidence>;
      readonly prDescription: string;
    }
  ): GateG7Context;
  pkcQueryRiskHotspotsSafe(
    projectRoot: string,
    pkcAccessor: PkcAccessor,
    topN: number
  ): Promise<{ readonly symbols: ReadonlyArray<UncoveredSymbol>; readonly available: boolean }>;
  wrapLlmClientWithUsage(inner: LLMClient, onUsage: (usage: LLMUsage | null) => void): LLMClient;
};

function makeOrchestrator(): { orchestrator: TestingOrchestrator; priv: OrchestratorPrivates } {
  const pkc = new InMemoryPkcAccessor([createE2eTestSpec()], []);
  const orchestrator = new TestingOrchestrator({
    coverageGate: new CoverageGate(pkc),
    gateG6Checker: new GateG6Checker(),
    gateG7Checker: new GateG7Checker(),
  });
  return { orchestrator, priv: orchestrator as unknown as OrchestratorPrivates };
}

/** generatePrDescription 的最小入参 */
function makePrInput(
  overrides: Record<string, unknown> = {}
): Parameters<OrchestratorPrivates["generatePrDescription"]>[0] {
  return {
    contractTests: [],
    e2eTests: [],
    coverageReport: makeCoverageReport(),
    compatibilityReport: null,
    acceptanceCriteria: [],
    humanCheckpointFlows: [],
    testQualityResults: [],
    ...overrides,
  } as Parameters<OrchestratorPrivates["generatePrDescription"]>[0];
}

/** 环境变量临时设置助手（自动恢复） */
async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const original = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
}

/**
 * 真实 spawn `node --test --test-reporter=tap <file>`，收集 stdout/stderr/退出码。
 *
 * 用于 ④-a：把「真实子进程输出」喂给纯函数 buildTestExecutionResult（纯函数喂入，
 * 非走 executeSingleTestFile 的端到端路径；后者由 ①-f 覆盖）。
 * 显式剔除 NODE_TEST_CONTEXT，避免父级 node:test 运行器让嵌套 spawn 递归跳过测试。
 */
function spawnNodeForTap(fileAbsPath: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn("node", ["--test", "--test-reporter=tap", fileAbsPath], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer | string) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer | string) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code: number | null) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

// ============================================================================
// ① 测试执行失败证据链（P0-4）
// ============================================================================

test("①-a: stderr 含 AssertionError 时结果保留 stderr / 失败用例名 / errorMessage", () => {
  const result = makeEvidenceResult();

  assert.equal(result.filePath, "tests/contract/order.contract.test.ts");
  assert.equal(result.exitCode, 1, "失败测试退出码非 0");
  assert.equal(result.failedCount, 1, "应统计 1 个失败用例");
  assert.equal(result.passedCount, 1, "应统计 1 个通过用例");
  assert.ok(result.stderr, "stderr 必须保留（旧实现收集却从不读取）");
  assert.ok(result.stderr!.includes("AssertionError"), "stderr 必须含 AssertionError 原文");
  assert.ok(result.stderr!.includes("1 !== 2"), "stderr 必须含断言失败详情");
  assert.ok(result.failedCases, "失败用例名列表必须保留");
  assert.ok(
    result.failedCases!.some((n) => n.includes("should reject invalid order")),
    "失败用例名必须是真实用例名（旧实现丢弃 name）"
  );
  assert.ok(result.errorMessage, "失败原因必须存在");
  assert.ok(result.errorMessage!.includes("AssertionError"), "errorMessage 必须透传 AssertionError");
  assert.ok(result.errorMessage!.includes("should reject invalid order"), "errorMessage 必须含失败用例名");
});

test("①-b: NDJSON（test:fail 事件流）同样提取失败用例名", () => {
  const ndjson = [
    JSON.stringify({ type: "test:pass", data: { name: "case A" } }),
    JSON.stringify({ type: "test:fail", data: { name: "case B fails" } }),
    JSON.stringify({ type: "test:fail", data: {} }),
  ].join("\n");
  const result = buildTestExecutionResult("t.test.ts", 1, 10, ndjson, "AssertionError: boom");
  assert.equal(result.passedCount, 1);
  assert.equal(result.failedCount, 2);
  assert.ok(result.failedCases!.includes("case B fails"));
  assert.ok(
    result.failedCases!.some((n) => n.includes("未命名用例")),
    "无名用例应标注而非静默丢弃"
  );
  assert.ok(result.stderr!.includes("AssertionError"));
});

test("①-c: JSON 解析失败时保留原始 stdout/stderr 片段并写明原因（不简化）", () => {
  const raw = "NOT JSON <<<fatal: reporter crashed>>>";
  const stderr = "AssertionError [ERR_ASSERTION]: raw crash output";
  const result = buildTestExecutionResult("t.test.ts", 7, 42, raw, stderr);

  assert.equal(result.failedCount, 1, "解析失败按退出码退化统计");
  assert.equal(result.passedCount, 0);
  assert.ok(result.stdoutSnippet, "必须保留原始 stdout 片段");
  assert.ok(result.stdoutSnippet!.includes("fatal: reporter crashed"), "stdout 片段必须含原始内容");
  assert.ok(result.stderr!.includes("AssertionError"), "stderr 必须保留");
  assert.ok(result.errorMessage, "必须写明失败原因，而非无理由的 failedCount=1");
  assert.ok(result.errorMessage!.includes("既非合法 JSON"), "errorMessage 应说明解析失败原因");
  assert.ok(result.errorMessage!.includes("AssertionError"), "errorMessage 应透传 stderr 证据");
});

test("①-d: 失败证据进入 generatePrDescription（PR 描述）", () => {
  const { priv } = makeOrchestrator();
  const evidence = makeEvidenceResult();
  const pr = priv.generatePrDescription(
    makePrInput({
      contractTestResults: [evidence],
      e2eTestResults: [],
    })
  );

  assert.ok(pr.includes("## 测试执行失败证据"), "PR 应含失败证据专段");
  assert.ok(pr.includes("AssertionError"), "PR 应含 AssertionError 原文");
  assert.ok(pr.includes("1 !== 2"), "PR 应含断言失败详情");
  assert.ok(pr.includes("should reject invalid order"), "PR 应含失败用例名");
  assert.ok(pr.includes("tests/contract/order.contract.test.ts"), "PR 应含失败文件路径");
});

test("①-e: 失败证据进入 G-7 上下文（buildGateG7Context）", () => {
  const { priv } = makeOrchestrator();
  const evidence = makeEvidenceResult();
  const request = createTestingLoopRequest({ projectRoot: "/tmp/eag-review-fixes-g7" });
  const ctx = priv.buildGateG7Context(request, {
    coverageReport: makeCoverageReport(),
    contractTests: [],
    contractTestResults: [evidence],
    e2eTests: [],
    e2eTestResults: [],
    prDescription: "## 变更摘要\n\n## 需求映射\n\n## 测试报告\n\n## 合规证据\n",
  });

  assert.equal(ctx.contractTestResults.length, 1);
  const carried = ctx.contractTestResults as ReadonlyArray<TestExecutionResultWithEvidence>;
  assert.equal(carried[0].exitCode, 1, "真实失败不得被改成通过");
  assert.ok(carried[0].stderr!.includes("AssertionError"), "G-7 上下文应携带 stderr 证据");
  assert.ok(carried[0].failedCases!.some((n) => n.includes("should reject invalid order")));
  assert.ok(carried[0].errorMessage!.includes("AssertionError"));
});

test("①-f: 真实子进程（默认 tap）端到端解析出失败用例名与 AssertionError 证据", async () => {
  // 本轮 P0-4 收尾同步调整断言：默认 reporter 由 json 改为 tap 后，本用例不再走
  // 「JSON 解析失败 + stdoutSnippet 保留」旧路径，而是走 TAP13 解析，故把断言从
  // 「stderr 非空 / stdoutSnippet 存在」升级为「真实 spawn 解析出失败用例名 + stdout
  // YAML 块的 AssertionError 进入证据链」。用例本身保留，未删除、未放宽为 success。
  const { priv } = makeOrchestrator();
  const projectRoot = createRepoTmpDir();
  try {
    const testFileRel = "deliberate-failure.evidence.test.ts";
    fs.writeFileSync(
      path.join(projectRoot, testFileRel),
      [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'test("deliberate assertion failure", () => {',
        '  try { assert.equal(1, 2, "values should be equal"); }',
        "  catch (e) { process.stderr.write(`AssertionError [ERR_ASSERTION]: ${e instanceof Error ? e.message : String(e)}\\n`); throw e; }",
        "});",
      ].join("\n"),
      "utf-8"
    );

    const result = await priv.executeSingleTestFile(testFileRel, projectRoot);

    assert.notEqual(result.exitCode, 0, "失败测试子进程退出码应非 0");
    assert.equal(result.failedCount, 1, "默认 tap 下应解析出 1 个失败用例");
    assert.ok(
      result.failedCases && result.failedCases.some((n) => n.includes("deliberate assertion failure")),
      "端到端真实 spawn 应解析出真实失败用例名（旧 json reporter 永远取不到）"
    );
    assert.ok(
      result.errorMessage && result.errorMessage.includes("AssertionError"),
      "TAP stdout YAML 块的 AssertionError 应进入 errorMessage，不能只依赖 stderr"
    );
    // TAP 把 AssertionError 写在 stdout 的 YAML 块而非 stderr，证据必须能从 stdout 侧取到
    const evidence = [result.errorMessage, result.stdoutSnippet, result.stderr].filter(Boolean).join("\n");
    assert.ok(evidence.includes("1 !== 2") || evidence.includes("values should be equal"), "断言失败详情应进入证据链");
  } finally {
    cleanupDir(projectRoot);
  }
});

// ============================================================================
// ② PKC 吞错 → 覆盖率恒 100（P0-5）
// ============================================================================

test("②-a: computeHighRiskSymbolsCoverage PKC 不可用时返回 0 而非 100", () => {
  assert.equal(computeHighRiskSymbolsCoverage([], [], { pkcUnavailable: true }), 0);
  // 兼容性：未提供 options 的旧两参调用，空数组仍返回 100（合法「无必测约束」）
  assert.equal(computeHighRiskSymbolsCoverage([], []), 100);
});

test("②-b: PKC 查询抛错 → 该维度不判达标且门禁不误通过", async () => {
  const gate = new CoverageGate(new ThrowingPkcAccessor());
  const report = await gate.check(makeCoverageGateRequest());

  assert.equal(report.passed, false, "PKC 不可用（信息不足）时门禁不得判通过");
  assert.ok(report.failedDimensions.includes("highRiskSymbols"), "highRiskSymbols 维度必须记为未达标");
  assert.equal(report.highRiskSymbols, 0, "空数组不得被解释为 100% 覆盖率");
  assert.equal(report.pkcUnavailable, true, "报告必须显式标注 PKC 不可用");
  assert.ok(report.pkcError && report.pkcError.includes("PKC 数据库连接失败"), "必须记录 PKC 错误证据");
});

test("②-c: 对照 — PKC 正常返回空时旧语义不变（passed=true，无回归）", async () => {
  const gate = new CoverageGate(new InMemoryPkcAccessor([], []));
  const report = await gate.check(makeCoverageGateRequest());

  assert.equal(report.passed, true, "PKC 真实返回空时不应误阻断");
  assert.equal(report.highRiskSymbols, 100);
  assert.equal(report.failedDimensions.length, 0);
  assert.equal(report.pkcUnavailable, undefined);
});

test("②-d: EAG_COVERAGE_PKC_LENIENT=1 可回退到旧宽松语义", async () => {
  await withEnv("EAG_COVERAGE_PKC_LENIENT", "1", async () => {
    const gate = new CoverageGate(new ThrowingPkcAccessor());
    const report = await gate.check(makeCoverageGateRequest());
    assert.equal(report.passed, true, "回退开关启用时恢复旧语义");
    assert.equal(report.pkcUnavailable, undefined);
  });
  // 关闭开关后恢复诚实降级
  await withEnv("EAG_COVERAGE_PKC_LENIENT", undefined, async () => {
    const gate = new CoverageGate(new ThrowingPkcAccessor());
    const report = await gate.check(makeCoverageGateRequest());
    assert.equal(report.passed, false);
  });
});

// ============================================================================
// ③ dependency-scanner 全部解析失败不得报 passed（P1）
// ============================================================================

const SEC01_REDLINE = { id: "TCS-SEC-01" } as unknown as RedlineDefinition;

test("③-a: 全部 package.json 解析失败 → status=unknown（非 passed）", () => {
  const scanner = new DependencyScanner();
  const result = scanner.check(
    [
      { path: "package.json", content: "{ this is NOT valid json }" },
      { path: "services/package.json", content: "<<< broken >>>" },
    ],
    SEC01_REDLINE
  );

  assert.notEqual(result.status, "passed", "无法判定绝不得报 passed（用户红线）");
  assert.equal(result.status, "unknown", "应为 unknown（对齐 strict-evaluator 降级模式）");
  assert.ok(result.evidence, "unknown 必须附 evidence");
  assert.ok(result.evidence!.includes("解析失败"), "evidence 应说明解析失败");
  assert.ok(result.evidence!.includes("package.json"), "evidence 应含失败文件");
  assert.equal(result.violations.length, 0);
});

test("③-b: 对照 — 合法 package.json 且无已知漏洞 → passed（无回归）", () => {
  const scanner = new DependencyScanner();
  const result = scanner.check(
    [
      {
        path: "package.json",
        content: JSON.stringify({ name: "app", dependencies: { lodash: "^4.17.21" } }),
      },
    ],
    SEC01_REDLINE
  );
  assert.equal(result.status, "passed");
});

test("③-c: 对照 — 含已知高危漏洞依赖 → violated（真实违规仍可检出）", () => {
  const scanner = new DependencyScanner();
  const result = scanner.check(
    [
      {
        path: "package.json",
        content: JSON.stringify({ name: "app", dependencies: { lodash: "4.17.20" } }),
      },
    ],
    SEC01_REDLINE
  );
  assert.equal(result.status, "violated");
  assert.ok(result.violations.length > 0);
});

test("③-d: EAG_DEPENDENCY_SCANNER_LENIENT=1 可回退到旧语义", async () => {
  await withEnv("EAG_DEPENDENCY_SCANNER_LENIENT", "1", () => {
    const scanner = new DependencyScanner();
    const result = scanner.check([{ path: "package.json", content: "{ broken" }], SEC01_REDLINE);
    assert.equal(result.status, "passed", "回退开关启用时恢复旧语义");
  });
  await withEnv("EAG_DEPENDENCY_SCANNER_LENIENT", undefined, () => {
    const scanner = new DependencyScanner();
    const result = scanner.check([{ path: "package.json", content: "{ broken" }], SEC01_REDLINE);
    assert.equal(result.status, "unknown", "关闭开关后恢复诚实降级");
  });
});

// ============================================================================
// P1 其它确证项回归
// ============================================================================

test("P1-a: PR 头部改用 failedDimensions 判定并列出未达标维度", () => {
  const { priv } = makeOrchestrator();
  // 首次失败 WARNING：passed=true 但 failedDimensions 非空——旧实现会误显示「✅ 通过」
  const report = makeCoverageReport({ passed: true, failedDimensions: ["lines", "branches"] });
  const pr = priv.generatePrDescription(makePrInput({ coverageReport: report }));

  assert.ok(pr.includes("❌ 未通过"), "有未达标维度时必须显示未通过");
  assert.ok(!pr.includes("✅ 通过"), "不得再误显示通过");
  assert.ok(pr.includes("未达标维度：lines, branches"), "必须列出未达标维度");
});

test("P1-b: EAG_PR_DISPLAY_LEGACY=1 可回退 PR 头部旧文案（不改门禁策略）", async () => {
  await withEnv("EAG_PR_DISPLAY_LEGACY", "1", () => {
    const { priv } = makeOrchestrator();
    const report = makeCoverageReport({ passed: true, failedDimensions: ["lines"] });
    const pr = priv.generatePrDescription(makePrInput({ coverageReport: report }));
    assert.ok(pr.includes("✅ 通过"), "回退开关启用时恢复旧 passed 判定文案");
  });
});

test("P1-c: PKC 不可用时报告在 PR 中显式标注「PKC 不可用」", () => {
  const { priv } = makeOrchestrator();
  const report = makeCoverageReport({
    passed: false,
    failedDimensions: ["highRiskSymbols"],
    highRiskSymbols: 0,
    pkcUnavailable: true,
    pkcError: "PKC 数据库连接失败",
  });
  const pr = priv.generatePrDescription(makePrInput({ coverageReport: report }));
  assert.ok(pr.includes("PKC 不可用"), "PR 应显式标注 PKC 不可用");
  assert.ok(pr.includes("PKC 数据库连接失败"), "PR 应含 PKC 错误证据");
});

test("P1-d: CoverageGapChecker 在 PKC unknown 时按 unknown 处理（不得空转判 passed）", () => {
  const checker = new CoverageGapChecker();
  const unknownResult = checker.check([], {
    highRiskSymbols: [],
    projectRoot: "/tmp/x",
    highRiskSymbolsUnknown: true,
  });
  assert.equal(unknownResult.passed, false, "信息不足不得判 passed");
  assert.equal(unknownResult.severity, "warning", "诚实记录但不升级为 blocker");
  assert.ok(unknownResult.violations.length > 0);
  assert.ok(unknownResult.violations[0].description.includes("unknown"));

  // 对照：PKC 可用且真实返回空 → 仍可判 passed（无回归）
  const normalResult = checker.check([], {
    highRiskSymbols: [],
    projectRoot: "/tmp/x",
  });
  assert.equal(normalResult.passed, true);
});

test("P1-e: pkcQueryRiskHotspotsSafe 真正接入 PKC，失败显式标 unknown", async () => {
  const { priv } = makeOrchestrator();
  const symbol: UncoveredSymbol = {
    symbolId: "src/A.ts:A.f",
    filePath: "src/A.ts",
    reason: "high-risk-no-test",
    riskScore: 0.9,
  };

  const ok = await priv.pkcQueryRiskHotspotsSafe("/tmp/x", new InMemoryPkcAccessor([], [symbol]), 5);
  assert.equal(ok.available, true, "真正查询成功标 available");
  assert.equal(ok.symbols.length, 1, "应拿到真实风险热点（旧实现恒空）");
  assert.equal(ok.symbols[0].symbolId, "src/A.ts:A.f");

  const bad = await priv.pkcQueryRiskHotspotsSafe("/tmp/x", new ThrowingPkcAccessor(), 5);
  assert.equal(bad.available, false, "查询失败必须显式标不可用");
  assert.equal(bad.symbols.length, 0);
});

test("P1-f: LLM 用量包装器累加真实计数；无 usage 时如实记 0", async () => {
  const { priv } = makeOrchestrator();
  const realClient = new InMemoryLLMClient(unifiedRealResponseGenerator);

  let calls = 0;
  let tokens = 0;
  const wrapped = priv.wrapLlmClientWithUsage(realClient, (usage) => {
    calls += 1;
    if (usage) {
      tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    }
  });
  const req = {
    messages: [{ role: "user", content: "请为以下 API 接口生成契约测试：/api/v1/tasks/T-001" }],
  } as unknown as LLMRequest;
  const response = await wrapped.createMessage(req);

  assert.equal(calls, 1, "应记录 1 次真实调用");
  assert.equal(tokens, 300, "应累加真实 usage（200 + 100），而非恒 0");
  assert.equal(response.usage?.inputTokens, 200);

  // 无 usage 时如实记 0，绝不编造
  const nullUsageClient = new InMemoryLLMClient(() => ({
    content: "{}",
    thinking: "",
    toolCalls: [],
    stopReason: "stop",
    usage: null,
  }));
  let nullCalls = 0;
  let nullTokens = 0;
  const wrappedNull = priv.wrapLlmClientWithUsage(nullUsageClient, (usage) => {
    nullCalls += 1;
    if (usage) nullTokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  });
  await wrappedNull.createMessage(req);
  assert.equal(nullCalls, 1);
  assert.equal(nullTokens, 0, "取不到真实 token 时如实记 0，不编造");
});

test("P1-g: 旧调用方零回归 — TestExecutionResultWithEvidence 结构兼容 G-7 必填字段", () => {
  const result = makeEvidenceResult();
  // G-7 checker 消费的 5 个必填字段类型不变（旧调用方零回归）
  assert.equal(typeof result.filePath, "string");
  assert.equal(typeof result.exitCode, "number");
  assert.equal(typeof result.durationMs, "number");
  assert.equal(typeof result.failedCount, "number");
  assert.equal(typeof result.passedCount, "number");

  // 新证据字段一律可选：无失败 / 无 stderr 时不应出现
  const minimal = buildTestExecutionResult("t.test.ts", 0, 1, JSON.stringify({ tests: [] }), "");
  assert.equal(minimal.stderr, undefined);
  assert.equal(minimal.failedCases, undefined);
  assert.equal(minimal.errorMessage, undefined);
  assert.equal(minimal.stdoutSnippet, undefined);
  assert.equal(minimal.passedCount, 0);
  assert.equal(minimal.failedCount, 0);
});

// ============================================================================
// ④ P0-4 收尾：默认 tap reporter / 回退开关 / TAP13 证据链
// ============================================================================

test("④-a: 真实 node --test --test-reporter=tap 输出喂入 buildTestExecutionResult（1 pass + 1 fail）", async () => {
  const dir = createRepoTmpDir();
  try {
    const mjsRel = "tap-evidence.test.mjs";
    const mjsAbs = path.join(dir, mjsRel);
    fs.writeFileSync(
      mjsAbs,
      [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'test("should accept valid order", () => { assert.equal(1, 1); });',
        'test("should reject invalid order", () => { assert.equal(1, 2, "values should be equal"); });',
      ].join("\n"),
      "utf-8"
    );

    // 真实 spawn（非 mock）：产出真正的 TAP13 stdout/stderr，再喂给纯函数
    const real = await spawnNodeForTap(mjsAbs);
    assert.notEqual(real.exitCode, 0, "含 1 个失败用例时子进程退出码应非 0");

    const result = buildTestExecutionResult(mjsRel, real.exitCode, 0, real.stdout, real.stderr);
    assert.equal(result.passedCount, 1, "应解析出 1 个通过用例");
    assert.equal(result.failedCount, 1, "应解析出 1 个失败用例");
    assert.ok(
      result.failedCases && result.failedCases.some((n) => n.includes("should reject invalid order")),
      "failedCases 必须含真实失败用例名"
    );
    // TAP 把 AssertionError 写在 stdout 的 YAML 块而非 stderr（实测 stderr 为空），
    // 故错误文本证据必须能从 errorMessage / stdoutSnippet 取到，不能只依赖 stderr
    const errorText = [result.errorMessage, result.stdoutSnippet, result.stderr].filter(Boolean).join("\n");
    assert.ok(errorText.length > 0, "错误文本证据必须非空");
    assert.ok(
      /AssertionError|values should be equal|1 !== 2/.test(errorText),
      "错误文本证据应含 TAP YAML 块的断言失败详情"
    );
  } finally {
    cleanupDir(dir);
  }
});

test("④-b: 默认命令为 --test-reporter=tap；EAG_LEGACY_JSON_REPORTER=1 回退 json", async () => {
  // 可观察点：命令构造纯函数 buildTestRunnerArgs（executeSingleTestFile 真实调用它），
  // 直接断言构造出的命令字符串，不引入任何 mock 框架。
  const defaultArgs = buildTestRunnerArgs("x.test.ts");
  assert.ok(defaultArgs.includes("--test-reporter=tap"), "默认应使用 Node 内置 tap reporter");
  assert.ok(!defaultArgs.includes("--test-reporter=json"), "默认不应再用不可用的 json reporter");
  assert.ok(defaultArgs.includes("--import") && defaultArgs.includes("tsx"), "保留 tsx 加载器");

  await withEnv("EAG_LEGACY_JSON_REPORTER", "1", () => {
    const legacyArgs = buildTestRunnerArgs("x.test.ts");
    assert.ok(legacyArgs.includes("--test-reporter=json"), "回退开关启用时恢复旧 json 命令");
    assert.ok(!legacyArgs.includes("--test-reporter=tap"), "回退时不应再是 tap");
  });

  const restoredArgs = buildTestRunnerArgs("x.test.ts");
  assert.ok(restoredArgs.includes("--test-reporter=tap"), "关闭开关后恢复默认 tap");
});

test("④-c: EAG_LEGACY_JSON_REPORTER=1 下真实 executeSingleTestFile 回到 json reporter（拿不到报告）", async () => {
  // 端到端佐证：回退开关确实影响真实 spawn 命令——json reporter 在本环境不可用，
  // 子进程会抛 ERR_MODULE_NOT_FOUND / Cannot find package 'json' 且 stderr 被保留。
  const { priv } = makeOrchestrator();
  const dir = createRepoTmpDir();
  try {
    const rel = "legacy-json.test.ts";
    fs.writeFileSync(
      path.join(dir, rel),
      ['import { test } from "node:test";', 'test("always passes", () => {});'].join("\n"),
      "utf-8"
    );

    await withEnv("EAG_LEGACY_JSON_REPORTER", "1", async () => {
      const result = await priv.executeSingleTestFile(rel, dir);
      const evidence = [result.stderr, result.errorMessage, result.stdoutSnippet].filter(Boolean).join("\n");
      assert.ok(
        evidence.includes("Cannot find package 'json'") || evidence.includes("ERR_MODULE_NOT_FOUND"),
        `回退 json reporter 时应出现 json 不可用的真实报错证据，实际证据：${evidence.slice(0, 200)}`
      );
    });
  } finally {
    cleanupDir(dir);
  }
});

test("④-d: TAP13 跳过 # 注释 / YAML 块 / 1..N 计划行，且 YAML 诊断进证据", () => {
  const tap = [
    "TAP version 13",
    "# Subtest: should accept valid order",
    "ok 1 - should accept valid order",
    "  ---",
    "  duration_ms: 0.2",
    "  ...",
    "# Subtest: should reject invalid order",
    "not ok 2 - should reject invalid order",
    "  ---",
    "  failureType: 'testCodeFailure'",
    "  error: |-",
    "    values should be equal",
    "    1 !== 2",
    "  name: 'AssertionError'",
    "  stack: |-",
    "    at TestContext.<anonymous> (x.test.ts:9:10)",
    "  ...",
    "1..2",
    "# tests 2",
    "# pass 1",
    "# fail 1",
  ].join("\n");

  const result = buildTestExecutionResult("x.test.ts", 1, 5, tap, "");
  assert.equal(result.passedCount, 1, "# 注释 / 计划行 / YAML 块不得被误计为用例");
  assert.equal(result.failedCount, 1);
  assert.deepEqual(result.failedCases, ["should reject invalid order"]);
  assert.equal(result.stderr, undefined, "TAP 下 stderr 为空（证据来自 stdout YAML 块）");
  assert.ok(result.errorMessage && result.errorMessage.includes("AssertionError"), "YAML 块 name 应进 errorMessage");
  assert.ok(result.errorMessage!.includes("1 !== 2"), "YAML 块 error 文本应进 errorMessage");
  assert.ok(
    result.stdoutSnippet && result.stdoutSnippet.includes("values should be equal"),
    "YAML 诊断应进 stdoutSnippet"
  );
});
