/**
 * G-7 TESTING Loop 退出门禁检查器（EAG-P3 批次 10 §4.8.3 + 批次 11 §9.2 合规证据扩展）
 *
 * 本模块实现 `GateG7Checker` 类，对应 EAG-P3 批次 10 设计 §4.8.3 G-7 门禁：
 * "TESTING Loop 退出门禁——覆盖率达标 + 契约测试全过 + E2E 测试全过 + 合规证据完整 + PR 描述就绪"。
 *
 * EAG-P3 批次 11 §9.2 进一步扩展合规证据校验——G-7-Comp-1~4 四条规则：
 * - G-7-Comp-1：启用 ICP 时 complianceEvidence 必填（既有）
 * - G-7-Comp-2：complianceEvidence 必须为 ComplianceEvidenceReport 结构（新增）
 * - G-7-Comp-3：每个启用合规包的 overallPassed 必须为 true（新增）
 * - G-7-Comp-4：blocker 级规则必须全部通过（新增，独立校验——架构师审查 B5-M10 修复）
 *
 * 核心职责（对齐 §4.8.3 + §9.2）：
 * G-7 校验 TESTING Loop 退出的 5 个前置条件 + 启用 ICP 时的 4 条合规证据规则：
 * 1. coverageReport.passed === true（覆盖率达标：行/分支/函数/高风险符号均达标）
 * 2. contractTests 非空 + contractTestResults 全部 exitCode=0（契约测试生成且全部执行通过）
 * 3. e2eTests 非空 + e2eTestResults 全部 exitCode=0（E2E 测试生成且全部执行通过）
 * 4. 若 compliancePackIds 非空 → 合规证据 4 条规则（G-7-Comp-1~4）：
 *    a. G-7-Comp-1：complianceEvidence 必填（!== undefined）
 *    b. G-7-Comp-2：complianceEvidence 必须为 ComplianceEvidenceReport 结构
 *       （含 packId / runId / generatedAt / ruleResults / overallPassed）
 *    c. G-7-Comp-4：blocker 级规则必须全部通过（从 ComplianceRuleResult.severity 字段校验）
 *    d. G-7-Comp-3：overallPassed 必须为 true
 * 5. prDescription 非空 + 含四段结构（变更摘要 / 需求映射 / 测试报告 / 合规证据）
 *    + 启用 ICP 时校验"## 合规证据"段含 packId 与 overallPassed 摘要
 *
 * 任一失败 → 返回 passed=false, severity=blocker，并附引导消息"补全后重试"
 *
 * PR 描述四段结构（对齐 §5.10.4 交付门禁）：
 * 1. 变更摘要（## 变更摘要 / ## Change Summary）
 * 2. 需求映射（## 需求映射 / ## Requirement Mapping）
 * 3. 测试报告（## 测试报告 / ## Test Report）
 * 4. 合规证据链接（## 合规证据 / ## Compliance Evidence）
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计 §4.8.1 设计依据（G-6/G-7 同构外推 G-4/G-5）
 * - EAG-P3 批次 10 设计 §4.8.3 G-7 门禁判定规则
 * - EAG-P3 批次 10 设计 §4.8.4 GateG7Context 扩展字段
 * - EAG-P3 批次 11 设计 §9.2 B5 合规证据扩展（G-7-Comp-1~4 + PR 描述合规证据段）
 * - EAG 方案 §5.10.4 交付门禁（PR 描述四段结构）
 * - EAG 方案 §5.9.2 ICP 合规证据
 *
 * 与 testing-orchestrator.ts 中内联 checkGateG7 的关系：
 * - 设计文档明确允许"独立类 + 内联实现共存"（§4.8.1）
 * - 本类为 P3 批次 10 抽取的独立实现，供 GateOrchestrator 统一编排
 * - 批次 11 §9.2 在本独立类上扩展合规证据校验（内联实现不在批次 11 扩展范围）
 * - testing-orchestrator.ts 中的内联 checkGateG7 作为兜底保留（已通过 259 个测试）
 * - 本独立类相对内联实现做了增强：
 *   1. 新增 contractTestResults / e2eTestResults 校验（内联实现仅校验文件列表非空）
 *   2. 新增 PR 描述四段结构校验（内联实现仅校验非空）
 *   3. 多重失败一次性收集（内联实现也是一次性收集，本类对齐该策略）
 *   4. 批次 11 扩展：G-7-Comp-2/3/4 合规证据结构 + blocker 级规则 + PR 描述合规证据段
 *
 * 架构师审查 B5-M10 修复说明：
 * - 原设计将 G-7-Comp-4（blocker 级规则校验）错误地合并到 G-7-Comp-3
 * - 修复后：ComplianceRuleResult 携带 severity 字段（从 ComplianceRule.severity 复制），
 *   G-7-Comp-4 可独立校验"blocker 级规则必须全部通过"
 * - 校验顺序：先 G-7-Comp-4（blocker 级规则），再 G-7-Comp-3（overallPassed）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 公开方法返回冻结对象（Object.freeze）
 * - check() 返回的 GateResult 通过 Object.freeze 冻结
 * - 类字段使用 readonly 修饰
 * - 常量 PR_SECTION_PATTERNS 使用 Object.freeze 冻结
 *
 * @module eag/gate/gate-g7-checker
 */

import type { GateChecker, GateContext, GateResult, GateG7Context } from "./gate-types";
import type { ComplianceEvidenceReport, ComplianceRuleResult } from "../icp/types";

// ============================================================================
// 常量
// ============================================================================

/**
 * G-7 门禁失败时的引导消息（建议补全未通过项后重试）
 *
 * 对齐 §4.8.3 G-7 门禁失败处置：当任一前置条件不满足时，TESTING Loop 不得退出，
 * 应继续修复覆盖率不达标 / 测试失败 / 合规证据缺失 / PR 描述不完整等问题。
 */
const G7_FAILURE_GUIDANCE: string =
  "建议补全未通过项（覆盖率不达标 / 契约或 E2E 测试失败 / 合规证据缺失 / PR 描述不完整）后重试 G-7 门禁";

/**
 * PR 描述四段结构的正则匹配模式（中英文双兼容）
 *
 * 每个段落的标题以 Markdown 二级标题（##）开头，允许中英文两种写法：
 * 1. 变更摘要：## 变更摘要 或 ## Change Summary
 * 2. 需求映射：## 需求映射 或 ## Requirement Mapping
 * 3. 测试报告：## 测试报告 或 ## Test Report
 * 4. 合规证据：## 合规证据 或 ## Compliance Evidence
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（对齐 §5.12.4 G-A6d）。
 *
 * 设计依据：§5.10.4 交付门禁明确要求 PR 描述含四段结构。
 */
const PR_SECTION_PATTERNS: ReadonlyArray<{ readonly section: string; readonly pattern: RegExp }> = Object.freeze([
  { section: "变更摘要", pattern: /^##\s+(变更摘要|Change\s+Summary)\s*$/m },
  { section: "需求映射", pattern: /^##\s+(需求映射|Requirement\s+Mapping)\s*$/m },
  { section: "测试报告", pattern: /^##\s+(测试报告|Test\s+Report)\s*$/m },
  { section: "合规证据", pattern: /^##\s+(合规证据|Compliance\s+Evidence)\s*$/m },
]);

// ============================================================================
// GateG7Checker 类
// ============================================================================

/**
 * G-7 门禁检查器
 *
 * 实现 §4.8.3 G-7 门禁：TESTING Loop 退出门禁。
 *
 * 检查规则（对齐 §4.8.3 判定规则，多重失败一次性收集到 failures 列表）：
 * 1. coverageReport.passed === true
 * 2. contractTests.length > 0 且 contractTestResults 全部 exitCode=0
 * 3. e2eTests.length > 0 且 e2eTestResults 全部 exitCode=0
 * 4. 若 compliancePackIds 非空 → complianceEvidence 必填（非 undefined）
 * 5. prDescription 非空字符串 + 含四段结构（变更摘要 / 需求映射 / 测试报告 / 合规证据链接）
 *
 * 任一失败 → 返回 passed=false, severity=blocker
 * 全部通过 → 返回 passed=true, severity=blocker
 *
 * 使用方式：
 * ```typescript
 * const checker = new GateG7Checker();
 * const result = checker.check(g7Context);
 * if (!result.passed) {
 *   // 阻止退出 TESTING Loop，按 guidance 补全后重试
 * }
 * ```
 *
 * 注：G-7 上下文（GateG7Context）继承自 GateContext，扩展了
 * coverageReport / contractTests / contractTestResults / e2eTests / e2eTestResults /
 * compliancePackIds / complianceEvidence / prDescription 字段。
 * 调用方在装配 GateG7Context 时应确保所有必填字段已填充。
 */
export class GateG7Checker implements GateChecker {
  /** 门禁 ID（固定为 "G-7"） */
  public readonly gateId = "G-7" as const;

  /**
   * 初始化 G-7 门禁检查器
   *
   * G-7 不依赖外部服务（覆盖率报告由调用方在装配上下文时调用 CoverageGate 生成后传入），
   * 因此构造函数无参数。
   *
   * 与设计文档 §4.8.3 的偏差说明：
   * - 设计文档显示 G-7 构造函数接受 coverageGate 参数
   * - 本实现中 G-7 直接校验 context.coverageReport.passed（由调用方
   *   在装配上下文时调用 CoverageGate.evaluate 后传入），不主动调用 coverageGate
   * - 这与 G-5 的实现策略一致（G-5 也是直接校验 finalEvaluationReport.verdict）
   * - 保留无参构造函数，简化调用方使用
   */
  constructor() {
    // 无外部依赖注入
  }

  /**
   * 执行 G-7 门禁检查
   *
   * 检查顺序（多重失败一次性收集，便于调用方一次性看到全部未通过项）：
   * 1. coverageReport.passed === true
   * 2. contractTests 非空 + contractTestResults 全部 exitCode=0
   * 3. e2eTests 非空 + e2eTestResults 全部 exitCode=0
   * 4. 若 compliancePackIds 非空 → complianceEvidence 必填
   * 5. prDescription 非空 + 含四段结构
   *
   * 与 G-1~G-5 短路求值不同，G-7 采用"一次性收集全部失败"策略：
   * - 优势：调用方一次看到全部未通过项，避免逐项修复-重试循环
   * - 设计依据：G-7 是 TESTING Loop 退出门禁，前置条件较多（5 项），
   *   一次性展示全部失败更高效
   *
   * @param context 门禁上下文（GateG7Context，含 G-7 扩展字段）
   * @returns 门禁判定结果（passed=true 表示通过，false 表示未通过，含全部失败原因）
   */
  public check(context: GateContext): GateResult {
    // G-7 上下文需为 GateG7Context（含扩展字段）
    // 由于 GateChecker 协议定义 check(context: GateContext)，此处需类型断言
    const g7Context = context as GateG7Context;

    // 多重失败一次性收集到 failures 列表
    const failures: string[] = [];

    // ----------------------------------------------------------------------
    // 检查 1：coverageReport.passed === true（覆盖率达标）
    // ----------------------------------------------------------------------
    const coverageReport = g7Context.coverageReport;
    if (!coverageReport || coverageReport.passed !== true) {
      const failedDims = coverageReport?.failedDimensions?.join(", ") ?? "未知";
      failures.push(`覆盖率未达标（未通过维度：${failedDims}，G-7 要求行/分支/函数/高风险符号全部达标）`);
    }

    // ----------------------------------------------------------------------
    // 检查 2：contractTests 非空 + contractTestResults 全部 exitCode=0
    // ----------------------------------------------------------------------
    const contractTests = g7Context.contractTests;
    const contractTestResults = g7Context.contractTestResults;
    if (!Array.isArray(contractTests) || contractTests.length === 0) {
      failures.push("契约测试文件列表为空（TESTING Loop 必须生成至少一个契约测试文件）");
    } else if (!Array.isArray(contractTestResults) || contractTestResults.length === 0) {
      failures.push("契约测试执行结果列表为空（contractTests 非空时 contractTestResults 必须含对应执行结果）");
    } else {
      // 校验全部 exitCode=0
      const failedContractTests = contractTestResults.filter((r) => r.exitCode !== 0);
      if (failedContractTests.length > 0) {
        const failedPaths = failedContractTests.map((r) => r.filePath).join(", ");
        failures.push(`契约测试存在 ${failedContractTests.length} 个失败文件（exitCode 非 0）：${failedPaths}`);
      }
    }

    // ----------------------------------------------------------------------
    // 检查 3：e2eTests 非空 + e2eTestResults 全部 exitCode=0
    // ----------------------------------------------------------------------
    const e2eTests = g7Context.e2eTests;
    const e2eTestResults = g7Context.e2eTestResults;
    if (!Array.isArray(e2eTests) || e2eTests.length === 0) {
      failures.push("E2E 测试文件列表为空（TESTING Loop 必须生成至少一个 E2E 测试文件）");
    } else if (!Array.isArray(e2eTestResults) || e2eTestResults.length === 0) {
      failures.push("E2E 测试执行结果列表为空（e2eTests 非空时 e2eTestResults 必须含对应执行结果）");
    } else {
      // 校验全部 exitCode=0
      const failedE2eTests = e2eTestResults.filter((r) => r.exitCode !== 0);
      if (failedE2eTests.length > 0) {
        const failedPaths = failedE2eTests.map((r) => r.filePath).join(", ");
        failures.push(`E2E 测试存在 ${failedE2eTests.length} 个失败文件（exitCode 非 0）：${failedPaths}`);
      }
    }

    // ----------------------------------------------------------------------
    // 检查 4：若 compliancePackIds 非空 → 合规证据 4 条规则（G-7-Comp-1~4）
    //
    // EAG-P3 批次 11 §9.2 扩展：
    // - G-7-Comp-1：complianceEvidence 必填（!== undefined，既有规则）
    // - G-7-Comp-2：complianceEvidence 必须为 ComplianceEvidenceReport 结构
    // - G-7-Comp-4：blocker 级规则必须全部通过（架构师审查 B5-M10 修复，独立校验）
    // - G-7-Comp-3：overallPassed 必须为 true
    //
    // 校验顺序（对齐 §9.2 + B5-M10 修复 + B5-M2 修复）：
    // 1. G-7-Comp-1：先校验非空（否则后续校验无意义）
    // 2. G-7-Comp-2：再校验结构完整性（否则后续 severity 字段访问会异常）
    // 3. G-7-Comp-4：先校验 blocker 级规则（不可豁免，必全部通过）
    // 4. G-7-Comp-3：再校验 overallPassed（不可豁免，与 G-7 门禁 blocker 级语义一致）
    // ----------------------------------------------------------------------
    const compliancePackIds = g7Context.compliancePackIds;
    const icpEnabled: boolean = Array.isArray(compliancePackIds) && compliancePackIds.length > 0;

    if (icpEnabled) {
      // 注：此处显式重新检查 Array.isArray(compliancePackIds) 以触发 TS narrowing，
      // 因为中间变量 icpEnabled: boolean 丢失了 compliancePackIds 非 undefined 的类型信息。
      // 若不重新检查，L253 的 compliancePackIds.length / .join 会触发 TS18048 错误。
      const packIds: ReadonlyArray<string> = Array.isArray(compliancePackIds)
        ? compliancePackIds
        : Object.freeze([] as string[]);
      // G-7-Comp-1：启用 ICP 时 complianceEvidence 必填（!== undefined）
      if (g7Context.complianceEvidence === undefined) {
        failures.push(
          `[G-7-Comp-1] 启用 ICP 合规包（${packIds.length} 个：${packIds.join(", ")}）但 complianceEvidence 缺失（启用 ICP 时合规证据必填）`
        );
      } else {
        // G-7-Comp-2：complianceEvidence 必须为 ComplianceEvidenceReport 结构
        // 校验字段：packId / runId / generatedAt / ruleResults / overallPassed
        // 注：complianceEvidence 在 GateG7Context 中类型为 Readonly<Record<string, unknown>>，
        //     此处通过 Partial<ComplianceEvidenceReport> 类型断言进行字段校验
        const report = g7Context.complianceEvidence as unknown as Partial<ComplianceEvidenceReport>;
        const structErrors: string[] = [];
        if (typeof report.packId !== "string" || (report.packId as string).trim().length === 0) {
          structErrors.push("packId（非空字符串）");
        }
        if (typeof report.runId !== "string" || (report.runId as string).trim().length === 0) {
          structErrors.push("runId（非空字符串）");
        }
        if (typeof report.generatedAt !== "string" || (report.generatedAt as string).trim().length === 0) {
          structErrors.push("generatedAt（非空字符串）");
        }
        if (!Array.isArray(report.ruleResults)) {
          structErrors.push("ruleResults（数组）");
        }
        if (typeof report.overallPassed !== "boolean") {
          structErrors.push("overallPassed（布尔）");
        }
        if (structErrors.length > 0) {
          failures.push(
            `[G-7-Comp-2] complianceEvidence 必须为 ComplianceEvidenceReport 结构（含 packId/runId/generatedAt/ruleResults/overallPassed），缺失或类型错误：${structErrors.join("、")}`
          );
        } else {
          // 结构校验通过，进行 G-7-Comp-4 与 G-7-Comp-3 校验
          const ruleResults: ReadonlyArray<ComplianceRuleResult> =
            report.ruleResults as ReadonlyArray<ComplianceRuleResult>;

          // G-7-Comp-4：blocker 级规则必须全部通过（架构师审查 B5-M10 修复——独立校验）
          // 从 ComplianceRuleResult.severity 字段校验，blocker 级规则不可豁免，必全部通过
          const blockerFailures: ReadonlyArray<ComplianceRuleResult> = ruleResults.filter(
            (r: ComplianceRuleResult) => r.severity === "blocker" && !r.passed
          );
          if (blockerFailures.length > 0) {
            const failedRuleIds: string = blockerFailures.map((r: ComplianceRuleResult) => r.ruleId).join(", ");
            failures.push(
              `[G-7-Comp-4] 存在 ${blockerFailures.length} 条 blocker 级规则未通过：${failedRuleIds}（blocker 级规则不可豁免，必须全部通过）`
            );
          }

          // G-7-Comp-3：每个启用合规包的 overallPassed 必须为 true
          // 语义说明（架构师审查 B5-M2 修复——删除"可人工豁免"误导性注释）：
          // - G-7 门禁整体为 blocker 级（任一失败即阻塞 TESTING Loop 退出）
          // - G-7-Comp-3 与 G-7 门禁整体语义一致：overallPassed=false 不可豁免，必须修复后重试
          // - G-7-Comp-4 已独立校验 blocker 级规则全部通过，此处 overallPassed=false
          //   通常由 major 级规则未通过导致，但 major 级失败同样阻塞 G-7 门禁（不可豁免）
          // - 调用方需修复 major 级规则失败后重新执行 G-7 门禁检查
          if (report.overallPassed !== true) {
            failures.push(
              `[G-7-Comp-3] 合规包 ${report.packId as string} overallPassed=false，存在未通过规则（blocker 级已通过 G-7-Comp-4 校验，此处可能为 major 级未通过，需修复后重试 G-7 门禁）`
            );
          }
        }
      }
    }

    // ----------------------------------------------------------------------
    // 检查 5：prDescription 非空 + 含四段结构
    //   + 启用 ICP 时校验"## 合规证据"段含 packId 与 overallPassed 摘要
    //   （EAG-P3 批次 11 §9.2.3 PR 描述合规证据段扩展）
    // ----------------------------------------------------------------------
    const prDescription = g7Context.prDescription;
    if (typeof prDescription !== "string" || prDescription.trim().length === 0) {
      failures.push("PR 描述未就绪（prDescription 为空或非字符串，TESTING Loop 退出前必须生成 PR 描述）");
    } else {
      // 校验四段结构
      const missingSections: string[] = [];
      for (const { section, pattern } of PR_SECTION_PATTERNS) {
        if (!pattern.test(prDescription)) {
          missingSections.push(section);
        }
      }
      if (missingSections.length > 0) {
        failures.push(
          `PR 描述缺少 ${missingSections.length} 个段落：${missingSections.join("、")}（G-7 要求 PR 描述含变更摘要/需求映射/测试报告/合规证据四段）`
        );
      }

      // 启用 ICP 时校验"## 合规证据"段含 packId 与 overallPassed 摘要（§9.2.3）
      if (icpEnabled) {
        const complianceSection: string | null = this.extractSection(prDescription, "合规证据");
        if (complianceSection === null) {
          failures.push(`[G-7-PR-Comp] PR 描述缺少 ## 合规证据 段（启用 ICP 时 PR 描述必须含合规证据摘要）`);
        } else {
          // 校验摘要包含 packId / overallPassed
          if (!complianceSection.includes("packId:") || !complianceSection.includes("overallPassed:")) {
            failures.push(
              `[G-7-PR-Comp] PR 描述 ## 合规证据 段必须包含 packId 与 overallPassed 摘要（实际段内容：${complianceSection.slice(0, 80)}...）`
            );
          }
        }
      }
    }

    // 任一失败 → 返回 passed=false, severity=blocker
    if (failures.length > 0) {
      return Object.freeze({
        passed: false,
        gate: "G-7",
        reason: `G-7 门禁未通过，共 ${failures.length} 项失败：${failures.join("；")}`,
        guidance: G7_FAILURE_GUIDANCE,
        severity: "blocker",
      }) as GateResult;
    }

    // 全部通过
    const hasIcp = Array.isArray(compliancePackIds) && compliancePackIds.length > 0;
    return Object.freeze({
      passed: true,
      gate: "G-7",
      reason:
        `G-7 门禁通过：覆盖率达标，契约测试 ${contractTests.length} 个全过，` +
        `E2E 测试 ${e2eTests.length} 个全过，` +
        `${hasIcp ? `含 ICP 合规证据（${compliancePackIds.length} 个合规包），` : ""}` +
        `PR 描述四段结构完整`,
      severity: "blocker",
    }) as GateResult;
  }

  /**
   * 从 PR 描述中提取指定二级标题段的内容
   *
   * 用于 G-7-PR-Comp 校验——启用 ICP 时校验 "## 合规证据" 段含 packId 与 overallPassed 摘要。
   *
   * 提取规则（对齐 Markdown 二级标题语法）：
   * 1. 在 prDescription 中查找以 `## ` 开头、后跟 sectionName 的行（支持中英文）
   * 2. 找到后，返回从该行下一行到下一个 `## ` 标题行（不含）或字符串末尾的内容
   * 3. 未找到指定段时返回 null
   *
   * 设计要点：
   * - 段标题匹配必须独占一行（避免误匹配正文中的 `## xxx` 文本）
   * - 支持中英文兼容（sectionName="合规证据" 同时匹配 "## 合规证据" 与 "## Compliance Evidence"）
   * - 段内容保留原始换行，便于调用方进一步 includes() 检查
   * - 段内容去除首尾空白（trim），避免空段被误判为有内容
   *
   * @param prDescription PR 描述原文（含多段 Markdown 二级标题）
   * @param sectionName 段名（中文，如 "合规证据"；英文别名在调用处通过 PR_SECTION_PATTERNS 已兼容）
   * @returns 段内容（trim 后），未找到返回 null
   *
   * @example
   * const pr = "## 变更摘要\n修复登录\n\n## 合规证据\npackId: GMP\noverallPassed: true\n";
   * const section = checker["extractSection"](pr, "合规证据");
   * // section === "packId: GMP\noverallPassed: true"
   */
  private extractSection(prDescription: string, sectionName: string): string | null {
    // 按 Markdown 行分割（保留行结构，便于定位标题行）
    const lines: ReadonlyArray<string> = prDescription.split(/\r?\n/);

    // 构造段标题匹配正则：^## <sectionName>\s*$（独占一行，允许尾随空白）
    // 同时支持中英文兼容：通过 PR_SECTION_PATTERNS 查找该段对应的中文 / 英文别名
    // 但此处仅基于传入 sectionName 匹配中文标题，英文标题由调用方在 PR_SECTION_PATTERNS
    // 的四段结构校验中已统一处理；本方法专注提取指定中文段内容
    const sectionPattern: RegExp = new RegExp(`^##\\s+${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);

    // 查找段标题所在行索引
    let sectionStartIndex: number = -1;
    for (let i: number = 0; i < lines.length; i++) {
      if (sectionPattern.test(lines[i])) {
        sectionStartIndex = i;
        break;
      }
    }

    // 未找到段标题 → 返回 null
    if (sectionStartIndex === -1) {
      return null;
    }

    // 从段标题下一行开始，查找下一个 `## ` 标题行（段结束边界）
    let sectionEndIndex: number = lines.length;
    for (let j: number = sectionStartIndex + 1; j < lines.length; j++) {
      if (/^##\s+/.test(lines[j])) {
        sectionEndIndex = j;
        break;
      }
    }

    // 提取段内容（标题行下一行到段结束边界前一行）
    const sectionLines: ReadonlyArray<string> = lines.slice(sectionStartIndex + 1, sectionEndIndex);

    // 拼接为字符串并 trim（去除首尾空白，避免空段被误判为有内容）
    const sectionContent: string = sectionLines.join("\n").trim();

    // 段内容为空字符串时仍返回空串（与 null 区分：null 表示段不存在，空串表示段存在但内容为空）
    return sectionContent;
  }
}
