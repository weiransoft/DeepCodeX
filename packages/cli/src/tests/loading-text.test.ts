import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
// 修复"存活指示器"2026-10-03：thinkingSpinnerFrame 与 buildLoadingText 共用
// 同一 now 推导期望帧，避免断言硬编码点字导致时间漂移 flaky
import { buildLoadingText, thinkingSpinnerFrame } from "../ui";

/** 按给定 now 生成 spinner 前缀（"帧 + 空格"），供各用例拼装期望文案 */
const spin = (now: number): string => `${thinkingSpinnerFrame(now)} `;

test("buildLoadingText returns spinner-prefixed 思考中... when no progress", () => {
  const now = Date.now();
  assert.equal(buildLoadingText({ progress: null, now }), `${spin(now)}思考中...`);
});

test("thinking spinner frame advances every 120ms and cycles through 10 frames", () => {
  // 存活指示器的核心契约：now 每 +120ms 帧前进一格，+1200ms 回到起点（整循环）
  const base = Date.parse("2026-04-28T00:00:00.000Z");
  const frame0 = thinkingSpinnerFrame(base);
  const frame1 = thinkingSpinnerFrame(base + 120);
  assert.notEqual(frame0, frame1, "相邻帧必须不同，否则终端看不到旋转（存活假象）");
  assert.equal(thinkingSpinnerFrame(base + 1200), frame0, "10 帧 × 120ms = 1200ms 整循环");
  // 帧序列内所有字形互不相同（10 帧全覆盖）
  const frames = new Set(Array.from({ length: 10 }, (_, i) => thinkingSpinnerFrame(base + i * 120)));
  assert.equal(frames.size, 10);
});

test("buildLoadingText shows reconnect attempt before stream progress", () => {
  const now = Date.now();
  assert.equal(
    buildLoadingText({
      progress: null,
      retry: {
        requestId: "request-1",
        error: "HTTP 502: Bad Gateway",
        attempt: 2,
        maxRetries: 5,
        delayMs: 1600,
      },
      now,
    }),
    `${spin(now)}Reconnecting... 2/5 (esc to interrupt)`
  );
});

test("buildLoadingText shows running process elapsed time before thinking progress", () => {
  const startedAt = "2026-04-28T00:00:00.000Z";
  const now = Date.parse(startedAt) + 5_750;
  const processes = new Map([["123", { startTime: startedAt, command: "yarn install" }]]);
  const text = buildLoadingText({
    processes,
    progress: {
      requestId: "r",
      startedAt,
      estimatedTokens: 850,
      formattedTokens: "850",
      phase: "update",
    },
    now,
  });
  assert.equal(text, `${spin(now)}(5s) yarn install`);
});

test("buildLoadingText formats long-running process time with minutes", () => {
  const startedAt = "2026-04-28T00:00:00.000Z";
  const now = Date.parse(startedAt) + 65_250;
  const processes = new Map([["web-search", { startTime: startedAt, command: "WebSearch: latest node release" }]]);
  // 修复"工具调用卡死"2026-10-03：≥60s 加卡顿提示后缀（阶梯详见 loading-text.ts buildRunningProcessHint）
  assert.equal(
    buildLoadingText({ processes, progress: null, now }),
    `${spin(now)}(1m5s) WebSearch: latest node release · 已卡住？Ctrl+C 中断 + 改用 run_in_background:true`
  );
});

test("buildLoadingText adds 10s slow hint suffix for processes running over 10s", () => {
  const startedAt = "2026-04-28T00:00:00.000Z";
  const now = Date.parse(startedAt) + 15_000;
  const processes = new Map([["123", { startTime: startedAt, command: "git fetch" }]]);
  assert.equal(
    buildLoadingText({ processes, progress: null, now }),
    `${spin(now)}(15s) git fetch · 运行中，可 Ctrl+C 中断`
  );
});

test("buildLoadingText adds 30s very-slow hint suffix for processes running over 30s", () => {
  const startedAt = "2026-04-28T00:00:00.000Z";
  const now = Date.parse(startedAt) + 45_000;
  const processes = new Map([["123", { startTime: startedAt, command: "pip install torch" }]]);
  assert.equal(
    buildLoadingText({ processes, progress: null, now }),
    `${spin(now)}(45s) pip install torch · 较慢，建议走 run_in_background`
  );
});

test("buildLoadingText does not add hint suffix for processes under 10s", () => {
  const startedAt = "2026-04-28T00:00:00.000Z";
  const now = Date.parse(startedAt) + 5_000;
  const processes = new Map([["123", { startTime: startedAt, command: "ls -la" }]]);
  assert.equal(buildLoadingText({ processes, progress: null, now }), `${spin(now)}(5s) ls -la`);
});

test("buildLoadingText returns plain 思考中... while elapsed below 3s", () => {
  const startedAt = "2026-04-28T00:00:00.000Z";
  const now = Date.parse(startedAt) + 1500;
  const text = buildLoadingText({
    progress: {
      requestId: "r",
      startedAt,
      estimatedTokens: 12,
      formattedTokens: "12",
      phase: "update",
    },
    now,
  });
  assert.equal(text, `${spin(now)}思考中...`);
});

test("buildLoadingText shows elapsed seconds and tokens once past the threshold", () => {
  const startedAt = "2026-04-28T00:00:00.000Z";
  const now = Date.parse(startedAt) + 5_750;
  const text = buildLoadingText({
    progress: {
      requestId: "r",
      startedAt,
      estimatedTokens: 850,
      formattedTokens: "850",
      phase: "update",
    },
    now,
  });
  assert.equal(text, `${spin(now)}思考中... (5s) · ↓ 850 tokens`);
});

test("buildLoadingText formats tokens with thousands separator", () => {
  const startedAt = "2026-04-28T00:00:00.000Z";
  const now = Date.parse(startedAt) + 4_000;
  const text = buildLoadingText({
    progress: {
      requestId: "r",
      startedAt,
      estimatedTokens: 1_234_567,
      formattedTokens: "1234567",
      phase: "update",
    },
    now,
  });
  assert.equal(text, `${spin(now)}思考中... (4s) · ↓ 1,234,567 tokens`);
});

test("buildLoadingText falls back to '0' when formattedTokens is missing", () => {
  const startedAt = "2026-04-28T00:00:00.000Z";
  const now = Date.parse(startedAt) + 4_000;
  const text = buildLoadingText({
    progress: {
      requestId: "r",
      startedAt,
      estimatedTokens: 0,
      formattedTokens: "",
      phase: "update",
    },
    now,
  });
  assert.equal(text, `${spin(now)}思考中... (4s) · ↓ 0 tokens`);
});

test("buildLoadingText falls back to 思考中... when timestamp is unparseable", () => {
  const now = Date.now();
  const text = buildLoadingText({
    progress: {
      requestId: "r",
      startedAt: "not-a-date",
      estimatedTokens: 0,
      formattedTokens: "0",
      phase: "update",
    },
    now,
  });
  assert.equal(text, `${spin(now)}思考中...`);
});

const previewProgress = {
  requestId: "preview",
  startedAt: "2026-04-28T00:00:00.000Z",
  estimatedTokens: 1501,
  formattedTokens: "1.5k",
  phase: "update" as const,
  previewText: "latest text",
};
const previewNow = Date.parse(previewProgress.startedAt) + 5000;
// fork 中文化：loading 状态文案为"思考中..."（与上方非 preview 用例一致）；
// formattedTokens 传 "1.5k" 紧凑格式时由 formatTokens 原样透传
const previewStatus = `${spin(previewNow)}思考中... (5s) · ↓ 1.5k tokens`;

test("loading preview requires more than 1500 tokens and preserves status priority", () => {
  const input = { progress: previewProgress, now: previewNow, screenWidth: 100 };
  assert.equal(buildLoadingText(input), `${previewStatus} [latest text]`);
  assert.equal(buildLoadingText({ ...input, progress: { ...previewProgress, estimatedTokens: 1500 } }), previewStatus);
  assert.equal(buildLoadingText({ ...input, progress: { ...previewProgress, previewText: "" } }), previewStatus);
  const shortNow = previewNow - 4000;
  assert.equal(buildLoadingText({ ...input, now: shortNow }), `${spin(shortNow)}思考中...`);
  assert.equal(
    buildLoadingText({
      ...input,
      processes: new Map([["p", { startTime: previewProgress.startedAt, command: "cmd" }]]),
    }),
    `${spin(previewNow)}(5s) cmd`
  );
  assert.equal(
    buildLoadingText({ ...input, retry: { requestId: "r", error: "err", attempt: 1, maxRetries: 5, delayMs: 800 } }),
    `${spin(previewNow)}Reconnecting... 1/5 (esc to interrupt)`
  );
});

test("loading preview keeps the newest complete graphemes within the reserved boundary", () => {
  const previewText = "old ".repeat(100) + "中文👨‍👩‍👧‍👦é";
  for (const screenWidth of [35, 60, 70, 80, 100, 200]) {
    const text = buildLoadingText({ progress: { ...previewProgress, previewText }, now: previewNow, screenWidth });
    if (text !== previewStatus) {
      assert.ok(stringWidth(text) <= screenWidth - 28);
      assert.ok(text.startsWith(`${previewStatus} [...`));
      assert.ok(text.endsWith("é]"));
      const tail = text.slice(previewStatus.length + 5, -1);
      assert.ok(previewText.endsWith(tail));
      assert.ok(!tail.startsWith("\u200d"));
    }
  }
  assert.equal(buildLoadingText({ progress: previewProgress, now: previewNow, screenWidth: 40 }), previewStatus);
});

test("loading preview hides below 80 columns and returns when the terminal grows", () => {
  const input = { progress: previewProgress, now: previewNow };
  for (const screenWidth of [40, 60, 70, 79, 0]) {
    assert.equal(buildLoadingText({ ...input, screenWidth }), previewStatus);
  }
  assert.equal(buildLoadingText(input), previewStatus);
  for (const screenWidth of [80, 100, 160]) {
    assert.equal(buildLoadingText({ ...input, screenWidth }), `${previewStatus} [latest text]`);
  }
});

// ===== 思考尾行渲染（修复"thinking 期状态行零进展"2026-10-03） =====

/** 思考期典型进度：token 未过 1500 门槛、正文 previewText 为空、thinkingText 持续累积 */
const thinkingProgress = {
  requestId: "thinking",
  startedAt: "2026-04-28T00:00:00.000Z",
  estimatedTokens: 700,
  formattedTokens: "0.7k",
  phase: "update" as const,
  thinkingText: "先检查 package.json 的依赖，\n再分析 deploy 目录结构是否完整",
};
const thinkingNow = Date.parse(thinkingProgress.startedAt) + 120_000;
const thinkingStatus = `${spin(thinkingNow)}思考中... (120s) · ↓ 0.7k tokens`;

test("thinking tail renders when content preview is absent (long thinking phase not looking stalled)", () => {
  const text = buildLoadingText({ progress: thinkingProgress, now: thinkingNow, screenWidth: 120 });
  // 尾行必须带"思考"标记，且换行折叠为单空格（状态行始终单行）
  assert.equal(text, `${thinkingStatus} · 思考 先检查 package.json 的依赖， 再分析 deploy 目录结构是否完整`);
  assert.ok(!text.includes("\n"), "状态行绝不允许含换行");
});

test("thinking tail renders below 1500-token preview gate but not below 50 columns", () => {
  // 50~79 列：正文 preview 门槛不满足，但思考尾行仍渲染（thinking 本身就是进度信号）；
  // 70 列下状态行 + "· 思考" 前缀只剩约 16 列 → 保留最新尾段并前置省略号
  assert.equal(
    buildLoadingText({ progress: thinkingProgress, now: thinkingNow, screenWidth: 70 }),
    `${thinkingStatus} · 思考 …析 deploy 目录结构是否完整`
  );
  // <50 列：状态行前缀已近满宽，尾行只能换行 → 不渲染
  assert.equal(buildLoadingText({ progress: thinkingProgress, now: thinkingNow, screenWidth: 40 }), thinkingStatus);
  // screenWidth 未提供（undefined → 0）：宽度未知时保守不渲染尾行（与正文 preview 同策略）
  assert.equal(buildLoadingText({ progress: thinkingProgress, now: thinkingNow }), thinkingStatus);
});

test("content preview keeps priority over thinking tail", () => {
  // 正文 preview 满足原门槛（>1500 token 且终端 ≥80 列）→ 走原 preview 分支，零回归
  const both = { ...previewProgress, thinkingText: "some reasoning text here" };
  assert.equal(
    buildLoadingText({ progress: both, now: previewNow, screenWidth: 120 }),
    `${previewStatus} [latest text]`
  );
});

test("thinking tail truncates 1MB-scale reasoning to bounded single line", () => {
  const huge = `reasoning ${"x ".repeat(200_000)}conclusion`;
  const text = buildLoadingText({
    progress: { ...thinkingProgress, thinkingText: huge },
    now: thinkingNow,
    screenWidth: 120,
  });
  assert.ok(stringWidth(text) <= 120, `状态行必须不超终端宽度，实际 ${stringWidth(text)}`);
  assert.ok(!text.includes("\n"));
  // 保留的是最新（尾部）内容——"conclusion" 必须可见，开头的旧推理被裁掉
  assert.ok(text.endsWith("conclusion"), "尾行必须保留最新思考片段");
  // 旧推理最多只剩尾行预算内的若干组（"x x x" 出现次数必须远小于原始 20 万组），
  // 且整行仍受终端宽度约束（上方 stringWidth ≤120 断言已兜底）
  const xGroups = (text.match(/x /g) ?? []).length;
  assert.ok(xGroups <= 40, `旧推理必须被折叠到尾行预算内，实际残留 ${xGroups} 组`);
});

test("blank or whitespace-only thinkingText falls back to plain status line", () => {
  const status = (thinkingText: string) =>
    buildLoadingText({ progress: { ...thinkingProgress, thinkingText }, now: thinkingNow, screenWidth: 120 });
  assert.equal(status(""), thinkingStatus);
  assert.equal(status("   \n\n  \t "), thinkingStatus);
  assert.equal(status("嗯"), thinkingStatus);
});
