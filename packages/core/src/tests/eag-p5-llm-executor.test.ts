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

    // 4. 两次请求均只暴露白名单工具（bash 已入白名单，2026-10-03 用户决策）
    const requests = client.getRequests();
    assert.equal(requests.length, 2);
    for (const record of requests) {
      for (const toolName of record.toolNames) {
        assert.ok(
          ["read", "write", "edit", "UpdatePlan", "bash"].includes(toolName),
          `暴露了白名单外工具：${toolName}`
        );
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

test("E3b. 模板豁免：read .env.example / .env.prod.example 应 approve（安装引导依赖）", async () => {
  const projectRoot = createGitProject();
  // 真实预置两个公开模板文件（无真实凭据，仅占位 KEY=）
  const tpl1 = path.join(projectRoot, ".env.example");
  const tpl2 = path.join(projectRoot, ".env.prod.example");
  try {
    fs.writeFileSync(tpl1, "DATABASE_URL=postgres://user:pass@localhost:5432/db\n");
    fs.writeFileSync(tpl2, "VLLM_BASE_URL=http://localhost:8000/v1\n");

    const client = new StubLlmClient([
      {
        content: "",
        toolCalls: [
          { name: "read", args: { file_path: tpl1 } },
          { name: "read", args: { file_path: tpl2 } },
        ],
      },
      { content: "已读取两份环境模板，可据此生成 .env.prod。" },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    // read 是只读工具：deny 不报错但结果文本含拒绝语义；approve 时模型拿到文件内容。
    // 通过 StubLlmClient 真实收到的消息回灌验证读取成功（无 deny 文本）。
    const toolMessages = client
      .getRequests()
      .slice(1)
      .flatMap((req: any) => req.messages ?? [])
      .filter((m: any) => m.role === "tool");
    assert.ok(toolMessages.length >= 2, "两次 read 都应有 tool 结果回灌");
    for (const msg of toolMessages) {
      assert.ok(
        !/拒绝|deny|不允许|凭据/.test(String(msg.content)),
        `模板文件 read 不应被凭据模式拒绝，实际回灌：${String(msg.content).slice(0, 120)}`
      );
    }
    assert.equal(result.success, true);
  } finally {
    cleanup(projectRoot);
  }
});

test("E3c. 只读放行（修复 2026-10-03）：read /tmp 下文件应 approve，write /tmp 同路径仍 deny", async () => {
  const projectRoot = createGitProject();
  // 真实预置 /tmp 下的日志文件（模拟 deepcodex-verify.log 查询场景）
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-p5-readonly-"));
  const logPath = path.join(tmpDir, "deepcodex-verify.log");
  fs.writeFileSync(logPath, "verify ok\n");
  const writeTarget = path.join(tmpDir, "should-be-denied.txt");
  try {
    const client = new StubLlmClient([
      {
        content: "",
        toolCalls: [
          // read 越界到 /tmp：只读放行例外应 approve（模型拿到文件内容）
          { name: "read", args: { file_path: logPath } },
          // write 越界到 /tmp：只放行 read，写入仍必须被牢笼拒绝
          { name: "write", args: { file_path: writeTarget, content: "evil" } },
        ],
      },
      { content: "读取日志完成，写文件被拒绝。" },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    assert.equal(result.success, true);
    const toolMessages = client
      .getRequests()
      .slice(1)
      .flatMap((req: any) => req.messages ?? [])
      .filter((m: any) => m.role === "tool");
    assert.ok(toolMessages.length >= 2, "read 与 write 都应有 tool 结果回灌");
    // 第 1 条：read /tmp 放行 → 内容回灌且无拒绝语义
    assert.match(String(toolMessages[0]!.content), /verify ok/, "read /tmp 应真实回灌文件内容");
    // 第 2 条：write /tmp 仍拒绝 → 含拒绝语义且文件绝不创建
    assert.match(String(toolMessages[1]!.content), /拒绝|deny|权限|不允许|路径/i);
    assert.ok(!fs.existsSync(writeTarget), "write /tmp（牢笼外）绝不允许落盘");
  } finally {
    cleanup(projectRoot);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 容错
    }
  }
});

test("E4. bash 入白名单（用户决策 2026-10-03）：常规命令 approve 真实执行；白名单外工具仍 deny", async () => {
  const projectRoot = createGitProject();
  const markerAbsolutePath = path.join(projectRoot, "executed.marker");
  // E4 同构引号约定：shell 单引号 → node 双引号源码（避免路径被解析为正则字面量）
  const safeCommand = `node -e 'require("fs").writeFileSync(${JSON.stringify(markerAbsolutePath)},"x")'`;
  try {
    const client = new StubLlmClient([
      {
        content: "",
        toolCalls: [
          { name: "bash", args: { command: safeCommand } },
          // 白名单外工具（WebSearch）仍必须 deny（防模型/调用方注入）
          { name: "WebSearch", args: { query: "anything" } },
        ],
      },
      { content: "完成。" },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    assert.equal(result.success, true);
    assert.ok(fs.existsSync(markerAbsolutePath), "bash 已入白名单，常规命令必须真实执行");
    // 白名单外工具 deny 语义必须回灌模型
    const toolMessages = client
      .getRequests()
      .slice(1)
      .flatMap((req: any) => req.messages ?? [])
      .filter((m: any) => m.role === "tool");
    assert.ok(
      toolMessages.some((m: any) => /拒绝|deny/i.test(String(m.content))),
      "WebSearch（白名单外）的 deny 必须回灌模型"
    );
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

// ============================================================================
// 拒绝风暴 fail-fast（修复"同一错误静默重复烧轮"2026-10-03）
// ============================================================================

test("E9. 拒绝风暴：连续 6 次越权 read 后 fail-fast，不再烧满 12 轮", async () => {
  const projectRoot = createGitProject();
  try {
    // 脚本：12 轮全部持续调用 read 越界路径（越界且不在只读放行前缀的目录）。
    // /tmp 已只读放行，因此这里改用凭据模式：项目内 .env.sensitive 会被凭据守卫
    // deny——但注意权限钩子在执行 handler 之前判定，凭据 deny 必须真实命中
    // isCredentialProtected；为保证与真实事故场景一致，先落盘一个真实凭据文件。
    // 脚本重复 3 轮 × 2 次 = 6 次 deny 即触发风暴 fail-fast。
    const envPath = path.join(projectRoot, ".env.sensitive");
    fs.writeFileSync(envPath, "SECRET_TOKEN=unit-test-fixture-value\n");
    const responses: ConstructorParameters<typeof StubLlmClient>[0] = [];
    for (let round = 0; round < 12; round += 1) {
      responses.push({
        content: "",
        toolCalls: [
          { name: "read", args: { file_path: envPath } },
          { name: "read", args: { file_path: envPath } },
        ],
      });
    }
    const client = new StubLlmClient(responses);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /拒绝风暴/, `应醒目标注拒绝风暴根因，实际：${result.error}`);
    // fail-fast：3 轮（6 次 deny）即停，llmRequests=3 << 12 轮上限
    assert.ok(result.llmRequests <= 3, `拒绝风暴应在 3 轮内终止，实际 llmRequests=${result.llmRequests}`);
  } finally {
    cleanup(projectRoot);
  }
});

test("E10. deny 穿插合法调用不误伤：少量重复 deny（< 阈值）+ 合法穿插，任务正常终态", async () => {
  const projectRoot = createGitProject();
  const envPath = path.join(projectRoot, ".env.sensitive");
  const okPath = path.join(projectRoot, "ok.txt");
  try {
    // 真实落盘凭据文件，保证 deny 由凭据守卫命中（而非"文件不存在"错误）
    fs.writeFileSync(envPath, "SECRET_TOKEN=unit-test-fixture-value\n");
    const client = new StubLlmClient([
      // 第 1 轮：一次 deny + 一次成功 write（合法穿插）
      {
        content: "",
        toolCalls: [
          { name: "read", args: { file_path: envPath } },
          { name: "write", args: { file_path: okPath, content: "ok\n" } },
        ],
      },
      // 后续轮次重复 deny 同一目标——累计 3 次仍 < 阈值 6，不得误触发风暴
      {
        content: "",
        toolCalls: [
          { name: "read", args: { file_path: envPath } },
          { name: "read", args: { file_path: envPath } },
        ],
      },
      { content: "完成" },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    // 3 次 deny（< 阈值 6）→ 不触发风暴，任务以正常终态成功
    assert.equal(result.success, true);
    assert.ok(fs.existsSync(okPath), "混合轮次中的成功 write 必须真实落盘");
  } finally {
    cleanup(projectRoot);
  }
});

test("E11. 拒绝风暴按目标指纹计数：合法穿插不清零，同一目标累计 6 次即 fail-fast", async () => {
  const projectRoot = createGitProject();
  const envPath = path.join(projectRoot, ".env.sensitive");
  const okPath = path.join(projectRoot, "ok.txt");
  try {
    fs.writeFileSync(envPath, "SECRET_TOKEN=unit-test-fixture-value\n");
    // 每轮：一次对 ok.txt 的合法 write（穿插的"成功调用"）+ 两次对凭据文件的 deny。
    // 旧实现：每轮成功 write 把计数清零 → 风暴永不触发 → 烧满 12 轮。
    // 新实现：ok.txt 的 write 与凭据 deny 指纹不同互不干扰，凭据指纹
    // 每轮 +2，第 3 轮累计 6 次即 fail-fast。
    const responses: ConstructorParameters<typeof StubLlmClient>[0] = [];
    for (let round = 0; round < 12; round += 1) {
      responses.push({
        content: "",
        toolCalls: [
          { name: "write", args: { file_path: okPath, content: `ok-${round}\n` } },
          { name: "read", args: { file_path: envPath } },
          { name: "read", args: { file_path: envPath } },
        ],
      });
    }
    const client = new StubLlmClient(responses);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    assert.equal(result.success, false, "同一目标累计 6 次 deny 必须判失败");
    assert.match(result.error ?? "", /拒绝风暴/, `应醒目标注拒绝风暴根因，实际：${result.error}`);
    // 错误信息必须点名的被拒目标
    assert.match(result.error ?? "", /read:.*\.env\.sensitive/, `风暴信息应含被拒目标指纹，实际：${result.error}`);
    // fail-fast：3 轮（6 次同目标 deny）即停，合法穿插不再给风暴"续命"
    assert.ok(result.llmRequests <= 3, `同目标风暴应在 3 轮内终止，实际 llmRequests=${result.llmRequests}`);
    assert.ok(fs.existsSync(okPath), "穿插的合法 write 必须真实落盘（风暴不误伤正常调用）");
  } finally {
    cleanup(projectRoot);
  }
});

test("E12. 风暴按指纹分组：两个不同目标各 deny 5 次（均 < 阈值）不误伤，终态成功", async () => {
  const projectRoot = createGitProject();
  const envPathA = path.join(projectRoot, ".env.alpha");
  const envPathB = path.join(projectRoot, ".env.beta");
  try {
    fs.writeFileSync(envPathA, "SECRET_TOKEN=A\n");
    fs.writeFileSync(envPathB, "SECRET_TOKEN=B\n");
    // 3 轮 × 每轮 2 个目标各 1 次 deny → 每个指纹各 3 次；再加 1 轮交替 4 次
    // → 每指纹各 5 次，均 < 阈值 6 → 不触发风暴（分组独立性）；第 4 轮终态。
    const responses: ConstructorParameters<typeof StubLlmClient>[0] = [
      {
        content: "",
        toolCalls: [
          { name: "read", args: { file_path: envPathA } },
          { name: "read", args: { file_path: envPathB } },
        ],
      },
      {
        content: "",
        toolCalls: [
          { name: "read", args: { file_path: envPathA } },
          { name: "read", args: { file_path: envPathB } },
        ],
      },
      {
        content: "",
        toolCalls: [
          { name: "read", args: { file_path: envPathA } },
          { name: "read", args: { file_path: envPathB } },
        ],
      },
      {
        content: "",
        toolCalls: [
          { name: "read", args: { file_path: envPathA } },
          { name: "read", args: { file_path: envPathB } },
          { name: "read", args: { file_path: envPathA } },
          { name: "read", args: { file_path: envPathB } },
        ],
      },
      { content: "完成" },
    ];
    const client = new StubLlmClient(responses);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    // 每指纹各 5 次 deny（< 阈值 6）→ 不触发风暴，任务以正常终态成功
    assert.equal(result.success, true, `不同目标各自 < 阈值不得误触发风暴，实际：${result.error}`);
    assert.equal(result.llmRequests, 5);
  } finally {
    cleanup(projectRoot);
  }
});

test("E13. bash 开放（用户决策 2026-10-03）：shell 类任务不再拒绝，推送能力提示后正常执行", async () => {
  const projectRoot = createGitProject();
  const markerPath = path.join(projectRoot, "deploy.marker");
  try {
    // 桩客户端：第 1 轮 bash echo 写 marker（常规命令应真实执行），第 2 轮终态
    const client = new StubLlmClient([
      {
        content: "",
        toolCalls: [{ name: "bash", args: { command: `echo done > ${JSON.stringify(markerPath)}` } }],
      },
      { content: "已完成部署准备命令执行。" },
    ]);
    const progressEvents: { phase: string; previewText: string; thinkingText: string }[] = [];
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      onTaskProgress: (event) =>
        progressEvents.push({ phase: event.phase, previewText: event.previewText, thinkingText: event.thinkingText }),
    });

    const input: P5TaskExecutionInput = Object.freeze({
      projectRoot,
      runId: "unit-run-bash",
      iterIndex: 0,
      stage: "dev",
      objective: "在远程服务器部署推理环境",
      taskId: "T-001",
      taskTitle: "docker pull 镜像并安装 CUDA 驱动",
      acceptanceCriteria: Object.freeze(["容器正常运行"]),
      abortFlagPath: path.join(projectRoot, ".eag", "p5", "abort.flag"),
    });

    const result = await executor.executeTask(input);

    // 不再 fatal 拒绝：任务正常执行到终态（bash 已开放，docker/安装类任务直接执行）
    assert.equal(result.success, true, `shell 类任务应正常执行，实际 error=${result.error}`);
    assert.equal(result.llmRequests, 2);
    assert.ok(fs.existsSync(markerPath), "常规 bash 命令必须真实执行（echo 重定向落盘 marker）");

    // 「思考过程」区必须收到能力提示（告知将通过 bash 真实执行命令）
    const hint = progressEvents.find((e) => e.thinkingText.includes("能力提示"));
    assert.ok(hint, `进度事件应含能力提示，实际：${JSON.stringify(progressEvents.map((e) => e.previewText))}`);
    assert.match(hint.thinkingText, /容器|安装/, "能力提示应列出命中的 shell 语义类别");
    assert.match(hint.thinkingText, /人工确认/, "能力提示应说明高危命令有人工确认闸门");
  } finally {
    cleanup(projectRoot);
  }
});

test("E14. bash 高危命令无确认通道：fail-closed deny，命令绝不执行", async () => {
  const projectRoot = createGitProject();
  const markerPath = path.join(projectRoot, "pwned.marker");
  try {
    // 注入命中黑名单的命令（shred 销毁文件）：未注入 dangerousCommandApproval
    // → 权限钩子直接 deny，命令绝不执行（marker 不存在即证明）
    const injectedCommand = `node -e "require('fs').writeFileSync(${JSON.stringify(markerPath)},'x')" && shred ${JSON.stringify(markerPath)}`;
    const client = new StubLlmClient([
      { content: "", toolCalls: [{ name: "bash", args: { command: injectedCommand } }] },
      { content: "高危命令被拒绝，结束。" },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    assert.equal(result.success, true, "deny 回灌后模型终态，任务本身正常收尾");
    assert.ok(!fs.existsSync(markerPath), "高危命令被 deny，注入命令绝不能执行产生 marker");
    // 拒绝语义必须回灌给模型（tool 消息含拒绝文案），供模型改用安全替代方案
    const toolMessages = client
      .getRequests()
      .slice(1)
      .flatMap((req: any) => req.messages ?? [])
      .filter((m: any) => m.role === "tool");
    assert.ok(
      toolMessages.some((m: any) => /拒绝|deny/i.test(String(m.content))),
      "高危命令 deny 结果必须回灌模型"
    );
  } finally {
    cleanup(projectRoot);
  }
});

test("E15. bash 高危命令人工批准：确认后真实执行；人工拒绝：deny 且不执行", async () => {
  // 场景 A：宿主确认回调返回 true → 命令真实执行（echo 重定向落盘 marker）
  const projectRootA = createGitProject();
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-p5-e15-"));
  const markerA = path.join(markerDir, "approved.marker");
  // 命令含 sudo（黑名单"全局/提权安装"）但实际无害：用 sudo -n true 验证拦截语义，
  // 再附加安全部分验证放行后真实执行——拆两条命令避免真实 sudo 交互。
  const riskyCommandA = `sudo -n true; echo ok > ${JSON.stringify(markerA)}`;
  try {
    const approvalCalls: { command: string; risk: string; taskId: string }[] = [];
    const client = new StubLlmClient([
      { content: "", toolCalls: [{ name: "bash", args: { command: riskyCommandA } }] },
      { content: "完成。" },
    ]);
    const executor = new LlmTaskExecutor({
      projectRoot: projectRootA,
      createLlmClient: () => client,
      dangerousCommandApproval: async (request) => {
        approvalCalls.push({ command: request.command, risk: request.risk, taskId: request.taskId });
        return true; // 人类批准
      },
    });
    const result = await executor.executeTask(buildExecutionInput(projectRootA));
    assert.equal(result.success, true);
    assert.equal(approvalCalls.length, 1, "高危命令必须恰好触发一次人工确认");
    assert.match(approvalCalls[0]!.risk, /提权|安装/, `确认请求应含风险类别，实际：${approvalCalls[0]!.risk}`);
    assert.equal(approvalCalls[0]!.taskId, "T-001", "确认请求应携带任务卡上下文");
    // 批准 → handler 真实执行的证据取"命令回灌给模型的 tool 消息"：
    // ok=true 且含 sudo 的 stderr 输出——证明命令进程真实跑过（非 deny 短路）。
    const toolMessages = client
      .getRequests()
      .slice(1)
      .flatMap((req: any) => req.messages ?? [])
      .filter((m: any) => m.role === "tool");
    assert.ok(
      toolMessages.some((m: any) => /"ok":\s*true/.test(String(m.content)) && /sudo/i.test(String(m.content))),
      `人工批准后 bash 命令必须真实执行（tool 回灌应含 ok:true 与 sudo 输出），实际：${JSON.stringify(
        toolMessages.map((m: any) => String(m.content).slice(0, 150))
      )}`
    );
    // 命令副作用断言：批准执行的 echo 必须真实落盘（stale cwd 修复后此断言稳定）
    assert.ok(fs.existsSync(markerA), "人工批准后 bash 命令的 echo 副作用必须真实落盘");
  } finally {
    cleanup(projectRootA);
    try {
      fs.rmSync(markerDir, { recursive: true, force: true });
    } catch {
      // 容错
    }
  }

  // 场景 B：宿主确认回调返回 false → deny，命令绝不执行
  const projectRootB = createGitProject();
  const markerB = path.join(projectRootB, "rejected.marker");
  try {
    const client = new StubLlmClient([
      { content: "", toolCalls: [{ name: "bash", args: { command: `shred ${JSON.stringify(markerB)}` } }] },
      { content: "用户拒绝，结束。" },
    ]);
    const executor = new LlmTaskExecutor({
      projectRoot: projectRootB,
      createLlmClient: () => client,
      dangerousCommandApproval: async () => false, // 人类拒绝
    });
    const result = await executor.executeTask(buildExecutionInput(projectRootB));
    assert.equal(result.success, true);
    assert.ok(!fs.existsSync(markerB), "人工拒绝后高危命令绝不能执行");
  } finally {
    cleanup(projectRootB);
  }
});

test("E16. stale cwd 回归（修复 2026-10-04）：同合成 sessionId 的前序项目目录被删除后，后续任务 bash 仍真实执行", async () => {
  // 根因：bash-handler 模块级 sessionWorkingDirs 按 sessionId 缓存 cwd；
  // P5 执行器合成 sessionId（p5-<runId>-i<iter>-<stage>）跨任务相同，
  // 前序任务的临时项目目录被清理删除后缓存残留 stale 路径，
  // spawn 的 cwd 指向不存在目录时 Node 报出误导性的 `spawn <shell> ENOENT`。
  // 本用例用同一 buildExecutionInput（同 runId/iterIndex/stage → 同 sessionId）
  // 复刻该场景：case-1 执行 bash 后删除其项目目录，case-2 必须不受污染。
  const projectRootFirst = createGitProject();
  const projectRootSecond = createGitProject();
  try {
    // 第一轮：正常执行 bash，cwd 缓存写入 projectRootFirst
    const clientFirst = new StubLlmClient([
      { content: "", toolCalls: [{ name: "bash", args: { command: "echo first" } }] },
      { content: "完成。" },
    ]);
    const executorFirst = new LlmTaskExecutor({ projectRoot: projectRootFirst, createLlmClient: () => clientFirst });
    const resultFirst = await executorFirst.executeTask(buildExecutionInput(projectRootFirst));
    assert.equal(resultFirst.success, true, "第一轮 bash 应成功");

    // 模拟编排器清理前序任务的临时项目目录（缓存中残留 stale cwd）
    cleanup(projectRootFirst);

    // 第二轮：同合成 sessionId 的新任务，新目录。修复前必现 spawn ENOENT。
    const markerSecond = path.join(projectRootSecond, "cwd-clean.marker");
    const clientSecond = new StubLlmClient([
      { content: "", toolCalls: [{ name: "bash", args: { command: `echo ok > ${JSON.stringify(markerSecond)}` } }] },
      { content: "完成。" },
    ]);
    const executorSecond = new LlmTaskExecutor({ projectRoot: projectRootSecond, createLlmClient: () => clientSecond });
    const resultSecond = await executorSecond.executeTask(buildExecutionInput(projectRootSecond));
    assert.equal(resultSecond.success, true, "第二轮任务应成功（stale cwd 已被防御回退）");

    // bash 真实执行证据：tool 回灌 ok:true 且副作用落盘
    const toolMessages = clientSecond
      .getRequests()
      .slice(1)
      .flatMap((req: any) => req.messages ?? [])
      .filter((m: any) => m.role === "tool");
    assert.ok(
      toolMessages.some((m: any) => /"ok":\s*true/.test(String(m.content))),
      `stale cwd 场景下 bash 必须真实执行（tool 回灌应含 ok:true），实际：${JSON.stringify(
        toolMessages.map((m: any) => String(m.content).slice(0, 200))
      )}`
    );
    assert.ok(fs.existsSync(markerSecond), "stale cwd 场景下 bash 副作用必须真实落盘");
  } finally {
    cleanup(projectRootFirst);
    cleanup(projectRootSecond);
  }
});

// ============================================================================
// 3. onTaskProgress 进度回调（Web UI 分流进展显示，2026-10-03）
// ============================================================================

test("P1. onTaskProgress：正常 write→终态任务应推送 task_start / llm_request / tool_execution / task_end 四类进度", async () => {
  const projectRoot = createGitProject();
  try {
    const targetAbsolutePath = path.join(projectRoot, "src", "answer.js");
    const fileContent = "module.exports = () => 42;\n";

    const client = new StubLlmClient([
      {
        content: "",
        toolCalls: [{ name: "write", args: { file_path: targetAbsolutePath, content: fileContent } }],
      },
      { content: "已创建 src/answer.js。" },
    ]);

    /** 进度事件真实收集（非断言替身——验证的就是这个数组的内容） */
    const progressEvents: { phase: string; previewText: string; thinkingText: string }[] = [];
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      onTaskProgress: (event) => {
        progressEvents.push({
          phase: event.phase,
          previewText: event.previewText,
          thinkingText: event.thinkingText,
        });
      },
    });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));
    assert.equal(result.success, true);

    // 1. 四类进度相位全部出现且顺序正确
    const phases = progressEvents.map((e) => e.phase);
    assert.ok(phases.includes("task_start"), "缺少 task_start");
    assert.ok(phases.includes("llm_request"), "缺少 llm_request");
    assert.ok(phases.includes("tool_execution"), "缺少 tool_execution");
    assert.ok(phases.includes("task_end"), "缺少 task_end");
    assert.equal(phases[0], "task_start", "首个进度必须是 task_start");
    assert.equal(phases[phases.length - 1], "task_end", "末个进度必须是 task_end");

    // 2. task_start 的 previewText 包含任务卡信息
    const start = progressEvents.find((e) => e.phase === "task_start")!;
    assert.ok(start.previewText.includes("T-001"), "task_start 应含任务卡 ID");
    assert.ok(start.thinkingText.includes("dev"), "task_start thinkingText 应含阶段名");

    // 3. tool_execution 的 thinkingText 包含工具名与文件路径摘要
    const toolEvents = progressEvents.filter((e) => e.phase === "tool_execution");
    assert.ok(toolEvents.length >= 1, "至少一次 tool_execution 进度");
    const toolThinking = toolEvents[0].thinkingText;
    assert.ok(toolThinking.includes("write"), "tool_execution 应含工具名 write");

    // 4. task_end 的 thinkingText 包含"任务正常结束"语义
    const end = progressEvents.find((e) => e.phase === "task_end")!;
    assert.ok(
      end.thinkingText.includes("终态回复") || end.thinkingText.includes("任务正常结束"),
      "task_end thinkingText 应含终态语义"
    );

    // 5. thinkingText 单调累积（后一条包含前一条的内容前缀）
    for (let i = 1; i < progressEvents.length; i += 1) {
      const prev = progressEvents[i - 1].thinkingText;
      const cur = progressEvents[i].thinkingText;
      assert.ok(
        cur.startsWith(prev) || prev === "" || cur.includes(prev.split("\n")[0]),
        `thinkingText 应保持累积语义（第 ${i} 条应以前一条为基础）`
      );
    }
  } finally {
    cleanup(projectRoot);
  }
});

test("P2. onTaskProgress：轮数上限失败时推送 task_end 且 previewText 含失败原因", async () => {
  const projectRoot = createGitProject();
  try {
    // 脚本：全部轮次持续调用工具，永不给出终态（maxToolRounds 收窄为 2 加速测试）
    const toolCallRound = {
      content: "",
      toolCalls: [{ name: "read", args: { file_path: path.join(projectRoot, "nonexist.js") } }],
    };
    const client = new StubLlmClient([toolCallRound, toolCallRound, toolCallRound]);

    const progressEvents: { phase: string; previewText: string }[] = [];
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 2,
      onTaskProgress: (event) => progressEvents.push({ phase: event.phase, previewText: event.previewText }),
    });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));
    assert.equal(result.success, false, "轮数上限必须判失败");

    const end = progressEvents[progressEvents.length - 1];
    assert.equal(end.phase, "task_end", "失败终态也须推送 task_end");
    assert.ok(end.previewText.includes("上限"), `task_end previewText 应含失败原因，实际：${end.previewText}`);
  } finally {
    cleanup(projectRoot);
  }
});

test("P3. onTaskProgress 未注入（默认无操作）：任务执行不受影响（零回归）", async () => {
  const projectRoot = createGitProject();
  try {
    const client = new StubLlmClient([{ content: "直接终态，无工具调用。" }]);
    // 不传 onTaskProgress——构造的默认 noop 回调不得抛异常
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));
    assert.equal(result.success, true);
    assert.equal(result.llmRequests, 1);
  } finally {
    cleanup(projectRoot);
  }
});

/**
 * E3d. 只读放行前缀 + 凭据守卫协同（2026-10-04 安全加固回归）
 *
 * 场景：LLM 试图读取 /tmp/.env、/tmp/secrets.key 等越出牢笼但命中只读放行前缀的
 *       凭据文件——只读放行绝不能架空凭据守卫（原代码在只读放行命中后直接 return "approve"
 *       跳过第四层凭据判定，属于安全漏洞）。
 *
 * 验证：越出牢笼 + 命中 /tmp 前缀 + basename 命中凭据模式 → 必须 deny，
 *       同时越出牢笼 + 命中 /tmp 前缀 + basename 非凭据文件 → 正常 approve（只读放行）。
 *
 * 安全边界：本测试不碰生产环境 /tmp 下真实凭据文件——项目本身不在 /tmp 下，
 *       创建的 .env / secrets 都是测试临时路径，但 basename 匹配凭据模式，
 *       足以验证守卫协同逻辑。
 */
test("E3d. 只读放行 + 凭据守卫协同：/tmp/.env、/tmp/private.key 越界凭据文件必须 deny", async () => {
  const projectRoot = createGitProject();
  // 真实预置 /tmp 下的凭据文件（文件名命中 CREDENTIAL_FILE_PATTERNS）
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-p5-cred-readonly-"));
  const tmpEnvPath = path.join(tmpDir, ".env");
  const tmpKeyPath = path.join(tmpDir, "private.pem");
  const tmpLogPath = path.join(tmpDir, "verify.log"); // 非凭据，对照验证只读放行仍工作
  fs.writeFileSync(tmpEnvPath, "SECRET=should-not-be-readable\n");
  fs.writeFileSync(tmpKeyPath, "-----BEGIN PRIVATE KEY-----\n");
  fs.writeFileSync(tmpLogPath, "safe content\n");
  try {
    // Stub 脚本：模型依次尝试读取 /tmp/.env、/tmp/private.pem、/tmp/verify.log
    // 预期：前两个凭据文件被 deny，第三个安全日志被 approve
    const client = new StubLlmClient([
      {
        content: "",
        toolCalls: [
          { name: "read", args: { file_path: tmpEnvPath } },
          { name: "read", args: { file_path: tmpKeyPath } },
          { name: "read", args: { file_path: tmpLogPath } },
        ],
      },
      { content: "凭据文件被拒绝，安全日志可读。" },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));
    assert.equal(result.success, true);

    // 验证 3 个 read 调用的权限判定结果
    const toolMessages = client
      .getRequests()
      .slice(1)
      .flatMap((req: any) => req.messages ?? [])
      .filter((m: any) => m.role === "tool");
    assert.equal(toolMessages.length, 3, "3 次 read 应有 3 条 tool 结果回灌");

    // 第 1 条：/tmp/.env → 凭据 deny
    const envResult = String(toolMessages[0]!.content);
    assert.match(envResult, /拒绝|deny|凭据|权限/i, `/tmp/.env 必须被凭据守卫拒绝，实际：${envResult.slice(0, 120)}`);
    assert.ok(!/SECRET=should-not-be-readable/.test(envResult), "被拒绝的凭据内容绝不能泄露到模型");

    // 第 2 条：/tmp/private.pem → 凭据 deny
    const keyResult = String(toolMessages[1]!.content);
    assert.match(
      keyResult,
      /拒绝|deny|凭据|权限/i,
      `/tmp/private.pem 必须被凭据守卫拒绝，实际：${keyResult.slice(0, 120)}`
    );
    assert.ok(!/BEGIN PRIVATE KEY/.test(keyResult), "被拒绝的密钥内容绝不能泄露到模型");

    // 第 3 条：/tmp/verify.log → 只读放行 approve
    const logResult = String(toolMessages[2]!.content);
    assert.ok(
      !/拒绝|deny|凭据|权限/i.test(logResult),
      `/tmp/verify.log（非凭据）应被只读放行 approve，实际：${logResult.slice(0, 120)}`
    );
    assert.match(logResult, /safe content/, "只读放行的安全文件内容应真实回灌");
  } finally {
    cleanup(projectRoot);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 容错
    }
  }
});
