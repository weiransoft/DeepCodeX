/**
 * EAG-P4 批次 13 Phase 5 单元测试：DeployStageImpl
 *
 * 测试范围（对齐设计文档 §6.2.1 D2-1 DeployStage 覆盖率 ≥ 85%）：
 * - T1. 实例化与接口契约
 *   - T1a. 实例化成功
 *   - T1b. 实现 DeployStage 接口
 * - T2. 构造期不变式校验
 *   - T2a. preDeployChecker 为空时抛异常
 *   - T2b. postDeployChecker 为空时抛异常
 *   - T2c. smokeTestRunner 为空时抛异常
 *   - T2d. rollbackManager 可选（不抛异常）
 * - T3. pre-deploy 失败场景
 *   - T3a. pre-deploy 失败时 success=false
 *   - T3b. pre-deploy 失败时 preDeployPassed=false
 *   - T3c. pre-deploy 失败时不触发回滚（rollbackExecuted=false）
 *   - T3d. pre-deploy 失败时 errors 含失败项
 * - T4. deploy 失败场景
 *   - T4a. deploy 失败时 success=false
 *   - T4b. deploy 失败时 deployResult.success=false
 *   - T4c. deploy 失败时 errors 含部署错误
 * - T5. post-deploy 失败场景
 *   - T5a. post-deploy 失败时 success=false
 *   - T5b. post-deploy 失败时 postDeployPassed=false
 *   - T5c. post-deploy 失败时 healthEndpoints 已填充（B-2 修复）
 * - T6. smoke-test 失败场景
 *   - T6a. smoke-test 失败时 success=false
 *   - T6b. smoke-test 失败时 errors 含烟雾测试错误
 * - T7. 4 步全部成功场景
 *   - T7a. 4 步全部成功时 success=true
 *   - T7b. 4 步全部成功时 healthEndpoints 非空
 *   - T7c. 4 步全部成功时 errors 为空
 * - T8. 回滚触发场景
 *   - T8a. deploy 失败 + rollbackManager 存在时触发回滚
 *   - T8b. post-deploy 失败 + rollbackManager 存在时触发回滚
 *   - T8c. smoke-test 失败 + rollbackManager 存在时触发回滚
 * - T9. 不可变优先
 *   - T9a. DeployStageResult 已冻结
 *   - T9b. healthEndpoints 已冻结
 *   - T9c. errors 已冻结
 * - T10. 异常处理场景
 *   - T10a. deploy 抛异常时 success=false
 *   - T10b. post-deploy 抛异常时 success=false
 *   - T10c. smoke-test 抛异常时 success=false
 *   - T10d. deploy 抛异常 + rollbackManager 存在时触发回滚
 *   - T10e. pre-deploy 抛异常时 success=false 且不触发回滚（P1-1 修复验证）
 *   - T10f. deploy 失败 + rollback() 抛异常时 errors 含回滚执行异常（P1-2 修复验证）
 *   - T10g. post-deploy 失败 + rollback() 抛异常时 errors 含回滚执行异常（P1-2 修复验证）
 *   - T10h. smoke-test 失败 + rollback() 抛异常时 errors 含回滚执行异常（P1-2 修复验证）
 * - T11. 快照创建失败场景（P2-4 验证）
 *   - T11a. 快照创建失败时不阻塞部署，errors 含"版本快照创建失败"
 *   - T11b. 快照创建失败 + deploy 失败时不触发回滚（snapshot 为 undefined）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实测试替身类（实现真实接口，返回真实数据）
 * - 测试替身类与 eag-coding-fix-loop.test.ts 中的 StatefulChecker / AlwaysViolatedChecker 同构
 *
 * @module core/tests/eag-deploy-stage
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DeployStageImpl } from "../eag/deploy/deploy-stage";
import { NoOpRollbackManager } from "../eag/devops/rollback-manager";
import type {
  DeployStage,
  DeployStageOptions,
  DeployStageResult,
  DevOpsContext,
  IaCTemplate,
  DeployStrategy,
  DeployContext,
  DeployResult,
  DeployedResource,
  PreDeployChecker,
  PreDeployCheckContext,
  PreDeployCheckResult,
  PostDeployChecker,
  PostDeployCheckContext,
  PostDeployCheckResult,
  HealthEndpoint,
  SmokeTestRunner,
  SmokeTestCase,
  SmokeTestResult,
  SmokeTestFailure,
  RollbackManager,
  RollbackSnapshotContext,
  RollbackSnapshot,
  RollbackResult,
} from "../eag/devops/types";

// ============================================================================
// 测试替身类（真实实现接口，返回真实数据，非 mock）
// ============================================================================

/**
 * AlwaysPassPreDeployChecker —— 始终通过的 PreDeployChecker 测试替身
 *
 * 实现 PreDeployChecker 接口，check() 始终返回 passed=true。
 * 用于测试 DeployStage 的 Step 2~4 编排逻辑。
 */
class AlwaysPassPreDeployChecker implements PreDeployChecker {
  async check(_context: PreDeployCheckContext): Promise<PreDeployCheckResult> {
    void _context;
    return Object.freeze({
      passed: true,
      imageBuilt: true,
      configValid: true,
      dependenciesAvailable: true,
      resourceQuotaSufficient: true,
      failures: Object.freeze([]) as ReadonlyArray<string>,
    }) as PreDeployCheckResult;
  }
}

/**
 * AlwaysFailPreDeployChecker —— 始终失败的 PreDeployChecker 测试替身
 *
 * 实现 PreDeployChecker 接口，check() 始终返回 passed=false。
 * 用于测试 DeployStage 的 Step 1 失败场景。
 */
class AlwaysFailPreDeployChecker implements PreDeployChecker {
  async check(_context: PreDeployCheckContext): Promise<PreDeployCheckResult> {
    void _context;
    return Object.freeze({
      passed: false,
      imageBuilt: false,
      configValid: true,
      dependenciesAvailable: true,
      resourceQuotaSufficient: true,
      failures: Object.freeze(["镜像不存在"]) as ReadonlyArray<string>,
    }) as PreDeployCheckResult;
  }
}

/**
 * AlwaysPassPostDeployChecker —— 始终通过的 PostDeployChecker 测试替身
 *
 * 实现 PostDeployChecker 接口，check() 始终返回 passed=true，并填充 endpoints。
 * 用于测试 DeployStage 的 Step 4 编排逻辑。
 */
class AlwaysPassPostDeployChecker implements PostDeployChecker {
  async check(_context: PostDeployCheckContext): Promise<PostDeployCheckResult> {
    void _context;
    return Object.freeze({
      passed: true,
      podsReady: true,
      serviceEndpointReachable: true,
      logsClean: true,
      metricsReporting: true,
      endpoints: Object.freeze([
        Object.freeze({
          url: "http://test-app.example.com/healthz",
          statusCode: 200,
          responseTimeMs: 50,
          healthy: true,
        }) as HealthEndpoint,
      ]) as ReadonlyArray<HealthEndpoint>,
      failures: Object.freeze([]) as ReadonlyArray<string>,
    }) as PostDeployCheckResult;
  }
}

/**
 * AlwaysFailPostDeployChecker —— 始终失败的 PostDeployChecker 测试替身
 *
 * 实现 PostDeployChecker 接口，check() 始终返回 passed=false。
 * 用于测试 DeployStage 的 Step 3 失败场景。
 *
 * P2-1 修复：返回非空 endpoints（含 1 个不健康的端点），用于真正验证 M-1 修复
 * （从 PostDeployCheckResult.endpoints 提取健康端点）的填充逻辑。
 */
class AlwaysFailPostDeployChecker implements PostDeployChecker {
  async check(_context: PostDeployCheckContext): Promise<PostDeployCheckResult> {
    void _context;
    return Object.freeze({
      passed: false,
      podsReady: false,
      serviceEndpointReachable: true,
      logsClean: true,
      metricsReporting: true,
      // P2-1 修复：返回非空 endpoints，验证 M-1 修复的填充逻辑
      endpoints: Object.freeze([
        Object.freeze({
          url: "http://test-app.example.com/healthz",
          statusCode: 503,
          responseTimeMs: 100,
          healthy: false, // 失败场景下端点不健康
        }) as HealthEndpoint,
      ]) as ReadonlyArray<HealthEndpoint>,
      failures: Object.freeze(["Pod 未就绪"]) as ReadonlyArray<string>,
    }) as PostDeployCheckResult;
  }
}

/**
 * ThrowingPostDeployChecker —— 抛出异常的 PostDeployChecker 测试替身
 *
 * 实现 PostDeployChecker 接口，check() 始终抛出异常。
 * 用于测试 DeployStage 的 Step 3 异常处理场景。
 */
class ThrowingPostDeployChecker implements PostDeployChecker {
  async check(_context: PostDeployCheckContext): Promise<PostDeployCheckResult> {
    void _context;
    throw new Error("PostDeployChecker 模拟异常");
  }
}

/**
 * AlwaysPassSmokeTestRunner —— 始终通过的 SmokeTestRunner 测试替身
 *
 * 实现 SmokeTestRunner 接口，run() 始终返回 passed=true。
 * 用于测试 DeployStage 的 Step 4 成功场景。
 */
class AlwaysPassSmokeTestRunner implements SmokeTestRunner {
  async run(_endpoints: ReadonlyArray<string>, _testCases: ReadonlyArray<SmokeTestCase>): Promise<SmokeTestResult> {
    void _endpoints;
    void _testCases;
    return Object.freeze({
      passed: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      duration: 100,
      failures: Object.freeze([]) as ReadonlyArray<SmokeTestFailure>,
    }) as SmokeTestResult;
  }
}

/**
 * AlwaysFailSmokeTestRunner —— 始终失败的 SmokeTestRunner 测试替身
 *
 * 实现 SmokeTestRunner 接口，run() 始终返回 passed=false。
 * 用于测试 DeployStage 的 Step 4 失败场景。
 */
class AlwaysFailSmokeTestRunner implements SmokeTestRunner {
  async run(_endpoints: ReadonlyArray<string>, _testCases: ReadonlyArray<SmokeTestCase>): Promise<SmokeTestResult> {
    void _endpoints;
    void _testCases;
    return Object.freeze({
      passed: false,
      totalTests: 1,
      passedTests: 0,
      failedTests: 1,
      duration: 100,
      failures: Object.freeze([
        Object.freeze({
          testName: "T1",
          expected: "HTTP 200",
          actual: "HTTP 500",
          errorMessage: "内部错误",
        }) as SmokeTestFailure,
      ]) as ReadonlyArray<SmokeTestFailure>,
    }) as SmokeTestResult;
  }
}

/**
 * ThrowingSmokeTestRunner —— 抛出异常的 SmokeTestRunner 测试替身
 *
 * 实现 SmokeTestRunner 接口，run() 始终抛出异常。
 * 用于测试 DeployStage 的 Step 4 异常处理场景。
 */
class ThrowingSmokeTestRunner implements SmokeTestRunner {
  async run(_endpoints: ReadonlyArray<string>, _testCases: ReadonlyArray<SmokeTestCase>): Promise<SmokeTestResult> {
    void _endpoints;
    void _testCases;
    throw new Error("SmokeTestRunner 模拟异常");
  }
}

/**
 * SuccessDeployStrategy —— 始终成功的 DeployStrategy 测试替身
 *
 * 实现 DeployStrategy 接口，execute() 始终返回 success=true，并返回已部署资源列表。
 * 用于测试 DeployStage 的 Step 3~4 编排逻辑。
 */
class SuccessDeployStrategy implements DeployStrategy {
  readonly strategyType = "rolling" as const;
  async execute(_context: DeployContext): Promise<DeployResult> {
    void _context;
    const resources: DeployedResource[] = [
      { kind: "Deployment", name: "test-app", namespace: "test-app", status: "Running" },
      { kind: "Service", name: "test-app-service", namespace: "test-app", status: "Running" },
    ];
    return Object.freeze({
      success: true,
      deployedAt: new Date().toISOString(),
      duration: 5000,
      resources: Object.freeze([...resources]) as ReadonlyArray<DeployedResource>,
      errors: Object.freeze([]) as ReadonlyArray<string>,
    }) as DeployResult;
  }
}

/**
 * FailureDeployStrategy —— 始终失败的 DeployStrategy 测试替身
 *
 * 实现 DeployStrategy 接口，execute() 始终返回 success=false。
 * 用于测试 DeployStage 的 Step 2 失败场景。
 */
class FailureDeployStrategy implements DeployStrategy {
  readonly strategyType = "rolling" as const;
  async execute(_context: DeployContext): Promise<DeployResult> {
    void _context;
    return Object.freeze({
      success: false,
      deployedAt: new Date().toISOString(),
      duration: 1000,
      resources: Object.freeze([]) as ReadonlyArray<DeployedResource>,
      errors: Object.freeze(["部署超时"]) as ReadonlyArray<string>,
    }) as DeployResult;
  }
}

/**
 * ThrowingDeployStrategy —— 抛出异常的 DeployStrategy 测试替身
 *
 * 实现 DeployStrategy 接口，execute() 始终抛出异常。
 * 用于测试 DeployStage 的 Step 2 异常处理场景。
 */
class ThrowingDeployStrategy implements DeployStrategy {
  readonly strategyType = "rolling" as const;
  async execute(_context: DeployContext): Promise<DeployResult> {
    void _context;
    throw new Error("DeployStrategy 模拟异常");
  }
}

/**
 * TrackingRollbackManager —— 跟踪回滚调用的 RollbackManager 测试替身
 *
 * 实现 RollbackManager 接口，记录 createSnapshot / rollback 调用次数。
 * 用于测试 DeployStage 的回滚触发逻辑。
 */
class TrackingRollbackManager implements RollbackManager {
  public createSnapshotCallCount = 0;
  public rollbackCallCount = 0;

  async createSnapshot(_context: RollbackSnapshotContext): Promise<RollbackSnapshot> {
    void _context;
    this.createSnapshotCallCount++;
    return Object.freeze({
      snapshotId: `snap-${Date.now()}`,
      createdAt: new Date().toISOString(),
      version: "v1.0.0",
      resources: Object.freeze(["Deployment/test-app", "Service/test-app-service"]) as ReadonlyArray<string>,
    }) as RollbackSnapshot;
  }

  async rollback(_snapshot: RollbackSnapshot): Promise<RollbackResult> {
    void _snapshot;
    this.rollbackCallCount++;
    return Object.freeze({
      success: true,
      rolledBackTo: "v0.9.0",
      duration: 2000,
      errors: Object.freeze([]) as ReadonlyArray<string>,
    }) as RollbackResult;
  }
}

/**
 * ThrowingPreDeployChecker —— 抛出异常的 PreDeployChecker 测试替身
 *
 * 实现 PreDeployChecker 接口，check() 始终抛出异常。
 * 用于测试 DeployStage 的 Step 1 异常处理场景（验证 P1-1 修复）。
 */
class ThrowingPreDeployChecker implements PreDeployChecker {
  async check(_context: PreDeployCheckContext): Promise<PreDeployCheckResult> {
    void _context;
    throw new Error("PreDeployChecker 模拟异常");
  }
}

/**
 * ThrowingRollbackManager —— rollback() 抛异常的 RollbackManager 测试替身
 *
 * 实现 RollbackManager 接口，createSnapshot() 正常返回，rollback() 始终抛出异常。
 * 用于测试 DeployStage 的回滚异常处理（验证 P1-2 修复：3 个非异常失败路径中
 * rollback() 调用用 try/catch 包裹，异常不传播到 execute() 调用方）。
 */
class ThrowingRollbackManager implements RollbackManager {
  public createSnapshotCallCount = 0;
  public rollbackCallCount = 0;

  async createSnapshot(_context: RollbackSnapshotContext): Promise<RollbackSnapshot> {
    void _context;
    this.createSnapshotCallCount++;
    return Object.freeze({
      snapshotId: `snap-${Date.now()}`,
      createdAt: new Date().toISOString(),
      version: "v1.0.0",
      resources: Object.freeze(["Deployment/test-app", "Service/test-app-service"]) as ReadonlyArray<string>,
    }) as RollbackSnapshot;
  }

  async rollback(_snapshot: RollbackSnapshot): Promise<RollbackResult> {
    void _snapshot;
    this.rollbackCallCount++;
    throw new Error("RollbackManager.rollback 模拟异常");
  }
}

/**
 * ThrowingSnapshotRollbackManager —— createSnapshot() 抛异常的 RollbackManager 测试替身
 *
 * 实现 RollbackManager 接口，createSnapshot() 始终抛出异常，rollback() 正常返回。
 * 用于测试 DeployStage 的快照创建失败场景（快照失败不阻塞部署，但 errors 含错误信息，
 * 且后续 deploy/post-deploy/smoke-test 失败时不触发回滚，因为 snapshot 为 undefined）。
 */
class ThrowingSnapshotRollbackManager implements RollbackManager {
  public createSnapshotCallCount = 0;
  public rollbackCallCount = 0;

  async createSnapshot(_context: RollbackSnapshotContext): Promise<RollbackSnapshot> {
    void _context;
    this.createSnapshotCallCount++;
    throw new Error("RollbackManager.createSnapshot 模拟异常");
  }

  async rollback(_snapshot: RollbackSnapshot): Promise<RollbackResult> {
    void _snapshot;
    this.rollbackCallCount++;
    return Object.freeze({
      success: true,
      rolledBackTo: "v0.9.0",
      duration: 2000,
      errors: Object.freeze([]) as ReadonlyArray<string>,
    }) as RollbackResult;
  }
}

// ============================================================================
// 辅助函数：构造 DevOpsContext
// ============================================================================

/**
 * 构造测试用 DevOpsContext
 *
 * @returns 完整的 DevOpsContext
 */
function createContext(): DevOpsContext {
  return {
    // GateContext 基础字段
    runId: "test-run-001",
    sessionId: "test-session-001",
    // DevOpsContext 扩展字段
    loopType: "deploy" as const,
    iacGenerationContext: {
      projectName: "test-app",
      environment: "dev" as const,
      replicas: 3,
      image: "registry.example.com/test-app:v1.0.0",
      port: 8080,
      resources: {
        requests: { cpu: "100m", memory: "128Mi" },
        limits: { cpu: "500m", memory: "512Mi" },
      },
      envVars: [{ name: "LOG_LEVEL", value: "info" }],
    },
    deployContext: {
      runId: "test-run-001",
      projectName: "test-app",
      environment: "dev" as const,
      iacTemplates: [],
      strategyType: "rolling" as const,
      timeoutMs: 300000,
    },
    smokeTestCases: [
      {
        name: "healthz",
        method: "GET" as const,
        path: "/healthz",
        expectedStatusCode: 200,
      },
    ],
  };
}

/**
 * 构造测试用 IaCTemplate 数组
 *
 * @returns IaCTemplate 数组
 */
function createIacTemplates(): ReadonlyArray<IaCTemplate> {
  return [
    {
      type: "k8s-manifest" as const,
      content: "# test manifest",
      filePath: "deployment.yaml",
      hash: "abc123",
      generatedAt: "2026-07-20T00:00:00.000Z",
    },
  ];
}

/**
 * 构造测试用 DeployStageOptions（默认全部通过）
 *
 * @param overrides 覆盖字段
 * @returns 完整的 DeployStageOptions
 */
function createOptions(overrides: Partial<DeployStageOptions> = {}): DeployStageOptions {
  return {
    preDeployChecker: new AlwaysPassPreDeployChecker(),
    postDeployChecker: new AlwaysPassPostDeployChecker(),
    smokeTestRunner: new AlwaysPassSmokeTestRunner(),
    ...overrides,
  };
}

// ============================================================================
// T1. 实例化与接口契约
// ============================================================================

test("T1a. DeployStageImpl 实例化成功", () => {
  const stage = new DeployStageImpl(createOptions());
  assert.ok(stage instanceof DeployStageImpl);
});

test("T1b. 实现 DeployStage 接口", () => {
  const stage: DeployStage = new DeployStageImpl(createOptions());
  assert.equal(typeof stage.execute, "function");
});

// ============================================================================
// T2. 构造期不变式校验
// ============================================================================

test("T2a. preDeployChecker 为空时抛异常", () => {
  assert.throws(
    () => new DeployStageImpl(createOptions({ preDeployChecker: undefined as unknown as PreDeployChecker })),
    /preDeployChecker 必填/
  );
});

test("T2b. postDeployChecker 为空时抛异常", () => {
  assert.throws(
    () => new DeployStageImpl(createOptions({ postDeployChecker: undefined as unknown as PostDeployChecker })),
    /postDeployChecker 必填/
  );
});

test("T2c. smokeTestRunner 为空时抛异常", () => {
  assert.throws(
    () => new DeployStageImpl(createOptions({ smokeTestRunner: undefined as unknown as SmokeTestRunner })),
    /smokeTestRunner 必填/
  );
});

test("T2d. rollbackManager 可选（不抛异常）", () => {
  const stage = new DeployStageImpl(createOptions());
  assert.ok(stage instanceof DeployStageImpl);
});

// ============================================================================
// T3. pre-deploy 失败场景
// ============================================================================

test("T3a. pre-deploy 失败时 success=false", async () => {
  const stage = new DeployStageImpl(createOptions({ preDeployChecker: new AlwaysFailPreDeployChecker() }));
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  assert.equal(result.success, false);
});

test("T3b. pre-deploy 失败时 preDeployPassed=false", async () => {
  const stage = new DeployStageImpl(createOptions({ preDeployChecker: new AlwaysFailPreDeployChecker() }));
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  assert.equal(result.preDeployPassed, false);
});

test("T3c. pre-deploy 失败时不触发回滚（rollbackExecuted=false）", async () => {
  const rollbackManager = new TrackingRollbackManager();
  const stage = new DeployStageImpl(
    createOptions({
      preDeployChecker: new AlwaysFailPreDeployChecker(),
      rollbackManager,
    })
  );
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  assert.equal(result.rollbackExecuted, false);
  assert.equal(rollbackManager.rollbackCallCount, 0);
});

test("T3d. pre-deploy 失败时 errors 含失败项", async () => {
  const stage = new DeployStageImpl(createOptions({ preDeployChecker: new AlwaysFailPreDeployChecker() }));
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("镜像"), `errors 应含"镜像"，实际：${errorsStr}`);
});

// ============================================================================
// T4. deploy 失败场景
// ============================================================================

test("T4a. deploy 失败时 success=false", async () => {
  const stage = new DeployStageImpl(createOptions());
  const result = await stage.execute(createContext(), createIacTemplates(), new FailureDeployStrategy());
  assert.equal(result.success, false);
});

test("T4b. deploy 失败时 deployResult.success=false", async () => {
  const stage = new DeployStageImpl(createOptions());
  const result = await stage.execute(createContext(), createIacTemplates(), new FailureDeployStrategy());
  assert.ok(result.deployResult !== undefined);
  assert.equal(result.deployResult.success, false);
});

test("T4c. deploy 失败时 errors 含部署错误", async () => {
  const stage = new DeployStageImpl(createOptions());
  const result = await stage.execute(createContext(), createIacTemplates(), new FailureDeployStrategy());
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("部署超时"), `errors 应含"部署超时"，实际：${errorsStr}`);
});

// ============================================================================
// T5. post-deploy 失败场景
// ============================================================================

test("T5a. post-deploy 失败时 success=false", async () => {
  const stage = new DeployStageImpl(createOptions({ postDeployChecker: new AlwaysFailPostDeployChecker() }));
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  assert.equal(result.success, false);
});

test("T5b. post-deploy 失败时 postDeployPassed=false", async () => {
  const stage = new DeployStageImpl(createOptions({ postDeployChecker: new AlwaysFailPostDeployChecker() }));
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  assert.equal(result.postDeployPassed, false);
});

test("T5c. post-deploy 失败时 healthEndpoints 已填充（B-2 修复 + M-1 修复）", async () => {
  const stage = new DeployStageImpl(createOptions({ postDeployChecker: new AlwaysFailPostDeployChecker() }));
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  // B-2 修复：即使 post-deploy 失败，healthEndpoints 也应从 PostDeployCheckResult.endpoints 填充
  // P2-1 修复：AlwaysFailPostDeployChecker 返回 1 个非空 endpoint，真正验证 M-1 修复填充逻辑
  assert.ok(Array.isArray(result.healthEndpoints));
  assert.equal(result.healthEndpoints.length, 1, "healthEndpoints 应含 1 个端点（M-1 修复填充）");
  assert.equal(result.healthEndpoints[0].url, "http://test-app.example.com/healthz");
  assert.equal(result.healthEndpoints[0].healthy, false, "失败场景下端点应不健康");
});

// ============================================================================
// T6. smoke-test 失败场景
// ============================================================================

test("T6a. smoke-test 失败时 success=false", async () => {
  const stage = new DeployStageImpl(createOptions({ smokeTestRunner: new AlwaysFailSmokeTestRunner() }));
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  assert.equal(result.success, false);
});

test("T6b. smoke-test 失败时 errors 含烟雾测试错误", async () => {
  const stage = new DeployStageImpl(createOptions({ smokeTestRunner: new AlwaysFailSmokeTestRunner() }));
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("烟雾测试"), `errors 应含"烟雾测试"，实际：${errorsStr}`);
});

// ============================================================================
// T7. 4 步全部成功场景
// ============================================================================

test("T7a. 4 步全部成功时 success=true", async () => {
  const stage = new DeployStageImpl(createOptions());
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  assert.equal(result.success, true);
});

test("T7b. 4 步全部成功时 healthEndpoints 非空", async () => {
  const stage = new DeployStageImpl(createOptions());
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  // AlwaysPassPostDeployChecker 返回 1 个 HealthEndpoint
  assert.ok(result.healthEndpoints.length >= 1, "healthEndpoints 应非空");
  const endpoint: HealthEndpoint = result.healthEndpoints[0];
  assert.ok(typeof endpoint === "object");
  assert.ok("url" in endpoint);
  assert.ok("statusCode" in endpoint);
  assert.ok("responseTimeMs" in endpoint);
  assert.ok("healthy" in endpoint);
});

test("T7c. 4 步全部成功时 errors 为空", async () => {
  const stage = new DeployStageImpl(createOptions());
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  assert.equal(result.errors.length, 0);
});

// ============================================================================
// T8. 回滚触发场景
// ============================================================================

test("T8a. deploy 失败 + rollbackManager 存在时触发回滚", async () => {
  const rollbackManager = new TrackingRollbackManager();
  const stage = new DeployStageImpl(createOptions({ rollbackManager }));
  const result = await stage.execute(createContext(), createIacTemplates(), new FailureDeployStrategy());
  assert.equal(result.rollbackExecuted, true);
  assert.equal(rollbackManager.rollbackCallCount, 1);
  assert.ok(result.rollbackResult !== undefined);
});

test("T8b. post-deploy 失败 + rollbackManager 存在时触发回滚", async () => {
  const rollbackManager = new TrackingRollbackManager();
  const stage = new DeployStageImpl(
    createOptions({
      postDeployChecker: new AlwaysFailPostDeployChecker(),
      rollbackManager,
    })
  );
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  assert.equal(result.rollbackExecuted, true);
  assert.equal(rollbackManager.rollbackCallCount, 1);
});

test("T8c. smoke-test 失败 + rollbackManager 存在时触发回滚", async () => {
  const rollbackManager = new TrackingRollbackManager();
  const stage = new DeployStageImpl(
    createOptions({
      smokeTestRunner: new AlwaysFailSmokeTestRunner(),
      rollbackManager,
    })
  );
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  assert.equal(result.rollbackExecuted, true);
  assert.equal(rollbackManager.rollbackCallCount, 1);
});

// ============================================================================
// T9. 不可变优先
// ============================================================================

test("T9a. DeployStageResult 已冻结", async () => {
  const stage = new DeployStageImpl(createOptions());
  const result: DeployStageResult = await stage.execute(
    createContext(),
    createIacTemplates(),
    new SuccessDeployStrategy()
  );
  assert.equal(Object.isFrozen(result), true);
});

test("T9b. healthEndpoints 已冻结", async () => {
  const stage = new DeployStageImpl(createOptions());
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  assert.equal(Object.isFrozen(result.healthEndpoints), true);
});

test("T9c. errors 已冻结", async () => {
  const stage = new DeployStageImpl(createOptions());
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  assert.equal(Object.isFrozen(result.errors), true);
});

// ============================================================================
// T10. 异常处理场景
// ============================================================================

test("T10a. deploy 抛异常时 success=false", async () => {
  const stage = new DeployStageImpl(createOptions());
  const result = await stage.execute(createContext(), createIacTemplates(), new ThrowingDeployStrategy());
  assert.equal(result.success, false);
  // 异常信息应收集到 errors
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("部署执行异常"), `errors 应含"部署执行异常"，实际：${errorsStr}`);
});

test("T10b. post-deploy 抛异常时 success=false", async () => {
  const stage = new DeployStageImpl(createOptions({ postDeployChecker: new ThrowingPostDeployChecker() }));
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  assert.equal(result.success, false);
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("部署后检查异常"), `errors 应含"部署后检查异常"，实际：${errorsStr}`);
});

test("T10c. smoke-test 抛异常时 success=false", async () => {
  const stage = new DeployStageImpl(createOptions({ smokeTestRunner: new ThrowingSmokeTestRunner() }));
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  assert.equal(result.success, false);
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("烟雾测试执行异常"), `errors 应含"烟雾测试执行异常"，实际：${errorsStr}`);
});

test("T10d. deploy 抛异常 + rollbackManager 存在时触发回滚", async () => {
  const rollbackManager = new TrackingRollbackManager();
  const stage = new DeployStageImpl(createOptions({ rollbackManager }));
  const result = await stage.execute(createContext(), createIacTemplates(), new ThrowingDeployStrategy());
  assert.equal(result.rollbackExecuted, true);
  assert.equal(rollbackManager.rollbackCallCount, 1);
});

// ============================================================================
// T10e~T10h. P1 修复验证场景（架构师审查 P1-1 + P1-2 修复）
// ============================================================================

test("T10e. pre-deploy 抛异常时 success=false 且不触发回滚（P1-1 修复）", async () => {
  const rollbackManager = new TrackingRollbackManager();
  const stage = new DeployStageImpl(
    createOptions({
      preDeployChecker: new ThrowingPreDeployChecker(),
      rollbackManager,
    })
  );
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  // P1-1 修复：pre-deploy 抛异常与 passed=false 同等处理（不触发回滚，直接返回）
  assert.equal(result.success, false, "pre-deploy 抛异常时 success 应为 false");
  assert.equal(result.preDeployPassed, false, "pre-deploy 抛异常时 preDeployPassed 应为 false");
  assert.equal(result.rollbackExecuted, false, "pre-deploy 抛异常时不触发回滚");
  assert.equal(rollbackManager.rollbackCallCount, 0, "rollback() 不应被调用");
  assert.equal(rollbackManager.createSnapshotCallCount, 0, "createSnapshot() 不应被调用");
  // 异常信息应收集到 errors
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("部署前检查异常"), `errors 应含"部署前检查异常"，实际：${errorsStr}`);
  assert.ok(errorsStr.includes("PreDeployChecker 模拟异常"), `errors 应含原始异常信息，实际：${errorsStr}`);
});

test("T10f. deploy 失败 + rollback() 抛异常时 success=false 且 errors 含回滚执行异常（P1-2 修复）", async () => {
  const rollbackManager = new ThrowingRollbackManager();
  const stage = new DeployStageImpl(createOptions({ rollbackManager }));
  const result = await stage.execute(createContext(), createIacTemplates(), new FailureDeployStrategy());
  // P1-2 修复：非异常失败路径中 rollback() 用 try/catch 包裹，异常不传播
  assert.equal(result.success, false, "deploy 失败时 success 应为 false");
  assert.equal(rollbackManager.createSnapshotCallCount, 1, "createSnapshot 应被调用 1 次");
  assert.equal(rollbackManager.rollbackCallCount, 1, "rollback 应被调用 1 次");
  // errors 应同时含部署错误和回滚执行异常
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("部署超时"), `errors 应含"部署超时"，实际：${errorsStr}`);
  assert.ok(errorsStr.includes("回滚执行异常"), `errors 应含"回滚执行异常"，实际：${errorsStr}`);
  assert.ok(errorsStr.includes("RollbackManager.rollback 模拟异常"), `errors 应含回滚异常原始信息，实际：${errorsStr}`);
});

test("T10g. post-deploy 失败 + rollback() 抛异常时 success=false 且 errors 含回滚执行异常（P1-2 修复）", async () => {
  const rollbackManager = new ThrowingRollbackManager();
  const stage = new DeployStageImpl(
    createOptions({
      postDeployChecker: new AlwaysFailPostDeployChecker(),
      rollbackManager,
    })
  );
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  // P1-2 修复：post-deploy 非异常失败路径中 rollback() 用 try/catch 包裹
  assert.equal(result.success, false, "post-deploy 失败时 success 应为 false");
  assert.equal(rollbackManager.rollbackCallCount, 1, "rollback 应被调用 1 次");
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("Pod 未就绪"), `errors 应含"Pod 未就绪"，实际：${errorsStr}`);
  assert.ok(errorsStr.includes("回滚执行异常"), `errors 应含"回滚执行异常"，实际：${errorsStr}`);
});

test("T10h. smoke-test 失败 + rollback() 抛异常时 success=false 且 errors 含回滚执行异常（P1-2 修复）", async () => {
  const rollbackManager = new ThrowingRollbackManager();
  const stage = new DeployStageImpl(
    createOptions({
      smokeTestRunner: new AlwaysFailSmokeTestRunner(),
      rollbackManager,
    })
  );
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  // P1-2 修复：smoke-test 非异常失败路径中 rollback() 用 try/catch 包裹
  assert.equal(result.success, false, "smoke-test 失败时 success 应为 false");
  assert.equal(rollbackManager.rollbackCallCount, 1, "rollback 应被调用 1 次");
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("烟雾测试"), `errors 应含"烟雾测试"，实际：${errorsStr}`);
  assert.ok(errorsStr.includes("回滚执行异常"), `errors 应含"回滚执行异常"，实际：${errorsStr}`);
});

// ============================================================================
// T11. 快照创建失败场景（P2-4 验证）
// ============================================================================

test("T11a. 快照创建失败时不阻塞部署，errors 含'版本快照创建失败'（P2-4 验证）", async () => {
  const rollbackManager = new ThrowingSnapshotRollbackManager();
  const stage = new DeployStageImpl(createOptions({ rollbackManager }));
  const result = await stage.execute(createContext(), createIacTemplates(), new SuccessDeployStrategy());
  // P2-4 验证：快照创建失败不阻塞部署，4 步全部成功
  assert.equal(result.success, true, "快照创建失败不阻塞部署，4 步全部成功");
  assert.equal(rollbackManager.createSnapshotCallCount, 1, "createSnapshot 应被调用 1 次");
  assert.equal(rollbackManager.rollbackCallCount, 0, "4 步全部成功时 rollback 不应被调用");
  // errors 应含快照创建失败错误
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("版本快照创建失败"), `errors 应含"版本快照创建失败"，实际：${errorsStr}`);
  assert.ok(errorsStr.includes("createSnapshot 模拟异常"), `errors 应含快照异常原始信息，实际：${errorsStr}`);
  // rollbackExecuted=false（快照未创建成功，即使后续失败也不会回滚）
  assert.equal(result.rollbackExecuted, false, "快照创建失败时 rollbackExecuted 应为 false");
});

test("T11b. 快照创建失败 + deploy 失败时不触发回滚（snapshot 为 undefined）", async () => {
  const rollbackManager = new ThrowingSnapshotRollbackManager();
  const stage = new DeployStageImpl(createOptions({ rollbackManager }));
  const result = await stage.execute(createContext(), createIacTemplates(), new FailureDeployStrategy());
  // 快照创建失败 → snapshot 为 undefined → deploy 失败时不触发回滚
  assert.equal(result.success, false, "deploy 失败时 success 应为 false");
  assert.equal(result.rollbackExecuted, false, "snapshot 为 undefined 时不触发回滚");
  assert.equal(rollbackManager.rollbackCallCount, 0, "rollback 不应被调用（snapshot 为 undefined）");
  // errors 同时含快照创建失败和部署超时
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("版本快照创建失败"), `errors 应含"版本快照创建失败"，实际：${errorsStr}`);
  assert.ok(errorsStr.includes("部署超时"), `errors 应含"部署超时"，实际：${errorsStr}`);
});
