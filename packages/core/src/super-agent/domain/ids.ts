/**
 * Super Agent ID 与幂等键
 *
 * ## 三类标识的分工
 *
 * | 用途 | 规则 | 理由 |
 * |---|---|---|
 * | 实体 ID（trigger / ticket / assignment…） | `crypto.randomUUID()` 派生，带类型前缀 | 全局唯一、可读前缀便于日志排查 |
 * | **幂等键**（Trigger） | `sha256(sourceId + actor + text + 时间桶)` | **同一事件重复投递必须命中**——否则会产生重复 Ticket |
 * | **Thread ID** | `sha256(sourceId + correlationKey)` | **确定性**——同一话题的后续事件必须落到同一 Thread，否则订阅直通失效 |
 *
 * ## 幂等键的时间桶
 *
 * 时间桶默认 5 分钟。取舍：
 * - 桶太短 → 同一事件重投（网络重试）可能跨桶，幂等失效；
 * - 桶太长 → 两条真正独立的相同消息会被误判为重复。
 *
 * 5 分钟是「网络重试」与「用户连发两条相同内容」的中间值。
 *
 * @module super-agent/domain/ids
 */

import * as crypto from "node:crypto";

/** 幂等键时间桶（毫秒） */
export const IDEMPOTENCY_BUCKET_MS = 5 * 60 * 1000;

/** 实体 ID 前缀表 */
export const ID_PREFIX = {
  trigger: "trg",
  thread: "thd",
  ticket: "tkt",
  assignment: "asg",
  decision: "dec",
  disposition: "dsp",
  input: "inp",
  message: "msg",
  attention: "att",
  effect: "eff",
} as const;

/** 实体 ID 类型 */
export type EntityKind = keyof typeof ID_PREFIX;

/**
 * 生成实体 ID
 *
 * @param kind 实体种类
 * @returns 带前缀的 UUID，如 `tkt_3f2a…`
 */
export function makeId(kind: EntityKind): string {
  return `${ID_PREFIX[kind]}_${crypto.randomUUID()}`;
}

/**
 * 计算 Trigger 幂等键
 *
 * @param input 幂等键输入
 * @returns 十六进制 sha256
 */
export function makeIdempotencyKey(input: {
  readonly sourceId: string;
  readonly actor: string;
  readonly text: string;
  readonly createdAt: string;
  /** 时间桶大小（毫秒），默认 {@link IDEMPOTENCY_BUCKET_MS} */
  readonly bucketMs?: number;
}): string {
  const bucketMs = input.bucketMs ?? IDEMPOTENCY_BUCKET_MS;
  const timestamp = Date.parse(input.createdAt);
  // 时间解析失败时退回 0 桶——宁可让键更稳定，也不要让键随时间漂移
  const safeTimestamp = Number.isNaN(timestamp) ? 0 : timestamp;
  const bucket = Math.floor(safeTimestamp / bucketMs);
  const payload = [input.sourceId, input.actor, input.text.trim(), String(bucket)].join("\u0000");
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * 计算确定性 Thread ID
 *
 * 同一 (sourceId, correlationKey) 永远得到同一 Thread ID。
 *
 * @param input Thread 键输入
 * @returns 带前缀的 sha256 前 32 位
 */
export function makeThreadId(input: { readonly sourceId: string; readonly correlationKey: string }): string {
  const payload = `${input.sourceId}\u0000${input.correlationKey}`;
  const digest = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
  return `${ID_PREFIX.thread}_${digest.slice(0, 32)}`;
}

/**
 * 计算内容指纹（用于去重与产物标识）
 *
 * @param content 任意内容
 * @returns 十六进制 sha256
 */
export function fingerprint(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}
