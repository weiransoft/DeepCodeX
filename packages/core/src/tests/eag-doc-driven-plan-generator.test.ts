/**
 * EAG-P2 批次 8 单元测试：plan.md 生成器
 *
 * 测试范围：
 * - T1. PlanGenerator 实例化
 * - T2. 完整输入 → 生成 5 章节 Markdown
 *   - T2a. 含"# 实现方案（plan.md）"标题
 *   - T2b. 含"## 1. 实现方案"章节
 *   - T2c. 含"## 2. 模块切分"章节
 *   - T2d. 含"## 3. 接口契约"章节
 *   - T2e. 含"## 4. 数据迁移"章节
 *   - T2f. 含"## 5. 风险与回退"章节
 * - T3. 技术栈清单渲染
 * - T4. 模块切分渲染（含依赖与关键文件）
 * - T5. 接口契约渲染（含签名与错误码）
 * - T6. 数据迁移表格渲染
 * - T7. 风险与回退表格渲染
 * - T8. 入参校验
 *   - T8a. specContent 为空 → 抛 PlanGeneratorError
 *   - T8b. constitutionContent 为空 → 抛 PlanGeneratorError
 *   - T8c. moduleSplits 非数组 → 抛 PlanGeneratorError
 *   - T8d. moduleSplits[0].moduleName 为空 → 抛 PlanGeneratorError
 *   - T8e. interfaceContracts[0].interfaceName 为空 → 抛 PlanGeneratorError
 *   - T8f. dataMigrations[0].migrationId 为空 → 抛 PlanGeneratorError
 *   - T8g. risks[0].riskId 为空 → 抛 PlanGeneratorError
 *   - T8h. techStack 非数组 → 抛 PlanGeneratorError
 * - T9. 空数组输入（合法）→ 生成空章节占位
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 *
 * @module core/tests/eag-doc-driven-plan-generator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanGenerator, PlanGeneratorError } from "../eag/doc-driven/plan-generator";
import type {
  DataMigration,
  InterfaceContract,
  ModuleSplit,
  PlanGenerationInput,
  RiskItem,
} from "../eag/doc-driven/types";

// ============================================================================
// 辅助函数：构造 PlanGenerationInput
// ============================================================================

/**
 * 构造完整的 PlanGenerationInput（含全部字段）
 *
 * @param overrides 覆盖字段
 * @returns 完整的 PlanGenerationInput
 */
function createInput(overrides: Partial<PlanGenerationInput> = {}): PlanGenerationInput {
  return {
    specContent: "# 功能需求规格\n## F-001 用户登录\n用户登录功能...",
    constitutionContent: "# 项目宪法\n## 不可协商项\n- 技术栈：TypeScript",
    moduleSplits: [
      {
        moduleName: "UserAggregate",
        responsibility: "用户认证与权限管理",
        dependsOn: [],
        keyFiles: ["src/domain/UserAggregate.ts"],
      },
      {
        moduleName: "OrderService",
        responsibility: "订单管理",
        dependsOn: ["UserAggregate"],
        keyFiles: ["src/services/OrderService.ts"],
      },
    ],
    interfaceContracts: [
      {
        interfaceName: "UserService.login",
        type: "service-method",
        signature: "login(email: string, password: string): Promise<AuthToken>",
        description: "用户登录方法",
        errorCodes: ["400 InvalidEmail", "401 Unauthorized"],
      },
      {
        interfaceName: "OrderController.create",
        type: "rest-api",
        signature: "POST /api/orders",
        description: "创建订单 API",
        requestSchema: '{"type":"object"}',
        responseSchema: '{"type":"object"}',
        errorCodes: ["400 BadRequest", "500 InternalError"],
      },
    ],
    dataMigrations: [
      {
        migrationId: "20260720000000_create_users",
        changeType: "create-table",
        tableName: "users",
        description: "创建 users 表",
        rollbackStrategy: "DROP TABLE users",
      },
      {
        migrationId: "20260720000001_add_email_index",
        changeType: "create-index",
        tableName: "users",
        description: "为 users.email 添加唯一索引",
        rollbackStrategy: "DROP INDEX idx_users_email",
      },
    ],
    risks: [
      {
        riskId: "R-001",
        description: "数据库迁移失败风险",
        severity: "high",
        mitigation: "迁移前备份 + 灰度执行",
        rollbackPlan: "回滚到上一个迁移版本",
      },
      {
        riskId: "R-002",
        description: "JWT 密钥泄漏风险",
        severity: "medium",
        mitigation: "密钥定期轮换",
        rollbackPlan: "撤销已颁发 token",
      },
    ],
    techStack: ["TypeScript", "NestJS", "PostgreSQL", "Redis"],
    ...overrides,
  };
}

// ============================================================================
// T1. PlanGenerator 实例化
// ============================================================================

test("T1. PlanGenerator 实例化成功", () => {
  const generator = new PlanGenerator();
  assert.ok(generator instanceof PlanGenerator);
  assert.equal(typeof generator.generate, "function");
});

// ============================================================================
// T2. 完整输入 → 生成 5 章节 Markdown
// ============================================================================

test("T2a. 含 # 实现方案（plan.md）标题", () => {
  const generator = new PlanGenerator();
  const md = generator.generate(createInput());
  assert.ok(md.includes("# 实现方案（plan.md）"));
});

test("T2b. 含 ## 1. 实现方案 章节", () => {
  const generator = new PlanGenerator();
  const md = generator.generate(createInput());
  assert.ok(md.includes("## 1. 实现方案"));
});

test("T2c. 含 ## 2. 模块切分 章节", () => {
  const generator = new PlanGenerator();
  const md = generator.generate(createInput());
  assert.ok(md.includes("## 2. 模块切分"));
});

test("T2d. 含 ## 3. 接口契约 章节", () => {
  const generator = new PlanGenerator();
  const md = generator.generate(createInput());
  assert.ok(md.includes("## 3. 接口契约"));
});

test("T2e. 含 ## 4. 数据迁移 章节", () => {
  const generator = new PlanGenerator();
  const md = generator.generate(createInput());
  assert.ok(md.includes("## 4. 数据迁移"));
});

test("T2f. 含 ## 5. 风险与回退 章节", () => {
  const generator = new PlanGenerator();
  const md = generator.generate(createInput());
  assert.ok(md.includes("## 5. 风险与回退"));
});

// ============================================================================
// T3. 技术栈清单渲染
// ============================================================================

test("T3. 技术栈清单渲染（含 TypeScript / NestJS）", () => {
  const generator = new PlanGenerator();
  const md = generator.generate(createInput());
  assert.ok(md.includes("TypeScript"));
  assert.ok(md.includes("NestJS"));
  assert.ok(md.includes("PostgreSQL"));
});

// ============================================================================
// T4. 模块切分渲染（含依赖与关键文件）
// ============================================================================

test("T4. 模块切分渲染（含模块名 / 职责 / 依赖 / 关键文件）", () => {
  const generator = new PlanGenerator();
  const md = generator.generate(createInput());
  assert.ok(md.includes("UserAggregate"));
  assert.ok(md.includes("用户认证与权限管理"));
  assert.ok(md.includes("OrderService"));
  assert.ok(md.includes("src/domain/UserAggregate.ts"));
});

// ============================================================================
// T5. 接口契约渲染（含签名与错误码）
// ============================================================================

test("T5. 接口契约渲染（含接口名 / 签名 / 错误码）", () => {
  const generator = new PlanGenerator();
  const md = generator.generate(createInput());
  assert.ok(md.includes("UserService.login"));
  assert.ok(md.includes("login(email: string, password: string): Promise<AuthToken>"));
  assert.ok(md.includes("400 InvalidEmail"));
  assert.ok(md.includes("401 Unauthorized"));
});

// ============================================================================
// T6. 数据迁移表格渲染
// ============================================================================

test("T6. 数据迁移表格渲染（含迁移 ID / 表名 / 回滚策略）", () => {
  const generator = new PlanGenerator();
  const md = generator.generate(createInput());
  assert.ok(md.includes("20260720000000_create_users"));
  assert.ok(md.includes("users"));
  assert.ok(md.includes("DROP TABLE users"));
  assert.ok(md.includes("建表")); // 中文映射
});

// ============================================================================
// T7. 风险与回退表格渲染
// ============================================================================

test("T7. 风险与回退表格渲染（含风险 ID / 严重性 / 回退方案）", () => {
  const generator = new PlanGenerator();
  const md = generator.generate(createInput());
  assert.ok(md.includes("R-001"));
  assert.ok(md.includes("数据库迁移失败风险"));
  assert.ok(md.includes("回滚到上一个迁移版本"));
  assert.ok(md.includes("高")); // 严重性中文映射
});

// ============================================================================
// T8. 入参校验
// ============================================================================

test("T8a. specContent 为空 → 抛 PlanGeneratorError", () => {
  const generator = new PlanGenerator();
  assert.throws(
    () => generator.generate(createInput({ specContent: "" })),
    (err: unknown) => {
      assert.ok(err instanceof PlanGeneratorError);
      assert.equal((err as PlanGeneratorError).field, "specContent");
      return true;
    }
  );
});

test("T8b. constitutionContent 为空 → 抛 PlanGeneratorError", () => {
  const generator = new PlanGenerator();
  assert.throws(
    () => generator.generate(createInput({ constitutionContent: "" })),
    (err: unknown) => {
      assert.ok(err instanceof PlanGeneratorError);
      assert.equal((err as PlanGeneratorError).field, "constitutionContent");
      return true;
    }
  );
});

test("T8c. moduleSplits 非数组 → 抛 PlanGeneratorError", () => {
  const generator = new PlanGenerator();
  assert.throws(
    () => generator.generate(createInput({ moduleSplits: "not-array" as unknown as ModuleSplit[] })),
    (err: unknown) => {
      assert.ok(err instanceof PlanGeneratorError);
      assert.equal((err as PlanGeneratorError).field, "moduleSplits");
      return true;
    }
  );
});

test("T8d. moduleSplits[0].moduleName 为空 → 抛 PlanGeneratorError", () => {
  const generator = new PlanGenerator();
  const badSplits: ModuleSplit[] = [
    {
      moduleName: "",
      responsibility: "x",
      dependsOn: [],
      keyFiles: [],
    },
  ];
  assert.throws(
    () => generator.generate(createInput({ moduleSplits: badSplits })),
    (err: unknown) => {
      assert.ok(err instanceof PlanGeneratorError);
      assert.ok((err as PlanGeneratorError).field.includes("moduleSplits[0].moduleName"));
      return true;
    }
  );
});

test("T8e. interfaceContracts[0].interfaceName 为空 → 抛 PlanGeneratorError", () => {
  const generator = new PlanGenerator();
  const badContracts: InterfaceContract[] = [
    {
      interfaceName: "",
      type: "service-method",
      signature: "x()",
      description: "x",
      errorCodes: [],
    },
  ];
  assert.throws(
    () => generator.generate(createInput({ interfaceContracts: badContracts })),
    (err: unknown) => {
      assert.ok(err instanceof PlanGeneratorError);
      assert.ok((err as PlanGeneratorError).field.includes("interfaceContracts[0].interfaceName"));
      return true;
    }
  );
});

test("T8f. dataMigrations[0].migrationId 为空 → 抛 PlanGeneratorError", () => {
  const generator = new PlanGenerator();
  const badMigrations: DataMigration[] = [
    {
      migrationId: "",
      changeType: "create-table",
      tableName: "users",
      description: "x",
      rollbackStrategy: "x",
    },
  ];
  assert.throws(
    () => generator.generate(createInput({ dataMigrations: badMigrations })),
    (err: unknown) => {
      assert.ok(err instanceof PlanGeneratorError);
      assert.ok((err as PlanGeneratorError).field.includes("dataMigrations[0].migrationId"));
      return true;
    }
  );
});

test("T8g. risks[0].riskId 为空 → 抛 PlanGeneratorError", () => {
  const generator = new PlanGenerator();
  const badRisks: RiskItem[] = [
    {
      riskId: "",
      description: "x",
      severity: "high",
      mitigation: "x",
      rollbackPlan: "x",
    },
  ];
  assert.throws(
    () => generator.generate(createInput({ risks: badRisks })),
    (err: unknown) => {
      assert.ok(err instanceof PlanGeneratorError);
      assert.ok((err as PlanGeneratorError).field.includes("risks[0].riskId"));
      return true;
    }
  );
});

test("T8h. techStack 非数组 → 抛 PlanGeneratorError", () => {
  const generator = new PlanGenerator();
  assert.throws(
    () => generator.generate(createInput({ techStack: "not-array" as unknown as string[] })),
    (err: unknown) => {
      assert.ok(err instanceof PlanGeneratorError);
      assert.equal((err as PlanGeneratorError).field, "techStack");
      return true;
    }
  );
});

// ============================================================================
// T9. 空数组输入（合法）→ 生成空章节占位
// ============================================================================

test("T9. 空数组输入（合法）→ 生成空章节占位", () => {
  const generator = new PlanGenerator();
  const md = generator.generate(
    createInput({
      moduleSplits: [],
      interfaceContracts: [],
      dataMigrations: [],
      risks: [],
      techStack: [],
    })
  );
  // 空数组不应抛错
  assert.ok(md.includes("## 1. 实现方案"));
  assert.ok(md.includes("## 2. 模块切分"));
  assert.ok(md.includes("## 3. 接口契约"));
});
