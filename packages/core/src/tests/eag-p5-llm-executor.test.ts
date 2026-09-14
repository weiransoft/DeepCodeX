/**
 * EAG-P5 LlmTaskExecutor 单元测试（方案 A §5，设计文档 eag-p5-llm-execution-wiring.md）
 *
 * 真实性边界（用户硬性规则：禁止 mock/占位/简化）：
 * - LLM HTTP 边界：使用 StubLlmClient 按脚本返回响应（设计唯一允许的替换点）；
 * - ToolExecutor：生产真实实例（executor 内部 new），read/write/edit 真实执行；
 * - 文件系统：os.tmpdir 真实临时目录，落盘内容逐字节断言；
 * - git：每个项目真实 `git init`，changedFiles 由真实 `git status --porcelain` 检出；
 * - 权限钩子：白名单/路径牢笼/凭据模式全部走生产 onBeforeToolExecution 判定。
 *
 * 覆盖：
 * - E1 正常 write→终态：真实落盘 / success / llmRequests=2 / 真实 token / git 检出变更；
 * - E2 越权 write 项目外：deny 且文件绝不创建；
 * - E3 项目内 .env：凭据模式 deny 且文件绝不创建；
 * - E4 白名单外 bash：deny 且命令绝不执行（marker 文件不存在）；
 * - E5 LLM 工厂返回 null：fail-closed、零请求；
 * - E6 abort 标志文件预先存在：首轮即 aborted、零请求；
 * - E7 持续工具调用：达到 maxToolRounds 诚实判失败；
 * - E8 网关不回 usage：tokensEstimated=true 且 tokensUsed≥1（字符估算保底）。
 *
 * @module core/tests/eag-p5-llm-executor
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import { LlmTaskExecutor } from "../eag/p5/index";
import type { P5TaskExecutionInput } from "../eag/p5/index";
import { StubLlmClient } from "./fixtures/stub-llm-client";

// ============================================================================
// 1. 真实临时 git 项目夹具
// ============================================================================

/**
 * 创建真实临时项目并执行 git init（changedFiles 检出依赖真实 git 仓库）。
 *
 * @returns 项目根目录绝对路径
 */
function createGitProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eag-p5-executor-"));
  // 真实初始化 git 仓库（-q 静默；临时目录保证无远端副作用）
  execFileSync("git", ["init", "-q"], { cwd: projectRoot, stdio: "ignore" });
  return projectRoot;
}

/**
 * 递归删除临时目录（容错）。
 *
 * @param projectRoot 项目根目录
 */
function cleanup(projectRoot: string): void {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // 清理失败不影响断言结论
  }
}

/**
 * 构造执行器输入（端口契约的最小完整真实值）。
 *
 * @param projectRoot 项目根目录
 * @param abortFlagPath abort 标志文件路径（默认指向不存在的文件=不中止）
 * @returns 冻结的 P5TaskExecutionInput
 */
function buildExecutionInput(projectRoot: string, abortFlagPath?: string): P5TaskExecutionInput {
  return Object.freeze({
    projectRoot,
    runId: "unit-run-001",
    iterIndex: 0,
    stage: "dev",
    objective: "在临时项目中按任务卡完成真实文件改动",
    taskId: "T-001",
    taskTitle: "创建 answer 模块",
    acceptanceCriteria: Object.freeze(["文件真实落盘", "内容可被 Node 加载"]),
    abortFlagPath: abortFlagPath ?? path.join(projectRoot, ".eag", "p5", "abort.flag"),
  });
}

// ============================================================================
// 2. 测试用例
// ============================================================================

test("E1. write 工具真实落盘 → 终态：success、llmRequests=2、token 真实累计、git 检出变更", async () => {
  const projectRoot = createGitProject();
  try {
    const targetRelativePath = "src/answer.js";
    const targetAbsolutePath = path.join(projectRoot, targetRelativePath);
    const fileContent = "// 由桩模型经真实 write 工具创建\nmodule.exports = () => 42;\n";

    // 脚本：①write 真实创建项目内文件 ②无工具调用的终态文本
    const client = new StubLlmClient([
      {
        content: "",
        toolCalls: [
          {
            name: "write",
            args: { file_path: targetAbsolutePath, content: fileContent },
          },
        ],
      },
      { content: "已创建 src/answer.js，导出 answer 函数。" },
    ]);
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
    });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    // 1. 文件必须真实落盘且内容逐字节一致（证明走的是真实 write 工具而非内存模拟）
    assert.ok(fs.existsSync(targetAbsolutePath), "write 目标文件应真实存在");
    assert.equal(fs.readFileSync(targetAbsolutePath, "utf8"), fileContent);

    // 2. 终态语义
    assert.equal(result.success, true);
    assert.equal(result.llmRequests, 2, "write 一轮 + 终态一轮应为 2 次真实请求");
    assert.equal(result.tokensEstimated, false, "网关回了非零 usage，不应标记为估算");
    assert.ok(result.tokensUsed > 0, "真实 token 用量应大于 0");
    assert.ok(result.summary.includes("src/answer.js"), "终态摘要应来自模型真实文本");

    // 3. changedFiles 由真实 git status --porcelain 检出
    assert.ok(
      result.changedFiles.includes(targetRelativePath),
      `changedFiles 应含 ${targetRelativePath}，实际：${JSON.stringify(result.changedFiles)}`
    );

    // 4. 两次请求均只暴露白名单工具（无 bash/AskUserQuestion 等）
    const requests = client.getRequests();
    assert.equal(requests.length, 2);
    for (const record of requests) {
      for (const toolName of record.toolNames) {
        assert.ok(["read", "write", "edit", "UpdatePlan"].includes(toolName), `暴露了白名单外工具：${toolName}`);
      }
    }
  } finally {
    cleanup(projectRoot);
  }
});

test("E2. 越权 write（projectRoot 外绝对路径）：权限钩子 deny，文件绝不创建，任务仍可诚实终态", async () => {
  const projectRoot = createGitProject();
  // 越权目标位于 projectRoot 之外（os.tmpdir 下独立文件）
  const outsidePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eag-p5-outside-")), "escaped.js");
  try {
    const client = new StubLlmClient([
      {
        content: "",
        // 模型尝试写牢笼外文件：必须被进程内权限钩子拒绝
        toolCalls: [{ name: "write", args: { file_path: outsidePath, content: "evil" } }],
      },
      // deny 结果回灌后模型放弃越权，给出终态
      { content: "缺少在项目外写文件的权限，任务停止。" },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    assert.equal(result.success, true, "模型终态回复本身仍算执行完成（但没有任何越权改动）");
    assert.ok(!fs.existsSync(outsidePath), "牢笼外文件绝不允许被创建");
    // git 工作区应无任何变更（deny 的工具调用不产生落盘）
    assert.equal(result.changedFiles.length, 0, `不应检出变更，实际：${JSON.stringify(result.changedFiles)}`);

    // 工具结果回灌链路：第 2 次请求的消息中应含一条 tool 角色消息携带 deny 文本
    const secondRequestMessages = client.getRequests()[1]!.messages;
    const toolMessages = secondRequestMessages.filter((message) => message.role === "tool");
    assert.ok(toolMessages.length >= 1, "deny 后应把工具失败结果作为 tool 消息回灌模型");
    assert.match(toolMessages[0]!.content, /拒绝|deny|权限|不允许|outside|路径/i);
  } finally {
    cleanup(projectRoot);
    // 清理越权目标的父临时目录（文件本身不应存在，目录由 mkdtemp 创建需回收）
    try {
      fs.rmSync(path.dirname(outsidePath), { recursive: true, force: true });
    } catch {
      // 容错
    }
  }
});

test("E3. 项目内 .env 凭据文件：凭据模式命中 deny，文件绝不创建", async () => {
  const projectRoot = createGitProject();
  const envRelativePath = ".env";
  const envAbsolutePath = path.join(projectRoot, envRelativePath);
  try {
    const client = new StubLlmClient([
      {
        content: "",
        toolCalls: [{ name: "write", args: { file_path: envAbsolutePath, content: "API_KEY=sk-leaked\n" } }],
      },
      { content: "无法写入凭据文件。" },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    assert.equal(result.success, true);
    assert.ok(!fs.existsSync(envAbsolutePath), ".env 即使位于项目牢笼内也必须拒绝写入");
    assert.equal(result.changedFiles.length, 0);
  } finally {
    cleanup(projectRoot);
  }
});

test("E4. 白名单外工具（bash）：deny 且命令绝不执行（副作用 marker 不存在）", async () => {
  const projectRoot = createGitProject();
  // 若 bash 被真实执行，会在项目内留下 marker 文件（用 node 而非 touch 以跨平台）
  const markerRelativePath = "pwned.marker";
  const markerAbsolutePath = path.join(projectRoot, markerRelativePath);
  const injectedCommand = `node -e "require('fs').writeFileSync(${JSON.stringify(markerAbsolutePath)},'x')"`;
  try {
    const client = new StubLlmClient([
      {
        content: "",
        toolCalls: [{ name: "bash", args: { command: injectedCommand } }],
      },
      // 第二次尝试 edit（白名单内但无有效 snippet）也应被拒，随后模型终态
      { content: "", toolCalls: [{ name: "edit", args: { snippet_id: "nonexistent", replacement: "x" } }] },
      { content: "无可用执行通道，结束。" },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    assert.equal(result.success, true);
    assert.ok(!fs.existsSync(markerAbsolutePath), "bash 被 deny，注入命令绝不能执行产生 marker");
    assert.equal(result.changedFiles.length, 0);
  } finally {
    cleanup(projectRoot);
  }
});

test("E5. LLM 客户端工厂返回 null（无凭据）：fail-closed 失败且零请求", async () => {
  const projectRoot = createGitProject();
  try {
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => null,
    });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    assert.equal(result.success, false);
    assert.equal(result.llmRequests, 0, "无凭据时不得发起任何 LLM 请求");
    assert.equal(result.tokensUsed, 0);
    assert.ok(
      result.error !== undefined && result.error.includes("凭据"),
      `error 应说明凭据缺失，实际：${result.error}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

test("E6. abort 标志文件预先存在：首轮开始前即中止，零 LLM 请求", async () => {
  const projectRoot = createGitProject();
  // 真实创建 abort 标志文件（等价于 orchestrator/用户在执行前已请求 stop）
  const abortDir = path.join(projectRoot, ".eag", "p5");
  fs.mkdirSync(abortDir, { recursive: true });
  const abortFlagPath = path.join(abortDir, "abort.flag");
  fs.writeFileSync(abortFlagPath, String(Date.now()), "utf8");
  try {
    let requestCount = 0;
    const client = new StubLlmClient([{ content: "不应被触达" }]);
    // 再包一层计数工厂：executeTask 会先取客户端、再在首轮循环顶部做 abort 检查，
    // 因此工厂被调用 1 次，但桩 createMessage 绝不被触达（零真实请求）
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => {
        requestCount += 1;
        return client;
      },
    });

    const result = await executor.executeTask(buildExecutionInput(projectRoot, abortFlagPath));

    assert.equal(result.success, false);
    assert.ok(
      result.error !== undefined && result.error.includes("aborted"),
      `error 应为 aborted，实际：${result.error}`
    );
    assert.equal(result.llmRequests, 0, "中止检查先于首轮 LLM 请求");
    assert.equal(client.requestCount, 0, "桩 createMessage 不应被触达");
    assert.equal(requestCount, 1, "客户端工厂在 abort 检查前取一次，但不产生任何请求");
  } finally {
    cleanup(projectRoot);
  }
});

test("E7. 模型持续工具调用不给终态：达到 maxToolRounds 上限诚实判失败", async () => {
  const projectRoot = createGitProject();
  try {
    const targetAbsolutePath = path.join(projectRoot, "loop.txt");
    // 模型每轮都调用 write（内容不同以模拟反复修改），永不返回无 toolCalls 的终态。
    // 脚本长度给足（maxToolRounds+1），保证失败原因是"达上限"而非"脚本耗尽抛错"。
    const script = Array.from({ length: 4 }, (_unused, index) => ({
      content: "",
      toolCalls: [{ name: "write", args: { file_path: targetAbsolutePath, content: `round-${index}\n` } }],
    }));
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => new StubLlmClient(script),
      maxToolRounds: 2, // 测试收窄上限，避免不必要等待
    });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    assert.equal(result.success, false);
    assert.equal(result.llmRequests, 2, "最多发起 2 轮请求");
    assert.ok(
      result.error !== undefined && result.error.includes("上限"),
      `error 应说明工具循环达上限，实际：${result.error}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

test("E8. 网关全程不回 usage（usage=null）：tokensEstimated=true 且字符估算保底 tokensUsed≥1", async () => {
  const projectRoot = createGitProject();
  const targetAbsolutePath = path.join(projectRoot, "estimated.txt");
  try {
    const client = new StubLlmClient([
      {
        content: "",
        toolCalls: [{ name: "write", args: { file_path: targetAbsolutePath, content: "est\n" } }],
        usage: null, // 显式模拟不回 usage 的网关
      },
      { content: "完成", usage: null },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    assert.equal(result.success, true);
    assert.equal(result.llmRequests, 2);
    assert.equal(result.tokensEstimated, true, "无真实 usage 时必须诚实标记为估算值");
    assert.ok(
      Number.isInteger(result.tokensUsed) && result.tokensUsed >= 1,
      `估算保底必须 ≥1（保证 llmCallCount 凭证成立），实际：${result.tokensUsed}`
    );
    assert.ok(fs.existsSync(targetAbsolutePath));
  } finally {
    cleanup(projectRoot);
  }
});
