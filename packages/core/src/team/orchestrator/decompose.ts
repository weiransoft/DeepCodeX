/**
 * 目标 → 子任务计划（拆解器）
 *
 * ## 设计要点
 *
 * 1. **一次调用**：拆解只调一次 LLM。多次往返（先粗拆再细化）会让成本和延迟翻倍，
 *    而 `maxSubtasks=6` 的上限让「一次拆清楚」是可行的。
 * 2. **输出是纯 JSON**：不走 function calling——`team/` 层没有 tool 定义通道，
 *    走纯文本 + 容错解析（见 `extractJsonObject`）比给编排器再引一套 tool schema 便宜。
 * 3. **一切产物都过校验**：`decomposeGoal` 只负责「拿到文本」，是否可信由
 *    `validatePlan` 判定。拆解失败一律返回结构化错误，由编排层降级为单任务派单。
 *
 * @module team/orchestrator/decompose
 */

import type { OpenAIClientHandle } from "../../common/openai-client.js";
import { callLlmOnce } from "./llm-once.js";
import { extractJsonObject, validatePlan } from "./plan-graph.js";
import type { DecomposeResult, OrchestrationBudget } from "./types.js";

/** 注入 prompt 的角色上限（防止候选集膨胀时把 prompt 撑爆） */
const MAX_ROLES_IN_PROMPT = 60;

/** 拆解器系统提示 */
export const DECOMPOSE_SYSTEM_PROMPT = [
  "你是一个任务拆解器。你的唯一职责是把用户目标拆成若干「可独立派给一个角色」的子任务。",
  "",
  "输出要求（必须严格遵守）：",
  "1. 只输出一个 JSON 对象，不要任何解释文字、不要 markdown 围栏。",
  "2. JSON 结构：",
  '   {"rationale":"一句话说明为什么这样拆","subtasks":[',
  '     {"id":"t1","title":"短标题","description":"完整任务描述",',
  '      "roleHint":"角色id","dependsOn":[],"files":["相对路径"],"acceptance":"完成判据"}]}',
  "3. 字段规则：",
  "   - id：唯一、以字母开头、只含字母数字下划线连字符，如 t1/t2/design-api。",
  "   - description：写给执行角色的完整指令，包含必要的上下文；不要写「同上」。",
  "   - dependsOn：只在「后一个任务必须读到前一个任务的产物」时才填。",
  "     互不依赖的任务必须放在同一批（dependsOn 为空），这样才能并行。",
  "   - files：该子任务预计会修改的项目内相对路径（用于检测写冲突）。不确定就留空数组，",
  "     绝对不要写绝对路径或包含 .. 的路径。",
  "   - roleHint：只能从下面给出的角色清单里选 roleId；没有合适的就省略该字段。",
  "4. 不要输出超过上限数量的子任务；宁可少拆，也不要把一个任务拆成多个同义子任务。",
  "5. 如果目标本身已经足够小（一个角色一次就能做完），就只输出一个子任务。",
].join("\n");

/** 角色摘要（进 prompt 用） */
export interface RoleBrief {
  roleId: string;
  name: string;
  group?: string;
  /** 角色擅长什么（取 capabilities 前 3 项，帮助模型判断该派给谁） */
  capabilities?: ReadonlyArray<string>;
}

/** 构造拆解用 user prompt */
export function buildDecomposeUserPrompt(params: {
  goal: string;
  roles: ReadonlyArray<RoleBrief>;
  budget: OrchestrationBudget;
  projectRoot: string;
}): string {
  const { goal, roles, budget, projectRoot } = params;

  const roleLines = roles.slice(0, MAX_ROLES_IN_PROMPT).map((role) => {
    const group = role.group ? ` [${role.group}]` : "";
    const caps =
      role.capabilities && role.capabilities.length > 0 ? ` 擅长:${role.capabilities.slice(0, 3).join("/")}` : "";
    return `- ${role.roleId}${group}：${role.name}${caps}`;
  });

  return [
    `项目根目录: ${projectRoot}`,
    `子任务数量上限: ${budget.maxSubtasks}`,
    "",
    "可用角色清单（roleHint 只能从中选择）:",
    roleLines.length > 0 ? roleLines.join("\n") : "- （无可用角色，省略 roleHint 字段）",
    "",
    "用户目标:",
    goal,
  ].join("\n");
}

/**
 * 执行拆解
 *
 * 失败不抛异常：所有失败都以 `{ ok: false, kind }` 返回，编排层据此降级。
 * 这是刻意的——拆解是"增强项"，它挂掉不该让用户的目标完全没人接。
 */
export async function decomposeGoal(params: {
  goal: string;
  handle: OpenAIClientHandle | null;
  roles: ReadonlyArray<RoleBrief>;
  budget: OrchestrationBudget;
  projectRoot: string;
  timeoutMs?: number;
}): Promise<DecomposeResult> {
  const { goal, handle, roles, budget, projectRoot, timeoutMs } = params;

  if (goal.trim() === "") {
    return { ok: false, kind: "plan-invalid", message: "目标为空，无法拆解" };
  }
  if (handle === null) {
    return { ok: false, kind: "llm-unavailable", message: "LLM 不可用（未配置 API Key）" };
  }

  const userPrompt = buildDecomposeUserPrompt({ goal, roles, budget, projectRoot });
  const response = await callLlmOnce(handle, DECOMPOSE_SYSTEM_PROMPT, userPrompt, timeoutMs);

  if (!response.ok) {
    return {
      ok: false,
      kind: response.kind === "llm-unavailable" ? "llm-unavailable" : "llm-error",
      message: response.message,
    };
  }

  const extracted = extractJsonObject(response.content);
  if (!extracted.ok) {
    return {
      ok: false,
      kind: "no-json",
      message: "拆解结果中找不到 JSON 对象",
      raw: response.content,
    };
  }

  const validated = validatePlan(extracted.value, budget);
  if (!validated.ok) {
    return {
      ok: false,
      kind: "plan-invalid",
      message: validated.reason,
      raw: response.content,
    };
  }

  return {
    ok: true,
    plan: validated.plan,
    rationale: validated.plan.rationale,
    raw: response.content,
  };
}
