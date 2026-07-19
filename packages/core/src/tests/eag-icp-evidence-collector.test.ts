/**
 * EAG-P3 批次 11 单元测试：EvidenceCollector 证据采集器（evidence-collector.ts）
 *
 * 测试范围：
 * - T1. EvidenceCollector 实例化
 * - T2. collectCodeSnippet（代码片段证据）
 *   - T2a. 正常截取行号范围
 *   - T2b. 越界行号处理（lineStart < 1 / lineEnd > 总行数）
 *   - T2c. lineStart > lineEnd 时的处理
 *   - T2d. 单行截取
 * - T3. collectTestOutput（测试输出证据）
 *   - T3a. 仅 stdout
 *   - T3b. stdout + stderr 合并
 *   - T3c. 超长输出截断（> 1000 行）
 * - T4. collectConfig（配置文件证据）
 *   - T4a. 字符串值
 *   - T4b. 对象值（JSON 序列化）
 *   - T4c. null / undefined 值
 *   - T4d. 数字值
 * - T5. collectLog（日志证据）
 *   - T5a. 正常构造日志条目
 *   - T5b. 不同日志级别格式化
 * - T6. collectAuditTrail（审计追踪证据）
 *   - T6a. 正常构造审计记录
 *   - T6b. source 格式校验
 * - T7. 不可变性校验
 *   - T7a. 所有方法返回值均被冻结
 *
 * 测试约定：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实字符串与对象
 *
 * @module core/tests/eag-icp-evidence-collector
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EvidenceCollector } from "../eag/icp/evidence-collector";

// ============================================================================
// T1. EvidenceCollector 实例化
// ============================================================================

test("T1a: EvidenceCollector 应可正常实例化", () => {
  const collector = new EvidenceCollector();
  assert.ok(collector instanceof EvidenceCollector);
});

// ============================================================================
// T2. collectCodeSnippet
// ============================================================================

test("T2a: collectCodeSnippet 正常截取行号范围", () => {
  const collector = new EvidenceCollector();
  const content = "line1\nline2\nline3\nline4\nline5";
  const evidence = collector.collectCodeSnippet("src/test.ts", content, 2, 4);

  assert.equal(evidence.kind, "code-snippet");
  assert.equal(evidence.source, "src/test.ts:2-4");
  assert.equal(evidence.content, "line2\nline3\nline4");
  assert.ok(Object.isFrozen(evidence));
});

test("T2b: collectCodeSnippet 越界 lineStart < 1 时调整为 1", () => {
  const collector = new EvidenceCollector();
  const content = "line1\nline2\nline3";
  const evidence = collector.collectCodeSnippet("test.ts", content, -5, 2);

  assert.equal(evidence.source, "test.ts:1-2");
  assert.equal(evidence.content, "line1\nline2");
});

test("T2c: collectCodeSnippet 越界 lineEnd > 总行数时调整为总行数", () => {
  const collector = new EvidenceCollector();
  const content = "line1\nline2\nline3";
  const evidence = collector.collectCodeSnippet("test.ts", content, 2, 100);

  assert.equal(evidence.source, "test.ts:2-3");
  assert.equal(evidence.content, "line2\nline3");
});

test("T2d: collectCodeSnippet lineStart > lineEnd 时调整 lineEnd 为 lineStart", () => {
  const collector = new EvidenceCollector();
  const content = "line1\nline2\nline3";
  const evidence = collector.collectCodeSnippet("test.ts", content, 5, 2);

  // lineStart=5 被调整为 3（总行数），lineEnd=2 被调整为 3
  assert.equal(evidence.source, "test.ts:3-3");
  assert.equal(evidence.content, "line3");
});

test("T2e: collectCodeSnippet 单行截取", () => {
  const collector = new EvidenceCollector();
  const content = "line1\nline2\nline3";
  const evidence = collector.collectCodeSnippet("test.ts", content, 2, 2);

  assert.equal(evidence.source, "test.ts:2-2");
  assert.equal(evidence.content, "line2");
});

test("T2f: collectCodeSnippet 空文件处理", () => {
  const collector = new EvidenceCollector();
  const evidence = collector.collectCodeSnippet("test.ts", "", 1, 10);

  // 空文件时 lines = [""]，totalLines = 1
  assert.ok(evidence.source.includes("test.ts"));
});

test("T2g: collectCodeSnippet 处理 Windows 换行符（\\r\\n）", () => {
  const collector = new EvidenceCollector();
  const content = "line1\r\nline2\r\nline3";
  const evidence = collector.collectCodeSnippet("test.ts", content, 2, 3);

  assert.equal(evidence.content, "line2\nline3");
});

// ============================================================================
// T3. collectTestOutput
// ============================================================================

test("T3a: collectTestOutput 仅 stdout", () => {
  const collector = new EvidenceCollector();
  const evidence = collector.collectTestOutput("tests/test1.test.ts", "test passed");

  assert.equal(evidence.kind, "test-output");
  assert.equal(evidence.source, "tests/test1.test.ts");
  assert.equal(evidence.content, "test passed");
  assert.ok(Object.isFrozen(evidence));
});

test("T3b: collectTestOutput stdout + stderr 合并", () => {
  const collector = new EvidenceCollector();
  const evidence = collector.collectTestOutput("tests/test1.test.ts", "stdout content", "stderr content");

  assert.ok(evidence.content.includes("=== stdout ==="));
  assert.ok(evidence.content.includes("stdout content"));
  assert.ok(evidence.content.includes("=== stderr ==="));
  assert.ok(evidence.content.includes("stderr content"));
});

test("T3c: collectTestOutput 空字符串 stderr 不附加分隔标识", () => {
  const collector = new EvidenceCollector();
  const evidence = collector.collectTestOutput("tests/test1.test.ts", "stdout", "");

  // stderr 为空字符串，不应附加分隔标识
  assert.ok(!evidence.content.includes("=== stderr ==="));
  assert.equal(evidence.content, "stdout");
});

test("T3d: collectTestOutput 超长输出截断（> 1000 行）", () => {
  const collector = new EvidenceCollector();
  const longOutput = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join("\n");
  const evidence = collector.collectTestOutput("tests/test1.test.ts", longOutput);

  // 截断后应含截断标识
  assert.ok(evidence.content.includes("输出已截断"));
  assert.ok(evidence.content.includes("共 2000 行"));
  assert.ok(evidence.content.includes("仅显示前 1000 行"));
});

test("T3e: collectTestOutput 边界——恰好 1000 行不截断", () => {
  const collector = new EvidenceCollector();
  const output = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n");
  const evidence = collector.collectTestOutput("tests/test1.test.ts", output);

  // 1000 行不应被截断
  assert.ok(!evidence.content.includes("输出已截断"));
});

// ============================================================================
// T4. collectConfig
// ============================================================================

test("T4a: collectConfig 字符串值", () => {
  const collector = new EvidenceCollector();
  const evidence = collector.collectConfig(".eag/icp-config.yml", "compliance.gmp.version", "1.0.0");

  assert.equal(evidence.kind, "config");
  assert.equal(evidence.source, ".eag/icp-config.yml#compliance.gmp.version");
  assert.equal(evidence.content, "1.0.0");
  assert.ok(Object.isFrozen(evidence));
});

test("T4b: collectConfig 对象值（JSON 序列化）", () => {
  const collector = new EvidenceCollector();
  const value = { enabled: true, level: "blocker" };
  const evidence = collector.collectConfig("config.yml", "compliance.gmp", value);

  assert.ok(evidence.content.includes('"enabled": true'));
  assert.ok(evidence.content.includes('"level": "blocker"'));
});

test("T4c: collectConfig null 值", () => {
  const collector = new EvidenceCollector();
  const evidence = collector.collectConfig("config.yml", "field", null);

  assert.equal(evidence.content, "null");
});

test("T4d: collectConfig undefined 值", () => {
  const collector = new EvidenceCollector();
  const evidence = collector.collectConfig("config.yml", "field", undefined);

  assert.equal(evidence.content, "undefined");
});

test("T4e: collectConfig 数字值", () => {
  const collector = new EvidenceCollector();
  const evidence = collector.collectConfig("config.yml", "count", 42);

  assert.equal(evidence.content, "42");
});

test("T4f: collectConfig 布尔值", () => {
  const collector = new EvidenceCollector();
  const evidence = collector.collectConfig("config.yml", "enabled", true);

  assert.equal(evidence.content, "true");
});

// ============================================================================
// T5. collectLog
// ============================================================================

test("T5a: collectLog 正常构造日志条目", () => {
  const collector = new EvidenceCollector();
  const evidence = collector.collectLog("2026-07-19T10:00:00.000Z", "info", "操作完成");

  assert.equal(evidence.kind, "log");
  assert.equal(evidence.source, "log:2026-07-19T10:00:00.000Z");
  assert.equal(evidence.content, "[2026-07-19T10:00:00.000Z] [INFO] 操作完成");
  assert.ok(Object.isFrozen(evidence));
});

test("T5b: collectLog 不同日志级别格式化（level 应大写）", () => {
  const collector = new EvidenceCollector();

  const levels = ["info", "warn", "error", "debug"] as const;
  for (const level of levels) {
    const evidence = collector.collectLog("2026-07-19T10:00:00.000Z", level, "msg");
    assert.ok(evidence.content.includes(`[${level.toUpperCase()}]`));
  }
});

test("T5c: collectLog source 格式应为 log:<timestamp>", () => {
  const collector = new EvidenceCollector();
  const evidence = collector.collectLog("2026-07-19T10:00:00.000Z", "info", "msg");

  assert.match(evidence.source, /^log:/);
  assert.ok(evidence.source.includes("2026-07-19T10:00:00.000Z"));
});

// ============================================================================
// T6. collectAuditTrail
// ============================================================================

test("T6a: collectAuditTrail 正常构造审计记录", () => {
  const collector = new EvidenceCollector();
  const evidence = collector.collectAuditTrail("user-001", "2026-07-19T10:00:00.000Z", "approve-batch-record");

  assert.equal(evidence.kind, "audit-trail");
  assert.equal(evidence.source, "audit:user-001@2026-07-19T10:00:00.000Z");
  assert.ok(evidence.content.includes("operator=user-001"));
  assert.ok(evidence.content.includes("timestamp=2026-07-19T10:00:00.000Z"));
  assert.ok(evidence.content.includes("action=approve-batch-record"));
  assert.ok(Object.isFrozen(evidence));
});

test("T6b: collectAuditTrail 不同操作人/动作", () => {
  const collector = new EvidenceCollector();
  const evidence = collector.collectAuditTrail("admin-002", "2026-07-20T08:30:00.000Z", "delete-record");

  assert.ok(evidence.source.includes("admin-002"));
  assert.ok(evidence.content.includes("delete-record"));
});

// ============================================================================
// T7. 不可变性深度校验
// ============================================================================

test("T7a: 所有采集方法返回值均被冻结（修改应抛 TypeError）", () => {
  "use strict";
  const collector = new EvidenceCollector();

  const codeEvidence = collector.collectCodeSnippet("a.ts", "x\ny", 1, 2);
  assert.throws(() => {
    // @ts-expect-error 测试修改冻结对象
    codeEvidence.kind = "log";
  }, TypeError);

  const testEvidence = collector.collectTestOutput("t.ts", "ok");
  assert.throws(() => {
    // @ts-expect-error 测试修改冻结对象
    testEvidence.source = "modified";
  }, TypeError);

  const configEvidence = collector.collectConfig("c.yml", "k", "v");
  assert.throws(() => {
    // @ts-expect-error 测试修改冻结对象
    configEvidence.content = "modified";
  }, TypeError);

  const logEvidence = collector.collectLog("ts", "info", "msg");
  assert.throws(() => {
    // @ts-expect-error 测试修改冻结对象
    logEvidence.kind = "config";
  }, TypeError);

  const auditEvidence = collector.collectAuditTrail("op", "ts", "act");
  assert.throws(() => {
    // @ts-expect-error 测试修改冻结对象
    auditEvidence.source = "modified";
  }, TypeError);
});

test("T7b: EvidenceCollector 实例无状态——多次调用应返回独立证据对象", () => {
  const collector = new EvidenceCollector();

  const e1 = collector.collectLog("2026-07-19T10:00:00.000Z", "info", "msg1");
  const e2 = collector.collectLog("2026-07-19T10:00:00.000Z", "info", "msg2");

  assert.notStrictEqual(e1, e2, "应返回独立对象");
  assert.equal(e1.content.includes("msg1"), true);
  assert.equal(e2.content.includes("msg2"), true);
});
