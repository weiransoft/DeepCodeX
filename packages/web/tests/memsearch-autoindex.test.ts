/**
 * memsearch-autoindex.test.ts — 启动时自动增量索引回归
 *
 * 全注入式 runner，不 spawn 真实进程、不调用 as1，保证确定性。
 * 覆盖：未配置时零副作用、参数契约（绝不 --force）、失败诚实降级、
 * 非阻塞启动、cancel 生效、日志不含凭据/stderr 原文。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MemsearchCommandResult, MemsearchRunner } from "@vegamo/deepcode-core";

import {
  DEFAULT_MEMSEARCH_BATCH_SIZE,
  DEFAULT_MEMSEARCH_COLLECTION,
  MEMSEARCH_AUTOINDEX_ENV,
  MEMSEARCH_BATCH_SIZE_ENV,
  MEMSEARCH_COLLECTION_ENV,
  MEMSEARCH_CORPUS_DIRS_ENV,
  MEMSEARCH_EXCLUDES_ENV,
  formatAutoIndexReport,
  parseAbsoluteDirs,
  resolveAutoIndexConfig,
  runMemsearchAutoIndex,
  startMemsearchAutoIndex,
} from "../src/memsearch-autoindex";

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

async function withTempDirs(fn: (dirs: readonly string[]) => Promise<void>): Promise<void> {
  const a = mkdtempSync(path.join(tmpdir(), "dcx-autoindex-a-"));
  const b = mkdtempSync(path.join(tmpdir(), "dcx-autoindex-b-"));
  mkdirSync(path.join(a, "memory"), { recursive: true });
  try {
    await fn([a, b]);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
}

test("AI-1 parseAbsoluteDirs 拒绝相对路径、去重、保序", () => {
  assert.deepEqual(parseAbsoluteDirs(undefined), []);
  assert.deepEqual(parseAbsoluteDirs(""), []);
  assert.deepEqual(parseAbsoluteDirs("relative/docs:./x"), []);
  assert.deepEqual(parseAbsoluteDirs("/a:/b:/a"), ["/a", "/b"]);
  assert.deepEqual(parseAbsoluteDirs(" /a/../a : /b "), ["/a", "/b"]);
});

test("AI-2 未配置语料根 → disabled，且零次外部调用", async () => {
  const config = resolveAutoIndexConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.skipReason, "no-corpus-dirs");
  const calls: string[][] = [];
  const report = await runMemsearchAutoIndex({
    config,
    runner: makeRunner(() => ok("Indexed 1 chunks.\n"), calls),
  });
  assert.equal(report.status, "disabled");
  assert.equal(calls.length, 0, "连 --version 探测都不应发生");
});

test("AI-3 显式 " + MEMSEARCH_AUTOINDEX_ENV + "=0 → disabled，且零次外部调用", async () => {
  const env = {
    [MEMSEARCH_CORPUS_DIRS_ENV]: "/tmp",
    [MEMSEARCH_AUTOINDEX_ENV]: "0",
  } as NodeJS.ProcessEnv;
  const config = resolveAutoIndexConfig(env);
  assert.equal(config.enabled, false);
  assert.equal(config.skipReason, "disabled-by-env");
  const calls: string[][] = [];
  const report = await runMemsearchAutoIndex({
    config,
    env,
    runner: makeRunner(() => ok("Indexed 1 chunks.\n"), calls),
  });
  assert.equal(report.status, "disabled");
  assert.equal(calls.length, 0);
});

test("AI-4 配置有效目录 → ok，显式 collection / exclude / batch-size，绝不 --force", async () => {
  await withTempDirs(async ([a, b]) => {
    const env = {
      [MEMSEARCH_CORPUS_DIRS_ENV]: `${a}${path.delimiter}${b}`,
      [MEMSEARCH_EXCLUDES_ENV]: "dev/**,fusion/**",
      [MEMSEARCH_COLLECTION_ENV]: "custom_collection",
      [MEMSEARCH_BATCH_SIZE_ENV]: "8",
    } as NodeJS.ProcessEnv;
    const config = resolveAutoIndexConfig(env);
    assert.equal(config.enabled, true);
    assert.equal(config.batchSize, 8);
    assert.deepEqual(config.excludePatterns, ["dev/**", "fusion/**"]);
    const calls: string[][] = [];
    const report = await runMemsearchAutoIndex({
      config,
      env,
      runner: makeRunner(() => ok("Indexed 0 chunks.\n"), calls),
    });
    assert.equal(report.status, "ok");
    assert.equal(report.indexedChunks, 0);
    assert.equal(report.dirCount, 2);
    const indexCall = calls.find((c) => c[0] === "index");
    assert.ok(indexCall);
    assert.equal(indexCall.includes("--force"), false, "自动索引绝不传 --force");
    assert.ok(indexCall.includes(a));
    assert.ok(indexCall.includes(b));
    // 参数顺序：index <paths...> --collection <c> --exclude <p>... --batch-size <n>
    assert.deepEqual(indexCall.slice(-2), ["--batch-size", "8"]);
    assert.equal(indexCall.filter((v) => v === "--exclude").length, 2);
    assert.ok(indexCall.includes("dev/**"));
    assert.ok(indexCall.includes("fusion/**"));
    assert.ok(indexCall.includes("custom_collection"));
  });
});

test("AI-5 默认值：collection 与 batch-size 的实测安全值", () => {
  const config = resolveAutoIndexConfig({ [MEMSEARCH_CORPUS_DIRS_ENV]: "/tmp" } as NodeJS.ProcessEnv);
  assert.equal(config.collection, DEFAULT_MEMSEARCH_COLLECTION);
  assert.equal(config.batchSize, DEFAULT_MEMSEARCH_BATCH_SIZE);
  assert.equal(config.batchSize, 16, "as1 qwen3-embedding 32768 上下文下 256 会溢出");
});

test("AI-6 CLI 不可用 → unavailable，且不发起 index", async () => {
  await withTempDirs(async ([a]) => {
    const env = { [MEMSEARCH_CORPUS_DIRS_ENV]: a } as NodeJS.ProcessEnv;
    const calls: string[][] = [];
    const report = await runMemsearchAutoIndex({
      config: resolveAutoIndexConfig(env),
      env,
      runner: async (_bin, args) => {
        calls.push([...args]);
        return { status: 1, stdout: "", stderr: "not found", error: "", timedOut: false };
      },
    });
    assert.equal(report.status, "unavailable");
    assert.equal(
      calls.some((c) => c[0] === "index"),
      false
    );
  });
});

test("AI-7 部分失败 → partial，不伪装成功", async () => {
  await withTempDirs(async ([a]) => {
    const env = { [MEMSEARCH_CORPUS_DIRS_ENV]: a } as NodeJS.ProcessEnv;
    const stderr = "Failed to index /repo/big.md, skipping\nIndexed 17 chunks.\n";
    const report = await runMemsearchAutoIndex({
      config: resolveAutoIndexConfig(env),
      env,
      runner: makeRunner(() => ok("Indexed 17 chunks.\n", stderr), []),
    });
    assert.equal(report.status, "partial");
    assert.equal(report.failedFiles, 1);
    assert.equal(report.indexedChunks, 17);
  });
});

test("AI-8 语料根都不存在 → no-valid-dirs，零 index 调用", async () => {
  const env = {
    [MEMSEARCH_CORPUS_DIRS_ENV]: "/tmp/dcx-definitely-missing-corpus-dir-20261108",
  } as NodeJS.ProcessEnv;
  const calls: string[][] = [];
  const report = await runMemsearchAutoIndex({
    config: resolveAutoIndexConfig(env),
    env,
    runner: makeRunner(() => ok("Indexed 1 chunks.\n"), calls),
  });
  assert.equal(report.status, "no-valid-dirs");
  assert.equal(calls.length, 0);
});

test("AI-9 startMemsearchAutoIndex 非阻塞 + cancel 阻止后续 index", async () => {
  await withTempDirs(async ([a]) => {
    const env = { [MEMSEARCH_CORPUS_DIRS_ENV]: a } as NodeJS.ProcessEnv;
    const calls: string[][] = [];
    const lines: string[] = [];
    const handle = startMemsearchAutoIndex({
      env,
      runner: makeRunner(() => ok("Indexed 5 chunks.\n"), calls),
      logger: (line) => lines.push(line),
    });
    // 同步返回：不 await done 也能立刻拿到句柄，证明不阻塞 listen
    assert.equal(typeof handle.cancel, "function");
    assert.ok(handle.done instanceof Promise);
    handle.cancel();
    const report = await handle.done;
    assert.equal(report.status, "aborted");
    assert.equal(
      calls.some((c) => c[0] === "index"),
      false,
      "cancel 后不得继续写索引"
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /status=aborted/);
  });
});

test("AI-10 formatAutoIndexReport 只含结构化字段，绝不含 reason / stderr", () => {
  const line = formatAutoIndexReport({
    status: "error",
    skipReason: "",
    indexedChunks: null,
    failedFiles: 0,
    dirCount: 2,
    durationMs: 123,
  });
  assert.match(line, /status=error/);
  assert.match(line, /dirs=2/);
  assert.match(line, /chunks=n\/a/);
  assert.equal(line.includes("upstream 401"), false);
  assert.equal(line.includes("sk-"), false);
});
