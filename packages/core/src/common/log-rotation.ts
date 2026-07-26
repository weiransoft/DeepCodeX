/**
 * 统一日志轮转工具（D-2 修复）
 *
 * 提供按文件大小轮转的通用函数，供 debug-logger.ts、error-logger.ts、
 * interrupt-logger.ts 共用，替代历史"读全文 + slice + 重写"的性能反模式。
 *
 * 设计约束（Karpathy Simplicity First）：
 * - 仅使用 Node.js 标准库（fs）
 * - 失败安全：stat/rename/unlink 失败不抛错，由调用方在外层 try/catch 兜底
 * - 非原子操作：stat → unlink → rename 序列非原子，但被外层 try/catch 保护
 * - 备份策略：logPath → logPath.1 → logPath.2 → ... → logPath.N
 *
 * @module common/log-rotation
 */

import * as fs from "fs";

/** 默认日志文件大小上限（10MB） */
export const DEFAULT_MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;

/** 默认保留备份文件数量（3 个：.log.1 / .log.2 / .log.3） */
export const DEFAULT_MAX_BACKUP_COUNT = 3;

/** 轮转选项 */
export interface RotateLogOptions {
  /** 日志文件大小上限（字节），默认 10MB */
  maxSizeBytes?: number;
  /** 保留备份文件数量，默认 3 */
  maxBackupCount?: number;
}

/**
 * 检查日志文件大小，超过阈值时滚动备份
 *
 * 轮转流程（以 logPath=debug.log, maxBackupCount=3 为例）：
 * 1. stat(debug.log) 检查大小
 * 2. 若超过阈值：
 *    - unlink(debug.log.3)（删除最旧的备份）
 *    - rename(debug.log.2 → debug.log.3)
 *    - rename(debug.log.1 → debug.log.2)
 *    - rename(debug.log → debug.log.1)
 * 3. 下次 appendFileSync 会创建新的 debug.log
 *
 * 性能说明：仅 stat + N 次 rename，无文件读全文操作
 *
 * @param logPath 日志文件路径
 * @param options 轮转选项
 */
export function rotateLogIfNeeded(logPath: string, options: RotateLogOptions = {}): void {
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_LOG_SIZE_BYTES;
  const maxBackupCount = options.maxBackupCount ?? DEFAULT_MAX_BACKUP_COUNT;

  // 1. 检查文件大小（文件不存在时直接返回）
  let stats: fs.Stats;
  try {
    stats = fs.statSync(logPath);
  } catch {
    return;
  }
  if (stats.size < maxSizeBytes) {
    return;
  }

  // 2. 从最旧的备份开始删除/重命名（避免覆盖）
  for (let i = maxBackupCount; i >= 1; i--) {
    const backupPath = `${logPath}.${i}`;
    if (i === maxBackupCount) {
      try {
        fs.unlinkSync(backupPath);
      } catch {
        // 备份不存在，忽略
      }
    } else {
      const nextBackupPath = `${logPath}.${i + 1}`;
      try {
        fs.renameSync(backupPath, nextBackupPath);
      } catch {
        // 备份不存在，忽略
      }
    }
  }

  // 3. 当前日志文件重命名为 .1
  try {
    fs.renameSync(logPath, `${logPath}.1`);
  } catch (err) {
    throw new Error(
      `rotateLogIfNeeded 失败：无法重命名日志文件（${err instanceof Error ? err.message : String(err)}）`
    );
  }
}

/**
 * 获取备份文件路径列表（用于测试和调试）
 *
 * @param logPath 日志文件路径
 * @param maxBackupCount 备份数量
 * @returns 备份文件路径数组（从 .1 到 .N）
 */
export function getBackupFilePaths(logPath: string, maxBackupCount: number = DEFAULT_MAX_BACKUP_COUNT): string[] {
  const paths: string[] = [];
  for (let i = 1; i <= maxBackupCount; i++) {
    paths.push(`${logPath}.${i}`);
  }
  return paths;
}
