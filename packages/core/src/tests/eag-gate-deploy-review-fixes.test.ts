/**
 * EAG 全量审查修复定向测试（2026-11-08）——devops / deploy / gate「默认放行」与「谎报成功」
 *
 * 覆盖审查项：
 * - P0-6 G-8 监控/回滚预案恒真（去掉 `?? true`、以真实检查器 valid/ready 为准）
 * - P0-7 回滚验证把解析失败当成功（parseOk + expectedReplicas>0 才可能 success）
 * - P0-8 监控就绪「信息不足即通过」（缺失路径 → skipped 且不计入 ready）
 * - P1 烟雾测试 0 用例误报 passed、deploy-stage 空健康端点、gate 默认宽松覆盖、
 *   G-3 两种空集语义、devops 事件类型按 success 选择、环境变量回退契约
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock：使用真实实现类 + 实现真实接口的测试替身（返回真实数据）
 * - 不修改任何既有测试文件，仅新增本文件
 *
 * 环境变量契约：
 * - 默认（未设置 EAG_LEGACY_PASS_THROUGH）：修复后的诚实语义（fail-closed）
 * - EAG_LEGACY_PASS_THROUGH=1：紧急回退到修复前「默认放行/信息不足即通过」语义
 *
 * @module core/tests/eag-gate-deploy-review-fixes
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { GateG8CheckerImpl } from "../eag/gate/gate-g8-checker";
import { GateG3Checker } from "../eag/gate/gate-g3-checker";
import { GateOrchestrator } from "../eag/gate/gate-orchestrator";
import { SmokeTestRunnerImpl } from "../eag/deploy/smoke-test-runner";
import { MonitoringReadinessCheckerImpl } from "../eag/devops/monitoring-readiness-checker";
import { K8sRollbackManager } from "../eag/devops/rollback-manager";
import { DevOpsOrchestrator } from "../eag/devops/devops-orchestrator";
import type {
  DevOpsContext,
  IaCTemplate,
  IaCGenerator,
  IaCType,
  IaCValidationResult,
  DeployStrategy,
  DeployResult,
  DeployStage,
  DeployStageResult,
  DevOpsEvent,
  DevOpsEventEmitter,
  MonitoringReadinessChecker,
  MonitoringCheckContext,
  MonitoringCheckResult,
  RollbackPlanChecker,
  RollbackPlanCheckContext,
  RollbackPlanCheckResult,
  SmokeTestCase,
} from "../eag/devops/types";
import type { GateContext } from "../eag/gate/gate-types";

// ============================================================================
// 环境变量辅助：默认走诚实语义；涉及回退的用例用 try/finally 严格恢复
// ============================================================================

const LEGACY_FLAG = "EAG_LEGACY_PASS_THROUGH";

/** 清除回退开关，确保当前用例走修复后的诚实语义 */
function clearLegacyFlag(): void {
  delete process.env[LEGACY_FLAG];
}

// ============================================================================
// 测试替身（实现真实接口，返回真实数据，非 mock）
// ============================================================================

/** 始终生成 1 个合法 IaC 模板、校验通过的生成器替身 */
class StubIaCGenerator implements IaCGenerator {
  public readonly iacType: IaCType = "k8s-manifest";

  generate(): IaCTemplate[] {
    return [
      Object.freeze({
        type: "k8s-manifest",
        content: "apiVersion: v1\nkind: Deployment\n",
        filePath: "deployment.yaml",
        hash: "sha256:stub",
        generatedAt: new Date().toISOString(),
      }) as IaCTemplate,
    ];
  }

  async validate(): Promise<IaCValidationResult> {
    return Object.freeze({
      valid: true,
      errors: Object.freeze([]) as ReadonlyArray<string>,
      validatedBy: "kubectl-dry-run",
    }) as IaCValidationResult;
  }
}

/** 构造一个 success=true、errors 为空的部署结果 */
function createSuccessDeployResult(): DeployResult {
  return Object.freeze({
    success: true,
    deployedAt: new Date().toISOString(),
    duration: 1,
    resources: Object.freeze([]) as ReadonlyArray<never>,
    errors: Object.freeze([]) as ReadonlyArray<string>,
  }) as DeployResult;
}

/** 始终成功的部署策略替身 */
class StubDeployStrategy implements DeployStrategy {
  public readonly strategyType = "rolling" as const;

  async execute(): Promise<DeployResult> {
    return createSuccessDeployResult();
  }
}

/** 4 步阶段全部成功的 DeployStage 替身（healthEndpoints 含 1 个健康端点） */
class StubDeployStage implements DeployStage {
  async execute(): Promise<DeployStageResult> {
    return Object.freeze({
      success: true,
      preDeployPassed: true,
      deployResult: createSuccessDeployResult(),
      postDeployPassed: true,
      smokeTestResult: Object.freeze({
        passed: true,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        duration: 1,
        failures: Object.freeze([]) as ReadonlyArray<never>,
      }),
      healthEndpoints: Object.freeze([
        Object.freeze({ url: "http://app.example.com/healthz", statusCode: 200, responseTimeMs: 1, healthy: true }),
      ]),
      rollbackExecuted: false,
      errors: Object.freeze([]) as ReadonlyArray<string>,
    }) as DeployStageResult;
  }
}

/** 记录已发射事件的 EventEmitter 替身 */
class TrackingEventEmitter implements DevOpsEventEmitter {
  public readonly events: DevOpsEvent[] = [];

  emit(event: DevOpsEvent): void {
    this.events.push(event);
  }
}

/** 监控就绪检查器替身：明确返回未就绪（ready=false） */
class NotReadyMonitoringChecker implements MonitoringReadinessChecker {
  async check(_context: MonitoringCheckContext): Promise<MonitoringCheckResult> {
    void _context;
    return Object.freeze({
      ready: false,
      checkedItems: Object.freeze([]) as ReadonlyArray<never>,
      failures: Object.freeze(["监控检查未通过（测试替身）"]) as ReadonlyArray<string>,
    }) as MonitoringCheckResult;
  }
}

/** 回滚预案检查器替身：文件存在但章节不全（exists=true, valid=false） */
class InvalidRollbackPlanChecker implements RollbackPlanChecker {
  async check(_context: RollbackPlanCheckContext): Promise<RollbackPlanCheckResult> {
    void _context;
    return Object.freeze({
      exists: true,
      valid: false,
      filePath: "/tmp/rollback-plan-stub.md",
      failures: Object.freeze(["章节缺失：## 回滚命令"]) as ReadonlyArray<string>,
    }) as RollbackPlanCheckResult;
  }
}

// ============================================================================
// 上下文构造辅助
// ============================================================================

/** 构造完整 DevOpsContext（默认不配置 monitoringReady / rollbackPlanExists） */
function createDevOpsContext(overrides: Partial<DevOpsContext> = {}): DevOpsContext {
  return {
    projectId: "review-project",
    loopType: "deploy",
    specStatus: "approved",
    planStatus: "approved",
    reviewRecords: [],
    userApproved: true,
    taskCard: { id: "T-001", title: "部署任务", status: "completed" } as never,
    actualChanges: [],
    iacGenerationContext: {
      projectName: "review-app",
      environment: "prod",
      replicas: 3,
      image: "registry.example.com/review-app:v1.0.0",
      port: 8080,
      resources: {
        requests: { cpu: "100m", memory: "128Mi" },
        limits: { cpu: "500m", memory: "512Mi" },
      },
      envVars: [],
    },
    deployContext: {
      runId: "review-run-001",
      projectName: "review-app",
      environment: "prod",
      iacTemplates: [],
      strategyType: "rolling",
      timeoutMs: 300000,
    },
    smokeTestCases: [{ name: "healthz", method: "GET", path: "/healthz", expectedStatusCode: 200 }],
    ...overrides,
  } as unknown as DevOpsContext;
}

/** 构造完整 GateContext（默认 coding Loop、全部文档已批准） */
function createGateContext(overrides: Partial<GateContext> = {}): GateContext {
  return {
    projectId: "review-project",
    loopType: "coding",
    specStatus: "approved",
    planStatus: "approved",
    reviewRecords: [
      { role: "architect", reviewer: "r1", verdict: "approve", comments: "ok", reviewedAt: "2026-01-01T00:00:00.000Z" },
      { role: "pm", reviewer: "r2", verdict: "approve", comments: "ok", reviewedAt: "2026-01-01T00:00:00.000Z" },
      {
        role: "test-expert",
        reviewer: "r3",
        verdict: "approve",
        comments: "ok",
        reviewedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        role: "solo-coder",
        reviewer: "r4",
        verdict: "approve",
        comments: "ok",
        reviewedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    userApproved: true,
    taskCard: {
      id: "T-001",
      title: "测试任务",
      requirementId: "F-001",
      dependencies: [],
      acceptanceCriteria: ["npm test"],
      status: "pending",
      declaredSymbols: [],
    },
    actualChanges: [],
    ...overrides,
  } as GateContext;
}

/** 构造一个会跑的烟雾测试用例 */
function createTestCase(): SmokeTestCase {
  return { name: "healthz", method: "GET", path: "/healthz", expectedStatusCode: 200 };
}

/** 启动返回 200 的本地 HTTP 服务器（真实服务器，非 mock） */
function startLocalHttpServer(): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end("OK");
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

/** 构造带真实 G-8 检查器的 DevOpsOrchestrator */
function createOrchestrator(): DevOpsOrchestrator {
  return new DevOpsOrchestrator({
    iacGenerators: [new StubIaCGenerator()],
    gateG8Checker: new GateG8CheckerImpl(),
    deployStrategy: new StubDeployStrategy(),
    deployStage: new StubDeployStage(),
  });
}

// ============================================================================
// ① P0-6: 未配置 monitoringReady/rollbackPlanExists 时 G-8 不判通过
// ============================================================================

test("① 未配置 monitoringReady/rollbackPlanExists 时 G-8 不判通过（不再 ?? true 默认放行）", async () => {
  clearLegacyFlag();
  const emitter = new TrackingEventEmitter();
  const orchestrator = new DevOpsOrchestrator({
    iacGenerators: [new StubIaCGenerator()],
    gateG8Checker: new GateG8CheckerImpl(),
    deployStrategy: new StubDeployStrategy(),
    deployStage: new StubDeployStage(),
    eventEmitter: emitter,
  });

  const result = await orchestrator.run(createDevOpsContext());

  assert.equal(result.gateResult.passed, false, "未配置监控/回滚预案时 G-8 必须判未通过");
  assert.equal(result.success, false, "G-8 未通过时整体不得判成功");
  assert.ok(result.gateResult.reason.includes("G-8-4"), "应含监控未就绪失败项");
  assert.ok(result.gateResult.reason.includes("G-8-5"), "应含回滚预案不存在失败项");
  // P1: G-8 未通过时按 success 选事件类型，不得谎发 devops-completed
  const eventTypes = emitter.events.map((e) => e.type);
  assert.ok(eventTypes.includes("devops-failed"), "G-8 未通过应发射 devops-failed");
  assert.ok(!eventTypes.includes("devops-completed"), "G-8 未通过不应发射 devops-completed");
});

test("①b 显式配置 monitoringReady/rollbackPlanExists=true 时 G-8 可判通过（不是一刀切）", async () => {
  clearLegacyFlag();
  const result = await createOrchestrator().run(
    createDevOpsContext({ monitoringReady: true, rollbackPlanExists: true })
  );
  assert.equal(result.gateResult.passed, true);
  assert.equal(result.success, true);
});

test("①c 注入真实检查器时以 ready / exists&&valid 为准（布尔置 true 不能绕过校验）", async () => {
  clearLegacyFlag();
  const orchestrator = new DevOpsOrchestrator({
    iacGenerators: [new StubIaCGenerator()],
    gateG8Checker: new GateG8CheckerImpl(),
    deployStrategy: new StubDeployStrategy(),
    deployStage: new StubDeployStage(),
    monitoringReadinessChecker: new NotReadyMonitoringChecker(),
    rollbackPlanChecker: new InvalidRollbackPlanChecker(),
  });

  const result = await orchestrator.run(
    createDevOpsContext({
      // 调用方试图用布尔 true 绕过，但注入了真实检查器 → 必须以真实结果为准
      monitoringReady: true,
      rollbackPlanExists: true,
      monitoringCheckContext: {
        projectName: "review-app",
        namespace: "default",
        serviceName: "review-app",
        metricsEndpoint: "http://127.0.0.1:1/metrics",
      },
      rollbackPlanCheckContext: { projectRoot: "/tmp", runId: "review-run-001" },
    })
  );

  assert.equal(result.gateResult.passed, false);
  assert.ok(result.gateResult.reason.includes("G-8-4"), "真实监控检查 ready=false 应判失败");
  assert.ok(result.gateResult.reason.includes("G-8-5"), "真实回滚预案 valid=false 应判失败");
  // errors 应带真实检查器证据，而非泛化 guidance
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("监控就绪检查未通过") || errorsStr.includes("回滚预案检查未通过"));
});

// ============================================================================
// ② P0-7: kubectl 输出非合法 JSON 时 verifyRollback 不报 success
// ============================================================================

test("② kubectl 输出非合法 JSON 时 verifyRollback 不报 success", async () => {
  const manager = new K8sRollbackManager({
    rollbackTimeoutMs: 0, // maxAttempts=1，避免轮询等待
    cliExecutor: async () => ({
      success: true,
      stdout: "this is NOT json {{{",
      stderr: "",
      exitCode: 0,
      errorMessage: "",
    }),
  });

  const result = await manager.verifyRollback("review-app", "default");

  assert.equal(result.success, false, "解析失败绝不能判验证成功");
  assert.ok(!result.message.includes("回滚验证成功"), "消息不得谎报验证成功");
  assert.ok(result.message.includes("parseOk=false") || result.message.includes("无法解析"));
});

test("②b kubectl 输出 null / 非法数值时不报 success（0/0 不再被当作达标）", async () => {
  for (const badStdout of ["null", "[]", '{"spec":{"replicas":"NaN"},"status":{"availableReplicas":"x"}}']) {
    const manager = new K8sRollbackManager({
      rollbackTimeoutMs: 0,
      cliExecutor: async () => ({
        success: true,
        stdout: badStdout,
        stderr: "",
        exitCode: 0,
        errorMessage: "",
      }),
    });
    const result = await manager.verifyRollback("review-app", "default");
    assert.equal(result.success, false, `stdout=${badStdout} 时不得判验证成功`);
  }
});

test("②c 合法 JSON 且副本达标时才判 success（确认修复未误伤正常路径）", async () => {
  const manager = new K8sRollbackManager({
    rollbackTimeoutMs: 0,
    cliExecutor: async () => ({
      success: true,
      stdout: JSON.stringify({ spec: { replicas: 3 }, status: { availableReplicas: 3 } }),
      stderr: "",
      exitCode: 0,
      errorMessage: "",
    }),
  });
  const result = await manager.verifyRollback("review-app", "default");
  assert.equal(result.success, true);
  assert.equal(result.currentReplicas, 3);
  assert.equal(result.expectedReplicas, 3);
});

// ============================================================================
// ③ P0-8: prometheusConfigPath 缺失时 ready 不为 true
// ============================================================================

test("③ prometheusConfigPath 缺失时 ready 不为 true（显式 skipped，不计入 ready）", async () => {
  clearLegacyFlag();
  const savedPath = process.env.PATH;
  process.env.PATH = "/nonexistent"; // 让 kubectl 快速失败，避免真实外部依赖
  try {
    const checker = new MonitoringReadinessCheckerImpl({ httpTimeoutMs: 100, kubectlTimeoutMs: 100 });
    const result = await checker.check({
      projectName: "review-app",
      namespace: "default",
      serviceName: "review-app",
      metricsEndpoint: "http://127.0.0.1:1/metrics",
      // 故意不提供 prometheusConfigPath
    });

    assert.notEqual(result.ready, true, "信息不足绝不能算作 ready");
    assert.equal(result.ready, false);
    const promItem = result.checkedItems.find((i) => i.name === "prometheusScrapeConfig");
    assert.ok(promItem, "应含 prometheusScrapeConfig 检查项");
    assert.equal(promItem.skipped, true, "缺失路径应显式标记 skipped");
    assert.equal(promItem.passed, false, "skipped 项 passed 必须为 false");
    assert.ok(
      result.failures.some((f) => f.includes("skipped")),
      "failures 应披露未执行项"
    );
  } finally {
    process.env.PATH = savedPath;
  }
});

// ============================================================================
// ④ P1: 烟雾测试 0 个用例时不报 passed
// ============================================================================

test("④ 烟雾测试 0 个用例时不报 passed（区分'一条都没跑'与'跑完零失败'）", async () => {
  clearLegacyFlag();
  const runner = new SmokeTestRunnerImpl();

  // endpoints 为空 → totalTests=0
  const emptyEndpoints = await runner.run([], [createTestCase()]);
  assert.equal(emptyEndpoints.passed, false);
  assert.equal(emptyEndpoints.totalTests, 0);
  assert.equal(emptyEndpoints.reason, "no-test-executed");

  // testCases 为空 → totalTests=0
  const emptyCases = await runner.run(["http://127.0.0.1:1"], []);
  assert.equal(emptyCases.passed, false);
  assert.equal(emptyCases.totalTests, 0);
  assert.equal(emptyCases.reason, "no-test-executed");
});

test("④b 跑完零失败仍判 passed=true（修复未误伤正常执行）", async () => {
  clearLegacyFlag();
  const { server, baseUrl } = await startLocalHttpServer();
  try {
    const runner = new SmokeTestRunnerImpl();
    const result = await runner.run([baseUrl], [createTestCase()]);
    assert.equal(result.totalTests, 1);
    assert.equal(result.failedTests, 0);
    assert.equal(result.passed, true);
    assert.equal(result.reason, undefined, "正常执行不应带 no-test-executed 原因");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ============================================================================
// ⑤ P1: 缺检查器且未显式确认时 allPassed 为 false
// ============================================================================

test("⑤ 缺检查器且未显式确认时 allPassed 为 false（默认 fail-closed）", () => {
  clearLegacyFlag();
  const orchestrator = new GateOrchestrator();
  const result = orchestrator.run(createGateContext({ loopType: "coding" }));

  assert.equal(result.allPassed, false, "coding 缺 G-4/G-5 检查器时不得报全绿");
  assert.ok((result.skippedGates ?? []).some((s) => s.reason === "no-checker"));
  assert.equal(result.firstFailedGate, "G-4");
});

test("⑤b 显式确认 strictGateCoverage:false 时恢复宽松语义", () => {
  clearLegacyFlag();
  const orchestrator = new GateOrchestrator({ strictGateCoverage: false });
  const result = orchestrator.run(createGateContext({ loopType: "coding" }));
  assert.equal(result.allPassed, true, "显式确认接受宽松覆盖时 allPassed 应为 true");
});

test("⑤c design Loop 不启用任何门禁 → allPassed=true（合理语义不改）", () => {
  clearLegacyFlag();
  const orchestrator = new GateOrchestrator();
  const result = orchestrator.run(createGateContext({ loopType: "design" }));
  assert.equal(result.allPassed, true);
  assert.deepEqual(result.skippedGates, []);
});

// ============================================================================
// G-3: 区分「采集失败致空」与「确认零变更」
// ============================================================================

test("G-3. actualChangesCollected=false 时零变更不判通过", () => {
  const checker = new GateG3Checker();
  const failed = checker.check(createGateContext({ actualChanges: [], actualChangesCollected: false }));
  assert.equal(failed.passed, false, "采集失败致空不得当作确认零变更");
  assert.ok(failed.reason.includes("采集失败"));

  const confirmed = checker.check(createGateContext({ actualChanges: [] }));
  assert.equal(confirmed.passed, true, "确认零变更保持既有通过语义");
});

// ============================================================================
// R: 环境变量回退开关契约
// ============================================================================

test("R. EAG_LEGACY_PASS_THROUGH=1 可回退到修复前语义（契约验证）", async () => {
  const saved = process.env[LEGACY_FLAG];
  process.env[LEGACY_FLAG] = "1";
  try {
    // 烟雾测试空集合恢复 passed=true
    const smoke = await new SmokeTestRunnerImpl().run([], []);
    assert.equal(smoke.passed, true);

    // gate 默认宽松覆盖恢复 allPassed=true
    const gate = new GateOrchestrator().run(createGateContext({ loopType: "coding" }));
    assert.equal(gate.allPassed, true);

    // devops-orchestrator 恢复 `?? true` 默认放行：未配置也让 G-8 通过
    const devops = await createOrchestrator().run(createDevOpsContext());
    assert.equal(devops.gateResult.passed, true);
  } finally {
    if (saved === undefined) {
      delete process.env[LEGACY_FLAG];
    } else {
      process.env[LEGACY_FLAG] = saved;
    }
  }
});
