/**
 * PKC L2 语义检索层数据模型（EAG-P2 批次 8）
 *
 * 本模块定义 EAG 方案 §5.11.1 L2 语义检索层所需的全部结构化数据类型。
 * L2 层提供符号粒度的混合检索能力（FTS5 BM25 + 语义向量 RRF 融合），
 * 让系统像资深程序员一样精准定位代码细节（如"支付回调在哪处理"→
 * `PaymentCallbackHandler.handle()` 及调用链）。
 *
 * 设计依据：
 * - EAG 方案 §5.11.1 L2 语义检索层（符号粒度混合检索）
 * - §5.11.6 V2-P4 CodeMap 符号级知识图谱增强（FTS5 BM25 + 向量 RRF k=60 融合）
 * - 查询形态感知 kind boosting（PascalCase→Class 1.5x 等）
 * - focusPoints 上下文 1.5x 加权
 * - 增量索引（git diff 驱动受影响闭包局部重建，§5.11.6）
 * - 小变更直通（变更文件 ≤2 且 impacted ≤10 时跳过重建）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层配置常量使用 Object.freeze 冻结，防止运行期被 LLM 自改
 *
 * @module eag/pkc/l2-types
 */

// ============================================================================
// 1. 符号类型与索引结构
// ============================================================================

/**
 * 符号类型（字面量联合类型，覆盖函数/类/方法等常见符号粒度）
 *
 * 用于索引时标注符号的语法类别，支持查询形态感知 kind boosting：
 * - class：类声明（PascalCase 命名）
 * - function：函数声明（camelCase 命名）
 * - method：类方法（属于类的成员函数）
 * - interface：接口声明（PascalCase 命名）
 * - variable：变量声明（含 const/let/var）
 * - enum：枚举声明
 * - type-alias：类型别名（type T = ...）
 * - property：对象属性
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type SymbolKind =
  | "class"
  | "function"
  | "method"
  | "interface"
  | "variable"
  | "enum"
  | "type-alias"
  | "property";

/**
 * SymbolKind 全部合法值（用于运行时枚举、测试断言）
 *
 * 使用 Object.freeze 冻结。
 */
export const SYMBOL_KINDS: ReadonlyArray<SymbolKind> = Object.freeze([
  "class",
  "function",
  "method",
  "interface",
  "variable",
  "enum",
  "type-alias",
  "property",
]);

/**
 * 查询形态感知 kind boosting 系数表
 *
 * 对应 EAG 方案 §5.11.6 V2-P4 设计——查询形态感知 kind boosting：
 * - PascalCase 查询（如 `UserService`）→ Class 1.5x、Interface 1.4x、Type 1.3x
 * - camelCase 查询（如 `getUserById`）→ Function 1.3x、Method 1.4x
 * - snake_case 查询（如 `get_user_by_id`）→ Function 1.2x、Method 1.2x
 * - 默认（无法识别形态）：全部 1.0x（不加权）
 *
 * 此处仅定义"默认形态"的兜底系数表；具体 boosting 在 SemanticSearcher
 * 内根据查询形态动态计算（详见 semantic-searcher.ts 的 `computeKindBoost`）。
 *
 * 使用 Object.freeze 冻结。
 */
export const DEFAULT_KIND_BOOST: Readonly<Record<SymbolKind, number>> = Object.freeze({
  class: 1.0,
  function: 1.0,
  method: 1.0,
  interface: 1.0,
  variable: 1.0,
  enum: 1.0,
  "type-alias": 1.0,
  property: 1.0,
});

/**
 * 索引符号（L2 语义检索层的核心数据结构）
 *
 * 描述项目代码库中一个符号（函数/类/方法等）的完整索引信息：
 * - 标识字段：symbolId 唯一、kind/name 路由 boosting
 * - 位置字段：filePath/startLine/endLine 定位代码
 * - 语义字段：signature/summary 供检索展示
 * - 向量字段：embedding（可选，无向量模型时为 undefined，降级为纯 FTS5）
 *
 * 字段全部 readonly——索引符号一经构建即不可变，
 * 代码变更通过增量索引生成新的 IndexedSymbol 替换。
 *
 * 范例：
 *   {
 *     symbolId: "src/services/UserService.ts:UserService.login",
 *     kind: "method",
 *     name: "login",
 *     signature: "login(email: string, password: string): Promise<AuthToken>",
 *     filePath: "src/services/UserService.ts",
 *     startLine: 42,
 *     endLine: 78,
 *     summary: "用户登录方法，校验凭证后颁发 JWT",
 *     embedding: [0.12, -0.34, ...]
 *   }
 */
export interface IndexedSymbol {
  /** 符号唯一 ID（格式：filePath:fullyQualifiedName，如 "src/UserService.ts:UserService.login"） */
  readonly symbolId: string;
  /** 符号类型（class/function/method/interface/variable/enum/type-alias/property） */
  readonly kind: SymbolKind;
  /** 符号名（不含类前缀，如 "login"、"UserService"） */
  readonly name: string;
  /** 符号签名（函数/方法为参数与返回类型，类/接口为定义概要） */
  readonly signature: string;
  /** 文件相对路径（相对于项目根，如 "src/services/UserService.ts"） */
  readonly filePath: string;
  /** 起始行号（1-based） */
  readonly startLine: number;
  /** 结束行号（1-based，含） */
  readonly endLine: number;
  /** 符号摘要（一句话描述符号职责，供检索结果展示） */
  readonly summary: string;
  /** 语义向量（可选，无向量模型时为 undefined，降级为纯 FTS5 检索） */
  readonly embedding?: ReadonlyArray<number>;
}

// ============================================================================
// 2. 检索选项与结果
// ============================================================================

/**
 * 检索选项（SemanticSearcher.search 的可选入参）
 *
 * 控制检索行为：
 * - topK：返回结果数上限（默认 10）
 * - focusPoints：上下文焦点符号 ID 列表，命中的符号获 1.5x 加权
 * - kindBoost：自定义 kind boosting 系数表（覆盖默认 DEFAULT_KIND_BOOST）
 * - enableVector：是否启用向量通路（默认 true，无向量模型时自动降级为纯 FTS5）
 * - rrfK：RRF 融合常数 k（默认 60，参考 EAG 方案 §5.11.6 V2-P4）
 *
 * 范例：
 *   {
 *     topK: 5,
 *     focusPoints: ["src/services/UserService.ts:UserService.login"],
 *     enableVector: true,
 *     rrfK: 60
 *   }
 */
export interface SearchOptions {
  /** 返回结果数上限（默认 10） */
  readonly topK?: number;
  /** 焦点符号 ID 列表，命中符号获 1.5x 加权（§5.11.6 focusPoints 上下文加权） */
  readonly focusPoints?: ReadonlyArray<string>;
  /** 自定义 kind boosting 系数表（覆盖默认 DEFAULT_KIND_BOOST） */
  readonly kindBoost?: Readonly<Record<SymbolKind, number>>;
  /** 是否启用向量通路（默认 true，无向量模型时自动降级为纯 FTS5） */
  readonly enableVector?: boolean;
  /** RRF 融合常数 k（默认 60，§5.11.6 V2-P4） */
  readonly rrfK?: number;
}

/**
 * 检索结果（SemanticSearcher.search 的产出）
 *
 * 描述单条检索命中：
 * - 符号引用：symbol（含 IndexedSymbol 全量字段）
 * - 评分字段：score（综合 BM25 + 向量 RRF + boosting 的最终得分）
 * - 命中来源：matchedBy（"bm25" / "vector" / "both"）
 * - 高亮片段：snippet（命中文本片段，便于 UI 展示）
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     symbol: { symbolId: "src/services/UserService.ts:UserService.login", ... },
 *     score: 0.873,
 *     matchedBy: "both",
 *     snippet: "async login(email: string, password: string) { ... }"
 *   }
 */
export interface SearchResult {
  /** 命中的索引符号（全量字段） */
  readonly symbol: IndexedSymbol;
  /** 综合得分（0~1，BM25 + 向量 RRF + boosting 后的归一化分数） */
  readonly score: number;
  /** 命中来源（"bm25"=FTS5 命中，"vector"=向量命中，"both"=双路命中） */
  readonly matchedBy: "bm25" | "vector" | "both";
  /** 命中片段（命中文本片段，便于 UI 展示） */
  readonly snippet: string;
}

// ============================================================================
// 3. Git Diff 与增量索引
// ============================================================================

/**
 * Git Diff 文件变更类型（字面量联合类型）
 *
 * - added：新增文件
 * - modified：修改文件
 * - deleted：删除文件
 * - renamed：重命名文件
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type GitDiffType = "added" | "modified" | "deleted" | "renamed";

/**
 * Git Diff 文件变更（单文件的 diff 信息）
 *
 * 描述一个文件的 git diff 信息，用于 SymbolIndexer.indexIncremental
 * 驱动增量索引重建。
 *
 * 范例：
 *   {
 *     type: "modified",
 *     filePath: "src/services/UserService.ts",
 *     oldFilePath: undefined,
 *     addedLines: [42, 43, 44],
 *     removedLines: [40]
 *   }
 */
export interface GitDiffFile {
  /** 变更类型（added/modified/deleted/renamed） */
  readonly type: GitDiffType;
  /** 文件相对路径（变更后路径） */
  readonly filePath: string;
  /** 旧文件路径（仅 renamed 类型时有效） */
  readonly oldFilePath?: string;
  /** 新增行号列表（1-based） */
  readonly addedLines: ReadonlyArray<number>;
  /** 删除行号列表（1-based，相对旧文件） */
  readonly removedLines: ReadonlyArray<number>;
}

/**
 * Git Diff（一次 git diff 的完整信息）
 *
 * 用于 SymbolIndexer.indexIncremental 的入参，驱动增量索引重建：
 * - changedFiles：变更文件列表
 * - baseCommit：基线 commit（diff 起点）
 * - headCommit：目标 commit（diff 终点）
 *
 * 范例：
 *   {
 *     changedFiles: [{ type: "modified", filePath: "src/UserService.ts", ... }],
 *     baseCommit: "abc1234",
 *     headCommit: "def5678"
 *   }
 */
export interface GitDiff {
  /** 变更文件列表 */
  readonly changedFiles: ReadonlyArray<GitDiffFile>;
  /** 基线 commit SHA（diff 起点） */
  readonly baseCommit: string;
  /** 目标 commit SHA（diff 终点） */
  readonly headCommit: string;
}

/**
 * 增量索引重建结果（SymbolIndexer.indexIncremental 的产出）
 *
 * 描述一次增量重建的结果：
 * - reindexedFiles：本次重解析的文件列表
 * - impactedSymbols：受影响的符号列表（含反向 1 跳闭包）
 * - addedSymbols：新增的符号列表
 * - updatedSymbols：更新的符号列表
 * - removedSymbols：移除的符号列表
 * - skipped：是否跳过重建（小变更直通场景为 true）
 * - reason：跳过原因或重建说明
 *
 * 范例：
 *   {
 *     reindexedFiles: ["src/UserService.ts"],
 *     impactedSymbols: ["src/UserService.ts:UserService.login", ...],
 *     addedSymbols: [...],
 *     updatedSymbols: [...],
 *     removedSymbols: [],
 *     skipped: false,
 *     reason: "增量重建：1 个变更文件，5 个受影响符号"
 *   }
 */
export interface ReindexResult {
  /** 本次重解析的文件列表 */
  readonly reindexedFiles: ReadonlyArray<string>;
  /** 受影响的符号列表（含反向 1 跳闭包） */
  readonly impactedSymbols: ReadonlyArray<string>;
  /** 新增的符号列表 */
  readonly addedSymbols: ReadonlyArray<IndexedSymbol>;
  /** 更新的符号列表 */
  readonly updatedSymbols: ReadonlyArray<IndexedSymbol>;
  /** 移除的符号列表（仅 symbolId 字段） */
  readonly removedSymbols: ReadonlyArray<string>;
  /** 是否跳过重建（小变更直通场景为 true） */
  readonly skipped: boolean;
  /** 跳过原因或重建说明 */
  readonly reason: string;
}

// ============================================================================
// 4. RRF 融合与 BM25 默认参数
// ============================================================================

/**
 * 默认 RRF 融合常数 k
 *
 * 对应 EAG 方案 §5.11.6 V2-P4 设计——RRF 融合常数 k=60。
 * RRF 公式：score(d) = Σ 1/(k + rank_i(d))，k 越大对低排名结果越宽容。
 *
 * 使用 Object.freeze 冻结。
 */
export const DEFAULT_RRF_K: number = Object.freeze(60) as number;

/**
 * 默认检索结果数上限 topK
 *
 * 对应 EAG 方案 §5.11.6 V2-P4 设计——默认 topK=10。
 *
 * 使用 Object.freeze 冻结。
 */
export const DEFAULT_TOP_K: number = Object.freeze(10) as number;

/**
 * 焦点符号加权系数（focusPoints 命中时的 boosting 倍数）
 *
 * 对应 EAG 方案 §5.11.6 V2-P4 设计——focusPoints 上下文 1.5x 加权。
 *
 * 使用 Object.freeze 冻结。
 */
export const FOCUS_POINT_BOOST: number = Object.freeze(1.5) as number;

/**
 * 小变更直通阈值（变更文件数上限）
 *
 * 对应 EAG 方案 §5.11.6 V2-P4 设计——变更文件 ≤2 且 impacted ≤10 时跳过重建。
 * 本常量是"变更文件数上限"，即 changedFiles.length ≤ 2。
 *
 * 使用 Object.freeze 冻结。
 */
export const SMALL_CHANGE_FILE_THRESHOLD: number = Object.freeze(2) as number;

/**
 * 小变更直通阈值（受影响符号数上限）
 *
 * 对应 EAG 方案 §5.11.6 V2-P4 设计——变更文件 ≤2 且 impacted ≤10 时跳过重建。
 * 本常量是"受影响符号数上限"，即 impactedSymbols.length ≤ 10。
 *
 * 使用 Object.freeze 冻结。
 */
export const SMALL_CHANGE_IMPACTED_THRESHOLD: number = Object.freeze(10) as number;
