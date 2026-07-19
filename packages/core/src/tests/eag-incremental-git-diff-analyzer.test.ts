/**
 * EAG-P3 批次 11 单元测试：GitDiffAnalyzer（§8.4）
 *
 * 本测试文件校验 GitDiffAnalyzer 类的 git diff 解析能力。
 *
 * 测试策略（遵循用户规则 P-5"禁止 mock"）：
 * - 在 os.tmpdir() 下创建临时 git 仓库
 * - 真实执行 git init / git add / git commit / git diff 等命令
 * - 真实校验 GitDiffAnalyzer.analyze() 的输出
 * - 测试结束后清理临时仓库
 *
 * 测试范围：
 * - T1. 单文件修改（modified）→ 解析 type=modified / filePath / diffStat
 * - T2. 新增文件（added）→ 解析 type=added
 * - T3. 删除文件（deleted）→ 解析 type=deleted
 * - T4. 重命名文件（renamed）→ 解析 type=renamed + oldFilePath
 * - T5. 多种变更混合（modified + added + deleted）→ 一次返回全部
 * - T6. 无变更（base==head）→ 返回空数组
 * - T7. analyze 返回的列表已冻结（Object.isFrozen）
 * - T8. 每个 GitFileChange 对象本身也冻结
 * - T9. DiffStat 字段已冻结
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 使用 node:fs / node:os / node:path / node:child_process 真实操作 git 仓库
 * - 禁止 mock
 *
 * @module core/tests/eag-incremental-git-diff-analyzer
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { GitDiffAnalyzer } from "../eag/testing/incremental/git-diff-analyzer";
import type { GitFileChange } from "../eag/testing/incremental/types";

// ============================================================================
// 辅助函数：真实 git 仓库管理
// ============================================================================

/**
 * 创建临时 git 仓库（已 git init + 一次初始提交）
 *
 * @returns 临时仓库信息（repoPath / initialCommitSha）
 */
function createTempGitRepo(): { repoPath: string; initialCommitSha: string } {
  // 在 os.tmpdir() 下创建唯一临时目录
  const repoPath: string = fs.mkdtempSync(path.join(os.tmpdir(), "eag-git-diff-test-"));

  // git init（默认主分支名 main，避免 master 分支兼容性问题）
  execSync("git init -b main", { cwd: repoPath, encoding: "utf-8" });
  // 配置 user.email / user.name（避免 commit 时报错 "Author identity unknown"）
  execSync('git config user.email "test@example.com"', { cwd: repoPath, encoding: "utf-8" });
  execSync('git config user.name "Test User"', { cwd: repoPath, encoding: "utf-8" });

  // 创建初始文件并提交（作为 base）
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Test Repo\n");
  execSync("git add README.md", { cwd: repoPath, encoding: "utf-8" });
  execSync('git commit -m "initial commit"', { cwd: repoPath, encoding: "utf-8" });

  // 获取初始提交 SHA（作为 base）
  const initialCommitSha: string = execSync("git rev-parse HEAD", {
    cwd: repoPath,
    encoding: "utf-8",
  }).trim();

  return { repoPath, initialCommitSha };
}

/**
 * 在仓库中创建文件并写入内容
 *
 * @param repoPath 仓库路径
 * @param relativePath 文件相对路径
 * @param content 文件内容
 */
function writeRepoFile(repoPath: string, relativePath: string, content: string): void {
  const fullPath: string = path.join(repoPath, relativePath);
  // 确保父目录存在
  const parentDir: string = path.dirname(fullPath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(fullPath, content);
}

/**
 * 在仓库中删除文件
 *
 * @param repoPath 仓库路径
 * @param relativePath 文件相对路径
 */
function deleteRepoFile(repoPath: string, relativePath: string): void {
  const fullPath: string = path.join(repoPath, relativePath);
  fs.unlinkSync(fullPath);
}

/**
 * 在仓库中重命名文件（使用 fs.rename + git add）
 *
 * @param repoPath 仓库路径
 * @param oldRelativePath 旧文件相对路径
 * @param newRelativePath 新文件相对路径
 */
function renameRepoFile(repoPath: string, oldRelativePath: string, newRelativePath: string): void {
  const oldFullPath: string = path.join(repoPath, oldRelativePath);
  const newFullPath: string = path.join(repoPath, newRelativePath);
  // 确保新父目录存在
  const parentDir: string = path.dirname(newFullPath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.renameSync(oldFullPath, newFullPath);
}

/**
 * 提交当前所有变更
 *
 * @param repoPath 仓库路径
 * @param message 提交消息
 */
function commitAll(repoPath: string, message: string): void {
  execSync("git add -A", { cwd: repoPath, encoding: "utf-8" });
  execSync(`git commit -m "${message}"`, { cwd: repoPath, encoding: "utf-8" });
}

/**
 * 递归删除临时仓库目录
 *
 * @param repoPath 仓库路径
 */
function cleanupRepo(repoPath: string): void {
  try {
    fs.rmSync(repoPath, { recursive: true, force: true });
  } catch (_e) {
    // 清理失败不影响测试结果（os.tmpdir 会被系统定期清理）
  }
}

// ============================================================================
// T1. 单文件修改（modified）→ 解析 type=modified / filePath / diffStat
// ============================================================================

test("T1. 单文件修改（modified）→ 解析 type=modified / filePath / diffStat", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    // 修改 README.md（把 "# Test Repo" 改为 "# Modified Repo"，并新增 2 行）
    // 原始行 "# Test Repo" 被删除，新增行 "# Modified Repo" + 空行 + "新增内容 1" + "新增内容 2"
    writeRepoFile(repoPath, "README.md", "# Modified Repo\n\n新增内容 1\n新增内容 2\n");
    commitAll(repoPath, "modify README.md");

    const analyzer = new GitDiffAnalyzer();
    const changes = analyzer.analyze(repoPath, initialCommitSha, "HEAD");

    assert.equal(changes.length, 1);
    const change: GitFileChange = changes[0];
    assert.equal(change.type, "modified");
    assert.equal(change.filePath, "README.md");
    assert.equal(change.oldFilePath, undefined);
    // additions 至少为 1（新增 "# Modified Repo" 行）
    assert.ok(change.diffStat.additions >= 1, `additions 应 >= 1，实际：${change.diffStat.additions}`);
    // deletions 至少为 1（删除 "# Test Repo" 行）
    assert.ok(change.diffStat.deletions >= 1, `deletions 应 >= 1，实际：${change.diffStat.deletions}`);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T2. 新增文件（added）→ 解析 type=added
// ============================================================================

test("T2. 新增文件（added）→ 解析 type=added", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/new-file.ts", "export const x = 1;\n");
    commitAll(repoPath, "add new-file.ts");

    const analyzer = new GitDiffAnalyzer();
    const changes = analyzer.analyze(repoPath, initialCommitSha, "HEAD");

    assert.equal(changes.length, 1);
    const change: GitFileChange = changes[0];
    assert.equal(change.type, "added");
    assert.equal(change.filePath, "src/new-file.ts");
    assert.equal(change.oldFilePath, undefined);
    assert.ok(change.diffStat.additions >= 1);
    assert.equal(change.diffStat.deletions, 0);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T3. 删除文件（deleted）→ 解析 type=deleted
// ============================================================================

test("T3. 删除文件（deleted）→ 解析 type=deleted", () => {
  const { repoPath } = createTempGitRepo();
  try {
    // 先添加 src/to-delete.ts 并提交，作为删除的 base（确保 base 中已存在该文件）
    writeRepoFile(repoPath, "src/to-delete.ts", "export const x = 1;\n");
    commitAll(repoPath, "add to-delete.ts");
    // 获取 base SHA（to-delete.ts 已存在）
    const baseSha: string = execSync("git rev-parse HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
    // 删除 src/to-delete.ts
    deleteRepoFile(repoPath, "src/to-delete.ts");
    commitAll(repoPath, "delete to-delete.ts");

    const analyzer = new GitDiffAnalyzer();
    const changes = analyzer.analyze(repoPath, baseSha, "HEAD");

    // 应至少包含一个 deleted 类型变更
    const deletedChange = changes.find((c) => c.type === "deleted");
    assert.ok(deletedChange, `应找到 deleted 类型变更，实际：${JSON.stringify(changes.map((c) => c.type))}`);
    assert.equal(deletedChange!.filePath, "src/to-delete.ts");
    assert.equal(deletedChange!.oldFilePath, undefined);
    assert.equal(deletedChange!.diffStat.additions, 0);
    assert.ok(deletedChange!.diffStat.deletions >= 1);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T4. 重命名文件（renamed）→ 解析 type=renamed + oldFilePath
// ============================================================================

test("T4. 重命名文件（renamed）→ 解析 type=renamed + oldFilePath", () => {
  const { repoPath } = createTempGitRepo();
  try {
    // 先添加 src/old-name.ts 并提交，作为重命名的 base
    writeRepoFile(repoPath, "src/old-name.ts", "export const x = 1;\n");
    commitAll(repoPath, "add old-name.ts");
    // 获取 base SHA（old-name.ts 已存在）
    const baseSha: string = execSync("git rev-parse HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
    // 重命名 old-name.ts → new-name.ts
    renameRepoFile(repoPath, "src/old-name.ts", "src/new-name.ts");
    commitAll(repoPath, "rename old-name.ts → new-name.ts");

    const analyzer = new GitDiffAnalyzer();
    const changes = analyzer.analyze(repoPath, baseSha, "HEAD");

    // 应找到一个 renamed 类型变更
    const renamedChange = changes.find((c) => c.type === "renamed");
    assert.ok(renamedChange, `应找到 renamed 类型变更，实际：${JSON.stringify(changes.map((c) => c.type))}`);
    assert.equal(renamedChange!.filePath, "src/new-name.ts");
    assert.equal(renamedChange!.oldFilePath, "src/old-name.ts");
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T5. 多种变更混合（modified + added + deleted）→ 一次返回全部
// ============================================================================

test("T5. 多种变更混合（modified + added + deleted）→ 一次返回全部", () => {
  const { repoPath } = createTempGitRepo();
  try {
    // 先添加 src/to-delete.ts 并提交，作为删除的 base（确保 base 中已存在该文件）
    writeRepoFile(repoPath, "src/to-delete.ts", "export const x = 1;\n");
    commitAll(repoPath, "add to-delete.ts");
    // 获取 base SHA（to-delete.ts 已存在）
    const baseSha: string = execSync("git rev-parse HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
    // 修改 README.md
    writeRepoFile(repoPath, "README.md", "# Test Repo\n修改内容\n");
    // 新增 src/added.ts
    writeRepoFile(repoPath, "src/added.ts", "export const a = 1;\n");
    // 删除 src/to-delete.ts
    deleteRepoFile(repoPath, "src/to-delete.ts");
    commitAll(repoPath, "mixed changes");

    const analyzer = new GitDiffAnalyzer();
    const changes = analyzer.analyze(repoPath, baseSha, "HEAD");

    // 应至少包含 modified / added / deleted 三种类型
    const types = new Set(changes.map((c) => c.type));
    assert.ok(types.has("modified"), `应包含 modified 类型，实际：${[...types].join(", ")}`);
    assert.ok(types.has("added"), `应包含 added 类型，实际：${[...types].join(", ")}`);
    assert.ok(types.has("deleted"), `应包含 deleted 类型，实际：${[...types].join(", ")}`);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T6. 无变更（base==head）→ 返回空数组
// ============================================================================

test("T6. 无变更（base==head）→ 返回空数组", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    const analyzer = new GitDiffAnalyzer();
    const changes = analyzer.analyze(repoPath, initialCommitSha, "HEAD");

    assert.equal(Array.isArray(changes), true);
    assert.equal(changes.length, 0);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T7. analyze 返回的列表已冻结（Object.isFrozen）
// ============================================================================

test("T7. analyze 返回的列表已冻结", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/file.ts", "export const x = 1;\n");
    commitAll(repoPath, "add file.ts");

    const analyzer = new GitDiffAnalyzer();
    const changes = analyzer.analyze(repoPath, initialCommitSha, "HEAD");

    assert.equal(Object.isFrozen(changes), true);
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T8. 每个 GitFileChange 对象本身也冻结
// ============================================================================

test("T8. 每个 GitFileChange 对象本身也冻结", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/file.ts", "export const x = 1;\n");
    commitAll(repoPath, "add file.ts");

    const analyzer = new GitDiffAnalyzer();
    const changes = analyzer.analyze(repoPath, initialCommitSha, "HEAD");

    assert.ok(changes.length > 0);
    for (const change of changes) {
      assert.equal(Object.isFrozen(change), true, `GitFileChange 应冻结：${change.filePath}`);
    }
  } finally {
    cleanupRepo(repoPath);
  }
});

// ============================================================================
// T9. DiffStat 字段已冻结
// ============================================================================

test("T9. DiffStat 字段已冻结", () => {
  const { repoPath, initialCommitSha } = createTempGitRepo();
  try {
    writeRepoFile(repoPath, "src/file.ts", "export const x = 1;\nexport const y = 2;\n");
    commitAll(repoPath, "add file.ts");

    const analyzer = new GitDiffAnalyzer();
    const changes = analyzer.analyze(repoPath, initialCommitSha, "HEAD");

    assert.ok(changes.length > 0);
    for (const change of changes) {
      assert.equal(Object.isFrozen(change.diffStat), true, `DiffStat 应冻结：${change.filePath}`);
    }
  } finally {
    cleanupRepo(repoPath);
  }
});
