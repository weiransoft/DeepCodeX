import {
  getThinkingOptionIndex,
  MODEL_COMMAND_MODELS,
  MODEL_COMMAND_THINKING_OPTIONS,
} from "./components/ModelsDropdown";

export { getThinkingOptionIndex, MODEL_COMMAND_MODELS, MODEL_COMMAND_THINKING_OPTIONS };
export { buildPromptDraftFromSessionMessage } from "./utils";
export {
  disableTerminalExtendedKeys,
  enableTerminalExtendedKeys,
  getPromptCursorPlacement,
  isPromptCursorAtWrapBoundary,
  resolvePromptTerminalCursorPosition,
} from "./hooks/cursor";
export { default as AppContainer } from "./views/AppContainer";
export { AskUserQuestionPrompt } from "./views/AskUserQuestionPrompt";
export {
  PlanImplementationPrompt,
  extractProposedPlan,
  getImplementationPrompt,
  getPlanImplementationChoice,
} from "./views/PlanImplementationPrompt";
export { MessageView } from "./components";
export { parseDiffPreview } from "./components/MessageView/utils";
export {
  PromptInput,
  IMAGE_ATTACHMENT_CLEAR_HINT,
  formatImageAttachmentStatus,
  formatSelectedSkillsStatus,
  addUniqueSkill,
  toggleSkillSelection,
  removeCurrentSlashToken,
  isClearImageAttachmentsShortcut,
  isRawModeShortcut,
  getPromptReturnKeyAction,
  renderBufferWithCursor,
  buildInitPromptSubmission,
  type PromptSubmission,
  type PromptDraft,
} from "./views/PromptInput";
export { SessionList, formatSessionTitle, filterSessions, formatSessionStatus } from "./views/SessionList";
export { ThemedGradient } from "./views/ThemedGradient";
export { UpdatePrompt, type UpdatePromptChoice } from "./views/UpdatePrompt";
export { WelcomeScreen, formatHomeRelativePath, buildWelcomeTips } from "./views/WelcomeScreen";
export {
  findPendingAskUserQuestion,
  formatAskUserQuestionAnswers,
  formatAskUserQuestionDecline,
  type AskUserQuestionOption,
  type AskUserQuestionItem,
  type PendingAskUserQuestion,
  type AskUserQuestionAnswers,
} from "./core/ask-user-question";
export { readClipboardImage, type ClipboardImage } from "./core/clipboard";
export { buildLoadingText, type LoadingTextInput } from "./core/loading-text";
export { renderMarkdown, renderMarkdownSegments, type MarkdownSegment } from "./components/MessageView/markdown";
export {
  EMPTY_BUFFER,
  insertText,
  backspace,
  deleteForward,
  moveLeft,
  moveRight,
  moveWordLeft,
  moveWordRight,
  moveUp,
  moveDown,
  moveLineStart,
  moveLineEnd,
  killLine,
  deleteWordBefore,
  deleteWordAfter,
  reset,
  isEmpty,
  getCurrentSlashToken,
  type PromptBufferState,
} from "./core/prompt-buffer";
export {
  BUILTIN_SLASH_COMMANDS,
  buildSlashCommands,
  filterSlashCommands,
  findExactSlashCommand,
  // F2 修复：唯一前缀匹配（残缺命令如 "/revi" 自动补全）
  findUniquePrefixSlashCommand,
  // F1 修复：残缺命令首 token 归一化为完整命令 label
  normalizeSlashCommandText,
  // fork 特有：格式化内置命令完整列表（/review、/quality 等帮助文本）
  formatBuiltinCommandList,
  formatSlashCommandDescription,
  formatSlashCommandLabel,
  type SlashCommandKind,
  type SlashCommandItem,
} from "./core/slash-commands";
export {
  filterFileMentionItems,
  formatFileMentionPath,
  getCurrentFileMentionToken,
  replaceCurrentFileMentionToken,
  scanFileMentionItems,
  type FileMentionItem,
  type FileMentionToken,
} from "./core/file-mentions";
export { findExpandedThinkingId, isCollapsedThinking } from "./core/thinking-state";
// 上游 v0.3.1 新增 buildPluginRateLimitHintText：插件限流提示文本
export { buildExitSummaryText, buildPluginRateLimitHintText, buildResumeHintText } from "./exit-summary";
