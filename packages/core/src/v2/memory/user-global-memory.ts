/**
 * 用户全局记忆管理器（F-MEM-01）
 *
 * 包装 MemoryStore 提供 7 维度结构化 API，跨项目、跨会话维护用户级记忆。
 * 参考 WoAgent MemoryMiddleware.java 的多维度记忆设计。
 *
 * 维度交付节奏（V2 技术方案 §8.1 唯一事实源）：
 *   - V2-P3 首发 3 维度：personalContext / workContext / facts
 *   - V2-P3 尾程补全 4 维度：topOfMind / recentMonths / earlierContext / longTermBackground
 *
 * 持久化路径：~/.deepcode/memory/global.json（经 MemoryStore）
 *
 * 关键技术点：
 *   1. 全部同步 API：与 MemoryStore 同步契约一致（P1-3 修复）
 *   2. facts 序列化为单条 MemoryEntry（key="facts", value=JSON.stringify(facts)），
 *      避免 100 条 facts 产生 100 个 MemoryEntry（P2-4 修复）
 *   3. 7 维度字符串各自存储为独立 MemoryEntry（key=维度名，value=字符串内容）
 *   4. userId 参数保留但 V2-P3 阶段固定 "default"（P1-6 修复）：
 *      底层 MemoryStore 不接受 userId，所有 user_global 类型共享 global.json
 *   5. 启发式提取规则无 LLM 依赖（YAGNI 裁剪，Karpathy Simplicity First）
 *   6. 注入 SystemPrompt 总长度限制 2000 字符，facts 按 confidence 降序取 Top-10
 *
 * 设计依据：
 * - V2 上下文记忆 PRD §US-MEM-001
 * - V2 技术方案 §8.1 用户全局记忆
 * - V2-P3 实施计划 §3.2（v1.1 修订落实 P1-3/P1-6/P2-4）
 * - V2-P3 架构师审查报告 §2.2 P1-3/P1-6 + §2.3 P2-4
 *
 * @module v2/memory/user-global-memory
 */

import * as crypto from "node:crypto";
import type { MemoryStore } from "./memory-store";

// ============================================================================
// 常量定义
// ============================================================================

/** 7 维度键名（与 UserGlobalMemory 字段名一一对应） */
const DIMENSION_KEYS = [
  "workContext",
  "personalContext",
  "topOfMind",
  "recentMonths",
  "earlierContext",
  "longTermBackground",
] as const;

/** facts 在 MemoryStore 中的键名（单条 MemoryEntry 存储） */
const FACTS_KEY = "facts";

/** facts 容量上限（超过时按 confidence 降序保留 Top-100） */
const MAX_FACTS = 100;

/** 注入 SystemPrompt 的总长度上限（字符数） */
const INJECTION_CHAR_LIMIT = 2000;

/** 注入块中 facts 的 Top-N 数量 */
const INJECTION_FACTS_TOP_N = 10;

/** hygiene 清理阈值：confidence 低于此值且 accessCount=0 的 facts 被删除 */
const HYGIENE_CONFIDENCE_THRESHOLD = 0.3;

/** 启发式提取规则：personalContext 触发关键词 */
const PERSONAL_CONTEXT_PATTERNS: RegExp[] = [/请用中文注释/, /我喜欢/, /我偏好/, /我习惯/, /我倾向于/];

/** 启发式提取规则：workContext 触发关键词 */
const WORK_CONTEXT_PATTERNS: RegExp[] = [/这个项目是/, /我们在做/, /我们在开发/, /项目背景是/, /项目目标是/];

/** 启发式提取规则：facts 触发关键词 */
const FACTS_PATTERNS: RegExp[] = [/记住/, /注意/, /事实是/, /已知/];

/**
 * V2-P3 ContextSnippet 类型常量（P1-1 修复）
 *
 * ContextSnippet.type 字段是自由 string（非联合类型），定义在 v2/integration/session-hook.ts。
 * V2-P3 不修改类型定义，仅在此模块导出常量供 DualLayerContextManager 使用。
 */
export const CONTEXT_SNIPPET_TYPE = {
  /** 用户全局记忆片段 */
  USER_GLOBAL_MEMORY: "user_global_memory",
} as const;

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 用户全局记忆（7 维度）
 *
 * 参考 WoAgent MemoryMiddleware.java。
 * 跨项目、跨会话的用户级记忆。
 *
 * 维度语义：
 *   - personalContext（个人上下文/语义记忆）：用户偏好、习惯、风格
 *   - workContext（工作上下文/情景记忆）：当前项目、业务领域
 *   - topOfMind（当前关注点/情景记忆）：最近思考的核心问题
 *   - recentMonths（近几个月历史/情景记忆）：近期工作回顾
 *   - earlierContext（早期上下文/情景记忆）：远期背景信息
 *   - longTermBackground（长期背景/语义记忆）：长期不变的知识
 *   - facts（事实库/语义记忆）：结构化事实集合，最多 100 条
 */
export interface UserGlobalMemory {
  /** 工作上下文（情景记忆） */
  workContext: string;
  /** 个人上下文（语义记忆）- 用户偏好 */
  personalContext: string;
  /** 当前关注点（情景记忆） */
  topOfMind: string;
  /** 近几个月历史（情景记忆） */
  recentMonths: string;
  /** 早期上下文（情景记忆） */
  earlierContext: string;
  /** 长期背景（语义记忆） */
  longTermBackground: string;
  /** 事实库（语义记忆，最多 100 条） */
  facts: Fact[];
}

/**
 * 事实条目
 *
 * 按 confidence 降序排列，accessCount 用于 LRU 淘汰。
 * 时间戳使用 ISO 8601 字符串（UTC）。
 */
export interface Fact {
  /** 事实 ID（UUID v4） */
  id: string;
  /** 事实内容（自然语言） */
  content: string;
  /** 置信度（0-1） */
  confidence: number;
  /** 来源（对话/任务/推断） */
  source: string;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** 最后访问时间（ISO 8601） */
  lastAccessedAt: string;
  /** 访问次数 */
  accessCount: number;
}

/**
 * 用户全局记忆管理器
 *
 * 包装 MemoryStore 提供 7 维度结构化 API。
 *
 * v1.1 修订（P1-3 修复）：所有方法改为同步，与 MemoryStore 同步 API 一致。
 * v1.1 修订（P1-6 修复）：userId 参数保留，但 V2-P3 阶段固定为 "default"，
 *   多用户支持留待 V2-P4（底层 MemoryStore 不接受 userId，所有 user_global
 *   类型记忆共享 ~/.deepcode/memory/global.json）。
 * v1.1 修订（P2-4 修复）：facts 序列化策略明确为单条 MemoryEntry
 *   （key="facts", value=JSON.stringify(facts)），读取时 JSON.parse。
 *
 * 使用方式：
 * ```typescript
 * const store = new MemoryStore(); // projectRoot=null，仅用户全局
 * const manager = new UserGlobalMemoryManager(store);
 * manager.updateGlobalMemory("default", { personalContext: "偏好中文注释" });
 * const memory = manager.getGlobalMemory("default");
 * const prompt = manager.injectIntoSystemPrompt("default", originalPrompt);
 * ```
 *
 * userId 限制说明（P1-6）：
 * - V2-P3 阶段仅支持 userId="default"
 * - 多用户隔离需重构 MemoryStore（接受 userId 参数），留待 V2-P4
 * - 当前 userId 参数仅用于一致性，实际被底层 MemoryStore 忽略
 */
export class UserGlobalMemoryManager {
  /**
   * @param store MemoryStore 实例（V2-P1 已实现）
   */
  constructor(private readonly store: MemoryStore) {}

  /**
   * 获取用户全局记忆
   *
   * 从 MemoryStore 读取 user_global 类型条目，按 7 维度组装返回。
   * 缺失维度返回空字符串，facts 缺失返回空数组。
   *
   * facts 读取策略（P2-4）：从单条 MemoryEntry（key="facts"）读取，
   * JSON.parse 还原为 Fact[] 数组。若 JSON 解析失败，降级为空数组
   * 并不抛异常（W-06 记忆透明化原则）。
   *
   * @param userId 用户 ID（V2-P3 固定 "default"，多用户留待 V2-P4）
   * @returns 用户全局记忆（永不返回 null，缺失时返回空记忆）
   */
  getGlobalMemory(userId: string): UserGlobalMemory {
    // userId 参数仅用于 API 一致性，底层 MemoryStore 忽略
    void userId;

    // 读取所有 user_global 类型条目
    const list = this.store.list("user_global");
    const entries = list.entries;

    // 初始化空记忆（7 维度均为空字符串，facts 为空数组）
    const memory: UserGlobalMemory = {
      workContext: "",
      personalContext: "",
      topOfMind: "",
      recentMonths: "",
      earlierContext: "",
      longTermBackground: "",
      facts: [],
    };

    // 按 key 分发到 7 维度
    for (const entry of entries) {
      if (entry.key === FACTS_KEY) {
        // facts 单条 MemoryEntry，JSON.parse 还原
        try {
          const parsed = JSON.parse(entry.value);
          if (Array.isArray(parsed)) {
            memory.facts = parsed as Fact[];
          }
        } catch {
          // JSON 解析失败：降级为空数组（W-06 记忆透明化）
          // 不抛异常，避免损坏数据阻塞调用方
        }
      } else if (DIMENSION_KEYS.includes(entry.key as (typeof DIMENSION_KEYS)[number])) {
        // 6 个字符串维度直接赋值（facts 已单独处理）
        // 类型安全：key 收窄为 DIMENSION_KEYS 的字面量联合，均为 string 字段
        const key = entry.key as (typeof DIMENSION_KEYS)[number];
        memory[key] = entry.value;
      }
    }

    return memory;
  }

  /**
   * 更新用户全局记忆
   *
   * 将提供的字段写入 MemoryStore（Partial 更新，仅写入提供的字段，
   * 未提供的字段保持不变）。
   *
   * facts 写入策略（P2-4）：JSON.stringify(facts) 写入单条 MemoryEntry
   * （key="facts"），覆盖旧值。写入前按 confidence 降序排序，
   * 超过 100 条淘汰最低者。
   *
   * 实现细节：
   *   - 对每个提供的字段，先删除同 key 的旧条目（若有），再添加新条目
   *   - 不影响未提供字段的原有数据
   *
   * @param userId 用户 ID（V2-P3 固定 "default"，多用户留待 V2-P4）
   * @param memory 待更新的记忆（Partial，仅更新提供的字段）
   */
  updateGlobalMemory(userId: string, memory: Partial<UserGlobalMemory>): void {
    void userId;

    // 处理 6 个字符串维度（Partial 更新，仅写入提供的字段）
    for (const key of DIMENSION_KEYS) {
      if (key in memory) {
        const value = memory[key];
        // 仅在值非 undefined 时更新（允许空字符串）
        if (value !== undefined) {
          this.upsertDimensionEntry(key, value);
        }
      }
    }

    // 处理 facts（单条 MemoryEntry，JSON.stringify）
    if ("facts" in memory && memory.facts !== undefined) {
      let facts = memory.facts;
      // 按 confidence 降序排序（稳定排序，相同 confidence 保持原顺序）
      facts = [...facts].sort((a, b) => b.confidence - a.confidence);
      // 超过 100 条淘汰最低者（保留 Top-100）
      if (facts.length > MAX_FACTS) {
        facts = facts.slice(0, MAX_FACTS);
      }
      this.upsertDimensionEntry(FACTS_KEY, JSON.stringify(facts));
    }
  }

  /**
   * 从对话中提取新记忆
   *
   * 启发式提取规则（无 LLM 依赖，YAGNI 裁剪）：
   *   - "请用中文注释" / "我喜欢..." / "我偏好..." → personalContext
   *   - "这个项目是..." / "我们在做..." → workContext
   *   - "记住..." / "注意..." → facts
   *
   * 提取策略：
   *   - 仅扫描 role="user" 的消息（用户主动表达的内容才有提取价值）
   *   - 每条消息按优先级匹配（facts > personalContext > workContext），
   *     一条消息仅触发一个维度，避免重复提取
   *   - facts 提取时生成完整 Fact 结构（id/createdAt/lastAccessedAt/accessCount=0）
   *   - personalContext/workContext 提取整条消息内容（保留上下文）
   *
   * @param userId 用户 ID（V2-P3 固定 "default"，多用户留待 V2-P4）
   * @param messages 对话消息列表
   * @returns 提取的记忆片段（Partial，未提取到的维度不出现在返回值中）
   */
  extractFromConversation(
    userId: string,
    messages: Array<{ role: string; content: string }>
  ): Partial<UserGlobalMemory> {
    void userId;

    const result: Partial<UserGlobalMemory> = {};
    const extractedFacts: Fact[] = [];
    let personalContext = "";
    let workContext = "";
    const now = new Date().toISOString();

    for (const msg of messages) {
      // 仅扫描用户消息
      if (msg.role !== "user" || !msg.content) {
        continue;
      }
      const content = msg.content;

      // 优先级 1：facts（"记住" / "注意" / "事实是" / "已知"）
      const factMatch = FACTS_PATTERNS.find((re) => re.test(content));
      if (factMatch) {
        // 提取关键词后的内容作为 fact
        const match = content.match(factMatch);
        if (match) {
          // 截取关键词之后的内容作为 fact 内容
          const factContent = content.slice(match.index! + match[0].length).trim();
          if (factContent) {
            extractedFacts.push({
              id: crypto.randomUUID(),
              content: factContent,
              confidence: 0.7, // 启发式提取默认置信度
              source: "auto_extracted",
              createdAt: now,
              lastAccessedAt: now,
              accessCount: 0,
            });
          }
        }
        continue;
      }

      // 优先级 2：personalContext（"请用中文注释" / "我喜欢" / "我偏好" 等）
      const personalMatch = PERSONAL_CONTEXT_PATTERNS.find((re) => re.test(content));
      if (personalMatch) {
        // 追加到 personalContext（多条消息可累积，以换行分隔）
        personalContext = personalContext ? `${personalContext}\n${content}` : content;
        continue;
      }

      // 优先级 3：workContext（"这个项目是" / "我们在做" 等）
      const workMatch = WORK_CONTEXT_PATTERNS.find((re) => re.test(content));
      if (workMatch) {
        workContext = workContext ? `${workContext}\n${content}` : content;
        continue;
      }
    }

    // 组装 Partial 返回值（仅包含提取到内容的维度）
    if (personalContext) {
      result.personalContext = personalContext;
    }
    if (workContext) {
      result.workContext = workContext;
    }
    if (extractedFacts.length > 0) {
      result.facts = extractedFacts;
    }

    return result;
  }

  /**
   * 注入记忆到 SystemPrompt
   *
   * 注入策略（§8.1 验收标准）：
   *   - 总长度限制 2000 字符（含 <user_memory></user_memory> 标签）
   *   - facts 按 confidence 降序取 Top-10
   *   - 7 维度按优先级排序：
   *       personalContext > workContext > topOfMind > facts >
   *       recentMonths > earlierContext > longTermBackground
   *   - 注入格式：<user_memory>...</user_memory> 块，追加到原 prompt 末尾
   *   - 空记忆返回原 prompt 不修改
   *   - 超长截断策略：按优先级顺序填充，超出 2000 字符时停止添加新维度
   *
   * @param userId 用户 ID（V2-P3 固定 "default"，多用户留待 V2-P4）
   * @param originalPrompt 原始 SystemPrompt
   * @returns 注入后的 SystemPrompt（原 prompt + <user_memory> 块）
   */
  injectIntoSystemPrompt(userId: string, originalPrompt: string): string {
    const memory = this.getGlobalMemory(userId);

    // 维度优先级顺序（高 → 低）
    const orderedDimensions: Array<{ key: string; label: string; value: string }> = [
      { key: "personalContext", label: "用户偏好", value: memory.personalContext },
      { key: "workContext", label: "工作上下文", value: memory.workContext },
      { key: "topOfMind", label: "当前关注", value: memory.topOfMind },
      { key: "facts", label: "已知事实", value: "" }, // facts 单独处理
      { key: "recentMonths", label: "近期历史", value: memory.recentMonths },
      { key: "earlierContext", label: "早期上下文", value: memory.earlierContext },
      { key: "longTermBackground", label: "长期背景", value: memory.longTermBackground },
    ];

    // 构建注入块内容（按优先级顺序）
    const lines: string[] = [];
    const openTag = "<user_memory>";
    const closeTag = "</user_memory>";
    // 预留标签长度，剩余字符配额
    let remainingBudget = INJECTION_CHAR_LIMIT - openTag.length - closeTag.length;

    for (const dim of orderedDimensions) {
      if (dim.key === "facts") {
        // facts 按 confidence 降序取 Top-10
        const topFacts = [...memory.facts].sort((a, b) => b.confidence - a.confidence).slice(0, INJECTION_FACTS_TOP_N);

        for (const fact of topFacts) {
          const line = `- [${fact.confidence.toFixed(2)}] ${fact.content}`;
          const lineWithNewline = (lines.length > 0 ? "\n" : "") + line;
          if (lineWithNewline.length > remainingBudget) {
            break; // 超出预算，停止添加
          }
          lines.push(line);
          remainingBudget -= lineWithNewline.length;
        }
      } else if (dim.value) {
        // 非 facts 维度：仅在有内容时添加
        const line = `[${dim.label}] ${dim.value}`;
        const lineWithNewline = (lines.length > 0 ? "\n" : "") + line;
        if (lineWithNewline.length > remainingBudget) {
          break; // 超出预算，停止添加后续维度
        }
        lines.push(line);
        remainingBudget -= lineWithNewline.length;
      }
    }

    // 空记忆返回原 prompt 不修改
    if (lines.length === 0) {
      return originalPrompt;
    }

    // 拼接注入块，追加到原 prompt 末尾
    const memoryBlock = `${openTag}\n${lines.join("\n")}\n${closeTag}`;
    return `${originalPrompt}\n\n${memoryBlock}`;
  }

  /**
   * 记忆卫生：清理过期/低置信度记忆
   *
   * 清理规则：
   *   1. facts 中 confidence < 0.3 且 accessCount = 0 的条目删除
   *      （低置信度且从未被访问，价值极低）
   *   2. 清理后若仍超过 100 条，按 (confidence desc, accessCount desc)
   *      综合排序淘汰低优先级者，保留 Top-100
   *
   * 实现细节：
   *   - 仅修改 facts，不影响 6 个字符串维度
   *   - 若 facts 未发生变化（无需清理），不触发写入以避免无谓 IO
   *
   * @param userId 用户 ID（V2-P3 固定 "default"，多用户留待 V2-P4）
   */
  hygiene(userId: string): void {
    const memory = this.getGlobalMemory(userId);
    if (memory.facts.length === 0) {
      // 空 facts 无需清理
      return;
    }

    // 规则 1：删除 confidence < 0.3 且 accessCount = 0 的 facts
    let cleanedFacts = memory.facts.filter((f) => f.confidence >= HYGIENE_CONFIDENCE_THRESHOLD || f.accessCount > 0);

    // 规则 2：若仍超过 100 条，按 (confidence desc, accessCount desc) 淘汰
    if (cleanedFacts.length > MAX_FACTS) {
      cleanedFacts = cleanedFacts
        .sort((a, b) => {
          // 主排序：confidence 降序
          if (b.confidence !== a.confidence) {
            return b.confidence - a.confidence;
          }
          // 次排序：accessCount 降序
          return b.accessCount - a.accessCount;
        })
        .slice(0, MAX_FACTS);
    }

    // 仅在 facts 数量变化时才写入（避免无谓 IO）
    if (cleanedFacts.length !== memory.facts.length) {
      this.upsertDimensionEntry(FACTS_KEY, JSON.stringify(cleanedFacts));
    }
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 上插/更新维度条目
   *
   * MemoryStore.add 不支持 upsert（仅追加不查重），因此：
   *   1. 列出 user_global 类型条目
   *   2. 找到同 key 的旧条目并删除（若有）
   *   3. 添加新条目
   *
   * @param key 维度键名（如 "personalContext" / "facts"）
   * @param value 维度值（字符串或 JSON.stringify 后的 facts）
   */
  private upsertDimensionEntry(key: string, value: string): void {
    // 查找并删除同 key 的旧条目
    const list = this.store.list("user_global");
    for (const entry of list.entries) {
      if (entry.key === key) {
        this.store.delete(entry.id);
      }
    }

    // 添加新条目（facts 用 confidence=1.0，其他维度用 0.9 表示用户显式设置）
    const isFacts = key === FACTS_KEY;
    this.store.add({
      type: "user_global",
      key,
      value,
      confidence: isFacts ? 1.0 : 0.9,
      source: "user_explicit",
    });
  }
}
