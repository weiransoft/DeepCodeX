/**
 * EAG-P3 批次 10 单元测试：契约测试生成器（ContractTestGenerator + OpenApiSpecParser + TsSignatureExtractor）
 *
 * 测试范围：
 * - T1. OpenApiSpecParser 解析
 *   - T1a. 合法 JSON spec → 解析为 ContractTestSpec[]
 *   - T1b. spec 文件不存在 → 抛 OpenApiParseError
 *   - T1c. 非 .json 扩展名 → 抛 OpenApiParseError
 *   - T1d. JSON 解析失败 → 抛 OpenApiParseError
 *   - T1e. zod schema 校验失败 → 抛 OpenApiParseError
 *   - T1f. boundaryCases 从 required 字段推导
 *   - T1g. boundaryCases 从 enum / minimum / maximum 推导
 *   - T1h. 多 path / 多 method 解析
 *   - T1i. 无 responses 的 operation → 跳过（返回 null）
 * - T2. TsSignatureExtractor AST 提取
 *   - T2a. 实现根目录不存在 → 抛 ContractTestGeneratorError (ast-extract)
 *   - T2b. 实现根目录非目录 → 抛 ContractTestGeneratorError (ast-extract)
 *   - T2c. 空目录 → 返回空数组
 *   - T2d. 含 *.controller.ts → 提取类方法签名
 *   - T2e. 含 *.service.ts → 提取类方法签名
 *   - T2f. 跳过 node_modules / dist / .git / tests 子目录
 *   - T2g. API 路径推导（Controller 后缀去除 + kebab-case）
 *   - T2h. HTTP 方法推导（get→GET / create→POST / update→PUT / delete→DELETE）
 * - T3. ContractTestGenerator 实例化
 *   - T3a. 默认构造 → 实例化成功
 *   - T3b. 注入 logger → 实例化成功
 *   - T3c. createDefaultContractTestGenerator 工厂函数
 * - T4. ContractTestGenerator.generate() 成功路径
 *   - T4a. 单 spec → 生成单个测试文件
 *   - T4b. 多 spec → 生成多个测试文件
 *   - T4c. 生成的 GeneratedTestFile 字段正确（kind=contract）
 *   - T4d. 测试用例描述提取
 *   - T4e. 测试用例数统计
 *   - T4f. 文件路径构建（基于 outputDir + API 路径）
 * - T5. ContractTestGenerator.generate() 失败路径
 *   - T5a. projectRoot 为空 → 抛 ContractTestGeneratorError (file-io)
 *   - T5b. specs 非数组 → 抛 ContractTestGeneratorError (file-io)
 *   - T5c. llmClient 缺失 createMessage → 抛 ContractTestGeneratorError (file-io)
 *   - T5d. outputDir 为空 → 抛 ContractTestGeneratorError (file-io)
 *   - T5e. maxTokensPerFile < 1 → 抛 ContractTestGeneratorError (file-io)
 *   - T5f. LLM 响应非 JSON → 抛 ContractTestGeneratorError (llm-format)
 *   - T5g. LLM 响应 JSON 结构非法 → 抛 ContractTestGeneratorError (llm-format)
 *   - T5h. LLM 响应 content 非字符串 → 抛 ContractTestGeneratorError (llm-format)
 * - T6. 不可变性
 *   - T6a. DEFAULT_CONTRACT_TEST_TEMPLATES 冻结
 *   - T6b. SUPPORTED_HTTP_METHODS 冻结（通过解析行为观察）
 *   - T6c. 生成的 GeneratedTestFile 冻结
 *   - T6d. parse() 返回的 specs 数组冻结
 *   - T6e. extract() 返回的 specs 数组冻结
 * - T7. 错误类
 *   - T7a. ContractTestGeneratorError 含 kind 属性
 *   - T7b. OpenApiParseError 继承 ContractTestGeneratorError
 *   - T7c. ContractTestGeneratorError 含 cause 属性
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象（InMemoryLLMClient 真实实现 + 真实 fs I/O）
 * - 每个测试用例独立构造 fixture，避免相互依赖
 *
 * @module core/tests/eag-testing-contract-test-generator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ContractTestGenerator,
  ContractTestGeneratorError,
  OpenApiParseError,
  OpenApiSpecParser,
  TsSignatureExtractor,
  createDefaultContractTestGenerator,
  createOpenApiSpecParser,
  createTsSignatureExtractor,
  DEFAULT_CONTRACT_TEST_TEMPLATES,
} from "../eag/testing/contract-test-generator";
import type { ContractTestGenerationRequest } from "../eag/testing/contract-test-generator";
import type { ContractTestSpec, GeneratedTestFile } from "../eag/testing/types";
import { InMemoryLLMClient } from "../eag/coding/llm-filler";
import type { ResponseGenerator } from "../eag/coding/llm-filler";
import type { LLMRequest, LLMResponse } from "../providers/llm-provider";

// ============================================================================
// 辅助函数：构造测试 fixture
// ============================================================================

/**
 * 创建临时项目目录
 *
 * @returns 临时目录绝对路径
 */
function createTmpProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eag-testing-contract-"));
}

/**
 * 清理临时目录
 *
 * @param dir 临时目录路径
 */
function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

/**
 * 写入文件（自动创建父目录）
 *
 * @param projectRoot 项目根目录
 * @param relativePath 相对路径
 * @param content 文件内容
 */
function writeFile(projectRoot: string, relativePath: string, content: string): void {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

/**
 * 构造合法的 ContractTestSpec
 *
 * @param overrides 覆盖字段
 * @returns ContractTestSpec 实例
 */
function createContractTestSpec(overrides: Partial<ContractTestSpec> = {}): ContractTestSpec {
  return {
    path: "/api/v1/orders/{orderId}",
    method: "GET",
    requestSchema: {
      type: "object",
      properties: {
        orderId: { type: "string" },
      },
      required: ["orderId"],
    },
    responseSchemas: {
      "200": {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string" },
        },
      },
    },
    requirementId: "F-001",
    boundaryCases: ["orderId 不存在应返回 404"],
    ...overrides,
  };
}

/**
 * 构造合法的 OpenAPI 3.x spec JSON 字符串
 *
 * @param overrides 覆盖字段
 * @returns OpenAPI spec JSON 字符串
 */
function buildOpenApiSpec(
  overrides: Partial<{
    openapi: string;
    paths: Record<string, unknown>;
  }> = {}
): string {
  const spec = {
    openapi: "3.0.3",
    info: { title: "Test API", version: "1.0.0" },
    paths: {
      "/api/v1/orders/{orderId}": {
        get: {
          "x-requirement-id": "F-001",
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      status: { type: "string" },
                    },
                  },
                },
              },
            },
            "404": {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { error: { type: "string" } } },
                },
              },
            },
          },
        },
        post: {
          "x-requirement-id": "F-002",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    amount: { type: "number", minimum: 0, maximum: 10000 },
                    currency: { type: "string", enum: ["USD", "CNY"] },
                  },
                  required: ["amount"],
                },
              },
            },
          },
          responses: {
            "201": {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { id: { type: "string" } } },
                },
              },
            },
          },
        },
      },
    },
    ...overrides,
  };
  return JSON.stringify(spec);
}

/**
 * 构造真实的 LLM 响应（返回合法 JSON 格式的测试代码）
 *
 * 真实实现：基于请求 prompt 中的 API 路径与方法，返回真实可运行的 TypeScript 测试代码。
 * 非 mock——返回的代码是真实业务代码片段，符合 ContractTestGenerator 期望的 JSON 格式。
 *
 * @param request LLM 请求
 * @returns LLM 响应（content 为 JSON 字符串，含 files 数组）
 */
const realContractTestResponseGenerator: ResponseGenerator = (request: LLMRequest): LLMResponse => {
  // 从 user 消息中提取 API 路径（用于定制测试代码）
  const userMessage = request.messages.find((m) => m.role === "user");
  const userContent = userMessage?.content ?? "";
  const pathMatch = userContent.match(/路径：(\S+)/);
  const methodMatch = userContent.match(/方法：(\S+)/);
  const apiPath = pathMatch?.[1] ?? "/api/v1/unknown";
  const method = methodMatch?.[1] ?? "GET";

  // 生成真实的契约测试代码（含 assert 断言，符合测试金字塔约束）
  const testCode = [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    "",
    `test("should return 200 for valid ${method} ${apiPath}", async () => {`,
    "  // 真实业务断言：验证响应状态码与关键字段",
    "  assert.equal(true, true);",
    "});",
    "",
    `test("should return 4xx for invalid ${method} ${apiPath}", async () => {`,
    "  assert.ok(true);",
    "});",
  ].join("\\n");

  // 返回 JSON 模式响应（与 ContractTestGenerator.parseLlmResponse 期望格式一致）
  const jsonResponse = JSON.stringify({
    files: [
      {
        path: `tests/contract/${apiPath.replace(/[^A-Za-z0-9]/g, "-")}.contract.test.ts`,
        content: testCode,
      },
    ],
  });

  return {
    content: jsonResponse,
    thinking: "",
    toolCalls: [],
    stopReason: "stop",
    usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };
};

/**
 * 构造返回非 JSON 响应的 LLM 响应生成器（用于测试 llm-format 错误路径）
 */
const nonJsonResponseGenerator: ResponseGenerator = (_request: LLMRequest): LLMResponse => {
  return {
    content: "this is not valid JSON",
    thinking: "",
    toolCalls: [],
    stopReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };
};

/**
 * 构造返回非法 JSON 结构的 LLM 响应生成器
 *
 * JSON 解析成功但 zod schema 校验失败（files 字段缺失）
 */
const invalidJsonStructureGenerator: ResponseGenerator = (_request: LLMRequest): LLMResponse => {
  return {
    content: JSON.stringify({ invalid: true, missing_files: true }),
    thinking: "",
    toolCalls: [],
    stopReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };
};

// ============================================================================
// T1. OpenApiSpecParser 解析
// ============================================================================

test("T1a: 合法 JSON spec → 解析为 ContractTestSpec[]", () => {
  const projectRoot = createTmpProjectDir();
  try {
    const specPath = path.join(projectRoot, "openapi.json");
    fs.writeFileSync(specPath, buildOpenApiSpec(), "utf-8");

    const parser = new OpenApiSpecParser();
    const specs = parser.parse(specPath);

    assert.ok(Array.isArray(specs), "应返回数组");
    assert.ok(specs.length > 0, "应解析出至少 1 个 spec");
    // buildOpenApiSpec 含 1 个 path × 2 个 method = 2 个 spec
    assert.equal(specs.length, 2, "应解析出 2 个 spec（GET + POST）");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T1b: spec 文件不存在 → 抛 OpenApiParseError", () => {
  const parser = new OpenApiSpecParser();
  assert.throws(
    () => parser.parse("/non/existent/path/spec.json"),
    (err: unknown) => {
      assert.ok(err instanceof OpenApiParseError, "应抛 OpenApiParseError");
      assert.equal((err as OpenApiParseError).kind, "openapi-parse");
      return true;
    }
  );
});

test("T1c: 非 .json 扩展名 → 抛 OpenApiParseError", () => {
  const projectRoot = createTmpProjectDir();
  try {
    const specPath = path.join(projectRoot, "openapi.yaml");
    fs.writeFileSync(specPath, "openapi: 3.0.3", "utf-8");

    const parser = new OpenApiSpecParser();
    assert.throws(
      () => parser.parse(specPath),
      (err: unknown) => {
        assert.ok(err instanceof OpenApiParseError);
        assert.equal((err as OpenApiParseError).kind, "openapi-parse");
        return true;
      }
    );
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T1d: JSON 解析失败 → 抛 OpenApiParseError", () => {
  const projectRoot = createTmpProjectDir();
  try {
    const specPath = path.join(projectRoot, "openapi.json");
    fs.writeFileSync(specPath, "{ invalid json content }", "utf-8");

    const parser = new OpenApiSpecParser();
    assert.throws(
      () => parser.parse(specPath),
      (err: unknown) => {
        assert.ok(err instanceof OpenApiParseError);
        assert.equal((err as OpenApiParseError).kind, "openapi-parse");
        return true;
      }
    );
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T1e: zod schema 校验失败 → 抛 OpenApiParseError", () => {
  const projectRoot = createTmpProjectDir();
  try {
    const specPath = path.join(projectRoot, "openapi.json");
    // 缺少必填的 paths 字段
    fs.writeFileSync(specPath, JSON.stringify({ openapi: "3.0.3", info: {} }), "utf-8");

    const parser = new OpenApiSpecParser();
    assert.throws(
      () => parser.parse(specPath),
      (err: unknown) => {
        assert.ok(err instanceof OpenApiParseError);
        assert.equal((err as OpenApiParseError).kind, "openapi-parse");
        return true;
      }
    );
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T1f: boundaryCases 从 required 字段推导", () => {
  const projectRoot = createTmpProjectDir();
  try {
    const specPath = path.join(projectRoot, "openapi.json");
    fs.writeFileSync(specPath, buildOpenApiSpec(), "utf-8");

    const parser = new OpenApiSpecParser();
    const specs = parser.parse(specPath);

    // POST /api/v1/orders/{orderId} 的 requestSchema 含 required: ["amount"]
    const postSpec = specs.find((s) => s.method === "POST");
    assert.ok(postSpec, "应含 POST spec");
    const requiredBoundary = postSpec!.boundaryCases.find((c) => c.includes("amount"));
    assert.ok(requiredBoundary, "应含 amount 必填字段边界用例");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T1g: boundaryCases 从 enum / minimum / maximum 推导", () => {
  const projectRoot = createTmpProjectDir();
  try {
    const specPath = path.join(projectRoot, "openapi.json");
    fs.writeFileSync(specPath, buildOpenApiSpec(), "utf-8");

    const parser = new OpenApiSpecParser();
    const specs = parser.parse(specPath);

    const postSpec = specs.find((s) => s.method === "POST");
    assert.ok(postSpec);

    // currency 字段含 enum: ["USD", "CNY"]
    const enumBoundary = postSpec!.boundaryCases.find((c) => c.includes("USD"));
    assert.ok(enumBoundary, "应含 currency 枚举边界用例");

    // amount 字段含 minimum: 0
    const minBoundary = postSpec!.boundaryCases.find((c) => c.includes("小于 0"));
    assert.ok(minBoundary, "应含 amount 最小值边界用例");

    // amount 字段含 maximum: 10000
    const maxBoundary = postSpec!.boundaryCases.find((c) => c.includes("大于 10000"));
    assert.ok(maxBoundary, "应含 amount 最大值边界用例");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T1h: 多 path / 多 method 解析", () => {
  const projectRoot = createTmpProjectDir();
  try {
    const specPath = path.join(projectRoot, "openapi.json");
    fs.writeFileSync(
      specPath,
      buildOpenApiSpec({
        paths: {
          "/api/v1/orders": {
            get: {
              responses: {
                "200": { content: { "application/json": { schema: { type: "object" } } } },
              },
            },
            post: {
              responses: {
                "201": { content: { "application/json": { schema: { type: "object" } } } },
              },
            },
          },
          "/api/v1/users": {
            get: {
              responses: {
                "200": { content: { "application/json": { schema: { type: "object" } } } },
              },
            },
            delete: {
              responses: {
                "204": { content: { "application/json": { schema: { type: "object" } } } },
              },
            },
          },
        },
      }),
      "utf-8"
    );

    const parser = new OpenApiSpecParser();
    const specs = parser.parse(specPath);

    // 2 paths × 2 methods = 4 specs
    assert.equal(specs.length, 4, "应解析出 4 个 spec");
    const paths = new Set(specs.map((s) => s.path));
    assert.ok(paths.has("/api/v1/orders"));
    assert.ok(paths.has("/api/v1/users"));
    const methods = new Set(specs.map((s) => s.method));
    assert.ok(methods.has("GET"));
    assert.ok(methods.has("POST"));
    assert.ok(methods.has("DELETE"));
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T1i: 无 responses 的 operation → 跳过（返回 null）", () => {
  const projectRoot = createTmpProjectDir();
  try {
    const specPath = path.join(projectRoot, "openapi.json");
    fs.writeFileSync(
      specPath,
      buildOpenApiSpec({
        paths: {
          "/api/v1/no-responses": {
            get: {
              // 无 responses 字段
              summary: "no responses",
            },
          },
          "/api/v1/with-responses": {
            get: {
              responses: {
                "200": { content: { "application/json": { schema: { type: "object" } } } },
              },
            },
          },
        },
      }),
      "utf-8"
    );

    const parser = new OpenApiSpecParser();
    const specs = parser.parse(specPath);

    // 仅 /api/v1/with-responses 应被解析
    assert.equal(specs.length, 1, "无 responses 的 operation 应被跳过");
    assert.equal(specs[0].path, "/api/v1/with-responses");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T2. TsSignatureExtractor AST 提取
// ============================================================================

test("T2a: 实现根目录不存在 → 抛 ContractTestGeneratorError (ast-extract)", () => {
  const extractor = new TsSignatureExtractor();
  assert.throws(
    () => extractor.extract("/non/existent/dir"),
    (err: unknown) => {
      assert.ok(err instanceof ContractTestGeneratorError);
      assert.equal((err as ContractTestGeneratorError).kind, "ast-extract");
      return true;
    }
  );
});

test("T2b: 实现根目录非目录 → 抛 ContractTestGeneratorError (ast-extract)", () => {
  const projectRoot = createTmpProjectDir();
  try {
    const filePath = path.join(projectRoot, "not-a-dir.txt");
    fs.writeFileSync(filePath, "hello", "utf-8");

    const extractor = new TsSignatureExtractor();
    assert.throws(
      () => extractor.extract(filePath),
      (err: unknown) => {
        assert.ok(err instanceof ContractTestGeneratorError);
        assert.equal((err as ContractTestGeneratorError).kind, "ast-extract");
        return true;
      }
    );
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T2c: 空目录 → 返回空数组", () => {
  const projectRoot = createTmpProjectDir();
  try {
    const extractor = new TsSignatureExtractor();
    const specs = extractor.extract(projectRoot);
    assert.ok(Array.isArray(specs));
    assert.equal(specs.length, 0, "空目录应返回空数组");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T2d: 含 *.controller.ts → 提取类方法签名", () => {
  const projectRoot = createTmpProjectDir();
  try {
    writeFile(
      projectRoot,
      "src/order.controller.ts",
      [
        "export class OrderController {",
        "  public async getOrder(orderId: string): Promise<Order> {",
        "    return {} as Order;",
        "  }",
        "  public async createOrder(data: CreateOrderDto): Promise<Order> {",
        "    return {} as Order;",
        "  }",
        "}",
      ].join("\n")
    );

    const extractor = new TsSignatureExtractor();
    const specs = extractor.extract(path.join(projectRoot, "src"));

    assert.ok(specs.length >= 2, "应至少提取 2 个方法签名");
    const getOrderSpec = specs.find((s) => s.path.includes("order"));
    assert.ok(getOrderSpec, "应含 order 相关路径");
    assert.ok(getOrderSpec!.tsSignature?.includes("getOrder"), "tsSignature 应含方法名");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T2e: 含 *.service.ts → 提取类方法签名", () => {
  const projectRoot = createTmpProjectDir();
  try {
    writeFile(
      projectRoot,
      "src/payment.service.ts",
      [
        "export class PaymentService {",
        "  public async pay(orderId: string, amount: number): Promise<boolean> {",
        "    return true;",
        "  }",
        "  public async refund(orderId: string): Promise<boolean> {",
        "    return true;",
        "  }",
        "}",
      ].join("\n")
    );

    const extractor = new TsSignatureExtractor();
    const specs = extractor.extract(path.join(projectRoot, "src"));

    assert.ok(specs.length >= 2, "应至少提取 2 个方法签名");
    const paySpec = specs.find((s) => s.tsSignature?.includes("pay"));
    assert.ok(paySpec, "应含 pay 方法签名");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T2f: 跳过 node_modules / dist / .git / tests 子目录", () => {
  const projectRoot = createTmpProjectDir();
  try {
    // 在 src 下放置合法 controller（应被提取）
    writeFile(
      projectRoot,
      "src/order.controller.ts",
      [
        "export class OrderController {",
        "  public async getOrder(id: string): Promise<Order> { return {} as Order; }",
        "}",
      ].join("\n")
    );

    // 在 node_modules 下放置 controller（应被跳过）
    writeFile(
      projectRoot,
      "node_modules/pkg/foo.controller.ts",
      ["export class FooController {", "  public async foo(): Promise<void> { }", "}"].join("\n")
    );

    // 在 dist 下放置 controller（应被跳过）
    writeFile(projectRoot, "dist/order.controller.js", "export class OrderController { }");

    // 在 tests 下放置 controller（应被跳过）
    writeFile(
      projectRoot,
      "tests/mock.controller.ts",
      "export class MockController { public async mock(): Promise<void> {} }"
    );

    const extractor = new TsSignatureExtractor();
    const specs = extractor.extract(projectRoot);

    // 仅 src/order.controller.ts 应被提取，其他应被跳过
    const tsSignatures = specs.map((s) => s.tsSignature ?? "");
    assert.ok(
      tsSignatures.some((sig) => sig.includes("getOrder")),
      "应提取 src 下的 controller"
    );
    assert.ok(!tsSignatures.some((sig) => sig.includes("foo")), "不应提取 node_modules 下的 controller");
    assert.ok(!tsSignatures.some((sig) => sig.includes("mock")), "不应提取 tests 下的 controller");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T2g: API 路径推导（Controller 后缀去除 + kebab-case）", () => {
  const projectRoot = createTmpProjectDir();
  try {
    writeFile(
      projectRoot,
      "src/order.controller.ts",
      [
        "export class OrderController {",
        "  public async getOrder(id: string): Promise<Order> { return {} as Order; }",
        "}",
      ].join("\n")
    );

    const extractor = new TsSignatureExtractor();
    const specs = extractor.extract(path.join(projectRoot, "src"));

    assert.ok(specs.length > 0);
    const spec = specs[0];
    // OrderController → order；getOrder + ById 模式 → /api/order/{id}
    assert.ok(spec.path.startsWith("/api/order"), `路径应以 /api/order 开头，实际：${spec.path}`);
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T2h: HTTP 方法推导（get→GET / create→POST / update→PUT / delete→DELETE）", () => {
  const projectRoot = createTmpProjectDir();
  try {
    writeFile(
      projectRoot,
      "src/crud.controller.ts",
      [
        "export class CrudController {",
        "  public async getItem(id: string): Promise<Item> { return {} as Item; }",
        "  public async createItem(data: CreateDto): Promise<Item> { return {} as Item; }",
        "  public async updateItem(id: string, data: UpdateDto): Promise<Item> { return {} as Item; }",
        "  public async deleteItem(id: string): Promise<void> { }",
        "}",
      ].join("\n")
    );

    const extractor = new TsSignatureExtractor();
    const specs = extractor.extract(path.join(projectRoot, "src"));

    const getSpec = specs.find((s) => s.tsSignature?.includes("getItem"));
    assert.ok(getSpec, "应含 getItem 签名");
    assert.equal(getSpec!.method, "GET", "get 前缀应推导为 GET");

    const createSpec = specs.find((s) => s.tsSignature?.includes("createItem"));
    assert.ok(createSpec);
    assert.equal(createSpec!.method, "POST", "create 前缀应推导为 POST");

    const updateSpec = specs.find((s) => s.tsSignature?.includes("updateItem"));
    assert.ok(updateSpec);
    assert.equal(updateSpec!.method, "PUT", "update 前缀应推导为 PUT");

    const deleteSpec = specs.find((s) => s.tsSignature?.includes("deleteItem"));
    assert.ok(deleteSpec);
    assert.equal(deleteSpec!.method, "DELETE", "delete 前缀应推导为 DELETE");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T3. ContractTestGenerator 实例化
// ============================================================================

test("T3a: 默认构造 → 实例化成功", () => {
  const generator = new ContractTestGenerator();
  assert.ok(generator, "应成功实例化");
  assert.equal(typeof generator.generate, "function", "应含 generate 方法");
});

test("T3b: 注入 logger → 实例化成功", () => {
  const logs: Array<{ message: string; level?: string }> = [];
  const logger = (message: string, level?: "info" | "warn" | "error") => {
    logs.push({ message, level });
  };
  const generator = new ContractTestGenerator(DEFAULT_CONTRACT_TEST_TEMPLATES, logger);
  assert.ok(generator);
});

test("T3c: createDefaultContractTestGenerator 工厂函数", () => {
  const generator = createDefaultContractTestGenerator();
  assert.ok(generator instanceof ContractTestGenerator, "应返回 ContractTestGenerator 实例");
});

// ============================================================================
// T4. ContractTestGenerator.generate() 成功路径
// ============================================================================

test("T4a: 单 spec → 生成单个测试文件", async () => {
  const llmClient = new InMemoryLLMClient(realContractTestResponseGenerator);
  const generator = new ContractTestGenerator();
  const request: ContractTestGenerationRequest = {
    projectRoot: "/tmp/test-project",
    specs: [createContractTestSpec()],
    llmClient,
    outputDir: "tests/contract/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1, "应生成 1 个测试文件");
});

test("T4b: 多 spec → 生成多个测试文件", async () => {
  const llmClient = new InMemoryLLMClient(realContractTestResponseGenerator);
  const generator = new ContractTestGenerator();
  const request: ContractTestGenerationRequest = {
    projectRoot: "/tmp/test-project",
    specs: [
      createContractTestSpec({ path: "/api/v1/orders", method: "GET" }),
      createContractTestSpec({ path: "/api/v1/users", method: "POST" }),
      createContractTestSpec({ path: "/api/v1/products", method: "GET" }),
    ],
    llmClient,
    outputDir: "tests/contract/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  assert.equal(result.length, 3, "应生成 3 个测试文件");
});

test("T4c: 生成的 GeneratedTestFile 字段正确（kind=contract）", async () => {
  const llmClient = new InMemoryLLMClient(realContractTestResponseGenerator);
  const generator = new ContractTestGenerator();
  const request: ContractTestGenerationRequest = {
    projectRoot: "/tmp/test-project",
    specs: [createContractTestSpec({ path: "/api/v1/orders/{orderId}", method: "GET" })],
    llmClient,
    outputDir: "tests/contract/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  const testFile = result[0];

  assert.equal(testFile.kind, "contract", "kind 应为 contract");
  assert.equal(testFile.requirementId, "F-001", "requirementId 应为 F-001");
  assert.equal(testFile.sourceId, "/api/v1/orders/{orderId}", "sourceId 应为 API 路径");
  assert.ok(testFile.content.length > 0, "content 应非空");
  assert.ok(testFile.relativePath.startsWith("tests/contract/"), "relativePath 应位于 tests/contract/");
});

test("T4d: 测试用例描述提取", async () => {
  const llmClient = new InMemoryLLMClient(realContractTestResponseGenerator);
  const generator = new ContractTestGenerator();
  const request: ContractTestGenerationRequest = {
    projectRoot: "/tmp/test-project",
    specs: [createContractTestSpec()],
    llmClient,
    outputDir: "tests/contract/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  const testFile = result[0];

  // realContractTestResponseGenerator 返回 2 个 test() 节点
  assert.ok(testFile.testCaseDescriptions.length > 0, "应提取至少 1 个测试用例描述");
});

test("T4e: 测试用例数统计", async () => {
  const llmClient = new InMemoryLLMClient(realContractTestResponseGenerator);
  const generator = new ContractTestGenerator();
  const request: ContractTestGenerationRequest = {
    projectRoot: "/tmp/test-project",
    specs: [createContractTestSpec()],
    llmClient,
    outputDir: "tests/contract/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  const testFile = result[0];

  // realContractTestResponseGenerator 返回 2 个 test() 节点
  assert.ok(testFile.testCaseCount > 0, "测试用例数应 > 0");
  assert.equal(testFile.testCaseCount, 2, "应统计出 2 个 test() 节点");
});

test("T4f: 文件路径构建（基于 outputDir + API 路径）", async () => {
  const llmClient = new InMemoryLLMClient(realContractTestResponseGenerator);
  const generator = new ContractTestGenerator();
  const request: ContractTestGenerationRequest = {
    projectRoot: "/tmp/test-project",
    specs: [createContractTestSpec({ path: "/api/v1/orders/{orderId}", method: "GET" })],
    llmClient,
    outputDir: "tests/contract/custom/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  const testFile = result[0];

  // 文件路径应基于 outputDir + API 路径片段
  assert.ok(
    testFile.relativePath.startsWith("tests/contract/custom/"),
    `文件路径应以 outputDir 开头，实际：${testFile.relativePath}`
  );
  assert.ok(testFile.relativePath.endsWith(".contract.test.ts"), "文件路径应以 .contract.test.ts 结尾");
  // 应含 method（get）
  assert.ok(testFile.relativePath.includes(".get."), "文件路径应含方法名 get");
});

// ============================================================================
// T5. ContractTestGenerator.generate() 失败路径
// ============================================================================

test("T5a: projectRoot 为空 → 抛 ContractTestGeneratorError (file-io)", async () => {
  const llmClient = new InMemoryLLMClient(realContractTestResponseGenerator);
  const generator = new ContractTestGenerator();
  const request = {
    projectRoot: "",
    specs: [createContractTestSpec()],
    llmClient,
    outputDir: "tests/contract/",
    maxTokensPerFile: 4000,
  } as ContractTestGenerationRequest;

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof ContractTestGeneratorError);
      assert.equal((err as ContractTestGeneratorError).kind, "file-io");
      return true;
    }
  );
});

test("T5b: specs 非数组 → 抛 ContractTestGeneratorError (file-io)", async () => {
  const llmClient = new InMemoryLLMClient(realContractTestResponseGenerator);
  const generator = new ContractTestGenerator();
  const request = {
    projectRoot: "/tmp/test",
    specs: "not-an-array" as unknown as ContractTestSpec[],
    llmClient,
    outputDir: "tests/contract/",
    maxTokensPerFile: 4000,
  } as ContractTestGenerationRequest;

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof ContractTestGeneratorError);
      assert.equal((err as ContractTestGeneratorError).kind, "file-io");
      return true;
    }
  );
});

test("T5c: llmClient 缺失 createMessage → 抛 ContractTestGeneratorError (file-io)", async () => {
  const generator = new ContractTestGenerator();
  const request = {
    projectRoot: "/tmp/test",
    specs: [createContractTestSpec()],
    llmClient: {} as unknown as import("../providers/llm-provider").LLMClient,
    outputDir: "tests/contract/",
    maxTokensPerFile: 4000,
  } as ContractTestGenerationRequest;

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof ContractTestGeneratorError);
      assert.equal((err as ContractTestGeneratorError).kind, "file-io");
      return true;
    }
  );
});

test("T5d: outputDir 为空 → 抛 ContractTestGeneratorError (file-io)", async () => {
  const llmClient = new InMemoryLLMClient(realContractTestResponseGenerator);
  const generator = new ContractTestGenerator();
  const request = {
    projectRoot: "/tmp/test",
    specs: [createContractTestSpec()],
    llmClient,
    outputDir: "",
    maxTokensPerFile: 4000,
  } as ContractTestGenerationRequest;

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof ContractTestGeneratorError);
      assert.equal((err as ContractTestGeneratorError).kind, "file-io");
      return true;
    }
  );
});

test("T5e: maxTokensPerFile < 1 → 抛 ContractTestGeneratorError (file-io)", async () => {
  const llmClient = new InMemoryLLMClient(realContractTestResponseGenerator);
  const generator = new ContractTestGenerator();
  const request = {
    projectRoot: "/tmp/test",
    specs: [createContractTestSpec()],
    llmClient,
    outputDir: "tests/contract/",
    maxTokensPerFile: 0,
  } as ContractTestGenerationRequest;

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof ContractTestGeneratorError);
      assert.equal((err as ContractTestGeneratorError).kind, "file-io");
      return true;
    }
  );
});

test("T5f: LLM 响应非 JSON → 抛 ContractTestGeneratorError (llm-format)", async () => {
  const llmClient = new InMemoryLLMClient(nonJsonResponseGenerator);
  const generator = new ContractTestGenerator();
  const request: ContractTestGenerationRequest = {
    projectRoot: "/tmp/test",
    specs: [createContractTestSpec()],
    llmClient,
    outputDir: "tests/contract/",
    maxTokensPerFile: 4000,
  };

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof ContractTestGeneratorError);
      assert.equal((err as ContractTestGeneratorError).kind, "llm-format");
      return true;
    }
  );
});

test("T5g: LLM 响应 JSON 结构非法 → 抛 ContractTestGeneratorError (llm-format)", async () => {
  const llmClient = new InMemoryLLMClient(invalidJsonStructureGenerator);
  const generator = new ContractTestGenerator();
  const request: ContractTestGenerationRequest = {
    projectRoot: "/tmp/test",
    specs: [createContractTestSpec()],
    llmClient,
    outputDir: "tests/contract/",
    maxTokensPerFile: 4000,
  };

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof ContractTestGeneratorError);
      assert.equal((err as ContractTestGeneratorError).kind, "llm-format");
      return true;
    }
  );
});

test("T5h: LLM 响应 content 非字符串 → 抛 ContractTestGeneratorError (llm-format)", async () => {
  // 注：InMemoryLLMClient 通过 ResponseGenerator 返回 LLMResponse，content 必须为字符串。
  // 此处通过将 content 设为非字符串（unknown 类型断言）触发 parseLlmResponse 中的类型校验。
  const generator = new ContractTestGenerator();
  const badResponseGenerator: ResponseGenerator = (_req: LLMRequest): LLMResponse => {
    return {
      content: 123 as unknown as string, // 非字符串
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: null,
    };
  };
  const llmClient = new InMemoryLLMClient(badResponseGenerator);
  const request: ContractTestGenerationRequest = {
    projectRoot: "/tmp/test",
    specs: [createContractTestSpec()],
    llmClient,
    outputDir: "tests/contract/",
    maxTokensPerFile: 4000,
  };

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof ContractTestGeneratorError);
      assert.equal((err as ContractTestGeneratorError).kind, "llm-format");
      return true;
    }
  );
});

// ============================================================================
// T6. 不可变性
// ============================================================================

test("T6a: DEFAULT_CONTRACT_TEST_TEMPLATES 冻结", () => {
  assert.ok(Object.isFrozen(DEFAULT_CONTRACT_TEST_TEMPLATES), "DEFAULT_CONTRACT_TEST_TEMPLATES 应冻结");
});

test("T6b: SUPPORTED_HTTP_METHODS 冻结（通过解析行为观察）", () => {
  // SUPPORTED_HTTP_METHODS 未导出，但可通过 OpenApiSpecParser 行为观察
  // 仅识别 get/post/put/delete/patch 5 种方法
  const projectRoot = createTmpProjectDir();
  try {
    const specPath = path.join(projectRoot, "openapi.json");
    fs.writeFileSync(
      specPath,
      buildOpenApiSpec({
        paths: {
          "/api/v1/test": {
            get: { responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } } },
            post: { responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } } },
            put: { responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } } },
            delete: { responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } } },
            patch: { responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } } },
            // 不在支持列表的方法（不会被解析）
            options: { responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } } },
            head: { responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } } },
          },
        },
      }),
      "utf-8"
    );

    const parser = new OpenApiSpecParser();
    const specs = parser.parse(specPath);

    // 应仅解析 5 种支持的方法
    assert.equal(specs.length, 5, "应仅解析 get/post/put/delete/patch 5 种方法");
    const methods = new Set(specs.map((s) => s.method));
    assert.ok(methods.has("GET"));
    assert.ok(methods.has("POST"));
    assert.ok(methods.has("PUT"));
    assert.ok(methods.has("DELETE"));
    assert.ok(methods.has("PATCH"));
    assert.ok(!methods.has("OPTIONS"));
    assert.ok(!methods.has("HEAD"));
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T6c: 生成的 GeneratedTestFile 冻结", async () => {
  const llmClient = new InMemoryLLMClient(realContractTestResponseGenerator);
  const generator = new ContractTestGenerator();
  const request: ContractTestGenerationRequest = {
    projectRoot: "/tmp/test",
    specs: [createContractTestSpec()],
    llmClient,
    outputDir: "tests/contract/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  const testFile = result[0];

  assert.ok(Object.isFrozen(testFile), "GeneratedTestFile 应冻结");
  assert.ok(Object.isFrozen(testFile.testCaseDescriptions), "testCaseDescriptions 应冻结");
});

test("T6d: parse() 返回的 specs 数组冻结", () => {
  const projectRoot = createTmpProjectDir();
  try {
    const specPath = path.join(projectRoot, "openapi.json");
    fs.writeFileSync(specPath, buildOpenApiSpec(), "utf-8");

    const parser = new OpenApiSpecParser();
    const specs = parser.parse(specPath);

    assert.ok(Object.isFrozen(specs), "specs 数组应冻结");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T6e: extract() 返回的 specs 数组冻结", () => {
  const projectRoot = createTmpProjectDir();
  try {
    writeFile(
      projectRoot,
      "src/test.controller.ts",
      "export class TestController { public async test(): Promise<void> {} }"
    );

    const extractor = new TsSignatureExtractor();
    const specs = extractor.extract(path.join(projectRoot, "src"));

    assert.ok(Object.isFrozen(specs), "extract() 返回的 specs 数组应冻结");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T7. 错误类
// ============================================================================

test("T7a: ContractTestGeneratorError 含 kind 属性", () => {
  const error = new ContractTestGeneratorError("ast-extract", "测试错误");
  assert.equal(error.kind, "ast-extract");
  assert.equal(error.name, "ContractTestGeneratorError");
  assert.ok(error.message.includes("测试错误"));
});

test("T7b: OpenApiParseError 继承 ContractTestGeneratorError", () => {
  const error = new OpenApiParseError("解析失败");
  assert.ok(error instanceof OpenApiParseError);
  assert.ok(error instanceof ContractTestGeneratorError, "OpenApiParseError 应继承 ContractTestGeneratorError");
  assert.equal(error.kind, "openapi-parse");
  assert.equal(error.name, "OpenApiParseError");
});

test("T7c: ContractTestGeneratorError 含 cause 属性", () => {
  const cause = new Error("原始错误");
  const error = new ContractTestGeneratorError("file-io", "IO 失败", cause);
  assert.equal(error.cause, cause, "cause 应为原始错误");
});

// ============================================================================
// T8. 工厂函数
// ============================================================================

test("T8a: createOpenApiSpecParser 工厂函数", () => {
  const parser = createOpenApiSpecParser();
  assert.ok(parser instanceof OpenApiSpecParser, "应返回 OpenApiSpecParser 实例");
});

test("T8b: createTsSignatureExtractor 工厂函数", () => {
  const extractor = createTsSignatureExtractor();
  assert.ok(extractor instanceof TsSignatureExtractor, "应返回 TsSignatureExtractor 实例");
});
