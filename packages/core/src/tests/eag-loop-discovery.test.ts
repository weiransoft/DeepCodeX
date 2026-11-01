/**
 * P5 重复工作流发现测试（record-only）
 *
 * 覆盖（共识 C5 量化验收口径）：
 * 1. 已知重复流程检出率 100%：三会话同一序列 fixture 必须全部命中
 * 2. 单次产出建议 ≤ 5 条（maxSuggestions 上限）
 * 3. 归一化（bash argsSnippet 首词）、跨会话阈值、平凡序列过滤
 * 4. 覆盖阶梯：已知资产 → extend；无资产 → create
 * 5. record-only：纯函数无副作用（输入数组不被修改）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  discoverRepeatedFlows,
  discoverFromStore,
  normalizeStep,
  computeSequenceFingerprint,
  DEFAULT_LOOP_DISCOVERY_OPTIONS,
} from "../eag/discovery/loop-discovery";
import type { ExecutionRecord } from "../v2/memory/execution-history-types";

let seq = 0;

/** 构造一条执行记录 */
function rec(partial: {
  sessionId: string;
  toolName: string;
  argsSnippet?: string;
  ok?: boolean;
  timestamp: number;
}): ExecutionRecord {
  seq += 1;
  return {
    id: `rec-${seq}`,
    sessionId: partial.sessionId,
    toolName: partial.toolName,
    ok: partial.ok ?? true,
    timestamp: partial.timestamp,
    turnIndex: seq,
    argsSnippet: partial.argsSnippet,
  } as ExecutionRecord;
}

/** 已知重复工作流 fixture：三会话执行同一「构建→测试→改→lint」序列 */
function seedKnownFlow(): ExecutionRecord[] {
  const records: ExecutionRecord[] = [];
  const base = Date.parse("2026-10-30T10:00:00Z");
  for (let s = 1; s <= 3; s += 1) {
    const sessionId = `sess-${s}`;
    records.push(
      rec({ sessionId, toolName: "bash", argsSnippet: "npm run build", timestamp: base + s }),
      rec({ sessionId, toolName: "bash", argsSnippet: "npm test", timestamp: base + s + 1 }),
      rec({ sessionId, toolName: "edit", argsSnippet: "src/a.ts", timestamp: base + s + 2 }),
      rec({ sessionId, toolName: "bash", argsSnippet: "npm run lint", timestamp: base + s + 3 })
    );
  }
  return records;
}

test("T1: 已知重复流程检出率 100%（三会话同序列必命中，occurrences≥3）", () => {
  const records = seedKnownFlow();
  const suggestions = discoverRepeatedFlows(records);
  // 同一 4 步序列应被检出（n=3..5 的 n-gram 中 4 步 gram 完整命中 3 次）
  const hit = suggestions.find((s) => s.sequence.length === 4);
  assert.ok(hit, "应检出 4 步完整序列");
  assert.ok(hit.occurrences >= 3, `occurrences=${hit.occurrences} 应 ≥3`);
  assert.equal(hit.distinctSessions, 3);
  assert.equal(hit.coverageLadder, "create");
  assert.ok(hit.fingerprint.length === 64);
});

test("T2: 单次产出建议 ≤ 5 条（共识 C5 上限）", () => {
  // 构造 8 条彼此不同的重复序列
  const records: ExecutionRecord[] = [];
  const base = Date.parse("2026-10-30T10:00:00Z");
  for (let f = 0; f < 8; f += 1) {
    for (let s = 1; s <= 3; s += 1) {
      records.push(
        rec({ sessionId: `s${f}-${s}`, toolName: "bash", argsSnippet: `cmd${f}a`, timestamp: base + f * 100 + s }),
        rec({ sessionId: `s${f}-${s}`, toolName: "bash", argsSnippet: `cmd${f}b`, timestamp: base + f * 100 + s + 1 }),
        rec({ sessionId: `s${f}-${s}`, toolName: "edit", timestamp: base + f * 100 + s + 2 })
      );
    }
  }
  const suggestions = discoverRepeatedFlows(records);
  assert.ok(suggestions.length <= DEFAULT_LOOP_DISCOVERY_OPTIONS.maxSuggestions);
  assert.equal(suggestions.length, 5);
});

test("T3: 跨会话阈值——单会话内重复不产建议（TurnGuard 职责不越界）", () => {
  const base = Date.parse("2026-10-30T10:00:00Z");
  const records = [
    rec({ sessionId: "only-1", toolName: "bash", argsSnippet: "build", timestamp: base }),
    rec({ sessionId: "only-1", toolName: "bash", argsSnippet: "test", timestamp: base + 1 }),
    rec({ sessionId: "only-1", toolName: "bash", argsSnippet: "build", timestamp: base + 2 }),
    rec({ sessionId: "only-1", toolName: "bash", argsSnippet: "test", timestamp: base + 3 }),
  ];
  assert.equal(discoverRepeatedFlows(records).length, 0);
});

test("T4: 次数阈值——只出现 2 次的序列不产建议（默认 minOccurrences=3）", () => {
  const base = Date.parse("2026-10-30T10:00:00Z");
  const records: ExecutionRecord[] = [];
  for (const s of ["a", "b"]) {
    records.push(
      rec({ sessionId: s, toolName: "bash", argsSnippet: "rare1", timestamp: base }),
      rec({ sessionId: s, toolName: "edit", timestamp: base + 1 }),
      rec({ sessionId: s, toolName: "bash", argsSnippet: "rare2", timestamp: base + 2 })
    );
  }
  assert.equal(discoverRepeatedFlows(records).length, 0);
  // 阈值放宽到 2 时可检出
  const relaxed = discoverRepeatedFlows(records, { minOccurrences: 2, minDistinctSessions: 2 });
  assert.ok(relaxed.length >= 1);
});

test("T5: 平凡序列过滤——bash×3 同命令不算工作流", () => {
  const base = Date.parse("2026-10-30T10:00:00Z");
  const records: ExecutionRecord[] = [];
  for (const s of ["x", "y", "z"]) {
    for (let i = 0; i < 3; i += 1) {
      records.push(rec({ sessionId: s, toolName: "bash", argsSnippet: "same", timestamp: base + i }));
    }
  }
  assert.equal(discoverRepeatedFlows(records).length, 0);
});

test("T6: 覆盖阶梯——已知资产 token 重叠 → extend + matchedAsset", () => {
  const records = seedKnownFlow();
  // bash 步骤按首词归一为 npm，资产名含 npm token 即匹配
  const suggestions = discoverRepeatedFlows(records, { knownAssetNames: ["npm-build-checklist"] });
  const hit = suggestions.find((s) => s.sequence.length === 4);
  assert.ok(hit);
  assert.equal(hit.coverageLadder, "extend");
  assert.equal(hit.matchedAsset, "npm-build-checklist");
  assert.ok(hit.rationale.includes("npm-build-checklist"));
});

test("T7: normalizeStep——bash 首词归一；其余用 toolName；空 args 兜底", () => {
  assert.equal(normalizeStep({ toolName: "bash", argsSnippet: "  npm run build " }), "bash:npm");
  assert.equal(normalizeStep({ toolName: "edit", argsSnippet: "a.ts" }), "edit");
  assert.equal(normalizeStep({ toolName: "bash", argsSnippet: "" }), "bash");
  assert.equal(normalizeStep({ toolName: "bash" }), "bash");
});

test("T8: 指纹稳定性——同序列指纹一致，不同序列指纹不同", () => {
  const f1 = computeSequenceFingerprint(["bash:build", "edit"]);
  const f2 = computeSequenceFingerprint(["bash:build", "edit"]);
  const f3 = computeSequenceFingerprint(["edit", "bash:build"]);
  assert.equal(f1, f2);
  assert.notEqual(f1, f3);
});

test("T9: record-only 纯函数——输入数组不被修改", () => {
  const records = seedKnownFlow();
  const snapshot = JSON.stringify(records);
  discoverRepeatedFlows(records, { knownAssetNames: ["x"] });
  assert.equal(JSON.stringify(records), snapshot);
});

test("T10: discoverFromStore——与 store.query(lastDays) 衔接", () => {
  const records = seedKnownFlow();
  const queried: Array<{ lastDays?: number } | undefined> = [];
  const fakeStore = {
    query(q?: { lastDays?: number }) {
      queried.push(q);
      return records;
    },
  };
  const suggestions = discoverFromStore(fakeStore, { windowDays: 3 });
  assert.equal(queried.length, 1);
  assert.equal(queried[0]?.lastDays, 3);
  assert.ok(suggestions.length >= 1);
});
