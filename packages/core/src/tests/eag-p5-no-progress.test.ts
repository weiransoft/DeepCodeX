/**
 * EAG-P5 无进展熔断单元测试（2026-11 修复「dev 阶段模型每轮换一条不同的 bash
 * 命令、连续 12+ 轮零产出」空转事故）。
 *
 * 真实性边界（与现有 EAG-P5 测试同构，禁止 mock/占位/简化）：
 * - LLM HTTP 边界：StubLlmClient 按脚本返回响应（唯一允许的替换点）；
 * - ToolExecutor / read / write / bash / 文件系统 / git：全部生产真实实现；
 * - git 仓库用真实 `git init`，工作区快照由真实 `git status --porcelain -uall` 采集；
 * - 权限钩子（白名单 / 路径牢笼 / 凭据模式）走生产 onBeforeToolExecution 判定。
 *
 * 覆盖：
 * - N1 每轮换不同 bash 命令、结果相同、工作区无变化 → 第 4 轮无进展熔断；
 * - N2 不同 read 返回不同内容（Z10 同型）→ 不误伤，正常成功；
 * - N3 每轮 write 不同文件（工作区快照变化）→ 不误伤，正常成功；
 * - N4 dev 阶段带 feedback → 首条 user 提示词注入反馈 + 「既有改动上继续修」；
 * - N5 fix 阶段 feedback 仍注入（回归保护）；
 * - N6 连续 3 轮完全相同调用仍由「相同调用空转熔断」优先触发（不回归 Z9）；
 * - N7 无 feedback 时不插入任何失败反馈行；
 * - N8 自定义 noProgressLimit=2 → 第 2 轮即触发（options 解析链生效）；
 * - N9 非 git 仓库：仅按结果指纹判定、阈值 +1、文案注明；
 * - N10 输出确实不同的探索型 bash 命令、不落盘 → 第 6 轮触发轨道 B；
 * - N11 Z10 同型（git 仓库）3 轮 read 不同内容 → 轨道 B 不达阈值、正常成功；
 * - N12 连续 4 轮探索后第 5 轮 write 新文件 → 计数清零、正常成功；
 * - N13 非 git 仓库下轨道 B 禁用：探索轮不触发，只按轨道 A 判定且文案注明。
 *
 * @module core/tests/eag-p5-no-progress
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
// 1. 真实临时项目夹具
// ============================================================================

/** 创建真实临时项目并 git init（工作区进展快照必须基于真实 git 仓库）。 */
function createGitProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eag-noprog-git-"));
  execFileSync("git", ["init", "-q"], { cwd: projectRoot, stdio: "ignore" });
  return projectRoot;
}

/** 创建非 git 的普通临时项目（用于纯提示词断言，不涉及工作区快照）。 */
function createPlainProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eag-noprog-plain-"));
}

/** 递归删除临时目录（容错）。 */
function cleanup(projectRoot: string): void {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // 清理失败不影响断言结论
  }
}

/** 构造执行器输入（端口契约最小完整真实值），可覆盖 stage / feedback 等字段。 */
function buildInput(
  projectRoot: string,
  overrides: Readonly<Partial<P5TaskExecutionInput>> = {}
): P5TaskExecutionInput {
  return Object.freeze({
    projectRoot,
    runId: "noprog-run-001",
    iterIndex: 0,
    stage: "dev" as const,
    objective: "无进展熔断用例目标",
    taskId: "T-001",
    taskTitle: "无进展熔断用例",
    acceptanceCriteria: Object.freeze([]) as ReadonlyArray<string>,
    abortFlagPath: path.join(projectRoot, ".eag", "p5", "abort.flag"),
    ...overrides,
  }) as P5TaskExecutionInput;
}

/** 取 StubLlmClient 首条请求的 user 提示词（buildUserPrompt 产物）。 */
function firstUserPrompt(client: StubLlmClient): string {
  const request = client.getRequests()[0];
  assert.ok(request, "至少应发生一次 LLM 请求");
  const userMessage = request.messages.find((message) => message.role === "user");
  assert.ok(userMessage, "首条请求应含 user 消息");
  return String(userMessage.content ?? "");
}

// ============================================================================
// 2. 无进展熔断主路径
// ============================================================================

test("N1. 每轮换不同 bash 命令、结果相同且工作区无变化 → 第 4 轮触发无进展熔断", async () => {
  const projectRoot = createGitProject();
  try {
    // 4 条命令文本各不相同：batchFingerprint（工具名+参数）逐轮重置，旧的
    // 「相同调用空转熔断」(阈值 3) 永不触发——这正是真实事故形态。
    // 四条命令都无 stdout、exitCode=0、不落盘：
    //   resultFingerprint（ok + content 首尾 512，deadlineAt 已中性化）逐轮相同；
    //   git status 快照逐轮相同（工作区零变更）。
    // → 连续 4 轮无进展，默认阈值 4 在第 4 轮工具执行后收口。
    const client = new StubLlmClient([
      { content: "", toolCalls: [{ name: "bash", args: { command: "true" } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command: ":" } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command: "printf ''" } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command: "echo -n ''" } }] },
    ]);
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 12,
    });

    const result = await executor.executeTask(buildInput(projectRoot));

    assert.equal(result.success, false, "换命令零产出必须诚实判失败");
    assert.equal(result.llmRequests, 4, "默认阈值 4：第 4 轮工具执行后立即收口，不烧第 5-12 轮");
    assert.match(result.error ?? result.summary, /无进展熔断/, `失败文案须含「无进展熔断」：${result.error}`);
  } finally {
    cleanup(projectRoot);
  }
});

test("N2. 不同 read 返回不同内容（Z10 同型）→ 不触发无进展熔断，正常成功", async () => {
  const projectRoot = createGitProject();
  try {
    fs.writeFileSync(path.join(projectRoot, "a.txt"), "A", "utf8");
    fs.writeFileSync(path.join(projectRoot, "b.txt"), "B", "utf8");
    fs.writeFileSync(path.join(projectRoot, "c.txt"), "C", "utf8");
    // 同名工具（read）但目标文件与返回内容各不相同 → resultFingerprint 每轮不同，
    // 不应被判为「结果与快照均无变化」。
    const client = new StubLlmClient([
      { content: "", toolCalls: [{ name: "read", args: { file_path: "a.txt" } }] },
      { content: "", toolCalls: [{ name: "read", args: { file_path: "b.txt" } }] },
      { content: "", toolCalls: [{ name: "read", args: { file_path: "c.txt" } }] },
      { content: "已读取三个文件，任务完成。" },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildInput(projectRoot));

    assert.equal(result.success, true, `读到不同内容不是空转：${result.summary} ${result.error ?? ""}`);
    assert.equal(result.llmRequests, 4);
  } finally {
    cleanup(projectRoot);
  }
});

test("N3. 每轮 write 不同文件（工作区快照变化）→ 不触发无进展熔断，正常成功", async () => {
  const projectRoot = createGitProject();
  try {
    // 每轮写入新文件：git status 快照逐轮新增一行（progressSnapshot 变化），
    // 且 write 结果含不同路径（resultFingerprint 变化）→ 每轮都判「有进展」。
    const client = new StubLlmClient([
      {
        content: "",
        toolCalls: [{ name: "write", args: { file_path: path.join(projectRoot, "f1.txt"), content: "one" } }],
      },
      {
        content: "",
        toolCalls: [{ name: "write", args: { file_path: path.join(projectRoot, "f2.txt"), content: "two" } }],
      },
      {
        content: "",
        toolCalls: [{ name: "write", args: { file_path: path.join(projectRoot, "f3.txt"), content: "three" } }],
      },
      { content: "已写入三个文件，任务完成。" },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildInput(projectRoot));

    assert.equal(result.success, true, `产生真实文件变更不是空转：${result.summary} ${result.error ?? ""}`);
    assert.equal(result.llmRequests, 4);
    assert.ok(fs.existsSync(path.join(projectRoot, "f3.txt")), "第三个文件应真实落盘");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 3. feedback 注入不再限 stage
// ============================================================================

test("N4. dev 阶段带 feedback → 首条 user 提示词含反馈文本与「既有改动上继续修」", async () => {
  const projectRoot = createPlainProject();
  try {
    const feedback = "验证失败：test/foo.spec.ts 第 12 行断言，期望 1 实际 2";
    const client = new StubLlmClient([{ content: "完成。" }]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildInput(projectRoot, { stage: "dev", feedback }));

    assert.equal(result.success, true);
    const prompt = firstUserPrompt(client);
    assert.ok(prompt.includes(feedback), `dev 提示词必须注入跨 run 失败反馈：${prompt}`);
    assert.match(prompt, /既有改动上继续修/, "dev 措辞应为「在既有改动上继续修，不要从零重跑整卡」");
  } finally {
    cleanup(projectRoot);
  }
});

test("N5. fix 阶段 feedback 仍注入（回归保护）", async () => {
  const projectRoot = createPlainProject();
  try {
    const feedback = "验证失败：npm test 退出码 1，TypeError: foo is not a function";
    const client = new StubLlmClient([{ content: "完成。" }]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildInput(projectRoot, { stage: "fix", feedback }));

    assert.equal(result.success, true);
    const prompt = firstUserPrompt(client);
    assert.ok(prompt.includes(feedback), `fix 提示词必须注入失败反馈：${prompt}`);
    assert.match(prompt, /请据此修复，不要重复导致失败的做法/, "fix 措辞保持原样");
  } finally {
    cleanup(projectRoot);
  }
});

test("N7. 无 feedback 时提示词不插入任何失败反馈行", async () => {
  const projectRoot = createPlainProject();
  try {
    const client = new StubLlmClient([{ content: "完成。" }]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildInput(projectRoot, { stage: "dev" }));

    assert.equal(result.success, true);
    const prompt = firstUserPrompt(client);
    assert.doesNotMatch(prompt, /本任务此前的验证失败反馈/, `无 feedback 不应插入反馈行：${prompt}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 4. 与既有「相同调用空转熔断」的优先级
// ============================================================================

test("N6. 连续 3 轮完全相同调用仍由「相同调用空转熔断」优先触发（不回归 Z9）", async () => {
  const projectRoot = createGitProject();
  try {
    // 与 Z9 同型：3 轮完全相同的 `bash ls -la`。相同调用阈值 3 < 无进展阈值 4，
    // 且相同调用判定在代码顺序上先于无进展判定 → 第 3 轮由相同调用熔断收口。
    const client = new StubLlmClient([
      { content: "", toolCalls: [{ name: "bash", args: { command: "ls -la" } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command: "ls -la" } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command: "ls -la" } }] },
    ]);
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 12,
    });

    const result = await executor.executeTask(buildInput(projectRoot));

    assert.equal(result.success, false);
    assert.equal(result.llmRequests, 3, "第 3 轮立即终止");
    assert.match(result.error ?? result.summary, /相同调用空转熔断/);
    assert.doesNotMatch(result.error ?? result.summary, /无进展熔断/, "无进展熔断不得抢先");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 5. 配置解析链（options 通道）
// ============================================================================

test("N8. 自定义 noProgressLimit=2 → 第 2 轮即触发（options 解析链生效）", async () => {
  const projectRoot = createGitProject();
  try {
    const client = new StubLlmClient([
      { content: "", toolCalls: [{ name: "bash", args: { command: "true" } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command: ":" } }] },
    ]);
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      noProgressLimit: 2,
      maxToolRounds: 12,
    });

    const result = await executor.executeTask(buildInput(projectRoot));

    assert.equal(result.success, false);
    assert.equal(result.llmRequests, 2, "options.noProgressLimit=2 时第 2 轮即收口");
    assert.match(result.error ?? result.summary, /无进展熔断/);
  } finally {
    cleanup(projectRoot);
  }
});

test("N9. 非 git 仓库：仅按结果指纹判定、阈值 +1，第 5 轮触发且文案注明", async () => {
  const projectRoot = createPlainProject();
  try {
    // 非 git 仓库是合法场景：工作区快照不可用（null），不因此判空转；
    // 仅按结果指纹判定且阈值 = 默认 4 + 1 = 5，文案须注明该口径。
    const client = new StubLlmClient([
      { content: "", toolCalls: [{ name: "bash", args: { command: "true" } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command: ":" } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command: "printf ''" } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command: "echo -n ''" } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command: 'echo -n ""' } }] },
    ]);
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 12,
    });

    const result = await executor.executeTask(buildInput(projectRoot));

    assert.equal(result.success, false);
    assert.equal(result.llmRequests, 5, "非 git 仓库阈值 +1：第 5 轮收口");
    assert.match(result.error ?? result.summary, /无进展熔断/);
    assert.match(result.error ?? result.summary, /非 git 仓库，仅按结果指纹判定/);
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 6. 探索型空转（轨道 B）：命令输出变化但工作区连续无变化
// ============================================================================

test("N10. 输出确实不同的探索型 bash 命令、不落盘 → 第 6 轮触发轨道 B", async () => {
  const projectRoot = createGitProject();
  try {
    // 真实事故形态：每轮换一条不同命令（ls / pwd / find / echo / ls -la），
    // 输出确实不同 → 结果指纹逐轮不同，轨道 A 恒清零；但都不落盘，
    // git 工作区快照连续无变化 → 轨道 B 逐轮累计，第 6 轮(noProgressLimit+2)收口。
    const commands = ["ls", "pwd", "echo distinct-A", "find . -maxdepth 1", "echo distinct-B", "ls -la"];
    const client = new StubLlmClient(
      commands.map((command) => ({ content: "", toolCalls: [{ name: "bash", args: { command } }] }))
    );
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 12,
    });

    const result = await executor.executeTask(buildInput(projectRoot));

    assert.equal(result.success, false, "输出变化但零产出的探索型空转必须判失败");
    assert.equal(result.llmRequests, 6, "轨道 B 阈值 6：第 6 轮收口");
    assert.match(result.error ?? result.summary, /无进展熔断/);
    assert.match(result.error ?? result.summary, /命令输出变化但工作区连续/, "成因须为探索型空转而非结果重复");
  } finally {
    cleanup(projectRoot);
  }
});

test("N11. Z10 同型（git 仓库）：3 轮 read 不同内容 + 终态 → 轨道 B 不达阈值、正常成功", async () => {
  const projectRoot = createGitProject();
  try {
    // 特意用 git 仓库让轨道 B 处于启用态：3 轮探索累计 explorationStreak=3 < 6，
    // 不得触发（团队要求「轨道 B 阈值 6 > Z10 的 3 轮 read」）。
    fs.writeFileSync(path.join(projectRoot, "a.txt"), "A", "utf8");
    fs.writeFileSync(path.join(projectRoot, "b.txt"), "B", "utf8");
    fs.writeFileSync(path.join(projectRoot, "c.txt"), "C", "utf8");
    const client = new StubLlmClient([
      { content: "", toolCalls: [{ name: "read", args: { file_path: "a.txt" } }] },
      { content: "", toolCalls: [{ name: "read", args: { file_path: "b.txt" } }] },
      { content: "", toolCalls: [{ name: "read", args: { file_path: "c.txt" } }] },
      { content: "已读取三个文件，任务完成。" },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildInput(projectRoot));

    assert.equal(result.success, true, `读到不同内容不是空转：${result.summary} ${result.error ?? ""}`);
    assert.equal(result.llmRequests, 4);
  } finally {
    cleanup(projectRoot);
  }
});

test("N12. 连续 4 轮探索后第 5 轮 write 新文件 → 计数清零、正常成功、不触发", async () => {
  const projectRoot = createGitProject();
  try {
    const target = path.join(projectRoot, "written.txt");
    const client = new StubLlmClient([
      { content: "", toolCalls: [{ name: "bash", args: { command: "echo explore-1" } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command: "echo explore-2" } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command: "echo explore-3" } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command: "echo explore-4" } }] },
      { content: "", toolCalls: [{ name: "write", args: { file_path: target, content: "done" } }] },
      { content: "已写入文件，任务完成。" },
    ]);
    const executor = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });

    const result = await executor.executeTask(buildInput(projectRoot));

    assert.equal(result.success, true, `第 5 轮真实写入应打断探索计数：${result.error ?? ""}`);
    assert.equal(result.llmRequests, 6);
    assert.ok(fs.existsSync(target), "write 必须真实落盘");
  } finally {
    cleanup(projectRoot);
  }
});

test("N13. 非 git 仓库下轨道 B 禁用：探索轮不触发，只按轨道 A 判定且文案注明", async () => {
  const projectRoot = createPlainProject();
  try {
    // 前 6 轮：输出各不相同的探索命令。若轨道 B 未禁用，第 6 轮就会被
    // 「命令输出变化」成因收口；禁用后必须不触发。
    // 后 6 轮：输出恒为空的命令（结果指纹相同）→ 仅轨道 A 累计，第 12 轮收口。
    const exploration = ["ls", "pwd", "echo e1", "echo e2", "echo e3", "echo e4"];
    const repeated = ["true", ":", "printf ''", "echo -n ''", 'echo -n ""', "true "];
    const client = new StubLlmClient([
      ...exploration.map((command) => ({ content: "", toolCalls: [{ name: "bash", args: { command } }] })),
      ...repeated.map((command) => ({ content: "", toolCalls: [{ name: "bash", args: { command } }] })),
    ]);
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 20,
    });

    const result = await executor.executeTask(buildInput(projectRoot));

    assert.equal(result.success, false);
    assert.equal(result.llmRequests, 12, "前 6 轮探索未被轨道 B 收口（B 禁用），第 12 轮由轨道 A 收口");
    assert.match(result.error ?? result.summary, /无进展熔断/);
    assert.match(result.error ?? result.summary, /非 git 仓库，仅按结果指纹判定/);
    assert.doesNotMatch(result.error ?? result.summary, /命令输出变化但工作区连续/, "不得走轨道 B 成因");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// 7. 相同调用熔断的结果维度（2026-11-10 修复"重复调用但输出/状态有变化被误熔断"）
// ============================================================================

/** 在临时工作区外建一个计数器文件路径（计数器在 git 工作区外，不污染快照）。 */
function createExternalCounterPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eag-noprog-counter-")), "counter");
}

test("N14. 相同调用但输出变化（轮询/等待型命令）→ 不触发相同调用熔断，正常收尾", async () => {
  const projectRoot = createGitProject();
  const counterFile = createExternalCounterPath();
  try {
    // 同一条命令（参数逐字符相同）每轮输出递增——模拟"轮询等待服务就绪"：
    // 调用重复但输出/状态确实在变化，属于合法等待行为。修复前：相同调用熔断
    // 只看「工具名+参数」，第 3 轮即误杀；修复后：结果指纹逐轮不同 → 相同调用
    // 熔断不触发；轨道 B（探索型）计数 3 < 6，第 4 轮模型给出终态回复正常成功。
    const command = `n=$(cat "${counterFile}" 2>/dev/null || echo 0); echo $((n+1)) > "${counterFile}"; echo "tick-$n"`;
    const client = new StubLlmClient([
      { content: "", toolCalls: [{ name: "bash", args: { command } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command } }] },
      { content: "服务已就绪，任务完成。" },
    ]);
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 12,
    });

    const result = await executor.executeTask(buildInput(projectRoot));

    assert.equal(result.success, true, `输出在变化的等待命令不是空转：${result.summary} ${result.error ?? ""}`);
    assert.equal(result.llmRequests, 4, "3 轮等待 + 1 轮终态，不得在第 3 轮被误熔断");
    assert.doesNotMatch(result.error ?? result.summary, /相同调用空转熔断/);
    // 计数器真实递增：证明三轮输出确实各不相同（结果指纹变化是真实发生的事实）
    assert.equal(fs.readFileSync(counterFile, "utf8").trim(), "3", "外部计数器应被真实累加到 3");
  } finally {
    try {
      fs.rmSync(path.dirname(counterFile), { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言结论
    }
    cleanup(projectRoot);
  }
});

test("N15. 相同调用但输出变化且持续不落盘 → 交由轨道 B 收口（第 4 轮，noProgressLimit=2）", async () => {
  const projectRoot = createGitProject();
  const counterFile = createExternalCounterPath();
  try {
    // 与 N14 同型，但模型一直不给出终态：调用相同、输出变化、工作区零变化。
    // 相同调用熔断（结果维度）不再收口，由轨道 B（探索型空转）收口：
    // noProgressLimit=2 → explorationLimit=4 → 第 4 轮触发，成因须为
    // 「命令输出变化但工作区连续无变化」而非「相同调用」。
    const command = `n=$(cat "${counterFile}" 2>/dev/null || echo 0); echo $((n+1)) > "${counterFile}"; echo "tick-$n"`;
    const client = new StubLlmClient([
      { content: "", toolCalls: [{ name: "bash", args: { command } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command } }] },
      { content: "", toolCalls: [{ name: "bash", args: { command } }] },
    ]);
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      noProgressLimit: 2,
      maxToolRounds: 12,
    });

    const result = await executor.executeTask(buildInput(projectRoot));

    assert.equal(result.success, false, "无限等待型轮询终须由轨道 B 诚实收口");
    assert.equal(result.llmRequests, 4, "轨道 B 阈值 4（2+2）：第 4 轮收口");
    assert.match(result.error ?? result.summary, /无进展熔断/);
    assert.match(result.error ?? result.summary, /命令输出变化但工作区连续/, "成因须为探索型空转");
    assert.doesNotMatch(result.error ?? result.summary, /相同调用空转熔断/, "相同调用熔断不得误抢先");
  } finally {
    try {
      fs.rmSync(path.dirname(counterFile), { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言结论
    }
    cleanup(projectRoot);
  }
});
