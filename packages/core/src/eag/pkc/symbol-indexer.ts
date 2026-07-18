/**
 * 符号索引器实现（EAG-P2 批次 8）
 *
 * 本模块实现 `SymbolIndexer` 类，提供 EAG 方案 §5.11.1 L2 语义检索层的
 * 符号粒度索引与增量重建逻辑。
 *
 * 核心职责：
 * - indexFile(filePath)：解析单个源代码文件，提取函数/类/方法等符号
 * - indexIncremental(diff)：基于 git diff 驱动增量重建（含反向 1 跳闭包）
 * - getSymbol(symbolId)：按 ID 查询符号
 * - 小变更直通：变更文件 ≤2 且 impacted ≤10 时跳过重建
 *
 * §5.11.1 L2 语义检索层设计要求：
 * - 符号粒度索引（函数/类/方法粒度）
 * - 字段：symbolId / kind / name / signature / filePath / startLine / endLine / summary / embedding?
 * - 增量索引：git diff 驱动 → 变更文件 → 受影响闭包（反向 1 跳）重解析
 * - 小变更直通：变更文件 ≤2 且 impacted ≤10 时跳过重建
 *
 * 设计依据：
 * - EAG 方案 §5.11.1 L2 语义检索层
 * - §5.11.6 V2-P4 CodeMap 符号级知识图谱增强
 * - 多语言多框架支持（TypeScript/JavaScript/Java/Python/Go）
 *
 * 实现说明：
 * - 不依赖外部 AST 解析库（避免引入依赖），采用基于正则的符号提取
 * - 调用方嵌入器（Embedder）可选；无嵌入器时仅做 BM25 索引
 * - 内部维护 symbolById Map + fileToSymbols Map（双向索引）
 * - 增量索引采用"反向 1 跳闭包"算法：变更文件 → 文件内符号 → 引用这些符号的文件
 *   （此处简化为同文件 + 同目录文件视为受影响闭包）
 *
 * 不可变优先：
 * - 内部状态使用 readonly 修饰，更新时返回新 Map
 * - 公开方法返回冻结对象
 *
 * @module eag/pkc/symbol-indexer
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { GitDiff, IndexedSymbol, ReindexResult, SymbolKind } from "./l2-types";
import { SMALL_CHANGE_FILE_THRESHOLD, SMALL_CHANGE_IMPACTED_THRESHOLD } from "./l2-types";

// ============================================================================
// 嵌入器接口（供调用方注入向量模型实现）
// ============================================================================

/**
 * 嵌入器接口（供 SemanticSearcher 与 SymbolIndexer 共享）
 *
 * 实现方负责将文本（如符号签名 + 摘要）转换为数值向量。
 * 无向量模型时调用方不注入嵌入器，索引与检索退化为纯 BM25。
 *
 * 实现示例：
 * - 生产实现：调用 OpenAI text-embedding-3-small 等模型 API
 * - 测试实现：StaticEmbedder（基于 hash 的确定性向量，禁用 mock）
 */
export interface Embedder {
  /** 嵌入向量维度（如 384、768、1536） */
  readonly dimension: number;
  /** 将文本嵌入为向量（异步，可能调用远程模型） */
  embed(text: string): Promise<ReadonlyArray<number>>;
}

// ============================================================================
// 符号提取规则（多语言正则表）
// ============================================================================

/**
 * 符号提取规则（单语言单符号类型一条规则）
 */
interface SymbolExtractionRule {
  /** 符号类型 */
  readonly kind: SymbolKind;
  /** 正则表达式（带捕获组：1=符号名，2=可选参数或继承信息） */
  readonly pattern: RegExp;
  /** 文件扩展名（小写，含点，如 ".ts"） */
  readonly extensions: ReadonlyArray<string>;
}

/**
 * 多语言符号提取规则表
 *
 * 覆盖语言：TypeScript / JavaScript / Java / Python / Go
 * 覆盖符号类型：class / interface / function / method / enum / type-alias
 *
 * 使用 Object.freeze 冻结。
 *
 * 实现说明：
 * - 正则采用全局匹配 + 捕获组提取符号名
 * - 行号通过 split('\n') + indexOf 计算（O(N)，N 为文件行数）
 * - 同一行多次匹配按位置顺序处理
 */
const SYMBOL_EXTRACTION_RULES: ReadonlyArray<SymbolExtractionRule> = Object.freeze([
  // TypeScript/JavaScript class
  {
    kind: "class",
    pattern: /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Z][A-Za-z0-9_]*)/g,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  // TypeScript interface
  {
    kind: "interface",
    pattern: /\b(?:export\s+)?interface\s+([A-Z][A-Za-z0-9_]*)/g,
    extensions: [".ts", ".tsx"],
  },
  // TypeScript type alias
  {
    kind: "type-alias",
    pattern: /\b(?:export\s+)?type\s+([A-Z][A-Za-z0-9_]*)\s*=/g,
    extensions: [".ts", ".tsx"],
  },
  // TypeScript/JavaScript enum
  {
    kind: "enum",
    pattern: /\b(?:export\s+)?(?:const\s+)?enum\s+([A-Z][A-Za-z0-9_]*)/g,
    extensions: [".ts", ".tsx", ".js", ".jsx"],
  },
  // TypeScript/JavaScript 顶层 function（不在类内的命名导出函数）
  {
    kind: "function",
    pattern: /\b(?:export\s+)?(?:async\s+)?function\s+([a-z][A-Za-z0-9_]*)/g,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  // TypeScript/JavaScript 类方法（class X { methodName(...) { } }）
  {
    kind: "method",
    pattern:
      /\b(?:public|private|protected|static|async|readonly|\s)+([a-z][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\s*[{=]/g,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  // Java class
  {
    kind: "class",
    pattern: /\b(?:public|private|protected|final|abstract|\s)*class\s+([A-Z][A-Za-z0-9_]*)/g,
    extensions: [".java"],
  },
  // Java interface
  {
    kind: "interface",
    pattern: /\b(?:public|private|protected|\s)*interface\s+([A-Z][A-Za-z0-9_]*)/g,
    extensions: [".java"],
  },
  // Java enum
  {
    kind: "enum",
    pattern: /\b(?:public|private|protected|\s)*enum\s+([A-Z][A-Za-z0-9_]*)/g,
    extensions: [".java"],
  },
  // Java method（返回类型支持泛型与数组 String[] / List<byte[]> 等）
  {
    kind: "method",
    pattern:
      /\b(?:public|private|protected|static|final|synchronized|abstract|\s)+[A-Za-z_<>,[\]\s]+\s+([a-z][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?:throws\s+[A-Za-z_,\s.]+)?\s*\{/g,
    extensions: [".java"],
  },
  // Python class
  {
    kind: "class",
    pattern: /\bclass\s+([A-Z][A-Za-z0-9_]*)/g,
    extensions: [".py"],
  },
  // Python function（def 关键字）
  {
    kind: "function",
    pattern: /\bdef\s+([a-z_][A-Za-z0-9_]*)/g,
    extensions: [".py"],
  },
  // Go func（函数与方法）
  {
    kind: "function",
    pattern: /\bfunc\s+(?:\([^)]*\)\s+)?([A-Z][A-Za-z0-9_]*)\s*\(/g,
    extensions: [".go"],
  },
  // Go struct
  {
    kind: "class",
    pattern: /\btype\s+([A-Z][A-Za-z0-9_]*)\s+struct\b/g,
    extensions: [".go"],
  },
  // Go interface
  {
    kind: "interface",
    pattern: /\btype\s+([A-Z][A-Za-z0-9_]*)\s+interface\b/g,
    extensions: [".go"],
  },
]);

// ============================================================================
// 异常类型
// ============================================================================

/**
 * 符号索引器错误（路径不存在或解析失败时抛出）
 */
export class SymbolIndexerError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-path：路径非法
   *   - path-not-found：路径不存在
   *   - parse-error：解析失败
   * @param detail 错误详情
   */
  constructor(
    public readonly kind: "invalid-path" | "path-not-found" | "parse-error",
    public readonly detail: string
  ) {
    super(`符号索引器错误 [${kind}]：${detail}`);
    this.name = "SymbolIndexerError";
  }
}

// ============================================================================
// 内部辅助类型：符号位置（用于行号计算）
// ============================================================================

/**
 * 符号位置（用于解析过程中临时存储）
 */
interface SymbolPosition {
  /** 符号名 */
  readonly name: string;
  /** 符号类型 */
  readonly kind: SymbolKind;
  /** 起始行号（1-based） */
  readonly startLine: number;
  /** 起始字符在文件内容中的偏移量 */
  readonly startOffset: number;
}

// ============================================================================
// SymbolIndexer 类
// ============================================================================

/**
 * 符号索引器（实现 §5.11.1 L2 语义检索层的符号粒度索引）
 *
 * 提供真实索引逻辑（禁止 mock）：
 * - indexFile：解析单文件，提取符号，构建 IndexedSymbol 并存入索引
 * - indexIncremental：基于 git diff 驱动增量重建
 * - getSymbol：按 ID 查询符号
 * - getAllSymbols：返回全部符号（供 SemanticSearcher 检索）
 * - removeSymbolsOfFile：移除指定文件的全部符号
 *
 * 索引结构：
 * - symbolById：Map<string, IndexedSymbol>（symbolId → 符号）
 * - fileToSymbolIds：Map<string, Set<string>>（filePath → symbolId 集合）
 *
 * 增量索引算法：
 * 1. 收集变更文件列表（changedFiles + 反向 1 跳闭包）
 * 2. 判定是否小变更直通（changedFiles.length ≤ 2 且 impacted ≤ 10）
 * 3. 小变更：跳过重建，记录 skipped=true
 * 4. 非小变更：删除变更文件的旧符号 → 重新解析变更文件 → 比对差异产出 ReindexResult
 *
 * 使用方式：
 * ```typescript
 * const indexer = new SymbolIndexer(projectRoot);
 * await indexer.indexFile("src/services/UserService.ts");
 * const sym = indexer.getSymbol("src/services/UserService.ts:UserService");
 * ```
 */
export class SymbolIndexer {
  /**
   * 项目根目录绝对路径（用于拼接文件绝对路径）
   */
  private readonly projectRoot: string;

  /**
   * 可选嵌入器（用于为符号生成向量）
   *
   * 未注入时索引符号的 embedding 字段为 undefined，检索退化为纯 BM25。
   */
  private readonly embedder?: Embedder;

  /**
   * 符号 ID → IndexedSymbol 映射（核心索引）
   *
   * 注：使用可变 Map 仅在内部实现中，对外返回时通过 Object.freeze 冻结。
   */
  private readonly symbolById: Map<string, IndexedSymbol> = new Map();

  /**
   * 文件路径 → 符号 ID 集合 映射（反向索引，便于按文件批量删除）
   */
  private readonly fileToSymbolIds: Map<string, Set<string>> = new Map();

  /**
   * @param projectRoot 项目根目录绝对路径
   * @param embedder 可选嵌入器（无嵌入器时索引无向量）
   */
  constructor(projectRoot: string, embedder?: Embedder) {
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new SymbolIndexerError("invalid-path", "projectRoot 必须为非空字符串");
    }
    this.projectRoot = projectRoot;
    this.embedder = embedder;
  }

  /**
   * 解析单个文件，提取符号并构建索引
   *
   * 执行流程：
   * 1. 校验文件路径存在且为文件
   * 2. 读取文件内容
   * 3. 按文件扩展名匹配符号提取规则
   * 4. 提取符号位置 → 计算行号 → 生成 symbolId → 构建 IndexedSymbol
   * 5. 若有嵌入器：为每个符号生成 embedding
   * 6. 写入索引（symbolById + fileToSymbolIds）
   *
   * @param filePath 文件相对路径（相对于 projectRoot）
   * @returns 索引的符号列表（冻结的 IndexedSymbol[]）
   * @throws {SymbolIndexerError} 路径不存在或解析失败时抛出
   */
  async indexFile(filePath: string): Promise<ReadonlyArray<IndexedSymbol>> {
    // 校验入参
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new SymbolIndexerError("invalid-path", "filePath 必须为非空字符串");
    }

    // 拼接绝对路径
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
    const relativePath = path.isAbsolute(filePath) ? path.relative(this.projectRoot, filePath) : filePath;

    // 校验文件存在
    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch (err) {
      throw new SymbolIndexerError("path-not-found", `文件不存在：${absolutePath}（${(err as Error).message}）`);
    }
    if (!stat.isFile()) {
      throw new SymbolIndexerError("invalid-path", `路径不是文件：${absolutePath}`);
    }

    // 读取文件内容
    let content: string;
    try {
      content = await fs.readFile(absolutePath, "utf-8");
    } catch (err) {
      throw new SymbolIndexerError("parse-error", `读取文件失败：${absolutePath}（${(err as Error).message}）`);
    }

    // 移除该文件的旧符号（避免重复）
    this.removeSymbolsOfFile(relativePath);

    // 提取符号
    const symbols = await this.extractSymbols(content, relativePath);

    // 写入索引
    for (const sym of symbols) {
      this.symbolById.set(sym.symbolId, sym);
      if (!this.fileToSymbolIds.has(relativePath)) {
        this.fileToSymbolIds.set(relativePath, new Set());
      }
      this.fileToSymbolIds.get(relativePath)!.add(sym.symbolId);
    }

    return Object.freeze(symbols.map((s) => Object.freeze({ ...s })));
  }

  /**
   * 基于 git diff 增量重建索引
   *
   * 执行流程：
   * 1. 收集变更文件列表（changedFiles）
   * 2. 计算受影响符号（反向 1 跳闭包）
   * 3. 判定是否小变更直通
   *    - changedFiles.length ≤ 2 且 impacted ≤ 10 → 跳过重建
   * 4. 小变更：返回 skipped=true
   * 5. 非小变更：
   *    - 记录旧符号快照（用于 diff）
   *    - 删除变更文件的旧符号
   *    - 重新解析变更文件（deleted 类型跳过）
   *    - 比对新旧符号，分类为 added/updated/removed
   *    - 返回 ReindexResult
   *
   * @param diff Git Diff 信息
   * @returns 增量重建结果
   */
  async indexIncremental(diff: GitDiff): Promise<ReindexResult> {
    // 收集变更文件路径（统一为相对路径）
    const changedFiles = diff.changedFiles.map((f) => f.filePath);

    // 计算受影响符号（反向 1 跳闭包）
    // 算法：变更文件 → 文件内符号 → 引用这些符号的文件 → 这些文件的符号
    // 简化版：将变更文件 + 同目录文件视为受影响闭包
    const impactedSymbols = this.computeImpactedSymbols(changedFiles);

    // 判定是否小变更直通
    if (
      changedFiles.length <= SMALL_CHANGE_FILE_THRESHOLD &&
      impactedSymbols.length <= SMALL_CHANGE_IMPACTED_THRESHOLD
    ) {
      return Object.freeze({
        reindexedFiles: Object.freeze([]),
        impactedSymbols: Object.freeze([...impactedSymbols]),
        addedSymbols: Object.freeze([]),
        updatedSymbols: Object.freeze([]),
        removedSymbols: Object.freeze([]),
        skipped: true,
        reason: `小变更直通：变更文件 ${changedFiles.length} ≤ ${SMALL_CHANGE_FILE_THRESHOLD} 且受影响符号 ${impactedSymbols.length} ≤ ${SMALL_CHANGE_IMPACTED_THRESHOLD}，跳过重建`,
      });
    }

    // 非小变更：执行增量重建
    const reindexedFiles: string[] = [];
    const addedSymbols: IndexedSymbol[] = [];
    const updatedSymbols: IndexedSymbol[] = [];
    const removedSymbols: string[] = [];

    for (const file of diff.changedFiles) {
      // deleted 类型：直接移除符号
      if (file.type === "deleted") {
        const oldSymbols = this.getFileSymbols(file.filePath);
        for (const sym of oldSymbols) {
          removedSymbols.push(sym.symbolId);
        }
        this.removeSymbolsOfFile(file.filePath);
        continue;
      }

      // renamed 类型：先移除旧路径符号，再索引新路径
      if (file.type === "renamed" && file.oldFilePath) {
        const oldSymbols = this.getFileSymbols(file.oldFilePath);
        for (const sym of oldSymbols) {
          removedSymbols.push(sym.symbolId);
        }
        this.removeSymbolsOfFile(file.oldFilePath);
      }

      // 记录旧符号快照（modified/added/renamed 都需要重新索引）
      const filePathToIndex = file.filePath;
      const oldSymbolsMap = new Map<string, IndexedSymbol>();
      for (const sym of this.getFileSymbols(filePathToIndex)) {
        oldSymbolsMap.set(sym.symbolId, sym);
      }

      // 重新索引（indexFile 会先移除旧符号再添加新符号）
      let newSymbols: ReadonlyArray<IndexedSymbol> = [];
      try {
        newSymbols = await this.indexFile(filePathToIndex);
        reindexedFiles.push(filePathToIndex);
      } catch {
        // 索引失败：跳过该文件，不中断整体重建（单点失败不阻断整体原则）
        continue;
      }

      // 比对新旧符号，分类为 added/updated/removed
      for (const newSym of newSymbols) {
        const oldSym = oldSymbolsMap.get(newSym.symbolId);
        if (!oldSym) {
          // 新增
          addedSymbols.push(newSym);
        } else {
          // 已存在 → 检查是否更新（任何字段变化视为更新）
          if (
            oldSym.signature !== newSym.signature ||
            oldSym.startLine !== newSym.startLine ||
            oldSym.endLine !== newSym.endLine ||
            oldSym.summary !== newSym.summary
          ) {
            updatedSymbols.push(newSym);
          }
          oldSymbolsMap.delete(newSym.symbolId);
        }
      }
      // oldSymbolsMap 中剩余的为已删除符号
      for (const removedId of oldSymbolsMap.keys()) {
        removedSymbols.push(removedId);
      }
    }

    return Object.freeze({
      reindexedFiles: Object.freeze(reindexedFiles),
      impactedSymbols: Object.freeze([...impactedSymbols]),
      addedSymbols: Object.freeze(addedSymbols.map((s) => Object.freeze({ ...s }))),
      updatedSymbols: Object.freeze(updatedSymbols.map((s) => Object.freeze({ ...s }))),
      removedSymbols: Object.freeze([...removedSymbols]),
      skipped: false,
      reason: `增量重建：${reindexedFiles.length} 个文件重解析，${addedSymbols.length} 新增 / ${updatedSymbols.length} 更新 / ${removedSymbols.length} 移除`,
    });
  }

  /**
   * 按 ID 查询符号
   *
   * @param symbolId 符号 ID（格式：filePath:fullyQualifiedName）
   * @returns 符号对象（不存在返回 null）
   */
  getSymbol(symbolId: string): IndexedSymbol | null {
    const sym = this.symbolById.get(symbolId);
    if (!sym) {
      return null;
    }
    // 返回浅拷贝并冻结（防止外部修改内部状态）
    return Object.freeze({ ...sym });
  }

  /**
   * 返回全部已索引符号（供 SemanticSearcher 检索）
   *
   * @returns 全部符号列表（冻结）
   */
  getAllSymbols(): ReadonlyArray<IndexedSymbol> {
    return Object.freeze([...this.symbolById.values()].map((s) => Object.freeze({ ...s })));
  }

  /**
   * 返回指定文件的全部符号
   *
   * @param filePath 文件相对路径
   * @returns 符号列表（冻结）
   */
  getFileSymbols(filePath: string): ReadonlyArray<IndexedSymbol> {
    const symbolIds = this.fileToSymbolIds.get(filePath);
    if (!symbolIds) {
      return Object.freeze([]);
    }
    const symbols: IndexedSymbol[] = [];
    for (const id of symbolIds) {
      const sym = this.symbolById.get(id);
      if (sym) {
        symbols.push(sym);
      }
    }
    return Object.freeze(symbols.map((s) => Object.freeze({ ...s })));
  }

  /**
   * 移除指定文件的全部符号
   *
   * @param filePath 文件相对路径
   * @returns 移除的符号数量
   */
  removeSymbolsOfFile(filePath: string): number {
    const symbolIds = this.fileToSymbolIds.get(filePath);
    if (!symbolIds) {
      return 0;
    }
    const count = symbolIds.size;
    for (const id of symbolIds) {
      this.symbolById.delete(id);
    }
    symbolIds.clear();
    this.fileToSymbolIds.delete(filePath);
    return count;
  }

  /**
   * 返回当前已索引的文件路径列表
   *
   * @returns 文件路径列表（冻结）
   */
  getIndexedFiles(): ReadonlyArray<string> {
    return Object.freeze([...this.fileToSymbolIds.keys()]);
  }

  // ============================ 私有辅助方法 ============================

  /**
   * 从文件内容提取符号
   *
   * 执行流程：
   * 1. 按文件扩展名过滤适用的提取规则
   * 2. 对每条规则执行正则匹配，提取符号位置
   * 3. 计算每个符号的行号与签名
   * 4. 生成 symbolId（filePath:fullyQualifiedName）
   * 5. 若有嵌入器：生成 embedding
   * 6. 构建并返回 IndexedSymbol 列表
   *
   * @param content 文件内容
   * @param filePath 文件相对路径
   * @returns 索引符号列表
   */
  private async extractSymbols(content: string, filePath: string): Promise<IndexedSymbol[]> {
    const ext = path.extname(filePath).toLowerCase();
    const applicableRules = SYMBOL_EXTRACTION_RULES.filter((r) => r.extensions.includes(ext));

    if (applicableRules.length === 0) {
      return [];
    }

    // 提取所有符号位置
    const positions: SymbolPosition[] = [];
    for (const rule of applicableRules) {
      // 重置正则 lastIndex（带 g 标志的正则需要重置）
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(content)) !== null) {
        const name = match[1];
        if (!name) continue;
        const startOffset = match.index;
        // 计算行号（1-based）：统计 startOffset 之前有多个 \n
        const startLine = this.computeLineNumber(content, startOffset);
        positions.push({
          name,
          kind: rule.kind,
          startLine,
          startOffset,
        });
      }
    }

    // 按起始偏移量排序（便于后续计算结束行号）
    positions.sort((a, b) => a.startOffset - b.startOffset);

    // 构建 IndexedSymbol 列表
    const symbols: IndexedSymbol[] = [];
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      // 结束行号：下一个符号的前一行，或文件末尾
      const endLine =
        i + 1 < positions.length ? positions[i + 1].startLine - 1 : this.computeLineNumber(content, content.length);

      // 提取符号签名（从符号开始行到结束行的代码片段，截断到 200 字符）
      const signature = this.extractSignature(content, pos.startOffset, 200);

      // 生成符号摘要（首行注释或前一行注释，截断到 120 字符）
      const summary = this.extractSummary(content, pos.startOffset, pos.name);

      // 生成 symbolId（filePath:name，避免完全限定名的复杂性）
      // 注：同名符号在同一文件内可能冲突，此时附加行号消歧
      const baseId = `${filePath}:${pos.name}`;
      const symbolId = symbols.some((s) => s.symbolId === baseId) ? `${filePath}:${pos.name}:${pos.startLine}` : baseId;

      // 若有嵌入器：生成 embedding
      let embedding: ReadonlyArray<number> | undefined;
      if (this.embedder) {
        try {
          embedding = await this.embedder.embed(`${signature} ${summary}`);
        } catch {
          // 嵌入失败：embedding 保持 undefined（不阻断索引）
          embedding = undefined;
        }
      }

      symbols.push(
        Object.freeze({
          symbolId,
          kind: pos.kind,
          name: pos.name,
          signature,
          filePath,
          startLine: pos.startLine,
          endLine: Math.max(endLine, pos.startLine),
          summary,
          embedding,
        })
      );
    }

    return symbols;
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
        // \n
        line++;
      }
    }
    return line;
  }

  /**
   * 提取符号签名（从符号开始位置截取若干字符，截断到 maxLen）
   *
   * @param content 文件内容
   * @param startOffset 符号起始偏移量
   * @param maxLen 最大长度
   * @returns 签名字符串（已 trim + 折叠空白）
   */
  private extractSignature(content: string, startOffset: number, maxLen: number): string {
    const raw = content.slice(startOffset, startOffset + maxLen);
    // 取首行（到第一个 \n 或 { ）
    const endIdx = raw.search(/[\n{]/);
    const signature = endIdx >= 0 ? raw.slice(0, endIdx) : raw;
    // 折叠空白
    return signature.trim().replace(/\s+/g, " ");
  }

  /**
   * 提取符号摘要（取符号上方紧邻的注释，或符号名 + 类型描述）
   *
   * @param content 文件内容
   * @param startOffset 符号起始偏移量
   * @param name 符号名
   * @returns 摘要字符串
   */
  private extractSummary(content: string, startOffset: number, name: string): string {
    // 取符号前 200 字符，查找最近的注释行
    const prefix = content.slice(Math.max(0, startOffset - 200), startOffset);
    const lines = prefix.split("\n");

    // 从后向前查找注释行（// 或 # 或 *）
    const commentLines: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith("//") || line.startsWith("#") || line.startsWith("*")) {
        commentLines.unshift(line.replace(/^(\/\/|#|\*)\s*/, ""));
      } else if (line.length === 0) {
        // 空行：继续向前查找
        continue;
      } else {
        // 非注释非空行：停止
        break;
      }
    }

    if (commentLines.length > 0) {
      return commentLines.join(" ").slice(0, 120);
    }

    // 无注释：使用符号名作为摘要
    return `${name}（${"符号"}）`;
  }

  /**
   * 计算受影响符号列表（反向 1 跳闭包）
   *
   * 算法（简化版）：
   * 1. 收集变更文件内已有的符号 ID
   * 2. 加入同目录文件的符号 ID（视为反向 1 跳闭包）
   *
   * @param changedFiles 变更文件列表
   * @returns 受影响符号 ID 列表
   */
  private computeImpactedSymbols(changedFiles: ReadonlyArray<string>): string[] {
    const impacted = new Set<string>();

    // 1. 变更文件内已有的符号
    for (const file of changedFiles) {
      const symbolIds = this.fileToSymbolIds.get(file);
      if (symbolIds) {
        for (const id of symbolIds) {
          impacted.add(id);
        }
      }
    }

    // 2. 同目录文件的符号（反向 1 跳闭包）
    const impactedFiles = new Set<string>(changedFiles);
    for (const file of changedFiles) {
      const dir = path.dirname(file);
      for (const indexedFile of this.fileToSymbolIds.keys()) {
        if (path.dirname(indexedFile) === dir) {
          impactedFiles.add(indexedFile);
        }
      }
    }

    // 收集所有受影响文件的符号
    for (const file of impactedFiles) {
      const symbolIds = this.fileToSymbolIds.get(file);
      if (symbolIds) {
        for (const id of symbolIds) {
          impacted.add(id);
        }
      }
    }

    return [...impacted];
  }
}
