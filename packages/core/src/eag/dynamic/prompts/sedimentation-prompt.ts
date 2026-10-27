/**
 * 沉淀分析 prompt 模板（T02，架构 §3）
 *
 * 用途：SedimentationSuggester 把最近对话轮次交给 LLM 分析，识别可沉淀为
 * skill / agent 的可复用模式，输出受 JSON schema 约束的建议数组。
 *
 * 设计约束：
 * - 输出 JSON 仅含白名单字段（kind/name/description/role/content/rationale）；
 * - name 强制 kebab-case；agent 必须给 role；无建议时输出空数组；
 * - prompt 全中文（用户可见文案中文，对齐仓库约定）。
 *
 * @module eag/dynamic/prompts/sedimentation-prompt
 */

/** 传给 LLM 的对话轮次（仅 user/assistant 文本） */
export type SedimentationPromptTurn = {
  role: "user" | "assistant";
  content: string;
};

/** 沉淀分析 prompt 上下文 */
export type SedimentationPromptContext = {
  /** 最近对话轮次（已裁剪） */
  turns: SedimentationPromptTurn[];
};

/** 单条沉淀建议的 LLM 原始输出（解析前） */
export type RawSedimentationSuggestion = {
  kind?: string;
  name?: string;
  description?: string;
  role?: string;
  content?: string;
  rationale?: string;
};

/** LLM 原始输出结构 */
export type RawSedimentationOutput = {
  suggestions?: RawSedimentationSuggestion[];
};

/** 渲染后的 prompt 消息（role/content 形态，与 LLMRequest.messages 兼容） */
export type SedimentationPromptMessage = { role: "system" | "user"; content: string };

/** 单轮内容截断上限（防超长对话撑爆 prompt） */
const MAX_TURN_CHARS = 4000;

/** 送入分析的轮次数量上限（只看最近对话） */
export const SEDIMENTATION_MAX_TURNS = 30;

/**
 * 构建沉淀分析 prompt（system + user 两条消息）。
 *
 * @param context prompt 上下文（turns 已由调用方裁剪；本函数再做单轮长度截断兜底）
 * @returns prompt 消息数组
 */
export function buildSedimentationPrompt(context: SedimentationPromptContext): SedimentationPromptMessage[] {
  const turns = (context.turns ?? [])
    .slice(-SEDIMENTATION_MAX_TURNS)
    .map((turn) => ({
      role: turn.role === "assistant" ? "assistant" : "user",
      content: typeof turn.content === "string" ? turn.content.slice(0, MAX_TURN_CHARS) : "",
    }))
    .filter((turn) => turn.content.trim().length > 0);

  const systemPrompt = `你是一个知识沉淀分析器。你的任务是分析一段人机协作对话，判断其中是否反复出现了值得沉淀为可复用资产的方法论、排查步骤、操作流程或角色行为约束。

沉淀物的两种形态：
- skill：一组可复用的任务指令（操作步骤、规范、checklist 等）；
- agent：带角色身份与行为约束的定义（用户反复把模型当某个角色使用时沉淀）。

输出要求（严格 JSON，不要输出任何其他内容）：
\`\`\`
{ "suggestions": [ { "kind": "skill 或 agent", "name": "kebab-case 名称（小写字母/数字/连字符）", "description": "一句话描述", "role": "agent 时的角色身份，skill 时省略", "content": "完整的 Markdown 正文（frontmatter 之后的内容，可直接作为指令使用）", "rationale": "给用户看的中文建议理由（为什么值得沉淀）" } ] }
\`\`\`

判定门槛：
- 只沉淀「可复用」的模式：同样的流程/约束在对话中多次出现，或用户明确表达了"以后都这样做"的意图；
- name 必须符合 kebab-case；kind 为 agent 时必须给出 role；
- 没有值得沉淀的内容时输出 {"suggestions": []}，不要为了输出而输出；
- content 必须是完整可独立使用的中文 Markdown 指令，不要引用对话上下文。`;

  const userPrompt = `以下是最近的对话轮次（按时间顺序）：

<transcript>
${turns.map((turn) => `[${turn.role}] ${turn.content}`).join("\n\n")}
</transcript>

请分析并输出沉淀建议（严格 JSON）。`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}
