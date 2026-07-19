/**
 * EAG-P3 批次 10 单元测试：long-horizon/milestone-tagger.ts 里程碑 tag 生成器
 *
 * 测试范围（对齐设计文档 §4.15）：
 * - T1.  HealthScoreCalculator 健康度计算器（独立可测）
 * - T2.  MilestoneTagger 构造函数校验
 * - T3.  tag() 请求字段校验
 * - T4.  tag() 成功路径（创建 milestone + git tag + 回归测试 + 健康度计算）
 * - T5.  tag() 创建 git tag 真实性（通过 git tag --list 验证）
 * - T6.  rollback() 校验（无可回滚 / runId 为空）
 * - T7.  rollback() 成功路径（git reset --hard + 返回上一个 milestone）
 * - T8.  listTags() 测试
 * - T9.  tag() 失败路径（重复创建同一 tag）
 * - T10. MilestoneTaggerError 字段断言
 * - T11. tag() 自定义选项（tagPrefix / 自定义回归测试命令）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用真实 RunStateStore + 真实 git 命令调用（child_process.spawnSync）
 * - 真实文件系统 I/O（fs.mkdtempSync + try/finally 清理）
 * - 真实 git 仓库初始化（git init + commit）以支持 tag 操作
 * - 回归测试命令使用 "node -e 'console.log()'" 真实执行（避免触发 npm test）
 * - 使用 node:test + node:assert/strict
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计文档 §4.15 MilestoneTagger
 * - EAG 方案 §5.12.2 里程碑检查点（tag + 回归 + 健康度）
 * - eag/long-horizon/milestone-tagger.ts 源文件
 *
 * @module core/tests/eag-long-horizon-milestone-tagger
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { MilestoneTagger, MilestoneTaggerError, HealthScoreCalculator } from "../eag/long-horizon/milestone-tagger";
import { RunStateStore } from "../eag/long-horizon/run-state-store";
import type { RegressionResult } from "../eag/long-horizon/types";

// ============================================================================
// 辅助工具
// ============================================================================

/**
 * 创建临时项目根目录
 *
 * @returns 临时项目根目录绝对路径
 */
function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eag-milestone-tagger-"));
}

/**
 * 递归删除目录
 *
 * @param dirPath 待删除目录
 */
function rmrf(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
}

/**
 * 在临时目录初始化一个真实 git 仓库（含一次 commit）以支持 MilestoneTagger 的 git tag 操作
 *
 * @param projectRoot 项目根目录
 */
function initGitRepo(projectRoot: string): void {
  childProcess.execSync("git init", { cwd: projectRoot, stdio: "pipe" });
  childProcess.execSync('git config user.email "test@example.com"', {
    cwd: projectRoot,
    stdio: "pipe",
  });
  childProcess.execSync('git config user.name "Test User"', {
    cwd: projectRoot,
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(projectRoot, "README.md"), "# Test Project\n", "utf8");
  childProcess.execSync("git add README.md", { cwd: projectRoot, stdio: "pipe" });
  childProcess.execSync('git commit -m "init"', { cwd: projectRoot, stdio: "pipe" });
}

/**
 * 列出项目 git 仓库中的所有 tag
 *
 * @param projectRoot 项目根目录
 * @returns tag 列表（按字母序）
 */
function listGitTags(projectRoot: string): string[] {
  const output = childProcess.execSync("git tag --list", {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return output
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 创建一个真实的 RunState（通过 RunStateStore.initialize()）
 *
 * @param projectRoot 项目根目录
 * @param runStateStore RunState 持久化存储
 * @param runId 显式指定 runId
 * @returns RunState 对象
 */
async function createRunState(
  projectRoot: string,
  runStateStore: RunStateStore,
  runId: string
): Promise<ReturnType<RunStateStore["initialize"]>> {
  return await runStateStore.initialize({
    runId,
    projectRoot,
    initialLoop: "design",
  });
}

/**
 * 在调用 tag() 后追加 milestone-tagged 事件到 RunState
 *
 * 设计理由：
 * - MilestoneTagger.tag() 仅创建 git tag + 返回 MilestoneRecord，不写回 RunState
 * - 调用方（如 EagRunHandler）负责追加 milestone-tagged 事件让 RunState.milestones 累积
 * - 本辅助函数模拟该真实流程，让连续 tag() 调用能正确递增 index
 *
 * @param runStateStore RunState 持久化存储
 * @param runId run-id
 * @param milestone 刚创建的 milestone 记录
 */
async function recordMilestoneInRunState(
  runStateStore: RunStateStore,
  runId: string,
  milestone: Readonly<{
    index: number;
    name: string;
    loopType: string;
    completedAt: string;
    tagName: string;
    commitSha: string;
    regressionResult?: unknown;
    healthScore: number;
  }>
): Promise<void> {
  await runStateStore.appendEvent(runId, {
    type: "milestone-tagged",
    payload: { milestone },
  });
}

// ============================================================================
// T1. HealthScoreCalculator 健康度计算器（独立可测）
// ============================================================================

test("T1.1 HealthScoreCalculator.calculate() 全部通过 → 健康度 1.0", () => {
  const calculator = new HealthScoreCalculator();
  const regressionResult: RegressionResult = {
    totalTests: 100,
    passedTests: 100,
    failedTests: 0,
    exitCode: 0,
    durationSec: 10,
  };
  // testPassRate=1.0, redlinePassRate=1.0, coverageRate=1.0
  // healthScore = 1.0 * 0.5 + 1.0 * 0.3 + 1.0 * 0.2 = 1.0
  const score = calculator.calculate(regressionResult, 1.0, 1.0);
  assert.equal(score, 1.0);
});

test("T1.2 HealthScoreCalculator.calculate() 全部失败 → 健康度 0.0", () => {
  const calculator = new HealthScoreCalculator();
  const regressionResult: RegressionResult = {
    totalTests: 100,
    passedTests: 0,
    failedTests: 100,
    exitCode: 1,
    durationSec: 10,
  };
  // testPassRate=0.0, redlinePassRate=0.0, coverageRate=0.0
  // healthScore = 0.0 * 0.5 + 0.0 * 0.3 + 0.0 * 0.2 = 0.0
  const score = calculator.calculate(regressionResult, 0.0, 0.0);
  assert.equal(score, 0.0);
});

test("T1.3 HealthScoreCalculator.calculate() totalTests=0 → testPassRate=0（避免除零）", () => {
  const calculator = new HealthScoreCalculator();
  const regressionResult: RegressionResult = {
    totalTests: 0,
    passedTests: 0,
    failedTests: 0,
    exitCode: 0,
    durationSec: 0,
  };
  // totalTests=0 → testPassRate=0
  // healthScore = 0 * 0.5 + 1.0 * 0.3 + 1.0 * 0.2 = 0.5
  const score = calculator.calculate(regressionResult, 1.0, 1.0);
  assert.equal(score, 0.5);
});

test("T1.4 HealthScoreCalculator.calculate() redlinePassRate 越界 → 钳制到 [0, 1]", () => {
  const calculator = new HealthScoreCalculator();
  const regressionResult: RegressionResult = {
    totalTests: 100,
    passedTests: 100,
    failedTests: 0,
    exitCode: 0,
    durationSec: 10,
  };
  // redlinePassRate=1.5（越界）→ 钳制到 1.0；coverageRate=-0.5（越界）→ 钳制到 0.0
  // testPassRate=1.0
  // healthScore = 1.0 * 0.5 + 1.0 * 0.3 + 0.0 * 0.2 = 0.8
  const score = calculator.calculate(regressionResult, 1.5, -0.5);
  assert.equal(score, 0.8);
});

test("T1.5 HealthScoreCalculator.calculate() 部分通过 → 健康度符合公式", () => {
  const calculator = new HealthScoreCalculator();
  const regressionResult: RegressionResult = {
    totalTests: 200,
    passedTests: 150,
    failedTests: 50,
    exitCode: 1,
    durationSec: 30,
  };
  // testPassRate = 150/200 = 0.75
  // redlinePassRate = 0.8
  // coverageRate = 0.6
  // healthScore = 0.75 * 0.5 + 0.8 * 0.3 + 0.6 * 0.2 = 0.375 + 0.24 + 0.12 = 0.735
  // 保留 4 位小数 → 0.735
  const score = calculator.calculate(regressionResult, 0.8, 0.6);
  assert.equal(score, 0.735);
});

// ============================================================================
// T2. MilestoneTagger 构造函数校验
// ============================================================================

test("T2.1 MilestoneTagger 构造函数注入 runStateStore 可成功实例化", () => {
  const runStateStore = new RunStateStore();
  const tagger = new MilestoneTagger(runStateStore);
  assert.ok(tagger instanceof MilestoneTagger);
});

test("T2.2 MilestoneTagger 缺少 runStateStore 抛 invalid-request", () => {
  assert.throws(
    () => new MilestoneTagger(undefined as unknown as RunStateStore),
    (err: unknown) => {
      assert.ok(err instanceof MilestoneTaggerError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.message.includes("runStateStore 必填"));
      return true;
    }
  );
});

test("T2.3 MilestoneTagger 构造函数使用自定义选项可成功实例化", () => {
  const runStateStore = new RunStateStore();
  const tagger = new MilestoneTagger(runStateStore, undefined, {
    regressionTestCommand: "node -e \"console.log('test')\"",
    regressionTestTimeoutSec: 60,
    tagPrefix: "eag-test",
    healthScoreCalculator: new HealthScoreCalculator(),
  });
  assert.ok(tagger instanceof MilestoneTagger);
});

// ============================================================================
// T3. tag() 请求字段校验
// ============================================================================

test("T3.1 tag() runId 为空 → 抛 invalid-request", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: "node -e \"console.log('test ok')\"",
    });

    await assert.rejects(
      tagger.tag({
        runId: "",
        projectRoot,
        name: "测试 milestone",
        loopType: "design",
      }),
      (err: unknown) => {
        assert.ok(err instanceof MilestoneTaggerError);
        assert.equal(err.kind, "invalid-request");
        assert.ok(err.message.includes("runId 必须为非空字符串"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T3.2 tag() projectRoot 为空 → 抛 invalid-request", async () => {
  const runStateStore = new RunStateStore();
  const tagger = new MilestoneTagger(runStateStore, undefined, {
    regressionTestCommand: "node -e \"console.log('test ok')\"",
  });

  await assert.rejects(
    tagger.tag({
      runId: "testtag001",
      projectRoot: "",
      name: "测试 milestone",
      loopType: "design",
    }),
    (err: unknown) => {
      assert.ok(err instanceof MilestoneTaggerError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.message.includes("projectRoot 必须为非空字符串"));
      return true;
    }
  );
});

test("T3.3 tag() name 为空 → 抛 invalid-request", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: "node -e \"console.log('test ok')\"",
    });

    await assert.rejects(
      tagger.tag({
        runId: "testtag002",
        projectRoot,
        name: "",
        loopType: "design",
      }),
      (err: unknown) => {
        assert.ok(err instanceof MilestoneTaggerError);
        assert.equal(err.kind, "invalid-request");
        assert.ok(err.message.includes("name 必须为非空字符串"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T3.4 tag() loopType 非法 → 抛 invalid-request", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: "node -e \"console.log('test ok')\"",
    });

    await assert.rejects(
      tagger.tag({
        runId: "testtag003",
        projectRoot,
        name: "测试 milestone",
        loopType: "invalid-loop-type" as "design",
      }),
      (err: unknown) => {
        assert.ok(err instanceof MilestoneTaggerError);
        assert.equal(err.kind, "invalid-request");
        assert.ok(err.message.includes("loopType 非法"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

test("T3.5 tag() runId 含非法字符（下划线）→ 抛 invalid-request", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: "node -e \"console.log('test ok')\"",
    });

    await assert.rejects(
      tagger.tag({
        runId: "test_invalid", // 含下划线，不符合 /^[a-zA-Z0-9-]+$/
        projectRoot,
        name: "测试 milestone",
        loopType: "design",
      }),
      (err: unknown) => {
        assert.ok(err instanceof MilestoneTaggerError);
        assert.equal(err.kind, "invalid-request");
        assert.ok(err.message.includes("runId 仅允许字母/数字/连字符"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T4. tag() 成功路径
// ============================================================================

test('T4.1 tag() 首次调用 → milestone.index=1, tagName="eag/<runId>/m1"', async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = "testtag004";
    await createRunState(projectRoot, runStateStore, runId);

    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: "node -e \"console.log('test ok')\"",
    });
    const milestone = await tagger.tag({
      runId,
      projectRoot,
      name: "DESIGN Loop 完成",
      loopType: "design",
    });

    // 验证 milestone 字段
    assert.equal(milestone.index, 1);
    assert.equal(milestone.name, "DESIGN Loop 完成");
    assert.equal(milestone.loopType, "design");
    assert.equal(milestone.tagName, `eag/${runId}/m1`);
    assert.ok(milestone.completedAt.length > 0);
    assert.ok(milestone.commitSha.length >= 7); // git SHA 至少 7 字符（短 SHA）
    assert.ok(milestone.healthScore >= 0 && milestone.healthScore <= 1);
    // 回归测试结果应存在
    assert.ok(milestone.regressionResult !== undefined);
    assert.ok(milestone.regressionResult!.durationSec >= 0);
  } finally {
    rmrf(projectRoot);
  }
});

test('T4.2 tag() 第二次调用 → milestone.index=2, tagName="eag/<runId>/m2"', async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = "testtag005";
    await createRunState(projectRoot, runStateStore, runId);

    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: "node -e \"console.log('test ok')\"",
    });

    // 第一次 tag
    const m1 = await tagger.tag({
      runId,
      projectRoot,
      name: "DESIGN Loop 完成",
      loopType: "design",
    });
    assert.equal(m1.index, 1);
    assert.equal(m1.tagName, `eag/${runId}/m1`);

    // 调用方需追加 milestone-tagged 事件让 RunState.milestones 累积
    // （对齐 EagRunHandler.handle() 中调用 tag() 后的真实流程）
    await recordMilestoneInRunState(runStateStore, runId, m1);

    // 第二次 tag
    const m2 = await tagger.tag({
      runId,
      projectRoot,
      name: "CODING Loop 完成",
      loopType: "coding",
    });
    assert.equal(m2.index, 2);
    assert.equal(m2.tagName, `eag/${runId}/m2`);
    assert.equal(m2.loopType, "coding");
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T5. tag() 创建 git tag 真实性（通过 git tag --list 验证）
// ============================================================================

test("T5.1 tag() 后 git tag --list 含创建的 tag", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = "testtag006";
    await createRunState(projectRoot, runStateStore, runId);

    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: "node -e \"console.log('test ok')\"",
    });
    await tagger.tag({
      runId,
      projectRoot,
      name: "DESIGN Loop 完成",
      loopType: "design",
    });

    // 通过 git tag --list 验证 tag 真实存在
    const tags = listGitTags(projectRoot);
    assert.ok(tags.includes(`eag/${runId}/m1`), `git tag 列表应含 eag/${runId}/m1，实际：\n${tags.join("\n")}`);
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T6. rollback() 校验
// ============================================================================

test("T6.1 rollback() 仅有 1 个 milestone → 返回 null（无可回滚）", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = "testtag007";
    await createRunState(projectRoot, runStateStore, runId);

    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: "node -e \"console.log('test ok')\"",
    });
    // 仅创建 1 个 milestone
    await tagger.tag({
      runId,
      projectRoot,
      name: "DESIGN Loop 完成",
      loopType: "design",
    });

    // rollback 应返回 null（milestones.length < 2）
    const result = await tagger.rollback(runId, projectRoot);
    assert.equal(result, null);
  } finally {
    rmrf(projectRoot);
  }
});

test("T6.2 rollback() runId 为空 → 抛 invalid-request", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: "node -e \"console.log('test ok')\"",
    });

    await assert.rejects(tagger.rollback("", projectRoot), (err: unknown) => {
      assert.ok(err instanceof MilestoneTaggerError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.message.includes("runId 必须为非空字符串"));
      return true;
    });
  } finally {
    rmrf(projectRoot);
  }
});

test("T6.3 rollback() projectRoot 为空 → 抛 invalid-request", async () => {
  const runStateStore = new RunStateStore();
  const tagger = new MilestoneTagger(runStateStore, undefined, {
    regressionTestCommand: "node -e \"console.log('test ok')\"",
  });

  await assert.rejects(tagger.rollback("testtag008", ""), (err: unknown) => {
    assert.ok(err instanceof MilestoneTaggerError);
    assert.equal(err.kind, "invalid-request");
    assert.ok(err.message.includes("projectRoot 必须为非空字符串"));
    return true;
  });
});

// ============================================================================
// T7. rollback() 成功路径
// ============================================================================

test("T7.1 rollback() 有 2 个 milestone → 返回倒数第二个 milestone + git reset --hard", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = "testtag009";
    await createRunState(projectRoot, runStateStore, runId);

    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: "node -e \"console.log('test ok')\"",
    });

    // 创建 2 个 milestone
    const m1 = await tagger.tag({
      runId,
      projectRoot,
      name: "DESIGN Loop 完成",
      loopType: "design",
    });
    // 调用方需追加 milestone-tagged 事件让 RunState.milestones 累积
    await recordMilestoneInRunState(runStateStore, runId, m1);

    // 在第一个 milestone 后追加一个 commit（让 HEAD 前进）
    fs.writeFileSync(path.join(projectRoot, "file-after-m1.txt"), "after m1\n", "utf8");
    childProcess.execSync("git add file-after-m1.txt", { cwd: projectRoot, stdio: "pipe" });
    childProcess.execSync('git commit -m "after m1"', { cwd: projectRoot, stdio: "pipe" });

    const m2 = await tagger.tag({
      runId,
      projectRoot,
      name: "CODING Loop 完成",
      loopType: "coding",
    });
    assert.equal(m2.index, 2);
    // 同样记录 m2 到 RunState（虽然 rollback 不需要，但保持流程一致性）
    await recordMilestoneInRunState(runStateStore, runId, m2);

    // 回滚：应返回 m1（倒数第二个 milestone）
    const rolledBack = await tagger.rollback(runId, projectRoot);
    assert.ok(rolledBack !== null);
    assert.equal(rolledBack!.index, 1);
    assert.equal(rolledBack!.tagName, m1.tagName);

    // 验证 file-after-m1.txt 已被 git reset --hard 删除
    assert.ok(!fs.existsSync(path.join(projectRoot, "file-after-m1.txt")));
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T8. listTags() 测试
// ============================================================================

test("T8.1 listTags() 返回 RunState 中所有 milestone（按 index 升序）", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = "testtag010";
    await createRunState(projectRoot, runStateStore, runId);

    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: "node -e \"console.log('test ok')\"",
    });

    // 创建 3 个 milestone（每次 tag 后追加 milestone-tagged 事件到 RunState）
    const m1 = await tagger.tag({ runId, projectRoot, name: "M1", loopType: "design" });
    await recordMilestoneInRunState(runStateStore, runId, m1);
    fs.writeFileSync(path.join(projectRoot, "f1.txt"), "1\n", "utf8");
    childProcess.execSync('git add f1.txt && git commit -m "c1"', { cwd: projectRoot, stdio: "pipe" });
    const m2 = await tagger.tag({ runId, projectRoot, name: "M2", loopType: "coding" });
    await recordMilestoneInRunState(runStateStore, runId, m2);
    fs.writeFileSync(path.join(projectRoot, "f2.txt"), "2\n", "utf8");
    childProcess.execSync('git add f2.txt && git commit -m "c2"', { cwd: projectRoot, stdio: "pipe" });
    const m3 = await tagger.tag({ runId, projectRoot, name: "M3", loopType: "testing" });
    await recordMilestoneInRunState(runStateStore, runId, m3);

    const tags = await tagger.listTags(runId, projectRoot);
    assert.equal(tags.length, 3);
    // 验证按 index 升序
    assert.equal(tags[0].index, 1);
    assert.equal(tags[1].index, 2);
    assert.equal(tags[2].index, 3);
    // 验证 tag 名
    assert.equal(tags[0].tagName, `eag/${runId}/m1`);
    assert.equal(tags[1].tagName, `eag/${runId}/m2`);
    assert.equal(tags[2].tagName, `eag/${runId}/m3`);
    // 验证 name 字段
    assert.equal(tags[0].name, "M1");
    assert.equal(tags[1].name, "M2");
    assert.equal(tags[2].name, "M3");
  } finally {
    rmrf(projectRoot);
  }
});

test("T8.2 listTags() runId 为空 → 抛 invalid-request", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: "node -e \"console.log('test ok')\"",
    });

    await assert.rejects(tagger.listTags("", projectRoot), (err: unknown) => {
      assert.ok(err instanceof MilestoneTaggerError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.message.includes("runId 必须为非空字符串"));
      return true;
    });
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T9. tag() 失败路径（重复创建同一 tag）
// ============================================================================

test("T9.1 tag() 重复创建同一 tag → 抛 git-tag-create-failed", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = "testtag011";
    await createRunState(projectRoot, runStateStore, runId);

    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: "node -e \"console.log('test ok')\"",
    });

    // 第一次 tag 成功
    const m1 = await tagger.tag({
      runId,
      projectRoot,
      name: "M1",
      loopType: "design",
    });
    // 记录 m1 到 RunState，让第二次 tag() 计算 nextIndex=2
    await recordMilestoneInRunState(runStateStore, runId, m1);

    // 直接在 git 仓库中预先创建 m2 tag（模拟冲突）
    childProcess.execSync(`git tag -a eag/${runId}/m2 -m "predefined m2"`, {
      cwd: projectRoot,
      stdio: "pipe",
    });

    // 第二次 tag 应失败（m2 tag 已存在）
    await assert.rejects(
      tagger.tag({
        runId,
        projectRoot,
        name: "M2",
        loopType: "coding",
      }),
      (err: unknown) => {
        assert.ok(err instanceof MilestoneTaggerError);
        assert.equal(err.kind, "git-tag-create-failed");
        assert.ok(err.message.includes("git tag") || err.message.includes("已存在"));
        return true;
      }
    );
  } finally {
    rmrf(projectRoot);
  }
});

// ============================================================================
// T10. MilestoneTaggerError 字段断言
// ============================================================================

test("T10.1 MilestoneTaggerError 含 kind + cause 字段", () => {
  const cause = new Error("原始 git 错误");
  const err = new MilestoneTaggerError("git-tag-create-failed", "tag 创建失败", cause);
  assert.ok(err instanceof Error);
  assert.equal(err.name, "MilestoneTaggerError");
  assert.equal(err.kind, "git-tag-create-failed");
  assert.equal(err.cause, cause);
  // MilestoneTaggerError 的 message 是构造时传入的 detail 字符串（不含 kind 前缀）
  assert.ok(err.message.includes("tag 创建失败"));
});

test("T10.2 MilestoneTaggerError 全部 kind 字面量覆盖校验", () => {
  // 验证全部 kind 字面量均可构造（确保类型联合无遗漏）
  const kinds: ReadonlyArray<string> = [
    "invalid-request",
    "git-tag-create-failed",
    "git-tag-not-found",
    "git-reset-failed",
    "regression-test-failed",
    "git-command-failed",
  ];
  for (const kind of kinds) {
    const err = new MilestoneTaggerError(kind as never, `测试 ${kind}`, undefined);
    assert.equal(err.kind, kind);
  }
});

// ============================================================================
// T11. tag() 自定义选项
// ============================================================================

test('T11.1 tag() 使用自定义 tagPrefix="eag-test" → tagName="eag-test/<runId>/m1"', async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = "testtag012";
    await createRunState(projectRoot, runStateStore, runId);

    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: "node -e \"console.log('test ok')\"",
      tagPrefix: "eag-test",
    });
    const milestone = await tagger.tag({
      runId,
      projectRoot,
      name: "自定义前缀测试",
      loopType: "design",
    });

    // tagName 应使用自定义前缀
    assert.equal(milestone.tagName, `eag-test/${runId}/m1`);
    // 验证 git tag --list 也包含自定义前缀
    const tags = listGitTags(projectRoot);
    assert.ok(tags.includes(`eag-test/${runId}/m1`));
  } finally {
    rmrf(projectRoot);
  }
});

test("T11.2 tag() 使用自定义回归测试命令 → regressionResult 解析正确", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = "testtag013";
    await createRunState(projectRoot, runStateStore, runId);

    // 创建一个真实的 shell 脚本文件作为回归测试命令
    // 设计理由：MilestoneTagger.runRegressionTests() 使用 split(/\s+/) 简单拆分命令，
    // 不支持引号嵌套，因此含空格的 -e 参数会被错误拆分。
    // 使用 shell 脚本文件避免该限制，同时真实执行（非 mock）。
    const scriptPath = path.join(projectRoot, "fake-test.sh");
    fs.writeFileSync(scriptPath, "#!/bin/sh\n" + "echo '#tests 5'\n" + "echo '#pass 5'\n" + "echo '#fail 0'\n", "utf8");
    fs.chmodSync(scriptPath, 0o755); // 添加可执行权限

    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: scriptPath,
    });
    const milestone = await tagger.tag({
      runId,
      projectRoot,
      name: "自定义回归测试命令",
      loopType: "design",
    });

    // 验证 regressionResult 被正确解析（node:test TAP 格式）
    assert.ok(milestone.regressionResult !== undefined);
    assert.equal(milestone.regressionResult!.totalTests, 5);
    assert.equal(milestone.regressionResult!.passedTests, 5);
    assert.equal(milestone.regressionResult!.failedTests, 0);
  } finally {
    rmrf(projectRoot);
  }
});

test("T11.3 tag() 使用自定义 healthScoreCalculator → 健康度按自定义计算器返回", async () => {
  const projectRoot = makeTempProjectRoot();
  try {
    initGitRepo(projectRoot);
    const runStateStore = new RunStateStore();
    const runId = "testtag014";
    await createRunState(projectRoot, runStateStore, runId);

    // 自定义 HealthScoreCalculator 子类（始终返回 0.42）
    class FixedHealthScoreCalculator extends HealthScoreCalculator {
      override calculate(): number {
        return 0.42;
      }
    }

    const tagger = new MilestoneTagger(runStateStore, undefined, {
      regressionTestCommand: "node -e \"console.log('test ok')\"",
      healthScoreCalculator: new FixedHealthScoreCalculator(),
    });
    const milestone = await tagger.tag({
      runId,
      projectRoot,
      name: "自定义健康度计算器",
      loopType: "design",
    });

    // 健康度应为自定义计算器返回的固定值 0.42
    assert.equal(milestone.healthScore, 0.42);
  } finally {
    rmrf(projectRoot);
  }
});
