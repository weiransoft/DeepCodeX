/**
 * FileHistoryCoordinator 文件历史协调器 —— 从 session.ts 抽取的 undo/file-history 域逻辑
 *
 * 职责（S4 首阶段拆分，迁移自 SessionManager 的 11 个私有方法）：
 * - checkpoint 仓库定位：解析 <projectDir>/file-history/.git 路径并构造 GitFileHistory
 * - 会话分支生命周期：ensureFileHistorySession（首次 lazy init 空仓库 + 分支）
 * - 用户提示检查点：recordUserPromptCheckpoint（跟踪文件快照，供回滚/差异提示）
 * - 文件变更检查点：prepareFileMutationCheckpoint（工具改写文件前）/
 *   recordFileMutationCheckpoint（改写后）
 * - hash 回写链路：updateLatestUserCheckpointHash（把 checkpoint hash 写回最近一条
 *   可撤销用户消息并经 saveSessionMessages 持久化——undo 语义的数据源）
 * - 恢复能力：canRestoreCheckpointHash / restoreCheckpointHash
 * - undo 目标谓词：isUndoTargetMessage（user + visible + 未压缩）
 *
 * 抽取模式（供第二阶段 EAG 宿主拆分与 SessionManager 其余域复用）：
 * - 最小 Context 回调注入（对齐 skill-manager.ts 先例）：
 *   projectRoot / getProjectStorage / listSessionMessages / saveSessionMessages
 * - 引用 session.ts 类型一律 import type（编译期擦除，规避运行时循环依赖）
 * - SessionManager 保留公开组合层（listUndoTargets / restoreSessionConversation /
 *   restoreSessionCode），本协调器不触碰会话索引（updateSessionEntry 属会话语义）
 *
 * 修订记录：
 * - 2026-08-19：从 session.ts 抽取（11 个方法，约 125 行）
 *   方案出处：docs/optimization-plan-20260819.md §5（S4）
 */

import * as path from "path";
import { GitFileHistory, type FileHistoryCheckpointResult } from "./common/file-history";
// type-only import 不会产生运行时循环依赖（TypeScript 编译时擦除）
import type { SessionMessage } from "./session";

/**
 * FileHistoryCoordinator 依赖上下文
 *
 * 设计说明（对齐 SkillManagerContext 的回调注入模式）：
 * - projectRoot: 项目根目录，透传给 GitFileHistory（工作区路径语义）
 * - getProjectStorage: 会话存储根路径（projectDir）获取函数，
 *   file-history git 目录 = <projectDir>/file-history/.git。
 *   注意：其实现依赖 os.homedir()，测试必须经 HOME 隔离（fixtures/session-test-env）
 * - listSessionMessages / saveSessionMessages: 消息读取与持久化回调，
 *   updateLatestUserCheckpointHash 的 hash 回写依赖（不注入则回写链路不可用）
 *
 * 这四个依赖是本协调器运行所需的最小集合，
 * 避免直接依赖 SessionManager 实例（降低耦合度）。
 */
export interface FileHistoryCoordinatorContext {
  /** 项目根目录（GitFileHistory 工作区路径） */
  projectRoot: string;
  /** 会话存储根路径（projectDir）获取函数 */
  getProjectStorage: () => string;
  /** 会话消息列表读取函数（hash 回写链路依赖） */
  listSessionMessages: (sessionId: string) => SessionMessage[];
  /** 会话消息持久化函数（hash 回写链路依赖） */
  saveSessionMessages: (sessionId: string, messages: SessionMessage[]) => void;
}

/**
 * FileHistoryCoordinator —— undo/file-history 域协调器
 *
 * 封装 checkpoint 的记录、回写、校验与恢复；不涉及会话索引更新与
 * LLM 调用（这两部分逻辑保留在 SessionManager 组合层）。
 *
 * 使用方式：
 * ```typescript
 * const coordinator = new FileHistoryCoordinator({
 *   projectRoot: "/path/to/project",
 *   getProjectStorage: () => sessionManager.getProjectStorage().projectDir,
 *   listSessionMessages: (id) => sessionManager.listSessionMessages(id),
 *   saveSessionMessages: (id, messages) => sessionManager.saveSessionMessages(id, messages),
 * });
 * coordinator.ensureFileHistorySession(sessionId);
 * ```
 */
export class FileHistoryCoordinator {
  constructor(private readonly context: FileHistoryCoordinatorContext) {}

  /**
   * 构造 GitFileHistory 实例（每次调用新建，无状态持有）
   *
   * GitFileHistory 构造仅记录 gitDir 路径（common/file-history.ts），
   * 仓库不存在时由 ensureSession 内部自动 git init。
   */
  private getFileHistory(): GitFileHistory {
    return new GitFileHistory(this.context.projectRoot, this.getFileHistoryGitDir());
  }

  /**
   * 解析 file-history 仓库的 .git 目录路径
   *
   * 路径规则：<projectDir>/file-history/.git
   * （projectDir 来自 Context.getProjectStorage，即 ~/.deepcode/projects/<projectCode>）
   */
  private getFileHistoryGitDir(): string {
    return path.join(this.context.getProjectStorage(), "file-history", ".git");
  }

  /**
   * 确保会话的 file-history 分支存在（幂等）
   *
   * 首次调用时 lazy init 空仓库并创建 Initial checkpoint 分支；
   * 已存在时返回当前分支 head。
   * git 不可用等异常场景返回 undefined（调用方按降级处理，不阻塞主流程）。
   */
  ensureFileHistorySession(sessionId: string): string | undefined {
    return this.getFileHistory().ensureSession(sessionId);
  }

  /**
   * 获取会话当前 checkpoint 分支 head（无分支/仓库时返回 undefined）
   */
  getCurrentCheckpointHash(sessionId: string): string | undefined {
    return this.getFileHistory().getCurrentCheckpointHash(sessionId);
  }

  /**
   * 记录用户提示检查点（跟踪文件快照）
   *
   * 用途：
   * 1. replySession 阶段检测用户手动编辑过的文件（changedFilePaths 非空时
   *    由 SessionManager 追加隐藏 system 提示）
   * 2. createSession 阶段建立基准快照
   */
  recordUserPromptCheckpoint(sessionId: string): FileHistoryCheckpointResult {
    return this.getFileHistory().recordTrackedFilesCheckpoint(sessionId, "User prompt checkpoint");
  }

  /**
   * 文件变更前置检查点（工具改写文件前调用，ToolExecutionHooks.onBeforeFileMutation）
   *
   * 流程：
   * 1. ensureSession 获取当前 head（previousHash）
   * 2. 先把 previousHash 回写到最近一条可撤销用户消息（保证该消息必有 hash 可恢复）
   * 3. 为目标文件创建 Pre-mutation checkpoint
   * 4. hash 前进时把 nextHash 回写（替换上一步写入的 previousHash）
   */
  prepareFileMutationCheckpoint(sessionId: string, filePath: string): void {
    const fileHistory = this.getFileHistory();
    const previousHash = fileHistory.ensureSession(sessionId);
    if (!previousHash) {
      return;
    }
    this.updateLatestUserCheckpointHash(sessionId, undefined, previousHash);
    const nextHash = fileHistory.recordCheckpoint(sessionId, [filePath], "Pre-mutation checkpoint");
    if (nextHash && nextHash !== previousHash) {
      this.updateLatestUserCheckpointHash(sessionId, previousHash, nextHash);
    }
  }

  /**
   * 文件变更后置检查点（工具改写文件后调用，ToolExecutionHooks.onAfterFileMutation）
   *
   * 确保会话分支存在后为目标文件创建 File mutation checkpoint。
   */
  recordFileMutationCheckpoint(sessionId: string, filePath: string): void {
    const fileHistory = this.getFileHistory();
    fileHistory.ensureSession(sessionId);
    fileHistory.recordCheckpoint(sessionId, [filePath], "File mutation checkpoint");
  }

  /**
   * 将 checkpoint hash 回写到最近一条可撤销用户消息并持久化（hash 回写链路）
   *
   * 语义（undo 的数据源）：
   * - 从消息尾部向前找第一条 isUndoTargetMessage 的用户消息
   * - 若该消息已有 checkpointHash 且与 previousHash 不一致（说明被更新的
   *   checkpoint 占位），则放弃回写（保持最新值）
   * - 否则把 checkpointHash 替换为 nextHash，经 saveSessionMessages 落盘
   *
   * @param sessionId 会话 ID
   * @param previousHash 期望覆盖的旧 hash（undefined 表示无条件写入）
   * @param nextHash 要写入的新 hash
   */
  updateLatestUserCheckpointHash(sessionId: string, previousHash: string | undefined, nextHash: string): void {
    const messages = this.context.listSessionMessages(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || !this.isUndoTargetMessage(message)) {
        continue;
      }
      if (message.checkpointHash && message.checkpointHash !== previousHash) {
        return;
      }
      messages[index] = {
        ...message,
        checkpointHash: nextHash,
        updateTime: new Date().toISOString(),
      };
      this.context.saveSessionMessages(sessionId, messages);
      return;
    }
  }

  /**
   * 校验指定 checkpoint hash 是否可恢复（分支上存在该提交且 manifest 完整）
   */
  canRestoreCheckpointHash(sessionId: string, checkpointHash: string): boolean {
    return this.getFileHistory().canRestore(sessionId, checkpointHash);
  }

  /**
   * 恢复到指定 checkpoint（文件级回滚）
   *
   * 由 SessionManager.restoreSessionCode 组合层调用；
   * hash 不存在或恢复失败时由 GitFileHistory 内部抛错/降级。
   */
  restoreCheckpointHash(sessionId: string, checkpointHash: string): void {
    this.getFileHistory().restore(sessionId, checkpointHash);
  }

  /**
   * 判断消息是否为可撤销目标（undo target 谓词）
   *
   * 条件：role === "user" 且 visible 且未 compacted。
   * （assistant/tool 消息与压缩消息不作为回写目标）
   */
  isUndoTargetMessage(message: SessionMessage): boolean {
    return message.role === "user" && message.visible && !message.compacted;
  }
}
