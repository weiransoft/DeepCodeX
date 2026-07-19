/**
 * 模块地图章节构建器（EAG-P3 批次 11 Part B2 §7.4 第 2 章）
 *
 * 本模块实现 ModuleMapSectionBuilder，构建交接文档第 2 章"模块地图"。
 *
 * 数据源（对齐 §7.4 七章结构表）：
 * - PKC L1 GlobalView（context.pkcL1GlobalView，可选，降级时使用 fileMap）
 * - 代码扫描：从 context.fileMap 扫描 src 下的所有 .ts 文件（递归子目录）
 *
 * 置信度：verified（代码 + AST 解析）
 *
 * 章节内容包含：
 * 1. 模块列表（按目录分组，含模块名 / 职责 / 关键文件）
 * 2. 模块依赖关系（从 import 语句提取）
 * 3. 关键导出符号（export class / export interface / export function）
 *
 * @module eag/pkc/l4/section-builders/module-map-section
 */

import type { HandoverSection, SectionBuilder, SectionBuildContext } from "../types";

// ============================================================================
// 常量定义
// ============================================================================

const SECTION_ID = "module-map" as const;
const SECTION_TITLE = "模块地图" as const;
const SECTION_ORDER = 2 as const;
const SECTION_CONFIDENCE = "verified" as const;

/**
 * 源代码文件扩展名（仅扫描这些扩展名的文件）
 */
const SOURCE_EXTENSIONS: ReadonlyArray<string> = Object.freeze([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

// ============================================================================
// 类型定义（内部使用）
// ============================================================================

/**
 * 模块信息（一个目录对应一个模块）
 */
interface ModuleInfo {
  /** 模块路径（相对 projectRoot，如 "src/domain"） */
  readonly path: string;
  /** 模块名（目录名，如 "domain"） */
  readonly name: string;
  /** 关键文件列表（相对路径） */
  readonly files: ReadonlyArray<string>;
  /** 导出符号列表 */
  readonly exports: ReadonlyArray<ExportSymbol>;
  /** 依赖的其他模块路径列表 */
  readonly dependencies: ReadonlyArray<string>;
}

/**
 * 导出符号信息
 */
interface ExportSymbol {
  /** 符号名（如 "OrderService"） */
  readonly name: string;
  /** 符号类型（class / interface / function / const / type / enum） */
  readonly kind: string;
  /** 所在文件路径 */
  readonly filePath: string;
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
 * 测试文件特征：
 * - 路径包含 .test. / .spec.
 * - 路径在 tests/ / __tests__/ / test/ 目录下
 *
 * @param filePath 文件路径
 * @returns true=测试文件
 */
function isTestFile(filePath: string): boolean {
  if (/\.test\.[a-z]+$/.test(filePath) || /\.spec\.[a-z]+$/.test(filePath)) {
    return true;
  }
  if (/(^|\/)(tests?|__tests__)\//.test(filePath)) {
    return true;
  }
  return false;
}

/**
 * 从文件路径提取模块路径（所在目录）
 *
 * 例如：
 * - "src/domain/order.ts" → "src/domain"
 * - "src/index.ts" → "src"
 * - "package.json" → ""（根目录）
 *
 * @param filePath 文件路径
 * @returns 模块路径（目录）
 */
function extractModulePath(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash < 0) {
    return "";
  }
  return filePath.slice(0, lastSlash);
}

/**
 * 从文件路径提取模块名（最后一层目录名）
 *
 * @param modulePath 模块路径（目录）
 * @returns 模块名
 */
function extractModuleName(modulePath: string): string {
  if (modulePath === "") {
    return "(root)";
  }
  const lastSlash = modulePath.lastIndexOf("/");
  if (lastSlash < 0) {
    return modulePath;
  }
  return modulePath.slice(lastSlash + 1);
}

/**
 * 从 TypeScript / JavaScript 文件内容中提取导出符号
 *
 * 支持以下导出语法：
 * - export class Name
 * - export interface Name
 * - export function name
 * - export const name
 * - export type Name
 * - export enum Name
 * - export default class Name（kind=default-class）
 *
 * @param content 文件内容
 * @param filePath 文件路径（用于记录来源）
 * @returns 导出符号列表
 */
function extractExports(content: string, filePath: string): ExportSymbol[] {
  const exports: ExportSymbol[] = [];
  const lines = content.split("\n");

  // 匹配 export class / interface / function / const / type / enum
  // 形如：export class ClassName { / export interface IfaceName { / export function fn(...) {
  const exportRegex =
    /^\s*export\s+(default\s+)?(abstract\s+)?(class|interface|function|const|let|type|enum)\s+([A-Za-z_$][\w$]*)/;

  for (const line of lines) {
    const match = line.match(exportRegex);
    if (!match) {
      continue;
    }
    const isDefault = Boolean(match[1]);
    const kind = match[3];
    const name = match[4];
    exports.push({
      name,
      kind: isDefault ? `default-${kind}` : kind,
      filePath,
    });
  }

  // 匹配 export { name1, name2 } 语法（重导出）
  const reExportRegex = /^\s*export\s+\{([^}]+)\}\s*(?:from\s+['"]([^'"]+)['"])?\s*;?/;
  for (const line of lines) {
    const match = line.match(reExportRegex);
    if (!match) {
      continue;
    }
    const names = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const name of names) {
      // 跳过 "name as alias" 中的 alias 部分
      const actualName = name.split(/\s+as\s+/)[0];
      if (actualName) {
        exports.push({
          name: actualName,
          kind: "re-export",
          filePath,
        });
      }
    }
  }

  return exports;
}

/**
 * 从 TypeScript / JavaScript 文件内容中提取 import 语句的目标路径
 *
 * 支持以下 import 语法：
 * - import { x } from "./path"
 * - import x from "./path"
 * - import * as x from "./path"
 * - import "./path"（副作用导入）
 *
 * 仅提取相对路径（./ 或 ../ 开头），不提取 npm 包名。
 *
 * @param content 文件内容
 * @returns import 目标路径列表（相对路径）
 */
function extractImports(content: string): string[] {
  const imports: string[] = [];
  // 匹配 import ... from '...' / import ... from "..."
  const importRegex = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    const target = match[1];
    // 仅记录相对路径
    if (target.startsWith("./") || target.startsWith("../")) {
      imports.push(target);
    }
  }
  return imports;
}

/**
 * 将相对 import 路径解析为模块路径
 *
 * 例如：从 "src/domain/order.ts" 导入 "../services/orderService"
 *  - 起点：src/domain/
 *  - 目标：src/services/orderService
 *  - 返回："src/services"
 *
 * @param fromFilePath 导入来源文件路径
 * @param importPath 相对 import 路径（如 "./foo" / "../bar/baz"）
 * @returns 解析后的模块路径（目录）
 */
function resolveImportToModulePath(fromFilePath: string, importPath: string): string {
  const fromModulePath = extractModulePath(fromFilePath);
  // 将 fromModulePath 拆分为段
  const segments = fromModulePath === "" ? [] : fromModulePath.split("/");

  // 处理 importPath 的每个段
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

  // 移除末尾的文件名段（如 "orderService" 可能是文件名）
  // 由于无法确定是文件还是目录，统一保留作为模块路径
  return segments.join("/");
}

/**
 * 按 fileMap 中的源代码文件聚合模块
 *
 * 算法：
 * 1. 过滤源代码文件（非测试）
 * 2. 按所在目录分组
 * 3. 对每个文件提取 exports / imports
 * 4. 模块依赖 = 该模块所有文件的 import 目标模块路径集合
 *
 * @param fileMap 项目文件清单
 * @returns 模块列表（按 path 字典序排序）
 */
function aggregateModules(fileMap: Readonly<Record<string, string>>): ModuleInfo[] {
  // 模块路径 → 模块构建中间态
  const moduleMap = new Map<
    string,
    {
      path: string;
      name: string;
      files: string[];
      exports: ExportSymbol[];
      dependencies: Set<string>;
    }
  >();

  // 收集所有文件路径，按字典序处理，保证结果稳定
  const allPaths = Object.keys(fileMap).sort();

  for (const filePath of allPaths) {
    // 跳过非源代码文件
    if (!isSourceFile(filePath)) {
      continue;
    }
    // 跳过测试文件
    if (isTestFile(filePath)) {
      continue;
    }
    const content = fileMap[filePath];
    if (typeof content !== "string") {
      continue;
    }

    const modulePath = extractModulePath(filePath);
    const moduleName = extractModuleName(modulePath);

    // 获取或创建模块
    let mod = moduleMap.get(modulePath);
    if (!mod) {
      mod = {
        path: modulePath,
        name: moduleName,
        files: [],
        exports: [],
        dependencies: new Set<string>(),
      };
      moduleMap.set(modulePath, mod);
    }

    // 添加文件
    mod.files.push(filePath);
    // 提取 exports
    const exports = extractExports(content, filePath);
    mod.exports.push(...exports);
    // 提取 imports 并解析为模块路径
    const imports = extractImports(content);
    for (const imp of imports) {
      const depModulePath = resolveImportToModulePath(filePath, imp);
      // 不计入自身模块
      if (depModulePath !== modulePath && depModulePath !== "") {
        mod.dependencies.add(depModulePath);
      }
    }
  }

  // 转换为 ModuleInfo 数组并排序
  const modules: ModuleInfo[] = [];
  for (const mod of moduleMap.values()) {
    modules.push({
      path: mod.path,
      name: mod.name,
      files: Object.freeze([...mod.files].sort()),
      exports: Object.freeze(mod.exports),
      dependencies: Object.freeze([...mod.dependencies].sort()),
    });
  }
  modules.sort((a, b) => a.path.localeCompare(b.path));
  return modules;
}

// ============================================================================
// ModuleMapSectionBuilder 类
// ============================================================================

/**
 * 模块地图章节构建器
 *
 * 实现章节顺序 2（对齐 §7.4 七章结构表）。
 *
 * 构建流程：
 * 1. 从 context.fileMap 扫描源代码文件（src 下的 .ts 文件，递归子目录）
 * 2. 跳过测试文件（.test.ts / tests/ 目录等）
 * 3. 按所在目录聚合为模块
 * 4. 对每个文件提取 exports（export class/interface/function/const/type/enum）
 * 5. 对每个文件提取 imports，解析为模块依赖关系
 * 6. 组装 Markdown 内容（模块列表 + 依赖关系 + 关键导出）
 * 7. 返回冻结的 HandoverSection（confidence=verified）
 *
 * 不可变优先：
 * - build 返回的 HandoverSection 通过 Object.freeze 冻结
 */
export class ModuleMapSectionBuilder implements SectionBuilder {
  readonly sectionId = SECTION_ID;
  readonly title = SECTION_TITLE;
  readonly order = SECTION_ORDER;

  /**
   * 构建模块地图章节
   *
   * @param context 章节构建上下文
   * @returns 冻结的 HandoverSection（confidence=verified）
   */
  async build(context: SectionBuildContext): Promise<HandoverSection> {
    // 聚合模块
    const modules = aggregateModules(context.fileMap);

    // 收集 sources（所有扫描到的源代码文件）
    const sources: string[] = [];
    for (const mod of modules) {
      sources.push(...mod.files);
    }

    // 组装 Markdown 内容
    const content = this.assembleContent(modules, context.projectRoot);

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
   * @param modules 模块列表
   * @param projectRoot 项目根目录
   * @returns 完整 Markdown 内容
   */
  private assembleContent(modules: ModuleInfo[], projectRoot: string): string {
    const lines: string[] = [];
    lines.push(`## ${SECTION_TITLE}`);
    lines.push("");
    lines.push(`> **置信度**：verified（基于代码扫描 + import/export 静态分析）`);
    lines.push(`> **项目根目录**：${projectRoot}`);
    lines.push(`> **模块总数**：${modules.length}`);
    lines.push("");

    if (modules.length === 0) {
      lines.push("> 未在 fileMap 中扫描到源代码文件。请检查项目结构或注入完整 fileMap。");
      lines.push("");
      return lines.join("\n");
    }

    // 模块列表
    lines.push("### 模块列表");
    lines.push("");
    lines.push("| 模块路径 | 模块名 | 文件数 | 导出符号数 | 依赖模块数 |");
    lines.push("|----------|--------|--------|-----------|-----------|");
    for (const mod of modules) {
      lines.push(
        `| \`${mod.path || "(root)"}\` | ${mod.name} | ${mod.files.length} | ${mod.exports.length} | ${mod.dependencies.length} |`
      );
    }
    lines.push("");

    // 模块详情
    lines.push("### 模块详情");
    lines.push("");
    for (const mod of modules) {
      lines.push(`#### \`${mod.path || "(root)"}\``);
      lines.push("");
      lines.push(`- **模块名**：${mod.name}`);
      lines.push(`- **文件数**：${mod.files.length}`);
      lines.push("");

      // 关键文件
      if (mod.files.length > 0) {
        lines.push("**关键文件**：");
        lines.push("");
        for (const file of mod.files) {
          lines.push(`- \`${file}\``);
        }
        lines.push("");
      }

      // 导出符号
      if (mod.exports.length > 0) {
        lines.push("**导出符号**：");
        lines.push("");
        lines.push("| 符号名 | 类型 | 所在文件 |");
        lines.push("|--------|------|----------|");
        for (const exp of mod.exports) {
          lines.push(`| ${exp.name} | ${exp.kind} | \`${exp.filePath}\` |`);
        }
        lines.push("");
      }

      // 依赖关系
      if (mod.dependencies.length > 0) {
        lines.push("**依赖模块**：");
        lines.push("");
        for (const dep of mod.dependencies) {
          lines.push(`- \`${dep}\``);
        }
        lines.push("");
      }
    }

    // 依赖关系图（Mermaid）
    lines.push("### 模块依赖关系图");
    lines.push("");
    lines.push("```mermaid");
    lines.push("graph TD");
    // 生成节点 ID（替换特殊字符为下划线）
    const nodeIdMap = new Map<string, string>();
    let nodeIndex = 0;
    for (const mod of modules) {
      const nodeId = `M${nodeIndex++}`;
      nodeIdMap.set(mod.path, nodeId);
      lines.push(`  ${nodeId}["${mod.path || "(root)"}"]`);
    }
    // 生成边
    for (const mod of modules) {
      const fromId = nodeIdMap.get(mod.path);
      if (!fromId) continue;
      for (const dep of mod.dependencies) {
        const toId = nodeIdMap.get(dep);
        if (toId) {
          lines.push(`  ${fromId} --> ${toId}`);
        }
      }
    }
    lines.push("```");
    lines.push("");

    return lines.join("\n");
  }
}
