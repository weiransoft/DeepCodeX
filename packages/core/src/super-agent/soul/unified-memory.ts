/**
 * Soul 记忆 ↔ V2 记忆的双向映射（纯函数层）
 *
 * ## 问题
 *
 * 同一句「主仓库用 pnpm，提交走 conventional」可能被记两次：
 * `/memory add` 写进 `~/.deepcode/memory/global.json`，
 * 人格面板写进 `~/.deepcode/soul/memory.json`。
 * 两个文件互相不知道对方存在，于是：
 *
 * - 用户在 `/memory` 里记下的事，司南在对话里读不到；
 * - 司南记住的事，`/memory list` 里看不到，用户无法审计；
 * - 两边各衰减各的，同一条事实出现两个强度。
 *
 * 「加一个互相同步的定时任务」是错的解法——同步一旦漏一次就会分叉，
 * 而且两份数据的冲突规则没人说得清。这里改成**一份存储，两种视图**：
 *
 * ```
 * ~/.deepcode/memory/global.json         ← 唯一物理落点（V2 MemoryStore）
 * <projectRoot>/.deepcode/memory/project.json
 * ```
 *
 * ## 两种条目怎么共存
 *
 * | 来源 | 写入方 | 落盘形态 | 读回 Soul | 引擎是否写回 |
 * |---|---|---|---|---|
 * | Soul 新建/观察 | `SoulEngine.remember/observe` | `MemoryEntry` + `metadata.soul` | 无损还原 | 是 |
 * | V2 既有（/memory、7 维度、facts、experience） | 其它模块 | 原样 | 只读映射 | 否 |
 *
 * 关键在最后一行：V2 条目**只读**。如果引擎把它们也写回，`facts` 会被降级成
 * 一条普通 JSON 文本，7 维度的结构也会丢——那不是统一，是吞并。
 *
 * ## 为什么强度放 `confidence`
 *
 * V2 的 `confidence`（置信度）与 Soul 的 `strength`（强度）语义不完全相同，
 * 但都是「这条有多可信、多值得占提示词预算」，落在同一列上最省事。
 * 真正需要精确还原的字段（分类、标题、敏感性、激活计数）全部塞进
 * `metadata.soul`，读回时优先用它，缺失才走推断。
 *
 * ## 为什么这一层不碰文件
 *
 * 本模块只有纯函数与纯类型：给 `MemoryEntry`，出 `SoulMemory`，反之亦然。
 * 真正的读写（以及旧文件迁移）在适配层 `super-agent/soul-memory-store.ts`——
 * `soul/` 属内核目录，按 `eslint.config.mjs` 的内核门禁不得 `import node:fs`，
 * 也不得值导入 `v2/*`。这样拆分后，映射逻辑可以单测、可以复用，
 * I/O 集中在一处可审计。
 *
 * @module super-agent/soul/unified-memory
 */

import type { MemoryEntry, MemoryType } from "../../v2/memory/types.js";
import { classifyMemoryText } from "./taxonomy.js";
import type { MemoryCategory, MemorySensitivity, SoulMemory } from "./types.js";

/** 标记条目来自 Soul 层（`tags` 里的一枚，便于人工排查） */
const SOUL_TAG = "soul";

/** `metadata` 里存放 Soul 原始字段的键 */
const SOUL_META_KEY = "soul";

/** 判定「这条属于 Soul 层」时读取的元数据形状 */
interface SoulMeta {
  /** 元数据版本（当前 1，便于未来加字段） */
  readonly v: 1;
  readonly category: MemoryCategory;
  readonly title: string;
  readonly key: string;
  readonly sensitivity: MemorySensitivity;
  readonly activationCount: number;
  readonly strength: number;
  readonly lastRecalledAt?: string;
}

/**
 * V2 七维度条目 → Soul 分类
 *
 * 这六个键来自 `UserGlobalMemoryManager`，它们本身是**没有分类**的自由文本，
 * 只能按语义硬映射一次；映射错了也只是排序靠后，不会丢内容。
 */
const DIMENSION_CATEGORY: Readonly<Record<string, MemoryCategory>> = {
  workContext: "project",
  personalContext: "preference",
  topOfMind: "preference",
  recentMonths: "preference",
  earlierContext: "domain",
  longTermBackground: "domain",
};

/** V2 七维度条目的中文标题 */
const DIMENSION_TITLE: Readonly<Record<string, string>> = {
  workContext: "工作上下文",
  personalContext: "个人偏好",
  topOfMind: "当前关注",
  recentMonths: "近几个月",
  earlierContext: "早期上下文",
  longTermBackground: "长期背景",
  facts: "已确认事实",
};

/** 凭证类键名特征（用于给 V2 条目补敏感性） */
const SECRET_KEY_PATTERN = /(password|passwd|token|secret|api[-_]?key|credential|密码|口令|密钥|凭据)/i;

/**
 * 作用域 → V2 记忆类型
 *
 * `experience`（跨项目经验）在读取时并入全局作用域：它对「怎么做事」有用，
 * 但写入永远只写 `user_global`，免得把经验文件改坏。
 *
 * @param scope 作用域
 * @returns V2 类型
 */
export function typeForScope(scope: "global" | "project"): MemoryType {
  return scope === "project" ? "project" : "user_global";
}

/**
 * 判断一条 V2 条目是否由 Soul 层写入
 *
 * @param entry V2 条目
 * @returns 是否 Soul 条目
 */
export function isSoulEntry(entry: MemoryEntry): boolean {
  const meta = entry.metadata?.[SOUL_META_KEY];
  return typeof meta === "object" && meta !== null;
}

/**
 * 取 Soul 元数据（不合法返回 null）
 *
 * @param entry V2 条目
 * @returns 元数据或 null
 */
function readSoulMeta(entry: MemoryEntry): SoulMeta | null {
  const raw = entry.metadata?.[SOUL_META_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.category !== "string" || typeof record.key !== "string") return null;
  if (typeof record.title !== "string" || typeof record.strength !== "number") return null;
  return {
    v: 1,
    category: record.category as MemoryCategory,
    title: record.title,
    key: record.key,
    sensitivity: record.sensitivity === "secret" ? "secret" : "normal",
    activationCount: typeof record.activationCount === "number" ? record.activationCount : 0,
    strength: record.strength,
    lastRecalledAt: typeof record.lastRecalledAt === "string" ? record.lastRecalledAt : undefined,
  };
}

/**
 * Soul 条目 → V2 条目
 *
 * @param entry Soul 记忆
 * @param type 目标类型
 * @returns V2 条目
 */
export function soulEntryToMemoryEntry(entry: SoulMemory, type: MemoryType): MemoryEntry {
  const meta: SoulMeta = {
    v: 1,
    category: entry.category,
    title: entry.title,
    key: entry.key,
    sensitivity: entry.sensitivity,
    activationCount: entry.activationCount,
    strength: entry.strength,
    lastRecalledAt: entry.lastRecalledAt,
  };
  const tags = [SOUL_TAG, entry.category, ...(entry.sensitivity === "secret" ? ["secret"] : []), ...(entry.tags ?? [])];
  return {
    id: entry.id,
    type,
    // 键加 `soul.` 前缀：V2 侧一眼能看出这条来自人格层，也避免和
    // `/memory add` 用同名键时互相覆盖（V2 的 key 是用户自由输入的）
    key: `soul.${entry.key}`,
    value: entry.value,
    confidence: clamp01(entry.strength),
    source:
      entry.source === "user_explicit"
        ? "user_explicit"
        : entry.source === "observed"
          ? "auto_extracted"
          : "system_default",
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    tags: [...new Set(tags)],
    metadata: { [SOUL_META_KEY]: meta },
  };
}

/**
 * 取条目标题
 *
 * @param entry V2 条目
 * @returns 标题
 */
function nativeTitle(entry: MemoryEntry): string {
  const known = DIMENSION_TITLE[entry.key];
  if (known !== undefined) return known;
  // 经验记忆的 key 往往是执行记录 id，标题取正文首行更有信息量
  const firstLine = entry.value.split(/\r?\n/).find((line) => line.trim().length > 0) ?? entry.key;
  const cleaned = firstLine.replace(/^[\s\-*•\d.、)]+/, "").trim();
  if (cleaned.length === 0) return entry.key;
  return cleaned.length <= 24 ? cleaned : `${cleaned.slice(0, 24)}…`;
}

/**
 * 推断 V2 条目的分类
 *
 * @param entry V2 条目
 * @returns 分类
 */
function nativeCategory(entry: MemoryEntry): MemoryCategory {
  const known = DIMENSION_CATEGORY[entry.key];
  if (known !== undefined) return known;
  // 键名比正文更能说明「这是不是凭证」：`db_password` 的正文是一串乱码，
  // 按正文分类只会得到 preference
  if (SECRET_KEY_PATTERN.test(entry.key)) return "credential";
  const tagged = entry.tags?.find((tag): tag is MemoryCategory => isCategory(tag));
  if (tagged !== undefined) return tagged;
  if (entry.type === "experience") return "lesson";
  // 键名通常比正文更能说明「这是哪类事」（deploy_host / test_command）
  return classifyMemoryText(`${entry.key} ${entry.value}`).category;
}

/**
 * 判断字符串是否为记忆分类
 *
 * @param value 待判定值
 * @returns 是否分类
 */
function isCategory(value: string): value is MemoryCategory {
  return (
    value === "project" ||
    value === "deploy" ||
    value === "credential" ||
    value === "convention" ||
    value === "environment" ||
    value === "command" ||
    value === "preference" ||
    value === "lesson" ||
    value === "people" ||
    value === "domain"
  );
}

/**
 * 判断 V2 条目是否该按凭证处理
 *
 * @param entry V2 条目
 * @param category 已推断的分类
 * @returns 敏感性
 */
function nativeSensitivity(entry: MemoryEntry, category: MemoryCategory): MemorySensitivity {
  if (category === "credential") return "secret";
  if (entry.tags?.includes("secret") === true) return "secret";
  return SECRET_KEY_PATTERN.test(entry.key) ? "secret" : "normal";
}

/**
 * V2 条目 → Soul 条目（不含 facts 展开）
 *
 * @param entry V2 条目
 * @returns Soul 记忆
 */
function nativeToSoul(entry: MemoryEntry): SoulMemory {
  const category = nativeCategory(entry);
  const sensitivity = nativeSensitivity(entry, category);
  return {
    id: entry.id,
    category,
    // `v2.` 前缀保证与 Soul 自己的 key 不撞：引擎按 category+key 去重
    key: `v2.${entry.type}.${entry.key}`,
    // 凭证条目的标题用键名而不是正文：正文就是密码本身，
    // 拿它当标题等于把明文写进提示词与界面
    title: sensitivity === "secret" ? `凭据：${entry.key.slice(0, 20)}` : nativeTitle(entry),
    value: entry.value,
    sensitivity,
    strength: clamp01(entry.confidence),
    activationCount: 0,
    source:
      entry.source === "user_explicit"
        ? "user_explicit"
        : entry.source === "system_default"
          ? "system_default"
          : "observed",
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    origin: "v2",
  };
}

/**
 * 解析 `facts` 条目的 JSON 值
 *
 * 导出给适配层的 `remove()` 用：删单条事实时必须回到这条 JSON 里摘掉，
 * 否则「忘掉」只是把界面上的字删了，刷新又回来。
 *
 * @param value 原始 JSON 字符串
 * @returns 事实数组（解析失败返回 null，调用方按「不是 facts 结构」处理）
 */
export function parseFacts(value: string): Record<string, unknown>[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

/**
 * 把 `facts` 条目展开成多条记忆
 *
 * `UserGlobalMemoryManager` 把最多 100 条事实塞进**一条** `MemoryEntry` 的 JSON
 * 字符串里。原样喂给提示词会得到一坨 JSON，等于没记；这里按条拆开，
 * 让每条事实各自参与召回打分。
 *
 * @param entry V2 条目
 * @returns 展开后的记忆（不是 facts 条目返回 null）
 */
function expandFacts(entry: MemoryEntry): SoulMemory[] | null {
  if (entry.key !== "facts") return null;
  const parsed = parseFacts(entry.value);
  if (parsed === null) return null;

  const memories: SoulMemory[] = [];
  for (const record of parsed) {
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (content.length === 0) continue;
    const id = typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;
    const category = classifyMemoryText(content).category;
    const confidence = typeof record.confidence === "number" ? clamp01(record.confidence) : 0.6;
    const createdAt = typeof record.createdAt === "string" ? record.createdAt : entry.createdAt;
    const lastAccessedAt = typeof record.lastAccessedAt === "string" ? record.lastAccessedAt : createdAt;
    memories.push({
      // 用事实自己的 id（UUID）：它稳定，且「忘掉」时能精确命中
      id: id ?? `v2fact-${hashText(content)}`,
      category,
      key: `v2.fact.${id ?? hashText(content)}`,
      title: nativeTitle({ ...entry, key: "fact", value: content }),
      value: content,
      sensitivity: nativeSensitivity(entry, category),
      strength: confidence,
      activationCount: typeof record.accessCount === "number" ? Math.max(0, record.accessCount) : 0,
      source: "user_explicit",
      createdAt,
      updatedAt: lastAccessedAt,
      lastRecalledAt: lastAccessedAt,
      origin: "v2",
    });
  }
  return memories;
}

/**
 * V2 条目 → Soul 条目（含 facts 展开）
 *
 * @param entry V2 条目
 * @returns Soul 记忆数组
 */
export function memoryEntryToSoul(entry: MemoryEntry): SoulMemory[] {
  const meta = readSoulMeta(entry);
  if (meta !== null) {
    return [
      {
        id: entry.id,
        category: meta.category,
        key: meta.key,
        title: meta.title,
        value: entry.value,
        sensitivity: meta.sensitivity,
        strength: meta.strength,
        activationCount: meta.activationCount,
        source:
          entry.source === "user_explicit"
            ? "user_explicit"
            : entry.source === "system_default"
              ? "system_default"
              : "observed",
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        lastRecalledAt: meta.lastRecalledAt,
        tags: entry.tags?.filter((tag) => tag !== SOUL_TAG),
      },
    ];
  }
  const facts = expandFacts(entry);
  if (facts !== null) return facts;
  // 维度值为空字符串时没有信息量，直接跳过（否则提示词里会出现空条目）
  if (entry.key in DIMENSION_TITLE && entry.value.trim().length === 0) return [];
  return [nativeToSoul(entry)];
}

/**
 * 把数值夹到 0~1
 *
 * @param value 原值
 * @returns 夹紧值
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.6;
  return Math.max(0, Math.min(1, value));
}

/**
 * 稳定短哈希（用于没有 id 的事实）
 *
 * @param text 文本
 * @returns 6 位 36 进制哈希
 */
function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 1_000_000_007;
  }
  return hash.toString(36);
}
