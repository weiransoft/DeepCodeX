/**
 * 会话压缩（compact）事件日志记录器（T8）
 *
 * 背景：compact 链路（自动阈值触发 / 手动触发 → 摘要 LLM 请求 → 压缩落盘）
 * 此前没有任何日志，出现"compact 疑似卡住"时完全无法定位卡在哪个阶段。
 * 本模块为该链路提供 6 种关键事件的结构化 JSONL 记录，写入
 * `<homeRoot>/.deepcodex/logs/compact.log`。
 *
 * 设计依据（与 common/interrupt-logger.ts 保持同构）：
 * - 模块位置放 common/（与 debug-logger.ts、error-logger.ts、interrupt-logger.ts 同目录）
 * - 共享 log-rotation.ts 轮转机制（10MB × 3 备份）
 * - 失败安全：所有日志操作在 try/catch 中静默吞掉，异常绝不影响 compact 主流程
 *
 * 6 种事件类型（事件正常序列）：
 * | 事件类型        | 触发位置                                   | 说明                         |
 * |----------------|-------------------------------------------|------------------------------|
 * | compact_start  | compactSession 通过全部前置判定后           | 压缩开始（携带阈值/消息区间） |
 * | compact_skip   | compactSession 前置判定不满足而提前返回     | 跳过压缩（携带跳过原因）      |
 * | summary_start  | 摘要 LLM 请求（createMessage）发起前        | 摘要请求开始打点              |
 * | summary_done   | 摘要 LLM 请求成功返回                       | 摘要完成（durationMs/字符数） |
 * | summary_fail   | 摘要 LLM 请求抛异常                         | 摘要失败（error 原文）        |
 * | compact_done   | 压缩消息落盘完成                            | 压缩完成（前后消息数/总耗时） |
 *
 * @module common/compact-logger
 */

import * as fs from "fs";
import * as path from "path";
import { rotateLogIfNeeded, getDeepCodeXLogDir } from "./log-rotation";

// ============================================================================
// 常量定义
// ============================================================================

/** compact 事件日志文件名 */
const COMPACT_LOG_FILE = "compact.log";

// ============================================================================
// 类型定义
// ============================================================================

/** compact 事件类型（6 种，与文件头注释的事件序列对齐） */
export type CompactEventType =
  | "compact_start"
  | "summary_start"
  | "summary_done"
  | "summary_fail"
  | "compact_done"
  | "compact_skip";

/** compact 事件日志条目 */
export interface CompactEvent {
  /** 事件类型 */
  type: CompactEventType;
  /** 关联的会话 ID */
  sessionId: string;
  /** 触发/跳过时的估算 token 数（compact_start / compact_skip 填写） */
  tokensBefore?: number;
  /** 自动 compact 阈值（token 数，compact_start / compact_skip 填写） */
  threshold?: number;
  /** 被压缩消息区间的起始下标（compact_start / compact_done 填写） */
  rangeStart?: number;
  /** 被压缩消息区间的结束下标（左闭，compact_start / compact_done 填写） */
  rangeEnd?: number;
  /** 相关消息数（compact_skip = 可压缩消息数；compact_done = 落盘后消息总数） */
  messageCount?: number;
  /** 阶段耗时（ms：summary_done/summary_fail = 摘要请求耗时；compact_done = 压缩总耗时） */
  durationMs?: number;
  /** 摘要文本字符数（summary_done 填写） */
  summaryChars?: number;
  /** 错误信息原文（summary_fail 填写） */
  error?: string;
  /** 跳过原因（compact_skip 填写，如 "no-llm-client" / "below-threshold" 等） */
  reason?: string;
}

// ============================================================================
// 核心函数实现
// ============================================================================

/**
 * 获取 compact 事件日志文件路径
 *
 * @param homeRoot 引擎数据根目录（可选注入，缺省 = os.homedir()，CLI 行为不变）
 * @returns 日志文件绝对路径（`<homeRoot>/.deepcodex/logs/compact.log`）
 */
export function getCompactLogPath(homeRoot?: string): string {
  return path.join(getDeepCodeXLogDir(homeRoot), COMPACT_LOG_FILE);
}

/**
 * 记录 compact 事件到日志文件（追加 JSONL）
 *
 * 写入流程（对齐 interrupt-logger.ts 的 logInterruptEvent）：
 * 1. 确保日志目录存在（mkdir -p 语义）
 * 2. 写入前检查轮转（10MB × 3 备份，轮转失败降级为直接 append）
 * 3. 序列化事件为单行 JSON（`{ts, ...event}`）追加写入
 *
 * 失败处理：
 * - 整个函数被 try/catch 包裹，任何异常（权限不足、磁盘满等）都被静默吞掉
 * - 日志失败绝不影响 compact 主流程
 *
 * @param homeRoot 引擎数据根目录（SessionManager.homeRoot 透传，Web 多用户按用户隔离）
 * @param event compact 事件（type/sessionId 必填，其余字段按事件类型选填）
 */
export function logCompactEvent(homeRoot: string | undefined, event: CompactEvent): void {
  try {
    const logPath = getCompactLogPath(homeRoot);
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
    // 日志记录失败不影响 compact 主流程（静默）
  }
}
