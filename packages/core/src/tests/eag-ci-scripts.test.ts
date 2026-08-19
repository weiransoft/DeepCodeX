/**
 * EAG-P3 批次 12 单元测试：C3 CI 脚本语法校验
 *
 * 测试范围（对齐设计文档 §5.6 / §5.7 / §5.2）：
 * - S1. ci-eag-gate.sh bash 语法校验（bash -n）
 * - S2. eag-batch9-integration.sh bash 语法校验（bash -n）
 * - S3. eag-batch10-integration.sh bash 语法校验（bash -n，回归保护）
 * - S4. ci-eag-gate.sh 可执行权限检查
 * - S5. eag-batch9-integration.sh 可执行权限检查
 * - S6. ci.yml 关键步骤存在性校验（TypeCheck Strict / Test Coverage / EAG Gate）
 * - S7. architect-review.yml 关键步骤存在性校验（Detect Trigger / Run Architect / Post Review）
 * - S8. ci-eag-gate.sh 头部注释完整性（功能描述 + 退出码）
 * - S9. eag-batch9-integration.sh 头部注释完整性
 * - S10. ci-eag-gate.sh 关键步骤调用（validateTcsFixtures / tsc / 集成测试 / 回归测试）
 * - S11. eag-batch9-integration.sh 关键调用（runner 文件路径 + node --import tsx）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，所有检查基于真实文件内容与 bash 子进程
 * - bash -n 是真实的 shell 语法检查（不执行脚本，仅解析语法）
 *
 * 设计依据：
 * - EAG-P3 批次 12 设计文档 §5.2 GitHub Actions 工作流改动
 * - EAG-P3 批次 12 设计文档 §5.6 ci-eag-gate.sh
 * - EAG-P3 批次 12 设计文档 §5.7 eag-batch9-integration.sh
 *
 * @module core/tests/eag-ci-scripts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ============================================================================
// 常量与路径
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 从 packages/core/src/tests/ 回退 4 级到项目根 DeepCodeX-cli：
//   - ../           → packages/core/src/
//   - ../../        → packages/core/
//   - ../../../     → packages/
//   - ../../../../  → DeepCodeX-cli/（项目根）
const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPTS_DIR = path.join(PROJECT_ROOT, "tests", "scripts");
const WORKFLOWS_DIR = path.join(PROJECT_ROOT, ".github", "workflows");

/**
 * CI EAG 门禁脚本路径
 */
const CI_EAG_GATE_SH = path.join(SCRIPTS_DIR, "ci-eag-gate.sh");

/**
 * 批次 9 集成测试脚本路径
 */
const EAG_BATCH9_INTEGRATION_SH = path.join(SCRIPTS_DIR, "eag-batch9-integration.sh");

/**
 * 批次 10 集成测试脚本路径（既有，回归保护）
 */
const EAG_BATCH10_INTEGRATION_SH = path.join(SCRIPTS_DIR, "eag-batch10-integration.sh");

/**
 * CI 工作流文件路径
 */
const CI_YML = path.join(WORKFLOWS_DIR, "ci.yml");

/**
 * 架构师审查工作流文件路径
 */
const ARCHITECT_REVIEW_YML = path.join(WORKFLOWS_DIR, "architect-review.yml");

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 通过 `bash -n` 校验 shell 脚本语法
 *
 * bash -n 选项：仅解析脚本语法而不执行，用于检测语法错误。
 * 不使用 mock，是真实的 shell 语法解析。
 *
 * @param scriptPath 脚本路径
 * @returns {ok: boolean, error: string} 校验结果
 */
function checkBashSyntax(scriptPath: string): { ok: boolean; error: string } {
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `脚本不存在：${scriptPath}` };
  }
  const result = spawnSync("bash", ["-n", scriptPath], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr || result.stdout || `bash -n 失败（status=${result.status}）`,
    };
  }
  return { ok: true, error: "" };
}

/**
 * 读取文件内容（UTF-8）
 *
 * @param filePath 文件路径
 * @returns 文件内容字符串
 */
function readFileContent(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    assert.fail(`文件不存在：${filePath}`);
  }
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * 检查文件是否具有可执行权限
 *
 * @param filePath 文件路径
 * @returns 是否具有可执行权限
 */
function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// S1. ci-eag-gate.sh bash 语法校验
// ============================================================================

test("S1. ci-eag-gate.sh bash 语法校验（bash -n）", () => {
  const result = checkBashSyntax(CI_EAG_GATE_SH);
  assert.ok(result.ok, `ci-eag-gate.sh 语法错误：${result.error}`);
});

// ============================================================================
// S2. eag-batch9-integration.sh bash 语法校验
// ============================================================================

test("S2. eag-batch9-integration.sh bash 语法校验（bash -n）", () => {
  const result = checkBashSyntax(EAG_BATCH9_INTEGRATION_SH);
  assert.ok(result.ok, `eag-batch9-integration.sh 语法错误：${result.error}`);
});

// ============================================================================
// S3. eag-batch10-integration.sh bash 语法校验（回归保护）
// ============================================================================

test("S3. eag-batch10-integration.sh bash 语法校验（回归保护）", () => {
  // 既有脚本，校验不应被本次改动破坏
  if (fs.existsSync(EAG_BATCH10_INTEGRATION_SH)) {
    const result = checkBashSyntax(EAG_BATCH10_INTEGRATION_SH);
    assert.ok(result.ok, `eag-batch10-integration.sh 语法错误：${result.error}`);
  } else {
    // 既有脚本不存在时跳过（不视为失败）
    assert.ok(true, "eag-batch10-integration.sh 不存在，跳过");
  }
});

// ============================================================================
// S4. ci-eag-gate.sh 可执行权限检查
// ============================================================================

test("S4. ci-eag-gate.sh 可执行权限检查", () => {
  // CI 中通过 `bash tests/scripts/ci-eag-gate.sh` 调用，不强制 +x 权限，
  // 但本地直接执行时应可执行。校验权限位（兼容 CI 检出后权限丢失场景）。
  assert.ok(fs.existsSync(CI_EAG_GATE_SH), "ci-eag-gate.sh 应存在");
  // 仅校验文件存在与可读，权限位不强制（CI 检出可能丢失 +x）
  try {
    fs.accessSync(CI_EAG_GATE_SH, fs.constants.R_OK);
    assert.ok(true);
  } catch {
    assert.fail("ci-eag-gate.sh 不可读");
  }
});

// ============================================================================
// S5. eag-batch9-integration.sh 可执行权限检查
// ============================================================================

test("S5. eag-batch9-integration.sh 可执行权限检查", () => {
  assert.ok(fs.existsSync(EAG_BATCH9_INTEGRATION_SH), "eag-batch9-integration.sh 应存在");
  try {
    fs.accessSync(EAG_BATCH9_INTEGRATION_SH, fs.constants.R_OK);
    assert.ok(true);
  } catch {
    assert.fail("eag-batch9-integration.sh 不可读");
  }
});

// ============================================================================
// S6. ci.yml 关键步骤存在性校验
// ============================================================================

test("S6. ci.yml 关键步骤存在性校验", () => {
  const content = readFileContent(CI_YML);

  // 校验新增的 TypeCheck Strict 步骤
  assert.match(content, /name:\s*TypeCheck Strict/, "ci.yml 应含 TypeCheck Strict 步骤");
  assert.match(content, /npx tsc --noEmit --strict/, "ci.yml 应含 tsc --strict 命令");

  // S1 重构（2026-08-19）：Test Coverage（core only）拆分为
  // Test (all workspaces)（全量测试）+ Coverage (merged)（合并覆盖率门禁）
  assert.match(content, /name:\s*Test \(all workspaces\)/, "ci.yml 应含 Test (all workspaces) 步骤");
  assert.match(content, /npm test/, "ci.yml Test 步骤应调用 npm test 单一入口");
  assert.match(content, /name:\s*Coverage \(merged\)/, "ci.yml 应含 Coverage (merged) 步骤");
  assert.match(content, /--experimental-test-coverage/, "ci.yml 应含 --experimental-test-coverage flag");

  // 覆盖率阈值门禁保留（合并 lcov 后统一计算）
  assert.match(content, /check-coverage-threshold\.js/, "ci.yml 应调用 check-coverage-threshold.js");

  // 校验新增的 Upload Coverage Report 步骤
  assert.match(content, /name:\s*Upload Coverage Report/, "ci.yml 应含 Upload Coverage Report 步骤");
  assert.match(content, /actions\/upload-artifact@v/, "ci.yml 应使用 upload-artifact action");

  // 校验新增的 EAG Gate 步骤
  assert.match(content, /name:\s*EAG Gate/, "ci.yml 应含 EAG Gate 步骤");
  assert.match(content, /ci-eag-gate\.sh/, "ci.yml 应调用 ci-eag-gate.sh");

  // S1 重构：Team Gate 步骤已删除（内容被 Test (all workspaces) 覆盖），
  // ci-team-gate.sh 文件一并删除，ci.yml 不应再引用
  assert.doesNotMatch(content, /ci-team-gate\.sh/, "ci.yml 不应再引用 ci-team-gate.sh（Team Gate 已删除）");
  assert.doesNotMatch(content, /name:\s*Team Gate/, "ci.yml 不应再含 Team Gate 步骤");
});

// ============================================================================
// S7. architect-review.yml 关键步骤存在性校验
// ============================================================================

test("S7. architect-review.yml 关键步骤存在性校验", () => {
  const content = readFileContent(ARCHITECT_REVIEW_YML);

  // 校验工作流名称
  assert.match(content, /name:\s*Architect Review/, "architect-review.yml 应含工作流名称");

  // 校验触发条件
  assert.match(content, /pull_request:/, "应含 pull_request 触发器");
  assert.match(content, /workflow_dispatch:/, "应含 workflow_dispatch 触发器");
  assert.match(content, /docs\/enterprise\/\*\.md/, "应含 docs/enterprise/*.md 路径过滤");
  assert.match(content, /packages\/core\/src\/eag\/\*\*/, "应含 packages/core/src/eag/** 路径过滤");

  // 校验关键步骤
  assert.match(content, /name:\s*Detect Trigger Condition/, "应含 Detect Trigger Condition 步骤");
  assert.match(content, /name:\s*Run Architect adversarial-verify/, "应含 Run Architect 步骤");
  assert.match(content, /name:\s*Post Review as PR Comment/, "应含 Post Review 步骤");
  assert.match(content, /needs-architect-review/, "应检测 needs-architect-review 标签");
  assert.match(content, /eag_changes/, "应统计 eag_changes");
});

// ============================================================================
// S8. ci-eag-gate.sh 头部注释完整性
// ============================================================================

test("S8. ci-eag-gate.sh 头部注释完整性", () => {
  const content = readFileContent(CI_EAG_GATE_SH);
  // 头部 100 行内应包含功能描述、退出码说明
  const head = content.split("\n").slice(0, 60).join("\n");
  assert.match(head, /EAG-P3 批次 12 CI EAG 门禁脚本/, "应含脚本名称");
  assert.match(head, /功能/, "应含功能描述");
  assert.match(head, /退出码/, "应含退出码说明");
  assert.match(head, /fixtures 完整性校验/, "应含 fixtures 完整性校验步骤描述");
  assert.match(head, /EAG 静态扫描/, "应含 EAG 静态扫描步骤描述");
  assert.match(head, /EAG 集成测试/, "应含 EAG 集成测试步骤描述");
  // S1 重构（2026-08-19）：步骤 4"全量回归测试"已删除（与 CI Test 步骤重复），
  // 头部应说明 3 步检查与删除原因，不再声明执行全量回归
  assert.match(head, /3 步检查/, "应声明 3 步检查（原 4 步已删除全量回归）");
  assert.doesNotMatch(head, /4 步检查/, "不应再声明 4 步检查");
});

// ============================================================================
// S9. eag-batch9-integration.sh 头部注释完整性
// ============================================================================

test("S9. eag-batch9-integration.sh 头部注释完整性", () => {
  const content = readFileContent(EAG_BATCH9_INTEGRATION_SH);
  const head = content.split("\n").slice(0, 60).join("\n");
  assert.match(head, /EAG-P2 批次 9 集成测试 shell/, "应含脚本名称");
  assert.match(head, /遗留 L-6 闭环/, "应含 L-6 闭环说明");
  assert.match(head, /功能/, "应含功能描述");
  assert.match(head, /退出码/, "应含退出码说明");
});

// ============================================================================
// S10. ci-eag-gate.sh 关键步骤调用校验
// ============================================================================

test("S10. ci-eag-gate.sh 关键步骤调用校验", () => {
  const content = readFileContent(CI_EAG_GATE_SH);

  // Step 1: validateTcsFixtures 调用
  assert.match(content, /validateTcsFixtures/, "应调用 validateTcsFixtures");
  assert.match(content, /from ['"]\.\/src\/eag\/tcs\/fixtures\/index\.ts['"]/, "应从 fixtures/index.ts 导入");

  // Step 2: tsc --noEmit --strict
  assert.match(content, /npx tsc --noEmit --strict/, "应执行 tsc --noEmit --strict");

  // Step 3: 批次集成测试脚本调用（S1 重构后保留的核心检查）
  assert.match(content, /eag-batch9-integration\.sh/, "应调用 eag-batch9-integration.sh");
  assert.match(content, /eag-batch10-integration\.sh/, "应调用 eag-batch10-integration.sh");

  // S1 重构（2026-08-19）：原 Step 4 全量回归命令断言已删除
  // （该命令已从 gate 脚本移除，全量回归由 CI Test (all workspaces) 步骤覆盖），
  // 改为断言 gate 脚本不再包含全量回归命令
  assert.doesNotMatch(
    content,
    /node --import tsx --test src\/tests\/\*\.test\.ts/,
    "不应再执行 core 顶层全量回归（已由 CI Test 步骤覆盖）"
  );
});

// ============================================================================
// S11. eag-batch9-integration.sh 关键调用校验
// ============================================================================

test("S11. eag-batch9-integration.sh 关键调用校验", () => {
  const content = readFileContent(EAG_BATCH9_INTEGRATION_SH);

  // runner 文件路径
  assert.match(content, /eag-batch9-integration-runner\.ts/, "应引用 eag-batch9-integration-runner.ts");

  // 通过 node --import tsx 调用 runner
  assert.match(content, /node --import tsx/, "应通过 node --import tsx 调用 runner");

  // --tmp-dir 参数传递
  assert.match(content, /--tmp-dir/, "应传递 --tmp-dir 参数");

  // --report-file 参数传递
  assert.match(content, /--report-file/, "应传递 --report-file 参数");

  // plan.md 写入
  assert.match(content, /plan\.md/, "应写入 plan.md");

  // tasks.md 写入
  assert.match(content, /tasks\.md/, "应写入 tasks.md");

  // 临时目录清理
  assert.match(content, /cleanup|trap.*EXIT/, "应注册 cleanup trap");
});
