import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logApiError, getErrorLogPath, type ApiErrorLogEntry } from "../common/error-logger";

/**
 * 默认日志轮转大小阈值（10MB），与 log-rotation.ts 中 DEFAULT_MAX_LOG_SIZE_BYTES 保持一致。
 * 用于 TC-EL-002 / TC-EL-003 预填充超过阈值的旧内容以触发轮转。
 */
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * 切换 process.env.HOME 到 os.tmpdir() 下的临时目录，实现测试隔离。
 *
 * 参照 debug-logger.test.ts:9-15 的模式：
 * - macOS/Linux 下 os.homedir() 读取 $HOME 环境变量
 * - Windows 下还需切换 USERPROFILE
 * - finally 块恢复原始环境变量，避免污染其他测试
 *
 * @param fn 在隔离 HOME 环境下执行的回调，接收临时 HOME 路径
 * @returns fn 的返回值
 */
function withIsolatedHome<T>(fn: (home: string) => T): T {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-error-log-home-"));
  process.env.HOME = home;
  if (process.platform === "win32") {
    process.env.USERPROFILE = home;
  }
  try {
    return fn(home);
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
}

/**
 * 构建一个最小的 ApiErrorLogEntry 用于测试。
 * 各字段均可通过 overrides 覆盖，便于不同测试用例定制。
 *
 * @param overrides 覆盖默认值的字段
 * @returns 完整的 ApiErrorLogEntry
 */
function makeEntry(overrides: Partial<ApiErrorLogEntry> = {}): ApiErrorLogEntry {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    location: "test.location",
    requestId: "request-1",
    error: {
      name: "TestError",
      message: "test error message",
    },
    request: {},
    ...overrides,
  };
}

/**
 * 读取 error.log 并按行解析为 JSON 对象数组。
 * 假定每行是一个独立的 JSON 对象（NDJSON 格式）。
 */
function readErrorLog(): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(getErrorLogPath(), "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * 预填充超过 10MB 的旧内容到指定日志文件，用于触发轮转。
 * 每行是一个含 marker 字段的 JSON 对象，便于后续断言验证旧内容去向。
 *
 * @param logPath 日志文件路径
 * @param marker 旧内容标记字符串
 * @param minBytes 最小字节数（默认 10MB + 1KB）
 */
function prefillOversizedLog(logPath: string, marker: string, minBytes: number = MAX_LOG_SIZE_BYTES + 1024): void {
  // 构造单行内容（含 marker 字段的 JSON 对象 + 换行符）
  const line = Buffer.from(JSON.stringify({ timestamp: "2025-01-01T00:00:00.000Z", marker }) + "\n", "utf8");
  const lineCount = Math.ceil(minBytes / line.length) + 1;
  // 使用 Buffer.concat 一次性构造，避免字符串拼接的 O(n²) 性能问题
  const buffers: Buffer[] = new Array(lineCount);
  for (let i = 0; i < lineCount; i += 1) {
    buffers[i] = line;
  }
  fs.writeFileSync(logPath, Buffer.concat(buffers));
}

// ============================================================================
// D-2 修复回归测试：error-logger 接入 rotateLogIfNeeded，删除 MAX_ENTRIES=20 反模式
// 源码位置：error-logger.ts:92-123
// 关键点：
//   1. 写入前调用 rotateLogIfNeeded（内层 try/catch 容错）
//   2. 使用 appendFileSync 追加，不再"读全文 + slice + 重写"
//   3. 外层 try/catch 兜底所有错误，不抛错
// ============================================================================

// TC-EL-001：error.log 写入后不再触发"读全文 + 重写"
// 验证 D-2 性能回归：单次写入只 append 不重写，文件大小合理
test("TC-EL-001: logApiError appends single entry without read-all-and-rewrite", () => {
  withIsolatedHome(() => {
    // 写入 1 条日志
    logApiError(makeEntry({ requestId: "single-1" }));

    const logPath = getErrorLogPath();
    // 断言文件存在
    assert.ok(fs.existsSync(logPath), "error.log should exist after logApiError");

    // 断言只有 1 行（旧 MAX_ENTRIES=20 逻辑在首次写入时也是 1 行，此处验证基本 append 行为）
    const raw = fs.readFileSync(logPath, "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 1, "error.log should contain exactly 1 line");

    // 断言文件大小小于 10MB（追加而非重写，单条远小于阈值）
    const stats = fs.statSync(logPath);
    assert.ok(stats.size < MAX_LOG_SIZE_BYTES, "error.log size should be less than 10MB");

    // 断言内容正确
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(entry.requestId, "single-1");
  });
});

// TC-EL-002：error.log 超过 10MB 时触发轮转
// 验证 D-2 集成：rotateLogIfNeeded 正确接入，旧内容滚动到 .log.1，新内容写入新文件
test("TC-EL-002: error.log rotates when exceeding 10MB", () => {
  withIsolatedHome(() => {
    const logPath = getErrorLogPath();
    const logDir = path.dirname(logPath);
    fs.mkdirSync(logDir, { recursive: true });

    // 预填充 10MB+1KB 内容到 error.log（标记旧内容）
    const oldMarker = "OLD_CONTENT_MARKER";
    prefillOversizedLog(logPath, oldMarker);

    // 调用 logApiError 写入新条目（应触发轮转）
    logApiError(makeEntry({ requestId: "new-after-rotation" }));

    const backupPath = `${logPath}.1`;
    // 断言 error.log.1 存在且为旧内容
    assert.ok(fs.existsSync(backupPath), "error.log.1 should exist after rotation");
    const backupContent = fs.readFileSync(backupPath, "utf8");
    assert.ok(backupContent.includes(oldMarker), "error.log.1 should contain old content with marker");

    // 断言 error.log 只有 1 行新内容（轮转后新文件只含本次写入）
    const newRaw = fs.readFileSync(logPath, "utf8");
    const newLines = newRaw.trim().split("\n");
    assert.equal(newLines.length, 1, "error.log should contain only 1 line after rotation");
    const newEntry = JSON.parse(newLines[0]) as Record<string, unknown>;
    assert.equal(newEntry.requestId, "new-after-rotation");
  });
});

// TC-EL-003：error.log 轮转失败时仍写入日志（容错）
// 验证 D-2 容错：rotateLogIfNeeded 失败被内层 catch 吞掉，外层 try/catch 兜底，不抛错
//
// 实现要点：macOS/Linux 下创建只读目录（chmod 0444）模拟权限不足，
// 导致 rename 失败抛错。logApiError 应被外层 try/catch 吞掉，不向上抛出。
test("TC-EL-003: logApiError does not throw when rotation fails", () => {
  // 跳过 Windows：chmod 0444 在 Windows 下行为不同，无法模拟权限不足
  if (process.platform === "win32") {
    return;
  }
  // 跳过 root 用户：root 绕过 Unix 权限检查，chmod 0444 不生效
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return;
  }

  withIsolatedHome(() => {
    const logPath = getErrorLogPath();
    const logDir = path.dirname(logPath);
    fs.mkdirSync(logDir, { recursive: true });

    // 预填充超过 10MB 的内容以触发轮转（轮转时 rename 会因目录只读而失败）
    prefillOversizedLog(logPath, "OLD_BEFORE_READONLY");

    // 将日志目录设为只读，模拟权限不足导致 rename 失败
    fs.chmodSync(logDir, 0o444);

    try {
      // 调用 logApiError 不应抛错（rotateLogIfNeeded 失败被内层 catch，
      // appendFileSync 失败被外层 catch）
      assert.doesNotThrow(() => {
        logApiError(makeEntry({ requestId: "rotation-failure" }));
      });
    } finally {
      // 恢复目录权限以便 finally 块清理和后续测试
      fs.chmodSync(logDir, 0o755);
    }
  });
});

// TC-EL-004：连续写入 25 条不再被 slice 到 20 条
// 验证 D-2 回归：删除 MAX_ENTRIES=20 截断逻辑后，所有条目都保留
// 这是验证 D-2 修复有效性的核心测试
test("TC-EL-004: 25 consecutive entries are not truncated to 20", () => {
  withIsolatedHome(() => {
    // 连续调用 25 次 logApiError
    for (let i = 0; i < 25; i += 1) {
      logApiError(makeEntry({ requestId: `request-${i}` }));
    }

    // 断言 error.log 有 25 行（旧 MAX_ENTRIES=20 逻辑会截断到 20 条）
    const entries = readErrorLog();
    assert.equal(entries.length, 25, "error.log should contain all 25 entries without truncation");

    // 断言首尾条目正确，确认无丢失
    assert.equal(entries[0].requestId, "request-0", "first entry should be request-0");
    assert.equal(entries[24].requestId, "request-24", "last entry should be request-24");
  });
});

// TC-EL-005：error.log 内容含 sanitize 后的 request payload
// 验证现有功能回归：request.content 长字符串被截断到 100 字符前缀 + "...(total N chars)"
// 源码位置：error-logger.ts:38-43 truncateContent, error-logger.ts:50-75 sanitizeRequestPayload
test("TC-EL-005: request content is sanitized with truncation", () => {
  withIsolatedHome(() => {
    const longContent = "x".repeat(200);
    logApiError(
      makeEntry({
        requestId: "sanitize-test",
        request: { content: longContent },
      })
    );

    const entries = readErrorLog();
    assert.equal(entries.length, 1, "should have exactly 1 entry");
    const request = entries[0].request as Record<string, unknown>;
    const content = request.content as string;
    // 断言 content 被截断到 100 字符前缀 + "...(total 200 chars)"
    assert.equal(
      content,
      "x".repeat(100) + "...(total 200 chars)",
      "content should be truncated to 100-char prefix with total length suffix"
    );
    // 断言原始长字符串不再完整出现
    assert.ok(!content.includes("x".repeat(101)), "truncated content should not contain full 200 chars");
  });
});

// TC-EL-006：error.log 内容含 mask 后的 Authorization
// 验证现有功能回归：response 中的 Authorization Bearer token 被 mask
// 源码位置：error-logger.ts:21-29 maskSensitive, error-logger.ts:107-109 response 处理
test("TC-EL-006: Authorization header in response is masked", () => {
  withIsolatedHome(() => {
    const secretToken = "sk-abc123xyz";
    const rawResponse = `Authorization: Bearer ${secretToken}`;
    logApiError(
      makeEntry({
        requestId: "mask-test",
        response: rawResponse,
      })
    );

    const entries = readErrorLog();
    assert.equal(entries.length, 1, "should have exactly 1 entry");
    const response = entries[0].response as string;
    // 断言含 "***MASKED***"（maskSensitive 正则替换结果）
    assert.ok(response.includes("***MASKED***"), "response should contain ***MASKED*** after masking");
    // 断言不含原始 token（防止凭证泄露）
    assert.ok(!response.includes(secretToken), "response should not contain raw token");
  });
});
