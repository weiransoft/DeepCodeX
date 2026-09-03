/**
 * 建议循环客户端兜底（2026-09-03）：
 *
 * 背景：系统提示词纪律（F4"命令执行纪律"）禁止模型在收到任务后回复"建议执行 /xxx"，
 * 但提示词无法 100% 约束模型行为。当 LLM 回合以纯文本结束（无工具调用）且回复中
 * 出现"建议执行 /xxx"句式时，客户端自动把该命令注入执行，打破"模型反复建议、
 * 命令永不执行"的建议循环。
 *
 * 与 App.tsx handlePrompt finally 块配合工作，完整防线分三层：
 * 1. 提取层（本模块 extractSuggestedCommandText）：从回合收尾文本中提取建议的命令字符串；
 * 2. 校验层（App.tsx parseSlashCommandKind）：命令必须是 BUILTIN_SLASH_COMMANDS 中的
 *    内置命令，否则视为 LLM 幻觉，静默放弃；
 * 3. 执行层（App.tsx）：只有 kind 落在 AUTO_EXECUTABLE_COMMAND_KINDS 白名单内才注入执行，
 *    且同一 kind 每个会话只自动执行一次（防循环）。
 *
 * 本模块为纯函数模块，不依赖 React / Ink，便于单元测试。
 */

/**
 * 允许自动执行的命令 kind 白名单（仅任务执行类）。
 *
 * 设计原则：
 * - 只收录副作用可控、且正是建议循环高发的"任务执行类"命令：
 *   review（代码审查）、quality-check（质量检查）、team（多角色团队调度，
 *   含 architect/pm/coder/tester/ui 等角色快捷命令的统一映射）；
 * - 明确排除：
 *   exit/new/resume/undo（会话控制/销毁类，模型幻觉触发即事故）；
 *   cancel/bg/fg/pause（进程控制类）；
 *   continue（自动执行 /continue 本身构成循环风险）；
 *   tasks/mcp/rules/help/memory（信息展示/状态管理类，无执行价值）。
 */
export const AUTO_EXECUTABLE_COMMAND_KINDS = new Set<string>(["review", "quality-check", "team"]);

// "建议执行" + 至多 12 个非换行非斜杠字符（容忍"的/命令/反引号/，"等连接词）+ /命令名(+ASCII 参数)
// 命令名要求字母开头（与 BUILTIN_SLASH_COMMANDS 命名一致），参数只捕获 ASCII token，
// 中文散文（如"建议执行 /review 来完成代码审查"中的"来完成代码审查"）不会被误认为参数。
const SUGGESTION_COMMAND_PATTERN = /建议执行[^\n/]{0,12}\/([a-zA-Z][\w-]*)(?:[ \t]+[A-Za-z0-9_\-./@]+)*/g;

// 否定标记：当"建议执行 /xxx"是模型转述的模板约束文本（例如 F3 审查模板中的
// "严禁回复'建议执行 /review 或任何斜杠命令'"），模式前文会出现下列否定词，
// 此时该文本是"被禁止的示例"而非真正的建议，不应触发自动执行。
const NEGATION_MARKER_PATTERN = /严禁|禁止|避免|不要|不建议|不会|不必|无需/;

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
 *    （App.tsx parseSlashCommandKind + AUTO_EXECUTABLE_COMMAND_KINDS）二次校验。
 *
 * @param text assistant 回合收尾回复的完整文本
 * @returns 以 "/" 开头的命令字符串（如 "/review" 或 "/team dispatch task"）；
 *          无有效建议时返回 null
 */
export function extractSuggestedCommandText(text: string): string | null {
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
    // 否定保护：前 12 字符窗口内出现否定标记则视为转述约束文本
    const prefix = text.slice(Math.max(0, match.index - 12), match.index);
    if (NEGATION_MARKER_PATTERN.test(prefix)) {
      continue;
    }
    // 返回从 "/" 开始的完整匹配（命令名 + ASCII 参数）
    const slashOffset = match[0].indexOf("/");
    return match[0].slice(slashOffset >= 0 ? slashOffset : 0);
  }
  return null;
}
