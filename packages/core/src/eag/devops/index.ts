/**
 * EAG DevOps 模块 barrel 导出（EAG-P4 批次 13 D1-4 + Phase 3 D1-2 IaC 生成器 + Phase 4 D2-2/D2-3 部署检查器 + Phase 4 监控就绪/回滚预案检查器）
 *
 * 本模块统一导出 DevOps 角色相关的类型与实现，供外部消费者从单一入口导入。
 *
 * 导出内容：
 * - 类型定义（types.ts）：DevOpsContext / DevOpsResult / IaCTemplate / DeployStrategy /
 *   HealthCheckResult / SmokeTestResult / GateG8Checker / PreDeployChecker /
 *   PostDeployChecker / RollbackManager / DeployStage / DevOpsOrchestratorOptions /
 *   MonitoringReadinessChecker / RollbackPlanChecker 等
 * - 实现类（rollback-manager.ts）：NoOpRollbackManager（占位实现，批次 14 扩展真实实现）
 * - IaC 生成器（iac-generator/*.ts，Phase 3 新增）：
 *   TerraformGenerator / K8sManifestGenerator / HelmChartGenerator
 * - 部署检查器（deploy/*.ts，Phase 4 新增）：
 *   PreDeployCheckerImpl / PostDeployCheckerImpl
 * - 监控就绪检查器（devops/monitoring-readiness-checker.ts，Phase 4 TASK-14-4-1 新增）：
 *   MonitoringReadinessCheckerImpl
 * - 回滚预案检查器（devops/rollback-plan-checker.ts，Phase 4 TASK-14-4-2 新增）：
 *   RollbackPlanCheckerImpl
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
  // 10. 监控就绪检查器相关类型（批次 14 §4.3.1 FR-12）
  MonitoringReadinessChecker,
  MonitoringCheckContext,
  MonitoringCheckResult,
  MonitoringCheckedItem,
  // 11. 回滚预案检查器相关类型（批次 14 §4.3.2 FR-13）
  RollbackPlanChecker,
  RollbackPlanCheckContext,
  RollbackPlanCheckResult,
  // 12. 发布策略配置选项（批次 14 §4.1.6/§4.1.7/§4.1.8 FR-5/FR-6 + B-14-1）
  RollingStrategyOptions,
  BlueGreenStrategyOptions,
  CanaryConfig,
  CanaryStrategyOptions,
  // 回滚预案文件 schema 常量（K-1 决策，5 个固定章节）
  ROLLBACK_PLAN_SECTIONS,
  // 13. Phase 3 回滚管理器扩展类型（K8sRollbackManager / HelmRollbackManager 完整实现所需）
  RollbackStrategyType,
  K8sRollbackSnapshotData,
  HelmRollbackSnapshotData,
  RollbackVerificationResult,
  RollbackPlanStep,
  RollbackPlan,
} from "./types";

// ============================================================================
// 值导出：RollbackExecutionError 错误类（Phase 3 新增，需要在运行时实例化）
// ============================================================================

/**
 * RollbackExecutionError —— 回滚执行错误类（Phase 3 新增）
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
export { RollbackExecutionError } from "./types";

// ============================================================================
// 实现类导出（RollbackManager 实现，批次 13 + 批次 14 Phase 1）
// ============================================================================

/**
 * NoOpRollbackManager —— 空实现占位（批次 13）
 *
 * 用途：DevOpsOrchestrator / DeployStage 在未注入 rollbackManager 时使用此占位。
 * - createSnapshot() 返回空快照（snapshotId="noop-<timestamp>" / version="unknown"）
 * - rollback() 直接返回 success=false（无法回滚，提示用户手动处理）
 */
export { NoOpRollbackManager } from "./rollback-manager";

/**
 * K8sRollbackManager —— 基于 kubectl 的回滚管理器实现（FR-2，Phase 3 完整实现）
 *
 * 真实调用 kubectl CLI（通过 child_process.execFile，禁止 shell:true 避免命令注入）：
 * - createSnapshot()：kubectl get deployment -o yaml + kubectl rollout history
 * - rollback()：根据 RollbackStrategyType 调用 rolling / blue-green / canary 三种策略
 * - verifyRollback()：轮询 kubectl get deployment -o json 检查 availableReplicas
 *
 * 错误处理（错误外抛模式，区别于 RollingStrategy 的错误内化）：
 * - kubectl 命令失败：抛出 RollbackExecutionError（含 stderr / command / exitCode）
 * - verifyRollback 失败：返回 RollbackResult.success=false（不抛异常，调用方可重试）
 */
export { K8sRollbackManager } from "./rollback-manager";
export type { K8sRollbackManagerOptions } from "./rollback-manager";

/**
 * HelmRollbackManager —— 基于 helm 的回滚管理器实现（FR-3，Phase 3 完整实现）
 *
 * 真实调用 helm CLI（通过 child_process.execFile，禁止 shell:true 避免命令注入）：
 * - createSnapshot()：helm history <release> -n <ns> --output yaml
 * - rollback()：helm rollback <release> <revision> -n <ns>
 * - verifyRollback()：helm history 确认当前 revision 为目标值
 *
 * 与 K8sRollbackManager 同构，但调用 helm CLI。
 */
export { HelmRollbackManager } from "./rollback-manager";
export type { HelmRollbackManagerOptions } from "./rollback-manager";

/**
 * RollbackPlanWriter —— 回滚预案 YAML 文件读写器（Phase 3 新增，TASK-14-3-4）
 *
 * 提供三个核心方法：
 * - writePlan：将 RollbackPlan 序列化为 YAML 文件（自实现 emitter，不依赖外部 yaml 包）
 * - readPlan：从 YAML 文件反序列化为 RollbackPlan 对象（自实现 parser）
 * - validatePlanFile：校验文件存在性 + 字段完整性 + steps 非空
 *
 * 设计原则：
 * - 零新增依赖：仅复用 node:* 内置模块（fs / path），不引入外部 yaml 包
 * - 不可变优先：返回的 RollbackPlan 对象通过 Object.freeze 深冻结
 * - 安全原则：文件权限 0o600，目录权限 0o700
 */
export { RollbackPlanWriter } from "./rollback-plan-writer";
export type { RollbackPlanWriterOptions } from "./rollback-plan-writer";

/**
 * createRollbackManager —— RollbackManager 装配工厂（FR-4，K-3 决策）
 *
 * 根据 IaCType 选择对应的 RollbackManager 实现注入 DeployStageOptions.rollbackManager：
 * - k8s-manifest → K8sRollbackManager
 * - helm-chart → HelmRollbackManager
 * - terraform → K8sRollbackManager（兜底，打印 WARNING 日志，K-3 条件）
 *
 * 防御性检查：未识别的 iacType 抛 UnsupportedRollbackManagerTypeError。
 */
export { createRollbackManager, UnsupportedRollbackManagerTypeError } from "./rollback-manager";
export type { RollbackManagerFactoryOptions } from "./rollback-manager";

// ============================================================================
// 部署策略导出（批次 14 Phase 2，3 个策略类）
// 通过 devops/index.ts 重新导出，统一入口为 eag/devops（与 PreDeployCheckerImpl /
// PostDeployCheckerImpl / SmokeTestRunnerImpl / DeployStageImpl 跨目录导入模式一致）
// ============================================================================

/**
 * RollingStrategy —— 滚动发布策略实现（B-14-1 Blocker 修复，§4.1.6）
 *
 * 真实调用 kubectl apply / rollout status / get 命令，与 BlueGreenStrategy / CanaryStrategy 同构。
 */
export { RollingStrategy } from "../deploy/rolling-strategy";

/**
 * BlueGreenStrategy —— 蓝绿发布策略实现（FR-5，§4.1.7）
 *
 * 部署 Green Deployment → 等待 Ready → 切换 Service selector → 清理 Blue（keepBlue=true 时跳过）。
 * 失败恢复：Green Pod 未 Ready 不切换流量；流量切换失败 best-effort 回切 Blue。
 */
export { BlueGreenStrategy } from "../deploy/blue-green-strategy";

/**
 * CanaryStrategy —— 金丝雀发布策略实现（FR-6，§4.1.8，K-2 决策）
 *
 * 部署 Canary Deployment → 按流量阶梯循环（kubectl scale + rollout status + HTTP /healthz）
 * → 全部阶梯通过后删除 Stable Deployment。
 *
 * 构造期校验 canarySteps：数组非空、元素为正整数、0~100 范围、结尾必须为 100。
 * 失败时保留 Canary 资源（R-14-1 缓解 A-1）。
 */
export { CanaryStrategy } from "../deploy/canary-strategy";

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
// 监控就绪 / 回滚预案检查器导出（Phase 4 TASK-14-4-1 / TASK-14-4-2，2 个检查器类）
// ============================================================================

/**
 * MonitoringReadinessCheckerImpl —— 监控就绪检查器实现（FR-12，K-4 决策）
 *
 * 校验 3 项监控就绪条件（K-4 决策：Alertmanager 规则首版不实现）：
 * 1. ServiceMonitor / PodMonitor 资源存在：调用 kubectl get servicemonitor -n <ns>
 * 2. /metrics 端点可达：HTTP GET context.metricsEndpoint 返回 200
 * 3. Prometheus scrape 配置含目标服务：读取 prometheusConfigPath 文件 + 自实现 YAML parser
 *
 * 真实调用 kubectl 与 HTTP 请求（禁止 mock，NFR-3）：
 * - kubectl CLI：通过 node:child_process.spawn 调用，不使用 shell:true 避免命令注入
 * - HTTP 请求：通过 node:http / node:https 真实发起
 * - 文件读取：通过 node:fs.readFileSync 真实读取
 *
 * 预留 checkAlertmanagerRules 可选方法（K-4 决策：首版不实现，返回 undefined）
 *
 * 不可变优先：返回的 MonitoringCheckResult 对象 + checkedItems 数组 + failures 数组均通过 Object.freeze 冻结
 */
export { MonitoringReadinessCheckerImpl } from "./monitoring-readiness-checker";

/**
 * RollbackPlanCheckerImpl —— 回滚预案检查器实现（FR-13，K-1 决策）
 *
 * 校验 2 项回滚预案就绪条件（K-1 决策：5 个固定章节）：
 * 1. 回滚预案文件存在于 <projectRoot>/deploy/rollback-plan-<runId>.md（fs.existsSync 真实校验）
 * 2. 文件内容含 5 个必需章节（正则解析 ## 目标版本号 / ## 回滚命令 / ## 资源清单 / ## 创建时间戳 / ## runId）
 *
 * 真实读取文件系统（禁止 mock，NFR-3）：
 * - fs.existsSync / fs.readFileSync：真实读取文件系统
 * - 正则表达式：不依赖外部 markdown parser，零新增依赖
 *
 * 错误处理（不抛异常，错误内化）：
 * - 文件不存在时返回 exists=false + valid=false + failures=["文件不存在：<path>"]
 * - 文件存在但章节缺失时返回 valid=false + failures 含缺失章节名
 *
 * 不可变优先：返回的 RollbackPlanCheckResult 对象 + failures 数组均通过 Object.freeze 冻结
 */
export { RollbackPlanCheckerImpl } from "./rollback-plan-checker";

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
