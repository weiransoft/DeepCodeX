/**
 * EAG-P4 批次 13 Phase 4 单元测试：SmokeTestRunnerImpl（D2-4 补全）
 *
 * 测试范围（对齐设计文档 §6.2.1 D2-4 SmokeTestRunner 覆盖率 ≥ 85%）：
 * - T1. 实例化与接口契约
 *   - T1a. 实例化成功
 *   - T1b. 实现 SmokeTestRunner 接口
 * - T2. 返回结构正确
 *   - T2a. SmokeTestResult 结构（含 6 个字段）
 *   - T2b. failures 是数组
 * - T3. 连接失败场景
 *   - T3a. 连接不存在的端口时 passed=false
 *   - T3b. failures 含失败用例
 * - T4. 状态码不匹配场景
 *   - T4a. 期望 200 实际 404 时 passed=false
 * - T5. 响应体不包含预期字符串场景
 *   - T5a. expectedBodyContains 不匹配时 passed=false
 * - T6. 所有用例通过场景
 *   - T6a. 启动本地 HTTP 服务器，所有用例通过时 passed=true
 * - T7. 边界场景
 *   - T7a. 空 endpoints
 *   - T7b. 空 testCases
 * - T8. 不可变优先
 *   - T8a. SmokeTestResult 已冻结
 *   - T8b. failures 已冻结
 *   - T8c. SmokeTestFailure 已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 * - 启动本地 HTTP 服务器进行真实 HTTP 请求测试（使用 node:http.createServer）
 * - 测试完成后关闭 HTTP 服务器
 *
 * @module core/tests/eag-deploy-smoke-test-runner
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SmokeTestRunnerImpl } from "../eag/deploy/smoke-test-runner";
import type { SmokeTestRunner, SmokeTestCase, SmokeTestResult, SmokeTestFailure } from "../eag/devops/types";

// ============================================================================
// 辅助函数：启动本地 HTTP 服务器
// ============================================================================

/**
 * 启动本地 HTTP 服务器用于真实 HTTP 请求测试（非 mock）
 *
 * 服务器行为：
 * - GET /healthz → 200 "OK"
 * - GET /api/status → 200 '{"status":"healthy"}'
 * - GET /notfound → 404 "Not Found"
 * - POST /api/echo → 200 "echo"
 * - 其他路径 → 404 "Not Found"
 *
 * @returns Promise，resolve 为 { server, baseUrl }，baseUrl 形如 "http://127.0.0.1:PORT"
 */
function startLocalHttpServer(): Promise<{
  server: http.Server;
  baseUrl: string;
}> {
  return new Promise((resolve, reject) => {
    // 创建 HTTP 服务器（真实服务器，非 mock）
    const server = http.createServer((req, res) => {
      // 设置响应头
      res.setHeader("Content-Type", "text/plain");

      // 路由处理
      const url = req.url ?? "/";
      if (req.method === "GET" && url === "/healthz") {
        res.statusCode = 200;
        res.end("OK");
      } else if (req.method === "GET" && url === "/api/status") {
        res.statusCode = 200;
        res.end('{"status":"healthy"}');
      } else if (req.method === "GET" && url === "/notfound") {
        res.statusCode = 404;
        res.end("Not Found");
      } else if (req.method === "POST" && url === "/api/echo") {
        res.statusCode = 200;
        res.end("echo");
      } else {
        res.statusCode = 404;
        res.end("Not Found");
      }
    });

    // 监听随机端口（端口 0 让系统自动分配可用端口）
    server.on("error", (error: Error) => {
      reject(error);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      resolve({ server, baseUrl });
    });
  });
}

/**
 * 关闭本地 HTTP 服务器
 *
 * @param server 待关闭的 HTTP 服务器
 * @returns Promise，resolve 时服务器已关闭
 */
function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

// ============================================================================
// 辅助函数：构造 SmokeTestCase
// ============================================================================

/**
 * 构造测试用 SmokeTestCase（GET /healthz，期望 200）
 *
 * @param overrides 覆盖字段
 * @returns 完整的 SmokeTestCase
 */
function createTestCase(overrides: Partial<SmokeTestCase> = {}): SmokeTestCase {
  return {
    name: "healthz",
    method: "GET",
    path: "/healthz",
    expectedStatusCode: 200,
    ...overrides,
  };
}

// ============================================================================
// T1. 实例化与接口契约
// ============================================================================

test("T1a. SmokeTestRunnerImpl 实例化成功", () => {
  const runner = new SmokeTestRunnerImpl();
  assert.ok(runner instanceof SmokeTestRunnerImpl);
});

test("T1b. 实现 SmokeTestRunner 接口", () => {
  const runner: SmokeTestRunner = new SmokeTestRunnerImpl();
  assert.equal(typeof runner.run, "function");
});

// ============================================================================
// T2. 返回结构正确
// ============================================================================

test("T2a. 返回 SmokeTestResult 结构（含 6 个字段）", async () => {
  const runner = new SmokeTestRunnerImpl();
  // 使用连接不存在的端口，触发请求失败，但返回结构应正确
  const result = await runner.run(["http://127.0.0.1:1"], [createTestCase()]);

  // 验证 6 个字段全部存在
  assert.ok("passed" in result);
  assert.ok("totalTests" in result);
  assert.ok("passedTests" in result);
  assert.ok("failedTests" in result);
  assert.ok("duration" in result);
  assert.ok("failures" in result);

  // 验证字段类型
  assert.equal(typeof result.passed, "boolean");
  assert.equal(typeof result.totalTests, "number");
  assert.equal(typeof result.passedTests, "number");
  assert.equal(typeof result.failedTests, "number");
  assert.equal(typeof result.duration, "number");
});

test("T2b. failures 是数组", async () => {
  const runner = new SmokeTestRunnerImpl();
  const result = await runner.run(["http://127.0.0.1:1"], [createTestCase()]);
  assert.ok(Array.isArray(result.failures));
});

// ============================================================================
// T3. 连接失败场景
// ============================================================================

test("T3a. 连接不存在的端口时 passed=false", async () => {
  const runner = new SmokeTestRunnerImpl();
  // 端口 1 是特权端口，普通用户无权限监听，必然连接失败（ECONNREFUSED）
  const result = await runner.run(["http://127.0.0.1:1"], [createTestCase()]);
  // 连接失败 → failedTests=1 → passed=false
  assert.equal(result.passed, false);
  assert.equal(result.failedTests, 1);
  assert.equal(result.passedTests, 0);
  assert.equal(result.totalTests, 1);
});

test("T3b. failures 含失败用例（包含 testName / expected / actual / errorMessage）", async () => {
  const runner = new SmokeTestRunnerImpl();
  const result = await runner.run(["http://127.0.0.1:1"], [createTestCase()]);

  // 验证 failures 含至少 1 条失败用例
  assert.ok(result.failures.length >= 1, "failures 应含至少 1 条失败用例");

  // 验证 SmokeTestFailure 结构（4 个字段）
  const failure: SmokeTestFailure = result.failures[0];
  assert.ok("testName" in failure);
  assert.ok("expected" in failure);
  assert.ok("actual" in failure);
  assert.ok("errorMessage" in failure);

  // 验证字段类型
  assert.equal(typeof failure.testName, "string");
  assert.equal(typeof failure.expected, "string");
  assert.equal(typeof failure.actual, "string");
  assert.equal(typeof failure.errorMessage, "string");

  // 验证 testName 与用例名称一致
  assert.equal(failure.testName, "healthz");
});

// ============================================================================
// T4. 状态码不匹配场景
// ============================================================================

test("T4a. 期望 200 实际 404 时 passed=false", async () => {
  const { server, baseUrl } = await startLocalHttpServer();
  try {
    const runner = new SmokeTestRunnerImpl();
    // 请求 /notfound 端点，服务器返回 404，期望 200 → 状态码不匹配
    const result = await runner.run(
      [baseUrl],
      [createTestCase({ name: "expect-200-but-404", path: "/notfound", expectedStatusCode: 200 })]
    );

    // 状态码不匹配 → failedTests=1 → passed=false
    assert.equal(result.passed, false);
    assert.equal(result.failedTests, 1);
    assert.equal(result.passedTests, 0);

    // 验证 failure 内容：expected="HTTP 200", actual="HTTP 404"
    const failure = result.failures[0];
    assert.equal(failure.expected, "HTTP 200");
    assert.equal(failure.actual, "HTTP 404");
    assert.equal(failure.errorMessage, "状态码不匹配");
  } finally {
    await closeServer(server);
  }
});

// ============================================================================
// T5. 响应体不包含预期字符串场景
// ============================================================================

test("T5a. expectedBodyContains 不匹配时 passed=false", async () => {
  const { server, baseUrl } = await startLocalHttpServer();
  try {
    const runner = new SmokeTestRunnerImpl();
    // 请求 /healthz 端点，服务器返回 200 "OK"，但期望响应体包含 "healthy" → 不匹配
    const result = await runner.run(
      [baseUrl],
      [
        createTestCase({
          name: "body-not-contains",
          path: "/healthz",
          expectedStatusCode: 200,
          expectedBodyContains: "healthy",
        }),
      ]
    );

    // 响应体不包含 → failedTests=1 → passed=false
    assert.equal(result.passed, false);
    assert.equal(result.failedTests, 1);

    // 验证 failure 内容
    const failure = result.failures[0];
    assert.equal(failure.testName, "body-not-contains");
    assert.ok(failure.expected.includes("healthy"), `expected 应含 'healthy'，实际：${failure.expected}`);
    assert.ok(failure.errorMessage.includes("healthy"), `errorMessage 应含 'healthy'，实际：${failure.errorMessage}`);
  } finally {
    await closeServer(server);
  }
});

// ============================================================================
// T6. 所有用例通过场景
// ============================================================================

test("T6a. 启动本地 HTTP 服务器，所有用例通过时 passed=true", async () => {
  const { server, baseUrl } = await startLocalHttpServer();
  try {
    const runner = new SmokeTestRunnerImpl();
    // 构造多个会全部通过的用例
    const testCases: ReadonlyArray<SmokeTestCase> = [
      createTestCase({ name: "healthz", path: "/healthz", expectedStatusCode: 200, expectedBodyContains: "OK" }),
      createTestCase({
        name: "api-status",
        path: "/api/status",
        expectedStatusCode: 200,
        expectedBodyContains: "healthy",
        method: "GET",
      }),
      createTestCase({
        name: "post-echo",
        path: "/api/echo",
        expectedStatusCode: 200,
        method: "POST",
      }),
    ];

    const result = await runner.run([baseUrl], testCases);

    // 所有用例通过 → failedTests=0 → passed=true
    assert.equal(result.passed, true);
    assert.equal(result.totalTests, 3);
    assert.equal(result.passedTests, 3);
    assert.equal(result.failedTests, 0);
    assert.equal(result.failures.length, 0);
  } finally {
    await closeServer(server);
  }
});

// ============================================================================
// T7. 边界场景
// ============================================================================

test("T7a. 空 endpoints 时 passed=true（空集合视为通过）", async () => {
  const runner = new SmokeTestRunnerImpl();
  const result = await runner.run([], [createTestCase()]);

  // endpoints 为空 → tasks 为空 → totalTests=0, failedTests=0 → passed=true
  assert.equal(result.passed, true);
  assert.equal(result.totalTests, 0);
  assert.equal(result.passedTests, 0);
  assert.equal(result.failedTests, 0);
  assert.equal(result.failures.length, 0);
});

test("T7b. 空 testCases 时 passed=true（空集合视为通过）", async () => {
  const runner = new SmokeTestRunnerImpl();
  const result = await runner.run(["http://127.0.0.1:1"], []);

  // testCases 为空 → tasks 为空 → totalTests=0, failedTests=0 → passed=true
  assert.equal(result.passed, true);
  assert.equal(result.totalTests, 0);
  assert.equal(result.passedTests, 0);
  assert.equal(result.failedTests, 0);
  assert.equal(result.failures.length, 0);
});

// ============================================================================
// T8. 不可变优先
// ============================================================================

test("T8a. SmokeTestResult 已冻结", async () => {
  const runner = new SmokeTestRunnerImpl();
  const result: SmokeTestResult = await runner.run(["http://127.0.0.1:1"], [createTestCase()]);
  assert.equal(Object.isFrozen(result), true);
});

test("T8b. failures 数组已冻结", async () => {
  const runner = new SmokeTestRunnerImpl();
  const result = await runner.run(["http://127.0.0.1:1"], [createTestCase()]);
  assert.equal(Object.isFrozen(result.failures), true);
});

test("T8c. SmokeTestFailure 已冻结", async () => {
  const runner = new SmokeTestRunnerImpl();
  const result = await runner.run(["http://127.0.0.1:1"], [createTestCase()]);
  // failures 非空时验证第一个 failure 已冻结
  assert.ok(result.failures.length >= 1, "failures 应非空以验证 SmokeTestFailure 冻结状态");
  const failure: SmokeTestFailure = result.failures[0];
  assert.equal(Object.isFrozen(failure), true);
});

// ============================================================================
// T9. 多个 endpoints × 多个 testCases 笛卡尔积
// ============================================================================

test("T9a. 多个 endpoints × 多个 testCases 笛卡尔积正确执行", async () => {
  const { server, baseUrl } = await startLocalHttpServer();
  try {
    const runner = new SmokeTestRunnerImpl();
    // 2 个 endpoints × 2 个 testCases = 4 个组合
    const endpoints: ReadonlyArray<string> = [baseUrl, "http://127.0.0.1:1"];
    const testCases: ReadonlyArray<SmokeTestCase> = [
      createTestCase({ name: "healthz", path: "/healthz", expectedStatusCode: 200 }),
      createTestCase({ name: "notfound", path: "/notfound", expectedStatusCode: 404 }),
    ];

    const result = await runner.run(endpoints, testCases);

    // 2 × 2 = 4 个组合
    assert.equal(result.totalTests, 4);
    // 通过的用例：
    // - baseUrl + healthz → 200 ✓
    // - baseUrl + notfound → 404 ✓
    // - 127.0.0.1:1 + healthz → ECONNREFUSED ✗
    // - 127.0.0.1:1 + notfound → ECONNREFUSED ✗
    assert.equal(result.passedTests, 2);
    assert.equal(result.failedTests, 2);
    assert.equal(result.passed, false);
  } finally {
    await closeServer(server);
  }
});

// ============================================================================
// T10. URL 解析失败场景
// ============================================================================

test("T10a. URL 解析失败时 passed=false", async () => {
  const runner = new SmokeTestRunnerImpl();
  // 构造无效 URL（非 http/https 协议）
  const result = await runner.run(["ftp://invalid-protocol.example.com"], [createTestCase()]);

  // URL 协议不支持 → failedTests=1 → passed=false
  assert.equal(result.passed, false);
  assert.equal(result.failedTests, 1);

  // 验证 failure 内容：expected 应提示 http:// or https://
  const failure = result.failures[0];
  assert.ok(
    failure.expected.includes("http") || failure.errorMessage.includes("协议"),
    `expected 或 errorMessage 应含协议信息，expected=${failure.expected}, errorMessage=${failure.errorMessage}`
  );
});
