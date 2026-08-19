#!/usr/bin/env node
/**
 * lcov 合并去重脚本（S1-D6：lcov SF 跨包重复统计治理）
 *
 * 背景（实测确认）：
 *   node:test 的 lcov reporter 以「相对 process.cwd() 的路径」作为 SF 字段，
 *   多包测试合并（cat coverage/*.lcov）后存在两类重复：
 *   1. 同一物理文件在同一 lcov 内出现多个 section（如 cli 测试 runner 分批
 *      spawn 多个 node 进程，每个进程各写一份 SF section，实测
 *      ../ui/core/clipboard.ts 在 cli.lcov 内出现 3 次）；
 *   2. 不同物理文件因各 runner cwd 不同产生同名 SF 字符串（如
 *      core-v2 的 ../codemap/generator.ts 与 quality 的 ../codemap/generator.ts
 *      指向两个不同包的不同文件）。
 *
 *   check-coverage-threshold.js 按 section 累加 LF/LH/BRF/BRH/FNF/FNH：
 *   - 情况 1 会低估并集覆盖率（同一行在一个进程覆盖、另一个进程未覆盖时，
 *     被计为一次覆盖 + 一次未覆盖）；
 *   - 情况 2 会把两个不同文件的统计混同为一条。
 *
 * 处置（对齐 docs/optimization-plan-20260819.md §2.2 D6 评审共识）：
 *   按 SF 分组，保留「累计命中数（LH + BRH + FNH）更大」的一条 section，
 *   其余丢弃。该策略对情况 1 保守正确（不重复计数）；对情况 2 丢弃其中一个
 *   文件的统计（实测仅 5 个 SF 字符串 / 1497 个 section，影响 < 0.5%，
 *   属评审接受的显式折衷）。
 *
 * 使用方式：
 *   node scripts/dedupe-lcov.js <input.lcov> <output.lcov>
 *
 * 退出码：
 *   0 = 去重成功（含「无重复、原样写出」的平凡情形）
 *   1 = 参数非法 / 输入文件不存在 / 解析失败
 *
 * 设计依据：
 * - docs/optimization-plan-20260819.md §2.2 D6（lcov SF 重复统计风险）
 * - scripts/check-coverage-threshold.js（下游消费者，仅累加 6 个计数字段）
 *
 * @module scripts/dedupe-lcov
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

// ============================================================================
// lcov section 解析
// ============================================================================

/**
 * lcov section 结构
 *
 * @typedef {Object} LcovSection
 * @property {string} sf - SF 字段值（源文件路径字符串，原样保留）
 * @property {ReadonlyArray<string>} lines - 该 section 的全部原始行（含 TN:/SF: 与 end_of_record）
 * @property {number} accumulatedHits - 累计命中数（LH + BRH + FNH，用于组内择优）
 */

/**
 * 解析 lcov 内容为 section 数组
 *
 * 解析规则：
 *   - 每遇到 `SF:` 行开始一个新 section，直到 `end_of_record` 结束；
 *   - `SF:` 行之前紧邻的 `TN:` 行归属该 section（lcov 标准布局 TN 在 SF 之前）；
 *   - 文件级垃圾（首个 section 之前的空行/注释）原样保留到头部 preamble；
 *   - `SF:` 后缺少 `end_of_record` 视为格式损坏，抛错而非静默截断（fail-closed）。
 *
 * @param {string} content - lcov 文件完整内容
 * @returns {{preamble: ReadonlyArray<string>, sections: ReadonlyArray<LcovSection>}} 头部保留行与 section 列表
 * @throws {Error} section 未闭合 / SF 行缺少路径
 */
function parseLcovSections(content) {
  /** @type {string[]} */
  const preamble = [];
  /** @type {LcovSection[]} */
  const sections = [];
  /** @type {string[]} */
  let current = [];
  /** @type {string|null} */
  let currentSf = null;
  let inSection = false;

  // 按行切分（兼容 \r\n 与 \n）；末尾若无换行，split 也会产出最后一行
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    if (!inSection) {
      if (line.startsWith("SF:")) {
        // TN: 行已在 preamble/current 累积中——将紧邻的 TN: 从 preamble 摘出并入 section
        const sfValue = line.slice(3).trim();
        if (sfValue.length === 0) {
          throw new Error("lcov 格式损坏：SF: 行缺少源文件路径");
        }
        // 摘出紧邻的 TN: 行（lcov 标准中 TN 紧贴 SF 之前）
        /** @type {string[]} */
        const sectionStart = [];
        const lastLine = preamble[preamble.length - 1];
        if (lastLine !== undefined && lastLine.startsWith("TN:")) {
          preamble.pop();
          sectionStart.push(lastLine);
        }
        sectionStart.push(line);
        current = sectionStart;
        currentSf = sfValue;
        inSection = true;
      } else {
        preamble.push(line);
      }
      continue;
    }

    // section 内部：原样累积
    current.push(line);
    if (line === "end_of_record") {
      sections.push(buildSection(currentSf, current));
      inSection = false;
      current = [];
      currentSf = null;
    }
  }

  if (inSection) {
    throw new Error(`lcov 格式损坏：SF:${String(currentSf)} 的 section 缺少 end_of_record`);
  }

  return { preamble, sections };
}

/**
 * 由原始行构造 section 对象（提取累计命中数）
 *
 * 累计命中数定义：LH（命中行数）+ BRH（命中分支数）+ FNH（命中函数数）之和。
 * 三类计数均为「越大覆盖越多」的单调指标，求和可稳定区分组内优劣。
 *
 * @param {string} sf - SF 字段值
 * @param {ReadonlyArray<string>} lines - section 全部原始行
 * @returns {LcovSection} 完整 section 对象
 */
function buildSection(sf, lines) {
  let lh = 0;
  let brh = 0;
  let fnh = 0;
  for (const line of lines) {
    if (line.startsWith("LH:")) {
      lh += parseCounter(line, "LH:");
    } else if (line.startsWith("BRH:")) {
      brh += parseCounter(line, "BRH:");
    } else if (line.startsWith("FNH:")) {
      fnh += parseCounter(line, "FNH:");
    }
  }
  return { sf, lines, accumulatedHits: lh + brh + fnh };
}

/**
 * 解析 lcov 计数行（LH:/BRH:/FNH:）的数值
 *
 * @param {string} line - 计数行
 * @param {string} prefix - 字段前缀（如 "LH:"）
 * @returns {number} 数值（非法或缺失时按 0 处理，与阈值脚本 extractLcovValue 语义一致）
 */
function parseCounter(line, prefix) {
  const num = Number.parseInt(line.slice(prefix.length).trim(), 10);
  return Number.isNaN(num) ? 0 : num;
}

// ============================================================================
// SF 分组去重
// ============================================================================

/**
 * 去重结果
 *
 * @typedef {Object} DedupeResult
 * @property {ReadonlyArray<LcovSection>} keptSections - 去重后保留的 section（按首次出现顺序）
 * @property {ReadonlyArray<{sf: string, kept: number, dropped: number}>} dedupedGroups - 发生丢弃的分组明细（保留命中数与丢弃命中数）
 */

/**
 * 按 SF 分组去重：每组保留累计命中数最大的一条
 *
 * 平局规则：保留首次出现的那条（保证输出确定性，不依赖输入顺序抖动）。
 *
 * @param {ReadonlyArray<LcovSection>} sections - 全部 section
 * @returns {DedupeResult} 去重结果与明细
 */
function dedupeBySf(sections) {
  /** @type {Map<string, LcovSection>} */
  const best = new Map();
  /** @type {Map<string, number>} */
  const firstIndex = new Map();
  // 单遍预统计每个 SF 分组的 section 数（避免明细计算退化为 O(n²)）
  /** @type {Map<string, number>} */
  const groupCounts = new Map();

  sections.forEach((section, index) => {
    groupCounts.set(section.sf, (groupCounts.get(section.sf) ?? 0) + 1);

    const existing = best.get(section.sf);
    if (existing === undefined) {
      // 首次出现：直接保留，并记录首次出现序号（决定输出顺序）
      best.set(section.sf, section);
      firstIndex.set(section.sf, index);
      return;
    }
    // 重复出现：仅当累计命中数严格更大时替换（平局保留先到者）
    if (section.accumulatedHits > existing.accumulatedHits) {
      best.set(section.sf, section);
    }
  });

  // 按首次出现顺序输出，保持合并 lcov 的文件顺序稳定
  const keptSections = [...best.entries()]
    .sort((a, b) => firstIndex.get(a[0]) - firstIndex.get(b[0]))
    .map(([, section]) => section);

  // 明细：仅报告发生丢弃的分组
  /** @type {{sf: string, kept: number, dropped: number}[]} */
  const dedupedGroups = [];
  for (const [sf, section] of best) {
    const groupCount = groupCounts.get(sf) ?? 1;
    if (groupCount > 1) {
      dedupedGroups.push({ sf, kept: section.accumulatedHits, dropped: groupCount - 1 });
    }
  }

  return { keptSections, dedupedGroups };
}

// ============================================================================
// 序列化与主流程
// ============================================================================

/**
 * 将去重结果序列化为 lcov 文本
 *
 * @param {ReadonlyArray<string>} preamble - 文件级头部保留行（含末尾换行语义由 join 承担）
 * @param {ReadonlyArray<LcovSection>} sections - 保留的 section
 * @returns {string} 完整 lcov 文本（以换行结尾）
 */
function serializeLcov(preamble, sections) {
  const parts = [];
  // preamble 常见为空或空行；过滤纯空行避免头部堆积空行
  const meaningfulPreamble = preamble.filter((line) => line.length > 0);
  if (meaningfulPreamble.length > 0) {
    parts.push(meaningfulPreamble.join("\n"));
  }
  for (const section of sections) {
    parts.push(section.lines.join("\n"));
  }
  return parts.join("\n") + "\n";
}

/**
 * 主入口：读取输入 lcov → SF 分组去重 → 写出输出 lcov
 *
 * @param {ReadonlyArray<string>} argv - 命令行参数（process.argv.slice(2)）
 * @returns {number} 退出码（0 成功 / 1 失败）
 */
function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "lcov 合并去重脚本（S1-D6）",
        "",
        "使用方式：",
        "  node scripts/dedupe-lcov.js <input.lcov> <output.lcov>",
        "",
        "行为：按 SF 分组，保留累计命中数（LH+BRH+FNH）最大的一条 section。",
        "退出码：0 成功（含无重复的平凡情形）/ 1 参数或格式错误。",
      ].join("\n")
    );
    return 0;
  }

  if (argv.length !== 2) {
    console.error("❌ 参数非法：需要且仅需要 <input.lcov> <output.lcov> 两个参数");
    return 1;
  }

  const inputPath = resolve(argv[0]);
  const outputPath = resolve(argv[1]);

  if (!existsSync(inputPath)) {
    console.error(`❌ 输入 lcov 文件不存在：${inputPath}`);
    return 1;
  }

  let content;
  try {
    content = readFileSync(inputPath, "utf-8");
  } catch (err) {
    console.error(`❌ 读取 lcov 失败：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  let parsed;
  try {
    parsed = parseLcovSections(content);
  } catch (err) {
    console.error(`❌ lcov 解析失败：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const { keptSections, dedupedGroups } = dedupeBySf(parsed.sections);
  const output = serializeLcov(parsed.preamble, keptSections);

  try {
    writeFileSync(outputPath, output, "utf-8");
  } catch (err) {
    console.error(`❌ 写出 lcov 失败：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // 摘要输出（stderr，不污染管道输出）
  const droppedTotal = dedupedGroups.reduce((sum, g) => sum + g.dropped, 0);
  console.error(
    `lcov 去重完成：section ${parsed.sections.length} → ${keptSections.length}` +
      `（丢弃 ${droppedTotal} 条重复，涉及 ${dedupedGroups.length} 个 SF 分组）`
  );
  for (const group of dedupedGroups) {
    console.error(`  - SF:${group.sf}（保留命中数 ${group.kept}，丢弃 ${group.dropped} 条）`);
  }
  return 0;
}

// ============================================================================
// 模块导出（供单元测试使用）
// ============================================================================

export { parseLcovSections, dedupeBySf, serializeLcov, main };

// ============================================================================
// CLI 入口（仅在直接执行时运行，被 import 时不执行）
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
