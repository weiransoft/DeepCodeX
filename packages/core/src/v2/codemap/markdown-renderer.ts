/**
 * CodeMap Markdown 渲染器（CM-13 主模块）
 *
 * 将 CodeMapGenerator 产出的 CodeMap 对象渲染为 Markdown 格式的人类可读文档。
 *
 * 设计依据：
 * - V2 测试方案 §2.5 CM-13（CodeMap Markdown 输出）
 * - 架构师审查报告（2026-07-21）：
 *   R1 纯函数实现 `renderCodeMapAsMarkdown(codeMap: CodeMap): string`，无副作用
 *   R2 与 memory-commands.ts 输出风格一致（多行文本、分组、缩进）
 *   R3 空数据优雅降级（空数组显示"无"，不报错）
 *
 * 渲染结构（9 个章节）：
 *   1. 标题（项目名 + 生成时间）
 *   2. 项目元信息（根目录 / 架构 / 语言 / 技术栈）
 *   3. 统计信息（totalFiles / parsedFiles / failedFiles / ... / generationTimeMs）
 *   4. 模块列表（ModuleInfo[]：名称 / 路径 / 描述 / 依赖 / 导出 / 文件）
 *   5. 文件列表（FileInfo[]：路径 / 语言 / 行数 / 解析状态 / 类 / 函数）
 *   6. 依赖关系图（DependencyEdge[]：source → target / 类型 / 解析状态）
 *   7. 调用关系图（CallEdge[]：caller → callee / 文件:行号）
 *   8. 循环依赖（cycles[][]：每条环路径展开为路径链）
 *   9. 失败文件清单（parseStatus=failed 的 FileInfo，便于快速定位）
 *
 * @module v2/codemap/markdown-renderer
 */

import type {
  CodeMap,
  ProjectInfo,
  TechStackInfo,
  CodeMapStats,
  ModuleInfo,
  FileInfo,
  DependencyEdge,
  CallEdge,
} from "./generator";

// ============================================================================
// 主函数：renderCodeMapAsMarkdown
// ============================================================================

/**
 * 将 CodeMap 渲染为 Markdown 字符串
 *
 * 纯函数实现：输入 CodeMap 对象，输出多行 Markdown 字符串。
 * 不修改输入对象，不产生副作用，不读取文件系统。
 *
 * @param codeMap 完整代码地图对象
 * @returns Markdown 格式的人类可读文档（多行字符串）
 */
export function renderCodeMapAsMarkdown(codeMap: CodeMap): string {
  const lines: string[] = [];

  // 章节 1：标题
  lines.push(...renderHeader(codeMap));

  // 章节 2：项目元信息
  lines.push(...renderProjectInfo(codeMap.project));

  // 章节 3：统计信息
  lines.push(...renderStats(codeMap.stats));

  // 章节 4：模块列表
  lines.push(...renderModules(codeMap.modules));

  // 章节 5：文件列表
  lines.push(...renderFiles(codeMap.files));

  // 章节 6：依赖关系图
  lines.push(...renderDependencyGraph(codeMap.dependencyGraph));

  // 章节 7：调用关系图
  lines.push(...renderCallGraph(codeMap.callGraph));

  // 章节 8：循环依赖
  lines.push(...renderCycles(codeMap.cycles));

  // 章节 9：失败文件清单（架构师审查 R3：便于快速定位解析失败）
  lines.push(...renderFailedFiles(codeMap.files));

  return lines.join("\n").trimEnd() + "\n";
}

// ============================================================================
// 章节 1：标题
// ============================================================================

/**
 * 渲染 Markdown 标题章节
 *
 * @param codeMap 完整代码地图对象
 * @returns Markdown 行数组
 */
function renderHeader(codeMap: CodeMap): string[] {
  const lines: string[] = [];
  lines.push(`# 代码地图：${codeMap.project.name}`);
  lines.push("");
  lines.push(`> 生成时间：${codeMap.generatedAt}`);
  lines.push("");
  return lines;
}

// ============================================================================
// 章节 2：项目元信息
// ============================================================================

/**
 * 渲染项目元信息章节
 *
 * 包含项目名、根目录、架构类型、支持语言、技术栈（框架/构建工具/包管理器/测试框架/linter）。
 *
 * @param project 项目信息
 * @returns Markdown 行数组
 */
function renderProjectInfo(project: ProjectInfo): string[] {
  const lines: string[] = [];
  lines.push("## 项目信息");
  lines.push("");
  lines.push(`- **名称**：${project.name}`);
  lines.push(`- **根目录**：${project.root}`);
  lines.push(`- **架构类型**：${project.architecture}`);
  lines.push(`- **支持语言**：${project.languages.join(", ") || "（未识别）"}`);
  lines.push("");

  // 技术栈子章节
  lines.push(...renderTechStack(project.techStack));

  return lines;
}

/**
 * 渲染技术栈子章节
 *
 * @param techStack 技术栈信息
 * @returns Markdown 行数组
 */
function renderTechStack(techStack: TechStackInfo): string[] {
  const lines: string[] = [];
  lines.push("### 技术栈");
  lines.push("");
  lines.push(`- **框架**：${techStack.frameworks.join(", ") || "（未识别）"}`);
  lines.push(`- **构建工具**：${techStack.buildTools.join(", ") || "（未识别）"}`);
  lines.push(`- **包管理器**：${techStack.packageManagers.join(", ") || "（未识别）"}`);
  lines.push(`- **测试框架**：${techStack.testFrameworks.join(", ") || "（未识别）"}`);
  lines.push(`- **Linter**：${techStack.linters.join(", ") || "（未识别）"}`);
  lines.push("");
  return lines;
}

// ============================================================================
// 章节 3：统计信息
// ============================================================================

/**
 * 渲染统计信息章节
 *
 * @param stats CodeMap 统计信息
 * @returns Markdown 行数组
 */
function renderStats(stats: CodeMapStats): string[] {
  const lines: string[] = [];
  lines.push("## 统计信息");
  lines.push("");
  lines.push("| 指标 | 数值 |");
  lines.push("| --- | --- |");
  lines.push(`| 文件总数 | ${stats.totalFiles} |`);
  lines.push(`| 成功解析 | ${stats.parsedFiles} |`);
  lines.push(`| 解析失败 | ${stats.failedFiles} |`);
  lines.push(`| 类总数 | ${stats.totalClasses} |`);
  lines.push(`| 函数总数 | ${stats.totalFunctions} |`);
  lines.push(`| 依赖关系总数 | ${stats.totalDependencies} |`);
  lines.push(`| 循环依赖数 | ${stats.cyclesDetected} |`);
  lines.push(`| 未解析依赖数 | ${stats.unresolvedDeps} |`);
  lines.push(`| 生成耗时（ms） | ${stats.generationTimeMs} |`);
  lines.push("");
  return lines;
}

// ============================================================================
// 章节 4：模块列表
// ============================================================================

/**
 * 渲染模块列表章节
 *
 * @param modules 模块信息数组
 * @returns Markdown 行数组
 */
function renderModules(modules: ModuleInfo[]): string[] {
  const lines: string[] = [];
  lines.push("## 模块列表");
  lines.push("");

  if (modules.length === 0) {
    lines.push("（无模块）");
    lines.push("");
    return lines;
  }

  for (const mod of modules) {
    lines.push(`### ${mod.name}`);
    lines.push("");
    lines.push(`- **路径**：${mod.path}`);
    lines.push(`- **描述**：${mod.description || "（无描述）"}`);
    lines.push(`- **依赖**：${mod.dependencies.length > 0 ? mod.dependencies.join(", ") : "（无）"}`);
    lines.push(`- **导出**：${mod.exports.length > 0 ? mod.exports.join(", ") : "（无）"}`);
    lines.push(`- **文件数**：${mod.files.length}`);
    // 文件列表折叠展示（避免过长）
    if (mod.files.length > 0) {
      lines.push("");
      lines.push("<details><summary>文件清单</summary>");
      lines.push("");
      lines.push("```");
      for (const f of mod.files) {
        lines.push(f);
      }
      lines.push("```");
      lines.push("");
      lines.push("</details>");
    }
    lines.push("");
  }

  return lines;
}

// ============================================================================
// 章节 5：文件列表
// ============================================================================

/**
 * 渲染文件列表章节
 *
 * 表格形式展示每个文件的路径、语言、行数、解析状态、类数、函数数。
 *
 * @param files 文件信息数组
 * @returns Markdown 行数组
 */
function renderFiles(files: FileInfo[]): string[] {
  const lines: string[] = [];
  lines.push("## 文件列表");
  lines.push("");

  if (files.length === 0) {
    lines.push("（无文件）");
    lines.push("");
    return lines;
  }

  // 表格头部
  lines.push("| 路径 | 语言 | 行数 | 解析状态 | 类数 | 函数数 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");

  for (const file of files) {
    // 转义 Markdown 表格中的管道符（防止破坏表格结构）
    const safePath = escapeMarkdownTable(file.path);
    lines.push(
      `| ${safePath} | ${file.language} | ${file.lines} | ${file.parseStatus} | ${file.classes.length} | ${file.functions.length} |`
    );
  }

  lines.push("");
  return lines;
}

// ============================================================================
// 章节 6：依赖关系图
// ============================================================================

/**
 * 渲染依赖关系图章节
 *
 * @param dependencies 依赖关系边数组
 * @returns Markdown 行数组
 */
function renderDependencyGraph(dependencies: DependencyEdge[]): string[] {
  const lines: string[] = [];
  lines.push("## 依赖关系图");
  lines.push("");

  if (dependencies.length === 0) {
    lines.push("（无依赖关系）");
    lines.push("");
    return lines;
  }

  lines.push("| 源文件 | 目标文件 | 类型 | 已解析 |");
  lines.push("| --- | --- | --- | --- |");

  for (const dep of dependencies) {
    const resolvedMark = dep.resolved ? "✅" : "❌";
    lines.push(
      `| ${escapeMarkdownTable(dep.source)} | ${escapeMarkdownTable(dep.target)} | ${dep.type} | ${resolvedMark} |`
    );
  }

  lines.push("");
  return lines;
}

// ============================================================================
// 章节 7：调用关系图
// ============================================================================

/**
 * 渲染调用关系图章节
 *
 * @param callGraph 调用关系边数组
 * @returns Markdown 行数组
 */
function renderCallGraph(callGraph: CallEdge[]): string[] {
  const lines: string[] = [];
  lines.push("## 调用关系图");
  lines.push("");

  if (callGraph.length === 0) {
    lines.push("（无调用关系）");
    lines.push("");
    return lines;
  }

  lines.push("| 调用方 | 被调用方 | 文件 | 行号 |");
  lines.push("| --- | --- | --- | --- |");

  for (const call of callGraph) {
    lines.push(
      `| ${escapeMarkdownTable(call.caller)} | ${escapeMarkdownTable(call.callee)} | ${escapeMarkdownTable(call.file)} | ${call.line} |`
    );
  }

  lines.push("");
  return lines;
}

// ============================================================================
// 章节 8：循环依赖
// ============================================================================

/**
 * 渲染循环依赖章节
 *
 * 每条循环依赖展开为路径链：A → B → C → A
 *
 * @param cycles 循环依赖路径数组（每条为构成环的文件路径数组）
 * @returns Markdown 行数组
 */
function renderCycles(cycles: string[][]): string[] {
  const lines: string[] = [];
  lines.push("## 循环依赖");
  lines.push("");

  if (cycles.length === 0) {
    lines.push("（无循环依赖）");
    lines.push("");
    return lines;
  }

  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i]!;
    // 路径链：A → B → C → A（首尾相同，形成闭环）
    const chain = [...cycle, cycle[0]].join(" → ");
    lines.push(`### 循环 #${i + 1}`);
    lines.push("");
    lines.push("```");
    lines.push(chain);
    lines.push("```");
    lines.push("");
  }

  return lines;
}

// ============================================================================
// 章节 9：失败文件清单
// ============================================================================

/**
 * 渲染失败文件清单章节（架构师审查 R3：便于快速定位）
 *
 * 仅展示 parseStatus=failed 的文件，包含路径、语言、行数。
 *
 * @param files 文件信息数组
 * @returns Markdown 行数组
 */
function renderFailedFiles(files: FileInfo[]): string[] {
  const lines: string[] = [];
  lines.push("## 失败文件清单");
  lines.push("");

  const failedFiles = files.filter((f) => f.parseStatus === "failed");

  if (failedFiles.length === 0) {
    lines.push("（无失败文件）");
    lines.push("");
    return lines;
  }

  lines.push("| 路径 | 语言 | 行数 |");
  lines.push("| --- | --- | --- |");

  for (const file of failedFiles) {
    lines.push(`| ${escapeMarkdownTable(file.path)} | ${file.language} | ${file.lines} |`);
  }

  lines.push("");
  return lines;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 转义 Markdown 表格中的特殊字符（管道符）
 *
 * Markdown 表格使用 | 作为列分隔符，若文件路径中包含 |（罕见但可能），
 * 需转义为 \| 防止破坏表格结构。
 *
 * @param text 原始文本
 * @returns 转义后的文本
 */
function escapeMarkdownTable(text: string): string {
  return text.replace(/\|/g, "\\|");
}
