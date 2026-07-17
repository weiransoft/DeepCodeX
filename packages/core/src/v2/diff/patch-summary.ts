/**
 * Patch 摘要生成器（F-DIFF-03）
 *
 * 参考 DeepSeek-TUI crates/tui/src/tui/history.rs PatchSummaryCell，
 * 生成多文件变更摘要，用于在终端展示一次 patch 操作的整体影响范围。
 *
 * 核心职责：
 * - summarize：从多个文件的 DiffResult 生成结构化摘要（PatchSummary）
 * - render：将 PatchSummary 渲染为终端友好的纯文本格式
 *
 * 渲染格式示例（设计文档 §3.2.3）：
 * ```
 * 📄 packages/core/src/v2/diff/enhance-diff-preview.ts (+125 -3)
 * 📄 packages/core/src/v2/types.ts (+45 -8)
 * 📄 packages/cli/src/ui/views/diff-view.tsx (+89 -12)
 * ─────────────────────────────────────
 * Total: 3 files changed, +259 -23
 * ```
 *
 * 设计说明：
 * - 不使用 ANSI 颜色：保持简洁，颜色由调用方按上下文决定（避免双重着色）
 * - 使用 emoji 📄 作为文件行前缀：跨终端兼容，无需颜色支持
 * - 分隔线使用 37 个 Box Drawing Horizontal（U+2500）：视觉清晰，宽度固定，
 *   长度与设计文档 §3.2.3 示例完全一致
 *
 * 依赖关系：
 * - 依赖 myers-diff.ts 的 DiffHunk / DiffStats 类型（仅类型导入，无运行时依赖）
 */

import type { DiffHunk, DiffStats } from "./myers-diff";

/**
 * 单个文件的 diff 结果（PatchSummaryGenerator 的输入）
 *
 * 由 enhanceDiffPreview 或类似 diff 计算模块产出，作为 PatchSummaryGenerator.summarize 的输入单元。
 *
 * @property filePath 文件路径（相对路径或绝对路径，由调用方决定展示形式）
 * @property hunks 该文件的 diff hunk 列表（按文件顺序排列，每个 hunk 对应一段连续变更）
 * @property stats 该文件的统计信息（additions/deletions/changes）
 */
export interface DiffResult {
  filePath: string;
  hunks: DiffHunk[];
  stats: DiffStats;
}

/**
 * 单个文件的变更摘要
 *
 * summarize 阶段从 DiffResult 提取的精简信息，去除 hunk 内部细节，
 * 仅保留用于渲染和汇总的必要字段。
 *
 * @property filePath 文件路径
 * @property additions 新增行数（来自 DiffStats.additions）
 * @property deletions 删除行数（来自 DiffStats.deletions）
 * @property hunks hunk 数量（变更块数，来自 DiffResult.hunks.length）
 */
export interface FileChangeSummary {
  filePath: string;
  additions: number;
  deletions: number;
  hunks: number;
}

/**
 * Patch 整体摘要
 *
 * @property files 每个文件的变更摘要列表（顺序与输入 diffs 一致）
 * @property totalAdditions 所有文件新增行数总和
 * @property totalDeletions 所有文件删除行数总和
 * @property totalFiles 变更文件总数（等于 files.length）
 * @property rendered 渲染后的摘要字符串（由 render 生成，便于调用方直接展示）
 */
export interface PatchSummary {
  files: FileChangeSummary[];
  totalAdditions: number;
  totalDeletions: number;
  totalFiles: number;
  /** 渲染后的摘要字符串 */
  rendered: string;
}

/**
 * 文件行前缀 emoji
 *
 * 使用 📄（U+1F4C4 PAGE FACING UP）表示文件，跨终端兼容且无需颜色支持。
 */
const FILE_PREFIX = "📄";

/**
 * 分隔线（37 个 Box Drawing Horizontal U+2500）
 *
 * 长度与设计文档 §3.2.3 示例完全一致，保证视觉对齐与输出稳定性。
 */
const SEPARATOR = "─".repeat(37);

/**
 * Patch 摘要生成器
 *
 * 提供两个核心方法：
 * - summarize：将 DiffResult[] 聚合为 PatchSummary（含统计 + 渲染字符串）
 * - render：将 PatchSummary 渲染为终端友好格式（独立可复用）
 *
 * 线程安全：无内部可变状态，可在并发环境中安全使用。
 */
export class PatchSummaryGenerator {
  /**
   * 从多个 DiffResult 生成 Patch 摘要
   *
   * 处理流程：
   * 1. 遍历每个 DiffResult，提取 filePath / additions / deletions / hunks 数量
   *    - additions/deletions 直接取自 stats 字段（由 myers-diff.computeStats 计算）
   *    - hunks 数量取 hunks 数组长度（即变更块数，反映变更的分散程度）
   * 2. 汇总 totalAdditions / totalDeletions / totalFiles
   * 3. 调用 render() 生成 rendered 字符串并写入结果，便于调用方直接展示
   *
   * @param diffs DiffResult 数组（每个元素描述一个文件的 diff 结果）
   * @returns PatchSummary 结构化摘要（含 rendered 渲染字符串）
   */
  summarize(diffs: DiffResult[]): PatchSummary {
    const files: FileChangeSummary[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    // 遍历每个 DiffResult，提取单文件摘要并累加总计
    for (const diff of diffs) {
      const fileSummary: FileChangeSummary = {
        filePath: diff.filePath,
        additions: diff.stats.additions,
        deletions: diff.stats.deletions,
        hunks: diff.hunks.length,
      };
      files.push(fileSummary);

      // 累加总计行数
      totalAdditions += diff.stats.additions;
      totalDeletions += diff.stats.deletions;
    }

    // 构造 PatchSummary 结构（rendered 先占位，下面通过 render 填充）
    const summary: PatchSummary = {
      files,
      totalAdditions,
      totalDeletions,
      totalFiles: files.length,
      rendered: "",
    };

    // 调用 render 生成渲染字符串，写入 summary.rendered
    summary.rendered = this.render(summary);
    return summary;
  }

  /**
   * 渲染 PatchSummary 为终端友好格式
   *
   * 格式规范（设计文档 §3.2.3）：
   * - 每个文件一行：📄 <path> (+N -M)
   * - 分隔线：37 个 ─（U+2500）
   * - 总计行：Total: N files changed, +N -M
   * - 不使用 ANSI 颜色（颜色由调用方决定，避免双重着色）
   *
   * 行拼接规则：
   * - 行间以 \n 分隔
   * - 末尾不附加额外换行符（由调用方按展示场景决定是否追加）
   * - 即使 files 为空，仍输出分隔线 + 总计行，保证格式一致性
   *
   * @param summary PatchSummary 结构化摘要
   * @returns 渲染字符串（多行，行间以 \n 分隔）
   */
  render(summary: PatchSummary): string {
    const lines: string[] = [];

    // 文件行：每个文件一行，格式 "📄 <path> (+N -M)"
    for (const file of summary.files) {
      lines.push(`${FILE_PREFIX} ${file.filePath} (+${file.additions} -${file.deletions})`);
    }

    // 分隔线：固定 37 个 ─
    lines.push(SEPARATOR);

    // 总计行：格式 "Total: N files changed, +N -M"
    // 严格按设计文档格式字符串，单复数统一使用 "files"
    lines.push(`Total: ${summary.totalFiles} files changed, +${summary.totalAdditions} -${summary.totalDeletions}`);

    return lines.join("\n");
  }
}
