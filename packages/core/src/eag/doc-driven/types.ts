/**
 * 文档驱动开发 Loop 数据模型（EAG-P1 批次 5）
 *
 * 本模块定义 EAG 方案 §5.10 文档驱动开发 Loop 所需的全部结构化数据类型。
 * 文档驱动开发 Loop 的职责是：将企业开发的过程管理（文档契约、任务分解、
 * 编码规范、git 流程）自动化纳入三 Loop 编排，使生成过程本身符合企业过程规范。
 *
 * 设计依据：
 * - EAG 方案 §5.10 文档驱动开发 Loop 细化编排
 * - §5.10.1 三文档契约（spec → plan → tasks）
 * - §5.10.2 任务分解规范（粒度/DAG/验收卡）
 * - §5.10.4 Git 过程管理自动化（分支模型/Commit 规范/快照与回滚/删除纪律）
 * - SEED-10 规则（需求文档先行 + 文件删除操作延迟到 Loop 收尾）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层配置常量使用 Object.freeze 冻结，防止运行期被 LLM 自改
 *
 * @module eag/doc-driven/types
 */

// ============================================================================
// 1. 文档契约类型与状态机
// ============================================================================

/**
 * 文档类型（4 类，字面量联合类型）
 *
 * 对齐 EAG 方案 §5.10.1 三文档契约 + 项目宪法：
 * - constitution：CONSTITUTION.md（项目宪法，DESIGN Loop 首轮产出）
 *   含项目愿景 + 技术/业务/质量原则 + 不可协商项
 * - spec：spec.md（功能需求规格，DESIGN Loop 产出）
 *   含功能需求编号体系（F-001…）+ 领域模型 + 技术选型决策表
 * - plan：plan.md（实现方案，CODING Loop 首轮产出）
 *   含模块切分/接口契约/数据迁移 + 风险与回退
 * - tasks：tasks.md（任务分解 DAG，CODING Loop 首轮产出）
 *   含任务 DAG 与拓扑序
 *
 * 字面量联合而非 string，可在编译期防止拼写错误。
 */
export type DocumentType = "constitution" | "spec" | "plan" | "tasks";

/**
 * DocumentType 全部合法值（用于运行时枚举、测试断言与配置校验）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。顺序对应文档生命周期：
 * constitution（首轮） → spec（DESIGN Loop） → plan（CODING Loop 首轮） → tasks（CODING Loop 首轮）。
 */
export const DOCUMENT_TYPES: ReadonlyArray<DocumentType> = Object.freeze(["constitution", "spec", "plan", "tasks"]);

/**
 * 文档状态（4 态，字面量联合类型）
 *
 * 对应 EAG 方案 §5.10.1 文档即门禁——文档状态机作为 Loop 流转条件。
 * - draft：草稿（初始状态）
 * - reviewing：评审中（提交评审后）
 * - approved：已批准（评审通过，作为下游 Loop 启动条件）
 * - rejected：已驳回（评审不通过，需修改后重新提交）
 *
 * 状态流转规则（由 DocumentStateMachine 实现）：
 *   draft → reviewing → approved（通过）
 *                      → rejected（驳回）
 *   rejected → reviewing（修改后重新提交）
 *   approved/rejected 为终态，不可回退到 draft
 */
export type DocumentState = "draft" | "reviewing" | "approved" | "rejected";

/**
 * DocumentState 全部合法值（用于运行时枚举、测试断言）
 *
 * 使用 Object.freeze 冻结。顺序对应状态机自然流转顺序。
 */
export const DOCUMENT_STATES: ReadonlyArray<DocumentState> = Object.freeze([
  "draft",
  "reviewing",
  "approved",
  "rejected",
]);

/**
 * 文档路径常量（对齐 §5.10.1 文档存放路径规范）
 *
 * 4 类文档统一存放在 docs/eag/ 目录下，文件名固定。
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改路径。
 *
 * 路径设计理由：
 * - 集中存放在 docs/eag/ 便于工具识别与版本控制
 * - 文件名大写表示宪法级文档（CONSTITUTION.md）
 * - 文件名小写表示常规文档（spec.md / plan.md / tasks.md）
 */
export const DOCUMENT_PATHS: Readonly<Record<DocumentType, string>> = Object.freeze({
  constitution: "docs/eag/CONSTITUTION.md",
  spec: "docs/eag/spec.md",
  plan: "docs/eag/plan.md",
  tasks: "docs/eag/tasks.md",
});

/**
 * EAG 文档（文档驱动开发 Loop 的核心数据结构）
 *
 * 描述一份文档的完整状态：类型/路径/状态/内容/版本/时间戳。
 * 字段全部 readonly——文档一旦发布即不可变，变更通过版本号递增表达。
 *
 * 范例：
 *   {
 *     type: "spec",
 *     path: "docs/eag/spec.md",
 *     state: "approved",
 *     content: "# 功能需求规格\n## F-001 用户登录...",
 *     version: 3,
 *     createdAt: "2026-07-18T10:00:00.000Z",
 *     updatedAt: "2026-07-18T15:30:00.000Z"
 *   }
 */
export interface EagDocument {
  /** 文档类型（4 类之一） */
  readonly type: DocumentType;
  /** 文档相对路径（如 "docs/eag/spec.md"） */
  readonly path: string;
  /** 文档状态（draft/reviewing/approved/rejected） */
  readonly state: DocumentState;
  /** 文档内容（Markdown 字符串） */
  readonly content: string;
  /** 版本号（从 1 开始，每次状态转换递增） */
  readonly version: number;
  /** 创建时间（ISO 8601 字符串，如 "2026-07-18T10:00:00.000Z"） */
  readonly createdAt: string;
  /** 最后更新时间（ISO 8601 字符串） */
  readonly updatedAt: string;
}

// ============================================================================
// 2. 功能需求与任务 DAG
// ============================================================================

/**
 * 需求优先级（3 级，字面量联合类型）
 *
 * 对齐 EAG 方案 §5.10.1 功能需求编号体系的优先级字段：
 * - high：高优先级（MVP 必备）
 * - medium：中优先级（MVP 后第一迭代）
 * - low：低优先级（远期迭代）
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type RequirementPriority = "high" | "medium" | "low";

/**
 * 功能需求（spec.md 的核心构件）
 *
 * 对应 EAG 方案 §5.10.1 功能需求编号体系（F-001…含优先级/所属模块/验收标准）。
 * 每条需求是任务分解的最小输入单元——TaskDecomposer 据此生成任务 DAG。
 *
 * 范例：
 *   {
 *     id: "F-001",
 *     title: "用户登录",
 *     priority: "high",
 *     module: "UserAggregate",
 *     acceptanceCriteria: [
 *       "Given 用户已注册，When 输入正确凭证，Then 返回 JWT token",
 *       "Given 用户未注册，When 输入任意凭证，Then 返回 401 错误"
 *     ]
 *   }
 */
export interface FunctionalRequirement {
  /** 需求 ID（如 "F-001"，遵循 F-NNN 三位数字编号规范） */
  readonly id: string;
  /** 需求标题（简洁描述需求，如 "用户登录"） */
  readonly title: string;
  /** 优先级（high/medium/low） */
  readonly priority: RequirementPriority;
  /** 所属模块/聚合格名（如 "UserAggregate"，对应任务分解的 fileCluster） */
  readonly module: string;
  /** 验收标准列表（Gherkin 风格或自然语言，每条可执行） */
  readonly acceptanceCriteria: ReadonlyArray<string>;
}

/**
 * 任务节点（任务 DAG 的节点，对齐 §5.10.2 任务分解规范）
 *
 * 任务粒度约束（§5.10.2）：
 * - 单任务 ≤ 1 个文件簇（聚合/模块）
 * - 任务卡含 [REQ-F-xxx] 需求溯源标记（requirementId 字段）
 *
 * 依赖关系约束（§5.10.2）：
 * - 任务间通过 dependencies 声明依赖（骨架 → 领域实现 → 应用服务 → API → 前端）
 * - Loop 按拓扑序执行，无依赖任务可扇出并行
 *
 * 验收卡约束（§5.10.2）：
 * - 每任务带可执行验收标准（acceptanceCommand，如 "npm test order"）
 * - 完成判定不由开发者角色自报，而由评估器执行验收卡
 *
 * 范例：
 *   {
 *     id: "T-001",
 *     title: "UserAggregate 骨架",
 *     requirementId: "F-001",
 *     dependencies: [],
 *     fileCluster: "UserAggregate",
 *     acceptanceCommand: "npm test user-aggregate"
 *   }
 */
export interface TaskNode {
  /** 任务 ID（如 "T-001"，遵循 T-NNN 三位数字编号规范） */
  readonly id: string;
  /** 任务标题（简洁描述任务，如 "UserAggregate 骨架"） */
  readonly title: string;
  /** 需求溯源 ID（如 "F-001"，对齐 [REQ-F-xxx] 标记规范） */
  readonly requirementId: string;
  /** 依赖任务 ID 列表（必须在本任务启动前完成） */
  readonly dependencies: ReadonlyArray<string>;
  /** 文件簇名（如 "OrderAggregate"，单任务 ≤ 1 文件簇约束） */
  readonly fileCluster: string;
  /** 验收命令（如 "npm test order"，由评估器执行判定完成） */
  readonly acceptanceCommand: string;
}

/**
 * 任务 DAG（有向无环图）
 *
 * 对应 EAG 方案 §5.10.2 任务分解 DAG——CODING Loop 首轮产出，
 * Loop 调度器按拓扑序执行任务，无依赖任务可扇出并行。
 *
 * 不变性约束（由 TaskDecomposer 保证）：
 * - nodes 中的每个 task.id 唯一
 * - nodes 中的每个 task.dependencies 引用的 ID 必须存在于 nodes
 * - 不存在循环依赖（DAG 性质）
 * - topologicalOrder 是 nodes.id 的有效拓扑序
 */
export interface TaskDag {
  /** 任务节点列表 */
  readonly nodes: ReadonlyArray<TaskNode>;
  /** 拓扑序任务 ID 列表（按依赖关系排序，无依赖任务在前） */
  readonly topologicalOrder: ReadonlyArray<string>;
}

// ============================================================================
// 3. Git 过程管理类型
// ============================================================================

/**
 * 语义化提交类型（对齐 Conventional Commits 规范）
 *
 * EAG 方案 §5.10.4 Git 过程管理自动化要求 Commit 规范：
 * 语义化提交（feat/fix/docs/chore/test/refactor），message 自动附需求溯源。
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type CommitType = "feat" | "fix" | "docs" | "chore" | "test" | "refactor";

/**
 * CommitType 全部合法值（用于运行时枚举与校验）
 *
 * 使用 Object.freeze 冻结。覆盖 Conventional Commits 规范的 6 类常用类型。
 */
export const COMMIT_TYPES: ReadonlyArray<CommitType> = Object.freeze([
  "feat",
  "fix",
  "docs",
  "chore",
  "test",
  "refactor",
]);

/**
 * Git 过程管理配置（对齐 §5.10.4 Git 过程管理自动化）
 *
 * 字段说明：
 * - branchPrefix：分支前缀（默认 "feature/eag-"，对齐 §5.10.4 分支模型）
 * - enableAutoPr：TESTING Loop 通过后自动生成 PR 描述（默认 true）
 * - snapshotPerTurn：是否启用 side-git turn 级快照（默认 true，§5.10.4 要求）
 *
 * 不可变保证：通过 createDefaultGitProcessConfig 工厂函数 Object.freeze 冻结。
 */
export interface GitProcessConfig {
  /** 分支前缀（默认 "feature/eag-"，对齐 §5.10.4 分支模型 feature/eag-<run-id>） */
  readonly branchPrefix: string;
  /** 是否在 TESTING Loop 通过后自动生成 PR 描述（默认 true） */
  readonly enableAutoPr: boolean;
  /** 是否启用 side-git turn 级快照（默认 true，§5.10.4 要求） */
  readonly snapshotPerTurn: boolean;
}

/**
 * 默认 Git 过程管理配置常量
 *
 * 数值依据：
 * - branchPrefix="feature/eag-"：§5.10.4 明确要求分支名格式 feature/eag-<run-id>
 * - enableAutoPr=true：§5.10.4 交付门禁要求 TESTING Loop 通过后自动生成 PR 描述
 * - snapshotPerTurn=true：§5.10.4 快照与回滚要求 side-git turn 级快照
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改。
 */
export const DEFAULT_GIT_PROCESS_CONFIG: Readonly<GitProcessConfig> = Object.freeze({
  branchPrefix: "feature/eag-",
  enableAutoPr: true,
  snapshotPerTurn: true,
});

/**
 * Git 过程管理配置校验错误
 *
 * 当 GitProcessConfig 的字段非法时抛出。
 */
export class GitProcessConfigError extends Error {
  /**
   * @param field 非法字段名
   * @param value 非法字段值
   * @param reason 非法原因
   */
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    public readonly reason: string
  ) {
    super(`GitProcessConfig 字段非法：${field}=${String(value)}，${reason}`);
    this.name = "GitProcessConfigError";
  }
}

/**
 * 创建默认 Git 过程管理配置（带字段校验 + 冻结）
 *
 * 工厂函数模式：调用方传入部分字段覆盖默认值，工厂函数完成校验并 Object.freeze 冻结。
 *
 * 校验规则：
 * - branchPrefix 必须为非空字符串
 * - enableAutoPr 必须为 boolean
 * - snapshotPerTurn 必须为 boolean
 *
 * @param overrides 覆盖字段（缺省字段使用 DEFAULT_GIT_PROCESS_CONFIG）
 * @returns 冻结后的配置对象
 * @throws {GitProcessConfigError} 任一字段非法时抛出
 */
export function createDefaultGitProcessConfig(overrides?: Partial<GitProcessConfig>): Readonly<GitProcessConfig> {
  // 合并默认值与覆盖值
  const merged: GitProcessConfig = {
    ...DEFAULT_GIT_PROCESS_CONFIG,
    ...overrides,
  };

  // 字段合法性校验
  if (typeof merged.branchPrefix !== "string" || merged.branchPrefix.trim().length === 0) {
    throw new GitProcessConfigError("branchPrefix", merged.branchPrefix, "必须为非空字符串");
  }
  if (typeof merged.enableAutoPr !== "boolean") {
    throw new GitProcessConfigError("enableAutoPr", merged.enableAutoPr, "必须为 boolean");
  }
  if (typeof merged.snapshotPerTurn !== "boolean") {
    throw new GitProcessConfigError("snapshotPerTurn", merged.snapshotPerTurn, "必须为 boolean");
  }

  return Object.freeze(merged);
}

// ============================================================================
// 4. CONSTITUTION.md 构建器输入
// ============================================================================

/**
 * 项目宪法（CONSTITUTION.md）构建器输入
 *
 * 对应 EAG 方案 §5.10.1 CONSTITUTION.md 内容：
 * - 项目愿景（vision）
 * - 技术/业务/质量原则（techPrinciples / businessPrinciples / qualityPrinciples）
 * - 不可协商项（nonNegotiableItems，含技术栈锁定清单、合规要求、红线声明）
 *
 * CONSTITUTION.md 在 DESIGN Loop 首轮产出，是 spec.md 的前置条件。
 * 不可协商项一旦写入宪法，未经用户显式批准不得变更（对齐 SEED-06 / SEED-10）。
 */
export interface ConstitutionInput {
  /** 项目愿景（一句话描述项目目标，如 "构建企业级订单管理系统"） */
  readonly vision: string;
  /** 技术原则列表（如 ["DDD 分层架构优先", "领域层零外部依赖"]） */
  readonly techPrinciples: ReadonlyArray<string>;
  /** 业务原则列表（如 ["业务规则内聚到领域层", "事务边界=聚合边界"]） */
  readonly businessPrinciples: ReadonlyArray<string>;
  /** 质量原则列表（如 ["单元测试覆盖率 >= 80%", "禁止 mock 真实逻辑"]） */
  readonly qualityPrinciples: ReadonlyArray<string>;
  /** 不可协商项（含技术栈锁定清单、合规要求、红线声明） */
  readonly nonNegotiableItems: Readonly<NonNegotiableItems>;
}

/**
 * 不可协商项（CONSTITUTION.md 章节 5，对齐 §5.10.1 不可协商项）
 *
 * 三类不可协商项一旦写入宪法即锁定，未经用户显式批准不得变更：
 * - techStackLocks：技术栈锁定清单（如 ["TypeScript", "NestJS", "PostgreSQL"]）
 * - complianceRequirements：合规要求（如 ["GDPR", "等保三级", "PCI-DSS"]）
 * - redlines：红线声明（如 ["禁止使用 mock 实现", "禁止简化逻辑"]）
 */
export interface NonNegotiableItems {
  /** 技术栈锁定清单（未经用户批准不得变更，对齐 SEED-06） */
  readonly techStackLocks: ReadonlyArray<string>;
  /** 合规要求清单（项目必须满足的合规标准） */
  readonly complianceRequirements: ReadonlyArray<string>;
  /** 红线声明清单（项目必须遵守的强制规则） */
  readonly redlines: ReadonlyArray<string>;
}

/**
 * 文档工作流校验结果（DocumentStateMachine.validateWorkflow 产出）
 *
 * 对应 EAG 方案 §5.10.1 文档即门禁——Loop 调度器将文档状态机作为流转条件。
 * spec.md 未批准时 CODING Loop 不得启动（SEED-10"需求文档先行"的流程落地）。
 *
 * 判定规则：
 * - constitution 必须为 approved（DESIGN Loop 前置条件）
 * - spec 必须为 approved（CODING Loop 前置条件，SEED-10）
 * - plan 与 tasks 在 CODING Loop 首轮产出，启动 CODING Loop 时不要求已批准
 *
 * 范例：
 *   {
 *     canStartCoding: false,
 *     missingApprovals: ["spec"],
 *     reason: "spec.md 未批准，CODING Loop 不得启动（SEED-10 需求文档先行）"
 *   }
 */
export interface WorkflowValidationResult {
  /** 是否可以启动 CODING Loop（true=所有门禁通过，false=有文档未批准） */
  readonly canStartCoding: boolean;
  /** 未批准的文档类型列表（如 ["spec"]，空数组表示全部已批准） */
  readonly missingApprovals: ReadonlyArray<DocumentType>;
  /** 判定理由（人类可读，包含具体哪类文档未批准） */
  readonly reason: string;
}
