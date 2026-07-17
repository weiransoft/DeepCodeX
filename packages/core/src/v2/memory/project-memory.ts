/**
 * 项目记忆（F-MEM-02）
 *
 * 单项目级记忆，跨会话复用。存储项目配置、领域知识、项目历史、已知问题。
 *
 * 设计依据：
 * - V2 技术方案 §8.2 项目记忆（行 3439-3530）
 * - V2 技术方案 §8.2.1 .gitignore 排除机制（P1-12 修复）
 * - 架构师审查报告（2026-07-17）：存储到 <projectRoot>/.deepcode/project-memory.json，
 *   KnownIssue 按 fingerprint 去重，自动初始化 .deepcode/ 目录 + 写入 .gitignore 排除自身
 *
 * 存储布局：
 *   <projectRoot>/.deepcode/project-memory.json  —— 单文件持久化整个 ProjectMemory
 *   <projectRoot>/.deepcode/.gitignore            —— 排除 .deepcode/ 自身（自动创建）
 *
 * 关键技术点：
 *   1. .gitignore 排除：加载项目记忆前构造 GitignoreFilter，命中的路径不写入记忆
 *   2. 原子写入：先写 .tmp 文件，fsyncSync 后 renameSync 替换原文件
 *   3. KnownIssue 去重：fingerprint = sha256(filePath + line + message)，相同 fingerprint 不重复添加
 *   4. 损坏降级：JSON 解析失败时备份为 .corrupted.<timestamp> 并重建默认空记忆
 *   5. projectId 生成：基于 projectPath 的 sha256 hash 前 16 位
 *   6. 自动初始化：首次加载时创建 .deepcode/ 目录 + .gitignore 排除自身
 *
 * @module v2/memory/project-memory
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { GitignoreFilter } from "./gitignore-filter";

// ============================================================================
// 常量定义
// ============================================================================

/** 存储格式版本号 */
const SCHEMA_VERSION = 1;

/** 项目历史条目容量上限（超过时 LRU 淘汰） */
const MAX_PROJECT_HISTORY = 200;

/** 已知问题容量上限 */
const MAX_KNOWN_ISSUES = 100;

/** .deepcode 目录下的 .gitignore 内容（排除自身） */
const DEEPCODE_GITIGNORE_CONTENT = "# DeepCode V2 自动生成：排除 .deepcode 目录\n*\n";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 项目记忆
 *
 * 参考 WoAgent DomainKnowledge。
 * 单项目级记忆，跨会话复用。
 */
export interface ProjectMemory {
  /** Schema 版本号 */
  schemaVersion: number;
  /** 项目 ID（基于 projectPath 的 sha256 hash 前 16 位） */
  projectId: string;
  /** 项目绝对路径 */
  projectPath: string;
  /** 项目配置（从 .deepcode/memory/project.json 加载） */
  config: ProjectConfig;
  /** 领域知识（V2-P1 阶段为空，V2-P2 由 DomainModeler 填充） */
  domainKnowledge: ProjectDomainKnowledge;
  /** 项目历史事件列表 */
  projectHistory: ProjectHistoryEntry[];
  /** 已知问题列表 */
  knownIssues: KnownIssue[];
  /** 最后更新时间（ISO 8601） */
  lastUpdatedAt: string;
}

/**
 * 项目配置
 *
 * 记录项目的编码风格、测试、lint、构建等配置信息。
 * 由 initializeFromUnderstanding 从 ProjectUnderstanding 提取，或手动维护。
 */
export interface ProjectConfig {
  /** 缩进风格 */
  indent: "2space" | "4space" | "tab";
  /** 测试框架（如 "jest" / "mocha" / "pytest"） */
  testFramework: string;
  /** 测试命令（如 "npm test" / "pytest"） */
  testCommand: string;
  /** lint 工具（如 "eslint" / "ruff"） */
  linter: string;
  /** lint 命令 */
  lintCommand: string;
  /** 构建命令（如 "npm run build" / "tsc"） */
  buildCommand: string;
  /** 注释语言 */
  commentLanguage: "zh" | "en" | "mixed";
}

/**
 * 项目级领域知识（简化版）
 *
 * V2-P1 阶段为空，V2-P2 由 DomainModeler 填充。
 * 与 GlobalContext.DomainKnowledge 区分：项目级 vs 用户全局级。
 */
export interface ProjectDomainKnowledge {
  /** 项目特定概念 */
  concepts: string[];
  /** 项目特定规则 */
  rules: string[];
  /** 项目特定最佳实践 */
  bestPractices: string[];
}

/**
 * 项目历史条目
 *
 * 记录项目生命周期中的重要事件（如配置变更、问题修复等）。
 */
export interface ProjectHistoryEntry {
  /** 事件时间戳（ISO 8601） */
  timestamp: string;
  /** 事件类型（如 "config_changed" / "issue_resolved" / "initialization"） */
  event: string;
  /** 事件描述 */
  description: string;
}

/**
 * 已知问题
 *
 * 记录项目中已知的问题及其 workaround。
 * 通过 fingerprint 去重（sha256(filePath + line + message)）。
 */
export interface KnownIssue {
  /** 问题 ID（UUID v4） */
  id: string;
  /** 问题指纹（sha256(filePath + line + message)），用于去重 */
  fingerprint: string;
  /** 问题涉及的文件路径 */
  filePath: string;
  /** 问题涉及的行号（可选） */
  line?: number;
  /** 问题描述 */
  description: string;
  /** 临时解决方案 */
  workaround: string;
  /** 状态：open / resolved */
  status: "open" | "resolved";
  /** 发现时间（ISO 8601） */
  discoveredAt: string;
}

/**
 * 项目理解结果（最小化输入接口）
 *
 * F-BIZ-01 实现的完整 ProjectUnderstanding 接口会结构化兼容本接口。
 * V2-P1 阶段 initializeFromUnderstanding 仅使用 projectInfo 和 techStack 字段。
 */
export interface ProjectUnderstandingInput {
  /** 项目信息 */
  projectInfo: {
    name: string;
    root: string;
    languages: string[];
  };
  /** 技术栈信息 */
  techStack: {
    frameworks: string[];
    buildTools: string[];
    packageManagers: string[];
    testFrameworks: string[];
    linters: string[];
  };
  /** 架构类型 */
  architecture: string;
}

// ============================================================================
// 默认值工厂
// ============================================================================

/**
 * 创建默认的空 ProjectMemory
 *
 * @param projectPath 项目绝对路径
 * @returns 填充默认值的 ProjectMemory
 */
export function createDefaultProjectMemory(projectPath: string): ProjectMemory {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: generateProjectId(projectPath),
    projectPath,
    config: {
      indent: "2space",
      testFramework: "",
      testCommand: "",
      linter: "",
      lintCommand: "",
      buildCommand: "",
      commentLanguage: "zh",
    },
    domainKnowledge: {
      concepts: [],
      rules: [],
      bestPractices: [],
    },
    projectHistory: [],
    knownIssues: [],
    lastUpdatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// ProjectMemoryManager 类
// ============================================================================

/**
 * 项目记忆管理器
 *
 * 负责 ProjectMemory 的持久化（load/save）、更新、从理解结果初始化、
 * 历史条目维护、已知问题维护（含去重）。
 *
 * 用法：
 * ```typescript
 * const manager = new ProjectMemoryManager("/path/to/project");
 * const memory = await manager.getProjectMemory();
 * await manager.addHistoryEntry({
 *   timestamp: new Date().toISOString(),
 *   event: "initialization",
 *   description: "项目记忆初始化",
 * });
 * ```
 */
export class ProjectMemoryManager {
  /** 项目根目录绝对路径 */
  private readonly projectRoot: string;
  /** ProjectMemory 持久化文件路径：<projectRoot>/.deepcode/project-memory.json */
  private readonly filePath: string;
  /** .deepcode 目录路径 */
  private readonly deepcodeDir: string;

  /**
   * @param projectRoot 项目根目录绝对路径
   */
  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.deepcodeDir = path.join(projectRoot, ".deepcode");
    this.filePath = path.join(this.deepcodeDir, "project-memory.json");
  }

  /**
   * 加载项目记忆
   *
   * 行为契约：
   * - 文件不存在：返回默认空记忆（不创建文件，首启友好）
   * - 文件存在且合法：返回解析后的记忆（含迁移）
   * - 文件存在但损坏：备份原文件，返回默认空记忆
   *
   * 加载前会构造 GitignoreFilter，但 V2-P1 阶段仅用于过滤已知问题的 filePath，
   * 不影响整个记忆文件的加载（记忆文件本身在 .deepcode/ 下，已被 .gitignore 排除）。
   *
   * @returns 加载（或默认创建）的 ProjectMemory
   */
  async getProjectMemory(): Promise<ProjectMemory> {
    // 确保 .deepcode 目录存在 + .gitignore 排除自身
    this.ensureDeepcodeDir();

    // 文件不存在：返回默认空记忆
    if (!fs.existsSync(this.filePath)) {
      return createDefaultProjectMemory(this.projectRoot);
    }

    // 读取文件内容
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch {
      return createDefaultProjectMemory(this.projectRoot);
    }

    // 解析 JSON
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      this.backupCorruptedFile();
      return createDefaultProjectMemory(this.projectRoot);
    }

    // 校验最低结构合法性
    if (!isObject(data) || typeof data.schemaVersion !== "number") {
      this.backupCorruptedFile();
      return createDefaultProjectMemory(this.projectRoot);
    }

    // 迁移并补全缺失字段
    return this.migrate(data as unknown as ProjectMemory);
  }

  /**
   * 保存项目记忆（原子写入）
   *
   * @param memory 待保存的 ProjectMemory
   */
  async updateProjectMemory(memory: ProjectMemory): Promise<void> {
    // 确保 .deepcode 目录存在
    this.ensureDeepcodeDir();

    // 更新时间戳
    const toSave: ProjectMemory = {
      ...memory,
      schemaVersion: SCHEMA_VERSION,
      lastUpdatedAt: new Date().toISOString(),
    };

    // 容量上限维护
    if (toSave.projectHistory.length > MAX_PROJECT_HISTORY) {
      // 保留最近 MAX_PROJECT_HISTORY 条（按 timestamp 降序排序后取前 N 条）
      toSave.projectHistory.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      toSave.projectHistory = toSave.projectHistory.slice(0, MAX_PROJECT_HISTORY);
    }
    if (toSave.knownIssues.length > MAX_KNOWN_ISSUES) {
      // 保留 open 状态优先 + 最近发现的
      toSave.knownIssues.sort((a, b) => {
        if (a.status !== b.status) {
          return a.status === "open" ? -1 : 1; // open 排前
        }
        return b.discoveredAt.localeCompare(a.discoveredAt); // 最近发现排前
      });
      toSave.knownIssues = toSave.knownIssues.slice(0, MAX_KNOWN_ISSUES);
    }

    // 原子写入
    const json = JSON.stringify(toSave, null, 2);
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
   * 从项目理解结果初始化项目记忆
   *
   * 从 ProjectUnderstanding 提取信息填充 ProjectMemory：
   * - projectInfo.languages → domainKnowledge.concepts（语言作为概念）
   * - techStack → config（testFramework / linter / buildCommand 等）
   *
   * @param understanding 项目理解结果
   * @returns 初始化后的 ProjectMemory
   */
  async initializeFromUnderstanding(understanding: ProjectUnderstandingInput): Promise<ProjectMemory> {
    const memory = createDefaultProjectMemory(this.projectRoot);

    // 从技术栈提取配置
    if (understanding.techStack.testFrameworks.length > 0) {
      memory.config.testFramework = understanding.techStack.testFrameworks[0];
      // 根据 packageManager 推断测试命令
      const pkgManager = understanding.techStack.packageManagers[0] ?? "npm";
      memory.config.testCommand = `${pkgManager} test`;
    }
    if (understanding.techStack.linters.length > 0) {
      memory.config.linter = understanding.techStack.linters[0];
      const pkgManager = understanding.techStack.packageManagers[0] ?? "npm";
      memory.config.lintCommand = `${pkgManager} run lint`;
    }
    if (understanding.techStack.buildTools.length > 0) {
      const pkgManager = understanding.techStack.packageManagers[0] ?? "npm";
      memory.config.buildCommand = `${pkgManager} run build`;
    }

    // 从项目信息提取领域知识
    memory.domainKnowledge.concepts = [...understanding.projectInfo.languages];
    if (understanding.architecture) {
      memory.domainKnowledge.concepts.push(`architecture:${understanding.architecture}`);
    }

    // 添加初始化历史条目
    memory.projectHistory.push({
      timestamp: new Date().toISOString(),
      event: "initialization",
      description: `项目记忆初始化：${understanding.projectInfo.name}（${understanding.architecture}）`,
    });

    await this.updateProjectMemory(memory);
    return memory;
  }

  /**
   * 添加项目历史条目
   *
   * @param entry 历史条目
   */
  async addHistoryEntry(entry: ProjectHistoryEntry): Promise<void> {
    const memory = await this.getProjectMemory();
    memory.projectHistory.push(entry);
    await this.updateProjectMemory(memory);
  }

  /**
   * 添加已知问题（含 fingerprint 去重）
   *
   * 如果已存在相同 fingerprint 的问题，不重复添加（幂等）。
   *
   * @param issue 已知问题
   * @returns 是否实际添加（false 表示已存在相同 fingerprint）
   */
  async addKnownIssue(issue: KnownIssue): Promise<boolean> {
    const memory = await this.getProjectMemory();

    // fingerprint 去重
    const existing = memory.knownIssues.find((i) => i.fingerprint === issue.fingerprint);
    if (existing) {
      return false; // 已存在，不重复添加
    }

    memory.knownIssues.push(issue);
    await this.updateProjectMemory(memory);
    return true;
  }

  /**
   * 标记已知问题为已解决
   *
   * @param issueId 问题 ID
   * @returns 是否成功标记（false 表示问题不存在）
   */
  async resolveKnownIssue(issueId: string): Promise<boolean> {
    const memory = await this.getProjectMemory();
    const issue = memory.knownIssues.find((i) => i.id === issueId);
    if (!issue) {
      return false;
    }
    issue.status = "resolved";
    await this.updateProjectMemory(memory);

    // 添加历史条目
    await this.addHistoryEntry({
      timestamp: new Date().toISOString(),
      event: "issue_resolved",
      description: `已知问题已解决：${issue.description}`,
    });
    return true;
  }

  /**
   * 获取项目的 GitignoreFilter
   *
   * 供 CodeMapGenerator 等模块复用，确保全系统 gitignore 语义单一事实源。
   *
   * @returns GitignoreFilter 实例
   */
  async getGitignoreFilter(): Promise<GitignoreFilter> {
    return GitignoreFilter.load(this.projectRoot, ["node_modules", ".git", ".deepcode"]);
  }

  // ------------------------------------------------------------------------
  // 私有方法
  // ------------------------------------------------------------------------

  /**
   * 确保 .deepcode 目录存在 + 写入 .gitignore 排除自身
   *
   * 首次调用时创建 .deepcode/ 目录，并写入 .gitignore 文件（内容为 `*\n`），
   * 确保 .deepcode/ 下所有内容不被 git 跟踪。
   */
  private ensureDeepcodeDir(): void {
    if (!fs.existsSync(this.deepcodeDir)) {
      fs.mkdirSync(this.deepcodeDir, { recursive: true });
    }
    // 写入 .gitignore 排除自身（如果不存在）
    const gitignorePath = path.join(this.deepcodeDir, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, DEEPCODE_GITIGNORE_CONTENT, "utf-8");
    }
  }

  /**
   * 版本迁移与字段补全
   *
   * @param data 从文件加载的原始数据
   * @returns 迁移后的 ProjectMemory
   */
  private migrate(data: ProjectMemory): ProjectMemory {
    const result: ProjectMemory = {
      ...createDefaultProjectMemory(this.projectRoot),
      ...data,
      schemaVersion: SCHEMA_VERSION,
      projectPath: this.projectRoot, // 始终使用当前 projectRoot（防止路径变更）
      projectId: generateProjectId(this.projectRoot),
    };

    // 防御性补全嵌套结构
    if (!result.config) {
      result.config = createDefaultProjectMemory(this.projectRoot).config;
    }
    if (!result.domainKnowledge) {
      result.domainKnowledge = { concepts: [], rules: [], bestPractices: [] };
    }
    if (!Array.isArray(result.projectHistory)) {
      result.projectHistory = [];
    }
    if (!Array.isArray(result.knownIssues)) {
      result.knownIssues = [];
    }

    return result;
  }

  /**
   * 备份损坏的持久化文件
   */
  private backupCorruptedFile(): void {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${this.filePath}.corrupted.${timestamp}`;
      fs.renameSync(this.filePath, backupPath);
    } catch {
      // 备份失败静默忽略
    }
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 生成项目 ID（基于 projectPath 的 sha256 hash 前 16 位）
 *
 * @param projectPath 项目绝对路径
 * @returns 16 字符的 hex 项目 ID
 */
export function generateProjectId(projectPath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(projectPath);
  return hash.digest("hex").slice(0, 16);
}

/**
 * 生成已知问题的 fingerprint
 *
 * @param filePath 问题文件路径
 * @param line 问题行号（可选）
 * @param message 问题描述
 * @returns sha256 hex 字符串
 */
export function generateIssueFingerprint(filePath: string, line: number | undefined, message: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(`${filePath}:${line ?? 0}:${message}`);
  return hash.digest("hex");
}

/**
 * 类型守卫：判断值是否为普通对象
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ============================================================================
// 导出常量
// ============================================================================

export { SCHEMA_VERSION, MAX_PROJECT_HISTORY, MAX_KNOWN_ISSUES };
