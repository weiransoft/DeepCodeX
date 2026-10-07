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
 * bash 高危命令人工确认回调（用户决策 2026-10-03）。
 *
 * 背景：autonomous 任务开放 bash 真实执行（安装/容器/服务类任务），但命中
 * 破坏性模式的命令（rm -rf / sudo / shutdown / curl|sh 等）不得静默放行，
 * 必须交给宿主（CLI 审批提示 / Web 前端确认框）由人类批准或拒绝。
 *
 * 契约：
 * - 返回 true 表示用户批准执行该命令；false（含超时未决、宿主不可达）表示拒绝；
 * - 回调可长时间挂起等待人工响应（执行器端兜底超时默认 10 分钟，超时按拒绝处理）；
 * - 回调抛异常按拒绝处理（fail-closed，无人值守安全默认）。
 */
export type P5DangerousCommandApproval = (
  request: Readonly<{
    /** 待确认的原始命令文本 */
    readonly command: string;
    /** 命中的破坏性风险类别（如 "rm -rf 根目录"） */
    readonly risk: string;
    /** 所属任务卡 ID（供 UI 展示上下文） */
    readonly taskId: string;
    /** 所属任务卡标题 */
    readonly taskTitle: string;
    /** P5 run-id（宿主路由/去重用） */
    readonly runId: string;
  }>
) => Promise<boolean>;

/**
 * 任务执行进度事件（Web UI 实时进展显示，2026-10-03）。
 *
 * 与 executors/llm-task-executor.ts 中的定义保持同构——端口层先行声明类型，
 * 执行器实现引用同一形状，宿主（SessionManager）只依赖端口协议即可桥接，
 * 避免 handler 层反向依赖 executor 具体实现。
 */
export interface P5TaskProgressEvent {
  /** 进度相位：任务开始 / LLM 请求 / 工具执行 / 任务终态 */
  readonly phase: "task_start" | "llm_request" | "tool_execution" | "task_end";
  /** 一行预览文本（气泡标题） */
  readonly previewText: string;
  /** 累积式思考过程文本（换行保留，供前端折叠区 Markdown 渲染） */
  readonly thinkingText: string;
  /** 当前工具循环轮次（可选） */
  readonly round?: number;
}

/** 任务执行进度回调（宿主注入执行器，把进展转成 SSE llm_delta 帧外发） */
export type P5TaskProgressCallback = (event: Readonly<P5TaskProgressEvent>) => void;

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
  /**
   * bash 高危命令人工确认回调（可选，宿主注入；2026-10-03）。
   *
   * 执行器权限钩子命中 DANGEROUS_COMMAND_PATTERNS 时挂起等待此回调的人类决策：
   * - 已注入：批准→执行；拒绝/超时/异常→deny 并把原因回灌模型；
   * - 未注入：高危命令直接 deny（fail-closed，宁可误拒不可误放）。
   */
  readonly dangerousCommandApproval?: P5DangerousCommandApproval;
  /**
   * 任务执行进度回调（可选，默认无操作）。
   *
   * Web UI 接线：SessionManager 构造执行器时注入 `(e) => this.emitLlmStreamProgress(...)`
   * 适配器，把执行进展转成 llm_delta SSE 帧，让前端「思考过程」区实时显示
   * autonomous 模式下的轮次/工具调用/终态摘要（docs/dev/web-thinking-display.md 补充）。
   */
  readonly onTaskProgress?: P5TaskProgressCallback;
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
  /**
   * 空转标记（2026-10-07 新增）：模型未发起任何工具调用且 git 无任何变更时为 true。
   *
   * 语义：success 仍为 true（工具循环正常到达终态），但本任务"光说不做"——
   * 编排器据此把该轮计入 consecutiveNoopIterations 空转熔断计数，防止
   * "每轮纯文本回复 → 卡标 completed → 零产出"被当成真实进展无限循环。
   */
  readonly noop?: boolean;
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
