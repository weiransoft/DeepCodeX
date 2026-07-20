/**
 * SmokeTestRunner —— 烟雾测试执行器（EAG-P4 批次 13 Phase 5 D2-4）
 *
 * 核心职责：
 * - 按测试用例发起真实 HTTP 请求，验证部署后端点是否可用
 * - 对每个 endpoint × testCase 组合执行测试
 * - 收集失败用例，返回结构化结果
 *
 * 真实 HTTP 请求（对齐 P-5 测试不使用 mock）：
 * - 使用 node:http / node:https 发起请求（根据 URL 协议自动选择）
 * - 超时 5 秒，避免长时间阻塞
 *
 * 不可变优先（§5.12.4 G-A6d）：
 * - run() 返回的 SmokeTestResult 对象通过 Object.freeze 冻结
 * - failures 数组通过 Object.freeze 冻结
 * - SmokeTestFailure 对象通过 Object.freeze 冻结
 *
 * @module eag/deploy/smoke-test-runner
 */

import http from "node:http";
import https from "node:https";
import type { SmokeTestRunner, SmokeTestCase, SmokeTestResult, SmokeTestFailure } from "../devops/types";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 默认 HTTP 请求超时时间（毫秒）
 *
 * 取值理由：
 * - 5 秒覆盖绝大部分健康端点响应时间（P99 < 1s）
 * - 超过 5 秒未响应的端点视为不健康，避免长时间阻塞烟雾测试流程
 * - 与 PostDeployChecker 中 TCP 连接超时保持一致（5 秒）
 */
const DEFAULT_TIMEOUT_MS = 5000;

// ============================================================================
// 内部类型定义
// ============================================================================

/**
 * 单次 HTTP 请求执行结果（内部使用，不对外导出）
 *
 * 字段说明：
 * - statusCode：HTTP 响应状态码；请求失败时为 0
 * - body：响应体字符串；请求失败时为空字符串
 * - errorMessage：错误信息；请求成功时为空字符串
 */
interface HttpRequestOutcome {
  readonly statusCode: number;
  readonly body: string;
  readonly errorMessage: string;
}

// ============================================================================
// SmokeTestRunnerImpl 类
// ============================================================================

/**
 * SmokeTestRunner 实现类
 *
 * 执行流程：
 * 1. 遍历 endpoints × testCases 笛卡尔积，对每个组合执行 HTTP 请求
 * 2. 根据端点 URL 协议（http:// 或 https://）自动选择 node:http / node:https
 * 3. 拼接 endpoint + testCase.path 作为完整请求 URL
 * 4. 按 testCase.method 发起 HTTP 请求，超时控制默认 5000ms
 * 5. 校验响应状态码是否匹配 expectedStatusCode
 * 6. 如 expectedBodyContains 提供，校验响应体是否包含该字符串
 * 7. 收集所有失败的测试用例到 failures 数组
 * 8. 返回 SmokeTestResult（passed = failedTests === 0）
 *
 * 不可变优先：
 * - run() 返回的 SmokeTestResult 对象通过 Object.freeze 冻结
 * - failures 数组通过 Object.freeze 冻结
 * - SmokeTestFailure 对象通过 Object.freeze 冻结
 *
 * 使用方式：
 *   const runner = new SmokeTestRunnerImpl();
 *   const result = await runner.run(
 *     ["http://myapp.example.com"],
 *     [{ name: "healthz", method: "GET", path: "/healthz", expectedStatusCode: 200 }]
 *   );
 *   if (!result.passed) {
 *     // 烟雾测试未通过，触发回滚或提示用户修复
 *   }
 */
export class SmokeTestRunnerImpl implements SmokeTestRunner {
  /** HTTP 请求超时时间（毫秒），默认 5000ms */
  private readonly timeoutMs: number;

  /**
   * 构造函数
   *
   * @param timeoutMs HTTP 请求超时时间（毫秒），默认 5000ms
   */
  constructor(timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * 执行烟雾测试
   *
   * 执行逻辑：
   * 1. 计算 endpoints × testCases 笛卡尔积，得到全部待执行的测试组合
   * 2. 对每个组合并发执行 HTTP 请求（Promise.all，提高执行效率）
   * 3. 收集所有失败的测试用例到 failures 数组
   * 4. 计算 totalTests / passedTests / failedTests / duration
   * 5. 构造 SmokeTestResult 并 Object.freeze 冻结返回
   *
   * 边界场景处理：
   * - endpoints 为空 → totalTests=0, passedTests=0, failedTests=0, passed=true
   * - testCases 为空 → totalTests=0, passedTests=0, failedTests=0, passed=true
   * - URL 解析失败 → 该用例视为失败，记录到 failures
   * - HTTP 请求超时 → 该用例视为失败，errorMessage="timeout"
   * - HTTP 请求错误（如 ECONNREFUSED）→ 该用例视为失败，记录到 failures
   *
   * @param endpoints 健康端点 URL 列表（如 ["http://myapp.example.com"]）
   * @param testCases 测试用例列表
   * @returns 烟雾测试结果（已冻结）
   */
  public async run(
    endpoints: ReadonlyArray<string>,
    testCases: ReadonlyArray<SmokeTestCase>
  ): Promise<SmokeTestResult> {
    // 记录开始时间，用于计算总耗时
    const startedAt = Date.now();

    // 收集全部失败用例（非短路求值，便于用户一次性看到所有失败项）
    const failures: SmokeTestFailure[] = [];

    // 计算 endpoints × testCases 笛卡尔积，生成全部待执行的测试任务
    // 边界场景：endpoints 或 testCases 为空时，tasks 为空数组
    // tasks 数组本身是内部可变状态（仅用于收集任务），最终在 Promise.all 后不再使用
    const tasks: Array<{ readonly endpoint: string; readonly testCase: SmokeTestCase }> = [];
    for (const endpoint of endpoints) {
      for (const testCase of testCases) {
        // 任务对象本身通过 Object.freeze 冻结，保持不可变优先原则
        tasks.push(
          Object.freeze({
            endpoint,
            testCase,
          }) as { readonly endpoint: string; readonly testCase: SmokeTestCase }
        );
      }
    }

    // 测试用例总数 = endpoints × testCases 笛卡尔积的大小
    const totalTests = tasks.length;

    // 并发执行所有测试任务，提高执行效率（每个任务独立，互不依赖）
    // 每个任务返回 null（通过）或 SmokeTestFailure（失败）
    const results = await Promise.all(tasks.map((task) => this.executeSingleTest(task.endpoint, task.testCase)));

    // 收集所有失败用例
    for (const result of results) {
      if (result !== null) {
        // 失败用例对象本身已冻结（在 executeSingleTest 中冻结）
        failures.push(result);
      }
    }

    // 计算通过 / 失败用例数
    const passedTests = totalTests - failures.length;
    const failedTests = failures.length;

    // 计算总耗时（毫秒）
    const duration = Date.now() - startedAt;

    // passed = failedTests === 0（无失败用例即视为通过）
    // 边界场景：totalTests=0 时，failedTests=0，passed=true（空集合视为通过）
    const passed = failedTests === 0;

    // 构造结果对象（不可变优先：对象和数组均通过 Object.freeze 冻结）
    return Object.freeze({
      passed,
      totalTests,
      passedTests,
      failedTests,
      duration,
      failures: Object.freeze(failures) as ReadonlyArray<SmokeTestFailure>,
    }) as SmokeTestResult;
  }

  /**
   * 执行单个 endpoint × testCase 组合的测试
   *
   * 执行逻辑：
   * 1. 拼接完整 URL（endpoint + testCase.path）
   * 2. 解析 URL，根据协议（http:// 或 https://）选择 node:http 或 node:https
   * 3. 发起 HTTP 请求，应用超时控制（默认 5000ms）
   * 4. 收集响应状态码和响应体
   * 5. 校验响应状态码是否匹配 expectedStatusCode
   * 6. 如果 expectedBodyContains 提供，校验响应体是否包含该字符串
   * 7. 全部校验通过 → 返回 null；任一校验失败 → 返回 SmokeTestFailure
   *
   * 失败场景分类：
   * - URL 解析失败：expected="valid URL", actual=原始 URL, errorMessage=解析错误信息
   * - HTTP 请求错误（连接拒绝 / DNS 解析失败）：expected=期望状态码, actual="请求失败", errorMessage=错误信息
   * - HTTP 请求超时：expected=期望状态码, actual="请求超时", errorMessage="timeout after Xms"
   * - 状态码不匹配：expected="HTTP 200", actual="HTTP 404", errorMessage=""
   * - 响应体不包含预期字符串：expected="body contains 'OK'", actual="响应体内容", errorMessage=""
   *
   * @param endpoint 健康端点 URL（如 "http://myapp.example.com"）
   * @param testCase 测试用例
   * @returns null=测试通过；SmokeTestFailure=测试失败（已冻结）
   */
  private async executeSingleTest(endpoint: string, testCase: SmokeTestCase): Promise<SmokeTestFailure | null> {
    // 拼接完整 URL（endpoint + testCase.path）
    // 注意：endpoint 可能以 / 结尾（如 http://host/），testCase.path 可能以 / 开头（如 /healthz）
    // 简单拼接会产生 http://host//healthz（双斜杠），但 new URL() 构造函数会自动规范化为 /healthz
    // 若未来需要更严格的 URL 规范化，可改用 new URL(testCase.path, endpoint).toString()
    const fullUrl = `${endpoint}${testCase.path}`;

    // 解析 URL，根据协议选择 http 或 https 模块
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(fullUrl);
    } catch (error) {
      // URL 解析失败：构造失败用例返回
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.createFailure(testCase, "valid URL", fullUrl, `URL 解析失败：${errorMessage}`);
    }

    // 根据协议选择 http 或 https 模块（非 http/https 协议视为失败）
    let client: typeof http | typeof https;
    if (parsedUrl.protocol === "http:") {
      client = http;
    } else if (parsedUrl.protocol === "https:") {
      client = https;
    } else {
      // 不支持的协议（如 ftp: / file:）：构造失败用例返回
      return this.createFailure(
        testCase,
        "http:// or https://",
        parsedUrl.protocol,
        `不支持的协议：${parsedUrl.protocol}`
      );
    }

    // 发起 HTTP 请求，收集响应状态码和响应体
    const outcome = await this.performHttpRequest(client, parsedUrl, testCase.method);

    // 校验 1: HTTP 请求本身是否成功（请求失败 / 超时）
    if (outcome.errorMessage !== "") {
      // 请求失败：构造失败用例返回
      return this.createFailure(testCase, `HTTP ${testCase.expectedStatusCode}`, "请求失败", outcome.errorMessage);
    }

    // 校验 2: 响应状态码是否匹配 expectedStatusCode
    if (outcome.statusCode !== testCase.expectedStatusCode) {
      // 状态码不匹配：构造失败用例返回
      return this.createFailure(
        testCase,
        `HTTP ${testCase.expectedStatusCode}`,
        `HTTP ${outcome.statusCode}`,
        `状态码不匹配`
      );
    }

    // 校验 3: 如果 expectedBodyContains 提供，校验响应体是否包含该字符串
    if (testCase.expectedBodyContains !== undefined) {
      if (!outcome.body.includes(testCase.expectedBodyContains)) {
        // 响应体不包含预期字符串：构造失败用例返回
        return this.createFailure(
          testCase,
          `response body contains '${testCase.expectedBodyContains}'`,
          `response body (length=${outcome.body.length})`,
          `响应体不包含预期字符串：${testCase.expectedBodyContains}`
        );
      }
    }

    // 全部校验通过：返回 null（表示该用例通过）
    return null;
  }

  /**
   * 执行单次 HTTP 请求
   *
   * 实现细节：
   * 1. 使用 node:http / node:https 的 request API 发起请求
   * 2. 通过 setTimeout 设置超时（默认 5000ms），超时后销毁请求并返回 timeout 错误
   * 3. 监听 'response' 事件，收集响应数据
   * 4. 监听 'error' 事件，捕获连接错误（如 ECONNREFUSED / ENOTFOUND）
   * 5. GET / DELETE 请求不写入请求体；POST / PUT 请求写入空请求体（批次 13 不支持自定义请求体）
   *
   * 超时处理说明：
   * - setTimeout 在 this.timeoutMs 毫秒后销毁请求对象（req.destroy()）
   * - 销毁后 'error' 事件会被触发，error.code === 'ABORTED'
   * - 此处将超时错误转换为 errorMessage="timeout after Xms"，便于 failures 中展示
   *
   * @param client node:http 或 node:https 模块
   * @param url 已解析的 URL 对象
   * @param method HTTP 方法（GET / POST / PUT / DELETE）
   * @returns HttpRequestOutcome 含 statusCode / body / errorMessage
   */
  private performHttpRequest(
    client: typeof http | typeof https,
    url: URL,
    method: string
  ): Promise<HttpRequestOutcome> {
    return new Promise<HttpRequestOutcome>((resolve) => {
      // 配置请求选项
      const options: https.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        // 超时控制：this.timeoutMs 毫秒后触发 'timeout' 事件
        timeout: this.timeoutMs,
      };

      // 发起 HTTP 请求
      const req = client.request(options, (res) => {
        // 收集响应数据（Buffer 拼接，最后转为字符串）
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          // 响应结束：返回状态码和响应体
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            errorMessage: "",
          });
        });
        // 响应流错误（如响应中途断开）
        res.on("error", (error: Error) => {
          resolve({
            statusCode: 0,
            body: "",
            errorMessage: `响应流错误：${error.message}`,
          });
        });
      });

      // 请求超时：销毁请求并返回 timeout 错误
      req.on("timeout", () => {
        // 销毁请求，触发 'error' 事件（但此处直接 resolve，避免重复处理）
        req.destroy();
        resolve({
          statusCode: 0,
          body: "",
          errorMessage: `timeout after ${this.timeoutMs}ms`,
        });
      });

      // 请求错误：捕获连接错误（如 ECONNREFUSED / ENOTFOUND / ECONNRESET）
      req.on("error", (error: NodeJS.ErrnoException) => {
        resolve({
          statusCode: 0,
          body: "",
          errorMessage: `请求错误：${error.message}${error.code ? `（code=${error.code}）` : ""}`,
        });
      });

      // 写入请求体（POST / PUT 需要调用 end() 触发请求；GET / DELETE 也需要 end()）
      // 批次 13 不支持自定义请求体，统一发送空请求体
      req.end();
    });
  }

  /**
   * 构造 SmokeTestFailure 对象（并 Object.freeze 冻结）
   *
   * @param testCase 测试用例（用于提取 testName）
   * @param expected 期望结果描述
   * @param actual 实际结果描述
   * @param errorMessage 错误信息
   * @returns 已冻结的 SmokeTestFailure 对象
   */
  private createFailure(
    testCase: SmokeTestCase,
    expected: string,
    actual: string,
    errorMessage: string
  ): SmokeTestFailure {
    return Object.freeze({
      testName: testCase.name,
      expected,
      actual,
      errorMessage,
    }) as SmokeTestFailure;
  }
}
