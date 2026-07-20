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

/**
 * SmokeTestRunnerImpl —— 烟雾测试执行器实现（Phase 5 D2-4）
 *
 * 按 endpoints × testCases 笛卡尔积执行真实 HTTP 请求，验证部署后端点可用性：
 * - 使用 node:http / node:https 发起真实 HTTP 请求（根据 URL 协议自动选择）
 * - 超时控制默认 5000ms
 * - 校验响应状态码 + 响应体包含字符串
 * - 收集失败用例，返回结构化 SmokeTestResult
 * - 不可变优先：返回对象和 failures 数组通过 Object.freeze 冻结
 */
export { SmokeTestRunnerImpl } from "../deploy/smoke-test-runner";

// ============================================================================
// 阶段编排器导出（Phase 5 D2-1，1 个编排器类）
// ============================================================================

/**
 * DeployStageImpl —— DEPLOY 阶段编排器实现
 *
 * 编排 pre-deploy → deploy → post-deploy → smoke-test 四步阶段：
 * 1. pre-deploy 检查：调用 PreDeployChecker.check()（镜像/配置/依赖/配额）
 * 2. deploy 部署：调用 DeployStrategy.execute()（部署前创建版本快照）
 * 3. post-deploy 检查：调用 PostDeployChecker.check()（Pod/Service/日志/指标）
 * 4. smoke-test 烟雾测试：调用 SmokeTestRunner.run()（HTTP 请求验证端点）
 *
 * 失败处理：
 * - pre-deploy 失败：不触发回滚（尚未部署任何资源）
 * - deploy / post-deploy / smoke-test 失败：如果 rollbackManager 存在则触发回滚
 * - 回滚仅触发一次（通过 rollbackExecuted 标志位避免重复回滚）
 *
 * B-2 修复：填充 healthEndpoints 字段供 DevOpsOrchestrator 构造 HealthCheckResult
 * M-1 修复：从 PostDeployCheckResult.endpoints 提取健康端点
 */
export { DeployStageImpl } from "../deploy/deploy-stage";

// ============================================================================
// 角色编排器导出（Phase 6 D1-1，1 个编排器类）
// ============================================================================

/**
 * DevOpsOrchestrator —— DevOps 第 6 角色编排器实现
 *
 * 编排 5 步流程：
 * 1. 发射 devops-started 事件
 * 2. 生成 IaC 模板（并行调用多个生成器）
 * 3. 校验 IaC 模板（并行校验）
 * 4. 委托 DeployStage.execute() 执行 4 步阶段（pre-deploy → deploy → post-deploy → smoke-test）
 * 5. 调用 GateG8Checker 校验部署就绪状态，发射 devops-completed 事件
 *
 * 失败处理：任一步骤失败时发射 devops-failed 事件并提前返回
 *
 * B-4 修复：DevOpsOrchestrator 与 DeployStage 职责边界明确
 * - DevOpsOrchestrator：角色编排器（IaC 生成 + 校验 + 委托 + G-8 门禁 + 事件发射）
 * - DeployStage：阶段编排器（4 步阶段 + 失败时触发 RollbackManager）
 *
 * N-M-1 修复：DevOpsOrchestratorOptions 仅保留 DevOpsOrchestrator 自身使用的字段
 * （iacGenerators / gateG8Checker / deployStrategy / deployStage / eventEmitter）
 * PreDeployChecker / PostDeployChecker / SmokeTestRunner / RollbackManager 由 DeployStageOptions 持有
 *
 * N-M-4 修复：失败时仍从 deployStageResult.healthEndpoints 构造 healthCheckResult
 *
 * M-1/M-2 修复：healthCheckResult.endpoints 从 deployStageResult.healthEndpoints 填充
 *
 * M-5 修复：IaC 生成器并行调用（Promise.all）
 *
 * M-10 修复：duration 直接用毫秒相减，避免 ISO 字符串 parse 误差
 */
export { DevOpsOrchestrator } from "./devops-orchestrator";
