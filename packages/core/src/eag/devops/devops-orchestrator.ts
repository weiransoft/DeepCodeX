/**
 * DevOpsOrchestrator —— DevOps 第 6 角色编排器实现（EAG-P4 批次 13 Phase 6 D1-1）
 *
 * 核心职责（B-4 修复后明确边界）：
 * - 生成 IaC 模板（并行调用多个 IaC 生成器，M-5 修复）
 * - 校验 IaC 模板（并行调用真实 CLI 工具，Promise.all）
 * - 委托 DeployStage.execute() 执行 pre-deploy → deploy → post-deploy → smoke-test 四步阶段
 * - 调用 GateG8Checker 校验部署就绪状态（IaC 完整 + 健康就绪 + 烟雾通过 + 监控就位 + 回滚预案存在）
 * - 发射 DevOps 生命周期事件（devops-started / iac-generated / smoke-test-passed / devops-completed / devops-failed）
 *
 * 5 步编排（按设计文档 §3.4 L774~L930）：
 * 1. 发射 devops-started 事件
 * 2. 生成 IaC 模板（并行 Promise.all 调用多个生成器）+ 发射 iac-generated 事件
 * 3. 校验 IaC 模板（并行 Promise.all）
 * 4. 委托 deployStage.execute() 执行 4 步阶段
 *    - 失败时：N-M-4 修复（从 deployStageResult.healthEndpoints 构造 healthCheckResult）+ throw Error 触发 catch
 *    - 成功时：构造 healthCheckResult（M-1/M-2 修复，从 deployStageResult.healthEndpoints 填充）+ 发射 smoke-test-passed 事件
 * 5. G-8 门禁校验 + 发射 devops-completed 事件
 * - 返回 Object.freeze 冻结的 DevOpsResult
 *
 * 设计原则（与既有 orchestrator 同构）：
 * - 与 DesignOrchestrator / CodingOrchestrator / TestingOrchestrator 同构
 * - 构造函数注入 options，必填字段无默认值
 * - run() 方法返回 DevOpsResult，被 Object.freeze 冻结
 * - 所有阶段失败时发射 devops-failed 事件并提前返回
 *
 * 不可变优先（§5.12.4 G-A6d）：
 * - 所有返回的 DevOpsResult 通过 Object.freeze 冻结
 * - errors 数组通过 Object.freeze 冻结
 * - iacTemplates 数组中每个模板通过 Object.freeze 冻结
 *
 * 修复说明：
 * - B-4 修复：DevOpsOrchestrator 与 DeployStage 职责边界明确
 *   - DevOpsOrchestrator：角色编排器（IaC 生成 + 校验 + 委托 + G-8 门禁 + 事件发射）
 *   - DeployStage：阶段编排器（4 步阶段 + 失败时触发 RollbackManager）
 * - N-M-1 修复：DevOpsOrchestratorOptions 仅保留 DevOpsOrchestrator 自身使用的字段
 *   PreDeployChecker / PostDeployChecker / SmokeTestRunner / RollbackManager 由 DeployStageOptions 持有
 * - N-M-4 修复：失败时仍从 deployStageResult.healthEndpoints 构造 healthCheckResult
 * - M-1/M-2 修复：healthCheckResult.endpoints 从 deployStageResult.healthEndpoints 填充
 * - M-5 修复：IaC 生成器并行调用（Promise.all）
 * - M-10 修复：duration 直接用毫秒相减，避免 ISO 字符串 parse 误差
 *
 * 文件位置：packages/core/src/eag/devops/devops-orchestrator.ts
 *
 * @module eag/devops/devops-orchestrator
 */

import type {
  DevOpsOrchestratorOptions,
  DevOpsContext,
  DevOpsResult,
  IaCTemplate,
  DeployResult,
  HealthCheckResult,
  SmokeTestResult,
  DevOpsEvent,
} from "./types";
import type { GateResult } from "../gate/gate-types";

// ============================================================================
// DevOpsOrchestrator 类
// ============================================================================

/**
 * DevOpsOrchestrator —— DevOps 第 6 角色编排器实现
 *
 * 编排 5 步流程（按设计文档 §3.4）：
 * 1. 发射 devops-started 事件
 * 2. 生成 IaC 模板（并行调用多个生成器）
 * 3. 校验 IaC 模板（并行校验）
 * 4. 委托 DeployStage.execute() 执行 4 步阶段（pre-deploy → deploy → post-deploy → smoke-test）
 * 5. 调用 GateG8Checker 校验部署就绪状态，发射 devops-completed 事件
 *
 * 失败处理：任一步骤失败时发射 devops-failed 事件并提前返回
 *
 * 使用方式：
 *   const orchestrator = new DevOpsOrchestrator({
 *     iacGenerators: [new TerraformGenerator(), new K8sManifestGenerator()],
 *     gateG8Checker: new GateG8CheckerImpl(),
 *     deployStrategy: new RollingStrategy(),
 *     deployStage: new DeployStageImpl({ ... }),
 *     eventEmitter: new SomeEventEmitter(),
 *   });
 *   const result = await orchestrator.run(devOpsContext);
 *   if (!result.success) {
 *     // 检查 result.errors 与 result.gateResult
 *   }
 */
export class DevOpsOrchestrator {
  /** 编排器选项（构造时注入，不可变） */
  private readonly options: DevOpsOrchestratorOptions;

  /**
   * 构造函数 —— 注入 DevOps 编排所需全部依赖
   *
   * 构造期不变式校验（与既有 Orchestrator 同构）：
   * - iacGenerators 不能为空数组（至少需要 1 个 IaC 生成器）
   * - gateG8Checker 必填：G-8 门禁是 DevOps 编排的最终验证步骤
   * - deployStrategy 必填：部署策略是 DeployStage 的入参
   * - deployStage 必填：DevOpsOrchestrator 委托 4 步阶段给 DeployStage
   * - eventEmitter 可选：未注入时不发射事件（no-op）
   *
   * @param options 编排器选项
   * @throws Error 当 options.iacGenerators 为空数组或 undefined 时抛错
   * @throws Error 当 options.gateG8Checker 为空时抛错
   * @throws Error 当 options.deployStrategy 为空时抛错
   * @throws Error 当 options.deployStage 为空时抛错
   */
  constructor(options: DevOpsOrchestratorOptions) {
    // 构造期不变式校验（与 TestingOrchestrator 同构）
    // iacGenerators 为空数组或 undefined 时抛错（至少需要 1 个 IaC 生成器）
    if (!options.iacGenerators || options.iacGenerators.length === 0) {
      throw new Error("iacGenerators 不能为空（至少需要 1 个 IaC 生成器）");
    }
    // gateG8Checker 必填：G-8 门禁是 DevOps 编排的最终验证步骤
    if (!options.gateG8Checker) {
      throw new Error("gateG8Checker 必填");
    }
    // deployStrategy 必填：部署策略是 DeployStage 的入参
    if (!options.deployStrategy) {
      throw new Error("deployStrategy 必填");
    }
    // deployStage 必填：DevOpsOrchestrator 委托 4 步阶段给 DeployStage
    if (!options.deployStage) {
      throw new Error("deployStage 必填（DevOpsOrchestrator 委托 4 步阶段给 DeployStage）");
    }
    // eventEmitter 可选，不校验

    this.options = options;
  }

  /**
   * 执行 DevOps 编排
   *
   * 编排流程（B-4 修复后简化为 5 步，原 Step 3~7 委托给 DeployStage）：
   * 1. 发射 devops-started 事件
   * 2. 生成 IaC 模板（M-5 修复：并行调用多个生成器，Promise.all）
   * 3. 校验 IaC 模板（并行校验，Promise.all）
   * 4. 委托 DeployStage.execute() 执行 4 步阶段（pre-deploy → deploy → post-deploy → smoke-test）
   *    - 失败时：N-M-4 修复（从 deployStageResult.healthEndpoints 构造 healthCheckResult）+ throw 触发 catch
   *    - 成功时：构造 healthCheckResult（M-1/M-2 修复，从 deployStageResult.healthEndpoints 填充）+ 发射 smoke-test-passed 事件
   * 5. G-8 门禁校验 + 发射 devops-completed 事件
   *
   * 失败处理：
   * - 任一步骤失败时（通过 throw 触发 catch 块）发射 devops-failed 事件并提前返回
   * - DeployStage 内部失败时如果 rollbackManager 存在，由 DeployStage 触发回滚
   * - 错误信息去重（避免重复）
   * - duration 用毫秒相减（M-10 修复，避免 ISO 字符串 parse 误差）
   * - gateResult 如未执行则使用默认失败结果（gate="G-8", passed=false, severity="blocker"）
   *
   * 不可变优先：
   * - 返回的 DevOpsResult 通过 Object.freeze 冻结
   * - errors 数组通过 Object.freeze 冻结
   *
   * @param context DevOps 编排上下文
   * @returns DevOpsResult，被 Object.freeze 冻结
   */
  async run(context: DevOpsContext): Promise<DevOpsResult> {
    // M-10 修复：记录毫秒时间戳，避免 ISO 字符串 parse 误差
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    // runId 从 deployContext 获取（DeployContext.runId 是 DevOps 编排运行的唯一 ID）
    const runId = context.deployContext.runId;

    // ---------- Step 1: 发射 devops-started 事件 ----------
    this.emitEvent({ type: "devops-started", runId, timestamp: startedAt });

    // 累积错误信息（各步骤失败时收集，最终在 DevOpsResult.errors 中返回）
    const errors: string[] = [];
    // IaC 模板列表（Step 2 生成后填充）
    let iacTemplates: IaCTemplate[] = [];
    // 部署结果（Step 4 成功后从 deployStageResult.deployResult 填充）
    let deployResult: DeployResult | undefined;
    // 健康检查结果（Step 4 后从 deployStageResult.healthEndpoints 构造）
    let healthCheckResult: HealthCheckResult | undefined;
    // 烟雾测试结果（Step 4 成功后从 deployStageResult.smokeTestResult 填充）
    let smokeTestResult: SmokeTestResult | undefined;
    // G-8 门禁结果（Step 5 填充，失败时使用默认失败结果）
    let gateResult: GateResult | undefined;

    try {
      // ---------- Step 2: 生成 IaC 模板（M-5 修复：并行调用多个生成器） ----------
      iacTemplates = await this.generateIaCTemplates(context);
      // 发射 iac-generated 事件（携带本次生成的所有 IaC 模板）
      this.emitEvent({
        type: "iac-generated",
        runId,
        templates: iacTemplates,
        timestamp: new Date().toISOString(),
      });

      // ---------- Step 3: 校验 IaC 模板（并行校验） ----------
      // 任一模板校验失败时抛错，进入 catch 块
      await this.validateIaCTemplates(iacTemplates);

      // ---------- Step 4: 委托 DeployStage.execute() 执行 4 步阶段 ----------
      // B-4 修复：不再直接实现 pre-deploy → deploy → post-deploy → smoke-test
      // 委托给 DeployStage，由 DeployStage 内部编排 4 步并在失败时触发 RollbackManager
      const deployStageResult = await this.options.deployStage.execute(
        context,
        iacTemplates,
        this.options.deployStrategy
      );

      // 4.1 DeployStage 失败处理
      if (!deployStageResult.success) {
        // 收集 DeployStage 错误（含 RollbackManager 调用结果）
        errors.push(...deployStageResult.errors);
        // 提取已采集的部署结果（即使失败也可能有部分部署结果）
        if (deployStageResult.deployResult) {
          deployResult = deployStageResult.deployResult;
        }
        // 提取已采集的烟雾测试结果（可能在 smoke-test 阶段失败时有值）
        if (deployStageResult.smokeTestResult) {
          smokeTestResult = deployStageResult.smokeTestResult;
        }
        // N-M-4 修复：失败时仍从 deployStageResult.healthEndpoints 构造 healthCheckResult
        // 当 DeployStage 在 smoke-test 阶段失败时，post-deploy 已执行成功，healthEndpoints 已有值
        // 不应丢失这些已采集的健康端点信息，便于用户定位失败时的健康端点状态
        if (deployStageResult.healthEndpoints && deployStageResult.healthEndpoints.length > 0) {
          healthCheckResult = {
            healthy: false, // 失败场景下标记为不健康
            checkedAt: new Date().toISOString(),
            endpoints: deployStageResult.healthEndpoints,
            failures: deployStageResult.errors,
          };
        }
        // 抛出错误以触发 catch 块的统一失败处理（发射 devops-failed 事件）
        throw new Error(`DeployStage 执行失败：${deployStageResult.errors.join("；")}`);
      }

      // 4.2 DeployStage 成功，提取结果
      // 注意：deployStageResult.deployResult / smokeTestResult 在 success=true 时应有值，
      // 但接口声明为可选（DeployStageResult.deployResult?: DeployResult），
      // 此处使用条件赋值保持类型安全
      if (deployStageResult.deployResult) {
        deployResult = deployStageResult.deployResult;
      }
      if (deployStageResult.smokeTestResult) {
        smokeTestResult = deployStageResult.smokeTestResult;
      }

      // M-1/M-2 修复：健康检查结果从 deployStageResult.healthEndpoints 填充
      // DeployStage 内部调用 PostDeployChecker，PostDeployCheckResult.endpoints 已填充
      // 此处从 deployStageResult.healthEndpoints 提取并构造 HealthCheckResult
      healthCheckResult = {
        healthy: deployStageResult.postDeployPassed,
        checkedAt: new Date().toISOString(),
        endpoints: deployStageResult.healthEndpoints,
        failures: deployStageResult.errors,
      };

      // 发射 smoke-test-passed 事件（4 步阶段全部成功，含 smoke-test 通过）
      // 注意：smokeTestResult 此处应有值，但为类型安全使用条件发射
      if (smokeTestResult) {
        this.emitEvent({
          type: "smoke-test-passed",
          runId,
          result: smokeTestResult,
          timestamp: new Date().toISOString(),
        });
      }

      // ---------- Step 5: G-8 门禁校验 ----------
      // M-8 修复：monitoringReady / rollbackPlanExists 从 context 传入，默认 true
      // 批次 13 暂固定为 true，批次 14 实现完整检查（Prometheus scrape / RollbackPlan 文件存在性）
      // 构造 GateG8Context：spread context 提供 GateContext 字段（projectId / specStatus 等），
      // 覆盖 loopType 为 "deploy"（GateG8Context 要求固定值），扩展 G-8 特有字段
      gateResult = this.options.gateG8Checker.check({
        ...context,
        loopType: "deploy",
        iacTemplates,
        deployResult: deployResult as DeployResult,
        healthCheckResult: healthCheckResult as HealthCheckResult,
        smokeTestResult: smokeTestResult as SmokeTestResult,
        monitoringReady: context.monitoringReady ?? true, // 默认 true，批次 14 实现完整检查
        rollbackPlanExists: context.rollbackPlanExists ?? true, // 默认 true，批次 14 实现完整检查
      });

      // G-8 门禁未通过时收集错误（不抛错，继续构造结果，由 success 字段反映失败）
      if (!gateResult.passed) {
        errors.push(`G-8 门禁未通过：${gateResult.reason}`);
      }

      // ---------- 完成：构造 DevOpsResult + 发射 devops-completed 事件 ----------
      const finishedAtMs = Date.now();
      const finishedAt = new Date(finishedAtMs).toISOString();
      const result: DevOpsResult = {
        // success 当且仅当 G-8 门禁通过且无累积错误
        success: gateResult.passed && errors.length === 0,
        runId,
        startedAt,
        finishedAt,
        duration: finishedAtMs - startedAtMs, // M-10 修复：直接用毫秒相减
        iacTemplates,
        deployResult,
        healthCheckResult,
        smokeTestResult,
        gateResult,
        errors: Object.freeze(errors) as ReadonlyArray<string>,
      };

      // 发射 devops-completed 事件（携带完整 DevOpsResult）
      this.emitEvent({
        type: "devops-completed",
        runId,
        result,
        timestamp: finishedAt,
      });

      // 不可变优先：返回冻结的 DevOpsResult
      return Object.freeze(result) as DevOpsResult;
    } catch (error) {
      // ---------- 失败处理：发射 devops-failed 事件 ----------
      const errorMessage = error instanceof Error ? error.message : String(error);
      // 错误信息去重（避免 DeployStage 失败时 errors 已含相同信息又被 catch 重复添加）
      if (!errors.includes(errorMessage)) {
        errors.push(errorMessage);
      }

      // 发射 devops-failed 事件（携带错误信息）
      this.emitEvent({
        type: "devops-failed",
        runId,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      });

      // 构造 failedResult
      const failedFinishedAtMs = Date.now();
      const failedResult: DevOpsResult = {
        success: false,
        runId,
        startedAt,
        finishedAt: new Date(failedFinishedAtMs).toISOString(),
        duration: failedFinishedAtMs - startedAtMs, // M-10 修复：直接用毫秒相减
        iacTemplates,
        deployResult,
        healthCheckResult,
        smokeTestResult,
        // gateResult 如未执行（Step 5 之前失败）则使用默认失败结果
        gateResult: gateResult ?? {
          gate: "G-8",
          passed: false,
          reason: errorMessage,
          guidance: "请检查 errors 字段中的具体失败原因，修复后重试",
          severity: "blocker",
        },
        errors: Object.freeze(errors) as ReadonlyArray<string>,
      };

      // 不可变优先：返回冻结的 failedResult
      return Object.freeze(failedResult) as DevOpsResult;
    }
  }

  /**
   * 生成 IaC 模板（M-5 修复：并行调用多个生成器）
   *
   * 实现细节：
   * - 使用 Promise.all 并行调用所有生成器的 generate() 方法
   * - 每个生成器可能产出多个 IaC 模板（如 Helm Chart 含 Chart.yaml + values.yaml + templates/*.yaml）
   * - 展平二维数组为一维数组（templatesPerGenerator.flat()）
   * - 对每个模板 Object.freeze，保持不可变优先
   *
   * 注意：generate() 是同步方法（返回 IaCTemplate[]），但通过 async 包装为 Promise
   * 以便未来扩展为异步生成器（如从远程拉取模板）
   *
   * @param context DevOps 编排上下文
   * @returns IaC 模板数组（已展平 + 每个模板已冻结）
   */
  private async generateIaCTemplates(context: DevOpsContext): Promise<IaCTemplate[]> {
    // M-5 修复：使用 Promise.all 并行调用所有生成器
    // 注意：generate() 同步返回 IaCTemplate[]，但通过 async lambda 包装为 Promise
    const generatePromises = this.options.iacGenerators.map(async (generator) => {
      return generator.generate(context.iacGenerationContext);
    });
    const templatesPerGenerator = await Promise.all(generatePromises);
    // 展平二维数组为一维数组（每个生成器返回 IaCTemplate[]，组合后是 IaCTemplate[][]）
    const allTemplates = templatesPerGenerator.flat();
    // 对每个模板进行 Object.freeze，保持不可变优先
    return allTemplates.map((t) => Object.freeze(t) as IaCTemplate);
  }

  /**
   * 校验 IaC 模板（并行校验）
   *
   * 实现细节：
   * - 使用 Promise.all 并行校验所有模板
   * - 通过 template.type 找到对应的生成器（iacGenerators.find(g => g.iacType === template.type)）
   * - 找不到生成器时抛错（防御性检查）
   * - result.valid === false 时抛错（含完整错误信息）
   *
   * 校验工具（对齐 P-5 测试不使用 mock）：
   * - terraform-validate：调用 `terraform validate` 命令
   * - kubectl-dry-run：调用 `kubectl apply --dry-run=client -f` 命令
   * - helm-lint：调用 `helm lint` 命令
   *
   * @param templates IaC 模板数组
   * @throws Error 当未找到 IaC 类型对应的生成器时抛错
   * @throws Error 当任一模板校验失败（valid=false）时抛错
   */
  private async validateIaCTemplates(templates: IaCTemplate[]): Promise<void> {
    // 为每个模板构造校验 Promise
    const validationPromises = templates.map(async (template) => {
      // 通过 template.type 找到对应的生成器
      const generator = this.options.iacGenerators.find((g) => g.iacType === template.type);
      // 找不到生成器时抛错（防御性检查，避免类型断言绕过）
      if (!generator) {
        throw new Error(`未找到 IaC 类型 ${template.type} 对应的生成器`);
      }
      // 调用生成器的 validate() 方法（调用真实 CLI 工具）
      const result = await generator.validate(template);
      // 校验失败时抛错（含完整错误信息）
      if (!result.valid) {
        throw new Error(`IaC 模板 ${template.filePath} 校验失败：${result.errors.join("；")}`);
      }
    });

    // 并行执行所有校验（任一失败立即 reject）
    await Promise.all(validationPromises);
  }

  /**
   * 发射 DevOps 事件
   *
   * 实现细节：
   * - 如果 this.options.eventEmitter 存在则调用 emit(event)
   * - 不存在则忽略（no-op），不影响主流程
   *
   * 事件类型（9 种，对齐 DevOpsEvent 联合类型）：
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
   * @param event DevOps 事件
   */
  private emitEvent(event: DevOpsEvent): void {
    // eventEmitter 可选，未注入时不发射事件（no-op）
    if (this.options.eventEmitter) {
      this.options.eventEmitter.emit(event);
    }
  }
}
