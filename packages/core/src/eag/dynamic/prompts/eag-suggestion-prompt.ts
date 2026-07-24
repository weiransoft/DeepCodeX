/**
 * 全局动态编排建议层决策 Prompt
 *
 * 本模块提供 `buildEagSuggestionPrompt()` 函数，用于根据用户目标、会话上下文
 * 和当前全部可用命令清单（EAG/Team/Rules/slash），生成供 LLM 做意图识别与
 * 命令建议的 prompt。
 *
 * 设计原则（对齐 2026-07-24-eag-llm-dynamic-orchestration.md v1.4）：
 * 1. 只做建议，不自动执行任何命令。
 * 2. 覆盖全部命令体系：EAG 编排、Team 多角色、Rules 规则管理、TUI slash 命令。
 * 3. 多阶段模糊任务优先推荐 /eag-autonomous 或 /team autonomous，而非 /eag-graph。
 * 4. 当任务存在多种合理技术路径或需求不清时，必须返回 ask_clarification。
 * 5. 必须说明前置条件（如 /eag-build 需要 spec/plan/tasks）。
 *
 * @module eag/dynamic/prompts/eag-suggestion-prompt
 */

import type { DynamicCommandDescriptor } from "../eag-dynamic-suggester";

/**
 * 构建决策 prompt 的上下文参数
 */
export interface EagSuggestionPromptContext {
  /** 用户当前自然语言目标 */
  readonly goal: string;
  /** 当前会话最近 N 条消息（可选） */
  readonly recentMessages?: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: string }>;
  /** 当前环境实际支持的全部命令描述符（EAG/Team/Rules/slash，由 session.ts / CLI 注入） */
  readonly availableCommands: ReadonlyArray<DynamicCommandDescriptor>;
  /** 上一轮澄清问题的用户选择（可选） */
  readonly clarification?: ReadonlyArray<string>;
}

/**
 * 构建 EAG 智能建议层的决策 prompt
 *
 * 算法：
 * 1. 按 category 分组展示可用命令清单及说明。
 * 2. 组合 system prompt（角色、约束、决策规则、输出格式）。
 * 3. 注入用户目标、最近消息、澄清答案。
 * 4. 返回供 LLMClient 使用的 message 数组。
 *
 * @param context 决策上下文
 * @returns 供 LLM 调用的消息数组
 */
export function buildEagSuggestionPrompt(
  context: Readonly<EagSuggestionPromptContext>
): ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }> {
  // 步骤 1：按 category 分组构造命令说明文本
  const commandDescriptions = formatCommandList(context.availableCommands);

  // 步骤 2：构造最近消息上下文文本
  const recentMessagesText =
    context.recentMessages && context.recentMessages.length > 0
      ? context.recentMessages.map((m) => `${m.role}: ${m.content}`).join("\n") + "\n\n"
      : "";

  // 步骤 3：构造澄清答案文本
  const clarificationText =
    context.clarification && context.clarification.length > 0
      ? `【用户上一轮澄清选择】\n${context.clarification.map((a) => `- ${a}`).join("\n")}\n\n`
      : "";

  // 步骤 4：组合 system prompt
  const systemPrompt = `你是 DeepCodeX CLI 的全局动态编排建议助手。
你的职责：根据用户目标和当前全部可用命令，给出最合适的命令建议。覆盖 EAG 编排、Team 多角色、Rules 规则管理、TUI slash 命令全部体系。

${commandDescriptions}

【决策规则】
1. 简单问答、解释、闲聊、单点技术建议 → 返回 action="direct_chat"，让主对话 LLM 处理。
2. 明确单阶段 EAG 任务（只需设计 / 编码 / 测试 / 部署中的一项） → 返回 action="suggest_command"，commandCategory="eag"，并给出 commandHint。
3. 模糊多阶段目标（如"帮我实现一个登录模块"、"完成用户认证功能"） → 返回 action="suggest_autonomous"，优先推荐 /eag-autonomous。
4. 用户明确提到 DAG、并行分支、条件路由，或已提供图定义文件 → 返回 action="suggest_graph"，推荐 /eag-graph。
5. 需要多角色协同（如"启动新项目"、"架构评审"） → 返回 action="suggest_command"，commandCategory="team"，推荐 /team dispatch 或 /team full-lifecycle。
6. 需要管理规则（查看/添加/删除规则） → 返回 action="suggest_command"，commandCategory="rules"，推荐 /rules list 等。
7. 需要 TUI 操作（切换模型、查看技能、新建会话等） → 返回 action="suggest_command"，commandCategory="slash"，推荐对应 slash 命令。
8. 任务规划存在多个方向、不同技术路径、需求不清或歧义时 → 返回 action="ask_clarification"，列出选项要求用户确认。

【命令体系说明】
- EAG 命令（category=eag）：企业级应用生成编排，包含设计/编码/测试/部署/自动化/图编排等阶段。
  - /eag-build、/eag-test、/eag-deploy、/eag-run 需要 spec/plan/tasks 等前置文档，如果用户未提供，必须在 messageToUser 或 prerequisites 中说明。
  - 多阶段任务优先推荐 /eag-autonomous，而不是 /eag-graph。
- Team 命令（category=team）：多角色协同调度，包含角色列表/匹配/分派/自主迭代/全流程。
  - /team autonomous：4 阶段 Ralph 自主迭代（plan → dev → verify → fix）。
  - /team full-lifecycle：8 阶段项目全流程（需求→架构→UI→测试设计→分解→开发→测试→审查）。
- Rules 命令（category=rules）：RLIS 规则管理，包含 list/add/remove/show/path。
- Slash 命令（category=slash）：TUI 交互命令，如 /skills、/model、/new、/init、/resume 等。

【强制约束】
- 绝对不允许自动执行任何命令。
- 只能建议当前可用命令清单中存在的命令（通过 commandCategory + commandId 精确标识）。
- /eag-build、/eag-test、/eag-deploy、/eag-run 需要 spec/plan/tasks 等前置文档，如果用户未提供，必须在 messageToUser 或 prerequisites 中说明。
- 多阶段任务优先推荐 /eag-autonomous 或 /team autonomous，而不是 /eag-graph。
- 如果返回 ask_clarification，必须提供清晰的 question、2-4 个 options（multiSelect 明确 true/false）、以及用户选择后如何推进的说明。

【输出格式】
必须严格返回以下 JSON，不要包含 markdown 代码块标记：
{
  "reasoning": "简短推理过程（中文）",
  "action": "direct_chat | suggest_command | suggest_autonomous | suggest_graph | ask_clarification",
  "commandCategory": "可选，当 action 为 suggest_command 时填写（eag | team | rules | slash）",
  "commandId": "可选，当 action 为 suggest_command 时填写，必须与可用命令清单中的 id 匹配",
  "commandHint": "可选，当 action 为 suggest_command/suggest_autonomous/suggest_graph 时填写，如 /eag-autonomous --goal \\"...\\"",
  "messageToUser": "展示给用户的中文建议文本",
  "prerequisites": ["可选：前置条件列表"],
  "question": "当 action=ask_clarification 时填写",
  "options": [{"label": "选项文本", "value": "选项标识", "description": "可选说明"}],
  "multiSelect": false,
  "confidence": 0.85
}

字段说明：
- confidence：0.0-1.0，表示你对判断的置信度。低于 0.6 时建议返回 direct_chat。
- action=suggest_command 时，commandCategory + commandId 必填，用于精确匹配命令。
- action=suggest_autonomous / suggest_graph 时，commandHint 填写推荐命令字符串。
- action=ask_clarification 时，commandHint / prerequisites 可省略，但 question / options / multiSelect 必填。
- action=direct_chat 时，commandHint / prerequisites / question / options 可省略。`;

  // 步骤 5：组合 user prompt
  const userPrompt = `${recentMessagesText}${clarificationText}用户目标：${context.goal}

请根据上述信息返回 JSON 建议。`;

  return Object.freeze([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);
}

/**
 * 按 category 分组格式化命令清单
 *
 * 将 DynamicCommandDescriptor 数组按 category（eag/team/rules/slash）分组，
 * 每组列出命令名称和说明，供 LLM 理解每个命令的用途。
 *
 * @param commands 可用命令描述符数组
 * @returns 分组格式化后的命令清单文本
 */
function formatCommandList(commands: ReadonlyArray<DynamicCommandDescriptor>): string {
  if (commands.length === 0) {
    return "【可用命令】\n（无可用命令）";
  }

  // 按 category 分组
  const groups: Record<string, DynamicCommandDescriptor[]> = {
    eag: [],
    team: [],
    rules: [],
    slash: [],
  };

  for (const cmd of commands) {
    const group = groups[cmd.category];
    if (group) {
      group.push(cmd);
    }
  }

  const sections: string[] = ["【可用命令】"];

  // EAG 命令组
  if (groups.eag.length > 0) {
    sections.push("\n--- EAG 编排命令（category=eag）---");
    for (const cmd of groups.eag) {
      const argsText = cmd.args && cmd.args.length > 0 ? ` 参数: ${cmd.args.join(", ")}` : "";
      sections.push(`- ${cmd.name}（id=${cmd.id}）: ${cmd.description}${argsText}`);
    }
  }

  // Team 命令组
  if (groups.team.length > 0) {
    sections.push("\n--- Team 多角色命令（category=team）---");
    for (const cmd of groups.team) {
      const argsText = cmd.args && cmd.args.length > 0 ? ` 参数: ${cmd.args.join(", ")}` : "";
      sections.push(`- ${cmd.name}（id=${cmd.id}）: ${cmd.description}${argsText}`);
    }
  }

  // Rules 命令组
  if (groups.rules.length > 0) {
    sections.push("\n--- Rules 规则管理命令（category=rules）---");
    for (const cmd of groups.rules) {
      const argsText = cmd.args && cmd.args.length > 0 ? ` 参数: ${cmd.args.join(", ")}` : "";
      sections.push(`- ${cmd.name}（id=${cmd.id}）: ${cmd.description}${argsText}`);
    }
  }

  // Slash 命令组
  if (groups.slash.length > 0) {
    sections.push("\n--- TUI Slash 命令（category=slash）---");
    for (const cmd of groups.slash) {
      const argsText = cmd.args && cmd.args.length > 0 ? ` 参数: ${cmd.args.join(", ")}` : "";
      sections.push(`- ${cmd.name}（id=${cmd.id}）: ${cmd.description}${argsText}`);
    }
  }

  return sections.join("\n");
}
