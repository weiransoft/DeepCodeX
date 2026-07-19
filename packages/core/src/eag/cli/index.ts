/**
 * EAG CLI 模块 barrel（§5 S3 改进方案 D-S3-1）
 *
 * 导出 EagCommandParser 类与 EagCommand 类型联合，供 session.ts 与外部消费者复用。
 *
 * 设计原则（§5.12.4 G-A6d）：
 * - 类型与值分离导出（type-only re-export 避免运行期循环依赖）
 * - 不可变优先：EAG_COMMAND_STRINGS 通过 Object.freeze 冻结
 *
 * @module eag/cli
 */

// EagCommandParser 类（值导出，含运行期实现）
export { EagCommandParser, EAG_COMMAND_STRINGS } from "./eag-command-parser";

// EagCommand 类型联合（类型导出，discriminated union）
export type { EagCommand } from "./eag-command-parser";
