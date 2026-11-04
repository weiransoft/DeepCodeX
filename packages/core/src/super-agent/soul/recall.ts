/**
 * 记忆召回与整理 —— 打分、去重、衰减
 *
 * ## 一个必须回答的问题：凭什么「想起这条」
 *
 * 提示词预算是硬约束（每轮都付）。所以召回不能是「最近 N 条」，
 * 那会让助手只记得刚聊过的闲事。这里用三项加权：
 *
 * ```
 * importance = 强度 × 0.5 + 激活频次 × 0.3 + 新鲜度 × 0.2
 * score      = importance × 类别权重
 * ```
 *
 * - **强度**来自用户显式录入（0.9）或观察所得（0.5），可人为调高调低；
 * - **激活频次**让「反复被用到的事实」浮上来（生产部署位置每天都用）；
 * - **新鲜度**让改过的地址压过旧地址（一周线性衰减到 0）；
 * - **类别权重**保证凭证 / 部署永远排在小偏好前面。
 *
 * 三项都写进 `reasons`，UI 上能回答「为什么显示这条」——可解释的召回
 * 才敢让人去删条目。
 *
 * ## 整理为什么是显式动作
 *
 * 去重与衰减会**改数据**。若在读取时顺手做，同一份记忆会随读取次数漂移，
 * 排查问题时无法复现。因此读取只打分不改写，变更全部集中在 `organize()` /
 * `upsertMemory()`，且都返回报告。
 *
 * @module super-agent/soul/recall
 */

import { categoryDefinition, emptyCategoryCount, MEMORY_CATEGORIES, suggestMemoryKey } from "./taxonomy.js";
import type { MemoryCategory, OrganizeReport, RecalledMemory, SoulMemory, SoulMemoryFile } from "./types.js";

/** 一周小时数：新鲜度衰减窗口 */
const FRESHNESS_WINDOW_HOURS = 168;

/** 强度低于此值视为休眠，不再召回 */
const DORMANT_THRESHOLD = 0.1;

/** 长期未变更（天）后的衰减步长 */
const STALE_DAYS = 30;

/** 单次衰减量 */
const DECAY_STEP = 0.1;

/**
 * 计算记忆新鲜度
 *
 * 以最后召回时间（缺失则更新时间）为基准，一周线性衰减到 0。
 *
 * @param memory 记忆条目
 * @param now 当前时间（毫秒时间戳）
 * @returns 新鲜度 0~1
 */
export function memoryFreshness(memory: SoulMemory, now: number = Date.now()): number {
  const stamp = memory.lastRecalledAt ?? memory.updatedAt;
  const parsed = Date.parse(stamp);
  if (Number.isNaN(parsed)) return 0.5;
  const hours = Math.max(0, (now - parsed) / 3_600_000);
  return Math.max(0, Math.min(1, 1 - hours / FRESHNESS_WINDOW_HOURS));
}

/**
 * 计算记忆重要度（不含类别权重）
 *
 * @param memory 记忆条目
 * @param now 当前时间（毫秒时间戳）
 * @returns 重要度 0~1
 */
export function memoryImportance(memory: SoulMemory, now: number = Date.now()): number {
  const activationFactor = Math.min(1, memory.activationCount / 10);
  const freshness = memoryFreshness(memory, now);
  return Math.max(0, Math.min(1, memory.strength * 0.5 + activationFactor * 0.3 + freshness * 0.2));
}

/**
 * 计算综合分数（含类别权重）
 *
 * @param memory 记忆条目
 * @param now 当前时间（毫秒时间戳）
 * @returns 分数 0~1 与构成说明
 */
export function scoreMemory(
  memory: SoulMemory,
  now: number = Date.now()
): { readonly score: number; readonly reasons: readonly string[] } {
  const definition = categoryDefinition(memory.category);
  const freshness = memoryFreshness(memory, now);
  const importance = memoryImportance(memory, now);
  const score = importance * definition.weight;
  const reasons = [
    `强度 ${(memory.strength * 100).toFixed(0)}%`,
    `召回 ${memory.activationCount} 次`,
    `新鲜度 ${(freshness * 100).toFixed(0)}%`,
    `类别权重 ${definition.weight.toFixed(2)}（${definition.label}）`,
  ];
  return { score, reasons };
}

/**
 * 召回选项
 */
export interface RecallOptions {
  /** 条数上限（默认 12） */
  readonly limit?: number;
  /** 当前时间（测试注入） */
  readonly now?: number;
  /** 只召回这些类别（缺省全部） */
  readonly categories?: readonly MemoryCategory[];
  /** 是否包含凭证类（凭证仍会被遮蔽，但会计入预算；默认包含以便提示「有凭证可用」） */
  readonly includeSecrets?: boolean;
}

/**
 * 召回记忆
 *
 * 过滤休眠条目（强度过低）→ 打分 → 降序 → 截断。
 * **不修改入参**：召回是只读操作，激活计数由调用方在真正使用后显式累加。
 *
 * @param memories 全部记忆
 * @param options 召回选项
 * @returns 带分数的召回结果
 */
export function recallMemories(memories: readonly SoulMemory[], options: RecallOptions = {}): RecalledMemory[] {
  const limit = options.limit ?? 12;
  const now = options.now ?? Date.now();
  const includeSecrets = options.includeSecrets ?? true;
  const allowed = options.categories === undefined ? undefined : new Set(options.categories);

  const scored: RecalledMemory[] = [];
  for (const memory of memories) {
    if (memory.strength < DORMANT_THRESHOLD) continue;
    if (allowed !== undefined && !allowed.has(memory.category)) continue;
    if (memory.sensitivity === "secret" && !includeSecrets) continue;
    const { score, reasons } = scoreMemory(memory, now);
    scored.push({ memory, score, reasons });
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    // 同分时新的在前，保证结果稳定可复现
    return right.memory.updatedAt.localeCompare(left.memory.updatedAt);
  });

  return scored.slice(0, Math.max(0, limit));
}

/**
 * 按类别分组（保持分类表顺序）
 *
 * @param memories 记忆
 * @returns 分组后的映射
 */
export function groupByCategory(memories: readonly SoulMemory[]): Map<MemoryCategory, SoulMemory[]> {
  const groups = new Map<MemoryCategory, SoulMemory[]>();
  for (const definition of MEMORY_CATEGORIES) groups.set(definition.id, []);
  for (const memory of memories) {
    const bucket = groups.get(memory.category);
    if (bucket === undefined) continue;
    bucket.push(memory);
  }
  return groups;
}

/**
 * 统计分类分布
 *
 * @param memories 记忆
 * @returns 全类别计数
 */
export function countByCategory(memories: readonly SoulMemory[]): Record<MemoryCategory, number> {
  const counts = emptyCategoryCount();
  for (const memory of memories) counts[memory.category] += 1;
  return counts;
}

/**
 * 找出尚未记录的类别
 *
 * 用途是**驱动补齐而不是假装知道**：UI 上把空类别作为提示，
 * 助手在提示词里也能说「部署位置还没记，你要现在告诉我吗」。
 *
 * @param memories 记忆
 * @returns 空类别（按分类表顺序）
 */
export function missingCategories(memories: readonly SoulMemory[]): MemoryCategory[] {
  const counts = countByCategory(memories);
  return MEMORY_CATEGORIES.filter((definition) => counts[definition.id] === 0).map((d) => d.id);
}

/**
 * 单条记忆入库（upsert）
 *
 * 同 `category + key` 视为同一事实：保留新值，强度取两者较大值并小幅提升，
 * 创建时间沿用旧条目（它确实是更早知道的）。
 *
 * @param entries 现有条目
 * @param incoming 待写入条目
 * @returns 新条目数组与动作类型
 */
export function upsertMemory(
  entries: readonly SoulMemory[],
  incoming: SoulMemory
): { readonly entries: SoulMemory[]; readonly action: "created" | "updated" } {
  const index = entries.findIndex((entry) => entry.category === incoming.category && entry.key === incoming.key);
  if (index < 0) {
    return { entries: [...entries, incoming], action: "created" };
  }
  const previous = entries[index]!;
  const merged: SoulMemory = {
    ...incoming,
    id: previous.id,
    createdAt: previous.createdAt,
    activationCount: Math.max(previous.activationCount, incoming.activationCount),
    strength: Math.min(1, Math.max(previous.strength, incoming.strength) + 0.05),
  };
  const next = entries.slice();
  next[index] = merged;
  return { entries: next, action: "updated" };
}

/**
 * 构造一条记忆
 *
 * 默认值集中在这里，避免各调用点各自编造 strength / sensitivity。
 *
 * @param input 必要字段
 * @returns 记忆条目
 */
export function buildMemory(input: {
  readonly category: MemoryCategory;
  readonly title: string;
  readonly value: string;
  readonly key?: string;
  readonly sensitivity?: "normal" | "secret";
  readonly strength?: number;
  readonly source?: SoulMemory["source"];
  readonly tags?: readonly string[];
  readonly now?: number;
}): SoulMemory {
  const timestamp = new Date(input.now ?? Date.now()).toISOString();
  const definition = categoryDefinition(input.category);
  const source = input.source ?? "user_explicit";
  const defaultStrength = source === "user_explicit" ? 0.9 : source === "observed" ? 0.5 : 0.6;
  const sensitivity = input.sensitivity ?? definition.sensitivity;
  // 凭证类标题必须脱敏：默认标题取自正文首行，会把密码原文带进 UI / 列表 / 日志。
  // 键也由脱敏标题派生——否则 `Password is Passw0rd` 会变成 key 的一部分。
  const safeTitle = sensitivity === "secret" ? deriveSecretTitle(input.title) : input.title;
  return {
    id: `mem-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    category: input.category,
    // 键由「这是什么」派生而非整句：值变了仍是同一条事实（否则改地址永远不会覆盖旧地址）
    key: input.key ?? suggestMemoryKey(input.category, deriveLabel(safeTitle)),
    title: safeTitle,
    value: input.value,
    sensitivity,
    strength: input.strength ?? defaultStrength,
    activationCount: 0,
    source,
    createdAt: timestamp,
    updatedAt: timestamp,
    tags: input.tags,
  };
}

/** 标题切分标记：出现在这些符号之前的部分才是「这是什么」，之后是「值是什么」 */
const LABEL_MARKERS = ["是", "为", "：", ":", "=", "→", "->", "在"];

/**
 * 从一句事实里提取「这是什么」的部分（不含值）
 *
 * 例：`数据库密码是 Passw0rd!2026` → `数据库密码`；
 * `生产部署在 10.0.0.8` → `生产部署`。
 *
 * 这一个函数服务两个目的：
 *
 * 1. **凭证标题**：标题会出现在列表、Web 面板与日志里，而遮蔽逻辑只覆盖 value，
 *    所以凭证标题必须先切掉值；
 * 2. **记忆键**：键是「同一事实」的判据。若键由整句派生，
 *    「部署在 10.0.0.8」和「部署在 10.0.0.9」就成了两条互不相干的事实，
 *    永远合并不掉——地址改了、旧地址还在，正是记忆系统最常见的坏味道。
 *
 * 找不到切分标记时原样返回（宁可键区分得细，也不要误合并两件不同的事）。
 *
 * @param text 原文（标题或正文首行）
 * @returns 标签（≤24 字）
 */
export function deriveLabel(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] ?? text;
  let cut = firstLine.length;
  for (const marker of LABEL_MARKERS) {
    const index = firstLine.indexOf(marker);
    if (index > 0 && index < cut) cut = index;
  }
  const label = firstLine.slice(0, cut).trim();
  if (label.length >= 2) return label.length <= 24 ? label : `${label.slice(0, 24)}…`;
  return "记录";
}

/**
 * 凭证标题脱敏
 *
 * 语义与 {@link deriveLabel} 相同，单独命名是为了让调用点读起来有意图：
 * 这里做的是**安全处理**，不是排版。
 *
 * @param title 原始标题
 * @returns 脱敏标题
 */
export function deriveSecretTitle(title: string): string {
  const label = deriveLabel(title);
  return label === "记录" ? "凭证记录" : label;
}

/**
 * 整理记忆：去重合并 + 长期未用衰减 + 休眠清理
 *
 * 三步顺序有意为之：先去重（避免重复条目各自衰减），再衰减（只对真正陈旧的动手），
 * 最后清理（强度归零的移出）。每步都计数，产出可读报告。
 *
 * @param memories 记忆
 * @param now 当前时间（毫秒时间戳）
 * @returns 整理结果与报告
 */
export function organizeMemories(
  memories: readonly SoulMemory[],
  now: number = Date.now()
): { readonly entries: SoulMemory[]; readonly report: OrganizeReport } {
  const notes: string[] = [];
  let merged = 0;

  // 第一步：同 category+key 合并（保留强度最高的那条，累加召回次数）
  const byKey = new Map<string, SoulMemory>();
  for (const memory of memories) {
    const composite = `${memory.category}::${memory.key}`;
    const existing = byKey.get(composite);
    if (existing === undefined) {
      byKey.set(composite, memory);
      continue;
    }
    merged += 1;
    const keepNewer = memory.updatedAt >= existing.updatedAt ? memory : existing;
    byKey.set(composite, {
      ...keepNewer,
      activationCount: existing.activationCount + memory.activationCount,
      strength: Math.max(existing.strength, memory.strength),
      createdAt: existing.createdAt <= memory.createdAt ? existing.createdAt : memory.createdAt,
    });
  }
  if (merged > 0) notes.push(`合并重复条目 ${merged} 条`);

  // 第二步：长期未动（> STALE_DAYS）的条目做一次衰减
  let decayed = 0;
  const decayedEntries: SoulMemory[] = [];
  for (const memory of byKey.values()) {
    const stamp = Date.parse(memory.lastRecalledAt ?? memory.updatedAt);
    const staleDays = Number.isNaN(stamp) ? 0 : (now - stamp) / 86_400_000;
    if (staleDays <= STALE_DAYS) {
      decayedEntries.push(memory);
      continue;
    }
    decayed += 1;
    decayedEntries.push({
      ...memory,
      strength: Math.max(0, memory.strength - DECAY_STEP),
      updatedAt: new Date(now).toISOString(),
    });
  }
  if (decayed > 0) notes.push(`陈旧条目 ${decayed} 条各衰减 ${DECAY_STEP}（超过 ${STALE_DAYS} 天未使用）`);

  // 第三步：休眠清理（强度低于阈值的移出，但 secret 类保留——凭证不该因冷而丢）
  const kept: SoulMemory[] = [];
  let pruned = 0;
  for (const memory of decayedEntries) {
    if (memory.strength < DORMANT_THRESHOLD && memory.sensitivity !== "secret") {
      pruned += 1;
      continue;
    }
    kept.push(memory);
  }
  if (pruned > 0) notes.push(`清理休眠条目 ${pruned} 条`);

  const byCategory = countByCategory(kept);
  const missing = MEMORY_CATEGORIES.filter((definition) => byCategory[definition.id] === 0).map(
    (definition) => definition.label
  );
  if (missing.length > 0) notes.push(`尚未记录：${missing.join("、")}`);
  if (notes.length === 0) notes.push("记忆已是最新，无需整理");

  return {
    entries: kept,
    report: {
      merged,
      pruned,
      total: kept.length,
      byCategory,
      notes,
    },
  };
}

/**
 * 构造空的记忆文件
 *
 * @param scope 作用域
 * @param now 当前时间（毫秒时间戳）
 * @returns 空文件
 */
export function emptyMemoryFile(scope: SoulMemoryFile["scope"], now: number = Date.now()): SoulMemoryFile {
  return {
    version: 1,
    scope,
    entries: [],
    lastUpdated: new Date(now).toISOString(),
  };
}

/**
 * 校验记忆文件形状
 *
 * 存储层读到的可能是人手工编辑过的 JSON——不能假设它合法。
 * 只保留字段齐全的条目，其余丢弃（丢弃不静默：调用方可用返回的 `rejected` 计数提示）。
 *
 * @param raw 原始值
 * @param scope 期望作用域
 * @returns 合法文件与丢弃计数
 */
export function normalizeMemoryFile(
  raw: unknown,
  scope: SoulMemoryFile["scope"]
): { readonly file: SoulMemoryFile; readonly rejected: number } {
  if (raw === null || typeof raw !== "object") {
    return { file: emptyMemoryFile(scope), rejected: 0 };
  }
  const record = raw as Record<string, unknown>;
  const list = Array.isArray(record.entries) ? record.entries : [];
  const validCategories = new Set(MEMORY_CATEGORIES.map((definition) => definition.id));
  const entries: SoulMemory[] = [];
  let rejected = 0;

  for (const item of list) {
    if (item === null || typeof item !== "object") {
      rejected += 1;
      continue;
    }
    const entry = item as Record<string, unknown>;
    const category = entry.category;
    if (
      typeof entry.id !== "string" ||
      typeof entry.key !== "string" ||
      typeof entry.title !== "string" ||
      typeof entry.value !== "string" ||
      typeof category !== "string" ||
      !validCategories.has(category as MemoryCategory)
    ) {
      rejected += 1;
      continue;
    }
    const sensitivity: "normal" | "secret" = entry.sensitivity === "secret" ? "secret" : "normal";
    // 读取侧的二次防线：文件可能由旧版本写入或被手工编辑过，
    // 凭证条目的标题/键里可能残留明文——统一按脱敏标题重算。
    const safeTitle = sensitivity === "secret" ? deriveSecretTitle(entry.title) : entry.title;
    entries.push({
      id: entry.id,
      category: category as MemoryCategory,
      // 旧版本可能把明文写进凭证条目的键——读取时按脱敏标签重算
      key: sensitivity === "secret" ? suggestMemoryKey(category as MemoryCategory, deriveLabel(safeTitle)) : entry.key,
      title: safeTitle,
      value: entry.value,
      sensitivity,
      strength: typeof entry.strength === "number" ? clamp01(entry.strength) : 0.6,
      activationCount: typeof entry.activationCount === "number" ? Math.max(0, entry.activationCount) : 0,
      source: entry.source === "observed" || entry.source === "system_default" ? entry.source : "user_explicit",
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date(0).toISOString(),
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString(),
      lastRecalledAt: typeof entry.lastRecalledAt === "string" ? entry.lastRecalledAt : undefined,
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
    });
  }

  return {
    file: {
      version: 1,
      scope,
      entries,
      lastUpdated: typeof record.lastUpdated === "string" ? record.lastUpdated : new Date(0).toISOString(),
    },
    rejected,
  };
}

/**
 * 把数值夹到 0~1
 *
 * @param value 原值
 * @returns 夹紧值
 */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
