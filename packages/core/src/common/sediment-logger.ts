/**
 * 执行历史沉淀（sedimentation）事件日志记录器（T5）
 *
 * 背景：执行历史 → MemoryStore 的自动沉淀链路（activateSession finally、
 * 增量沉淀、flushSedimentation、disposeAll 兜底、异常降级）此前只有
 * console.log/console.error 输出，进程被杀或无终端时事件完全不可追溯。
 * 本模块为该链路提供 5 种关键事件的结构化 JSONL 记录，写入
 * `<homeRoot>/.deepcodex/logs/sedimentation.log`。
 *
 * 设计依据（与 common/compact-logger.ts、common/interrupt-logger.ts 保持同构）：
 * - 模块位置放 common/（与 debug-logger.ts、error-logger.ts、interrupt-logger.ts 同目录）
 * - 共享 log-rotation.ts 轮转机制（10MB × 3 备份）
 * - 失败安全：所有日志操作在 try/catch 中静默吞掉，异常绝不影响沉淀主流程
 * - 牢笼改造对齐：homeRoot 可选注入（Web 多用户按用户隔离），缺省 = os.homedir()
 *
 * 5 种事件类型：
 * | 事件类型      | 触发位置                                        | 说明                         |
 * |--------------|------------------------------------------------|------------------------------|
 * | sync         | activateSession finally 沉淀（提取后的私有方法） | 常规轮次结束沉淀             |
 * | incremental  | 每满 SEDIMENT_INCREMENTAL_EVERY_TURNS 个激活轮次 | 长会话运行中的增量沉淀        |
 * | flush        | SessionManager.flushSedimentation 公开 API      | 主动兜底沉淀（SIGTERM 前等）  |
 * | fallback     | 关闭链路（disposeAll 等）兜底沉淀               | 预留：进程退出链路的兜底事件  |
 * | degrade      | 沉淀过程抛异常被 catch 降级                     | 携带 error 原文，便于排障     |
 *
 * @module common/sediment-logger
 */

import * as fs from "fs";
import * as path from "path";
import { rotateLogIfNeeded, getDeepCodeXLogDir } from "./log-rotation";

// ============================================================================
// 常量定义
// ============================================================================

/** 沉淀事件日志文件名 */
const SEDIMENT_LOG_FILE = "sedimentation.log";

// ============================================================================
// 类型定义
// ============================================================================

/** 沉淀事件类型（5 种，与文件头注释的事件表对齐） */
export type SedimentEventType = "sync" | "incremental" | "flush" | "fallback" | "degrade";

/** 沉淀事件日志条目 */
export interface SedimentEvent {
  /** 事件类型 */
  type: SedimentEventType;
  /** 关联的会话 ID（degrade 场景在 sessionId 已知时也应填写） */
  sessionId?: string;
  /** 本次沉淀成功的成功命令经验数（sync/incremental/flush/fallback 填写） */
  successCount?: number;
  /** 本次沉淀成功的失败+修复对经验数（sync/incremental/flush/fallback 填写） */
  failureFixCount?: number;
  /** 本次回写 raw jsonl 关联字段的执行记录条数（T4 patchRecordLinks 命中数） */
  linkedRecords?: number;
  /** 错误信息原文（degrade 填写） */
  error?: string;
}

// ============================================================================
// 核心函数实现
// ============================================================================

/**
 * 获取沉淀事件日志文件路径
 *
 * @param homeRoot 引擎数据根目录（可选注入，缺省 = os.homedir()，CLI 行为不变）
 * @returns 日志文件绝对路径（`<homeRoot>/.deepcodex/logs/sedimentation.log`）
 */
export function getSedimentLogPath(homeRoot?: string): string {
  return path.join(getDeepCodeXLogDir(homeRoot), SEDIMENT_LOG_FILE);
}

/**
 * 记录沉淀事件到日志文件（追加 JSONL）
 *
 * 写入流程（对齐 compact-logger.ts 的 logCompactEvent）：
 * 1. 确保日志目录存在（mkdir -p 语义）
 * 2. 写入前检查轮转（10MB × 3 备份，轮转失败降级为直接 append）
 * 3. 序列化事件为单行 JSON（`{ts, ...event}`）追加写入
 *
 * 失败处理：
 * - 整个函数被 try/catch 包裹，任何异常（权限不足、磁盘满等）都被静默吞掉
 * - 日志失败绝不影响沉淀主流程
 *
 * @param homeRoot 引擎数据根目录（SessionManager.homeRoot 透传，Web 多用户按用户隔离）
 * @param event 沉淀事件（type 必填，其余字段按事件类型选填）
 */
export function logSedimentEvent(homeRoot: string | undefined, event: SedimentEvent): void {
  try {
    const logPath = getSedimentLogPath(homeRoot);
    // 确保日志目录存在
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // 写入前检查轮转（失败时降级为直接 append）
    try {
      rotateLogIfNeeded(logPath);
    } catch {
      // 轮转失败不阻塞写入
    }
    // 每行一条事件：ISO 时间戳 + 事件字段平铺
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
  } catch {
    // 日志记录失败不影响沉淀主流程（静默）
  }
}
