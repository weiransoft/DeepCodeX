/**
 * 集成契约测试：壳侧策略文件 → sidecar 策略加载；MCP 登记 → 两份配置。
 *
 * 这两处是「接线」而非「算法」：最容易在重构时静默断掉，所以用测试锁死形状。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  bundledPolicyPath,
  hardenExternalPolicy,
  loadPolicy,
  resolvePolicyPath,
  shellPolicyPath,
} from "../src/modules/policy-load.mjs";
import { DEFAULT_DENIED_CATEGORIES } from "../src/modules/policy-guard.mjs";
import {
  MCP_NAME,
  applyRegistration,
  buildEntries,
  parseArgs,
  readConfig,
  removeRegistration,
  run,
} from "../scripts/register-mcp.mjs";

const quiet = () => {};

test("策略路径优先级：显式 env > 壳落盘 > 仓库默认", () => {
  const env = { DEEPCODE_AGENT_POLICY: "C:/tmp/custom.json" };
  assert.deepEqual(resolvePolicyPath({ env, home: "/home/u", exists: () => true }), {
    path: resolve("C:/tmp/custom.json"),
    source: "env",
  });
  assert.equal(resolvePolicyPath({ env: {}, home: "/home/u", exists: () => true }).source, "shell");
  assert.equal(resolvePolicyPath({ env: {}, home: "/home/u", exists: () => false }).path, bundledPolicyPath());
  assert.equal(resolvePolicyPath({ env: {}, home: "/home/u", exists: () => false }).source, "bundled");
  assert.equal(shellPolicyPath("/home/u"), join("/home/u", ".deepcode", "desktop-agent.json"));
});

test("外部策略硬化：锁定字段不可放宽，bypass 降级，非法条目丢弃", () => {
  const p = hardenExternalPolicy({
    enabled: true,
    permissionMode: "bypass",
    deniedCategories: [],
    allowScreenshot: true,
    allowCoordinateInput: true,
    preferBrowserChannel: false,
    maxSteps: 9999,
    maxTokens: -1,
    maxRetries: 99,
    allowedApps: [
      { appId: "notepad", always: true, scopes: ["read", "admin"] },
      { appId: "../evil", always: true, scopes: ["write"] },
    ],
    deniedApps: ["bad\\path", "ok-app"],
    _comment: "不应透传",
    injectedField: "x",
  });
  assert.equal(p.enabled, true);
  assert.equal(p.permissionMode, "manual");
  assert.deepEqual(p.deniedCategories, [...DEFAULT_DENIED_CATEGORIES]);
  assert.equal(p.allowScreenshot, false);
  assert.equal(p.allowCoordinateInput, false);
  assert.equal(p.preferBrowserChannel, true);
  assert.equal(p.maxSteps, 100);
  assert.equal(p.maxTokens, 1000);
  assert.equal(p.maxRetries, 5);
  assert.equal(p.allowedApps.length, 1);
  assert.deepEqual(p.allowedApps[0], { appId: "notepad", always: true, scopes: ["read"] });
  assert.deepEqual(p.deniedApps, ["ok-app"]);
  assert.equal(p._comment, undefined);
  assert.equal(p.injectedField, undefined);
});

test("loadPolicy：读壳策略生效；文件损坏时回落「默认关闭」而不是带病启动", () => {
  const good = loadPolicy({
    env: {},
    home: "/home/u",
    exists: () => true,
    read: () => JSON.stringify({ enabled: true, permissionMode: "auto", allowedApps: [{ appId: "notepad", scopes: ["read"] }] }),
  });
  assert.equal(good.source, "shell");
  assert.equal(good.policy.enabled, true);
  assert.equal(good.policy.permissionMode, "auto");
  assert.equal(good.error, null);

  const bad = loadPolicy({ env: {}, home: "/home/u", exists: () => true, read: () => "{ not json" });
  assert.equal(bad.source, "fallback");
  assert.equal(bad.policy.enabled, false);
  assert.notEqual(bad.error, null);
});

test("MCP 登记：两种形态同时写、保留其他服务与其它配置键、幂等", () => {
  const entries = buildEntries({ entryPath: "C:/repo/desktop-agent/src/index.mjs", command: "node" });
  const settings = { mcpServers: { sql: { command: "uvx", args: ["x"] } }, web: { ldap: { url: "ldap://x" } } };
  const desktop = { mcpServers: [{ id: "m", name: "sql", command: "uvx", args: ["x"], enabled: true }], models: [{ id: "m1" }] };

  const r = applyRegistration({ ...entries, settings, desktop });
  assert.equal(r.changed, true);
  assert.equal(r.settings.mcpServers[MCP_NAME].command, "node");
  assert.deepEqual(r.settings.mcpServers.sql, { command: "uvx", args: ["x"] }); // 引擎侧其它服务不动
  assert.deepEqual(r.settings.web, { ldap: { url: "ldap://x" } }); // 未知键不动
  assert.equal(r.desktop.mcpServers.length, 2);
  assert.equal(r.desktop.mcpServers.at(-1).name, MCP_NAME);
  assert.deepEqual(r.desktop.models, [{ id: "m1" }]);
  assert.deepEqual(settings.mcpServers.sql, { command: "uvx", args: ["x"] }); // 入参未被修改
  assert.equal(desktop.mcpServers.length, 1);

  const again = applyRegistration({ ...entries, settings: r.settings, desktop: r.desktop });
  assert.equal(again.changed, false); // 幂等：重复执行不产生变更
});

test("MCP 移除：只摘掉 sidecar，其它服务保留", () => {
  const entries = buildEntries({ entryPath: "C:/repo/index.mjs", command: "node" });
  const added = applyRegistration({ ...entries, settings: {}, desktop: { mcpServers: [{ id: "sql", name: "sql", command: "uvx" }] } });
  const removed = removeRegistration(added);
  assert.equal(removed.changed, true);
  assert.equal(removed.settings.mcpServers[MCP_NAME], undefined);
  assert.equal(removed.desktop.mcpServers.length, 1);
  assert.equal(removeRegistration(removed).changed, false);
});

test("readConfig：缺失 / 损坏文件安全回落并给出警告", () => {
  const dir = mkdtempSync(join(tmpdir(), "dcx-cfg-"));
  try {
    assert.deepEqual(readConfig(join(dir, "missing.json")), { value: {}, warning: null });
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ bad", "utf8");
    const r = readConfig(broken);
    assert.deepEqual(r.value, {});
    assert.match(r.warning, /解析失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run：默认 dry-run 不落盘；--write 双写并备份；--remove 撤销", () => {
  const home = mkdtempSync(join(tmpdir(), "dcx-home-"));
  const dir = join(home, ".deepcode");
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "settings.json");
  const desktopPath = join(dir, "desktop.json");
  try {
    writeFileSync(settingsPath, JSON.stringify({ mcpServers: {} }), "utf8");
    writeFileSync(desktopPath, JSON.stringify({ mcpServers: [], firstLoginDone: true }), "utf8");

    const dry = run(["--home", home], { log: quiet });
    assert.equal(dry.applied, false);
    assert.equal(dry.changed, true);
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).mcpServers[MCP_NAME], undefined);

    assert.deepEqual(parseArgs(["--write", "--home", home]).write, true);
    const written = run(["--home", home, "--write"], { log: quiet });
    assert.equal(written.applied, true);
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    const d = JSON.parse(readFileSync(desktopPath, "utf8"));
    assert.equal(s.mcpServers[MCP_NAME].args.length, 1);
    assert.equal(d.mcpServers[0].name, MCP_NAME);
    assert.equal(d.firstLoginDone, true);
    assert.equal(existsSync(`${settingsPath}.bak`), true);
    assert.equal(existsSync(`${desktopPath}.bak`), true);

    const again = run(["--home", home, "--write"], { log: quiet });
    assert.equal(again.changed, false); // 幂等，不重复写

    const removed = run(["--home", home, "--remove", "--write"], { log: quiet });
    assert.equal(removed.applied, true);
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).mcpServers[MCP_NAME], undefined);
    assert.deepEqual(JSON.parse(readFileSync(desktopPath, "utf8")).mcpServers, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
