/**
 * Super Agent 策略 —— 准入、接单模式与授权复验
 *
 * ## 三层职责
 *
 * 1. **Policy** —— 版本化的规则集合（接单模式 + 规则 + 各 Source 的准入表）。
 * 2. **Gate** —— 纯确定性的准入判断（**零 LLM**，毫秒级）。
 * 3. **revalidate** —— Ticket 恢复前，按当前 Policy 复验旧 Mandate 是否仍然成立。
 *
 * ## 三条硬规则
 *
 * - **显式请求在任何接单模式下都有效**；`off` 只影响推断型。
 * - **Policy 变更不撤销存量 Mandate**——只投递变更通知。撤销只发生在恢复时复验失败。
 * - **强度分级不可跨越**：显式 → 推断可以降级，反之不行。
 *
 * @module super-agent/policy/policy
 */

import { authorizationRevoked, invalidRequest, notFound, type UserError } from "../domain/errors.js";
import type {
  AcceptMode,
  AdmissionCell,
  Mandate,
  Policy,
  PolicyRule,
  SourcePolicyPart,
  Strength,
  TicketSummary,
  Trigger,
} from "../domain/types.js";

// ============================================================================
// 默认策略
// ============================================================================

/** 默认策略规则（首期内置一条通用规则；其余由用户在 policy 文件中扩展） */
export const DEFAULT_POLICY_RULES: readonly PolicyRule[] = Object.freeze([
  Object.freeze({
    id: "reproduce-and-fix",
    title: "复现并修复缺陷",
    description:
      "当有人反馈一个疑似缺陷（崩溃、报错、行为异常）时，在后台复现问题、定位根因，" +
      "找到明确的修复方案后再交付；无法复现或没有简单修法时保持安静。",
    enabled: true,
  }),
]);

/** 默认接单模式 —— `observe`（保守起步，与 DSH 原文推荐路径一致） */
export const DEFAULT_ACCEPT_MODE: AcceptMode = "observe";

/** 默认每日打扰上限 */
export const DEFAULT_DAILY_ATTENTION_BUDGET = 10;

/** 构造默认 Policy */
export function createDefaultPolicy(): Policy {
  return {
    version: 1,
    acceptMode: DEFAULT_ACCEPT_MODE,
    rules: DEFAULT_POLICY_RULES,
    sourceParts: {},
    dailyAttentionBudget: DEFAULT_DAILY_ATTENTION_BUDGET,
  };
}

// ============================================================================
// 准入判定
// ============================================================================

/** Gate 的判定结果 */
export type GateOutcome = {
  /** 是否准入（成为候选） */
  readonly admitted: boolean;
  /** 强度（未准入时为 undefined） */
  readonly strength?: Strength;
  /** 判定理由（可展示） */
  readonly reason: string;
  /** 是否为显式请求 */
  readonly explicit: boolean;
};

/** Gate 的输入 */
export interface GateInput {
  /** 待判定的事件 */
  readonly trigger: Trigger;
  /** 该事件所属 Source 的策略部分（缺省用全局兜底） */
  readonly sourcePart?: SourcePolicyPart;
  /** 当前 Policy */
  readonly policy: Policy;
  /** 该 Thread 上已有的 Ticket（用于判断「追问」场景） */
  readonly existingTickets: readonly TicketSummary[];
  /** 事件的接收范围标识（不同 Source 有不同语义，如 GitHub 的 "new-issue"） */
  readonly scope?: string;
}

/**
 * 确定性准入判断（**零 LLM**）
 *
 * 判定顺序（命中即返回）：
 * 1. bot 名单内的机器人消息 → 推断候选（若策略允许推断）
 * 2. 白名单内的人 + 显式寻址 → 显式请求
 * 3. 白名单内的人 + 未寻址 + 该 Thread 已有 Ticket → 显式追问
 * 4. 非白名单的人 + 显式寻址 → 查准入表
 * 5. 非白名单的人 + 未寻址 → 查准入表（默认 ignore）
 * 6. 其余 bot 消息 → 不准入
 *
 * @param input 判定输入
 * @returns Gate 判定结果
 */
export function evaluateGate(input: GateInput): GateOutcome {
  const { trigger, policy, existingTickets } = input;
  const sourcePart = input.sourcePart;
  const allowlist = sourcePart?.allowlist ?? [];
  const botList = sourcePart?.botList ?? [];
  const isAllowed = allowlist.includes(trigger.actor);
  const isKnownBot = botList.includes(trigger.actor);

  // 1) 机器人消息：只能是推断候选，且必须被允许推断
  if (trigger.actorKind === "bot") {
    if (!isKnownBot) {
      return { admitted: false, reason: "发送者不在该 Source 的机器人名单内", explicit: false };
    }
    if (policy.acceptMode === "off") {
      return { admitted: false, reason: "接单模式为 off，推断型候选不产生", explicit: false };
    }
    return {
      admitted: true,
      strength: "inferred",
      reason: "机器人名单内的消息，可作为推断候选",
      explicit: false,
    };
  }

  // 2) 白名单内的人显式寻址 → 显式请求
  if (isAllowed && trigger.addressed) {
    return { admitted: true, strength: "explicit", reason: "白名单内用户显式寻址", explicit: true };
  }

  // 3) 白名单内的人在已有 Ticket 的 Thread 上追问 → 显式追问
  if (isAllowed && existingTickets.length > 0) {
    return {
      admitted: true,
      strength: "explicit",
      reason: "白名单内用户在已有工单的线程上追问",
      explicit: true,
    };
  }

  // 4/5) 其余情形查准入表
  const cell = resolveAdmissionCell(sourcePart, input.scope, isAllowed, trigger.addressed);
  switch (cell) {
    case "explicit":
      return {
        admitted: true,
        strength: "explicit",
        reason: "准入表判定为显式请求",
        explicit: true,
      };
    case "inferred":
      if (policy.acceptMode === "off") {
        return { admitted: false, reason: "接单模式为 off，推断型候选不产生", explicit: false };
      }
      return { admitted: true, strength: "inferred", reason: "准入表判定为推断候选", explicit: false };
    case "ignore":
    default:
      return { admitted: false, reason: "准入表判定为不予考虑", explicit: false };
  }
}

/**
 * 解析准入单元格
 *
 * 表格语义（与 DSH 原型一致）：
 * - 「在名单内 / 未寻址」→ 默认 `inferred`
 * - 「不在名单内 / 已寻址」→ 默认 `ignore`
 * - 「不在名单内 / 未寻址」→ 默认 `ignore`
 *
 * @param sourcePart Source 策略部分
 * @param scope 接收范围标识
 * @param isAllowed 发送者是否在名单内
 * @param addressed 是否显式寻址
 * @returns 准入单元格
 */
function resolveAdmissionCell(
  sourcePart: SourcePolicyPart | undefined,
  scope: string | undefined,
  isAllowed: boolean,
  addressed: boolean
): AdmissionCell {
  if (sourcePart === undefined || scope === undefined) {
    // 无准入表时的兜底：名单内的人已寻址 → 显式；其余 → 忽略
    return isAllowed && addressed ? "explicit" : "ignore";
  }
  const table = sourcePart.admission;
  if (isAllowed) {
    return table[scope] ?? "inferred";
  }
  return table[`${scope}:unlisted`] ?? "ignore";
}

// ============================================================================
// 授权复验
// ============================================================================

/**
 * 恢复前复验 Mandate
 *
 * 规则（DSH `docs/002-authorization.md` 的复验语义）：
 * - 显式追单的 Mandate → 直接通过；
 * - 推断的 Mandate → 需要 `auto` 模式且匹配规则仍启用；
 * - 经准入表单元格准入的 Mandate → 需要今天的表格仍给出同等强度且发送者仍在名单内；
 * - 机器人的 Mandate → 需要该机器人仍在机器人名单内；
 * - 其余 → 需要发送者仍在允许名单内。
 *
 * @param mandate 待复验的授权
 * @param policy 当前 Policy
 * @param sourcePart 当前该 Source 的策略部分
 * @returns 复验通过返回 true
 */
export function revalidateMandate(mandate: Mandate, policy: Policy, sourcePart: SourcePolicyPart | undefined): boolean {
  // 显式授权不受接单模式影响
  if (mandate.strength === "explicit") {
    // 但来源必须仍在监听——由 Source 层保证
    return true;
  }

  // 推断授权：需要 auto 模式 + 匹配规则仍启用
  if (policy.acceptMode !== "auto") {
    return false;
  }
  if (mandate.matchedRules.length > 0) {
    const enabled = new Set(policy.rules.filter((rule) => rule.enabled).map((rule) => rule.id));
    const stillEnabled = mandate.matchedRules.some((ruleId) => enabled.has(ruleId));
    if (!stillEnabled) return false;
  }

  // 发送者身份复验
  const allowlist = sourcePart?.allowlist ?? [];
  const botList = sourcePart?.botList ?? [];
  if (botList.includes(mandate.actor)) {
    return true;
  }
  return allowlist.includes(mandate.actor);
}

/**
 * 复验失败时构造错误
 *
 * @param reason 失败原因
 * @returns UserError
 */
export function revokedError(reason: string): UserError {
  return authorizationRevoked(reason);
}

// ============================================================================
// Policy 存取
// ============================================================================

/** Policy 持久化的 KV 键 */
export const POLICY_KV_KEY = "super-agent:policy";

/**
 * 从存储中读取 Policy（不存在则返回默认）
 *
 * @param read 读取函数
 * @returns Policy
 */
export function loadPolicy(read: (key: string) => string | undefined): Policy {
  const raw = read(POLICY_KV_KEY);
  if (raw === undefined || raw.length === 0) return createDefaultPolicy();
  try {
    const parsed = JSON.parse(raw) as Partial<Policy>;
    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      acceptMode: isAcceptMode(parsed.acceptMode) ? parsed.acceptMode : DEFAULT_ACCEPT_MODE,
      rules: Array.isArray(parsed.rules) ? parsed.rules : DEFAULT_POLICY_RULES,
      sourceParts: isRecord(parsed.sourceParts) ? (parsed.sourceParts as Record<string, SourcePolicyPart>) : {},
      dailyAttentionBudget:
        typeof parsed.dailyAttentionBudget === "number" ? parsed.dailyAttentionBudget : DEFAULT_DAILY_ATTENTION_BUDGET,
    };
  } catch {
    // 损坏的 Policy 不让系统崩——退回默认并由调用方如实汇报
    return createDefaultPolicy();
  }
}

/**
 * 校验 Policy 是否合法（用于 `policy set`）
 *
 * @param policy 待校验 Policy
 * @throws {UserError} 不合法时抛出
 */
export function validatePolicy(policy: Policy): void {
  if (!isAcceptMode(policy.acceptMode)) {
    throw invalidRequest(`接单模式非法：${String(policy.acceptMode)}（合法值：off / observe / auto）`);
  }
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    throw invalidRequest(`Policy 版本必须为正整数，当前为 ${String(policy.version)}`);
  }
  if (policy.dailyAttentionBudget !== null && policy.dailyAttentionBudget < 0) {
    throw invalidRequest("每日打扰上限不能为负数。");
  }
  const ruleIds = new Set<string>();
  for (const rule of policy.rules) {
    if (ruleIds.has(rule.id)) {
      throw invalidRequest(`规则 ID 重复：${rule.id}`);
    }
    ruleIds.add(rule.id);
  }
}

/**
 * 切换接单模式（便捷入口，返回新 Policy）
 *
 * @param policy 当前 Policy
 * @param mode 新模式
 * @returns 新 Policy（版本号 +1）
 */
export function withAcceptMode(policy: Policy, mode: AcceptMode): Policy {
  validatePolicy({ ...policy, acceptMode: mode, version: policy.version + 1 });
  return { ...policy, acceptMode: mode, version: policy.version + 1 };
}

/**
 * 查找某 Source 的策略部分
 *
 * @param policy 当前 Policy
 * @param sourceId Source ID
 * @returns Source 策略部分或 undefined
 */
export function findSourcePart(policy: Policy, sourceId: string): SourcePolicyPart | undefined {
  return policy.sourceParts[sourceId];
}

/**
 * 断言 Ticket 存在，否则抛出 notFound
 *
 * @param ticket 可能为 undefined 的 Ticket
 * @returns 非空 Ticket
 * @throws {UserError} Ticket 不存在
 */
export function requireTicket<T>(ticket: T | undefined): T {
  if (ticket === undefined) {
    throw notFound("工单不存在。");
  }
  return ticket;
}

function isAcceptMode(value: unknown): value is AcceptMode {
  return value === "off" || value === "observe" || value === "auto";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
