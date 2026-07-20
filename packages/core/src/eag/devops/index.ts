/**
 * EAG DevOps 模块 barrel 导出（EAG-P4 批次 13 D1-4 + Phase 3 D1-2 IaC 生成器 + Phase 4 D2-2/D2-3 部署检查器）
 *
 * 本模块统一导出 DevOps 角色相关的类型与实现，供外部消费者从单一入口导入。
 *
 * 导出内容：
 * - 类型定义（types.ts）：DevOpsContext / DevOpsResult / IaCTemplate / DeployStrategy /
 *   HealthCheckResult / SmokeTestResult / GateG8Checker / PreDeployChecker /
 *   PostDeployChecker / RollbackManager / DeployStage / DevOpsOrchestratorOptions 等
 * - 实现类（rollback-manager.ts）：NoOpRollbackManager（占位实现，批次 14 扩展真实实现）
 * - IaC 生成器（iac-generator/*.ts，Phase 3 新增）：
 *   TerraformGenerator / K8sManifestGenerator / HelmChartGenerator
 * - 部署检查器（deploy/*.ts，Phase 4 新增）：
 *   PreDeployCheckerImpl / PostDeployCheckerImpl
 *
 * 不在本模块导出的实现类（避免循环依赖）：
 * - GateG8CheckerImpl 类：从 eag/gate/index.ts 导出（gate 模块是 G-1~G-8 检查器的自然归属）
 *   理由：gate-g8-checker.ts 需从 devops/types.ts 导入 GateG8Context 类型（type-only），
 *         若 devops/index.ts 再导出 GateG8CheckerImpl 会形成循环依赖
 *
 * 跨目录导入说明（Phase 4 新增）：
 * - PreDeployCheckerImpl / PostDeployCheckerImpl 位于 eag/deploy/ 目录
 * - 从 eag/devops/index.ts 重新导出，统一入口为 eag/devops
 * - 依赖方向：devops/index.ts → deploy/pre-deploy-checker.ts → devops/types.ts（type-only）
 * - 无循环依赖（pre-deploy-checker.ts 仅从 devops/types.ts 导入类型，不导入实现）
 *
 * 后续批次导出（Phase 5~7 完成后逐步添加）：
 * - deploy-stage.ts：DeployStageImpl 类（Phase 5）
 * - devops-orchestrator.ts：DevOpsOrchestrator 类（Phase 6）
 *
 * @module eag/devops
 */

// 类型定义导出
export type {
  // 1. IaC 模板相关类型
  IaCType,
  IaCTemplate,
  IaCGenerator,
  IaCGenerationContext,
  ContainerResources,
  ResourceSpec,
  EnvVar,
  IngressConfig,
  IaCValidationResult,
  // 2. 部署相关类型
  DeployStrategyType,
  DeployStrategy,
  DeployContext,
  DeployResult,
  DeployedResource,
  // 3. 健康检查与烟雾测试
  HealthCheckResult,
  HealthEndpoint,
  SmokeTestResult,
  SmokeTestFailure,
  SmokeTestCase,
  SmokeTestRunner,
  // 4. DevOps 编排器类型
  DevOpsEvent,
  DevOpsEventEmitter,
  DevOpsContext,
  DevOpsResult,
  // 5. G-8 门禁相关类型
  GateG8Context,
  GateG8Checker,
  // 6. PreDeploy / PostDeploy 检查器接口
  PreDeployChecker,
  PreDeployCheckContext,
  PreDeployCheckResult,
  PostDeployChecker,
  PostDeployCheckContext,
  PostDeployCheckResult,
  // 7. RollbackManager 相关类型
  RollbackManager,
  RollbackSnapshotContext,
  RollbackSnapshot,
  RollbackResult,
  // 8. DeployStage 相关类型
  DeployStageOptions,
  DeployStageResult,
  DeployStage,
  // 9. DevOpsOrchestrator 相关类型
  DevOpsOrchestratorOptions,
} from "./types";

// 实现类导出
export { NoOpRollbackManager } from "./rollback-manager";

// ============================================================================
// IaC 生成器导出（Phase 3 D1-2，3 个生成器类）
// ============================================================================

/**
 * TerraformGenerator —— Terraform HCL 模板生成器
 *
 * 产出 main.tf / variables.tf / outputs.tf 三个文件，
 * 通过 kubernetes_provider 接入既有 K8s 集群，创建 namespace / deployment / service / ingress 资源。
 * validate() 调用 `terraform validate -json` 校验 HCL 语法。
 */
export { TerraformGenerator } from "./iac-generator/terraform-generator";

/**
 * K8sManifestGenerator —— Kubernetes Manifest YAML 生成器
 *
 * 产出 namespace / configmap / secret / deployment / service / ingress 6 种资源 YAML 文件。
 * validate() 调用 `kubectl apply --dry-run=client -f <file>` 校验 YAML 语法与 API 对象合法性。
 */
export { K8sManifestGenerator } from "./iac-generator/k8s-manifest-generator";

/**
 * HelmChartGenerator —— Helm Chart 模板生成器
 *
 * 产出 Chart.yaml / values.yaml / templates/_helpers.tpl / templates/deployment.yaml /
 * templates/service.yaml / templates/ingress.yaml / templates/secret.yaml 6~7 个文件。
 * validate() 调用 `helm lint <chart-dir>` 校验 Chart 结构与模板语法。
 */
export { HelmChartGenerator } from "./iac-generator/helm-chart-generator";

// ============================================================================
// 部署检查器导出（Phase 4 D2-2 + D2-3，2 个检查器类）
// ============================================================================

/**
 * PreDeployCheckerImpl —— 部署前检查器实现
 *
 * 校验 4 项部署前置条件：
 * 1. 镜像构建成功（imageBuilt）：调用 docker inspect <image>
 * 2. 配置完整性（configValid）：IaC 模板数组非空
 * 3. 依赖服务可用（dependenciesAvailable）：N-M-2 修复，处理首次部署场景
 * 4. 资源配额充足（resourceQuotaSufficient）：N-M-2 修复，处理首次部署场景
 *
 * 真实 CLI 调用：docker / kubectl（CLI 不存在时降级返回 false）
 */
export { PreDeployCheckerImpl } from "../deploy/pre-deploy-checker";

/**
 * PostDeployCheckerImpl —— 部署后检查器实现
 *
 * 校验 4 项部署后状态：
 * 1. Pod 就绪（podsReady）：调用 kubectl get pods -n <ns> -o json
 * 2. Service 端点可达（serviceEndpointReachable）：M-1 修复，返回 HealthEndpoint
 * 3. 日志无 ERROR（logsClean）：调用 kubectl logs --all-containers=true --tail=1000
 * 4. 指标上报正常（metricsReporting）：调用 kubectl get --raw /metrics
 *
 * M-1 修复：填充 endpoints 字段供 DevOpsOrchestrator 构造 HealthCheckResult
 * 真实 CLI 调用：kubectl（CLI 不存在时降级返回 false）
 */
export { PostDeployCheckerImpl } from "../deploy/post-deploy-checker";
