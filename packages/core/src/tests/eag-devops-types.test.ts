/**
 * EAG-P4 批次 13 单元测试：DevOps 角色核心类型定义（D1-4 DevOpsTypes）
 *
 * 测试范围（对齐设计文档 §6.2.1 D1-4 DevOpsTypes 100% 覆盖率目标）：
 * - T1. IaCType 字面量联合完整性（terraform / k8s-manifest / helm-chart）
 * - T2. IaCTemplate 接口字段完整性 + Object.freeze 校验
 * - T3. IaCGenerator 接口约束验证（策略模式）
 * - T4. IaCGenerationContext 接口字段完整性
 * - T5. ContainerResources / ResourceSpec / EnvVar / IngressConfig 接口完整性
 * - T6. IaCValidationResult 接口完整性
 * - T7. DeployStrategyType 字面量联合完整性
 * - T8. DeployStrategy / DeployContext / DeployResult / DeployedResource 接口完整性
 * - T9. HealthCheckResult / HealthEndpoint 接口完整性
 * - T10. SmokeTestResult / SmokeTestFailure / SmokeTestCase / SmokeTestRunner 接口完整性
 * - T11. DevOpsEvent discriminated union 完整性（9 种事件类型）
 * - T12. DevOpsContext / DevOpsResult 接口完整性
 * - T13. GateG8Context / GateG8Checker 接口完整性
 * - T14. PreDeployChecker / PreDeployCheckContext / PreDeployCheckResult 接口完整性
 * - T15. PostDeployChecker / PostDeployCheckContext / PostDeployCheckResult 接口完整性
 * - T16. RollbackManager / RollbackSnapshotContext / RollbackSnapshot / RollbackResult 接口完整性
 * - T17. DeployStageOptions / DeployStageResult / DeployStage 接口完整性
 * - T18. DevOpsOrchestratorOptions 接口完整性（N-M-1 修复后字段）
 * - T19. NoOpRollbackManager 类实现完整性
 *   - T19a. createSnapshot() 返回正确结构 + Object.freeze
 *   - T19b. rollback() 返回 success=false + 正确错误消息 + Object.freeze
 *   - T19c. createSnapshot() 不调用任何外部命令（无副作用验证）
 * - T20. LoopType 扩展 "deploy" 验证
 *   - T20a. LOOP_TYPES 包含 "deploy"
 *   - T20b. LOOP_TYPES 已冻结
 * - T21. GateId 扩展 "G-8" 验证
 *   - T21a. GATE_IDS 包含 "G-8"
 *   - T21b. GATE_IDS 已冻结
 * - T22. 批次 14 Phase 1 类型扩展验证（TASK-14-1-1 验收）
 *   - T22a. RollbackSnapshot 含可选 rollbackPlanFilePath 字段（M-14-2 修复）
 *   - T22b. RollbackSnapshotContext 含可选 projectRoot / runId 字段
 *   - T22c. MonitoringReadinessChecker / MonitoringCheckContext / MonitoringCheckResult / MonitoringCheckedItem 接口完整性
 *   - T22d. RollbackPlanChecker / RollbackPlanCheckContext / RollbackPlanCheckResult 接口完整性
 *   - T22e. ROLLBACK_PLAN_SECTIONS 常量含 5 个固定章节 + Object.freeze
 *   - T22f. CanaryConfig / CanaryStrategyOptions / BlueGreenStrategyOptions / RollingStrategyOptions 接口完整性
 *   - T22g. GateG8Context 含可选 monitoringCheckContext / rollbackPlanCheckContext / projectRoot / runId 字段
 *   - T22h. DevOpsContext 含可选 monitoringCheckContext / rollbackPlanCheckContext / projectRoot / runId 字段
 *   - T22i. DevOpsOrchestratorOptions 含可选 monitoringReadinessChecker / rollbackPlanChecker 字段
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 * - 中文详细注释
 *
 * @module core/tests/eag-devops-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { NoOpRollbackManager } from "../eag/devops/rollback-manager";
// 架构师审查 P2-3 修复 v1.4：LOOP_TYPES 权威来源是 loop/models.ts（gate-types.ts 仅 re-export）
import { GATE_IDS } from "../eag/gate/gate-types";
import { LOOP_TYPES } from "../eag/loop/models";
// 批次 14 新增：ROLLBACK_PLAN_SECTIONS 是 const 常量，需要 value import（非 type-only）
import { ROLLBACK_PLAN_SECTIONS } from "../eag/devops/types";
import type {
  BlueGreenStrategyOptions,
  CanaryConfig,
  CanaryStrategyOptions,
  ContainerResources,
  DeployContext,
  DeployResult,
  DeployStage,
  DeployStageOptions,
  DeployStageResult,
  DeployStrategy,
  DeployStrategyType,
  DeployedResource,
  DevOpsContext,
  DevOpsEvent,
  DevOpsEventEmitter,
  DevOpsOrchestratorOptions,
  DevOpsResult,
  EnvVar,
  GateG8Checker,
  GateG8Context,
  HealthCheckResult,
  HealthEndpoint,
  IaCGenerationContext,
  IaCGenerator,
  IaCTemplate,
  IaCType,
  IaCValidationResult,
  IngressConfig,
  MonitoringCheckContext,
  MonitoringCheckResult,
  MonitoringCheckedItem,
  MonitoringReadinessChecker,
  PostDeployCheckContext,
  PostDeployCheckResult,
  PostDeployChecker,
  PreDeployCheckContext,
  PreDeployCheckResult,
  PreDeployChecker,
  ResourceSpec,
  RollbackManager,
  RollbackPlanCheckContext,
  RollbackPlanCheckResult,
  RollbackPlanChecker,
  RollbackResult,
  RollbackSnapshot,
  RollbackSnapshotContext,
  RollingStrategyOptions,
  SmokeTestCase,
  SmokeTestFailure,
  SmokeTestResult,
  SmokeTestRunner,
} from "../eag/devops/types";
import type { TaskCard } from "../eag/doc-driven/types";

// ============================================================================
// 测试辅助：构造真实 TaskCard 对象（避免重复，所有测试复用）
// ============================================================================

/**
 * 构造测试用 TaskCard（真实对象，非 mock）
 *
 * 用于 GateContext.taskCard 字段，DevOpsContext 继承 GateContext 故需要此字段
 */
function createTestTaskCard(): TaskCard {
  return {
    id: "TC-001",
    title: "测试任务卡",
    description: "用于 DevOpsTypes 单元测试的任务卡",
    status: "completed",
    declaredSymbols: [],
    fileCluster: "test-cluster",
  };
}

// ============================================================================
// T1. IaCType 字面量联合完整性
// ============================================================================

test("T1. IaCType 字面量联合覆盖 terraform / k8s-manifest / helm-chart", () => {
  // 通过构造真实数组验证字面量联合
  const types: IaCType[] = ["terraform", "k8s-manifest", "helm-chart"];
  assert.equal(types.length, 3);
  assert.ok(types.includes("terraform"));
  assert.ok(types.includes("k8s-manifest"));
  assert.ok(types.includes("helm-chart"));
});

// ============================================================================
// T2. IaCTemplate 接口字段完整性 + Object.freeze 校验
// ============================================================================

test("T2. IaCTemplate 接口字段完整性 + Object.freeze 校验", () => {
  const template: IaCTemplate = Object.freeze({
    type: "terraform",
    content: 'resource "null_resource" "test" {}\n',
    filePath: "main.tf",
    hash: "abc123def456",
    generatedAt: "2026-07-20T10:00:00.000Z",
  });
  assert.equal(template.type, "terraform");
  assert.equal(template.content, 'resource "null_resource" "test" {}\n');
  assert.equal(template.filePath, "main.tf");
  assert.equal(template.hash, "abc123def456");
  assert.equal(template.generatedAt, "2026-07-20T10:00:00.000Z");
  assert.equal(Object.isFrozen(template), true);
});

// ============================================================================
// T3. IaCGenerator 接口约束验证（策略模式）
// ============================================================================

test("T3. IaCGenerator 接口约束验证（实现类需提供 iacType + generate + validate）", () => {
  // 构造真实的 IaCGenerator 实现（非 mock，验证接口约束）
  const generator: IaCGenerator = {
    iacType: "terraform",
    generate(context: IaCGenerationContext): IaCTemplate[] {
      return [
        Object.freeze({
          type: "terraform",
          content: `# generated for ${context.projectName}\n`,
          filePath: "main.tf",
          hash: "fake-hash",
          generatedAt: "2026-07-20T10:00:00.000Z",
        }),
      ];
    },
    async validate(template: IaCTemplate): Promise<IaCValidationResult> {
      return Object.freeze({
        valid: template.content.length > 0,
        errors: [],
        validatedBy: "terraform-validate",
      });
    },
  };
  assert.equal(generator.iacType, "terraform");
  const templates = generator.generate({
    projectName: "test-project",
    environment: "dev",
    replicas: 1,
    image: "test-image:v1",
    port: 8080,
    resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
    envVars: [],
  });
  assert.equal(templates.length, 1);
  assert.equal(templates[0].filePath, "main.tf");
});

// ============================================================================
// T4. IaCGenerationContext 接口字段完整性
// ============================================================================

test("T4. IaCGenerationContext 接口字段完整性（含可选 ingress）", () => {
  const ctx: IaCGenerationContext = {
    projectName: "myapp",
    environment: "prod",
    replicas: 3,
    image: "registry.example.com/myapp:v1.0.0",
    port: 8080,
    resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
    envVars: [{ name: "DATABASE_URL", value: "postgres://...", fromSecret: true }],
    ingress: { host: "myapp.example.com", path: "/", port: 8080, tlsSecret: "myapp-tls" },
  };
  assert.equal(ctx.projectName, "myapp");
  assert.equal(ctx.environment, "prod");
  assert.equal(ctx.replicas, 3);
  assert.equal(ctx.image, "registry.example.com/myapp:v1.0.0");
  assert.equal(ctx.port, 8080);
  assert.equal(ctx.ingress?.host, "myapp.example.com");
  assert.equal(ctx.ingress?.tlsSecret, "myapp-tls");
});

// ============================================================================
// T5. ContainerResources / ResourceSpec / EnvVar / IngressConfig 接口完整性
// ============================================================================

test("T5a. ContainerResources / ResourceSpec 接口完整性", () => {
  const resources: ContainerResources = {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "500m", memory: "256Mi" },
  };
  assert.equal(resources.requests.cpu, "100m");
  assert.equal(resources.limits.memory, "256Mi");
  const spec: ResourceSpec = { cpu: "1", memory: "1Gi" };
  assert.equal(spec.cpu, "1");
  assert.equal(spec.memory, "1Gi");
});

test("T5b. EnvVar 接口完整性（含可选 fromSecret）", () => {
  const plain: EnvVar = { name: "LOG_LEVEL", value: "info" };
  assert.equal(plain.fromSecret, undefined);
  const secret: EnvVar = { name: "DATABASE_URL", value: "database-url-key", fromSecret: true };
  assert.equal(secret.fromSecret, true);
});

test("T5c. IngressConfig 接口完整性（含可选 tlsSecret）", () => {
  const ingress: IngressConfig = {
    host: "myapp.example.com",
    path: "/api",
    port: 8080,
    tlsSecret: "myapp-tls",
  };
  assert.equal(ingress.host, "myapp.example.com");
  assert.equal(ingress.tlsSecret, "myapp-tls");
});

// ============================================================================
// T6. IaCValidationResult 接口完整性
// ============================================================================

test("T6. IaCValidationResult 接口完整性（含 validatedBy 联合类型）", () => {
  const valid: IaCValidationResult = Object.freeze({
    valid: true,
    errors: [],
    validatedBy: "terraform-validate",
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.errors.length, 0);
  assert.equal(valid.validatedBy, "terraform-validate");

  const invalid: IaCValidationResult = Object.freeze({
    valid: false,
    errors: Object.freeze(["Syntax error at line 5"]),
    validatedBy: "helm-lint",
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors.length, 1);
  assert.equal(invalid.validatedBy, "helm-lint");
});

// ============================================================================
// T7. DeployStrategyType 字面量联合完整性
// ============================================================================

test("T7. DeployStrategyType 字面量联合覆盖 rolling / blue-green / canary", () => {
  const types: DeployStrategyType[] = ["rolling", "blue-green", "canary"];
  assert.equal(types.length, 3);
  assert.ok(types.includes("rolling"));
  assert.ok(types.includes("blue-green"));
  assert.ok(types.includes("canary"));
});

// ============================================================================
// T8. DeployStrategy / DeployContext / DeployResult / DeployedResource 接口完整性
// ============================================================================

test("T8a. DeployStrategy 接口约束验证（策略模式）", async () => {
  const strategy: DeployStrategy = {
    strategyType: "rolling",
    async execute(context: DeployContext): Promise<DeployResult> {
      return Object.freeze({
        success: true,
        deployedAt: "2026-07-20T10:00:00.000Z",
        duration: 30000,
        resources: Object.freeze([]) as DeployedResource[],
        errors: Object.freeze([]) as string[],
      });
    },
  };
  assert.equal(strategy.strategyType, "rolling");
  const result = await strategy.execute({
    runId: "run-001",
    projectName: "myapp",
    environment: "dev",
    iacTemplates: [],
    strategyType: "rolling",
    timeoutMs: 300000,
  });
  assert.equal(result.success, true);
});

test("T8b. DeployContext 接口字段完整性", () => {
  const ctx: DeployContext = {
    runId: "run-001",
    projectName: "myapp",
    environment: "staging",
    iacTemplates: [],
    strategyType: "rolling",
    timeoutMs: 600000,
  };
  assert.equal(ctx.runId, "run-001");
  assert.equal(ctx.environment, "staging");
  assert.equal(ctx.timeoutMs, 600000);
});

test("T8c. DeployResult / DeployedResource 接口完整性", () => {
  const result: DeployResult = Object.freeze({
    success: true,
    deployedAt: "2026-07-20T10:00:00.000Z",
    duration: 30000,
    resources: Object.freeze([
      { kind: "Deployment", name: "myapp", namespace: "default", status: "Running" },
      { kind: "Service", name: "myapp-svc", namespace: "default", status: "Running" },
    ]) as DeployedResource[],
    errors: Object.freeze([]) as string[],
  });
  assert.equal(result.success, true);
  assert.equal(result.resources.length, 2);
  assert.equal(result.resources[0].kind, "Deployment");
  assert.equal(result.resources[1].status, "Running");
});

// ============================================================================
// T9. HealthCheckResult / HealthEndpoint 接口完整性
// ============================================================================

test("T9. HealthCheckResult / HealthEndpoint 接口完整性", () => {
  const health: HealthCheckResult = Object.freeze({
    healthy: true,
    checkedAt: "2026-07-20T10:01:00.000Z",
    endpoints: Object.freeze([
      { url: "http://myapp.example.com/healthz", statusCode: 200, responseTimeMs: 50, healthy: true },
    ]) as HealthEndpoint[],
    failures: Object.freeze([]) as string[],
  });
  assert.equal(health.healthy, true);
  assert.equal(health.endpoints.length, 1);
  assert.equal(health.endpoints[0].statusCode, 200);
  assert.equal(health.endpoints[0].healthy, true);
});

// ============================================================================
// T10. SmokeTestResult / SmokeTestFailure / SmokeTestCase / SmokeTestRunner 接口完整性
// ============================================================================

test("T10a. SmokeTestResult / SmokeTestFailure 接口完整性", () => {
  const result: SmokeTestResult = Object.freeze({
    passed: false,
    totalTests: 2,
    passedTests: 1,
    failedTests: 1,
    duration: 1500,
    failures: Object.freeze([
      {
        testName: "GET /api/users returns 200",
        expected: "HTTP 200",
        actual: "HTTP 500",
        errorMessage: "Internal Server Error",
      },
    ]) as SmokeTestFailure[],
  });
  assert.equal(result.passed, false);
  assert.equal(result.passedTests, 1);
  assert.equal(result.failedTests, 1);
  assert.equal(result.failures[0].testName, "GET /api/users returns 200");
});

test("T10b. SmokeTestCase 接口完整性（含可选 expectedBodyContains）", () => {
  const tc1: SmokeTestCase = {
    name: "GET /healthz returns 200",
    method: "GET",
    path: "/healthz",
    expectedStatusCode: 200,
  };
  assert.equal(tc1.expectedBodyContains, undefined);

  const tc2: SmokeTestCase = {
    name: "POST /api/users returns 201",
    method: "POST",
    path: "/api/users",
    expectedStatusCode: 201,
    expectedBodyContains: '"id":',
  };
  assert.equal(tc2.expectedBodyContains, '"id":');
});

test("T10c. SmokeTestRunner 接口约束验证", async () => {
  const runner: SmokeTestRunner = {
    async run(endpoints: ReadonlyArray<string>, testCases: ReadonlyArray<SmokeTestCase>): Promise<SmokeTestResult> {
      return Object.freeze({
        passed: endpoints.length > 0 && testCases.length > 0,
        totalTests: testCases.length,
        passedTests: testCases.length,
        failedTests: 0,
        duration: 100,
        failures: Object.freeze([]) as SmokeTestFailure[],
      });
    },
  };
  const result = await runner.run(
    ["http://myapp.example.com"],
    [{ name: "GET /healthz", method: "GET", path: "/healthz", expectedStatusCode: 200 }]
  );
  assert.equal(result.passed, true);
  assert.equal(result.totalTests, 1);
});

// ============================================================================
// T11. DevOpsEvent discriminated union 完整性（9 种事件类型）
// ============================================================================

test("T11. DevOpsEvent discriminated union 覆盖 9 种事件类型", () => {
  const events: DevOpsEvent[] = [
    { type: "devops-started", runId: "r1", timestamp: "2026-07-20T10:00:00.000Z" },
    { type: "iac-generated", runId: "r1", templates: [], timestamp: "2026-07-20T10:00:01.000Z" },
    { type: "pre-deploy-check-passed", runId: "r1", timestamp: "2026-07-20T10:00:02.000Z" },
    { type: "deploy-started", runId: "r1", timestamp: "2026-07-20T10:00:03.000Z" },
    {
      type: "deploy-completed",
      runId: "r1",
      result: {
        success: true,
        deployedAt: "2026-07-20T10:00:30.000Z",
        duration: 30000,
        resources: [],
        errors: [],
      },
      timestamp: "2026-07-20T10:00:30.000Z",
    },
    { type: "post-deploy-check-passed", runId: "r1", timestamp: "2026-07-20T10:00:31.000Z" },
    {
      type: "smoke-test-passed",
      runId: "r1",
      result: {
        passed: true,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        duration: 100,
        failures: [],
      },
      timestamp: "2026-07-20T10:00:32.000Z",
    },
    {
      type: "devops-completed",
      runId: "r1",
      result: {
        success: true,
        runId: "r1",
        startedAt: "2026-07-20T10:00:00.000Z",
        finishedAt: "2026-07-20T10:00:33.000Z",
        duration: 33000,
        iacTemplates: [],
        gateResult: { passed: true, gate: "G-8", reason: "ok", severity: "blocker" },
        errors: [],
      },
      timestamp: "2026-07-20T10:00:33.000Z",
    },
    { type: "devops-failed", runId: "r1", error: "deploy failed", timestamp: "2026-07-20T10:00:34.000Z" },
  ];
  assert.equal(events.length, 9);

  // 验证 discriminated union 的 type 字段覆盖全部 9 种事件
  const eventTypes = events.map((e) => e.type);
  const expectedTypes: DevOpsEvent["type"][] = [
    "devops-started",
    "iac-generated",
    "pre-deploy-check-passed",
    "deploy-started",
    "deploy-completed",
    "post-deploy-check-passed",
    "smoke-test-passed",
    "devops-completed",
    "devops-failed",
  ];
  assert.deepEqual(eventTypes, expectedTypes);
});

test("T11b. DevOpsEventEmitter 接口约束验证", () => {
  const received: DevOpsEvent[] = [];
  const emitter: DevOpsEventEmitter = {
    emit(event: DevOpsEvent): void {
      received.push(event);
    },
  };
  const event: DevOpsEvent = { type: "devops-started", runId: "r1", timestamp: "2026-07-20T10:00:00.000Z" };
  emitter.emit(event);
  assert.equal(received.length, 1);
  assert.equal(received[0].type, "devops-started");
});

// ============================================================================
// T12. DevOpsContext / DevOpsResult 接口完整性
// ============================================================================

test("T12a. DevOpsContext 接口字段完整性（含可选 monitoringReady / rollbackPlanExists）", () => {
  const ctx: DevOpsContext = {
    projectId: "myapp",
    loopType: "deploy",
    specStatus: "approved",
    planStatus: "approved",
    reviewRecords: [],
    userApproved: true,
    taskCard: createTestTaskCard(),
    actualChanges: [],
    iacGenerationContext: {
      projectName: "myapp",
      environment: "dev",
      replicas: 1,
      image: "myapp:v1",
      port: 8080,
      resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
      envVars: [],
    },
    deployContext: {
      runId: "run-001",
      projectName: "myapp",
      environment: "dev",
      iacTemplates: [],
      strategyType: "rolling",
      timeoutMs: 300000,
    },
    smokeTestCases: [{ name: "GET /healthz", method: "GET", path: "/healthz", expectedStatusCode: 200 }],
    monitoringReady: true,
    rollbackPlanExists: true,
  };
  assert.equal(ctx.loopType, "deploy");
  assert.equal(ctx.iacGenerationContext.projectName, "myapp");
  assert.equal(ctx.smokeTestCases.length, 1);
  assert.equal(ctx.monitoringReady, true);
  assert.equal(ctx.rollbackPlanExists, true);
});

test("T12b. DevOpsResult 接口字段完整性（含可选 deployResult / healthCheckResult / smokeTestResult）", () => {
  const result: DevOpsResult = Object.freeze({
    success: true,
    runId: "run-001",
    startedAt: "2026-07-20T10:00:00.000Z",
    finishedAt: "2026-07-20T10:01:00.000Z",
    duration: 60000,
    iacTemplates: [],
    deployResult: {
      success: true,
      deployedAt: "2026-07-20T10:00:30.000Z",
      duration: 30000,
      resources: [],
      errors: [],
    },
    healthCheckResult: {
      healthy: true,
      checkedAt: "2026-07-20T10:00:45.000Z",
      endpoints: [],
      failures: [],
    },
    smokeTestResult: {
      passed: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      duration: 100,
      failures: [],
    },
    gateResult: {
      passed: true,
      gate: "G-8",
      reason: "全部 6 项部署就绪条件已满足",
      severity: "blocker",
    },
    errors: [],
  });
  assert.equal(result.success, true);
  assert.equal(result.gateResult.gate, "G-8");
  assert.equal(result.deployResult?.success, true);
  assert.equal(result.healthCheckResult?.healthy, true);
  assert.equal(result.smokeTestResult?.passed, true);
  assert.equal(Object.isFrozen(result), true);
});

// ============================================================================
// T13. GateG8Context / GateG8Checker 接口完整性
// ============================================================================

test("T13a. GateG8Context 接口字段完整性", () => {
  const ctx: GateG8Context = {
    projectId: "myapp",
    loopType: "deploy",
    specStatus: "approved",
    planStatus: "approved",
    reviewRecords: [],
    userApproved: true,
    taskCard: createTestTaskCard(),
    actualChanges: [],
    iacTemplates: [],
    deployResult: {
      success: true,
      deployedAt: "2026-07-20T10:00:30.000Z",
      duration: 30000,
      resources: [],
      errors: [],
    },
    healthCheckResult: {
      healthy: true,
      checkedAt: "2026-07-20T10:00:45.000Z",
      endpoints: [],
      failures: [],
    },
    smokeTestResult: {
      passed: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      duration: 100,
      failures: [],
    },
    monitoringReady: true,
    rollbackPlanExists: true,
  };
  assert.equal(ctx.loopType, "deploy");
  assert.equal(ctx.monitoringReady, true);
  assert.equal(ctx.rollbackPlanExists, true);
});

test('T13b. GateG8Checker 接口约束验证（gateId 固定为 "G-8"）', () => {
  const checker: GateG8Checker = {
    gateId: "G-8",
    check(context: GateG8Context): {
      passed: boolean;
      gate: "G-8";
      reason: string;
      severity: "blocker" | "major" | "warning";
    } {
      const passed =
        context.deployResult.success && context.healthCheckResult.healthy && context.smokeTestResult.passed;
      return Object.freeze({
        passed,
        gate: "G-8",
        reason: passed ? "全部 6 项部署就绪条件已满足" : "存在未通过的部署就绪条件",
        severity: "blocker",
      }) as ReturnType<GateG8Checker["check"]>;
    },
  };
  assert.equal(checker.gateId, "G-8");
});

// ============================================================================
// T14. PreDeployChecker / PreDeployCheckContext / PreDeployCheckResult 接口完整性
// ============================================================================

test("T14. PreDeployChecker 接口约束验证 + Context / Result 字段完整性", async () => {
  const checker: PreDeployChecker = {
    async check(context: PreDeployCheckContext): Promise<PreDeployCheckResult> {
      return Object.freeze({
        passed: context.image.length > 0,
        imageBuilt: true,
        configValid: true,
        dependenciesAvailable: true,
        resourceQuotaSufficient: true,
        failures: Object.freeze([]) as string[],
      });
    },
  };
  const ctx: PreDeployCheckContext = {
    projectName: "myapp",
    environment: "dev",
    image: "myapp:v1",
    iacTemplates: [],
  };
  const result = await checker.check(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.imageBuilt, true);
  assert.equal(result.configValid, true);
  assert.equal(result.dependenciesAvailable, true);
  assert.equal(result.resourceQuotaSufficient, true);
  assert.equal(result.failures.length, 0);
});

// ============================================================================
// T15. PostDeployChecker / PostDeployCheckContext / PostDeployCheckResult 接口完整性
// ============================================================================

test("T15. PostDeployChecker 接口约束验证 + Context / Result 字段完整性（含 endpoints）", async () => {
  const checker: PostDeployChecker = {
    async check(context: PostDeployCheckContext): Promise<PostDeployCheckResult> {
      return Object.freeze({
        passed: context.deployedResources.length > 0,
        podsReady: true,
        serviceEndpointReachable: true,
        logsClean: true,
        metricsReporting: true,
        endpoints: Object.freeze([
          {
            url: `http://${context.serviceName}.${context.namespace}.svc.cluster.local/healthz`,
            statusCode: 200,
            responseTimeMs: 50,
            healthy: true,
          },
        ]) as HealthEndpoint[],
        failures: Object.freeze([]) as string[],
      });
    },
  };
  const ctx: PostDeployCheckContext = {
    namespace: "default",
    serviceName: "myapp-svc",
    deployedResources: [{ kind: "Deployment", name: "myapp", namespace: "default", status: "Running" }],
  };
  const result = await checker.check(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.podsReady, true);
  assert.equal(result.endpoints.length, 1);
  assert.equal(result.endpoints[0].url, "http://myapp-svc.default.svc.cluster.local/healthz");
});

// ============================================================================
// T16. RollbackManager / RollbackSnapshotContext / RollbackSnapshot / RollbackResult 接口完整性
// ============================================================================

test("T16a. RollbackManager 接口约束验证", async () => {
  const manager: RollbackManager = {
    async createSnapshot(context: RollbackSnapshotContext): Promise<RollbackSnapshot> {
      return Object.freeze({
        snapshotId: `snap-${Date.now()}`,
        createdAt: new Date().toISOString(),
        version: context.previousVersion ?? "v1.0.0",
        resources: Object.freeze(["deployment/myapp"]) as ReadonlyArray<string>,
      });
    },
    async rollback(snapshot: RollbackSnapshot): Promise<RollbackResult> {
      return Object.freeze({
        success: true,
        rolledBackTo: snapshot.version,
        duration: 5000,
        errors: Object.freeze([]) as string[],
      });
    },
  };
  const snapshot = await manager.createSnapshot({
    projectName: "myapp",
    namespace: "default",
    previousVersion: "v1.0.0",
  });
  assert.equal(snapshot.version, "v1.0.0");
  assert.equal(snapshot.resources.length, 1);

  const result = await manager.rollback(snapshot);
  assert.equal(result.success, true);
  assert.equal(result.rolledBackTo, "v1.0.0");
});

// ============================================================================
// T17. DeployStageOptions / DeployStageResult / DeployStage 接口完整性
// ============================================================================

test("T17a. DeployStageOptions 接口字段完整性（含可选 rollbackManager）", () => {
  const options: DeployStageOptions = {
    preDeployChecker: {
      async check() {
        return Object.freeze({
          passed: true,
          imageBuilt: true,
          configValid: true,
          dependenciesAvailable: true,
          resourceQuotaSufficient: true,
          failures: [],
        });
      },
    },
    postDeployChecker: {
      async check() {
        return Object.freeze({
          passed: true,
          podsReady: true,
          serviceEndpointReachable: true,
          logsClean: true,
          metricsReporting: true,
          endpoints: [],
          failures: [],
        });
      },
    },
    smokeTestRunner: {
      async run() {
        return Object.freeze({
          passed: true,
          totalTests: 0,
          passedTests: 0,
          failedTests: 0,
          duration: 0,
          failures: [],
        });
      },
    },
    // rollbackManager 可选，未注入
  };
  // 架构师审查 P2-4 修复 v1.4：原 assert.equal(options.preDeployChecker.constructor, Object)
  // 不能验证接口约束，改为直接验证 check 方法存在（接口协议校验）
  assert.equal(typeof options.preDeployChecker.check, "function");
  assert.equal(options.rollbackManager, undefined);
});

test("T17b. DeployStageResult 接口字段完整性（含 healthEndpoints + rollbackResult）", () => {
  const result: DeployStageResult = Object.freeze({
    success: false,
    preDeployPassed: true,
    deployResult: {
      success: false,
      deployedAt: "2026-07-20T10:00:30.000Z",
      duration: 30000,
      resources: [],
      errors: Object.freeze(["kubectl apply failed"]) as string[],
    },
    postDeployPassed: false,
    smokeTestResult: undefined,
    healthEndpoints: Object.freeze([
      { url: "http://myapp/healthz", statusCode: 503, responseTimeMs: 1000, healthy: false },
    ]) as HealthEndpoint[],
    rollbackExecuted: true,
    rollbackResult: {
      success: true,
      rolledBackTo: "v1.0.0",
      duration: 5000,
      errors: [],
    },
    errors: Object.freeze(["deploy failed", "rollback executed"]) as string[],
  });
  assert.equal(result.success, false);
  assert.equal(result.preDeployPassed, true);
  assert.equal(result.healthEndpoints.length, 1);
  assert.equal(result.healthEndpoints[0].healthy, false);
  assert.equal(result.rollbackExecuted, true);
  assert.equal(result.rollbackResult?.rolledBackTo, "v1.0.0");
  assert.equal(Object.isFrozen(result), true);
});

test("T17c. DeployStage 接口约束验证（execute 方法签名）", async () => {
  const stage: DeployStage = {
    async execute(context, iacTemplates, deployStrategy): Promise<DeployStageResult> {
      // 真实实现需要 4 步编排，此处仅验证接口约束（返回结构正确的 DeployStageResult）
      void context;
      void iacTemplates;
      void deployStrategy;
      return Object.freeze({
        success: true,
        preDeployPassed: true,
        postDeployPassed: true,
        healthEndpoints: Object.freeze([]) as HealthEndpoint[],
        rollbackExecuted: false,
        errors: Object.freeze([]) as string[],
      });
    },
  };
  const result = await stage.execute(
    {
      projectId: "myapp",
      loopType: "deploy",
      specStatus: "approved",
      planStatus: "approved",
      reviewRecords: [],
      userApproved: true,
      taskCard: createTestTaskCard(),
      actualChanges: [],
      iacGenerationContext: {
        projectName: "myapp",
        environment: "dev",
        replicas: 1,
        image: "myapp:v1",
        port: 8080,
        resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
        envVars: [],
      },
      deployContext: {
        runId: "run-001",
        projectName: "myapp",
        environment: "dev",
        iacTemplates: [],
        strategyType: "rolling",
        timeoutMs: 300000,
      },
      smokeTestCases: [],
    },
    [],
    {
      strategyType: "rolling",
      async execute() {
        return Object.freeze({ success: true, deployedAt: "", duration: 0, resources: [], errors: [] });
      },
    }
  );
  assert.equal(result.success, true);
});

// ============================================================================
// T18. DevOpsOrchestratorOptions 接口完整性（N-M-1 修复后字段）
// ============================================================================

test("T18. DevOpsOrchestratorOptions 接口完整性（N-M-1 修复后仅 5 个字段）", () => {
  const options: DevOpsOrchestratorOptions = {
    iacGenerators: [
      {
        iacType: "terraform",
        generate() {
          return [];
        },
        async validate() {
          return Object.freeze({ valid: true, errors: [], validatedBy: "terraform-validate" });
        },
      },
    ],
    gateG8Checker: {
      gateId: "G-8",
      check() {
        return Object.freeze({ passed: true, gate: "G-8", reason: "ok", severity: "blocker" }) as ReturnType<
          GateG8Checker["check"]
        >;
      },
    },
    deployStrategy: {
      strategyType: "rolling",
      async execute() {
        return Object.freeze({ success: true, deployedAt: "", duration: 0, resources: [], errors: [] });
      },
    },
    deployStage: {
      async execute() {
        return Object.freeze({
          success: true,
          preDeployPassed: true,
          postDeployPassed: true,
          healthEndpoints: [],
          rollbackExecuted: false,
          errors: [],
        });
      },
    },
    // eventEmitter 可选，未注入
  };
  assert.equal(options.iacGenerators.length, 1);
  assert.equal(options.gateG8Checker.gateId, "G-8");
  assert.equal(options.deployStrategy.strategyType, "rolling");
  assert.equal(options.eventEmitter, undefined);

  // N-M-1 修复验证：DevOpsOrchestratorOptions 不应包含 preDeployChecker / postDeployChecker / smokeTestRunner / rollbackManager 字段
  // 通过类型系统保证（TS 编译期校验），运行期不直接断言这些字段不存在
  // 此处仅验证 5 个字段全部存在
  assert.ok("iacGenerators" in options);
  assert.ok("gateG8Checker" in options);
  assert.ok("deployStrategy" in options);
  assert.ok("deployStage" in options);
});

// ============================================================================
// T19. NoOpRollbackManager 类实现完整性
// ============================================================================

test("T19a. NoOpRollbackManager.createSnapshot() 返回正确结构 + Object.freeze", async () => {
  const manager = new NoOpRollbackManager();
  const snapshot = await manager.createSnapshot({
    projectName: "myapp",
    namespace: "default",
  });
  // 验证 snapshotId 以 "noop-" 前缀开头
  assert.ok(snapshot.snapshotId.startsWith("noop-"), `snapshotId 应以 "noop-" 开头，实际值：${snapshot.snapshotId}`);
  // 验证 version 固定为 "unknown"
  assert.equal(snapshot.version, "unknown");
  // 验证 resources 为空数组
  assert.equal(snapshot.resources.length, 0);
  // 验证 createdAt 是有效的 ISO 8601 时间戳
  assert.ok(
    !isNaN(Date.parse(snapshot.createdAt)),
    `createdAt 应为有效 ISO 8601 时间戳，实际值：${snapshot.createdAt}`
  );
  // 验证返回值被 Object.freeze 冻结
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.resources), true);
});

test("T19b. NoOpRollbackManager.rollback() 返回 success=false + 正确错误消息 + Object.freeze", async () => {
  const manager = new NoOpRollbackManager();
  // 先创建一个快照用于 rollback() 调用
  const snapshot = await manager.createSnapshot({
    projectName: "myapp",
    namespace: "default",
  });
  const result = await manager.rollback(snapshot);
  // 验证 success 固定为 false
  assert.equal(result.success, false);
  // 验证 rolledBackTo 固定为 "none"
  assert.equal(result.rolledBackTo, "none");
  // 验证 duration 固定为 0
  assert.equal(result.duration, 0);
  // 验证 errors 包含明确的错误消息（提及 NoOpRollbackManager + 建议手动执行）
  assert.equal(result.errors.length, 1);
  const errorMsg = result.errors[0];
  assert.ok(errorMsg.includes("NoOpRollbackManager"), `错误消息应包含 "NoOpRollbackManager"，实际值：${errorMsg}`);
  assert.ok(
    errorMsg.includes("kubectl rollout undo"),
    `错误消息应建议手动执行 "kubectl rollout undo"，实际值：${errorMsg}`
  );
  assert.ok(errorMsg.includes("helm rollback"), `错误消息应建议手动执行 "helm rollback"，实际值：${errorMsg}`);
  assert.ok(errorMsg.includes(snapshot.snapshotId), `错误消息应包含 snapshotId，实际值：${errorMsg}`);
  // 验证返回值被 Object.freeze 冻结
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.errors), true);
});

test("T19c. NoOpRollbackManager 不调用任何外部命令（无副作用验证）", async () => {
  // NoOpRollbackManager 是占位实现，不应调用 kubectl / helm / docker 等外部命令
  // 此处通过验证 createSnapshot() 的执行时间极短（< 50ms，无外部命令调用）来确认无副作用
  const manager = new NoOpRollbackManager();
  const start = Date.now();
  await manager.createSnapshot({ projectName: "myapp", namespace: "default" });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 50, `createSnapshot() 应在 50ms 内完成（无外部命令调用），实际耗时：${elapsed}ms`);

  const snapshot = await manager.createSnapshot({ projectName: "myapp", namespace: "default" });
  const start2 = Date.now();
  await manager.rollback(snapshot);
  const elapsed2 = Date.now() - start2;
  assert.ok(elapsed2 < 50, `rollback() 应在 50ms 内完成（无外部命令调用），实际耗时：${elapsed2}ms`);
});

// ============================================================================
// T20. LoopType 扩展 "deploy" 验证
// ============================================================================

test('T20a. LOOP_TYPES 包含 "deploy"（批次 13 扩展）', () => {
  assert.ok(LOOP_TYPES.includes("deploy"), `LOOP_TYPES 应包含 "deploy"，实际值：${JSON.stringify(LOOP_TYPES)}`);
  assert.equal(LOOP_TYPES.length, 4, `LOOP_TYPES 应有 4 个元素，实际值：${LOOP_TYPES.length}`);
});

test("T20b. LOOP_TYPES 已冻结", () => {
  assert.equal(Object.isFrozen(LOOP_TYPES), true);
});

// ============================================================================
// T21. GateId 扩展 "G-8" 验证
// ============================================================================

test('T21a. GATE_IDS 包含 "G-8"（批次 13 扩展）', () => {
  assert.ok(GATE_IDS.includes("G-8"), `GATE_IDS 应包含 "G-8"，实际值：${JSON.stringify(GATE_IDS)}`);
  assert.equal(GATE_IDS.length, 8, `GATE_IDS 应有 8 个元素，实际值：${GATE_IDS.length}`);
});

test("T21b. GATE_IDS 已冻结", () => {
  assert.equal(Object.isFrozen(GATE_IDS), true);
});

// ============================================================================
// T22. 批次 14 Phase 1 类型扩展验证（TASK-14-1-1 验收）
// ============================================================================

test("T22a. RollbackSnapshot 含可选 rollbackPlanFilePath 字段（M-14-2 修复，向后兼容）", () => {
  // 验证 1：不提供 rollbackPlanFilePath（向后兼容，批次 13 NoOpRollbackManager 行为）
  const snapshotWithoutPlan: RollbackSnapshot = Object.freeze({
    snapshotId: "snap-001",
    createdAt: "2026-07-21T10:00:00.000Z",
    version: "v1.0.0",
    resources: Object.freeze(["deployment/myapp"]) as ReadonlyArray<string>,
  });
  assert.equal(snapshotWithoutPlan.rollbackPlanFilePath, undefined);
  assert.equal(snapshotWithoutPlan.snapshotId, "snap-001");

  // 验证 2：提供 rollbackPlanFilePath（批次 14 新增字段）
  const snapshotWithPlan: RollbackSnapshot = Object.freeze({
    snapshotId: "snap-002",
    createdAt: "2026-07-21T11:00:00.000Z",
    version: "v1.1.0",
    resources: Object.freeze(["deployment/myapp", "service/myapp"]) as ReadonlyArray<string>,
    rollbackPlanFilePath: "/project/deploy/rollback-plan-run-001.md",
  });
  assert.equal(snapshotWithPlan.rollbackPlanFilePath, "/project/deploy/rollback-plan-run-001.md");
  assert.equal(Object.isFrozen(snapshotWithPlan), true);
});

test("T22b. RollbackSnapshotContext 含可选 projectRoot / runId 字段（向后兼容）", () => {
  // 验证 1：不提供 projectRoot / runId（向后兼容，批次 13 行为）
  const ctxLegacy: RollbackSnapshotContext = {
    projectName: "myapp",
    namespace: "default",
    previousVersion: "v1.0.0",
  };
  assert.equal(ctxLegacy.projectRoot, undefined);
  assert.equal(ctxLegacy.runId, undefined);

  // 验证 2：提供 projectRoot / runId（批次 14 新增字段）
  const ctxExtended: RollbackSnapshotContext = {
    projectName: "myapp",
    namespace: "default",
    previousVersion: "v1.0.0",
    projectRoot: "/path/to/project",
    runId: "run-001",
  };
  assert.equal(ctxExtended.projectRoot, "/path/to/project");
  assert.equal(ctxExtended.runId, "run-001");
});

test("T22c. MonitoringReadinessChecker / MonitoringCheckContext / MonitoringCheckResult / MonitoringCheckedItem 接口完整性", async () => {
  // 验证 MonitoringCheckContext 接口字段完整性
  const monCtx: MonitoringCheckContext = {
    projectName: "myapp",
    namespace: "default",
    serviceName: "myapp-svc",
    metricsEndpoint: "http://myapp.default.svc.cluster.local:8080/metrics",
    prometheusConfigPath: "/etc/prometheus/prometheus.yml",
  };
  assert.equal(monCtx.projectName, "myapp");
  assert.equal(monCtx.metricsEndpoint, "http://myapp.default.svc.cluster.local:8080/metrics");
  assert.equal(monCtx.prometheusConfigPath, "/etc/prometheus/prometheus.yml");

  // 验证 MonitoringCheckedItem 接口字段完整性
  const item: MonitoringCheckedItem = Object.freeze({
    name: "serviceMonitorExists",
    passed: true,
    detail: "ServiceMonitor/myapp-monitor found in namespace default",
  });
  assert.equal(item.name, "serviceMonitorExists");
  assert.equal(item.passed, true);
  assert.equal(item.detail, "ServiceMonitor/myapp-monitor found in namespace default");

  // 验证 MonitoringCheckResult 接口字段完整性
  const monResult: MonitoringCheckResult = Object.freeze({
    ready: true,
    checkedItems: Object.freeze([item]) as ReadonlyArray<MonitoringCheckedItem>,
    failures: Object.freeze([]) as ReadonlyArray<string>,
  });
  assert.equal(monResult.ready, true);
  assert.equal(monResult.checkedItems.length, 1);
  assert.equal(monResult.failures.length, 0);
  assert.equal(Object.isFrozen(monResult), true);

  // 验证 MonitoringReadinessChecker 接口约束（实现类需提供 check 方法）
  const checker: MonitoringReadinessChecker = {
    async check(context: MonitoringCheckContext): Promise<MonitoringCheckResult> {
      return Object.freeze({
        ready: context.metricsEndpoint.length > 0,
        checkedItems: Object.freeze([
          { name: "metricsEndpointReachable", passed: true, detail: `HTTP 200 from ${context.metricsEndpoint}` },
        ]) as ReadonlyArray<MonitoringCheckedItem>,
        failures: Object.freeze([]) as ReadonlyArray<string>,
      });
    },
  };
  assert.equal(typeof checker.check, "function");
  const result = await checker.check(monCtx);
  assert.equal(result.ready, true);
});

test("T22d. RollbackPlanChecker / RollbackPlanCheckContext / RollbackPlanCheckResult 接口完整性", async () => {
  // 验证 RollbackPlanCheckContext 接口字段完整性
  const planCtx: RollbackPlanCheckContext = {
    projectRoot: "/path/to/project",
    runId: "run-001",
  };
  assert.equal(planCtx.projectRoot, "/path/to/project");
  assert.equal(planCtx.runId, "run-001");

  // 验证 RollbackPlanCheckResult 接口字段完整性
  const planResult: RollbackPlanCheckResult = Object.freeze({
    exists: true,
    valid: true,
    filePath: "/path/to/project/deploy/rollback-plan-run-001.md",
    failures: Object.freeze([]) as ReadonlyArray<string>,
  });
  assert.equal(planResult.exists, true);
  assert.equal(planResult.valid, true);
  assert.equal(planResult.filePath, "/path/to/project/deploy/rollback-plan-run-001.md");
  assert.equal(planResult.failures.length, 0);
  assert.equal(Object.isFrozen(planResult), true);

  // 验证 RollbackPlanChecker 接口约束（实现类需提供 check 方法）
  const checker: RollbackPlanChecker = {
    async check(context: RollbackPlanCheckContext): Promise<RollbackPlanCheckResult> {
      return Object.freeze({
        exists: context.projectRoot.length > 0,
        valid: context.runId.length > 0,
        filePath: `${context.projectRoot}/deploy/rollback-plan-${context.runId}.md`,
        failures: Object.freeze([]) as ReadonlyArray<string>,
      });
    },
  };
  assert.equal(typeof checker.check, "function");
  const result = await checker.check(planCtx);
  assert.equal(result.exists, true);
  assert.equal(result.filePath, "/path/to/project/deploy/rollback-plan-run-001.md");
});

test("T22e. ROLLBACK_PLAN_SECTIONS 常量含 5 个固定章节 + Object.freeze", () => {
  // 验证常量被 Object.freeze 冻结
  assert.equal(Object.isFrozen(ROLLBACK_PLAN_SECTIONS), true);
  // 验证含 5 个章节
  assert.equal(ROLLBACK_PLAN_SECTIONS.length, 5);
  // 验证章节内容（K-1 决策：目标版本号 / 回滚命令 / 资源清单 / 创建时间戳 / runId）
  assert.equal(ROLLBACK_PLAN_SECTIONS[0], "目标版本号");
  assert.equal(ROLLBACK_PLAN_SECTIONS[1], "回滚命令");
  assert.equal(ROLLBACK_PLAN_SECTIONS[2], "资源清单");
  assert.equal(ROLLBACK_PLAN_SECTIONS[3], "创建时间戳");
  assert.equal(ROLLBACK_PLAN_SECTIONS[4], "runId");
  // 验证包含全部 5 个章节（顺序无关检查）
  assert.ok(ROLLBACK_PLAN_SECTIONS.includes("目标版本号"));
  assert.ok(ROLLBACK_PLAN_SECTIONS.includes("回滚命令"));
  assert.ok(ROLLBACK_PLAN_SECTIONS.includes("资源清单"));
  assert.ok(ROLLBACK_PLAN_SECTIONS.includes("创建时间戳"));
  assert.ok(ROLLBACK_PLAN_SECTIONS.includes("runId"));
});

test("T22f. CanaryConfig / CanaryStrategyOptions / BlueGreenStrategyOptions / RollingStrategyOptions 接口完整性", () => {
  // 验证 RollingStrategyOptions 接口字段完整性（含可选 timeoutMs）
  const rollingOpts: RollingStrategyOptions = { timeoutMs: 300000 };
  assert.equal(rollingOpts.timeoutMs, 300000);
  const rollingOptsDefault: RollingStrategyOptions = {};
  assert.equal(rollingOptsDefault.timeoutMs, undefined);

  // 验证 BlueGreenStrategyOptions 接口字段完整性（含可选 timeoutMs / keepBlue）
  const blueGreenOpts: BlueGreenStrategyOptions = { timeoutMs: 300000, keepBlue: true };
  assert.equal(blueGreenOpts.timeoutMs, 300000);
  assert.equal(blueGreenOpts.keepBlue, true);
  const blueGreenOptsDefault: BlueGreenStrategyOptions = {};
  assert.equal(blueGreenOptsDefault.keepBlue, undefined);

  // 验证 CanaryConfig 接口字段完整性（必填 canarySteps）
  const canaryCfg: CanaryConfig = {
    canarySteps: Object.freeze([25, 50, 100]) as ReadonlyArray<number>,
  };
  assert.equal(canaryCfg.canarySteps.length, 3);
  assert.equal(canaryCfg.canarySteps[2], 100);

  // 验证 CanaryStrategyOptions 扩展 CanaryConfig（含 canarySteps + healthCheckTimeoutMs + healthCheckPath）
  const canaryOpts: CanaryStrategyOptions = {
    canarySteps: Object.freeze([10, 50, 100]) as ReadonlyArray<number>,
    healthCheckTimeoutMs: 60000,
    healthCheckPath: "/healthz",
  };
  assert.equal(canaryOpts.canarySteps.length, 3);
  assert.equal(canaryOpts.healthCheckTimeoutMs, 60000);
  assert.equal(canaryOpts.healthCheckPath, "/healthz");

  // 验证 CanaryStrategyOptions 可省略可选字段（仅 canarySteps 必填）
  const canaryOptsMinimal: CanaryStrategyOptions = {
    canarySteps: Object.freeze([100]) as ReadonlyArray<number>,
  };
  assert.equal(canaryOptsMinimal.canarySteps.length, 1);
  assert.equal(canaryOptsMinimal.healthCheckTimeoutMs, undefined);
  assert.equal(canaryOptsMinimal.healthCheckPath, undefined);
});

test("T22g. GateG8Context 含可选 monitoringCheckContext / rollbackPlanCheckContext / projectRoot / runId 字段（向后兼容）", () => {
  // 构造测试 TaskCard（GateContext 必填字段）
  const taskCard = createTestTaskCard();

  // 验证 1：批次 13 既有字段（不提供批次 14 新增可选字段，向后兼容）
  const ctxLegacy: GateG8Context = {
    projectId: "myapp",
    loopType: "deploy",
    specStatus: "approved",
    planStatus: "approved",
    reviewRecords: [],
    userApproved: true,
    taskCard,
    actualChanges: [],
    iacTemplates: Object.freeze([]) as ReadonlyArray<IaCTemplate>,
    deployResult: {
      success: true,
      deployedAt: "2026-07-21T10:00:00.000Z",
      duration: 30000,
      resources: Object.freeze([]) as ReadonlyArray<DeployedResource>,
      errors: Object.freeze([]) as ReadonlyArray<string>,
    },
    healthCheckResult: {
      healthy: true,
      checkedAt: "2026-07-21T10:00:30.000Z",
      endpoints: Object.freeze([]) as ReadonlyArray<HealthEndpoint>,
      failures: Object.freeze([]) as ReadonlyArray<string>,
    },
    smokeTestResult: {
      passed: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      duration: 500,
      failures: Object.freeze([]) as ReadonlyArray<SmokeTestFailure>,
    },
    monitoringReady: true,
    rollbackPlanExists: true,
  };
  assert.equal(ctxLegacy.monitoringCheckContext, undefined);
  assert.equal(ctxLegacy.rollbackPlanCheckContext, undefined);
  assert.equal(ctxLegacy.projectRoot, undefined);
  assert.equal(ctxLegacy.runId, undefined);

  // 验证 2：批次 14 新增可选字段（提供全部新字段）
  const ctxExtended: GateG8Context = {
    ...ctxLegacy,
    monitoringCheckContext: {
      projectName: "myapp",
      namespace: "default",
      serviceName: "myapp-svc",
      metricsEndpoint: "http://myapp.default.svc.cluster.local:8080/metrics",
    },
    rollbackPlanCheckContext: {
      projectRoot: "/path/to/project",
      runId: "run-001",
    },
    projectRoot: "/path/to/project",
    runId: "run-001",
  };
  assert.equal(ctxExtended.monitoringCheckContext?.serviceName, "myapp-svc");
  assert.equal(ctxExtended.rollbackPlanCheckContext?.runId, "run-001");
  assert.equal(ctxExtended.projectRoot, "/path/to/project");
  assert.equal(ctxExtended.runId, "run-001");
});

test("T22h. DevOpsContext 含可选 monitoringCheckContext / rollbackPlanCheckContext / projectRoot / runId 字段（向后兼容）", () => {
  // 构造测试 TaskCard（GateContext 必填字段）
  const taskCard = createTestTaskCard();

  // 验证 1：批次 13 既有字段（不提供批次 14 新增可选字段，向后兼容）
  const ctxLegacy: DevOpsContext = {
    projectId: "myapp",
    loopType: "deploy",
    specStatus: "approved",
    planStatus: "approved",
    reviewRecords: [],
    userApproved: true,
    taskCard,
    actualChanges: [],
    iacGenerationContext: {
      projectName: "myapp",
      environment: "prod",
      replicas: 3,
      image: "registry.example.com/myapp:v1.0.0",
      port: 8080,
      resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
      envVars: [],
    },
    deployContext: {
      runId: "run-001",
      projectName: "myapp",
      environment: "prod",
      iacTemplates: Object.freeze([]) as ReadonlyArray<IaCTemplate>,
      strategyType: "rolling",
      timeoutMs: 300000,
    },
    smokeTestCases: Object.freeze([]) as ReadonlyArray<SmokeTestCase>,
  };
  assert.equal(ctxLegacy.monitoringCheckContext, undefined);
  assert.equal(ctxLegacy.rollbackPlanCheckContext, undefined);
  assert.equal(ctxLegacy.projectRoot, undefined);
  assert.equal(ctxLegacy.runId, undefined);

  // 验证 2：批次 14 新增可选字段（提供全部新字段）
  const ctxExtended: DevOpsContext = {
    ...ctxLegacy,
    monitoringCheckContext: {
      projectName: "myapp",
      namespace: "default",
      serviceName: "myapp-svc",
      metricsEndpoint: "http://myapp.default.svc.cluster.local:8080/metrics",
    },
    rollbackPlanCheckContext: {
      projectRoot: "/path/to/project",
      runId: "run-001",
    },
    projectRoot: "/path/to/project",
    runId: "run-001",
  };
  assert.equal(ctxExtended.monitoringCheckContext?.namespace, "default");
  assert.equal(ctxExtended.rollbackPlanCheckContext?.projectRoot, "/path/to/project");
  assert.equal(ctxExtended.projectRoot, "/path/to/project");
  assert.equal(ctxExtended.runId, "run-001");
});

test("T22i. DevOpsOrchestratorOptions 含可选 monitoringReadinessChecker / rollbackPlanChecker 字段（向后兼容）", () => {
  // 构造辅助 mock-free 占位实现（与 NoOpRollbackManager 同样的占位模式，仅用于类型校验）
  const gateG8Checker: GateG8Checker = {
    gateId: "G-8",
    check(): import("../eag/gate/gate-types").GateResult {
      return Object.freeze({
        passed: true,
        gate: "G-8",
        reason: "全部 5 项部署就绪条件已满足",
        severity: "blocker",
      }) as import("../eag/gate/gate-types").GateResult;
    },
  };
  const deployStrategy: DeployStrategy = {
    strategyType: "rolling",
    async execute(): Promise<DeployResult> {
      return Object.freeze({
        success: true,
        deployedAt: "2026-07-21T10:00:00.000Z",
        duration: 30000,
        resources: Object.freeze([]) as ReadonlyArray<DeployedResource>,
        errors: Object.freeze([]) as ReadonlyArray<string>,
      }) as DeployResult;
    },
  };
  const deployStage: DeployStage = {
    async execute(): Promise<DeployStageResult> {
      return Object.freeze({
        success: true,
        preDeployPassed: true,
        postDeployPassed: true,
        healthEndpoints: Object.freeze([]) as ReadonlyArray<HealthEndpoint>,
        rollbackExecuted: false,
        errors: Object.freeze([]) as ReadonlyArray<string>,
      }) as DeployStageResult;
    },
  };

  // 验证 1：批次 13 既有字段（不提供批次 14 新增可选字段，向后兼容）
  const optsLegacy: DevOpsOrchestratorOptions = {
    iacGenerators: Object.freeze([]) as ReadonlyArray<IaCGenerator>,
    gateG8Checker,
    deployStrategy,
    deployStage,
  };
  assert.equal(optsLegacy.monitoringReadinessChecker, undefined);
  assert.equal(optsLegacy.rollbackPlanChecker, undefined);

  // 验证 2：批次 14 新增可选字段（提供全部新字段）
  const optsExtended: DevOpsOrchestratorOptions = {
    ...optsLegacy,
    monitoringReadinessChecker: {
      async check(): Promise<MonitoringCheckResult> {
        return Object.freeze({
          ready: true,
          checkedItems: Object.freeze([]) as ReadonlyArray<MonitoringCheckedItem>,
          failures: Object.freeze([]) as ReadonlyArray<string>,
        }) as MonitoringCheckResult;
      },
    },
    rollbackPlanChecker: {
      async check(): Promise<RollbackPlanCheckResult> {
        return Object.freeze({
          exists: true,
          valid: true,
          filePath: "/path/to/project/deploy/rollback-plan-run-001.md",
          failures: Object.freeze([]) as ReadonlyArray<string>,
        }) as RollbackPlanCheckResult;
      },
    },
  };
  assert.equal(typeof optsExtended.monitoringReadinessChecker?.check, "function");
  assert.equal(typeof optsExtended.rollbackPlanChecker?.check, "function");
});
