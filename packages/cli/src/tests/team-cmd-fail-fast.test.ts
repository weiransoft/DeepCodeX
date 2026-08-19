/**
 * team-cmd-fail-fast.test.ts - fail-fast 语义消费 + 退出码修正单元测试（S2）
 *
 * 测试目标（对照 docs/optimization-plan-20260819.md §3）：
 *   - --fail-fast 在 consensus 模式真实消费：任一角色失败 → 跳过聚合、exit 1
 *   - --fail-fast 在 full-lifecycle 线性模式真实消费：
 *       默认（true）失败即中止；--no-fail-fast 失败阶段继续并最终汇总 exit 1
 *   - 退出码修正：顶层 catch → 4；参数缺失（match/autonomous/full-lifecycle）→ 2
 *   - 边界回归：全 skipped 不触发 fail-fast；skipped 阶段不视为失败；显式 true ≡ 默认
 *
 * 测试场景（TC-FF-001 ~ TC-FF-010，与方案 §3.4 一一对应）：
 *   - TC-FF-001: consensus + architect 失败 + 默认 failFast → 跳过聚合、exit 1
 *   - TC-FF-002: 同场景 + failFast:false → 聚合执行（第 6 次调用）、exit 0（partial）
 *   - TC-FF-003: full-lifecycle 线性 + 阶段 2 失败 + failFast:false → 后续阶段继续、exit 1
 *   - TC-FF-004: 同场景 + 默认 failFast → 阶段 3 起无请求（中止）、exit 1
 *   - TC-FF-005: 损坏 .deepcodex/autonomous.yml → loadAutonomousConfig 抛错冒泡 → exit 4
 *   - TC-FF-006: match 缺 keywords / autonomous 缺 goal / full-lifecycle 缺 goal → exit 2
 *   - TC-FF-007: consensus 全 failed + failFast:false → 不聚合、exit 1
 *   - TC-FF-008: failFast 显式 true ≡ 默认 undefined（解析层回归）
 *   - TC-FF-009: full-lifecycle 线性阶段 skipped 不视为失败 → 继续执行、最终 exit 0
 *   - TC-FF-010: 帮助文本含 fail-fast 生效范围说明
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
import { executeTeamCommand, formatTeamHelp } from "../team/team-cmd.js";
import { buildAwareStubClient } from "./utils/stub-client.js";

// ============================================================================
// 辅助函数（与 team-cmd-consensus.test.ts 保持同模式，内联避免跨文件耦合）
// ============================================================================

/**
 * 创建临时项目目录（用于隔离测试）
 *
 * @param prefix 目录名前缀
 * @returns 临时目录绝对路径
 */
function makeTempProject(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `deepcode-ff-${prefix}-`));
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
 * 隔离 OpenAI / DeepCode 相关环境变量 + 重定向 HOME 目录
 *
 * 用途：TC-FF-009 测试"全阶段 skipped"场景时，确保 createOpenAIClient 走 no-client
 * 分支（无 API Key → executeDispatch 返回 skipped）
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

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-ff-home-"));
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

/**
 * 从记录的请求中提取 user prompt 内容（断言辅助）
 *
 * @param req LLM 请求对象
 * @returns user 消息内容（无则空字符串）
 */
function userContentOf(req: unknown): string {
  const messages = (req as { messages?: Array<{ role: string; content: unknown }> }).messages;
  if (!Array.isArray(messages)) {
    return "";
  }
  const userMsg = messages.find((m) => m && m.role === "user");
  return typeof userMsg?.content === "string" ? userMsg.content : "";
}

/**
 * 判断记录的请求中是否存在含指定文本的 user prompt（断言辅助）
 *
 * @param requests 记录的请求数组
 * @param text 期望包含的文本
 * @returns 是否存在
 */
function hasRequestWithUserContent(requests: unknown[], text: string): boolean {
  return requests.some((req) => userContentOf(req).includes(text));
}

// ============================================================================
// TC-FF-001: consensus + architect 失败 + 默认 failFast → 跳过聚合、exit 1
// ============================================================================

test("TC-FF-001: consensus 部分（architect）失败 + 默认 failFast → 跳过聚合（5 次调用）、exit 1", async () => {
  const tmpDir = makeTempProject("tc001");
  const cap = captureOutput();
  try {
    const requests: unknown[] = [];
    // failRoles=["Architect"]：仅 architect 角色评审抛错（system prompt 匹配），
    // 其余 4 角色正常返回；聚合请求经 "共识聚合" 标识放行（但 fail-fast 下不应发生）
    const stubClient = buildAwareStubClient(requests, { failRoles: ["Architect"] });

    const exitCode = await executeTeamCommand({
      subcommand: "dispatch",
      task: "设计用户登录模块",
      consensus: true,
      projectRoot: tmpDir,
      injectedClient: stubClient,
      // failFast 未指定 → 默认 true（S2 统一判定 failFast !== false）
    });

    // 快速失败：任一角色 failed → exit 1（此前 partial 场景返回 0，为目的性变更）
    assert.equal(exitCode, 1, `exitCode 应为 1，实际: ${exitCode}`);

    // 跳过聚合：仅 5 次角色评审调用（architect 抛错的调用同样被记录），无第 6 次聚合调用
    assert.equal(requests.length, 5, `LLM 调用应为 5 次（跳过聚合），实际: ${requests.length}`);

    // 正向标记：报告显式标注未聚合及 fail-fast 原因（不使用脆弱的负向断言）
    assert.ok(cap.stdout.includes("（未聚合："), `stdout 应含 "（未聚合：" 标记，实际: ${cap.stdout}`);
    assert.ok(cap.stdout.includes("fail-fast 生效"), `stdout 应含 "fail-fast 生效" 原因，实际: ${cap.stdout}`);
    assert.ok(cap.stdout.includes("failed: 1"), `stdout 应含 "failed: 1" 统计，实际: ${cap.stdout}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TC-FF-002: 同场景 + failFast:false → 聚合执行（6 次调用）、exit 0（partial）
// ============================================================================

test("TC-FF-002: consensus 部分失败 + failFast:false → 聚合执行（6 次调用）、exit 0", async () => {
  const tmpDir = makeTempProject("tc002");
  const cap = captureOutput();
  try {
    const requests: unknown[] = [];
    const stubClient = buildAwareStubClient(requests, { failRoles: ["Architect"] });

    const exitCode = await executeTeamCommand({
      subcommand: "dispatch",
      task: "设计用户登录模块",
      consensus: true,
      failFast: false,
      projectRoot: tmpDir,
      injectedClient: stubClient,
    });

    // --no-fail-fast：保持原有行为，partial（部分成功）→ exit 0
    assert.equal(exitCode, 0, `exitCode 应为 0，实际: ${exitCode}`);

    // 聚合执行：5 次评审 + 1 次聚合 = 6 次，第 6 次请求 user prompt 含 "共识聚合" 标识
    assert.equal(requests.length, 6, `LLM 调用应为 6 次（5 评审 + 1 聚合），实际: ${requests.length}`);
    assert.ok(hasRequestWithUserContent(requests, "共识聚合"), "第 6 次调用应为聚合请求（user prompt 含 '共识聚合'）");
    assert.ok(cap.stdout.includes("consensusStatus: partial"), `stdout 应含 "consensusStatus: partial"`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TC-FF-003: full-lifecycle 线性 + 阶段 2 失败 + failFast:false → 后续阶段继续、exit 1
// ============================================================================

test("TC-FF-003: full-lifecycle 线性阶段 2 失败 + failFast:false → 阶段 3+ 继续、exit 1", async () => {
  const tmpDir = makeTempProject("tc003");
  const cap = captureOutput();
  try {
    const requests: unknown[] = [];
    // failStages=[2]：阶段 2（架构设计）请求抛错，其余阶段正常返回
    const stubClient = buildAwareStubClient(requests, { failStages: [2] });

    const exitCode = await executeTeamCommand({
      subcommand: "full-lifecycle",
      goal: "测试项目",
      failFast: false,
      projectRoot: tmpDir,
      injectedClient: stubClient,
    });

    // --no-fail-fast：失败阶段继续执行，最终汇总判定仍有失败 → exit 1
    assert.equal(exitCode, 1, `exitCode 应为 1，实际: ${exitCode}`);

    // 阶段 3+ 请求继续发生（阶段 1-7 全部执行：7 次请求）
    assert.ok(hasRequestWithUserContent(requests, "[阶段3]"), "阶段 3 请求应继续发生");
    assert.ok(hasRequestWithUserContent(requests, "[阶段7]"), "阶段 7 请求应继续发生");
    assert.equal(requests.length, 7, `阶段 1-7 应全部执行（7 次调用），实际: ${requests.length}`);

    // 汇总输出：失败阶段计入 failedStages 并在最终统一输出
    assert.ok(cap.stderr.includes("全流程执行完毕，但 1 个阶段失败"), `stderr 应含失败汇总输出，实际: ${cap.stderr}`);
    assert.ok(cap.stderr.includes("阶段2(架构设计)"), `stderr 应含失败阶段标识`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TC-FF-004: 同场景 + 默认 failFast → 阶段 3 起无请求（中止）、exit 1
// ============================================================================

test("TC-FF-004: full-lifecycle 线性阶段 2 失败 + 默认 failFast → 立即中止（仅 2 次调用）、exit 1", async () => {
  const tmpDir = makeTempProject("tc004");
  const cap = captureOutput();
  try {
    const requests: unknown[] = [];
    const stubClient = buildAwareStubClient(requests, { failStages: [2] });

    const exitCode = await executeTeamCommand({
      subcommand: "full-lifecycle",
      goal: "测试项目",
      projectRoot: tmpDir,
      injectedClient: stubClient,
      // failFast 未指定 → 默认 true：阶段 2 失败即中止（原有行为保持）
    });

    assert.equal(exitCode, 1, `exitCode 应为 1，实际: ${exitCode}`);

    // 立即中止：仅阶段 1、2 的请求发生，阶段 3 起无任何请求
    assert.equal(requests.length, 2, `LLM 调用应为 2 次（阶段 1 成功 + 阶段 2 失败后中止），实际: ${requests.length}`);
    assert.ok(!hasRequestWithUserContent(requests, "[阶段3]"), "阶段 3 起不应有请求（已中止）");
    assert.ok(cap.stderr.includes("中止全流程"), `stderr 应含 "中止全流程"，实际: ${cap.stderr}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TC-FF-005: 损坏 autonomous.yml → loadAutonomousConfig 抛错冒泡 → exit 4
// ============================================================================

test("TC-FF-005: 损坏 .deepcodex/autonomous.yml → 顶层 catch 捕获 → exit 4", async () => {
  const tmpDir = makeTempProject("tc005");
  const cap = captureOutput();
  const restoreEnv = isolateOpenAIEnv();
  try {
    // 写入损坏的 autonomous.yml：内容 "!!!" 无法匹配 key: value 语法，
    // parseSimpleYaml（config-loader.ts L151）抛 "YAML 语法错误"，
    // loadAutonomousConfig 无内部 try/catch → 异常冒泡至 executeTeamCommand 顶层 catch
    fs.mkdirSync(path.join(tmpDir, ".deepcodex"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".deepcodex", "autonomous.yml"), "!!!", "utf-8");

    const requests: unknown[] = [];
    const stubClient = buildAwareStubClient(requests, {});

    const exitCode = await executeTeamCommand({
      subcommand: "autonomous",
      goal: "测试目标",
      projectRoot: tmpDir,
      injectedClient: stubClient,
    });

    // 未捕获异常属于运行时异常 → exit 4（此前返回 1，与帮助文本声明不符）
    assert.equal(exitCode, 4, `exitCode 应为 4（运行时异常），实际: ${exitCode}`);
    assert.ok(cap.stderr.includes("Team 命令执行失败"), `stderr 应含顶层异常提示，实际: ${cap.stderr}`);
    assert.ok(cap.stderr.includes("YAML"), `stderr 应含 YAML 解析错误信息，实际: ${cap.stderr}`);
  } finally {
    cap.restore();
    restoreEnv();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TC-FF-006: 参数缺失 → exit 2（match / autonomous / full-lifecycle 三断言）
// ============================================================================

test("TC-FF-006: match 缺 keywords / autonomous 缺 goal / full-lifecycle 缺 goal → exit 2", async () => {
  const tmpDir = makeTempProject("tc006");
  const cap = captureOutput();
  try {
    const requests: unknown[] = [];
    const stubClient = buildAwareStubClient(requests, {});

    // 断言 1：match 缺 --keywords → 参数错误 exit 2（此前返回 1）
    const matchExit = await executeTeamCommand({
      subcommand: "match",
      projectRoot: tmpDir,
    });
    assert.equal(matchExit, 2, `match 缺 keywords 的 exitCode 应为 2，实际: ${matchExit}`);
    assert.ok(cap.stderr.includes("需要 --keywords"), `stderr 应含 "需要 --keywords"，实际: ${cap.stderr}`);

    // 断言 2：autonomous 缺 --goal/--task → 参数错误 exit 2（AC-001 断言同步更新）
    // 注入 stub client 绕过 Step 2 的 API Key 检查，让流程到达 goal 校验
    const autonomousExit = await executeTeamCommand({
      subcommand: "autonomous",
      projectRoot: tmpDir,
      injectedClient: stubClient,
    });
    assert.equal(autonomousExit, 2, `autonomous 缺 goal 的 exitCode 应为 2，实际: ${autonomousExit}`);
    assert.ok(cap.stderr.includes("需要 --goal"), `stderr 应含 "需要 --goal"，实际: ${cap.stderr}`);

    // 断言 3：full-lifecycle 缺 --goal/--task → 参数错误 exit 2
    const lifecycleExit = await executeTeamCommand({
      subcommand: "full-lifecycle",
      projectRoot: tmpDir,
      injectedClient: stubClient,
    });
    assert.equal(lifecycleExit, 2, `full-lifecycle 缺 goal 的 exitCode 应为 2，实际: ${lifecycleExit}`);
    assert.ok(cap.stderr.includes("需要 --goal"), `stderr 应含 "需要 --goal"，实际: ${cap.stderr}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TC-FF-007: consensus 全 failed + failFast:false → 不聚合、exit 1
// ============================================================================

test("TC-FF-007: consensus 全 failed + failFast:false → 无成功角色不聚合、exit 1", async () => {
  const tmpDir = makeTempProject("tc007");
  const cap = captureOutput();
  try {
    const requests: unknown[] = [];
    // 全部 5 角色评审抛错（无成功角色产出）
    const stubClient = buildAwareStubClient(requests, {
      failRoles: ["Architect", "Product Manager", "Solo Coder", "Test Expert", "UI Designer"],
    });

    const exitCode = await executeTeamCommand({
      subcommand: "dispatch",
      task: "设计用户登录模块",
      consensus: true,
      failFast: false,
      projectRoot: tmpDir,
      injectedClient: stubClient,
    });

    // failFast=false 不改变全失败结果：consensusStatus=failed → exit 1
    assert.equal(exitCode, 1, `exitCode 应为 1，实际: ${exitCode}`);

    // 无成功角色产出 → 不发起聚合调用（5 次评审调用，全部抛错被 executeDispatch 捕获）
    assert.equal(requests.length, 5, `LLM 调用应为 5 次（无聚合），实际: ${requests.length}`);
    assert.ok(cap.stdout.includes("failed: 5"), `stdout 应含 "failed: 5"，实际: ${cap.stdout}`);
    assert.ok(cap.stdout.includes("（未聚合："), `stdout 应含 "（未聚合：" 标记，实际: ${cap.stdout}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TC-FF-008: failFast 显式 true ≡ 默认 undefined（解析层回归）
// ============================================================================

test("TC-FF-008: failFast 显式 true 与默认 undefined 行为一致", async () => {
  const tmpDir = makeTempProject("tc008");
  const cap = captureOutput();
  try {
    // 路径 1：显式 failFast: true
    const requestsExplicit: unknown[] = [];
    const exitExplicit = await executeTeamCommand({
      subcommand: "dispatch",
      task: "设计用户登录模块",
      consensus: true,
      failFast: true,
      projectRoot: tmpDir,
      injectedClient: buildAwareStubClient(requestsExplicit, { failRoles: ["Architect"] }),
    });

    // 路径 2：默认（不传 failFast → undefined → !== false → true）
    const requestsDefault: unknown[] = [];
    const exitDefault = await executeTeamCommand({
      subcommand: "dispatch",
      task: "设计用户登录模块",
      consensus: true,
      projectRoot: tmpDir,
      injectedClient: buildAwareStubClient(requestsDefault, { failRoles: ["Architect"] }),
    });

    // 两路径行为完全一致：均快速失败（exit 1、跳过聚合 5 次调用）
    assert.equal(exitExplicit, 1, `显式 true 的 exitCode 应为 1，实际: ${exitExplicit}`);
    assert.equal(exitDefault, 1, `默认 undefined 的 exitCode 应为 1，实际: ${exitDefault}`);
    assert.equal(requestsExplicit.length, 5, `显式 true 应跳过聚合（5 次调用），实际: ${requestsExplicit.length}`);
    assert.equal(requestsDefault.length, 5, `默认应跳过聚合（5 次调用），实际: ${requestsDefault.length}`);
  } finally {
    cap.restore();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TC-FF-009: full-lifecycle 线性阶段 skipped 不视为失败 → 继续执行、最终 exit 0
// ============================================================================

test("TC-FF-009: full-lifecycle 线性全阶段 skipped（无 API Key）→ 继续执行、exit 0", async () => {
  const tmpDir = makeTempProject("tc009");
  const cap = captureOutput();
  const restoreEnv = isolateOpenAIEnv();
  try {
    // 不注入 injectedClient + 隔离环境变量：createOpenAIClient 走 no-client 分支，
    // 每个阶段的 executeDispatch 返回 status=skipped（环境原因，非失败）
    const exitCode = await executeTeamCommand({
      subcommand: "full-lifecycle",
      goal: "测试项目",
      projectRoot: tmpDir,
    });

    // skipped 不视为失败：8 个阶段全部"通过"（skipped），最终 exit 0
    // （该条件是原有行为保持的回归验证，E2E TC-LOOP-01~08 依赖）
    assert.equal(exitCode, 0, `exitCode 应为 0，实际: ${exitCode}`);

    // 全部阶段状态为 skipped 且流程未中止（输出含多个阶段的 skipped 状态行）
    const skippedCount = cap.stdout.split("状态: skipped").length - 1;
    assert.equal(skippedCount, 7, `阶段 1-7 应全部 skipped（7 行状态输出），实际: ${skippedCount}`);
  } finally {
    cap.restore();
    restoreEnv();
    rmTempProject(tmpDir);
  }
});

// ============================================================================
// TC-FF-010: 帮助文本断言（fail-fast 生效范围说明）
// ============================================================================

test("TC-FF-010: formatTeamHelp 输出含 fail-fast 生效范围与退出码说明", () => {
  const help = formatTeamHelp();

  // --fail-fast 选项说明：默认开启 + 生效范围（仅 consensus 与 full-lifecycle 线性模式）
  assert.ok(help.includes("--fail-fast"), `帮助文本应含 "--fail-fast" 选项，实际:\n${help}`);
  assert.ok(
    help.includes("仅 consensus 与 full-lifecycle"),
    `帮助文本应含生效范围说明 "仅 consensus 与 full-lifecycle"，实际:\n${help}`
  );
  // --no-fail-fast 反向开关说明
  assert.ok(help.includes("--no-fail-fast"), `帮助文本应含 "--no-fail-fast" 说明，实际:\n${help}`);
  // 退出码区：4 = 运行时异常（与顶层 catch 实际返回值对齐）
  assert.ok(help.includes("4  运行时异常"), `帮助文本应含 "4  运行时异常" 退出码说明，实际:\n${help}`);
});
