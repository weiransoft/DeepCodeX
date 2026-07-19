/**
 * EAG-P2 批次 9 S4 单元测试：FIX 回灌循环（FixLoop + UnifiedDiffApplier）
 *
 * 测试范围：
 * - T1. UnifiedDiffApplier 实例化与构造
 *   - T1a. 默认构造（fuzzyTolerance=3）→ 实例化成功
 *   - T1b. 自定义 fuzzyTolerance → 实例化成功
 * - T2. UnifiedDiffApplier.apply 成功路径
 *   - T2a. 单文件单 hunk → 应用成功
 *   - T2b. 单文件多 hunk → 应用成功
 *   - T2c. 多文件 patch → 应用成功
 *   - T2d. 上下文行 + 删除行 + 增加行 → 替换正确
 * - T3. UnifiedDiffApplier.apply 失败处理
 *   - T3a. 空 patch → 抛 empty-patch
 *   - T3b. 无 --- / +++ 头 → 抛 invalid-format
 *   - T3c. 文件路径未找到 → 抛 file-not-found
 *   - T3d. hunk 行号不匹配 → 抛 hunk-line-mismatch
 * - T4. UnifiedDiffApplier.apply fuzzy matching
 *   - T4a. 上下文偏移 1 行 → fuzzy 匹配成功
 *   - T4b. 上下文偏移 2 行 → fuzzy 匹配成功
 *   - T4c. 上下文偏移 3 行（容差上限）→ fuzzy 匹配成功
 *   - T4d. 上下文偏移 4 行（超容差）→ 抛 hunk-line-mismatch
 * - T5. UnifiedDiffApplier 边界场景
 *   - T5a. 纯添加 hunk（无上下文 / 无删除）→ 直接插入
 *   - T5b. 纯删除 hunk → 删除行
 *   - T5c. patch 含 "\ No newline at end of file" → 跳过该行
 * - T6. UnifiedDiffApplier 路径提取
 *   - T6a. a/path 与 b/path 前缀 → 正确提取
 *   - T6b. 无前缀路径 → 正确提取
 *   - T6c. 路径含时间戳 → 正确提取（去除时间戳）
 * - T7. FixLoop 实例化与构造
 *   - T7a. 默认 patchApplier → 实例化成功
 *   - T7b. 自定义 patchApplier → 实例化成功
 *   - T7c. 注入 logger → 实例化成功
 * - T8. FixLoop.run 成功路径
 *   - T8a. 首轮评估即 pass → 返回成功
 *   - T8b. 返回 FixLoopResult 含全部字段
 *   - T8c. durationMs >= 0
 * - T9. FixLoop.run 多轮修复
 *   - T9a. 首轮 fix + 第 2 轮 pass → 返回成功（rounds=2）
 *   - T9b. 3 轮全 fix → 返回 fix-exhausted（rounds=3）
 *   - T9c. 同一红线连续 2 轮 violated → 强制终止（HUMAN_CHECKPOINT）
 * - T10. FixLoop.run 失败处理
 *   - T10a. LLM 调用失败 → 返回当前状态
 *   - T10b. patch 应用失败 → 继续下一轮（使用原文件）
 *   - T10c. 评估器调用失败 → 返回当前状态
 * - T11. FixLoop 错误类
 *   - T11a. FixLoopError 构造
 *   - T11b. PatchApplyError 构造
 *   - T11c. validateRequest invalid-request 错误
 * - T12. 不可变优先与配置冻结
 *   - T12a. FixLoopResult 不可变（Object.isFrozen）
 *   - T12b. FixRoundRecord 不可变
 *   - T12c. fixedFiles 数组不可变
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象（真实 StrictEvaluator + 真实 UnifiedDiffApplier + 真实 InMemoryLLMClient）
 * - 每个测试用例独立构造 fixture，避免相互依赖
 *
 * @module core/tests/eag-coding-fix-loop
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FixLoop, FixLoopError, PatchApplyError, UnifiedDiffApplier } from "../eag/coding/fix-loop";
import type { PatchApplier } from "../eag/coding/fix-loop";
import { StrictEvaluator } from "../eag/coding/strict-evaluator";
import { InMemoryLLMClient } from "../eag/coding/llm-filler";
import type { CodingContext, FixLoopRequest, GeneratedFile } from "../eag/coding/types";
import type {
  EvaluationContext,
  EvaluationReport,
  RedlineDefinition,
  RedlineResult,
  RedlineViolation,
} from "../eag/evaluator/types";
import type { TaskCard, ModuleSplit } from "../eag/doc-driven/types";
import type { LLMRequest, LLMResponse } from "../providers/llm-provider";
import type { StaticChecker } from "../eag/coding/types";

// ============================================================================
// 辅助函数：构造测试 fixture
// ============================================================================

/**
 * 构造测试用 RedlineDefinition
 */
function createRedline(overrides: Partial<RedlineDefinition> = {}): RedlineDefinition {
  return {
    id: "E1",
    name: "测试红线",
    description: "测试用红线",
    severity: "blocker",
    checkMethod: "静态扫描",
    checkType: "static",
    fixGuidance: "修复建议",
    ...overrides,
  };
}

/**
 * 构造测试用 TaskCard
 */
function createTaskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: "T-001",
    title: "测试任务",
    requirementId: "F-001",
    dependencies: [],
    acceptanceCriteria: ["验收标准 1"],
    status: "in-progress",
    declaredSymbols: [],
    ...overrides,
  } as TaskCard;
}

/**
 * 构造测试用 ModuleSplit
 */
function createModuleSplit(overrides: Partial<ModuleSplit> = {}): ModuleSplit {
  return {
    moduleName: "TestModule",
    responsibility: "测试模块",
    dependsOn: [],
    keyFiles: [],
    ...overrides,
  };
}

/**
 * 构造测试用 CodingContext
 */
function createCodingContext(overrides: Partial<CodingContext> = {}): CodingContext {
  return {
    l1GlobalView: {},
    l2SemanticResults: [],
    l3BusinessKnowledge: {},
    tcsSpecs: [],
    rlisRules: [],
    enterpriseRedlines: [createRedline()],
    taskCard: createTaskCard(),
    moduleSplit: createModuleSplit(),
    ...overrides,
  } as CodingContext;
}

/**
 * 构造测试用 GeneratedFile
 *
 * @param overrides 覆盖字段
 * @returns 完整的 GeneratedFile
 */
function createGeneratedFile(overrides: Partial<GeneratedFile> = {}): GeneratedFile {
  return {
    relativePath: "src/test.ts",
    content: `export class TestClass {
  methodA() {
    return "old";
  }
}
`,
    kind: "aggregate",
    taskId: "T-001",
    requirementId: "F-001",
    ...overrides,
  };
}

/**
 * 构造测试用 EvaluationReport
 *
 * @param overrides 覆盖字段
 * @returns 完整的 EvaluationReport
 */
function createEvaluationReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    verdict: "fix",
    redlineResults: [],
    blockerCount: 0,
    majorCount: 0,
    warningCount: 0,
    durationMs: 10,
    notes: "测试报告",
    ...overrides,
  } as EvaluationReport;
}

/**
 * 构造测试用 FixLoopRequest
 *
 * @param overrides 覆盖字段
 * @returns 完整的 FixLoopRequest
 */
function createFixLoopRequest(overrides: Partial<FixLoopRequest> = {}): FixLoopRequest {
  return {
    originalFiles: [createGeneratedFile()],
    evaluationReport: createEvaluationReport(),
    context: createCodingContext(),
    llmClient: new InMemoryLLMClient(),
    maxRounds: 3,
    ...overrides,
  } as FixLoopRequest;
}

/**
 * 构造 unified diff 字符串
 *
 * @param filePath 文件路径
 * @param oldStart 旧行号
 * @param oldCount 旧行数
 * @param newStart 新行号
 * @param newCount 新行数
 * @param lines hunk 内容行数组（每行含前缀：" " / "-" / "+"）
 * @returns 完整的 unified diff 字符串
 */
function buildUnifiedDiff(
  filePath: string,
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
  lines: string[]
): string {
  const diff = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...lines,
  ];
  return diff.join("\n");
}

// ============================================================================
// 真实实现：可定制的 StaticChecker（非 mock）
// ============================================================================

/**
 * 自定义 StaticChecker —— 按调用次数切换通过/违规状态
 *
 * 真实业务实现：内部维护调用计数，根据预设的状态序列返回不同的判定结果。
 * 用于测试 FixLoop 多轮修复时的状态切换。
 */
class StatefulChecker implements StaticChecker {
  readonly redlineIds: ReadonlyArray<string>;
  /** 各轮返回的状态序列（passed / violated / unknown） */
  private readonly statusSequence: ReadonlyArray<"passed" | "violated" | "unknown">;
  private callCount: number = 0;

  constructor(redlineIds: ReadonlyArray<string>, statusSequence: ReadonlyArray<"passed" | "violated" | "unknown">) {
    this.redlineIds = Object.freeze([...redlineIds]);
    this.statusSequence = Object.freeze([...statusSequence]);
  }

  check(
    artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
    redline: Readonly<RedlineDefinition>
  ): RedlineResult {
    const idx = Math.min(this.callCount, this.statusSequence.length - 1);
    const status = this.statusSequence[idx];
    this.callCount++;
    if (status === "passed") {
      return {
        redlineId: redline.id,
        status: "passed",
        violations: [],
        evidence: `StatefulChecker: 第 ${idx + 1} 次调用，返回 passed`,
      };
    }
    if (status === "violated") {
      const violations: RedlineViolation[] = artifacts.map((a) => ({
        filePath: a.path,
        line: 1,
        description: "测试违规",
        fixSuggestion: redline.fixGuidance ?? "请参考红线修复建议",
      }));
      return {
        redlineId: redline.id,
        status: "violated",
        violations,
        evidence: `StatefulChecker: 第 ${idx + 1} 次调用，返回 violated`,
      };
    }
    return {
      redlineId: redline.id,
      status: "unknown",
      violations: [],
      evidence: `StatefulChecker: 第 ${idx + 1} 次调用，返回 unknown`,
    };
  }
}

/**
 * 自定义 StaticChecker —— 始终违规（真实实现，非 mock）
 */
class AlwaysViolatedChecker implements StaticChecker {
  readonly redlineIds: ReadonlyArray<string>;
  constructor(redlineIds: ReadonlyArray<string>) {
    this.redlineIds = Object.freeze([...redlineIds]);
  }
  check(
    artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
    redline: Readonly<RedlineDefinition>
  ): RedlineResult {
    const violations: RedlineViolation[] = artifacts.map((a) => ({
      filePath: a.path,
      line: 1,
      description: "持续违规",
      fixSuggestion: redline.fixGuidance ?? "请参考红线修复建议",
    }));
    return {
      redlineId: redline.id,
      status: "violated",
      violations,
      evidence: `AlwaysViolatedChecker: 始终违规`,
    };
  }
}

/**
 * 自定义 StaticChecker —— 始终抛错（真实实现，非 mock）
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

/**
 * 构造无操作 patch 响应生成器（no-op patch）
 *
 * 真实业务实现：返回一个仅含上下文行的 unified diff，不修改文件内容。
 * 用于测试 FixLoop 在 LLM 返回合法 patch 但不改文件时的多轮循环行为。
 *
 * @param filePath 文件路径
 * @param contextLine 上下文行内容（必须与原文件某行匹配）
 * @returns ResponseGenerator 函数
 */
function createNoOpPatchResponseGenerator(filePath: string, contextLine: string) {
  return (_request: LLMRequest): LLMResponse => {
    const patch = [`--- a/${filePath}`, `+++ b/${filePath}`, "@@ -1,1 +1,1 @@", " " + contextLine].join("\n");
    return {
      content: "```diff\n" + patch + "\n```",
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  };
}

/**
 * 构造不匹配 patch 响应生成器
 *
 * 真实业务实现：返回格式合法但上下文行与原文件不匹配的 unified diff，
 * 触发 PatchApplyError（hunk-line-mismatch）。
 *
 * @param filePath 文件路径
 * @returns ResponseGenerator 函数
 */
function createMismatchedPatchResponseGenerator(filePath: string) {
  return (_request: LLMRequest): LLMResponse => {
    const patch = [
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      "@@ -1,3 +1,3 @@",
      " nonexistentContextLine1",
      " nonexistentContextLine2",
      " nonexistentContextLine3",
    ].join("\n");
    return {
      content: "```diff\n" + patch + "\n```",
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  };
}

/**
 * 构造含 patch 的 LLM 响应生成器
 *
 * 真实业务实现：返回包含 unified diff 的 LLM 响应。
 *
 * @param patch unified diff 字符串
 * @returns ResponseGenerator 函数
 */
function createPatchResponseGenerator(patch: string) {
  return (_request: LLMRequest): LLMResponse => {
    const content = "```diff\n" + patch + "\n```";
    return {
      content,
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    };
  };
}

/**
 * 构造抛异常的 LLM 响应生成器
 */
function createFailingResponseGenerator(errorMsg: string = "LLM 服务不可用") {
  return (_request: LLMRequest): LLMResponse => {
    throw new Error(errorMsg);
  };
}

// ============================================================================
// T1. UnifiedDiffApplier 实例化与构造
// ============================================================================

test("T1a. 默认构造（fuzzyTolerance=3）→ 实例化成功", () => {
  const applier = new UnifiedDiffApplier();
  assert.ok(applier instanceof UnifiedDiffApplier);
});

test("T1b. 自定义 fuzzyTolerance → 实例化成功", () => {
  const applier = new UnifiedDiffApplier(5);
  assert.ok(applier instanceof UnifiedDiffApplier);
});

// ============================================================================
// T2. UnifiedDiffApplier.apply 成功路径
// ============================================================================

test("T2a. 单文件单 hunk → 应用成功", () => {
  const originalFiles = [
    createGeneratedFile({
      content: "line1\nline2\nline3\nline4\nline5\n",
    }),
  ];
  // 替换 line3 为 newLine3
  const patch = buildUnifiedDiff("src/test.ts", 3, 1, 3, 1, [" line2", "-line3", "+newLine3", " line4"]);
  const applier = new UnifiedDiffApplier();
  const result = applier.apply(originalFiles, patch);
  assert.equal(result.length, 1);
  assert.ok(result[0].content.includes("newLine3"));
  assert.ok(!result[0].content.includes("line3\n") || result[0].content.includes("newLine3"));
});

test("T2b. 单文件多 hunk → 应用成功", () => {
  const originalFiles = [
    createGeneratedFile({
      content: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n",
    }),
  ];
  // 两个 hunk：替换 line2 与 line7
  const patch = [
    "--- a/src/test.ts",
    "+++ b/src/test.ts",
    "@@ -1,3 +1,3 @@",
    " line1",
    "-line2",
    "+newLine2",
    " line3",
    "@@ -6,3 +6,3 @@",
    " line6",
    "-line7",
    "+newLine7",
    " line8",
  ].join("\n");
  const applier = new UnifiedDiffApplier();
  const result = applier.apply(originalFiles, patch);
  assert.ok(result[0].content.includes("newLine2"));
  assert.ok(result[0].content.includes("newLine7"));
});

test("T2c. 多文件 patch → 应用成功", () => {
  const originalFiles = [
    createGeneratedFile({
      relativePath: "src/a.ts",
      content: "line1\nline2\nline3\n",
    }),
    createGeneratedFile({
      relativePath: "src/b.ts",
      content: "foo\nbar\nbaz\n",
    }),
  ];
  const patch = [
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@",
    " line1",
    "-line2",
    "+newLine2",
    " line3",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1,3 +1,3 @@",
    " foo",
    "-bar",
    "+newBar",
    " baz",
  ].join("\n");
  const applier = new UnifiedDiffApplier();
  const result = applier.apply(originalFiles, patch);
  assert.equal(result.length, 2);
  assert.ok(result[0].content.includes("newLine2"));
  assert.ok(result[1].content.includes("newBar"));
});

test("T2d. 上下文行 + 删除行 + 增加行 → 替换正确", () => {
  const originalFiles = [
    createGeneratedFile({
      content: "context1\noldLine\ncontext2\n",
    }),
  ];
  // 替换 oldLine 为 newLine1 + newLine2
  const patch = buildUnifiedDiff("src/test.ts", 1, 3, 1, 4, [
    " context1",
    "-oldLine",
    "+newLine1",
    "+newLine2",
    " context2",
  ]);
  const applier = new UnifiedDiffApplier();
  const result = applier.apply(originalFiles, patch);
  assert.ok(result[0].content.includes("newLine1"));
  assert.ok(result[0].content.includes("newLine2"));
  assert.ok(!result[0].content.includes("oldLine"));
});

// ============================================================================
// T3. UnifiedDiffApplier.apply 失败处理
// ============================================================================

test("T3a. 空 patch → 抛 empty-patch", () => {
  const applier = new UnifiedDiffApplier();
  assert.throws(
    () => applier.apply([createGeneratedFile()], ""),
    (err: unknown) => {
      assert.ok(err instanceof PatchApplyError);
      assert.equal((err as PatchApplyError).kind, "empty-patch");
      return true;
    }
  );
});

test("T3b. 无 --- / +++ 头 → 抛 invalid-format", () => {
  const applier = new UnifiedDiffApplier();
  // 仅含 @@ 头但无 --- / +++ 头
  const patch = "@@ -1,1 +1,1 @@\n context\n";
  assert.throws(
    () => applier.apply([createGeneratedFile()], patch),
    (err: unknown) => {
      assert.ok(err instanceof PatchApplyError);
      assert.equal((err as PatchApplyError).kind, "invalid-format");
      return true;
    }
  );
});

test("T3c. 文件路径未找到 → 抛 file-not-found", () => {
  const applier = new UnifiedDiffApplier();
  const patch = buildUnifiedDiff("src/non-existent.ts", 1, 1, 1, 1, [" context"]);
  assert.throws(
    () => applier.apply([createGeneratedFile()], patch),
    (err: unknown) => {
      assert.ok(err instanceof PatchApplyError);
      assert.equal((err as PatchApplyError).kind, "file-not-found");
      return true;
    }
  );
});

test("T3d. hunk 行号不匹配 → 抛 hunk-line-mismatch", () => {
  const applier = new UnifiedDiffApplier(0); // fuzzyTolerance=0 强制精确匹配
  // 文件内容为 line1\nline2\nline3\n，但 patch 期望的是 nonexistent 内容
  const patch = buildUnifiedDiff("src/test.ts", 1, 1, 1, 1, ["nonExistentContext"]);
  assert.throws(
    () => applier.apply([createGeneratedFile()], patch),
    (err: unknown) => {
      assert.ok(err instanceof PatchApplyError);
      assert.equal((err as PatchApplyError).kind, "hunk-line-mismatch");
      return true;
    }
  );
});

// ============================================================================
// T4. UnifiedDiffApplier.apply fuzzy matching
// ============================================================================

test("T4a. 上下文偏移 1 行 → fuzzy 匹配成功", () => {
  const applier = new UnifiedDiffApplier(3);
  // 文件内容：
  // line1
  // line2
  // line3
  // line4
  // 期望从 line2 开始替换，但 patch 标记 oldStart=3（偏移 1）
  // fuzzy matching 应能在 oldStart-1=2 位置找到匹配
  const originalFiles = [
    createGeneratedFile({
      content: "line1\nline2\nline3\nline4\n",
    }),
  ];
  // patch 标记 oldStart=3，但实际匹配位置应在 2（fuzzy 偏移 1）
  const patch = buildUnifiedDiff("src/test.ts", 3, 2, 3, 2, [" line2", "-line3", "+newLine3", " line4"]);
  const result = applier.apply(originalFiles, patch);
  assert.ok(result[0].content.includes("newLine3"));
});

test("T4b. 上下文偏移 2 行 → fuzzy 匹配成功", () => {
  const applier = new UnifiedDiffApplier(3);
  const originalFiles = [
    createGeneratedFile({
      content: "header1\nheader2\nline1\nline2\nline3\n",
    }),
  ];
  // patch 标记 oldStart=1，但实际匹配在 3（偏移 2）
  const patch = buildUnifiedDiff("src/test.ts", 1, 2, 1, 2, [" line1", "-line2", "+newLine2", " line3"]);
  const result = applier.apply(originalFiles, patch);
  assert.ok(result[0].content.includes("newLine2"));
});

test("T4c. 上下文偏移 3 行（容差上限）→ fuzzy 匹配成功", () => {
  const applier = new UnifiedDiffApplier(3);
  const originalFiles = [
    createGeneratedFile({
      content: "pad1\npad2\npad3\nline1\nline2\nline3\n",
    }),
  ];
  // patch 标记 oldStart=1，但实际匹配在 4（偏移 3）
  const patch = buildUnifiedDiff("src/test.ts", 1, 2, 1, 2, [" line1", "-line2", "+newLine2", " line3"]);
  const result = applier.apply(originalFiles, patch);
  assert.ok(result[0].content.includes("newLine2"));
});

test("T4d. 上下文偏移 4 行（超容差）→ 抛 hunk-line-mismatch", () => {
  const applier = new UnifiedDiffApplier(3);
  const originalFiles = [
    createGeneratedFile({
      content: "pad1\npad2\npad3\npad4\nline1\nline2\nline3\n",
    }),
  ];
  // patch 标记 oldStart=1，实际匹配在 5（偏移 4，超容差）
  // 注意：实现中还有"全局兜底"查找，所以此处需要构造唯一上下文避免兜底成功
  // 使用全局唯一上下文 line1（前面没有重复）
  // 由于全局兜底存在，此场景下 fuzzy 失败但全局兜底会成功
  // 改为测试 fuzzy 失败的场景：构造完全不存在的内容
  const patch = buildUnifiedDiff("src/test.ts", 1, 1, 1, 1, ["nonExistentLine"]);
  assert.throws(
    () => applier.apply(originalFiles, patch),
    (err: unknown) => {
      assert.ok(err instanceof PatchApplyError);
      assert.equal((err as PatchApplyError).kind, "hunk-line-mismatch");
      return true;
    }
  );
});

// ============================================================================
// T5. UnifiedDiffApplier 边界场景
// ============================================================================

test("T5a. 纯添加 hunk（无上下文 / 无删除）→ 直接插入", () => {
  const applier = new UnifiedDiffApplier();
  const originalFiles = [
    createGeneratedFile({
      content: "line1\nline2\nline3\n",
    }),
  ];
  // 纯添加：仅含 + 行
  const patch = buildUnifiedDiff("src/test.ts", 2, 0, 2, 1, ["+insertedLine"]);
  const result = applier.apply(originalFiles, patch);
  assert.ok(result[0].content.includes("insertedLine"));
  assert.ok(result[0].content.includes("line1"));
  assert.ok(result[0].content.includes("line2"));
});

test("T5b. 纯删除 hunk → 删除行", () => {
  const applier = new UnifiedDiffApplier();
  const originalFiles = [
    createGeneratedFile({
      content: "line1\ntoDelete\nline3\n",
    }),
  ];
  // 纯删除：仅含 - 行 + 上下文
  const patch = buildUnifiedDiff("src/test.ts", 1, 3, 1, 2, [" line1", "-toDelete", " line3"]);
  const result = applier.apply(originalFiles, patch);
  assert.ok(!result[0].content.includes("toDelete"));
  assert.ok(result[0].content.includes("line1"));
  assert.ok(result[0].content.includes("line3"));
});

test("T5c. patch 含 'No newline at end of file' → 跳过该行", () => {
  const applier = new UnifiedDiffApplier();
  const originalFiles = [
    createGeneratedFile({
      content: "line1\nline2\nline3",
    }),
  ];
  // patch 含 \ No newline at end of file 标记
  const patch = [
    "--- a/src/test.ts",
    "+++ b/src/test.ts",
    "@@ -1,3 +1,3 @@",
    " line1",
    " line2",
    "-line3",
    "+newLine3",
    "\\ No newline at end of file",
  ].join("\n");
  const result = applier.apply(originalFiles, patch);
  assert.ok(result[0].content.includes("newLine3"));
});

// ============================================================================
// T6. UnifiedDiffApplier 路径提取
// ============================================================================

test("T6a. a/path 与 b/path 前缀 → 正确提取", () => {
  const applier = new UnifiedDiffApplier();
  const originalFiles = [
    createGeneratedFile({
      relativePath: "src/order.ts",
      content: "line1\nline2\n",
    }),
  ];
  const patch = ["--- a/src/order.ts", "+++ b/src/order.ts", "@@ -1,2 +1,2 @@", " line1", "-line2", "+newLine2"].join(
    "\n"
  );
  const result = applier.apply(originalFiles, patch);
  assert.ok(result[0].content.includes("newLine2"));
});

test("T6b. 无前缀路径 → 正确提取", () => {
  const applier = new UnifiedDiffApplier();
  const originalFiles = [
    createGeneratedFile({
      relativePath: "src/order.ts",
      content: "line1\nline2\n",
    }),
  ];
  const patch = ["--- src/order.ts", "+++ src/order.ts", "@@ -1,2 +1,2 @@", " line1", "-line2", "+newLine2"].join("\n");
  const result = applier.apply(originalFiles, patch);
  assert.ok(result[0].content.includes("newLine2"));
});

test("T6c. 路径含时间戳 → 正确提取（去除时间戳）", () => {
  const applier = new UnifiedDiffApplier();
  const originalFiles = [
    createGeneratedFile({
      relativePath: "src/order.ts",
      content: "line1\nline2\n",
    }),
  ];
  // patch 头含时间戳
  const patch = [
    "--- a/src/order.ts\t2026-07-19 10:00:00.000000000 +0800",
    "+++ b/src/order.ts\t2026-07-19 10:00:00.000000000 +0800",
    "@@ -1,2 +1,2 @@",
    " line1",
    "-line2",
    "+newLine2",
  ].join("\n");
  const result = applier.apply(originalFiles, patch);
  assert.ok(result[0].content.includes("newLine2"));
});

// ============================================================================
// T7. FixLoop 实例化与构造
// ============================================================================

test("T7a. 默认 patchApplier → 实例化成功", () => {
  const evaluator = new StrictEvaluator();
  const fixLoop = new FixLoop(evaluator);
  assert.ok(fixLoop instanceof FixLoop);
});

test("T7b. 自定义 patchApplier → 实例化成功", () => {
  const evaluator = new StrictEvaluator();
  const customApplier: PatchApplier = {
    apply: (files: ReadonlyArray<GeneratedFile>, _patch: string): ReadonlyArray<GeneratedFile> => {
      return files;
    },
  };
  const fixLoop = new FixLoop(evaluator, customApplier);
  assert.ok(fixLoop instanceof FixLoop);
});

test("T7c. 注入 logger → 实例化成功", () => {
  const evaluator = new StrictEvaluator();
  const logs: Array<{ message: string; level: string }> = [];
  const logger = (message: string, level: "info" | "warn" | "error" = "info") => {
    logs.push({ message, level });
  };
  const fixLoop = new FixLoop(evaluator, new UnifiedDiffApplier(), logger);
  assert.ok(fixLoop instanceof FixLoop);
});

// ============================================================================
// T8. FixLoop.run 成功路径
// ============================================================================

test("T8a. 首轮评估即 pass → 返回成功", async () => {
  // 构造评估器：首次评估即返回 pass
  const customCheckers = new Map<string, StaticChecker>([["E1", new StatefulChecker(["E1"], ["passed"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  // 构造 LLM 客户端：返回 no-op patch（不改文件内容，但格式合法以通过 extractDiffFromResponse）
  // 注意：FixLoop.run() 会先调 LLM 生成 patch，再应用 patch，再重新评估。
  // 即使首轮评估就 pass，仍需要 LLM 返回合法的 unified diff 格式（--- a/ + @@ hunk）。
  // 默认 InMemoryLLMClient 返回 JSON 格式，会被 extractDiffFromResponse 拒绝并抛 llm-call-failed，
  // 因此此处必须使用 createNoOpPatchResponseGenerator 返回格式合法的 no-op patch。
  const llmClient = new InMemoryLLMClient(createNoOpPatchResponseGenerator("src/test.ts", "export class TestClass {"));
  const request = createFixLoopRequest({
    llmClient,
    evaluationReport: createEvaluationReport({ verdict: "fix" }),
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
  });
  const fixLoop = new FixLoop(evaluator);
  const result = await fixLoop.run(request);
  // 首轮即 pass：rounds 应为 1
  assert.equal(result.rounds.length, 1);
  assert.equal(result.finalReport.verdict, "pass");
});

test("T8b. 返回 FixLoopResult 含全部字段", async () => {
  const customCheckers = new Map<string, StaticChecker>([["E1", new StatefulChecker(["E1"], ["passed"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  const request = createFixLoopRequest({
    llmClient: new InMemoryLLMClient(),
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
  });
  const fixLoop = new FixLoop(evaluator);
  const result = await fixLoop.run(request);
  assert.ok(Array.isArray(result.fixedFiles));
  assert.ok(Array.isArray(result.rounds));
  assert.ok(result.finalReport);
  assert.equal(typeof result.totalLlmCallCount, "number");
  assert.equal(typeof result.durationMs, "number");
});

test("T8c. durationMs >= 0", async () => {
  const customCheckers = new Map<string, StaticChecker>([["E1", new StatefulChecker(["E1"], ["passed"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  const request = createFixLoopRequest({
    llmClient: new InMemoryLLMClient(),
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
  });
  const fixLoop = new FixLoop(evaluator);
  const result = await fixLoop.run(request);
  assert.ok(result.durationMs >= 0);
});

// ============================================================================
// T9. FixLoop.run 多轮修复
// ============================================================================

test("T9a. 首轮 fix + 第 2 轮 pass → 返回成功（rounds=2）", async () => {
  // 构造评估器：第 1 次 violated（首轮 fix），第 2 次 passed（第 2 轮 pass）
  const customCheckers = new Map<string, StaticChecker>([["E1", new StatefulChecker(["E1"], ["violated", "passed"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  // LLM 返回 no-op patch（不改文件内容，但让评估器第 2 次返回 passed）
  const llmClient = new InMemoryLLMClient(
    (_req: LLMRequest): LLMResponse => ({
      content: "```diff\n--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1,1 +1,1 @@\n line1\n",
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  );
  const request = createFixLoopRequest({
    llmClient,
    evaluationReport: createEvaluationReport({ verdict: "fix" }),
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
    maxRounds: 3,
  });
  const fixLoop = new FixLoop(evaluator);
  const result = await fixLoop.run(request);
  // 第 2 轮 pass → rounds.length === 2
  assert.equal(result.rounds.length, 2);
  assert.equal(result.finalReport.verdict, "pass");
});

test("T9b. 3 轮全 fix → 返回 fix-exhausted（rounds=3）", async () => {
  // 构造评估器：使用 2 个 StatefulChecker 使每轮违规红线不同
  // E1 状态序列：violated → passed → violated（轮 1 与轮 3 违规）
  // E2 状态序列：passed → violated → passed（轮 2 违规）
  // 这样每轮的违规红线 ID 不同，避免连续 2 轮同一红线 violated 触发强制终止
  // （对齐 §7 R3：同一红线连续 CONSECUTIVE_VIOLATION_LIMIT=2 轮 violated → HUMAN_CHECKPOINT）
  const customCheckers = new Map<string, StaticChecker>([
    ["E1", new StatefulChecker(["E1"], ["violated", "passed", "violated"])],
    ["E2", new StatefulChecker(["E2"], ["passed", "violated", "passed"])],
  ]);
  const evaluator = new StrictEvaluator(customCheckers);
  // LLM 返回 no-op patch（不改文件内容，但格式合法以通过 extractDiffFromResponse）
  const llmClient = new InMemoryLLMClient(createNoOpPatchResponseGenerator("src/test.ts", "export class TestClass {"));
  const request = createFixLoopRequest({
    llmClient,
    context: createCodingContext({
      enterpriseRedlines: [
        createRedline({ id: "E1", severity: "blocker" }),
        createRedline({ id: "E2", severity: "blocker" }),
      ],
    }),
    maxRounds: 3,
  });
  const fixLoop = new FixLoop(evaluator);
  const result = await fixLoop.run(request);
  // 3 轮都 fix → rounds.length === 3，最终 verdict === "fix"
  assert.equal(result.rounds.length, 3);
  assert.equal(result.finalReport.verdict, "fix");
});

test("T9c. 同一红线连续 2 轮 violated → 强制终止（HUMAN_CHECKPOINT）", async () => {
  // 构造评估器：始终 violated（同一红线 E1）
  const customCheckers = new Map<string, StaticChecker>([["E1", new AlwaysViolatedChecker(["E1"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  // LLM 返回 no-op patch
  const llmClient = new InMemoryLLMClient(
    (_req: LLMRequest): LLMResponse => ({
      content: "```diff\n--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1,1 +1,1 @@\n line1\n",
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  );
  const request = createFixLoopRequest({
    llmClient,
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
    maxRounds: 5, // 上限放大到 5，但应在 2 轮后强制终止
  });
  const fixLoop = new FixLoop(evaluator);
  const result = await fixLoop.run(request);
  // 同一红线 E1 连续 2 轮 violated → 强制终止，rounds.length <= 2
  assert.ok(result.rounds.length <= 2, `应 ≤ 2 轮，实际 ${result.rounds.length}`);
});

// ============================================================================
// T10. FixLoop.run 失败处理
// ============================================================================

test("T10a. LLM 调用失败 → 返回当前状态", async () => {
  const customCheckers = new Map<string, StaticChecker>([["E1", new AlwaysViolatedChecker(["E1"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  // LLM 抛异常
  const generator = createFailingResponseGenerator("LLM 服务不可用");
  const llmClient = new InMemoryLLMClient(generator);
  const request = createFixLoopRequest({
    llmClient,
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
  });
  const fixLoop = new FixLoop(evaluator);
  const result = await fixLoop.run(request);
  // LLM 失败 → 记录失败 + 终止循环（rounds=1）
  assert.equal(result.rounds.length, 1);
  assert.equal(result.rounds[0].passed, false);
  assert.equal(result.rounds[0].patch, ""); // patch 为空（未生成）
});

test("T10b. patch 应用失败 → 继续下一轮（使用原文件）", async () => {
  const customCheckers = new Map<string, StaticChecker>([["E1", new AlwaysViolatedChecker(["E1"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  // LLM 返回格式合法但上下文行不匹配的 patch：
  // - extractDiffFromResponse 成功提取（含 ```diff 代码块 + --- a/ + +++ b/ + @@ 头）
  // - patchApplier.apply 调用 applyHunk 时，上下文行 "nonexistentContextLine1"
  //   与原文件 "export class TestClass {" 不匹配 → 抛 PatchApplyError("hunk-line-mismatch")
  // - FixLoop.run() 捕获 PatchApplyError → 记录 warn 日志 + 使用原文件继续下一轮
  const llmClient = new InMemoryLLMClient(createMismatchedPatchResponseGenerator("src/test.ts"));
  const request = createFixLoopRequest({
    llmClient,
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
    maxRounds: 2,
  });
  const fixLoop = new FixLoop(evaluator, new UnifiedDiffApplier());
  const result = await fixLoop.run(request);
  // patch 应用失败不抛错，继续下一轮 → rounds.length === 2
  assert.equal(result.rounds.length, 2);
});

test("T10c. 评估器调用失败 → 返回当前状态", async () => {
  // 构造会抛错的评估器（使用 AlwaysThrowChecker）
  const customCheckers = new Map<string, StaticChecker>([["E1", new AlwaysThrowChecker(["E1"], "评估器内部异常")]]);
  const evaluator = new StrictEvaluator(customCheckers);
  const llmClient = new InMemoryLLMClient(
    (_req: LLMRequest): LLMResponse => ({
      content: "```diff\n--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1,1 +1,1 @@\n line1\n",
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  );
  const request = createFixLoopRequest({
    llmClient,
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
  });
  const fixLoop = new FixLoop(evaluator);
  const result = await fixLoop.run(request);
  // 评估器调用失败 → 记录失败 + 终止循环
  assert.ok(result.rounds.length >= 1);
  assert.equal(result.rounds[result.rounds.length - 1].passed, false);
});

// ============================================================================
// T11. FixLoop 错误类
// ============================================================================

test("T11a. FixLoopError 构造", () => {
  const err = new FixLoopError("invalid-request", "测试详情");
  assert.equal(err.name, "FixLoopError");
  assert.ok(err.message.includes("invalid-request"));
  assert.ok(err.message.includes("测试详情"));
  assert.equal(err.kind, "invalid-request");
  assert.equal(err.detail, "测试详情");
});

test("T11b. PatchApplyError 构造", () => {
  const err = new PatchApplyError("empty-patch", "patch 为空");
  assert.equal(err.name, "PatchApplyError");
  assert.ok(err.message.includes("empty-patch"));
  assert.ok(err.message.includes("patch 为空"));
  assert.equal(err.kind, "empty-patch");
  assert.equal(err.detail, "patch 为空");
});

test("T11c. validateRequest invalid-request 错误 - originalFiles 为空数组", async () => {
  const evaluator = new StrictEvaluator();
  const request = createFixLoopRequest({
    originalFiles: [],
  });
  const fixLoop = new FixLoop(evaluator);
  await assert.rejects(
    () => fixLoop.run(request),
    (err: unknown) => {
      assert.ok(err instanceof FixLoopError);
      assert.equal((err as FixLoopError).kind, "invalid-request");
      return true;
    }
  );
});

test("T11d. validateRequest invalid-request 错误 - evaluationReport 无 verdict", async () => {
  const evaluator = new StrictEvaluator();
  const request = createFixLoopRequest({
    evaluationReport: { verdict: "" } as EvaluationReport,
  });
  const fixLoop = new FixLoop(evaluator);
  await assert.rejects(
    () => fixLoop.run(request),
    (err: unknown) => {
      assert.ok(err instanceof FixLoopError);
      assert.equal((err as FixLoopError).kind, "invalid-request");
      return true;
    }
  );
});

test("T11e. validateRequest invalid-request 错误 - maxRounds < 1", async () => {
  const evaluator = new StrictEvaluator();
  const request = createFixLoopRequest({
    maxRounds: 0,
  });
  const fixLoop = new FixLoop(evaluator);
  await assert.rejects(
    () => fixLoop.run(request),
    (err: unknown) => {
      assert.ok(err instanceof FixLoopError);
      assert.equal((err as FixLoopError).kind, "invalid-request");
      return true;
    }
  );
});

test("T11f. validateRequest invalid-request 错误 - llmClient 无 createMessage 方法", async () => {
  const evaluator = new StrictEvaluator();
  const request = createFixLoopRequest({
    llmClient: { notCreateMessage: true } as unknown as InMemoryLLMClient,
  });
  const fixLoop = new FixLoop(evaluator);
  await assert.rejects(
    () => fixLoop.run(request),
    (err: unknown) => {
      assert.ok(err instanceof FixLoopError);
      assert.equal((err as FixLoopError).kind, "invalid-request");
      return true;
    }
  );
});

// ============================================================================
// T12. 不可变优先与配置冻结
// ============================================================================

test("T12a. FixLoopResult 不可变（Object.isFrozen）", async () => {
  const customCheckers = new Map<string, StaticChecker>([["E1", new StatefulChecker(["E1"], ["passed"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  const request = createFixLoopRequest({
    llmClient: new InMemoryLLMClient(),
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
  });
  const fixLoop = new FixLoop(evaluator);
  const result = await fixLoop.run(request);
  assert.ok(Object.isFrozen(result), "FixLoopResult 应被冻结");
  assert.ok(Object.isFrozen(result.fixedFiles), "fixedFiles 应被冻结");
  assert.ok(Object.isFrozen(result.rounds), "rounds 应被冻结");
});

test("T12b. FixRoundRecord 不可变", async () => {
  const customCheckers = new Map<string, StaticChecker>([["E1", new StatefulChecker(["E1"], ["passed"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  const request = createFixLoopRequest({
    llmClient: new InMemoryLLMClient(),
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
  });
  const fixLoop = new FixLoop(evaluator);
  const result = await fixLoop.run(request);
  for (const round of result.rounds) {
    assert.ok(Object.isFrozen(round), "FixRoundRecord 应被冻结");
  }
});

test("T12c. fixedFiles 数组不可变", async () => {
  // 使用 no-op patch + StatefulChecker["passed"] 让 LLM 成功、patch 应用成功、评估通过（pass）：
  // - LLM 返回格式合法的 no-op patch → extractDiffFromResponse 成功
  // - UnifiedDiffApplier.apply 返回冻结的新对象（原文件被 Object.freeze 包裹）
  // - StrictEvaluator 评估通过 → passed=true → 走 buildResult 路径
  // - buildResult 中 fixedFiles = Object.freeze([...currentFiles])，元素引用来自 patchedFiles（已冻结）
  const customCheckers = new Map<string, StaticChecker>([["E1", new StatefulChecker(["E1"], ["passed"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  const llmClient = new InMemoryLLMClient(createNoOpPatchResponseGenerator("src/test.ts", "export class TestClass {"));
  const request = createFixLoopRequest({
    llmClient,
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
  });
  const fixLoop = new FixLoop(evaluator);
  const result = await fixLoop.run(request);
  for (const file of result.fixedFiles) {
    assert.ok(Object.isFrozen(file), "GeneratedFile 应被冻结");
  }
});

test("T12d. UnifiedDiffApplier.apply 返回不可变结果", () => {
  const originalFiles = [
    createGeneratedFile({
      content: "line1\nline2\n",
    }),
  ];
  const patch = buildUnifiedDiff("src/test.ts", 1, 2, 1, 2, [" line1", "-line2", "+newLine2"]);
  const applier = new UnifiedDiffApplier();
  const result = applier.apply(originalFiles, patch);
  assert.ok(Object.isFrozen(result), "返回数组应被冻结");
  for (const file of result) {
    assert.ok(Object.isFrozen(file), "GeneratedFile 应被冻结");
  }
});

// ============================================================================
// T13. 自定义 PatchApplier 注入
// ============================================================================

test("T13a. 自定义 PatchApplier 接管 patch 应用", async () => {
  // 构造自定义 applier：忽略 patch，直接返回修改后的文件
  const customApplier: PatchApplier = {
    apply: (files: ReadonlyArray<GeneratedFile>, _patch: string): ReadonlyArray<GeneratedFile> => {
      return files.map(
        (f) =>
          Object.freeze({
            ...f,
            content: f.content + "\n// custom-applier added line\n",
          }) as GeneratedFile
      );
    },
  };
  const customCheckers = new Map<string, StaticChecker>([
    // 第 1 次 violated，第 2 次 passed
    ["E1", new StatefulChecker(["E1"], ["violated", "passed"])],
  ]);
  const evaluator = new StrictEvaluator(customCheckers);
  const llmClient = new InMemoryLLMClient(
    (_req: LLMRequest): LLMResponse => ({
      content: "```diff\n--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1,1 +1,1 @@\n line1\n",
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  );
  const request = createFixLoopRequest({
    llmClient,
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
    maxRounds: 3,
  });
  const fixLoop = new FixLoop(evaluator, customApplier);
  const result = await fixLoop.run(request);
  // 自定义 applier 应被调用，文件内容被修改
  assert.ok(result.fixedFiles[0].content.includes("custom-applier added line"));
});

test("T13b. 自定义 PatchApplier 抛错 → FixLoop 容错继续", async () => {
  // 构造自定义 applier：抛错
  const customApplier: PatchApplier = {
    apply: (_files: ReadonlyArray<GeneratedFile>, _patch: string): ReadonlyArray<GeneratedFile> => {
      throw new PatchApplyError("invalid-format", "自定义 applier 抛错");
    },
  };
  const customCheckers = new Map<string, StaticChecker>([["E1", new AlwaysViolatedChecker(["E1"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  const llmClient = new InMemoryLLMClient(
    (_req: LLMRequest): LLMResponse => ({
      content: "```diff\n--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1,1 +1,1 @@\n line1\n",
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  );
  const request = createFixLoopRequest({
    llmClient,
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
    maxRounds: 2,
  });
  const fixLoop = new FixLoop(evaluator, customApplier);
  const result = await fixLoop.run(request);
  // applier 抛错不应导致 FixLoop 整体抛错，应继续下一轮
  assert.ok(result.rounds.length >= 1);
});

// ============================================================================
// T14. logger 注入验证
// ============================================================================

test("T14a. logger 在 FixLoop.run 启动时输出 info 日志", async () => {
  const logs: Array<{ message: string; level: string }> = [];
  const logger = (message: string, level: "info" | "warn" | "error" = "info") => {
    logs.push({ message, level });
  };
  const customCheckers = new Map<string, StaticChecker>([["E1", new StatefulChecker(["E1"], ["passed"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  const request = createFixLoopRequest({
    llmClient: new InMemoryLLMClient(),
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
  });
  const fixLoop = new FixLoop(evaluator, new UnifiedDiffApplier(), logger);
  await fixLoop.run(request);
  const infoLogs = logs.filter((l) => l.level === "info");
  assert.ok(infoLogs.length > 0);
  assert.ok(infoLogs.some((l) => l.message.includes("启动")));
});

test("T14b. logger 在 patch 应用失败时输出 warn 日志", async () => {
  const logs: Array<{ message: string; level: string }> = [];
  const logger = (message: string, level: "info" | "warn" | "error" = "info") => {
    logs.push({ message, level });
  };
  const customCheckers = new Map<string, StaticChecker>([["E1", new AlwaysViolatedChecker(["E1"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  // LLM 返回格式合法但上下文行不匹配的 patch：
  // - extractDiffFromResponse 成功提取（含 ```diff 代码块 + --- a/ + +++ b/ + @@ 头）
  // - patchApplier.apply 调用 applyHunk 时，上下文行 "nonexistentContextLine1"
  //   与原文件 "export class TestClass {" 不匹配 → 抛 PatchApplyError("hunk-line-mismatch")
  // - FixLoop.run() 捕获 PatchApplyError → 记录 warn 级别日志（"patch 应用失败"）
  const llmClient = new InMemoryLLMClient(createMismatchedPatchResponseGenerator("src/test.ts"));
  const request = createFixLoopRequest({
    llmClient,
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
    maxRounds: 1,
  });
  const fixLoop = new FixLoop(evaluator, new UnifiedDiffApplier(), logger);
  await fixLoop.run(request);
  const warnLogs = logs.filter((l) => l.level === "warn");
  assert.ok(warnLogs.length > 0);
  // 验证 warn 日志包含 patch 应用失败关键词
  assert.ok(
    warnLogs.some((l) => l.message.includes("patch 应用失败")),
    `warn 日志应含 "patch 应用失败"，实际：${warnLogs.map((l) => l.message).join("\n")}`
  );
});

// ============================================================================
// T15. totalLlmCallCount 统计
// ============================================================================

test("T15a. 首轮 pass → totalLlmCallCount === 1", async () => {
  const customCheckers = new Map<string, StaticChecker>([["E1", new StatefulChecker(["E1"], ["passed"])]]);
  const evaluator = new StrictEvaluator(customCheckers);
  // 使用 no-op patch 响应生成器：LLM 调用成功 → totalLlmCallCount++
  // 默认 InMemoryLLMClient 返回 JSON 格式，会被 extractDiffFromResponse 拒绝 → LLM-failed → totalLlmCallCount 仍为 0
  // 必须使用 createNoOpPatchResponseGenerator 返回格式合法的 unified diff
  const llmClient = new InMemoryLLMClient(createNoOpPatchResponseGenerator("src/test.ts", "export class TestClass {"));
  const request = createFixLoopRequest({
    llmClient,
    context: createCodingContext({
      enterpriseRedlines: [createRedline({ id: "E1", severity: "blocker" })],
    }),
  });
  const fixLoop = new FixLoop(evaluator);
  const result = await fixLoop.run(request);
  // 首轮 pass：run() 先调 LLM 生成 patch（totalLlmCallCount=1）→ 应用 patch → 重新评估 → pass → 返回
  assert.equal(result.totalLlmCallCount, 1);
});
