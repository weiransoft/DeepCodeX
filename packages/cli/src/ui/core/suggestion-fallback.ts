/**
 * 建议循环客户端兜底（2026-09-03；T1 下沉改造 2026-09-24）
 *
 * 设计依据：docs/dev/eag-web-sedimentation-fixes.md §2.1（T1 装配下沉·方案 A）
 *
 * 背景：系统提示词纪律（F4"命令执行纪律"）禁止模型在收到任务后回复"建议执行 /xxx"，
 * 但提示词无法 100% 约束模型行为。当 LLM 回合以纯文本结束（无工具调用）且回复中
 * 出现"建议执行 /xxx"句式时，客户端自动把该命令注入执行，打破"模型反复建议、
 * 命令永不执行"的建议循环。
 *
 * 与 App.tsx handlePrompt finally 块配合工作，完整防线分四层：
 * 1. 提取层（core extractSuggestedCommandText，本文件 re-export）：从回合收尾文本中
 *    提取建议的命令字符串（F9-v2：参数捕获支持单/双引号包裹的中文参数）；
 * 2. 校验层（App.tsx parseSlashCommandKind）：命令必须是 BUILTIN_SLASH_COMMANDS 中的
 *    内置命令，否则视为 LLM 幻觉，静默放弃；
 * 3. 执行层（App.tsx）：只有 kind 落在 AUTO_EXECUTABLE_COMMAND_KINDS 白名单内才注入执行，
 *    且同一 kind 每个会话只自动执行一次（防循环）。
 * 4. EAG 执行层（F9-v2，App.tsx）：PromptSubmission.command 体系外的 EAG 命令经
 *    extractAutoExecutableEagCommandName + AUTO_EXECUTABLE_EAG_COMMANDS 校验后，
 *    走纯文本注入通道直达 core session.ts 的 EagCommandParser（EAG 命令本身不在
 *    第 2/3 层体系内）。
 *
 * T1 下沉说明（2026-09-24）：
 * - EAG 三件套（AUTO_EXECUTABLE_EAG_COMMANDS / extractAutoExecutableEagCommandName /
 *   extractSuggestedCommandText）已迁移至 core `packages/core/src/eag/suggestion-auto.ts`
 *   （CLI / Web 共享单一数据源），本文件 re-export 保持既有 import 路径零修改；
 * - AUTO_EXECUTABLE_COMMAND_KINDS 属 CLI slash 体系（内置命令 kind 白名单），
 *   按设计文档留在本文件不动。
 */

// EAG 白名单三件套：core 单一数据源薄壳转发（行为逐字节不变）
export {
  AUTO_EXECUTABLE_EAG_COMMANDS,
  extractAutoExecutableEagCommandName,
  extractSuggestedCommandText,
} from "@vegamo/deepcode-core";

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
