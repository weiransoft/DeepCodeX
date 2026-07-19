/**
 * EAG-P3 批次 10 单元测试：既有契约保护判定器（BrownfieldContractGuard）
 *
 * 测试范围：
 * - T1. 实例化与构造
 *   - T1a. 默认构造 → 实例化成功
 *   - T1b. 注入 logger → 实例化成功
 *   - T1c. createDefaultBrownfieldContractGuard 工厂函数
 * - T2. check() 文件加载失败处理
 *   - T2a. 既有契约文件不存在 → 抛 BrownfieldContractGuardError (file-not-found)
 *   - T2b. JSON 解析失败 → 抛 BrownfieldContractGuardError (file-parse)
 *   - T2c. schema 校验失败 → 抛 BrownfieldContractGuardError (schema-invalid)
 * - T3. check() 兼容变更检测
 *   - T3a. 新增 API → compatible=true，记录 api-added
 *   - T3b. 可选字段新增 → 记录 optional-field-added
 *   - T3c. 响应字段新增 → 记录 response-field-added
 * - T4. check() breaking change 检测
 *   - T4a. 既有 API 被删除 → compatible=false，记录 api-removed
 *   - T4b. 必填字段新增 → compatible=false，记录 required-field-added
 *   - T4c. 字段类型变更 → compatible=false，记录 field-type-changed
 *   - T4d. 响应字段删除 → compatible=false，记录 response-field-removed
 * - T5. 报告不可变性
 *   - T5a. breakingChanges 数组冻结
 *   - T5b. compatibleChanges 数组冻结
 *   - T5c. 整体 report 冻结
 * - T6. BrownfieldContractGuardError 错误类
 *   - T6a. 含 kind / filePath 属性
 *   - T6b. 默认 message 根据 kind 生成
 *   - T6c. 自定义 message 覆盖默认
 * - T7. 默认路径推导
 *   - T7a. 未提供 existingContractsPath → 使用默认 .eag/existing-contracts.json
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象 + 真实文件 I/O（mkdtempSync 临时目录）
 *
 * @module core/tests/eag-testing-brownfield-contract-guard
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  BrownfieldContractGuard,
  BrownfieldContractGuardError,
  createDefaultBrownfieldContractGuard,
  DEFAULT_EXISTING_CONTRACTS_RELATIVE_PATH,
} from "../eag/testing/brownfield-contract-guard";
import type { BrownfieldContractGuardErrorKind } from "../eag/testing/brownfield-contract-guard";
import type { ContractTestSpec } from "../eag/testing/types";

// ============================================================================
// 辅助函数：构造测试 fixture
// ============================================================================

/**
 * 创建临时项目目录
 *
 * @returns 临时目录绝对路径
 */
function createTmpProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eag-testing-brownfield-"));
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
    path: "/api/v1/orders",
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
    boundaryCases: [],
    ...overrides,
  };
}

/**
 * 构造既有 API 契约清单文件内容
 *
 * @param apis API 列表
 * @returns JSON 字符串
 */
function buildExistingContractsFile(
  apis: ReadonlyArray<{
    readonly path: string;
    readonly method: string;
    readonly requestSchema?: Record<string, unknown>;
    readonly responseSchemas: Record<string, Record<string, unknown>>;
  }>
): string {
  return JSON.stringify({ apis });
}

// ============================================================================
// T1. 实例化与构造
// ============================================================================

test("T1a: BrownfieldContractGuard 默认构造 → 实例化成功", () => {
  const guard = new BrownfieldContractGuard();
  assert.ok(guard, "应成功实例化");
  assert.equal(typeof guard.check, "function", "应含 check 方法");
});

test("T1b: BrownfieldContractGuard 注入 logger → 实例化成功", () => {
  const logs: Array<{ message: string; level?: string }> = [];
  const logger = (message: string, level?: "info" | "warn" | "error") => {
    logs.push({ message, level });
  };
  const guard = new BrownfieldContractGuard(undefined, logger);
  assert.ok(guard, "应成功实例化");
  // logger 注入但不立即调用，需在 check() 中触发
});

test("T1c: createDefaultBrownfieldContractGuard 工厂函数", () => {
  const guard = createDefaultBrownfieldContractGuard();
  assert.ok(guard instanceof BrownfieldContractGuard, "应返回 BrownfieldContractGuard 实例");
});

// ============================================================================
// T2. check() 文件加载失败处理
// ============================================================================

test("T2a: 既有契约文件不存在 → 抛 BrownfieldContractGuardError (file-not-found)", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    const guard = new BrownfieldContractGuard();
    await assert.rejects(
      () =>
        guard.check({
          projectRoot,
          newContractSpecs: [createContractTestSpec()],
          existingContractsPath: path.join(projectRoot, "non-existent.json"),
        }),
      (err: unknown) => {
        assert.ok(err instanceof BrownfieldContractGuardError, "应抛 BrownfieldContractGuardError");
        assert.equal((err as BrownfieldContractGuardError).kind, "file-not-found", "kind 应为 file-not-found");
        return true;
      }
    );
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T2b: JSON 解析失败 → 抛 BrownfieldContractGuardError (file-parse)", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    const filePath = path.join(projectRoot, "contracts.json");
    fs.writeFileSync(filePath, "{ invalid json }", "utf-8");

    const guard = new BrownfieldContractGuard();
    await assert.rejects(
      () =>
        guard.check({
          projectRoot,
          newContractSpecs: [createContractTestSpec()],
          existingContractsPath: filePath,
        }),
      (err: unknown) => {
        assert.ok(err instanceof BrownfieldContractGuardError);
        assert.equal((err as BrownfieldContractGuardError).kind, "file-parse", "kind 应为 file-parse");
        return true;
      }
    );
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T2c: schema 校验失败 → 抛 BrownfieldContractGuardError (schema-invalid)", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    const filePath = path.join(projectRoot, "contracts.json");
    // 缺少 apis 字段
    fs.writeFileSync(filePath, JSON.stringify({ invalid: true }), "utf-8");

    const guard = new BrownfieldContractGuard();
    await assert.rejects(
      () =>
        guard.check({
          projectRoot,
          newContractSpecs: [createContractTestSpec()],
          existingContractsPath: filePath,
        }),
      (err: unknown) => {
        assert.ok(err instanceof BrownfieldContractGuardError);
        assert.equal((err as BrownfieldContractGuardError).kind, "schema-invalid");
        return true;
      }
    );
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T3. check() 兼容变更检测
// ============================================================================

test("T3a: 新增 API → compatible=true，记录 api-added", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    // 既有契约：空列表（无任何 API）
    writeFile(projectRoot, "contracts.json", buildExistingContractsFile([]));

    const guard = new BrownfieldContractGuard();
    const report = await guard.check({
      projectRoot,
      newContractSpecs: [createContractTestSpec()],
      existingContractsPath: path.join(projectRoot, "contracts.json"),
    });

    assert.equal(report.compatible, true, "新增 API 应兼容");
    assert.equal(report.breakingChanges.length, 0, "无 breaking change");
    const apiAdded = report.compatibleChanges.find((c) => c.kind === "api-added");
    assert.ok(apiAdded, "应记录 api-added 兼容变更");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T3b: 可选字段新增 → 记录 optional-field-added", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    // 既有契约：包含一个 API，requestSchema 不含 note 字段
    writeFile(
      projectRoot,
      "contracts.json",
      buildExistingContractsFile([
        {
          path: "/api/v1/orders",
          method: "GET",
          requestSchema: {
            type: "object",
            properties: { orderId: { type: "string" } },
            required: ["orderId"],
          },
          responseSchemas: {
            "200": {
              type: "object",
              properties: { id: { type: "string" } },
            },
          },
        },
      ])
    );

    // 新契约：新增可选字段 note（不在 required 中）
    const newSpec = createContractTestSpec({
      requestSchema: {
        type: "object",
        properties: {
          orderId: { type: "string" },
          note: { type: "string" }, // 新增可选字段
        },
        required: ["orderId"], // note 不在 required 中
      },
    });

    const guard = new BrownfieldContractGuard();
    const report = await guard.check({
      projectRoot,
      newContractSpecs: [newSpec],
      existingContractsPath: path.join(projectRoot, "contracts.json"),
    });

    assert.equal(report.compatible, true, "新增可选字段应兼容");
    const optionalAdded = report.compatibleChanges.find((c) => c.kind === "optional-field-added");
    assert.ok(optionalAdded, "应记录 optional-field-added");
    assert.equal(optionalAdded!.field, "note", "field 应为 note");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T3c: 响应字段新增 → 记录 response-field-added", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    writeFile(
      projectRoot,
      "contracts.json",
      buildExistingContractsFile([
        {
          path: "/api/v1/orders",
          method: "GET",
          responseSchemas: {
            "200": {
              type: "object",
              properties: { id: { type: "string" } },
            },
          },
        },
      ])
    );

    // 新契约：响应新增 message 字段
    const newSpec = createContractTestSpec({
      requestSchema: undefined,
      responseSchemas: {
        "200": {
          type: "object",
          properties: {
            id: { type: "string" },
            message: { type: "string" }, // 新增字段
          },
        },
      },
    });

    const guard = new BrownfieldContractGuard();
    const report = await guard.check({
      projectRoot,
      newContractSpecs: [newSpec],
      existingContractsPath: path.join(projectRoot, "contracts.json"),
    });

    assert.equal(report.compatible, true, "新增响应字段应兼容");
    const responseAdded = report.compatibleChanges.find((c) => c.kind === "response-field-added");
    assert.ok(responseAdded, "应记录 response-field-added");
    assert.equal(responseAdded!.field, "message", "field 应为 message");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T4. check() breaking change 检测
// ============================================================================

test("T4a: 既有 API 被删除 → compatible=false，记录 api-removed", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    // 既有契约包含一个 API
    writeFile(
      projectRoot,
      "contracts.json",
      buildExistingContractsFile([
        {
          path: "/api/v1/orders",
          method: "GET",
          responseSchemas: {
            "200": { type: "object", properties: { id: { type: "string" } } },
          },
        },
      ])
    );

    // 新契约为空（既有 API 全部被删除）
    const guard = new BrownfieldContractGuard();
    const report = await guard.check({
      projectRoot,
      newContractSpecs: [],
      existingContractsPath: path.join(projectRoot, "contracts.json"),
    });

    assert.equal(report.compatible, false, "既有 API 被删除应不兼容");
    const apiRemoved = report.breakingChanges.find((c) => c.kind === "api-removed");
    assert.ok(apiRemoved, "应记录 api-removed");
    assert.ok(apiRemoved!.apiPath.includes("GET /api/v1/orders"), "apiPath 应正确");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T4b: 必填字段新增 → compatible=false，记录 required-field-added", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    writeFile(
      projectRoot,
      "contracts.json",
      buildExistingContractsFile([
        {
          path: "/api/v1/orders",
          method: "GET",
          requestSchema: {
            type: "object",
            properties: { orderId: { type: "string" } },
            required: ["orderId"],
          },
          responseSchemas: {
            "200": { type: "object", properties: { id: { type: "string" } } },
          },
        },
      ])
    );

    // 新契约：新增必填字段 reason
    const newSpec = createContractTestSpec({
      requestSchema: {
        type: "object",
        properties: {
          orderId: { type: "string" },
          reason: { type: "string" }, // 新增必填字段
        },
        required: ["orderId", "reason"], // reason 是新增必填
      },
    });

    const guard = new BrownfieldContractGuard();
    const report = await guard.check({
      projectRoot,
      newContractSpecs: [newSpec],
      existingContractsPath: path.join(projectRoot, "contracts.json"),
    });

    assert.equal(report.compatible, false, "新增必填字段应不兼容");
    const requiredAdded = report.breakingChanges.find((c) => c.kind === "required-field-added");
    assert.ok(requiredAdded, "应记录 required-field-added");
    assert.equal(requiredAdded!.field, "reason", "field 应为 reason");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T4c: 字段类型变更 → compatible=false，记录 field-type-changed", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    writeFile(
      projectRoot,
      "contracts.json",
      buildExistingContractsFile([
        {
          path: "/api/v1/orders",
          method: "GET",
          requestSchema: {
            type: "object",
            properties: { orderId: { type: "string" } },
            required: ["orderId"],
          },
          responseSchemas: {
            "200": { type: "object", properties: { id: { type: "string" } } },
          },
        },
      ])
    );

    // 新契约：orderId 类型从 string 改为 number
    const newSpec = createContractTestSpec({
      requestSchema: {
        type: "object",
        properties: {
          orderId: { type: "number" }, // 类型变更
        },
        required: ["orderId"],
      },
    });

    const guard = new BrownfieldContractGuard();
    const report = await guard.check({
      projectRoot,
      newContractSpecs: [newSpec],
      existingContractsPath: path.join(projectRoot, "contracts.json"),
    });

    assert.equal(report.compatible, false, "字段类型变更应不兼容");
    const typeChanged = report.breakingChanges.find((c) => c.kind === "field-type-changed");
    assert.ok(typeChanged, "应记录 field-type-changed");
    assert.equal(typeChanged!.field, "orderId", "field 应为 orderId");
    assert.equal(typeChanged!.oldValue, "string", "oldValue 应为 string");
    assert.equal(typeChanged!.newValue, "number", "newValue 应为 number");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T4d: 响应字段删除 → compatible=false，记录 response-field-removed", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    writeFile(
      projectRoot,
      "contracts.json",
      buildExistingContractsFile([
        {
          path: "/api/v1/orders",
          method: "GET",
          responseSchemas: {
            "200": {
              type: "object",
              properties: {
                id: { type: "string" },
                status: { type: "string" },
              },
            },
          },
        },
      ])
    );

    // 新契约：响应删除 status 字段
    const newSpec = createContractTestSpec({
      requestSchema: undefined,
      responseSchemas: {
        "200": {
          type: "object",
          properties: {
            id: { type: "string" },
            // status 字段被删除
          },
        },
      },
    });

    const guard = new BrownfieldContractGuard();
    const report = await guard.check({
      projectRoot,
      newContractSpecs: [newSpec],
      existingContractsPath: path.join(projectRoot, "contracts.json"),
    });

    assert.equal(report.compatible, false, "响应字段删除应不兼容");
    const fieldRemoved = report.breakingChanges.find((c) => c.kind === "response-field-removed");
    assert.ok(fieldRemoved, "应记录 response-field-removed");
    assert.equal(fieldRemoved!.field, "status", "field 应为 status");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T5. 报告不可变性
// ============================================================================

test("T5a: breakingChanges 数组冻结", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    writeFile(
      projectRoot,
      "contracts.json",
      buildExistingContractsFile([
        {
          path: "/api/v1/orders",
          method: "GET",
          responseSchemas: { "200": { type: "object", properties: { id: { type: "string" } } } },
        },
      ])
    );

    const guard = new BrownfieldContractGuard();
    const report = await guard.check({
      projectRoot,
      newContractSpecs: [], // 全部删除
      existingContractsPath: path.join(projectRoot, "contracts.json"),
    });

    assert.ok(Object.isFrozen(report.breakingChanges), "breakingChanges 应被冻结");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T5b: compatibleChanges 数组冻结", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    writeFile(projectRoot, "contracts.json", buildExistingContractsFile([]));

    const guard = new BrownfieldContractGuard();
    const report = await guard.check({
      projectRoot,
      newContractSpecs: [createContractTestSpec()],
      existingContractsPath: path.join(projectRoot, "contracts.json"),
    });

    assert.ok(Object.isFrozen(report.compatibleChanges), "compatibleChanges 应被冻结");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T5c: 整体 report 冻结", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    writeFile(projectRoot, "contracts.json", buildExistingContractsFile([]));

    const guard = new BrownfieldContractGuard();
    const report = await guard.check({
      projectRoot,
      newContractSpecs: [createContractTestSpec()],
      existingContractsPath: path.join(projectRoot, "contracts.json"),
    });

    assert.ok(Object.isFrozen(report), "report 应被冻结");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T6. BrownfieldContractGuardError 错误类
// ============================================================================

test("T6a: BrownfieldContractGuardError 含 kind / filePath 属性", () => {
  const err = new BrownfieldContractGuardError("file-not-found", "/path/to/file.json");
  assert.equal(err.kind, "file-not-found", "kind 应正确设置");
  assert.equal(err.filePath, "/path/to/file.json", "filePath 应正确设置");
  assert.equal(err.name, "BrownfieldContractGuardError", "name 应正确设置");
});

test("T6b: BrownfieldContractGuardError 默认 message 根据 kind 生成", () => {
  const cases: Array<{ kind: BrownfieldContractGuardErrorKind; expected: string }> = [
    { kind: "file-not-found", expected: "既有契约文件不存在" },
    { kind: "file-parse", expected: "既有契约文件 JSON 解析失败" },
    { kind: "schema-invalid", expected: "既有契约文件结构不合法" },
    { kind: "io-error", expected: "既有契约文件读取 I/O 错误" },
  ];

  for (const { kind, expected } of cases) {
    const err = new BrownfieldContractGuardError(kind, "/test/path.json");
    assert.ok(err.message.includes(expected), `kind="${kind}" 的默认 message 应含 "${expected}"，实际：${err.message}`);
  }
});

test("T6c: BrownfieldContractGuardError 自定义 message 覆盖默认", () => {
  const err = new BrownfieldContractGuardError("file-not-found", "/test/path.json", undefined, "自定义错误消息");
  assert.equal(err.message, "自定义错误消息", "自定义 message 应覆盖默认");
});

// ============================================================================
// T7. 默认路径推导
// ============================================================================

test("T7a: 未提供 existingContractsPath → 使用默认 .eag/existing-contracts.json", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    // 在默认路径下创建既有契约文件
    writeFile(projectRoot, DEFAULT_EXISTING_CONTRACTS_RELATIVE_PATH, buildExistingContractsFile([]));

    const guard = new BrownfieldContractGuard();
    // 不传 existingContractsPath，应使用默认路径
    const report = await guard.check({
      projectRoot,
      newContractSpecs: [createContractTestSpec()],
    });

    assert.equal(report.compatible, true, "默认路径加载应成功");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});
