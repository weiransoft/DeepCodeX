/**
 * 内容摘要器接口（双实现模式的统一契约）—— F-FOCUS-03 配套
 *
 * 提供两个真实实现（非 mock）：
 * - DeepSeekSummarizer：生产环境，调用真实 DeepSeek LLM API
 * - RuleBasedSummarizer：测试环境，基于真实启发式规则的摘要生成
 *
 * 设计依据：
 * - V2_P2_IMPLEMENTATION_PLAN.md §3.3.1（权威接口定义）
 * - V2 测试方案 §7.2（取代技术方案 §10.4 的 LLMSummarizer 接口名）
 * - R-P2-07：ContentSummarizer 为权威接口名，需回流修订技术方案 §10.4
 *
 * 双实现模式目的：
 * - CI 环境（无 DEEPSEEK_API_KEY）自动使用 RuleBasedSummarizer，确保测试全绿
 * - 生产环境（有 DEEPSEEK_API_KEY）使用 DeepSeekSummarizer，调用真实 LLM
 * - 切换由 summarizer-factory.ts 工厂方法统一控制，调用方无感知
 *
 * @module v2/memory/content-summarizer
 */

/**
 * 关键信息（用于记忆提取）
 *
 * 由 extractKeyInfo 方法产出，供 ProjectMemoryManager 等记忆模块
 * 提取用户偏好、事实、技能、任务等结构化信息。
 */
export interface KeyInfo {
  /** 信息类型（preference=偏好 / fact=事实 / skill=技能 / task=任务） */
  type: "preference" | "fact" | "skill" | "task";
  /** 信息内容（原始文本片段） */
  content: string;
  /** 置信度（0-1，1 表示完全确定） */
  confidence: number;
}

/**
 * 内容摘要器接口
 *
 * 双实现模式的统一契约。测试中通过工厂方法切换，不使用任何 mock 框架。
 *
 * 方法语义：
 * - summarize：将长文本压缩为不超过 maxLength 字符的摘要，保留关键信息
 * - extractKeyInfo：从文本中提取结构化关键信息，用于记忆归档
 *
 * 实现要求：
 * - 真实算法（非 mock）：RuleBasedSummarizer 使用句子分割+关键词加权+截断的真实启发式
 * - 真实调用（非占位）：DeepSeekSummarizer 调用真实 DeepSeek API
 * - 失败安全：extractKeyInfo 解析失败时返回空数组，不抛错
 */
export interface ContentSummarizer {
  /**
   * 生成内容摘要
   *
   * @param content 原始内容
   * @param maxLength 最大长度（字符数），摘要不得超过此长度
   * @returns 摘要字符串（可能为空串，当 content 为空或全部被过滤时）
   */
  summarize(content: string, maxLength: number): Promise<string>;

  /**
   * 提取关键信息（用于记忆提取）
   *
   * @param content 原始内容
   * @returns 关键信息数组（可能为空数组，当无匹配规则或解析失败时）
   */
  extractKeyInfo(content: string): Promise<KeyInfo[]>;
}

/**
 * 摘要器配置（工厂方法用）
 *
 * 注：测试方案 §7.5 使用 V2Config 类型，但 V2Config 在代码库中不存在。
 * 本方案以 SummarizerConfig 最小化替代（YAGNI），仅含 LLM 开关字段。
 * V2Config 应随 F-MEM-01 等特性引入时再完整定义。
 *
 * R-P2-08：需回流修订测试方案 §7.5 的 V2Config → SummarizerConfig。
 */
export interface SummarizerConfig {
  /** LLM 配置 */
  llm: {
    /**
     * 是否启用 LLM（生产环境 true，测试环境 false）
     *
     * - true + DEEPSEEK_API_KEY 存在 → DeepSeekSummarizer（生产）
     * - true + 无 DEEPSEEK_API_KEY → RuleBasedSummarizer（降级）
     * - false → RuleBasedSummarizer（测试）
     */
    enabled: boolean;
  };
}
