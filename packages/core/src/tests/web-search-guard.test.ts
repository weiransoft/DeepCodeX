/**
 * WebSearch 配额守卫单测（tools/web-search-guard）
 *
 * 这一层的失败方式不会报错，只会让配额悄悄少掉：
 *
 * - 缓存 key 没归一化 → 大小写/空格的同一 query 各自打一次上游
 * - TTL 判断写成 `<` → 到点仍然命中，用户拿到五分钟前的旧结果
 * - 熔断永不解除 → 用户明明恢复配额了，工具还在一直拒答
 *
 * 所以断言都盯着这几处边界。时钟用注入的假 `now`，不靠 sleep。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RATE_LIMIT_COOLDOWN_MS,
  SEARCH_CACHE_LIMIT,
  SEARCH_CACHE_TTL_MS,
  WebSearchGuard,
  rateLimitCooldownMessage,
} from "../tools/web-search-guard";

function createClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

test("G1 key 归一化：大小写与多余空白视为同一条 query", () => {
  const guard = new WebSearchGuard();
  assert.equal(
    guard.keyFor("  Latest   Node Release ", "https://deepcode.vegamo.cn"),
    guard.keyFor("latest node release", "https://deepcode.vegamo.cn")
  );
});

test("G2 key 区分上游 host（Plus 与非 Plus 不同源，不能互相命中）", () => {
  const guard = new WebSearchGuard();
  assert.notEqual(
    guard.keyFor("latest node release", "https://deepcode.vegamo.cn"),
    guard.keyFor("latest node release", "https://www.deepcodeplus.com")
  );
});

test("G3 TTL 内命中，过期后失效", () => {
  const clock = createClock();
  const guard = new WebSearchGuard({ now: clock.now });
  guard.write("k", "result");
  assert.equal(guard.read("k"), "result");

  clock.advance(SEARCH_CACHE_TTL_MS - 1);
  assert.equal(guard.read("k"), "result", "差 1ms 仍算有效");

  clock.advance(1);
  assert.equal(guard.read("k"), null, "到点必须失效，否则会拿到过期结果");
});

test("G4 条目上限：超出后淘汰最早写入的那条", () => {
  const guard = new WebSearchGuard({ now: () => 0 });
  for (let i = 0; i < SEARCH_CACHE_LIMIT + 5; i += 1) guard.write(`k${i}`, `v${i}`);
  assert.equal(guard.read("k0"), null, "最早的应被淘汰");
  assert.equal(guard.read(`k${SEARCH_CACHE_LIMIT + 4}`), `v${SEARCH_CACHE_LIMIT + 4}`);
});

test("G5 命中会刷新写入顺序（近似 LRU：常读的不先被淘汰）", () => {
  const guard = new WebSearchGuard({ now: () => 0, limit: 2 });
  guard.write("a", "1");
  guard.write("b", "2");
  guard.read("a"); // a 变成最新
  guard.write("c", "3"); // 挤掉的是 b
  assert.equal(guard.read("a"), "1", "刚读过的不能被优先淘汰");
  assert.equal(guard.read("b"), null);
});

test("G6 熔断窗口：trip 后在窗口内 open，窗口过后自动恢复", () => {
  const clock = createClock();
  const guard = new WebSearchGuard({ now: clock.now });
  assert.equal(guard.blockedForMs(), 0, "默认不熔断");

  guard.trip();
  assert.equal(guard.blockedForMs(), RATE_LIMIT_COOLDOWN_MS);

  clock.advance(RATE_LIMIT_COOLDOWN_MS);
  assert.equal(guard.blockedForMs(), 0, "到点必须自动恢复，不能永久锁死");
});

test("G7 并发共享同一个 Promise（只执行一次工厂函数）", async () => {
  const guard = new WebSearchGuard();
  let runs = 0;
  const factory = async () => {
    runs += 1;
    return "shared";
  };
  const [a, b] = await Promise.all([guard.share("k", factory), guard.share("k", factory)]);
  assert.equal(a, "shared");
  assert.equal(b, "shared");
  assert.equal(runs, 1, "并行的同一条 query 只该打一次上游");
});

test("G8 共享的请求失败后不残留（下一次仍能重试）", async () => {
  const guard = new WebSearchGuard();
  await assert.rejects(
    guard.share("k", async () => {
      throw new Error("boom");
    })
  );
  const retried = await guard.share("k", async () => "ok");
  assert.equal(retried, "ok", "失败的在途记录必须清掉，否则这条 query 永远失败");
});

test("G9 熔断文案是给模型的指令：必须包含「不要重试」与剩余时长", () => {
  const message = rateLimitCooldownMessage(90_000);
  assert.match(message, /不要重试/);
  assert.match(message, /2 分钟/, "90 秒应向上取整成 2 分钟");
  assert.match(rateLimitCooldownMessage(1), /1 分钟/, "极短窗口也要说成至少 1 分钟，不能是 0");
});
