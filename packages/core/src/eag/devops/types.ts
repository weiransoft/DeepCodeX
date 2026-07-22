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
 * - value：环境变量值（语义因生成器而异，详见下方"value 字段语义差异说明"）
 * - fromSecret：是否从 Secret 引用（true 时该环境变量不写入 ConfigMap，而是从 Secret 引用）
 *
 * value 字段语义差异说明（P1-2 修复，架构师审查发现）：
 * 不同 IaC 生成器对 fromSecret=true 时 value 字段的语义处理不同，调用方需根据目标生成器
 * 填写正确的 value 值：
 * - TerraformGenerator：value 是**既有 Secret 的名称**（用于 kubernetes_secret_v1 data source
 *   引用集群中已存在的 Secret，secret_key_ref.name = env.value，secret_key_ref.key = env.name）
 * - K8sManifestGenerator：value 是**真实敏感值**（生成器通过 Buffer.from(value).toString("base64")
 *   编码后写入新建 Secret 的 data[env.name] 字段）
 * - HelmChartGenerator：value 是**真实敏感值**（生成器在 secret.yaml 模板中通过 b64enc 编码后
 *   写入新建 Secret 的 data[env.name] 字段）
 *
 * 设计差异原因：
 * - Terraform 通常用于声明式管理长期资源，引用既有 Secret 符合 GitOps 模式
 * - K8s Manifest / Helm Chart 通常用于应用部署包，需要自包含 Secret 定义
 *
 * 安全建议：敏感信息（密码 / Token / 密钥）必须设置 fromSecret=true，
 * 避免明文写入 deployment.yaml 环境变量段。
 */
export interface EnvVar {
  /** 环境变量名 */
  readonly name: string;
  /**
   * 环境变量值（语义因生成器而异，详见接口注释中的"value 字段语义差异说明"）
   * - TerraformGenerator：既有 Secret 的名称
   * - K8sManifestGenerator / HelmChartGenerator：真实敏感值（会被 base64 编码后写入新建 Secret）
   */
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
 * DevOps 编排上下文（批次 14 扩展，向后兼容）
 *
 * 继承 GateContext（提供 projectId / specStatus / planStatus 等门禁字段），
 * 扩展 DevOps 编排所需的 IaC 生成上下文 + 部署上下文 + 烟雾测试用例 + 监控/回滚标记。
 *
 * 字段说明（批次 13 既有字段）：
 * - loopType：固定为 "deploy"（DevOps 编排器仅在 DEPLOY Loop 中调用）
 * - iacGenerationContext：IaC 生成上下文（含项目名 / 环境 / 镜像 / 端口 / 资源配置等）
 * - deployContext：部署上下文（含 runId / 项目名 / IaC 模板 / 策略类型 / 超时）
 * - smokeTestCases：烟雾测试用例列表
 * - monitoringReady：监控告警就位标记（可选，默认 true；批次 14 实现完整监控就绪检查）
 * - rollbackPlanExists：回滚预案存在标记（可选，默认 true；批次 14 实现完整回滚预案检查）
 *
 * 字段说明（批次 14 新增可选字段，向后兼容）：
 * - monitoringCheckContext：监控检查上下文（注入时 DevOpsOrchestrator 调用真实检查器）
 * - rollbackPlanCheckContext：回滚预案检查上下文（注入时 DevOpsOrchestrator 调用真实检查器）
 * - projectRoot：项目根目录（供 RollbackPlanChecker 拼接文件路径）
 * - runId：运行 ID（供 RollbackPlanChecker 拼接文件名）
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
  /** 监控检查上下文（可选，批次 14 新增，注入时 DevOpsOrchestrator 调用真实检查器） */
  readonly monitoringCheckContext?: MonitoringCheckContext;
  /** 回滚预案检查上下文（可选，批次 14 新增，注入时 DevOpsOrchestrator 调用真实检查器） */
  readonly rollbackPlanCheckContext?: RollbackPlanCheckContext;
  /** 项目根目录（可选，批次 14 新增，供 RollbackPlanChecker 拼接文件路径） */
  readonly projectRoot?: string;
  /** 运行 ID（可选，批次 14 新增，供 RollbackPlanChecker 拼接文件名） */
  readonly runId?: string;
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
 * G-8 门禁上下文（批次 14 扩展，向后兼容）
 *
 * 继承 GateContext，扩展 DEPLOY Loop 退出门禁所需的字段。
 *
 * G-8 门禁校验 5 项部署就绪条件（对齐设计文档 §3.6 L2590）：
 * 1. IaC 模板完整性（iacTemplates 数组非空，length > 0）
 * 2. 健康检查就绪（HealthCheckResult.healthy=true）
 * 3. 烟雾测试通过（SmokeTestResult.passed=true）
 * 4. 监控就绪（monitoringReady=true，批次 13 暂固定为 true，批次 14 实现）
 * 5. 回滚预案存在（rollbackPlanExists=true，批次 13 暂固定为 true，批次 14 实现）
 *
 * 说明：
 * - IaC 模板的 CLI 校验（terraform validate / kubectl dry-run / helm lint）由
 *   DevOpsOrchestrator 在 G-8 之前独立执行（设计文档 §3.5），G-8 仅校验模板完整性
 * - DeployResult.success 不在 G-8 检查项中：部署失败会直接触发回滚（由 DeployStage 处理），
 *   不会进入 G-8 门禁（G-8 是部署成功后的运行期数据门禁）
 *
 * 字段说明（批次 13 既有字段）：
 * - loopType：固定为 "deploy"
 * - iacTemplates：本次部署使用的 IaC 模板列表
 * - deployResult：部署结果
 * - healthCheckResult：健康检查结果
 * - smokeTestResult：烟雾测试结果
 * - monitoringReady：监控就绪标记
 * - rollbackPlanExists：回滚预案存在标记
 *
 * 字段说明（批次 14 新增可选字段，向后兼容）：
 * - monitoringCheckContext：监控检查上下文（注入时 GateG8CheckerImpl 调用真实检查器）
 * - rollbackPlanCheckContext：回滚预案检查上下文（注入时 GateG8CheckerImpl 调用真实检查器）
 * - projectRoot：项目根目录（供 RollbackPlanChecker 拼接文件路径）
 * - runId：运行 ID（供 RollbackPlanChecker 拼接文件名）
 *
 * 禁用模式（向后兼容）：
 * - monitoringReady=true 显式传入时跳过真实校验
 * - rollbackPlanExists=true 显式传入时跳过真实校验
 * - 既有测试用例显式传入 true，保持行为不变
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
  /** 监控检查上下文（可选，批次 14 新增，注入时 GateG8CheckerImpl 调用真实检查器） */
  readonly monitoringCheckContext?: MonitoringCheckContext;
  /** 回滚预案检查上下文（可选，批次 14 新增，注入时 GateG8CheckerImpl 调用真实检查器） */
  readonly rollbackPlanCheckContext?: RollbackPlanCheckContext;
  /** 项目根目录（可选，批次 14 新增，供 RollbackPlanChecker 拼接文件路径） */
  readonly projectRoot?: string;
  /** 运行 ID（可选，批次 14 新增，供 RollbackPlanChecker 拼接文件名） */
  readonly runId?: string;
}

/**
 * G-8 门禁检查器接口
 *
 * 遵循 GateChecker 协议（gateId + check() 方法），但 gateId 固定为 "G-8"。
 *
 * Phase 2 在 gate/gate-g8-checker.ts 中实现 GateG8CheckerImpl 类
 * （架构师审查 P2-1 修复 v1.4：推荐接口与实现类不同名以避免声明合并混淆，
 *  实现类命名为 GateG8CheckerImpl；TypeScript 虽允许类与接口同名（会产生声明合并），但不推荐使用）
 *
 * 文件位置：packages/core/src/eag/gate/gate-g8-checker.ts（与既有 G-1~G-7 同目录）
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
 * 回滚策略类型联合（批次 14 Phase 3 新增，与 DeployStrategyType 对齐）
 *
 * 三种回滚策略对应不同的 kubectl 命令：
 * - rolling：`kubectl rollout undo deployment/<name>`（默认）
 * - blue-green：切换 Service selector 回上一个 version 标签
 * - canary：降级 traffic 分流（scale canary deployment 至 0）
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type RollbackStrategyType = "rolling" | "blue-green" | "canary";

/**
 * 快照上下文（批次 14 扩展，向后兼容）
 *
 * 批次 14 新增可选字段 projectRoot / runId，供回滚预案文件生成。
 * Phase 3 新增可选字段 rollbackStrategy，供回滚时选择对应策略。
 *
 * 字段说明：
 * - projectName：项目名称（K8s Deployment 名 / Helm Release 名）
 * - namespace：K8s 命名空间
 * - previousVersion：上一个稳定版本号（可选，首次部署时无）
 * - projectRoot：项目根目录（可选，批次 14 新增，用于生成回滚预案文件路径）
 * - runId：运行 ID（可选，批次 14 新增，用于回滚预案文件名唯一性）
 * - rollbackStrategy：回滚策略（可选，Phase 3 新增，默认 "rolling"）
 */
export interface RollbackSnapshotContext {
  /** 项目名称 */
  readonly projectName: string;
  /** K8s 命名空间 */
  readonly namespace: string;
  /** 上一个稳定版本号（可选） */
  readonly previousVersion?: string;
  /** 项目根目录（可选，批次 14 新增，用于回滚预案文件路径） */
  readonly projectRoot?: string;
  /** 运行 ID（可选，批次 14 新增，用于回滚预案文件名唯一性） */
  readonly runId?: string;
  /** 回滚策略（可选，Phase 3 新增，默认 "rolling"） */
  readonly rollbackStrategy?: RollbackStrategyType;
}

/**
 * 版本快照（批次 14 扩展，M-14-2 修复，Phase 3 扩展，向后兼容）
 *
 * 批次 13 既有字段（snapshotId / createdAt / version / resources）零改动，
 * 批次 14 新增可选字段 rollbackPlanFilePath，供 RollbackPlanChecker 校验。
 * Phase 3 新增可选字段 rollbackStrategy / snapshotDataPath，供回滚执行与快照数据文件引用。
 *
 * 字段说明：
 * - snapshotId：快照唯一 ID（用于回滚时引用）
 * - createdAt：创建时间戳（ISO 8601）
 * - version：版本号（kubectl rollout history REVISION / helm history REVISION）
 * - resources：快照包含的资源列表（如 ["deployment/myapp", "service/myapp"]）
 * - rollbackPlanFilePath：回滚预案文件路径（M-14-2 修复，可选，批次 14 新增）
 *   - 文件生成成功时为绝对路径（如 "/project/deploy/rollback-plan-xxx.md"）
 *   - 文件生成失败时为 undefined
 *   - NoOpRollbackManager 不返回此字段（向后兼容）
 *   - RollbackPlanChecker 校验此字段是否非空 + 文件是否存在
 * - rollbackStrategy：回滚策略（可选，Phase 3 新增，默认 "rolling"）
 *   - 在 createSnapshot 时从 context.rollbackStrategy 捕获
 *   - 在 rollback 时根据此字段选择对应策略的 kubectl 命令
 * - snapshotDataPath：快照数据文件路径（可选，Phase 3 新增）
 *   - K8s：`<projectRoot>/rollback-snapshots/<runId>/<deploymentName>.yaml`（kubectl get deployment -o yaml 原始输出）
 *   - Helm：`<projectRoot>/rollback-snapshots/<runId>/<release>.yaml`（helm history --output yaml 原始输出）
 *   - NoOpRollbackManager 不返回此字段（向后兼容）
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
  /** 回滚预案文件路径（M-14-2 修复，可选，批次 14 新增） */
  readonly rollbackPlanFilePath?: string;
  /** 回滚策略（可选，Phase 3 新增，默认 "rolling"） */
  readonly rollbackStrategy?: RollbackStrategyType;
  /** 快照数据文件路径（可选，Phase 3 新增，保存 kubectl/helm 原始输出） */
  readonly snapshotDataPath?: string;
  /** 项目名称（可选，Phase 3 新增，rollback 时引用 deployment/release 名） */
  readonly projectName?: string;
  /** K8s 命名空间（可选，Phase 3 新增，rollback 时引用 namespace） */
  readonly namespace?: string;
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
 * DevOps 编排器选项（N-M-1 修复：删除与 DeployStageOptions 重复的 4 个字段；批次 14 扩展：新增监控/回滚预案检查器可选注入）
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
 * 批次 14 扩展（向后兼容）：
 * - 新增可选字段 monitoringReadinessChecker / rollbackPlanChecker
 * - 注入时 DevOpsOrchestrator 在构造 GateG8Context 时调用真实检查器获取 monitoringReady / rollbackPlanExists 值
 * - 未注入时降级为 context.monitoringReady / context.rollbackPlanExists 字段值校验（向后兼容批次 13 行为）
 *
 * 字段说明：
 * - iacGenerators：IaC 生成器列表（至少 1 个，并行调用产出不同类型的 IaC 模板）
 * - gateG8Checker：G-8 部署门禁检查器
 * - deployStrategy：部署策略（批次 13 仅 RollingStrategy；DevOpsOrchestrator 用于注入 DeployContext.strategyType）
 * - deployStage：DEPLOY 子阶段编排器（DevOpsOrchestrator 委托 pre-deploy→deploy→post-deploy→smoke-test 四步给 DeployStage；
 *   PreDeployChecker / PostDeployChecker / SmokeTestRunner / RollbackManager 由 DeployStage 自身的 options 持有）
 * - eventEmitter：事件发射器（可选，与既有 orchestrator 一致）
 * - monitoringReadinessChecker：监控就绪检查器（可选，批次 14 新增，注入时调用真实检查器）
 * - rollbackPlanChecker：回滚预案检查器（可选，批次 14 新增，注入时调用真实检查器）
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
  /** 监控就绪检查器（可选，批次 14 新增，注入时 DevOpsOrchestrator 调用真实检查器获取 monitoringReady 值） */
  readonly monitoringReadinessChecker?: MonitoringReadinessChecker;
  /** 回滚预案检查器（可选，批次 14 新增，注入时 DevOpsOrchestrator 调用真实检查器获取 rollbackPlanExists 值） */
  readonly rollbackPlanChecker?: RollbackPlanChecker;
}

// ============================================================================
// 10. 监控就绪检查器相关类型（批次 14 §4.3.1 FR-12，Phase 4 实现 MonitoringReadinessCheckerImpl）
// ============================================================================

/**
 * 监控就绪检查器接口（FR-12）
 *
 * Phase 4 在 devops/monitoring-readiness-checker.ts 中实现 MonitoringReadinessCheckerImpl 类。
 *
 * 校验 3 项（K-4 决策：Alertmanager 规则校验首版不实现）：
 * 1. ServiceMonitor / PodMonitor 资源存在（kubectl get servicemonitor -n <ns>）
 * 2. /metrics 端点可达（HTTP GET 返回 200）
 * 3. Prometheus scrape 配置含目标服务（读取 ServiceMonitor selector 或 Prometheus config）
 *
 * 真实调用 kubectl 与 HTTP 请求（禁止 mock）。
 */
export interface MonitoringReadinessChecker {
  /**
   * 执行监控就绪检查
   *
   * @param context 监控检查上下文
   * @returns MonitoringCheckResult，被 Object.freeze 冻结
   */
  check(context: MonitoringCheckContext): Promise<MonitoringCheckResult>;
}

/**
 * 监控检查上下文
 *
 * 字段说明：
 * - projectName：项目名称
 * - namespace：K8s 命名空间
 * - serviceName：Service 名称（用于 /metrics 端点拼接）
 * - metricsEndpoint：/metrics 端点完整 URL（如 "http://myapp.default.svc.cluster.local:8080/metrics"）
 * - prometheusConfigPath：Prometheus 配置文件路径（可选，未提供时仅校验 ServiceMonitor）
 */
export interface MonitoringCheckContext {
  /** 项目名称 */
  readonly projectName: string;
  /** K8s 命名空间 */
  readonly namespace: string;
  /** Service 名称（用于 /metrics 端点拼接） */
  readonly serviceName: string;
  /** /metrics 端点完整 URL（如 "http://myapp.default.svc.cluster.local:8080/metrics"） */
  readonly metricsEndpoint: string;
  /** Prometheus 配置文件路径（可选，未提供时仅校验 ServiceMonitor） */
  readonly prometheusConfigPath?: string;
}

/**
 * 监控检查结果
 *
 * 字段说明：
 * - ready：监控是否就绪（3 项全过才为 true）
 * - checkedItems：各项检查结果列表
 * - failures：失败原因列表（ready=true 时为空数组）
 */
export interface MonitoringCheckResult {
  /** 监控是否就绪（3 项全过才为 true） */
  readonly ready: boolean;
  /** 各项检查结果 */
  readonly checkedItems: ReadonlyArray<MonitoringCheckedItem>;
  /** 失败原因列表（ready=true 时为空数组） */
  readonly failures: ReadonlyArray<string>;
}

/**
 * 单项检查结果
 *
 * 字段说明：
 * - name：检查项名称（serviceMonitorExists / metricsEndpointReachable / prometheusScrapeConfig）
 * - passed：是否通过
 * - detail：详情（如 ServiceMonitor 名称 / HTTP 状态码 / Prometheus 配置路径）
 */
export interface MonitoringCheckedItem {
  /** 检查项名称（serviceMonitorExists / metricsEndpointReachable / prometheusScrapeConfig） */
  readonly name: string;
  /** 是否通过 */
  readonly passed: boolean;
  /** 详情（如 ServiceMonitor 名称 / HTTP 状态码 / Prometheus 配置路径） */
  readonly detail: string;
}

// ============================================================================
// 11. 回滚预案检查器相关类型（批次 14 §4.3.2 FR-13，Phase 4 实现 RollbackPlanCheckerImpl）
// ============================================================================

/**
 * 回滚预案检查器接口（FR-13）
 *
 * Phase 4 在 devops/rollback-plan-checker.ts 中实现 RollbackPlanCheckerImpl 类。
 *
 * 校验 2 项：
 * 1. 回滚预案文件存在于指定路径（<projectRoot>/deploy/rollback-plan-<runId>.md）
 * 2. 文件内容含 5 个必需章节（目标版本号 / 回滚命令 / 资源清单 / 创建时间戳 / runId）
 *
 * 真实读取文件系统（fs.readFile，禁止 mock）。
 */
export interface RollbackPlanChecker {
  /**
   * 执行回滚预案检查
   *
   * @param context 检查上下文
   * @returns RollbackPlanCheckResult，被 Object.freeze 冻结
   */
  check(context: RollbackPlanCheckContext): Promise<RollbackPlanCheckResult>;
}

/**
 * 回滚预案检查上下文
 *
 * 字段说明：
 * - projectRoot：项目根目录（用于拼接文件路径 <projectRoot>/deploy/rollback-plan-<runId>.md）
 * - runId：运行 ID（用于拼接文件名 rollback-plan-<runId>.md）
 */
export interface RollbackPlanCheckContext {
  /** 项目根目录 */
  readonly projectRoot: string;
  /** 运行 ID（用于拼接文件名 rollback-plan-<runId>.md） */
  readonly runId: string;
}

/**
 * 回滚预案检查结果
 *
 * 字段说明：
 * - exists：文件是否存在
 * - valid：文件内容是否有效（5 个章节齐全）
 * - filePath：文件路径（exists=true 时为绝对路径，false 时为预期路径）
 * - failures：失败原因列表（exists=true 且 valid=true 时为空数组）
 */
export interface RollbackPlanCheckResult {
  /** 文件是否存在 */
  readonly exists: boolean;
  /** 文件内容是否有效（5 个章节齐全） */
  readonly valid: boolean;
  /** 文件路径（exists=true 时为绝对路径，false 时为预期路径） */
  readonly filePath: string;
  /** 失败原因列表（exists=true 且 valid=true 时为空数组） */
  readonly failures: ReadonlyArray<string>;
}

/**
 * 回滚预案文件 schema（5 个固定章节，K-1 决策）
 *
 * 文件格式：
 * # 回滚预案
 *
 * ## 目标版本号
 * <version>
 *
 * ## 回滚命令
 * ```bash
 * kubectl rollout undo deployment/<name> -n <ns> --to-revision=<N>
 * ```
 *
 * ## 资源清单
 * - deployment/<name>
 * - service/<name>
 *
 * ## 创建时间戳
 * <ISO 8601>
 *
 * ## runId
 * <runId>
 *
 * 不可变优先：通过 Object.freeze 冻结为只读元组，防止运行时篡改章节名。
 */
export const ROLLBACK_PLAN_SECTIONS = Object.freeze([
  "目标版本号",
  "回滚命令",
  "资源清单",
  "创建时间戳",
  "runId",
] as const) as ReadonlyArray<string>;

// ============================================================================
// 12. 发布策略配置选项（批次 14 §4.1.6/§4.1.7/§4.1.8 FR-5/FR-6 + B-14-1，Phase 2 实现 RollingStrategy/BlueGreenStrategy/CanaryStrategy）
// ============================================================================

/**
 * RollingStrategy 配置选项（B-14-1 修复）
 *
 * 字段说明：
 * - timeoutMs：部署命令超时（毫秒），默认 300000（5 分钟）
 *
 * 不可变优先：所有字段 readonly。
 */
export interface RollingStrategyOptions {
  /** 部署命令超时（毫秒），默认 300000（5 分钟） */
  readonly timeoutMs?: number;
}

/**
 * BlueGreenStrategy 配置选项（FR-5）
 *
 * 字段说明：
 * - timeoutMs：部署命令超时（毫秒），默认 300000（5 分钟）
 * - keepBlue：是否保留 Blue Deployment 兜底（默认 false，清理 Blue）
 *
 * 不可变优先：所有字段 readonly。
 */
export interface BlueGreenStrategyOptions {
  /** 部署命令超时（毫秒），默认 300000（5 分钟） */
  readonly timeoutMs?: number;
  /** 是否保留 Blue Deployment 兜底（默认 false，清理 Blue） */
  readonly keepBlue?: boolean;
}

/**
 * 金丝雀发布基础配置（FR-6）
 *
 * 仅包含金丝雀发布的最小配置：流量阶梯数组。
 * CanaryStrategyOptions 扩展此接口，新增运行时健康检查相关参数。
 *
 * 字段说明：
 * - canarySteps：流量阶梯数组（百分比，0~100，结尾必须为 100）
 *   - 数组长度至少 1（仅 [100] 表示一次性全量切换）
 *   - 每个元素为正整数，范围 0~100
 *   - 最后一个元素必须为 100（最终全量）
 *
 * 不可变优先：所有字段 readonly，数组 ReadonlyArray<number>。
 */
export interface CanaryConfig {
  /** 流量阶梯数组（百分比，0~100，结尾必须为 100） */
  readonly canarySteps: ReadonlyArray<number>;
}

/**
 * CanaryStrategy 配置选项（FR-6）
 *
 * 扩展 CanaryConfig，新增运行时健康检查相关参数。
 *
 * 字段说明：
 * - canarySteps：流量阶梯数组（百分比，0~100，结尾必须为 100）—— 继承自 CanaryConfig
 * - healthCheckTimeoutMs：单阶梯健康检查超时（毫秒），默认 60000
 * - healthCheckPath：健康检查端点路径，默认 "/healthz"
 *
 * 不可变优先：所有字段 readonly，数组 ReadonlyArray<number>。
 */
export interface CanaryStrategyOptions extends CanaryConfig {
  /** 单阶梯健康检查超时（毫秒），默认 60000 */
  readonly healthCheckTimeoutMs?: number;
  /** 健康检查端点路径，默认 "/healthz" */
  readonly healthCheckPath?: string;
}

// ============================================================================
// 13. Phase 3 回滚管理器扩展类型（K8sRollbackManager / HelmRollbackManager 完整实现所需）
// ============================================================================

/**
 * 回滚执行错误（Phase 3 新增，kubectl/helm 命令执行失败时抛出）
 *
 * 当 K8sRollbackManager / HelmRollbackManager 调用 kubectl/helm 命令失败
 * （退出码非 0 / 进程启动失败 / 超时）时抛出此错误。
 *
 * 与 RollingStrategy 的"错误内化"模式不同，RollbackManager 采用"错误外抛"模式：
 * - RollingStrategy 在 DeployResult.errors 中收集错误，不抛异常（部署阶段可降级）
 * - RollbackManager 在命令失败时直接抛 RollbackExecutionError（回滚阶段不可降级，必须明确失败）
 *
 * 字段说明：
 * - command：执行的命令名称（如 "kubectl rollout undo" / "helm rollback"）
 * - stderr：命令的标准错误输出（含 kubectl/helm 的错误诊断信息）
 * - exitCode：退出码（null 表示进程被信号终止或启动失败）
 *
 * 不可变优先：错误实例通过 Object.freeze 冻结，防止运行时篡改错误信息。
 */
export class RollbackExecutionError extends Error {
  /** 执行的命令名称（如 "kubectl rollout undo" / "helm rollback"） */
  public readonly stderr: string;
  /** 命令的标准错误输出（含 kubectl/helm 的错误诊断信息） */
  public readonly command: string;
  /** 退出码（null 表示进程被信号终止或启动失败） */
  public readonly exitCode: number | null;

  /**
   * 构造函数
   *
   * @param command 执行的命令名称（如 "kubectl rollout undo"）
   * @param stderr 命令的标准错误输出
   * @param exitCode 退出码（null 表示进程被信号终止或启动失败）
   */
  constructor(command: string, stderr: string, exitCode: number | null) {
    // 构造清晰的错误消息，包含命令名称、退出码与 stderr 输出
    super(`回滚命令执行失败：${command}（exitCode=${exitCode}）：${stderr}`);
    this.name = "RollbackExecutionError";
    this.command = command;
    this.stderr = stderr;
    this.exitCode = exitCode;
    // 维持原型链（TypeScript 编译到 ES5 时继承 Error 的已知问题）
    Object.setPrototypeOf(this, RollbackExecutionError.prototype);
    // 冻结实例：防止运行时修改错误信息（对齐 P-1 不可变优先原则）
    Object.freeze(this);
  }
}

/**
 * K8s 回滚快照数据（Phase 3 新增，描述 K8sRollbackManager.createSnapshot 的数据结构）
 *
 * 此类型描述 createSnapshot 方法捕获的 K8s Deployment 快照数据，包含：
 * - deploymentYaml：`kubectl get deployment <name> -o yaml` 的完整输出
 * - revision：Deployment 的 revision 号（来自 `kubectl rollout history`）
 * - labels：Deployment 的 labels（用于 blue-green 回滚时切换 Service selector）
 *
 * 数据持久化：
 * - deploymentYaml 保存到 `<projectRoot>/rollback-snapshots/<runId>/<deploymentName>.yaml`
 * - revision 写入 RollbackSnapshot.version 字段（字符串形式）
 * - labels 用于 rollback 时构造 kubectl patch 命令
 *
 * 不可变优先：所有字段 readonly，labels 为 Readonly<Record>。
 */
export interface K8sRollbackSnapshotData {
  /** `kubectl get deployment <name> -o yaml` 的完整输出（原始 YAML 字符串） */
  readonly deploymentYaml: string;
  /** Deployment 的 revision 号（来自 `kubectl rollout history`，数值形式） */
  readonly revision: number;
  /** Deployment 的 labels（用于 blue-green 回滚时切换 Service selector） */
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * Helm 回滚快照数据（Phase 3 新增，描述 HelmRollbackManager.createSnapshot 的数据结构）
 *
 * 此类型描述 createSnapshot 方法捕获的 Helm Release 快照数据，包含：
 * - revisions：`helm history <release> --output yaml` 解析后的最近 3 个 revision 记录
 * - chartVersion：Chart 版本号（来自最近一次 revision 的 chart 字段）
 * - namespace：Helm Release 所在的命名空间
 *
 * 数据持久化：
 * - 原始 helm history 输出保存到 `<projectRoot>/rollback-snapshots/<runId>/<release>.yaml`
 * - 最近一次 revision 号写入 RollbackSnapshot.version 字段（字符串形式）
 *
 * 不可变优先：所有字段 readonly，revisions 为 ReadonlyArray。
 */
export interface HelmRollbackSnapshotData {
  /** `helm history <release> --output yaml` 解析后的最近 3 个 revision 记录 */
  readonly revisions: ReadonlyArray<{
    /** Revision 号 */
    readonly revision: number;
    /** Revision 状态（deployed / superseded / failed 等） */
    readonly status: string;
    /** Chart 名称与版本（如 "myapp-0.1.0"） */
    readonly chart: string;
    /** App 版本号 */
    readonly appVersion: string;
    /** Revision 描述（如 "Install complete"） */
    readonly description: string;
    /** 更新时间戳 */
    readonly updated: string;
  }>;
  /** Chart 版本号（来自最近一次 revision 的 chart 字段） */
  readonly chartVersion: string;
  /** Helm Release 所在的命名空间 */
  readonly namespace: string;
}

/**
 * 回滚验证结果（Phase 3 新增，verifyRollback 方法的返回值）
 *
 * 描述回滚后对资源状态的验证结果，用于确认回滚是否真正生效。
 *
 * K8s 验证语义：
 * - currentReplicas：`kubectl rollout status` 返回的当前可用副本数
 * - expectedReplicas：Deployment spec.replicas 期望副本数
 * - success：currentReplicas >= expectedReplicas
 *
 * Helm 验证语义：
 * - currentReplicas：当前 revision 号（helm history 的最新 revision）
 * - expectedReplicas：目标 revision 号（snapshot.version 解析）
 * - success：currentReplicas === expectedReplicas
 *
 * 不可变优先：所有字段 readonly。
 */
export interface RollbackVerificationResult {
  /** 验证是否成功（K8s: 副本数达标；Helm: revision 匹配） */
  readonly success: boolean;
  /** 当前副本数（K8s: 可用副本数；Helm: 当前 revision 号） */
  readonly currentReplicas: number;
  /** 期望副本数（K8s: 期望副本数；Helm: 目标 revision 号） */
  readonly expectedReplicas: number;
  /** 验证消息（含人类可读的诊断信息） */
  readonly message: string;
}

/**
 * 回滚预案步骤（Phase 3 新增，RollbackPlanWriter 使用的步骤定义）
 *
 * 描述回滚预案中的单个步骤，包含步骤号、动作描述与执行的命令。
 *
 * 字段说明：
 * - step：步骤序号（从 1 开始递增）
 * - action：动作描述（如 "执行 kubectl rollout undo" / "切换 Service selector"）
 * - command：实际执行的命令（如 "kubectl rollout undo deployment/myapp -n default --to-revision=5"）
 *
 * 不可变优先：所有字段 readonly。
 */
export interface RollbackPlanStep {
  /** 步骤序号（从 1 开始递增） */
  readonly step: number;
  /** 动作描述（如 "执行 kubectl rollout undo"） */
  readonly action: string;
  /** 实际执行的命令（如 "kubectl rollout undo deployment/myapp -n default --to-revision=5"） */
  readonly command: string;
}

/**
 * 回滚预案（Phase 3 新增，RollbackPlanWriter 序列化/反序列化的数据结构）
 *
 * 描述完整的回滚预案，包含目标版本号、回滚命令、资源清单、创建时间戳、runId 与步骤列表。
 * 与 ROLLBACK_PLAN_SECTIONS（Markdown 格式的 5 章节）对齐，但采用 YAML 格式便于机器解析。
 *
 * 字段说明（与 ROLLBACK_PLAN_SECTIONS 5 章节对齐）：
 * - targetVersion：目标版本号（对应"目标版本号"章节）
 * - rollbackCommand：回滚命令（对应"回滚命令"章节）
 * - resources：资源清单（对应"资源清单"章节）
 * - createdAt：创建时间戳（对应"创建时间戳"章节，ISO 8601）
 * - runId：运行 ID（对应"runId"章节）
 * - steps：回滚步骤列表（新增，描述多步骤回滚流程）
 *
 * 不可变优先：所有字段 readonly，resources / steps 为 ReadonlyArray。
 */
export interface RollbackPlan {
  /** 目标版本号（对应 ROLLBACK_PLAN_SECTIONS "目标版本号" 章节） */
  readonly targetVersion: string;
  /** 回滚命令（对应 ROLLBACK_PLAN_SECTIONS "回滚命令" 章节） */
  readonly rollbackCommand: string;
  /** 资源清单（对应 ROLLBACK_PLAN_SECTIONS "资源清单" 章节） */
  readonly resources: ReadonlyArray<string>;
  /** 创建时间戳（对应 ROLLBACK_PLAN_SECTIONS "创建时间戳" 章节，ISO 8601） */
  readonly createdAt: string;
  /** 运行 ID（对应 ROLLBACK_PLAN_SECTIONS "runId" 章节） */
  readonly runId: string;
  /** 回滚步骤列表（新增，描述多步骤回滚流程，至少 1 个步骤） */
  readonly steps: ReadonlyArray<RollbackPlanStep>;
}
