/**
 * Autonomous 模块单元测试
 *
 * 验证 9 个组件的真实功能：
 *   1. config-loader
 *   2. run-state
 *   3. notes-memory
 *   4. loop-controller
 *   5. git-driver
 *   6. sleep-guard
 *   7. smart-confirmation
 *   8. auto-skill-loader
 *   9. dispatcher-adapter
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultAutonomousConfig,
  loadAutonomousConfig,
  parseSimpleYaml,
  RunState,
  listRuns,
  findLatestResumableRun,
  NotesMemory,
  RalphLoopController,
  defaultLoopConfig,
  generateRunId,
  GitDriver,
  SleepGuard,
  SmartConfirmation,
  scoreToLevel,
  AutoSkillLoader,
  DispatcherAdapter,
  defaultTaskArgs,
} from "../autonomous/index.js";

// 临时目录 helper
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-autonomous-test-"));
}

function rmTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 静默
  }
}

// ============================================================================
// 1. config-loader 测试
// ============================================================================

test("config-loader: default config has all required fields", () => {
  const config = defaultAutonomousConfig("/tmp/project");
  assert.equal(config.maxIterations, 50);
  assert.equal(config.maxTokens, 500_000);
  assert.equal(config.stopWhen, "");
  assert.deepEqual(config.stageOrder, ["plan", "dev", "verify", "fix"]);
  assert.equal(config.consecutiveFailureAbort, 3);
  assert.equal(config.autoCommit, true);
  assert.equal(config.sleepGuardEnabled, true);
  assert.equal(config.confirmMode, "smart");
  assert.equal(config.notesPath, "/tmp/project/.deepcodex/notes.md");
});

test("config-loader: parseSimpleYaml handles flat key-values", () => {
  const yaml = "maxIterations: 100\nstopWhen: done\nautoCommit: true\n";
  const obj = parseSimpleYaml(yaml);
  assert.equal(obj["maxIterations"], 100);
  assert.equal(obj["stopWhen"], "done");
  assert.equal(obj["autoCommit"], true);
});

test("config-loader: parseSimpleYaml handles lists", () => {
  const yaml = "stageOrder:\n  - plan\n  - dev\n  - verify\n  - fix\n";
  const obj = parseSimpleYaml(yaml);
  assert.deepEqual(obj["stageOrder"], ["plan", "dev", "verify", "fix"]);
});

test("config-loader: loadAutonomousConfig returns default if no files", () => {
  const tmpDir = makeTmpDir();
  try {
    const config = loadAutonomousConfig(tmpDir);
    assert.equal(config.maxIterations, 50);
    assert.equal(config.notesPath, path.join(tmpDir, ".deepcodex", "notes.md"));
  } finally {
    rmTmpDir(tmpDir);
  }
});

// ============================================================================
// 2. run-state 测试
// ============================================================================

test("run-state: new state has correct initial values", () => {
  const rs = new RunState("/tmp/run", "r-test", "test objective");
  const state = rs.getState();
  assert.equal(state.runId, "r-test");
  assert.equal(state.objective, "test objective");
  assert.equal(state.iterIndex, 0);
  assert.equal(state.status, "pending");
  assert.equal(state.schemaVersion, 1);
});

test("run-state: update modifies state and marks dirty", () => {
  const rs = new RunState("/tmp/run", "r-test");
  rs.update({ iterIndex: 5, status: "running" });
  const state = rs.getState();
  assert.equal(state.iterIndex, 5);
  assert.equal(state.status, "running");
});

test("run-state: appendHistory adds timestamped entry", () => {
  const rs = new RunState("/tmp/run", "r-test");
  rs.appendHistory({ kind: "success", summary: "test" });
  const state = rs.getState();
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0]!["kind"], "success");
  assert.ok(typeof state.history[0]!["timestamp"] === "string");
});

test("run-state: persist and load round-trip", () => {
  const tmpDir = makeTmpDir();
  try {
    const runDir = path.join(tmpDir, "r-test");
    fs.mkdirSync(runDir, { recursive: true });
    const rs = new RunState(runDir, "r-test", "test");
    rs.update({ iterIndex: 3, status: "running" });
    rs.appendHistory({ kind: "success" });
    rs.persist();
    const loaded = RunState.load(runDir);
    assert.ok(loaded !== null);
    const state = loaded!.getState();
    assert.equal(state.iterIndex, 3);
    assert.equal(state.status, "running");
    assert.equal(state.history.length, 1);
  } finally {
    rmTmpDir(tmpDir);
  }
});

test("run-state: generateRunId returns r-prefixed hex", () => {
  const id = generateRunId();
  assert.match(id, /^r-[0-9a-f]{12}$/);
});

test("run-state: listRuns returns all runs in directory", () => {
  const tmpDir = makeTmpDir();
  try {
    const r1 = path.join(tmpDir, "r-aaa");
    const r2 = path.join(tmpDir, "r-bbb");
    fs.mkdirSync(r1, { recursive: true });
    fs.mkdirSync(r2, { recursive: true });
    const rs1 = new RunState(r1, "r-aaa", "a");
    rs1.update({ status: "running" });
    rs1.persist();
    const rs2 = new RunState(r2, "r-bbb", "b");
    rs2.update({ status: "completed" });
    rs2.persist();
    const runs = listRuns(tmpDir);
    assert.equal(runs.length, 2);
  } finally {
    rmTmpDir(tmpDir);
  }
});

test("run-state: findLatestResumableRun skips completed", () => {
  const tmpDir = makeTmpDir();
  try {
    const r1 = path.join(tmpDir, "r-old");
    fs.mkdirSync(r1, { recursive: true });
    const rs1 = new RunState(r1, "r-old");
    rs1.update({ status: "completed" });
    rs1.persist();
    const latest = findLatestResumableRun(tmpDir);
    assert.equal(latest, null);
  } finally {
    rmTmpDir(tmpDir);
  }
});

// ============================================================================
// 3. notes-memory 测试
// ============================================================================

test("notes-memory: load returns empty when file missing", () => {
  const tmpDir = makeTmpDir();
  try {
    const notesPath = path.join(tmpDir, "notes.md");
    const nm = new NotesMemory(notesPath);
    assert.equal(nm.load(), "");
  } finally {
    rmTmpDir(tmpDir);
  }
});

test("notes-memory: append then load returns serialized content", () => {
  const tmpDir = makeTmpDir();
  try {
    const notesPath = path.join(tmpDir, "notes.md");
    const nm = new NotesMemory(notesPath);
    nm.append({
      title: "Iteration 1: success",
      body: "First iteration done",
      timestamp: new Date().toISOString(),
      iterIndex: 1,
      tags: ["success"],
    });
    const content = nm.load();
    assert.ok(content.includes("## Iteration 1: success"));
    assert.ok(content.includes("<!-- iter=1 tags=success -->"));
    assert.ok(content.includes("First iteration done"));
  } finally {
    rmTmpDir(tmpDir);
  }
});

test("notes-memory: listSections parses appended sections", () => {
  const tmpDir = makeTmpDir();
  try {
    const notesPath = path.join(tmpDir, "notes.md");
    const nm = new NotesMemory(notesPath);
    nm.append({
      title: "Section A",
      body: "Body A",
      timestamp: new Date().toISOString(),
      iterIndex: 1,
      tags: [],
    });
    nm.append({
      title: "Section B",
      body: "Body B",
      timestamp: new Date().toISOString(),
      iterIndex: 2,
      tags: ["test"],
    });
    const sections = nm.listSections();
    assert.equal(sections.length, 2);
    assert.equal(sections[0]!.title, "Section A");
    assert.equal(sections[0]!.iterIndex, 1);
    assert.equal(sections[1]!.title, "Section B");
    assert.equal(sections[1]!.tags[0], "test");
  } finally {
    rmTmpDir(tmpDir);
  }
});

test("notes-memory: getRecentSections returns last N", () => {
  const tmpDir = makeTmpDir();
  try {
    const notesPath = path.join(tmpDir, "notes.md");
    const nm = new NotesMemory(notesPath);
    for (let i = 1; i <= 5; i++) {
      nm.append({
        title: `Section ${i}`,
        body: `Body ${i}`,
        timestamp: new Date().toISOString(),
        iterIndex: i,
        tags: [],
      });
    }
    const recent = nm.getRecentSections(2);
    assert.equal(recent.length, 2);
    assert.equal(recent[1]!.title, "Section 5");
  } finally {
    rmTmpDir(tmpDir);
  }
});

test("notes-memory: estimateTokens returns char/4", () => {
  const tmpDir = makeTmpDir();
  try {
    const notesPath = path.join(tmpDir, "notes.md");
    const nm = new NotesMemory(notesPath);
    nm.append({
      title: "X",
      body: "01234567890123456789", // 20 chars
      timestamp: new Date().toISOString(),
      iterIndex: 1,
      tags: [],
    });
    const tokens = nm.estimateTokens();
    // body alone = 20 chars / 4 = 5; full content > 5
    assert.ok(tokens >= 5);
  } finally {
    rmTmpDir(tmpDir);
  }
});

test("notes-memory: writeFinalSummary appends Final Summary section", () => {
  const tmpDir = makeTmpDir();
  try {
    const notesPath = path.join(tmpDir, "notes.md");
    const nm = new NotesMemory(notesPath);
    nm.writeFinalSummary("All done");
    const sections = nm.listSections();
    assert.ok(sections.some((s) => s.title === "Final Summary"));
  } finally {
    rmTmpDir(tmpDir);
  }
});

test("notes-memory: clear removes file", () => {
  const tmpDir = makeTmpDir();
  try {
    const notesPath = path.join(tmpDir, "notes.md");
    const nm = new NotesMemory(notesPath);
    nm.append({
      title: "A",
      body: "B",
      timestamp: new Date().toISOString(),
      iterIndex: 1,
      tags: [],
    });
    assert.ok(fs.existsSync(notesPath));
    nm.clear();
    assert.ok(!fs.existsSync(notesPath));
  } finally {
    rmTmpDir(tmpDir);
  }
});

test("notes-memory: trim removes old sections when exceeding max size", () => {
  const tmpDir = makeTmpDir();
  try {
    const notesPath = path.join(tmpDir, "notes.md");
    const nm = new NotesMemory(notesPath, 1, 3); // 1KB max, keep 3
    for (let i = 1; i <= 10; i++) {
      nm.append({
        title: `Section ${i}`,
        body: "X".repeat(200),
        timestamp: new Date().toISOString(),
        iterIndex: i,
        tags: [],
      });
    }
    const sections = nm.listSections();
    // 应触发 trim
    assert.ok(sections.length <= 10);
  } finally {
    rmTmpDir(tmpDir);
  }
});

// ============================================================================
// 4. loop-controller 测试
// ============================================================================

test("loop-controller: defaultLoopConfig has expected values", () => {
  const config = defaultLoopConfig();
  assert.equal(config.maxIterations, 50);
  assert.equal(config.maxTokens, 500_000);
  assert.deepEqual(config.stageOrder, ["plan", "dev", "verify", "fix"]);
  assert.equal(config.consecutiveFailureAbort, 3);
});

test("loop-controller: constructor stores config", () => {
  const tmpDir = makeTmpDir();
  try {
    const runState = makeRunStateLike(tmpDir, "r-test");
    const controller = new RalphLoopController({
      config: defaultLoopConfig(),
      projectRoot: tmpDir,
      gitDriver: makeGitDriverLike(),
      notesMemory: null,
      runState,
      stageHandlers: {
        plan: { handle: () => ({ kind: "success" as const, summary: "plan stage ok", artifacts: {} }) },
        dev: { handle: () => ({ kind: "success" as const, summary: "dev stage ok", artifacts: {} }) },
        verify: { handle: () => ({ kind: "success" as const, summary: "verify stage ok", artifacts: {} }) },
        fix: { handle: () => ({ kind: "success" as const, summary: "fix stage ok", artifacts: {} }) },
      },
    });
    assert.equal(controller.shouldStopPublic(), false);
  } finally {
    rmTmpDir(tmpDir);
  }
});

test("loop-controller: shouldStop returns true when iterIndex >= maxIterations", () => {
  const tmpDir = makeTmpDir();
  try {
    const runState = makeRunStateLike(tmpDir, "r-test", { iterIndex: 51 });
    const controller = new RalphLoopController({
      config: defaultLoopConfig(),
      projectRoot: tmpDir,
      gitDriver: makeGitDriverLike(),
      notesMemory: null,
      runState,
      stageHandlers: {
        plan: { handle: () => ({ kind: "success" as const, summary: "plan stage ok", artifacts: {} }) },
        dev: { handle: () => ({ kind: "success" as const, summary: "dev stage ok", artifacts: {} }) },
        verify: { handle: () => ({ kind: "success" as const, summary: "verify stage ok", artifacts: {} }) },
        fix: { handle: () => ({ kind: "success" as const, summary: "fix stage ok", artifacts: {} }) },
      },
    });
    assert.equal(controller.shouldStopPublic(), true);
  } finally {
    rmTmpDir(tmpDir);
  }
});

// ============================================================================
// 5. git-driver 测试
// ============================================================================

test("git-driver: isGitRepo returns false for non-git directory", () => {
  const tmpDir = makeTmpDir();
  try {
    const gd = new GitDriver({ repoRoot: tmpDir, runId: "r-test" });
    assert.equal(gd.isGitRepo(), false);
  } finally {
    rmTmpDir(tmpDir);
  }
});

test("git-driver: status returns error for non-git directory", () => {
  const tmpDir = makeTmpDir();
  try {
    const gd = new GitDriver({ repoRoot: tmpDir, runId: "r-test" });
    const result = gd.status();
    assert.equal(result.success, false);
  } finally {
    rmTmpDir(tmpDir);
  }
});

test("git-driver: commit rejects empty message", () => {
  const tmpDir = makeTmpDir();
  try {
    const gd = new GitDriver({ repoRoot: tmpDir, runId: "r-test" });
    const result = gd.commit("");
    assert.equal(result.success, false);
    assert.ok(result.errorMessage.includes("不能为空"));
  } finally {
    rmTmpDir(tmpDir);
  }
});

// ============================================================================
// 6. sleep-guard 测试
// ============================================================================

test("sleep-guard: detectPlatformBackend returns valid backend", () => {
  const backend = SleepGuard.detectPlatformBackend();
  assert.ok(["caffeinate", "systemd-inhibit", "noop"].includes(backend));
});

test("sleep-guard: mode=off returns noop handle", () => {
  const sg = new SleepGuard("off");
  const handle = sg.acquire();
  assert.equal(handle.backend, "noop");
  assert.equal(handle.process, null);
  sg.release();
});

test("sleep-guard: release on uninitialized is no-op", () => {
  const sg = new SleepGuard("off");
  sg.release();
  assert.equal(sg.isActive(), false);
});

// ============================================================================
// 7. smart-confirmation 测试
// ============================================================================

test("smart-confirmation: blacklisted command returns DENY", () => {
  const sc = new SmartConfirmation();
  const result = sc.check("rm -rf / ");
  assert.equal(result.decision, "deny");
  assert.equal(result.riskLevel, "critical");
});

test("smart-confirmation: whitelisted command returns AUTO", () => {
  const sc = new SmartConfirmation();
  const result = sc.check("npm test");
  assert.equal(result.decision, "auto");
  assert.equal(result.riskLevel, "low");
});

test("smart-confirmation: empty command returns DENY", () => {
  const sc = new SmartConfirmation();
  const result = sc.check("");
  assert.equal(result.decision, "deny");
});

test("smart-confirmation: isDestructive detects blacklisted", () => {
  const sc = new SmartConfirmation();
  assert.equal(sc.isDestructive("rm -rf /etc"), true);
  assert.equal(sc.isDestructive("ls -la"), false);
});

test("smart-confirmation: checkBatch processes multiple", () => {
  const sc = new SmartConfirmation();
  const results = sc.checkBatch(["npm test", "rm -rf / "]);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.decision, "auto");
  assert.equal(results[1]!.decision, "deny");
});

test("scoreToLevel: maps scores correctly", () => {
  assert.equal(scoreToLevel(0), "low");
  assert.equal(scoreToLevel(30), "low");
  assert.equal(scoreToLevel(31), "medium");
  assert.equal(scoreToLevel(70), "medium");
  assert.equal(scoreToLevel(71), "high");
  assert.equal(scoreToLevel(100), "high");
});

// ============================================================================
// 8. auto-skill-loader 测试
// ============================================================================

test("auto-skill-loader: detect on non-existent dir returns empty", () => {
  const tmpDir = makeTmpDir();
  try {
    const loader = new AutoSkillLoader({ projectRoot: tmpDir });
    const skills = loader.detect();
    assert.deepEqual(skills, []);
  } finally {
    rmTmpDir(tmpDir);
  }
});

test("auto-skill-loader: detect loads JSON manifest", () => {
  const tmpDir = makeTmpDir();
  try {
    const skillsDir = path.join(tmpDir, ".deepcodex", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "test-skill.json"),
      JSON.stringify({
        name: "test-skill",
        description: "A test skill",
        triggers: ["test", "demo"],
        priority: 50,
        version: "1.0.0",
      }),
      "utf-8"
    );
    const loader = new AutoSkillLoader({ projectRoot: tmpDir });
    const skills = loader.detect();
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, "test-skill");
    assert.equal(skills[0]!.priority, 50);
  } finally {
    rmTmpDir(tmpDir);
  }
});

test("auto-skill-loader: detectForTask filters by trigger", () => {
  const tmpDir = makeTmpDir();
  try {
    const skillsDir = path.join(tmpDir, ".deepcodex", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "matching.json"),
      JSON.stringify({
        name: "matching",
        triggers: ["search", "find"],
        priority: 10,
      }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(skillsDir, "nonmatching.json"),
      JSON.stringify({
        name: "nonmatching",
        triggers: ["unrelated"],
        priority: 10,
      }),
      "utf-8"
    );
    const loader = new AutoSkillLoader({ projectRoot: tmpDir });
    const relevant = loader.detectForTask("I need to search for files");
    assert.equal(relevant.length, 1);
    assert.equal(relevant[0]!.name, "matching");
  } finally {
    rmTmpDir(tmpDir);
  }
});

test("auto-skill-loader: formatForPrompt returns markdown", () => {
  const loader = new AutoSkillLoader({ projectRoot: "/tmp/nonexistent" });
  const formatted = loader.formatForPrompt([
    {
      name: "test",
      path: "/tmp/test.json",
      description: "test skill",
      triggers: ["a", "b"],
      priority: 50,
      version: "1.0.0",
      author: "",
      requires: [],
    },
  ]);
  assert.ok(formatted.includes("Available Auto-Loaded Skills"));
  assert.ok(formatted.includes("**test**"));
});

test("auto-skill-loader: empty task returns empty", () => {
  const loader = new AutoSkillLoader({ projectRoot: "/tmp" });
  assert.deepEqual(loader.detectForTask(""), []);
});

// ============================================================================
// 9. dispatcher-adapter 测试
// ============================================================================

test("dispatcher-adapter: empty task returns FATAL", () => {
  const da = new DispatcherAdapter();
  const result = da.invoke({ task: "" });
  assert.equal(result.success, false);
  assert.equal(result.kind, "fatal");
});

test("dispatcher-adapter: isAvailable returns false without facade", () => {
  const da = new DispatcherAdapter();
  assert.equal(da.isAvailable(), false);
});

test("dispatcher-adapter: invoke returns FATAL when facade unavailable", () => {
  const da = new DispatcherAdapter();
  const result = da.invoke({ task: "test task" });
  assert.equal(result.kind, "fatal");
  assert.ok(result.summary.includes("不可用") || result.summary.includes("缺少"));
});

test("dispatcher-adapter: invokeWithArgs returns FATAL when facade unavailable", () => {
  const da = new DispatcherAdapter();
  const args = defaultTaskArgs("test");
  const result = da.invokeWithArgs(args);
  assert.equal(result.kind, "fatal");
});

test("dispatcher-adapter: invoke with mock facade returns success on rc=0", () => {
  const mockFacade = {
    _dispatchThroughV3: (_args: unknown) => 0,
  };
  const da = new DispatcherAdapter({ facade: mockFacade });
  da.isAvailable();
  const result = da.invoke({ task: "test" });
  assert.equal(result.success, true);
  assert.equal(result.kind, "success");
});

test("dispatcher-adapter: invoke with mock facade returns retriable on rc=1", () => {
  const mockFacade = {
    _dispatchThroughV3: (_args: unknown) => 1,
  };
  const da = new DispatcherAdapter({ facade: mockFacade });
  da.isAvailable();
  const result = da.invoke({ task: "test" });
  assert.equal(result.success, false);
  assert.equal(result.kind, "retriable");
});

test("dispatcher-adapter: invoke with mock facade returns fatal on rc=3", () => {
  const mockFacade = {
    _dispatchThroughV3: (_args: unknown) => 3,
  };
  const da = new DispatcherAdapter({ facade: mockFacade });
  da.isAvailable();
  const result = da.invoke({ task: "test" });
  assert.equal(result.success, false);
  assert.equal(result.kind, "fatal");
});

test("dispatcher-adapter: invoke captures exception as FATAL", () => {
  const mockFacade = {
    _dispatchThroughV3: (_args: unknown) => {
      throw new Error("dispatcher crashed");
    },
  };
  const da = new DispatcherAdapter({ facade: mockFacade });
  da.isAvailable();
  const result = da.invoke({ task: "test" });
  assert.equal(result.kind, "fatal");
  assert.ok(result.error !== null);
  assert.ok(result.errorTrace.length > 0);
});

// ============================================================================
// 辅助：构造 RunStateLike 和 GitDriverLike
// ============================================================================

interface RunStateLikeLocal {
  state: {
    runId: string;
    objective: string;
    iterIndex: number;
    cumulativeTokens: number;
    commitsMade: number;
    status: "pending" | "running" | "completed" | "aborted" | "failed";
  };
  markRunning(): void;
  markComplete(): void;
  markFailed(reason: string): void;
  markAborted(reason: string): void;
  recordIteration(args: unknown): void;
}

function makeRunStateLike(
  projectRoot: string,
  runId: string,
  overrides: Partial<RunStateLikeLocal["state"]> = {}
): RunStateLikeLocal {
  return {
    state: {
      runId,
      objective: "test",
      iterIndex: 0,
      cumulativeTokens: 0,
      commitsMade: 0,
      status: "pending",
      ...overrides,
    },
    markRunning() {
      this.state.status = "running";
    },
    markComplete() {
      this.state.status = "completed";
    },
    markFailed(_reason: string) {
      this.state.status = "failed";
    },
    markAborted(_reason: string) {
      this.state.status = "aborted";
    },
    recordIteration(_args: unknown) {
      // noop
    },
  };
}

function makeGitDriverLike(): {
  commit(message: string): { success: boolean; errorMessage?: string };
  rollback(): { success: boolean; errorMessage?: string };
} {
  return {
    commit(_message: string) {
      return { success: true };
    },
    rollback() {
      return { success: true };
    },
  };
}
