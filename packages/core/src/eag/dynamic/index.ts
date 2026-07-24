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
