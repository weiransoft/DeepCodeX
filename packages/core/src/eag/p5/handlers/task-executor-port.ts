/**
 * EAG-P5 任务执行器端口（P5TaskExecutor）
 *
 * 背景（EAG-P5 自主循环 LLM 执行链路补全 · 方案 A §3.1）：
 * - 修复前 dev/fix 阶段只做文件盘点/生成结构化建议即返回 success，
 *   4 阶段零 LLM 调用，orchestrator 空转一轮就误报 completed。
 * - 本端口定义"把一张任务卡真实做完"的能力协议，由 core 层的
 *   LlmTaskExecutor（精简 LLM↔工具循环）实现，SessionManager 在构造期
 *   通过 AutonomousOrchestrator.bindTaskExecutor() 注入。
 *
 * 设计约束（架构师审查 P0-6）：
 * - 端口只表达输入/输出，不绑定 SessionManager / ToolExecutor / Provider 具体类型，
 *   保证 StageHandler 仅依赖协议，测试中可用测试替身聚焦状态机断言。
 * - 所有字段 readonly + ReadonlyArray，遵循 P5 不可变约定（G-A6d）。
 * - 生产实现禁止任何占位/mock 行为；无 LLM 凭据必须 fail-closed 返回 success=false。
 *
 * @module eag/p5/handlers/task-executor-port
 */

/**
 * 单次任务执行输入（不可变）
 *
 * 由 dev/fix StageHandler 从 P5StageContext + TaskCard 装配，
 * 描述"在哪个项目、哪次运行、第几轮、以什么阶段语义执行哪张卡"。
 */
export interface P5TaskExecutionInput {
  /** 项目根目录绝对路径（执行器的路径牢笼边界，越界写一律拒绝） */
  readonly projectRoot: string;
  /** P5 run-id（12 位 UUID 前缀），用于派生工具执行的合成 sessionId（不落 sessions-index） */
  readonly runId: string;
  /** 当前迭代号（0-based），与合成 sessionId 一起保证多轮执行互不串扰 */
  readonly iterIndex: number;
  /**
   * 执行阶段语义：
   * - dev：首次按任务卡实现
   * - fix：带着 verify 失败反馈再次执行
   */
  readonly stage: "dev" | "fix";
  /** 用户原始目标（objective），为执行器提供任务背景 */
  readonly objective: string;
  /** 任务卡 ID（如 T-001） */
  readonly taskId: string;
  /** 任务卡标题 */
  readonly taskTitle: string;
  /** 任务卡验收标准（可能为空数组：合成卡未填写时为空） */
  readonly acceptanceCriteria: ReadonlyArray<string>;
  /**
   * fix 阶段必填的失败反馈（失败分类 + exitCode + 输出片段 + 结构化建议）；
   * dev 阶段为 undefined。
   */
  readonly feedback?: string;
  /**
   * abort 标志文件绝对路径（与 orchestrator 同一文件）。
   * 执行器每轮工具循环开始前轮询，文件存在即中止并返回 success=false。
   */
  readonly abortFlagPath: string;
}

/**
 * 单次任务执行结果（不可变）
 *
 * success=true 仅代表"LLM 工具循环正常到达终态且未触发中止/上限"，
 * 业务正确性由随后的 verify 阶段用真实测试命令裁定——执行器自身不宣告"测试通过"。
 */
export interface P5TaskExecutionResult {
  /** 是否执行成功（凭据缺失/abort/轮数上限/异常均为 false） */
  readonly success: boolean;
  /** 终态文本摘要（模型最后一条无工具调用消息，截断 2000 字） */
  readonly summary: string;
  /**
   * 本任务真实 token 用量（各次 LLM 请求 usage 输入+输出累计）。
   * 部分网关不回 usage：按字符数估算保底 ≥1，此时 tokensEstimated=true。
   */
  readonly tokensUsed: number;
  /** tokensUsed 是否为估算值（网关未回 usage 时为 true） */
  readonly tokensEstimated: boolean;
  /** 真实发起 LLM 请求的次数（与 token 计数解耦，作为 llmCallCount 凭证） */
  readonly llmRequests: number;
  /**
   * git status --porcelain 检出的真实变更文件（相对路径）；
   * 非 git 仓库或无变更时为空数组。
   */
  readonly changedFiles: ReadonlyArray<string>;
  /** success=false 时的错误原因（aborted / 凭据缺失 / 异常消息等） */
  readonly error?: string;
}

/**
 * 任务执行器端口
 *
 * dev/fix StageHandler 只依赖此接口：
 * - 已绑定：调用 executeTask() 把任务卡真实做完；
 * - 未绑定（undefined/null）：fail-closed 返回阶段 failed，绝不空转成功。
 */
export interface P5TaskExecutor {
  /**
   * 执行单张任务卡
   *
   * @param input 执行输入（readonly）
   * @returns 执行结果（Promise，语义上不可变）
   */
  executeTask(input: Readonly<P5TaskExecutionInput>): Promise<Readonly<P5TaskExecutionResult>>;
}
