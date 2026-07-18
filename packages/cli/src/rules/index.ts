/**
 * Rules 模块入口
 *
 * 汇总导出 RLIS 规则管理 CLI 的全部公开 API。
 * 调用方可以从 `packages/cli/src/rules` 统一导入，也可以直接从 `./rules-cmd` 导入。
 *
 * 导出清单：
 * - executeRulesCommand：主命令执行器
 * - formatRulesHelp：help 文本生成
 * - RulesCommandArgs：命令参数类型
 * - RulesCommandResult：命令执行结果类型
 * - RulesSubcommand：子命令类型
 *
 * @module cli/rules/index
 */

export {
  executeRulesCommand,
  formatRulesHelp,
  type RulesCommandArgs,
  type RulesCommandResult,
  type RulesSubcommand,
} from "./rules-cmd";
