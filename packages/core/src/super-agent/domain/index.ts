/**
 * Super Agent 领域层出口
 *
 * 领域层是**零 I/O、零框架依赖**的纯逻辑层：类型 + 谓词 + ID + 错误。
 * 单独出口便于单测直接引入，不必牵动持久层与适配层。
 *
 * @module super-agent/domain/index
 */

export * from "./types.js";
export * from "./ids.js";
export * from "./errors.js";
