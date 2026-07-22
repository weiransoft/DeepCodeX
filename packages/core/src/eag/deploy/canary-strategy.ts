/**
 * CanaryStrategy —— 金丝雀发布策略实现（EAG-P4 批次 14 Phase 2 TASK-14-2-3，FR-6，K-2 决策）
 *
 * 核心职责：
 * - 实现金丝雀发布策略：部署 Canary Deployment → 按流量阶梯放量 → 健康检查 → 提升 Canary 为 Stable
 * - 真实调用 kubectl CLI（通过 child_process.spawn，禁止 shell:true 避免命令注入）
 * - 与 RollingStrategy / BlueGreenStrategy 同构（构造函数注入 + execute() 签名 + DeployResult 返回值）
 *
 * 真实 kubectl 调用流程（§4.1.8，K-2 决策）：
 * 1. 将 IaC 模板内容写入临时文件（Deployment 名称替换为 -canary 后缀，添加 track: canary label）
 * 2. kubectl apply -f <临时文件>（部署 Canary Deployment，副本数初始为 0，逐步放量）
 * 3. 按流量阶梯循环（canarySteps 数组）：
 *    a. 计算 Canary 副本数 = Math.ceil(totalReplicas * step / 100)
 *    b. kubectl scale deployment/<name>-canary -n <ns> --replicas=<N>（调整 Canary 副本数）
 *    c. kubectl rollout status deployment/<name>-canary -n <ns> --timeout=<healthCheckTimeoutMs>ms（等待 Canary Pod Ready）
 *    d. HTTP GET http://<service>.<ns>.svc.cluster.local:<port><healthCheckPath>（健康检查，期望 200）
 *    e. 失败时立即返回 success=false（保留已部署 Canary 资源，R-14-1 缓解 A-1）
 * 4. 全部阶梯通过后：
 *    a. kubectl delete deployment/<originalName> -n <ns>（删除 Stable Deployment）
 *    b. Canary Deployment 保留，承接全部流量（Service selector 通过共享 label 匹配 Canary Pod）
 * 5. kubectl get deployment,service -n <ns> -o json（获取已部署资源列表）
 *
 * 失败恢复策略（R-14-1 缓解 A-1，错误内化，不抛异常）：
 * - Canary Pod 未 Ready：返回 success=false，保留 Canary 资源（便于排查）
 * - 健康检查失败（HTTP 非 200 / 超时）：返回 success=false，保留 Canary 资源
 * - kubectl apply 失败（YAML 不合法）：返回 success=false，未部署任何 Canary 资源
 * - Stable 删除失败（best-effort）：仅记录警告，不影响部署成功状态（Canary 已承接流量）
 *
 * 不可变优先（§5.12.4 G-A6d）：
 * - execute() 返回的 DeployResult 对象通过 Object.freeze 冻结
 * - resources 数组通过 Object.freeze 冻结
 * - errors 数组通过 Object.freeze 冻结
 * - DeployedResource 对象通过 Object.freeze 冻结
 * - 构造函数 Object.freeze 冻结实例
 * - canarySteps 数组通过 Object.freeze 冻结（防止运行时篡改阶梯）
 *
 * 安全原则：
 * - 所有 kubectl 参数通过数组传递给 spawn，不使用 shell:true，避免命令注入
 * - 临时文件权限 0o600（仅 owner 可读写），临时目录权限 0o700
 * - 临时文件在 finally 块中清理
 *
 * 构造期校验（K-2 决策）：
 * - canarySteps 数组非空（length >= 1）
 * - 每个元素为正整数（Number.isInteger + value > 0）
 * - 每个元素范围 0~100（value <= 100）
 * - 最后一个元素必须为 100（最终全量切流）
 * - 不满足时抛错（不允许默认值兜底，避免运行时静默错误）
 *
 * 设计依据：
 * - EAG-P4 批次 14 架构师审查 §4.1.8 CanaryStrategy 类契约（FR-6）
 * - K-2 决策：kubectl patch 副本数方案（不引入 Istio）
 * - §R-14-1 风险缓解 A-1：失败时保留 Canary 资源
 * - §5.12.4 G-A6d 不可变优先原则
 *
 * 文件位置：packages/core/src/eag/deploy/canary-strategy.ts
 *
 * @module eag/deploy/canary-strategy
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import http from "node:http";
import https from "node:https";
import type {
  DeployStrategy,
  DeployContext,
  DeployResult,
  DeployedResource,
  IaCTemplate,
  CanaryStrategyOptions,
} from "../devops/types";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 默认部署命令超时时间（毫秒）
 *
 * 取值理由：
 * - 5 分钟覆盖 Canary Deployment rollout 时间（含镜像拉取 + Pod 调度 + 健康检查）
 * - 与 RollingStrategy / BlueGreenStrategy 默认超时一致（保持同构）
 */
const DEFAULT_TIMEOUT_MS = 300000;

/**
 * 默认单阶梯健康检查超时时间（毫秒）
 *
 * 取值理由：
 * - 60 秒覆盖单个流量阶梯的 rollout + HTTP 健康检查
 * - 短于 DEFAULT_TIMEOUT_MS，因为单阶梯只需等待增量 Pod Ready
 * - 超过 60 秒未通过视为异常，触发失败返回
 */
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 60000;

/**
 * 默认健康检查端点路径
 *
 * 取值理由：
 * - /healthz 是 Kubernetes 生态约定的健康检查端点
 * - 与 PreDeployChecker / PostDeployChecker 中的健康检查路径一致
 */
const DEFAULT_HEALTH_CHECK_PATH = "/healthz";

/**
 * 临时目录前缀（用于 Canary Deployment manifest 文件存储）
 */
const TMP_DIR_PREFIX = "eag-canary-apply-";

/**
 * 临时文件名（Canary Deployment manifest 文件）
 */
const MANIFEST_FILENAME = "canary-deployment.yaml";

/**
 * Canary Deployment 名称后缀
 *
 * 命名规范：<original-name>-canary
 * 例如：原始 Deployment 名称为 "myapp"，则 Canary Deployment 名称为 "myapp-canary"
 */
const CANARY_SUFFIX = "-canary";

/**
 * 默认 Service 端口（当 IaC 模板中未指定 Service port 时使用）
 *
 * 取值理由：
 * - 80 是 HTTP 服务的默认端口
 * - 与 K8s Service 默认 port 一致
 */
const DEFAULT_SERVICE_PORT = 80;

/**
 * HTTP 健康检查默认超时时间（毫秒）
 *
 * 取值理由：
 * - 5 秒覆盖绝大部分健康端点响应时间
 * - 与 SmokeTestRunnerImpl 默认超时一致
 */
const HTTP_HEALTH_CHECK_TIMEOUT_MS = 5000;

// ============================================================================
// 内部类型定义
// ============================================================================

/**
 * kubectl 命令执行结果（内部使用，不对外导出）
 *
 * 字段说明：
 * - success：命令是否成功（退出码 0）
 * - stdout：标准输出（kubectl JSON 输出或日志）
 * - stderr：标准错误（kubectl 错误信息）
 * - exitCode：退出码（null 表示进程被信号终止或启动失败）
 * - errorMessage：错误信息（spawn error 时填充，如 "kubectl 命令不可用"）
 */
interface KubectlExecutionResult {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly errorMessage: string;
}

/**
 * kubectl get 返回的 JSON 输出结构（与 RollingStrategy / BlueGreenStrategy 共享结构，独立定义避免循环依赖）
 */
interface KubectlResourceList {
  readonly items: ReadonlyArray<{
    readonly kind: string;
    readonly metadata: {
      readonly name: string;
      readonly namespace?: string;
    };
    readonly status?: {
      readonly conditions?: ReadonlyArray<{
        readonly type: string;
        readonly status: string;
      }>;
      readonly phase?: string;
    };
  }>;
}

/**
 * HTTP 健康检查结果（内部使用）
 *
 * 字段说明：
 * - healthy：端点是否健康（HTTP 200）
 * - statusCode：HTTP 响应状态码（请求失败时为 0）
 * - errorMessage：错误信息（healthy=true 时为空字符串）
 */
interface HttpHealthCheckOutcome {
  readonly healthy: boolean;
  readonly statusCode: number;
  readonly errorMessage: string;
}

// ============================================================================
// CanaryStrategy 类
// ============================================================================

/**
 * CanaryStrategy —— 金丝雀发布策略实现
 *
 * 实现 DeployStrategy 接口，strategyType = "canary"。
 *
 * 与 RollingStrategy / BlueGreenStrategy 同构：
 * - 构造函数注入 CanaryStrategyOptions（含 canarySteps / healthCheckTimeoutMs / healthCheckPath）
 * - execute(context: DeployContext): Promise<DeployResult> 签名一致
 * - 返回 DeployResult（含 success / deployedAt / duration / resources / errors）
 *
 * 金丝雀发布流程：
 * 1. 部署 Canary Deployment（独立于 Stable，带 track: canary label）
 * 2. 按流量阶梯循环（canarySteps）：
 *    - 计算 Canary 副本数 = Math.ceil(totalReplicas * step / 100)
 *    - kubectl scale 调整 Canary 副本数
 *    - 等待 Canary Pod Ready（kubectl rollout status）
 *    - HTTP GET /healthz 验证健康状态
 *    - 失败时立即返回 success=false（保留 Canary 资源）
 * 3. 全部阶梯通过后：删除 Stable Deployment，Canary 接管全部流量
 *
 * 使用方式：
 *   const strategy = new CanaryStrategy({
 *     canarySteps: [10, 50, 100],
 *     healthCheckTimeoutMs: 60000,
 *     healthCheckPath: "/healthz",
 *   });
 *   const result = await strategy.execute(deployContext);
 *   if (!result.success) {
 *     // 部署失败，Canary 资源已保留，根据 errors 列表诊断
 *   }
 */
export class CanaryStrategy implements DeployStrategy {
  /** 策略类型标识（固定为 "canary"） */
  public readonly strategyType = "canary" as const;

  /** 流量阶梯数组（百分比，0~100，结尾必须为 100），构造期校验后冻结 */
  public readonly canarySteps: ReadonlyArray<number>;

  /** 单阶梯健康检查超时（毫秒），默认 60000 */
  public readonly healthCheckTimeoutMs: number;

  /** 健康检查端点路径，默认 "/healthz" */
  public readonly healthCheckPath: string;

  /** 部署命令超时（毫秒），默认 300000（5 分钟） */
  public readonly timeoutMs: number;

  /**
   * 构造函数
   *
   * 构造期校验 canarySteps（K-2 决策）：
   * - 数组非空（length >= 1）
   * - 每个元素为正整数（Number.isInteger + value > 0）
   * - 每个元素范围 0~100（value <= 100）
   * - 最后一个元素必须为 100（最终全量切流）
   * - 不满足时抛错（不允许默认值兜底）
   *
   * @param options 配置选项（含 canarySteps / healthCheckTimeoutMs / healthCheckPath / timeoutMs）
   * @throws Error 当 canarySteps 为空数组、包含非正整数、>100、结尾非 100 时抛错
   */
  constructor(options: CanaryStrategyOptions) {
    // 校验 options 非空（canarySteps 为必填字段）
    if (!options || !options.canarySteps) {
      throw new Error("CanaryStrategy 构造失败：canarySteps 为必填字段，未提供 options.canarySteps");
    }

    // 校验 canarySteps 数组非空
    if (options.canarySteps.length === 0) {
      throw new Error("CanaryStrategy 构造失败：canarySteps 不能为空数组");
    }

    // 校验每个元素为正整数且范围 0~100
    for (let i = 0; i < options.canarySteps.length; i++) {
      const step = options.canarySteps[i];
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`CanaryStrategy 构造失败：canarySteps[${i}]=${step} 不是正整数（必须为 1~100 的正整数）`);
      }
      if (step > 100) {
        throw new Error(`CanaryStrategy 构造失败：canarySteps[${i}]=${step} 超过 100（必须为 1~100 的正整数）`);
      }
    }

    // 校验最后一个元素必须为 100（最终全量切流）
    const lastStep = options.canarySteps[options.canarySteps.length - 1];
    if (lastStep !== 100) {
      throw new Error(
        `CanaryStrategy 构造失败：canarySteps 最后一个元素必须为 100（实际为 ${lastStep}），表示最终全量切流`
      );
    }

    // 应用默认值：healthCheckTimeoutMs 默认 60000ms，healthCheckPath 默认 "/healthz"
    this.canarySteps = Object.freeze([...options.canarySteps]) as ReadonlyArray<number>;
    this.healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
    this.healthCheckPath = options.healthCheckPath ?? DEFAULT_HEALTH_CHECK_PATH;
    this.timeoutMs = DEFAULT_TIMEOUT_MS;
    // 冻结实例：防止运行时修改配置（对齐 P-1 不可变优先原则）
    Object.freeze(this);
  }

  /**
   * 执行金丝雀部署
   *
   * 执行流程：
   * 1. 校验 iacTemplates 非空
   * 2. 从 IaC 模板中解析 Deployment 名称与副本数（totalReplicas）
   * 3. 将 IaC 模板内容写入临时文件（Deployment 名称替换为 -canary 后缀，添加 track: canary label）
   * 4. 调用 kubectl apply -f <临时文件>（部署 Canary Deployment）
   * 5. 按流量阶梯循环（canarySteps）：
   *    a. 计算 Canary 副本数 = Math.ceil(totalReplicas * step / 100)
   *    b. kubectl scale deployment/<name>-canary -n <ns> --replicas=<N>
   *    c. kubectl rollout status deployment/<name>-canary -n <ns> --timeout=<healthCheckTimeoutMs>ms
   *    d. HTTP GET http://<service>.<ns>.svc.cluster.local:<port><healthCheckPath>
   *    e. 失败时立即返回 success=false（保留 Canary 资源，R-14-1 缓解 A-1）
   * 6. 全部阶梯通过后：kubectl delete deployment/<originalName> -n <ns>（删除 Stable Deployment）
   * 7. 调用 kubectl get deployment,service -n <ns> -o json（获取已部署资源列表）
   *
   * 错误处理（错误内化，不抛异常）：
   * - Canary Pod 未 Ready：返回 success=false，保留 Canary 资源
   * - 健康检查失败：返回 success=false，保留 Canary 资源
   * - Stable 删除失败：仅记录警告，不影响部署成功状态（best-effort）
   * - 临时文件在 finally 块中清理
   *
   * @param context 部署上下文（含 runId / projectName / iacTemplates / timeoutMs）
   * @returns DeployResult，被 Object.freeze 冻结
   */
  async execute(context: DeployContext): Promise<DeployResult> {
    // 记录开始时间，用于计算部署耗时
    const startedAt = Date.now();
    // 累积错误信息（kubectl 命令失败时收集）
    const errors: string[] = [];

    // ---------- 步骤 1: 校验 iacTemplates 非空 ----------
    if (!context.iacTemplates || context.iacTemplates.length === 0) {
      // IaC 模板为空：返回失败 + 明确错误信息
      errors.push("IaC 模板为空，无法执行 kubectl apply");
      return this.buildResult(false, startedAt, [], errors);
    }

    // ---------- 步骤 2: 从 IaC 模板中解析 Deployment 名称与副本数 ----------
    const originalName = this.extractDeploymentName(context.iacTemplates);
    if (!originalName) {
      // IaC 模板中无 Deployment：金丝雀部署需要 Deployment 资源
      errors.push("IaC 模板中未找到 Deployment 资源，金丝雀部署需要 Deployment");
      return this.buildResult(false, startedAt, [], errors);
    }

    // 解析 Deployment 副本数（用于计算每阶梯的 Canary 副本数）
    const totalReplicas = this.extractReplicasFromManifest(context.iacTemplates);
    if (totalReplicas <= 0) {
      // 副本数无效：返回失败 + 明确错误信息
      errors.push(`IaC 模板中 Deployment 副本数无效（totalReplicas=${totalReplicas}），必须为正整数`);
      return this.buildResult(false, startedAt, [], errors);
    }

    // 解析 Service 端口（用于 HTTP 健康检查 URL 拼接）
    const servicePort = this.extractServicePortFromManifest(context.iacTemplates);

    // 构造 Canary Deployment 名称
    const canaryDeploymentName = `${originalName}${CANARY_SUFFIX}`;
    // namespace 默认使用 projectName（与 RollingStrategy / BlueGreenStrategy 一致）
    const namespace = context.projectName;

    // ---------- 步骤 3: 将 IaC 模板内容写入临时文件 ----------
    // 创建临时目录（mode 0o700 限制权限，避免敏感信息泄露）
    let tmpDir: string | undefined;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_DIR_PREFIX));
    } catch (err) {
      // 临时目录创建失败：返回失败 + 明确错误信息
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`临时目录创建失败：${errMsg}`);
      return this.buildResult(false, startedAt, [], errors);
    }

    // manifest 文件路径
    const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
    // 重写 IaC 模板内容：Deployment 名称替换为 -canary 后缀，添加 track: canary label，副本数初始为 0
    const manifestContent = this.rewriteManifestForCanary(context.iacTemplates, originalName);

    // 写入 manifest 文件（mode 0o600 限制权限）
    try {
      fs.writeFileSync(manifestPath, manifestContent, { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      // manifest 文件写入失败：清理临时目录并返回失败
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`manifest 文件写入失败：${errMsg}`);
      this.cleanupTempDir(tmpDir);
      return this.buildResult(false, startedAt, [], errors);
    }

    try {
      // ---------- 步骤 4: 调用 kubectl apply 部署 Canary Deployment ----------
      const applyResult = await this.runKubectl(["apply", "-f", manifestPath]);

      if (!applyResult.success) {
        // kubectl apply 失败：返回失败，未部署任何 Canary 资源
        const errMsg = this.formatKubectlError("kubectl apply", applyResult);
        errors.push(errMsg);
        return this.buildResult(false, startedAt, [], errors);
      }

      // ---------- 步骤 5: 按流量阶梯循环 ----------
      for (let stepIdx = 0; stepIdx < this.canarySteps.length; stepIdx++) {
        const step = this.canarySteps[stepIdx];
        // 计算 Canary 副本数 = Math.ceil(totalReplicas * step / 100)
        // 使用 Math.ceil 保证至少 1 个副本（step > 0 时）
        const canaryReplicas = Math.ceil((totalReplicas * step) / 100);

        // 5a. kubectl scale 调整 Canary 副本数
        const scaleResult = await this.runKubectl([
          "scale",
          "deployment",
          canaryDeploymentName,
          "-n",
          namespace,
          `--replicas=${canaryReplicas}`,
        ]);

        if (!scaleResult.success) {
          // kubectl scale 失败：返回失败，保留 Canary 资源（R-14-1 缓解 A-1）
          const errMsg = this.formatKubectlError(`kubectl scale (step=${step}%)`, scaleResult);
          errors.push(errMsg);
          return this.buildResult(false, startedAt, [], errors);
        }

        // 5b. kubectl rollout status 等待 Canary Pod Ready
        const timeoutSeconds = Math.ceil(this.healthCheckTimeoutMs / 1000);
        const rolloutResult = await this.runKubectl(
          ["rollout", "status", `deployment/${canaryDeploymentName}`, "-n", namespace, `--timeout=${timeoutSeconds}s`],
          this.healthCheckTimeoutMs
        );

        if (!rolloutResult.success) {
          // Canary Pod 未 Ready：返回失败，保留 Canary 资源（R-14-1 缓解 A-1）
          const errMsg = this.formatKubectlError(`rollout status (step=${step}%)`, rolloutResult);
          if (this.isTimeoutError(rolloutResult)) {
            errors.push(
              `Canary Pod 未 Ready（rollout status 超时 ${this.healthCheckTimeoutMs}ms，step=${step}%）：${errMsg}`
            );
          } else {
            errors.push(`Canary Pod 未 Ready（step=${step}%）：${errMsg}`);
          }
          return this.buildResult(false, startedAt, [], errors);
        }

        // 5c. HTTP GET /healthz 健康检查
        // 拼接健康检查 URL：http://<serviceName>.<namespace>.svc.cluster.local:<port><path>
        const healthCheckUrl = `http://${originalName}.${namespace}.svc.cluster.local:${servicePort}${this.healthCheckPath}`;
        const healthResult = await this.runHttpHealthCheck(healthCheckUrl);

        if (!healthResult.healthy) {
          // 健康检查失败：返回失败，保留 Canary 资源（R-14-1 缓解 A-1）
          errors.push(
            `健康检查失败（step=${step}%, url=${healthCheckUrl}, statusCode=${healthResult.statusCode}）：${healthResult.errorMessage}`
          );
          return this.buildResult(false, startedAt, [], errors);
        }
      }

      // ---------- 步骤 6: 全部阶梯通过，删除 Stable Deployment ----------
      // kubectl delete deployment/<originalName> -n <ns>（best-effort，失败不影响部署成功状态）
      const deleteResult = await this.runKubectl([
        "delete",
        "deployment",
        originalName,
        "-n",
        namespace,
        "--ignore-not-found=true",
      ]);

      if (!deleteResult.success) {
        // Stable 删除失败：仅记录警告，不影响部署成功状态（best-effort）
        // 原因：Canary 已承接全部流量，Stable 残留不影响服务可用性
        const warnMsg = this.formatKubectlError("Stable Deployment 清理", deleteResult);
        errors.push(`Stable Deployment 清理失败（best-effort，不影响部署）：${warnMsg}`);
      }

      // ---------- 步骤 7: 调用 kubectl get 获取已部署资源列表 ----------
      const getResult = await this.runKubectl(["get", "deployment,service", "-n", namespace, "-o", "json"]);

      // 解析 kubectl get 的 JSON 输出，构造 DeployedResource 列表
      const resources = this.parseKubectlResources(getResult, namespace, errors);

      // ---------- 构造成功结果 ----------
      // 即使 kubectl get 失败，只要 apply + 全部阶梯 + 健康检查成功就视为部署成功
      // 因为 Canary 已承接全部流量，部署已生效
      const success = true;
      return this.buildResult(success, startedAt, resources, errors);
    } finally {
      // 清理临时目录（finally 块确保异常路径下也能清理）
      this.cleanupTempDir(tmpDir);
    }
  }

  // ============================================================================
  // 私有辅助方法
  // ============================================================================

  /**
   * 重写 IaC 模板内容，将 Deployment 名称替换为 -canary 后缀，添加 track: canary label，副本数初始为 0
   *
   * 重写逻辑：
   * 1. 按 "---" 分割多个文档
   * 2. 对每个文档：
   *    - 如果是 Deployment 资源（kind: Deployment）：
   *      a. 替换 metadata.name 为 <name>-canary
   *      b. 在 metadata.labels 中添加 track: canary
   *      c. 在 spec.template.metadata.labels 中添加 track: canary（用于 Pod selector）
   *      d. 将 spec.replicas 替换为 0（初始副本数为 0，逐步放量）
   *    - 其他资源（Service / ConfigMap 等）保持不变
   * 3. 用 "---" 重新拼接
   *
   * @param templates IaC 模板列表
   * @param originalName 原始 Deployment 名称
   * @returns 重写后的 manifest 字符串
   */
  private rewriteManifestForCanary(templates: ReadonlyArray<IaCTemplate>, originalName: string): string {
    // 拼接全部 IaC 模板内容
    const allContent = templates.map((t) => t.content).join("\n---\n");
    // 按 "---" 分割多个文档
    const documents = allContent.split(/^---\s*$/m);

    // 遍历每个文档，重写 Deployment 资源
    const rewrittenDocs = documents.map((doc) => {
      // 查找 "kind: Deployment" 行
      const kindMatch = doc.match(/^kind:\s*Deployment\s*$/m);
      if (!kindMatch) {
        // 非 Deployment 资源，保持不变
        return doc;
      }

      // 重写 Deployment 资源：
      // 1. 替换 metadata.name 为 <name>-canary
      let rewritten = doc.replace(/^(metadata:\s*\n\s+name:\s*)\S+(\s*)$/m, `$1${originalName}${CANARY_SUFFIX}$2`);

      // 2. 在 metadata.labels 中添加 track: canary（如果 metadata.labels 不存在则添加）
      const labelsMatch = rewritten.match(/^(\s+)labels:\s*$/m);
      if (labelsMatch) {
        // metadata.labels 已存在，在 labels 下添加 track: canary
        const indent = labelsMatch[1];
        rewritten = rewritten.replace(/^(\s+)labels:\s*$/m, `$1labels:\n${indent}  track: canary`);
      } else {
        // metadata.labels 不存在，在 metadata 块下添加 labels: track: canary
        rewritten = rewritten.replace(/^(metadata:\s*\n)(\s+name:\s*\S+\s*)$/m, `$1$2  labels:\n    track: canary\n`);
      }

      // 3. 在 spec.template.metadata.labels 中添加 track: canary（用于 Pod selector）
      const podLabelsMatch = rewritten.match(/^(\s+)spec:\s*\n(\s+)template:\s*\n(\s+)metadata:\s*\n(\s+)labels:\s*$/m);
      if (podLabelsMatch) {
        // spec.template.metadata.labels 已存在，在 labels 下添加 track: canary
        const indent = podLabelsMatch[4];
        rewritten = rewritten.replace(
          /^(\s+)spec:\s*\n(\s+)template:\s*\n(\s+)metadata:\s*\n(\s+)labels:\s*$/m,
          `$1spec:\n$2template:\n$3metadata:\n$4labels:\n${indent}  track: canary`
        );
      } else {
        // spec.template.metadata.labels 不存在，添加完整结构
        rewritten = rewritten.replace(
          /^(\s+)spec:\s*\n(\s+)template:\s*\n(\s+)metadata:\s*\n/m,
          `$1spec:\n$2template:\n$3metadata:\n$3  labels:\n    track: canary\n`
        );
      }

      // 4. 将 spec.replicas 替换为 0（初始副本数为 0，逐步放量）
      // 匹配 "spec:\n  replicas: <N>" 或 "spec:\n  replicas: <N>" 等格式
      const replicasMatch = rewritten.match(/^(\s+)spec:\s*\n(\s+)replicas:\s*\d+\s*$/m);
      if (replicasMatch) {
        // spec.replicas 已存在，替换为 0
        const replicasIndent = replicasMatch[2];
        rewritten = rewritten.replace(
          /^(\s+)spec:\s*\n(\s+)replicas:\s*\d+\s*$/m,
          `$1spec:\n${replicasIndent}replicas: 0`
        );
      } else {
        // spec.replicas 不存在，在 spec 块下添加 replicas: 0
        rewritten = rewritten.replace(/^(\s+)spec:\s*\n/m, `$1spec:\n$1  replicas: 0\n`);
      }

      return rewritten;
    });

    // 用 "---" 重新拼接
    return rewrittenDocs.join("\n---\n");
  }

  /**
   * 从 IaC 模板中解析 Deployment 名称（与 RollingStrategy / BlueGreenStrategy 同构逻辑）
   *
   * 简单 YAML 解析（不引入 yaml 库，保持零新增依赖）：
   * 1. 按 "---" 分割多个文档
   * 2. 查找 "kind: Deployment" 行
   * 3. 提取 metadata.name 字段
   *
   * @param templates IaC 模板列表
   * @returns Deployment 名称；无 Deployment 时返回 undefined
   */
  private extractDeploymentName(templates: ReadonlyArray<IaCTemplate>): string | undefined {
    // 拼接全部 IaC 模板内容
    const allContent = templates.map((t) => t.content).join("\n---\n");
    // 按 "---" 分割多个文档
    const documents = allContent.split(/^---\s*$/m);

    // 遍历每个文档，查找 Deployment 资源
    for (const doc of documents) {
      // 查找 "kind: Deployment" 行
      const kindMatch = doc.match(/^kind:\s*Deployment\s*$/m);
      if (!kindMatch) {
        continue;
      }

      // 查找 metadata.name 字段（兼容缩进格式）
      const nameMatch = doc.match(/^metadata:\s*\n\s+name:\s*(\S+)\s*$/m);
      if (nameMatch) {
        return nameMatch[1];
      }

      // 兼容带引号的格式
      const quotedNameMatch = doc.match(/^metadata:\s*\n\s*name:\s*["']([^"'\n\s]+)["']\s*$/m);
      if (quotedNameMatch) {
        return quotedNameMatch[1];
      }
    }

    return undefined;
  }

  /**
   * 从 IaC 模板中解析 Deployment 副本数（spec.replicas）
   *
   * 简单 YAML 解析：
   * 1. 按 "---" 分割多个文档
   * 2. 查找 "kind: Deployment" 行
   * 3. 在该文档中查找 spec.replicas 字段
   * 4. 提取副本数（默认 1，未指定时）
   *
   * @param templates IaC 模板列表
   * @returns 副本数（默认 1）；无 Deployment 时返回 0
   */
  private extractReplicasFromManifest(templates: ReadonlyArray<IaCTemplate>): number {
    // 拼接全部 IaC 模板内容
    const allContent = templates.map((t) => t.content).join("\n---\n");
    // 按 "---" 分割多个文档
    const documents = allContent.split(/^---\s*$/m);

    // 遍历每个文档，查找 Deployment 资源
    for (const doc of documents) {
      const kindMatch = doc.match(/^kind:\s*Deployment\s*$/m);
      if (!kindMatch) {
        continue;
      }

      // 查找 spec.replicas 字段
      const replicasMatch = doc.match(/^spec:\s*\n\s+replicas:\s*(\d+)\s*$/m);
      if (replicasMatch) {
        const replicas = parseInt(replicasMatch[1], 10);
        // 返回有效副本数（正整数）
        return replicas > 0 ? replicas : 1;
      }

      // 兼容 spec 嵌套层级更深的格式
      const nestedReplicasMatch = doc.match(/^\s+replicas:\s*(\d+)\s*$/m);
      if (nestedReplicasMatch) {
        const replicas = parseInt(nestedReplicasMatch[1], 10);
        if (replicas > 0) {
          return replicas;
        }
      }

      // Deployment 找到但未指定 replicas，默认为 1
      return 1;
    }

    // 未找到 Deployment 资源
    return 0;
  }

  /**
   * 从 IaC 模板中解析 Service 端口
   *
   * 简单 YAML 解析：
   * 1. 按 "---" 分割多个文档
   * 2. 查找 "kind: Service" 行
   * 3. 在该文档中查找 spec.ports[0].port 字段
   * 4. 提取端口号（默认 80，未指定时）
   *
   * @param templates IaC 模板列表
   * @returns Service 端口号（默认 80）
   */
  private extractServicePortFromManifest(templates: ReadonlyArray<IaCTemplate>): number {
    // 拼接全部 IaC 模板内容
    const allContent = templates.map((t) => t.content).join("\n---\n");
    // 按 "---" 分割多个文档
    const documents = allContent.split(/^---\s*$/m);

    // 遍历每个文档，查找 Service 资源
    for (const doc of documents) {
      const kindMatch = doc.match(/^kind:\s*Service\s*$/m);
      if (!kindMatch) {
        continue;
      }

      // 查找 spec.ports[0].port 字段
      // 匹配 "ports:\n  - port: <N>" 或 "ports:\n- port: <N>" 等格式
      const portMatch = doc.match(/^(\s*)ports:\s*\n\s*-?\s*port:\s*(\d+)\s*$/m);
      if (portMatch) {
        const port = parseInt(portMatch[2], 10);
        // 返回有效端口号（1~65535）
        if (port > 0 && port <= 65535) {
          return port;
        }
      }

      // 兼容 port 字段直接在 ports 下的格式
      const directPortMatch = doc.match(/^\s+-?\s*port:\s*(\d+)\s*$/m);
      if (directPortMatch) {
        const port = parseInt(directPortMatch[1], 10);
        if (port > 0 && port <= 65535) {
          return port;
        }
      }

      // Service 找到但未指定 port，使用默认值
      return DEFAULT_SERVICE_PORT;
    }

    // 未找到 Service 资源，使用默认值
    return DEFAULT_SERVICE_PORT;
  }

  /**
   * 执行 kubectl 命令（通过 child_process.spawn，禁止 shell:true）
   *
   * 安全原则：
   * - 参数通过数组传递给 spawn，不使用 shell:true，避免命令注入
   * - 超时通过 spawn 的 timeout 选项控制，超时后子进程被 SIGKILL 终止
   *
   * @param args kubectl 命令参数数组
   * @param timeoutMs 超时时间（毫秒），默认使用 this.timeoutMs
   * @returns KubectlExecutionResult 含 success / stdout / stderr / exitCode / errorMessage
   */
  private runKubectl(args: string[], timeoutMs: number = this.timeoutMs): Promise<KubectlExecutionResult> {
    return new Promise<KubectlExecutionResult>((resolve) => {
      // 启动 kubectl 子进程（不使用 shell:true，避免命令注入）
      const child = spawn("kubectl", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        timeout: timeoutMs,
      });

      // 收集 stdout / stderr 输出
      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });

      // 子进程正常退出
      child.on("close", (code: number | null) => {
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code,
          errorMessage: "",
        });
      });

      // 子进程启动失败（如 kubectl 命令不存在）
      child.on("error", (err: Error) => {
        resolve({
          success: false,
          stdout,
          stderr,
          exitCode: null,
          errorMessage: `kubectl 命令不可用：${err.message}`,
        });
      });
    });
  }

  /**
   * 执行 HTTP 健康检查（GET /healthz）
   *
   * 使用 node:http / node:https 发起真实 HTTP 请求（根据 URL 协议自动选择）：
   * - 超时控制 HTTP_HEALTH_CHECK_TIMEOUT_MS（5 秒）
   * - 期望响应状态码 200
   * - 请求失败（DNS 解析失败 / 连接拒绝 / 超时）时返回 healthy=false
   *
   * @param url 健康检查完整 URL（如 "http://myapp.default.svc.cluster.local:80/healthz"）
   * @returns HttpHealthCheckOutcome 含 healthy / statusCode / errorMessage
   */
  private runHttpHealthCheck(url: string): Promise<HttpHealthCheckOutcome> {
    return new Promise<HttpHealthCheckOutcome>((resolve) => {
      // 解析 URL，根据协议选择 http 或 https 模块
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch (err) {
        // URL 解析失败：返回不健康
        const errMsg = err instanceof Error ? err.message : String(err);
        resolve({
          healthy: false,
          statusCode: 0,
          errorMessage: `URL 解析失败：${errMsg}`,
        });
        return;
      }

      // 根据 protocol 选择 http 或 https 模块
      const requestModule = parsedUrl.protocol === "https:" ? https : http;

      // 构造请求选项
      const requestOptions: http.RequestOptions = {
        method: "GET",
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        timeout: HTTP_HEALTH_CHECK_TIMEOUT_MS,
      };

      // 发起 HTTP 请求
      const req = requestModule.request(requestOptions, (res: http.IncomingMessage) => {
        // 接收响应数据（消费 data 事件，避免内存泄漏）
        res.on("data", () => {
          // 不需要响应体内容，仅消费事件
        });
        res.on("end", () => {
          // 响应结束：根据状态码判断健康状态
          const statusCode = res.statusCode ?? 0;
          resolve({
            healthy: statusCode === 200,
            statusCode,
            errorMessage: statusCode === 200 ? "" : `HTTP 状态码非 200（实际 ${statusCode}）`,
          });
        });
      });

      // 请求超时处理
      req.on("timeout", () => {
        req.destroy();
        resolve({
          healthy: false,
          statusCode: 0,
          errorMessage: `HTTP 请求超时（${HTTP_HEALTH_CHECK_TIMEOUT_MS}ms）`,
        });
      });

      // 请求错误处理（DNS 解析失败 / 连接拒绝等）
      req.on("error", (err: Error) => {
        resolve({
          healthy: false,
          statusCode: 0,
          errorMessage: `HTTP 请求失败：${err.message}`,
        });
      });

      // 发起请求
      req.end();
    });
  }

  /**
   * 判断 kubectl 是否为超时错误
   *
   * kubectl rollout status 超时时的特征：
   * - 退出码非 0（通常为 1）
   * - stderr 含 "timed out" / "deadline exceeded" / "Timeout" 关键字
   *
   * @param result kubectl 执行结果
   * @returns true=超时错误；false=其他错误
   */
  private isTimeoutError(result: KubectlExecutionResult): boolean {
    // 检查 stderr 是否含超时关键字（不区分大小写）
    const stderrLower = result.stderr.toLowerCase();
    return (
      stderrLower.includes("timed out") || stderrLower.includes("deadline exceeded") || stderrLower.includes("timeout")
    );
  }

  /**
   * 格式化 kubectl 错误信息
   *
   * 将 kubectl 执行结果格式化为清晰的错误信息字符串，便于 errors 列表展示。
   *
   * @param commandName 命令名称（如 "kubectl apply" / "rollout status"）
   * @param result kubectl 执行结果
   * @returns 格式化后的错误信息字符串
   */
  private formatKubectlError(commandName: string, result: KubectlExecutionResult): string {
    // 优先使用 errorMessage（spawn error）
    if (result.errorMessage) {
      return `${commandName} 执行失败：${result.errorMessage}`;
    }
    // 其次使用 stderr（kubectl 错误输出）
    if (result.stderr.trim()) {
      return `${commandName} 执行失败（exitCode=${result.exitCode}）：${result.stderr.trim()}`;
    }
    // 最后使用 stdout（某些 kubectl 命令的错误输出到 stdout）
    return `${commandName} 执行失败（exitCode=${result.exitCode}）：${result.stdout.trim()}`;
  }

  /**
   * 解析 kubectl get 的 JSON 输出，构造 DeployedResource 列表
   *
   * 解析逻辑：
   * 1. 解析 JSON 输出为 KubectlResourceList 结构
   * 2. 遍历 items，提取 kind / name / namespace / status
   * 3. 根据 status.conditions 判断资源状态（Running / Pending / Failed / Unknown）
   *
   * 边界场景：
   * - JSON 解析失败：返回空数组，追加错误信息到 errors
   * - items 为空：返回空数组（不追加错误，可能 namespace 下确实无资源）
   * - 单个资源解析失败：跳过该资源，继续解析其他资源
   *
   * @param result kubectl get 执行结果
   * @param defaultNamespace 默认命名空间
   * @param errors 错误信息收集数组（解析失败时追加）
   * @returns DeployedResource 列表
   */
  private parseKubectlResources(
    result: KubectlExecutionResult,
    defaultNamespace: string,
    errors: string[]
  ): DeployedResource[] {
    // kubectl get 失败时返回空数组，追加警告到 errors
    if (!result.success) {
      errors.push(this.formatKubectlError("kubectl get", result));
      return [];
    }

    // 解析 JSON 输出
    let resourceList: KubectlResourceList;
    try {
      resourceList = JSON.parse(result.stdout) as KubectlResourceList;
    } catch (err) {
      // JSON 解析失败：返回空数组，追加错误信息
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`kubectl get JSON 解析失败：${errMsg}`);
      return [];
    }

    // 遍历 items，构造 DeployedResource 列表
    const resources: DeployedResource[] = [];
    for (const item of resourceList.items ?? []) {
      try {
        const kind = item.kind;
        const name = item.metadata?.name ?? "unknown";
        const namespace = item.metadata?.namespace ?? defaultNamespace;
        const status = this.determineResourceStatus(item);

        const resource: DeployedResource = Object.freeze({
          kind,
          name,
          namespace,
          status,
        }) as DeployedResource;
        resources.push(resource);
      } catch {
        // 单个资源解析失败：跳过该资源，继续解析其他资源
        continue;
      }
    }

    return resources;
  }

  /**
   * 根据 kubectl get 的 status 字段判断资源状态
   *
   * 状态判断逻辑：
   * - Deployment：检查 status.conditions 中 "Available" 条件，status="True" 为 Running
   * - Service：检查 status.phase，"Active" 为 Running（Service 通常无 phase 字段，默认 Running）
   * - 其他资源：检查 status.phase，"Running"/"Active"/"Bound" 为 Running
   * - 无法判断时返回 Unknown
   *
   * @param item kubectl get 返回的资源项
   * @returns 资源状态（Running / Pending / Failed / Unknown）
   */
  private determineResourceStatus(
    item: KubectlResourceList["items"][number]
  ): "Running" | "Pending" | "Failed" | "Unknown" {
    const status = item.status;
    if (!status) {
      // 无 status 字段（如 Service）：默认为 Running
      return "Running";
    }

    // Deployment 资源：检查 conditions 中 "Available" 条件
    if (item.kind === "Deployment" && status.conditions) {
      const availableCondition = status.conditions.find((c) => c.type === "Available");
      if (availableCondition) {
        return availableCondition.status === "True" ? "Running" : "Pending";
      }
      return "Unknown";
    }

    // 通用资源：检查 phase 字段
    if (status.phase) {
      switch (status.phase) {
        case "Running":
        case "Active":
        case "Bound":
          return "Running";
        case "Pending":
          return "Pending";
        case "Failed":
          return "Failed";
        default:
          return "Unknown";
      }
    }

    // 无法判断状态时返回 Unknown
    return "Unknown";
  }

  /**
   * 清理临时目录
   *
   * 使用 fs.rmSync 递归删除临时目录及其内容。
   * 失败时不抛异常，仅打印警告日志（避免清理失败影响主流程）。
   *
   * @param tmpDir 临时目录路径
   */
  private cleanupTempDir(tmpDir: string): void {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      // 清理失败时仅打印警告，不抛异常
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`临时目录清理失败（${tmpDir}）：${errMsg}`);
    }
  }

  /**
   * 构建 DeployResult（统一构造 + Object.freeze）
   *
   * 不可变优先（§5.12.4 G-A6d）：
   * - result 对象通过 Object.freeze 冻结
   * - resources 数组通过 Object.freeze 冻结（每个 DeployedResource 已单独冻结）
   * - errors 数组通过 Object.freeze 冻结
   *
   * @param success 部署是否成功
   * @param startedAt 开始时间戳（毫秒）
   * @param resources 已部署资源列表
   * @param errors 错误信息列表
   * @returns DeployResult，被 Object.freeze 冻结
   */
  private buildResult(
    success: boolean,
    startedAt: number,
    resources: DeployedResource[],
    errors: string[]
  ): DeployResult {
    // 计算部署耗时（毫秒）
    const duration = Date.now() - startedAt;
    // 构造结果对象（不可变优先：对象和数组均通过 Object.freeze 冻结）
    const result: DeployResult = {
      success,
      deployedAt: new Date().toISOString(),
      duration,
      resources: Object.freeze([...resources]) as ReadonlyArray<DeployedResource>,
      errors: Object.freeze([...errors]) as ReadonlyArray<string>,
    };
    return Object.freeze(result) as DeployResult;
  }
}
