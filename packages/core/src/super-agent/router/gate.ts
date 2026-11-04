/**
 * Super Agent 准入闸（Gate）—— 候选的第一层判断
 *
 * ## 定位
 *
 * Gate 是**纯确定性**的（零 LLM、毫秒级）。它的存在意义是：
 * **绝大多数环境事件根本不需要模型介入**——在模型被调用之前就滤掉。
 *
 * 这与 DSH 的两级过滤一致：确定性代码构成低延迟的 Fast Path，
 * 通过准入的候选才交给 LLM 做 Slow Path。
 *
 * @module super-agent/router/gate
 */

import { evaluateGate, findSourcePart, type GateOutcome } from "../policy/policy.js";
import type { EvalCandidate } from "../domain/types.js";
import type { EngineContext } from "../engine/engine.js";

/**
 * 对一个候选做准入判定
 *
 * @param ctx 引擎上下文
 * @param candidate 候选
 * @returns Gate 判定结果
 */
export function admitCandidate(ctx: EngineContext, candidate: EvalCandidate): GateOutcome {
  const trigger = candidate.triggers[candidate.triggers.length - 1];
  if (trigger === undefined) {
    return { admitted: false, reason: "候选批次为空", explicit: false };
  }

  const sourcePart = findSourcePart(candidate.policy, trigger.sourceId);
  return evaluateGate({
    trigger,
    sourcePart,
    policy: candidate.policy,
    existingTickets: candidate.existingTickets,
    scope: scopeOf(trigger.sourceId, trigger.meta),
  });
}

/**
 * 从事件元数据推导接收范围
 *
 * @param sourceId Source ID
 * @param meta 事件元数据
 * @returns 范围标识或 undefined
 */
function scopeOf(sourceId: string, meta: Readonly<Record<string, unknown>>): string | undefined {
  const scope = meta["scope"];
  if (typeof scope === "string" && scope.length > 0) return scope;
  return sourceId;
}

export type { GateOutcome };
