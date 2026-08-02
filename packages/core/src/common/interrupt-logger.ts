/**
 * 中断事件日志记录器（D-4 修复）
 *
 * 为动态指令注入与后台子 Agent 特性（ADR-DI-001）提供独立的日志记录机制，
 * 记录 7 种关键事件到 ~/.deepcodex/logs/interrupts.log。
 *
 * 设计依据：
 * - 架构师审查意见：模块位置放 common/（与 debug-logger.ts、error-logger.ts 同目录）
 * - 与 debug-logger.ts 共享 log-rotation.ts 轮转机制
 * - 失败安全：所有日志操作在 try/catch 中，异常不影响 CLI 主流程
 *
 * 8 种事件类型（与设计文档 §3.4 对齐）：
 * | 事件类型           | 触发位置                              | 说明           |
 * |-------------------|--------------------------------------|---------------|
 * | interrupt.enqueued | InterruptQueue.enqueue 成功后         | 指令入队       |
 * | interrupt.drained  | InterruptQueue.drain 返回非空后       | 指令被消费     |
 * | task.started       | BackgroundTaskRunner.start 注册成功后 | 后台任务启动   |
 * | task.succeeded     | BackgroundTask onStateChange 终态分支 | 任务成功完成   |
 * | task.failed        | BackgroundTask onStateChange 终态分支 | 任务失败       |
 * | task.cancelled     | BackgroundTask onStateChange 终态分支 | 任务被取消     |
 * | task.timeout       | BackgroundTask onStateChange 终态分支 | 任务执行超时   |
 * | task.injected      | BackgroundTask.inject 成功后         | 指令注入到任务 |
 *
 * @module common/interrupt-logger
 */

import * as fs from "fs";
import * as path from "path";
import { rotateLogIfNeeded, getDeepCodeXLogDir } from "./log-rotation";
import type { TaskKind, TaskStatus } from "../interrupts/types";

// ============================================================================
// 常量定义
// ============================================================================

/** 中断事件日志文件名 */
const INTERRUPT_LOG_FILE = "interrupts.log";

/** 指令文本截断长度（避免日志过长） */
const INSTRUCTION_TEXT_MAX_LENGTH = 200;

// ============================================================================
// 类型定义
// ============================================================================

/** 中断事件类型（8 种，与设计文档 §3.4 对齐） */
export type InterruptEventType =
  | "interrupt.enqueued"
  | "interrupt.drained"
  | "task.started"
  | "task.succeeded"
  | "task.failed"
  | "task.cancelled"
  | "task.timeout"
  | "task.injected";

/** 中断事件日志条目 */
export interface InterruptEvent {
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 事件类型 */
  eventType: InterruptEventType;
  /** 关联的任务 ID（task.* 事件必填） */
  taskId?: string;
  /** 任务类型（task.* 事件必填） */
  taskKind?: TaskKind;
  /** 任务状态（task.* 事件必填） */
  taskStatus?: TaskStatus;
  /** 关联的会话 ID */
  sessionId?: string;
  /** 指令文本（interrupt.* 事件必填，截断到 200 字符） */
  instructionText?: string;
  /** 指令来源（user / llm） */
  instructionSource?: "user" | "llm";
  /** 队列大小（drained 后的剩余大小） */
  queueSize?: number;
  /** 取消/失败原因 */
  reason?: string;
  /** 任务耗时（ms，task.succeeded/failed 时填写） */
  durationMs?: number;
}

// ============================================================================
// 核心函数实现
// ============================================================================

/**
 * 获取中断事件日志文件路径
 *
 * @returns 日志文件绝对路径（~/.deepcodex/logs/interrupts.log）
 */
export function getInterruptLogPath(): string {
  return path.join(getDeepCodeXLogDir(), INTERRUPT_LOG_FILE);
}

/**
 * 记录中断事件到日志文件
 *
 * 写入流程：
 * 1. 检查日志文件大小，超过 10MB 时滚动备份
 * 2. 序列化事件为 JSON 字符串
 * 3. 追加写入日志文件（appendFileSync）
 *
 * 失败处理：
 * - 整个函数被 try/catch 包裹
 * - 任何异常（权限不足、磁盘满等）都被静默吞掉
 * - 不影响 CLI 主流程
 *
 * @param event 中断事件
 */
export function logInterruptEvent(event: InterruptEvent): void {
  try {
    const logPath = getInterruptLogPath();
    // 确保日志目录存在
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // 写入前检查轮转（失败时降级为直接 append）
    try {
      rotateLogIfNeeded(logPath);
    } catch {
      // 轮转失败不阻塞写入
    }
    // 截断指令文本（避免日志过长）
    const sanitizedEvent: InterruptEvent = { ...event };
    if (sanitizedEvent.instructionText && sanitizedEvent.instructionText.length > INSTRUCTION_TEXT_MAX_LENGTH) {
      sanitizedEvent.instructionText = `${sanitizedEvent.instructionText.slice(0, INSTRUCTION_TEXT_MAX_LENGTH)}...(total ${sanitizedEvent.instructionText.length} chars)`;
    }
    // 序列化并追加写入
    const logLine = `${JSON.stringify(toSerializable(sanitizedEvent))}\n`;
    fs.appendFileSync(logPath, logLine, "utf8");
  } catch {
    // 日志记录失败不影响主流程
  }
}

/**
 * 将事件对象序列化为可安全 JSON 化的结构
 *
 * 处理：
 * - bigint 转为字符串
 * - Error 转为 {name, message, stack}
 * - 循环引用检测
 * - 冻结数组处理
 *
 * @param value 原始值
 * @returns 可序列化值
 */
function toSerializable(value: unknown): unknown {
  const seen = new WeakSet<object>();

  function walk(current: unknown): unknown {
    if (typeof current === "bigint") {
      return current.toString();
    }
    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        stack: current.stack,
      };
    }
    if (!current || typeof current !== "object") {
      return current;
    }
    if (seen.has(current as object)) {
      return "[Circular]";
    }
    seen.add(current as object);
    if (Array.isArray(current)) {
      return current.map(walk);
    }
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(current)) {
      result[key] = walk(val);
    }
    return result;
  }

  return walk(value);
}
