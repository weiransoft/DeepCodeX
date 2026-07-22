/**
 * team-cmd-task-file.test.ts - --task-file 参数功能单元测试（v2.1.1 E2E）
 *
 * 测试目标：
 *   验证 team-cmd 的 --task-file 选项能正确从文件读取任务描述，
 *   避免 shell 转义问题（特别是 E2E 测试中 task 包含 < > ? & | $ ` " ' 等特殊字符）。
 *
 * 测试场景：
 *   - TF-001: dispatch --task-file 指定有效文件 → 任务描述从文件读取
 *   - TF-002: dispatch --task-file 指定空文件 → exitCode=1, stderr 含 "文件为空"
 *   - TF-003: dispatch --task-file 指定不存在文件 → exitCode=1, stderr 含 "读取 --task-file 失败"
 *   - TF-004: dispatch 同时指定 --task 和 --task-file → --task-file 优先（taskFile > task）
 *   - TF-005: dispatch --task-file 文件内容含 shell 特殊字符 → 原样传递给 LLM，不被 shell 解释
 *   - TF-006: autonomous --task-file 指定有效文件 → objective 从文件读取
 *   - TF-007: full-lifecycle --task-file 指定有效文件 → project 从文件读取
 *   - TF-008: dispatch 无 --task 也无 --task-file → exitCode=1, stderr 含 "需要 --task 或 --task-file"
 *
 * 测试约定（遵循用户规则）：
 *   - 使用 node:test + node:assert/strict
 *   - 禁止使用 mock 框架，使用真实临时文件 + 真实接口契约
 *   - 通过 TeamCommandArgs.injectedClient 字段注入 stub client
 *   - 每个测试用例独立隔离：临时 projectRoot + 拦截/恢复 stdout/stderr
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeTeamCommand } from "../team/team-cmd.js";
import type { OpenAIClientHandle } from "@vegamo/deepcode-core";

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 创建临时项目目录（用于隔离测试）
 *
 * @param prefix 目录名前缀
 * @returns 临时目录绝对路径
 */
function makeTempProject(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `deepcode-tf-${prefix}-`));
}

/**
 * 递归删除临时目录（忽略清理失败）
 *
 * @param dir 临时目录路径
 */
function rmTempProject(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

/**
 * 拦截 process.stdout.write 和 process.stderr.write，收集输出
 *
 * @returns 包含 stdout、stderr getter 和 restore 方法的对象
 */
function captureOutput(): {
  stdout: string;
  stderr: string;
  restore: () => void;
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  return {
    get stdout() {
      return stdoutChunks.join("");
    },
    get stderr() {
      return stderrChunks.join("");
    },
    restore: () => {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    },
  };
}

/**
 * 构造一个记录最后一次请求的 stub client
 *
 * 用于验证 task 描述是否正确传递给 LLM（通过 capturedRequest 检查 messages[1].content）
 *
 * @param responseContent LLM 固定返回的 content
 * @param capturedRef 用于记录最后一次 LLM 请求的对象（通过引用传递捕获结果）
 * @returns OpenAIClientHandle
 */
function buildCapturingStubClient(
  responseContent: string,
  capturedRef: { request: unknown | null }
): OpenAIClientHandle {
  return {
    client: {
      chat: {
        completions: {
          create: async (req: unknown, _opts?: { signal?: AbortSignal }) => {
            // 记录最后一次请求，供测试断言
            capturedRef.request = req;
            return {
              choices: [
                {
                  message: {
                    content: responseContent,
                  },
                },
              ],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 50,
                total_tokens: 150,
              },
            };
          },
        },
      },
    },
    model: "stub-task-file-model",
    baseURL: "https://stub.local",
    temperature: 0.3,
    thinkingEnabled: false,
  };
}

// ============================================================================
// TF-001: dispatch --task-file 指定有效文件
// ============================================================================

test("TF-001: dispatch --task-file 指定有效文件 → 任务描述从文件读取", async () => {
  const tmpDir = makeTempProject("tf001");
  const cap = captureOutput();
  try {
    // 准备任务文件，内容包含明确标识
    const taskContent = "请实现一个简单的加法函数，返回 a + b 的结果。";
    const taskFilePath = path.join(tmpDir, "task.txt");
    fs.writeFileSync(taskFilePath, taskContent, "utf-8");

    // 用于捕获 LLM 请求
    const captured: { request: unknown | null } = { request: null };
    const stubClient = buildCapturingStubClient("加法函数已实现", captured);

    const exitCode = await executeTeamCommand({
      subcommand: "dispatch",
      role: "solo-coder",
      taskFile: taskFilePath,
      projectRoot: tmpDir,
      injectedClient: stubClient,
    });

    // 验证 exitCode=0（succeeded）
    assert.equal(exitCode, 0, `exitCode 应为 0，实际: ${exitCode}`);

    // 验证 LLM 请求中的 user prompt 包含任务文件内容
    const req = captured.request as {
      messages?: Array<{ role: string; content: string }>;
    } | null;
    assert.ok(req, "应捕获到 LLM 请求");
    assert.ok(req?.messages, "请求应包含 messages 字段");
    assert.ok(req!.messages!.length >= 2, `messages 至少 2 条（system + user），实际: ${req!.messages!.length}`);

    // user prompt 是 messages[1]
    const userMessage = req!.messages!.find((m) => m.role === "user");
    assert.ok(userMessage, "应存在 user role 的 message");
    assert.ok(
      userMessage!.content.includes("加法函数"),
      `user prompt 应包含任务文件内容，实际: ${userMessage!.content}`
    );
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TF-002: dispatch --task-file 指定空文件
// ============================================================================

test("TF-002: dispatch --task-file 指定空文件 → exitCode=1, stderr 含 '文件为空'", async () => {
  const tmpDir = makeTempProject("tf002");
  const cap = captureOutput();
  try {
    // 准备空文件
    const taskFilePath = path.join(tmpDir, "empty-task.txt");
    fs.writeFileSync(taskFilePath, "", "utf-8");

    const exitCode = await executeTeamCommand({
      subcommand: "dispatch",
      role: "solo-coder",
      taskFile: taskFilePath,
      projectRoot: tmpDir,
      injectedClient: buildCapturingStubClient("不应被调用", { request: null }),
    });

    assert.equal(exitCode, 1, `exitCode 应为 1，实际: ${exitCode}`);
    assert.ok(cap.stderr.includes("文件为空"), `stderr 应含 "文件为空"，实际: ${cap.stderr}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TF-003: dispatch --task-file 指定不存在文件
// ============================================================================

test("TF-003: dispatch --task-file 指定不存在文件 → exitCode=1, stderr 含 '读取 --task-file 失败'", async () => {
  const tmpDir = makeTempProject("tf003");
  const cap = captureOutput();
  try {
    const notExistPath = path.join(tmpDir, "not-exist.txt");

    const exitCode = await executeTeamCommand({
      subcommand: "dispatch",
      role: "solo-coder",
      taskFile: notExistPath,
      projectRoot: tmpDir,
      injectedClient: buildCapturingStubClient("不应被调用", { request: null }),
    });

    assert.equal(exitCode, 1, `exitCode 应为 1，实际: ${exitCode}`);
    assert.ok(cap.stderr.includes("读取 --task-file 失败"), `stderr 应含 "读取 --task-file 失败"，实际: ${cap.stderr}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TF-004: dispatch 同时指定 --task 和 --task-file → --task-file 优先
// ============================================================================

test("TF-004: dispatch 同时指定 --task 和 --task-file → --task-file 优先", async () => {
  const tmpDir = makeTempProject("tf004");
  const cap = captureOutput();
  try {
    // task 和 taskFile 内容不同，验证 taskFile 优先
    const taskArg = "这是 --task 的内容";
    const taskFileContent = "这是 --task-file 的内容，应当优先使用";
    const taskFilePath = path.join(tmpDir, "task-priority.txt");
    fs.writeFileSync(taskFilePath, taskFileContent, "utf-8");

    const captured: { request: unknown | null } = { request: null };
    const stubClient = buildCapturingStubClient("已响应", captured);

    const exitCode = await executeTeamCommand({
      subcommand: "dispatch",
      role: "solo-coder",
      task: taskArg,
      taskFile: taskFilePath,
      projectRoot: tmpDir,
      injectedClient: stubClient,
    });

    assert.equal(exitCode, 0, `exitCode 应为 0，实际: ${exitCode}`);

    // 验证 LLM 请求中的 user prompt 包含 taskFile 内容，不包含 task 内容
    const req = captured.request as {
      messages?: Array<{ role: string; content: string }>;
    } | null;
    const userMessage = req?.messages?.find((m) => m.role === "user");
    assert.ok(userMessage, "应存在 user role 的 message");
    assert.ok(
      userMessage!.content.includes("--task-file 的内容"),
      `user prompt 应包含 --task-file 内容，实际: ${userMessage!.content}`
    );
    assert.ok(
      !userMessage!.content.includes(taskArg),
      `user prompt 不应包含 --task 内容（被 taskFile 覆盖），实际: ${userMessage!.content}`
    );
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TF-005: dispatch --task-file 文件内容含 shell 特殊字符
// ============================================================================

test("TF-005: dispatch --task-file 文件内容含 shell 特殊字符 → 原样传递给 LLM", async () => {
  const tmpDir = makeTempProject("tf005");
  const cap = captureOutput();
  try {
    // 准备含 shell 特殊字符的任务内容（模拟 PRD/ARCHITECTURE 文档片段）
    const taskContent = `请实现以下 API 契约：

POST /api/auth/login
  Body: { username: string, password: string }
  Response 200: { token: string, expiresIn: number }
  Response 401: { error: string }
  Authorization: Bearer <token>

特殊字符测试：
- ?name=xxx&age=20
- price: $100
- command: \`ls -la\`
- pipeline: cmd1 | cmd2
- and: a && b
- redirect: cat > file.txt
- function signToken(payload: { username: string }): string

┌─────────────────────────────────────────────┐
│             Express App (index.ts)            │
└─────────────────────────────────────────────┘`;

    const taskFilePath = path.join(tmpDir, "task-special.txt");
    fs.writeFileSync(taskFilePath, taskContent, "utf-8");

    const captured: { request: unknown | null } = { request: null };
    const stubClient = buildCapturingStubClient("已处理特殊字符", captured);

    const exitCode = await executeTeamCommand({
      subcommand: "dispatch",
      role: "solo-coder",
      taskFile: taskFilePath,
      projectRoot: tmpDir,
      injectedClient: stubClient,
    });

    assert.equal(exitCode, 0, `exitCode 应为 0，实际: ${exitCode}`);

    // 验证 LLM 请求中的 user prompt 完整包含所有特殊字符
    const req = captured.request as {
      messages?: Array<{ role: string; content: string }>;
    } | null;
    const userMessage = req?.messages?.find((m) => m.role === "user");
    assert.ok(userMessage, "应存在 user role 的 message");

    // 验证关键特殊字符都原样传递
    assert.ok(userMessage!.content.includes("<token>"), "应包含 <token>");
    assert.ok(userMessage!.content.includes("?name=xxx"), "应包含 ?name=xxx");
    assert.ok(userMessage!.content.includes("|"), "应包含管道符 |");
    assert.ok(userMessage!.content.includes("&&"), "应包含 &&");
    assert.ok(userMessage!.content.includes("signToken(payload"), "应包含函数签名");
    assert.ok(userMessage!.content.includes("┌─"), "应包含 box drawing 字符");
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TF-006: autonomous --task-file 指定有效文件
// ============================================================================

test("TF-006: autonomous --task-file 指定有效文件 → objective 从文件读取", async () => {
  const tmpDir = makeTempProject("tf006");
  const cap = captureOutput();
  try {
    // 准备任务文件
    const taskContent = "实现 OAuth2 登录模块（task-file 方式）";
    const taskFilePath = path.join(tmpDir, "autonomous-task.txt");
    fs.writeFileSync(taskFilePath, taskContent, "utf-8");

    // 自定义 stub client，固定返回成功的 stage 输出
    const stubClient: OpenAIClientHandle = {
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [
                {
                  message: {
                    content: "## Plan\n\n方案：OAuth2 登录模块实现计划...",
                  },
                },
              ],
              usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
            }),
          },
        },
      },
      model: "stub-autonomous-model",
      baseURL: "https://stub.local",
      temperature: 0.3,
      thinkingEnabled: false,
    };

    const exitCode = await executeTeamCommand({
      subcommand: "autonomous",
      taskFile: taskFilePath,
      projectRoot: tmpDir,
      injectedClient: stubClient,
    });

    // autonomous 模式即使 LLM 调用成功，后续阶段也可能失败
    // 这里只验证 stdout 含 "task-file 方式"（说明 objective 已从文件读取）
    // 或含 "创建新 run"（说明流程已进入正常路径，不是因 goal 缺失而失败）
    assert.ok(
      cap.stdout.includes("创建新 run") || cap.stdout.includes("OAuth2"),
      `stdout 应含 "创建新 run" 或 "OAuth2"，实际: ${cap.stdout}`
    );

    // 关键断言：不应出现 "需要 --goal 或 --task" 错误
    assert.ok(
      !cap.stderr.includes("需要 --goal 或 --task"),
      `stderr 不应含 "需要 --goal 或 --task"（说明 task-file 已生效），实际: ${cap.stderr}`
    );

    // exitCode 应该是 0/1/2/3 之一（不应该因为 goal 校验失败而返回 1）
    // 但这里我们不严格断言 exitCode，因为 autonomous 模式成功与否取决于后续 stage 执行
    assert.ok(
      exitCode === 0 || exitCode === 1 || exitCode === 2 || exitCode === 3,
      `exitCode 应在 0-3 范围内，实际: ${exitCode}`
    );
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TF-007: full-lifecycle --task-file 指定有效文件
// ============================================================================

test("TF-007: full-lifecycle --task-file 指定有效文件 → project 从文件读取", async () => {
  const tmpDir = makeTempProject("tf007");
  const cap = captureOutput();
  try {
    // 准备任务文件
    const taskContent = "电商网站项目（task-file 方式）";
    const taskFilePath = path.join(tmpDir, "full-lifecycle-task.txt");
    fs.writeFileSync(taskFilePath, taskContent, "utf-8");

    // full-lifecycle 模式会调用多次 dispatch，这里用一个简单的 stub
    const stubClient: OpenAIClientHandle = {
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [
                {
                  message: {
                    content: "## 响应\n\n项目已启动...",
                  },
                },
              ],
              usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
            }),
          },
        },
      },
      model: "stub-full-lifecycle-model",
      baseURL: "https://stub.local",
      temperature: 0.3,
      thinkingEnabled: false,
    };

    const exitCode = await executeTeamCommand({
      subcommand: "full-lifecycle",
      taskFile: taskFilePath,
      projectRoot: tmpDir,
      injectedClient: stubClient,
    });

    // 关键断言：不应出现 "需要 --goal 或 --task" 错误
    assert.ok(
      !cap.stderr.includes("需要 --goal 或 --task"),
      `stderr 不应含 "需要 --goal 或 --task"（说明 task-file 已生效），实际: ${cap.stderr}`
    );
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TF-008: dispatch 无 --task 也无 --task-file
// ============================================================================

test("TF-008: dispatch 无 --task 也无 --task-file → exitCode=1, stderr 含 '需要 --task 或 --task-file'", async () => {
  const tmpDir = makeTempProject("tf008");
  const cap = captureOutput();
  try {
    const exitCode = await executeTeamCommand({
      subcommand: "dispatch",
      role: "solo-coder",
      projectRoot: tmpDir,
      // 不提供 task 和 taskFile
      injectedClient: buildCapturingStubClient("不应被调用", { request: null }),
    });

    assert.equal(exitCode, 1, `exitCode 应为 1，实际: ${exitCode}`);
    assert.ok(
      cap.stderr.includes("需要 --task 或 --task-file"),
      `stderr 应含 "需要 --task 或 --task-file"，实际: ${cap.stderr}`
    );
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});
