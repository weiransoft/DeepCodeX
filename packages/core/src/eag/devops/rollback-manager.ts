/**
 * NoOpRollbackManager —— 回滚管理器空实现占位（EAG-P4 批次 13 D1-4 §3.7 M-7 修复）
 *
 * 本模块提供 RollbackManager 接口的空实现占位，供 DevOpsOrchestrator / DeployStage
 * 在未注入真实 RollbackManager 时使用。
 *
 * 设计原则：
 * - 不引入实际副作用（不调用 kubectl / helm / docker 等外部命令）
 * - 与既有 Orchestrator 的"可选依赖 + 默认占位"模式同构
 * - 返回值被 Object.freeze 深冻结（对齐 P-1 不可变优先原则）
 *
 * 批次规划：
 * - 批次 13（当前）：仅 NoOpRollbackManager 占位实现
 * - 批次 14：K8sRollbackManager / HelmRollbackManager 完整实现
 *   - K8sRollbackManager：调用 `kubectl rollout undo deployment/<name>` 命令
 *   - HelmRollbackManager：调用 `helm rollback <release>` 命令
 *
 * 设计依据：
 * - EAG-P4 批次 13 设计文档 §3.7 RollbackManager 接口与 NoOpRollbackManager 占位实现
 * - §6.3 R-P4-3 风险缓解：批次 13 仅预留接口，不实现回滚逻辑
 *
 * @module eag/devops/rollback-manager
 */

import type { RollbackManager, RollbackSnapshotContext, RollbackSnapshot, RollbackResult } from "./types";

// ============================================================================
// NoOpRollbackManager 类
// ============================================================================

/**
 * NoOpRollbackManager —— 空实现占位
 *
 * 用途：
 * - DevOpsOrchestrator / DeployStage 在未注入 rollbackManager 时使用此占位
 * - createSnapshot() 返回空快照（snapshotId="noop-<timestamp>" / version="unknown"）
 * - rollback() 直接返回 success=false（无法回滚，提示用户手动处理）
 *
 * 设计原则：
 * - 不引入实际副作用（不调用 kubectl / helm）
 * - 与既有 Orchestrator 的"可选依赖 + 默认占位"模式同构
 * - 返回值被 Object.freeze 深冻结（对齐 P-1 不可变优先原则）
 */
export class NoOpRollbackManager implements RollbackManager {
  /**
   * 创建空快照（不调用任何外部命令）
   *
   * 实现：
   * - snapshotId：使用 "noop-<Date.now()>" 格式，保证唯一性
   * - version：固定为 "unknown"（占位实现无法获取真实版本）
   * - resources：空数组（占位实现无法枚举真实资源）
   * - createdAt：使用 new Date().toISOString() 生成 ISO 8601 时间戳
   *
   * @param context 快照上下文（含 projectName / namespace / previousVersion）
   * @returns RollbackSnapshot 含空快照数据，被 Object.freeze 冻结
   */
  async createSnapshot(context: RollbackSnapshotContext): Promise<RollbackSnapshot> {
    // 构造空快照（不调用任何外部命令，仅生成元数据）
    const snapshot: RollbackSnapshot = {
      snapshotId: `noop-${Date.now()}`,
      createdAt: new Date().toISOString(),
      version: "unknown", // 占位实现无法获取真实版本
      resources: Object.freeze([]) as ReadonlyArray<string>,
    };
    return Object.freeze(snapshot) as RollbackSnapshot;
  }

  /**
   * 空回滚（直接返回失败，提示用户手动处理）
   *
   * 实现：
   * - success：固定为 false（占位实现无法执行实际回滚）
   * - rolledBackTo：固定为 "none"（未执行任何回滚操作）
   * - duration：固定为 0（无实际操作耗时）
   * - errors：包含明确的错误消息，提示用户注入真实 RollbackManager 或手动执行回滚命令
   *
   * @param snapshot 部署前创建的版本快照（占位实现仅用于错误消息中引用 snapshotId）
   * @returns RollbackResult 含失败结果与错误消息，被 Object.freeze 冻结
   */
  async rollback(snapshot: RollbackSnapshot): Promise<RollbackResult> {
    // 构造失败结果（明确告知用户占位实现不支持实际回滚）
    const result: RollbackResult = {
      success: false,
      rolledBackTo: "none", // 占位实现未执行实际回滚
      duration: 0,
      errors: Object.freeze([
        `NoOpRollbackManager 不支持实际回滚（snapshot=${snapshot.snapshotId}），` +
          `请注入 K8sRollbackManager / HelmRollbackManager 或手动执行 ` +
          `kubectl rollout undo deployment/<name> -n <namespace> / helm rollback <release>`,
      ]) as ReadonlyArray<string>,
    };
    return Object.freeze(result) as RollbackResult;
  }
}
