/**
 * EAG-P5 任务完成"变更文件清单"回归测试（2026-10-07 需求）
 *
 * 需求：/eag-autonomous 任务完成时，Web 与 CLI 都要列出本次运行修改和新增的
 * 文件清单。单一事实源：AutonomousRunResult.changedFiles（结构化字段）与
 * finalReport 的"## 变更文件清单"段（markdown，双宿主渲染文本）同源。
 *
 * 归因正确性是本特性的生命线：清单必须只包含"本次运行干的"，
 * 运行前工作区已有的脏文件（用户未提交改动）绝不能被归因给本任务。
 * 归因实现：run() 入口 git 基线快照（porcelain -uall + ls-files），
 * 结束再做终态快照差集（autonomous-orchestrator.ts computeRunFileChanges）。
 *
 * 用例矩阵（测试专家评审裁决落地）：
 * - CF-1 纯函数归因：基线干净 + 终态 ??/M/D 三态混合 → added/modified/deleted
 *   归类与稳定排序；
 * - CF-2 归因正确性（关键）：基线已有 ??/M 脏文件且运行期未再触碰 →
 *   必须完全排除出清单（不做基线差集此用例必挂）；
 * - CF-3 rename：终态 "R old -> new" 拆为 new=added（基线不脏）或 modified
 *   （基线跟踪文件改名后 tracked 但 ?? 不可能——改名后 git 报 R），
 *   old 记 deleted；
 * - CF-4 多轮跨任务去重：同一文件两轮先后改动 → 清单只出现一次
 *   （终态快照单文件单状态，天然去重）；
 * - CF-5 端到端（真实 git 仓库）：run() 完成后 changedFiles 与磁盘真实
 *   状态一致 + finalReport 含清单段；
 * - CF-6 端到端归因（真实 git 仓库）：运行前预置脏文件 → 不出现在清单；
 * - CF-7 非 git 仓库降级：changedFiles 空 + gitAttributionAvailable=false +
 *   finalReport 标注"git 归因不可用"而非"无变更"；
 * - CF-8 markdown 段格式：零变更 git 仓库 → "（本次运行无文件变更）"；
 *   有变更 → 分组标题 + 反引号路径 + 合计行。
 *
 * 真实性边界（用户硬性规则：禁止 mock/占位/简化）：
 * - 编排器/handler/guard 链/tasks.md/git 仓库全部真实；
 * - 唯一替身是 LLM 网络边界（StubLlmClient）与纯函数用例的快照对象。
 *
 * @module core/tests/eag-p5-changed-files-inventory
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

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
} from "../eag/p5/index";
import { StubLlmClient } from "./fixtures/stub-llm-client";

// ============================================================================
// 纯函数归因夹具：通过受控子类暴露私有归因算法（测试专用装配，非产品替身）
// ============================================================================

/**
 * 受控编排器子类：把私有的快照采集与差集归因暴露给测试。
 *
 * 产品代码不依赖此子类；测试经由它用**真实 git 命令**（快照采集走真实
 * execFileSync）+ 真实 porcelain 输出验证归因算法，不 mock git。
 */
class InventoryTestHarness extends AutonomousOrchestrator {
  /** 采集指定目录的真实 git 快照（透传私有方法） */
  snapshotOf(projectRoot: string): { dirty: Array<[string, string]>; tracked: string[] } | null {
    const snap = (
      this as unknown as {
        captureGitSnapshot(root: string): { dirty: Map<string, string>; tracked: Set<string> } | null;
      }
    ).captureGitSnapshot(projectRoot);
    if (snap === null) {
      return null;
    }
    return { dirty: [...snap.dirty.entries()], tracked: [...snap.tracked] };
  }

  /** 对两份快照做差集归因（透传私有方法） */
  computeChanges(
    baseline: { dirty: Array<[string, string]>; tracked: string[] } | null,
    final: { dirty: Array<[string, string]>; tracked: string[] } | null
  ): Array<{ path: string; kind: string }> {
    const revive = (s: { dirty: Array<[string, string]>; tracked: string[] } | null) =>
      s === null ? null : { dirty: new Map(s.dirty), tracked: new Set(s.tracked) };
    return (
      this as unknown as {
        computeRunFileChanges(
          b: { dirty: Map<string, string>; tracked: Set<string> } | null,
          f: { dirty: Map<string, string>; tracked: Set<string> } | null
        ): Array<{ path: string; kind: string }>;
      }
    ).computeRunFileChanges(revive(baseline), revive(final));
  }
}

/** 构造受控编排器（纯归因用例只需方法可访问，不需要完整装配语义） */
function buildHarness(): InventoryTestHarness {
  const loopExecutor = createP5LoopExecutorFromHandlers(
    new P5PlanStageHandler(),
    createDevStageHandler(),
    createVerifyStageHandler(),
    createFixStageHandler()
  );
  return new InventoryTestHarness({
    loopExecutor,
    runStateStore: new P5RunStateStore(),
    notesMemory: new P5NotesMemory(),
    guardChain: createDefaultBlockerGuardChain({ throwOnDeny: false }),
    smartConfirmation: new P5SmartConfirmation(),
    defaultTestCommand: "node -e '0'",
    defaultTestTimeoutSec: 15,
  });
}

// ============================================================================
// 真实 git 仓库夹具
// ============================================================================

/**
 * 创建真实 git 仓库项目目录并完成首次提交（基线干净）。
 *
 * 提交初始文件 tracked-a.ts（供"修改已有文件"用例）与 tracked-doomed.ts
 * （供"删除文件"用例）。git user 配置仅在临时仓库内设置，不污染全局。
 *
 * @param prefix 临时目录前缀
 * @returns 项目根目录绝对路径（git 仓库、工作区干净）
 */
function createGitProject(prefix: string): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(projectRoot, ".eag", "p5"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "cf-inventory", version: "1.0.0", scripts: { test: "node -e '0'" } }, null, 2),
    "utf8"
  );
  fs.writeFileSync(path.join(projectRoot, "src-tracked-a.ts"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "src-tracked-doomed.ts"), "export const doomed = true;\n", "utf8");
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: projectRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["config", "user.email", "cf-test@local"]);
  git(["config", "user.name", "cf-test"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "baseline"]);
  return projectRoot;
}

/**
 * 创建非 git 项目目录（CF-7 降级用例）。
 *
 * @param prefix 临时目录前缀
 * @returns 项目根目录绝对路径（无 .git）
 */
function createPlainProject(prefix: string): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(projectRoot, ".eag", "p5"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "cf-plain", version: "1.0.0", scripts: { test: "node -e '0'" } }, null, 2),
    "utf8"
  );
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
 * 构造"真实写文件"执行器（跨轮可配置目标文件）：
 * - 默认写入 src/&lt;taskId小写&gt;.ts，内容含任务标题——首轮新建文件
 *   归因 added（porcelain ?? 映射）；
 * - overrideTargetRelative/overrideContent 用于多轮场景：第 2 轮显式
 *   指向第 1 轮产物路径并改内容，制造"基线 ?? → 终态 ??（内容变化）"，
 *   验证跨轮清单去重与归因语义。
 *
 * @param projectRoot 项目根目录
 * @param options 可选覆盖：目标相对路径 / 写入内容函数
 * @returns 执行器端口实现
 */
function buildRealWriteExecutor(
  projectRoot: string,
  options?: { targetRelative?: string; contentFor?: (taskId: string, taskTitle: string) => string }
): P5TaskExecutor {
  return Object.freeze({
    async executeTask(
      input: Parameters<LlmTaskExecutor["executeTask"]>[0]
    ): Promise<ReturnType<LlmTaskExecutor["executeTask"]>> {
      const relative = options?.targetRelative ?? `src/${input.taskId.toLowerCase()}.ts`;
      const content =
        options?.contentFor !== undefined
          ? options.contentFor(input.taskId, input.taskTitle)
          : `// ${input.taskTitle}\nexport const taskId = "${input.taskId}";\n`;
      const targetAbsolute = path.join(projectRoot, relative);
      const client = new StubLlmClient([
        {
          content: "",
          toolCalls: [
            {
              name: "write",
              args: { file_path: targetAbsolute, content },
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
 * 构造"只读任务"执行器：仅 read package.json，零文件写入——
 * 用于构造"卡 completed 但零文件改动"的诚实零变更场景。
 *
 * @param projectRoot 项目根目录
 * @returns 执行器端口实现
 */
function buildReadOnlyExecutor(projectRoot: string): P5TaskExecutor {
  return Object.freeze({
    async executeTask(
      input: Parameters<LlmTaskExecutor["executeTask"]>[0]
    ): Promise<ReturnType<LlmTaskExecutor["executeTask"]>> {
      const targetAbsolute = path.join(projectRoot, "package.json");
      const client = new StubLlmClient([
        { content: "", toolCalls: [{ name: "read", args: { file_path: targetAbsolute } }] },
        { content: `已完成 ${input.taskTitle}（只读核验，无需改动文件）。` },
      ]);
      const inner = new LlmTaskExecutor({ projectRoot, createLlmClient: () => client });
      return inner.executeTask(input);
    },
  });
}

/**
 * 完整装配编排器并绑定执行器。
 *
 * @param projectRoot 项目根目录
 * @param taskExecutor 执行器实现
 * @returns 编排器实例
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

// ============================================================================
// CF-1 纯函数归因：三态混合归类与排序
// ============================================================================

test("CF-1. 快照差集：?? 新文件→added，跟踪文件 M→modified，跟踪文件 D→deleted，稳定排序", () => {
  const harness = buildHarness();
  const baseline = { dirty: [], tracked: ["old.ts"] };
  const final = {
    dirty: [
      ["new.ts", "?"],
      ["old.ts", "M"],
      ["gone.ts", "D"],
      ["a-mid.ts", "?"],
    ],
    tracked: ["old.ts"],
  };

  const changes = harness.computeChanges(baseline, final);
  const byPath = new Map(changes.map((c) => [c.path, c.kind]));
  assert.equal(byPath.get("new.ts"), "added", "终态 ?? 且基线不脏 → added");
  assert.equal(byPath.get("a-mid.ts"), "added", "第二个 ?? 同样 added");
  assert.equal(byPath.get("old.ts"), "modified", "基线跟踪干净 + 终态 M → modified");
  assert.equal(byPath.get("gone.ts"), "deleted", "终态 D 且基线不脏（跟踪文件被删）→ deleted");
  // 稳定排序：added（字典序）→ modified → deleted
  assert.deepEqual(
    changes.map((c) => c.path),
    ["a-mid.ts", "new.ts", "old.ts", "gone.ts"],
    "清单必须按 added→modified→deleted、组内字典序稳定排序"
  );
});

// ============================================================================
// CF-2 归因正确性（关键用例）：运行前既有脏文件必须排除
// ============================================================================

test("CF-2. 关键归因：运行前工作区已有的脏文件（?? 与 M）状态未变 → 完全排除出清单", () => {
  const harness = buildHarness();
  // 基线：用户已有未提交改动 pre-dirty.ts(??) 与 dirty-tracked.ts(M)
  const baseline = {
    dirty: [
      ["pre-dirty.ts", "?"],
      ["dirty-tracked.ts", "M"],
    ],
    tracked: ["dirty-tracked.ts"],
  };
  // 终态：这两文件状态原样（本次运行没碰它们），另有两个运行产物
  const final = {
    dirty: [
      ["pre-dirty.ts", "?"],
      ["dirty-tracked.ts", "M"],
      ["run-new.ts", "?"],
      ["run-mod.ts", "M"],
    ],
    tracked: ["dirty-tracked.ts", "run-mod.ts"],
  };

  const changes = harness.computeChanges(baseline, final);
  const paths = changes.map((c) => c.path);
  assert.ok(!paths.includes("pre-dirty.ts"), "运行前既有 ?? 文件（未再触碰）不得归因给本次运行");
  assert.ok(!paths.includes("dirty-tracked.ts"), "运行前既有 M 文件（状态未变）不得归因给本次运行");
  assert.deepEqual(
    changes,
    [
      { path: "run-new.ts", kind: "added" },
      { path: "run-mod.ts", kind: "modified" },
    ],
    "清单只含本次运行产物"
  );
});

// ============================================================================
// CF-3 rename 拆分
// ============================================================================

test("CF-3. rename 归因：基线跟踪文件改名为 R old->new → new=modified、old=deleted", () => {
  const harness = buildHarness();
  // 基线：old-name.ts 已跟踪且干净（不在 dirty）
  const baseline = { dirty: [], tracked: ["old-name.ts"] };
  // 终态：快照采集把 R old -> new 拆为 new(M) + old(D)（captureGitSnapshot 语义）
  const final = {
    dirty: [
      ["new-name.ts", "M"],
      ["old-name.ts", "D"],
    ],
    tracked: ["new-name.ts", "old-name.ts"],
  };

  const changes = harness.computeChanges(baseline, final);
  const byPath = new Map(changes.map((c) => [c.path, c.kind]));
  assert.equal(byPath.get("new-name.ts"), "modified", "改名后的新路径（基线跟踪文件产物）归 modified");
  assert.equal(byPath.get("old-name.ts"), "deleted", "旧路径归 deleted");
});

// ============================================================================
// CF-4 多轮跨任务同文件去重（端到端）
// ============================================================================

test("CF-4. 多轮端到端：第 2 轮修改第 1 轮新建的同一文件 → 清单只出现一次", async () => {
  const projectRoot = createGitProject("eag-cf4-");
  try {
    // 第 1 轮：默认执行器新建 src/t-001.ts（终态 ?? → added）
    const orchestrator1 = buildOrchestrator(projectRoot, buildRealWriteExecutor(projectRoot));
    const goal1 = "实现用户注册接口，包含邮箱校验与密码哈希";
    await orchestrator1.run({ projectRoot, objective: goal1, maxIterations: 6 });

    // 第 2 轮：执行器显式改写第 1 轮产物 src/t-001.ts（内容变化但 porcelain
    // 仍 ??，git 视其为同一未跟踪文件）——第 2 轮基线 ?? → 终态 ??，
    // 状态未变按"基线遗留"规则排除，清单只出现一次
    const orchestrator2 = buildOrchestrator(
      projectRoot,
      buildRealWriteExecutor(projectRoot, {
        targetRelative: "src/t-001.ts",
        contentFor: (taskId) => `// refactored by ${taskId}\nexport const taskId = "T-001";\n`,
      })
    );
    const goal2 = "重构用户注册接口，抽取密码校验为独立模块";
    const run2 = await orchestrator2.run({ projectRoot, objective: goal2, maxIterations: 6 });

    // 跨轮去重：同一文件在第 2 轮清单内至多出现一次
    const dupCheck = new Map<string, number>();
    for (const f of run2.changedFiles) {
      dupCheck.set(f.path, (dupCheck.get(f.path) ?? 0) + 1);
    }
    for (const [filePath, count] of dupCheck) {
      assert.equal(count, 1, `清单文件 ${filePath} 出现 ${count} 次，必须去重为 1 次`);
    }
    // 归因语义：src/t-001.ts 属第 1 轮产物（?? 状态跨轮未变）——第 2 轮
    // 不得把它重复归因为自己的 added/modified（第 1 轮已报告过）
    const t001 = run2.changedFiles.find((f) => f.path === "src/t-001.ts");
    assert.ok(
      t001 === undefined || t001.kind !== "added",
      `第 2 轮不得把第 1 轮已报告的 ?? 文件重复归因 added，实际 ${JSON.stringify(run2.changedFiles)}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// CF-5 端到端：真实 git 仓库新增文件 → changedFiles + finalReport 一致
// ============================================================================

test("CF-5. 端到端：任务新建文件 → changedFiles 报 added 且 finalReport 含清单段", async () => {
  const projectRoot = createGitProject("eag-cf5-");
  try {
    const orchestrator = buildOrchestrator(projectRoot, buildRealWriteExecutor(projectRoot));
    const result = await orchestrator.run({
      projectRoot,
      objective: "实现用户注册接口，包含邮箱校验与密码哈希",
      maxIterations: 6,
    });

    assert.equal(
      result.finalStatus,
      "completed",
      `应 completed，实际 ${result.finalStatus}：${result.finalReport.slice(0, 250)}`
    );
    assert.equal(result.gitAttributionAvailable, true, "git 仓库归因必须可用");
    const t001 = result.changedFiles.find((f) => f.path === "src/t-001.ts");
    assert.ok(t001 !== undefined, `changedFiles 必须含 src/t-001.ts，实际：${JSON.stringify(result.changedFiles)}`);
    assert.equal(t001!.kind, "added", "新建文件必须归因 added（porcelain ?? 映射，不是 modified）");
    // 单一事实源：finalReport 清单段与结构化字段同源
    assert.ok(result.finalReport.includes("## 变更文件清单"), "finalReport 必须含清单段标题");
    assert.ok(result.finalReport.includes("### 新增"), "清单段必须含新增分组");
    assert.ok(result.finalReport.includes("`src/t-001.ts`"), "finalReport 清单必须列出同源路径");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// CF-6 端到端归因：运行前预置脏文件不得出现在清单
// ============================================================================

test("CF-6. 端到端归因：运行前工作区预置未提交脏文件 → 清单不得包含它", async () => {
  const projectRoot = createGitProject("eag-cf6-");
  try {
    // 用户已有的未提交改动（本次运行绝不触碰）
    fs.writeFileSync(path.join(projectRoot, "user-preexisting.ts"), "// 用户运行前就有的改动\n", "utf8");
    const orchestrator = buildOrchestrator(projectRoot, buildRealWriteExecutor(projectRoot));
    const result = await orchestrator.run({
      projectRoot,
      objective: "实现健康检查端点，返回进程存活状态",
      maxIterations: 6,
    });

    assert.equal(result.finalStatus, "completed");
    const paths = result.changedFiles.map((f) => f.path);
    assert.ok(
      !paths.includes("user-preexisting.ts"),
      `运行前既有脏文件必须排除，实际清单：${JSON.stringify(result.changedFiles)}`
    );
    assert.ok(paths.includes("src/t-001.ts"), "本次运行产物必须在清单内");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// CF-7 非 git 仓库诚实降级
// ============================================================================

test("CF-7. 非 git 仓库：changedFiles 空 + gitAttributionAvailable=false + 报告标注不可用（非'无变更'）", async () => {
  const projectRoot = createPlainProject("eag-cf7-");
  try {
    const orchestrator = buildOrchestrator(projectRoot, buildRealWriteExecutor(projectRoot));
    const result = await orchestrator.run({
      projectRoot,
      objective: "实现用户注册接口，包含邮箱校验与密码哈希",
      maxIterations: 6,
    });

    assert.equal(
      result.finalStatus,
      "completed",
      `非 git 仓库运行本身不得失败，实际 ${result.finalStatus}：${result.finalReport.slice(0, 250)}`
    );
    assert.deepEqual([...result.changedFiles], [], "非 git 仓库清单必须为空（诚实降级）");
    assert.equal(result.gitAttributionAvailable, false, "git 归因不可用标志必须为 false");
    assert.ok(result.finalReport.includes("git 归因不可用"), "报告必须显式标注归因不可用");
    assert.ok(!result.finalReport.includes("（本次运行无文件变更）"), "归因不可用时禁止输出'无文件变更'误导结论");
  } finally {
    cleanup(projectRoot);
  }
});

// ============================================================================
// CF-8 markdown 段格式：零变更 git 仓库
// ============================================================================

test("CF-8. 零变更：completed 且无任何文件改动 → 清单段输出'本次运行无文件变更'", async () => {
  const projectRoot = createGitProject("eag-cf8-");
  try {
    // 只读核验型任务：卡走完 dev(read)+verify 全绿 completed，但磁盘零改动。
    // 这是"completed ≠ 有文件变更"的诚实场景——清单段必须输出空清单文案。
    const orchestrator = buildOrchestrator(projectRoot, buildReadOnlyExecutor(projectRoot));
    const result = await orchestrator.run({
      projectRoot,
      objective: "审计依赖清单完整性，确认无缺失声明（只读核验，不改文件）",
      maxIterations: 6,
    });

    assert.equal(
      result.finalStatus,
      "completed",
      `应 completed，实际 ${result.finalStatus}：${result.finalReport.slice(0, 250)}`
    );
    assert.equal(result.gitAttributionAvailable, true);
    assert.deepEqual([...result.changedFiles], [], "只读任务零改动，清单必须为空");
    assert.ok(result.finalReport.includes("（本次运行无文件变更）"), "零变更必须输出诚实空清单文案");
  } finally {
    cleanup(projectRoot);
  }
});
