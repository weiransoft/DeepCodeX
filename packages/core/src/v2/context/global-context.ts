/**
 * 全局上下文（GlobalContext）—— F-CTX-01
 *
 * 跨任务、跨会话的全局上下文，承载用户画像、领域知识、历史经验、协作网络、能力模型。
 * V2-P1 阶段实现精简版：UserProfile 仅手动维护（通过 /profile 命令），自动派生留 V2-P2。
 *
 * 设计依据：
 * - V2 技术方案 §5.1 GlobalContext 数据结构（行 2090-2364）
 * - V2 技术方案 §14.5 V2-P1 功能项 F-CTX-01
 * - 架构师审查报告（2026-07-17）：采纳简化建议 UserProfile 仅手动
 *
 * 存储布局：
 *   ~/.deepcode/global-context.json  —— 单文件持久化整个 GlobalContext
 *
 * 关键技术点：
 *   1. 原子写入：先写 .tmp 文件，fsyncSync 后 renameSync 替换原文件，
 *      避免半写状态导致数据损坏（参考 memory-store.ts 模式）。
 *   2. Schema 版本化：顶层 schemaVersion 字段，migrate() 函数支持前向兼容。
 *   3. 容量上限 LRU 淘汰：HistoricalExperience 三类条目分别设上限，
 *      超限时按 (accessCount, lastAccessedAt) 综合排序淘汰最差者。
 *   4. 损坏降级：JSON 解析失败时将原文件重命名为 .corrupted 备份，
 *      并以默认空上下文继续工作（W-06 记忆透明化 / US-ERR-002）。
 *   5. 并发安全：CLI 单进程，不加锁；原子写入保证一致性。
 *   6. 文件不存在时返回默认空上下文，不抛异常（首启友好）。
 *
 * @module v2/context/global-context
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// 常量定义
// ============================================================================

/** 存储格式版本号（用于未来 schema 升级的兼容判断与迁移） */
const SCHEMA_VERSION = 1;

/** 成功经验容量上限（超过时 LRU 淘汰） */
const MAX_SUCCESS_EXPERIENCES = 100;

/** 失败经验容量上限（超过时 LRU 淘汰） */
const MAX_FAILURE_EXPERIENCES = 100;

/** 经验模式容量上限（超过时 LRU 淘汰） */
const MAX_EXPERIENCE_PATTERNS = 50;

// ============================================================================
// 类型定义（与 V2 技术方案 §5.1 完全对齐）
// ============================================================================

/**
 * 全局上下文（跨任务、跨会话）
 *
 * 参考 WoAgent GlobalContext.java。
 * 包含用户画像、领域知识、历史经验、协作网络、能力模型。
 * 单用户单文件持久化到 ~/.deepcode/global-context.json。
 */
export interface GlobalContext {
  /** Schema 版本号（用于 migrate 函数判断迁移路径） */
  schemaVersion: number;
  /** 用户 ID（V2-P1 阶段固定为 "default"，多用户留 V2-P2） */
  userId: string;
  /** 用户画像（编码风格、框架偏好、行为模式等） */
  userProfile: UserProfile;
  /** 领域知识库（知识图谱、概念库、规则库、案例库、最佳实践库） */
  domainKnowledge: DomainKnowledge;
  /** 历史经验库（成功经验、失败经验、经验模式） */
  historicalExperience: HistoricalExperience;
  /** 协作网络（外部工具集成 + 协作偏好） */
  collaborationNetwork: CollaborationNetwork;
  /** 能力模型（用户能力 + AI 能力评估） */
  capabilityModel: CapabilityModel;
  /** 乐观并发版本号（每次 save 自增） */
  version: number;
  /** 最后更新时间（ISO 8601 字符串） */
  lastUpdatedAt: string;
}

/**
 * 用户画像
 *
 * V2-P1 阶段仅手动维护（通过 /profile 命令）；
 * V2-P2 将增加任务结束自动派生（编码偏好、常用语言）。
 */
export interface UserProfile {
  /** 代码风格偏好 */
  codeStyle: {
    /** 缩进风格：2 空格 / 4 空格 / Tab */
    indent: "2space" | "4space" | "tab";
    /** 引号风格：单引号 / 双引号 */
    quoteStyle: "single" | "double";
    /** 是否使用分号 */
    semicolons: boolean;
    /** 注释语言：中文 / 英文 / 混合 */
    commentLanguage: "zh" | "en" | "mixed";
  };
  /** 框架偏好（如 ["react", "express"]） */
  frameworkPreferences: string[];
  /** 行为模式（如 ["偏好函数式", "避免类继承"]） */
  behaviorPatterns: string[];
  /** 交互历史摘要（自然语言描述，V2-P1 阶段为空字符串） */
  interactionHistorySummary: string;
  /** 能力评估摘要（自然语言描述，V2-P1 阶段为空字符串） */
  capabilityAssessment: string;
}

/**
 * 领域知识库
 *
 * V2-P1 阶段提供空默认值；V2-P2 由 DomainModeler 填充。
 */
export interface DomainKnowledge {
  /** 知识图谱（简化版：节点 + 边） */
  knowledgeGraph: SimpleKnowledgeGraph;
  /** 概念库 */
  conceptLibrary: ConceptEntry[];
  /** 规则库 */
  ruleLibrary: RuleEntry[];
  /** 案例库 */
  caseLibrary: CaseEntry[];
  /** 最佳实践库 */
  bestPracticeLibrary: BestPracticeEntry[];
}

/**
 * 简化版知识图谱
 *
 * 节点为业务概念，边为关系。V2-P1 阶段为空图。
 */
export interface SimpleKnowledgeGraph {
  /** 节点（业务概念） */
  nodes: GraphNode[];
  /** 边（关系） */
  edges: GraphEdge[];
}

/** 图节点：业务概念 */
export interface GraphNode {
  /** 节点 ID（唯一） */
  id: string;
  /** 节点显示标签 */
  label: string;
  /** 节点类型：概念 / 实体 / 流程 / 规则 */
  type: "concept" | "entity" | "process" | "rule";
  /** 节点属性（自由字段） */
  properties: Record<string, unknown>;
}

/** 图边：节点间关系 */
export interface GraphEdge {
  /** 源节点 ID */
  source: string;
  /** 目标节点 ID */
  target: string;
  /** 关系名称（如 "depends_on" / "calls" / "extends"） */
  relation: string;
  /** 关系权重（0-1） */
  weight: number;
}

/** 概念库条目（V2-P1 阶段为空，V2-P2 由 DomainModeler 填充） */
export interface ConceptEntry {
  id: string;
  name: string;
  description: string;
  relatedConcepts: string[];
  /**
   * 推断置信度（0-1，V2-P3 多角色审查 L-4 修复新增可选字段）
   *
   * V2-P3 之前由 DomainModeler 推断但未持久化到 ConceptEntry，造成"推断侧有置信度、
   * 消费侧无置信度"的信息断层（多角色共识评价 L-4 风险）。
   *
   * V2-P3 起 persistToGlobalContext 写入此字段，collectDomainKnowledgeSnippets
   * 优先按 confidence 降序排序；旧 global-context.json 文件无此字段时按
   * relatedConcepts.length 降序兜底（向后兼容）。
   */
  confidence?: number;
}

/** 规则库条目 */
export interface RuleEntry {
  id: string;
  rule: string;
  scope: string;
  priority: number;
}

/** 案例库条目 */
export interface CaseEntry {
  id: string;
  title: string;
  description: string;
  solution: string;
  tags: string[];
}

/** 最佳实践库条目 */
export interface BestPracticeEntry {
  id: string;
  practice: string;
  rationale: string;
  applicableScenarios: string[];
}

/**
 * 历史经验库
 *
 * V2-P1 阶段的核心数据结构，由 WorkingMemoryManager.archiveToExperience 写入。
 * 三类条目分别设容量上限，超限时 LRU 淘汰。
 */
export interface HistoricalExperience {
  /** 成功经验（上限 100 条） */
  successExperiences: SuccessExperience[];
  /** 失败经验（上限 100 条） */
  failureExperiences: FailureExperience[];
  /** 经验模式（上限 50 条） */
  experiencePatterns: ExperiencePattern[];
}

/**
 * 成功经验
 *
 * 记录任务成功完成后的可复用经验。
 * LRU 淘汰依据：(accessCount, lastAccessedAt) 综合排序。
 */
export interface SuccessExperience {
  /** 经验 ID（UUID v4） */
  id: string;
  /** 任务类型（如 "bugfix" / "feature" / "refactor"） */
  taskType: string;
  /** 任务描述 */
  description: string;
  /** 解决方案（自然语言描述） */
  solution: string;
  /** 标签（用于检索） */
  tags: string[];
  /** 重要性（1-10，10 为最重要） */
  importance: number;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** 访问次数（每次检索命中时自增） */
  accessCount: number;
  /** 最后访问时间（ISO 8601，初始等于 createdAt） */
  lastAccessedAt: string;
}

/**
 * 失败经验
 *
 * 记录任务失败后的教训，避免重复犯错。
 */
export interface FailureExperience {
  /** 经验 ID（UUID v4） */
  id: string;
  /** 任务类型 */
  taskType: string;
  /** 任务描述 */
  description: string;
  /** 失败原因 */
  failureReason: string;
  /** 学到的教训 */
  lessonLearned: string;
  /** 标签 */
  tags: string[];
  /** 重要性（1-10） */
  importance: number;
  /** 创建时间 */
  createdAt: string;
  /** 访问次数 */
  accessCount: number;
  /** 最后访问时间 */
  lastAccessedAt: string;
}

/**
 * 经验模式
 *
 * 从多次经验中抽象出的通用模式（V2-P1 阶段由 archiveToExperience 简单提取，
 * V2-P2 将增加 LLM 模式抽取）。
 */
export interface ExperiencePattern {
  /** 模式 ID（UUID v4） */
  id: string;
  /** 模式描述（自然语言） */
  pattern: string;
  /** 适用场景列表 */
  applicableScenarios: string[];
  /** 反例列表（不适用场景） */
  counterExamples: string[];
  /** 置信度（0-1） */
  confidence: number;
}

/**
 * 协作网络
 *
 * 单用户工具简化为外部协作工具集成配置。
 * V2-P1 阶段提供空默认值。
 */
export interface CollaborationNetwork {
  /** 外部协作工具集成（如 Git/GitHub/Jira/Slack 等） */
  integrations: CollaborationIntegration[];
  /** 用户协作偏好 */
  preferences: CollaborationPreference;
}

/** 协作工具集成 */
export interface CollaborationIntegration {
  /** 工具名称 */
  name: string;
  /** 工具类型 */
  type: "git" | "issue_tracker" | "chat" | "ci_cd" | "other";
  /** 是否已配置 */
  configured: boolean;
}

/** 协作偏好 */
export interface CollaborationPreference {
  /** 默认通知级别 */
  notificationLevel: "all" | "important" | "none";
  /** 自动同步间隔（毫秒） */
  autoSyncIntervalMs: number;
}

/**
 * 能力模型
 *
 * 用户能力 + AI 能力评估。V2-P1 阶段提供空默认值。
 */
export interface CapabilityModel {
  /** 用户能力评估 */
  userCapability: CapabilityAssessment;
  /** AI 能力评估 */
  aiCapability: CapabilityAssessment;
  /** 评估时间（ISO 8601） */
  assessedAt: string;
}

/** 能力评估 */
export interface CapabilityAssessment {
  /** 技术领域能力评分（域名 → 0-1 评分） */
  domains: Record<string, number>;
  /** 工具熟练度（工具名 → 0-1 评分） */
  toolProficiency: Record<string, number>;
  /** 整体能力等级 */
  overallLevel: "beginner" | "intermediate" | "advanced" | "expert";
}

// ============================================================================
// 默认值工厂
// ============================================================================

/**
 * 创建默认的空 GlobalContext
 *
 * 首次启动（文件不存在）或文件损坏时使用。
 * 所有集合字段初始化为空数组/空对象，确保后续代码无需判空。
 *
 * @param userId 用户 ID（默认 "default"）
 * @returns 填充默认值的 GlobalContext
 */
export function createDefaultGlobalContext(userId: string = "default"): GlobalContext {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    userId,
    userProfile: {
      codeStyle: {
        indent: "2space",
        quoteStyle: "double",
        semicolons: true,
        commentLanguage: "zh",
      },
      frameworkPreferences: [],
      behaviorPatterns: [],
      interactionHistorySummary: "",
      capabilityAssessment: "",
    },
    domainKnowledge: {
      knowledgeGraph: { nodes: [], edges: [] },
      conceptLibrary: [],
      ruleLibrary: [],
      caseLibrary: [],
      bestPracticeLibrary: [],
    },
    historicalExperience: {
      successExperiences: [],
      failureExperiences: [],
      experiencePatterns: [],
    },
    collaborationNetwork: {
      integrations: [],
      preferences: {
        notificationLevel: "important",
        autoSyncIntervalMs: 60_000,
      },
    },
    capabilityModel: {
      userCapability: {
        domains: {},
        toolProficiency: {},
        overallLevel: "beginner",
      },
      aiCapability: {
        domains: {},
        toolProficiency: {},
        overallLevel: "intermediate",
      },
      assessedAt: now,
    },
    version: 0,
    lastUpdatedAt: now,
  };
}

// ============================================================================
// GlobalContextManager 类
// ============================================================================

/**
 * GlobalContext 管理器
 *
 * 负责 GlobalContext 的持久化（load/save）、更新（update）、版本迁移（migrate）、
 * 经验条目维护（addSuccessExperience / addFailureExperience / addExperiencePattern /
 * recordExperienceAccess）。
 *
 * V2-P1 阶段不实现 DualLayerContextManager（V2-P2 整合层），本类作为独立的
 * GlobalContext 存取入口，供 ContextSynchronizer / WorkingMemoryManager 等模块依赖注入。
 *
 * 用法：
 * ```typescript
 * const manager = new GlobalContextManager();
 * const ctx = await manager.load("default");
 * await manager.addSuccessExperience("default", {
 *   id: crypto.randomUUID(),
 *   taskType: "bugfix",
 *   description: "修复内存泄漏",
 *   solution: "释放事件监听器",
 *   tags: ["memory", "event"],
 *   importance: 7,
 *   createdAt: new Date().toISOString(),
 *   accessCount: 0,
 *   lastAccessedAt: new Date().toISOString(),
 * });
 * ```
 */
export class GlobalContextManager {
  /** GlobalContext 持久化文件路径：~/.deepcode/global-context.json */
  private readonly filePath: string;

  /**
   * @param filePath 可选的自定义存储路径（测试用）；默认 ~/.deepcode/global-context.json
   */
  constructor(filePath?: string) {
    if (filePath) {
      this.filePath = filePath;
    } else {
      const homeDir = os.homedir();
      const dir = path.join(homeDir, ".deepcode");
      this.filePath = path.join(dir, "global-context.json");
    }
  }

  /**
   * 加载 GlobalContext
   *
   * 行为契约：
   * - 文件不存在：返回默认空上下文（不创建文件，首启友好）
   * - 文件存在且合法：返回解析后的上下文（含 migrate）
   * - 文件存在但损坏：将原文件重命名为 .corrupted.<timestamp> 备份，
   *   返回默认空上下文（W-06 记忆透明化 / US-ERR-002 降级约定）
   *
   * @param userId 用户 ID（默认 "default"）
   * @returns 加载（或默认创建）的 GlobalContext
   */
  load(userId: string = "default"): GlobalContext {
    // 文件不存在：返回默认空上下文，不创建文件
    if (!fs.existsSync(this.filePath)) {
      return createDefaultGlobalContext(userId);
    }

    // 读取文件内容
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch {
      // 读取失败（权限/IO 错误）：降级返回默认空上下文，不抛错
      return createDefaultGlobalContext(userId);
    }

    // 解析 JSON
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      // JSON 解析失败：备份损坏文件，返回默认空上下文
      this.backupCorruptedFile();
      return createDefaultGlobalContext(userId);
    }

    // 校验最低结构合法性（必须是对象且含 schemaVersion 字段）
    if (!isObject(data) || typeof data.schemaVersion !== "number") {
      this.backupCorruptedFile();
      return createDefaultGlobalContext(userId);
    }

    // 版本迁移（经 unknown 中转再断言为 GlobalContext，TS 要求双重断言）
    const migrated = this.migrate(data as unknown as GlobalContext, userId);

    return migrated;
  }

  /**
   * 保存 GlobalContext（原子写入）
   *
   * 实现步骤：
   * 1. 自增 version（乐观并发）
   * 2. 更新 lastUpdatedAt
   * 3. 确保父目录存在
   * 4. 序列化为 JSON 字符串
   * 5. 写入 .tmp 临时文件
   * 6. fsyncSync 刷盘（防止系统崩溃丢数据）
   * 7. renameSync 原子替换原文件
   *
   * @param ctx 待保存的 GlobalContext
   */
  save(ctx: GlobalContext): void {
    // 自增版本号 + 更新时间戳
    const toSave: GlobalContext = {
      ...ctx,
      version: ctx.version + 1,
      lastUpdatedAt: new Date().toISOString(),
    };

    // 确保父目录存在
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    // 序列化（2 空格缩进，便于人工检视）
    const json = JSON.stringify(toSave, null, 2);

    // 原子写入：先写 .tmp，fsync 后 rename
    const tmpPath = this.filePath + ".tmp";
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, json, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.filePath);
  }

  /**
   * 更新 GlobalContext（读-改-写原子操作）
   *
   * @param userId 用户 ID
   * @param updater 更新函数，接收当前上下文，返回修改后的上下文
   * @returns 保存后的 GlobalContext
   */
  update(userId: string, updater: (ctx: GlobalContext) => GlobalContext): GlobalContext {
    const current = this.load(userId);
    const updated = updater(current);
    this.save(updated);
    return updated;
  }

  /**
   * 添加成功经验
   *
   * 自动维护容量上限：超过 MAX_SUCCESS_EXPERIENCES 时 LRU 淘汰。
   * LRU 依据：(accessCount, lastAccessedAt) 综合排序——先按 accessCount 升序，
   * 相同则按 lastAccessedAt 升序，淘汰最差者。
   *
   * @param userId 用户 ID
   * @param exp 待添加的成功经验（id/createdAt/accessCount/lastAccessedAt 由调用方提供）
   */
  addSuccessExperience(userId: string, exp: SuccessExperience): void {
    this.update(userId, (ctx) => {
      ctx.historicalExperience.successExperiences.push(exp);
      // 容量上限 LRU 淘汰
      if (ctx.historicalExperience.successExperiences.length > MAX_SUCCESS_EXPERIENCES) {
        ctx.historicalExperience.successExperiences = evictLRU(
          ctx.historicalExperience.successExperiences,
          MAX_SUCCESS_EXPERIENCES
        );
      }
      return ctx;
    });
  }

  /**
   * 添加失败经验
   *
   * 自动维护容量上限：超过 MAX_FAILURE_EXPERIENCES 时 LRU 淘汰。
   *
   * @param userId 用户 ID
   * @param exp 待添加的失败经验
   */
  addFailureExperience(userId: string, exp: FailureExperience): void {
    this.update(userId, (ctx) => {
      ctx.historicalExperience.failureExperiences.push(exp);
      if (ctx.historicalExperience.failureExperiences.length > MAX_FAILURE_EXPERIENCES) {
        ctx.historicalExperience.failureExperiences = evictLRU(
          ctx.historicalExperience.failureExperiences,
          MAX_FAILURE_EXPERIENCES
        );
      }
      return ctx;
    });
  }

  /**
   * 添加经验模式
   *
   * 自动维护容量上限：超过 MAX_EXPERIENCE_PATTERNS 时淘汰 confidence 最低者。
   * 经验模式无 accessCount 字段，按 confidence 升序淘汰。
   *
   * @param userId 用户 ID
   * @param pattern 待添加的经验模式
   */
  addExperiencePattern(userId: string, pattern: ExperiencePattern): void {
    this.update(userId, (ctx) => {
      ctx.historicalExperience.experiencePatterns.push(pattern);
      if (ctx.historicalExperience.experiencePatterns.length > MAX_EXPERIENCE_PATTERNS) {
        // 按 confidence 升序排序，淘汰最低者
        ctx.historicalExperience.experiencePatterns.sort((a, b) => a.confidence - b.confidence);
        ctx.historicalExperience.experiencePatterns =
          ctx.historicalExperience.experiencePatterns.slice(-MAX_EXPERIENCE_PATTERNS);
      }
      return ctx;
    });
  }

  /**
   * 记录经验访问（成功或失败经验）
   *
   * 检索命中时调用，自增 accessCount 并更新 lastAccessedAt。
   * 用于 LRU 淘汰排序。
   *
   * @param userId 用户 ID
   * @param experienceId 经验 ID
   */
  recordExperienceAccess(userId: string, experienceId: string): void {
    this.update(userId, (ctx) => {
      const now = new Date().toISOString();
      // 在成功经验中查找
      const successExp = ctx.historicalExperience.successExperiences.find((e) => e.id === experienceId);
      if (successExp) {
        successExp.accessCount += 1;
        successExp.lastAccessedAt = now;
        return ctx;
      }
      // 在失败经验中查找
      const failureExp = ctx.historicalExperience.failureExperiences.find((e) => e.id === experienceId);
      if (failureExp) {
        failureExp.accessCount += 1;
        failureExp.lastAccessedAt = now;
        return ctx;
      }
      // 未找到：静默返回（不抛错，避免检索路径耦合写入路径）
      return ctx;
    });
  }

  /**
   * 批量记录经验访问（V2-P3 新增，P1-5 修复）
   *
   * 一次 load + save 更新多条经验的访问记录，避免循环调用
   * recordExperienceAccess 导致的 N 次 load+save（性能优化）。
   *
   * 适用场景：ExperienceRecommender.recommend 命中多条经验后批量更新访问记录。
   *
   * @param userId 用户 ID
   * @param experienceIds 经验 ID 列表
   */
  recordExperienceAccessBatch(userId: string, experienceIds: string[]): void {
    if (!experienceIds || experienceIds.length === 0) {
      return;
    }
    // 转为 Set 加速查找
    const idSet = new Set(experienceIds);
    this.update(userId, (ctx) => {
      const now = new Date().toISOString();
      // 在成功经验中批量更新
      for (const exp of ctx.historicalExperience.successExperiences) {
        if (idSet.has(exp.id)) {
          exp.accessCount += 1;
          exp.lastAccessedAt = now;
        }
      }
      // 在失败经验中批量更新
      for (const exp of ctx.historicalExperience.failureExperiences) {
        if (idSet.has(exp.id)) {
          exp.accessCount += 1;
          exp.lastAccessedAt = now;
        }
      }
      return ctx;
    });
  }

  // ------------------------------------------------------------------------
  // 私有方法
  // ------------------------------------------------------------------------

  /**
   * 版本迁移
   *
   * 当前 SCHEMA_VERSION = 1，无历史版本需迁移。
   * 未来升级时在此处追加 if (data.schemaVersion < 2) { ... } 迁移逻辑。
   *
   * @param data 从文件加载的原始数据
   * @param userId 用户 ID（用于补全缺失字段）
   * @returns 迁移后的 GlobalContext
   */
  private migrate(data: GlobalContext, userId: string): GlobalContext {
    // 当前仅版本 1，无需迁移；确保 schemaVersion 字段为最新
    const result: GlobalContext = {
      ...createDefaultGlobalContext(userId),
      ...data,
      schemaVersion: SCHEMA_VERSION,
    };

    // 防御性补全：确保嵌套结构完整（防止旧版本文件字段缺失）
    if (!result.historicalExperience) {
      result.historicalExperience = {
        successExperiences: [],
        failureExperiences: [],
        experiencePatterns: [],
      };
    }
    if (!result.userProfile) {
      result.userProfile = createDefaultGlobalContext(userId).userProfile;
    }
    if (!result.domainKnowledge) {
      result.domainKnowledge = createDefaultGlobalContext(userId).domainKnowledge;
    }
    if (!result.collaborationNetwork) {
      result.collaborationNetwork = createDefaultGlobalContext(userId).collaborationNetwork;
    }
    if (!result.capabilityModel) {
      result.capabilityModel = createDefaultGlobalContext(userId).capabilityModel;
    }

    return result;
  }

  /**
   * 备份损坏的持久化文件
   *
   * 将原文件重命名为 .corrupted.<timestamp> 备份，便于事后排查。
   * 备份失败时静默忽略（不阻塞降级流程）。
   */
  private backupCorruptedFile(): void {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${this.filePath}.corrupted.${timestamp}`;
      fs.renameSync(this.filePath, backupPath);
    } catch {
      // 备份失败静默忽略：降级流程优先，不因备份失败抛错
    }
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * LRU 淘汰算法
 *
 * 适用于 SuccessExperience / FailureExperience（含 accessCount + lastAccessedAt）。
 * 排序依据：先按 accessCount 升序，相同则按 lastAccessedAt 升序，保留 top N。
 *
 * @param items 经验条目数组
 * @param maxSize 最大容量
 * @returns 淘汰后的数组（长度 ≤ maxSize）
 */
function evictLRU<T extends { accessCount: number; lastAccessedAt: string }>(items: T[], maxSize: number): T[] {
  // 复制一份，避免修改原数组
  const sorted = [...items].sort((a, b) => {
    // 先按 accessCount 升序（访问次数少的排前面，优先淘汰）
    if (a.accessCount !== b.accessCount) {
      return a.accessCount - b.accessCount;
    }
    // accessCount 相同则按 lastAccessedAt 升序（最久未访问的排前面，优先淘汰）
    return a.lastAccessedAt.localeCompare(b.lastAccessedAt);
  });
  // 保留后 maxSize 个（即访问最频繁 / 最近访问的）
  return sorted.slice(-maxSize);
}

/**
 * 类型守卫：判断值是否为普通对象（非 null、非数组）
 *
 * @param value 待判断的值
 * @returns 是否为普通对象
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ============================================================================
// 导出常量（供测试与外部模块使用）
// ============================================================================

export { SCHEMA_VERSION, MAX_SUCCESS_EXPERIENCES, MAX_FAILURE_EXPERIENCES, MAX_EXPERIENCE_PATTERNS };
