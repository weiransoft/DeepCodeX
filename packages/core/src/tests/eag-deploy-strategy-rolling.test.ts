/**
 * EAG-P4 批次 14 Phase 2 单元测试：RollingStrategy（B-14-1 Blocker 修复验证，TASK-14-2-5）
 *
 * 测试范围（对齐架构师审查 §4.1.6 + 任务清单 TASK-14-2-4 验收标准）：
 * - TC-RL-001. 实例化与接口契约
 *   - TC-RL-001a. RollingStrategy 实例化成功
 *   - TC-RL-001b. 实现 DeployStrategy 接口（strategyType="rolling"）
 *   - TC-RL-001c. 默认 timeoutMs=300000（5 分钟）
 *   - TC-RL-001d. 自定义 timeoutMs 通过构造函数注入
 *   - TC-RL-001e. 实例被 Object.freeze 冻结
 * - TC-RL-002. execute() 返回 DeployResult 结构正确
 *   - TC-RL-002a. 返回对象含 5 个字段（success / deployedAt / duration / resources / errors）
 *   - TC-RL-002b. success 为 boolean 类型
 *   - TC-RL-002c. deployedAt 为 ISO 8601 字符串
 *   - TC-RL-002d. duration 为非负数
 *   - TC-RL-002e. resources 为数组
 *   - TC-RL-002f. errors 为数组
 * - TC-RL-003. iacTemplates 为空时返回 success=false 不抛异常（错误内化）
 *   - TC-RL-003a. 空数组时 success=false
 *   - TC-RL-003b. errors 含 "IaC 模板为空"
 * - TC-RL-004. kubectl 不可用时返回 success=false + 明确错误信息（spawn ENOENT 路径）
 *   - TC-RL-004a. success=false
 *   - TC-RL-004b. errors 含 "kubectl 命令不可用" 或 kubectl 错误
 *   - TC-RL-004c. 不抛异常（错误内化）
 * - TC-RL-005. 不可变优先（Object.isFrozen 断言）
 *   - TC-RL-005a. 返回的 DeployResult 对象已冻结
 *   - TC-RL-005b. resources 数组已冻结
 *   - TC-RL-005c. errors 数组已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 * - kubectl 不可用测试通过 PATH="/nonexistent" 真实模拟（非 mock）
 * - 真实 kubectl 调用测试通过 checkCliAvailable 检测，不可用时跳过
 *
 * 设计依据：
 * - EAG-P4 批次 14 任务清单 TASK-14-2-4 验收标准
 * - 架构师审查 §4.1.6 RollingStrategy 类契约
 * - B-14-1 Blocker 修复
 *
 * @module core/tests/eag-deploy-strategy-rolling
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { RollingStrategy } from "../eag/deploy/rolling-strategy";
import type { DeployStrategy, DeployContext, DeployResult, IaCTemplate } from "../eag/devops/types";

// ============================================================================
// 辅助函数：检测 CLI 工具是否可用
// ============================================================================

/**
 * 检测 CLI 工具是否可用
 *
 * 通过 spawnSync 调用 `<cli> --version` 检测 CLI 是否存在，非 mock。
 * 用于有条件地运行真实 CLI 测试，CLI 不存在时跳过。
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
    strategyType: "rolling",
    timeoutMs: 300000,
    ...overrides,
  };
}

/**
 * 构造测试用 K8s Manifest IaCTemplate 数组
 *
 * 包含 Deployment + Service 两个资源，用于 RollingStrategy.execute() 真实调用 kubectl。
 *
 * @returns IaCTemplate 数组（Deployment + Service）
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

// ============================================================================
// 检测 kubectl CLI 是否可用
// ============================================================================

const hasKubectl = checkCliAvailable("kubectl");

// ============================================================================
// TC-RL-001. 实例化与接口契约
// ============================================================================

test("TC-RL-001a. RollingStrategy 实例化成功", () => {
  const strategy = new RollingStrategy();
  assert.ok(strategy instanceof RollingStrategy);
});

test('TC-RL-001b. 实现 DeployStrategy 接口（strategyType="rolling"）', () => {
  const strategy: DeployStrategy = new RollingStrategy();
  assert.equal(strategy.strategyType, "rolling");
  assert.equal(typeof strategy.execute, "function");
});

test("TC-RL-001c. 默认 timeoutMs=300000（5 分钟）", () => {
  const strategy = new RollingStrategy();
  assert.equal(strategy.timeoutMs, 300000);
});

test("TC-RL-001d. 自定义 timeoutMs 通过构造函数注入", () => {
  const strategy = new RollingStrategy({ timeoutMs: 60000 });
  assert.equal(strategy.timeoutMs, 60000);
});

test("TC-RL-001e. 实例被 Object.freeze 冻结", () => {
  const strategy = new RollingStrategy();
  assert.equal(Object.isFrozen(strategy), true);
});

// ============================================================================
// TC-RL-002. execute() 返回 DeployResult 结构正确
// ============================================================================

test("TC-RL-002a. 返回对象含 5 个字段（success / deployedAt / duration / resources / errors）", async () => {
  const strategy = new RollingStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  // 验证 5 个字段全部存在
  assert.ok("success" in result);
  assert.ok("deployedAt" in result);
  assert.ok("duration" in result);
  assert.ok("resources" in result);
  assert.ok("errors" in result);
});

test("TC-RL-002b. success 为 boolean 类型", async () => {
  const strategy = new RollingStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(typeof result.success, "boolean");
});

test("TC-RL-002c. deployedAt 为 ISO 8601 字符串", async () => {
  const strategy = new RollingStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(typeof result.deployedAt, "string");
  // ISO 8601 格式校验：含 "T" 与 "Z" 或时区偏移
  assert.ok(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(result.deployedAt),
    `deployedAt 应为 ISO 8601 格式，实际：${result.deployedAt}`
  );
});

test("TC-RL-002d. duration 为非负数", async () => {
  const strategy = new RollingStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(typeof result.duration, "number");
  assert.ok(result.duration >= 0, `duration 应为非负数，实际：${result.duration}`);
});

test("TC-RL-002e. resources 为数组", async () => {
  const strategy = new RollingStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.ok(Array.isArray(result.resources));
});

test("TC-RL-002f. errors 为数组", async () => {
  const strategy = new RollingStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.ok(Array.isArray(result.errors));
});

// ============================================================================
// TC-RL-003. iacTemplates 为空时返回 success=false 不抛异常（错误内化）
// ============================================================================

test("TC-RL-003a. 空数组时 success=false", async () => {
  const strategy = new RollingStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(result.success, false);
});

test('TC-RL-003b. errors 含 "IaC 模板为空"', async () => {
  const strategy = new RollingStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("IaC 模板为空"), `errors 应含 "IaC 模板为空"，实际：${errorsStr}`);
});

test("TC-RL-003c. 不抛异常（错误内化）", async () => {
  const strategy = new RollingStrategy();
  // execute 不应抛异常，应返回结构化 DeployResult
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.ok(result instanceof Object || typeof result === "object");
});

// ============================================================================
// TC-RL-004. kubectl 不可用时返回 success=false + 明确错误信息（spawn ENOENT 路径）
// ============================================================================

test("TC-RL-004a. kubectl 不可用时 success=false", async () => {
  const strategy = new RollingStrategy({ timeoutMs: 5000 });
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await strategy.execute(createDeployContext());
    // kubectl 不可用时：apply 失败 → success=false
    assert.equal(result.success, false);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("TC-RL-004b. kubectl 不可用时 errors 含错误信息", async () => {
  const strategy = new RollingStrategy({ timeoutMs: 5000 });
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await strategy.execute(createDeployContext());
    assert.ok(result.errors.length > 0, "errors 数组应非空");
    const errorsStr = result.errors.join(" ");
    // errors 应含 kubectl 相关错误（"kubectl" 或 "执行失败"）
    assert.ok(
      errorsStr.includes("kubectl") || errorsStr.includes("执行失败"),
      `errors 应含 kubectl 错误，实际：${errorsStr}`
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("TC-RL-004c. kubectl 不可用时不抛异常（错误内化）", async () => {
  const strategy = new RollingStrategy({ timeoutMs: 5000 });
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
// TC-RL-005. 不可变优先（Object.isFrozen 断言）
// ============================================================================

test("TC-RL-005a. 返回的 DeployResult 对象已冻结", async () => {
  const strategy = new RollingStrategy();
  const result: DeployResult = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(Object.isFrozen(result), true);
});

test("TC-RL-005b. resources 数组已冻结", async () => {
  const strategy = new RollingStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(Object.isFrozen(result.resources), true);
});

test("TC-RL-005c. errors 数组已冻结", async () => {
  const strategy = new RollingStrategy();
  const result = await strategy.execute(createDeployContext({ iacTemplates: [] }));
  assert.equal(Object.isFrozen(result.errors), true);
});

// ============================================================================
// TC-RL-006. 真实 kubectl 调用（CLI 存在时，可选测试）
// ============================================================================

test("TC-RL-006. 真实 kubectl 调用（CLI 存在时）", { skip: !hasKubectl }, async () => {
  // 此测试在 kubectl 可用时运行，验证真实 kubectl 调用路径
  // 注意：此测试需要可访问的 K8s 集群，否则 kubectl apply 会失败
  // 测试目的：验证 RollingStrategy.execute() 真实调用 kubectl（非 mock）
  const strategy = new RollingStrategy({ timeoutMs: 30000 });
  const result = await strategy.execute(createDeployContext());

  // 无论 kubectl apply 是否成功（取决于集群可用性），结果应为结构化 DeployResult
  assert.equal(typeof result.success, "boolean");
  assert.ok(Array.isArray(result.errors));
  assert.ok(Array.isArray(result.resources));
  assert.equal(Object.isFrozen(result), true);
});
