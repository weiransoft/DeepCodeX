/**
 * Telemetry —— 结构化事件流 + 脱敏（方案 §5 / R2 / §8 度量基线）。
 *
 * 硬约束：
 * - 截图 base64、UI 全文、令牌、API Key **一律不写入事件**；
 * - 事件默认只在内存环形缓冲，不落盘；只有显式传入 sink 才写 jsonl；
 * - 记录的是「发生了什么动作、结果如何、耗时多少」，用于回放与成本看板，
 *   不是把界面内容复制一份到日志里。
 */

// 注意：不要把 base64 放进键名规则——它是常见的**数据字段名**（截图/图标），
// 超长二进制由下面的值检测处理；真正的密钥字段名仍一律脱敏。
const SECRET_KEY = /(api[_ -]?key|token|secret|password|credential|authorization|cookie)/i;
const REDACTED = "[redacted]";
const MAX_TEXT = 160;

function truncate(value) {
  if (typeof value !== "string") return value;
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…(truncated)` : value;
}

/** 递归脱敏：键名命中密钥词直接替换；长文本截断；base64 大串不留存 */
export function redact(value, depth = 0) {
  if (depth > 6) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) {
        out[k] = REDACTED;
      } else if (typeof v === "string" && /^[A-Za-z0-9+/=]{500,}$/.test(v)) {
        out[k] = `[binary-omitted:${v.length}]`;
      } else {
        out[k] = redact(truncate(v), depth + 1);
      }
    }
    return out;
  }
  return truncate(value);
}

export class Telemetry {
  constructor(options = {}) {
    this.capacity = options.capacity ?? 500;
    this.clock = options.clock ?? (() => Date.now());
    this.sink = options.sink ?? null; // null = 不落盘（默认）
    this.events = [];
    this.seq = 0;
  }

  /** 记录一条事件；返回脱敏后的事件（可安全回传前端 / 写入回放） */
  emit(type, payload = {}) {
    const event = {
      seq: ++this.seq,
      ts: this.clock(),
      type,
      ...redact(payload),
    };
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.shift();
    if (typeof this.sink === "function") {
      try {
        this.sink(event);
      } catch {
        /* 审计写入失败不应阻断主流程 */
      }
    }
    return event;
  }

  /** 动作计时包装：自动记 start / end / 耗时 / 结果码 */
  async measure(type, payload, fn) {
    const started = this.clock();
    this.emit(`${type}.start`, payload);
    try {
      const result = await fn();
      this.emit(`${type}.done`, {
        ...payload,
        ok: result?.ok !== false,
        code: result?.code,
        elapsedMs: this.clock() - started,
      });
      return result;
    } catch (err) {
      this.emit(`${type}.error`, {
        ...payload,
        ok: false,
        code: err?.code ?? "INTERNAL",
        elapsedMs: this.clock() - started,
      });
      throw err;
    }
  }

  /** 回放视图：给 P2 看板 / 事后复盘用 */
  list({ since = 0, type } = {}) {
    return this.events.filter((e) => e.seq > since && (!type || e.type === type));
  }

  /** 汇总指标（方案 §8） */
  metrics() {
    const byType = {};
    let elapsedMs = 0;
    for (const e of this.events) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      if (typeof e.elapsedMs === "number") elapsedMs += e.elapsedMs;
    }
    return {
      totalEvents: this.events.length,
      byType,
      accumulatedElapsedMs: elapsedMs,
      screenshotsPersisted: 0, // 恒为 0：本实现从不落盘截图
    };
  }
}
