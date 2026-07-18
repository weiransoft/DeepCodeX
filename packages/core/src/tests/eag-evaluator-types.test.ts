/**
 * EAG-P0 单元测试：独立评估器协议（IndependentEvaluator Protocol）
 *
 * 测试范围：
 * - A. 类型与常量：EvaluationMode / RedlineSeverity / EvaluationVerdict
 * - B. RedlineDefinition / RedlineResult / RedlineViolation 接口结构
 * - C. EvaluationContext / EvaluationReport 接口结构
 * - D. decideVerdict() 决策逻辑（PASS / FIX / HUMAN_CHECKPOINT / STOP_FAILURE）
 * - E. buildReport() 报告构建（severity 统计 / fixSuggestions 汇总）
 * - F. IndependentEvaluator 接口契约（最简实现）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实类型实例和真实函数调用
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - EAG 方案 §5.1.3 企业红线清单（BLOCKER/MAJOR/WARNING 三级）
 * - EAG 方案 §5.2.1 五步闭环 Verification 阶段
 * - eag/evaluator/types.ts 源文件（被测对象）
 *
 * @module core/tests/eag-evaluator-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type EvaluationMode,
  type RedlineSeverity,
  type EvaluationVerdict,
  type RedlineDefinition,
  type RedlineResult,
  type RedlineViolation,
  type EvaluationContext,
  type EvaluationReport,
  type IndependentEvaluator,
  decideVerdict,
  buildReport,
} from "../eag/evaluator/types";

// ============================================================================
// 辅助：构造测试数据
// ============================================================================

/**
 * 构造一条 BLOCKER 级红线定义
 *
 * @param id 红线 ID
 * @param name 红线名称
 */
function makeBlockerRedline(id: string, name: string = "BLOCKER 红线"): RedlineDefinition {
  return {
    id,
    name,
    description: `${name}：不可豁免的硬约束`,
    severity: "blocker",
    checkMethod: "静态分析",
    checkType: "static",
    fixGuidance: "请按 BLOCKER 红线要求修复",
  };
}

/**
 * 构造一条 MAJOR 级红线定义
 */
function makeMajorRedline(id: string, name: string = "MAJOR 红线"): RedlineDefinition {
  return {
    id,
    name,
    description: `${name}：可人工豁免的半确定规则`,
    severity: "major",
    checkMethod: "LLM 推理判定",
    checkType: "reasoning",
    fixGuidance: "请按 MAJOR 红线要求修复",
  };
}

/**
 * 构造一条 WARNING 级红线定义
 */
function makeWarningRedline(id: string, name: string = "WARNING 红线"): RedlineDefinition {
  return {
    id,
    name,
    description: `${name}：启发式提示，不打回`,
    severity: "warning",
    checkMethod: "正则扫描",
    checkType: "static",
    fixGuidance: "建议优化",
  };
}

/**
 * 构造一条 passed 状态的判定结果
 */
function makePassedResult(redlineId: string): RedlineResult {
  return {
    redlineId,
    status: "passed",
    violations: [],
  };
}

/**
 * 构造一条 violated 状态的判定结果
 *
 * @param redlineId 红线 ID
 * @param filePath 违规文件路径
 * @param line 违规行号
 * @param description 违规描述
 */
function makeViolatedResult(
  redlineId: string,
  filePath: string = "src/foo.ts",
  line: number = 10,
  description: string = "违反红线"
): RedlineResult {
  return {
    redlineId,
    status: "violated",
    violations: [
      {
        filePath,
        line,
        description,
        fixSuggestion: "请修复此处",
      },
    ],
  };
}

/**
 * 构造一条 unknown 状态的判定结果（推理判定无法确定）
 */
function makeUnknownResult(redlineId: string): RedlineResult {
  return {
    redlineId,
    status: "unknown",
    violations: [],
  };
}

// ============================================================================
// A. 类型与常量测试
// ============================================================================

test("A1. EvaluationMode 包含 strict / standard / off 三种模式", () => {
  const modes: EvaluationMode[] = ["strict", "standard", "off"];
  assert.equal(modes.length, 3);
  assert.ok(modes.includes("strict"));
  assert.ok(modes.includes("standard"));
  assert.ok(modes.includes("off"));
});

test("A2. RedlineSeverity 包含 blocker / major / warning 三级", () => {
  const severities: RedlineSeverity[] = ["blocker", "major", "warning"];
  assert.equal(severities.length, 3);
  assert.ok(severities.includes("blocker"));
  assert.ok(severities.includes("major"));
  assert.ok(severities.includes("warning"));
});

test("A3. EvaluationVerdict 包含 4 种结论", () => {
  const verdicts: EvaluationVerdict[] = ["pass", "fix", "human_checkpoint", "stop_failure"];
  assert.equal(verdicts.length, 4);
  assert.ok(verdicts.includes("pass"));
  assert.ok(verdicts.includes("fix"));
  assert.ok(verdicts.includes("human_checkpoint"));
  assert.ok(verdicts.includes("stop_failure"));
});

// ============================================================================
// B. RedlineDefinition / RedlineResult / RedlineViolation 接口结构测试
// ============================================================================

test("B4. RedlineDefinition 包含全部必需字段", () => {
  const rl = makeBlockerRedline("E1", "事务边界");
  assert.equal(rl.id, "E1");
  assert.equal(rl.name, "事务边界");
  assert.ok(rl.description.length > 0);
  assert.equal(rl.severity, "blocker");
  assert.ok(typeof rl.checkMethod === "string");
  assert.ok(rl.checkType === "static" || rl.checkType === "reasoning");
  assert.ok(typeof rl.fixGuidance === "string");
});

test("B5. RedlineResult 包含 redlineId / status / violations 字段", () => {
  const result = makeViolatedResult("E1");
  assert.equal(result.redlineId, "E1");
  assert.equal(result.status, "violated");
  assert.ok(Array.isArray(result.violations));
  assert.equal(result.violations.length, 1);
});

test("B6. RedlineViolation 包含 filePath / line / description / fixSuggestion 字段", () => {
  const v: RedlineViolation = {
    filePath: "src/bar.ts",
    line: 42,
    description: "硬编码密钥",
    fixSuggestion: "请使用环境变量",
  };
  assert.equal(v.filePath, "src/bar.ts");
  assert.equal(v.line, 42);
  assert.ok(v.description.length > 0);
  assert.ok(v.fixSuggestion.length > 0);
});

test("B7. RedlineViolation 的 line 字段可选", () => {
  // 推理判定场景下无法提供精确行号，line 应可选
  const v: RedlineViolation = {
    filePath: "src/baz.ts",
    description: "整体实现不符合规范",
    fixSuggestion: "请重写该模块",
  };
  assert.equal(v.line, undefined);
});

// ============================================================================
// C. EvaluationContext / EvaluationReport 接口结构测试
// ============================================================================

test("C8. EvaluationContext 包含 loopType / iteration / taskId / artifactPaths", () => {
  const ctx: EvaluationContext = {
    loopType: "coding",
    iteration: 1,
    taskId: "T-001",
    artifactPaths: ["src/foo.ts"],
  };
  assert.equal(ctx.loopType, "coding");
  assert.equal(ctx.iteration, 1);
  assert.equal(ctx.taskId, "T-001");
  assert.ok(Array.isArray(ctx.artifactPaths));
  assert.equal(ctx.artifactPaths.length, 1);
});

test("C9. EvaluationContext.loopType 仅接受 design / coding / testing", () => {
  const loopTypes = ["design", "coding", "testing"] as const;
  for (const lt of loopTypes) {
    const ctx: EvaluationContext = {
      loopType: lt,
      iteration: 1,
      taskId: "T-001",
      artifactPaths: [],
    };
    assert.equal(ctx.loopType, lt);
  }
});

test("C10. EvaluationReport 包含全部必需字段", () => {
  const report: EvaluationReport = {
    verdict: "pass",
    redlineResults: [],
    blockerCount: 0,
    majorCount: 0,
    warningCount: 0,
    durationMs: 100,
  };
  assert.equal(report.verdict, "pass");
  assert.ok(Array.isArray(report.redlineResults));
  assert.equal(report.blockerCount, 0);
  assert.equal(report.majorCount, 0);
  assert.equal(report.warningCount, 0);
  assert.equal(report.durationMs, 100);
  assert.equal(report.notes, undefined);
  assert.equal(report.fixSuggestions, undefined);
});

// ============================================================================
// D. decideVerdict() 决策逻辑测试
// ============================================================================

test("D11. decideVerdict：全部 passed → pass", () => {
  const results: RedlineResult[] = [makePassedResult("E1"), makePassedResult("E2")];
  const verdict = decideVerdict(results, 0);
  assert.equal(verdict, "pass");
});

test("D12. decideVerdict：空结果集 → pass", () => {
  // 无红线判定结果时，视为全部通过
  const verdict = decideVerdict([], 0);
  assert.equal(verdict, "pass");
});

test("D13. decideVerdict：存在 violated → fix", () => {
  const results: RedlineResult[] = [makePassedResult("E1"), makeViolatedResult("E2")];
  const verdict = decideVerdict(results, 0);
  assert.equal(verdict, "fix");
});

test("D14. decideVerdict：存在 unknown → human_checkpoint", () => {
  // 推理判定无法确定且有 BLOCKER/MAJOR 级红线 → 转人工
  const results: RedlineResult[] = [makePassedResult("E1"), makeUnknownResult("E2")];
  const verdict = decideVerdict(results, 0);
  assert.equal(verdict, "human_checkpoint");
});

test("D15. decideVerdict：连续失败达上限 → stop_failure", () => {
  // maxConsecutiveFailures >= failureThreshold（默认 3）→ STOP_FAILURE
  const results: RedlineResult[] = [makePassedResult("E1")];
  const verdict = decideVerdict(results, 3);
  assert.equal(verdict, "stop_failure");
});

test("D16. decideVerdict：连续失败未达上限时不触发 stop_failure", () => {
  const results: RedlineResult[] = [makePassedResult("E1")];
  // maxConsecutiveFailures=2 < failureThreshold=3
  const verdict = decideVerdict(results, 2);
  assert.equal(verdict, "pass");
});

test("D17. decideVerdict：自定义 failureThreshold 生效", () => {
  const results: RedlineResult[] = [makePassedResult("E1")];
  // maxConsecutiveFailures=5, failureThreshold=5 → STOP_FAILURE
  const verdict = decideVerdict(results, 5, 5);
  assert.equal(verdict, "stop_failure");
});

test("D18. decideVerdict：stop_failure 优先级高于 fix", () => {
  // 同时存在 violated 和连续失败达上限 → STOP_FAILURE 优先
  const results: RedlineResult[] = [makeViolatedResult("E1")];
  const verdict = decideVerdict(results, 3);
  assert.equal(verdict, "stop_failure");
});

// ============================================================================
// E. buildReport() 报告构建测试
// ============================================================================

test("E19. buildReport：正确统计 blocker/major/warning 违规数", () => {
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1"), makeMajorRedline("E2"), makeWarningRedline("E3")];
  const results: RedlineResult[] = [makeViolatedResult("E1"), makeViolatedResult("E2"), makeViolatedResult("E3")];
  const report = buildReport(results, redlines, 100, 0);
  assert.equal(report.blockerCount, 1);
  assert.equal(report.majorCount, 1);
  assert.equal(report.warningCount, 1);
});

test("E20. buildReport：多条违规在同一红线内累计计数", () => {
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1")];
  const results: RedlineResult[] = [
    {
      redlineId: "E1",
      status: "violated",
      violations: [
        { filePath: "a.ts", line: 1, description: "v1", fixSuggestion: "f1" },
        { filePath: "b.ts", line: 2, description: "v2", fixSuggestion: "f2" },
        { filePath: "c.ts", line: 3, description: "v3", fixSuggestion: "f3" },
      ],
    },
  ];
  const report = buildReport(results, redlines, 50, 0);
  assert.equal(report.blockerCount, 3);
});

test("E21. buildReport：passed 结果不计入违规数", () => {
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1"), makeMajorRedline("E2")];
  const results: RedlineResult[] = [makePassedResult("E1"), makePassedResult("E2")];
  const report = buildReport(results, redlines, 30, 0);
  assert.equal(report.blockerCount, 0);
  assert.equal(report.majorCount, 0);
  assert.equal(report.warningCount, 0);
  assert.equal(report.verdict, "pass");
});

test("E22. buildReport：verdict 与 decideVerdict 一致", () => {
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1")];
  const results: RedlineResult[] = [makeViolatedResult("E1")];
  const report = buildReport(results, redlines, 80, 0);
  // 存在 BLOCKER 违规 → fix
  assert.equal(report.verdict, "fix");
  assert.equal(report.verdict, decideVerdict(results, 0));
});

test("E23. buildReport：fixSuggestions 仅包含 blocker/major 违规（不含 warning）", () => {
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1"), makeMajorRedline("E2"), makeWarningRedline("E3")];
  const results: RedlineResult[] = [
    makeViolatedResult("E1", "a.ts", 1, "BLOCKER 违规"),
    makeViolatedResult("E2", "b.ts", 2, "MAJOR 违规"),
    makeViolatedResult("E3", "c.ts", 3, "WARNING 违规"),
  ];
  const report = buildReport(results, redlines, 60, 0);
  assert.ok(report.fixSuggestions);
  assert.ok(report.fixSuggestions!.length >= 2);
  // 应包含 BLOCKER 和 MAJOR 违规，不含 WARNING
  const joined = report.fixSuggestions!.join("\n");
  assert.match(joined, /BLOCKER/i);
  assert.match(joined, /MAJOR/i);
  assert.doesNotMatch(joined, /WARNING/i);
});

test("E24. buildReport：无违规时 fixSuggestions 为 undefined", () => {
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1")];
  const results: RedlineResult[] = [makePassedResult("E1")];
  const report = buildReport(results, redlines, 20, 0);
  assert.equal(report.fixSuggestions, undefined);
});

test("E25. buildReport：notes 字段透传", () => {
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1")];
  const results: RedlineResult[] = [makePassedResult("E1")];
  const notes = "LLM judge 推理摘要：代码符合规范";
  const report = buildReport(results, redlines, 40, 0, notes);
  assert.equal(report.notes, notes);
});

test("E26. buildReport：durationMs 字段透传", () => {
  const redlines: RedlineDefinition[] = [];
  const results: RedlineResult[] = [];
  const report = buildReport(results, redlines, 1234, 0);
  assert.equal(report.durationMs, 1234);
});

// ============================================================================
// F. IndependentEvaluator 接口契约测试
// ============================================================================

test("F27. IndependentEvaluator 接口可被实现（最简实现）", async () => {
  // 构造一个最简的真实评估器实现（非 mock，真实业务逻辑）
  const evaluator: IndependentEvaluator = {
    async evaluate(context: EvaluationContext, redlines: ReadonlyArray<RedlineDefinition>): Promise<EvaluationReport> {
      // 真实业务逻辑：对所有红线返回 passed
      const results: RedlineResult[] = redlines.map((rl) => ({
        redlineId: rl.id,
        status: "passed" as const,
        violations: [],
      }));
      return buildReport(results, redlines, 10, 0);
    },
    getName(): string {
      return "TestEvaluator";
    },
    getDefaultMode(): EvaluationMode {
      return "strict";
    },
  };

  assert.equal(evaluator.getName(), "TestEvaluator");
  assert.equal(evaluator.getDefaultMode(), "strict");

  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1")];
  const ctx: EvaluationContext = {
    loopType: "coding",
    iteration: 1,
    taskId: "T-001",
    artifactPaths: [],
  };
  const report = await evaluator.evaluate(ctx, redlines);
  assert.equal(report.verdict, "pass");
  assert.equal(report.redlineResults.length, 1);
  assert.equal(report.redlineResults[0].status, "passed");
});

test("F28. IndependentEvaluator.evaluate 返回符合 EvaluationReport 结构", async () => {
  // 验证评估器返回值结构完整性
  const evaluator: IndependentEvaluator = {
    async evaluate(_context: EvaluationContext, redlines: ReadonlyArray<RedlineDefinition>): Promise<EvaluationReport> {
      // 真实业务逻辑：所有红线 violated
      const results: RedlineResult[] = redlines.map((rl) => ({
        redlineId: rl.id,
        status: "violated" as const,
        violations: [
          {
            filePath: "src/test.ts",
            line: 1,
            description: "违规",
            fixSuggestion: "修复",
          },
        ],
      }));
      return buildReport(results, redlines, 5, 0, "测试备注");
    },
    getName() {
      return "ViolatingEvaluator";
    },
    getDefaultMode() {
      return "standard";
    },
  };

  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1"), makeMajorRedline("E2")];
  const ctx: EvaluationContext = {
    loopType: "design",
    iteration: 2,
    taskId: "T-002",
    artifactPaths: ["src/test.ts"],
    inlineArtifacts: [{ path: "src/test.ts", content: "const x = 1;" }],
    mode: "standard",
  };
  const report = await evaluator.evaluate(ctx, redlines);

  // 验证 EvaluationReport 全部字段
  assert.ok(typeof report.verdict === "string");
  assert.ok(Array.isArray(report.redlineResults));
  assert.equal(typeof report.blockerCount, "number");
  assert.equal(typeof report.majorCount, "number");
  assert.equal(typeof report.warningCount, "number");
  assert.equal(typeof report.durationMs, "number");
  assert.equal(report.notes, "测试备注");
  assert.ok(Array.isArray(report.fixSuggestions));
  assert.equal(report.blockerCount, 1);
  assert.equal(report.majorCount, 1);
  assert.equal(report.verdict, "fix");
});
