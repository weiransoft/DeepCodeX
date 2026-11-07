/**
 * 策略热重载（AgentLifecycle）：授权/撤销在下一次工具调用前生效。
 *
 * 这一组要锁住的核心不是「能重载」，而是**不能因为重载出现安全回退**：
 *   - 撤销后旧授权不能残留（整体替换，不是 patch merge）；
 *   - 文件损坏/删除必须收紧到默认全关，不能沿用上一次的有效授权；
 *   - 每次重载都重新 harden，手改 JSON 不能放宽；
 *   - 重载不换 guard 实例，否则子模块继续按旧策略判定（静默越权）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PolicyReloader } from "../src/modules/policy-load.mjs";
import { PolicyGuard } from "../src/modules/policy-guard.mjs";
import { DesktopAgent } from "../src/agent.mjs";
import { createMockBackend } from "../src/backends/mock.mjs";

const MINUTE = 60_000;
const NOW = Date.now();

/** 每个用例一个独立临时策略文件，退出时清理 */
function tmpPolicy(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "desktop-agent.json");
}

/** 与壳侧 desktop_agent.rs 写出的形状一致（可写字段 + 派生字段都带上） */
function base(extra = {}) {
  return {
    enabled: true,
    permissionMode: "auto",
    allowedApps: [{ appId: "notepad", always: true, scopes: ["read", "write"] }],
    deniedApps: [],
    deniedCategories: ["finance", "crypto", "medical", "government", "finance-or-sensitive"],
    preferBrowserChannel: true,
    allowCoordinateInput: false,
    allowScreenshot: false,
    vision: null,
    maxSteps: 25,
    maxScreenshots: 3,
    maxTokens: 60_000,
    maxRetries: 2,
    ...extra,
  };
}

function grant(apps, { coord = false, at = NOW, ttl = 30 * MINUTE } = {}) {
  return {
    apps,
    allowCoordinateInput: coord,
    grantedAt: at,
    expiresAt: at + ttl,
    grantId: "g-lifecycle-test",
  };
}

const write = (path, obj) => writeFileSync(path, JSON.stringify(obj), "utf8");

function makeAgent(path, clock) {
  const reloader = new PolicyReloader({ path, ...(clock ? { clock } : {}) });
  const initial = reloader.current();
  const agent = new DesktopAgent({
    backend: createMockBackend(),
    policy: initial.policy,
    limits: initial.policy,
    reloader,
  });
  return { agent, reloader };
}

const screenshot = (agent) =>
  agent.callTool("desktop_screenshot", {
    appId: "notepad",
    reason: "policy-lifecycle",
    includeImage: true,
  });

// ─────────── PolicyGuard.replace：整体替换 ───────────

test("replace 是整体替换：撤销后旧视觉授权不残留，确认令牌一并作废", () => {
  const guard = new PolicyGuard(
    base({
      allowScreenshot: true,
      allowCoordinateInput: true,
      visionApps: ["notepad"],
      visionExpiresAt: NOW + MINUTE,
    })
  );
  const token = guard.createConfirmation("notepad", "submit");
  const identity = guard;

  const snap = guard.replace({ enabled: true });

  assert.equal(guard, identity, "实例引用必须不变");
  assert.equal(snap.allowScreenshot, false, "merge 会让旧开关残留，replace 不会");
  assert.equal(snap.allowCoordinateInput, false);
  assert.deepEqual(snap.visionApps, []);
  assert.equal(snap.visionExpiresAt, 0);
  assert.equal(snap.pendingConfirmations, 0);
  assert.equal(guard.consumeConfirmation(token, "notepad", "submit"), false, "策略变更后旧确认令牌不能再用");
});

// ─────────── PolicyReloader：变更探测 ───────────

test("首次解析 → 内容不变不重解析 → 内容变化才重载", (t) => {
  const path = tmpPolicy(t);
  write(path, base({ vision: grant(["notepad"]) }));
  const events = [];
  const r = new PolicyReloader({ path, onReload: (e) => events.push(e) });

  const first = r.current();
  assert.equal(first.reason, "initial");
  assert.equal(first.policy.allowScreenshot, true);
  assert.equal(r.revision, 1);

  const second = r.current();
  assert.equal(second.changed, false);
  assert.equal(second.reason, "unchanged");
  assert.equal(r.revision, 1);
  assert.equal(events.length, 1, "没变就不该重复 harden / 重复发事件");

  write(path, base({ vision: null }));
  const third = r.current();
  assert.equal(third.reason, "content-changed");
  assert.equal(third.policy.allowScreenshot, false);
  assert.equal(r.revision, 2);
  assert.equal(events.length, 2);
});

test("内容签名不依赖 mtime：mtime 被还原时仍能探测到变更", (t) => {
  const path = tmpPolicy(t);
  write(path, base({ vision: null }));
  const r = new PolicyReloader({ path });
  r.current();
  const { atime, mtime } = statSync(path);

  write(path, base({ vision: grant(["notepad"]) }));
  utimesSync(path, atime, mtime); // 原子写/编辑器常常保留 mtime

  const state = r.current();
  assert.equal(state.reason, "content-changed");
  assert.equal(state.policy.allowScreenshot, true);
});

test("手改 JSON 里的开关不能放宽：每次重载都重跑 hardenExternalPolicy", (t) => {
  const path = tmpPolicy(t);
  write(path, base({ vision: null }));
  const r = new PolicyReloader({ path });
  assert.equal(r.current().policy.allowScreenshot, false);

  // 模拟人工篡改：把两个派生字段直接写成 true，但没有合法 vision
  write(path, base({ allowScreenshot: true, allowCoordinateInput: true, vision: null }));
  const p = r.current().policy;
  assert.equal(p.allowScreenshot, false);
  assert.equal(p.allowCoordinateInput, false);
});

test("授权到期后重解析把开关一并收回（不只是动作时拒绝）", (t) => {
  const path = tmpPolicy(t);
  const T0 = 1_700_000_000_000;
  write(path, base({ vision: grant(["notepad"], { at: T0, ttl: MINUTE }) }));
  let now = T0;
  const r = new PolicyReloader({ path, clock: () => now });

  assert.equal(r.current().policy.allowScreenshot, true);
  now = T0 + MINUTE;
  const expired = r.current();
  assert.equal(expired.reason, "vision-expired");
  assert.equal(expired.policy.allowScreenshot, false);
  assert.equal(expired.policy.visionExpiresAt, 0);
  assert.equal(r.current().changed, false, "收回后不应每次调用都重复刷新");
});

// ─────────── fail-closed ───────────

test("策略文件消失 / JSON 损坏 → fail-closed 回落到默认全关，恢复后重新解析", (t) => {
  const path = tmpPolicy(t);
  write(path, base({ vision: grant(["notepad"]) }));
  const errors = [];
  const r = new PolicyReloader({ path, onError: (e) => errors.push(e) });
  assert.equal(r.current().policy.allowScreenshot, true);

  rmSync(path);
  const gone = r.current();
  assert.equal(gone.failed, true);
  assert.match(gone.reason, /^fail-closed:unreadable/);
  assert.equal(gone.policy.allowScreenshot, false, "删文件不能反而保住旧授权");
  assert.equal(gone.policy.enabled, false);
  assert.equal(gone.changed, true, "收紧必须让上层真的替换策略");
  assert.equal(errors.length, 1);
  assert.equal(r.current().changed, false, "持续故障不重复刷事件");

  write(path, base({ vision: grant(["notepad"]) }));
  const back = r.current();
  assert.equal(back.failed, false);
  assert.equal(back.policy.allowScreenshot, true, "缓存作废后文件恢复必须重新解析");
  assert.equal(errors.length, 1);

  writeFileSync(path, "{ not-json", "utf8");
  const broken = r.current();
  assert.equal(broken.failed, true);
  assert.match(broken.reason, /^fail-closed:invalid-policy/);
  assert.equal(broken.policy.allowScreenshot, false);

  // 修好后不沿用损坏前的授权（内容签名已作废）
  write(path, base({ vision: null }));
  assert.equal(r.current().policy.allowScreenshot, false);
});

// ─────────── DesktopAgent 端到端：授权 / 撤销即时生效 ───────────

test("新授权在下一次工具调用前生效，无需重启引擎", async (t) => {
  const path = tmpPolicy(t);
  write(path, base({ vision: null }));
  const { agent } = makeAgent(path);

  const before = await screenshot(agent);
  assert.equal(before.ok, false);
  assert.equal(before.code, "CAPABILITY_UNAVAILABLE");

  write(path, base({ vision: grant(["notepad"]) }));
  const after = await screenshot(agent);
  assert.equal(after.ok, true, "同一个进程、同一个 guard，改文件后应立即放行");
  assert.equal(agent.policy.policy.allowScreenshot, true);
});

test("撤销授权在下一次工具调用前收紧（本项的核心安全用例）", async (t) => {
  const path = tmpPolicy(t);
  write(path, base({ vision: grant(["notepad"], { coord: true }) }));
  const { agent } = makeAgent(path);

  assert.equal((await screenshot(agent)).ok, true);
  assert.equal(agent.policy.policy.allowCoordinateInput, true);

  write(path, base({ vision: null })); // = desktop_agent_vision_revoke 的落盘结果
  const revoked = await screenshot(agent);
  assert.equal(revoked.ok, false);
  assert.equal(revoked.code, "CAPABILITY_UNAVAILABLE");
  assert.match(revoked.message, /截屏通道默认关闭/);
  assert.equal(agent.policy.policy.allowScreenshot, false);
  assert.equal(agent.policy.policy.allowCoordinateInput, false);
  assert.deepEqual(agent.policy.policy.visionApps, []);
});

test("热重载不换 guard 实例：子模块仍指向同一策略对象", async (t) => {
  const path = tmpPolicy(t);
  write(path, base({ vision: grant(["notepad"]) }));
  const { agent } = makeAgent(path);
  const guard = agent.policy;
  assert.equal(agent.perception.policy, guard);
  assert.equal(agent.verifier.policy, guard);

  write(path, base({ vision: null }));
  await screenshot(agent);

  assert.equal(agent.policy, guard, "换实例会让子模块继续按旧策略判定");
  assert.equal(agent.perception.policy, guard);
  assert.equal(agent.verifier.policy, guard);
  assert.equal(guard.policy.allowScreenshot, false);
});

test("预算上限随策略一起重载", async (t) => {
  const path = tmpPolicy(t);
  write(path, base({ maxSteps: 7 }));
  const { agent } = makeAgent(path);
  assert.equal(agent.budget.limits.maxSteps, 7);

  write(path, base({ maxSteps: 9, maxScreenshots: 1 }));
  agent.refreshPolicy();
  assert.equal(agent.budget.limits.maxSteps, 9);
  assert.equal(agent.budget.limits.maxScreenshots, 1);
});

test("文件损坏时 callTool 也立即收紧（重载入口在 callTool，不只守协议层）", async (t) => {
  const path = tmpPolicy(t);
  write(path, base({ vision: grant(["notepad"]) }));
  const { agent } = makeAgent(path);
  assert.equal((await screenshot(agent)).ok, true);

  writeFileSync(path, "{ broken", "utf8");
  const result = await screenshot(agent);
  assert.equal(result.ok, false);
  assert.equal(agent.policy.policy.enabled, false, "fail-closed 应落到默认关闭");
  assert.equal(agent.policy.policy.allowScreenshot, false);
});
