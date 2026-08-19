/**
 * EAG 编排器 CLI 装配模块（2026-07-31 新特性集成审查 FIX-1 / FIX-2）
 *
 * 背景（审查 GAP-1 / GAP-2）：
 * - /eag-autonomous 三命令（B 域）与 /eag-graph（D 域）的引擎与命令 Handler
 *   在 core 层完整实现并有测试覆盖，但 CLI 生产装配路径（App.tsx → SessionManager）
 *   从未注入 autonomousOrchestrator / graphLoopOrchestratorOptions，
 *   导致 4 个命令在真实 CLI 中全部 fail-closed 不可用。
 * - 本模块是唯一的生产装配点（单一数据源），负责真实构造全部依赖并注入。
 *
 * 设计契约（与 core session.ts 的既有契约对齐）：
 * - 失败安全：任一组件构造异常 → 返回 undefined 并记录日志，
 *   SessionManager 维持"未注入时命令不可用"的 fail-closed 降级，CLI 主流程不崩溃。
 * - 真实实现：禁止 mock / 占位 / 永远成功的假适配器。
 *   - LoopHandoffAdapter 的 executor 仅当 loop 节点配置 plugin 时经 GoalDispatcher
 *     真实派发；未配置时诚实返回失败（fail-closed），绝不假装成功。
 *   - evaluator 真实执行节点 overrides.testCommand（child_process），
 *     未配置时执行输出契约校验（success===true 且 output 非空），绝不永远 passed。
 *
 * @module ui/core/eag-orchestrator-assembly
 */

import { exec } from "node:child_process";
import {
  EagP5,
  GoalDispatcher,
  PluginRegistry,
  makeGoal,
  makeBatch,
  AutonomousPlugin,
  MultiGoalPlugin,
  GraphPlugin,
  LoopPlugin,
  ResumePlugin,
  CancelPlugin,
  NodeExecutorImpl,
  EdgeResolverImpl,
  GraphSchedulerImpl,
  GraphGuardImpl,
  createPredicateRegistry,
  createRetrySuppressionConfig,
  // S3.2（2026-08-19）：DESIGN Loop 三角色装配组件（/eag-design 接线批次）
  LlmProductManager,
  LlmArchitect,
  FeedbackAwareArchitect,
  FeedbackCapturingEvaluator,
  StaticDesignEvaluator,
  DesignLoopOrchestrator,
} from "@vegamo/deepcode-core";
import type {
  AutonomousOrchestrator,
  GraphLoopOrchestratorOptions,
  LoopHandoffAdapter,
  LoopExecutorCallback,
  LoopEvaluatorCallback,
  GraphNodeDef,
  GraphRunContext,
  GraphLogger,
  TaskRequirement,
  LLMClient,
} from "@vegamo/deepcode-core";

/** 装配日志回调（与 core P5LogCallback / AutonomousOrchestratorLogCallback 签名对齐） */
export type AssemblyLogCallback = (message: string, level?: "info" | "warn" | "error") => void;

/**
 * evaluator 执行节点测试命令的超时上限（毫秒）
 *
 * 对齐 P5 默认 testTimeoutSec=600s，避免测试命令挂死导致图遍历卡死。
 */
const TEST_COMMAND_TIMEOUT_MS = 600_000;

/** 测试命令输出截断长度（findings 中保留 stdout/stderr 尾部，避免上下文爆炸） */
const COMMAND_OUTPUT_TAIL_LENGTH = 2_000;

/**
 * 构造适配 GraphLogger 接口的最小日志器
 *
 * 将 4 级日志统一桥接到 AssemblyLogCallback（最终汇入 CLI debug 日志通道）。
 *
 * @param log 装配日志回调
 * @returns GraphLogger 实例
 */
function createGraphLogger(log: AssemblyLogCallback): GraphLogger {
  return {
    debug: (message, context) => log(formatContext(message, context), "info"),
    info: (message, context) => log(formatContext(message, context), "info"),
    warn: (message, context) => log(formatContext(message, context), "warn"),
    error: (message, context) => log(formatContext(message, context), "error"),
  };
}

/** 将结构化上下文拼接到消息尾部（JSON 序列化失败时降级为省略上下文） */
function formatContext(message: string, context?: Record<string, unknown>): string {
  if (!context) {
    return message;
  }
  try {
    return `${message} ${JSON.stringify(context)}`;
  } catch {
    return message;
  }
}

// ============================================================================
// FIX-1：AutonomousOrchestrator 装配（/eag-autonomous 三命令）
// ============================================================================

/**
 * 真实构造完整装配的 AutonomousOrchestrator 实例
 *
 * 装配依赖（全部为 core EagP5 命名空间的生产组件，无任何 mock）：
 * - loopExecutor：4 个默认 StageHandler（plan/dev/verify/fix，真实文件 + 命令操作）
 * - runStateStore：JSONL 运行状态持久化（断点续跑）
 * - notesMemory：跨轮 notes.md 记忆
 * - guardChain：6 层默认 BLOCKER 护栏链
 * - smartConfirmation：三态智能确认器
 *
 * @param log 装配日志回调（可选，默认空操作）
 * @returns 装配完成的 AutonomousOrchestrator；任一组件构造失败返回 undefined（失败安全）
 */
export function buildAutonomousOrchestrator(log: AssemblyLogCallback = () => {}): AutonomousOrchestrator | undefined {
  try {
    const orchestrator = EagP5.createAutonomousOrchestrator({
      loopExecutor: EagP5.createP5LoopExecutorFromHandlers(
        new EagP5.P5PlanStageHandler(),
        new EagP5.P5DevStageHandler(),
        new EagP5.P5VerifyStageHandler(),
        new EagP5.P5FixStageHandler(),
        (message, level) => log(`[P5LoopExecutor] ${message}`, level)
      ),
      runStateStore: new EagP5.P5RunStateStore((message, level) => log(`[P5RunStateStore] ${message}`, level)),
      notesMemory: new EagP5.P5NotesMemory(),
      guardChain: EagP5.createDefaultBlockerGuardChain(),
      smartConfirmation: new EagP5.P5SmartConfirmation(),
      logger: (message, level) => log(`[AutonomousOrchestrator] ${message}`, level),
    });
    log("EAG AutonomousOrchestrator 装配完成", "info");
    return orchestrator;
  } catch (err) {
    // 失败安全：装配失败不阻断 CLI 启动，/eag-autonomous 维持 fail-closed 降级
    const reason = err instanceof Error ? err.message : String(err);
    log(`EAG AutonomousOrchestrator 装配失败（命令将不可用）：${reason}`, "error");
    return undefined;
  }
}

// ============================================================================
// FIX-2：GraphLoopOrchestratorOptions 装配（/eag-graph）
// ============================================================================

/**
 * CLI 生产级 LoopHandoffAdapter
 *
 * 为图遍历中的 loop 节点提供真实的 Handoff（executor）/ Verification（evaluator）回调。
 *
 * 真实实现承诺（架构师红线）：
 * - executor：仅当 loop 节点配置 plugin 字段时，经 GoalDispatcher + makeGoal/makeBatch
 *   真实派发执行（与 NodeExecutorImpl task 节点同款路径）；上轮 evaluator 的修复建议
 *   （feedback）拼入任务输入，实现 Ralph 循环的"带着反馈重试"语义。
 *   未配置 plugin 时诚实返回 success=false（fail-closed），绝不空转假装成功。
 * - evaluator：节点 overrides.testCommand 存在时经 child_process 在 projectRoot
 *   真实执行（exit code 判定）；否则执行输出契约校验（success===true 且 output 非空）。
 *   两条路径都产生真实判定，绝不永远 passed。
 */
export class CliLoopHandoffAdapter implements LoopHandoffAdapter {
  private readonly goalDispatcher: GoalDispatcher;
  private readonly projectRoot: string;
  private readonly logger: GraphLogger;

  constructor(options: { goalDispatcher: GoalDispatcher; projectRoot: string; logger: GraphLogger }) {
    this.goalDispatcher = options.goalDispatcher;
    this.projectRoot = options.projectRoot;
    this.logger = options.logger;
  }

  /**
   * 创建 loop 节点的真实 executor 回调
   *
   * @param node loop 节点定义（plugin 字段决定派发目标）
   * @param input 节点输入数据（EdgeResolver 解析的上游输出）
   * @param context 图运行上下文
   * @returns 真实执行回调；每轮迭代经 GoalDispatcher 派发，feedback 并入任务描述
   */
  createLoopExecutor(
    node: Readonly<GraphNodeDef>,
    input: Readonly<Record<string, unknown>>,
    context: Readonly<GraphRunContext>
  ): LoopExecutorCallback {
    // 捕获节点定义（回调签名不传 node，需在闭包中携带）
    const pluginName = node.plugin;
    const nodeTask = node.task;
    const nodeId = node.nodeId;

    return async (iteration, currentInput, _context, feedback) => {
      // fail-closed：未配置 plugin 的 loop 节点在 CLI 生产路径无真实执行体
      // （自然语言任务需要 LLM 子会话，属于后续接线范围），诚实返回失败
      if (!pluginName) {
        this.logger.warn(`[CliLoopHandoffAdapter:${nodeId}] loop 节点未配置 plugin，无法真实执行`, {
          iteration,
        });
        return {
          success: false,
          error: `loop 节点 ${nodeId} 未配置 plugin 字段，CLI 生产路径无法执行（fail-closed）`,
        };
      }

      // 拼接上轮评估反馈（Ralph 循环的"带着反馈重试"语义）
      // feedback 是 LoopEvaluationVerdict 对象：提取判定理由 / 问题清单 / 修复建议
      let taskWithFeedback = nodeTask;
      if (feedback && !feedback.passed) {
        const feedbackLines = [`上轮评估未通过（${feedback.evaluatorId}）：${feedback.reason}`];
        if (feedback.findings.length > 0) {
          feedbackLines.push(`问题清单：${feedback.findings.join("；")}`);
        }
        if (feedback.suggestedFix) {
          feedbackLines.push(`修复建议：${feedback.suggestedFix}`);
        }
        taskWithFeedback = `${nodeTask}\n\n${feedbackLines.join("\n")}`;
      }

      // 复用 NodeExecutorImpl task 节点的真实派发路径
      const taskRequirement: TaskRequirement = {
        taskId: `${context.runId}-${nodeId}-iter${iteration}`,
        title: nodeTask.slice(0, 200) || `loop-${nodeId}`,
        description: taskWithFeedback,
        requiredCapabilities: [],
        preferredSkills: [],
        constraints: [],
        attachments: [],
        upstreamContext: {},
        priority: "medium",
        timeoutMs: 0,
        createdAt: new Date().toISOString(),
        domainTags: [],
      };
      const goal = makeGoal({
        plugin: pluginName,
        input: {
          ...currentInput,
          task: taskWithFeedback,
          nodeId,
          iteration,
        },
      });
      const batch = makeBatch({ task: taskRequirement, goals: [goal] });

      try {
        const batchResult = await this.goalDispatcher.dispatch(batch);
        const goalState = Array.from(batchResult.goalStates.values())[0];
        const dispatchResult = goalState?.result;
        return {
          success: batchResult.overallStatus === "succeeded",
          output: dispatchResult?.output,
          artifacts: dispatchResult?.artifacts,
          plugin: pluginName,
          iteration,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.error(`[CliLoopHandoffAdapter:${nodeId}] executor 派发异常：${reason}`, { iteration });
        return { success: false, error: `GoalDispatcher 派发异常：${reason}`, iteration };
      }
    };
  }

  /**
   * 创建 loop 节点的真实 evaluator 回调
   *
   * 判定路径（按优先级）：
   * 1. 节点 overrides.testCommand 存在 → child_process 真实执行，exit code 判定
   * 2. 否则 → 输出契约校验（success===true 且 output 非空）
   *
   * @param node loop 节点定义
   * @param input 节点输入数据
   * @param context 图运行上下文
   * @returns 真实评估回调
   */
  createLoopEvaluator(
    node: Readonly<GraphNodeDef>,
    _input: Readonly<Record<string, unknown>>,
    _context: Readonly<GraphRunContext>
  ): LoopEvaluatorCallback {
    const nodeId = node.nodeId;
    // 节点级配置覆盖中的测试命令（GraphNodeDef.overrides 是既有扩展点，非新发明）
    const testCommand =
      typeof node.overrides?.["testCommand"] === "string" ? (node.overrides["testCommand"] as string) : null;

    return async (iteration, generatorResult, _currentInput, _ctx) => {
      // 路径 1：真实执行节点声明的测试命令
      if (testCommand) {
        return this.evaluateByTestCommand(nodeId, testCommand, iteration);
      }
      // 路径 2：输出契约校验（绝不永远 passed）
      const success = generatorResult["success"] === true;
      const output = generatorResult["output"];
      const hasOutput = output !== undefined && output !== null && String(output).trim().length > 0;
      if (success && hasOutput) {
        return {
          passed: true,
          evaluatorId: "cli-contract-check",
          reason: "输出契约校验通过（success===true 且 output 非空）",
          findings: [],
          severity: "info" as const,
          suggestedFix: "",
          sampledArtifacts: [],
        };
      }
      const errorDetail =
        typeof generatorResult["error"] === "string" ? generatorResult["error"] : "output 为空或 success!==true";
      return {
        passed: false,
        evaluatorId: "cli-contract-check",
        reason: `输出契约校验失败：${errorDetail}`,
        findings: [errorDetail],
        severity: "blocker" as const,
        suggestedFix: "检查 loop 节点 plugin 执行体的真实输出，修复失败后重试",
        sampledArtifacts: [],
      };
    };
  }

  /**
   * 经 child_process 真实执行测试命令并判定
   *
   * @param nodeId 节点 ID（日志用）
   * @param command 测试命令（在 projectRoot 下执行）
   * @param iteration 当前迭代轮次
   * @returns 评估判定（exit 0 → passed；非 0/超时 → blocker）
   */
  private evaluateByTestCommand(
    nodeId: string,
    command: string,
    iteration: number
  ): Promise<{
    passed: boolean;
    evaluatorId: string;
    reason: string;
    findings: ReadonlyArray<string>;
    severity: "info" | "warning" | "blocker";
    suggestedFix: string;
    sampledArtifacts: ReadonlyArray<string>;
  }> {
    return new Promise((resolve) => {
      exec(command, { cwd: this.projectRoot, timeout: TEST_COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
        if (!error) {
          resolve({
            passed: true,
            evaluatorId: "cli-test-command",
            reason: `测试命令通过（exit 0）：${command}`,
            findings: [],
            severity: "info",
            suggestedFix: "",
            sampledArtifacts: [],
          });
          return;
        }
        // 失败路径：保留 stderr/stdout 尾部作为 findings（截断防上下文爆炸）
        const tail = (stderr || stdout || "").slice(-COMMAND_OUTPUT_TAIL_LENGTH).trim();
        const isTimeout = error.killed === true;
        const reason = isTimeout
          ? `测试命令超时（>${TEST_COMMAND_TIMEOUT_MS / 1000}s）：${command}`
          : `测试命令失败（exit ${error.code ?? "?"}）：${command}`;
        this.logger.warn(`[CliLoopHandoffAdapter:${nodeId}] ${reason}`, { iteration });
        resolve({
          passed: false,
          evaluatorId: "cli-test-command",
          reason,
          findings: tail ? [tail] : [reason],
          severity: "blocker",
          suggestedFix: `根据测试输出修复后重试：${tail.slice(0, 200)}`,
          sampledArtifacts: [],
        });
      });
    });
  }
}

/**
 * 真实构造完整装配的 GraphLoopOrchestratorOptions
 *
 * 装配依赖（全部为 core 生产组件）：
 * - nodeExecutor：NodeExecutorImpl（GoalDispatcher 真实注册 6 个生产插件 + CliLoopHandoffAdapter）
 * - edgeResolver：EdgeResolverImpl（边契约解析）
 * - graphScheduler：GraphSchedulerImpl（双层重试抑制，保守静态配置：
 *   图在命令执行时才加载，装配期 nodeCount 未知，取 32 节点 × 3 重试的保守上限）
 * - graphGuard：GraphGuardImpl（深度/并行度/Token/超时护栏，默认配置）
 * - predicateRegistry：createPredicateRegistry（内置谓词全集）
 *
 * @param projectRoot 项目根目录（evaluator 执行测试命令的工作目录）
 * @param log 装配日志回调（可选）
 * @returns 装配完成的 GraphLoopOrchestratorOptions；任一组件构造失败返回 undefined（失败安全）
 */
export function buildGraphLoopOrchestratorOptions(
  projectRoot: string,
  log: AssemblyLogCallback = () => {}
): GraphLoopOrchestratorOptions | undefined {
  try {
    const graphLogger = createGraphLogger(log);

    // 1. 真实构建 GoalDispatcher：注册 6 个生产插件（每次装配独立实例，避免跨会话状态污染）
    const registry = new PluginRegistry();
    registry.register(new AutonomousPlugin());
    registry.register(new MultiGoalPlugin());
    registry.register(new GraphPlugin());
    registry.register(new LoopPlugin());
    registry.register(new ResumePlugin());
    registry.register(new CancelPlugin());
    const goalDispatcher = new GoalDispatcher(registry, { maxParallel: 3, failFast: false });

    // 2. 生产级 LoopHandoffAdapter（loop 节点的真实 Handoff / Verification 回调）
    const loopHandoffAdapter = new CliLoopHandoffAdapter({
      goalDispatcher,
      projectRoot,
      logger: graphLogger,
    });

    // 3. 装配图编排选项（重试抑制取保守静态上限：32 节点 × 3 重试 × 2）
    const options: GraphLoopOrchestratorOptions = {
      nodeExecutor: new NodeExecutorImpl({ goalDispatcher, loopHandoffAdapter, logger: graphLogger }),
      edgeResolver: new EdgeResolverImpl(),
      graphScheduler: new GraphSchedulerImpl(createRetrySuppressionConfig(32, 3), graphLogger),
      graphGuard: new GraphGuardImpl(),
      predicateRegistry: createPredicateRegistry(),
      projectRoot,
      logger: graphLogger,
    };
    log("EAG GraphLoopOrchestratorOptions 装配完成", "info");
    return options;
  } catch (err) {
    // 失败安全：装配失败不阻断 CLI 启动，/eag-graph 维持 fail-closed 降级
    const reason = err instanceof Error ? err.message : String(err);
    log(`EAG GraphLoopOrchestratorOptions 装配失败（命令将不可用）：${reason}`, "error");
    return undefined;
  }
}

// ============================================================================
// S3.2（2026-08-19）：DesignLoopOrchestrator 装配（/eag-design）
// ============================================================================

/**
 * DESIGN Loop LLM 客户端工厂签名
 *
 * 与 App.tsx 中 eagDynamicSuggester 的 createDecisionLLMClient 同源：
 * 每次角色调用时惰性解析当前 settings 并经 ProviderFactory 路由创建客户端，
 * 返回 null 表示无可用凭据（角色将抛 DesignRoleError，由 session.ts 通知用户）。
 */
export type DesignLlmClientFactory = () => LLMClient | null;

/**
 * 真实构造完整装配的 DesignLoopOrchestrator 实例（/eag-design 命令执行体）
 *
 * 装配依赖（全部为 core 生产组件，无任何 mock）：
 * - PM：LlmProductManager（原始需求 → StructuredRequirement，LLM 驱动）
 * - 架构师：FeedbackAwareArchitect 包装 LlmArchitect
 *   （评估失败时携带 verdict 反馈重试，反馈与 requirement 对象引用绑定实现跨轮隔离）
 * - 评估器：FeedbackCapturingEvaluator 包装 StaticDesignEvaluator
 *   （真实静态判定：范式一致性 / 设计完整性 / 反模式零命中 / signalEvidence 证据强制；
 *   判定结果旁路回调给 FeedbackAwareArchitect 构成重试闭环）
 * - 编排器：DesignLoopOrchestrator（PM → 架构师 → 评估器 → 失败重试 → HUMAN_CHECKPOINT）
 *
 * StaticDesignEvaluator 默认参数说明（strict + 非锁定）：
 * - 评估模式 strict：任一判定项失败即打回，符合 DESIGN Loop 质量门禁定位
 * - paradigmLocked=false：signalEvidence 证据强制判定启用。锁定场景（--paradigm）
 *   下架构师 prompt 仍强制填写 signalEvidence（供审计），因此该判定在两种场景
 *   均可正常通过，不会误判
 *
 * 状态共享安全性（对齐 session.ts §4.18.3 契约"避免每次命令重复构造"）：
 * - DesignLoopOrchestrator.run() 入口重置运行时状态（iterations / checkpoint 标志）
 * - FeedbackAwareArchitect.lastFeedback 与 requirement 对象引用绑定，
 *   新一轮 run() 的 requirement 是新对象，旧反馈不会跨命令泄漏
 *
 * @param createLLMClient LLM 客户端工厂（与 session.ts createLLMClient 同源）
 * @param log 装配日志回调（可选，默认空操作）
 * @returns 装配完成的 DesignLoopOrchestrator；任一组件构造失败返回 undefined（失败安全）
 */
export function buildDesignOrchestrator(
  createLLMClient: DesignLlmClientFactory,
  log: AssemblyLogCallback = () => {}
): DesignLoopOrchestrator | undefined {
  try {
    // 1. PM 角色：LLM 驱动的需求结构化（用户故事 / 验收标准 / 领域词汇表 / 非功能需求）
    const pm = new LlmProductManager({ createLLMClient });

    // 2. 架构师角色：FeedbackAwareArchitect 包装 LlmArchitect，
    //    使评估失败重试时能携带上轮 verdict 的 reason/findings/suggestedFix
    const feedbackArchitect = new FeedbackAwareArchitect(new LlmArchitect({ createLLMClient }));

    // 3. 评估器角色：FeedbackCapturingEvaluator 包装 StaticDesignEvaluator（真实静态判定），
    //    每次评估后将判定回调给 feedbackArchitect，构成"失败 → 带反馈重试"闭环
    const evaluator = new FeedbackCapturingEvaluator(new StaticDesignEvaluator(), (requirement, verdict) =>
      feedbackArchitect.recordVerdict(requirement, verdict)
    );

    // 4. 三角色编排器（config 省略 → 使用 createDefaultDesignLoopConfig() 默认配置）
    const orchestrator = new DesignLoopOrchestrator(pm, feedbackArchitect, evaluator);
    log("EAG DesignLoopOrchestrator 装配完成", "info");
    return orchestrator;
  } catch (err) {
    // 失败安全：装配失败不阻断 CLI 启动，/eag-design 维持 fail-closed 降级
    const reason = err instanceof Error ? err.message : String(err);
    log(`EAG DesignLoopOrchestrator 装配失败（命令将不可用）：${reason}`, "error");
    return undefined;
  }
}
