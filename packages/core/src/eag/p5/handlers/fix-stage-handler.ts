/**
 * EAG-P5 Phase 5.2 FixStageHandler（TASK-P5-1.2-007）
 *
 * 本模块实现 `P5FixStageHandler` 类，是 AutonomousOrchestrator 4 阶段循环
 * 的 fix 阶段处理器，负责"评估意见结构化回灌 + G-A3b 清理意图永禁"。
 *
 * 核心职责（对齐架构师审查 §3.1.3 + §4.1）：
 * 1. 从 prevResults 中查找 verify 阶段产出的失败结果
 * 2. 提取测试失败信息（失败数量、退出码、错误输出）
 * 3. 基于失败模式生成结构化修复建议（不直接执行修复，由 LLM 消费）
 * 4. 调用 guardChain.execute() 做 G-A3b 清理意图永禁预检
 *    （禁止 fix 阶段执行 rm/cleanup/git reset --hard 等清理操作）
 * 5. 返回修复建议作为 artifacts（供下一轮迭代的 plan/dev 阶段消费）
 *
 * 关键技术决策：
 * - 失败模式分析：基于错误输出关键词分类（assertion/import/timeout/syntax）
 * - 修复建议生成：基于失败模式生成结构化建议（不含具体代码）
 * - 清理意图永禁：检查 pendingCommand 是否含清理关键词（rm/cleanup/delete 等）
 * - 不执行修复：本 Handler 仅生成修复建议，不直接修改代码（LLM 职责）
 *
 * 修复建议结构：
 * ```typescript
 * {
 *   failureCategory: "assertion" | "import" | "timeout" | "syntax" | "unknown",
 *   failureSummary: "12 个测试失败，主要错误：期望 200 但得到 404",
 *   suggestedActions: ["检查路由配置", "验证 mock 数据", ...],
 *   filesToReview: ["src/services/OrderService.ts", ...],
 * }
 * ```
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 *
 * @module eag/p5/handlers/fix-stage-handler
 */

import type { P5StageContext, P5StageHandler, P5StageResult } from "./types";
import { buildGuardContext, createSuccessStageResult, createFailedStageResult, toGuardRecords } from "./types";
import type { TaskCard } from "../guards/types";

// ============================================================================
// 1. 常量定义
// ============================================================================

/**
 * 清理类关键词黑名单（G-A3b 清理意图永禁依据）
 *
 * fix 阶段禁止执行任何清理类操作，包括但不限于：
 * - rm / rmdir / unlink：文件删除
 * - cleanup / clean：清理
 * - git reset --hard / git clean：Git 清理
 * - drop / truncate：数据库清理
 * - kill / killall：进程清理
 */
const CLEANUP_KEYWORDS: ReadonlyArray<string> = Object.freeze([
  "\\brm\\b",
  "\\brmdir\\b",
  "\\bunlink\\b",
  "\\bcleanup\\b",
  "\\bclean\\b",
  "\\bgit\\s+reset\\s+--hard\\b",
  "\\bgit\\s+clean\\b",
  "\\bdrop\\b",
  "\\btruncate\\b",
  "\\bkill\\b",
  "\\bkillall\\b",
  "\\bformat\\b",
]);

/**
 * 预编译的清理类关键词正则数组（IGNORECASE）
 */
const CLEANUP_KEYWORDS_RE: ReadonlyArray<RegExp> = Object.freeze(CLEANUP_KEYWORDS.map((p) => new RegExp(p, "i")));

/**
 * 失败模式分类规则表（按优先级排序）
 *
 * 每条规则为 [关键词正则, 分类名称]，按顺序匹配，命中第一个即停止。
 */
const FAILURE_PATTERN_RULES: ReadonlyArray<Readonly<[RegExp, FixFailureCategory]>> = Object.freeze([
  // 断言失败：expected/actual/assertion/AssertionError
  [/\b(expected|actual|assertion|AssertionError)\b/i, "assertion"],
  // 导入失败：Cannot find module/ImportError/Module not found
  [/\b(Cannot\s+find\s+module|ImportError|Module\s+not\s+found)\b/i, "import"],
  // 超时：timeout/timed out
  [/\b(timeout|timed?\s+out)\b/i, "timeout"],
  // 语法错误：SyntaxError/Unexpected token
  [/\b(SyntaxError|Unexpected\s+token)\b/i, "syntax"],
  // 类型错误：TypeError/is not a function
  [/\b(TypeError|is\s+not\s+a\s+function)\b/i, "type"],
  // 引用错误：ReferenceError/is not defined
  [/\b(ReferenceError|is\s+not\s+defined)\b/i, "reference"],
]);

// ============================================================================
// 2. 类型定义
// ============================================================================

/**
 * 失败模式分类（6 类 + unknown）
 */
export type FixFailureCategory = "assertion" | "import" | "timeout" | "syntax" | "type" | "reference" | "unknown";

/**
 * 结构化修复建议
 */
export interface FixSuggestion {
  /** 失败模式分类 */
  readonly failureCategory: FixFailureCategory;
  /** 失败摘要（人类可读） */
  readonly failureSummary: string;
  /** 建议动作列表（人类可读，供 LLM 消费） */
  readonly suggestedActions: ReadonlyArray<string>;
  /** 待审查文件列表（来自任务卡 declaredFiles） */
  readonly filesToReview: ReadonlyArray<string>;
  /** 失败的测试数量 */
  readonly failedTestCount: number;
  /** 测试退出码 */
  readonly testExitCode: number;
  /** 失败输出摘要（前 N 字符） */
  readonly failureOutputSnippet: string;
}

// ============================================================================
// 3. P5FixStageHandler 类
// ============================================================================

/**
 * Fix 阶段处理器
 *
 * 设计原则（对 align Karpathy Simplicity First + Ponytail 红线）：
 *   1. 单一职责：仅做"失败分析 + 修复建议生成"，不执行代码修改
 *   2. 清理意图永禁：检查 pendingCommand 是否含清理关键词（G-A3b）
 *   3. 结构化回灌：修复建议为结构化对象，供 LLM 消费
 *   4. 不可变产出：返回的 P5StageResult 为冻结对象
 *
 * 使用方式：
 * ```typescript
 * const handler = new P5FixStageHandler();
 * const result = await handler.handle(ctx);
 * if (result.kind === "success") {
 *   const suggestion = result.artifacts["fixSuggestion"] as FixSuggestion;
 *   // LLM 消费 suggestion 生成具体修复代码
 * }
 * ```
 */
export class P5FixStageHandler implements P5StageHandler {
  /**
   * 执行 fix 阶段处理
   *
   * 完整时序：
   * 1. 从 prevResults 中查找 verify 阶段的失败结果
   * 2. 若无失败结果 → 返回 success（无需修复，可能 verify 已通过）
   * 3. 提取测试失败信息（testStats + completionEvidence）
   * 4. 分析失败模式（FAILURE_PATTERN_RULES）
   * 5. 生成结构化修复建议（FixSuggestion）
   * 6. 调用 guardChain.execute() 做 G-A3b 清理意图永禁预检
   * 7. 护栏 DENY → 返回 fatal（清理意图被拦截）
   * 8. 护栏 ASK → 返回 failed（需用户确认）
   * 9. 护栏 PASS → 返回 success + 修复建议
   *
   * @param ctx 阶段执行上下文
   * @returns 阶段执行结果
   */
  async handle(ctx: Readonly<P5StageContext>): Promise<Readonly<P5StageResult>> {
    const startTime = Date.now();

    try {
      // 1. 从 prevResults 中查找 verify 阶段的失败结果
      const verifyResult = findVerifyFailure(ctx);

      // 2. 若无失败结果 → 返回 success（无需修复）
      if (verifyResult === null) {
        return createSuccessStageResult(
          "fix",
          "无需修复（verify 阶段已通过或无测试结果）",
          {
            fixSuggestion: null,
            reason: "no-verify-failure",
          },
          [],
          0,
          Date.now() - startTime
        );
      }

      // 3. 提取测试失败信息
      const testStats = verifyResult.artifacts["testStats"] as
        | { readonly passed: number; readonly failed: number; readonly skipped: number; readonly total: number }
        | undefined;
      const evidence = verifyResult.artifacts["completionEvidence"] as
        | { readonly testExitCode: number; readonly testOutputSummary: string }
        | undefined;
      const cmdResult = verifyResult.artifacts["commandResult"] as
        | { readonly exitCode: number | null; readonly timedOut: boolean }
        | undefined;

      const failedCount = testStats?.failed ?? 0;
      const exitCode = evidence?.testExitCode ?? cmdResult?.exitCode ?? -1;
      const outputSummary = evidence?.testOutputSummary ?? verifyResult.error ?? "";

      // 4. 分析失败模式
      const failureCategory = analyzeFailureCategory(outputSummary);

      // 5. 生成结构化修复建议
      const taskCard = extractTaskCardFromPrevResults(ctx);
      const filesToReview = taskCard?.declaredFiles ?? [];

      const suggestedActions = generateSuggestedActions(failureCategory, outputSummary, filesToReview);

      const fixSuggestion: FixSuggestion = Object.freeze({
        failureCategory,
        failureSummary: `${failedCount} 个测试失败（exitCode=${exitCode}）`,
        suggestedActions: Object.freeze([...suggestedActions]),
        filesToReview: Object.freeze([...filesToReview]),
        failedTestCount: failedCount,
        testExitCode: exitCode,
        failureOutputSnippet: outputSummary.slice(0, 500),
      });

      // 6. 调用 guardChain.execute() 做 G-A3b 清理意图永禁预检
      //    检查 pendingCommand 是否含清理关键词
      const pendingCommand = extractPendingCommand(ctx);
      const hasCleanupIntent = pendingCommand ? detectCleanupIntent(pendingCommand) : false;

      const guardContext = buildGuardContext(ctx, {
        currentTaskCard: taskCard ?? undefined,
        pendingCommand,
      });

      const chainResult = await ctx.guardChain.execute(guardContext);
      const guardRecords = toGuardRecords(chainResult, ctx.iterIndex, "fix", ctx.loopType);

      // 7. 清理意图命中 → 返回 fatal（G-A3b BLOCKER）
      if (hasCleanupIntent) {
        return createFailedStageResult(
          "fix",
          "fatal",
          `清理意图被拦截（G-A3b）：命令 "${pendingCommand}" 含清理关键词`,
          `fix 阶段禁止执行清理类操作（rm/cleanup/git reset --hard 等）`,
          {
            fixSuggestion,
            pendingCommand,
            guardRuleId: "G-A3b",
            guardDecision: "DENY",
          },
          guardRecords,
          0,
          Date.now() - startTime
        );
      }

      // 8. 护栏 DENY → 返回 fatal
      if (chainResult.overallDecision === "DENY") {
        const firstDenial = chainResult.firstDenial;
        return createFailedStageResult(
          "fix",
          "fatal",
          `fix 阶段护栏拒绝（规则 ${firstDenial?.ruleId ?? "unknown"}）`,
          firstDenial?.reason ?? "未知原因",
          {
            fixSuggestion,
            guardDecision: "DENY",
            guardRuleId: firstDenial?.ruleId ?? "",
          },
          guardRecords,
          0,
          Date.now() - startTime
        );
      }

      // 9. 护栏 ASK → 返回 failed
      if (chainResult.overallDecision === "ASK") {
        const firstAsk = chainResult.triggeredGuards.find((v) => v.decision === "ASK");
        return createFailedStageResult(
          "fix",
          "failed",
          `fix 阶段护栏需确认（规则 ${firstAsk?.ruleId ?? "unknown"}）`,
          firstAsk?.reason ?? "需用户确认",
          {
            fixSuggestion,
            guardDecision: "ASK",
            guardRuleId: firstAsk?.ruleId ?? "",
          },
          guardRecords,
          0,
          Date.now() - startTime
        );
      }

      // 10. 护栏 PASS → 返回 success + 修复建议
      return createSuccessStageResult(
        "fix",
        `fix 阶段完成：失败分析（${failureCategory}），生成 ${suggestedActions.length} 条修复建议`,
        {
          fixSuggestion,
          failureCategory,
          failedTestCount: failedCount,
          guardDecision: "PASS",
        },
        guardRecords,
        0,
        Date.now() - startTime
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return createFailedStageResult(
        "fix",
        "fatal",
        `fix 阶段异常：${error.message}`,
        error.stack ?? error.message,
        {},
        [],
        0,
        Date.now() - startTime
      );
    }
  }

  // ========================================================================
  // 内部辅助方法
  // ========================================================================

  /**
   * 获取清理类关键词数量（用于测试断言与可观测性）
   *
   * @returns 清理类关键词正则数量
   */
  getCleanupKeywordCount(): number {
    return CLEANUP_KEYWORDS_RE.length;
  }
}

// ============================================================================
// 4. 失败分析器
// ============================================================================

/**
 * 分析失败模式分类
 *
 * 基于错误输出关键词分类，按优先级匹配：
 * 1. assertion（断言失败）
 * 2. import（导入失败）
 * 3. timeout（超时）
 * 4. syntax（语法错误）
 * 5. type（类型错误）
 * 6. reference（引用错误）
 * 7. unknown（未分类）
 *
 * @param output 测试输出（stdout + stderr 摘要）
 * @returns 失败模式分类
 */
export function analyzeFailureCategory(output: string): FixFailureCategory {
  if (!output) return "unknown";

  for (const [pattern, category] of FAILURE_PATTERN_RULES) {
    if (pattern.test(output)) {
      return category;
    }
  }

  return "unknown";
}

/**
 * 生成修复建议动作列表
 *
 * 基于失败模式生成结构化建议，供 LLM 消费生成具体修复代码。
 *
 * @param category 失败模式分类
 * @param output 失败输出
 * @param filesToReview 待审查文件列表
 * @returns 建议动作列表
 */
function generateSuggestedActions(
  category: FixFailureCategory,
  output: string,
  filesToReview: ReadonlyArray<string>
): string[] {
  const actions: string[] = [];

  switch (category) {
    case "assertion":
      actions.push("检查断言期望值与实际值是否一致");
      actions.push("验证 mock 数据是否与真实数据结构匹配");
      actions.push("检查测试用例的业务逻辑是否正确");
      break;
    case "import":
      actions.push("检查模块路径是否正确（相对路径/绝对路径）");
      actions.push("验证依赖包是否已安装（package.json）");
      actions.push("检查 TypeScript 路径映射（tsconfig.json paths）");
      break;
    case "timeout":
      actions.push("检查异步操作是否正确 await");
      actions.push("验证网络请求是否设置了合理超时");
      actions.push("检查是否存在死循环或无限递归");
      break;
    case "syntax":
      actions.push("检查语法错误位置（行号/列号）");
      actions.push("验证括号/引号是否匹配");
      actions.push("检查 TypeScript 类型注解是否正确");
      break;
    case "type":
      actions.push("检查函数参数类型是否匹配");
      actions.push("验证对象属性是否存在");
      actions.push("检查 undefined/null 处理");
      break;
    case "reference":
      actions.push("检查变量是否已声明");
      actions.push("验证作用域是否正确（let/const/var）");
      actions.push("检查模块导出/导入是否匹配");
      break;
    default:
      actions.push("检查测试输出的错误详情");
      actions.push("验证测试环境配置是否正确");
      break;
  }

  // 通用建议
  if (filesToReview.length > 0) {
    actions.push(`审查以下文件：${filesToReview.join(", ")}`);
  }
  actions.push("检查最近的代码改动是否引入回归");

  return actions;
}

// ============================================================================
// 5. 清理意图检测器（G-A3b）
// ============================================================================

/**
 * 检测命令是否含清理意图
 *
 * 基于清理类关键词黑名单（CLEANUP_KEYWORDS_RE）匹配。
 * 命中任一关键词即返回 true（清理意图被拦截）。
 *
 * @param command 待检测的命令字符串
 * @returns true=含清理意图；false=无清理意图
 */
export function detectCleanupIntent(command: string): boolean {
  if (!command || !command.trim()) return false;
  const cmdStripped = command.trim();
  return CLEANUP_KEYWORDS_RE.some((re) => re.test(cmdStripped));
}

// ============================================================================
// 6. 辅助函数
// ============================================================================

/**
 * 从 prevResults 中查找 verify 阶段的失败结果
 *
 * 查找规则：从 prevResults 末尾向前查找第一个 stage === "verify" 且 kind !== "success" 的结果。
 *
 * @param ctx 阶段执行上下文
 * @returns 失败的 verify 阶段结果（若无则返回 null）
 */
function findVerifyFailure(ctx: Readonly<P5StageContext>): Readonly<P5StageResult> | null {
  for (let i = ctx.prevResults.length - 1; i >= 0; i--) {
    const result = ctx.prevResults[i]!;
    if (result.stage === "verify" && result.kind !== "success") {
      return result;
    }
  }
  return null;
}

/**
 * 从 prevResults 中提取 plan 阶段产出的任务卡
 *
 * @param ctx 阶段执行上下文
 * @returns 任务卡（若无则返回 null）
 */
function extractTaskCardFromPrevResults(ctx: Readonly<P5StageContext>): TaskCard | null {
  for (let i = ctx.prevResults.length - 1; i >= 0; i--) {
    const result = ctx.prevResults[i]!;
    if (result.stage === "plan" && result.kind === "success") {
      const taskCard = result.artifacts["taskCard"];
      if (taskCard && typeof taskCard === "object") {
        return taskCard as TaskCard;
      }
    }
  }
  return null;
}

/**
 * 从上下文中提取待执行命令（用于 G-A3b 清理意图检测）
 *
 * 当前实现：从 notesSnapshot 中解析最近一条命令（以 "$ " 或 "> " 开头的行）。
 * 若无则返回空字符串（不检测）。
 *
 * @param ctx 阶段执行上下文
 * @returns 待执行命令（若无则返回空字符串）
 */
function extractPendingCommand(ctx: Readonly<P5StageContext>): string {
  // 从 notesSnapshot 中查找命令行
  const lines = ctx.notesSnapshot.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    // 匹配 "$ command" 或 "> command" 格式
    const match = /^[$>]\s+(.+)$/.exec(line);
    if (match) {
      return match[1]!.trim();
    }
  }
  return "";
}

// ============================================================================
// 7. 工厂函数
// ============================================================================

/**
 * 工厂函数：创建默认 P5FixStageHandler 实例
 *
 * @returns P5FixStageHandler 实例
 */
export function createFixStageHandler(): P5FixStageHandler {
  return new P5FixStageHandler();
}
