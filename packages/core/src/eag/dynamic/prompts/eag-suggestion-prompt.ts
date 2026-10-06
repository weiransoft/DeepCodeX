/**
 * EAG 触发层统一决策 Prompt（0.4.3.11：LLM 意图识别 + 任务动态规划）
 *
 * 本模块提供 `buildEagSuggestionPrompt()` 函数，用于根据用户输入、会话上下文
 * （上一条建议快照、自主运行终态历史）和当前全部可用命令清单（EAG/Team/Rules/slash），
 * 生成供 LLM 做触发层统一决策的 prompt。
 *
 * 设计原则（0.4.3.11 触发层 LLM 化改造，设计文档
 * docs/research/2026-10-eag-llm-intent-trigger.md §3.5）：
 * 1. 触发层不再依赖关键字/规则匹配——第一次指令（execute_command）、
 *    第二次指令（confirm_previous）、建议展示（suggest_*）、澄清（ask_clarification）、
 *    主对话（direct_chat）全部由本决策 LLM 单次调用输出。
 * 2. LLM 不可用/输出非法/低置信度时降级为 direct_chat（不自动执行），无正则兜底。
 * 3. 目标有效性由 LLM 判断：纯终态状态标签（"已完成""人工接管"等）禁止 execute_command。
 * 4. 知情重试判定：目标命中运行终态历史中的失败记录时，仅当用户输入明确表达
 *    知情重试才输出 acknowledgeFailedGoal=true，否则省略（由守卫拦截）。
 *
 * @module eag/dynamic/prompts/eag-suggestion-prompt
 */

import type { DynamicCommandDescriptor } from "../eag-dynamic-suggester";

/**
 * 构建触发层决策 prompt 的上下文参数
 */
export interface EagSuggestionPromptContext {
  /** 用户当前自然语言输入（原始目标） */
  readonly goal: string;
  /** 当前会话最近 N 条消息（可选，不含当前输入） */
  readonly recentMessages?: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: string }>;
  /** 当前环境实际支持的全部命令描述符（EAG/Team/Rules/slash，由 session.ts / CLI 注入） */
  readonly availableCommands: ReadonlyArray<DynamicCommandDescriptor>;
  /** 上一轮澄清问题的用户选择（可选，refine 流程） */
  readonly clarification?: ReadonlyArray<string>;
  /** 上一条展示过的建议快照（可选，指代确认识别依据；无快照时为 null/undefined） */
  readonly previousSuggestion?: Readonly<{ commandHint: string; goal: string }> | null;
  /** 自主运行终态历史（可选，知情重试判定依据；goal 为截断回显） */
  readonly autonomousGoalRuns?: ReadonlyArray<{
    readonly goal: string;
    readonly finalStatus: string;
    readonly endedAt: string;
  }>;
}

/**
 * 构建 EAG 触发层统一决策 prompt
 *
 * 算法：
 * 1. 按 category 分组展示可用命令清单及说明。
 * 2. 构造上下文区块：最近消息、澄清答案、上一条建议快照、运行终态历史。
 * 3. 组合 system prompt（角色、决策规则、守卫约束、输出格式）。
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

  // 步骤 4：构造上一条建议快照文本（指代确认识别依据）
  const previousSuggestionText =
    context.previousSuggestion && context.previousSuggestion.commandHint
      ? `【上一条展示过的建议快照】\n命令：${context.previousSuggestion.commandHint}\n目标：${context.previousSuggestion.goal}\n\n`
      : "";

  // 步骤 5：构造自主运行终态历史文本（知情重试判定依据）
  let runHistoryText = "";
  if (context.autonomousGoalRuns && context.autonomousGoalRuns.length > 0) {
    const lines = context.autonomousGoalRuns.map(
      (r) => `- 目标：${r.goal}｜终态：${r.finalStatus}｜结束时间：${r.endedAt}`
    );
    runHistoryText = `【本会话自主运行终态历史（最新在后）】\n${lines.join("\n")}\n\n`;
  }

  // 步骤 6：组合 system prompt
  const systemPrompt = `你是 DeepCodeX 的触发层统一决策助手（意图识别 + 任务动态规划）。
你的职责：对每一条用户输入做语义级判断，决定系统是"立即自动执行命令"（execute_command）、
"确认执行上一条建议"（confirm_previous）、"仅展示建议"（suggest_*）、"追问澄清"
（ask_clarification）还是"交回主对话"（direct_chat）。覆盖 EAG 编排、Team 多角色、
Rules 规则管理、TUI slash 命令全部体系。

${commandDescriptions}

【决策规则】
1. 简单问答、解释、闲聊、单点技术建议、否定表述（"不要启动""先别执行"）→ action="direct_chat"。
2. 用户输入明确表达可执行意图且目标实质充分 → action="execute_command"：commandHint 填
   裸命令（如 "/eag-autonomous"，**严禁携带任何参数**），goal 填你从输入中动态规划提取的
   目标文本。execute_command 仅限 category=eag 的命令；team/rules/slash 命令只能 suggest_command。
3. 用户输入是在确认执行上一条展示过的建议（如"执行这个""就运行该方案""开始吧"，
   结合上一条建议快照判断）→ action="confirm_previous"。
4. 意图存在但不足以自动执行（如 /eag-build 缺 spec/plan 前置文档、需要用户知晓说明、
   非 EAG 命令）→ action="suggest_command" / "suggest_autonomous" / "suggest_graph"，仅展示。
5. 仅当需求严重模糊（"帮我做点什么"）或多路径分歧时 → action="ask_clarification"。
   有明确目标的模糊描述应直接 execute_command。

【目标有效性判定（高优先级，取代旧关键词规则）】
- 目标文本若仅为终态状态标签（"已完成""人工接管""completed""已验证"等）而无实质动作，
  **禁止 execute_command**：返回 direct_chat 或 suggest_autonomous 并说明原因。
- 目标含实质动作（修复/实现/部署等）或具体技术上下文时，终态词只是背景描述，可正常判定。

【知情重试判定】
- 若动态规划提取的目标与本会话运行终态历史中某条非 completed 记录实质相同：
  - 用户输入明确表达知情重试（如"上次失败的任务重新跑一遍，这次加上约束 X"）→
    输出 "acknowledgeFailedGoal": true；
  - 无法确认是知情重试（如只是"继续"）→ 省略 acknowledgeFailedGoal（系统守卫会拦截并提示）。

【命令体系说明】
- EAG 命令（category=eag）：企业级应用生成编排，包含设计/编码/测试/部署/自动化/图编排等阶段。
  - /eag-build、/eag-test、/eag-deploy、/eag-run 需要 spec/plan/tasks 等前置文档；
    用户未提供时不得 execute_command，改用 suggest_command 并在 prerequisites 中说明。
  - 多阶段任务优先 execute_command /eag-autonomous，而不是 /eag-graph。
- Team 命令（category=team）：多角色协同调度（/team autonomous、/team full-lifecycle 等）。
- Rules 命令（category=rules）：RLIS 规则管理（/rules list 等）。
- Slash 命令（category=slash）：TUI 交互命令（/skills、/model、/new 等）。

【强制约束】
- execute_command 表示系统将**立即自动执行**，仅在意图充分、目标实质、命令为裸 /eag- 命令时返回。
- suggest_* 仅展示建议；messageToUser 面向用户说明原因与下一步。
- 只能引用当前可用命令清单中存在的命令（通过 commandCategory + commandId 精确标识）。
- 如果返回 ask_clarification，必须提供清晰的 question、2-4 个 options、multiSelect 明确 true/false。

【输出格式】
必须严格返回以下 JSON，不要包含 markdown 代码块标记：
{
  "reasoning": "简短推理过程（中文）",
  "action": "direct_chat | execute_command | confirm_previous | suggest_command | suggest_autonomous | suggest_graph | ask_clarification",
  "commandHint": "execute_command/suggest_autonomous/suggest_graph 时填写，execute_command 必须为裸命令如 /eag-autonomous",
  "goal": "execute_command 时必填：动态规划提取的目标文本",
  "acknowledgeFailedGoal": "可选，execute_command 且用户明确知情重试失败目标时为 true",
  "commandCategory": "suggest_command 时填写（eag | team | rules | slash）",
  "commandId": "suggest_command 时填写，必须与可用命令清单中的 id 匹配",
  "messageToUser": "展示给用户的中文文本",
  "prerequisites": ["可选：前置条件列表"],
  "question": "当 action=ask_clarification 时填写",
  "options": [{"label": "选项文本", "value": "选项标识", "description": "可选说明"}],
  "multiSelect": false,
  "confidence": 0.85
}

字段说明：
- confidence：0.0-1.0，表示你对判断的置信度。低于 0.6 时返回 direct_chat（宁可交给主对话，不可误触发自动执行）。
- action=execute_command 时，commandHint（裸命令）+ goal 必填。
- action=suggest_command 时，commandCategory + commandId 必填。
- action=ask_clarification 时，question / options / multiSelect 必填。
- action=direct_chat / confirm_previous 时，其余字段可省略。`;

  // 步骤 7：组合 user prompt（上下文区块 + 当前输入）
  const userPrompt = `${recentMessagesText}${clarificationText}${previousSuggestionText}${runHistoryText}用户当前输入：${context.goal}

请根据上述信息返回 JSON 决策。`;

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
