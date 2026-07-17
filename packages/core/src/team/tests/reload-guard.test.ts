/**
 * ReloadGuard 测试
 *
 * 验证 reload-guard.ts 的临界区保护、状态机、waiters 队列
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ReloadGuard, withReloadGuard } from "../reload-guard.js";
import { ReloadGuardBusyError } from "../errors.js";

test("ReloadGuard initial state is idle", () => {
  const guard = new ReloadGuard();
  assert.equal(guard.isBusy(), false);
  assert.equal(guard.currentHolder(), null);
  assert.equal(guard.queueLength(), 0);
});

test("tryAcquire succeeds when idle", () => {
  const guard = new ReloadGuard();
  assert.equal(guard.tryAcquire("op-1", 100), true);
  assert.equal(guard.isBusy(), true);
  assert.equal(guard.currentHolder()?.id, "op-1");
});

test("tryAcquire returns false when busy (no timeout)", () => {
  const guard = new ReloadGuard();
  assert.equal(guard.tryAcquire("op-1"), true);
  assert.equal(guard.tryAcquire("op-2", 0), false);
});

test("release returns to idle", () => {
  const guard = new ReloadGuard();
  guard.tryAcquire("op-1");
  guard.release();
  assert.equal(guard.isBusy(), false);
});

test("release with wrong holder throws", () => {
  const guard = new ReloadGuard();
  guard.tryAcquire("op-1");
  assert.throws(() => guard.release("op-2"), ReloadGuardBusyError);
});

test("release on idle is no-op", () => {
  const guard = new ReloadGuard();
  guard.release();
  assert.equal(guard.isBusy(), false);
});

test("waitFor acquires immediately when idle", async () => {
  const guard = new ReloadGuard();
  const result = await guard.waitFor("op-1", 1000);
  assert.equal(result, true);
  assert.equal(guard.isBusy(), true);
});

test("waitFor queues when busy, acquires after release", async () => {
  const guard = new ReloadGuard();
  await guard.waitFor("op-1", 1000);

  let op2Acquired = false;
  const p = guard.waitFor("op-2", 1000).then((acquired) => {
    op2Acquired = acquired;
    return acquired;
  });

  // op-1 still holds
  assert.equal(guard.isBusy(), true);
  // Release op-1 → op-2 should acquire
  setTimeout(() => guard.release("op-1"), 10);

  const result = await p;
  assert.equal(result, true);
  assert.equal(op2Acquired, true);
});

test("waitFor times out", async () => {
  const guard = new ReloadGuard();
  await guard.waitFor("op-1", 1000);
  const result = await guard.waitFor("op-2", 50);
  assert.equal(result, false);
});

test("forceBreak clears waiters and resets", async () => {
  const guard = new ReloadGuard();
  await guard.waitFor("op-1", 1000);
  const p1 = guard.waitFor("op-2", 1000);
  const p2 = guard.waitFor("op-3", 1000);
  const broken = guard.forceBreak();
  assert.equal(broken, 2);
  assert.equal(guard.isBusy(), false);
  assert.equal(await p1, false);
  assert.equal(await p2, false);
});

test("forceBreak stats increment", () => {
  const guard = new ReloadGuard();
  guard.forceBreak();
  guard.forceBreak();
  const stats = guard.getStats();
  assert.equal(stats.totalForceBreaks, 2);
});

test("getStats tracks acquired/released", () => {
  const guard = new ReloadGuard();
  guard.tryAcquire("op-1");
  guard.release();
  const stats = guard.getStats();
  assert.equal(stats.totalAcquired, 1);
  assert.equal(stats.totalReleased, 1);
});

test("withReloadGuard runs fn under guard", async () => {
  const guard = new ReloadGuard();
  const result = await withReloadGuard(guard, "op-1", 1000, async () => "success");
  assert.equal(result, "success");
  assert.equal(guard.isBusy(), false);
});

test("withReloadGuard releases on throw", async () => {
  const guard = new ReloadGuard();
  await assert.rejects(
    withReloadGuard(guard, "op-1", 1000, async () => {
      throw new Error("boom");
    })
  );
  assert.equal(guard.isBusy(), false);
});

test("withReloadGuard throws when wait times out", async () => {
  const guard = new ReloadGuard();
  await guard.waitFor("op-1", 1000);
  await assert.rejects(
    withReloadGuard(guard, "op-2", 50, async () => "never"),
    ReloadGuardBusyError
  );
});

test("defaultTimeoutMs applied to new guards", () => {
  const guard = new ReloadGuard({ defaultTimeoutMs: 100 });
  guard.tryAcquire("op-1");
  // Just verify no crash
  assert.equal(guard.isBusy(), true);
});
