/**
 * EAG 动态编排建议层公共导出
 *
 * @module eag/dynamic
 */

export {
  EagDynamicSuggester,
  createEagDynamicSuggester,
  type EagCommandKind,
  type EagClarificationOption,
  type EagDynamicSuggestion,
  type EagDynamicSuggesterOptions,
  type EagDynamicContext,
  type DynamicCommandCategory,
  type DynamicCommandDescriptor,
} from "./eag-dynamic-suggester";

export { buildEagSuggestionPrompt, type EagSuggestionPromptContext } from "./prompts/eag-suggestion-prompt";

// T02：Skill/Agent 沉淀建议器（对话 → 挖掘 → 沉淀闭环的分析环节）
export {
  SedimentationSuggester,
  computeSedimentationFingerprint,
  type SedimentationSuggestion,
  type SedimentationSuggesterDeps,
} from "./sedimentation-suggester";
export {
  buildSedimentationPrompt,
  SEDIMENTATION_MAX_TURNS,
  type SedimentationPromptContext,
  type SedimentationPromptMessage,
  type SedimentationPromptTurn,
  type RawSedimentationOutput,
  type RawSedimentationSuggestion,
} from "./prompts/sedimentation-prompt";

// P3：Finding 四要素契约（沉淀建议 → 证据绑定 → deferred 池）
export {
  validateFinding,
  partitionByEvidence,
  FINDING_SEVERITIES,
  FINDING_TEXT_MAX_CHARS,
  type AgentFinding,
  type FindingSeverity,
  type FindingEvidenceRef,
  type FindingPartition,
} from "./finding";
