/**
 * 增强的 diff 预览生成器
 *
 * 基于现有 buildDiffPreview 的概念，使用 Myers diff 算法提供更精确的差异计算。
 * 相比原有的 prefix/suffix 简单匹配方式，Myers 算法能计算最小编辑脚本，
 * 准确识别文件中间的多处变更。
 *
 * 功能特性：
 * - 使用 Myers diff 算法计算精确差异（支持多处分散变更）
 * - 支持上下文行配置（contextLines，控制变更行周围的相等行显示数量）
 * - 支持 ANSI 颜色输出（删除行红色、新增行绿色、行号灰色）
 * - 支持行号显示（同时显示原始行号和新行号）
 * - 支持最大 diff 行数限制（maxDiffLines，超出时截断并提示）
 * - 输出 unified diff 格式（--- / +++ / @@ 头部）
 */

import {
  computeMyersDiff,
  groupIntoHunks,
  computeStats,
  type DiffOp,
  type DiffHunk,
  type DiffStats,
} from "./myers-diff";

/**
 * diff 预览选项
 */
export interface DiffPreviewOptions {
  /** 是否启用 ANSI 颜色（默认 false） */
  colorEnabled?: boolean;
  /** 上下文行数：变更行前后保留的相等行数（默认 3） */
  contextLines?: number;
  /** 最大 diff 行数：超出时截断并添加提示（默认 200） */
  maxDiffLines?: number;
  /** 是否显示行号（默认 false） */
  showLineNumbers?: boolean;
}

/**
 * diff 预览结果
 */
export interface DiffPreviewResult {
  /** 渲染后的 diff 文本（unified diff 格式） */
  rendered: string;
  /** hunk 列表（按文件顺序排列） */
  hunks: DiffHunk[];
  /** 统计信息（新增/删除/变更行数） */
  stats: DiffStats;
}

// ANSI 颜色常量定义
const COLOR_RED = "\x1b[31m"; // 删除行：红色
const COLOR_GREEN = "\x1b[32m"; // 新增行：绿色
const COLOR_CYAN = "\x1b[36m"; // hunk 头部：青色
const COLOR_GRAY = "\x1b[90m"; // 行号：灰色
const COLOR_RESET = "\x1b[0m"; // 颜色重置

// 默认选项值
const DEFAULT_COLOR_ENABLED = false;
const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_DIFF_LINES = 200;
const DEFAULT_SHOW_LINE_NUMBERS = false;

// 行号显示的固定宽度（右对齐）
const LINE_NUMBER_WIDTH = 5;

/**
 * 生成增强的 diff 预览
 *
 * 使用 Myers diff 算法计算两个文本内容的差异，并渲染为 unified diff 格式。
 *
 * 处理流程：
 * 1. 将原始和新内容按行分割（统一换行符、处理末尾空行）
 * 2. 若内容完全相同，返回空结果（rendered 为空字符串，stats 全为 0）
 * 3. 调用 computeMyersDiff 计算最小编辑脚本
 * 4. 按 contextLines 分组为 hunks
 * 5. 计算 diff 统计信息
 * 6. 渲染为 unified diff 文本（含 --- / +++ / @@ 头部）
 * 7. 若超过 maxDiffLines 则截断并添加提示
 *
 * @param oldContent 原始内容（null 表示新文件，全部为新增）
 * @param newContent 新内容
 * @param options 预览选项（可选，使用默认值）
 * @returns 预览结果（rendered、hunks、stats）
 */
export function enhanceDiffPreview(
  oldContent: string | null,
  newContent: string,
  options?: DiffPreviewOptions
): DiffPreviewResult {
  // 解析选项，使用默认值填充未指定的项
  const colorEnabled = options?.colorEnabled ?? DEFAULT_COLOR_ENABLED;
  const contextLines = options?.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxDiffLines = options?.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES;
  const showLineNumbers = options?.showLineNumbers ?? DEFAULT_SHOW_LINE_NUMBERS;

  // 将内容按行分割
  // oldContent 为 null 表示新文件，oldLines 为空数组
  const oldLines = oldContent === null ? [] : splitLines(oldContent);
  const newLines = splitLines(newContent);

  // 快速路径：内容完全相同，返回空结果
  // 比较分割后的行数组，避免对相同内容执行完整的 Myers 计算
  if (oldLines.length === newLines.length && oldLines.every((line, idx) => line === newLines[idx])) {
    return {
      rendered: "",
      hunks: [],
      stats: { additions: 0, deletions: 0, changes: 0 },
    };
  }

  // 调用 Myers diff 算法计算最小编辑脚本
  const ops = computeMyersDiff(oldLines, newLines);

  // 按 contextLines 将操作序列分组为 hunks
  const hunks = groupIntoHunks(ops, contextLines);

  // 计算 diff 统计信息
  const stats = computeStats(ops);

  // 渲染为 unified diff 文本
  const rendered = renderDiff(hunks, stats, oldContent === null, {
    colorEnabled,
    showLineNumbers,
    maxDiffLines,
  });

  return {
    rendered,
    hunks,
    stats,
  };
}

/**
 * 将文本内容按行分割
 *
 * 处理逻辑：
 * 1. 统一换行符：将 CRLF（\r\n）转换为 LF（\n）
 * 2. 按 \n 分割为行数组
 * 3. 移除末尾因换行符产生的空字符串（例如 "a\nb\n" → ["a", "b"]）
 *
 * 与现有 buildDiffPreview 中 toDiffLines 的行为保持一致。
 *
 * @param content 文本内容
 * @returns 行数组（每行不含换行符）
 */
function splitLines(content: string): string[] {
  // 统一换行符：CRLF → LF
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  // 移除末尾因换行符产生的空字符串
  // 例如 "a\nb\n".split("\n") = ["a", "b", ""]，移除末尾 "" 得到 ["a", "b"]
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * 渲染选项（内部使用）
 */
interface RenderOptions {
  colorEnabled: boolean;
  showLineNumbers: boolean;
  maxDiffLines: number;
}

/**
 * 渲染 diff 为 unified diff 格式文本
 *
 * 输出格式：
 * ```
 * --- a/file            （或 /dev/null 表示新文件）
 * +++ b/file
 * @@ -oldStart,oldLines +newStart,newLines @@
 *  context line
 * -deleted line
 * +added line
 *  context line
 * @@ ... @@
 * ...
 * ```
 *
 * 若启用颜色，删除行显示红色、新增行显示绿色、hunk 头部显示青色、行号显示灰色。
 * 若启用行号显示，每行前会显示原始行号和新行号。
 * 若总行数超过 maxDiffLines，截断并添加截断提示。
 *
 * @param hunks hunk 数组
 * @param stats 统计信息
 * @param isNewFile 是否为新文件（oldContent 为 null）
 * @param options 渲染选项
 * @returns 渲染后的 diff 文本（若无变更返回空字符串）
 */
function renderDiff(hunks: DiffHunk[], stats: DiffStats, isNewFile: boolean, options: RenderOptions): string {
  // 无变更时返回空字符串
  if (stats.changes === 0 || hunks.length === 0) {
    return "";
  }

  const lines: string[] = [];

  // 文件头：--- 和 +++
  // 新文件（oldContent 为 null）使用 /dev/null 表示原始内容不存在
  lines.push(isNewFile ? "--- /dev/null" : "--- a/file");
  lines.push("+++ b/file");

  // 遍历每个 hunk，生成 hunk 头部和操作行
  for (const hunk of hunks) {
    // hunk 头部：@@ -oldStart,oldLines +newStart,newLines @@
    const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    if (options.colorEnabled) {
      lines.push(`${COLOR_CYAN}${hunkHeader}${COLOR_RESET}`);
    } else {
      lines.push(hunkHeader);
    }

    // 渲染 hunk 内的每个操作
    for (const op of hunk.ops) {
      lines.push(renderOp(op, options));
    }
  }

  // 检查是否超过最大行数限制
  const totalLines = lines.length;
  if (totalLines > options.maxDiffLines) {
    // 截断到 maxDiffLines 行，并添加截断提示
    const truncated = lines.slice(0, options.maxDiffLines);
    truncated.push(`... (${totalLines} lines, truncated)`);
    return truncated.join("\n");
  }

  return lines.join("\n");
}

/**
 * 渲染单个 diff 操作为文本行
 *
 * 输出格式：
 * - 不显示行号时：`{symbol}{content}`
 *   - symbol 为 ' '（equal）、'-'（delete）、'+'（insert）
 * - 显示行号时：`{symbol} {oldNo} {newNo} | {content}`
 *   - oldNo/newNo 右对齐到固定宽度，无对应行号时为空格
 *
 * 颜色规则（colorEnabled 为 true 时）：
 * - delete：红色
 * - insert：绿色
 * - equal：无颜色
 * - 行号：灰色
 *
 * @param op diff 操作
 * @param options 渲染选项
 * @returns 渲染后的单行文本
 */
function renderOp(op: DiffOp, options: RenderOptions): string {
  // 操作符号：equal=' '、delete='-'、insert='+'
  const symbol = op.type === "equal" ? " " : op.type === "delete" ? "-" : "+";
  const content = op.text;

  if (options.showLineNumbers) {
    // 带行号格式：{symbol} {oldNo} {newNo} | {content}
    // 行号右对齐到 LINE_NUMBER_WIDTH 宽度，无行号时为空格
    const oldNoStr =
      op.oldLineNo !== undefined ? String(op.oldLineNo).padStart(LINE_NUMBER_WIDTH) : " ".repeat(LINE_NUMBER_WIDTH);
    const newNoStr =
      op.newLineNo !== undefined ? String(op.newLineNo).padStart(LINE_NUMBER_WIDTH) : " ".repeat(LINE_NUMBER_WIDTH);

    if (options.colorEnabled) {
      // 颜色模式：行号灰色，内容根据操作类型着色
      const contentColor = op.type === "delete" ? COLOR_RED : op.type === "insert" ? COLOR_GREEN : "";
      const coloredContent = contentColor ? `${contentColor}${content}${COLOR_RESET}` : content;
      return `${symbol} ${COLOR_GRAY}${oldNoStr} ${newNoStr}${COLOR_RESET} | ${coloredContent}`;
    }
    return `${symbol} ${oldNoStr} ${newNoStr} | ${content}`;
  }

  // 不带行号格式：{symbol}{content}
  if (options.colorEnabled) {
    const contentColor = op.type === "delete" ? COLOR_RED : op.type === "insert" ? COLOR_GREEN : "";
    if (contentColor) {
      return `${symbol}${contentColor}${content}${COLOR_RESET}`;
    }
  }
  return `${symbol}${content}`;
}
