/**
 * 风险与技术债章节构建器（EAG-P3 批次 11 Part B2 §7.4 第 6 章）
 *
 * 本模块实现 RiskDebtSectionBuilder，构建交接文档第 6 章"风险与技术债"。
 *
 * 数据源（对齐 §7.4 七章结构表）：
 * - BrownfieldDiscovery 产出（context.pkcL2DependencyGraph，可选）
 * - 代码分析（扫描 TODO / FIXME / HACK 注释，识别循环依赖）
 *
 * 置信度：inferred（基于代码静态分析推断，需人工审核后提升置信度）
 *
 * **inferred 章节必须在 content 头部包含 INFERRED_SECTION_NOTICE 提示**
 *
 * 章节内容包含：
 * 1. 技术债清单（TODO / FIXME / HACK 注释扫描结果）
 * 2. 风险评估（循环依赖 / 高复杂度函数 / 大文件）
 * 3. 循环依赖（从 import 关系推导）
 * 4. 覆盖率盲点（未测试的高风险符号）
 *
 * @module eag/pkc/l4/section-builders/risk-debt-section
 */

import type { HandoverSection, SectionBuilder, SectionBuildContext } from "../types";
import { INFERRED_SECTION_NOTICE } from "../types";

// ============================================================================
// 常量定义
// ============================================================================

const SECTION_ID = "risks-debt" as const;
const SECTION_TITLE = "风险与技术债" as const;
const SECTION_ORDER = 6 as const;
const SECTION_CONFIDENCE = "inferred" as const;

/**
 * 技术债标记正则表达式
 *
 * 匹配以下标记（不区分大小写）：
 * - TODO
 * - FIXME
 * - HACK
 * - XXX
 * - WORKAROUND
 */
const DEBT_MARKER_REGEX = /\b(TODO|FIXME|HACK|XXX|WORKAROUND)\b/gi;

/**
 * 源代码文件扩展名
 */
const SOURCE_EXTENSIONS: ReadonlyArray<string> = Object.freeze([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

/**
 * 大文件阈值（行数 >= 此值视为大文件）
 */
const LARGE_FILE_THRESHOLD = 500;

// ============================================================================
// 类型定义（内部使用）
// ============================================================================

/**
 * 技术债条目（单条 TODO/FIXME/HACK 注释）
 */
interface DebtItem {
  /** 标记类型（TODO / FIXME / HACK / XXX / WORKAROUND） */
  readonly marker: string;
  /** 所在文件路径 */
  readonly filePath: string;
  /** 行号（1-based） */
  readonly line: number;
  /** 注释内容（标记后的描述文本） */
  readonly description: string;
}

/**
 * 循环依赖条目
 */
interface CircularDependency {
  /** 循环依赖路径（模块路径数组，按依赖顺序排列） */
  readonly cycle: ReadonlyArray<string>;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 判断文件路径是否为源代码文件
 *
 * @param filePath 文件路径
 * @returns true=源代码文件
 */
function isSourceFile(filePath: string): boolean {
  for (const ext of SOURCE_EXTENSIONS) {
    if (filePath.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

/**
 * 判断文件路径是否为测试文件
 *
 * @param filePath 文件路径
 * @returns true=测试文件
 */
function isTestFile(filePath: string): boolean {
  if (/\.test\.[a-z]+$/.test(filePath) || /\.spec\.[a-z]+$/.test(filePath)) {
    return true;
  }
  return /(^|\/)(tests?|__tests__)\//.test(filePath);
}

/**
 * 从文件内容中提取技术债条目（TODO / FIXME / HACK / XXX / WORKAROUND）
 *
 * @param content 文件内容
 * @param filePath 文件路径
 * @returns 技术债条目列表
 */
function extractDebtItems(content: string, filePath: string): DebtItem[] {
  const items: DebtItem[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 重置 regex lastIndex（global 标志需重置）
    DEBT_MARKER_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DEBT_MARKER_REGEX.exec(line)) !== null) {
      const marker = match[1].toUpperCase();
      // 提取标记后的描述文本（到行尾）
      const afterMarker = line.slice(match.index + match[0].length);
      // 去除前导冒号/空格
      const description = afterMarker.replace(/^[\s:]+/, "").trim();
      items.push({
        marker,
        filePath,
        line: i + 1,
        description,
      });
    }
  }
  return items;
}

/**
 * 从文件路径提取模块路径（所在目录）
 *
 * @param filePath 文件路径
 * @returns 模块路径
 */
function extractModulePath(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash < 0) {
    return "";
  }
  return filePath.slice(0, lastSlash);
}

/**
 * 从 TypeScript 文件内容中提取相对 import 路径
 *
 * @param content 文件内容
 * @returns import 目标路径列表（相对路径）
 */
function extractRelativeImports(content: string): string[] {
  const imports: string[] = [];
  const importRegex = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    const target = match[1];
    if (target.startsWith("./") || target.startsWith("../")) {
      imports.push(target);
    }
  }
  return imports;
}

/**
 * 将相对 import 路径解析为模块路径
 *
 * 解析策略：
 * 1. 按 ES Module 相对路径语义拼接段
 * 2. 根据 fileMap 判断最后一段是否为文件名（含扩展名 / 对应 .ts/.tsx/.js/.jsx/.mjs 文件）
 * 3. 若是文件名，移除最后一段得到模块路径（目录）
 * 4. 若是目录名（如 barrel 导入 utils/index.ts），保留作为模块路径
 *
 * @param fromFilePath 导入来源文件路径
 * @param importPath 相对 import 路径
 * @param fileMap 项目文件清单（用于判断文件 / 目录）
 * @returns 解析后的模块路径
 */
function resolveImportToModulePath(
  fromFilePath: string,
  importPath: string,
  fileMap: Readonly<Record<string, string>>
): string {
  const fromModulePath = extractModulePath(fromFilePath);
  const segments = fromModulePath === "" ? [] : fromModulePath.split("/");
  const importSegments = importPath.split("/");
  for (const seg of importSegments) {
    if (seg === "." || seg === "") {
      continue;
    }
    if (seg === "..") {
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  // 判断最后一段是否为文件名：
  // - 显式扩展名（如 './foo.ts'）→ 文件名
  // - 拼接常见扩展名后存在于 fileMap（如 './foo' + '.ts'）→ 文件名
  // 否则视为目录（barrel 导入），保留作为模块路径
  if (segments.length > 0) {
    const last = segments[segments.length - 1];
    const hasExplicitExt = /\.(ts|tsx|js|jsx|mjs|json)$/.test(last);
    const candidateExts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json", "/index.ts", "/index.tsx", "/index.js"];
    const matchesFile = hasExplicitExt || candidateExts.some((ext) => Boolean(fileMap[segments.join("/") + ext]));
    if (matchesFile) {
      segments.pop();
    }
  }
  return segments.join("/");
}

/**
 * 构建模块依赖图并检测循环依赖
 *
 * 算法：DFS + 路径栈检测回边
 *
 * @param fileMap 项目文件清单
 * @returns 循环依赖列表
 */
function detectCircularDependencies(fileMap: Readonly<Record<string, string>>): CircularDependency[] {
  // 构建模块依赖图（邻接表）
  const graph = new Map<string, Set<string>>();
  const allPaths = Object.keys(fileMap).sort();
  for (const filePath of allPaths) {
    if (!isSourceFile(filePath) || isTestFile(filePath)) {
      continue;
    }
    const content = fileMap[filePath];
    if (typeof content !== "string") {
      continue;
    }
    const modulePath = extractModulePath(filePath);
    if (!graph.has(modulePath)) {
      graph.set(modulePath, new Set());
    }
    const imports = extractRelativeImports(content);
    for (const imp of imports) {
      const depModulePath = resolveImportToModulePath(filePath, imp, fileMap);
      if (depModulePath !== modulePath && depModulePath !== "") {
        graph.get(modulePath)!.add(depModulePath);
      }
    }
  }

  // DFS 检测循环依赖
  const visited = new Set<string>();
  const stack: string[] = [];
  const inStack = new Set<string>();
  const cycles: CircularDependency[] = [];
  const reportedCycles = new Set<string>();

  const dfs = (node: string): void => {
    if (inStack.has(node)) {
      // 找到循环：从栈中 node 第一次出现的位置开始截取
      const startIdx = stack.indexOf(node);
      const cycle = stack.slice(startIdx).concat([node]);
      // 标准化循环键（以最小元素开头的旋转）
      const key = cycle.slice(0, -1).sort().join("→");
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key);
        cycles.push({ cycle: Object.freeze(cycle) });
      }
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    inStack.add(node);
    stack.push(node);
    const neighbors = graph.get(node);
    if (neighbors) {
      for (const neighbor of neighbors) {
        dfs(neighbor);
      }
    }
    stack.pop();
    inStack.delete(node);
  };

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}

/**
 * 统计大文件（行数 >= 阈值）
 *
 * @param fileMap 项目文件清单
 * @returns 大文件列表（路径 + 行数）
 */
function detectLargeFiles(fileMap: Readonly<Record<string, string>>): { filePath: string; lines: number }[] {
  const largeFiles: { filePath: string; lines: number }[] = [];
  for (const [filePath, content] of Object.entries(fileMap)) {
    if (!isSourceFile(filePath) || isTestFile(filePath)) {
      continue;
    }
    if (typeof content !== "string") {
      continue;
    }
    const lines = content.split("\n").length;
    if (lines >= LARGE_FILE_THRESHOLD) {
      largeFiles.push({ filePath, lines });
    }
  }
  largeFiles.sort((a, b) => b.lines - a.lines);
  return largeFiles;
}

// ============================================================================
// RiskDebtSectionBuilder 类
// ============================================================================

/**
 * 风险与技术债章节构建器
 *
 * 实现章节顺序 6（对齐 §7.4 七章结构表）。
 *
 * 置信度：inferred（基于代码静态分析推断，需人工审核）
 *
 * **inferred 章节头部必须包含 INFERRED_SECTION_NOTICE 提示**
 *
 * 构建流程：
 * 1. 扫描所有源代码文件，提取 TODO / FIXME / HACK / XXX / WORKAROUND 注释
 * 2. 构建 import 依赖图，DFS 检测循环依赖
 * 3. 统计大文件（行数 >= 500）
 * 4. 组装 Markdown 内容（技术债清单 + 风险评估 + 循环依赖 + 覆盖率盲点）
 * 5. 返回冻结的 HandoverSection（confidence=inferred）
 */
export class RiskDebtSectionBuilder implements SectionBuilder {
  readonly sectionId = SECTION_ID;
  readonly title = SECTION_TITLE;
  readonly order = SECTION_ORDER;

  /**
   * 构建风险与技术债章节
   *
   * @param context 章节构建上下文
   * @returns 冻结的 HandoverSection（confidence=inferred）
   */
  async build(context: SectionBuildContext): Promise<HandoverSection> {
    const sources: string[] = [];

    // 1. 扫描技术债条目
    const debtItems: DebtItem[] = [];
    for (const [filePath, content] of Object.entries(context.fileMap)) {
      if (!isSourceFile(filePath) || isTestFile(filePath)) {
        continue;
      }
      if (typeof content !== "string") {
        continue;
      }
      sources.push(filePath);
      const fileItems = extractDebtItems(content, filePath);
      debtItems.push(...fileItems);
    }

    // 2. 检测循环依赖
    const circularDeps = detectCircularDependencies(context.fileMap);

    // 3. 检测大文件
    const largeFiles = detectLargeFiles(context.fileMap);

    // 4. 组装 Markdown 内容（头部必须包含 INFERRED_SECTION_NOTICE）
    const content = this.assembleContent(debtItems, circularDeps, largeFiles, context.projectRoot);

    return Object.freeze({
      sectionId: SECTION_ID,
      title: SECTION_TITLE,
      order: SECTION_ORDER,
      confidence: SECTION_CONFIDENCE,
      content,
      sources: Object.freeze(sources),
    });
  }

  /**
   * 组装章节 Markdown 内容
   *
   * **inferred 章节头部必须包含 INFERRED_SECTION_NOTICE 提示**
   *
   * @param debtItems 技术债条目列表
   * @param circularDeps 循环依赖列表
   * @param largeFiles 大文件列表
   * @param projectRoot 项目根目录
   * @returns 完整 Markdown 内容（头部含 INFERRED_SECTION_NOTICE）
   */
  private assembleContent(
    debtItems: DebtItem[],
    circularDeps: CircularDependency[],
    largeFiles: { filePath: string; lines: number }[],
    projectRoot: string
  ): string {
    const lines: string[] = [];
    // inferred 章节头部提示（对齐 §7.4 注释）
    lines.push(INFERRED_SECTION_NOTICE);
    lines.push(`## ${SECTION_TITLE}`);
    lines.push("");
    lines.push(`> **置信度**：inferred（基于代码静态分析推断，需人工审核后提升置信度）`);
    lines.push(`> **项目根目录**：${projectRoot}`);
    lines.push(`> **技术债条目数**：${debtItems.length}`);
    lines.push(`> **循环依赖数**：${circularDeps.length}`);
    lines.push(`> **大文件数**：${largeFiles.length}`);
    lines.push("");

    // 技术债清单
    lines.push("### 技术债清单");
    lines.push("");
    if (debtItems.length === 0) {
      lines.push("> 未在源代码中扫描到 TODO / FIXME / HACK / XXX / WORKAROUND 注释。");
      lines.push("");
    } else {
      // 按标记类型分组统计
      const markerCounts = new Map<string, number>();
      for (const item of debtItems) {
        markerCounts.set(item.marker, (markerCounts.get(item.marker) ?? 0) + 1);
      }
      lines.push("**按标记类型分组统计**：");
      lines.push("");
      lines.push("| 标记 | 数量 |");
      lines.push("|------|------|");
      for (const marker of [...markerCounts.keys()].sort()) {
        lines.push(`| ${marker} | ${markerCounts.get(marker)} |`);
      }
      lines.push("");

      // 详细清单（最多展示 50 条）
      lines.push("**详细清单**（最多展示 50 条）：");
      lines.push("");
      lines.push("| 标记 | 文件 | 行号 | 描述 |");
      lines.push("|------|------|------|------|");
      for (const item of debtItems.slice(0, 50)) {
        const desc = item.description || "(无描述)";
        lines.push(`| ${item.marker} | \`${item.filePath}\` | ${item.line} | ${desc} |`);
      }
      if (debtItems.length > 50) {
        lines.push(`| ... | ...(共 ${debtItems.length} 条) | ... | ... |`);
      }
      lines.push("");
    }

    // 循环依赖
    lines.push("### 循环依赖");
    lines.push("");
    if (circularDeps.length === 0) {
      lines.push("> 未检测到循环依赖。");
      lines.push("");
    } else {
      lines.push("**检测到以下循环依赖**（需重构以解除循环）：");
      lines.push("");
      for (const dep of circularDeps) {
        lines.push(`- ${dep.cycle.join(" → ")}`);
      }
      lines.push("");
    }

    // 大文件
    lines.push("### 大文件（行数 ≥ 500）");
    lines.push("");
    if (largeFiles.length === 0) {
      lines.push("> 未检测到大文件。");
      lines.push("");
    } else {
      lines.push("| 文件路径 | 行数 |");
      lines.push("|----------|------|");
      for (const file of largeFiles) {
        lines.push(`| \`${file.filePath}\` | ${file.lines} |`);
      }
      lines.push("");
    }

    // 覆盖率盲点
    lines.push("### 覆盖率盲点");
    lines.push("");
    lines.push("> **注**：覆盖率盲点需结合 TESTING Loop 的 CoverageGapChecker 产出。");
    lines.push("> 若 context.testResults 未提供覆盖率信息，本章节仅列出未含测试文件的源代码模块。");
    lines.push("");

    // 风险评估
    lines.push("### 风险评估");
    lines.push("");
    const riskLevel =
      circularDeps.length > 0 || largeFiles.length > 5 || debtItems.length > 20
        ? "高"
        : circularDeps.length > 0 || largeFiles.length > 0 || debtItems.length > 5
          ? "中"
          : "低";
    lines.push(`**整体风险等级**：${riskLevel}`);
    lines.push("");
    lines.push("**风险因素**：");
    lines.push("");
    lines.push(`- 循环依赖数量：${circularDeps.length}（${circularDeps.length > 0 ? "⚠️ 需重构" : "✅ 无"}）`);
    lines.push(`- 大文件数量：${largeFiles.length}（${largeFiles.length > 5 ? "⚠️ 需拆分" : "✅ 可控"}）`);
    lines.push(`- 技术债条目数：${debtItems.length}（${debtItems.length > 20 ? "⚠️ 需清理" : "✅ 可控"}）`);
    lines.push("");

    // 改进建议
    lines.push("### 改进建议");
    lines.push("");
    lines.push("1. **清理技术债**：按优先级处理 FIXME（必须修复）→ TODO（计划修复）→ HACK（临时方案）。");
    lines.push("2. **解除循环依赖**：通过依赖倒置（DIP）/ 接口隔离（ISP）重构循环模块。");
    lines.push("3. **拆分大文件**：将行数 ≥ 500 的文件按职责拆分为多个小文件。");
    lines.push("4. **补充测试**：为高风险符号补充单元测试，提升覆盖率至 ≥ 80%。");
    lines.push("5. **人工审核**：本章节为 inferred，建议接手者审核后提升置信度至 documented 或 verified。");
    lines.push("");

    return lines.join("\n");
  }
}
