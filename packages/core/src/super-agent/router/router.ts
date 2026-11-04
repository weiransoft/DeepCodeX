/**
 * Super Agent 路由器（Router）—— 决策的编排者
 *
 * ## 职责边界（避免出现两个调度器）
 *
 * | 层 | 做什么 | 不做什么 |
 * |---|---|---|
 * | **Router（本模块）** | 准入 → 研判 → **批量决策** | 不做目标拆解、不做分层调度 |
 * | `team/orchestrator` | 拆解 → 分层 → 执行 → 聚合 | 不管准入与授权 |
 *
 * 首期不引入第三套拓扑排序（既有 `team/orchestrator/plan-graph.ts:324`
 * 与 `team/plugins/goal-dispatcher.ts:183` 已有两套）。
 *
 * ## 与既有 `team/` 编排的关系
 *
 * Router 产出的是**被授权的工作单元（Ticket）**；
 * Ticket 内部若需要多角色拆解，由既有 L2 编排承担——Super Agent 不重复实现。
 *
 * @module super-agent/router/router
 */

import type { DecisionInput, DecisionResult, SuperAgentEngine } from "../engine/engine.js";
import type { EvalCandidate } from "../domain/types.js";
import type { WorkflowPlanner } from "../planner/planner.js";
import { loadPolicy } from "../policy/policy.js";
import { admitCandidate } from "./gate.js";
import type { Assessor } from "../engine/engine.js";

/** Router 构造选项 */
export interface SuperAgentRouterOptions {
  /** 引擎 */
  readonly engine: SuperAgentEngine;
  /** 研判器（null = 无研判能力） */
  readonly assessor: Assessor | null;
  /**
   * 计划器（null = 不做动态分解，按单角色执行）
   *
   * 计划只对 `accept` 生效，且生成失败**不影响接单**——
   * 计划是「怎么做」的增强，不是「要不要做」的前提。
   */
  readonly planner?: WorkflowPlanner | null;
}

/**
 * SuperAgentRouter —— 候选处理与决策编排
 */
export class SuperAgentRouter {
  /** 引擎 */
  private readonly engine: SuperAgentEngine;
  /** 研判器 */
  private readonly assessor: Assessor | null;
  /** 计划器 */
  private readonly planner: WorkflowPlanner | null;

  /**
   * 构造 Router
   *
   * @param options 构造选项
   */
  constructor(options: SuperAgentRouterOptions) {
    this.engine = options.engine;
    this.assessor = options.assessor;
    this.planner = options.planner ?? null;
  }

  /**
   * 处理当前所有待研判的候选
   *
   * @returns 决策结果列表
   */
  async processCandidates(): Promise<DecisionResult[]> {
    const candidates = this.engine.router.listCandidates();
    if (candidates.length === 0) return [];

    const decisions: DecisionInput[] = [];
    for (const candidate of candidates) {
      const decision = await this.buildDecision(candidate);
      if (decision !== null) decisions.push(decision);
    }
    if (decisions.length === 0) return [];

    // 一次批量提交——逐项独立，单项失败不阻断（I4）
    return this.engine.router.decide(decisions);
  }

  /**
   * 为一个候选构建决策输入
   *
   * @param candidate 候选
   * @returns 决策输入；null 表示本轮无需决策
   */
  private async buildDecision(candidate: EvalCandidate): Promise<DecisionInput | null> {
    const triggerIds = candidate.triggers.map((trigger) => trigger.id);
    const latestTrigger = candidate.triggers[candidate.triggers.length - 1];

    // 第一层：Gate（确定性）
    const gate = admitCandidate(this.engine.context, candidate);
    if (!gate.admitted) {
      return {
        threadId: candidate.threadId,
        kind: "ignore",
        reason: `未准入：${gate.reason}`,
        strength: gate.strength,
        triggerIds,
      };
    }

    // 第二层：Assessment（LLM）
    if (this.assessor === null) {
      // 没有研判能力 → 记 unavailable，**不编造结论**
      return {
        threadId: candidate.threadId,
        kind: "unavailable",
        reason: "未配置研判器（Assessor），本轮无法完成判断。",
        strength: gate.strength,
        triggerIds,
      };
    }

    const assessment = await this.assessor.assess(candidate);
    if (assessment === null) {
      return {
        threadId: candidate.threadId,
        kind: "unavailable",
        reason: "研判失败（模型不可用或输出无法解析），本轮未完成判断。",
        strength: gate.strength,
        triggerIds,
      };
    }

    const scope = latestTrigger?.text.slice(0, 200) ?? "";
    // 动态分解：只在「确定会真的接单」时做——
    // observe 模式下的推断候选只记影子，不建工单，也就不该消耗一次规划调用。
    const policy = loadPolicy((key) => this.engine.context.repos.getKv(key));
    const willAccept = gate.strength === "explicit" || policy.acceptMode === "auto";
    const plan =
      assessment.kind === "accept" && this.planner !== null && willAccept
        ? await this.safePlan(candidate.threadId, ticketNameOf(scope), scope)
        : undefined;

    return {
      threadId: candidate.threadId,
      kind: assessment.kind,
      reason: assessment.reason.length > 0 ? assessment.reason : "（研判未给出理由）",
      strength: gate.strength ?? "inferred",
      matchedRules: assessment.matchedRules,
      scope,
      actor: latestTrigger?.actor,
      sourceId: latestTrigger?.sourceId,
      triggerIds,
      plan,
    };
  }

  /**
   * 安全地生成计划
   *
   * 规划器自身的契约是「必定返回计划（失败即降级）」，但这里仍然兜底：
   * 规划异常绝不能让**接单**失败——计划可以没有，工单不能没有。
   *
   * @param threadId Thread ID（作为工单 ID 的占位）
   * @param ticketName 工单名称
   * @param scope 授权范围
   * @returns 计划；异常时 undefined
   */
  private async safePlan(
    threadId: string,
    ticketName: string,
    scope: string
  ): Promise<DecisionInput["plan"] | undefined> {
    try {
      return await (this.planner as WorkflowPlanner).plan({ ticketId: threadId, ticketName, scope });
    } catch {
      return undefined;
    }
  }
}

/**
 * 从请求文本推导工单名称（与 `evals.ts` 的命名口径一致）
 *
 * @param text 请求文本
 * @returns 名称（首行，超长截断）
 */
function ticketNameOf(text: string): string {
  const firstLine = text.split("\n")[0] ?? text;
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}
