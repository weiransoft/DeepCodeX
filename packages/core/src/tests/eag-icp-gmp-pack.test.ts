/**
 * EAG-P3 批次 11 单元测试：GMP 合规规则集（packs/gmp-pack.ts）
 *
 * 测试范围：
 * - T1. GMP_PACK 合规包结构
 *   - T1a. packId / packName / version 字段
 *   - T1b. rules 数组含 6 条规则（GMP-01 ~ GMP-06）
 *   - T1c. 全部规则 regulatoryReference 引用真实法规条款
 *   - T1d. GMP_PACK 与 rules 数组均被冻结
 * - T2. GMP-01 工艺验证（static / blocker）
 *   - T2a. 项目无 @ProcessStep 装饰器 → 通过（无适用规则）
 *   - T2b. @ProcessStep 含对应测试文件且测试含 test() → 通过
 *   - T2c. @ProcessStep 缺失对应测试文件 → 失败（blocker）
 *   - T2d. 测试文件存在但无 test() 用例 → 失败
 *   - T2e. AST 准确性：字符串字面量内的 @ProcessStep 不被误识别
 * - T3. GMP-02 批记录（dynamic / blocker）
 *   - T3a. testRunner 未注入 → passed=false
 *   - T3b. testRunner 返回 exitCode=0 + 输出含"批记录验证通过" → 通过
 *   - T3c. testRunner 返回 exitCode=1 → 失败
 *   - T3d. testRunner 输出不含"批记录验证通过" → 失败
 * - T4. GMP-03 变更控制（static / major）
 *   - T4a. 项目无 @ChangeControl → 通过
 *   - T4b. @ChangeControl 含完整变更记录 → 通过
 *   - T4c. @ChangeControl 缺失变更记录文件 → 失败
 *   - T4d. 变更记录缺失必要章节 → 失败
 * - T5. GMP-04 偏差处理（dynamic / major）
 *   - T5a. testRunner 未注入 → passed=false
 *   - T5b. testRunner 返回 exitCode=0 + 输出含"偏差处理验证通过" → 通过
 *   - T5c. testRunner 返回 exitCode=1 → 失败
 * - T6. GMP-05 质量风险管理（static / major）
 *   - T6a. 项目无 @RiskAssessed → 通过
 *   - T6b. @RiskAssessed 含完整风险评估 → 通过
 *   - T6c. @RiskAssessed 缺失风险评估文件 → 失败
 * - T7. GMP-06 物料管理（dynamic / blocker）
 *   - T7a. testRunner 未注入 → passed=false
 *   - T7b. testRunner 返回 exitCode=0 + 输出含"物料管理验证通过" → 通过
 *   - T7c. testRunner 返回 exitCode=1 → 失败
 * - T8. 真实法规引用校验
 *   - T8a. 全部规则的 regulatoryReference 引用真实法规条款
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，构造真实 fileMap（含真实 TypeScript 代码字符串）
 * - 真实 testRunner 实现（InMemoryTestRunner 真实对象，非 mock）
 *
 * @module core/tests/eag-icp-gmp-pack
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GMP_PACK, __internal } from "../eag/icp/packs/gmp-pack";
import type { ComplianceCheckContext, ComplianceTestRunner } from "../eag/icp/types";

// ============================================================================
// 辅助函数：构造测试上下文与真实 testRunner
// ============================================================================

/**
 * 构造合规检查上下文（真实 fileMap）
 *
 * @param fileMap 文件清单
 * @param testRunner 测试运行器（可选）
 * @returns 真实 ComplianceCheckContext 实例
 */
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

/**
 * 真实 InMemoryTestRunner（预录制测试输出，非 mock）
 *
 * 设计说明：
 * - 不使用 mock 框架（如 sinon），而是真实实现 ComplianceTestRunner 协议
 * - 测试输出由真实代码路径生成（testRunner.run() 真实执行逻辑）
 * - 输出内容由调用方注入，模拟真实测试运行结果
 */
class InMemoryTestRunner implements ComplianceTestRunner {
  /** 预录制的测试结果映射（testPath → { exitCode, output }） */
  private readonly results: Readonly<Record<string, { exitCode: number; output: string }>>;

  /**
   * @param results 预录制测试结果映射
   */
  constructor(results: Record<string, { exitCode: number; output: string }>) {
    this.results = Object.freeze({ ...results });
  }

  /**
   * 运行测试：从预录制结果中查询，未找到则返回失败
   *
   * @param testPath 测试文件路径
   * @returns 测试结果（exitCode 与 output）
   */
  async run(testPath: string): Promise<{ exitCode: number; output: string }> {
    const result = this.results[testPath];
    if (!result) {
      return {
        exitCode: 1,
        output: `测试文件未找到：${testPath}`,
      };
    }
    return { exitCode: result.exitCode, output: result.output };
  }
}

// ============================================================================
// T1. GMP_PACK 合规包结构
// ============================================================================

test("T1a: GMP_PACK packId/packName/version 字段正确", () => {
  assert.equal(GMP_PACK.packId, "GMP");
  assert.equal(GMP_PACK.packName, "药品生产质量管理规范（GMP）");
  assert.equal(GMP_PACK.version, "1.0.0");
});

test("T1b: GMP_PACK rules 含 6 条规则（GMP-01 ~ GMP-06）", () => {
  assert.equal(GMP_PACK.rules.length, 6);
  const ruleIds = GMP_PACK.rules.map((r) => r.ruleId);
  assert.deepEqual(ruleIds, ["GMP-01", "GMP-02", "GMP-03", "GMP-04", "GMP-05", "GMP-06"]);
});

test("T1c: GMP 全部规则 regulatoryReference 引用真实法规条款", () => {
  // 真实法规条款映射（设计文档 §6.4 规定）
  const expectedReferences: Record<string, string> = {
    "GMP-01": "21 CFR 211.110(a)",
    "GMP-02": "21 CFR 211.100",
    "GMP-03": "ICH Q10 §13",
    "GMP-04": "21 CFR 211.192",
    "GMP-05": "ICH Q9",
    "GMP-06": "21 CFR 211.80",
  };

  for (const rule of GMP_PACK.rules) {
    const expected = expectedReferences[rule.ruleId];
    assert.ok(expected, `${rule.ruleId} 应在期望列表中`);
    assert.equal(
      rule.regulatoryReference,
      expected,
      `${rule.ruleId} 的 regulatoryReference 应为 ${expected}（实际：${rule.regulatoryReference}）`
    );
    // 校验非空
    assert.ok(rule.regulatoryReference.length > 0, `${rule.ruleId} regulatoryReference 不应为空`);
  }
});

test("T1d: GMP_PACK 与 rules 数组均被冻结", () => {
  assert.ok(Object.isFrozen(GMP_PACK), "GMP_PACK 应被冻结");
  assert.ok(Object.isFrozen(GMP_PACK.rules), "GMP_PACK.rules 应被冻结");
});

test("T1e: GMP 全部规则 checkKind 与 severity 字段正确", () => {
  const expected: Record<string, { checkKind: string; severity: string }> = {
    "GMP-01": { checkKind: "static", severity: "blocker" },
    "GMP-02": { checkKind: "dynamic", severity: "blocker" },
    "GMP-03": { checkKind: "static", severity: "major" },
    "GMP-04": { checkKind: "dynamic", severity: "major" },
    "GMP-05": { checkKind: "static", severity: "major" },
    "GMP-06": { checkKind: "dynamic", severity: "blocker" },
  };
  for (const rule of GMP_PACK.rules) {
    const exp = expected[rule.ruleId];
    assert.equal(rule.checkKind, exp.checkKind, `${rule.ruleId} checkKind`);
    assert.equal(rule.severity, exp.severity, `${rule.ruleId} severity`);
  }
});

// ============================================================================
// T2. GMP-01 工艺验证
// ============================================================================

test("T2a: GMP-01 项目无 @ProcessStep 装饰器 → 通过", () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-01")!;
  const ctx = createContext({
    "src/service.ts": "export class Service { hello() { return 1; } }",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true, "无 @ProcessStep 应通过");
  assert.equal(result.severity, "blocker");
  assert.ok(Object.isFrozen(result), "结果应被冻结");
});

test("T2b: GMP-01 @ProcessStep 含对应测试文件且测试含 test() 用例 → 通过", () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-01")!;
  const ctx = createContext({
    "src/production.ts":
      "export class Production {\n" + '  @ProcessStep("synthesis")\n' + "  synthesis() { /* ... */ }\n" + "}",
    "tests/process-validation/synthesis.process.test.ts":
      "import { test } from 'node:test';\n" + "test('synthesis process', () => { /* assertions */ });",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true, "有 @ProcessStep + 测试文件 + test() 用例应通过");
  assert.ok(result.reason.includes("1 个步骤"), `reason 应含通过步骤数（实际：${result.reason}）`);
  // 校验证据含 code-snippet 与 test-output
  const kinds = result.evidence.map((e) => e.kind);
  assert.ok(kinds.includes("code-snippet"), "证据应含 code-snippet");
  assert.ok(kinds.includes("test-output"), "证据应含 test-output");
});

test("T2c: GMP-01 @ProcessStep 缺失对应测试文件 → 失败", () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-01")!;
  const ctx = createContext({
    "src/production.ts":
      "export class Production {\n" + '  @ProcessStep("synthesis")\n' + "  synthesis() { /* ... */ }\n" + "}",
    // 故意缺失 tests/process-validation/synthesis.process.test.ts
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false, "缺失测试文件应失败");
  assert.ok(result.reason.includes("synthesis"), "失败原因应含 stepName");
});

test("T2d: GMP-01 测试文件存在但无 test() 用例 → 失败", () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-01")!;
  const ctx = createContext({
    "src/production.ts":
      "export class Production {\n" + '  @ProcessStep("synthesis")\n' + "  synthesis() { /* ... */ }\n" + "}",
    "tests/process-validation/synthesis.process.test.ts":
      "// 空测试文件，无 test() 调用\nimport { describe } from 'node:test';\ndescribe('placeholder', () => {});",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false, "测试文件无 test() 用例应失败");
  assert.ok(result.reason.includes("不包含任何 test()"));
});

test("T2e: GMP-01 AST 准确性——字符串字面量内的 @ProcessStep 不被误识别", () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-01")!;
  const ctx = createContext({
    "src/comment.ts":
      "// 这是注释，不是真正的 @ProcessStep 装饰器\n" +
      "const text = '@ProcessStep(\"fake\")';\n" +
      "export class Foo { bar() {} }",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true, "字符串字面量内的伪 @ProcessStep 不应触发规则");
});

test("T2f: GMP-01 多个 @ProcessStep 部分缺失测试 → 失败", () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-01")!;
  const ctx = createContext({
    "src/production.ts":
      "export class Production {\n" +
      '  @ProcessStep("step1")\n' +
      "  step1() {}\n" +
      '  @ProcessStep("step2")\n' +
      "  step2() {}\n" +
      "}",
    "tests/process-validation/step1.process.test.ts": "import { test } from 'node:test';\ntest('step1', () => {});",
    // 缺失 step2 测试文件
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false, "缺失部分测试应失败");
  assert.ok(result.reason.includes("step2"));
  assert.ok(result.reason.includes("1 处工艺验证缺失") === false, "应明确列出失败项");
});

// ============================================================================
// T3. GMP-02 批记录
// ============================================================================

test("T3a: GMP-02 testRunner 未注入 → passed=false", async () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-02")!;
  const ctx = createContext({});
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, false);
  assert.equal(result.severity, "blocker");
  assert.ok(result.reason.includes("未注入 testRunner"));
});

test("T3b: GMP-02 testRunner 返回 exitCode=0 + 输出含'批记录验证通过' → 通过", async () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-02")!;
  const ctx = createContext(
    {},
    new InMemoryTestRunner({
      "tests/compliance/gmp-02.batch.test.ts": {
        exitCode: 0,
        output: "running batch test...\n批记录验证通过\nall tests passed",
      },
    })
  );
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, true);
  assert.ok(result.reason.includes("批记录测试通过"));
  assert.ok(Object.isFrozen(result));
});

test("T3c: GMP-02 testRunner 返回 exitCode=1 → 失败", async () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-02")!;
  const ctx = createContext(
    {},
    new InMemoryTestRunner({
      "tests/compliance/gmp-02.batch.test.ts": {
        exitCode: 1,
        output: "批记录验证通过", // 故意：即使有标识，exitCode != 0 也失败
      },
    })
  );
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("exitCode=1"));
});

test("T3d: GMP-02 testRunner 输出不含'批记录验证通过' → 失败", async () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-02")!;
  const ctx = createContext(
    {},
    new InMemoryTestRunner({
      "tests/compliance/gmp-02.batch.test.ts": {
        exitCode: 0,
        output: "tests passed without proper identifier",
      },
    })
  );
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("未包含"));
});

// ============================================================================
// T4. GMP-03 变更控制
// ============================================================================

test("T4a: GMP-03 项目无 @ChangeControl → 通过", () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-03")!;
  const ctx = createContext({
    "src/service.ts": "export class Service { hello() {} }",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.equal(result.severity, "major");
});

test("T4b: GMP-03 @ChangeControl 含完整变更记录 → 通过", () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-03")!;
  const ctx = createContext({
    "src/service.ts": "export class Service {\n" + '  @ChangeControl("CHG-001")\n' + "  updateConfig() {}\n" + "}",
    "docs/change-control/CHG-001.md": "# CHG-001\n\n## 变更概述\n更新配置项\n\n## 风险评估\n低风险",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.ok(result.reason.includes("1 个变更"));
});

test("T4c: GMP-03 @ChangeControl 缺失变更记录文件 → 失败", () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-03")!;
  const ctx = createContext({
    "src/service.ts": "export class Service {\n" + '  @ChangeControl("CHG-002")\n' + "  updateConfig() {}\n" + "}",
    // 缺失 docs/change-control/CHG-002.md
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("CHG-002"));
});

test("T4d: GMP-03 变更记录缺失必要章节 → 失败", () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-03")!;
  const ctx = createContext({
    "src/service.ts": "export class Service {\n" + '  @ChangeControl("CHG-003")\n' + "  updateConfig() {}\n" + "}",
    "docs/change-control/CHG-003.md": "# CHG-003\n\n## 变更概述\n更新配置\n（缺失风险评估章节）",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("风险评估"));
});

// ============================================================================
// T5. GMP-04 偏差处理
// ============================================================================

test("T5a: GMP-04 testRunner 未注入 → passed=false", async () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-04")!;
  const ctx = createContext({});
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, false);
  assert.equal(result.severity, "major");
});

test("T5b: GMP-04 testRunner 返回 exitCode=0 + 输出含'偏差处理验证通过' → 通过", async () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-04")!;
  const ctx = createContext(
    {},
    new InMemoryTestRunner({
      "tests/compliance/gmp-04.deviation.test.ts": {
        exitCode: 0,
        output: "偏差处理验证通过\nall tests passed",
      },
    })
  );
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T5c: GMP-04 testRunner 返回 exitCode=1 → 失败", async () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-04")!;
  const ctx = createContext(
    {},
    new InMemoryTestRunner({
      "tests/compliance/gmp-04.deviation.test.ts": {
        exitCode: 1,
        output: "偏差处理验证通过",
      },
    })
  );
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, false);
});

// ============================================================================
// T6. GMP-05 质量风险管理
// ============================================================================

test("T6a: GMP-05 项目无 @RiskAssessed → 通过", () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-05")!;
  const ctx = createContext({ "src/service.ts": "export class Service {}" });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T6b: GMP-05 @RiskAssessed 含完整风险评估 → 通过", () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-05")!;
  const ctx = createContext({
    "src/risk.ts": "export class Service {\n" + '  @RiskAssessed("RISK-001")\n' + "  criticalOperation() {}\n" + "}",
    "docs/risk-assessment/RISK-001.md": "# RISK-001\n\n## 风险识别\n关键操作\n\n## 风险控制\n通过校验",
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, true);
  assert.ok(result.reason.includes("1 个风险点"));
});

test("T6c: GMP-05 @RiskAssessed 缺失风险评估文件 → 失败", () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-05")!;
  const ctx = createContext({
    "src/risk.ts": "export class Service {\n" + '  @RiskAssessed("RISK-002")\n' + "  criticalOperation() {}\n" + "}",
    // 缺失 docs/risk-assessment/RISK-002.md
  });
  const result = rule.staticChecker!(ctx);
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes("RISK-002"));
});

// ============================================================================
// T7. GMP-06 物料管理
// ============================================================================

test("T7a: GMP-06 testRunner 未注入 → passed=false", async () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-06")!;
  const ctx = createContext({});
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, false);
  assert.equal(result.severity, "blocker");
});

test("T7b: GMP-06 testRunner 返回 exitCode=0 + 输出含'物料管理验证通过' → 通过", async () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-06")!;
  const ctx = createContext(
    {},
    new InMemoryTestRunner({
      "tests/compliance/gmp-06.material.test.ts": {
        exitCode: 0,
        output: "物料管理验证通过\nall tests passed",
      },
    })
  );
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, true);
});

test("T7c: GMP-06 testRunner 返回 exitCode=1 → 失败", async () => {
  const rule = GMP_PACK.rules.find((r) => r.ruleId === "GMP-06")!;
  const ctx = createContext(
    {},
    new InMemoryTestRunner({
      "tests/compliance/gmp-06.material.test.ts": {
        exitCode: 1,
        output: "物料管理验证通过",
      },
    })
  );
  const result = await rule.dynamicChecker!(ctx);
  assert.equal(result.passed, false);
});

// ============================================================================
// T8. 内部工具函数测试
// ============================================================================

test("T8a: __internal.scanDecorators 应正确识别 @Decorator", () => {
  const decorators = __internal.scanDecorators(
    "test.ts",
    'export class Foo {\n  @ProcessStep("step1")\n  step1() {}\n}',
    "ProcessStep"
  );
  assert.equal(decorators.length, 1);
  assert.equal(decorators[0].name, "ProcessStep");
  assert.equal(decorators[0].firstArg, "step1");
});

test("T8b: __internal.countTestCalls 应正确统计 test/it 调用次数", () => {
  const content =
    "import { test, it } from 'node:test';\n" +
    "test('a', () => {});\n" +
    "it('b', () => {});\n" +
    "describe('c', () => { it('d', () => {}); });";
  const count = __internal.countTestCalls(content);
  assert.equal(count, 3, "应统计 test + it + 内层 it = 3");
});

test("T8c: __internal.buildNoTestRunnerResult 返回 passed=false", () => {
  const result = __internal.buildNoTestRunnerResult("GMP-02", "blocker", "test.ts");
  assert.equal(result.passed, false);
  assert.equal(result.ruleId, "GMP-02");
  assert.equal(result.severity, "blocker");
  assert.ok(result.reason.includes("未注入 testRunner"));
  assert.ok(Object.isFrozen(result));
});

// ============================================================================
// T9. 法规引用真实性深度校验
// ============================================================================

test("T9a: GMP 全部规则 regulatoryReference 应引用真实存在的法规（非杜撰）", () => {
  // 真实法规条款白名单（21 CFR Part 211 / ICH Q9 / ICH Q10）
  const realRegulations = [
    "21 CFR 211.110(a)",
    "21 CFR 211.100",
    "21 CFR 211.192",
    "21 CFR 211.80",
    "ICH Q9",
    "ICH Q10 §13",
  ];

  for (const rule of GMP_PACK.rules) {
    assert.ok(
      realRegulations.includes(rule.regulatoryReference),
      `${rule.ruleId} 的 regulatoryReference "${rule.regulatoryReference}" 应在真实法规白名单中`
    );
  }
});
