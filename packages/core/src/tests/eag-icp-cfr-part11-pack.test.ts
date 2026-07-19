/**
 * EAG-P3 批次 11 单元测试：CFR Part 11 合规规则集（packs/cfr-part11-pack.ts）
 *
 * 测试范围：
 * - T1. CFR_PART_11_PACK 合规包结构
 *   - T1a. packId / packName / version 字段
 *   - T1b. rules 数组含 5 条规则（CFR-01 ~ CFR-05）
 *   - T1c. 全部规则 regulatoryReference 引用真实法规条款
 *   - T1d. CFR_PART_11_PACK 与 rules 数组均被冻结
 * - T2. CFR-01 电子签名（static / blocker）
 *   - T2a. 项目无 @ElectronicSignature → 通过
 *   - T2b. @ElectronicSignature 含 userId/timestamp/meaning → 通过
 *   - T2c. @ElectronicSignature 缺失 userId → 失败
 *   - T2d. @ElectronicSignature 缺失多个字段 → 失败
 * - T3. CFR-02 记录生成（static / blocker）
 *   - T3a. 项目无记录生成调用 → 通过
 *   - T3b. auditLog.record 含完整字段 → 通过
 *   - T3c. auditLog.record 缺失 timestamp → 失败
 *   - T3d. saveRecord 含 action 字段（替代 content）→ 通过
 * - T4. CFR-03 记录保护（static / major）
 *   - T4a. 项目无文件操作 → 通过
 *   - T4b. 文件操作 + @Protected 装饰器 → 通过
 *   - T4c. 文件操作 + chmod 调用 → 通过
 *   - T4d. 文件操作无保护 → 失败
 * - T5. CFR-04 系统访问控制（static / blocker）
 *   - T5a. 项目无 API 端点 → 通过
 *   - T5b. @Get + @Authenticated → 通过
 *   - T5c. @Post + requireAuth 调用 → 通过
 *   - T5d. @Get 无认证 → 失败
 * - T6. CFR-05 审计追踪（dynamic / blocker）
 *   - T6a. testRunner 未注入 → passed=false
 *   - T6b. testRunner 返回 exitCode=0 + 输出含'审计追踪验证通过' → 通过
 *   - T6c. testRunner 返回 exitCode=1 → 失败
 * - T7. 真实法规引用校验
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，构造真实 fileMap
 *
 * @module core/tests/eag-icp-cfr-part11-pack
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CFR_PART_11_PACK, __internal } from "../eag/icp/packs/cfr-part11-pack";
import type { ComplianceCheckContext, ComplianceTestRunner } from "../eag/icp/types";

// ============================================================================
// 辅助函数
// ============================================================================

function createContext(
  fileMap: Record<string, string> = {},
  testRunner?: ComplianceTestRunner
): ComplianceCheckContext {
  return {
    projectRoot: "/tmp/test-project",
    fileMap,
    astMap: {},
    configMap: {},
    testRunner,
  };
}

class InMemoryTestRunner implements ComplianceTestRunner {
  private readonly results: Readonly<Record<string, { exitCode: number; output: string }>>;

  constructor(results: Record<string, { exitCode: number; output: string }>) {
    this.results = Object.freeze({ ...results });
  }

  async run(testPath: string): Promise<{ exitCode: number; output: string }> {
    const result = this.results[testPath];
    if (!result) {
      return { exitCode: 1, output: `测试文件未找到：${testPath}` };
    }
    return { exitCode: result.exitCode, output: result.output };
  }
}

// ============================================================================
// T1. CFR_PART_11_PACK 合规包结构
// ============================================================================

test("T1a: CFR_PART_11_PACK packId/packName/version 字段正确", () => {
  assert.equal(CFR_PART_11_PACK.packId, "CFR");
  assert.equal(CFR_PART_11_PACK.packName, "21 CFR Part 11 电子记录与电子签名");
  assert.equal(CFR_PART_11_PACK.version, "1.0.0");
});

test("T1b: CFR_PART_11_PACK rules 含 5 条规则（CFR-01 ~ CFR-05）", () => {
  assert.equal(CFR_PART_11_PACK.rules.length, 5);
  const ruleIds = CFR_PART_11_PACK.rules.map((r) => r.ruleId);
  assert.deepEqual(ruleIds, ["CFR-01", "CFR-02", "CFR-03", "CFR-04", "CFR-05"]);
});

test("T1c: CFR 全部规则 regulatoryReference 引用真实法规条款", () => {
  const expectedReferences: Record<string, string> = {
    "CFR-01": "21 CFR 11.50",
    "CFR-02": "21 CFR 11.10(b)",
    "CFR-03": "21 CFR 11.10(c)",
    "CFR-04": "21 CFR 11.10(d)",
    "CFR-05": "21 CFR 11.10(e)",
  };

  for (const rule of CFR_PART_11_PACK.rules) {
    const expected = expectedReferences[rule.ruleId];
    assert.equal(rule.regulatoryReference, expected);
    assert.ok(rule.regulatoryReference.length > 0);
  }
});

test("T1d: CFR_PART_11_PACK 与 rules 数组均被冻结", () => {
  assert.ok(Object.isFrozen(CFR_PART_11_PACK));
  assert.ok(Object.isFrozen(CFR_PART_11_PACK.rules));
});

test("T1e: CFR 全部规则 checkKind 与 severity 字段正确", () => {
  const expected: Record<string, { checkKind: string; severity: string }> = {
    "CFR-01": { checkKind: "static", severity: "blocker" },
    "CFR-02": { checkKind: "static", severity: "blocker" },
    "CFR-03": { checkKind: "static", severity: "major" },
    "CFR-04": { checkKind: "static", severity: "blocker" },
    "CFR-05": { checkKind: "dynamic", severity: "blocker" },
  };
  for (const rule of CFR_PART_11_PACK.rules) {
    const exp = expected[rule.ruleId];
    assert.equal(rule.checkKind, exp.checkKind);
    assert.equal(rule.severity, exp.severity);
  }
});

// ============================================================================
// T2. CFR-01 电子签名
// ============================================================================

test("T2a: CFR-01 项目无 @ElectronicSignature → 通过", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-01")!;
  const ctx = createContext({ "src/service.ts": "export class Service {}" });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "blocker");
});

test("T2b: CFR-01 @ElectronicSignature 含 userId/timestamp/meaning → 通过", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-01")!;
  const ctx = createContext({
    "src/sign.ts":
      "export class SignService {\n" +
      "  @ElectronicSignature({ userId: 'user-001', timestamp: new Date(), meaning: 'approve' })\n" +
      "  signDocument() {}\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.ok(result.reason.includes("1 个签名"));
});

test("T2c: CFR-01 @ElectronicSignature 缺失 userId → 失败", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-01")!;
  const ctx = createContext({
    "src/sign.ts":
      "export class SignService {\n" +
      "  @ElectronicSignature({ timestamp: new Date(), meaning: 'approve' })\n" +
      "  signDocument() {}\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("userId"));
});

test("T2d: CFR-01 @ElectronicSignature 缺失多个字段 → 失败", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-01")!;
  const ctx = createContext({
    "src/sign.ts":
      "export class SignService {\n" +
      "  @ElectronicSignature({ userId: 'user-001' })\n" +
      "  signDocument() {}\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("timestamp"));
  assert.ok(result.reason.includes("meaning"));
});

// ============================================================================
// T3. CFR-02 记录生成
// ============================================================================

test("T3a: CFR-02 项目无记录生成调用 → 通过", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-02")!;
  const ctx = createContext({ "src/service.ts": "export class Service {}" });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T3b: CFR-02 auditLog.record 含完整字段 → 通过", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-02")!;
  const ctx = createContext({
    "src/audit.ts":
      "import { auditLog } from './audit';\n" +
      "export function logAction() {\n" +
      "  auditLog.record({ timestamp: new Date(), operator: 'user-001', content: 'approved' });\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.ok(result.reason.includes("1 个记录"));
});

test("T3c: CFR-02 auditLog.record 缺失 timestamp → 失败", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-02")!;
  const ctx = createContext({
    "src/audit.ts":
      "import { auditLog } from './audit';\n" +
      "export function logAction() {\n" +
      "  auditLog.record({ operator: 'user-001', content: 'approved' });\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("timestamp"));
});

test("T3d: CFR-02 saveRecord 含 action 字段（替代 content）→ 通过", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-02")!;
  const ctx = createContext({
    "src/audit.ts":
      "import { saveRecord } from './audit';\n" +
      "export function logAction() {\n" +
      "  saveRecord({ timestamp: new Date(), operator: 'user-001', action: 'approve' });\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T3e: CFR-02 logRecord 缺失 operator 与 content/action → 失败", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-02")!;
  const ctx = createContext({
    "src/audit.ts":
      "import { logRecord } from './audit';\n" +
      "export function logAction() {\n" +
      "  logRecord({ timestamp: new Date() });\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("operator"));
  assert.ok(result.reason.includes("content/action"));
});

// ============================================================================
// T4. CFR-03 记录保护
// ============================================================================

test("T4a: CFR-03 项目无文件操作 → 通过", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-03")!;
  const ctx = createContext({ "src/service.ts": "export class Service {}" });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "major");
});

test("T4b: CFR-03 文件操作 + @Protected 装饰器 → 通过", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-03")!;
  const ctx = createContext({
    "src/file.ts":
      "import * as fs from 'node:fs';\n" +
      "export class FileService {\n" +
      "  @Protected\n" +
      "  writeLog() {\n" +
      "    fs.writeFile('log.txt', 'data');\n" +
      "  }\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T4c: CFR-03 文件操作 + chmod 调用 → 通过", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-03")!;
  const ctx = createContext({
    "src/file.ts":
      "import * as fs from 'node:fs';\n" +
      "export function writeLog() {\n" +
      "  fs.writeFile('log.txt', 'data');\n" +
      "  fs.chmod('log.txt', 0o600);\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T4d: CFR-03 文件操作无保护 → 失败", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-03")!;
  const ctx = createContext({
    "src/file.ts":
      "import * as fs from 'node:fs';\n" +
      "export function writeLog() {\n" +
      "  fs.writeFile('log.txt', 'data');\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("缺少权限保护"));
});

// ============================================================================
// T5. CFR-04 系统访问控制
// ============================================================================

test("T5a: CFR-04 项目无 API 端点 → 通过", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-04")!;
  const ctx = createContext({ "src/service.ts": "export class Service {}" });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "blocker");
});

test("T5b: CFR-04 @Get + @Authenticated → 通过", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-04")!;
  const ctx = createContext({
    "src/controller.ts":
      "export class OrderController {\n" + "  @Authenticated\n" + "  @Get('/orders')\n" + "  getOrders() {}\n" + "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T5c: CFR-04 @Post + requireAuth 调用 → 通过", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-04")!;
  const ctx = createContext({
    "src/controller.ts":
      "export class OrderController {\n" +
      "  @Post('/orders')\n" +
      "  createOrder() {\n" +
      "    requireAuth();\n" +
      "    return 'created';\n" +
      "  }\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T5d: CFR-04 @Get 无认证 → 失败", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-04")!;
  const ctx = createContext({
    "src/controller.ts": "export class OrderController {\n" + "  @Get('/orders')\n" + "  getOrders() {}\n" + "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("缺少认证"));
});

test("T5e: CFR-04 多种端点装饰器（@Delete/@Put 等）应都被识别", () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-04")!;
  const ctx = createContext({
    "src/controller.ts":
      "export class OrderController {\n" +
      "  @Authenticated\n" +
      "  @Delete('/orders/:id')\n" +
      "  deleteOrder() {}\n" +
      "  @Authenticated\n" +
      "  @Put('/orders/:id')\n" +
      "  updateOrder() {}\n" +
      "  @Authenticated\n" +
      "  @Patch('/orders/:id')\n" +
      "  patchOrder() {}\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.ok(result.reason.includes("3 个端点"));
});

// ============================================================================
// T6. CFR-05 审计追踪
// ============================================================================

test("T6a: CFR-05 testRunner 未注入 → passed=false", async () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-05")!;
  const ctx = createContext({});
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, false);
  assert.equal(result.severity, "blocker");
});

test("T6b: CFR-05 testRunner 返回 exitCode=0 + 输出含'审计追踪验证通过' → 通过", async () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-05")!;
  const ctx = createContext(
    {},
    new InMemoryTestRunner({
      "tests/compliance/cfr-05.audit.test.ts": {
        exitCode: 0,
        output: "审计追踪验证通过\nall tests passed",
      },
    })
  );
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T6c: CFR-05 testRunner 返回 exitCode=1 → 失败", async () => {
  const rule = CFR_PART_11_PACK.rules.find((r) => r.ruleId === "CFR-05")!;
  const ctx = createContext(
    {},
    new InMemoryTestRunner({
      "tests/compliance/cfr-05.audit.test.ts": {
        exitCode: 1,
        output: "审计追踪验证通过",
      },
    })
  );
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, false);
});

// ============================================================================
// T7. 内部工具函数与法规校验
// ============================================================================

test("T7a: __internal.scanFunctionCalls 应正确识别 auditLog.record 调用", () => {
  const calls = __internal.scanFunctionCalls(
    "test.ts",
    "auditLog.record({ timestamp: 1, operator: 'x', content: 'y' });",
    ["auditLog.record"]
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callee, "auditLog.record");
  assert.ok(calls[0].argPropertyNames.includes("timestamp"));
  assert.ok(calls[0].argPropertyNames.includes("operator"));
  assert.ok(calls[0].argPropertyNames.includes("content"));
});

test("T7b: __internal.scanDecorators 应正确识别 @ElectronicSignature", () => {
  const decorators = __internal.scanDecorators(
    "test.ts",
    "export class S {\n  @ElectronicSignature({ userId: 'u', timestamp: 1, meaning: 'm' })\n  sign() {}\n}",
    "ElectronicSignature"
  );
  assert.equal(decorators.length, 1);
  assert.equal(decorators[0].name, "ElectronicSignature");
  assert.ok(decorators[0].argPropertyNames.includes("userId"));
});

test("T7c: CFR 全部规则 regulatoryReference 应引用真实存在的法规", () => {
  const realRegulations = ["21 CFR 11.50", "21 CFR 11.10(b)", "21 CFR 11.10(c)", "21 CFR 11.10(d)", "21 CFR 11.10(e)"];
  for (const rule of CFR_PART_11_PACK.rules) {
    assert.ok(
      realRegulations.includes(rule.regulatoryReference),
      `${rule.ruleId} 的 regulatoryReference "${rule.regulatoryReference}" 应在真实法规白名单中`
    );
  }
});
