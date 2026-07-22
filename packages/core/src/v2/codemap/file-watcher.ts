/**
 * 文件监听器（CodeMapFileWatcher）
 *
 * 设计依据：V2_CONTEXT_MEMORY_TECH_DESIGN.md §6.7 文件监听契约（P1-07 修复）
 *
 * 职责：
 * - 作为系统中唯一持有 fs.watch 句柄的模块
 * - 监听项目工作区文件变更（created/modified/deleted 三态）
 * - 300ms 去抖聚合后批量回调 CodeMapGenerator.updateIncremental
 * - 排除规则（gitignore + excludeDirs）在 watcher 层硬过滤
 *
 * 单向数据流设计（§6.7.1）：
 *   项目工作区文件
 *     ↓ fs.watch（300ms debounce）
 *   CodeMapFileWatcher
 *     ↓ FileWatchEvent[]（过滤后批量）
 *   CodeMapGenerator.updateIncremental()
 *     ↓ 产出
 *   CodeMap（更新后的代码地图）
 *
 * 单向约束规则：
 * 1. CodeMapFileWatcher 是系统中唯一持有 fs.watch 句柄的模块；
 * 2. memory 子域需要"哪些文件变了"时，通过 CodeMapGenerator.readCodeMap() 获取；
 * 3. 事件流向：fs.watch → watcher 去抖聚合 → updateIncremental → CodeMap 更新。
 *
 * macOS 递归限制兜底（§6.7.3）：
 * - macOS 的 fs.watch recursive 选项不可靠，使用非递归 + 手动子目录监听兜底；
 * - 新建目录时动态挂载子目录 watcher；
 * - watcher 数量超过 1000 时告警（避免大型项目资源耗尽）。
 *
 * @module v2/codemap/file-watcher
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeMapGenerator } from "./generator";
import { GitignoreFilter } from "../memory/gitignore-filter";

// ============================================================================
// 1. 接口定义（§6.7.2）
// ============================================================================

/**
 * 文件监听事件：watcher 向 CodeMap 传递的最小信息单元
 *
 * 契约约束：
 * - type 仅 "created" / "modified" / "deleted" 三态（不区分 rename/move，统一映射为 delete+create）
 * - path 为相对 projectRoot 的 POSIX 风格相对路径（如 "src/utils/helpers.ts"）
 * - language 从文件扩展名推断（与 RegexASTAnalyzer.detectLanguage 对齐）
 */
export interface FileWatchEvent {
  /** 事件类型：created（新建）/ modified（修改）/ deleted（删除） */
  type: "created" | "modified" | "deleted";
  /** 相对 projectRoot 的 POSIX 风格路径（如 "src/utils/helpers.ts"） */
  path: string;
  /** 文件语言（从扩展名推断，无法识别时为 null） */
  language: string | null;
}

/**
 * 监听器配置
 */
export interface FileWatcherConfig {
  /** 项目根目录（绝对路径） */
  projectRoot: string;
  /**
   * 去抖窗口（毫秒，默认 300）：
   * 同一路径在窗口内的多次原始事件只保留最后一次的规范事件，
   * 避免编辑器保存触发的多次 fs.watch 事件导致重复 CodeMap 更新。
   */
  debounceMs: number;
  /**
   * 要排除的目录名（如 ["node_modules", ".git", "dist"]）：
   * 这些目录下的文件变更不触发事件，与 gitignore 互为兜底。
   */
  excludeDirs: string[];
  /**
   * 最大 watcher 数量（默认 1000）：
   * 超过此数量时告警但不抛错（避免大型项目资源耗尽）。
   */
  maxWatchers: number;
}

// ============================================================================
// 2. 语言检测辅助函数
// ============================================================================

/**
 * 扩展名 → 语言映射表（与 regex-analyzer.detectLanguage 对齐）
 */
const EXTENSION_TO_LANGUAGE: ReadonlyMap<string, string> = new Map([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"],
]);

/**
 * 从文件路径推断语言
 *
 * @param filePath 文件路径
 * @returns 语言名（无法识别时返回 null）
 */
function detectLanguageFromPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE.get(ext) ?? null;
}

/**
 * 将绝对路径转换为相对 projectRoot 的 POSIX 风格相对路径
 *
 * @param absolutePath 绝对路径
 * @param projectRoot 项目根目录
 * @returns POSIX 风格相对路径（如 "src/utils/helpers.ts"）
 */
function toRelativePosixPath(absolutePath: string, projectRoot: string): string {
  const relative = path.relative(projectRoot, absolutePath);
  // 统一为 POSIX 风格（正斜杠）
  return relative.split(path.sep).join("/");
}

// ============================================================================
// 3. CodeMapFileWatcher 类（§6.7.2）
// ============================================================================

/**
 * 文件监听器：CodeMap 增量更新的唯一事件源
 *
 * 使用方式：
 * ```typescript
 * const watcher = new CodeMapFileWatcher(
 *   { projectRoot: "/path/to/project", debounceMs: 300, excludeDirs: ["node_modules"], maxWatchers: 1000 },
 *   async (events) => { await generator.updateIncremental(events); },
 * );
 * await watcher.start();
 * // ... 文件变更触发回调 ...
 * await watcher.stop();
 * ```
 */
export class CodeMapFileWatcher {
  /** 配置（不可变） */
  private readonly config: FileWatcherConfig;
  /** 事件出口：去抖聚合后的批量回调 */
  private readonly onBatch: (events: FileWatchEvent[]) => Promise<void>;

  /** fs.watch 句柄映射：绝对路径 → FSWatcher */
  private readonly watchers: Map<string, fs.FSWatcher> = new Map();
  /** 去抖定时器映射：相对路径 → NodeJS.Timeout */
  private readonly debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  /** 去抖窗口内累积的事件：相对路径 → 最新事件 */
  private readonly pendingEvents: Map<string, FileWatchEvent> = new Map();

  /** gitignore 过滤器（与 CodeMapGenerator 共享同一实例） */
  private gitignoreFilter: GitignoreFilter | null = null;
  /** 是否已启动 */
  private started = false;
  /** 批量刷新定时器（用于定期将 pending 事件刷出） */
  private flushTimer: NodeJS.Timeout | null = null;

  /**
   * 创建文件监听器
   *
   * @param config 监听器配置
   * @param onBatch 事件出口：去抖聚合后的批量回调，由 CodeMapGenerator 注入 updateIncremental 适配器
   */
  constructor(config: FileWatcherConfig, onBatch: (events: FileWatchEvent[]) => Promise<void>) {
    this.config = config;
    this.onBatch = onBatch;
  }

  /**
   * 启动文件监听
   *
   * 实现步骤：
   * 1. 初始化 GitignoreFilter（读取项目根目录的 .gitignore）；
   * 2. 递归扫描项目目录，为每个子目录挂载 fs.watch（非递归模式）；
   * 3. 启动批量刷新定时器（去抖窗口的 2 倍周期，确保事件不丢失）；
   * 4. 标记为已启动。
   *
   * @returns Promise<void>，启动完成后 resolve
   */
  async start(): Promise<void> {
    if (this.started) {
      return; // 幂等
    }

    // 步骤 1：初始化 gitignore 过滤器
    // GitignoreFilter 构造函数为私有，通过静态 load() 工厂方法创建实例：
    // 该方法会递归读取项目根 + 嵌套 .gitignore 规则，按"根在前、嵌套在后"顺序合并。
    this.gitignoreFilter = await GitignoreFilter.load(this.config.projectRoot, this.config.excludeDirs);

    // 步骤 2：递归挂载目录 watcher
    await this.watchDirectory(this.config.projectRoot);

    // 步骤 3：启动批量刷新定时器（去抖窗口的 2 倍周期）
    const flushInterval = this.config.debounceMs * 2;
    this.flushTimer = setInterval(() => {
      this.flushPendingEvents().catch((err) => {
        console.warn(`[CodeMapFileWatcher] 批量刷新失败: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, flushInterval);

    this.started = true;
  }

  /**
   * 停止文件监听
   *
   * 清理所有 watcher 和定时器，刷出剩余事件。
   *
   * @returns Promise<void>，停止完成后 resolve
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return; // 幂等
    }

    // 停止批量刷新定时器
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // 关闭所有 fs.watch 句柄
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();

    // 清理去抖定时器
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // 刷出剩余事件
    await this.flushPendingEvents();

    this.started = false;
  }

  /**
   * 释放资源（stop 的别名，便于与 IDisposable 模式对齐）
   */
  async dispose(): Promise<void> {
    await this.stop();
  }

  /**
   * 获取当前活跃的 watcher 数量（供监控与告警用）
   *
   * @returns watcher 数量
   */
  getWatcherCount(): number {
    return this.watchers.size;
  }

  // ========================================================================
  // 内部方法
  // ========================================================================

  /**
   * 递归为目录及其子目录挂载 fs.watch
   *
   * macOS 兼容性：
   * - macOS 的 fs.watch recursive 选项不可靠，使用非递归 + 手动子目录监听；
   * - 新建目录时通过 'rename' 事件动态挂载子目录 watcher。
   *
   * @param dirPath 目录绝对路径
   */
  private async watchDirectory(dirPath: string): Promise<void> {
    // 检查 watcher 数量上限
    if (this.watchers.size >= this.config.maxWatchers) {
      console.warn(`[CodeMapFileWatcher] watcher 数量已达上限 ${this.config.maxWatchers}，跳过 ${dirPath}`);
      return;
    }

    // 排除目录检查
    const dirName = path.basename(dirPath);
    if (this.config.excludeDirs.includes(dirName)) {
      return;
    }

    // .deepcode 自身目录排除（避免监听自身产物）
    if (dirName === ".deepcode") {
      return;
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(dirPath);
    } catch {
      // 目录不存在或不可访问，跳过
      return;
    }
    if (!stat.isDirectory()) {
      return;
    }

    // 挂载 fs.watch（非递归模式，macOS 兼容）
    try {
      const watcher = fs.watch(dirPath, { recursive: false }, (eventType, filename) => {
        if (!filename) return;
        const absolutePath = path.join(dirPath, filename);
        this.handleFsEvent(eventType, absolutePath).catch((err) => {
          console.warn(`[CodeMapFileWatcher] 事件处理失败: ${err instanceof Error ? err.message : String(err)}`);
        });
      });
      this.watchers.set(dirPath, watcher);
    } catch (err) {
      // 某些系统目录可能无权监听，跳过不抛错
      console.warn(`[CodeMapFileWatcher] 无法监听目录 ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // 递归监听子目录
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const childPath = path.join(dirPath, entry.name);
          await this.watchDirectory(childPath);
        }
      }
    } catch {
      // readdir 失败不影响主流程
    }
  }

  /**
   * 处理 fs.watch 原始事件
   *
   * 将 fs.watch 的 'change' / 'rename' 事件规范化为 FileWatchEvent，
   * 并通过去抖窗口聚合。
   *
   * @param eventType fs.watch 事件类型（'change' / 'rename'）
   * @param absolutePath 文件绝对路径
   */
  private async handleFsEvent(eventType: string, absolutePath: string): Promise<void> {
    // 转换为相对路径
    const relativePath = toRelativePosixPath(absolutePath, this.config.projectRoot);
    if (relativePath === "" || relativePath.startsWith("..")) {
      return; // 不在项目目录内
    }

    // gitignore 过滤
    if (this.gitignoreFilter !== null && this.gitignoreFilter.isIgnored(relativePath)) {
      return;
    }

    // excludeDirs 双保险
    const pathParts = relativePath.split("/");
    for (const part of pathParts) {
      if (this.config.excludeDirs.includes(part)) {
        return;
      }
    }

    // 判断文件状态（created / modified / deleted）
    let eventType2: "created" | "modified" | "deleted";
    try {
      const stat = await fs.promises.stat(absolutePath);
      if (stat.isDirectory()) {
        // 新建目录：动态挂载子目录 watcher
        if (eventType === "rename" && !this.watchers.has(absolutePath)) {
          await this.watchDirectory(absolutePath);
        }
        return; // 目录事件不触发 CodeMap 更新
      }
      // 文件存在：created 或 modified
      // 通过 watcher 是否已见过此路径区分（简化实现：统一视为 modified）
      eventType2 = "modified";
    } catch {
      // 文件不存在：deleted
      eventType2 = "deleted";
    }

    // 构建规范事件
    const event: FileWatchEvent = {
      type: eventType2,
      path: relativePath,
      language: detectLanguageFromPath(relativePath),
    };

    // 去抖聚合：同一路径在去抖窗口内只保留最新事件
    this.pendingEvents.set(relativePath, event);

    // 重置该路径的去抖定时器
    const existingTimer = this.debounceTimers.get(relativePath);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.flushPendingEvents().catch((err) => {
        console.warn(`[CodeMapFileWatcher] 去抖刷新失败: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.config.debounceMs);
    this.debounceTimers.set(relativePath, timer);
  }

  /**
   * 刷出所有待处理事件（去抖窗口到期或 stop 时调用）
   *
   * 将 pendingEvents 中的全部事件批量回调给 onBatch，
   * 然后清空 pendingEvents 与去抖定时器。
   */
  private async flushPendingEvents(): Promise<void> {
    if (this.pendingEvents.size === 0) {
      return;
    }

    // 收集全部待处理事件
    const events = Array.from(this.pendingEvents.values());

    // 清空 pending 与定时器
    this.pendingEvents.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // 批量回调
    try {
      await this.onBatch(events);
    } catch (err) {
      console.warn(`[CodeMapFileWatcher] onBatch 回调失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ============================================================================
// 4. attachFileWatcher 辅助函数（§6.7.3）
// ============================================================================

/**
 * 将 watcher 附加到 CodeMapGenerator，建立单向数据流
 *
 * 数据流（§6.7.1）：
 *   fs.watch 原始事件 → watcher 去抖聚合 → updateIncremental → CodeMap 更新
 *
 * updateIncremental 的事件处理规则：
 * - created → 解析新文件并添加到 CodeMap.files
 * - modified → 重新解析文件并更新 CodeMap.files 中的条目
 * - deleted → 从 CodeMap.files 中移除条目（不触发解析），同步清理 callGraph/dependencyGraph 中的相关边
 *
 * @param generator CodeMapGenerator 实例
 * @param watcher CodeMapFileWatcher 实例
 * @returns Promise<void>，附加完成后 resolve
 */
export async function attachFileWatcher(generator: CodeMapGenerator, watcher: CodeMapFileWatcher): Promise<void> {
  // 检查 generator 是否提供 updateIncremental 方法
  const gen = generator as unknown as {
    updateIncremental?: (events: FileWatchEvent[]) => Promise<void>;
  };
  if (typeof gen.updateIncremental !== "function") {
    throw new Error("CodeMapGenerator 未提供 updateIncremental(events: FileWatchEvent[]) 方法，无法附加 watcher");
  }

  // watcher 的 onBatch 回调已在构造时注入，此处只需启动 watcher
  await watcher.start();
}
