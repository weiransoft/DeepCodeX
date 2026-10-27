/**
 * agents 模块公共 API 导出（core 单一装配源，架构 §7 共享知识 #5）
 *
 * cli/web 不得绕过本模块直接读 SKILL.md；新能力一律经 packages/core/src/index.ts 再导出。
 *
 * @module agents
 */

export { AgentRegistry, type AgentDefinition, type AgentRegistryDeps } from "./agent-registry";

// T02：沉淀落盘器（用户确认后写 SKILL.md，五条安全门槛）
export {
  SedimentationWriter,
  type SedimentationScope,
  type SedimentationDraft,
  type WriteResult,
  type SedimentationWriterDeps,
} from "./sedimentation-writer";
