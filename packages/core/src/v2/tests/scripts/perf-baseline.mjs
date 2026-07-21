#!/usr/bin/env node
/**
 * CodeMap 性能基线记录脚本（perf-baseline.mjs）
 *
 * 用途：
 *   - 运行多档位（100 / 1000 / 5000 文件）基准测试，输出 JSON 格式性能基线
 *   - 记录性能基线供后续对比，检测性能回退
 *   - 与 cm-12-large-bench.mjs 互补：前者单档位深度测量，本脚本多档位广度记录
 *
 * 设计依据：
 *   - V2 测试方案 §2.5 CM-12（性能基准：中型档 1000 文件 < 15s）
 *   - 架构师审查报告（2026-07-21）：性能基线脚本独立运行，输出 JSON 便于 diff
 *   - 用户规则：测试脚本放 tests/scripts 目录，使用 .mjs 扩展名
 *
 * 使用方法：
 *   node --import tsx packages/core/src/v2/tests/scripts/perf-baseline.mjs [--output=baseline.json] [--rounds=3]
 *
 * 参数说明：
 *   --output=PATH  基线 JSON 输出路径（默认：tests/scripts/perf-baseline.json）
 *   --rounds=N     每档位重复运行次数（默认 3，取中位数）
 *
 * 输出 JSON 结构：
 *   {
 *     "version": "1.0",
 *     "generatedAt": "2026-07-21T...",
 *     "environment": {
 *       "node": "v20.x.x",
 *       "platform": "darwin arm64",
 *       "cpus": 10,
 *       "totalMemoryGb": 16.0
 *     },
 *     "benchmarks": [
 *       {
 *         "scale": 100,
 *         "rounds": [
 *           { "elapsedMs": 18, "files": 100, "classes": 100, "functions": 100, "throughput": 5555 },
 *           ...
 *         ],
 *         "median": { "elapsedMs": 19, "throughput": 5263 }
 *       },
 *       ...
 *     ]
 *   }
 *
 * @module v2/tests/scripts/perf-baseline
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CodeMapGenerator } from "../../codemap/generator.ts";

// ============================================================================
// 参数解析
// ============================================================================

/** 默认每档位重复运行次数（取中位数减少抖动） */
const DEFAULT_ROUNDS = 3;

/** 默认输出路径（与脚本同目录） */
const DEFAULT_OUTPUT = "perf-baseline.json";

/** 档位定义：100（小型）/ 1000（中型，与 CM-12 单元测试对齐）/ 5000（大型） */
const DEFAULT_SCALES = [100, 1000, 5000];

/**
 * 解析命令行参数
 *
 * @returns 参数对象
 */
function parseArgs() {
  const args = process.argv.slice(2);
  let output = DEFAULT_OUTPUT;
  let rounds = DEFAULT_ROUNDS;
  let scales = DEFAULT_SCALES;

  for (const arg of args) {
    const outputMatch = /^--output=(.+)$/.exec(arg);
    if (outputMatch) {
      output = outputMatch[1];
      continue;
    }
    const roundsMatch = /^--rounds=(\d+)$/.exec(arg);
    if (roundsMatch) {
      const r = parseInt(roundsMatch[1], 10);
      if (r > 0 && r <= 20) {
        rounds = r;
      } else {
        console.error(`无效的 --rounds 值：${roundsMatch[1]}（应在 1-20 之间）`);
        process.exit(1);
      }
      continue;
    }
    const scalesMatch = /^--scales=([\d,]+)$/.exec(arg);
    if (scalesMatch) {
      scales = scalesMatch[1]
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => n > 0 && n <= 100000);
      if (scales.length === 0) {
        console.error(`无效的 --scales 值：${scalesMatch[1]}`);
        process.exit(1);
      }
      continue;
    }
    console.error(`未知参数：${arg}`);
    console.error("用法：node perf-baseline.mjs [--output=baseline.json] [--rounds=3] [--scales=100,1000,5000]");
    process.exit(1);
  }

  return { output, rounds, scales };
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
 * 在临时目录中生成指定规模的项目结构
 *
 * 算法（与 cm-12-large-bench.mjs 一致）：
 *   - 复制 N/modCount 个模块目录，每个目录包含全部种子文件
 *   - 不同模块之间互不依赖（避免循环依赖爆炸）
 *
 * @param tempDir 临时目录
 * @param scale 目标文件总数
 * @param seeds 种子文件映射
 * @returns 实际生成的文件数
 */
function generateProject(tempDir, scale, seeds) {
  const seedCount = seeds.size;
  const moduleCount = Math.ceil(scale / seedCount);
  let fileCount = 0;

  for (let i = 0; i < moduleCount; i++) {
    const moduleDir = path.join(tempDir, `mod${i}`, "src");
    fs.mkdirSync(moduleDir, { recursive: true });

    for (const [fileName, content] of seeds) {
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
// 单次基准测试
// ============================================================================

/**
 * 运行单次基准测试
 *
 * @param scale 目标文件数
 * @param seeds 种子文件映射
 * @returns 单次结果
 */
async function runSingleBench(scale, seeds) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-perf-base-"));
  try {
    const actualFiles = generateProject(tempDir, scale, seeds);

    const generator = new CodeMapGenerator({
      projectRoot: tempDir,
      extensions: [".ts"],
      excludeDirs: ["node_modules", ".git"],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });

    const start = Date.now();
    const codeMap = await generator.generateFullMap();
    const elapsedMs = Date.now() - start;

    return {
      elapsedMs,
      files: codeMap.stats.totalFiles,
      classes: codeMap.stats.totalClasses,
      functions: codeMap.stats.totalFunctions,
      dependencies: codeMap.stats.totalDependencies,
      cycles: codeMap.stats.cyclesDetected,
      throughput: elapsedMs > 0 ? Math.round((actualFiles / elapsedMs) * 1000) : 0,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ============================================================================
// 中位数计算
// ============================================================================

/**
 * 计算数值数组的中位数
 *
 * @param values 数值数组
 * @returns 中位数
 */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

// ============================================================================
// 主流程
// ============================================================================

/**
 * 主流程：运行多档位基准测试并输出 JSON 基线
 */
async function main() {
  const { output, rounds, scales } = parseArgs();

  console.log("=== CodeMap 性能基线记录 ===");
  console.log(`Node.js 版本：${process.version}`);
  console.log(`平台：${process.platform} ${process.arch}`);
  console.log(`CPU 核心数：${os.cpus().length}`);
  console.log(`内存总量：${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`档位：${scales.join(", ")} 文件`);
  console.log(`每档位重复：${rounds} 次（取中位数）`);
  console.log(`输出路径：${output}`);
  console.log("");

  // 读取种子文件
  console.log("步骤 1：读取种子文件...");
  const seeds = readSeedFiles();
  console.log(`  已加载 ${seeds.size} 个种子文件`);
  console.log("");

  // 运行各档位基准
  console.log("步骤 2：运行基准测试...");
  const benchmarks = [];

  for (const scale of scales) {
    console.log(`\n  档位 ${scale} 文件：`);
    const roundResults = [];

    for (let i = 0; i < rounds; i++) {
      process.stdout.write(`    第 ${i + 1}/${rounds} 轮...`);
      const result = await runSingleBench(scale, seeds);
      roundResults.push(result);
      console.log(` ${result.elapsedMs}ms (${result.throughput} 文件/秒)`);
    }

    // 计算中位数
    const medianElapsed = median(roundResults.map((r) => r.elapsedMs));
    const medianThroughput = median(roundResults.map((r) => r.throughput));
    // 取第一轮的统计数据（每轮统计相同，因项目结构相同）
    const firstRound = roundResults[0];

    benchmarks.push({
      scale,
      rounds: roundResults,
      median: {
        elapsedMs: medianElapsed,
        throughput: medianThroughput,
        files: firstRound.files,
        classes: firstRound.classes,
        functions: firstRound.functions,
        dependencies: firstRound.dependencies,
        cycles: firstRound.cycles,
      },
    });

    console.log(`  中位数：${medianElapsed}ms (${medianThroughput} 文件/秒)`);
  }

  // 构建基线对象
  const baseline = {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpus: os.cpus().length,
      totalMemoryGb: Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(2)),
    },
    benchmarks,
  };

  // 输出 JSON
  console.log("");
  console.log("步骤 3：写入基线 JSON...");
  const outputPath = path.isAbsolute(output) ? output : path.resolve(process.cwd(), output);
  fs.writeFileSync(outputPath, JSON.stringify(baseline, null, 2), "utf8");
  console.log(`  已写入：${outputPath}`);
  console.log("");

  // 汇总
  console.log("=== 基线汇总 ===");
  for (const b of benchmarks) {
    console.log(`  ${b.scale} 文件：中位数 ${b.median.elapsedMs}ms，吞吐 ${b.median.throughput} 文件/秒`);
  }
  console.log("");
  console.log("性能基线记录完成。");
}

// 运行主流程
main().catch((error) => {
  console.error("性能基线记录失败：", error);
  process.exit(2);
});
