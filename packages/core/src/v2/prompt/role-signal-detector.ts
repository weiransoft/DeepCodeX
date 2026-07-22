/**
 * EAG-P6 Phase 3 角色信号探测器（RoleSignalDetector）
 *
 * 本模块从任务上下文（TaskContext）中检测 5 角色信号，输出按置信度降序排列的
 * RoleSignal 列表，供 RolePromptCustomizer 选择主角色 + 协作角色。
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §2 US-3（AC-3.1~AC-3.4：关键词+语义+任务类型三路检测）
 * - EAG-P6-ARCHITECTURE.md §5.2 接口契约 2（RoleSignalDetector）
 *   + §4 模块清单（embedder → TFIDF → Hashing 三级降级链）
 * - EAG-P6-TASKS.md §3 TASK-P6-3-02（RoleSignalDetector）
 * - EAG-P6-TEST-CASES.md TC-SIGNAL-001~020（关键词/语义/任务类型断言）
 *
 * 三路检测策略：
 *   1. 关键词匹配（keyword）
 *      - 复用 role-matcher.ts 的 computeKeywordOverlap 算法思路
 *      - 针对 5 角色的关键词列表（与 multi-agent-team skill v2.7 对齐）
 *      - 命中关键词数 / 关键词总数 → 重叠度 [0, 1]
 *
 *   2. 语义匹配（semantic）
 *      - 三级降级链：
 *        a. embedder 首选：使用 SymbolRecord.embedding 字段（如已由向量模型生成）
 *        b. TFIDF 降级：基于角色关键词文档与任务文本的 TFIDF 余弦相似度
 *        c. Hashing 降级：基于 token hash 向量的余弦相似度（无 IDF 加权）
 *      - 计算 task 文本向量与每个角色"关键词文档"向量的余弦相似度
 *
 *   3. 任务类型推断（task_type）
 *      - 任务类型：design / implementation / testing / review / planning / ui
 *      - 每种任务类型有对应主角色（如 design → architect）
 *      - 任务类型由关键词命中数决定，输出对应主角色的 RoleSignal
 *
 * 综合置信度计算：
 *   final_confidence = keyword_weight * keyword_score
 *                    + semantic_weight * semantic_score
 *                    + task_type_weight * task_type_score
 *
 *   权重（与 multi-agent-team v2.1 MATCH_WEIGHTS 思路一致，但适配三路检测）：
 *   - keyword  : 0.5（最强信号，直接命中角色关键词）
 *   - semantic : 0.3（次强信号，捕捉同义/上下位关系）
 *   - task_type: 0.2（辅助信号，任务类型推断）
 *
 * 输出策略：
 *   - 三路独立计算，每路输出一组 RoleSignal
 *   - 按 role 聚合，取三路加权综合置信度
 *   - 按综合置信度降序排序
 *   - 过滤置信度 < MIN_CONFIDENCE_THRESHOLD 的信号
 *
 * 不可变优先原则（对齐 NFR-8）：
 * - 所有公开接口 readonly + ReadonlyArray + Object.freeze
 * - 内部计算使用 const，无副作用
 *
 * @module v2/prompt/role-signal-detector
 */

// 导入类型与常量
import type { SymbolRecord } from "../context/symbol-graph-types.js";
import type { RoleKind } from "./role-knowledge-slices.js";
import { ROLE_KINDS } from "./role-knowledge-slices.js";

// ============================================================================
// 1. 类型定义
// ============================================================================

/**
 * 角色信号来源枚举
 *
 * - keyword  ：关键词匹配（直接命中角色关键词表）
 * - semantic ：语义匹配（embedder / TFIDF / Hashing 三级降级）
 * - task_type：任务类型推断（任务类型 → 主角色映射）
 */
export type RoleSignalSource = "keyword" | "semantic" | "task_type";

/**
 * 任务类型枚举（6 种）
 *
 * - design        ：架构设计（→ architect）
 * - implementation：编码实现（→ solo_coder）
 * - testing       ：测试验证（→ test_expert）
 * - review        ：代码审查（→ architect）
 * - planning      ：需求规划（→ product_manager）
 * - ui            ：UI 设计（→ ui_designer）
 */
export type TaskType = "design" | "implementation" | "testing" | "review" | "planning" | "ui";

/**
 * 角色信号（RoleSignal）
 *
 * 描述某角色被检测到的置信度、信号来源与原因列表。
 *
 * 不可变优先：所有字段 readonly + ReadonlyArray。
 */
export interface RoleSignal {
  /** 角色 ID（architect / product_manager / solo_coder / test_expert / ui_designer） */
  readonly role: RoleKind;
  /** 综合置信度 [0, 1]，由三路加权计算得出 */
  readonly confidence: number;
  /** 信号来源（keyword / semantic / task_type） */
  readonly source: RoleSignalSource;
  /** 原因列表（人类可读的解释，用于可解释性） */
  readonly reasons: ReadonlyArray<string>;
}

/**
 * 任务上下文（TaskContext）
 *
 * RoleSignalDetector.detect() 的输入，包含任务文本与可选的代码符号上下文。
 *
 * 字段说明：
 * - title       ：任务标题（必填，关键词匹配的主要输入）
 * - description ：任务描述（必填，关键词+语义匹配的辅助输入）
 * - focusPoints ：焦点符号名列表（可选，用于聚焦语义匹配范围）
 * - impactRoots ：影响根符号 ID 列表（可选，用于聚焦语义匹配范围）
 * - symbols     ：相关 SymbolRecord 列表（可选，提供 embedding 向量供语义匹配）
 *
 * 不可变优先：所有字段 readonly + ReadonlyArray。
 */
export interface TaskContext {
  /** 任务标题（必填，关键词匹配的主要输入） */
  readonly title: string;
  /** 任务描述（必填，关键词+语义匹配的辅助输入） */
  readonly description: string;
  /** 焦点符号名列表（可选，用于聚焦语义匹配范围） */
  readonly focusPoints?: ReadonlyArray<string>;
  /** 影响根符号 ID 列表（可选，用于聚焦语义匹配范围） */
  readonly impactRoots?: ReadonlyArray<string>;
  /** 相关 SymbolRecord 列表（可选，提供 embedding 向量供语义匹配） */
  readonly symbols?: ReadonlyArray<SymbolRecord>;
}

/**
 * 角色信号检测选项（可选，用于调权与阈值控制）
 *
 * 默认值由 DEFAULT_DETECTOR_OPTIONS 提供。
 */
export interface RoleSignalDetectorOptions {
  /** 关键词权重（默认 0.5） */
  readonly keywordWeight: number;
  /** 语义权重（默认 0.3） */
  readonly semanticWeight: number;
  /** 任务类型权重（默认 0.2） */
  readonly taskTypeWeight: number;
  /** 最小置信度阈值（默认 0.1，低于此值的信号被过滤） */
  readonly minConfidenceThreshold: number;
  /** 语义相似度命中阈值（默认 0.3，高于此值才算语义命中） */
  readonly semanticHitThreshold: number;
}

/**
 * 语义匹配降级链层级标识
 *
 * - embedding ：使用 SymbolRecord.embedding（向量模型已生成）
 * - tfidf     : TFIDF 降级（基于词频-逆文档频率）
 * - hashing   : Hashing 降级（基于 token hash 向量）
 * - none      : 无可用语义匹配（任务文本为空或全部向量长度为 0）
 */
export type SemanticFallbackLevel = "embedding" | "tfidf" | "hashing" | "none";

// ============================================================================
// 2. 常量定义
// ============================================================================

/**
 * 默认检测选项
 *
 * 权重设计（与 multi-agent-team v2.1 MATCH_WEIGHTS 思路一致，但适配三路检测）：
 * - keyword  : 0.5（最强信号，直接命中角色关键词）
 * - semantic : 0.3（次强信号，捕捉同义/上下位关系）
 * - task_type: 0.2（辅助信号，任务类型推断）
 *
 * 三者之和 = 1.0，保证综合置信度落在 [0, 1]。
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
export const DEFAULT_DETECTOR_OPTIONS: Readonly<RoleSignalDetectorOptions> = Object.freeze({
  keywordWeight: 0.5,
  semanticWeight: 0.3,
  taskTypeWeight: 0.2,
  minConfidenceThreshold: 0.1,
  semanticHitThreshold: 0.3,
});

/**
 * 5 角色关键词表（与 multi-agent-team skill v2.7 触发关键词对齐）
 *
 * 来源：
 * - architect        ：docs/roles/architect/prompt.md 触发关键词
 * - product_manager  ：docs/roles/product-manager/prompt.md 触发关键词
 * - solo_coder       ：docs/roles/solo-coder/prompt.md 触发关键词
 * - test_expert      ：docs/roles/test-expert/prompt.md 触发关键词
 * - ui_designer      ：docs/roles/ui-designer/prompt.md 触发关键词
 *
 * 用户任务描述明确要求的关键词映射：
 * - "架构" → architect
 * - "测试" → test_expert
 * - "实现" → solo_coder
 * - "UI设计" → ui_designer
 * - "需求" → product_manager
 *
 * 每个角色的关键词列表已包含上述映射关键词，并扩展了同义/相关关键词
 * 以提升召回率。
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
export const ROLE_KEYWORDS: Readonly<Record<RoleKind, ReadonlyArray<string>>> = Object.freeze({
  architect: Object.freeze([
    "架构",
    "设计",
    "选型",
    "审查",
    "性能",
    "瓶颈",
    "模块",
    "接口",
    "部署",
    "ADR",
    "架构师",
    "分层",
    "微服务",
    "事件驱动",
    "CQRS",
    "DDD",
    "依赖注入",
    "架构风格",
  ]),
  product_manager: Object.freeze([
    "需求",
    "产品",
    "PRD",
    "用户故事",
    "验收标准",
    "竞品分析",
    "产品经理",
    "需求分析",
    "用户价值",
    "MVP",
    "bite-sized",
    "用户研究",
    "需求文档",
    "功能定义",
  ]),
  solo_coder: Object.freeze([
    "实现",
    "开发",
    "代码",
    "修复",
    "优化",
    "重构",
    "单元测试",
    "文档",
    "独立开发者",
    "编码",
    "TDD",
    "红绿重构",
    "solo coder",
    "bug fix",
    "feature",
  ]),
  test_expert: Object.freeze([
    "测试",
    "质量",
    "验收",
    "自动化",
    "性能测试",
    "缺陷",
    "评审",
    "门禁",
    "测试专家",
    "QA",
    "test expert",
    "test case",
    "回归测试",
    "集成测试",
    "断言",
  ]),
  ui_designer: Object.freeze([
    "UI设计",
    "界面设计",
    "前端设计",
    "视觉设计",
    "UI/UX",
    "UI原型",
    "界面美化",
    "UI优化",
    "UI重构",
    "UI设计师",
    "ui designer",
    "AI slop",
    "anti-slop",
    "视觉规范",
    "设计系统",
  ]),
});

/**
 * 5 角色描述文档（用于 TFIDF/Hashing 语义匹配，模拟"角色文档"）
 *
 * 每个角色的描述由其关键词 + 角色职责说明拼接而成，作为语义匹配的"文档"。
 * TFIDF/Hashing 会对该文档与任务文本计算余弦相似度。
 *
 * 使用 Object.freeze 冻结。
 */
export const ROLE_DESCRIPTIONS: Readonly<Record<RoleKind, string>> = Object.freeze({
  architect:
    "架构师 architect 设计系统性前瞻性可落地可验证的架构 " +
    "架构 设计 选型 审查 性能 瓶颈 模块 接口 部署 ADR " +
    "分层 微服务 事件驱动 CQRS DDD 依赖注入 架构风格 " +
    "四步分析框架 架构风格识别 核心组件 技术栈 扩展性评估",
  product_manager:
    "产品经理 product_manager 定义用户价值清晰 需求明确 可落地 可验收的产品 " +
    "需求 产品 PRD 用户故事 验收标准 竞品分析 需求分析 " +
    "用户价值 MVP bite-sized 每步 2-5 分钟可验证 用户研究 需求文档 功能定义",
  solo_coder:
    "独立开发者 solo_coder 编写完整高质量可维护可测试的代码 " +
    "实现 开发 代码 修复 优化 重构 单元测试 文档 编码 TDD " +
    "红绿重构 NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST " +
    "bug fix feature Karpathy Simplicity First Surgical Changes",
  test_expert:
    "测试专家 test_expert 确保全面深入自动化可量化的质量保障 " +
    "测试 质量 验收 自动化 性能测试 缺陷 评审 门禁 QA " +
    "test case 回归测试 集成测试 断言 " +
    "假设 插桩 复现 分析 修复 验证 证据驱动调试法",
  ui_designer:
    "UI 设计师 ui_designer 创建独特生产级的 UI 界面 高设计质量 避免通用 AI slop 美学 " +
    "UI设计 界面设计 前端设计 视觉设计 UI/UX UI原型 界面美化 UI优化 UI重构 " +
    "反 AI-slop 禁用字体 Inter Roboto Arial system-ui " +
    "Bold aesthetic direction 设计系统 视觉规范",
});

/**
 * 任务类型 → 主角色映射
 *
 * 每种任务类型对应一个主角色，用于 task_type 信号检测：
 * - design        → architect（架构设计由架构师主导）
 * - implementation→ solo_coder（编码实现由独立开发者主导）
 * - testing       → test_expert（测试验证由测试专家主导）
 * - review        → architect（代码审查由架构师主导，确保不偏离架构）
 * - planning      → product_manager（需求规划由产品经理主导）
 * - ui            → ui_designer（UI 设计由 UI 设计师主导）
 *
 * 使用 Object.freeze 冻结。
 */
export const TASK_TYPE_TO_ROLE: Readonly<Record<TaskType, RoleKind>> = Object.freeze({
  design: "architect",
  implementation: "solo_coder",
  testing: "test_expert",
  review: "architect",
  planning: "product_manager",
  ui: "ui_designer",
});

/**
 * 任务类型推断关键词表
 *
 * 每种任务类型对应一组关键词，关键词命中数最多的任务类型即为推断结果。
 *
 * 使用 Object.freeze 冻结。
 */
export const TASK_TYPE_KEYWORDS: Readonly<Record<TaskType, ReadonlyArray<string>>> = Object.freeze({
  design: Object.freeze(["架构", "设计", "选型", "ADR", "module", "interface", "分层", "微服务"]),
  implementation: Object.freeze(["实现", "编码", "代码", "修复", "重构", "TDD", "feature", "bug fix"]),
  testing: Object.freeze(["测试", "验收", "QA", "automation", "test case", "回归", "断言"]),
  review: Object.freeze(["审查", "评审", "review", "audit", "走查"]),
  planning: Object.freeze(["规划", "需求", "PRD", "用户故事", "MVP", "竞品"]),
  ui: Object.freeze(["UI", "界面", "前端", "视觉", "UI/UX", "原型", "设计系统"]),
});

/**
 * 全部任务类型列表（用于枚举遍历）
 */
export const TASK_TYPES: ReadonlyArray<TaskType> = Object.freeze([
  "design",
  "implementation",
  "testing",
  "review",
  "planning",
  "ui",
]);

/**
 * Hashing 向量维度（2^12 = 4096，足以避免碰撞）
 *
 * 选型依据：
 * - 2^12 = 4096 维，对于 5 角色 × ~15 关键词 的场景，碰撞概率 < 1%
 * - 内存占用：4096 * 8 bytes * 6 向量 ≈ 192KB，可接受
 * - 与 scikit-learn HashingVectorizer 默认值（2^20）相比，更节省内存
 */
const HASHING_DIMENSION = 4096;

// ============================================================================
// 3. 文本处理工具函数
// ============================================================================

/**
 * 文本归一化与切词
 *
 * 切词规则（与 role-matcher.ts computeKeywordOverlap 一致）：
 * - 英文：[a-z0-9+#.-]+ 切分为单词
 * - 中文：[\u4e00-\u9fff] 每个汉字作为一个 token
 * - 全部转小写
 * - 去重
 *
 * @param text 原始文本
 * @returns token 数组（已去重，已排序保证稳定性）
 */
function tokenize(text: string): ReadonlyArray<string> {
  if (text.length === 0) return [];
  const normalized = text.toLowerCase();
  const englishWords = normalized.match(/[a-z0-9+#.-]+/g) ?? [];
  const chineseChars = normalized.match(/[\u4e00-\u9fff]/g) ?? [];
  const tokenSet = new Set<string>();
  for (const w of englishWords) {
    if (w.length > 0) tokenSet.add(w);
  }
  for (const c of chineseChars) {
    tokenSet.add(c);
  }
  // 排序保证稳定性（便于测试断言）
  return Array.from(tokenSet).sort();
}

/**
 * 计算关键词重叠度（与 role-matcher.ts computeKeywordOverlap 算法一致）
 *
 * 算法：命中关键词数 / 关键词总数
 *
 * 边界处理：
 * - keywords 为空：返回 0
 * - text 为空：返回 0
 *
 * @param text 任务文本
 * @param keywords 角色关键词列表
 * @returns 重叠度 [0, 1]
 */
function computeKeywordOverlap(text: string, keywords: ReadonlyArray<string>): number {
  if (keywords.length === 0) return 0;
  if (text.length === 0) return 0;

  const normalized = text.toLowerCase();
  const englishWords = normalized.match(/[a-z0-9+#.-]+/g) ?? [];
  const chineseChars = normalized.match(/[\u4e00-\u9fff]/g) ?? [];
  const tokenSet = new Set<string>();
  for (const w of englishWords) tokenSet.add(w);
  for (const c of chineseChars) tokenSet.add(c);

  let hitCount = 0;
  for (const kw of keywords) {
    const lowerKw = kw.toLowerCase();
    if (lowerKw.length === 0) continue;
    if (lowerKw.length > 1 && /[a-z0-9]/.test(lowerKw)) {
      // 英文/数字关键词：精确匹配 token
      if (tokenSet.has(lowerKw)) hitCount++;
    } else {
      // 中文关键词或单字符：子串包含匹配
      if (normalized.includes(lowerKw)) hitCount++;
    }
  }
  return hitCount / keywords.length;
}

/**
 * 计算两个向量的余弦相似度
 *
 * 公式：cosine = (a · b) / (||a|| * ||b||)
 *
 * 边界处理：
 * - 任一向量为空：返回 0
 * - 任一向量模长为 0：返回 0
 * - 向量长度不一致：返回 0（防御性处理）
 *
 * @param a 向量 A
 * @param b 向量 B
 * @returns 余弦相似度 [-1, 1]，语义相似度场景通常 [0, 1]
 */
function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dotProduct += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================================================
// 4. TFIDF 向量化（embedder 降级第一级）
// ============================================================================

/**
 * TFIDF 词频-逆文档频率向量化
 *
 * 算法：
 * - IDF(t) = log(N / (1 + df(t)))
 *   - N：文档总数（5 角色文档 + 1 任务文本 = 6）
 *   - df(t)：包含词 t 的文档数
 * - TF(t, d) = 词 t 在文档 d 中出现次数
 * - TFIDF(t, d) = TF(t, d) * IDF(t)
 *
 * 由于 5 角色"文档"是静态的，IDF 可预计算；
 * 任务文本作为第 6 篇文档参与 IDF 计算。
 *
 * 实现策略（避免预计算 5 角色 IDF，保证公平）：
 * - 6 篇文档（5 角色 + 1 任务）共同计算 IDF
 * - 对每篇文档计算 TFIDF 向量
 * - 计算任务文本与每个角色文档的余弦相似度
 *
 * @param taskText 任务文本
 * @returns 5 角色 → TFIDF 相似度得分 的映射
 */
function computeTFIDFSimilarity(taskText: string): Readonly<Record<RoleKind, number>> {
  // ---------- 1. 构建 6 篇文档（5 角色 + 1 任务） ----------
  const roleDocs: ReadonlyArray<[RoleKind, ReadonlyArray<string>]> = ROLE_KINDS.map((role) => [
    role,
    tokenize(ROLE_DESCRIPTIONS[role]),
  ]);
  const taskTokens = tokenize(taskText);

  // ---------- 2. 计算 IDF ----------
  // N = 6（5 角色 + 1 任务）
  const N = roleDocs.length + 1;
  // df(t)：词 t 在多少篇文档中出现
  const dfMap = new Map<string, number>();
  const allTokens = new Set<string>();
  for (const [, tokens] of roleDocs) {
    const seen = new Set<string>();
    for (const t of tokens) {
      allTokens.add(t);
      if (!seen.has(t)) {
        seen.add(t);
        dfMap.set(t, (dfMap.get(t) ?? 0) + 1);
      }
    }
  }
  // 任务文档的 df 贡献
  const taskSeen = new Set<string>();
  for (const t of taskTokens) {
    allTokens.add(t);
    if (!taskSeen.has(t)) {
      taskSeen.add(t);
      dfMap.set(t, (dfMap.get(t) ?? 0) + 1);
    }
  }

  // ---------- 3. 构建 token → index 映射（保证向量维度一致） ----------
  const tokenList = Array.from(allTokens).sort();
  const tokenIndex = new Map<string, number>();
  for (let i = 0; i < tokenList.length; i++) {
    tokenIndex.set(tokenList[i] as string, i);
  }

  // ---------- 4. 计算任务文本的 TFIDF 向量 ----------
  const taskVector = new Array<number>(tokenList.length).fill(0);
  const taskTfMap = new Map<string, number>();
  for (const t of taskTokens) {
    taskTfMap.set(t, (taskTfMap.get(t) ?? 0) + 1);
  }
  for (const [token, tf] of taskTfMap) {
    const idx = tokenIndex.get(token);
    if (idx === undefined) continue;
    const df = dfMap.get(token) ?? 1;
    const idf = Math.log(N / (1 + df));
    taskVector[idx] = tf * idf;
  }

  // ---------- 5. 计算每个角色文档的 TFIDF 向量，并计算余弦相似度 ----------
  const result = {} as Record<RoleKind, number>;
  for (const [role, tokens] of roleDocs) {
    const roleVector = new Array<number>(tokenList.length).fill(0);
    const roleTfMap = new Map<string, number>();
    for (const t of tokens) {
      roleTfMap.set(t, (roleTfMap.get(t) ?? 0) + 1);
    }
    for (const [token, tf] of roleTfMap) {
      const idx = tokenIndex.get(token);
      if (idx === undefined) continue;
      const df = dfMap.get(token) ?? 1;
      const idf = Math.log(N / (1 + df));
      roleVector[idx] = tf * idf;
    }
    result[role] = cosineSimilarity(taskVector, roleVector);
  }

  return Object.freeze(result);
}

// ============================================================================
// 5. Hashing 向量化（embedder 降级第二级）
// ============================================================================

/**
 * FNV-1a 哈希函数（32 位）
 *
 * 选型依据：
 * - FNV-1a 简单快速，分布均匀，适合 hash 向量化
 * - 32 位足够映射到 4096 维向量（mod 4096）
 *
 * @param str 输入字符串
 * @returns 32 位无符号整数
 */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis (2166136261)
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // FNV prime (16777619)
    hash = Math.imul(hash, 0x01000193);
  }
  // 转为无符号 32 位
  return hash >>> 0;
}

/**
 * Hashing 向量化（基于 token hash 的词袋模型）
 *
 * 算法：
 * - 对每个 token 计算 FNV-1a 哈希
 * - hash mod dimension 得到向量索引
 * - 索引位置 +1（词频累加）
 * - L2 归一化
 *
 * 与 TFIDF 区别：
 * - 无 IDF 加权（不知道全局词频）
 * - 维度固定（4096），不随词表增长
 * - 速度更快，内存占用固定
 *
 * 适用场景：
 * - TFIDF 计算量大时（词表 > 10K）
 * - 实时性要求高的场景
 *
 * @param tokens token 数组
 * @param dimension 向量维度（默认 4096）
 * @returns L2 归一化后的 hash 向量
 */
function computeHashingVector(
  tokens: ReadonlyArray<string>,
  dimension: number = HASHING_DIMENSION
): ReadonlyArray<number> {
  const vector = new Array<number>(dimension).fill(0);
  for (const token of tokens) {
    const hash = fnv1aHash(token);
    const idx = hash % dimension;
    vector[idx] = vector[idx]! + 1;
  }
  // L2 归一化
  let norm = 0;
  for (const v of vector) {
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimension; i++) {
      vector[i] = (vector[i] ?? 0) / norm;
    }
  }
  return Object.freeze(vector);
}

/**
 * 计算 Hashing 相似度
 *
 * 算法：
 * - 计算任务文本与每个角色文档的 hash 向量
 * - 计算余弦相似度
 *
 * @param taskText 任务文本
 * @returns 5 角色 → Hashing 相似度得分 的映射
 */
function computeHashingSimilarity(taskText: string): Readonly<Record<RoleKind, number>> {
  const taskTokens = tokenize(taskText);
  const taskVector = computeHashingVector(taskTokens);

  const result = {} as Record<RoleKind, number>;
  for (const role of ROLE_KINDS) {
    const roleTokens = tokenize(ROLE_DESCRIPTIONS[role]);
    const roleVector = computeHashingVector(roleTokens);
    result[role] = cosineSimilarity(taskVector, roleVector);
  }
  return Object.freeze(result);
}

// ============================================================================
// 6. Embedding 向量匹配（embedder 首选，使用 SymbolRecord.embedding）
// ============================================================================

/**
 * 计算 embedding 平均向量
 *
 * 算法：对所有 SymbolRecord.embedding 取平均（按维度求均值）
 *
 * 用途：任务上下文中可能包含多个 SymbolRecord，每个有 embedding 向量。
 * 取平均向量代表"任务涉及的代码符号的语义中心"。
 *
 * 边界处理：
 * - symbols 为空：返回空数组
 * - 所有 symbols 都无 embedding：返回空数组
 * - embedding 长度不一致：跳过该 symbol
 *
 * @param symbols SymbolRecord 列表
 * @returns 平均向量（如所有 symbol 都无 embedding，返回空数组）
 */
function computeAverageEmbedding(symbols: ReadonlyArray<SymbolRecord>): ReadonlyArray<number> {
  if (symbols.length === 0) return [];
  // 收集所有有效 embedding（长度一致）
  let refLength = 0;
  const validEmbeddings: ReadonlyArray<number>[] = [];
  for (const sym of symbols) {
    if (sym.embedding === undefined) continue;
    if (sym.embedding.length === 0) continue;
    if (refLength === 0) {
      refLength = sym.embedding.length;
      validEmbeddings.push(sym.embedding);
    } else if (sym.embedding.length === refLength) {
      validEmbeddings.push(sym.embedding);
    }
    // 长度不一致的 embedding 跳过
  }
  if (validEmbeddings.length === 0 || refLength === 0) return [];

  // 按维度求均值
  const avgVector = new Array<number>(refLength).fill(0);
  for (const emb of validEmbeddings) {
    for (let i = 0; i < refLength; i++) {
      avgVector[i] = avgVector[i]! + (emb[i] ?? 0);
    }
  }
  for (let i = 0; i < refLength; i++) {
    avgVector[i] = avgVector[i]! / validEmbeddings.length;
  }
  return Object.freeze(avgVector);
}

/**
 * 基于 SymbolRecord.embedding 计算语义相似度
 *
 * 算法：
 * - 优先使用 symbols 的 embedding：计算平均 embedding 向量作为"代码符号语义中心"
 * - 由于角色文档无 embedding（仅静态字符串），无法直接与 embedding 计算余弦相似度
 * - 降级策略：
 *   a. 若 symbols 有 embedding：将 symbols 的 summary 文本拼接到 taskText，
 *      增强 TFIDF 计算（让 symbol 的语义通过 summary 注入）
 *      此时 level="embedding"，表示"利用了 embedding 存在性信号 + summary 文本"
 *   b. 若 symbols 无 embedding：纯 TFIDF 计算，level="tfidf"
 *   c. 若 TFIDF 计算失败（罕见）：降级到 Hashing，level="hashing"
 *   d. 若 taskText 为空：level="none"
 *
 * computeAverageEmbedding 的实际用途：
 * - 计算平均 embedding 向量，用于检测 symbols 是否真正有有效 embedding
 * - 若平均向量非空，说明 symbols 的 embedding 可用，标记为 "embedding" 降级层级
 * - 同时，平均向量可用于后续扩展（如与角色文档的 hash 向量比较，作为辅助信号）
 *
 * @param taskText 任务文本
 * @param symbols SymbolRecord 列表（可能含 embedding）
 * @returns { level, similarity, avgEmbedding } 降级层级、相似度映射与平均 embedding 向量
 *   - level="embedding"：symbols 中有有效 embedding，且通过 summary 增强 TFIDF
 *   - level="tfidf"：symbols 中无 embedding，纯 TFIDF
 *   - level="hashing"：TFIDF 计算失败（罕见），降级到 Hashing
 *   - level="none"：taskText 为空，无法计算
 */
function computeSemanticSimilarity(
  taskText: string,
  symbols: ReadonlyArray<SymbolRecord> | undefined
): {
  readonly level: SemanticFallbackLevel;
  readonly similarity: Readonly<Record<RoleKind, number>>;
  readonly avgEmbedding: ReadonlyArray<number>;
} {
  // ---------- 边界处理：taskText 为空 ----------
  if (taskText.trim().length === 0) {
    return {
      level: "none",
      similarity: Object.freeze({
        architect: 0,
        product_manager: 0,
        solo_coder: 0,
        test_expert: 0,
        ui_designer: 0,
      }),
      avgEmbedding: Object.freeze([]),
    };
  }

  // ---------- 1. 计算 symbols 的平均 embedding 向量（用于检测有效 embedding） ----------
  const avgEmbedding = symbols !== undefined && symbols.length > 0 ? computeAverageEmbedding(symbols) : [];
  const hasEmbedding = avgEmbedding.length > 0;

  // ---------- 2. 构建增强后的 taskText（如有 embedding，将 symbol summary 拼入） ----------
  let enhancedTaskText = taskText;
  if (hasEmbedding && symbols !== undefined) {
    const summaries = symbols
      .filter((s) => s.embedding !== undefined && s.embedding.length > 0)
      .map((s) => s.summary)
      .filter((summary) => summary.length > 0);
    if (summaries.length > 0) {
      enhancedTaskText = `${taskText} ${summaries.join(" ")}`;
    }
  }

  // ---------- 3. 首选 TFIDF（比 Hashing 更准确，因为 IDF 加权） ----------
  try {
    const tfidfSim = computeTFIDFSimilarity(enhancedTaskText);
    return {
      level: hasEmbedding ? "embedding" : "tfidf",
      similarity: tfidfSim,
      avgEmbedding,
    };
  } catch {
    // TFIDF 计算失败（如词表过大），降级到 Hashing
    // 理论上不会发生，防御性处理
    const hashingSim = computeHashingSimilarity(enhancedTaskText);
    return {
      level: "hashing",
      similarity: hashingSim,
      avgEmbedding,
    };
  }
}

// ============================================================================
// 7. 任务类型推断
// ============================================================================

/**
 * 推断任务类型
 *
 * 算法：
 * - 对 6 种任务类型的关键词表分别计算重叠度
 * - 重叠度最高的任务类型即为推断结果
 * - 若所有任务类型重叠度都为 0，返回 null（无法推断）
 *
 * @param taskText 任务文本（title + description）
 * @returns 推断的任务类型，或 null（无法推断）
 */
export function inferTaskType(taskText: string): TaskType | null {
  if (taskText.trim().length === 0) return null;

  let bestType: TaskType | null = null;
  let bestScore = 0;
  for (const taskType of TASK_TYPES) {
    const keywords = TASK_TYPE_KEYWORDS[taskType];
    const score = computeKeywordOverlap(taskText, keywords);
    if (score > bestScore) {
      bestScore = score;
      bestType = taskType;
    }
  }
  // 若所有任务类型关键词重叠度都为 0，返回 null
  if (bestScore === 0) return null;
  return bestType;
}

// ============================================================================
// 8. 三路匹配器
// ============================================================================

/**
 * 关键词匹配器：对 5 角色计算关键词重叠度
 *
 * @param taskText 任务文本（title + description）
 * @returns 5 角色 → { score, hitKeywords } 的映射
 */
function matchByKeyword(
  taskText: string
): Readonly<Record<RoleKind, { readonly score: number; readonly hitKeywords: ReadonlyArray<string> }>> {
  const result = {} as Record<RoleKind, { readonly score: number; readonly hitKeywords: ReadonlyArray<string> }>;
  for (const role of ROLE_KINDS) {
    const keywords = ROLE_KEYWORDS[role];
    const score = computeKeywordOverlap(taskText, keywords);
    // 收集命中的关键词（用于可解释性）
    const normalized = taskText.toLowerCase();
    const englishWords = normalized.match(/[a-z0-9+#.-]+/g) ?? [];
    const chineseChars = normalized.match(/[\u4e00-\u9fff]/g) ?? [];
    const tokenSet = new Set<string>();
    for (const w of englishWords) tokenSet.add(w);
    for (const c of chineseChars) tokenSet.add(c);

    const hitKeywords: string[] = [];
    for (const kw of keywords) {
      const lowerKw = kw.toLowerCase();
      if (lowerKw.length === 0) continue;
      if (lowerKw.length > 1 && /[a-z0-9]/.test(lowerKw)) {
        if (tokenSet.has(lowerKw)) hitKeywords.push(kw);
      } else {
        if (normalized.includes(lowerKw)) hitKeywords.push(kw);
      }
    }
    result[role] = Object.freeze({
      score,
      hitKeywords: Object.freeze(hitKeywords),
    });
  }
  return Object.freeze(result);
}

/**
 * 语义匹配器：对 5 角色计算语义相似度
 *
 * @param taskText 任务文本
 * @param symbols 相关 SymbolRecord 列表（可选）
 * @returns { level, similarity, avgEmbedding } 降级层级、相似度映射与平均 embedding 向量
 */
function matchBySemantic(
  taskText: string,
  symbols: ReadonlyArray<SymbolRecord> | undefined
): {
  readonly level: SemanticFallbackLevel;
  readonly similarity: Readonly<Record<RoleKind, number>>;
  readonly avgEmbedding: ReadonlyArray<number>;
} {
  return computeSemanticSimilarity(taskText, symbols);
}

/**
 * 任务类型匹配器：推断任务类型并映射到主角色
 *
 * @param taskText 任务文本
 * @returns { taskType, role, score } 推断结果，或 null（无法推断）
 */
function matchByTaskType(taskText: string): {
  readonly taskType: TaskType;
  readonly role: RoleKind;
  readonly score: number;
} | null {
  const taskType = inferTaskType(taskText);
  if (taskType === null) return null;
  const role = TASK_TYPE_TO_ROLE[taskType];
  const keywords = TASK_TYPE_KEYWORDS[taskType];
  const score = computeKeywordOverlap(taskText, keywords);
  return Object.freeze({ taskType, role, score });
}

// ============================================================================
// 9. 主类 RoleSignalDetector
// ============================================================================

/**
 * 角色信号探测器
 *
 * 主入口：detect(context) → RoleSignal[]
 *
 * 工作流程：
 * 1. 拼接 taskText = title + " " + description
 * 2. 三路独立检测：
 *    a. 关键词匹配：5 角色的关键词重叠度
 *    b. 语义匹配：TFIDF（首选）/ Hashing（降级）
 *    c. 任务类型推断：6 任务类型 → 主角色
 * 3. 按 role 聚合三路得分，加权综合置信度
 * 4. 按综合置信度降序排序
 * 5. 过滤置信度 < minConfidenceThreshold 的信号
 * 6. 返回 RoleSignal[]（已冻结）
 *
 * 不可变优先：
 * - options 在构造时 Object.freeze
 * - 输出 RoleSignal[] 已 Object.freeze
 */
export class RoleSignalDetector {
  /** 检测选项（已冻结） */
  private readonly options: Readonly<RoleSignalDetectorOptions>;

  /**
   * 构造函数
   *
   * @param options 检测选项（可选，默认使用 DEFAULT_DETECTOR_OPTIONS）
   */
  constructor(options?: Partial<RoleSignalDetectorOptions>) {
    this.options = Object.freeze({
      ...DEFAULT_DETECTOR_OPTIONS,
      ...options,
    });
  }

  /**
   * 检测角色信号
   *
   * @param context 任务上下文
   * @returns RoleSignal[]，按综合置信度降序排序，已冻结
   */
  detect(context: TaskContext): ReadonlyArray<RoleSignal> {
    // ---------- 1. 拼接 taskText ----------
    const taskText = `${context.title} ${context.description}`;

    // ---------- 2. 三路独立检测 ----------
    const keywordResult = matchByKeyword(taskText);
    const semanticResult = matchBySemantic(taskText, context.symbols);
    const taskTypeResult = matchByTaskType(taskText);

    // ---------- 3. 按 role 聚合三路得分 ----------
    const signals: RoleSignal[] = [];
    for (const role of ROLE_KINDS) {
      const keywordScore = keywordResult[role].score;
      const semanticScore = semanticResult.similarity[role];
      // 任务类型得分：若该角色是推断出的主角色，则得分为 task_type 关键词重叠度；否则为 0
      let taskTypeScore = 0;
      let taskTypeReason: string | null = null;
      if (taskTypeResult !== null && taskTypeResult.role === role) {
        taskTypeScore = taskTypeResult.score;
        taskTypeReason = `任务类型推断为 "${taskTypeResult.taskType}"，主角色为 ${role}`;
      }

      // ---------- 综合置信度加权 ----------
      const confidence =
        this.options.keywordWeight * keywordScore +
        this.options.semanticWeight * semanticScore +
        this.options.taskTypeWeight * taskTypeScore;

      // ---------- 过滤低置信度信号 ----------
      if (confidence < this.options.minConfidenceThreshold) {
        continue;
      }

      // ---------- 构建原因列表 ----------
      const reasons: string[] = [];
      const hitKeywords = keywordResult[role].hitKeywords;
      if (hitKeywords.length > 0) {
        reasons.push(`关键词命中：${hitKeywords.join("、")}（重叠度 ${keywordScore.toFixed(3)}）`);
      }
      if (semanticScore >= this.options.semanticHitThreshold) {
        reasons.push(`语义相似度 ${semanticScore.toFixed(3)}（${semanticResult.level} 降级层级）`);
      }
      if (taskTypeReason !== null) {
        reasons.push(taskTypeReason);
      }

      // 若 reasons 为空，说明三路都未命中，跳过该角色
      if (reasons.length === 0) {
        continue;
      }

      signals.push(
        Object.freeze({
          role,
          confidence,
          source: this.determinePrimarySource(keywordScore, semanticScore, taskTypeScore),
          reasons: Object.freeze(reasons),
        })
      );
    }

    // ---------- 4. 按综合置信度降序排序 ----------
    signals.sort((a, b) => b.confidence - a.confidence);

    // ---------- 5. 返回已冻结的 RoleSignal[] ----------
    return Object.freeze(signals);
  }

  /**
   * 根据三路得分确定信号的主要来源
   *
   * 规则：取三路中得分最高的作为主要来源
   * - 若 keyword 得分最高 → "keyword"
   * - 若 semantic 得分最高 → "semantic"
   * - 若 task_type 得分最高 → "task_type"
   * - 若三者都为 0 → "keyword"（默认，不会到达，因为已过滤）
   *
   * @param keywordScore 关键词得分
   * @param semanticScore 语义得分
   * @param taskTypeScore 任务类型得分
   * @returns 主要信号来源
   */
  private determinePrimarySource(keywordScore: number, semanticScore: number, taskTypeScore: number): RoleSignalSource {
    if (keywordScore >= semanticScore && keywordScore >= taskTypeScore) {
      return "keyword";
    }
    if (semanticScore >= keywordScore && semanticScore >= taskTypeScore) {
      return "semantic";
    }
    return "task_type";
  }

  /**
   * 获取当前使用的语义匹配降级层级（用于调试/测试）
   *
   * @param context 任务上下文
   * @returns 语义匹配降级层级
   */
  getSemanticFallbackLevel(context: TaskContext): SemanticFallbackLevel {
    const taskText = `${context.title} ${context.description}`;
    const result = matchBySemantic(taskText, context.symbols);
    return result.level;
  }

  /**
   * 获取检测选项（已冻结，不可变）
   *
   * @returns 检测选项的只读副本
   */
  getOptions(): Readonly<RoleSignalDetectorOptions> {
    return this.options;
  }
}

// ============================================================================
// 10. 顶层便捷函数
// ============================================================================

/**
 * 顶层便捷函数：检测角色信号
 *
 * 使用默认选项创建 RoleSignalDetector 实例并执行 detect()。
 *
 * @param context 任务上下文
 * @returns RoleSignal[]，按综合置信度降序排序
 */
export function detectRoleSignals(context: TaskContext): ReadonlyArray<RoleSignal> {
  const detector = new RoleSignalDetector();
  return detector.detect(context);
}
