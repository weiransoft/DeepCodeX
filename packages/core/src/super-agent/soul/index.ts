/**
 * Soul 层对外出口
 *
 * 内核侧纯函数集合：四层人格（`presets`）、记忆分类（`taxonomy`）、
 * 召回整理（`recall`）、渲染（`render`）、运行时（`engine`）。
 * 文件 I/O 在 `../soul-io.ts`——本目录零 I/O，受 ESLint 内核门禁约束。
 *
 * @module super-agent/soul
 */

export type {
  CommunicationStyle,
  CoreEssence,
  DecisionStyle,
  EmotionalState,
  EmotionalTone,
  ExpressionStyle,
  MemoryCategory,
  MemoryGroup,
  MemoryItemView,
  MemorySensitivity,
  MoralPrinciple,
  NameIdentity,
  OceanTraits,
  OrganizeReport,
  OriginStory,
  PersonalityMatrix,
  RecalledMemory,
  Soul,
  SoulAvatarConfig,
  SoulCompanionConfig,
  SoulConfig,
  SoulMemory,
  SoulMemoryFile,
  SoulMemoryStore,
  SoulMode,
  SoulSnapshot,
  SoulVoiceConfig,
  UserProfile,
  VoiceEngine,
} from "./types.js";

export type { CategoryDefinition, ClassificationResult } from "./taxonomy.js";
export type { RecallOptions } from "./recall.js";
export type { RenderOptions } from "./render.js";
export type { RememberResult, ScopedSoulStore, SoulEngineOptions } from "./engine.js";

export {
  AVATAR_DATA_URL_MAX,
  DEFAULT_SOUL_CONFIG,
  DEFAULT_VOICE_DESCRIPTION,
  DEFAULT_VOICE_ENDPOINT,
  DEFAULT_WAKE_WORD,
  VOICE_ENGINES,
  VOICE_PRESETS,
  VOICE_SPEED_MAX,
  VOICE_SPEED_MIN,
  WAKE_WORD_MAX_LENGTH,
  defaultVoiceConfig,
  findVoicePreset,
  findCompanionPreset,
  normalizeAvatarConfig,
  normalizeCompanionConfig,
  normalizeSoulConfig,
  normalizeVoiceConfig,
  soulModeLabel,
  soulModeOptions,
} from "./config.js";

// 语音能力的平台默认值（有本机 MLX 语音模型的平台默认开，其余默认关）
export { defaultSpeakReplies, defaultVoiceEnabled, isVoiceCapablePlatform } from "./platform.js";

export {
  COMPANION_PRESETS,
  DEFAULT_COMPANION_CONFIG,
  SOUL_MODES,
  applySoulMode,
  parseSoulMode,
  renderModeSection,
} from "./modes.js";

// 注意：这里只导出**纯映射**。`UnifiedSoulStore` 与旧文件迁移需要
// `node:fs` 与 `v2/MemoryStore`，按内核门禁不得出现在 `soul/` 下，
// 由适配层 `super-agent/soul-memory-store.ts` 提供并从上层 barrel 导出。
export { isSoulEntry, memoryEntryToSoul, soulEntryToMemoryEntry } from "./unified-memory.js";

export {
  MEMORY_CATEGORIES,
  allCategories,
  categoryDefinition,
  categoryLabel,
  classifyMemoryText,
  emptyCategoryCount,
  isSecretCategory,
  suggestMemoryKey,
} from "./taxonomy.js";

export {
  buildMemory,
  countByCategory,
  deriveLabel,
  deriveSecretTitle,
  emptyMemoryFile,
  groupByCategory,
  memoryFreshness,
  memoryImportance,
  missingCategories,
  normalizeMemoryFile,
  organizeMemories,
  recallMemories,
  scoreMemory,
  upsertMemory,
} from "./recall.js";

export {
  DEFAULT_USER_PROFILE,
  SINAN_EMOTION,
  SINAN_ESSENCE,
  SINAN_EXPRESSION,
  SINAN_PERSONALITY,
  SINAN_PRESET_NAME,
  TONE_DIRECTIVES,
  TONE_LABELS,
  createSinanSoul,
  toneLabel,
  withMemories,
} from "./presets.js";

export {
  buildSoulSnapshot,
  categoryHints,
  describeOcean,
  memoryLabel,
  redactSecret,
  renderSoulPrompt,
} from "./render.js";

export { SoulEngine, defaultTitle, detectTone } from "./engine.js";
