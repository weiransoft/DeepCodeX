/**
 * 跨宿主命令层入口（L0-1，2026-11-02）
 *
 * 宿主（CLI / Web）只从这里取命令执行体与描述符，避免各自实现导致分歧。
 *
 * @module commands
 */

export * from "./types.js";
export {
  runTeamCommand,
  parseTeamCommandLine,
  formatTeamHelp,
  isTeamCommandIntent,
  extractTeamSubcommandToken,
} from "./team-command.js";
