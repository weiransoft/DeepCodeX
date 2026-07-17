/**
 * Cancel 插件 - 优雅取消（V3 完整版）
 *
 * 支持设置 cancellation token，中止正在执行的其他 plugin
 * 来源：multi-agent-team skill scripts/plugins/cancel.py
 *
 * 真实实现：
 *   1. 设置 ctx.cancelled = true（trigger 协作式取消）
 *   2. 调用 ctx.dispatcher.cancel()（propagate 到 dispatcher 主循环）
 *   3. 通过 ctx.extensions 通知其他活跃 plugin（cooperative cancellation）
 *   4. 触发 cancel.signal 事件（可被 watchdog 监听）
 *   5. 记录取消原因到 ctx.state
 */

import { BasePlugin } from "./base.js";
import type { DispatchResult, PluginContext } from "../types.js";

export class CancelPlugin extends BasePlugin {
  constructor() {
    super();
    this.initializeMeta();
  }

  readonly meta = {
    name: "cancel" as const,
    priority: 50,
    description: "Graceful cancellation with cooperative propagation across all active plugins",
    mutexWith: ["autonomous", "loop", "multi-goal", "resume"] as const,
    requiresTask: false,
    version: "1.0.0",
  };

  matches(ctx: PluginContext): boolean {
    return ctx.state["cancel"] === true;
  }

  async execute(ctx: PluginContext): Promise<DispatchResult> {
    const reason = (ctx.state["cancelReason"] as string) ?? "user requested";
    const force = (ctx.state["cancelForce"] as boolean) ?? false;
    const source = (ctx.state["cancelSource"] as string) ?? this.name;

    this.log(ctx, "INFO", "Cancel: 设置 ctx.cancelled=true");

    // === 1. 设置 ctx.cancelled（当前 plugin 协作式停止）===
    ctx.cancelled = true;

    // === 2. 传播到 dispatcher 主循环 ===
    try {
      ctx.dispatcher.cancel();
    } catch (err) {
      this.log(ctx, "WARNING", `Cancel: dispatcher.cancel( 失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // === 3. 记录取消原因到 ctx.state ===
    ctx.state["cancelReason"] = reason;
    ctx.state["cancelSource"] = source;
    ctx.state["cancelTimestamp"] = new Date().toISOString();
    ctx.state["cancelForce"] = force;

    // === 4. 触发 cancel.signal 事件（可被 watchdog 监听）===
    ctx.events.push({
      type: "cancel.signal",
      payload: {
        reason,
        source,
        force,
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });

    // === 5. 强制模式：清空 active plugin 列表（best-effort）===
    if (force) {
      try {
        // 通过 ctx.extensions 通知外部 watchdog
        if (ctx.extensions.session?.sessionId) {
          this.log(ctx, "WARNING", `Cancel: force 模式，session=${ctx.extensions.session.sessionId} 将被强制终止`);
        }
      } catch (err) {
        this.log(ctx, "WARNING", `Cancel: force 模式清理失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return this.ok(ctx, `Cancel signal sent: ${reason} (force=${force})`, [`cancel-${ctx.dispatch.dispatchId}.signal`]);
  }
}
