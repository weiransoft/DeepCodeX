/**
 * EAG-P4 批次 14 Phase 4 单元测试：MonitoringReadinessChecker + RollbackPlanChecker（TASK-14-4-3 + TASK-14-4-4 合并）
 *
 * 测试范围（对齐 EAG-P4-BATCH14-TEST-CASES.md TC-G8-001 ~ TC-G8-008 + TC-RL-005 ~ TC-RL-008）：
 *
 * MonitoringReadinessChecker 测试（TC-G8-001 ~ TC-G8-004）：
 * - TC-G8-001. 监控就位：ServiceMonitor 存在 + /metrics 200 + Prometheus 配置含目标 → ready=true
 *   - TC-G8-001a. ready=true（3 项全过）
 *   - TC-G8-001b. checkedItems 长度 3
 *   - TC-G8-001c. failures 为空数组
 *   - TC-G8-001d. result 被 Object.freeze 冻结
 *   - TC-G8-001e. checkedItems 数组被冻结
 *   - TC-G8-001f. failures 数组被冻结
 *   - TC-G8-001g. checkedItems[0].name === "serviceMonitorExists"
 *   - TC-G8-001h. checkedItems[1].name === "metricsEndpointReachable"
 *   - TC-G8-001i. checkedItems[2].name === "prometheusScrapeConfig"
 * - TC-G8-002. ServiceMonitor 缺失返回 ready=false
 *   - TC-G8-002a. ready=false
 *   - TC-G8-002b. checkedItems[0].passed=false（serviceMonitorExists）
 *   - TC-G8-002c. failures 含 "ServiceMonitor 检查未通过"
 * - TC-G8-003. /metrics 不可达返回 ready=false
 *   - TC-G8-003a. ready=false
 *   - TC-G8-003b. checkedItems[1].passed=false（metricsEndpointReachable）
 *   - TC-G8-003c. failures 含 "/metrics 端点不可达"
 * - TC-G8-004. Prometheus 配置未含目标返回 ready=false
 *   - TC-G8-004a. ready=false
 *   - TC-G8-004b. checkedItems[2].passed=false（prometheusScrapeConfig）
 *   - TC-G8-004c. failures 含 "Prometheus scrape 配置未含目标服务"
 * - TC-G8-004a. prometheusConfigPath 未提供时视为通过（K-4 决策简化）
 *
 * RollbackPlanChecker 测试（TC-G8-005 ~ TC-G8-008 + TC-RL-005 ~ TC-RL-008）：
 * - TC-G8-005 / TC-RL-005. 文件存在 + 5 字段齐全 valid=true
 *   - TC-RL-005a. exists=true
 *   - TC-RL-005b. valid=true
 *   - TC-RL-005c. failures 为空数组
 *   - TC-RL-005d. filePath 以 .md 结尾
 *   - TC-RL-005e. result 被 Object.freeze 冻结
 *   - TC-RL-005f. failures 数组被冻结
 * - TC-G8-006 / TC-RL-006. 文件缺失 exists=false
 *   - TC-RL-006a. exists=false
 *   - TC-RL-006b. valid=false
 *   - TC-RL-006c. failures 含 "回滚预案文件不存在"
 *   - TC-RL-006d. filePath 为预期路径（含 runId）
 * - TC-G8-007 / TC-RL-007. 字段缺失 valid=false + 缺失字段名
 *   - TC-RL-007a. exists=true
 *   - TC-RL-007b. valid=false
 *   - TC-RL-007c. failures 含缺失章节名（"目标版本号" / "回滚命令" / "资源清单" / "创建时间戳" / "runId"）
 *   - TC-RL-007d. 单章节缺失：仅含对应缺失章节
 *   - TC-RL-007e. 多章节缺失：含全部缺失章节
 * - TC-G8-008 / TC-RL-008. 文件存在但内容为空 valid=false
 *   - TC-RL-008a. exists=true
 *   - TC-RL-008b. valid=false
 *   - TC-RL-008c. failures 含全部 5 个章节名
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实文件系统（os.tmpdir() + fs.mkdtempSync + fs.writeFileSync）
 * - 使用 node:http.createServer 启动本地 HTTP 服务模拟 /metrics 端点（真实 HTTP 请求，非 mock）
 * - 使用 fake-binary 技巧模拟 kubectl（真实可执行 shell 脚本，非 mock）
 * - 真实读写文件系统（fs.mkdtempSync + fs.writeFileSync + fs.rmSync）
 * - 中文详细注释
 * - Object.isFrozen 断言不可变优先
 *
 * fake-binary 技巧说明（对齐 NFR-3 测试不使用 mock）：
 * - 在临时目录创建可执行 shell 脚本作为 fake kubectl
 * - 临时修改 process.env.PATH 让 spawn 找到 fake binary（真实调用 spawn，非 mock）
 * - fake binary 是真实的可执行文件，根据参数输出预先定义好的内容
 * - 测试完成后恢复 PATH 并清理临时目录
 *
 * HTTP 服务模拟说明（对齐 NFR-3 测试不使用 mock）：
 * - 使用 node:http.createServer 启动真实的本地 HTTP 服务
 * - 监听 0 端口让操作系统分配可用端口
 * - 测试完成后调用 server.close() 关闭服务
 * - 真实发起 HTTP 请求，非 mock
 *
 * 设计依据：
 * - EAG-P4 批次 14 任务清单 TASK-14-4-3 + TASK-14-4-4 验收标准
 * - EAG-P4 批次 14 测试用例文档 TC-G8-001 ~ TC-G8-008 + TC-RL-005 ~ TC-RL-008
 * - types.ts 中 MonitoringReadinessChecker / RollbackPlanChecker 接口定义
 * - monitoring-readiness-checker.ts / rollback-plan-checker.ts 实现
 *
 * @module core/tests/eag-devops-monitoring-rollback-checkers
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import http from "node:http";
import { spawnSync } from "node:child_process";

import { MonitoringReadinessCheckerImpl, RollbackPlanCheckerImpl } from "../eag/devops";
import type {
  MonitoringCheckContext,
  MonitoringCheckResult,
  RollbackPlanCheckContext,
  RollbackPlanCheckResult,
} from "../eag/devops";

// ============================================================================
// 辅助函数：检测 kubectl CLI 是否可用
// ============================================================================

/**
 * 检测 kubectl CLI 是否可用
 *
 * 通过 spawnSync 调用 kubectl --version 检测 kubectl 是否存在，非 mock。
 * 用于有条件地运行真实 kubectl 测试，kubectl 不存在时使用 fake-binary。
 *
 * @returns true=kubectl 可用，false=kubectl 不可用
 */
function checkKubectlAvailable(): boolean {
  try {
    const result = spawnSync("kubectl", ["version", "--client"], {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ============================================================================
// fake-binary 工具函数：创建临时目录与 fake kubectl 脚本
// ============================================================================

/**
 * 创建 fake kubectl 临时目录环境
 *
 * 执行流程：
 * 1. 在 os.tmpdir() 下创建临时目录（fs.mkdtempSync，前缀 "eag-mrc-fake-"）
 * 2. 在临时目录下创建 fake kubectl 可执行脚本
 * 3. 临时修改 process.env.PATH 让 spawn 找到 fake kubectl（fake binary 目录优先）
 * 4. 返回 { tmpDir, originalPath }，调用方需在测试完成后调用 restoreFakeKubectlEnv 恢复
 *
 * @param script fake kubectl 脚本内容
 * @returns 含临时目录路径与原始 PATH 的对象
 */
function setupFakeKubectlEnv(script: string): { tmpDir: string; originalPath: string } {
  // 创建临时目录
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-fake-"));

  // 创建 fake kubectl 脚本
  const kubectlPath = path.join(tmpDir, "kubectl");
  fs.writeFileSync(kubectlPath, script, {
    encoding: "utf8",
    mode: 0o755, // 可执行权限
  });

  // 临时修改 PATH 让 spawn 找到 fake kubectl（fake binary 目录优先）
  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${tmpDir}:${originalPath}`;

  return { tmpDir, originalPath };
}

/**
 * 恢复 fake kubectl 环境
 *
 * 执行流程：
 * 1. 恢复 process.env.PATH 为原始值
 * 2. 递归删除临时目录（fs.rmSync recursive: true）
 *
 * @param tmpDir 临时目录路径
 * @param originalPath 原始 PATH 值
 */
function restoreFakeKubectlEnv(tmpDir: string, originalPath: string): void {
  // 恢复 PATH
  process.env.PATH = originalPath;
  // 清理临时目录
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 清理失败不抛异常（避免测试失败时掩盖原始错误）
  }
}

// ============================================================================
// fake kubectl 脚本生成器
// ============================================================================

/**
 * 生成 fake kubectl 脚本（成功路径，servicemonitor 子命令返回成功）
 *
 * 支持的子命令：
 * - get servicemonitor -n <ns>：返回成功（退出码 0），模拟命名空间内存在 ServiceMonitor
 *
 * @returns fake kubectl shell 脚本内容
 */
function createFakeKubectlSuccessScript(): string {
  return `#!/bin/bash
# fake kubectl 成功模式：servicemonitor 子命令返回成功
subcmd="$1"
shift

case "$subcmd" in
  get)
    resource="$1"
    if [[ "$resource" == "servicemonitor" ]]; then
      # kubectl get servicemonitor -n <ns>：返回成功（命名空间内存在 ServiceMonitor）
      echo "NAME              AGE"
      echo "myapp-monitor     5m"
      exit 0
    fi
    exit 1
    ;;
  *)
    # 其他子命令：返回成功（兼容 kubectl version --client）
    exit 0
    ;;
esac
`;
}

/**
 * 生成 fake kubectl 脚本（失败路径，servicemonitor 子命令返回失败）
 *
 * 支持的子命令：
 * - get servicemonitor -n <ns>：返回失败（退出码 1），模拟命名空间内不存在 ServiceMonitor
 *
 * @returns fake kubectl shell 脚本内容
 */
function createFakeKubectlFailureScript(): string {
  return `#!/bin/bash
# fake kubectl 失败模式：servicemonitor 子命令返回失败
subcmd="$1"
shift

case "$subcmd" in
  get)
    resource="$1"
    if [[ "$resource" == "servicemonitor" ]]; then
      # kubectl get servicemonitor -n <ns>：返回失败（命名空间内不存在 ServiceMonitor）
      echo 'Error from server (NotFound): No resources found' >&2
      exit 1
    fi
    exit 1
    ;;
  *)
    # 其他子命令：返回成功（兼容 kubectl version --client）
    exit 0
    ;;
esac
`;
}

// ============================================================================
// HTTP 服务工具函数：启动本地 /metrics 端点
// ============================================================================

/**
 * 启动本地 HTTP 服务模拟 /metrics 端点
 *
 * 执行流程：
 * 1. 使用 node:http.createServer 创建 HTTP 服务
 * 2. 监听 0 端口让操作系统分配可用端口
 * 3. /metrics 路径返回 200 + Prometheus 格式指标
 * 4. 其他路径返回 404
 * 5. 返回 { server, url }，调用方需在测试完成后调用 server.close() 关闭
 *
 * @param statusCode /metrics 端点返回的 HTTP 状态码（默认 200）
 * @returns 含 HTTP 服务实例与 /metrics 端点 URL 的对象
 */
function startMetricsServer(statusCode: number = 200): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    // 创建 HTTP 服务
    const server = http.createServer((req, res) => {
      if (req.url === "/metrics") {
        // /metrics 路径返回指定状态码 + Prometheus 格式指标
        res.writeHead(statusCode, { "Content-Type": "text/plain; version=0.0.4" });
        res.end(
          "# HELP myapp_requests_total Total requests\n# TYPE myapp_requests_total counter\nmyapp_requests_total 1234\n"
        );
      } else {
        // 其他路径返回 404
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    });

    // 监听 0 端口让操作系统分配可用端口
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const url = `http://127.0.0.1:${address.port}/metrics`;
        resolve({ server, url });
      }
    });
  });
}

/**
 * 关闭本地 HTTP 服务
 *
 * @param server HTTP 服务实例
 */
function stopMetricsServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

// ============================================================================
// 回滚预案样例文件生成器
// ============================================================================

/**
 * 生成完整的回滚预案文件内容（5 个章节齐全）
 *
 * 文件 schema（与 ROLLBACK_PLAN_SECTIONS 对齐）：
 * # 回滚预案
 *
 * ## 目标版本号
 * <version>
 *
 * ## 回滚命令
 * ```bash
 * kubectl rollout undo deployment/<name> -n <ns> --to-revision=<N>
 * ```
 *
 * ## 资源清单
 * - deployment/<name>
 *
 * ## 创建时间戳
 * <ISO 8601>
 *
 * ## runId
 * <runId>
 *
 * @param runId 运行 ID（用于填充 runId 章节）
 * @returns 完整的回滚预案 Markdown 内容
 */
function createCompleteRollbackPlanContent(runId: string): string {
  return [
    "# 回滚预案",
    "",
    "## 目标版本号",
    "revision-5",
    "",
    "## 回滚命令",
    "```bash",
    "kubectl rollout undo deployment/myapp -n default --to-revision=5",
    "```",
    "",
    "## 资源清单",
    "- deployment/myapp",
    "- service/myapp",
    "",
    "## 创建时间戳",
    "2026-07-21T10:00:00.000Z",
    "",
    "## runId",
    runId,
    "",
  ].join("\n");
}

/**
 * 生成缺失指定章节的回滚预案文件内容
 *
 * @param runId 运行 ID
 * @param missingSections 缺失的章节名数组（如 ["目标版本号", "回滚命令"]）
 * @returns 缺失指定章节的回滚预案 Markdown 内容
 */
function createIncompleteRollbackPlanContent(runId: string, missingSections: string[]): string {
  const lines: string[] = ["# 回滚预案", ""];

  // 5 个章节定义
  const sections: Array<{ name: string; content: string[] }> = [
    { name: "目标版本号", content: ["revision-5", ""] },
    {
      name: "回滚命令",
      content: ["```bash", "kubectl rollout undo deployment/myapp -n default --to-revision=5", "```", ""],
    },
    { name: "资源清单", content: ["- deployment/myapp", "- service/myapp", ""] },
    { name: "创建时间戳", content: ["2026-07-21T10:00:00.000Z", ""] },
    { name: "runId", content: [runId, ""] },
  ];

  // 仅添加未缺失的章节
  for (const section of sections) {
    if (!missingSections.includes(section.name)) {
      lines.push(`## ${section.name}`);
      lines.push(...section.content);
    }
  }

  return lines.join("\n");
}

/**
 * 生成 Prometheus scrape 配置文件内容
 *
 * 配置 schema（Prometheus 标准格式）：
 * scrape_configs:
 *   - job_name: myapp-metrics
 *     static_configs:
 *       - targets: ['myapp.default.svc.cluster.local:8080']
 *     metrics_path: /metrics
 *
 * @param serviceName Service 名称
 * @param namespace K8s 命名空间
 * @returns Prometheus 配置 YAML 内容
 */
function createPrometheusConfigWithTarget(serviceName: string, namespace: string): string {
  return [
    "global:",
    "  scrape_interval: 15s",
    "",
    "scrape_configs:",
    `  - job_name: '${serviceName}-metrics'`,
    "    metrics_path: /metrics",
    "    static_configs:",
    `      - targets: ['${serviceName}.${namespace}.svc.cluster.local:8080']`,
    "",
  ].join("\n");
}

/**
 * 生成不含目标服务的 Prometheus scrape 配置文件内容
 *
 * @returns Prometheus 配置 YAML 内容（不含目标服务）
 */
function createPrometheusConfigWithoutTarget(): string {
  return [
    "global:",
    "  scrape_interval: 15s",
    "",
    "scrape_configs:",
    "  - job_name: 'other-app-metrics'",
    "    metrics_path: /metrics",
    "    static_configs:",
    "      - targets: ['other-app.default.svc.cluster.local:8080']",
    "",
  ].join("\n");
}

// ============================================================================
// 测试辅助：构造 MonitoringCheckContext
// ============================================================================

/**
 * 构造测试用 MonitoringCheckContext
 *
 * @param overrides 覆盖字段
 * @returns 完整的 MonitoringCheckContext
 */
function createMonitoringContext(overrides?: Partial<MonitoringCheckContext>): MonitoringCheckContext {
  return {
    projectName: "myapp",
    namespace: "default",
    serviceName: "myapp",
    metricsEndpoint: "http://127.0.0.1:9090/metrics",
    ...overrides,
  };
}

// ============================================================================
// 测试辅助：构造 RollbackPlanCheckContext
// ============================================================================

/**
 * 构造测试用 RollbackPlanCheckContext
 *
 * @param projectRoot 项目根目录
 * @param runId 运行 ID
 * @returns 完整的 RollbackPlanCheckContext
 */
function createRollbackPlanContext(projectRoot: string, runId: string): RollbackPlanCheckContext {
  return {
    projectRoot,
    runId,
  };
}

// ============================================================================
// 测试辅助：在临时目录中创建回滚预案文件
// ============================================================================

/**
 * 在临时项目目录中创建回滚预案文件
 *
 * 文件路径：<projectRoot>/deploy/rollback-plan-<runId>.md
 *
 * @param projectRoot 项目根目录
 * @param runId 运行 ID
 * @param content 文件内容
 * @returns 文件绝对路径
 */
function createRollbackPlanFile(projectRoot: string, runId: string, content: string): string {
  const deployDir = path.join(projectRoot, "deploy");
  fs.mkdirSync(deployDir, { recursive: true });
  const filePath = path.join(deployDir, `rollback-plan-${runId}.md`);
  fs.writeFileSync(filePath, content, { encoding: "utf8" });
  return filePath;
}

// ============================================================================
// ============================================================================
// MonitoringReadinessCheckerImpl 测试（TC-G8-001 ~ TC-G8-004）
// ============================================================================
// ============================================================================

// ============================================================================
// TC-G8-001. 监控就位：ServiceMonitor 存在 + /metrics 200 + Prometheus 配置含目标 → ready=true
// ============================================================================

test("TC-G8-001a. 监控就位时 ready=true（3 项全过）", async () => {
  // 准备：启动本地 HTTP 服务模拟 /metrics 端点（返回 200）
  const { server, url } = await startMetricsServer(200);
  // 准备：创建 fake kubectl 临时目录（servicemonitor 子命令返回成功）
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  // 准备：创建临时目录存放 Prometheus 配置文件
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithTarget("myapp", "default"), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：ready=true（3 项全过）
    assert.equal(result.ready, true, `监控就绪时应 ready=true，实际 failures：${result.failures.join("; ")}`);
  } finally {
    // 清理：关闭 HTTP 服务 + 恢复 PATH + 删除临时目录
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-G8-001b. checkedItems 长度 3（serviceMonitorExists / metricsEndpointReachable / prometheusScrapeConfig）", async () => {
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithTarget("myapp", "default"), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：checkedItems 含 3 项
    assert.equal(result.checkedItems.length, 3, `checkedItems 应含 3 项，实际：${result.checkedItems.length}`);
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-G8-001c. 监控就位时 failures 为空数组", async () => {
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithTarget("myapp", "default"), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：failures 为空数组
    assert.equal(result.failures.length, 0, `监控就位时 failures 应为空，实际：${result.failures.join("; ")}`);
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-G8-001d. result 被 Object.freeze 冻结", async () => {
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithTarget("myapp", "default"), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：result 对象被冻结
    assert.equal(Object.isFrozen(result), true, "result 应被 Object.freeze 冻结");
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-G8-001e. checkedItems 数组被冻结", async () => {
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithTarget("myapp", "default"), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：checkedItems 数组被冻结
    assert.equal(Object.isFrozen(result.checkedItems), true, "checkedItems 数组应被 Object.freeze 冻结");
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-G8-001f. failures 数组被冻结", async () => {
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithTarget("myapp", "default"), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：failures 数组被冻结
    assert.equal(Object.isFrozen(result.failures), true, "failures 数组应被 Object.freeze 冻结");
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-G8-001g. checkedItems[0].name === 'serviceMonitorExists'", async () => {
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithTarget("myapp", "default"), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：第一项 name 为 serviceMonitorExists
    assert.equal(result.checkedItems[0].name, "serviceMonitorExists");
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-G8-001h. checkedItems[1].name === 'metricsEndpointReachable'", async () => {
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithTarget("myapp", "default"), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：第二项 name 为 metricsEndpointReachable
    assert.equal(result.checkedItems[1].name, "metricsEndpointReachable");
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-G8-001i. checkedItems[2].name === 'prometheusScrapeConfig'", async () => {
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithTarget("myapp", "default"), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：第三项 name 为 prometheusScrapeConfig
    assert.equal(result.checkedItems[2].name, "prometheusScrapeConfig");
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-G8-002. ServiceMonitor 缺失返回 ready=false
// ============================================================================

test("TC-G8-002a. ServiceMonitor 缺失时 ready=false", async () => {
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlFailureScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithTarget("myapp", "default"), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：ready=false（ServiceMonitor 缺失导致）
    assert.equal(result.ready, false, "ServiceMonitor 缺失时应 ready=false");
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-G8-002b. ServiceMonitor 缺失时 checkedItems[0].passed=false", async () => {
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlFailureScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithTarget("myapp", "default"), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：serviceMonitorExists 项 passed=false
    assert.equal(result.checkedItems[0].name, "serviceMonitorExists");
    assert.equal(result.checkedItems[0].passed, false, "ServiceMonitor 缺失时 serviceMonitorExists 应 passed=false");
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-G8-002c. ServiceMonitor 缺失时 failures 含 'ServiceMonitor 检查未通过'", async () => {
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlFailureScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithTarget("myapp", "default"), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：failures 含 "ServiceMonitor 检查未通过"
    const failuresStr = result.failures.join(" ");
    assert.ok(
      failuresStr.includes("ServiceMonitor 检查未通过"),
      `failures 应含 "ServiceMonitor 检查未通过"，实际：${failuresStr}`
    );
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-G8-003. /metrics 不可达返回 ready=false
// ============================================================================

test("TC-G8-003a. /metrics 不可达时 ready=false", async () => {
  // 准备：使用不存在的端口模拟 /metrics 端点不可达
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithTarget("myapp", "default"), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl({ httpTimeoutMs: 1000 });
    // 指向不存在的端口（确保连接被拒绝）
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: "http://127.0.0.1:1/metrics", // 端口 1 通常无服务监听
        prometheusConfigPath: configPath,
      })
    );

    // 验证：ready=false（/metrics 不可达导致）
    assert.equal(result.ready, false, "/metrics 不可达时应 ready=false");
  } finally {
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-G8-003b. /metrics 不可达时 checkedItems[1].passed=false", async () => {
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithTarget("myapp", "default"), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl({ httpTimeoutMs: 1000 });
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: "http://127.0.0.1:1/metrics",
        prometheusConfigPath: configPath,
      })
    );

    // 验证：metricsEndpointReachable 项 passed=false
    assert.equal(result.checkedItems[1].name, "metricsEndpointReachable");
    assert.equal(result.checkedItems[1].passed, false, "/metrics 不可达时 metricsEndpointReachable 应 passed=false");
  } finally {
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-G8-003c. /metrics 不可达时 failures 含 '/metrics 端点不可达'", async () => {
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithTarget("myapp", "default"), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl({ httpTimeoutMs: 1000 });
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: "http://127.0.0.1:1/metrics",
        prometheusConfigPath: configPath,
      })
    );

    // 验证：failures 含 "/metrics 端点不可达"
    const failuresStr = result.failures.join(" ");
    assert.ok(failuresStr.includes("/metrics 端点不可达"), `failures 应含 "/metrics 端点不可达"，实际：${failuresStr}`);
  } finally {
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-G8-004. Prometheus 配置未含目标返回 ready=false
// ============================================================================

test("TC-G8-004a. Prometheus 配置未含目标时 ready=false", async () => {
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  // 写入不含目标服务的 Prometheus 配置
  fs.writeFileSync(configPath, createPrometheusConfigWithoutTarget(), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        projectName: "myapp",
        namespace: "default",
        serviceName: "myapp",
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：ready=false（Prometheus 配置未含目标服务导致）
    assert.equal(result.ready, false, "Prometheus 配置未含目标服务时应 ready=false");
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-G8-004b. Prometheus 配置未含目标时 checkedItems[2].passed=false", async () => {
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithoutTarget(), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        projectName: "myapp",
        namespace: "default",
        serviceName: "myapp",
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：prometheusScrapeConfig 项 passed=false
    assert.equal(result.checkedItems[2].name, "prometheusScrapeConfig");
    assert.equal(
      result.checkedItems[2].passed,
      false,
      "Prometheus 配置未含目标时 prometheusScrapeConfig 应 passed=false"
    );
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-G8-004c. Prometheus 配置未含目标时 failures 含 'Prometheus scrape 配置未含目标服务'", async () => {
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  fs.writeFileSync(configPath, createPrometheusConfigWithoutTarget(), { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        projectName: "myapp",
        namespace: "default",
        serviceName: "myapp",
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：failures 含 "Prometheus scrape 配置未含目标服务"
    const failuresStr = result.failures.join(" ");
    assert.ok(
      failuresStr.includes("Prometheus scrape 配置未含目标服务"),
      `failures 应含 "Prometheus scrape 配置未含目标服务"，实际：${failuresStr}`
    );
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-G8-004d. prometheusConfigPath 未提供时 prometheusScrapeConfig 视为通过（K-4 决策简化）", async () => {
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    // 不提供 prometheusConfigPath
    const result = await checker.check(
      createMonitoringContext({
        metricsEndpoint: url,
      })
    );

    // 验证：ready=true（prometheusScrapeConfig 视为通过）
    assert.equal(
      result.ready,
      true,
      `prometheusConfigPath 未提供时应 ready=true，实际 failures：${result.failures.join("; ")}`
    );
    // 验证：prometheusScrapeConfig 项 passed=true
    assert.equal(
      result.checkedItems[2].passed,
      true,
      "prometheusConfigPath 未提供时 prometheusScrapeConfig 应 passed=true"
    );
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
  }
});

// ============================================================================
// MonitoringReadinessCheckerImpl 实例化与 K-4 决策测试
// ============================================================================

test("TC-MRC-001. MonitoringReadinessCheckerImpl 实例化成功", () => {
  const checker = new MonitoringReadinessCheckerImpl();
  assert.ok(checker instanceof MonitoringReadinessCheckerImpl);
});

test("TC-MRC-002. MonitoringReadinessCheckerImpl 实例被 Object.freeze 冻结", () => {
  const checker = new MonitoringReadinessCheckerImpl();
  assert.equal(Object.isFrozen(checker), true, "实例应被 Object.freeze 冻结");
});

test("TC-MRC-003. checkAlertmanagerRules 首版返回 undefined（K-4 决策）", () => {
  const checker = new MonitoringReadinessCheckerImpl();
  const result = checker.checkAlertmanagerRules();
  assert.equal(result, undefined, "K-4 决策：首版返回 undefined");
});

test("TC-MRC-004. MonitoringReadinessCheckerImpl 实现 MonitoringReadinessChecker 接口", async () => {
  const checker = new MonitoringReadinessCheckerImpl();
  assert.equal(typeof checker.check, "function", "应实现 check 方法");
});

test("TC-MRC-005a. YAML parser 正确处理多 static_configs 项的 targets 合并", async () => {
  // 准备：构造含 2 个 static_configs 项的 Prometheus 配置（target 在第 2 项中）
  // 验证修复：parser 不应丢失第 2 个 static_config 项的 targets
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  // 含 2 个 static_configs 项，第 1 项 targets 含 myapp，第 2 项 targets 含 other-app
  const multiStaticConfigsYaml = [
    "global:",
    "  scrape_interval: 15s",
    "",
    "scrape_configs:",
    "  - job_name: 'myapp-metrics'",
    "    metrics_path: /metrics",
    "    static_configs:",
    "      - targets: ['myapp.default.svc.cluster.local:8080']",
    "      - targets: ['other-app.default.svc.cluster.local:8080']",
    "",
  ].join("\n");
  fs.writeFileSync(configPath, multiStaticConfigsYaml, { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        projectName: "myapp",
        namespace: "default",
        serviceName: "myapp",
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：prometheusScrapeConfig 项 passed=true（myapp 在第 1 个 static_config 项中匹配）
    assert.equal(result.checkedItems[2].name, "prometheusScrapeConfig");
    assert.equal(result.checkedItems[2].passed, true, "Prometheus 配置含 myapp 目标，应 passed=true");
    // 验证：ready=true
    assert.equal(result.ready, true, `监控就位时应 ready=true，实际 failures：${result.failures.join("; ")}`);
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

test("TC-MRC-005b. YAML parser 正确处理多 static_configs 项（目标仅在第 2 项中匹配）", async () => {
  // 准备：构造含 2 个 static_configs 项的 Prometheus 配置（target 仅在第 2 项中匹配）
  // 验证修复：parser 不应丢失第 2 个 static_config 项的 targets
  const { server, url } = await startMetricsServer(200);
  const { tmpDir, originalPath } = setupFakeKubectlEnv(createFakeKubectlSuccessScript());
  const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-mrc-prom-"));
  const configPath = path.join(configTmpDir, "prometheus.yml");
  // 含 2 个 static_configs 项，第 1 项 targets 含 other-app，第 2 项 targets 含 myapp
  const multiStaticConfigsYaml = [
    "global:",
    "  scrape_interval: 15s",
    "",
    "scrape_configs:",
    "  - job_name: 'myapp-metrics'",
    "    metrics_path: /metrics",
    "    static_configs:",
    "      - targets: ['other-app.default.svc.cluster.local:8080']",
    "      - targets: ['myapp.default.svc.cluster.local:8080']",
    "",
  ].join("\n");
  fs.writeFileSync(configPath, multiStaticConfigsYaml, { encoding: "utf8" });

  try {
    const checker = new MonitoringReadinessCheckerImpl();
    const result = await checker.check(
      createMonitoringContext({
        projectName: "myapp",
        namespace: "default",
        serviceName: "myapp",
        metricsEndpoint: url,
        prometheusConfigPath: configPath,
      })
    );

    // 验证：prometheusScrapeConfig 项 passed=true（myapp 在第 2 个 static_config 项中匹配）
    assert.equal(result.checkedItems[2].name, "prometheusScrapeConfig");
    assert.equal(
      result.checkedItems[2].passed,
      true,
      "Prometheus 配置第 2 个 static_config 项含 myapp 目标，应 passed=true"
    );
    // 验证：ready=true
    assert.equal(result.ready, true, `监控就位时应 ready=true，实际 failures：${result.failures.join("; ")}`);
  } finally {
    await stopMetricsServer(server);
    restoreFakeKubectlEnv(tmpDir, originalPath);
    fs.rmSync(configTmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 真实 kubectl 集成测试（kubectl 可用时运行，验证真实 CLI 调用路径）
// ============================================================================

const hasKubectl = checkKubectlAvailable();

test("TC-MRC-005. 真实 kubectl 调用（kubectl 可用时）", { skip: !hasKubectl }, async () => {
  // 此测试在 kubectl 可用时运行，验证 MonitoringReadinessCheckerImpl 真实调用 kubectl（非 mock）
  // 注意：此测试需要可访问的 K8s 集群 + ServiceMonitor CRD，否则 kubectl get servicemonitor 会失败
  // 测试目的：验证 MonitoringReadinessCheckerImpl 真实调用 kubectl（非 mock）
  const { server, url } = await startMetricsServer(200);
  try {
    const checker = new MonitoringReadinessCheckerImpl({ kubectlTimeoutMs: 5000 });
    const result = await checker.check(
      createMonitoringContext({
        namespace: "default",
        metricsEndpoint: url,
        // 不提供 prometheusConfigPath，K-4 决策简化为通过
      })
    );

    // 无论 kubectl 是否成功（取决于集群可用性），结果应为结构化 MonitoringCheckResult
    assert.equal(typeof result.ready, "boolean");
    assert.ok(Array.isArray(result.checkedItems));
    assert.ok(Array.isArray(result.failures));
    assert.equal(Object.isFrozen(result), true);
  } finally {
    await stopMetricsServer(server);
  }
});

// ============================================================================
// ============================================================================
// RollbackPlanCheckerImpl 测试（TC-G8-005 ~ TC-G8-008 + TC-RL-005 ~ TC-RL-008）
// ============================================================================
// ============================================================================

// ============================================================================
// TC-G8-005 / TC-RL-005. 文件存在 + 5 字段齐全 valid=true
// ============================================================================

test("TC-RL-005a. 文件存在 + 5 字段齐全时 exists=true", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    createRollbackPlanFile(projectTmpDir, runId, createCompleteRollbackPlanContent(runId));
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：exists=true
    assert.equal(result.exists, true, "文件存在时应 exists=true");
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RL-005b. 文件存在 + 5 字段齐全时 valid=true", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    createRollbackPlanFile(projectTmpDir, runId, createCompleteRollbackPlanContent(runId));
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：valid=true
    assert.equal(result.valid, true, `5 字段齐全时应 valid=true，实际 failures：${result.failures.join("; ")}`);
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RL-005c. 文件存在 + 5 字段齐全时 failures 为空数组", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    createRollbackPlanFile(projectTmpDir, runId, createCompleteRollbackPlanContent(runId));
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：failures 为空数组
    assert.equal(result.failures.length, 0, `5 字段齐全时 failures 应为空，实际：${result.failures.join("; ")}`);
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RL-005d. filePath 以 .md 结尾", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    createRollbackPlanFile(projectTmpDir, runId, createCompleteRollbackPlanContent(runId));
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：filePath 以 .md 结尾
    assert.ok(result.filePath.endsWith(".md"), `filePath 应以 .md 结尾，实际：${result.filePath}`);
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RL-005e. result 被 Object.freeze 冻结", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    createRollbackPlanFile(projectTmpDir, runId, createCompleteRollbackPlanContent(runId));
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：result 对象被冻结
    assert.equal(Object.isFrozen(result), true, "result 应被 Object.freeze 冻结");
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RL-005f. failures 数组被冻结", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    createRollbackPlanFile(projectTmpDir, runId, createCompleteRollbackPlanContent(runId));
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：failures 数组被冻结
    assert.equal(Object.isFrozen(result.failures), true, "failures 数组应被 Object.freeze 冻结");
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-G8-006 / TC-RL-006. 文件缺失 exists=false
// ============================================================================

test("TC-RL-006a. 文件缺失时 exists=false", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    // 不创建回滚预案文件
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：exists=false
    assert.equal(result.exists, false, "文件缺失时应 exists=false");
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RL-006b. 文件缺失时 valid=false", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：valid=false
    assert.equal(result.valid, false, "文件缺失时应 valid=false");
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RL-006c. 文件缺失时 failures 含 '回滚预案文件不存在'", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：failures 含 "回滚预案文件不存在"
    const failuresStr = result.failures.join(" ");
    assert.ok(failuresStr.includes("回滚预案文件不存在"), `failures 应含 "回滚预案文件不存在"，实际：${failuresStr}`);
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RL-006d. 文件缺失时 filePath 为预期路径（含 runId）", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：filePath 含 runId 与 .md 扩展名
    assert.ok(result.filePath.includes(runId), `filePath 应含 runId "${runId}"，实际：${result.filePath}`);
    assert.ok(result.filePath.endsWith(".md"), `filePath 应以 .md 结尾，实际：${result.filePath}`);
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-G8-007 / TC-RL-007. 字段缺失 valid=false + 缺失字段名
// ============================================================================

test("TC-RL-007a. 单章节缺失时 exists=true", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    // 缺失 "目标版本号" 章节
    createRollbackPlanFile(projectTmpDir, runId, createIncompleteRollbackPlanContent(runId, ["目标版本号"]));
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：exists=true
    assert.equal(result.exists, true, "文件存在时应 exists=true");
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RL-007b. 单章节缺失时 valid=false", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    createRollbackPlanFile(projectTmpDir, runId, createIncompleteRollbackPlanContent(runId, ["目标版本号"]));
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：valid=false
    assert.equal(result.valid, false, "章节缺失时应 valid=false");
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RL-007c. 单章节缺失时 failures 含具体缺失章节名", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    createRollbackPlanFile(projectTmpDir, runId, createIncompleteRollbackPlanContent(runId, ["目标版本号"]));
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：failures 含 "目标版本号" 章节名
    const failuresStr = result.failures.join(" ");
    assert.ok(failuresStr.includes("目标版本号"), `failures 应含缺失章节名 "目标版本号"，实际：${failuresStr}`);
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RL-007d. 单章节缺失时仅含对应缺失章节（不误报其他章节）", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    createRollbackPlanFile(projectTmpDir, runId, createIncompleteRollbackPlanContent(runId, ["回滚命令"]));
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：failures 仅含 "回滚命令" 章节名（不误报其他章节）
    assert.equal(result.failures.length, 1, `单章节缺失时 failures 应仅含 1 条，实际：${result.failures.length}`);
    assert.ok(result.failures[0].includes("回滚命令"), `failures 应含 "回滚命令"，实际：${result.failures[0]}`);
    // 验证：不误报其他章节
    const failuresStr = result.failures.join(" ");
    assert.ok(!failuresStr.includes("目标版本号"), "不应误报 '目标版本号' 缺失");
    assert.ok(!failuresStr.includes("资源清单"), "不应误报 '资源清单' 缺失");
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RL-007e. 多章节缺失时 failures 含全部缺失章节", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    // 缺失 3 个章节
    const missingSections = ["目标版本号", "回滚命令", "资源清单"];
    createRollbackPlanFile(projectTmpDir, runId, createIncompleteRollbackPlanContent(runId, missingSections));
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：valid=false
    assert.equal(result.valid, false, "多章节缺失时应 valid=false");
    // 验证：failures 含全部 3 个缺失章节
    assert.equal(result.failures.length, 3, `3 章节缺失时 failures 应含 3 条，实际：${result.failures.length}`);
    const failuresStr = result.failures.join(" ");
    for (const section of missingSections) {
      assert.ok(failuresStr.includes(section), `failures 应含缺失章节名 "${section}"，实际：${failuresStr}`);
    }
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-G8-008 / TC-RL-008. 文件存在但内容为空 valid=false
// ============================================================================

test("TC-RL-008a. 文件存在但内容为空时 exists=true", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    // 创建空内容的回滚预案文件
    createRollbackPlanFile(projectTmpDir, runId, "");
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：exists=true
    assert.equal(result.exists, true, "文件存在时应 exists=true");
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RL-008b. 文件存在但内容为空时 valid=false", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    createRollbackPlanFile(projectTmpDir, runId, "");
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：valid=false
    assert.equal(result.valid, false, "内容为空时应 valid=false");
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

test("TC-RL-008c. 文件存在但内容为空时 failures 含全部 5 个章节名", async () => {
  const projectTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-rpc-"));
  const runId = "test-run-001";
  try {
    createRollbackPlanFile(projectTmpDir, runId, "");
    const checker = new RollbackPlanCheckerImpl();
    const result = await checker.check(createRollbackPlanContext(projectTmpDir, runId));

    // 验证：failures 含全部 5 个章节名
    assert.equal(
      result.failures.length,
      5,
      `内容为空时 failures 应含 5 条（全部章节缺失），实际：${result.failures.length}`
    );
    const failuresStr = result.failures.join(" ");
    const allSections = ["目标版本号", "回滚命令", "资源清单", "创建时间戳", "runId"];
    for (const section of allSections) {
      assert.ok(failuresStr.includes(section), `failures 应含章节名 "${section}"，实际：${failuresStr}`);
    }
  } finally {
    fs.rmSync(projectTmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// RollbackPlanCheckerImpl 实例化测试
// ============================================================================

test("TC-RPC-001. RollbackPlanCheckerImpl 实例化成功", () => {
  const checker = new RollbackPlanCheckerImpl();
  assert.ok(checker instanceof RollbackPlanCheckerImpl);
});

test("TC-RPC-002. RollbackPlanCheckerImpl 实例被 Object.freeze 冻结", () => {
  const checker = new RollbackPlanCheckerImpl();
  assert.equal(Object.isFrozen(checker), true, "实例应被 Object.freeze 冻结");
});

test("TC-RPC-003. RollbackPlanCheckerImpl 实现 RollbackPlanChecker 接口", async () => {
  const checker = new RollbackPlanCheckerImpl();
  assert.equal(typeof checker.check, "function", "应实现 check 方法");
});
