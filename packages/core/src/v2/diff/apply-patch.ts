/**
 * Fuzzy Matching Patch 应用器（F-DIFF-02）
 *
 * 参考 DeepSeek-TUI crates/tui/src/tools/apply_patch.rs
 * 支持多文件多 hunk + 模糊匹配。
 *
 * 核心功能：
 * 1. parse()：解析 unified diff 格式字符串为 PatchFile 数组
 * 2. apply()：将 patch 应用到文件系统（含 fuzzy matching）
 * 3. applyHunk()：对单个文件应用单个 hunk（含 fuzzy matching）
 *
 * 数据结构设计：
 * - PatchHunk.lines 为带类型标记的行数组（PatchLine[]），保持 unified diff 原始顺序
 * - 旧文件内容 = lines 中所有非 addition 行（context + deletion），按原始顺序
 * - 新文件内容 = lines 中所有非 deletion 行（context + addition），按原始顺序
 * - 这种设计避免了分离数组丢失行交错顺序的问题
 *
 * Fuzzy Matching 算法：
 * 1. 精确匹配：从 oldStart 行开始，逐行比对旧文件期望内容
 * 2. 空白容错：忽略行首/行尾空白差异
 * 3. 滑动搜索：在 oldStart ± maxFuzz 范围内搜索匹配位置
 * 4. 相似度评分：使用 bigram 相似度（内部实现，不依赖外部模块）
 * 5. 候选返回：匹配失败时返回 Top-5 候选位置（按相似度排序）
 *
 * 失败原因映射表（7 种 reason 全覆盖）：
 * | 失败路径 | reason |
 * |----------|--------|
 * | unified diff 解析失败 | invalid_patch |
 * | 读取目标文件 ENOENT | file_not_found |
 * | 读写文件 EACCES/EPERM/ENOSPC | io_error |
 * | 文件非 UTF-8 编码 | encoding_error |
 * | 精确+空白+fuzzy 全部失败 | no_match |
 * | fuzzy 产出多个并列候选 | ambiguous |
 * | patch 新增内容已存在 | already_applied |
 *
 * 设计依据：V2_CONTEXT_MEMORY_TECH_DESIGN.md §3.2.2
 *
 * @module v2/diff/apply-patch
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// 类型定义
// ============================================================================

/** ApplyPatch 配置选项 */
export interface ApplyPatchOptions {
  /** 最大模糊容忍度（0=严格，N=允许 N 处差异），即滑动搜索范围为 oldStart ± maxFuzz */
  maxFuzz: number;
  /** 是否容忍空白差异（行首/行尾空白） */
  ignoreWhitespace: boolean;
  /** 是否容忍大小写差异 */
  ignoreCase: boolean;
}

/** 单行的类型标记 */
export type PatchLineType = "context" | "addition" | "deletion";

/** 带类型标记的单行（保持 unified diff 原始顺序） */
export interface PatchLine {
  /** 行类型：context=上下文行，addition=新增行，deletion=删除行 */
  type: PatchLineType;
  /** 行文本内容（不含 +/- 前缀） */
  text: string;
}

/** 单个 patch hunk（变更块） */
export interface PatchHunk {
  /** 旧文件起始行号（从 1 开始） */
  oldStart: number;
  /** 旧文件的行数 */
  oldLines: number;
  /** 新文件起始行号（从 1 开始） */
  newStart: number;
  /** 新文件的行数 */
  newLines: number;
  /** unified diff 行数组（带类型标记，保持原始顺序，是匹配与替换的唯一数据源） */
  lines: PatchLine[];
}

/** 单个文件的 patch（含多个 hunk） */
export interface PatchFile {
  /** 旧文件路径（--- 行的路径，已去除 a/ 前缀） */
  oldPath: string;
  /** 新文件路径（+++ 行的路径，已去除 b/ 前缀） */
  newPath: string;
  /** 该文件的 hunk 列表 */
  hunks: PatchHunk[];
}

/** apply() 的返回结果 */
export interface ApplyResult {
  /** 是否全部成功 */
  success: boolean;
  /** 成功应用的文件列表 */
  appliedFiles: string[];
  /** 失败列表（含失败原因和候选位置） */
  failures: ApplyFailure[];
  /** 模糊匹配成功的次数 */
  fuzzyMatches: number;
}

/** 单个失败信息 */
export interface ApplyFailure {
  /** 失败的文件路径 */
  filePath: string;
  /** 失败的 hunk 索引 */
  hunkIndex: number;
  /** 失败原因（7 种枚举，覆盖匹配失败 + 解析失败 + I/O 失败三类全部分支） */
  reason:
    | "no_match"
    | "ambiguous"
    | "already_applied"
    | "invalid_patch"
    | "file_not_found"
    | "io_error"
    | "encoding_error";
  /** 候选位置（no_match/ambiguous 时提供，最多 5 个） */
  candidates: PatchCandidate[];
}

/** 候选匹配位置 */
export interface PatchCandidate {
  /** 候选起始行号（从 1 开始） */
  startLine: number;
  /** 相似度评分（0-1，1 为完全匹配） */
  similarity: number;
}

/** applyHunk() 的返回结果 */
export interface SingleHunkResult {
  /** 是否成功 */
  success: boolean;
  /** 成功时返回新内容 */
  newContent?: string;
  /** 失败时返回原因 */
  reason?: ApplyFailure["reason"];
  /** no_match/ambiguous 时提供候选位置 */
  candidates?: PatchCandidate[];
  /** 是否通过模糊匹配成功 */
  fuzzyMatched?: boolean;
}

// ============================================================================
// 默认选项
// ============================================================================

/** 默认配置：maxFuzz=3, ignoreWhitespace=true, ignoreCase=false */
const DEFAULT_OPTIONS: ApplyPatchOptions = {
  maxFuzz: 3,
  ignoreWhitespace: true,
  ignoreCase: false,
};

// ============================================================================
// ApplyPatch 类实现
// ============================================================================

/**
 * Fuzzy Matching Patch 应用器
 *
 * 用法：
 * ```typescript
 * const applier = new ApplyPatch({ maxFuzz: 5 });
 * const patchFiles = applier.parse(unifiedDiffText);
 * const result = applier.apply(patchFiles, workspaceRoot);
 * if (result.success) {
 *   console.log(`成功应用 ${result.appliedFiles.length} 个文件`);
 * } else {
 *   for (const failure of result.failures) {
 *     console.error(`失败: ${failure.filePath} hunk ${failure.hunkIndex}: ${failure.reason}`);
 *   }
 * }
 * ```
 */
export class ApplyPatch {
  /** 配置选项（与默认选项合并后只读） */
  private readonly options: ApplyPatchOptions;

  /**
   * 构造 Patch 应用器
   *
   * @param options 部分配置选项（未提供的使用默认值）
   */
  constructor(options: Partial<ApplyPatchOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 解析 unified diff 格式字符串为 PatchFile 数组
   *
   * 解析规则：
   * 1. 识别 `--- a/path` 和 `+++ b/path` 行作为文件头
   * 2. 识别 `@@ -oldStart,oldLines +newStart,newLines @@` 行作为 hunk 头
   * 3. 以空格开头的行为 context，`+` 开头为 addition，`-` 开头为 deletion
   * 4. 文件之间以 `--- ` 行分隔
   * 5. 行数组 `lines` 保持 unified diff 中的原始顺序（带类型标记）
   *
   * 尾部换行处理：
   * - 输入字符串末尾的 `\n` 在 split 后会产生一个空字符串元素
   * - 该空字符串不是有效的上下文行，需在解析前去除尾部换行
   * - hunk 内部的空行（以空格开头或为空）仍被正确解析为 context
   *
   * @param patchText unified diff 格式字符串
   * @returns 解析后的 PatchFile 数组
   * @throws {Error} 格式非法时抛出（reason: invalid_patch）
   */
  parse(patchText: string): PatchFile[] {
    // 去除尾部换行符，避免 split 后产生多余的空字符串元素被误判为 context
    const normalizedText = patchText.replace(/\n+$/, "");
    const lines = normalizedText.split("\n");
    const files: PatchFile[] = [];
    let currentFile: PatchFile | null = null;
    let currentHunk: PatchHunk | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 文件头：--- a/oldpath
      if (line.startsWith("--- ")) {
        // 如果有未完成的 hunk，追加到当前文件
        if (currentHunk && currentFile) {
          currentFile.hunks.push(currentHunk);
        }
        // 如果有未完成的文件，追加到结果
        if (currentFile) {
          files.push(currentFile);
        }

        const oldPath = this.stripPathPrefix(line.slice(4));
        // 读取下一行获取 +++ b/newpath
        const nextLine = lines[i + 1];
        if (!nextLine || !nextLine.startsWith("+++ ")) {
          throw new Error(`invalid_patch: 第 ${i + 1} 行 --- 后缺少 +++ 行`);
        }
        const newPath = this.stripPathPrefix(nextLine.slice(4));
        currentFile = { oldPath, newPath, hunks: [] };
        currentHunk = null;
        i++; // 跳过 +++ 行
        continue;
      }

      // hunk 头：@@ -oldStart,oldLines +newStart,newLines @@
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch) {
        // 如果有未完成的 hunk，追加到当前文件
        if (currentHunk && currentFile) {
          currentFile.hunks.push(currentHunk);
        }

        const oldStart = parseInt(hunkMatch[1], 10);
        const oldLines = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
        const newStart = parseInt(hunkMatch[3], 10);
        const newLines = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;

        currentHunk = {
          oldStart,
          oldLines,
          newStart,
          newLines,
          lines: [],
        };
        continue;
      }

      // hunk 内容行（按原始顺序追加到 lines 数组，带类型标记）
      if (currentHunk) {
        if (line.startsWith("+")) {
          // addition 行：+ 前缀
          currentHunk.lines.push({ type: "addition", text: line.slice(1) });
        } else if (line.startsWith("-")) {
          // deletion 行：- 前缀
          currentHunk.lines.push({ type: "deletion", text: line.slice(1) });
        } else if (line.startsWith(" ")) {
          // context 行：以空格开头，去除前导空格
          currentHunk.lines.push({ type: "context", text: line.slice(1) });
        } else if (line === "") {
          // 空行视为 context（unified diff 中空行通常表示空上下文行）
          currentHunk.lines.push({ type: "context", text: "" });
        } else if (line.startsWith("\\")) {
          // \\ No newline at end of file — 忽略此标记
          continue;
        }
      }
    }

    // 追加最后一个 hunk 和文件
    if (currentHunk && currentFile) {
      currentFile.hunks.push(currentHunk);
    }
    if (currentFile) {
      files.push(currentFile);
    }

    return files;
  }

  /**
   * 应用 patch 到文件系统
   *
   * 逐文件逐 hunk 应用：
   * 1. 读取文件内容（处理 file_not_found / io_error / encoding_error）
   * 2. 逐 hunk 调用 applyHunk() 应用变更
   * 3. 全部 hunk 成功后写回文件
   *
   * @param patchFiles PatchFile 数组
   * @param workspaceRoot 工作区根目录
   * @returns ApplyResult（含成功文件列表和失败列表）
   */
  apply(patchFiles: PatchFile[], workspaceRoot: string): ApplyResult {
    const appliedFiles: string[] = [];
    const failures: ApplyFailure[] = [];
    let fuzzyMatches = 0;

    for (const patchFile of patchFiles) {
      const filePath = path.resolve(workspaceRoot, patchFile.newPath);
      let fileContent: string;

      // 读取文件内容（处理 I/O 类失败）
      try {
        fileContent = fs.readFileSync(filePath, "utf-8");
      } catch (err) {
        const error = err as NodeJS.ErrnoException;
        let reason: ApplyFailure["reason"];
        if (error.code === "ENOENT") {
          reason = "file_not_found";
        } else if (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOSPC") {
          reason = "io_error";
        } else {
          // 其他 I/O 错误也归为 io_error
          reason = "io_error";
        }
        failures.push({
          filePath: patchFile.newPath,
          hunkIndex: -1,
          reason,
          candidates: [],
        });
        continue;
      }

      // 逐 hunk 应用
      let currentContent = fileContent;
      let allHunksSuccess = true;

      for (let hunkIndex = 0; hunkIndex < patchFile.hunks.length; hunkIndex++) {
        const hunk = patchFile.hunks[hunkIndex];
        const result = this.applyHunk(currentContent, hunk);

        if (result.success) {
          currentContent = result.newContent!;
          if (result.fuzzyMatched) {
            fuzzyMatches++;
          }
        } else {
          // hunk 应用失败，记录失败信息
          failures.push({
            filePath: patchFile.newPath,
            hunkIndex,
            reason: result.reason!,
            candidates: result.candidates ?? [],
          });
          allHunksSuccess = false;
          break; // 同一文件后续 hunk 不再尝试
        }
      }

      // 全部 hunk 成功，写回文件
      if (allHunksSuccess) {
        try {
          fs.writeFileSync(filePath, currentContent, "utf-8");
          appliedFiles.push(patchFile.newPath);
        } catch {
          failures.push({
            filePath: patchFile.newPath,
            hunkIndex: -1,
            reason: "io_error",
            candidates: [],
          });
        }
      }
    }

    return {
      success: failures.length === 0,
      appliedFiles,
      failures,
      fuzzyMatches,
    };
  }

  /**
   * 对单个文件应用单个 hunk（带 fuzzy matching）
   *
   * 匹配流程：
   * 1. 幂等检测：检查 additions 内容是否已存在于目标位置（already_applied）
   * 2. 精确匹配：从 oldStart 行开始，逐行比对旧文件期望内容
   * 3. 空白容错：忽略行首/行尾空白差异
   * 4. 滑动搜索：在 oldStart ± maxFuzz 范围内搜索匹配位置
   * 5. 相似度评分：使用 bigram 相似度评估候选位置
   * 6. 候选返回：匹配失败时返回 Top-5 候选位置
   *
   * 期望内容与替换内容的构造（基于 lines 数组的原始顺序）：
   * - expectedLines（旧文件应存在的内容）= lines 中所有非 addition 行的文本
   * - replacementLines（新文件应替换为的内容）= lines 中所有非 deletion 行的文本
   * - 这种构造保持了 unified diff 中行的交错顺序，确保匹配正确性
   *
   * @param fileContent 文件内容
   * @param hunk 要应用的 hunk
   * @returns 应用结果（成功则返回新内容，失败则返回原因和候选位置）
   */
  applyHunk(fileContent: string, hunk: PatchHunk): SingleHunkResult {
    const fileLines = fileContent.split("\n");

    // 构建"期望内容"：lines 中所有非 addition 行（context + deletion），保持原始顺序
    // 这对应旧文件中应存在的文本
    const expectedLines = hunk.lines.filter((l) => l.type !== "addition").map((l) => l.text);

    // 构建"替换内容"：lines 中所有非 deletion 行（context + addition），保持原始顺序
    // 这对应新文件中应替换为的文本
    const replacementLines = hunk.lines.filter((l) => l.type !== "deletion").map((l) => l.text);

    // 提取 additions 用于幂等检测
    const additions = hunk.lines.filter((l) => l.type === "addition").map((l) => l.text);

    // 步骤 1：幂等检测——检查 additions 是否已存在于目标位置
    // 如果 additions 内容已经在文件中 oldStart 附近，说明 patch 已应用过
    if (additions.length > 0) {
      const additionText = additions.join("\n");
      const nearbyStart = Math.max(0, hunk.oldStart - 1);
      const nearbyEnd = Math.min(fileLines.length, hunk.oldStart - 1 + additions.length + 1);
      const nearbyText = fileLines.slice(nearbyStart, nearbyEnd).join("\n");
      if (nearbyText.includes(additionText)) {
        return { success: false, reason: "already_applied" };
      }
    }

    // 步骤 2：精确匹配——从 oldStart 行开始逐行比对
    const matchStart = hunk.oldStart - 1; // 转为 0-based
    if (this.exactMatch(fileLines, expectedLines, matchStart)) {
      // 精确匹配成功，执行替换
      const newContent = this.replaceLines(fileLines, matchStart, expectedLines.length, replacementLines);
      return { success: true, newContent, fuzzyMatched: false };
    }

    // 步骤 3：空白容错匹配
    if (this.options.ignoreWhitespace) {
      if (this.whitespaceTolerantMatch(fileLines, expectedLines, matchStart)) {
        const newContent = this.replaceLines(fileLines, matchStart, expectedLines.length, replacementLines);
        return { success: true, newContent, fuzzyMatched: false };
      }
    }

    // 步骤 4：滑动搜索——在 oldStart ± maxFuzz 范围内搜索
    const candidates: PatchCandidate[] = [];
    const searchStart = Math.max(0, matchStart - this.options.maxFuzz);
    const searchEnd = Math.min(fileLines.length - expectedLines.length, matchStart + this.options.maxFuzz);

    for (let start = searchStart; start <= searchEnd; start++) {
      const similarity = this.computeSimilarity(fileLines, expectedLines, start);
      if (similarity >= 0.8) {
        candidates.push({ startLine: start + 1, similarity });
      }
    }

    // 按相似度降序排列，取 Top-5
    candidates.sort((a, b) => b.similarity - a.similarity);
    const topCandidates = candidates.slice(0, 5);

    if (topCandidates.length === 0) {
      // 无候选：完全无法匹配
      return {
        success: false,
        reason: "no_match",
        candidates: [],
      };
    }

    // 检查是否有唯一最佳候选
    if (topCandidates.length === 1 || topCandidates[0].similarity - topCandidates[1].similarity > 0.1) {
      // 唯一最佳候选（或相似度差距 > 0.1），使用 fuzzy 匹配
      const bestStart = topCandidates[0].startLine - 1; // 转为 0-based
      const newContent = this.replaceLines(fileLines, bestStart, expectedLines.length, replacementLines);
      return { success: true, newContent, fuzzyMatched: true };
    }

    // 多个并列候选，无法唯一确定
    return {
      success: false,
      reason: "ambiguous",
      candidates: topCandidates,
    };
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 去除路径前缀（a/ 或 b/）
   *
   * unified diff 格式中文件路径通常以 a/ 或 b/ 前缀，
   * 实际应用时需要去除前缀以获取真实路径。
   *
   * @param rawPath 原始路径（可能含 a/ 或 b/ 前缀）
   * @returns 去除前缀后的路径
   */
  private stripPathPrefix(rawPath: string): string {
    // 去除 a/ 或 b/ 前缀
    if (rawPath.startsWith("a/")) return rawPath.slice(2);
    if (rawPath.startsWith("b/")) return rawPath.slice(2);
    return rawPath;
  }

  /**
   * 精确匹配：从指定位置开始逐行比对
   *
   * @param fileLines 文件行数组
   * @param expectedLines 期望的行内容（旧文件中应存在的文本）
   * @param start 起始行号（0-based）
   * @returns 是否完全匹配
   */
  private exactMatch(fileLines: string[], expectedLines: string[], start: number): boolean {
    if (start < 0 || start + expectedLines.length > fileLines.length) {
      return false;
    }
    for (let i = 0; i < expectedLines.length; i++) {
      let fileLine = fileLines[start + i];
      let expectedLine = expectedLines[i];

      if (this.options.ignoreCase) {
        fileLine = fileLine.toLowerCase();
        expectedLine = expectedLine.toLowerCase();
      }

      if (fileLine !== expectedLine) {
        return false;
      }
    }
    return true;
  }

  /**
   * 空白容错匹配：忽略行首/行尾空白差异
   *
   * @param fileLines 文件行数组
   * @param expectedLines 期望的行内容
   * @param start 起始行号（0-based）
   * @returns 是否匹配（忽略空白后）
   */
  private whitespaceTolerantMatch(fileLines: string[], expectedLines: string[], start: number): boolean {
    if (start < 0 || start + expectedLines.length > fileLines.length) {
      return false;
    }
    for (let i = 0; i < expectedLines.length; i++) {
      const fileLine = fileLines[start + i].trim();
      const expectedLine = expectedLines[i].trim();

      if (this.options.ignoreCase) {
        if (fileLine.toLowerCase() !== expectedLine.toLowerCase()) {
          return false;
        }
      } else {
        if (fileLine !== expectedLine) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * 计算相似度：使用 bigram 相似度算法
   *
   * 将文件从 start 开始的 expectedLines.length 行与 expectedLines 比对，
   * 计算两者的 bigram 集合的 Jaccard 相似度。
   *
   * bigram 相似度原理：
   * 1. 将每行文本拆分为相邻字符对（bigram）
   * 2. 合并所有行的 bigram 为一个集合
   * 3. 计算两个 bigram 集合的 Jaccard 相似度 = |交集| / |并集|
   *
   * @param fileLines 文件行数组
   * @param expectedLines 期望的行内容
   * @param start 起始行号（0-based）
   * @returns 相似度（0-1，1 为完全匹配）
   */
  private computeSimilarity(fileLines: string[], expectedLines: string[], start: number): number {
    if (start < 0 || start + expectedLines.length > fileLines.length) {
      return 0;
    }

    // 提取文件中对应区间的文本
    const fileText = fileLines.slice(start, start + expectedLines.length).join("\n");
    const expectedText = expectedLines.join("\n");

    // 计算 bigram 集合
    const fileBigrams = this.toBigrams(fileText);
    const expectedBigrams = this.toBigrams(expectedText);

    if (fileBigrams.size === 0 && expectedBigrams.size === 0) {
      return 1; // 两者都为空，视为完全匹配
    }

    // 计算 Jaccard 相似度 = |交集| / |并集|
    let intersection = 0;
    for (const bigram of expectedBigrams) {
      if (fileBigrams.has(bigram)) {
        intersection++;
      }
    }
    const union = fileBigrams.size + expectedBigrams.size - intersection;

    return union === 0 ? 0 : intersection / union;
  }

  /**
   * 将文本转换为 bigram 集合
   *
   * bigram = 相邻两个字符组成的字符串。
   * 例如 "hello" → {"he", "el", "ll", "lo"}
   *
   * @param text 输入文本
   * @returns bigram 集合（Set 去重）
   */
  private toBigrams(text: string): Set<string> {
    const bigrams = new Set<string>();
    for (let i = 0; i < text.length - 1; i++) {
      let bigram = text.slice(i, i + 2);
      if (this.options.ignoreWhitespace) {
        bigram = bigram.replace(/\s+/g, " ");
      }
      if (this.options.ignoreCase) {
        bigram = bigram.toLowerCase();
      }
      bigrams.add(bigram);
    }
    return bigrams;
  }

  /**
   * 替换文件中的指定行范围
   *
   * 将 fileLines[start .. start+count) 替换为 replacementLines，
   * 返回新的完整文件内容字符串。
   *
   * @param fileLines 原始文件行数组
   * @param start 起始行号（0-based）
   * @param count 要替换的行数
   * @param replacementLines 替换后的行内容
   * @returns 新的文件内容字符串
   */
  private replaceLines(fileLines: string[], start: number, count: number, replacementLines: string[]): string {
    const before = fileLines.slice(0, start);
    const after = fileLines.slice(start + count);
    const newLines = [...before, ...replacementLines, ...after];
    return newLines.join("\n");
  }
}
