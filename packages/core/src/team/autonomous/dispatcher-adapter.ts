/**
 * Phase 18: DispatcherAdapter - 复用现有 GoalDispatcher 的适配层（V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/autonomous/dispatcher_adapter.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 * Karpathy 原则：Simplicity First - 适配层零业务逻辑
 * Ponytail 红线：不修改 V3 dispatcher，零侵入
 *
 * 真实实现能力：
 *   1. 不修改 V3 dispatcher（facade/dispatcher/plugin 零修改）
 *   2. 构造 PluginContext 并调用 GoalDispatcher.dispatch()
 *   3. 把 dispatch 结果包装为 AdapterInvokeResult 返回
 *   4. 捕获异常并以 FATAL 形式返回（不抛异常给调用方）
 *   5. 延迟导入 facade 模块（避免循环依赖）
 *   6. 详细 error_trace 记录
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================================================
// 第一部分：类型定义
// ============================================================================

/** 调用结果判定 */
export type AdapterInvokeKind = "success" | "failed" | "retriable" | "fatal";

/** 适配器调用结果 */
export interface AdapterInvokeResult {
  success: boolean;
  kind: AdapterInvokeKind;
  output: string;
  summary: string;
  tokens: number;
  skillsUsed: string[];
  error: Error | null;
  errorTrace: string;
}

/** 默认 AdapterInvokeResult 工厂 */
export function defaultAdapterInvokeResult(): AdapterInvokeResult {
  return {
    success: false,
    kind: "failed",
    output: "",
    summary: "",
    tokens: 0,
    skillsUsed: [],
    error: null,
    errorTrace: "",
  };
}

/** 任务参数（模拟 argparse.Namespace） */
export interface DispatcherTaskArgs {
  task: string;
  agent: string;
  consensus: boolean;
  explain: boolean;
  matchStrategy: string;
  projectFullLifecycle: boolean;
  resume: boolean;
  goal: string;
  goalDesc: string;
  criteria: string[] | null;
  convergenceWindow: number;
  loop: boolean;
  maxIterations: number;
  hotReload: boolean;
  hotReloadDir: string | null;
  hotReloadInterval: number;
  autonomous: boolean;
  autoSkills: Array<Record<string, any>>;
  autoContext: Record<string, any>;
}

/** 默认任务参数工厂 */
export function defaultTaskArgs(task: string, agent: string = "auto"): DispatcherTaskArgs {
  return {
    task,
    agent,
    consensus: false,
    explain: false,
    matchStrategy: "auto",
    projectFullLifecycle: false,
    resume: false,
    goal: "",
    goalDesc: "",
    criteria: null,
    convergenceWindow: 3,
    loop: false,
    maxIterations: 1,
    hotReload: false,
    hotReloadDir: null,
    hotReloadInterval: 5.0,
    autonomous: true,
    autoSkills: [],
    autoContext: {},
  };
}

/** Facade 模块抽象（duck typing） */
export interface FacadeLike {
  _dispatchThroughV3(args: DispatcherTaskArgs | any): number;
}

/** 日志回调签名 */
export type AdapterLogCallback = (level: "info" | "warn" | "error" | "debug", message: string) => void;

/** 默认空日志 */
const NULL_LOG: AdapterLogCallback = () => {};

// ============================================================================
// 第二部分：DispatcherAdapter 类
// ============================================================================

/**
 * Ralph 风格 Dispatcher 适配器
 *
 * 设计原则：
 *   1. 不修改 V3 dispatcher
 *   2. 调用 facade._dispatch_through_v3()（如果可用）
 *   3. 失败以 FATAL 包装（不抛异常）
 *   4. 记录真实错误 trace
 */
export class DispatcherAdapter {
  private facade: FacadeLike | null = null;
  private readonly log: AdapterLogCallback;
  private dispatcherAvailable: boolean | null = null;

  constructor(args?: { facade?: FacadeLike | null; log?: AdapterLogCallback }) {
    this.facade = args?.facade ?? null;
    this.log = args?.log ?? NULL_LOG;
  }

  // ========================================================================
  // 公共 API
  // ========================================================================

  /**
   * 检测 dispatcher 是否可用（不实际调用）
   */
  isAvailable(): boolean {
    if (this.dispatcherAvailable !== null) {
      return this.dispatcherAvailable;
    }
    try {
      const facade = this.getFacade();
      this.dispatcherAvailable = facade !== null && typeof facade._dispatchThroughV3 === "function";
    } catch {
      this.dispatcherAvailable = false;
    }
    return this.dispatcherAvailable;
  }

  /**
   * 调用 dispatcher 执行一次任务
   *
   * 行为：
   *   1. 构造 taskArgs（模拟命令行参数）
   *   2. 调用 facade._dispatch_through_v3(args)
   *   3. 包装结果为 AdapterInvokeResult
   *   4. 异常 → FATAL
   */
  invoke(args: {
    task: string;
    agent?: string;
    autoSkills?: Array<Record<string, any>>;
    extraContext?: Record<string, any>;
    timeoutSec?: number;
  }): AdapterInvokeResult {
    if (!args.task || !args.task.trim()) {
      return {
        ...defaultAdapterInvokeResult(),
        kind: "fatal",
        summary: "任务描述为空",
      };
    }
    if (!this.isAvailable()) {
      return {
        ...defaultAdapterInvokeResult(),
        kind: "fatal",
        summary: "GoalDispatcher 不可用（facade 模块未找到或缺少 _dispatch_through_v3）",
      };
    }
    const facade = this.getFacade();
    if (facade === null) {
      return {
        ...defaultAdapterInvokeResult(),
        kind: "fatal",
        summary: "无法导入 facade 模块",
      };
    }
    // 构造 args
    const taskArgs: DispatcherTaskArgs = {
      ...defaultTaskArgs(args.task, args.agent ?? "auto"),
      autoSkills: args.autoSkills ?? [],
      autoContext: args.extraContext ?? {},
    };
    // 调用 dispatcher
    try {
      this.log("info", `[DispatcherAdapter] 调用 dispatcher: task=${args.task.slice(0, 60)}...`);
      const rc = facade._dispatchThroughV3(taskArgs);
      // rc 是退出码（0=成功）
      if (rc === 0) {
        return {
          success: true,
          kind: "success",
          output: `dispatcher 返回码 ${rc}`,
          summary: `任务执行成功（rc=${rc}）`,
          tokens: 0,
          skillsUsed: (args.autoSkills ?? [])
            .map((s) => (typeof s["name"] === "string" ? s["name"] : ""))
            .filter((n) => n.length > 0),
          error: null,
          errorTrace: "",
        };
      } else if (rc === 1 || rc === 2) {
        // 用户级错误 / 部分失败
        return {
          ...defaultAdapterInvokeResult(),
          kind: "retriable",
          output: `dispatcher 返回码 ${rc}`,
          summary: `任务执行失败（rc=${rc}，可重试）`,
        };
      } else {
        // 未知错误码
        return {
          ...defaultAdapterInvokeResult(),
          kind: "fatal",
          output: `dispatcher 返回码 ${rc}`,
          summary: `dispatcher 致命错误（rc=${rc}）`,
        };
      }
    } catch (err) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      const errorName = errObj.name;
      if (errorName === "ImportError" || errObj.message.includes("Cannot find module")) {
        return {
          ...defaultAdapterInvokeResult(),
          kind: "fatal",
          summary: `dispatcher 缺少依赖: ${errObj.message}`,
          error: errObj,
          errorTrace: errObj.stack ?? "",
        };
      }
      // 未知异常 → FATAL
      return {
        ...defaultAdapterInvokeResult(),
        kind: "fatal",
        summary: `dispatcher 异常: ${errObj.name}: ${errObj.message}`,
        error: errObj,
        errorTrace: errObj.stack ?? "",
      };
    }
  }

  /**
   * 使用预先构造的 args 调用 dispatcher
   */
  invokeWithArgs(taskArgs: DispatcherTaskArgs | any): AdapterInvokeResult {
    if (!this.isAvailable()) {
      return {
        ...defaultAdapterInvokeResult(),
        kind: "fatal",
        summary: "GoalDispatcher 不可用",
      };
    }
    const facade = this.getFacade();
    if (facade === null) {
      return {
        ...defaultAdapterInvokeResult(),
        kind: "fatal",
        summary: "无法导入 facade 模块",
      };
    }
    try {
      this.log("info", "[DispatcherAdapter] invokeWithArgs 调用");
      const rc = facade._dispatchThroughV3(taskArgs);
      if (rc === 0) {
        return {
          ...defaultAdapterInvokeResult(),
          success: true,
          kind: "success",
          output: `dispatcher 返回码 ${rc}`,
          summary: `任务执行成功（rc=${rc}）`,
        };
      }
      return {
        ...defaultAdapterInvokeResult(),
        kind: rc === 1 || rc === 2 ? "retriable" : "fatal",
        output: `dispatcher 返回码 ${rc}`,
        summary: `任务执行失败（rc=${rc}）`,
      };
    } catch (err) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      return {
        ...defaultAdapterInvokeResult(),
        kind: "fatal",
        summary: `dispatcher 异常: ${errObj.name}: ${errObj.message}`,
        error: errObj,
        errorTrace: errObj.stack ?? "",
      };
    }
  }

  // ========================================================================
  // 内部辅助
  // ========================================================================

  /**
   * 获取 facade 模块
   *
   * 注意：TypeScript 版本中 facade 由外部注入（避免循环依赖）。
   * 若未注入则返回 null，调用方会得到 FATAL 结果。
   */
  private getFacade(): FacadeLike | null {
    if (this.facade !== null) {
      return this.facade;
    }
    // TypeScript 中无 Python 动态导入；facade 必须在构造时注入
    // 若需要运行时动态加载，可在此处 import()
    return null;
  }
}
