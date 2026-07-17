/**
 * Memory 模块类型定义
 *
 * 定义记忆条目、记忆类型、存储结构等核心类型契约。
 * 这些类型是 V2 上下文记忆系统（F-MEM-01/02）的基础数据模型，
 * 用于在用户全局、项目、任务、经验四个维度持久化与读取记忆。
 *
 * 设计依据：
 * - V2 上下文记忆 PRD §US-MEM-001/002/003
 * - V2 技术方案 §8.5 记忆持久化（原子写入：tmp + fsync + rename）
 * - V2 测试方案 §2.9 MEM 系列（含 MEM-07 文件损坏降级）
 *
 * @module v2/memory/types
 */

/**
 * 记忆类型：标识记忆条目所属的存储维度
 *
 * - "user_global"：用户全局记忆，跨项目共享，持久化到 ~/.deepcode/memory/global.json
 * - "project"：项目记忆，绑定单个项目，持久化到 <project>/.deepcode/memory/project.json
 * - "task"：任务临时记忆，仅存在于会话内存中，不持久化（任务结束即销毁）
 * - "experience"：经验记忆，跨项目沉淀的成功/失败经验，持久化到 ~/.deepcode/memory/experience.json
 */
export type MemoryType = "user_global" | "project" | "task" | "experience";

/**
 * 记忆来源：标识记忆条目的产生方式
 *
 * - "auto_extracted"：系统自动从对话/操作中提取
 * - "user_explicit"：用户显式声明或通过命令录入
 * - "system_default"：系统默认初始化（如首次启动时的预设项）
 */
export type MemorySource = "auto_extracted" | "user_explicit" | "system_default";

/**
 * 单条记忆条目
 *
 * 是 MemoryStore 管理的最小数据单元，包含唯一 ID、类型、键值、
 * 置信度、来源、时间戳以及可选的标签和元数据。
 */
export interface MemoryEntry {
  /** 唯一标识（UUID v4 格式，由 crypto.randomUUID() 生成） */
  id: string;
  /** 记忆类型，决定持久化路径与生命周期 */
  type: MemoryType;
  /** 记忆键（如 "preferred_language"、"project_convention" 等语义化标识） */
  key: string;
  /** 记忆值（自由文本，描述键对应的具体内容） */
  value: string;
  /** 置信度（0-1，越高表示越可信，用于排序与过滤） */
  confidence: number;
  /** 来源，标识记忆的产生方式 */
  source: MemorySource;
  /** 创建时间（ISO 8601 字符串，UTC） */
  createdAt: string;
  /** 最后更新时间（ISO 8601 字符串，UTC） */
  updatedAt: string;
  /** 标签列表（可选，用于分类与检索） */
  tags?: string[];
  /** 额外元数据（可选，存放与业务相关的扩展字段） */
  metadata?: Record<string, unknown>;
}

/**
 * 记忆存储结构：单个持久化文件的 JSON 顶层结构
 *
 * 用于 global.json / project.json / experience.json 等持久化文件。
 * 文件损坏（JSON 解析失败）时，MemoryStore 会将其重命名为 .corrupted 备份，
 * 并以空存储（createEmptyStore）继续工作（W-06 记忆透明化）。
 */
export interface MemoryStoreData {
  /** 该文件下的所有记忆条目 */
  entries: MemoryEntry[];
  /** 存储格式版本（当前为 "1.0"），用于未来格式升级时的兼容判断 */
  version: string;
  /** 最后更新时间（ISO 8601 字符串，UTC） */
  lastUpdated: string;
}

/**
 * /memory list 命令的输出结构
 *
 * 包含记忆总数、按类型的统计信息以及完整的记忆列表，
 * 由 handleList 子命令构造，用于命令行展示与结构化访问。
 */
export interface MemoryListResult {
  /** 总记忆数（所有类型合计） */
  total: number;
  /** 按类型统计的记忆数量（键为 MemoryType，值为该类型的条目数） */
  byType: Record<MemoryType, number>;
  /** 记忆列表（按 createdAt 升序排列） */
  entries: MemoryEntry[];
}

/**
 * /memory delete 命令的输出结构
 *
 * 标识删除操作的成功/失败结果，失败时附上原因说明。
 */
export interface MemoryDeleteResult {
  /** 是否删除成功 */
  deleted: boolean;
  /** 被删除的记忆条目（成功时返回，失败时为 undefined） */
  deletedEntry?: MemoryEntry;
  /** 失败原因（如 "记忆不存在: <id>"，成功时为 undefined） */
  reason?: string;
}
