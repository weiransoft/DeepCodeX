/**
 * FIX 回灌循环（EAG-P2 批次 9 S4 填充与修复层）
 *
 * 本模块实现 `FixLoop` 类、`PatchApplier` 接口与 `UnifiedDiffApplier` 类，
 * 对应 EAG-P2 批次 9 设计 §4.6：
 * 基于 STRICT 评估报告，调用 LLM 生成修复 patch，应用 patch 后重新评估，
 * 多轮循环直到通过或达上限。
 *
 * 核心职责（对齐 §4.6.1）：
 * 1. 装配 FIX prompt（原代码 + 评估报告 + 违规项 + 前 2 轮失败摘要）
 * 2. 调用 LLM 生成 unified diff 格式 patch
 * 3. 应用 diff 到原文件（自实现 UnifiedDiffApplier）
 * 4. 重新评估（调用 StrictEvaluator.evaluate）
 * 5. 若 verdict=pass → 返回成功
 * 6. 若 verdict=fix 且 round < maxRounds → 继续下一轮
 * 7. 若 round = maxRounds → 返回 fix-exhausted
 * 8. 同一红线连续 2 轮 violated → 强制 HUMAN_CHECKPOINT（§7 R3 风险缓解）
 *
 * 关键技术决策（对齐 §4.6.2）：
 * - Patch 格式：unified diff（--- a/path / +++ b/path / @@ hunk）
 * - Patch 应用：自实现 UnifiedDiffApplier（不引入 patch 库，200 行内）
 * - 失败上限：3 轮 FIX（对齐 §5.2.3 + §5.12.2 失败上限纪律）
 * - 上下文窗口：每轮携带前 2 轮失败摘要（避免重复犯错 + 防 token 膨胀）
 * - 评估器复用：复用 StrictEvaluator 实例（单一评估器贯穿 Phase B → FIX 全流程）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有方法入参与返回值使用 readonly + ReadonlyArray
 * - 顶层配置使用 Object.freeze 冻结
 * - 工厂方法返回冻结对象
 *
 * @module eag/coding/fix-loop
 */

import type { CodingContext, FixLoopRequest, FixLoopResult, FixRoundRecord, GeneratedFile } from "./types";
import { DEFAULT_MAX_FIX_ROUNDS, FIX_CONTEXT_WINDOW_SIZE, SAME_REDLINE_CONSECUTIVE_VIOLATION_LIMIT } from "./types";
import type { StrictEvaluator } from "./strict-evaluator";
import type { EvaluationContext, EvaluationReport, RedlineDefinition, RedlineResult } from "../evaluator/types";
import type { LLMClient, LLMRequest, LLMResponse, LLMStreamEvent } from "../../providers/llm-provider";
import type { SessionMessage } from "../../session";

// ============================================================================
// 常量与配置
// ============================================================================

/**
 * 日志回调类型（与同模块其他类保持一致）
 */
type LogCallback = (message: string, level?: "info" | "warn" | "error") => void;

/**
 * 默认最大 FIX 轮次（对齐 §5.2.3 + types.ts DEFAULT_MAX_FIX_ROUNDS = 3）
 *
 * 连续 3 次 FIX 失败 → HUMAN_CHECKPOINT。
 */
const DEFAULT_MAX_ROUNDS = DEFAULT_MAX_FIX_ROUNDS;

/**
 * FIX 上下文窗口大小（对齐 §4.6.2 + types.ts FIX_CONTEXT_WINDOW_SIZE = 2）
 *
 * 每轮 FIX 携带前 2 轮失败摘要，避免重复犯错。
 */
const FIX_WINDOW_SIZE = FIX_CONTEXT_WINDOW_SIZE;

/**
 * 同一红线连续违反上限（对齐 §7 R3 + types.ts SAME_REDLINE_CONSECUTIVE_VIOLATION_LIMIT = 2）
 *
 * 同一红线连续 2 轮 violated → 强制 HUMAN_CHECKPOINT。
 */
const CONSECUTIVE_VIOLATION_LIMIT = SAME_REDLINE_CONSECUTIVE_VIOLATION_LIMIT;

/**
 * LLM 调用温度（FIX 阶段略高于填充阶段，但仍低温，保持确定性）
 */
const LLM_TEMPERATURE = 0.2 as const;

/**
 * 单次 LLM 调用最大 token 上限
 */
const MAX_TOKENS_PER_LLM_CALL = 8000 as const;

/**
 * 估算 token 数的字符换算比例（与 llm-filler.ts 一致）
 */
const CHARS_PER_TOKEN = 4 as const;

// ============================================================================
// 异常类型
// ============================================================================

/**
 * FIX 循环错误
 *
 * 当请求字段非法、patch 应用失败、评估器调用异常等场景抛出。
 */
export class FixLoopError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-request：请求字段非法（originalFiles / evaluationReport / llmClient 缺失）
   *   - patch-apply-failed：unified diff 应用失败（hunk 行号不匹配）
   *   - evaluator-error：评估器调用抛出异常
   *   - llm-call-failed：LLM 调用抛出异常
   * @param detail 错误详情
   */
  constructor(
    public readonly kind: "invalid-request" | "patch-apply-failed" | "evaluator-error" | "llm-call-failed",
    public readonly detail: string
  ) {
    super(`FIX 循环错误 [${kind}]：${detail}`);
    this.name = "FixLoopError";
  }
}

/**
 * Patch 应用错误
 *
 * 当 unified diff 解析失败或 hunk 行号不匹配时抛出。
 */
export class PatchApplyError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-format：patch 不是合法的 unified diff 格式
   *   - file-not-found：patch 中的文件路径在 originalFiles 中找不到
   *   - hunk-line-mismatch：hunk 上下文行与原文件不匹配
   *   - empty-patch：patch 为空字符串或无有效 hunk
   * @param detail 错误详情
   */
  constructor(
    public readonly kind: "invalid-format" | "file-not-found" | "hunk-line-mismatch" | "empty-patch",
    public readonly detail: string
  ) {
    super(`Patch 应用错误 [${kind}]：${detail}`);
    this.name = "PatchApplyError";
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 构造一条 SessionMessage（与 llm-filler.ts 一致，保持代码风格统一）
 *
 * @param role 消息角色（"system" / "user"）
 * @param content 消息内容
 * @returns 完整的 SessionMessage
 */
function buildMessage(role: "system" | "user", content: string): SessionMessage {
  const now = new Date().toISOString();
  return {
    id: `fix-loop-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "fix-loop-session",
    role,
    content,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: false,
    createTime: now,
    updateTime: now,
  };
}

/**
 * 提取评估报告中的违规红线 ID 列表
 *
 * 用于检测同一红线连续违反（§7 R3 风险缓解）。
 *
 * @param report 评估报告
 * @returns 违规的红线 ID 列表（去重后）
 */
function extractViolatedRedlineIds(report: Readonly<EvaluationReport>): string[] {
  const ids = new Set<string>();
  for (const result of report.redlineResults) {
    if (result.status === "violated") {
      ids.add(result.redlineId);
    }
  }
  return Array.from(ids);
}

/**
 * 检测同一红线是否连续违反上限（§7 R3 风险缓解）
 *
 * 算法：检查每轮的违规红线 ID 是否在前 N 轮也违规。
 * - 若同一红线连续 CONSECUTIVE_VIOLATION_LIMIT 轮 violated → 返回 true
 *
 * @param rounds 各轮记录
 * @returns true 表示有红线连续违反上限，需强制 HUMAN_CHECKPOINT
 */
function hasConsecutiveViolationExceeded(rounds: ReadonlyArray<FixRoundRecord>): boolean {
  if (rounds.length < CONSECUTIVE_VIOLATION_LIMIT) return false;
  // 取最近 N 轮的违规红线 ID
  const recentRounds = rounds.slice(-CONSECUTIVE_VIOLATION_LIMIT);
  // 取所有轮次都违规的红线 ID（交集）
  const commonViolations = recentRounds.reduce(
    (acc, round, idx) => {
      const violatedIds = new Set(extractViolatedRedlineIds(round.outputReport));
      if (idx === 0) return violatedIds;
      // 取与前一轮交集
      for (const id of acc) {
        if (!violatedIds.has(id)) {
          acc.delete(id);
        }
      }
      return acc;
    },
    new Set<string>(extractViolatedRedlineIds(recentRounds[0].outputReport))
  );

  return commonViolations.size > 0;
}

// ============================================================================
// PatchApplier 接口
// ============================================================================

/**
 * Diff 应用器协议
 *
 * 对应 EAG-P2 批次 9 设计 §4.6.3 PatchApplier：
 * 将 unified diff 应用到原文件，产出修复后的文件列表。
 *
 * 设计依据（对齐 §4.6.2 关键技术决策）：
 * - 自实现 diff 应用器（不引入 patch 库，减少 dependency）
 * - diff 应用算法简单（200 行内），自实现可控
 * - 失败时抛 PatchApplyError，由 FixLoop 决定后续动作
 *
 * 实现方负责：
 * 1. 解析 unified diff 格式（--- a/path / +++ b/path / @@ hunk）
 * 2. 对每个 hunk 应用上下文匹配 + 增删行
 * 3. 失败时尝试 fuzzy matching（±3 行容差，对齐 §7 R5 风险缓解）
 * 4. fuzzy matching 失败时抛 PatchApplyError
 *
 * 调用方（FixLoop）负责：
 * 1. 在每轮 FIX 中调用 apply(originalFiles, patch)
 * 2. 捕获 PatchApplyError，记录到本轮 FixRoundRecord.patch 失败信息
 * 3. 决定是否进入下一轮或终止
 */
export interface PatchApplier {
  /**
   * 将 unified diff 应用到原文件
   *
   * @param originalFiles 原始文件列表
   * @param patch unified diff 字符串
   * @returns 应用后的文件列表（失败时抛 PatchApplyError）
   * @throws {PatchApplyError} patch 格式非法 / 文件未找到 / hunk 行号不匹配
   */
  apply(originalFiles: ReadonlyArray<GeneratedFile>, patch: string): ReadonlyArray<GeneratedFile>;
}

// ============================================================================
// UnifiedDiffApplier 类
// ============================================================================

/**
 * Unified Diff 应用器
 *
 * 对应 EAG-P2 批次 9 设计 §4.6.3 UnifiedDiffApplier：
 * 自实现 unified diff 解析与应用算法。
 *
 * Unified Diff 格式（标准 GNU diff）：
 * ```
 * --- a/src/file.ts
 * +++ b/src/file.ts
 * @@ -10,5 +10,7 @@
 *  unchanged context line 1
 *  unchanged context line 2
 * -removed line
 * +added line 1
 * +added line 2
 *  unchanged context line 3
 * ```
 *
 * 算法：
 * 1. 解析 patch 字符串，按 `--- ` / `+++ ` / `@@ ` 切分文件级 diff 与 hunk
 * 2. 对每个文件级 diff：
 *    a. 提取 a/ 与 b/ 路径
 *    b. 在 originalFiles 中查找对应文件
 *    c. 对每个 hunk：
 *       - 解析 @@ -start,count +start,count @@ 头
 *       - 提取上下文行（前缀空格）+ 删除行（前缀 -）+ 增加行（前缀 +）
 *       - 在原文件 start-1 行开始匹配上下文行
 *       - 失败时尝试 fuzzy matching（±3 行容差）
 *       - 应用增删行替换原文件内容
 * 3. 返回更新后的文件列表
 *
 * 不可变优先：
 * - 入参使用 ReadonlyArray + readonly 字段
 * - 返回值为新创建的冻结对象（不修改原 originalFiles）
 *
 * 容错策略（对齐 §7 R5 风险缓解）：
 * - fuzzy matching：±3 行容差，在 start±3 范围内查找匹配位置
 * - hunk 行号超出文件范围时尝试 fuzzy matching
 * - fuzzy matching 失败时抛 PatchApplyError（hunk-line-mismatch）
 */
export class UnifiedDiffApplier implements PatchApplier {
  /** fuzzy matching 容差（行数，对齐 §7 R5：±3 行） */
  private readonly fuzzyTolerance: number;

  /**
   * 初始化 UnifiedDiffApplier
   *
   * @param fuzzyTolerance fuzzy matching 容差（默认 3 行）
   */
  constructor(fuzzyTolerance: number = 3) {
    this.fuzzyTolerance = Math.max(0, fuzzyTolerance);
  }

  /**
   * 应用 unified diff 到原文件
   *
   * @param originalFiles 原始文件列表
   * @param patch unified diff 字符串
   * @returns 应用后的文件列表（已冻结）
   * @throws {PatchApplyError} patch 格式非法 / 文件未找到 / hunk 行号不匹配
   */
  apply(originalFiles: ReadonlyArray<GeneratedFile>, patch: string): ReadonlyArray<GeneratedFile> {
    if (typeof patch !== "string" || patch.trim().length === 0) {
      throw new PatchApplyError("empty-patch", "patch 为空字符串或无有效内容");
    }

    // 解析 patch 为多个文件级 diff
    const fileDiffs = this.parseFileDiffs(patch);
    if (fileDiffs.length === 0) {
      throw new PatchApplyError("invalid-format", "patch 中未找到有效的文件级 diff（--- / +++ 头）");
    }

    // 复制原文件列表（避免修改入参）
    const resultFiles: GeneratedFile[] = originalFiles.map((f) => ({
      relativePath: f.relativePath,
      content: f.content,
      kind: f.kind,
      taskId: f.taskId,
      requirementId: f.requirementId,
    }));

    // 对每个文件级 diff 应用 hunks
    for (const fileDiff of fileDiffs) {
      // 在 resultFiles 中查找对应文件（按 b/ 路径优先，回退到 a/ 路径）
      const targetFile = resultFiles.find(
        (f) => f.relativePath === fileDiff.bPath || f.relativePath === fileDiff.aPath
      );
      if (!targetFile) {
        throw new PatchApplyError("file-not-found", `patch 中的文件路径 "${fileDiff.bPath}" 在 originalFiles 中找不到`);
      }

      // 应用所有 hunks 到 targetFile.content
      let currentContent = targetFile.content;
      for (const hunk of fileDiff.hunks) {
        currentContent = this.applyHunk(currentContent, hunk, targetFile.relativePath);
      }

      // 更新 resultFiles 中对应文件的内容
      const targetIdx = resultFiles.indexOf(targetFile);
      resultFiles[targetIdx] = Object.freeze({
        relativePath: targetFile.relativePath,
        content: currentContent,
        kind: targetFile.kind,
        taskId: targetFile.taskId,
        requirementId: targetFile.requirementId,
      }) as GeneratedFile;
    }

    return Object.freeze(resultFiles) as ReadonlyArray<GeneratedFile>;
  }

  // ========================================================================
  // 私有辅助方法
  // ========================================================================

  /**
   * 解析 patch 字符串为文件级 diff 列表
   *
   * @param patch unified diff 字符串
   * @returns 文件级 diff 列表（每个含 aPath / bPath / hunks）
   */
  private parseFileDiffs(patch: string): Array<{
    aPath: string;
    bPath: string;
    hunks: Array<Hunk>;
  }> {
    const fileDiffs: Array<{ aPath: string; bPath: string; hunks: Array<Hunk> }> = [];
    const lines = patch.split(/\r?\n/);

    let currentFileDiff: { aPath: string; bPath: string; hunks: Array<Hunk> } | null = null;
    let currentHunk: Hunk | null = null;
    let currentHunkLines: HunkLine[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 文件头 --- a/path
      if (line.startsWith("--- ")) {
        // 提交前一个 hunk（如有）
        if (currentFileDiff && currentHunk) {
          currentHunk.lines = Object.freeze([...currentHunkLines]) as ReadonlyArray<HunkLine>;
          currentFileDiff.hunks.push(currentHunk);
          currentHunk = null;
          currentHunkLines = [];
        }
        // 提交前一个文件 diff（如有）
        if (currentFileDiff) {
          fileDiffs.push(currentFileDiff);
        }
        // 开始新文件 diff
        const aPath = this.extractPath(line);
        // 下一行应为 +++ b/path
        const nextLine = lines[i + 1];
        if (!nextLine || !nextLine.startsWith("+++ ")) {
          throw new PatchApplyError(
            "invalid-format",
            `第 ${i + 1} 行 "--- " 后未跟随 "+++ " 头（实际为：${nextLine}）`
          );
        }
        const bPath = this.extractPath(nextLine);
        currentFileDiff = { aPath, bPath, hunks: [] };
        i++; // 跳过下一行（+++ 头）
        continue;
      }

      // Hunk 头 @@ -start,count +start,count @@
      if (line.startsWith("@@ ")) {
        // 提交前一个 hunk
        if (currentFileDiff && currentHunk) {
          currentHunk.lines = Object.freeze([...currentHunkLines]) as ReadonlyArray<HunkLine>;
          currentFileDiff.hunks.push(currentHunk);
          currentHunkLines = [];
        }
        if (!currentFileDiff) {
          throw new PatchApplyError("invalid-format", `第 ${i + 1} 行 "@@ " 出现在文件头 "--- " 之前`);
        }
        // 解析 hunk 头
        const hunkHeader = this.parseHunkHeader(line);
        if (!hunkHeader) {
          throw new PatchApplyError("invalid-format", `第 ${i + 1} 行 hunk 头格式错误：${line}`);
        }
        currentHunk = hunkHeader;
        continue;
      }

      // Hunk 内容行（前缀为空格 / - / +）
      if (currentHunk) {
        if (line.startsWith(" ")) {
          // 上下文行
          currentHunkLines.push({ type: "context", content: line.slice(1) });
        } else if (line.startsWith("-")) {
          // 删除行
          currentHunkLines.push({ type: "remove", content: line.slice(1) });
        } else if (line.startsWith("+")) {
          // 增加行
          currentHunkLines.push({ type: "add", content: line.slice(1) });
        } else if (line.startsWith("\\") || line === "") {
          // \ No newline at end of file 或空行 → 跳过
          continue;
        } else {
          // 未知行 → 视为上下文行（容错）
          currentHunkLines.push({ type: "context", content: line });
        }
      }
    }

    // 提交最后一个 hunk
    if (currentFileDiff && currentHunk) {
      currentHunk.lines = Object.freeze([...currentHunkLines]) as ReadonlyArray<HunkLine>;
      currentFileDiff.hunks.push(currentHunk);
    }
    // 提交最后一个文件 diff
    if (currentFileDiff) {
      fileDiffs.push(currentFileDiff);
    }

    return fileDiffs;
  }

  /**
   * 从 --- 或 +++ 行中提取文件路径
   *
   * 支持两种格式：
   * - `--- a/src/file.ts`（去除 a/ 前缀）
   * - `--- src/file.ts`（无前缀）
   *
   * @param headerLine 头行（"--- a/..." 或 "+++ b/..."）
   * @returns 提取的文件路径
   */
  private extractPath(headerLine: string): string {
    // 去除前缀 "--- " 或 "+++ "
    const rest = headerLine.slice(4).trim();
    // 去除尾部时间戳（如 "2026-07-19 10:00:00.000000000 +0800"）
    const pathPart = rest.split(/\s+/)[0] ?? rest;
    // 去除 a/ 或 b/ 前缀
    if (pathPart.startsWith("a/") || pathPart.startsWith("b/")) {
      return pathPart.slice(2);
    }
    return pathPart;
  }

  /**
   * 解析 hunk 头 @@ -start,count +start,count @@
   *
   * @param line hunk 头行
   * @returns 解析后的 Hunk 对象；解析失败返回 null
   */
  private parseHunkHeader(line: string): Hunk | null {
    // 匹配 @@ -start,count +start,count @@ 形式
    // count 可选（默认 1）
    const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!match) return null;
    const oldStart = parseInt(match[1], 10);
    const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
    const newStart = parseInt(match[3], 10);
    const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;
    return {
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: [],
    };
  }

  /**
   * 应用单个 hunk 到文件内容
   *
   * 算法：
   * 1. 将原内容按行分割
   * 2. 提取 hunk 的上下文行 + 删除行（用于匹配）
   * 3. 在原文件 oldStart-1 位置开始匹配
   * 4. 失败时尝试 fuzzy matching（±3 行容差）
   * 5. 替换匹配区域为：上下文行 + 增加行
   * 6. 返回更新后的内容
   *
   * @param content 原文件内容
   * @param hunk hunk 对象
   * @param filePath 文件路径（用于错误信息）
   * @returns 应用 hunk 后的文件内容
   * @throws {PatchApplyError} hunk 行号不匹配且 fuzzy matching 失败
   */
  private applyHunk(content: string, hunk: Hunk, filePath: string): string {
    const lines = content.split(/\r?\n/);
    // 收集 hunk 中需要匹配的"旧内容"（上下文行 + 删除行）
    const oldLines: string[] = [];
    for (const hl of hunk.lines) {
      if (hl.type === "context" || hl.type === "remove") {
        oldLines.push(hl.content);
      }
    }
    // 收集 hunk 中的"新内容"（上下文行 + 增加行）
    const newLines: string[] = [];
    for (const hl of hunk.lines) {
      if (hl.type === "context" || hl.type === "add") {
        newLines.push(hl.content);
      }
    }

    // 若 hunk 无任何内容行 → 直接返回原内容
    if (oldLines.length === 0 && newLines.length === 0) {
      return content;
    }

    // 在原文件中查找匹配位置（oldStart-1 为 0-based 索引）
    const expectedStart = Math.max(0, hunk.oldStart - 1);
    const matchPos = this.findMatchPosition(lines, oldLines, expectedStart);

    if (matchPos < 0) {
      // fuzzy matching 失败
      throw new PatchApplyError(
        "hunk-line-mismatch",
        `文件 "${filePath}" 中 hunk @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@ 行号不匹配（fuzzy 容差 ${this.fuzzyTolerance} 行内未找到匹配）`
      );
    }

    // 替换匹配区域为新内容
    const newFileLines = [...lines.slice(0, matchPos), ...newLines, ...lines.slice(matchPos + oldLines.length)];

    return newFileLines.join("\n");
  }

  /**
   * 在原文件中查找匹配位置
   *
   * 算法：
   * 1. 优先在 expectedStart 位置匹配
   * 2. 失败时在 [expectedStart - tolerance, expectedStart + tolerance] 范围内 fuzzy 匹配
   * 3. 若 oldLines 为空（纯添加 hunk）→ 直接返回 expectedStart
   *
   * @param fileLines 原文件按行分割的数组
   * @param oldLines hunk 中需要匹配的旧内容行
   * @param expectedStart 期望的起始位置（0-based）
   * @returns 匹配位置（0-based）；未找到返回 -1
   */
  private findMatchPosition(fileLines: string[], oldLines: string[], expectedStart: number): number {
    // 纯添加 hunk（无上下文 / 删除行）→ 直接在期望位置插入
    if (oldLines.length === 0) {
      return Math.min(Math.max(0, expectedStart), fileLines.length);
    }

    // 1. 优先在 expectedStart 位置精确匹配
    if (this.matchAt(fileLines, oldLines, expectedStart)) {
      return expectedStart;
    }

    // 2. fuzzy matching：在 [expectedStart - tolerance, expectedStart + tolerance] 范围内查找
    for (let offset = 1; offset <= this.fuzzyTolerance; offset++) {
      // 先尝试向后偏移
      const afterPos = expectedStart + offset;
      if (this.matchAt(fileLines, oldLines, afterPos)) {
        return afterPos;
      }
      // 再尝试向前偏移
      const beforePos = expectedStart - offset;
      if (beforePos >= 0 && this.matchAt(fileLines, oldLines, beforePos)) {
        return beforePos;
      }
    }

    // 3. 全局兜底：在文件中查找首个匹配位置
    for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
      if (this.matchAt(fileLines, oldLines, i)) {
        return i;
      }
    }

    return -1;
  }

  /**
   * 检查 fileLines 中从位置 pos 开始是否匹配 oldLines
   *
   * @param fileLines 原文件按行分割的数组
   * @param oldLines hunk 中需要匹配的旧内容行
   * @param pos 起始位置（0-based）
   * @returns true 表示匹配；false 表示不匹配
   */
  private matchAt(fileLines: string[], oldLines: string[], pos: number): boolean {
    if (pos < 0 || pos + oldLines.length > fileLines.length) {
      return false;
    }
    for (let i = 0; i < oldLines.length; i++) {
      // 去除首尾空白后比较（容错：忽略行尾空格差异）
      if (fileLines[pos + i].trim() !== oldLines[i].trim()) {
        return false;
      }
    }
    return true;
  }
}

/**
 * Hunk 内部表示
 */
interface Hunk {
  /** 旧文件起始行号（1-based） */
  oldStart: number;
  /** 旧文件行数 */
  oldCount: number;
  /** 新文件起始行号（1-based） */
  newStart: number;
  /** 新文件行数 */
  newCount: number;
  /** hunk 内容行列表 */
  lines: ReadonlyArray<HunkLine>;
}

/**
 * Hunk 内容行内部表示
 */
interface HunkLine {
  /** 行类型：context（上下文）/ remove（删除）/ add（增加） */
  type: "context" | "remove" | "add";
  /** 行内容（去除前缀后的） */
  content: string;
}

// ============================================================================
// FixLoop 类
// ============================================================================

/**
 * FIX 回灌循环
 *
 * 对应 EAG-P2 批次 9 设计 §4.6.3 FixLoop：
 * 基于 STRICT 评估报告，调用 LLM 生成修复 patch，应用 patch 后重新评估，
 * 多轮循环直到通过或达上限。
 *
 * 使用方式：
 * ```typescript
 * const evaluator = new StrictEvaluator();
 * const applier = new UnifiedDiffApplier();
 * const fixLoop = new FixLoop(evaluator, applier);
 * const result = await fixLoop.run({
 *   originalFiles: filledFiles,
 *   evaluationReport: strictReport,
 *   context: codingContext,
 *   llmClient: new InMemoryLLMClient(),
 *   maxRounds: 3,
 * });
 * // result.finalReport.verdict === "pass" 表示修复成功
 * // result.rounds 含各轮记录
 * ```
 *
 * 不可变优先：
 * - 构造时注入的 evaluator / patchApplier 使用 readonly 包裹
 * - run() 返回的 FixLoopResult 通过 Object.freeze 冻结
 * - 各轮 FixRoundRecord 通过 Object.freeze 冻结
 */
export class FixLoop {
  /** STRICT 评估器实例（贯穿 Phase B → FIX 全流程，状态一致） */
  private readonly evaluator: StrictEvaluator;
  /** Patch 应用器（默认 UnifiedDiffApplier） */
  private readonly patchApplier: PatchApplier;
  /** 日志回调（可选，用于输出调试信息） */
  private readonly logger?: LogCallback;

  /**
   * 初始化 FIX 循环
   *
   * @param evaluator STRICT 评估器实例（由调用方注入，复用同一实例贯穿 Phase B → FIX）
   * @param patchApplier Patch 应用器（默认 new UnifiedDiffApplier()）
   * @param logger 日志回调（可选）
   */
  constructor(evaluator: StrictEvaluator, patchApplier: PatchApplier = new UnifiedDiffApplier(), logger?: LogCallback) {
    this.evaluator = evaluator;
    this.patchApplier = patchApplier;
    this.logger = logger;
  }

  /**
   * 执行 FIX 回灌循环
   *
   * 算法（对齐 §4.6.3）：
   * ```
   * for round in 1..maxRounds:
   *   1. 装配 FIX prompt（原代码 + 评估报告 + 违规项 + 前 2 轮失败摘要）
   *   2. 调用 LLM 生成 unified diff
   *   3. 应用 diff 到原文件（UnifiedDiffApplier）
   *   4. 重新评估（调用 StrictEvaluator.evaluate）
   *   5. 记录 FixRoundRecord
   *   6. 若 verdict=pass → 返回成功
   *   7. 若 verdict=fix 且 round < maxRounds → 继续下一轮
   *   8. 若 round = maxRounds → 返回 fix-exhausted
   *   9. 若同一红线连续 2 轮 violated → 强制 HUMAN_CHECKPOINT
   * ```
   *
   * @param request FIX 回灌请求
   * @returns FIX 回灌产出（含修复后文件 / 各轮记录 / 最终报告 / 调用统计 / 耗时）
   * @throws {FixLoopError} 请求整体非法或不可恢复错误时抛出
   */
  async run(request: Readonly<FixLoopRequest>): Promise<FixLoopResult> {
    const startTime = Date.now();
    this.logger?.("FixLoop.run 启动", "info");

    // 步骤 1：校验请求字段合法性
    this.validateRequest(request);

    // 步骤 2：初始化状态变量
    const maxRounds = request.maxRounds > 0 ? request.maxRounds : DEFAULT_MAX_ROUNDS;
    const redlines = this.extractRedlinesFromContext(request.context);
    let currentFiles: GeneratedFile[] = [...request.originalFiles];
    let currentReport: EvaluationReport = request.evaluationReport as EvaluationReport;
    const rounds: FixRoundRecord[] = [];
    let totalLlmCallCount = 0;

    // 步骤 3：FIX 循环
    for (let round = 1; round <= maxRounds; round++) {
      this.logger?.(`FixLoop 第 ${round}/${maxRounds} 轮启动`, "info");

      // 3a. 装配 FIX prompt（含前 N 轮失败摘要）
      const previousFailures = rounds.slice(-FIX_WINDOW_SIZE);
      const { systemPrompt, userPrompt } = this.assembleFixPrompt(currentFiles, currentReport, previousFailures);

      // 3b. 调用 LLM 生成 unified diff
      let patch: string;
      try {
        patch = await this.callLlmForPatch(request.llmClient, systemPrompt, userPrompt);
        totalLlmCallCount++;
      } catch (e) {
        // LLM 调用失败 → 记录本轮失败 + 终止循环
        this.logger?.(`FixLoop 第 ${round} 轮 LLM 调用失败：${e instanceof Error ? e.message : String(e)}`, "error");
        const failedRecord = Object.freeze({
          round,
          inputReport: currentReport,
          patch: "",
          outputReport: currentReport,
          passed: false,
        }) as FixRoundRecord;
        rounds.push(failedRecord);
        // 终止循环，返回当前结果
        return this.buildResult(currentFiles, rounds, currentReport, totalLlmCallCount, startTime);
      }

      // 3c. 应用 diff 到原文件
      let patchedFiles: ReadonlyArray<GeneratedFile>;
      try {
        patchedFiles = this.patchApplier.apply(currentFiles, patch);
      } catch (e) {
        // patch 应用失败 → 记录本轮失败 + 进入下一轮（不终止）
        const errorMsg = e instanceof Error ? e.message : String(e);
        this.logger?.(`FixLoop 第 ${round} 轮 patch 应用失败：${errorMsg}`, "warn");
        // 用原文件继续评估（不更新 currentFiles）
        patchedFiles = currentFiles;
      }

      // 3d. 重新评估（调用 StrictEvaluator）
      let newReport: EvaluationReport;
      try {
        newReport = await this.evaluateFiles(patchedFiles, redlines, request.context, round);
      } catch (e) {
        // 评估器调用失败 → 记录本轮失败 + 终止循环
        const errorMsg = e instanceof Error ? e.message : String(e);
        this.logger?.(`FixLoop 第 ${round} 轮评估器调用失败：${errorMsg}`, "error");
        const failedRecord = Object.freeze({
          round,
          inputReport: currentReport,
          patch,
          outputReport: currentReport,
          passed: false,
        }) as FixRoundRecord;
        rounds.push(failedRecord);
        return this.buildResult(currentFiles, rounds, currentReport, totalLlmCallCount, startTime);
      }

      // 3e. 记录本轮 FixRoundRecord
      const passed = newReport.verdict === "pass";
      const roundRecord = Object.freeze({
        round,
        inputReport: currentReport,
        patch,
        outputReport: newReport,
        passed,
      }) as FixRoundRecord;
      rounds.push(roundRecord);

      // 更新 currentFiles 与 currentReport
      currentFiles = [...patchedFiles];
      currentReport = newReport;

      this.logger?.(
        `FixLoop 第 ${round} 轮完成：verdict=${newReport.verdict}，` +
          `blocker=${newReport.blockerCount}/major=${newReport.majorCount}/warning=${newReport.warningCount}`,
        passed ? "info" : "warn"
      );

      // 3f. 若 verdict=pass → 返回成功
      if (passed) {
        return this.buildResult(currentFiles, rounds, newReport, totalLlmCallCount, startTime);
      }

      // 3g. 检测同一红线连续违反上限（§7 R3 风险缓解）
      if (hasConsecutiveViolationExceeded(rounds)) {
        this.logger?.(
          `FixLoop 检测到同一红线连续 ${CONSECUTIVE_VIOLATION_LIMIT} 轮 violated，强制 HUMAN_CHECKPOINT`,
          "warn"
        );
        // 强制终止循环，返回当前结果（finalReport.verdict 应为 fix 或 human_checkpoint）
        return this.buildResult(currentFiles, rounds, newReport, totalLlmCallCount, startTime);
      }

      // 3h. 若 round = maxRounds → 返回 fix-exhausted
      if (round === maxRounds) {
        this.logger?.(`FixLoop 已达 ${maxRounds} 轮上限，返回 fix-exhausted`, "warn");
        return this.buildResult(currentFiles, rounds, newReport, totalLlmCallCount, startTime);
      }

      // 3i. 继续下一轮
    }

    // 步骤 4：循环结束（理论上不会到达，maxRounds 轮内必定 return）
    return this.buildResult(currentFiles, rounds, currentReport, totalLlmCallCount, startTime);
  }

  // ========================================================================
  // 私有辅助方法
  // ========================================================================

  /**
   * 校验 FixLoopRequest 字段合法性
   *
   * @param request 待校验请求
   * @throws {FixLoopError} 任一字段非法时抛出
   */
  private validateRequest(request: Readonly<FixLoopRequest>): void {
    if (!Array.isArray(request.originalFiles) || request.originalFiles.length === 0) {
      throw new FixLoopError("invalid-request", "originalFiles 必须为非空数组");
    }
    if (!request.evaluationReport || !request.evaluationReport.verdict) {
      throw new FixLoopError("invalid-request", "evaluationReport 必须含 verdict 字段");
    }
    if (!request.context || !request.context.taskCard) {
      throw new FixLoopError("invalid-request", "context 必须含 taskCard 字段");
    }
    if (!request.llmClient || typeof request.llmClient.createMessage !== "function") {
      throw new FixLoopError("invalid-request", "llmClient 必须实现 LLMClient 接口");
    }
    if (typeof request.maxRounds !== "number" || request.maxRounds < 1) {
      throw new FixLoopError("invalid-request", "maxRounds 必须 ≥ 1");
    }
  }

  /**
   * 从 CodingContext 中提取红线清单
   *
   * FIX 阶段评估使用与 Phase B 相同的红线清单（企业红线 + TCS 红线）。
   * RLIS 规则的 severity 在 STRICT 评估时已通过 enterpriseRedlines 体现，此处不再注入。
   *
   * @param context CODING Loop 上下文
   * @returns 合并后的红线清单
   */
  private extractRedlinesFromContext(context: Readonly<CodingContext>): ReadonlyArray<RedlineDefinition> {
    const redlines: RedlineDefinition[] = [...context.enterpriseRedlines];
    // 合并 TCS 红线
    for (const spec of context.tcsSpecs) {
      for (const rl of spec.redlines) {
        // 去重（按 id）
        if (!redlines.find((r) => r.id === rl.id)) {
          redlines.push(rl);
        }
      }
    }
    return Object.freeze(redlines) as ReadonlyArray<RedlineDefinition>;
  }

  /**
   * 装配 FIX prompt（对齐 §4.6.4）
   *
   * System 消息：
   * - 角色：你是代码修复专家，依据 STRICT 评估报告修复违规
   * - 红线清单（含修复建议模板）
   * - 输出格式：unified diff
   *
   * User 消息：
   * - 上一轮评估报告（违规项 + 严重级别 + 修复建议）
   * - 当前代码内容
   * - 前 2 轮失败摘要（避免重复犯错）
   * - 输出 diff 格式约束
   *
   * @param files 当前代码文件列表
   * @param report 当前评估报告
   * @param previousFailures 前 N 轮失败记录
   * @returns systemPrompt + userPrompt
   */
  private assembleFixPrompt(
    files: ReadonlyArray<GeneratedFile>,
    report: Readonly<EvaluationReport>,
    previousFailures: ReadonlyArray<FixRoundRecord>
  ): { systemPrompt: string; userPrompt: string } {
    // ============================================================
    // System Prompt 装配
    // ============================================================
    const systemParts: string[] = [];

    // 1. 角色定义
    systemParts.push(
      "你是一名代码修复专家，依据 STRICT 评估报告修复违规项。",
      "你的职责是生成 unified diff 格式的修复 patch，应用后使所有红线通过。",
      "严禁修改未违规的代码，仅生成最小必要的修复 diff。",
      "严禁使用 mock / 占位 / 简化实现，所有修复必须真实解决违规。",
      ""
    );

    // 2. 输出格式约束（unified diff）
    systemParts.push("## 输出格式约束");
    systemParts.push("你必须返回 unified diff 格式的 patch，格式如下：");
    systemParts.push("```diff");
    systemParts.push("--- a/<文件相对路径>");
    systemParts.push("+++ b/<文件相对路径>");
    systemParts.push("@@ -<旧行号>,<旧行数> +<新行号>,<新行数> @@");
    systemParts.push(" 上下文行（前缀空格）");
    systemParts.push("-删除行（前缀 -）");
    systemParts.push("+增加行（前缀 +）");
    systemParts.push("```");
    systemParts.push("- 严禁返回 diff 外的内容（直接返回 unified diff）");
    systemParts.push("- 每个 hunk 必须含 @@ 头与至少 1 行内容");
    systemParts.push("");

    // 3. 红线清单与修复建议模板
    systemParts.push("## 红线清单与修复建议模板");
    for (const result of report.redlineResults) {
      if (result.status === "violated") {
        systemParts.push(`### ${result.redlineId}（违规）`);
        for (const v of result.violations) {
          const location = v.line ? `${v.filePath}:${v.line}` : v.filePath;
          systemParts.push(`- 位置：${location}`);
          systemParts.push(`  描述：${v.description}`);
          systemParts.push(`  修复建议：${v.fixSuggestion}`);
        }
      }
    }

    const systemPrompt = systemParts.join("\n");

    // ============================================================
    // User Prompt 装配
    // ============================================================
    const userParts: string[] = [];

    // 1. 当前评估报告摘要
    userParts.push("## 当前评估报告");
    userParts.push(`- verdict：${report.verdict}`);
    userParts.push(`- blocker 违规：${report.blockerCount}`);
    userParts.push(`- major 违规：${report.majorCount}`);
    userParts.push(`- warning 违规：${report.warningCount}`);
    if (report.fixSuggestions && report.fixSuggestions.length > 0) {
      userParts.push("- 修复建议汇总：");
      for (const s of report.fixSuggestions) {
        userParts.push(`  - ${s}`);
      }
    }
    userParts.push("");

    // 2. 当前代码内容
    userParts.push("## 当前代码内容");
    for (const file of files) {
      userParts.push(`### 文件：${file.relativePath}`);
      userParts.push("```typescript");
      userParts.push(file.content);
      userParts.push("```");
      userParts.push("");
    }

    // 3. 前 2 轮失败摘要（避免重复犯错）
    if (previousFailures.length > 0) {
      userParts.push("## 前几轮失败摘要（避免重复犯错）");
      for (const failure of previousFailures) {
        userParts.push(`### 第 ${failure.round} 轮`);
        userParts.push(`- input verdict：${failure.inputReport.verdict}`);
        userParts.push(`- output verdict：${failure.outputReport.verdict}`);
        // 提取违规红线 ID
        const violatedIds = extractViolatedRedlineIds(failure.outputReport);
        if (violatedIds.length > 0) {
          userParts.push(`- 违规红线：${violatedIds.join(", ")}`);
        }
        // 截取 patch 前 500 字符（避免 token 膨胀）
        if (failure.patch) {
          const patchSummary = failure.patch.length > 500 ? failure.patch.slice(0, 500) + "..." : failure.patch;
          userParts.push("- 已尝试 patch（前 500 字符）：");
          userParts.push("```diff");
          userParts.push(patchSummary);
          userParts.push("```");
        }
        userParts.push("");
      }
    }

    // 4. 输出 diff 格式约束（再次强调）
    userParts.push("## 输出要求");
    userParts.push("请返回 unified diff 格式的 patch，修复上述所有违规项。");
    userParts.push("严禁返回 diff 外的任何内容（直接返回 ```diff ... ``` 块）。");

    const userPrompt = userParts.join("\n");

    return { systemPrompt, userPrompt };
  }

  /**
   * 调用 LLM 生成 unified diff patch
   *
   * @param llmClient LLM 客户端
   * @param systemPrompt System 提示词
   * @param userPrompt User 提示词
   * @returns LLM 生成的 unified diff 字符串
   * @throws {FixLoopError} LLM 调用失败时抛出
   */
  private async callLlmForPatch(llmClient: LLMClient, systemPrompt: string, userPrompt: string): Promise<string> {
    const llmRequest: LLMRequest = {
      messages: [buildMessage("system", systemPrompt), buildMessage("user", userPrompt)],
      thinkingEnabled: false,
      maxTokens: MAX_TOKENS_PER_LLM_CALL,
      temperature: LLM_TEMPERATURE,
      signal: null,
    };

    let response: LLMResponse;
    try {
      response = await llmClient.createMessage(llmRequest);
    } catch (e) {
      throw new FixLoopError("llm-call-failed", `LLM 调用异常：${e instanceof Error ? e.message : String(e)}`);
    }

    // 从 LLM 响应中提取 unified diff
    return this.extractDiffFromResponse(response.content);
  }

  /**
   * 从 LLM 响应中提取 unified diff
   *
   * 算法：
   * 1. 若响应含 ```diff ... ``` 代码块 → 提取代码块内容
   * 2. 若响应含 ```patch ... ``` 代码块 → 提取代码块内容
   * 3. 若响应以 --- a/ 开头 → 直接返回响应内容
   * 4. 否则 → 提取响应中所有 --- a/ 开头到下一个空行之间的内容
   *
   * @param content LLM 响应内容
   * @returns 提取的 unified diff 字符串
   * @throws {FixLoopError} 响应中无有效 diff 内容时抛出
   */
  private extractDiffFromResponse(content: string): string {
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new FixLoopError("llm-call-failed", "LLM 响应为空，无法提取 diff");
    }

    // 1. 尝试提取 ```diff 代码块
    const diffBlockMatch = content.match(/```(?:diff|patch)\s*\n([\s\S]*?)\n```/);
    if (diffBlockMatch && diffBlockMatch[1]) {
      return diffBlockMatch[1].trim();
    }

    // 2. 若响应以 --- a/ 开头 → 直接返回响应内容
    if (/^\s*---\s+[ab]\//m.test(content)) {
      return content.trim();
    }

    // 3. 提取响应中所有 --- a/ 开头到下一个空行之间的内容
    const match = content.match(/(---\s+[ab]\/[\s\S]*?)(?=\n\s*\n|\n```|$)/);
    if (match && match[1]) {
      return match[1].trim();
    }

    // 4. 无有效 diff 内容 → 抛错
    throw new FixLoopError(
      "llm-call-failed",
      `LLM 响应中无有效 unified diff 内容（响应前 200 字符：${content.slice(0, 200)}）`
    );
  }

  /**
   * 调用评估器评估文件
   *
   * @param files 待评估的文件列表
   * @param redlines 红线清单
   * @param context CODING Loop 上下文
   * @param round 当前轮次
   * @returns 评估报告
   * @throws {FixLoopError} 评估器调用失败时抛出
   */
  private async evaluateFiles(
    files: ReadonlyArray<GeneratedFile>,
    redlines: ReadonlyArray<RedlineDefinition>,
    context: Readonly<CodingContext>,
    round: number
  ): Promise<EvaluationReport> {
    // 构造 EvaluationContext
    const evaluationContext: EvaluationContext = {
      loopType: "coding",
      iteration: round,
      taskId: context.taskCard.id,
      artifactPaths: files.map((f) => f.relativePath),
      inlineArtifacts: files.map((f) => ({ path: f.relativePath, content: f.content })),
      mode: "strict",
    };

    try {
      return await this.evaluator.evaluate(evaluationContext, redlines);
    } catch (e) {
      throw new FixLoopError("evaluator-error", `评估器调用异常：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 构建 FixLoopResult
   *
   * @param fixedFiles 修复后的文件列表
   * @param rounds 各轮记录
   * @param finalReport 最终评估报告
   * @param totalLlmCallCount 总 LLM 调用次数
   * @param startTime 开始时间戳
   * @returns 冻结的 FixLoopResult
   */
  private buildResult(
    fixedFiles: GeneratedFile[],
    rounds: FixRoundRecord[],
    finalReport: EvaluationReport,
    totalLlmCallCount: number,
    startTime: number
  ): FixLoopResult {
    const durationMs = Date.now() - startTime;
    return Object.freeze({
      fixedFiles: Object.freeze([...fixedFiles]) as ReadonlyArray<GeneratedFile>,
      rounds: Object.freeze([...rounds]) as ReadonlyArray<FixRoundRecord>,
      finalReport,
      totalLlmCallCount,
      durationMs,
    }) as FixLoopResult;
  }
}
