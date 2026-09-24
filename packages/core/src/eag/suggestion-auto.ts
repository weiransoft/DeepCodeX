/**
 * EAG 建议自动执行白名单与命令提取纯函数（T1 装配下沉，2026-09-24）
 *
 * 设计依据：docs/dev/eag-web-sedimentation-fixes.md §2.1（T1 装配下沉·方案 A）
 *
 * 背景（原 CLI 版 ui/core/suggestion-fallback.ts 头注释契约，完整保留）：
 * 系统提示词纪律（F4"命令执行纪律"）禁止模型在收到任务后回复"建议执行 /xxx"，
 * 但提示词无法 100% 约束模型行为。当 LLM 回合以纯文本结束（无工具调用）且回复中
 * 出现"建议执行 /xxx"句式时，客户端自动把该命令注入执行，打破"模型反复建议、
 * 命令永不执行"的建议循环。
 *
 * 与消费方（CLI App.tsx handlePrompt finally 块 / Web session-pool 轮次收尾）配合工作，
 * 完整防线分四层：
 * 1. 提取层（本模块 extractSuggestedCommandText）：从回合收尾文本中提取建议的命令字符串
 *    （F9-v2：参数捕获支持单/双引号包裹的中文参数）；
 * 2. 校验层（CLI App.tsx parseSlashCommandKind）：命令必须是 BUILTIN_SLASH_COMMANDS 中的
 *    内置命令，否则视为 LLM 幻觉，静默放弃；
 * 3. 执行层（CLI App.tsx）：只有 kind 落在 AUTO_EXECUTABLE_COMMAND_KINDS 白名单内才注入执行，
 *    且同一 kind 每个会话只自动执行一次（防循环）。该白名单属 CLI slash 体系，留在 CLI；
 * 4. EAG 执行层（F9-v2）：PromptSubmission.command 体系外的 EAG 命令经
 *    extractAutoExecutableEagCommandName + AUTO_EXECUTABLE_EAG_COMMANDS 校验后，
 *    走纯文本注入通道直达 core session.ts 的 EagCommandParser（EAG 命令本身不在
 *    第 2/3 层体系内）。
 *
 * 本模块为纯函数模块，不依赖 React / Ink，便于单元测试；T1 下沉后 CLI / Web 共享同一份
 * 白名单与提取实现（行为逐字节不变）。
 *
 * @module eag/suggestion-auto
 */

/**
 * F9-v2（2026-09-12）：允许自动执行的 EAG 命令名白名单。
 *
 * 背景：EAG 命令不在 AUTO_EXECUTABLE_COMMAND_KINDS 体系内——PromptSubmission.command
 * 联合类型没有 eag-* 成员，EAG 命令经"裸文本透传"通道直达 core session.ts 的
 * EagCommandParser 前缀解析分发。因此 EAG 建议的自动执行走独立的纯文本注入通道
 * （见 CLI App.tsx finally 兜底块 / Web session-pool 轮次收尾），白名单也独立维护。
 *
 * 设计原则（保守收录）：
 * - 仅收录 eag-autonomous：建议循环日志中反复出现"建议启动 /eag-autonomous"，
 *   且该命令是 EAG 建议器（suggest_autonomous）的标准产出；
 * - 明确排除：
 *   eag-autonomous-stop（熔断操作，模型幻觉触发即中断真实任务）；
 *   eag-autonomous-status（信息查询类，无执行价值）；
 *   eag-graph（需要 --graph-file 等复杂参数，幻觉参数无法通过校验）；
 *   eag-design/eag-build 等（需要完整需求/规格参数，交给建议层 refine 流程处理）。
 */
export const AUTO_EXECUTABLE_EAG_COMMANDS = new Set<string>(["eag-autonomous"]);

// "建议 + 动词(执行|启动|运行|使用|部署|调用|发起|开始)" + 至多 12 个非换行非斜杠字符
// （容忍"的/命令/反引号/，"等连接词）+ /命令名(+ 参数)
//
// F9 扩展：原正则只匹配"建议执行"，但 EAG 动态建议器输出的是"建议启动 /eag-autonomous"
// 等句式，此处扩展动词枚举覆盖更多中文表达，前缀容忍窗口保持 12 字符不变。
// 命令名要求字母开头（与 BUILTIN_SLASH_COMMANDS 命名一致）。
//
// F9-v2 扩展（2026-09-12）：参数捕获支持单/双引号包裹的中文参数——
// 日志铁证：建议器输出"建议启动 /eag-autonomous --goal '从本机 46 导出...'"时，
// 原正则的 ASCII token 模式在引号处截断，导致 --goal 的中文值被丢弃、兜底全程静默。
// 引号参数模式（'[^'\n]*'|"[^"\n]*"）完整捕获引号内任意非换行内容（含中文与空格），
// 引号后继续匹配 ASCII token（如 --max-iterations 10）。
// 中文散文（如"建议启动 /eag-autonomous 来完成这次同步"中的"来完成这次同步"）
// 仍不会被误认为参数（裸 token 模式保持 ASCII-only）。
const SUGGESTION_COMMAND_PATTERN =
  /建议(?:执行|启动|运行|使用|部署|调用|发起|开始)[^\n/]{0,12}\/([a-zA-Z][\w-]*)(?:[ \t]+(?:'[^'\n]*'|"[^"\n]*"|[A-Za-z0-9_\-./@]+))*/g;

// 否定标记：当"建议执行 /xxx"是模型转述的模板约束文本（例如 F3 审查模板中的
// "严禁回复'建议执行 /review 或任何斜杠命令'"），模式前文会出现下列否定词，
// 此时该文本是"被禁止的示例"而非真正的建议，不应触发自动执行。
// 双路匹配：
// - NEGATION_MARKER_PATTERN（完整词）：严禁|禁止|避免|不要|不建议|不会|不必|无需
//   覆盖绝大多数否定语汇
// - SINGLE_CHAR_NEGATION（单字前缀）：不|别|勿|禁
//   用于捕获被正则"建议"截断的否定词前缀（如"不建议启动"中，正则从"建议"开始命中
//   match.index=1，完整否定词"不建议"被截在窗口之外——单字"不"落入 prefix）
const NEGATION_MARKER_PATTERN = /严禁|禁止|避免|不要|不建议|不会|不必|无需/;
const SINGLE_CHAR_NEGATION = /[不别勿禁]/;

/**
 * F9-v2（2026-09-12）：判断建议命令是否为允许自动执行的 EAG 命令。
 *
 * EAG 命令经纯文本注入通道执行（无 PromptSubmission.command 字段），因此
 * CLI App.tsx 的 parseSlashCommandKind + AUTO_EXECUTABLE_COMMAND_KINDS 校验体系
 * 对 eag-* 返回 undefined（走不进白名单）。本函数为 EAG 命令提供等价的
 * 白名单校验：命令名（首个 token 去除 "/"）必须落在 AUTO_EXECUTABLE_EAG_COMMANDS。
 *
 * @param commandText 建议命令字符串（如 "/eag-autonomous --goal 'xxx'"）
 * @returns 命中的 EAG 命令名（如 "eag-autonomous"）；非白名单 EAG 命令或
 *          非 EAG 命令返回 null
 */
export function extractAutoExecutableEagCommandName(commandText: string): string | null {
  const trimmed = commandText.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  // 提取首个 token（如 "/eag-autonomous"），去除 "/" 得到命令名
  const firstToken = trimmed.split(/\s+/, 1)[0];
  if (!firstToken) {
    return null;
  }
  const commandName = firstToken.slice(1);
  if (!commandName) {
    return null;
  }
  return AUTO_EXECUTABLE_EAG_COMMANDS.has(commandName) ? commandName : null;
}

/**
 * 从 assistant 回合收尾文本中提取"建议执行 /xxx"的斜杠命令。
 *
 * 规则：
 * 1. 匹配"建议执行[≤12 非换行非斜杠字符]/命令名(ASCII 参数)"，命令名后紧跟的中文散文不视为参数；
 * 2. 从最后一次匹配向前倒序搜索——"回合以建议结尾"意味着文本尾部最相关，
 *    也避免命中回复中段偶然出现的同类句式；
 * 3. 否定保护：若匹配前 12 个字符内出现否定标记（严禁/禁止/不要等），
 *    视为模型转述约束文本，跳过该匹配继续向前找；
 * 4. 提取结果只保证形如 "/cmd [ascii-args]"，是否为真实内置命令由调用方
 *    （CLI App.tsx parseSlashCommandKind + AUTO_EXECUTABLE_COMMAND_KINDS）二次校验。
 *
 * @param text assistant 回合收尾回复的完整文本
 * @returns 以 "/" 开头的命令字符串（如 "/review" 或 "/team dispatch task"）；
 *          无有效建议时返回 null
 */
export function extractSuggestedCommandText(text: string): string | null {
  const captured = captureLastNonNegatedSuggestion(text);
  if (!captured) {
    return null;
  }
  return captured.commandWithSlash;
}

/**
 * 建议句式捕获结果（命令片段 + 中文目标散文）
 *
 * 内部结构：由 captureLastNonNegatedSuggestion 返回，供 extractSuggestedCommandText
 * （纯命令）和 extractSuggestedCommandAndGoal（命令 + goal）两条消费路径共用。
 * goalText 为命令名之后、句号或文本结尾之前的中文散文片段（去掉首尾空白），
 * 若命令本身已带 --goal 参数则 goalText 为空字符串——此时完整命令里以已带参数为准。
 */
export type SuggestedCommandCapture = {
  /** 正则完整命中（含"建议启动"前缀）——内部调试/提取用 */
  readonly snippet: string;
  /** 命令名（首个 token 去 "/"，如 "eag-autonomous"） */
  readonly commandName: string;
  /** 以 "/" 开头的纯命令片段（含可选 ASCII 参数，不含中文散文）——直接用于 buildAutoExecuteCommand */
  readonly commandWithSlash: string;
  /** 命令之后的中文散文作为 goal 文本（空串表示命令已自带 --goal 或无散文） */
  readonly goalText: string;
};

/**
 * 内部工具：在回合文本中定位**最后一次**非否定建议句式匹配。
 *
 * 负责：正则匹配 → 倒序 → 否定保护 → goal 散文抽取。不做命令格式校验（白名单由外层处理）。
 *
 * 提取规则：
 * - 命令片段（snippet）：正则命中的完整片段（含命令名 + ASCII 参数）
 * - goal 散文（goalText）：命令片段在原文本中结束位置之后的内容，截取到**首个句号/感叹号/问号/换行**之前（支持中英文句号，允许多句散文但截断到首个终结标点）
 *   - 空字符串：命令本身已带引号参数或无散文
 *   - 纯 ASCII token 序列（如 "10 --confirmation smart"）：已在正则捕获范围内，不会落入 goal
 *
 * @param text assistant 回合收尾回复的完整文本
 * @returns 捕获结构；未命中 / 全部被否定保护跳过则返回 null
 */
function captureLastNonNegatedSuggestion(text: string): SuggestedCommandCapture | null {
  if (!text || typeof text !== "string") {
    return null;
  }
  // /g 正则带 lastIndex 状态，matchAll 会自行从头扫描，但显式复位可防御外部复用
  SUGGESTION_COMMAND_PATTERN.lastIndex = 0;
  const matches = Array.from(text.matchAll(SUGGESTION_COMMAND_PATTERN));
  // 倒序搜索：最后一次非否定匹配优先（回合"以建议结尾"）
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    if (!match || typeof match.index !== "number") {
      continue;
    }
    // 否定保护（双路匹配 + 12 字符紧邻窗口）：
    // - 窗口 [match.index - 12, match.index) 紧邻建议句式前的 12 字符（原 EA-02e 场景
    //   设计：远在前面的否定词不应该误伤后面的真实建议——"不建议执行 /xxx。建议执行 /yyy"
    //   里 "/yyy" 应被保留，因为否定词远在前面与当前建议句式无关）；
    // - NEGATION_MARKER_PATTERN 完整词匹配覆盖绝大多数否定语汇；
    // - SINGLE_CHAR_NEGATION 单字前缀（不/别/勿/禁）补充——用于捕获被正则"建议"截断
    //   的否定词前导字："不建议启动 /xxx"中正则从"建议"开始命中（match.index=1），
    //   完整否定词"不建议"被截在窗口外，prefix 仅抓到单字"不"，单字匹配兜底。
    const WINDOW = 12;
    const windowStart = Math.max(0, match.index - WINDOW);
    const prefix = text.slice(windowStart, match.index);
    if (NEGATION_MARKER_PATTERN.test(prefix) || (prefix.length > 0 && SINGLE_CHAR_NEGATION.test(prefix.slice(-1)))) {
      continue;
    }
    const snippet = match[0];
    // 命令名：match[1] 是捕获组 1（首个 token 不含 "/"），空串兜底
    const commandName = match[1] ?? "";
    // 从 snippet 中切出以 "/" 开头的纯命令片段（命令名 + ASCII 参数，不含中文散文）
    // 与 extractSuggestedCommandText 行为一致——共享 slice 避免两处维护
    const slashOffset = snippet.indexOf("/");
    const commandWithSlash = slashOffset >= 0 ? snippet.slice(slashOffset) : snippet;
    // 抽取 goal 散文：snippet 在原文本中的结束位置之后，截取到首个句号/换行/感叹号/问号
    const snippetEnd = match.index + snippet.length;
    const tail = text.slice(snippetEnd);
    // 终结标点集合：中文句号/感叹号/问号，英文句号/感叹号/问号，换行
    // 允许散文跨逗号/分号（保留到首个句号），但截断在换行处
    const terminalPattern = /[\n。！？!?]/;
    let goalText = "";
    if (tail.length > 0) {
      const terminalMatch = terminalPattern.exec(tail);
      goalText = terminalMatch ? tail.slice(0, terminalMatch.index).trim() : tail.trim();
    }
    // 命令本身已带 --goal 参数时，goalText 归零（避免与命令内参数冲突）
    const hasExplicitGoal = /--goal\b/.test(snippet) || /--requirement\b/.test(snippet);
    if (hasExplicitGoal) {
      goalText = "";
    }
    return { snippet, commandName, commandWithSlash, goalText };
  }
  return null;
}

/**
 * F1-v2（2026-09-24）：同时提取建议命令与中文目标散文。
 *
 * 修复 EA-03b 遗留：extractSuggestedCommandText 只返回裸命令（如 "/eag-autonomous"），
 * 但 Web 宿主需要完整命令（带 --goal 引号参数）才能让 handleEagAutonomousCommand
 * 启动编排器真实执行。本函数返回命令片段 + 原始散文 goal，由外层 buildAutoExecuteCommand
 * 组装完整命令。
 *
 * 规则（与 extractSuggestedCommandText 同基，额外抽取散文 goal）：
 * - 命令片段：正则捕获的命令名 + ASCII 参数（不含散文）
 * - goalText：命令片段之后、首个句号/感叹号/问号/换行之前的中文散文（trim 后）
 * - 若命令本身已带 --goal 参数，goalText 返回空字符串（冲突防护）
 *
 * @param text assistant 回合收尾回复的完整文本
 * @returns 捕获结构（snippet 空串表示无有效命令）；全部被否定保护跳过则返回 null
 */
export function extractSuggestedCommandAndGoal(text: string): SuggestedCommandCapture | null {
  return captureLastNonNegatedSuggestion(text);
}

/**
 * 根据命令提示 + goal 散文构造自动执行的完整命令字符串（纯函数版本）。
 *
 * 与 SessionManager.buildAutoExecuteCommand（session.ts L3995）逻辑完全等价，
 * 但为纯函数签名（无 SessionManager 依赖），供 CLI 兜底（App.tsx）和 Web 宿主
 * （session-pool 兜底）共享——Web 宿主的 session-manager 私有方法不可直调，
 * 本纯函数作为公用组装体。
 *
 * 命令格式（对齐 extractEagAutonomousRequestFromPrompt 等解析器）：
 * - /eag-autonomous --goal "..." --max-iterations 10 --confirmation smart
 * - /eag-design --requirement "..." --paradigm ddd-layered
 * - /eag-build /eag-test /eag-run /eag-deploy --goal "..."
 * - 其他命令裸透传
 *
 * goal 中的双引号、反斜杠、换行符会被安全转义，防止命令字符串解析失败。
 *
 * @param commandHint 命令提示字符串（如 "/eag-autonomous"）
 * @param goal 用户原始目标散文（如"修复登录失败问题"）
 * @returns 完整命令字符串
 */
export function buildAutoExecuteCommand(commandHint: string, goal: string): string {
  // 安全转义 goal 中的特殊字符（对齐 shell 引号 + argparse 解析器）：
  // - 反斜杠 → 双反斜杠
  // - 双引号 → 反斜杠双引号
  // - 换行符 → 空格（命令字符串不支持多行参数）
  const escapedGoal = goal.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ").trim();
  const trimmedCommand = commandHint.trim();

  // /eag-autonomous：完整参数（--goal + --max-iterations + --confirmation smart）
  if (trimmedCommand === "/eag-autonomous") {
    return escapedGoal.length > 0
      ? `/eag-autonomous --goal "${escapedGoal}" --max-iterations 10 --confirmation smart`
      : "/eag-autonomous";
  }
  // /eag-design：--requirement + --paradigm
  if (trimmedCommand === "/eag-design") {
    return escapedGoal.length > 0 ? `/eag-design --requirement "${escapedGoal}" --paradigm ddd-layered` : "/eag-design";
  }
  // /eag-build / /eag-test / /eag-run / /eag-deploy：通用 --goal 参数
  const goalCommands = ["/eag-build", "/eag-test", "/eag-run", "/eag-deploy"];
  if (goalCommands.includes(trimmedCommand)) {
    return escapedGoal.length > 0 ? `${trimmedCommand} --goal "${escapedGoal}"` : trimmedCommand;
  }

  // /eag-graph 等特殊命令：降级为裸命令（handler 内部会提示需要额外参数）
  // suggest_command 可能带参数（如 "/team dispatch"），直接返回 commandHint 让 handler 自行处理
  return trimmedCommand;
}

/**
 * 工具调用回合的短碎片降级判据纯函数（脏碎片治理，2026-09-24）
 *
 * 设计依据：Advisor 2026-09-24 审查会话 + 用户原始场景（"数据库连接池异常"6 字
 * 孤立 assistant 消息，qwen3.8 在工具循环中间轮次把这段误输出在正文通道而非
 * reasoning_content）
 *
 * 三条件同时满足才判定为碎片并降级（三条件收窄自最初单条件 toolCalls && content 非空
 * 方案，Advisor 指出原方案会误伤 "让我先检查一下项目结构..." 这类合法长前导）：
 *   1. normalizedToolCalls 存在（工具调用回合铁证——最终回复轮必然无工具调用）
 *   2. reasoningContent 为空（模型本该把这段放 thinking 却放错了通道）
 *   3. content.trim() 长度 ∈ (0, MAX_LEN)（短碎片判据，MAX_LEN 默认 80）
 *
 * 降级动作由消费方（session.ts createChatCompletionStream / createLlmMessageStream
 * 两处流式聚合器）执行——把 content 并入 reasoning_content、content 置空，让
 * buildAssistantMessage 经 meta.asThinking 标记进入宿主思考区渲染路径。
 *
 * @param param 判据输入
 * @param param.normalizedToolCalls 工具调用回合的 tool_calls 数组（非 null/undefined 即存在）
 * @param param.reasoningContent 本回合已累积的 reasoning_content 文本
 * @param param.content 本回合已累积的 content 文本（正文通道）
 * @param param.maxLen 碎片长度上限，默认 80
 * @returns true 表示应降级（content 并入 reasoning、content 置空）；false 表示保持原样
 *
 * @example
 * shouldDemoteToolCallFragment({ normalizedToolCalls: [call], reasoningContent: "", content: "数据库连接池异常" })
 * // → true（核心命中：工具轮 + 无 thinking + 6 字短碎片）
 *
 * shouldDemoteToolCallFragment({ normalizedToolCalls: [call], reasoningContent: "",
 *   content: "好的，让我先检查一下项目结构、登录相关的路由配置、数据库连接方式和错误处理机制，然后给你一份完整的排查方案" })
 * // → false（长前导，合法叙述，≥ 80 字不误伤）
 *
 * shouldDemoteToolCallFragment({ normalizedToolCalls: [call], reasoningContent: "让我想想...", content: "好的" })
 * // → false（reasoning 通道正常产出，降级不触发）
 *
 * shouldDemoteToolCallFragment({ normalizedToolCalls: undefined, reasoningContent: "", content: "好的" })
 * // → false（content-only 回合，没有工具调用→不降级；合法短回复不误伤）
 */
export function shouldDemoteToolCallFragment(param: {
  normalizedToolCalls: unknown[] | null | undefined;
  reasoningContent: string;
  content: string;
  maxLen?: number;
}): boolean {
  const { normalizedToolCalls, reasoningContent, content, maxLen = 80 } = param;
  // 条件 1：工具调用回合铁证（最终回复轮必然无工具调用，碎片只在工具轮中间产出）
  if (!normalizedToolCalls || normalizedToolCalls.length === 0) return false;
  // 条件 2：reasoning 通道为空——模型本该把这段放 thinking 却放错了通道
  if (reasoningContent && reasoningContent.length > 0) return false;
  // 条件 3：content 短（∈ (0, maxLen)）——排除合法长前导叙述
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length >= maxLen) return false;
  return true;
}
