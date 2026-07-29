/**
 * 报告格式化器 - /quality-check 命令的输出格式化模块
 *
 * 提供 3 种格式（json / text / markdown）的格式化能力，覆盖 3 类报告：
 *   - CodeMap：代码地图报告（json 直接序列化 / text 简要统计 / markdown 复用 generator.toMarkdown）
 *   - UIUXReport：UI/UX 巡检报告（json 直接序列化 / text 问题清单 / markdown 分维度分组）
 *   - VisualDiffResult：视觉回归比对报告（json 直接序列化 / text 摘要 / markdown 表格化）
 *
 * 设计原则：
 *   - 纯函数：所有格式化函数均为纯函数，无副作用
 *   - 类型安全：严格使用 quality package 导出的类型
 *   - 失败安全：单条问题格式化失败不影响整体输出
 *
 * @module cli/quality/quality-formatter
 */

import type { CodeMap, UIUXReport } from "@deepcodex/quality";
import type { VisualDiffResult } from "@vegamo/deepcode-core";
import chalk from "chalk";

// ============================================================================
// 通用工具
// ============================================================================

/** 支持的报告格式 */
export type ReportFormat = "json" | "text" | "markdown";

/**
 * 根据严重级别返回带 chalk 颜色的文本。
 *
 * - HIGH  → 红色（高风险，需要优先处理）
 * - MEDIUM → 黄色（中风险）
 * - LOW   → 灰色（低风险，提示性）
 * - 其他  → 原样返回（容错）
 *
 * @param severity 严重级别字符串
 * @returns 带 ANSI 颜色的字符串
 */
function colorSeverity(severity: string): string {
  switch (severity) {
    case "HIGH":
      return chalk.red(severity);
    case "MEDIUM":
      return chalk.yellow(severity);
    case "LOW":
      return chalk.gray(severity);
    default:
      return severity;
  }
}

/**
 * 将数字保留指定小数位
 *
 * @param value 原始数值
 * @param digits 小数位数（默认 2）
 * @returns 格式化后的字符串
 */
function formatNumber(value: number, digits: number = 2): string {
  return value.toFixed(digits);
}

// ============================================================================
// CodeMap 报告格式化
// ============================================================================

/**
 * 格式化代码地图报告
 *
 * - json：直接 JSON.stringify，缩进 2 空格
 * - text：简要统计摘要（文件数 / 节点数 / 边数 / 复杂度 / 死代码数）
 * - markdown：复用 CodeMapGenerator.toMarkdown() 的输出（由调用方传入）
 *
 * @param map CodeMap 对象
 * @param format 报告格式
 * @param markdownContent 当 format=markdown 时，由 CodeMapGenerator.toMarkdown() 生成的完整 markdown 内容
 * @returns 格式化后的字符串
 */
export function formatCodeMapReport(map: CodeMap, format: ReportFormat, markdownContent?: string): string {
  switch (format) {
    case "json":
      return JSON.stringify(map, null, 2);

    case "markdown":
      // markdown 格式优先使用 CodeMapGenerator.toMarkdown() 的输出
      // 调用方必须传入 markdownContent，否则降级到 text 格式
      if (markdownContent) {
        return markdownContent;
      }
      return formatCodeMapText(map);

    case "text":
    default:
      return formatCodeMapText(map);
  }
}

/**
 * 格式化 CodeMap 的 text 输出（简要统计摘要）
 */
function formatCodeMapText(map: CodeMap): string {
  const lines: string[] = [];
  lines.push(`# Code Map: ${map.projectName}`);
  lines.push(`- 生成时间: ${map.generatedAt}`);
  lines.push(`- 项目根: ${map.projectRoot}`);
  lines.push(`- 文件数: ${map.stats.fileCount}`);
  lines.push(`- 目录数: ${map.stats.directoryCount}`);
  lines.push(`- 节点数: ${map.nodes.length}`);
  lines.push(`- 边数: ${map.edges.length}`);
  lines.push(`- 总行数: ${map.stats.totalLines}`);
  lines.push(`- 平均圈复杂度: ${formatNumber(map.stats.avgComplexity)}`);
  lines.push(`- 死代码候选: ${map.stats.deadCodeCandidates.length} 个`);
  // 死代码列表（最多展示 10 个，避免输出过长）
  if (map.stats.deadCodeCandidates.length > 0) {
    lines.push("");
    lines.push("## 死代码候选（前 10 个）");
    const top = map.stats.deadCodeCandidates.slice(0, 10);
    for (const id of top) {
      lines.push(`  - ${id}`);
    }
    if (map.stats.deadCodeCandidates.length > 10) {
      lines.push(`  ... 还有 ${map.stats.deadCodeCandidates.length - 10} 个`);
    }
  }
  // 复杂度 Top 5
  if (map.stats.topComplexNodes.length > 0) {
    lines.push("");
    lines.push("## 复杂度 Top 5");
    const top5 = map.stats.topComplexNodes.slice(0, 5);
    for (const node of top5) {
      lines.push(`  - [${node.complexity}] ${node.name} (${node.filePath})`);
    }
  }
  return lines.join("\n");
}

// ============================================================================
// UIUXReport 报告格式化
// ============================================================================

/**
 * 格式化 UI/UX 巡检报告
 *
 * - json：直接 JSON.stringify，缩进 2 空格
 * - text：简要摘要 + 问题列表
 * - markdown：分维度分组的 markdown 报告
 *
 * @param report UIUXReport 对象
 * @param format 报告格式
 * @returns 格式化后的字符串
 */
export function formatUIUXReport(report: UIUXReport, format: ReportFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify(report, null, 2);

    case "markdown":
      return formatUIUXMarkdown(report);

    case "text":
    default:
      return formatUIUXText(report);
  }
}

/**
 * 格式化 UIUXReport 的 text 输出
 */
function formatUIUXText(report: UIUXReport): string {
  const lines: string[] = [];
  lines.push("# UI/UX 巡检报告");
  lines.push(`- 综合评分: ${report.score}/100`);
  lines.push(`- 是否通过: ${report.is_pass ? "✅ 通过" : "❌ 未通过"}`);
  lines.push(`- 问题总数: ${report.total_issues}`);
  lines.push(`  - HIGH: ${report.high_count}`);
  lines.push(`  - MEDIUM: ${report.medium_count}`);
  lines.push(`  - LOW: ${report.low_count}`);
  // 问题清单（按 severity 排序：HIGH > MEDIUM > LOW）
  if (report.issues.length > 0) {
    lines.push("");
    lines.push("## 问题清单");
    const severityOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    const sorted = [...report.issues].sort((a, b) => {
      const orderA = severityOrder[a.severity] ?? 99;
      const orderB = severityOrder[b.severity] ?? 99;
      return orderA - orderB;
    });
    for (let i = 0; i < sorted.length; i++) {
      const issue = sorted[i]!;
      // FIX-17（多角色审查 2026-07-29）：严重级别文本增加颜色语义
      lines.push(`  ${i + 1}. [${colorSeverity(issue.severity)}] ${issue.category}/${issue.rule}: ${issue.message}`);
      lines.push(`     元素: ${issue.element}`);
      lines.push(`     建议: ${issue.fix}`);
    }
  }
  return lines.join("\n");
}

/**
 * 格式化 UIUXReport 的 markdown 输出（分维度分组）
 */
function formatUIUXMarkdown(report: UIUXReport): string {
  const lines: string[] = [];
  lines.push("# UI/UX 巡检报告");
  lines.push("");
  lines.push("## 总览");
  lines.push("");
  lines.push("| 指标 | 数值 |");
  lines.push("| --- | --- |");
  lines.push(`| 综合评分 | ${report.score}/100 |`);
  lines.push(`| 是否通过 | ${report.is_pass ? "✅ 通过" : "❌ 未通过"} |`);
  lines.push(`| 问题总数 | ${report.total_issues} |`);
  lines.push(`| HIGH | ${report.high_count} |`);
  lines.push(`| MEDIUM | ${report.medium_count} |`);
  lines.push(`| LOW | ${report.low_count} |`);
  lines.push("");

  if (report.issues.length === 0) {
    lines.push("## 问题清单");
    lines.push("");
    lines.push("无问题。");
    return lines.join("\n");
  }

  // 按 category 分组
  const categories: Record<string, typeof report.issues> = {};
  for (const issue of report.issues) {
    if (!categories[issue.category]) {
      categories[issue.category] = [];
    }
    categories[issue.category]!.push(issue);
  }

  // 输出每个分类的问题
  for (const [category, issues] of Object.entries(categories)) {
    lines.push(`## ${category} (${issues.length} 项)`);
    lines.push("");
    lines.push("| 严重级别 | 规则 | 元素 | 描述 | 修复建议 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const issue of issues) {
      // 转义 markdown 表格中的 | 字符
      const escapeCell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
      // FIX-17（多角色审查 2026-07-29）：markdown 表格中的严重级别同样增加颜色语义
      lines.push(
        `| ${colorSeverity(issue.severity)} | ${escapeCell(issue.rule)} | ${escapeCell(issue.element)} | ${escapeCell(
          issue.message
        )} | ${escapeCell(issue.fix)} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================================================
// VisualDiffResult 报告格式化
// ============================================================================

/**
 * 格式化视觉回归比对报告
 *
 * - json：直接 JSON.stringify，缩进 2 空格
 * - text：简要摘要 + 变化区域 + 数据显示不全 + 显示错误
 * - markdown：表格化展示
 *
 * @param result VisualDiffResult 对象
 * @param format 报告格式
 * @returns 格式化后的字符串
 */
export function formatVisualReport(result: VisualDiffResult, format: ReportFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify(result, null, 2);

    case "markdown":
      return formatVisualMarkdown(result);

    case "text":
    default:
      return formatVisualText(result);
  }
}

/**
 * 格式化 VisualDiffResult 的 text 输出
 */
function formatVisualText(result: VisualDiffResult): string {
  const lines: string[] = [];
  // ssimScore 是 optional 字段，未提供时显示 N/A
  const ssimScore = result.ssimScore ?? 0;
  const hasSsim = result.ssimScore !== undefined;
  lines.push("# 视觉回归比对报告");
  lines.push(`- testId: ${result.testId}`);
  lines.push(`- step: ${result.step}`);
  lines.push(`- 像素差异比: ${formatNumber(result.pixelDiffRatio * 100, 4)}%`);
  lines.push(`- SSIM 评分: ${hasSsim ? formatNumber(ssimScore, 4) : "N/A"}`);
  // 判断是否通过（pixelDiffRatio < 1%；若 ssimScore 提供，还需 >= 0.95）
  const isPass = result.pixelDiffRatio < 0.01 && (!hasSsim || ssimScore >= 0.95);
  lines.push(`- 是否通过: ${isPass ? "✅ 通过" : "❌ 未通过"}`);
  if (result.error) {
    lines.push(`- 错误: ${result.error}`);
  }
  // 变化区域
  if (result.changedRegions.length > 0) {
    lines.push("");
    lines.push(`## 变化区域 (${result.changedRegions.length} 个)`);
    for (let i = 0; i < result.changedRegions.length; i++) {
      const region = result.changedRegions[i]!;
      // ChangedRegion 字段：x / y / width / height / pixelCount / severity（无 diffRatio）
      // pixelCount 表示该区域变化的像素数，severity 表示严重级别
      lines.push(
        `  ${i + 1}. 位置: (${region.x}, ${region.y}) 尺寸: ${region.width}x${region.height} 变化像素: ${
          region.pixelCount
        } 级别: ${colorSeverity(region.severity)}`
      );
    }
  }
  // 数据显示不全
  if (result.dataIncomplete.length > 0) {
    lines.push("");
    lines.push(`## 数据显示不全 (${result.dataIncomplete.length} 项)`);
    for (let i = 0; i < result.dataIncomplete.length; i++) {
      const item = result.dataIncomplete[i]!;
      lines.push(`  ${i + 1}. ${item}`);
    }
  }
  // 显示错误
  if (result.displayErrors.length > 0) {
    lines.push("");
    lines.push(`## 显示错误 (${result.displayErrors.length} 项)`);
    for (let i = 0; i < result.displayErrors.length; i++) {
      const item = result.displayErrors[i]!;
      lines.push(`  ${i + 1}. ${item}`);
    }
  }
  return lines.join("\n");
}

/**
 * 格式化 VisualDiffResult 的 markdown 输出（表格化）
 */
function formatVisualMarkdown(result: VisualDiffResult): string {
  const lines: string[] = [];
  // ssimScore 是 optional 字段，未提供时显示 N/A
  const ssimScore = result.ssimScore ?? 0;
  const hasSsim = result.ssimScore !== undefined;
  lines.push("# 视觉回归比对报告");
  lines.push("");
  lines.push("## 总览");
  lines.push("");
  lines.push("| 指标 | 数值 |");
  lines.push("| --- | --- |");
  lines.push(`| testId | ${result.testId} |`);
  lines.push(`| step | ${result.step} |`);
  lines.push(`| 像素差异比 | ${formatNumber(result.pixelDiffRatio * 100, 4)}% |`);
  lines.push(`| SSIM 评分 | ${hasSsim ? formatNumber(ssimScore, 4) : "N/A"} |`);
  const isPass = result.pixelDiffRatio < 0.01 && (!hasSsim || ssimScore >= 0.95);
  lines.push(`| 是否通过 | ${isPass ? "✅ 通过" : "❌ 未通过"} |`);
  if (result.error) {
    lines.push(`| 错误 | ${result.error} |`);
  }
  lines.push("");

  // 变化区域表格
  if (result.changedRegions.length > 0) {
    lines.push(`## 变化区域 (${result.changedRegions.length} 个)`);
    lines.push("");
    // ChangedRegion 字段：x / y / width / height / pixelCount / severity（无 diffRatio）
    lines.push("| 序号 | X | Y | 宽度 | 高度 | 变化像素 | 级别 |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (let i = 0; i < result.changedRegions.length; i++) {
      const region = result.changedRegions[i]!;
      lines.push(
        `| ${i + 1} | ${region.x} | ${region.y} | ${region.width} | ${region.height} | ${region.pixelCount} | ${colorSeverity(
          region.severity
        )} |`
      );
    }
    lines.push("");
  }

  // 数据显示不全
  if (result.dataIncomplete.length > 0) {
    lines.push(`## 数据显示不全 (${result.dataIncomplete.length} 项)`);
    lines.push("");
    for (let i = 0; i < result.dataIncomplete.length; i++) {
      lines.push(`${i + 1}. ${result.dataIncomplete[i]}`);
    }
    lines.push("");
  }

  // 显示错误
  if (result.displayErrors.length > 0) {
    lines.push(`## 显示错误 (${result.displayErrors.length} 项)`);
    lines.push("");
    for (let i = 0; i < result.displayErrors.length; i++) {
      lines.push(`${i + 1}. ${result.displayErrors[i]}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================================================
// 合并报告格式化（all 子命令使用）
// ============================================================================

/**
 * 合并多个子命令的报告为单一输出
 *
 * 用于 /quality-check all 子命令，按顺序合并 codemap / uiux / visual 报告。
 * 每个子命令报告之间使用分隔线分隔，并添加标题。
 *
 * @param sections 各子命令的报告内容数组（已包含标题）
 * @returns 合并后的字符串
 */
export function formatCombinedReport(sections: Array<{ title: string; content: string }>): string {
  const lines: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    if (i > 0) {
      lines.push("");
      lines.push("---");
      lines.push("");
    }
    lines.push(`# ${section.title}`);
    lines.push("");
    lines.push(section.content);
  }
  return lines.join("\n");
}
