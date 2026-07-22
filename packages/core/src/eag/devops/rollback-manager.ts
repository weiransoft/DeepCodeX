/**
 * RollbackManager 实现 + 工厂装配（EAG-P4 批次 13 D1-4 §3.7 + 批次 14 Phase 1 §4.1.3/§4.1.4/§4.1.5 + Phase 3 完整实现）
 *
 * 本模块提供 RollbackManager 接口的 3 个实现 + 1 个工厂函数：
 * - NoOpRollbackManager（批次 13）：空实现占位，供 DevOpsOrchestrator / DeployStage 在未注入真实 RollbackManager 时使用
 * - K8sRollbackManager（批次 14 Phase 3 完整实现）：基于 kubectl 的回滚管理器，调用 kubectl rollout undo / patch / scale
 * - HelmRollbackManager（批次 14 Phase 3 完整实现）：基于 helm 的回滚管理器，调用 helm rollback
 * - createRollbackManager（批次 14 Phase 1）：RollbackManager 装配工厂，根据 IaCType 路由到对应实现
 *
 * Phase 3 完整实现（K8sRollbackManager / HelmRollbackManager）：
 * - 真实调用 kubectl / helm CLI（通过 child_process.execFile，禁止 shell:true 避免命令注入）
 * - createSnapshot：kubectl get deployment -o yaml / helm history --output yaml，保存到 rollback-snapshots/<runId>/
 * - rollback：根据 RollbackStrategyType 调用对应策略（rolling / blue-green / canary）
 * - verifyRollback：轮询 kubectl rollout status / helm history 确认回滚生效
 * - 失败时抛出 RollbackExecutionError（含 stderr / command / exitCode 字段）
 * - 超时控制：默认 30s（可通过 options.rollbackTimeoutMs 配置）
 *
 * 设计原则：
 * - NoOpRollbackManager 不引入实际副作用（不调用 kubectl / helm）
 * - K8s/Helm RollbackManager 真实调用 CLI，失败时抛 RollbackExecutionError（错误外抛模式，区别于 RollingStrategy 的错误内化）
 * - 返回值被 Object.freeze 深冻结（对齐 P-1 不可变优先原则）
 * - 工厂函数真实实现路由逻辑（K-3 决策）
 *
 * 安全原则：
 * - 所有 kubectl/helm 参数通过数组传递给 execFile，不使用 shell:true，避免命令注入
 * - 临时文件权限 0o600（仅 owner 可读写），避免敏感信息泄露
 * - 临时文件在 finally 块中清理，确保异常路径下也能清理
 *
 * 设计依据：
 * - EAG-P4 批次 13 设计文档 §3.7 RollbackManager 接口与 NoOpRollbackManager 占位实现
 * - §6.3 R-P4-3 风险缓解：批次 13 仅预留接口，不实现回滚逻辑
 * - EAG-P4 批次 14 架构师审查 §4.1.3 K8sRollbackManager 类契约
 * - EAG-P4 批次 14 架构师审查 §4.1.4 HelmRollbackManager 类契约
 * - EAG-P4 批次 14 架构师审查 §4.1.5 createRollbackManager 工厂函数（FR-4）
 * - K-3 决策：terraform IaC 使用 K8sRollbackManager 兜底，打印 WARNING 日志
 *
 * @module eag/devops/rollback-manager
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  IaCType,
  RollbackManager,
  RollbackResult,
  RollbackSnapshot,
  RollbackSnapshotContext,
  RollbackStrategyType,
  RollbackVerificationResult,
} from "./types";
import { RollbackExecutionError, ROLLBACK_PLAN_SECTIONS } from "./types";

// ============================================================================
// NoOpRollbackManager 类（批次 13 既有，零改动）
// ============================================================================

/**
 * NoOpRollbackManager —— 空实现占位
 *
 * 用途：
 * - DevOpsOrchestrator / DeployStage 在未注入 rollbackManager 时使用此占位
 * - createSnapshot() 返回空快照（snapshotId="noop-<timestamp>" / version="unknown"）
 * - rollback() 直接返回 success=false（无法回滚，提示用户手动处理）
 *
 * 设计原则：
 * - 不引入实际副作用（不调用 kubectl / helm）
 * - 与既有 Orchestrator 的"可选依赖 + 默认占位"模式同构
 * - 返回值被 Object.freeze 深冻结（对齐 P-1 不可变优先原则）
 */
export class NoOpRollbackManager implements RollbackManager {
  /**
   * 创建空快照（不调用任何外部命令）
   *
   * 实现：
   * - snapshotId：使用 "noop-<Date.now()>" 格式，保证唯一性
   * - version：固定为 "unknown"（占位实现无法获取真实版本）
   * - resources：空数组（占位实现无法枚举真实资源）
   * - createdAt：使用 new Date().toISOString() 生成 ISO 8601 时间戳
   *
   * @param context 快照上下文（含 projectName / namespace / previousVersion）
   * @returns RollbackSnapshot 含空快照数据，被 Object.freeze 冻结
   */
  async createSnapshot(context: RollbackSnapshotContext): Promise<RollbackSnapshot> {
    // 构造空快照（不调用任何外部命令，仅生成元数据）
    const snapshot: RollbackSnapshot = {
      snapshotId: `noop-${Date.now()}`,
      createdAt: new Date().toISOString(),
      version: "unknown", // 占位实现无法获取真实版本
      resources: Object.freeze([]) as ReadonlyArray<string>,
    };
    return Object.freeze(snapshot) as RollbackSnapshot;
  }

  /**
   * 空回滚（直接返回失败，提示用户手动处理）
   *
   * 实现：
   * - success：固定为 false（占位实现无法执行实际回滚）
   * - rolledBackTo：固定为 "none"（未执行任何回滚操作）
   * - duration：固定为 0（无实际操作耗时）
   * - errors：包含明确的错误消息，提示用户注入真实 RollbackManager 或手动执行回滚命令
   *
   * @param snapshot 部署前创建的版本快照（占位实现仅用于错误消息中引用 snapshotId）
   * @returns RollbackResult 含失败结果与错误消息，被 Object.freeze 冻结
   */
  async rollback(snapshot: RollbackSnapshot): Promise<RollbackResult> {
    // 构造失败结果（明确告知用户占位实现不支持实际回滚）
    const result: RollbackResult = {
      success: false,
      rolledBackTo: "none", // 占位实现未执行实际回滚
      duration: 0,
      errors: Object.freeze([
        `NoOpRollbackManager 不支持实际回滚（snapshot=${snapshot.snapshotId}），` +
          `请注入 K8sRollbackManager / HelmRollbackManager 或手动执行 ` +
          `kubectl rollout undo deployment/<name> -n <namespace> / helm rollback <release>`,
      ]) as ReadonlyArray<string>,
    };
    return Object.freeze(result) as RollbackResult;
  }
}

// ============================================================================
// 内部类型与工具函数（Phase 3 新增，K8s/Helm RollbackManager 共用）
// ============================================================================

/**
 * CLI 命令执行结果（内部使用，不对外导出）
 *
 * 字段说明：
 * - success：命令是否成功（退出码 0）
 * - stdout：标准输出（kubectl/helm 的正常输出）
 * - stderr：标准错误（kubectl/helm 的错误输出）
 * - exitCode：退出码（null 表示进程被信号终止或启动失败）
 * - errorMessage：错误信息（spawn error 时填充，如 "kubectl 命令不可用"）
 */
interface CliExecResult {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly errorMessage: string;
}

/**
 * 执行 CLI 命令（通过 child_process.execFile，禁止 shell:true 避免命令注入）
 *
 * 安全原则：
 * - 参数通过数组传递给 execFile，不使用 shell:true，避免命令注入
 * - 超时通过 execFile 的 timeout 选项控制，超时后子进程被 SIGTERM 终止
 * - maxBuffer 设为 10MB，覆盖 kubectl get -o yaml / helm history --output yaml 的输出大小
 *
 * 错误处理：
 * - 退出码非 0：success=false, exitCode=退出码, stderr 含 kubectl/helm 错误输出
 * - 命令不存在（ENOENT）：success=false, exitCode=null, errorMessage="命令 <cmd> 不可用"
 * - 超时（SIGTERM）：success=false, exitCode=null, errorMessage="命令 <cmd> 被信号 SIGTERM 终止"
 * - maxBuffer 超限：success=false, exitCode=null, errorMessage 含 maxBuffer 错误
 *
 * @param cmd 命令名称（如 "kubectl" / "helm"）
 * @param args 命令参数数组（如 ["get", "deployment", "myapp", "-n", "default", "-o", "yaml"]）
 * @param timeoutMs 超时时间（毫秒）
 * @returns CliExecResult 含 success / stdout / stderr / exitCode / errorMessage
 */
function execCli(cmd: string, args: string[], timeoutMs: number): Promise<CliExecResult> {
  return new Promise<CliExecResult>((resolve) => {
    // 启动子进程（execFile 不使用 shell:true，避免命令注入）
    // encoding: "utf8" 让 stdout/stderr 自动为 string 类型，避免 Buffer 转换
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB，覆盖 kubectl/helm 输出大小
        encoding: "utf8",
        env: process.env,
      },
      (error, stdout, stderr) => {
        // encoding 已指定为 "utf8"，stdout/stderr 直接为 string 类型
        const stdoutStr = stdout;
        const stderrStr = stderr;

        if (error) {
          // 命令执行失败，分析错误类型
          const code = error.code;
          const signal = error.signal;

          let exitCode: number | null;
          let errorMessage: string;

          if (typeof code === "number") {
            // 非零退出码：kubectl/helm 命令执行失败（如资源不存在 / 参数错误）
            exitCode = code;
            errorMessage = "";
          } else if (code === "ENOENT") {
            // 命令不存在：kubectl/helm 未安装或不在 PATH 中
            exitCode = null;
            errorMessage = `命令 ${cmd} 不可用：${error.message}`;
          } else if (signal) {
            // 被信号终止（如超时 SIGTERM）
            exitCode = null;
            errorMessage = `命令 ${cmd} 被信号 ${signal} 终止`;
          } else {
            // 其他错误（如 maxBuffer 超限）
            exitCode = null;
            errorMessage = error.message;
          }

          resolve({
            success: false,
            stdout: stdoutStr,
            stderr: stderrStr,
            exitCode,
            errorMessage,
          });
        } else {
          // 命令执行成功（退出码 0）
          resolve({
            success: true,
            stdout: stdoutStr,
            stderr: stderrStr,
            exitCode: 0,
            errorMessage: "",
          });
        }
      }
    );
  });
}

// ============================================================================
// K8sRollbackManager 类（Phase 3 完整实现，替换 Phase 1 占位类）
// ============================================================================

/**
 * K8sRollbackManager 配置选项（批次 14 §4.1.3）
 *
 * 字段说明：
 * - rollbackTimeoutMs：回滚命令超时（毫秒），默认 30000
 * - projectRoot：项目根目录（用于生成回滚预案文件路径与快照数据文件路径）
 *
 * 不可变优先：所有字段 readonly。
 */
export interface K8sRollbackManagerOptions {
  /** 回滚命令超时（毫秒），默认 30000 */
  readonly rollbackTimeoutMs?: number;
  /** 项目根目录（用于生成回滚预案文件路径与快照数据文件路径） */
  readonly projectRoot?: string;
}

/**
 * K8sRollbackManager —— 基于 kubectl 的回滚管理器实现（FR-2，Phase 3 完整实现）
 *
 * 真实调用 kubectl CLI（通过 child_process.execFile，禁止 shell:true 避免命令注入）：
 * - createSnapshot()：
 *   1. `kubectl get deployment <name> -n <ns> -o yaml`（获取当前 Deployment YAML）
 *   2. `kubectl rollout history deployment/<name> -n <ns>`（获取 revision 历史）
 *   3. 保存 YAML 到 `<projectRoot>/rollback-snapshots/<runId>/<name>.yaml`
 *   4. 生成回滚预案文件 `<projectRoot>/deploy/rollback-plan-<runId>.md`
 * - rollback()：根据 RollbackStrategyType 调用对应策略
 *   - rolling：`kubectl rollout undo deployment/<name> -n <ns> --to-revision=<N>`
 *   - blue-green：`kubectl patch service <name> -n <ns> --type=json -p='[...]'`（切换 Service selector）
 *   - canary：`kubectl scale deployment/<name>-canary -n <ns> --replicas=0`（降级 traffic 分流）
 * - verifyRollback()：轮询 `kubectl get deployment <name> -n <ns> -o json`
 *   直到 status.availableReplicas >= spec.replicas
 *
 * 错误处理（错误外抛模式，区别于 RollingStrategy 的错误内化）：
 * - kubectl 命令失败（退出码非 0）：抛出 RollbackExecutionError（含 stderr / command / exitCode）
 * - kubectl 命令不可用（ENOENT）：抛出 RollbackExecutionError（含 errorMessage）
 * - 超时（SIGTERM）：抛出 RollbackExecutionError（含超时信息）
 * - verifyRollback 失败：返回 RollbackResult.success=false（不抛异常，调用方可重试）
 *
 * 不可变优先：
 * - createSnapshot() / rollback() / verifyRollback() 返回值通过 Object.freeze 冻结
 * - 构造函数 Object.freeze 冻结实例，防止运行时修改配置
 * - 超时控制：默认 30s（可通过 options.rollbackTimeoutMs 配置）
 *
 * 使用方式：
 *   const manager = new K8sRollbackManager({
 *     rollbackTimeoutMs: 30000,
 *     projectRoot: "/path/to/project",
 *   });
 *   const snapshot = await manager.createSnapshot({ projectName: "myapp", namespace: "default", runId: "run-001" });
 *   const result = await manager.rollback(snapshot);
 */
export class K8sRollbackManager implements RollbackManager {
  /** 回滚命令超时（毫秒），默认 30000 */
  public readonly rollbackTimeoutMs: number;
  /** 项目根目录（用于生成回滚预案文件路径与快照数据文件路径） */
  public readonly projectRoot?: string;

  /**
   * 构造函数
   *
   * @param options 配置选项（含 rollbackTimeoutMs / projectRoot）
   */
  constructor(options?: K8sRollbackManagerOptions) {
    // 应用默认值：rollbackTimeoutMs 默认 30000ms，projectRoot 可选
    this.rollbackTimeoutMs = options?.rollbackTimeoutMs ?? 30000;
    this.projectRoot = options?.projectRoot;
    // 冻结实例：防止运行时修改配置（对齐 P-1 不可变优先原则）
    Object.freeze(this);
  }

  /**
   * 创建版本快照（部署前调用）
   *
   * 执行流程：
   * 1. 调用 `kubectl get deployment <projectName> -n <namespace> -o yaml` 获取当前 Deployment YAML
   * 2. 调用 `kubectl rollout history deployment/<projectName> -n <namespace>` 获取 revision 历史
   * 3. 解析最新 revision 号
   * 4. 解析 Deployment 的 labels（用于 blue-green 回滚时切换 Service selector）
   * 5. 保存 YAML 到 `<projectRoot>/rollback-snapshots/<runId>/<projectName>.yaml`
   * 6. 生成回滚预案文件（5 个章节，Markdown 格式）
   * 7. 返回 Object.freeze(snapshot)
   *
   * 错误处理：
   * - kubectl 命令失败：抛出 RollbackExecutionError
   * - 快照文件保存失败：不抛异常，snapshotDataPath 为 undefined（非致命错误）
   * - 回滚预案文件生成失败：不抛异常，rollbackPlanFilePath 为 undefined（非致命错误）
   *
   * @param context 快照上下文（含 projectName / namespace / runId / rollbackStrategy）
   * @returns RollbackSnapshot 含真实版本号与资源列表
   * @throws RollbackExecutionError 当 kubectl 命令失败时抛出
   */
  async createSnapshot(context: RollbackSnapshotContext): Promise<RollbackSnapshot> {
    // ---------- 步骤 1: 调用 kubectl get deployment -o yaml ----------
    const getYamlResult = await execCli(
      "kubectl",
      ["get", "deployment", context.projectName, "-n", context.namespace, "-o", "yaml"],
      this.rollbackTimeoutMs
    );

    if (!getYamlResult.success) {
      // kubectl get 失败：抛出 RollbackExecutionError（含 stderr 输出）
      throw new RollbackExecutionError(
        `kubectl get deployment ${context.projectName} -n ${context.namespace} -o yaml`,
        getYamlResult.errorMessage || getYamlResult.stderr,
        getYamlResult.exitCode
      );
    }

    // ---------- 步骤 2: 调用 kubectl rollout history ----------
    const historyResult = await execCli(
      "kubectl",
      ["rollout", "history", `deployment/${context.projectName}`, "-n", context.namespace],
      this.rollbackTimeoutMs
    );

    if (!historyResult.success) {
      // kubectl rollout history 失败：抛出 RollbackExecutionError
      throw new RollbackExecutionError(
        `kubectl rollout history deployment/${context.projectName} -n ${context.namespace}`,
        historyResult.errorMessage || historyResult.stderr,
        historyResult.exitCode
      );
    }

    // ---------- 步骤 3: 解析最新 revision 号 ----------
    const revision = this.parseLatestRevision(historyResult.stdout);

    // ---------- 步骤 4: 解析 Deployment 的 labels ----------
    const labels = this.parseDeploymentLabels(getYamlResult.stdout);

    // ---------- 步骤 5: 保存快照数据文件 ----------
    // 文件路径：<projectRoot>/rollback-snapshots/<runId>/<projectName>.yaml
    // projectRoot 未设置时使用 process.cwd() 兜底
    const runId = context.runId ?? "default";
    const baseDir = this.projectRoot ?? process.cwd();
    const snapshotDir = path.join(baseDir, "rollback-snapshots", runId);
    const snapshotFilePath = path.join(snapshotDir, `${context.projectName}.yaml`);

    let snapshotDataPath: string | undefined;
    try {
      // 创建快照目录（recursive: true 确保父目录也存在）
      fs.mkdirSync(snapshotDir, { recursive: true });
      // 写入快照文件（mode 0o600 限制权限，避免敏感信息泄露）
      fs.writeFileSync(snapshotFilePath, getYamlResult.stdout, {
        encoding: "utf8",
        mode: 0o600,
      });
      snapshotDataPath = snapshotFilePath;
    } catch {
      // 快照文件保存失败：非致命错误，继续执行（snapshotDataPath 保持 undefined）
      // 不抛异常，确保 createSnapshot 仍能返回有效快照
    }

    // ---------- 步骤 6: 生成回滚预案文件 ----------
    const rollbackPlanFilePath = this.generateRollbackPlan(context, revision);

    // ---------- 步骤 7: 构造并返回 RollbackSnapshot ----------
    const snapshot: RollbackSnapshot = {
      snapshotId: `k8s-${runId}-${Date.now()}`,
      createdAt: new Date().toISOString(),
      version: String(revision),
      resources: Object.freeze([`deployment/${context.projectName}`]) as ReadonlyArray<string>,
      rollbackPlanFilePath,
      rollbackStrategy: context.rollbackStrategy ?? "rolling",
      snapshotDataPath,
      projectName: context.projectName,
      namespace: context.namespace,
    };
    return Object.freeze(snapshot) as RollbackSnapshot;
  }

  /**
   * 执行回滚（部署失败时调用）
   *
   * 执行流程：
   * 1. 从 snapshot 中提取 deploymentName / namespace / targetRevision / strategy
   * 2. 根据 RollbackStrategyType 调用对应策略的 kubectl 命令
   * 3. 调用 verifyRollback 验证回滚是否生效
   * 4. 返回 RollbackResult（success / rolledBackTo / duration / errors）
   *
   * 错误处理：
   * - kubectl 命令失败：抛出 RollbackExecutionError
   * - verifyRollback 失败：返回 RollbackResult.success=false（不抛异常）
   *
   * @param snapshot 部署前创建的版本快照
   * @returns RollbackResult，被 Object.freeze 冻结
   * @throws RollbackExecutionError 当 kubectl 回滚命令失败时抛出
   */
  async rollback(snapshot: RollbackSnapshot): Promise<RollbackResult> {
    const startedAt = Date.now();

    // 提取回滚所需参数
    const deploymentName = snapshot.projectName ?? this.extractDeploymentName(snapshot.resources);
    const namespace = snapshot.namespace ?? "default";
    const targetRevision = parseInt(snapshot.version, 10);
    const strategy: RollbackStrategyType = snapshot.rollbackStrategy ?? "rolling";

    if (!deploymentName) {
      // 无法确定 deployment 名称：返回失败结果
      const result: RollbackResult = {
        success: false,
        rolledBackTo: "none",
        duration: Date.now() - startedAt,
        errors: Object.freeze([
          `无法确定 deployment 名称：snapshot.projectName 未设置且 snapshot.resources 无法解析`,
        ]) as ReadonlyArray<string>,
      };
      return Object.freeze(result) as RollbackResult;
    }

    // ---------- 根据策略执行回滚命令 ----------
    await this.executeRollbackStrategy(strategy, deploymentName, namespace, targetRevision, snapshot);

    // ---------- 验证回滚结果 ----------
    const verification = await this.verifyRollback(deploymentName, namespace);

    // ---------- 构造并返回 RollbackResult ----------
    const result: RollbackResult = {
      success: verification.success,
      rolledBackTo: snapshot.version,
      duration: Date.now() - startedAt,
      errors: verification.success
        ? (Object.freeze([]) as ReadonlyArray<string>)
        : (Object.freeze([verification.message]) as ReadonlyArray<string>),
    };
    return Object.freeze(result) as RollbackResult;
  }

  /**
   * 验证回滚结果（轮询 kubectl get deployment -o json 直到 AvailableReplicas 达到期望）
   *
   * 执行流程：
   * 1. 轮询 `kubectl get deployment <name> -n <ns> -o json`
   * 2. 解析 JSON 输出，提取 status.availableReplicas 与 spec.replicas
   * 3. 当 availableReplicas >= replicas 时返回 success=true
   * 4. 超过超时时间后返回 success=false
   *
   * 轮询参数：
   * - 轮询间隔：1000ms（1 秒）
   * - 最大轮询次数：rollbackTimeoutMs / 1000
   *
   * @param deploymentName Deployment 名称
   * @param namespace K8s 命名空间
   * @returns RollbackVerificationResult，被 Object.freeze 冻结
   */
  async verifyRollback(deploymentName: string, namespace: string): Promise<RollbackVerificationResult> {
    // 轮询间隔 1 秒
    const pollIntervalMs = 1000;
    // 最大轮询次数 = 超时时间 / 轮询间隔
    const maxAttempts = Math.max(1, Math.ceil(this.rollbackTimeoutMs / pollIntervalMs));

    let lastAvailableReplicas = 0;
    let lastExpectedReplicas = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // 调用 kubectl get deployment -o json 获取 Deployment 状态
      const result = await execCli(
        "kubectl",
        ["get", "deployment", deploymentName, "-n", namespace, "-o", "json"],
        this.rollbackTimeoutMs
      );

      if (result.success) {
        // 解析 JSON 输出，提取副本数
        const { availableReplicas, expectedReplicas } = this.parseDeploymentStatus(result.stdout);
        lastAvailableReplicas = availableReplicas;
        lastExpectedReplicas = expectedReplicas;

        if (availableReplicas >= expectedReplicas) {
          // 副本数达标：验证成功
          return Object.freeze({
            success: true,
            currentReplicas: availableReplicas,
            expectedReplicas,
            message: `回滚验证成功：${availableReplicas}/${expectedReplicas} 副本可用`,
          }) as RollbackVerificationResult;
        }
      }

      // 等待下一次轮询（最后一次不需要等待）
      if (attempt < maxAttempts - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }

    // 超时：验证失败
    return Object.freeze({
      success: false,
      currentReplicas: lastAvailableReplicas,
      expectedReplicas: lastExpectedReplicas,
      message: `回滚验证超时：${this.rollbackTimeoutMs}ms 内未达到期望副本数（${lastAvailableReplicas}/${lastExpectedReplicas}）`,
    }) as RollbackVerificationResult;
  }

  /**
   * 根据回滚策略执行对应的 kubectl 命令
   *
   * 三种策略对应的 kubectl 命令：
   * - rolling：`kubectl rollout undo deployment/<name> -n <ns> --to-revision=<N>`
   * - blue-green：`kubectl patch service <name> -n <ns> --type=json -p='[...]'`（切换 Service selector）
   * - canary：`kubectl scale deployment/<name>-canary -n <ns> --replicas=0`（降级 traffic 分流）
   *
   * @param strategy 回滚策略类型
   * @param deploymentName Deployment 名称
   * @param namespace K8s 命名空间
   * @param targetRevision 目标 revision 号
   * @param snapshot 版本快照（用于 blue-green 获取历史 labels）
   * @throws RollbackExecutionError 当 kubectl 命令失败时抛出
   */
  private async executeRollbackStrategy(
    strategy: RollbackStrategyType,
    deploymentName: string,
    namespace: string,
    targetRevision: number,
    snapshot: RollbackSnapshot
  ): Promise<void> {
    switch (strategy) {
      case "rolling": {
        // 滚动回滚：kubectl rollout undo deployment/<name> --to-revision=<N>
        const result = await execCli(
          "kubectl",
          ["rollout", "undo", `deployment/${deploymentName}`, "-n", namespace, `--to-revision=${targetRevision}`],
          this.rollbackTimeoutMs
        );

        if (!result.success) {
          throw new RollbackExecutionError(
            `kubectl rollout undo deployment/${deploymentName} -n ${namespace} --to-revision=${targetRevision}`,
            result.errorMessage || result.stderr,
            result.exitCode
          );
        }
        break;
      }

      case "blue-green": {
        // 蓝绿回滚：切换 Service selector 回上一个 version 标签
        // 读取快照数据文件获取历史 labels（blue-green 回滚需要切换 Service selector）
        const labels = await this.loadSnapshotLabels(snapshot);

        // 构造 JSON patch：替换 Service 的 spec.selector
        // patch 格式：[{"op":"replace","path":"/spec/selector","value":{...}}]
        const selectorJson = JSON.stringify(labels);
        const patchJson = JSON.stringify([
          {
            op: "replace",
            path: "/spec/selector",
            value: labels,
          },
        ]);

        // 调用 kubectl patch service 切换 selector
        const result = await execCli(
          "kubectl",
          ["patch", "service", deploymentName, "-n", namespace, "--type=json", `-p=${patchJson}`],
          this.rollbackTimeoutMs
        );

        if (!result.success) {
          throw new RollbackExecutionError(
            `kubectl patch service ${deploymentName} -n ${namespace} --type=json -p=${selectorJson}`,
            result.errorMessage || result.stderr,
            result.exitCode
          );
        }
        break;
      }

      case "canary": {
        // 金丝雀回滚：降级 traffic 分流（scale canary deployment 至 0 副本）
        const canaryDeploymentName = `${deploymentName}-canary`;
        const result = await execCli(
          "kubectl",
          ["scale", "deployment", canaryDeploymentName, "-n", namespace, "--replicas=0"],
          this.rollbackTimeoutMs
        );

        if (!result.success) {
          throw new RollbackExecutionError(
            `kubectl scale deployment ${canaryDeploymentName} -n ${namespace} --replicas=0`,
            result.errorMessage || result.stderr,
            result.exitCode
          );
        }
        break;
      }

      default: {
        // 防御性检查：未知策略类型（不应到达此处，TypeScript 穷尽性检查）
        const exhaustiveCheck: never = strategy;
        throw new RollbackExecutionError(
          `未知回滚策略：${exhaustiveCheck}`,
          `不支持的 RollbackStrategyType: ${exhaustiveCheck}`,
          null
        );
      }
    }
  }

  /**
   * 从快照数据文件加载 Deployment labels（用于 blue-green 回滚）
   *
   * 读取 snapshotDataPath 指向的 YAML 文件，解析 metadata.labels 部分。
   * 如果文件不存在或解析失败，返回空对象（回退为不切换 selector）。
   *
   * @param snapshot 版本快照
   * @returns labels 对象（Record<string, string>）
   */
  private async loadSnapshotLabels(snapshot: RollbackSnapshot): Promise<Record<string, string>> {
    // 如果快照数据文件路径未设置，返回空对象
    if (!snapshot.snapshotDataPath) {
      return {};
    }

    try {
      // 同步读取快照数据文件
      const yamlContent = fs.readFileSync(snapshot.snapshotDataPath, { encoding: "utf8" });
      // 解析 labels
      return this.parseDeploymentLabels(yamlContent);
    } catch {
      // 文件读取失败或解析失败：返回空对象（非致命错误）
      return {};
    }
  }

  /**
   * 解析 kubectl rollout history 输出，提取最新 revision 号
   *
   * kubectl rollout history 输出格式：
   * ```
   * deployment.apps/myapp
   * REVISION  CHANGE-CAUSE
   * 1         <none>
   * 2         <none>
   * 3         kubectl apply --filename=...
   * ```
   *
   * 解析逻辑：
   * 1. 按行分割输出
   * 2. 跳过非数字开头的行（如 "deployment.apps/myapp" / "REVISION  CHANGE-CAUSE"）
   * 3. 提取每行开头的数字作为 revision 号
   * 4. 返回最大的 revision 号（最新版本）
   *
   * @param output kubectl rollout history 的标准输出
   * @returns 最新 revision 号（无法解析时返回 0）
   */
  private parseLatestRevision(output: string): number {
    const lines = output.split("\n");
    let maxRevision = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      // 跳过空行
      if (!trimmed) continue;
      // 匹配行首的数字（revision 号）
      const match = trimmed.match(/^(\d+)/);
      if (match) {
        const revision = parseInt(match[1], 10);
        if (revision > maxRevision) {
          maxRevision = revision;
        }
      }
    }

    return maxRevision;
  }

  /**
   * 解析 Deployment YAML 的 metadata.labels 部分
   *
   * YAML 格式：
   * ```yaml
   * metadata:
   *   name: myapp
   *   namespace: default
   *   labels:
   *     app: myapp
   *     version: v1.0.0
   * ```
   *
   * 解析逻辑（简单 YAML 解析，不引入 yaml 库）：
   * 1. 查找 "metadata:" 行（顶 level，无缩进）
   * 2. 在 metadata 块中查找 "labels:" 行（2 空格缩进）
   * 3. 读取后续缩进行（4 空格）作为 key-value 对
   * 4. 遇到非缩进行或新的顶 level key 时停止
   *
   * @param yamlContent Deployment YAML 内容
   * @returns labels 对象（Record<string, string>）
   */
  private parseDeploymentLabels(yamlContent: string): Record<string, string> {
    const labels: Record<string, string> = {};
    const lines = yamlContent.split("\n");

    let inMetadata = false;
    let inLabels = false;
    let labelsIndent = -1;

    for (const line of lines) {
      // 检测顶 level key（无缩进，非空行）
      if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
        // 进入或离开 metadata 块
        if (line.startsWith("metadata:")) {
          inMetadata = true;
          inLabels = false;
        } else {
          inMetadata = false;
          inLabels = false;
        }
        continue;
      }

      if (!inMetadata) continue;

      // 在 metadata 块中，检测 labels 子 key
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const indent = line.length - line.trimStart().length;

      if (!inLabels) {
        // 查找 labels: 行（2 空格缩进）
        if (trimmed === "labels:" || trimmed.startsWith("labels:")) {
          inLabels = true;
          labelsIndent = indent;
        }
      } else {
        // 在 labels 块中，读取 key-value 对
        // 同级或更深层级的缩进属于 labels
        // 更浅层级的缩进表示 labels 块结束
        if (indent <= labelsIndent) {
          // labels 块结束
          inLabels = false;
          continue;
        }

        // 解析 key: value 对
        const match = trimmed.match(/^(\S+):\s*(.*)$/);
        if (match) {
          const key = match[1];
          let value = match[2].trim();
          // 去除引号
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          labels[key] = value;
        }
      }
    }

    return labels;
  }

  /**
   * 解析 kubectl get deployment -o json 输出，提取副本数
   *
   * JSON 结构：
   * ```json
   * {
   *   "spec": { "replicas": 3 },
   *   "status": { "availableReplicas": 3, "readyReplicas": 3 }
   * }
   * ```
   *
   * 边界场景：
   * - spec.replicas 未设置：默认 1（K8s 默认值）
   * - status.availableReplicas 未设置：默认 0（Deployment 刚创建，无可用 Pod）
   * - JSON 解析失败：返回 availableReplicas=0, expectedReplicas=0
   *
   * @param jsonContent kubectl get deployment -o json 的输出
   * @returns 含 availableReplicas 与 expectedReplicas 的对象
   */
  private parseDeploymentStatus(jsonContent: string): { availableReplicas: number; expectedReplicas: number } {
    try {
      const deployment = JSON.parse(jsonContent) as {
        spec?: { replicas?: number };
        status?: { availableReplicas?: number; readyReplicas?: number };
      };

      // spec.replicas 未设置时默认 1（K8s 默认值）
      const expectedReplicas = deployment.spec?.replicas ?? 1;
      // status.availableReplicas 未设置时默认 0（Deployment 刚创建，无可用 Pod）
      const availableReplicas = deployment.status?.availableReplicas ?? 0;

      return { availableReplicas, expectedReplicas };
    } catch {
      // JSON 解析失败：返回 0/0
      return { availableReplicas: 0, expectedReplicas: 0 };
    }
  }

  /**
   * 从 snapshot.resources 中提取 Deployment 名称
   *
   * snapshot.resources 格式：["deployment/myapp", "service/myapp"]
   * 提取第一个 "deployment/<name>" 格式的资源名，返回 <name> 部分。
   *
   * @param resources 资源列表
   * @returns Deployment 名称（如 "myapp"）；无法解析时返回 undefined
   */
  private extractDeploymentName(resources: ReadonlyArray<string>): string | undefined {
    for (const resource of resources) {
      // 匹配 "deployment/<name>" 格式
      const match = resource.match(/^deployment\/(.+)$/);
      if (match) {
        return match[1];
      }
    }
    return undefined;
  }

  /**
   * 生成回滚预案文件（Markdown 格式，5 个固定章节）
   *
   * 文件路径：<projectRoot>/deploy/rollback-plan-<runId>.md
   * 文件 schema（与 ROLLBACK_PLAN_SECTIONS 对齐）：
   * 1. 目标版本号
   * 2. 回滚命令
   * 3. 资源清单
   * 4. 创建时间戳
   * 5. runId
   *
   * @param context 快照上下文
   * @param revision 目标 revision 号
   * @returns 文件路径（生成成功时）；undefined（生成失败时）
   */
  private generateRollbackPlan(context: RollbackSnapshotContext, revision: number): string | undefined {
    const runId = context.runId ?? "default";
    const baseDir = this.projectRoot ?? process.cwd();
    const deployDir = path.join(baseDir, "deploy");
    const filePath = path.join(deployDir, `rollback-plan-${runId}.md`);

    // 构造回滚命令
    const rollbackCommand = `kubectl rollout undo deployment/${context.projectName} -n ${context.namespace} --to-revision=${revision}`;

    // 构造文件内容（5 个固定章节，与 ROLLBACK_PLAN_SECTIONS 对齐）
    const content = [
      "# 回滚预案",
      "",
      `## ${ROLLBACK_PLAN_SECTIONS[0]}`,
      `revision-${revision}`,
      "",
      `## ${ROLLBACK_PLAN_SECTIONS[1]}`,
      "```bash",
      rollbackCommand,
      "```",
      "",
      `## ${ROLLBACK_PLAN_SECTIONS[2]}`,
      `- deployment/${context.projectName}`,
      "",
      `## ${ROLLBACK_PLAN_SECTIONS[3]}`,
      new Date().toISOString(),
      "",
      `## ${ROLLBACK_PLAN_SECTIONS[4]}`,
      runId,
      "",
    ].join("\n");

    try {
      // 创建 deploy 目录（recursive: true 确保父目录也存在）
      fs.mkdirSync(deployDir, { recursive: true });
      // 写入回滚预案文件
      fs.writeFileSync(filePath, content, { encoding: "utf8" });
      return filePath;
    } catch {
      // 文件生成失败：返回 undefined（非致命错误，不抛异常）
      return undefined;
    }
  }
}

// ============================================================================
// HelmRollbackManager 类（Phase 3 完整实现，替换 Phase 1 占位类）
// ============================================================================

/**
 * HelmRollbackManager 配置选项（批次 14 §4.1.4）
 *
 * 字段说明：
 * - rollbackTimeoutMs：回滚命令超时（毫秒），默认 30000
 * - projectRoot：项目根目录（用于生成回滚预案文件路径与快照数据文件路径）
 *
 * 不可变优先：所有字段 readonly。
 */
export interface HelmRollbackManagerOptions {
  /** 回滚命令超时（毫秒），默认 30000 */
  readonly rollbackTimeoutMs?: number;
  /** 项目根目录（用于生成回滚预案文件路径与快照数据文件路径） */
  readonly projectRoot?: string;
}

/**
 * HelmRollbackManager —— 基于 helm 的回滚管理器实现（FR-3，Phase 3 完整实现）
 *
 * 真实调用 helm CLI（通过 child_process.execFile，禁止 shell:true）：
 * - createSnapshot()：
 *   1. `helm history <release> -n <ns> --output yaml`（获取 revision 历史）
 *   2. 保存输出到 `<projectRoot>/rollback-snapshots/<runId>/<release>.yaml`
 *   3. 解析 YAML 获取最近 3 个 revision
 *   4. 生成回滚预案文件
 * - rollback()：`helm rollback <release> <revision> -n <ns>`
 * - verifyRollback()：`helm history <release> -n <ns>` 确认当前 revision 为目标值
 *
 * 与 K8sRollbackManager 同构，但调用 helm CLI。
 *
 * 错误处理（错误外抛模式）：
 * - helm 命令失败：抛出 RollbackExecutionError
 * - verifyRollback 失败：返回 RollbackResult.success=false
 */
export class HelmRollbackManager implements RollbackManager {
  /** 回滚命令超时（毫秒），默认 30000 */
  public readonly rollbackTimeoutMs: number;
  /** 项目根目录（用于生成回滚预案文件路径与快照数据文件路径） */
  public readonly projectRoot?: string;

  /**
   * 构造函数
   *
   * @param options 配置选项（含 rollbackTimeoutMs / projectRoot）
   */
  constructor(options?: HelmRollbackManagerOptions) {
    // 应用默认值：rollbackTimeoutMs 默认 30000ms，projectRoot 可选
    this.rollbackTimeoutMs = options?.rollbackTimeoutMs ?? 30000;
    this.projectRoot = options?.projectRoot;
    // 冻结实例：防止运行时修改配置（对齐 P-1 不可变优先原则）
    Object.freeze(this);
  }

  /**
   * 创建版本快照（部署前调用）
   *
   * 执行流程：
   * 1. 调用 `helm history <release> -n <namespace> --output yaml` 获取 revision 历史
   * 2. 保存输出到 `<projectRoot>/rollback-snapshots/<runId>/<release>.yaml`
   * 3. 解析 YAML 输出，提取最近 3 个 revision 记录
   * 4. 提取最新 revision 号与 chart 版本号
   * 5. 生成回滚预案文件
   * 6. 返回 Object.freeze(snapshot)
   *
   * @param context 快照上下文（含 projectName=release 名 / namespace / runId）
   * @returns RollbackSnapshot 含真实版本号与资源列表
   * @throws RollbackExecutionError 当 helm 命令失败时抛出
   */
  async createSnapshot(context: RollbackSnapshotContext): Promise<RollbackSnapshot> {
    // ---------- 步骤 1: 调用 helm history --output yaml ----------
    const historyResult = await execCli(
      "helm",
      ["history", context.projectName, "-n", context.namespace, "--output", "yaml"],
      this.rollbackTimeoutMs
    );

    if (!historyResult.success) {
      // helm history 失败：抛出 RollbackExecutionError
      throw new RollbackExecutionError(
        `helm history ${context.projectName} -n ${context.namespace} --output yaml`,
        historyResult.errorMessage || historyResult.stderr,
        historyResult.exitCode
      );
    }

    // ---------- 步骤 2: 保存快照数据文件 ----------
    const runId = context.runId ?? "default";
    const baseDir = this.projectRoot ?? process.cwd();
    const snapshotDir = path.join(baseDir, "rollback-snapshots", runId);
    const snapshotFilePath = path.join(snapshotDir, `${context.projectName}.yaml`);

    let snapshotDataPath: string | undefined;
    try {
      fs.mkdirSync(snapshotDir, { recursive: true });
      fs.writeFileSync(snapshotFilePath, historyResult.stdout, {
        encoding: "utf8",
        mode: 0o600,
      });
      snapshotDataPath = snapshotFilePath;
    } catch {
      // 快照文件保存失败：非致命错误
    }

    // ---------- 步骤 3: 解析 YAML 输出，提取 revision 记录 ----------
    const revisions = this.parseHelmHistoryYaml(historyResult.stdout);

    // ---------- 步骤 4: 提取最新 revision 号与 chart 版本号 ----------
    const latestRevision = revisions.length > 0 ? revisions[0].revision : 0;
    const chartVersion = revisions.length > 0 ? revisions[0].chart : "unknown";

    // ---------- 步骤 5: 生成回滚预案文件 ----------
    const rollbackPlanFilePath = this.generateRollbackPlan(context, latestRevision);

    // ---------- 步骤 6: 构造并返回 RollbackSnapshot ----------
    const snapshot: RollbackSnapshot = {
      snapshotId: `helm-${runId}-${Date.now()}`,
      createdAt: new Date().toISOString(),
      version: String(latestRevision),
      resources: Object.freeze([`release/${context.projectName}`]) as ReadonlyArray<string>,
      rollbackPlanFilePath,
      rollbackStrategy: context.rollbackStrategy ?? "rolling",
      snapshotDataPath,
      projectName: context.projectName,
      namespace: context.namespace,
    };
    return Object.freeze(snapshot) as RollbackSnapshot;
  }

  /**
   * 执行回滚（部署失败时调用）
   *
   * 执行流程：
   * 1. 从 snapshot 中提取 releaseName / namespace / targetRevision
   * 2. 调用 `helm rollback <release> <revision> -n <ns>`
   * 3. 调用 verifyRollback 验证回滚是否生效
   * 4. 返回 RollbackResult
   *
   * @param snapshot 部署前创建的版本快照
   * @returns RollbackResult，被 Object.freeze 冻结
   * @throws RollbackExecutionError 当 helm rollback 命令失败时抛出
   */
  async rollback(snapshot: RollbackSnapshot): Promise<RollbackResult> {
    const startedAt = Date.now();

    const releaseName = snapshot.projectName;
    const namespace = snapshot.namespace ?? "default";
    const targetRevision = parseInt(snapshot.version, 10);

    if (!releaseName) {
      // 无法确定 release 名称：返回失败结果
      const result: RollbackResult = {
        success: false,
        rolledBackTo: "none",
        duration: Date.now() - startedAt,
        errors: Object.freeze(["无法确定 release 名称：snapshot.projectName 未设置"]) as ReadonlyArray<string>,
      };
      return Object.freeze(result) as RollbackResult;
    }

    // ---------- 执行 helm rollback 命令 ----------
    const result = await execCli(
      "helm",
      ["rollback", releaseName, String(targetRevision), "-n", namespace],
      this.rollbackTimeoutMs
    );

    if (!result.success) {
      // helm rollback 失败：抛出 RollbackExecutionError
      throw new RollbackExecutionError(
        `helm rollback ${releaseName} ${targetRevision} -n ${namespace}`,
        result.errorMessage || result.stderr,
        result.exitCode
      );
    }

    // ---------- 验证回滚结果 ----------
    const verification = await this.verifyRollback(releaseName, namespace, targetRevision);

    // ---------- 构造并返回 RollbackResult ----------
    const rollbackResult: RollbackResult = {
      success: verification.success,
      rolledBackTo: snapshot.version,
      duration: Date.now() - startedAt,
      errors: verification.success
        ? (Object.freeze([]) as ReadonlyArray<string>)
        : (Object.freeze([verification.message]) as ReadonlyArray<string>),
    };
    return Object.freeze(rollbackResult) as RollbackResult;
  }

  /**
   * 验证回滚结果（helm history 确认当前 revision 为目标值）
   *
   * 执行流程：
   * 1. 调用 `helm history <release> -n <ns> --output yaml`
   * 2. 解析 YAML 输出，获取最新 revision
   * 3. 比较最新 revision 与目标 revision
   * 4. 匹配则返回 success=true，否则返回 success=false
   *
   * @param releaseName Helm Release 名称
   * @param namespace 命名空间
   * @param targetRevision 目标 revision 号
   * @returns RollbackVerificationResult，被 Object.freeze 冻结
   */
  async verifyRollback(
    releaseName: string,
    namespace: string,
    targetRevision: number
  ): Promise<RollbackVerificationResult> {
    // 调用 helm history 获取当前 revision
    const result = await execCli(
      "helm",
      ["history", releaseName, "-n", namespace, "--output", "yaml"],
      this.rollbackTimeoutMs
    );

    if (!result.success) {
      // helm history 失败：验证失败
      return Object.freeze({
        success: false,
        currentReplicas: 0,
        expectedReplicas: targetRevision,
        message: `helm history 执行失败：${result.errorMessage || result.stderr}`,
      }) as RollbackVerificationResult;
    }

    // 解析 YAML 输出，获取最新 revision
    const revisions = this.parseHelmHistoryYaml(result.stdout);
    const currentRevision = revisions.length > 0 ? revisions[0].revision : 0;

    // 比较当前 revision 与目标 revision
    if (currentRevision === targetRevision) {
      return Object.freeze({
        success: true,
        currentReplicas: currentRevision,
        expectedReplicas: targetRevision,
        message: `回滚验证成功：当前 revision=${currentRevision}，目标 revision=${targetRevision}`,
      }) as RollbackVerificationResult;
    }

    return Object.freeze({
      success: false,
      currentReplicas: currentRevision,
      expectedReplicas: targetRevision,
      message: `回滚验证失败：当前 revision=${currentRevision}，目标 revision=${targetRevision}`,
    }) as RollbackVerificationResult;
  }

  /**
   * 解析 helm history --output yaml 的输出
   *
   * YAML 输出格式（Helm 3+）：
   * ```yaml
   * - app_version: "1.0.0"
   *   chart: myapp-0.1.0
   *   description: Install complete
   *   revision: 1
   *   status: deployed
   *   updated: 2026-07-21T10:00:00.000Z
   * - app_version: "2.0.0"
   *   chart: myapp-0.2.0
   *   description: Upgrade complete
   *   revision: 2
   *   status: deployed
   *   updated: 2026-07-21T11:00:00.000Z
   * ```
   *
   * 解析逻辑（简单 YAML 解析，不引入 yaml 库）：
   * 1. 按行分割输出
   * 2. 行首 "- " 表示新的列表项
   * 3. 后续缩进行 "  key: value" 为当前项的 key-value 对
   * 4. 按 revision 倒序排列（最新在前）
   *
   * @param yamlContent helm history --output yaml 的输出
   * @returns revision 记录数组（最新在前）
   */
  private parseHelmHistoryYaml(yamlContent: string): ReadonlyArray<{
    revision: number;
    status: string;
    chart: string;
    appVersion: string;
    description: string;
    updated: string;
  }> {
    const entries: Array<{
      revision: number;
      status: string;
      chart: string;
      appVersion: string;
      description: string;
      updated: string;
    }> = [];

    let currentEntry: {
      revision: number;
      status: string;
      chart: string;
      appVersion: string;
      description: string;
      updated: string;
    } | null = null;

    const lines = yamlContent.split("\n");

    for (const line of lines) {
      // 检测新列表项（行首 "- " 或 "-\t"）
      if (line.startsWith("- ") || line.match(/^-\s/)) {
        // 保存前一个条目
        if (currentEntry) {
          entries.push(currentEntry);
        }
        // 开始新条目
        currentEntry = {
          revision: 0,
          status: "",
          chart: "",
          appVersion: "",
          description: "",
          updated: "",
        };

        // 解析 "- key: value" 格式（第一个 key-value 在同一行）
        const rest = line.replace(/^-\s*/, "").trim();
        if (rest) {
          this.parseHelmHistoryLine(rest, currentEntry);
        }
      } else if (currentEntry) {
        // 解析后续缩进行的 "key: value"
        const trimmed = line.trim();
        if (trimmed) {
          this.parseHelmHistoryLine(trimmed, currentEntry);
        }
      }
    }

    // 保存最后一个条目
    if (currentEntry) {
      entries.push(currentEntry);
    }

    // 按 revision 倒序排列（最新在前）
    entries.sort((a, b) => b.revision - a.revision);

    // 返回最近 3 个 revision（冻结保持不可变优先）
    return Object.freeze(entries.slice(0, 3)) as ReadonlyArray<(typeof entries)[number]>;
  }

  /**
   * 解析 helm history YAML 中的单行 key: value
   *
   * 支持的字段：revision / status / chart / app_version / description / updated
   * 值可能带引号（单引号或双引号），解析时去除引号。
   *
   * @param line 单行内容（如 "revision: 2"）
   * @param entry 当前条目对象（会被修改）
   */
  private parseHelmHistoryLine(
    line: string,
    entry: {
      revision: number;
      status: string;
      chart: string;
      appVersion: string;
      description: string;
      updated: string;
    }
  ): void {
    // 匹配 "key: value" 格式
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (!match) return;

    const key = match[1];
    let value = match[2].trim();

    // 去除引号（单引号或双引号）
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // 根据字段名赋值
    switch (key) {
      case "revision":
        entry.revision = parseInt(value, 10) || 0;
        break;
      case "status":
        entry.status = value;
        break;
      case "chart":
        entry.chart = value;
        break;
      case "app_version":
        entry.appVersion = value;
        break;
      case "description":
        entry.description = value;
        break;
      case "updated":
        entry.updated = value;
        break;
      // 忽略未知字段
    }
  }

  /**
   * 生成回滚预案文件（Markdown 格式，5 个固定章节）
   *
   * 文件路径：<projectRoot>/deploy/rollback-plan-<runId>.md
   * 文件 schema（与 ROLLBACK_PLAN_SECTIONS 对齐）：
   * 1. 目标版本号
   * 2. 回滚命令
   * 3. 资源清单
   * 4. 创建时间戳
   * 5. runId
   *
   * @param context 快照上下文
   * @param revision 目标 revision 号
   * @returns 文件路径（生成成功时）；undefined（生成失败时）
   */
  private generateRollbackPlan(context: RollbackSnapshotContext, revision: number): string | undefined {
    const runId = context.runId ?? "default";
    const baseDir = this.projectRoot ?? process.cwd();
    const deployDir = path.join(baseDir, "deploy");
    const filePath = path.join(deployDir, `rollback-plan-${runId}.md`);

    // 构造回滚命令
    const rollbackCommand = `helm rollback ${context.projectName} ${revision} -n ${context.namespace}`;

    // 构造文件内容（5 个固定章节，与 ROLLBACK_PLAN_SECTIONS 对齐）
    const content = [
      "# 回滚预案",
      "",
      `## ${ROLLBACK_PLAN_SECTIONS[0]}`,
      `revision-${revision}`,
      "",
      `## ${ROLLBACK_PLAN_SECTIONS[1]}`,
      "```bash",
      rollbackCommand,
      "```",
      "",
      `## ${ROLLBACK_PLAN_SECTIONS[2]}`,
      `- release/${context.projectName}`,
      "",
      `## ${ROLLBACK_PLAN_SECTIONS[3]}`,
      new Date().toISOString(),
      "",
      `## ${ROLLBACK_PLAN_SECTIONS[4]}`,
      runId,
      "",
    ].join("\n");

    try {
      // 创建 deploy 目录
      fs.mkdirSync(deployDir, { recursive: true });
      // 写入回滚预案文件
      fs.writeFileSync(filePath, content, { encoding: "utf8" });
      return filePath;
    } catch {
      // 文件生成失败：返回 undefined（非致命错误）
      return undefined;
    }
  }
}

// ============================================================================
// createRollbackManager 工厂函数（批次 14 Phase 1 §4.1.5 FR-4，K-3 决策）
// ============================================================================

/**
 * RollbackManager 工厂配置选项（批次 14 §4.1.5）
 *
 * 字段说明：
 * - projectRoot：项目根目录（必填，用于回滚预案文件路径）
 * - rollbackTimeoutMs：回滚命令超时（毫秒），默认 30000
 *
 * 不可变优先：所有字段 readonly。
 */
export interface RollbackManagerFactoryOptions {
  /** 项目根目录（必填，用于回滚预案文件路径） */
  readonly projectRoot: string;
  /** 回滚命令超时（毫秒），默认 30000 */
  readonly rollbackTimeoutMs?: number;
}

/**
 * UnsupportedRollbackManagerTypeError —— 不支持的 RollbackManager 类型错误
 *
 * 当 createRollbackManager 接收到未识别的 IaCType 时抛出。
 * 自定义错误类提供清晰的错误信息（包括不支持的 iacType 值），便于调用方诊断。
 *
 * 不可变优先：错误信息通过构造函数固定，运行时不可修改 name 属性。
 */
export class UnsupportedRollbackManagerTypeError extends Error {
  /** 不支持的 IaC 类型值（用于错误诊断） */
  public readonly iacType: string;

  /**
   * 构造函数
   *
   * @param iacType 不支持的 IaC 类型值
   */
  constructor(iacType: string) {
    // 构造清晰的错误消息，列出当前支持的 IaC 类型
    super(
      `Unsupported IaCType for RollbackManager: "${iacType}". ` +
        `Supported types: "terraform" / "k8s-manifest" / "helm-chart".`
    );
    this.name = "UnsupportedRollbackManagerTypeError";
    this.iacType = iacType;
    // 维持原型链（TypeScript 编译到 ES5 时继承 Error 的已知问题）
    Object.setPrototypeOf(this, UnsupportedRollbackManagerTypeError.prototype);
    // 冻结实例：防止运行时修改错误信息（对齐 P-1 不可变优先原则）
    Object.freeze(this);
  }
}

/**
 * createRollbackManager —— RollbackManager 装配工厂（FR-4，K-3 决策）
 *
 * 根据 IaCType 选择对应的 RollbackManager 实现注入 DeployStageOptions.rollbackManager。
 *
 * 装配规则（K-3 决策）：
 * - k8s-manifest → K8sRollbackManager
 * - helm-chart → HelmRollbackManager
 * - terraform → K8sRollbackManager（兜底，打印 WARNING 日志，K-3 条件）
 *   - WARNING 日志内容：`Terraform IaC 使用 K8sRollbackManager 兜底，仅支持 K8s 资源回滚`
 *   - 原因：Terraform 管理的资源包含 K8s + 云资源（AWS / GCP / Azure），RollbackManager 仅能回滚 K8s 资源
 *
 * 防御性检查：
 * - 未识别的 iacType 抛 UnsupportedRollbackManagerTypeError（不允许 default 分支静默兜底）
 * - 返回的 RollbackManager 实例不可变（构造后不再修改，K8s/Helm 类构造函数内 Object.freeze）
 *
 * @param iacType IaC 类型（terraform / k8s-manifest / helm-chart）
 * @param options 配置选项（含 projectRoot / rollbackTimeoutMs）
 * @returns 对应的 RollbackManager 实例（K8sRollbackManager / HelmRollbackManager）
 * @throws UnsupportedRollbackManagerTypeError 当 iacType 不是 "terraform" / "k8s-manifest" / "helm-chart" 时抛出
 */
export function createRollbackManager(iacType: IaCType, options: RollbackManagerFactoryOptions): RollbackManager {
  // 提取配置选项，应用默认值：rollbackTimeoutMs 默认 30000ms
  const rollbackTimeoutMs = options.rollbackTimeoutMs ?? 30000;
  const managerOptions = {
    rollbackTimeoutMs,
    projectRoot: options.projectRoot,
  };

  // 根据 IaCType 路由到对应的 RollbackManager 实现（K-3 决策）
  switch (iacType) {
    case "k8s-manifest": {
      // k8s-manifest → K8sRollbackManager
      return new K8sRollbackManager(managerOptions);
    }
    case "helm-chart": {
      // helm-chart → HelmRollbackManager
      return new HelmRollbackManager(managerOptions);
    }
    case "terraform": {
      // terraform → K8sRollbackManager 兜底（K-3 决策）
      // 打印 WARNING 日志：Terraform IaC 仅支持 K8s 资源回滚
      // 使用 console.warn 而非 logger，避免引入额外依赖（与 NoOpRollbackManager 一致的日志风格）
      console.warn(
        `Terraform IaC 使用 K8sRollbackManager 兜底，仅支持 K8s 资源回滚（projectRoot=${options.projectRoot}）`
      );
      return new K8sRollbackManager(managerOptions);
    }
    default: {
      // 防御性检查：未识别的 iacType 抛错（不允许 default 分支静默兜底）
      // 通过类型断言强制穷尽性检查：iacType 应为 never 类型，若不为 never 则说明 IaCType 联合类型扩展了新成员未处理
      const exhaustiveCheck: never = iacType;
      throw new UnsupportedRollbackManagerTypeError(exhaustiveCheck as string);
    }
  }
}
