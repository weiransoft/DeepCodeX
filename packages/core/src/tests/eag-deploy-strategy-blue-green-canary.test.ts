/**
 * EAG-P4 批次 14 Phase 2 单元测试：BlueGreenStrategy + CanaryStrategy（TASK-14-2-6）
 *
 * 测试范围（对齐架构师审查 §4.1.7 + §4.1.8 + 任务清单 TASK-14-2-5/TASK-14-2-6 验收标准）：
 *
 * BlueGreenStrategy 测试用例（TC-BG-001 ~ TC-BG-005）：
 * - TC-BG-001. 实例化与接口契约
 *   - TC-BG-001a. BlueGreenStrategy 实例化成功
 *   - TC-BG-001b. 实现 DeployStrategy 接口（strategyType="blue-green"）
 *   - TC-BG-001c. 默认 timeoutMs=300000 + keepBlue=false
 *   - TC-BG-001d. 自定义 timeoutMs / keepBlue 通过构造函数注入
 *   - TC-BG-001e. 实例被 Object.freeze 冻结
 * - TC-BG-002. execute() 返回 DeployResult 结构正确
 *   - TC-BG-002a. 返回对象含 5 个字段
 *   - TC-BG-002b. 字段类型正确
 * - TC-BG-003. iacTemplates 为空时返回 success=false 不抛异常
 *   - TC-BG-003a. 空数组时 success=false
 *   - TC-BG-003b. errors 含 "IaC 模板为空"
 * - TC-BG-004. IaC 模板无 Deployment 时返回 success=false
 *   - TC-BG-004a. 无 Deployment 时 success=false
 *   - TC-BG-004b. errors 含 "Deployment"
 * - TC-BG-005. 不可变优先（Object.isFrozen 断言）
 *   - TC-BG-005a. 返回的 DeployResult 对象已冻结
 *   - TC-BG-005b. resources 数组已冻结
 *   - TC-BG-005c. errors 数组已冻结
 *
 * CanaryStrategy 测试用例（TC-CN-001 ~ TC-CN-005）：
 * - TC-CN-001. 单阶梯 [100] 实例化成功
 * - TC-CN-002. 多阶梯 [10, 50, 100] 实例化成功
 * - TC-CN-003. 阶梯失败保留 Canary 资源（kubectl 不可用时返回 success=false）
 *   - TC-CN-003a. kubectl 不可用时 success=false
 *   - TC-CN-003b. kubectl 不可用时不抛异常（错误内化）
 * - TC-CN-004. 流量阶梯可配置 [25, 75, 100] 实例化成功
 * - TC-CN-005. 构造期 canarySteps 校验（参数化测试，4 种异常）
 *   - TC-CN-005a. 空数组抛错
 *   - TC-CN-005b. 非正整数（0）抛错
 *   - TC-CN-005c. 超过 100 抛错
 *   - TC-CN-005d. 结尾非 100 抛错
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 * - kubectl 不可用测试通过 PATH="/nonexistent" 真实模拟（非 mock）
 * - 真实 kubectl 调用测试通过 checkCliAvailable 检测，不可用时跳过
 *
 * 设计依据：
 * - EAG-P4 批次 14 任务清单 TASK-14-2-5 / TASK-14-2-6 验收标准
 * - 架构师审查 §4.1.7 BlueGreenStrategy 类契约（FR-5）
 * - 架构师审查 §4.1.8 CanaryStrategy 类契约（FR-6，K-2 决策）
 * - R-14-1 缓解 A-1：失败时保留 Canary 资源
 *
 * @module core/tests/eag-deploy-strategy-blue-green-canary
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { BlueGreenStrategy } from "../eag/deploy/blue-green-strategy";
import { CanaryStrategy } from "../eag/deploy/canary-strategy";
import type { DeployStrategy, DeployContext, DeployResult, IaCTemplate } from "../eag/devops/types";

// ============================================================================
// 辅助函数：检测 CLI 工具是否可用
// ============================================================================

/**
 * 检测 CLI 工具是否可用
 *
 * 通过 spawnSync 调用 `<cli> --version` 检测 CLI 是否存在，非 mock。
 *
 * @param cliName CLI 工具名称（如 "kubectl"）
 * @returns true=CLI 可用，false=CLI 不可用
 */
function checkCliAvailable(cliName: string): boolean {
  try {
    const result = spawnSync(cliName, ["--version"], {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ============================================================================
// 辅助函数：构造测试用 DeployContext
// ============================================================================

/**
 * 构造测试用 DeployContext
 *
 * @param overrides 覆盖字段
 * @returns 完整的 DeployContext
 */
function createDeployContext(overrides: Partial<DeployContext> = {}): DeployContext {
  return {
    runId: "test-run-001",
    projectName: "test-app",
    environment: "dev",
    iacTemplates: createK8sManifestTemplates(),
    strategyType: "blue-green",
    timeoutMs: 300000,
    ...overrides,
  };
}

/**
 * 构造测试用 K8s Manifest IaCTemplate 数组（含 Deployment + Service）
 *
 * @returns IaCTemplate 数组
 */
function createK8sManifestTemplates(): ReadonlyArray<IaCTemplate> {
  const deploymentYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  namespace: test-app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: test-app
  template:
    metadata:
      labels:
        app: test-app
    spec:
      containers:
        - name: test-app
          image: nginx:1.21
          ports:
            - containerPort: 80
`;
  const serviceYaml = `apiVersion: v1
kind: Service
metadata:
  name: test-app
  namespace: test-app
spec:
  selector:
    app: test-app
  ports:
    - port: 80
      targetPort: 80
`;
  return [
    {
      type: "k8s-manifest",
      content: deploymentYaml,
      filePath: "deployment.yaml",
      hash: "hash-deployment-001",
      generatedAt: "2026-07-21T00:00:00.000Z",
    },
    {
      type: "k8s-manifest",
      content: serviceYaml,
      filePath: "service.yaml",
      hash: "hash-service-001",
      generatedAt: "2026-07-21T00:00:00.000Z",
    },
  ];
}

/**
 * 构造仅含 Service 资源（无 Deployment）的 IaCTemplate 数组
 *
 * 用于测试 BlueGreenStrategy 在 IaC 模板无 Deployment 时的失败处理。
 *
 * @returns IaCTemplate 数组（仅含 Service）
 */
function createServiceOnlyTemplates(): ReadonlyArray<IaCTemplate> {
  const serviceYaml = `apiVersion: v1
kind: Service
metadata:
  name: test-app
  namespace: test-app
spec:
  selector:
    app: test-app
  ports:
    - port: 80
      targetPort: 80
`;
  return [
    {
      type: "k8s-manifest",
      content: serviceYaml,
      filePath: "service.yaml",
      hash: "hash-service-002",
      generatedAt: "2026-07-21T00:00:00.000Z",
    },
  ];
}

// ============================================================================
// 检测 kubectl CLI 是否可用
// ============================================================================

const hasKubectl = checkCliAvailable("kubectl");

// ============================================================================
// ============================================================================
// BlueGreenStrategy 测试用例（TC-BG-001 ~ TC-BG-005）
// ============================================================================
// ============================================================================

// ----------------------------------------------------------------------------
// TC-BG-001. 实例化与接口契约
// ----------------------------------------------------------------------------

test("TC-BG-001a. BlueGreenStrategy 实例化成功", () => {
  const strategy = new BlueGreenStrategy();
  assert.ok(strategy instanceof BlueGreenStrategy);
});

test('TC-BG-001b. 实现 DeployStrategy 接口（strategyType="blue-green"）', () => {
  const strategy: DeployStrategy = new BlueGreenStrategy();
  assert.equal(strategy.strategyType, "blue-green");
  assert.equal(typeof strategy.execute, "function");
});

test("TC-BG-001c. 默认 timeoutMs=300000 + keepBlue=false", () => {
  const strategy = new BlueGreenStrategy();
  assert.equal(strategy.timeoutMs, 300000);
  assert.equal(strategy.keepBlue, false);
});

test("TC-BG-001d. 自定义 timeoutMs / keepBlue 通过构造函数注入", () => {
  const strategy = new BlueGreenStrategy({ timeoutMs: 60000, keepBlue: true });
  assert.equal(strategy.timeoutMs, 60000);
  assert.equal(strategy.keepBlue, true);
});

test("TC-BG-001e. 实例被 Object.freeze 冻结", () => {
  const strategy = new BlueGreenStrategy();
  assert.equal(Object.isFrozen(strategy), true);
});

// ----------------------------------------------------------------------------
// TC-BG-002. execute() 返回 DeployResult 结构正确
// ----------------------------------------------------------------------------

test("TC-BG-002a. 返回对象含 5 个字段（success / deployedAt / duration / resources / errors）", async () => {
  const strategy = new BlueGreenStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  // 验证 5 个字段全部存在
  assert.ok("success" in result);
  assert.ok("deployedAt" in result);
  assert.ok("duration" in result);
  assert.ok("resources" in result);
  assert.ok("errors" in result);
});

test("TC-BG-002b. 字段类型正确（success=boolean, deployedAt=string, duration=number）", async () => {
  const strategy = new BlueGreenStrategy();
  const result: DeployResult = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(typeof result.success, "boolean");
  assert.equal(typeof result.deployedAt, "string");
  assert.equal(typeof result.duration, "number");
  assert.ok(Array.isArray(result.resources));
  assert.ok(Array.isArray(result.errors));
});

// ----------------------------------------------------------------------------
// TC-BG-003. iacTemplates 为空时返回 success=false 不抛异常
// ----------------------------------------------------------------------------

test("TC-BG-003a. 空数组时 success=false", async () => {
  const strategy = new BlueGreenStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(result.success, false);
});

test('TC-BG-003b. errors 含 "IaC 模板为空"', async () => {
  const strategy = new BlueGreenStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("IaC 模板为空"), `errors 应含 "IaC 模板为空"，实际：${errorsStr}`);
});

test("TC-BG-003c. 不抛异常（错误内化）", async () => {
  const strategy = new BlueGreenStrategy();
  // execute 不应抛异常，应返回结构化 DeployResult
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.ok(result !== null && result !== undefined);
});

// ----------------------------------------------------------------------------
// TC-BG-004. IaC 模板无 Deployment 时返回 success=false
// ----------------------------------------------------------------------------

test("TC-BG-004a. 无 Deployment 时 success=false", async () => {
  const strategy = new BlueGreenStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: createServiceOnlyTemplates() }));
  assert.equal(result.success, false);
});

test('TC-BG-004b. errors 含 "Deployment"', async () => {
  const strategy = new BlueGreenStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: createServiceOnlyTemplates() }));
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("Deployment"), `errors 应含 "Deployment"，实际：${errorsStr}`);
});

// ----------------------------------------------------------------------------
// TC-BG-005. 不可变优先（Object.isFrozen 断言）
// ----------------------------------------------------------------------------

test("TC-BG-005a. 返回的 DeployResult 对象已冻结", async () => {
  const strategy = new BlueGreenStrategy();
  const result: DeployResult = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(Object.isFrozen(result), true);
});

test("TC-BG-005b. resources 数组已冻结", async () => {
  const strategy = new BlueGreenStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(Object.isFrozen(result.resources), true);
});

test("TC-BG-005c. errors 数组已冻结", async () => {
  const strategy = new BlueGreenStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(Object.isFrozen(result.errors), true);
});

// ----------------------------------------------------------------------------
// TC-BG-006. kubectl 不可用时返回 success=false（spawn ENOENT 路径）
// ----------------------------------------------------------------------------

test("TC-BG-006a. kubectl 不可用时 success=false", async () => {
  const strategy = new BlueGreenStrategy({ timeoutMs: 5000 });
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await strategy.execute(createDeployContext());
    // kubectl 不可用时：apply 失败 → success=false（不切换流量，R-14-1 缓解 A-1）
    assert.equal(result.success, false);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("TC-BG-006b. kubectl 不可用时不抛异常（错误内化）", async () => {
  const strategy = new BlueGreenStrategy({ timeoutMs: 5000 });
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    // execute 不应抛异常，应返回结构化 DeployResult
    const result = await strategy.execute(createDeployContext());
    assert.ok(result !== null && result !== undefined);
    assert.equal(typeof result.success, "boolean");
  } finally {
    process.env.PATH = originalPath;
  }
});

// ============================================================================
// ============================================================================
// CanaryStrategy 测试用例（TC-CN-001 ~ TC-CN-005）
// ============================================================================
// ============================================================================

// ----------------------------------------------------------------------------
// TC-CN-001. 单阶梯 [100] 实例化成功
// ----------------------------------------------------------------------------

test("TC-CN-001a. 单阶梯 [100] 实例化成功", () => {
  const strategy = new CanaryStrategy({ canarySteps: [100] });
  assert.ok(strategy instanceof CanaryStrategy);
});

test('TC-CN-001b. 单阶梯 [100] strategyType="canary"', () => {
  const strategy: DeployStrategy = new CanaryStrategy({ canarySteps: [100] });
  assert.equal(strategy.strategyType, "canary");
});

test("TC-CN-001c. 单阶梯 [100] canarySteps 冻结", () => {
  const strategy = new CanaryStrategy({ canarySteps: [100] });
  assert.deepEqual(Array.from(strategy.canarySteps), [100]);
  assert.equal(Object.isFrozen(strategy.canarySteps), true);
});

test("TC-CN-001d. 单阶梯 [100] 默认 healthCheckTimeoutMs=60000 + healthCheckPath=/healthz", () => {
  const strategy = new CanaryStrategy({ canarySteps: [100] });
  assert.equal(strategy.healthCheckTimeoutMs, 60000);
  assert.equal(strategy.healthCheckPath, "/healthz");
});

// ----------------------------------------------------------------------------
// TC-CN-002. 多阶梯 [10, 50, 100] 实例化成功
// ----------------------------------------------------------------------------

test("TC-CN-002a. 多阶梯 [10, 50, 100] 实例化成功", () => {
  const strategy = new CanaryStrategy({ canarySteps: [10, 50, 100] });
  assert.ok(strategy instanceof CanaryStrategy);
});

test("TC-CN-002b. 多阶梯 [10, 50, 100] canarySteps 保留传入值", () => {
  const strategy = new CanaryStrategy({ canarySteps: [10, 50, 100] });
  assert.deepEqual(Array.from(strategy.canarySteps), [10, 50, 100]);
});

test("TC-CN-002c. 多阶梯 [10, 50, 100] 实例被 Object.freeze 冻结", () => {
  const strategy = new CanaryStrategy({ canarySteps: [10, 50, 100] });
  assert.equal(Object.isFrozen(strategy), true);
});

test("TC-CN-002d. 多阶梯 [10, 50, 100] 自定义 healthCheckTimeoutMs + healthCheckPath", () => {
  const strategy = new CanaryStrategy({
    canarySteps: [10, 50, 100],
    healthCheckTimeoutMs: 30000,
    healthCheckPath: "/health",
  });
  assert.equal(strategy.healthCheckTimeoutMs, 30000);
  assert.equal(strategy.healthCheckPath, "/health");
});

// ----------------------------------------------------------------------------
// TC-CN-003. 阶梯失败保留 Canary 资源（kubectl 不可用时返回 success=false）
// R-14-1 缓解 A-1：失败时保留 Canary 资源
// ----------------------------------------------------------------------------

test("TC-CN-003a. kubectl 不可用时 success=false", async () => {
  const strategy = new CanaryStrategy({ canarySteps: [100], healthCheckTimeoutMs: 5000 });
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await strategy.execute(createDeployContext());
    // kubectl 不可用时：apply 失败 → success=false（保留 Canary 资源由 kubectl 行为决定）
    assert.equal(result.success, false);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("TC-CN-003b. kubectl 不可用时不抛异常（错误内化）", async () => {
  const strategy = new CanaryStrategy({ canarySteps: [100], healthCheckTimeoutMs: 5000 });
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    // execute 不应抛异常，应返回结构化 DeployResult
    const result = await strategy.execute(createDeployContext());
    assert.ok(result !== null && result !== undefined);
    assert.equal(typeof result.success, "boolean");
    assert.ok(Array.isArray(result.errors));
  } finally {
    process.env.PATH = originalPath;
  }
});

test("TC-CN-003c. kubectl 不可用时 errors 含错误信息", async () => {
  const strategy = new CanaryStrategy({ canarySteps: [100], healthCheckTimeoutMs: 5000 });
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await strategy.execute(createDeployContext());
    assert.ok(result.errors.length > 0, "errors 数组应非空");
    const errorsStr = result.errors.join(" ");
    // errors 应含 kubectl 相关错误
    assert.ok(
      errorsStr.includes("kubectl") || errorsStr.includes("执行失败"),
      `errors 应含 kubectl 错误，实际：${errorsStr}`
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("TC-CN-003d. iacTemplates 为空时 success=false（保留 Canary 资源前置条件）", async () => {
  const strategy = new CanaryStrategy({ canarySteps: [100] });
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  // iacTemplates 为空时：未部署任何 Canary 资源，success=false
  assert.equal(result.success, false);
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("IaC 模板为空"));
});

// ----------------------------------------------------------------------------
// TC-CN-004. 流量阶梯可配置 [25, 75, 100] 实例化成功
// ----------------------------------------------------------------------------

test("TC-CN-004a. 流量阶梯可配置 [25, 75, 100] 实例化成功", () => {
  const strategy = new CanaryStrategy({ canarySteps: [25, 75, 100] });
  assert.ok(strategy instanceof CanaryStrategy);
});

test("TC-CN-004b. 流量阶梯 [25, 75, 100] canarySteps 保留传入值", () => {
  const strategy = new CanaryStrategy({ canarySteps: [25, 75, 100] });
  assert.deepEqual(Array.from(strategy.canarySteps), [25, 75, 100]);
});

test("TC-CN-004c. 流量阶梯 [25, 75, 100] 实例冻结", () => {
  const strategy = new CanaryStrategy({ canarySteps: [25, 75, 100] });
  assert.equal(Object.isFrozen(strategy), true);
  assert.equal(Object.isFrozen(strategy.canarySteps), true);
});

test("TC-CN-004d. 不同阶梯数组互不影响（每次构造独立实例）", () => {
  const strategy1 = new CanaryStrategy({ canarySteps: [25, 75, 100] });
  const strategy2 = new CanaryStrategy({ canarySteps: [10, 50, 100] });
  assert.deepEqual(Array.from(strategy1.canarySteps), [25, 75, 100]);
  assert.deepEqual(Array.from(strategy2.canarySteps), [10, 50, 100]);
});

// ----------------------------------------------------------------------------
// TC-CN-005. 构造期 canarySteps 校验（参数化测试，4 种异常）
// ----------------------------------------------------------------------------

test("TC-CN-005a. 空数组抛错", () => {
  assert.throws(() => new CanaryStrategy({ canarySteps: [] }), /canarySteps 不能为空数组/, "空数组应抛错");
});

test("TC-CN-005b. 非正整数（0）抛错", () => {
  assert.throws(() => new CanaryStrategy({ canarySteps: [0, 100] }), /不是正整数/, "包含 0 应抛错");
});

test("TC-CN-005c. 超过 100 抛错", () => {
  assert.throws(() => new CanaryStrategy({ canarySteps: [101, 100] }), /超过 100/, "包含 101 应抛错");
});

test("TC-CN-005d. 结尾非 100 抛错", () => {
  assert.throws(() => new CanaryStrategy({ canarySteps: [10, 50, 90] }), /最后一个元素必须为 100/, "结尾非 100 应抛错");
});

test("TC-CN-005e. 非整数（小数）抛错", () => {
  assert.throws(() => new CanaryStrategy({ canarySteps: [10.5, 100] }), /不是正整数/, "包含小数应抛错");
});

test("TC-CN-005f. 负数抛错", () => {
  assert.throws(() => new CanaryStrategy({ canarySteps: [-10, 100] }), /不是正整数/, "包含负数应抛错");
});

test("TC-CN-005g. options 为 undefined 抛错", () => {
  assert.throws(
    () => new CanaryStrategy(undefined as unknown as { canarySteps: ReadonlyArray<number> }),
    /canarySteps 为必填字段/,
    "options 为 undefined 应抛错"
  );
});

test("TC-CN-005h. canarySteps 为 undefined 抛错", () => {
  assert.throws(
    () => new CanaryStrategy({ canarySteps: undefined } as unknown as { canarySteps: ReadonlyArray<number> }),
    /canarySteps 为必填字段/,
    "canarySteps 为 undefined 应抛错"
  );
});

// ----------------------------------------------------------------------------
// TC-CN-006. execute() 返回 DeployResult 结构正确
// ----------------------------------------------------------------------------

test("TC-CN-006a. 返回对象含 5 个字段（success / deployedAt / duration / resources / errors）", async () => {
  const strategy = new CanaryStrategy({ canarySteps: [100] });
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  // 验证 5 个字段全部存在
  assert.ok("success" in result);
  assert.ok("deployedAt" in result);
  assert.ok("duration" in result);
  assert.ok("resources" in result);
  assert.ok("errors" in result);
});

test("TC-CN-006b. 字段类型正确", async () => {
  const strategy = new CanaryStrategy({ canarySteps: [100] });
  const result: DeployResult = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(typeof result.success, "boolean");
  assert.equal(typeof result.deployedAt, "string");
  assert.equal(typeof result.duration, "number");
  assert.ok(Array.isArray(result.resources));
  assert.ok(Array.isArray(result.errors));
});

// ----------------------------------------------------------------------------
// TC-CN-007. 不可变优先（Object.isFrozen 断言）
// ----------------------------------------------------------------------------

test("TC-CN-007a. 返回的 DeployResult 对象已冻结", async () => {
  const strategy = new CanaryStrategy({ canarySteps: [100] });
  const result: DeployResult = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(Object.isFrozen(result), true);
});

test("TC-CN-007b. resources 数组已冻结", async () => {
  const strategy = new CanaryStrategy({ canarySteps: [100] });
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(Object.isFrozen(result.resources), true);
});

test("TC-CN-007c. errors 数组已冻结", async () => {
  const strategy = new CanaryStrategy({ canarySteps: [100] });
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(Object.isFrozen(result.errors), true);
});

// ----------------------------------------------------------------------------
// TC-CN-008. 真实 kubectl 调用（CLI 存在时，可选测试）
// ----------------------------------------------------------------------------

test("TC-CN-008. 真实 kubectl 调用（CLI 存在时）", { skip: !hasKubectl }, async () => {
  // 此测试在 kubectl 可用时运行，验证真实 kubectl 调用路径
  // 注意：此测试需要可访问的 K8s 集群，否则 kubectl apply 会失败
  // 测试目的：验证 CanaryStrategy.execute() 真实调用 kubectl（非 mock）
  const strategy = new CanaryStrategy({
    canarySteps: [100],
    healthCheckTimeoutMs: 10000,
  });
  const result = await strategy.execute(createDeployContext());

  // 无论 kubectl apply 是否成功（取决于集群可用性），结果应为结构化 DeployResult
  assert.equal(typeof result.success, "boolean");
  assert.ok(Array.isArray(result.errors));
  assert.ok(Array.isArray(result.resources));
  assert.equal(Object.isFrozen(result), true);
});
