/**
 * SensitiveInfoRedactor 单元测试（PRIV-01 ~ PRIV-08 + 边界用例）
 *
 * 设计依据：V2_CONTEXT_MEMORY_TECH_DESIGN.md §8.6 敏感信息过滤层
 *
 * 测试覆盖：
 * - PRIV-01: 通用密码脱敏（password=xxx / passwd: xxx / pwd xxx）
 * - PRIV-02: API Key 脱敏（api_key=xxx / api-secret: xxx / access_token=xxx）
 * - PRIV-03: Bearer Token 脱敏（Bearer xxx）
 * - PRIV-04: AWS Access Key 脱敏（AKIA/ASIA 开头 20 位）
 * - PRIV-05: 私钥块脱敏（-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----）
 * - PRIV-06: 平台令牌脱敏（GitHub PAT / GitLab PAT / Slack / Google API Key / JWT）
 * - PRIV-07: 多规则命中（同一文本多个敏感片段同时脱敏）
 * - PRIV-08: redactMemory 递归脱敏对象/数组
 * - PRIV-09: /g 正则 lastIndex 跨调用不残留（同一文本两次调用结果一致）
 * - PRIV-10: 命中按 offset 降序从后向前替换（不破坏偏移量）
 * - PRIV-11: digest = sha256(明文).hex.slice(0,8)（不可逆、可对账）
 * - PRIV-12: 审计日志只记录规则名/位置/digest，绝不记录明文
 * - PRIV-13: 无敏感信息时 sanitized === 原文，hits 为空
 * - PRIV-14: basic-auth-url 脱敏（https://user:pass@host）
 * - PRIV-15: 已替换为 [REDACTED] 的片段不再参与后续规则匹配
 *
 * 所有测试使用真实文件系统（mkdtempSync 临时目录）写审计日志，禁止 mock。
 *
 * @module v2/tests/memory/redaction.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { SensitiveInfoRedactor, DEFAULT_REDACTION_RULES, type RedactionRule } from "../../memory/redaction";

// ============================================================================
// 测试 fixture：每个用例独立的临时日志目录
// ============================================================================

let tempDir: string;
let logPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-redaction-"));
  logPath = path.join(tempDir, "redaction.log");
});

afterEach(async () => {
  // 等待 redact() 内部异步 appendLogs 完成，避免 tempDir 被删除后日志写入触发 ENOENT 告警
  // redact() 设计为同步返回（不阻塞主流程），审计日志异步追加；
  // 此处等待 50ms 让 microtask 队列中的 fs.appendFile 完成后再清理目录
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 计算明文片段的 SHA-256 前 8 位（与 redactor 内部 digest 算法一致）
 */
function expectedDigest(plainText: string): string {
  return createHash("sha256").update(plainText, "utf8").digest("hex").slice(0, 8);
}

// ============================================================================
// PRIV-01 ~ PRIV-15 测试用例
// ============================================================================

test("PRIV-01: 通用密码脱敏（password=xxx / passwd: xxx / pwd xxx）", () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);

  // password=xxx：整段 "password=hunter2!" 被替换为 [REDACTED]
  const r1 = redactor.redact("db password=hunter2!", "global.json");
  assert.match(r1.sanitized, /db \[REDACTED\]/);
  assert.ok(!r1.sanitized.includes("hunter2"), "明文密码应被脱敏");
  assert.equal(r1.hits.length, 1);
  assert.equal(r1.hits[0].ruleName, "generic-password");
  assert.equal(r1.hits[0].digest, expectedDigest("password=hunter2!"));

  // passwd: xxx：整段 "passwd: mySecret123" 被替换
  const r2 = redactor.redact("passwd: mySecret123", "global.json");
  assert.ok(!r2.sanitized.includes("mySecret123"), "明文密码应被脱敏");
  assert.equal(r2.hits[0].ruleName, "generic-password");

  // pwd=xxx：整段 "pwd=abc123" 被替换
  const r3 = redactor.redact("pwd=abc123", "global.json");
  assert.ok(!r3.sanitized.includes("abc123"), "明文密码应被脱敏");
  assert.equal(r3.hits[0].ruleName, "generic-password");
});

test("PRIV-02: API Key 脱敏（api_key=xxx / api-secret: xxx / access_token=xxx）", () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);

  // api_key=xxx：整段 "api_key=sk-abc123XYZ" 被替换
  const r1 = redactor.redact("api_key=sk-abc123XYZ", "global.json");
  assert.ok(!r1.sanitized.includes("sk-abc123XYZ"), "明文 API Key 应被脱敏");
  assert.equal(r1.hits[0].ruleName, "generic-api-key");
  assert.equal(r1.hits[0].severity, "high");

  // api-secret: xxx
  const r2 = redactor.redact('api-secret: "my-secret-value"', "global.json");
  assert.ok(!r2.sanitized.includes("my-secret-value"), "明文应被脱敏");

  // access_token=xxx
  const r3 = redactor.redact("access_token=abc123", "global.json");
  assert.ok(!r3.sanitized.includes("abc123"), "明文应被脱敏");
});

test("PRIV-03: Bearer Token 脱敏（Bearer xxx）", () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);

  // 标准 Bearer token：整段 "Bearer eyJ..." 被替换为 [REDACTED]
  const r1 = redactor.redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx", "global.json");
  assert.ok(!r1.sanitized.includes("eyJhbGciOiJIUzI1NiJ9"), "Bearer token 应被脱敏");
  assert.match(r1.sanitized, /Authorization: \[REDACTED\]/);
  assert.equal(r1.hits[0].ruleName, "bearer-token");

  // 太短的 token（< 8 字符）不应匹配
  const r2 = redactor.redact("Bearer abc", "global.json");
  assert.equal(r2.hits.length, 0, "短于 8 字符的 Bearer token 不应脱敏");
});

test("PRIV-04: AWS Access Key 脱敏（AKIA/ASIA 开头 20 位）", () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);

  // AKIA 开头的 AWS Access Key ID（20 位）
  const r1 = redactor.redact("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "global.json");
  assert.match(r1.sanitized, /\[REDACTED\]/);
  assert.equal(r1.hits[0].ruleName, "aws-access-key");
  assert.equal(r1.hits[0].digest, expectedDigest("AKIAIOSFODNN7EXAMPLE"));

  // ASIA 开头（临时凭据）
  const r2 = redactor.redact("key: ASIAIOSFODNN7EXAMPLE", "global.json");
  assert.match(r2.sanitized, /\[REDACTED\]/);
  assert.equal(r2.hits[0].ruleName, "aws-access-key");

  // 非 AKIA/ASIA 开头不应匹配
  const r3 = redactor.redact("AKIB1234567890ABCDEF", "global.json");
  assert.equal(r3.hits.length, 0, "非 AKIA/ASIA 开头不应匹配 aws-access-key");
});

test("PRIV-05: 私钥块脱敏（-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----）", () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);

  const privateKeyBlock = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAzb8rXXk3
abcdef1234567890
-----END RSA PRIVATE KEY-----`;
  const r = redactor.redact(`签名密钥：\n${privateKeyBlock}\n后续内容`, "global.json");
  assert.match(r.sanitized, /\[REDACTED\]/);
  assert.ok(!r.sanitized.includes("MIIEpAIBAAKCAQEA"), "私钥内容应被脱敏");
  assert.ok(!r.sanitized.includes("abcdef1234567890"), "私钥内容应被脱敏");
  assert.equal(r.hits[0].ruleName, "private-key-block");
  assert.equal(r.hits[0].severity, "high");
});

test("PRIV-06: 平台令牌脱敏（GitHub PAT / GitLab PAT / Slack / Google API Key / JWT）", () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);

  // GitHub PAT（ghp_ + 36 位）
  const r1 = redactor.redact("GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD", "global.json");
  assert.match(r1.sanitized, /\[REDACTED\]/);
  assert.equal(r1.hits[0].ruleName, "github-pat");

  // GitLab PAT（glpat- + 20 位）
  const r2 = redactor.redact("gitlab_token: glpat-1234567890abcdefghij", "global.json");
  assert.match(r2.sanitized, /\[REDACTED\]/);
  assert.equal(r2.hits[0].ruleName, "gitlab-pat");

  // Slack token（xoxp- / xoxb-）
  const r3 = redactor.redact("slack_token=xoxp-1234567890-abcdefghij", "global.json");
  assert.match(r3.sanitized, /\[REDACTED\]/);
  assert.equal(r3.hits[0].ruleName, "slack-token");

  // Google API Key（AIza + 35 位）
  // 注意：测试使用纯 token（不带 "google_api_key=" 前缀），
  // 因为前缀中的 "api_key=" 子串会被 generic-api-key 规则先匹配（先匹配者先替换），
  // 这是规则集声明顺序的正常行为。此处验证 google-api-key 规则本身能独立识别 Google API Key。
  const r4 = redactor.redact("AIzaSyA1234567890abcdefghijklmnopqrstuv", "global.json");
  assert.match(r4.sanitized, /\[REDACTED\]/);
  assert.equal(r4.hits[0].ruleName, "google-api-key");

  // JWT（eyJxxx.eyJxxx.signature）
  const r5 = redactor.redact("jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signatureabc", "global.json");
  assert.match(r5.sanitized, /\[REDACTED\]/);
  assert.equal(r5.hits[0].ruleName, "jwt-token");
});

test("PRIV-07: 多规则命中（同一文本多个敏感片段同时脱敏）", () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);

  const text = `配置：
db password=hunter2
api_key=sk-abc123
GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD
其他内容`;
  const r = redactor.redact(text, "global.json");

  assert.ok(r.hits.length >= 3, "应至少命中 3 个规则");
  // 验证所有命中片段已被替换为 [REDACTED]
  assert.ok(!r.sanitized.includes("hunter2"), "password 应被脱敏");
  assert.ok(!r.sanitized.includes("sk-abc123"), "api_key 应被脱敏");
  assert.ok(!r.sanitized.includes("ghp_1234567890"), "github token 应被脱敏");
  assert.ok(r.sanitized.includes("其他内容"), "非敏感内容保留");
});

test("PRIV-08: redactMemory 递归脱敏对象/数组", () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);

  const data = {
    user: "alice",
    credentials: {
      password: "password=secret123",
      apiKey: "api_key=sk-xyz",
    },
    notes: ["Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig", "normal text"],
    count: 42,
    active: true,
    nested: {
      deep: {
        secret: "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD",
      },
    },
  };

  const result = redactor.redactMemory(data, "global.json");

  // 验证嵌套对象中的敏感字段被脱敏
  assert.ok(!JSON.stringify(result).includes("secret123"), "嵌套 password 应被脱敏");
  assert.ok(!JSON.stringify(result).includes("sk-xyz"), "嵌套 api_key 应被脱敏");
  assert.ok(!JSON.stringify(result).includes("ghp_1234567890"), "深层 github token 应被脱敏");

  // 验证非敏感字段保留
  assert.equal(result.user, "alice");
  assert.equal(result.count, 42);
  assert.equal(result.active, true);
  assert.equal(result.notes[1], "normal text");

  // 验证原对象未被修改（纯函数语义）
  assert.equal(data.credentials.password, "password=secret123", "原对象不应被修改");
});

test("PRIV-09: /g 正则 lastIndex 跨调用不残留（同一文本两次调用结果一致）", () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);
  const text = "password=hunter2 and api_key=sk-abc123";

  // 第一次调用
  const r1 = redactor.redact(text, "global.json");
  // 第二次调用同一文本
  const r2 = redactor.redact(text, "global.json");

  // 两次结果必须完全一致（验证 lastIndex 重置）
  assert.equal(r1.sanitized, r2.sanitized, "同一文本两次调用 sanitized 应一致");
  assert.deepEqual(r1.hits, r2.hits, "同一文本两次调用 hits 应一致");
});

test("PRIV-10: 命中按 offset 降序从后向前替换（不破坏偏移量）", () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);

  // 三个命中：password (offset 靠前) / api_key (中间) / ghp_ (靠后)
  const text = "password=hunter2 middle api_key=sk-abc end ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD";
  const r = redactor.redact(text, "global.json");

  // hits 按 offset 升序排列（便于调用方按原文顺序查阅）
  for (let i = 1; i < r.hits.length; i++) {
    assert.ok(
      r.hits[i].offset > r.hits[i - 1].offset,
      `hits[${i}].offset (${r.hits[i].offset}) 应大于 hits[${i - 1}].offset (${r.hits[i - 1].offset})`
    );
  }

  // 验证 offset 对应原文中的敏感片段
  const firstHit = r.hits[0];
  const originalSlice = text.slice(firstHit.offset, firstHit.offset + firstHit.length);
  assert.equal(firstHit.digest, expectedDigest(originalSlice), "digest 应与原文对应片段的 SHA-256 一致");
});

test("PRIV-11: digest = sha256(明文).hex.slice(0,8)（不可逆、可对账）", () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);
  const plainText = "password=hunter2";
  const r = redactor.redact(plainText, "global.json");

  assert.equal(r.hits[0].digest, expectedDigest(plainText), "digest 应为 SHA-256 前 8 位");
  assert.equal(r.hits[0].digest.length, 8, "digest 长度应为 8");
});

test("PRIV-12: 审计日志只记录规则名/位置/digest，绝不记录明文", async () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);
  const plainText = "password=hunter2-secret-value";

  redactor.redact(plainText, "global.json");

  // 等待异步日志写入完成
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 读取日志文件
  const logContent = fs.readFileSync(logPath, "utf8");
  const logLines = logContent.trim().split("\n");

  assert.ok(logLines.length >= 1, "应至少写入一条日志");
  for (const line of logLines) {
    const entry = JSON.parse(line);
    // 验证日志结构
    assert.ok(entry.timestamp, "日志应含 timestamp");
    assert.equal(entry.memoryFile, "global.json");
    assert.ok(entry.ruleName, "日志应含 ruleName");
    assert.equal(typeof entry.offset, "number");
    assert.equal(typeof entry.length, "number");
    assert.equal(entry.digest.length, 8);

    // 隐私红线：日志绝不记录明文片段
    assert.ok(!line.includes("hunter2-secret-value"), "日志严禁包含明文片段");
    assert.ok(!line.includes("password=hunter2"), "日志严禁包含完整明文");
  }
});

test("PRIV-13: 无敏感信息时 sanitized === 原文，hits 为空", () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);

  const text = "这是一段完全正常的文本，不含任何敏感信息。Hello world!";
  const r = redactor.redact(text, "global.json");

  assert.equal(r.sanitized, text, "无敏感信息时 sanitized 应等于原文");
  assert.equal(r.hits.length, 0, "无敏感信息时 hits 应为空数组");
});

test("PRIV-14: basic-auth-url 脱敏（https://user:pass@host）", () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);

  const r = redactor.redact("service_url: https://alice:s3cr3t@api.example.com/v1", "global.json");
  assert.match(r.sanitized, /https:\/\/\[REDACTED\]@api\.example\.com\/v1/);
  assert.ok(!r.sanitized.includes("alice:s3cr3t"), "用户名密码应被脱敏");
  assert.equal(r.hits[0].ruleName, "basic-auth-url");
});

test("PRIV-15: 已替换为 [REDACTED] 的片段不再参与后续规则匹配", () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);

  // 构造一个文本，第一个规则命中后产生的 [REDACTED] 不应被第二个规则再次匹配
  // password=Bearer eyJxxx... 命中 generic-password 后，整段被替换，
  // bearer-token 规则不应再对已替换的 [REDACTED] 进行匹配
  const text = "password=Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature";
  const r = redactor.redact(text, "global.json");

  // generic-password 应命中（password= 后跟非空白字符）
  const passwordHit = r.hits.find((h) => h.ruleName === "generic-password");
  assert.ok(passwordHit, "generic-password 应命中");

  // 验证最终 sanitized 不含任何明文
  assert.ok(!r.sanitized.includes("Bearer eyJ"), "Bearer token 应随 password 一起被脱敏");
  assert.ok(!r.sanitized.includes("password=Bearer"), "整段 password=... 应被替换");
});

test("PRIV-16: 自定义规则集（追加规则不删除内置规则）", () => {
  // 自定义规则只能追加
  const customRules: RedactionRule[] = [
    ...DEFAULT_REDACTION_RULES,
    {
      name: "custom-internal-token",
      pattern: /internal_token_[a-z0-9]{16}/g,
      replacement: "[CUSTOM-REDACTED]",
      severity: "medium",
    },
  ];
  const redactor = new SensitiveInfoRedactor(customRules, logPath);

  // 内置规则仍生效
  const r1 = redactor.redact("password=hunter2", "global.json");
  assert.ok(
    r1.hits.some((h) => h.ruleName === "generic-password"),
    "内置规则应生效"
  );

  // 自定义规则生效
  const r2 = redactor.redact("internal_token_abcdef0123456789", "global.json");
  assert.ok(
    r2.hits.some((h) => h.ruleName === "custom-internal-token"),
    "自定义规则应生效"
  );
  assert.match(r2.sanitized, /\[CUSTOM-REDACTED\]/);
});

test("PRIV-17: 空文本与 null/undefined 输入安全处理", () => {
  const redactor = new SensitiveInfoRedactor(DEFAULT_REDACTION_RULES, logPath);

  // 空字符串
  const r1 = redactor.redact("", "global.json");
  assert.equal(r1.sanitized, "");
  assert.equal(r1.hits.length, 0);

  // redactMemory 处理 null/undefined
  assert.equal(redactor.redactMemory(null, "global.json"), null);
  assert.equal(redactor.redactMemory(undefined, "global.json"), undefined);

  // redactMemory 处理基本类型
  assert.equal(redactor.redactMemory(42, "global.json"), 42);
  assert.equal(redactor.redactMemory(true, "global.json"), true);
});
