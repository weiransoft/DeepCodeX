/**
 * EAG-P2 批次 9 S3 单元测试：G-4 进入门禁检查器
 *
 * 测试范围：
 * - T1. GateG4Checker 实例化与 gateId
 *   - T1a. 实例化成功
 *   - T1b. gateId 为 "G-4"
 *   - T1c. 实现 GateChecker 协议
 * - T2. 全部字段合法 → 通过
 * - T3. tasksStatus 非 approved → 失败（blocker）
 *   - T3a. tasksStatus="draft"
 *   - T3b. tasksStatus="reviewing"
 *   - T3c. tasksStatus="rejected"
 * - T4. taskCard.declaredSymbols 为空 → 失败（blocker）
 * - T5. taskCard.acceptanceCriteria 为空 → 失败（blocker）
 * - T6. fileCluster 为空 → 失败（blocker）
 * - T7. requiredTemplateKinds 为空 → 失败（blocker）
 * - T8. requiredTemplateKinds 含未注册 kind → 失败（blocker）
 * - T9. techStack 为空 → 失败（blocker）
 * - T10. outputDir 为空 → 失败（blocker）
 * - T11. 失败结果含引导消息
 * - T12. 失败结果 severity 为 blocker
 * - T13. 结果对象已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象与真实 TemplateRegistry
 *
 * @module core/tests/eag-gate-g4-checker
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GateG4Checker } from "../eag/gate/gate-g4-checker";
import type { GateChecker, GateContext, GateG4Context, GateResult } from "../eag/gate/gate-types";
import type { DocumentState } from "../eag/doc-driven/types";
import type { GeneratedFileKind } from "../eag/coding/types";
import { DEFAULT_TEMPLATE_REGISTRY } from "../eag/coding/templates/index";
import type { TemplateRegistry } from "../eag/coding/types";

// ============================================================================
// 辅助函数：构造 GateG4Context
// ============================================================================

/**
 * 构造测试用 GateG4Context（默认全部字段合法）
 *
 * @param overrides 覆盖字段
 * @returns 完整的 GateG4Context
 */
function createG4Context(overrides: Partial<GateG4Context> = {}): GateG4Context {
  // 合法的 GateG4Context 基线：所有字段满足 G-4 门禁要求
  const baseContext: GateG4Context = {
    projectId: "test-project",
    loopType: "coding",
    specStatus: "approved" as DocumentState,
    planStatus: "approved" as DocumentState,
    reviewRecords: [],
    userApproved: true,
    taskCard: {
      id: "T-001",
      title: "OrderAggregate 骨架生成",
      requirementId: "F-001",
      dependencies: [],
      acceptanceCriteria: ["npm run test:order"],
      status: "pending",
      declaredSymbols: [
        "src/domain/order/OrderAggregate.ts:OrderAggregate.create",
        "src/domain/order/OrderAggregate.ts:OrderAggregate.cancel",
      ],
    },
    actualChanges: [],
    tasksStatus: "approved" as DocumentState,
    fileCluster: "OrderAggregate",
    requiredTemplateKinds: ["aggregate", "domain-event"] as ReadonlyArray<GeneratedFileKind>,
    techStack: ["TypeScript", "NestJS", "PostgreSQL", "TypeORM"],
    outputDir: "src/",
  };
  return { ...baseContext, ...overrides };
}

// ============================================================================
// 自定义 TemplateRegistry（用于 T8：含未注册 kind 场景）
// ============================================================================

/**
 * 自定义 TemplateRegistry（仅注册少量 kind，用于测试"未注册 kind"场景）
 *
 * 真实实现：内部维护一个 Set<GeneratedFileKind>，listKinds 仅返回部分 kind。
 * 不是 mock——所有方法真实工作，只是注册的 kind 集合较小。
 */
class PartialTemplateRegistry implements TemplateRegistry {
  private readonly registeredKinds: ReadonlySet<GeneratedFileKind>;

  constructor(kinds: ReadonlyArray<GeneratedFileKind>) {
    this.registeredKinds = new Set(kinds);
  }

  getTemplate(kind: GeneratedFileKind): string {
    if (!this.registeredKinds.has(kind)) {
      throw new Error(`未注册的 kind: ${kind}`);
    }
    return `// template for ${kind}`;
  }

  listKinds(): ReadonlyArray<GeneratedFileKind> {
    return Object.freeze(Array.from(this.registeredKinds) as GeneratedFileKind[]);
  }

  getVariableSchema(kind: GeneratedFileKind) {
    return {
      validate: (variables: Readonly<Record<string, unknown>>) => {
        if (!this.registeredKinds.has(kind)) {
          return { success: false, errors: [`未注册的 kind: ${kind}`] };
        }
        return { success: true, data: variables };
      },
    };
  }
}

// ============================================================================
// T1. GateG4Checker 实例化与 gateId
// ============================================================================

test("T1a. GateG4Checker 实例化成功（默认 TemplateRegistry）", () => {
  const checker = new GateG4Checker();
  assert.ok(checker instanceof GateG4Checker);
});

test("T1b. gateId 为 G-4", () => {
  const checker = new GateG4Checker();
  assert.equal(checker.gateId, "G-4");
});

test("T1c. 实现 GateChecker 协议", () => {
  const checker: GateChecker = new GateG4Checker();
  assert.equal(checker.gateId, "G-4");
  assert.equal(typeof checker.check, "function");
});

// ============================================================================
// T2. 全部字段合法 → 通过
// ============================================================================

test("T2. 全部字段合法 → 通过", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context();
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.gate, "G-4");
  assert.equal(result.severity, "blocker");
  assert.ok(result.reason.includes("G-4 门禁通过"));
  assert.ok(result.reason.includes("OrderAggregate"));
});

// ============================================================================
// T3. tasksStatus 非 approved → 失败
// ============================================================================

test("T3a. tasksStatus=draft → 失败", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context({ tasksStatus: "draft" as DocumentState });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.equal(result.gate, "G-4");
  assert.equal(result.severity, "blocker");
  assert.ok(result.reason.includes("draft"));
});

test("T3b. tasksStatus=reviewing → 失败", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context({ tasksStatus: "reviewing" as DocumentState });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("reviewing"));
});

test("T3c. tasksStatus=rejected → 失败", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context({ tasksStatus: "rejected" as DocumentState });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("rejected"));
});

// ============================================================================
// T4. taskCard.declaredSymbols 为空 → 失败
// ============================================================================

test("T4. taskCard.declaredSymbols 为空 → 失败", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context({
    taskCard: {
      id: "T-001",
      title: "测试任务",
      requirementId: "F-001",
      dependencies: [],
      acceptanceCriteria: ["npm test"],
      status: "pending",
      declaredSymbols: [],
    },
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("declaredSymbols"));
  assert.ok(result.reason.includes("为空"));
});

// ============================================================================
// T5. taskCard.acceptanceCriteria 为空 → 失败
// ============================================================================

test("T5. taskCard.acceptanceCriteria 为空 → 失败", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context({
    taskCard: {
      id: "T-001",
      title: "测试任务",
      requirementId: "F-001",
      dependencies: [],
      acceptanceCriteria: [],
      status: "pending",
      declaredSymbols: ["src/file.ts:Symbol"],
    },
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("acceptanceCriteria"));
  assert.ok(result.reason.includes("为空"));
});

// ============================================================================
// T6. fileCluster 为空 → 失败
// ============================================================================

test("T6a. fileCluster 为空字符串 → 失败", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context({ fileCluster: "" });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("fileCluster"));
});

test("T6b. fileCluster 为纯空白字符串 → 失败", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context({ fileCluster: "   " });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("fileCluster"));
});

// ============================================================================
// T7. requiredTemplateKinds 为空 → 失败
// ============================================================================

test("T7. requiredTemplateKinds 为空 → 失败", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context({
    requiredTemplateKinds: [] as ReadonlyArray<GeneratedFileKind>,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("requiredTemplateKinds"));
  assert.ok(result.reason.includes("为空"));
});

// ============================================================================
// T8. requiredTemplateKinds 含未注册 kind → 失败
// ============================================================================

test("T8. requiredTemplateKinds 含未注册 kind → 失败", () => {
  // 自定义注册表：仅注册 aggregate，未注册 domain-event
  const partialRegistry = new PartialTemplateRegistry(["aggregate"]);
  const checker = new GateG4Checker(partialRegistry);
  const ctx = createG4Context({
    requiredTemplateKinds: ["aggregate", "domain-event"] as ReadonlyArray<GeneratedFileKind>,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("domain-event"));
  assert.ok(result.reason.includes("未注册"));
});

// ============================================================================
// T9. techStack 为空 → 失败
// ============================================================================

test("T9. techStack 为空数组 → 失败", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context({ techStack: [] });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("techStack"));
});

// ============================================================================
// T10. outputDir 为空 → 失败
// ============================================================================

test("T10a. outputDir 为空字符串 → 失败", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context({ outputDir: "" });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("outputDir"));
});

test("T10b. outputDir 为纯空白字符串 → 失败", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context({ outputDir: "  " });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("outputDir"));
});

// ============================================================================
// T11. 失败结果含引导消息
// ============================================================================

test("T11. 失败结果含引导消息（建议回退到 CODING Loop 首轮）", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context({ tasksStatus: "draft" as DocumentState });
  const result = checker.check(ctx);
  assert.ok(result.guidance !== undefined);
  assert.ok(result.guidance!.includes("CODING Loop 首轮"));
});

// ============================================================================
// T12. 失败结果 severity 为 blocker
// ============================================================================

test("T12. 失败结果 severity 为 blocker", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context({ tasksStatus: "draft" as DocumentState });
  const result = checker.check(ctx);
  assert.equal(result.severity, "blocker");
});

// ============================================================================
// T13. 结果对象已冻结
// ============================================================================

test("T13a. 通过结果对象已冻结", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context();
  const result: GateResult = checker.check(ctx);
  assert.equal(Object.isFrozen(result), true);
});

test("T13b. 失败结果对象已冻结", () => {
  const checker = new GateG4Checker();
  const ctx = createG4Context({ tasksStatus: "draft" as DocumentState });
  const result: GateResult = checker.check(ctx);
  assert.equal(Object.isFrozen(result), true);
});

// ============================================================================
// T14. 默认 TemplateRegistry 为 DEFAULT_TEMPLATE_REGISTRY
// ============================================================================

test("T14. 默认 TemplateRegistry 含 13 种 kind", () => {
  const checker = new GateG4Checker();
  // 通过传入全部 13 种 kind 验证默认注册表覆盖完整
  const allKinds: ReadonlyArray<GeneratedFileKind> = DEFAULT_TEMPLATE_REGISTRY.listKinds();
  assert.equal(allKinds.length, 13);
  // 全部 kind 应通过 G-4 校验
  const ctx = createG4Context({ requiredTemplateKinds: allKinds });
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
});

// ============================================================================
// T15. GateContext（非 G4）传入 check 时不报编译错误（运行时按 G4 处理）
// ============================================================================

test("T15. GateContext 类型入参仍可被 check 接收（运行时按 G4 处理）", () => {
  const checker = new GateG4Checker();
  // GateG4Context 继承自 GateContext，可向上转型为 GateContext 传入
  const g4Context: GateContext = createG4Context();
  const result = checker.check(g4Context);
  assert.equal(result.passed, true);
});
