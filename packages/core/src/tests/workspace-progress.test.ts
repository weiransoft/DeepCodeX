/**
 * 工作区进展快照测试（2026-11-10「状态推进被误判为空转」修复）。
 *
 * 真实性边界：全部使用真实临时目录 + 真实 `git init` / `git status`，
 * 不经任何 mock；快照工具本身即生产实现，仅断言其可观测输出。
 *
 * 覆盖：
 * - W1 反复写同一未跟踪文件：git status 行恒不变，但快照必须变化；
 * - W2 大文件尾部追加（> 首尾摘要窗口）：摘要仍覆盖推进，不漏判；
 * - W3 干净仓库 / 非 git 目录 / 空 projectRoot 的诚实降级语义；
 * - W4 LoopKernel 导出的 captureWorkspaceSnapshot 已接线到共享快照；
 * - W5 符号链接指向仓库外：不读外部内容，标记为 out-of-root。
 *
 * @module core/tests/workspace-progress
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import { captureWorkspaceProgressSnapshot } from "../common/workspace-progress";
import { captureWorkspaceSnapshot } from "../eag/loop/kernel";

function createGitProject(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ws-progress-${prefix}-`));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  return root;
}

function createPlainProject(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ws-progress-${prefix}-`));
}

function cleanup(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // 清理失败不影响断言结论
  }
}

function gitStatusLines(root: string): string {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .sort()
    .join("\n");
}

test("W1. 反复写同一未跟踪文件：状态码不变但内容推进 → 快照必须变化", () => {
  const root = createGitProject("w1");
  try {
    const target = path.join(root, "progress.log");
    fs.writeFileSync(target, "step 1\n");
    const statusBefore = gitStatusLines(root);
    const snapshotBefore = captureWorkspaceProgressSnapshot(root);
    assert.ok(snapshotBefore !== null && snapshotBefore.includes("progress.log"), "快照应包含变更文件");

    fs.writeFileSync(target, "step 1\nstep 2\n");
    const statusAfter = gitStatusLines(root);
    const snapshotAfter = captureWorkspaceProgressSnapshot(root);

    assert.equal(statusAfter, statusBefore, "旧口径：路径/状态码完全相同，看不出任何进展");
    assert.notEqual(snapshotAfter, snapshotBefore, "新口径：内容摘要必须让状态推进可比较");
    assert.equal(captureWorkspaceProgressSnapshot(root), snapshotAfter, "同一状态下快照必须稳定可复现");
  } finally {
    cleanup(root);
  }
});

test("W2. 大文件尾部追加（超出首尾摘要窗口）→ 仍识别为进展", () => {
  const root = createGitProject("w2");
  try {
    const target = path.join(root, "big.log");
    fs.writeFileSync(target, "A".repeat(40_000));
    const before = captureWorkspaceProgressSnapshot(root);
    fs.appendFileSync(target, "B".repeat(200));
    const after = captureWorkspaceProgressSnapshot(root);
    assert.ok(before !== null && after !== null);
    assert.notEqual(after, before, "尾部摘要必须让追加写入被识别为进展");
  } finally {
    cleanup(root);
  }
});

test("W3. 干净仓库返回可比较空串；非 git / 空 projectRoot 诚实返回 null", () => {
  const gitRoot = createGitProject("w3");
  const plainRoot = createPlainProject("w3");
  try {
    assert.equal(captureWorkspaceProgressSnapshot(gitRoot), "", "干净 git 仓库不是降级，返回空快照");
    assert.equal(captureWorkspaceProgressSnapshot(gitRoot, 3000), "");
    assert.equal(captureWorkspaceProgressSnapshot(plainRoot), null, "非 git 目录必须降级为 null");
    assert.equal(captureWorkspaceProgressSnapshot(""), null);
    assert.equal(captureWorkspaceProgressSnapshot(undefined), null);
    assert.equal(captureWorkspaceProgressSnapshot("   "), null);
    assert.equal(captureWorkspaceProgressSnapshot(path.join(plainRoot, "does-not-exist")), null);
  } finally {
    cleanup(gitRoot);
    cleanup(plainRoot);
  }
});

test("W4. LoopKernel.captureWorkspaceSnapshot 已接线共享快照：同一文件内容推进可感知", () => {
  const root = createGitProject("w4");
  try {
    const target = path.join(root, "state.json");
    fs.writeFileSync(target, '{"counter":1}');
    const before = captureWorkspaceSnapshot(root);
    assert.ok(before !== null);
    fs.writeFileSync(target, '{"counter":2}');
    const after = captureWorkspaceSnapshot(root);
    assert.notEqual(after, before, "LoopKernel/NodeLoopKernel 共用的快照必须感知内容推进");
    assert.equal(after, captureWorkspaceProgressSnapshot(root), "两处口径必须一致");
  } finally {
    cleanup(root);
  }
});

test("W5. 符号链接指向仓库外 → 不读外部内容，标记 out-of-root 且快照可用", () => {
  const root = createGitProject("w5");
  const outside = createPlainProject("w5-outside");
  try {
    const secretPath = path.join(outside, "secret.txt");
    fs.writeFileSync(secretPath, "EXTERNAL-CONTENT-SHOULD-NOT-BE-READ");
    fs.symlinkSync(secretPath, path.join(root, "link.txt"));
    const snapshot = captureWorkspaceProgressSnapshot(root);
    assert.ok(snapshot !== null, "越界链接不能让整个快照降级为 null");
    assert.match(snapshot, /out-of-root/, "越界链接必须显式标记，不读取仓库外文件");
    assert.ok(!snapshot.includes("EXTERNAL-CONTENT"), "绝不能把外部文件内容写进快照");
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});
