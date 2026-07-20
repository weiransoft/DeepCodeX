/**
 * EAG DevOps 模块 barrel 导出（EAG-P4 批次 13 D1-4）
 *
 * 本模块统一导出 DevOps 角色相关的类型与实现，供外部消费者从单一入口导入。
 *
 * 导出内容：
 * - 类型定义（types.ts）：DevOpsContext / DevOpsResult / IaCTemplate / DeployStrategy /
 *   HealthCheckResult / SmokeTestResult / GateG8Checker / PreDeployChecker /
 *   PostDeployChecker / RollbackManager / DeployStage / DevOpsOrchestratorOptions 等
 * - 实现类（rollback-manager.ts）：NoOpRollbackManager（占位实现，批次 14 扩展真实实现）
 *
 * 不在本模块导出的实现类（避免循环依赖）：
 * - GateG8CheckerImpl 类：从 eag/gate/index.ts 导出（gate 模块是 G-1~G-8 检查器的自然归属）
 *   理由：gate-g8-checker.ts 需从 devops/types.ts 导入 GateG8Context 类型（type-only），
 *         若 devops/index.ts 再导出 GateG8CheckerImpl 会形成循环依赖
 *
 * 后续批次导出（Phase 3~7 完成后逐步添加）：
 * - iac-generators/*.ts：TerraformGenerator / K8sManifestGenerator / HelmChartGenerator 类（Phase 3）
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
