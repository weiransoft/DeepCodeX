/**
 * RollingStrategy —— 滚动发布策略实现（EAG-P4 批次 14 Phase 2 TASK-14-2-1，B-14-1 Blocker 修复）
 *
 * 核心职责：
 * - 补齐批次 13 缺失的 RollingStrategy 真实实现（B-14-1 Blocker 修复）
 * - 真实调用 kubectl CLI（通过 child_process.spawn，禁止 shell:true 避免命令注入）
 * - 与 BlueGreenStrategy / CanaryStrategy 同构（构造函数注入 + execute() 签名 + DeployResult 返回值）
 *
 * 真实 kubectl 调用流程（§4.1.6）：
 * 1. 将 IaC 模板内容写入临时文件（fs.mkdtempSync + fs.writeFileSync，mode=0o600 限制权限）
 * 2. kubectl apply -f <临时文件>（应用 IaC 模板，创建/更新 K8s 资源）
 * 3. kubectl rollout status deployment/<name> -n <ns> --timeout=<timeoutMs>ms（等待 rollout 完成）
 * 4. kubectl get deployment,service -n <ns> -o json（获取已部署资源列表，解析 JSON 输出）
 * 5. 清理临时文件（try/finally 确保 cleanup）
 *
 * 失败处理策略（错误内化，不抛异常）：
 * - kubectl apply 失败（YAML 不合法 / API Server 不可达）：返回 success=false + errors 含 kubectl 错误信息
 * - kubectl rollout status 超时（Pod 未 Ready）：返回 success=false + errors 含 "rollout status 超时"
 * - kubectl get 失败（资源不存在）：返回 success=true（apply 已成功）但 resources 为空数组 + errors 含警告
 * - spawn error（如 kubectl 命令不存在）：返回 success=false + errors 含 "kubectl 命令不可用"
 *
 * 不可变优先（§5.12.4 G-A6d）：
 * - execute() 返回的 DeployResult 对象通过 Object.freeze 冻结
 * - resources 数组通过 Object.freeze 冻结
 * - errors 数组通过 Object.freeze 冻结
 * - DeployedResource 对象通过 Object.freeze 冻结
 * - 构造函数 Object.freeze 冻结实例，防止运行时修改配置
 *
 * 安全原则：
 * - 所有 kubectl 参数通过数组传递给 spawn，不使用 shell:true，避免命令注入
 * - 临时文件权限 0o600（仅 owner 可读写），避免敏感信息泄露
 * - 临时文件在 finally 块中清理，确保异常路径下也能清理
 *
 * 设计依据：
 * - EAG-P4 批次 14 架构师审查 §4.1.6 RollingStrategy 类契约（B-14-1 修复）
 * - §B.2.1 B-14-1（Blocker）—— RollingStrategy 实现缺失修复
 * - §5.12.4 G-A6d 不可变优先原则
 * - 与 PreDeployChecker / PostDeployChecker 的 kubectl 调用模式同构
 *
 * 文件位置：packages/core/src/eag/deploy/rolling-strategy.ts
 *
 * @module eag/deploy/rolling-strategy
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
  RollingStrategyOptions,
} from "../devops/types";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 默认部署命令超时时间（毫秒）
 *
 * 取值理由：
 * - 5 分钟覆盖绝大部分 Deployment rollout 时间（含镜像拉取 + Pod 调度 + 健康检查）
 * - 与 DeployContext.timeoutMs 默认值 300000（5 分钟）对齐
 * - 超过 5 分钟未完成的 rollout 视为异常，触发超时返回
 */
const DEFAULT_TIMEOUT_MS = 300000;

/**
 * 临时目录前缀（用于 kubectl apply 的 manifest 文件存储）
 *
 * 命名规范：eag-rolling-apply-<random>
 * 权限：0o700（仅 owner 可访问，避免敏感信息泄露）
 */
const TMP_DIR_PREFIX = "eag-rolling-apply-";

/**
 * 临时文件名（manifest 文件）
 *
 * 命名：manifest.yaml
 * 权限：0o600（仅 owner 可读写）
 */
const MANIFEST_FILENAME = "manifest.yaml";

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
 * kubectl get 返回的 JSON 输出结构（仅解析所需字段）
 *
 * 字段说明：
 * - items：资源列表（kubectl get -o json 输出格式）
 *   - kind：资源类型（如 "Deployment" / "Service"）
 *   - metadata.name：资源名称
 *   - metadata.namespace：命名空间
 *   - status：资源状态（如 Deployment 的 status.conditions）
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
// RollingStrategy 类
// ============================================================================

/**
 * RollingStrategy —— 滚动发布策略实现
 *
 * 实现 DeployStrategy 接口，strategyType = "rolling"。
 *
 * 与 BlueGreenStrategy / CanaryStrategy 同构：
 * - 构造函数注入 RollingStrategyOptions（含可选 timeoutMs）
 * - execute(context: DeployContext): Promise<DeployResult> 签名一致
 * - 返回 DeployResult（含 success / deployedAt / duration / resources / errors）
 *
 * 使用方式：
 *   const strategy = new RollingStrategy({ timeoutMs: 300000 });
 *   const result = await strategy.execute(deployContext);
 *   if (!result.success) {
 *     // 部署失败，根据 errors 列表诊断
 *   }
 */
export class RollingStrategy implements DeployStrategy {
  /** 策略类型标识（固定为 "rolling"） */
  public readonly strategyType = "rolling" as const;

  /** 部署命令超时（毫秒），默认 300000（5 分钟） */
  public readonly timeoutMs: number;

  /**
   * 构造函数
   *
   * @param options 配置选项（含可选 timeoutMs，默认 300000ms）
   */
  constructor(options?: RollingStrategyOptions) {
    // 应用默认值：timeoutMs 默认 300000ms（5 分钟）
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // 冻结实例：防止运行时修改配置（对齐 P-1 不可变优先原则）
    Object.freeze(this);
  }

  /**
   * 执行滚动部署
   *
   * 执行流程：
   * 1. 校验 iacTemplates 非空（空数组时返回 success=false + 明确错误）
   * 2. 将 IaC 模板内容写入临时文件（fs.mkdtempSync + fs.writeFileSync）
   * 3. 调用 kubectl apply -f <临时文件>（应用 IaC 模板）
   * 4. 从 IaC 模板中解析 Deployment 名称（简单 YAML 解析）
   * 5. 调用 kubectl rollout status deployment/<name> -n <ns> --timeout=<timeoutMs>ms（等待 rollout）
   * 6. 调用 kubectl get deployment,service -n <ns> -o json（获取资源列表）
   * 7. 解析 JSON 输出，构造 DeployedResource 列表
   * 8. 清理临时文件（finally 块确保清理）
   *
   * 错误处理（错误内化，不抛异常）：
   * - 任一 kubectl 命令失败时，立即返回 success=false + 错误信息
   * - 不抛异常，保证 execute() 始终返回结构化 DeployResult
   * - 临时文件在 finally 块中清理，确保异常路径下也能清理
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

    // ---------- 步骤 2: 将 IaC 模板内容写入临时文件 ----------
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

    // manifest 文件路径（<tmpDir>/manifest.yaml）
    const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
    // 拼接所有 IaC 模板内容（多文档 YAML 用 "---" 分隔）
    const manifestContent = this.concatenateIacTemplates(context.iacTemplates);

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

    // 从 IaC 模板中解析 Deployment 名称（用于后续 rollout status）
    const deploymentName = this.extractDeploymentName(context.iacTemplates);
    // namespace 默认使用 projectName（与 PreDeployChecker / PostDeployChecker 一致）
    const namespace = context.projectName;

    try {
      // ---------- 步骤 3: 调用 kubectl apply -f <临时文件> ----------
      const applyResult = await this.runKubectl(["apply", "-f", manifestPath]);

      if (!applyResult.success) {
        // kubectl apply 失败：收集错误信息并返回失败
        const errMsg = this.formatKubectlError("kubectl apply", applyResult);
        errors.push(errMsg);
        return this.buildResult(false, startedAt, [], errors);
      }

      // ---------- 步骤 4: 调用 kubectl rollout status 等待 rollout 完成 ----------
      // 仅当从 IaC 模板中解析到 Deployment 名称时才调用 rollout status
      // （无 Deployment 的纯 Service / ConfigMap 部署跳过此步骤）
      if (deploymentName) {
        // 超时时间通过 --timeout 参数传递给 kubectl（单位：秒）
        // 注意：kubectl --timeout 接受 5m / 30s / 300s 等格式，这里使用 ${seconds}s 格式
        const timeoutSeconds = Math.ceil(this.timeoutMs / 1000);
        const rolloutResult = await this.runKubectl(
          ["rollout", "status", `deployment/${deploymentName}`, "-n", namespace, `--timeout=${timeoutSeconds}s`],
          this.timeoutMs
        );

        if (!rolloutResult.success) {
          // kubectl rollout status 失败：可能是 Pod 未 Ready / 超时 / Deployment 不存在
          const errMsg = this.formatKubectlError("rollout status", rolloutResult);
          // 判断是否为超时（kubectl 超时退出码为 1，stderr 含 "timed out" 关键字）
          if (this.isTimeoutError(rolloutResult)) {
            errors.push(`rollout status 超时（${this.timeoutMs}ms）：${errMsg}`);
          } else {
            errors.push(errMsg);
          }
          return this.buildResult(false, startedAt, [], errors);
        }
      }

      // ---------- 步骤 5: 调用 kubectl get 获取已部署资源列表 ----------
      // 获取 namespace 下的所有 Deployment 和 Service 资源（-o json 便于解析）
      const getResult = await this.runKubectl(["get", "deployment,service", "-n", namespace, "-o", "json"]);

      // 解析 kubectl get 的 JSON 输出，构造 DeployedResource 列表
      const resources = this.parseKubectlResources(getResult, namespace, errors);

      // ---------- 步骤 6: 构造成功结果 ----------
      // 即使 kubectl get 失败（如资源列表为空），只要 apply 和 rollout 成功就视为部署成功
      // 因为 apply 已成功创建资源，kubectl get 失败只是无法获取资源列表
      const success = errors.length === 0 || resources.length > 0;
      return this.buildResult(success, startedAt, resources, errors);
    } finally {
      // 清理临时目录（finally 块确保异常路径下也能清理）
      this.cleanupTempDir(tmpDir);
    }
  }

  /**
   * 拼接 IaC 模板内容为多文档 YAML
   *
   * 多文档 YAML 用 "---" 分隔，kubectl apply 支持 -f 读取多文档 YAML。
   *
   * @param templates IaC 模板列表
   * @returns 拼接后的 YAML 字符串
   */
  private concatenateIacTemplates(templates: ReadonlyArray<IaCTemplate>): string {
    // 过滤出 K8s manifest 类型的模板（terraform / helm-chart 不直接 apply）
    // 注意：RollingStrategy 仅处理 k8s-manifest 类型，其他类型跳过
    const k8sTemplates = templates.filter((t) => t.type === "k8s-manifest");
    // 如果没有 K8s manifest 类型模板，回退到使用全部模板（兼容混合类型场景）
    const templatesToUse = k8sTemplates.length > 0 ? k8sTemplates : templates;
    // 用 "---\n" 分隔每个模板内容，构造多文档 YAML
    return templatesToUse.map((t) => t.content).join("\n---\n");
  }

  /**
   * 从 IaC 模板中解析 Deployment 名称
   *
   * 简单 YAML 解析逻辑（不引入 yaml 库，保持零新增依赖）：
   * 1. 按 "---" 分割多个文档
   * 2. 对每个文档，查找 "kind: Deployment" 行
   * 3. 如果找到，在该文档中查找 "metadata.name" 字段
   * 4. 提取名称
   *
   * 边界场景：
   * - 无 Deployment 资源：返回 undefined（调用方跳过 rollout status）
   * - 多个 Deployment：返回第一个 Deployment 的名称
   * - YAML 格式不规范：返回 undefined（不抛异常）
   *
   * @param templates IaC 模板列表
   * @returns Deployment 名称（如 "myapp"）；无 Deployment 时返回 undefined
   */
  private extractDeploymentName(templates: ReadonlyArray<IaCTemplate>): string | undefined {
    // 拼接全部 IaC 模板内容
    const allContent = templates.map((t) => t.content).join("\n---\n");
    // 按 "---" 分割多个文档
    const documents = allContent.split(/^---\s*$/m);

    // 遍历每个文档，查找 Deployment 资源
    for (const doc of documents) {
      // 查找 "kind: Deployment" 行（允许 "kind:Deployment" / "kind: Deployment " 等变体）
      const kindMatch = doc.match(/^kind:\s*Deployment\s*$/m);
      if (!kindMatch) {
        // 非 Deployment 资源，跳过
        continue;
      }

      // 在该文档中查找 "metadata.name" 字段
      // 匹配 "metadata:\n  name: <value>" 或 "metadata:\n  name: <value>" 等
      const nameMatch = doc.match(/^metadata:\s*\n\s+name:\s*(\S+)\s*$/m);
      if (nameMatch) {
        // 提取 Deployment 名称
        return nameMatch[1];
      }

      // 兼容顶层 "name:" 直接在 metadata 下的格式（无缩进）
      const topLevelNameMatch = doc.match(/^metadata:\s*\n\s*name:\s*["']?([^"'\n\s]+)["']?\s*$/m);
      if (topLevelNameMatch) {
        return topLevelNameMatch[1];
      }
    }

    // 未找到 Deployment 资源
    return undefined;
  }

  /**
   * 执行 kubectl 命令（通过 child_process.spawn，禁止 shell:true）
   *
   * 安全原则：
   * - 参数通过数组传递给 spawn，不使用 shell:true，避免命令注入
   * - 超时通过 spawn 的 timeout 选项控制，超时后子进程被 SIGKILL 终止
   *
   * @param args kubectl 命令参数数组（如 ["apply", "-f", "/path/to/manifest.yaml"]）
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
   * @param defaultNamespace 默认命名空间（资源未指定 namespace 时使用）
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
        // 提取资源类型（kubectl get 返回的 kind 可能是 "Deployment" / "Service" / "ReplicaSet" 等）
        const kind = item.kind;
        // 提取资源名称
        const name = item.metadata?.name ?? "unknown";
        // 提取命名空间（未指定时使用默认值）
        const namespace = item.metadata?.namespace ?? defaultNamespace;
        // 根据 status 字段判断资源状态
        const status = this.determineResourceStatus(item);

        // 构造 DeployedResource 对象（冻结保持不可变优先）
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
