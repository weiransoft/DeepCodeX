/**
 * EAG-P3 批次 12 单元测试：C3 CI 覆盖率阈值检查脚本
 *
 * 测试范围（对齐设计文档 §5.4 / §5.1 D-C3-2 / D-C3-3 / D-C3-13）：
 * - T1. lcov 解析：单 section 累加 LF/LH/BRF/BRH/FNF/FNH
 * - T2. lcov 解析：多 section 累加（不同 SF 文件的覆盖率累加）
 * - T3. lcov 解析：忽略空行与注释（# 开头）
 * - T4. lcov 解析：兼容 \r\n 与 \n 换行
 * - T5. 覆盖率计算：除零保护（total=0 时返回 100%）
 * - T6. 覆盖率计算：正常百分比计算（保留两位小数）
 * - T7. 阈值检查：全部达标 → failures 为空
 * - T8. 阈值检查：行覆盖率不达标 → failures 含行覆盖率项
 * - T9. 阈值检查：分支覆盖率不达标 → failures 含分支覆盖率项
 * - T10. 阈值检查：函数覆盖率不达标 → failures 含函数覆盖率项
 * - T11. 阈值检查：多维度同时不达标 → failures 包含全部未达标项
 * - T12. CLI 行为：合法 lcov + 全部达标 → 退出码 0
 * - T13. CLI 行为：合法 lcov + 部分不达标 → 退出码 1
 * - T14. CLI 行为：未指定 lcov 文件 → 退出码 1
 * - T15. CLI 行为：lcov 文件不存在 → 退出码 1
 * - T16. CLI 行为：自定义阈值参数（--lines/--branches/--functions）
 * - T17. CLI 行为：--help 输出帮助信息且退出码 0
 * - T18. CLI 行为：未知参数 → 退出码 1
 * - T19. CLI 行为：阈值数值越界（<0 / >100）→ 退出码 1
 * - T20. 不可变性：DEFAULT_THRESHOLDS 已冻结
 * - T21. 不可变性：LCOV_PREFIX 已冻结
 * - T22. 不可变性：checkThresholds 返回的 failures 数组已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实 lcov 文件 + 真实 CLI 子进程调用
 * - 临时文件通过 fs.mkdtempSync 创建，测试后自动清理
 *
 * 设计依据：
 * - EAG-P3 批次 12 设计文档 §5.4 测试覆盖率报告
 * - EAG-P3 批次 12 设计文档 §5.1 D-C3-2 / D-C3-3 / D-C3-13
 * - scripts/check-coverage-threshold.js（被测脚本）
 *
 * @module core/tests/eag-ci-coverage-threshold
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ============================================================================
// 常量与路径
// ============================================================================

/**
 * 被测脚本路径：scripts/check-coverage-threshold.js
 *
 * 使用 import.meta.url 推算项目根目录，避免硬编码绝对路径。
 * 测试文件位于 packages/core/src/tests/，回退 4 级到项目根 DeepCodeX-cli：
 *   - ../           → packages/core/src/
 *   - ../../        → packages/core/
 *   - ../../../     → packages/
 *   - ../../../../  → DeepCodeX-cli/（项目根）
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 从 packages/core/src/tests/ 回退 4 级到项目根
const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT_PATH = path.join(PROJECT_ROOT, "scripts", "check-coverage-threshold.js");

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 创建临时目录
 *
 * @returns 临时目录绝对路径
 */
function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eag-ci-coverage-threshold-"));
}

/**
 * 清理临时目录
 *
 * @param dir 临时目录路径
 */
function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

/**
 * 构造 lcov 报告内容（真实 lcov 格式，非 mock）
 *
 * @param sections section 列表（每个 section 含 SF/LF/LH/BRF/BRH/FNF/FNH）
 * @returns lcov 文本内容
 */
function buildLcovContent(
  sections: ReadonlyArray<{
    sf: string;
    lf: number;
    lh: number;
    brf: number;
    brh: number;
    fnf: number;
    fnh: number;
  }>
): string {
  const lines: string[] = [];
  for (const s of sections) {
    lines.push(`SF:${s.sf}`);
    lines.push(`LF:${s.lf}`);
    lines.push(`LH:${s.lh}`);
    lines.push(`BRF:${s.brf}`);
    lines.push(`BRH:${s.brh}`);
    lines.push(`FNF:${s.fnf}`);
    lines.push(`FNH:${s.fnh}`);
    lines.push("end_of_record");
  }
  return lines.join("\n") + "\n";
}

/**
 * 调用 check-coverage-threshold.js CLI
 *
 * 通过 spawnSync 启动真实子进程，传入真实 lcov 文件路径。
 * 不使用 mock，是真实的端到端 CLI 测试。
 *
 * @param args 命令行参数数组
 * @param cwd 子进程工作目录（默认 PROJECT_ROOT）
 * @returns 子进程结果（status / stdout / stderr）
 */
function runCli(
  args: ReadonlyArray<string>,
  cwd: string = PROJECT_ROOT
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf-8",
    // 确保不继承父进程环境中的干扰变量
    env: { ...process.env, NODE_ENV: "test" },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ============================================================================
// T1. lcov 解析：单 section 累加
// ============================================================================

test("T1. lcov 解析：单 section 累加 LF/LH/BRF/BRH/FNF/FNH", () => {
  // 直接通过 dynamic import 加载脚本模块，测试纯函数
  // 使用 file:// URL 加载 ESM 模块
  const scriptUrl = new URL(`file://${SCRIPT_PATH}`).href;

  return import(scriptUrl).then((mod) => {
    const lcov = buildLcovContent([
      {
        sf: "src/foo.ts",
        lf: 100,
        lh: 80,
        brf: 20,
        brh: 14,
        fnf: 10,
        fnh: 9,
      },
    ]);
    const stats = mod.parseLcov(lcov);
    assert.equal(stats.totalLines, 100);
    assert.equal(stats.coveredLines, 80);
    assert.equal(stats.totalBranches, 20);
    assert.equal(stats.coveredBranches, 14);
    assert.equal(stats.totalFunctions, 10);
    assert.equal(stats.coveredFunctions, 9);
  });
});

// ============================================================================
// T2. lcov 解析：多 section 累加
// ============================================================================

test("T2. lcov 解析：多 section 累加", () => {
  const scriptUrl = new URL(`file://${SCRIPT_PATH}`).href;

  return import(scriptUrl).then((mod) => {
    const lcov = buildLcovContent([
      { sf: "src/foo.ts", lf: 100, lh: 80, brf: 20, brh: 14, fnf: 10, fnh: 9 },
      { sf: "src/bar.ts", lf: 50, lh: 40, brf: 10, brh: 5, fnf: 5, fnh: 3 },
    ]);
    const stats = mod.parseLcov(lcov);
    assert.equal(stats.totalLines, 150);
    assert.equal(stats.coveredLines, 120);
    assert.equal(stats.totalBranches, 30);
    assert.equal(stats.coveredBranches, 19);
    assert.equal(stats.totalFunctions, 15);
    assert.equal(stats.coveredFunctions, 12);
  });
});

// ============================================================================
// T3. lcov 解析：忽略空行与注释
// ============================================================================

test("T3. lcov 解析：忽略空行与注释（# 开头）", () => {
  const scriptUrl = new URL(`file://${SCRIPT_PATH}`).href;

  return import(scriptUrl).then((mod) => {
    const lcov = [
      "# This is a comment line",
      "",
      "SF:src/foo.ts",
      "LF:100",
      "LH:80",
      "BRF:20",
      "BRH:14",
      "FNF:10",
      "FNH:9",
      "end_of_record",
      "",
      "# trailing comment",
    ].join("\n");
    const stats = mod.parseLcov(lcov);
    assert.equal(stats.totalLines, 100);
    assert.equal(stats.coveredLines, 80);
  });
});

// ============================================================================
// T4. lcov 解析：兼容 \r\n 与 \n 换行
// ============================================================================

test("T4. lcov 解析：兼容 CRLF (\\r\\n) 与 LF (\\n) 换行", () => {
  const scriptUrl = new URL(`file://${SCRIPT_PATH}`).href;

  return import(scriptUrl).then((mod) => {
    const lcovCrlf =
      ["SF:src/foo.ts", "LF:100", "LH:80", "BRF:20", "BRH:14", "FNF:10", "FNH:9", "end_of_record"].join("\r\n") +
      "\r\n";
    const stats = mod.parseLcov(lcovCrlf);
    assert.equal(stats.totalLines, 100);
    assert.equal(stats.coveredLines, 80);
    assert.equal(stats.totalBranches, 20);
    assert.equal(stats.coveredBranches, 14);
  });
});

// ============================================================================
// T5. 覆盖率计算：除零保护
// ============================================================================

test("T5. 覆盖率计算：total=0 时返回 100%", () => {
  const scriptUrl = new URL(`file://${SCRIPT_PATH}`).href;

  return import(scriptUrl).then((mod) => {
    assert.equal(mod.computePercentage(0, 0), 100);
    assert.equal(mod.computePercentage(10, 0), 100);
  });
});

// ============================================================================
// T6. 覆盖率计算：正常百分比
// ============================================================================

test("T6. 覆盖率计算：正常百分比", () => {
  const scriptUrl = new URL(`file://${SCRIPT_PATH}`).href;

  return import(scriptUrl).then((mod) => {
    // 80/100 = 80%
    assert.equal(mod.computePercentage(80, 100), 80);
    // 14/20 = 70%
    assert.equal(mod.computePercentage(14, 20), 70);
    // 9/10 = 90%
    assert.equal(mod.computePercentage(9, 10), 90);
  });
});

// ============================================================================
// T7. 阈值检查：全部达标
// ============================================================================

test("T7. 阈值检查：全部达标 → failures 为空", () => {
  const scriptUrl = new URL(`file://${SCRIPT_PATH}`).href;

  return import(scriptUrl).then((mod) => {
    const stats = {
      totalLines: 100,
      coveredLines: 85, // 85% >= 80%
      totalBranches: 20,
      coveredBranches: 15, // 75% >= 70%
      totalFunctions: 10,
      coveredFunctions: 9, // 90% >= 85%
    };
    const thresholds = { lines: 80, branches: 70, functions: 85 };
    const result = mod.checkThresholds(stats, thresholds);
    assert.equal(result.failures.length, 0);
    assert.equal(result.linesPct, 85);
    assert.equal(result.branchesPct, 75);
    assert.equal(result.functionsPct, 90);
  });
});

// ============================================================================
// T8. 阈值检查：行覆盖率不达标
// ============================================================================

test("T8. 阈值检查：行覆盖率不达标 → failures 含行覆盖率项", () => {
  const scriptUrl = new URL(`file://${SCRIPT_PATH}`).href;

  return import(scriptUrl).then((mod) => {
    const stats = {
      totalLines: 100,
      coveredLines: 70, // 70% < 80%
      totalBranches: 20,
      coveredBranches: 15,
      totalFunctions: 10,
      coveredFunctions: 9,
    };
    const thresholds = { lines: 80, branches: 70, functions: 85 };
    const result = mod.checkThresholds(stats, thresholds);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /行覆盖率未达标/);
  });
});

// ============================================================================
// T9. 阈值检查：分支覆盖率不达标
// ============================================================================

test("T9. 阈值检查：分支覆盖率不达标 → failures 含分支覆盖率项", () => {
  const scriptUrl = new URL(`file://${SCRIPT_PATH}`).href;

  return import(scriptUrl).then((mod) => {
    const stats = {
      totalLines: 100,
      coveredLines: 85,
      totalBranches: 20,
      coveredBranches: 10, // 50% < 70%
      totalFunctions: 10,
      coveredFunctions: 9,
    };
    const thresholds = { lines: 80, branches: 70, functions: 85 };
    const result = mod.checkThresholds(stats, thresholds);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /分支覆盖率未达标/);
  });
});

// ============================================================================
// T10. 阈值检查：函数覆盖率不达标
// ============================================================================

test("T10. 阈值检查：函数覆盖率不达标 → failures 含函数覆盖率项", () => {
  const scriptUrl = new URL(`file://${SCRIPT_PATH}`).href;

  return import(scriptUrl).then((mod) => {
    const stats = {
      totalLines: 100,
      coveredLines: 85,
      totalBranches: 20,
      coveredBranches: 15,
      totalFunctions: 10,
      coveredFunctions: 7, // 70% < 85%
    };
    const thresholds = { lines: 80, branches: 70, functions: 85 };
    const result = mod.checkThresholds(stats, thresholds);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /函数覆盖率未达标/);
  });
});

// ============================================================================
// T11. 阈值检查：多维度同时不达标
// ============================================================================

test("T11. 阈值检查：多维度同时不达标 → failures 包含全部未达标项", () => {
  const scriptUrl = new URL(`file://${SCRIPT_PATH}`).href;

  return import(scriptUrl).then((mod) => {
    const stats = {
      totalLines: 100,
      coveredLines: 50, // 50% < 80%
      totalBranches: 20,
      coveredBranches: 5, // 25% < 70%
      totalFunctions: 10,
      coveredFunctions: 5, // 50% < 85%
    };
    const thresholds = { lines: 80, branches: 70, functions: 85 };
    const result = mod.checkThresholds(stats, thresholds);
    assert.equal(result.failures.length, 3);
    assert.match(result.failures[0], /行覆盖率未达标/);
    assert.match(result.failures[1], /分支覆盖率未达标/);
    assert.match(result.failures[2], /函数覆盖率未达标/);
  });
});

// ============================================================================
// T12. CLI 行为：合法 lcov + 全部达标 → 退出码 0
// ============================================================================

test("T12. CLI 行为：合法 lcov + 全部达标 → 退出码 0", () => {
  const tmpDir = createTmpDir();
  try {
    const lcovPath = path.join(tmpDir, "coverage.lcov");
    const lcov = buildLcovContent([
      {
        sf: "src/foo.ts",
        lf: 100,
        lh: 85, // 85% >= 80%
        brf: 20,
        brh: 15, // 75% >= 70%
        fnf: 10,
        fnh: 9, // 90% >= 85%
      },
    ]);
    fs.writeFileSync(lcovPath, lcov, "utf-8");

    const result = runCli([lcovPath]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /覆盖率全部达标/);
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

// ============================================================================
// T13. CLI 行为：合法 lcov + 部分不达标 → 退出码 1
// ============================================================================

test("T13. CLI 行为：合法 lcov + 部分不达标 → 退出码 1", () => {
  const tmpDir = createTmpDir();
  try {
    const lcovPath = path.join(tmpDir, "coverage.lcov");
    const lcov = buildLcovContent([
      {
        sf: "src/foo.ts",
        lf: 100,
        lh: 50, // 50% < 80%
        brf: 20,
        brh: 15,
        fnf: 10,
        fnh: 9,
      },
    ]);
    fs.writeFileSync(lcovPath, lcov, "utf-8");

    const result = runCli([lcovPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /行覆盖率未达标/);
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

// ============================================================================
// T14. CLI 行为：未指定 lcov 文件 → 退出码 1
// ============================================================================

test("T14. CLI 行为：未指定 lcov 文件 → 退出码 1", () => {
  const result = runCli([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /未指定 lcov 文件路径/);
});

// ============================================================================
// T15. CLI 行为：lcov 文件不存在 → 退出码 1
// ============================================================================

test("T15. CLI 行为：lcov 文件不存在 → 退出码 1", () => {
  const result = runCli(["/nonexistent/path/coverage.lcov"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lcov 文件不存在/);
});

// ============================================================================
// T16. CLI 行为：自定义阈值参数
// ============================================================================

test("T16. CLI 行为：自定义阈值参数（--lines/--branches/--functions）", () => {
  const tmpDir = createTmpDir();
  try {
    const lcovPath = path.join(tmpDir, "coverage.lcov");
    // 50% 行覆盖率，使用默认阈值 80% 会失败，自定义阈值 40% 应通过
    const lcov = buildLcovContent([
      {
        sf: "src/foo.ts",
        lf: 100,
        lh: 50, // 50%
        brf: 20,
        brh: 10, // 50%
        fnf: 10,
        fnh: 5, // 50%
      },
    ]);
    fs.writeFileSync(lcovPath, lcov, "utf-8");

    const result = runCli([lcovPath, "--lines", "40", "--branches", "40", "--functions", "40"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /覆盖率全部达标/);
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

// ============================================================================
// T17. CLI 行为：--help 输出帮助信息且退出码 0
// ============================================================================

test("T17. CLI 行为：--help 输出帮助信息且退出码 0", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /覆盖率阈值检查脚本/);
  assert.match(result.stdout, /使用方式/);
});

// ============================================================================
// T18. CLI 行为：未知参数 → 退出码 1
// ============================================================================

test("T18. CLI 行为：未知参数 → 退出码 1", () => {
  const tmpDir = createTmpDir();
  try {
    const lcovPath = path.join(tmpDir, "coverage.lcov");
    fs.writeFileSync(lcovPath, "SF:foo.ts\nLF:0\nLH:0\nend_of_record\n", "utf-8");

    const result = runCli([lcovPath, "--unknown-flag", "value"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /未知参数/);
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

// ============================================================================
// T19. CLI 行为：阈值数值越界 → 退出码 1
// ============================================================================

test("T19. CLI 行为：阈值数值越界（<0 / >100）→ 退出码 1", () => {
  const tmpDir = createTmpDir();
  try {
    const lcovPath = path.join(tmpDir, "coverage.lcov");
    fs.writeFileSync(lcovPath, "SF:foo.ts\nLF:0\nLH:0\nend_of_record\n", "utf-8");

    // 越界（>100）
    const result1 = runCli([lcovPath, "--lines", "150"]);
    assert.equal(result1.status, 1);
    assert.match(result1.stderr, /数值非法/);

    // 越界（<0）
    const result2 = runCli([lcovPath, "--lines", "-10"]);
    assert.equal(result2.status, 1);
    assert.match(result2.stderr, /数值非法/);
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

// ============================================================================
// T20. 不可变性：DEFAULT_THRESHOLDS 已冻结
// ============================================================================

test("T20. 不可变性：DEFAULT_THRESHOLDS 已冻结", () => {
  const scriptUrl = new URL(`file://${SCRIPT_PATH}`).href;

  return import(scriptUrl).then((mod) => {
    assert.equal(Object.isFrozen(mod.DEFAULT_THRESHOLDS), true);
  });
});

// ============================================================================
// T21. 不可变性：LCOV_PREFIX 已冻结
// ============================================================================

test("T21. 不可变性：LCOV_PREFIX 已冻结", () => {
  const scriptUrl = new URL(`file://${SCRIPT_PATH}`).href;

  return import(scriptUrl).then((mod) => {
    assert.equal(Object.isFrozen(mod.LCOV_PREFIX), true);
  });
});

// ============================================================================
// T22. 不可变性：checkThresholds 返回的 failures 数组已冻结
// ============================================================================

test("T22. 不可变性：checkThresholds 返回的 failures 数组已冻结", () => {
  const scriptUrl = new URL(`file://${SCRIPT_PATH}`).href;

  return import(scriptUrl).then((mod) => {
    const stats = {
      totalLines: 100,
      coveredLines: 50,
      totalBranches: 20,
      coveredBranches: 5,
      totalFunctions: 10,
      coveredFunctions: 5,
    };
    const thresholds = { lines: 80, branches: 70, functions: 85 };
    const result = mod.checkThresholds(stats, thresholds);
    assert.equal(Object.isFrozen(result.failures), true);
  });
});
