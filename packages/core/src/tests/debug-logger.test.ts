import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getDebugLogPath, logOpenAIChatCompletionDebug } from "../common/debug-logger";

test("debug logger appends full entries without rotation", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-debug-log-home-"));
  process.env.HOME = home;
  if (process.platform === "win32") {
    process.env.USERPROFILE = home;
  }
  try {
    for (let index = 0; index < 25; index += 1) {
      logOpenAIChatCompletionDebug({
        timestamp: "2026-01-01T00:00:00.000Z",
        location: "test.location",
        requestId: `request-${index}`,
        model: "test-model",
        request: {
          model: "test-model",
          messages: [{ role: "user", content: `full request content ${index}` }],
        },
        response: {
          choices: [{ message: { content: `full response content ${index}` } }],
        },
      });
    }

    const raw = fs.readFileSync(getDebugLogPath(), "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 25);

    const first = JSON.parse(lines[0]) as Record<string, any>;
    const last = JSON.parse(lines[24]) as Record<string, any>;
    assert.equal(first.requestId, "request-0");
    assert.equal(first.request.messages[0].content, "full request content 0");
    assert.equal(last.requestId, "request-24");
    assert.equal(last.response.choices[0].message.content, "full response content 24");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});

// ============================================================================
// D-2 集成测试：debug-logger 与 log-rotation 联动（追加 4 个用例）
// 测试目标：
//   - 验证 logOpenAIChatCompletionDebug 在写入前正确调用 rotateLogIfNeeded
//   - 验证轮转失败时降级为直接 append，不阻塞主流程
//   - 验证多次轮转后保留 maxBackupCount=3 个备份
// 严禁 mock：所有 fs 操作使用真实文件系统，使用临时 HOME 目录隔离
// ============================================================================

/**
 * 创建临时 HOME 目录并切换 process.env.HOME，返回 { home, restore } 辅助对象。
 * 调用方必须在 finally 中调用 restore() 并通过 fs.rmSync(home, recursive) 清理。
 */
function setupTempHome(prefix: string): { home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `deepcode-debug-${prefix}-`));
  process.env.HOME = home;
  if (process.platform === "win32") {
    process.env.USERPROFILE = home;
  }
  return { home };
}

/**
 * 恢复 process.env.HOME / USERPROFILE 到原始值。
 */
function restoreHome(originalHome: string | undefined, originalUserProfile: string | undefined): void {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
}

/**
 * 构造一个最小的 OpenAIChatCompletionDebugEntry 用于测试。
 */
function makeDebugEntry(index: number) {
  return {
    timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    location: `test.rotate.${index}`,
    requestId: `rotate-req-${index}`,
    model: "test-model",
    request: {
      model: "test-model",
      messages: [{ role: "user", content: `rotate content ${index}` }],
    },
    response: {
      choices: [{ message: { content: `resp ${index}` } }],
    },
  };
}

// TC-DR-001：debug.log 超过 10MB 时触发轮转（D-2 集成）
// 验证：预填充 10MB+1KB 内容后调用 logOpenAIChatCompletionDebug，应触发轮转
// 期望：debug.log.1 存在且为旧内容，debug.log 只有 1 行新内容
test("TC-DR-001: debug.log 超过 10MB 时触发轮转", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const { home } = setupTempHome("rotate-1");
  try {
    const logPath = getDebugLogPath();
    const logDir = path.dirname(logPath);
    fs.mkdirSync(logDir, { recursive: true });

    // 预填充 10MB+1KB 内容到 debug.log（超过默认阈值 10MB）
    const originalSize = 10 * 1024 * 1024 + 1024;
    const originalContent = Buffer.alloc(originalSize, 0x61);
    fs.writeFileSync(logPath, originalContent);

    // 调用 logOpenAIChatCompletionDebug，应触发轮转
    logOpenAIChatCompletionDebug(makeDebugEntry(1));

    // 断言 1：debug.log.1 存在且为旧内容
    assert.equal(fs.existsSync(`${logPath}.1`), true, "debug.log.1 应存在");
    const backupContent = fs.readFileSync(`${logPath}.1`);
    assert.equal(backupContent.length, originalSize, "备份文件大小应等于原始大小");
    assert.equal(backupContent[0], 0x61, "备份文件首字节应匹配");

    // 断言 2：debug.log 只有 1 行新内容
    const newContent = fs.readFileSync(logPath, "utf8");
    const lines = newContent.trim().split("\n");
    assert.equal(lines.length, 1, "新 debug.log 应只有 1 行");
    const parsed = JSON.parse(lines[0]) as Record<string, any>;
    assert.equal(parsed.requestId, "rotate-req-1");
    assert.equal(parsed.request.messages[0].content, "rotate content 1");
  } finally {
    restoreHome(originalHome, originalUserProfile);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// TC-DR-002：debug.log 轮转后新内容写入新文件（D-2 集成）
// 验证：轮转后新 entry 写入新的 debug.log，旧内容完整保留到 .1
// 与 TC-DR-001 互补：连续写入 2 条 entry，第 2 条应在新文件中
test("TC-DR-002: debug.log 轮转后新内容写入新文件", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const { home } = setupTempHome("rotate-2");
  try {
    const logPath = getDebugLogPath();
    const logDir = path.dirname(logPath);
    fs.mkdirSync(logDir, { recursive: true });

    // 预填充 10MB+1KB 内容到 debug.log
    const originalSize = 10 * 1024 * 1024 + 1024;
    fs.writeFileSync(logPath, Buffer.alloc(originalSize, 0x62));

    // 调用 logOpenAIChatCompletionDebug，应触发轮转
    logOpenAIChatCompletionDebug(makeDebugEntry(10));

    // 轮转后，新文件中应只有 1 条 entry（requestId=rotate-req-10）
    const newContent = fs.readFileSync(logPath, "utf8");
    const lines = newContent.trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]) as Record<string, any>;
    assert.equal(parsed.requestId, "rotate-req-10");

    // 再次调用 logOpenAIChatCompletionDebug（此时 debug.log 很小，不触发轮转）
    logOpenAIChatCompletionDebug(makeDebugEntry(11));

    // 新文件中现在应有 2 行
    const newContent2 = fs.readFileSync(logPath, "utf8");
    const lines2 = newContent2.trim().split("\n");
    assert.equal(lines2.length, 2);
    const parsed10 = JSON.parse(lines2[0]) as Record<string, any>;
    const parsed11 = JSON.parse(lines2[1]) as Record<string, any>;
    assert.equal(parsed10.requestId, "rotate-req-10");
    assert.equal(parsed11.requestId, "rotate-req-11");

    // debug.log.1 仍为旧的大文件内容
    const backup = fs.readFileSync(`${logPath}.1`);
    assert.equal(backup.length, originalSize);
    assert.equal(backup[0], 0x62);

    // 不应存在 .2（只轮转了一次）
    assert.equal(fs.existsSync(`${logPath}.2`), false);
  } finally {
    restoreHome(originalHome, originalUserProfile);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// TC-DR-003：debug.log 轮转失败时仍写入日志（D-2 容错）
// 验证：rotateLogIfNeeded 抛错时，logOpenAIChatCompletionDebug 不抛错且仍 append 内容
// 实现：将 debug.log.1/.2/.3 都创建为非空目录，使整个 rename 链失败，最终
//       rename(logPath, .1) 因 .1 是非空目录而抛错
// 期望：调用不抛错，debug.log 仍被追加新行（旧大文件内容 + 新 entry 行）
test("TC-DR-003: debug.log 轮转失败时仍写入日志", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const { home } = setupTempHome("rotate-fail");
  try {
    const logPath = getDebugLogPath();
    const logDir = path.dirname(logPath);
    fs.mkdirSync(logDir, { recursive: true });

    // 预填充 10MB+1KB 内容到 debug.log
    const originalSize = 10 * 1024 * 1024 + 1024;
    const originalContent = Buffer.alloc(originalSize, 0x63);
    fs.writeFileSync(logPath, originalContent);

    // 将 debug.log.1/.2/.3 都创建为非空目录（各含 blocker.txt）
    // rotateLogIfNeeded 内部（maxBackupCount=3）：
    //   - i=3: unlinkSync(.3) 失败（.3 是目录，EISDIR），catch
    //   - i=2: renameSync(.2, .3) 失败（.3 是非空目录，ENOTEMPTY），catch
    //   - i=1: renameSync(.1, .2) 失败（.2 是非空目录，ENOTEMPTY），catch
    //   - 最后: renameSync(logPath, .1) 失败（.1 是非空目录，EISDIR/ENOTDIR），抛错
    // logOpenAIChatCompletionDebug 内层 catch 捕获该错误，继续 appendFileSync
    for (let i = 1; i <= 3; i += 1) {
      const dirPath = `${logPath}.${i}`;
      fs.mkdirSync(dirPath);
      fs.writeFileSync(path.join(dirPath, "blocker.txt"), "blocker");
    }

    // 调用不应抛错
    assert.doesNotThrow(() => logOpenAIChatCompletionDebug(makeDebugEntry(20)));

    // debug.log 应被追加新行（旧二进制内容 + 新 JSON 行）
    // 注意：旧内容是二进制（0x63），不能用 utf8 读取，用 Buffer 检查长度
    const after = fs.readFileSync(logPath);
    assert.ok(after.length > originalSize, "debug.log 应被追加新内容");
    // 验证新内容包含在文件末尾：取最后若干字节解析为 JSON
    const tail = after.subarray(after.length - 1024).toString("utf8");
    assert.ok(tail.includes("rotate-req-20"), "新 entry 应写入 debug.log 末尾");

    // debug.log.1/.2/.3 仍是非空目录（未被 rename 覆盖）
    assert.equal(fs.statSync(`${logPath}.1`).isDirectory(), true, ".1 仍应为目录");
    assert.equal(fs.statSync(`${logPath}.2`).isDirectory(), true, ".2 仍应为目录");
    assert.equal(fs.statSync(`${logPath}.3`).isDirectory(), true, ".3 仍应为目录");
  } finally {
    restoreHome(originalHome, originalUserProfile);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// TC-DR-004：多次轮转后保留 3 个备份（D-2 备份上限）
// 验证：连续触发 5 次轮转后，只保留 .1/.2/.3，不存在 .4
test("TC-DR-004: 多次轮转后保留 3 个备份", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const { home } = setupTempHome("rotate-multi");
  try {
    const logPath = getDebugLogPath();
    const logDir = path.dirname(logPath);
    fs.mkdirSync(logDir, { recursive: true });

    // 连续触发 5 次轮转
    // 每次循环：预填充 10MB+1KB 大文件 → 调用 logOpenAIChatCompletionDebug 触发轮转
    for (let i = 1; i <= 5; i += 1) {
      // 覆盖 debug.log 为大文件（如果上次轮转后 debug.log 只有 1 行小内容，这里会覆盖）
      // 注意：如果 debug.log 不存在（被 rename 走了），writeFileSync 会创建新文件
      fs.writeFileSync(logPath, Buffer.alloc(10 * 1024 * 1024 + 1024, 0x60 + i));
      logOpenAIChatCompletionDebug(makeDebugEntry(100 + i));
    }

    // 断言：保留 .1/.2/.3，不存在 .4
    assert.equal(fs.existsSync(`${logPath}.1`), true, "debug.log.1 应存在");
    assert.equal(fs.existsSync(`${logPath}.2`), true, "debug.log.2 应存在");
    assert.equal(fs.existsSync(`${logPath}.3`), true, "debug.log.3 应存在");
    assert.equal(fs.existsSync(`${logPath}.4`), false, "debug.log.4 不应存在");

    // 验证 .1 是最近一次轮转的旧内容（标记字节 0x65 = 第 5 次）
    const dot1 = fs.readFileSync(`${logPath}.1`);
    assert.equal(dot1[0], 0x65, ".1 应为第 5 次轮转的旧内容");
    // 验证 .2 是第 4 次的（0x64）
    const dot2 = fs.readFileSync(`${logPath}.2`);
    assert.equal(dot2[0], 0x64, ".2 应为第 4 次轮转的旧内容");
    // 验证 .3 是第 3 次的（0x63）
    const dot3 = fs.readFileSync(`${logPath}.3`);
    assert.equal(dot3[0], 0x63, ".3 应为第 3 次轮转的旧内容");

    // debug.log 当前是新 entry（1 行）
    const newContent = fs.readFileSync(logPath, "utf8");
    const lines = newContent.trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]) as Record<string, any>;
    assert.equal(parsed.requestId, "rotate-req-105");
  } finally {
    restoreHome(originalHome, originalUserProfile);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ============================================================================
// FIX-08 密钥脱敏测试（多角色审查 2026-07-29）
// 测试目标：
//   - 敏感字段名（apiKey/Authorization/token 等）命中时，值整体替换为 [REDACTED]
//   - 字符串值形如密钥（sk-*/Bearer */ghp_*）时，即使键名不敏感也脱敏
//   - 非敏感字段内容不受影响（不误伤）
//   - 嵌套对象与数组中的敏感字段同样脱敏
// ============================================================================

// TC-RS-001：敏感字段名的值整体脱敏
test("TC-RS-001: 敏感字段名（apiKey/authorization/token）的值脱敏为 [REDACTED]", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const { home } = setupTempHome("redact-key");
  try {
    logOpenAIChatCompletionDebug({
      timestamp: "2026-01-01T00:00:00.000Z",
      location: "test.redact.key",
      requestId: "redact-req-1",
      request: {
        model: "test-model",
        apiKey: "sk-live-secret-key-123456",
        Authorization: "Bearer sk-live-secret-key-123456",
        access_token: "oauth-token-abc",
        userPassword: "p@ssw0rd",
        awsCredentials: { ak: "AKIA..." },
        messages: [{ role: "user", content: "正常内容" }],
      },
    });

    const raw = fs.readFileSync(getDebugLogPath(), "utf8");
    const parsed = JSON.parse(raw.trim()) as Record<string, any>;
    assert.equal(parsed.request.apiKey, "[REDACTED]", "apiKey 应脱敏");
    assert.equal(parsed.request.Authorization, "[REDACTED]", "Authorization 应脱敏");
    assert.equal(parsed.request.access_token, "[REDACTED]", "access_token 应脱敏");
    assert.equal(parsed.request.userPassword, "[REDACTED]", "userPassword 应脱敏");
    assert.equal(parsed.request.awsCredentials, "[REDACTED]", "awsCredentials 应整体脱敏");
    assert.equal(parsed.request.messages[0].content, "正常内容", "非敏感字段不受影响");
    assert.equal(parsed.request.model, "test-model", "model 字段不受影响");
    // 原始密钥绝不出现在日志中
    assert.ok(!raw.includes("sk-live-secret-key-123456"), "日志不得包含原始密钥");
  } finally {
    restoreHome(originalHome, originalUserProfile);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// TC-RS-002：键名不敏感但值形如密钥时脱敏
test("TC-RS-002: 值形如密钥（sk-*/Bearer */ghp_*）时脱敏", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const { home } = setupTempHome("redact-value");
  try {
    logOpenAIChatCompletionDebug({
      timestamp: "2026-01-01T00:00:00.000Z",
      location: "test.redact.value",
      requestId: "redact-req-2",
      request: {
        model: "test-model",
        endpoint: "sk-proj-abcdef1234567890",
        note: "Bearer eyJhbGciOiJIUzI1NiIs",
        upstream: "ghp_1234567890abcdefgh",
        description: "这是一段普通中文描述，不应脱敏",
        url: "https://api.example.com/v1/chat",
      },
    });

    const raw = fs.readFileSync(getDebugLogPath(), "utf8");
    const parsed = JSON.parse(raw.trim()) as Record<string, any>;
    assert.equal(parsed.request.endpoint, "[REDACTED]", "sk- 前缀值应脱敏");
    assert.equal(parsed.request.note, "[REDACTED]", "Bearer 值应脱敏");
    assert.equal(parsed.request.upstream, "[REDACTED]", "ghp_ 值应脱敏");
    assert.equal(parsed.request.description, "这是一段普通中文描述，不应脱敏", "普通中文不脱敏");
    assert.equal(parsed.request.url, "https://api.example.com/v1/chat", "URL 不脱敏");
  } finally {
    restoreHome(originalHome, originalUserProfile);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// TC-RS-003：嵌套对象与数组中的敏感字段递归脱敏
test("TC-RS-003: 嵌套对象与数组中的敏感字段递归脱敏", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const { home } = setupTempHome("redact-nested");
  try {
    logOpenAIChatCompletionDebug({
      timestamp: "2026-01-01T00:00:00.000Z",
      location: "test.redact.nested",
      requestId: "redact-req-3",
      request: {
        model: "test-model",
        config: {
          nested: {
            clientSecret: "deep-nested-secret",
            safe: "保留我",
          },
        },
        providers: [
          { name: "a", apiToken: "token-in-array" },
          { name: "b", safe: 1 },
        ],
      },
    });

    const raw = fs.readFileSync(getDebugLogPath(), "utf8");
    const parsed = JSON.parse(raw.trim()) as Record<string, any>;
    assert.equal(parsed.request.config.nested.clientSecret, "[REDACTED]", "嵌套 secret 应脱敏");
    assert.equal(parsed.request.config.nested.safe, "保留我", "嵌套非敏感字段保留");
    assert.equal(parsed.request.providers[0].apiToken, "[REDACTED]", "数组元素内 token 应脱敏");
    assert.equal(parsed.request.providers[1].safe, 1, "数组元素内非敏感字段保留");
    assert.ok(!raw.includes("deep-nested-secret"), "日志不得包含嵌套密钥");
    assert.ok(!raw.includes("token-in-array"), "日志不得包含数组内密钥");
  } finally {
    restoreHome(originalHome, originalUserProfile);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
