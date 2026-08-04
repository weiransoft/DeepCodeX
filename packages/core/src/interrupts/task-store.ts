/**
 * 任务持久化存储 —— ADR-DI-001 §5.5 实现
 *
 * 本模块实现 `TaskStore` 类，是动态指令注入特性的持久化层。
 *
 * 核心职责（对齐 ADR-DI-001 §5.5）：
 * 1. 将 BackgroundTask 序列化为 TaskSnapshot 并写入磁盘（.deepcodex/tasks/<taskId>.json）
 * 2. 启动时从磁盘加载全部任务快照（用于崩溃恢复）
 * 3. 原子写入（先写临时文件，再 rename，防止写入中断导致数据损坏）
 * 4. 任务完成（终态）后自动删除持久化文件（避免磁盘堆积）
 *
 * 设计约束：
 * - 使用 Node.js 内置 fs 模块（不引入新依赖）
 * - 原子写入：write tmp file → fsync → rename（防止写入中断导致数据损坏）
 * - 错误处理：持久化失败不抛错，仅记录到 stderr（不影响主流程）
 * - 目录自动创建：首次 persist 时自动创建 .deepcodex/tasks/ 目录
 *
 * 与 BackgroundTaskRunner 的关系：
 * - BackgroundTaskRunner 通过 taskStore 可选注入 TaskStore 实例
 * - 每次任务状态变更时，BackgroundTaskRunner 调用 taskStore.persist(task)
 * - 任务进入终态后，BackgroundTaskRunner 调用 taskStore.remove(taskId) 删除持久化文件
 *
 * @module interrupts/task-store
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { BackgroundTask } from "./background-task";
import type { TaskSnapshot } from "./types";
import { TERMINAL_STATUSES } from "./types";

// ============================================================================
// 1. TaskStoreOptions 构造选项
// ============================================================================

/**
 * TaskStore 构造选项
 *
 * 字段说明：
 * - `projectRoot`：项目根目录（用于定位 .deepcodex/tasks/ 目录）
 * - `tasksDir`：自定义任务目录（可选，用于测试，默认 <projectRoot>/.deepcodex/tasks）
 *
 * 设计约束：
 * - projectRoot 必须是绝对路径（内部 path.resolve 处理）
 * - tasksDir 优先级高于 projectRoot（测试用）
 */
export interface TaskStoreOptions {
  /** 项目根目录（绝对或相对路径，内部 path.resolve 处理） */
  readonly projectRoot: string;
  /** 自定义任务目录（可选，用于测试，默认 <projectRoot>/.deepcodex/tasks） */
  readonly tasksDir?: string;
}

// ============================================================================
// 2. TaskStore 类实现
// ============================================================================

/**
 * 任务持久化存储
 *
 * 将 BackgroundTask 序列化为 TaskSnapshot 并写入磁盘（.deepcodex/tasks/<taskId>.json）。
 * 启动时从磁盘加载全部任务快照（用于崩溃恢复）。
 *
 * 使用示例：
 * ```typescript
 * const store = new TaskStore({ projectRoot: "/path/to/project" });
 * await store.persist(task); // 写入 .deepcodex/tasks/<taskId>.json
 * const snapshots = await store.loadAll(); // 加载全部任务快照
 * await store.remove(taskId); // 删除持久化文件
 * ```
 */
export class TaskStore {
  /** 任务目录路径（.deepcodex/tasks/） */
  private readonly tasksDir: string;

  /** 目录是否已创建（避免重复 mkdir） */
  private dirCreated = false;

  /**
   * 构造 TaskStore
   *
   * @param options 构造选项
   */
  constructor(options: TaskStoreOptions) {
    // 计算任务目录路径
    if (options.tasksDir) {
      this.tasksDir = path.resolve(options.tasksDir);
    } else {
      const resolvedRoot = path.resolve(options.projectRoot);
      this.tasksDir = path.join(resolvedRoot, ".deepcodex", "tasks");
    }
  }

  // ============================================================================
  // 2.1 persist 持久化任务状态
  // ============================================================================

  /**
   * 持久化任务状态（原子写入）
   *
   * 流程：
   * 1. 调用 task.toSnapshot() 序列化为 TaskSnapshot
   * 2. 确保 .deepcodex/tasks/ 目录存在（首次调用时自动创建）
   * 3. 将 TaskSnapshot 序列化为 JSON 字符串
   * 4. 写入临时文件（<taskId>.tmp.json）
   * 5. fsync 临时文件（确保数据落盘）
   * 6. rename 临时文件为 <taskId>.json（原子操作）
   *
   * 错误处理：
   * - 持久化失败不抛错，仅记录到 stderr（不影响主流程）
   * - 目录创建失败、文件写入失败、rename 失败均被 catch 并记录
   *
   * @param task 待持久化的任务
   */
  async persist(task: BackgroundTask): Promise<void> {
    try {
      // 1. 序列化为 TaskSnapshot
      const snapshot = task.toSnapshot();
      // 2. 确保目录存在
      await this.ensureDir();
      // 3. 序列化为 JSON
      const json = JSON.stringify(snapshot, null, 2);
      // 4. 写入临时文件
      const tmpPath = path.join(this.tasksDir, `${task.id}.tmp.json`);
      await fs.promises.writeFile(tmpPath, json, "utf-8");
      // 5. fsync（确保数据落盘）
      const fd = await fs.promises.open(tmpPath, "r");
      await fd.sync();
      await fd.close();
      // 6. rename 为最终文件（原子操作）
      const finalPath = path.join(this.tasksDir, `${task.id}.json`);
      await fs.promises.rename(tmpPath, finalPath);
    } catch (err) {
      // 持久化失败不抛错，仅记录到 stderr
      console.error(
        `[TaskStore] persist 失败（task.id=${task.id}）：`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ============================================================================
  // 2.2 loadAll 加载全部任务快照
  // ============================================================================

  /**
   * 加载全部任务快照（启动时恢复用）
   *
   * 流程：
   * 1. 检查 .deepcodex/tasks/ 目录是否存在（不存在返回空数组）
   * 2. 读取目录下全部 .json 文件（排除 .tmp.json）
   * 3. 逐个读取并解析 JSON（解析失败的文件跳过并记录到 stderr）
   * 4. 返回 TaskSnapshot 数组（按文件修改时间升序排列）
   *
   * 错误处理：
   * - 目录不存在返回空数组（不抛错）
   * - 单个文件解析失败跳过该文件（不影响其他文件加载）
   * - 解析失败的错误记录到 stderr
   *
   * @returns 任务快照数组（按文件修改时间升序排列）
   */
  async loadAll(): Promise<readonly TaskSnapshot[]> {
    try {
      // 1. 检查目录是否存在
      try {
        await fs.promises.access(this.tasksDir);
      } catch {
        // 目录不存在返回空数组
        return [];
      }
      // 2. 读取目录下全部 .json 文件（排除 .tmp.json）
      const files = await fs.promises.readdir(this.tasksDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp.json"));
      // 3. 逐个读取并解析
      const snapshots: TaskSnapshot[] = [];
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(this.tasksDir, file);
          const content = await fs.promises.readFile(filePath, "utf-8");
          const snapshot = JSON.parse(content) as TaskSnapshot;
          // 校验 snapshot 必须字段（防止损坏文件）
          if (snapshot.id && snapshot.kind && snapshot.status && snapshot.prompt) {
            snapshots.push(snapshot);
          } else {
            console.error(`[TaskStore] loadAll 跳过损坏文件：${file}（缺少必须字段）`);
          }
        } catch (err) {
          console.error(
            `[TaskStore] loadAll 解析失败（跳过文件 ${file}）：`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }
      // 4. 按文件修改时间升序排列（最早创建的任务在前）
      // 注：此处简化处理，直接按文件名排序（taskId 含时间戳信息）
      snapshots.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      return snapshots;
    } catch (err) {
      // 加载失败返回空数组（不抛错）
      console.error(`[TaskStore] loadAll 失败：`, err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  // ============================================================================
  // 2.3 remove 删除持久化文件
  // ============================================================================

  /**
   * 删除持久化文件（任务进入终态后调用）
   *
   * 流程：
   * 1. 构造文件路径（.deepcodex/tasks/<taskId>.json）
   * 2. 删除文件（不存在则忽略）
   *
   * 错误处理：
   * - 删除失败不抛错，仅记录到 stderr
   * - 文件不存在不抛错（ENOENT 忽略）
   *
   * @param taskId 任务 ID
   */
  async remove(taskId: string): Promise<void> {
    try {
      const filePath = path.join(this.tasksDir, `${taskId}.json`);
      await fs.promises.unlink(filePath);
    } catch (err) {
      // 文件不存在不抛错（ENOENT 忽略）
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      // 其他错误记录到 stderr
      console.error(`[TaskStore] remove 失败（taskId=${taskId}）：`, err instanceof Error ? err.message : String(err));
    }
  }

  // ============================================================================
  // 2.4 内部辅助方法
  // ============================================================================

  /**
   * 确保任务目录存在（首次调用时自动创建）
   *
   * 使用 mkdir -p 递归创建目录（父目录不存在时一并创建）。
   * 目录已存在时不抛错（recursive: true）。
   */
  private async ensureDir(): Promise<void> {
    if (this.dirCreated) {
      return;
    }
    try {
      await fs.promises.mkdir(this.tasksDir, { recursive: true });
      this.dirCreated = true;
    } catch (err) {
      // 目录已存在不抛错（EEXIST 忽略）
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        this.dirCreated = true;
        return;
      }
      // 其他错误抛出（由 persist catch 块处理）
      throw err;
    }
  }
}
