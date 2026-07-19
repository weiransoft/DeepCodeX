/**
 * G-7 TESTING Loop 退出门禁检查器（EAG-P3 批次 10 §4.8.3）
 *
 * 本模块实现 `GateG7Checker` 类，对应 EAG-P3 批次 10 设计 §4.8.3 G-7 门禁：
 * "TESTING Loop 退出门禁——覆盖率达标 + 契约测试全过 + E2E 测试全过 + 合规证据完整 + PR 描述就绪"。
 *
 * 核心职责（对齐 §4.8.3）：
 * G-7 校验 TESTING Loop 退出的 5 个前置条件：
 * 1. coverageReport.passed === true（覆盖率达标：行/分支/函数/高风险符号均达标）
 * 2. contractTests 非空 + contractTestResults 全部 exitCode=0（契约测试生成且全部执行通过）
 * 3. e2eTests 非空 + e2eTestResults 全部 exitCode=0（E2E 测试生成且全部执行通过）
 * 4. 若 compliancePackIds 非空 → complianceEvidence 必填（启用 ICP 时合规证据不可缺失）
 * 5. prDescription 非空 + 含四段结构（变更摘要 / 需求映射 / 测试报告 / 合规证据链接）
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
 * - EAG 方案 §5.10.4 交付门禁（PR 描述四段结构）
 * - EAG 方案 §5.9.2 ICP 合规证据
 *
 * 与 testing-orchestrator.ts 中内联 checkGateG7 的关系：
 * - 设计文档明确允许"独立类 + 内联实现共存"（§4.8.1）
 * - 本类为 P3 批次 10 抽取的独立实现，供 GateOrchestrator 统一编排
 * - testing-orchestrator.ts 中的内联 checkGateG7 作为兜底保留（已通过 259 个测试）
 * - 本独立类相对内联实现做了增强：
 *   1. 新增 contractTestResults / e2eTestResults 校验（内联实现仅校验文件列表非空）
 *   2. 新增 PR 描述四段结构校验（内联实现仅校验非空）
 *   3. 多重失败一次性收集（内联实现也是一次性收集，本类对齐该策略）
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
    // 检查 4：若 compliancePackIds 非空 → complianceEvidence 必填
    // ----------------------------------------------------------------------
    const compliancePackIds = g7Context.compliancePackIds;
    if (
      Array.isArray(compliancePackIds) &&
      compliancePackIds.length > 0 &&
      g7Context.complianceEvidence === undefined
    ) {
      failures.push(
        `启用 ICP 合规包（${compliancePackIds.length} 个：${compliancePackIds.join(", ")}）但 complianceEvidence 缺失（启用 ICP 时合规证据必填）`
      );
    }

    // ----------------------------------------------------------------------
    // 检查 5：prDescription 非空 + 含四段结构
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
}
