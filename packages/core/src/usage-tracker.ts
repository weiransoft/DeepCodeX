/**
 * Usage 追踪模块 —— 从 session.ts 抽取的 Usage 累加与统计逻辑
 *
 * 职责：
 * - LLM Usage 数据累加（支持嵌套对象）
 * - 模型级 Usage 聚合（per-model）
 * - LLMUsage → ModelUsage 转换（统一 OpenAI/Anthropic 两条通路）
 * - 请求计数（total_reqs）
 * - 总 token 数计算（驱动 compact 阈值）
 *
 * 设计原则：
 * - 纯函数模块，无状态，无副作用
 * - 类型守卫严格防御空对象与类实例
 * - 累加算法使用迭代 + 深度限制，防止恶意 payload 栈溢出
 *
 * 修订记录：
 * - 2026-07-26：从 session.ts 抽取；addUsageValue 改迭代 + 深度限制；isUsageRecord 增加空对象防御
 */

import type { LLMUsage } from "./providers/llm-provider";

/**
 * 模型 Usage 数据结构（会话持久化格式）
 *
 * 字段说明：
 * - prompt_tokens: 输入 token 数（含 cache 命中与未命中部分）
 * - completion_tokens: 输出 token 数
 * - total_tokens: 总 token 数 = prompt_tokens + completion_tokens
 * - completion_tokens_details: 输出 token 明细（reasoning_tokens 等）
 * - prompt_tokens_details: 输入 token 明细（cached_tokens 等）
 * - prompt_cache_hit_tokens: cache 命中 token 数（缺省不输出）
 * - prompt_cache_miss_tokens: cache 未命中 token 数（缺省不输出）
 * - total_reqs: 请求累计次数
 */
export type ModelUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: Record<string, unknown>;
  prompt_tokens_details?: Record<string, unknown>;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  total_reqs?: number;
};

/**
 * addUsageValue 最大递归深度
 *
 * 限制说明：
 * - Usage 数据正常情况下深度 ≤ 3（如 { completion_tokens_details: { reasoning_tokens: 100 } }）
 * - 设置 10 为安全上限，远超正常使用场景
 * - 超出深度时记录警告并截断，防止恶意 payload 导致栈溢出
 */
const MAX_USAGE_DEPTH = 10;

/**
 * 类型守卫：判断值是否为有效的 Usage Record（非空普通对象）
 *
 * 防御维度：
 * 1. null / undefined → false
 * 2. 非对象类型（string/number/boolean 等）→ false
 * 3. 数组 → false
 * 4. 空对象 {} → false（Usage Record 应至少包含一个字段）
 * 5. 类实例（prototype 不是 Object.prototype）→ false
 *
 * @param value 待判断的值
 * @returns true 表示是有效的 Usage Record
 */
export function isUsageRecord(value: unknown): value is Record<string, unknown> {
  // 第一层防御：null / 非对象 / 数组
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  // 第二层防御：空对象（Usage Record 应至少包含一个字段）
  if (Object.keys(value as Record<string, unknown>).length === 0) {
    return false;
  }
  // 第三层防御：类实例（仅接受普通对象，拒绝 Date/Map/Set/类实例等）
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    return false;
  }
  return true;
}

/**
 * 累加 Usage 值（迭代实现，防止深嵌套 payload 栈溢出）
 *
 * 算法说明：
 * - 使用栈模拟递归，避免递归调用导致的栈溢出
 * - 每个栈帧包含 { current, next, target, key } 四元组
 * - 处理 number 时直接累加；处理对象时展开到栈中；其他类型直接覆盖
 * - 通过深度计数器限制最大迭代次数，超出时记录警告并截断
 *
 * 行为一致性：
 * - 与原递归实现结果一致（除了深度超限时的截断行为）
 * - number + number → 求和
 * - number + object → object 覆盖
 * - object + number → object 覆盖
 * - object + object → 递归合并
 *
 * @param current 当前累积值（可能为 number/object/其他类型）
 * @param next 新增值（可能为 number/object/其他类型）
 * @returns 累加后的值
 */
export function addUsageValue(current: unknown, next: unknown): unknown {
  // 快速路径：next 是 number，直接累加
  if (typeof next === "number") {
    return (typeof current === "number" ? current : 0) + next;
  }

  // 快速路径：next 不是有效的 Usage Record，直接返回 next（覆盖语义）
  if (!isUsageRecord(next)) {
    return next;
  }

  // 栈模拟递归：每个栈帧处理一个 (current, next, target, key) 四元组
  // - current: 当前累积值中对应 key 的子值
  // - next: 新增值中对应 key 的子值
  // - target: 父对象（结果对象），需要写入 result[key]
  // - key: 父对象中待写入的键名
  type StackFrame = {
    current: unknown;
    next: unknown;
    target: Record<string, unknown>;
    key: string;
  };
  const stack: StackFrame[] = [];

  // 根层结果对象：合并 current（如果是对象）和 next
  const currentRecord = isUsageRecord(current) ? current : {};
  const rootResult: Record<string, unknown> = { ...currentRecord };

  // 初始化栈：将 next 的所有键推入栈
  for (const [key, value] of Object.entries(next)) {
    stack.push({
      current: currentRecord[key],
      next: value,
      target: rootResult,
      key,
    });
  }

  // 深度计数器：限制最大迭代次数（MAX_USAGE_DEPTH * 100 是宽松上限，
  // 因为每次迭代处理一个键值对，而非一层深度）
  let iterationCount = 0;
  const maxIterations = MAX_USAGE_DEPTH * 100;

  while (stack.length > 0 && iterationCount < maxIterations) {
    const frame = stack.pop()!;
    iterationCount++;

    if (typeof frame.next === "number") {
      // number 累加：current 如果是 number 则求和，否则从 0 开始
      frame.target[frame.key] = (typeof frame.current === "number" ? frame.current : 0) + frame.next;
    } else if (isUsageRecord(frame.next)) {
      // 对象合并：创建嵌套结果对象，将 next 的所有键推入栈
      const nestedCurrent = isUsageRecord(frame.current) ? frame.current : {};
      const nestedResult: Record<string, unknown> = { ...nestedCurrent };
      frame.target[frame.key] = nestedResult;
      for (const [k, v] of Object.entries(frame.next)) {
        stack.push({
          current: nestedCurrent[k],
          next: v,
          target: nestedResult,
          key: k,
        });
      }
    } else {
      // 其他类型：直接覆盖（与原递归实现一致）
      frame.target[frame.key] = frame.next;
    }
  }

  // 深度超限警告：记录但不抛错，返回已累积的部分结果
  if (iterationCount >= maxIterations) {
    console.warn(
      `[usage-tracker] addUsageValue 超出最大迭代限制 ${maxIterations}（深度上限 ${MAX_USAGE_DEPTH}），已截断`
    );
  }

  return rootResult;
}

/**
 * 累加 Usage（null 安全版本）
 *
 * @param current 当前累积的 ModelUsage（可能为 null）
 * @param next 新增的 Usage 数据（可能为 null/undefined/任意值）
 * @returns 累加后的 ModelUsage，或 null
 */
export function accumulateUsage(current: ModelUsage | null, next: unknown | null | undefined): ModelUsage | null {
  if (next == null) {
    return current ?? null;
  }
  return addUsageValue(current, next) as ModelUsage;
}

/**
 * 为 Usage 增加请求计数（total_reqs + 1）
 *
 * @param usage 当前 Usage 数据
 * @returns 新的 Usage 对象（total_reqs 递增）
 */
export function usageWithRequestCount(usage: ModelUsage): ModelUsage {
  const totalReqs = typeof usage.total_reqs === "number" ? usage.total_reqs + 1 : 1;
  return {
    ...usage,
    total_reqs: totalReqs,
  };
}

/**
 * 按模型聚合 Usage（per-model 累加）
 *
 * @param current 当前 per-model Usage 字典（可能为 null/undefined）
 * @param model 模型名称（空字符串归一化为 "unknown"）
 * @param next 新增的 ModelUsage（可能为 null/undefined）
 * @returns 更新后的 per-model Usage 字典，或 null
 */
export function accumulateUsagePerModel(
  current: Record<string, ModelUsage> | null | undefined,
  model: string,
  next: ModelUsage | null | undefined
): Record<string, ModelUsage> | null {
  if (next == null) {
    return current ?? null;
  }

  const usagePerModel = { ...(current ?? {}) };
  // 模型名称归一化：trim 空白，空字符串归一化为 "unknown"
  const modelName = model.trim() || "unknown";
  // 累加当前模型的 Usage，并递增请求计数
  usagePerModel[modelName] = accumulateUsage(usagePerModel[modelName] ?? null, usageWithRequestCount(next))!;
  return usagePerModel;
}

/**
 * 获取 Usage 中的总 token 数
 *
 * 用于驱动 compact 阈值判断：activeTokens = getTotalTokens(usage)
 *
 * @param usage Usage 数据（可能为 null/undefined）
 * @returns total_tokens 数值，无效时返回 0
 */
export function getTotalTokens(usage: ModelUsage | null | undefined): number {
  if (!isUsageRecord(usage)) {
    return 0;
  }
  const totalTokens = usage.total_tokens;
  return typeof totalTokens === "number" ? totalTokens : 0;
}

/**
 * 统一 LLMUsage → 会话持久化 ModelUsage 转换
 *
 * （B1：compactSession 接线 provider 层；2026-07-18 设计 §4.4 cache 语义修正）
 *
 * 字段映射（修正版，一处定义两通路共享）：
 * - prompt_tokens ← inputTokens + cacheCreation + cacheRead。
 *   语义事实：Anthropic 的 input_tokens 不含 cache_read/cache_creation（三者独立计量计费），
 *   而 DeepSeek 的 prompt_tokens 为输入总量（= prompt_cache_hit + prompt_cache_miss）。
 *   消费方约束：getTotalTokens 只读 total_tokens → activeTokens → 驱动 compact 阈值；
 *   若 prompt_tokens 不含 cache 命中部分，prompt caching 生效时 activeTokens 被严重低估
 *   （cache 命中可占上下文 90%+），compact 永不触发 → 上下文溢出。故必须含 cache 部分；
 * - completion_tokens ← outputTokens；total_tokens = prompt_tokens + completion_tokens；
 * - cacheReadInputTokens → prompt_cache_hit_tokens（命中计量，缺省不输出字段）；
 * - inputTokens + cacheCreationInputTokens → prompt_cache_miss_tokens
 *   （未命中计量 = 新输入 + 写缓存，缺省不输出字段）。
 * DeepSeek 自有 prompt_cache_hit/miss_tokens 不经此函数（主对话流式通路保持原样透传）。
 * OpenAI provider 的 LLMUsage 永无 cache 字段，映射结果与修正前逐值相等（OpenAI 通路零变化）。
 *
 * @param usage provider 层返回的 LLMUsage（可能为 null）
 * @returns 转换后的 ModelUsage，或 null
 */
export function toModelUsage(usage: LLMUsage | null): ModelUsage | null {
  if (!usage) {
    return null;
  }
  const cacheCreation = usage.cacheCreationInputTokens ?? 0;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  // prompt_tokens 必须包含 cache 部分，否则 compact 阈值判断失效
  const promptTokens = usage.inputTokens + cacheCreation + cacheRead;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: promptTokens + usage.outputTokens,
    // cache 命中计量：仅在 provider 返回时输出
    ...(usage.cacheReadInputTokens != null ? { prompt_cache_hit_tokens: usage.cacheReadInputTokens } : {}),
    // cache 未命中计量：仅在 provider 返回时输出
    ...(usage.cacheCreationInputTokens != null
      ? { prompt_cache_miss_tokens: usage.inputTokens + usage.cacheCreationInputTokens }
      : {}),
  };
}
