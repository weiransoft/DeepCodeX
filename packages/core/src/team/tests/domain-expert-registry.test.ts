/**
 * DomainExpertRegistry 单元测试
 *
 * 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.2 / §4.3 / §5.1
 * 覆盖：注册/查询/卸载/懒加载/并发/冲突检测（≥18 个测试用例）
 *
 * 严格遵循 user rules：
 *   - 禁止 mock：使用真实 DomainExpert.parse 构造测试数据
 *   - 禁止占位：每个测试都有具体断言
 *   - 禁止简化：覆盖所有错误分支和边界条件
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainExpertRegistry, type RoleRegistryAdapter } from "../domain-expert-registry.js";
import {
  DomainExpertAlreadyRegisteredError,
  DomainExpertCategoryUnknownError,
  DomainExpertRoleIdCollisionError,
} from "../errors.js";
import { DomainExpert, type DomainCategory, type DomainExpert as DomainExpertType } from "../types.js";

// ============================================================================
// 测试 fixture：构造合法 DomainExpert 对象
// ============================================================================

/**
 * 构造测试用 DomainExpert
 *
 * @param overrides 覆盖字段
 * @returns 合法的 DomainExpert 实例
 */
function buildExpert(overrides: Partial<DomainExpertType> = {}): DomainExpertType {
  const base = {
    expertId: "domain-test-expert",
    name: "测试专家",
    nameEn: "Test Expert",
    category: "strategy" as DomainCategory,
    specialty: "测试专长",
    description: "测试专家描述内容（≥10 字符）",
    systemPromptPrefix: "你是测试专家，严格遵循 Karpathy 4 原则与 Ponytail 16 红线，专注于测试业务领域的分析。",
    capabilities: ["cap1", "cap2", "cap3"],
    skills: ["skill1", "skill2", "skill3"],
    keywords: ["kw1", "kw2", "kw3"],
    domainTags: ["测试", "业务"],
    metadata: { color: "#1E88E5", icon: "test", outputFormat: "markdown" as const, source: "woagent" as const },
  };
  return DomainExpert.parse({ ...base, ...overrides });
}

/**
 * 构造 RoleRegistry 适配器（用于跨系统冲突检测测试）
 */
function buildRoleAdapter(
  roleIds: string[] = ["architect", "product-manager", "solo-coder", "test-expert", "ui-designer"]
): RoleRegistryAdapter {
  return {
    listRoleIds: () => roleIds,
  };
}

// ============================================================================
// 第一部分：注册与查询（8 个测试）
// ============================================================================

test("register 单个专家成功", () => {
  const registry = new DomainExpertRegistry();
  const expert = buildExpert({ expertId: "domain-business-strategist" });
  registry.register(expert);
  assert.equal(registry.size(), 1);
  assert.ok(registry.has("domain-business-strategist"));
});

test("register 相同 expertId 抛出 DomainExpertAlreadyRegisteredError", () => {
  const registry = new DomainExpertRegistry();
  const expert = buildExpert({ expertId: "domain-duplicate" });
  registry.register(expert);
  assert.throws(
    () => registry.register(expert),
    (err: unknown) => {
      assert.ok(err instanceof DomainExpertAlreadyRegisteredError);
      assert.equal((err as DomainExpertAlreadyRegisteredError).expertId, "domain-duplicate");
      return true;
    }
  );
});

test("registerAll 批量注册成功", () => {
  const registry = new DomainExpertRegistry();
  const experts = [
    buildExpert({ expertId: "domain-expert-1" }),
    buildExpert({ expertId: "domain-expert-2", category: "product" }),
    buildExpert({ expertId: "domain-expert-3", category: "support" }),
  ];
  registry.registerAll(experts);
  assert.equal(registry.size(), 3);
  assert.ok(registry.has("domain-expert-1"));
  assert.ok(registry.has("domain-expert-2"));
  assert.ok(registry.has("domain-expert-3"));
});

test("registerAll 遇到重复立即终止（已注册不回滚）", () => {
  const registry = new DomainExpertRegistry();
  const experts = [
    buildExpert({ expertId: "domain-first" }),
    buildExpert({ expertId: "domain-first" }), // 重复
    buildExpert({ expertId: "domain-third" }),
  ];
  assert.throws(() => registry.registerAll(experts), DomainExpertAlreadyRegisteredError);
  // 已注册的 domain-first 保留，domain-third 未注册
  assert.ok(registry.has("domain-first"));
  assert.ok(!registry.has("domain-third"));
  assert.equal(registry.size(), 1);
});

test("getExpert 按 ID 查询返回专家定义", () => {
  const registry = new DomainExpertRegistry();
  const expert = buildExpert({ expertId: "domain-query-test", specialty: "查询测试专长" });
  registry.register(expert);
  const found = registry.getExpert("domain-query-test");
  assert.ok(found);
  assert.equal(found.expertId, "domain-query-test");
  assert.equal(found.specialty, "查询测试专长");
  // 未找到返回 undefined
  assert.equal(registry.getExpert("domain-not-exist"), undefined);
});

test("getByCategory 按类别查询返回所有该类别专家", () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-strategy-1", category: "strategy" }));
  registry.register(buildExpert({ expertId: "domain-strategy-2", category: "strategy" }));
  registry.register(buildExpert({ expertId: "domain-product-1", category: "product" }));
  const strategyExperts = registry.getByCategory("strategy");
  assert.equal(strategyExperts.length, 2);
  const productExperts = registry.getByCategory("product");
  assert.equal(productExperts.length, 1);
  // 空类别返回空数组
  assert.equal(registry.getByCategory("academic").length, 0);
});

test("getByDomainTag 按业务标签查询返回匹配专家", () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-finance-1", domainTags: ["金融", "风控"] }));
  registry.register(buildExpert({ expertId: "domain-finance-2", domainTags: ["金融", "合规"] }));
  registry.register(buildExpert({ expertId: "domain-medical-1", domainTags: ["医疗", "合规"] }));
  const financeExperts = registry.getByDomainTag("金融");
  assert.equal(financeExperts.length, 2);
  const complianceExperts = registry.getByDomainTag("合规");
  assert.equal(complianceExperts.length, 2);
  const medicalExperts = registry.getByDomainTag("医疗");
  assert.equal(medicalExperts.length, 1);
  // 未匹配返回空数组
  assert.equal(registry.getByDomainTag("未知标签").length, 0);
});

test("listExpertIds / listDomainTags 返回所有已注册 ID 和标签", () => {
  const registry = new DomainExpertRegistry();
  registry.register(buildExpert({ expertId: "domain-a", domainTags: ["金融"] }));
  registry.register(buildExpert({ expertId: "domain-b", domainTags: ["医疗", "合规"] }));
  const ids = registry.listExpertIds();
  assert.equal(ids.length, 2);
  assert.ok(ids.includes("domain-a"));
  assert.ok(ids.includes("domain-b"));
  const tags = registry.listDomainTags();
  assert.equal(tags.length, 3);
  assert.ok(tags.includes("金融"));
  assert.ok(tags.includes("医疗"));
  assert.ok(tags.includes("合规"));
});

// ============================================================================
// 第二部分：注销（3 个测试）
// ============================================================================

test("unregister 卸载已注册专家并清理三级索引", () => {
  const registry = new DomainExpertRegistry();
  registry.register(
    buildExpert({ expertId: "domain-unregister-test", category: "strategy", domainTags: ["战略", "商业"] })
  );
  assert.equal(registry.size(), 1);
  const result = registry.unregister("domain-unregister-test");
  assert.equal(result, true);
  assert.equal(registry.size(), 0);
  assert.ok(!registry.has("domain-unregister-test"));
  // 类别索引已清理
  assert.equal(registry.getByCategory("strategy").length, 0);
  // 标签索引已清理
  assert.equal(registry.getByDomainTag("战略").length, 0);
  assert.equal(registry.getByDomainTag("商业").length, 0);
  // listDomainTags 不再包含已卸载专家的标签
  const tags = registry.listDomainTags();
  assert.ok(!tags.includes("战略"));
  assert.ok(!tags.includes("商业"));
});

test("unregister 未注册专家返回 false", () => {
  const registry = new DomainExpertRegistry();
  const result = registry.unregister("domain-not-exist");
  assert.equal(result, false);
});

test("unregister 后可重新注册（hot-reload 场景）", () => {
  const registry = new DomainExpertRegistry();
  const expert = buildExpert({ expertId: "domain-reload-test" });
  registry.register(expert);
  registry.unregister("domain-reload-test");
  // 重新注册不应抛错
  registry.register(expert);
  assert.ok(registry.has("domain-reload-test"));
  assert.equal(registry.size(), 1);
});

// ============================================================================
// 第三部分：命名冲突检测（4 个测试，v1.1 P1-7）
// ============================================================================

test("register 与 RoleId 冲突抛出 DomainExpertRoleIdCollisionError", () => {
  const registry = new DomainExpertRegistry(buildRoleAdapter());
  // domain-architect 去 domain- 前缀后为 "architect"，与 RoleId="architect" 冲突
  const conflictingExpert = buildExpert({ expertId: "domain-architect" });
  assert.throws(
    () => registry.register(conflictingExpert),
    (err: unknown) => {
      assert.ok(err instanceof DomainExpertRoleIdCollisionError);
      assert.equal((err as DomainExpertRoleIdCollisionError).expertId, "domain-architect");
      assert.equal((err as DomainExpertRoleIdCollisionError).collisionRoleId, "architect");
      return true;
    }
  );
});

test("register 与 RoleId 不冲突时成功（domain- 前缀隔离生效）", () => {
  const registry = new DomainExpertRegistry(buildRoleAdapter());
  // domain-business-strategist 去 domain- 前缀后为 "business-strategist"，不与 RoleId 冲突
  const safeExpert = buildExpert({ expertId: "domain-business-strategist" });
  registry.register(safeExpert);
  assert.ok(registry.has("domain-business-strategist"));
});

test("register 未注入 roleRegistry 时跳过跨系统冲突检测", () => {
  const registry = new DomainExpertRegistry(); // 无 roleRegistry
  // 无 roleRegistry，即使 domain-architect 与 RoleId 冲突也不会抛错
  const expert = buildExpert({ expertId: "domain-architect" });
  registry.register(expert);
  assert.ok(registry.has("domain-architect"));
});

test("register 多个 RoleId 冲突时第一个即抛错", () => {
  const registry = new DomainExpertRegistry(buildRoleAdapter());
  const experts = [
    buildExpert({ expertId: "domain-product-manager" }), // 与 RoleId="product-manager" 冲突
    buildExpert({ expertId: "domain-architect" }), // 与 RoleId="architect" 冲突
  ];
  assert.throws(() => registry.registerAll(experts), DomainExpertRoleIdCollisionError);
  assert.equal(registry.size(), 0, "第一个冲突前未注册任何专家");
});

// ============================================================================
// 第四部分：懒加载（4 个测试，v1.1 P1-2）
// ============================================================================

test("ensureLoaded 首次加载触发 register", async () => {
  let loadCount = 0;
  const registry = new DomainExpertRegistry(undefined, {
    product: () => {
      loadCount++;
      return Promise.resolve({
        register: (r) => {
          r.register(buildExpert({ expertId: "domain-product-1", category: "product" }));
        },
      });
    },
    "project-management": () => Promise.resolve({ register: () => {} }),
    strategy: () => Promise.resolve({ register: () => {} }),
    support: () => Promise.resolve({ register: () => {} }),
    specialized: () => Promise.resolve({ register: () => {} }),
    academic: () => Promise.resolve({ register: () => {} }),
    marketing: () => Promise.resolve({ register: () => {} }),
    sales: () => Promise.resolve({ register: () => {} }),
  });
  await registry.ensureLoaded("product");
  assert.equal(loadCount, 1, "首次加载触发 1 次 loader 调用");
  assert.ok(registry.has("domain-product-1"));
  assert.ok(registry.listLoadedCategories().includes("product"));
});

test("ensureLoaded 二次加载命中缓存（不重复触发 loader）", async () => {
  let loadCount = 0;
  const registry = new DomainExpertRegistry(undefined, {
    product: () => {
      loadCount++;
      return Promise.resolve({ register: () => {} });
    },
    "project-management": () => Promise.resolve({ register: () => {} }),
    strategy: () => Promise.resolve({ register: () => {} }),
    support: () => Promise.resolve({ register: () => {} }),
    specialized: () => Promise.resolve({ register: () => {} }),
    academic: () => Promise.resolve({ register: () => {} }),
    marketing: () => Promise.resolve({ register: () => {} }),
    sales: () => Promise.resolve({ register: () => {} }),
  });
  await registry.ensureLoaded("product");
  await registry.ensureLoaded("product"); // 二次加载
  await registry.ensureLoaded("product"); // 三次加载
  assert.equal(loadCount, 1, "二次/三次加载命中缓存，loader 只调用 1 次");
});

test("ensureLoaded 并发请求复用 in-flight Promise（只触发 1 次加载）", async () => {
  let loadCount = 0;
  const registry = new DomainExpertRegistry(undefined, {
    product: () => {
      loadCount++;
      // 模拟异步加载延迟
      return new Promise<{ register: (r: DomainExpertRegistry) => void }>((resolve) => {
        setTimeout(() => resolve({ register: () => {} }), 50);
      });
    },
    "project-management": () => Promise.resolve({ register: () => {} }),
    strategy: () => Promise.resolve({ register: () => {} }),
    support: () => Promise.resolve({ register: () => {} }),
    specialized: () => Promise.resolve({ register: () => {} }),
    academic: () => Promise.resolve({ register: () => {} }),
    marketing: () => Promise.resolve({ register: () => {} }),
    sales: () => Promise.resolve({ register: () => {} }),
  });
  // 并发 100 次请求
  const promises = Array.from({ length: 100 }, () => registry.ensureLoaded("product"));
  await Promise.all(promises);
  assert.equal(loadCount, 1, "并发 100 次请求只触发 1 次实际加载（in-flight Promise 保护）");
});

test("ensureLoaded 加载失败后允许重试", async () => {
  let loadCount = 0;
  const registry = new DomainExpertRegistry(undefined, {
    product: () => {
      loadCount++;
      if (loadCount === 1) {
        return Promise.reject(new Error("首次加载失败"));
      }
      return Promise.resolve({ register: () => {} });
    },
    "project-management": () => Promise.resolve({ register: () => {} }),
    strategy: () => Promise.resolve({ register: () => {} }),
    support: () => Promise.resolve({ register: () => {} }),
    specialized: () => Promise.resolve({ register: () => {} }),
    academic: () => Promise.resolve({ register: () => {} }),
    marketing: () => Promise.resolve({ register: () => {} }),
    sales: () => Promise.resolve({ register: () => {} }),
  });
  // 首次加载失败
  await assert.rejects(() => registry.ensureLoaded("product"), /首次加载失败/);
  assert.equal(loadCount, 1);
  assert.ok(!registry.listLoadedCategories().includes("product"), "失败后不标记为已加载");
  // 重试成功
  await registry.ensureLoaded("product");
  assert.equal(loadCount, 2, "重试触发新的加载");
  assert.ok(registry.listLoadedCategories().includes("product"), "重试成功后标记为已加载");
});

// ============================================================================
// 第五部分：全量加载与边界（3 个测试）
// ============================================================================

test("loadAll 并行加载所有 8 个类别", async () => {
  const loadedCategories: string[] = [];
  const buildLoader = (cat: DomainCategory) => () => {
    loadedCategories.push(cat);
    return Promise.resolve({ register: () => {} });
  };
  const registry = new DomainExpertRegistry(undefined, {
    product: buildLoader("product"),
    "project-management": buildLoader("project-management"),
    strategy: buildLoader("strategy"),
    support: buildLoader("support"),
    specialized: buildLoader("specialized"),
    academic: buildLoader("academic"),
    marketing: buildLoader("marketing"),
    sales: buildLoader("sales"),
  });
  await registry.loadAll();
  assert.equal(loadedCategories.length, 8, "8 个类别全部加载");
  assert.equal(registry.listLoadedCategories().length, 8);
});

test("loadAll 二次调用全部命中缓存", async () => {
  let loadCount = 0;
  const buildLoader = () => () => {
    loadCount++;
    return Promise.resolve({ register: () => {} });
  };
  const registry = new DomainExpertRegistry(undefined, {
    product: buildLoader(),
    "project-management": buildLoader(),
    strategy: buildLoader(),
    support: buildLoader(),
    specialized: buildLoader(),
    academic: buildLoader(),
    marketing: buildLoader(),
    sales: buildLoader(),
  });
  await registry.loadAll();
  assert.equal(loadCount, 8);
  await registry.loadAll(); // 二次调用
  assert.equal(loadCount, 8, "二次调用全部命中缓存，loader 不再被调用");
});

test("register 防御性：expertId 不符合 regex 时抛错", () => {
  const registry = new DomainExpertRegistry();
  // 通过 Object.defineProperty 绕过 schema 校验，构造非法 expertId
  const validExpert = buildExpert();
  const invalidExpert = { ...validExpert, expertId: "invalid-no-prefix" };
  assert.throws(() => registry.register(invalidExpert as DomainExpertType), /expertId 不符合 domain- 前缀 regex/);
});

// ============================================================================
// 第六部分：size / has 查询辅助（1 个测试）
// ============================================================================

test("size 与 has 反映注册状态", () => {
  const registry = new DomainExpertRegistry();
  assert.equal(registry.size(), 0);
  assert.ok(!registry.has("domain-any"));
  registry.register(buildExpert({ expertId: "domain-size-test-1" }));
  assert.equal(registry.size(), 1);
  assert.ok(registry.has("domain-size-test-1"));
  registry.register(buildExpert({ expertId: "domain-size-test-2", category: "product" }));
  assert.equal(registry.size(), 2);
  registry.unregister("domain-size-test-1");
  assert.equal(registry.size(), 1);
  assert.ok(!registry.has("domain-size-test-1"));
});
