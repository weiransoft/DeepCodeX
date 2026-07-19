/**
 * EAG-P0 单元测试：SessionManager 评估器外挂 hook
 *
 * 测试范围：
 * - IndependentEvaluator 协议的最简真实实现（StaticEvaluator）
 * - LoopGuard 与评估器的组合行为（模拟主循环 !toolCalls 判定点的契约）
 * - SessionManagerOptions 的 evaluator/loopGuard/evaluatorRedlines 字段存在性与传递性
 * - EvaluationContext 构造完整性
 * - 边界情况：空 redlines / 评估器异常降级
 *
 * 测试策略（推荐策略 2：组件级测试）：
 * - runEvaluatorHook 为 SessionManager 的私有方法，无法直接调用
 * - 通过组件级测试验证 EAG-P0 核心契约：
 *   1. 构造真实的 StaticEvaluator（非 mock，按协议实现静态判定逻辑）
 *   2. 配合真实的 LoopGuard，测试组合行为
 *   3. 验证 SessionManagerOptions 字段正确传递（通过 SessionManager 实例化不报错验证）
 *   4. 通过 simulateEvaluatorHook 复制 runEvaluatorHook 的判定逻辑，验证降级语义
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict（与项目既有测试一致）
 * - 禁止使用 mock 框架（按用户规则，构造真实实现）
 * - 中文注释
 *
 * 设计依据：
 * - EAG 方案 §5.4 Goal Evaluator 接入主循环
 * - EAG 方案 §5.2.1 五步闭环上限保护
 * - session.ts runEvaluatorHook（§1998-2097） / activateSession 主循环外挂逻辑（§1722-1762 / §1945-1961）
 * - eag/evaluator/types.ts IndependentEvaluator 协议
 * - common/loop-guard.ts LoopGuard 共享上限保护
 *
 * @module tests/eag-session-hook
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../session";
import { LoopGuard } from "../common/loop-guard";
import {
  buildReport,
  type IndependentEvaluator,
  type EvaluationContext,
  type EvaluationReport,
  type EvaluationMode,
  type EvaluationVerdict,
  type RedlineDefinition,
  type RedlineResult,
} from "../eag/evaluator/types";

// ============================================================================
// 测试辅助：真实评估器实现（非 mock，按协议实现静态判定逻辑）
// ============================================================================

/**
 * 违规触发标记
 *
 * StaticEvaluator 通过检查 inlineArtifacts 内容是否包含此标记来判定是否违规。
 * 模拟"硬编码密钥模式扫描"这类静态可判红线（确定性判定，非推理判定）。
 */
const VIOLATION_MARKER = "VIOLATION:";

/**
 * StaticEvaluator —— 最简真实独立评估器实现
 *
 * 按 IndependentEvaluator 协议实现一个基于静态字符串匹配的评估器：
 * - 检查 inlineArtifacts 内容是否包含 VIOLATION_MARKER
 * - 若包含：所有红线判定为 violated，verdict=fix
 * - 若不包含：所有红线判定为 passed，verdict=pass
 *
 * 此实现是真实的评估器（非 mock），验证 EAG-P0 评估器协议的契约正确性。
 * 使用 buildReport() 共享函数构建报告，确保报告结构与决策逻辑一致。
 */
class StaticEvaluator implements IndependentEvaluator {
  /** 评估器名称（用于日志和审计） */
  static readonly NAME = "StaticEvaluator";
  /** 评估器默认模式（保守策略，无客观指标即不通过） */
  static readonly DEFAULT_MODE: EvaluationMode = "strict";

  getName(): string {
    return StaticEvaluator.NAME;
  }

  getDefaultMode(): EvaluationMode {
    return StaticEvaluator.DEFAULT_MODE;
  }

  /**
   * 执行评估
   *
   * 判定逻辑：
   * 1. 收集 inlineArtifacts 的所有内容（可能有多条）
   * 2. 检查是否包含 VIOLATION_MARKER（静态字符串匹配）
   * 3. 若包含：所有红线判定为 violated，附违规记录
   * 4. 若不包含：所有红线判定为 passed
   * 5. 调用 buildReport 构建完整评估报告
   *
   * @param context 评估上下文（产出物 + Loop 信息）
   * @param redlines 红线清单
   * @returns 评估报告
   */
  async evaluate(context: EvaluationContext, redlines: ReadonlyArray<RedlineDefinition>): Promise<EvaluationReport> {
    const startMs = Date.now();

    // 收集 inlineArtifacts 全部内容（可能有多条），空数组时为空串
    const content = (context.inlineArtifacts ?? []).map((a) => a.content).join("\n");

    // 静态判定：是否包含违规标记
    const hasViolation = content.includes(VIOLATION_MARKER);

    // 对每条红线生成判定结果
    const results: RedlineResult[] = redlines.map((rl) => {
      if (hasViolation) {
        // 违规：构造一条违规记录（附修复建议，对应 RedlineDefinition.fixGuidance）
        return {
          redlineId: rl.id,
          status: "violated" as const,
          violations: [
            {
              filePath: "<assistant-reply>",
              description: `检测到违规标记 ${VIOLATION_MARKER}`,
              fixSuggestion: rl.fixGuidance ?? "请移除违规内容",
            },
          ],
          evidence: `静态扫描命中：${VIOLATION_MARKER}`,
        };
      }
      // 合规
      return {
        redlineId: rl.id,
        status: "passed" as const,
        violations: [],
      };
    });

    // 调用共享 buildReport 构建完整报告（确保报告结构与决策逻辑一致）
    return buildReport(
      results,
      redlines,
      Date.now() - startMs,
      0,
      hasViolation ? "静态扫描发现违规标记" : "静态扫描未发现违规"
    );
  }
}

/**
 * ThrowingEvaluator —— 用于测试评估器异常降级
 *
 * evaluate() 总是抛出异常，用于验证调用方（runEvaluatorHook）的 try-catch 降级行为：
 * 评估器故障不应阻塞主流程（EAG-P0 降级语义，session.ts §2091-2096）。
 *
 * 注意：evaluate 方法签名需与 IndependentEvaluator 接口一致
 * （接收 context 与 redlines 参数，尽管本实现不使用它们）。
 */
class ThrowingEvaluator implements IndependentEvaluator {
  getName(): string {
    return "ThrowingEvaluator";
  }
  getDefaultMode(): EvaluationMode {
    return "strict";
  }
  async evaluate(_context: EvaluationContext, _redlines: ReadonlyArray<RedlineDefinition>): Promise<EvaluationReport> {
    throw new Error("评估器内部异常（测试用）");
  }
}

// ============================================================================
// 测试数据工厂（内联构造真实对象，非 mock）
// ============================================================================

/**
 * 构造一条 BLOCKER 级红线定义
 * @param id 红线 ID
 */
function makeBlockerRedline(id: string): RedlineDefinition {
  return {
    id,
    name: `${id} 红线`,
    description: `${id} 描述`,
    severity: "blocker",
    checkMethod: "静态分析",
    checkType: "static",
    fixGuidance: "修复指引",
  };
}

/**
 * 构造一条 MAJOR 级红线定义
 * @param id 红线 ID
 */
function makeMajorRedline(id: string): RedlineDefinition {
  return {
    id,
    name: `${id} 红线`,
    description: `${id} 描述`,
    severity: "major",
    checkMethod: "推理判定",
    checkType: "reasoning",
    fixGuidance: "修复指引",
  };
}

/**
 * 构造最小评估上下文
 *
 * @param content LLM 最终回复内容（作为 inlineArtifacts 注入）
 * @param mode 评估模式（默认 "strict"）
 */
function makeContext(content: string, mode?: EvaluationMode): EvaluationContext {
  return {
    loopType: "coding",
    iteration: 0,
    taskId: "test-task",
    artifactPaths: [],
    inlineArtifacts: [{ path: "<assistant-reply>", content }],
    mode: mode ?? "strict",
  };
}

/**
 * 模拟 SessionManager.runEvaluatorHook 的核心逻辑（session.ts §2020-2097）
 *
 * 由于 runEvaluatorHook 为私有方法无法直接调用，
 * 此函数复制其判定逻辑用于组件级测试，验证 EAG-P0 核心契约：
 * 1. 未注入 evaluator 或 evaluatorRedlines 为空 → 返回 null（降级，§2027）
 * 2. 调用 evaluator.evaluate，按 verdict 返回
 * 3. 评估器异常 → 返回 null（降级，不阻塞主流程，§2091-2096）
 *
 * @param evaluator 评估器实例（未注入时传 undefined）
 * @param redlines 红线清单（未注入或空时传 undefined 或 []）
 * @param assistantContent LLM 最终回复内容
 * @returns 评估结论或 null
 */
async function simulateEvaluatorHook(
  evaluator: IndependentEvaluator | undefined,
  redlines: ReadonlyArray<RedlineDefinition> | undefined,
  assistantContent: string
): Promise<EvaluationVerdict | null> {
  // 降级判定：未注入 evaluator 或 evaluatorRedlines 为空 → 返回 null
  // 对应 session.ts §2027：!this.evaluator || !this.evaluatorRedlines || this.evaluatorRedlines.length === 0
  if (!evaluator || !redlines || redlines.length === 0) {
    return null;
  }
  try {
    // 构造评估上下文（对应 session.ts §2033-2051）
    const context: EvaluationContext = {
      loopType: "coding",
      iteration: 0,
      taskId: "simulated-session",
      artifactPaths: [],
      inlineArtifacts: [
        {
          path: "<assistant-reply>",
          content: assistantContent,
        },
      ],
      mode: evaluator.getDefaultMode(),
    };
    // 调用评估器
    const report = await evaluator.evaluate(context, redlines);
    return report.verdict;
  } catch {
    // 评估器异常：降级为 null（对应 session.ts §2091-2096）
    return null;
  }
}

// ============================================================================
// A. IndependentEvaluator 协议实现测试
// ============================================================================

test("A1. StaticEvaluator 实例化成功（实现 IndependentEvaluator 接口）", () => {
  // 验证：StaticEvaluator 可正常实例化，且 implements IndependentEvaluator 接口
  const evaluator = new StaticEvaluator();
  assert.ok(evaluator instanceof StaticEvaluator);
  // 验证接口契约方法存在
  assert.equal(typeof evaluator.getName, "function");
  assert.equal(typeof evaluator.getDefaultMode, "function");
  assert.equal(typeof evaluator.evaluate, "function");
});

test("A2. getName/getDefaultMode 返回正确值", () => {
  const evaluator = new StaticEvaluator();
  assert.equal(evaluator.getName(), "StaticEvaluator");
  assert.equal(evaluator.getDefaultMode(), "strict");
});

test("A3. evaluate 返回 EvaluationReport 结构正确", async () => {
  // 验证：evaluate 返回的报告结构包含所有必填字段
  const evaluator = new StaticEvaluator();
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1")];
  const report = await evaluator.evaluate(makeContext("合规内容"), redlines);

  // 验证 EvaluationReport 所有必填字段存在
  assert.ok("verdict" in report, "report 应包含 verdict 字段");
  assert.ok("redlineResults" in report, "report 应包含 redlineResults 字段");
  assert.ok("blockerCount" in report, "report 应包含 blockerCount 字段");
  assert.ok("majorCount" in report, "report 应包含 majorCount 字段");
  assert.ok("warningCount" in report, "report 应包含 warningCount 字段");
  assert.ok("durationMs" in report, "report 应包含 durationMs 字段");
  // verdict 必须是合法的 EvaluationVerdict 枚举值
  assert.ok(
    ["pass", "fix", "human_checkpoint", "stop_failure"].includes(report.verdict),
    `verdict 应为合法枚举值，实际为 ${report.verdict}`
  );
  // durationMs 应为非负数
  assert.ok(report.durationMs >= 0, "durationMs 应为非负数");
  // redlineResults 应为数组
  assert.ok(Array.isArray(report.redlineResults), "redlineResults 应为数组");
});

test("A4. evaluate 对合规内容返回 verdict=pass", async () => {
  // 验证：内容不含违规标记时，所有红线 passed，verdict=pass
  const evaluator = new StaticEvaluator();
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1"), makeMajorRedline("E2")];
  const report = await evaluator.evaluate(makeContext("这是一段合规的代码，没有违规标记"), redlines);

  assert.equal(report.verdict, "pass");
  assert.equal(report.blockerCount, 0);
  assert.equal(report.majorCount, 0);
  assert.equal(report.warningCount, 0);
  // 所有红线判定为 passed
  assert.equal(report.redlineResults.length, 2);
  for (const r of report.redlineResults) {
    assert.equal(r.status, "passed");
    assert.equal(r.violations.length, 0);
  }
  // 无违规时 fixSuggestions 应为 undefined
  assert.equal(report.fixSuggestions, undefined);
});

test("A5. evaluate 对违规内容返回 verdict=fix", async () => {
  // 验证：内容含违规标记时，所有红线 violated，verdict=fix
  const evaluator = new StaticEvaluator();
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1"), makeMajorRedline("E2")];
  const report = await evaluator.evaluate(makeContext(`代码内容\n${VIOLATION_MARKER} 硬编码密钥`), redlines);

  assert.equal(report.verdict, "fix");
  // BLOCKER 红线 E1 违规 → blockerCount=1
  assert.equal(report.blockerCount, 1);
  // MAJOR 红线 E2 违规 → majorCount=1
  assert.equal(report.majorCount, 1);
  assert.equal(report.warningCount, 0);
  // 所有红线判定为 violated
  assert.equal(report.redlineResults.length, 2);
  for (const r of report.redlineResults) {
    assert.equal(r.status, "violated");
    assert.equal(r.violations.length, 1);
  }
  // fixSuggestions 应存在并包含修复建议
  assert.ok(report.fixSuggestions);
  assert.equal(report.fixSuggestions!.length, 2);
});

test("A6. evaluate 的 redlineResults 包含所有传入的 redlines（顺序与 ID 对应）", async () => {
  // 验证：传入 N 条红线，redlineResults 返回 N 条结果，redlineId 一一对应
  const evaluator = new StaticEvaluator();
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1"), makeMajorRedline("E2"), makeBlockerRedline("E3")];
  const report = await evaluator.evaluate(makeContext("合规内容"), redlines);

  assert.equal(report.redlineResults.length, 3);
  // 验证 redlineId 顺序与传入一致
  assert.equal(report.redlineResults[0].redlineId, "E1");
  assert.equal(report.redlineResults[1].redlineId, "E2");
  assert.equal(report.redlineResults[2].redlineId, "E3");
});

// ============================================================================
// B. LoopGuard 与评估器的组合行为测试
// ============================================================================

test("B7. LoopGuard + StaticEvaluator 组合：pass 重置失败计数，连续 3 次 fix 触发终止", async () => {
  // 模拟 activateSession 主循环（session.ts §1722-1762 / §1945-1961）的组合行为：
  // - 循环顶部调用 LoopGuard.check() 判定是否允许继续
  // - !toolCalls 判定点调用评估器，按 verdict 决定 recordIteration 的 success 参数
  // - pass → recordIteration(success=true) → consecutiveFailures 重置为 0
  // - fix → recordIteration(success=false) → consecutiveFailures 递增
  // - 连续 3 次 fix → LoopGuard.check() 返回 allowed=false, stopReason="max_consecutive_failures"

  const guard = new LoopGuard({ maxConsecutiveFailures: 3, maxIterations: 100, maxTokens: 1_000_000 });
  const evaluator = new StaticEvaluator();
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1")];

  // 跟踪主循环行为
  const verdicts: EvaluationVerdict[] = [];
  let terminated = false;
  let stopReason: string | undefined = undefined;

  // 模拟主循环（最多 20 轮防止意外死循环）
  for (let i = 0; i < 20; i++) {
    // 1. 循环顶部 LoopGuard 检查（对应 session.ts §1731-1763）
    const guardCheck = guard.check();
    if (!guardCheck.allowed) {
      terminated = true;
      stopReason = guardCheck.stopReason;
      break;
    }

    // 2. 评估器外挂判定（对应 session.ts §1950）
    // 交替产生 fix/pass/fix 序列，验证重置语义
    const content =
      i === 2 // 第 3 轮给合规内容，验证 pass 重置 consecutiveFailures
        ? "合规内容"
        : `${VIOLATION_MARKER} 违规`;
    const verdict = await simulateEvaluatorHook(evaluator, redlines, content);
    assert.ok(verdict !== null, "评估器应返回非 null verdict（已注入 evaluator + redlines）");
    verdicts.push(verdict!);

    // 3. 记录迭代（对应 session.ts §1955-1959）
    // success 语义：verdict=pass 或 null（未注入评估器）
    const success = verdict === "pass" || verdict === null;
    guard.recordIteration(0, success);
  }

  // 验证：第 3 轮 pass 重置了 consecutiveFailures，因此需要再连续 3 次 fix 才终止
  // 序列：fix(1), fix(2), pass(重置→0), fix(1), fix(2), fix(3) → 第 7 轮 check() 终止
  // 注：使用 deepEqual 比较数组内容（equal 对数组使用引用相等）
  assert.deepEqual(verdicts, ["fix", "fix", "pass", "fix", "fix", "fix"]);
  // 验证循环被 LoopGuard 终止
  assert.ok(terminated, "循环应被 LoopGuard 终止");
  assert.equal(stopReason, "max_consecutive_failures");
  // 验证连续失败计数达到上限
  assert.equal(guard.getState().consecutiveFailures, 3);
});

test("B8. 评估器返回 fix 但未超连续失败上限 → LoopGuard.check() 仍 allowed=true, suggestedWaitMs > 0", async () => {
  // 验证：单次失败后，LoopGuard 仍允许继续，但建议退避等待（指数退避）
  const guard = new LoopGuard({
    maxConsecutiveFailures: 3,
    maxIterations: 100,
    maxTokens: 1_000_000,
    initialBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    backoffMultiplier: 2.0,
    jitterRatio: 0.1,
  });
  const evaluator = new StaticEvaluator();
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1")];

  // 首次 check：无失败记录，suggestedWaitMs 应为 undefined
  const check0 = guard.check();
  assert.equal(check0.allowed, true);
  assert.equal(check0.suggestedWaitMs, undefined);

  // 一次失败迭代（评估器返回 fix）
  const verdict = await simulateEvaluatorHook(evaluator, redlines, `${VIOLATION_MARKER} 违规`);
  assert.equal(verdict, "fix");
  guard.recordIteration(0, false); // success=false

  // 再次 check：连续失败 1 < 3，仍 allowed=true；但有失败记录，suggestedWaitMs > 0
  const check1 = guard.check();
  assert.equal(check1.allowed, true);
  assert.ok(
    check1.suggestedWaitMs !== undefined && check1.suggestedWaitMs > 0,
    `suggestedWaitMs 应 > 0（指数退避），实际为 ${check1.suggestedWaitMs}`
  );
  // 退避延迟应在合理范围内（initialBackoffMs=1000, jitter=±10% → 900~1100）
  assert.ok(
    check1.suggestedWaitMs! >= 900 && check1.suggestedWaitMs! <= 1100,
    `首次退避应在 900~1100ms 范围内，实际为 ${check1.suggestedWaitMs}`
  );
  // 验证状态：连续失败计数=1
  assert.equal(check1.state.consecutiveFailures, 1);
  assert.equal(check1.state.backoffLevel, 1);
});

// ============================================================================
// C. SessionManagerOptions 字段验证
// ============================================================================

test("C9. 传入 evaluator/loopGuard/evaluatorRedlines 时字段正确传递", () => {
  // 验证：SessionManager 构造函数正确赋值 EAG-P0 新增字段（session.ts §475-478）
  // 构造真实的 minimal stub（非 mock 框架，而是真实函数实现）
  const evaluator = new StaticEvaluator();
  const loopGuard = new LoopGuard({ maxIterations: 10 });
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1")];

  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    // EAG-P0 新增字段
    evaluator,
    loopGuard,
    evaluatorRedlines: redlines,
  });

  // 通过 any 类型访问私有字段验证赋值（与 session.test.ts 既有模式一致）

  const internal = manager as any;
  assert.equal(internal.evaluator, evaluator, "evaluator 字段应正确传递");
  assert.equal(internal.loopGuard, loopGuard, "loopGuard 字段应正确传递");
  assert.equal(internal.evaluatorRedlines, redlines, "evaluatorRedlines 字段应正确传递");
});

test("C10. 不传入 evaluator/loopGuard/evaluatorRedlines 时 SessionManager 正常构造（向后兼容）", () => {
  // 验证：EAG-P0 字段均为可选，不注入时 SessionManager 正常构造
  // （向后兼容保证，V2 526 测试零回归，session.ts §380-383 注释）
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    // 不传入 evaluator/loopGuard/evaluatorRedlines
  });

  assert.ok(manager instanceof SessionManager);
  // 验证未注入时字段为 undefined

  const internal = manager as any;
  assert.equal(internal.evaluator, undefined, "未注入时 evaluator 应为 undefined");
  assert.equal(internal.loopGuard, undefined, "未注入时 loopGuard 应为 undefined");
  assert.equal(internal.evaluatorRedlines, undefined, "未注入时 evaluatorRedlines 应为 undefined");
});

// ============================================================================
// D. EvaluationContext 构造测试
// ============================================================================

test("D11. EvaluationContext 字段完整性（loopType/iteration/taskId/artifactPaths/inlineArtifacts/mode）", () => {
  // 验证：EvaluationContext 所有字段可正确构造（对应 session.ts §2033-2051 构造逻辑）
  const context: EvaluationContext = {
    loopType: "coding",
    iteration: 5,
    taskId: "task-001",
    artifactPaths: ["/path/to/file.ts"],
    inlineArtifacts: [{ path: "<assistant-reply>", content: "内容" }],
    mode: "strict",
  };

  assert.equal(context.loopType, "coding");
  assert.equal(context.iteration, 5);
  assert.equal(context.taskId, "task-001");
  assert.equal(context.artifactPaths.length, 1);
  assert.equal(context.artifactPaths[0], "/path/to/file.ts");
  assert.equal(context.inlineArtifacts?.length, 1);
  assert.equal(context.inlineArtifacts![0].path, "<assistant-reply>");
  assert.equal(context.inlineArtifacts![0].content, "内容");
  assert.equal(context.mode, "strict");
});

test("D12. inlineArtifacts 为空数组时评估器仍可运行（降级语义）", async () => {
  // 验证：inlineArtifacts 为空数组时，评估器不报错，返回 verdict=pass
  // （降级语义：无内容可判定即视为合规，对应 session.ts §2043-2048 注入空数组场景）
  const evaluator = new StaticEvaluator();
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1")];
  const context: EvaluationContext = {
    loopType: "coding",
    iteration: 0,
    taskId: "test-task",
    artifactPaths: [],
    inlineArtifacts: [], // 空数组
    mode: "strict",
  };

  const report = await evaluator.evaluate(context, redlines);
  // 空内容 → 不含违规标记 → 所有红线 passed → verdict=pass
  assert.equal(report.verdict, "pass");
  assert.equal(report.blockerCount, 0);
  assert.equal(report.redlineResults.length, 1);
  assert.equal(report.redlineResults[0].status, "passed");
});

// ============================================================================
// E. 边界情况
// ============================================================================

test("E13. evaluatorRedlines 为空数组时 simulateEvaluatorHook 跳过（返回 null）", async () => {
  // 验证 runEvaluatorHook 的降级语义（session.ts §2027）：
  // 未注入 evaluator 或 evaluatorRedlines 为空 → 返回 null（主循环保持现有 return 行为）
  const evaluator = new StaticEvaluator();

  // 情况 1：redlines 为空数组 → 跳过
  const verdict1 = await simulateEvaluatorHook(evaluator, [], "任意内容");
  assert.equal(verdict1, null, "空 redlines 时应返回 null（跳过评估）");

  // 情况 2：redlines 为 undefined → 跳过
  const verdict2 = await simulateEvaluatorHook(evaluator, undefined, "任意内容");
  assert.equal(verdict2, null, "undefined redlines 时应返回 null（跳过评估）");

  // 情况 3：evaluator 为 undefined → 跳过
  const verdict3 = await simulateEvaluatorHook(undefined, [makeBlockerRedline("E1")], "任意内容");
  assert.equal(verdict3, null, "undefined evaluator 时应返回 null（跳过评估）");

  // 额外验证：StaticEvaluator 直接调用 evaluate 时，空 redlines 返回 verdict=pass
  // （评估器层面：无红线即无违规，verdict=pass）
  const report = await evaluator.evaluate(makeContext("任意内容"), []);
  assert.equal(report.verdict, "pass");
  assert.equal(report.redlineResults.length, 0);
});

test("E14. 评估器 evaluate 抛异常时 simulateEvaluatorHook 降级为 null", async () => {
  // 验证 runEvaluatorHook 的异常降级行为（session.ts §2091-2096）：
  // 评估器调用异常 → 返回 null（降级为无操作，不阻塞主循环 return）
  const evaluator = new ThrowingEvaluator();
  const redlines: RedlineDefinition[] = [makeBlockerRedline("E1")];

  // 验证 ThrowingEvaluator.evaluate 确实抛异常
  await assert.rejects(
    async () => evaluator.evaluate(makeContext("内容"), redlines),
    /评估器内部异常/,
    "ThrowingEvaluator.evaluate 应抛出异常"
  );

  // 验证 simulateEvaluatorHook 捕获异常并降级为 null
  const verdict = await simulateEvaluatorHook(evaluator, redlines, "内容");
  assert.equal(verdict, null, "评估器异常时应降级为 null，不阻塞主流程");
});

// ============================================================================
// F. EAG-P2 批次 9 S5：/eag-build 命令外挂 hook 测试（§4.9.3）
// ============================================================================
//
// 本节验证 EAG-P2 批次 9 S5 在 session.ts 中新增的 /eag-build 命令分支：
// - isEagBuildPrompt 命令判定逻辑
// - handleEagBuildCommand 依赖校验与错误处理
// - extractCodingLoopRequest 元数据提取
// - renderCodingLoopResult 结果渲染
// - SessionManagerOptions 新增字段（codingOrchestrator / pkcAccessor）正确传递
// - UserPromptContent 新增 messageParams 字段正确传递
//
// 设计依据：
// - EAG-P2 批次 9 设计 §4.9.3 新增 Hook 点设计
// - session.ts isEagBuildPrompt / handleEagBuildCommand / extractCodingLoopRequest / renderCodingLoopResult
// - 向后兼容保证（§4.9.4）：未注入 codingOrchestrator 时零影响

/**
 * 构造测试用最小 CodingLoopRequest 占位对象
 *
 * 用于测试 extractCodingLoopRequest 的字段校验逻辑。
 * 注：此对象仅用于校验通过，不可真正传给 CodingOrchestrator.run()。
 */
function createMinimalCodingLoopRequestPlaceholder(): Record<string, unknown> {
  return {
    projectRoot: "/test/project",
    specContent: "spec",
    planContent: "plan",
    tasksContent: "tasks",
    taskDag: { nodes: [], topologicalOrder: [] },
    taskCards: [],
    techStack: ["TypeScript"],
    constitutionContent: "constitution",
    llmClient: { createMessage: () => ({}), providerName: "test" },
    pkcAccessor: { queryL1GlobalView: () => ({}), searchL2: () => [], queryL3BusinessKnowledge: () => ({}) },
    loopGuard: {
      check: () => ({ allowed: true }),
      recordIteration: () => {},
      getConfig: () => ({
        maxIterations: 10,
        maxTokens: 100000,
        maxConsecutiveFailures: 3,
        initialBackoffMs: 1000,
        maxBackoffMs: 30000,
        backoffMultiplier: 2,
        jitterRatio: 0.1,
      }),
      getState: () => ({
        iterationsCompleted: 0,
        tokensConsumed: 0,
        consecutiveFailures: 0,
        totalFailures: 0,
        backoffLevel: 0,
      }),
    },
    maxIterations: 10,
    maxFixRounds: 3,
  };
}

test("F15. isEagBuildPrompt 对 /eag-build 命令返回 true（命令判定逻辑）", () => {
  // 验证：isEagBuildPrompt 能正确识别 /eag-build 命令
  // 通过构造 SessionManager 实例，调用其私有方法 isEagBuildPrompt
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
  // 通过 any 访问私有方法（与既有测试模式一致）
  const internal = manager as any;

  // 正确命令格式
  assert.equal(internal.isEagBuildPrompt({ text: "/eag-build" }), true);
  assert.equal(internal.isEagBuildPrompt({ text: "  /eag-build  " }), true);
  // 非命令格式
  assert.equal(internal.isEagBuildPrompt({ text: "请帮我执行 /eag-build" }), false);
  assert.equal(internal.isEagBuildPrompt({ text: "/eag-build arg" }), false);
  assert.equal(internal.isEagBuildPrompt({ text: "/eag-design" }), false);
  assert.equal(internal.isEagBuildPrompt({ text: undefined }), false);
  // 含图片或技能时不识别为命令（避免误触发）
  assert.equal(internal.isEagBuildPrompt({ text: "/eag-build", imageUrls: ["data:image/png;base64,..."] }), false);
  assert.equal(
    internal.isEagBuildPrompt({ text: "/eag-build", skills: [{ name: "test", path: "/", description: "" }] }),
    false
  );
});

test("F16. 未注入 codingOrchestrator 时 SessionManager 正常构造（向后兼容，§4.9.4）", () => {
  // 验证：未注入 codingOrchestrator / pkcAccessor 时 SessionManager 仍可正常构造
  // （向后兼容保证，V2 526 测试零回归，§4.9.4）
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    // 不传入 codingOrchestrator / pkcAccessor
  });

  assert.ok(manager instanceof SessionManager);
  // 验证未注入时字段为 undefined
  const internal = manager as any;
  assert.equal(internal.codingOrchestrator, undefined, "未注入时 codingOrchestrator 应为 undefined");
  assert.equal(internal.pkcAccessor, undefined, "未注入时 pkcAccessor 应为 undefined");
});

test("F17. 注入 codingOrchestrator / pkcAccessor 时字段正确传递（§4.9.3）", () => {
  // 验证：SessionManager 构造函数正确赋值 EAG-P2 批次 9 S5 新增字段
  const fakeOrchestrator = { run: () => ({}) } as any;
  const fakePkcAccessor = {
    queryL1GlobalView: () => ({}),
    searchL2: () => [],
    queryL3BusinessKnowledge: () => ({}),
  } as any;

  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    // EAG-P2 批次 9 S5 新增字段
    codingOrchestrator: fakeOrchestrator,
    pkcAccessor: fakePkcAccessor,
  });

  const internal = manager as any;
  assert.equal(internal.codingOrchestrator, fakeOrchestrator, "codingOrchestrator 字段应正确传递");
  assert.equal(internal.pkcAccessor, fakePkcAccessor, "pkcAccessor 字段应正确传递");
});

test("F18. handleEagBuildCommand 未注入 codingOrchestrator 时通知错误并标记 failed", async () => {
  // 验证 handleEagBuildCommand 的依赖校验逻辑（session.ts §handleEagBuildCommand 步骤 1）：
  // 未注入 codingOrchestrator → 通知用户配置缺失，更新 session 状态为 failed
  const messages: string[] = [];
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: (message: any) => messages.push(message.content),
    // 不注入 codingOrchestrator
  });

  // 通过 any 访问私有方法
  const internal = manager as any;

  // 调用 handleEagBuildCommand
  await internal.handleEagBuildCommand("test-session-id", { text: "/eag-build" }, new AbortController());

  // 验证：通知消息含"未注入"字样
  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("CODING Loop 编排器未注入")),
    `通知消息应含"CODING Loop 编排器未注入"，实际为：${messages.join("\n")}`
  );
});

test("F19. handleEagBuildCommand 未提供 CodingLoopRequest 时通知错误（§4.9.3）", async () => {
  // 验证 handleEagBuildCommand 的请求装配逻辑（session.ts §handleEagBuildCommand 步骤 2）：
  // 已注入 codingOrchestrator 但未通过 messageParams 提供 CodingLoopRequest → 通知用户配置缺失
  const fakeOrchestrator = { run: () => ({}) } as any;
  const fakePkcAccessor = {
    queryL1GlobalView: () => ({}),
    searchL2: () => [],
    queryL3BusinessKnowledge: () => ({}),
  } as any;
  const messages: string[] = [];

  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: (message: any) => messages.push(message.content),
    codingOrchestrator: fakeOrchestrator,
    pkcAccessor: fakePkcAccessor,
  });

  const internal = manager as any;
  // 不通过 messageParams 提供 CodingLoopRequest
  await internal.handleEagBuildCommand("test-session-id", { text: "/eag-build" }, new AbortController());

  // 验证：通知消息含"CodingLoopRequest 未提供"字样
  assert.ok(messages.length > 0, "应发送至少一条通知消息");
  assert.ok(
    messages.some((m) => m.includes("CodingLoopRequest 未提供")),
    `通知消息应含"CodingLoopRequest 未提供"，实际为：${messages.join("\n")}`
  );
});

test("F20. extractCodingLoopRequest 正确提取并校验 CodingLoopRequest 字段", () => {
  // 验证 extractCodingLoopRequest 的字段校验逻辑（session.ts §extractCodingLoopRequest）：
  // 1. messageParams 为 undefined/null → 返回 undefined
  // 2. messageParams.codingLoopRequest 缺失 → 返回 undefined
  // 3. messageParams.codingLoopRequest 字段不完整 → 返回 undefined
  // 4. messageParams.codingLoopRequest 字段完整 → 返回 CodingLoopRequest 对象
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
  const internal = manager as any;

  // 情况 1：messageParams 为 undefined
  assert.equal(internal.extractCodingLoopRequest({ text: "/eag-build" }), undefined);
  // 情况 1：messageParams 为 null
  assert.equal(internal.extractCodingLoopRequest({ text: "/eag-build", messageParams: null }), undefined);
  // 情况 1：messageParams 为空对象
  assert.equal(internal.extractCodingLoopRequest({ text: "/eag-build", messageParams: {} }), undefined);
  // 情况 2：codingLoopRequest 字段缺失
  assert.equal(internal.extractCodingLoopRequest({ text: "/eag-build", messageParams: { other: "value" } }), undefined);
  // 情况 3：codingLoopRequest 字段不完整（缺 projectRoot）
  assert.equal(
    internal.extractCodingLoopRequest({
      text: "/eag-build",
      messageParams: { codingLoopRequest: { specContent: "spec" } },
    }),
    undefined
  );
  // 情况 4：codingLoopRequest 字段完整 → 返回对象
  const validRequest = createMinimalCodingLoopRequestPlaceholder();
  const extracted = internal.extractCodingLoopRequest({
    text: "/eag-build",
    messageParams: { codingLoopRequest: validRequest },
  });
  assert.ok(extracted, "字段完整时应返回 CodingLoopRequest 对象");
  assert.equal(extracted.projectRoot, "/test/project");
  assert.equal(extracted.specContent, "spec");
  assert.equal(extracted.maxIterations, 10);
});

test("F21. renderCodingLoopResult 正确渲染结果摘要（§4.9.3）", () => {
  // 验证 renderCodingLoopResult 的渲染逻辑（session.ts §renderCodingLoopResult）：
  // 1. 包含最终状态
  // 2. 包含任务卡执行统计
  // 3. 包含任务卡执行明细
  // 4. 包含生成文件清单（前 10 个）
  // 5. 包含失败原因（若存在）
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: null, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
  const internal = manager as any;

  // 构造测试用 CodingLoopResult
  const result = Object.freeze({
    taskResults: Object.freeze([
      Object.freeze({
        taskCardId: "T-001",
        skeleton: { files: [], templateVariables: {}, fillPlaceholders: [], durationMs: 10 },
        fill: { filledFiles: [], fillStatus: [], llmCallCount: 1, totalTokensUsed: 100, durationMs: 20 },
        finalEvaluation: {
          verdict: "pass",
          redlineResults: [],
          blockerCount: 0,
          majorCount: 0,
          warningCount: 0,
          durationMs: 5,
        },
        status: "completed",
        iterations: 1,
      }),
    ]),
    allGeneratedFiles: Object.freeze([
      {
        relativePath: "src/domain/order/OrderAggregate.ts",
        content: "...",
        kind: "aggregate",
        taskId: "T-001",
        requirementId: "F-001",
      },
    ]),
    totalIterations: 1,
    totalLlmCallCount: 1,
    totalTokensUsed: 100,
    durationSec: 5,
    finalStatus: "completed",
    blockedReason: undefined,
  });

  const summary: string = internal.renderCodingLoopResult(result);

  // 验证渲染内容
  assert.ok(summary.includes("[EAG CODING Loop]"), "应包含标题");
  assert.ok(summary.includes("最终状态: completed"), "应包含最终状态");
  assert.ok(summary.includes("任务卡数: 1"), "应包含任务卡数量");
  assert.ok(summary.includes("T-001"), "应包含任务卡 ID");
  assert.ok(summary.includes("src/domain/order/OrderAggregate.ts"), "应包含生成文件路径");
  // blockedReason 为 undefined 时不应渲染终止原因
  assert.ok(!summary.includes("终止原因"), "blockedReason 为 undefined 时不应渲染终止原因");

  // 验证失败场景：含 blockedReason
  const failedResult = { ...result, finalStatus: "failed", blockedReason: "G-5 门禁失败" };
  const failedSummary: string = internal.renderCodingLoopResult(failedResult);
  assert.ok(failedSummary.includes("最终状态: failed"), "应渲染失败状态");
  assert.ok(failedSummary.includes("终止原因: G-5 门禁失败"), "应渲染终止原因");
});
