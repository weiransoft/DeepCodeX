/**
 * Loop 编排插件（V3 完整版）
 *
 * 支持循环执行（loop-until-done 模式）
 * 来源：multi-agent-team skill scripts/plugins/loop.py + loop_engineering.py
 *
 * 真实能力：
 *   1. 真实循环执行（不模拟）
 *   2. 退出条件评估（基于上次结果或自定义 predicate）
 *   3. 最大迭代次数限制
 *   4. 退避策略（指数退避）
 *   5. 进度上报 + ctx 取消响应
 *   6. step 回调从 ctx.state 注入
 */

import { BasePlugin } from "./base.js";
import type { DispatchResult, PluginContext } from "../types.js";

/** Loop step 签名 */
export type LoopStep = (iteration: number, lastResult: unknown) => Promise<unknown> | unknown;

/** 退出条件签名 */
export type ExitPredicate = (iteration: number, lastResult: unknown) => boolean | Promise<boolean>;

export class LoopPlugin extends BasePlugin {
  constructor() {
    super();
    this.initializeMeta();
  }

  readonly meta = {
    name: "loop" as const,
    priority: 100,
    description: "Loop execution with exit predicate, backoff, and cancel awareness",
    mutexWith: ["autonomous", "cancel", "multi-goal"] as const,
    requiresTask: false,
    version: "1.0.0",
  };

  matches(ctx: PluginContext): boolean {
    // 匹配：ctx.state.loop === true
    return ctx.state["loop"] === true || typeof ctx.state["loopStep"] === "function";
  }

  async execute(ctx: PluginContext): Promise<DispatchResult> {
    const maxIterations = (ctx.state["loopMaxIterations"] as number) ?? 10;
    const exitWhen = (ctx.state["loopExitWhen"] as string) ?? "done";
    const backoffBase = (ctx.state["loopBackoffBase"] as number) ?? 0;
    const backoffMax = (ctx.state["loopBackoffMax"] as number) ?? 0;
    const stepFn = ctx.state["loopStep"] as LoopStep | undefined;

    if (!stepFn) {
      this.log(ctx, "WARNING", "Loop: 未提供 step 函数，立即返回（不循环）");
      return this.ok(ctx, "Loop: 无 step 函数，未执行", []);
    }

    this.log(
      ctx,
      "INFO",
      `Loop: max=${maxIterations} iterations, exitWhen="${exitWhen}", backoff=${backoffBase}~${backoffMax}s`
    );

    const history: Array<{ iteration: number; result: unknown; durationMs: number }> = [];
    let i = 0;
    let lastResult: unknown = null;
    let exitReason: "max-iterations" | "predicate" | "cancelled" | "no-step" = "no-step";

    while (i < maxIterations) {
      // === 取消检查 ===
      if (ctx.cancelled) {
        this.log(ctx, "WARNING", `Loop: 第 ${i + 1} 次迭代前取消`);
        exitReason = "cancelled";
        break;
      }

      i++;
      this.progress(ctx, Math.round((i / maxIterations) * 100), `iteration ${i}/${maxIterations}`);

      const iterStart = Date.now();
      try {
        lastResult = stepFn ? await stepFn(i, lastResult) : null;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.log(ctx, "ERROR", `Loop: iteration ${i} 异常: ${errorMsg}`);
        return this.fail(ctx, `Loop: iteration ${i} 异常: ${errorMsg}`);
      }
      const iterDuration = Date.now() - iterStart;

      history.push({ iteration: i, result: lastResult, durationMs: iterDuration });
      this.log(ctx, "INFO", `Loop iteration ${i}: ${formatValue(lastResult)} (${iterDuration}ms)`);

      // === 退出条件评估 ===
      if (await evaluateExit(exitWhen, lastResult, i, history)) {
        exitReason = "predicate";
        this.log(ctx, "INFO", `Loop: 退出条件命中 (${exitWhen} @ iteration ${i}`);
        break;
      }

      // === 退避 ===
      if (backoffBase > 0 && i < maxIterations) {
        const delaySec = Math.min(backoffBase * Math.pow(2, i - 1), backoffMax);
        this.log(ctx, "DEBUG", `Loop: 退避 ${delaySec}s`);
        await sleep(delaySec * 1000);
      }
    }

    if (exitReason === "no-step" && i >= maxIterations) {
      exitReason = "max-iterations";
    }

    // === 持久化 history 到 ctx.state ===
    ctx.state["loopHistory"] = history;
    ctx.state["loopExitReason"] = exitReason;

    const summary = `Loop: ${i} iterations, exit=${exitReason}, last=${formatValue(lastResult)}`;
    return this.ok(ctx, summary, [`loop-${ctx.dispatch.dispatchId}-history.json`]);
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 评估退出条件
 *
 * 支持的 exitWhen 值：
 *   - "done" / "finish" / "complete"：当 lastResult === "done" / "finish" / "complete" 或 true
 *   - "never" / ""：永不退出（仅靠 maxIterations）
 *   - 其他字符串：lastResult === exitWhen
 */
async function evaluateExit(
  exitWhen: string,
  lastResult: unknown,
  iteration: number,
  history: ReadonlyArray<{ iteration: number; result: unknown }>
): Promise<boolean> {
  if (!exitWhen || exitWhen === "never") return false;

  // 特殊值
  if (exitWhen === "done" || exitWhen === "finish" || exitWhen === "complete") {
    return lastResult === "done" || lastResult === "finish" || lastResult === "complete" || lastResult === true;
  }

  // 自定义字符串匹配
  if (typeof lastResult === "string" && lastResult === exitWhen) return true;
  if (lastResult === exitWhen) return true;

  // 数字比较：lastResult >= exitWhen
  if (typeof lastResult === "number" && !isNaN(Number(exitWhen))) {
    return lastResult >= Number(exitWhen);
  }

  // history 长度判断："after:N"
  const afterMatch = /^after:(\d+)$/.exec(exitWhen);
  if (afterMatch) {
    return iteration >= parseInt(afterMatch[1]!, 10);
  }

  // v2.0 安全修复：移除 fn: 表达式分支（RCE 风险）
  // 原实现使用 new Function() 动态求值，存在远程代码执行风险。
  // 复杂退出条件请通过 eag/graph/PredicateRegistry 注册谓词函数实现。
  // 未匹配任何预定义条件时默认不退出（返回 false）

  return false;
}

/**
 * 格式化 lastResult 为可读字符串
 */
function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return `"${v}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Sleep 工具
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
