/**
 * 质量门禁真实执行器单元测试
 *
 * 覆盖 packages/core/src/team/principles/quality-gate-executors.ts 中的 7 个真实执行器：
 * - CodeReviewExecutor
 * - TestCoverageExecutor
 * - SpecComplianceExecutor
 * - SecurityScanExecutor
 * - PonytailRedlineExecutor
 * - KarpathyPrinciplesExecutor
 * - UIUXVisualExecutor
 *
 * 每个 executor 至少覆盖：
 * - 通过路径（干净源码，score 接近 1.0）
 * - 失败路径（触发典型 findings，score 下降）
 * - 边界条件（配置开关、测试文件跳过等）
 *
 * 测试使用临时目录写入受控源码，直接调用 executor.execute(projectPath, config)，
 * 不依赖真实 LLM、不依赖生产数据库、不 mock 源码扫描行为。
 *
 * 严格遵循 user rules：禁止 mock/占位/简化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CodeReviewExecutor,
  TestCoverageExecutor,
  SpecComplianceExecutor,
  SecurityScanExecutor,
  PonytailRedlineExecutor,
  KarpathyPrinciplesExecutor,
  UIUXVisualExecutor,
} from "../../principles/quality-gate-executors.js";
import {
  QualityGateId,
  createQualityGateConfig,
  type QualityGateConfig,
} from "../../principles/quality-gate-common.js";

// ============================================================================
// 测试辅助函数
// ============================================================================

/**
 * 创建临时项目目录，并写入若干受控文件
 *
 * @param files 相对路径 → 内容的映射
 * @returns 临时项目根目录绝对路径
 */
function createTempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quality-gate-executor-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf-8");
  }
  return dir;
}

/**
 * 清理临时项目目录
 */
function cleanupTempProject(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * 创建指定 gateId 的测试用配置
 */
function createTestConfig(
  gateId: keyof typeof QualityGateId,
  overrides: Partial<QualityGateConfig> = {}
): QualityGateConfig {
  return createQualityGateConfig({
    gateId: QualityGateId[gateId],
    name: "测试",
    description: "测试配置",
    threshold: 1.0,
    ...overrides,
  });
}

// ============================================================================
// CodeReviewExecutor
// ============================================================================

test("CodeReviewExecutor：干净源码通过", async () => {
  const dir = createTempProject({
    "src/index.ts": `// 加法函数\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    "tests/index.test.ts": `import { test } from "node:test";\nimport { add } from "../src/index.js";\ntest("add", () => {\n  console.log("running");\n});\n`,
  });
  try {
    const executor = new CodeReviewExecutor();
    const result = await executor.execute(dir, createTestConfig("CODE_REVIEW"));
    assert.equal(result.score, 1.0);
    assert.equal(result.findings.length, 0);
    assert.equal(result.metadata["executor"], "code-review");
  } finally {
    cleanupTempProject(dir);
  }
});

test("CodeReviewExecutor：调试代码残留导致 findings", async () => {
  const dir = createTempProject({
    "src/index.ts": `export function add(a: number, b: number): number {\n  console.log("debug", a, b);\n  debugger;\n  return a + b;\n}\n`,
  });
  try {
    const executor = new CodeReviewExecutor();
    const result = await executor.execute(dir, createTestConfig("CODE_REVIEW"));
    assert.ok(result.score < 1.0);
    assert.ok(result.findings.some((f) => f.rule === "debug-code-leftover"));
  } finally {
    cleanupTempProject(dir);
  }
});

test("CodeReviewExecutor：未实现 TODO 导致 findings", async () => {
  const dir = createTempProject({
    "src/index.ts": `// TODO: 待实现\nexport function compute(): number {\n  return 0;\n}\n`,
  });
  try {
    const executor = new CodeReviewExecutor();
    const result = await executor.execute(dir, createTestConfig("CODE_REVIEW"));
    assert.ok(result.findings.some((f) => f.rule === "todo-without-implementation"));
  } finally {
    cleanupTempProject(dir);
  }
});

test("CodeReviewExecutor：过长函数导致 findings", async () => {
  const longFunction = `export function longFn(): number {\n${Array.from({ length: 100 }, (_, i) => `  const x${i} = ${i};`).join("\n")}\n  return x0;\n}\n`;
  const dir = createTempProject({ "src/index.ts": longFunction });
  try {
    const executor = new CodeReviewExecutor();
    const result = await executor.execute(dir, createTestConfig("CODE_REVIEW", { params: { maxFunctionLines: 20 } }));
    assert.ok(result.findings.some((f) => f.rule === "function-too-long"));
  } finally {
    cleanupTempProject(dir);
  }
});

// ============================================================================
// TestCoverageExecutor
// ============================================================================

test("TestCoverageExecutor：有真实 lcov 报告时按报告评分", async () => {
  const dir = createTempProject({
    "coverage/lcov.info": `TN:\nSF:src/index.ts\nFN:1,add\nFNDA:1,add\nDA:2,1\nDA:3,1\nLF:2\nLH:2\nend_of_record\n`,
    "src/index.ts": `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
  });
  try {
    const executor = new TestCoverageExecutor();
    const result = await executor.execute(
      dir,
      createTestConfig("TEST_COVERAGE", { threshold: 0.8, params: { lineThreshold: 0.8 } })
    );
    assert.equal(result.score, 1.0);
    assert.equal(result.findings.length, 0);
    assert.equal(result.metadata["coverageSource"], "lcov");
  } finally {
    cleanupTempProject(dir);
  }
});

test("TestCoverageExecutor：lcov 覆盖率低于阈值产生 finding", async () => {
  const dir = createTempProject({
    "coverage/lcov.info": `TN:\nSF:src/index.ts\nDA:2,1\nDA:3,0\nLF:2\nLH:1\nend_of_record\n`,
    "src/index.ts": `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
  });
  try {
    const executor = new TestCoverageExecutor();
    const result = await executor.execute(
      dir,
      createTestConfig("TEST_COVERAGE", { threshold: 0.9, params: { lineThreshold: 0.9 } })
    );
    assert.equal(result.score, 0.5);
    assert.ok(result.findings.some((f) => f.rule === "coverage-below-threshold"));
  } finally {
    cleanupTempProject(dir);
  }
});

test("TestCoverageExecutor：无 lcov 时按代理指标评分", async () => {
  const dir = createTempProject({
    "src/index.ts": `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    "tests/index.test.ts": `import { test } from "node:test";\ntest("add", () => {});\n`,
  });
  try {
    const executor = new TestCoverageExecutor();
    const result = await executor.execute(
      dir,
      createTestConfig("TEST_COVERAGE", { threshold: 0.8, params: { lineThreshold: 0.8 } })
    );
    assert.equal(result.score, 1.0);
    assert.equal(result.metadata["coverageSource"], "proxy");
  } finally {
    cleanupTempProject(dir);
  }
});

test("TestCoverageExecutor：无 lcov 且测试不足时产生 finding", async () => {
  const dir = createTempProject({
    "src/index.ts": `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    "src/helper.ts": `export function help(): void {}\n`,
  });
  try {
    const executor = new TestCoverageExecutor();
    const result = await executor.execute(
      dir,
      createTestConfig("TEST_COVERAGE", { threshold: 0.8, params: { lineThreshold: 0.8 } })
    );
    assert.ok(result.score < 1.0);
    assert.ok(result.findings.some((f) => f.rule === "test-coverage-proxy-low"));
  } finally {
    cleanupTempProject(dir);
  }
});

// ============================================================================
// SpecComplianceExecutor
// ============================================================================

test("SpecComplianceExecutor：干净且符合命名规范的源码通过", async () => {
  const dir = createTempProject({
    "src/my-util.ts": `// 工具函数\nexport function helper(): string {\n  return "ok";\n}\n`,
  });
  try {
    const executor = new SpecComplianceExecutor();
    const result = await executor.execute(dir, createTestConfig("SPEC_COMPLIANCE"));
    assert.equal(result.score, 1.0);
    assert.equal(result.findings.length, 0);
  } finally {
    cleanupTempProject(dir);
  }
});

test("SpecComplianceExecutor：命名不规范产生 finding", async () => {
  const dir = createTempProject({
    "src/MyUtil.ts": `export function helper(): string {\n  return "ok";\n}\n`,
  });
  try {
    const executor = new SpecComplianceExecutor();
    const result = await executor.execute(dir, createTestConfig("SPEC_COMPLIANCE"));
    assert.ok(result.findings.some((f) => f.rule === "naming-convention-violation"));
  } finally {
    cleanupTempProject(dir);
  }
});

test("SpecComplianceExecutor：缺少中文注释产生 finding", async () => {
  const dir = createTempProject({
    "src/my-util.ts": `export function helper(): string {\n  return "ok";\n}\n`,
  });
  try {
    const executor = new SpecComplianceExecutor();
    const result = await executor.execute(dir, createTestConfig("SPEC_COMPLIANCE"));
    assert.ok(result.findings.some((f) => f.rule === "missing-chinese-comment"));
  } finally {
    cleanupTempProject(dir);
  }
});

test("SpecComplianceExecutor：占位符代码产生 finding", async () => {
  const dir = createTempProject({
    "src/my-util.ts": `// 工具函数\nexport function helper(): void {\n  pass;\n}\n`,
  });
  try {
    const executor = new SpecComplianceExecutor();
    const result = await executor.execute(dir, createTestConfig("SPEC_COMPLIANCE"));
    assert.ok(result.findings.some((f) => f.rule === "placeholder-code"));
  } finally {
    cleanupTempProject(dir);
  }
});

test("SpecComplianceExecutor：可禁用中文注释检查", async () => {
  const dir = createTempProject({
    "src/my-util.ts": `export function helper(): string {\n  return "ok";\n}\n`,
  });
  try {
    const executor = new SpecComplianceExecutor();
    const result = await executor.execute(
      dir,
      createTestConfig("SPEC_COMPLIANCE", { params: { requireZhComments: false } })
    );
    assert.ok(!result.findings.some((f) => f.rule === "missing-chinese-comment"));
  } finally {
    cleanupTempProject(dir);
  }
});

// ============================================================================
// SecurityScanExecutor
// ============================================================================

test("SecurityScanExecutor：干净源码通过", async () => {
  const dir = createTempProject({
    "src/index.ts": `export function greet(name: string): string {\n  return \`Hello \${name}\`;\n}\n`,
  });
  try {
    const executor = new SecurityScanExecutor();
    const result = await executor.execute(dir, createTestConfig("SECURITY_SCAN"));
    assert.equal(result.score, 1.0);
    assert.equal(result.findings.length, 0);
  } finally {
    cleanupTempProject(dir);
  }
});

test("SecurityScanExecutor：硬编码密钥产生 finding", async () => {
  const dir = createTempProject({
    "src/config.ts": `export const apiKey = "sk-1234567890abcdef";\nexport const password = "supersecret";\n`,
  });
  try {
    const executor = new SecurityScanExecutor();
    const result = await executor.execute(dir, createTestConfig("SECURITY_SCAN"));
    assert.ok(result.findings.some((f) => f.rule === "hardcoded-api-key"));
    assert.ok(result.findings.some((f) => f.rule === "hardcoded-password"));
  } finally {
    cleanupTempProject(dir);
  }
});

test("SecurityScanExecutor：eval 与 innerHTML 产生 finding", async () => {
  const dir = createTempProject({
    "src/index.ts": `export function run(userInput: string): unknown {\n  return eval(userInput);\n}\nexport function render(html: string): void {\n  document.body.innerHTML = html;\n}\n`,
  });
  try {
    const executor = new SecurityScanExecutor();
    const result = await executor.execute(dir, createTestConfig("SECURITY_SCAN"));
    assert.ok(result.findings.some((f) => f.rule === "dangerous-eval"));
    assert.ok(result.findings.some((f) => f.rule === "unsafe-innerHTML"));
  } finally {
    cleanupTempProject(dir);
  }
});

test("SecurityScanExecutor：可禁用密钥扫描", async () => {
  const dir = createTempProject({
    "src/config.ts": `export const apiKey = "sk-1234567890abcdef";\n`,
  });
  try {
    const executor = new SecurityScanExecutor();
    const result = await executor.execute(dir, createTestConfig("SECURITY_SCAN", { params: { secretScan: false } }));
    assert.ok(!result.findings.some((f) => f.rule === "hardcoded-api-key"));
  } finally {
    cleanupTempProject(dir);
  }
});

// ============================================================================
// PonytailRedlineExecutor
// ============================================================================

test("PonytailRedlineExecutor：干净源码通过", async () => {
  const dir = createTempProject({
    "src/index.ts": `// 真实加法实现\nexport function add(a: number, b: number): number {\n  if (typeof a !== "number" || typeof b !== "number") {\n    throw new TypeError("invalid input");\n  }\n  return a + b;\n}\n`,
  });
  try {
    const executor = new PonytailRedlineExecutor();
    const result = await executor.execute(dir, createTestConfig("PONYTAIL_REDLINES"));
    assert.equal(result.score, 1.0);
    assert.equal(result.findings.length, 0);
  } finally {
    cleanupTempProject(dir);
  }
});

test("PonytailRedlineExecutor：吞异常产生 finding", async () => {
  const dir = createTempProject({
    "src/index.ts": `export function risky(): void {\n  try {\n    doSomething();\n  } catch (e) {\n    // ignore\n  }\n}\n`,
  });
  try {
    const executor = new PonytailRedlineExecutor();
    const result = await executor.execute(dir, createTestConfig("PONYTAIL_REDLINES"));
    assert.ok(result.findings.some((f) => f.rule === "swallow-exceptions"));
  } finally {
    cleanupTempProject(dir);
  }
});

test("PonytailRedlineExecutor：mock/占位产生 finding", async () => {
  const dir = createTempProject({
    "src/index.ts": `export function compute(): number {\n  // TODO implement\n  return 0;\n}\n`,
  });
  try {
    const executor = new PonytailRedlineExecutor();
    const result = await executor.execute(dir, createTestConfig("PONYTAIL_REDLINES"));
    assert.ok(result.findings.some((f) => f.rule === "mock-placeholder"));
  } finally {
    cleanupTempProject(dir);
  }
});

// ============================================================================
// KarpathyPrinciplesExecutor
// ============================================================================

test("KarpathyPrinciplesExecutor：干净小项目通过", async () => {
  const dir = createTempProject({
    "src/index.ts": `// 返回两数之和\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n`,
  });
  try {
    const executor = new KarpathyPrinciplesExecutor();
    const result = await executor.execute(dir, createTestConfig("KARPATHY_PRINCIPLES"));
    assert.equal(result.score, 1.0);
    assert.equal(result.findings.length, 0);
    assert.equal(result.metadata["executor"], "karpathy-principles");
  } finally {
    cleanupTempProject(dir);
  }
});

test("KarpathyPrinciplesExecutor：空项目不产生异常", async () => {
  const dir = createTempProject({});
  try {
    const executor = new KarpathyPrinciplesExecutor();
    const result = await executor.execute(dir, createTestConfig("KARPATHY_PRINCIPLES"));
    assert.equal(result.score, 1.0);
    assert.equal(result.findings.length, 0);
  } finally {
    cleanupTempProject(dir);
  }
});

// ============================================================================
// UIUXVisualExecutor
// ============================================================================

test("UIUXVisualExecutor：干净 UI 文件通过", async () => {
  const dir = createTempProject({
    "src/Avatar.tsx": `export function Avatar({ src, alt }: { src: string; alt: string }) {\n  return <img src={src} alt={alt} />;\n}\n`,
  });
  try {
    const executor = new UIUXVisualExecutor();
    const result = await executor.execute(dir, createTestConfig("UIUX_VISUAL"));
    assert.equal(result.score, 1.0);
    assert.equal(result.findings.length, 0);
    assert.equal(result.metadata["staticOnly"], true);
  } finally {
    cleanupTempProject(dir);
  }
});

test("UIUXVisualExecutor：img 缺少 alt 产生 finding", async () => {
  const dir = createTempProject({
    "src/Avatar.tsx": `export function Avatar({ src }: { src: string }) {\n  return <img src={src} />;\n}\n`,
  });
  try {
    const executor = new UIUXVisualExecutor();
    const result = await executor.execute(dir, createTestConfig("UIUX_VISUAL"));
    assert.ok(result.findings.some((f) => f.rule === "img-missing-alt"));
  } finally {
    cleanupTempProject(dir);
  }
});

test("UIUXVisualExecutor：input 缺少 label 产生 finding", async () => {
  const dir = createTempProject({
    "src/Form.tsx": `export function Form() {\n  return <input type="text" name="email" />;\n}\n`,
  });
  try {
    const executor = new UIUXVisualExecutor();
    const result = await executor.execute(dir, createTestConfig("UIUX_VISUAL"));
    assert.ok(result.findings.some((f) => f.rule === "input-missing-label"));
  } finally {
    cleanupTempProject(dir);
  }
});

test("UIUXVisualExecutor：可点击 div 缺少键盘支持产生 finding", async () => {
  const dir = createTempProject({
    "src/Card.tsx": `export function Card({ onClick }: { onClick: () => void }) {\n  return <div onClick={onClick}>Click me</div>;\n}\n`,
  });
  try {
    const executor = new UIUXVisualExecutor();
    const result = await executor.execute(dir, createTestConfig("UIUX_VISUAL"));
    assert.ok(result.findings.some((f) => f.rule === "clickable-div-no-keyboard"));
  } finally {
    cleanupTempProject(dir);
  }
});

test("UIUXVisualExecutor：可禁用部分审计维度", async () => {
  const dir = createTempProject({
    "src/Avatar.tsx": `export function Avatar({ src }: { src: string }) {\n  return <img src={src} />;\n}\n`,
  });
  try {
    const executor = new UIUXVisualExecutor();
    const result = await executor.execute(
      dir,
      createTestConfig("UIUX_VISUAL", { params: { auditDimensions: ["interaction"] } })
    );
    assert.ok(!result.findings.some((f) => f.rule === "img-missing-alt"));
  } finally {
    cleanupTempProject(dir);
  }
});
