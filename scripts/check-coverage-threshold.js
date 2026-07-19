#!/usr/bin/env node
/**
 * 覆盖率阈值检查脚本（EAG-P3 批次 12 C3 CI 强化）
 *
 * 功能：
 *   解析 lcov 格式的覆盖率报告，与预设阈值对比，未达标则退出码 1。
 *   仅使用 Node.js 内置模块（fs / path / process），零新增依赖（对齐 P-2）。
 *
 * 使用方式：
 *   node scripts/check-coverage-threshold.js <lcov-file> [--lines 80] [--branches 70] [--functions 85]
 *
 * 默认阈值（对齐设计文档 §5.1 D-C3-3）：
 *   - 行覆盖率（lines）      ≥ 80%
 *   - 分支覆盖率（branches）  ≥ 70%
 *   - 函数覆盖率（functions） ≥ 85%
 *
 * lcov 格式说明（仅使用以下 6 个字段）：
 *   - LF:<n>   模块总行数（Lines Found）
 *   - LH:<n>   模块已覆盖行数（Lines Hit）
 *   - BRF:<n>  模块总分支数（BRanches Found）
 *   - BRH:<n>  模块已覆盖分支数（BRanches Hit）
 *   - FNF:<n>  模块总函数数（Functions Found）
 *   - FNH:<n>  模块已覆盖函数数（Functions Hit）
 *
 * 退出码：
 *   0 = 全部阈值达标
 *   1 = lcov 文件不存在 / 入参非法 / 任一阈值未达标
 *
 * 设计依据：
 * - EAG-P3 批次 12 设计文档 §5.1 D-C3-2 / D-C3-3 / D-C3-13
 * - EAG-P3 批次 12 设计文档 §5.4 测试覆盖率报告
 *
 * @module scripts/check-coverage-threshold
 */

import { readFileSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import process from "node:process";

// ============================================================================
// 常量与配置
// ============================================================================

/**
 * 默认覆盖率阈值（对齐设计文档 §5.1 D-C3-3）
 *
 * 不可变优先：使用 Object.freeze 冻结，防止运行期被修改。
 */
const DEFAULT_THRESHOLDS = Object.freeze({
  lines: 80,
  branches: 70,
  functions: 85,
});

/**
 * lcov 报告字段前缀常量
 *
 * 使用前缀常量集中管理，避免散落在解析逻辑中导致拼写错误。
 */
const LCOV_PREFIX = Object.freeze({
  LINES_FOUND: "LF:",
  LINES_HIT: "LH:",
  BRANCHES_FOUND: "BRF:",
  BRANCHES_HIT: "BRH:",
  FUNCTIONS_FOUND: "FNF:",
  FUNCTIONS_HIT: "FNH:",
});

// ============================================================================
// 参数解析
// ============================================================================

/**
 * 解析命令行参数
 *
 * 解析规则：
 *   - 第一个非 -- 开头的参数视为 lcov 文件路径
 *   - --lines <n>    覆盖行覆盖率阈值
 *   - --branches <n> 覆盖分支覆盖率阈值
 *   - --functions <n> 覆盖函数覆盖率阈值
 *   - --help / -h    输出帮助信息
 *
 * @param {ReadonlyArray<string>} args - process.argv.slice(2) 后的参数数组
 * @returns {{lcovFile: string|null, thresholds: {lines: number, branches: number, functions: number}, showHelp: boolean}} 解析结果
 */
function parseArgs(args) {
  /** @type {{lines: number, branches: number, functions: number}} */
  const thresholds = { ...DEFAULT_THRESHOLDS };
  /** @type {string|null} */
  let lcovFile = null;
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // 帮助标志
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }

    // 阈值参数（--lines / --branches / --functions）
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      // 仅接受预定义的阈值键
      if (!(key in thresholds)) {
        throw new Error(`未知参数：${arg}（仅支持 --lines / --branches / --functions）`);
      }
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`参数 ${arg} 缺少数值`);
      }
      const num = Number.parseInt(value, 10);
      if (Number.isNaN(num) || num < 0 || num > 100) {
        throw new Error(`参数 ${arg} 数值非法：${value}（应为 0-100 的整数）`);
      }
      thresholds[key] = num;
      i++; // 跳过下一个参数（已作为数值消费）
      continue;
    }

    // 第一个非 -- 参数视为 lcov 文件路径
    if (lcovFile === null) {
      lcovFile = arg;
    } else {
      throw new Error(`多余的位置参数：${arg}（仅支持一个 lcov 文件路径）`);
    }
  }

  return { lcovFile, thresholds, showHelp };
}

// ============================================================================
// lcov 解析
// ============================================================================

/**
 * 从单行 lcov 数据中提取数值
 *
 * @param {string} line - lcov 行
 * @param {string} prefix - 字段前缀（如 "LF:"）
 * @returns {number} 解析后的数值；若行不以 prefix 开头则返回 0
 */
function extractLcovValue(line, prefix) {
  if (!line.startsWith(prefix)) {
    return 0;
  }
  const valueStr = line.slice(prefix.length).trim();
  const num = Number.parseInt(valueStr, 10);
  return Number.isNaN(num) ? 0 : num;
}

/**
 * 解析 lcov 报告内容
 *
 * 解析策略：
 *   - 按行迭代，累加 LF/LH/BRF/BRH/FNF/FNH 字段
 *   - 忽略空行与未识别字段
 *   - 多个 section（SF:...）的数值会被累加，得到全量覆盖率
 *
 * @param {string} content - lcov 文件内容
 * @returns {{totalLines: number, coveredLines: number, totalBranches: number, coveredBranches: number, totalFunctions: number, coveredFunctions: number}} 累加后的覆盖率统计
 */
function parseLcov(content) {
  let totalLines = 0;
  let coveredLines = 0;
  let totalBranches = 0;
  let coveredBranches = 0;
  let totalFunctions = 0;
  let coveredFunctions = 0;

  // 按行切分（兼容 \r\n 与 \n）
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    // 跳过空行与注释
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    totalLines += extractLcovValue(line, LCOV_PREFIX.LINES_FOUND);
    coveredLines += extractLcovValue(line, LCOV_PREFIX.LINES_HIT);
    totalBranches += extractLcovValue(line, LCOV_PREFIX.BRANCHES_FOUND);
    coveredBranches += extractLcovValue(line, LCOV_PREFIX.BRANCHES_HIT);
    totalFunctions += extractLcovValue(line, LCOV_PREFIX.FUNCTIONS_FOUND);
    coveredFunctions += extractLcovValue(line, LCOV_PREFIX.FUNCTIONS_HIT);
  }

  return {
    totalLines,
    coveredLines,
    totalBranches,
    coveredBranches,
    totalFunctions,
    coveredFunctions,
  };
}

// ============================================================================
// 覆盖率计算与阈值检查
// ============================================================================

/**
 * 计算百分比（避免除零）
 *
 * @param {number} covered - 已覆盖数量
 * @param {number} total - 总数量
 * @returns {number} 覆盖率（0-100，保留两位小数精度由调用方处理）
 */
function computePercentage(covered, total) {
  // 当总数量为 0 时，约定覆盖率为 100%（无代码可覆盖，不视为缺陷）
  if (total === 0) {
    return 100;
  }
  return (covered / total) * 100;
}

/**
 * 阈值检查结果
 *
 * @typedef {Object} ThresholdCheckResult
 * @property {number} linesPct - 行覆盖率（0-100）
 * @property {number} branchesPct - 分支覆盖率（0-100）
 * @property {number} functionsPct - 函数覆盖率（0-100）
 * @property {{lines: number, branches: number, functions: number}} thresholds - 阈值配置
 * @property {ReadonlyArray<string>} failures - 未达标项列表（空数组表示全部达标）
 */

/**
 * 执行阈值检查
 *
 * @param {{totalLines: number, coveredLines: number, totalBranches: number, coveredBranches: number, totalFunctions: number, coveredFunctions: number}} stats - lcov 解析统计
 * @param {{lines: number, branches: number, functions: number}} thresholds - 阈值配置
 * @returns {ThresholdCheckResult} 检查结果
 */
function checkThresholds(stats, thresholds) {
  const linesPct = computePercentage(stats.coveredLines, stats.totalLines);
  const branchesPct = computePercentage(stats.coveredBranches, stats.totalBranches);
  const functionsPct = computePercentage(stats.coveredFunctions, stats.totalFunctions);

  /** @type {string[]} */
  const failures = [];
  if (linesPct < thresholds.lines) {
    failures.push(`行覆盖率未达标：${linesPct.toFixed(2)}% < ${thresholds.lines}%`);
  }
  if (branchesPct < thresholds.branches) {
    failures.push(`分支覆盖率未达标：${branchesPct.toFixed(2)}% < ${thresholds.branches}%`);
  }
  if (functionsPct < thresholds.functions) {
    failures.push(`函数覆盖率未达标：${functionsPct.toFixed(2)}% < ${thresholds.functions}%`);
  }

  return {
    linesPct,
    branchesPct,
    functionsPct,
    thresholds,
    failures: Object.freeze(failures),
  };
}

// ============================================================================
// 帮助信息
// ============================================================================

/**
 * 输出帮助信息到 stdout
 */
function printHelp() {
  const help = `
覆盖率阈值检查脚本（EAG-P3 批次 12 C3）

使用方式：
  node scripts/check-coverage-threshold.js <lcov-file> [options]

参数：
  <lcov-file>          lcov 格式覆盖率报告路径（必填）

选项：
  --lines <n>          行覆盖率阈值（0-100，默认 80）
  --branches <n>       分支覆盖率阈值（0-100，默认 70）
  --functions <n>      函数覆盖率阈值（0-100，默认 85）
  -h, --help           输出此帮助信息

退出码：
  0 = 全部阈值达标
  1 = lcov 文件不存在 / 入参非法 / 任一阈值未达标

示例：
  node scripts/check-coverage-threshold.js coverage.lcov
  node scripts/check-coverage-threshold.js coverage.lcov --lines 80 --branches 70 --functions 85
`.trim();

  console.log(help);
}

// ============================================================================
// 主流程
// ============================================================================

/**
 * 主入口函数
 *
 * @param {ReadonlyArray<string>} argv - 命令行参数（process.argv.slice(2)）
 * @returns {number} 退出码（0 成功 / 1 失败）
 */
function main(argv) {
  // 解析参数
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`❌ 参数解析失败：${err.message}`);
    printHelp();
    return 1;
  }

  if (parsed.showHelp) {
    printHelp();
    return 0;
  }

  const { lcovFile, thresholds } = parsed;

  // 校验 lcov 文件路径
  if (!lcovFile) {
    console.error("❌ 未指定 lcov 文件路径");
    printHelp();
    return 1;
  }

  const lcovPath = resolve(lcovFile);
  if (!existsSync(lcovPath)) {
    console.error(`❌ lcov 文件不存在：${lcovPath}`);
    return 1;
  }

  // 校验文件扩展名（仅支持 .lcov / .info / .txt，避免误传 .json）
  const ext = extname(lcovPath).toLowerCase();
  const allowedExts = [".lcov", ".info", ".txt", ""];
  if (!allowedExts.includes(ext)) {
    console.error(`❌ lcov 文件扩展名不支持：${ext}（仅支持 .lcov / .info / .txt）`);
    return 1;
  }

  // 读取并解析 lcov 文件
  const content = readFileSync(lcovPath, "utf-8");
  const stats = parseLcov(content);

  // 阈值检查
  const result = checkThresholds(stats, thresholds);

  // 输出检查结果
  console.log("覆盖率报告：");
  console.log(`  行覆盖率：${result.linesPct.toFixed(2)}% (阈值 ${thresholds.lines}%)`);
  console.log(`  分支覆盖率：${result.branchesPct.toFixed(2)}% (阈值 ${thresholds.branches}%)`);
  console.log(`  函数覆盖率：${result.functionsPct.toFixed(2)}% (阈值 ${thresholds.functions}%)`);

  if (result.failures.length > 0) {
    console.error("\n❌ 覆盖率阈值检查失败：");
    for (const failure of result.failures) {
      console.error(`  - ${failure}`);
    }
    return 1;
  }

  console.log("\n✅ 覆盖率全部达标");
  return 0;
}

// ============================================================================
// 模块导出（供单元测试使用）
// ============================================================================

export {
  DEFAULT_THRESHOLDS,
  LCOV_PREFIX,
  parseArgs,
  parseLcov,
  extractLcovValue,
  computePercentage,
  checkThresholds,
  main,
};

// ============================================================================
// CLI 入口（仅在直接执行时运行，被 import 时不执行）
// ============================================================================

// 当作 CLI 直接执行时，调用 main 并以退出码退出
// 通过 import.meta.url 判断是否为入口模块
if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = main(process.argv.slice(2));
  process.exit(exitCode);
}
