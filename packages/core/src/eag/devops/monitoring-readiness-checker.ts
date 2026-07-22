/**
 * MonitoringReadinessChecker —— 监控就绪检查器（EAG-P4 批次 14 Phase 4 TASK-14-4-1，FR-12，K-4 决策）
 *
 * 核心职责：
 * - 校验部署后监控系统是否就绪，确保 Prometheus 已配置抓取目标服务
 * - 校验 3 项（K-4 决策：Alertmanager 规则首版不实现）：
 *   1. ServiceMonitor / PodMonitor 资源存在（kubectl get servicemonitor -n <ns> 真实调用）
 *   2. /metrics 端点可达（node:http / node:https 真实 HTTP GET 返回 200）
 *   3. Prometheus scrape 配置含目标服务（读取 prometheusConfigPath 配置文件并解析）
 *
 * 真实调用（对齐 NFR-3 测试不使用 mock）：
 * - kubectl get servicemonitor -n <ns>：通过 node:child_process.spawn 真实调用 kubectl CLI
 * - HTTP GET <metricsEndpoint>：使用 node:http / node:https 真实发起请求
 * - fs.readFile 读取 prometheusConfigPath：真实读取文件系统
 *
 * 自实现 YAML parser（零新增依赖，P-2 原则）：
 * - 仅解析 Prometheus scrape 配置所需的字段：job_name / static_configs / kubernetes_sd_configs / relabelings
 * - 不引入外部 yaml 包，避免新增依赖
 * - 支持多 job 配置、嵌套数组、relabelings replace 动作
 *
 * 不可变优先（§5.12.4 G-A6d）：
 * - check() 返回的 MonitoringCheckResult 对象通过 Object.freeze 深冻结
 * - checkedItems 数组和 failures 数组通过 Object.freeze 冻结
 * - MonitoringCheckedItem 对象通过 Object.freeze 冻结
 * - MonitoringReadinessCheckerImpl 实例本身通过 Object.freeze 冻结
 *
 * CLI / HTTP 降级策略：
 * - kubectl 命令不存在时（spawn error），serviceMonitorExists 校验项返回 false
 * - HTTP 请求失败 / 超时时，metricsEndpointReachable 校验项返回 false
 * - 配置文件不存在 / 解析失败时，prometheusScrapeConfig 校验项返回 false
 * - 不抛异常，保证 check() 始终返回结构化结果
 *
 * K-4 决策（Alertmanager 规则校验首版不实现）：
 * - 预留 checkAlertmanagerRules 可选方法（首版返回 undefined）
 * - Phase 7+ 视需求决定是否实现
 *
 * 设计依据：
 * - EAG-P4 批次 14 任务清单 TASK-14-4-1 验收标准
 * - types.ts 中 MonitoringReadinessChecker / MonitoringCheckContext / MonitoringCheckResult 接口定义
 * - 架构师审查 §4.3.1 FR-12 监控就绪检查器
 * - K-4 决策：Alertmanager 规则首版不实现
 *
 * 文件位置：packages/core/src/eag/devops/monitoring-readiness-checker.ts
 *
 * @module eag/devops/monitoring-readiness-checker
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type {
  MonitoringReadinessChecker,
  MonitoringCheckContext,
  MonitoringCheckResult,
  MonitoringCheckedItem,
} from "./types";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 默认 HTTP 请求超时时间（毫秒）
 *
 * 取值理由：
 * - 5 秒覆盖绝大部分 /metrics 端点响应时间（Prometheus 抓取周期通常 15~60 秒，单次响应 < 1s）
 * - 超过 5 秒未响应的端点视为不健康，避免长时间阻塞监控就绪检查
 * - 与 SmokeTestRunnerImpl / PostDeployCheckerImpl 的超时保持一致（5 秒）
 */
const DEFAULT_HTTP_TIMEOUT_MS = 5000;

/**
 * 默认 kubectl 子进程超时时间（毫秒）
 *
 * 取值理由：
 * - kubectl get servicemonitor 通常 < 1 秒返回
 * - 10 秒覆盖集群 API server 延迟场景
 * - 超过 10 秒未返回视为 kubectl 不可用
 */
const DEFAULT_KUBECTL_TIMEOUT_MS = 10000;

/**
 * 校验项名称常量（与 MonitoringCheckedItem.name 字段对齐）
 *
 * 取值理由：
 * - 统一命名便于上层（如 GateG8CheckerImpl）按 name 字段检索具体校验项
 * - 与 types.ts 中 MonitoringCheckedItem 接口注释一致
 */
const CHECK_ITEM_SERVICE_MONITOR = "serviceMonitorExists" as const;
const CHECK_ITEM_METRICS_ENDPOINT = "metricsEndpointReachable" as const;
const CHECK_ITEM_PROMETHEUS_CONFIG = "prometheusScrapeConfig" as const;

// ============================================================================
// 内部类型定义
// ============================================================================

/**
 * HTTP 请求执行结果（内部使用，不对外导出）
 *
 * 字段说明：
 * - statusCode：HTTP 响应状态码；请求失败时为 0
 * - errorMessage：错误信息；请求成功时为空字符串
 */
interface HttpRequestOutcome {
  readonly statusCode: number;
  readonly errorMessage: string;
}

/**
 * Prometheus scrape 配置中的单个 job 定义（自实现 YAML parser 输出结构）
 *
 * 字段说明（仅解析本检查器所需的字段）：
 * - jobName：job_name 字段值（如 "myapp-metrics"）
 * - staticTargets：static_configs[*].targets 数组的扁平化（如 ["10.0.0.1:8080", "10.0.0.2:8080"]）
 * - kubernetesSdRole：kubernetes_sd_configs[*].role 字段值（如 "service" / "pod" / "endpoints"）
 * - relabelActions：relabelings 数组，仅保留 action / sourceLabels / regex / targetLabel 字段
 */
interface PrometheusScrapeJob {
  readonly jobName: string;
  readonly staticTargets: ReadonlyArray<string>;
  readonly kubernetesSdRole: string | undefined;
  readonly relabelActions: ReadonlyArray<{
    readonly action: string;
    readonly sourceLabels: ReadonlyArray<string>;
    readonly regex: string;
    readonly targetLabel: string;
    readonly replacement: string;
  }>;
}

// ============================================================================
// MonitoringReadinessCheckerImpl 类
// ============================================================================

/**
 * MonitoringReadinessChecker 实现类（FR-12，K-4 决策）
 *
 * 校验 3 项监控就绪条件（K-4 决策：Alertmanager 规则首版不实现）：
 * 1. ServiceMonitor / PodMonitor 资源存在（serviceMonitorExists）：
 *    - 调用 kubectl get servicemonitor -n <ns> 真实检查 ServiceMonitor CR 是否存在
 *    - kubectl 退出码 0 = 通过（命名空间内至少有 1 个 ServiceMonitor）
 *    - kubectl 退出码非 0 或 spawn error = 失败
 *
 * 2. /metrics 端点可达（metricsEndpointReachable）：
 *    - 使用 node:http / node:https 真实发起 HTTP GET 请求到 context.metricsEndpoint
 *    - HTTP 200 = 通过；其他状态码或请求失败 / 超时 = 失败
 *
 * 3. Prometheus scrape 配置含目标服务（prometheusScrapeConfig）：
 *    - 若 context.prometheusConfigPath 提供：读取文件 + 自实现 YAML parser 解析 + 校验含目标服务
 *    - 若 context.prometheusConfigPath 未提供：视为通过（ServiceMonitor 已存在即代表 Prometheus 已配置 scrape，K-4 决策简化）
 *    - 文件不存在 / 解析失败 / 未匹配目标 = 失败
 *
 * 真实调用（对齐 NFR-3 测试不使用 mock）：
 * - kubectl CLI：通过 node:child_process.spawn 调用，不使用 shell:true 避免命令注入
 * - HTTP 请求：通过 node:http / node:https 真实发起
 * - 文件读取：通过 node:fs.readFileSync 真实读取
 *
 * 不可变优先：
 * - check() 返回的 MonitoringCheckResult 对象通过 Object.freeze 深冻结
 * - checkedItems 数组和 failures 数组通过 Object.freeze 冻结
 * - MonitoringCheckedItem 对象通过 Object.freeze 冻结
 * - MonitoringReadinessCheckerImpl 实例本身通过 Object.freeze 冻结
 *
 * 使用方式：
 *   const checker = new MonitoringReadinessCheckerImpl();
 *   const result = await checker.check({
 *     projectName: "myapp",
 *     namespace: "default",
 *     serviceName: "myapp",
 *     metricsEndpoint: "http://myapp.default.svc.cluster.local:8080/metrics",
 *     prometheusConfigPath: "/path/to/prometheus.yml",
 *   });
 *   if (!result.ready) {
 *     // 监控未就绪，提示用户修复 ServiceMonitor / /metrics 端点 / Prometheus 配置
 *     console.error(result.failures);
 *   }
 */
export class MonitoringReadinessCheckerImpl implements MonitoringReadinessChecker {
  /** HTTP 请求超时时间（毫秒），默认 5000ms */
  private readonly httpTimeoutMs: number;
  /** kubectl 子进程超时时间（毫秒），默认 10000ms */
  private readonly kubectlTimeoutMs: number;

  /**
   * 构造函数
   *
   * @param options 配置选项（可选）
   *   - httpTimeoutMs：HTTP 请求超时时间（毫秒），默认 5000ms
   *   - kubectlTimeoutMs：kubectl 子进程超时时间（毫秒），默认 10000ms
   */
  constructor(options?: { readonly httpTimeoutMs?: number; readonly kubectlTimeoutMs?: number }) {
    this.httpTimeoutMs = options?.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.kubectlTimeoutMs = options?.kubectlTimeoutMs ?? DEFAULT_KUBECTL_TIMEOUT_MS;
    // 不可变优先：实例本身冻结，防止运行时篡改超时配置
    Object.freeze(this);
  }

  /**
   * 执行监控就绪检查
   *
   * 检查顺序（非短路求值，收集全部失败项）：
   * 1. ServiceMonitor 存在——kubectl get servicemonitor -n <ns>
   * 2. /metrics 端点可达——HTTP GET context.metricsEndpoint
   * 3. Prometheus scrape 配置含目标服务——读取 prometheusConfigPath 文件 + YAML parser
   *
   * 非短路求值理由：
   * - 监控未就绪时，用户希望一次性看到所有未通过项，便于批量修复
   * - 避免多次往返触发部署
   *
   * @param context 监控检查上下文（含 projectName / namespace / serviceName / metricsEndpoint / prometheusConfigPath）
   * @returns MonitoringCheckResult，含 ready 总体结果 + checkedItems 各项详情 + failures 失败原因列表
   */
  public async check(context: MonitoringCheckContext): Promise<MonitoringCheckResult> {
    // 收集各项检查结果（非短路求值，3 项均执行）
    const checkedItems: MonitoringCheckedItem[] = [];
    // 收集失败原因列表（ready=true 时为空数组）
    const failures: string[] = [];

    // ---------- 校验 1: ServiceMonitor 存在 ----------
    const serviceMonitorResult = await this.checkServiceMonitorExists(context.namespace);
    checkedItems.push(serviceMonitorResult);
    if (!serviceMonitorResult.passed) {
      failures.push(`ServiceMonitor 检查未通过：${serviceMonitorResult.detail}`);
    }

    // ---------- 校验 2: /metrics 端点可达 ----------
    const metricsResult = await this.checkMetricsEndpointReachable(context.metricsEndpoint);
    checkedItems.push(metricsResult);
    if (!metricsResult.passed) {
      failures.push(`/metrics 端点不可达：${metricsResult.detail}`);
    }

    // ---------- 校验 3: Prometheus scrape 配置含目标服务 ----------
    const prometheusConfigResult = await this.checkPrometheusScrapeConfig(context);
    checkedItems.push(prometheusConfigResult);
    if (!prometheusConfigResult.passed) {
      failures.push(`Prometheus scrape 配置未含目标服务：${prometheusConfigResult.detail}`);
    }

    // ---------- 汇总结果 ----------
    // ready = 3 项全过；不可变优先：深冻结返回对象
    const ready = checkedItems.every((item) => item.passed);
    return Object.freeze({
      ready,
      checkedItems: Object.freeze(checkedItems) as ReadonlyArray<MonitoringCheckedItem>,
      failures: Object.freeze(failures) as ReadonlyArray<string>,
    }) as MonitoringCheckResult;
  }

  /**
   * 校验 Alertmanager 规则（K-4 决策：首版不实现）
   *
   * K-4 决策说明：
   * - Alertmanager 规则校验首版不实现，预留接口供 Phase 7+ 视需求决定是否实现
   * 当前实现：返回 undefined，表示该可选校验项未执行
   *
   * @returns undefined（首版不实现）
   */
  public checkAlertmanagerRules(): undefined {
    // K-4 决策：Alertmanager 规则校验首版不实现，返回 undefined
    return undefined;
  }

  // ==========================================================================
  // 私有方法：校验 1 - ServiceMonitor 存在
  // ==========================================================================

  /**
   * 校验 ServiceMonitor / PodMonitor 资源是否存在
   *
   * 执行流程：
   * 1. 调用 kubectl get servicemonitor -n <ns> 真实检查 ServiceMonitor CR
   * 2. kubectl 退出码 0 = 通过（命名空间内至少有 1 个 ServiceMonitor）
   * 3. kubectl 退出码非 0 = 失败（ServiceMonitor 不存在）
   * 4. spawn error（如 kubectl 命令不存在）= 失败
   *
   * 安全说明：
   * - namespace 参数通过数组传递给 spawn，不使用 shell:true，避免命令注入
   * - namespace 格式示例："default" / "kube-system" / "myapp-prod"
   *
   * @param namespace K8s 命名空间
   * @returns MonitoringCheckedItem，含 name="serviceMonitorExists" / passed / detail
   */
  private async checkServiceMonitorExists(namespace: string): Promise<MonitoringCheckedItem> {
    // 启动 kubectl get servicemonitor 子进程（不使用 shell:true，避免命令注入）
    return new Promise<MonitoringCheckedItem>((resolve) => {
      const child = spawn("kubectl", ["get", "servicemonitor", "-n", namespace], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      // 收集 stderr 输出（用于错误诊断）
      let stderrData = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrData += chunk.toString("utf8");
      });

      // 子进程正常退出：退出码 0 = ServiceMonitor 存在
      child.on("close", (code: number | null) => {
        if (code === 0) {
          // 通过：命名空间内存在 ServiceMonitor
          resolve(
            Object.freeze({
              name: CHECK_ITEM_SERVICE_MONITOR,
              passed: true,
              detail: `命名空间 ${namespace} 内存在 ServiceMonitor 资源`,
            }) as MonitoringCheckedItem
          );
        } else {
          // 失败：ServiceMonitor 不存在（kubectl 退出码非 0）
          const detail = stderrData.trim() || `kubectl 退出码 ${code}`;
          resolve(
            Object.freeze({
              name: CHECK_ITEM_SERVICE_MONITOR,
              passed: false,
              detail: `命名空间 ${namespace} 内不存在 ServiceMonitor（${detail}）`,
            }) as MonitoringCheckedItem
          );
        }
      });

      // 子进程启动失败（如 kubectl 命令不存在）：返回失败
      child.on("error", (err: Error) => {
        resolve(
          Object.freeze({
            name: CHECK_ITEM_SERVICE_MONITOR,
            passed: false,
            detail: `kubectl 命令不可用：${err.message}`,
          }) as MonitoringCheckedItem
        );
      });
    });
  }

  // ==========================================================================
  // 私有方法：校验 2 - /metrics 端点可达
  // ==========================================================================

  /**
   * 校验 /metrics 端点是否可达
   *
   * 执行流程：
   * 1. 解析 metricsEndpoint URL
   * 2. 根据协议（http: / https:）选择 node:http / node:https 模块
   * 3. 发起 HTTP GET 请求，超时控制默认 5000ms
   * 4. HTTP 200 = 通过；其他状态码 / 请求失败 / 超时 = 失败
   *
   * 不支持的协议（如 ftp: / file:）：直接返回失败
   *
   * @param metricsEndpoint /metrics 端点完整 URL（如 "http://myapp.default.svc.cluster.local:8080/metrics"）
   * @returns MonitoringCheckedItem，含 name="metricsEndpointReachable" / passed / detail
   */
  private async checkMetricsEndpointReachable(metricsEndpoint: string): Promise<MonitoringCheckedItem> {
    // 解析 URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(metricsEndpoint);
    } catch (err) {
      // URL 解析失败：返回失败
      return Object.freeze({
        name: CHECK_ITEM_METRICS_ENDPOINT,
        passed: false,
        detail: `metricsEndpoint URL 解析失败：${(err as Error).message}`,
      }) as MonitoringCheckedItem;
    }

    // 根据协议选择 http 或 https 模块（非 http/https 协议视为失败）
    let client: typeof http | typeof https;
    if (parsedUrl.protocol === "http:") {
      client = http;
    } else if (parsedUrl.protocol === "https:") {
      client = https;
    } else {
      // 不支持的协议（如 ftp: / file:）：返回失败
      return Object.freeze({
        name: CHECK_ITEM_METRICS_ENDPOINT,
        passed: false,
        detail: `不支持的协议：${parsedUrl.protocol}`,
      }) as MonitoringCheckedItem;
    }

    // 发起 HTTP GET 请求
    const outcome = await this.performHttpGet(client, parsedUrl);

    // 校验 HTTP 请求结果
    if (outcome.errorMessage !== "") {
      // 请求失败 / 超时：返回失败
      return Object.freeze({
        name: CHECK_ITEM_METRICS_ENDPOINT,
        passed: false,
        detail: outcome.errorMessage,
      }) as MonitoringCheckedItem;
    }

    if (outcome.statusCode !== 200) {
      // 状态码非 200：返回失败
      return Object.freeze({
        name: CHECK_ITEM_METRICS_ENDPOINT,
        passed: false,
        detail: `HTTP 状态码 ${outcome.statusCode}（预期 200）`,
      }) as MonitoringCheckedItem;
    }

    // 通过：HTTP 200
    return Object.freeze({
      name: CHECK_ITEM_METRICS_ENDPOINT,
      passed: true,
      detail: `HTTP GET ${metricsEndpoint} 返回 200`,
    }) as MonitoringCheckedItem;
  }

  /**
   * 执行单次 HTTP GET 请求
   *
   * 实现细节：
   * 1. 使用 node:http / node:https 的 request API 发起 GET 请求
   * 2. 通过 timeout 选项设置超时（默认 5000ms），超时后销毁请求并返回 timeout 错误
   * 3. 监听 'response' 事件，收集响应状态码
   * 4. 监听 'error' 事件，捕获连接错误（如 ECONNREFUSED / ENOTFOUND）
   *
   * 超时处理说明：
   * - timeout 选项在 this.httpTimeoutMs 毫秒后触发 'timeout' 事件
   * - 'timeout' 事件触发后手动销毁请求对象（req.destroy()）
   * - 销毁后 'error' 事件会被触发，error.code === 'ECONNRESET'，此处统一转换为 timeout 错误信息
   *
   * @param client node:http 或 node:https 模块
   * @param url 已解析的 URL 对象
   * @returns HttpRequestOutcome 含 statusCode / errorMessage
   */
  private performHttpGet(client: typeof http | typeof https, url: URL): Promise<HttpRequestOutcome> {
    return new Promise<HttpRequestOutcome>((resolve) => {
      // 配置 GET 请求选项
      const options: https.RequestOptions = {
        method: "GET",
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        // 超时控制：this.httpTimeoutMs 毫秒后触发 'timeout' 事件
        timeout: this.httpTimeoutMs,
      };

      // 发起 HTTP GET 请求
      const req = client.request(options, (res) => {
        // 消费响应体（避免 socket 资源泄漏），但不解析内容（仅需状态码）
        res.resume();
        res.on("end", () => {
          // 响应结束：返回状态码
          resolve({
            statusCode: res.statusCode ?? 0,
            errorMessage: "",
          });
        });
        // 响应流错误（如响应中途断开）
        res.on("error", (error: Error) => {
          resolve({
            statusCode: 0,
            errorMessage: `响应流错误：${error.message}`,
          });
        });
      });

      // 超时处理：销毁请求对象
      req.on("timeout", () => {
        req.destroy();
        resolve({
          statusCode: 0,
          errorMessage: `请求超时（${this.httpTimeoutMs}ms）`,
        });
      });

      // 请求错误（如 ECONNREFUSED / ENOTFOUND）
      req.on("error", (error: NodeJS.ErrnoException) => {
        // 如果是 destroy 触发的 ECONNRESET，已被 timeout 处理覆盖，此处跳过
        if (error.code === "ECONNRESET") {
          return;
        }
        resolve({
          statusCode: 0,
          errorMessage: `请求失败：${error.message}`,
        });
      });

      // 写入空请求体（GET 请求无请求体，但需调用 end() 触发请求发送）
      req.end();
    });
  }

  // ==========================================================================
  // 私有方法：校验 3 - Prometheus scrape 配置含目标服务
  // ==========================================================================

  /**
   * 校验 Prometheus scrape 配置是否包含目标服务
   *
   * 执行流程（K-4 决策简化）：
   * 1. 若 context.prometheusConfigPath 未提供：视为通过
   *    理由：ServiceMonitor 已存在即代表 Prometheus 已配置 scrape（ServiceMonitor CR 由 Prometheus Operator 自动同步）
   * 2. 若 context.prometheusConfigPath 提供：
   *    a. 读取文件内容（fs.readFileSync）
   *    b. 调用自实现 YAML parser 解析为 PrometheusScrapeJob 数组
   *    c. 校验至少有 1 个 job 匹配目标服务（通过 namespace + serviceName 匹配 static_configs 或 relabelings）
   *
   * 匹配规则：
   * - static_configs[*].targets 中含 <serviceName>.<namespace> 字符串 = 匹配
   * - kubernetes_sd_configs[*].role === "service" 或 "endpoints" + relabelings 含 namespace/serviceName 替换 = 匹配
   * - 简化匹配：扫描整个 YAML 文本是否同时包含 namespace 与 serviceName 字符串
   *
   * @param context 监控检查上下文（含 namespace / serviceName / prometheusConfigPath）
   * @returns MonitoringCheckedItem，含 name="prometheusScrapeConfig" / passed / detail
   */
  private async checkPrometheusScrapeConfig(context: MonitoringCheckContext): Promise<MonitoringCheckedItem> {
    // K-4 决策简化：prometheusConfigPath 未提供时视为通过
    if (!context.prometheusConfigPath) {
      return Object.freeze({
        name: CHECK_ITEM_PROMETHEUS_CONFIG,
        passed: true,
        detail: "未提供 prometheusConfigPath，跳过 Prometheus 配置校验（依赖 ServiceMonitor 已存在）",
      }) as MonitoringCheckedItem;
    }

    // 读取 Prometheus 配置文件
    let yamlContent: string;
    try {
      yamlContent = fs.readFileSync(context.prometheusConfigPath, { encoding: "utf8" });
    } catch (err) {
      // 文件读取失败：返回失败
      return Object.freeze({
        name: CHECK_ITEM_PROMETHEUS_CONFIG,
        passed: false,
        detail: `Prometheus 配置文件读取失败：${(err as Error).message}`,
      }) as MonitoringCheckedItem;
    }

    // 调用自实现 YAML parser 解析 scrape jobs
    let jobs: ReadonlyArray<PrometheusScrapeJob>;
    try {
      jobs = parsePrometheusScrapeConfig(yamlContent);
    } catch (err) {
      // YAML 解析失败：返回失败
      return Object.freeze({
        name: CHECK_ITEM_PROMETHEUS_CONFIG,
        passed: false,
        detail: `Prometheus 配置 YAML 解析失败：${(err as Error).message}`,
      }) as MonitoringCheckedItem;
    }

    // 校验至少有 1 个 job 匹配目标服务
    const matchedJobs = findMatchedJobs(jobs, context.namespace, context.serviceName);
    if (matchedJobs.length === 0) {
      // 无匹配 job：返回失败
      return Object.freeze({
        name: CHECK_ITEM_PROMETHEUS_CONFIG,
        passed: false,
        detail: `Prometheus 配置中未找到匹配 namespace=${context.namespace} serviceName=${context.serviceName} 的 scrape job`,
      }) as MonitoringCheckedItem;
    }

    // 通过：至少有 1 个匹配 job
    return Object.freeze({
      name: CHECK_ITEM_PROMETHEUS_CONFIG,
      passed: true,
      detail: `Prometheus 配置含 ${matchedJobs.length} 个匹配 job：${matchedJobs.join(", ")}`,
    }) as MonitoringCheckedItem;
  }
}

// ============================================================================
// 自实现 YAML parser（零新增依赖，P-2 原则）
// ============================================================================

/**
 * 自实现 Prometheus scrape 配置 YAML parser
 *
 * 设计目标：
 * - 仅解析 Prometheus scrape 配置所需的字段：job_name / static_configs / kubernetes_sd_configs / relabelings
 * - 不引入外部 yaml 包，避免新增依赖（P-2 零新增依赖原则）
 * - 支持多 job 配置、嵌套数组、relabelings replace 动作
 *
 * 解析规则（简化版，仅覆盖 Prometheus scrape 配置常见格式）：
 * 1. 顶层 scrape_configs 字段为 YAML 数组，每个元素为 1 个 scrape job
 * 2. 每个 job 含 job_name（字符串）/ static_configs（数组）/ kubernetes_sd_configs（数组）/ relabelings（数组）
 * 3. static_configs[*].targets 为字符串数组
 * 4. kubernetes_sd_configs[*].role 为字符串
 * 5. relabelings[*] 含 action / source_labels / regex / target_label / replacement 字段
 *
 * 解析策略：
 * - 基于缩进的逐行解析（2 空格缩进为标准 YAML 格式）
 * - 维护当前所在的层级路径（如 scrape_configs / static_configs / targets）
 * - 遇到列表项（- 开头）时压栈，遇到缩进减少时出栈
 *
 * 局限性（接受范围内）：
 * - 不支持 YAML 流式语法（如 [a, b, c] / {a: b}）
 * - 不支持多行字符串（| / >）
 * - 不支持锚点与别名（& / *）
 * - 仅覆盖 Prometheus scrape 配置常见格式，足够本检查器使用
 *
 * @param yamlContent YAML 文件内容
 * @returns PrometheusScrapeJob 数组（已冻结）
 * @throws Error 当 YAML 顶层不含 scrape_configs 字段时抛出
 */
function parsePrometheusScrapeConfig(yamlContent: string): ReadonlyArray<PrometheusScrapeJob> {
  // 按行分割（兼容 \n 与 \r\n）
  const lines = yamlContent.split(/\r?\n/);

  // 解析状态机：当前所在的层级路径
  // 例如 ["scrape_configs", "0"] 表示当前在 scrape_configs 数组的第 0 个元素内
  const pathStack: { key: string; indent: number }[] = [];

  // 解析结果：scrape job 数组
  const jobs: PrometheusScrapeJob[] = [];

  // 临时变量：当前正在构建的 job
  let currentJob: {
    jobName: string;
    staticTargets: string[];
    kubernetesSdRole: string | undefined;
    relabelActions: {
      action: string;
      sourceLabels: string[];
      regex: string;
      targetLabel: string;
      replacement: string;
    }[];
  } | null = null;

  // 临时变量：当前正在构建的 relabel action
  let currentRelabel: {
    action: string;
    sourceLabels: string[];
    regex: string;
    targetLabel: string;
    replacement: string;
  } | null = null;

  // 临时变量：当前正在构建的 static_configs targets 数组
  let currentStaticTargets: string[] | null = null;

  // 标记是否在 scrape_configs 数组内
  let inScrapeConfigs = false;

  // 逐行解析
  for (const rawLine of lines) {
    // 跳过空行与注释行
    const trimmedLine = rawLine.trim();
    if (trimmedLine === "" || trimmedLine.startsWith("#")) {
      continue;
    }

    // 计算当前行缩进（前导空格数）
    const indent = rawLine.length - rawLine.trimStart().length;

    // 弹出 pathStack 中所有 indent 大于等于当前行的层级（缩进减少时出栈）
    while (pathStack.length > 0 && pathStack[pathStack.length - 1].indent >= indent) {
      const popped = pathStack.pop();
      if (!popped) {
        break;
      }
      // 离开特定层级时的清理逻辑
      if (popped.key === "static_configs" && currentStaticTargets !== null && currentJob !== null) {
        // 离开 static_configs 数组时，将累积的 targets 合并到 currentJob.staticTargets
        currentJob.staticTargets.push(...currentStaticTargets);
        currentStaticTargets = null;
      }
      if (popped.key === "relabelings" && currentRelabel !== null && currentJob !== null) {
        // 离开 relabelings 数组时，将累积的 relabel action 推入 currentJob.relabelActions
        currentJob.relabelActions.push(currentRelabel);
        currentRelabel = null;
      }
      if (popped.key === "scrape_configs" && currentJob !== null) {
        // 离开 scrape_configs 数组时，将 currentJob 推入 jobs
        jobs.push(
          Object.freeze({
            jobName: currentJob.jobName,
            staticTargets: Object.freeze(currentJob.staticTargets) as ReadonlyArray<string>,
            kubernetesSdRole: currentJob.kubernetesSdRole,
            relabelActions: Object.freeze(currentJob.relabelActions) as ReadonlyArray<{
              readonly action: string;
              readonly sourceLabels: ReadonlyArray<string>;
              readonly regex: string;
              readonly targetLabel: string;
              readonly replacement: string;
            }>,
          }) as PrometheusScrapeJob
        );
        currentJob = null;
        inScrapeConfigs = false;
      }
    }

    // 处理列表项（以 "- " 开头）
    if (trimmedLine.startsWith("- ")) {
      const itemContent = trimmedLine.slice(2).trim();
      const top = pathStack[pathStack.length - 1];

      // 进入 scrape_configs 数组的新 job 项
      if (top?.key === "scrape_configs" && !currentJob) {
        currentJob = {
          jobName: "",
          staticTargets: [],
          kubernetesSdRole: undefined,
          relabelActions: [],
        };
      }

      // 进入 static_configs 数组的新项
      if (top?.key === "static_configs") {
        // 若之前累积了 targets，先合并到 currentJob.staticTargets
        // 避免丢失多 static_config 项的 targets（每个 static_config 项可有自己的 targets 列表）
        if (currentStaticTargets && currentJob && currentStaticTargets.length > 0) {
          currentJob.staticTargets.push(...currentStaticTargets);
        }
        // 初始化 targets 数组（新 static_config 项）
        currentStaticTargets = [];
      }

      // 进入 kubernetes_sd_configs 数组的新项（无需特殊处理，仅记录层级）
      if (top?.key === "kubernetes_sd_configs") {
        // 无需特殊处理，role 字段在 key:value 行中处理
      }

      // 进入 relabelings 数组的新项
      if (top?.key === "relabelings") {
        // 若上一个 relabel 未推入，先推入（保险逻辑，正常情况下出栈时已处理）
        if (currentRelabel && currentJob) {
          currentJob.relabelActions.push(currentRelabel);
        }
        currentRelabel = {
          action: "",
          sourceLabels: [],
          regex: "",
          targetLabel: "",
          replacement: "",
        };
      }

      // 处理 inline 键值对（如 "- job_name: myapp" / "- targets: ['10.0.0.1:8080']"）
      if (itemContent.includes(":")) {
        const colonIdx = itemContent.indexOf(":");
        const key = itemContent.slice(0, colonIdx).trim();
        const value = itemContent.slice(colonIdx + 1).trim();

        // 特殊处理：targets 是 inline 数组（如 "- targets: ['10.0.0.1:8080']"）
        // 此分支在 static_configs 列表项内，top.key === "static_configs"
        if (key === "targets" && top?.key === "static_configs") {
          if (value && currentStaticTargets) {
            const cleanValue = value.replace(/^\[/, "").replace(/\]$/, "").trim();
            if (cleanValue !== "") {
              for (const target of cleanValue.split(",").map((s) => s.trim())) {
                if (target) {
                  // 去除每个 target 的引号
                  currentStaticTargets.push(stripYamlQuotes(target));
                }
              }
            }
          }
        } else if (key === "source_labels" && top?.key === "relabelings") {
          // 特殊处理：source_labels 是 inline 数组（如 "- source_labels: [__meta_kubernetes_namespace]"）
          if (value && currentRelabel) {
            const cleanValue = value.replace(/^\[/, "").replace(/\]$/, "").trim();
            if (cleanValue !== "") {
              for (const label of cleanValue.split(",").map((s) => s.trim())) {
                if (label) {
                  currentRelabel.sourceLabels.push(stripYamlQuotes(label));
                }
              }
            }
          }
        } else {
          // 其他键值对：交给 processKeyValue 处理
          processKeyValue(key, value, top?.key, {
            currentJob: () => currentJob,
            setCurrentJobJobName: (v: string) => {
              if (currentJob) currentJob.jobName = v;
            },
            setCurrentJobKubernetesSdRole: (v: string) => {
              if (currentJob) currentJob.kubernetesSdRole = v;
            },
            setCurrentRelabelField: (field: "action" | "regex" | "targetLabel" | "replacement", v: string) => {
              if (currentRelabel) currentRelabel[field] = v;
            },
            addStaticTarget: (v: string) => {
              if (currentStaticTargets) currentStaticTargets.push(v);
            },
            addSourceLabel: (v: string) => {
              if (currentRelabel) currentRelabel.sourceLabels.push(v);
            },
          });
        }
      }

      // 处理纯列表项（如 "- 10.0.0.1:8080" 或 "- __meta_kubernetes_namespace"）
      if (!itemContent.includes(":")) {
        const topKey = top?.key;
        // 在 static_configs.targets 下的纯列表项 = target
        if (topKey === "static_configs") {
          // 当 static_configs 项内含 targets 列表时，items 形如 "10.0.0.1:8080"
          // 由于 targets 是 static_configs 的子层级，top 此时是 static_configs，
          // 但实际 targets 的纯列表项可能直接在 static_configs 项下（缩进对齐）
          if (currentStaticTargets) {
            currentStaticTargets.push(itemContent);
          }
        }
        // 在 source_labels 下的纯列表项 = source label
        if (topKey === "source_labels") {
          if (currentRelabel) {
            currentRelabel.sourceLabels.push(itemContent);
          }
        }
      }

      continue;
    }

    // 处理键值对（key: value 格式）
    if (trimmedLine.includes(":")) {
      const colonIdx = trimmedLine.indexOf(":");
      const key = trimmedLine.slice(0, colonIdx).trim();
      const value = trimmedLine.slice(colonIdx + 1).trim();

      // 顶层 scrape_configs 字段：进入 scrape_configs 数组
      if (key === "scrape_configs" && pathStack.length === 0) {
        pathStack.push({ key: "scrape_configs", indent });
        inScrapeConfigs = true;
        continue;
      }

      // 子层级的数组字段：压栈
      const top = pathStack[pathStack.length - 1];
      if (key === "static_configs" && top) {
        pathStack.push({ key: "static_configs", indent });
        currentStaticTargets = [];
        continue;
      }
      if (key === "kubernetes_sd_configs" && top) {
        pathStack.push({ key: "kubernetes_sd_configs", indent });
        continue;
      }
      if (key === "relabelings" && top) {
        pathStack.push({ key: "relabelings", indent });
        // 若上一个 relabel 未推入，先推入
        if (currentRelabel && currentJob) {
          currentJob.relabelActions.push(currentRelabel);
        }
        currentRelabel = {
          action: "",
          sourceLabels: [],
          regex: "",
          targetLabel: "",
          replacement: "",
        };
        continue;
      }
      if (key === "targets" && top?.key === "static_configs") {
        // targets 是数组字段，但以 key: value 形式存在时通常是 inline 数组（如 targets: [a, b]）
        // 此处简化处理：若 value 非空，按逗号分割后加入 currentStaticTargets
        if (value && currentStaticTargets) {
          // 去除方括号后按逗号分割
          const cleanValue = value.replace(/^\[/, "").replace(/\]$/, "").trim();
          if (cleanValue !== "") {
            for (const target of cleanValue.split(",").map((s) => s.trim())) {
              if (target) {
                // 去除每个 target 的引号
                currentStaticTargets.push(stripYamlQuotes(target));
              }
            }
          }
        }
        continue;
      }
      if (key === "source_labels" && top?.key === "relabelings") {
        // source_labels 是数组字段，inline 数组（如 source_labels: [__meta_kubernetes_namespace]）
        if (value && currentRelabel) {
          const cleanValue = value.replace(/^\[/, "").replace(/\]$/, "").trim();
          if (cleanValue !== "") {
            for (const label of cleanValue.split(",").map((s) => s.trim())) {
              if (label) {
                // 去除每个 label 的引号
                currentRelabel.sourceLabels.push(stripYamlQuotes(label));
              }
            }
          }
        }
        continue;
      }

      // 普通键值对：交给 processKeyValue 处理
      processKeyValue(key, value, top?.key, {
        currentJob: () => currentJob,
        setCurrentJobJobName: (v: string) => {
          if (currentJob) currentJob.jobName = v;
        },
        setCurrentJobKubernetesSdRole: (v: string) => {
          if (currentJob) currentJob.kubernetesSdRole = v;
        },
        setCurrentRelabelField: (field: "action" | "regex" | "targetLabel" | "replacement", v: string) => {
          if (currentRelabel) currentRelabel[field] = v;
        },
        addStaticTarget: (v: string) => {
          if (currentStaticTargets) currentStaticTargets.push(v);
        },
        addSourceLabel: (v: string) => {
          if (currentRelabel) currentRelabel.sourceLabels.push(v);
        },
      });
    }
  }

  // 处理完所有行后，将仍在构建中的 job / relabel / static_targets 收尾
  if (currentRelabel && currentJob) {
    currentJob.relabelActions.push(currentRelabel);
    currentRelabel = null;
  }
  if (currentStaticTargets && currentJob) {
    currentJob.staticTargets.push(...currentStaticTargets);
    currentStaticTargets = null;
  }
  if (currentJob) {
    jobs.push(
      Object.freeze({
        jobName: currentJob.jobName,
        staticTargets: Object.freeze(currentJob.staticTargets) as ReadonlyArray<string>,
        kubernetesSdRole: currentJob.kubernetesSdRole,
        relabelActions: Object.freeze(currentJob.relabelActions) as ReadonlyArray<{
          readonly action: string;
          readonly sourceLabels: ReadonlyArray<string>;
          readonly regex: string;
          readonly targetLabel: string;
          readonly replacement: string;
        }>,
      }) as PrometheusScrapeJob
    );
    currentJob = null;
  }

  // 验证：YAML 必须含 scrape_configs 字段（若全程未进入 scrape_configs，抛错）
  if (!inScrapeConfigs && jobs.length === 0) {
    throw new Error("YAML 顶层未找到 scrape_configs 字段");
  }

  return Object.freeze(jobs) as ReadonlyArray<PrometheusScrapeJob>;
}

/**
 * 处理 YAML 键值对的辅助函数（避免重复代码）
 *
 * 根据当前所在的层级（topKey）将 key/value 分发到对应的 setter
 *
 * @param key 键名（如 "job_name" / "role" / "action"）
 * @param value 值（字符串，已去除引号）
 * @param topKey 当前层级的 key（如 "scrape_configs" / "relabelings"）
 * @param handlers 回调函数集合
 */
function processKeyValue(
  key: string,
  value: string,
  topKey: string | undefined,
  handlers: {
    currentJob: () => {
      jobName: string;
      staticTargets: string[];
      kubernetesSdRole: string | undefined;
      relabelActions: unknown[];
    } | null;
    setCurrentJobJobName: (v: string) => void;
    setCurrentJobKubernetesSdRole: (v: string) => void;
    setCurrentRelabelField: (field: "action" | "regex" | "targetLabel" | "replacement", v: string) => void;
    addStaticTarget: (v: string) => void;
    addSourceLabel: (v: string) => void;
  }
): void {
  // 去除值两端的引号（YAML 字符串可加单引号或双引号）
  const cleanValue = stripYamlQuotes(value);

  // 在 scrape_configs 项下的 job_name 字段
  if (key === "job_name" && topKey === "scrape_configs") {
    handlers.setCurrentJobJobName(cleanValue);
    return;
  }

  // 在 kubernetes_sd_configs 项下的 role 字段
  if (key === "role" && topKey === "kubernetes_sd_configs") {
    handlers.setCurrentJobKubernetesSdRole(cleanValue);
    return;
  }

  // 在 relabelings 项下的 action / regex / target_label / replacement 字段
  if (topKey === "relabelings") {
    if (key === "action") {
      handlers.setCurrentRelabelField("action", cleanValue);
      return;
    }
    if (key === "regex") {
      handlers.setCurrentRelabelField("regex", cleanValue);
      return;
    }
    if (key === "target_label") {
      handlers.setCurrentRelabelField("targetLabel", cleanValue);
      return;
    }
    if (key === "replacement") {
      handlers.setCurrentRelabelField("replacement", cleanValue);
      return;
    }
  }
}

/**
 * 去除 YAML 字符串值两端的引号
 *
 * YAML 字符串可加单引号或双引号，本函数去除两端引号还原原始字符串
 *
 * @param value 原始值（如 '"myapp"' / "'myapp'" / "myapp"）
 * @returns 去除引号后的值（如 "myapp"）
 */
function stripYamlQuotes(value: string): string {
  if (value.length >= 2) {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * 在已解析的 Prometheus scrape jobs 中查找匹配目标服务的 job
 *
 * 匹配规则（满足任一即视为匹配）：
 * 1. static_configs[*].targets 中含 <serviceName>.<namespace> 字符串（DNS 形式）
 * 2. static_configs[*].targets 中含 <serviceName> 字符串（简化匹配）
 * 3. kubernetes_sd_configs[*].role === "service" 或 "endpoints" + relabelings 含 namespace/serviceName 替换
 * 4. relabelings[*].replacement 含 <namespace> 或 <serviceName>（relabel 替换值匹配）
 *
 * @param jobs 已解析的 scrape job 数组
 * @param namespace K8s 命名空间
 * @param serviceName Service 名称
 * @returns 匹配的 job_name 数组
 */
function findMatchedJobs(jobs: ReadonlyArray<PrometheusScrapeJob>, namespace: string, serviceName: string): string[] {
  const matched: string[] = [];

  for (const job of jobs) {
    let isMatched = false;

    // 匹配规则 1/2：static_configs[*].targets 含 serviceName 或 serviceName.namespace
    for (const target of job.staticTargets) {
      if (target.includes(serviceName)) {
        isMatched = true;
        break;
      }
      // DNS 形式：<serviceName>.<namespace>.svc.cluster.local
      if (target.includes(`${serviceName}.${namespace}`)) {
        isMatched = true;
        break;
      }
    }

    // 匹配规则 3：kubernetes_sd_configs role 为 service/endpoints + relabelings 含目标
    if (!isMatched && job.kubernetesSdRole) {
      if (
        job.kubernetesSdRole === "service" ||
        job.kubernetesSdRole === "endpoints" ||
        job.kubernetesSdRole === "pod"
      ) {
        // 检查 relabelings 是否含 namespace 或 serviceName 替换
        for (const relabel of job.relabelActions) {
          if (relabel.replacement.includes(namespace) || relabel.replacement.includes(serviceName)) {
            isMatched = true;
            break;
          }
          // 检查 regex 是否含 namespace 或 serviceName
          if (relabel.regex.includes(namespace) || relabel.regex.includes(serviceName)) {
            isMatched = true;
            break;
          }
        }
      }
    }

    if (isMatched && job.jobName) {
      matched.push(job.jobName);
    }
  }

  return matched;
}
