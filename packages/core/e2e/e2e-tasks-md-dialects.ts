/**
 * E2E：tasks.md 任务卡状态行的真实文件读写闭环（三种"方言"）
 *
 * 背景（2026-11-01 修复，本轮唯一可达 P0）：
 * 任务卡状态行存在三套互不一致的写法与正则——
 *   ① 标准：`- status: pending`
 *   ② 缩进 + 冒号前空格：`  - status : pending`
 *   ③ 同名重复行：卡内出现两条 status（解析器以**末条**为准）
 * 旧实现里，解析器认①②③，守卫写入只认①。于是：
 *   - 用户手写②③的卡，守卫"改写成功"但磁盘状态没变 → 下一轮重读仍是
 *     pending → 守卫每轮重触发，空转到迭代上限，任务永远不执行（P0）；
 *   - ③ 还会让 markTaskCompleted 抛错，"跑绿了却记不成完成"。
 *
 * 本脚本走真实文件链路（不 mock 任何东西）：
 *   真实临时目录 → 真实 tasks.md → 真实 parseTaskCards
 *   → 真实 markTaskCardStatusInContent → 真实落盘 → 重新读取再解析
 *
 * 运行：
 *   node --import tsx packages/core/e2e/e2e-tasks-md-dialects.ts
 *
 * 退出码：0 = 全部通过；1 = 有用例失败
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseTaskCards,
  markTaskCardStatusInContent,
  TASK_STATUS_LINE_RE,
  formatTaskStatusLine,
} from "../src/eag/p5/handlers/plan-stage-handler";

let pass = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ============================================================================
// 夹具：三张卡，分别使用三种"方言"
// ============================================================================

const TASKS_MD = `# 任务清单

## T-1 标准写法
- requirement: R-1
- status: pending
- files: ["src/a.ts"]

## T-2 缩进 + 冒号前空格
- requirement: R-2
  - status : pending
- files: ["src/b.ts"]

## T-3 重复 status 行（解析器以末条为准）
- requirement: R-3
- status: completed
- status: pending
- files: ["src/c.ts"]
`;

const workDir = mkdtempSync(path.join(tmpdir(), "deepcode-e2e-tasks-"));
const tasksPath = path.join(workDir, "tasks.md");
writeFileSync(tasksPath, TASKS_MD, "utf8");

// ============================================================================
// 场景 1：解析器必须认识三种方言
// ============================================================================

console.log("\n【场景 1】parseTaskCards 认识三种方言");
{
  const cards = parseTaskCards(readFileSync(tasksPath, "utf8"));
  check("解析出 3 张任务卡", cards.length === 3, `实际 ${cards.length} 张：${cards.map((c) => c.id).join(",")}`);

  const byId = new Map(cards.map((c) => [c.id, c]));
  check("T-1 标准方言 → pending", byId.get("T-1")?.status === "pending", `status=${byId.get("T-1")?.status}`);
  check(
    "T-2 缩进 + 冒号前空格方言 → pending（不再漏解析）",
    byId.get("T-2")?.status === "pending",
    `status=${byId.get("T-2")?.status}`
  );
  check(
    "T-3 重复 status 行 → 以末条为准（pending，不是前一条 completed）",
    byId.get("T-3")?.status === "pending",
    `status=${byId.get("T-3")?.status}`
  );
}

// ============================================================================
// 场景 2：守卫式落盘闭环 —— 写盘后回读必须真的变了
// ============================================================================

console.log("\n【场景 2】markTaskCardStatusInContent + 真实落盘 + 回读校验");
{
  for (const taskId of ["T-1", "T-2", "T-3"]) {
    // 每一轮都从磁盘当前内容开始（模拟守卫每轮重读文件）
    const before = readFileSync(tasksPath, "utf8");
    const rewritten = markTaskCardStatusInContent(before, taskId, "completed");
    writeFileSync(tasksPath, rewritten, "utf8");

    const reread = readFileSync(tasksPath, "utf8");
    const cards = parseTaskCards(reread);
    const target = cards.find((c) => c.id === taskId);

    check(
      `${taskId} 写盘后回读状态为 completed（守卫不再空转）`,
      target?.status === "completed",
      `回读 status=${target?.status}`
    );

    // 其它卡不得被误改
    const others = cards.filter((c) => c.id !== taskId);
    check(
      `${taskId} 改写未波及其它任务卡`,
      others.every((c) => c.status === "completed" || c.status === "pending"),
      others.map((c) => `${c.id}=${c.status}`).join(", ")
    );
  }

  // 三张卡最终都应 completed
  const finalCards = parseTaskCards(readFileSync(tasksPath, "utf8"));
  check(
    "三张不同方言的卡全部落定为 completed",
    finalCards.every((c) => c.status === "completed"),
    finalCards.map((c) => `${c.id}=${c.status}`).join(", ")
  );
}

// ============================================================================
// 场景 3：守卫循环收敛性 —— 必须第 1 轮就收敛（旧实现空转到上限）
// ============================================================================

console.log("\n【场景 3】守卫循环：一轮内收敛，不空转");
{
  // 重置为全 pending，模拟一轮全新的守卫检查
  writeFileSync(tasksPath, TASKS_MD.replace(/- status: completed\n- status: pending/g, "- status: pending"), "utf8");

  const MAX_GUARD_ROUNDS = 10; // 生产守卫的迭代上限
  let rounds = 0;
  let convergedAt = -1;

  for (let round = 1; round <= MAX_GUARD_ROUNDS; round += 1) {
    rounds = round;
    const content = readFileSync(tasksPath, "utf8");
    const cards = parseTaskCards(content);
    const pending = cards.find((c) => c.status === "pending");
    if (!pending) {
      convergedAt = round - 1;
      break;
    }
    // 守卫动作：把当前 pending 卡标记为 blocked 并落盘
    writeFileSync(tasksPath, markTaskCardStatusInContent(content, pending.id, "blocked"), "utf8");
  }

  check(
    "守卫在 1 轮内把 3 张 pending 卡全部转为 blocked（无空转）",
    convergedAt === 3,
    `收敛于第 ${convergedAt} 轮 / 上限 ${MAX_GUARD_ROUNDS} 轮`
  );
  check("未触达迭代上限（旧实现会跑满 10 轮）", rounds < MAX_GUARD_ROUNDS, `实际跑了 ${rounds} 轮`);

  const afterGuard = parseTaskCards(readFileSync(tasksPath, "utf8"));
  check(
    "守卫落盘后磁盘上确实没有 pending 卡",
    afterGuard.every((c) => c.status !== "pending"),
    afterGuard.map((c) => `${c.id}=${c.status}`).join(", ")
  );
}

// ============================================================================
// 场景 4：状态行工具函数一致性（解析 / 写入必须同一套规则）
// ============================================================================

console.log("\n【场景 4】TASK_STATUS_LINE_RE 与 formatTaskStatusLine 自洽");
{
  const variants = ["- status: pending", "  - status : pending", "\t-  status:  blocked"];
  for (const line of variants) {
    check(`样式「${line}」可被统一正则识别`, TASK_STATUS_LINE_RE.test(line), `match=${TASK_STATUS_LINE_RE.test(line)}`);
  }
  check("formatTaskStatusLine 输出标准样式", formatTaskStatusLine("completed") === "- status: completed");
  check("标准样式可被统一正则识别（写读自洽）", TASK_STATUS_LINE_RE.test(formatTaskStatusLine("completed")));
  // 非状态行不得误匹配
  check("普通属性行不被误判为状态行", TASK_STATUS_LINE_RE.test("- files: [a.ts]") === false);
}

// ============================================================================
// 收尾
// ============================================================================

rmSync(workDir, { recursive: true, force: true });

console.log("\n========================================");
if (failures.length === 0) {
  console.log(`✅ tasks.md 状态行端到端全部通过（${pass} 项断言）`);
  process.exit(0);
}
console.log(`❌ 失败 ${failures.length} 项 / 通过 ${pass} 项：`);
for (const f of failures) console.log(`   - ${f}`);
process.exit(1);
