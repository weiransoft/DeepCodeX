/**
 * GitDiffAnalyzer：git diff 分析器（EAG-P3 批次 11 §8.4）
 *
 * 本模块实现 `GitDiffAnalyzer` 类，对应 EAG-P3 批次 11 设计 §8.4：
 * 通过真实调用 git diff 提取变更文件清单，为 BlastRadiusBfs 提供 sourceFiles 输入。
 *
 * 核心职责（对齐 §8.4 第 1923-1925 行）：
 * 1. 调用 `git diff --name-status <base>..<head>` 提取变更文件清单（status + filePath + oldFilePath）
 * 2. 调用 `git diff --numstat <base>..<head>` 提取变更行数统计（additions + deletions + filePath）
 * 3. 按 filePath 合并两个结果为 GitFileChange 列表
 *
 * 实现说明（架构师审查 B3-M8 修复 + macOS Apple Git 兼容性修复）：
 * - 使用 ES Module import 语法（`import { execFileSync } from "node:child_process";`）
 * - 不使用 CommonJS `require()`（项目是 TypeScript + ESM，require 违反模块规范）
 * - 分两次调用 git diff（不合并 --name-status 与 --numstat）：
 *   * macOS Apple Git 在合并选项时仅输出 name-status，丢失 numstat 数据
 *   * 设计文档 §8.4 职责描述明确分两次调用（第 1923-1925 行）
 *
 * P0 安全修复（docs/archive/PHASE2_SECURITY_FIX_PLAN_2026-07-31.md §P0-8）：
 * - 使用 `execFileSync` 以数组参数调用 git，避免启动 shell 解释器
 * - 对 `base` / `head` 做白名单校验，拒绝含 shell 元字符、路径穿越、绝对路径的非法 ref
 * - 不再使用字符串模板拼接命令
 *
 * Git diff 输出格式说明：
 * - `--name-status` 输出：
 *   * 普通修改：`M\t<filePath>`
 *   * 新增：`A\t<filePath>`
 *   * 删除：`D\t<filePath>`
 *   * 重命名：`R100\t<oldFilePath>\t<filePath>`（R 后跟相似度，含两个文件路径）
 *   * 复制：`C100\t<oldFilePath>\t<filePath>`（按 R 处理，type=renamed）
 * - `--numstat` 输出：
 *   * 普通文件：`<additions>\t<deletions>\t<filePath>`
 *   * 二进制文件：`-\t-\t<filePath>`（additions/deletions 用 0 兜底）
 *   * 重命名文件：`<additions>\t<deletions>\t<newFilePath>`（输出新路径，与 --name-status 的 filePath 一致）
 *
 * @module eag/testing/incremental/git-diff-analyzer
 */

import { execFileSync } from "node:child_process";
import type { GitChangeType, GitFileChange, DiffStat } from "./types";

// ============================================================================
// 常量
// ============================================================================

/**
 * execFileSync 调用的 maxBuffer 兜底值
 *
 * 默认 maxBuffer（1MB）对大型仓库可能不足，提升到 10MB 兜底。
 */
const EXEC_MAX_BUFFER: Readonly<number> = Object.freeze(10 * 1024 * 1024) as number;

/**
 * Git ref 允许字符集（用于分支名、tag、reflog 表达式等）。
 *
 * 允许的字符：字母、数字、下划线、点、@、花括号、^、~、/、连字符。
 * 显式禁止：空格、反斜杠、美元符号、反引号、分号、尖括号、双引号、单引号、
 * 感叹号等 shell 元字符或可能导致命令注入的字符。
 */
const GIT_REF_ALLOWED_PATTERN = /^[A-Za-z0-9_.@{}^~/-]+$/;

/**
 * 40 位或 64 位十六进制 commit SHA 正则。
 *
 * Git SHA-1 为 40 位；SHA-256 为 64 位。这里按 P0 修复方案要求严格匹配完整长度，
 * 避免接受任意短字符串导致误判。
 */
const GIT_SHA_PATTERN = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;

// ============================================================================
// GitDiffAnalyzer 类
// ============================================================================

/**
 * GitDiffAnalyzer：git diff 分析器
 *
 * 实现 §8.4 设计——通过真实调用 git diff 提取变更文件清单。
 *
 * 使用方式：
 * ```typescript
 * const analyzer = new GitDiffAnalyzer();
 * const changes = analyzer.analyze("/path/to/project", "HEAD~1", "HEAD");
 * for (const change of changes) {
 *   console.log(`${change.type}: ${change.filePath} (+${change.diffStat.additions} -${change.diffStat.deletions})`);
 * }
 * ```
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - analyze() 返回的 GitFileChange 列表通过 Object.freeze 冻结
 * - 每个 GitFileChange 对象本身也通过 Object.freeze 冻结
 * - DiffStat 字段同样冻结
 */
export class GitDiffAnalyzer {
  /**
   * 初始化 GitDiffAnalyzer
   *
   * GitDiffAnalyzer 不依赖外部服务（仅调用 git CLI），构造函数无参数。
   */
  constructor() {
    // 无外部依赖注入
  }

  /**
   * 分析 git diff，提取变更文件清单
   *
   * 算法（对齐 §8.4 第 1923-1925 行职责描述）：
   * 1. 校验 base / head 为合法 git ref，防止命令注入
   * 2. 调用 `git diff --name-status <base>..<head>` 提取 status + filePath + oldFilePath
   * 3. 调用 `git diff --numstat <base>..<head>` 提取 additions + deletions + filePath
   * 4. 按 filePath 合并两个结果，构造 GitFileChange 列表
   * 5. 返回 Object.freeze 冻结的 GitFileChange 列表
   *
   * 错误处理：
   * - execFileSync 抛出异常时（非 git 仓库 / base 或 head 不存在），向上抛出原始异常
   * - 任一命令输出为空字符串时返回空数组（无变更）
   * - 单行解析失败时跳过该行（不影响其他行）
   * - numstat 中找不到对应 filePath 时，additions/deletions 兜底为 0
   *
   * @param projectRoot 项目根目录（绝对路径，git 命令的 cwd）
   * @param base 基线提交（如 "HEAD~1" / "main" / commit SHA）
   * @param head 目标提交（默认 "HEAD"）
   * @returns GitFileChange 列表（已冻结，每个对象也冻结）
   * @throws {Error} 当 git 命令执行失败或 ref 校验失败时
   */
  public analyze(projectRoot: string, base: string, head: string = "HEAD"): ReadonlyArray<GitFileChange> {
    // P0 安全修复：先校验 ref，拒绝非法输入，避免注入到 execFileSync 参数中。
    validateGitRef(base);
    validateGitRef(head);

    // 1. 调用 git diff --name-status 提取 status + filePath + oldFilePath
    const nameStatusOutput: string = this.runGitDiff("--name-status", projectRoot, base, head);
    // 2. 调用 git diff --numstat 提取 additions + deletions + filePath
    const numstatOutput: string = this.runGitDiff("--numstat", projectRoot, base, head);

    // 3. 解析 numstat 输出为 Map<filePath, DiffStat>，便于后续按 filePath 查询
    const numstatMap: Map<string, DiffStat> = this.parseNumstatOutput(numstatOutput);

    // 4. 解析 name-status 输出，合并 numstat 数据，构造 GitFileChange 列表
    const changes: GitFileChange[] = [];
    const nameStatusLines: string[] = nameStatusOutput.split("\n").filter((line: string) => line.trim().length > 0);
    for (const line of nameStatusLines) {
      const change = this.parseNameStatusLine(line, numstatMap);
      if (change !== null) {
        changes.push(change);
      }
    }

    // 5. 返回冻结的 GitFileChange 列表
    return Object.freeze(changes);
  }

  /**
   * 执行 git diff 命令
   *
   * P0 安全修复：使用 execFileSync + 数组参数，避免 shell 解释器介入；
   * base / head 已在外层 `validateGitRef` 中校验，因此 `${base}..${head}` 范围
   * 表达式可直接作为最后一个参数传递。
   *
   * @param subCommand git diff 子选项（"--name-status" 或 "--numstat"）
   * @param projectRoot 项目根目录（git 命令的 cwd）
   * @param base 基线提交
   * @param head 目标提交
   * @returns git diff 输出（utf-8 字符串）
   * @throws {Error} 当 git 命令执行失败时
   */
  private runGitDiff(subCommand: string, projectRoot: string, base: string, head: string): string {
    return execFileSync("git", ["-c", "core.quotepath=false", "diff", subCommand, `${base}..${head}`], {
      cwd: projectRoot,
      encoding: "utf-8",
      maxBuffer: EXEC_MAX_BUFFER,
    });
  }

  /**
   * 解析 git diff --numstat 输出为 Map<filePath, DiffStat>
   *
   * numstat 输出格式（每行）：
   * - 普通文件：`<additions>\t<deletions>\t<filePath>`
   * - 二进制文件：`-\t-\t<filePath>`（additions/deletions 兜底为 0）
   * - 重命名文件：`<additions>\t<deletions>\t<newFilePath>`（输出新路径）
   *
   * @param output git diff --numstat 的完整输出
   * @returns Map<filePath, DiffStat>（filePath → 行数统计）
   */
  private parseNumstatOutput(output: string): Map<string, DiffStat> {
    const map: Map<string, DiffStat> = new Map<string, DiffStat>();
    const lines: string[] = output.split("\n").filter((line: string) => line.trim().length > 0);
    for (const line of lines) {
      const parts: string[] = line.split("\t");
      if (parts.length < 3) {
        // 格式异常，跳过该行
        continue;
      }
      const additions: number = this.parseNumstat(parts[0]);
      const deletions: number = this.parseNumstat(parts[1]);
      const filePath: string = parts[2];
      const diffStat: DiffStat = Object.freeze({
        additions,
        deletions,
      }) as DiffStat;
      map.set(filePath, diffStat);
    }
    return map;
  }

  /**
   * 解析 git diff --name-status 单行输出为 GitFileChange
   *
   * 行格式（按 Tab 分割）：
   * - 普通文件：`<status>\t<filePath>`
   * - renamed/copied：`<status>\t<oldFilePath>\t<filePath>`
   *
   * status 首字母映射：
   * - A → added
   * - M → modified
   * - D → deleted
   * - R → renamed（R 后跟相似度数字，如 R100）
   * - C → renamed（复制文件按 renamed 处理，含 oldFilePath）
   * - T → modified（类型变更，按 modified 处理）
   * - U → modified（未合并，按 modified 处理）
   *
   * numstat 合并：
   * - 通过 numstatMap 查询 filePath 对应的 DiffStat
   * - 若 numstatMap 中找不到，additions/deletions 兜底为 0
   *
   * @param line 单行 name-status 输出
   * @param numstatMap numstat 解析结果（Map<filePath, DiffStat>）
   * @returns GitFileChange 对象（已冻结）或 null（解析失败）
   */
  private parseNameStatusLine(line: string, numstatMap: Map<string, DiffStat>): GitFileChange | null {
    // 按 Tab 分割
    const parts: string[] = line.split("\t");
    if (parts.length < 2) {
      // 行格式不符合预期（至少 2 列：status + filePath）
      return null;
    }

    // 解析 status（首字母映射到 GitChangeType）
    const status: string = parts[0];
    const type: GitChangeType | null = this.parseStatus(status);
    if (type === null) {
      // 未知 status，跳过该行
      return null;
    }

    // 解析 filePath / oldFilePath
    // - 普通文件：parts[1] = filePath
    // - renamed/copied：parts[1] = oldFilePath, parts[2] = filePath
    let filePath: string;
    let oldFilePath: string | undefined;
    if (type === "renamed") {
      // renamed 需要两列：oldFilePath + filePath
      if (parts.length < 3) {
        // 格式异常（renamed 应有 3 列），降级处理：将 parts[1] 作为 filePath
        filePath = parts[1];
        oldFilePath = undefined;
      } else {
        oldFilePath = parts[1];
        filePath = parts[2];
      }
    } else {
      filePath = parts[1];
      oldFilePath = undefined;
    }

    // 从 numstatMap 查询 DiffStat（找不到时兜底为 0/0）
    const diffStat: DiffStat = numstatMap.get(filePath) ?? (Object.freeze({ additions: 0, deletions: 0 }) as DiffStat);

    // 构造并冻结 GitFileChange
    return Object.freeze({
      type,
      filePath,
      oldFilePath,
      diffStat,
    }) as GitFileChange;
  }

  /**
   * 解析 git diff status 为 GitChangeType
   *
   * status 可能的形式：
   * - "A" / "AM"（added + 未暂存修改）
   * - "M" / "MM"
   * - "D"
   * - "R100" / "R75"（相似度 100/75）
   * - "C100"（复制，相似度 100）
   * - "T"（类型变更）
   * - "U"（未合并）
   *
   * 映射规则：取首字母判定主类型，C 与 R 都按 renamed 处理（含 oldFilePath）。
   *
   * @param status git diff status 字符串
   * @returns GitChangeType 或 null（未知 status）
   */
  private parseStatus(status: string): GitChangeType | null {
    if (status.length === 0) {
      return null;
    }
    const firstChar: string = status[0];
    switch (firstChar) {
      case "A":
        return "added";
      case "M":
      case "T":
      case "U":
        return "modified";
      case "D":
        return "deleted";
      case "R":
      case "C":
        // R（rename）与 C（copy）都按 renamed 处理（含 oldFilePath）
        return "renamed";
      default:
        return null;
    }
  }

  /**
   * 解析 numstat 列为数字
   *
   * numstat 列可能的形式：
   * - 数字字符串："42" / "0"
   * - 二进制文件标记："-"（git 无法统计二进制文件行数）
   *
   * 二进制文件 "-" 兜底为 0。
   *
   * @param value numstat 列原始字符串
   * @returns 解析后的数字（解析失败时返回 0）
   */
  private parseNumstat(value: string): number {
    if (value === "-") {
      // 二进制文件，git 无法统计行数，兜底为 0
      return 0;
    }
    const num: number = parseInt(value, 10);
    return Number.isNaN(num) ? 0 : num;
  }
}

// ============================================================================
// 安全辅助函数
// ============================================================================

/**
 * 校验 git ref 是否合法。
 *
 * P0 安全修复：仅接受以下 ref 形式，拒绝任何可能触发命令注入或路径穿越的输入：
 * - "HEAD"
 * - 40 位或 64 位十六进制 commit SHA
 * - 分支名 / tag / reflog 表达式（由允许字符集定义）
 *
 * 显式拒绝：
 * - 空字符串、非字符串
 * - 以 "~" 开头的 home 目录展开
 * - 以 "/" 开头的绝对路径
 * - 以 "-" 开头的选项式参数
 * - 含空格、反斜杠、美元符号、反引号、分号、尖括号、双引号、单引号等字符
 *
 * @param ref 待校验的 git ref
 * @throws {Error} ref 不合法时抛出错误（错误信息不包含原始 ref）
 */
function validateGitRef(ref: string): void {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error("Git ref 不能为空");
  }

  if (ref === "HEAD") {
    return;
  }

  if (GIT_SHA_PATTERN.test(ref)) {
    return;
  }

  if (ref.startsWith("~")) {
    throw new Error("Git ref 不能以 ~ 开头（存在路径穿越风险）");
  }

  if (ref.startsWith("/")) {
    throw new Error("Git ref 不能以 / 开头（存在绝对路径注入风险）");
  }

  if (ref.startsWith("-")) {
    throw new Error("Git ref 不能以 - 开头（存在选项注入风险）");
  }

  if (!GIT_REF_ALLOWED_PATTERN.test(ref)) {
    throw new Error("Git ref 包含非法字符，存在命令注入风险");
  }
}
