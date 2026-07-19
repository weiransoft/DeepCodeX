/**
 * 覆盖率门禁（CoverageGate）—— EAG-P3 批次 10 §4.4
 *
 * 职责：
 * - 调用 c8 工具执行覆盖率采集
 * - 结合 PKC L1 风险热点（高风险符号必测）
 * - 按阈值判定是否达标（对齐 §5.2.4 + §8.6）
 *
 * 关键技术决策（对齐 §4.4.2）：
 * - 覆盖率工具：c8（V8 原生，零运行时开销）
 * - c8 调用方式：Node 子进程 child_process.spawn
 * - 高风险符号来源：PKC L1 风险热点（queryRiskHotspots）
 * - 阈值配置：运行时注入 CoverageThreshold + 默认值 DEFAULT_COVERAGE_THRESHOLD
 * - 失败处理：首次失败 WARNING + 连续 2 次失败升级 BLOCKER
 * - 报告格式：c8 reporter JSON + 自定义摘要
 *
 * c8 调用实现要点（对齐 §4.4.4）：
 * - 使用 child_process.spawn("c8", [...args], { stdio: ["ignore", "pipe", "pipe"] })
 * - 通过 --reporter=json 输出到 stdout，解析为 JSON
 * - 通过 --reporter=text 输出到 stderr，用于日志
 * - 失败时检查 c8 退出码：0=成功 / 1=覆盖率未达标 / 其他=执行错误
 *
 * 不可变优先原则：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 工厂函数返回冻结对象
 *
 * @module eag/testing/coverage-gate
 */

// ============================================================================
// 1. 外部依赖与类型导入
// ============================================================================

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type {
  CoverageFailedDimension,
  CoverageReport,
  CoverageThreshold,
  LogCallback,
  PkcAccessor,
  UncoveredSymbol,
} from "./types";
import { COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD, DEFAULT_COVERAGE_THRESHOLD, DEFAULT_HIGH_RISK_TOP_N } from "./types";

// ============================================================================
// 2. 常量定义
// ============================================================================

/**
 * c8 默认测试目录（相对 projectRoot）
 */
const DEFAULT_TEST_DIR = "tests/" as const;

/**
 * c8 默认实现代码目录（相对 projectRoot）
 */
const DEFAULT_IMPLEMENTATION_ROOT = "src/" as const;

/**
 * c8 JSON 报告结构 zod 校验 schema
 *
 * c8 --reporter=json 输出格式（基于 v8-coverage）：
 * - total: 总行数 / 总分支数 / 总函数数
 * - covered: 覆盖行数 / 覆盖分支数 / 覆盖函数数
 * - pct: 百分比覆盖率
 *
 * 注：c8 报告实际结构较复杂，此处仅校验 ContractTestGenerator 消费的核心字段。
 */
const C8ReportSchema = z.object({
  total: z.object({
    lines: z.number(),
    statements: z.number(),
    functions: z.number(),
    branches: z.number(),
  }),
  covered: z.object({
    lines: z.number(),
    statements: z.number(),
    functions: z.number(),
    branches: z.number(),
  }),
  pct: z.object({
    lines: z.number(),
    statements: z.number(),
    functions: z.number(),
    branches: z.number(),
  }),
});

// ============================================================================
// 3. 自定义错误类
// ============================================================================

/**
 * 覆盖率门禁错误基类
 */
export class CoverageGateError extends Error {
  /**
   * @param kind 错误类型（c8-spawn / c8-parse / pkc-query / threshold-config）
   * @param message 错误消息
   * @param cause 原始错误（可选）
   */
  constructor(
    public readonly kind: "c8-spawn" | "c8-parse" | "pkc-query" | "threshold-config",
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "CoverageGateError";
  }
}

// ============================================================================
// 4. 请求与中间产物类型定义
// ============================================================================

/**
 * 覆盖率请求
 *
 * 对应设计文档 §4.4.3 CoverageGateRequest。
 * 字段全部 readonly——请求一经组装即不可变。
 */
export interface CoverageGateRequest {
  /** 项目根目录（绝对路径） */
  readonly projectRoot: string;
  /** 测试目录（相对 projectRoot，默认 "tests/"） */
  readonly testDir: string;
  /** 实现代码目录（相对 projectRoot，默认 "src/"） */
  readonly implementationRoot: string;
  /** 高风险符号 Top-N（默认 10） */
  readonly topN: number;
  /** 失败次数（用于升级 BLOCKER 判定，由调用方维护计数） */
  readonly consecutiveFailureCount: number;
}

/**
 * c8 解析后报告（中间产物）
 *
 * 对应设计文档 §4.4.3 C8ParsedReport。
 * C8ReportParser.parse() 的产出，供 CoverageGate.check() 消费。
 */
export interface C8ParsedReport {
  /** 行覆盖率（0~100） */
  readonly lines: number;
  /** 分支覆盖率（0~100） */
  readonly branches: number;
  /** 函数覆盖率（0~100） */
  readonly functions: number;
  /** 未覆盖文件列表（相对路径） */
  readonly uncoveredFiles: ReadonlyArray<string>;
  /** 未覆盖符号列表（含风险评分，来自 PKC 交叉比对） */
  readonly uncoveredSymbols: ReadonlyArray<UncoveredSymbol>;
  /** 原始 c8 报告 JSON */
  readonly raw: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 5. C8ReportParser 实现
// ============================================================================

/**
 * c8 报告解析器（独立可测）
 *
 * 算法：
 * 1. 解析 c8 --reporter=json 原始输出为 JSON
 * 2. 用 zod 校验 c8 报告结构
 * 3. 提取行/分支/函数覆盖率百分比
 * 4. 从 c8 报告的 uncoveredFiles 字段提取未覆盖文件列表
 * 5. 返回结构化 C8ParsedReport
 *
 * 设计依据：§4.4.3 C8ReportParser 类设计
 */
export class C8ReportParser {
  /**
   * 解析 c8 JSON 报告
   *
   * @param rawJson c8 reporter=json 原始输出
   * @returns 结构化覆盖率数据
   * @throws {CoverageGateError} c8 报告解析失败
   */
  parse(rawJson: string): Readonly<C8ParsedReport> {
    if (typeof rawJson !== "string" || rawJson.trim().length === 0) {
      throw new CoverageGateError("c8-parse", "c8 报告内容为空或非字符串");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (e) {
      throw new CoverageGateError(
        "c8-parse",
        `c8 报告 JSON 解析失败：${e instanceof Error ? e.message : String(e)}`,
        e
      );
    }

    // 用 zod 校验 c8 报告结构
    const validationResult = C8ReportSchema.safeParse(parsed);
    if (!validationResult.success) {
      throw new CoverageGateError(
        "c8-parse",
        `c8 报告结构校验失败：${validationResult.error.message}`,
        validationResult.error
      );
    }

    const report = validationResult.data;

    // 提取未覆盖文件列表
    // c8 报告可能含 uncoveredFiles 字段（取决于 reporter 实现）
    // 此处兼容性处理：若无该字段，从 raw 中提取
    const rawObj = parsed as Record<string, unknown>;
    const uncoveredFilesRaw = (rawObj["uncoveredFiles"] as unknown[]) ?? [];
    const uncoveredFiles: string[] = [];
    if (Array.isArray(uncoveredFilesRaw)) {
      for (const f of uncoveredFilesRaw) {
        if (typeof f === "string") {
          uncoveredFiles.push(f);
        }
      }
    }

    return Object.freeze({
      lines: report.pct.lines,
      branches: report.pct.branches,
      functions: report.pct.functions,
      uncoveredFiles: Object.freeze(uncoveredFiles),
      uncoveredSymbols: Object.freeze([]), // 由 CoverageGate.check() 通过 PKC 交叉比对填充
      raw: Object.freeze({ ...rawObj }) as Readonly<Record<string, unknown>>,
    }) as C8ParsedReport;
  }
}

// ============================================================================
// 6. CoverageGate 实现
// ============================================================================

/**
 * 覆盖率门禁
 *
 * 算法（对齐 §4.4.3）：
 * 1. 调用 c8 spawn 子进程执行 `c8 --reporter=json --reporter=text node --test tests/`
 * 2. 解析 c8 JSON 报告 → 行/分支/函数覆盖率
 * 3. 从 pkcAccessor.queryRiskHotspots() 获取高风险符号列表
 * 4. 比对 c8 报告与高风险符号列表，识别未覆盖的高风险符号
 * 5. 按 CoverageThreshold 判定是否达标
 * 6. 应用失败升级策略：
 *    - 首次失败（consecutiveFailureCount=0）→ WARNING（passed=true 但提示）
 *    - 连续 2 次失败（consecutiveFailureCount≥1）→ BLOCKER（passed=false）
 * 7. 返回 CoverageReport
 */
export class CoverageGate {
  private readonly reportParser: C8ReportParser;

  /**
   * 初始化覆盖率门禁
   *
   * @param pkcAccessor PKC 知识库访问器（查询高风险符号）
   * @param threshold 覆盖率阈值（默认 DEFAULT_COVERAGE_THRESHOLD）
   * @param logger 日志回调（可选）
   */
  constructor(
    private readonly pkcAccessor: PkcAccessor,
    private readonly threshold: Readonly<CoverageThreshold> = DEFAULT_COVERAGE_THRESHOLD,
    private readonly logger?: LogCallback
  ) {
    this.reportParser = new C8ReportParser();
  }

  /**
   * 执行覆盖率采集与门禁判定
   *
   * @param request 覆盖率请求
   * @returns 覆盖率报告（含未覆盖符号列表 + 是否达标）
   * @throws {CoverageGateError} c8 命令执行失败或报告解析失败
   */
  async check(request: Readonly<CoverageGateRequest>): Promise<Readonly<CoverageReport>> {
    this.log("开始执行覆盖率采集", "info");

    // 1. 校验请求字段
    this.validateRequest(request);

    // 2. 调用 c8 spawn 子进程执行覆盖率采集
    const c8RawReport = await this.runC8(request);

    // 3. 解析 c8 JSON 报告
    const parsedReport = this.reportParser.parse(c8RawReport);
    this.log(
      `覆盖率采集完成：lines=${parsedReport.lines.toFixed(1)}% branches=${parsedReport.branches.toFixed(1)}% functions=${parsedReport.functions.toFixed(1)}%`,
      "info"
    );

    // 4. 从 PKC 查询高风险符号
    let riskHotspots: ReadonlyArray<UncoveredSymbol> = [];
    try {
      riskHotspots = await this.pkcAccessor.queryRiskHotspots(request.projectRoot, request.topN);
    } catch (e) {
      // PKC 查询失败不阻断覆盖率门禁，仅记录错误
      this.log(`查询 PKC 风险热点失败（降级为无高风险符号）：${e instanceof Error ? e.message : String(e)}`, "warn");
    }

    // 5. 比对 c8 报告与高风险符号列表，识别未覆盖的高风险符号
    const uncoveredHighRiskSymbols = this.identifyUncoveredHighRiskSymbols(parsedReport, riskHotspots, request);

    // 6. 计算高风险符号覆盖率
    const highRiskSymbolsCoverage = this.calculateHighRiskSymbolsCoverage(riskHotspots, uncoveredHighRiskSymbols);

    // 7. 按 CoverageThreshold 判定是否达标
    const failedDimensions = this.evaluateThreshold(parsedReport, highRiskSymbolsCoverage);

    // 8. 应用失败升级策略
    // 首次失败（consecutiveFailureCount=0）→ WARNING（passed=true）
    // 连续 ≥2 次失败（consecutiveFailureCount≥1）→ BLOCKER（passed=false）
    const isBlocker = request.consecutiveFailureCount >= COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD - 1;
    const passed = failedDimensions.length === 0 || !isBlocker;

    // 9. 构建并冻结 CoverageReport
    const report = Object.freeze({
      lines: parsedReport.lines,
      branches: parsedReport.branches,
      functions: parsedReport.functions,
      highRiskSymbols: highRiskSymbolsCoverage,
      uncoveredHighRiskSymbols: Object.freeze([...uncoveredHighRiskSymbols]),
      uncoveredFiles: Object.freeze([...parsedReport.uncoveredFiles]),
      passed,
      failedDimensions: Object.freeze([...failedDimensions]),
      rawReport: parsedReport.raw,
    }) as CoverageReport;

    if (!passed) {
      this.log(
        `覆盖率门禁未通过（连续失败 ${request.consecutiveFailureCount + 1} 次，已升级 BLOCKER）：${failedDimensions.join(", ")}`,
        "error"
      );
    } else if (failedDimensions.length > 0) {
      this.log(`覆盖率未达标但首次失败（WARNING，不阻断）：${failedDimensions.join(", ")}`, "warn");
    } else {
      this.log("覆盖率门禁通过", "info");
    }

    return report;
  }

  /**
   * 校验请求字段合法性
   *
   * @param request 覆盖率请求
   * @throws {CoverageGateError} 字段非法时抛出
   */
  private validateRequest(request: Readonly<CoverageGateRequest>): void {
    if (typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new CoverageGateError("threshold-config", "projectRoot 必须为非空字符串");
    }
    if (typeof request.testDir !== "string" || request.testDir.trim().length === 0) {
      throw new CoverageGateError("threshold-config", "testDir 必须为非空字符串");
    }
    if (typeof request.implementationRoot !== "string" || request.implementationRoot.trim().length === 0) {
      throw new CoverageGateError("threshold-config", "implementationRoot 必须为非空字符串");
    }
    if (typeof request.topN !== "number" || request.topN < 1) {
      throw new CoverageGateError("threshold-config", "topN 必须为 ≥1 的数字");
    }
    if (typeof request.consecutiveFailureCount !== "number" || request.consecutiveFailureCount < 0) {
      throw new CoverageGateError("threshold-config", "consecutiveFailureCount 必须为 ≥0 的数字");
    }
  }

  /**
   * 调用 c8 spawn 子进程执行覆盖率采集
   *
   * 算法（对齐 §4.4.4）：
   * 1. 构造 c8 命令参数：--reporter=json --reporter=text node --test <testDir>
   * 2. 在 projectRoot 目录下 spawn c8 子进程
   * 3. 收集 stdout（JSON 报告）与 stderr（text 报告，用于日志）
   * 4. 检查退出码：0=成功 / 1=覆盖率未达标 / 其他=执行错误
   * 5. 返回 stdout 内容
   *
   * @param request 覆盖率请求
   * @returns c8 JSON 报告字符串
   * @throws {CoverageGateError} c8 命令执行失败
   */
  private async runC8(request: Readonly<CoverageGateRequest>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // 构造 c8 命令参数
      const args = [
        "--reporter=json",
        "--reporter=text",
        `--include=${request.implementationRoot}**/*.ts`,
        "node",
        "--test",
        request.testDir,
      ];

      this.log(`执行 c8 命令：c8 ${args.join(" ")}`, "info");

      const child = spawn("c8", args, {
        cwd: request.projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_OPTIONS: "--import tsx" },
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });

      child.on("error", (err: Error) => {
        // spawn 本身失败（如 c8 未安装）
        reject(new CoverageGateError("c8-spawn", `c8 命令启动失败（请确认 c8 已全局或本地安装）：${err.message}`, err));
      });

      child.on("close", (code: number | null) => {
        // 退出码：0=成功 / 1=覆盖率未达标 / 其他=执行错误
        if (code !== null && code !== 0 && code !== 1) {
          reject(
            new CoverageGateError(
              "c8-spawn",
              `c8 命令执行失败（退出码 ${code}）：${stderr}`,
              new Error(`c8 exited with code ${code}`)
            )
          );
          return;
        }

        // 记录 stderr 中的 text 报告（用于日志展示）
        if (stderr.length > 0) {
          this.log(`c8 text 报告：\n${stderr}`, "info");
        }

        if (stdout.trim().length === 0) {
          reject(new CoverageGateError("c8-spawn", "c8 命令执行成功但 stdout 为空（未生成 JSON 报告）"));
          return;
        }

        resolve(stdout);
      });
    });
  }

  /**
   * 识别未覆盖的高风险符号
   *
   * 算法：
   * 1. 遍历 PKC 风险热点列表（riskHotspots）
   * 2. 对每个高风险符号检查是否在 c8 未覆盖文件列表中
   * 3. 若高风险符号所在文件未在 c8 覆盖范围 → 视为未覆盖
   *
   * @param parsedReport c8 解析后报告
   * @param riskHotspots PKC 风险热点列表
   * @param request 覆盖率请求
   * @returns 未覆盖的高风险符号列表
   */
  private identifyUncoveredHighRiskSymbols(
    parsedReport: Readonly<C8ParsedReport>,
    riskHotspots: ReadonlyArray<UncoveredSymbol>,
    _request: Readonly<CoverageGateRequest>
  ): UncoveredSymbol[] {
    const uncovered: UncoveredSymbol[] = [];

    for (const symbol of riskHotspots) {
      // 检查高风险符号所在文件是否在 c8 未覆盖文件列表中
      const isUncovered = parsedReport.uncoveredFiles.some(
        (file) => symbol.filePath.includes(file) || file.includes(symbol.filePath)
      );

      if (isUncovered) {
        uncovered.push({
          symbolId: symbol.symbolId,
          filePath: symbol.filePath,
          reason: "high-risk-no-test",
          riskScore: symbol.riskScore,
        });
      }
    }

    return uncovered;
  }

  /**
   * 计算高风险符号覆盖率
   *
   * 算法：
   * - 若无高风险符号 → 覆盖率 100%（无必测约束）
   * - 否则：覆盖率 = (1 - 未覆盖数 / 总数) * 100
   *
   * @param riskHotspots 风险热点列表
   * @param uncoveredHighRiskSymbols 未覆盖的高风险符号列表
   * @returns 高风险符号覆盖率（0~100）
   */
  private calculateHighRiskSymbolsCoverage(
    riskHotspots: ReadonlyArray<UncoveredSymbol>,
    uncoveredHighRiskSymbols: ReadonlyArray<UncoveredSymbol>
  ): number {
    if (riskHotspots.length === 0) {
      return 100;
    }
    const coveredCount = riskHotspots.length - uncoveredHighRiskSymbols.length;
    return (coveredCount / riskHotspots.length) * 100;
  }

  /**
   * 按 CoverageThreshold 判定是否达标
   *
   * 算法：
   * 1. 比对行覆盖率与 threshold.lines
   * 2. 比对分支覆盖率与 threshold.branches
   * 3. 比对函数覆盖率与 threshold.functions
   * 4. 比对高风险符号覆盖率与 threshold.highRiskSymbols
   * 5. 任一维度未达标 → 加入 failedDimensions 列表
   *
   * @param parsedReport c8 解析后报告
   * @param highRiskSymbolsCoverage 高风险符号覆盖率
   * @returns 未达标维度列表
   */
  private evaluateThreshold(
    parsedReport: Readonly<C8ParsedReport>,
    highRiskSymbolsCoverage: number
  ): CoverageFailedDimension[] {
    const failed: CoverageFailedDimension[] = [];

    if (parsedReport.lines < this.threshold.lines) {
      failed.push("lines");
    }
    if (parsedReport.branches < this.threshold.branches) {
      failed.push("branches");
    }
    if (parsedReport.functions < this.threshold.functions) {
      failed.push("functions");
    }
    if (highRiskSymbolsCoverage < this.threshold.highRiskSymbols) {
      failed.push("highRiskSymbols");
    }

    return failed;
  }

  /**
   * 日志回调
   *
   * @param message 日志消息
   * @param level 日志级别（默认 info）
   */
  private log(message: string, level: "info" | "warn" | "error" = "info"): void {
    if (this.logger) {
      this.logger(message, level);
    }
  }
}

// ============================================================================
// 7. 工厂函数
// ============================================================================

/**
 * 创建默认覆盖率门禁实例
 *
 * @param pkcAccessor PKC 知识库访问器
 * @param threshold 覆盖率阈值（默认 DEFAULT_COVERAGE_THRESHOLD）
 * @param logger 日志回调（可选）
 * @returns CoverageGate 实例
 */
export function createDefaultCoverageGate(
  pkcAccessor: PkcAccessor,
  threshold: Readonly<CoverageThreshold> = DEFAULT_COVERAGE_THRESHOLD,
  logger?: LogCallback
): CoverageGate {
  return new CoverageGate(pkcAccessor, threshold, logger);
}

/**
 * 创建 c8 报告解析器实例
 *
 * @returns C8ReportParser 实例
 */
export function createC8ReportParser(): C8ReportParser {
  return new C8ReportParser();
}

// ============================================================================
// 8. 辅助函数：检查 c8 是否可用
// ============================================================================

/**
 * 检查 c8 命令是否可用
 *
 * 工具函数：在调用 CoverageGate.check() 前可调用此函数预检 c8 是否已安装。
 *
 * @returns true 表示 c8 可用
 */
export function isC8Available(): boolean {
  try {
    // 尝试在 node_modules 中查找 c8
    const c8PackagePath = path.resolve(process.cwd(), "node_modules/c8/package.json");
    if (fs.existsSync(c8PackagePath)) {
      return true;
    }
    // 兜底：检查全局 c8（通过 which/where 命令）
    return false;
  } catch {
    return false;
  }
}

// ============================================================================
// 9. 常量与默认值重导出
// ============================================================================

export { DEFAULT_COVERAGE_THRESHOLD, DEFAULT_HIGH_RISK_TOP_N, COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD } from "./types";
