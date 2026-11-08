/**
 * memsearch-index-honesty.test.ts — index 增量参数与「部分失败不得伪装成功」回归
 *
 * 2026-11-08 生产实测触发：官方 CLI 在单文件 embedding 超长时输出
 * "Failed to index ..., skipping" 并仍以 exit 0 结束 + "Indexed 2602 chunks"，
 * 只看退出码会把部分失败当成完整成功。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { indexMemories, type MemsearchCommandResult, type MemsearchRunner } from "../common/memsearch-bridge";

function ok(stdout: string, stderr = ""): MemsearchCommandResult {
  return { status: 0, stdout, stderr, error: "", timedOut: false };
}

function makeRunner(
  handler: (args: readonly string[]) => MemsearchCommandResult,
  calls: readonly string[][]
): MemsearchRunner {
  return async (_bin, args) => {
    calls.push([...args]);
    if (args.length === 1 && args[0] === "--version") return ok("memsearch, version 0.4.23\n");
    return handler(args);
  };
}

test("IH-1 excludePatterns / batchSize / collection 逐项落到 CLI 参数，且不传 --force", async () => {
  const calls: string[][] = [];
  const outcome = await indexMemories({
    paths: ["/tmp/docs", "/tmp/memory/a.md"],
    collection: "deepcodex_memory",
    excludePatterns: ["dev/**", "fusion/**", "research/**"],
    batchSize: 16,
    runner: makeRunner(() => ok("Indexed 12 chunks.\n"), calls),
  });
  assert.equal(outcome.ok, true, outcome.reason);
  const indexCall = calls.find((c) => c[0] === "index");
  assert.ok(indexCall, "应发起 index 调用");
  assert.deepEqual(indexCall.slice(1, 3), ["/tmp/docs", "/tmp/memory/a.md"]);
  assert.deepEqual(indexCall.slice(3, 5), ["--collection", "deepcodex_memory"]);
  assert.equal(indexCall.includes("--force"), false, "增量索引绝不传 --force");
  assert.deepEqual(indexCall.filter((v) => v === "--exclude").length, 3, "每个排除模式各一个 --exclude");
  assert.ok(indexCall.includes("dev/**"));
  assert.ok(indexCall.includes("fusion/**"));
  assert.ok(indexCall.includes("research/**"));
  assert.deepEqual(indexCall.slice(-2), ["--batch-size", "16"]);
});

test("IH-2 force:true 才追加 --force（显式全量重嵌入，与 IH-1 形成 A/B 对照）", async () => {
  const calls: string[][] = [];
  await indexMemories({
    paths: ["/tmp/docs"],
    force: true,
    runner: makeRunner(() => ok("Indexed 3 chunks.\n"), calls),
  });
  const indexCall = calls.find((c) => c[0] === "index");
  assert.ok(indexCall);
  assert.equal(indexCall.includes("--force"), true);
});

test("IH-3 干净 stderr → ok:true / partial:false / 条数解析正确", async () => {
  const outcome = await indexMemories({
    paths: ["/tmp/docs"],
    runner: makeRunner(() => ok("Indexed 0 chunks.\n"), []),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.partial, false);
  assert.equal(outcome.failedFiles, 0);
  assert.equal(outcome.indexedChunks, 0, "无变化时 0 chunks 是有效结果，不是失败");
});

test("IH-4 stderr 含失败文件 → ok:false / partial:true，且保留已写入条数证据", async () => {
  const stderr =
    "Failed to index /repo/docs/big-table.md, skipping\n" +
    "openai.BadRequestError: input too long: est 38545 tokens > context 32768\n" +
    "Indexed 2602 chunks from 115 files (1 files failed)\n";
  const outcome = await indexMemories({
    paths: ["/tmp/docs"],
    runner: makeRunner(() => ok("Indexed 2602 chunks.\n", stderr), []),
  });
  assert.equal(outcome.ok, false, "部分失败不得报成功");
  assert.equal(outcome.status, "error");
  assert.equal(outcome.partial, true);
  assert.equal(outcome.failedFiles, 1);
  assert.equal(outcome.indexedChunks, 2602, "已写入的 chunk 数仍是真实证据，不能丢");
  assert.match(outcome.reason, /部分失败/);
});

test("IH-5 同一路径重复告警 + 堆栈重复行 → 按路径去重，不虚增失败数", async () => {
  const stderr = [
    "Failed to index /repo/docs/a.md, skipping",
    "Failed to index /repo/docs/a.md, skipping",
    "Traceback (most recent call last):",
    "Indexed 7 chunks.",
  ].join("\n");
  const outcome = await indexMemories({
    paths: ["/tmp/docs"],
    runner: makeRunner(() => ok("Indexed 7 chunks.\n", stderr), []),
  });
  assert.equal(outcome.failedFiles, 1);
  assert.equal(outcome.partial, true);
});

test("IH-6 两个不同文件失败 → failedFiles=2", async () => {
  const stderr = [
    "WARNING:memsearch.core:Failed to index /repo/docs/a.md, skipping",
    "WARNING:memsearch.core:Failed to index /repo/docs/b.md, skipping",
  ].join("\n");
  const outcome = await indexMemories({
    paths: ["/tmp/docs"],
    runner: makeRunner(() => ok("Indexed 9 chunks.\n", stderr), []),
  });
  assert.equal(outcome.failedFiles, 2);
});

test("IH-7 非零退出时 stderr 中的凭据进入 reason 前必须脱敏", async () => {
  const stderr = "upstream 401: api_key=sk-abcdef1234567890 Bearer eyJhbGciOiJIUzI1NiJ9.token";
  const outcome = await indexMemories({
    paths: ["/tmp/docs"],
    runner: makeRunner(() => ({ status: 1, stdout: "", stderr, error: "", timedOut: false }), []),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason.includes("sk-abcdef1234567890"), false, "API key 不得出现在 reason");
  assert.equal(outcome.reason.includes("eyJhbGciOiJIUzI1NiJ9"), false, "Bearer token 不得出现在 reason");
  assert.match(outcome.reason, /<redacted>/);
});

test("IH-8 空 paths → 直接拒绝且不调用外部 CLI", async () => {
  const calls: string[][] = [];
  const outcome = await indexMemories({
    paths: [],
    runner: makeRunner(() => ok("Indexed 1 chunks.\n"), calls),
  });
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0, "连 --version 探测都不应发生");
  assert.equal(outcome.partial, false);
});
