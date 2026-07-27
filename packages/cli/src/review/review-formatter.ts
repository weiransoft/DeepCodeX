/**
 * Review 报告格式化器
 *
 * 将 ReviewDimensionResult[] 格式化为 markdown / text / json 报告。
 * 所有报告必须包含：
 *   - 项目类型与根目录
 *   - 审查时间与范围
 *   - 每个维度的命令记录（证据附注）
 *   - 每个维度的简要结论（含 [已验证]/[未验证]/[不确定] 标注）
 *   - 总览表格
 *
 * @module cli/review/review-formatter
 */

import type { ToolCommandRecord } from "./review-cmd.js";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 报告章节（对应一个维度的执行结果）
 */
export interface ReviewReportSection {
  /** 维度名称（如 "类型检查"） */
  readonly name: string;
  /** 子命令名（如 "typecheck"） */
  readonly subcommand: string;
  /** 该维度是否通过 */
  readonly passed: boolean;
  /** 该维度执行的命令记录（可能多条，按优先级尝试） */
  readonly records: ReadonlyArray<ToolCommandRecord>;
  /** 该维度的简要结论 */
  readonly summary: string;
}

/**
 * 报告格式化参数
 */
export interface FormatReviewReportArgs {
  /** 项目类型 */
  readonly projectType: "node" | "python" | "rust" | "go" | "unknown";
  /** 项目根目录 */
  readonly projectRoot: string;
  /** 审查时间（ISO 字符串） */
  readonly reviewTime: string;
  /** 审查范围（typecheck / lint / format / full） */
  readonly scope: string;
  /** 章节列表 */
  readonly sections: ReadonlyArray<ReviewReportSection>;
  /** 静默模式（仅输出结论，不输出明细） */
  readonly quiet: boolean;
  /** 输出格式 */
  readonly format: "markdown" | "text" | "json";
}

// ============================================================================
// 主格式化函数
// ============================================================================

/**
 * 格式化审查报告
 *
 * @param args 格式化参数
 * @returns 格式化后的报告字符串
 */
export function formatReviewReport(args: FormatReviewReportArgs): string {
  switch (args.format) {
    case "json":
      return formatAsJson(args);
    case "text":
      return formatAsText(args);
    case "markdown":
    default:
      return formatAsMarkdown(args);
  }
}

// ============================================================================
// Markdown 格式
// ============================================================================

/**
 * 格式化为 Markdown
 *
 * 结构：
 *   # 标题
 *   **元信息**
 *   ---
 *   ## 1. 维度1
 *   **命令** / **退出码** / **耗时**
 *   ### 输出（前 N 行）
 *   ```
 *   ...
 *   ```
 *   ### 结论
 *   ---
 *   ## 总览
 */
function formatAsMarkdown(args: FormatReviewReportArgs): string {
  const lines: string[] = [];
  lines.push(`# DeepCodeX 代码审查报告`);
  lines.push(``);
  lines.push(`**项目类型**：${getProjectTypeName(args.projectType)}`);
  lines.push(`**项目根目录**：${args.projectRoot}`);
  lines.push(`**审查时间**：${args.reviewTime}`);
  lines.push(`**审查范围**：${args.scope}`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // 各维度详情
  for (let i = 0; i < args.sections.length; i++) {
    const section = args.sections[i];
    if (!section) continue;
    lines.push(`## ${i + 1}. ${section.name}`);
    lines.push(``);

    if (section.records.length === 0) {
      lines.push(`**未执行任何命令**（无可用工具候选）`);
      lines.push(``);
      lines.push(`### 结论`);
      lines.push(`- ${section.summary}`);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
      continue;
    }

    // 找到生效的命令记录（exitCode !== 127 的最后一条）
    const effectiveRecord = [...section.records].reverse().find((r) => r.exitCode !== 127) ?? section.records[0];
    if (!effectiveRecord) continue;

    lines.push(`**命令**：\`${effectiveRecord.command}\``);
    lines.push(`**退出码**：${effectiveRecord.exitCode ?? "null"}`);
    lines.push(`**耗时**：${effectiveRecord.durationMs}ms${effectiveRecord.timedOut ? "（已超时）" : ""}`);
    lines.push(``);

    if (!args.quiet) {
      // 输出证据（前 50 行）
      const output = (effectiveRecord.stdout || effectiveRecord.stderr).trim();
      if (output) {
        lines.push(`### 输出（前 50 行）`);
        lines.push(``);
        lines.push("```");
        const outputLines = output.split("\n").slice(0, 50);
        lines.push(...outputLines);
        if (output.split("\n").length > 50) {
          lines.push(`...（共 ${output.split("\n").length} 行，仅显示前 50 行）`);
        }
        lines.push("```");
        lines.push(``);
      }

      // 候选命令尝试记录（若有多条）
      if (section.records.length > 1) {
        lines.push(`### 候选命令尝试记录`);
        lines.push(``);
        for (const record of section.records) {
          const status = record.exitCode === 127 ? "命令不存在" : "命令存在";
          lines.push(`- \`${record.command}\` → exitCode=${record.exitCode ?? "null"} (${status})`);
        }
        lines.push(``);
      }
    }

    lines.push(`### 结论`);
    lines.push(`- ${section.summary}`);
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  // 总览表格
  lines.push(`## 总览`);
  lines.push(``);
  lines.push(`| 维度 | 状态 | 结论 |`);
  lines.push(`|------|------|------|`);
  for (const section of args.sections) {
    const status = section.passed ? "✅ 通过" : "❌ 未通过";
    lines.push(`| ${section.name} | ${status} | ${section.summary} |`);
  }
  lines.push(``);
  const overallPassed = args.sections.every((s) => s.passed);
  lines.push(`**总体状态**：${overallPassed ? "✅ 所有检查通过" : "❌ 存在未通过的检查"}`);
  lines.push(``);
  return lines.join("\n");
}

// ============================================================================
// Text 格式
// ============================================================================

/**
 * 格式化为纯文本
 *
 * 简化版，无 markdown 标记，适合管道处理。
 */
function formatAsText(args: FormatReviewReportArgs): string {
  const lines: string[] = [];
  lines.push(`DeepCodeX 代码审查报告`);
  lines.push(`项目类型：${getProjectTypeName(args.projectType)}`);
  lines.push(`项目根目录：${args.projectRoot}`);
  lines.push(`审查时间：${args.reviewTime}`);
  lines.push(`审查范围：${args.scope}`);
  lines.push(``);

  for (const section of args.sections) {
    lines.push(`[${section.name}]`);
    if (section.records.length > 0) {
      const effectiveRecord = [...section.records].reverse().find((r) => r.exitCode !== 127) ?? section.records[0];
      if (effectiveRecord) {
        lines.push(`命令：${effectiveRecord.command}`);
        lines.push(`退出码：${effectiveRecord.exitCode ?? "null"}`);
        lines.push(`耗时：${effectiveRecord.durationMs}ms${effectiveRecord.timedOut ? "（已超时）" : ""}`);
        if (!args.quiet) {
          const output = (effectiveRecord.stdout || effectiveRecord.stderr).trim();
          if (output) {
            const outputLines = output.split("\n").slice(0, 50);
            lines.push(`输出：`);
            lines.push(...outputLines);
          }
        }
      }
    }
    lines.push(`结论：${section.summary}`);
    lines.push(``);
  }

  const overallPassed = args.sections.every((s) => s.passed);
  lines.push(`总体状态：${overallPassed ? "✅ 所有检查通过" : "❌ 存在未通过的检查"}`);
  return lines.join("\n");
}

// ============================================================================
// JSON 格式
// ============================================================================

/**
 * 格式化为 JSON
 *
 * 结构化输出，便于下游工具解析。
 */
function formatAsJson(args: FormatReviewReportArgs): string {
  const overallPassed = args.sections.every((s) => s.passed);
  const report = {
    title: "DeepCodeX 代码审查报告",
    projectType: args.projectType,
    projectRoot: args.projectRoot,
    reviewTime: args.reviewTime,
    scope: args.scope,
    overallPassed,
    sections: args.sections.map((section) => ({
      name: section.name,
      subcommand: section.subcommand,
      passed: section.passed,
      summary: section.summary,
      records: section.records.map((record) => ({
        command: record.command,
        exitCode: record.exitCode,
        durationMs: record.durationMs,
        timedOut: record.timedOut,
        stdout: args.quiet ? undefined : record.stdout,
        stderr: args.quiet ? undefined : record.stderr,
      })),
    })),
  };
  return JSON.stringify(report, null, 2);
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 获取项目类型中文名
 */
function getProjectTypeName(projectType: "node" | "python" | "rust" | "go" | "unknown"): string {
  switch (projectType) {
    case "node":
      return "Node.js / TypeScript";
    case "python":
      return "Python";
    case "rust":
      return "Rust";
    case "go":
      return "Go";
    case "unknown":
      return "未知";
  }
}
