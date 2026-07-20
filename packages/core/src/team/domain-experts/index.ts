/**
 * 领域专家 barrel 导出（domain-experts/index.ts）
 *
 * 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.5 文件结构 + P2-NEW-3
 *
 * v1.1 P2-NEW-3：barrel 导出与懒加载交互说明
 *   - 不使用 `export * from "./product-experts.js"` 这种静态 re-export
 *   - 原因：静态 re-export 会被 bundler 打包为同步 import 链，破坏 §4.3 的懒加载
 *   - 解决方案：index.ts 仅导出类型和 registerAllExperts() 函数（内部使用动态 import）
 *   - 真正的加载由 DomainExpertRegistry.ensureLoaded(category) 触发动态 import()
 *   - 这样既保持 barrel 导出的便利性，又不破坏懒加载
 *
 * 严格遵循 user rules：
 *   - 禁止 mock/占位/简化：所有 30 个专家定义真实可加载
 *   - 中文注释 + 详细说明
 */

import type { DomainExpert } from "../types.js";
import type { DomainExpertRegistry } from "../domain-expert-registry.js";

// ============================================================================
// 第一部分：类型再导出（便于外部统一从 domain-experts/index.js 导入）
// ============================================================================

export type { DomainExpert, DomainCategory } from "../types.js";

// ============================================================================
// 第二部分：registerAllExperts 函数（全量注册 30 个专家）
// ============================================================================

/**
 * 全量注册 30 个领域专家到 DomainExpertRegistry
 *
 * 使用场景：
 *   - 测试场景：需要一次性加载所有专家用于验证
 *   - 启动场景：若配置 enableDomainExperts=true 且 enabledCategories 为空（全量启用），
 *     可调用此函数一次性注册（牺牲懒加载换启动时确定状态）
 *
 * 注意：
 *   - 生产环境推荐使用 DomainExpertRegistry.ensureLoaded(category) / loadAll() 懒加载
 *   - 此函数内部使用动态 import() 触发 8 个文件的并行加载
 *   - 8 个文件之间的 dependsOn 关系由 DomainExpertRegistry.register 仅检查 ID 重复，
 *     不校验 dependsOn 存在性；运行时解析由 DomainExpertMatcher / ReviewPlugin 负责
 *
 * @param registry 领域专家注册中心
 * @throws {DomainExpertAlreadyRegisteredError} 当 expertId 已注册时
 * @throws {DomainExpertRoleIdCollisionError} 当 expertId 与 RoleId 冲突时
 */
export async function registerAllExperts(registry: DomainExpertRegistry): Promise<void> {
  // 并行加载 8 个类别的专家文件
  // 每个文件导出 register(registry) 函数，调用后完成注册
  const modules = await Promise.all([
    import("./product-experts.js"),
    import("./project-management-experts.js"),
    import("./strategy-experts.js"),
    import("./support-experts.js"),
    import("./specialized-experts.js"),
    import("./academic-experts.js"),
    import("./marketing-experts.js"),
    import("./sales-experts.js"),
  ]);

  // 顺序调用每个模块的 register 函数
  // 顺序原因：避免并发的 register 操作触发 DomainExpertAlreadyRegisteredError
  // （虽然 Node.js 单线程不会真正并发，但 register 是同步操作，顺序调用更清晰）
  for (const mod of modules) {
    mod.register(registry);
  }
}

// ============================================================================
// 第三部分：专家定义只读导出（供调试 / 监控 / 文档生成使用）
// ============================================================================

/**
 * 重新导出 8 个类别的专家定义数组
 *
 * 用途：
 *   - 测试场景直接访问专家定义（无需通过 registry）
 *   - 文档生成工具枚举所有专家
 *   - 监控面板展示已注册专家清单
 *
 * 注意：这些导出会触发静态 import 链（bundler 同步加载所有 8 个文件）。
 *      生产环境运行时不应使用此导出，应通过 DomainExpertRegistry.ensureLoaded() 懒加载。
 */
export { productExperts } from "./product-experts.js";
export { projectManagementExperts } from "./project-management-experts.js";
export { strategyExperts } from "./strategy-experts.js";
export { supportExperts } from "./support-experts.js";
export { specializedExperts } from "./specialized-experts.js";
export { academicExperts } from "./academic-experts.js";
export { marketingExperts } from "./marketing-experts.js";
export { salesExperts } from "./sales-experts.js";

// ============================================================================
// 第四部分：常量导出（供 DomainExpertRegistry 验证总数）
// ============================================================================

/**
 * 领域专家总数（设计文档 §2.2 共 30 个）
 *
 * 4 (product) + 3 (project-management) + 4 (strategy) + 4 (support) +
 * 5 (specialized) + 4 (academic) + 5 (marketing) + 1 (sales) = 30
 *
 * 用途：DomainExpertRegistry.loadAll() 后可校验 size() === EXPECTED_TOTAL_EXPERTS
 */
export const EXPECTED_TOTAL_EXPERTS = 30;

/**
 * 8 个业务类别常量
 *
 * 与 types.ts DomainCategory enum 一一对应。
 * 单独导出数组形式，便于 registerAllExperts / loadAll 遍历。
 */
export const ALL_DOMAIN_CATEGORIES = [
  "product",
  "project-management",
  "strategy",
  "support",
  "specialized",
  "academic",
  "marketing",
  "sales",
] as const;
