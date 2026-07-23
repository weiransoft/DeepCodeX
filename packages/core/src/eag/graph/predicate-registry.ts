/**
 * 谓词注册表实现（v2.0 新增）
 *
 * 本模块提供 PredicateRegistry 接口的具体实现，替代设计文档 v1.0 中的 `fn:` 表达式语法，
 * 消除远程代码执行（RCE）风险，同时支持运行时动态注册谓词函数。
 *
 * 设计要点：
 * - 使用 Map<string, PredicateFunction> 存储谓词函数，O(1) 查询性能
 * - register() 重复注册抛错（避免覆盖已有谓词，防止意外行为变更）
 * - lookup() 未注册抛错（避免静默失败，让调用方及早发现问题）
 * - 提供 list() 扩展方法用于审计和测试（返回所有已注册 ID 的只读快照）
 * - 提供 clear() 扩展方法用于测试重置（生产环境不建议使用）
 *
 * 安全保证：
 * - 所有谓词函数必须是用户显式注册的 JavaScript/TypeScript 函数，
 *   不接受字符串表达式，不使用 new Function() / eval() 求值
 * - 谓词函数在执行时接收 input 和 context 两个只读参数，
 *   无法修改图级状态（除非通过 context.globalState 显式写入，但这会被 GraphGuard 检测）
 *
 * @module eag/graph/predicate-registry
 */

import type { PredicateFunction, PredicateRegistry } from "./graph-loop-models";

/**
 * 谓词注册表实现类
 *
 * 实现 PredicateRegistry 接口，提供谓词函数的注册、查询、检查功能。
 *
 * 使用示例：
 * ```typescript
 * const registry = new PredicateRegistryImpl();
 *
 * // 注册决策谓词（返回下游边 ID）
 * registry.register("chooseBranch", (input, ctx) => {
 *   return input.score >= 80 ? "edge-to-fast-path" : "edge-to-slow-path";
 * });
 *
 * // 注册边激活谓词（返回 boolean）
 * registry.register("isHighPriority", (input, ctx) => {
 *   return input.priority === "high";
 * });
 *
 * // 在图定义中引用
 * const node: GraphNodeDef = {
 *   nodeId: "decision-1",
 *   nodeType: "decision",
 *   decisionPredicateId: "chooseBranch",  // 引用注册的谓词
 *   // ... 其他字段
 * };
 *
 * // 查询谓词（未注册时抛错）
 * const fn = registry.lookup("chooseBranch");
 * const result = fn({ score: 90 }, ctx);  // 返回 "edge-to-fast-path"
 * ```
 */
export class PredicateRegistryImpl implements PredicateRegistry {
  /**
   * 谓词函数存储表
   *
   * key = 谓词 ID（字符串，由调用方保证唯一性）
   * value = 谓词函数（PredicateFunction 签名）
   *
   * 使用 Map 而非 Object，避免原型链污染和键名冲突（如 "toString" / "hasOwnProperty"）。
   */
  private readonly predicates: Map<string, PredicateFunction> = new Map();

  /**
   * 注册谓词函数
   *
   * 将谓词函数以指定 ID 注册到表中，供后续 lookup 查询。
   *
   * @param id 谓词 ID（在图定义中通过 decisionPredicateId / activationPredicateId 引用）
   * @param predicate 谓词函数（签名：(input, context) => string | boolean）
   * @throws {Error} 当 id 为空字符串、非字符串，或 id 已存在时抛出
   * @throws {Error} 当 predicate 不是函数时抛出
   */
  register(id: string, predicate: PredicateFunction): void {
    // 参数校验：id 必须是非空字符串
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`PredicateRegistry.register: id 必须是非空字符串，实际类型=${typeof id}，实际值=${String(id)}`);
    }
    // 参数校验：predicate 必须是函数
    if (typeof predicate !== "function") {
      throw new Error(`PredicateRegistry.register: predicate 必须是函数，实际类型=${typeof predicate}，id=${id}`);
    }
    // 重复注册检查：避免覆盖已有谓词（防止意外行为变更）
    if (this.predicates.has(id)) {
      throw new Error(
        `PredicateRegistry.register: 谓词 ID 已存在，禁止覆盖注册，id=${id}。如需替换请先调用 clear() 清空或使用不同 ID。`
      );
    }

    this.predicates.set(id, predicate);
  }

  /**
   * 查询谓词函数
   *
   * 根据谓词 ID 查询已注册的谓词函数。
   *
   * @param id 谓词 ID
   * @returns 谓词函数
   * @throws {Error} 当 id 未注册时抛出（避免静默失败，让调用方及早发现配置错误）
   */
  lookup(id: string): PredicateFunction {
    const predicate = this.predicates.get(id);
    if (predicate === undefined) {
      // 未注册时抛错，列出所有已注册 ID 帮助调试
      const registeredIds = this.list().join(", ");
      throw new Error(
        `PredicateRegistry.lookup: 谓词 ID 未注册，id=${id}。当前已注册谓词：[${registeredIds || "<空>"}]`
      );
    }
    return predicate;
  }

  /**
   * 检查谓词是否已注册
   *
   * @param id 谓词 ID
   * @returns 是否已注册（true=已注册，false=未注册）
   */
  has(id: string): boolean {
    return this.predicates.has(id);
  }

  /**
   * 列出所有已注册的谓词 ID（扩展方法，用于审计和测试）
   *
   * 返回新数组，避免外部修改内部 Map 的键视图。
   *
   * @returns 已注册谓词 ID 列表（按注册顺序，无重复）
   */
  list(): string[] {
    return Array.from(this.predicates.keys());
  }

  /**
   * 清空注册表（扩展方法，用于测试重置）
   *
   * ⚠️ 警告：此方法会清空所有已注册的谓词，仅用于测试场景。
   * 生产环境请勿调用，否则会导致图执行时谓词查询全部失败。
   */
  clear(): void {
    this.predicates.clear();
  }

  /**
   * 获取已注册谓词数量（扩展方法，用于审计和测试）
   *
   * @returns 已注册谓词数量
   */
  size(): number {
    return this.predicates.size;
  }
}

/**
 * 创建空的谓词注册表（工厂函数）
 *
 * 提供工厂函数便于未来扩展（如添加日志、监控等装饰器），
 * 调用方无需直接 new PredicateRegistryImpl()。
 *
 * @returns 新的 PredicateRegistry 实例（实现类为 PredicateRegistryImpl）
 */
export function createPredicateRegistry(): PredicateRegistry {
  return new PredicateRegistryImpl();
}
