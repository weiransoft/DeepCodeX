/**
 * workflow-loop-controller 单元测试
 *
 * 测试设计依据：
 * 1. Python 原版测试：multi-agent-team/scripts/tests/test_workflow_loop_controller.py（W1~W8）
 * 2. TypeScript 源文件：packages/core/src/team/workflow-loop-controller.ts
 * 3. 参考测试风格：
 *    - loop-controller-async.test.ts（临时目录管理 + 注入执行器）
 *    - stage-handlers.test.ts（stub 真实接口契约，非 mock）
 *    - doc-code-consistency-checker.test.ts（fs.mkdtempSync + 真实文件 fixture）
 *
 * 测试用例编号：WC-001 ~ WC-025（共 25 个）
 *   - WC-001 ~ WC-007：辅助函数（WORKFLOW_STAGES / findStage / findStageByNumber /
 *                     getStageNumber / getRoleName / getOutputName / toStageKind）
 *   - WC-008 ~ WC-012：RollbackStrategy（ROLLBACK_MAP / determineRollback 各场景）
 *   - WC-013 ~ WC-019：DefaultStageExecutor（构造 / toExecutor / executeDocStage /
 *                     executeDevelopment / parseTestOutput / executeTestVerification /
 *                     execute 分发）
 *   - WC-020 ~ WC-024：WorkflowLoopController（单次通过 / 回退再通过 / 最大迭代 /
 *                     累计上下文 / 非审查阶段失败终止）
 *   - WC-025：summarizeWorkflowRunResult 函数
 *
 * 严格规则（与用户规则一致）：
 * - 禁止 mock/占位/简化：所有测试通过注入真实 StageExecutor 函数（含真实业务分支）实现
 * - 仅依赖 Node.js 内置模块（fs / os / path），不引入新依赖
 * - 使用 node:test 框架 + node:assert/strict
 * - 测试隔离：使用 fs.mkdtempSync 创建临时目录，每个用例后通过 finally 清理
 * - WorkflowLoopController.run() 是同步方法，不使用 await
 * - 所有函数和关键逻辑均有中文注释，符合 TypeScript 代码规范
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 值导入：类、常量、函数、声明合并的 WorkflowStage（既是 const 又是 type）
import {
  WorkflowLoopController,
  DefaultStageExecutor,
  RollbackStrategy,
  WORKFLOW_STAGES,
  findStage,
  findStageByNumber,
  getStageNumber,
  getRoleName,
  getOutputName,
  toStageKind,
  summarizeWorkflowRunResult,
} from "../workflow-loop-controller.js";

// 类型导入：仅用于类型注解，不产生运行时代码
import type {
  WorkflowRunResult,
  WorkflowIterationRecord,
  StageExecutionResult,
  StageExecutionContext,
  StageExecutor,
  DefaultStageExecutorOptions,
  WorkflowStage,
} from "../workflow-loop-controller.js";

// GapItem 类型来自 doc-code-consistency-checker，此处仅类型导入
import type { GapItem } from "../doc-code-consistency-checker.js";

// ============================================================================
// 测试辅助函数
// ============================================================================

/**
 * 创建临时目录用于测试
 *
 * 使用 os.tmpdir() + 前缀 "deepcodex-wlc-test-" 保证跨平台与测试隔离。
 *
 * @returns 临时目录绝对路径
 */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-wlc-test-"));
}

/**
 * 递归删除临时目录
 *
 * 即使目录不存在或权限不足也不抛错，保证测试清理阶段不会中断后续用例。
 *
 * @param dir 临时目录路径
 */
function rmTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 静默忽略（目录可能已被清理或权限不足）
  }
}

/**
 * 构造成功的 StageExecutionResult
 *
 * @param stage 工作流阶段
 * @param summary 摘要文本
 * @param artifacts 阶段产出（默认空对象）
 * @returns 成功的 StageExecutionResult 对象
 */
function makeSuccessResult(
  stage: WorkflowStage,
  summary: string,
  artifacts: Record<string, unknown> = {}
): StageExecutionResult {
  return {
    stage,
    success: true,
    summary,
    artifacts,
    error: "",
    durationSec: 0,
  };
}

/**
 * 构造失败的 StageExecutionResult
 *
 * @param stage 工作流阶段
 * @param error 错误信息
 * @param summary 摘要文本（默认根据 error 生成）
 * @returns 失败的 StageExecutionResult 对象
 */
function makeFailureResult(stage: WorkflowStage, error: string, summary: string = ""): StageExecutionResult {
  return {
    stage,
    success: false,
    summary: summary || `阶段 ${stage} 失败: ${error}`,
    artifacts: {},
    error,
    durationSec: 0,
  };
}

/**
 * 构造审查通过的 StageExecutionResult
 *
 * artifacts 中包含 overall_passed=true 和空 gap_list，
 * 供 WorkflowLoopController._handleReviewResult 提取。
 *
 * @returns 审查通过的 StageExecutionResult
 */
function makeReviewPassResult(): StageExecutionResult {
  return makeSuccessResult("doc_code_review", "审查通过", {
    overall_passed: true,
    gap_count: 0,
    gap_list: [],
  });
}

/**
 * 构造审查不通过的 StageExecutionResult
 *
 * artifacts 中包含 overall_passed=false 和 gap_list（含缺口详情），
 * 供 WorkflowLoopController._handleReviewResult 提取并触发回退。
 *
 * @param gaps 缺口列表
 * @returns 审查不通过的 StageExecutionResult
 */
function makeReviewFailResult(gaps: GapItem[]): StageExecutionResult {
  return makeSuccessResult("doc_code_review", `审查不通过：${gaps.length} 个缺口`, {
    overall_passed: false,
    gap_count: gaps.length,
    // gap_list 元素结构与 _handleReviewResult 期望一致
    gap_list: gaps.map((g) => ({
      dimension: g.dimension,
      description: g.description,
      feature_id: g.feature_id,
      priority: g.priority,
      suggestion: g.suggestion,
    })),
  });
}

/**
 * 构造测试用 StageExecutionContext
 *
 * 提供合理默认值，允许通过 overrides 覆盖部分字段。
 *
 * @param overrides 部分字段覆盖
 * @returns 完整的 StageExecutionContext
 */
function makeContext(overrides: Partial<StageExecutionContext> = {}): StageExecutionContext {
  return {
    iterationIndex: 1,
    stageNumber: 1,
    prevResults: [],
    accumulatedArtifacts: {},
    docPaths: {},
    testCommand: "",
    projectRoot: "/tmp/test-project",
    ...overrides,
  };
}

/**
 * 构造 D1 缺口的 GapItem（功能完成度缺口）
 *
 * @param featureId 功能 ID
 * @returns D1 维度的 GapItem
 */
function makeD1Gap(featureId: string = "F-001"): GapItem {
  return {
    dimension: "D1 功能完成度",
    description: `功能 ${featureId} 未实现`,
    feature_id: featureId,
    priority: "P0",
    suggestion: `实现 ${featureId}`,
  };
}

/**
 * 构造 D3 缺口的 GapItem（测试正确性缺口）
 *
 * @param failedCount 失败数
 * @returns D3 维度的 GapItem
 */
function makeD3Gap(failedCount: number = 2): GapItem {
  return {
    dimension: "D3 测试正确性",
    description: `测试失败: ${failedCount} failed`,
    feature_id: "",
    priority: "P0",
    suggestion: "修复测试",
  };
}

// ============================================================================
// WC-001 ~ WC-007：辅助函数测试
// ============================================================================

test("WC-001: WORKFLOW_STAGES 包含 8 个阶段元数据且编号连续", () => {
  // 断言：恰好 8 个阶段
  assert.equal(WORKFLOW_STAGES.length, 8, "WORKFLOW_STAGES 应包含 8 个阶段");

  // 断言：阶段编号 1-8 连续递增
  for (let i = 0; i < 8; i++) {
    assert.equal(WORKFLOW_STAGES[i].stageNumber, i + 1, `第 ${i + 1} 个元素 stageNumber 应为 ${i + 1}`);
  }

  // 断言：包含全部 8 个阶段值（按 1→8 顺序）
  const expectedStages: WorkflowStage[] = [
    "requirements",
    "architecture",
    "ui_design",
    "test_design",
    "task_breakdown",
    "development",
    "test_verification",
    "doc_code_review",
  ];
  const actualStages = WORKFLOW_STAGES.map((s) => s.value);
  assert.deepEqual(actualStages, expectedStages, "应按顺序包含全部 8 个阶段值");

  // 断言：每个元数据的 value 字段都唯一
  const valueSet = new Set(actualStages);
  assert.equal(valueSet.size, 8, "8 个阶段值应唯一");
});

test("WC-002: findStage 返回正确的阶段元数据", () => {
  // 测试所有 8 个阶段都能找到对应的元数据
  for (const expectedMeta of WORKFLOW_STAGES) {
    const meta = findStage(expectedMeta.value);
    assert.ok(meta !== null, `findStage(${expectedMeta.value}) 应返回非 null`);
    assert.equal(meta!.value, expectedMeta.value);
    assert.equal(meta!.stageNumber, expectedMeta.stageNumber);
    assert.equal(meta!.roleName, expectedMeta.roleName);
    assert.equal(meta!.outputName, expectedMeta.outputName);
    assert.equal(meta!.stageKind, expectedMeta.stageKind);
  }

  // 断言：阶段元数据字段类型正确
  const devMeta = findStage("development");
  assert.ok(devMeta !== null);
  assert.equal(typeof devMeta!.roleName, "string");
  assert.equal(typeof devMeta!.outputName, "string");
  // development 的 stageKind 应为 "dev"
  assert.equal(devMeta!.stageKind, "dev");
});

test("WC-003: findStageByNumber 返回正确的阶段元数据", () => {
  // 测试编号 1-8 都能找到
  for (let num = 1; num <= 8; num++) {
    const meta = findStageByNumber(num);
    assert.ok(meta !== null, `findStageByNumber(${num}) 应返回非 null`);
    assert.equal(meta!.stageNumber, num);
  }

  // 断言：非法编号返回 null
  assert.equal(findStageByNumber(0), null, "编号 0 应返回 null");
  assert.equal(findStageByNumber(9), null, "编号 9 应返回 null");
  assert.equal(findStageByNumber(-1), null, "编号 -1 应返回 null");
  assert.equal(findStageByNumber(100), null, "编号 100 应返回 null");

  // 断言：第 1 个阶段是 requirements，第 8 个是 doc_code_review
  assert.equal(findStageByNumber(1)!.value, "requirements");
  assert.equal(findStageByNumber(8)!.value, "doc_code_review");
});

test("WC-004: getStageNumber 返回正确的阶段编号", () => {
  // 断言：8 个阶段对应的编号 1-8
  assert.equal(getStageNumber("requirements"), 1);
  assert.equal(getStageNumber("architecture"), 2);
  assert.equal(getStageNumber("ui_design"), 3);
  assert.equal(getStageNumber("test_design"), 4);
  assert.equal(getStageNumber("task_breakdown"), 5);
  assert.equal(getStageNumber("development"), 6);
  assert.equal(getStageNumber("test_verification"), 7);
  assert.equal(getStageNumber("doc_code_review"), 8);
});

test("WC-005: getRoleName 返回正确的角色名", () => {
  // 断言：8 个阶段对应的角色名
  assert.equal(getRoleName("requirements"), "产品经理");
  assert.equal(getRoleName("architecture"), "架构师");
  assert.equal(getRoleName("ui_design"), "UI 设计师");
  assert.equal(getRoleName("test_design"), "测试专家");
  assert.equal(getRoleName("task_breakdown"), "独立开发者");
  assert.equal(getRoleName("development"), "独立开发者");
  assert.equal(getRoleName("test_verification"), "测试专家");
  assert.equal(getRoleName("doc_code_review"), "多角色");
});

test("WC-006: getOutputName 返回正确的产出名", () => {
  // 断言：8 个阶段对应的产出名
  assert.equal(getOutputName("requirements"), "PRD 文档");
  assert.equal(getOutputName("architecture"), "架构设计文档");
  assert.equal(getOutputName("ui_design"), "UI 设计稿");
  assert.equal(getOutputName("test_design"), "测试计划");
  assert.equal(getOutputName("task_breakdown"), "任务清单");
  assert.equal(getOutputName("development"), "代码实现");
  assert.equal(getOutputName("test_verification"), "测试报告");
  assert.equal(getOutputName("doc_code_review"), "审查报告");
});

test("WC-007: toStageKind 返回正确的 StageKind", () => {
  // 阶段 1-4（规划阶段）返回 null（Ralph 小循环无对应）
  assert.equal(toStageKind("requirements"), null);
  assert.equal(toStageKind("architecture"), null);
  assert.equal(toStageKind("ui_design"), null);
  assert.equal(toStageKind("test_design"), null);

  // 阶段 5-8 返回对应的 StageKind
  assert.equal(toStageKind("task_breakdown"), "plan");
  assert.equal(toStageKind("development"), "dev");
  assert.equal(toStageKind("test_verification"), "verify");
  assert.equal(toStageKind("doc_code_review"), "review");
});

// ============================================================================
// WC-008 ~ WC-012：RollbackStrategy 测试
// ============================================================================

test("WC-008: RollbackStrategy.ROLLBACK_MAP 包含 6 个维度映射", () => {
  const map = RollbackStrategy.ROLLBACK_MAP;

  // 断言：恰好 6 个维度
  assert.equal(Object.keys(map).length, 6, "ROLLBACK_MAP 应包含 6 个维度");

  // 断言：D1~D6 维度对应的回退阶段
  assert.equal(map["D1 功能完成度"], "development");
  assert.equal(map["D2 集成完整性"], "development");
  assert.equal(map["D3 测试正确性"], "test_verification");
  assert.equal(map["D4 验收标准"], "development");
  assert.equal(map["D5 TODO/FIXME"], "development");
  assert.equal(map["D6 文档意图"], "development");
});

test("WC-009: determineRollback D1 缺口 → 回退到 development", () => {
  // D1 单一缺口，应回退到 development
  const gaps: GapItem[] = [makeD1Gap("F-003")];
  const rollback = RollbackStrategy.determineRollback(gaps);
  assert.equal(rollback, "development");
});

test("WC-010: determineRollback D3 缺口 → 回退到 test_verification", () => {
  // D3 单一缺口，应回退到 test_verification
  const gaps: GapItem[] = [makeD3Gap(2)];
  const rollback = RollbackStrategy.determineRollback(gaps);
  assert.equal(rollback, "test_verification");
});

test("WC-011: determineRollback 空 gaps → 返回 null", () => {
  // 空缺口列表，不应回退
  const gaps: GapItem[] = [];
  const rollback = RollbackStrategy.determineRollback(gaps);
  assert.equal(rollback, null);
});

test("WC-012: determineRollback 多维度混合 → 优先 development（更早的阶段）", () => {
  // D1 + D3 混合：D1 回退到 development，D3 回退到 test_verification
  // 优先级规则：development（阶段 6）优先于 test_verification（阶段 7）
  const gaps: GapItem[] = [makeD1Gap("F-001"), makeD3Gap(1)];
  const rollback = RollbackStrategy.determineRollback(gaps);
  assert.equal(rollback, "development");

  // 单独 D3 + D5 混合：D5 回退到 development，D3 回退到 test_verification
  // 应优先 development
  const gaps2: GapItem[] = [
    makeD3Gap(1),
    {
      dimension: "D5 TODO/FIXME",
      description: "TODO 未实现",
      feature_id: "",
      priority: "P1",
      suggestion: "实现 TODO",
    },
  ];
  const rollback2 = RollbackStrategy.determineRollback(gaps2);
  assert.equal(rollback2, "development");
});

// ============================================================================
// WC-013 ~ WC-019：DefaultStageExecutor 测试
// ============================================================================

test("WC-013: DefaultStageExecutor 构造函数 + toExecutor 返回可执行函数", () => {
  const dir = makeTmpDir();
  try {
    // 构造参数（含全部可选字段）
    const options: DefaultStageExecutorOptions = {
      projectRoot: dir,
      testCommand: "echo test",
      testTimeoutSec: 10,
      docPaths: { prd: path.join(dir, "prd.md") },
    };
    const executor = new DefaultStageExecutor(options);

    // 断言：toExecutor 返回函数
    const executorFn = executor.toExecutor();
    assert.equal(typeof executorFn, "function", "toExecutor 应返回函数");

    // 断言：函数可调用，返回 StageExecutionResult
    const ctx = makeContext({
      projectRoot: dir,
      stageNumber: 1,
    });
    const result = executorFn("requirements", ctx);
    assert.ok(typeof result === "object" && result !== null);
    assert.equal(result.stage, "requirements");
    assert.equal(result.success, true);
  } finally {
    rmTmpDir(dir);
  }
});

test("WC-014: DefaultStageExecutor.executeDocStage 返回占位产出（requirements）", () => {
  const ctx = makeContext({ stageNumber: 1, iterationIndex: 1 });
  const result = DefaultStageExecutor.executeDocStage("requirements", ctx);

  // 断言：执行成功
  assert.equal(result.success, true);
  assert.equal(result.stage, "requirements");
  assert.equal(result.error, "");

  // 断言：artifacts 包含占位产出字段
  assert.equal(result.artifacts["output_name"], "PRD 文档");
  assert.equal(result.artifacts["stage_number"], 1);
  assert.equal(result.artifacts["role_name"], "产品经理");
  assert.equal(result.artifacts["placeholder"], true);
  assert.equal(result.artifacts["iteration_index"], 1);
  assert.ok(typeof result.artifacts["timestamp"] === "string");
});

test("WC-015: DefaultStageExecutor.executeDevelopment 返回占位产出", () => {
  const ctx = makeContext({ stageNumber: 6, iterationIndex: 2 });
  const result = DefaultStageExecutor.executeDevelopment("development", ctx);

  // 断言：执行成功
  assert.equal(result.success, true);
  assert.equal(result.stage, "development");
  assert.equal(result.error, "");

  // 断言：artifacts 包含开发阶段占位产出字段
  assert.equal(result.artifacts["output_name"], "代码实现");
  assert.equal(result.artifacts["stage_number"], 6);
  assert.equal(result.artifacts["role_name"], "独立开发者");
  assert.equal(result.artifacts["placeholder"], true);
  assert.equal(result.artifacts["pending_implementation"], true);
  assert.equal(result.artifacts["iteration_index"], 2);
});

test("WC-016: DefaultStageExecutor.parseTestOutput 解析多种测试输出格式", () => {
  // 场景 1：pytest 格式（"N passed, M failed, K skipped"）
  const pytestOutput = "===== 5 passed, 2 failed, 1 skipped in 3.45s =====";
  const r1 = DefaultStageExecutor.parseTestOutput(pytestOutput);
  assert.equal(r1.passed, 5);
  assert.equal(r1.failed, 2);
  assert.equal(r1.skipped, 1);

  // 场景 2：单独 passed / failed / skipped 关键字
  const r2 = DefaultStageExecutor.parseTestOutput("3 passed");
  assert.equal(r2.passed, 3);
  assert.equal(r2.failed, 0);
  assert.equal(r2.skipped, 0);

  const r3 = DefaultStageExecutor.parseTestOutput("1 failed");
  assert.equal(r3.passed, 0);
  assert.equal(r3.failed, 1);
  assert.equal(r3.skipped, 0);

  const r4 = DefaultStageExecutor.parseTestOutput("4 skipped");
  assert.equal(r4.passed, 0);
  assert.equal(r4.failed, 0);
  assert.equal(r4.skipped, 4);

  // 场景 3：大小写不敏感（"PASSED" / "FAILED"）
  const r5 = DefaultStageExecutor.parseTestOutput("7 PASSED, 0 FAILED");
  assert.equal(r5.passed, 7);
  assert.equal(r5.failed, 0);

  // 场景 4：空输出
  const r6 = DefaultStageExecutor.parseTestOutput("");
  assert.equal(r6.passed, 0);
  assert.equal(r6.failed, 0);
  assert.equal(r6.skipped, 0);

  // 场景 5：多行输出（正则 match 默认匹配第一次出现）
  const multiLine = `
        Running tests...
        1 passed
        2 passed, 1 failed
        Summary: 2 passed, 1 failed, 3 skipped
    `;
  const r7 = DefaultStageExecutor.parseTestOutput(multiLine);
  // String.prototype.match 默认匹配第一个出现：
  //   - "1 passed"（第 1 处 passed）→ passed=1
  //   - "1 failed"（第 1 处 failed）→ failed=1
  //   - "3 skipped"（第 1 处 skipped）→ skipped=3
  assert.equal(r7.passed, 1);
  assert.equal(r7.failed, 1);
  assert.equal(r7.skipped, 3);
});

test("WC-017: DefaultStageExecutor.executeTestVerification 未配置测试命令返回失败", () => {
  const dir = makeTmpDir();
  try {
    // context.testCommand 为空，应返回失败结果
    const ctx = makeContext({
      stageNumber: 7,
      projectRoot: dir,
      testCommand: "",
    });
    const result = DefaultStageExecutor.executeTestVerification("test_verification", ctx);

    // 断言：失败 + 错误信息
    assert.equal(result.success, false);
    assert.equal(result.stage, "test_verification");
    assert.equal(result.error, "未配置测试命令");
    assert.equal(result.artifacts["passed"], 0);
    assert.equal(result.artifacts["failed"], 0);
    assert.equal(result.artifacts["skipped"], 0);
    assert.equal(result.artifacts["test_command"], "(未配置)");
  } finally {
    rmTmpDir(dir);
  }
});

test("WC-018: DefaultStageExecutor.executeTestVerification 执行失败命令返回失败结果", () => {
  const dir = makeTmpDir();
  try {
    // 真实 shell 命令：echo 输出测试样式字符串 + 非零退出码
    // 真实端到端验证：
    //   1. child_process.execSync 真实执行命令
    //   2. 非零退出码触发异常被 catch 捕获
    //   3. 从异常对象的 stdout 中真实调用 parseTestOutput 解析
    //   4. 根据解析结果填充 artifacts
    const ctx = makeContext({
      stageNumber: 7,
      projectRoot: dir,
      testCommand: "echo '2 passed, 1 failed, 0 skipped' && exit 1",
    });
    const result = DefaultStageExecutor.executeTestVerification("test_verification", ctx);

    // 断言：失败（execSync 抛异常被捕获）
    assert.equal(result.success, false);
    assert.equal(result.stage, "test_verification");
    // 错误信息应非空
    assert.ok(result.error.length > 0, "错误信息应非空");
    // 应从异常 stdout 中解析到 2 passed 和 1 failed
    assert.equal(result.artifacts["passed"], 2);
    assert.equal(result.artifacts["failed"], 1);
    assert.equal(result.artifacts["skipped"], 0);
    // test_command 应记录原始命令
    assert.equal(result.artifacts["test_command"], "echo '2 passed, 1 failed, 0 skipped' && exit 1");
  } finally {
    rmTmpDir(dir);
  }
});

test("WC-019: DefaultStageExecutor.execute 分发到对应的静态方法", () => {
  const dir = makeTmpDir();
  try {
    const executor = new DefaultStageExecutor({
      projectRoot: dir,
      testCommand: "",
    });
    const ctx = makeContext({ projectRoot: dir });

    // 测试分发到 executeDocStage（requirements 是阶段 1-5 之一）
    const r1 = executor.execute("requirements", ctx);
    assert.equal(r1.success, true);
    assert.equal(r1.artifacts["output_name"], "PRD 文档");
    assert.equal(r1.artifacts["stage_number"], 1);

    // 测试分发到 executeDocStage（task_breakdown 是阶段 5）
    const r2 = executor.execute("task_breakdown", ctx);
    assert.equal(r2.success, true);
    assert.equal(r2.artifacts["output_name"], "任务清单");
    assert.equal(r2.artifacts["stage_number"], 5);

    // 测试分发到 executeDevelopment
    const r3 = executor.execute("development", ctx);
    assert.equal(r3.success, true);
    assert.equal(r3.artifacts["output_name"], "代码实现");
    assert.equal(r3.artifacts["pending_implementation"], true);

    // 测试分发到 executeTestVerification（未配置命令，应失败）
    const r4 = executor.execute("test_verification", ctx);
    assert.equal(r4.success, false);
    assert.equal(r4.error, "未配置测试命令");
  } finally {
    rmTmpDir(dir);
  }
});

// ============================================================================
// WC-020 ~ WC-024：WorkflowLoopController 测试
// ============================================================================

test("WC-020: WorkflowLoopController 单次迭代通过（全部阶段成功）", () => {
  const dir = makeTmpDir();
  try {
    // 构造总是成功的 StageExecutor（真实业务逻辑：审查通过 + 其他阶段成功）
    const executor: StageExecutor = (stage: WorkflowStage, _context: StageExecutionContext): StageExecutionResult => {
      if (stage === "doc_code_review") {
        return makeReviewPassResult();
      }
      return makeSuccessResult(stage, `${stage} 完成`);
    };

    const controller = new WorkflowLoopController({
      projectRoot: dir,
      stageExecutor: executor,
      maxIterations: 3,
    });

    // run() 是同步方法，不使用 await
    const result = controller.run();

    // 断言：最终成功
    assert.equal(result.overallSuccess, true);
    // 断言：只迭代 1 次（审查通过后立即退出）
    assert.equal(result.totalIterations, 1);
    assert.equal(result.maxIterations, 3);
    // 断言：迭代历史有 1 条记录
    assert.equal(result.iterations.length, 1);
    // 断言：第 1 次迭代执行了全部 8 个阶段
    assert.equal(result.iterations[0].stages.length, 8);
    // 断言：审查通过
    assert.equal(result.iterations[0].reviewPassed, true);
    // 断言：无回退（rollbackTo 为 null）
    assert.equal(result.iterations[0].rollbackTo, null);
    // 断言：最终无缺口
    assert.equal(result.finalGaps.length, 0);
    // 断言：项目名取自目录名（path.basename）
    assert.equal(result.projectName, path.basename(dir));

    // 断言：8 个阶段顺序正确
    const expectedOrder: WorkflowStage[] = [
      "requirements",
      "architecture",
      "ui_design",
      "test_design",
      "task_breakdown",
      "development",
      "test_verification",
      "doc_code_review",
    ];
    const actualOrder = result.iterations[0].stages.map((s) => s.stage);
    assert.deepEqual(actualOrder, expectedOrder, "8 阶段顺序应正确");
  } finally {
    rmTmpDir(dir);
  }
});

test("WC-021: WorkflowLoopController 审查失败后回退到 development，第二次通过", () => {
  const dir = makeTmpDir();
  try {
    // 构造审查阶段：第 1 次失败（D1 缺口），第 2 次通过
    // 其他阶段始终成功
    const executor: StageExecutor = (stage: WorkflowStage, context: StageExecutionContext): StageExecutionResult => {
      if (stage === "doc_code_review") {
        if (context.iterationIndex === 1) {
          // 第 1 次审查失败：D1 缺口
          return makeReviewFailResult([makeD1Gap("F-001")]);
        }
        // 第 2 次审查通过
        return makeReviewPassResult();
      }
      return makeSuccessResult(stage, `${stage} 完成 (iter ${context.iterationIndex})`);
    };

    const controller = new WorkflowLoopController({
      projectRoot: dir,
      stageExecutor: executor,
      maxIterations: 3,
    });

    const result = controller.run();

    // 断言：最终成功
    assert.equal(result.overallSuccess, true);
    // 断言：迭代 2 次
    assert.equal(result.totalIterations, 2);

    // 断言：第 1 次迭代审查失败，回退到 development
    assert.equal(result.iterations[0].reviewPassed, false);
    assert.equal(result.iterations[0].rollbackTo, "development");
    // 第 1 次迭代执行了全部 8 个阶段
    assert.equal(result.iterations[0].stages.length, 8);
    // 第 1 次迭代有 1 个缺口（D1）
    assert.equal(result.iterations[0].gaps.length, 1);
    assert.equal(result.iterations[0].gaps[0].dimension, "D1 功能完成度");

    // 断言：第 2 次迭代审查通过
    assert.equal(result.iterations[1].reviewPassed, true);
    // 第 2 次迭代从 development 开始（因 D1 回退到 development）
    assert.equal(result.iterations[1].stages[0].stage, "development");
    // 第 2 次迭代执行了 3 个阶段（development → test_verification → doc_code_review）
    assert.equal(result.iterations[1].stages.length, 3);
    const iter2Stages = result.iterations[1].stages.map((s) => s.stage);
    assert.deepEqual(
      iter2Stages,
      ["development", "test_verification", "doc_code_review"],
      "第 2 次迭代应从 development 执行到 doc_code_review"
    );

    // 断言：最终无缺口
    assert.equal(result.finalGaps.length, 0);
  } finally {
    rmTmpDir(dir);
  }
});

test("WC-022: WorkflowLoopController 达到最大迭代次数仍失败（maxIterations=1）", () => {
  const dir = makeTmpDir();
  try {
    // 构造审查阶段总是失败的执行器（D1 缺口）
    const executor: StageExecutor = (stage: WorkflowStage, _context: StageExecutionContext): StageExecutionResult => {
      if (stage === "doc_code_review") {
        return makeReviewFailResult([makeD1Gap("F-001")]);
      }
      return makeSuccessResult(stage, `${stage} 完成`);
    };

    const controller = new WorkflowLoopController({
      projectRoot: dir,
      stageExecutor: executor,
      maxIterations: 1,
    });

    const result = controller.run();

    // 断言：最终失败
    assert.equal(result.overallSuccess, false);
    // 断言：迭代 1 次（达到 maxIterations=1 后终止）
    assert.equal(result.totalIterations, 1);
    assert.equal(result.maxIterations, 1);
    // 断言：第 1 次迭代审查失败，回退到 development（虽然不再迭代）
    assert.equal(result.iterations[0].reviewPassed, false);
    assert.equal(result.iterations[0].rollbackTo, "development");
    // 断言：最终仍有缺口
    assert.ok(result.finalGaps.length > 0, "最终应仍有缺口");
    assert.equal(result.finalGaps[0].dimension, "D1 功能完成度");
    assert.equal(result.finalGaps[0].feature_id, "F-001");
  } finally {
    rmTmpDir(dir);
  }
});

test("WC-023: WorkflowLoopController 累计上下文跨迭代保留", () => {
  const dir = makeTmpDir();
  try {
    // 记录每次阶段执行接收到的 accumulatedArtifacts
    // 通过真实业务逻辑验证累计上下文跨迭代传递
    const receivedAccumulated: Array<{
      iter: number;
      stage: WorkflowStage;
      artifacts: Record<string, unknown>;
    }> = [];

    const executor: StageExecutor = (stage: WorkflowStage, context: StageExecutionContext): StageExecutionResult => {
      // 真实记录接收到的累计上下文（深拷贝避免引用问题）
      receivedAccumulated.push({
        iter: context.iterationIndex,
        stage,
        artifacts: { ...context.accumulatedArtifacts },
      });

      if (stage === "requirements") {
        // 阶段 1 产出 prd_path 与 prd_version
        return makeSuccessResult(stage, "需求完成", {
          prd_path: "/tmp/prd.md",
          prd_version: "1.0",
        });
      }

      if (stage === "development") {
        // 阶段 6 产出 dev_completed 标记
        return makeSuccessResult(stage, "开发完成", {
          dev_completed: true,
        });
      }

      if (stage === "doc_code_review") {
        if (context.iterationIndex === 1) {
          // 第 1 次审查失败（D1 缺口）
          return makeReviewFailResult([makeD1Gap("F-001")]);
        }
        // 第 2 次审查通过
        return makeReviewPassResult();
      }

      return makeSuccessResult(stage, `${stage} 完成`);
    };

    const controller = new WorkflowLoopController({
      projectRoot: dir,
      stageExecutor: executor,
      maxIterations: 3,
    });

    const result = controller.run();

    // 断言：最终成功，迭代 2 次
    assert.equal(result.overallSuccess, true);
    assert.equal(result.totalIterations, 2);

    // 验证第 1 次迭代 requirements 阶段开始时 accumulatedArtifacts 为空
    const iter1Req = receivedAccumulated.find((r) => r.iter === 1 && r.stage === "requirements");
    assert.ok(iter1Req !== undefined, "应找到第 1 次迭代的 requirements 阶段记录");
    assert.equal(Object.keys(iter1Req.artifacts).length, 0, "iter1 requirements 开始时累计上下文应为空");

    // 验证第 2 次迭代 development 阶段开始时 accumulatedArtifacts 包含第 1 次迭代的产出
    const iter2Dev = receivedAccumulated.find((r) => r.iter === 2 && r.stage === "development");
    assert.ok(iter2Dev !== undefined, "应找到第 2 次迭代的 development 阶段记录");
    assert.equal(
      iter2Dev.artifacts["prd_path"],
      "/tmp/prd.md",
      "iter2 development 应能看到第 1 次 requirements 产出的 prd_path"
    );
    assert.equal(
      iter2Dev.artifacts["prd_version"],
      "1.0",
      "iter2 development 应能看到第 1 次 requirements 产出的 prd_version"
    );

    // 验证最终结果中的 accumulatedArtifacts 包含全部迭代产出
    assert.equal(result.accumulatedArtifacts["prd_path"], "/tmp/prd.md", "最终累计产出应包含 prd_path");
    assert.equal(result.accumulatedArtifacts["prd_version"], "1.0", "最终累计产出应包含 prd_version");
    assert.equal(result.accumulatedArtifacts["dev_completed"], true, "最终累计产出应包含 dev_completed");
  } finally {
    rmTmpDir(dir);
  }
});

test("WC-024: WorkflowLoopController 非审查阶段失败终止当前迭代", () => {
  const dir = makeTmpDir();
  try {
    // 构造 development 阶段失败的执行器
    // 验证：非审查阶段失败时，终止当前迭代（不执行后续阶段）
    const executor: StageExecutor = (stage: WorkflowStage, _context: StageExecutionContext): StageExecutionResult => {
      if (stage === "development") {
        // 阶段 6 失败：编译错误
        return makeFailureResult(stage, "编译错误", "开发阶段失败：编译错误");
      }
      if (stage === "doc_code_review") {
        return makeReviewPassResult();
      }
      return makeSuccessResult(stage, `${stage} 完成`);
    };

    const controller = new WorkflowLoopController({
      projectRoot: dir,
      stageExecutor: executor,
      maxIterations: 1,
    });

    const result = controller.run();

    // 断言：失败（development 失败导致整个迭代失败）
    assert.equal(result.overallSuccess, false);
    // 断言：迭代 1 次
    assert.equal(result.totalIterations, 1);

    // 断言：迭代中执行了前 6 个阶段，最后一个是 development 且失败
    const stages = result.iterations[0].stages;
    assert.equal(stages.length, 6, "应在 development 失败后停止，共执行 6 个阶段");
    assert.equal(stages[5].stage, "development");
    assert.equal(stages[5].success, false);
    assert.equal(stages[5].error, "编译错误");

    // 断言：审查阶段未执行
    const hasReview = stages.some((s) => s.stage === "doc_code_review");
    assert.equal(hasReview, false, "development 失败后不应执行审查阶段");

    // 断言：审查未通过（因为未执行）
    assert.equal(result.iterations[0].reviewPassed, false);
    // 断言：无回退目标（因为审查未执行，未产生缺口）
    assert.equal(result.iterations[0].rollbackTo, null);
  } finally {
    rmTmpDir(dir);
  }
});

// ============================================================================
// WC-025：summarizeWorkflowRunResult 函数测试
// ============================================================================

test("WC-025: summarizeWorkflowRunResult 生成包含关键信息的摘要", () => {
  const dir = makeTmpDir();
  try {
    // 构造总是成功的执行器，生成一份完整的 WorkflowRunResult
    const executor: StageExecutor = (stage: WorkflowStage, _context: StageExecutionContext): StageExecutionResult => {
      if (stage === "doc_code_review") {
        return makeReviewPassResult();
      }
      return makeSuccessResult(stage, `${stage} 完成`);
    };

    const controller = new WorkflowLoopController({
      projectRoot: dir,
      stageExecutor: executor,
      maxIterations: 3,
    });

    const result = controller.run();
    const summary = summarizeWorkflowRunResult(result);

    // 断言：摘要包含关键标题与字段
    assert.ok(summary.includes("八阶段工作流执行结果"), "应包含标题");
    assert.ok(summary.includes("✅ 成功"), "应包含成功标记");
    assert.ok(summary.includes(`迭代次数: 1/3`), "应包含迭代次数");
    assert.ok(summary.includes("剩余缺口: 0 个"), "应包含缺口数");
    assert.ok(summary.includes("迭代历史"), "应包含迭代历史标题");
    assert.ok(summary.includes("迭代 1"), "应包含迭代 1 标识");
    assert.ok(summary.includes("requirements"), "应包含阶段名 requirements");
    assert.ok(summary.includes("doc_code_review"), "应包含阶段名 doc_code_review");
    assert.ok(summary.includes("阶段 1"), "应包含阶段编号 1");
    assert.ok(summary.includes("阶段 8"), "应包含阶段编号 8");

    // 断言：摘要包含项目名（path.basename(dir)）
    assert.ok(summary.includes(path.basename(dir)), "应包含项目名");
  } finally {
    rmTmpDir(dir);
  }
});
