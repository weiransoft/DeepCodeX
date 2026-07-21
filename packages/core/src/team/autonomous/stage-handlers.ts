/**
 * StageHandler 完整实现（v1.1 重写，对接 executeDispatch 真实 LLM 调用）
 *
 * 来源：multi-agent-team skill scripts/autonomous/stage_handlers.py
 * 严格遵循 user rules：禁止 mock/占位/简化；所有 stage handler 真实调用 executeDispatch
 * Karpathy 原则：Surgical Changes - 仅新增 stage-handlers.ts，不修改 StageHandler 接口
 *
 * 设计要点：
 *   1. BaseStageHandler 基类封装通用逻辑：task 构造、dispatch 调用、错误处理
 *   2. 4 个子类（Plan/Dev/Verify/Fix）只实现 buildDescription + judgeResult 两个抽象方法
 *   3. judgeResult 参数类型为 DispatchResult（v1.1 修正：替代 any，符合"禁止 any"规则）
 *   4. handle() 是 async，与 StageHandler 接口的 `StageResult | Promise<StageResult>` 兼容
 *   5. v1.5（H-02）：buildDescription 生成的 user prompt 必须以 `# Plan 阶段`/`# Dev 阶段`/
 *      `# Verify 阶段`/`# Fix 阶段` 标题开头，供 stub client 的 stage-aware 工厂
 *      基于 user prompt（messages[1].content）精确匹配推断 stage
 *   6. v1.6（I-12）：stage 标题大小写敏感，必须首字母大写（`# Plan 阶段` 而非 `# plan 阶段`）
 *      原因：JavaScript `String.prototype.includes` 大小写敏感，小写会匹配失败
 *   7. 透传 injectedClient（依赖注入，非 mock）：单元测试时通过此字段注入 stub client
 *      生产环境不传此字段，executeDispatch 内部会调用 createOpenAIClient 构造真实客户端
 */

import type { StageHandler, StageResult, IterationContext, LogCallback } from "./loop-controller.js";
// v1.2 修正（M-04）：DispatchResult 必须直接从 types.js 导入
//   team-adapter.ts 仅 `import type { DispatchResult, ... } from "./types.js"`，未 re-export
//   若从 team-adapter.js 导入 DispatchResult，会导致类型解析失败
import { executeDispatch, buildTask } from "../team-adapter.js";
import type { DispatchResult, RoleId } from "../types.js";
// v1.4 修正（G-04 / 架构师 NB-03）：OpenAIClientHandle 和 isOpenAIClientHandle
//   从 stage-handlers.ts 改放到 common/openai-client.ts，消除循环依赖
//   原因：v1.3 F-06 将类型守卫放在 stage-handlers.ts，但 team-adapter.ts → stage-handlers.ts → team-adapter.ts
//   形成循环依赖。common/openai-client.ts 已定义 createOpenAIClient，返回值结构正好对应
//   OpenAIClientHandle，类型守卫自然归属此文件，且 common/ 不依赖 team/，无循环依赖风险
import { type OpenAIClientHandle } from "../../common/openai-client.js";
// v1.6 修正：显式导入 StageKind 类型，供 createDefaultStageHandlers 返回值类型使用
import type { StageKind } from "./loop-controller.js";

/** 向后兼容别名（v1.2 stage-handlers 内部使用的旧名，与 OpenAIClientHandle 等价） */
type InjectedClientHandle = OpenAIClientHandle;

/**
 * BaseStageHandler 基类：封装通用逻辑（task 构造、dispatch 调用、错误处理）
 *
 * 子类只需实现：
 *   - buildDescription(ctx): 构造 stage 特定的描述文本（必须以 `# X 阶段` 开头）
 *   - judgeResult(result, ctx, tokens): 根据 DispatchResult 判定 StageResult
 *
 * 泛型参数：无（stageName 和 roleId 通过抽象 getter 暴露）
 */
abstract class BaseStageHandler implements StageHandler {
  /**
   * @param projectRoot 项目根目录
   * @param log 日志回调（位置参数风格，与 NotesMemory / SleepGuard 等组件一致）
   * @param injectedClient 注入的 OpenAI 客户端句柄（可选，用于单元测试，依赖注入非 mock）
   *                      生产环境不传，executeDispatch 内部会 createOpenAIClient
   */
  constructor(
    protected readonly projectRoot: string,
    protected readonly log: LogCallback = () => {},
    protected readonly injectedClient?: InjectedClientHandle
  ) {}

  /** 子类必须声明 stage 名称（plan/dev/verify/fix） */
  abstract readonly stageName: string;
  /** 子类必须声明对应的角色 ID（architect/solo-coder/test-expert） */
  abstract readonly roleId: RoleId;

  /**
   * 处理一次 stage 执行（async，对接 executeDispatch 的真实 LLM 调用）
   *
   * 流程：
   *   1. 构造 TaskRequirement（含 stage 上下文 + 最近 3 次迭代摘要）
   *   2. 调用 executeDispatch（forceRole 指定角色，透传 injectedClient）
   *   3. 提取 token 消耗并调用 judgeResult 判定结果
   *   4. 异常 → fatal（附 error message）
   *
   * @param ctx 迭代上下文（含 prevResults: IterationResult[]）
   * @returns StageResult（kind: success / failed / retriable / fatal）
   */
  async handle(ctx: IterationContext): Promise<StageResult> {
    // 构造 TaskRequirement：title 含 stage 名 + iter 编号，description 由子类生成
    const task = buildTask({
      title: `[${this.stageName}] iter-${ctx.iterIndex}`,
      description: this.buildDescription(ctx),
      upstreamContext: {
        autonomousStage: this.stageName,
        autonomousIteration: ctx.iterIndex,
        autonomousGoal: ctx.objective,
        // v1.1 修正：prevResults 是 IterationResult[]，summary 形如 "iter-1 全阶段完成"
        // 传递最近 3 次的 summary 作为上下文，让 LLM 了解历史
        recentIterationSummaries: ctx.prevResults.slice(-3).map((r) => r.summary),
      },
    });

    try {
      // 调用 executeDispatch（真实 LLM 调用，由 team-adapter.ts 阶段 3 实现）
      // 透传 injectedClient：测试场景注入 stub client，生产场景为 undefined（内部 createOpenAIClient）
      const result = await executeDispatch(task, {
        projectRoot: this.projectRoot,
        forceRole: { roleId: this.roleId, reason: `Autonomous ${this.stageName} stage` },
        injectedClient: this.injectedClient,
      });

      // 提取本次消耗的 token 数（executeDispatch 返回 tokensConsumed.total）
      const tokens = result.tokensConsumed.total;
      return this.judgeResult(result, ctx, tokens);
    } catch (err) {
      // 未捕获异常 → fatal（含错误信息，便于诊断）
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log("error", `[${this.stageName}] 未捕获异常: ${errMsg}`);
      return {
        kind: "fatal",
        summary: `[${this.stageName}] 未捕获异常: ${errMsg}`,
        artifacts: { tokens: 0 },
        error: errMsg,
      };
    }
  }

  /**
   * 子类实现：构造 stage 特定的描述文本
   *
   * v1.5（H-02）约束：返回值必须以 `# X 阶段` 标题开头（X 首字母大写）
   *   - PlanStageHandler 返回值以 `# Plan 阶段` 开头
   *   - DevStageHandler 返回值以 `# Dev 阶段` 开头
   *   - VerifyStageHandler 返回值以 `# Verify 阶段` 开头
   *   - FixStageHandler 返回值以 `# Fix 阶段` 开头
   *   原因：stub client 基于 messages[1].content（user prompt）的子串匹配推断 stage
   *   详见 §7.4 buildStubClientReturningValidOutput 的 stage-aware 工厂设计
   */
  protected abstract buildDescription(ctx: IterationContext): string;

  /**
   * 子类实现：根据 dispatch 结果判定 StageResult
   *
   * v1.1 修正：参数类型从 any 改为 DispatchResult，符合用户规则"禁止 any"
   *
   * @param result executeDispatch 的返回值
   * @param ctx 迭代上下文
   * @param tokens 本次消耗的 token 数
   * @returns StageResult
   */
  protected abstract judgeResult(result: DispatchResult, ctx: IterationContext, tokens: number): StageResult;
}

/**
 * Plan 阶段处理器：调用 architect 角色生成方案
 *
 * 判定逻辑：
 *   - succeeded + output 含 "## Plan" → success
 *   - succeeded + output 不含 "## Plan" → failed（LLM 未按格式输出）
 *   - failed → retriable（可重试）
 *   - skipped → fatal（无 API Key 等不可恢复）
 *   - 其他 → fatal
 */
export class PlanStageHandler extends BaseStageHandler {
  readonly stageName = "plan";
  readonly roleId: RoleId = "architect";

  constructor(projectRoot: string, log: LogCallback = () => {}, injectedClient?: InjectedClientHandle) {
    super(projectRoot, log, injectedClient);
  }

  /**
   * 构造 Plan 阶段的描述文本
   * 包含目标、历史笔记、历史迭代摘要，供 architect 角色生成方案
   */
  protected buildDescription(ctx: IterationContext): string {
    return [
      `# Plan 阶段（迭代 ${ctx.iterIndex}）`,
      ``,
      `## 目标`,
      ctx.objective,
      ``,
      `## 历史笔记`,
      ctx.notesSnapshot || "（首次迭代，无历史笔记）",
      ``,
      `## 历史迭代摘要`,
      ctx.prevResults.length > 0
        ? ctx.prevResults
            .slice(-3)
            .map((r, i) => `${i + 1}. ${r.summary}`)
            .join("\n")
        : "（首次迭代，无历史）",
    ].join("\n");
  }

  /**
   * 判定 Plan 阶段结果
   * 成功条件：succeeded + output 含 "## Plan" 标题（architect 输出格式约定）
   */
  protected judgeResult(result: DispatchResult, ctx: IterationContext, tokens: number): StageResult {
    if (result.status === "succeeded") {
      // 检查 output 是否含 "## Plan" 标题（architect 输出格式约定）
      if (result.output && result.output.includes("## Plan")) {
        return {
          kind: "success",
          summary: `[plan] 生成方案（${result.output.length} 字符）`,
          artifacts: { tokens, plan: result.output },
        };
      }
      // output 不符合格式 → failed（非 fatal，可重新生成）
      return {
        kind: "failed",
        summary: "[plan] LLM 未生成有效方案（缺少 ## Plan 标题）",
        artifacts: { tokens },
        error: "Invalid plan output",
      };
    }
    if (result.status === "failed") {
      // LLM 调用失败 → retriable（可重试）
      return {
        kind: "retriable",
        summary: `[plan] architect 调用失败: ${result.error ?? "未知错误"}`,
        artifacts: { tokens },
        error: result.error,
      };
    }
    // v1.1 新增：处理 skipped 状态（无 API Key 等不可恢复情况）→ fatal
    if (result.status === "skipped") {
      return {
        kind: "fatal",
        summary: `[plan] dispatch 被跳过: ${result.error ?? "未知原因"}`,
        artifacts: { tokens },
        error: result.error,
      };
    }
    // 其他未知状态 → fatal
    return {
      kind: "fatal",
      summary: `[plan] 未知状态: ${result.status}`,
      artifacts: { tokens },
      error: result.error,
    };
  }
}

/**
 * Dev 阶段处理器：调用 solo-coder 角色生成代码
 *
 * 判定逻辑：
 *   - succeeded + output 非空 → success
 *   - succeeded + output 空 → failed
 *   - skipped → fatal（无 API Key）
 *   - failed / 其他 → retriable
 */
export class DevStageHandler extends BaseStageHandler {
  readonly stageName = "dev";
  readonly roleId: RoleId = "solo-coder";

  constructor(projectRoot: string, log: LogCallback = () => {}, injectedClient?: InjectedClientHandle) {
    super(projectRoot, log, injectedClient);
  }

  /**
   * 构造 Dev 阶段的描述文本
   * 包含上游方案（来自 PlanStageHandler 的 artifacts.plan 或 ctx.currentPlan）和目标
   *
   * v1.1 修正：prevResults 是 IterationResult[]，不是 stage 结果
   *   IterationResult 没有 artifacts 字段，只有 agentOutput
   *   plan 信息在 ctx.currentPlan 或上次迭代的 agentOutput 中
   */
  protected buildDescription(ctx: IterationContext): string {
    const lastIter = ctx.prevResults[ctx.prevResults.length - 1];
    const plan = ctx.currentPlan || lastIter?.agentOutput || "";

    return [
      `# Dev 阶段（迭代 ${ctx.iterIndex}）`,
      ``,
      `## 上游方案`,
      plan || "（无上游 plan，按 objective 直接实现）",
      ``,
      `## 目标`,
      ctx.objective,
    ].join("\n");
  }

  /**
   * 判定 Dev 阶段结果
   * 成功条件：succeeded + output 非空（trim 后长度 > 0）
   */
  protected judgeResult(result: DispatchResult, ctx: IterationContext, tokens: number): StageResult {
    if (result.status === "succeeded") {
      if (result.output && result.output.trim().length > 0) {
        return {
          kind: "success",
          summary: `[dev] 生成代码（${result.output.length} 字符）`,
          artifacts: { tokens, code: result.output },
        };
      }
      // output 为空 → failed（可重新生成）
      return {
        kind: "failed",
        summary: "[dev] solo-coder 未生成代码",
        artifacts: { tokens },
        error: "Empty dev output",
      };
    }
    // skipped → fatal（无 API Key）
    if (result.status === "skipped") {
      return {
        kind: "fatal",
        summary: `[dev] dispatch 被跳过: ${result.error ?? "未知原因"}`,
        artifacts: { tokens },
        error: result.error,
      };
    }
    // 其他失败 → retriable
    return {
      kind: "retriable",
      summary: `[dev] solo-coder 调用失败: ${result.error ?? "未知错误"}`,
      artifacts: { tokens },
      error: result.error,
    };
  }
}

/**
 * Verify 阶段处理器：调用 test-expert 角色运行测试
 *
 * 判定逻辑：
 *   - succeeded + output 含 "PASS"/"通过" → success
 *   - succeeded + output 含 "FAIL"/"失败" → retriable（需 fix）
 *   - succeeded + output 无上述关键词 → failed（输出无法解析）
 *   - skipped → fatal
 *   - 其他 → fatal
 *
 * 构造函数额外接收 testCommand 参数（默认 "npm test"），写入 description 供 test-expert 执行
 */
export class VerifyStageHandler extends BaseStageHandler {
  readonly stageName = "verify";
  readonly roleId: RoleId = "test-expert";

  /**
   * @param projectRoot 项目根目录
   * @param log 日志回调
   * @param testCommand 测试命令（默认 "npm test"，写入 description 供 test-expert 执行）
   * @param injectedClient 注入的 OpenAI 客户端句柄（可选，用于测试）
   */
  constructor(
    projectRoot: string,
    log: LogCallback = () => {},
    private readonly testCommand: string = "npm test",
    injectedClient?: InjectedClientHandle
  ) {
    super(projectRoot, log, injectedClient);
  }

  /**
   * 构造 Verify 阶段的描述文本
   * 包含目标、测试命令、上次迭代输出
   */
  protected buildDescription(ctx: IterationContext): string {
    return [
      `# Verify 阶段（迭代 ${ctx.iterIndex}）`,
      ``,
      `## 目标`,
      ctx.objective,
      ``,
      `## 测试命令`,
      `\`${this.testCommand}\``,
      ``,
      `## 上次迭代输出`,
      ctx.prevResults[ctx.prevResults.length - 1]?.agentOutput || "（无）",
    ].join("\n");
  }

  /**
   * 判定 Verify 阶段结果
   * 解析测试输出，识别 PASS/通过 或 FAIL/失败 关键词
   */
  protected judgeResult(result: DispatchResult, ctx: IterationContext, tokens: number): StageResult {
    if (result.status === "succeeded") {
      const output = result.output ?? "";
      // 测试通过：output 含 "PASS" 或 "通过"
      if (output.includes("PASS") || output.includes("通过")) {
        return {
          kind: "success",
          summary: `[verify] 测试通过`,
          artifacts: { tokens, verifyResult: output },
        };
      }
      // 测试失败：output 含 "FAIL" 或 "失败" → retriable（需 fix 阶段介入）
      if (output.includes("FAIL") || output.includes("失败")) {
        return {
          kind: "retriable",
          summary: `[verify] 测试失败，需要 fix`,
          artifacts: {
            tokens,
            verifyResult: output,
            // 提取失败用例行（最多 10 条），供 Fix 阶段参考
            failures: this.extractFailures(output),
          },
          error: "Tests failed",
        };
      }
      // 输出无法解析 → failed
      return {
        kind: "failed",
        summary: "[verify] 测试输出无法解析",
        artifacts: { tokens },
        error: "Unparseable test output",
      };
    }
    // skipped → fatal
    if (result.status === "skipped") {
      return {
        kind: "fatal",
        summary: `[verify] dispatch 被跳过: ${result.error ?? "未知原因"}`,
        artifacts: { tokens },
        error: result.error,
      };
    }
    // 其他失败 → fatal（test-expert 异常不应重试，需人工介入）
    return {
      kind: "fatal",
      summary: `[verify] test-expert 调用失败: ${result.error ?? "未知"}`,
      artifacts: { tokens },
      error: result.error,
    };
  }

  /**
   * 从测试输出中提取失败用例
   *
   * @param output 测试输出文本
   * @returns 失败用例行数组（最多 10 条，避免输出过长）
   */
  private extractFailures(output: string): string[] {
    const lines = output.split("\n");
    return lines.filter((l) => l.includes("FAIL") || l.includes("失败")).slice(0, 10);
  }
}

/**
 * Fix 阶段处理器：调用 solo-coder 角色基于 verify 失败原因修复
 *
 * 判定逻辑：
 *   - succeeded + output 非空 → success
 *   - succeeded + output 空 → failed
 *   - skipped → fatal
 *   - 其他 → retriable
 *
 * 构造 description 时从 prevResults 中查找最近一次 verify 失败的 agentOutput
 */
export class FixStageHandler extends BaseStageHandler {
  readonly stageName = "fix";
  readonly roleId: RoleId = "solo-coder";

  constructor(projectRoot: string, log: LogCallback = () => {}, injectedClient?: InjectedClientHandle) {
    super(projectRoot, log, injectedClient);
  }

  /**
   * 构造 Fix 阶段的描述文本
   *
   * v1.1 修正：从 IterationContext.prevResults（IterationResult[]）中
   *   找最近一次 verify 失败的 agentOutput
   *   IterationResult 不含 stage 标识，需通过 summary 中是否含 "verify" 或 "测试" 判断
   */
  protected buildDescription(ctx: IterationContext): string {
    // 逆序查找最近的 verify 迭代结果
    const verifyResult = [...ctx.prevResults]
      .reverse()
      .find((r) => r.summary.includes("verify") || r.summary.includes("测试"));
    // 提取失败原因（IterationResult.error 是 Error | null，需 String 化）
    const failures = verifyResult?.error ? [String(verifyResult.error)] : [];

    return [
      `# Fix 阶段（迭代 ${ctx.iterIndex}）`,
      ``,
      `## 目标`,
      ctx.objective,
      ``,
      `## 失败原因`,
      failures.length > 0 ? failures.join("\n") : "（无具体失败信息，按 objective 重新实现）",
      ``,
      `## 上次迭代输出`,
      verifyResult?.agentOutput || "（无）",
    ].join("\n");
  }

  /**
   * 判定 Fix 阶段结果
   * 成功条件：succeeded + output 非空
   */
  protected judgeResult(result: DispatchResult, ctx: IterationContext, tokens: number): StageResult {
    if (result.status === "succeeded") {
      if (result.output && result.output.trim().length > 0) {
        return {
          kind: "success",
          summary: `[fix] 修复完成（${result.output.length} 字符）`,
          artifacts: { tokens, fix: result.output },
        };
      }
      // output 为空 → failed
      return {
        kind: "failed",
        summary: "[fix] solo-coder 未生成修复",
        artifacts: { tokens },
        error: "Empty fix output",
      };
    }
    // skipped → fatal
    if (result.status === "skipped") {
      return {
        kind: "fatal",
        summary: `[fix] dispatch 被跳过: ${result.error ?? "未知原因"}`,
        artifacts: { tokens },
        error: result.error,
      };
    }
    // 其他失败 → retriable
    return {
      kind: "retriable",
      summary: `[fix] solo-coder 调用失败: ${result.error ?? "未知"}`,
      artifacts: { tokens },
      error: result.error,
    };
  }
}

/**
 * 工厂函数：构造 4 个 StageHandler
 *
 * 统一使用位置参数风格（与 NotesMemory / SleepGuard 等组件一致）
 *
 * @param opts.projectRoot 项目根目录
 * @param opts.testCommand 测试命令（默认 "npm test"，仅 VerifyStageHandler 使用）
 * @param opts.log 日志回调
 * @param opts.injectedClient 注入的 OpenAI 客户端（可选，用于测试场景的依赖注入）
 * @returns 4 个 StageHandler 实例（plan/dev/verify/fix）
 */
export function createDefaultStageHandlers(opts: {
  projectRoot: string;
  testCommand?: string;
  log?: LogCallback;
  injectedClient?: InjectedClientHandle;
}): Record<StageKind, StageHandler> {
  const log = opts.log ?? (() => {});
  const testCmd = opts.testCommand ?? "npm test";
  return {
    plan: new PlanStageHandler(opts.projectRoot, log, opts.injectedClient),
    dev: new DevStageHandler(opts.projectRoot, log, opts.injectedClient),
    verify: new VerifyStageHandler(opts.projectRoot, log, testCmd, opts.injectedClient),
    fix: new FixStageHandler(opts.projectRoot, log, opts.injectedClient),
  };
}
