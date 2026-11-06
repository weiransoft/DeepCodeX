/**
 * 故障注入回归（P2 准入项 2）。
 *
 * 桌面操作最怕的不是失败，而是「失败以错误的形态出现」：
 * 窗口关了被当成动作成功、进程崩了还在重试、桥挂了直接抛原始堆栈。
 * 这里逐条锁死：错误码、可恢复性、是否交还控制权、是否泄漏异常。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DesktopAgent } from "../src/agent.mjs";
import { createMockBackend } from "../src/backends/mock.mjs";
import { defaultPolicy } from "../src/modules/policy-guard.mjs";
import { ErrorCode } from "../src/errors.mjs";

function makeAgent() {
  const backend = createMockBackend();
  const policy = {
    ...defaultPolicy(),
    enabled: true,
    permissionMode: "auto",
    allowedApps: [{ appId: "notepad", always: true, scopes: ["read", "write"] }],
    deniedApps: [],
    allowCoordinateInput: true,
    allowScreenshot: true,
  };
  return { backend, agent: new DesktopAgent({ backend, policy, limits: policy }) };
}

async function snap(agent) {
  const r = await agent.callTool("desktop_snapshot", { appId: "notepad", maxDepth: 4 });
  assert.equal(r.ok, true, `snapshot 应成功：${JSON.stringify(r)}`);
  return r;
}

test("窗口中途关闭：返回 OBSERVATION_FAILED 且可恢复，不伪装成成功", async () => {
  const { backend, agent } = makeAgent();
  const s = await snap(agent);
  const edit = s.tree.flatMap(function walk(n) { return [n, ...(n.children ?? []).flatMap(walk)]; }).find((n) => n.role === "edit");

  backend.faults.windowClosed = true;
  const res = await agent.callTool("desktop_click_ref", {
    appId: "notepad",
    snapshotId: s.snapshotId,
    ref: edit.ref,
    action: "invoke",
    value: "x",
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, ErrorCode.OBSERVATION_FAILED);
  assert.equal(res.recoverable, true, "窗口关闭是可恢复的：重开窗口后可重试");
  assert.match(res.message, /窗口已关闭/);
});

test("目标进程崩溃：HANDOFF_REQUIRED，不可恢复，禁止继续重试", async () => {
  const { backend, agent } = makeAgent();
  const s = await snap(agent);
  const edit = s.tree.flatMap(function walk(n) { return [n, ...(n.children ?? []).flatMap(walk)]; }).find((n) => n.role === "edit");

  backend.faults.appExited = true;
  const res = await agent.callTool("desktop_click_ref", {
    appId: "notepad",
    snapshotId: s.snapshotId,
    ref: edit.ref,
    action: "invoke",
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, ErrorCode.HANDOFF_REQUIRED);
  assert.equal(res.recoverable, false);
});

test("观察阶段目标消失：observe 返回结构化失败，不抛原始异常", async () => {
  const { backend, agent } = makeAgent();
  backend.faults.windowClosed = true;
  const res = await agent.callTool("desktop_snapshot", { appId: "notepad" });
  assert.equal(res.ok, false);
  assert.equal(res.code, ErrorCode.OBSERVATION_FAILED);
  assert.ok(typeof res.hint === "string" && res.hint.length > 0, "失败必须给出可行动提示");
});

test("界面变化后复用旧 ref：STALE_REF 硬拦，且不静默重取后继续点", async () => {
  const { backend, agent } = makeAgent();
  const s = await snap(agent);
  const edit = s.tree.flatMap(function walk(n) { return [n, ...(n.children ?? []).flatMap(walk)]; }).find((n) => n.role === "edit");

  // 模拟界面刷新：后端快照全部失效
  backend.invalidateSnapshots();
  // 先触发一次新观察，让 perception 的 current 前进
  await agent.callTool("desktop_snapshot", { appId: "notepad", maxDepth: 4 });

  const res = await agent.callTool("desktop_click_ref", {
    appId: "notepad",
    snapshotId: s.snapshotId,
    ref: edit.ref,
    action: "invoke",
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, ErrorCode.STALE_REF);
  assert.equal(res.outcome, "stale-ref");
});

test("幂等动作（保存）：expectChange=false 记为 verified-no-change，不谎报已变化", async () => {
  const { agent } = makeAgent();
  const s = await snap(agent);

  const res = await agent.callTool("desktop_key", {
    appId: "notepad",
    snapshotId: s.snapshotId,
    combo: "^s",
    expectChange: false,
  });
  // mock 的 sendKey 只记录按键、不改状态，正好等价于「保存后界面无变化」
  assert.equal(res.ok, true);
  assert.equal(res.outcome, "verified-no-change");
  assert.equal(res.verification.changed, false);
  assert.equal(res.verification.expectChange, false);
});

test("动作无效果：有界重试后 VERIFY_FAILED，attempts 可观测", async () => {
  const { backend, agent } = makeAgent();
  const s = await snap(agent);
  const edit = s.tree.flatMap(function walk(n) { return [n, ...(n.children ?? []).flatMap(walk)]; }).find((n) => n.role === "edit");

  backend.faults.failNextAction = 99; // 一直失败
  const res = await agent.callTool("desktop_click_ref", {
    appId: "notepad",
    snapshotId: s.snapshotId,
    ref: edit.ref,
    action: "invoke",
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, ErrorCode.VERIFY_FAILED);
  assert.equal(res.outcome, "verify-failed");
  assert.ok(res.attempts >= 2, "必须记录真实尝试次数，便于熔断与成本核算");
});

test("预算耗尽：熔断为 BUDGET_EXCEEDED，不会无限重试", async () => {
  const { backend, agent } = makeAgent();
  const s = await snap(agent);
  const edit = s.tree.flatMap(function walk(n) { return [n, ...(n.children ?? []).flatMap(walk)]; }).find((n) => n.role === "edit");

  backend.faults.failNextAction = 99;
  // 快照已用掉 1 步，把上限压到 1：下一次动作预扣即熔断
  agent.budget.limits.maxSteps = 1;
  const res = await agent.callTool("desktop_click_ref", {
    appId: "notepad",
    snapshotId: s.snapshotId,
    ref: edit.ref,
    action: "invoke",
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, ErrorCode.BUDGET_EXCEEDED);
});
