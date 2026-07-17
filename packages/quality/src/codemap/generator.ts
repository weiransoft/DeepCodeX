/**
 * 代码地图生成器（V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/code_map_generator_v2.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 核心能力:
 *   1. 多语言支持：TypeScript / JavaScript / Python / Java / Go / Rust / C/C++ / C# / PHP / Shell
 *   2. 代码元素提取：类、函数、接口、模块、配置
 *   3. 依赖关系追踪：import / require / package 导入图
 *   4. 复杂度评估：圈复杂度近似（控制流关键词计数）
 *   5. 死代码检测：无入边的节点（孤儿模块）
 *   6. Markdown 输出：人 + AI 双可读的代码地图
 *   7. JSON 输出：用于程序化消费
 *
 * 设计原则:
 *   - 标准库优先：仅依赖 node:fs / node:path，正则匹配语法元素
 *   - 失败安全：单文件分析失败不影响整图生成
 *   - 性能可控：可配置最大文件数 / 最大行数限制
 */

// 同步 fs / path 导入（用于 resolveImportPath 同步检测文件存在性）
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

// ============================================================================
// 数据模型
// ============================================================================

/** 代码元素（函数 / 方法 / 类 / 接口） */
export interface CodeNode {
  /** 节点 ID：file::symbolName */
  id: string;
  /** 节点类型 */
  kind: "function" | "method" | "class" | "interface" | "module" | "file" | "variable" | "constant";
  /** 元素名（如函数名、类名） */
  name: string;
  /** 所属文件路径（绝对） */
  filePath: string;
  /** 所属文件相对路径（相对 projectRoot） */
  relativePath: string;
  /** 起始行（1-based） */
  lineStart: number;
  /** 结束行（1-based） */
  lineEnd: number;
  /** 圈复杂度（近似） */
  complexity: number;
  /** 复杂度等级：low (≤5) / medium (6-10) / high (>10) */
  complexityLevel: "low" | "medium" | "high";
  /** 文档注释（若有） */
  docstring: string;
  /** 父节点 ID（方法属于类时） */
  parentId: string | null;
}

/** 依赖关系边 */
export interface CodeEdge {
  /** 源节点 ID（被引用者，语义上"被指向"的目标） */
  from: string;
  /** 目标节点 ID（引用方，语义上"指向"的来源） */
  to: string;
  /** 边类型 */
  kind: "imports" | "extends" | "implements" | "calls" | "uses";
  /** 引用所在文件 */
  sourceFile: string;
  /** 引用所在行 */
  sourceLine: number;
  /**
   * 具名导入的符号列表（仅对 imports 边有效）
   *
   * 用于死代码检测的精细化匹配：当 file 被 import 引用时，仅当 importedSymbols
   * 包含该 file 内某节点的 name 时，该节点才继承入度（不被视为死代码）。
   *
   * 示例：
   *   - `import { Service } from "./v2"` → importedSymbols: ["Service"]
   *   - `import { A, B as B2 } from "./v2"` → importedSymbols: ["A", "B"]
   *   - `import * as V2 from "./v2"` → importedSymbols: ["*"]（表示全部）
   *   - `import "./v2"` → importedSymbols: []（仅副作用）
   */
  importedSymbols?: string[];
}

/** 代码地图汇总 */
export interface CodeMap {
  /** 项目名 */
  projectName: string;
  /** 项目根路径 */
  projectRoot: string;
  /** 生成时间 ISO 字符串 */
  generatedAt: string;
  /** 节点列表（按文件分组） */
  nodes: CodeNode[];
  /** 边列表 */
  edges: CodeEdge[];
  /** 统计 */
  stats: CodeMapStats;
}

/** 代码地图统计 */
export interface CodeMapStats {
  /** 文件总数 */
  fileCount: number;
  /** 目录总数 */
  directoryCount: number;
  /** 节点总数（按 kind 分组） */
  nodesByKind: Record<CodeNode["kind"], number>;
  /** 边总数（按 kind 分组） */
  edgesByKind: Record<CodeEdge["kind"], number>;
  /** 各语言文件数 */
  languageBreakdown: Record<string, number>;
  /** 平均圈复杂度 */
  avgComplexity: number;
  /** 最高圈复杂度节点 */
  topComplexNodes: Array<{ id: string; complexity: number; name: string; filePath: string }>;
  /** 死代码候选（无入边的节点） */
  deadCodeCandidates: string[];
  /** 总行数 */
  totalLines: number;
}

/** 代码地图生成器配置 */
export interface CodeMapOptions {
  /** 项目根目录 */
  projectRoot: string;
  /** 分析范围（子目录白名单，可选） */
  scope?: string;
  /** 要跳过的目录名（默认：node_modules, .git, dist, build, target） */
  skipDirs?: string[];
  /** 要分析的文件扩展名（默认：.ts .tsx .js .jsx .py .java .go .rs .cpp .h .cs .php .sh） */
  includeExtensions?: string[];
  /** 最大文件数（防止巨型项目内存爆炸） */
  maxFiles?: number;
  /** 单文件最大行数（超出则仅分析前 N 行） */
  maxLinesPerFile?: number;
  /** 是否生成 Markdown 输出（默认 true） */
  generateMarkdown?: boolean;
  /** 是否生成 JSON 输出（默认 true） */
  generateJson?: boolean;
  /** Markdown 输出路径（可选） */
  markdownOutputPath?: string;
  /** JSON 输出路径（可选） */
  jsonOutputPath?: string;
}

// ============================================================================
// 代码地图生成器
// ============================================================================

/**
 * 代码地图生成器
 *
 * 用法：
 *   const gen = new CodeMapGenerator({ projectRoot: "/path/to/project" });
 *   const map = await gen.generate();
 *   await gen.dump(map);
 */
export class CodeMapGenerator {
  // 默认配置
  static readonly DEFAULT_SKIP_DIRS = [
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    "__pycache__",
    ".next",
    ".nuxt",
    "coverage",
    ".turbo",
    ".gradle",
    "out",
    "vendor",
    "venv",
    ".venv",
    "env",
  ];
  static readonly DEFAULT_INCLUDE_EXTS = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".java",
    ".go",
    ".rs",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".php",
    ".sh",
    ".bash",
    ".zsh",
    ".rb",
    ".kt",
    ".swift",
  ];
  static readonly DEFAULT_MAX_FILES = 5000;
  static readonly DEFAULT_MAX_LINES = 5000;
  /**
   * 入口文件命名约定（业界通用）
   * 入口文件作为应用启动点，未被 import 是合理的
   * 这些文件内的顶层 class/function 不会被识别为死代码
   */
  static readonly ENTRY_FILE_NAMES = new Set([
    "main",
    "index",
    "app",
    "server",
    "cli",
    "entry",
    "start",
    "Main",
    "App",
    "Server",
    "Application",
  ]);

  /** 项目根路径 */
  private readonly projectRoot: string;
  /** 跳过的目录 */
  private readonly skipDirs: Set<string>;
  /** 包含的文件扩展名 */
  private readonly includeExts: Set<string>;
  /** 最大文件数 */
  private readonly maxFiles: number;
  /** 单文件最大行数 */
  private readonly maxLinesPerFile: number;
  /** 分析范围 */
  private readonly scope: string | null;
  /** 配置 */
  private readonly options: CodeMapOptions;

  constructor(options: CodeMapOptions) {
    this.options = options;
    this.projectRoot = options.projectRoot;
    this.skipDirs = new Set(options.skipDirs ?? CodeMapGenerator.DEFAULT_SKIP_DIRS);
    this.includeExts = new Set(options.includeExtensions ?? CodeMapGenerator.DEFAULT_INCLUDE_EXTS);
    this.maxFiles = options.maxFiles ?? CodeMapGenerator.DEFAULT_MAX_FILES;
    this.maxLinesPerFile = options.maxLinesPerFile ?? CodeMapGenerator.DEFAULT_MAX_LINES;
    this.scope = options.scope ?? null;
  }

  // ==========================================================================
  // 主入口
  // ==========================================================================

  /**
   * 执行完整代码地图生成
   *
   * 流程：
   *   1. 递归扫描目录
   *   2. 解析每个文件（按语言分派）
   *   3. 提取节点 + 边
   *   4. 计算统计 + 死代码检测
   *   5. 返回 CodeMap
   */
  async generate(): Promise<CodeMap> {
    const nodes: CodeNode[] = [];
    const edges: CodeEdge[] = [];
    const fileCount = { value: 0 };
    const dirCount = { value: 0 };
    const languageBreakdown: Record<string, number> = {};
    const totalLines = { value: 0 };

    // 1) 递归扫描目录
    const filePaths: string[] = [];
    await this.scanDir(this.projectRoot, filePaths, dirCount);

    // 2) 解析每个文件
    for (const absPath of filePaths) {
      if (fileCount.value >= this.maxFiles) {
        this.warn(`达到最大文件数限制 ${this.maxFiles}，停止分析`);
        break;
      }
      const rel = CodeMapGenerator.toRelative(this.projectRoot, absPath);
      const ext = CodeMapGenerator.extOf(absPath);
      const lang = CodeMapGenerator.langOfExt(ext);
      languageBreakdown[lang] = (languageBreakdown[lang] ?? 0) + 1;
      fileCount.value++;

      try {
        const result = await this.analyzeFile(absPath, rel, ext, lang);
        nodes.push(...result.nodes);
        edges.push(...result.edges);
        totalLines.value += result.lineCount;
      } catch (err) {
        this.warn(`分析文件失败: ${rel} - ${CodeMapGenerator.errMsg(err)}`);
      }
    }

    // 3) 构建统计
    const stats = this.buildStats(nodes, edges, fileCount.value, dirCount.value, languageBreakdown, totalLines.value);

    return {
      projectName: CodeMapGenerator.basename(this.projectRoot),
      projectRoot: this.projectRoot,
      generatedAt: new Date().toISOString(),
      nodes,
      edges,
      stats,
    };
  }

  // ==========================================================================
  // 目录扫描
  // ==========================================================================

  /**
   * 递归扫描目录，收集所有待分析的文件路径
   *
   * @param dir 当前目录绝对路径
   * @param filePaths 输出文件路径列表
   * @param dirCount 目录计数（输出）
   */
  private async scanDir(dir: string, filePaths: string[], dirCount: { value: number }): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      this.warn(`读取目录失败: ${dir} - ${CodeMapGenerator.errMsg(err)}`);
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".deepcodex") {
        // 跳过隐藏目录（.git, .next 等），但允许 .deepcodex
        continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (this.skipDirs.has(entry.name)) continue;
        // scope 限制
        if (this.scope && !abs.includes(this.scope)) continue;
        dirCount.value++;
        await this.scanDir(abs, filePaths, dirCount);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (this.includeExts.has(ext)) {
          filePaths.push(abs);
        }
      }
    }
  }

  // ==========================================================================
  // 文件分析（按语言分派）
  // ==========================================================================

  /**
   * 分析单个文件
   *
   * 入口：读取文件 → 按扩展名分派 → 解析节点和边
   */
  private async analyzeFile(
    absPath: string,
    relPath: string,
    ext: string,
    lang: string
  ): Promise<{ nodes: CodeNode[]; edges: CodeEdge[]; lineCount: number }> {
    const fs = await import("node:fs/promises");
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch (err) {
      this.warn(`读取文件失败: ${relPath} - ${CodeMapGenerator.errMsg(err)}`);
      return { nodes: [], edges: [], lineCount: 0 };
    }

    // 截断超大文件
    const allLines = content.split(/\r?\n/);
    const lineCount = allLines.length;
    const lines = allLines.slice(0, this.maxLinesPerFile);
    const contentSlice = lines.join("\n");

    // 文件级节点
    const fileNode: CodeNode = {
      id: `file::${relPath}`,
      kind: "file",
      name: CodeMapGenerator.basename(relPath),
      filePath: absPath,
      relativePath: relPath,
      lineStart: 1,
      lineEnd: lineCount,
      complexity: 0,
      complexityLevel: "low",
      docstring: "",
      parentId: null,
    };

    // 按语言分派
    let nodes: CodeNode[] = [fileNode];
    let edges: CodeEdge[] = [];
    if (lang === "typescript" || lang === "javascript") {
      ({ nodes, edges } = this.analyzeJsLikeFile(absPath, relPath, contentSlice, lines, fileNode));
    } else if (lang === "python") {
      ({ nodes, edges } = this.analyzePythonFile(absPath, relPath, contentSlice, lines, fileNode));
    } else if (lang === "java") {
      ({ nodes, edges } = this.analyzeJavaFile(absPath, relPath, contentSlice, lines, fileNode));
    } else if (lang === "go") {
      ({ nodes, edges } = this.analyzeGoFile(absPath, relPath, contentSlice, lines, fileNode));
    } else if (lang === "rust") {
      ({ nodes, edges } = this.analyzeRustFile(absPath, relPath, contentSlice, lines, fileNode));
    } else {
      // 其他语言：仅文件级节点
    }

    return { nodes, edges, lineCount };
  }

  // ==========================================================================
  // 静态工具：解析 import 语句的具名符号
  // ==========================================================================

  /**
   * 解析 import 语句中具名导入的符号列表
   *
   * 支持的语法：
   *   - `import { A, B as C } from "./m"` → ["A", "B"]（as 别名取原始名）
   *   - `import * as M from "./m"` → ["*"]（命名空间导入，匹配所有符号）
   *   - `import D from "./m"` → ["D"]（默认导入）
   *   - `import "./m"` → []（仅副作用，不算引用任何符号）
   *   - `export { A, B } from "./m"` → ["A", "B"]（re-export）
   *
   * @param trimmed 已 trim 的 import 语句
   * @returns 具名符号列表（去重）
   */
  static parseImportSymbols(trimmed: string): string[] {
    const symbols: string[] = [];
    // 形式 1: 具名导入 { A, B as C }
    const braceMatch = /import\s*\{([^}]+)\}/.exec(trimmed);
    if (braceMatch) {
      const items = braceMatch[1]!.split(",");
      for (const item of items) {
        // 提取原始名（忽略 as 后面的别名）
        const name = item
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim();
        if (name && !symbols.includes(name)) symbols.push(name);
      }
      return symbols;
    }
    // 形式 2: 命名空间导入 * as M
    if (/^import\s+\*\s+as\s+/.test(trimmed)) {
      return ["*"];
    }
    // 形式 3: 默认导入 D from "..."
    const defaultMatch = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+/.exec(trimmed);
    if (defaultMatch) {
      return [defaultMatch[1]!];
    }
    // 形式 4: 副作用导入 import "..." → 空数组
    return [];
  }

  /**
   * 解析 Python import 语句的具名符号
   *
   * 支持：
   *   - `from .m import A, B as C` → ["A", "B"]
   *   - `from .m import *` → ["*"]
   *   - `import .m` / `import .m as N` → ["*"]（整体导入）
   */
  static parsePythonImportSymbols(trimmed: string): string[] {
    const symbols: string[] = [];
    // 形式 1: from X import A, B as C
    const fromMatch = /^from\s+[\w.]+\s+import\s+(.+)$/.exec(trimmed);
    if (fromMatch) {
      const items = fromMatch[1]!.split(",");
      for (const item of items) {
        const name = item
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim();
        if (name === "*") return ["*"];
        if (name && !symbols.includes(name)) symbols.push(name);
      }
      return symbols;
    }
    // 形式 2: import X (整体导入)
    if (/^import\s+[\w.]+/.test(trimmed)) {
      return ["*"];
    }
    return symbols;
  }

  // ==========================================================================
  // TypeScript / JavaScript 分析
  // ==========================================================================

  /**
   * 分析 TS/JS 文件
   *
   * 提取：import 依赖、function、class、interface、type alias、export
   */
  private analyzeJsLikeFile(
    absPath: string,
    relPath: string,
    content: string,
    lines: string[],
    fileNode: CodeNode
  ): { nodes: CodeNode[]; edges: CodeEdge[] } {
    const nodes: CodeNode[] = [fileNode];
    const edges: CodeEdge[] = [];
    // 块注释中的 docstring
    let lastDoc: string = "";
    // 当前 class 名（用于绑定 method 的 parentId）
    let currentClass: string | null = null;
    // 当前 class 的结束行（lineNo 超出后重置 currentClass）
    let currentClassEndLine: number = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNo = i + 1;
      const trimmed = line.trim();

      // 提取块注释 (/** ... */) 作为 docstring
      const blockMatch = /^\/\*\*\s*([\s\S]*?)\s*\*\//.exec(trimmed);
      if (blockMatch) {
        lastDoc = blockMatch[1]!.replace(/^\s*\*\s?/gm, "").trim();
        continue;
      }
      // 单行 // 注释（仅作为 docstring，不重置）
      if (trimmed.startsWith("//") && !trimmed.startsWith("///")) {
        if (!lastDoc) lastDoc = trimmed.slice(2).trim();
        continue;
      }

      // import 语句
      const importMatch = /^(?:import|export)\s+(?:.*?from\s+)?["']([^"']+)["']/.exec(trimmed);
      if (importMatch) {
        const target = importMatch[1]!;
        // 解析 import 语句中的具名符号（用于死代码检测的精细化匹配）
        const importedSymbols = CodeMapGenerator.parseImportSymbols(trimmed);
        // 始终推送 module:: 形式的边（保留原始模块路径，用于跨文件依赖图）
        edges.push({
          from: `module::${target}`,
          to: fileNode.id,
          kind: "imports",
          sourceFile: absPath,
          sourceLine: lineNo,
          importedSymbols: importedSymbols.length > 0 ? importedSymbols : undefined,
        });
        // 如果能解析到具体本地文件，再推送 file:: 形式的边
        // 这条边用于死代码检测：被 import 的 file 节点有入边
        if (target.startsWith(".")) {
          const targetAbs = CodeMapGenerator.resolveImportPath(absPath, target);
          if (targetAbs) {
            const targetRel = CodeMapGenerator.toRelative(this.projectRoot, targetAbs);
            edges.push({
              from: `file::${targetRel}`,
              to: fileNode.id,
              kind: "imports",
              sourceFile: absPath,
              sourceLine: lineNo,
              importedSymbols: importedSymbols.length > 0 ? importedSymbols : undefined,
            });
          }
        }
        continue;
      }

      // const/let/var 顶层声明（变量/常量）
      const constMatch = /^(?:export\s+)?(?:const|let|var)\s+([A-Z_][A-Z0-9_]*|[a-z_][a-zA-Z0-9_]*)\s*[=:]/.exec(
        trimmed
      );
      if (constMatch) {
        const name = constMatch[1]!;
        const isConst = /[A-Z_][A-Z0-9_]*$/.test(name);
        nodes.push({
          id: `var::${relPath}::${name}`,
          kind: isConst ? "constant" : "variable",
          name,
          filePath: absPath,
          relativePath: relPath,
          lineStart: lineNo,
          lineEnd: lineNo,
          complexity: 0,
          complexityLevel: "low",
          docstring: lastDoc,
          parentId: null,
        });
        lastDoc = "";
        continue;
      }

      // function 声明
      const fnMatch = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/.exec(trimmed);
      if (fnMatch) {
        const name = fnMatch[1]!;
        const endLine = this.findBlockEnd(lines, i);
        const body = lines.slice(i, endLine).join("\n");
        const complexity = this.estimateComplexity(body);
        nodes.push({
          id: `func::${relPath}::${name}`,
          kind: "function",
          name,
          filePath: absPath,
          relativePath: relPath,
          lineStart: lineNo,
          lineEnd: endLine,
          complexity,
          complexityLevel: this.complexityLevel(complexity),
          docstring: lastDoc,
          parentId: null,
        });
        lastDoc = "";
        continue;
      }

      // class 声明
      const classMatch = /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
      if (classMatch) {
        const name = classMatch[1]!;
        const endLine = this.findBlockEnd(lines, i);
        const body = lines.slice(i, endLine).join("\n");
        const complexity = this.estimateComplexity(body);
        currentClass = name;
        // 记录类结束行（基于 findBlockEnd 的精确位置），用于判断类是否结束
        currentClassEndLine = endLine;
        nodes.push({
          id: `class::${relPath}::${name}`,
          kind: "class",
          name,
          filePath: absPath,
          relativePath: relPath,
          lineStart: lineNo,
          lineEnd: endLine,
          complexity,
          complexityLevel: this.complexityLevel(complexity),
          docstring: lastDoc,
          parentId: null,
        });
        // 提取 extends / implements
        const extMatch = /(?:extends|implements)\s+([A-Za-z_$][\w$,\s]*)/.exec(trimmed);
        if (extMatch) {
          for (const base of extMatch[1]!.split(",")) {
            const baseName = base.trim();
            if (baseName) {
              edges.push({
                from: `class::${relPath}::${baseName}`,
                to: `class::${relPath}::${name}`,
                kind: /extends/i.test(trimmed) ? "extends" : "implements",
                sourceFile: absPath,
                sourceLine: lineNo,
              });
            }
          }
        }
        lastDoc = "";
        continue;
      }

      // interface / type 声明
      const ifaceMatch = /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
      if (ifaceMatch) {
        const name = ifaceMatch[1]!;
        const endLine = this.findBlockEnd(lines, i);
        nodes.push({
          id: `iface::${relPath}::${name}`,
          kind: "interface",
          name,
          filePath: absPath,
          relativePath: relPath,
          lineStart: lineNo,
          lineEnd: endLine,
          complexity: 0,
          complexityLevel: "low",
          docstring: lastDoc,
          parentId: null,
        });
        lastDoc = "";
        continue;
      }

      // method（在 class 内部）
      if (currentClass !== null) {
        const methodMatch = /^(?:public\s+|private\s+|protected\s+|async\s+|static\s+)*([A-Za-z_$][\w$]*)\s*[(<]/.exec(
          trimmed
        );
        // 必须包含括号，才视为 method（避免误判属性）
        if (
          methodMatch &&
          /[<(]/.test(trimmed) &&
          !trimmed.startsWith("if") &&
          !trimmed.startsWith("for") &&
          !trimmed.startsWith("while") &&
          !trimmed.startsWith("return")
        ) {
          const name = methodMatch[1]!;
          if (name !== currentClass) {
            // 排除构造函数同名
            const endLine = this.findBlockEnd(lines, i);
            const body = lines.slice(i, endLine).join("\n");
            const complexity = this.estimateComplexity(body);
            nodes.push({
              id: `method::${relPath}::${currentClass}.${name}`,
              kind: "method",
              name,
              filePath: absPath,
              relativePath: relPath,
              lineStart: lineNo,
              lineEnd: endLine,
              complexity,
              complexityLevel: this.complexityLevel(complexity),
              docstring: lastDoc,
              parentId: `class::${relPath}::${currentClass}`,
            });
            lastDoc = "";
            continue;
          }
        }
      }

      // 重置 lastDoc 当遇到空行
      if (trimmed === "") {
        lastDoc = "";
      }

      // class 结束时（行号超过 classEndLine）重置 currentClass
      // 注：不能用大括号差值判断（方法体内部嵌套的 } 会错误地提前重置 currentClass）
      if (currentClass !== null && lineNo > currentClassEndLine) {
        currentClass = null;
        currentClassEndLine = 0;
      }
    }

    return { nodes, edges };
  }

  // ==========================================================================
  // Python 分析
  // ==========================================================================

  /**
   * 分析 Python 文件
   *
   * 提取：import 依赖、def、class、async def
   */
  private analyzePythonFile(
    absPath: string,
    relPath: string,
    content: string,
    lines: string[],
    fileNode: CodeNode
  ): { nodes: CodeNode[]; edges: CodeEdge[] } {
    const nodes: CodeNode[] = [fileNode];
    const edges: CodeEdge[] = [];
    let lastDoc = "";
    let currentClass: string | null = null;
    let classIndent = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNo = i + 1;
      const indent = line.length - line.trimStart().length;
      const trimmed = line.trim();

      // docstring
      if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        lastDoc = trimmed.replace(/['"]{3}/g, "").trim();
        continue;
      }
      if (trimmed.startsWith("#")) {
        if (!lastDoc) lastDoc = trimmed.slice(1).trim();
        continue;
      }

      // import
      const importMatch = /^(?:from\s+([\w.]+)\s+)?import\s+([\w.,\s]+)/.exec(trimmed);
      if (importMatch) {
        const module = importMatch[1] ?? importMatch[2]!.split(",")[0]!.trim();
        // 解析 Python import 语句的具名符号
        const importedSymbols = CodeMapGenerator.parsePythonImportSymbols(trimmed);
        edges.push({
          from: `module::${module}`,
          to: fileNode.id,
          kind: "imports",
          sourceFile: absPath,
          sourceLine: lineNo,
          importedSymbols: importedSymbols.length > 0 ? importedSymbols : undefined,
        });
        continue;
      }

      // async def / def
      const fnMatch = /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/.exec(trimmed);
      if (fnMatch && indent === 0) {
        const name = fnMatch[1]!;
        const endLine = this.findPythonBlockEnd(lines, i);
        const body = lines.slice(i, endLine).join("\n");
        const complexity = this.estimateComplexity(body);
        nodes.push({
          id: `func::${relPath}::${name}`,
          kind: "function",
          name,
          filePath: absPath,
          relativePath: relPath,
          lineStart: lineNo,
          lineEnd: endLine,
          complexity,
          complexityLevel: this.complexityLevel(complexity),
          docstring: lastDoc,
          parentId: null,
        });
        lastDoc = "";
        continue;
      }

      // class
      const classMatch = /^class\s+([A-Za-z_][\w]*)/.exec(trimmed);
      if (classMatch && indent === 0) {
        const name = classMatch[1]!;
        currentClass = name;
        classIndent = indent;
        const endLine = this.findPythonBlockEnd(lines, i);
        const body = lines.slice(i, endLine).join("\n");
        const complexity = this.estimateComplexity(body);
        nodes.push({
          id: `class::${relPath}::${name}`,
          kind: "class",
          name,
          filePath: absPath,
          relativePath: relPath,
          lineStart: lineNo,
          lineEnd: endLine,
          complexity,
          complexityLevel: this.complexityLevel(complexity),
          docstring: lastDoc,
          parentId: null,
        });
        // 提取基类
        const baseMatch = /class\s+\w+\s*\(([\w\s,]+)\)/.exec(trimmed);
        if (baseMatch) {
          for (const base of baseMatch[1]!.split(",")) {
            const baseName = base.trim();
            if (baseName && baseName !== "object") {
              edges.push({
                from: `class::${relPath}::${baseName}`,
                to: `class::${relPath}::${name}`,
                kind: "extends",
                sourceFile: absPath,
                sourceLine: lineNo,
              });
            }
          }
        }
        lastDoc = "";
        continue;
      }

      // method (在 class 内，缩进 > classIndent)
      if (currentClass !== null && indent > classIndent) {
        const methodMatch = /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/.exec(trimmed);
        if (methodMatch) {
          const name = methodMatch[1]!;
          if (name !== currentClass && !name.startsWith("__")) {
            // 排除构造函数同名（实际是 __init__）
            const endLine = this.findPythonBlockEnd(lines, i);
            const body = lines.slice(i, endLine).join("\n");
            const complexity = this.estimateComplexity(body);
            nodes.push({
              id: `method::${relPath}::${currentClass}.${name}`,
              kind: "method",
              name,
              filePath: absPath,
              relativePath: relPath,
              lineStart: lineNo,
              lineEnd: endLine,
              complexity,
              complexityLevel: this.complexityLevel(complexity),
              docstring: lastDoc,
              parentId: `class::${relPath}::${currentClass}`,
            });
            lastDoc = "";
            continue;
          }
        }
      }

      // class 结束（回到顶层）
      if (
        currentClass !== null &&
        indent === 0 &&
        trimmed !== "" &&
        !trimmed.startsWith("class ") &&
        !trimmed.startsWith("def ")
      ) {
        currentClass = null;
        classIndent = -1;
      }

      if (trimmed === "") lastDoc = "";
    }

    return { nodes, edges };
  }

  // ==========================================================================
  // Java 分析
  // ==========================================================================

  /**
   * 分析 Java 文件
   *
   * 提取：import、package、class、interface、enum、method
   */
  private analyzeJavaFile(
    absPath: string,
    relPath: string,
    content: string,
    lines: string[],
    fileNode: CodeNode
  ): { nodes: CodeNode[]; edges: CodeEdge[] } {
    const nodes: CodeNode[] = [fileNode];
    const edges: CodeEdge[] = [];
    let lastDoc = "";
    let currentClass: string | null = null;
    let packageName = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNo = i + 1;
      const trimmed = line.trim();

      // 块注释
      const blockMatch = /^\/\*\*?\s*([\s\S]*?)\s*\*\//.exec(trimmed);
      if (blockMatch) {
        lastDoc = blockMatch[1]!.replace(/^\s*\*\s?/gm, "").trim();
        continue;
      }
      if (trimmed.startsWith("//")) {
        if (!lastDoc) lastDoc = trimmed.slice(2).trim();
        continue;
      }

      // package
      const pkgMatch = /^package\s+([\w.]+);/.exec(trimmed);
      if (pkgMatch) {
        packageName = pkgMatch[1]!;
        continue;
      }

      // import
      const importMatch = /^import\s+(?:static\s+)?([\w.]+);/.exec(trimmed);
      if (importMatch) {
        edges.push({
          from: `module::${importMatch[1]}`,
          to: fileNode.id,
          kind: "imports",
          sourceFile: absPath,
          sourceLine: lineNo,
        });
        continue;
      }

      // class / interface / enum
      const typeMatch =
        /^(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?(?:class|interface|enum)\s+([A-Z]\w*)/.exec(
          trimmed
        );
      if (typeMatch) {
        const name = typeMatch[1]!;
        const isInterface = trimmed.startsWith("interface") || trimmed.includes(" interface ");
        currentClass = name;
        const endLine = this.findBlockEnd(lines, i);
        const body = lines.slice(i, endLine).join("\n");
        const complexity = this.estimateComplexity(body);
        nodes.push({
          id: `${isInterface ? "iface" : "class"}::${relPath}::${name}`,
          kind: isInterface ? "interface" : "class",
          name,
          filePath: absPath,
          relativePath: relPath,
          lineStart: lineNo,
          lineEnd: endLine,
          complexity,
          complexityLevel: this.complexityLevel(complexity),
          docstring: lastDoc,
          parentId: null,
        });
        // extends / implements
        const extMatch = /(?:extends|implements)\s+([A-Z]\w*)/.exec(trimmed);
        if (extMatch) {
          edges.push({
            from: `class::${relPath}::${extMatch[1]}`,
            to: `${isInterface ? "iface" : "class"}::${relPath}::${name}`,
            kind: /extends/.test(trimmed) ? "extends" : "implements",
            sourceFile: absPath,
            sourceLine: lineNo,
          });
        }
        lastDoc = "";
        continue;
      }

      // method
      if (currentClass !== null) {
        const methodMatch =
          /^(?:public\s+|private\s+|protected\s+)?(?:static\s+|final\s+|synchronized\s+|abstract\s+)*[\w<>[\]]+\s+([A-Z]\w*|[a-z]\w*)\s*\(/.exec(
            trimmed
          );
        if (methodMatch && !trimmed.includes("=") && !trimmed.endsWith(";") && /[{}]/.test(trimmed)) {
          const name = methodMatch[1]!;
          // 跳过构造器（同名）
          if (name !== currentClass) {
            const endLine = this.findBlockEnd(lines, i);
            const body = lines.slice(i, endLine).join("\n");
            const complexity = this.estimateComplexity(body);
            nodes.push({
              id: `method::${relPath}::${currentClass}.${name}`,
              kind: "method",
              name,
              filePath: absPath,
              relativePath: relPath,
              lineStart: lineNo,
              lineEnd: endLine,
              complexity,
              complexityLevel: this.complexityLevel(complexity),
              docstring: lastDoc,
              parentId: `class::${relPath}::${currentClass}`,
            });
            lastDoc = "";
            continue;
          }
        }
      }

      if (trimmed === "") lastDoc = "";
    }
    void packageName;
    return { nodes, edges };
  }

  // ==========================================================================
  // Go 分析（轻量级）
  // ==========================================================================

  /**
   * 分析 Go 文件
   *
   * 提取：import、func、type struct
   */
  private analyzeGoFile(
    absPath: string,
    relPath: string,
    content: string,
    lines: string[],
    fileNode: CodeNode
  ): { nodes: CodeNode[]; edges: CodeEdge[] } {
    const nodes: CodeNode[] = [fileNode];
    const edges: CodeEdge[] = [];
    let lastDoc = "";
    let inImportBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNo = i + 1;
      const trimmed = line.trim();

      if (trimmed.startsWith("//")) {
        if (!lastDoc) lastDoc = trimmed.slice(2).trim();
        continue;
      }

      // import block
      if (trimmed === "import (" || trimmed.startsWith("import (")) {
        inImportBlock = true;
        continue;
      }
      if (inImportBlock) {
        if (trimmed === ")") {
          inImportBlock = false;
          continue;
        }
        const impMatch = /"([^"]+)"/.exec(trimmed);
        if (impMatch) {
          edges.push({
            from: `module::${impMatch[1]}`,
            to: fileNode.id,
            kind: "imports",
            sourceFile: absPath,
            sourceLine: lineNo,
          });
        }
        continue;
      }
      // import single
      const impSingle = /^import\s+"([^"]+)"/.exec(trimmed);
      if (impSingle) {
        edges.push({
          from: `module::${impSingle[1]}`,
          to: fileNode.id,
          kind: "imports",
          sourceFile: absPath,
          sourceLine: lineNo,
        });
        continue;
      }

      // func
      const fnMatch = /^func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?([A-Z]\w*|[a-z]\w*)\s*\(/.exec(trimmed);
      if (fnMatch) {
        const name = fnMatch[1]!;
        const endLine = this.findBlockEnd(lines, i);
        const body = lines.slice(i, endLine).join("\n");
        const complexity = this.estimateComplexity(body);
        const isMethod = /^\s*\(/.test(trimmed.slice(4));
        nodes.push({
          id: `${isMethod ? "method" : "func"}::${relPath}::${name}`,
          kind: isMethod ? "method" : "function",
          name,
          filePath: absPath,
          relativePath: relPath,
          lineStart: lineNo,
          lineEnd: endLine,
          complexity,
          complexityLevel: this.complexityLevel(complexity),
          docstring: lastDoc,
          parentId: null,
        });
        lastDoc = "";
        continue;
      }

      // type struct
      const typeMatch = /^type\s+([A-Z]\w*)\s+struct/.exec(trimmed);
      if (typeMatch) {
        const name = typeMatch[1]!;
        const endLine = this.findBlockEnd(lines, i);
        nodes.push({
          id: `class::${relPath}::${name}`,
          kind: "class",
          name,
          filePath: absPath,
          relativePath: relPath,
          lineStart: lineNo,
          lineEnd: endLine,
          complexity: 0,
          complexityLevel: "low",
          docstring: lastDoc,
          parentId: null,
        });
        lastDoc = "";
        continue;
      }

      if (trimmed === "") lastDoc = "";
    }

    return { nodes, edges };
  }

  // ==========================================================================
  // Rust 分析（轻量级）
  // ==========================================================================

  /**
   * 分析 Rust 文件
   *
   * 提取：use、fn、impl、struct、enum、trait
   */
  private analyzeRustFile(
    absPath: string,
    relPath: string,
    content: string,
    lines: string[],
    fileNode: CodeNode
  ): { nodes: CodeNode[]; edges: CodeEdge[] } {
    const nodes: CodeNode[] = [fileNode];
    const edges: CodeEdge[] = [];
    let lastDoc = "";
    let currentImpl: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNo = i + 1;
      const trimmed = line.trim();

      if (trimmed.startsWith("///") || trimmed.startsWith("//!")) {
        lastDoc = trimmed.replace(/^[!/#]+\s*/, "").trim();
        continue;
      }
      if (trimmed.startsWith("//")) continue;

      // use
      const useMatch = /^use\s+([\w:]+)/.exec(trimmed);
      if (useMatch) {
        edges.push({
          from: `module::${useMatch[1]}`,
          to: fileNode.id,
          kind: "imports",
          sourceFile: absPath,
          sourceLine: lineNo,
        });
        continue;
      }

      // fn
      const fnMatch = /^(?:pub\s+)?(?:async\s+|const\s+|unsafe\s+)?fn\s+(\w+)\s*[<(]/.exec(trimmed);
      if (fnMatch) {
        const name = fnMatch[1]!;
        const endLine = this.findBlockEnd(lines, i);
        const body = lines.slice(i, endLine).join("\n");
        const complexity = this.estimateComplexity(body);
        nodes.push({
          id: `${currentImpl ? "method" : "func"}::${relPath}::${currentImpl ? currentImpl + "." + name : name}`,
          kind: currentImpl ? "method" : "function",
          name,
          filePath: absPath,
          relativePath: relPath,
          lineStart: lineNo,
          lineEnd: endLine,
          complexity,
          complexityLevel: this.complexityLevel(complexity),
          docstring: lastDoc,
          parentId: currentImpl ? `class::${relPath}::${currentImpl}` : null,
        });
        lastDoc = "";
        continue;
      }

      // impl
      const implMatch = /^impl(?:\s+\w+\s+for)?\s+(\w+)/.exec(trimmed);
      if (implMatch) {
        currentImpl = implMatch[1]!;
        continue;
      }

      // struct / enum / trait
      const typeMatch = /^(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/.exec(trimmed);
      if (typeMatch) {
        const name = typeMatch[1]!;
        // 用单词边界匹配 trait 关键字，避免 pub trait 被误判
        const isTrait = /\btrait\b/.test(trimmed);
        const kind: CodeNode["kind"] = isTrait ? "interface" : "class";
        const endLine = this.findBlockEnd(lines, i);
        nodes.push({
          id: `${kind === "interface" ? "iface" : "class"}::${relPath}::${name}`,
          kind,
          name,
          filePath: absPath,
          relativePath: relPath,
          lineStart: lineNo,
          lineEnd: endLine,
          complexity: 0,
          complexityLevel: "low",
          docstring: lastDoc,
          parentId: null,
        });
        lastDoc = "";
        continue;
      }

      if (trimmed === "") lastDoc = "";
    }

    return { nodes, edges };
  }

  // ==========================================================================
  // 通用工具：块边界、复杂度
  // ==========================================================================

  /**
   * 查找花括号匹配的块结束行（用于 C 系语言）
   *
   * 从起始行 i 开始，向下找到匹配的 }，返回结束行索引（含）
   */
  private findBlockEnd(lines: string[], startIdx: number): number {
    let depth = 0;
    let started = false;
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i]!;
      for (const ch of line) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") {
          depth--;
          if (started && depth === 0) {
            return i + 1;
          }
        }
      }
    }
    return lines.length;
  }

  /**
   * 查找 Python 缩进块结束行
   *
   * 规则：当遇到一行缩进 <= 起始行缩进（且非空），视为块结束
   */
  private findPythonBlockEnd(lines: string[], startIdx: number): number {
    const startLine = lines[startIdx]!;
    const startIndent = startLine.length - startLine.trimStart().length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= startIndent) {
        return i;
      }
    }
    return lines.length;
  }

  /**
   * 估算圈复杂度（基于控制流关键词计数）
   *
   * 圈复杂度 = 1 + 控制流分支数
   *   - if / elif / else if
   *   - for / while / do
   *   - case
   *   - catch
   *   - && / || / ?
   */
  private estimateComplexity(body: string): number {
    let count = 1;
    // 关键词
    const keywords = /\b(if|elif|else\s+if|for|while|catch|case|when)\b/g;
    const keywordMatches = body.match(keywords);
    if (keywordMatches) count += keywordMatches.length;
    // 逻辑运算符
    const logical = /(&&|\|\||\?)/g;
    const logicalMatches = body.match(logical);
    if (logicalMatches) count += logicalMatches.length;
    return count;
  }

  /** 复杂度等级 */
  private complexityLevel(complexity: number): "low" | "medium" | "high" {
    if (complexity <= 5) return "low";
    if (complexity <= 10) return "medium";
    return "high";
  }

  // ==========================================================================
  // 统计与死代码检测
  // ==========================================================================

  /**
   * 构建统计信息
   */
  private buildStats(
    nodes: CodeNode[],
    edges: CodeEdge[],
    fileCount: number,
    dirCount: number,
    languageBreakdown: Record<string, number>,
    totalLines: number
  ): CodeMapStats {
    const nodesByKind: Record<CodeNode["kind"], number> = {
      function: 0,
      method: 0,
      class: 0,
      interface: 0,
      module: 0,
      file: 0,
      variable: 0,
      constant: 0,
    };
    const edgesByKind: Record<CodeEdge["kind"], number> = {
      imports: 0,
      extends: 0,
      implements: 0,
      calls: 0,
      uses: 0,
    };
    let totalComplexity = 0;
    let complexityCount = 0;
    const topComplexNodes: CodeMapStats["topComplexNodes"] = [];

    for (const n of nodes) {
      nodesByKind[n.kind]++;
      if (n.complexity > 0) {
        totalComplexity += n.complexity;
        complexityCount++;
      }
      topComplexNodes.push({
        id: n.id,
        complexity: n.complexity,
        name: n.name,
        filePath: n.filePath,
      });
    }
    for (const e of edges) {
      edgesByKind[e.kind]++;
    }
    topComplexNodes.sort((a, b) => b.complexity - a.complexity);
    topComplexNodes.splice(10);

    // 死代码检测：无入边的非 file 节点
    //
    // 算法（V2 精细化版）：
    //   1) 直接入边：某节点有 imports/extends/implements/calls/uses 边指向它
    //      - 即 e.to = 某节点 → 该节点入度 +1
    //   2) 间接入边（file 被 import 引用时）：
    //      - 收集每个被引用的 file 及其 importedSymbols 列表
    //      - 遍历 file 内的非 file 节点，仅当节点名出现在 importedSymbols 中时
    //        才继承入度（避免整个 file 的所有节点都被"被 import 一次"激活）
    //   3) 特殊规则：
    //      - importedSymbols === ["*"] 表示命名空间导入，匹配 file 内所有符号
    //      - importedSymbols === undefined 或 [] 表示仅副作用导入，不激活任何符号
    //   4) 排除：变量/常量节点（不视为死代码，因为变量常是内部状态）
    const incomingCount = new Map<string, number>();
    for (const n of nodes) {
      if (n.kind !== "file") incomingCount.set(n.id, 0);
    }
    // 1) 直接入边
    for (const e of edges) {
      if (incomingCount.has(e.to)) {
        incomingCount.set(e.to, (incomingCount.get(e.to) ?? 0) + 1);
      }
    }
    // 2) 间接入边：file 被 import 引用时，按 importedSymbols 匹配
    //    注：当前实现 import 边的 from 字段是被引用的 file（file::xxx），
    //    to 字段是引用方 file
    const fileImportedSymbols = new Map<string, Set<string>>(); // fileId -> symbols
    for (const e of edges) {
      if (e.kind !== "imports" || !e.from.startsWith("file::")) continue;
      const fileId = e.from;
      const symbols = e.importedSymbols;
      if (!symbols || symbols.length === 0) {
        // 副作用导入（无具名符号），不激活任何节点
        continue;
      }
      if (!fileImportedSymbols.has(fileId)) {
        fileImportedSymbols.set(fileId, new Set());
      }
      const set = fileImportedSymbols.get(fileId)!;
      for (const s of symbols) set.add(s);
    }
    // 入口文件：作为应用启动点的文件，其内部节点不算死代码
    // 入口文件命名约定见 ENTRY_FILE_NAMES
    const entryFileBasenames = new Set<string>();
    for (const n of nodes) {
      if (n.kind !== "file") continue;
      const basename = n.name.replace(/\.[^.]+$/, ""); // 去掉扩展名
      if (CodeMapGenerator.ENTRY_FILE_NAMES.has(basename)) {
        entryFileBasenames.add(n.id);
      }
    }
    // 对 file 内的非 file 节点：仅当节点名出现在 importedSymbols 中时继承入度
    for (const n of nodes) {
      if (n.kind === "file") continue;
      // 入口文件内的所有非 file 节点都继承入度（不算死代码）
      const fileId = `file::${n.relativePath}`;
      if (entryFileBasenames.has(fileId)) {
        incomingCount.set(n.id, (incomingCount.get(n.id) ?? 0) + 1);
        continue;
      }
      const importedNames = fileImportedSymbols.get(fileId);
      if (!importedNames) continue;
      // ["*"] 表示命名空间导入，匹配所有符号
      if (importedNames.has("*")) {
        incomingCount.set(n.id, (incomingCount.get(n.id) ?? 0) + 1);
        continue;
      }
      // 按名匹配：节点 name 出现在 importedNames 中
      if (importedNames.has(n.name)) {
        incomingCount.set(n.id, (incomingCount.get(n.id) ?? 0) + 1);
      }
    }
    // 3) 子节点继承父节点入度：method 继承其父 class 的入度
    //    语义：class 被引用时，其内部方法也视为"被引用"（因为调用方使用 class 时
    //    会调用 class 的方法）；反之 class 未被引用时，方法自然也不可能被使用
    const methodNodes = nodes.filter((n) => n.kind === "method" && n.parentId);
    for (const m of methodNodes) {
      const parentIncoming = incomingCount.get(m.parentId!) ?? 0;
      if (parentIncoming > 0) {
        incomingCount.set(m.id, (incomingCount.get(m.id) ?? 0) + parentIncoming);
      }
    }
    const deadCodeCandidates: string[] = [];
    for (const [id, count] of incomingCount.entries()) {
      if (count === 0) {
        const node = nodes.find((n) => n.id === id);
        // 排除：变量/常量节点不算死代码（内部状态）
        if (node && node.kind !== "constant" && node.kind !== "variable") {
          deadCodeCandidates.push(id);
        }
      }
    }

    return {
      fileCount,
      directoryCount: dirCount,
      nodesByKind,
      edgesByKind,
      languageBreakdown,
      avgComplexity: complexityCount > 0 ? totalComplexity / complexityCount : 0,
      topComplexNodes,
      deadCodeCandidates,
      totalLines,
    };
  }

  // ==========================================================================
  // 输出
  // ==========================================================================

  /**
   * 输出代码地图到文件
   *
   * - Markdown：人 + AI 双可读
   * - JSON：程序化消费
   */
  async dump(map: CodeMap): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    if (this.options.generateMarkdown !== false) {
      const md = this.toMarkdown(map);
      const mdPath = this.options.markdownOutputPath ?? path.join(this.projectRoot, "CODE_MAP.md");
      await fs.mkdir(path.dirname(mdPath), { recursive: true });
      await fs.writeFile(mdPath, md, "utf-8");
    }
    if (this.options.generateJson !== false) {
      const jsonPath = this.options.jsonOutputPath ?? path.join(this.projectRoot, "CODE_MAP.json");
      await fs.mkdir(path.dirname(jsonPath), { recursive: true });
      await fs.writeFile(jsonPath, JSON.stringify(map, null, 2), "utf-8");
    }
  }

  /**
   * 序列化为 Markdown 格式
   *
   * 结构：
   *   # Code Map: <projectName>
   *   ## 概览（统计）
   *   ## 复杂度 Top 10
   *   ## 死代码候选
   *   ## 模块依赖
   *   ## 文件清单
   */
  toMarkdown(map: CodeMap): string {
    const lines: string[] = [];
    lines.push(`# Code Map: ${map.projectName}`);
    lines.push("");
    lines.push(`- **生成时间**: ${map.generatedAt}`);
    lines.push(`- **项目根**: ${map.projectRoot}`);
    lines.push(`- **文件数**: ${map.stats.fileCount}`);
    lines.push(`- **目录数**: ${map.stats.directoryCount}`);
    lines.push(`- **节点数**: ${map.nodes.length}`);
    lines.push(`- **边数**: ${map.edges.length}`);
    lines.push(`- **总行数**: ${map.stats.totalLines}`);
    lines.push(`- **平均圈复杂度**: ${map.stats.avgComplexity.toFixed(2)}`);
    lines.push("");

    // 语言分布
    lines.push("## 语言分布");
    lines.push("");
    lines.push("| 语言 | 文件数 |");
    lines.push("| --- | --- |");
    for (const [lang, count] of Object.entries(map.stats.languageBreakdown).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${lang} | ${count} |`);
    }
    lines.push("");

    // 节点类型分布
    lines.push("## 节点分布");
    lines.push("");
    lines.push("| 类型 | 数量 |");
    lines.push("| --- | --- |");
    for (const [kind, count] of Object.entries(map.stats.nodesByKind)) {
      if (count > 0) lines.push(`| ${kind} | ${count} |`);
    }
    lines.push("");

    // 复杂度 Top 10
    lines.push("## 复杂度 Top 10");
    lines.push("");
    lines.push("| 节点 | 复杂度 | 等级 | 文件 |");
    lines.push("| --- | --- | --- | --- |");
    for (const n of map.stats.topComplexNodes) {
      const level = this.complexityLevel(n.complexity);
      const file = CodeMapGenerator.toRelative(this.projectRoot, n.filePath);
      lines.push(`| ${n.name} | ${n.complexity} | ${level} | ${file} |`);
    }
    lines.push("");

    // 死代码候选
    if (map.stats.deadCodeCandidates.length > 0) {
      lines.push("## 死代码候选");
      lines.push("");
      lines.push("以下节点无入边，可能为未使用的代码：");
      lines.push("");
      for (const id of map.stats.deadCodeCandidates) {
        const node = map.nodes.find((n) => n.id === id);
        if (node) {
          lines.push(`- \`${node.name}\` (${node.kind}) - ${node.relativePath}:${node.lineStart}`);
        }
      }
      lines.push("");
    }

    // 文件清单
    lines.push("## 文件清单");
    lines.push("");
    const filesByLang = new Map<string, string[]>();
    for (const n of map.nodes) {
      if (n.kind === "file") {
        const lang = CodeMapGenerator.langOfExt(CodeMapGenerator.extOf(n.relativePath));
        const list = filesByLang.get(lang) ?? [];
        list.push(n.relativePath);
        filesByLang.set(lang, list);
      }
    }
    for (const [lang, files] of filesByLang) {
      lines.push(`### ${lang} (${files.length})`);
      lines.push("");
      for (const f of files.slice(0, 50)) {
        lines.push(`- \`${f}\``);
      }
      if (files.length > 50) {
        lines.push(`- _... 以及其他 ${files.length - 50} 个文件_`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // ==========================================================================
  // 工具方法
  // ==========================================================================

  private warn(msg: string): void {
    console.warn(`[CodeMapGenerator] ${msg}`);
  }

  private static basename(path: string): string {
    const m = /[^/\\]+$/.exec(path);
    return m ? m[0] : path;
  }

  private static toRelative(root: string, abs: string): string {
    if (abs.startsWith(root)) {
      return abs.slice(root.length).replace(/^[\\/]+/, "");
    }
    return abs;
  }

  /**
   * 解析相对 import 路径为绝对文件路径
   *
   * 处理 ./x / ../x / ./x.ts / ./x.js / ./x/index.ts 等形式。
   * 如果目标文件不存在，返回 null。
   *
   * @param fromFile 引用方文件绝对路径
   * @param importPath import 路径（相对路径）
   * @returns 目标文件绝对路径（若存在）
   */
  /**
   * 解析相对 import 路径为绝对文件路径
   *
   * 处理 ./x / ../x / ./x.ts / ./x.js / ./x/index.ts 等形式。
   * 如果目标文件不存在，返回 null。
   *
   * @param fromFile 引用方文件绝对路径
   * @param importPath import 路径（相对路径）
   * @returns 目标文件绝对路径（若存在）
   */
  private static resolveImportPath(fromFile: string, importPath: string): string | null {
    const path = nodePath;
    const fs = nodeFs;
    const fromDir = path.dirname(fromFile);
    const basePath = path.resolve(fromDir, importPath);
    // 1) 直接命中
    if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
      return basePath;
    }
    // 2) 加扩展名（按 DEFAULT_INCLUDE_EXTS 顺序）
    for (const ext of CodeMapGenerator.DEFAULT_INCLUDE_EXTS) {
      const withExt = basePath + ext;
      if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
        return withExt;
      }
    }
    // 3) 目录 + index.<ext>
    if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
      for (const ext of CodeMapGenerator.DEFAULT_INCLUDE_EXTS) {
        const indexPath = path.join(basePath, "index" + ext);
        if (fs.existsSync(indexPath)) {
          return indexPath;
        }
      }
    }
    return null;
  }

  private static extOf(path: string): string {
    const idx = path.lastIndexOf(".");
    return idx === -1 ? "" : path.slice(idx).toLowerCase();
  }

  private static langOfExt(ext: string): string {
    if ([".ts", ".tsx"].includes(ext)) return "typescript";
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
    if (ext === ".py") return "python";
    if (ext === ".java") return "java";
    if (ext === ".go") return "go";
    if (ext === ".rs") return "rust";
    if ([".c", ".h"].includes(ext)) return "c";
    if ([".cpp", ".hpp", ".cc", ".hh"].includes(ext)) return "cpp";
    if (ext === ".cs") return "csharp";
    if (ext === ".php") return "php";
    if ([".sh", ".bash", ".zsh"].includes(ext)) return "shell";
    if (ext === ".rb") return "ruby";
    if (ext === ".kt") return "kotlin";
    if (ext === ".swift") return "swift";
    return "other";
  }

  private static errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
