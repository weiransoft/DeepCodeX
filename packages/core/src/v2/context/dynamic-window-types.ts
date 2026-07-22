/**
 * EAG-P6 Phase 2 动态窗口共享类型定义
 *
 * 本模块定义 DynamicWindowManager 与 CodeMapSnippetProvider 共享的全部类型、
 * 接口与常量：
 * - 枚举类型：LoopPhase / CodeMapSnippetType / DynamicWindowSource
 * - 核心数据结构：CodeMapSnippet / DynamicWindowQuery / DynamicWindowResult
 * - Token 预算分配结构：TokenBudgetAllocation
 * - 预算分配常量与片段上限常量
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §3 FR-1（DynamicWindowManager）/ FR-2（CodeMapSnippetProvider）
 *   + DW-1~DW-4 四层供给策略
 * - EAG-P6-ARCHITECTURE.md §5.1 核心数据模型 + §5.2 接口契约 1/2
 *   + §6 数据流图（DW-1~DW-4 四层供给）
 * - EAG-P6-TASKS.md §3 TASK-P6-2-01（动态窗口类型与常量定义）
 *
 * 与 Phase 1 类型的关系：
 * - 复用 symbol-graph-types.ts 的 SymbolKind（在 v2/index.ts 中重命名为 GraphSymbolKind）
 *   与 Confidence 类型，避免重复定义
 * - CodeMapSnippet 派生自 SymbolRecord，新增 distance（BFS 距离）与 confidence（边置信度）
 *   两个字段，便于评分排序与可追溯性
 *
 * 不可变优先原则（对齐 NFR-8）：
 * - 所有字段 readonly
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层枚举常量使用 Object.freeze 冻结
 *
 * @module v2/context/dynamic-window-types
 */

import type { Confidence, SymbolKind } from "./symbol-graph-types";

// ============================================================================
// 1. Loop 阶段枚举（LoopPhase）
// ============================================================================

/**
 * Loop 阶段枚举（用于 DynamicWindowManager 决定激活哪些 DW 层）
 *
 * 与 EAG-P6-ARCHITECTURE.md §5.2 接口契约 1 中的激活规则表对齐：
 *
 * | Loop 阶段 | DW-1 焦点符号 | DW-2 爆炸半径 | DW-3 风险热点 | DW-4 语义检索 |
 * |----------|---------------|---------------|---------------|---------------|
 * | design   | ✅ 必注入      | ❌ 不激活     | ❌ 不激活     | ✅ agent 主动调用 |
 * | coding   | ✅ 必注入      | ✅ 参与评分   | ❌ 不激活     | ✅ agent 主动调用 |
 * | testing  | ✅ 必注入      | ✅ 参与评分   | ✅ 必注入     | ✅ agent 主动调用 |
 * | deploy   | ✅ 必注入      | ❌ 不激活     | ❌ 不激活     | ✅ agent 主动调用 |
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type LoopPhase = "design" | "coding" | "testing" | "deploy";

/**
 * LoopPhase 全部合法值（用于运行时枚举、测试断言、参数校验）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改（NFR-8 不可变优先）。
 */
export const LOOP_PHASES: ReadonlyArray<LoopPhase> = Object.freeze(["design", "coding", "testing", "deploy"]);

// ============================================================================
// 2. CodeMap 片段类型枚举（CodeMapSnippetType）
// ============================================================================

/**
 * CodeMap 片段类型常量枚举（D-5 决策：不含 conversation/dialog/turn）
 *
 * 三种片段类型对应 DW-1/DW-2/DW-3 三层供给策略：
 * - CODEMAP_SYMBOL（DW-1）：焦点符号直供片段，必注入，上限 3 片段
 * - CODEMAP_IMPACT（DW-2）：爆炸半径片段，参与评分竞争，无硬上限
 * - CODEMAP_RISK（DW-3）：风险热点片段，TESTING 阶段必注入，上限 5 片段
 *
 * 命名设计（D-5 决策）：
 * - 三种 type 均以 "codemap_" 前缀开头，便于 SlidingWindowManager 按 type
 *   前缀识别 codemap 片段并应用 30% 子预算
 * - 不含 conversation/dialog/turn 关键字，避免被 sliding-window.ts 的
 *   isConversationSnippet 函数误判为对话片段
 *
 * 使用 Object.freeze + as const 冻结，防止运行期被篡改。
 */
export const CODEMAP_SNIPPET_TYPE = Object.freeze({
  /** DW-1 焦点符号直供片段（必注入，上限 3 片段，不经评分） */
  CODEMAP_SYMBOL: "codemap_symbol",
  /** DW-2 爆炸半径片段（参与评分竞争，无硬上限） */
  CODEMAP_IMPACT: "codemap_impact",
  /** DW-3 风险热点片段（TESTING 阶段必注入，上限 5 片段） */
  CODEMAP_RISK: "codemap_risk",
} as const);

/**
 * CodeMap 片段类型（从 CODEMAP_SNIPPET_TYPE 常量派生的字面量联合类型）
 *
 * 派生方式：typeof CODEMAP_SNIPPET_TYPE[keyof typeof CODEMAP_SNIPPET_TYPE]
 * 结果："codemap_symbol" | "codemap_impact" | "codemap_risk"
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type CodeMapSnippetType = (typeof CODEMAP_SNIPPET_TYPE)[keyof typeof CODEMAP_SNIPPET_TYPE];

/**
 * CodeMapSnippetType 全部合法值（用于运行时枚举、测试断言、参数校验）
 *
 * 使用 Object.freeze 冻结。
 */
export const CODEMAP_SNIPPET_TYPES: ReadonlyArray<CodeMapSnippetType> = Object.freeze([
  CODEMAP_SNIPPET_TYPE.CODEMAP_SYMBOL,
  CODEMAP_SNIPPET_TYPE.CODEMAP_IMPACT,
  CODEMAP_SNIPPET_TYPE.CODEMAP_RISK,
]);

// ============================================================================
// 3. 动态窗口结果来源枚举（DynamicWindowSource）
// ============================================================================

/**
 * 动态窗口结果来源枚举（描述 DynamicWindowResult.snippets 的主要来源）
 *
 * - dw1：全部片段来自 DW-1 焦点符号直供
 * - dw2：主要片段来自 DW-2 爆炸半径（参与评分竞争后胜出）
 * - dw3：主要片段来自 DW-3 风险热点
 * - mixed：多来源混合（DW-1 + DW-2 或 DW-1 + DW-3 等）
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type DynamicWindowSource = "dw1" | "dw2" | "dw3" | "mixed";

/**
 * DynamicWindowSource 全部合法值
 *
 * 使用 Object.freeze 冻结。
 */
export const DYNAMIC_WINDOW_SOURCES: ReadonlyArray<DynamicWindowSource> = Object.freeze(["dw1", "dw2", "dw3", "mixed"]);

// ============================================================================
// 4. CodeMap 片段数据结构（CodeMapSnippet）
// ============================================================================

/**
 * CodeMap 片段（CodeMapSnippet）
 *
 * 描述 DW-1/DW-2/DW-3 三层供给产出的单个符号片段，派生自 SymbolRecord，
 * 新增 distance（BFS 距离）与 confidence（边置信度）两个图谱派生字段。
 *
 * 字段说明：
 * - 标识字段：type（片段类型）/ symbolId（图谱节点唯一 ID）
 * - 元数据字段：name / kind / signature / summary / filePath / startLine / endLine
 *   （直接派生自 SymbolRecord 同名字段）
 * - 风险字段：importance（0-1，DW-3 风险热点排序依据）
 * - 图谱派生字段：
 *   - distance：BFS 距离（焦点符号 → 当前符号的跳数，焦点符号本身为 0）
 *   - confidence：边置信度（HIGH/MEDIUM/LOW，源于 V2-P4 两级解析派生的边）
 *
 * 设计取舍（与架构师文档 §5.1 的关系）：
 * - 架构师文档 §5.1 CodeMapSnippet 含 content/source/relevance/impactRadius/riskScore
 *   等字段，更接近 ContextSnippet 风格（通用片段模型）
 * - 本实现采用任务描述中的契约：直接派生自 SymbolRecord，便于评分排序与可追溯性
 * - 两种契约可互转：DynamicWindowManager 在产出 DynamicWindowResult 时，
 *   可将 CodeMapSnippet 转换为 ContextSnippet 注入 SlidingWindowManager
 *
 * 不可变优先：所有字段 readonly，构建后通过 Object.freeze 冻结。
 *
 * 范例：
 *   {
 *     type: "codemap_symbol",
 *     symbolId: "src/services/UserService.ts:UserService",
 *     name: "UserService",
 *     kind: "class",
 *     signature: "class UserService { login(email, password): Promise<AuthToken> }",
 *     summary: "用户服务类，封装登录与权限校验",
 *     filePath: "src/services/UserService.ts",
 *     startLine: 10,
 *     endLine: 80,
 *     importance: 0.82,
 *     distance: 0,
 *     confidence: "HIGH"
 *   }
 */
export interface CodeMapSnippet {
  /** 片段类型（DW-1 codemap_symbol / DW-2 codemap_impact / DW-3 codemap_risk） */
  readonly type: CodeMapSnippetType;
  /** 符号唯一 ID（格式：filePath:fullyQualifiedName，与 SymbolRecord.symbolId 一致） */
  readonly symbolId: string;
  /** 符号名（不含类前缀，与 SymbolRecord.name 一致） */
  readonly name: string;
  /** 符号类型（function/class/interface/type/variable/module/namespace） */
  readonly kind: SymbolKind;
  /** 符号签名（函数为参数与返回类型；类/接口为定义概要，可选） */
  readonly signature?: string;
  /** 符号摘要（一句话描述符号职责，可选） */
  readonly summary?: string;
  /** 文件相对路径（POSIX 路径，与 SymbolRecord.filePath 一致） */
  readonly filePath: string;
  /** 起始行号（1-based，与 SymbolRecord.startLine 一致） */
  readonly startLine: number;
  /** 结束行号（1-based，含，与 SymbolRecord.endLine 一致） */
  readonly endLine: number;
  /**
   * 重要性评分（0-1，与 SymbolRecord.importance 一致）
   *
   * DW-3 风险热点排序依据；DW-1/DW-2 片段保留此字段供评分参考。
   */
  readonly importance: number;
  /**
   * BFS 距离（焦点符号 → 当前符号的跳数）
   *
   * - DW-1 焦点符号本身：distance = 0
   * - DW-2 爆炸半径片段：distance = 1~maxDepth（BFS 跳数）
   * - DW-3 风险热点片段：distance = Number.MAX_SAFE_INTEGER（不参与距离评分，
   *   而是按 importance 排序）
   *
   * 用于 RelevanceScorer 符号级距离评分（跳数越近分数越高）。
   */
  readonly distance: number;
  /**
   * 边置信度（HIGH/MEDIUM/LOW，源于 V2-P4 两级解析派生的边）
   *
   * - DW-1 焦点符号：confidence = "HIGH"（焦点符号必注入，置信度最高）
   * - DW-2 爆炸半径片段：confidence = BFS 路径上最弱边的置信度
   *   （路径上若任一边为 LOW，则整体 confidence = LOW）
   * - DW-3 风险热点片段：confidence = "HIGH"（风险热点按 importance 排序，
   *   无显式边置信度，统一为 HIGH）
   *
   * 用于 RelevanceScorer 加权评分（HIGH=1.0 / MEDIUM=0.7 / LOW=0.4）。
   */
  readonly confidence: Confidence;
}

// ============================================================================
// 5. 动态窗口查询参数（DynamicWindowQuery）
// ============================================================================

/**
 * 动态窗口查询参数（DynamicWindowQuery）
 *
 * 任务上下文摘要，供 DynamicWindowManager.computeWindow 与
 * CodeMapSnippetProvider 各 collect* 方法共享。
 *
 * 字段说明：
 * - focusPoints：焦点符号 ID 列表（DW-1 数据源，必填，来自任务卡 focusPoints）
 * - impactRoots：影响根符号 ID 列表（DW-2 数据源，可选，来自 changedFiles 派生）
 * - riskTopN：风险热点 Top-N（DW-3 数据源，可选，默认 MAX_DW3_RISK_SNIPPETS=5）
 * - maxSnippets：单轮最大片段数（防结果集过大，由调用方根据 Token 预算估算）
 * - role：当前角色 ID（如 "solo_coder" / "test_expert"，用于角色相关日志追踪）
 * - phase：当前 Loop 阶段（"design" / "coding" / "testing" / "deploy"，
 *   决定激活哪些 DW 层）
 *
 * 不可变优先：所有字段 readonly + ReadonlyArray，构建后不修改。
 *
 * 范例：
 *   {
 *     focusPoints: ["src/services/UserService.ts:UserService"],
 *     impactRoots: ["src/services/UserService.ts:UserService"],
 *     riskTopN: 5,
 *     maxSnippets: 30,
 *     role: "solo_coder",
 *     phase: "coding"
 *   }
 */
export interface DynamicWindowQuery {
  /** 焦点符号 ID 列表（DW-1 数据源，必填，来自任务卡 focusPoints） */
  readonly focusPoints: ReadonlyArray<string>;
  /** 影响根符号 ID 列表（DW-2 数据源，可选，来自 changedFiles 派生） */
  readonly impactRoots?: ReadonlyArray<string>;
  /** 风险热点 Top-N（DW-3 数据源，可选，默认 MAX_DW3_RISK_SNIPPETS=5） */
  readonly riskTopN?: number;
  /** 单轮最大片段数（防结果集过大，由调用方根据 Token 预算估算） */
  readonly maxSnippets: number;
  /** 当前角色 ID（如 "solo_coder" / "test_expert"，用于角色相关日志追踪） */
  readonly role: string;
  /** 当前 Loop 阶段（决定激活哪些 DW 层） */
  readonly phase: LoopPhase;
}

// ============================================================================
// 6. 动态窗口结果（DynamicWindowResult）
// ============================================================================

/**
 * 动态窗口结果（DynamicWindowResult）
 *
 * DynamicWindowManager.computeWindow 的返回值，含最终保留的片段列表、
 * Token 估算、来源标识与低相关性丢弃统计。
 *
 * 字段说明：
 * - snippets：最终保留的片段列表（已按相关性评分排序，已 Token 截断）
 * - totalTokens：保留片段的累计 Token 估算（4 字符 ≈ 1 token）
 * - source：主要来源标识（dw1/dw2/dw3/mixed，用于审计与可追溯性）
 * - droppedLowRelevance：因相关性评分过低被丢弃的片段数（不超 Token 预算
 *   但评分低于阈值，被丢弃以给高评分片段让路）
 *
 * 不可变优先：所有字段 readonly + ReadonlyArray，构建后通过 Object.freeze 冻结。
 *
 * 范例：
 *   {
 *     snippets: [...],  // 15 个片段
 *     totalTokens: 8500,
 *     source: "mixed",
 *     droppedLowRelevance: 3
 *   }
 */
export interface DynamicWindowResult {
  /** 最终保留的片段列表（已按相关性评分排序，已 Token 截断，已冻结） */
  readonly snippets: ReadonlyArray<CodeMapSnippet>;
  /** 保留片段的累计 Token 估算（4 字符 ≈ 1 token） */
  readonly totalTokens: number;
  /** 主要来源标识（dw1/dw2/dw3/mixed，用于审计与可追溯性） */
  readonly source: DynamicWindowSource;
  /** 因相关性评分过低被丢弃的片段数（评分低于阈值，被丢弃以给高评分片段让路） */
  readonly droppedLowRelevance: number;
}

// ============================================================================
// 7. Token 预算分配结构（TokenBudgetAllocation）
// ============================================================================

/**
 * Token 预算分配结构（TokenBudgetAllocation）
 *
 * DynamicWindowManager.allocateTokenBudget 的返回值，描述 codemap 与其他片段
 * 的预算分配与实际使用情况。
 *
 * 分配规则（D-6 决策）：
 * - codemapBudget = totalBudget * CODEMAP_BUDGET_RATIO（默认 30%）
 * - otherBudget = totalBudget - codemapBudget（默认 70%）
 *
 * 使用统计：
 * - codemapUsed：实际 codemap 片段消耗的 Token 数（≤ codemapBudget）
 * - otherUsed：实际其他片段消耗的 Token 数（≤ otherBudget）
 *
 * 用途：
 * - SlidingWindowManager 按 codemapBudget / otherBudget 分别截断两类片段
 * - DynamicWindowManager 在 computeWindow 中填充实际使用量，供审计与日志追踪
 *
 * 不可变优先：所有字段 readonly，构建后通过 Object.freeze 冻结。
 *
 * 范例：
 *   {
 *     codemapBudget: 3000,
 *     otherBudget: 7000,
 *     codemapUsed: 2800,
 *     otherUsed: 6500
 *   }
 */
export interface TokenBudgetAllocation {
  /** CodeMap 片段预算（totalBudget * CODEMAP_BUDGET_RATIO，默认 30%） */
  readonly codemapBudget: number;
  /** 其他片段预算（totalBudget - codemapBudget，默认 70%） */
  readonly otherBudget: number;
  /** 实际 CodeMap 片段消耗的 Token 数（≤ codemapBudget） */
  readonly codemapUsed: number;
  /** 实际其他片段消耗的 Token 数（≤ otherBudget） */
  readonly otherUsed: number;
}

// ============================================================================
// 8. 预算分配常量与片段上限常量
// ============================================================================

/**
 * CodeMap 片段预算占比（D-6 决策：30% codemap + 70% 其他）
 *
 * SlidingWindowManager 按此比例将总 Token 预算分配给 codemap 片段与其他片段，
 * 避免 codemap 片段挤占过多预算导致对话历史与文件内容被压缩。
 *
 * 取值范围：0.0 ~ 1.0
 * 默认值：0.3（30%）
 *
 * 使用 Object.freeze 冻结。
 */
export const CODEMAP_BUDGET_RATIO: number = Object.freeze(0.3) as number;

/**
 * 其他片段预算占比（1 - CODEMAP_BUDGET_RATIO = 70%）
 *
 * 使用 Object.freeze 冻结。
 */
export const OTHER_BUDGET_RATIO: number = Object.freeze(0.7) as number;

/**
 * DW-1 焦点符号直供片段上限（D-3 决策：上限 3 片段）
 *
 * 焦点符号必注入，但上限 3 片段以防止挤占过多 Token 预算。
 * 来源：EAG-P6-ARCHITECTURE.md §5.2 接口契约 2 + EAG-P6-REQUIREMENTS.md §3 FR-2
 *
 * 使用 Object.freeze 冻结。
 */
export const MAX_DW1_SYMBOL_SNIPPETS: number = Object.freeze(3) as number;

/**
 * DW-3 风险热点片段上限（D-3 决策：上限 5 片段，测试专家必见）
 *
 * TESTING 阶段必注入风险热点 Top-5，确保测试专家能优先关注高风险符号。
 * 来源：EAG-P6-ARCHITECTURE.md §5.2 接口契约 2 + EAG-P6-REQUIREMENTS.md §3 FR-2
 *
 * 使用 Object.freeze 冻结。
 */
export const MAX_DW3_RISK_SNIPPETS: number = Object.freeze(5) as number;

/**
 * DW-4 codemap_search 工具单轮调用上限（D-3 决策：上限 5 次）
 *
 * 单轮 LLM 请求中 codemap_search 工具最多调用 5 次，防止 agent 滥用工具
 * 消耗过多 Token。由 tool-executor 在工具注册时强制限制。
 *
 * 使用 Object.freeze 冻结。
 */
export const MAX_CODEMAP_TOOLS_PER_TURN: number = Object.freeze(5) as number;

/**
 * DW-2 爆炸半径 BFS 最大深度（架构师 §5.2 接口契约 5：最大 3，防图谱爆炸）
 *
 * getExplosionRadius 的 maxDepth 参数上限，防止 BFS 遍历过深导致结果集过大。
 *
 * 使用 Object.freeze 冻结。
 */
export const MAX_EXPLOSION_RADIUS_DEPTH: number = Object.freeze(3) as number;

/**
 * DW-2 爆炸半径 BFS 默认深度（默认 2，架构师 §5.2 接口契约 5）
 *
 * DynamicWindowManager 调用 getExplosionRadius 时使用的默认 maxDepth 值。
 * 平衡影响面分析精度与性能（2 跳覆盖直接调用者与间接调用者）。
 *
 * 使用 Object.freeze 冻结。
 */
export const DEFAULT_EXPLOSION_RADIUS_DEPTH: number = Object.freeze(2) as number;

/**
 * DW-2 爆炸半径 BFS 默认最大节点数（防结果集过大）
 *
 * DynamicWindowManager 调用 getExplosionRadius 时使用的默认 maxNodes 值。
 *
 * 使用 Object.freeze 冻结。
 */
export const DEFAULT_EXPLOSION_RADIUS_MAX_NODES: number = Object.freeze(50) as number;

/**
 * Token 估算系数（4 字符 ≈ 1 token，OpenAI 经验值）
 *
 * 与 sliding-window.ts 的 charsPerToken 默认值一致，用于 DynamicWindowManager
 * 估算片段 Token 数。
 *
 * 使用 Object.freeze 冻结。
 */
export const CHARS_PER_TOKEN: number = Object.freeze(4) as number;

/**
 * 低相关性丢弃阈值（评分低于此值的片段被丢弃）
 *
 * DynamicWindowManager 在 computeWindow 中按此阈值过滤低评分片段，
 * 避免低相关性片段挤占 Token 预算。
 *
 * 取值范围：0.0 ~ 1.0
 * 默认值：0.1（评分低于 0.1 的片段被丢弃）
 *
 * 使用 Object.freeze 冻结。
 */
export const LOW_RELEVANCE_THRESHOLD: number = Object.freeze(0.1) as number;

// ============================================================================
// 9. 空返回常量（供降级路径复用，避免重复创建数组）
// ============================================================================

/**
 * 空 CodeMapSnippet 列表常量（冻结，供降级实现复用）
 *
 * DynamicWindowManager 与 CodeMapSnippetProvider 在降级模式下返回此常量，
 * 避免每次调用创建新数组对象（性能优化 + 不可变优先）。
 */
export const EMPTY_CODEMAP_SNIPPETS: ReadonlyArray<CodeMapSnippet> = Object.freeze([]);

/**
 * 空动态窗口结果常量（冻结，供降级实现复用）
 *
 * DynamicWindowManager 在降级模式下返回此常量，零开销降级。
 */
export const EMPTY_DYNAMIC_WINDOW_RESULT: Readonly<DynamicWindowResult> = Object.freeze({
  snippets: EMPTY_CODEMAP_SNIPPETS,
  totalTokens: 0,
  source: "dw1",
  droppedLowRelevance: 0,
});

/**
 * 空预算分配常量（冻结，供降级实现复用）
 *
 * DynamicWindowManager 在降级模式下返回此常量，零开销降级。
 */
export const EMPTY_TOKEN_BUDGET_ALLOCATION: Readonly<TokenBudgetAllocation> = Object.freeze({
  codemapBudget: 0,
  otherBudget: 0,
  codemapUsed: 0,
  otherUsed: 0,
});
