/**
 * memsearch-bridge.test.ts — 外部 CLI 桥接层回归
 *
 * 覆盖：L1/L2 解析契约、参数组装、脏数据、各类失败态的诚实降级、
 * index/stats 文本解析、可执行文件候选，以及本机真实 CLI 可用性冒烟。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  MEMSEARCH_INSTALL_HINT,
  createSpawnRunner,
  expandMemories,
  indexMemories,
  memsearchBinCandidates,
  memsearchStats,
  probeMemsearch,
  searchMemories,
  type MemsearchCommandResult,
  type MemsearchRunner,
} from "../common/memsearch-bridge";

function ok(stdout: string): MemsearchCommandResult {
  return { status: 0, stdout, stderr: "", error: "", timedOut: false };
}

function fail(stdout = "", stderr = "boom", status: number | null = 1, error = ""): MemsearchCommandResult {
  return { status, stdout, stderr, error, timedOut: false };
}

/** 包装 handler，自动让 --version 探测成功；返回记录下的调用参数 */
function makeRunner(
  handler: (bin: string, args: readonly string[]) => MemsearchCommandResult,
  calls: Array<{ bin: string; args: readonly string[] }> = []
): MemsearchRunner {
  return async (bin, args) => {
    calls.push({ bin, args: [...args] });
    if (args.length === 1 && args[0] === "--version") return ok("memsearch, version 0.4.23\n");
    return handler(bin, args);
  };
}

const TWO_CHUNKS = JSON.stringify([
  {
    chunk_hash: "aaa111",
    content: "## 标题A\n内容A",
    source: "/tmp/a.md",
    heading: "标题A",
    heading_level: 2,
    start_line: 1,
    end_line: 2,
    score: 0.98,
  },
  {
    chunk_hash: "bbb222",
    content: "内容B",
    source: "/tmp/b.md",
    heading: "标题B",
    heading_level: 3,
    start_line: 9,
    end_line: 9,
    score: 0.44,
  },
]);

test("MB-01 search 解析合法结果并保留全部契约字段", async () => {
  const runner = makeRunner(() => ok(TWO_CHUNKS));
  const result = await searchMemories({ query: "测试查询", runner });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].chunk_hash, "aaa111");
  assert.equal(result.results[0].heading, "标题A");
  assert.equal(result.results[0].start_line, 1);
  assert.equal(result.results[0].score, 0.98);
  assert.equal(result.droppedCount, 0);
  assert.equal(result.cliVersion, "0.4.23");
  assert.equal(result.hint, "");
});

test("MB-02 参数契约：json-output / top-k / collection / source-prefix", async () => {
  const calls: Array<{ bin: string; args: readonly string[] }> = [];
  const runner = makeRunner(() => ok("[]"), calls);
  await searchMemories({
    query: "  关键词  ",
    topK: 7,
    collection: "user_abc",
    sourcePrefix: "/home/u/.deepcode/memory",
    runner,
  });
  const searchCall = calls.find((c) => c.args[0] === "search");
  assert.ok(searchCall, "必须发起 search 调用");
  assert.deepEqual(searchCall.args, [
    "search",
    "关键词",
    "--json-output",
    "--top-k",
    "7",
    "--collection",
    "user_abc",
    "--source-prefix",
    "/home/u/.deepcode/memory",
  ]);
});

test("MB-03 空数组是合法空结果，不得判为失败", async () => {
  const result = await searchMemories({ query: "无匹配", runner: makeRunner(() => ok("[]")) });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.results.length, 0);
  assert.match(result.reason, /返回 0 条/);
});

test("MB-04 脏数据：部分丢弃仍成功，全部不合规则判 invalid-output", async () => {
  const mixed = JSON.stringify([
    { chunk_hash: "ok1", content: "内容", source: "/a.md", score: 0.9 },
    { chunk_hash: "bad", content: "", source: "/a.md" },
    null,
  ]);
  const partial = await searchMemories({ query: "q", runner: makeRunner(() => ok(mixed)) });
  assert.equal(partial.ok, true);
  assert.equal(partial.results.length, 1);
  assert.equal(partial.droppedCount, 2);
  assert.match(partial.reason, /丢弃 2 条/);

  const allBad = JSON.stringify([{ chunk_hash: "x" }, 42]);
  const failed = await searchMemories({ query: "q", runner: makeRunner(() => ok(allBad)) });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, "invalid-output");
  assert.equal(failed.results.length, 0);
  assert.equal(failed.droppedCount, 2);
});

test("MB-05 非数组 JSON 判 invalid-output", async () => {
  const result = await searchMemories({ query: "q", runner: makeRunner(() => ok('{"results":[]}')) });
  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid-output");
  assert.match(result.reason, /不是数组/);
});

test("MB-06 非法 JSON 判 invalid-output 且不吞解析错误", async () => {
  const result = await searchMemories({ query: "q", runner: makeRunner(() => ok("not json")) });
  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid-output");
  assert.match(result.reason, /不是合法 JSON/);
});

test("MB-07 CLI 不存在 → unavailable + 安装提示", async () => {
  const runner: MemsearchRunner = async () => fail("", "ENOENT", null, "spawn memsearch ENOENT");
  const result = await searchMemories({ query: "q", runner });
  assert.equal(result.ok, false);
  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /不可用/);
  assert.match(result.hint, /uv tool install memsearch/);
  assert.ok(result.hint.includes(MEMSEARCH_INSTALL_HINT));
});

test("MB-08 非零退出 → error，stderr 必须进入 reason", async () => {
  const runner = makeRunner(() => fail("", "upstream 401 invalid api key", 1));
  const result = await searchMemories({ query: "q", runner });
  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.match(result.reason, /退出码 1/);
  assert.match(result.reason, /upstream 401 invalid api key/);
});

test("MB-09 超时 → timeout，不得返回成功", async () => {
  const runner = makeRunner(() => ({
    status: null,
    stdout: "",
    stderr: "killed",
    error: "",
    timedOut: true,
  }));
  const result = await searchMemories({ query: "q", runner, timeoutMs: 1234 });
  assert.equal(result.ok, false);
  assert.equal(result.status, "timeout");
  assert.match(result.reason, /超时/);
});

test("MB-10 空 query 直接拒绝且不调用外部 CLI", async () => {
  let called = 0;
  const runner: MemsearchRunner = async () => {
    called += 1;
    return ok("[]");
  };
  const result = await searchMemories({ query: "   ", runner });
  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.equal(called, 0);
});

test("MB-11 topK 钳位到 [1,50]", async () => {
  const calls: Array<{ bin: string; args: readonly string[] }> = [];
  const runner = makeRunner(() => ok("[]"), calls);
  await searchMemories({ query: "q", topK: 0, runner });
  await searchMemories({ query: "q", topK: 999, runner });
  const ks = calls.filter((c) => c.args[0] === "search").map((c) => c.args[c.args.indexOf("--top-k") + 1]);
  assert.deepEqual(ks, ["1", "50"]);
});

test("MB-12 expand 返回完整章节", async () => {
  const expansion = {
    chunk_hash: "aaa111",
    source: "/tmp/a.md",
    heading: "标题A",
    start_line: 1,
    end_line: 2,
    content: "## 标题A\n内容A",
  };
  const result = await expandMemories({
    chunkHash: "aaa111",
    collection: "dcx",
    runner: makeRunner(() => ok(JSON.stringify(expansion))),
  });
  assert.equal(result.ok, true);
  assert.equal(result.expansion?.chunk_hash, "aaa111");
  assert.equal(result.expansion?.content, "## 标题A\n内容A");
});

test("MB-13 expand 缺 content/source 判 invalid-output；空 hash 直接拒绝", async () => {
  const bad = await expandMemories({ chunkHash: "x", runner: makeRunner(() => ok('{"heading":"h"}')) });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, "invalid-output");
  const empty = await expandMemories({ chunkHash: " ", runner: makeRunner(() => ok("{}")) });
  assert.equal(empty.ok, false);
  assert.equal(empty.status, "error");
});

test("MB-14 index 解析条数；无法解析时诚实判 invalid-output", async () => {
  const good = await indexMemories({
    paths: ["/tmp/memory"],
    collection: "dcx",
    force: true,
    runner: makeRunner(() => ok("Indexed 4 chunks.\n")),
  });
  assert.equal(good.ok, true);
  assert.equal(good.indexedChunks, 4);

  const bad = await indexMemories({
    paths: ["/tmp/memory"],
    runner: makeRunner(() => ok("unexpected output")),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, "invalid-output");
  assert.equal(bad.indexedChunks, null);

  const noPaths = await indexMemories({ paths: [], runner: makeRunner(() => ok("")) });
  assert.equal(noPaths.ok, false);
  assert.equal(noPaths.status, "error");
});

test("MB-15 stats 解析条数", async () => {
  const result = await memsearchStats({
    collection: "dcx",
    runner: makeRunner(() => ok("Total indexed chunks: 4\n")),
  });
  assert.equal(result.ok, true);
  assert.equal(result.totalChunks, 4);
});

test("MB-16 可执行文件候选：显式覆盖 > PATH > uv tool 路径，且去重", () => {
  const defaults = memsearchBinCandidates();
  assert.equal(defaults[0], "memsearch");
  assert.ok(defaults.includes(join(homedir(), ".local", "bin", "memsearch")));
  const explicit = memsearchBinCandidates("/opt/bin/memsearch");
  assert.equal(explicit[0], "/opt/bin/memsearch");
  assert.equal(new Set(explicit).size, explicit.length);
  const same = memsearchBinCandidates("memsearch");
  assert.equal(same[0], "memsearch");
  assert.equal(same.length, 2, "显式值与 PATH 默认值应去重");
});

test("MB-17 真实 CLI 冒烟：本机可用时能完成 --version 探测", async (t) => {
  const probe = await probeMemsearch({ runner: createSpawnRunner(), timeoutMs: 5_000 });
  if (!probe.ok) {
    t.skip(`本机未安装 memsearch：${probe.reason}`);
    return;
  }
  assert.match(probe.version ?? "", /^\d+\.\d+/);
  assert.ok(probe.bin.length > 0);
});
