/**
 * BlueGreenStrategy —— 蓝绿发布策略实现（EAG-P4 批次 14 Phase 2 TASK-14-2-2，FR-5）
 *
 * 核心职责：
 * - 实现蓝绿发布策略：部署 Green Deployment → 等待 Ready → 切换流量 → 清理 Blue
 * - 真实调用 kubectl CLI（通过 child_process.spawn，禁止 shell:true 避免命令注入）
 * - 与 RollingStrategy / CanaryStrategy 同构（构造函数注入 + execute() 签名 + DeployResult 返回值）
 *
 * 真实 kubectl 调用流程（§4.1.7）：
 * 1. 将 IaC 模板内容写入临时文件（version label 替换为 green）
 * 2. kubectl apply -f <临时文件>（部署 Green Deployment，带 version: green label）
 * 3. kubectl rollout status deployment/<name>-green -n <ns> --timeout=<timeoutMs>ms（等待 Green Pod Ready）
 * 4. kubectl patch service <name> -p '{"spec":{"selector":{"version":"green"}}}'（切换流量到 Green）
 * 5. kubectl delete deployment <name>-blue -n <ns>（清理旧 Blue，best-effort，keepBlue=true 时跳过）
 * 6. kubectl get deployment,service -n <ns> -o json（获取已部署资源列表）
 *
 * 失败恢复策略（R-14-1 缓解 A-1，错误内化，不抛异常）：
 * - Green Pod 未 Ready：返回 success=false，不切换流量（保留 Blue 流量）
 * - 流量切换失败：best-effort 回切 Service 到 Blue（不阻塞返回），返回 success=false
 * - 超时：返回 success=false，不切换流量
 * - kubectl apply 失败（YAML 不合法）：返回 success=false，不切换流量
 *
 * 不可变优先（§5.12.4 G-A6d）：
 * - execute() 返回的 DeployResult 对象通过 Object.freeze 冻结
 * - resources 数组通过 Object.freeze 冻结
 * - errors 数组通过 Object.freeze 冻结
 * - 构造函数 Object.freeze 冻结实例
 *
 * 安全原则：
 * - 所有 kubectl 参数通过数组传递给 spawn，不使用 shell:true
 * - 临时文件权限 0o600，临时目录权限 0o700
 * - Service patch 的 JSON payload 通过 spawn stdin 传递，避免 shell 解析
 *
 * 设计依据：
 * - EAG-P4 批次 14 架构师审查 §4.1.7 BlueGreenStrategy 类契约（FR-5）
 * - §R-14-1 风险缓解 A-1：流量切换失败时 best-effort 回切 Service 到 Blue
 * - §5.12.4 G-A6d 不可变优先原则
 *
 * 文件位置：packages/core/src/eag/deploy/blue-green-strategy.ts
 *
 * @module eag/deploy/blue-green-strategy
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  DeployStrategy,
  DeployContext,
  DeployResult,
  DeployedResource,
  IaCTemplate,
  BlueGreenStrategyOptions,
} from "../devops/types";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 默认部署命令超时时间（毫秒）
 *
 * 取值理由：
 * - 5 分钟覆盖 Green Deployment rollout 时间（含镜像拉取 + Pod 调度 + 健康检查）
 * - 与 RollingStrategy 默认超时一致（保持同构）
 */
const DEFAULT_TIMEOUT_MS = 300000;

/**
 * 临时目录前缀（用于 Green Deployment manifest 文件存储）
 */
const TMP_DIR_PREFIX = "eag-bluegreen-apply-";

/**
 * 临时文件名（Green Deployment manifest 文件）
 */
const MANIFEST_FILENAME = "green-deployment.yaml";

/**
 * Green Deployment 名称后缀
 *
 * 命名规范：<original-name>-green
 * 例如：原始 Deployment 名称为 "myapp"，则 Green Deployment 名称为 "myapp-green"
 */
const GREEN_SUFFIX = "-green";

/**
 * Blue Deployment 名称后缀
 *
 * 命名规范：<original-name>-blue
 * 例如：原始 Deployment 名称为 "myapp"，则 Blue Deployment 名称为 "myapp-blue"
 */
const BLUE_SUFFIX = "-blue";

// ============================================================================
// 内部类型定义
// ============================================================================

/**
 * kubectl 命令执行结果（内部使用，不对外导出）
 *
 * 字段说明：
 * - success：命令是否成功（退出码 0）
 * - stdout：标准输出
 * - stderr：标准错误
 * - exitCode：退出码（null 表示进程被信号终止或启动失败）
 * - errorMessage：错误信息（spawn error 时填充）
 */
interface KubectlExecutionResult {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly errorMessage: string;
}

/**
 * kubectl get 返回的 JSON 输出结构（与 RollingStrategy 共享，但独立定义避免循环依赖）
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

// ============================================================================
// BlueGreenStrategy 类
// ============================================================================

/**
 * BlueGreenStrategy —— 蓝绿发布策略实现
 *
 * 实现 DeployStrategy 接口，strategyType = "blue-green"。
 *
 * 与 RollingStrategy / CanaryStrategy 同构：
 * - 构造函数注入 BlueGreenStrategyOptions（含可选 timeoutMs / keepBlue）
 * - execute(context: DeployContext): Promise<DeployResult> 签名一致
 * - 返回 DeployResult（含 success / deployedAt / duration / resources / errors）
 *
 * 蓝绿发布流程：
 * 1. 部署 Green Deployment（独立于 Blue，带 version: green label）
 * 2. 等待 Green Pod Ready（kubectl rollout status）
 * 3. 切换 Service selector 到 version: green（流量切换到 Green）
 * 4. 清理旧 Blue Deployment（keepBlue=true 时跳过清理）
 *
 * 失败恢复：
 * - Green Pod 未 Ready：返回 success=false，不切换流量（Blue 继续提供服务）
 * - 流量切换失败：best-effort 回切 Service 到 Blue（不阻塞返回），返回 success=false
 *
 * 使用方式：
 *   const strategy = new BlueGreenStrategy({ timeoutMs: 300000, keepBlue: false });
 *   const result = await strategy.execute(deployContext);
 *   if (!result.success) {
 *     // 部署失败，根据 errors 列表诊断
 *   }
 */
export class BlueGreenStrategy implements DeployStrategy {
  /** 策略类型标识（固定为 "blue-green"） */
  public readonly strategyType = "blue-green" as const;

  /** 部署命令超时（毫秒），默认 300000（5 分钟） */
  public readonly timeoutMs: number;

  /** 是否保留 Blue Deployment 兜底（默认 false，清理 Blue） */
  public readonly keepBlue: boolean;

  /**
   * 构造函数
   *
   * @param options 配置选项（含可选 timeoutMs / keepBlue）
   */
  constructor(options?: BlueGreenStrategyOptions) {
    // 应用默认值：timeoutMs 默认 300000ms，keepBlue 默认 false
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.keepBlue = options?.keepBlue ?? false;
    // 冻结实例：防止运行时修改配置（对齐 P-1 不可变优先原则）
    Object.freeze(this);
  }

  /**
   * 执行蓝绿部署
   *
   * 执行流程：
   * 1. 校验 iacTemplates 非空
   * 2. 从 IaC 模板中解析 Deployment 名称
   * 3. 将 IaC 模板内容写入临时文件（Deployment 名称替换为 -green 后缀，version label 设为 green）
   * 4. 调用 kubectl apply -f <临时文件>（部署 Green Deployment）
   * 5. 调用 kubectl rollout status deployment/<name>-green -n <ns> --timeout=<timeoutMs>ms（等待 Green Pod Ready）
   *    - 失败时返回 success=false，不切换流量
   * 6. 调用 kubectl patch service <name> -p '{"spec":{"selector":{"version":"green"}}}'（切换流量到 Green）
   *    - 失败时 best-effort 回切 Service 到 Blue，返回 success=false
   * 7. 调用 kubectl delete deployment <name>-blue -n <ns>（清理旧 Blue，keepBlue=true 时跳过）
   *    - 失败时仅记录警告，不影响部署成功状态（best-effort）
   * 8. 调用 kubectl get deployment,service -n <ns> -o json（获取已部署资源列表）
   *
   * 错误处理（错误内化，不抛异常）：
   * - Green Pod 未 Ready：返回 success=false，不切换流量（R-14-1 缓解 A-1）
   * - 流量切换失败：best-effort 回切 Service 到 Blue（不阻塞返回），返回 success=false（R-14-1 缓解 A-1）
   * - Blue 清理失败：仅记录警告，不影响部署成功状态（best-effort）
   *
   * @param context 部署上下文
   * @returns DeployResult，被 Object.freeze 冻结
   */
  async execute(context: DeployContext): Promise<DeployResult> {
    // 记录开始时间
    const startedAt = Date.now();
    // 累积错误信息
    const errors: string[] = [];

    // ---------- 步骤 1: 校验 iacTemplates 非空 ----------
    if (!context.iacTemplates || context.iacTemplates.length === 0) {
      errors.push("IaC 模板为空，无法执行 kubectl apply");
      return this.buildResult(false, startedAt, [], errors);
    }

    // ---------- 步骤 2: 从 IaC 模板中解析 Deployment 名称 ----------
    const originalName = this.extractDeploymentName(context.iacTemplates);
    if (!originalName) {
      // IaC 模板中无 Deployment：蓝绿部署需要 Deployment 资源，无 Deployment 时返回失败
      errors.push("IaC 模板中未找到 Deployment 资源，蓝绿部署需要 Deployment");
      return this.buildResult(false, startedAt, [], errors);
    }

    // 构造 Green / Blue Deployment 名称
    const greenDeploymentName = `${originalName}${GREEN_SUFFIX}`;
    const blueDeploymentName = `${originalName}${BLUE_SUFFIX}`;
    // namespace 默认使用 projectName
    const namespace = context.projectName;

    // ---------- 步骤 3: 将 IaC 模板内容写入临时文件 ----------
    // 创建临时目录（mode 0o700 限制权限）
    let tmpDir: string | undefined;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_DIR_PREFIX));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`临时目录创建失败：${errMsg}`);
      return this.buildResult(false, startedAt, [], errors);
    }

    // manifest 文件路径
    const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
    // 重写 IaC 模板内容：Deployment 名称替换为 -green 后缀，version label 设为 green
    const manifestContent = this.rewriteManifestForGreen(context.iacTemplates, originalName);

    // 写入 manifest 文件
    try {
      fs.writeFileSync(manifestPath, manifestContent, { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`manifest 文件写入失败：${errMsg}`);
      this.cleanupTempDir(tmpDir);
      return this.buildResult(false, startedAt, [], errors);
    }

    try {
      // ---------- 步骤 4: 调用 kubectl apply 部署 Green Deployment ----------
      const applyResult = await this.runKubectl(["apply", "-f", manifestPath]);

      if (!applyResult.success) {
        // kubectl apply 失败：返回失败，不切换流量
        const errMsg = this.formatKubectlError("kubectl apply", applyResult);
        errors.push(errMsg);
        return this.buildResult(false, startedAt, [], errors);
      }

      // ---------- 步骤 5: 调用 kubectl rollout status 等待 Green Pod Ready ----------
      // 超时时间通过 --timeout 参数传递给 kubectl（单位：秒）
      const timeoutSeconds = Math.ceil(this.timeoutMs / 1000);
      const rolloutResult = await this.runKubectl(
        ["rollout", "status", `deployment/${greenDeploymentName}`, "-n", namespace, `--timeout=${timeoutSeconds}s`],
        this.timeoutMs
      );

      if (!rolloutResult.success) {
        // Green Pod 未 Ready 或超时：返回失败，不切换流量（R-14-1 缓解 A-1）
        const errMsg = this.formatKubectlError("rollout status", rolloutResult);
        if (this.isTimeoutError(rolloutResult)) {
          errors.push(`Green Pod 未 Ready（rollout status 超时 ${this.timeoutMs}ms）：${errMsg}`);
        } else {
          errors.push(`Green Pod 未 Ready：${errMsg}`);
        }
        return this.buildResult(false, startedAt, [], errors);
      }

      // ---------- 步骤 6: 调用 kubectl patch service 切换流量到 Green ----------
      // Service patch 的 JSON payload（通过 -p 参数传递）
      // 注意：kubectl patch -p 接受 JSON 字符串，单引号包裹避免 shell 解析
      // 但本实现不使用 shell:true，所以直接传递 JSON 字符串作为参数
      const patchPayload = JSON.stringify({
        spec: {
          selector: {
            version: "green",
          },
        },
      });

      const patchResult = await this.runKubectl([
        "patch",
        "service",
        originalName,
        "-n",
        namespace,
        "-p",
        patchPayload,
        "--type=merge",
      ]);

      if (!patchResult.success) {
        // 流量切换失败：best-effort 回切 Service 到 Blue（R-14-1 缓解 A-1）
        const errMsg = this.formatKubectlError("Service patch", patchResult);
        errors.push(`Service patch 失败（流量未切换到 Green）：${errMsg}`);

        // best-effort 回切 Service 到 Blue（不阻塞返回，失败时仅记录警告）
        const rollbackPatchPayload = JSON.stringify({
          spec: {
            selector: {
              version: "blue",
            },
          },
        });
        const rollbackPatchResult = await this.runKubectl([
          "patch",
          "service",
          originalName,
          "-n",
          namespace,
          "-p",
          rollbackPatchPayload,
          "--type=merge",
        ]);

        if (!rollbackPatchResult.success) {
          // 回切失败：记录警告（不阻塞返回）
          const rollbackErrMsg = this.formatKubectlError("Service 回切 patch", rollbackPatchResult);
          errors.push(`best-effort 回切 Service 到 Blue 失败：${rollbackErrMsg}`);
        } else {
          errors.push("已 best-effort 回切 Service 到 Blue");
        }

        return this.buildResult(false, startedAt, [], errors);
      }

      // ---------- 步骤 7: 清理旧 Blue Deployment（keepBlue=true 时跳过） ----------
      if (!this.keepBlue) {
        // 调用 kubectl delete deployment <name>-blue -n <ns>（best-effort，失败不影响部署成功状态）
        const deleteResult = await this.runKubectl([
          "delete",
          "deployment",
          blueDeploymentName,
          "-n",
          namespace,
          "--ignore-not-found=true",
        ]);

        if (!deleteResult.success) {
          // Blue 清理失败：仅记录警告，不影响部署成功状态（best-effort）
          const warnMsg = this.formatKubectlError("Blue Deployment 清理", deleteResult);
          errors.push(`Blue Deployment 清理失败（best-effort，不影响部署）：${warnMsg}`);
        }
      }

      // ---------- 步骤 8: 调用 kubectl get 获取已部署资源列表 ----------
      const getResult = await this.runKubectl(["get", "deployment,service", "-n", namespace, "-o", "json"]);

      // 解析 kubectl get 的 JSON 输出，构造 DeployedResource 列表
      const resources = this.parseKubectlResources(getResult, namespace, errors);

      // ---------- 构造成功结果 ----------
      // 即使 kubectl get 失败，只要 apply + rollout + patch 成功就视为部署成功
      // 因为流量已切换到 Green，部署已生效
      const success = true;
      return this.buildResult(success, startedAt, resources, errors);
    } finally {
      // 清理临时目录
      this.cleanupTempDir(tmpDir);
    }
  }

  /**
   * 重写 IaC 模板内容，将 Deployment 名称替换为 -green 后缀，version label 设为 green
   *
   * 重写逻辑：
   * 1. 按 "---" 分割多个文档
   * 2. 对每个文档：
   *    - 如果是 Deployment 资源（kind: Deployment）：
   *      a. 替换 metadata.name 为 <name>-green
   *      b. 在 metadata.labels 中添加 version: green
   *      c. 在 spec.template.metadata.labels 中添加 version: green（用于 Pod selector）
   *    - 其他资源（Service / ConfigMap 等）保持不变
   * 3. 用 "---" 重新拼接
   *
   * @param templates IaC 模板列表
   * @param originalName 原始 Deployment 名称
   * @returns 重写后的 manifest 字符串
   */
  private rewriteManifestForGreen(templates: ReadonlyArray<IaCTemplate>, originalName: string): string {
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
      // 1. 替换 metadata.name 为 <name>-green
      let rewritten = doc.replace(/^(metadata:\s*\n\s+name:\s*)\S+(\s*)$/m, `$1${originalName}${GREEN_SUFFIX}$2`);

      // 2. 在 metadata.labels 中添加 version: green（如果 metadata.labels 不存在则添加）
      // 匹配 metadata 块下的 labels 字段
      const labelsMatch = rewritten.match(/^(\s+)labels:\s*$/m);
      if (labelsMatch) {
        // metadata.labels 已存在，在 labels 下添加 version: green
        const indent = labelsMatch[1];
        rewritten = rewritten.replace(/^(\s+)labels:\s*$/m, `$1labels:\n${indent}  version: green`);
      } else {
        // metadata.labels 不存在，在 metadata 块下添加 labels: version: green
        // 匹配 metadata 块的开头，添加 labels 字段
        rewritten = rewritten.replace(/^(metadata:\s*\n)(\s+name:\s*\S+\s*)$/m, `$1$2  labels:\n    version: green\n`);
      }

      // 3. 在 spec.template.metadata.labels 中添加 version: green（用于 Pod selector）
      // 匹配 spec.template.metadata.labels 字段
      const podLabelsMatch = rewritten.match(/^(\s+)spec:\s*\n(\s+)template:\s*\n(\s+)metadata:\s*\n(\s+)labels:\s*$/m);
      if (podLabelsMatch) {
        // spec.template.metadata.labels 已存在，在 labels 下添加 version: green
        const indent = podLabelsMatch[4];
        rewritten = rewritten.replace(
          /^(\s+)spec:\s*\n(\s+)template:\s*\n(\s+)metadata:\s*\n(\s+)labels:\s*$/m,
          `$1spec:\n$2template:\n$3metadata:\n$4labels:\n${indent}  version: green`
        );
      } else {
        // spec.template.metadata.labels 不存在，添加完整结构
        // 匹配 spec.template.metadata 块，添加 labels: version: green
        rewritten = rewritten.replace(
          /^(\s+)spec:\s*\n(\s+)template:\s*\n(\s+)metadata:\s*\n/m,
          `$1spec:\n$2template:\n$3metadata:\n$3  labels:\n    version: green\n`
        );
      }

      return rewritten;
    });

    // 用 "---" 重新拼接
    return rewrittenDocs.join("\n---\n");
  }

  /**
   * 从 IaC 模板中解析 Deployment 名称（与 RollingStrategy 同构逻辑）
   *
   * 简单 YAML 解析（不引入 yaml 库）：
   * 1. 按 "---" 分割多个文档
   * 2. 查找 "kind: Deployment" 行
   * 3. 提取 metadata.name 字段
   *
   * @param templates IaC 模板列表
   * @returns Deployment 名称；无 Deployment 时返回 undefined
   */
  private extractDeploymentName(templates: ReadonlyArray<IaCTemplate>): string | undefined {
    const allContent = templates.map((t) => t.content).join("\n---\n");
    const documents = allContent.split(/^---\s*$/m);

    for (const doc of documents) {
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
   * 执行 kubectl 命令（通过 child_process.spawn，禁止 shell:true）
   *
   * @param args kubectl 命令参数数组
   * @param timeoutMs 超时时间（毫秒）
   * @returns KubectlExecutionResult
   */
  private runKubectl(args: string[], timeoutMs: number = this.timeoutMs): Promise<KubectlExecutionResult> {
    return new Promise<KubectlExecutionResult>((resolve) => {
      const child = spawn("kubectl", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        timeout: timeoutMs,
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });

      child.on("close", (code: number | null) => {
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code,
          errorMessage: "",
        });
      });

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
   * 判断 kubectl 是否为超时错误
   */
  private isTimeoutError(result: KubectlExecutionResult): boolean {
    const stderrLower = result.stderr.toLowerCase();
    return (
      stderrLower.includes("timed out") || stderrLower.includes("deadline exceeded") || stderrLower.includes("timeout")
    );
  }

  /**
   * 格式化 kubectl 错误信息
   */
  private formatKubectlError(commandName: string, result: KubectlExecutionResult): string {
    if (result.errorMessage) {
      return `${commandName} 执行失败：${result.errorMessage}`;
    }
    if (result.stderr.trim()) {
      return `${commandName} 执行失败（exitCode=${result.exitCode}）：${result.stderr.trim()}`;
    }
    return `${commandName} 执行失败（exitCode=${result.exitCode}）：${result.stdout.trim()}`;
  }

  /**
   * 解析 kubectl get 的 JSON 输出，构造 DeployedResource 列表
   */
  private parseKubectlResources(
    result: KubectlExecutionResult,
    defaultNamespace: string,
    errors: string[]
  ): DeployedResource[] {
    if (!result.success) {
      errors.push(this.formatKubectlError("kubectl get", result));
      return [];
    }

    let resourceList: KubectlResourceList;
    try {
      resourceList = JSON.parse(result.stdout) as KubectlResourceList;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`kubectl get JSON 解析失败：${errMsg}`);
      return [];
    }

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
        continue;
      }
    }

    return resources;
  }

  /**
   * 根据 kubectl get 的 status 字段判断资源状态
   */
  private determineResourceStatus(
    item: KubectlResourceList["items"][number]
  ): "Running" | "Pending" | "Failed" | "Unknown" {
    const status = item.status;
    if (!status) {
      return "Running";
    }

    if (item.kind === "Deployment" && status.conditions) {
      const availableCondition = status.conditions.find((c) => c.type === "Available");
      if (availableCondition) {
        return availableCondition.status === "True" ? "Running" : "Pending";
      }
      return "Unknown";
    }

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

    return "Unknown";
  }

  /**
   * 清理临时目录
   */
  private cleanupTempDir(tmpDir: string): void {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`临时目录清理失败（${tmpDir}）：${errMsg}`);
    }
  }

  /**
   * 构建 DeployResult（统一构造 + Object.freeze）
   */
  private buildResult(
    success: boolean,
    startedAt: number,
    resources: DeployedResource[],
    errors: string[]
  ): DeployResult {
    const duration = Date.now() - startedAt;
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
