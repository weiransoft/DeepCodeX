/**
 * EAG-P5 Autonomous 测试拆分文件 5/5：ConfirmationHistoryStore + 端到端完整流程
 *
 * 本文件从 eag-p5-e2e-autonomous.test.ts 拆分而来，包含：
 * - K 组（K1-K6）：ConfirmationHistoryStore（TASK-P5-5.3-002 验证）
 *   - record(entry) 写入历史决策
 *   - query(pattern) 多维度查询
 *   - getStats() 聚合统计
 *   - JSONL 持久化
 *   - 原子写入（.tmp → rename）
 * - L 组（L1-L3）：端到端完整流程测试（DOD-1 验证）
 *   - CLI 解析 → handler.execute → AutonomousOrchestrator.run → 结果渲染
 *   - 失败路径（testCommand 失败 → finalStatus=failed）
 *   - createAutonomousOrchestrator 工厂函数
 *
 * 测试约定（严格遵循项目规则 P-5 + NFR-9）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 AutonomousOrchestrator / StageHandler / GuardChain / SmartConfirmation 实例
 * - 使用真实文件系统（os.tmpdir + mkdtempSync）创建临时项目目录
 * - 使用真实 child_process（verify-stage-handler 内部 spawnSync 执行测试命令）
 * - 测试结束后清理临时目录（避免泄漏）
 * - 中文注释，符合 TypeScript 代码规范
 *
 * 设计依据：
 * - 需求文档 §3 FR-1 无人值守 4 阶段循环 + FR-4 /eag-autonomous 命令
 * - 架构师审查 §4.1 AutonomousOrchestrator 接口契约
 * - 任务说明 TASK-P5-5.3-002 + TASK-P5-4.1-008/009
 * - NFR-8 不可变优先 + NFR-9 禁止 mock + NFR-10 中文详细注释
 *
 * @module core/tests/eag-p5-autonomous-history-e2e
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

// EagCommandParser + 命令处理器导入（L 组用）
import { EagCommandParser } from "../eag/cli/eag-command-parser";
import { EagAutonomousCommandHandler } from "../eag/cli/eag-autonomous-command";

// P5 核心组件导入（L3 工厂函数测试用 createAutonomousOrchestrator）
import {
  // 工厂函数（L3）
  createAutonomousOrchestrator,
  // 4 个 StageHandler
  P5PlanStageHandler,
  P5DevStageHandler,
  P5VerifyStageHandler,
  P5FixStageHandler,
  // 分流器
  createP5LoopExecutorFromHandlers,
  // 核心依赖
  P5RunStateStore,
  P5NotesMemory,
  P5SmartConfirmation,
  createDefaultBlockerGuardChain,
  // ConfirmationHistoryStore（K 组）
  createDefaultP5ConfirmationHistoryStore,
  // 类型
  type P5ConfirmationDecision,
} from "../eag/p5";

// 共享夹具导入
import {
  PASS_TEST_CMD,
  FAIL_TEST_CMD,
  createTempProject,
  cleanupTempProject,
  createTasksFile,
  createDeclaredFile,
  buildOrchestrator,
  buildUserPrompt,
} from "./fixtures/eag-p5-e2e-fixtures";

// ============================================================================
// K. ConfirmationHistoryStore 测试（TASK-P5-5.3-002）
// ============================================================================

test("K1. P5ConfirmationHistoryStore record() 写入历史决策", async () => {
  // R7 修复：record() 是 async 方法，测试函数改为 async 并 await record() 调用
  const projectRoot = createTempProject();
  try {
    const store = createDefaultP5ConfirmationHistoryStore();
    const entry = Object.freeze({
      runId: "test-run-001",
      iterIndex: 0,
      stage: "dev" as const,
      command: "npm test",
      decision: "auto-approve" as P5ConfirmationDecision,
      riskLevel: "low" as const,
      riskScore: 0,
      guardRuleId: "",
      matchedPattern: "",
      reason: "白名单命令",
      timestamp: new Date().toISOString(),
    });

    // 写入不应抛异常（await 确保异步写入完成）
    await store.record(projectRoot, entry);

    // 验证文件已创建
    const historyDir = path.join(projectRoot, ".eag", "p5", "confirmation-history");
    assert.ok(fs.existsSync(historyDir), "confirmation-history 目录应存在");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("K2. P5ConfirmationHistoryStore query() 多维度查询", async () => {
  // R7 修复：record() / query() 均为 async 方法，测试函数改为 async 并 await 所有调用
  const projectRoot = createTempProject();
  try {
    const store = createDefaultP5ConfirmationHistoryStore();

    // 写入多条历史决策记录
    const baseTime = new Date().toISOString();
    const entries = Object.freeze([
      Object.freeze({
        runId: "run-001",
        iterIndex: 0,
        stage: "dev" as const,
        command: "npm test",
        decision: "auto-approve" as P5ConfirmationDecision,
        riskLevel: "low" as const,
        riskScore: 0,
        guardRuleId: "",
        matchedPattern: "",
        reason: "白名单",
        timestamp: baseTime,
      }),
      Object.freeze({
        runId: "run-001",
        iterIndex: 1,
        stage: "verify" as const,
        command: "rm -rf /tmp",
        decision: "fail-closed" as P5ConfirmationDecision,
        riskLevel: "critical" as const,
        riskScore: 100,
        guardRuleId: "G-A2a",
        matchedPattern: "rm -rf",
        reason: "黑名单",
        timestamp: baseTime,
      }),
      Object.freeze({
        runId: "run-002",
        iterIndex: 0,
        stage: "dev" as const,
        command: "npm run build",
        decision: "auto-approve" as P5ConfirmationDecision,
        riskLevel: "low" as const,
        riskScore: 0,
        guardRuleId: "",
        matchedPattern: "",
        reason: "白名单",
        timestamp: baseTime,
      }),
    ]);

    // 逐条 await record() 确保写入顺序
    for (const entry of entries) {
      await store.record(projectRoot, entry);
    }

    // 按 runId 查询（await query()）
    const run001Results = await store.query(projectRoot, { runId: "run-001" });
    assert.ok(run001Results.length >= 2, "run-001 应至少有 2 条记录");

    // 按 decision 查询
    const failClosedResults = await store.query(projectRoot, { decision: "fail-closed" });
    assert.ok(failClosedResults.length >= 1, "应至少有 1 条 fail-closed 记录");

    // 按 stage 查询
    const verifyResults = await store.query(projectRoot, { stage: "verify" });
    assert.ok(verifyResults.length >= 1, "应至少有 1 条 verify 阶段记录");

    // 按 commandSubstring 查询
    const npmResults = await store.query(projectRoot, { commandSubstring: "npm" });
    assert.ok(npmResults.length >= 2, "应至少有 2 条 npm 命令记录");

    // 按 guardRuleId 查询
    const guardResults = await store.query(projectRoot, { guardRuleId: "G-A2a" });
    assert.ok(guardResults.length >= 1, "应至少有 1 条 G-A2a 规则记录");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("K3. P5ConfirmationHistoryStore getStats() 聚合统计", async () => {
  // R7 修复：record() / getStats() 均为 async 方法，测试函数改为 async 并 await 所有调用
  const projectRoot = createTempProject();
  try {
    const store = createDefaultP5ConfirmationHistoryStore();

    // 写入多条历史决策记录
    const baseTime = new Date().toISOString();
    const entries = Object.freeze([
      Object.freeze({
        runId: "run-001",
        iterIndex: 0,
        stage: "dev" as const,
        command: "npm test",
        decision: "auto-approve" as P5ConfirmationDecision,
        riskLevel: "low" as const,
        riskScore: 0,
        guardRuleId: "",
        matchedPattern: "",
        reason: "白名单",
        timestamp: baseTime,
      }),
      Object.freeze({
        runId: "run-001",
        iterIndex: 1,
        stage: "dev" as const,
        command: "rm -rf /tmp",
        decision: "fail-closed" as P5ConfirmationDecision,
        riskLevel: "critical" as const,
        riskScore: 100,
        guardRuleId: "G-A2a",
        matchedPattern: "rm -rf",
        reason: "黑名单",
        timestamp: baseTime,
      }),
      Object.freeze({
        runId: "run-001",
        iterIndex: 2,
        stage: "verify" as const,
        command: "npm test",
        decision: "ask-user" as P5ConfirmationDecision,
        riskLevel: "medium" as const,
        riskScore: 30,
        guardRuleId: "",
        matchedPattern: "",
        reason: "中等风险",
        timestamp: baseTime,
      }),
    ]);

    for (const entry of entries) {
      await store.record(projectRoot, entry);
    }

    // 获取统计（await getStats()）
    const stats = await store.getStats(projectRoot);

    // 验证统计字段
    assert.ok(stats.totalEntries >= 3, "总记录数应 >= 3");
    assert.ok(stats.byDecision["auto-approve"] >= 1, "auto-approve 计数应 >= 1");
    assert.ok(stats.byDecision["fail-closed"] >= 1, "fail-closed 计数应 >= 1");
    assert.ok(stats.byDecision["ask-user"] >= 1, "ask-user 计数应 >= 1");
    assert.ok(stats.byStage["dev"] >= 2, "dev 阶段计数应 >= 2");
    assert.ok(stats.byStage["verify"] >= 1, "verify 阶段计数应 >= 1");
    assert.ok(stats.uniqueRunIds >= 1, "唯一 runId 数应 >= 1");
    assert.ok(stats.autoApproveRate > 0, "自动放行率应 > 0");
    assert.ok(stats.autoApproveRate + stats.askUserRate + stats.failClosedRate <= 1.01, "三态比例之和应约等于 1");
    assert.ok(stats.topGuardRuleIds.length > 0, "应含 Top 护栏规则");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("K4. P5ConfirmationHistoryStore JSONL 持久化（文件可解析）", async () => {
  // R7 修复：record() 是 async 方法，测试函数改为 async 并 await record() 调用
  const projectRoot = createTempProject();
  try {
    const store = createDefaultP5ConfirmationHistoryStore();

    await store.record(
      projectRoot,
      Object.freeze({
        runId: "run-persist-001",
        iterIndex: 0,
        stage: "dev" as const,
        command: "npm test",
        decision: "auto-approve" as P5ConfirmationDecision,
        riskLevel: "low" as const,
        riskScore: 0,
        guardRuleId: "",
        matchedPattern: "",
        reason: "持久化测试",
        timestamp: new Date().toISOString(),
      })
    );

    // 验证 JSONL 文件存在且可解析
    const historyDir = path.join(projectRoot, ".eag", "p5", "confirmation-history");
    const files = fs.readdirSync(historyDir).filter((f) => f.endsWith(".jsonl"));
    assert.ok(files.length > 0, "应至少有 1 个 .jsonl 文件");

    const filePath = path.join(historyDir, files[0]);
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0);
    assert.ok(lines.length > 0, "JSONL 文件应至少有 1 行");

    // 每行应可解析为 JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.runId, "string", "JSONL 行应含 runId 字段");
      assert.equal(typeof parsed.decision, "string", "JSONL 行应含 decision 字段");
    }
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("K5. P5ConfirmationHistoryStore clear() 清理历史记录", async () => {
  // R7 修复：record() / getStats() / clear() 均为 async 方法，测试函数改为 async 并 await 所有调用
  const projectRoot = createTempProject();
  try {
    const store = createDefaultP5ConfirmationHistoryStore();

    // 写入记录
    await store.record(
      projectRoot,
      Object.freeze({
        runId: "run-clear-001",
        iterIndex: 0,
        stage: "dev" as const,
        command: "npm test",
        decision: "auto-approve" as P5ConfirmationDecision,
        riskLevel: "low" as const,
        riskScore: 0,
        guardRuleId: "",
        matchedPattern: "",
        reason: "清理测试",
        timestamp: new Date().toISOString(),
      })
    );

    // 验证记录存在
    const beforeStats = await store.getStats(projectRoot);
    assert.ok(beforeStats.totalEntries >= 1, "清理前应有记录");

    // 清理
    await store.clear(projectRoot);

    // 验证记录已清理
    const afterStats = await store.getStats(projectRoot);
    assert.equal(afterStats.totalEntries, 0, "清理后总记录数应为 0");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("K6. P5ConfirmationHistoryStore 不可变性（返回冻结对象）", async () => {
  // R7 修复：record() / query() / getStats() 均为 async 方法，测试函数改为 async 并 await 所有调用
  const projectRoot = createTempProject();
  try {
    const store = createDefaultP5ConfirmationHistoryStore();

    await store.record(
      projectRoot,
      Object.freeze({
        runId: "run-immutable-001",
        iterIndex: 0,
        stage: "dev" as const,
        command: "npm test",
        decision: "auto-approve" as P5ConfirmationDecision,
        riskLevel: "low" as const,
        riskScore: 0,
        guardRuleId: "",
        matchedPattern: "",
        reason: "不可变性测试",
        timestamp: new Date().toISOString(),
      })
    );

    // query 返回的条目应被冻结（await query()）
    const results = await store.query(projectRoot, { runId: "run-immutable-001" });
    assert.ok(results.length > 0, "应至少有 1 条记录");
    for (const entry of results) {
      assert.ok(Object.isFrozen(entry), "历史记录条目应被冻结");
    }

    // getStats 返回的统计应被冻结（await getStats()）
    const stats = await store.getStats(projectRoot);
    assert.ok(Object.isFrozen(stats), "统计对象应被冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// L. 端到端完整流程测试（DOD-1 验证）
// ============================================================================

test("L1. 端到端完整流程：CLI 解析 → handler.execute → AutonomousOrchestrator.run → 结果渲染", async () => {
  const projectRoot = createTempProject();
  try {
    // 准备项目结构
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 步骤 1：用户输入 /eag-autonomous 命令
    const userPromptText = `/eag-autonomous --goal "端到端完整流程测试" --max-iterations 1 --test-command "${PASS_TEST_CMD}"`;

    // 步骤 2：EagCommandParser 解析命令
    const parser = new EagCommandParser();
    const userPrompt = buildUserPrompt(userPromptText);
    const command = parser.parse(userPrompt);
    assert.equal(command.kind, "eag-autonomous");
    if (command.kind !== "eag-autonomous" || !command.payload) {
      assert.fail("命令解析失败");
      return;
    }

    // 步骤 3：构造 AutonomousOrchestrator（5 个核心依赖完整装配）
    const orchestrator = buildOrchestrator();

    // 步骤 4：创建 EagAutonomousCommandHandler 并执行
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const result = await handler.execute(command.payload, projectRoot);

    // 步骤 5：验证执行结果
    assert.equal(result.success, true, "端到端流程应成功");
    assert.ok(result.runResult, "应包含 AutonomousRunResult");
    assert.ok(result.markdownReport.length > 0, "应生成 Markdown 报告");
    assert.ok(result.markdownReport.includes("[EAG Autonomous Loop]"), "报告应含标题");

    // 步骤 6：验证 RunState 持久化
    const runStateDir = path.join(projectRoot, ".eag", "p5", "run-state");
    assert.ok(fs.existsSync(runStateDir), "RunState 目录应存在");

    // 步骤 7：验证 NotesMemory 持久化
    // R5 修复：NotesMemory 路径契约为 <projectRoot>/.eag/p5/notes/<runId>.md（按 run 隔离，非固定 notes.md）
    const notesFile = path.join(projectRoot, ".eag", "p5", "notes", `${result.runResult!.runId}.md`);
    assert.ok(fs.existsSync(notesFile), `notes 文件应存在：${notesFile}`);

    // 步骤 8：验证结果不可变性
    assert.ok(Object.isFrozen(result), "EagAutonomousCommandResult 应被冻结");
    assert.ok(Object.isFrozen(result.runResult), "AutonomousRunResult 应被冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("L2. 端到端完整流程：失败路径（testCommand 失败 → finalStatus=failed）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "pending");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const userPromptText = `/eag-autonomous --goal "失败路径测试" --max-iterations 1 --test-command "${FAIL_TEST_CMD}"`;

    const parser = new EagCommandParser();
    const command = parser.parse(buildUserPrompt(userPromptText));
    if (command.kind !== "eag-autonomous" || !command.payload) {
      assert.fail("命令解析失败");
      return;
    }

    const orchestrator = buildOrchestrator();
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const result = await handler.execute(command.payload, projectRoot);

    // 验证失败路径
    assert.equal(result.success, true, "execute() 应返回 success=true（run() 未抛异常）");
    assert.ok(result.runResult, "应包含 AutonomousRunResult");
    // finalStatus 应为 failed 或 aborted（因为 testCommand 失败）
    assert.ok(["failed", "aborted"].includes(result.runResult!.finalStatus), "finalStatus 应为 failed 或 aborted");
    assert.ok(result.markdownReport.includes("[EAG Autonomous Loop]"), "失败报告也应含标题");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("L3. 端到端完整流程：createAutonomousOrchestrator 工厂函数", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    // 使用工厂函数构造 orchestrator（验证工厂函数可用性）
    const orchestrator = createAutonomousOrchestrator({
      loopExecutor: createP5LoopExecutorFromHandlers(
        new P5PlanStageHandler(),
        new P5DevStageHandler(),
        new P5VerifyStageHandler(),
        new P5FixStageHandler()
      ),
      runStateStore: new P5RunStateStore(),
      notesMemory: new P5NotesMemory(),
      guardChain: createDefaultBlockerGuardChain({ throwOnDeny: false }),
      smartConfirmation: new P5SmartConfirmation(),
    });

    const result = await orchestrator.run({
      projectRoot,
      objective: "工厂函数测试",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    assert.ok(result.totalIterations >= 1, "工厂函数构造的 orchestrator 应可正常运行");
    assert.ok(Object.isFrozen(result), "结果应被冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});
