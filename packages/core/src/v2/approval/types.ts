/**
 * Approval 模块类型定义
 *
 * 定义审批模式、应用模式、决策结果、风险等级等核心类型。
 * 这些类型是 V2 审批门控（ApprovalGate）的基础数据契约，
 * 用于在工具执行前做出"自动批准 / 询问用户 / 拒绝"的三态决策。
 *
 * 设计依据：
 * - V2.1 技术方案 §4.2 审批门控
 * - V2.1 评审修复 F-07：黑名单检查必须先于 ApprovalMode 判断（安全关键）
 * - V2.3 修复计划 P1-03：黑名单/白名单数据单一事实源
 */

/**
 * 审批模式：用户对工具执行的事前审批策略
 *
 * - "suggest"：建议模式，根据工具类型和风险等级细分决策（默认模式）
 * - "auto"：自动模式，非黑名单命令自动批准（仍创建快照保障可回滚）
 * - "never"：从不模式，仅允许只读工具自动执行，写操作一律拒绝
 */
export type ApprovalMode = "suggest" | "auto" | "never";

/**
 * 应用模式：整体会话的执行模式，决定工具执行的范围限制
 *
 * - "plan"：计划模式，禁止一切非只读操作（即使 ApprovalMode 为 auto 也拒绝写操作）
 * - "agent"：智能体模式，按 ApprovalMode 决策执行
 * - "yolo"：YOLO 模式，最高自由度，但仍受黑名单约束（F-07 安全修复保证）
 */
export type AppMode = "plan" | "agent" | "yolo";

/**
 * 审批决策结果：ApprovalGate.evaluate 的最终输出
 *
 * - "auto_approve"：自动批准，可直接执行（auto 模式下会创建快照）
 * - "ask_user"：需询问用户，等待用户确认后执行
 * - "deny"：拒绝执行，不可覆盖（黑名单或高风险命令）
 */
export type ApprovalDecision = "auto_approve" | "ask_user" | "deny";

/**
 * 风险等级：命令/操作的危险程度分类
 *
 * - "benign"：良性（评分 0-30），可自动批准
 * - "caution"：需谨慎（评分 31-90），需询问用户
 * - "destructive"：破坏性（评分 91-100），拒绝执行
 *
 * 注：评分区间 71-90 为"高风险谨慎"，仍归入 caution 等级（需询问），
 *     仅 91 及以上才判定为 destructive（拒绝）。
 */
export type RiskLevel = "benign" | "caution" | "destructive";

/**
 * 工具类型分类：用于 ApprovalGate 决策时区分工具行为特征
 *
 * - "readonly"：只读工具（read、ls、cat 等），无副作用
 * - "bash"：Shell 命令工具，需进行命令安全检查
 * - "file_write"：文件写入工具（新建文件）
 * - "file_edit"：文件编辑工具（修改已有文件）
 * - "network"：网络访问工具（web_search 等）
 * - "mcp"：MCP 协议工具（外部扩展）
 */
export type ToolCategory = "readonly" | "bash" | "file_write" | "file_edit" | "network" | "mcp";

/**
 * 风险评估结果：CommandSafety.assessRisk 的输出
 *
 * 包含数值评分、等级分类和人类可读的评估原因（中文），
 * 用于 ApprovalGate 决策和向用户展示风险评估依据。
 */
export interface RiskAssessment {
  /** 风险评分（0-100），越高越危险 */
  score: number;
  /** 风险等级：benign / caution / destructive */
  level: RiskLevel;
  /** 评估原因（中文，用于决策日志和用户提示） */
  reason: string;
}

/**
 * 审批上下文：调用 ApprovalGate.decide 时传入的完整决策依据
 *
 * 封装工具名称、类型、命令/文件路径、应用模式、审批模式等信息，
 * 使 ApprovalGate 的决策逻辑无外部依赖，便于单元测试。
 *
 * v2.4 修订（P0-02 修复）：补全 taskId 字段，供 side-git 快照关联与审计日志串联。
 * V2-P0a 阶段可选（缺省取 "default-task"），V2-P0b TaskContext 落地后必填。
 */
export interface ApprovalContext {
  /** 工具名称（如 "bash"、"edit"、"read"） */
  toolName: string;
  /** 工具类型分类，决定走哪条决策分支 */
  toolCategory: ToolCategory;
  /** bash 命令内容（仅 toolCategory === "bash" 时提供） */
  command?: string;
  /** 文件路径（仅 file_write / file_edit 工具时提供） */
  filePath?: string;
  /** 应用模式：plan / agent / yolo */
  appMode: AppMode;
  /** 审批模式：suggest / auto / never */
  approvalMode: ApprovalMode;
  /**
   * 关联任务 ID（v2.4 P0-02 补全：v2.3 P1-18 声明但 V2-P0a 未落地）
   *
   * 供 side-git 快照关联与审计日志串联，调用方在 ToolRouter.route() 中
   * 通过 ctx.taskId ?? "default-task" 传入 SideGitManager.createSnapshot。
   *
   * V2-P0a 阶段 ApprovalGate.decide 内部不依赖此字段（仅传递）；
   * V2-P0b TaskContext 落地后必填。
   */
  taskId?: string;
}

/**
 * 审批结果：ApprovalGate.decide 的返回值
 *
 * 包含最终决策、原因说明、风险评估（如有）和是否需要创建快照。
 * 调用方根据 decision 执行后续流程，snapshotRequired 为 true 时
 * 需在执行前创建 side-git 快照以支持回滚（V2 side-git 机制）。
 */
export interface ApprovalResult {
  /** 最终决策：auto_approve / ask_user / deny */
  decision: ApprovalDecision;
  /** 决策原因（中文，用于日志和用户提示） */
  reason: string;
  /** 风险评估结果（仅 bash 命令或文件写入时提供，只读工具为 undefined） */
  riskAssessment?: RiskAssessment;
  /** 是否需要创建快照（auto 模式下为 true，用于回滚保障） */
  snapshotRequired: boolean;
}

/**
 * V2 Approval 配置：运行时审批策略配置
 *
 * 支持启用/禁用 ApprovalGate、设置默认模式，
 * 以及追加自定义黑名单/白名单条目（与内置条目合并，单一事实源）。
 */
export interface ApprovalConfig {
  /** 是否启用 ApprovalGate（false 时所有工具直接执行，仅用于调试） */
  enabled: boolean;
  /** 默认审批模式（用户未显式指定时使用） */
  defaultApprovalMode: ApprovalMode;
  /** 默认应用模式（会话启动时使用） */
  defaultAppMode: AppMode;
  /** 自定义黑名单条目（追加到内置黑名单之后） */
  blacklist: string[];
  /** 自定义白名单条目（追加到内置白名单之后） */
  whitelist: string[];
}
