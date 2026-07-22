/**
 * EdgeResolver —— 符号边解析器（EAG-P5 Phase 5.1 TASK-P5-1.1-004）
 *
 * 本模块实现 `EdgeResolver` 类，提供符号级代码图谱的边解析能力，
 * 是 EAG-P5 符号级偏离检测（FR-3.4）与爆炸半径 BFS（FR-3.3）的核心输入。
 *
 * 核心职责（对齐架构师审查 §4.3 + 任务分解 TASK-P5-1.1-004）：
 * 1. 两级解析：
 *    - R1 静态可判（同文件内 import / extends / implements）→ EXTRACTED (1.0)
 *    - R2 推断（跨文件调用关系，签名匹配）→ AMBIGUOUS (0.6) / UNRESOLVED (0.2)
 * 2. 四类边解析：
 *    - CALLS：调用边（A 调用 B 的方法/函数）
 *    - INHERITS：继承边（A 继承 B）
 *    - IMPLEMENTS：实现边（A 实现 B 接口）
 *    - TESTED_BY：测试边（A 被 B 测试）
 * 3. 三级置信度（对齐 ADR-P4-001 §2.3）：
 *    - EXTRACTED (1.0)：静态可判，全权重参与 BFS
 *    - AMBIGUOUS (0.6)：推断，0.6 衰减参与 BFS
 *    - UNRESOLVED (0.2)：未解析，低权重参与 BFS（宁多勿漏）
 *
 * 设计依据：
 * - 复用 eag/pkc/symbol-indexer.ts 既有正则符号提取规则（不修改 SymbolIndexer 本体）
 * - 采用基于正则的轻量解析（避免引入 ts-morph 等重量级 AST 库）
 * - 多语言支持：TypeScript/JavaScript/Java/Python/Go
 *
 * 不可变优先：
 * - 所有接口字段 readonly
 * - 数组 ReadonlyArray<T>
 * - 顶层常量 Object.freeze
 *
 * @module eag/p5/edge-resolver
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { EdgeConfidence, EdgeKind } from "./symbol-graph-store";
import { CONFIDENCE_VALUE_MAP } from "./symbol-graph-store";

// ============================================================================
// 1. 类型定义
// ============================================================================

/**
 * 已解析的边（EdgeResolver 的输出）
 *
 * 与 SymbolGraphStore.addEdge 的入参对齐，可直接传入 addEdges 批量写入。
 */
export interface ResolvedEdge {
  /** 源符号 ID（格式：filePath:fullyQualifiedName） */
  readonly sourceSymbolId: string;
  /** 目标符号 ID */
  readonly targetSymbolId: string;
  /** 边类型（CALLS / INHERITS / IMPLEMENTS / TESTED_BY） */
  readonly kind: EdgeKind;
  /** 置信度标签（EXTRACTED / AMBIGUOUS / UNRESOLVED） */
  readonly confidenceLabel: EdgeConfidence;
}

/**
 * 简化的符号信息（EdgeResolver 内部使用）
 *
 * 仅包含边解析所需的最小字段集，避免依赖完整的 SymbolRecord。
 */
interface ParsedSymbol {
  /** 符号 ID（filePath:name 或 filePath:name:line） */
  readonly symbolId: string;
  /** 符号名 */
  readonly name: string;
  /** 符号所在文件相对路径 */
  readonly filePath: string;
  /** 符号所在文件的内容（用于解析边） */
  readonly fileContent: string;
}

/**
 * 解析的文件信息（内部中间结果）
 */
interface ParsedFileInfo {
  /** 文件相对路径 */
  readonly filePath: string;
  /** 文件内容 */
  readonly content: string;
  /** 文件扩展名（小写，含点） */
  readonly ext: string;
  /** 该文件内提取的符号列表 */
  readonly symbols: ReadonlyArray<ParsedSymbol>;
  /** 该文件的导入映射（导入名 → 来源文件路径） */
  readonly imports: ReadonlyMap<string, string>;
  /** 是否为测试文件 */
  readonly isTestFile: boolean;
}

// ============================================================================
// 2. 正则规则定义（复用 symbol-indexer.ts 的模式，不修改原文件）
// ============================================================================

/**
 * 符号提取规则（与 symbol-indexer.ts 的 SYMBOL_EXTRACTION_RULES 一致）
 *
 * 复用既有正则规则，确保符号 ID 生成与 SymbolIndexer 一致。
 * 此处仅提取符号名与位置，不构建完整 IndexedSymbol。
 */
interface SymbolExtractionRule {
  /** 正则表达式（捕获组 1 = 符号名） */
  readonly pattern: RegExp;
  /** 文件扩展名列表 */
  readonly extensions: ReadonlyArray<string>;
}

/**
 * 多语言符号提取规则表
 *
 * 与 symbol-indexer.ts 的 SYMBOL_EXTRACTION_RULES 保持一致，
 * 确保符号提取结果与 SymbolIndexer 兼容。
 */
const SYMBOL_PATTERNS: ReadonlyArray<SymbolExtractionRule> = Object.freeze([
  // TypeScript/JavaScript class
  {
    pattern: /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Z][A-Za-z0-9_]*)/g,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  // TypeScript interface
  { pattern: /\b(?:export\s+)?interface\s+([A-Z][A-Za-z0-9_]*)/g, extensions: [".ts", ".tsx"] },
  // TypeScript type alias
  { pattern: /\b(?:export\s+)?type\s+([A-Z][A-Za-z0-9_]*)\s*=/g, extensions: [".ts", ".tsx"] },
  // TypeScript/JavaScript enum
  { pattern: /\b(?:export\s+)?(?:const\s+)?enum\s+([A-Z][A-Za-z0-9_]*)/g, extensions: [".ts", ".tsx", ".js", ".jsx"] },
  // TypeScript/JavaScript 顶层 function
  {
    pattern: /\b(?:export\s+)?(?:async\s+)?function\s+([a-z][A-Za-z0-9_]*)/g,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  // TypeScript/JavaScript 类方法
  {
    pattern:
      /\b(?:public|private|protected|static|async|readonly|\s)+([a-z][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\s*[{=]/g,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  // Java class
  { pattern: /\b(?:public|private|protected|final|abstract|\s)*class\s+([A-Z][A-Za-z0-9_]*)/g, extensions: [".java"] },
  // Java interface
  { pattern: /\b(?:public|private|protected|\s)*interface\s+([A-Z][A-Za-z0-9_]*)/g, extensions: [".java"] },
  // Java enum
  { pattern: /\b(?:public|private|protected|\s)*enum\s+([A-Z][A-Za-z0-9_]*)/g, extensions: [".java"] },
  // Java method
  {
    pattern:
      /\b(?:public|private|protected|static|final|synchronized|abstract|\s)+[A-Za-z_<>,[\]\s]+\s+([a-z][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?:throws\s+[A-Za-z_,\s.]+)?\s*\{/g,
    extensions: [".java"],
  },
  // Python class
  { pattern: /\bclass\s+([A-Z][A-Za-z0-9_]*)/g, extensions: [".py"] },
  // Python function
  { pattern: /\bdef\s+([a-z_][A-Za-z0-9_]*)/g, extensions: [".py"] },
  // Go func
  { pattern: /\bfunc\s+(?:\([^)]*\)\s+)?([A-Z][A-Za-z0-9_]*)\s*\(/g, extensions: [".go"] },
  // Go struct
  { pattern: /\btype\s+([A-Z][A-Za-z0-9_]*)\s+struct\b/g, extensions: [".go"] },
  // Go interface
  { pattern: /\btype\s+([A-Z][A-Za-z0-9_]*)\s+interface\b/g, extensions: [".go"] },
]);

/**
 * 继承关系提取规则（class A extends B）
 *
 * 捕获组 1 = 子类名，捕获组 2 = 父类名
 */
const INHERITS_PATTERNS: ReadonlyArray<{ pattern: RegExp; extensions: ReadonlyArray<string> }> = Object.freeze([
  // TypeScript/JavaScript: class A extends B
  {
    pattern: /\bclass\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+([A-Z][A-Za-z0-9_]*)/g,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  // Java: class A extends B
  { pattern: /\bclass\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+([A-Za-z0-9_<>]+)/g, extensions: [".java"] },
  // Python: class A(B)
  { pattern: /\bclass\s+([A-Z][A-Za-z0-9_]*)\s*\(([^)]+)\)/g, extensions: [".py"] },
]);

/**
 * 接口实现提取规则（class A implements B, C）
 *
 * 捕获组 1 = 实现类名，捕获组 2 = 接口名列表（逗号分隔）
 */
const IMPLEMENTS_PATTERNS: ReadonlyArray<{ pattern: RegExp; extensions: ReadonlyArray<string> }> = Object.freeze([
  // TypeScript/JavaScript: class A implements B, C
  {
    pattern: /\bclass\s+([A-Z][A-Za-z0-9_]*)\s+implements\s+([A-Z][A-Za-z0-9_,\s]+)/g,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  // Java: class A implements B, C
  { pattern: /\bclass\s+([A-Z][A-Za-z0-9_]*)\s+implements\s+([A-Za-z0-9_,\s]+)/g, extensions: [".java"] },
]);

/**
 * 方法/函数调用提取规则（foo() / obj.method() / ClassName.staticMethod()）
 *
 * 捕获组 1 = 被调用的方法/函数名
 */
const CALL_PATTERNS: ReadonlyArray<{ pattern: RegExp; extensions: ReadonlyArray<string> }> = Object.freeze([
  // TypeScript/JavaScript/Java: 标识符() 或 标识符.方法()
  { pattern: /\b([a-z][A-Za-z0-9_]*)\s*\(/g, extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".java"] },
  // Python: 标识符()
  { pattern: /\b([a-z_][A-Za-z0-9_]*)\s*\(/g, extensions: [".py"] },
  // Go: 标识符()
  { pattern: /\b([A-Z][A-Za-z0-9_]*)\s*\(/g, extensions: [".go"] },
]);

/**
 * import 语句提取规则
 *
 * 捕获组 1 = 导入的名称列表，捕获组 2 = 来源模块路径
 */
const IMPORT_PATTERNS: ReadonlyArray<{ pattern: RegExp; extensions: ReadonlyArray<string> }> = Object.freeze([
  // TypeScript/JavaScript: import { A, B } from "./path"
  {
    pattern: /\bimport\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  // TypeScript/JavaScript: import A from "./path"
  {
    pattern: /\bimport\s+([A-Z][A-Za-z0-9_]*)\s+from\s+["']([^"']+)["']/g,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  // TypeScript/JavaScript: import * as A from "./path"
  {
    pattern: /\bimport\s+\*\s+as\s+([A-Z][A-Za-z0-9_]*)\s+from\s+["']([^"']+)["']/g,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  // Java: import com.example.A;
  { pattern: /\bimport\s+(?:static\s+)?([A-Za-z0-9_.]+);/g, extensions: [".java"] },
  // Python: from module import A, B
  { pattern: /\bfrom\s+([A-Za-z0-9_.]+)\s+import\s+([A-Za-z0-9_,\s]+)/g, extensions: [".py"] },
  // Python: import module
  { pattern: /\bimport\s+([A-Za-z0-9_.]+)/g, extensions: [".py"] },
  // Go: import "path" 或 import (多行)
  { pattern: /\bimport\s+"([^"]+)"/g, extensions: [".go"] },
]);

/**
 * 测试文件后缀模式（用于 TESTED_BY 边检测）
 */
const TEST_FILE_SUFFIXES: ReadonlyArray<string> = Object.freeze([
  ".test.ts",
  ".test.tsx",
  ".test.js",
  ".test.jsx",
  ".spec.ts",
  ".spec.tsx",
  ".spec.js",
  ".spec.jsx",
  "_test.go",
  "Test.java",
  "_test.py",
]);

// ============================================================================
// 3. EdgeResolver 类
// ============================================================================

/**
 * EdgeResolver —— 符号边解析器
 *
 * 从源代码文件中解析符号间的 4 类边（CALLS / INHERITS / IMPLEMENTS / TESTED_BY），
 * 并为每条边分配三级置信度（EXTRACTED / AMBIGUOUS / UNRESOLVED）。
 *
 * 使用方式：
 * ```typescript
 * const resolver = new EdgeResolver("/project/root");
 * const edges = await resolver.resolveEdges([
 *   "src/services/UserService.ts",
 *   "src/repositories/UserRepository.ts",
 *   "tests/user-service.test.ts",
 * ]);
 * // edges 可直接传入 SymbolGraphStore.addEdges()
 * store.addEdges(edges);
 * ```
 *
 * 解析算法：
 * 1. 读取所有源文件内容
 * 2. 从每个文件提取符号（复用 SymbolIndexer 正则规则）
 * 3. 解析 import 语句，建立"导入名 → 来源文件"映射
 * 4. 对每个文件解析 4 类边：
 *    - INHERITS：class A extends B → A INHERITS B
 *    - IMPLEMENTS：class A implements B → A IMPLEMENTS B
 *    - CALLS：foo() / obj.method() → caller CALLS callee
 *    - TESTED_BY：测试文件 → 源文件符号 TESTED_BY 测试符号
 * 5. 为每条边分配置信度：
 *    - EXTRACTED：同文件内或通过 import 显式导入
 *    - AMBIGUOUS：跨文件名匹配且唯一
 *    - UNRESOLVED：跨文件名匹配但不唯一（无法确定目标）
 */
export class EdgeResolver {
  /** 项目根目录绝对路径 */
  private readonly projectRoot: string;

  /**
   * @param projectRoot 项目根目录绝对路径
   */
  constructor(projectRoot: string) {
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new Error("EdgeResolver: projectRoot 必须为非空字符串");
    }
    this.projectRoot = projectRoot;
  }

  /**
   * 解析源文件列表中的符号边
   *
   * 执行流程：
   * 1. 并行读取所有源文件内容
   * 2. 从每个文件提取符号 + 解析 import 语句
   * 3. 构建全局符号索引（符号名 → 符号 ID 列表）
   * 4. 对每个文件解析 4 类边（INHERITS / IMPLEMENTS / CALLS / TESTED_BY）
   * 5. 为每条边分配置信度（EXTRACTED / AMBIGUOUS / UNRESOLVED）
   * 6. 去重（同一 source-target-kind 组合保留最高置信度）
   *
   * @param sourceFiles 源文件相对路径列表
   * @returns 解析的边列表（可直接传入 SymbolGraphStore.addEdges）
   */
  async resolveEdges(sourceFiles: ReadonlyArray<string>): Promise<ReadonlyArray<ResolvedEdge>> {
    if (sourceFiles.length === 0) {
      return Object.freeze([]);
    }

    // === 阶段 1：读取所有源文件内容 ===
    const fileInfos = await this.readAndParseFiles(sourceFiles);

    // === 阶段 2：构建全局符号索引（符号名 → 符号 ID 列表） ===
    const symbolIndex = this.buildSymbolIndex(fileInfos);

    // === 阶段 3：解析 4 类边 ===
    const allEdges: ResolvedEdge[] = [];

    for (const fileInfo of fileInfos) {
      // 解析 INHERITS 边
      const inheritsEdges = this.resolveInheritsEdges(fileInfo, symbolIndex);
      allEdges.push(...inheritsEdges);

      // 解析 IMPLEMENTS 边
      const implementsEdges = this.resolveImplementsEdges(fileInfo, symbolIndex);
      allEdges.push(...implementsEdges);

      // 解析 CALLS 边
      const callsEdges = this.resolveCallsEdges(fileInfo, symbolIndex);
      allEdges.push(...callsEdges);

      // 解析 TESTED_BY 边
      const testedByEdges = this.resolveTestedByEdges(fileInfo, fileInfos, symbolIndex);
      allEdges.push(...testedByEdges);
    }

    // === 阶段 4：去重（同一 source-target-kind 保留最高置信度） ===
    const dedupedEdges = this.deduplicateEdges(allEdges);

    return Object.freeze(dedupedEdges);
  }

  // ============================ 私有辅助方法 ============================

  /**
   * 读取并解析所有源文件
   *
   * @param sourceFiles 源文件相对路径列表
   * @returns 解析的文件信息列表
   */
  private async readAndParseFiles(sourceFiles: ReadonlyArray<string>): Promise<ParsedFileInfo[]> {
    const fileInfos: ParsedFileInfo[] = [];

    for (const filePath of sourceFiles) {
      // 拼接绝对路径
      const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
      const relativePath = path.isAbsolute(filePath) ? path.relative(this.projectRoot, filePath) : filePath;

      // 读取文件内容
      let content: string;
      try {
        content = await fs.readFile(absolutePath, "utf-8");
      } catch {
        // 文件读取失败时跳过（单点失败不阻断整体）
        continue;
      }

      const ext = path.extname(relativePath).toLowerCase();

      // 提取符号
      const symbols = this.extractSymbols(content, relativePath);

      // 解析 import 语句
      const imports = this.parseImports(content, ext);

      // 判断是否为测试文件
      const isTestFile = this.isTestFile(relativePath);

      fileInfos.push({
        filePath: relativePath,
        content,
        ext,
        symbols,
        imports,
        isTestFile,
      });
    }

    return fileInfos;
  }

  /**
   * 从文件内容提取符号（复用 SymbolIndexer 正则规则）
   *
   * @param content 文件内容
   * @param filePath 文件相对路径
   * @returns 提取的符号列表
   */
  private extractSymbols(content: string, filePath: string): ParsedSymbol[] {
    const ext = path.extname(filePath).toLowerCase();
    const applicablePatterns = SYMBOL_PATTERNS.filter((r) => r.extensions.includes(ext));

    const symbols: ParsedSymbol[] = [];
    const seenNames = new Set<string>();

    for (const rule of applicablePatterns) {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(content)) !== null) {
        const name = match[1];
        if (!name) continue;

        // 生成符号 ID（与 SymbolIndexer 一致：filePath:name，同名消歧加行号）
        const symbolId = seenNames.has(name)
          ? `${filePath}:${name}:${this.computeLineNumber(content, match.index)}`
          : `${filePath}:${name}`;
        seenNames.add(name);

        symbols.push({
          symbolId,
          name,
          filePath,
          fileContent: content,
        });
      }
    }

    return symbols;
  }

  /**
   * 解析 import 语句，建立"导入名 → 来源文件路径"映射
   *
   * @param content 文件内容
   * @param ext 文件扩展名
   * @returns 导入映射
   */
  private parseImports(content: string, ext: string): Map<string, string> {
    const imports = new Map<string, string>();
    const applicablePatterns = IMPORT_PATTERNS.filter((r) => r.extensions.includes(ext));

    for (const rule of applicablePatterns) {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(content)) !== null) {
        if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
          // TypeScript/JavaScript: import { A, B } from "./path" 或 import A from "./path"
          const namesPart = match[1] || "";
          const sourcePath = match[2] || "";
          if (sourcePath.startsWith(".")) {
            // 相对路径导入：将每个导入名映射到来源文件
            const names = namesPart
              .split(",")
              .map((n) => n.trim())
              .filter((n) => n.length > 0);
            for (const name of names) {
              imports.set(name, sourcePath);
            }
          }
        }
        // Java/Python/Go 的 import 解析较复杂，此处暂不处理跨文件解析
        // 这些语言的边主要依赖同文件内的 extends/implements 模式
      }
    }

    return imports;
  }

  /**
   * 判断是否为测试文件
   *
   * @param filePath 文件相对路径
   * @returns 是否为测试文件
   */
  private isTestFile(filePath: string): boolean {
    const lowerPath = filePath.toLowerCase();
    return TEST_FILE_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix));
  }

  /**
   * 构建全局符号索引（符号名 → 符号 ID 列表）
   *
   * @param fileInfos 解析的文件信息列表
   * @returns 符号索引
   */
  private buildSymbolIndex(fileInfos: ReadonlyArray<ParsedFileInfo>): Map<string, string[]> {
    const index = new Map<string, string[]>();

    for (const fileInfo of fileInfos) {
      for (const symbol of fileInfo.symbols) {
        const existing = index.get(symbol.name);
        if (existing) {
          existing.push(symbol.symbolId);
        } else {
          index.set(symbol.name, [symbol.symbolId]);
        }
      }
    }

    return index;
  }

  /**
   * 解析 INHERITS 边（class A extends B → A INHERITS B）
   *
   * @param fileInfo 文件信息
   * @param symbolIndex 全局符号索引
   * @returns INHERITS 边列表
   */
  private resolveInheritsEdges(fileInfo: ParsedFileInfo, symbolIndex: Map<string, string[]>): ResolvedEdge[] {
    const edges: ResolvedEdge[] = [];
    const applicablePatterns = INHERITS_PATTERNS.filter((r) => r.extensions.includes(fileInfo.ext));

    for (const rule of applicablePatterns) {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(fileInfo.content)) !== null) {
        const childName = match[1];
        const parentName = match[2];
        if (!childName || !parentName) continue;

        // 查找子类符号 ID
        const childSymbolId = this.findSymbolIdInFile(fileInfo, childName);
        if (!childSymbolId) continue;

        // 查找父类符号 ID 并分配置信度
        const edge = this.resolveEdgeTarget(fileInfo, childSymbolId, parentName, "INHERITS", symbolIndex);
        if (edge) {
          edges.push(edge);
        }
      }
    }

    return edges;
  }

  /**
   * 解析 IMPLEMENTS 边（class A implements B, C → A IMPLEMENTS B, A IMPLEMENTS C）
   *
   * @param fileInfo 文件信息
   * @param symbolIndex 全局符号索引
   * @returns IMPLEMENTS 边列表
   */
  private resolveImplementsEdges(fileInfo: ParsedFileInfo, symbolIndex: Map<string, string[]>): ResolvedEdge[] {
    const edges: ResolvedEdge[] = [];
    const applicablePatterns = IMPLEMENTS_PATTERNS.filter((r) => r.extensions.includes(fileInfo.ext));

    for (const rule of applicablePatterns) {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(fileInfo.content)) !== null) {
        const implClassName = match[1];
        const interfaceNamesPart = match[2];
        if (!implClassName || !interfaceNamesPart) continue;

        // 查找实现类符号 ID
        const implSymbolId = this.findSymbolIdInFile(fileInfo, implClassName);
        if (!implSymbolId) continue;

        // 解析接口名列表（逗号分隔）
        const interfaceNames = interfaceNamesPart
          .split(",")
          .map((n) => n.trim())
          .filter((n) => n.length > 0);

        for (const interfaceName of interfaceNames) {
          const edge = this.resolveEdgeTarget(fileInfo, implSymbolId, interfaceName, "IMPLEMENTS", symbolIndex);
          if (edge) {
            edges.push(edge);
          }
        }
      }
    }

    return edges;
  }

  /**
   * 解析 CALLS 边（foo() / obj.method() → caller CALLS callee）
   *
   * @param fileInfo 文件信息
   * @param symbolIndex 全局符号索引
   * @returns CALLS 边列表
   */
  private resolveCallsEdges(fileInfo: ParsedFileInfo, symbolIndex: Map<string, string[]>): ResolvedEdge[] {
    const edges: ResolvedEdge[] = [];
    const applicablePatterns = CALL_PATTERNS.filter((r) => r.extensions.includes(fileInfo.ext));

    // 收集本文件中所有调用名（去重）
    const calledNames = new Set<string>();
    for (const rule of applicablePatterns) {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(fileInfo.content)) !== null) {
        const calledName = match[1];
        if (!calledName) continue;
        // 过滤掉语言关键字和控制流语句
        if (this.isLanguageKeyword(calledName, fileInfo.ext)) continue;
        calledNames.add(calledName);
      }
    }

    // 为每个调用名创建边（源符号 = 文件中第一个符号，或文件本身）
    // 优先将调用归属到文件中的类符号，其次到函数符号
    const sourceSymbolId = this.findBestSourceSymbol(fileInfo);
    if (!sourceSymbolId) return edges;

    for (const calledName of calledNames) {
      // 跳过自身定义的符号（避免自调用噪声）
      const isSelfDefined = fileInfo.symbols.some((s) => s.name === calledName);
      if (isSelfDefined) continue;

      const edge = this.resolveEdgeTarget(fileInfo, sourceSymbolId, calledName, "CALLS", symbolIndex);
      if (edge) {
        edges.push(edge);
      }
    }

    return edges;
  }

  /**
   * 解析 TESTED_BY 边（测试文件 → 源文件符号 TESTED_BY 测试符号）
   *
   * 算法：
   * 1. 测试文件中的符号（如 UserServiceTest）→ 查找被测源符号（如 UserService）
   * 2. 被测符号名通过去掉测试后缀（Test/Spec）匹配
   * 3. 置信度：EXTRACTED（同文件名模式匹配）
   *
   * @param fileInfo 文件信息
   * @param allFileInfos 全部文件信息
   * @param symbolIndex 全局符号索引
   * @returns TESTED_BY 边列表
   */
  private resolveTestedByEdges(
    fileInfo: ParsedFileInfo,
    allFileInfos: ReadonlyArray<ParsedFileInfo>,
    symbolIndex: Map<string, string[]>
  ): ResolvedEdge[] {
    if (!fileInfo.isTestFile) return [];

    const edges: ResolvedEdge[] = [];

    // 测试文件中的每个符号都可能是测试符号
    for (const testSymbol of fileInfo.symbols) {
      // 推导被测符号名（去掉 Test/Spec 后缀）
      const testedName = this.deriveTestedSymbolName(testSymbol.name);
      if (!testedName) continue;

      // 在全局符号索引中查找被测符号
      const candidateIds = symbolIndex.get(testedName);
      if (!candidateIds || candidateIds.length === 0) continue;

      // 查找被测符号所在的源文件（排除测试文件本身）
      const sourceFileInfos = allFileInfos.filter((f) => !f.isTestFile && f.filePath !== fileInfo.filePath);
      for (const sourceFileInfo of sourceFileInfos) {
        const testedSymbolId = sourceFileInfo.symbols.find((s) => s.name === testedName)?.symbolId;
        if (!testedSymbolId) continue;

        // 创建 TESTED_BY 边：被测符号 TESTED_BY 测试符号
        edges.push({
          sourceSymbolId: testedSymbolId,
          targetSymbolId: testSymbol.symbolId,
          kind: "TESTED_BY",
          confidenceLabel: "EXTRACTED",
        });
      }
    }

    return edges;
  }

  /**
   * 解析单条边的目标符号并分配置信度
   *
   * 置信度分配规则：
   * - EXTRACTED (1.0)：目标符号在同一个文件内，或通过 import 显式导入
   * - AMBIGUOUS (0.6)：目标符号在其他文件中，且全局唯一匹配
   * - UNRESOLVED (0.2)：目标符号在其他文件中，但匹配不唯一（无法确定具体目标）
   *
   * @param fileInfo 源文件信息
   * @param sourceSymbolId 源符号 ID
   * @param targetName 目标符号名
   * @param kind 边类型
   * @param symbolIndex 全局符号索引
   * @returns 解析的边（无法解析返回 null）
   */
  private resolveEdgeTarget(
    fileInfo: ParsedFileInfo,
    sourceSymbolId: string,
    targetName: string,
    kind: EdgeKind,
    symbolIndex: Map<string, string[]>
  ): ResolvedEdge | null {
    // 1. 检查同文件内是否有该符号 → EXTRACTED
    const sameFileSymbol = fileInfo.symbols.find((s) => s.name === targetName);
    if (sameFileSymbol) {
      return {
        sourceSymbolId,
        targetSymbolId: sameFileSymbol.symbolId,
        kind,
        confidenceLabel: "EXTRACTED",
      };
    }

    // 2. 检查是否通过 import 导入 → EXTRACTED
    if (fileInfo.imports.has(targetName)) {
      // 查找全局符号索引中名为 targetName 的符号
      const candidateIds = symbolIndex.get(targetName);
      if (candidateIds && candidateIds.length === 1) {
        return {
          sourceSymbolId,
          targetSymbolId: candidateIds[0]!,
          kind,
          confidenceLabel: "EXTRACTED",
        };
      }
      // import 了但全局有多个同名符号 → AMBIGUOUS
      if (candidateIds && candidateIds.length > 1) {
        // 取第一个作为最佳猜测（UNRESOLVED，宁多勿漏）
        return {
          sourceSymbolId,
          targetSymbolId: candidateIds[0]!,
          kind,
          confidenceLabel: "UNRESOLVED",
        };
      }
    }

    // 3. 跨文件名匹配 → AMBIGUOUS 或 UNRESOLVED
    const candidateIds = symbolIndex.get(targetName);
    if (!candidateIds || candidateIds.length === 0) {
      // 全局无匹配 → 不创建边（无法确定目标）
      return null;
    }

    if (candidateIds.length === 1) {
      // 唯一匹配 → AMBIGUOUS
      return {
        sourceSymbolId,
        targetSymbolId: candidateIds[0]!,
        kind,
        confidenceLabel: "AMBIGUOUS",
      };
    }

    // 多个匹配 → UNRESOLVED（取第一个作为最佳猜测，宁多勿漏低权重参与 BFS）
    return {
      sourceSymbolId,
      targetSymbolId: candidateIds[0]!,
      kind,
      confidenceLabel: "UNRESOLVED",
    };
  }

  /**
   * 在文件中查找符号 ID
   *
   * @param fileInfo 文件信息
   * @param symbolName 符号名
   * @returns 符号 ID（不存在返回 null）
   */
  private findSymbolIdInFile(fileInfo: ParsedFileInfo, symbolName: string): string | null {
    const symbol = fileInfo.symbols.find((s) => s.name === symbolName);
    return symbol?.symbolId ?? null;
  }

  /**
   * 查找文件中最适合作为 CALLS 边源头的符号
   *
   * 优先级：class > function > method
   *
   * @param fileInfo 文件信息
   * @returns 最佳源符号 ID（无符号返回 null）
   */
  private findBestSourceSymbol(fileInfo: ParsedFileInfo): string | null {
    // 优先返回类符号
    const classSymbol = fileInfo.symbols.find((s) => /^[A-Z]/.test(s.name));
    if (classSymbol) return classSymbol.symbolId;

    // 其次返回第一个符号
    if (fileInfo.symbols.length > 0) {
      return fileInfo.symbols[0]!.symbolId;
    }

    return null;
  }

  /**
   * 从测试符号名推导被测符号名
   *
   * 规则：
   * - UserServiceTest → UserService
   * - UserServiceSpec → UserService
   * - testUserService → UserService（去掉 test 前缀，首字母大写）
   *
   * @param testSymbolName 测试符号名
   * @returns 被测符号名（无法推导返回 null）
   */
  private deriveTestedSymbolName(testSymbolName: string): string | null {
    // 去掉 Test 后缀
    if (testSymbolName.endsWith("Test")) {
      return testSymbolName.slice(0, -4);
    }
    // 去掉 Spec 后缀
    if (testSymbolName.endsWith("Spec")) {
      return testSymbolName.slice(0, -4);
    }
    // 去掉 test 前缀，首字母大写
    if (testSymbolName.startsWith("test") && testSymbolName.length > 4) {
      return testSymbolName.charAt(4)!.toUpperCase() + testSymbolName.slice(5);
    }
    return null;
  }

  /**
   * 判断名称是否为语言关键字（避免将关键字误判为调用）
   *
   * @param name 待判断的名称
   * @param ext 文件扩展名
   * @returns 是否为关键字
   */
  private isLanguageKeyword(name: string, ext: string): boolean {
    const keywords = new Set([
      "if",
      "else",
      "for",
      "while",
      "do",
      "switch",
      "case",
      "break",
      "continue",
      "return",
      "try",
      "catch",
      "finally",
      "throw",
      "new",
      "delete",
      "typeof",
      "instanceof",
      "in",
      "of",
      "void",
      "this",
      "super",
      "class",
      "extends",
      "implements",
      "interface",
      "enum",
      "function",
      "var",
      "let",
      "const",
      "import",
      "export",
      "from",
      "as",
      "default",
      "async",
      "await",
      "yield",
      "true",
      "false",
      "null",
      "undefined",
      "def",
      "elif",
      "lambda",
      "pass",
      "with",
      "raise",
      "except",
      "assert",
      "print",
      "len",
      "range",
      "self",
      "func",
      "go",
      "defer",
      "select",
      "chan",
      "map",
      "make",
      "append",
      "panic",
      "recover",
      "package",
      "type",
      "struct",
      "public",
      "private",
      "protected",
      "static",
      "final",
      "abstract",
      "synchronized",
      "throws",
      "throw",
      "int",
      "long",
      "double",
      "float",
      "boolean",
      "char",
      "byte",
      "short",
      "void",
    ]);
    return keywords.has(name);
  }

  /**
   * 计算字符偏移量对应的行号（1-based）
   *
   * @param content 文件内容
   * @param offset 字符偏移量
   * @returns 行号（1-based）
   */
  private computeLineNumber(content: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < content.length; i++) {
      if (content.charCodeAt(i) === 10) {
        line++;
      }
    }
    return line;
  }

  /**
   * 边去重（同一 source-target-kind 组合保留最高置信度）
   *
   * 置信度优先级：EXTRACTED > AMBIGUOUS > UNRESOLVED
   *
   * @param edges 待去重的边列表
   * @returns 去重后的边列表
   */
  private deduplicateEdges(edges: ReadonlyArray<ResolvedEdge>): ResolvedEdge[] {
    const edgeMap = new Map<string, ResolvedEdge>();

    for (const edge of edges) {
      const key = `${edge.sourceSymbolId}|${edge.targetSymbolId}|${edge.kind}`;
      const existing = edgeMap.get(key);

      if (!existing) {
        edgeMap.set(key, edge);
      } else {
        // 保留置信度更高的边
        const existingWeight = CONFIDENCE_VALUE_MAP[existing.confidenceLabel];
        const newWeight = CONFIDENCE_VALUE_MAP[edge.confidenceLabel];
        if (newWeight > existingWeight) {
          edgeMap.set(key, edge);
        }
      }
    }

    return [...edgeMap.values()];
  }
}
