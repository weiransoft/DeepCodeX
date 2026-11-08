/**
 * memory-search-tool.test.ts — memory_search LLM 工具回归
 *
 * 覆盖：工具定义契约、L1 摘要输出与预览截断、L2 expand 路由、失败态不伪装成功。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createMemorySearchHandler, getMemorySearchToolDefinition } from "../tools/memory-search-tool";
import { MEMSEARCH_INSTALL_HINT, type MemsearchCommandResult, type MemsearchRunner } from "../common/memsearch-bridge";

function ok(stdout: string): MemsearchCommandResult {
  return { status: 0, stdout, stderr: "", error: "", timedOut: false };
}

function runnerReturning(stdout: string): MemsearchRunner {
  return async (_bin, args) => {
    if (args.length === 1 && args[0] === "--version") return ok("memsearch, version 0.4.23\n");
    return ok(stdout);
  };
}

const HITS = JSON.stringify([
  {
    chunk_hash: "aaa111",
    content: "x".repeat(500),
    source: "/tmp/a.md",
    heading: "标题A",
    heading_level: 2,
    start_line: 1,
    end_line: 2,
    score: 0.97,
  },
]);

test("MT-01 工具定义契约：name / description / JSON Schema", () => {
  const def = getMemorySearchToolDefinition();
  assert.equal(def.type, "function");
  assert.equal(def.function.name, "memory_search");
  assert.match(def.function.description, /do NOT invent recalled facts/);
  assert.equal(def.function.parameters.type, "object");
  assert.equal(def.function.parameters.additionalProperties, false);
  const props = def.function.parameters.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(props).sort(), ["collection", "expand_hash", "query", "top_k"]);
});

test("MT-02 L1 search 输出结构化摘要并截断预览", async () => {
  const handler = createMemorySearchHandler({ runner: runnerReturning(HITS) });
  const result = await handler({ query: "记忆查询", top_k: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  const payload = JSON.parse(result.output ?? "{}") as {
    ok: boolean;
    action: string;
    results: Array<{ chunk_hash: string; preview: string; score: number }>;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.action, "search");
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].chunk_hash, "aaa111");
  assert.equal(payload.results[0].score, 0.97);
  assert.equal(payload.results[0].preview.length, 301, "300 字符 + 省略号");
});

test("MT-03 expand_hash 走 L2，返回完整章节而非摘要", async () => {
  const expansion = JSON.stringify({
    chunk_hash: "aaa111",
    source: "/tmp/a.md",
    heading: "标题A",
    start_line: 1,
    end_line: 2,
    content: "完整章节内容",
  });
  const handler = createMemorySearchHandler({ runner: runnerReturning(expansion) });
  const result = await handler({ query: "", expand_hash: "aaa111" });
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output ?? "{}") as { action: string; expansion: { content: string } };
  assert.equal(payload.action, "expand");
  assert.equal(payload.expansion.content, "完整章节内容");
});

test("MT-04 CLI 不可用 → ok:false，error 带 status / reason / 安装提示", async () => {
  const runner: MemsearchRunner = async () => ({
    status: null,
    stdout: "",
    stderr: "",
    error: "spawn ENOENT",
    timedOut: false,
  });
  const handler = createMemorySearchHandler({ runner });
  const result = await handler({ query: "任何查询" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /\[unavailable\]/);
  assert.match(result.error ?? "", /uv tool install memsearch/);
  const payload = JSON.parse(result.output ?? "{}") as { ok: boolean; status: string; hint: string };
  assert.equal(payload.ok, false, "输出里也必须诚实标注失败");
  assert.equal(payload.status, "unavailable");
  assert.ok(payload.hint.includes(MEMSEARCH_INSTALL_HINT));
});

test("MT-05 空 query 且无 expand_hash → 拒绝并说明原因", async () => {
  let calls = 0;
  const runner: MemsearchRunner = async () => {
    calls += 1;
    return ok("[]");
  };
  const handler = createMemorySearchHandler({ runner });
  const result = await handler({});
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /查询文本为空/);
  assert.equal(calls, 0, "参数非法时不应启动子进程");
});

test("MT-06 非零退出 → 具体 stderr 进入 error，不吞错", async () => {
  const runner: MemsearchRunner = async (_bin, args) => {
    if (args.length === 1 && args[0] === "--version") return ok("memsearch, version 0.4.23\n");
    return { status: 1, stdout: "", stderr: "upstream 401", error: "", timedOut: false };
  };
  const handler = createMemorySearchHandler({ runner });
  const result = await handler({ query: "q" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /\[error\]/);
  assert.match(result.error ?? "", /upstream 401/);
});
