/**
 * 共识判定单测
 *
 * 这些用例是「群聊不产出假共识」的最后一道防线：
 * 只要有阻断反对、有未收敛的补充、或有角色没发声，就不能判成 consensus。
 *
 * @module team/tests/roundtable-consensus
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeVerdict, judgeConsensus } from "../roundtable/consensus.js";
import type { RoundtableSpeech } from "../roundtable/types.js";

const ROLES = ["architect", "solo-coder", "test-expert"];

/** 造一条发言（默认成功、support） */
function speech(roleId: string, overrides: Partial<RoundtableSpeech> = {}): RoundtableSpeech {
  return {
    roleId,
    roleName: roleId,
    posture: "support",
    blocking: false,
    keyPoints: [],
    questions: [],
    content: "同意",
    ...overrides,
  };
}

test("C1. 全员 support → consensus", () => {
  const verdict = judgeConsensus(
    ROLES.map((id) => speech(id)),
    [],
    ROLES
  );
  assert.equal(verdict.kind, "consensus");
  assert.equal(verdict.coverage, 1);
  assert.deepEqual(verdict.blocking, []);
  assert.deepEqual(verdict.dissent, []);
});

test("C2. 有人 refine 且提出新补充 → diverging（还需一轮）", () => {
  const current = [
    speech("architect"),
    speech("solo-coder", { posture: "refine", keyPoints: ["需要明确限流粒度"] }),
    speech("test-expert"),
  ];
  const verdict = judgeConsensus(current, [], ROLES);
  assert.equal(verdict.kind, "diverging");
});

test("C3. refine 但没有新要点 → 视为稳定，可判 consensus", () => {
  const current = [
    speech("architect", { posture: "refine", keyPoints: [] }),
    speech("solo-coder"),
    speech("test-expert"),
  ];
  const verdict = judgeConsensus(current, [], ROLES);
  assert.equal(verdict.kind, "consensus", "refine 且无新增补充不应无限拖住会议");
});

test("C4. refine 要点与上一轮完全相同 → 已说完，可判 consensus", () => {
  const points = ["429 需要 Retry-After 头"];
  const previous = [speech("solo-coder", { posture: "refine", keyPoints: points })];
  const current = [
    speech("architect"),
    speech("solo-coder", { posture: "refine", keyPoints: [...points] }),
    speech("test-expert"),
  ];
  const verdict = judgeConsensus(current, previous, ROLES);
  assert.equal(verdict.kind, "consensus");
});

test("C5. refine 要点发生变化 → 仍在收敛中", () => {
  const previous = [speech("solo-coder", { posture: "refine", keyPoints: ["旧问题"] })];
  const current = [
    speech("architect"),
    speech("solo-coder", { posture: "refine", keyPoints: ["新问题"] }),
    speech("test-expert"),
  ];
  assert.equal(judgeConsensus(current, previous, ROLES).kind, "diverging");
});

test("C6. object + blocking → 一票否决，即便其余全 support", () => {
  const current = [
    speech("architect"),
    speech("solo-coder"),
    speech("test-expert", { posture: "object", blocking: true, keyPoints: ["没有测试环境"] }),
  ];
  const verdict = judgeConsensus(current, [], ROLES);
  assert.equal(verdict.kind, "diverging");
  assert.equal(verdict.blocking.length, 1);
  assert.equal(verdict.blocking[0]!.roleId, "test-expert");
  assert.equal(verdict.blocking[0]!.reason, "没有测试环境");
});

test("C7. object 非 blocking → 记为 dissent，仍未达成共识", () => {
  const current = [
    speech("architect"),
    speech("solo-coder", { posture: "object", blocking: false, keyPoints: ["命名不统一"] }),
    speech("test-expert"),
  ];
  const verdict = judgeConsensus(current, [], ROLES);
  assert.equal(verdict.kind, "diverging");
  assert.equal(verdict.blocking.length, 0);
  assert.equal(verdict.dissent.length, 1);
});

test("C8. 发言失败的角色记为 silent，且不参与判定", () => {
  const current = [speech("architect"), speech("solo-coder", { error: "超时" }), speech("test-expert")];
  const verdict = judgeConsensus(current, [], ROLES);
  assert.deepEqual(verdict.silent, ["solo-coder"]);
  // 2/3 = 0.67 ≥ 0.5，仍可判共识，但 silent 必须如实暴露
  assert.equal(verdict.kind, "consensus");
  assert.ok(verdict.coverage < 1);
});

test("C9. 覆盖率不足半数 → 最多到 converging，不给 consensus", () => {
  const roles = ["a", "b", "c", "d"];
  const current = [
    speech("a"),
    speech("b", { error: "报错" }),
    speech("c", { error: "报错" }),
    speech("d", { error: "报错" }),
  ];
  const verdict = judgeConsensus(current, [], roles);
  assert.equal(verdict.kind, "converging");
  assert.equal(verdict.coverage, 0.25);
  assert.deepEqual(verdict.silent, ["b", "c", "d"]);
});

test("C10. 全员失声 → diverging 且 coverage=0（由调用方降级为 degraded）", () => {
  const current = ROLES.map((id) => speech(id, { error: "无响应" }));
  const verdict = judgeConsensus(current, [], ROLES);
  assert.equal(verdict.kind, "diverging");
  assert.equal(verdict.coverage, 0);
});

test("C11. describeVerdict 输出可解释的立场统计（供主持人 prompt 使用）", () => {
  const speeches = [
    speech("architect"),
    speech("solo-coder", { posture: "refine", keyPoints: ["粒度不清"] }),
    speech("test-expert", { posture: "object", blocking: true, keyPoints: ["缺环境"] }),
  ];
  const verdict = judgeConsensus(speeches, [], ROLES);
  const text = describeVerdict(verdict, speeches);
  assert.ok(text.includes("结论倾向：diverging"));
  assert.ok(text.includes("有效发言覆盖率：100%"));
  assert.ok(text.includes("阻断性反对"));
  assert.ok(text.includes("test-expert"));
});
