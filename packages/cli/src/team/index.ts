/**
 * Team CLI 模块统一出口
 *
 * 提供多角色协同调度的命令行入口
 * 严格遵循 user rules：禁止 mock/占位/简化
 */

export { executeTeamCommand, formatTeamHelp } from "./team-cmd.js";
export type { TeamSubcommand, TeamCommandArgs } from "./team-cmd.js";
