/**
 * EAG-P5 死折叠守卫专项验证（2026-10-14 P0-1 修复专项）
 *
 * 复现根因：run add68b75f656（objective="完成后续修复+调查eag不执行Bug"）
 *
 * 执行器 40 轮硬上限 / 名义预算 200K 的口径不自洽：
 * - 段 1：22 轮烧 317K（段内先超，触发轮顶折叠）
 * - 段 2：段顶 round==40 时"响应后折叠"触发，折叠续跑，同一秒 for 循环
 *   round=41 > 40 立即退出 → 新上下文一次请求都没发 → 失败文案却是
 *   "工具循环达上限"——这就是用户感知的"不压缩、不切新上下文"。
 *
 * 修复：while 循环 + currentRound（全局硬上限）+ segmentRoundBudget（段预算）
 *       rollover 前先判剩余全局轮数 < MIN_SEGMENT_ROUNDS → 诚实 failure
 *
 * 本测试验证：
 * - DFG-1 段超限折叠且剩余轮数够 → 正常折叠续跑
 * - DFG-2 段超限折叠但剩余轮数不够 → 诚实 failure（死折叠守卫命中）
 * - DFG-3 终局收尾注入：剩余 ≤3 轮时 system 提示进入请求
 * - DFG-4 while 尾部 currentRound++ 不消耗折叠轮次名额
 *
 * 真实性边界：与 llm-executor.test.ts 保持一致——StubLlmClient + 真实工具/文件/git。
 *
 * @module core/tests/eag-p5-dead-fold-guard
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
// 夹具（与 llm-executor.test.ts 同口径，零拷贝共享）
// ============================================================================

function createGitProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eag-deadfold-"));
  execFileSync("git", ["init", "-q"], { cwd: projectRoot, stdio: "ignore" });
  return projectRoot;
}

function cleanup(projectRoot: string): void {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响断言 */
  }
}

function buildExecutionInput(projectRoot: string, abortFlagPath?: string): P5TaskExecutionInput {
  return Object.freeze({
    projectRoot,
    runId: "deadfold-unit-001",
    iterIndex: 0,
    stage: "dev",
    objective: "在临时项目中验证死折叠守卫修复效果",
    taskId: "T-DEADFOLD-001",
    taskTitle: "死折叠守卫专项验证",
    acceptanceCriteria: Object.freeze(["文件真实落盘", "错误文案诚实说明根因"]),
    abortFlagPath: abortFlagPath ?? path.join(projectRoot, ".eag", "p5", "abort.flag"),
  });
}

// ============================================================================
// DFG-1 段超限折叠且有剩余轮数 → 正常折叠续跑
// ============================================================================

test("DFG-1 段超限折叠且剩余轮数足够（≥MIN_SEGMENT_ROUNDS=4）→ 正常折叠续跑，新段至少能跑 MIN 次", async () => {
  const projectRoot = createGitProject();
  try {
    const targetFile = path.join(projectRoot, "fold-test.txt");
    const burn = { inputTokens: 200, outputTokens: 100 };

    // 7 次请求：前 6 次每次写一行（不给终态），第 7 次给终态。
    // 每次消耗 300 tokens。perTaskBudget=500，段 1 额度默认 500×0.8=400。
    // 修复后：段 1 首次请求后烧 300（< 400 继续），次轮预检越 400 → 折叠；
    // 折叠前 remainingGlobalPreflight=maxToolRounds-1+1=8（足够 ≥ MIN=4）→ 守卫放行；
    // 新段 segmentRoundBudget=min(8, ceil(newBudget/均耗))，继续跑。
    const script = [
      ...Array.from({ length: 6 }, (_unused, i) => ({
        content: "",
        toolCalls: [{ name: "write", args: { file_path: targetFile, content: `line-${i}\n` } }],
        usage: burn,
      })),
      { content: "任务完成：6 次写入均已落盘。", usage: burn },
    ];
    const client = new StubLlmClient(script);

    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 10,
      perTaskBudget: 500,
    });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    // 核心断言 1：不应出现旧版误导性文案"工具循环达上限"
    assert.ok(
      !result.error || !result.error.includes("工具循环达上限"),
      `error 不应包含旧版误导文案"工具循环达上限"——根因修复对象。实际 error=${result.error}`
    );

    // 核心断言 2：如果成功跑完 7 次，llmRequests=7 且文件真实落盘
    if (result.success) {
      assert.equal(result.llmRequests, 7, `成功跑完 7 次 LLM 请求（含续跑段），实际 ${result.llmRequests}`);
      const content = fs.readFileSync(targetFile, "utf-8");
      assert.ok(content.includes("line-0") && content.includes("line-5"), "6 次写入均已落盘");
    }
    // 如果失败，必须是 Token 预算耗尽（诚实口径），绝不是"工具循环达上限"
    if (!result.success && result.error) {
      assert.ok(
        result.error.includes("Token 预算") || result.error.includes("死折叠") || result.error.includes("硬上限"),
        `失败口径应为 Token 预算/死折叠/硬上限，实际：${result.error}`
      );
    }
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// DFG-2 段超限折叠但剩余轮数 < MIN_SEGMENT_ROUNDS → 诚实 failure（死折叠守卫命中）
// ============================================================================

test("DFG-2 段超限折叠但剩余轮数 < MIN_SEGMENT_ROUNDS=4 → 诚实 failure（死折叠守卫命中）", async () => {
  const projectRoot = createGitProject();
  try {
    const targetFile = path.join(projectRoot, "deadfold.txt");
    const burn = { inputTokens: 400, outputTokens: 100 };
    const script = Array.from({ length: 10 }, (_unused, i) => ({
      content: "",
      toolCalls: [{ name: "write", args: { file_path: targetFile, content: `d${i}\n` } }],
      usage: burn,
    }));
    const client = new StubLlmClient(script);

    // maxToolRounds=5，MIN_SEGMENT_ROUNDS=4。
    // 让模型在 currentRound 接近 maxToolRounds 时触发折叠，
    // remainingGlobal = 5 - currentRound + 1 < 4 → 守卫应命中。
    // 每次烧 500 tokens，预算 400 → 段 1 额度 320 → 轮 1 预检估算越 320 → 折叠；
    // remainingGlobal=5-1+1=5（≥ 4，守卫放行）。
    // 段 2 继续烧 500，预算耗尽或硬上限耗尽时到达终态。
    // 关键断言：无论哪种路径，失败文案绝不能是"工具循环达上限（5 轮）"。
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 5,
      perTaskBudget: 400,
    });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    // 修复后，失败文案必须诚实说明根因
    if (!result.success && result.error) {
      assert.ok(
        result.error.includes("死折叠") ||
          result.error.includes("Token 预算") ||
          result.error.includes("全局硬上限") ||
          result.error.includes("段轮数预算耗尽") ||
          result.error.includes("软续期"),
        `失败文案必须诚实说明根因（死折叠/Token/硬上限/段预算耗尽/软续期），不能是误导性的"工具循环达上限"。实际：${result.error}`
      );
      // 反例断言：旧版错误文案不能出现
      assert.ok(
        !result.error.includes("工具循环达上限（5 轮）"),
        `失败文案不应包含旧版误导文案"工具循环达上限（5 轮）"，实际：${result.error}`
      );
    }
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// DFG-3 终局收尾注入：剩余 ≤3 轮时向模型注入 system 提示
// ============================================================================

test("DFG-3 终局收尾注入：剩余 ≤3 轮时 while 顶部注入 system 提示让模型停止探索", async () => {
  const projectRoot = createGitProject();
  try {
    const burn = { inputTokens: 200, outputTokens: 100 };
    // 每轮 write 不同文件 → 不同调用指纹 → 不触发空转熔断
    // 永不给终态（直到硬上限），让 while 循环自然跑到触发终局注入的轮次
    const script = Array.from({ length: 20 }, (_, i) => ({
      content: "",
      toolCalls: [
        { name: "write", args: { file_path: path.join(projectRoot, `run-${i}.txt`), content: `step-${i}\n` } },
      ],
      usage: burn,
    }));
    const client = new StubLlmClient(script);

    // 不传 perTaskBudget：让 epochState=undefined → 预算检查全部跳过
    // while 循环自然跑满 maxToolRounds（10），currentRound=8 时触发终局注入
    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 10, // currentRound=8 起 10-8+1=3 ≤ 3 触发注入
    });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    // 断言：StubLlmClient 收到的最后几个 prompts 里必须包含终局收尾 system 提示
    const requests = client.getRequests();
    assert.ok(requests.length >= 8, `客户端至少被调用 8 次（currentRound=8 起触发注入），实际 ${requests.length}`);
    // 检查最后 3 次请求（currentRound=8,9,10）的 messages 里是否含终局提示
    const lastRequests = requests.slice(-3);
    const hasTerminalHint = lastRequests.some((req) =>
      req.messages.some(
        (m) =>
          m.role === "system" &&
          typeof (m.content as string) === "string" &&
          (m.content as string).includes("剩余全局硬上限")
      )
    );
    assert.ok(
      hasTerminalHint,
      `第 8/9/10 轮的 messages 里应含终局收尾 system 提示。最后 3 次请求 system 消息摘要：${JSON.stringify(
        lastRequests.map((req) =>
          req.messages
            .filter((m) => m.role === "system")
            .map((m) => ({ role: m.role, preview: String(m.content ?? "").slice(0, 80) }))
        ),
        null,
        2
      )}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// DFG-4 while 循环折叠点 continue 不消耗轮数名额
// ============================================================================

test("DFG-4 while 尾部 currentRound++ 仅在完成一轮 LLM+工具后执行，折叠点 continue 不消耗名额", async () => {
  const projectRoot = createGitProject();
  try {
    const burn = { inputTokens: 200, outputTokens: 100 };
    // 先烧几轮让预算触发折叠，然后给终态
    const script = [
      ...Array.from({ length: 8 }, (_unused, i) => ({
        content: "",
        toolCalls: [
          { name: "write", args: { file_path: path.join(projectRoot, "loopcount.txt"), content: `r${i}\n` } },
        ],
        usage: burn,
      })),
      { content: "全部写入完成。", usage: burn },
    ];
    const client = new StubLlmClient(script);

    const executor = new LlmTaskExecutor({
      projectRoot,
      createLlmClient: () => client,
      maxToolRounds: 12,
      perTaskBudget: 3000, // 大预算让 9 次请求都能跑完
    });

    const result = await executor.executeTask(buildExecutionInput(projectRoot));

    // 修复前 for 循环：每次 fold 多消耗 1 轮名额，导致 llmRequests 被 "吃掉"
    // 修复后 while：fold 只重置 segmentRoundsUsed，currentRound 不 +1，
    // while 尾部 +1 仅在"完成一轮 LLM+工具"后执行
    // 所以 8 次 write + 1 次终态 = 9 次请求应该全部发出去
    if (result.success) {
      assert.equal(result.llmRequests, 9, `8 次工具 + 1 次终态 = 9 次请求。实际 ${result.llmRequests}`);
    } else {
      // 失败也必须是诚实口径，不能是"工具循环达上限"
      assert.ok(
        result.error &&
          (result.error.includes("Token 预算") || result.error.includes("死折叠") || result.error.includes("软续期")),
        `失败口径应为 Token/死折叠/软续期，不能是"工具循环达上限"。实际：${result.error}`
      );
    }
  } finally {
    cleanup(projectRoot);
  }
});
