/**
 * team-cmd-consensus.test.ts - --consensus 共识评审功能单元测试（FIX-04）
 *
 * 测试目标：
 *   验证 team dispatch --consensus 的真实实现：
 *   - 并行派发 5 核心角色评审同一任务（forceRole 模式，各 1 次 LLM 调用）
 *   - LLM 聚合生成「共识点 / 分歧点 / 最终建议」结论（第 6 次调用）
 *   - 结构化输出 ConsensusResult 报告（状态统计 + 各角色意见 + 聚合结论）
 *   - 与 --role/--force-role 互斥校验
 *   - 无 API Key 时全角色 skipped → consensusStatus=skipped，exitCode=0
 *
 * 测试场景：
 *   - TC-CON-001: --consensus 全成功 → 6 次 LLM 调用（5 评审 + 1 聚合），
 *                 输出含 ConsensusResult / consensusStatus: succeeded / 5 角色小节 / 聚合结论
 *   - TC-CON-002: --consensus + --role 互斥 → exitCode=1，stderr 含 "互斥"
 *   - TC-CON-003: --consensus + --force-role 互斥 → exitCode=1，stderr 含 "互斥"
 *   - TC-CON-004: --consensus 无 API Key → 全角色 skipped，consensusStatus: skipped，
 *                 exitCode=0，聚合阶段显式标注"未聚合"
 *   - TC-CON-005: 聚合任务 prompt 嵌入全部成功角色的评审输出
 *
 * 测试约定（遵循用户规则）：
 *   - 使用 node:test + node:assert/strict
 *   - 禁止使用 mock 框架，使用真实临时目录 + stub client 依赖注入（合法扩展点）
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
  return fs.mkdtempSync(path.join(os.tmpdir(), `deepcode-con-${prefix}-`));
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
 * 构造一个记录全部请求的 stub client
 *
 * 用于验证共识评审的 LLM 调用次数与 prompt 内容：
 *   - 5 次角色评审调用（forceRole，各 1 次）
 *   - 1 次聚合调用（prompt 嵌入各角色输出）
 *
 * @param requestsRef 用于记录全部 LLM 请求的数组（通过引用传递捕获结果）
 * @param responseContent LLM 固定返回的 content
 * @returns OpenAIClientHandle
 */
function buildRecordingStubClient(requestsRef: unknown[], responseContent: string): OpenAIClientHandle {
  return {
    client: {
      chat: {
        completions: {
          create: async (req: unknown, _opts?: { signal?: AbortSignal }) => {
            // 记录每一次请求，供测试断言调用次数与 prompt 内容
            requestsRef.push(req);
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
    model: "stub-consensus-model",
    baseURL: "https://stub.local",
    temperature: 0.3,
    thinkingEnabled: false,
  };
}

/**
 * 隔离 OpenAI / DeepCode 相关环境变量 + 重定向 HOME 目录
 *
 * 用途：TC-CON-004 测试 "无 API Key" 场景时，确保 createOpenAIClient 走 no-client 分支
 *   1. 清空 OPENAI_API_KEY / DEEPCODE_API_KEY 等环境变量
 *   2. 重定向 HOME / USERPROFILE 到临时目录，阻断 ~/.deepcode/settings.json 读取
 *
 * 与 team-cmd-autonomous.test.ts 的 isolateOpenAIEnv 实现一致（内联避免跨包导入）。
 *
 * @returns restore 函数，调用后恢复原值并删除临时 HOME 目录
 */
function isolateOpenAIEnv(): () => void {
  const keys = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "DEEPCODE_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
  ];
  const backup: Record<string, string | undefined> = {};
  for (const key of keys) {
    backup[key] = process.env[key];
    delete process.env[key];
  }

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-con-home-"));
  const backupHome = process.env.HOME;
  const backupUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  return () => {
    if (backupHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = backupHome;
    }
    if (backupUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = backupUserProfile;
    }
    for (const key of keys) {
      if (backup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = backup[key]!;
      }
    }
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  };
}

// ============================================================================
// TC-CON-001: --consensus 全成功 → 6 次 LLM 调用 + 结构化共识报告
// ============================================================================

test("TC-CON-001: --consensus 全成功 → 6 次 LLM 调用，输出 ConsensusResult 结构化报告", async () => {
  const tmpDir = makeTempProject("tc001");
  const cap = captureOutput();
  try {
    const requests: unknown[] = [];
    const stubClient = buildRecordingStubClient(requests, "评审意见：该方案可行");

    const exitCode = await executeTeamCommand({
      subcommand: "dispatch",
      task: "设计用户登录模块",
      consensus: true,
      projectRoot: tmpDir,
      injectedClient: stubClient,
    });

    // 退出码：全成功 → 0
    assert.equal(exitCode, 0, `exitCode 应为 0，实际: ${exitCode}`);

    // LLM 调用次数：5 角色评审 + 1 聚合 = 6 次
    assert.equal(requests.length, 6, `LLM 调用应为 6 次（5 评审 + 1 聚合），实际: ${requests.length}`);

    // 结构化报告断言（对齐审查裁决：断言共识产物结构，而非恒真断言）
    assert.ok(cap.stdout.includes("ConsensusResult"), `stdout 应含 "ConsensusResult"，实际: ${cap.stdout}`);
    assert.ok(
      cap.stdout.includes("consensusStatus: succeeded"),
      `stdout 应含 "consensusStatus: succeeded"，实际: ${cap.stdout}`
    );
    assert.ok(cap.stdout.includes("roles: 5"), `stdout 应含 "roles: 5"，实际: ${cap.stdout}`);
    assert.ok(cap.stdout.includes("succeeded: 5"), `stdout 应含 "succeeded: 5"，实际: ${cap.stdout}`);

    // 5 角色小节全部出现
    for (const roleId of ["architect", "product-manager", "solo-coder", "test-expert", "ui-designer"]) {
      assert.ok(
        cap.stdout.includes(`--- ${roleId} (succeeded) ---`),
        `stdout 应含 "${roleId} (succeeded)" 小节，实际: ${cap.stdout}`
      );
    }

    // 聚合结论小节出现（stub 返回内容应包含在聚合输出中）
    assert.ok(cap.stdout.includes("聚合结论"), `stdout 应含 "聚合结论"，实际: ${cap.stdout}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TC-CON-002: --consensus + --role 互斥
// ============================================================================

test("TC-CON-002: --consensus + --role 互斥 → exitCode=1，stderr 含 '互斥'", async () => {
  const tmpDir = makeTempProject("tc002");
  const cap = captureOutput();
  try {
    const requests: unknown[] = [];
    const exitCode = await executeTeamCommand({
      subcommand: "dispatch",
      task: "设计用户登录模块",
      consensus: true,
      role: "architect",
      projectRoot: tmpDir,
      injectedClient: buildRecordingStubClient(requests, "不应被调用"),
    });

    assert.equal(exitCode, 1, `exitCode 应为 1，实际: ${exitCode}`);
    assert.ok(cap.stderr.includes("互斥"), `stderr 应含 "互斥"，实际: ${cap.stderr}`);
    // 互斥校验应在任何 LLM 调用之前触发
    assert.equal(requests.length, 0, `互斥场景不应发起 LLM 调用，实际: ${requests.length} 次`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TC-CON-003: --consensus + --force-role 互斥
// ============================================================================

test("TC-CON-003: --consensus + --force-role 互斥 → exitCode=1，stderr 含 '互斥'", async () => {
  const tmpDir = makeTempProject("tc003");
  const cap = captureOutput();
  try {
    const requests: unknown[] = [];
    const exitCode = await executeTeamCommand({
      subcommand: "dispatch",
      task: "设计用户登录模块",
      consensus: true,
      forceRole: true,
      projectRoot: tmpDir,
      injectedClient: buildRecordingStubClient(requests, "不应被调用"),
    });

    assert.equal(exitCode, 1, `exitCode 应为 1，实际: ${exitCode}`);
    assert.ok(cap.stderr.includes("互斥"), `stderr 应含 "互斥"，实际: ${cap.stderr}`);
    assert.equal(requests.length, 0, `互斥场景不应发起 LLM 调用，实际: ${requests.length} 次`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TC-CON-004: --consensus 无 API Key → 全角色 skipped
// ============================================================================

test("TC-CON-004: --consensus 无 API Key → consensusStatus: skipped，exitCode=0", async () => {
  const tmpDir = makeTempProject("tc004");
  const restoreEnv = isolateOpenAIEnv();
  const cap = captureOutput();
  try {
    // 不注入 injectedClient，走 createOpenAIClient 的 no-client 分支
    const exitCode = await executeTeamCommand({
      subcommand: "dispatch",
      task: "设计用户登录模块",
      consensus: true,
      projectRoot: tmpDir,
    });

    // skipped 为环境原因（非代码错误）→ exitCode=0
    assert.equal(exitCode, 0, `exitCode 应为 0，实际: ${exitCode}`);
    assert.ok(
      cap.stdout.includes("consensusStatus: skipped"),
      `stdout 应含 "consensusStatus: skipped"，实际: ${cap.stdout}`
    );
    assert.ok(cap.stdout.includes("skipped: 5"), `stdout 应含 "skipped: 5"，实际: ${cap.stdout}`);
    // 无成功角色产出 → 聚合阶段显式标注"未聚合"，不发起无意义的聚合调用
    assert.ok(cap.stdout.includes("未聚合"), `stdout 应含 "未聚合" 标注，实际: ${cap.stdout}`);
  } finally {
    cap.restore();
    restoreEnv();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TC-CON-005: 聚合任务 prompt 嵌入全部成功角色的评审输出
// ============================================================================

test("TC-CON-005: 聚合任务 prompt 嵌入全部 5 角色评审输出与三段式指令", async () => {
  const tmpDir = makeTempProject("tc005");
  const cap = captureOutput();
  try {
    const requests: unknown[] = [];
    // 每个角色评审返回带唯一标识的内容，聚合 prompt 应包含这些标识
    const roleOutputMarker = "角色评审唯一标识-MARKER";
    const stubClient = buildRecordingStubClient(requests, `评审意见 ${roleOutputMarker}`);

    const exitCode = await executeTeamCommand({
      subcommand: "dispatch",
      task: "设计用户登录模块",
      consensus: true,
      projectRoot: tmpDir,
      injectedClient: stubClient,
    });

    assert.equal(exitCode, 0, `exitCode 应为 0，实际: ${exitCode}`);
    assert.equal(requests.length, 6, `LLM 调用应为 6 次，实际: ${requests.length}`);

    // 第 6 次调用为聚合任务：检查其 user prompt
    const synthesisReq = requests[5] as {
      messages?: Array<{ role: string; content: string }>;
    };
    assert.ok(synthesisReq.messages, "聚合请求应包含 messages 字段");
    const synthesisUserMessage = synthesisReq.messages!.find((m) => m.role === "user");
    assert.ok(synthesisUserMessage, "聚合请求应存在 user role 的 message");

    const synthesisPrompt = synthesisUserMessage!.content;
    // 嵌入的 5 角色小节标题
    for (const roleId of ["architect", "product-manager", "solo-coder", "test-expert", "ui-designer"]) {
      assert.ok(
        synthesisPrompt.includes(`### ${roleId} 的评审意见`),
        `聚合 prompt 应含 "### ${roleId} 的评审意见" 小节，实际: ${synthesisPrompt}`
      );
    }
    // 嵌入的角色输出内容（唯一标识应出现 5 次：每个角色一份）
    const markerOccurrences = synthesisPrompt.split(roleOutputMarker).length - 1;
    assert.equal(markerOccurrences, 5, `聚合 prompt 应嵌入 5 份角色输出，实际: ${markerOccurrences} 份`);
    // 三段式聚合指令
    assert.ok(synthesisPrompt.includes("共识点"), `聚合 prompt 应含 "共识点" 指令，实际: ${synthesisPrompt}`);
    assert.ok(synthesisPrompt.includes("分歧点"), `聚合 prompt 应含 "分歧点" 指令，实际: ${synthesisPrompt}`);
    assert.ok(synthesisPrompt.includes("最终建议"), `聚合 prompt 应含 "最终建议" 指令，实际: ${synthesisPrompt}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});
