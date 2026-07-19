/**
 * EAG-P3 批次 11 单元测试：增量测试选择器边界场景
 *
 * 本测试文件专注校验 IncrementalTestSelector 与各组件的边界处理能力，
 * 覆盖空输入、无受影响测试、Top-N 超出候选数、异常输入等场景。
 *
 * 测试策略（遵循用户规则 P-5"禁止 mock"）：
 * - 在 os.tmpdir() 下创建临时 git 仓库
 * - 直接构造真实依赖图邻接表
 * - 真实校验边界场景下的输出
 *
 * 测试范围：
 * - T1. 空变更清单（base==head）→ selectedTests=[] / coverageEstimate=0
 * - T2. 变更清单非空但无受影响测试 → selectedTests=[] / coverageEstimate=0
 * - T3. Top-N=0 → 按 1 处理（至少选 1 个）
 * - T4. Top-N 负数 → 按 1 处理
 * - T5. Top-N 大于候选数 → 返回全部候选（不报错）
 * - T6. 空依赖图 → 仅返回 source 节点，selectedTests=[]
 * - T7. 空高风险符号列表 → 不影响基础评分
 * - T8. 循环依赖 → 不死循环，正常返回
 * - T9. 单文件变更但文件名特殊字符（含空格 / Unicode）→ 正常解析
 * - T10. 多源 BFS 边界（10 个 source 同时入队）→ 全部 source 都参与
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 使用真实 git 仓库 + 真实依赖图
 * - 禁止 mock
 *
 * @module core/tests/eag-incremental-boundary
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { GitDiffAnalyzer, BlastRadiusBfs, RiskScorer, IncrementalTestSelector } from "../eag/testing/incremental";
import type { IncrementalTestSelection } from "../eag/testing/incremental/types";

// ============================================================================
// 辅助函数：真实 git 仓库管理
// ============================================================================

function createTempGitRepo(): { repoPath: string; initialCommitSha: string } {
  const repoPath: string = fs.mkdtempSync(path.join(os.tmpdir(), "eag-boundary-test-"));

  execSync("git init -b main", { cwd: repoPath, encoding: "utf-8" });
  execSync('git config user.email "test@example.com"', { cwd: repoPath, encoding: "utf-8" });
  execSync('git config user.name "Test User"', { cwd: repoPath, encoding: "utf-8" });

  fs.writeFileSync(path.join(repoPath, "README.md"), "# Test Repo\n");
  execSync("git add README.md", { cwd: repoPath, encoding: "utf-8" });
  execSync('git commit -m "initial commit"', { cwd: repoPath, encoding: "utf-8" });

  const initialCommitSha: string = execSync("git rev-parse HEAD", {
    cwd: repoPath,
    encoding: "utf-8",
  }).trim();

  return { repoPath, initialCommitSha };
}

function writeRepoFile(repoPath: string, relativePath: string, content: string): void {
  const fullPath: string = path.join(repoPath, relativePath);
  const parentDir: string = path.dirname(fullPath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function commitAll(repoPath: string, message: string): void {
  execSync("git add -A", { cwd: repoPath, encoding: "utf-8" });
  execSync(`git commit -m "${message}"`, { cwd: repoPath, encoding: "utf-8" });
}

function cleanupRepo(repoPath: string): void {
  try {
    fs.rmSync(repoPath, { recursive: true, force: true });
  } catch (_e) {
    // 清理失败不影响测试结果
  }
}

function createSelector(): IncrementalTestSelector {
  return new IncrementalTestSelector(new GitDiffAnalyzer(), new BlastRadiusBfs(), new RiskScorer());
}

// ============================================================================
// T1. 空变更清单（base==head）→ selectedTests=[] / coverageEstimate=0
// ============================================================================

test("T1. 空变更清单（base==head）→ selectedTests=[] / coverageEstimate=0", () => {
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
    assert.ok(selection.selectionReason.includes("0 个候选"));
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T2. 变更清单非空但无受影响测试 → selectedTests=[] / coverageEstimate=0
// ============================================================================

test("T2. 变更清单非空但无受影响测试 → selectedTests=[] / coverageEstimate=0", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/orphan.ts", "export const x = 1;\n");
    commitAll(repoPath, "add orphan");

    const selector = createSelector();
    // 依赖图：orphan.ts 不在依赖图中
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
// T3. Top-N=0 → 按 1 处理（至少选 1 个）
// ============================================================================

test("T3. Top-N=0 → 按 1 处理（至少选 1 个）", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/services/PaymentService.ts", "export class PaymentService {}\n");
    commitAll(repoPath, "add PaymentService");

    const selector = createSelector();
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/services/PaymentService.ts": [
        "tests/contract/payment1.contract.test.ts",
        "tests/contract/payment2.contract.test.ts",
        "tests/contract/payment3.contract.test.ts",
      ],
    };

    // topN=0 → 按 1 处理
    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      [],
      0 // topN=0
    );

    // 应仅选中 1 个测试（按 1 处理）
    assert.equal(selection.selectedTests.length, 1);
    assert.equal(selection.topN, 1);
    assert.equal(selection.totalCandidates, 3);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T4. Top-N 负数 → 按 1 处理
// ============================================================================

test("T4. Top-N 负数 → 按 1 处理", () => {
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

    // topN=-5 → 按 1 处理
    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      [],
      -5 // topN=-5
    );

    assert.equal(selection.selectedTests.length, 1);
    assert.equal(selection.topN, 1);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T5. Top-N 大于候选数 → 返回全部候选（不报错）
// ============================================================================

test("T5. Top-N 大于候选数 → 返回全部候选（不报错）", () => {
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

    // topN=100（远大于候选数 2）
    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      [],
      100
    );

    // 应返回全部候选（2 个）
    assert.equal(selection.selectedTests.length, 2);
    assert.equal(selection.totalCandidates, 2);
    // coverageEstimate = 2 / 2 = 1.0
    assert.equal(selection.coverageEstimate, 1.0);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T6. 空依赖图 → 仅返回 source 节点，selectedTests=[]
// ============================================================================

test("T6. 空依赖图 → 仅返回 source 节点，selectedTests=[]", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/services/PaymentService.ts", "export class PaymentService {}\n");
    commitAll(repoPath, "add PaymentService");

    const selector = createSelector();
    // 空依赖图
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {};

    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      []
    );

    // 无依赖图，BFS 仅返回 source 节点，无测试文件命中
    assert.equal(selection.selectedTests.length, 0);
    assert.equal(selection.totalCandidates, 0);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T7. 空高风险符号列表 → 不影响基础评分
// ============================================================================

test("T7. 空高风险符号列表 → 不影响基础评分", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/services/PaymentService.ts", "export class PaymentService {}\n");
    commitAll(repoPath, "add PaymentService");

    const selector = createSelector();
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/services/PaymentService.ts": ["tests/contract/payment.contract.test.ts"],
    };

    // 传入空高风险符号列表
    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      [] // 空高风险符号列表
    );

    assert.equal(selection.selectedTests.length, 1);
    const selected = selection.selectedTests[0];
    // scores 不应含 high-risk-symbol 维度
    const highRiskScore = selected.scores.find((s) => s.dimension === "high-risk-symbol");
    assert.equal(highRiskScore, undefined);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T8. 循环依赖 → 不死循环，正常返回
// ============================================================================

test("T8. 循环依赖 → 不死循环，正常返回", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/A.ts", "export const a = 1;\n");
    commitAll(repoPath, "add A");

    const selector = createSelector();
    // 依赖图：A → B → A（循环），B → 测试文件
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/A.ts": ["src/B.ts"],
      "src/B.ts": ["src/A.ts", "tests/contract/a.contract.test.ts"],
    };

    // 期望：不死循环，正常返回测试文件
    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      []
    );

    // 应选中 1 个测试文件（a.contract.test.ts）
    assert.equal(selection.selectedTests.length, 1);
    assert.equal(selection.selectedTests[0].testPath, "tests/contract/a.contract.test.ts");
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T9. 单文件变更但文件名特殊字符（含空格 / Unicode）→ 正常解析
// ============================================================================

test("T9. 单文件变更但文件名含 Unicode → 正常解析", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    // 创建含中文字符的文件名
    writeRepoFile(repoPath, "src/服务.ts", "export const x = 1;\n");
    commitAll(repoPath, "add chinese filename");

    const selector = createSelector();
    const dependencyGraph: Readonly<Record<string, ReadonlyArray<string>>> = {
      "src/服务.ts": ["tests/contract/service.contract.test.ts"],
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
    assert.equal(selection.selectedTests[0].testPath, "tests/contract/service.contract.test.ts");
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T10. 多源 BFS 边界（10 个 source 同时入队）→ 全部 source 都参与
// ============================================================================

test("T10. 多源 BFS 边界（10 个 source 同时入队）→ 全部 source 都参与", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    // 修改 10 个源文件
    for (let i = 0; i < 10; i++) {
      writeRepoFile(repoPath, `src/services/Service${i}.ts`, `export class Service${i} {}\n`);
    }
    commitAll(repoPath, "add 10 services");

    const selector = createSelector();
    // 依赖图：每个 Service 对应一个测试文件
    const dependencyGraph: Record<string, ReadonlyArray<string>> = {};
    for (let i = 0; i < 10; i++) {
      dependencyGraph[`src/services/Service${i}.ts`] = [`tests/contract/service${i}.contract.test.ts`];
    }

    const selection: IncrementalTestSelection = selector.select(
      repoPath,
      initialCommitSha,
      "HEAD",
      dependencyGraph,
      [],
      20 // topN=20，可容纳全部 10 个候选
    );

    // 应选中 10 个测试文件
    assert.equal(selection.selectedTests.length, 10);
    assert.equal(selection.totalCandidates, 10);
    // coverageEstimate = 10 / 10 = 1.0
    assert.equal(selection.coverageEstimate, 1.0);
  } finally {
    cleanupRepo(repoPath);
  }
});
