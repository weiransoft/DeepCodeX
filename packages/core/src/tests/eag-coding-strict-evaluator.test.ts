/**
 * EAG-P2 批次 9 S3 单元测试：STRICT 评估器（StrictEvaluator）
 *
 * 测试范围：
 * - T1. StrictEvaluator 实例化与协议
 *   - T1a. 默认构造（DEFAULT_STATIC_CHECKERS）→ 实例化成功
 *   - T1b. 自定义 staticCheckers → 实例化成功
 *   - T1c. 实现 IndependentEvaluator 协议（evaluate / getName / getDefaultMode）
 *   - T1d. getName 返回 "StrictEvaluator"
 *   - T1e. getDefaultMode 返回 "strict"
 * - T2. evaluate 成功路径
 *   - T2a. 返回 EvaluationReport 含全部字段
 *   - T2b. redlineResults 数量与输入 redlines 一致
 *   - T2c. durationMs >= 0
 *   - T2d. notes 含评估统计
 * - T3. 红线路由
 *   - T3a. 已注册 Checker → 调用 check 返回 passed
 *   - T3b. 已注册 Checker → 调用 check 返回 violated
 *   - T3c. 未注册 Checker → 返回 unknown
 *   - T3d. checkType="static" 未注册 → 返回 unknown
 *   - T3e. checkType="reasoning" 未注册 → 返回 unknown
 * - T4. StaticChecker 异常处理
 *   - T4a. check 抛错 → 返回 unknown（含异常信息）
 *   - T4b. 单个 Checker 异常不影响其他红线判定
 * - T5. buildReport 集成
 *   - T5a. 全部通过 → verdict=pass
 *   - T5b. 有 BLOCKER 违规 → verdict=fix
 *   - T5c. 有 MAJOR 违规 → verdict=fix
 *   - T5d. 全部 unknown → verdict=human_checkpoint
 *   - T5e. blockerCount / majorCount / warningCount 统计正确
 * - T6. 便捷 API
 *   - T6a. getStaticCheckerCount 返回已注册数量
 *   - T6b. hasStaticChecker 返回 true/false
 * - T7. 错误处理
 *   - T7a. context.loopType 为空 → invalid-context
 *   - T7b. context.taskId 为空 → invalid-context
 *   - T7c. artifactPaths 与 inlineArtifacts 均为空 → invalid-context
 *   - T7d. redlines 为空数组 → redlines-empty
 *   - T7e. redlines 非数组 → redlines-empty
 * - T8. 默认 staticCheckers（DEFAULT_STATIC_CHECKERS）行为
 *   - T8a. 默认注册 E1~E8 + TCS-* 共 21 条 redlineId 映射
 *   - T8b. 默认 getStaticCheckerCount === 21
 *   - T8c. 默认 hasStaticChecker("E1") === true
 *   - T8d. 默认 hasStaticChecker("NON-EXISTENT") === false
 * - T9. 产出物收集
 *   - T9a. inlineArtifacts 优先使用
 *   - T9b. artifactPaths 中未内联路径记录到 notes
 *   - T9c. 同时有 inlineArtifacts 与 artifactPaths 时合并
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象（真实 StaticChecker / 真实 RedlineDefinition / 真实 DEFAULT_STATIC_CHECKERS）
 *
 * @module core/tests/eag-coding-strict-evaluator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { StrictEvaluator, StrictEvaluatorError } from "../eag/coding/strict-evaluator";
import type { StaticChecker } from "../eag/coding/types";
import { DEFAULT_STATIC_CHECKERS } from "../eag/coding/static-checkers";
import type {
  EvaluationContext,
  EvaluationReport,
  EvaluationMode,
  IndependentEvaluator,
  RedlineDefinition,
  RedlineResult,
  RedlineViolation,
} from "../eag/evaluator/types";

// ============================================================================
// 辅助函数：构造 RedlineDefinition
// ============================================================================

/**
 * 构造测试用 RedlineDefinition
 *
 * @param overrides 覆盖字段
 * @returns 完整的 RedlineDefinition
 */
function createRedline(overrides: Partial<RedlineDefinition> = {}): RedlineDefinition {
  return {
    id: "TEST-01",
    name: "测试红线",
    description: "测试用红线",
    severity: "blocker",
    checkMethod: "静态扫描",
    checkType: "static",
    fixGuidance: "修复建议",
    ...overrides,
  };
}

// ============================================================================
// 辅助函数：构造 EvaluationContext
// ============================================================================

/**
 * 构造测试用 EvaluationContext
 *
 * @param overrides 覆盖字段
 * @returns 完整的 EvaluationContext
 */
function createContext(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    loopType: "coding",
    iteration: 1,
    taskId: "T-001",
    artifactPaths: ["src/test.ts"],
    inlineArtifacts: [
      {
        path: "src/test.ts",
        content: "export class TestClass {}",
      },
    ],
    ...overrides,
  };
}

// ============================================================================
// 真实实现：自定义 StaticChecker（非 mock）
// ============================================================================

/**
 * 自定义 StaticChecker —— 始终通过（真实实现，非 mock）
 *
 * 内部维护 redlineIds 列表，check 方法返回 passed 状态。
 */
class AlwaysPassChecker implements StaticChecker {
  readonly redlineIds: ReadonlyArray<string>;
  constructor(redlineIds: ReadonlyArray<string>) {
    this.redlineIds = Object.freeze([...redlineIds]);
  }
  check(
    artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
    redline: Readonly<RedlineDefinition>
  ): RedlineResult {
    return {
      redlineId: redline.id,
      status: "passed",
      violations: [],
      evidence: `AlwaysPassChecker: 扫描 ${artifacts.length} 个产出物，全部通过`,
    };
  }
}

/**
 * 自定义 StaticChecker —— 始终违规（真实实现，非 mock）
 *
 * 内部维护 redlineIds 列表与违规描述，check 方法返回 violated 状态。
 */
class AlwaysViolatedChecker implements StaticChecker {
  readonly redlineIds: ReadonlyArray<string>;
  private readonly violationDescription: string;
  constructor(redlineIds: ReadonlyArray<string>, violationDescription: string = "测试违规") {
    this.redlineIds = Object.freeze([...redlineIds]);
    this.violationDescription = violationDescription;
  }
  check(
    artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
    redline: Readonly<RedlineDefinition>
  ): RedlineResult {
    const violations: RedlineViolation[] = artifacts.map((a) => ({
      filePath: a.path,
      line: 1,
      description: this.violationDescription,
      fixSuggestion: redline.fixGuidance ?? "请参考红线修复建议",
    }));
    return {
      redlineId: redline.id,
      status: "violated",
      violations,
      evidence: `AlwaysViolatedChecker: 在 ${artifacts.length} 个产出物中检测到违规`,
    };
  }
}

/**
 * 自定义 StaticChecker —— 始终抛错（真实实现，非 mock）
 *
 * 用于测试评估器对 Checker 异常的容错处理。
 */
class AlwaysThrowChecker implements StaticChecker {
  readonly redlineIds: ReadonlyArray<string>;
  private readonly errorMsg: string;
  constructor(redlineIds: ReadonlyArray<string>, errorMsg: string = "Checker 内部异常") {
    this.redlineIds = Object.freeze([...redlineIds]);
    this.errorMsg = errorMsg;
  }
  check(
    _artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
    redline: Readonly<RedlineDefinition>
  ): RedlineResult {
    throw new Error(`${this.errorMsg} (redlineId=${redline.id})`);
  }
}

// ============================================================================
// T1. StrictEvaluator 实例化与协议
// ============================================================================

test("T1a. 默认构造（DEFAULT_STATIC_CHECKERS）→ 实例化成功", () => {
  const evaluator = new StrictEvaluator();
  assert.ok(evaluator instanceof StrictEvaluator);
});

test("T1b. 自定义 staticCheckers → 实例化成功", () => {
  const customCheckers = new Map<string, StaticChecker>([["CUSTOM-01", new AlwaysPassChecker(["CUSTOM-01"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  assert.ok(evaluator instanceof StrictEvaluator);
  assert.equal(evaluator.getStaticCheckerCount(), 1);
});

test("T1c. 实现 IndependentEvaluator 协议（evaluate / getName / getDefaultMode）", () => {
  const evaluator = new StrictEvaluator();
  // IndependentEvaluator 协议方法都存在
  const asEvaluator: IndependentEvaluator = evaluator;
  assert.equal(typeof asEvaluator.evaluate, "function");
  assert.equal(typeof asEvaluator.getName, "function");
  assert.equal(typeof asEvaluator.getDefaultMode, "function");
});

test("T1d. getName 返回 StrictEvaluator", () => {
  const evaluator = new StrictEvaluator();
  assert.equal(evaluator.getName(), "StrictEvaluator");
});

test("T1e. getDefaultMode 返回 strict", () => {
  const evaluator = new StrictEvaluator();
  const mode: EvaluationMode = evaluator.getDefaultMode();
  assert.equal(mode, "strict");
});

// ============================================================================
// T2. evaluate 成功路径
// ============================================================================

test("T2a. 返回 EvaluationReport 含全部字段", async () => {
  const customCheckers = new Map<string, StaticChecker>([["TEST-01", new AlwaysPassChecker(["TEST-01"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  const report = await evaluator.evaluate(createContext(), [createRedline()]);
  // 验证 EvaluationReport 含全部字段
  assert.ok(typeof report.verdict === "string");
  assert.ok(Array.isArray(report.redlineResults));
  assert.ok(typeof report.blockerCount === "number");
  assert.ok(typeof report.majorCount === "number");
  assert.ok(typeof report.warningCount === "number");
  assert.ok(typeof report.durationMs === "number");
  assert.ok(typeof report.notes === "string");
});

test("T2b. redlineResults 数量与输入 redlines 一致", async () => {
  const customCheckers = new Map<string, StaticChecker>([
    ["TEST-01", new AlwaysPassChecker(["TEST-01"])],
    ["TEST-02", new AlwaysPassChecker(["TEST-02"])],
    ["TEST-03", new AlwaysPassChecker(["TEST-03"])],
  ]);
  const evaluator = new StrictEvaluator(customCheckers);
  const redlines = [
    createRedline({ id: "TEST-01" }),
    createRedline({ id: "TEST-02" }),
    createRedline({ id: "TEST-03" }),
  ];
  const report = await evaluator.evaluate(createContext(), redlines);
  assert.equal(report.redlineResults.length, 3);
});

test("T2c. durationMs >= 0", async () => {
  const evaluator = new StrictEvaluator();
  const report = await evaluator.evaluate(createContext(), [createRedline({ id: "TEST-UNKNOWN" })]);
  assert.ok(report.durationMs >= 0);
});

test("T2d. notes 含评估统计", async () => {
  const customCheckers = new Map<string, StaticChecker>([["TEST-01", new AlwaysPassChecker(["TEST-01"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  const report = await evaluator.evaluate(createContext(), [createRedline()]);
  assert.ok(report.notes!.includes("评估统计"));
  assert.ok(report.notes!.includes("红线"));
  assert.ok(report.notes!.includes("产出物"));
  assert.ok(report.notes!.includes("通过"));
});

// ============================================================================
// T3. 红线路由
// ============================================================================

test("T3a. 已注册 Checker → 调用 check 返回 passed", async () => {
  const customCheckers = new Map<string, StaticChecker>([["TEST-01", new AlwaysPassChecker(["TEST-01"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  const redlines = [createRedline({ id: "TEST-01" })];
  const report = await evaluator.evaluate(createContext(), redlines);
  assert.equal(report.redlineResults[0].status, "passed");
  assert.equal(report.redlineResults[0].violations.length, 0);
});

test("T3b. 已注册 Checker → 调用 check 返回 violated", async () => {
  const customCheckers = new Map<string, StaticChecker>([
    ["TEST-01", new AlwaysViolatedChecker(["TEST-01"], "测试违规描述")],
  ]);
  const evaluator = new StrictEvaluator(customCheckers);
  const redlines = [createRedline({ id: "TEST-01", severity: "blocker" })];
  const report = await evaluator.evaluate(createContext(), redlines);
  assert.equal(report.redlineResults[0].status, "violated");
  assert.ok(report.redlineResults[0].violations.length > 0);
  assert.equal(report.redlineResults[0].violations[0].description, "测试违规描述");
});

test("T3c. 未注册 Checker → 返回 unknown", async () => {
  const evaluator = new StrictEvaluator(new Map<string, StaticChecker>());
  const redlines = [createRedline({ id: "UNREGISTERED-01" })];
  const report = await evaluator.evaluate(createContext(), redlines);
  assert.equal(report.redlineResults[0].status, "unknown");
  assert.equal(report.redlineResults[0].violations.length, 0);
  // evidence 应记录未注册原因
  assert.ok(report.redlineResults[0].evidence!.includes("UNREGISTERED-01"));
});

test("T3d. checkType=static 未注册 → 返回 unknown", async () => {
  const evaluator = new StrictEvaluator(new Map<string, StaticChecker>());
  const redlines = [createRedline({ id: "STATIC-01", checkType: "static" })];
  const report = await evaluator.evaluate(createContext(), redlines);
  assert.equal(report.redlineResults[0].status, "unknown");
  assert.ok(report.redlineResults[0].evidence!.includes("static"));
});

test("T3e. checkType=reasoning 未注册 → 返回 unknown", async () => {
  const evaluator = new StrictEvaluator(new Map<string, StaticChecker>());
  const redlines = [createRedline({ id: "REASONING-01", checkType: "reasoning" })];
  const report = await evaluator.evaluate(createContext(), redlines);
  assert.equal(report.redlineResults[0].status, "unknown");
  assert.ok(report.redlineResults[0].evidence!.includes("reasoning"));
});

// ============================================================================
// T4. StaticChecker 异常处理
// ============================================================================

test("T4a. check 抛错 → 返回 unknown（含异常信息）", async () => {
  const customCheckers = new Map<string, StaticChecker>([
    ["TEST-01", new AlwaysThrowChecker(["TEST-01"], "Checker 内部异常测试")],
  ]);
  const evaluator = new StrictEvaluator(customCheckers);
  const redlines = [createRedline({ id: "TEST-01" })];
  const report = await evaluator.evaluate(createContext(), redlines);
  assert.equal(report.redlineResults[0].status, "unknown");
  assert.ok(report.redlineResults[0].evidence!.includes("Checker 内部异常测试"));
  assert.ok(report.redlineResults[0].evidence!.includes("StaticChecker.check"));
});

test("T4b. 单个 Checker 异常不影响其他红线判定", async () => {
  const customCheckers = new Map<string, StaticChecker>([
    ["THROW-01", new AlwaysThrowChecker(["THROW-01"], "异常 1")],
    ["PASS-02", new AlwaysPassChecker(["PASS-02"])],
    ["VIOLATED-03", new AlwaysViolatedChecker(["VIOLATED-03"], "违规 3")],
  ]);
  const evaluator = new StrictEvaluator(customCheckers);
  const redlines = [
    createRedline({ id: "THROW-01", severity: "blocker" }),
    createRedline({ id: "PASS-02", severity: "blocker" }),
    createRedline({ id: "VIOLATED-03", severity: "major" }),
  ];
  const report = await evaluator.evaluate(createContext(), redlines);
  // 三条红线都应被处理
  assert.equal(report.redlineResults.length, 3);
  // 异常 Checker 返回 unknown
  const throwResult = report.redlineResults.find((r) => r.redlineId === "THROW-01");
  assert.equal(throwResult?.status, "unknown");
  // 正常 Checker 返回 passed
  const passResult = report.redlineResults.find((r) => r.redlineId === "PASS-02");
  assert.equal(passResult?.status, "passed");
  // 违规 Checker 返回 violated
  const violatedResult = report.redlineResults.find((r) => r.redlineId === "VIOLATED-03");
  assert.equal(violatedResult?.status, "violated");
});

// ============================================================================
// T5. buildReport 集成
// ============================================================================

test("T5a. 全部通过 → verdict=pass", async () => {
  const customCheckers = new Map<string, StaticChecker>([
    ["TEST-01", new AlwaysPassChecker(["TEST-01"])],
    ["TEST-02", new AlwaysPassChecker(["TEST-02"])],
  ]);
  const evaluator = new StrictEvaluator(customCheckers);
  const redlines = [
    createRedline({ id: "TEST-01", severity: "blocker" }),
    createRedline({ id: "TEST-02", severity: "major" }),
  ];
  const report = await evaluator.evaluate(createContext(), redlines);
  assert.equal(report.verdict, "pass");
  assert.equal(report.blockerCount, 0);
  assert.equal(report.majorCount, 0);
  assert.equal(report.warningCount, 0);
});

test("T5b. 有 BLOCKER 违规 → verdict=fix", async () => {
  const customCheckers = new Map<string, StaticChecker>([
    ["TEST-01", new AlwaysViolatedChecker(["TEST-01"], "BLOCKER 违规")],
  ]);
  const evaluator = new StrictEvaluator(customCheckers);
  const redlines = [createRedline({ id: "TEST-01", severity: "blocker" })];
  const report = await evaluator.evaluate(createContext(), redlines);
  assert.equal(report.verdict, "fix");
  assert.ok(report.blockerCount > 0);
  // 应含修复建议
  assert.ok(report.fixSuggestions !== undefined);
  assert.ok(report.fixSuggestions!.length > 0);
});

test("T5c. 有 MAJOR 违规 → verdict=fix", async () => {
  const customCheckers = new Map<string, StaticChecker>([
    ["TEST-01", new AlwaysViolatedChecker(["TEST-01"], "MAJOR 违规")],
  ]);
  const evaluator = new StrictEvaluator(customCheckers);
  const redlines = [createRedline({ id: "TEST-01", severity: "major" })];
  const report = await evaluator.evaluate(createContext(), redlines);
  assert.equal(report.verdict, "fix");
  assert.ok(report.majorCount > 0);
});

test("T5d. 全部 unknown → verdict=human_checkpoint", async () => {
  const evaluator = new StrictEvaluator(new Map<string, StaticChecker>());
  const redlines = [
    createRedline({ id: "UNKNOWN-01", severity: "blocker" }),
    createRedline({ id: "UNKNOWN-02", severity: "major" }),
  ];
  const report = await evaluator.evaluate(createContext(), redlines);
  // 全部 unknown 时 verdict=human_checkpoint
  assert.equal(report.verdict, "human_checkpoint");
  assert.equal(report.blockerCount, 0);
  assert.equal(report.majorCount, 0);
});

test("T5e. blockerCount / majorCount / warningCount 统计正确", async () => {
  const customCheckers = new Map<string, StaticChecker>([
    ["BLOCKER-01", new AlwaysViolatedChecker(["BLOCKER-01"], "blocker 违规")],
    ["MAJOR-01", new AlwaysViolatedChecker(["MAJOR-01"], "major 违规")],
    ["WARNING-01", new AlwaysViolatedChecker(["WARNING-01"], "warning 违规")],
    ["PASS-01", new AlwaysPassChecker(["PASS-01"])],
  ]);
  const evaluator = new StrictEvaluator(customCheckers);
  const redlines = [
    createRedline({ id: "BLOCKER-01", severity: "blocker" }),
    createRedline({ id: "MAJOR-01", severity: "major" }),
    createRedline({ id: "WARNING-01", severity: "warning" }),
    createRedline({ id: "PASS-01", severity: "blocker" }),
  ];
  const report = await evaluator.evaluate(createContext(), redlines);
  // 1 个 BLOCKER 违规（含 1 个产出物的 1 个 violation）
  assert.equal(report.blockerCount, 1);
  // 1 个 MAJOR 违规
  assert.equal(report.majorCount, 1);
  // 1 个 WARNING 违规
  assert.equal(report.warningCount, 1);
});

// ============================================================================
// T6. 便捷 API
// ============================================================================

test("T6a. getStaticCheckerCount 返回已注册数量", () => {
  const customCheckers = new Map<string, StaticChecker>([
    ["TEST-01", new AlwaysPassChecker(["TEST-01"])],
    ["TEST-02", new AlwaysPassChecker(["TEST-02"])],
    ["TEST-03", new AlwaysPassChecker(["TEST-03"])],
  ]);
  const evaluator = new StrictEvaluator(customCheckers);
  assert.equal(evaluator.getStaticCheckerCount(), 3);
});

test("T6b. hasStaticChecker 返回 true/false", () => {
  const customCheckers = new Map<string, StaticChecker>([["TEST-01", new AlwaysPassChecker(["TEST-01"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  assert.equal(evaluator.hasStaticChecker("TEST-01"), true);
  assert.equal(evaluator.hasStaticChecker("NON-EXISTENT"), false);
});

// ============================================================================
// T7. 错误处理
// ============================================================================

test("T7a. context.loopType 为空 → invalid-context", async () => {
  const evaluator = new StrictEvaluator();
  const badContext = createContext({ loopType: "" as EvaluationContext["loopType"] });
  await assert.rejects(
    () => evaluator.evaluate(badContext, [createRedline()]),
    (err: unknown) => {
      assert.ok(err instanceof StrictEvaluatorError);
      assert.equal((err as StrictEvaluatorError).kind, "invalid-context");
      assert.ok((err as StrictEvaluatorError).detail.includes("loopType"));
      return true;
    }
  );
});

test("T7b. context.taskId 为空 → invalid-context", async () => {
  const evaluator = new StrictEvaluator();
  const badContext = createContext({ taskId: "" });
  await assert.rejects(
    () => evaluator.evaluate(badContext, [createRedline()]),
    (err: unknown) => {
      assert.ok(err instanceof StrictEvaluatorError);
      assert.equal((err as StrictEvaluatorError).kind, "invalid-context");
      assert.ok((err as StrictEvaluatorError).detail.includes("taskId"));
      return true;
    }
  );
});

test("T7c. artifactPaths 与 inlineArtifacts 均为空 → invalid-context", async () => {
  const evaluator = new StrictEvaluator();
  const badContext = createContext({
    artifactPaths: [],
    inlineArtifacts: [],
  });
  await assert.rejects(
    () => evaluator.evaluate(badContext, [createRedline()]),
    (err: unknown) => {
      assert.ok(err instanceof StrictEvaluatorError);
      assert.equal((err as StrictEvaluatorError).kind, "invalid-context");
      assert.ok((err as StrictEvaluatorError).detail.includes("artifactPaths"));
      return true;
    }
  );
});

test("T7d. redlines 为空数组 → redlines-empty", async () => {
  const evaluator = new StrictEvaluator();
  await assert.rejects(
    () => evaluator.evaluate(createContext(), []),
    (err: unknown) => {
      assert.ok(err instanceof StrictEvaluatorError);
      assert.equal((err as StrictEvaluatorError).kind, "redlines-empty");
      return true;
    }
  );
});

test("T7e. redlines 非数组 → redlines-empty", async () => {
  const evaluator = new StrictEvaluator();
  // 传入非数组（null 强制类型转换）测试运行时校验
  await assert.rejects(
    () => evaluator.evaluate(createContext(), null as unknown as ReadonlyArray<RedlineDefinition>),
    (err: unknown) => {
      assert.ok(err instanceof StrictEvaluatorError);
      assert.equal((err as StrictEvaluatorError).kind, "redlines-empty");
      return true;
    }
  );
});

// ============================================================================
// T8. 默认 staticCheckers（DEFAULT_STATIC_CHECKERS）行为
// ============================================================================

test("T8a. 默认注册 E1~E8 + TCS-* 共 21 条 redlineId 映射", () => {
  const evaluator = new StrictEvaluator();
  // DEFAULT_STATIC_CHECKERS 含 21 条映射（8 个 E1~E8 + 13 个 TCS-*）
  // 实际数量：8 (E1~E8) + 13 (TCS-OSS-01/02/03, TCS-SEC-01, TCS-SEC-02,
  //                  TCS-CACHE-01/02/03, TCS-SQL-01/02/03, TCS-LDAP-01/02)
  // 批次 12 C1 补全：TCS-OSS-02/03 之前未注册（导致 StrictEvaluator 返回 unknown → human_checkpoint），
  // 现已补全注册到 OssPatternChecker，总数从 19 扩展为 21
  assert.equal(evaluator.getStaticCheckerCount(), 21);
  // 验证 E1~E8 全部注册
  for (let i = 1; i <= 8; i++) {
    assert.equal(evaluator.hasStaticChecker(`E${i}`), true, `E${i} 应已注册`);
  }
  // 验证 TCS-* 全部注册（13 条，含批次 12 新增的 TCS-OSS-02/03）
  const tcsIds = [
    "TCS-OSS-01",
    "TCS-OSS-02",
    "TCS-OSS-03",
    "TCS-SEC-01",
    "TCS-SEC-02",
    "TCS-CACHE-01",
    "TCS-CACHE-02",
    "TCS-CACHE-03",
    "TCS-SQL-01",
    "TCS-SQL-02",
    "TCS-SQL-03",
    "TCS-LDAP-01",
    "TCS-LDAP-02",
  ];
  for (const id of tcsIds) {
    assert.equal(evaluator.hasStaticChecker(id), true, `${id} 应已注册`);
  }
});

test("T8b. 默认 getStaticCheckerCount === 21", () => {
  const evaluator = new StrictEvaluator();
  // 批次 12 C1 补全 TCS-OSS-02/03 后，总数从 19 扩展为 21
  assert.equal(evaluator.getStaticCheckerCount(), 21);
});

test("T8c. 默认 hasStaticChecker(E1) === true", () => {
  const evaluator = new StrictEvaluator();
  assert.equal(evaluator.hasStaticChecker("E1"), true);
  assert.equal(evaluator.hasStaticChecker("E2"), true);
  assert.equal(evaluator.hasStaticChecker("E3"), true);
  assert.equal(evaluator.hasStaticChecker("E4"), true);
  assert.equal(evaluator.hasStaticChecker("E5"), true);
  assert.equal(evaluator.hasStaticChecker("E6"), true);
  assert.equal(evaluator.hasStaticChecker("E7"), true);
  assert.equal(evaluator.hasStaticChecker("E8"), true);
});

test("T8d. 默认 hasStaticChecker(NON-EXISTENT) === false", () => {
  const evaluator = new StrictEvaluator();
  assert.equal(evaluator.hasStaticChecker("NON-EXISTENT"), false);
  assert.equal(evaluator.hasStaticChecker("E9"), false);
  assert.equal(evaluator.hasStaticChecker("TCS-UNKNOWN-01"), false);
});

// ============================================================================
// T9. 产出物收集
// ============================================================================

test("T9a. inlineArtifacts 优先使用", async () => {
  const customCheckers = new Map<string, StaticChecker>([["TEST-01", new AlwaysPassChecker(["TEST-01"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  // 仅含 inlineArtifacts（无 artifactPaths）
  const context = createContext({
    artifactPaths: [],
    inlineArtifacts: [{ path: "src/inline.ts", content: "// inline content" }],
  });
  const report = await evaluator.evaluate(context, [createRedline({ id: "TEST-01" })]);
  // notes 应含统计信息（1 个产出物）
  assert.ok(report.notes!.includes("产出物 1"));
});

test("T9b. artifactPaths 中未内联路径记录到 notes", async () => {
  const customCheckers = new Map<string, StaticChecker>([["TEST-01", new AlwaysPassChecker(["TEST-01"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  // artifactPaths 含 2 个路径，仅 1 个内联到 inlineArtifacts
  const context = createContext({
    artifactPaths: ["src/inline.ts", "src/not-inlined.ts"],
    inlineArtifacts: [{ path: "src/inline.ts", content: "// inline content" }],
  });
  const report = await evaluator.evaluate(context, [createRedline({ id: "TEST-01" })]);
  // notes 应含未内联路径
  assert.ok(report.notes!.includes("未内联产出物路径"));
  assert.ok(report.notes!.includes("src/not-inlined.ts"));
});

test("T9c. 同时有 inlineArtifacts 与 artifactPaths 时合并", async () => {
  const customCheckers = new Map<string, StaticChecker>([["TEST-01", new AlwaysPassChecker(["TEST-01"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  // artifactPaths 与 inlineArtifacts 完全重叠（应视为同一产出物，不重复计入）
  const context = createContext({
    artifactPaths: ["src/test.ts"],
    inlineArtifacts: [{ path: "src/test.ts", content: "// content" }],
  });
  const report = await evaluator.evaluate(context, [createRedline({ id: "TEST-01" })]);
  // notes 应含统计信息（1 个产出物，0 个未内联）
  assert.ok(report.notes!.includes("产出物 1"));
  // 不应含"未内联"提示
  assert.ok(!report.notes!.includes("未内联"));
});

// ============================================================================
// T10. 真实 DEFAULT_STATIC_CHECKERS 集成测试
// ============================================================================

test("T10a. 使用真实 DEFAULT_STATIC_CHECKERS 评估单一红线（E4 依赖方向）", async () => {
  // 使用真实 DEFAULT_STATIC_CHECKERS 评估 E4 红线
  // 输入：合法的 import 语句（domain 不依赖 infrastructure）
  const evaluator = new StrictEvaluator(DEFAULT_STATIC_CHECKERS);
  const context = createContext({
    inlineArtifacts: [
      {
        path: "src/domain/order/OrderAggregate.ts",
        content: [
          "import { DomainEvent } from './DomainEvent';",
          "export class OrderAggregate {",
          "  private _id: string;",
          "}",
        ].join("\n"),
      },
    ],
  });
  const redlines: RedlineDefinition[] = [
    {
      id: "E4",
      name: "依赖方向",
      description: "domain 不得依赖 infrastructure",
      severity: "blocker",
      checkMethod: "import 静态分析",
      checkType: "static",
      fixGuidance: "重构依赖方向",
    },
  ];
  const report = await evaluator.evaluate(context, redlines);
  // 应返回 EvaluationReport
  assert.ok(report.verdict === "pass" || report.verdict === "fix" || report.verdict === "human_checkpoint");
  assert.equal(report.redlineResults.length, 1);
  assert.equal(report.redlineResults[0].redlineId, "E4");
});

test("T10b. 使用真实 DEFAULT_STATIC_CHECKERS 评估多个红线（E1~E8）", async () => {
  const evaluator = new StrictEvaluator(DEFAULT_STATIC_CHECKERS);
  // 构造 8 条企业红线
  const redlines: RedlineDefinition[] = [
    {
      id: "E1",
      name: "事务边界",
      description: "Saga 模式",
      severity: "major",
      checkMethod: "静态扫描",
      checkType: "static",
    },
    {
      id: "E2",
      name: "幂等性",
      description: "幂等键",
      severity: "major",
      checkMethod: "静态扫描",
      checkType: "static",
    },
    {
      id: "E3",
      name: "审计",
      description: "事件比对",
      severity: "major",
      checkMethod: "静态扫描",
      checkType: "static",
    },
    {
      id: "E4",
      name: "依赖方向",
      description: "domain 不依赖 infra",
      severity: "blocker",
      checkMethod: "静态扫描",
      checkType: "static",
    },
    {
      id: "E5",
      name: "输入校验",
      description: "DTO 校验",
      severity: "major",
      checkMethod: "静态扫描",
      checkType: "static",
    },
    {
      id: "E6",
      name: "密钥与配置",
      description: "硬编码密钥",
      severity: "blocker",
      checkMethod: "静态扫描",
      checkType: "static",
    },
    {
      id: "E7",
      name: "贫血模型禁令",
      description: "方法密度",
      severity: "warning",
      checkMethod: "静态扫描",
      checkType: "static",
    },
    {
      id: "E8",
      name: "API 契约",
      description: "OpenAPI",
      severity: "blocker",
      checkMethod: "静态扫描",
      checkType: "static",
    },
  ];
  const report = await evaluator.evaluate(createContext(), redlines);
  // 应处理全部 8 条红线
  assert.equal(report.redlineResults.length, 8);
  // 验证所有 redlineId 都被处理
  const redlineIds = report.redlineResults.map((r) => r.redlineId);
  assert.deepEqual(redlineIds, ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"]);
});

test("T10c. 未注册红线（如自定义 RLIS 转化红线）→ unknown", async () => {
  const evaluator = new StrictEvaluator(DEFAULT_STATIC_CHECKERS);
  const redlines: RedlineDefinition[] = [
    {
      id: "RLIS-CUSTOM-01",
      name: "自定义规则",
      description: "未注册 Checker 的自定义规则",
      severity: "major",
      checkMethod: "推理判定",
      checkType: "reasoning",
    },
  ];
  const report = await evaluator.evaluate(createContext(), redlines);
  // 未注册 Checker → unknown
  assert.equal(report.redlineResults[0].status, "unknown");
  // 至少 1 条 unknown → human_checkpoint
  assert.equal(report.verdict, "human_checkpoint");
});
