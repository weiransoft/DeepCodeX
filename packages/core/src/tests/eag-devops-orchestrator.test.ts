/**
 * EAG-P4 批次 13 Phase 6 单元测试：DevOpsOrchestrator
 *
 * 测试范围（对齐设计文档 §6.2 D1-1 DevOpsOrchestrator 覆盖率 ≥ 85%）：
 * - T1. 实例化与接口契约
 *   - T1a. DevOpsOrchestrator 实例化成功
 *   - T1b. 实例化后存在 run 方法
 * - T2. 构造期不变式校验
 *   - T2a. iacGenerators 为空数组时抛异常
 *   - T2b. iacGenerators 为 undefined 时抛异常
 *   - T2c. gateG8Checker 为空时抛异常
 *   - T2d. deployStrategy 为空时抛异常
 *   - T2e. deployStage 为空时抛异常
 *   - T2f. eventEmitter 可选（不抛异常）
 * - T3. 完整流程成功（5 步全部通过）
 *   - T3a. run() 返回 success=true
 *   - T3b. 返回 DevOpsResult 含全部字段
 *   - T3c. iacTemplates 非空（多个生成器并行调用结果）
 *   - T3d. errors 为空数组
 *   - T3e. duration 为正数
 *   - T3f. DevOpsResult 已冻结（Object.isFrozen）
 *   - T3g. errors 数组已冻结
 * - T4. IaC 生成失败场景
 *   - T4a. IaC 生成器抛异常时 success=false
 *   - T4b. errors 含生成异常信息
 *   - T4c. devops-failed 事件被发射
 * - T5. IaC 校验失败场景
 *   - T5a. IaC 校验失败（valid=false）时 success=false
 *   - T5b. errors 含校验失败信息
 *   - T5c. 未找到对应生成器时 success=false
 * - T6. DeployStage 失败场景
 *   - T6a. DeployStage.execute() 返回 success=false 时 DevOpsOrchestrator success=false
 *   - T6b. errors 含 DeployStage 错误
 *   - T6c. N-M-4 修复：失败时 healthCheckResult 从 deployStageResult.healthEndpoints 构造（healthy=false）
 * - T7. G-8 门禁失败场景
 *   - T7a. GateG8Checker.check() 返回 passed=false 时 success=false
 *   - T7b. errors 含 G-8 失败原因
 * - T8. 事件发射验证
 *   - T8a. eventEmitter.emit() 被调用（成功流程：devops-started / iac-generated / smoke-test-passed / devops-completed）
 *   - T8b. eventEmitter.emit() 被调用（失败流程：devops-started / devops-failed）
 *   - T8c. eventEmitter 未注入时不抛异常
 * - T9. 不可变优先
 *   - T9a. DevOpsResult 已冻结
 *   - T9b. errors 数组已冻结
 *   - T9c. iacTemplates 数组中每个模板已冻结
 * - T10. 多生成器并行调用
 *   - T10a. 2 个生成器并行调用，iacTemplates 含两个生成器的产出
 *   - T10b. 3 个生成器并行调用，iacTemplates 含三个生成器的产出
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实测试替身类（实现真实接口，返回真实数据）
 * - 测试替身类与 eag-deploy-stage.test.ts 中的 AlwaysPassPreDeployChecker 等同构
 * - 中文详细注释（每个测试函数和关键断言）
 * - 测试用例编号 T1a/T1b/T2a/... 与设计文档对齐
 *
 * @module core/tests/eag-devops-orchestrator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DevOpsOrchestrator } from "../eag/devops/devops-orchestrator";
import type {
  DevOpsOrchestratorOptions,
  DevOpsContext,
  DevOpsResult,
  IaCTemplate,
  IaCGenerator,
  IaCGenerationContext,
  IaCValidationResult,
  IaCType,
  DeployStrategy,
  DeployContext,
  DeployResult,
  DeployedResource,
  HealthCheckResult,
  HealthEndpoint,
  SmokeTestResult,
  SmokeTestFailure,
  SmokeTestCase,
  DeployStage,
  DeployStageResult,
  DevOpsEvent,
  DevOpsEventEmitter,
  GateG8Checker,
  GateG8Context,
} from "../eag/devops/types";
import type { GateResult } from "../eag/gate/gate-types";

// ============================================================================
// 测试替身类（真实实现接口，返回真实数据，非 mock）
// ============================================================================

/**
 * AlwaysPassIaCGenerator —— 始终成功的 IaC 生成器测试替身
 *
 * 实现 IaCGenerator 接口：
 * - iacType 可配置（构造时传入，默认 "k8s-manifest"）
 * - generate() 返回 1~2 个真实 IaCTemplate 对象
 * - validate() 返回 { valid: true, errors: [], validatedBy: "kubectl-dry-run" }
 *
 * 用于测试 DevOpsOrchestrator 的正常流程与多生成器并行调用。
 */
class AlwaysPassIaCGenerator implements IaCGenerator {
  /** IaC 类型标识（构造时配置，默认 "k8s-manifest"） */
  public readonly iacType: IaCType;
  /** 生成模板数量（构造时配置，默认 2） */
  private readonly templateCount: number;

  /**
   * @param iacType IaC 类型标识（默认 "k8s-manifest"）
   * @param templateCount 生成模板数量（默认 2）
   */
  constructor(iacType: IaCType = "k8s-manifest", templateCount: number = 2) {
    this.iacType = iacType;
    this.templateCount = templateCount;
  }

  /**
   * 生成 IaC 模板（返回真实 IaCTemplate 对象）
   *
   * @param context IaC 生成上下文
   * @returns IaC 模板数组（1~2 个模板）
   */
  generate(context: IaCGenerationContext): IaCTemplate[] {
    void context; // 不使用上下文字段，但保留参数以符合接口签名
    const templates: IaCTemplate[] = [];
    const generatedAt = new Date().toISOString();
    // 根据 templateCount 生成对应数量的模板
    for (let i = 0; i < this.templateCount; i++) {
      templates.push(
        Object.freeze({
          type: this.iacType,
          content: `# IaC template ${i + 1} for ${this.iacType}`,
          filePath: `template-${this.iacType}-${i + 1}.yaml`,
          hash: `hash-${this.iacType}-${i + 1}-${Date.now()}`,
          generatedAt,
        }) as IaCTemplate
      );
    }
    return templates;
  }

  /**
   * 校验 IaC 模板（始终返回 valid=true）
   *
   * @param template 待校验的 IaC 模板
   * @returns 校验结果（valid=true）
   */
  async validate(template: IaCTemplate): Promise<IaCValidationResult> {
    void template; // 不使用模板字段，但保留参数以符合接口签名
    return Object.freeze({
      valid: true,
      errors: Object.freeze([]) as ReadonlyArray<string>,
      validatedBy: "kubectl-dry-run",
    }) as IaCValidationResult;
  }
}

/**
 * AlwaysFailIaCGenerator —— 始终失败的 IaC 生成器测试替身
 *
 * 实现 IaCGenerator 接口：
 * - generate() 始终抛出异常 "IaC 生成失败"
 * - validate() 不会被调用（generate 已抛错）
 *
 * 用于测试 DevOpsOrchestrator 的 IaC 生成失败场景。
 */
class AlwaysFailIaCGenerator implements IaCGenerator {
  public readonly iacType: IaCType = "terraform";

  /**
   * 生成 IaC 模板（始终抛异常）
   *
   * @throws Error "IaC 生成失败"
   */
  generate(_context: IaCGenerationContext): IaCTemplate[] {
    void _context;
    throw new Error("IaC 生成失败");
  }

  /**
   * 校验 IaC 模板（不会被执行）
   */
  async validate(template: IaCTemplate): Promise<IaCValidationResult> {
    void template;
    return Object.freeze({
      valid: true,
      errors: Object.freeze([]) as ReadonlyArray<string>,
      validatedBy: "terraform-validate",
    }) as IaCValidationResult;
  }
}

/**
 * AlwaysFailValidationIaCGenerator —— 生成成功但校验失败的 IaC 生成器测试替身
 *
 * 实现 IaCGenerator 接口：
 * - generate() 返回 1 个 IaCTemplate
 * - validate() 返回 { valid: false, errors: ["HCL 语法错误"], validatedBy: "terraform-validate" }
 *
 * 用于测试 DevOpsOrchestrator 的 IaC 校验失败场景。
 */
class AlwaysFailValidationIaCGenerator implements IaCGenerator {
  public readonly iacType: IaCType = "terraform";

  /**
   * 生成 IaC 模板（返回 1 个模板）
   */
  generate(context: IaCGenerationContext): IaCTemplate[] {
    void context;
    return [
      Object.freeze({
        type: this.iacType,
        content: "# invalid HCL content",
        filePath: "main.tf",
        hash: `hash-fail-${Date.now()}`,
        generatedAt: new Date().toISOString(),
      }) as IaCTemplate,
    ];
  }

  /**
   * 校验 IaC 模板（始终返回 valid=false）
   *
   * @returns 校验结果（valid=false，含 "HCL 语法错误"）
   */
  async validate(template: IaCTemplate): Promise<IaCValidationResult> {
    void template;
    return Object.freeze({
      valid: false,
      errors: Object.freeze(["HCL 语法错误"]) as ReadonlyArray<string>,
      validatedBy: "terraform-validate",
    }) as IaCValidationResult;
  }
}

/**
 * TypeMismatchIaCGenerator —— 生成模板类型与自身 iacType 不匹配的 IaC 生成器测试替身
 *
 * 实现 IaCGenerator 接口：
 * - iacType 为 "terraform"（注册时声明）
 * - generate() 返回 type="helm-chart" 的模板（与 iacType 不匹配）
 * - validate() 不会被调用（因为找不到匹配的生成器）
 *
 * 用于测试 DevOpsOrchestrator 的"未找到对应生成器"场景（T5c）。
 */
class TypeMismatchIaCGenerator implements IaCGenerator {
  public readonly iacType: IaCType = "terraform";

  /**
   * 生成 IaC 模板（返回 type="helm-chart" 的模板，与 iacType="terraform" 不匹配）
   */
  generate(context: IaCGenerationContext): IaCTemplate[] {
    void context;
    return [
      Object.freeze({
        type: "helm-chart", // 故意与 iacType="terraform" 不匹配
        content: "# helm chart content",
        filePath: "Chart.yaml",
        hash: `hash-mismatch-${Date.now()}`,
        generatedAt: new Date().toISOString(),
      }) as IaCTemplate,
    ];
  }

  /**
   * 校验 IaC 模板（不会被调用）
   */
  async validate(template: IaCTemplate): Promise<IaCValidationResult> {
    void template;
    return Object.freeze({
      valid: true,
      errors: Object.freeze([]) as ReadonlyArray<string>,
      validatedBy: "helm-lint",
    }) as IaCValidationResult;
  }
}

/**
 * AlwaysPassGateG8Checker —— 始终通过的 G-8 检查器测试替身
 *
 * 实现 GateG8Checker 接口：
 * - gateId 固定为 "G-8"
 * - check() 返回 { passed: true, gate: "G-8", reason: "全部通过", severity: "blocker" }
 *
 * 用于测试 DevOpsOrchestrator 的 G-8 门禁通过场景。
 */
class AlwaysPassGateG8Checker implements GateG8Checker {
  public readonly gateId = "G-8" as const;

  /**
   * 执行 G-8 门禁检查（始终返回 passed=true）
   *
   * @param context G-8 门禁上下文（不使用）
   * @returns 门禁判定结果（passed=true）
   */
  check(context: GateG8Context): GateResult {
    void context;
    return Object.freeze({
      passed: true,
      gate: "G-8",
      reason: "全部通过",
      severity: "blocker",
    }) as GateResult;
  }
}

/**
 * AlwaysFailGateG8Checker —— 始终失败的 G-8 检查器测试替身
 *
 * 实现 GateG8Checker 接口：
 * - gateId 固定为 "G-8"
 * - check() 返回 { passed: false, gate: "G-8", reason: "健康检查未就绪", guidance: "检查 Pod 状态", severity: "blocker" }
 *
 * 用于测试 DevOpsOrchestrator 的 G-8 门禁失败场景。
 */
class AlwaysFailGateG8Checker implements GateG8Checker {
  public readonly gateId = "G-8" as const;

  /**
   * 执行 G-8 门禁检查（始终返回 passed=false）
   *
   * @param context G-8 门禁上下文（不使用）
   * @returns 门禁判定结果（passed=false，含失败原因与引导消息）
   */
  check(context: GateG8Context): GateResult {
    void context;
    return Object.freeze({
      passed: false,
      gate: "G-8",
      reason: "健康检查未就绪",
      guidance: "检查 Pod 状态",
      severity: "blocker",
    }) as GateResult;
  }
}

/**
 * AlwaysSuccessDeployStage —— 始终成功的 DeployStage 测试替身
 *
 * 实现 DeployStage 接口：
 * - execute() 返回完整 DeployStageResult（success=true，含 deployResult / smokeTestResult / healthEndpoints）
 *
 * 用于测试 DevOpsOrchestrator 的 DeployStage 成功场景。
 */
class AlwaysSuccessDeployStage implements DeployStage {
  /**
   * 执行 DEPLOY 阶段（始终返回 success=true）
   *
   * @param context DevOps 编排上下文（不使用）
   * @param iacTemplates IaC 模板列表（不使用）
   * @param deployStrategy 部署策略（不使用）
   * @returns DeployStageResult（success=true，含完整字段）
   */
  async execute(
    context: DevOpsContext,
    iacTemplates: ReadonlyArray<IaCTemplate>,
    deployStrategy: DeployStrategy
  ): Promise<DeployStageResult> {
    void context;
    void iacTemplates;
    void deployStrategy;
    // 构造已部署资源列表（1 个 Deployment + 1 个 Service）
    const resources: DeployedResource[] = [
      { kind: "Deployment", name: "test-app", namespace: "test-app", status: "Running" },
      { kind: "Service", name: "test-app-service", namespace: "test-app", status: "Running" },
    ];
    // 构造部署结果（success=true）
    const deployResult: DeployResult = Object.freeze({
      success: true,
      deployedAt: new Date().toISOString(),
      duration: 5000,
      resources: Object.freeze([...resources]) as ReadonlyArray<DeployedResource>,
      errors: Object.freeze([]) as ReadonlyArray<string>,
    }) as DeployResult;
    // 构造烟雾测试结果（passed=true）
    const smokeTestResult: SmokeTestResult = Object.freeze({
      passed: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      duration: 100,
      failures: Object.freeze([]) as ReadonlyArray<SmokeTestFailure>,
    }) as SmokeTestResult;
    // 构造健康端点列表（1 个健康端点）
    const healthEndpoints: ReadonlyArray<HealthEndpoint> = Object.freeze([
      Object.freeze({
        url: "http://test-app.example.com/healthz",
        statusCode: 200,
        responseTimeMs: 50,
        healthy: true,
      }) as HealthEndpoint,
    ]) as ReadonlyArray<HealthEndpoint>;
    // 构造完整的 DeployStageResult（4 步全部成功）
    return Object.freeze({
      success: true,
      preDeployPassed: true,
      deployResult,
      postDeployPassed: true,
      smokeTestResult,
      healthEndpoints,
      rollbackExecuted: false,
      errors: Object.freeze([]) as ReadonlyArray<string>,
    }) as DeployStageResult;
  }
}

/**
 * AlwaysFailDeployStage —— 始终失败的 DeployStage 测试替身
 *
 * 实现 DeployStage 接口：
 * - execute() 返回 DeployStageResult（success=false，errors 含 "DeployStage 失败"，healthEndpoints 含 1 个不健康端点）
 *
 * 用于测试 DevOpsOrchestrator 的 DeployStage 失败场景（N-M-4 修复验证）。
 */
class AlwaysFailDeployStage implements DeployStage {
  /**
   * 执行 DEPLOY 阶段（始终返回 success=false）
   *
   * @param context DevOps 编排上下文（不使用）
   * @param iacTemplates IaC 模板列表（不使用）
   * @param deployStrategy 部署策略（不使用）
   * @returns DeployStageResult（success=false，含错误信息与不健康端点）
   */
  async execute(
    context: DevOpsContext,
    iacTemplates: ReadonlyArray<IaCTemplate>,
    deployStrategy: DeployStrategy
  ): Promise<DeployStageResult> {
    void context;
    void iacTemplates;
    void deployStrategy;
    // 构造健康端点列表（1 个不健康端点，用于验证 N-M-4 修复）
    const healthEndpoints: ReadonlyArray<HealthEndpoint> = Object.freeze([
      Object.freeze({
        url: "http://test-app.example.com/healthz",
        statusCode: 503,
        responseTimeMs: 100,
        healthy: false, // 失败场景下端点不健康
      }) as HealthEndpoint,
    ]) as ReadonlyArray<HealthEndpoint>;
    // 构造 DeployStageResult（success=false，含错误信息）
    return Object.freeze({
      success: false,
      preDeployPassed: true,
      deployResult: undefined,
      postDeployPassed: false,
      smokeTestResult: undefined,
      healthEndpoints,
      rollbackExecuted: false,
      errors: Object.freeze(["DeployStage 失败"]) as ReadonlyArray<string>,
    }) as DeployStageResult;
  }
}

/**
 * SuccessDeployStrategy —— 部署策略测试替身
 *
 * 实现 DeployStrategy 接口：
 * - strategyType = "rolling"
 * - execute() 返回成功 DeployResult（含 1 个 Deployment + 1 个 Service 资源）
 *
 * 用于测试 DevOpsOrchestrator 的部署策略注入（DevOpsOrchestrator 将其传递给 DeployStage）。
 */
class SuccessDeployStrategy implements DeployStrategy {
  public readonly strategyType = "rolling" as const;

  /**
   * 执行部署（返回成功 DeployResult）
   *
   * @param context 部署上下文（不使用）
   * @returns DeployResult（success=true，含 1 个 Deployment + 1 个 Service）
   */
  async execute(context: DeployContext): Promise<DeployResult> {
    void context;
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
 * TrackingEventEmitter —— 跟踪事件发射的 EventEmitter 测试替身
 *
 * 实现 DevOpsEventEmitter 接口：
 * - emit(event) 将事件 push 到 events 数组（public 字段，测试可读取）
 * - events 数组供测试断言事件类型和顺序
 *
 * 用于测试 DevOpsOrchestrator 的事件发射逻辑（成功流程与失败流程）。
 */
class TrackingEventEmitter implements DevOpsEventEmitter {
  /** 已发射的事件列表（public 字段，测试可读取以断言事件类型和顺序） */
  public readonly events: DevOpsEvent[] = [];

  /**
   * 发射 DevOps 事件（将事件 push 到 events 数组）
   *
   * @param event DevOps 事件
   */
  emit(event: DevOpsEvent): void {
    this.events.push(event);
  }
}

// ============================================================================
// 辅助函数：构造 DevOpsContext 与 DevOpsOrchestratorOptions
// ============================================================================

/**
 * 构造测试用 DevOpsContext
 *
 * 包含完整字段：
 * - runId / sessionId（基础字段，与既有 eag-deploy-stage.test.ts 同构）
 * - projectId / loopType（GateContext 字段，用于 GateG8Context 构造时的 spread）
 * - iacGenerationContext（IaC 生成上下文）
 * - deployContext（部署上下文）
 * - smokeTestCases（烟雾测试用例）
 *
 * @returns 完整的 DevOpsContext
 */
function createContext(): DevOpsContext {
  return {
    // GateContext 基础字段
    projectId: "test-project",
    loopType: "deploy" as const,
    specStatus: "approved" as const,
    planStatus: "approved" as const,
    reviewRecords: [],
    userApproved: true,
    taskCard: { id: "T-001", title: "test", status: "completed" } as never,
    actualChanges: [],
    // DevOpsContext 扩展字段
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
  } as unknown as DevOpsContext;
}

/**
 * 构造测试用 DevOpsOrchestratorOptions（默认全部通过）
 *
 * 默认配置：
 * - iacGenerators: [new AlwaysPassIaCGenerator()]（1 个始终通过的生成器）
 * - gateG8Checker: new AlwaysPassGateG8Checker()
 * - deployStrategy: new SuccessDeployStrategy()
 * - deployStage: new AlwaysSuccessDeployStage()
 * - eventEmitter: undefined（可选，测试时通过 overrides 注入）
 *
 * @param overrides 覆盖字段
 * @returns 完整的 DevOpsOrchestratorOptions
 */
function createOptions(overrides: Partial<DevOpsOrchestratorOptions> = {}): DevOpsOrchestratorOptions {
  return {
    iacGenerators: [new AlwaysPassIaCGenerator()],
    gateG8Checker: new AlwaysPassGateG8Checker(),
    deployStrategy: new SuccessDeployStrategy(),
    deployStage: new AlwaysSuccessDeployStage(),
    ...overrides,
  };
}

// ============================================================================
// T1. 实例化与接口契约
// ============================================================================

test("T1a. DevOpsOrchestrator 实例化成功", () => {
  const orchestrator = new DevOpsOrchestrator(createOptions());
  assert.ok(orchestrator instanceof DevOpsOrchestrator);
});

test("T1b. 实例化后存在 run 方法", () => {
  const orchestrator = new DevOpsOrchestrator(createOptions());
  assert.equal(typeof orchestrator.run, "function");
});

// ============================================================================
// T2. 构造期不变式校验
// ============================================================================

test("T2a. iacGenerators 为空数组时抛异常", () => {
  assert.throws(() => new DevOpsOrchestrator(createOptions({ iacGenerators: [] })), /iacGenerators 不能为空/);
});

test("T2b. iacGenerators 为 undefined 时抛异常", () => {
  assert.throws(
    () => new DevOpsOrchestrator(createOptions({ iacGenerators: undefined as unknown as ReadonlyArray<IaCGenerator> })),
    /iacGenerators 不能为空/
  );
});

test("T2c. gateG8Checker 为空时抛异常", () => {
  assert.throws(
    () => new DevOpsOrchestrator(createOptions({ gateG8Checker: undefined as unknown as GateG8Checker })),
    /gateG8Checker 必填/
  );
});

test("T2d. deployStrategy 为空时抛异常", () => {
  assert.throws(
    () => new DevOpsOrchestrator(createOptions({ deployStrategy: undefined as unknown as DeployStrategy })),
    /deployStrategy 必填/
  );
});

test("T2e. deployStage 为空时抛异常", () => {
  assert.throws(
    () => new DevOpsOrchestrator(createOptions({ deployStage: undefined as unknown as DeployStage })),
    /deployStage 必填/
  );
});

test("T2f. eventEmitter 可选（不抛异常）", () => {
  // 不注入 eventEmitter 时不应抛异常
  const orchestrator = new DevOpsOrchestrator(createOptions());
  assert.ok(orchestrator instanceof DevOpsOrchestrator);
});

// ============================================================================
// T3. 完整流程成功（5 步全部通过）
// ============================================================================

test("T3a. run() 返回 success=true", async () => {
  const orchestrator = new DevOpsOrchestrator(createOptions());
  const result = await orchestrator.run(createContext());
  assert.equal(result.success, true);
});

test("T3b. 返回 DevOpsResult 含全部字段", async () => {
  const orchestrator = new DevOpsOrchestrator(createOptions());
  const result: DevOpsResult = await orchestrator.run(createContext());
  // 验证 DevOpsResult 接口的全部字段都存在
  assert.ok("success" in result, "应含 success 字段");
  assert.ok("runId" in result, "应含 runId 字段");
  assert.ok("startedAt" in result, "应含 startedAt 字段");
  assert.ok("finishedAt" in result, "应含 finishedAt 字段");
  assert.ok("duration" in result, "应含 duration 字段");
  assert.ok("iacTemplates" in result, "应含 iacTemplates 字段");
  assert.ok("deployResult" in result, "应含 deployResult 字段");
  assert.ok("healthCheckResult" in result, "应含 healthCheckResult 字段");
  assert.ok("smokeTestResult" in result, "应含 smokeTestResult 字段");
  assert.ok("gateResult" in result, "应含 gateResult 字段");
  assert.ok("errors" in result, "应含 errors 字段");
  // 验证关键字段值
  assert.equal(result.runId, "test-run-001");
  assert.ok(result.deployResult !== undefined, "deployResult 应有值");
  assert.ok(result.healthCheckResult !== undefined, "healthCheckResult 应有值");
  assert.ok(result.smokeTestResult !== undefined, "smokeTestResult 应有值");
  assert.ok(result.gateResult !== undefined, "gateResult 应有值");
});

test("T3c. iacTemplates 非空（多个生成器并行调用结果）", async () => {
  // 使用 2 个生成器，每个生成 2 个模板，预期 iacTemplates 含 4 个模板
  const orchestrator = new DevOpsOrchestrator(
    createOptions({
      iacGenerators: [new AlwaysPassIaCGenerator("terraform", 2), new AlwaysPassIaCGenerator("k8s-manifest", 2)],
    })
  );
  const result = await orchestrator.run(createContext());
  assert.ok(result.iacTemplates.length >= 1, "iacTemplates 应非空");
  assert.equal(result.iacTemplates.length, 4, "iacTemplates 应含 4 个模板（2 个生成器 × 2 个模板）");
});

test("T3d. errors 为空数组", async () => {
  const orchestrator = new DevOpsOrchestrator(createOptions());
  const result = await orchestrator.run(createContext());
  assert.equal(result.errors.length, 0);
});

test("T3e. duration 为非负数（M-10 修复：毫秒相减）", async () => {
  const orchestrator = new DevOpsOrchestrator(createOptions());
  const result = await orchestrator.run(createContext());
  // M-10 修复：duration 直接用毫秒相减，避免 ISO 字符串 parse 误差
  // 单元测试中使用测试替身执行速度极快，duration 可能为 0（毫秒精度不足以区分）
  // 实际生产环境中 duration 一定 > 0（涉及 IaC 生成/校验/部署等多步骤）
  // 此处断言为非负数（>= 0），符合实际语义
  assert.ok(result.duration >= 0, `duration 应为非负数，实际：${result.duration}`);
  // 同时验证 duration 是数字类型（M-10 修复：避免 ISO 字符串相减导致 NaN）
  assert.equal(typeof result.duration, "number", "duration 应为 number 类型");
  assert.ok(!Number.isNaN(result.duration), "duration 不应为 NaN");
});

test("T3f. DevOpsResult 已冻结（Object.isFrozen）", async () => {
  const orchestrator = new DevOpsOrchestrator(createOptions());
  const result = await orchestrator.run(createContext());
  assert.equal(Object.isFrozen(result), true);
});

test("T3g. errors 数组已冻结", async () => {
  const orchestrator = new DevOpsOrchestrator(createOptions());
  const result = await orchestrator.run(createContext());
  assert.equal(Object.isFrozen(result.errors), true);
});

// ============================================================================
// T4. IaC 生成失败场景
// ============================================================================

test("T4a. IaC 生成器抛异常时 success=false", async () => {
  const orchestrator = new DevOpsOrchestrator(createOptions({ iacGenerators: [new AlwaysFailIaCGenerator()] }));
  const result = await orchestrator.run(createContext());
  assert.equal(result.success, false);
});

test("T4b. errors 含生成异常信息", async () => {
  const orchestrator = new DevOpsOrchestrator(createOptions({ iacGenerators: [new AlwaysFailIaCGenerator()] }));
  const result = await orchestrator.run(createContext());
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("IaC 生成失败"), `errors 应含"IaC 生成失败"，实际：${errorsStr}`);
});

test("T4c. devops-failed 事件被发射", async () => {
  const eventEmitter = new TrackingEventEmitter();
  const orchestrator = new DevOpsOrchestrator(
    createOptions({
      iacGenerators: [new AlwaysFailIaCGenerator()],
      eventEmitter,
    })
  );
  await orchestrator.run(createContext());
  // 验证 devops-failed 事件被发射
  const failedEvents = eventEmitter.events.filter((e) => e.type === "devops-failed");
  assert.equal(failedEvents.length, 1, "应发射 1 个 devops-failed 事件");
  // 验证事件携带错误信息
  const failedEvent = failedEvents[0] as { type: string; error: string };
  assert.ok(failedEvent.error.includes("IaC 生成失败"), "devops-failed 事件应携带错误信息");
});

// ============================================================================
// T5. IaC 校验失败场景
// ============================================================================

test("T5a. IaC 校验失败（valid=false）时 success=false", async () => {
  const orchestrator = new DevOpsOrchestrator(
    createOptions({ iacGenerators: [new AlwaysFailValidationIaCGenerator()] })
  );
  const result = await orchestrator.run(createContext());
  assert.equal(result.success, false);
});

test("T5b. errors 含校验失败信息", async () => {
  const orchestrator = new DevOpsOrchestrator(
    createOptions({ iacGenerators: [new AlwaysFailValidationIaCGenerator()] })
  );
  const result = await orchestrator.run(createContext());
  const errorsStr = result.errors.join(" ");
  // 验证 errors 含校验失败信息（含文件名与错误原因）
  assert.ok(errorsStr.includes("main.tf"), `errors 应含"main.tf"，实际：${errorsStr}`);
  assert.ok(errorsStr.includes("HCL 语法错误"), `errors 应含"HCL 语法错误"，实际：${errorsStr}`);
  assert.ok(errorsStr.includes("校验失败"), `errors 应含"校验失败"，实际：${errorsStr}`);
});

test("T5c. 未找到对应生成器时 success=false", async () => {
  // TypeMismatchIaCGenerator 的 iacType="terraform"，但 generate() 返回 type="helm-chart" 的模板
  // validateIaCTemplates 会查找 iacType="helm-chart" 的生成器，找不到时抛错
  const orchestrator = new DevOpsOrchestrator(createOptions({ iacGenerators: [new TypeMismatchIaCGenerator()] }));
  const result = await orchestrator.run(createContext());
  assert.equal(result.success, false);
  // 验证 errors 含"未找到 IaC 类型 helm-chart 对应的生成器"
  const errorsStr = result.errors.join(" ");
  assert.ok(
    errorsStr.includes("未找到 IaC 类型 helm-chart 对应的生成器"),
    `errors 应含"未找到 IaC 类型 helm-chart 对应的生成器"，实际：${errorsStr}`
  );
});

// ============================================================================
// T6. DeployStage 失败场景
// ============================================================================

test("T6a. DeployStage.execute() 返回 success=false 时 DevOpsOrchestrator success=false", async () => {
  const orchestrator = new DevOpsOrchestrator(createOptions({ deployStage: new AlwaysFailDeployStage() }));
  const result = await orchestrator.run(createContext());
  assert.equal(result.success, false);
});

test("T6b. errors 含 DeployStage 错误", async () => {
  const orchestrator = new DevOpsOrchestrator(createOptions({ deployStage: new AlwaysFailDeployStage() }));
  const result = await orchestrator.run(createContext());
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("DeployStage 失败"), `errors 应含"DeployStage 失败"，实际：${errorsStr}`);
  assert.ok(errorsStr.includes("DeployStage 执行失败"), `errors 应含"DeployStage 执行失败"，实际：${errorsStr}`);
});

test("T6c. N-M-4 修复：失败时 healthCheckResult 从 deployStageResult.healthEndpoints 构造（healthy=false）", async () => {
  const orchestrator = new DevOpsOrchestrator(createOptions({ deployStage: new AlwaysFailDeployStage() }));
  const result = await orchestrator.run(createContext());
  // N-M-4 修复：失败时仍从 deployStageResult.healthEndpoints 构造 healthCheckResult
  assert.ok(result.healthCheckResult !== undefined, "healthCheckResult 应有值（N-M-4 修复）");
  const healthCheck: HealthCheckResult = result.healthCheckResult as HealthCheckResult;
  // 失败场景下 healthy 应为 false
  assert.equal(healthCheck.healthy, false, "失败时 healthCheckResult.healthy 应为 false");
  // endpoints 应从 deployStageResult.healthEndpoints 填充（1 个不健康端点）
  assert.equal(healthCheck.endpoints.length, 1, "healthCheckResult.endpoints 应含 1 个端点");
  assert.equal(healthCheck.endpoints[0].url, "http://test-app.example.com/healthz");
  assert.equal(healthCheck.endpoints[0].healthy, false, "端点应不健康");
});

// ============================================================================
// T7. G-8 门禁失败场景
// ============================================================================

test("T7a. GateG8Checker.check() 返回 passed=false 时 success=false", async () => {
  const orchestrator = new DevOpsOrchestrator(createOptions({ gateG8Checker: new AlwaysFailGateG8Checker() }));
  const result = await orchestrator.run(createContext());
  // G-8 门禁未通过，success 应为 false
  assert.equal(result.success, false);
  // gateResult 应记录 G-8 门禁的失败结果
  assert.ok(result.gateResult !== undefined);
  assert.equal(result.gateResult.passed, false);
  assert.equal(result.gateResult.gate, "G-8");
});

test("T7b. errors 含 G-8 失败原因", async () => {
  const orchestrator = new DevOpsOrchestrator(createOptions({ gateG8Checker: new AlwaysFailGateG8Checker() }));
  const result = await orchestrator.run(createContext());
  const errorsStr = result.errors.join(" ");
  assert.ok(errorsStr.includes("G-8 门禁未通过"), `errors 应含"G-8 门禁未通过"，实际：${errorsStr}`);
  assert.ok(errorsStr.includes("健康检查未就绪"), `errors 应含 G-8 失败原因"健康检查未就绪"，实际：${errorsStr}`);
});

// ============================================================================
// T8. 事件发射验证
// ============================================================================

test("T8a. eventEmitter.emit() 被调用（成功流程：devops-started / iac-generated / smoke-test-passed / devops-completed）", async () => {
  const eventEmitter = new TrackingEventEmitter();
  const orchestrator = new DevOpsOrchestrator(createOptions({ eventEmitter }));
  await orchestrator.run(createContext());
  // 验证事件类型与顺序
  const eventTypes = eventEmitter.events.map((e) => e.type);
  assert.ok(eventTypes.includes("devops-started"), "应发射 devops-started 事件");
  assert.ok(eventTypes.includes("iac-generated"), "应发射 iac-generated 事件");
  assert.ok(eventTypes.includes("smoke-test-passed"), "应发射 smoke-test-passed 事件");
  assert.ok(eventTypes.includes("devops-completed"), "应发射 devops-completed 事件");
  // 验证事件顺序：devops-started 应在 devops-completed 之前
  const startedIdx = eventTypes.indexOf("devops-started");
  const completedIdx = eventTypes.indexOf("devops-completed");
  assert.ok(startedIdx < completedIdx, "devops-started 应在 devops-completed 之前");
  // 成功流程不应发射 devops-failed 事件
  assert.ok(!eventTypes.includes("devops-failed"), "成功流程不应发射 devops-failed 事件");
});

test("T8b. eventEmitter.emit() 被调用（失败流程：devops-started / devops-failed）", async () => {
  const eventEmitter = new TrackingEventEmitter();
  const orchestrator = new DevOpsOrchestrator(
    createOptions({
      iacGenerators: [new AlwaysFailIaCGenerator()],
      eventEmitter,
    })
  );
  await orchestrator.run(createContext());
  // 验证事件类型
  const eventTypes = eventEmitter.events.map((e) => e.type);
  assert.ok(eventTypes.includes("devops-started"), "应发射 devops-started 事件");
  assert.ok(eventTypes.includes("devops-failed"), "应发射 devops-failed 事件");
  // 失败流程不应发射 devops-completed 事件
  assert.ok(!eventTypes.includes("devops-completed"), "失败流程不应发射 devops-completed 事件");
});

test("T8c. eventEmitter 未注入时不抛异常", async () => {
  // 不注入 eventEmitter 时不应抛异常
  const orchestrator = new DevOpsOrchestrator(createOptions());
  const result = await orchestrator.run(createContext());
  // 应正常返回成功结果
  assert.equal(result.success, true);
});

// ============================================================================
// T9. 不可变优先
// ============================================================================

test("T9a. DevOpsResult 已冻结", async () => {
  const orchestrator = new DevOpsOrchestrator(createOptions());
  const result = await orchestrator.run(createContext());
  assert.equal(Object.isFrozen(result), true);
});

test("T9b. errors 数组已冻结", async () => {
  const orchestrator = new DevOpsOrchestrator(createOptions());
  const result = await orchestrator.run(createContext());
  assert.equal(Object.isFrozen(result.errors), true);
});

test("T9c. iacTemplates 数组中每个模板已冻结", async () => {
  const orchestrator = new DevOpsOrchestrator(
    createOptions({
      iacGenerators: [new AlwaysPassIaCGenerator("terraform", 2), new AlwaysPassIaCGenerator("k8s-manifest", 1)],
    })
  );
  const result = await orchestrator.run(createContext());
  // 验证每个模板都已冻结
  for (const template of result.iacTemplates) {
    assert.equal(Object.isFrozen(template), true, "每个 IaCTemplate 应已冻结");
  }
});

// ============================================================================
// T10. 多生成器并行调用
// ============================================================================

test("T10a. 2 个生成器并行调用，iacTemplates 含两个生成器的产出", async () => {
  const orchestrator = new DevOpsOrchestrator(
    createOptions({
      iacGenerators: [new AlwaysPassIaCGenerator("terraform", 2), new AlwaysPassIaCGenerator("k8s-manifest", 3)],
    })
  );
  const result = await orchestrator.run(createContext());
  // 2 个生成器并行调用，预期 iacTemplates 含 5 个模板（2 + 3）
  assert.equal(result.iacTemplates.length, 5, "iacTemplates 应含 5 个模板（2 + 3）");
  // 验证两个生成器的产出都包含在内
  const terraformTemplates = result.iacTemplates.filter((t) => t.type === "terraform");
  const k8sTemplates = result.iacTemplates.filter((t) => t.type === "k8s-manifest");
  assert.equal(terraformTemplates.length, 2, "应含 2 个 terraform 模板");
  assert.equal(k8sTemplates.length, 3, "应含 3 个 k8s-manifest 模板");
});

test("T10b. 3 个生成器并行调用，iacTemplates 含三个生成器的产出", async () => {
  const orchestrator = new DevOpsOrchestrator(
    createOptions({
      iacGenerators: [
        new AlwaysPassIaCGenerator("terraform", 1),
        new AlwaysPassIaCGenerator("k8s-manifest", 2),
        new AlwaysPassIaCGenerator("helm-chart", 3),
      ],
    })
  );
  const result = await orchestrator.run(createContext());
  // 3 个生成器并行调用，预期 iacTemplates 含 6 个模板（1 + 2 + 3）
  assert.equal(result.iacTemplates.length, 6, "iacTemplates 应含 6 个模板（1 + 2 + 3）");
  // 验证三个生成器的产出都包含在内
  const terraformTemplates = result.iacTemplates.filter((t) => t.type === "terraform");
  const k8sTemplates = result.iacTemplates.filter((t) => t.type === "k8s-manifest");
  const helmTemplates = result.iacTemplates.filter((t) => t.type === "helm-chart");
  assert.equal(terraformTemplates.length, 1, "应含 1 个 terraform 模板");
  assert.equal(k8sTemplates.length, 2, "应含 2 个 k8s-manifest 模板");
  assert.equal(helmTemplates.length, 3, "应含 3 个 helm-chart 模板");
});
