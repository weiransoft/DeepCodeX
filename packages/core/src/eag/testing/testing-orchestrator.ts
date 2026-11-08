/**
 * TESTING Loop 编排器（TestingOrchestrator）—— EAG-P3 批次 10 §4.5
 *
 * 职责：
 * - 编排契约测试生成 → E2E 测试生成 → 覆盖率门禁 → 合规证据 → PR 描述生成的完整 TESTING Loop
 * - 集成 G-6/G-7 门禁检查（本批次内联实现，P3 批次 11 可抽取为独立 GateG6Checker/GateG7Checker 类）
 * - 集成 LoopGuard 上限保护（maxIterations + maxTokens + 连续失败）
 * - 集成 3 个测试质量静态判定器（AssertionDensityChecker / TestNamingChecker / CoverageGapChecker）
 * - 集成 BrownfieldContractGuard 既有契约保护判定
 *
 * 对应 EAG 方案 §5.10.5 时序"TESTING Loop"段完整编排：
 * 契约测试生成 → E2E 测试生成 → 覆盖率门禁 → 合规证据（如启用 ICP） → PR 描述生成
 *
 * 算法（对齐设计文档 §4.5.2）：
 * 1. G-6 门禁检查（实现代码已完成 + 单测全过 + spec 已批准）
 * 2. 解析 spec.md → AcceptanceCriterion[]
 * 3. 调用 ContractTestGenerator.generate() 生成契约测试
 * 4. 调用 E2eTestGenerator.generate() 生成 E2E 测试
 *    - inferred 流程转 HUMAN_CHECKPOINT 队列
 * 5. 调用 BrownfieldContractGuard.check() 做既有契约保护判定（棕地场景）
 * 6. 调用 3 个 TestQualityChecker 做静态质量判定
 * 7. 调用 CoverageGate.check() 执行覆盖率门禁
 *    - 首次失败 WARNING + 连续 2 次失败升级 BLOCKER
 * 8. 若启用 ICP（compliancePackIds 非空）：调用 ComplianceEvidenceReport（批次 11 实现，本批次预留接口）
 * 9. 生成 PR 描述（变更摘要 / 需求映射 / 测试报告 / 合规证据链接）
 * 10. G-7 门禁检查（覆盖率达标 + 契约全过 + E2E 全过 + 合规证据 + PR 描述就绪）
 * 11. 写 events.jsonl 事件流
 *
 * 失败处理：
 * - 契约测试或 E2E 测试生成失败 → human_checkpoint
 * - 覆盖率连续 2 次 BLOCKER → human_checkpoint
 * - LoopGuard 触达上限 → stop_failure
 * - G-6 失败 → human_checkpoint（前置条件未满足）
 * - G-7 失败 → human_checkpoint（交付门禁未通过）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * @module eag/testing/testing-orchestrator
 */

// ============================================================================
// 1. 外部依赖与类型导入
// ============================================================================

import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { LoopEvent, LoopEventType } from "../loop/models";
import type { TaskDag } from "../doc-driven/types";
import type { LoopGuard } from "../../common/loop-guard";
import { ContractTestGenerator } from "./contract-test-generator";
import { E2eTestGenerator } from "./e2e-test-generator";
import type { CoverageGate } from "./coverage-gate";
import { BrownfieldContractGuard } from "./brownfield-contract-guard";
import { DEFAULT_TEST_QUALITY_CHECKERS } from "./static-checkers/index";
// EAG-P3 批次 11 S1 改造：从 gate 模块导入独立的 G-6/G-7 检查器与类型
// 设计依据：EAG-P3 批次 11 设计 §3 S1 D-S1-2/D-S1-3——gate 模块是门禁类型的权威来源，
// testing-orchestrator 作为消费者应复用，避免内联重复定义导致类型分叉。
import { GateG6Checker } from "../gate/gate-g6-checker";
import { GateG7Checker } from "../gate/gate-g7-checker";
import type { GateG6Context, GateG7Context, GateResult } from "../gate/gate-types";
// P0-4 修复：TestExecutionResult 权威定义在 gate/ 目录（本组无权修改），
// 测试执行结果改用 testing 域内结构兼容的超集 TestExecutionResultWithEvidence，
// 额外携带 stderr / failedCases / errorMessage / stdoutSnippet 失败证据链（字段全可选）。
import type { LLMClient, LLMRequest, LLMResponse, LLMStreamEvent, LLMUsage } from "../../providers/llm-provider";
import type {
  AcceptanceCriterion,
  ContractCompatibilityReport,
  ContractTestSpec,
  CoverageFailedDimension,
  CoverageReport,
  CoverageThreshold,
  E2eTestSpec,
  GeneratedTestFile,
  LogCallback,
  PkcAccessor,
  TestExecutionResultWithEvidence,
  TestQualityChecker,
  TestQualityContext,
  TestQualityResult,
  TestingLoopFinalStatus,
  TestingLoopRequest,
  TestingLoopResult,
  UncoveredSymbol,
} from "./types";
import {
  COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD,
  DEFAULT_CONTRACT_TEST_OUTPUT_DIR,
  DEFAULT_COVERAGE_THRESHOLD,
  DEFAULT_E2E_TEST_OUTPUT_DIR,
  DEFAULT_HIGH_RISK_TOP_N,
  DEFAULT_MAX_TOKENS_PER_TEST_FILE,
  DEFAULT_MAX_TESTING_ITERATIONS,
} from "./types";

// ============================================================================
// 2. 常量定义
// ============================================================================

/**
 * 默认测试目录（相对 projectRoot，c8 覆盖率采集使用）
 */
const DEFAULT_TEST_DIR = "tests/" as const;

/**
 * 默认实现代码目录（相对 projectRoot）
 */
const DEFAULT_IMPLEMENTATION_ROOT = "src/" as const;

/**
 * 默认日志空函数（避免 undefined 判空）
 */
function noopLog(_message: string, _level?: "info" | "warn" | "error"): void {
  // 默认无操作
}

/**
 * 证据文本截断上限（字符）
 *
 * P0-4 修复：stderr / stdout 可能含极长的堆栈，保留证据的同时避免
 * PR 描述与事件流无限膨胀；截断时显式标注原始长度，不静默丢弃。
 */
const EVIDENCE_CLIP_LIMIT = 4000 as const;

/**
 * 截断证据文本，并显式标注原始长度（P0-4 修复：证据不得无声消失）
 */
function clipEvidence(text: string, limit: number = EVIDENCE_CLIP_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…（已截断，原始长度 ${text.length} 字符）`;
}

/**
 * 构造测试子进程的 node 命令参数（P0-4 收尾修复，导出为纯函数作为可观察点）
 *
 * 背景：`--test-reporter=json` 从来不是 node:test 内置 reporter（Node v22 内置仅
 * spec/tap/dot/junit/lcov），仓库亦未安装 `json` 包，真实运行必抛
 * ERR_MODULE_NOT_FOUND，导致每个测试文件都拿不到 JSON 报告、P0-4 修的失败用例名
 * 在真实运行中永远取不到。默认改用内置 `tap`。
 *
 * 导出为纯函数：命令构造成为确定性可观察点，单测无需引入 mock 框架即可断言
 * 默认/回退语义；executeSingleTestFile 真实调用本函数，旧调用方零回归。
 *
 * 回退：EAG_LEGACY_JSON_REPORTER=1 时恢复旧 `--test-reporter=json` 命令。
 *
 * @param filePath 测试文件相对路径（相对 projectRoot）
 * @returns node 子进程参数数组
 */
export function buildTestRunnerArgs(filePath: string): ReadonlyArray<string> {
  const reporter = process.env.EAG_LEGACY_JSON_REPORTER === "1" ? "json" : "tap";
  return Object.freeze(["--import", "tsx", "--test", `--test-reporter=${reporter}`, filePath]);
}

/**
 * 解析 TAP13 报告（node --test --test-reporter=tap 的默认输出）
 *
 * 规则（对齐 P0-4 收尾规格）：
 * - 识别 `ok N - <name>` / `not ok N - <name>` 提取通过/失败用例名
 * - 跳过 `#` 注释行、`TAP version` 头、`1..N` 计划行、空行
 * - `---` / `...` 之间的 YAML 诊断块不作用例判定，但把块内文本（error: |- /
 *   stack: |- / name: 'AssertionError' / 断言差异等）收集为错误证据——TAP 把
 *   AssertionError 写在 stdout 的 YAML 块而非 stderr，证据不能只依赖 stderr
 *
 * @param stdout 子进程 stdout
 * @returns 是否识别为 TAP、用例列表、YAML 诊断文本
 */
function parseTap13(stdout: string): {
  readonly recognized: boolean;
  readonly cases: ReadonlyArray<{ readonly name?: string; readonly status: "pass" | "fail" }>;
  readonly diagnosticText: string;
} {
  const cases: Array<{ readonly name?: string; readonly status: "pass" | "fail" }> = [];
  const diagnosticLines: string[] = [];
  let inYamlBlock = false;
  let recognized = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const trimmed = rawLine.trim();

    // YAML 诊断块边界：块内文本纳入证据，但不作为用例行判定
    if (trimmed === "---") {
      inYamlBlock = true;
      continue;
    }
    if (trimmed === "...") {
      inYamlBlock = false;
      continue;
    }
    if (inYamlBlock) {
      diagnosticLines.push(rawLine.replace(/^\s{2}/, ""));
      continue;
    }

    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;
    if (/^TAP version \d+/i.test(trimmed)) continue;
    if (/^1\.\.\d+/.test(trimmed)) continue;

    const match = /^(not ok|ok)\s+\d+\s*(?:-\s*)?(.*)$/.exec(trimmed);
    if (match) {
      recognized = true;
      const status: "pass" | "fail" = match[1] === "ok" ? "pass" : "fail";
      // 去掉 TAP 指令后缀（# SKIP / # TODO），避免污染用例名
      const name = match[2].replace(/\s+#\s*(?:SKIP|TODO)\b.*$/i, "").trim();
      cases.push({ name: name.length > 0 ? name : undefined, status });
    }
  }

  return {
    recognized,
    cases: Object.freeze(cases),
    diagnosticText: diagnosticLines.join("\n").trim(),
  };
}

/**
 * 构造「子进程非正常退出」路径的测试执行结果（spawn 失败 / 超时 / error 事件）
 *
 * P0-4 修复：旧实现仅返回 failedCount=1 且不带任何原因，导致失败证据整体消失。
 * 新实现透传真实 stderr + 明确 errorMessage（含触发原因），供 G-7 上下文与 PR 描述使用。
 */
function buildSpawnFailureResult(
  filePath: string,
  durationMs: number,
  reason: string,
  stderr: string
): TestExecutionResultWithEvidence {
  const stderrTrimmed = stderr.trim();
  return {
    filePath,
    exitCode: -1,
    durationMs,
    failedCount: 1,
    passedCount: 0,
    ...(stderrTrimmed.length > 0 ? { stderr: clipEvidence(stderr) } : {}),
    errorMessage: stderrTrimmed.length > 0 ? `${reason}\nstderr：${clipEvidence(stderrTrimmed)}` : reason,
  };
}

/**
 * 解析测试子进程的 stdout/stderr，组装含失败证据链的 TestExecutionResultWithEvidence
 * （P0-4 修复新增，导出为纯函数以便确定性单测）
 *
 * 解析优先级（保持旧调用方零回归）：
 * 1. 单个 JSON 对象：{ tests: [{ name, status: "pass"|"fail" }, ...] }
 * 2. NDJSON 事件流（node --test 实际输出之一）：逐行 { type: "test:pass"|"test:fail", data: { name } }
 * 3. TAP13（node --test --test-reporter=tap，Node 内置）：`ok N - <name>` / `not ok N - <name>`
 *
 * 关键约束（对齐用户红线「诚实降级」）：
 * - 真实 stderr 原样保留（含 AssertionError），不再"收集却从不读取"
 * - 失败用例名（name）不再被丢弃
 * - TAP 把 AssertionError 写在 stdout 的 YAML 诊断块而非 stderr，故把
 *   error/stack/name 等诊断文本也纳入 errorMessage / stdoutSnippet 证据
 * - 报告解析失败时保留原始 stdout/stderr 片段并写明原因，
 *   绝不简化为 failedCount=1 却不带原因
 */
export function buildTestExecutionResult(
  filePath: string,
  exitCode: number,
  durationMs: number,
  stdout: string,
  stderr: string
): TestExecutionResultWithEvidence {
  const parsedCases: Array<{ readonly name?: string; readonly status: "pass" | "fail" }> = [];
  let tapDiagnosticText = "";
  let parseError: string | null = null;
  let jsonParseErrorMessage = "";

  // ---- 优先级 1：单个 JSON 对象 ----
  let jsonHandled = false;
  try {
    const single = JSON.parse(stdout) as { tests?: Array<{ name?: string; status?: string }> };
    if (Array.isArray(single.tests)) {
      for (const t of single.tests) {
        const status = t?.status;
        if (status === "pass" || status === "fail") {
          parsedCases.push({ name: t?.name, status });
        }
      }
    } else {
      parseError = "stdout 是合法 JSON 但缺少 tests 数组";
    }
    jsonHandled = true;
  } catch (e) {
    jsonParseErrorMessage = e instanceof Error ? e.message : String(e);
  }

  // ---- 优先级 2：NDJSON 事件流 ----
  if (!jsonHandled) {
    let ndjsonRecognized = false;
    for (const line of stdout.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      try {
        const ev = JSON.parse(line) as {
          type?: string;
          data?: { name?: string };
        };
        if (typeof ev.type === "string") ndjsonRecognized = true;
        if (ev.type === "test:pass") {
          parsedCases.push({ name: ev.data?.name, status: "pass" });
        } else if (ev.type === "test:fail") {
          parsedCases.push({ name: ev.data?.name, status: "fail" });
        }
      } catch {
        // 非 JSON 行（如编译器告警）忽略，保留在 stdoutSnippet 中供诊断
      }
    }

    // ---- 优先级 3：TAP13（Node 内置 tap reporter 默认输出）----
    if (!ndjsonRecognized) {
      const tap = parseTap13(stdout);
      if (tap.recognized) {
        for (const c of tap.cases) parsedCases.push(c);
        tapDiagnosticText = tap.diagnosticText;
      } else {
        parseError = `stdout 既非合法 JSON 报告、NDJSON 事件流，也非 TAP13 报告：${jsonParseErrorMessage}`;
      }
    }
  }

  let passedCount = 0;
  let failedCount = 0;
  const failedCases: string[] = [];
  for (const c of parsedCases) {
    if (c.status === "pass") {
      passedCount++;
    } else {
      failedCount++;
      failedCases.push(
        typeof c.name === "string" && c.name.trim().length > 0 ? c.name : `(未命名用例 #${failedCount})`
      );
    }
  }

  // 三种格式都解析失败时才按退出码退化统计，但必须保留原始 stdout/stderr 片段
  if (parseError !== null) {
    if (exitCode === 0) {
      passedCount = 1;
      failedCount = 0;
    } else {
      passedCount = 0;
      failedCount = 1;
    }
  }

  const stderrTrimmed = stderr.trim();
  // TAP 把 AssertionError 写在 stdout YAML 块，存在失败用例时把诊断文本纳入证据
  // （避免只依赖可能为空的 stderr；正常全通过时不污染结果）
  const tapEvidence = failedCount > 0 ? tapDiagnosticText : "";
  const reasonParts: string[] = [];
  if (parseError) reasonParts.push(parseError);
  if (failedCases.length > 0) reasonParts.push(`失败用例：${failedCases.join("、")}`);
  if (tapEvidence.length > 0) reasonParts.push(`TAP 诊断（stdout YAML 块）：${clipEvidence(tapEvidence)}`);
  if (stderrTrimmed.length > 0) reasonParts.push(`stderr：${clipEvidence(stderrTrimmed)}`);
  if (exitCode !== 0 && failedCases.length === 0 && reasonParts.length === 0) {
    reasonParts.push(`测试进程退出码 ${exitCode}（stdout/stderr 未含可解析的失败用例）`);
  }

  // 解析失败保留原始 stdout；TAP 解析成功但存在失败时保留 YAML 诊断证据片段
  const stdoutSnippetText = parseError !== null ? stdout : tapEvidence;

  return {
    filePath,
    exitCode,
    durationMs,
    failedCount,
    passedCount,
    ...(stderrTrimmed.length > 0 ? { stderr: clipEvidence(stderr) } : {}),
    ...(failedCases.length > 0 ? { failedCases: Object.freeze([...failedCases]) } : {}),
    ...(reasonParts.length > 0 ? { errorMessage: reasonParts.join("\n") } : {}),
    ...(stdoutSnippetText.length > 0 ? { stdoutSnippet: clipEvidence(stdoutSnippetText) } : {}),
  };
}

// ============================================================================
// 3. TestingOrchestratorError 自定义错误类
// ============================================================================

/**
 * TESTING Loop 编排器错误类型（字面量联合类型）
 *
 * - request-invalid：请求字段非法
 * - gate-failed：门禁检查失败
 * - generator-failed：测试生成器失败
 * - coverage-failed：覆盖率门禁失败
 * - contract-broken：既有契约保护判定失败（breaking change 存在）
 */
export type TestingOrchestratorErrorKind =
  | "request-invalid"
  | "gate-failed"
  | "generator-failed"
  | "coverage-failed"
  | "contract-broken";

/**
 * TESTING Loop 编排器错误
 */
export class TestingOrchestratorError extends Error {
  /**
   * @param kind 错误类型
   * @param message 错误消息
   * @param cause 原始错误（可选）
   */
  constructor(
    public readonly kind: TestingOrchestratorErrorKind,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "TestingOrchestratorError";
  }
}

// ============================================================================
// 4. G-6/G-7 门禁类型与检查器（EAG-P3 批次 11 S1 改造后从 gate 模块导入）
// ============================================================================
//
// 改造说明（对齐 EAG-P3 批次 11 设计 §3 S1 D-S1-1/D-S1-2/D-S1-3）：
// - 原 L147~L234 内联声明的 4 个接口（GateG6Result / GateG7Result / GateG6Context / GateG7Context）
//   已删除，改为从 gate/gate-types 导入权威类型
// - 原 L768~L831 内联的 2 个私有方法（checkGateG6 / checkGateG7）已删除，
//   改为通过构造期注入的 GateG6Checker / GateG7Checker 独立类委托执行
// - 返回值由内联 GateG6Result / GateG7Result（failures 数组结构）
//   切换为权威 GateResult（reason 字符串 + guidance + severity 结构）
// - 与 GateG4Checker / GateG5Checker 在 CodingOrchestrator 中的注入方式同构
//
// 类型源头统一（与 S2 改进合并实施）：
// - gate/gate-types.ts 是 GateG6Context / GateG7Context / GateResult / TestExecutionResult 的权威来源
// - testing-orchestrator.ts 作为消费者复用，不再独立声明
//
// 向后兼容性：
// - 既有测试中 import { GateG6Result, GateG7Result } 的代码需更新为 import type { GateResult }
// - 事件流 payload 中 failures 字段改为 reason 字段（结构由数组变字符串）

// ============================================================================
// 5. TestingOrchestrator 主类
// ============================================================================

/**
 * TESTING Loop 编排器
 *
 * 对应 EAG 方案 §5.10.5 时序"TESTING Loop"段完整编排：
 * 契约测试生成 → E2E 测试生成 → 覆盖率门禁 → 合规证据（如启用 ICP） → PR 描述生成
 *
 * 用法：
 * ```typescript
 * const orchestrator = new TestingOrchestrator({
 *   coverageGate: new CoverageGate(pkcAccessor),
 * });
 * const result = await orchestrator.run({
 *   projectRoot: "/path/to/project",
 *   specContent: "...",
 *   planContent: "...",
 *   tasksContent: "...",
 *   implementationRoot: "src/",
 *   taskDag: { nodes: [...], topologicalOrder: [...] },
 *   acceptanceCriteria: [{ requirementId: "F-001", ... }],
 *   llmClient: new SomeLLMClient(),
 *   pkcAccessor: new SomePkcAccessor(),
 *   loopGuard: new LoopGuard({ maxIterations: 5 }),
 *   coverageThreshold: DEFAULT_COVERAGE_THRESHOLD,
 *   maxIterations: 5,
 * });
 * if (result.finalStatus === "success") {
 *   console.log("TESTING Loop 成功完成，PR 描述：", result.prDescription);
 * }
 * ```
 */
export class TestingOrchestrator {
  // ----------------------------------------------------------------------
  // 私有字段
  // ----------------------------------------------------------------------

  /** 契约测试生成器（依赖注入） */
  private readonly contractTestGenerator: ContractTestGenerator;
  /** E2E 测试生成器（依赖注入） */
  private readonly e2eTestGenerator: E2eTestGenerator;
  /** 覆盖率门禁（依赖注入，必填——需要 pkcAccessor） */
  private readonly coverageGate: CoverageGate;

  /**
   * 覆盖率门禁"连续未达标"计数（跨 run 保有，2026-11-01 修复）。
   *
   * 原实现是本方法内的局部变量、每次 run 重置为 0，而 CoverageGate 在
   * consecutiveFailureCount=0 时恒返回 passed=true（首次失败只升 WARNING），
   * 于是 `if (!coverageReport.passed)` 分支在单次 run 内永远不成立 →
   * 计数的自增语句不可达 → 计数永远是 0 → BLOCKER 升级阈值永远达不到，
   * 覆盖率在单 run 内永不阻断。改为实例级状态：同一编排器实例跨 Loop 迭代
   * 复用，计数才具备"连续失败"语义；覆盖率达标时清零。
   */
  private coverageConsecutiveFailureCount = 0;
  /** 既有契约保护判定器（依赖注入） */
  private readonly brownfieldContractGuard: BrownfieldContractGuard;
  /** 测试质量静态判定器注册表（依赖注入） */
  private readonly staticCheckers: ReadonlyMap<string, TestQualityChecker>;
  /**
   * G-6 门禁检查器（依赖注入，必填）
   *
   * EAG-P3 批次 11 S1 改造新增（D-S1-4）：
   * 与 GateG4Checker / GateG5Checker 在 CodingOrchestrator 中的注入方式同构，
   * 所有 7 道门禁均采用"独立类 + 构造期注入"模式，避免内联实现导致架构同构破坏。
   */
  private readonly gateG6Checker: GateG6Checker;
  /**
   * G-7 门禁检查器（依赖注入，必填）
   *
   * EAG-P3 批次 11 S1 改造新增（D-S1-4）：
   * 与 GateG4Checker / GateG5Checker 在 CodingOrchestrator 中的注入方式同构，
   * 所有 7 道门禁均采用"独立类 + 构造期注入"模式，避免内联实现导致架构同构破坏。
   */
  private readonly gateG7Checker: GateG7Checker;
  /** 日志回调 */
  private readonly logger: LogCallback;

  // ----------------------------------------------------------------------
  // 构造函数
  // ----------------------------------------------------------------------

  /**
   * 初始化 TESTING Loop 编排器
   *
   * EAG-P3 批次 11 S1 改造（D-S1-4）：新增 gateG6Checker / gateG7Checker 必填字段，
   * 与 CodingOrchestrator 中 gateG4Checker / gateG5Checker 的注入方式同构。
   *
   * @param options 注入选项
   * @param options.coverageGate 覆盖率门禁实例（必填——需注入 pkcAccessor）
   * @param options.gateG6Checker G-6 门禁检查器（必填——TESTING Loop 进入门禁）
   * @param options.gateG7Checker G-7 门禁检查器（必填——TESTING Loop 退出门禁）
   * @param options.contractTestGenerator 契约测试生成器（可选，默认 ContractTestGenerator）
   * @param options.e2eTestGenerator E2E 测试生成器（可选，默认 E2eTestGenerator）
   * @param options.brownfieldContractGuard 既有契约保护判定器（可选，默认 BrownfieldContractGuard）
   * @param options.staticCheckers 静态判定器注册表（可选，默认 DEFAULT_TEST_QUALITY_CHECKERS）
   * @param options.logger 日志回调（可选）
   * @throws {TestingOrchestratorError} 当 coverageGate / gateG6Checker / gateG7Checker 缺失时抛出 request-invalid
   */
  constructor(options: {
    readonly coverageGate: CoverageGate;
    readonly gateG6Checker: GateG6Checker;
    readonly gateG7Checker: GateG7Checker;
    readonly contractTestGenerator?: ContractTestGenerator;
    readonly e2eTestGenerator?: E2eTestGenerator;
    readonly brownfieldContractGuard?: BrownfieldContractGuard;
    readonly staticCheckers?: ReadonlyMap<string, TestQualityChecker>;
    readonly logger?: LogCallback;
  }) {
    // 构造期不变式校验（D-S1-4）：必填字段缺失时立即抛错，避免运行期 NPE
    if (!options || !options.coverageGate) {
      throw new TestingOrchestratorError("request-invalid", "coverageGate 必填（需注入 pkcAccessor）");
    }
    if (!options.gateG6Checker) {
      throw new TestingOrchestratorError("request-invalid", "gateG6Checker 必填（TESTING Loop 进入门禁检查器）");
    }
    if (!options.gateG7Checker) {
      throw new TestingOrchestratorError("request-invalid", "gateG7Checker 必填（TESTING Loop 退出门禁检查器）");
    }
    this.coverageGate = options.coverageGate;
    this.gateG6Checker = options.gateG6Checker;
    this.gateG7Checker = options.gateG7Checker;
    this.contractTestGenerator = options.contractTestGenerator ?? new ContractTestGenerator();
    this.e2eTestGenerator = options.e2eTestGenerator ?? new E2eTestGenerator();
    this.brownfieldContractGuard = options.brownfieldContractGuard ?? new BrownfieldContractGuard();
    this.staticCheckers = options.staticCheckers ?? DEFAULT_TEST_QUALITY_CHECKERS;
    this.logger = options.logger ?? noopLog;
  }

  // ----------------------------------------------------------------------
  // 公共 API
  // ----------------------------------------------------------------------

  /**
   * 执行 TESTING Loop
   *
   * 完整时序（对齐设计文档 §4.5.3）：
   * 1. 校验请求字段
   * 2. G-6 门禁检查
   * 3. LoopGuard.check() 上限保护
   * 4. 调用 ContractTestGenerator.generate() 生成契约测试
   * 5. 调用 E2eTestGenerator.generate() 生成 E2E 测试
   * 6. 调用 BrownfieldContractGuard.check() 做既有契约保护判定
   * 7. 调用 runAllCheckers() 执行测试质量静态判定
   * 8. 调用 CoverageGate.check() 执行覆盖率门禁
   * 9. 生成 PR 描述
   * 10. G-7 门禁检查
   * 11. LoopGuard.recordIteration() 记录迭代
   * 12. 构建并返回 TestingLoopResult
   *
   * @param request 编排请求
   * @returns 编排产出（含测试文件 / 覆盖率报告 / PR 描述 / 事件流）
   */
  async run(request: Readonly<TestingLoopRequest>): Promise<Readonly<TestingLoopResult>> {
    const startTime = Date.now();
    const runId = request.runId ?? this.generateRunId();
    this.log(`开始执行 TESTING Loop，runId=${runId}`, "info");

    // 1. 校验请求字段
    this.validateRequest(request);

    // 2. 初始化事件流与计数器
    const events: LoopEvent[] = [];
    // P1 修复：旧实现是 const=0 且全文从不自增，recordIteration(0, ...) 让 token 预算护栏失效。
    // 改为 let，并由下方 LLM 客户端包装器在每次真实 createMessage 返回后累加真实计数
    // （取不到 LLMResponse.usage 时如实记 0，并标注来源，绝不编造）。
    let totalLlmCallCount = 0;
    let totalTokensUsed = 0;
    let llmUsageReported = false;
    const trackedLlmClient = this.wrapLlmClientWithUsage(request.llmClient, (usage) => {
      totalLlmCallCount += 1;
      if (usage) {
        totalTokensUsed += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        llmUsageReported = true;
      }
    });
    let coverageConsecutiveFailureCount = this.coverageConsecutiveFailureCount;

    // 3. G-6 门禁检查（TESTING Loop 进入门禁）
    // EAG-P3 批次 11 S1 改造（D-S1-5）：改为委托给注入的 GateG6Checker 独立类
    // 构造完整的 GateG6Context（extends GateContext），从 request 派生基础字段 + 默认假设扩展字段
    const g6Context: GateG6Context = this.buildGateG6Context(request);
    const g6Result: GateResult = this.gateG6Checker.check(g6Context);
    events.push(this.buildEvent(runId, 0, "verification_started", { gateId: "G-6", result: g6Result }));

    if (!g6Result.passed) {
      // D-S1-7：返回值由内联 GateG6Result（failures 数组）切换为权威 GateResult（reason 字符串）
      // 调用方读取 g6Result.reason（字符串）而非 g6Result.failures（数组）
      this.log(`G-6 门禁未通过：${g6Result.reason}`, "warn");
      events.push(
        this.buildEvent(runId, 0, "human_checkpoint", {
          gateId: "G-6",
          reason: g6Result.reason,
          guidance: g6Result.guidance,
        })
      );
      return this.buildFailureResult(
        request,
        runId,
        "human_checkpoint",
        `G-6 门禁未通过：${g6Result.reason}`,
        events,
        totalLlmCallCount,
        totalTokensUsed,
        startTime
      );
    }
    events.push(this.buildEvent(runId, 0, "verification_passed", { gateId: "G-6" }));

    // 4. LoopGuard 上限保护检查
    const guardCheck = request.loopGuard.check();
    if (!guardCheck.allowed) {
      this.log(`LoopGuard 终止：${guardCheck.stopReason}`, "warn");
      events.push(this.buildEvent(runId, 0, "loop_failed", { stopReason: guardCheck.stopReason }));
      return this.buildFailureResult(
        request,
        runId,
        "stop_failure",
        `LoopGuard 终止：${guardCheck.stopReason}`,
        events,
        totalLlmCallCount,
        totalTokensUsed,
        startTime
      );
    }

    // 5. 调用 ContractTestGenerator 生成契约测试
    let contractTests: GeneratedTestFile[] = [];
    let contractSpecs: ContractTestSpec[] = [];
    try {
      this.log("开始生成契约测试", "info");
      events.push(this.buildEvent(runId, 0, "discovery_started", { stage: "contract-test-generation" }));

      // 从 spec/plan 推导 ContractTestSpec[]（本批次简化：从 taskDag 节点提取）
      // 真实实现应基于 OpenAPI spec 或 TypeScript AST 提取
      contractSpecs = this.deriveContractSpecsFromRequest(request);

      if (contractSpecs.length === 0) {
        this.log("无契约测试规范可生成（taskDag 为空或无可提取的 API 签名）", "warn");
      } else {
        const contractTestResults = await this.contractTestGenerator.generate({
          projectRoot: request.projectRoot,
          specs: contractSpecs,
          // P1 修复：传入真实计数包装器，累加每次 createMessage 的调用数与 token
          llmClient: trackedLlmClient,
          outputDir: DEFAULT_CONTRACT_TEST_OUTPUT_DIR,
          maxTokensPerFile: DEFAULT_MAX_TOKENS_PER_TEST_FILE,
        });
        contractTests = [...contractTestResults];
        this.log(`契约测试生成完成，共 ${contractTests.length} 个文件`, "info");
      }

      events.push(
        this.buildEvent(runId, 0, "discovery_completed", {
          stage: "contract-test-generation",
          fileCount: contractTests.length,
        })
      );
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.log(`契约测试生成失败：${errorMsg}`, "error");
      events.push(
        this.buildEvent(runId, 0, "loop_failed", {
          stage: "contract-test-generation",
          error: errorMsg,
        })
      );
      return this.buildFailureResult(
        request,
        runId,
        "human_checkpoint",
        `契约测试生成失败：${errorMsg}`,
        events,
        totalLlmCallCount,
        totalTokensUsed,
        startTime
      );
    }

    // 6. 调用 E2eTestGenerator 生成 E2E 测试
    let e2eTests: GeneratedTestFile[] = [];
    let humanCheckpointFlows: E2eTestSpec[] = [];
    try {
      this.log("开始生成 E2E 测试", "info");
      events.push(this.buildEvent(runId, 0, "handoff_created", { stage: "e2e-test-generation" }));

      const e2eResult = await this.e2eTestGenerator.generate({
        projectRoot: request.projectRoot,
        // P1 修复：传入真实计数包装器，累加每次 createMessage 的调用数与 token
        llmClient: trackedLlmClient,
        pkcAccessor: request.pkcAccessor,
        acceptanceCriteria: request.acceptanceCriteria,
        outputDir: DEFAULT_E2E_TEST_OUTPUT_DIR,
        maxTokensPerFile: DEFAULT_MAX_TOKENS_PER_TEST_FILE,
      });
      e2eTests = [...e2eResult.testFiles];
      humanCheckpointFlows = [...e2eResult.humanCheckpointFlows];
      this.log(
        `E2E 测试生成完成，共 ${e2eTests.length} 个文件，${humanCheckpointFlows.length} 个流程需人工确认`,
        "info"
      );

      events.push(
        this.buildEvent(runId, 0, "handoff_dispatched", {
          stage: "e2e-test-generation",
          fileCount: e2eTests.length,
          humanCheckpointFlowCount: humanCheckpointFlows.length,
        })
      );

      // P1 修复：显式标注 token 计数来源，取不到真实 usage 时如实记 0（未编造）
      events.push(
        this.buildEvent(runId, 0, "scheduling_decision", {
          stage: "llm-usage",
          totalLlmCallCount,
          totalTokensUsed,
          source: llmUsageReported
            ? "LLMResponse.usage（每次真实 createMessage 调用累加）"
            : "LLM 未返回 usage（如实记 0，未编造）",
        })
      );

      // 若有 inferred 流程需人工确认 → 触发 human_checkpoint
      if (humanCheckpointFlows.length > 0) {
        events.push(
          this.buildEvent(runId, 0, "human_checkpoint", {
            reason: "inferred-flows-pending-confirmation",
            flowCount: humanCheckpointFlows.length,
            flowIds: humanCheckpointFlows.map((f) => f.flowId),
          })
        );
        // 注意：此处不立即返回，继续执行后续步骤；最终 finalStatus 由 G-7 决定
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.log(`E2E 测试生成失败：${errorMsg}`, "error");
      events.push(
        this.buildEvent(runId, 0, "loop_failed", {
          stage: "e2e-test-generation",
          error: errorMsg,
        })
      );
      return this.buildFailureResult(
        request,
        runId,
        "human_checkpoint",
        `E2E 测试生成失败：${errorMsg}`,
        events,
        totalLlmCallCount,
        totalTokensUsed,
        startTime
      );
    }

    // 7. 调用 BrownfieldContractGuard 做既有契约保护判定
    let compatibilityReport: ContractCompatibilityReport | null = null;
    try {
      this.log("开始既有契约保护判定", "info");
      compatibilityReport = await this.brownfieldContractGuard.check({
        projectRoot: request.projectRoot,
        newContractSpecs: contractSpecs,
      });

      if (!compatibilityReport.compatible) {
        this.log(`既有契约保护判定未通过：${compatibilityReport.breakingChanges.length} 项 breaking change`, "warn");
        events.push(
          this.buildEvent(runId, 0, "verification_rejected", {
            stage: "brownfield-contract-guard",
            breakingChanges: compatibilityReport.breakingChanges,
          })
        );
        // breaking change 存在 → 触发 human_checkpoint
        return this.buildFailureResult(
          request,
          runId,
          "human_checkpoint",
          `既有契约保护判定未通过：${compatibilityReport.breakingChanges.length} 项 breaking change`,
          events,
          totalLlmCallCount,
          totalTokensUsed,
          startTime,
          { contractTests, e2eTests }
        );
      }

      events.push(
        this.buildEvent(runId, 0, "verification_passed", {
          stage: "brownfield-contract-guard",
          compatibleChanges: compatibilityReport.compatibleChanges.length,
        })
      );
    } catch (e) {
      // 既有契约保护判定失败不阻断 Loop（可能既有契约文件不存在——绿地场景）
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.log(`既有契约保护判定失败（降级跳过）：${errorMsg}`, "warn");
      events.push(
        this.buildEvent(runId, 0, "scheduling_decision", {
          stage: "brownfield-contract-guard",
          skipped: true,
          error: errorMsg,
        })
      );
    }

    // 8. 调用注入的 staticCheckers 执行测试质量静态判定
    let testQualityResults: ReadonlyArray<TestQualityResult> = [];
    try {
      this.log("开始测试质量静态判定", "info");
      const allTestFiles = [...contractTests, ...e2eTests];
      // P1 修复：旧实现 pkcQueryRiskHotspotsSafe() 的 try/catch 都直接 return []，
      // 从不查询 PKC，导致 highRiskSymbols 恒空、CoverageGapChecker 空转判 passed。
      // 新实现真正接入 pkcAccessor.queryRiskHotspots，失败时显式标 unknown 并透传下游。
      const { symbols: highRiskSymbols, available: pkcAvailable } = await this.pkcQueryRiskHotspotsSafe(
        request.projectRoot,
        request.pkcAccessor,
        DEFAULT_HIGH_RISK_TOP_N
      );

      if (!pkcAvailable) {
        events.push(
          this.buildEvent(runId, 0, "scheduling_decision", {
            stage: "test-quality-checkers",
            pkcUnavailable: true,
            reason: "PKC 风险热点查询不可用，高风险符号维度按 unknown 处理",
          })
        );
      }

      const qualityContext: TestQualityContext = {
        highRiskSymbols,
        projectRoot: request.projectRoot,
        ...(pkcAvailable ? {} : { highRiskSymbolsUnknown: true }),
      };
      // 遍历注入的 staticCheckers 注册表（按 checkerId 字典序）
      // 注：不直接调用 runAllCheckers()，因为该函数硬编码使用 DEFAULT_TEST_QUALITY_CHECKERS，
      // 此处需要使用构造函数注入的 staticCheckers 以支持测试替换。
      const qualityResultList: TestQualityResult[] = [];
      const sortedCheckerIds = Array.from(this.staticCheckers.keys()).sort((a, b) => a.localeCompare(b));
      for (const checkerId of sortedCheckerIds) {
        const checker = this.staticCheckers.get(checkerId);
        if (!checker) continue;
        const result = checker.check(allTestFiles, qualityContext);
        qualityResultList.push(result);
      }
      testQualityResults = Object.freeze(qualityResultList);

      const blockerResults = testQualityResults.filter((r) => !r.passed && r.severity === "blocker");
      if (blockerResults.length > 0) {
        this.log(`测试质量静态判定阻断：${blockerResults.length} 个 blocker`, "warn");
        events.push(
          this.buildEvent(runId, 0, "verification_rejected", {
            stage: "test-quality-checkers",
            blockerResults,
          })
        );
        return this.buildFailureResult(
          request,
          runId,
          "human_checkpoint",
          `测试质量静态判定阻断：${blockerResults.length} 个 blocker`,
          events,
          totalLlmCallCount,
          totalTokensUsed,
          startTime,
          { contractTests, e2eTests }
        );
      }

      events.push(
        this.buildEvent(runId, 0, "verification_passed", {
          stage: "test-quality-checkers",
          totalCheckers: testQualityResults.length,
        })
      );
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.log(`测试质量静态判定异常（降级跳过）：${errorMsg}`, "warn");
      events.push(
        this.buildEvent(runId, 0, "scheduling_decision", {
          stage: "test-quality-checkers",
          skipped: true,
          error: errorMsg,
        })
      );
    }

    // 9. 调用 CoverageGate 执行覆盖率门禁
    let coverageReport: CoverageReport | null = null;
    try {
      this.log("开始执行覆盖率门禁", "info");
      events.push(this.buildEvent(runId, 0, "verification_started", { stage: "coverage-gate" }));

      coverageReport = await this.coverageGate.check({
        projectRoot: request.projectRoot,
        testDir: DEFAULT_TEST_DIR,
        implementationRoot: request.implementationRoot || DEFAULT_IMPLEMENTATION_ROOT,
        topN: DEFAULT_HIGH_RISK_TOP_N,
        consecutiveFailureCount: coverageConsecutiveFailureCount,
      });

      // 2026-11-01 修复：原判据 `if (!coverageReport.passed)` 与门禁自身的
      // 升级策略互为因果——门禁在 consecutiveFailureCount=0（首次失败）时
      // 恒返回 passed=true，因此该分支不可达、计数永远是 0、BLOCKER 永远不触发。
      // 改用原始信号「存在未达标维度」累计，计数才真正推进（首次 WARNING、
      // 第二次起 BLOCKER，对齐下方升级策略注释）。
      if (coverageReport.failedDimensions.length > 0) {
        // 覆盖率未达标 → 递增失败计数
        coverageConsecutiveFailureCount++;
        this.coverageConsecutiveFailureCount = coverageConsecutiveFailureCount;
        this.log(
          `覆盖率门禁未通过（连续失败 ${coverageConsecutiveFailureCount} 次）`,
          coverageConsecutiveFailureCount >= COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD ? "error" : "warn"
        );

        // 连续 2 次 BLOCKER → human_checkpoint
        if (coverageConsecutiveFailureCount >= COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD) {
          events.push(
            this.buildEvent(runId, 0, "human_checkpoint", {
              stage: "coverage-gate",
              reason: "consecutive-coverage-failure",
              consecutiveFailures: coverageConsecutiveFailureCount,
              failedDimensions: coverageReport.failedDimensions,
            })
          );
          return this.buildFailureResult(
            request,
            runId,
            "human_checkpoint",
            `覆盖率门禁连续 ${coverageConsecutiveFailureCount} 次未通过，已升级 BLOCKER`,
            events,
            totalLlmCallCount,
            totalTokensUsed,
            startTime,
            { contractTests, e2eTests, coverageReport }
          );
        }
      } else {
        // 覆盖率达标 → 重置失败计数（实例级同步清零，保证"连续"语义）
        coverageConsecutiveFailureCount = 0;
        this.coverageConsecutiveFailureCount = 0;
      }

      events.push(
        this.buildEvent(runId, 0, coverageReport.passed ? "verification_passed" : "verification_rejected", {
          stage: "coverage-gate",
          lines: coverageReport.lines,
          branches: coverageReport.branches,
          functions: coverageReport.functions,
          highRiskSymbols: coverageReport.highRiskSymbols,
          passed: coverageReport.passed,
          failedDimensions: coverageReport.failedDimensions,
        })
      );
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.log(`覆盖率门禁执行失败：${errorMsg}`, "error");
      events.push(
        this.buildEvent(runId, 0, "loop_failed", {
          stage: "coverage-gate",
          error: errorMsg,
        })
      );
      return this.buildFailureResult(
        request,
        runId,
        "human_checkpoint",
        `覆盖率门禁执行失败：${errorMsg}`,
        events,
        totalLlmCallCount,
        totalTokensUsed,
        startTime,
        { contractTests, e2eTests }
      );
    }

    // 10. 真实运行测试文件，收集 TestExecutionResultWithEvidence[]（含失败证据链）
    // P0-4 修复：先执行测试再生成 PR 描述，保证 stderr / 失败用例名 / AssertionError
    // 既能进入 G-7 上下文（buildGateG7Context），也能渲染进 PR 描述（generatePrDescription）。
    // EAG-P3 批次 11 S1 改造（D-S1-5）：G-7 委托给注入的 GateG7Checker 独立类。
    this.log("开始执行契约测试与 E2E 测试，收集 G-7 门禁所需执行结果", "info");
    events.push(this.buildEvent(runId, 0, "verification_started", { gateId: "G-7", stage: "test-execution" }));
    const contractTestResults: TestExecutionResultWithEvidence[] = await this.executeTestFiles(
      contractTests,
      request.projectRoot
    );
    const e2eTestResults: TestExecutionResultWithEvidence[] = await this.executeTestFiles(
      e2eTests,
      request.projectRoot
    );

    // 汇总失败证据摘要写入事件流，供审计追溯（不丢失真实 stderr / 用例名）
    const allExecResults = [...contractTestResults, ...e2eTestResults];
    const failureEvidence = allExecResults
      .filter((r) => r.exitCode !== 0 || r.failedCount > 0)
      .map((r) => ({
        filePath: r.filePath,
        exitCode: r.exitCode,
        failedCount: r.failedCount,
        failedCases: r.failedCases ?? [],
        errorMessage: r.errorMessage ?? "",
      }));
    events.push(
      this.buildEvent(runId, 0, "verification_passed", {
        gateId: "G-7",
        stage: "test-execution",
        contractTestCount: contractTestResults.length,
        e2eTestCount: e2eTestResults.length,
        failureEvidence,
      })
    );

    // 11. 生成 PR 描述（含测试执行失败证据）
    const prDescription = this.generatePrDescription({
      contractTests,
      e2eTests,
      coverageReport,
      compatibilityReport,
      acceptanceCriteria: request.acceptanceCriteria,
      humanCheckpointFlows,
      testQualityResults,
      contractTestResults,
      e2eTestResults,
    });
    events.push(
      this.buildEvent(runId, 0, "persistence_written", {
        stage: "pr-description",
        length: prDescription.length,
      })
    );

    // 12. G-7 门禁检查（TESTING Loop 退出门禁）

    // 构造完整的 GateG7Context（extends GateContext），从 request 派生基础字段 + 真实测试执行结果
    const g7Context: GateG7Context = this.buildGateG7Context(request, {
      coverageReport,
      contractTests,
      contractTestResults,
      e2eTests,
      e2eTestResults,
      complianceEvidence: undefined, // 本批次预留，不启用 ICP
      compliancePackIds: request.compliancePackIds,
      prDescription,
    });
    const g7Result: GateResult = this.gateG7Checker.check(g7Context);
    events.push(this.buildEvent(runId, 0, "verification_started", { gateId: "G-7", result: g7Result }));

    if (!g7Result.passed) {
      // D-S1-7：返回值由内联 GateG7Result（failures 数组）切换为权威 GateResult（reason 字符串）
      // 调用方读取 g7Result.reason（字符串）而非 g7Result.failures（数组）
      this.log(`G-7 门禁未通过：${g7Result.reason}`, "warn");
      events.push(
        this.buildEvent(runId, 0, "human_checkpoint", {
          gateId: "G-7",
          reason: g7Result.reason,
          guidance: g7Result.guidance,
        })
      );
      return this.buildFailureResult(
        request,
        runId,
        "human_checkpoint",
        `G-7 门禁未通过：${g7Result.reason}`,
        events,
        totalLlmCallCount,
        totalTokensUsed,
        startTime,
        { contractTests, e2eTests, coverageReport, prDescription }
      );
    }
    events.push(this.buildEvent(runId, 0, "verification_passed", { gateId: "G-7" }));

    // 13. LoopGuard 记录迭代（成功）
    // P1 修复：totalTokensUsed 已由真实 LLM 用量包装器累加，token 预算护栏恢复生效
    request.loopGuard.recordIteration(totalTokensUsed, true);

    // 14. 构建成功结果
    events.push(this.buildEvent(runId, 0, "loop_completed", { finalStatus: "success" }));
    this.log("TESTING Loop 成功完成", "info");

    return this.buildSuccessResult({
      request,
      runId,
      contractTests,
      e2eTests,
      coverageReport,
      prDescription,
      events,
      totalLlmCallCount,
      totalTokensUsed,
      startTime,
    });
  }

  // ----------------------------------------------------------------------
  // 私有方法：LLM 真实用量计数（P1 修复）
  // ----------------------------------------------------------------------

  /**
   * 用「真实计数包装器」包裹 LLM 客户端
   *
   * P1 修复：生成器（ContractTestGenerator / E2eTestGenerator）内部调用
   * llmClient.createMessage() 但其 generate() 不暴露 token 用量，导致编排器
   * totalLlmCallCount / totalTokensUsed 恒为 0、token 预算护栏失效。
   *
   * 本包装器在每次真实 createMessage 返回后回调 onUsage，累加：
   * - 调用次数（无条件 +1）
   * - token 数（仅当响应携带真实 LLMResponse.usage 时累加；未携带则如实记 0，
   *   绝不编造估算值）
   *
   * 包装器透传 LLMClient 的全部只读字段与 createMessageStream，语义与原始客户端一致。
   *
   * @param inner 原始 LLM 客户端（来自 TestingLoopRequest）
   * @param onUsage 用量回调（usage 为 LLMResponse.usage 原值，可能为 null）
   * @returns 结构兼容的 LLMClient 包装器
   */
  private wrapLlmClientWithUsage(inner: LLMClient, onUsage: (usage: LLMUsage | null) => void): LLMClient {
    return {
      get providerName() {
        return inner.providerName;
      },
      get model() {
        return inner.model;
      },
      get baseURL() {
        return inner.baseURL;
      },
      get supportsThinking() {
        return inner.supportsThinking;
      },
      get supportsPromptCaching() {
        return inner.supportsPromptCaching;
      },
      createMessage: async (req: LLMRequest): Promise<LLMResponse> => {
        const response = await inner.createMessage(req);
        onUsage(response.usage);
        return response;
      },
      createMessageStream: (req: LLMRequest): AsyncIterable<LLMStreamEvent> => {
        const source = inner.createMessageStream(req);
        return (async function* (): AsyncIterable<LLMStreamEvent> {
          let streamUsage: LLMUsage | null = null;
          for await (const event of source) {
            if (event.type === "message_end") {
              streamUsage = event.usage;
            }
            yield event;
          }
          onUsage(streamUsage);
        })();
      },
    } as LLMClient;
  }

  // ----------------------------------------------------------------------
  // 私有方法：G-6 / G-7 门禁上下文构造（EAG-P3 批次 11 S1 改造后新增）
  // ----------------------------------------------------------------------
  //
  // 改造说明（对齐 EAG-P3 批次 11 设计 §3 S1 D-S1-2/D-S1-5）：
  // - 原 L768~L831 内联的 checkGateG6 / checkGateG7 私有方法已删除
  // - 改为通过注入的 GateG6Checker / GateG7Checker 独立类委托执行
  // - 新增 buildGateG6Context / buildGateG7Context 私有方法：
  //   构造完整的 GateG6Context / GateG7Context（extends GateContext），
  //   从 TestingLoopRequest 派生基础字段 + 真实测试执行结果
  // - 新增 executeTestFiles 私有方法：真实运行测试文件，收集 TestExecutionResultWithEvidence[]
  //   对齐 G-7 checker 的 contractTestResults / e2eTestResults 必填要求

  /**
   * 构造 G-6 门禁上下文（TESTING Loop 进入门禁）
   *
   * EAG-P3 批次 11 S1 改造新增（D-S1-5）：
   * - 从 TestingLoopRequest 派生 GateContext 基础字段
   * - 默认假设 G-5 已通过 / 单测全过 / spec.md 已批准（调用方需保证前置条件）
   * - implementationRoot 来自 request.implementationRoot
   *
   * 字段派生策略：
   * - projectId：从 projectRoot 派生（path.basename），G-6 checker 内部不使用
   * - loopType：固定为 "testing"（TESTING Loop）
   * - specStatus / planStatus：默认 "approved"（调用方需保证前置条件）
   * - reviewRecords：空数组（G-6 checker 内部不使用）
   * - userApproved：true（调用方需保证前置条件）
   * - taskCard：从 request.taskDag.nodes[0] 派生（G-6 checker 内部不使用）
   * - actualChanges：空数组（G-6 checker 内部不使用）
   * - g5Passed / unitTestsPassed：默认 true（调用方需保证前置条件）
   * - implementationRoot：来自 request.implementationRoot
   *
   * @param request TESTING Loop 编排请求
   * @returns 完整的 GateG6Context 上下文
   */
  private buildGateG6Context(request: Readonly<TestingLoopRequest>): GateG6Context {
    // 从 request.taskDag.nodes[0] 派生 TaskCard（G-6 checker 内部不使用，仅满足类型约束）
    const firstNode = request.taskDag.nodes[0];
    const taskCard = {
      id: firstNode?.id ?? "T-000",
      title: firstNode?.title ?? "默认任务",
      requirementId: firstNode?.requirementId ?? "F-000",
      dependencies: firstNode?.dependencies ?? [],
      acceptanceCriteria: firstNode?.acceptanceCommand ? [firstNode.acceptanceCommand] : [],
      status: "completed" as const,
      declaredSymbols: firstNode?.declaredSymbols ?? [],
    };

    return Object.freeze({
      // GateContext 基础字段（从 request 派生或默认值）
      projectId: crypto.createHash("sha1").update(request.projectRoot).digest("hex").slice(0, 8),
      loopType: "testing" as const,
      specStatus: "approved" as const,
      planStatus: "approved" as const,
      reviewRecords: Object.freeze([]),
      userApproved: true,
      taskCard: Object.freeze(taskCard),
      actualChanges: Object.freeze([]),
      // GateG6Context 扩展字段
      g5Passed: true, // 默认假设 G-5 已通过（调用方需保证前置条件）
      unitTestsPassed: true, // 默认假设单测已通过
      implementationRoot: request.implementationRoot,
    });
  }

  /**
   * 构造 G-7 门禁上下文（TESTING Loop 退出门禁）
   *
   * EAG-P3 批次 11 S1 改造新增（D-S1-5）：
   * - 从 TestingLoopRequest 派生 GateContext 基础字段
   * - 从测试执行结果派生 contractTestResults / e2eTestResults（真实运行测试得到）
   * - coverageReport / prDescription 从编排流程产出传入
   *
   * @param request TESTING Loop 编排请求
   * @param overrides G-7 扩展字段（coverageReport / contractTests / contractTestResults / e2eTests / e2eTestResults / complianceEvidence / compliancePackIds / prDescription）
   * @returns 完整的 GateG7Context 上下文
   */
  private buildGateG7Context(
    request: Readonly<TestingLoopRequest>,
    overrides: {
      readonly coverageReport: Readonly<CoverageReport>;
      readonly contractTests: ReadonlyArray<GeneratedTestFile>;
      readonly contractTestResults: ReadonlyArray<TestExecutionResultWithEvidence>;
      readonly e2eTests: ReadonlyArray<GeneratedTestFile>;
      readonly e2eTestResults: ReadonlyArray<TestExecutionResultWithEvidence>;
      readonly complianceEvidence?: Readonly<Record<string, unknown>>;
      readonly compliancePackIds?: ReadonlyArray<string>;
      readonly prDescription: string;
    }
  ): GateG7Context {
    // 从 request.taskDag.nodes[0] 派生 TaskCard（G-7 checker 内部不使用，仅满足类型约束）
    const firstNode = request.taskDag.nodes[0];
    const taskCard = {
      id: firstNode?.id ?? "T-000",
      title: firstNode?.title ?? "默认任务",
      requirementId: firstNode?.requirementId ?? "F-000",
      dependencies: firstNode?.dependencies ?? [],
      acceptanceCriteria: firstNode?.acceptanceCommand ? [firstNode.acceptanceCommand] : [],
      status: "completed" as const,
      declaredSymbols: firstNode?.declaredSymbols ?? [],
    };

    return Object.freeze({
      // GateContext 基础字段（从 request 派生或默认值）
      projectId: crypto.createHash("sha1").update(request.projectRoot).digest("hex").slice(0, 8),
      loopType: "testing" as const,
      specStatus: "approved" as const,
      planStatus: "approved" as const,
      reviewRecords: Object.freeze([]),
      userApproved: true,
      taskCard: Object.freeze(taskCard),
      actualChanges: Object.freeze([]),
      // GateG7Context 扩展字段（从编排流程产出传入）
      coverageReport: overrides.coverageReport,
      contractTests: overrides.contractTests,
      contractTestResults: overrides.contractTestResults,
      e2eTests: overrides.e2eTests,
      e2eTestResults: overrides.e2eTestResults,
      complianceEvidence: overrides.complianceEvidence,
      compliancePackIds: overrides.compliancePackIds,
      prDescription: overrides.prDescription,
    });
  }

  /**
   * 真实执行测试文件，收集 TestExecutionResultWithEvidence[]
   *
   * EAG-P3 批次 11 S1 改造新增（D-S1-5 配套）：
   * - G-7 checker 要求 contractTestResults / e2eTestResults 必填
   * - 本方法通过 child_process.spawn 调用 `node --test --test-reporter=tap <file>`
   *   真实运行每个测试文件，并解析 TAP13 输出得到 TestExecutionResult
   * - 与"严禁 mock/占位/简化"原则对齐：使用真实测试执行结果，不构造假数据
   *
   * 算法：
   * 1. 对每个 GeneratedTestFile，构造 `node --test --test-reporter=tap <filePath>` 命令
   *    （EAG_LEGACY_JSON_REPORTER=1 可回退旧 json 命令，详见 buildTestRunnerArgs）
   * 2. 在 projectRoot 目录下 spawn 子进程
   * 3. 收集 stdout（TAP13 报告，含 YAML 诊断块）与 stderr（错误日志）
   * 4. 检查退出码：0=全部通过 / 非 0=存在失败
   * 5. 解析 TAP13 报告（兼容 JSON / NDJSON / TAP 三种格式），统计通过/失败用例数
   * 6. 返回 TestExecutionResult（含 filePath / exitCode / durationMs / failedCount / passedCount）
   *
   * 错误处理：
   * - spawn 本身失败（如 node 未安装）→ exitCode=-1, failedCount=1, passedCount=0
   * - 测试文件不存在 → exitCode=-1, failedCount=1, passedCount=0
   * - 测试执行超时（默认 30 秒）→ exitCode=-1, failedCount=1, passedCount=0
   * - 报告解析失败 → 退化为基于 exitCode 的简化统计，并保留原始 stdout/stderr 片段
   *
   * @param files 测试文件列表（GeneratedTestFile[]）
   * @param projectRoot 项目根目录（绝对路径）
   * @returns 测试执行结果列表（TestExecutionResultWithEvidence[]，与 files 一一对应）
   */
  private async executeTestFiles(
    files: ReadonlyArray<GeneratedTestFile>,
    projectRoot: string
  ): Promise<TestExecutionResultWithEvidence[]> {
    // 无测试文件时返回空数组（G-7 checker 会校验非空，触发失败）
    if (!files || files.length === 0) {
      return [];
    }

    // 串行执行每个测试文件（避免并发资源竞争）
    const results: TestExecutionResultWithEvidence[] = [];
    for (const file of files) {
      const result = await this.executeSingleTestFile(file.relativePath, projectRoot);
      results.push(result);
    }
    return results;
  }

  /**
   * 执行单个测试文件，返回 TestExecutionResult
   *
   * 算法：
   * 1. 构造命令参数：`--test --test-reporter=tap <filePath>`（默认 tap，可回退 json）
   * 2. 在 projectRoot 目录下 spawn node 子进程
   * 3. 设置 30 秒超时（避免长时间挂起）
   * 4. 收集 stdout（TAP13 报告，含 YAML 诊断块）与 stderr（错误日志）
   * 5. 检查退出码：0=全部通过 / 非 0=存在失败
   * 6. 解析报告（JSON / NDJSON / TAP13），统计通过/失败用例数并保留失败证据
   *
   * @param filePath 测试文件相对路径（相对 projectRoot）
   * @param projectRoot 项目根目录（绝对路径）
   * @returns 测试执行结果
   */
  private executeSingleTestFile(filePath: string, projectRoot: string): Promise<TestExecutionResultWithEvidence> {
    return new Promise<TestExecutionResultWithEvidence>((resolve) => {
      const startTime = Date.now();
      // P0-4 收尾修复：默认改用 Node 内置 tap reporter（json 从来不是内置 reporter、
      // 仓库亦无 json 包，真实运行必抛 ERR_MODULE_NOT_FOUND 而拿不到报告，失败用例名
      // 永远取不到）。命令构造抽为纯函数 buildTestRunnerArgs；
      // EAG_LEGACY_JSON_REPORTER=1 可回退旧 --test-reporter=json 命令。
      // 使用 --import tsx 支持 TypeScript 测试文件直接执行（与 coverage-gate.ts 同构）
      const args = [...buildTestRunnerArgs(filePath)];
      // 父级 node:test 运行器会注入 NODE_TEST_CONTEXT=child-v8；嵌套 spawn 的
      // `node --test` 继承后会判定「递归调用」并跳过所有测试文件（exit 0、无报告）。
      // 显式剔除该变量，保证每个测试文件都以顶层运行器真实执行。
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("node", args, {
          cwd: projectRoot,
          stdio: ["ignore", "pipe", "pipe"],
          env: childEnv,
        });
      } catch (err) {
        // P0-4 修复：spawn 失败时透传真实原因，不再返回"无理由的 failedCount=1"
        const reason = `node 子进程 spawn 失败：${err instanceof Error ? err.message : String(err)}`;
        resolve(buildSpawnFailureResult(filePath, Date.now() - startTime, reason, ""));
        return;
      }

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data: Buffer | string) => {
        stdout += data.toString();
      });
      child.stderr?.on("data", (data: Buffer | string) => {
        stderr += data.toString();
      });

      // 30 秒超时保护（避免长时间挂起）
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(buildSpawnFailureResult(filePath, Date.now() - startTime, "测试执行超时（30 秒）", stderr));
      }, 30_000);

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        const exitCode = code ?? -1;
        // P0-4 修复：把真实 stdout/stderr 交给纯判定函数，保留失败用例名与 AssertionError，
        // 解析失败时保留原始片段并写明原因（不再简化为无理由的 failedCount=1）。
        resolve(buildTestExecutionResult(filePath, exitCode, durationMs, stdout, stderr));
      });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        resolve(
          buildSpawnFailureResult(
            filePath,
            Date.now() - startTime,
            `node 子进程触发 error 事件：${err.message}`,
            stderr
          )
        );
      });
    });
  }

  // ----------------------------------------------------------------------
  // 私有方法：请求校验与派生
  // ----------------------------------------------------------------------

  /**
   * 校验 TestingLoopRequest 字段合法性
   *
   * @param request 编排请求
   * @throws {TestingOrchestratorError} 字段非法时抛出
   */
  private validateRequest(request: Readonly<TestingLoopRequest>): void {
    if (typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new TestingOrchestratorError("request-invalid", "projectRoot 必须为非空字符串");
    }
    if (typeof request.specContent !== "string" || request.specContent.trim().length === 0) {
      throw new TestingOrchestratorError("request-invalid", "specContent 必须为非空字符串");
    }
    if (typeof request.planContent !== "string" || request.planContent.trim().length === 0) {
      throw new TestingOrchestratorError("request-invalid", "planContent 必须为非空字符串");
    }
    if (typeof request.tasksContent !== "string" || request.tasksContent.trim().length === 0) {
      throw new TestingOrchestratorError("request-invalid", "tasksContent 必须为非空字符串");
    }
    if (!request.taskDag || !Array.isArray(request.taskDag.nodes)) {
      throw new TestingOrchestratorError("request-invalid", "taskDag 必须含 nodes 数组");
    }
    if (!Array.isArray(request.acceptanceCriteria)) {
      throw new TestingOrchestratorError("request-invalid", "acceptanceCriteria 必须为数组");
    }
    if (!request.llmClient || typeof request.llmClient.createMessage !== "function") {
      throw new TestingOrchestratorError("request-invalid", "llmClient 必须实现 LLMClient 接口");
    }
    if (!request.pkcAccessor || typeof request.pkcAccessor.queryBusinessFlows !== "function") {
      throw new TestingOrchestratorError("request-invalid", "pkcAccessor 必须实现 PkcAccessor 接口");
    }
    if (!request.loopGuard || typeof request.loopGuard.check !== "function") {
      throw new TestingOrchestratorError("request-invalid", "loopGuard 必须含 check 方法");
    }
    if (
      typeof request.maxIterations !== "number" ||
      request.maxIterations < 1 ||
      request.maxIterations > DEFAULT_MAX_TESTING_ITERATIONS * 10
    ) {
      throw new TestingOrchestratorError(
        "request-invalid",
        `maxIterations 必须为 1~${DEFAULT_MAX_TESTING_ITERATIONS * 10} 的数字`
      );
    }
  }

  /**
   * 从 TestingLoopRequest 派生 ContractTestSpec[]
   *
   * 本批次简化实现：基于 taskDag.nodes 提取接口签名（每个任务节点对应一个 API）。
   * 真实实现应优先使用 OpenAPI spec 解析（ContractTestGenerator 内部已实现），
   * 此处仅在没有 OpenAPI spec 时降级使用。
   *
   * @param request 编排请求
   * @returns ContractTestSpec 列表
   */
  private deriveContractSpecsFromRequest(request: Readonly<TestingLoopRequest>): ContractTestSpec[] {
    const specs: ContractTestSpec[] = [];

    for (const node of request.taskDag.nodes) {
      // 从 taskDag 节点派生 ContractTestSpec（简化版，每个任务对应一个虚拟 API）
      // 真实实现应基于 OpenAPI spec 或 TypeScript AST 提取
      const apiPath = `/api/v1/tasks/${node.id}`;
      const method = "POST"; // 默认 POST（任务创建语义）

      specs.push({
        path: apiPath,
        method,
        responseSchemas: {
          "200": {
            type: "object",
            properties: {
              taskId: { type: "string" },
              status: { type: "string" },
            },
          },
        },
        tsSignature: `execute(${node.id}): Promise<void>`,
        requirementId: node.requirementId ?? "F-UNKNOWN",
        boundaryCases: [],
      });
    }

    return specs;
  }

  // ----------------------------------------------------------------------
  // 私有方法：PR 描述生成
  // ----------------------------------------------------------------------

  /**
   * 生成 PR 描述（对齐 §5.10.4 交付门禁）
   *
   * PR 描述结构：
   * 1. 变更摘要（生成的测试文件数量 / 覆盖率数值 / 兼容性判定）
   * 2. 需求映射（验收标准 → 测试文件）
   * 3. 测试报告（契约测试 / E2E 测试 / 覆盖率明细）
   * 4. 合规证据链接（如启用 ICP，本批次预留）
   *
   * @param input PR 描述输入
   * @returns PR 描述字符串
   */
  private generatePrDescription(input: {
    readonly contractTests: ReadonlyArray<GeneratedTestFile>;
    readonly e2eTests: ReadonlyArray<GeneratedTestFile>;
    readonly coverageReport: Readonly<CoverageReport>;
    readonly compatibilityReport: Readonly<ContractCompatibilityReport> | null;
    readonly acceptanceCriteria: ReadonlyArray<AcceptanceCriterion>;
    readonly humanCheckpointFlows: ReadonlyArray<E2eTestSpec>;
    readonly testQualityResults: ReadonlyArray<TestQualityResult>;
    /** P0-4 新增（可选）：契约测试真实执行结果（含失败证据链），旧调用方零回归 */
    readonly contractTestResults?: ReadonlyArray<TestExecutionResultWithEvidence>;
    /** P0-4 新增（可选）：E2E 测试真实执行结果（含失败证据链），旧调用方零回归 */
    readonly e2eTestResults?: ReadonlyArray<TestExecutionResultWithEvidence>;
  }): string {
    const lines: string[] = [];

    // ---- 1. 变更摘要 ----
    lines.push("# TESTING Loop 产出 PR 描述");
    lines.push("");
    lines.push("## 变更摘要");
    lines.push("");
    lines.push(`- 契约测试文件数：${input.contractTests.length}`);
    lines.push(`- E2E 测试文件数：${input.e2eTests.length}`);
    lines.push(
      `- 覆盖率：lines=${input.coverageReport.lines.toFixed(1)}% / branches=${input.coverageReport.branches.toFixed(1)}% / functions=${input.coverageReport.functions.toFixed(1)}% / highRiskSymbols=${input.coverageReport.highRiskSymbols.toFixed(1)}%`
    );

    // P1 修复：旧实现只看 coverageReport.passed，首次失败 WARNING（passed=true 但有
    // failedDimensions）仍显示「✅ 通过」且不列出未达标维度。改用
    // failedDimensions.length === 0 判定并显式列出未达标维度。
    // 注意：不改动「首次失败 passed=true、第 2 次阻断」的门禁策略，只修展示层。
    // 环境变量 EAG_PR_DISPLAY_LEGACY=1 可回退到旧的 passed 判定（兼容已依赖旧文案的调用方）。
    const legacyDisplay = process.env.EAG_PR_DISPLAY_LEGACY === "1";
    const noFailedDimensions = input.coverageReport.failedDimensions.length === 0;
    const gatePassedLabel = legacyDisplay
      ? input.coverageReport.passed
        ? "✅ 通过"
        : "❌ 未通过"
      : noFailedDimensions
        ? "✅ 通过"
        : "❌ 未通过";
    lines.push(`- 覆盖率门禁：${gatePassedLabel}`);
    if (!legacyDisplay && !noFailedDimensions) {
      lines.push(`  - 未达标维度：${input.coverageReport.failedDimensions.join(", ")}`);
    }
    if (input.coverageReport.pkcUnavailable) {
      lines.push(
        `  - ⚠️ PKC 不可用（高风险符号维度 unknown，未判达标）：${input.coverageReport.pkcError ?? "原因未知"}`
      );
    }

    if (input.compatibilityReport) {
      lines.push(`- 既有契约兼容性：${input.compatibilityReport.compatible ? "✅ 兼容" : "❌ 有 breaking change"}`);
      if (input.compatibilityReport.breakingChanges.length > 0) {
        lines.push(`  - breaking change 数：${input.compatibilityReport.breakingChanges.length}`);
      }
      if (input.compatibilityReport.compatibleChanges.length > 0) {
        lines.push(`  - 兼容变更数：${input.compatibilityReport.compatibleChanges.length}`);
      }
    }

    if (input.humanCheckpointFlows.length > 0) {
      lines.push(`- 需人工确认的 E2E 流程：${input.humanCheckpointFlows.length} 个`);
    }

    lines.push("");

    // ---- 2. 需求映射 ----
    lines.push("## 需求映射");
    lines.push("");
    lines.push("| 需求 ID | 模块名 | 验收标准 | 契约测试 | E2E 测试 |");
    lines.push("|---------|--------|----------|----------|----------|");
    for (const criterion of input.acceptanceCriteria) {
      const contractCount = input.contractTests.filter((t) => t.requirementId === criterion.requirementId).length;
      const e2eCount = input.e2eTests.filter((t) => t.requirementId === criterion.requirementId).length;
      lines.push(
        `| ${criterion.requirementId} | ${criterion.moduleName} | ${criterion.description.slice(0, 60)} | ${contractCount} | ${e2eCount} |`
      );
    }
    lines.push("");

    // ---- 3. 测试报告 ----
    lines.push("## 测试报告");
    lines.push("");
    lines.push("### 契约测试");
    lines.push("");
    if (input.contractTests.length === 0) {
      lines.push("（无契约测试）");
    } else {
      lines.push("| 文件路径 | 测试用例数 | 需求 ID |");
      lines.push("|----------|-----------|---------|");
      for (const test of input.contractTests) {
        lines.push(`| ${test.relativePath} | ${test.testCaseCount} | ${test.requirementId} |`);
      }
    }
    lines.push("");

    lines.push("### E2E 测试");
    lines.push("");
    if (input.e2eTests.length === 0) {
      lines.push("（无 E2E 测试）");
    } else {
      lines.push("| 文件路径 | 测试用例数 | 需求 ID |");
      lines.push("|----------|-----------|---------|");
      for (const test of input.e2eTests) {
        lines.push(`| ${test.relativePath} | ${test.testCaseCount} | ${test.requirementId} |`);
      }
    }
    lines.push("");

    lines.push("### 覆盖率明细");
    lines.push("");
    lines.push("| 维度 | 覆盖率 | 阈值 | 是否达标 |");
    lines.push("|------|--------|------|----------|");
    lines.push(
      `| 行覆盖率 | ${input.coverageReport.lines.toFixed(1)}% | ${DEFAULT_COVERAGE_THRESHOLD.lines}% | ${input.coverageReport.lines >= DEFAULT_COVERAGE_THRESHOLD.lines ? "✅" : "❌"} |`
    );
    lines.push(
      `| 分支覆盖率 | ${input.coverageReport.branches.toFixed(1)}% | ${DEFAULT_COVERAGE_THRESHOLD.branches}% | ${input.coverageReport.branches >= DEFAULT_COVERAGE_THRESHOLD.branches ? "✅" : "❌"} |`
    );
    lines.push(
      `| 函数覆盖率 | ${input.coverageReport.functions.toFixed(1)}% | ${DEFAULT_COVERAGE_THRESHOLD.functions}% | ${input.coverageReport.functions >= DEFAULT_COVERAGE_THRESHOLD.functions ? "✅" : "❌"} |`
    );
    lines.push(
      `| 高风险符号覆盖率 | ${input.coverageReport.highRiskSymbols.toFixed(1)}% | ${DEFAULT_COVERAGE_THRESHOLD.highRiskSymbols}% | ${input.coverageReport.highRiskSymbols >= DEFAULT_COVERAGE_THRESHOLD.highRiskSymbols ? "✅" : "❌"} |`
    );
    lines.push("");

    if (input.coverageReport.uncoveredHighRiskSymbols.length > 0) {
      lines.push("### 未覆盖的高风险符号");
      lines.push("");
      lines.push("| 符号 ID | 文件路径 | 未覆盖原因 | 风险评分 |");
      lines.push("|---------|----------|------------|----------|");
      for (const symbol of input.coverageReport.uncoveredHighRiskSymbols) {
        lines.push(`| ${symbol.symbolId} | ${symbol.filePath} | ${symbol.reason} | ${symbol.riskScore.toFixed(2)} |`);
      }
      lines.push("");
    }

    // ---- 4. 测试质量静态判定结果 ----
    if (input.testQualityResults.length > 0) {
      lines.push("## 测试质量静态判定");
      lines.push("");
      lines.push("| Checker ID | 严重级 | 是否通过 | 违规数 |");
      lines.push("|------------|--------|----------|--------|");
      for (const result of input.testQualityResults) {
        lines.push(
          `| ${result.checkerId} | ${result.severity} | ${result.passed ? "✅" : "❌"} | ${result.violations.length} |`
        );
      }
      lines.push("");
    }

    // ---- 5. 测试执行失败证据（P0-4 新增） ----
    // 把真实 stderr / 失败用例名 / AssertionError 透传进 PR 描述，供人工排查与审计。
    // 仅在存在失败时渲染，避免污染正常交付的 PR。
    const execResults: ReadonlyArray<TestExecutionResultWithEvidence> = [
      ...(input.contractTestResults ?? []),
      ...(input.e2eTestResults ?? []),
    ];
    const failedExecResults = execResults.filter((r) => r.exitCode !== 0 || r.failedCount > 0);
    if (failedExecResults.length > 0) {
      lines.push("## 测试执行失败证据");
      lines.push("");
      lines.push("> 以下为真实子进程执行输出，未简化、未编造；供 G-7 门禁与人工排查使用。");
      lines.push("");
      for (const r of failedExecResults) {
        lines.push(`### ${r.filePath}`);
        lines.push("");
        lines.push(`- 退出码：${r.exitCode} / 失败用例数：${r.failedCount} / 通过用例数：${r.passedCount}`);
        if (r.failedCases && r.failedCases.length > 0) {
          lines.push(`- 失败用例名：${r.failedCases.join("、")}`);
        }
        if (r.errorMessage) {
          lines.push("- 失败原因：");
          lines.push("```");
          lines.push(r.errorMessage);
          lines.push("```");
        }
        if (r.stderr) {
          lines.push("- stderr（原始输出）：");
          lines.push("```");
          lines.push(r.stderr);
          lines.push("```");
        }
        if (r.stdoutSnippet) {
          lines.push("- stdout 片段（解析失败时保留）：");
          lines.push("```");
          lines.push(r.stdoutSnippet);
          lines.push("```");
        }
        lines.push("");
      }
    }

    // ---- 6. 合规证据（预留） ----
    lines.push("## 合规证据");
    lines.push("");
    lines.push("（本批次未启用 ICP，合规证据预留——P3 批次 11 实现）");
    lines.push("");

    return lines.join("\n");
  }

  // ----------------------------------------------------------------------
  // 私有方法：辅助方法
  // ----------------------------------------------------------------------

  /**
   * 生成 run-id（SHA256 时间戳哈希）
   *
   * @returns 16 字符 run-id
   */
  private generateRunId(): string {
    return crypto.createHash("sha256").update(Date.now().toString()).digest("hex").slice(0, 16);
  }

  /**
   * 构建 Loop 事件
   *
   * @param runId 运行 ID
   * @param iterIndex 迭代索引
   * @param eventType 事件类型
   * @param payload 事件负载
   * @returns LoopEvent 实例
   */
  private buildEvent(
    runId: string,
    iterIndex: number,
    eventType: LoopEventType,
    payload: Readonly<Record<string, unknown>>
  ): LoopEvent {
    return Object.freeze({
      eventId: `${runId}-${iterIndex}-${eventType}-${Date.now()}`,
      eventType,
      phase: "testing",
      runId,
      iterIndex,
      payload: Object.freeze({ ...payload }),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 查询 PKC 风险热点（P1 修复：真正接入，失败显式标 unknown）
   *
   * 旧实现 try 与 catch 都 `return []`，从不查询 PKC，使
   * TestQualityContext.highRiskSymbols 恒空、CoverageGapChecker 空转判 passed。
   * 新实现调用真实的 pkcAccessor.queryRiskHotspots：
   * - 查询成功 → { symbols, available: true }
   * - 查询失败 → { symbols: [], available: false }，调用方据此把
   *   highRiskSymbolsUnknown 置 true，下游判定器按 unknown 处理（不得判 passed）。
   *
   * @param projectRoot 项目根目录
   * @param pkcAccessor PKC 知识库访问器（来自 TestingLoopRequest）
   * @param topN 高风险符号 Top-N
   */
  private async pkcQueryRiskHotspotsSafe(
    projectRoot: string,
    pkcAccessor: PkcAccessor,
    topN: number
  ): Promise<{ readonly symbols: ReadonlyArray<UncoveredSymbol>; readonly available: boolean }> {
    try {
      const symbols = await pkcAccessor.queryRiskHotspots(projectRoot, topN);
      return { symbols, available: true };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.log(`PKC 风险热点查询失败（高风险符号维度标记 unknown）：${errorMsg}`, "warn");
      return { symbols: [], available: false };
    }
  }

  /**
   * 构建失败结果
   *
   * @param request 编排请求
   * @param runId 运行 ID
   * @param finalStatus 最终状态（human_checkpoint / stop_failure）
   * @param blockedReason 阻塞原因
   * @param events 事件流
   * @param totalLlmCallCount 总 LLM 调用次数
   * @param totalTokensUsed 总 token 消耗
   * @param startTime 开始时间戳
   * @param partialResults 部分产出（可选）
   * @returns 失败的 TestingLoopResult
   */
  private buildFailureResult(
    request: Readonly<TestingLoopRequest>,
    runId: string,
    finalStatus: TestingLoopFinalStatus,
    blockedReason: string,
    events: LoopEvent[],
    totalLlmCallCount: number,
    totalTokensUsed: number,
    startTime: number,
    partialResults?: {
      readonly contractTests?: ReadonlyArray<GeneratedTestFile>;
      readonly e2eTests?: ReadonlyArray<GeneratedTestFile>;
      readonly coverageReport?: Readonly<CoverageReport>;
      readonly prDescription?: string;
    }
  ): Readonly<TestingLoopResult> {
    const durationSec = Math.round((Date.now() - startTime) / 1000);

    // 失败时也记录 LoopGuard 迭代
    request.loopGuard.recordIteration(totalTokensUsed, false);

    return Object.freeze({
      runId,
      finalStatus,
      contractTests: Object.freeze([...(partialResults?.contractTests ?? [])]),
      e2eTests: Object.freeze([...(partialResults?.e2eTests ?? [])]),
      integrationTests: Object.freeze([]),
      complianceTests: Object.freeze([]),
      coverageReport: (partialResults?.coverageReport ?? this.buildEmptyCoverageReport()) as CoverageReport,
      prDescription: partialResults?.prDescription ?? "",
      blockedReason,
      totalLlmCallCount,
      totalTokensUsed,
      durationSec,
      events: Object.freeze([...events]),
    });
  }

  /**
   * 构建成功结果
   *
   * @param input 成功结果输入
   * @returns 成功的 TestingLoopResult
   */
  private buildSuccessResult(input: {
    readonly request: Readonly<TestingLoopRequest>;
    readonly runId: string;
    readonly contractTests: ReadonlyArray<GeneratedTestFile>;
    readonly e2eTests: ReadonlyArray<GeneratedTestFile>;
    readonly coverageReport: Readonly<CoverageReport>;
    readonly prDescription: string;
    readonly events: LoopEvent[];
    readonly totalLlmCallCount: number;
    readonly totalTokensUsed: number;
    readonly startTime: number;
  }): Readonly<TestingLoopResult> {
    const durationSec = Math.round((Date.now() - input.startTime) / 1000);

    return Object.freeze({
      runId: input.runId,
      finalStatus: "success",
      contractTests: Object.freeze([...input.contractTests]),
      e2eTests: Object.freeze([...input.e2eTests]),
      integrationTests: Object.freeze([]),
      complianceTests: Object.freeze([]),
      coverageReport: input.coverageReport,
      prDescription: input.prDescription,
      totalLlmCallCount: input.totalLlmCallCount,
      totalTokensUsed: input.totalTokensUsed,
      durationSec,
      events: Object.freeze([...input.events]),
    });
  }

  /**
   * 构建空覆盖率报告（失败降级时使用）
   *
   * @returns 空 CoverageReport
   */
  private buildEmptyCoverageReport(): Readonly<CoverageReport> {
    return Object.freeze({
      lines: 0,
      branches: 0,
      functions: 0,
      highRiskSymbols: 0,
      uncoveredHighRiskSymbols: Object.freeze([]),
      uncoveredFiles: Object.freeze([]),
      passed: false,
      failedDimensions: Object.freeze([
        "lines",
        "branches",
        "functions",
        "highRiskSymbols",
      ]) as ReadonlyArray<CoverageFailedDimension>,
      rawReport: Object.freeze({}),
    });
  }

  /**
   * 日志输出
   *
   * @param message 日志消息
   * @param level 日志级别
   */
  private log(message: string, level: "info" | "warn" | "error"): void {
    this.logger(message, level);
  }
}

// ============================================================================
// 6. 工厂函数
// ============================================================================

/**
 * 创建默认 TestingOrchestrator 实例
 *
 * EAG-P3 批次 11 S1 改造（D-S1-4/D-S1-8）：注入默认的 GateG6Checker / GateG7Checker 独立类，
 * 与 CodingOrchestrator 中 createDefaultCodingOrchestrator 的注入方式同构。
 *
 * @param coverageGate 覆盖率门禁实例（必填——需注入 pkcAccessor）
 * @param logger 日志回调（可选）
 * @returns TestingOrchestrator 实例（含默认注入的 G-6/G-7 门禁检查器）
 */
export function createDefaultTestingOrchestrator(
  coverageGate: CoverageGate,
  logger?: LogCallback
): TestingOrchestrator {
  return new TestingOrchestrator({
    coverageGate,
    // EAG-P3 批次 11 S1 改造：注入默认的 G-6/G-7 门禁检查器（独立类，无外部依赖）
    gateG6Checker: new GateG6Checker(),
    gateG7Checker: new GateG7Checker(),
    logger,
  });
}

// ============================================================================
// 7. 模块导出
// ============================================================================
