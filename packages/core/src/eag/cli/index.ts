/**
 * EAG CLI 模块 barrel（§5 S3 改进方案 D-S3-1）
 *
 * 导出 EagCommandParser 类与 EagCommand 类型联合，供 session.ts 与外部消费者复用。
 *
 * 设计原则（§5.12.4 G-A6d）：
 * - 类型与值分离导出（type-only re-export 避免运行期循环依赖）
 * - 不可变优先：EAG_COMMAND_STRINGS 通过 Object.freeze 冻结
 * - 独立函数 extractDeployRequestFromPrompt 供 session.ts 构造 messageParams 时调用
 * - EAG-P5 Phase 5.3 新增：extractEagAutonomousRequestFromPrompt + EagAutonomousCommandHandler
 *
 * @module eag/cli
 */

// EagCommandParser 类与独立函数（值导出，含运行期实现）
export { EagCommandParser, EAG_COMMAND_STRINGS, extractDeployRequestFromPrompt } from "./eag-command-parser";

// EagCommand 类型联合与 DeployRequest 接口（类型导出，discriminated union）
// ADR-DI-001 §7.4.1 新增：7 个动态指令注入命令 payload 类型
export type {
  EagCommand,
  DeployRequest,
  InjectCommandRequest,
  BgCommandRequest,
  TasksCommandRequest,
  FgCommandRequest,
  CancelCommandRequest,
  ResumeCommandRequest,
} from "./eag-command-parser";

// EAG-P5 Phase 5.3 TASK-P5-3.1-005：/eag-autonomous CLI 命令处理器（值导出，含运行期实现）
// - EagAutonomousCommandHandler：命令处理器类，接收 AutonomousOrchestrator 实例并执行 4 阶段循环
// - extractEagAutonomousRequestFromPrompt：独立函数，从命令字符串解析参数
// - EAG_AUTONOMOUS_COMMAND_PREFIX：命令前缀常量（Object.freeze 冻结）
// - EAG_AUTONOMOUS_CONFIRMATION_VALUES：合法 confirmation 取值集合（Object.freeze 冻结）
// EAG-P5 TASK-P5-3.1-005/006 v1.1 新增（设计文档 §3.5）：
// - extractEagAutonomousStatusRequestFromPrompt：从 /eag-autonomous-status 命令字符串解析 runId
// - extractEagAutonomousStopRequestFromPrompt：从 /eag-autonomous-stop 命令字符串解析 runId
export {
  EagAutonomousCommandHandler,
  extractEagAutonomousRequestFromPrompt,
  extractEagAutonomousStatusRequestFromPrompt,
  extractEagAutonomousStopRequestFromPrompt,
  EAG_AUTONOMOUS_COMMAND_PREFIX,
  EAG_AUTONOMOUS_CONFIRMATION_VALUES,
} from "./eag-autonomous-command";

// EAG-P5 Phase 5.3 TASK-P5-3.1-005：/eag-autonomous 命令相关类型（类型导出）
// EAG-P5 TASK-P5-3.1-005/006 v1.1 新增：EagAutonomousStatusRequest / EagAutonomousStopRequest
export type {
  EagAutonomousRequest,
  EagAutonomousCommandResult,
  EagAutonomousConfirmation,
  EagAutonomousStatusRequest,
  EagAutonomousStopRequest,
} from "./eag-autonomous-command";

// Loop-Graph 融合方案 Phase 5：/eag-graph CLI 命令处理器（值导出，含运行期实现）
// - EagGraphCommandHandler：命令处理器类，接收 GraphLoopOrchestrator 实例并执行图遍历
// - extractEagGraphRequestFromPrompt：独立函数，从命令字符串解析参数
// - EAG_GRAPH_COMMAND_PREFIX：命令前缀常量
export {
  EagGraphCommandHandler,
  extractEagGraphRequestFromPrompt,
  EAG_GRAPH_COMMAND_PREFIX,
} from "./eag-graph-command";

// Loop-Graph 融合方案 Phase 5：/eag-graph 命令相关类型（类型导出）
export type { EagGraphRequest, EagGraphCommandResult } from "./eag-graph-command";
