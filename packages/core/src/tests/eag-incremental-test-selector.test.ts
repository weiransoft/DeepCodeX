/**
 * EAG-P3 批次 11 单元测试：IncrementalTestSelector 编排器（§8.7）
 *
 * 本测试文件校验 IncrementalTestSelector 类的流水线编排能力，
 * 覆盖 GitDiffAnalyzer → BlastRadiusBfs → RiskScorer → Top-N 全流程。
 *
 * 测试策略（遵循用户规则 P-5"禁止 mock"）：
 * - 在 os.tmpdir() 下创建临时 git 仓库
 * - 真实执行 git init / git add / git commit / git diff
 * - 直接构造真实依赖图邻接表（Record<string, ReadonlyArray<string>>）
 * - 真实校验 IncrementalTestSelector.select() 的完整输出
 *
 * 测试范围：
 * - T1. 单文件修改 + 单测试文件命中 → selectedTests 长度=1
 * - T2. 多文件修改 + 多测试文件命中 → Top-N 降序排序
 * - T3. 无变更（base==head）→ selectedTests=[] / totalCandidates=0 / coverageEstimate=0
 * - T4. 变更但无受影响测试 → selectedTests=[] / totalCandidates=0 / coverageEstimate=0
 * - T5. Top-N 小于候选数 → 仅返回 Top-N 个
 * - T6. 默认 Top-N=20
 * - T7. selectedTests 按 totalScore 降序排序
 * - T8. 每个 SelectedTest 含 affectedFiles（BFS 路径回溯）
 * - T9. 每个 SelectedTest 含 scores 与 reason
 * - T10. 返回的 IncrementalTestSelection 已冻结
 * - T11. selectedTests 数组已冻结
 * - T12. 每个 SelectedTest 对象本身也冻结
 * - T13. selectionReason 含 Top-N 与候选总数
 * - T14. 高风险符号参与评分（high-risk-symbol 维度命中）
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 使用真实 git 仓库 + 真实依赖图
 * - 禁止 mock
 *
 * @module core/tests/eag-incremental-test-selector
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { GitDiffAnalyzer, BlastRadiusBfs, RiskScorer, IncrementalTestSelector } from "../eag/testing/incremental/index";
import type { IncrementalTestSelection, SelectedTest } from "../eag/testing/incremental/types";

// ============================================================================
// 辅助函数：真实 git 仓库管理（与 git-diff-analyzer 测试同构）
// ============================================================================

/**
 * 创建临时 git 仓库（已 git init + 一次初始提交）
 *
 * @returns 临时仓库信息（repoPath / initialCommitSha）
 */
function createTempGitRepo(): { repoPath: string; initialCommitSha: string } {
  const repoPath: string = fs.mkdtempSync(path.join(os.tmpdir(), "eag-selector-test-"));

  execSync("git init -b main", { cwd: repoPath, encoding: "utf-8" });
  execSync('git config user.email "test@example.com"', { cwd: repoPath, encoding: "utf-8" });
  execSync('git config user.name "Test User"', { cwd: repoPath, encoding: "utf-8" });

  // 初始提交一个空 README
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Test Repo\n");
  execSync("git add README.md", { cwd: repoPath, encoding: "utf-8" });
  execSync('git commit -m "initial commit"', { cwd: repoPath, encoding: "utf-8" });

  const initialCommitSha: string = execSync("git rev-parse HEAD", {
    cwd: repoPath,
    encoding: "utf-8",
  }).trim();

  return { repoPath, initialCommitSha };
}

/**
 * 在仓库中创建文件并写入内容
 */
function writeRepoFile(repoPath: string, relativePath: string, content: string): void {
  const fullPath: string = path.join(repoPath, relativePath);
  const parentDir: string = path.dirname(fullPath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(fullPath, content);
}

/**
 * 提交当前所有变更
 */
function commitAll(repoPath: string, message: string): void {
  execSync("git add -A", { cwd: repoPath, encoding: "utf-8" });
  execSync(`git commit -m "${message}"`, { cwd: repoPath, encoding: "utf-8" });
}

/**
 * 递归删除临时仓库目录
 */
function cleanupRepo(repoPath: string): void {
  try {
    fs.rmSync(repoPath, { recursive: true, force: true });
  } catch (_e) {
    // 清理失败不影响测试结果
  }
}

/**
 * 构造 IncrementalTestSelector 实例（注入三个真实组件）
 */
function createSelector(): IncrementalTestSelector {
  return new IncrementalTestSelector(new GitDiffAnalyzer(), new BlastRadiusBfs(), new RiskScorer());
}

// ============================================================================
// T1. 单文件修改 + 单测试文件命中 → selectedTests 长度=1
// ============================================================================

test("T1. 单文件修改 + 单测试文件命中 → selectedTests 长度=1", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    // 修改 src/services/PaymentService.ts
    writeRepoFile(repoPath, "src/services/PaymentService.ts", "export class PaymentService {}\n");
    commitAll(repoPath, "add PaymentService");

    const selector = createSelector();
    // 依赖图：PaymentService → payment.contract.test.ts
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/services/PaymentService.ts": ["tests/contract/payment.contract.test.ts"],
    };

    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      []
    );

    // 应选中 1 个测试文件
    assert.equal(selection.selectedTests.length, 1);
    assert.equal(selection.totalCandidates, 1);
    assert.equal(selection.selectedTests[0].testPath, "tests/contract/payment.contract.test.ts");
    assert.ok(selection.selectedTests[0].totalScore > 0);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T2. 多文件修改 + 多测试文件命中 → Top-N 降序排序
// ============================================================================

test("T2. 多文件修改 + 多测试文件命中 → Top-N 降序排序", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    // 修改两个源文件
    writeRepoFile(repoPath, "src/services/PaymentService.ts", "export class PaymentService {}\n");
    writeRepoFile(repoPath, "src/services/OrderService.ts", "export class OrderService {}\n");
    commitAll(repoPath, "add PaymentService + OrderService");

    const selector = createSelector();
    // 依赖图：
    // - PaymentService → payment.contract.test.ts（depth=1，score 较高）
    // - OrderService → OrderController → order.contract.test.ts（depth=2，score 较低）
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/services/PaymentService.ts": ["tests/contract/payment.contract.test.ts"],
      "src/services/OrderService.ts": ["src/controllers/OrderController.ts"],
      "src/controllers/OrderController.ts": ["tests/contract/order.contract.test.ts"],
    };

    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      []
    );

    // 应选中 2 个测试文件
    assert.equal(selection.selectedTests.length, 2);
    assert.equal(selection.totalCandidates, 2);

    // 验证按 totalScore 降序排序
    const [first, second] = selection.selectedTests;
    assert.ok(first.totalScore >= second.totalScore, "应按 totalScore 降序排序");
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T3. 无变更（base==head）→ selectedTests=[] / totalCandidates=0 / coverageEstimate=0
// ============================================================================

test("T3. 无变更（base==head）→ selectedTests=[] / totalCandidates=0 / coverageEstimate=0", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    const selector = createSelector();
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/A.ts": ["tests/foo.test.ts"],
    };

    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      []
    );

    assert.equal(selection.selectedTests.length, 0);
    assert.equal(selection.totalCandidates, 0);
    assert.equal(selection.coverageEstimate, 0);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T4. 变更但无受影响测试 → selectedTests=[] / totalCandidates=0
// ============================================================================

test("T4. 变更但无受影响测试 → selectedTests=[] / totalCandidates=0", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/orphan.ts", "export const x = 1;\n");
    commitAll(repoPath, "add orphan");

    const selector = createSelector();
    // 依赖图：orphan 不在依赖图中，且其依赖不是测试文件
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/other.ts": ["src/B.ts"],
    };

    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      []
    );

    assert.equal(selection.selectedTests.length, 0);
    assert.equal(selection.totalCandidates, 0);
    assert.equal(selection.coverageEstimate, 0);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T5. Top-N 小于候选数 → 仅返回 Top-N 个
// ============================================================================

test("T5. Top-N 小于候选数 → 仅返回 Top-N 个", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    // 修改一个源文件
    writeRepoFile(repoPath, "src/services/PaymentService.ts", "export class PaymentService {}\n");
    commitAll(repoPath, "add PaymentService");

    const selector = createSelector();
    // 依赖图：PaymentService 依赖 3 个测试文件（3 个候选）
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/services/PaymentService.ts": [
        "tests/contract/payment1.contract.test.ts",
        "tests/contract/payment2.contract.test.ts",
        "tests/contract/payment3.contract.test.ts",
      ],
    };

    // Top-N=2，应仅返回 2 个
    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      [],
      2 // topN=2
    );

    assert.equal(selection.selectedTests.length, 2);
    assert.equal(selection.totalCandidates, 3);
    assert.equal(selection.topN, 2);
    // coverageEstimate = 2 / 3 ≈ 0.667
    assert.ok(selection.coverageEstimate > 0.66 && selection.coverageEstimate < 0.67);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T6. 默认 Top-N=20
// ============================================================================

test("T6. 默认 Top-N=20", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/services/PaymentService.ts", "export class PaymentService {}\n");
    commitAll(repoPath, "add PaymentService");

    const selector = createSelector();
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/services/PaymentService.ts": ["tests/contract/payment.contract.test.ts"],
    };

    // 不传 topN，使用默认值
    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      []
    );

    assert.equal(selection.topN, 20);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T7. selectedTests 按 totalScore 降序排序
// ============================================================================

test("T7. selectedTests 按 totalScore 降序排序", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    // 修改两个源文件（一个直接命中测试，一个间接命中）
    writeRepoFile(repoPath, "src/services/PaymentService.ts", "export class PaymentService {}\n");
    writeRepoFile(repoPath, "src/services/OrderService.ts", "export class OrderService {}\n");
    commitAll(repoPath, "add services");

    const selector = createSelector();
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      // PaymentService → payment.test.ts（depth=1，totalScore 较高）
      "src/services/PaymentService.ts": ["tests/contract/payment.contract.test.ts"],
      // OrderService → OrderController → order.test.ts（depth=2，totalScore 较低）
      "src/services/OrderService.ts": ["src/controllers/OrderController.ts"],
      "src/controllers/OrderController.ts": ["tests/contract/order.contract.test.ts"],
    };

    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      []
    );

    assert.ok(selection.selectedTests.length >= 2, "应有至少 2 个候选");
    // 验证降序排序
    for (let i = 1; i < selection.selectedTests.length; i++) {
      const prev: SelectedTest = selection.selectedTests[i - 1];
      const curr: SelectedTest = selection.selectedTests[i];
      assert.ok(
        prev.totalScore >= curr.totalScore,
        `selectedTests[${i - 1}].totalScore(${prev.totalScore}) 应 >= selectedTests[${i}].totalScore(${curr.totalScore})`
      );
    }
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T8. 每个 SelectedTest 含 affectedFiles（BFS 路径回溯）
// ============================================================================

test("T8. 每个 SelectedTest 含 affectedFiles（BFS 路径回溯）", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/services/PaymentService.ts", "export class PaymentService {}\n");
    commitAll(repoPath, "add PaymentService");

    const selector = createSelector();
    // 依赖图：PaymentService → PaymentController → payment.test.ts
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/services/PaymentService.ts": ["src/controllers/PaymentController.ts"],
      "src/controllers/PaymentController.ts": ["tests/contract/payment.contract.test.ts"],
    };

    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      []
    );

    assert.equal(selection.selectedTests.length, 1);
    const selected: SelectedTest = selection.selectedTests[0];
    // affectedFiles 应含 BFS 路径回溯的依赖链（PaymentService + PaymentController）
    assert.ok(selected.affectedFiles.length >= 1, `affectedFiles 应非空，实际：${selected.affectedFiles.length}`);
    assert.ok(selected.affectedFiles.includes("src/services/PaymentService.ts"));
    assert.ok(selected.affectedFiles.includes("src/controllers/PaymentController.ts"));
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T9. 每个 SelectedTest 含 scores 与 reason
// ============================================================================

test("T9. 每个 SelectedTest 含 scores 与 reason", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/services/PaymentService.ts", "export class PaymentService {}\n");
    commitAll(repoPath, "add PaymentService");

    const selector = createSelector();
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/services/PaymentService.ts": ["tests/contract/payment.contract.test.ts"],
    };

    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      []
    );

    assert.equal(selection.selectedTests.length, 1);
    const selected: SelectedTest = selection.selectedTests[0];
    // scores 应非空（至少含 indirect 维度）
    assert.ok(selected.scores.length > 0, "scores 应非空");
    // reason 应含 "总评分"
    assert.ok(selected.reason.includes("总评分"), `reason 应含 "总评分"，实际：${selected.reason}`);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T10. 返回的 IncrementalTestSelection 已冻结
// ============================================================================

test("T10. 返回的 IncrementalTestSelection 已冻结", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/services/PaymentService.ts", "export class PaymentService {}\n");
    commitAll(repoPath, "add PaymentService");

    const selector = createSelector();
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/services/PaymentService.ts": ["tests/contract/payment.contract.test.ts"],
    };

    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      []
    );

    assert.equal(Object.isFrozen(selection), true);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T11. selectedTests 数组已冻结
// ============================================================================

test("T11. selectedTests 数组已冻结", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/services/PaymentService.ts", "export class PaymentService {}\n");
    commitAll(repoPath, "add PaymentService");

    const selector = createSelector();
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/services/PaymentService.ts": ["tests/contract/payment.contract.test.ts"],
    };

    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      []
    );

    assert.equal(Object.isFrozen(selection.selectedTests), true);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T12. 每个 SelectedTest 对象本身也冻结
// ============================================================================

test("T12. 每个 SelectedTest 对象本身也冻结", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/services/PaymentService.ts", "export class PaymentService {}\n");
    commitAll(repoPath, "add PaymentService");

    const selector = createSelector();
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/services/PaymentService.ts": ["tests/contract/payment.contract.test.ts"],
    };

    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      []
    );

    for (const st of selection.selectedTests) {
      assert.equal(Object.isFrozen(st), true, `SelectedTest 应冻结：${st.testPath}`);
    }
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T13. selectionReason 含 Top-N 与候选总数
// ============================================================================

test("T13. selectionReason 含 Top-N 与候选总数", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/services/PaymentService.ts", "export class PaymentService {}\n");
    commitAll(repoPath, "add PaymentService");

    const selector = createSelector();
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/services/PaymentService.ts": [
        "tests/contract/payment1.contract.test.ts",
        "tests/contract/payment2.contract.test.ts",
      ],
    };

    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      [],
      5
    );

    // selectionReason 应含 "Top-5" 与候选总数 "2"
    assert.ok(selection.selectionReason.includes("Top-5"), `应含 "Top-5"，实际：${selection.selectionReason}`);
    assert.ok(selection.selectionReason.includes("2 个候选"), `应含 "2 个候选"，实际：${selection.selectionReason}`);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T14. 高风险符号参与评分（high-risk-symbol 维度命中）
// ============================================================================

test("T14. 高风险符号参与评分（high-risk-symbol 维度命中）", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/services/PaymentService.ts", "export class PaymentService {}\n");
    commitAll(repoPath, "add PaymentService");

    const selector = createSelector();
    // 依赖图：PaymentService → PaymentController:PaymentService.refund → payment.test.ts
    // parentPaths 中含 "src/controllers/PaymentController.ts:PaymentService.refund"
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/services/PaymentService.ts": ["src/controllers/PaymentController.ts:PaymentService.refund"],
      "src/controllers/PaymentController.ts:PaymentService.refund": ["tests/contract/payment.contract.test.ts"],
    };

    // 传入高风险符号 "PaymentService.refund"
    const selection: IncrementalTestSelection = selector.select(repoPath, initialCommitSha, "HEAD", dependencyGraph, [
      "PaymentService.refund",
    ]);

    assert.equal(selection.selectedTests.length, 1);
    const selected: SelectedTest = selection.selectedTests[0];
    // scores 应含 high-risk-symbol 维度
    const highRiskScore = selected.scores.find((s) => s.dimension === "high-risk-symbol");
    assert.ok(
      highRiskScore,
      `应含 high-risk-symbol 维度，实际 scores：${JSON.stringify(selected.scores.map((s) => s.dimension))}`
    );
    assert.equal(highRiskScore!.score, 0.3);
  } finally {
    cleanupRepo(repoPath);
  }
});
