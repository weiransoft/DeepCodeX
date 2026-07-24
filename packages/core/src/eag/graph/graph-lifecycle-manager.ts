/**
 * 图生命周期管理器实现（TOP-1）
 *
 * 本模块实现 GraphLifecycleManagerProtocol，统一封装 WorkGraph 的完整生命周期：
 * 初始化（initialize）→ 启动（start）→ 停止（stop）→ 状态查询（status）→ 重置（reset）。
 *
 * 设计意图（对齐设计文档 §13.12 / 附录 D TOP-1）：
 * - 将 GraphLoopOrchestrator 的构造与运行细节隐藏，使 CLI、Web UI、自动化脚本只与生命周期状态机交互。
 * - 通过显式状态转换避免非法调用（如在 running 时 reset）。
 * - 提供状态变更监听器，便于上层接入日志、指标和调试器（TOP-5）。
 * - 监听器执行异常不得中断主流程，实现类会捕获并记录警告。
 *
 * 状态转换规则：
 * - idle ──initialize()──> initializing ──构造完成──> ready
 * - ready ──start()──> running ──成功 completed / 非 completed 失败──> completed / failed
 * - running ──start() 异常──> failed
 * - running ──stop()──> stopping ──start() Promise 完成──> completed / failed
 * - completed / failed / ready ──reset()──> resetting ──清理完成──> idle
 * - running / stopping 状态禁止 reset()
 *
 * 线程/并发安全说明：
 * - 本实现假设单线程事件循环调用；start() / stop() / reset() 之间可能产生竞态，
 *   通过状态机检查和一次性标志位进行基础防护。
 *
 * @module eag/graph/graph-lifecycle-manager
 */

import { GraphLoopOrchestrator } from "./graph-loop-orchestrator";
import type {
  /** 工作图定义 */
  WorkGraph,
  /** 图运行报告 */
  GraphRunReport,
} from "./graph-loop-models";
import type {
  /** 编排器构造选项 */
  GraphLoopOrchestratorOptions,
} from "./graph-loop-protocols";
import type {
  /** 图生命周期状态 */
  GraphLifecycleState,
  /** 图生命周期管理器协议 */
  GraphLifecycleManagerProtocol,
  /** 图生命周期状态变更事件 */
  GraphLifecycleStateChangeEvent,
  /** 图生命周期状态变更监听器 */
  GraphLifecycleStateChangeListener,
} from "./graph-lifecycle-models";

// ============================================================================
// GraphLifecycleManager 实现类
// ============================================================================

/**
 * 图生命周期管理器实现类
 *
 * 实现 GraphLifecycleManagerProtocol，封装 GraphLoopOrchestrator 的构造与运行。
 *
 * 使用示例：
 * ```typescript
 * const manager = new GraphLifecycleManager();
 * manager.onStateChange = (event) => console.log(`${event.oldState} -> ${event.newState}`);
 *
 * await manager.initialize(graph, orchestratorOptions);
 * const report = await manager.start();
 * console.log(report.finalStatus);
 * await manager.reset();
 * ```
 */
export class GraphLifecycleManager implements GraphLifecycleManagerProtocol {
  /** 当前生命周期状态（默认 idle） */
  private state: GraphLifecycleState;

  /** 当前持有的编排器实例（initialize 后赋值，reset 后释放） */
  private orchestrator?: GraphLoopOrchestrator;

  /** 当前待执行/已执行的工作图（initialize 后赋值，reset 后释放） */
  private currentGraph?: Readonly<WorkGraph>;

  /** 最近一次图执行报告（start 成功后赋值，reset 后释放） */
  private currentReport?: Readonly<GraphRunReport>;

  /** stop() 调用时传入的停止原因（用于状态变更事件和日志） */
  private stopReason?: string;

  /**
   * 状态变更监听器（可选）
   *
   * 每次状态转换时触发。监听器异常会被捕获并记录警告，不会中断状态转换。
   */
  public onStateChange?: GraphLifecycleStateChangeListener;

  /**
   * 构造图生命周期管理器
   *
   * 初始状态为 idle，未持有任何编排器或图定义。
   */
  constructor() {
    this.state = "idle";
  }

  /**
   * 安全设置内部状态并触发监听器
   *
   * 状态变更前后会构造 GraphLifecycleStateChangeEvent 并调用 onStateChange。
   * 监听器抛异常时仅记录 console.warn，不影响状态转换和后续流程。
   *
   * @param newState 目标状态
   * @param reason 状态变更原因（可选，写入事件 reason 字段）
   */
  private setState(newState: GraphLifecycleState, reason?: string): void {
    const oldState = this.state;
    this.state = newState;

    const event: GraphLifecycleStateChangeEvent = {
      oldState,
      newState,
      changedAt: new Date().toISOString(),
      reason,
    };

    if (this.onStateChange) {
      try {
        this.onStateChange(event);
      } catch (err) {
        // 监听器异常不得中断状态转换，仅记录警告
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[GraphLifecycleManager] 状态变更监听器异常（${oldState} -> ${newState}）：${message}`);
      }
    }
  }

  /**
   * 初始化图执行环境
   *
   * 校验当前状态允许初始化后，进入 initializing 状态，
   * 使用传入的 options 构造 GraphLoopOrchestrator 实例，
   * 完成后进入 ready 状态。
   *
   * 允许初始化的状态：idle / completed / failed。
   * 禁止初始化的状态：initializing / ready / running / stopping / resetting。
   *
   * @param graph 待执行的工作图定义
   * @param options 编排器构造选项
   * @throws {Error} 当状态不是 idle / completed / failed 时抛出
   */
  async initialize(graph: Readonly<WorkGraph>, options: Readonly<GraphLoopOrchestratorOptions>): Promise<void> {
    if (this.state !== "idle" && this.state !== "completed" && this.state !== "failed") {
      throw new Error(
        `GraphLifecycleManager.initialize: 非法状态转换，当前状态为 ${this.state}，` +
          "只能从 idle / completed / failed 状态调用 initialize()"
      );
    }

    this.setState("initializing", "initialize");

    // 保存图定义和构造编排器
    // 注意：GraphLoopOrchestrator 在 run() 时才会执行 validateGraph，
    // 因此 initialize 阶段仅做构造，不做图结构校验。
    this.currentGraph = graph;
    this.orchestrator = new GraphLoopOrchestrator(options);
    this.currentReport = undefined;
    this.stopReason = undefined;

    this.setState("ready", "initialize-complete");
  }

  /**
   * 启动图执行
   *
   * 仅在 ready 状态下可调用。调用后状态变为 running，
   * 图遍历完成后根据 GraphRunReport.finalStatus 设置 completed 或 failed。
   *
   * 停止语义：
   * - 执行过程中调用 stop() 会设置 cancel 信号，orchestrator.run() 返回后 finalStatus 可能为 aborted。
   * - 此时 aborted 视为非 completed，状态将迁移到 failed（但报告本身保留 aborted 标记）。
   *
   * 异常处理：
   * - 若编排器 run() 抛异常，状态迁移到 failed，异常重新抛出供调用方处理。
   *
   * @returns 图运行报告（不可变对象）
   * @throws {Error} 当状态不是 ready 或缺少编排器/图定义时抛出
   */
  async start(): Promise<Readonly<GraphRunReport>> {
    if (this.state !== "ready" || !this.orchestrator || !this.currentGraph) {
      throw new Error(
        `GraphLifecycleManager.start: 非法状态转换，当前状态为 ${this.status()}，` +
          "只能在 ready 状态且已成功 initialize() 后调用 start()"
      );
    }

    this.setState("running", "start");

    try {
      const report = await this.orchestrator.run(this.currentGraph);
      this.currentReport = report;

      // 根据最终状态决定生命周期状态
      // 注意：aborted / timeout / failed 均映射到生命周期 failed 状态
      const isCompleted = report.finalStatus === "completed";
      this.setState(isCompleted ? "completed" : "failed", "run-complete");

      return report;
    } catch (err) {
      this.setState("failed", "run-error");
      throw err;
    }
  }

  /**
   * 请求停止图执行
   *
   * 仅在 running 状态下生效。调用后状态迁移到 stopping，
   * 并向编排器发送 stop 信号。本方法不等待图执行完全结束，
   * 调用方应通过 start() 返回的 Promise 等待最终结果。
   *
   * 在非 running 状态下调用为静默空操作（no-op），不抛异常。
   *
   * @param reason 停止原因（可选）
   */
  async stop(reason?: string): Promise<void> {
    if (this.state !== "running" || !this.orchestrator) {
      return;
    }

    this.stopReason = reason;
    this.setState("stopping", reason ?? "stop-requested");
    this.orchestrator.stop(reason ?? "用户请求停止图执行");
  }

  /**
   * 查询当前生命周期状态
   *
   * @returns 当前状态快照
   */
  status(): GraphLifecycleState {
    return this.state;
  }

  /**
   * 重置生命周期管理器
   *
   * 清理 orchestrator、currentGraph、currentReport、stopReason 等内部状态，
   * 完成后回到 idle 状态。
   *
   * 限制：
   * - running / stopping 状态下调用会抛出错误。
   * - idle 状态下调用为幂等空操作。
   *
   * @throws {Error} 当状态为 running 或 stopping 时抛出
   */
  async reset(): Promise<void> {
    if (this.state === "running" || this.state === "stopping") {
      throw new Error(
        `GraphLifecycleManager.reset: 非法状态转换，无法在 ${this.state} 状态下重置，` +
          "请先调用 stop() 并等待 start() Promise 完成后再调用 reset()"
      );
    }

    if (this.state === "idle") {
      return;
    }

    this.setState("resetting", "reset");

    this.orchestrator = undefined;
    this.currentGraph = undefined;
    this.currentReport = undefined;
    this.stopReason = undefined;

    this.setState("idle", "reset-complete");
  }
}
