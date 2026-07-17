/**
 * 上下文同步器（ContextSynchronizer）—— F-CTX-03
 *
 * 双层上下文同步器，负责 GlobalContext ↔ TaskContext 之间的信息流转。
 *
 * V2-P1 阶段实现范围（架构师审查简化建议）：
 * - 单向同步：仅实现 updateGlobalFromTask（任务 → 全局），updateTaskFromGlobal 为桩实现
 * - 无冲突检测：ConflictDetector 留 V2-P2，SyncResult.conflicts 始终为空数组
 * - 接入方式：作为 P0b TaskContextManager 的 ArchiveCallback 实现注入，零改动既有代码
 *
 * 同步语义（updateGlobalFromTask）：
 * 1. 任务状态为 "completed" → 提取成功经验（SuccessExperience）
 *    - description: taskDefinition.description
 *    - solution: workingMemory.intermediateResults 最后一条的 result（无则为空串）
 *    - taskType: taskDefinition.taskType
 *    - tags: focusPoints 中 type="concept" 的 ref + type="file" 的文件名（去扩展名）
 *    - importance: 默认 5（中等，V2-P2 由 LLM 评估）
 * 2. 任务状态为 "failed" → 提取失败经验（FailureExperience）
 *    - failureReason: workingMemory.thoughtHistory 最后一条 thought（无则为空串）
 *    - lessonLearned: 从 thoughtHistory 倒序查找含 "失败"/"错误"/"教训"/"修正" 关键字的条目，
 *      命中则取其 thought，否则取最后一条 thought
 * 3. 任务状态为 "cancelled" → 不提取经验（用户主动取消，无经验价值）
 * 4. 任务状态为 "pending"/"in_progress" → 不提取经验（仅终态归档）
 * 5. focusPoints 中 type="concept" 的条目 → DomainKnowledge.conceptLibrary（按 name 去重）
 *
 * 持久化策略：
 * - updateGlobalFromTask 内部通过 GlobalContextManager.addSuccessExperience /
 *   addFailureExperience / update 方法持久化（复用 LRU 淘汰 + 原子写入）
 * - sync 方法不再单独调用 save（已由 add* 方法 save）
 * - updateGlobalFromTask 返回 globalStore.load(userId) 的最新状态
 *
 * 设计依据：
 * - V2 技术方案 §5.3 ContextSynchronizer 接口契约
 * - V2_P1_IMPLEMENTATION_PLAN.md §3.3（P1 裁剪：单向 + ArchiveCallback 接入）
 * - V2 技术方案 §14.5 V2-P1 功能项 F-CTX-03（单向：任务→全局）
 * - 架构师审查报告（2026-07-17）：单向 sync，updateTaskFromGlobal 桩
 *
 * @module v2/context/synchronizer
 */

import * as crypto from "node:crypto";
import type {
  GlobalContext,
  GlobalContextManager,
  SuccessExperience,
  FailureExperience,
  ConceptEntry,
} from "./global-context";
import type { TaskContext, TaskArchiveSummary, ArchiveCallback, FocusPoint, ThoughtEntry } from "./types";

// ============================================================================
// 类型定义（与 V2 技术方案 §5.3 完全对齐）
// ============================================================================

/**
 * 上下文冲突描述
 *
 * V2-P1 阶段不实现冲突检测（ConflictDetector 留 V2-P2），
 * SyncResult.conflicts 始终为空数组。
 */
export interface ContextConflict {
  /** 冲突类型：偏好/约束/资源 */
  type: "preference_conflict" | "constraint_conflict" | "resource_conflict";
  /** 冲突描述（自然语言） */
  description: string;
  /** 全局上下文中的值 */
  globalValue: string;
  /** 任务上下文中的值 */
  taskValue: string;
  /** 解决策略：全局优先/任务优先/人工裁决 */
  resolution: "global_wins" | "task_wins" | "manual";
}

/**
 * 同步结果
 *
 * V2-P1 阶段：
 * - conflicts 始终为空（无冲突检测）
 * - globalUpdates 包含本次任务→全局的更新描述（审计用，中文）
 * - taskUpdates 始终为空（updateTaskFromGlobal 桩）
 */
export interface SyncResult {
  /** 检测到的冲突列表（V2-P1 始终为空） */
  conflicts: ContextConflict[];
  /** 从任务同步到全局的更新描述列表 */
  globalUpdates: string[];
  /** 从全局同步到任务的更新描述列表（V2-P1 始终为空） */
  taskUpdates: string[];
  /** 同步完成时间（ISO 8601 字符串，UTC） */
  syncedAt: string;
}

// ============================================================================
// 常量定义
// ============================================================================

/** 默认经验重要性（1-10，5 为中等；V2-P2 由 LLM 评估） */
const DEFAULT_EXPERIENCE_IMPORTANCE = 5;

/** 失败经验教训关键字（用于从 thoughtHistory 倒序查找含教训的条目） */
const LESSON_KEYWORDS = ["失败", "错误", "教训", "修正", "bug", "fix", "error", "mistake"];

// ============================================================================
// ContextSynchronizer 类
// ============================================================================

/**
 * 上下文同步器
 *
 * 参考 WoAgent ContextSynchronizer.java。
 * V2-P1 阶段仅实现单向同步（任务 → 全局），
 * 双向同步与冲突检测留 V2-P2。
 *
 * 用法 1（§5.3 原始接口，sync/updateGlobalFromTask/updateTaskFromGlobal）：
 * ```typescript
 * const synchronizer = new ContextSynchronizer(globalManager);
 * const global = globalManager.load("default");
 * const result = await synchronizer.sync(global, taskContext);
 * console.log(result.globalUpdates);
 * ```
 *
 * 用法 2（P0b ArchiveCallback 接入）：
 * ```typescript
 * const synchronizer = new ContextSynchronizer(globalManager);
 * const taskManager = new TaskContextManager(synchronizer.asArchiveCallback("default"));
 * // 任务归档时自动触发同步
 * taskManager.archive("task-001", true);
 * ```
 */
export class ContextSynchronizer {
  /**
   * @param globalStore GlobalContext 管理器（依赖注入，负责持久化与 LRU 淘汰）
   */
  constructor(private readonly globalStore: GlobalContextManager) {}

  /**
   * 同步全局与任务上下文
   *
   * V2-P1 阶段行为：
   * 1. 调用 doUpdateGlobalFromTask 执行任务→全局同步（含持久化），收集更新描述
   * 2. 调用 updateTaskFromGlobal（桩，不修改任务）
   * 3. 返回 SyncResult（conflicts 空、taskUpdates 空、globalUpdates 含本次更新描述）
   *
   * @param globalContext 当前全局上下文（userId 从中获取）
   * @param taskContext 当前任务上下文
   * @returns 同步结果
   */
  async sync(globalContext: GlobalContext, taskContext: TaskContext): Promise<SyncResult> {
    // 任务 → 全局同步（含持久化），同时收集更新描述
    const { updates } = this.doUpdateGlobalFromTask(globalContext, taskContext);

    // 全局 → 任务同步（V2-P1 桩，不修改任务）
    await this.updateTaskFromGlobal(globalContext, taskContext);

    return {
      conflicts: [], // V2-P1 无冲突检测
      globalUpdates: updates,
      taskUpdates: [], // V2-P1 桩，无任务更新
      syncedAt: new Date().toISOString(),
    };
  }

  /**
   * 任务 → 全局更新（§5.3 契约方法）
   *
   * 同步规则：
   * - 任务状态 "completed" → 新增 SuccessExperience
   * - 任务状态 "failed" → 新增 FailureExperience
   * - 任务状态 "cancelled" / "pending" / "in_progress" → 不新增经验
   * - focusPoints 中 type="concept" 的条目 → conceptLibrary（按 name 去重）
   *
   * 持久化：通过 globalStore.addSuccessExperience / addFailureExperience / update 完成
   * （复用 LRU 淘汰 + 原子写入），方法内部已 save。
   *
   * @param global 当前全局上下文（仅读取 userId 字段）
   * @param task 当前任务上下文
   * @returns 更新后的全局上下文（从 globalStore 重新 load 的最新状态）
   */
  async updateGlobalFromTask(global: GlobalContext, task: TaskContext): Promise<GlobalContext> {
    this.doUpdateGlobalFromTask(global, task);
    // 重新 load 返回最新状态（add* 方法已 save，load 拿到最新版本号与时间戳）
    return this.globalStore.load(global.userId);
  }

  /**
   * 任务 → 全局更新的内部实现（返回更新描述列表，供 sync 与 updateGlobalFromTask 共用）
   *
   * @param global 当前全局上下文
   * @param task 当前任务上下文
   * @returns 更新后的全局上下文 + 更新描述列表
   */
  private doUpdateGlobalFromTask(
    global: GlobalContext,
    task: TaskContext
  ): { global: GlobalContext; updates: string[] } {
    const userId = global.userId;
    const updates: string[] = [];

    // ---------- 1. 经验提取（根据任务终态） ----------
    const status = task.taskState.status;
    if (status === "completed") {
      // 成功任务 → SuccessExperience
      const exp = this.buildSuccessExperience(task);
      this.globalStore.addSuccessExperience(userId, exp);
      updates.push(`新增成功经验（任务 ${task.taskId}）：${exp.description} → ${exp.solution}`);
    } else if (status === "failed") {
      // 失败任务 → FailureExperience
      const exp = this.buildFailureExperience(task);
      this.globalStore.addFailureExperience(userId, exp);
      updates.push(`新增失败经验（任务 ${task.taskId}）：${exp.description} → 教训：${exp.lessonLearned}`);
    }
    // cancelled / pending / in_progress 不提取经验

    // ---------- 2. 概念提取（focusPoints 中 type="concept"） ----------
    const concepts = this.extractConcepts(task);
    if (concepts.length > 0) {
      this.globalStore.update(userId, (ctx) => {
        for (const concept of concepts) {
          // 按 name 去重：已存在则跳过
          const exists = ctx.domainKnowledge.conceptLibrary.some((c) => c.name === concept.name);
          if (!exists) {
            ctx.domainKnowledge.conceptLibrary.push(concept);
            updates.push(`新增概念：${concept.name}（来源：任务 ${task.taskId}）`);
          }
        }
        return ctx;
      });
    }

    return { global, updates };
  }

  /**
   * 全局 → 任务更新（V2-P1 桩实现）
   *
   * V2-P1 阶段不实现全局→任务方向的同步：
   * - 用户偏好注入 WorkingMemory（V2-P2）
   * - 相关经验注入 WorkingMemory.focusPoints（V2-P2）
   *
   * 桩行为：直接返回原 taskContext，不修改。
   *
   * @param global 当前全局上下文（V2-P1 未使用）
   * @param task 当前任务上下文
   * @returns 原任务上下文（未修改）
   */
  async updateTaskFromGlobal(global: GlobalContext, task: TaskContext): Promise<TaskContext> {
    // V2-P1 桩实现：直接返回原 task，不修改
    // V2-P2 将实现：用户偏好注入 + 相关经验注入
    return task;
  }

  /**
   * 生成符合 P0b ArchiveCallback 签名的回调
   *
   * 接入方式：注入 TaskContextManager 构造函数，任务归档时自动触发同步。
   *
   * 与 sync 方法的区别：
   * - sync 接收 TaskContext，用于会话内实时同步
   * - asArchiveCallback 接收 TaskArchiveSummary，用于任务归档时同步
   * - 两者共用同一套经验提取逻辑（buildSuccessExperience / buildFailureExperience）
   *
   * @param userId 用户 ID
   * @returns ArchiveCallback 函数（接收 TaskArchiveSummary，void 返回）
   */
  asArchiveCallback(userId: string): ArchiveCallback {
    return (summary: TaskArchiveSummary) => {
      if (summary.success) {
        // 成功归档 → SuccessExperience
        const exp = this.buildSuccessExperienceFromArchive(summary);
        this.globalStore.addSuccessExperience(userId, exp);
      } else {
        // 失败归档 → FailureExperience
        const exp = this.buildFailureExperienceFromArchive(summary);
        this.globalStore.addFailureExperience(userId, exp);
      }
    };
  }

  // ========================================================================
  // 私有辅助方法
  // ========================================================================

  /**
   * 从 TaskContext 构建成功经验
   *
   * @param task 任务上下文（status 应为 "completed"）
   * @returns 填充完整的 SuccessExperience
   */
  private buildSuccessExperience(task: TaskContext): SuccessExperience {
    const now = new Date().toISOString();
    const intermediateResults = task.workingMemory.intermediateResults;
    // solution 取最后一条中间结果（最近的阶段性成果）
    const solution = intermediateResults.length > 0 ? intermediateResults[intermediateResults.length - 1].result : "";

    return {
      id: crypto.randomUUID(),
      taskType: task.taskDefinition.taskType,
      description: task.taskDefinition.description,
      solution,
      tags: this.extractTags(task.workingMemory.focusPoints),
      importance: DEFAULT_EXPERIENCE_IMPORTANCE,
      createdAt: now,
      accessCount: 0,
      lastAccessedAt: now,
    };
  }

  /**
   * 从 TaskContext 构建失败经验
   *
   * @param task 任务上下文（status 应为 "failed"）
   * @returns 填充完整的 FailureExperience
   */
  private buildFailureExperience(task: TaskContext): FailureExperience {
    const now = new Date().toISOString();
    const thoughts = task.workingMemory.thoughtHistory;
    // failureReason 取最后一条思考（最接近失败时刻的推理）
    const failureReason = thoughts.length > 0 ? thoughts[thoughts.length - 1].thought : "";
    // lessonLearned 倒序查找含教训关键字的条目
    const lessonLearned = this.extractLesson(thoughts);

    return {
      id: crypto.randomUUID(),
      taskType: task.taskDefinition.taskType,
      description: task.taskDefinition.description,
      failureReason,
      lessonLearned,
      tags: this.extractTags(task.workingMemory.focusPoints),
      importance: DEFAULT_EXPERIENCE_IMPORTANCE,
      createdAt: now,
      accessCount: 0,
      lastAccessedAt: now,
    };
  }

  /**
   * 从 TaskArchiveSummary 构建成功经验（归档回调用）
   *
   * @param summary 任务归档摘要
   * @returns 填充完整的 SuccessExperience
   */
  private buildSuccessExperienceFromArchive(summary: TaskArchiveSummary): SuccessExperience {
    // solution 取最后一条中间结果
    const intermediateResults = summary.intermediateResults;
    const solution = intermediateResults.length > 0 ? intermediateResults[intermediateResults.length - 1].result : "";

    return {
      id: crypto.randomUUID(),
      taskType: summary.taskDefinition.taskType,
      description: summary.taskDefinition.description,
      solution,
      tags: this.extractTags(summary.focusPoints),
      importance: DEFAULT_EXPERIENCE_IMPORTANCE,
      createdAt: summary.archivedAt,
      accessCount: 0,
      lastAccessedAt: summary.archivedAt,
    };
  }

  /**
   * 从 TaskArchiveSummary 构建失败经验（归档回调用）
   *
   * @param summary 任务归档摘要
   * @returns 填充完整的 FailureExperience
   */
  private buildFailureExperienceFromArchive(summary: TaskArchiveSummary): FailureExperience {
    const thoughts = summary.thoughtHistory;
    const failureReason = thoughts.length > 0 ? thoughts[thoughts.length - 1].thought : "";
    const lessonLearned = this.extractLesson(thoughts);

    return {
      id: crypto.randomUUID(),
      taskType: summary.taskDefinition.taskType,
      description: summary.taskDefinition.description,
      failureReason,
      lessonLearned,
      tags: this.extractTags(summary.focusPoints),
      importance: DEFAULT_EXPERIENCE_IMPORTANCE,
      createdAt: summary.archivedAt,
      accessCount: 0,
      lastAccessedAt: summary.archivedAt,
    };
  }

  /**
   * 从 focusPoints 提取标签
   *
   * 规则：
   * - type="concept" 的 ref 直接作为标签
   * - type="file" 的 ref 取文件名（去除目录前缀和扩展名）
   * - type="function"/"task" 的 ref 直接作为标签
   * - 去重
   *
   * @param focusPoints 关注点列表
   * @returns 标签数组（已去重）
   */
  private extractTags(focusPoints: FocusPoint[]): string[] {
    const tags = new Set<string>();
    for (const fp of focusPoints) {
      if (fp.type === "file") {
        // 文件关注点：取文件名（去扩展名）作为标签
        const basename = fp.ref.split("/").pop() ?? fp.ref;
        const nameWithoutExt = basename.replace(/\.[^.]+$/, "");
        if (nameWithoutExt) tags.add(nameWithoutExt);
      } else {
        // 其他类型：ref 直接作为标签
        if (fp.ref) tags.add(fp.ref);
      }
    }
    return Array.from(tags);
  }

  /**
   * 从思考历史倒序提取教训
   *
   * 规则：倒序遍历 thoughtHistory，查找 thought 内容含 LESSON_KEYWORDS 任一关键字的条目，
   * 命中则返回其 thought；全部未命中则返回最后一条 thought（无则空串）。
   *
   * @param thoughts 思考历史列表
   * @returns 教训描述
   */
  private extractLesson(thoughts: ThoughtEntry[]): string {
    if (thoughts.length === 0) return "";

    // 倒序查找含教训关键字的条目
    for (let i = thoughts.length - 1; i >= 0; i--) {
      const thought = thoughts[i].thought.toLowerCase();
      for (const keyword of LESSON_KEYWORDS) {
        if (thought.includes(keyword.toLowerCase())) {
          return thoughts[i].thought;
        }
      }
    }

    // 全部未命中：返回最后一条 thought
    return thoughts[thoughts.length - 1].thought;
  }

  /**
   * 从 TaskContext 提取概念（type="concept" 的 focusPoint）
   *
   * 规则：
   * - focusPoints 中 type="concept" 的 ref 作为概念 name
   * - description 默认为空串（V2-P2 由 LLM 补全）
   * - relatedConcepts 默认为空数组
   * - id 由 crypto.randomUUID 生成
   *
   * @param task 任务上下文
   * @returns 概念条目列表
   */
  private extractConcepts(task: TaskContext): ConceptEntry[] {
    const concepts: ConceptEntry[] = [];
    for (const fp of task.workingMemory.focusPoints) {
      if (fp.type === "concept" && fp.ref) {
        concepts.push({
          id: crypto.randomUUID(),
          name: fp.ref,
          description: "",
          relatedConcepts: [],
        });
      }
    }
    return concepts;
  }
}
