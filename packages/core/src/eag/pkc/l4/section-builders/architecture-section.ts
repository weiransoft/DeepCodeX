/**
 * 架构概览章节构建器（EAG-P3 批次 11 Part B2 §7.4 第 1 章）
 *
 * 本模块实现 ArchitectureSectionBuilder，构建交接文档第 1 章"架构概览"。
 *
 * 数据源（对齐 §7.4 七章结构表）：
 * - spec.md：项目规格说明（含项目定位 / 技术栈 / 分层架构 / 设计原则）
 * - CONSTITUTION.md：项目宪法（含不可妥协的设计原则）
 *
 * 置信度：documented（来自项目文档）
 *
 * 章节内容包含：
 * 1. 项目定位（从 spec.md 提取"## 项目定位"或"## Project Overview"章节）
 * 2. 技术栈（从 spec.md 提取"## 技术栈"章节，或扫描 package.json）
 * 3. 分层架构（从 spec.md 提取"## 架构概览"或"## 分层架构"章节）
 * 4. 设计原则（从 CONSTITUTION.md 提取设计原则条目）
 *
 * @module eag/pkc/l4/section-builders/architecture-section
 */

import type { HandoverSection, SectionBuilder, SectionBuildContext } from "../types";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 架构概览章节 ID（对齐 §7.4）
 */
const SECTION_ID = "architecture-overview" as const;

/**
 * 架构概览章节标题（对齐 §7.4）
 */
const SECTION_TITLE = "架构概览" as const;

/**
 * 架构概览章节顺序（对齐 §7.4，第 1 章）
 */
const SECTION_ORDER = 1 as const;

/**
 * 架构概览章节置信度（对齐 §7.4，documented）
 *
 * documented：来自 spec.md / CONSTITUTION.md 文档
 */
const SECTION_CONFIDENCE = "documented" as const;

/**
 * 可能的 spec.md 文件路径列表（按优先级排序）
 *
 * SectionBuilder 按此顺序在 fileMap 中查找 spec.md 文件。
 */
const SPEC_FILE_PATHS: ReadonlyArray<string> = Object.freeze([
  "spec.md",
  "docs/spec.md",
  "SPEC.md",
  "docs/SPEC.md",
  "README.md",
  "docs/README.md",
]);

/**
 * 可能的 CONSTITUTION.md 文件路径列表（按优先级排序）
 */
const CONSTITUTION_FILE_PATHS: ReadonlyArray<string> = Object.freeze([
  "CONSTITUTION.md",
  "docs/CONSTITUTION.md",
  "constitution.md",
  "docs/constitution.md",
]);

/**
 * package.json 文件路径（用于补充技术栈信息）
 */
const PACKAGE_JSON_PATH = "package.json" as const;

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从 fileMap 中按候选路径顺序查找首个存在的文件
 *
 * @param fileMap 项目文件清单
 * @param candidates 候选路径列表（按优先级排序）
 * @returns 首个命中文件的内容，未命中返回 null
 */
function findFile(fileMap: Readonly<Record<string, string>>, candidates: ReadonlyArray<string>): string | null {
  for (const candidate of candidates) {
    if (typeof fileMap[candidate] === "string") {
      return fileMap[candidate];
    }
  }
  return null;
}

/**
 * 从 Markdown 内容中提取指定章节（含子章节）
 *
 * 章节以 `## 标题` 开始，到下一个 `## ` 或文件末尾结束。
 *
 * @param markdown Markdown 全文
 * @param headingPatterns 章节标题正则模式数组（如 [/^##\s+架构概览/m, /^##\s+分层架构/m]）
 * @returns 提取的章节内容（去除 `## 标题` 行），未找到返回 null
 */
function extractSection(markdown: string, headingPatterns: ReadonlyArray<RegExp>): string | null {
  // 按行扫描，匹配 ## 标题
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 检查当前行是否匹配任一标题模式
    const matched = headingPatterns.some((pattern) => pattern.test(line));
    if (!matched) {
      continue;
    }
    // 找到匹配标题，提取从下一行开始直到下一个 ## 标题或文件末尾的内容
    const contentLines: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      // 遇到下一个 ## 标题则停止（### 子标题保留）
      if (/^##\s+/.test(lines[j])) {
        break;
      }
      contentLines.push(lines[j]);
    }
    const content = contentLines.join("\n").trim();
    if (content.length > 0) {
      return content;
    }
  }
  return null;
}

/**
 * 从 package.json 内容中提取技术栈信息
 *
 * 提取 dependencies / devDependencies 中的包名列表。
 *
 * @param packageJsonContent package.json 文件内容
 * @returns 技术栈描述 Markdown（如 "- typescript\n- express\n"），失败返回 null
 */
function extractTechStackFromPackageJson(packageJsonContent: string): string | null {
  try {
    const pkg = JSON.parse(packageJsonContent);
    const deps: string[] = [];
    if (pkg.dependencies && typeof pkg.dependencies === "object") {
      deps.push(...Object.keys(pkg.dependencies));
    }
    if (pkg.devDependencies && typeof pkg.devDependencies === "object") {
      deps.push(...Object.keys(pkg.devDependencies));
    }
    if (deps.length === 0) {
      return null;
    }
    // 去重并排序
    const uniqueDeps = [...new Set(deps)].sort();
    return uniqueDeps.map((dep) => `- ${dep}`).join("\n");
  } catch {
    // JSON 解析失败返回 null
    return null;
  }
}

/**
 * 从 CONSTITUTION.md 提取设计原则
 *
 * 设计原则通常以列表项形式呈现（- / *），或以"## 设计原则"章节呈现。
 *
 * @param constitutionContent CONSTITUTION.md 文件内容
 * @returns 设计原则 Markdown 内容，未找到返回 null
 */
function extractDesignPrinciples(constitutionContent: string): string | null {
  // 优先尝试提取"## 设计原则"章节
  const section = extractSection(constitutionContent, [/^##\s+设计原则/m, /^##\s+Design\s+Principles/m, /^##\s+原则/m]);
  if (section) {
    return section;
  }
  // 降级：提取所有以 "原则" 开头的列表项
  const lines = constitutionContent.split("\n");
  const principleLines = lines.filter((line) => /^\s*[-*]\s+.*原则/.test(line));
  if (principleLines.length > 0) {
    return principleLines.join("\n");
  }
  return null;
}

// ============================================================================
// ArchitectureSectionBuilder 类
// ============================================================================

/**
 * 架构概览章节构建器
 *
 * 实现章节顺序 1（对齐 §7.4 七章结构表）。
 *
 * 构建流程：
 * 1. 从 fileMap 读取 spec.md（按 SPEC_FILE_PATHS 顺序查找）
 * 2. 从 fileMap 读取 CONSTITUTION.md（按 CONSTITUTION_FILE_PATHS 顺序查找）
 * 3. 从 spec.md 提取：项目定位 / 技术栈 / 分层架构
 * 4. 从 CONSTITUTION.md 提取：设计原则
 * 5. 降级策略：spec.md 缺失时用 package.json 推导技术栈
 * 6. 组装 Markdown 内容
 * 7. 返回冻结的 HandoverSection
 *
 * 不可变优先：
 * - build 返回的 HandoverSection 通过 Object.freeze 冻结
 */
export class ArchitectureSectionBuilder implements SectionBuilder {
  /** 章节 ID（对齐 §7.4） */
  readonly sectionId = SECTION_ID;
  /** 章节标题（对齐 §7.4） */
  readonly title = SECTION_TITLE;
  /** 章节顺序（对齐 §7.4，第 1 章） */
  readonly order = SECTION_ORDER;

  /**
   * 构建架构概览章节
   *
   * @param context 章节构建上下文（含 fileMap / projectRoot / runId）
   * @returns 冻结的 HandoverSection（confidence=documented）
   */
  async build(context: SectionBuildContext): Promise<HandoverSection> {
    const sources: string[] = [];

    // 1. 读取 spec.md
    const specContent = findFile(context.fileMap, SPEC_FILE_PATHS);
    if (specContent !== null) {
      // 记录命中的 spec 文件路径
      for (const candidate of SPEC_FILE_PATHS) {
        if (typeof context.fileMap[candidate] === "string") {
          sources.push(candidate);
          break;
        }
      }
    }

    // 2. 读取 CONSTITUTION.md
    const constitutionContent = findFile(context.fileMap, CONSTITUTION_FILE_PATHS);
    if (constitutionContent !== null) {
      for (const candidate of CONSTITUTION_FILE_PATHS) {
        if (typeof context.fileMap[candidate] === "string") {
          sources.push(candidate);
          break;
        }
      }
    }

    // 3. 提取项目定位
    const projectPositioning = specContent
      ? extractSection(specContent, [
          /^##\s+项目定位/m,
          /^##\s+Project\s+Overview/m,
          /^##\s+项目概述/m,
          /^##\s+项目简介/m,
        ])
      : null;

    // 4. 提取技术栈（spec.md 优先，降级到 package.json）
    let techStack = specContent ? extractSection(specContent, [/^##\s+技术栈/m, /^##\s+Tech\s+Stack/m]) : null;
    if (!techStack) {
      const packageJson = context.fileMap[PACKAGE_JSON_PATH];
      if (packageJson) {
        techStack = extractTechStackFromPackageJson(packageJson);
        if (techStack) {
          sources.push(PACKAGE_JSON_PATH);
        }
      }
    }

    // 5. 提取分层架构
    const layeredArchitecture = specContent
      ? extractSection(specContent, [
          /^##\s+架构概览/m,
          /^##\s+分层架构/m,
          /^##\s+Architecture/m,
          /^##\s+Architecture\s+Overview/m,
        ])
      : null;

    // 6. 提取设计原则
    const designPrinciples = constitutionContent ? extractDesignPrinciples(constitutionContent) : null;

    // 7. 组装 Markdown 内容
    const content = this.assembleContent({
      projectPositioning,
      techStack,
      layeredArchitecture,
      designPrinciples,
      projectRoot: context.projectRoot,
    });

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
   * 每个部分缺失时给出明确提示，而非空占位符。
   *
   * @param parts 章节组成部分
   * @returns 完整 Markdown 内容
   */
  private assembleContent(parts: {
    projectPositioning: string | null;
    techStack: string | null;
    layeredArchitecture: string | null;
    designPrinciples: string | null;
    projectRoot: string;
  }): string {
    const lines: string[] = [];
    lines.push(`## ${SECTION_TITLE}`);
    lines.push("");
    lines.push(`> **置信度**：documented（来自 spec.md / CONSTITUTION.md）`);
    lines.push(`> **项目根目录**：${parts.projectRoot}`);
    lines.push("");

    // 项目定位
    lines.push("### 项目定位");
    lines.push("");
    if (parts.projectPositioning) {
      lines.push(parts.projectPositioning);
    } else {
      lines.push("> 未在 spec.md 中找到项目定位章节（候选标题：项目定位 / Project Overview / 项目概述 / 项目简介）。");
    }
    lines.push("");

    // 技术栈
    lines.push("### 技术栈");
    lines.push("");
    if (parts.techStack) {
      lines.push(parts.techStack);
    } else {
      lines.push("> 未在 spec.md 中找到技术栈章节，且 package.json 不可用。请补充技术栈信息。");
    }
    lines.push("");

    // 分层架构
    lines.push("### 分层架构");
    lines.push("");
    if (parts.layeredArchitecture) {
      lines.push(parts.layeredArchitecture);
    } else {
      lines.push("> 未在 spec.md 中找到分层架构章节（候选标题：架构概览 / 分层架构 / Architecture）。");
    }
    lines.push("");

    // 设计原则
    lines.push("### 设计原则");
    lines.push("");
    if (parts.designPrinciples) {
      lines.push(parts.designPrinciples);
    } else {
      lines.push("> 未在 CONSTITUTION.md 中找到设计原则章节。建议补充宪法文件以记录不可妥协的设计原则。");
    }
    lines.push("");

    return lines.join("\n");
  }
}
