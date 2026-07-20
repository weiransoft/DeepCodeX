/**
 * PostDeployChecker —— 部署后检查器（EAG-P4 批次 13 Phase 4 D2-3）
 *
 * 核心职责：
 * - 校验部署后系统状态是否正常，确保部署成功且服务可用
 * - 校验 4 项：Pod 就绪 / Service 端点可达 / 日志无 ERROR / 指标上报正常
 * - M-1 修复：填充 endpoints 字段供 DevOpsOrchestrator 构造 HealthCheckResult
 *
 * 真实 CLI 调用（对齐 P-5 测试不使用 mock）：
 * - kubectl get pods -n <ns> -o json：校验所有 Pod status.phase === "Running"
 * - kubectl get svc <name> -n <ns> -o json：获取 Service ClusterIP 和 Port
 * - kubectl logs -n <ns> --all-containers=true --tail=1000：检查日志含 "ERROR"
 * - kubectl get --raw /metrics：校验指标端点可达
 *
 * TCP 端口可达性检测（P-2 零新增依赖）：
 * - 使用 node:net.Socket 发起 TCP 连接检测端口可达性
 * - 不引入 http 模块，保持零新增依赖原则
 * - 超时 5 秒，避免长时间阻塞
 *
 * 不可变优先（§5.12.4 G-A6d）：
 * - check() 返回的 PostDeployCheckResult 对象通过 Object.freeze 冻结
 * - endpoints 数组和 failures 数组通过 Object.freeze 冻结
 * - HealthEndpoint 对象通过 Object.freeze 冻结
 *
 * CLI 降级策略：
 * - kubectl 命令不存在时（spawn error），对应校验项返回 false
 * - 不抛异常，保证 check() 始终返回结构化结果
 *
 * 设计依据：
 * - EAG-P4 批次 13 设计文档 §4.4 PostDeployChecker 实现
 * - §3.7.2 PostDeployChecker 接口定义（types.ts）
 * - M-1 修复：填充 endpoints 字段（设计文档 §4.4 L3354-L3371）
 * - §5.12.4 G-A6d 不可变优先原则
 *
 * 文件位置：packages/core/src/eag/deploy/post-deploy-checker.ts
 *
 * @module eag/deploy/post-deploy-checker
 */

import { spawn } from "node:child_process";
import type {
  PostDeployChecker,
  PostDeployCheckContext,
  PostDeployCheckResult,
  HealthEndpoint,
  DeployedResource,
} from "../devops/types";

// ============================================================================
// PostDeployCheckerImpl 类
// ============================================================================

/**
 * PostDeployChecker 实现类
 *
 * 校验 4 项部署后状态：
 * 1. Pod 就绪（podsReady）：调用 kubectl get pods -n <ns> -o json，解析 JSON 验证所有 Pod status.phase === "Running"
 * 2. Service 端点可达（serviceEndpointReachable）：M-1 修复，返回 HealthEndpoint
 *    - 调用 kubectl get svc <name> -n <ns> -o json 获取 ClusterIP 和 Port
 *    - 通过 node:net Socket 发起 TCP 连接检测端口可达性
 * 3. 日志无 ERROR（logsClean）：调用 kubectl logs -n <ns> --all-containers=true --tail=1000，检查输出含 "ERROR"
 * 4. 指标上报正常（metricsReporting）：调用 kubectl get --raw /metrics，验证指标端点可达
 *
 * M-1 修复说明（填充 endpoints 字段）：
 * - 原实现 checkServiceEndpoint 返回 boolean，DevOpsOrchestrator 无法获取健康端点详情
 * - 修复方案：checkServiceEndpoint 返回 HealthEndpoint 对象（含 url / statusCode / responseTimeMs / healthy）
 * - DevOpsOrchestrator 从 PostDeployCheckResult.endpoints 字段填充 HealthCheckResult.endpoints
 *
 * 使用方式：
 *   const checker = new PostDeployCheckerImpl();
 *   const result = await checker.check(context);
 *   if (!result.passed) {
 *     // 部署后检查未通过，触发回滚或提示用户修复
 *   }
 *   // result.endpoints 可用于构造 HealthCheckResult
 */
export class PostDeployCheckerImpl implements PostDeployChecker {
  /**
   * 执行部署后检查
   *
   * 检查顺序（非短路求值，收集全部失败项）：
   * 1. Pod 就绪——kubectl get pods -n <ns> -o json
   * 2. Service 端点可达——kubectl get svc + TCP 连接检测（M-1 修复：返回 HealthEndpoint）
   * 3. 日志无 ERROR——kubectl logs -n <ns> --all-containers=true --tail=1000
   * 4. 指标上报正常——kubectl get --raw /metrics
   *
   * 非短路求值理由：
   * - 部署后检查失败后，用户希望一次性看到所有未通过项，便于批量修复
   * - 避免多次往返触发部署
   *
   * M-1 修复：同时收集 HealthEndpoint 到 endpoints 数组，供 DevOpsOrchestrator 构造 HealthCheckResult
   *
   * @param context 检查上下文（含 namespace / serviceName / deployedResources）
   * @returns PostDeployCheckResult，含 4 项校验状态 + endpoints 健康端点列表 + failures 失败项列表
   */
  public async check(context: PostDeployCheckContext): Promise<PostDeployCheckResult> {
    // 收集全部失败项（非短路求值，便于用户一次性修复）
    const failures: string[] = [];
    // 收集健康端点列表（M-1 修复：供 DevOpsOrchestrator 构造 HealthCheckResult）
    const endpoints: HealthEndpoint[] = [];

    // 校验 1: Pod 就绪
    // P1-1 修复：先通过 deployedResources 预校验，再调用 kubectl 真实校验
    // 预校验逻辑：如果 deployedResources 中存在 status="Failed" 的资源，直接判定 Pod 未就绪，
    // 避免不必要的 kubectl 调用（性能优化 + 使用 deployedResources 字段）
    // 真实校验：调用 kubectl get pods -n <ns> -o json，解析 JSON 验证所有 Pod status.phase === "Running"
    const podsReady = await this.checkPodsReady(context.namespace, context.deployedResources);
    if (!podsReady) {
      failures.push(`Pod 未就绪（命名空间 ${context.namespace}）`);
    }

    // 校验 2: Service 端点可达（M-1 修复：同时收集 HealthEndpoint）
    // 调用 kubectl get svc <name> -n <ns> -o json 获取 ClusterIP 和 Port
    // 然后通过 node:net Socket 发起 TCP 连接检测端口可达性
    const serviceEndpoint = await this.checkServiceEndpoint(context.namespace, context.serviceName);
    const serviceEndpointReachable = serviceEndpoint.healthy;
    // M-1 修复：将 HealthEndpoint 加入 endpoints 列表
    endpoints.push(serviceEndpoint);
    if (!serviceEndpointReachable) {
      failures.push(`Service ${context.serviceName} 端点不可达`);
    }

    // 校验 3: 日志无 ERROR
    // 调用 kubectl logs -n <ns> --all-containers=true --tail=1000，检查输出含 "ERROR"
    const logsClean = await this.checkLogsClean(context.namespace);
    if (!logsClean) {
      failures.push(`日志含 ERROR（命名空间 ${context.namespace}）`);
    }

    // 校验 4: 指标上报正常
    // 调用 kubectl get --raw /metrics，验证指标端点可达
    const metricsReporting = await this.checkMetricsReporting(context.namespace);
    if (!metricsReporting) {
      failures.push(`指标上报异常（命名空间 ${context.namespace}）`);
    }

    // 计算是否全部通过
    const passed = failures.length === 0;

    // 构造检查结果（不可变优先：对象和数组均通过 Object.freeze 冻结）
    return Object.freeze({
      passed,
      podsReady,
      serviceEndpointReachable,
      logsClean,
      metricsReporting,
      endpoints: Object.freeze(endpoints) as ReadonlyArray<HealthEndpoint>,
      failures: Object.freeze(failures) as ReadonlyArray<string>,
    }) as PostDeployCheckResult;
  }

  /**
   * 检查 Pod 是否就绪（P1-1 修复：使用 deployedResources 进行预校验）
   *
   * 预校验逻辑（P1-1 修复）：
   * - 检查 deployedResources 中是否存在 status="Failed" 的资源
   * - 如果存在 Failed 资源，直接返回 false，避免不必要的 kubectl 调用
   * - 预校验通过后再调用 kubectl 进行真实校验
   *
   * 真实校验逻辑：
   * - 调用 `kubectl get pods -n <ns> -o json`，解析 JSON 验证所有 Pod status.phase === "Running"
   *
   * 校验顺序：
   * 1. 预校验：deployedResources 含 Failed 资源 → 返回 false（快速失败）
   * 2. 命令退出码非 0 → 返回 false（kubectl 失败或 namespace 不存在）
   * 3. JSON 解析失败 → 返回 false
   * 4. Pod 列表为空 → 返回 false（无 Pod 运行）
   * 5. 所有 Pod status.phase === "Running" → 返回 true
   * 6. 存在非 Running 状态的 Pod → 返回 false
   *
   * @param namespace 命名空间
   * @param deployedResources 已部署资源列表（来自 DeployResult.resources，用于预校验）
   * @returns true=所有 Pod 就绪；false=Pod 未就绪或 kubectl 不可用
   */
  private async checkPodsReady(
    namespace: string,
    deployedResources: ReadonlyArray<DeployedResource>
  ): Promise<boolean> {
    // P1-1 修复：预校验 deployedResources 中是否存在 Failed 状态的资源
    // 如果存在 Failed 资源，直接返回 false，避免不必要的 kubectl 调用（性能优化）
    const hasFailedResource = deployedResources.some((resource: DeployedResource) => resource.status === "Failed");
    if (hasFailedResource) {
      return false;
    }

    return new Promise((resolve) => {
      // 启动 kubectl get pods 子进程（-o json 输出 JSON 格式，便于解析）
      const child = spawn("kubectl", ["get", "pods", "-n", namespace, "-o", "json"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      let stdout = "";
      // 捕获 stdout 输出（JSON 格式）
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      // 子进程正常退出
      child.on("close", (code: number | null) => {
        if (code !== 0) {
          // kubectl 失败或 namespace 不存在
          resolve(false);
          return;
        }
        try {
          // 解析 JSON 输出
          const data = JSON.parse(stdout);
          const pods = data.items || [];
          if (pods.length === 0) {
            // 无 Pod 运行
            resolve(false);
            return;
          }
          // 验证所有 Pod status.phase === "Running"
          const allRunning = pods.every((pod: { status?: { phase?: string } }) => pod.status?.phase === "Running");
          resolve(allRunning);
        } catch {
          // JSON 解析失败
          resolve(false);
        }
      });

      // 子进程启动失败（如 kubectl 命令不存在）：返回 false
      child.on("error", () => {
        resolve(false);
      });
    });
  }

  /**
   * 检查 Service 端点是否可达（M-1 修复：返回 HealthEndpoint 而非 boolean）
   *
   * 实现步骤：
   * 1. 调用 kubectl get svc <name> -n <ns> -o json 获取 Service 的 ClusterIP 和 Port
   * 2. 通过 node:net Socket 发起 TCP 连接检测端口可达性
   * 3. 构造 HealthEndpoint 返回（含 url / statusCode / responseTimeMs / healthy）
   *
   * M-1 修复说明：
   * - 原实现返回 boolean，DevOpsOrchestrator 无法获取健康端点详情
   * - 修复后返回 HealthEndpoint 对象，供 DevOpsOrchestrator 构造 HealthCheckResult.endpoints
   *
   * TCP 连接检测（P-2 零新增依赖）：
   * - 使用 node:net.Socket 发起 TCP 连接
   * - 超时 5 秒，避免长时间阻塞
   * - 连接成功 = 端口可达；超时或错误 = 端口不可达
   *
   * @param namespace 命名空间
   * @param serviceName Service 名称
   * @returns HealthEndpoint 含 url / statusCode / responseTimeMs / healthy
   */
  private async checkServiceEndpoint(namespace: string, serviceName: string): Promise<HealthEndpoint> {
    const startedAt = Date.now();

    // 先调用 kubectl 获取 Service 的 ClusterIP 和 Port
    const serviceInfo = await this.getServiceInfo(namespace, serviceName);
    if (!serviceInfo) {
      // Service 不存在或解析失败：返回不可达的 HealthEndpoint
      return Object.freeze({
        url: `kubectl://${namespace}/${serviceName}`,
        statusCode: 0,
        responseTimeMs: Date.now() - startedAt,
        healthy: false,
      }) as HealthEndpoint;
    }

    // 通过 TCP 连接检测端口可达性（不引入 http 模块，保持 P-2 零新增依赖）
    const net = await import("node:net");
    const url = `tcp://${serviceInfo.clusterIP}:${serviceInfo.port}`;
    const healthy = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      const timeout = 5000; // 5 秒超时，避免长时间阻塞
      socket.setTimeout(timeout);

      // 连接成功 = 端口可达
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });

      // 超时 = 端口不可达
      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });

      // 连接错误 = 端口不可达
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });

      // 发起 TCP 连接
      socket.connect(serviceInfo.port, serviceInfo.clusterIP);
    });

    // 构造 HealthEndpoint（TCP 可达视为 200，不可达视为 0）
    return Object.freeze({
      url,
      statusCode: healthy ? 200 : 0,
      responseTimeMs: Date.now() - startedAt,
      healthy,
    }) as HealthEndpoint;
  }

  /**
   * 获取 Service 的 ClusterIP 和 Port
   *
   * 调用 `kubectl get svc <name> -n <ns> -o json`，解析 spec.clusterIP 和 spec.ports[0].port
   *
   * 解析逻辑：
   * 1. 命令退出码非 0 → 返回 null（Service 不存在）
   * 2. JSON 解析失败 → 返回 null
   * 3. spec.clusterIP 或 spec.ports[0].port 不存在 → 返回 null
   * 4. 解析成功 → 返回 { clusterIP, port }（Object.freeze 冻结）
   *
   * @param namespace 命名空间
   * @param serviceName Service 名称
   * @returns { clusterIP, port } 或 null（Service 不存在或解析失败）
   */
  private async getServiceInfo(
    namespace: string,
    serviceName: string
  ): Promise<{ readonly clusterIP: string; readonly port: number } | null> {
    return new Promise((resolve) => {
      // 启动 kubectl get svc 子进程（-o json 输出 JSON 格式）
      const child = spawn("kubectl", ["get", "svc", serviceName, "-n", namespace, "-o", "json"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      let stdout = "";
      // 捕获 stdout 输出（JSON 格式）
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      // 子进程正常退出
      child.on("close", (code: number | null) => {
        if (code !== 0) {
          // Service 不存在
          resolve(null);
          return;
        }
        try {
          // 解析 JSON 输出
          const data = JSON.parse(stdout);
          const clusterIP = data.spec?.clusterIP;
          const port = data.spec?.ports?.[0]?.port;
          if (!clusterIP || typeof port !== "number") {
            // clusterIP 或 port 不存在
            resolve(null);
            return;
          }
          // 返回冻结的 serviceInfo 对象（不可变优先）
          resolve(Object.freeze({ clusterIP, port }) as { readonly clusterIP: string; readonly port: number });
        } catch {
          // JSON 解析失败
          resolve(null);
        }
      });

      // 子进程启动失败（如 kubectl 命令不存在）：返回 null
      child.on("error", () => {
        resolve(null);
      });
    });
  }

  /**
   * 检查日志是否无 ERROR
   *
   * 调用 `kubectl logs -n <ns> --all-containers=true --tail=1000`，检查输出含 "ERROR"
   *
   * 校验逻辑：
   * 1. 命令退出码非 0 → 返回 false（kubectl 失败或 namespace 不存在）
   * 2. 输出含 "ERROR" → 返回 false（日志有错误）
   * 3. 输出不含 "ERROR" → 返回 true（日志干净）
   *
   * 参数说明：
   * - --all-containers=true：获取 namespace 下所有 Pod 的所有容器日志
   * - --tail=1000：仅获取最后 1000 行日志，避免大量日志输出
   *
   * @param namespace 命名空间
   * @returns true=日志无 ERROR；false=日志含 ERROR 或 kubectl 不可用
   */
  private async checkLogsClean(namespace: string): Promise<boolean> {
    return new Promise((resolve) => {
      // 启动 kubectl logs 子进程
      const child = spawn("kubectl", ["logs", "-n", namespace, "--all-containers=true", "--tail=1000"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      let stdout = "";
      // 捕获 stdout 输出（日志内容）
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      // 子进程正常退出
      child.on("close", (code: number | null) => {
        if (code !== 0) {
          // kubectl 失败或 namespace 不存在
          resolve(false);
          return;
        }
        // 检查日志是否含 "ERROR"
        resolve(!stdout.includes("ERROR"));
      });

      // 子进程启动失败（如 kubectl 命令不存在）：返回 false
      child.on("error", () => {
        resolve(false);
      });
    });
  }

  /**
   * 检查指标上报是否正常
   *
   * 调用 `kubectl get --raw /metrics`，验证 K8s API server 的全局 /metrics 端点可达
   *
   * 校验逻辑：
   * 1. 命令退出码 0 → 返回 true（指标端点可达）
   * 2. 非 0 退出码 → 返回 false（指标端点不可达）
   * 3. spawn error → 返回 false（kubectl 不可用）
   *
   * 说明：
   * - kubectl get --raw /metrics 直接访问 K8s API server 的 /metrics 端点
   * - 该端点返回 Prometheus 格式的全局指标数据（包含 K8s 控制平面指标）
   * - 批次 13 仅校验端点可达性，不解析指标数据
   *
   * P1-3 修复（namespace 参数语义澄清）：
   * - kubectl get --raw /metrics 是全局指标端点，不支持 namespace 级别过滤
   * - 批次 13 中 namespace 参数未被使用（仅作为方法签名的占位，保持调用一致性）
   * - 批次 14 扩展方向（namespace 级别指标校验）：
   *   1. 通过 Prometheus 查询 namespace 级别指标（如 up{namespace="<ns>"}）
   *   2. 通过 kubectl top pods -n <ns> 校验 Pod 级别资源使用率
   *   3. 通过 Service Monitor / Pod Monitor 校验自定义指标采集
   *
   * @param namespace 命名空间（批次 13 未使用，详见上方 P1-3 修复说明）
   * @returns true=指标端点可达；false=指标端点不可达或 kubectl 不可用
   */
  private async checkMetricsReporting(namespace: string): Promise<boolean> {
    // P1-3 修复：namespace 参数在批次 13 中未使用（kubectl --raw /metrics 是全局端点）
    // 批次 14 扩展时改用 Prometheus 查询或 kubectl top 实现 namespace 级别指标校验
    void namespace;

    return new Promise((resolve) => {
      // 启动 kubectl get --raw /metrics 子进程
      const child = spawn("kubectl", ["get", "--raw", "/metrics"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      // 子进程正常退出：退出码 0 = 指标端点可达
      child.on("close", (code: number | null) => {
        resolve(code === 0);
      });

      // 子进程启动失败（如 kubectl 命令不存在）：返回 false
      child.on("error", () => {
        resolve(false);
      });
    });
  }
}
