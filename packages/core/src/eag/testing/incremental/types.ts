/**
 * 增量测试选择器数据模型（EAG-P3 批次 11 §8.3）
 *
 * 本模块定义 EAG 方案 §5.10.5 棕地增量测试选择所需的全部结构化数据类型。
 * 增量测试选择器基于"git diff → 爆炸半径 BFS → 风险评分 Top-N"算法，
 * 让系统像资深程序员一样精准定位"这次改动可能影响哪些测试，必须重跑"。
 *
 * 设计依据：
 * - EAG 方案 §5.10.5 TESTING Loop 时序（增量测试驱动 LoopGuard）
 * - EAG 方案 §5.11.6 V2-P4 CodeMap 符号级知识图谱（爆炸半径 BFS）
 * - EAG-P3 批次 11 设计 §8.1 B3 设计目标
 * - EAG-P3 批次 11 设计 §8.3 B3 核心类型设计
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层配置常量使用 Object.freeze 冻结，防止运行期被 LLM 自改
 *
 * @module eag/testing/incremental/types
 */

// ============================================================================
// 1. Git Diff 变更类型
// ============================================================================

/**
 * 变更类型（字面量联合类型，对齐 Git diff status）
 *
 * - added：新增文件（Git status A）
 * - modified：修改文件（Git status M）
 * - deleted：删除文件（Git status D）
 * - renamed：重命名文件（Git status R）
 *
 * 字面量联合而非 string，避免拼写错误。
 * 与 gate-types.ts 中的 FileChangeType 与 l2-types.ts 中的 GitDiffType 对齐，
 * 但此处独立定义以避免门禁/PKC 模块耦合 testing/incremental 模块。
 */
export type GitChangeType = "added" | "modified" | "deleted" | "renamed";

/**
 * GIT_CHANGE_TYPES 全部合法值（用于运行时枚举、测试断言与配置校验）
 *
 * 使用 Object.freeze 冻结。顺序对齐 Git status 字母顺序（A/M/D/R）。
 */
export const GIT_CHANGE_TYPES: ReadonlyArray<GitChangeType> = Object.freeze([
  "added",
  "modified",
  "deleted",
  "renamed",
]);

/**
 * 变更行数统计（单文件 diff 的新增/删除行数）
 *
 * 字段全部 readonly——统计数据一经 git diff 采集即不可变。
 *
 * 范例：
 *   {
 *     additions: 42,
 *     deletions: 18
 *   }
 */
export interface DiffStat {
  /** 新增行数（git diff --numstat 第一列） */
  readonly additions: number;
  /** 删除行数（git diff --numstat 第二列） */
  readonly deletions: number;
}

/**
 * 文件变更记录（单文件的 git diff 信息）
 *
 * 描述一个文件的 git diff 信息，由 GitDiffAnalyzer.analyze() 产出，
 * 作为 BlastRadiusBfs.bfs() 的 sourceFiles 输入。
 *
 * 字段全部 readonly——变更记录一经采集即不可变。
 *
 * 范例：
 *   {
 *     type: "modified",
 *     filePath: "src/services/PaymentService.ts",
 *     oldFilePath: undefined,
 *     diffStat: { additions: 42, deletions: 18 }
 *   }
 *
 *   {
 *     type: "renamed",
 *     filePath: "src/services/PaymentServiceV2.ts",
 *     oldFilePath: "src/services/PaymentService.ts",
 *     diffStat: { additions: 5, deletions: 3 }
 *   }
 */
export interface GitFileChange {
  /** 变更类型（added/modified/deleted/renamed） */
  readonly type: GitChangeType;
  /** 文件相对路径（相对 projectRoot，变更后路径） */
  readonly filePath: string;
  /** 旧文件路径（仅 renamed 时填写，相对 projectRoot） */
  readonly oldFilePath?: string;
  /** 变更行数统计 */
  readonly diffStat: Readonly<DiffStat>;
}

// ============================================================================
// 2. 爆炸半径 BFS 节点类型
// ============================================================================

/**
 * 爆炸半径 BFS 节点类型（字面量联合类型）
 *
 * - source：变更源文件（git diff 提取，BFS 起点）
 * - affected：受影响文件（BFS 遍历到的依赖项，非测试文件）
 * - test：测试文件（受影响文件对应的测试，BFS 终点）
 *
 * 字面量联合而非 string，避免拼写错误。
 *
 * 设计依据：§8.5 BlastRadiusBfs 算法
 */
export type BlastRadiusNodeType = "source" | "affected" | "test";

/**
 * BLAST_RADIUS_NODE_TYPES 全部合法值（用于运行时枚举与测试断言）
 *
 * 使用 Object.freeze 冻结。顺序对齐 BFS 节点流转顺序：source → affected → test。
 */
export const BLAST_RADIUS_NODE_TYPES: ReadonlyArray<BlastRadiusNodeType> = Object.freeze([
  "source",
  "affected",
  "test",
]);

/**
 * 爆炸半径节点（BFS 遍历的单个节点）
 *
 * 描述一个文件在爆炸半径 BFS 中的位置信息：
 * - type：节点类型（source/affected/test）
 * - filePath：文件路径
 * - depth：距离源节点的跳数（0=源，1=直接依赖，2=间接依赖...）
 * - parentPaths：父节点路径列表（BFS 路径回溯，便于风险评分定位影响链）
 *
 * 字段全部 readonly——节点一经构建即不可变。
 *
 * 范例：
 *   {
 *     type: "test",
 *     filePath: "tests/contract/payment.contract.test.ts",
 *     depth: 2,
 *     parentPaths: ["src/services/PaymentService.ts", "src/controllers/PaymentController.ts"]
 *   }
 */
export interface BlastRadiusNode {
  /** 节点类型（source/affected/test） */
  readonly type: BlastRadiusNodeType;
  /** 文件路径（相对 projectRoot） */
  readonly filePath: string;
  /** 距离源节点的跳数（0=源，1=直接依赖，2=间接依赖...，上限 5） */
  readonly depth: number;
  /** 父节点路径列表（BFS 路径回溯，受影响文件的依赖链） */
  readonly parentPaths: ReadonlyArray<string>;
}

// ============================================================================
// 3. 风险评分维度
// ============================================================================

/**
 * 风险评分维度（字面量联合类型）
 *
 * - direct：直接修改（git diff 中的文件，depth=0 的 source 节点）
 * - indirect：间接影响（BFS 受影响文件，depth>0 的 affected 节点）
 * - high-risk-symbol：高风险符号（PKC L2 标记的 critical 符号，影响链中含高风险符号）
 * - domain-layer：领域层代码（src/domain/ 下的文件，业务核心）
 * - depth-decay：距离衰减（每跳 -0.1，最低 0.1）—— 架构师审查 B3-M9 修复：
 *   depth 衰减独立为单独维度，避免与 indirect 维度评分重复出现两个 dimension="indirect" 项
 *
 * 字面量联合而非 string，避免拼写错误。
 *
 * 设计依据：§8.6 RiskScorer 设计 + B3-M9 修复
 */
export type RiskScoreDimension = "direct" | "indirect" | "high-risk-symbol" | "domain-layer" | "depth-decay";

/**
 * RISK_SCORE_DIMENSIONS 全部合法值（用于运行时枚举与测试断言）
 *
 * 使用 Object.freeze 冻结。顺序对齐评分维度优先级：
 * direct → indirect → high-risk-symbol → domain-layer → depth-decay。
 */
export const RISK_SCORE_DIMENSIONS: ReadonlyArray<RiskScoreDimension> = Object.freeze([
  "direct",
  "indirect",
  "high-risk-symbol",
  "domain-layer",
  "depth-decay",
]);

/**
 * 风险评分（单维度评分）
 *
 * 描述测试文件在某个评分维度上的得分与判定理由：
 * - dimension：评分维度
 * - score：评分（0~1，可能为正分也可能为负分——depth-decay 为负分）
 * - reason：评分理由（人类可读，含触发条件与得分计算）
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     dimension: "direct",
 *     score: 1.0,
 *     reason: "测试文件直接被修改"
 *   }
 *
 *   {
 *     dimension: "depth-decay",
 *     score: -0.3,
 *     reason: "距离衰减 -0.30（depth=3）"
 *   }
 */
export interface RiskScore {
  /** 评分维度 */
  readonly dimension: RiskScoreDimension;
  /** 评分（direct=1.0 / indirect=0.5 / high-risk-symbol=+0.3 / domain-layer=+0.2 / depth-decay=-0.1*depth，最低 0.1） */
  readonly score: number;
  /** 评分理由（人类可读，含触发条件与得分计算） */
  readonly reason: string;
}

// ============================================================================
// 4. 选中的测试与选择结果
// ============================================================================

/**
 * 选中的测试（Top-N 选择的单个测试）
 *
 * 描述一个被增量测试选择器选中的测试文件：
 * - testPath：测试文件路径（相对 projectRoot）
 * - totalScore：总风险评分（0~1，所有维度评分之和，上限 1.0）
 * - scores：各维度评分明细（含 direct/indirect/high-risk-symbol/domain-layer/depth-decay）
 * - affectedFiles：受影响的源文件路径列表（BFS 路径回溯得到的依赖链）
 * - reason：选择理由（人类可读，含总评分与各维度评分摘要）
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     testPath: "tests/contract/payment.contract.test.ts",
 *     totalScore: 0.9,
 *     scores: [
 *       { dimension: "indirect", score: 0.5, reason: "受影响（距离 2 跳）" },
 *       { dimension: "high-risk-symbol", score: 0.3, reason: "受影响文件包含高风险符号" },
 *       { dimension: "depth-decay", score: -0.2, reason: "距离衰减 -0.20（depth=2）" }
 *     ],
 *     affectedFiles: ["src/services/PaymentService.ts", "src/controllers/PaymentController.ts"],
 *     reason: "总评分 0.90（indirect:0.5, high-risk-symbol:0.3, depth-decay:-0.2）"
 *   }
 */
export interface SelectedTest {
  /** 测试文件路径（相对 projectRoot） */
  readonly testPath: string;
  /** 总风险评分（0~1，所有维度加权，上限 1.0） */
  readonly totalScore: number;
  /** 各维度评分明细 */
  readonly scores: ReadonlyArray<RiskScore>;
  /** 受影响的源文件路径列表（BFS 路径回溯得到的依赖链） */
  readonly affectedFiles: ReadonlyArray<string>;
  /** 选择理由（人类可读，含总评分与各维度评分摘要） */
  readonly reason: string;
}

/**
 * 增量测试选择结果（IncrementalTestSelector.select 的产出）
 *
 * 描述一次增量测试选择的完整结果：
 * - selectedTests：选中的测试列表（按 totalScore 降序，取 Top-N）
 * - totalCandidates：候选测试总数（BFS 找到的所有受影响测试）
 * - selectionReason：选择理由（人类可读，含 Top-N 与候选总数）
 * - coverageEstimate：估算覆盖率（0~1，selectedTests / totalCandidates）
 * - topN：Top-N 参数
 *
 * 字段全部 readonly——选择结果一经生成即不可变。
 *
 * 范例：
 *   {
 *     selectedTests: [...],
 *     totalCandidates: 35,
 *     selectionReason: "Top-20 选择（共 35 个候选测试）",
 *     coverageEstimate: 0.571,
 *     topN: 20
 *   }
 */
export interface IncrementalTestSelection {
  /** 选中的测试列表（按 totalScore 降序，取 Top-N） */
  readonly selectedTests: ReadonlyArray<SelectedTest>;
  /** 候选测试总数（BFS 找到的所有受影响测试，未取 Top-N 前的总数） */
  readonly totalCandidates: number;
  /** 选择理由（人类可读，含 Top-N 与候选总数） */
  readonly selectionReason: string;
  /** 估算覆盖率（0~1，selectedTests / totalCandidates，totalCandidates=0 时为 0） */
  readonly coverageEstimate: number;
  /** Top-N 参数（默认 20） */
  readonly topN: number;
}

// ============================================================================
// 5. 默认配置常量
// ============================================================================

/**
 * 默认 BFS 最大深度
 *
 * 对应 EAG 方案 §5.11.6 爆炸半径 BFS 设计——最大深度 5，避免无限遍历。
 * 深度过大会导致受影响测试过多（爆炸半径过大），失去增量测试的价值；
 * 深度过小会遗漏间接依赖的测试，导致回归漏测。
 *
 * 使用 `as const` 字面量断言（数字本身已是不可变原始值，无需 Object.freeze）。
 */
export const DEFAULT_MAX_BFS_DEPTH = 5 as const;

/**
 * 默认 Top-N 选择数
 *
 * 对应 EAG 方案 §5.10.5 增量测试 Top-N 设计——默认选择 Top-20 个测试。
 * 20 是企业项目实践中"单次增量测试的合理上限"，平衡测试覆盖与执行耗时。
 *
 * 使用 `as const` 字面量断言。
 */
export const DEFAULT_TOP_N = 20 as const;

/**
 * 测试文件路径正则（匹配 tests/ 目录下以 .test.ts 结尾的文件）
 *
 * 对应 EAG 方案 §5.10.5 测试文件识别规则——测试文件位于 tests/ 目录下，
 * 文件名以 .test.ts 结尾（与项目 tests/ 目录下的测试文件命名一致）。
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
export const TEST_FILE_PATTERN: RegExp = Object.freeze(/tests\/.*\.test\.ts$/);

/**
 * 领域层路径前缀（src/domain/）
 *
 * 对应 EAG 方案 §5.1 EAK 范式 DDD 分层架构——领域层是业务核心，
 * 修改领域层代码的风险高于修改 interfaces/infrastructure 层。
 *
 * 使用 Object.freeze 冻结。
 */
export const DOMAIN_LAYER_PREFIX: string = Object.freeze("src/domain/") as string;
