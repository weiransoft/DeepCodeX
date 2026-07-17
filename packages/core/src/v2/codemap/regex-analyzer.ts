/**
 * 正则分析器（F-FOCUS-01 核心子模块）
 *
 * 零依赖使用正则表达式提取 TS/JS/Python/Java/Rust/Go 六语言的结构化信息：
 *   - 类/接口/结构体/枚举（ClassInfo）
 *   - 函数/方法/箭头函数（FunctionInfo）
 *   - 导入/导出（原始说明符）
 *   - 同文件内函数调用关系（FunctionInfo.calls → 派生 CallEdge）
 *
 * 设计依据：
 * - V2 技术方案 §6.3 正则分析器（v2.1 修订：6 语言统一实现）
 * - V2 技术方案 §6.1 FileInfo 接口（v2.6 补充 parseStatus/dependencies 字段）
 * - V2_P2_IMPLEMENTATION_PLAN.md §3.1：V2-P2 启用 Java/Rust/Go（CM-05/06/07 去 skip 转绿）
 * - 架构师审查报告（2026-07-17）：CallEdge 仅同文件，简化建议已采纳
 * - 测试方案 §2.5 CM 系列（CM-01~CM-12）
 *
 * V2-P2 变更点：
 * - 新增 JAVA_PATTERNS / RUST_PATTERNS / GO_PATTERNS 三套正则规则集（自 quality 包移植）
 * - getPatterns 方法补齐 java/rust/go 三个 case（移除 V2-P1 default 抛错）
 * - matchClass 升级为语言感知 type 检测（新增 detectClassType 方法，支持 class/interface/struct/enum 四型）
 * - matchFunction 增加 Java 关键字排除（P1-3 架构师建议，避免误匹配 if/for/while 等控制流）
 * - extractReturnType 增加 Rust/Go 返回类型提取
 *
 * 已知局限（正则分析器固有，非简化）：
 * - 字符串/注释内的关键字可能被误匹配（正则无词法上下文）
 * - 大括号配对不处理字符串/注释内的花括号（endLine 可能偏差，fallback 到文件末尾）
 * - Go import 块（import ( ... )）无状态ful解析，仅匹配单行 import 与块内行
 * - Java returnType 提取留空（返回类型在方法名前，正则难以精确提取）
 * - 这些局限由 §4.6 US-ERR-003 单文件解析失败跳过机制兜底，不阻断整体扫描
 *
 * @module v2/codemap/regex-analyzer
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// 类型定义（与设计文档 §6.1 对齐）
// ============================================================================

/** 支持的语言（V2-P2 启用全部 6 语言：typescript/javascript/python/java/rust/go） */
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
// V2-P2 新增：Java/Rust/Go 正则规则集（自 quality 包 generator.ts 移植）
// ============================================================================

/**
 * Java 正则规则集
 *
 * 移植自 quality 包 analyzeJavaFile（generator.ts:851-970）。
 * Java 特性：
 * - 类/接口/枚举：[modifiers] class|interface|enum Name
 * - 方法：[modifiers] returnType name(params) { （仅在类内部，正则无法精确归属）
 * - 导入：import [static] fully.qualified.Name;
 * - 无显式导出（Java 通过 public 修饰符控制可见性，exports 恒为空数组）
 *
 * 已知局限：方法正则可能误匹配字符串/注释内的关键字，
 * 由 US-ERR-003 单文件解析失败跳过机制兜底。
 */
const JAVA_PATTERNS: LanguagePatterns = {
  // 类/接口/枚举：[public|private|protected] [abstract|final] class|interface|enum Name
  // 移植自 quality: /^(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?(?:class|interface|enum)\s+([A-Z]\w*)/
  classPattern: /(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?(?:class|interface|enum)\s+([A-Z]\w*)/,
  // 方法：[modifiers] returnType name(params) {
  // 移植自 quality: /^(?:public\s+|private\s+|protected\s+)?(?:static\s+|final\s+|synchronized\s+|abstract\s+)*[\w<>\[\]]+\s+([A-Z]\w*|[a-z]\w*)\s*\(/
  // 注意：Java 方法在类内部，正则无法精确归属，收集到 functions 列表
  // matchFunction 中通过 KEYWORDS 排除控制流关键字（if/for/while 等后跟括号的场景）
  functionPattern:
    /(?:public\s+|private\s+|protected\s+)?(?:static\s+|final\s+|synchronized\s+|abstract\s+)*[\w<>[\]]+\s+([A-Z]\w*|[a-z]\w*)\s*\(([^)]*)\)/,
  // 导入：import [static] fully.qualified.Name;
  // 移植自 quality: /^import\s+(?:static\s+)?([\w.]+);/
  importPattern: /^\s*import\s+(?:static\s+)?([\w.]+);/,
  // 导出：Java 无显式导出，置空匹配
  exportPattern: /$^/,
};

/**
 * Rust 正则规则集
 *
 * 移植自 quality 包 analyzeRustFile（generator.ts:1097-1193）。
 * Rust 特性：
 * - 结构体/枚举/trait：[pub] struct|enum|trait Name
 * - 函数：[pub] [async|const|unsafe] fn name(params) {
 * - 导入：use path::to::module;
 * - 无显式导出（Rust 通过 pub 修饰符控制可见性）
 */
const RUST_PATTERNS: LanguagePatterns = {
  // 结构体/枚举/trait：[pub] struct|enum|trait Name
  // 移植自 quality: /^(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/
  classPattern: /(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/,
  // 函数：[pub] [async|const|unsafe] fn name(params)
  // 移植自 quality: /^(?:pub\s+)?(?:async\s+|const\s+|unsafe\s+)?fn\s+(\w+)\s*[<(]/
  functionPattern: /(?:pub\s+)?(?:async\s+|const\s+|unsafe\s+)?fn\s+(\w+)\s*\(([^)]*)\)/,
  // 导入：use path::to::module;
  // 移植自 quality: /^use\s+([\w:]+)/
  importPattern: /^\s*use\s+([\w:]+)/,
  // 导出：Rust 无显式导出，置空匹配
  exportPattern: /$^/,
};

/**
 * Go 正则规则集
 *
 * 移植自 quality 包 analyzeGoFile（generator.ts:981-1086）。
 * Go 特性：
 * - 结构体：type Name struct {
 * - 函数：func [receiver] name(params) {
 * - 导入：import "path" 或 import ( "path1" "path2" )
 * - 无显式导出（Go 通过首字母大写控制可见性）
 *
 * 已知局限：Go import 块（import ( ... )）需状态ful解析，当前无状态逐行正则
 * 仅匹配单行 import 与块内行，块外字符串字面量可能误匹配（正则分析器固有局限，
 * 由 US-ERR-003 单文件解析失败跳过机制兜底）。
 */
const GO_PATTERNS: LanguagePatterns = {
  // 结构体：type Name struct {
  // 移植自 quality: /^type\s+([A-Z]\w*)\s+struct/
  classPattern: /type\s+([A-Z]\w*)\s+struct/,
  // 函数：func [receiver] name(params) {
  // 移植自 quality: /^func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?([A-Z]\w*|[a-z]\w*)\s*\(/
  functionPattern: /func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?([A-Z]\w*|[a-z]\w*)\s*\(([^)]*)\)/,
  // 导入：import "path" 或块内 "path" 行
  // 移植自 quality: 单行 /^import\s+"([^"]+)"/ + 块内 /"([^"]+)"/
  importPattern: /^\s*(?:import\s+)?"([^"]+)"/,
  // 导出：Go 无显式导出，置空匹配
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
   * @param language 目标语言（V2-P2 启用全部 6 语言：TS/JS/Python/Java/Rust/Go）
   * @throws {Error} 当 language 不在 6 语言支持列表时抛错（SupportedLanguage 类型已约束，不应触达）
   */
  constructor(language: SupportedLanguage) {
    this.language = language;
    this.patterns = RegexASTAnalyzer.getPatterns(language);
  }

  /**
   * 获取语言对应的正则规则集
   *
   * V2-P2 启用全部 6 语言（TS/JS/Python/Java/Rust/Go）。
   *
   * @param language 语言类型
   * @returns 正则规则集
   * @throws {Error} 当语言不在 6 语言支持列表时抛错（fail-fast，类型已约束不应触达）
   */
  private static getPatterns(language: SupportedLanguage): LanguagePatterns {
    switch (language) {
      case "typescript":
      case "javascript":
        return TS_JS_PATTERNS;
      case "python":
        return PYTHON_PATTERNS;
      case "java":
        return JAVA_PATTERNS;
      case "rust":
        return RUST_PATTERNS;
      case "go":
        return GO_PATTERNS;
      default:
        // 6 语言之外的值不应出现（SupportedLanguage 类型已约束）
        throw new Error(`RegexASTAnalyzer: 不支持的语言 ${language}`);
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
   * 匹配类定义（V2-P2 升级：语言感知 type 检测）
   *
   * V2-P1 仅区分 interface vs class（line.includes("interface")）。
   * V2-P2 扩展为支持 class/interface/struct/enum 四型：
   * - TS/JS：interface → "interface"，其余 → "class"
   * - Python：恒 → "class"
   * - Java：interface → "interface"，enum → "enum"，其余 → "class"
   * - Rust：struct → "struct"，enum → "enum"，trait → "interface"，其余 → "class"
   * - Go：恒 → "struct"（Go type X struct）
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
    // 语言感知 type 检测（V2-P2 升级，支持 class/interface/struct/enum 四型）
    const type = this.detectClassType(line);
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
   * 检测类/结构体/枚举/接口类型（V2-P2 新增，语言感知）
   *
   * 根据 language 与当前行关键字判定 ClassInfo["type"]：
   * - TS/JS：interface 关键字 → "interface"，其余 → "class"
   * - Python：恒 → "class"（Python 仅有 class）
   * - Java：interface → "interface"，enum → "enum"，其余 → "class"
   * - Rust：struct → "struct"，enum → "enum"，trait → "interface"（trait 语义最接近 interface），其余 → "class"
   * - Go：恒 → "struct"（Go type X struct 形态固定）
   *
   * @param line 当前行文本
   * @returns ClassInfo["type"] 联合类型之一
   */
  private detectClassType(line: string): ClassInfo["type"] {
    switch (this.language) {
      case "typescript":
      case "javascript":
        return line.includes("interface") ? "interface" : "class";
      case "python":
        return "class";
      case "java":
        if (line.includes("interface")) return "interface";
        if (line.includes("enum")) return "enum";
        return "class";
      case "rust":
        if (line.includes("struct")) return "struct";
        if (line.includes("enum")) return "enum";
        if (/\btrait\b/.test(line)) return "interface";
        return "class";
      case "go":
        return "struct";
      default:
        return "class";
    }
  }

  /**
   * 匹配函数定义
   *
   * V2-P2 升级：增加 Java 控制流关键字排除（P1-3 架构师建议）。
   * Java functionPattern 含前置 returnType 捕获组，可能误匹配
   * "return foo(args)" / "else if (cond)" 等控制流语句。
   * 通过 KEYWORDS 集合排除这些误匹配（复用既有 KEYWORDS Set）。
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
    // Java/Rust/Go：match[1]=name, match[2]=params（与 TS/JS 一致）
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

    // V2-P2 新增：Java 关键字排除（P1-3 架构师建议）
    // Java functionPattern 含前置 returnType，可能误匹配 "return foo(args)" / "else if (cond)"
    // 通过 KEYWORDS 集合排除控制流关键字（if/for/while/return 等）
    if (this.language === "java" && KEYWORDS.has(name)) {
      return;
    }

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
   * 各语言返回类型位置不同：
   * - TS/JS：`function name(params): ReturnType {` — 返回类型在 ) 后
   * - Python：`def name(params) -> ReturnType:` — 返回类型在 ) 后，用 -> 标记
   * - Java：`returnType name(params) {` — 返回类型在 name 前（正则难以精确提取，返回空串）
   * - Rust：`fn name(params) -> ReturnType {` — 返回类型在 ) 后，用 -> 标记
   * - Go：`func name(params) ReturnType {` — 返回类型在 ) 后，无标记符号
   *
   * @param line 当前行文本
   * @returns 返回类型字符串；提取不到返回空串
   */
  private extractReturnType(line: string): string {
    switch (this.language) {
      case "python":
        // Python: def foo(...) -> ReturnType:
        return line.match(/->\s*([^:]+):/)?.[1]?.trim() ?? "";
      case "rust":
        // Rust: fn foo(...) -> ReturnType { 或 fn foo(...) -> ReturnType {
        return line.match(/->\s*([^{]+)/)?.[1]?.trim() ?? "";
      case "go":
        // Go: func foo(params) ReturnType { — 返回类型在 ) 和 { 之间
        return line.match(/\)\s+(\w+)\s*\{/)?.[1]?.trim() ?? "";
      case "java":
        // Java: returnType name(params) { — 返回类型在 name 前
        // 正则难以精确提取（需解析 modifiers + returnType 前缀），
        // V2-P2 范围内返回空串（YAGNI，测试用例不要求 Java returnType）
        return "";
      default:
        // TS/JS: function foo(...): ReturnType { 或 ): ReturnType;
        return line.match(/\)\s*:\s*([^{;]+)[{;]/)?.[1]?.trim() ?? "";
    }
  }
}
