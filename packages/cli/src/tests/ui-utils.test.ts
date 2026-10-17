import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry, SessionMessage } from "@vegamo/deepcode-core";
import {
  buildPromptHistory,
  buildStatusLine,
  formatContextUsage,
  formatTokenCount,
  formatTimestampInTimezone,
} from "../ui/utils/index";

// 需求122：配置时区时间格式化——缺省东八区北京时间，可传任意合法 IANA 时区
test("formatTimestampInTimezone default formats UTC instant as Beijing wall clock", () => {
  // 2026-01-01T00:00:00Z = 北京时间 2026-01-01 08:00:00（UTC+8）
  const formatted = formatTimestampInTimezone("2026-01-01T00:00:00.000Z");
  assert.match(formatted, /2026/);
  assert.match(formatted, /01/);
  assert.match(formatted, /08:00:00/, "缺省时区（东八区）：UTC 0 点必须换算为北京时间 8 点");
});

test("formatTimestampInTimezone crosses day boundary correctly", () => {
  // 2025-12-31T17:00:00Z = 北京时间 2026-01-01 01:00:00
  const formatted = formatTimestampInTimezone("2025-12-31T17:00:00.000Z");
  assert.match(formatted, /2026/);
  assert.match(formatted, /01:00:00/);
});

test("formatTimestampInTimezone honors explicit timezone (UTC / New York)", () => {
  // 同一时刻在不同时区的墙钟时间必须不同（证明时区参数生效，非写死东八区）
  const utc = formatTimestampInTimezone("2026-06-15T12:00:00.000Z", "UTC");
  assert.match(utc, /12:00:00/, "UTC 时区展示必须等于 UTC 墙钟时间");
  // 夏令时期间 America/New_York = UTC-4 → 08:00
  const ny = formatTimestampInTimezone("2026-06-15T12:00:00.000Z", "America/New_York");
  assert.match(ny, /08:00:00/, "纽约（EDT, UTC-4）墙钟时间必须为 08:00");
});

test("formatTimestampInTimezone invalid timezone falls back to Beijing default", () => {
  // 非法时区名（Intl 不接受）回落东八区默认值，行为与缺省一致
  const formatted = formatTimestampInTimezone("2026-01-01T00:00:00.000Z", "Not/AZone");
  assert.match(formatted, /08:00:00/, "非法时区必须回落东八区（北京时间 8 点）");
  // 空串/纯空白同样回落默认
  assert.match(formatTimestampInTimezone("2026-01-01T00:00:00.000Z", "  "), /08:00:00/);
});

test("formatTimestampInTimezone returns invalid input unchanged (defensive)", () => {
  assert.equal(formatTimestampInTimezone("not-a-date"), "not-a-date");
  assert.equal(formatTimestampInTimezone(""), "");
});

test("buildPromptHistory includes only visible non-empty user messages", () => {
  const messages = [
    buildMessage("user", " first prompt ", true),
    buildMessage("user", "internal image follow-up", false),
    buildMessage("system", "system prompt", false),
    buildMessage("assistant", "assistant reply", true),
    buildMessage("user", "   ", true),
    buildMessage("user", "second prompt", true),
  ];

  assert.deepEqual(buildPromptHistory(messages), ["first prompt", "second prompt"]);
});

test("formatTokenCount uses binary K/M units with at most one decimal", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(1023), "1023");
  assert.equal(formatTokenCount(1126), "1.1K");
  assert.equal(formatTokenCount(1024 * 1024), "1M");
  assert.equal(formatTokenCount(1.25 * 1024 * 1024), "1.3M");
});

test("formatContextUsage rounds a ten-cell bar to whole blocks", () => {
  assert.equal(formatContextUsage(0, 1000), "0/1000 [░░░░░░░░░░] 0%");
  assert.equal(formatContextUsage(20, 1000), "20/1000 [░░░░░░░░░░] 2%");
  assert.equal(formatContextUsage(200, 1000), "200/1000 [▓▓░░░░░░░░] 20%");
  assert.equal(formatContextUsage(550, 1000), "550/1000 [▓▓▓▓▓▓░░░░] 55%");
});

test("formatContextUsage caps the bar and percentage at 100 percent", () => {
  assert.equal(formatContextUsage(1200, 1000), "1.2K/1000 [▓▓▓▓▓▓▓▓▓▓] 100%");
});

test("buildStatusLine replaces the tokens label while preserving status and failure", () => {
  const entry: SessionEntry = {
    id: "session-1",
    summary: null,
    assistantReply: null,
    assistantThinking: null,
    assistantRefusal: null,
    toolCalls: null,
    status: "failed",
    failReason: "boom",
    usage: null,
    usagePerModel: null,
    activeTokens: 20,
    createTime: "2026-01-01T00:00:00.000Z",
    updateTime: "2026-01-01T00:00:01.000Z",
    processes: null,
  };

  assert.equal(
    buildStatusLine(entry, {
      contextWindow: 1000,
      model: "deepseek-v4-flash",
      thinkingEnabled: true,
      reasoningEffort: "max",
    }),
    "status: failed · 20/1000 [░░░░░░░░░░] 2% · deepseek-v4-flash max · fail: boom"
  );
});

test("buildStatusLine omits context usage and reasoning effort when thinking is disabled", () => {
  const entry = {
    status: "pending",
    activeTokens: 0,
    failReason: null,
  } as SessionEntry;

  assert.equal(
    buildStatusLine(entry, {
      contextWindow: 1024 * 1024,
      model: "deepseek-v4-flash",
      thinkingEnabled: false,
      reasoningEffort: "max",
    }),
    "status: pending · deepseek-v4-flash"
  );
});

test("buildStatusLine omits an empty model", () => {
  const entry = {
    status: "pending",
    activeTokens: 0,
    failReason: null,
  } as SessionEntry;

  assert.equal(
    buildStatusLine(entry, {
      contextWindow: 1024 * 1024,
      model: "  ",
      thinkingEnabled: true,
      reasoningEffort: "max",
    }),
    "status: pending"
  );
});

function buildMessage(role: SessionMessage["role"], content: string, visible: boolean): SessionMessage {
  return {
    id: `${role}-${content}`,
    sessionId: "session-1",
    role,
    content,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible,
    createTime: "2026-01-01T00:00:00.000Z",
    updateTime: "2026-01-01T00:00:00.000Z",
  };
}

test("buildStatusLine appends plus only for the selected PLUS connection", () => {
  for (const usingPlus of [undefined, false, true]) {
    for (const thinkingEnabled of [false, true]) {
      const entry = { status: "completed", activeTokens: 0, failReason: null, usingPlus } as SessionEntry;
      assert.equal(
        buildStatusLine(entry, {
          model: "deepseek-flash",
          thinkingEnabled,
          reasoningEffort: "max",
          contextWindow: 1024 * 1024,
        }),
        `status: completed · deepseek-flash${thinkingEnabled ? " max" : ""}${usingPlus ? " plus" : ""}`
      );
    }
  }
});
