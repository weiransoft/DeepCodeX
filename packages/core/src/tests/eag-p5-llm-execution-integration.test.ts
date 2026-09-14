/**
 * EAG-P5 LLM 执行链路补全（方案 A）端到端集成测试
 * 设计文档：docs/dev/eag-p5-llm-execution-wiring.md §5（L277-282）
 *
 * 本文件与 eag-p5-llm-executor / eag-p5-llm-execution 的本质区别：
 * - 【禁止】使用 createAlwaysSucceedTaskExecutor 等任何执行器替身；
 * - 使用生产真实装配：AutonomousOrchestrator + 四阶段 Handler + LlmTaskExecutor + ToolExecutor；
 * - 唯一替换点是 LLM HTTP 边界（StubLlmClient 按脚本返回响应），这是任何离线测试
 *   都必须替换的外部网络依赖；工具执行（read/write/edit）、文件系统、git status、
 *   npm test 子进程、tasks.md 状态机、护栏、调度器全部为生产真实实现。
 *
 * 场景 A（合成任务直通）：无 tasks.md → plan 从 objective 合成 T-001 →
 *   dev 经"write 工具调用 + 终态文本"两次真实 LLM 请求落盘 src/math.js →
 *   verify 因项目无测试目标诚实 skip(unverified) → 全绿标记 completed →
 *   下一轮 plan 报 all-tasks-completed 收尾。
 *
 * 场景 B（verify 失败 → fix 带真实失败反馈修复回路）：
 *   package.json 定义 `npm test` → node test.js 对 src/math.js 做行为断言；
 *   dev 首轮写入【错误实现】→ verify 真实失败（exit 1）→
 *   fix 轮执行器收到的 user 消息必须包含 verify 的真实失败输出片段 →
 *   fix 写入正确实现 → 下一轮 dev 空改动终态 + verify 全绿 → completed。
 *
 * @module core/tests/eag-p5-llm-execution-integration
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { LlmTaskExecutor } from "../eag/p5/executors/llm-task-executor";
import { parseTaskCards } from "../eag/p5/index";
import { createTempProject, cleanupTempProject, buildOrchestrator } from "./fixtures/eag-p5-e2e-fixtures";
import { StubLlmClient } from "./fixtures/stub-llm-client";

/**
 * 在临时目录中初始化真实 git 仓库。
 *
 * LlmTaskExecutor 终态时真实执行 `git status --porcelain --untracked-files=all`
 * 检出变更文件；非 git 目录会返回空数组（不判失败），但集成测试必须覆盖
 * 最常见的真实项目形态，故显式 git init（不做 commit，未跟踪文件同样被 porcelain 检出）。
 *
 * @param projectRoot 项目根
 */
function initGitRepo(projectRoot: string): void {
  execFileSync("git", ["init"], { cwd: projectRoot, stdio: ["ignore", "ignore", "ignore"] });
}

test("INT-A. 合成任务直通：真实 write 落盘 → 诚实 skip → markTaskCompleted → all-tasks-completed 收尾", async () => {
  const projectRoot = createTempProject("eag-p5-int-a-");
  try {
    initGitRepo(projectRoot);
    assert.ok(!fs.existsSync(path.join(projectRoot, "package.json")), "场景前提：项目无 package.json");

    // 桩脚本（仅替换 HTTP）：
    // 请求 0：模型决定调用 write 工具，在项目牢笼内真实创建 src/math.js
    //         （write 工具协议要求绝对路径，system prompt 已告知工作目录绝对路径）
    // 请求 1：看到工具成功回灌后给出终态文本（无工具调用 = 执行结束）
    const mathFileAbs = path.join(projectRoot, "src", "math.js");
    const client = new StubLlmClient([
      {
        content: "我将创建加法实现文件。",
        toolCalls: [
          {
            name: "write",
            args: {
              file_path: mathFileAbs,
              content:
                "// 由 P5 LLM 执行器真实写入（集成测试 INT-A）\n" +
                "function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n",
            },
          },
        ],
      },
      {
        content: "已完成 src/math.js 的加法实现，任务结束。",
      },
    ]);

    // 生产真实执行器（仅 createLlmClient 工厂返回桩）
    const taskExecutor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
    });
    const orchestrator = buildOrchestrator({ taskExecutor });

    const result = await orchestrator.run({
      projectRoot,
      objective: "实现一个 add(a,b) 加法函数并落盘 src/math.js",
      maxIterations: 3,
      // 合成任务默认测试命令；项目无 package.json，verify 应走诚实 skip 而非 spawn
      testCommand: "npm test",
      testTimeoutSec: 30,
    });

    // ---- 终态断言 ----
    assert.equal(result.finalStatus, "completed", `应正常收尾，报告：\n${result.finalReport}`);
    assert.equal(result.exitCode, 0);

    // ---- LLM 真实请求计数（dev：1 次工具轮 + 1 次终态 = 2）----
    const requests = client.getRequests();
    assert.equal(requests.length, 2, "dev 执行必须恰好发起 2 次 createMessage");
    // 白名单收窄事实：每次请求暴露的工具只能是 read/write/edit/UpdatePlan
    for (const record of requests) {
      assert.deepEqual([...record.toolNames].sort(), ["UpdatePlan", "edit", "read", "write"]);
    }
    // 第二次请求必须携带工具结果回灌消息（system/user/assistant/tool）
    assert.ok(requests[1]!.messages.length >= 4, "终态请求前必须回灌 write 的工具结果");
    const toolMessage = requests[1]!.messages.find((m) => m.role === "tool");
    assert.ok(toolMessage, "第二次请求消息序列中必须存在 role=tool 的工具结果消息");

    // ---- 文件真实落盘且内容正确（不是内存假象）----
    const producedFile = path.join(projectRoot, "src", "math.js");
    assert.ok(fs.existsSync(producedFile), "src/math.js 必须由 write 工具真实创建");
    const moduleFn = new Function("module", "exports", fs.readFileSync(producedFile, "utf8")) as (
      module: { exports: Record<string, unknown> },
      exports: Record<string, unknown>
    ) => void;
    const moduleObj = { exports: {} as Record<string, unknown> };
    moduleFn(moduleObj, moduleObj.exports);
    assert.equal((moduleObj.exports.add as (a: number, b: number) => number)(2, 3), 5);

    // ---- tasks.md 状态机：T-001 被真实标记 completed ----
    const tasksRaw = fs.readFileSync(path.join(projectRoot, ".eag", "p5", "tasks.md"), "utf8");
    const cards = parseTaskCards(tasksRaw);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.id, "T-001");
    assert.equal(cards[0]!.status, "completed");

    // ---- token 真实累计（桩返回固定 usage：每次 32+16=48，两次 96）----
    assert.ok(result.totalLlmCallCount >= 1, "编排器 LLM 调用计数必须透传执行器请求事实");
    assert.ok(result.totalTokensUsed > 0, "totalTokensUsed 必须透传执行器真实累计值");
    assert.equal(result.totalTokensUsed, 96);

    // ---- 里程碑诚实标注 unverified（skip 不等于测试通过）----
    assert.equal(result.milestones.length, 1, "仅任务轮记 milestone，收尾轮不记");
    assert.match(result.milestones[0]!.name, /unverified/);

    // ---- 最终报告含执行器请求数行（交付表达一致性）----
    assert.match(result.finalReport, /执行器 LLM 请求数\*\*：2/);
  } finally {
    cleanupTempProject(projectRoot);
  }
});

test("INT-B. verify 真实失败 → fix 轮收到失败输出反馈并修复 → 下一轮 verify 全绿 → completed", async () => {
  const projectRoot = createTempProject("eag-p5-int-b-");
  try {
    initGitRepo(projectRoot);

    // 真实测试目标：package.json + test.js 对 src/math.js 做行为断言
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "int-b", version: "1.0.0", scripts: { test: "node test.js" } }, null, 2),
      "utf8"
    );
    fs.writeFileSync(
      path.join(projectRoot, "test.js"),
      [
        "// 真实行为测试（由 npm test 子进程执行）",
        "const { add } = require('./src/math.js');",
        "const actual = add(1, 2);",
        "if (actual !== 3) {",
        "  console.error('Tests: 0 passed, 1 failed - add(1,2)=' + actual + ' expected 3');",
        "  process.exit(1);",
        "}",
        "console.log('Tests: 1 passed, 0 failed');",
        "",
      ].join("\n"),
      "utf8"
    );

    // 桩脚本序列（跨 3 轮编排，共 6 次请求）：
    // iter0 dev：[0] write 错误实现（a-b）→ [1] 终态
    // iter0 verify：真实 npm test 失败（T-001 不标 completed）
    // iter0 fix：[2] read 既有文件（fix 是独立 ToolExecutor 会话，write 已存在文件受
    //            "未读先写"保护，真实模型必须先读）→ [3] write 正确实现（a+b）→ [4] 终态
    // iter1 dev：[5] 直接终态（文件已由 fix 修正，无需再改；git 仍能检出变更）
    // iter1 verify：真实 npm test 全绿 → markTaskCompleted
    // iter2 plan：all-tasks-completed → completed
    const mathFileAbs = path.join(projectRoot, "src", "math.js");
    const client = new StubLlmClient([
      {
        content: "先写入实现。",
        toolCalls: [
          {
            name: "write",
            args: {
              file_path: mathFileAbs,
              content:
                "// 错误实现（集成测试 INT-B 首轮，故意减法）\n" +
                "function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n",
            },
          },
        ],
      },
      { content: "首轮 dev 实现完成。" },
      {
        content: "先读取既有实现以定位问题。",
        toolCalls: [{ name: "read", args: { file_path: mathFileAbs } }],
      },
      {
        content: "根据验证失败反馈修正为加法。",
        toolCalls: [
          {
            name: "write",
            args: {
              file_path: mathFileAbs,
              content:
                "// 修正实现（集成测试 INT-B fix 轮）\n" +
                "function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n",
            },
          },
        ],
      },
      { content: "已按失败反馈修复。" },
      { content: "复核：实现已正确，本轮无需改动。" },
    ]);

    const taskExecutor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
    });
    const orchestrator = buildOrchestrator({ taskExecutor });

    const result = await orchestrator.run({
      projectRoot,
      objective: "实现 add(a,b) 加法函数，行为测试位于 test.js",
      maxIterations: 3,
      testCommand: "npm test",
      testTimeoutSec: 60,
    });

    assert.equal(result.finalStatus, "completed", `修复回路应收尾 completed，报告：\n${result.finalReport}`);
    assert.equal(result.exitCode, 0);

    // ---- 6 次请求全部被真实消费（脚本 fail-loud：少一轮就会抛错使 run 失败）----
    assert.equal(client.getRequests().length, 6);

    // ---- fix 轮请求（index 2）的 user 消息必须携带 verify 的【真实失败输出】片段 ----
    const fixRequest = client.getRequests()[2]!;
    const fixUserPrompt = fixRequest.messages.find((m) => m.role === "user")?.content ?? "";
    assert.match(fixUserPrompt, /验证失败反馈/, "fix user prompt 必须进入失败反馈分支");
    assert.match(
      fixUserPrompt,
      /expected 3|Tests: 0 passed, 1 failed/,
      "fix 反馈必须包含 verify 子进程的真实失败输出片段，而非泛化提示"
    );

    // ---- 最终磁盘产物必须是正确实现（fix 写覆盖了 dev 的错误版本）----
    const producedFile = path.join(projectRoot, "src", "math.js");
    const produced = fs.readFileSync(producedFile, "utf8");
    assert.match(produced, /return a \+ b;/, "最终文件必须是 fix 轮写入的加法实现");
    assert.doesNotMatch(produced, /return a - b;/, "错误实现不得残留");

    // 再真实跑一次 npm test 独立复核（不依赖编排器的 verify 结论）
    const retest = execFileSync("npm", ["test"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(retest, /Tests: 1 passed, 0 failed/);

    // ---- 状态机：经历一次失败后仍正确标记 completed ----
    const cards = parseTaskCards(fs.readFileSync(path.join(projectRoot, ".eag", "p5", "tasks.md"), "utf8"));
    assert.equal(cards[0]!.status, "completed");

    // 全绿里程碑不带 unverified（项目有真实测试目标且通过）
    assert.equal(result.milestones.length, 1);
    assert.doesNotMatch(result.milestones[0]!.name, /unverified/);
  } finally {
    cleanupTempProject(projectRoot);
  }
});
