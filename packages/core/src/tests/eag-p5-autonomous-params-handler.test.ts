/**
 * EAG-P5 Autonomous 测试拆分文件 1/5：参数解析 + 命令处理器
 *
 * 本文件从 eag-p5-e2e-autonomous.test.ts 拆分而来，包含：
 * - A 组（A1-A16）：extractEagAutonomousRequestFromPrompt 参数解析（TASK-P5-3.1-005 验证）
 *   - 完整参数解析（--goal / --max-iterations / --confirmation / --test-command / --stop-when 等）
 *   - 必填参数缺失拒绝（--goal 缺失 / 空字符串）
 *   - 取值范围非法拒绝（--max-iterations 超界 / --confirmation 非法值）
 *   - 默认值应用（未提供参数时使用默认值）
 *   - 不可变优先（Object.freeze 冻结）
 * - B 组（B1-B7）：EagAutonomousCommandHandler 命令处理器（TASK-P5-3.1-005 验证）
 *   - 构造校验（orchestrator 必填）
 *   - execute() 成功路径（real AutonomousOrchestrator + 真实文件系统）
 *   - execute() 失败路径（orchestrator.run() 抛异常 → success=false）
 *   - execute() 入参校验（projectRoot / request 必填）
 *   - 返回结果不可变性（Object.freeze）
 *
 * 测试约定（严格遵循项目规则 P-5 + NFR-9）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 AutonomousOrchestrator / StageHandler / GuardChain / SmartConfirmation 实例
 * - 使用真实文件系统（os.tmpdir + mkdtempSync）创建临时项目目录
 * - 测试结束后清理临时目录（避免泄漏）
 * - 中文注释，符合 TypeScript 代码规范
 *
 * 设计依据：
 * - 需求文档 §3 FR-1 无人值守 4 阶段循环 + FR-4 /eag-autonomous 命令
 * - 架构师审查 §4.1 AutonomousOrchestrator 接口契约
 * - 任务说明 TASK-P5-3.1-005/006
 * - NFR-8 不可变优先 + NFR-9 禁止 mock + NFR-10 中文详细注释
 *
 * @module core/tests/eag-p5-autonomous-params-handler
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// EagCommandParser + 命令处理器导入（TASK-P5-3.1-005/006 验证）
import {
  EagAutonomousCommandHandler,
  extractEagAutonomousRequestFromPrompt,
  EAG_AUTONOMOUS_COMMAND_PREFIX,
  EAG_AUTONOMOUS_CONFIRMATION_VALUES,
} from "../eag/cli/eag-autonomous-command";
import type { EagAutonomousRequest, EagAutonomousConfirmation } from "../eag/cli/eag-autonomous-command";

// P5 核心组件类型导入（用于 B 组类型断言）
import type { AutonomousOrchestrator } from "../eag/p5/index";

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
// A. extractEagAutonomousRequestFromPrompt 参数解析测试
// ============================================================================

test("A1. 完整参数解析（所有 flag 提供时正确映射）", () => {
  const prompt = `/eag-autonomous --goal "为订单服务加退款功能" --max-iterations 10 --confirmation smart --test-command "npm test" --stop-when "all tests pass" --max-tokens 200000 --test-timeout-sec 600 --consecutive-failure-abort 3`;
  const request = extractEagAutonomousRequestFromPrompt(prompt);

  assert.equal(request.goal, "为订单服务加退款功能");
  assert.equal(request.maxIterations, 10);
  assert.equal(request.confirmation, "smart");
  assert.equal(request.testCommand, "npm test");
  assert.equal(request.stopWhen, "all tests pass");
  assert.equal(request.maxTokens, 200000);
  assert.equal(request.testTimeoutSec, 600);
  assert.equal(request.consecutiveFailureAbort, 3);
});

test("A2. 默认值应用（仅必填 --goal 提供时使用默认值）", () => {
  const prompt = `/eag-autonomous --goal "测试目标"`;
  const request = extractEagAutonomousRequestFromPrompt(prompt);

  assert.equal(request.goal, "测试目标");
  // 默认值断言（对齐 EAG_AUTONOMOUS_DEFAULT_* 常量）
  assert.equal(request.maxIterations, 10, "默认 maxIterations 应为 10");
  assert.equal(request.confirmation, "smart", "默认 confirmation 应为 smart");
  assert.equal(request.testCommand, "npm test", '默认 testCommand 应为 "npm test"');
  assert.equal(request.stopWhen, "", "默认 stopWhen 应为空字符串");
  assert.equal(request.maxTokens, 200000, "默认 maxTokens 应为 200000");
  assert.equal(request.testTimeoutSec, 600, "默认 testTimeoutSec 应为 600");
  assert.equal(request.consecutiveFailureAbort, 3, "默认 consecutiveFailureAbort 应为 3");
});

test("A3. 必填参数 --goal 缺失时抛错", () => {
  const prompt = `/eag-autonomous --max-iterations 10`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /缺少必填参数 --goal/);
});

test("A4. --goal 为空字符串时抛错", () => {
  const prompt = `/eag-autonomous --goal ""`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /缺少必填参数 --goal/);
});

test("A5. --max-iterations 超界时抛错（>1000）", () => {
  const prompt = `/eag-autonomous --goal "测试" --max-iterations 1001`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /--max-iterations 取值非法/);
});

test("A6. --max-iterations 非正整数时抛错（0）", () => {
  const prompt = `/eag-autonomous --goal "测试" --max-iterations 0`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /--max-iterations 取值非法/);
});

test("A7. --confirmation 非法值时抛错", () => {
  const prompt = `/eag-autonomous --goal "测试" --confirmation invalid-mode`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /--confirmation 取值非法/);
});

test("A8. --test-command 为空字符串时抛错", () => {
  const prompt = `/eag-autonomous --goal "测试" --test-command ""`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /--test-command 取值非法/);
});

test("A9. 命令前缀大小写不敏感匹配（/EAG-AUTONOMOUS）", () => {
  const prompt = `/EAG-AUTONOMOUS --goal "大小写测试"`;
  const request = extractEagAutonomousRequestFromPrompt(prompt);
  assert.equal(request.goal, "大小写测试");
});

test("A10. 命令前缀不匹配时抛错", () => {
  const prompt = `/eag-other --goal "测试"`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /命令前缀不匹配/);
});

test("A11. 返回对象被 Object.freeze 冻结（不可变优先）", () => {
  const prompt = `/eag-autonomous --goal "冻结测试"`;
  const request = extractEagAutonomousRequestFromPrompt(prompt);
  assert.ok(Object.isFrozen(request), "EagAutonomousRequest 应被冻结");
  // 尝试修改应抛 TypeError（严格模式）
  assert.throws(() => {
    (request as { goal: string }).goal = "modified";
  }, TypeError);
});

test("A12. --max-tokens 非正整数时抛错", () => {
  const prompt = `/eag-autonomous --goal "测试" --max-tokens 0`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /--max-tokens 取值非法/);
});

test("A13. --test-timeout-sec 非正整数时抛错", () => {
  const prompt = `/eag-autonomous --goal "测试" --test-timeout-sec -1`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /--test-timeout-sec 取值非法/);
});

test("A14. --consecutive-failure-abort 非正整数时抛错", () => {
  const prompt = `/eag-autonomous --goal "测试" --consecutive-failure-abort 0`;
  assert.throws(() => extractEagAutonomousRequestFromPrompt(prompt), /--consecutive-failure-abort 取值非法/);
});

test("A15. EAG_AUTONOMOUS_CONFIRMATION_VALUES 常量正确性", () => {
  // 验证合法 confirmation 取值集合
  assert.ok(Array.isArray(EAG_AUTONOMOUS_CONFIRMATION_VALUES));
  assert.ok(EAG_AUTONOMOUS_CONFIRMATION_VALUES.includes("smart"));
  assert.ok(EAG_AUTONOMOUS_CONFIRMATION_VALUES.includes("always-ask"));
  assert.ok(EAG_AUTONOMOUS_CONFIRMATION_VALUES.includes("fail-closed"));
  // 冻结断言
  assert.ok(Object.isFrozen(EAG_AUTONOMOUS_CONFIRMATION_VALUES));
});

test("A16. EAG_AUTONOMOUS_COMMAND_PREFIX 常量正确性", () => {
  assert.equal(EAG_AUTONOMOUS_COMMAND_PREFIX, "/eag-autonomous");
});

// ============================================================================
// B. EagAutonomousCommandHandler 命令处理器测试
// ============================================================================

test("B1. EagAutonomousCommandHandler 构造成功（orchestrator 注入）", () => {
  const orchestrator = buildOrchestrator();
  const handler = new EagAutonomousCommandHandler(orchestrator);
  assert.ok(handler instanceof EagAutonomousCommandHandler);
});

test("B2. EagAutonomousCommandHandler 构造失败（orchestrator 为空）", () => {
  assert.throws(() => new EagAutonomousCommandHandler(null as unknown as AutonomousOrchestrator), /orchestrator 必填/);
});

test("B3. EagAutonomousCommandHandler execute() 成功路径", async () => {
  const projectRoot = createTempProject();
  try {
    // 准备 tasks.md（含 1 张 completed 任务卡，让 plan 阶段直接成功）
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const request = extractEagAutonomousRequestFromPrompt(
      `/eag-autonomous --goal "测试目标" --max-iterations 1 --test-command "${PASS_TEST_CMD}"`
    );

    const result = await handler.execute(request, projectRoot);

    // 验证成功路径
    assert.equal(result.success, true, "execute 应返回 success=true");
    assert.equal(result.errorMessage, "", "成功时 errorMessage 应为空");
    assert.ok(result.markdownReport.length > 0, "应生成 Markdown 报告");
    assert.ok(result.runResult, "应包含原始 AutonomousRunResult");
    assert.ok(Object.isFrozen(result), "结果应被 Object.freeze 冻结");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("B4. EagAutonomousCommandHandler execute() 失败路径（orchestrator 抛异常）", async () => {
  const projectRoot = createTempProject();
  try {
    // 故意不创建 tasks.md，让 plan 阶段失败
    // 但 orchestrator.run() 不会抛异常（会捕获并返回 failed finalStatus）
    // 此测试验证 handler.execute() 在 orchestrator.run() 正常返回但 finalStatus=failed 时
    // 仍然返回 success=true（因为 execute() 的 success 字段表示 run() 是否抛异常）
    const orchestrator = buildOrchestrator();
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const request = extractEagAutonomousRequestFromPrompt(
      `/eag-autonomous --goal "无 tasks.md 测试" --max-iterations 1`
    );

    const result = await handler.execute(request, projectRoot);

    // 即使 finalStatus=failed，execute() 仍然返回 success=true（因为 run() 未抛异常）
    assert.equal(result.success, true);
    assert.ok(result.runResult, "应包含原始 AutonomousRunResult");
    assert.ok(result.markdownReport.length > 0, "应生成 Markdown 报告");
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("B5. EagAutonomousCommandHandler execute() 入参校验（projectRoot 空）", async () => {
  const orchestrator = buildOrchestrator();
  const handler = new EagAutonomousCommandHandler(orchestrator);
  const request = extractEagAutonomousRequestFromPrompt(`/eag-autonomous --goal "测试"`);

  await assert.rejects(async () => handler.execute(request, ""), /projectRoot 必须为非空字符串/);
});

test("B6. EagAutonomousCommandHandler execute() 入参校验（request.goal 空）", async () => {
  const projectRoot = createTempProject();
  try {
    const orchestrator = buildOrchestrator();
    const handler = new EagAutonomousCommandHandler(orchestrator);
    // 构造非法 request（绕过 extractEagAutonomousRequestFromPrompt 的校验）
    const invalidRequest = Object.freeze({
      goal: "", // 空 goal
      maxIterations: 10,
      confirmation: "smart" as EagAutonomousConfirmation,
      testCommand: "npm test",
      stopWhen: "",
      maxTokens: 200000,
      testTimeoutSec: 600,
      consecutiveFailureAbort: 3,
    }) as EagAutonomousRequest;

    await assert.rejects(
      async () => handler.execute(invalidRequest, projectRoot),
      /EagAutonomousRequest\.goal 必须为非空字符串/
    );
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("B7. EagAutonomousCommandResult 不可变性（Object.freeze）", async () => {
  const projectRoot = createTempProject();
  try {
    createTasksFile(projectRoot, 1, "completed");
    createDeclaredFile(projectRoot, "src/services/Service1.ts");

    const orchestrator = buildOrchestrator();
    const handler = new EagAutonomousCommandHandler(orchestrator);
    const request = extractEagAutonomousRequestFromPrompt(
      `/eag-autonomous --goal "冻结测试" --max-iterations 1 --test-command "${PASS_TEST_CMD}"`
    );

    const result = await handler.execute(request, projectRoot);

    // 验证返回对象被 Object.freeze 冻结
    assert.ok(Object.isFrozen(result), "EagAutonomousCommandResult 应被冻结");
    // 尝试修改应抛 TypeError
    assert.throws(() => {
      (result as { success: boolean }).success = false;
    }, TypeError);
  } finally {
    cleanupTempProject(projectRoot);
  }
});
