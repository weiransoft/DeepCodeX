/**
 * EAG-P5 端到端能力呈现验证（拆分文件 1/5）：Dev / Verify / Fix 阶段代码生成能力
 *
 * 本文件由原 `eag-p5-e2e-capability-verification.test.ts` 拆分而来，
 * 集中承载 4 阶段 StageHandler 的代码生成能力端到端验证：
 *
 * - L 组（L1-L5）：Dev 阶段前置护栏 + 文件盘点 + 制品产出
 * - M 组（M1-M3）：4 阶段制品链流转（plan → dev → verify → fix）
 * - N 组（N1-N4）：Verify 阶段真实测试执行 + 输出解析 + 证据强制
 * - O 组（O1-O3）：Fix 阶段失败分析 + 修复建议 + 清理意图拦截
 *
 * 测试约定（严格遵循项目规则 NFR-8 / NFR-9 / NFR-10）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 StageHandler / GuardChain / SmartConfirmation 实例
 * - 使用真实文件系统（os.tmpdir + mkdtempSync）创建临时项目目录
 * - 使用真实 child_process（verify-stage-handler 内部 spawnSync 执行测试命令）
 * - 每个测试用例独立构造临时目录与依赖实例，无共享可变状态
 * - 测试结束后清理临时目录（避免泄漏）
 * - 中文注释，符合 TypeScript 代码规范
 *
 * 设计依据：
 * - 需求文档 §3 FR-1 无人值守 4 阶段循环
 * - 架构师审查 §3.1.3 4 阶段 StageHandler + §4.1 接口契约
 * - NFR-8 不可变优先 + NFR-9 禁止 mock + NFR-10 中文详细注释
 *
 * @module core/tests/eag-p5-e2e-dev-verify-fix
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// P5 核心组件导入（4 个 StageHandler + 制品构造工厂 + 解析函数）
import {
  // 4 个 StageHandler（真实实例，禁止 mock）
  P5PlanStageHandler,
  P5DevStageHandler,
  P5VerifyStageHandler,
  P5FixStageHandler,
  // StageResult 构造工厂（用于构造 plan/dev 前置结果）
  createSuccessStageResult,
  createFailedStageResult,
  // Verify/Fix 解析函数
  parseTestOutput,
  analyzeFailureCategory,
  detectCleanupIntent,
  // 类型
  type TaskCard,
  type ChangeDiff,
  type CompletionEvidence,
} from "../eag/p5/index";

// 共享夹具导入（临时目录 / tasks.md / StageContext / TaskCard 等）
import {
  PASS_TEST_CMD,
  FAIL_TEST_CMD,
  createTempProject,
  cleanupTempProject,
  createTasksFile,
  createDeclaredFile,
  buildStageContext,
  createTestTaskCard,
} from "./fixtures/eag-p5-e2e-fixtures";

// ============================================================================
// L 组：Dev 阶段代码生成能力验证（L1-L5）
// ============================================================================

test("L1. Dev 阶段正常路径：产出 validatedFiles + diffStats + fileInventory + changeDiff 制品", async () => {
  const projectRoot = createTempProject();
  try {
    // 准备 tasks.md + 声明的源文件
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 构造 plan 阶段成功结果（含 taskCard）
    const taskCard = createTestTaskCard();
    const planResult = createSuccessStageResult(
      "plan",
      "选取下一任务卡：T-001",
      { taskCard, guardDecision: "PASS" },
      [],
      0,
      10
    );

    // 构造 dev 阶段上下文（含 plan 阶段结果作为 prevResults）
    const ctx = buildStageContext(projectRoot, "dev", {
      prevResults: Object.freeze([planResult]),
    });

    // 执行 dev 阶段
    const handler = new P5DevStageHandler();
    const result = await handler.handle(ctx);

    // 验证 result.kind === "success"
    assert.equal(result.kind, "success", "dev 阶段应返回 success");
    assert.equal(result.stage, "dev", "stage 应为 dev");

    // 验证 artifacts.validatedFiles 为字符串数组
    const validatedFiles = result.artifacts["validatedFiles"] as string[];
    assert.ok(Array.isArray(validatedFiles), "validatedFiles 应为数组");
    assert.ok(validatedFiles.length > 0, "validatedFiles 应非空");
    assert.ok(validatedFiles.includes("src/services/Service1.ts"), "应包含声明的文件");

    // 验证 artifacts.diffStats 为 [total, existing, new] 三元组
    const diffStats = result.artifacts["diffStats"] as [number, number, number];
    assert.ok(Array.isArray(diffStats), "diffStats 应为数组");
    assert.equal(diffStats.length, 3, "diffStats 应为三元组");
    assert.equal(diffStats[0], 1, "文件总数应为 1");
    assert.equal(diffStats[1], 1, "已存在文件数应为 1");
    assert.equal(diffStats[2], 0, "新文件数应为 0");

    // 验证 artifacts.fileInventory 含 exists/size/mtime/isCredential/withinProjectRoot
    const fileInventory = result.artifacts["fileInventory"] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(fileInventory), "fileInventory 应为数组");
    assert.equal(fileInventory.length, 1, "fileInventory 应有 1 个条目");
    const entry = fileInventory[0]!;
    assert.equal(entry.exists, true, "文件应存在");
    assert.equal(typeof entry.size, "number", "size 应为 number");
    assert.equal(typeof entry.mtime, "string", "mtime 应为 string");
    assert.equal(entry.isCredential, false, "非凭据文件 isCredential 应为 false");
    assert.equal(entry.withinProjectRoot, true, "文件应在 projectRoot 内");

    // 验证 artifacts.changeDiff 含 changedFiles/affectedSymbols/totalAdditions/totalDeletions
    const changeDiff = result.artifacts["changeDiff"] as ChangeDiff;
    assert.ok(changeDiff, "changeDiff 应存在");
    assert.ok(Array.isArray(changeDiff.changedFiles), "changedFiles 应为数组");
    assert.equal(changeDiff.changedFiles.length, 1, "changedFiles 应有 1 个条目");
    assert.ok(Array.isArray(changeDiff.affectedSymbols), "affectedSymbols 应为数组");
    assert.equal(typeof changeDiff.totalAdditions, "number", "totalAdditions 应为 number");
    assert.equal(typeof changeDiff.totalDeletions, "number", "totalDeletions 应为 number");

    // 验证所有制品 Object.isFrozen
    assert.ok(Object.isFrozen(result), "P5StageResult 应被冻结");
    assert.ok(Object.isFrozen(validatedFiles), "validatedFiles 应被冻结");
    assert.ok(Object.isFrozen(diffStats), "diffStats 应被冻结");
    assert.ok(Object.isFrozen(changeDiff), "changeDiff 应被冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("L2. Dev 阶段 G-A1a 路径牢笼触发：越界路径返回 fatal", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");

    // 构造含越界路径的 TaskCard（文件路径在 projectRoot 之外）
    const outsidePath = path.join(os.tmpdir(), "outside-eag-p5-test-file.ts");
    // 确保越界文件存在（仅用于测试路径校验，不实际访问）
    fs.writeFileSync(outsidePath, "// 越界文件", "utf8");

    const taskCard = createTestTaskCard("T-001", [outsidePath], ["OutsideService"]);
    const planResult = createSuccessStageResult(
      "plan",
      "选取下一任务卡：T-001",
      { taskCard, guardDecision: "PASS" },
      [],
      0,
      10
    );

    const ctx = buildStageContext(projectRoot, "dev", {
      prevResults: Object.freeze([planResult]),
    });

    const handler = new P5DevStageHandler();
    const result = await handler.handle(ctx);

    // 验证 result.kind === "fatal"
    assert.equal(result.kind, "fatal", "越界路径应返回 fatal");

    // 验证 result.summary 含 "路径越界被拒（G-A1a）"（summary 为用户可读的护栏触发原因）
    assert.ok(result.summary, "summary 应存在");
    assert.ok(result.summary.includes("路径越界被拒"), "summary 应含'路径越界被拒'");
    assert.ok(result.summary.includes("G-A1a"), "summary 应含 G-A1a");

    // 验证 result.error 含具体越界详情（error 为技术细节）
    assert.ok(result.error, "error 应存在");
    assert.ok(result.error!.includes("projectRoot"), "error 应含 projectRoot 相关说明");

    // 验证 artifacts.violation === "path-jail"
    assert.equal(result.artifacts["violation"], "path-jail", "violation 应为 path-jail");

    // 验证 artifacts.guardRuleId === "G-A1a"
    assert.equal(result.artifacts["guardRuleId"], "G-A1a", "guardRuleId 应为 G-A1a");

    // 验证 result 为冻结对象
    assert.ok(Object.isFrozen(result), "fatal result 应被冻结");

    // 清理越界文件
    fs.unlinkSync(outsidePath);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("L3. Dev 阶段 G-A5a 凭据白名单触发：访问 .env 文件返回 fatal", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");

    // 构造含凭据文件的 TaskCard
    const taskCard = createTestTaskCard("T-001", [".env"], ["EnvConfig"]);
    const planResult = createSuccessStageResult(
      "plan",
      "选取下一任务卡：T-001",
      { taskCard, guardDecision: "PASS" },
      [],
      0,
      10
    );

    const ctx = buildStageContext(projectRoot, "dev", {
      prevResults: Object.freeze([planResult]),
    });

    const handler = new P5DevStageHandler();
    const result = await handler.handle(ctx);

    // 验证 result.kind === "fatal"
    assert.equal(result.kind, "fatal", "凭据文件访问应返回 fatal");

    // 验证 result.summary 含 "凭据文件访问被拒（G-A5a）"（summary 为用户可读的护栏触发原因）
    assert.ok(result.summary, "summary 应存在");
    assert.ok(result.summary.includes("凭据文件访问被拒"), "summary 应含'凭据文件访问被拒'");
    assert.ok(result.summary.includes("G-A5a"), "summary 应含 G-A5a");

    // 验证 result.error 含具体凭据黑名单命中详情（error 为技术细节）
    assert.ok(result.error, "error 应存在");
    assert.ok(result.error!.includes("凭据黑名单"), "error 应含'凭据黑名单'相关说明");

    // 验证 artifacts.violation === "credential-access"
    assert.equal(result.artifacts["violation"], "credential-access", "violation 应为 credential-access");

    // 验证 artifacts.guardRuleId === "G-A5a"
    assert.equal(result.artifacts["guardRuleId"], "G-A5a", "guardRuleId 应为 G-A5a");

    // 验证凭据文件模式覆盖 .env/.ssh/.aws/.pem/.key 等
    const handler2 = new P5DevStageHandler();
    const patternCount = handler2.getCredentialPatternCount();
    assert.ok(patternCount >= 14, `凭据文件模式应至少 14 个，实际 ${patternCount}`);

    // 验证 result 为冻结对象
    assert.ok(Object.isFrozen(result), "fatal result 应被冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("L4. Dev 阶段无任务卡时返回 success + taskCard=null", async () => {
  const projectRoot = createTempProject();
  try {
    // 不构造 plan 阶段结果（prevResults 为空）
    const ctx = buildStageContext(projectRoot, "dev", {
      prevResults: Object.freeze([]),
    });

    const handler = new P5DevStageHandler();
    const result = await handler.handle(ctx);

    // 验证 result.kind === "success"
    assert.equal(result.kind, "success", "无任务卡时应返回 success");

    // 验证 artifacts.taskCard === null
    assert.equal(result.artifacts["taskCard"], null, "taskCard 应为 null");

    // 验证 artifacts.reason === "no-task-card"
    assert.equal(result.artifacts["reason"], "no-task-card", "reason 应为 no-task-card");

    // 验证 summary 含 "dev 阶段跳过"
    assert.ok(result.summary.includes("dev 阶段跳过"), "summary 应含'dev 阶段跳过'");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("L5. Dev 阶段 fileInventory 真实盘点：验证 exists/size/mtime 与文件系统一致", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");

    // 预创建文件（含已知内容）
    const fileContent = "export class Service1 { hello() { return 'world'; } }\n";
    createDeclaredFile(projectRoot, "src/services/Service1.ts", fileContent);

    // 获取真实文件状态用于断言
    const realFilePath = path.join(projectRoot, "src/services/Service1.ts");
    const realStat = fs.statSync(realFilePath);

    const taskCard = createTestTaskCard();
    const planResult = createSuccessStageResult(
      "plan",
      "选取下一任务卡：T-001",
      { taskCard, guardDecision: "PASS" },
      [],
      0,
      10
    );

    const ctx = buildStageContext(projectRoot, "dev", {
      prevResults: Object.freeze([planResult]),
    });

    const handler = new P5DevStageHandler();
    const result = await handler.handle(ctx);

    assert.equal(result.kind, "success", "应返回 success");

    const fileInventory = result.artifacts["fileInventory"] as Array<Record<string, unknown>>;
    assert.equal(fileInventory.length, 1, "应有 1 个文件条目");

    const entry = fileInventory[0]!;

    // 验证 fileInventory.exists === true（预创建文件）
    assert.equal(entry.exists, true, "预创建文件 exists 应为 true");

    // 验证 fileInventory.size 与 fs.statSync().size 一致
    assert.equal(entry.size, realStat.size, "size 应与 fs.statSync 一致");

    // 验证 fileInventory.mtime 为 ISO 8601 格式
    assert.equal(typeof entry.mtime, "string", "mtime 应为 string");
    const mtimeDate = new Date(entry.mtime as string);
    assert.ok(!isNaN(mtimeDate.getTime()), "mtime 应为有效的 ISO 8601 日期");

    // 验证未创建文件的 exists === false
    const taskCard2 = createTestTaskCard("T-002", ["src/services/NotExists.ts"], ["NotExists"]);
    const planResult2 = createSuccessStageResult(
      "plan",
      "选取下一任务卡：T-002",
      { taskCard: taskCard2, guardDecision: "PASS" },
      [],
      0,
      10
    );

    const ctx2 = buildStageContext(projectRoot, "dev", {
      prevResults: Object.freeze([planResult2]),
    });

    const result2 = await handler.handle(ctx2);
    assert.equal(result2.kind, "success", "未创建文件也应返回 success");

    const fileInventory2 = result2.artifacts["fileInventory"] as Array<Record<string, unknown>>;
    const entry2 = fileInventory2[0]!;
    assert.equal(entry2.exists, false, "未创建文件 exists 应为 false");
    assert.equal(entry2.size, 0, "未创建文件 size 应为 0");
    assert.equal(entry2.mtime, "", "未创建文件 mtime 应为空字符串");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// M 组：4 阶段制品链流转验证（M1-M3）
// ============================================================================

test("M1. plan → dev 制品链：dev 阶段正确消费 plan 产出的 taskCard", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 1. 执行 plan 阶段
    const planCtx = buildStageContext(projectRoot, "plan");
    const planHandler = new P5PlanStageHandler();
    const planResult = await planHandler.handle(planCtx);

    // 验证 plan 产出 artifacts.taskCard 含 id/title/declaredFiles/declaredSymbols
    assert.equal(planResult.kind, "success", "plan 阶段应返回 success");
    const planTaskCard = planResult.artifacts["taskCard"] as TaskCard;
    assert.ok(planTaskCard, "plan 应产出 taskCard");
    assert.equal(planTaskCard.id, "T-001", "taskCard.id 应为 T-001");
    assert.ok(planTaskCard.title.length > 0, "taskCard.title 应非空");
    assert.ok(planTaskCard.declaredFiles.includes("src/services/Service1.ts"), "declaredFiles 应含 Service1.ts");
    assert.ok(planTaskCard.declaredSymbols.includes("Service1"), "declaredSymbols 应含 Service1");

    // 2. 执行 dev 阶段（含 plan 结果作为 prevResults）
    const devCtx = buildStageContext(projectRoot, "dev", {
      prevResults: Object.freeze([planResult]),
    });
    const devHandler = new P5DevStageHandler();
    const devResult = await devHandler.handle(devCtx);

    // 验证 dev 阶段通过 extractTaskCardFromPrevResults 获取相同 taskCard
    assert.equal(devResult.kind, "success", "dev 阶段应返回 success");
    const devTaskCard = devResult.artifacts["taskCard"] as TaskCard;
    assert.ok(devTaskCard, "dev 应消费 plan 产出的 taskCard");
    assert.equal(devTaskCard.id, planTaskCard.id, "dev 消费的 taskCard.id 应与 plan 一致");
    assert.equal(devTaskCard.title, planTaskCard.title, "taskCard.title 应一致");

    // 验证 dev 阶段 validatedFiles 与 taskCard.declaredFiles 一致
    const validatedFiles = devResult.artifacts["validatedFiles"] as string[];
    assert.deepEqual(
      [...validatedFiles].sort(),
      [...planTaskCard.declaredFiles].sort(),
      "validatedFiles 应与 declaredFiles 一致"
    );
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("M2. dev → verify 制品链：verify 阶段正确消费 dev 阶段的 taskCard", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 1. 执行 plan 阶段
    const planCtx = buildStageContext(projectRoot, "plan");
    const planResult = await new P5PlanStageHandler().handle(planCtx);

    // 2. 执行 dev 阶段
    const devCtx = buildStageContext(projectRoot, "dev", {
      prevResults: Object.freeze([planResult]),
    });
    const devResult = await new P5DevStageHandler().handle(devCtx);
    assert.equal(devResult.kind, "success", "dev 阶段应返回 success");

    // 验证 dev 阶段 artifacts.taskCard 与 plan 一致
    const devTaskCard = devResult.artifacts["taskCard"] as TaskCard;
    assert.ok(devTaskCard, "dev 应产出 taskCard");
    assert.equal(devTaskCard.id, "T-001", "taskCard.id 应为 T-001");

    // 3. 执行 verify 阶段（含 plan + dev 结果作为 prevResults）
    const verifyCtx = buildStageContext(projectRoot, "verify", {
      prevResults: Object.freeze([planResult, devResult]),
      testCommand: PASS_TEST_CMD,
    });
    const verifyResult = await new P5VerifyStageHandler().handle(verifyCtx);

    // 验证 verify 阶段通过 extractTaskCardFromPrevResults 获取相同 taskCard
    assert.equal(verifyResult.kind, "success", "verify 阶段应返回 success（PASS_TEST_CMD）");

    // 验证 verify 阶段 completionEvidence 含真实 testExitCode
    const evidence = verifyResult.artifacts["completionEvidence"] as CompletionEvidence;
    assert.ok(evidence, "verify 应产出 completionEvidence");
    assert.equal(evidence.testExitCode, 0, "PASS_TEST_CMD 的 testExitCode 应为 0");
    assert.equal(evidence.evaluatorVerdict, "pass", "evaluatorVerdict 应为 pass");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("M3. verify → fix 制品链：fix 阶段正确消费 verify 阶段的失败结果", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 1. 执行 plan 阶段
    const planCtx = buildStageContext(projectRoot, "plan");
    const planResult = await new P5PlanStageHandler().handle(planCtx);

    // 2. 执行 dev 阶段
    const devCtx = buildStageContext(projectRoot, "dev", {
      prevResults: Object.freeze([planResult]),
    });
    const devResult = await new P5DevStageHandler().handle(devCtx);

    // 3. 执行 verify 阶段（FAIL_TEST_CMD → failed）
    const verifyCtx = buildStageContext(projectRoot, "verify", {
      prevResults: Object.freeze([planResult, devResult]),
      testCommand: FAIL_TEST_CMD,
    });
    const verifyResult = await new P5VerifyStageHandler().handle(verifyCtx);

    // 验证 verify 失败时 result.kind === "failed"
    assert.equal(verifyResult.kind, "failed", "FAIL_TEST_CMD 时 verify 应返回 failed");

    // 提取 verify 阶段的 testStats.failed
    const verifyStats = verifyResult.artifacts["testStats"] as { readonly failed: number };
    assert.equal(verifyStats.failed, 1, "verify testStats.failed 应为 1");

    // 4. 执行 fix 阶段（含 plan + dev + verify 结果作为 prevResults）
    const fixCtx = buildStageContext(projectRoot, "fix", {
      prevResults: Object.freeze([planResult, devResult, verifyResult]),
    });
    const fixResult = await new P5FixStageHandler().handle(fixCtx);

    // 验证 fix 阶段通过 findVerifyFailure 获取 verify 失败结果
    assert.equal(fixResult.kind, "success", "fix 阶段应返回 success");

    // 验证 fix 阶段 fixSuggestion.failedTestCount 与 verify 阶段 testStats.failed 一致
    const fixSuggestion = fixResult.artifacts["fixSuggestion"];
    assert.ok(fixSuggestion, "fix 应产出 fixSuggestion");
    const suggestion = fixSuggestion as { readonly failedTestCount: number };
    assert.equal(suggestion.failedTestCount, verifyStats.failed, "failedTestCount 应与 verify testStats.failed 一致");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// N 组：Verify 阶段能力验证（N1-N4）
// ============================================================================

test("N1. Verify 阶段真实测试命令执行：PASS_TEST_CMD 产出 exitCode=0", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 构造 plan + dev 结果链（verify 阶段需要 plan 的 taskCard）
    const taskCard = createTestTaskCard();
    const planResult = createSuccessStageResult("plan", "plan 完成", { taskCard }, [], 0, 10);
    const devResult = createSuccessStageResult("dev", "dev 完成", { taskCard }, [], 0, 10);

    const ctx = buildStageContext(projectRoot, "verify", {
      prevResults: Object.freeze([planResult, devResult]),
      testCommand: PASS_TEST_CMD,
    });

    const handler = new P5VerifyStageHandler();
    const result = await handler.handle(ctx);

    // 验证 result.kind === "success"
    assert.equal(result.kind, "success", "PASS_TEST_CMD 应返回 success");

    // 验证 artifacts.commandResult.exitCode === 0
    const cmdResult = result.artifacts["commandResult"] as { readonly exitCode: number | null };
    assert.equal(cmdResult.exitCode, 0, "exitCode 应为 0");

    // 验证 artifacts.testStats.failed === 0
    const testStats = result.artifacts["testStats"] as { readonly failed: number };
    assert.equal(testStats.failed, 0, "failed 应为 0");

    // 验证 artifacts.completionEvidence.testExitCode === 0
    const evidence = result.artifacts["completionEvidence"] as CompletionEvidence;
    assert.equal(evidence.testExitCode, 0, "evidence.testExitCode 应为 0");

    // 验证 artifacts.completionEvidence.evaluatorVerdict === "pass"
    assert.equal(evidence.evaluatorVerdict, "pass", "evaluatorVerdict 应为 pass");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("N2. Verify 阶段测试输出解析：Jest 格式正确解析 passed/failed/skipped", () => {
  // 验证 PASS_TEST_CMD 输出被解析为 {passed:1, failed:0, skipped:0, total:1, parser:"jest"}
  const passOutput = "Tests: 1 passed, 0 failed";
  const passStats = parseTestOutput(passOutput, "");
  assert.equal(passStats.passed, 1, "passed 应为 1");
  assert.equal(passStats.failed, 0, "failed 应为 0");
  assert.equal(passStats.skipped, 0, "skipped 应为 0");
  assert.equal(passStats.total, 1, "total 应为 1");
  assert.equal(passStats.parser, "jest", "parser 应为 jest");

  // 验证 FAIL_TEST_CMD 输出被解析为 {passed:0, failed:1, skipped:0, total:1, parser:"jest"}
  const failOutput = "Tests: 0 passed, 1 failed";
  const failStats = parseTestOutput(failOutput, "");
  assert.equal(failStats.passed, 0, "passed 应为 0");
  assert.equal(failStats.failed, 1, "failed 应为 1");
  assert.equal(failStats.skipped, 0, "skipped 应为 0");
  assert.equal(failStats.total, 1, "total 应为 1");
  assert.equal(failStats.parser, "jest", "parser 应为 jest");
});

test("N3. Verify 阶段 G-A4a 证据强制：completionEvidence 含 testExitCode + testOutputSummary", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const taskCard = createTestTaskCard();
    const planResult = createSuccessStageResult("plan", "plan 完成", { taskCard }, [], 0, 10);
    const devResult = createSuccessStageResult("dev", "dev 完成", { taskCard }, [], 0, 10);

    const ctx = buildStageContext(projectRoot, "verify", {
      prevResults: Object.freeze([planResult, devResult]),
      testCommand: PASS_TEST_CMD,
    });

    const handler = new P5VerifyStageHandler();
    const result = await handler.handle(ctx);

    // 验证 artifacts.completionEvidence 含全部字段
    const evidence = result.artifacts["completionEvidence"] as CompletionEvidence;
    assert.ok(evidence, "completionEvidence 应存在");

    // 验证 testCommand 存在
    assert.ok(typeof evidence.testCommand === "string", "testCommand 应为 string");
    assert.ok(evidence.testCommand.length > 0, "testCommand 应非空");

    // 验证 testExitCode 为真实退出码
    assert.equal(typeof evidence.testExitCode, "number", "testExitCode 应为 number");
    assert.equal(evidence.testExitCode, 0, "testExitCode 应为 0（PASS_TEST_CMD）");

    // 验证 testOutputSummary 非空
    assert.ok(typeof evidence.testOutputSummary === "string", "testOutputSummary 应为 string");
    assert.ok(evidence.testOutputSummary.length > 0, "testOutputSummary 应非空");

    // 验证 coveragePercent 存在
    assert.equal(typeof evidence.coveragePercent, "number", "coveragePercent 应为 number");

    // 验证 evaluatorVerdict 存在
    assert.ok(["pass", "fail", "inconclusive"].includes(evidence.evaluatorVerdict), "evaluatorVerdict 应为合法值");

    // 验证 executedAt 存在且为 ISO 8601
    assert.ok(typeof evidence.executedAt === "string", "executedAt 应为 string");
    const executedDate = new Date(evidence.executedAt);
    assert.ok(!isNaN(executedDate.getTime()), "executedAt 应为有效 ISO 8601 日期");

    // 验证 completionEvidence 为冻结对象
    assert.ok(Object.isFrozen(evidence), "completionEvidence 应被冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("N4. Verify 阶段测试失败返回 failed：FAIL_TEST_CMD 产出 exitCode=1", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const taskCard = createTestTaskCard();
    const planResult = createSuccessStageResult("plan", "plan 完成", { taskCard }, [], 0, 10);
    const devResult = createSuccessStageResult("dev", "dev 完成", { taskCard }, [], 0, 10);

    const ctx = buildStageContext(projectRoot, "verify", {
      prevResults: Object.freeze([planResult, devResult]),
      testCommand: FAIL_TEST_CMD,
    });

    const handler = new P5VerifyStageHandler();
    const result = await handler.handle(ctx);

    // 验证 result.kind === "failed"
    assert.equal(result.kind, "failed", "FAIL_TEST_CMD 应返回 failed");

    // 验证 result.summary 含 "测试失败"
    assert.ok(result.summary.includes("测试失败"), "summary 应含'测试失败'");

    // 验证 artifacts.testStats.failed === 1
    const testStats = result.artifacts["testStats"] as { readonly failed: number };
    assert.equal(testStats.failed, 1, "failed 应为 1");

    // 验证 artifacts.completionEvidence.testExitCode === 1
    const evidence = result.artifacts["completionEvidence"] as CompletionEvidence;
    assert.equal(evidence.testExitCode, 1, "testExitCode 应为 1（FAIL_TEST_CMD）");

    // 验证 artifacts.completionEvidence.evaluatorVerdict === "fail"
    assert.equal(evidence.evaluatorVerdict, "fail", "evaluatorVerdict 应为 fail");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// O 组：Fix 阶段能力验证（O1-O3）
// ============================================================================

test("O1. Fix 阶段失败模式分析：6 类 + unknown 分类", () => {
  // 验证 "AssertionError" → "assertion"
  assert.equal(analyzeFailureCategory("AssertionError: expected 200 but got 404"), "assertion");

  // 验证 "Cannot find module" → "import"
  assert.equal(analyzeFailureCategory("Cannot find module './service'"), "import");

  // 验证 "timeout" → "timeout"
  assert.equal(analyzeFailureCategory("Error: timeout of 5000ms exceeded"), "timeout");

  // 验证 "SyntaxError" → "syntax"
  assert.equal(analyzeFailureCategory("SyntaxError: Unexpected token }"), "syntax");

  // 验证 "TypeError" → "type"
  assert.equal(analyzeFailureCategory("TypeError: x is not a function"), "type");

  // 验证 "ReferenceError" → "reference"
  assert.equal(analyzeFailureCategory("ReferenceError: foo is not defined"), "reference");

  // 验证无匹配 → "unknown"
  assert.equal(analyzeFailureCategory("一些未知的错误信息"), "unknown");

  // 验证空字符串 → "unknown"
  assert.equal(analyzeFailureCategory(""), "unknown");
});

test("O2. Fix 阶段修复建议生成：FixSuggestion 含 failureCategory + suggestedActions + filesToReview", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 构造 plan + dev + verify(失败) 结果链
    const taskCard = createTestTaskCard();
    const planResult = createSuccessStageResult("plan", "plan 完成", { taskCard }, [], 0, 10);
    const devResult = createSuccessStageResult("dev", "dev 完成", { taskCard }, [], 0, 10);

    // 构造 verify 失败结果（含 AssertionError 输出 → failureCategory="assertion"）
    const verifyFailResult = createFailedStageResult(
      "verify",
      "failed",
      "测试失败：1 failed",
      "AssertionError: expected 200 but got 404",
      {
        testCommand: FAIL_TEST_CMD,
        testStats: { passed: 0, failed: 1, skipped: 0, total: 1 },
        completionEvidence: {
          testCommand: FAIL_TEST_CMD,
          testExitCode: 1,
          testOutputSummary: "AssertionError: expected 200 but got 404",
          coveragePercent: 0,
          evaluatorVerdict: "fail",
          executedAt: new Date().toISOString(),
        },
        commandResult: { exitCode: 1, timedOut: false },
      },
      [],
      0,
      100
    );

    // 执行 fix 阶段
    const ctx = buildStageContext(projectRoot, "fix", {
      prevResults: Object.freeze([planResult, devResult, verifyFailResult]),
    });

    const handler = new P5FixStageHandler();
    const result = await handler.handle(ctx);

    // 验证 result.kind === "success"
    assert.equal(result.kind, "success", "fix 阶段应返回 success");

    // 验证 artifacts.fixSuggestion 含全部字段
    const fixSuggestion = result.artifacts["fixSuggestion"] as Record<string, unknown>;
    assert.ok(fixSuggestion, "fixSuggestion 应存在");

    // 验证 failureCategory 存在
    assert.ok(typeof fixSuggestion.failureCategory === "string", "failureCategory 应为 string");

    // 验证 failureSummary 存在
    assert.ok(typeof fixSuggestion.failureSummary === "string", "failureSummary 应为 string");

    // 验证 suggestedActions 为非空数组
    assert.ok(Array.isArray(fixSuggestion.suggestedActions), "suggestedActions 应为数组");
    assert.ok((fixSuggestion.suggestedActions as unknown[]).length > 0, "suggestedActions 应非空");

    // 验证 filesToReview 与 taskCard.declaredFiles 一致
    assert.ok(Array.isArray(fixSuggestion.filesToReview), "filesToReview 应为数组");
    assert.deepEqual(
      [...(fixSuggestion.filesToReview as string[])].sort(),
      [...taskCard.declaredFiles].sort(),
      "filesToReview 应与 declaredFiles 一致"
    );

    // 验证 failedTestCount 存在
    assert.equal(typeof fixSuggestion.failedTestCount, "number", "failedTestCount 应为 number");

    // 验证 testExitCode 存在
    assert.equal(typeof fixSuggestion.testExitCode, "number", "testExitCode 应为 number");

    // 验证 failureOutputSnippet 存在
    assert.ok(typeof fixSuggestion.failureOutputSnippet === "string", "failureOutputSnippet 应为 string");

    // 验证 fixSuggestion 为冻结对象
    assert.ok(Object.isFrozen(fixSuggestion), "fixSuggestion 应被冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("O3. Fix 阶段 G-A3b 清理意图永禁：cleanup 关键词触发拦截", () => {
  // 验证 detectCleanupIntent 对清理命令返回 true
  assert.equal(detectCleanupIntent("rm -rf /tmp"), true, "'rm -rf /tmp' 应被识别为清理意图");
  assert.equal(detectCleanupIntent("git reset --hard"), true, "'git reset --hard' 应被识别为清理意图");
  assert.equal(detectCleanupIntent("cleanup logs"), true, "'cleanup logs' 应被识别为清理意图");
  assert.equal(detectCleanupIntent("git clean -fdx"), true, "'git clean -fdx' 应被识别为清理意图");
  assert.equal(detectCleanupIntent("drop table users"), true, "'drop table users' 应被识别为清理意图");
  assert.equal(detectCleanupIntent("truncate table logs"), true, "'truncate table logs' 应被识别为清理意图");
  assert.equal(detectCleanupIntent("kill -9 1234"), true, "'kill -9 1234' 应被识别为清理意图");

  // 验证 detectCleanupIntent 对非清理命令返回 false
  assert.equal(detectCleanupIntent("npm test"), false, "'npm test' 不应被识别为清理意图");
  assert.equal(detectCleanupIntent("echo hello"), false, "'echo hello' 不应被识别为清理意图");
  assert.equal(detectCleanupIntent("git status"), false, "'git status' 不应被识别为清理意图");
  assert.equal(detectCleanupIntent(""), false, "空字符串不应被识别为清理意图");
});
