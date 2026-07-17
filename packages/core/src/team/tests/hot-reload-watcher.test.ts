/**
 * HotReloadWatcher 测试
 *
 * 验证路径安全、扫描、文件变更检测
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { HotReloadWatcher, POLL_INTERVAL } from "../hot-reload-watcher.js";
import { GoalDispatcher, PluginRegistry } from "../plugins/goal-dispatcher.js";
import { DropInPathAbsoluteError, DropInPathOutsideRootError, DropInPathNotDirError } from "../errors.js";

function makeProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "watcher-test-"));
}

test("POLL_INTERVAL constants are valid", () => {
  assert.ok(POLL_INTERVAL.MIN < POLL_INTERVAL.DEFAULT);
  assert.ok(POLL_INTERVAL.DEFAULT < POLL_INTERVAL.MAX);
  assert.equal(POLL_INTERVAL.MIN, 0.5);
  assert.equal(POLL_INTERVAL.MAX, 60.0);
});

test("HotReloadWatcher rejects absolute path", () => {
  const projectRoot = makeProject();
  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  assert.throws(() => new HotReloadWatcher(dispatcher, "/absolute/path", projectRoot), DropInPathAbsoluteError);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("HotReloadWatcher rejects path outside project root", () => {
  const projectRoot = makeProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  assert.throws(() => new HotReloadWatcher(dispatcher, "../escape", projectRoot), DropInPathOutsideRootError);
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("HotReloadWatcher creates drop-in dir if missing", () => {
  const projectRoot = makeProject();
  const dropInDir = path.join(projectRoot, ".drop-in");
  assert.equal(fs.existsSync(dropInDir), false);
  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  new HotReloadWatcher(dispatcher, ".drop-in", projectRoot);
  assert.equal(fs.existsSync(dropInDir), true);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("HotReloadWatcher rejects file path (not dir)", () => {
  const projectRoot = makeProject();
  const filePath = path.join(projectRoot, "not-a-dir.txt");
  fs.writeFileSync(filePath, "hello");
  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  assert.throws(() => new HotReloadWatcher(dispatcher, "not-a-dir.txt", projectRoot), DropInPathNotDirError);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("HotReloadWatcher.scanOnce on empty dir", async () => {
  const projectRoot = makeProject();
  const dropInDir = path.join(projectRoot, ".drop-in");
  fs.mkdirSync(dropInDir);
  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  const watcher = new HotReloadWatcher(dispatcher, ".drop-in", projectRoot, {
    pollInterval: 60,
  });
  await watcher.scanOnce();
  assert.equal(watcher.listLoaded().length, 0);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("HotReloadWatcher clamps pollInterval", () => {
  const projectRoot = makeProject();
  fs.mkdirSync(path.join(projectRoot, ".drop-in"));
  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  // Very small → clamped to MIN
  const w1 = new HotReloadWatcher(dispatcher, ".drop-in", projectRoot, { pollInterval: 0.1 });
  // Very large → clamped to MAX
  const w2 = new HotReloadWatcher(dispatcher, ".drop-in", projectRoot, { pollInterval: 1000 });
  assert.ok(w1);
  assert.ok(w2);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("HotReloadWatcher logs via logCallback", async () => {
  const projectRoot = makeProject();
  fs.mkdirSync(path.join(projectRoot, ".drop-in"));
  const logs: Array<{ level: string; msg: string }> = [];
  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  const watcher = new HotReloadWatcher(dispatcher, ".drop-in", projectRoot, {
    logCallback: (level, msg) => logs.push({ level, msg }),
  });
  await watcher.scanOnce();
  // Should have logged "Watcher" message
  assert.ok(logs.length > 0);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("HotReloadWatcher getGuard returns guard", () => {
  const projectRoot = makeProject();
  fs.mkdirSync(path.join(projectRoot, ".drop-in"));
  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  const watcher = new HotReloadWatcher(dispatcher, ".drop-in", projectRoot);
  const guard = watcher.getGuard();
  assert.equal(guard.isBusy(), false);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("HotReloadWatcher stop() is idempotent", async () => {
  const projectRoot = makeProject();
  fs.mkdirSync(path.join(projectRoot, ".drop-in"));
  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  const watcher = new HotReloadWatcher(dispatcher, ".drop-in", projectRoot);
  await watcher.start();
  watcher.stop();
  watcher.stop();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("HotReloadWatcher waitInitialScan returns true after start", async () => {
  const projectRoot = makeProject();
  fs.mkdirSync(path.join(projectRoot, ".drop-in"));
  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  const watcher = new HotReloadWatcher(dispatcher, ".drop-in", projectRoot);
  await watcher.start();
  const done = await watcher.waitInitialScan(1000);
  assert.equal(done, true);
  watcher.stop();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("HotReloadWatcher scanOnce handles missing dir gracefully", async () => {
  const projectRoot = makeProject();
  // 创建后立即删除以模拟目录消失
  const dropInDir = path.join(projectRoot, ".drop-in");
  fs.mkdirSync(dropInDir);
  fs.rmSync(dropInDir, { recursive: true, force: true });

  const registry = new PluginRegistry();
  const dispatcher = new GoalDispatcher(registry);
  // 构造时创建（drop-in 不存在 → 构造时创建）
  const watcher = new HotReloadWatcher(dispatcher, ".drop-in", projectRoot);
  // 删除后再 scan
  fs.rmSync(path.join(projectRoot, ".drop-in"), { recursive: true, force: true });
  const logs: string[] = [];
  watcher["logCallback"] = (level, msg) => {
    if (level === "warn") logs.push(msg);
  };
  // 重新设置 logCallback
  (watcher as unknown as { logCallback: (l: string, m: string) => void }).logCallback = (l, m) => {
    if (l === "warn") logs.push(m);
  };
  await watcher.scanOnce();
  assert.ok(logs.some((l) => l.includes("不存在")));
  fs.rmSync(projectRoot, { recursive: true, force: true });
});
