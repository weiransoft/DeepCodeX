/**
 * V2 Session 上下文钩子
 *
 * 实现 V2 技术方案 §9.1 的 SessionContextHook 接口与默认实现，
 * 提供"两阶段缓存模式"（异步预计算 + 同步供给）。
 *
 * 设计依据：
 * - V2 技术方案 §9.1 与现有 OpenAIMessageConverter 集成
 * - V2 技术方案 §14.1 交付物映射表 #3（DualLayerContextManager → SessionContextHook.preBuildContext 缓存）
 * - NP-01 修复：preBuildContext 必须保持同步签名（buildMessages 是同步热路径）
 * - NP-02 修复：preBuildContext 参数仅为 messages，从 messages 中提取会话信息
 *
 * 缓存语义（§9.1）：
 * - 存储结构：Map<sessionId, ContextSnippet[]> 进程内存缓存；
 * - 过期策略：按 V2Config.context.globalTtlMs 过期（默认 30 分钟），过期即视为未命中；
 * - 未命中降级：preBuildContext 读取不到有效缓存时返回空数组（降级为无注入），
 *   不抛错、不触发隐式 async 调用；
 * - 快照语义：turn 内缓存不随文件变更失效，同一 turn 内多次 buildMessages 均以
 *   turn 入口已注入的快照为准；文件变更在下一 turn 的 refreshContextAsync 中体现。
 *
 * @module v2/integration/session-hook
 */

import type { SessionMessage } from "./v1-adapters";
import type { V2Config } from "./settings-bridge.js";
import { DualLayerContextManager, type CodeMapProvider } from "../context/dual-layer-manager.js";
import { GlobalContextManager } from "../context/global-context.js";
import { TaskContextManager } from "../context/task-context-manager.js";
import type { TaskDefinition } from "../context/types.js";
import { CodeMapGenerator, type CodeMap } from "../codemap/generator.js";
import { ProgressiveContextLoader } from "../context/progressive-loader.js";
import { RelevanceScorer } from "../context/relevance-scorer.js";
import { SlidingWindowManager } from "../context/sliding-window.js";
import { createSummarizer } from "../memory/summarizer-factory.js";

/**
 * 上下文片段：注入到 system message 的上下文数据
 *
 * 每个 ContextSnippet 表示一段已格式化的上下文文本，由
 * DualLayerContextManager.buildOptimizedContext()（V2-P1）计算产出，
 * 经 SessionContextHook 缓存后注入到 system message 末尾的"## V2 Context"区块。
 */
export interface ContextSnippet {
  /** 片段类型（file_content / task_context / memory / codemap 等） */
  type: string;
  /** 片段内容（已格式化的文本，直接拼接进 system message） */
  content: string;
  /** 来源标识（文件路径 / 任务 ID / 记忆键等，用于审计与去重） */
  source: string;
  /** 相关性评分（0-1，由 RelevanceScorer 计算，V2-P1 落地；V2-P0a 阶段可选） */
  relevance?: number;
}

/**
 * Session 上下文钩子：两阶段缓存模式（异步预计算 + 同步供给）
 *
 * v2.3 F-1 修复：buildMessages 是每轮 LLM 请求热路径上的同步纯 CPU 转换
 * （openai-message-converter.ts 返回 ChatCompletionMessageParam[]，非 Promise），
 * 因此 preBuildContext 必须保持同步签名；所有 async 工作（如
 * DualLayerContextManager.buildOptimizedContext()）移出热路径，
 * 由 refreshContextAsync 在 turn 入口统一预计算并写入内存缓存。
 *
 * 调用契约（§9.1）：
 * - preBuildContext：由 OpenAIMessageConverter.buildMessages 在每轮 LLM 请求前同步调用；
 * - refreshContextAsync：由 V2 编排器在 turn 开始（LLM 流式循环之前）调用一次，
 *   循环内禁止重复调用，循环内所有 buildMessages 均消费本次刷新产生的快照。
 */
export interface SessionContextHook {
  /**
   * 同步读取当前会话已缓存的上下文片段（无 await、无 I/O、纯内存读取）。
   *
   * 缓存由 refreshContextAsync 在 turn 开始时填充；未命中或已过期时返回空数组
   * （降级无注入）。本方法内部禁止调用任何 async 方法。
   *
   * NP-01 修复：同步方法（非 Promise），保持 buildMessages 同步签名不变
   * NP-02 修复：参数仅为 messages（从 messages 中提取会话信息），
   *           不需要 sessionId/userId/taskId（由 V2 模块内部通过自身 session 管理器获取）
   *
   * @param messages 当前会话的 SessionMessage 列表
   * @returns 缓存的上下文片段列表；未命中或过期时返回空数组
   */
  preBuildContext(messages: SessionMessage[]): ContextSnippet[];

  /**
   * 异步刷新上下文缓存。由 V2 编排器在 turn 开始（LLM 循环之前）调用一次，
   * 内部可安全调用 DualLayerContextManager.buildOptimizedContext() 等 async 方法，
   * 结果写入 Map<sessionId, ContextSnippet[]> 内存缓存，并按 V2Config.context.globalTtlMs 过期。
   *
   * 调用约束：仅在 turn 入口调用一次，LLM 流式循环（activateSession 内）禁止重复调用；
   * 循环内所有 buildMessages 均消费本次刷新产生的快照。
   *
   * @param sessionId 会话 ID
   */
  refreshContextAsync(sessionId: string): Promise<void>;
}

/**
 * 缓存条目：包含上下文片段列表与过期时间戳
 *
 * 内部类型，不对外导出。过期判断以 Date.now() 与 expiresAt 比较，
 * 过期后 preBuildContext 返回空数组（降级无注入），不抛错。
 */
interface CacheEntry {
  /** 上下文片段列表（写入时已做副本隔离，防止外部修改污染缓存） */
  snippets: ContextSnippet[];
  /** 过期时间戳（毫秒，Date.now() 风格）；Date.now() >= expiresAt 即视为过期 */
  expiresAt: number;
}

/**
 * SessionContextHook 的默认实现
 *
 * V2-P0a 阶段提供基于 Map 的进程内存缓存与 TTL 过期机制：
 * - preBuildContext：从 messages 中提取 sessionId，同步读取缓存
 * - refreshContextAsync：V2-P0a 空实现（V2-P1 由 DualLayerContextManager 填充）
 * - setSnippets：供外部注入上下文片段（测试和 V2-P1 使用）
 *
 * 设计说明：
 * - 默认 TTL 30 分钟，与 V2Config.context.globalTtlMs 默认值一致（§9.1）；
 * - 缓存读写均做深拷贝隔离（map + 对象展开），防止外部对片段对象字段的修改
 *   污染缓存内部状态，也防止缓存的内部修改影响已返回给调用方的片段对象
 *  （ContextSnippet 仅含原始类型字段，一层对象展开拷贝即彻底隔离）；
 * - 过期条目不在 preBuildContext 中删除（避免同步热路径产生写操作），
 *   过期清理在下次 setSnippets 时通过覆盖旧条目隐式完成。
 */
export class DefaultSessionContextHook implements SessionContextHook {
  /** 缓存存储：sessionId → 缓存条目（进程内存，不持久化） */
  private readonly cache: Map<string, CacheEntry> = new Map();
  /** 缓存 TTL（毫秒），过期后 preBuildContext 返回空数组 */
  private readonly ttlMs: number;

  /**
   * @param ttlMs 缓存生存时间（毫秒），默认 30 分钟（与 V2Config.context.globalTtlMs 默认值一致）
   */
  constructor(ttlMs: number = 30 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /**
   * 同步读取当前会话已缓存的上下文片段
   *
   * 实现要点（§9.1 NP-01/NP-02 修复）：
   * - 纯同步：无 await、无 I/O、无 Promise 调用，保证 buildMessages 同步签名不变；
   * - sessionId 提取：从 messages 数组的首条消息的 sessionId 字段获取
   *   （SessionMessage.sessionId 由 session.ts 持久化，每条消息均携带）；
   * - 未命中降级：缓存不存在或已过期时返回空数组，不抛错（§9.1 未命中降级约定）。
   *
   * @param messages 当前会话的 SessionMessage 列表
   * @returns 缓存的上下文片段列表（副本）；未命中或过期时返回空数组
   */
  preBuildContext(messages: SessionMessage[]): ContextSnippet[] {
    // 防御性检查：空消息数组无法提取 sessionId，直接返回空数组（降级无注入）
    if (messages.length === 0) {
      return [];
    }

    // 从首条消息提取 sessionId
    // 事实：SessionMessage 类型定义中每条消息均携带 sessionId 字段（session.ts:269）
    const sessionId = messages[0]?.sessionId;
    if (!sessionId) {
      // sessionId 缺失：返回空数组，不抛错（防御性降级）
      return [];
    }

    // 同步读取缓存条目
    const entry = this.cache.get(sessionId);
    if (!entry) {
      // 缓存未命中：返回空数组（§9.1 未命中降级约定，不抛错、不触发隐式 async 调用）
      return [];
    }

    // 过期检查：过期则视为未命中，返回空数组
    // 注意：不在此处删除过期条目（避免 preBuildContext 同步热路径产生写操作副作用），
    // 过期条目的清理在下次 setSnippets 时通过覆盖旧条目隐式完成
    if (Date.now() >= entry.expiresAt) {
      return [];
    }

    // 返回缓存的片段深拷贝副本：slice 仅隔离数组外壳，snippet 对象仍共享引用，
    // 外部修改返回值[i].content 会污染缓存。因此对每个 snippet 做一层对象展开拷贝
    //（ContextSnippet 仅含原始类型字段，一层拷贝即彻底隔离），
    // 确保调用方对返回值的任何修改不影响缓存内部状态（§9.1 快照语义）。
    return entry.snippets.map((s) => ({ ...s }));
  }

  /**
   * 异步刷新上下文缓存
   *
   * V2-P0a 阶段：空实现（保持接口完整，不执行任何预计算）。
   * V2-P1 阶段：由编排器调用 DualLayerContextManager.buildOptimizedContext() 计算上下文，
   * 再经 setSnippets 写入缓存（§14.1 交付物映射表 #3）。
   *
   * 调用时机（§9.1）：仅在 turn 入口调用一次，LLM 流式循环内禁止重复调用。
   *
   * @param sessionId 会话 ID（V2-P0a 阶段未使用，V2-P1 用于关联上下文计算与缓存写入）
   */
  async refreshContextAsync(sessionId: string): Promise<void> {
    // V2-P0a 阶段：不执行任何预计算，保持接口契约完整
    // V2-P1 落地时由编排器在此处调用 DualLayerContextManager 后再调用 setSnippets
    // 保留 sessionId 参数以保持接口契约稳定（避免 V2-P1 落地时修改签名）
    void sessionId;
  }

  /**
   * 外部注入上下文片段到缓存
   *
   * 供 V2-P1 的 DualLayerContextManager 在 refreshContextAsync 内部调用，
   * 也供测试用例直接填充缓存以验证 preBuildContext 行为。
   *
   * 写入时做副本隔离（slice），防止外部对 snippets 数组的后续修改影响缓存内容。
   *
   * @param sessionId 会话 ID
   * @param snippets 上下文片段列表
   */
  setSnippets(sessionId: string, snippets: ContextSnippet[]): void {
    // 防御性检查：空 sessionId 不写入缓存，避免空键污染 Map
    if (!sessionId) {
      return;
    }
    this.cache.set(sessionId, {
      // 写入深拷贝副本：slice 仅隔离数组外壳，snippet 对象仍共享引用，
      // 外部修改 snippets[i].content 会污染缓存。因此对每个 snippet 做一层
      // 对象展开拷贝（ContextSnippet 仅含原始类型字段，一层拷贝即彻底隔离），
      // 确保缓存快照语义（§9.1：turn 内缓存不随外部修改失效）。
      snippets: snippets.map((s) => ({ ...s })),
      expiresAt: Date.now() + this.ttlMs,
    });
  }
}

/**
 * 创建基于 DualLayerContextManager 的 SessionContextHook（V2-P1 集成入口）
 *
 * 设计目标：
 * - 当 V2 总开关（v2Config.enabled）与上下文开关（v2Config.context.enabled）
 *   均未开启时，返回 DefaultSessionContextHook，行为与 v1 完全一致（零回归）；
 * - 当 V2 上下文启用时，内部构造最小化的 DualLayerContextManager 依赖链，
 *   在 refreshContextAsync 中异步预计算上下文片段并写入缓存；
 * - preBuildContext 保持同步读缓存，buildMessages 同步签名不变。
 *
 * 最小依赖链构造说明：
 * - GlobalContextManager：默认存储路径 ~/.deepcode/global-context.json；
 * - TaskContextManager：内存级，按 sessionId 自动创建最小任务上下文；
 * - CodeMapProvider：基于 CodeMapGenerator 的会话级缓存实现，每 projectRoot 复用；
 * - RelevanceScorer / SlidingWindowManager / ProgressiveContextLoader / RuleBasedSummarizer：
 *   使用默认配置，不调用外部 LLM，保证 CI/离线环境可用。
 *
 * @param projectRoot 项目根目录
 * @param v2Config V2 配置（可选；未提供时使用默认配置，V2 默认关闭）
 * @param ttlMs 缓存 TTL（毫秒，可选；默认 30 分钟）
 * @returns SessionContextHook 实例
 */
export function createDualLayerContextHook(
  projectRoot: string,
  v2Config?: V2Config,
  ttlMs?: number
): SessionContextHook {
  // V2 总开关与上下文子开关必须同时为 true 才启用 DualLayerContextManager
  // 任一未开启时降级为 DefaultSessionContextHook，refreshContextAsync 为空操作
  const enabled = v2Config?.enabled === true && v2Config?.context?.enabled === true;
  if (!enabled) {
    return new DefaultSessionContextHook(ttlMs);
  }

  // 基础缓存 hook，用于同步供给 preBuildContext
  const hook = new DefaultSessionContextHook(ttlMs);

  // 全局上下文管理器：加载 ~/.deepcode/global-context.json，文件缺失时降级返回默认空上下文
  const globalManager = new GlobalContextManager();

  // 任务上下文管理器：内存级，进程结束即销毁
  const taskManager = new TaskContextManager();

  // CodeMap 提供者：基于 CodeMapGenerator 的会话级缓存
  // 同一 projectRoot 在 hook 生命周期内复用同一个 generator 实例
  const codeMapGenerator = new CodeMapGenerator({
    projectRoot,
    extensions: [],
    excludeDirs: v2Config.codemap?.excludeDirs ?? ["node_modules", ".git", "dist", "build"],
    maxFileSizeKb: v2Config.codemap?.maxFileSizeKb ?? 100,
    incremental: v2Config.codemap?.incremental ?? true,
    outputPath: ".deepcode/codemap.json",
  });
  const codeMapProvider: CodeMapProvider = {
    async getCodeMap(_root: string): Promise<CodeMap> {
      return codeMapGenerator.generateFullMap();
    },
  };

  // 相关性评分器与滑动窗口管理器：使用默认配置，不依赖外部 LLM
  const scorer = new RelevanceScorer();
  const progressiveLoader = new ProgressiveContextLoader();
  const summarizer = createSummarizer({ llm: { enabled: false } });
  const window = new SlidingWindowManager({}, scorer, progressiveLoader, summarizer);

  // 双层上下文管理器：V2-P1 集成入口
  const manager = new DualLayerContextManager(
    {
      projectRoot,
      window: {},
      scoring: {},
      defaultTokenBudget: v2Config.context?.tokenBudget ?? 100_000,
    },
    globalManager,
    taskManager,
    codeMapProvider,
    scorer,
    window,
    progressiveLoader,
    summarizer
  );

  /**
   * 为 sessionId 确保存在对应的任务上下文
   *
   * DualLayerContextManager.buildOptimizedContext 要求 taskId 对应的 TaskContext 存在，
   * 否则按设计约定返回空数组。此处将会话 ID 直接映射为任务 ID，并创建一个最小化的
   * 聊天任务定义，使上下文预计算能够正常执行。
   *
   * @param sessionId 会话 ID
   */
  function ensureTaskContext(sessionId: string): void {
    if (taskManager.get(sessionId) !== null) {
      return;
    }
    const taskDefinition: TaskDefinition = {
      description: "用户对话任务",
      goals: ["理解用户意图", "提供高质量回复"],
      constraints: [],
      taskType: "chat",
      expectedOutput: "assistant_reply",
    };
    taskManager.create(sessionId, taskDefinition);
  }

  return {
    /**
     * 同步读取缓存的上下文片段
     *
     * 直接委托给 DefaultSessionContextHook.preBuildContext，保持同步签名。
     */
    preBuildContext(messages: SessionMessage[]): ContextSnippet[] {
      return hook.preBuildContext(messages);
    },

    /**
     * 异步刷新上下文缓存
     *
     * turn 入口调用：确保任务上下文存在后，调用 DualLayerContextManager.buildOptimizedContext
     * 计算上下文片段，再经 setSnippets 写入缓存。任何步骤失败均降级为空缓存，不抛错，
     * 避免影响主对话流程。
     */
    async refreshContextAsync(sessionId: string): Promise<void> {
      if (!sessionId) {
        return;
      }
      try {
        ensureTaskContext(sessionId);
        const userId = "default";
        const snippets = await manager.buildOptimizedContext(userId, sessionId);
        hook.setSnippets(sessionId, snippets);
      } catch (err) {
        // 预计算失败：清空该会话缓存，降级为无 V2 上下文注入，不阻塞主循环
        const message = err instanceof Error ? err.message : String(err);

        console.error(`[V2 Context] refreshContextAsync failed for ${sessionId}: ${message}`);
        hook.setSnippets(sessionId, []);
      }
    },
  };
}
