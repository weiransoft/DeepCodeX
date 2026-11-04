/**
 * SoulEngine —— 人格与记忆的运行时
 *
 * ## 边界：只做四件事
 *
 * | 动作 | 输入 | 输出 | 改数据吗 |
 * |---|---|---|---|
 * | `load` | 存储端口 | 挂好记忆的 Soul | 否 |
 * | `adapt` | 一段上下文 | 新情感状态 | 否（引擎内保留） |
 * | `remember` / `observe` | 一句话 | 入库条目 + 归类结果 | 是 |
 * | `organize` | — | 整理报告 | 是 |
 *
 * 读写分离的理由：读（渲染提示词、Web 展示）每秒都可能发生，写很贵且有副作用。
 * 把它们混在一起，就会出现「刷新一次页面把记忆衰减了一遍」这种不可复现的事。
 *
 * ## 情绪怎么变
 *
 * 参考 woagent 的 `EmotionalState.adaptToContext`，但改成**纯函数 + 引擎持有状态**：
 * 关键词命中决定基调，强度 = 基础强度 + 波动性 × 0.4（封顶 0.95）。
 * 不做无限累加——那样吵两轮就永远「绷紧了」，反而不像人。
 *
 * @module super-agent/soul/engine
 */

import { createSinanSoul } from "./presets.js";
import { applySoulMode, DEFAULT_COMPANION_CONFIG } from "./modes.js";
import { buildMemory, normalizeMemoryFile, organizeMemories, upsertMemory } from "./recall.js";
import { buildSoulSnapshot } from "./render.js";
import { classifyMemoryText } from "./taxonomy.js";
import type {
  EmotionalState,
  EmotionalTone,
  MemoryCategory,
  MemorySensitivity,
  OrganizeReport,
  Soul,
  SoulCompanionConfig,
  SoulMemory,
  SoulMemoryFile,
  SoulMemoryStore,
  SoulMode,
  SoulSnapshot,
} from "./types.js";

/**
 * 作用域化存储（全局 + 项目）
 */
export interface ScopedSoulStore {
  /** 作用域 */
  readonly scope: SoulMemoryFile["scope"];
  /** 存储端口 */
  readonly store: SoulMemoryStore;
}

/**
 * 引擎构造选项
 */
export interface SoulEngineOptions {
  /** 存储（可空——纯内存模式用于测试与「无持久化」场景） */
  readonly stores?: readonly ScopedSoulStore[];
  /** 基础 Soul（缺省为司南预设） */
  readonly soul?: Soul;
  /** 对话模式（缺省 work；companion 时按陪伴覆盖层重建人格） */
  readonly mode?: SoulMode;
  /** 陪伴模式可调项（mode=companion 时生效） */
  readonly companion?: SoulCompanionConfig;
  /** 时间源（测试注入） */
  readonly clock?: () => number;
}

/**
 * 记忆写入结果
 */
export interface RememberResult {
  /** 入库的条目 */
  readonly memory: SoulMemory;
  /** 新增还是覆盖 */
  readonly action: "created" | "updated";
  /** 归类置信度（0~1） */
  readonly confidence: number;
  /** 命中的关键词 */
  readonly matched: readonly string[];
  /** 是否由默认规则回落（未命中关键词） */
  readonly fallback: boolean;
  /** 是否因分类敏感而被标记为 secret */
  readonly secret: boolean;
}

/**
 * SoulEngine
 */
export class SoulEngine {
  /** 作用域化存储 */
  private readonly stores: readonly ScopedSoulStore[];
  /** 基础 Soul */
  private readonly baseSoul: Soul;
  /** 时间源 */
  private readonly clock: () => number;
  /** 当前记忆（内存镜像，唯一写入口） */
  private entries: SoulMemory[] = [];
  /** id → 作用域（决定写回哪个文件） */
  private originById = new Map<string, SoulMemoryFile["scope"]>();
  /** 当前情感（会话内状态，不落盘） */
  private emotion: EmotionalState;

  /**
   * 构造引擎
   *
   * @param options 构造选项
   */
  constructor(options: SoulEngineOptions = {}) {
    this.stores = options.stores ?? [];
    const base = options.soul ?? createSinanSoul();
    // 模式覆盖放在构造期：情感状态、表达风格、人格倾向一次性成型，
    // 之后 adapt/load 都在这份覆盖上工作，避免「渲染时才套壳」导致
    // 快照里的性格与提示词里的性格不一致。
    this.baseSoul = applySoulMode(
      base,
      options.mode ?? base.mode ?? "work",
      options.companion ?? DEFAULT_COMPANION_CONFIG
    );
    this.clock = options.clock ?? (() => Date.now());
    this.emotion = this.baseSoul.emotion;
  }

  /**
   * 从存储加载记忆
   *
   * 多个作用域合并时**项目优先**（更具体）：同 `category + key` 项目条目覆盖全局条目。
   * 读取失败不抛错——记忆是增强项，读不到不该让主流程挂掉。
   *
   * @returns 挂好记忆的 Soul
   */
  load(): Soul {
    const merged = new Map<string, SoulMemory>();
    this.originById = new Map();

    for (const { scope, store } of this.stores) {
      let file: SoulMemoryFile;
      try {
        file = normalizeMemoryFile(store.load(), scope).file;
      } catch {
        file = normalizeMemoryFile(undefined, scope).file;
      }
      for (const entry of file.entries) {
        const composite = `${entry.category}::${entry.key}`;
        const previous = merged.get(composite);
        // 后遍历的作用域覆盖前者；调用方按 [global, project] 顺序传入即项目优先
        merged.set(composite, entry);
        this.originById.set(entry.id, scope);
        if (previous !== undefined) this.originById.delete(previous.id);
      }
    }

    this.entries = [...merged.values()];
    return { ...this.baseSoul, memories: this.entries, emotion: this.emotion };
  }

  /**
   * 当前 Soul（含内存镜像里的记忆与情感）
   *
   * @returns Soul 聚合
   */
  soul(): Soul {
    return { ...this.baseSoul, memories: this.entries, emotion: this.emotion };
  }

  /**
   * 取快照（Web / CLI 展示）
   *
   * @param options 选项（是否显示凭证明文）
   * @returns 快照
   */
  snapshot(options: { readonly revealSecrets?: boolean } = {}): SoulSnapshot {
    return buildSoulSnapshot(this.soul(), {
      revealSecrets: options.revealSecrets ?? false,
      now: this.clock(),
    });
  }

  /**
   * 按上下文调整情感
   *
   * @param context 用户输入 / 上游交接 / 事件描述
   * @returns 新情感状态
   */
  adapt(context: string): EmotionalState {
    const detected = detectTone(context);
    // 陪伴模式下「对方搞不定」不是「要绷紧的故障」：同一句报错，工作模式该收紧
    // 语气去排障，陪伴模式该先接住挫败感。真正的紧急（事故/立刻/宕机）仍然严肃——
    // 情绪优先不等于对危险迟钝。
    const tone: EmotionalTone =
      this.baseSoul.mode === "companion" && (detected === "SERIOUS" || detected === "ANALYTICAL")
        ? isUrgentContext(context)
          ? "SERIOUS"
          : "EMPATHETIC"
        : detected;
    const volatility = this.baseSoul.emotion.volatility;
    const intensity =
      tone === this.emotion.current
        ? this.emotion.intensity
        : Math.min(0.95, Math.round((this.baseSoul.emotion.intensity + volatility * 0.4) * 100) / 100);
    this.emotion = {
      ...this.baseSoul.emotion,
      current: tone,
      intensity,
      triggeredBy: context.slice(0, 200),
      triggeredAt: new Date(this.clock()).toISOString(),
    };
    return this.emotion;
  }

  /**
   * 显式记住一条事实
   *
   * 分类可显式给（用户知道自己在记什么），也可省略由文本推断。
   * 显式分类不合法时回落推断——宁可归错也**不能丢**。
   *
   * @param input 记忆输入
   * @returns 写入结果
   */
  remember(input: {
    readonly text: string;
    readonly title?: string;
    readonly category?: MemoryCategory;
    readonly key?: string;
    readonly sensitivity?: MemorySensitivity;
    readonly strength?: number;
    readonly scope?: SoulMemoryFile["scope"];
    readonly tags?: readonly string[];
  }): RememberResult {
    const now = this.clock();
    const classification = classifyMemoryText(input.text);
    const category = input.category ?? classification.category;
    const title = input.title ?? defaultTitle(input.text);
    const memory = buildMemory({
      category,
      title,
      value: input.text,
      key: input.key,
      sensitivity: input.sensitivity,
      strength: input.strength,
      source: "user_explicit",
      tags: input.tags,
      now,
    });

    const { entries, action } = upsertMemory(this.entries, memory);
    this.entries = entries;
    const stored = entries.find((entry) => entry.category === category && entry.key === memory.key) ?? memory;
    this.originById.set(stored.id, input.scope ?? this.defaultScope());
    this.persist();

    return {
      memory: stored,
      action,
      confidence: input.category === undefined ? classification.confidence : 1,
      matched: classification.matched,
      fallback: input.category === undefined ? classification.fallback : false,
      secret: stored.sensitivity === "secret",
    };
  }

  /**
   * 观察一条事实（强度较低，可能被后续覆盖）
   *
   * 用于「对话里顺带提到」的场景：记下来但不敢当铁律，
   * 强度 0.5 让它在整理后可能被更强的事实压过。
   *
   * @param text 观察到的文本
   * @param category 分类（省略则推断）
   * @returns 写入结果
   */
  observe(text: string, category?: MemoryCategory): RememberResult {
    const now = this.clock();
    const classification = classifyMemoryText(text);
    const resolved = category ?? classification.category;
    const memory = buildMemory({
      category: resolved,
      title: defaultTitle(text),
      value: text,
      source: "observed",
      strength: 0.5,
      now,
    });
    const { entries, action } = upsertMemory(this.entries, memory);
    this.entries = entries;
    const stored = entries.find((entry) => entry.category === resolved && entry.key === memory.key) ?? memory;
    this.originById.set(stored.id, this.defaultScope());
    this.persist();
    return {
      memory: stored,
      action,
      confidence: classification.confidence,
      matched: classification.matched,
      fallback: classification.fallback,
      secret: stored.sensitivity === "secret",
    };
  }

  /**
   * 遗忘一条记忆
   *
   * @param id 记忆 ID
   * @returns 是否删除成功
   */
  forget(id: string): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const target = this.entries[index]!;
    const scope = this.originById.get(id) ?? this.defaultScope();
    this.entries = this.entries.filter((entry) => entry.id !== id);
    this.originById.delete(id);
    // V2 映射来的条目：只从内存里移掉等于「下次刷新又回来」，
    // 必须回写到它所在的 V2 文件里删——用户点「忘掉」就是真的要它消失。
    if (target.origin === "v2") {
      const owner = this.stores.find((item) => item.scope === scope);
      try {
        owner?.store.remove?.([id]);
      } catch {
        // 删除失败：内存里已移除，磁盘下次加载会重新出现——不静默假装成功
        return false;
      }
      return true;
    }
    this.persist();
    return true;
  }

  /**
   * 整理记忆并落盘
   *
   * @returns 整理报告
   */
  organize(): OrganizeReport {
    const { entries, report } = organizeMemories(this.entries, this.clock());
    this.entries = entries;
    this.persist();
    return report;
  }

  /**
   * 标记某条记忆被召回（累加激活计数）
   *
   * 由「真正用到这条记忆」的调用方触发，而不是渲染时自动累加——
   * 否则展示一次就等于用了一次，冷热判断失去意义。
   *
   * @param ids 被使用的记忆 ID
   */
  touch(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const target = new Set(ids);
    const now = new Date(this.clock()).toISOString();
    this.entries = this.entries.map((entry) =>
      target.has(entry.id) ? { ...entry, activationCount: entry.activationCount + 1, lastRecalledAt: now } : entry
    );
    this.persist();
  }

  /**
   * 记忆总数
   *
   * @returns 条数
   */
  size(): number {
    return this.entries.length;
  }

  /**
   * 默认写入作用域（有项目存储写项目，否则写全局）
   *
   * @returns 作用域
   */
  private defaultScope(): SoulMemoryFile["scope"] {
    return this.stores.some((item) => item.scope === "project") ? "project" : "global";
  }

  /**
   * 按来源作用域分片写回
   *
   * 每条记忆写回它原来的文件：跨文件搬条目会让「项目记忆」变成「全局记忆」，
   * 是隐私事故的常见来源。
   */
  private persist(): void {
    if (this.stores.length === 0) return;
    const timestamp = new Date(this.clock()).toISOString();
    for (const { scope, store } of this.stores) {
      const own = this.entries.filter(
        (entry) =>
          // V2 只读来源不写回：写回会把它降级成 soul 条目，
          // 丢掉 V2 侧的结构（例如 facts 的置信度与访问计数）
          entry.origin !== "v2" && (this.originById.get(entry.id) ?? this.defaultScope()) === scope
      );
      const file: SoulMemoryFile = { version: 1, scope, entries: own, lastUpdated: timestamp };
      try {
        store.save(file);
      } catch {
        // 写失败不抛：记忆是增强项，落盘失败不该中断当前任务（下次写入会重试）
      }
    }
  }
}

/**
 * 是否是「真的紧急」（而不是一般的挫败）
 *
 * 只认明确的危险词：事故、宕机、立刻、线上挂了。陪伴模式据此决定要不要
 * 从体谅切回严肃——两者的区别是「要不要先停手」。
 *
 * @param context 上下文
 * @returns 是否紧急
 */
export function isUrgentContext(context: string): boolean {
  const text = context.toLowerCase();
  return ["线上挂了", "紧急", "严重事故", "事故", "宕机", "立刻", "马上", "urgent", "critical", "asap"].some(
    (keyword) => text.includes(keyword)
  );
}

/**
 * 由上下文推断情感基调
 *
 * 顺序即优先级：越靠前越不允许被后面的关键词盖掉（事故 > 成功 > 报错 > 分析）。
 *
 * @param context 上下文
 * @returns 基调
 */
export function detectTone(context: string): EmotionalTone {
  if (context.trim().length === 0) return "NEUTRAL";
  const text = context.toLowerCase();
  const hit = (keywords: readonly string[]): boolean => keywords.some((keyword) => text.includes(keyword));

  if (hit(["线上挂了", "紧急", "严重", "立刻", "马上", "事故", "宕机", "urgent", "critical", "asap"])) {
    return "SERIOUS";
  }
  if (hit(["谢谢", "搞定", "成功了", "通过了", "上线了", "太棒", "恭喜", "celebration"])) {
    return "ENTHUSIASTIC";
  }
  if (hit(["报错", "失败", "不工作", "崩溃", "异常", "error", "fail", "bug", "不生效"])) {
    return "SERIOUS";
  }
  if (hit(["分析", "规划", "设计", "架构", "权衡", "对比", "为什么", "analyze", "plan", "design"])) {
    return "THOUGHTFUL";
  }
  if (hit(["研究", "探索", "看看", "了解一下", "调研", "好奇", "explore", "research"])) {
    return "CURIOUS";
  }
  if (hit(["累", "担心", "不好意思", "麻烦你", "帮我", "求助", "紧急求助"])) {
    return "EMPATHETIC";
  }
  if (hit(["实现", "重构", "排查", "定位", "验证", "debug", "refactor"])) {
    return "ANALYTICAL";
  }
  return "NEUTRAL";
}

/**
 * 由文本生成默认标题
 *
 * 取首行、去列表符号、截断到 24 字——标题是给人看的索引，
 * 太长会在 UI 里换行挤掉值。
 *
 * @param text 原文
 * @returns 标题
 */
export function defaultTitle(text: string): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? text;
  const cleaned = firstLine.replace(/^[\s\-*•\d.、)]+/, "").trim();
  return cleaned.length <= 24 ? cleaned : `${cleaned.slice(0, 24)}…`;
}
