/**
 * EAG-P3 批次 11 单元测试：ALCOA+ 数据完整性原则合规规则集（packs/alcoa-plus-pack.ts）
 *
 * 测试范围：
 * - T1. ALCOA_PLUS_PACK 合规包结构（9 条规则）
 * - T2. ALCOA-01 Attributable（static / blocker）
 * - T3. ALCOA-02 Legible（static / major）
 * - T4. ALCOA-03 Contemporaneous（static / blocker）
 * - T5. ALCOA-04 Original（static / major）
 * - T6. ALCOA-05 Accurate（dynamic / blocker）
 * - T7. ALCOA-06 Complete（static / major）
 * - T8. ALCOA-07 Consistent（static / major）
 * - T9. ALCOA-08 Enduring（static / warning）
 * - T10. ALCOA-09 Available（dynamic / warning）
 * - T11. 真实法规引用校验
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，构造真实 fileMap
 *
 * @module core/tests/eag-icp-alcoa-plus-pack
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ALCOA_PLUS_PACK, __internal } from "../eag/icp/packs/alcoa-plus-pack";
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
// T1. ALCOA_PLUS_PACK 合规包结构
// ============================================================================

test("T1a: ALCOA_PLUS_PACK packId/packName/version 字段正确", () => {
  assert.equal(ALCOA_PLUS_PACK.packId, "ALCOA");
  assert.equal(ALCOA_PLUS_PACK.packName, "ALCOA+ 数据完整性原则");
  assert.equal(ALCOA_PLUS_PACK.version, "1.0.0");
});

test("T1b: ALCOA_PLUS_PACK rules 含 9 条规则（ALCOA-01 ~ ALCOA-09）", () => {
  assert.equal(ALCOA_PLUS_PACK.rules.length, 9);
  const ruleIds = ALCOA_PLUS_PACK.rules.map((r) => r.ruleId);
  assert.deepEqual(ruleIds, [
    "ALCOA-01",
    "ALCOA-02",
    "ALCOA-03",
    "ALCOA-04",
    "ALCOA-05",
    "ALCOA-06",
    "ALCOA-07",
    "ALCOA-08",
    "ALCOA-09",
  ]);
});

test("T1c: ALCOA 全部规则 regulatoryReference 引用真实法规条款", () => {
  const expectedReferences: Record<string, string> = {
    "ALCOA-01": "FDA Guidance 2018 §III.A",
    "ALCOA-02": "FDA Guidance 2018 §III.B",
    "ALCOA-03": "FDA Guidance 2018 §III.C",
    "ALCOA-04": "FDA Guidance 2018 §III.D",
    "ALCOA-05": "FDA Guidance 2018 §III.E",
    "ALCOA-06": "FDA Guidance 2018 §III.F",
    "ALCOA-07": "FDA Guidance 2018 §III.G",
    "ALCOA-08": "FDA Guidance 2018 §III.H",
    "ALCOA-09": "FDA Guidance 2018 §III.I",
  };
  for (const rule of ALCOA_PLUS_PACK.rules) {
    assert.equal(rule.regulatoryReference, expectedReferences[rule.ruleId]);
    assert.ok(rule.regulatoryReference.length > 0);
  }
});

test("T1d: ALCOA_PLUS_PACK 与 rules 数组均被冻结", () => {
  assert.ok(Object.isFrozen(ALCOA_PLUS_PACK));
  assert.ok(Object.isFrozen(ALCOA_PLUS_PACK.rules));
});

test("T1e: ALCOA 全部规则 checkKind 与 severity 字段正确", () => {
  const expected: Record<string, { checkKind: string; severity: string }> = {
    "ALCOA-01": { checkKind: "static", severity: "blocker" },
    "ALCOA-02": { checkKind: "static", severity: "major" },
    "ALCOA-03": { checkKind: "static", severity: "blocker" },
    "ALCOA-04": { checkKind: "static", severity: "major" },
    "ALCOA-05": { checkKind: "dynamic", severity: "blocker" },
    "ALCOA-06": { checkKind: "static", severity: "major" },
    "ALCOA-07": { checkKind: "static", severity: "major" },
    "ALCOA-08": { checkKind: "static", severity: "warning" },
    "ALCOA-09": { checkKind: "dynamic", severity: "warning" },
  };
  for (const rule of ALCOA_PLUS_PACK.rules) {
    const exp = expected[rule.ruleId];
    assert.equal(rule.checkKind, exp.checkKind);
    assert.equal(rule.severity, exp.severity);
  }
});

// ============================================================================
// T2. ALCOA-01 Attributable
// ============================================================================

test("T2a: ALCOA-01 项目无数据写入调用 → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-01")!;
  const ctx = createContext({ "src/service.ts": "export class Service {}" });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "blocker");
});

test("T2b: ALCOA-01 repository.save 含 createdBy + createdAt → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-01")!;
  const ctx = createContext({
    "src/repo.ts":
      "export class OrderRepo {\n" +
      "  save() {\n" +
      "    repository.save({ id: 1, createdBy: 'user-001', createdAt: new Date() });\n" +
      "  }\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T2c: ALCOA-01 db.insert 缺失 createdBy → 失败", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-01")!;
  const ctx = createContext({
    "src/repo.ts":
      "export class OrderRepo {\n" +
      "  insert() {\n" +
      "    db.insert({ id: 1, createdAt: new Date() });\n" +
      "  }\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("createdBy"));
});

test("T2d: ALCOA-01 record.create 缺失 createdAt → 失败", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-01")!;
  const ctx = createContext({
    "src/repo.ts":
      "export class OrderRepo {\n" +
      "  create() {\n" +
      "    record.create({ id: 1, createdBy: 'user-001' });\n" +
      "  }\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("createdAt"));
});

// ============================================================================
// T3. ALCOA-02 Legible
// ============================================================================

test("T3a: ALCOA-02 项目无日志调用 → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-02")!;
  const ctx = createContext({ "src/service.ts": "export class Service {}" });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "major");
});

test("T3b: ALCOA-02 console.log 结构化（含 timestamp/level/message）→ 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-02")!;
  const ctx = createContext({
    "src/log.ts": "console.log({ timestamp: new Date().toISOString(), level: 'info', message: 'hello' });",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T3c: ALCOA-02 console.log 非结构化 → 失败", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-02")!;
  const ctx = createContext({
    "src/log.ts": "console.log('hello world');",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("非结构化"));
});

test("T3d: ALCOA-02 logger.info 结构化 → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-02")!;
  const ctx = createContext({
    "src/log.ts": "logger.info({ timestamp: '2026-07-19T10:00:00Z', level: 'info', message: 'ok' });",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

// ============================================================================
// T4. ALCOA-03 Contemporaneous
// ============================================================================

test("T4a: ALCOA-03 项目无时间戳赋值 → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-03")!;
  const ctx = createContext({ "src/service.ts": "export class Service {}" });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "blocker");
});

test("T4b: ALCOA-03 createdAt 使用 new Date() → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-03")!;
  const ctx = createContext({
    "src/model.ts": "const record = { createdAt: new Date() };",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T4c: ALCOA-03 createdAt 使用 Date.now() → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-03")!;
  const ctx = createContext({
    "src/model.ts": "const record = { timestamp: Date.now() };",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T4d: ALCOA-03 createdAt 硬编码字符串 → 失败", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-03")!;
  const ctx = createContext({
    "src/model.ts": "const record = { createdAt: '2024-01-01' };",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("硬编码"));
});

test("T4e: ALCOA-03 timestamp 硬编码数字 → 失败", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-03")!;
  const ctx = createContext({
    "src/model.ts": "const record = { timestamp: 1700000000000 };",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("硬编码"));
});

test("T4f: ALCOA-03 使用变量赋值 → 通过（认为运行期动态赋值）", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-03")!;
  const ctx = createContext({
    "src/model.ts": "const now = Date.now();\nconst record = { createdAt: now };",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

// ============================================================================
// T5. ALCOA-04 Original
// ============================================================================

test("T5a: ALCOA-04 项目无 @DataSource → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-04")!;
  const ctx = createContext({ "src/service.ts": "export class Service {}" });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "major");
});

test("T5b: ALCOA-04 @DataSource 含 source + type → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-04")!;
  const ctx = createContext({
    "src/source.ts":
      "export class Service {\n" +
      "  @DataSource({ source: 'api-endpoint-1', type: 'json' })\n" +
      "  fetchData() {}\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T5c: ALCOA-04 @DataSource 缺失 source → 失败", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-04")!;
  const ctx = createContext({
    "src/source.ts": "export class Service {\n" + "  @DataSource({ type: 'json' })\n" + "  fetchData() {}\n" + "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("source"));
});

test("T5d: ALCOA-04 @DataSource 缺失 type → 失败", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-04")!;
  const ctx = createContext({
    "src/source.ts": "export class Service {\n" + "  @DataSource({ source: 'api-1' })\n" + "  fetchData() {}\n" + "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("type"));
});

// ============================================================================
// T6. ALCOA-05 Accurate
// ============================================================================

test("T6a: ALCOA-05 testRunner 未注入 → passed=false", async () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-05")!;
  const ctx = createContext({});
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, false);
  assert.equal(result.severity, "blocker");
});

test("T6b: ALCOA-05 testRunner 返回 exitCode=0 + 输出含'数据准确性验证通过' → 通过", async () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-05")!;
  const ctx = createContext(
    {},
    new InMemoryTestRunner({
      "tests/compliance/alcoa-05.accuracy.test.ts": {
        exitCode: 0,
        output: "数据准确性验证通过\nall tests passed",
      },
    })
  );
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T6c: ALCOA-05 testRunner 返回 exitCode=1 → 失败", async () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-05")!;
  const ctx = createContext(
    {},
    new InMemoryTestRunner({
      "tests/compliance/alcoa-05.accuracy.test.ts": {
        exitCode: 1,
        output: "数据准确性验证通过",
      },
    })
  );
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, false);
});

// ============================================================================
// T7. ALCOA-06 Complete
// ============================================================================

test("T7a: ALCOA-06 项目无 *Record / *Entity 接口 → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-06")!;
  const ctx = createContext({
    "src/types.ts": "export interface SomeType { id: number; }",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "major");
});

test("T7b: ALCOA-06 *Record 接口必填属性有 @Required 注释 → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-06")!;
  const ctx = createContext({
    "src/types.ts":
      "export interface OrderRecord {\n" +
      "  /** @Required */\n" +
      "  id: number;\n" +
      "  /** @Required */\n" +
      "  name: string;\n" +
      "  optional?: string;\n" +
      "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T7c: ALCOA-06 *Entity 接口必填属性无完整性约束 → 失败", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-06")!;
  const ctx = createContext({
    "src/types.ts": "export interface OrderEntity {\n" + "  id: number;\n" + "  name: string;\n" + "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("缺少完整性约束"));
});

test("T7d: ALCOA-06 可选属性不强制完整性约束 → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-06")!;
  const ctx = createContext({
    "src/types.ts":
      "export interface OrderRecord {\n" + "  /** @Required */\n" + "  id: number;\n" + "  optional?: string;\n" + "}",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

// ============================================================================
// T8. ALCOA-07 Consistent
// ============================================================================

test("T8a: ALCOA-07 项目无日期格式化调用 → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-07")!;
  const ctx = createContext({ "src/service.ts": "export class Service {}" });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "major");
});

test("T8b: ALCOA-07 formatDate 使用 ISO 8601 格式 → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-07")!;
  const ctx = createContext({
    "src/date.ts": "formatDate(new Date(), 'YYYY-MM-DD');",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T8c: ALCOA-07 formatDate 使用非 ISO 8601 格式 → 失败", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-07")!;
  const ctx = createContext({
    "src/date.ts": "formatDate(new Date(), 'DD/MM/YYYY');",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("非 ISO 8601 格式"));
});

test("T8d: ALCOA-07 moment.format 使用 ISO 8601 → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-07")!;
  const ctx = createContext({
    "src/date.ts": "moment.format('YYYY-MM-DDTHH:mm:ss.sssZ');",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

// ============================================================================
// T9. ALCOA-08 Enduring
// ============================================================================

test("T9a: ALCOA-08 项目无持久化调用 → 通过（警告）", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-08")!;
  const ctx = createContext({ "src/service.ts": "export class Service {}" });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "warning");
});

test("T9b: ALCOA-08 repository.save 持久化 → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-08")!;
  const ctx = createContext({
    "src/repo.ts": "repository.save({ id: 1 });",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T9c: ALCOA-08 fs.writeFile 持久化 → 通过", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-08")!;
  const ctx = createContext({
    "src/file.ts": "fs.writeFile('data.txt', 'content');",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T9d: ALCOA-08 memoryCache.set 内存存储 → 失败（warning）", () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-08")!;
  const ctx = createContext({
    "src/cache.ts": "memoryCache.set('key', 'value');",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("内存存储"));
});

// ============================================================================
// T10. ALCOA-09 Available
// ============================================================================

test("T10a: ALCOA-09 testRunner 未注入 → passed=false", async () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-09")!;
  const ctx = createContext({});
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, false);
  assert.equal(result.severity, "warning");
});

test("T10b: ALCOA-09 testRunner 返回 exitCode=0 + 输出含'数据可用性验证通过' → 通过", async () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-09")!;
  const ctx = createContext(
    {},
    new InMemoryTestRunner({
      "tests/compliance/alcoa-09.available.test.ts": {
        exitCode: 0,
        output: "数据可用性验证通过\nall tests passed",
      },
    })
  );
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T10c: ALCOA-09 testRunner 返回 exitCode=1 → 失败（warning）", async () => {
  const rule = ALCOA_PLUS_PACK.rules.find((r) => r.ruleId === "ALCOA-09")!;
  const ctx = createContext(
    {},
    new InMemoryTestRunner({
      "tests/compliance/alcoa-09.available.test.ts": {
        exitCode: 1,
        output: "数据可用性验证通过",
      },
    })
  );
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, false);
});

// ============================================================================
// T11. 内部工具与法规校验
// ============================================================================

test("T11a: __internal.scanInterfaceProperties 应正确识别接口属性", () => {
  const properties = __internal.scanInterfaceProperties(
    "test.ts",
    "export interface OrderRecord {\n  id: number;\n  name?: string;\n}",
    "OrderRecord"
  );
  assert.equal(properties.length, 2);
  assert.equal(properties[0].name, "id");
  assert.equal(properties[0].optional, false);
  assert.equal(properties[1].name, "name");
  assert.equal(properties[1].optional, true);
});

test("T11b: ALCOA 全部规则 regulatoryReference 应引用真实存在的法规", () => {
  const realRegulations = [
    "FDA Guidance 2018 §III.A",
    "FDA Guidance 2018 §III.B",
    "FDA Guidance 2018 §III.C",
    "FDA Guidance 2018 §III.D",
    "FDA Guidance 2018 §III.E",
    "FDA Guidance 2018 §III.F",
    "FDA Guidance 2018 §III.G",
    "FDA Guidance 2018 §III.H",
    "FDA Guidance 2018 §III.I",
  ];
  for (const rule of ALCOA_PLUS_PACK.rules) {
    assert.ok(
      realRegulations.includes(rule.regulatoryReference),
      `${rule.ruleId} 的 regulatoryReference "${rule.regulatoryReference}" 应在真实法规白名单中`
    );
  }
});
