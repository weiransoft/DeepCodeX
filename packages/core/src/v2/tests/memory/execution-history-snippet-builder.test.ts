/**
 * ExecutionHistory SnippetBuilder + inferTaskType 单元测试
 *
 * SnippetBuilder（buildExecutionHistorySnippet）:
 * - UT-SN-001: store=null/undefined → 返回 null（降级）
 * - UT-SN-002: 空 store（query 返回空）→ 返回 null
 * - UT-SN-003: 有数据 → 返回 ContextSnippet{type:"execution_history", relevance:0.7}
 * - UT-SN-004: snippet.content 包含 markdown 格式 + projectRoot 出现在 source 字段
 *
 * inferTaskType（DualLayerContextManager 静态方法）:
 * - UT-SN-005: goal 含 "deploy/release/publish" → "deploy"
 * - UT-SN-006: goal 含 "fix/bug/debug" → "fix"（优先级高于 test/build）
 * - UT-SN-007: goal 含 "test/spec/jest" → "test"
 * - UT-SN-008: goal 含 "build/compile" → "build"
 * - UT-SN-009: 无关键词 → "general"
 * - UT-SN-010: goal=null → "general"
 *
 * @module v2/tests/memory/execution-history-snippet-builder.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { ExecutionHistoryStore } from "../../memory/execution-history-store";
import { buildExecutionHistorySnippet } from "../../context/execution-history-snippet-builder";
import { DualLayerContextManager } from "../../context/dual-layer-manager";

// ============================================================================
// Fixture
// ============================================================================

let tempHome: string;
let tempProject: string;
let originalHome: string | undefined;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-snippet-home-"));
  tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-snippet-project-"));
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结果
  }
});

async function waitFlush(ms = 150): Promise<void> {
  await sleep(ms);
}

type RecordInput = {
  toolName: "bash" | "edit" | "write";
  ok: boolean;
  argsSnippet?: string;
};

async function makeStore(records: RecordInput[]): Promise<ExecutionHistoryStore> {
  const store = new ExecutionHistoryStore({ projectRoot: tempProject });
  const now = Date.now();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    await store.record({
      sessionId: `snippet-test-session`,
      toolName: r.toolName,
      ok: r.ok,
      cwd: tempProject,
      argsSnippet:
        r.argsSnippet ??
        (r.toolName === "bash"
          ? JSON.stringify({ command: `cmd-${i}` })
          : JSON.stringify({ filePath: path.join(tempProject, "a.ts") })),
      timestamp: now - i * 1000,
      date: new Date(now - i * 1000).toISOString().slice(0, 10),
    });
  }
  await waitFlush();
  return store;
}

// ============================================================================
// SnippetBuilder 测试
// ============================================================================

test("UT-SN-001: buildExecutionHistorySnippet — store=null/undefined → 返回 null", () => {
  assert.equal(buildExecutionHistorySnippet(null as unknown as ExecutionHistoryStore), null);
  assert.equal(buildExecutionHistorySnippet(undefined), null);
});

test("UT-SN-002: buildExecutionHistorySnippet — 空 store（query 返回空）→ 返回 null", async () => {
  const store = await makeStore([]);
  const result = buildExecutionHistorySnippet(store);
  assert.equal(result, null, "空 store 应返回 null");
});

test("UT-SN-003: buildExecutionHistorySnippet — 有数据 → 返回 ContextSnippet{type, relevance}", async () => {
  const store = await makeStore([{ toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "npm test" }) }]);

  const snippet = buildExecutionHistorySnippet(store, "general", tempProject);
  assert.ok(snippet, "应有 snippet");
  assert.equal(snippet!.type, "execution_history");
  assert.equal(typeof snippet!.relevance, "number");
  assert.ok(snippet!.relevance! > 0 && snippet!.relevance! <= 1, "relevance 应在 (0,1] 区间");
});

test("UT-SN-004: buildExecutionHistorySnippet — snippet.content 含 markdown + projectRoot 在 source", async () => {
  const store = await makeStore([
    { toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "make build" }) },
    { toolName: "bash", ok: true, argsSnippet: JSON.stringify({ command: "git status" }) },
  ]);

  const snippet = buildExecutionHistorySnippet(store, "general", tempProject)!;
  assert.ok(snippet.content.includes("最近执行历史"), "应含标题");
  assert.ok(snippet.content.includes("make build"), "应含命令文本");
  assert.ok(snippet.source === tempProject, `source 应等于 projectRoot，实际 ${snippet.source}`);
});

// ============================================================================
// inferTaskType 测试（DualLayerContextManager.public static）
// ============================================================================

test("UT-SN-005: goal 含 deploy/release/publish → deploy", () => {
  assert.equal(DualLayerContextManager.inferTaskType({ goal: "Deploy the app to production" } as never), "deploy");
  assert.equal(DualLayerContextManager.inferTaskType({ goal: "release v2.0 and publish" } as never), "deploy");
});

test("UT-SN-006: goal 含 fix/bug/debug → fix（优先级最高：高于 test/build）", () => {
  // 单纯 fix
  assert.equal(DualLayerContextManager.inferTaskType({ goal: "fix the null pointer bug" } as never), "fix");
  // 同时出现 deploy 关键词 + fix 关键词 → deploy 优先级高
  assert.equal(DualLayerContextManager.inferTaskType({ goal: "fix bug and deploy to staging" } as never), "deploy");
  // 同时出现 test 关键词 + fix 关键词 → fix 优先级高
  assert.equal(DualLayerContextManager.inferTaskType({ goal: "test and fix the flaky test" } as never), "fix");
});

test("UT-SN-007: goal 含 test/spec/jest → test", () => {
  assert.equal(DualLayerContextManager.inferTaskType({ goal: "run all jest tests" } as never), "test");
  assert.equal(DualLayerContextManager.inferTaskType({ goal: "write unit spec" } as never), "test");
});

test("UT-SN-008: goal 含 build/compile → build", () => {
  assert.equal(DualLayerContextManager.inferTaskType({ goal: "build the project" } as never), "build");
  assert.equal(DualLayerContextManager.inferTaskType({ goal: "compile with tsc" } as never), "build");
});

test("UT-SN-009: 无关键词 → general", () => {
  assert.equal(DualLayerContextManager.inferTaskType({ goal: "do something general" } as never), "general");
});

test("UT-SN-010: taskContext=null/undefined → general", () => {
  assert.equal(DualLayerContextManager.inferTaskType(null), "general");
  assert.equal(DualLayerContextManager.inferTaskType(undefined), "general");
  assert.equal(DualLayerContextManager.inferTaskType({} as never), "general");
});
