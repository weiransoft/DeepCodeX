/**
 * 第 6 组修复的定向回归测试
 *
 * 覆盖：
 * - P1-17：合规证据 collectTestOutput head-only 丢 stderr 尾部真实错误 → 改保尾
 * - P1-18：对象存储 delete 用 .catch(() => null) 把任意读失败吞成「已永久删除」→ 区分 404 与其它异常
 * - P2：compliance-engine 空规则集 overallPassed、evidence-bundle 降级标注/失败原因摘要、
 *   report-render 空态区分、sedimentation toTurns 保尾、intervention-ledger 非法 verification 标注、
 *   dynamic/finding note 保尾 + partitionByEvidence 合法性校验
 *
 * 约定：node:test + assert/strict；不修改任何既有测试；不靠放宽断言刷绿。
 *
 * @module core/tests/eag-misc-evidence-fixes
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { EvidenceCollector } from "../eag/icp/evidence-collector";
import { ComplianceEngine } from "../eag/icp/compliance-engine";
import { S3Adapter, OssAdapter, ObjectNotFoundError } from "../eag/tcs/object-storage";
import type { StorageHttpClient, HttpResponse } from "../eag/tcs/object-storage";
import type { ObjectStorageConfig } from "../eag/tcs/types";
import { buildEvidenceBundle } from "../eag/evidence-bundle";
import { renderAuditReport, validateAuditReport } from "../eag/report-render";
import { readLedger, ledgerFilePath } from "../eag/intervention-ledger";
import { validateFinding, partitionByEvidence } from "../eag/dynamic/finding";
import { ExecutionHistoryStore } from "../v2/memory/execution-history-store";
import { DEFAULT_REDACTION_RULES, SensitiveInfoRedactor } from "../v2/memory/redaction";
import { SedimentationSuggester } from "../eag/dynamic/sedimentation-suggester";
import type { ComplianceCheckContext } from "../eag/icp/types";

// ============================================================================
// 通用 fixture
// ============================================================================

function minimalContext(): ComplianceCheckContext {
  return { projectRoot: "/tmp/eag-misc-test", fileMap: {}, astMap: {}, configMap: {} };
}

function makeConfig(provider: "s3" | "oss" = "s3"): ObjectStorageConfig {
  return {
    provider,
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    accessKeyId: "test-ak",
    accessKeySecret: "test-sk",
    bucket: "test-bucket",
    env: "test",
    domain: "user-avatar",
    allowedExtensions: ["jpg", "png"],
    maxFileBytes: 100 * 1024 * 1024,
  };
}

// ============================================================================
// P1-17：合规证据保尾
// ============================================================================

test("P1-17: stdout 超长 + stderr 尾部真实错误 → evidence.content 仍含该错误", () => {
  const collector = new EvidenceCollector();
  const realError = "FATAL: assertion failed at gmp-02 line 88 (expected 0, got 1)";
  // 1500 行 stdout 会超过 1000 行上限；旧 head-only 策略会把后面的 stderr 整段丢掉
  const stdout = Array.from({ length: 1500 }, (_, i) => `stdout line ${i + 1}`).join("\n");
  const stderr = `warning preamble\n${realError}`;

  const evidence = collector.collectTestOutput("tests/compliance/gmp-02.batch.test.ts", stdout, stderr);

  assert.ok(evidence.content.includes(realError), "stderr 尾部真实错误必须完整进入 evidence.content");
  assert.ok(evidence.content.includes("=== stderr ==="), "应保留 stderr 分隔标识");
  // 截断标识需写明被丢弃的是哪一段（头部）
  assert.ok(evidence.content.includes("被丢弃"), "截断标识应写明被丢弃段");
  assert.ok(evidence.content.includes("头部"), "被丢弃的应是头部行");
});

test("P1-17: 纯 stdout 超长截断后保留的是尾部行（而非头部）", () => {
  const collector = new EvidenceCollector();
  const stdout = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join("\n");
  const evidence = collector.collectTestOutput("t.ts", stdout);
  // 保尾：最后一行 line 2000 应保留，第一行 line 1 应被丢弃
  assert.ok(evidence.content.includes("line 2000"), "应保留输出尾部");
  assert.ok(!evidence.content.includes("line 1\n"), "头部行应被丢弃");
});

test("P1-17: 紧急回退开关 EAG_LEGACY_HEAD_ONLY_EVIDENCE=1 恢复旧 head-only 语义", () => {
  const prev = process.env.EAG_LEGACY_HEAD_ONLY_EVIDENCE;
  process.env.EAG_LEGACY_HEAD_ONLY_EVIDENCE = "1";
  try {
    const collector = new EvidenceCollector();
    const stdout = Array.from({ length: 1500 }, (_, i) => `stdout line ${i + 1}`).join("\n");
    const evidence = collector.collectTestOutput("t.ts", stdout, "TAIL-ERROR-MARKER");
    // 回退路径下 stderr 尾部错误确实会丢（仅为可回退性验证，非默认行为）
    assert.ok(!evidence.content.includes("TAIL-ERROR-MARKER"));
    assert.ok(evidence.content.includes("仅显示前 1000 行"));
  } finally {
    if (prev === undefined) delete process.env.EAG_LEGACY_HEAD_ONLY_EVIDENCE;
    else process.env.EAG_LEGACY_HEAD_ONLY_EVIDENCE = prev;
  }
});

// ============================================================================
// P1-18：对象存储 delete 不谎报成功
// ============================================================================

/** GET 返回 500（非 404）的 HTTP 客户端：模拟权限/服务端故障 */
class ServerErrorGetClient implements StorageHttpClient {
  async request(method: string): Promise<HttpResponse> {
    if (method === "GET") {
      return { status: 500, headers: {}, body: Buffer.from("internal server error") };
    }
    return { status: 200, headers: { etag: "x", "content-length": "0" }, body: Buffer.alloc(0) };
  }
}

/** GET 直接抛网络异常的 HTTP 客户端：模拟超时/连接重置/认证失败 */
class NetworkFailGetClient implements StorageHttpClient {
  async request(): Promise<HttpResponse> {
    throw new Error("ECONNRESET: connection reset by peer");
  }
}

/** GET 返回 404 的 HTTP 客户端：对象确实不存在 */
class NotFoundGetClient implements StorageHttpClient {
  async request(method: string): Promise<HttpResponse> {
    if (method === "GET") {
      return { status: 404, headers: {}, body: Buffer.from("<Error><Code>NoSuchKey</Code></Error>") };
    }
    return { status: 200, headers: { etag: "x", "content-length": "0" }, body: Buffer.alloc(0) };
  }
}

test("P1-18: S3 delete —— get 返回 500（非 404）时抛错，绝不返回 permanent:true", async () => {
  const adapter = new S3Adapter(makeConfig("s3"), new ServerErrorGetClient());
  await assert.rejects(() => adapter.delete("test/user-avatar/202607/a.jpg"), /拒绝谎报删除成功|前置 get 失败/);
});

test("P1-18: S3 delete —— get 抛网络异常时抛错，绝不返回 permanent:true", async () => {
  const adapter = new S3Adapter(makeConfig("s3"), new NetworkFailGetClient());
  await assert.rejects(() => adapter.delete("test/user-avatar/202607/a.jpg"), /ECONNRESET|拒绝谎报删除成功/);
});

test("P1-18: OSS delete —— get 返回 500（非 404）时抛错，绝不返回 permanent:true", async () => {
  const adapter = new OssAdapter(makeConfig("oss"), new ServerErrorGetClient());
  await assert.rejects(() => adapter.delete("test/user-avatar/202607/a.jpg"), /拒绝谎报删除成功|前置 get 失败/);
});

test("P1-18: 仅 404/NotFound 走 permanent:true（对象确实不存在）", async () => {
  const s3 = new S3Adapter(makeConfig("s3"), new NotFoundGetClient());
  const r1 = await s3.delete("missing/key.jpg");
  assert.equal(r1.permanent, true, "对象确实不存在才允许 permanent:true");
  assert.equal(r1.error, undefined);

  const oss = new OssAdapter(makeConfig("oss"), new NotFoundGetClient());
  const r2 = await oss.delete("missing/key.jpg");
  assert.equal(r2.permanent, true);
});

test("P1-18: get 404 抛 ObjectNotFoundError（结构化，供 delete 精确区分）", async () => {
  const adapter = new S3Adapter(makeConfig("s3"), new NotFoundGetClient());
  await assert.rejects(() => adapter.get("missing/key.jpg"), ObjectNotFoundError);
});

test("P1-18: EAG_TCS_DELETE_RETURN_ERROR=1 时诚实降级返回 permanent:false + error（不谎报）", async () => {
  const prev = process.env.EAG_TCS_DELETE_RETURN_ERROR;
  process.env.EAG_TCS_DELETE_RETURN_ERROR = "1";
  try {
    const adapter = new S3Adapter(makeConfig("s3"), new ServerErrorGetClient());
    const result = await adapter.delete("test/user-avatar/202607/a.jpg");
    assert.equal(result.permanent, false, "读失败不得谎报 permanent:true");
    assert.ok(result.error && result.error.length > 0, "应携带失败原因");
    assert.ok(!("deletedAt" in result && result.permanent), "不得同时表现为成功");
  } finally {
    if (prev === undefined) delete process.env.EAG_TCS_DELETE_RETURN_ERROR;
    else process.env.EAG_TCS_DELETE_RETURN_ERROR = prev;
  }
});

// ============================================================================
// P2：compliance-engine 空规则集
// ============================================================================

test("P2: 规则集为空时 overallPassed 不为 true（空集不得报告合规通过）", async () => {
  const engine = new ComplianceEngine();
  // 注入空规则包，走完整 run() 路径（三条 filter 后 allResults=[]）
  (engine as unknown as { loadPack: (id: string) => unknown }).loadPack = () => ({
    packId: "GMP",
    packName: "空规则集测试包",
    version: "1.0.0",
    rules: [],
  });
  const report = await engine.run("GMP", minimalContext(), "run-empty");
  assert.equal(report.ruleResults.length, 0);
  assert.equal(report.overallPassed, false, "一条规则未执行绝不能 overallPassed=true");
});

test("P2: compliance-engine summary 与 overallPassed 统一 warning 口径", async () => {
  const engine = new ComplianceEngine();
  // 注入只含一条 warning 级且失败规则的 pack：overallPassed 应为 true，
  // 摘要不得把该 warning 失败计入「失败（阻断性）」。
  (engine as unknown as { loadPack: (id: string) => unknown }).loadPack = () => ({
    packId: "GMP",
    packName: "warning 口径测试包",
    version: "1.0.0",
    rules: [
      {
        ruleId: "W-01",
        packId: "GMP",
        title: "warning 规则",
        description: "d",
        regulatoryReference: "r",
        checkKind: "static",
        severity: "warning",
        staticChecker: () => ({
          ruleId: "W-01",
          passed: false,
          severity: "warning" as const,
          evidence: [],
          reason: "warning 失败",
        }),
      },
    ],
  });
  const report = await engine.run("GMP", minimalContext(), "run-warning");
  assert.equal(report.overallPassed, true, "warning 失败不应影响整体判定");
  assert.ok(report.summary.includes("0 失败（阻断性）"), "warning 失败不应计入阻断性失败数");
  assert.ok(report.summary.includes("warning 失败 1 条不影响整体判定"), "应单独标注 warning 失败");
});

// ============================================================================
// P2：evidence-bundle 降级标注 / 失败原因摘要
// ============================================================================

function makeBundleFixture(): { root: string; homeDir: string; redactor: SensitiveInfoRedactor } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eag-misc-bundle-"));
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, path.join(root, "redaction.log"));
  return { root, homeDir, redactor };
}

const BUNDLE_SINCE = Date.parse("2026-05-01T00:00:00.000Z");
const BUNDLE_UNTIL = Date.parse("2026-06-02T00:00:00.000Z");

test("P2: evidence-bundle 失败记录保留脱敏后保尾的错误摘要，且明文密钥不进 bundle", async () => {
  const fx = makeBundleFixture();
  const secret = "sk-SECRET-MUST-NOT-LEAK-9f3a";
  const store = new ExecutionHistoryStore({ projectRoot: fx.root, homeDir: fx.homeDir });
  await store.record({
    sessionId: "s1",
    toolName: "bash",
    ok: false,
    timestamp: Date.parse("2026-06-01T00:00:00.000Z"),
    errorSnippet: `HEAD-MARK ${"x".repeat(600)} TAIL-ERROR: api_key=${secret} failed`,
  });
  store.closeSync();

  const bundle = await buildEvidenceBundle({
    projectRoot: fx.root,
    homeDir: fx.homeDir,
    since: BUNDLE_SINCE,
    until: BUNDLE_UNTIL,
    redactor: fx.redactor,
  });
  const rec = bundle.executionHistory[0];
  assert.ok(rec?.errorSummary, "失败记录应携带 errorSummary");
  assert.ok(rec!.errorSummary!.includes("TAIL-ERROR"), "错误摘要应保尾包含真实错误");
  assert.ok(!rec!.errorSummary!.includes("HEAD-MARK"), "保尾截断应丢弃头部");
  assert.ok(!JSON.stringify(bundle).includes(secret), "明文密钥不得进入 bundle（隐私红线）");
});

test("P2: evidence-bundle maxRecords 丢弃尾部记录 + listSkills 失败均进 manifest.degradedSources", async () => {
  const fx = makeBundleFixture();
  const store = new ExecutionHistoryStore({ projectRoot: fx.root, homeDir: fx.homeDir });
  for (let i = 0; i < 3; i += 1) {
    await store.record({
      sessionId: `s${i}`,
      toolName: "bash",
      ok: true,
      timestamp: Date.parse("2026-06-01T00:00:00.000Z") + i,
    });
  }
  store.closeSync();

  const bundle = await buildEvidenceBundle({
    projectRoot: fx.root,
    homeDir: fx.homeDir,
    since: BUNDLE_SINCE,
    until: BUNDLE_UNTIL,
    maxRecords: 1,
    redactor: fx.redactor,
    listSkills: async () => {
      throw new Error("provider down");
    },
  });
  assert.equal(bundle.summary.recordCount, 1);
  assert.ok(bundle.manifest.degradedSources, "降级/丢弃必须写入 manifest");
  const ds = bundle.manifest.degradedSources!;
  assert.ok(
    ds.some((d) => d.path === "execution-history" && d.reason.includes("丢弃尾部最新")),
    "截断丢弃应标注"
  );
  assert.ok(
    ds.some((d) => d.path === "skills" && d.reason.includes("失败")),
    "技能源失败应标注"
  );
});

// ============================================================================
// P2：report-render 空态区分 / 校验
// ============================================================================

test("P2: report-render 空态区分「无数据」与「数据源失败」，validateAuditReport 支持证据非空校验", () => {
  const base = { generatedAt: "2026-11-01T08:00:00.000Z", evidenceWindow: "窗口" };
  // 无降级：保留既有泛化空态文案（向后兼容）
  const empty = renderAuditReport(base);
  assert.ok(empty.includes("_（本窗口无规则使用证据）_"));
  assert.ok(validateAuditReport(empty));
  assert.equal(validateAuditReport(empty, { requireNonEmptyEvidence: true }), false, "空态不应通过证据非空校验");

  // 有降级：明确「数据源失败」+ 全局汇总行，而非泛化「无数据」
  const degraded = renderAuditReport({ ...base, degradedSources: ["ruleEvidence", "ledgerEntries"] });
  assert.ok(degraded.includes("数据源失败"));
  assert.ok(degraded.includes("本段证据不可用"));
  assert.ok(!degraded.includes("_（本窗口无规则使用证据）_"), "降级段不得用泛化无数据文案");
  assert.ok(validateAuditReport(degraded));
  assert.equal(validateAuditReport(degraded, { requireNonEmptyEvidence: true }), false);

  // 悄悄降级（段落标降级但无全局汇总行）→ 校验拒绝
  const stealth = [
    "## 证据窗口",
    "## 规则使用证据",
    "_（数据源失败：规则证据数据源不可用，本段证据不可用）_",
    "## 重复工作流发现",
    "## 干预台账",
  ].join("\n");
  assert.equal(validateAuditReport(stealth), false, "悄悄降级应被校验拒绝");
});

// ============================================================================
// P2：intervention-ledger 非法 verification 标注
// ============================================================================

test("P2: intervention-ledger 非法 verification 不再静默丢弃（保留原始值 + 解析告警）", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "eag-misc-ledger-"));
  const p = ledgerFilePath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify([
      {
        findingId: "F-1",
        appliedAt: "2026-10-30T10:00:00.000Z",
        owner: "user",
        expectedEffect: "效果",
        verification: { verifiedAt: "", state: "totally-bogus", note: "原始说明" },
      },
    ]),
    "utf8"
  );
  const entries = readLedger(home);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].verification, undefined, "非法 verification 不得被当成合法结构");
  assert.ok(entries[0].verificationParseWarning, "应有解析告警标注，而非静默丢弃");
  assert.ok(entries[0].rawVerification, "应保留原始 verification 值供人工核对");
});

// ============================================================================
// P2：sedimentation toTurns 保尾 / finding note 保尾 + partition 校验
// ============================================================================

test("P2: sedimentation toTurns 取最近 30 轮（而非最旧 30 轮）", async () => {
  let captured = "";
  const suggester = new SedimentationSuggester({
    createLLMClient: async () => ({
      createMessage: async (req: unknown) => {
        const r = req as { messages?: Array<{ content?: string }> };
        captured = r.messages?.[1]?.content ?? "";
        return { content: '{"suggestions":[]}' };
      },
    }),
  } as unknown as ConstructorParameters<typeof SedimentationSuggester>[0]);
  const transcript = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `TURN-${String(i + 1).padStart(2, "0")}`,
    id: `m${i}`,
  })) as never[];
  await suggester.analyze("sess-recent", transcript);
  assert.ok(captured.includes("TURN-40"), "最近轮次应进入 prompt");
  assert.ok(!captured.includes("TURN-01"), "最旧轮次不应进入 prompt（旧 head-only 会取最旧 30 轮）");
});

test("P2: finding note 超长保尾截断；partitionByEvidence 拒绝未过 schema 的 finding", () => {
  const finding = validateFinding({
    id: "F-1",
    evidence: [
      {
        source: "execution-history",
        ref: "rec-1",
        note: "HEAD-MARK" + "x".repeat(300) + "TAIL-MARK",
      },
    ],
    impact: "影响",
    minFixScope: "范围",
    verifyRoute: "验证",
    evidenceState: "exercised",
    severity: "major",
  });
  assert.ok(finding);
  assert.equal(finding.evidence[0].note?.length, 200);
  assert.ok(finding.evidence[0].note?.includes("TAIL-MARK"), "应保尾保留尾部标记");
  assert.ok(!finding.evidence[0].note?.includes("HEAD-MARK"), "头部标记应被丢弃");

  // truthy 但未过 schema 的 finding 应降级 deferred，不得进 bound
  const bogus = { id: "s1", finding: { id: "F-bad", evidence: [] } };
  const partition = partitionByEvidence([bogus] as never[]);
  assert.equal(partition.bound.length, 0, "非法 finding 不得进 bound");
  assert.equal(partition.deferred.length, 1, "非法 finding 应降级 deferred（不丢弃建议）");
});
