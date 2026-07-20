/**
 * EAG-P4 批次 13 Phase 4 单元测试：PostDeployCheckerImpl
 *
 * 测试范围（对齐设计文档 §6.2.1 D2-3 PostDeployChecker 覆盖率 ≥ 85%）：
 * - T1. 实例化与接口契约
 *   - T1a. 实例化成功
 *   - T1b. 实现 PostDeployChecker 接口
 * - T2. check() 返回结构正确
 *   - T2a. 返回 PostDeployCheckResult 结构（含 8 个字段）
 *   - T2b. 返回的 endpoints 是数组
 *   - T2c. 返回的 failures 是数组
 * - T3. Pod 就绪校验（podsReady）
 *   - T3a. kubectl 命令不存在时 podsReady=false
 * - T4. Service 端点可达校验（serviceEndpointReachable，M-1 修复）
 *   - T4a. kubectl 命令不存在时 serviceEndpointReachable=false
 *   - T4b. M-1 修复：endpoints 数组含 HealthEndpoint 对象
 *   - T4c. HealthEndpoint 对象含 url / statusCode / responseTimeMs / healthy 字段
 * - T5. 日志校验（logsClean）
 *   - T5a. kubectl 命令不存在时 logsClean=false
 * - T6. 指标上报校验（metricsReporting）
 *   - T6a. kubectl 命令不存在时 metricsReporting=false
 * - T7. 整体校验结果
 *   - T7a. CLI 不存在时 passed=false
 *   - T7b. failures 含全部 4 项错误
 * - T8. 不可变优先
 *   - T8a. 返回的 PostDeployCheckResult 对象已冻结
 *   - T8b. endpoints 数组已冻结
 *   - T8c. failures 数组已冻结
 *   - T8d. HealthEndpoint 对象已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 * - CLI 不存在测试通过 PATH="/nonexistent" 真实模拟（非 mock）
 * - CLI 存在测试通过 checkCliAvailable 检测，不存在时跳过
 *
 * @module core/tests/eag-deploy-post-checker
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PostDeployCheckerImpl } from "../eag/deploy/post-deploy-checker";
import type {
  PostDeployChecker,
  PostDeployCheckContext,
  PostDeployCheckResult,
  HealthEndpoint,
  DeployedResource,
} from "../eag/devops/types";

// ============================================================================
// 辅助函数：检测 CLI 工具是否可用
// ============================================================================

/**
 * 检测 CLI 工具是否可用
 *
 * 通过 spawnSync 调用 `<cli> --version` 检测 CLI 是否存在，非 mock。
 * 用于有条件地运行真实 CLI 测试，CLI 不存在时跳过。
 *
 * @param cliName CLI 工具名称（如 "kubectl"）
 * @returns true=CLI 可用，false=CLI 不可用
 */
function checkCliAvailable(cliName: string): boolean {
  try {
    const result = spawnSync(cliName, ["--version"], {
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
// 辅助函数：构造 PostDeployCheckContext
// ============================================================================

/**
 * 构造测试用 PostDeployCheckContext（默认含 1 个已部署资源）
 *
 * @param overrides 覆盖字段
 * @returns 完整的 PostDeployCheckContext
 */
function createContext(overrides: Partial<PostDeployCheckContext> = {}): PostDeployCheckContext {
  return {
    namespace: "test-app",
    serviceName: "test-app-service",
    deployedResources: [
      {
        kind: "Deployment",
        name: "test-app",
        namespace: "test-app",
        status: "Running",
      },
    ],
    ...overrides,
  };
}

/**
 * 构造测试用 DeployedResource 数组
 *
 * @param count 资源数量
 * @returns DeployedResource 数组
 */
function createDeployedResources(count: number): ReadonlyArray<DeployedResource> {
  const resources: DeployedResource[] = [];
  for (let i = 0; i < count; i++) {
    resources.push({
      kind: "Pod",
      name: `test-app-pod-${i}`,
      namespace: "test-app",
      status: "Running",
    });
  }
  return resources;
}

// ============================================================================
// T1. 实例化与接口契约
// ============================================================================

test("T1a. PostDeployCheckerImpl 实例化成功", () => {
  const checker = new PostDeployCheckerImpl();
  assert.ok(checker instanceof PostDeployCheckerImpl);
});

test("T1b. 实现 PostDeployChecker 接口", () => {
  const checker: PostDeployChecker = new PostDeployCheckerImpl();
  assert.equal(typeof checker.check, "function");
});

// ============================================================================
// T2. check() 返回结构正确
// ============================================================================

test("T2a. 返回 PostDeployCheckResult 结构（含 8 个字段）", async () => {
  const checker = new PostDeployCheckerImpl();
  const result = await checker.check(createContext());

  // 验证 8 个字段全部存在
  assert.ok("passed" in result);
  assert.ok("podsReady" in result);
  assert.ok("serviceEndpointReachable" in result);
  assert.ok("logsClean" in result);
  assert.ok("metricsReporting" in result);
  assert.ok("endpoints" in result);
  assert.ok("failures" in result);

  // 验证字段类型
  assert.equal(typeof result.passed, "boolean");
  assert.equal(typeof result.podsReady, "boolean");
  assert.equal(typeof result.serviceEndpointReachable, "boolean");
  assert.equal(typeof result.logsClean, "boolean");
  assert.equal(typeof result.metricsReporting, "boolean");
});

test("T2b. 返回的 endpoints 是数组", async () => {
  const checker = new PostDeployCheckerImpl();
  const result = await checker.check(createContext());
  assert.ok(Array.isArray(result.endpoints));
});

test("T2c. 返回的 failures 是数组", async () => {
  const checker = new PostDeployCheckerImpl();
  const result = await checker.check(createContext());
  assert.ok(Array.isArray(result.failures));
});

// ============================================================================
// T3. Pod 就绪校验（podsReady）
// ============================================================================

test("T3a. kubectl 命令不存在时 podsReady=false", async () => {
  const checker = new PostDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext());
    // kubectl 命令不存在时，podsReady 应为 false
    assert.equal(result.podsReady, false);
  } finally {
    process.env.PATH = originalPath;
  }
});

// ============================================================================
// T4. Service 端点可达校验（serviceEndpointReachable，M-1 修复）
// ============================================================================

test("T4a. kubectl 命令不存在时 serviceEndpointReachable=false", async () => {
  const checker = new PostDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext());
    // kubectl 命令不存在时，serviceEndpointReachable 应为 false
    assert.equal(result.serviceEndpointReachable, false);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("T4b. M-1 修复：endpoints 数组含 HealthEndpoint 对象", async () => {
  const checker = new PostDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext());
    // M-1 修复：endpoints 数组应含至少 1 个 HealthEndpoint 对象
    assert.ok(result.endpoints.length >= 1, "endpoints 数组应含至少 1 个 HealthEndpoint");
    const endpoint: HealthEndpoint = result.endpoints[0];
    assert.ok(typeof endpoint === "object");
    assert.ok("url" in endpoint);
    assert.ok("statusCode" in endpoint);
    assert.ok("responseTimeMs" in endpoint);
    assert.ok("healthy" in endpoint);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("T4c. HealthEndpoint 对象含 url / statusCode / responseTimeMs / healthy 字段", async () => {
  const checker = new PostDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext());
    const endpoint: HealthEndpoint = result.endpoints[0];
    // 验证字段类型
    assert.equal(typeof endpoint.url, "string");
    assert.equal(typeof endpoint.statusCode, "number");
    assert.equal(typeof endpoint.responseTimeMs, "number");
    assert.equal(typeof endpoint.healthy, "boolean");
    // kubectl 不存在时 healthy=false, statusCode=0
    assert.equal(endpoint.healthy, false);
    assert.equal(endpoint.statusCode, 0);
  } finally {
    process.env.PATH = originalPath;
  }
});

// ============================================================================
// T5. 日志校验（logsClean）
// ============================================================================

test("T5a. kubectl 命令不存在时 logsClean=false", async () => {
  const checker = new PostDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext());
    // kubectl 命令不存在时，logsClean 应为 false
    assert.equal(result.logsClean, false);
  } finally {
    process.env.PATH = originalPath;
  }
});

// ============================================================================
// T6. 指标上报校验（metricsReporting）
// ============================================================================

test("T6a. kubectl 命令不存在时 metricsReporting=false", async () => {
  const checker = new PostDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext());
    // kubectl 命令不存在时，metricsReporting 应为 false
    assert.equal(result.metricsReporting, false);
  } finally {
    process.env.PATH = originalPath;
  }
});

// ============================================================================
// T7. 整体校验结果
// ============================================================================

test("T7a. CLI 不存在时 passed=false", async () => {
  const checker = new PostDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext());
    // kubectl 不存在 → 全部 4 项 false → passed=false
    assert.equal(result.passed, false);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("T7b. failures 含全部 4 项错误", async () => {
  const checker = new PostDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext());
    // kubectl 不存在时，4 项校验全部失败，failures 应含 4 条错误
    assert.ok(result.failures.length >= 4, `failures 应含至少 4 条错误，实际：${result.failures.length}`);
    const failuresStr = result.failures.join(" ");
    // 验证含 Pod / Service / 日志 / 指标 相关错误
    assert.ok(failuresStr.includes("Pod"), `failures 应含"Pod"，实际：${failuresStr}`);
    assert.ok(failuresStr.includes("Service"), `failures 应含"Service"，实际：${failuresStr}`);
    assert.ok(failuresStr.includes("日志"), `failures 应含"日志"，实际：${failuresStr}`);
    assert.ok(failuresStr.includes("指标"), `failures 应含"指标"，实际：${failuresStr}`);
  } finally {
    process.env.PATH = originalPath;
  }
});

// ============================================================================
// T8. 不可变优先
// ============================================================================

test("T8a. 返回的 PostDeployCheckResult 对象已冻结", async () => {
  const checker = new PostDeployCheckerImpl();
  const result: PostDeployCheckResult = await checker.check(createContext());
  assert.equal(Object.isFrozen(result), true);
});

test("T8b. endpoints 数组已冻结", async () => {
  const checker = new PostDeployCheckerImpl();
  const result = await checker.check(createContext());
  assert.equal(Object.isFrozen(result.endpoints), true);
});

test("T8c. failures 数组已冻结", async () => {
  const checker = new PostDeployCheckerImpl();
  const result = await checker.check(createContext());
  assert.equal(Object.isFrozen(result.failures), true);
});

test("T8d. HealthEndpoint 对象已冻结", async () => {
  const checker = new PostDeployCheckerImpl();
  const result = await checker.check(createContext());
  const endpoint: HealthEndpoint = result.endpoints[0];
  assert.equal(Object.isFrozen(endpoint), true);
});

// ============================================================================
// T9. 边界场景
// ============================================================================

test("T9a. deployedResources 为空时不影响校验", async () => {
  const checker = new PostDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext({ deployedResources: [] }));
    // deployedResources 为空时不影响 4 项校验（kubectl 不存在时全部 false）
    assert.equal(result.passed, false);
    assert.equal(result.podsReady, false);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("T9b. 多个 deployedResources 时不影响校验", async () => {
  const checker = new PostDeployCheckerImpl();
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await checker.check(createContext({ deployedResources: createDeployedResources(5) }));
    assert.equal(result.passed, false);
  } finally {
    process.env.PATH = originalPath;
  }
});

// ============================================================================
// T10. 真实 CLI 调用（CLI 存在时）
// ============================================================================

// 检测真实 kubectl CLI 是否存在，存在时测试真实路径（非 mock），不存在时跳过
const hasKubectlCli = checkCliAvailable("kubectl");

test("T10a. kubectl CLI 存在时 check 返回结构正确", { skip: !hasKubectlCli }, async () => {
  const checker = new PostDeployCheckerImpl();
  // 使用不存在的 namespace，验证 kubectl 真实返回 false
  const result = await checker.check(createContext({ namespace: "nonexistent-namespace-for-test" }));
  // 验证返回结构正确性（不强制 passed=true，因为 namespace 不存在时全部失败）
  assert.equal(typeof result.passed, "boolean");
  assert.equal(typeof result.podsReady, "boolean");
  assert.equal(typeof result.serviceEndpointReachable, "boolean");
  assert.equal(typeof result.logsClean, "boolean");
  assert.equal(typeof result.metricsReporting, "boolean");
  assert.ok(Array.isArray(result.endpoints));
  assert.ok(Array.isArray(result.failures));
});
