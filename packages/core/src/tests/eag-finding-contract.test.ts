/**
 * P3 Finding-bound 沉淀契约测试
 *
 * 覆盖：
 * 1. validateFinding schema 关卡（合法/非法各形态）
 * 2. partitionByEvidence（bound / deferred 划分，deferred ≠ rejected）
 * 3. SedimentationWriter 白名单扩展：finding.json 完整落盘 + 非法 finding 降级不阻断
 * 4. SedimentationSuggester 抽取：LLM finding 合法携带、非法降级 deferred
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { validateFinding, partitionByEvidence } from "../eag/dynamic/finding";
import { SedimentationWriter, type SedimentationDraft } from "../agents/sedimentation-writer";
import { SedimentationSuggester } from "../eag/dynamic/sedimentation-suggester";

/** 合法 finding 构造器（默认 evidence 不带 note） */
function makeFinding(overrides: Record<string, unknown> = {}) {
  return {
    id: "FINDING-001",
    evidence: [{ source: "execution-history", ref: "rec-abc-123" }],
    impact: "每轮重复手工执行相同构建流程，浪费约 5 分钟",
    minFixScope: "沉淀为 skill：构建-验证 checklist",
    verifyRoute: "新会话注入该 skill 后观察构建轮次是否减少",
    evidenceState: "exercised",
    severity: "major",
    ...overrides,
  };
}

// ============================================================================
// 1. validateFinding
// ============================================================================

test("T1: 合法 finding 通过校验并规范化（note 缺省省略）", () => {
  const raw = makeFinding();
  const finding = validateFinding(raw);
  assert.ok(finding);
  assert.equal(finding.id, "FINDING-001");
  assert.equal(finding.evidence.length, 1);
  assert.equal(finding.evidence[0].source, "execution-history");
  assert.equal(finding.evidence[0].ref, "rec-abc-123");
  assert.equal(finding.evidenceState, "exercised");
  assert.equal(finding.severity, "major");
  assert.ok(!("note" in finding.evidence[0]));
});

test("T2: 非法形态全被拒绝（非对象/缺 id/空证据/坏 source/空 impact/坏状态/坏级别）", () => {
  assert.equal(validateFinding(null), undefined);
  assert.equal(validateFinding("str"), undefined);
  assert.equal(validateFinding(makeFinding({ id: "  " })), undefined);
  assert.equal(validateFinding(makeFinding({ evidence: [] })), undefined);
  assert.equal(validateFinding(makeFinding({ evidence: [{ source: "bogus", ref: "x" }] })), undefined);
  assert.equal(validateFinding(makeFinding({ evidence: [{ source: "v2-event", ref: "" }] })), undefined);
  assert.equal(validateFinding(makeFinding({ impact: "" })), undefined);
  assert.equal(validateFinding(makeFinding({ evidenceState: "totally-made-up" })), undefined);
  assert.equal(validateFinding(makeFinding({ severity: "catastrophic" })), undefined);
});

test("T3: 超长字段被拒绝（impact > 500 字；note 截断到 200 字）", () => {
  assert.equal(validateFinding(makeFinding({ impact: "长".repeat(501) })), undefined);
  // note 走截断而不是拒绝（note 是辅助说明）
  const finding = validateFinding(
    makeFinding({ evidence: [{ source: "v2-event", ref: "e1", note: "n".repeat(300) }] })
  );
  assert.ok(finding);
  assert.equal(finding.evidence[0].note?.length, 200);
});

// ============================================================================
// 2. partitionByEvidence
// ============================================================================

test("T4: partition 划分 bound/deferred，deferred 保留原对象（≠ rejected）", () => {
  const finding = validateFinding(makeFinding())!;
  const bound1 = { id: "s1", rationale: "有证据", finding };
  const deferred1 = { id: "s2", rationale: "无证据候选，保留工作理由" };
  const deferred2 = { id: "s3", rationale: "finding 非法被降级", finding: undefined };
  const result = partitionByEvidence([bound1, deferred1, deferred2]);
  assert.equal(result.bound.length, 1);
  assert.equal(result.bound[0].id, "s1");
  assert.equal(result.bound[0].finding.id, "FINDING-001");
  assert.equal(result.deferred.length, 2);
  assert.deepEqual(result.deferred.map((s) => s.id).sort(), ["s2", "s3"]);
  // deferred 保留 rationale（工作理由不丢）
  assert.equal(result.deferred[0].rationale, "无证据候选，保留工作理由");
});

// ============================================================================
// 3. SedimentationWriter finding 落盘集成
// ============================================================================

function makeWriterFixture(): { root: string; writer: SedimentationWriter } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p3-writer-"));
  return { root, writer: new SedimentationWriter({ projectRoot: root }) };
}

test("T5: writer 集成——合法 finding 完整落盘 finding.json（字段零丢失）", async () => {
  const { root, writer } = makeWriterFixture();
  const finding = makeFinding();
  const draft: SedimentationDraft = {
    kind: "skill",
    name: "build-checklist",
    description: "构建验证清单",
    content: "# 构建验证\n1. tsc\n2. test",
    finding: finding as SedimentationDraft["finding"],
  };
  const result = await writer.write(draft, "project");
  assert.ok(result.ok);
  assert.ok(result.findingPath);
  assert.ok(fs.existsSync(result.findingPath));
  const persisted = JSON.parse(fs.readFileSync(result.findingPath, "utf8"));
  assert.equal(persisted.id, "FINDING-001");
  assert.deepEqual(persisted.evidence, finding.evidence);
  assert.equal(persisted.impact, finding.impact);
  assert.equal(persisted.minFixScope, finding.minFixScope);
  assert.equal(persisted.verifyRoute, finding.verifyRoute);
  assert.equal(persisted.evidenceState, "exercised");
  assert.equal(persisted.severity, "major");
  // SKILL.md 本体不受影响
  assert.ok(fs.existsSync(path.join(path.dirname(result.findingPath), "SKILL.md")));
});

test("T6: writer 集成——非法 finding 静默丢弃，SKILL.md 照常落盘（不产 finding.json）", async () => {
  const { root, writer } = makeWriterFixture();
  const draft: SedimentationDraft = {
    kind: "skill",
    name: "no-evidence-skill",
    description: "无证据草稿",
    content: "# 正文",
    finding: makeFinding({ evidence: [] }) as unknown as SedimentationDraft["finding"],
  };
  const result = await writer.write(draft, "project");
  assert.ok(result.ok);
  assert.equal(result.findingPath, undefined);
  assert.ok(fs.existsSync(path.join(root, ".deepcode", "skills", "no-evidence-skill", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(root, ".deepcode", "skills", "no-evidence-skill", "finding.json")));
});

test("T7: writer 集成——无 finding 字段行为不变（向后兼容）", async () => {
  const { root, writer } = makeWriterFixture();
  const result = await writer.write(
    { kind: "agent", name: "reviewer-agent", description: "评审角色", role: "代码评审员", content: "# 评审规范" },
    "project"
  );
  assert.ok(result.ok);
  assert.equal(result.findingPath, undefined);
  assert.ok(fs.existsSync(path.join(root, ".deepcode", "skills", "reviewer-agent", "SKILL.md")));
});

// ============================================================================
// 4. SedimentationSuggester finding 抽取
// ============================================================================

/** mock LLM 客户端（返回给定 JSON 文本） */
function mockLLM(responseText: string) {
  return {
    createLLMClient: async () => ({
      createMessage: async () => ({ content: responseText }),
    }),
  };
}

const SUGGESTION_WITH_FINDING = JSON.stringify({
  suggestions: [
    {
      kind: "skill",
      name: "deploy-runbook",
      description: "部署运行手册",
      content: "# 部署步骤",
      rationale: "部署流程重复出现三次",
      finding: makeFinding({ id: "FINDING-DEPLOY" }),
    },
  ],
});

test("T8: suggester——LLM 合法 finding 被携带到建议上", async () => {
  const suggester = new SedimentationSuggester({
    ...mockLLM(SUGGESTION_WITH_FINDING),
    log: () => {},
  } as unknown as ConstructorParameters<typeof SedimentationSuggester>[0]);
  const suggestions = await suggester.analyze("sess-1", [
    { role: "user", content: "帮我部署", id: "m1" },
    { role: "assistant", content: "好的，执行部署流程", id: "m2" },
  ] as never[]);
  assert.equal(suggestions.length, 1);
  assert.ok(suggestions[0].finding);
  assert.equal(suggestions[0].finding!.id, "FINDING-DEPLOY");
});

test("T9: suggester——非法 finding 降级（建议保留、finding 为 undefined 即 deferred）", async () => {
  const bad = JSON.stringify({
    suggestions: [
      {
        kind: "skill",
        name: "no-evidence",
        description: "无证据建议",
        content: "# 正文",
        rationale: "r",
        finding: { id: "F-1", evidence: [] },
      },
    ],
  });
  const suggester = new SedimentationSuggester({
    ...mockLLM(bad),
    log: () => {},
  } as unknown as ConstructorParameters<typeof SedimentationSuggester>[0]);
  const suggestions = await suggester.analyze("sess-2", [{ role: "user", content: "任务", id: "m1" }] as never[]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].finding, undefined);
  // 与 partitionByEvidence 衔接：进 deferred 池
  const partition = partitionByEvidence(suggestions);
  assert.equal(partition.bound.length, 0);
  assert.equal(partition.deferred.length, 1);
});

test("T10: suggester——无 finding 字段时建议行为与 T02 完全一致", async () => {
  const plain = JSON.stringify({
    suggestions: [{ kind: "skill", name: "plain-skill", description: "d", content: "# c", rationale: "r" }],
  });
  const suggester = new SedimentationSuggester({
    ...mockLLM(plain),
    log: () => {},
  } as unknown as ConstructorParameters<typeof SedimentationSuggester>[0]);
  const suggestions = await suggester.analyze("sess-3", [{ role: "user", content: "任务", id: "m1" }] as never[]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].finding, undefined);
  assert.ok(suggestions[0].fingerprint.length === 64);
});
