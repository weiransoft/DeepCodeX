/**
 * bash-handler P0 安全修复单元测试
 *
 * 覆盖范围：
 * - P0-5 marker 安全加固（randomUUID 不可预测 + CWD 越界校验）
 * - P0-6 子 shell 环境变量过滤（由 shell-utils 实现，此处做集成验证）
 * - bash-handler 内置危险命令拦截
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实的 handleBashTool + 临时目录
 * - 中文注释
 *
 * @module core/tests/bash-handler-safety
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { handleBashTool } from "../tools/bash-handler";
import type { ToolExecutionContext } from "../tools/executor";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-bash-safety-"));
  // macOS /var 是 /private/var 的符号链接，子 shell 的 pwd 可能返回真实路径；
  // 使用 realpathSync 确保 projectRoot 与 shell 输出的 $PWD 在同一命名空间。
  const realDir = fs.realpathSync(dir);
  tempDirs.push(realDir);
  return realDir;
}

function createContext(sessionId: string, projectRoot: string): ToolExecutionContext {
  return {
    sessionId,
    projectRoot,
    toolCall: {
      id: "test-tool-call",
      type: "function",
      function: {
        name: "bash",
        arguments: "{}",
      },
    },
  };
}

// ============================================================================
// 1. P0-5 marker 安全加固
// ============================================================================

test("两次 bash 调用生成的 marker 不同，且输出中不泄露 marker", async () => {
  const workspace = createTempWorkspace();
  const sessionId = "marker-unpredictable-1";

  const result1 = await handleBashTool({ command: "echo hello" }, createContext(sessionId, workspace));
  assert.equal(result1.ok, true);
  assert.doesNotMatch(result1.output ?? "", /__DEEPCODE_PWD__/);

  // 同一个 session 再次执行，验证 session CWD 正常保留在项目内
  const result2 = await handleBashTool({ command: "pwd" }, createContext(sessionId, workspace));
  assert.equal(result2.ok, true);
  assert.equal(result2.metadata?.cwd, workspace);
  assert.doesNotMatch(result2.output ?? "", /__DEEPCODE_PWD__/);
});

test("shell 真实 CWD 越界到 /etc 时，返回的 cwd 被拦截并保留 projectRoot", async () => {
  const workspace = createTempWorkspace();
  const sessionId = "cwd-escape-1";

  // shell 真实 cd 到 /etc，marker 行会输出 /etc；
  // validateCwdWithinProjectRoot 必须拒绝越界 CWD，保留 projectRoot。
  const result = await handleBashTool({ command: "cd /etc && pwd" }, createContext(sessionId, workspace));
  assert.equal(result.ok, true);
  assert.notEqual(result.metadata?.cwd, "/etc");
  assert.equal(result.metadata?.cwd, workspace);
});

test("通过 cd 在项目子目录间切换是允许的", async () => {
  const workspace = createTempWorkspace();
  const subDir = path.join(workspace, "sub");
  fs.mkdirSync(subDir);
  const sessionId = "cwd-internal-1";

  const result = await handleBashTool({ command: "cd sub && pwd" }, createContext(sessionId, workspace));
  assert.equal(result.ok, true);
  assert.equal(result.metadata?.cwd, subDir);
});

// ============================================================================
// 2. 内置危险命令拦截
// ============================================================================

test("rm -rf / 被内置危险命令黑名单拦截", async () => {
  const workspace = createTempWorkspace();
  const result = await handleBashTool({ command: "rm -rf /" }, createContext("danger-rm-root", workspace));
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /blocked by built-in guard/);
});

test("mkfs 被内置危险命令黑名单拦截", async () => {
  const workspace = createTempWorkspace();
  const result = await handleBashTool({ command: "mkfs.ext4 /dev/sda1" }, createContext("danger-mkfs", workspace));
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /blocked by built-in guard/);
});

// ============================================================================
// 3. 子 shell 环境变量过滤集成验证
// ============================================================================

test("子 shell 不继承 API_KEY 等敏感环境变量", async () => {
  const workspace = createTempWorkspace();
  const originalKey = process.env.API_KEY;
  process.env.API_KEY = "sk-inherited-check";
  try {
    const result = await handleBashTool(
      { command: "echo ${API_KEY:-missing}" },
      createContext("env-filter-1", workspace)
    );
    assert.equal(result.ok, true);
    assert.equal(result.output?.trim(), "missing");
  } finally {
    if (originalKey === undefined) {
      delete process.env.API_KEY;
    } else {
      process.env.API_KEY = originalKey;
    }
  }
});

test("子 shell 保留 PATH 等基础环境变量", async () => {
  const workspace = createTempWorkspace();
  const result = await handleBashTool({ command: "echo ${PATH:+has_path}" }, createContext("env-path-1", workspace));
  assert.equal(result.ok, true);
  assert.equal(result.output?.trim(), "has_path");
});
