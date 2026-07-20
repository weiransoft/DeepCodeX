/**
 * DeepCodeX 多角色团队 - 领域专家注册中心（DomainExpertRegistry）
 *
 * 来源：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.2 / §4.3
 * 严格遵循 user rules：禁止 mock/占位/简化；所有方法真实实现
 * Karpathy 原则：Surgical Changes - 只新增必需字段，不修改 RoleRegistry
 *
 * 核心能力：
 *   1. 三级索引（expertId / category / tag）支持快速查询
 *   2. 动态注册 / 注销（与 multi-agent-team V3 插件热加载对齐）
 *   3. v1.1 P1-7 三道命名冲突检测（regex / 自身重复 / 跨系统 RoleId 冲突）
 *   4. v1.1 P1-2 懒加载并发模型（in-flight Promise 缓存，避免并发重复加载）
 *
 * 与 RoleRegistry 的关系：
 *   - 平行设计：DomainExpertRegistry 不修改 RoleRegistry
 *   - 命名空间隔离：expertId 强制 domain- 前缀（types.ts DomainExpertId regex）
 *   - 跨系统冲突检测：构造时可选注入 roleRegistry，register 时校验
 *
 * 线程安全分析（v1.1 P1-2）：
 *   - Node.js 单线程事件循环，无真正并发竞态
 *   - 但 async 操作之间存在交错（microtask boundary）
 *   - Map.set / Map.get 是同步操作，不会被打断
 *   - 因此 in-flight Promise 模式在 Node.js 中是安全的
 */

import type { DomainCategory, DomainExpert } from "./types.js";
import {
  DomainExpertAlreadyRegisteredError,
  DomainExpertCategoryUnknownError,
  DomainExpertRoleIdCollisionError,
} from "./errors.js";

// ============================================================================
// 第一部分：RoleRegistry 适配器接口（v1.1 P1-NEW-2 修复）
// ============================================================================

/**
 * RoleRegistry 适配器接口
 *
 * v1.1 P1-NEW-2 修复：
 *   - 设计文档 §3.2 构造函数签名 `roleRegistry?: Readonly<{ listRoleIds: () => ReadonlyArray<string> }>`
 *   - 现有 role-registry.ts 导出的是独立函数 `listRoleIds()`，不是对象方法
 *   - 通过此接口，调用方可直接传入 `{ listRoleIds }` 包装对象
 *
 * 示例：
 *   ```typescript
 *   import { listRoleIds } from "./role-registry.js";
 *   const registry = new DomainExpertRegistry({ listRoleIds });
 *   ```
 */
export interface RoleRegistryAdapter {
  /** 列出所有已注册的 RoleId（用于跨系统命名冲突检测） */
  listRoleIds(): ReadonlyArray<string>;
}

// ============================================================================
// 第二部分：DomainExpertRegistry 主类
// ============================================================================

/**
 * 领域专家注册中心
 *
 * v1.1 P1-7 命名冲突检测增强：
 *   1. 构造时可选注入 roleRegistry，跨系统冲突检测
 *   2. register() 内部三道校验：expertId regex / 自身重复 / 与 RoleId 冲突
 *   3. 抛出 DomainExpertAlreadyRegisteredError / DomainExpertRoleIdCollisionError
 *
 * v1.1 P1-2 懒加载并发模型：
 *   1. loadByCategory(category) 使用 in-flight Promise 缓存，避免并发重复加载
 *   2. loadedCategories: Set<DomainCategory> 记录已加载类别
 *   3. loadingPromises: Map<DomainCategory, Promise<void>> 记录 in-flight Promise
 */
export class DomainExpertRegistry {
  /** 专家定义主索引：expertId → DomainExpert */
  private readonly experts: Map<string, DomainExpert> = new Map();
  /** 类别索引：category → Set<expertId> */
  private readonly categoryIndex: Map<DomainCategory, Set<string>> = new Map();
  /** 业务标签索引：tag → Set<expertId>（动态调用核心入口） */
  private readonly tagIndex: Map<string, Set<string>> = new Map();
  /** v1.1 P1-7：已注册 ID 集合（与 experts.keys 等价，但 Set 查询 O(1)） */
  private readonly registeredIds: Set<string> = new Set();
  /** v1.1 P1-2：已加载类别集合（避免重复加载） */
  private readonly loadedCategories: Set<DomainCategory> = new Set();
  /** v1.1 P1-2：in-flight Promise 缓存，避免并发重复加载 */
  private readonly loadingPromises: Map<DomainCategory, Promise<void>> = new Map();

  /**
   * 构造函数
   *
   * @param roleRegistry v1.1 P1-7 跨系统 RoleRegistry 引用（可选）
   *                     用于 register 时检测 expertId 与 RoleId 的命名冲突
   *                     调用方通过 `{ listRoleIds }` 包装传入（P1-NEW-2）
   * @param categoryLoaders v1.1 P1-2 类别加载器映射（可选，用于测试注入）
   *                        默认使用动态 import 加载 ./domain-experts/*-experts.js
   */
  constructor(
    private readonly roleRegistry?: RoleRegistryAdapter,
    /**
     * 类别加载器注入接口（用于单元测试，禁止 mock，仅替换加载来源）
     * key: DomainCategory, value: 返回 register 函数的 Promise
     *
     * 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §4.3 loadByCategoryInternal
     * 测试时直接传入真实函数（如 `() => Promise.resolve({ register: (r) => r.register(expert) })`）
     */
    private readonly categoryLoaders?: Readonly<
      Record<DomainCategory, () => Promise<{ register: (r: DomainExpertRegistry) => void }>>
    >
  ) {}

  // ==========================================================================
  // 第三部分：注册与注销
  // ==========================================================================

  /**
   * 注册单个领域专家（v1.1 P1-7 三道校验）
   *
   * 校验顺序（fail-fast）：
   *   1. expertId regex 校验：由 DomainExpert schema 在调用方 parse 时保证
   *      （本方法接收的 expert 已是 DomainExpert 类型，schema 已通过）
   *   2. 自身重复校验：registeredIds.has(expertId) → DomainExpertAlreadyRegisteredError
   *   3. 跨系统 RoleId 冲突校验：去 domain- 前缀后与 roleRegistry.listRoleIds() 比较
   *      → DomainExpertRoleIdCollisionError
   *
   * @param expert 已通过 DomainExpert.parse 校验的专家定义
   * @throws {DomainExpertAlreadyRegisteredError} 当 expertId 已注册时
   * @throws {DomainExpertRoleIdCollisionError} 当 expertId 去 domain- 前缀后与 RoleId 冲突时
   */
  register(expert: DomainExpert): void {
    // 校验 1：expertId regex（防御性，schema 已保证；运行时再校验一次以防空构造）
    if (!/^domain-[a-z][a-z0-9-]*$/.test(expert.expertId)) {
      throw new Error(`expertId 不符合 domain- 前缀 regex：${expert.expertId}`);
    }

    // 校验 2：自身重复
    if (this.registeredIds.has(expert.expertId)) {
      throw new DomainExpertAlreadyRegisteredError(expert.expertId);
    }

    // 校验 3：跨系统 RoleId 冲突（P1-7）
    if (this.roleRegistry) {
      const roleIds = this.roleRegistry.listRoleIds();
      const stripped = expert.expertId.replace(/^domain-/, "");
      if (roleIds.includes(stripped)) {
        throw new DomainExpertRoleIdCollisionError(expert.expertId, stripped);
      }
    }

    // 注册到主索引
    this.experts.set(expert.expertId, expert);
    this.registeredIds.add(expert.expertId);

    // 注册到类别索引
    let categorySet = this.categoryIndex.get(expert.category);
    if (!categorySet) {
      categorySet = new Set();
      this.categoryIndex.set(expert.category, categorySet);
    }
    categorySet.add(expert.expertId);

    // 注册到业务标签索引
    for (const tag of expert.domainTags) {
      let tagSet = this.tagIndex.get(tag);
      if (!tagSet) {
        tagSet = new Set();
        this.tagIndex.set(tag, tagSet);
      }
      tagSet.add(expert.expertId);
    }
  }

  /**
   * 批量注册（遇到冲突立即终止并抛出，已注册的不回滚）
   *
   * 设计决策：不回滚已注册的专家
   *   - 原因：registerAll 通常在模块初始化时调用，回滚会导致部分模块不可用
   *   - 失败处理：调用方应捕获错误并清理已注册的专家（通过 unregister）
   *   - 详见设计文档 §3.2 "批量注册（遇到冲突立即终止并抛出，已注册的不回滚）"
   *
   * @param experts 专家定义数组
   * @throws {DomainExpertAlreadyRegisteredError} 第一个冲突的 expertId
   * @throws {DomainExpertRoleIdCollisionError} 第一个冲突的 RoleId
   */
  registerAll(experts: ReadonlyArray<DomainExpert>): void {
    for (const expert of experts) {
      this.register(expert);
    }
  }

  /**
   * 注销专家（支持运行时卸载）
   *
   * 与 multi-agent-team V3 插件热加载对齐：
   *   - 卸载时同步清理三级索引
   *   - 返回 boolean 表示是否实际卸载（未找到返回 false）
   *
   * @param expertId 专家 ID
   * @returns true 表示已卸载，false 表示未找到
   */
  unregister(expertId: string): boolean {
    const expert = this.experts.get(expertId);
    if (!expert) {
      return false;
    }

    // 清理主索引
    this.experts.delete(expertId);
    this.registeredIds.delete(expertId);

    // 清理类别索引
    const categorySet = this.categoryIndex.get(expert.category);
    if (categorySet) {
      categorySet.delete(expertId);
      // 空集合自动清理（避免内存泄漏）
      if (categorySet.size === 0) {
        this.categoryIndex.delete(expert.category);
      }
    }

    // 清理业务标签索引
    for (const tag of expert.domainTags) {
      const tagSet = this.tagIndex.get(tag);
      if (tagSet) {
        tagSet.delete(expertId);
        if (tagSet.size === 0) {
          this.tagIndex.delete(tag);
        }
      }
    }

    return true;
  }

  // ==========================================================================
  // 第四部分：查询接口
  // ==========================================================================

  /**
   * 按 expertId 获取专家定义
   *
   * @param expertId 专家 ID
   * @returns 专家定义（未找到返回 undefined）
   */
  getExpert(expertId: string): DomainExpert | undefined {
    return this.experts.get(expertId);
  }

  /**
   * 按类别获取全部专家
   *
   * @param category 业务类别
   * @returns 专家定义数组（未找到返回空数组）
   */
  getByCategory(category: DomainCategory): ReadonlyArray<DomainExpert> {
    const ids = this.categoryIndex.get(category);
    if (!ids || ids.size === 0) {
      return [];
    }
    const result: DomainExpert[] = [];
    for (const id of ids) {
      const expert = this.experts.get(id);
      if (expert) {
        result.push(expert);
      }
    }
    return result;
  }

  /**
   * 按业务标签获取专家（动态调用核心入口）
   *
   * 设计文档 §3.2：getByDomainTag 是动态调用的核心入口
   * 用法：DomainExpertMatcher 通过任务 domainTags 调用此方法获取候选专家
   *
   * @param tag 业务标签（如 "金融"、"医疗"、"零售"）
   * @returns 匹配的专家数组（未找到返回空数组）
   */
  getByDomainTag(tag: string): ReadonlyArray<DomainExpert> {
    const ids = this.tagIndex.get(tag);
    if (!ids || ids.size === 0) {
      return [];
    }
    const result: DomainExpert[] = [];
    for (const id of ids) {
      const expert = this.experts.get(id);
      if (expert) {
        result.push(expert);
      }
    }
    return result;
  }

  /**
   * 列出所有专家 ID
   *
   * @returns 专家 ID 数组（只读）
   */
  listExpertIds(): ReadonlyArray<string> {
    return Array.from(this.registeredIds);
  }

  /**
   * 列出所有业务标签
   *
   * 用途：调试 / 监控 / DomainExpertMatcher 候选集生成
   *
   * @returns 标签数组（只读）
   */
  listDomainTags(): ReadonlyArray<string> {
    return Array.from(this.tagIndex.keys());
  }

  /**
   * 列出所有已加载的类别
   *
   * 用途：测试验证懒加载行为 / 监控加载状态
   *
   * @returns 已加载类别数组（只读）
   */
  listLoadedCategories(): ReadonlyArray<DomainCategory> {
    return Array.from(this.loadedCategories);
  }

  /**
   * 是否已注册指定专家
   *
   * @param expertId 专家 ID
   * @returns true 表示已注册
   */
  has(expertId: string): boolean {
    return this.registeredIds.has(expertId);
  }

  /**
   * 获取已注册专家总数
   *
   * 用途：测试验证 / 监控
   *
   * @returns 专家数量
   */
  size(): number {
    return this.registeredIds.size;
  }

  // ==========================================================================
  // 第五部分：懒加载（v1.1 P1-2 in-flight Promise 并发安全）
  // ==========================================================================

  /**
   * 按类别懒加载（in-flight Promise 缓存，避免并发重复加载）
   *
   * 问题场景：
   *   - 多个并发请求同时触发 ensureLoaded("product")
   *   - 若不缓存 in-flight Promise，会导致 product-experts.ts 被加载 N 次
   *   - 浪费 I/O + 可能引发 register() 重复注册错误
   *
   * 解决方案：
   *   - loadingPromises: Map<DomainCategory, Promise<void>> 缓存 in-flight Promise
   *   - 第一个请求创建 Promise 并缓存，后续请求复用同一 Promise
   *   - Promise 完成（成功/失败）后从缓存移除
   *
   * @param category 业务类别
   * @throws {DomainExpertCategoryUnknownError} 当 category 不在 8 个有效类别中
   * @throws {DomainExpertAlreadyRegisteredError} 当加载的专家已注册（in-flight Promise 失败）
   * @throws {DomainExpertRoleIdCollisionError} 当加载的专家与 RoleId 冲突
   */
  async ensureLoaded(category: DomainCategory): Promise<void> {
    // 1. 已加载完成，直接返回（快速路径）
    if (this.loadedCategories.has(category)) {
      return;
    }

    // 2. 已有 in-flight Promise，复用（避免并发重复加载）
    const inFlight = this.loadingPromises.get(category);
    if (inFlight) {
      await inFlight;
      return;
    }

    // 3. 创建新的 in-flight Promise
    const promise = this.loadByCategoryInternal(category);
    this.loadingPromises.set(category, promise);

    try {
      await promise;
      // 成功后才标记为已加载（失败时不标记，允许后续重试）
      this.loadedCategories.add(category);
    } finally {
      // 4. 无论成功/失败，都从 in-flight 缓存移除
      //    失败时允许后续重试（loadedCategories 不会添加）
      this.loadingPromises.delete(category);
    }
  }

  /**
   * 全量加载（一次性加载所有 8 个类别）
   *
   * 使用 Promise.all 并行加载多个类别，每个类别内部仍走 ensureLoaded 的 in-flight 保护
   *
   * 性能基准（设计文档 §4.3）：
   *   - 并发 8 类别同时加载：≤ 200ms（Promise.all 并行）
   */
  async loadAll(): Promise<void> {
    const allCategories: DomainCategory[] = [
      "product",
      "project-management",
      "strategy",
      "support",
      "specialized",
      "academic",
      "marketing",
      "sales",
    ];
    await Promise.all(allCategories.map((c) => this.ensureLoaded(c)));
  }

  /**
   * 内部加载实现（按类别动态 import 对应 experts 文件）
   *
   * 实现细节：
   *   1. 优先使用构造函数注入的 categoryLoaders（用于测试注入真实加载函数）
   *   2. 否则使用动态 import() 加载对应类别的 experts 文件
   *      - product → import("./domain-experts/product-experts.js")
   *      - strategy → import("./domain-experts/strategy-experts.js")
   *      - ...
   *   3. 调用文件导出的 register(registry) 函数注册
   *   4. 注册失败抛出 DomainExpertAlreadyRegisteredError（由 ensureLoaded 的 finally 处理）
   *
   * @param category 业务类别
   * @throws {DomainExpertCategoryUnknownError} 当 category 不在 moduleMap 中
   */
  private async loadByCategoryInternal(category: DomainCategory): Promise<void> {
    // 优先使用注入的加载器（测试场景）
    if (this.categoryLoaders) {
      const loader = this.categoryLoaders[category];
      if (!loader) {
        throw new DomainExpertCategoryUnknownError(category);
      }
      const mod = await loader();
      mod.register(this);
      return;
    }

    // 默认：动态 import 对应类别的 experts 文件
    const moduleMap: Record<DomainCategory, () => Promise<{ register: (r: DomainExpertRegistry) => void }>> = {
      product: () => import("./domain-experts/product-experts.js"),
      "project-management": () => import("./domain-experts/project-management-experts.js"),
      strategy: () => import("./domain-experts/strategy-experts.js"),
      support: () => import("./domain-experts/support-experts.js"),
      specialized: () => import("./domain-experts/specialized-experts.js"),
      academic: () => import("./domain-experts/academic-experts.js"),
      marketing: () => import("./domain-experts/marketing-experts.js"),
      sales: () => import("./domain-experts/sales-experts.js"),
    };
    const loader = moduleMap[category];
    if (!loader) {
      throw new DomainExpertCategoryUnknownError(category);
    }
    const mod = await loader();
    mod.register(this);
  }
}
