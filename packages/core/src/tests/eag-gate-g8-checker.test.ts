/**
 * EAG-P4 批次 13 Phase 2 单元测试：G-8 门禁检查器（GateG8CheckerImpl）
 *
 * 测试范围（对齐设计文档 §6.2.1 D1-3 GateG8Checker 覆盖率 ≥ 90% 目标）：
 * - T1. GateG8CheckerImpl 实例化与 gateId
 *   - T1a. 实例化成功
 *   - T1b. gateId 为 "G-8"
 *   - T1c. 实现 GateChecker 协议（gateId + check 方法）
 *   - T1d. 实现 GateG8Checker 接口（更严格的协议，gateId 类型收窄为 "G-8"）
 * - T2. 全部 5 项通过 → passed=true
 *   - T2a. passed=true
 *   - T2b. gate="G-8"
 *   - T2c. severity="blocker"（通过时不降级为 warning，M-6 修复）
 *   - T2d. reason 含 "G-8 部署门禁通过"
 *   - T2e. guidance 为 "部署就绪，可进入生产环境"
 * - T3. G-8-1 失败（iacTemplates 为空数组）→ passed=false + failures 含 G-8-1
 * - T4. G-8-2 失败（healthCheckResult.healthy=false）→ passed=false + failures 含 G-8-2
 * - T5. G-8-3 失败（smokeTestResult.passed=false）→ passed=false + failures 含 G-8-3
 * - T6. G-8-4 失败（monitoringReady=false）→ passed=false + failures 含 G-8-4
 * - T7. G-8-5 失败（rollbackPlanExists=false）→ passed=false + failures 含 G-8-5
 * - T8. 多项失败同时收集（G-8-1 + G-8-2 + G-8-3 同时失败）→ failures 含 3 项（非短路求值验证）
 * - T9. 全部 5 项失败 → failures 含 5 项
 * - T10. 返回值 Object.freeze 冻结
 * - T11. severity 始终为 blocker（无论通过或失败，对齐 M-6 修复）
 * - T12. reason 格式正确（失败时为分号分隔的 failures 列表）
 * - T13. guidance 格式正确（失败时为"请根据 failures 列表逐项修复"）
 * - T14. GateG8Context.loopType 固定为 "deploy"（接口约束验证）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 * - 防御性检查测试：通过类型断言绕过 TypeScript 类型系统，模拟运行期非法输入
 *
 * @module core/tests/eag-gate-g8-checker
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GateG8CheckerImpl } from "../eag/gate/gate-g8-checker";
import type { GateChecker, GateContext, GateResult } from "../eag/gate/gate-types";
import type {
  DeployedResource,
  DeployResult,
  GateG8Checker,
  GateG8Context,
  HealthCheckResult,
  IaCTemplate,
  SmokeTestResult,
} from "../eag/devops/types";
import type { DocumentState } from "../eag/doc-driven/types";

// ============================================================================
// 辅助函数：构造测试用 GateG8Context
// ============================================================================

/**
 * 构造测试用 GateG8Context（默认全部 5 项通过）
 *
 * 默认值：
 * - iacTemplates: 含 1 个 IaC 模板（G-8-1 通过）
 * - healthCheckResult.healthy: true（G-8-2 通过）
 * - smokeTestResult.passed: true（G-8-3 通过）
 * - monitoringReady: true（G-8-4 通过）
 * - rollbackPlanExists: true（G-8-5 通过）
 *
 * @param overrides 覆盖字段（用于测试失败场景）
 * @returns 完整的 GateG8Context
 */
function createContext(overrides: Partial<GateG8Context> = {}): GateG8Context {
  // 默认 IaC 模板（Terraform 类型）
  const defaultIacTemplate: IaCTemplate = Object.freeze({
    type: "terraform",
    content: "# Terraform template content",
    filePath: "infra/main.tf",
    hash: "sha256:abc123",
    generatedAt: "2026-07-20T10:00:00.000Z",
  });

  // 默认部署结果
  const defaultDeployResult: DeployResult = Object.freeze({
    success: true,
    deployedAt: "2026-07-20T10:05:00.000Z",
    duration: 30000,
    resources: Object.freeze([
      Object.freeze({
        kind: "Deployment",
        name: "my-app",
        namespace: "default",
        status: "Running",
      }) as DeployedResource,
    ]) as ReadonlyArray<DeployedResource>,
    errors: Object.freeze([]) as ReadonlyArray<string>,
  });

  // 默认健康检查结果（healthy=true）
  const defaultHealthCheckResult: HealthCheckResult = Object.freeze({
    healthy: true,
    checkedAt: "2026-07-20T10:06:00.000Z",
    endpoints: Object.freeze([]),
    failures: Object.freeze([]) as ReadonlyArray<string>,
  });

  // 默认烟雾测试结果（passed=true）
  const defaultSmokeTestResult: SmokeTestResult = Object.freeze({
    passed: true,
    totalTests: 3,
    passedTests: 3,
    failedTests: 0,
    duration: 5000,
    failures: Object.freeze([]),
  });

  // 基础 GateContext 字段（GateG8Context extends GateContext）
  const baseContext: GateContext = {
    projectId: "test-project",
    loopType: "deploy", // GateG8Context.loopType 固定为 "deploy"
    specStatus: "approved" as DocumentState,
    planStatus: "approved" as DocumentState,
    reviewRecords: [],
    userApproved: true,
    taskCard: {
      id: "T-001",
      title: "部署任务",
      requirementId: "F-001",
      dependencies: [],
      acceptanceCriteria: ["kubectl get pods"],
      status: "pending",
      declaredSymbols: [],
    },
    actualChanges: [],
  };

  return {
    ...baseContext,
    loopType: "deploy", // 显式覆盖 baseContext.loopType（类型收窄为 "deploy"）
    iacTemplates: Object.freeze([defaultIacTemplate]) as ReadonlyArray<IaCTemplate>,
    deployResult: defaultDeployResult,
    healthCheckResult: defaultHealthCheckResult,
    smokeTestResult: defaultSmokeTestResult,
    monitoringReady: true,
    rollbackPlanExists: true,
    ...overrides,
  };
}

// ============================================================================
// T1. GateG8CheckerImpl 实例化与 gateId
// ============================================================================

test("T1a. GateG8CheckerImpl 实例化成功", () => {
  const checker = new GateG8CheckerImpl();
  assert.ok(checker instanceof GateG8CheckerImpl);
});

test("T1b. gateId 为 G-8", () => {
  const checker = new GateG8CheckerImpl();
  assert.equal(checker.gateId, "G-8");
});

test("T1c. 实现 GateChecker 协议（gateId + check 方法）", () => {
  // 将 GateG8CheckerImpl 实例赋值给 GateChecker 类型的变量，
  // 验证它满足 GateChecker 协议（多态性验证）
  const checker: GateChecker = new GateG8CheckerImpl();
  assert.equal(checker.gateId, "G-8");
  assert.equal(typeof checker.check, "function");
});

test("T1d. 实现 GateG8Checker 接口（更严格的协议，gateId 类型收窄为 'G-8'）", () => {
  // 将 GateG8CheckerImpl 实例赋值给 GateG8Checker 接口类型的变量，
  // 验证它满足 GateG8Checker 接口（gateId 字面量类型收窄为 "G-8"）
  const checker: GateG8Checker = new GateG8CheckerImpl();
  assert.equal(checker.gateId, "G-8");
  assert.equal(typeof checker.check, "function");
  // 验证 gateId 类型收窄为字面量 "G-8"（而非宽泛的 string）
  const gateId: "G-8" = checker.gateId;
  assert.equal(gateId, "G-8");
});

// ============================================================================
// T2. 全部 5 项通过 → passed=true
// ============================================================================

test("T2a. 全部 5 项通过 → passed=true", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext();
  const result = checker.check(ctx);
  assert.equal(result.passed, true);
});

test("T2b. 全部 5 项通过 → gate=G-8", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext();
  const result = checker.check(ctx);
  assert.equal(result.gate, "G-8");
});

test("T2c. 全部 5 项通过 → severity=blocker（通过时不降级为 warning，M-6 修复）", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext();
  const result = checker.check(ctx);
  // M-6 修复：与既有 G-1~G-7 同构，门禁本身为 blocker 级别（通过时不降级为 warning）
  assert.equal(result.severity, "blocker");
});

test("T2d. 全部 5 项通过 → reason 含 'G-8 部署门禁通过'", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext();
  const result = checker.check(ctx);
  assert.ok(result.reason.includes("G-8 部署门禁通过"), `reason 应含 "G-8 部署门禁通过"，实际值：${result.reason}`);
  // 验证 reason 含全部 5 项通过项
  assert.ok(result.reason.includes("IaC 完整"), "reason 应含 'IaC 完整'");
  assert.ok(result.reason.includes("健康就绪"), "reason 应含 '健康就绪'");
  assert.ok(result.reason.includes("烟雾通过"), "reason 应含 '烟雾通过'");
  assert.ok(result.reason.includes("监控就位"), "reason 应含 '监控就位'");
  assert.ok(result.reason.includes("回滚预案存在"), "reason 应含 '回滚预案存在'");
});

test("T2e. 全部 5 项通过 → guidance 为 '部署就绪，可进入生产环境'", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext();
  const result = checker.check(ctx);
  assert.equal(result.guidance, "部署就绪，可进入生产环境");
});

// ============================================================================
// T3. G-8-1 失败（iacTemplates 为空数组）
// ============================================================================

test("T3. G-8-1 失败（iacTemplates 为空数组）→ passed=false + failures 含 G-8-1", () => {
  const checker = new GateG8CheckerImpl();
  // 构造 iacTemplates 为空数组的上下文
  const ctx = createContext({
    iacTemplates: Object.freeze([]) as ReadonlyArray<IaCTemplate>,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.equal(result.gate, "G-8");
  assert.ok(result.reason.includes("G-8-1"), `reason 应含 "G-8-1"，实际值：${result.reason}`);
  assert.ok(result.reason.includes("IaC 模板为空"), "reason 应含 'IaC 模板为空'");
  // 验证其他 4 项仍通过（仅 G-8-1 失败）
  assert.ok(!result.reason.includes("G-8-2"), "不应含 G-8-2 失败");
  assert.ok(!result.reason.includes("G-8-3"), "不应含 G-8-3 失败");
  assert.ok(!result.reason.includes("G-8-4"), "不应含 G-8-4 失败");
  assert.ok(!result.reason.includes("G-8-5"), "不应含 G-8-5 失败");
});

// ============================================================================
// T4. G-8-2 失败（healthCheckResult.healthy=false）
// ============================================================================

test("T4. G-8-2 失败（healthCheckResult.healthy=false）→ passed=false + failures 含 G-8-2", () => {
  const checker = new GateG8CheckerImpl();
  // 构造 healthCheckResult.healthy=false 的上下文
  const ctx = createContext({
    healthCheckResult: Object.freeze({
      healthy: false,
      checkedAt: "2026-07-20T10:06:00.000Z",
      endpoints: Object.freeze([]),
      failures: Object.freeze(["/healthz 返回 503"]) as ReadonlyArray<string>,
    }),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("G-8-2"), `reason 应含 "G-8-2"，实际值：${result.reason}`);
  assert.ok(result.reason.includes("健康检查未就绪"), "reason 应含 '健康检查未就绪'");
  // 验证其他 4 项仍通过（仅 G-8-2 失败）
  assert.ok(!result.reason.includes("G-8-1"), "不应含 G-8-1 失败");
  assert.ok(!result.reason.includes("G-8-3"), "不应含 G-8-3 失败");
});

// ============================================================================
// T5. G-8-3 失败（smokeTestResult.passed=false）
// ============================================================================

test("T5. G-8-3 失败（smokeTestResult.passed=false）→ passed=false + failures 含 G-8-3", () => {
  const checker = new GateG8CheckerImpl();
  // 构造 smokeTestResult.passed=false 的上下文
  const ctx = createContext({
    smokeTestResult: Object.freeze({
      passed: false,
      totalTests: 3,
      passedTests: 2,
      failedTests: 1,
      duration: 5000,
      failures: Object.freeze([
        Object.freeze({
          testCase: "GET /api/users 应返回 200",
          actual: "503 Service Unavailable",
          expected: "200 OK",
        }),
      ]),
    }),
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("G-8-3"), `reason 应含 "G-8-3"，实际值：${result.reason}`);
  assert.ok(result.reason.includes("烟雾测试未通过"), "reason 应含 '烟雾测试未通过'");
});

// ============================================================================
// T6. G-8-4 失败（monitoringReady=false）
// ============================================================================

test("T6. G-8-4 失败（monitoringReady=false）→ passed=false + failures 含 G-8-4", () => {
  const checker = new GateG8CheckerImpl();
  // 构造 monitoringReady=false 的上下文
  const ctx = createContext({
    monitoringReady: false,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("G-8-4"), `reason 应含 "G-8-4"，实际值：${result.reason}`);
  assert.ok(result.reason.includes("监控告警未就位"), "reason 应含 '监控告警未就位'");
});

// ============================================================================
// T7. G-8-5 失败（rollbackPlanExists=false）
// ============================================================================

test("T7. G-8-5 失败（rollbackPlanExists=false）→ passed=false + failures 含 G-8-5", () => {
  const checker = new GateG8CheckerImpl();
  // 构造 rollbackPlanExists=false 的上下文
  const ctx = createContext({
    rollbackPlanExists: false,
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("G-8-5"), `reason 应含 "G-8-5"，实际值：${result.reason}`);
  assert.ok(result.reason.includes("回滚预案不存在"), "reason 应含 '回滚预案不存在'");
});

// ============================================================================
// T8. 多项失败同时收集（G-8-1 + G-8-2 + G-8-3 同时失败）→ failures 含 3 项（非短路求值验证）
// ============================================================================

test("T8. 多项失败同时收集（G-8-1 + G-8-2 + G-8-3 同时失败）→ failures 含 3 项", () => {
  const checker = new GateG8CheckerImpl();
  // 构造 3 项同时失败的上下文
  const ctx = createContext({
    iacTemplates: Object.freeze([]) as ReadonlyArray<IaCTemplate>, // G-8-1 失败
    healthCheckResult: Object.freeze({
      healthy: false,
      checkedAt: "2026-07-20T10:06:00.000Z",
      endpoints: Object.freeze([]),
      failures: Object.freeze([]) as ReadonlyArray<string>,
    }), // G-8-2 失败
    smokeTestResult: Object.freeze({
      passed: false,
      totalTests: 1,
      passedTests: 0,
      failedTests: 1,
      duration: 1000,
      failures: Object.freeze([]),
    }), // G-8-3 失败
    // G-8-4 / G-8-5 保持默认 true
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  // 验证 failures 含 3 项（非短路求值，全部失败项一次性收集）
  assert.ok(result.reason.includes("G-8-1"), "应含 G-8-1");
  assert.ok(result.reason.includes("G-8-2"), "应含 G-8-2");
  assert.ok(result.reason.includes("G-8-3"), "应含 G-8-3");
  // 验证 G-8-4 / G-8-5 未失败
  assert.ok(!result.reason.includes("G-8-4"), "不应含 G-8-4 失败");
  assert.ok(!result.reason.includes("G-8-5"), "不应含 G-8-5 失败");
  // 验证 failures 之间用分号分隔
  assert.ok(result.reason.includes(";"), "failures 之间应用分号分隔");
});

// ============================================================================
// T9. 全部 5 项失败 → failures 含 5 项
// ============================================================================

test("T9. 全部 5 项失败 → failures 含 5 项", () => {
  const checker = new GateG8CheckerImpl();
  // 构造全部 5 项失败的上下文
  const ctx = createContext({
    iacTemplates: Object.freeze([]) as ReadonlyArray<IaCTemplate>, // G-8-1 失败
    healthCheckResult: Object.freeze({
      healthy: false,
      checkedAt: "2026-07-20T10:06:00.000Z",
      endpoints: Object.freeze([]),
      failures: Object.freeze([]) as ReadonlyArray<string>,
    }), // G-8-2 失败
    smokeTestResult: Object.freeze({
      passed: false,
      totalTests: 1,
      passedTests: 0,
      failedTests: 1,
      duration: 1000,
      failures: Object.freeze([]),
    }), // G-8-3 失败
    monitoringReady: false, // G-8-4 失败
    rollbackPlanExists: false, // G-8-5 失败
  });
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  // 验证 failures 含全部 5 项
  assert.ok(result.reason.includes("G-8-1"), "应含 G-8-1");
  assert.ok(result.reason.includes("G-8-2"), "应含 G-8-2");
  assert.ok(result.reason.includes("G-8-3"), "应含 G-8-3");
  assert.ok(result.reason.includes("G-8-4"), "应含 G-8-4");
  assert.ok(result.reason.includes("G-8-5"), "应含 G-8-5");
  // 验证 failures 之间用分号分隔（4 个分号分隔 5 项）
  const semicolonCount = (result.reason.match(/;/g) || []).length;
  assert.ok(semicolonCount >= 4, `应有至少 4 个分号分隔 5 项 failures，实际：${semicolonCount}`);
});

// ============================================================================
// T10. 返回值 Object.freeze 冻结
// ============================================================================

test("T10. 返回值 Object.freeze 冻结（通过场景）", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext();
  const result = checker.check(ctx);
  assert.equal(Object.isFrozen(result), true, "通过场景的返回值应为冻结对象");
});

test("T10b. 返回值 Object.freeze 冻结（失败场景）", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext({ monitoringReady: false });
  const result = checker.check(ctx);
  assert.equal(Object.isFrozen(result), true, "失败场景的返回值应为冻结对象");
});

// ============================================================================
// T11. severity 始终为 blocker（无论通过或失败，对齐 M-6 修复）
// ============================================================================

test("T11. severity 始终为 blocker（通过场景）", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext();
  const result = checker.check(ctx);
  assert.equal(result.severity, "blocker");
});

test("T11b. severity 始终为 blocker（失败场景）", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext({ rollbackPlanExists: false });
  const result = checker.check(ctx);
  assert.equal(result.severity, "blocker");
});

// ============================================================================
// T12. reason 格式正确（失败时为分号分隔的 failures 列表）
// ============================================================================

test("T12. reason 格式正确（失败时为 'G-8 部署门禁未通过：' + 分号分隔的 failures）", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext({ monitoringReady: false, rollbackPlanExists: false });
  const result = checker.check(ctx);
  // 验证 reason 以 "G-8 部署门禁未通过：" 开头
  assert.ok(
    result.reason.startsWith("G-8 部署门禁未通过："),
    `reason 应以 "G-8 部署门禁未通过：" 开头，实际值：${result.reason}`
  );
  // 验证 failures 之间用分号分隔
  assert.ok(result.reason.includes(";"), "failures 之间应用分号分隔");
});

// ============================================================================
// T13. guidance 格式正确
// ============================================================================

test("T13. guidance 格式正确（通过场景：'部署就绪，可进入生产环境'）", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext();
  const result = checker.check(ctx);
  assert.equal(result.guidance, "部署就绪，可进入生产环境");
});

test("T13b. guidance 格式正确（失败场景：'请根据 failures 列表逐项修复，修复后重新触发部署'）", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext({ monitoringReady: false });
  const result = checker.check(ctx);
  assert.equal(result.guidance, "请根据 failures 列表逐项修复，修复后重新触发部署");
});

// ============================================================================
// T14. GateG8Context.loopType 固定为 "deploy"（接口约束验证）
// ============================================================================

test("T14. GateG8Context.loopType 固定为 'deploy'（接口约束验证）", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext();
  // 验证 loopType 为 "deploy"（GateG8Context 接口约束）
  assert.equal(ctx.loopType, "deploy");
  // 验证 check 方法能正确处理 loopType="deploy" 的上下文
  const result = checker.check(ctx);
  assert.equal(result.gate, "G-8");
  // 验证 check 不依赖 loopType 做分支（G-8 仅校验 5 项部署就绪条件，与 loopType 无关）
  assert.equal(result.passed, true);
});

// ============================================================================
// T15. 防御性检查：运行期非法输入（通过类型断言绕过 TypeScript 类型系统）
// ============================================================================

test("T15a. 防御性检查：iacTemplates 为 undefined（运行期非法输入）→ failures 含 G-8-1", () => {
  const checker = new GateG8CheckerImpl();
  // 通过类型断言绕过 TypeScript 类型系统，模拟运行期非法输入
  // 场景：调用方通过 `as GateG8Context` 传入了不完整对象
  const ctx = createContext() as GateG8Context;
  Reflect.set(ctx, "iacTemplates", undefined);
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("G-8-1"), "应含 G-8-1 失败");
});

test("T15b. 防御性检查：healthCheckResult 为 undefined（运行期非法输入）→ failures 含 G-8-2", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext() as GateG8Context;
  Reflect.set(ctx, "healthCheckResult", undefined);
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("G-8-2"), "应含 G-8-2 失败");
});

test("T15c. 防御性检查：smokeTestResult 为 undefined（运行期非法输入）→ failures 含 G-8-3", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext() as GateG8Context;
  Reflect.set(ctx, "smokeTestResult", undefined);
  const result = checker.check(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("G-8-3"), "应含 G-8-3 失败");
});

// ============================================================================
// T16. 返回类型为 GateResult（编译期 + 运行期校验）
// ============================================================================

test("T16. check 方法返回类型为 GateResult（含全部 5 个字段）", () => {
  const checker = new GateG8CheckerImpl();
  const ctx = createContext();
  const result: GateResult = checker.check(ctx);
  // 验证 GateResult 全部 5 个字段存在
  assert.ok("passed" in result, "应有 passed 字段");
  assert.ok("gate" in result, "应有 gate 字段");
  assert.ok("reason" in result, "应有 reason 字段");
  assert.ok("guidance" in result, "应有 guidance 字段");
  assert.ok("severity" in result, "应有 severity 字段");
});
