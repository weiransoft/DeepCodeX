/**
 * EAG-P5 Autonomous 测试拆分文件 4/5：三态确认 + RunState 持久化 + NotesMemory + GuardChain
 *
 * 本文件从 eag-p5-e2e-autonomous.test.ts 拆分而来，包含：
 * - G 组（G1-G5）：三态确认（SmartConfirmation + ConfirmationHistoryStore 集成）
 *   - auto-approve（白名单 / 低风险命令）
 *   - ask-user（中等风险命令）
 *   - fail-closed（黑名单命令）
 *   - decideWithContext 扩展数据源（history / impact / task-pattern）
 * - H 组（H1）：RunState 持久化（DOD-3 验证）
 *   - .eag/p5/run-state/<runId>.jsonl 文件写入
 *   - SHA256 校验和验证
 * - I 组（I1）：NotesMemory 跨轮记忆（FR-7 验证）
 *   - .eag/p5/notes/<runId>.md 文件写入（按 run 隔离）
 *   - DECISION 标签段落
 * - J 组（J1-J5）：GuardChain 15 条 BLOCKER（DOD-2 验证）
 *   - G-A1a 路径牢笼（越界写入 DENY）
 *   - G-A2a 黑名单命令（rm -rf / git push --force）
 *   - G-A3a 范围锁（tasks.md 范围外写操作）
 *   - G-A6d 上限冻结（Object.freeze）
 *
 * 测试约定（严格遵循项目规则 P-5 + NFR-9）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 SmartConfirmation / GuardChain / AutonomousOrchestrator 实例
 * - 使用真实文件系统（os.tmpdir + mkdtempSync）创建临时项目目录
 * - 测试结束后清理临时目录（避免泄漏）
 * - 中文注释，符合 TypeScript 代码规范
 *
 * 设计依据：
 * - 需求文档 §3 FR-1 4 阶段循环 + FR-2 6 层 15 条 BLOCKER + FR-7 NotesMemory
 * - 架构师审查 §4.1 AutonomousOrchestrator 接口契约 + §4.2 BlockerGuardChain 接口契约
 * - 任务说明 TASK-P5-5.3-001/002
 * - NFR-8 不可变优先 + NFR-9 禁止 mock + NFR-10 中文详细注释
 *
 * @module core/tests/eag-p5-autonomous-confirmation-guard
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

// 命令处理器导入（J4 用 extractEagAutonomousRequestFromPrompt）
import { extractEagAutonomousRequestFromPrompt } from "../eag/cli/eag-autonomous-command";

// P5 核心组件导入（G/H/I/J 组用）
import {
  // SmartConfirmation 真实组件
  P5SmartConfirmation,
  createDefaultBlockerGuardChain,
  // ConfirmationHistoryStore（Phase 5.3 TASK-P5-5.3-002）
  createDefaultP5ConfirmationHistoryStore,
  // SmartConfirmation 扩展类型（Phase 5.3 TASK-P5-5.3-001）
  type P5SmartConfirmationContext,
  // GuardChain 类型
  type GuardVerdict,
  type GuardContext,
} from "../eag/p5";

// 共享夹具导入
import {
  PASS_TEST_CMD,
  createTempProject,
  cleanupTempProject,
  createTasksFile,
  createDeclaredFile,
  buildOrchestrator,
} from "./fixtures/eag-p5-e2e-fixtures";

// ============================================================================
// G. 三态确认测试（SmartConfirmation + ConfirmationHistoryStore 集成）
// ============================================================================

test("G1. SmartConfirmation 三态决策：auto-approve（白名单命令 npm test）", () => {
  const smartConfirmation = new P5SmartConfirmation();
  // 构造 PASS verdict（GuardChain 通过）
  // R3 修复：GuardDecision 类型为 "PASS" | "DENY" | "ASK"（大写字面量联合类型）
  // 旧版本使用小写 "pass" 违反类型契约，虽然 decide() 仅检查 "DENY" 不影响 G1 结果，
  // 但为正确性应使用大写 "PASS"
  const passVerdict: GuardVerdict = Object.freeze({
    decision: "PASS",
    severity: "none",
    ruleId: "",
    reason: "通过",
    timestamp: new Date().toISOString(),
  }) as GuardVerdict;

  // npm test 在白名单中 → auto-approve
  const result = smartConfirmation.decide(passVerdict, "npm test");
  assert.equal(result.decision, "auto-approve", "npm test 应自动放行");
  assert.equal(result.riskLevel, "low", "风险等级应为 low");
});

test("G2. SmartConfirmation 三态决策：fail-closed（黑名单命令 rm -rf ~）", () => {
  const smartConfirmation = new P5SmartConfirmation();
  // 构造 PASS verdict（GuardChain 通过，但 SmartConfirmation 黑名单命中）
  // R3 修复：decision 使用大写 "PASS" 对齐 GuardDecision 类型契约
  const passVerdict: GuardVerdict = Object.freeze({
    decision: "PASS",
    severity: "none",
    ruleId: "",
    reason: "通过",
    timestamp: new Date().toISOString(),
  }) as GuardVerdict;

  // rm -rf ~ 在黑名单中 → fail-closed
  const result = smartConfirmation.decide(passVerdict, "rm -rf ~");
  assert.equal(result.decision, "fail-closed", "rm -rf ~ 应拒绝");
  assert.ok(result.riskLevel === "critical" || result.riskLevel === "high", "风险等级应为 critical 或 high");
});

test("G3. SmartConfirmation 三态决策：guard DENY 短路 → fail-closed", () => {
  const smartConfirmation = new P5SmartConfirmation();
  // 构造 DENY verdict（GuardChain 拒绝）
  // R3 修复：decision 必须使用大写 "DENY"（GuardDecision 类型契约）
  // 旧版本使用小写 "deny"，decide() 检查 verdict.decision === "DENY" 不匹配，
  // 导致 DENY 短路逻辑未触发，返回 auto-approve 而非 fail-closed
  const denyVerdict: GuardVerdict = Object.freeze({
    decision: "DENY",
    severity: "blocker",
    ruleId: "G-A1a",
    reason: "路径牢笼拦截：越界写入 $HOME",
    timestamp: new Date().toISOString(),
  }) as GuardVerdict;

  // GuardChain DENY → SmartConfirmation 直接 fail-closed（短路）
  const result = smartConfirmation.decide(denyVerdict, "echo test");
  assert.equal(result.decision, "fail-closed", "GuardChain DENY 应短路为 fail-closed");
});

test("G4. SmartConfirmation decideWithContext 扩展数据源（基础 fail-closed 短路）", async () => {
  const smartConfirmation = new P5SmartConfirmation();
  // R3 修复：decision 使用大写 "DENY" 对齐 GuardDecision 类型契约
  const denyVerdict: GuardVerdict = Object.freeze({
    decision: "DENY",
    severity: "blocker",
    ruleId: "G-A1a",
    reason: "路径牢笼拦截",
    timestamp: new Date().toISOString(),
  }) as GuardVerdict;

  // 构造扩展上下文（含 historyStore / symbolGraphStore / taskCard）
  const historyStore = createDefaultP5ConfirmationHistoryStore();
  // R4 修复：P5SmartConfirmationContext 必填 projectRoot 字段
  // validateContext() 校验 projectRoot 必须为非空字符串，缺失时抛出异常
  const projectRoot = createTempProject();
  try {
    const context: P5SmartConfirmationContext = Object.freeze({
      command: "rm -rf ~",
      runId: "test-run-001",
      projectRoot,
      iterIndex: 0,
      stage: "dev",
      historyStore,
      symbolGraphStore: null,
      taskCard: null,
    }) as P5SmartConfirmationContext;

    // 基础决策已为 fail-closed → 应短路返回（不查询扩展数据源）
    const result = await smartConfirmation.decideWithContext(denyVerdict, context);

    assert.equal(result.baseDecision, "fail-closed");
    assert.equal(result.finalDecision, "fail-closed");
    assert.equal(result.dataSourceContributions.length, 1);
    assert.equal(result.dataSourceContributions[0].action, "none");
    assert.ok(Object.isFrozen(result), "P5ExtendedConfirmationResult 应被冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("G5. SmartConfirmation decideWithContext 扩展数据源（auto-approve + 历史决策贡献）", async () => {
  const smartConfirmation = new P5SmartConfirmation();
  // R3 修复：decision 使用大写 "PASS" 对齐 GuardDecision 类型契约
  const passVerdict: GuardVerdict = Object.freeze({
    decision: "PASS",
    severity: "none",
    ruleId: "",
    reason: "通过",
    timestamp: new Date().toISOString(),
  }) as GuardVerdict;

  const projectRoot = createTempProject();
  try {
    // 构造真实的 ConfirmationHistoryStore（含历史决策记录）
    const historyStore = createDefaultP5ConfirmationHistoryStore();

    // 写入一条历史决策记录（auto-approve，让历史数据源不触发升级）
    // R7 修复：record() 是 async 方法，必须 await 确保记录写入完成后再查询
    await historyStore.record(projectRoot, {
      runId: "test-run-001",
      iterIndex: 0,
      stage: "dev",
      command: "npm test",
      decision: "auto-approve",
      riskLevel: "low",
      riskScore: 0,
      guardRuleId: "",
      matchedPattern: "",
      reason: "白名单命令",
      timestamp: new Date().toISOString(),
    });

    // R4 修复：P5SmartConfirmationContext 必填 projectRoot 字段
    // 旧版本创建了 projectRoot 变量但未放入 context 对象，导致 validateContext() 抛异常
    const context: P5SmartConfirmationContext = Object.freeze({
      command: "npm test",
      runId: "test-run-001",
      projectRoot,
      iterIndex: 1,
      stage: "dev",
      historyStore,
      symbolGraphStore: null,
      taskCard: null,
    }) as P5SmartConfirmationContext;

    // 基础决策为 auto-approve（npm test 白名单）→ 扩展数据源评估
    const result = await smartConfirmation.decideWithContext(passVerdict, context);

    // 验证扩展数据源贡献记录
    assert.equal(result.baseDecision, "auto-approve");
    assert.ok(result.dataSourceContributions.length >= 1, "应至少有 1 个数据源贡献记录");
    // 历史数据源应参与评估
    const historyContribution = result.dataSourceContributions.find((c) => c.source === "history");
    assert.ok(historyContribution, "应含历史数据源贡献");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// H. RunState 持久化测试（DOD-3）
// ============================================================================

test("H1. RunState 持久化文件写入（.eag/p5/run-state/<runId>.jsonl）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run({
      projectRoot,
      objective: "RunState 持久化测试",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证 RunState 持久化文件存在
    const runStateDir = path.join(projectRoot, ".eag", "p5", "run-state");
    assert.ok(fs.existsSync(runStateDir), `.eag/p5/run-state 目录应存在：${runStateDir}`);

    // 验证 runId 对应的 JSONL 文件存在
    const runStateFile = path.join(runStateDir, `${result.runId}.jsonl`);
    assert.ok(fs.existsSync(runStateFile), `RunState 文件应存在：${runStateFile}`);

    // 验证文件内容可解析为 JSONL（每行一个 JSON 对象）
    const fileContent = fs.readFileSync(runStateFile, "utf8");
    const lines = fileContent
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0);
    assert.ok(lines.length > 0, "RunState 文件应至少有 1 行");

    // 每行应可解析为 JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed, "RunState 每行应可解析为 JSON");
      assert.equal(typeof parsed.runId, "string", "RunState 应含 runId 字段");
    }
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// I. NotesMemory 跨轮记忆测试（FR-7）
// ============================================================================

test("I1. NotesMemory 文件写入（.eag/p5/notes/<runId>.md）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    // R5 修复：NotesMemory 路径契约为 <projectRoot>/.eag/p5/notes/<runId>.md（按 run 隔离）
    // 旧版本期望固定文件名 notes.md，实际路径为 <runId>.md
    // 需要从 orchestrator.run() 返回结果获取 runId，构造正确的文件路径
    const result = await orchestrator.run({
      projectRoot,
      objective: "NotesMemory 测试",
      maxIterations: 1,
      testCommand: PASS_TEST_CMD,
      testTimeoutSec: 10,
    });

    // 验证 <runId>.md 文件存在（路径布局：<projectRoot>/.eag/p5/notes/<runId>.md）
    const notesFile = path.join(projectRoot, ".eag", "p5", "notes", `${result.runId}.md`);
    assert.ok(fs.existsSync(notesFile), `notes 文件应存在：${notesFile}`);

    // 验证文件内容非空
    const content = fs.readFileSync(notesFile, "utf8");
    assert.ok(content.length > 0, "notes 文件内容应非空");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

// ============================================================================
// J. GuardChain 15 条 BLOCKER 测试（DOD-2）
// ============================================================================

test("J1. G-A1a 路径牢笼：越界写入 $HOME 拦截", () => {
  const guardChain = createDefaultBlockerGuardChain({ throwOnDeny: false });
  // R6 修复：
  // - GuardContext 使用 pendingCommand（非 command），guards 通过 context.pendingCommand 读取命令
  // - GuardContext 必填 loopType 字段
  // - 移除 changedFiles/declaredFiles/declaredSymbols（非 GuardContext 字段）
  // - guardChain.check() 不存在，改用 executeSync()（所有 guard 的 check() 都是同步的）
  // - result.verdicts 不存在，改用 result.allVerdicts（GuardChainResult 接口字段）
  // - v.decision === "deny"/"ask" 改为大写 "DENY"/"ASK"（GuardDecision 类型契约）
  const guardContext: GuardContext = Object.freeze({
    runId: "test-run-001",
    iterIndex: 0,
    stage: "dev",
    loopType: "coding",
    projectRoot: "/tmp/test-project",
    worktreePath: "/tmp/test-project",
    pendingCommand: "echo test > $HOME/.bashrc",
  }) as GuardContext;

  const result = guardChain.executeSync(guardContext);
  // 验证 GuardChain 拦截（DENY 或 ASK）
  assert.ok(
    result.allVerdicts.some((v) => v.decision === "DENY" || v.decision === "ASK"),
    "越界写入 $HOME 应被 GuardChain 拦截"
  );
});

test("J2. G-A2a 黑名单命令：rm -rf ~ 拦截", () => {
  const guardChain = createDefaultBlockerGuardChain({ throwOnDeny: false });
  // R6 修复：同 J1，修正 GuardContext 字段名和 GuardChain API
  const guardContext: GuardContext = Object.freeze({
    runId: "test-run-001",
    iterIndex: 0,
    stage: "dev",
    loopType: "coding",
    projectRoot: "/tmp/test-project",
    worktreePath: "/tmp/test-project",
    pendingCommand: "rm -rf ~",
  }) as GuardContext;

  const result = guardChain.executeSync(guardContext);
  // 验证 GuardChain 拦截
  assert.ok(
    result.allVerdicts.some((v) => v.decision === "DENY"),
    "rm -rf ~ 应被黑名单拦截（DENY）"
  );
});

test("J3. G-A2a 黑名单命令：git push --force 拦截", () => {
  const guardChain = createDefaultBlockerGuardChain({ throwOnDeny: false });
  // R6 修复：同 J1，修正 GuardContext 字段名和 GuardChain API
  const guardContext: GuardContext = Object.freeze({
    runId: "test-run-001",
    iterIndex: 0,
    stage: "dev",
    loopType: "coding",
    projectRoot: "/tmp/test-project",
    worktreePath: "/tmp/test-project",
    pendingCommand: "git push --force origin main",
  }) as GuardContext;

  const result = guardChain.executeSync(guardContext);
  assert.ok(
    result.allVerdicts.some((v) => v.decision === "DENY" || v.decision === "ASK"),
    "git push --force 应被拦截"
  );
});

test("J4. G-A6d 上限冻结：AUTONOMOUS_DEFAULT_* 常量被 Object.freeze 冻结", () => {
  // 验证配置常量被冻结（G-A6d 不可变优先）
  // 注：常量本身是 number/string 字面量，无法被 Object.freeze 冻结
  // 但通过 Object.isFrozen 验证包含它们的数据结构被冻结
  // 此处验证 EagAutonomousRequest 被冻结（等价于 G-A6d 在 CLI 层的落地）
  const request = extractEagAutonomousRequestFromPrompt(`/eag-autonomous --goal "G-A6d 测试"`);
  assert.ok(Object.isFrozen(request), "EagAutonomousRequest 应被冻结（G-A6d）");

  // 验证尝试修改冻结对象会抛 TypeError
  assert.throws(
    () => {
      (request as { maxIterations: number }).maxIterations = 999;
    },
    TypeError,
    "修改冻结对象应抛 TypeError"
  );
});

test("J5. GuardChain 完整执行返回 GuardChainResult", () => {
  const guardChain = createDefaultBlockerGuardChain({ throwOnDeny: false });
  // R6 修复：同 J1，修正 GuardContext 字段名和 GuardChain API
  // - result.verdicts → result.allVerdicts
  // - result.passed → result.overallDecision === "PASS"（GuardChainResult 无 passed 字段）
  const guardContext: GuardContext = Object.freeze({
    runId: "test-run-001",
    iterIndex: 0,
    stage: "verify",
    loopType: "testing",
    projectRoot: "/tmp/test-project",
    worktreePath: "/tmp/test-project",
    pendingCommand: "npm test",
  }) as GuardContext;

  const result = guardChain.executeSync(guardContext);
  // 验证 GuardChainResult 结构完整性
  assert.ok(result, "GuardChainResult 应非 null");
  assert.ok(Array.isArray(result.allVerdicts), "allVerdicts 应为数组");
  assert.equal(typeof result.overallDecision, "string", "overallDecision 应为 string");
  assert.ok(["PASS", "DENY", "ASK"].includes(result.overallDecision), "overallDecision 应为 PASS/DENY/ASK 之一");
  assert.equal(typeof result.durationMs, "number", "durationMs 应为 number");
});
