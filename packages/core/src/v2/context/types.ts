/**
 * TaskContext 类型定义（F-CTX-02）
 *
 * 定义任务上下文的核心数据模型，包括任务定义、任务状态、工作记忆、
 * 关注点、思考历史、中间结果、待办事项和技能上下文。
 *
 * V2-P0b 范围（§11.1）：仅 WorkingMemory + TaskState（精简版 TaskContext）。
 * GlobalContext、DualLayerContextManager、ContextSynchronizer 属于 V2-P1。
 * ExperienceStore（经验归档目标）属于 V2-P2，V2-P0b 通过可插拔回调预留接口。
 *
 * 设计依据：
 * - V2 技术方案 §5.1 数据模型（TaskContext / TaskDefinition / TaskState / WorkingMemory）
 * - V2 技术方案 §8.3 任务临时记忆（WorkingMemoryManager 接口）
 * - V2 PRD §US-CTX-002：TaskContext 任务上下文
 * - V2 测试方案 §2.9 MEM-08（任务隔离）/ MEM-09（归档）
 *
 * @module v2/context/types
 */

/**
 * 任务状态：任务生命周期的当前阶段
 *
 * 状态流转（单向，不可逆跃迁）：
 * pending → in_progress → completed（成功完成）
 *                     \→ failed（执行失败）
 *                     \→ cancelled（用户取消）
 *
 * pending 状态下仅允许创建操作（addFocusPoint 等），
 * 不允许更新进度；in_progress 状态下可执行所有操作；
 * completed/failed/cancelled 为终态，仅允许读取和归档。
 */
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

/**
 * 任务定义：描述任务的目标、约束和预期输出
 *
 * 由用户或上层调度器在任务创建时提供，整个任务生命周期内不可变。
 * 修改任务定义需创建新任务（保持审计可追溯性）。
 */
export interface TaskDefinition {
  /** 任务描述（用户原始输入或系统生成的任务摘要） */
  description: string;
  /** 任务目标列表（可衡量、可验证的预期成果） */
  goals: string[];
  /** 任务约束列表（技术限制、时间限制、资源限制等） */
  constraints: string[];
  /**
   * 任务类型（自由字符串，如 "bugfix" / "refactor" / "feature"）
   *
   * v2.3 P2-09：原 TaskType 联合类型无任何算法消费，按 YAGNI 放开为自由字符串。
   */
  taskType: string;
  /** 预期输出（交付物描述，如 "修复后的代码 + 测试用例"） */
  expectedOutput: string;
}

/**
 * 任务状态：任务执行的运行时状态
 *
 * 记录任务的当前阶段、进度百分比和时间戳，
 * 供 UI 展示任务进度和供 ContextSynchronizer（V2-P1）同步状态。
 */
export interface TaskState {
  /** 当前任务状态 */
  status: TaskStatus;
  /** 进度百分比（0-100，0=未开始，100=完成） */
  progress: number;
  /** 任务开始时间（ISO 8601 字符串，UTC） */
  startedAt: string;
  /** 任务完成时间（ISO 8601 字符串，UTC；未完成时为 undefined） */
  completedAt?: string;
  /** 当前阶段名称（如 "分析中" / "编码中" / "测试中"） */
  currentStage: string;
}

/**
 * 工作记忆：单个任务生命周期内的临时数据集合
 *
 * 参考 WoAgent WorkingMemory.java，存储任务执行过程中的动态上下文：
 * - focusPoints：当前关注的文件/函数/概念，用于上下文聚焦
 * - temporaryData：临时键值对，存放中间计算结果
 * - pendingItems：待办事项，跟踪任务内的子任务
 * - thoughtHistory：思考记录链，支持回溯推理过程
 * - intermediateResults：工具/Agent 产生的中间结果
 * - contextWindow：当前激活的文件/片段路径列表
 *
 * 任务间隔离：每个任务有独立的 WorkingMemory 实例，互不干扰（MEM-08 验收）。
 * 任务结束归档：任务完成后 WorkingMemory 摘要归档到 HistoricalExperience（MEM-09 验收，
 * V2-P0b 通过可插拔回调实现，V2-P1/P2 接入 ExperienceStore）。
 */
export interface WorkingMemory {
  /** 当前关注点列表（文件、函数、概念等，用于上下文聚焦） */
  focusPoints: FocusPoint[];
  /** 临时数据（键值对，存放中间计算结果、缓存等） */
  temporaryData: Record<string, unknown>;
  /** 待办事项列表 */
  pendingItems: PendingItem[];
  /** 思考历史记录（按时间顺序，支持回溯推理链） */
  thoughtHistory: ThoughtEntry[];
  /** 中间结果列表（工具/Agent 产生的阶段性成果） */
  intermediateResults: IntermediateResult[];
  /** 上下文窗口（当前激活的文件/片段路径列表，供滑动窗口管理器消费，V2-P1） */
  contextWindow: string[];
}

/**
 * 关注点：任务当前聚焦的文件、函数、概念或子任务
 *
 * type="file" 的关注点作为 V2-P1 RelevanceScorer 的距离计算源点集
 * （§14.1 交付物映射表 #2），用于滑动窗口的文件相关性评分。
 */
export interface FocusPoint {
  /** 关注点类型 */
  type: "file" | "function" | "concept" | "task";
  /** 引用标识（文件路径 / 函数名 / 概念 ID / 子任务 ID） */
  ref: string;
  /** 优先级（0-1，越高越重要，用于排序与过滤） */
  priority: number;
  /** 添加时间（ISO 8601 字符串，UTC） */
  addedAt: string;
}

/**
 * 思考历史条目：记录任务执行过程中的每一步思考
 *
 * 用于回溯推理链、调试 AI 决策、向用户展示"AI 为什么这么做"。
 */
export interface ThoughtEntry {
  /** 思考时间戳（ISO 8601 字符串，UTC） */
  timestamp: string;
  /** 思考内容（AI 的推理过程描述） */
  thought: string;
  /** 当前阶段名称（与 TaskState.currentStage 对应） */
  stage: string;
}

/**
 * 中间结果：工具或 Agent 在任务执行过程中产生的阶段性成果
 *
 * 与 ThoughtEntry 的区别：ThoughtEntry 记录"想什么"，
 * IntermediateResult 记录"得到了什么"（如搜索结果、分析结论等）。
 */
export interface IntermediateResult {
  /** 产生时间戳（ISO 8601 字符串，UTC） */
  timestamp: string;
  /** 结果内容（文本描述或结构化数据的 JSON 字符串） */
  result: string;
  /** 结果来源（工具名或 Agent 名，如 "grep"、"edit"、"code-analyzer"） */
  source: string;
}

/**
 * 待办事项：任务内的子任务跟踪
 *
 * 用于将复杂任务拆解为可管理的子项，支持状态流转和优先级排序。
 */
export interface PendingItem {
  /** 唯一标识（UUID v4 格式） */
  id: string;
  /** 待办描述 */
  description: string;
  /** 优先级（0-1，越高越紧急） */
  priority: number;
  /** 待办状态 */
  status: "pending" | "in_progress" | "done" | "cancelled";
  /** 创建时间（ISO 8601 字符串，UTC） */
  createdAt: string;
}

/**
 * 技能上下文：当前任务激活的技能列表和加载历史
 *
 * /命令技能机制实际消费 activeSkills，记录技能加载历史用于审计和去重。
 */
export interface SkillContext {
  /** 当前激活的技能列表（技能 ID 或名称） */
  activeSkills: string[];
  /** 技能加载历史记录 */
  loadedHistory: SkillLoadRecord[];
}

/**
 * 技能加载记录：记录技能的加载时间和版本
 */
export interface SkillLoadRecord {
  /** 技能 ID 或名称 */
  skillId: string;
  /** 加载时间（ISO 8601 字符串，UTC） */
  loadedAt: string;
  /** 技能版本 */
  version: string;
}

/**
 * 任务上下文：单任务生命周期的完整状态
 *
 * 参考 WoAgent TaskContext.java，是 TaskContextManager 管理的核心数据单元。
 * 包含任务定义（不可变）、任务状态（可变）、工作记忆（可变）、技能上下文和版本号。
 *
 * v2.3 P2-09 精简：移除了 TaskType 联合类型和 CollaborationContext
 * （单用户 CLI 无协作场景），与 §11.1 V2-P0b 精简范围一致。
 */
export interface TaskContext {
  /** 任务 ID（唯一标识，由调用方提供或自动生成） */
  taskId: string;
  /** 任务定义（创建时提供，生命周期内不可变） */
  taskDefinition: TaskDefinition;
  /** 任务状态（运行时可变，通过 TaskContextManager.updateState 更新） */
  taskState: TaskState;
  /** 工作记忆（运行时可变，通过 TaskContextManager 的 add* 方法操作） */
  workingMemory: WorkingMemory;
  /** 技能上下文（当前激活技能和加载历史） */
  skillContext: SkillContext;
  /** 版本号（乐观并发控制，每次修改 +1） */
  version: number;
}

/**
 * 任务归档摘要：任务完成后归档产生的总结数据
 *
 * V2-P0b 阶段由 TaskContextManager.archive() 生成，
 * 通过可插拔的 ArchiveCallback 传递给消费方。
 * V2-P1/P2 阶段由 ExperienceStore 消费，转换为 SuccessExperience / FailureExperience。
 *
 * 设计依据：V2 技术方案 §8.3 WorkingMemoryManager.archiveToExperience
 * 和 §5.2 DualLayerContextManager.archiveTaskToExperience。
 */
export interface TaskArchiveSummary {
  /** 被归档的任务 ID */
  taskId: string;
  /** 任务是否成功完成 */
  success: boolean;
  /** 任务定义摘要（描述 + 类型 + 目标） */
  taskDefinition: TaskDefinition;
  /** 思考历史摘要（全部 thought 条目） */
  thoughtHistory: ThoughtEntry[];
  /** 中间结果摘要（全部 intermediateResult 条目） */
  intermediateResults: IntermediateResult[];
  /** 关注点摘要（全部 focusPoint 条目） */
  focusPoints: FocusPoint[];
  /** 任务开始时间 */
  startedAt: string;
  /** 任务完成时间 */
  completedAt: string;
  /** 归档时间（ISO 8601 字符串，UTC） */
  archivedAt: string;
}

/**
 * 归档回调函数类型：任务归档时由 TaskContextManager 调用
 *
 * V2-P0b 阶段默认实现为日志记录（no-op 归档）；
 * V2-P1/P2 阶段由 ExperienceStore 提供真实归档实现。
 *
 * @param summary 任务归档摘要
 */
export type ArchiveCallback = (summary: TaskArchiveSummary) => void;
