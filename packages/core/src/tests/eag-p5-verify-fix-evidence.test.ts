/**
 * EAG-P5 verify 失败证据 / fix 反馈回灌 单测（2026-11-03 run b64490b8ad78 事故修复）
 *
 * 事故现象：verify 报 "23 passed, 1 failed"，fix 两轮执行后失败指纹完全一致，
 * 触发确定性失败熔断（同卡 + 相同失败连续 2 次）。
 *
 * 根因：verify 只保留测试输出前 2000 字符（head-only），fix 再取其中前 500 字符，
 * 而真实 runner（pytest/unittest/jest/mocha/node --test）的失败详情都在输出尾部
 * → fix 模型看不到失败用例与断言 → 只能重复相同实现 → 相同失败。
 *
 * 本文件覆盖四组契约：
 * - A 组：parseTestOutput 多格式统计（含 node:test、unittest、"failed 在前"逆序汇总）
 * - B 组：buildTestOutputSummary 失败窗口优先（尾部证据不丢、长度受控）
 * - C 组：extractFailedTestIds 五类失败用例标识提取（去重、保序、上限）
 * - D 组：verify 失败制品含失败用例；fix 反馈含失败用例段落与文件清单上限
 *
 * 测试约定（对齐项目规则 NFR-8/NFR-9/NFR-10）：
 * - node:test + node:assert/strict，禁止 mock 框架；
 * - 端到端用例使用真实文件系统与真实 child_process（verify 内部 spawnSync）；
 * - 执行器为"仅替代 LLM 网络"的测试替身，且本文件用它捕获真实回灌的 feedback 文本。
 *
 * @module core/tests/eag-p5-verify-fix-evidence
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { P5VerifyStageHandler, P5FixStageHandler, createSuccessStageResult } from "../eag/p5/index";
import type { P5TaskExecutionInput, P5TaskExecutionResult, P5TaskExecutor } from "../eag/p5/index";
import { buildTestOutputSummary, extractFailedTestIds, parseTestOutput } from "../eag/p5/handlers/test-output-analysis";

import {
  buildStageContext,
  cleanupTempProject,
  createTasksFile,
  createTempProject,
  createTestTaskCard,
} from "./fixtures/eag-p5-e2e-fixtures";

// ============================================================================
// 真实 runner 输出样本（本机 node --test 实测抓取，非构造猜测）
// ============================================================================

/** node:test（TAP）真实汇总块：注意 # suites 行插在 # tests 与 # pass 之间 */
const NODE_TEST_FAIL_OUTPUT = [
  "TAP version 13",
  "# Subtest: ok1",
  "ok 1 - ok1",
  "  ---",
  "  duration_ms: 0.34",
  "  type: 'test'",
  "  ...",
  "# Subtest: linear-binary",
  "not ok 3 - linear-binary",
  "  ---",
  "  duration_ms: 0.38",
  "  failureType: 'testCodeFailure'",
  "  error: 'LinearDesign 容器内二进制缺失'",
  "  code: 'ERR_ASSERTION'",
  "  name: 'AssertionError'",
  "  ...",
  "1..3",
  "# tests 3",
  "# suites 0",
  "# pass 2",
  "# fail 1",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 59.9",
].join("\n");

/** pytest 风格汇总：failed 在前（旧正则会把它解析成 failed=0） */
const PYTEST_FAIL_FIRST_OUTPUT = "...........F.....\n1 failed, 23 passed in 0.85s";

/** unittest 真实汇总：只有 Ran N tests + FAILED (failures=X)，没有 passed 计数 */
const UNITTEST_OUTPUT = [
  "FAIL: test_binary_missing (tests.test_zz_linear.TL)",
  "----------------------------------------------------------------------",
  "AssertionError: False is not true : LinearDesign 容器内二进制缺失",
  "",
  "----------------------------------------------------------------------",
  "Ran 24 tests in 0.025s",
  "",
  "FAILED (failures=1)",
].join("\n");

// ============================================================================
// A 组：测试结果统计解析
// ============================================================================

test("A1. node:test 汇总块（含 # suites 插入行）解析为 2 passed / 1 failed", () => {
  const stats = parseTestOutput(NODE_TEST_FAIL_OUTPUT, "");
  assert.equal(stats.parser, "node-test", "应命中 node-test 解析器");
  assert.equal(stats.passed, 2, "passed 应为 2");
  assert.equal(stats.failed, 1, "failed 应为 1");
  assert.equal(stats.total, 3, "total 应为 3");
});

test("A2. pytest 逆序汇总（1 failed, 23 passed）解析为 23 passed / 1 failed", () => {
  const stats = parseTestOutput(PYTEST_FAIL_FIRST_OUTPUT, "");
  assert.equal(stats.passed, 23, "passed 应为 23（逆序汇总不能被解析成 0）");
  assert.equal(stats.failed, 1, "failed 应为 1（旧实现解析为 0）");
  assert.equal(stats.parser, "generic-failed-first", "应命中逆序汇总解析器");
});

test("A3. unittest 汇总（Ran 24 tests + FAILED (failures=1)）解析为 23 passed / 1 failed", () => {
  const stats = parseTestOutput(UNITTEST_OUTPUT, "");
  assert.equal(stats.parser, "unittest", "应命中 unittest 解析器");
  assert.equal(stats.failed, 1, "failed 应为 1");
  assert.equal(stats.passed, 23, "passed 应为 23（ran - failed）");
});

test("A4. Jest / Mocha 既有格式不回退", () => {
  const jest = parseTestOutput("Tests: 12 passed, 0 failed, 2 skipped", "");
  assert.equal(jest.parser, "jest");
  assert.equal(jest.passed, 12);
  assert.equal(jest.skipped, 2);

  const mocha = parseTestOutput("12 passing (34ms)\n1 failing\n3 pending", "");
  assert.equal(mocha.parser, "mocha");
  assert.equal(mocha.passed, 12);
  assert.equal(mocha.failed, 1);
  assert.equal(mocha.skipped, 3);
});

test("A5. 无可解析计数时诚实返回 unknown（不臆造计数）", () => {
  const stats = parseTestOutput("build finished, nothing to report", "");
  assert.equal(stats.parser, "unknown");
  assert.equal(stats.passed, 0);
  assert.equal(stats.failed, 0);
});

test("A6. Vitest（竖线分隔）与 Jest 失败在前的汇总均可解析", () => {
  const vitestFail = parseTestOutput("      Tests  1 failed | 23 passed (24)", "");
  assert.equal(vitestFail.parser, "vitest");
  assert.equal(vitestFail.passed, 23);
  assert.equal(vitestFail.failed, 1);

  const vitestPass = parseTestOutput("      Tests  24 passed | 0 failed (24)", "");
  assert.equal(vitestPass.passed, 24);
  assert.equal(vitestPass.failed, 0);

  const jestFailFirst = parseTestOutput("Tests: 1 failed, 23 passed, 24 total", "");
  assert.equal(jestFailFirst.failed, 1, "jest 失败在前时 failed 不应丢");
  assert.equal(jestFailFirst.passed, 23);
});

test("A7. 通过轮输出中夹带 fixture 文本（1 failed, 23 passed）不应被误判为失败", () => {
  // 复现架构评审 T5：本仓库大量 E2E 用例会打印该统计串，若通用正则在全文匹配，
  // exitCode=0 的通过轮会被判失败。此处把该串放在尾部窗口之外的头部。
  const output = [
    "fixture 输出：Tests: 0 passed, 1 failed",
    "fixture 输出：1 failed, 23 passed",
    "A".repeat(5000),
    "24 passed",
  ].join("\n");
  const stats = parseTestOutput(output, "");
  assert.equal(stats.failed, 0, "尾部真实汇总为 24 passed，不应命中早年的 fixture 文本");
  assert.equal(stats.passed, 24);
});

// ============================================================================
// B 组：失败窗口优先摘要
// ============================================================================

test("B1. 3000 字符长输出、失败段在尾部 → 摘要保留失败用例与断言，长度 ≤ 2000", () => {
  // 模拟 pytest -q：头部大量进度点，失败详情与统计在尾部
  const progress = ".".repeat(2600);
  const longOutput = [
    "============================= test session starts =============================",
    "collected 24 items",
    progress,
    "=================================== FAILURES ==================================",
    "______________________ test_binary_missing ______________________",
    "E       AssertionError: LinearDesign 容器内二进制缺失",
    "tests/test_lin.py:5: AssertionError",
    "=========================== short test summary info ============================",
    "FAILED tests/test_lin.py::test_binary_missing - AssertionError: LinearDesign 容器内二进制缺失",
    "1 failed, 23 passed in 0.85s",
  ].join("\n");

  const summary = buildTestOutputSummary(longOutput, 2000);
  assert.ok(summary.length <= 2000, `摘要长度应 ≤ 2000，实际 ${summary.length}`);
  assert.ok(summary.includes("test_binary_missing"), "摘要必须包含失败用例名（旧实现被头部进度点挤掉）");
  assert.ok(summary.includes("LinearDesign 容器内二进制缺失"), "摘要必须包含断言根因");
  assert.ok(summary.includes("1 failed, 23 passed"), "摘要必须包含尾部统计汇总");
  assert.ok(summary.includes("省略"), "摘要应标注中间省略，避免被误读为完整输出");
});

test("B2. 无失败标记的长输出 → 头尾都给（保留尾部统计）", () => {
  const longOutput = `${"A".repeat(3000)}\n最后一行：命令退出码 1`;
  const summary = buildTestOutputSummary(longOutput, 2000);
  assert.ok(summary.length <= 2000, "摘要长度应 ≤ 2000");
  assert.ok(summary.startsWith("A"), "应保留头部上下文");
  assert.ok(summary.includes("最后一行：命令退出码 1"), "应保留尾部信息");
});

test("B3. 短输出原样返回（不做任何改写）", () => {
  const short = "Tests: 1 passed, 0 failed";
  assert.equal(buildTestOutputSummary(short, 2000), short);
});

test("B4. 任意 maxChars 预算下摘要长度都受控（400/800/1200/2000）", () => {
  const longOutput = `${".".repeat(5000)}\n================ FAILURES ================\nFAILED tests/a.py::test_x - boom\n1 failed, 23 passed in 0.85s`;
  for (const budget of [400, 800, 1200, 2000]) {
    const summary = buildTestOutputSummary(longOutput, budget);
    assert.ok(summary.length <= budget, `budget=${budget} 时摘要长度 ${summary.length} 应 ≤ ${budget}`);
    assert.ok(summary.includes("test_x"), `budget=${budget} 时应保留失败用例名`);
  }
});

// ============================================================================
// C 组：失败用例标识提取
// ============================================================================

test("C1. 五类 runner 的失败用例标识均可提取（去重保序）", () => {
  const pytest = extractFailedTestIds("FAILED tests/a.py::test_x - AssertionError: boom");
  assert.deepEqual([...pytest.ids], ["tests/a.py::test_x"]);
  assert.equal(pytest.total, 1);

  const unittest = extractFailedTestIds("FAIL: test_y (tests.test_mod.TC)");
  assert.deepEqual([...unittest.ids], ["tests.test_mod.TC.test_y"]);

  const jest = extractFailedTestIds("  ✕ 渲染订单列表\n  ● 提交后应刷新");
  assert.deepEqual([...jest.ids], ["渲染订单列表", "提交后应刷新"]);

  const mocha = extractFailedTestIds("  1) 订单服务\n     应返回 200");
  assert.deepEqual([...mocha.ids], ["订单服务"]);

  const tap = extractFailedTestIds("not ok 3 - linear-binary");
  assert.deepEqual([...tap.ids], ["linear-binary"]);
});

test("C2. 重复出现同一失败用例只计一次；超过上限时保留前 N 条并给出总数", () => {
  const lines: string[] = [];
  for (let i = 1; i <= 25; i += 1) {
    lines.push(`FAILED tests/test_${i}.py::test_case_${i} - AssertionError`);
  }
  lines.push("FAILED tests/test_1.py::test_case_1 - AssertionError"); // 重复项

  const result = extractFailedTestIds(lines.join("\n"), 20);
  assert.equal(result.total, 25, "总数应去重后为 25");
  assert.equal(result.ids.length, 20, "返回条数应受上限 20 约束");
  assert.equal(result.ids[0], "tests/test_1.py::test_case_1", "应保持出现顺序");
});

test("C3. 无失败用例时返回空列表（不产生噪声）", () => {
  const result = extractFailedTestIds("Tests: 3 passed, 0 failed");
  assert.equal(result.total, 0);
  assert.equal(result.ids.length, 0);
});

test("C4. unittest 堆栈段（Traceback + FAILED 汇总）仍能取到失败用例", () => {
  const output = [
    "FAIL: test_y (tests.test_mod.TC)",
    "Traceback (most recent call last):",
    "AssertionError: boom",
    "FAILED (failures=1)",
  ].join("\n");
  const result = extractFailedTestIds(output);
  assert.deepEqual([...result.ids], ["tests.test_mod.TC.test_y"]);
});

// ============================================================================
// D 组：verify / fix 阶段的证据回灌端到端
// ============================================================================

/**
 * 在临时项目里写一个"头部刷屏、尾部失败"的测试脚本。
 *
 * 脚本真实由 verify 阶段的 spawnSync 执行（非 mock）：先打印 2600 个进度点，
 * 再输出 FAILURES 段与 pytest 风格汇总，最后 exit 1 —— 精确复现事故输出形态。
 *
 * @param projectRoot 临时项目根目录
 * @returns 相对项目根的脚本文件名
 */
function writeTailFailureTestScript(projectRoot: string): string {
  const scriptName = "fail-tail.js";
  const script = [
    "// 真实测试脚本：复现 pytest 输出形态（进度在前，失败详情在尾部）",
    'console.log("============================= test session starts =============================");',
    'console.log("collected 24 items");',
    'process.stdout.write("." .repeat(2600) + "\\n");',
    'console.log("=================================== FAILURES ==================================");',
    'console.log("______________________ test_binary_missing ______________________");',
    'console.log("E       AssertionError: LinearDesign 容器内二进制缺失");',
    'console.log("=========================== short test summary info ============================");',
    'console.log("FAILED tests/test_lin.py::test_binary_missing - AssertionError: LinearDesign 容器内二进制缺失");',
    'console.log("1 failed, 23 passed in 0.85s");',
    "process.exit(1);",
  ].join("\n");
  fs.writeFileSync(path.join(projectRoot, scriptName), script, "utf8");
  return scriptName;
}

/**
 * 创建"记录 feedback 的"任务执行器测试替身。
 *
 * 仅替代 LLM 网络：把 fix 阶段真实回灌的 input.feedback 捕获下来供断言，
 * 返回一份成功的执行结果（文件变更、请求数均为固定值）。
 *
 * @param sink 捕获数组（写入最近一次 input）
 * @returns P5TaskExecutor 实例
 */
function createRecordingTaskExecutor(sink: P5TaskExecutionInput[]): P5TaskExecutor {
  const result: P5TaskExecutionResult = Object.freeze({
    success: true,
    summary: "[test-double] 记录 feedback 的执行器",
    tokensUsed: 1,
    tokensEstimated: false,
    llmRequests: 1,
    changedFiles: Object.freeze(["src/services/Service1.ts"]),
    error: undefined,
  });
  return Object.freeze({
    async executeTask(input: Readonly<P5TaskExecutionInput>): Promise<Readonly<P5TaskExecutionResult>> {
      sink.push(input);
      return result;
    },
  });
}

test("D1. verify 失败制品含失败用例标识，摘要含失败用例名（不再只有 exitCode）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    const scriptName = writeTailFailureTestScript(projectRoot);

    const taskCard = createTestTaskCard();
    const planResult = createSuccessStageResult("plan", "选取任务卡", { taskCard }, [], 0, 10);

    const ctx = buildStageContext(projectRoot, "verify", {
      prevResults: Object.freeze([planResult]),
      testCommand: `node ${scriptName}`,
    });

    const result = await new P5VerifyStageHandler().handle(ctx);

    assert.equal(result.kind, "failed", "有失败用例时应返回 failed");
    const failedIds = result.artifacts["failedTestIds"] as ReadonlyArray<string>;
    assert.ok(Array.isArray(failedIds) && failedIds.length === 1, "应提取到 1 个失败用例");
    assert.equal(failedIds[0], "tests/test_lin.py::test_binary_missing", "失败用例标识应可定位");
    assert.equal(result.artifacts["failedTestTotal"], 1, "失败用例总数应为 1");
    assert.ok(result.summary.includes("test_binary_missing"), "阶段摘要应包含失败用例名");
    assert.ok(
      (result.error ?? "").includes("失败用例"),
      "error 文本应包含失败用例提示（修复前只有 exitCode/failed 数字）"
    );

    // 原始尾部（供 fix 自愈重建）：必须含尾部断言根因
    const tail = result.artifacts["testOutputTail"] as string;
    assert.ok(typeof tail === "string" && tail.includes("LinearDesign 容器内二进制缺失"), "应保留原始尾部证据");

    // 统计解析正确（逆序汇总 1 failed, 23 passed）
    const stats = result.artifacts["testStats"] as { readonly passed: number; readonly failed: number };
    assert.equal(stats.passed, 23, "passed 应为 23");
    assert.equal(stats.failed, 1, "failed 应为 1");

    // 证据摘要必须含尾部断言根因（head-only 实现会丢）
    const evidence = result.artifacts["completionEvidence"] as { readonly testOutputSummary: string };
    assert.ok(evidence.testOutputSummary.includes("LinearDesign 容器内二进制缺失"), "证据摘要应含断言根因");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("D1b. 测试命令无法启动（ENOENT）→ fatal，不得降级为 skip", async () => {
  const projectRoot = createTempProject();
  try {
    // 绝对路径 + 白名单 basename（pytest），但程序不存在 → spawnSync ENOENT
    const ctx = buildStageContext(projectRoot, "verify", {
      // synthesizedTask=true 是"无测试可跑 → skip"的宽松路径，必须仍判 fatal
      synthesizedTask: true,
      testCommand: "/nonexistent-eag-bin/pytest -q",
    });

    const result = await new P5VerifyStageHandler().handle(ctx);
    assert.equal(result.kind, "fatal", "命令无法启动必须 fatal（旧实现会降级为 skip 假绿）");
    assert.ok((result.error ?? "").length > 0, "应带上启动失败原因");
    assert.equal(result.artifacts["skipped"], undefined, "不得标记为 skipped");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("D1c. 环境类失败（二进制缺失）分类为 environment 并给出环境排查方向", async () => {
  const { analyzeFailureCategory } = await import("../eag/p5/index");
  const category = analyzeFailureCategory("AssertionError: False is not true : LinearDesign 容器内二进制缺失");
  assert.equal(category, "environment", "缺失类根因应归为 environment，而非盲目按断言改业务代码");

  const categoryEnoent = analyzeFailureCategory("ENOENT: no such file or directory, spawn 'lineardesign'");
  assert.equal(categoryEnoent, "environment");
});

test("D2. 真实 verify→fix 链路：回灌反馈含失败用例与尾部断言，文件清单受上限约束", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    const scriptName = writeTailFailureTestScript(projectRoot);

    // 25 个声明文件（事故任务卡声明 249 个文件，这里用 25 验证截断与优先级）
    const declaredFiles = Array.from({ length: 25 }, (_, index) => `src/module_${index + 1}.ts`);
    const taskCard = createTestTaskCard("T-055", declaredFiles, ["LinearDesign"]);
    const planResult = createSuccessStageResult("plan", "选取任务卡", { taskCard }, [], 0, 10);

    // 第一段：真实执行 verify（真实 spawn，产出真实失败制品）
    const verifyCtx = buildStageContext(projectRoot, "verify", {
      prevResults: Object.freeze([planResult]),
      testCommand: `node ${scriptName}`,
    });
    const verifyResult = await new P5VerifyStageHandler().handle(verifyCtx);
    assert.equal(verifyResult.kind, "failed", "前置 verify 应真实失败");

    // 第二段：把真实 verify 失败结果喂给 fix，捕获真实回灌的 feedback
    const captured: P5TaskExecutionInput[] = [];
    const fixCtx = buildStageContext(projectRoot, "fix", {
      prevResults: Object.freeze([planResult, verifyResult]),
      taskExecutor: createRecordingTaskExecutor(captured),
    });

    const result = await new P5FixStageHandler().handle(fixCtx);
    assert.equal(result.kind, "success", "fix 阶段应执行修复并返回 success");

    assert.equal(captured.length, 1, "执行器应被调用一次");
    const feedback = captured[0]?.feedback ?? "";

    assert.ok(feedback.includes("失败用例（请优先定位并复跑这些用例"), "反馈应含失败用例段落");
    assert.ok(feedback.includes("tests/test_lin.py::test_binary_missing"), "反馈应含具体失败用例标识");
    assert.ok(
      feedback.includes("LinearDesign 容器内二进制缺失"),
      "反馈应含尾部断言根因（修复前被 500 字符头部截断丢掉）"
    );
    assert.ok(feedback.length > 500, "反馈长度应超过旧的 500 字符上限");

    // 文件清单截断：失败用例所在文件占 1 个名额，其余按声明顺序补到 20 条
    assert.ok(feedback.includes("共 25 个"), "应标注声明文件总数");
    assert.ok(feedback.includes("src/module_19.ts"), "声明文件应一直补到第 19 个（20 条上限 - 1 个测试文件）");
    assert.ok(!feedback.includes("src/module_20.ts"), "第 20 个声明文件应被截断（总数上限 20）");
    // 失败用例所在文件优先：tests/test_lin.py 应排在声明文件之前
    assert.ok(
      feedback.indexOf("tests/test_lin.py") < feedback.indexOf("src/module_1.ts"),
      "失败用例所在文件应优先于普通声明文件"
    );

    // 结构化制品同步暴露失败用例与环境类分类
    const suggestion = result.artifacts["fixSuggestion"] as {
      readonly failureCategory: string;
      readonly failedTestIds: ReadonlyArray<string>;
      readonly failedTestTotal: number;
      readonly declaredFileTotal: number;
      readonly filesToReview: ReadonlyArray<string>;
    };
    assert.equal(suggestion.failedTestTotal, 1, "失败用例总数应为 1");
    assert.equal(suggestion.failedTestIds[0], "tests/test_lin.py::test_binary_missing");
    assert.equal(suggestion.declaredFileTotal, 25);
    assert.equal(suggestion.filesToReview.length, 20);
    assert.equal(suggestion.failureCategory, "environment", "二进制/依赖缺失应分类为 environment");
  } finally {
    cleanupTempProject(projectRoot);
  }
});
