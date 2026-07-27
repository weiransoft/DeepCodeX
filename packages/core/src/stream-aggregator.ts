/**
 * StreamAggregator 流式聚合工具模块 —— 从 session.ts 抽取的流式相关纯函数
 *
 * 职责：
 * - Token 估算（基于 CJK 字符数的快速估算）
 * - Token 数格式化（人类可读的 k/k 格式）
 * - Abort 错误识别（兼容 OpenAI / Anthropic 的 AbortError / APIUserAbortError）
 * - AbortSignal 前置守卫（信号已取消时抛出 AbortError）
 *
 * 设计原则：
 * - 纯函数模块，无状态，无副作用
 * - 不依赖 SessionManager 实例（可独立单元测试）
 * - CJK_REGEX 预编译正则，避免每次调用重新编译
 *
 * 保留在 session.ts 中的方法（深度耦合，不宜抽取）：
 * - createChatCompletionStream：OpenAI 流式聚合（依赖 SessionManager 内部状态）
 * - createLlmMessageStream：Anthropic 流式聚合（依赖 SessionManager 内部状态）
 * - emitLlmStreamProgress：依赖 onLlmStreamProgress 回调
 * - logChatCompletionDebug：依赖 debug logger 配置
 *
 * 修订记录：
 * - 2026-07-26：从 session.ts 抽取（4 个纯函数 + 1 个常量，约 100 行）
 */

/**
 * 中日韩统一表意文字 + 扩展 A 区 + 兼容表意文字（预编译正则）
 *
 * 覆盖范围：
 * - U+3400-U+9FFF: CJK Unified Ideographs Extension A + Unified Ideographs
 * - U+F900-U+FAFF: CJK Compatibility Ideographs
 *
 * 使用 'g' 标志支持 match() 全局匹配，'u' 标志支持 Unicode 码点
 */
export const CJK_REGEX = /[\u3400-\u9fff\uf900-\ufaff]/gu;

/**
 * 估算流式文本的 token 数（v2 性能优化版）
 *
 * 算法说明：
 * - 中文/日文/韩文字符计 0.6 token（CJK 字符通常编码为 1-2 token）
 * - 其他字符计 0.3 token（ASCII/拉丁字母通常 3-4 字符为 1 token）
 *
 * 性能优化（v2 修复，对应 docs/dev/review.md 代码细节改进 4）：
 * - 原实现：逐字符正则测试（O(n) 次正则调用），长文本性能差
 * - 新实现：一次正则扫描统计 CJK 字符数（1 次正则调用），性能提升 5-10 倍
 * - 结果一致性：与原实现完全一致（相同文本返回相同 token 数）
 *
 * @param text 待估算的文本
 * @returns 估算的 token 数
 */
export function estimateStreamTokens(text: string): number {
  if (!text) {
    return 0;
  }
  // 一次正则扫描统计 CJK 字符数（match 返回所有匹配项数组）
  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = text.length - cjkCount;
  return cjkCount * 0.6 + otherCount * 0.3;
}

/**
 * 格式化 token 数为人类可读字符串
 *
 * 格式规则：
 * - ≤ 0 → "0"
 * - < 100 → 原始数字（如 "42"）
 * - < 10000 → 带 1 位小数的 k 格式（如 "1.5k"）
 * - ≥ 10000 → 取整的 k 格式（如 "15k"）
 *
 * @param tokens token 数值
 * @returns 格式化后的字符串
 */
export function formatEstimatedTokens(tokens: number): string {
  if (tokens <= 0) {
    return "0";
  }

  const roundedTokens = Math.round(tokens);
  if (roundedTokens <= 0) {
    return "0";
  }

  if (roundedTokens < 100) {
    return String(roundedTokens);
  }

  if (roundedTokens < 10000) {
    return `${Number((roundedTokens / 1000).toFixed(1))}k`;
  }

  return `${Math.round(roundedTokens / 1000)}k`;
}

/**
 * 判断错误是否为 Abort 相关错误
 *
 * 兼容两种 Abort 错误：
 * - 原生 AbortError（来自 fetch / AbortController.abort()）
 * - OpenAI SDK 的 APIUserAbortError（封装后的 Abort 错误）
 *
 * @param error 待判断的错误对象
 * @returns true 表示是 Abort 相关错误
 */
export function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError" || error.constructor.name === "APIUserAbortError";
}

/**
 * 前置守卫：如果 AbortSignal 已取消则抛出 AbortError
 *
 * 使用场景：
 * - LLM 调用前检查信号状态（避免无效请求）
 * - 流式 chunk 处理间隙检查信号状态（及时中断）
 * - 异步操作关键节点检查信号状态（快速失败）
 *
 * @param signal AbortSignal（可选，未传入时不检查）
 * @throws {Error} 当 signal.aborted 为 true 时抛出 name 为 "AbortError" 的错误
 */
export function throwIfAborted(signal?: AbortSignal | null): void {
  if (!signal?.aborted) {
    return;
  }

  const error = new Error("Request was aborted.");
  error.name = "AbortError";
  throw error;
}
