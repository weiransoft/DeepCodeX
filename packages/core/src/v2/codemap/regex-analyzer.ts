/**
 * 正则分析器（F-FOCUS-01 核心子模块）
 *
 * 零依赖使用正则表达式提取 TS/JS/Python 三语言的结构化信息：
 *   - 类/接口/结构体（ClassInfo）
 *   - 函数/方法/箭头函数（FunctionInfo）
 *   - 导入/导出（原始说明符）
 *   - 同文件内函数调用关系（FunctionInfo.calls → 派生 CallEdge）
 *
 * 设计依据：
 * - V2 技术方案 §6.3 正则分析器（v2.1 修订：6 语言统一实现，V2-P1 仅启用 TS/JS/Python）
 * - V2 技术方案 §6.1 FileInfo 接口（v2.6 补充 parseStatus/dependencies 字段）
 * - 架构师审查报告（2026-07-17）：CallEdge 仅同文件，简化建议已采纳
 * - 测试方案 §2.5 CM 系列（CM-01~CM-12，CM-05/06/07 Java/Rust/Go 延后至 V2-P2）
 *
 * 已知局限（正则分析器固有，非简化）：
 * - 字符串/注释内的关键字可能被误匹配（正则无词法上下文）
 * - 大括号配对不处理字符串/注释内的花括号（endLine 可能偏差，fallback 到文件末尾）
 * - 这些局限由 §4.6 US-ERR-003 单文件解析失败跳过机制兜底，不阻断整体扫描
 *
 * @module v2/codemap/regex-analyzer
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// 类型定义（与设计文档 §6.1 对齐）
// ============================================================================

/** 支持的语言（V2-P1 启用 typescript/javascript/python，其余延后至 V2-P2） */
export type SupportedLanguage = "typescript" | "javascript" | "python" | "java" | "rust" | "go";

/** 类/接口/结构体信息 */
export interface ClassInfo {
  name: string;
  type: "class" | "interface" | "struct" | "enum";
  methods: FunctionInfo[];
  properties: string[];
  startLine: number;
  endLine: number;
}

/** 函数/方法/箭头函数信息 */
export interface FunctionInfo {
  name: string;
  /** 函数签名（名称 + 参数列表，如 "foo(a: number, b: string)"） */
  signature: string;
  /** 参数列表原始文本 */
  params: string;
  /** 返回类型注解（提取不到时为空串） */
  returnType: string;
  startLine: number;
  endLine: number;
  /** 同文件内调用的其他函数名（派生 CallEdge 的源数据） */
  calls: string[];
}

/** 单文件分析结果（FileInfo，与设计文档 §6.1 对齐） */
export interface FileInfo {
  path: string;
  language: SupportedLanguage;
  classes: ClassInfo[];
  functions: FunctionInfo[];
  /** 原始导入说明符（如 "./bar"、"react"、"os"），路径解析由 generator 负责 */
  imports: string[];
  /** 导出符号名 */
  exports: string[];
  /** 文件总行数 */
  lines: number;
  /** 解析状态：ok=成功，failed=解析异常（CM-11 要求） */
  parseStatus: "ok" | "failed";
  /** 同项目内依赖文件相对路径（由 generator 填充，regex-analyzer 置空） */
  dependencies: string[];
}

/** 语言正则规则集 */
interface LanguagePatterns {
  /** 类/接口定义 */
  classPattern: RegExp;
  /** 函数定义 */
  functionPattern: RegExp;
  /** 导入语句 */
  importPattern: RegExp;
  /** 导出语句 */
  exportPattern: RegExp;
  /** 类方法定义（仅 TS/JS 有） */
  methodPattern?: RegExp;
  /** 箭头函数定义（仅 TS/JS 有） */
  arrowFunctionPattern?: RegExp;
}

// ============================================================================
// 正则规则集（从设计文档 §6.3 翻译，仅 TS/JS/Python）
// ============================================================================

/**
 * TS/JS 正则规则集
 *
 * 注意：正则中不含正斜杠加星号的序列，避免 JSDoc 注释终止符误解析。
 */
const TS_JS_PATTERNS: LanguagePatterns = {
  // 类/接口：匹配 export class / abstract class / interface / 普通类
  classPattern: /(?:export\s+)?(?:abstract\s+)?(?:class|interface)\s+(\w+)/,
  // 函数：匹配 function / async function / export function，捕获名称与参数
  functionPattern: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
  // 方法：匹配类方法（public/private/protected/static/async 修饰符 + 方法名 + 参数）
  methodPattern: /(?:public|private|protected|static|async)\s+(\w+)\s*\(([^)]*)\)/,
  // 箭头函数：const/let/var + 名称 + 可选 async + 参数 + 箭头
  arrowFunctionPattern: /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/,
  // 导入：ESM import 语句，捕获 from 后的模块说明符
  importPattern: /^\s*import\s+.*?from\s+['"]([^'"]+)['"]/,
  // 导出：export const/let/var/function/class/abstract/default + 名称
  exportPattern: /^\s*export\s+(?:const|let|var|function|class|abstract|default)\s+(\w+)/,
};

/** Python 正则规则集 */
const PYTHON_PATTERNS: LanguagePatterns = {
  // 类定义：class Name
  classPattern: /^class\s+(\w+)/,
  // 函数定义：def name(params)，含缩进（类内方法也用此匹配）
  functionPattern: /^(\s*)def\s+(\w+)\(([^)]*)\)/,
  // 导入：import x 或 from x import y，捕获模块路径
  importPattern: /^\s*(?:import\s+(\S+)|from\s+(\S+)\s+import)/,
  // 导出：Python 无显式 export，置空匹配（exports 恒为空数组）
  exportPattern: /$^/,
};

// ============================================================================
// 语言检测
// ============================================================================

/** 扩展名 → 语言映射表 */
const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".java": "java",
  ".rs": "rust",
  ".go": "go",
};

/**
 * 根据文件扩展名检测语言
 *
 * @param filePath 文件路径
 * @returns 语言类型；无法识别时返回 null
 */
export function detectLanguage(filePath: string): SupportedLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}

// ============================================================================
// 辅助函数：大括号配对（TS/JS）
// ============================================================================

/**
 * 从指定行开始，查找匹配的闭合大括号所在行
 *
 * 算法：从 startLine 行开始扫描，遇到 { 计数 +1，遇到 } 计数 -1，
 * 计数归零时的行号即为 endLine。
 *
 * 已知局限：不处理字符串/注释内的花括号（正则分析器固有局限，
 * 由 US-ERR-003 单文件解析失败跳过机制兜底）。
 *
 * @param lines 文件按行拆分的数组
 * @param startLine 起始行号（1-based）
 * @returns 闭合大括号所在行号（1-based）；配对失败返回文件末尾行号
 */
function findMatchingBraceLine(lines: string[], startLine: number): number {
  let depth = 0;
  let foundOpen = false;
  for (let i = startLine - 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        foundOpen = true;
      } else if (ch === "}") {
        depth--;
        if (foundOpen && depth === 0) {
          return i + 1;
        }
      }
    }
  }
  // 配对失败：fallback 到文件末尾
  return lines.length;
}

// ============================================================================
// 辅助函数：缩进追踪（Python）
// ============================================================================

/**
 * 查找 Python 函数体的结束行
 *
 * 算法：函数定义行的缩进为 baseIndent，函数体为后续缩进严格大于 baseIndent 的行；
 * 遇到缩进小于等于 baseIndent 的非空行即认为函数体结束。
 *
 * @param lines 文件按行拆分的数组
 * @param defLine 函数定义行号（1-based）
 * @returns 函数体结束行号（1-based，指向函数体最后一行）
 */
function findPythonBlockEnd(lines: string[], defLine: number): number {
  const defLineText = lines[defLine - 1] ?? "";
  const baseIndent = defLineText.match(/^(\s*)/)?.[1].length ?? 0;
  let endLine = defLine;
  for (let i = defLine; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // 空行或纯注释行不影响缩进判定
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const currentIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (currentIndent > baseIndent) {
      endLine = i + 1;
    } else {
      // 遇到缩进小于等于 baseIndent 的非空行，函数体已结束
      break;
    }
  }
  return endLine;
}

// ============================================================================
// 辅助函数：提取函数体内的调用
// ============================================================================

/**
 * 标识符调用正则：匹配 name( 或 name. 形式
 *
 * 用于在函数体范围内提取可能的目标函数调用。
 * 不匹配关键字（if/for/while/return 等）。
 */
const CALL_PATTERN = /\b([a-zA-Z_$][\w$]*)\s*\(/g;
/** 需要排除的语言关键字（避免误识别为函数调用） */
const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "new",
  "typeof",
  "instanceof",
  "in",
  "of",
  "do",
  "else",
  "try",
  "finally",
  "throw",
  "function",
  "class",
  "interface",
  "enum",
  "def",
  "elif",
  "with",
  "lambda",
  "print", // Python 2 print 语句（保守排除）
]);

/**
 * 提取指定行范围内的函数调用
 *
 * 算法：在 [startLine, endLine] 范围内用 CALL_PATTERN 匹配所有 name( 形式，
 * 排除关键字，与同文件已知函数名集合取交集，返回去重后的调用列表。
 *
 * @param lines 文件按行拆分的数组
 * @param startLine 起始行号（1-based，含）
 * @param endLine 结束行号（1-based，含）
 * @param knownFunctions 同文件已知函数名集合
 * @returns 去重后的被调用函数名列表（顺序保持首次出现顺序）
 */
function extractCallsInRange(
  lines: string[],
  startLine: number,
  endLine: number,
  knownFunctions: Set<string>
): string[] {
  const calls: string[] = [];
  const seen = new Set<string>();
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  for (let i = start; i < end; i++) {
    const line = lines[i] ?? "";
    CALL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CALL_PATTERN.exec(line)) !== null) {
      const name = match[1];
      if (!name) continue;
      // 排除关键字；仅保留同文件已知函数（跨文件调用由 DependencyEdge 表达）
      if (KEYWORDS.has(name)) continue;
      if (knownFunctions.has(name) && !seen.has(name)) {
        seen.add(name);
        calls.push(name);
      }
    }
  }
  return calls;
}

// ============================================================================
// RegexASTAnalyzer 类
// ============================================================================

/**
 * 正则分析器
 *
 * 对单个文件执行正则匹配，提取类/函数/导入/导出/调用关系。
 * 三语言（TS/JS/Python）共用同一套接口，通过 language 参数区分正则规则集。
 *
 * 用法：
 * ```typescript
 * const analyzer = new RegexASTAnalyzer("typescript");
 * const info = analyzer.analyzeFile("/path/to/file.ts");
 * console.log(info.functions.map((f) => f.name));
 * ```
 */
export class RegexASTAnalyzer {
  /** 分析器实例化的语言 */
  private readonly language: SupportedLanguage;
  /** 该语言对应的正则规则集 */
  private readonly patterns: LanguagePatterns;

  /**
   * 构造分析器
   *
   * @param language 目标语言
   * @throws {Error} 当 language 不是 TS/JS/Python 时抛错（V2-P1 仅支持三语言）
   */
  constructor(language: SupportedLanguage) {
    this.language = language;
    this.patterns = RegexASTAnalyzer.getPatterns(language);
  }

  /**
   * 获取语言对应的正则规则集
   *
   * V2-P1 仅支持 TS/JS/Python，Java/Rust/Go 延后至 V2-P2。
   *
   * @param language 语言类型
   * @returns 正则规则集
   * @throws {Error} 当语言未在 V2-P1 启用时抛错
   */
  private static getPatterns(language: SupportedLanguage): LanguagePatterns {
    switch (language) {
      case "typescript":
      case "javascript":
        return TS_JS_PATTERNS;
      case "python":
        return PYTHON_PATTERNS;
      default:
        // V2-P1 不启用 Java/Rust/Go，抛错以 fail-fast
        throw new Error(`RegexASTAnalyzer: 语言 ${language} 未在 V2-P1 启用（延后至 V2-P2）`);
    }
  }

  /**
   * 分析单个文件
   *
   * 实现步骤：
   * 1. 读取文件内容（UTF-8），失败则 parseStatus="failed"
   * 2. 按行拆分，逐行匹配 class/function/method/arrow/import/export 正则
   * 3. TS/JS 用大括号配对计算 endLine；Python 用缩进追踪计算 endLine
   * 4. 第二遍：对每个函数，在其行范围内提取同文件函数调用（calls 字段）
   * 5. 组装 FileInfo 返回
   *
   * 任何解析异常都被 catch，parseStatus 置为 "failed"，不抛错（US-ERR-003）。
   *
   * @param filePath 文件绝对路径
   * @returns 文件分析结果（parseStatus="ok" 或 "failed"）
   */
  analyzeFile(filePath: string): FileInfo {
    // 默认失败结果（解析异常时返回）
    const failedInfo: FileInfo = {
      path: filePath,
      language: this.language,
      classes: [],
      functions: [],
      imports: [],
      exports: [],
      lines: 0,
      parseStatus: "failed",
      dependencies: [],
    };

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      // 文件读取失败：返回 failed 状态
      return failedInfo;
    }

    try {
      const lines = content.split("\n");
      const fileInfo = this.parseLines(lines, filePath);
      return fileInfo;
    } catch {
      // 解析过程异常：返回 failed 状态，不中断整体扫描（US-ERR-003）
      return failedInfo;
    }
  }

  /**
   * 逐行解析文件内容
   *
   * @param lines 文件按行拆分的数组
   * @param filePath 文件路径（用于填充 FileInfo.path）
   * @returns 解析后的 FileInfo
   */
  private parseLines(lines: string[], filePath: string): FileInfo {
    const classes: ClassInfo[] = [];
    const functions: FunctionInfo[] = [];
    const imports: string[] = [];
    const exports: string[] = [];

    // 第一遍：识别所有顶层定义
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const lineNum = i + 1;

      // 类识别（TS/JS/Python 通用）
      this.matchClass(line, lineNum, lines, classes);
      // 函数识别
      this.matchFunction(line, lineNum, lines, functions);
      // 方法识别（仅 TS/JS，暂存到 classes 的 methods——但方法属于类，
      // 正则无法精确归属，这里收集到 functions 列表，标记为方法级）
      this.matchMethod(line, lineNum, lines, functions);
      // 箭头函数识别（仅 TS/JS）
      this.matchArrowFunction(line, lineNum, lines, functions);
      // 导入识别
      this.matchImport(line, imports);
      // 导出识别
      this.matchExport(line, exports);
    }

    // 第二遍：提取同文件函数调用（calls 字段）
    const knownFunctions = new Set<string>();
    for (const fn of functions) knownFunctions.add(fn.name);
    // 类方法名也加入已知函数集（方法可被同文件其他函数调用）
    for (const cls of classes) {
      for (const method of cls.methods) knownFunctions.add(method.name);
    }
    for (const fn of functions) {
      fn.calls = extractCallsInRange(lines, fn.startLine, fn.endLine, knownFunctions);
    }
    for (const cls of classes) {
      for (const method of cls.methods) {
        method.calls = extractCallsInRange(lines, method.startLine, method.endLine, knownFunctions);
      }
    }

    return {
      path: filePath,
      language: this.language,
      classes,
      functions,
      imports,
      exports,
      lines: lines.length,
      parseStatus: "ok",
      dependencies: [],
    };
  }

  /**
   * 匹配类定义
   *
   * @param line 当前行文本
   * @param lineNum 当前行号（1-based）
   * @param lines 文件全部行
   * @param classes 类信息收集数组（匹配成功时 push）
   */
  private matchClass(line: string, lineNum: number, lines: string[], classes: ClassInfo[]): void {
    const match = this.patterns.classPattern.exec(line);
    if (!match) return;
    const name = match[1];
    if (!name) return;
    // 判断类型：interface 关键字 → interface，否则 class（Python 只有 class）
    const type: ClassInfo["type"] = line.includes("interface") ? "interface" : "class";
    // 计算 endLine
    const endLine =
      this.language === "python" ? findPythonBlockEnd(lines, lineNum) : findMatchingBraceLine(lines, lineNum);
    classes.push({
      name,
      type,
      methods: [],
      properties: [],
      startLine: lineNum,
      endLine,
    });
  }

  /**
   * 匹配函数定义
   *
   * @param line 当前行文本
   * @param lineNum 当前行号（1-based）
   * @param lines 文件全部行
   * @param functions 函数信息收集数组（匹配成功时 push）
   */
  private matchFunction(line: string, lineNum: number, lines: string[], functions: FunctionInfo[]): void {
    const match = this.patterns.functionPattern.exec(line);
    if (!match) return;
    // TS/JS：match[1]=name, match[2]=params
    // Python：match[1]=indent, match[2]=name, match[3]=params
    let name: string | undefined;
    let params: string | undefined;
    if (this.language === "python") {
      name = match[2];
      params = match[3];
    } else {
      name = match[1];
      params = match[2];
    }
    if (!name || params === undefined) return;

    // 提取返回类型注解（TS 的 ): ReturnType { 或 Python 的 ) -> ReturnType:）
    const returnType = this.extractReturnType(line);

    // 计算 endLine
    const endLine =
      this.language === "python" ? findPythonBlockEnd(lines, lineNum) : findMatchingBraceLine(lines, lineNum);

    functions.push({
      name,
      signature: `${name}(${params})`,
      params,
      returnType,
      startLine: lineNum,
      endLine,
      calls: [],
    });
  }

  /**
   * 匹配类方法定义（仅 TS/JS）
   *
   * @param line 当前行文本
   * @param lineNum 当前行号（1-based）
   * @param lines 文件全部行
   * @param functions 函数信息收集数组（匹配成功时 push）
   */
  private matchMethod(line: string, lineNum: number, lines: string[], functions: FunctionInfo[]): void {
    if (!this.patterns.methodPattern) return;
    const match = this.patterns.methodPattern.exec(line);
    if (!match) return;
    const name = match[1];
    const params = match[2];
    if (!name || params === undefined) return;
    // 避免与 function 重复（function 关键字行不会被 methodPattern 匹配，但保守去重）
    if (line.includes("function ")) return;
    const endLine = findMatchingBraceLine(lines, lineNum);
    functions.push({
      name,
      signature: `${name}(${params})`,
      params,
      returnType: "",
      startLine: lineNum,
      endLine,
      calls: [],
    });
  }

  /**
   * 匹配箭头函数定义（仅 TS/JS）
   *
   * @param line 当前行文本
   * @param lineNum 当前行号（1-based）
   * @param lines 文件全部行
   * @param functions 函数信息收集数组（匹配成功时 push）
   */
  private matchArrowFunction(line: string, lineNum: number, lines: string[], functions: FunctionInfo[]): void {
    if (!this.patterns.arrowFunctionPattern) return;
    const match = this.patterns.arrowFunctionPattern.exec(line);
    if (!match) return;
    const name = match[1];
    const params = match[2];
    if (!name || params === undefined) return;
    // 箭头函数可能跨行，endLine 用大括号配对；若无大括号（表达式体），endLine=当前行
    let endLine = lineNum;
    if (line.includes("{")) {
      endLine = findMatchingBraceLine(lines, lineNum);
    }
    functions.push({
      name,
      signature: `${name}(${params})`,
      params,
      returnType: "",
      startLine: lineNum,
      endLine,
      calls: [],
    });
  }

  /**
   * 匹配导入语句
   *
   * @param line 当前行文本
   * @param imports 导入说明符收集数组（匹配成功时 push）
   */
  private matchImport(line: string, imports: string[]): void {
    const match = this.patterns.importPattern.exec(line);
    if (!match) return;
    // TS/JS：match[1] = 模块说明符
    // Python：match[1] = import x 的 x，match[2] = from x import 的 x
    if (this.language === "python") {
      const spec = match[1] ?? match[2];
      if (spec) imports.push(spec);
    } else {
      const spec = match[1];
      if (spec) imports.push(spec);
    }
  }

  /**
   * 匹配导出语句
   *
   * @param line 当前行文本
   * @param exports 导出符号收集数组（匹配成功时 push）
   */
  private matchExport(line: string, exports: string[]): void {
    const match = this.patterns.exportPattern.exec(line);
    if (!match) return;
    const name = match[1];
    if (name) exports.push(name);
  }

  /**
   * 提取返回类型注解
   *
   * TS/JS：匹配 `): ReturnType {` 或 `): ReturnType;`
   * Python：匹配 `) -> ReturnType:`
   *
   * @param line 当前行文本
   * @returns 返回类型字符串；提取不到返回空串
   */
  private extractReturnType(line: string): string {
    if (this.language === "python") {
      // Python: def foo(...) -> ReturnType:
      const m = line.match(/->\s*([^:]+):/);
      return m?.[1]?.trim() ?? "";
    }
    // TS/JS: function foo(...): ReturnType {
    const m = line.match(/\)\s*:\s*([^{;]+)[{;]/);
    return m?.[1]?.trim() ?? "";
  }
}
