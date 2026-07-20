/**
 * DevOps 角色核心类型定义（EAG-P4 批次 13 D1-4）
 *
 * 本模块定义 DevOps 第 6 角色（DevOpsOrchestrator）+ DEPLOY 子阶段编排器（DeployStage）
 * 所需的全部结构化数据类型，覆盖 IaC 模板、部署策略、健康检查、烟雾测试、G-8 门禁、
 * PreDeploy/PostDeploy 检查器、RollbackManager 等 8 大类型族。
 *
 * 设计原则（对齐批次 13 §1.2 P-1~P-11）：
 * - 不可变优先：所有接口字段 readonly，数组 ReadonlyArray<T>，公开常量 Object.freeze
 * - 类型安全：使用 discriminated union 区分不同 IaC 类型与部署策略
 * - 真实法规对齐：所有 IaC 资源类型引用真实云平台 API（aws_eks_cluster / kubernetes_namespace 等）
 * - 零新增依赖：仅复用 node:* 与项目既有依赖
 * - 中文详细注释：所有函数与关键逻辑必须有中文 JSDoc
 *
 * 模块结构说明：
 * - 本文件（devops/types.ts）：纯类型定义（接口/类型别名/常量），不含类实现
 * - devops/rollback-manager.ts：NoOpRollbackManager 类实现（implements RollbackManager 接口）
 * - devops/devops-orchestrator.ts（Phase 6 创建）：DevOpsOrchestrator 类实现
 * - deploy/deploy-stage.ts（Phase 5 创建）：DeployStage 类实现（implements DeployStage 接口）
 * - deploy/pre-deploy-checker.ts（Phase 4 创建）：PreDeployCheckerImpl 类实现
 * - deploy/post-deploy-checker.ts（Phase 4 创建）：PostDeployCheckerImpl 类实现
 *
 * 设计依据：
 * - EAG-P4 批次 13 设计文档 §3.3 D1-4 DevOpsTypes 类型定义
 * - §3.7 RollbackManager 接口与 NoOpRollbackManager 占位实现
 * - §4.2 DeployStage 阶段编排器（接口前置到 types.ts，类实现延后到 Phase 5）
 *
 * @module eag/devops/types
 */

import type { GateContext, GateResult } from "../gate/gate-types";

// ============================================================================
// 1. IaC 模板相关类型
// ============================================================================

/**
 * IaC 模板类型联合
 *
 * 三种 IaC 模板对应三种生成器实现：
 * - terraform：生成 .tf 文件，使用 HCL（HashiCorp Configuration Language）
 * - k8s-manifest：生成 .yaml 文件，使用 Kubernetes API 对象
 * - helm-chart：生成 Chart.yaml + templates/*.yaml，使用 Helm 3 模板语法
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type IaCType = "terraform" | "k8s-manifest" | "helm-chart";

/**
 * IaC 模板接口
 *
 * 描述单个 IaC 模板文件的内容与元数据。一个 IaC 生成器通常产出多个 IaCTemplate
 * （如 TerraformGenerator 产出 main.tf / variables.tf / outputs.tf 三个模板）。
 *
 * 字段说明：
 * - type：IaC 类型（terraform / k8s-manifest / helm-chart）
 * - content：模板内容字符串（HCL / YAML / Helm 模板语法）
 * - filePath：输出文件相对路径（如 "main.tf" / "deployment.yaml" / "Chart.yaml"）
 * - hash：内容 SHA256 哈希（用于变更检测，避免重复生成相同模板）
 * - generatedAt：生成时间戳（ISO 8601 字符串，用于审计与排序）
 */
export interface IaCTemplate {
  /** IaC 类型 */
  readonly type: IaCType;
  /** 模板内容字符串 */
  readonly content: string;
  /** 输出文件相对路径 */
  readonly filePath: string;
  /** 内容 SHA256 哈希 */
  readonly hash: string;
  /** 生成时间戳（ISO 8601） */
  readonly generatedAt: string;
}

/**
 * IaC 生成器接口（策略模式）
 *
 * 所有 IaC 生成器必须实现此接口。三个实现：
 * - TerraformGenerator：生成 Terraform HCL 模板（main.tf / variables.tf / outputs.tf）
 * - K8sManifestGenerator：生成 Kubernetes Manifest YAML（namespace.yaml / deployment.yaml / service.yaml）
 * - HelmChartGenerator：生成 Helm Chart（Chart.yaml / values.yaml / templates/*.yaml）
 *
 * 策略模式优势：DevOpsOrchestrator 持有 ReadonlyArray<IaCGenerator>，
 * 可并行调用多个生成器产出不同类型的 IaC 模板，互不耦合。
 */
export interface IaCGenerator {
  /** IaC 类型标识（用于运行时路由与日志） */
  readonly iacType: IaCType;
  /**
   * 生成 IaC 模板
   * @param context IaC 生成上下文（含项目名 / 环境 / 镜像 / 端口 / 资源配置等）
   * @returns IaC 模板数组（一个生成器可产出多个文件）
   */
  generate(context: IaCGenerationContext): IaCTemplate[];
  /**
   * 校验 IaC 模板（调用真实 CLI 工具）
   * @param template 待校验的 IaC 模板
   * @returns 校验结果（valid / errors / validatedBy）
   */
  validate(template: IaCTemplate): Promise<IaCValidationResult>;
}

/**
 * IaC 生成上下文
 *
 * 字段说明：
 * - projectName：项目名称（用于命名 K8s Namespace / Helm Release / Terraform resource prefix）
 * - environment：部署环境（dev / staging / prod）
 * - replicas：副本数（K8s Deployment.spec.replicas / Helm Values.replicaCount）
 * - image：容器镜像地址（如 "registry.example.com/myapp:v1.0.0"）
 * - port：服务端口（Container port 与 Service port）
 * - resources：资源配置（CPU / Memory limits / requests）
 * - envVars：环境变量列表（支持明文与 Secret 引用两种模式）
 * - ingress：Ingress 配置（可选，未提供时不生成 Ingress 资源）
 */
export interface IaCGenerationContext {
  /** 项目名称（用于资源命名） */
  readonly projectName: string;
  /** 部署环境 */
  readonly environment: "dev" | "staging" | "prod";
  /** 副本数 */
  readonly replicas: number;
  /** 容器镜像地址 */
  readonly image: string;
  /** 服务端口 */
  readonly port: number;
  /** 容器资源配置 */
  readonly resources: Readonly<ContainerResources>;
  /** 环境变量列表 */
  readonly envVars: ReadonlyArray<EnvVar>;
  /** Ingress 配置（可选） */
  readonly ingress?: Readonly<IngressConfig>;
}

/**
 * 容器资源配置（K8s Container.resources / Helm Values.resources）
 */
export interface ContainerResources {
  /** 资源请求（K8s requests） */
  readonly requests: Readonly<ResourceSpec>;
  /** 资源限制（K8s limits） */
  readonly limits: Readonly<ResourceSpec>;
}

/**
 * 资源规格（CPU / Memory）
 *
 * 字段格式对齐 K8s 资源Quantity：
 * - cpu：字符串形式（如 "100m" 表示 0.1 核 / "0.5" 表示 0.5 核 / "1" 表示 1 核）
 * - memory：字符串形式（如 "128Mi" / "256Mi" / "1Gi"）
 */
export interface ResourceSpec {
  /** CPU 资源量（如 "100m" / "0.5" / "1"） */
  readonly cpu: string;
  /** 内存资源量（如 "128Mi" / "256Mi" / "1Gi"） */
  readonly memory: string;
}

/**
 * 环境变量
 *
 * 字段说明：
 * - name：环境变量名（如 "DATABASE_URL"）
 * - value：环境变量值
 * - fromSecret：是否从 Secret 引用（true 时 value 字段是 Secret 的 key 名，而非明文值）
 *
 * 安全建议：敏感信息（密码 / Token / 密钥）必须设置 fromSecret=true，
 * 避免明文写入 deployment.yaml 环境变量段。
 */
export interface EnvVar {
  /** 环境变量名 */
  readonly name: string;
  /** 环境变量值（fromSecret=true 时为 Secret 的 key 名） */
  readonly value: string;
  /** 是否从 Secret 引用（默认 false） */
  readonly fromSecret?: boolean;
}

/**
 * Ingress 配置（K8s Ingress / Helm Values.ingress）
 *
 * 字段说明：
 * - host：域名（如 "myapp.example.com"）
 * - path：URL 路径（如 "/" 或 "/api"）
 * - port：Service 端口号（Ingress 后端转发目标端口）
 * - tlsSecret：TLS 证书 Secret 名称（可选，未提供时不启用 HTTPS）
 */
export interface IngressConfig {
  /** 域名 */
  readonly host: string;
  /** URL 路径 */
  readonly path: string;
  /** Service 端口号（Ingress 后端转发目标端口） */
  readonly port: number;
  /** TLS 证书 Secret 名称（可选） */
  readonly tlsSecret?: string;
}

/**
 * IaC 校验结果
 *
 * 字段说明：
 * - valid：校验是否通过
 * - errors：校验失败时的错误信息列表（valid=true 时为空数组）
 * - validatedBy：校验工具标识（terraform-validate / kubectl-dry-run / helm-lint）
 *
 * 真实 CLI 工具调用（对齐 P-5 测试不使用 mock）：
 * - terraform-validate：调用 `terraform validate` 命令
 * - kubectl-dry-run：调用 `kubectl apply --dry-run=client -f` 命令
 * - helm-lint：调用 `helm lint` 命令
 */
export interface IaCValidationResult {
  /** 校验是否通过 */
  readonly valid: boolean;
  /** 错误信息列表 */
  readonly errors: ReadonlyArray<string>;
  /** 校验工具标识 */
  readonly validatedBy: "terraform-validate" | "kubectl-dry-run" | "helm-lint";
}

// ============================================================================
// 2. 部署相关类型
// ============================================================================

/**
 * 部署策略联合类型
 *
 * 批次 13 仅支持 "rolling"（默认），批次 14 将扩展 "blue-green" / "canary"
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type DeployStrategyType = "rolling" | "blue-green" | "canary";

/**
 * 部署策略接口（策略模式）
 *
 * 批次 13 仅实现 RollingStrategy（kubectl rollout / helm upgrade），
 * 批次 14 扩展 BlueGreenStrategy / CanaryStrategy
 */
export interface DeployStrategy {
  /** 策略类型标识 */
  readonly strategyType: DeployStrategyType;
  /**
   * 执行部署
   * @param context 部署上下文（含 runId / 项目名 / IaC 模板 / 超时配置等）
   * @returns 部署结果（含部署状态 / 资源清单 / 错误信息）
   */
  execute(context: DeployContext): Promise<DeployResult>;
}

/**
 * 部署上下文
 *
 * 字段说明：
 * - runId：本次 DevOps 编排运行的唯一 ID（用于日志关联与审计）
 * - projectName：项目名称（用于 K8s Namespace / Helm Release 命名）
 * - environment：部署环境
 * - iacTemplates：本次部署使用的 IaC 模板列表
 * - strategyType：部署策略类型（rolling / blue-green / canary）
 * - timeoutMs：部署超时（毫秒），默认 300000（5 分钟）
 */
export interface DeployContext {
  /** 运行 ID */
  readonly runId: string;
  /** 项目名称 */
  readonly projectName: string;
  /** 部署环境 */
  readonly environment: "dev" | "staging" | "prod";
  /** IaC 模板列表 */
  readonly iacTemplates: ReadonlyArray<IaCTemplate>;
  /** 部署策略类型 */
  readonly strategyType: DeployStrategyType;
  /** 部署超时（毫秒） */
  readonly timeoutMs: number;
}

/**
 * 部署结果
 *
 * 字段说明：
 * - success：部署是否成功
 * - deployedAt：部署完成时间戳（ISO 8601）
 * - duration：部署耗时（毫秒）
 * - resources：已部署资源列表（Pod / Service / Deployment 等）
 * - errors：部署失败时的错误信息列表（success=true 时为空数组）
 */
export interface DeployResult {
  /** 部署是否成功 */
  readonly success: boolean;
  /** 部署完成时间戳（ISO 8601） */
  readonly deployedAt: string;
  /** 部署耗时（毫秒） */
  readonly duration: number;
  /** 已部署资源列表 */
  readonly resources: ReadonlyArray<DeployedResource>;
  /** 错误信息列表 */
  readonly errors: ReadonlyArray<string>;
}

/**
 * 已部署资源（单条资源信息）
 *
 * 字段说明：
 * - kind：资源类型（如 "Pod" / "Service" / "Deployment" / "Ingress"）
 * - name：资源名称
 * - namespace：K8s 命名空间
 * - status：资源状态（Running / Pending / Failed / Unknown）
 */
export interface DeployedResource {
  /** 资源类型（Pod / Service / Deployment 等） */
  readonly kind: string;
  /** 资源名称 */
  readonly name: string;
  /** K8s 命名空间 */
  readonly namespace: string;
  /** 资源状态 */
  readonly status: "Running" | "Pending" | "Failed" | "Unknown";
}

// ============================================================================
// 3. 健康检查与烟雾测试
// ============================================================================

/**
 * 健康检查结果
 *
 * 字段说明：
 * - healthy：整体是否健康（所有端点都健康才为 true）
 * - checkedAt：检查时间戳（ISO 8601）
 * - endpoints：各健康端点的检查结果列表
 * - failures：检查失败时的错误信息列表（healthy=true 时为空数组）
 */
export interface HealthCheckResult {
  /** 整体是否健康 */
  readonly healthy: boolean;
  /** 检查时间戳（ISO 8601） */
  readonly checkedAt: string;
  /** 各健康端点的检查结果列表 */
  readonly endpoints: ReadonlyArray<HealthEndpoint>;
  /** 错误信息列表 */
  readonly failures: ReadonlyArray<string>;
}

/**
 * 健康端点检查结果（单条端点）
 *
 * 字段说明：
 * - url：健康检查 URL（如 "http://myapp.example.com/healthz"）
 * - statusCode：HTTP 响应状态码（200 表示健康）
 * - responseTimeMs：响应时间（毫秒，用于性能监控）
 * - healthy：该端点是否健康
 */
export interface HealthEndpoint {
  /** 健康检查 URL */
  readonly url: string;
  /** HTTP 响应状态码 */
  readonly statusCode: number;
  /** 响应时间（毫秒） */
  readonly responseTimeMs: number;
  /** 该端点是否健康 */
  readonly healthy: boolean;
}

/**
 * 烟雾测试结果
 *
 * 字段说明：
 * - passed：烟雾测试是否全部通过
 * - totalTests：测试用例总数
 * - passedTests：通过用例数
 * - failedTests：失败用例数
 * - duration：测试耗时（毫秒）
 * - failures：失败用例详情列表（passed=true 时为空数组）
 */
export interface SmokeTestResult {
  /** 烟雾测试是否全部通过 */
  readonly passed: boolean;
  /** 测试用例总数 */
  readonly totalTests: number;
  /** 通过用例数 */
  readonly passedTests: number;
  /** 失败用例数 */
  readonly failedTests: number;
  /** 测试耗时（毫秒） */
  readonly duration: number;
  /** 失败用例详情列表 */
  readonly failures: ReadonlyArray<SmokeTestFailure>;
}

/**
 * 烟雾测试失败用例详情（单条失败）
 *
 * 字段说明：
 * - testName：测试用例名称
 * - expected：期望结果（如 "HTTP 200" / "response body contains 'OK'"）
 * - actual：实际结果
 * - errorMessage：错误信息（如 "Connection refused" / "timeout"）
 */
export interface SmokeTestFailure {
  /** 测试用例名称 */
  readonly testName: string;
  /** 期望结果 */
  readonly expected: string;
  /** 实际结果 */
  readonly actual: string;
  /** 错误信息 */
  readonly errorMessage: string;
}

/**
 * 烟雾测试用例（单条用例定义）
 *
 * 字段说明：
 * - name：用例名称（如 "GET /healthz returns 200"）
 * - method：HTTP 方法（GET / POST / PUT / DELETE）
 * - path：URL 路径（如 "/healthz" / "/api/users"）
 * - expectedStatusCode：期望 HTTP 状态码（如 200 / 201 / 204）
 * - expectedBodyContains：期望响应体包含的字符串（可选）
 */
export interface SmokeTestCase {
  /** 用例名称 */
  readonly name: string;
  /** HTTP 方法 */
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  /** URL 路径 */
  readonly path: string;
  /** 期望 HTTP 状态码 */
  readonly expectedStatusCode: number;
  /** 期望响应体包含的字符串（可选） */
  readonly expectedBodyContains?: string;
}

/**
 * 烟雾测试执行器接口
 *
 * Phase 4 在 deploy/smoke-test-runner.ts 中实现 SmokeTestRunnerImpl 类
 * （通过 node:http / node:https 发起 HTTP 请求，不使用 mock）
 */
export interface SmokeTestRunner {
  /**
   * 执行烟雾测试
   * @param endpoints 健康端点 URL 列表（如 ["http://myapp.example.com"]）
   * @param testCases 测试用例列表
   * @returns 烟雾测试结果
   */
  run(endpoints: ReadonlyArray<string>, testCases: ReadonlyArray<SmokeTestCase>): Promise<SmokeTestResult>;
}

// ============================================================================
// 4. DevOps 编排器类型
// ============================================================================

/**
 * DevOps 事件类型（discriminated union）
 *
 * 9 种事件覆盖 DevOps 编排全生命周期：
 * - devops-started：编排开始
 * - iac-generated：IaC 模板生成完成
 * - pre-deploy-check-passed：部署前检查通过
 * - deploy-started：部署开始
 * - deploy-completed：部署完成
 * - post-deploy-check-passed：部署后检查通过
 * - smoke-test-passed：烟雾测试通过
 * - devops-completed：编排完成
 * - devops-failed：编排失败
 *
 * 设计原则：
 * - 每个事件都包含 runId 与 timestamp 字段，便于审计与排序
 * - 关键事件（iac-generated / deploy-completed / smoke-test-passed / devops-completed）携带详细数据
 * - discriminated union 保证类型安全，switch 处理时编译器强制 exhaustive check
 */
export type DevOpsEvent =
  | { readonly type: "devops-started"; readonly runId: string; readonly timestamp: string }
  | {
      readonly type: "iac-generated";
      readonly runId: string;
      readonly templates: ReadonlyArray<IaCTemplate>;
      readonly timestamp: string;
    }
  | { readonly type: "pre-deploy-check-passed"; readonly runId: string; readonly timestamp: string }
  | { readonly type: "deploy-started"; readonly runId: string; readonly timestamp: string }
  | {
      readonly type: "deploy-completed";
      readonly runId: string;
      readonly result: DeployResult;
      readonly timestamp: string;
    }
  | { readonly type: "post-deploy-check-passed"; readonly runId: string; readonly timestamp: string }
  | {
      readonly type: "smoke-test-passed";
      readonly runId: string;
      readonly result: SmokeTestResult;
      readonly timestamp: string;
    }
  | {
      readonly type: "devops-completed";
      readonly runId: string;
      readonly result: DevOpsResult;
      readonly timestamp: string;
    }
  | { readonly type: "devops-failed"; readonly runId: string; readonly error: string; readonly timestamp: string };

/**
 * DevOps 事件发射器接口
 *
 * Phase 6 在 devops/devops-orchestrator.ts 中由 DevOpsOrchestrator 持有可选实例
 */
export interface DevOpsEventEmitter {
  /**
   * 发射 DevOps 事件
   * @param event DevOps 事件
   */
  emit(event: DevOpsEvent): void;
}

/**
 * DevOps 编排上下文
 *
 * 继承 GateContext（提供 projectId / specStatus / planStatus 等门禁字段），
 * 扩展 DevOps 编排所需的 IaC 生成上下文 + 部署上下文 + 烟雾测试用例 + 监控/回滚标记。
 *
 * 字段说明：
 * - loopType：固定为 "deploy"（DevOps 编排器仅在 DEPLOY Loop 中调用）
 * - iacGenerationContext：IaC 生成上下文（含项目名 / 环境 / 镜像 / 端口 / 资源配置等）
 * - deployContext：部署上下文（含 runId / 项目名 / IaC 模板 / 策略类型 / 超时）
 * - smokeTestCases：烟雾测试用例列表
 * - monitoringReady：监控告警就位标记（可选，默认 true；批次 14 实现完整监控就绪检查）
 * - rollbackPlanExists：回滚预案存在标记（可选，默认 true；批次 14 实现完整回滚预案检查）
 */
export interface DevOpsContext extends GateContext {
  /** Loop 类型（固定为 "deploy"） */
  readonly loopType: "deploy";
  /** IaC 生成上下文 */
  readonly iacGenerationContext: IaCGenerationContext;
  /** 部署上下文 */
  readonly deployContext: DeployContext;
  /** 烟雾测试用例列表 */
  readonly smokeTestCases: ReadonlyArray<SmokeTestCase>;
  /** 监控告警就位标记（可选，默认 true） */
  readonly monitoringReady?: boolean;
  /** 回滚预案存在标记（可选，默认 true） */
  readonly rollbackPlanExists?: boolean;
}

/**
 * DevOps 编排结果
 *
 * 描述 DevOps 编排器一次运行的完整结果，包含 IaC 模板 + 部署结果 + 健康检查 + 烟雾测试 + 门禁结果。
 *
 * 字段说明：
 * - success：编排是否成功（所有阶段通过 + G-8 门禁通过）
 * - runId：运行 ID（与 DevOpsContext.deployContext.runId 对齐）
 * - startedAt：开始时间戳（ISO 8601）
 * - finishedAt：结束时间戳（ISO 8601）
 * - duration：总耗时（毫秒）
 * - iacTemplates：生成的 IaC 模板列表
 * - deployResult：部署结果（部署成功后才有值）
 * - healthCheckResult：健康检查结果（部署成功后才有值）
 * - smokeTestResult：烟雾测试结果（健康检查通过后才有值）
 * - gateResult：G-8 门禁结果
 * - errors：累积错误信息列表（success=true 时为空数组）
 */
export interface DevOpsResult {
  /** 编排是否成功 */
  readonly success: boolean;
  /** 运行 ID */
  readonly runId: string;
  /** 开始时间戳（ISO 8601） */
  readonly startedAt: string;
  /** 结束时间戳（ISO 8601） */
  readonly finishedAt: string;
  /** 总耗时（毫秒） */
  readonly duration: number;
  /** 生成的 IaC 模板列表 */
  readonly iacTemplates: ReadonlyArray<IaCTemplate>;
  /** 部署结果（可选） */
  readonly deployResult?: DeployResult;
  /** 健康检查结果（可选） */
  readonly healthCheckResult?: HealthCheckResult;
  /** 烟雾测试结果（可选） */
  readonly smokeTestResult?: SmokeTestResult;
  /** G-8 门禁结果 */
  readonly gateResult: GateResult;
  /** 累积错误信息列表 */
  readonly errors: ReadonlyArray<string>;
}

// ============================================================================
// 5. G-8 门禁相关类型
// ============================================================================

/**
 * G-8 门禁上下文
 *
 * 继承 GateContext，扩展 DEPLOY Loop 退出门禁所需的字段。
 *
 * G-8 门禁校验 6 项部署就绪条件（对齐设计文档 §3.6）：
 * 1. IaC 模板校验通过（terraform validate / kubectl dry-run / helm lint）
 * 2. 部署成功（DeployResult.success=true）
 * 3. 健康检查通过（HealthCheckResult.healthy=true）
 * 4. 烟雾测试通过（SmokeTestResult.passed=true）
 * 5. 监控就绪（monitoringReady=true）
 * 6. 回滚预案存在（rollbackPlanExists=true）
 *
 * 字段说明：
 * - loopType：固定为 "deploy"
 * - iacTemplates：本次部署使用的 IaC 模板列表
 * - deployResult：部署结果
 * - healthCheckResult：健康检查结果
 * - smokeTestResult：烟雾测试结果
 * - monitoringReady：监控就绪标记
 * - rollbackPlanExists：回滚预案存在标记
 */
export interface GateG8Context extends GateContext {
  /** Loop 类型（固定为 "deploy"） */
  readonly loopType: "deploy";
  /** IaC 模板列表 */
  readonly iacTemplates: ReadonlyArray<IaCTemplate>;
  /** 部署结果 */
  readonly deployResult: DeployResult;
  /** 健康检查结果 */
  readonly healthCheckResult: HealthCheckResult;
  /** 烟雾测试结果 */
  readonly smokeTestResult: SmokeTestResult;
  /** 监控就绪标记 */
  readonly monitoringReady: boolean;
  /** 回滚预案存在标记 */
  readonly rollbackPlanExists: boolean;
}

/**
 * G-8 门禁检查器接口
 *
 * 遵循 GateChecker 协议（gateId + check() 方法），但 gateId 固定为 "G-8"。
 *
 * Phase 2 在 devops/gate-g8-checker.ts 中实现 GateG8CheckerImpl 类
 * （或直接命名 GateG8Checker 类，与本接口同名但不冲突——TypeScript 允许类与接口同名）
 */
export interface GateG8Checker {
  /** 门禁 ID（固定为 "G-8"） */
  readonly gateId: "G-8";
  /**
   * 执行 G-8 门禁检查
   * @param context G-8 门禁上下文
   * @returns 门禁判定结果（passed=true 表示通过，false 表示未通过）
   */
  check(context: GateG8Context): GateResult;
}

// ============================================================================
// 6. PreDeploy / PostDeploy 检查器接口
// ============================================================================

/**
 * PreDeploy 检查器接口（部署前检查）
 *
 * Phase 4 在 deploy/pre-deploy-checker.ts 中实现 PreDeployCheckerImpl 类
 *
 * 检查 4 项：
 * 1. 镜像已构建（imageBuilt）
 * 2. 配置有效（configValid）
 * 3. 依赖可用（dependenciesAvailable）
 * 4. 资源配额充足（resourceQuotaSufficient）
 */
export interface PreDeployChecker {
  /**
   * 执行部署前检查
   * @param context 检查上下文
   * @returns 检查结果
   */
  check(context: PreDeployCheckContext): Promise<PreDeployCheckResult>;
}

/**
 * PreDeploy 检查上下文
 *
 * 字段说明：
 * - projectName：项目名称
 * - environment：部署环境
 * - image：容器镜像地址
 * - iacTemplates：IaC 模板列表（用于配置校验）
 */
export interface PreDeployCheckContext {
  /** 项目名称 */
  readonly projectName: string;
  /** 部署环境 */
  readonly environment: "dev" | "staging" | "prod";
  /** 容器镜像地址 */
  readonly image: string;
  /** IaC 模板列表 */
  readonly iacTemplates: ReadonlyArray<IaCTemplate>;
}

/**
 * PreDeploy 检查结果
 *
 * 字段说明：
 * - passed：整体是否通过（4 项全过才为 true）
 * - imageBuilt：镜像是否已构建
 * - configValid：配置是否有效
 * - dependenciesAvailable：依赖是否可用
 * - resourceQuotaSufficient：资源配额是否充足
 * - failures：失败项详情列表（passed=true 时为空数组）
 */
export interface PreDeployCheckResult {
  /** 整体是否通过 */
  readonly passed: boolean;
  /** 镜像是否已构建 */
  readonly imageBuilt: boolean;
  /** 配置是否有效 */
  readonly configValid: boolean;
  /** 依赖是否可用 */
  readonly dependenciesAvailable: boolean;
  /** 资源配额是否充足 */
  readonly resourceQuotaSufficient: boolean;
  /** 失败项详情列表 */
  readonly failures: ReadonlyArray<string>;
}

/**
 * PostDeploy 检查器接口（部署后检查）
 *
 * Phase 4 在 deploy/post-deploy-checker.ts 中实现 PostDeployCheckerImpl 类
 *
 * 检查 4 项：
 * 1. Pod 就绪（podsReady）
 * 2. Service 端点可达（serviceEndpointReachable）
 * 3. 日志干净（logsClean）
 * 4. 指标上报（metricsReporting）
 */
export interface PostDeployChecker {
  /**
   * 执行部署后检查
   * @param context 检查上下文
   * @returns 检查结果（含健康端点列表）
   */
  check(context: PostDeployCheckContext): Promise<PostDeployCheckResult>;
}

/**
 * PostDeploy 检查上下文
 *
 * 字段说明：
 * - namespace：K8s 命名空间
 * - serviceName：Service 名称
 * - deployedResources：已部署资源列表（来自 DeployResult.resources）
 */
export interface PostDeployCheckContext {
  /** K8s 命名空间 */
  readonly namespace: string;
  /** Service 名称 */
  readonly serviceName: string;
  /** 已部署资源列表 */
  readonly deployedResources: ReadonlyArray<DeployedResource>;
}

/**
 * PostDeploy 检查结果
 *
 * 字段说明：
 * - passed：整体是否通过（4 项全过才为 true）
 * - podsReady：Pod 是否就绪
 * - serviceEndpointReachable：Service 端点是否可达
 * - logsClean：日志是否干净（无 ERROR / Exception）
 * - metricsReporting：指标是否上报
 * - endpoints：部署后健康端点列表（供 DevOpsOrchestrator 填充 HealthCheckResult.endpoints）
 * - failures：失败项详情列表（passed=true 时为空数组）
 */
export interface PostDeployCheckResult {
  /** 整体是否通过 */
  readonly passed: boolean;
  /** Pod 是否就绪 */
  readonly podsReady: boolean;
  /** Service 端点是否可达 */
  readonly serviceEndpointReachable: boolean;
  /** 日志是否干净 */
  readonly logsClean: boolean;
  /** 指标是否上报 */
  readonly metricsReporting: boolean;
  /** 部署后健康端点列表（B-2 修复：供 DevOpsOrchestrator 填充 HealthCheckResult.endpoints） */
  readonly endpoints: ReadonlyArray<HealthEndpoint>;
  /** 失败项详情列表 */
  readonly failures: ReadonlyArray<string>;
}

// ============================================================================
// 7. RollbackManager 相关类型（§3.7 接口前置到 types.ts，NoOpRollbackManager 类在 rollback-manager.ts）
// ============================================================================

/**
 * 回滚管理器接口
 *
 * 批次 13：仅接口定义 + NoOpRollbackManager 占位实现（在 rollback-manager.ts 中）
 * 批次 14：K8sRollbackManager / HelmRollbackManager 完整实现（调用 kubectl rollout undo / helm rollback）
 */
export interface RollbackManager {
  /**
   * 创建版本快照（部署前调用）
   *
   * @param context 快照上下文（含 projectName / namespace / previousVersion）
   * @returns RollbackSnapshot 含 snapshotId / version / resources
   */
  createSnapshot(context: RollbackSnapshotContext): Promise<RollbackSnapshot>;

  /**
   * 执行回滚（部署失败时调用）
   *
   * @param snapshot 部署前创建的版本快照
   * @returns RollbackResult 含 success / rolledBackTo / duration / errors
   */
  rollback(snapshot: RollbackSnapshot): Promise<RollbackResult>;
}

/**
 * 快照上下文
 *
 * 字段说明：
 * - projectName：项目名称
 * - namespace：K8s 命名空间
 * - previousVersion：上一个稳定版本号（可选，首次部署时无）
 */
export interface RollbackSnapshotContext {
  /** 项目名称 */
  readonly projectName: string;
  /** K8s 命名空间 */
  readonly namespace: string;
  /** 上一个稳定版本号（可选） */
  readonly previousVersion?: string;
}

/**
 * 版本快照
 *
 * 字段说明：
 * - snapshotId：快照唯一 ID（用于回滚时引用）
 * - createdAt：创建时间戳（ISO 8601）
 * - version：版本号
 * - resources：快照包含的资源列表（如 ["deployment/myapp", "service/myapp"]）
 */
export interface RollbackSnapshot {
  /** 快照唯一 ID */
  readonly snapshotId: string;
  /** 创建时间戳（ISO 8601） */
  readonly createdAt: string;
  /** 版本号 */
  readonly version: string;
  /** 快照包含的资源列表 */
  readonly resources: ReadonlyArray<string>;
}

/**
 * 回滚结果
 *
 * 字段说明：
 * - success：回滚是否成功
 * - rolledBackTo：回滚到的版本号
 * - duration：回滚耗时（毫秒）
 * - errors：回滚失败时的错误信息列表（success=true 时为空数组）
 */
export interface RollbackResult {
  /** 回滚是否成功 */
  readonly success: boolean;
  /** 回滚到的版本号 */
  readonly rolledBackTo: string;
  /** 回滚耗时（毫秒） */
  readonly duration: number;
  /** 错误信息列表 */
  readonly errors: ReadonlyArray<string>;
}

// ============================================================================
// 8. DeployStage 相关类型（§4.2 接口前置到 types.ts，类实现延后到 Phase 5）
// ============================================================================

/**
 * DeployStage 选项
 *
 * 字段说明：
 * - preDeployChecker：部署前检查器（必填，校验镜像/配置/依赖/配额 4 项）
 * - postDeployChecker：部署后检查器（必填，校验 Pod/Service/日志/指标 4 项）
 * - smokeTestRunner：烟雾测试执行器（必填，按用例发起 HTTP 请求验证端点）
 * - rollbackManager：回滚管理器（可选，批次 14 注入；批次 13 预留接口，失败时如果存在则调用 rollback()）
 *
 * 设计说明：
 * - 这 4 个字段由 DeployStageOptions 独占（N-M-1 修复后 DevOpsOrchestratorOptions 不再重复持有）
 * - session.ts 装配时分别构造 DeployStageOptions 与 DevOpsOrchestratorOptions 注入
 */
export interface DeployStageOptions {
  /** 部署前检查器（必填） */
  readonly preDeployChecker: PreDeployChecker;
  /** 部署后检查器（必填） */
  readonly postDeployChecker: PostDeployChecker;
  /** 烟雾测试执行器（必填） */
  readonly smokeTestRunner: SmokeTestRunner;
  /** 回滚管理器（可选，批次 14 注入） */
  readonly rollbackManager?: RollbackManager;
}

/**
 * DeployStage 执行结果
 *
 * 字段说明：
 * - success：4 步阶段是否全部成功（pre-deploy + deploy + post-deploy + smoke-test）
 * - preDeployPassed：pre-deploy 检查是否通过
 * - deployResult：部署执行结果（pre-deploy 通过后才会有值）
 * - postDeployPassed：post-deploy 检查是否通过（deploy 成功后才会有值）
 * - smokeTestResult：烟雾测试结果（post-deploy 通过后才会有值）
 * - healthEndpoints：部署后健康端点列表（从 PostDeployCheckResult.endpoints 填充，供 DevOpsOrchestrator 构造 HealthCheckResult.endpoints）
 * - rollbackExecuted：是否触发了回滚（仅在 deploy/post-deploy/smoke-test 失败且 rollbackManager 存在时为 true）
 * - rollbackResult：回滚执行结果（rollbackExecuted=true 时有值）
 * - errors：各阶段累积的错误信息
 *
 * B-2 修复：新增 healthEndpoints 字段，供 DevOpsOrchestrator 失败时构造 HealthCheckResult.endpoints
 */
export interface DeployStageResult {
  /** 4 步阶段是否全部成功 */
  readonly success: boolean;
  /** pre-deploy 检查是否通过 */
  readonly preDeployPassed: boolean;
  /** 部署执行结果（可选） */
  readonly deployResult?: DeployResult;
  /** post-deploy 检查是否通过 */
  readonly postDeployPassed: boolean;
  /** 烟雾测试结果（可选） */
  readonly smokeTestResult?: SmokeTestResult;
  /** 部署后健康端点列表（B-2 修复：供 DevOpsOrchestrator 填充 HealthCheckResult.endpoints） */
  readonly healthEndpoints: ReadonlyArray<HealthEndpoint>;
  /** 是否触发了回滚 */
  readonly rollbackExecuted: boolean;
  /** 回滚执行结果（可选） */
  readonly rollbackResult?: RollbackResult;
  /** 各阶段累积的错误信息 */
  readonly errors: ReadonlyArray<string>;
}

/**
 * DeployStage 阶段编排器接口
 *
 * 职责：
 * - 编排 pre-deploy → deploy → post-deploy → smoke-test 四步阶段
 * - 失败时触发 RollbackManager（批次 14 实现）
 * - 与 DesignLoop / CodingLoop / TestingLoop 同构的阶段编排器
 *
 * 与 DevOpsOrchestrator 的关系：
 * - DevOpsOrchestrator 是角色编排器（DevOps 第 6 角色）
 * - DeployStage 是阶段编排器（DEPLOY 子阶段）
 * - DevOpsOrchestrator.run() 内部调用 DeployStage.execute()
 *
 * 实现位置：Phase 5 在 deploy/deploy-stage.ts 中创建 DeployStage 类（implements 本接口）
 */
export interface DeployStage {
  /**
   * 执行 DEPLOY 阶段
   *
   * 4 步阶段编排：
   * 1. pre-deploy 检查：调用 PreDeployChecker.check()，校验镜像/配置/依赖/配额 4 项
   *    - 失败时直接返回（不进入 deploy，不触发回滚，因为尚未部署任何资源）
   * 2. deploy 部署：调用 DeployStrategy.execute() 执行实际部署
   *    - 失败时如果 rollbackManager 存在，创建快照并调用 rollback()
   * 3. post-deploy 检查：调用 PostDeployChecker.check()，校验 Pod/Service/日志/指标 4 项
   *    - 失败时如果 rollbackManager 存在，调用 rollback()
   *    - 填充 healthEndpoints（从 PostDeployCheckResult.endpoints）
   * 4. smoke-test 烟雾测试：调用 SmokeTestRunner.run()，按用例发起 HTTP 请求验证端点
   *    - 失败时如果 rollbackManager 存在，调用 rollback()
   *
   * @param context DevOps 编排上下文（提供 projectName / environment / smokeTestCases 等）
   * @param iacTemplates IaC 模板列表（来自 DevOpsOrchestrator 生成的模板）
   * @param deployStrategy 部署策略（来自 DevOpsOrchestratorOptions）
   * @returns DeployStageResult，被 Object.freeze 冻结
   */
  execute(
    context: DevOpsContext,
    iacTemplates: ReadonlyArray<IaCTemplate>,
    deployStrategy: DeployStrategy
  ): Promise<DeployStageResult>;
}

// ============================================================================
// 9. DevOpsOrchestrator 相关类型（§3.3 + N-M-1 修复后）
// ============================================================================

/**
 * DevOps 编排器选项（N-M-1 修复：删除与 DeployStageOptions 重复的 4 个字段）
 *
 * 修复原因：
 * - 原设计在 DevOpsOrchestratorOptions 与 DeployStageOptions 中重复注入 preDeployChecker /
 *   postDeployChecker / smokeTestRunner / rollbackManager 4 个字段
 * - DevOpsOrchestrator.run() 仅通过 this.options.deployStage.execute() 委托 4 步阶段，
 *   不直接使用这 4 个字段，违反 Simplicity First 与 DRY 原则
 * - 修复后：DevOpsOrchestratorOptions 仅保留 DevOpsOrchestrator 自身使用的字段
 *          （iacGenerators / gateG8Checker / deployStrategy / deployStage / eventEmitter）
 *          这 4 个字段由 DeployStageOptions 独占，session.ts 装配时分别注入两个 options
 *
 * 字段说明：
 * - iacGenerators：IaC 生成器列表（至少 1 个，并行调用产出不同类型的 IaC 模板）
 * - gateG8Checker：G-8 部署门禁检查器
 * - deployStrategy：部署策略（批次 13 仅 RollingStrategy；DevOpsOrchestrator 用于注入 DeployContext.strategyType）
 * - deployStage：DEPLOY 子阶段编排器（DevOpsOrchestrator 委托 pre-deploy→deploy→post-deploy→smoke-test 四步给 DeployStage；
 *   PreDeployChecker / PostDeployChecker / SmokeTestRunner / RollbackManager 由 DeployStage 自身的 options 持有）
 * - eventEmitter：事件发射器（可选，与既有 orchestrator 一致）
 *
 * 构造函数注入，必填字段无默认值（与 TestingOrchestratorOptions 同构，批次 11 S1 改进）
 */
export interface DevOpsOrchestratorOptions {
  /** IaC 生成器列表（至少 1 个） */
  readonly iacGenerators: ReadonlyArray<IaCGenerator>;
  /** G-8 部署门禁检查器 */
  readonly gateG8Checker: GateG8Checker;
  /** 部署策略（批次 13 仅 RollingStrategy；DevOpsOrchestrator 用于注入 DeployContext.strategyType） */
  readonly deployStrategy: DeployStrategy;
  /** DEPLOY 子阶段编排器（DevOpsOrchestrator 委托 pre-deploy→deploy→post-deploy→smoke-test 四步给 DeployStage） */
  readonly deployStage: DeployStage;
  /** 事件发射器（可选） */
  readonly eventEmitter?: DevOpsEventEmitter;
}
