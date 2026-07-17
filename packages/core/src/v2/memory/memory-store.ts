/**
 * 记忆存储管理器（MemoryStore）
 *
 * 负责 V2 上下文记忆系统中记忆条目的持久化存储、读取、删除和管理。
 * 实现严格遵循 user rules：禁止 mock/占位/简化，使用真实文件 I/O。
 *
 * 存储布局（按 MemoryType 路由）：
 *   - user_global  → ~/.deepcode/memory/global.json
 *   - project      → <projectRoot>/.deepcode/memory/project.json
 *   - task         → 会话内存（不持久化，进程结束即销毁）
 *   - experience   → ~/.deepcode/memory/experience.json
 *
 * 关键技术点：
 *   1. 原子写入：先写 .tmp 文件，fsyncSync 后 renameSync 替换原文件，
 *      避免半写状态导致数据损坏（参考现有 notes-memory.ts 模式）。
 *   2. ID 生成：使用 crypto.randomUUID()（Node.js 标准 API，UUID v4）。
 *   3. 损坏降级：JSON 解析失败时将原文件重命名为 .corrupted 备份，
 *      并以空存储继续工作（W-06 记忆透明化 / US-ERR-002）。
 *   4. 并发安全：写入使用临时文件 + rename 保证原子性（同一进程内串行调用）。
 *   5. 文件不存在时返回空存储，不抛异常（首启友好）。
 *
 * 设计依据：
 * - V2 技术方案 §8.5 记忆持久化
 * - V2 测试方案 §2.9 MEM-01 ~ MEM-10
 *
 * @module v2/memory/memory-store
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { MemoryEntry, MemoryStoreData, MemoryType, MemoryListResult, MemoryDeleteResult } from "./types";

/** 存储格式版本号（用于未来格式升级的兼容判断） */
const STORE_VERSION = "1.0";

/** 持久化的 MemoryType 集合（task 类型不持久化，仅存内存） */
const PERSISTENT_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>(["user_global", "project", "experience"]);

/**
 * 记忆存储管理器
 *
 * 封装记忆的增删查改与持久化逻辑。一个实例对应一组存储路径
 * （用户全局 + 项目 + 经验），task 类型记忆仅在内存中存活。
 *
 * 用法：
 * ```typescript
 * const store = new MemoryStore(process.cwd());
 * const entry = store.add({
 *   type: "user_global",
 *   key: "preferred_language",
 *   value: "TypeScript",
 *   confidence: 0.9,
 *   source: "user_explicit",
 * });
 * const list = store.list();
 * store.delete(entry.id);
 * ```
 */
export class MemoryStore {
  /** 用户全局记忆持久化路径：~/.deepcode/memory/global.json */
  private readonly globalMemoryPath: string;
  /** 经验记忆持久化路径：~/.deepcode/memory/experience.json */
  private readonly experienceMemoryPath: string;
  /** 项目记忆持久化路径：<projectRoot>/.deepcode/memory/project.json（无项目上下文时为 null） */
  private readonly projectMemoryPath: string | null;

  /** 任务临时记忆（仅存内存，进程结束即销毁） */
  private taskEntries: MemoryEntry[] = [];

  /**
   * 创建记忆存储管理器
   *
   * @param projectRoot 项目根目录绝对路径（null 表示无项目上下文，project 类型记忆将无法持久化）
   */
  constructor(projectRoot?: string | null) {
    const homeDir = os.homedir();
    const globalMemoryDir = path.join(homeDir, ".deepcode", "memory");

    this.globalMemoryPath = path.join(globalMemoryDir, "global.json");
    this.experienceMemoryPath = path.join(globalMemoryDir, "experience.json");

    this.projectMemoryPath = projectRoot ? path.join(projectRoot, ".deepcode", "memory", "project.json") : null;
  }

  /**
   * 列出所有记忆（聚合所有持久化文件 + 任务内存）
   *
   * @param typeFilter 可选的类型过滤器，仅返回指定类型的记忆
   * @returns 记忆列表结果，包含总数、按类型统计、条目列表（按 createdAt 升序）
   */
  list(typeFilter?: MemoryType): MemoryListResult {
    // 聚合所有来源的记忆条目
    const allEntries: MemoryEntry[] = [];

    // 读取持久化的三种类型
    for (const type of PERSISTENT_TYPES) {
      // project 类型仅在 projectRoot 可用时才有持久化文件
      if (type === "project" && !this.projectMemoryPath) {
        continue;
      }
      const storePath = this.getStorePath(type);
      const data = this.readFile(storePath);
      allEntries.push(...data.entries);
    }

    // 追加任务内存中的条目
    allEntries.push(...this.taskEntries);

    // 按类型过滤
    const filtered = typeFilter ? allEntries.filter((e) => e.type === typeFilter) : allEntries;

    // 按 createdAt 升序排列（创建时间早的在前）
    filtered.sort((a, b) => {
      const ta = a.createdAt || "";
      const tb = b.createdAt || "";
      if (ta === tb) return 0;
      return ta < tb ? -1 : 1;
    });

    // 按类型统计
    const byType: Record<MemoryType, number> = {
      user_global: 0,
      project: 0,
      task: 0,
      experience: 0,
    };
    for (const entry of allEntries) {
      byType[entry.type] += 1;
    }

    return {
      total: filtered.length,
      byType,
      entries: filtered,
    };
  }

  /**
   * 根据 ID 获取单条记忆
   *
   * 跨所有存储来源（持久化文件 + 任务内存）查找。
   *
   * @param id 记忆 ID（UUID v4）
   * @returns 找到的记忆条目；未找到返回 null
   */
  getById(id: string): MemoryEntry | null {
    if (!id) {
      return null;
    }
    // 先在任务内存中查找
    const inMemory = this.taskEntries.find((e) => e.id === id);
    if (inMemory) {
      return inMemory;
    }
    // 在持久化文件中查找
    for (const type of PERSISTENT_TYPES) {
      if (type === "project" && !this.projectMemoryPath) {
        continue;
      }
      const storePath = this.getStorePath(type);
      const data = this.readFile(storePath);
      const found = data.entries.find((e) => e.id === id);
      if (found) {
        return found;
      }
    }
    return null;
  }

  /**
   * 添加新记忆
   *
   * 根据 entry.type 路由到对应的存储位置：
   *   - 持久化类型：写入对应文件
   *   - task 类型：仅写入内存
   *
   * @param entry 记忆条目（不含 id/createdAt/updatedAt，由本方法自动填充）
   * @returns 完整的记忆条目（含生成的 ID 和时间戳）
   */
  add(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): MemoryEntry {
    // 参数校验：类型合法、键非空、置信度在 0-1 范围内
    if (!entry || typeof entry.type !== "string") {
      throw new TypeError("entry.type 必须是字符串");
    }
    if (!entry.key || typeof entry.key !== "string") {
      throw new TypeError("entry.key 必须是非空字符串");
    }
    if (typeof entry.confidence !== "number" || entry.confidence < 0 || entry.confidence > 1) {
      throw new TypeError("entry.confidence 必须是 0-1 之间的数字");
    }

    const now = new Date().toISOString();
    const fullEntry: MemoryEntry = {
      ...entry,
      id: this.generateId(),
      createdAt: now,
      updatedAt: now,
    };

    if (entry.type === "task") {
      // task 类型不持久化，仅存内存
      this.taskEntries.push(fullEntry);
      return fullEntry;
    }

    // 持久化类型：写入对应文件
    if (entry.type === "project" && !this.projectMemoryPath) {
      throw new Error("无法添加 project 类型记忆：未提供 projectRoot（项目根目录）");
    }

    const storePath = this.getStorePath(entry.type);
    const data = this.readFile(storePath);
    data.entries.push(fullEntry);
    data.lastUpdated = now;
    this.writeFile(storePath, data);

    return fullEntry;
  }

  /**
   * 删除记忆
   *
   * 跨所有存储来源查找并删除指定 ID 的记忆条目。
   *
   * @param id 记忆 ID（UUID v4）
   * @returns 删除结果（含被删除的条目或失败原因）
   */
  delete(id: string): MemoryDeleteResult {
    if (!id) {
      return {
        deleted: false,
        reason: "记忆 ID 不能为空",
      };
    }

    // 先在任务内存中查找删除
    const memIdx = this.taskEntries.findIndex((e) => e.id === id);
    if (memIdx >= 0) {
      const deletedEntry = this.taskEntries[memIdx]!;
      this.taskEntries.splice(memIdx, 1);
      return { deleted: true, deletedEntry };
    }

    // 在持久化文件中查找删除
    for (const type of PERSISTENT_TYPES) {
      if (type === "project" && !this.projectMemoryPath) {
        continue;
      }
      const storePath = this.getStorePath(type);
      const data = this.readFile(storePath);
      const idx = data.entries.findIndex((e) => e.id === id);
      if (idx >= 0) {
        const deletedEntry = data.entries[idx]!;
        data.entries.splice(idx, 1);
        data.lastUpdated = new Date().toISOString();
        this.writeFile(storePath, data);
        return { deleted: true, deletedEntry };
      }
    }

    return {
      deleted: false,
      reason: `记忆不存在: ${id}`,
    };
  }

  /**
   * 清空所有记忆（危险操作，调用方需做二次确认）
   *
   * 清空所有持久化文件中的条目以及任务内存。
   * 持久化文件本身不会被删除，而是被重写为空存储结构（保留 version 等元信息）。
   *
   * @returns 被清空的总记忆条目数
   */
  deleteAll(): { deleted: number } {
    let deleted = 0;

    // 清空任务内存
    deleted += this.taskEntries.length;
    this.taskEntries = [];

    // 清空所有持久化文件
    const now = new Date().toISOString();
    for (const type of PERSISTENT_TYPES) {
      if (type === "project" && !this.projectMemoryPath) {
        continue;
      }
      const storePath = this.getStorePath(type);
      const data = this.readFile(storePath);
      deleted += data.entries.length;
      // 仅在原有条目非空时才写回（避免无谓的磁盘 IO）
      if (data.entries.length > 0) {
        const empty = this.createEmptyStore();
        empty.lastUpdated = now;
        this.writeFile(storePath, empty);
      }
    }

    return { deleted };
  }

  /**
   * 导出所有记忆为 JSON 字符串
   *
   * 聚合所有存储来源的记忆条目，输出为格式化的 JSON 字符串。
   * 用于 /memory export 子命令，方便用户备份或迁移。
   *
   * @returns JSON 字符串（结构为 { entries, version, lastUpdated, exportedAt }）
   */
  export(): string {
    const list = this.list();
    const payload = {
      entries: list.entries,
      version: STORE_VERSION,
      lastUpdated: new Date().toISOString(),
      exportedAt: new Date().toISOString(),
    };
    // 格式化输出（2 空格缩进），便于人类阅读
    return JSON.stringify(payload, null, 2);
  }

  // ========================================================================
  // 私有方法：文件读写、原子写入、ID 生成等
  // ========================================================================

  /**
   * 读取持久化文件
   *
   * - 文件不存在 → 返回空存储（不抛异常）
   * - JSON 解析失败 → 将原文件重命名为 .corrupted 备份，返回空存储（W-06 记忆透明化）
   * - 正常解析 → 返回 MemoryStoreData
   *
   * @param filePath 持久化文件路径
   * @returns 记忆存储数据（永不返回 null，损坏时返回空存储）
   */
  private readFile(filePath: string): MemoryStoreData {
    if (!fs.existsSync(filePath)) {
      return this.createEmptyStore();
    }
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (_err) {
      // 读取出错（如权限问题）：降级为空存储，不破坏调用方
      return this.createEmptyStore();
    }
    try {
      const parsed = JSON.parse(content) as MemoryStoreData;
      // 基本结构校验：确保 entries 数组与 version 字段存在
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
        throw new Error("Invalid store structure: missing entries array");
      }
      // 兼容旧文件：若 version 缺失则补上默认值
      if (typeof parsed.version !== "string") {
        parsed.version = STORE_VERSION;
      }
      if (typeof parsed.lastUpdated !== "string") {
        parsed.lastUpdated = new Date().toISOString();
      }
      return parsed;
    } catch {
      // JSON 解析失败：备份损坏文件并降级为空存储（MEM-07 测试用例覆盖）
      this.backupCorruptedFile(filePath);
      return this.createEmptyStore();
    }
  }

  /**
   * 写入持久化文件（原子写入：tmp + fsync + rename）
   *
   * @param filePath 目标文件路径
   * @param data 记忆存储数据
   */
  private writeFile(filePath: string, data: MemoryStoreData): void {
    // 确保目录存在
    this.ensureDir(path.dirname(filePath));
    // 序列化为 JSON（2 空格缩进，便于阅读和 diff）
    const content = JSON.stringify(data, null, 2);
    this.atomicWrite(filePath, content);
  }

  /**
   * 原子写入实现：先写 .tmp 文件 → fsyncSync → renameSync
   *
   * 保证文件内容的原子性：要么完整写入，要么完全不变，
   * 避免半写状态导致后续读取时 JSON 解析失败。
   *
   * @param filePath 目标文件路径
   * @param content 完整文件内容
   */
  private atomicWrite(filePath: string, content: string): void {
    const tmpPath = `${filePath}.tmp`;
    // 以同步方式打开 .tmp 文件（O_WRONLY | O_CREAT | O_TRUNC）
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeSync(fd, content, 0, "utf-8");
      // 强制 fsync：确保数据落盘后再 rename，避免系统缓存丢失
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // 原子 rename（POSIX 保证 rename 是原子操作）
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * 备份损坏的持久化文件
   *
   * 将原文件重命名为 <filePath>.corrupted，便于后续排查（W-06 记忆透明化）。
   * 若 .corrupted 文件已存在，追加时间戳后缀避免覆盖。
   *
   * @param filePath 损坏的文件路径
   */
  private backupCorruptedFile(filePath: string): void {
    try {
      const backupPath = `${filePath}.corrupted`;
      // 若 .corrupted 已存在，追加时间戳后缀
      let targetPath = backupPath;
      if (fs.existsSync(backupPath)) {
        const ts = Date.now();
        targetPath = `${filePath}.corrupted.${ts}`;
      }
      fs.renameSync(filePath, targetPath);
    } catch {
      // 备份失败不影响主流程（最坏情况是损坏文件留在原地，
      // 下次读取仍会再次触发降级，不会造成数据损坏扩散）
    }
  }

  /**
   * 生成唯一 ID（UUID v4）
   *
   * 使用 Node.js 标准 API crypto.randomUUID()，
   * 无需第三方依赖，符合 Karpathy Simplicity First 原则。
   *
   * @returns UUID v4 字符串
   */
  private generateId(): string {
    return crypto.randomUUID();
  }

  /**
   * 根据 MemoryType 获取对应的持久化文件路径
   *
   * @param type 记忆类型（必须是持久化类型，task 类型不能调用此方法）
   * @returns 文件路径
   * @throws 当 type 为 task 或 project 类型但 projectRoot 为 null 时抛错
   */
  private getStorePath(type: MemoryType): string {
    switch (type) {
      case "user_global":
        return this.globalMemoryPath;
      case "experience":
        return this.experienceMemoryPath;
      case "project":
        if (!this.projectMemoryPath) {
          throw new Error("project 类型记忆需要 projectRoot，但当前 MemoryStore 未提供项目根目录");
        }
        return this.projectMemoryPath;
      case "task":
        throw new Error("task 类型记忆不持久化，不应调用 getStorePath");
      default:
        throw new Error(`未知的记忆类型: ${type as string}`);
    }
  }

  /**
   * 确保目录存在（递归创建）
   *
   * @param dirPath 目录路径
   */
  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * 创建空的记忆存储数据
   *
   * 用于首次启动（文件不存在）或文件损坏降级时的初始化。
   *
   * @returns 空的 MemoryStoreData（entries 为空数组，version 为当前版本号）
   */
  private createEmptyStore(): MemoryStoreData {
    return {
      entries: [],
      version: STORE_VERSION,
      lastUpdated: new Date().toISOString(),
    };
  }
}
