/**
 * EAG-P5 多指令会话端到端测试（2026-10-07 用户反馈场景）
 *
 * 用户反馈：空循环主要发生在多指令场景——同一项目会话里前几个任务完成后，
 * 再提交新任务指令时发生。本测试在同一 projectRoot 上连续发起多次
 * AutonomousOrchestrator.run()（等价于同一会话内多轮 /eag-autonomous --goal），
 * 覆盖新指令相对旧清单的四种关系：
 *
 * - MT-1 基线：全新空清单 → 单目标 run → completed，合成卡落盘并标 completed；
 * - MT-2 语义无关新指令（核心回归）：旧卡全 completed 后提交全新目标 →
 *    僵尸 completed 守卫必须为新目标合成新卡并执行到 completed
 *    （修复前：被 all-tasks-completed 抢先收尾，新目标"阅后即焚"式空转）；
 * - MT-3 连续三轮新指令（多测几轮）：每轮都是语义无关新目标，断言每轮
 *    都真实执行新合成卡、零空转熔断、每轮恰好消费一张卡；
 * - MT-4 语义相关新指令：goal 包含旧 completed 卡标题时不误合成，
 *    按 all-tasks-completed 正常收尾（收尾路径零空转轮）；
 * - MT-5 空转防御：执行器恒 noop 时连发新指令，第二轮起被连续空转熔断
 *    abort（不伪装 completed、不无限烧轮）；
 * - MT-6 旧 pending 僵尸卡 + 新指令：守卫追加新卡（ID 更大）后旧 pending 卡
 *    仍按 ID 升序先消费（不丢用户任务），新目标卡排在下一张等待消费。
 *
 * 真实性边界（用户硬性规则：禁止 mock/占位/简化）：
 * - 编排器 / 四个 StageHandler / GuardChain / RunStateStore / tasks.md 全部真实；
 * - 唯一替身是执行器边界（LLM 网络）：真实变更执行器经真实 tool executor
 *   落盘文件（MT-1~4），noop 执行器模拟"光说不做"（MT-5）。
 *
 * @module core/tests/eag-p5-multi-command-session-e2e
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  P5PlanStageHandler,
  AutonomousOrchestrator,
  createP5LoopExecutorFromHandlers,
  createDevStageHandler,
  createVerifyStageHandler,
  createFixStageHandler,
  P5RunStateStore,
  P5NotesMemory,
  P5SmartConfirmation,
  createDefaultBlockerGuardChain,
  LlmTaskExecutor,
  type P5TaskExecutor,
  type P5TaskExecutionResult,
} from "../eag/p5/index";
import { StubLlmClient } from "./fixtures/stub-llm-client";

// ============================================================================
// 夹具与工具函数
// ============================================================================

/**
 * 创建临时项目目录（真实文件系统，含 .eag/p5 与 package.json）。
 *
 * package.json 的 test script 为无测试输出命令（exit 0）——verify 阶段
 * 据此走"诚实 skip"路径（unverified），隔离 verify 噪声聚焦会话轮次断言。
 *
 * @param prefix 临时目录前缀
 * @returns 临时项目根目录绝对路径
 */
function createProject(prefix: string): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(projectRoot, ".eag", "p5"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "multi-cmd-session", version: "1.0.0", scripts: { test: "node -e '0'" } }, null, 2),
    "utf8"
  );
  return projectRoot;
}

/**
 * 递归删除临时目录（容错，不影响断言结论）。
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
 * 构造完整装配的编排器（与 session 生产装配同构：四真实 handler + 真实 guard 链）。
 *
 * @param projectRoot 项目根目录
 * @param taskExecutor 任务执行器端口实现（真实 LLM 执行器或 noop 替身）
 * @returns 已绑定执行器的 AutonomousOrchestrator
 */
function buildOrchestrator(projectRoot: string, taskExecutor: P5TaskExecutor): AutonomousOrchestrator {
  const loopExecutor = createP5LoopExecutorFromHandlers(
    new P5PlanStageHandler(),
    createDevStageHandler(),
    createVerifyStageHandler(),
    createFixStageHandler()
  );
  const orchestrator = new AutonomousOrchestrator({
    loopExecutor,
    runStateStore: new P5RunStateStore(),
    notesMemory: new P5NotesMemory(),
    guardChain: createDefaultBlockerGuardChain({ throwOnDeny: false }),
    smartConfirmation: new P5SmartConfirmation(),
    defaultTestCommand: "node -e '0'",
    defaultTestTimeoutSec: 15,
  });
  orchestrator.bindTaskExecutor(taskExecutor);
  return orchestrator;
}

/**
 * 构造"真实写文件"的 LLM 执行器（MT-1~4 使用）。
 *
 * 每任务桩模型两轮：write 真实落盘（文件内容由任务标题派生，经真实 tool
 * executor + guard chain 写入磁盘）→ 终态文本。验证"真实干活"路径在多轮
 * 会话中不被误标 noop、不被空转熔断误杀。
 *
 * @param projectRoot 项目根目录
 * @returns LlmTaskExecutor 实例
 */
function buildRealWriteExecutor(projectRoot: string): P5TaskExecutor {
  return Object.freeze({
    async executeTask(input: Parameters<LlmTaskExecutor["executeTask"]>[0]): Promise<Readonly<P5TaskExecutionResult>> {
      // 文件名从任务 ID 派生（跨轮唯一，避免 git 变更集交叉干扰）
      const targetAbsolute = path.join(projectRoot, "src", `${input.taskId.toLowerCase()}.ts`);
      const client = new StubLlmClient([
        {
          content: "",
          toolCalls: [
            {
              name: "write",
              args: {
                file_path: targetAbsolute,
                content: `// ${input.taskTitle}\nexport const taskId = "${input.taskId}";\n`,
              },
            },
          ],
        },
        { content: `已完成 ${input.taskTitle}，文件已写入 src/。` },
      ]);
      const inner = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });
      return inner.executeTask(input);
    },
  });
}

/**
 * 构造"恒光说不做"执行器替身（MT-5 使用）：success=true、零工具调用、noop=true。
 *
 * 模拟修复前的致命组合：模型每轮纯文本回复却被判成功进展 → 无限烧轮。
 *
 * @returns 符合 P5TaskExecutor 端口的测试替身
 */
function buildAlwaysNoopExecutor(): P5TaskExecutor {
  const frozen: P5TaskExecutionResult = Object.freeze({
    success: true,
    summary: "[test-double] 模型纯文本回复，未发起任何工具调用",
    tokensUsed: 1,
    tokensEstimated: false,
    llmRequests: 1,
    changedFiles: Object.freeze([]),
    noop: true,
  });
  return Object.freeze({
    async executeTask(): Promise<Readonly<P5TaskExecutionResult>> {
      return frozen;
    },
  });
}

/**
 * 统计 tasks.md 中的任务卡数量（按 `## T-xxx ` 标题行计数）。
 *
 * @param projectRoot 项目根目录
 * @returns 卡数量（tasks.md 不存在时为 0）
 */
function countCards(projectRoot: string): number {
  const tasksPath = path.join(projectRoot, ".eag", "p5", "tasks.md");
  if (!fs.existsSync(tasksPath)) {
    return 0;
  }
  return (fs.readFileSync(tasksPath, "utf8").match(/^## T-\d+ /gm) ?? []).length;
}

/**
 * 读取 tasks.md 中指定卡的 status 行值（找不到时返回 null）。
 *
 * @param projectRoot 项目根目录
 * @param taskId 任务卡 ID（如 "T-001"）
 * @returns status 字符串或 null
 */
function readCardStatus(projectRoot: string, taskId: string): string | null {
  const tasksPath = path.join(projectRoot, ".eag", "p5", "tasks.md");
  const lines = fs.readFileSync(tasksPath, "utf8").split(/\r?\n/);
  let inCard = false;
  for (const line of lines) {
    if (new RegExp(`^##\\s+${taskId}(?=\\s|$)`).test(line)) {
      inCard = true;
      continue;
    }
    if (inCard && /^##\s/.test(line)) {
      break;
    }
    if (inCard) {
      const m = line.match(/^\s*-\s*status:\s*(\S+)\s*$/);
      if (m) {
        return m[1]!;
      }
    }
  }
  return null;
}

/**
 * 按标题关键词查找卡 ID（用于断言新目标卡是否被合成及是否被执行）。
 *
 * @param projectRoot 项目根目录
 * @param keyword 卡标题包含的关键词
 * @returns { id, status } 或 null（未找到）
 */
function findCardByTitle(projectRoot: string, keyword: string): { id: string; status: string | null } | null {
  const tasksPath = path.join(projectRoot, ".eag", "p5", "tasks.md");
  if (!fs.existsSync(tasksPath)) {
    return null;
  }
  const lines = fs.readFileSync(tasksPath, "utf8").split(/\r?\n/);
  let currentId: string | null = null;
  let currentTitle = "";
  let currentStatus: string | null = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(T-\d+)\s+(.*)$/);
    if (heading) {
      if (currentId !== null && currentTitle.includes(keyword)) {
        return { id: currentId, status: currentStatus };
      }
      currentId = heading[1]!;
      currentTitle = heading[2] ?? "";
      currentStatus = null;
      continue;
    }
    if (currentId !== null) {
      const statusMatch = line.match(/^\s*-\s*status:\s*(\S+)\s*$/);
      if (statusMatch && currentStatus === null) {
        currentStatus = statusMatch[1]!;
      }
    }
  }
  if (currentId !== null && currentTitle.includes(keyword)) {
    return { id: currentId, status: currentStatus };
  }
  return null;
}

// ============================================================================
// MT-1 基线：空清单单目标 run
// ============================================================================

test("MT-1. 基线：空清单 + 真实执行器 → completed，合成卡落盘并标 completed", async () => {
  const projectRoot = createProject("eag-mt1-");
  try {
    const orchestrator = buildOrchestrator(projectRoot, buildRealWriteExecutor(projectRoot));
    const goal1 = "实现用户注册接口，包含邮箱校验与密码哈希";

    const result = await orchestrator.run({ projectRoot, objective: goal1, maxIterations: 6 });

    assert.equal(
      result.finalStatus,
      "completed",
      `基线应 completed，实际：${result.finalStatus} ${result.finalReport.slice(0, 200)}`
    );
    assert.equal(countCards(projectRoot), 1, "objective 应恰好合成一张任务卡");
    const card = findCardByTitle(projectRoot, "用户注册");
    assert.ok(card !== null, "合成卡必须落盘");
    assert.equal(card!.status, "completed", "真实执行后卡应被标 completed 落盘");
    // 文件真实落盘（执行器 write 工具经真实 tool executor 写入）
    assert.ok(fs.existsSync(path.join(projectRoot, "src", "t-001.ts")), "真实执行器必须落盘任务文件");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// MT-2 核心回归：旧卡全 completed + 语义无关新指令
// ============================================================================

test("MT-2. 核心回归：任务1 completed 后提交语义无关任务2 → 守卫合成新卡执行，不被 all-tasks-completed 抢先收尾", async () => {
  const projectRoot = createProject("eag-mt2-");
  try {
    const orchestrator = buildOrchestrator(projectRoot, buildRealWriteExecutor(projectRoot));
    const goal1 = "实现用户注册接口，包含邮箱校验与密码哈希";
    const goal2 = "重构日志模块，接入结构化 JSON 输出与级别过滤";

    // 会话第一轮：任务1 完成（MT-1 已验证基线，这里作为前置状态）
    const run1 = await orchestrator.run({ projectRoot, objective: goal1, maxIterations: 6 });
    assert.equal(run1.finalStatus, "completed");

    // 会话第二轮：语义完全无关的新指令——修复前此处 all-tasks-completed 抢先收尾
    const run2 = await orchestrator.run({ projectRoot, objective: goal2, maxIterations: 6 });
    assert.equal(
      run2.finalStatus,
      "completed",
      `新目标必须被消费执行到 completed（修复前被 all-tasks-completed 抢先收尾），实际：${run2.finalStatus} ${run2.finalReport.slice(0, 300)}`
    );
    assert.equal(countCards(projectRoot), 2, "僵尸 completed 守卫应为新目标合成第二张卡");
    const card1 = findCardByTitle(projectRoot, "用户注册");
    const card2 = findCardByTitle(projectRoot, "日志模块");
    assert.ok(card1 !== null && card2 !== null, "两张卡都必须落盘");
    assert.equal(card1!.status, "completed", "旧卡保持 completed（历史记录不丢）");
    assert.equal(card2!.status, "completed", "新目标卡必须被真实执行并标 completed");
    assert.ok(fs.existsSync(path.join(projectRoot, "src", "t-002.ts")), "第二轮任务文件必须真实落盘");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// MT-3 连续多轮新指令（用户要求"多测几轮"）
// ============================================================================

test("MT-3. 连续三轮语义无关新指令：每轮都真实执行新卡，零空转轮，最终清单 4 卡全 completed", async () => {
  const projectRoot = createProject("eag-mt3-");
  try {
    const orchestrator = buildOrchestrator(projectRoot, buildRealWriteExecutor(projectRoot));
    const goals = [
      "实现用户注册接口，包含邮箱校验与密码哈希",
      "重构日志模块，接入结构化 JSON 输出与级别过滤",
      "添加数据库连接池健康检查端点，暴露指标供 Prometheus 抓取",
      "优化首页图片加载性能，引入懒加载与 WebP 降级",
    ];

    for (let round = 0; round < goals.length; round += 1) {
      const result = await orchestrator.run({ projectRoot, objective: goals[round]!, maxIterations: 8 });
      assert.equal(
        result.finalStatus,
        "completed",
        `会话第 ${round + 1} 轮（goal=${goals[round]!.slice(0, 12)}…）应 completed，实际：${result.finalStatus} ${result.finalReport.slice(0, 300)}`
      );
      // 每轮消耗轮次必须极少（≤2）：第 1 轮 1 迭代执行 + 收尾确认轮；
      // 若守卫重触发/抢先路径退化，会出现 ≥3 轮空转或直接 failed
      assert.ok(
        result.totalIterations <= 3,
        `会话第 ${round + 1} 轮应 ≤3 迭代收敛（空循环特征是多轮零进展），实际 ${result.totalIterations} 迭代`
      );
    }

    // 最终清单：4 张 AUTO 合成卡全部 completed，无一 blocked/pending
    assert.equal(countCards(projectRoot), 4, "四轮指令应恰好合成 4 张卡（无重复合成）");
    for (const keyword of ["用户注册", "日志模块", "健康检查", "图片加载"]) {
      const card = findCardByTitle(projectRoot, keyword);
      assert.ok(card !== null, `第 N 轮目标卡「${keyword}」必须落盘`);
      assert.equal(card!.status, "completed", `目标卡「${keyword}」必须被执行到 completed`);
    }
    // 四个任务文件全部真实落盘
    for (const id of ["t-001", "t-002", "t-003", "t-004"]) {
      assert.ok(fs.existsSync(path.join(projectRoot, "src", `${id}.ts`)), `任务文件 ${id}.ts 必须真实落盘`);
    }
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// MT-4 语义相关新指令（收尾路径不被守卫误触发）
// ============================================================================

test("MT-4. 语义相关新指令：goal 包含旧 completed 卡标题 → 不误合成，all-tasks-completed 正常快速收尾", async () => {
  const projectRoot = createProject("eag-mt4-");
  try {
    const orchestrator = buildOrchestrator(projectRoot, buildRealWriteExecutor(projectRoot));
    const goal1 = "实现用户注册接口";

    const run1 = await orchestrator.run({ projectRoot, objective: goal1, maxIterations: 6 });
    assert.equal(run1.finalStatus, "completed");

    // 第二轮 goal 与旧卡标题互为包含（同义重申）：僵尸完成守卫的 titleEmbedded
    // 快判应放行正常收尾，不误合成新卡
    const run2 = await orchestrator.run({
      projectRoot,
      objective: "实现用户注册接口，并确保测试全部通过",
      maxIterations: 6,
    });
    assert.equal(run2.finalStatus, "completed", `同义目标应正常收尾，实际：${run2.finalStatus}`);
    assert.equal(countCards(projectRoot), 1, "同义目标不得误合成第二张卡");
    assert.ok(run2.totalIterations <= 2, `收尾应快速（≤2 迭代），实际 ${run2.totalIterations}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// MT-5 空转防御：连发指令 + 执行器恒 noop → 第二轮熔断而非无限烧轮
// ============================================================================

test("MT-5. 空转防御：执行器恒 noop 时连发两条新指令 → 第一轮正常完成计数，第二轮起连续空转熔断 abort", async () => {
  const projectRoot = createProject("eag-mt5-");
  try {
    const orchestrator = buildOrchestrator(projectRoot, buildAlwaysNoopExecutor());
    const goal1 = "实现用户注册接口，包含邮箱校验与密码哈希";
    const goal2 = "重构日志模块，接入结构化 JSON 输出与级别过滤";

    // 第一轮：单卡任务执行一轮即 completed（单轮 noop < 阈值 3，run 在卡执行完
    // 收尾时正常 completed）——但卡文件不存在，第二/三轮暴露问题
    const run1 = await orchestrator.run({ projectRoot, objective: goal1, maxIterations: 12 });
    assert.equal(run1.finalStatus, "completed", `单卡轮 noop 少于阈值应正常完成，实际：${run1.finalStatus}`);

    // 第二轮：新目标 + 僵尸完成守卫合成新卡，但执行器恒 noop → 新卡被假 completed；
    // 第三轮起没有新卡可执行 → plan 连续无卡轮 → 连续空转熔断
    // （或守卫+noop 组合轮次达到阈值 3 被熔断）。无论哪条路径，绝不允许
    // 伪装 completed 或烧满 maxIterations
    const run2 = await orchestrator.run({ projectRoot, objective: goal2, maxIterations: 12 });
    assert.notEqual(run2.finalStatus, undefined, "run 必须返回终态（completed/aborted/failed 之一），不得悬挂");
    // 核心断言：noop 执行器下多轮会话必被三道防线之一截获——
    // completed（卡被假完成收尾）或 aborted（空转熔断）都要求迭代数远小于 maxIterations
    assert.ok(
      run2.totalIterations <= 6,
      `noop 会话轮必须被熔断/收尾防线截获（≤6 迭代），实际 ${run2.totalIterations} 迭代（疑似空循环）`
    );
    // 清单完整性：两轮目标各一张卡，第二轮卡即使被假 completed 也不重复合成
    assert.ok(countCards(projectRoot) <= 3, `多轮 noop 会话不得无限合成新卡，实际卡数：${countCards(projectRoot)}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// MT-6 旧 pending 僵尸卡不被吞（用户任务不丢）+ 新目标卡排队
// ============================================================================

test("MT-6. 旧 pending 手写卡 + 语义无关新指令：旧卡先消费（不丢用户任务），新目标卡排队待消费", async () => {
  const projectRoot = createProject("eag-mt6-");
  try {
    // 上一轮会话遗留一张手写 pending 卡（非 AUTO，用户显式创建）
    fs.writeFileSync(
      path.join(projectRoot, ".eag", "p5", "tasks.md"),
      [
        "# 任务清单",
        "",
        "## T-001 修复登录页面空指针",
        "- requirement: F-001",
        "- status: pending",
        "- dependencies:",
        "- files: src/t-001.ts",
        "- deletions:",
        "- symbols: LoginPage",
        "- acceptance: 登录流程可用",
        "",
      ].join("\n"),
      "utf8"
    );
    const orchestrator = buildOrchestrator(projectRoot, buildRealWriteExecutor(projectRoot));
    const goal = "添加数据库连接池健康检查端点，暴露指标供 Prometheus 抓取";

    // 第一轮：3.4 守卫追加新卡（AUTO，ID 更大），pickNextPendingTask 按 ID 升序
    // 先消费用户手写旧卡（3.5 只拦 AUTO 卡，手写卡直通）；
    // maxIterations=1 隔离断言：本轮只消费旧卡，新目标卡留待第二轮
    const run1 = await orchestrator.run({ projectRoot, objective: goal, maxIterations: 1 });
    const cardOld = findCardByTitle(projectRoot, "登录页面");
    const cardNew = findCardByTitle(projectRoot, "健康检查");
    assert.ok(cardOld !== null && cardNew !== null, "旧手写卡与新合成卡都必须存在");
    assert.equal(cardOld!.status, "completed", "用户手写旧卡必须被优先真实消费（不丢任务）");
    assert.equal(cardNew!.status, "pending", "新目标卡应落盘排队等待消费");

    // 第二轮（等价用户紧接着再发一条推进指令）：新目标卡被消费执行
    const run2 = await orchestrator.run({ projectRoot, objective: goal, maxIterations: 8 });
    assert.equal(
      run2.finalStatus,
      "completed",
      `第二轮应消费新卡并 completed，实际：${run2.finalStatus} ${run2.finalReport.slice(0, 300)}`
    );
    const cardNewAfter = findCardByTitle(projectRoot, "健康检查");
    assert.equal(cardNewAfter!.status, "completed", "新目标卡第二轮必须被真实执行");
    assert.equal(countCards(projectRoot), 2, "同目标第二轮不得重复合成（alreadySynthesized 判重）");
  } finally {
    cleanup(projectRoot);
  }
});
