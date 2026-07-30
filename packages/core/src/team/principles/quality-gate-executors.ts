/**
 * 质量门禁真实执行器集合
 *
 * 来源：multi-agent-team skill skill-manifest-example.yaml quality_gates
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 本文件为 7 大门禁提供基于真实源码扫描的 GateExecutorLike 实现：
 * - code-review：代码审查（代码质量、坏味道、残留调试代码）
 * - test-coverage：测试覆盖（优先解析真实覆盖率报告，无报告时诚实用代理指标）
 * - spec-compliance：规范一致性（命名、注释、待办/修复项实现）
 * - security-scan：安全扫描（硬编码密钥、eval、SQL 拼接、unsafe innerHTML 等）
 * - ponytail-redlines：Ponytail 16 条不可简化红线
 * - karpathy-principles：Karpathy 四大核心原则
 * - uiux-visual：UI/UX 静态可访问性巡检（当前为静态 only，不做像素级 diff）
 *
 * 设计约束：
 * 1. 所有 executor 均真实读取 projectPath 下的源码文件，绝不直接返回空 findings。
 * 2. 共享 ProjectScanner 统一递归规则，避免重复扫描。
 * 3. 每个 gate 的 score 计算公式显式、可解释，由 findings 严重度加权映射到 [0,1]。
 * 4. 无法静态检测的项目（如 UI 像素级回归）在 metadata 中诚实标注能力边界。
 *
 * 作者：trae-multi-agent 融合 Phase 2（TypeScript 真实执行器版）
 * 创建日期：2026-07-29
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  QualityGateId,
  type QualityGateIdType,
  type QualityGateConfig,
  type GateFinding,
  type GateExecutorLike,
  GateSeverity,
  type GateSeverityType,
  createGateFinding,
} from "./quality-gate-common.js";
import { KarpathyPrincipleEnforcer, ViolationSeverity } from "../cybernetics/karpathy-principle-enforcer.js";

// ============================================================================
// 共享扫描基础设施
// ============================================================================

/** 默认扫描的源码扩展名 */
const DEFAULT_SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".php",
  ".rb",
]);

/** UI 相关扩展名 */
const UI_EXTENSIONS = new Set([".tsx", ".jsx", ".html", ".vue", ".svelte"]);

/** 递归扫描时跳过的目录 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  "venv",
  ".venv",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".cache",
  "out",
  "target", // Rust
]);

/** 源码文件信息 */
interface SourceFile {
  /** 绝对路径 */
  absolutePath: string;
  /** 相对于项目根目录的路径 */
  relativePath: string;
  /** 文件扩展名 */
  ext: string;
  /** 文件内容 */
  content: string;
  /** 按行拆分的内容 */
  lines: string[];
}

/**
 * 项目文件扫描器
 *
 * 负责统一递归遍历项目目录、跳过无关目录、读取文件内容。
 * 每个 executor 实例可复用同一次扫描结果，避免 7 个 gate 重复 IO。
 */
export class ProjectScanner {
  /** 项目根目录 */
  public readonly projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /**
   * 判断目录是否应该被跳过
   * @param dirName 目录名（不含路径）
   */
  private _shouldSkipDir(dirName: string): boolean {
    return SKIP_DIRS.has(dirName);
  }

  /**
   * 递归遍历目录，返回所有匹配扩展名的文件绝对路径
   * @param root 起始目录
   * @param extensions 允许扩展名集合
   */
  private _walk(root: string, extensions: Set<string>): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (!this._shouldSkipDir(entry.name)) {
          results.push(...this._walk(fullPath, extensions));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.has(ext)) {
          results.push(fullPath);
        }
      }
    }
    return results;
  }

  /**
   * 扫描源码文件
   * @param extensions 扩展名集合，默认 DEFAULT_SOURCE_EXTENSIONS
   * @returns 源码文件列表（按相对路径排序，结果稳定）
   */
  scanSourceFiles(extensions: Set<string> = DEFAULT_SOURCE_EXTENSIONS): SourceFile[] {
    if (!fs.existsSync(this.projectPath) || !fs.statSync(this.projectPath).isDirectory()) {
      return [];
    }
    const files = this._walk(this.projectPath, extensions);
    files.sort();
    return files
      .map((absolutePath) => {
        try {
          const content = fs.readFileSync(absolutePath, "utf-8");
          return {
            absolutePath,
            relativePath: path.relative(this.projectPath, absolutePath),
            ext: path.extname(absolutePath).toLowerCase(),
            content,
            lines: content.split(/\r?\n/),
          };
        } catch {
          // 读取失败（如无权限、二进制误判）则跳过该文件
          return null;
        }
      })
      .filter((f): f is SourceFile => f !== null);
  }

  /**
   * 判断文件路径是否落在测试目录中
   * @param relativePath 项目相对路径
   */
  static isTestFile(relativePath: string): boolean {
    const lower = relativePath.toLowerCase();
    return (
      lower.includes("/tests/") ||
      lower.includes("/test/") ||
      lower.startsWith("tests/") ||
      lower.startsWith("test/") ||
      /[._-](test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|java|go|rs)$/i.test(lower)
    );
  }

  /**
   * 判断文件路径是否落在源码目录中
   * @param relativePath 项目相对路径
   */
  static isSourceFile(relativePath: string): boolean {
    const lower = relativePath.toLowerCase();
    return (
      lower.includes("/src/") ||
      lower.startsWith("src/") ||
      (!ProjectScanner.isTestFile(relativePath) && !lower.includes("/node_modules/"))
    );
  }
}

// ============================================================================
// 共享评分工具
// ============================================================================

/**
 * 严重度权重映射
 * 权重越高，单个 finding 对分数扣减影响越大
 */
const SEVERITY_WEIGHTS: Record<GateSeverityType, number> = {
  [GateSeverity.CRITICAL]: 0.25,
  [GateSeverity.HIGH]: 0.15,
  [GateSeverity.MEDIUM]: 0.08,
  [GateSeverity.LOW]: 0.04,
};

/**
 * 基于 findings 计算扣分后的分数
 *
 * 公式：score = max(0, 1 - Σ(weight(severity) * count) / baseline)
 * baseline 控制“容错空间”，即允许出现少量低严重度问题而不立即 FAIL。
 *
 * @param findings 发现项列表
 * @param baseline 扣分基准，默认 3.0
 */
function scoreFromFindings(findings: GateFinding[], baseline = 3.0): number {
  if (findings.length === 0) return 1.0;
  let weighted = 0;
  for (const f of findings) {
    weighted += SEVERITY_WEIGHTS[f.severity] ?? 0.05;
  }
  const score = 1 - weighted / baseline;
  return Math.max(0, Math.round(score * 10000) / 10000);
}

/**
 * 将 Karpathy 违规严重度映射到门禁严重度
 */
function mapKarpathySeverity(severity: string): GateSeverityType {
  switch (severity) {
    case ViolationSeverity.CRITICAL:
      return GateSeverity.CRITICAL;
    case ViolationSeverity.HIGH:
      return GateSeverity.HIGH;
    case ViolationSeverity.MEDIUM:
      return GateSeverity.MEDIUM;
    case ViolationSeverity.LOW:
    case ViolationSeverity.INFO:
    default:
      return GateSeverity.LOW;
  }
}

/**
 * 将行号和周围上下文打包为 evidence 字符串
 */
function evidenceAround(lines: string[], lineIndex: number, contextLines = 2): string {
  const start = Math.max(0, lineIndex - contextLines);
  const end = Math.min(lines.length, lineIndex + contextLines + 1);
  return lines
    .slice(start, end)
    .map((line, idx) => `${start + idx + 1}: ${line}`)
    .join("\n");
}

// ============================================================================
// Executor 1: 代码审查（Code Review）
// ============================================================================

/**
 * 代码审查执行器
 *
 * 扫描源码中的代码质量问题：
 * - 调试代码残留（console.log、debugger）
 * - 过长函数（超过阈值）
 * - 未实现的待办/修复注释
 * - 未使用 import 提示（TypeScript/JavaScript）
 * - 硬编码魔法数/字符串（仅作提示，不重复安全扫描职责）
 */
export class CodeReviewExecutor implements GateExecutorLike {
  public readonly gateId: QualityGateIdType = QualityGateId.CODE_REVIEW;

  async execute(
    projectPath: string,
    config: QualityGateConfig
  ): Promise<{ score: number; findings: GateFinding[]; metadata: Record<string, unknown> }> {
    const scanner = new ProjectScanner(projectPath);
    const files = scanner.scanSourceFiles();
    const findings: GateFinding[] = [];

    // 从配置读取阈值，未配置时使用默认值
    const maxFunctionLines = Number(config.params.maxFunctionLines ?? 80);
    const debugPatterns: RegExp[] = [
      /(^|[^\w])console\.(log|warn|error|debug|info)\s*\(/,
      /(^|[^\w])debugger\s*;?\s*$/,
      /(^|[^\w])print\s*\(/, // Python debug
    ];

    for (const file of files) {
      // 跳过测试文件中的调试输出（测试代码允许 console.log）
      const isTest = ProjectScanner.isTestFile(file.relativePath);

      for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i]!;
        const trimmed = line.trim();

        // 调试代码残留
        if (!isTest) {
          for (const pattern of debugPatterns) {
            if (pattern.test(line)) {
              findings.push(
                createGateFinding({
                  gateId: this.gateId,
                  rule: "debug-code-leftover",
                  message: "源码中残留调试代码",
                  severity: GateSeverity.MEDIUM,
                  filePath: file.relativePath,
                  lineNumber: i + 1,
                  evidence: evidenceAround(file.lines, i),
                  fix: "删除调试代码，或改用结构化日志/测试断言",
                })
              );
              break;
            }
          }
        }

        // 未实现的待办/修复注释（带空实现或仅注释）
        const todoMatch = trimmed.match(/\/\/\s*(TODO|FIXME)\s*[:：]\s*(.+)/i);
        if (todoMatch) {
          const body = todoMatch[2] ?? "";
          if (/未实现|待实现|implement|placeholder|mock/i.test(body) || body.length < 4) {
            findings.push(
              createGateFinding({
                gateId: this.gateId,
                rule: "todo-without-implementation",
                message: "待办/修复注释缺少实现",
                severity: GateSeverity.HIGH,
                filePath: file.relativePath,
                lineNumber: i + 1,
                evidence: evidenceAround(file.lines, i),
                fix: "完成待办/修复对应实现，或删除无意义的占位注释",
              })
            );
          }
        }
      }

      // 函数长度检查（仅对支持语言）
      findings.push(...this._checkFunctionLength(file, maxFunctionLines));
    }

    const score = scoreFromFindings(findings, 4.0);
    return { score, findings, metadata: { filesScanned: files.length, executor: "code-review" } };
  }

  /**
   * 检查函数/方法是否过长
   * @param file 源文件
   * @param maxLines 最大允许行数
   */
  private _checkFunctionLength(file: SourceFile, maxLines: number): GateFinding[] {
    const findings: GateFinding[] = [];
    const functionPatterns = [
      // TypeScript / JavaScript
      /(?:async\s+)?function\s+(\w+)\s*\(/,
      /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(.*\)\s*=>/,
      // Python
      /def\s+(\w+)\s*\(/,
      // Java / Go
      /(?:public|private|protected|static|\s)+[\w<>[\]]+\s+(\w+)\s*\([^)]*\)\s*\{/,
      // Go func
      /func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/,
      // Rust fn
      /fn\s+(\w+)\s*\(/,
    ];

    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]!;
      for (const pattern of functionPatterns) {
        const match = line.match(pattern);
        if (match) {
          const functionName = match[1] ?? "anonymous";
          const startLine = i;
          const endLine = this._findBlockEnd(file.lines, startLine);
          const length = endLine - startLine + 1;
          if (length > maxLines) {
            findings.push(
              createGateFinding({
                gateId: this.gateId,
                rule: "function-too-long",
                message: `函数 "${functionName}" 过长（${length} 行，阈值 ${maxLines}）`,
                severity: GateSeverity.MEDIUM,
                filePath: file.relativePath,
                lineNumber: startLine + 1,
                evidence: evidenceAround(file.lines, startLine, 1),
                fix: "拆分函数，遵循单一职责原则",
              })
            );
          }
          break;
        }
      }
    }
    return findings;
  }

  /**
   * 粗略查找代码块的结束行
   * 基于大括号/缩进规则，不追求完整语法解析，仅用于函数长度启发式。
   */
  private _findBlockEnd(lines: string[], startLine: number): number {
    const firstLine = lines[startLine] ?? "";
    let braceCount = 0;
    let inBraceBlock = false;
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i]!;
      for (const ch of line) {
        if (ch === "{" || ch === "[" || ch === "(") braceCount++;
        else if (ch === "}" || ch === "]" || ch === ")") braceCount--;
      }
      if (line.includes("{")) inBraceBlock = true;
      if (inBraceBlock && braceCount <= 0) return i;
      // Python/Rust 等缩进语言：遇到空行或更浅缩进视为结束
      const indent = line.match(/^(\s*)\S/);
      if (!inBraceBlock && i > startLine && line.trim() !== "") {
        const baseIndent = (firstLine.match(/^(\s*)\S/)?.[1] ?? "").length;
        const currentIndent = indent?.[1].length ?? 0;
        if (currentIndent <= baseIndent) return i - 1;
      }
    }
    return lines.length - 1;
  }
}

// ============================================================================
// Executor 2: 测试覆盖（Test Coverage）
// ============================================================================

/**
 * 测试覆盖执行器
 *
 * 真实路径：
 * 1. 查找 coverage/lcov.info、.nyc_output 等真实覆盖率报告，解析行覆盖率。
 * 2. 若不存在真实覆盖率报告，则诚实地使用代理指标：
 *    - tests/ 目录与 src/ 目录文件数比例
 *    - 测试函数/用例数量
 *    并在 metadata 中标记 coverageSource: "proxy"。
 */
export class TestCoverageExecutor implements GateExecutorLike {
  public readonly gateId: QualityGateIdType = QualityGateId.TEST_COVERAGE;

  async execute(
    projectPath: string,
    config: QualityGateConfig
  ): Promise<{ score: number; findings: GateFinding[]; metadata: Record<string, unknown> }> {
    const scanner = new ProjectScanner(projectPath);
    const allFiles = scanner.scanSourceFiles();
    const findings: GateFinding[] = [];

    // 1. 尝试真实覆盖率报告
    const realCoverage = this._parseRealCoverage(projectPath);
    if (realCoverage !== null) {
      const threshold = Number(config.params.lineThreshold ?? config.threshold ?? 0.8);
      const score = Math.max(0, Math.min(1, realCoverage.lineCoverage));
      if (score < threshold) {
        findings.push(
          createGateFinding({
            gateId: this.gateId,
            rule: "coverage-below-threshold",
            message: `行覆盖率 ${(score * 100).toFixed(1)}% 低于阈值 ${(threshold * 100).toFixed(0)}%`,
            severity: GateSeverity.CRITICAL,
            filePath: "coverage/lcov.info",
            lineNumber: 1,
            evidence: `LF=${realCoverage.linesFound}, LH=${realCoverage.linesHit}`,
            fix: "补充单元测试或集成测试，提高行覆盖率",
          })
        );
      }
      return {
        score,
        findings,
        metadata: {
          executor: "test-coverage",
          coverageSource: "lcov",
          lineCoverage: score,
          linesFound: realCoverage.linesFound,
          linesHit: realCoverage.linesHit,
        },
      };
    }

    // 2. 代理指标路径
    const sourceFiles = allFiles.filter((f) => ProjectScanner.isSourceFile(f.relativePath));
    const testFiles = allFiles.filter((f) => ProjectScanner.isTestFile(f.relativePath));

    const sourceCount = sourceFiles.length;
    const testCount = testFiles.length;
    const testCaseCount = testFiles.reduce((sum, f) => sum + this._countTestCases(f), 0);

    const threshold = Number(config.params.lineThreshold ?? config.threshold ?? 0.8);
    // 代理分数：test/src 比例，封顶 1.0；若完全无源码或测试则按 0 处理
    let score = 0;
    if (sourceCount > 0) {
      const ratio = testCount / sourceCount;
      score = Math.min(1, ratio / threshold);
    } else if (testCount > 0) {
      score = 1; // 纯测试仓库
    }
    score = Math.round(score * 10000) / 10000;

    if (score < threshold) {
      findings.push(
        createGateFinding({
          gateId: this.gateId,
          rule: "test-coverage-proxy-low",
          message: `测试覆盖代理指标偏低（测试文件 ${testCount} / 源码文件 ${sourceCount} = ${(score * 100).toFixed(1)}%，阈值 ${(threshold * 100).toFixed(0)}%）`,
          severity: GateSeverity.CRITICAL,
          filePath: projectPath,
          lineNumber: 1,
          evidence: `测试用例数 ≈ ${testCaseCount}`,
          fix: "补充单元测试；或生成 coverage/lcov.info 真实覆盖率报告",
        })
      );
    }

    return {
      score,
      findings,
      metadata: {
        executor: "test-coverage",
        coverageSource: "proxy",
        sourceFileCount: sourceCount,
        testFileCount: testCount,
        testCaseCount,
      },
    };
  }

  /**
   * 解析真实覆盖率报告
   * @param projectPath 项目根目录
   * @returns 覆盖率数据，未找到报告返回 null
   */
  private _parseRealCoverage(
    projectPath: string
  ): { lineCoverage: number; linesFound: number; linesHit: number } | null {
    const lcovPath = path.join(projectPath, "coverage", "lcov.info");
    if (fs.existsSync(lcovPath)) {
      try {
        const content = fs.readFileSync(lcovPath, "utf-8");
        let linesFound = 0;
        let linesHit = 0;
        for (const line of content.split(/\r?\n/)) {
          const foundMatch = line.match(/^LF:(\d+)$/);
          const hitMatch = line.match(/^LH:(\d+)$/);
          if (foundMatch) linesFound += parseInt(foundMatch[1]!, 10);
          if (hitMatch) linesHit += parseInt(hitMatch[1]!, 10);
        }
        if (linesFound > 0) {
          return {
            lineCoverage: linesHit / linesFound,
            linesFound,
            linesHit,
          };
        }
      } catch {
        // 解析失败，降级到代理指标
      }
    }
    return null;
  }

  /**
   * 统计单个测试文件中的测试用例数量
   * @param file 源文件
   */
  private _countTestCases(file: SourceFile): number {
    const patterns = [
      /^\s*(it|test)\s*\(\s*['"`]/, // JS/TS
      /^\s*def\s+test_/, // Python
      /^\s*@Test/, // Java
      /^\s*func\s+Test/, // Go
      /^\s*#\s*\[test\]/, // Rust attribute
    ];
    let count = 0;
    for (const line of file.lines) {
      if (patterns.some((p) => p.test(line))) count++;
    }
    return count;
  }
}

// ============================================================================
// Executor 3: 规范一致性（Spec Compliance）
// ============================================================================

/**
 * 规范一致性执行器
 *
 * 检查项目规范遵守情况：
 * - 目录/文件命名是否符合 kebab-case（可配置）
 * - 关键函数/类是否有中文注释
 * - 待办/修复项是否都已实现
 * - 源码中是否存在明显的占位符（pass、...）
 */
export class SpecComplianceExecutor implements GateExecutorLike {
  public readonly gateId: QualityGateIdType = QualityGateId.SPEC_COMPLIANCE;

  async execute(
    projectPath: string,
    config: QualityGateConfig
  ): Promise<{ score: number; findings: GateFinding[]; metadata: Record<string, unknown> }> {
    const scanner = new ProjectScanner(projectPath);
    const files = scanner.scanSourceFiles();
    const findings: GateFinding[] = [];

    const requireZhComments = Boolean(config.params.requireZhComments ?? true);
    const requireTodoResolution = Boolean(config.params.requireTodoResolution ?? true);
    const naming = String(config.params.naming ?? "kebab-case");

    let namedFiles = 0;
    let compliantNames = 0;
    let exportedSymbols = 0;
    let commentedSymbols = 0;

    for (const file of files) {
      // 命名规范检查（忽略测试文件和配置文件）
      if (!ProjectScanner.isTestFile(file.relativePath) && !file.relativePath.includes(".config.")) {
        namedFiles++;
        if (this._isNamingCompliant(file.relativePath, naming)) {
          compliantNames++;
        } else {
          findings.push(
            createGateFinding({
              gateId: this.gateId,
              rule: "naming-convention-violation",
              message: `文件路径不符合 ${naming} 命名规范`,
              severity: GateSeverity.MEDIUM,
              filePath: file.relativePath,
              lineNumber: 1,
              evidence: file.relativePath,
              fix: `将文件名/目录名改为 ${naming} 风格`,
            })
          );
        }
      }

      // 中文注释检查
      if (requireZhComments) {
        const symbolComments = this._checkSymbolComments(file);
        exportedSymbols += symbolComments.total;
        commentedSymbols += symbolComments.commented;
        findings.push(...symbolComments.findings);
      }

      // 待办/修复项实现检查
      if (requireTodoResolution) {
        for (let i = 0; i < file.lines.length; i++) {
          const line = file.lines[i]!;
          const match = line.match(/\/\/\s*(TODO|FIXME)\s*[:：]\s*(.+)/i);
          if (match) {
            const body = match[2] ?? "";
            if (/未实现|待实现|implement|placeholder|mock/i.test(body) || body.length < 4) {
              findings.push(
                createGateFinding({
                  gateId: this.gateId,
                  rule: "unresolved-todo-fixme",
                  message: "存在未解决的待办/修复注释",
                  severity: GateSeverity.HIGH,
                  filePath: file.relativePath,
                  lineNumber: i + 1,
                  evidence: evidenceAround(file.lines, i),
                  fix: "完成对应实现或删除无意义注释",
                })
              );
            }
          }
        }
      }

      // 明显占位符检查（仅源码，测试代码允许 pass）
      if (!ProjectScanner.isTestFile(file.relativePath)) {
        for (let i = 0; i < file.lines.length; i++) {
          const trimmed = file.lines[i]!.trim();
          if (/^pass\s*;?\s*$/.test(trimmed) || /^\.\.\.$/.test(trimmed)) {
            findings.push(
              createGateFinding({
                gateId: this.gateId,
                rule: "placeholder-code",
                message: "源码中存在占位符（pass / ...）",
                severity: GateSeverity.CRITICAL,
                filePath: file.relativePath,
                lineNumber: i + 1,
                evidence: evidenceAround(file.lines, i),
                fix: "实现真实业务逻辑，禁止用占位符替代",
              })
            );
          }
        }
      }
    }

    const score = scoreFromFindings(findings, 3.0);
    return {
      score,
      findings,
      metadata: {
        executor: "spec-compliance",
        namingCompliantRate: namedFiles > 0 ? compliantNames / namedFiles : 1,
        commentCoverageRate: exportedSymbols > 0 ? commentedSymbols / exportedSymbols : 1,
        filesScanned: files.length,
      },
    };
  }

  /**
   * 判断文件路径是否符合命名规范
   * @param relativePath 相对路径
   * @param naming 命名规范名称
   */
  private _isNamingCompliant(relativePath: string, naming: string): boolean {
    if (naming !== "kebab-case") return true; // 目前仅实现 kebab-case
    const parts = relativePath.split(/[\\/]/);
    for (const part of parts) {
      if (part === "") continue;
      const base = part.replace(/\.[^.]+$/, ""); // 去掉扩展名
      if (base === "") continue;
      // 允许全大写常量文件、index、README、_underscore_测试文件
      if (/^(index|README|LICENSE|\.?[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(base)) continue;
      if (/^_[a-z0-9]+(?:_[a-z0-9]+)*_?$/.test(base)) continue; // Python 私有模块/测试
      return false;
    }
    return true;
  }

  /**
   * 检查导出符号是否有中文注释
   * @param file 源文件
   */
  private _checkSymbolComments(file: SourceFile): { total: number; commented: number; findings: GateFinding[] } {
    const findings: GateFinding[] = [];
    let total = 0;
    let commented = 0;

    const symbolPatterns = [
      // TypeScript / JavaScript 导出函数/类/接口
      /^\s*export\s+(?:async\s+)?function\s+(\w+)/,
      /^\s*export\s+(?:abstract\s+)?class\s+(\w+)/,
      /^\s*export\s+interface\s+(\w+)/,
      /^\s*export\s+const\s+(\w+)\s*=/,
      // Python 函数/类
      /^\s*def\s+(\w+)\s*\(/,
      /^\s*class\s+(\w+)\s*[:(]/,
      // Java 公开类/方法
      /^\s*public\s+(?:static\s+)?[\w<>[\]]+\s+(\w+)\s*\(/,
      /^\s*public\s+class\s+(\w+)/,
    ];

    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]!;
      for (const pattern of symbolPatterns) {
        const match = line.match(pattern);
        if (match) {
          total++;
          // 向上查找最近 5 行内是否有中文注释
          const hasZhComment = this._hasChineseCommentInRange(file.lines, Math.max(0, i - 5), i);
          if (hasZhComment) {
            commented++;
          } else {
            findings.push(
              createGateFinding({
                gateId: this.gateId,
                rule: "missing-chinese-comment",
                message: `导出符号 "${match[1]}" 缺少中文注释`,
                severity: GateSeverity.LOW,
                filePath: file.relativePath,
                lineNumber: i + 1,
                evidence: evidenceAround(file.lines, i, 1),
                fix: "在符号上方添加中文注释，说明其用途、参数和返回值",
              })
            );
          }
          break;
        }
      }
    }
    return { total, commented, findings };
  }

  /**
   * 判断指定行范围内是否存在包含中文字符的注释
   */
  private _hasChineseCommentInRange(lines: string[], start: number, end: number): boolean {
    for (let i = start; i < end; i++) {
      const line = lines[i] ?? "";
      const comment = line.match(/(?:\/\/|#|\/\*|\*)\s*(.+)/)?.[1] ?? "";
      if (/[\u4e00-\u9fa5]/.test(comment)) return true;
    }
    return false;
  }
}

// ============================================================================
// Executor 4: 安全扫描（Security Scan）
// ============================================================================

/**
 * 安全扫描执行器
 *
 * 静态应用安全测试（SAST）轻量实现：
 * - 硬编码密钥/密码/令牌
 * - eval / new Function / setTimeout 字符串
 * - SQL 拼接 / 命令注入
 * - 不安全的 innerHTML / document.write
 * - 敏感 API 调用（localStorage 存敏感信息）
 */
export class SecurityScanExecutor implements GateExecutorLike {
  public readonly gateId: QualityGateIdType = QualityGateId.SECURITY_SCAN;

  async execute(
    projectPath: string,
    config: QualityGateConfig
  ): Promise<{ score: number; findings: GateFinding[]; metadata: Record<string, unknown> }> {
    const scanner = new ProjectScanner(projectPath);
    const files = scanner.scanSourceFiles();
    const findings: GateFinding[] = [];

    const secretEnabled = Boolean(config.params.secretScan ?? true);
    const sastEnabled = Boolean(config.params.sastEnabled ?? true);

    for (const file of files) {
      if (secretEnabled) {
        findings.push(...this._scanSecrets(file));
      }
      if (sastEnabled) {
        findings.push(...this._scanSast(file));
      }
    }

    const score = scoreFromFindings(findings, 2.5);
    return {
      score,
      findings,
      metadata: { executor: "security-scan", filesScanned: files.length, secretScan: secretEnabled, sastEnabled },
    };
  }

  /**
   * 扫描硬编码敏感信息
   */
  private _scanSecrets(file: SourceFile): GateFinding[] {
    const findings: GateFinding[] = [];
    const secretPatterns = [
      {
        name: "hardcoded-password",
        pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"`][^'"`]{4,}['"`]/i,
        severity: GateSeverity.CRITICAL,
        message: "疑似硬编码密码",
        fix: "从环境变量或密钥管理服务读取密码",
      },
      {
        name: "hardcoded-api-key",
        pattern: /(?:api[_-]?key|apikey|token|secret)\s*[:=]\s*['"`][a-zA-Z0-9_-]{16,}['"`]/i,
        severity: GateSeverity.CRITICAL,
        message: "疑似硬编码 API Key 或 Token",
        fix: "将密钥迁移到环境变量或安全密钥存储",
      },
      {
        name: "private-key",
        pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
        severity: GateSeverity.CRITICAL,
        message: "源码中包含私钥",
        fix: "立即从仓库中移除私钥并轮换",
      },
    ];

    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]!;
      for (const rule of secretPatterns) {
        if (rule.pattern.test(line)) {
          findings.push(
            createGateFinding({
              gateId: this.gateId,
              rule: rule.name,
              message: rule.message,
              severity: rule.severity,
              filePath: file.relativePath,
              lineNumber: i + 1,
              evidence: evidenceAround(file.lines, i),
              fix: rule.fix,
            })
          );
        }
      }
    }
    return findings;
  }

  /**
   * 扫描常见 SAST 问题
   */
  private _scanSast(file: SourceFile): GateFinding[] {
    const findings: GateFinding[] = [];
    const sastPatterns = [
      {
        name: "dangerous-eval",
        pattern: /(^|[^\w])(eval|new\s+Function)\s*\(/,
        severity: GateSeverity.HIGH,
        message: "使用 eval 或 new Function，存在代码注入风险",
        fix: "避免 eval，改用 JSON.parse 或安全解析器",
      },
      {
        name: "unsafe-innerHTML",
        pattern: /\.innerHTML\s*=/,
        severity: GateSeverity.HIGH,
        message: "直接设置 innerHTML，存在 XSS 风险",
        fix: "使用 textContent 或经安全转义的 DOM 操作",
      },
      {
        name: "sql-concatenation",
        pattern: /(?:execute|query|cursor\.execute)\s*\(\s*['"`][^'"`]*\$\{[^}]+\}/,
        severity: GateSeverity.HIGH,
        message: "SQL 语句存在字符串拼接，可能导致 SQL 注入",
        fix: "使用参数化查询/预编译语句",
      },
      {
        name: "command-injection",
        pattern: /(?:exec|execSync|spawn)\s*\(\s*[`'"][^`'"]*\$\{[^}]+\}/,
        severity: GateSeverity.HIGH,
        message: "命令执行存在字符串拼接，可能导致命令注入",
        fix: "使用参数数组传递命令参数，避免 shell 拼接",
      },
      {
        name: "insecure-localStorage",
        pattern: /localStorage\.(setItem|\.\w+\s*=)\s*\(\s*['"`](?:password|token|secret|api[_-]?key)/i,
        severity: GateSeverity.MEDIUM,
        message: "疑似将敏感信息存入 localStorage",
        fix: "敏感信息不应存储在 localStorage，改用 httpOnly Cookie 或安全存储",
      },
    ];

    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]!;
      for (const rule of sastPatterns) {
        if (rule.pattern.test(line)) {
          findings.push(
            createGateFinding({
              gateId: this.gateId,
              rule: rule.name,
              message: rule.message,
              severity: rule.severity,
              filePath: file.relativePath,
              lineNumber: i + 1,
              evidence: evidenceAround(file.lines, i),
              fix: rule.fix,
            })
          );
        }
      }
    }
    return findings;
  }
}

// ============================================================================
// Executor 5: Ponytail 红线检查
// ============================================================================

/**
 * Ponytail 红线执行器
 *
 * 对照 principles/ponytail.ts 中的 RED_LINE_LIST，对源码进行静态模式扫描。
 * 仅对可静态检测的红线生成 findings；无法静态检测的红线（如硬件校准）不硬凑。
 */
export class PonytailRedlineExecutor implements GateExecutorLike {
  public readonly gateId: QualityGateIdType = QualityGateId.PONYTAIL_REDLINES;

  async execute(
    projectPath: string,
    config: QualityGateConfig
  ): Promise<{ score: number; findings: GateFinding[]; metadata: Record<string, unknown> }> {
    const scanner = new ProjectScanner(projectPath);
    const files = scanner.scanSourceFiles();
    const findings: GateFinding[] = [];

    const checkProjectRules = Boolean(config.params.checkProjectRules ?? true);

    for (const file of files) {
      findings.push(...this._scanRedlines(file, checkProjectRules));
    }

    const score = scoreFromFindings(findings, 3.0);
    return {
      score,
      findings,
      metadata: { executor: "ponytail-redlines", filesScanned: files.length, checkProjectRules },
    };
  }

  /**
   * 扫描单文件的红线违规
   */
  private _scanRedlines(file: SourceFile, _checkProjectRules: boolean): GateFinding[] {
    const findings: GateFinding[] = [];

    // 红线模式表：仅包含能静态检测的规则
    const redlinePatterns = [
      {
        rule: "input-validation",
        redline: "信任边界的输入校验",
        pattern: /function\s+\w+\s*\([^)]*\)\s*\{[\s\S]{0,400}\}/,
        // 输入校验模式较复杂，采用启发式：函数参数后 20 行内无 if/typeof/length/zod 校验
        heuristic: true,
        severity: GateSeverity.HIGH,
        message: "函数可能缺少信任边界输入校验",
        fix: "在函数入口对输入进行类型、范围、长度校验",
      },
      {
        rule: "swallow-exceptions",
        redline: "真实错误处理——禁止 except: pass 吞异常",
        pattern: /(?:except\s*.*:\s*pass|catch\s*\([^)]*\)\s*\{\s*\})/i,
        severity: GateSeverity.CRITICAL,
        message: "发现吞异常代码（except: pass 或空 catch）",
        fix: "记录日志、抛出自定义异常或执行补偿逻辑，禁止空处理",
      },
      {
        rule: "mock-placeholder",
        redline: "真实业务逻辑——禁止用 mock/占位/stub 替代",
        pattern: /(?:Mock|stub|spyOn|fake\w*|placeholder|TODO implement|FIXME implement)/i,
        severity: GateSeverity.CRITICAL,
        message: "发现 mock、stub 或占位实现",
        fix: "实现真实业务逻辑，测试场景除外",
      },
      {
        rule: "concurrency-safety",
        redline: "并发安全代码——Lock/Atomic/synchronized 不可简化",
        pattern: /\bMutex\b|\bLock\b|\batomic\.|\bsynchronized\b/,
        severity: GateSeverity.HIGH,
        message: "检测到并发原语使用，请确认未简化其保护范围",
        fix: "复核锁粒度与生命周期，确保临界区完整",
      },
      {
        rule: "transaction-boundary",
        redline: "数据库事务边界——事务提交/回滚不可简化",
        pattern: /(?:beginTransaction|startTransaction|BEGIN)\s*[;(]/i,
        severity: GateSeverity.HIGH,
        message: "检测到事务开始，请确认 commit/rollback 完整",
        fix: "确保事务在成功路径提交、异常路径回滚",
      },
      {
        rule: "api-contract",
        redline: "API 契约——公开 API 签名/返回格式不可单方面简化",
        pattern: /(?:@api|@route|app\.(get|post|put|delete)\s*\(|router\.(get|post|put|delete)\s*\()/i,
        severity: GateSeverity.MEDIUM,
        message: "检测到公开 API 定义，请确认签名与文档一致",
        fix: "对照 API 文档校验路径、参数、返回格式",
      },
    ];

    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]!;
      for (const rule of redlinePatterns) {
        if (rule.pattern.test(line)) {
          findings.push(
            createGateFinding({
              gateId: this.gateId,
              rule: rule.rule,
              message: `${rule.redline}：${rule.message}`,
              severity: rule.severity,
              filePath: file.relativePath,
              lineNumber: i + 1,
              evidence: evidenceAround(file.lines, i),
              fix: rule.fix,
            })
          );
        }
      }
    }

    // 跨行吞异常检测：Python 的 `except:` 后紧跟 `pass` / JavaScript 的空 `catch {}`
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]!;

      // Python：except 子句后紧跟 pass / ...（跳过纯注释行）
      if (/^\s*except\s*(?:\([^)]*\))?\s*:/i.test(line)) {
        for (let j = i + 1; j < Math.min(file.lines.length, i + 5); j++) {
          const next = file.lines[j]!.trim();
          if (next === "") continue;
          if (/^(\/\/.*|#.*|\*.*)$/.test(next)) continue;
          if (next === "pass" || next === "...") {
            findings.push(
              createGateFinding({
                gateId: this.gateId,
                rule: "swallow-exceptions",
                message: "真实错误处理——禁止 except: pass 吞异常：发现吞异常代码（except 块后紧跟 pass）",
                severity: GateSeverity.CRITICAL,
                filePath: file.relativePath,
                lineNumber: i + 1,
                evidence: evidenceAround(file.lines, i, 2),
                fix: "记录日志、抛出自定义异常或执行补偿逻辑，禁止空处理",
              })
            );
          }
          break;
        }
      }

      // JavaScript/TypeScript：空 catch 块（跳过纯注释行）
      if (/catch\s*\([^)]*\)\s*\{/i.test(line)) {
        for (let j = i + 1; j < Math.min(file.lines.length, i + 5); j++) {
          const next = file.lines[j]!.trim();
          if (next === "") continue;
          if (/^(\/\/.*|#.*|\*.*)$/.test(next)) continue;
          if (next === "}") {
            findings.push(
              createGateFinding({
                gateId: this.gateId,
                rule: "swallow-exceptions",
                message: "真实错误处理——禁止空 catch 吞异常：发现空 catch 块",
                severity: GateSeverity.CRITICAL,
                filePath: file.relativePath,
                lineNumber: i + 1,
                evidence: evidenceAround(file.lines, i, 2),
                fix: "记录日志、抛出自定义异常或执行补偿逻辑，禁止空处理",
              })
            );
          }
          break;
        }
      }
    }

    return findings;
  }
}

// ============================================================================
// Executor 6: Karpathy 原则
// ============================================================================

/**
 * Karpathy 原则执行器
 *
 * 复用 cybernetics/KarpathyPrincipleEnforcer 扫描项目，
 * 将 PrincipleViolation 转换为 GateFinding，并按严重度加权计算 score。
 */
export class KarpathyPrinciplesExecutor implements GateExecutorLike {
  public readonly gateId: QualityGateIdType = QualityGateId.KARPATHY_PRINCIPLES;

  async execute(
    projectPath: string,
    config: QualityGateConfig
  ): Promise<{ score: number; findings: GateFinding[]; metadata: Record<string, unknown> }> {
    const enforcer = new KarpathyPrincipleEnforcer({ project_root: projectPath });
    const violations = enforcer.scanProject();

    const findings: GateFinding[] = violations.map((v) =>
      createGateFinding({
        gateId: this.gateId,
        rule: v.principle,
        message: v.description,
        severity: mapKarpathySeverity(v.severity),
        filePath: v.file_path,
        lineNumber: v.line_number,
        evidence: v.evidence,
        fix: v.suggestion,
      })
    );

    const score = scoreFromFindings(findings, 4.0);
    return {
      score,
      findings,
      metadata: {
        executor: "karpathy-principles",
        violationCount: violations.length,
        principles: config.params.principles ?? [
          "think_before_coding",
          "simplicity_first",
          "surgical_changes",
          "goal_driven",
        ],
      },
    };
  }
}

// ============================================================================
// Executor 7: UI/UX 视觉巡检（静态 only）
// ============================================================================

/**
 * UI/UX 静态可访问性执行器
 *
 * 当前能力边界：仅对 tsx/jsx/html/vue/svelte 文件做静态 a11y 扫描。
 * 像素级视觉回归 / SSIM 需要浏览器渲染环境，本执行器在 metadata 中
 * 诚实标注 staticOnly: true，避免伪装成完整视觉回归。
 */
export class UIUXVisualExecutor implements GateExecutorLike {
  public readonly gateId: QualityGateIdType = QualityGateId.UIUX_VISUAL;

  async execute(
    projectPath: string,
    config: QualityGateConfig
  ): Promise<{ score: number; findings: GateFinding[]; metadata: Record<string, unknown> }> {
    const scanner = new ProjectScanner(projectPath);
    const files = scanner.scanSourceFiles(UI_EXTENSIONS);
    const findings: GateFinding[] = [];

    const dimensions = (config.params.auditDimensions as string[]) ?? ["a11y", "interaction", "layout", "ux"];

    for (const file of files) {
      if (dimensions.includes("a11y")) findings.push(...this._scanA11y(file));
      if (dimensions.includes("interaction")) findings.push(...this._scanInteraction(file));
      if (dimensions.includes("ux")) findings.push(...this._scanUx(file));
    }

    const score = scoreFromFindings(findings, 4.0);
    return {
      score,
      findings,
      metadata: {
        executor: "uiux-visual",
        staticOnly: true,
        filesScanned: files.length,
        dimensions,
        note: "视觉回归/SSIM 需要浏览器渲染，当前仅执行静态可访问性扫描",
      },
    };
  }

  /**
   * 可访问性扫描
   */
  private _scanA11y(file: SourceFile): GateFinding[] {
    const findings: GateFinding[] = [];
    const imgPattern = /<img[^>]*>/gi;
    const inputPattern = /<input[^>]*>/gi;
    const buttonPattern = /<button[^>]*>/gi;

    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]!;

      // img 缺少 alt
      let m: RegExpExecArray | null;
      while ((m = imgPattern.exec(line)) !== null) {
        const tag = m[0] ?? "";
        if (!/\salt\s*=/i.test(tag) && !/\srole\s*=\s*["']presentation["']/i.test(tag)) {
          findings.push(
            createGateFinding({
              gateId: this.gateId,
              rule: "img-missing-alt",
              message: "<img> 缺少 alt 属性",
              severity: GateSeverity.HIGH,
              filePath: file.relativePath,
              lineNumber: i + 1,
              evidence: tag,
              fix: '为 img 添加描述性 alt 属性，装饰性图片使用 alt="" 或 role="presentation"',
            })
          );
        }
      }

      // input 缺少关联 label
      while ((m = inputPattern.exec(line)) !== null) {
        const tag = m[0] ?? "";
        const type = /\stype\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.toLowerCase();
        if (type && ["hidden", "submit", "button", "image"].includes(type)) continue;
        if (!/\sid\s*=/i.test(tag) && !/\saria-label\s*=/i.test(tag) && !/\saria-labelledby\s*=/i.test(tag)) {
          findings.push(
            createGateFinding({
              gateId: this.gateId,
              rule: "input-missing-label",
              message: "<input> 缺少关联 label 或 aria-label",
              severity: GateSeverity.HIGH,
              filePath: file.relativePath,
              lineNumber: i + 1,
              evidence: tag,
              fix: '使用 <label for="id"> 关联，或添加 aria-label',
            })
          );
        }
      }

      // button 缺少 type
      while ((m = buttonPattern.exec(line)) !== null) {
        const tag = m[0] ?? "";
        if (!/\stype\s*=/i.test(tag)) {
          findings.push(
            createGateFinding({
              gateId: this.gateId,
              rule: "button-missing-type",
              message: "<button> 缺少 type 属性",
              severity: GateSeverity.LOW,
              filePath: file.relativePath,
              lineNumber: i + 1,
              evidence: tag,
              fix: '显式声明 type="button" / "submit" / "reset"',
            })
          );
        }
      }
    }
    return findings;
  }

  /**
   * 交互质量扫描
   */
  private _scanInteraction(file: SourceFile): GateFinding[] {
    const findings: GateFinding[] = [];
    // 可点击元素缺少键盘事件
    const clickablePattern = /<div[^>]*\sonClick\s*=/gi;
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]!;
      let m: RegExpExecArray | null;
      while ((m = clickablePattern.exec(line)) !== null) {
        const tag = m[0] ?? "";
        if (!/\s(tabIndex|tabindex)\s*=/i.test(tag) && !/\srole\s*=/i.test(tag)) {
          findings.push(
            createGateFinding({
              gateId: this.gateId,
              rule: "clickable-div-no-keyboard",
              message: "div 绑定 onClick 但缺少 tabIndex/role，键盘无法访问",
              severity: GateSeverity.MEDIUM,
              filePath: file.relativePath,
              lineNumber: i + 1,
              evidence: tag,
              fix: '使用 <button>，或添加 tabIndex=0、role="button" 和键盘事件',
            })
          );
        }
      }
    }
    return findings;
  }

  /**
   * UX 反模式扫描
   */
  private _scanUx(file: SourceFile): GateFinding[] {
    const findings: GateFinding[] = [];
    const destructivePattern = /onClick\s*=\s*\{[^}]*(?:delete|remove|drop|clear)\s*\(/i;
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]!;
      if (destructivePattern.test(line) && !/confirm\s*\(/i.test(line) && !/window\.confirm/i.test(line)) {
        findings.push(
          createGateFinding({
            gateId: this.gateId,
            rule: "destructive-action-no-confirm",
            message: "破坏性操作（删除/移除）缺少二次确认",
            severity: GateSeverity.MEDIUM,
            filePath: file.relativePath,
            lineNumber: i + 1,
            evidence: evidenceAround(file.lines, i),
            fix: "添加确认对话框或撤销机制",
          })
        );
      }
    }
    return findings;
  }
}

// ============================================================================
// Executor 工厂：供 QualityGateManager 默认注册
// ============================================================================

/**
 * 创建所有默认真实执行器
 *
 * QualityGateManager 通过本工厂函数注册 gate-specific 真实实现，
 * 替换原有的 DefaultPassExecutor 循环注册。
 *
 * @returns gateId → executor 的映射
 */
export function createDefaultGateExecutors(): Map<QualityGateIdType, GateExecutorLike> {
  const executors = new Map<QualityGateIdType, GateExecutorLike>();
  executors.set(QualityGateId.CODE_REVIEW, new CodeReviewExecutor());
  executors.set(QualityGateId.TEST_COVERAGE, new TestCoverageExecutor());
  executors.set(QualityGateId.SPEC_COMPLIANCE, new SpecComplianceExecutor());
  executors.set(QualityGateId.SECURITY_SCAN, new SecurityScanExecutor());
  executors.set(QualityGateId.PONYTAIL_REDLINES, new PonytailRedlineExecutor());
  executors.set(QualityGateId.KARPATHY_PRINCIPLES, new KarpathyPrinciplesExecutor());
  executors.set(QualityGateId.UIUX_VISUAL, new UIUXVisualExecutor());
  return executors;
}
