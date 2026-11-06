/**
 * Budget —— 成本与步数预算熔断（方案 §1.6 / R8）。
 *
 * TRAE 社区「400+ 积分事件」的根因是缺少预算可观测。这里把
 * 步数 / 截图 / token 三类预算做成**原子预扣**：动作执行前先扣，
 * 超限即熔断，任务内后续动作全部拒绝；只有显式 reset() 才恢复。
 */

import { ErrorCode, AgentError } from "../errors.mjs";

export class Budget {
  constructor(limits = {}, options = {}) {
    this.limits = {
      maxSteps: limits.maxSteps ?? 25,
      maxScreenshots: limits.maxScreenshots ?? 3,
      maxTokens: limits.maxTokens ?? 60_000,
      maxRetries: limits.maxRetries ?? 2,
    };
    this.clock = options.clock ?? (() => Date.now());
    this.reset();
  }

  reset() {
    this.used = { steps: 0, screenshots: 0, tokens: 0, retries: 0 };
    this.tripped = null;
    this.startedAt = this.clock();
  }

  /** 粗略 token 估算：无分词器依赖，按 UTF-8 字节 / 4 上取整，够做预算护栏 */
  estimateTokens(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
    return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
  }

  /** 预扣；超限时抛 BUDGET_EXCEEDED 并置熔断 */
  charge({ steps = 0, screenshots = 0, tokens = 0, retries = 0 } = {}) {
    if (this.tripped) {
      throw new AgentError(ErrorCode.BUDGET_EXCEEDED, `预算已熔断：${this.tripped}`, {
        used: { ...this.used },
        limits: { ...this.limits },
      });
    }
    const next = {
      steps: this.used.steps + steps,
      screenshots: this.used.screenshots + screenshots,
      tokens: this.used.tokens + tokens,
      retries: this.used.retries + retries,
    };
    const pairs = [
      ["steps", "maxSteps"],
      ["screenshots", "maxScreenshots"],
      ["tokens", "maxTokens"],
      ["retries", "maxRetries"],
    ];
    for (const [key, lim] of pairs) {
      if (next[key] > this.limits[lim]) {
        this.tripped = `${key} ${next[key]} > ${this.limits[lim]}`;
        // 记录已发生用量，便于事后复盘
        this.used = next;
        throw new AgentError(ErrorCode.BUDGET_EXCEEDED, `预算超限：${this.tripped}`, {
          used: { ...this.used },
          limits: { ...this.limits },
          hint: "停止任务并交还控制权（不要无限重试）",
        });
      }
    }
    this.used = next;
    return this.status();
  }

  status() {
    return {
      used: { ...this.used },
      limits: { ...this.limits },
      tripped: this.tripped,
      elapsedMs: Math.max(0, this.clock() - this.startedAt),
    };
  }
}
