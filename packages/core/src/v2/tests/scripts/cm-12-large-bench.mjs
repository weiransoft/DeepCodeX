#!/usr/bin/env node
/**
 * CM-12 大型性能基准测试脚本
 *
 * 用途：
 *   - 运行 5000/10000 文件规模的大型性能基准测试（超出单元测试的 1000 文件中型档）
 *   - 基于 fixtures/codemap/seed/ 种子文件复制扩展为大规模项目
 *   - 输出详细性能数据：总耗时 / 文件数 / 类数 / 函数数 / 依赖数 / 循环数 / 每文件平均耗时
 *
 * 设计依据：
 *   - V2 测试方案 §2.5 CM-12（性能基准：中型档 1000 文件 < 15s）
 *   - 架构师审查报告（2026-07-21）：大型基准独立脚本，不进入单元测试套件
 *   - 用户规则：测试脚本放 tests/scripts 目录，使用 .mjs 扩展名
 *
 * 使用方法：
 *   node --import tsx packages/core/src/v2/tests/scripts/cm-12-large-bench.mjs [--scale=5000]
 *
 * 默认 scale=5000，可通过 --scale=N 指定文件数（如 --scale=10000）
 *
 * 性能基线（M2 Pro 16GB，参考值，非硬性阈值）：
 *   - 1000 文件：~200ms（CM-12 单元测试硬阈值 < 15s）
 *   - 5000 文件：~2s（大型基准参考值）
 *   - 10000 文件：~5s（大型基准参考值）
 *
 * @module v2/tests/scripts/cm-12-large-bench
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CodeMapGenerator } from "../../codemap/generator.ts";

// ============================================================================
// 参数解析
// ============================================================================

/** 默认文件数（中型档 1000 已在单元测试覆盖，此处默认大型档 5000） */
const DEFAULT_SCALE = 5000;

/**
 * 解析命令行参数
 * @returns 文件数规模
 */
function parseScale() {
  const args = process.argv.slice(2);
  for (const arg of args) {
    const match = /^--scale=(\d+)$/.exec(arg);
    if (match) {
      const scale = parseInt(match[1], 10);
      if (scale > 0 && scale <= 100000) {
        return scale;
      }
      console.error(`无效的 --scale 值：${match[1]}（应在 1-100000 之间）`);
      process.exit(1);
    }
  }
  return DEFAULT_SCALE;
}

// ============================================================================
// 种子文件路径解析
// ============================================================================

/** 当前脚本所在目录（用于解析 fixtures 种子文件路径） */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** 种子文件目录 */
const SEED_DIR = path.join(__dirname, "..", "fixtures", "codemap", "seed");

// ============================================================================
// 项目结构生成
// ============================================================================

/**
 * 读取所有种子文件内容
 *
 * @returns 种子文件名 → 内容的映射
 */
function readSeedFiles() {
  const seeds = new Map();
  const files = fs.readdirSync(SEED_DIR).filter((f) => f.endsWith(".ts"));
  for (const file of files) {
    const content = fs.readFileSync(path.join(SEED_DIR, file), "utf8");
    seeds.set(file, content);
  }
  if (seeds.size === 0) {
    console.error(`错误：未找到种子文件，请检查路径：${SEED_DIR}`);
    process.exit(1);
  }
  return seeds;
}

/**
 * 在临时目录中生成大规模项目结构
 *
 * 算法：
 *   - 读取 10 个种子文件作为"模块模板"
 *   - 复制扩展为 N 个模块目录（mod0/ ~ modN/）
 *   - 每个模块目录复制全部种子文件（保持内部依赖关系）
 *   - 不同模块之间的文件互不依赖（避免循环依赖爆炸）
 *
 * @param tempDir 临时目录
 * @param scale 目标文件总数
 * @param seeds 种子文件映射
 * @returns 实际生成的文件数
 */
function generateLargeProject(tempDir, scale, seeds) {
  const seedCount = seeds.size;
  const moduleCount = Math.ceil(scale / seedCount);
  let fileCount = 0;

  console.log(`生成项目结构：${moduleCount} 个模块 × ${seedCount} 个种子文件 = ${moduleCount * seedCount} 个文件`);

  for (let i = 0; i < moduleCount; i++) {
    const moduleDir = path.join(tempDir, `mod${i}`, "src");
    fs.mkdirSync(moduleDir, { recursive: true });

    for (const [fileName, content] of seeds) {
      // 调整 import 路径（同模块内相对路径保持不变，因为种子文件在同目录）
      fs.writeFileSync(path.join(moduleDir, fileName), content, "utf8");
      fileCount++;

      if (fileCount >= scale) {
        return fileCount;
      }
    }
  }

  return fileCount;
}

// ============================================================================
// 基准测试主流程
// ============================================================================

/**
 * 运行基准测试
 */
async function main() {
  const scale = parseScale();
  console.log(`=== CM-12 大型性能基准测试 ===`);
  console.log(`目标文件数：${scale}`);
  console.log(`Node.js 版本：${process.version}`);
  console.log(`平台：${process.platform} ${process.arch}`);
  console.log(`CPU 核心数：${os.cpus().length}`);
  console.log(`内存总量：${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log("");

  // 步骤 1：读取种子文件
  console.log("步骤 1：读取种子文件...");
  const seeds = readSeedFiles();
  console.log(`  已加载 ${seeds.size} 个种子文件：${Array.from(seeds.keys()).join(", ")}`);
  console.log("");

  // 步骤 2：生成临时项目
  console.log("步骤 2：生成大规模项目结构...");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-bench-large-"));
  console.log(`  临时目录：${tempDir}`);
  const projectGenStart = Date.now();
  const actualFileCount = generateLargeProject(tempDir, scale, seeds);
  const projectGenElapsed = Date.now() - projectGenStart;
  console.log(`  实际生成文件数：${actualFileCount}`);
  console.log(`  项目生成耗时：${projectGenElapsed}ms`);
  console.log("");

  try {
    // 步骤 3：运行 CodeMapGenerator
    console.log("步骤 3：运行 CodeMapGenerator.generateFullMap()...");
    const generator = new CodeMapGenerator({
      projectRoot: tempDir,
      extensions: [".ts"],
      excludeDirs: ["node_modules", ".git"],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });

    const genStart = Date.now();
    const codeMap = await generator.generateFullMap();
    const genElapsed = Date.now() - genStart;

    console.log(`  生成耗时：${genElapsed}ms (${(genElapsed / 1000).toFixed(2)}s)`);
    console.log("");

    // 步骤 4：输出统计信息
    console.log("步骤 4：统计信息");
    console.log("  ========================");
    console.log(`  文件总数:     ${codeMap.stats.totalFiles}`);
    console.log(`  成功解析:     ${codeMap.stats.parsedFiles}`);
    console.log(`  解析失败:     ${codeMap.stats.failedFiles}`);
    console.log(`  类总数:       ${codeMap.stats.totalClasses}`);
    console.log(`  函数总数:     ${codeMap.stats.totalFunctions}`);
    console.log(`  依赖关系总数: ${codeMap.stats.totalDependencies}`);
    console.log(`  循环依赖数:   ${codeMap.stats.cyclesDetected}`);
    console.log(`  未解析依赖数: ${codeMap.stats.unresolvedDeps}`);
    console.log(`  生成耗时:     ${codeMap.stats.generationTimeMs}ms`);
    console.log("  ========================");
    console.log("");

    // 步骤 5：性能指标
    const avgPerFile = codeMap.stats.totalFiles > 0 ? genElapsed / codeMap.stats.totalFiles : 0;
    console.log("步骤 5：性能指标");
    console.log(`  每文件平均耗时: ${avgPerFile.toFixed(3)}ms`);
    console.log(`  吞吐量:         ${(1000 / avgPerFile).toFixed(0)} 文件/秒`);
    console.log("");

    // 步骤 6：性能判定
    console.log("步骤 6：性能判定");
    // CM-12 硬阈值：1000 文件 < 15s（中型档）
    // 大型档参考值：5000 文件 < 30s，10000 文件 < 60s
    const threshold = Math.max(15000, scale * 6); // 6ms/文件 作为大型档参考阈值
    if (genElapsed < threshold) {
      console.log(`  ✅ 通过：${genElapsed}ms < 阈值 ${threshold}ms`);
      process.exit(0);
    } else {
      console.log(`  ❌ 失败：${genElapsed}ms >= 阈值 ${threshold}ms`);
      process.exit(1);
    }
  } finally {
    // 清理临时目录
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("");
    console.log("临时目录已清理。");
  }
}

// 运行主流程
main().catch((error) => {
  console.error("基准测试执行失败：", error);
  process.exit(2);
});
