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
 *   failedTestIds: ["tests/test_x.py::test_y", ...],   // 失败用例标识（2026-11-03 新增）
 *   failureOutputSnippet: "...(失败窗口优先摘要)",      // 失败窗口 + 尾部统计，非 head-only
 *   suggestedActions: ["检查路由配置", "验证 mock 数据", ...],
 *   filesToReview: ["src/services/OrderService.ts", ...],  // 上限 20 条
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
import { buildTestOutputSummary, extractFailedTestIds } from "./test-output-analysis";

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
 * fix 阶段结果原因码（方案 A §3.5）。
 */
/** 任务执行器未绑定：有 verify 失败却无法真实修复，fail-closed 判 failed */
export const FIX_REASON_TASK_EXECUTOR_NOT_BOUND = "fix-task-executor-not-bound" as const;
/** fix 经执行器真实执行且到达终态 */
export const FIX_REASON_TASK_EXECUTED = "fix-task-executed" as const;
/** fix 执行器返回失败 */
export const FIX_REASON_TASK_EXECUTION_FAILED = "fix-task-execution-failed" as const;
/** verify 失败但上下文中找不到任务卡（状态不一致，无法定位修复目标） */
export const FIX_REASON_TASK_CARD_MISSING = "fix-task-card-missing" as const;

/** 基线脏路径未注入时的默认空集（统计口径统一用，避免每次构造）。 */
const EMPTY_PATH_SET: ReadonlySet<string> = new Set<string>();

/** 回灌给执行器的失败输出片段最大字符数（2026-11-03：500 → 2000）
 *
 *  原因（run b64490b8ad78 事故）：真实 runner 的失败详情在输出尾部，
 *  旧值 500 只能拿到头部进度点，模型无从定位失败用例，两轮修复产出相同实现
 *  → 相同失败 → 确定性熔断。现改为与 verify 证据同源的"失败窗口优先"摘要，
 *  长度上限与 CompletionEvidence.testOutputSummary 对齐（2000）。
 */
const FIX_FEEDBACK_SNIPPET_CHARS = 2000;

/** 回灌给执行器的"待审查文件"清单最大条数（防止超长 declaredFiles 淹没提示词） */
const FIX_FEEDBACK_MAX_FILES = 20;

/**
 * 失败模式分类规则表（按优先级排序）
 *
 * 每条规则为 [关键词正则, 分类名称]，按顺序匹配，命中第一个即停止。
 */
const FAILURE_PATTERN_RULES: ReadonlyArray<Readonly<[RegExp, FixFailureCategory]>> = Object.freeze([
  // 环境/前置条件缺失（2026-11-03 新增）：二进制、依赖、容器挂载缺失时，
  // 断言只是表象，盲改业务代码永远修不好（run b64490b8ad78 的 LinearDesign 集成即此类）。
  [
    // 说明：ASCII 关键词用 \b 限定词边界；中文关键词不能用 \b（JS 里中文不是 word 字符，
    // "缺失" 两侧加 \b 会永不命中），因此中英文分开写在同一条交替式里。
    /\b(?:ENOENT|No such file or directory|command not found|ModuleNotFoundError)\b|未安装|缺失|找不到可执行/i,
    "environment",
  ],
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
 * 失败模式分类（7 类 + unknown）
 */
export type FixFailureCategory =
  | "environment"
  | "assertion"
  | "import"
  | "timeout"
  | "syntax"
  | "type"
  | "reference"
  | "unknown";

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
  /** 待审查文件列表（来自任务卡 declaredFiles，已按上限截断） */
  readonly filesToReview: ReadonlyArray<string>;
  /** 任务卡声明文件总数（截断前） */
  readonly declaredFileTotal: number;
  /** 失败的测试数量 */
  readonly failedTestCount: number;
  /** 测试退出码 */
  readonly testExitCode: number;
  /** 失败用例标识（pytest FAILED / unittest FAIL: / jest ✕ / mocha N) / TAP not ok） */
  readonly failedTestIds: ReadonlyArray<string>;
  /** 识别到的失败用例总数（可能大于 failedTestIds.length） */
  readonly failedTestTotal: number;
  /** 失败输出片段（失败窗口优先摘取，≤ FIX_FEEDBACK_SNIPPET_CHARS） */
  readonly failureOutputSnippet: string;
  /**
   * 本轮是否"全部失败均为 run 起始既有红灯、无本任务新增失败"（2026-11-08 修复指令链路）。
   * true 时 buildFixFeedback 改为"与本任务无关、无需改代码"标注，不再让模型去修基线用例。
   */
  readonly baselineOnly?: boolean;
  /** 失败用例清单是否来自 verify 的基线/新增拆分（true=仅含本任务新增失败）。 */
  readonly failedIdsSplitApplied?: boolean;
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
        // R4（2026-10-20，run 68acea2de182 报告误导修复）：dev 阶段本轮失败时，
        // "无需修复（verify 阶段已通过或无测试结果）"是误导性 ✓——读者会以为
        // 失败已被 fix 处理过。fix 的修复对象只有 verify（测试）失败，对 dev
        // 失败的正确语义是 skip：如实说明跳过原因，不谎称"已通过"。
        const devFailure = findDevFailure(ctx);
        if (devFailure !== null) {
          return createSuccessStageResult(
            "fix",
            `跳过修复：dev 阶段本轮执行失败（${devFailure.summary.slice(0, 120)}），` +
              `无测试失败可分析——修复方向由下一轮 plan 的跨 run 失败记忆承接`,
            {
              fixSuggestion: null,
              reason: "dev-failed-no-verify-failure",
              devFailed: true,
            },
            [],
            0,
            Date.now() - startTime
          );
        }
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
      // 证据来源优先级（架构评审 B7）：
      //   1) verify 新增的 artifacts.testOutputTail（原始尾部，可在摘要被前人截断时自愈）；
      //   2) completionEvidence.testOutputSummary（已是失败窗口摘要）；
      //   3) verify 的 error 文本（最后兜底）。
      const rawTail = verifyResult.artifacts["testOutputTail"];
      const outputSummary =
        typeof rawTail === "string" && rawTail.length > 0
          ? rawTail
          : (evidence?.testOutputSummary ?? verifyResult.error ?? "");

      // 4. 分析失败模式（环境/断言/导入/超时/语法/类型/引用）
      const failureCategory = analyzeFailureCategory(outputSummary);

      // 4.5 失败证据：摘要仍用"失败窗口优先"重建（testOutputTail 仅作失败窗口摘要输入）；
      //     失败用例清单改为优先消费 verify 的基线/新增拆分结果（结构化），不再把
      //     从原始输出重新解析的全量清单作为优先来源（2026-11-08 修复指令链路贯通）。
      const failureSnippet = buildTestOutputSummary(outputSummary, FIX_FEEDBACK_SNIPPET_CHARS);
      const resolvedFailureIds = resolveFixFailureIds(ctx, verifyResult, outputSummary);

      // 5. 生成结构化修复建议
      const taskCard = extractTaskCardFromPrevResults(ctx);
      const declaredFiles = taskCard?.declaredFiles ?? [];
      // 文件清单：失败用例所在测试文件优先，其后按任务卡声明顺序，上限 20 条
      // （事故任务卡声明 249 个文件，直接灌进提示词会把失败证据淹没）
      const filesToReview = prioritizeDeclaredFiles(declaredFiles, resolvedFailureIds.ids, FIX_FEEDBACK_MAX_FILES);

      const suggestedActions = generateSuggestedActions(failureCategory, outputSummary);

      const fixSuggestion: FixSuggestion = Object.freeze({
        failureCategory,
        failureSummary: `${failedCount} 个测试失败（exitCode=${exitCode}）`,
        suggestedActions: Object.freeze([...suggestedActions]),
        filesToReview: Object.freeze([...filesToReview]),
        declaredFileTotal: declaredFiles.length,
        failedTestCount: failedCount,
        testExitCode: exitCode,
        failedTestIds: resolvedFailureIds.ids,
        failedTestTotal: resolvedFailureIds.total,
        failureOutputSnippet: failureSnippet,
        baselineOnly: resolvedFailureIds.baselineOnly,
        failedIdsSplitApplied: resolvedFailureIds.splitApplied,
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

      // 10. 护栏 PASS → 带失败反馈真实修复（方案 A §3.5：原"仅生成建议即 success"属空转，删除）

      // 10.1 缺少任务卡：无法定位修复目标，诚实判 failed（建议仍保留在制品中供诊断）
      if (taskCard === null) {
        return createFailedStageResult(
          "fix",
          "failed",
          "verify 失败但上下文中缺少任务卡，无法执行修复",
          "fix 阶段未能从 plan 结果中提取任务卡",
          {
            fixSuggestion,
            reason: FIX_REASON_TASK_CARD_MISSING,
            guardDecision: "PASS",
          },
          guardRecords,
          0,
          Date.now() - startTime
        );
      }

      // 10.2 执行器未绑定 → fail-closed（建议保留，但不得宣告修复成功）
      const taskExecutor = ctx.taskExecutor ?? null;
      if (taskExecutor === null) {
        return createFailedStageResult(
          "fix",
          "failed",
          `任务执行器未绑定（任务 ${taskCard.id}），无法真实修复`,
          "P5TaskExecutor 未注入：fix 阶段不能只输出建议即宣告成功",
          {
            fixSuggestion,
            reason: FIX_REASON_TASK_EXECUTOR_NOT_BOUND,
            guardDecision: "PASS",
          },
          guardRecords,
          0,
          Date.now() - startTime
        );
      }

      // 10.3 构造结构化反馈（失败分类/退出码/输出片段/建议动作），交执行器带反馈再执行
      const feedback = buildFixFeedback(fixSuggestion);
      const execution = await taskExecutor.executeTask({
        projectRoot: ctx.projectRoot,
        runId: ctx.runId,
        iterIndex: ctx.iterIndex,
        stage: "fix",
        objective: ctx.objective,
        taskId: taskCard.id,
        taskTitle: taskCard.title,
        acceptanceCriteria: taskCard.acceptanceCriteria,
        feedback,
        abortFlagPath: ctx.abortFlagPath ?? "",
        // 停止修复（2026-10-22）：宿主信号透传执行器（abort 即时打断 in-flight 请求）
        signal: ctx.signal,
        // 运行剩余预算透传（2026-10-08 T-009/T-010 事故修复）：执行器每轮增量检查，
        // 把单阶段超烧窗口从"整轮迭代"收窄到"单轮请求"；fixtures 未注入时 undefined
        perTaskBudget: ctx.perTaskBudget,
      });

      if (!execution.success) {
        return createFailedStageResult(
          "fix",
          "failed",
          `任务 ${taskCard.id} 修复执行失败：${execution.error ?? "未知原因"}`,
          execution.error ?? "任务执行器返回 success=false 且未提供错误原因",
          {
            fixSuggestion,
            reason: FIX_REASON_TASK_EXECUTION_FAILED,
            guardDecision: "PASS",
            execution: Object.freeze({ ...execution }),
            llmRequests: execution.llmRequests,
          },
          guardRecords,
          execution.tokensUsed,
          Date.now() - startTime
        );
      }

      // 10.4 修复执行到达终态（是否真正修好由下一轮 verify 真实测试裁定，本阶段不宣告测试通过）
      // 统计口径统一（2026-11-08）：与 dev handler 同口径，把执行器报出的"全量工作区
      // 变更文件"过滤成"本次产出"（排除 run 起始既有脏文件），文案/artifacts 一致。
      const baselineDirtyPaths = ctx.baselineDirtyPaths ?? EMPTY_PATH_SET;
      const workspaceChangedFilesTotal = execution.changedFiles.length;
      const thisRunChangedFiles = execution.changedFiles.filter((p) => !baselineDirtyPaths.has(p));
      const excludedWorkspaceFiles = workspaceChangedFilesTotal - thisRunChangedFiles.length;

      return createSuccessStageResult(
        "fix",
        `任务 ${taskCard.id} 已带失败反馈执行修复（本次产出 ${thisRunChangedFiles.length} 个文件；` +
          `工作区既有 ${excludedWorkspaceFiles} 个未计入，${execution.llmRequests} 次 LLM 请求）`,
        {
          fixSuggestion,
          reason: FIX_REASON_TASK_EXECUTED,
          failureCategory,
          failedTestCount: failedCount,
          guardDecision: "PASS",
          execution: Object.freeze({ ...execution }),
          // P2 状态机（2026-11-08）：标记本轮 fix 已成功应用 + 修复的任务卡 ID，
          // orchestrator 据此在下一轮 plan 选中同一张 pending 卡时跳过 dev 整卡重跑。
          fixApplied: true,
          fixTaskCardId: taskCard.id,
          changedFiles: Object.freeze([...thisRunChangedFiles]),
          // 审计字段：执行器报出的全量工作区变更数（未过滤）
          workspaceChangedFilesTotal,
          llmRequests: execution.llmRequests,
          // 空转透传（2026-10-07）：执行器检出"模型零工具调用 + 零文件变更"时为 true，
          // 编排器据此计入 consecutiveNoopIterations 空转熔断
          noop: execution.noop === true,
          tokensEstimated: execution.tokensEstimated,
          executionSummary: execution.summary,
        },
        guardRecords,
        execution.tokensUsed,
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

/** resolveFixFailureIds 的结果：给 fix 执行器的失败用例清单 + 拆分语义。 */
interface FixFailureIds {
  /** 失败用例标识清单（可拆分时仅含本任务新增失败；降级时为全量） */
  readonly ids: ReadonlyArray<string>;
  /** 识别到的失败用例总数（可能大于 ids.length） */
  readonly total: number;
  /** 本轮是否纯基线失败（无本任务新增失败） */
  readonly baselineOnly: boolean;
  /** ids 是否来自 verify 的基线/新增拆分（true=已排除基线用例） */
  readonly splitApplied: boolean;
}

/** 把 unknown 值安全转为冻结的字符串数组（非数组返回 undefined）。 */
function toOptionalStringArray(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  return Object.freeze((value as ReadonlyArray<unknown>).filter((v): v is string => typeof v === "string"));
}

/**
 * 解析"给 fix 执行器的失败用例清单"（2026-11-08 修复指令链路贯通）。
 *
 * 数据源优先级：
 * 1) orchestrator 投影到 ctx 的本轮 verify 拆分结果（verifyNewFailedTestIds /
 *    verifyBaselineAvailable / verifyBaselineOnly / verifyFailedTestIds）；
 * 2) 缺失时回退本轮 verify 失败结果 artifacts（fixtures 直接构造 handler 的路径）；
 * 3) 两者都无结构化清单时，才从 outputSummary 重新解析（旧 fixtures / 旧 verify 结果）。
 * 即 testOutputTail 只作失败窗口摘要输入，不再作为用例标识来源的优先项。
 *
 * 判定（与 verify-stage-handler 的 canSplit 同构）：
 * - baselineOnly（全部失败均为 run 起始既有红灯、无本任务新增失败）→ 用例清单为空，
 *   feedback 走"无需改代码"标注分支，绝不把基线用例交给执行器；
 * - 可拆分（基线可信 && 本轮真实提取到了用例标识 && 拿到了新增清单数组）→
 *   只返回新增清单（已排除基线用例）；
 * - 否则**诚实降级**回退全量，不排除任何失败，绝不因修复而丢信息。
 */
function resolveFixFailureIds(
  ctx: Readonly<P5StageContext>,
  verifyResult: Readonly<P5StageResult>,
  outputSummary: string
): FixFailureIds {
  const art = verifyResult.artifacts;
  const fullIds = toOptionalStringArray(ctx.verifyFailedTestIds) ?? toOptionalStringArray(art["failedTestIds"]);
  const newIds = toOptionalStringArray(ctx.verifyNewFailedTestIds) ?? toOptionalStringArray(art["newFailedTestIds"]);
  const baselineAvailable = ctx.verifyBaselineAvailable ?? art["baselineAvailable"] === true;
  const baselineOnly = (ctx.verifyBaselineOnly ?? art["baselineOnly"]) === true;
  const structuredTotal = typeof art["failedTestTotal"] === "number" ? (art["failedTestTotal"] as number) : 0;

  // 降级时 newFailedTestIds 为空数组；绝不能用它替换全量，否则会变成
  // "测试失败但反馈里没有任何失败用例"。必须同时确认基线可信 + 有全量标识 +
  // 拿到了拆分后的新增清单数组，才允许使用新增清单。
  const canSplit = baselineAvailable && fullIds !== undefined && fullIds.length > 0 && newIds !== undefined;

  if (baselineOnly && canSplit) {
    return { ids: Object.freeze([]), total: 0, baselineOnly: true, splitApplied: true };
  }
  if (canSplit) {
    return { ids: newIds!, total: newIds!.length, baselineOnly: false, splitApplied: true };
  }

  // 诚实降级：不排除任何失败。优先结构化全量清单，缺失时从原始输出重新解析。
  const parsed = extractFailedTestIds(outputSummary);
  const ids = fullIds ?? parsed.ids;
  return {
    ids,
    total: fullIds !== undefined ? Math.max(structuredTotal, ids.length) : parsed.total,
    baselineOnly: false,
    splitApplied: false,
  };
}

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
 * 文件清单不在建议里重复（反馈文本已单列"任务卡声明文件"），避免重复稀释提示词。
 *
 * @param category 失败模式分类
 * @param output 失败输出
 * @returns 建议动作列表
 */
function generateSuggestedActions(category: FixFailureCategory, output: string): string[] {
  const actions: string[] = [];

  switch (category) {
    case "environment":
      actions.push("先确认失败用例依赖的可执行文件/依赖/挂载项是否真实存在（whereis / ls / 容器内 PATH）");
      actions.push("环境不可用时按项目约定提供跳过或明确失败提示，不要改断言把失败掩盖成通过");
      actions.push("若属容器内依赖缺失，补 Dockerfile/依赖声明或给出可复现的安装步骤");
      break;
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
  actions.push("检查最近的代码改动是否引入回归");

  return actions;
}

/**
 * 组装"待审查文件"清单：失败用例所在测试文件优先，其后按任务卡声明顺序补齐。
 *
 * pytest 风格的失败用例标识含文件路径（`tests/test_x.py::test_y`），
 * 把这类文件排到最前可让 fix 模型先看失败点；其余声明文件按原顺序补齐。
 *
 * @param declaredFiles 任务卡声明文件（原始顺序）
 * @param failedTestIds 失败用例标识
 * @param limit 返回上限
 * @returns 去重后的文件清单（≤ limit 条）
 */
function prioritizeDeclaredFiles(
  declaredFiles: ReadonlyArray<string>,
  failedTestIds: ReadonlyArray<string>,
  limit: number
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  // 1. 失败用例所在文件（标识形如 `path/to/test_x.py::case`）
  for (const id of failedTestIds) {
    const candidate = id.split("::")[0]?.trim() ?? "";
    if (candidate.length === 0 || !/\.[A-Za-z0-9]+$/.test(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    ordered.push(candidate);
    if (ordered.length >= limit) return ordered;
  }

  // 2. 任务卡声明文件（跳过已在列表中的）
  for (const file of declaredFiles) {
    if (ordered.length >= limit) break;
    if (seen.has(file)) continue;
    seen.add(file);
    ordered.push(file);
  }
  return ordered;
}

/**
 * 把结构化修复建议组装为回灌执行器的反馈文本（方案 A §3.5）。
 *
 * 反馈包含：失败分类、失败测试数、退出码、**失败用例清单**、失败输出片段（≤2000 字）、
 * 建议动作、任务卡声明文件（≤20 条）。执行器把该文本放入 fix 轮 user 提示词，
 * 模型据此真实修改代码。
 *
 * 2026-11-03 修复（run b64490b8ad78 事故）：
 * - 新增"失败用例"段落：明确列出失败用例标识，模型无需再从进度点里猜；
 * - 失败输出不再 head-slice 500 字符，改用失败窗口摘要（尾部断言/堆栈可见）；
 * - 文件清单超限时标注总数，避免"249 条文件"淹没失败证据。
 *
 * @param suggestion 结构化修复建议
 * @returns 多行反馈文本
 */
function buildFixFeedback(suggestion: Readonly<FixSuggestion>): string {
  // 纯基线失败（2026-11-08 修复指令链路贯通）：本轮全部失败均为 run 起始既有红灯，
  // 与本任务无关、无本任务新增失败。不给执行器喂用例清单 / 输出片段 / 建议动作，
  // 避免诱导模型去"修"这些既有红灯（修了也不会让本任务更正确）。
  // 注意：这是"修复指令"文本，verify 阶段本身仍如实判 failed，不伪造通过。
  if (suggestion.baselineOnly === true) {
    return [
      "本轮 verify 阶段全部失败均为 run 起始既有红灯（与本任务无关、无本任务新增失败）：",
      "无需据此修改代码，也不要为这些既有红灯改动本任务实现；",
      "请继续推进本任务本身的实现与验证，基线红灯的单独修复不属于本次任务范围。",
    ].join("\n");
  }

  const lines: string[] = [
    `失败分类：${suggestion.failureCategory}`,
    `失败测试数：${suggestion.failedTestCount}`,
    `测试退出码：${suggestion.testExitCode}`,
  ];

  // 失败用例清单：fix 的第一优先级是定位并复跑这些用例。
  // 清单来自基线/新增拆分时显式标注"仅新增失败"，让模型不误以为还有基线用例要修。
  if (suggestion.failedTestIds.length > 0) {
    const heading =
      suggestion.failedIdsSplitApplied === true
        ? "失败用例（以下为与本任务相关的新增失败，请优先定位并复跑这些用例，修改后自证其通过）："
        : "失败用例（请优先定位并复跑这些用例，修改后自证其通过）：";
    lines.push("", heading);
    for (const id of suggestion.failedTestIds) {
      lines.push(`- ${id}`);
    }
    if (suggestion.failedTestTotal > suggestion.failedTestIds.length) {
      lines.push(`- …（共 ${suggestion.failedTestTotal} 个失败用例，以上为前 ${suggestion.failedTestIds.length} 个）`);
    }
  }

  lines.push("", "失败输出：", suggestion.failureOutputSnippet || "（无输出摘要）");

  if (suggestion.suggestedActions.length > 0) {
    lines.push("", "参考修复方向（需结合代码实际情况判断，不要机械照做）：");
    for (const action of suggestion.suggestedActions) {
      lines.push(`- ${action}`);
    }
  }
  if (suggestion.filesToReview.length > 0) {
    const truncatedHint =
      suggestion.declaredFileTotal > suggestion.filesToReview.length
        ? `（共 ${suggestion.declaredFileTotal} 个，以上为前 ${suggestion.filesToReview.length} 个）`
        : "";
    lines.push("", `任务卡声明文件${truncatedHint}：${suggestion.filesToReview.join(", ")}`);
  }
  return lines.join("\n");
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
 * 结果 → 所属迭代轮次的映射（WeakMap 侧表）
 *
 * 背景（2026-10-05 僵尸任务卡死循环修复）：编排路径的 fix 阶段必须只认
 * **本轮**的 verify 失败——旧实现无限向前扫描 prevResults，后续轮 plan/dev
 * 失败、本轮无 verify 结果时仍命中前一轮陈旧 verify 失败并白烧 fix 执行器，
 * 破坏编排层"相同卡+相同失败指纹"的确定性熔断判定。
 * 但 iterIndex 并不属于 P5StageResult 公共契约（orchestrator 也不回填），
 * 因此用 WeakMap 在 handler 侧建立"结果对象 → 轮次"侧表：
 * - 写入方：各 stage handler 在返回结果前调用 tagStageResultIterIndex；
 * - 读取方：findVerifyFailure 通过 readStageResultIterIndex 取轮次，
 *   读不到（调用方手搭/未打标签的旧结果）返回 null → 走批内锚点兼容路径。
 *
 * WeakMap 键为冻结的结果对象引用，对象不可达时自动回收，无内存泄漏。
 */
const stageResultIterIndexMap = new WeakMap<object, number>();

/**
 * 给阶段结果打轮次标签（handler 在返回前调用）
 *
 * @param result 即将返回的阶段结果对象
 * @param iterIndex 产生该结果的迭代轮次
 * @returns 原对象（透传，便于内联包装）
 */
export function tagStageResultIterIndex<T extends object>(result: T, iterIndex: number): T {
  stageResultIterIndexMap.set(result, iterIndex);
  return result;
}

/**
 * 读取阶段结果的轮次标签
 *
 * @param result 阶段结果对象
 * @returns 轮次；未打标签（手搭结果/旧数据）返回 null
 */
function readStageResultIterIndex(result: Readonly<P5StageResult>): number | null {
  return stageResultIterIndexMap.get(result) ?? null;
}

/**
 * 从 prevResults 中查找 verify 阶段的失败结果
 *
 * 查找规则（轮次隔离修复于 2026-10-05 僵尸任务卡死循环事故）：
 * - **编排路径**（orchestrator 同轮顺序执行 plan→dev→verify→fix，prevResults
 *   携带跨轮历史）：只认**本轮**（轮次标签 === ctx.iterIndex）的 verify
 *   失败。旧实现无限向前扫描，后续轮 plan/dev 失败、本轮无 verify 结果时仍命中
 *   前一轮陈旧 verify 失败并再次白烧一次 fix 执行器，失败信息还掺入陈旧输出，
 *   破坏编排层"相同卡+相同失败指纹"的确定性失败熔断判定。
 * - **单元/兼容路径**（结果无轮次标签，如历史测试手搭同批次结果）：
 *   批内锚点模式——批内无轮次信息可比对，等价于"整批视为同轮"，
 *   向前扫描到批首为止。
 *
 * @param ctx 阶段执行上下文
 * @returns 本轮（或当前批）失败的 verify 阶段结果（若无则返回 null）
 */
/**
 * 从 prevResults 中查找**本轮** dev 阶段的失败结果（R4，2026-10-20）
 *
 * 轮次隔离与 findVerifyFailure 完全同构（编排路径按轮次标签严格匹配，
 * 单元/手搭路径按批内向前扫描），只是 stage 换为 "dev"。
 */
function findDevFailure(ctx: Readonly<P5StageContext>): Readonly<P5StageResult> | null {
  const hasAlignedRound = ctx.prevResults.some((r) => readStageResultIterIndex(r) === ctx.iterIndex);

  if (hasAlignedRound) {
    for (let i = ctx.prevResults.length - 1; i >= 0; i--) {
      const result = ctx.prevResults[i]!;
      if (readStageResultIterIndex(result) !== ctx.iterIndex) {
        continue;
      }
      if (result.stage === "dev" && result.kind !== "success") {
        return result;
      }
    }
    return null;
  }

  for (let i = ctx.prevResults.length - 1; i >= 0; i--) {
    const result = ctx.prevResults[i]!;
    if (result.stage === "dev" && result.kind !== "success") {
      return result;
    }
  }
  return null;
}

function findVerifyFailure(ctx: Readonly<P5StageContext>): Readonly<P5StageResult> | null {
  // 快速判定：prevResults 中存在轮次标签与 ctx.iterIndex 对齐的结果 → 编排路径，
  // 严格按本轮隔离；否则视为单元路径，走批内兼容模式。
  const hasAlignedRound = ctx.prevResults.some((r) => readStageResultIterIndex(r) === ctx.iterIndex);

  if (hasAlignedRound) {
    for (let i = ctx.prevResults.length - 1; i >= 0; i--) {
      const result = ctx.prevResults[i]!;
      if (readStageResultIterIndex(result) !== ctx.iterIndex) {
        continue;
      }
      if (result.stage === "verify" && result.kind !== "success") {
        return result;
      }
    }
    return null;
  }

  // 批内兼容模式：无轮次标签可比对（手搭批次），整批视为同轮向前扫描
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
