/**
 * EAG Command Runner（兼容性重导出模块）
 *
 * @packageDocumentation
 * 本模块保留历史导入路径 `core/eag/cli/eag-command`，实际实现位于
 * `eag-command-parser.ts`（EagCommandParser）与 `eag-command-parser` 中的
 * `extractDeployRequestFromPrompt`。此处仅做稳定重导出，避免消费者断裂。
 */

import type { EagCommand } from "./eag-command-parser.js";

export { EagCommandParser, EAG_COMMAND_STRINGS, extractDeployRequestFromPrompt } from "./eag-command-parser.js";
export type { EagCommand, DeployRequest } from "./eag-command-parser.js";

/** 兼容别名：历史类型名 EagCommandResult ≡ EagCommand（parser 重命名前的旧导出名） */
export type EagCommandResult = EagCommand;
/** 兼容别名：历史类型名 EagCommandType ≡ EagCommand 的 kind 判别字段 */
export type EagCommandType = EagCommand["kind"];
