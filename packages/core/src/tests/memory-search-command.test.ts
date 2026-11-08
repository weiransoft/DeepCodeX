/**
 * memory-search-command.test.ts — /memory search 子命令回归
 *
 * 检索函数经参数注入（V2 模块不直接依赖 V1 文件），覆盖正常/未启用/失败/参数解析，
 * 并确认既有 help 与未知子命令文案同步。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { handleMemoryCommand, type MemorySearchFn, type MemorySearchOutcomeLike } from "../v2/memory/memory-commands";
import type { MemoryStore } from "../v2/memory/memory-store";

/** search 分支不使用 store / privacyManager，传空替身即可 */
const STORE = {} as MemoryStore;

function outcome(overrides: Partial<MemorySearchOutcomeLike> = {}): MemorySearchOutcomeLike {
  return {
    ok: true,
    status: "ok",
    reason: "检索完成，返回 1 条",
    hint: "",
    results: [
      {
        chunk_hash: "aaa111",
        content: "轨道 A 默认 4 轮；轨道 B 默认 6 轮",
        source: "/tmp/eag.md",
        heading: "无进展双轨熔断",
        start_line: 6,
        end_line: 8,
        score: 0.9999,
      },
    ],
    ...overrides,
  };
}

test("M-01 /memory search 正常输出排名 / hash / 预览", async () => {
  const fn: MemorySearchFn = async () => outcome();
  const result = await handleMemoryCommand("search 无进展熔断", STORE, undefined, fn);
  assert.equal(result.success, true);
  assert.match(result.output, /# 记忆检索：无进展熔断（1 条）/);
  assert.match(result.output, /1\. \[0\.9999\] 无进展双轨熔断/);
  assert.match(result.output, /hash: aaa111/);
  const data = result.data as Array<{ chunk_hash: string }>;
  assert.equal(data[0].chunk_hash, "aaa111");
});

test("M-02 未注入检索函数 → 明确报错 + 安装提示，不伪造命中", async () => {
  const result = await handleMemoryCommand("search 任意查询", STORE);
  assert.equal(result.success, false);
  assert.match(result.output, /未启用/);
  assert.match(result.output, /uv tool install memsearch/);
});

test("M-03 检索失败 → status / reason / hint 全透出", async () => {
  const fn: MemorySearchFn = async () =>
    outcome({
      ok: false,
      status: "unavailable",
      reason: "memsearch CLI 不可用",
      hint: "安装：uv tool install memsearch",
      results: [],
    });
  const result = await handleMemoryCommand("search q", STORE, undefined, fn);
  assert.equal(result.success, false);
  assert.match(result.output, /\[unavailable\]/);
  assert.match(result.output, /memsearch CLI 不可用/);
  assert.match(result.output, /修复建议/);
});

test("M-04 空查询 → 用法提示；--top-k 正确透传", async () => {
  const empty = await handleMemoryCommand("search", STORE, undefined, async () => outcome());
  assert.equal(empty.success, false);
  assert.match(empty.output, /用法: \/memory search/);

  let capturedK = 0;
  const fn: MemorySearchFn = async (_q, k) => {
    capturedK = k ?? 0;
    return outcome();
  };
  await handleMemoryCommand("search 关键词 --top-k 9", STORE, undefined, fn);
  assert.equal(capturedK, 9);
});

test("M-05 空结果仍是成功，但明确提示需先 index", async () => {
  const fn: MemorySearchFn = async () => outcome({ results: [], reason: "检索完成，返回 0 条" });
  const result = await handleMemoryCommand("search q", STORE, undefined, fn);
  assert.equal(result.success, true);
  assert.match(result.output, /0 条/);
  assert.match(result.output, /请确认已 index/);
});

test("M-06 检索函数抛异常被捕获，不冒泡到 TUI", async () => {
  const fn: MemorySearchFn = async () => {
    throw new Error("spawn failed");
  };
  const result = await handleMemoryCommand("search q", STORE, undefined, fn);
  assert.equal(result.success, false);
  assert.match(result.output, /spawn failed/);
});

test("M-07 help 与未知子命令文案均包含 search（文档一致性）", async () => {
  const help = await handleMemoryCommand("help", STORE);
  assert.equal(help.success, true);
  assert.match(help.output, /\/memory search <query>/);
  const unknown = await handleMemoryCommand("bogus", STORE);
  assert.equal(unknown.success, false);
  assert.match(unknown.output, /search/);
});
