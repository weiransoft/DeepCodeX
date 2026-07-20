/**
 * DeployStage —— DEPLOY 阶段编排器（EAG-P4 批次 13 Phase 5 D2-1）
 *
 * 核心职责：
 * - 编排 pre-deploy → deploy → post-deploy → smoke-test 四步阶段
 * - 失败时触发 RollbackManager（如果注入）
 * - 与 DesignLoop / CodingLoop / TestingLoop 同构的阶段编排器
 *
 * 4 步阶段编排：
 * 1. pre-deploy 检查：调用 PreDeployChecker.check()，校验镜像/配置/依赖/配额 4 项
 *    - 失败时直接返回（不进入 deploy，不触发回滚，因为尚未部署任何资源）
 * 2. deploy 部署：调用 DeployStrategy.execute()，按策略执行实际部署（rolling/blue-green/canary）
 *    - 部署前创建版本快照（如果 rollbackManager 存在）
 *    - 失败时如果 rollbackManager 存在且快照创建成功，调用 rollback() 触发回滚
 * 3. post-deploy 检查：调用 PostDeployChecker.check()，校验 Pod/Service/日志/指标 4 项
 *    - 失败时如果 rollbackManager 存在，调用 rollback() 触发回滚
 *    - 填充 healthEndpoints（从 PostDeployCheckResult.endpoints，B-2 修复）
 * 4. smoke-test 烟雾测试：调用 SmokeTestRunner.run()，按用例发起 HTTP 请求验证端点
 *    - 失败时如果 rollbackManager 存在，调用 rollback() 触发回滚
 *
 * 失败处理：
 * - 任一步骤失败时收集错误，根据是否已部署决定是否回滚
 * - 回滚仅触发一次（避免重复回滚）
 * - 回滚失败时把回滚错误追加到 errors
 *
 * 不可变优先（§5.12.4 G-A6d）：
 * - execute() 返回的 DeployStageResult 对象通过 Object.freeze 冻结
 * - healthEndpoints 数组和 errors 数组通过 Object.freeze 冻结
 *
 * 设计依据：
 * - EAG-P4 批次 13 设计文档 §4.2 DeployStage 阶段编排器
 * - §3.8 DeployStage 接口定义（types.ts）
 * - B-2 修复：填充 healthEndpoints 字段供 DevOpsOrchestrator 构造 HealthCheckResult
 * - M-1 修复：PostDeployChecker 返回 HealthEndpoint 列表
 * - N-M-1 修复：DeployStageOptions 独占 4 个字段（preDeployChecker / postDeployChecker / smokeTestRunner / rollbackManager）
 * - §5.12.4 G-A6d 不可变优先原则
 *
 * 文件位置：packages/core/src/eag/deploy/deploy-stage.ts
 *
 * @module eag/deploy/deploy-stage
 */

import type {
  DeployStage,
  DeployStageOptions,
  DeployStageResult,
  DevOpsContext,
  IaCTemplate,
  DeployStrategy,
  DeployContext,
  DeployResult,
  PreDeployCheckContext,
  PreDeployCheckResult,
  PostDeployCheckContext,
  PostDeployCheckResult,
  HealthEndpoint,
  SmokeTestResult,
  RollbackSnapshotContext,
  RollbackSnapshot,
  RollbackResult,
} from "../devops/types";

// ============================================================================
// DeployStageImpl 类
// ============================================================================

/**
 * DeployStage 实现类
 *
 * 编排 pre-deploy → deploy → post-deploy → smoke-test 四步阶段，
 * 失败时触发 RollbackManager（如果注入）。
 *
 * 与 DevOpsOrchestrator 的关系：
 * - DevOpsOrchestrator 是角色编排器（DevOps 第 6 角色）
 * - DeployStage 是阶段编排器（DEPLOY 子阶段）
 * - DevOpsOrchestrator.run() 内部调用 DeployStage.execute()
 *
 * 使用方式：
 *   const deployStage = new DeployStageImpl({
 *     preDeployChecker: new PreDeployCheckerImpl(),
 *     postDeployChecker: new PostDeployCheckerImpl(),
 *     smokeTestRunner: new SmokeTestRunnerImpl(),
 *     // rollbackManager: new K8sRollbackManager(),  // 批次 14 注入
 *   });
 *   const result = await deployStage.execute(context, iacTemplates, deployStrategy);
 *   if (!result.success) {
 *     // 部署失败，根据 rollbackExecuted 判断是否已回滚
 *   }
 */
export class DeployStageImpl implements DeployStage {
  /**
   * 构造函数
   *
   * @param options DeployStage 选项（含 4 个必填/可选组件）
   * @throws Error 如果 preDeployChecker / postDeployChecker / smokeTestRunner 为空
   *
   * 构造期不变式校验（与既有 Orchestrator 同构）：
   * - preDeployChecker 必填：pre-deploy 检查是部署前必须执行的步骤
   * - postDeployChecker 必填：post-deploy 检查是部署后必须执行的步骤
   * - smokeTestRunner 必填：smoke-test 是部署后必须执行的验证步骤
   * - rollbackManager 可选：批次 13 仅预留接口，批次 14 注入真实实现
   */
  constructor(private readonly options: DeployStageOptions) {
    // 构造期不变式校验（与既有 Orchestrator 同构）
    if (!options.preDeployChecker) {
      throw new Error("preDeployChecker 必填");
    }
    if (!options.postDeployChecker) {
      throw new Error("postDeployChecker 必填");
    }
    if (!options.smokeTestRunner) {
      throw new Error("smokeTestRunner 必填");
    }
    // rollbackManager 可选，不校验
  }

  /**
   * 执行 DEPLOY 阶段
   *
   * 4 步阶段编排（与 DesignLoop / CodingLoop / TestingLoop 同构的阶段编排器）：
   * 1. pre-deploy 检查：调用 PreDeployChecker.check()，校验镜像/配置/依赖/配额 4 项
   *    - 失败时直接返回（不进入 deploy，不触发回滚，因为尚未部署任何资源）
   * 2. deploy 部署：调用 DeployStrategy.execute()，按策略执行实际部署
   *    - 部署前创建版本快照（如果 rollbackManager 存在）
   *    - 失败时如果 rollbackManager 存在且快照创建成功，调用 rollback() 触发回滚
   * 3. post-deploy 检查：调用 PostDeployChecker.check()，校验 Pod/Service/日志/指标 4 项
   *    - 失败时如果 rollbackManager 存在，调用 rollback() 触发回滚
   *    - 填充 healthEndpoints（从 PostDeployCheckResult.endpoints，B-2 修复）
   * 4. smoke-test 烟雾测试：调用 SmokeTestRunner.run()，按用例发起 HTTP 请求验证端点
   *    - 失败时如果 rollbackManager 存在，调用 rollback() 触发回滚
   *
   * 失败处理策略：
   * - pre-deploy 失败：不触发回滚（尚未部署任何资源）
   * - deploy / post-deploy / smoke-test 失败：如果 rollbackManager 存在且快照创建成功，触发回滚
   * - 回滚仅触发一次（通过 rollbackExecuted 标志位避免重复回滚）
   * - 回滚失败时把回滚错误追加到 errors（不阻塞返回结果）
   *
   * @param context DevOps 编排上下文（提供 projectName / environment / image / smokeTestCases 等）
   * @param iacTemplates IaC 模板列表（来自 DevOpsOrchestrator 生成的模板）
   * @param deployStrategy 部署策略（来自 DevOpsOrchestratorOptions）
   * @returns DeployStageResult，被 Object.freeze 冻结
   */
  async execute(
    context: DevOpsContext,
    iacTemplates: ReadonlyArray<IaCTemplate>,
    deployStrategy: DeployStrategy
  ): Promise<DeployStageResult> {
    // 累积错误信息（各阶段失败时收集）
    const errors: string[] = [];
    // 阶段状态标记
    let preDeployPassed = false;
    let deployResult: DeployResult | undefined;
    let postDeployPassed = false;
    let smokeTestResult: SmokeTestResult | undefined;
    // B-2 修复：健康端点列表（从 PostDeployCheckResult.endpoints 填充）
    let healthEndpoints: ReadonlyArray<HealthEndpoint> = [];
    // 回滚状态标记
    let rollbackExecuted = false;
    let rollbackResult: RollbackResult | undefined;
    // 版本快照（部署前创建，回滚时使用）
    let snapshot: RollbackSnapshot | undefined;

    // ---------- Step 1: pre-deploy 检查 ----------
    // 构造 PreDeployCheckContext（从 DevOpsContext 中提取字段）
    const preDeployContext: PreDeployCheckContext = {
      projectName: context.deployContext.projectName,
      environment: context.deployContext.environment,
      image: context.iacGenerationContext.image, // 镜像来源（与 IaC 生成器一致）
      iacTemplates,
    };
    const preDeployResult: PreDeployCheckResult = await this.options.preDeployChecker.check(preDeployContext);
    preDeployPassed = preDeployResult.passed;
    if (!preDeployPassed) {
      // pre-deploy 失败：尚未部署任何资源，不触发回滚，直接返回
      errors.push(...preDeployResult.failures);
      return this.buildResult(
        false,
        preDeployPassed,
        deployResult,
        postDeployPassed,
        smokeTestResult,
        healthEndpoints,
        rollbackExecuted,
        rollbackResult,
        errors
      );
    }

    // ---------- Step 2: deploy 部署 ----------
    // 构造 DeployContext（注入 iacTemplates / strategyType / timeoutMs）
    const deployContext: DeployContext = {
      runId: context.deployContext.runId,
      projectName: context.deployContext.projectName,
      environment: context.deployContext.environment,
      iacTemplates,
      strategyType: deployStrategy.strategyType,
      timeoutMs: context.deployContext.timeoutMs,
    };

    // 部署前创建版本快照（如果 rollbackManager 存在）
    if (this.options.rollbackManager) {
      try {
        const snapshotContext: RollbackSnapshotContext = {
          projectName: context.deployContext.projectName,
          namespace: context.deployContext.projectName, // 批次 13 namespace 与 projectName 一致
        };
        snapshot = await this.options.rollbackManager.createSnapshot(snapshotContext);
      } catch (err) {
        // 快照创建失败不阻塞部署，但记录错误（批次 14 实现完整重试逻辑）
        errors.push(`版本快照创建失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      deployResult = await deployStrategy.execute(deployContext);
      if (!deployResult.success) {
        errors.push(...deployResult.errors);
        // deploy 失败：触发回滚（如果 rollbackManager 存在且快照创建成功）
        if (this.options.rollbackManager && snapshot) {
          const rbResult = await this.options.rollbackManager.rollback(snapshot);
          rollbackExecuted = true;
          rollbackResult = rbResult;
          if (!rbResult.success) {
            errors.push(`回滚失败：${rbResult.errors.join("；")}`);
          }
        }
        return this.buildResult(
          false,
          preDeployPassed,
          deployResult,
          postDeployPassed,
          smokeTestResult,
          healthEndpoints,
          rollbackExecuted,
          rollbackResult,
          errors
        );
      }
    } catch (err) {
      // deploy 抛异常：触发回滚（如果 rollbackManager 存在且快照创建成功）
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`部署执行异常：${errMsg}`);
      if (this.options.rollbackManager && snapshot) {
        try {
          const rbResult = await this.options.rollbackManager.rollback(snapshot);
          rollbackExecuted = true;
          rollbackResult = rbResult;
          if (!rbResult.success) {
            errors.push(`回滚失败：${rbResult.errors.join("；")}`);
          }
        } catch (rbErr) {
          errors.push(`回滚执行异常：${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
        }
      }
      return this.buildResult(
        false,
        preDeployPassed,
        deployResult,
        postDeployPassed,
        smokeTestResult,
        healthEndpoints,
        rollbackExecuted,
        rollbackResult,
        errors
      );
    }

    // ---------- Step 3: post-deploy 检查 ----------
    // 从 deployResult.resources 中提取 namespace / serviceName（取第一个 Deployment + Service）
    const deployment = deployResult.resources.find((r) => r.kind === "Deployment");
    const service = deployResult.resources.find((r) => r.kind === "Service");
    const namespace = deployment?.namespace ?? context.deployContext.projectName;
    const serviceName = service?.name ?? context.deployContext.projectName;

    const postDeployContext: PostDeployCheckContext = {
      namespace,
      serviceName,
      deployedResources: deployResult.resources,
    };

    let postDeployResult: PostDeployCheckResult;
    try {
      postDeployResult = await this.options.postDeployChecker.check(postDeployContext);
    } catch (err) {
      // post-deploy 抛异常：触发回滚
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`部署后检查异常：${errMsg}`);
      if (this.options.rollbackManager && snapshot) {
        try {
          const rbResult = await this.options.rollbackManager.rollback(snapshot);
          rollbackExecuted = true;
          rollbackResult = rbResult;
          if (!rbResult.success) {
            errors.push(`回滚失败：${rbResult.errors.join("；")}`);
          }
        } catch (rbErr) {
          errors.push(`回滚执行异常：${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
        }
      }
      return this.buildResult(
        false,
        preDeployPassed,
        deployResult,
        false,
        smokeTestResult,
        healthEndpoints,
        rollbackExecuted,
        rollbackResult,
        errors
      );
    }

    postDeployPassed = postDeployResult.passed;
    // M-1 修复 + B-2 修复：从 PostDeployCheckResult.endpoints 填充 healthEndpoints
    healthEndpoints = postDeployResult.endpoints;

    if (!postDeployPassed) {
      errors.push(...postDeployResult.failures);
      // post-deploy 失败：触发回滚（如果 rollbackManager 存在且快照创建成功）
      if (this.options.rollbackManager && snapshot) {
        const rbResult = await this.options.rollbackManager.rollback(snapshot);
        rollbackExecuted = true;
        rollbackResult = rbResult;
        if (!rbResult.success) {
          errors.push(`回滚失败：${rbResult.errors.join("；")}`);
        }
      }
      return this.buildResult(
        false,
        preDeployPassed,
        deployResult,
        postDeployPassed,
        smokeTestResult,
        healthEndpoints,
        rollbackExecuted,
        rollbackResult,
        errors
      );
    }

    // ---------- Step 4: smoke-test 烟雾测试 ----------
    // 构造烟雾测试端点列表（从 healthEndpoints 中提取健康端点 URL）
    const healthyEndpoints = healthEndpoints.filter((e) => e.healthy).map((e) => e.url);

    try {
      smokeTestResult = await this.options.smokeTestRunner.run(healthyEndpoints, context.smokeTestCases);
      if (!smokeTestResult.passed) {
        errors.push(`烟雾测试未通过（${smokeTestResult.failedTests}/${smokeTestResult.totalTests} 失败）`);
        // smoke-test 失败：触发回滚（如果 rollbackManager 存在且快照创建成功）
        if (this.options.rollbackManager && snapshot) {
          const rbResult = await this.options.rollbackManager.rollback(snapshot);
          rollbackExecuted = true;
          rollbackResult = rbResult;
          if (!rbResult.success) {
            errors.push(`回滚失败：${rbResult.errors.join("；")}`);
          }
        }
        return this.buildResult(
          false,
          preDeployPassed,
          deployResult,
          postDeployPassed,
          smokeTestResult,
          healthEndpoints,
          rollbackExecuted,
          rollbackResult,
          errors
        );
      }
    } catch (err) {
      // smoke-test 抛异常：触发回滚
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`烟雾测试执行异常：${errMsg}`);
      if (this.options.rollbackManager && snapshot) {
        try {
          const rbResult = await this.options.rollbackManager.rollback(snapshot);
          rollbackExecuted = true;
          rollbackResult = rbResult;
          if (!rbResult.success) {
            errors.push(`回滚失败：${rbResult.errors.join("；")}`);
          }
        } catch (rbErr) {
          errors.push(`回滚执行异常：${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
        }
      }
      return this.buildResult(
        false,
        preDeployPassed,
        deployResult,
        postDeployPassed,
        smokeTestResult,
        healthEndpoints,
        rollbackExecuted,
        rollbackResult,
        errors
      );
    }

    // ---------- 4 步全部成功 ----------
    return this.buildResult(
      true,
      preDeployPassed,
      deployResult,
      postDeployPassed,
      smokeTestResult,
      healthEndpoints,
      rollbackExecuted,
      rollbackResult,
      errors
    );
  }

  /**
   * 构建 DeployStageResult（统一构造 + Object.freeze）
   *
   * 不可变优先（§5.12.4 G-A6d）：
   * - result 对象通过 Object.freeze 冻结
   * - healthEndpoints 数组通过 Object.freeze 冻结（创建新数组避免修改原数组）
   * - errors 数组通过 Object.freeze 冻结
   *
   * @param success 4 步是否全部成功
   * @param preDeployPassed pre-deploy 是否通过
   * @param deployResult 部署结果（可选）
   * @param postDeployPassed post-deploy 是否通过
   * @param smokeTestResult 烟雾测试结果（可选）
   * @param healthEndpoints 健康端点列表
   * @param rollbackExecuted 是否触发回滚
   * @param rollbackResult 回滚结果（可选）
   * @param errors 错误列表
   * @returns DeployStageResult，被 Object.freeze 冻结
   */
  private buildResult(
    success: boolean,
    preDeployPassed: boolean,
    deployResult: DeployResult | undefined,
    postDeployPassed: boolean,
    smokeTestResult: SmokeTestResult | undefined,
    healthEndpoints: ReadonlyArray<HealthEndpoint>,
    rollbackExecuted: boolean,
    rollbackResult: RollbackResult | undefined,
    errors: string[]
  ): DeployStageResult {
    const result: DeployStageResult = {
      success,
      preDeployPassed,
      deployResult,
      postDeployPassed,
      smokeTestResult,
      // 创建新数组避免修改原数组，然后冻结
      healthEndpoints: Object.freeze([...healthEndpoints]) as ReadonlyArray<HealthEndpoint>,
      rollbackExecuted,
      rollbackResult,
      errors: Object.freeze(errors) as ReadonlyArray<string>,
    };
    return Object.freeze(result) as DeployStageResult;
  }
}
