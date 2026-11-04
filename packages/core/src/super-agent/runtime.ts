/**
 * Super Agent 运行时（组合根）
 *
 * ## 职责
 *
 * 把各个 part 模块装配成一个可运行的整体：
 *
 * ```
 *   Store（唯一持有 SQLite 连接）
 *     └─ Repositories（行 ↔ 领域对象）
 *          └─ Engine（唯一写入者）
 *               ├─ Router（Gate → Assessment → 批量决策）
 *               ├─ Effects（持久化副作用队列）
 *               ├─ Passes（每 2 秒一轮，串行）
 *               └─ Sources（事件源注册表）
 * ```
 *
 * ## 五个副作用处理器（I2 的落地）
 *
 * | kind | 处理器做什么 | 失败语义 |
 * |---|---|---|
 * | `assessment` | 跑一轮候选研判与决策 | 退避重试；研判不可用走 Eval 重排 |
 * | `launch` | 启动 Worker 会话 | 退避重试；无执行器则如实记失败并结束工单 |
 * | `delivery` | 把待投递输入送进运行中的 Worker | 退避重试；无注入通道则如实暂存 |
 * | `relay` | 把 Worker 报告回灌给 Router | 退避重试 |
 * | `reply` | 发送写侧消息 | 退避重试；标记 failed 后再抛 |
 *
 * ## 诚实降级（D2）
 *
 * - 没有 Worker 启动器 → 工单**如实失败**，不假装已派工。
 * - 没有 Worker 注入通道 → 输入**保持 pending**，不假装已送达。
 * - 没有研判器 → 决策记 `unavailable`，不编造结论。
 *
 * @module super-agent/runtime
 */

import { makeId } from "./domain/ids.js";
import type {
  AcceptMode,
  HistoricalDecision,
  IntakeResult,
  NewTrigger,
  TicketMessage,
  WorkerReport,
} from "./domain/types.js";
import { Effects, type EffectHealth } from "./effects/effects.js";
import { markAssignmentRunning } from "./engine/assignments.js";
import { buildContext, renderTaskContext } from "./engine/context.js";
import { SuperAgentEngine, type Assessor, type WorkerExecutor } from "./engine/engine.js";
import { recallHistoricalDecisions } from "./engine/history.js";
import { estimateTokens } from "./domain/recall.js";
import { Passes } from "./passes/passes.js";
import type { WorkflowPlanner } from "./planner/planner.js";
import { LlmWorkflowPlanner } from "./planner/planner.js";
import { loadPolicy } from "./policy/policy.js";
import { LlmAssessor, type HistoricalRecallPort } from "./router/assessment.js";
import { SuperAgentRouter } from "./router/router.js";
import { localWatcherKind } from "./source/local-watcher.js";
import { SourceRegistry, type SourceConfig } from "./source/kind.js";
import { SuperAgentRepositories } from "./store/repositories.js";
import { openStore, type Store } from "./store/store.js";
import { SuperAgentWorkerExecutor, type WorkerInjector, type WorkerLauncher } from "./worker/executor.js";
import { buildFailedReport, parseWorkerReport } from "./worker/report.js";

// ============================================================================
// 选项与状态
// ============================================================================

/** 写侧投递函数（首期只有 CLI 一个写侧） */
export type WriteSide = (message: TicketMessage) => void | Promise<void>;

/** Source 实例声明 */
export interface SuperAgentSourceSpec {
  /** Source kind ID（已注册的类型，如 "local-watcher"） */
  readonly kindId: string;
  /** 实例 ID（稳定，跨重启不变） */
  readonly sourceId: string;
  /** 实例配置 */
  readonly config?: SourceConfig;
}

/** 运行时构造选项 */
export interface SuperAgentRuntimeOptions {
  /** SQLite 数据库文件路径（绝对路径） */
  readonly databasePath: string;
  /** 项目根目录（用于解析用户配置的真实模型） */
  readonly projectRoot: string;
  /** 时钟（测试可注入固定时钟） */
  readonly now?: () => Date;
  /** 研判器（null = 无研判能力，推断型一律 unavailable） */
  readonly assessor?: Assessor | null;
  /**
   * 计划器（undefined = 装配默认 LLM 计划器；null = 不做动态分解）
   *
   * 不做动态分解时，接单语义与旧版完全一致（一单一角色）。
   */
  readonly planner?: WorkflowPlanner | null;
  /** Worker 启动器（null = 不派工，工单如实失败） */
  readonly launcher?: WorkerLauncher | null;
  /** Worker 注入通道（null = 无法向运行中的 Worker 追加输入） */
  readonly injector?: WorkerInjector | null;
  /** 写侧投递函数（默认打到 stdout） */
  readonly writeSide?: WriteSide;
  /** Pass 轮询间隔（毫秒，默认 2000） */
  readonly passIntervalMs?: number;
  /** 单轮处理的副作用上限（默认 50） */
  readonly effectLimit?: number;
  /** Eval 超时（毫秒，默认 30 秒） */
  readonly evalTimeoutMs?: number;
  /** 要启动的 Source 实例 */
  readonly sources?: readonly SuperAgentSourceSpec[];
}

/** 运行时状态快照（供 `super status` 展示） */
export interface SuperAgentStatus {
  readonly databasePath: string;
  readonly acceptMode: AcceptMode;
  readonly policyVersion: number;
  readonly openTickets: number;
  readonly totalTickets: number;
  readonly pendingEffects: Readonly<Record<string, number>>;
  readonly effectHealth: readonly EffectHealth[];
  readonly sources: readonly { readonly id: string; readonly kind: string }[];
  /** 是否具备研判能力 */
  readonly assessorAvailable: boolean;
  /** 是否具备动态分解（计划）能力 */
  readonly plannerAvailable: boolean;
  /** 计划与步骤进度 */
  readonly plans: {
    /** 有计划的总工单数 */
    readonly total: number;
    /** 待派工步骤 */
    readonly pendingSteps: number;
    /** 运行中步骤 */
    readonly runningSteps: number;
    /** 已完成步骤 */
    readonly completedSteps: number;
    /** 失败步骤 */
    readonly failedSteps: number;
  };
  /** 是否具备派工能力 */
  readonly executorAvailable: boolean;
  /** 是否具备向运行中 Worker 追加输入的能力 */
  readonly injectorAvailable: boolean;
  /** 候选数（触发事件进入 Eval 的次数） */
  readonly candidates: {
    /** 当前待研判候选 */
    readonly pending: number;
    /** 今日新增进入 Eval 的候选 */
    readonly today: number;
    /** 累计进入 Eval 的候选 */
    readonly total: number;
  };
  /** 未决 Attention 数（等待人回答） */
  readonly openAttention: number;
  /**
   * 订阅直通次数
   *
   * = `disposition.kind === 'fanned_out'` 的条数：触发事件命中订阅中的工单，
   * **未经过 Router 决策**。这是 `proposal-final.md` §5.2 的
   * `routed_via_subscription` 可观测量的真实来源（此前全仓 0 命中，承诺未兑现）。
   */
  readonly routedViaSubscription: number;
  /** 累计 token（**估算**，CJK 感知口径 `ceil(cjk + nonCjk/4)`） */
  readonly workerTokens: {
    /** Worker 收到的投递输入 */
    readonly input: number;
    /** Worker 产出的报告正文 */
    readonly output: number;
    /** 合计 */
    readonly total: number;
  };
}

// ============================================================================
// 运行时
// ============================================================================

/**
 * SuperAgentRuntime —— Super Agent 的组合根
 */
export class SuperAgentRuntime {
  /** 持久层 */
  readonly store: Store;
  /** 仓储 */
  readonly repos: SuperAgentRepositories;
  /** 引擎 */
  readonly engine: SuperAgentEngine;
  /** 副作用队列 */
  readonly effects: Effects;
  /** 路由器 */
  readonly router: SuperAgentRouter;
  /** 周期调度 */
  readonly passes: Passes;
  /** Source 注册表 */
  readonly sources: SourceRegistry;
  /** 执行器（null = 不派工） */
  private readonly executor: WorkerExecutor | null;
  /** 计划器（null = 不做动态分解） */
  private readonly planner: WorkflowPlanner | null;
  /** 注入通道（null = 不追加输入） */
  private readonly injector: WorkerInjector | null;
  /** 写侧 */
  private readonly writeSide: WriteSide;
  /** 单轮副作用上限 */
  private readonly effectLimit: number;
  /** 是否已关闭 */
  private closed = false;

  /**
   * 构造运行时
   *
   * @param store 持久层
   * @param repos 仓储
   * @param engine 引擎
   * @param router 路由器
   * @param effects 副作用队列
   * @param passes 周期调度
   * @param sources Source 注册表
   * @param options 其余可选项
   */
  private constructor(
    store: Store,
    repos: SuperAgentRepositories,
    engine: SuperAgentEngine,
    router: SuperAgentRouter,
    effects: Effects,
    passes: Passes,
    sources: SourceRegistry,
    options: {
      readonly executor: WorkerExecutor | null;
      readonly planner: WorkflowPlanner | null;
      readonly injector: WorkerInjector | null;
      readonly writeSide: WriteSide;
      readonly effectLimit: number;
    }
  ) {
    this.store = store;
    this.repos = repos;
    this.engine = engine;
    this.router = router;
    this.effects = effects;
    this.passes = passes;
    this.sources = sources;
    this.executor = options.executor;
    this.planner = options.planner;
    this.injector = options.injector;
    this.writeSide = options.writeSide;
    this.effectLimit = options.effectLimit;
  }

  /**
   * 创建并装配运行时
   *
   * @param options 构造选项
   * @returns 已完成迁移与装配的运行时
   */
  static async create(options: SuperAgentRuntimeOptions): Promise<SuperAgentRuntime> {
    const store = await openStore({
      databasePath: options.databasePath,
      now: options.now,
    });
    const repos = new SuperAgentRepositories(store);

    const assessor =
      options.assessor === undefined
        ? new LlmAssessor({ projectRoot: options.projectRoot, recall: buildRecallPort(repos, store) })
        : options.assessor;

    // 计划器：undefined → 默认 LLM 计划器；null → 不做动态分解（旧语义）
    const planner: WorkflowPlanner | null =
      options.planner === undefined ? new LlmWorkflowPlanner({ projectRoot: options.projectRoot }) : options.planner;

    // Worker 执行器只依赖仓储（不依赖 Engine）——避免「Engine 要执行器、执行器要 Engine」
    // 的构造期循环。
    const workerExecutor: WorkerExecutor | null =
      options.launcher === null || options.launcher === undefined
        ? null
        : new SuperAgentWorkerExecutor({ repos, launcher: options.launcher });

    const engine = new SuperAgentEngine({
      store,
      repos,
      assessor,
      executor: workerExecutor,
      evalTimeoutMs: options.evalTimeoutMs,
    });

    const router = new SuperAgentRouter({ engine, assessor, planner });
    const effects = new Effects(store, repos);
    const passes = new Passes({
      intervalMs: options.passIntervalMs ?? 2000,
      onTick: async () => {
        await effects.drain(effectLimitOf(options));
      },
    });

    const sources = new SourceRegistry();
    sources.registerKind(localWatcherKind);
    for (const spec of options.sources ?? []) {
      sources.create(spec.kindId, spec.sourceId, spec.config ?? {}, (trigger, threadKeys) => {
        engine.sources.receiveTrigger({ trigger, threadKeys });
      });
    }

    const runtime = new SuperAgentRuntime(store, repos, engine, router, effects, passes, sources, {
      executor: workerExecutor,
      planner,
      injector: options.injector ?? null,
      writeSide: options.writeSide ?? defaultWriteSide,
      effectLimit: effectLimitOf(options),
    });

    runtime.registerEffectHandlers();
    return runtime;
  }

  // ------------------------------------------------------------- 生命周期

  /** 启动：拉起 Source 与周期调度 */
  async start(): Promise<void> {
    await this.sources.startAll();
    this.passes.start();
  }

  /** 停止：停调度、停 Source、关连接 */
  async stop(): Promise<void> {
    this.passes.stop();
    await this.sources.stopAll();
    if (!this.closed) {
      this.closed = true;
      this.store.close();
    }
  }

  /** 同步跑一轮（供 `--once` 模式与测试使用） */
  async tick(): Promise<void> {
    await this.passes.tick();
  }

  // ---------------------------------------------------------------- 对外

  /**
   * 投递一个事件（CLI `super inject` 与 Source 共用同一条准入路径）
   *
   * @param trigger 事件
   * @param threadKeys Thread 相关键
   * @returns 准入结果
   */
  injectTrigger(trigger: NewTrigger, threadKeys: readonly string[]): IntakeResult {
    return this.engine.sources.receiveTrigger({ trigger, threadKeys });
  }

  /**
   * Worker 终态回调：把结果解析成结构化报告并回灌给 Router
   *
   * @param assignmentId Assignment ID
   * @param result Worker 原始输出（null = 无输出）
   * @param error 失败原因（null = 无失败）
   */
  notifyWorkerComplete(assignmentId: string, result: string | null, error: string | null): void {
    const report: WorkerReport =
      result !== null && result.trim().length > 0
        ? parseWorkerReport(result)
        : buildFailedReport(error ?? "Worker 未返回任何结果，判定为失败。");
    const at = this.store.now();
    this.store.write((tx) => {
      this.repos.enqueueEffect(tx, {
        kind: "relay",
        key: `relay:${assignmentId}`,
        payload: { assignmentId, report },
        dueAt: at,
      });
    });
  }

  /**
   * 取运行时状态快照
   *
   * @returns 状态
   */
  status(): SuperAgentStatus {
    const policy = loadPolicy((key) => this.repos.getKv(key));
    const tickets = this.repos.listTickets();
    const startOfToday = startOfLocalDay(this.store.now());

    // 候选数：`evaluated` 处置 = 触发事件进入 Eval（累计 / 今日）
    const evaluatedTotal = this.repos.countDispositionsByKind("evaluated");
    const evaluatedToday = this.repos.countDispositionsByKind("evaluated", startOfToday);

    // 订阅直通：`fanned_out` 处置 = 命中订阅工单、未经过 Router 决策
    const routedViaSubscription = this.repos.countDispositionsByKind("fanned_out");

    // 未决 Attention（等待人回答）
    const openAttention = this.repos.listOpenAttention().length;

    // 累计 token（估算）——从既有持久化事实派生，不新增任何表
    const workerTokens = estimateWorkerTokens(this.repos);

    return {
      databasePath: this.store.databasePath,
      acceptMode: policy.acceptMode,
      policyVersion: policy.version,
      openTickets: tickets.filter((ticket) => ticket.state === "open").length,
      totalTickets: tickets.length,
      pendingEffects: this.effects.pending(),
      effectHealth: this.effects.health(),
      sources: this.sources.listInstances().map((instance) => ({
        id: instance.id,
        kind: instance.id,
      })),
      assessorAvailable: this.engine.context.assessor !== null,
      plannerAvailable:
        this.planner !== null && (this.planner.available === undefined ? true : this.planner.available()),
      plans: {
        total: this.repos.countPlans(),
        pendingSteps: this.repos.countPlanStepsByState("pending"),
        runningSteps: this.repos.countPlanStepsByState("running"),
        completedSteps: this.repos.countPlanStepsByState("ready"),
        failedSteps: this.repos.countPlanStepsByState("failed"),
      },
      executorAvailable: this.executor !== null,
      injectorAvailable: this.injector !== null,
      candidates: {
        pending: this.engine.router.listCandidates().length,
        today: evaluatedToday,
        total: evaluatedTotal,
      },
      openAttention,
      routedViaSubscription,
      workerTokens,
    };
  }

  // ------------------------------------------------------- 副作用处理器

  /**
   * 注册五个副作用处理器
   *
   * 每个 kind 只能注册一次（`Effects.register` 会拒绝重复注册）。
   */
  private registerEffectHandlers(): void {
    this.effects.register("assessment", async () => {
      await this.router.processCandidates();
    });

    this.effects.register("launch", async (effect) => {
      await this.handleLaunch(effect.payload);
    });

    this.effects.register("delivery", async (effect) => {
      await this.handleDelivery(effect.payload);
    });

    this.effects.register("relay", async (effect) => {
      this.handleRelay(effect.payload);
    });

    this.effects.register("reply", async (effect) => {
      await this.handleReply(effect.payload);
    });
  }

  /**
   * `launch`：启动 Worker 会话
   *
   * @param payload 副作用载荷
   */
  private async handleLaunch(payload: unknown): Promise<void> {
    const { ticketId, assignmentId } = readPayload(payload);
    const ticket = this.repos.findTicket(ticketId);
    if (ticket === undefined) {
      throw new Error(`工单 ${ticketId} 不存在——无法派工。`);
    }

    if (this.executor === null) {
      // 诚实降级：没有执行器就**如实失败**，不假装已派工
      this.engine.executor.reportAssignment(
        assignmentId,
        buildFailedReport("未配置 Worker 启动器（executor 不可用），本工单未派工。")
      );
      return;
    }

    const step = this.repos.findPlanStepByAssignment(assignmentId);
    const sessionId = await this.executor.start({
      ticketId,
      assignmentId,
      // 计划的每一步有自己的角色；无计划时退回工单角色（旧语义）
      role: step?.role ?? ticket.execution.role,
      scope: ticket.mandate.scope,
      prompt: "",
    });
    const at = this.store.now();
    this.store.write((tx) => {
      markAssignmentRunning(this.engine.context, tx, assignmentId, sessionId);
      this.repos.updateAssignment(tx, assignmentId, { startedAt: at });
      if (step !== undefined) {
        this.repos.updatePlanStep(tx, ticketId, step.stepId, { state: "running", startedAt: at });
      }
    });
  }

  /**
   * `delivery`：把待投递输入送进运行中的 Worker
   *
   * @param payload 副作用载荷
   */
  private async handleDelivery(payload: unknown): Promise<void> {
    const { ticketId } = readPayload(payload);
    const ticket = this.repos.findTicket(ticketId);
    if (ticket === undefined) {
      throw new Error(`工单 ${ticketId} 不存在——无法投递。`);
    }

    const pending = this.repos.listPendingInputs(ticketId);
    if (pending.length === 0) return;

    // 运行中的 Assignment 可能不止一个（计划同一波内并行派工）。
    // 投递必须**无歧义**：只有恰好一个 Worker 在跑时才投；否则如实暂存。
    const running = this.repos.listAssignments(ticketId).filter((candidate) => candidate.state === "running");
    if (running.length > 1) {
      const at = this.store.now();
      this.store.write((tx) => {
        this.repos.insertTicketMessage(tx, {
          id: makeId("message"),
          ticketId,
          direction: "out",
          // dropped = 不入写侧发送队列：这只是一条内部说明，不是给人的通知
          body: `当前有 ${running.length} 个并行步骤运行中，${pending.length} 条输入暂存，待波次收敛后投递。`,
          state: "dropped",
          attempts: 0,
          createdAt: at,
        });
      });
      return;
    }
    if (running.length === 0) {
      // Worker 尚未就绪（launch 副作用可能还在队列里）：抛出 → 由 Effects 退避重试
      throw new Error(`工单 ${ticketId} 的 Worker 尚未就绪——投递延后重试。`);
    }
    const assignment = running[0].id;
    const workerSessionId = running[0].workerSessionId;
    if (workerSessionId === null) {
      throw new Error(`工单 ${ticketId} 的 Worker 尚未就绪——投递延后重试。`);
    }

    if (this.injector === null) {
      // 无注入通道：**输入保持 pending**，只如实记录一条待转交说明
      const at = this.store.now();
      this.store.write((tx) => {
        this.repos.insertTicketMessage(tx, {
          id: makeId("message"),
          ticketId,
          direction: "out",
          body: `待转交输入 ${pending.length} 条（未配置 Worker 注入通道，输入保持待转交状态）。`,
          state: "pending",
          attempts: 0,
          createdAt: at,
        });
      });
      return;
    }

    const text = pending.map((input) => `- [${input.kind}] ${input.body}`).join("\n");
    // 🔴 第 2 轮才带「工单上下文」：**派工时刻任务层投影必然为空**
    // （刚建单：无未决待办、无最近报告、无历史报告），只有追加输入到达时
    // 工单上才可能出现可投影的内容。此处不附上下文 = 该段永远不出现。
    const contextText = this.renderTaskContextFor(ticketId);
    const injectionText = contextText.length > 0 ? `${text}\n\n## 工单上下文\n${contextText}` : text;
    const outcome = await this.injector.inject({
      ticketId,
      assignmentId: assignment,
      text: injectionText,
    });

    // 🔴 只有指令**真被 Worker 接收**才标记「已送达」。
    // 此前无论注入是否真的送达都会标记，导致输入被记为已投递、实际从未到达 LLM。
    if (!outcome.accepted) {
      throw new Error(
        `工单 ${ticketId} 的输入未能投递给 Worker：${outcome.reason ?? "注入通道未确认接收"}——输入保持待投递状态。`
      );
    }

    const at = this.store.now();
    this.store.write((tx) => {
      for (const input of pending) {
        this.repos.markInputDelivered(tx, input.id, at);
      }
    });
  }

  /**
   * 渲染工单的任务层上下文投影（direct 通道）
   *
   * **只读**：只读既有表派生视图，不产生任何新的持久化状态（I10）。
   *
   * 与 `worker/executor.ts` 的首轮渲染保持同一套排除规则：
   * 授权范围与待投递输入已有专属段落，重复出现既浪费预算也可能与启动参数不一致。
   *
   * 装配失败（如工单已被并发删除）时**如实降级为空串**——
   * 上下文是增强项，不该让整条投递链路失败。
   *
   * @param ticketId 工单 ID
   * @returns Markdown 文本；无内容时返回空串
   */
  private renderTaskContextFor(ticketId: string): string {
    try {
      const bundle = buildContext({ repos: this.repos, now: () => this.store.now() }, { ticketId });
      return renderTaskContext(bundle, { exclude: ["mandate", "pending_input"] });
    } catch {
      return "";
    }
  }

  /**
   * `relay`：把 Worker 报告回灌给 Router
   *
   * @param payload 副作用载荷
   */
  private handleRelay(payload: unknown): void {
    const { assignmentId } = readPayload(payload);
    const report = readReport(payload);
    if (report === undefined) {
      throw new Error(`relay 副作用缺少结构化报告（assignment=${assignmentId}）。`);
    }
    this.engine.executor.reportAssignment(assignmentId, report);
  }

  /**
   * `reply`：发送写侧消息
   *
   * @param payload 副作用载荷
   */
  private async handleReply(payload: unknown): Promise<void> {
    const { ticketId, messageId } = readPayload(payload);
    const message = this.repos.listTicketMessages(ticketId).find((candidate) => candidate.id === messageId);
    if (message === undefined) {
      throw new Error(`消息 ${messageId} 不存在——无法发送。`);
    }
    try {
      await this.writeSide(message);
    } catch (error) {
      // 标记失败后抛出 → Effects 退避重试；重试耗尽时状态停留在 failed（如实）
      this.store.write((tx) => {
        this.repos.updateTicketMessageState(tx, messageId, "failed");
      });
      throw error;
    }
    this.store.write((tx) => {
      this.repos.updateTicketMessageState(tx, messageId, "sent");
    });
  }
}

// ============================================================================
// 辅助
// ============================================================================

/** 默认写侧：把消息打到 stdout */
function defaultWriteSide(message: TicketMessage): void {
  console.log(`[super-agent:${message.ticketId}] ${message.body}`);
}

/** 取副作用载荷中的标识字段 */
function readPayload(payload: unknown): {
  ticketId: string;
  assignmentId: string;
  messageId: string;
} {
  const record = (payload ?? {}) as Record<string, unknown>;
  return {
    ticketId: typeof record["ticketId"] === "string" ? record["ticketId"] : "",
    assignmentId: typeof record["assignmentId"] === "string" ? record["assignmentId"] : "",
    messageId: typeof record["messageId"] === "string" ? record["messageId"] : "",
  };
}

/** 取副作用载荷中的结构化报告 */
function readReport(payload: unknown): WorkerReport | undefined {
  const record = (payload ?? {}) as Record<string, unknown>;
  const report = record["report"];
  if (typeof report !== "object" || report === null) return undefined;
  return report as WorkerReport;
}

/** 取单轮副作用上限 */
function effectLimitOf(options: SuperAgentRuntimeOptions): number {
  return options.effectLimit ?? 50;
}

/**
 * 构造历史经验召回端口
 *
 * 全局层上下文（历史研判经验）由既有 `decision` 表**派生**——
 * 不建表、不落库、零迁移（见 `engine/history.ts`）。
 *
 * **只读**（I10）：召回只 `SELECT`，不产生任何新的持久化状态。
 *
 * @param repos 仓储
 * @param store 持久层（取时钟）
 * @returns 召回端口
 */
function buildRecallPort(repos: SuperAgentRepositories, store: Store): HistoricalRecallPort {
  return (query: string, sourceId: string): readonly HistoricalDecision[] =>
    recallHistoricalDecisions({ repos, now: () => store.now() }, { query, sourceId }).map((hit) => hit.decision);
}

/**
 * 取本地时区的当日起点（ISO 8601）
 *
 * @param isoNow 当前时间（ISO 8601）
 * @returns 当日 00:00:00 的 ISO 8601
 */
function startOfLocalDay(isoNow: string): string {
  const now = new Date(isoNow);
  if (Number.isNaN(now.getTime())) {
    return isoNow;
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/**
 * 估算累计 token
 *
 * ## 口径（**估算，不是账单**）
 *
 * | 方向 | 来源 |
 * |---|---|
 * | input | 所有工单的 `ticket_input.body`——投给 Worker 的内容 |
 * | output | 所有 Assignment 的 `report.summary` + `artifacts`——Worker 产出的正文 |
 *
 * 之所以只能估算：Worker 侧不落库真实 usage（落库需要新表，违反 I10「零新表」）。
 * 该口径与 `domain/recall.ts` 的 `estimateTokens` 一致（CJK 感知：`ceil(cjk + nonCjk/4)`）。
 *
 * @param repos 仓储
 * @returns token 估算
 */
function estimateWorkerTokens(repos: SuperAgentRepositories): {
  input: number;
  output: number;
  total: number;
} {
  let input = 0;
  let output = 0;
  // 状态快照是一次性全量扫描——limit 给足，避免长跑后低估
  for (const ticket of repos.listTickets(undefined, 10_000)) {
    for (const inputRecord of repos.listInputs(ticket.id)) {
      input += estimateTokens(inputRecord.body);
    }
    for (const assignment of repos.listAssignments(ticket.id)) {
      const report = assignment.report;
      if (report === null) continue;
      output += estimateTokens(`${report.summary}\n${report.artifacts.join("\n")}`);
    }
  }
  return { input, output, total: input + output };
}
