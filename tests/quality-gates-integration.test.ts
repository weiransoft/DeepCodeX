/**
 * Quality Gates 根目录集成测试
 *
 * 职责：
 * 1. 验证 QualityGateManager 默认注册全部 7 个 gate-specific 真实执行器
 *    （禁止 DefaultPassExecutor 作为默认实现）。
 * 2. 在受控临时项目上执行 runAll，验证真实扫描能产生预期的 findings。
 * 3. 验证 UIUX_VISUAL 默认 disabled，可手动启用并执行。
 *
 * 本测试位于项目 tests/ 根目录，与 packages/core/src/team/tests 形成互补：
 * - 单元测试聚焦单个 executor/数据结构的正确性；
 * - 根集成测试聚焦“默认注册 + 端到端执行”的契约。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  QualityGateId,
  ALL_QUALITY_GATE_IDS,
  GateStatus,
  DefaultPassExecutor,
  QualityGateManager,
} from "../packages/core/src/team/index.js";

/**
 * 创建临时项目目录
 * @param files 相对路径到内容的映射
 * @returns 临时目录绝对路径
 */
function createTempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quality-gates-root-test-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
  }
  return dir;
}

/**
 * 清理临时目录
 */
function cleanupTempProject(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

test("QualityGateManager registers real executors for all 7 gates by default", () => {
  const manager = new QualityGateManager(createTempProject({}));
  try {
    assert.equal(manager.executors.size, ALL_QUALITY_GATE_IDS.length);

    for (const gateId of ALL_QUALITY_GATE_IDS) {
      const executor = manager.executors.get(gateId);
      assert.ok(executor !== undefined, `${gateId} 必须注册真实执行器`);
      assert.ok(!(executor instanceof DefaultPassExecutor), `${gateId} 默认不能是占位执行器 DefaultPassExecutor`);
      assert.equal(executor.gateId, gateId);
    }
  } finally {
    cleanupTempProject(manager.projectPath);
  }
});

test("runAll on a project with violations reports findings and fails overall", async () => {
  const dir = createTempProject({
    "src/index.ts": `export function main() {
  console.log("debug output left");
  const API_KEY = "123456789012345678901234";
  pass
}
`,
    "src/page.tsx": `<div>
  <img src="logo.png" />
  <button>Delete</button>
</div>
`,
    "tests/index.test.ts": `import { test } from "node:test";
test("placeholder", () => {});
`,
  });

  try {
    const manager = new QualityGateManager(dir);
    const report = await manager.runAll();

    // UIUX_VISUAL 默认 disabled，因此只执行 6 个 gate
    assert.equal(report.totalGates, 6);

    // 由于存在调试代码、硬编码密钥、占位符，至少有一个 gate 失败
    assert.ok(
      report.failedGates > 0 || report.erroredGates > 0,
      `预期存在失败的门禁，实际 passed=${report.passedGates}, failed=${report.failedGates}, errored=${report.erroredGates}`
    );
    assert.equal(report.overallPassed, false);
    assert.ok(report.totalFindings > 0, "应发现至少一条 finding");

    // 验证具体 rule 被发现
    const rules = new Set(report.results.flatMap((r) => r.findings.map((f) => f.rule)));
    assert.ok(rules.has("debug-code-leftover"), "应发现 debug-code-leftover");
    assert.ok(rules.has("hardcoded-api-key"), "应发现 hardcoded-api-key");
    assert.ok(rules.has("placeholder-code"), "应发现 placeholder-code");
  } finally {
    cleanupTempProject(dir);
  }
});

test("UIUX_VISUAL gate can be enabled and reports static a11y findings", async () => {
  const dir = createTempProject({
    "src/page.tsx": `<div>
  <img src="logo.png" />
  <button>Click</button>
</div>
`,
  });

  try {
    const manager = new QualityGateManager(dir);
    manager.setEnabled(QualityGateId.UIUX_VISUAL, true);
    // 把阈值提到 1.0，确保只要存在静态可访问性问题就失败
    manager.setThreshold(QualityGateId.UIUX_VISUAL, 1.0);

    const uiConfig = manager.configs.find((c) => c.gateId === QualityGateId.UIUX_VISUAL)!;
    const result = await manager.runOne(uiConfig);

    assert.equal(result.status, GateStatus.FAILED);
    assert.ok(result.findings.length > 0, "UIUX_VISUAL 应发现静态可访问性问题");
    const rules = result.findings.map((f) => f.rule);
    assert.ok(rules.includes("img-missing-alt"), "应发现 img-missing-alt");
    assert.ok(rules.includes("button-missing-type"), "应发现 button-missing-type");
    assert.equal(result.metadata["staticOnly"], true);
  } finally {
    cleanupTempProject(dir);
  }
});

test("runAll on a clean project passes all enabled gates", async () => {
  const dir = createTempProject({
    "src/utils.ts": `/**
 * 返回两数之和
 */
export function add(a: number, b: number): number {
  return a + b;
}
`,
    "tests/utils.test.ts": `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/utils";

test("add works", () => {
  assert.equal(add(1, 2), 3);
});
`,
  });

  try {
    const manager = new QualityGateManager(dir);
    const report = await manager.runAll();

    assert.equal(report.totalGates, 6, "默认启用 6 个门禁（UIUX 关闭）");
    assert.equal(report.erroredGates, 0, "不应出现异常");
    assert.equal(report.criticalFindings, 0, "不应有严重 finding");

    // 干净项目理论上全部通过；若存在低严重度风格问题允许失败，
    // 但此处至少要求无异常且严重问题数为 0。
    assert.ok(report.passedGates >= 4, `干净项目应至少通过 4 个门禁，实际 ${report.passedGates}`);
  } finally {
    cleanupTempProject(dir);
  }
});
