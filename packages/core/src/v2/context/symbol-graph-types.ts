/**
 * EAG-P6 Phase 1 符号图谱共享类型定义
 *
 * 本模块定义 SymbolGraphAdapter（V2-P4 符号图谱适配层）所需的全部共享类型：
 * - 枚举类型：SymbolKind / EdgeDirection / EdgeKind / Confidence
 * - 核心数据结构：SymbolRecord / EdgeRecord
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §3 FR-7（CodeMap 降级探测）
 * - EAG-P6-ARCHITECTURE.md §5.1 核心数据模型 + §5.2 接口契约 5（SymbolGraphAdapter）
 * - EAG-P6-TASKS.md §3 TASK-P6-1-01（用户任务规格：与 P5 SymbolGraphStore 解耦，P6 不依赖 P5）
 *
 * 与既有 PKC L2 类型的关系：
 * - 本文件 SymbolKind 与 eag/pkc/l2-types.ts 的 SymbolKind **不同**：
 *   - L2 SymbolKind：class/function/method/interface/variable/enum/type-alias/property
 *     （索引器粒度，正则提取的 8 种语法类别）
 *   - P6 SymbolKind：function/class/interface/type/variable/module/namespace
 *     （图谱节点粒度，覆盖模块/命名空间等容器类节点，去掉了 method/enum/property
 *     —— method 归属 class 节点内部，property 归属 class/interface 节点内部，
 *     enum 与 type-alias 统一为 type；module 与 namespace 是 DDD/模块化架构必备）
 * - 两者语义不同：L2 是"语法类别"，P6 是"图谱节点类别"，故分别定义。
 * - P6 SymbolGraphAdapter 不依赖 PKC L2 SymbolIndexer，可独立使用。
 *
 * 不可变优先原则（对齐 NFR-8）：
 * - 所有字段 readonly
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层枚举常量使用 Object.freeze 冻结
 *
 * @module v2/context/symbol-graph-types
 */

// ============================================================================
// 1. 符号节点类型枚举（SymbolKind）
// ============================================================================

/**
 * 符号节点类型（字面量联合类型，覆盖图谱节点全部语法类别）
 *
 * 用于标注 SymbolRecord.kind 字段，决定节点在图谱中的语义角色：
 * - function：函数声明（独立函数 / 顶层函数 / 工具函数）
 * - class：类声明（聚合方法与属性的容器节点）
 * - interface：接口声明（抽象契约节点）
 * - type：类型别名（type T = ...）/ 枚举（enum）/ 联合类型等
 * - variable：变量声明（const/let/var 顶层变量，通常为常量或配置）
 * - module：ES Module 文件模块（一个 .ts/.js 文件作为一个模块节点）
 * - namespace：命名空间（TypeScript namespace 或 Java package 等容器）
 *
 * 设计取舍：
 * - 不包含 method/property：方法与属性归属 class/interface 节点内部，
 *   图谱节点不展开到方法粒度（避免图谱爆炸，方法级粒度由 PKC L2 索引承担）
 * - 不包含 enum：enum 与 type-alias 语义接近（皆为类型声明），统一归入 type
 * - 新增 module/namespace：DDD/模块化架构中模块与命名空间是核心节点类型，
 *   用于表达"模块间依赖"与"命名空间嵌套"关系
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type SymbolKind = "function" | "class" | "interface" | "type" | "variable" | "module" | "namespace";

/**
 * SymbolKind 全部合法值（用于运行时枚举、测试断言、参数校验）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改（NFR-8 不可变优先）。
 */
export const SYMBOL_KINDS: ReadonlyArray<SymbolKind> = Object.freeze([
  "function",
  "class",
  "interface",
  "type",
  "variable",
  "module",
  "namespace",
]);

// ============================================================================
// 2. 边方向枚举（EdgeDirection）
// ============================================================================

/**
 * 边方向枚举（用于 getEdges 方法过滤边的方向）
 *
 * - incoming：入边（其他节点指向当前节点，如 B 调用 A，对 A 而言是 incoming）
 * - outgoing：出边（当前节点指向其他节点，如 A 调用 B，对 A 而言是 outgoing）
 * - both：双向（incoming + outgoing 全部返回，用于影响面分析）
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type EdgeDirection = "incoming" | "outgoing" | "both";

/**
 * EdgeDirection 全部合法值
 *
 * 使用 Object.freeze 冻结。
 */
export const EDGE_DIRECTIONS: ReadonlyArray<EdgeDirection> = Object.freeze(["incoming", "outgoing", "both"]);

// ============================================================================
// 3. 边类型枚举（EdgeKind）
// ============================================================================

/**
 * 边类型枚举（描述符号间的语义关系）
 *
 * - CALLS：函数/方法调用关系（A 函数体中调用 B 函数）
 * - INHERITS：继承关系（class A extends B）
 * - IMPLEMENTS：实现关系（class A implements interface B）
 * - TESTED_BY：被测试关系（被测函数 A ← 测试用例 B）
 * - REFERENCES：引用关系（变量/类型引用，如 A 引用 B 导出的常量）
 * - DEPENDS_ON：模块级依赖（module A 依赖 module B，由 import 语句派生）
 *
 * 字面量联合而非 string，避免拼写错误。
 *
 * 设计依据：EAG 主方案 §5.11.6 V2-P4 R1~R6 两级符号边解析。
 */
export type EdgeKind = "CALLS" | "INHERITS" | "IMPLEMENTS" | "TESTED_BY" | "REFERENCES" | "DEPENDS_ON";

/**
 * EdgeKind 全部合法值
 *
 * 使用 Object.freeze 冻结。
 */
export const EDGE_KINDS: ReadonlyArray<EdgeKind> = Object.freeze([
  "CALLS",
  "INHERITS",
  "IMPLEMENTS",
  "TESTED_BY",
  "REFERENCES",
  "DEPENDS_ON",
]);

// ============================================================================
// 4. 置信度枚举（Confidence）
// ============================================================================

/**
 * 边置信度枚举（描述边的可信度，源于 V2-P4 两级解析）
 *
 * - HIGH：高置信度（R1 级，直接 AST 解析 / 显式 import 关系）
 * - MEDIUM：中置信度（R2 级，正则匹配 / 命名约定推断）
 * - LOW：低置信度（R3 级，启发式推断 / 跨文件同名匹配）
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

/**
 * Confidence 全部合法值
 *
 * 使用 Object.freeze 冻结。
 */
export const CONFIDENCE_LEVELS: ReadonlyArray<Confidence> = Object.freeze(["HIGH", "MEDIUM", "LOW"]);

/**
 * Confidence 数值化映射（用于风险评分加权，数值越高置信度越高）
 *
 * 使用 Object.freeze 冻结。
 */
export const CONFIDENCE_WEIGHTS: Readonly<Record<Confidence, number>> = Object.freeze({
  HIGH: 1.0,
  MEDIUM: 0.7,
  LOW: 0.4,
});

// ============================================================================
// 5. 符号节点数据结构（SymbolRecord）
// ============================================================================

/**
 * 符号节点记录（SymbolRecord）
 *
 * 描述图谱中一个符号节点的完整信息：
 * - 标识字段：symbolId 唯一、kind/name 路由查询
 * - 位置字段：filePath/startLine/endLine 定位代码
 * - 语义字段：signature/summary 供检索展示
 * - 风险字段：importance 风险评分（0-1，DW-3 风险热点排序依据）
 * - 向量字段：embedding（可选，无向量模型时为 undefined）
 *
 * 不可变优先：所有字段 readonly，构建后不修改；
 * 图谱更新通过生成新的 SymbolRecord 替换旧记录。
 *
 * 范例：
 *   {
 *     symbolId: "src/services/UserService.ts:UserService",
 *     kind: "class",
 *     name: "UserService",
 *     signature: "class UserService { login(email, password): Promise<AuthToken> }",
 *     filePath: "src/services/UserService.ts",
 *     startLine: 10,
 *     endLine: 80,
 *     summary: "用户服务类，封装登录/注册/权限校验",
 *     importance: 0.82,
 *     embedding: [0.12, -0.34, ...]
 *   }
 */
export interface SymbolRecord {
  /** 符号唯一 ID（格式：filePath:fullyQualifiedName，如 "src/UserService.ts:UserService"） */
  readonly symbolId: string;
  /** 符号类型（function/class/interface/type/variable/module/namespace） */
  readonly kind: SymbolKind;
  /** 符号名（不含类前缀，如 "UserService"、"login"） */
  readonly name: string;
  /** 符号签名（函数为参数与返回类型；类/接口为定义概要） */
  readonly signature: string;
  /** 文件相对路径（相对于项目根，POSIX 路径，如 "src/services/UserService.ts"） */
  readonly filePath: string;
  /** 起始行号（1-based） */
  readonly startLine: number;
  /** 结束行号（1-based，含） */
  readonly endLine: number;
  /** 符号摘要（一句话描述符号职责，供检索结果展示） */
  readonly summary: string;
  /**
   * 重要性评分（0-1，DW-3 风险热点排序依据）
   *
   * 综合评分因子（V2-P4 风险评分 6 因子加权归一化）：
   * - 调用频次（被其他符号 CALLS 的次数）
   * - 测试覆盖（是否有 TESTED_BY 边）
   * - hub 度（入度 + 出度，hub 节点分数高）
   * - bridge 度（跨社区连接数，bridge 节点分数高）
   * - 知识缺口（文档/注释缺失度）
   * - 变更频率（最近 N 次提交中的变更次数）
   *
   * 0 表示无风险/不重要，1 表示极高风险/极重要。
   */
  readonly importance: number;
  /** 语义向量（可选，无向量模型时为 undefined，降级为纯关键词检索） */
  readonly embedding?: ReadonlyArray<number>;
}

// ============================================================================
// 6. 边数据结构（EdgeRecord）
// ============================================================================

/**
 * 边记录（EdgeRecord）
 *
 * 描述图谱中两个符号节点间的一条有向边：
 * - 标识字段：edgeId 唯一
 * - 端点字段：srcSymbolId/dstSymbolId（src → dst）
 * - 语义字段：edgeKind 关系类型
 * - 置信度字段：confidence 边可信度（V2-P4 两级解析派生）
 *
 * 不可变优先：所有字段 readonly，构建后不修改；
 * 图谱更新通过生成新的 EdgeRecord 集合替换旧集合。
 *
 * 范例：
 *   {
 *     edgeId: "edge-001",
 *     srcSymbolId: "src/OrderService.ts:OrderService.placeOrder",
 *     dstSymbolId: "src/PaymentService.ts:PaymentService.charge",
 *     edgeKind: "CALLS",
 *     confidence: "HIGH"
 *   }
 */
export interface EdgeRecord {
  /** 边唯一 ID（格式：edge-<自增整数> 或 srcSymbolId|edgeKind|dstSymbolId 哈希） */
  readonly edgeId: string;
  /** 源符号 ID（边起点） */
  readonly srcSymbolId: string;
  /** 目标符号 ID（边终点） */
  readonly dstSymbolId: string;
  /** 边类型（CALLS/INHERITS/IMPLEMENTS/TESTED_BY/REFERENCES/DEPENDS_ON） */
  readonly edgeKind: EdgeKind;
  /** 边置信度（HIGH/MEDIUM/LOW，源于 V2-P4 两级解析） */
  readonly confidence: Confidence;
}

// ============================================================================
// 7. 静态图谱数据包（StaticGraphData，供 StaticSymbolGraph 构造注入）
// ============================================================================

/**
 * 静态图谱数据包（StaticGraphData）
 *
 * 用于 StaticSymbolGraph 构造时注入静态符号与边数据。
 * 适用场景：
 * - 测试 fixtures 注入（单元测试 / 集成测试）
 * - 序列化图谱加载（从 codemap.json / codemap.db dump 加载到内存）
 * - PKC L2 索引派生（从 IndexedSymbol 派生 SymbolRecord，无显式边时 edges 为空数组）
 *
 * 不可变优先：所有字段 readonly + ReadonlyArray，构建后通过 Object.freeze 冻结。
 *
 * 范例：
 *   const data: StaticGraphData = {
 *     symbolRecords: [
 *       { symbolId: "src/A.ts:A", kind: "class", name: "A", ... },
 *       { symbolId: "src/B.ts:B", kind: "function", name: "B", ... }
 *     ],
 *     edgeRecords: [
 *       { edgeId: "e1", srcSymbolId: "src/A.ts:A", dstSymbolId: "src/B.ts:B",
 *         edgeKind: "CALLS", confidence: "HIGH" }
 *     ]
 *   };
 */
export interface StaticGraphData {
  /** 符号节点列表（图谱全部节点） */
  readonly symbolRecords: ReadonlyArray<SymbolRecord>;
  /** 边列表（图谱全部边，可为空数组表示无显式关系） */
  readonly edgeRecords: ReadonlyArray<EdgeRecord>;
}
