/**
 * TaskContextManager 任务上下文管理器（F-CTX-02）
 *
 * 管理单个任务生命周期的 TaskContext，包括任务创建、状态转换、
 * 工作记忆操作和任务归档。每个任务拥有独立的 TaskContext 实例，
 * 任务间严格隔离（MEM-08 验收）。
 *
 * V2-P0b 范围（§11.1）：仅 WorkingMemory + TaskState（精简版）。
 * - 不包含 GlobalContext 管理（V2-P1 的 DualLayerContextManager）
 * - 不包含 ContextSynchronizer 双向同步（V2-P1）
 * - 不包含 SlidingWindowManager 滑动窗口（V2-P1）
 * - 归档通过可插拔 ArchiveCallback 实现（V2-P2 接入 ExperienceStore）
 *
 * 数据存储：V2-P0b 阶段使用内存 Map<taskId, TaskContext>，
 * 进程结束即销毁。V2-P1 阶段可扩展为 TaskContextStore 持久化。
 *
 * 线程安全：Node.js 单线程模型下无需加锁。
 * 但为防止异步操作中的竞态（如 archive 进行中另一处调用 clear），
 * 关键操作检查任务是否存在并返回明确的错误。
 *
 * 设计依据：
 * - V2 技术方案 §5.1 数据模型
 * - V2 技术方案 §8.3 WorkingMemoryManager 接口
 * - V2 PRD §US-CTX-002：TaskContext 任务上下文
 * - V2 测试方案 §2.9 MEM-08（任务隔离）/ MEM-09（归档）
 *
 * @module v2/context/task-context-manager
 */

import type {
  TaskContext,
  TaskDefinition,
  TaskStatus,
  WorkingMemory,
  FocusPoint,
  ThoughtEntry,
  IntermediateResult,
  PendingItem,
  TaskArchiveSummary,
  ArchiveCallback,
} from "./types";

/**
 * 任务上下文管理器
 *
 * 管理多个并行任务的 TaskContext，提供任务的 CRUD、状态转换、
 * 工作记忆操作和归档功能。是 V2 上下文记忆系统的任务层入口。
 *
 * 用法：
 * ```typescript
 * const manager = new TaskContextManager();
 *
 * // 创建任务
 * const ctx = manager.create("task-001", {
 *   description: "修复登录 bug",
 *   goals: ["用户可以正常登录"],
 *   constraints: ["不改动数据库结构"],
 *   taskType: "bugfix",
 *   expectedOutput: "修复后的代码 + 测试",
 * });
 *
 * // 更新状态
 * manager.updateState("task-001", "in_progress", 30, "分析中");
 *
 * // 添加工作记忆
 * manager.addFocusPoint("task-001", { type: "file", ref: "src/auth.ts", priority: 0.9, addedAt: new Date().toISOString() });
 * manager.addThought("task-001", "发现密码比对逻辑错误", "分析中");
 *
 * // 完成并归档
 * manager.updateState("task-001", "completed", 100, "完成");
 * manager.archive("task-001", true);
 * ```
 */
export class TaskContextManager {
  /** 任务上下文存储（taskId → TaskContext），内存存储，进程结束即销毁 */
  private readonly contexts: Map<string, TaskContext> = new Map();

  /** 归档回调函数（可选，V2-P0b 默认为 no-op，V2-P1/P2 接入 ExperienceStore） */
  private readonly archiveCallback: ArchiveCallback | null;

  /**
   * 构造任务上下文管理器
   *
   * @param archiveCallback 归档回调函数（可选）。任务归档时调用，
   *                        V2-P0b 默认不提供（归档仅产生摘要但不持久化），
   *                        V2-P1/P2 由 ExperienceStore 提供回调以持久化经验。
   */
  constructor(archiveCallback?: ArchiveCallback) {
    this.archiveCallback = archiveCallback ?? null;
  }

  /**
   * 创建新的任务上下文
   *
   * 初始化 TaskContext，包含空的 WorkingMemory 和 pending 状态的 TaskState。
   * 任务 ID 必须唯一，重复创建会抛出错误。
   *
   * @param taskId 任务 ID（唯一标识，由调用方提供）
   * @param taskDefinition 任务定义（描述、目标、约束、类型、预期输出）
   * @returns 新创建的 TaskContext
   * @throws {Error} 任务 ID 已存在时抛出
   */
  create(taskId: string, taskDefinition: TaskDefinition): TaskContext {
    // 检查任务 ID 是否已存在（防止覆盖已有任务上下文）
    if (this.contexts.has(taskId)) {
      throw new Error(`任务 ID 已存在: ${taskId}（TaskContextManager.create 拒绝覆盖已有任务）`);
    }

    const now = new Date().toISOString();
    const context: TaskContext = {
      taskId,
      taskDefinition,
      taskState: {
        status: "pending",
        progress: 0,
        startedAt: now,
        currentStage: "初始化",
      },
      workingMemory: this.createEmptyWorkingMemory(),
      skillContext: {
        activeSkills: [],
        loadedHistory: [],
      },
      version: 1,
    };

    this.contexts.set(taskId, context);
    return context;
  }

  /**
   * 获取任务上下文
   *
   * @param taskId 任务 ID
   * @returns 任务上下文（不存在时返回 null）
   */
  get(taskId: string): TaskContext | null {
    return this.contexts.get(taskId) ?? null;
  }

  /**
   * 列出所有任务上下文
   *
   * @returns 所有任务上下文的数组（按创建顺序，Map 保持插入序）
   */
  list(): TaskContext[] {
    return Array.from(this.contexts.values());
  }

  /**
   * 更新任务状态
   *
   * 状态流转规则（单向不可逆）：
   * - pending → in_progress（开始执行）
   * - in_progress → completed / failed / cancelled（终态）
   * - 终态不可再次转换
   *
   * 更新状态时会同步更新 progress、currentStage 和时间戳，
   * 并递增 version（乐观并发控制）。
   *
   * @param taskId 任务 ID
   * @param status 新状态
   * @param progress 进度百分比（0-100，可选）
   * @param currentStage 当前阶段名称（可选）
   * @throws {Error} 任务不存在或状态转换非法时抛出
   */
  updateState(taskId: string, status: TaskStatus, progress?: number, currentStage?: string): void {
    const ctx = this.contexts.get(taskId);
    if (!ctx) {
      throw new Error(`任务不存在: ${taskId}（TaskContextManager.updateState 无法更新）`);
    }

    // 校验状态转换合法性（防止非法跃迁）
    this.validateStateTransition(ctx.taskState.status, status);

    // 校验进度值合法性（在修改任何状态字段之前完成所有参数校验，
    // 确保校验失败时不会产生部分更新的中间状态）
    if (progress !== undefined && (progress < 0 || progress > 100)) {
      throw new Error(`进度值非法: ${progress}（应在 0-100 范围内）`);
    }

    // 所有参数校验通过，开始原子性更新状态
    ctx.taskState.status = status;

    // 更新进度（若提供，此时已校验通过）
    if (progress !== undefined) {
      ctx.taskState.progress = progress;
    }

    // 更新阶段名称（若提供）
    if (currentStage !== undefined) {
      ctx.taskState.currentStage = currentStage;
    }

    // 终态时记录完成时间
    if (status === "completed" || status === "failed" || status === "cancelled") {
      ctx.taskState.completedAt = new Date().toISOString();
      // 终态时进度强制设为 100（completed）或保持当前值（failed/cancelled）
      if (status === "completed") {
        ctx.taskState.progress = 100;
      }
    }

    // 递增版本号（乐观并发控制）
    ctx.version += 1;
  }

  /**
   * 添加关注点到工作记忆
   *
   * @param taskId 任务 ID
   * @param point 关注点（文件/函数/概念/任务）
   * @throws {Error} 任务不存在时抛出
   */
  addFocusPoint(taskId: string, point: FocusPoint): void {
    const ctx = this.getWritableContext(taskId, "addFocusPoint");
    ctx.workingMemory.focusPoints.push(point);
    ctx.version += 1;
  }

  /**
   * 添加思考记录到工作记忆
   *
   * @param taskId 任务 ID
   * @param thought 思考内容
   * @param stage 当前阶段名称
   * @throws {Error} 任务不存在时抛出
   */
  addThought(taskId: string, thought: string, stage: string): void {
    const ctx = this.getWritableContext(taskId, "addThought");
    const entry: ThoughtEntry = {
      timestamp: new Date().toISOString(),
      thought,
      stage,
    };
    ctx.workingMemory.thoughtHistory.push(entry);
    ctx.version += 1;
  }

  /**
   * 添加中间结果到工作记忆
   *
   * @param taskId 任务 ID
   * @param result 结果内容
   * @param source 来源（工具名或 Agent 名）
   * @throws {Error} 任务不存在时抛出
   */
  addIntermediateResult(taskId: string, result: string, source: string): void {
    const ctx = this.getWritableContext(taskId, "addIntermediateResult");
    const entry: IntermediateResult = {
      timestamp: new Date().toISOString(),
      result,
      source,
    };
    ctx.workingMemory.intermediateResults.push(entry);
    ctx.version += 1;
  }

  /**
   * 添加待办事项到工作记忆
   *
   * @param taskId 任务 ID
   * @param item 待办事项
   * @throws {Error} 任务不存在时抛出
   */
  addPendingItem(taskId: string, item: PendingItem): void {
    const ctx = this.getWritableContext(taskId, "addPendingItem");
    ctx.workingMemory.pendingItems.push(item);
    ctx.version += 1;
  }

  /**
   * 更新待办事项状态
   *
   * @param taskId 任务 ID
   * @param itemId 待办事项 ID
   * @param status 新状态
   * @throws {Error} 任务或待办事项不存在时抛出
   */
  updatePendingItemStatus(taskId: string, itemId: string, status: PendingItem["status"]): void {
    const ctx = this.getWritableContext(taskId, "updatePendingItemStatus");
    const item = ctx.workingMemory.pendingItems.find((i) => i.id === itemId);
    if (!item) {
      throw new Error(`待办事项不存在: ${itemId}（任务 ${taskId}）`);
    }
    item.status = status;
    ctx.version += 1;
  }

  /**
   * 设置临时数据键值对
   *
   * @param taskId 任务 ID
   * @param key 数据键
   * @param value 数据值
   * @throws {Error} 任务不存在时抛出
   */
  setTemporaryData(taskId: string, key: string, value: unknown): void {
    const ctx = this.getWritableContext(taskId, "setTemporaryData");
    ctx.workingMemory.temporaryData[key] = value;
    ctx.version += 1;
  }

  /**
   * 更新上下文窗口（当前激活的文件/片段路径列表）
   *
   * V2-P0b 阶段仅存储路径列表，V2-P1 由 SlidingWindowManager 消费做相关性筛选。
   *
   * @param taskId 任务 ID
   * @param window 上下文窗口路径列表
   * @throws {Error} 任务不存在时抛出
   */
  updateContextWindow(taskId: string, window: string[]): void {
    const ctx = this.getWritableContext(taskId, "updateContextWindow");
    ctx.workingMemory.contextWindow = [...window];
    ctx.version += 1;
  }

  /**
   * 激活技能
   *
   * 将技能添加到 activeSkills 列表，并记录加载历史。
   *
   * @param taskId 任务 ID
   * @param skillId 技能 ID 或名称
   * @param version 技能版本
   * @throws {Error} 任务不存在时抛出
   */
  activateSkill(taskId: string, skillId: string, version: string): void {
    const ctx = this.getWritableContext(taskId, "activateSkill");

    // 避免重复激活同一技能
    if (!ctx.skillContext.activeSkills.includes(skillId)) {
      ctx.skillContext.activeSkills.push(skillId);
    }

    // 记录加载历史
    ctx.skillContext.loadedHistory.push({
      skillId,
      loadedAt: new Date().toISOString(),
      version,
    });

    ctx.version += 1;
  }

  /**
   * 清空工作记忆（保留任务定义和状态）
   *
   * 用于任务执行中需要重置工作记忆的场景（如切换子任务）。
   *
   * @param taskId 任务 ID
   * @throws {Error} 任务不存在时抛出
   */
  clear(taskId: string): void {
    const ctx = this.getWritableContext(taskId, "clear");
    ctx.workingMemory = this.createEmptyWorkingMemory();
    ctx.version += 1;
  }

  /**
   * 归档任务：生成归档摘要并调用回调，然后删除任务上下文
   *
   * 归档流程（MEM-09 验收）：
   * 1. 检查任务存在且处于终态（completed/failed/cancelled）
   * 2. 构建 TaskArchiveSummary（包含思考历史、中间结果、关注点等摘要）
   * 3. 调用 archiveCallback（若提供）将摘要传递给消费方
   * 4. 从内存中删除任务上下文（释放资源）
   *
   * V2-P0b 阶段：若未提供 archiveCallback，归档仅生成摘要并删除上下文。
   * V2-P1/P2 阶段：ExperienceStore 提供 archiveCallback，将摘要持久化为经验。
   *
   * @param taskId 任务 ID
   * @param success 任务是否成功完成（影响归档为成功经验还是失败经验）
   * @returns 归档摘要（无论是否有回调消费，都返回摘要供调用方使用）
   * @throws {Error} 任务不存在或未处于终态时抛出
   */
  archive(taskId: string, success: boolean): TaskArchiveSummary {
    const ctx = this.contexts.get(taskId);
    if (!ctx) {
      throw new Error(`任务不存在: ${taskId}（TaskContextManager.archive 无法归档）`);
    }

    // 校验任务已处于终态（只有终态任务才能归档）
    const terminalStatuses: TaskStatus[] = ["completed", "failed", "cancelled"];
    if (!terminalStatuses.includes(ctx.taskState.status)) {
      throw new Error(
        `任务未处于终态，无法归档: ${taskId}（当前状态: ${ctx.taskState.status}，需为 completed/failed/cancelled）`
      );
    }

    // 构建归档摘要
    const summary: TaskArchiveSummary = {
      taskId: ctx.taskId,
      success,
      taskDefinition: ctx.taskDefinition,
      thoughtHistory: [...ctx.workingMemory.thoughtHistory],
      intermediateResults: [...ctx.workingMemory.intermediateResults],
      focusPoints: [...ctx.workingMemory.focusPoints],
      startedAt: ctx.taskState.startedAt,
      completedAt: ctx.taskState.completedAt ?? new Date().toISOString(),
      archivedAt: new Date().toISOString(),
    };

    // 调用归档回调（若提供）
    // V2-P0b 默认无回调，摘要仅返回给调用方；
    // V2-P1/P2 ExperienceStore 提供回调时，摘要被持久化为经验
    if (this.archiveCallback) {
      this.archiveCallback(summary);
    }

    // 从内存中删除任务上下文（释放资源，防止内存泄漏）
    this.contexts.delete(taskId);

    return summary;
  }

  /**
   * 删除任务上下文（不归档，直接删除）
   *
   * 用于任务异常或调试场景的强制清理。
   * 正常流程应使用 archive() 进行归档后自动删除。
   *
   * @param taskId 任务 ID
   * @returns 是否删除成功（任务不存在时返回 false）
   */
  delete(taskId: string): boolean {
    return this.contexts.delete(taskId);
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 创建空的 WorkingMemory 实例
   *
   * 所有集合字段初始化为空数组/空对象，避免 undefined 访问。
   *
   * @returns 空 WorkingMemory
   */
  private createEmptyWorkingMemory(): WorkingMemory {
    return {
      focusPoints: [],
      temporaryData: {},
      pendingItems: [],
      thoughtHistory: [],
      intermediateResults: [],
      contextWindow: [],
    };
  }

  /**
   * 校验状态转换合法性
   *
   * 合法转换：
   * - pending → in_progress / completed / failed / cancelled
   * - in_progress → completed / failed / cancelled
   * - 终态（completed/failed/cancelled）不可再转换
   *
   * @param from 当前状态
   * @param to 目标状态
   * @throws {Error} 非法状态转换时抛出
   */
  private validateStateTransition(from: TaskStatus, to: TaskStatus): void {
    // 相同状态无需转换
    if (from === to) {
      return;
    }

    // 终态不可转换（已完成/失败/取消的任务不能再次变更状态）
    const terminalStatuses: TaskStatus[] = ["completed", "failed", "cancelled"];
    if (terminalStatuses.includes(from)) {
      throw new Error(`非法状态转换: ${from} → ${to}（终态任务不可变更状态）`);
    }

    // pending → in_progress / completed / failed / cancelled（全部合法）
    if (from === "pending") {
      return;
    }

    // in_progress → completed / failed / cancelled（全部合法）
    if (from === "in_progress") {
      return;
    }

    // 理论上不会到达此处（所有合法路径已覆盖）
    throw new Error(`非法状态转换: ${from} → ${to}`);
  }

  /**
   * 获取可写任务上下文（存在且未归档）
   *
   * 工作记忆操作（addFocusPoint 等）的公共前置检查：
   * 1. 任务必须存在
   * 2. 返回的上下文可直接修改（Map 中存储的是引用，修改即生效）
   *
   * @param taskId 任务 ID
   * @param operation 操作名称（用于错误信息）
   * @returns 可写的 TaskContext
   * @throws {Error} 任务不存在时抛出
   */
  private getWritableContext(taskId: string, operation: string): TaskContext {
    const ctx = this.contexts.get(taskId);
    if (!ctx) {
      throw new Error(`任务不存在: ${taskId}（操作 ${operation} 无法执行）`);
    }
    return ctx;
  }
}
