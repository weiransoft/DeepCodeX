/**
 * RelevanceScorer + SlidingWindowManager 单元测试（F-FOCUS-02 + V2-P2 升级）
 *
 * 测试覆盖：
 * - RS-01: 直达距离评分（d=0 → 1.0）
 * - RS-02: 一跳距离评分（d=1 → 0.7）
 * - RS-03: 两跳距离评分（d=2 → 0.4）
 * - RS-04: 三跳距离评分（d=3 → 0.1）
 * - RS-05: 不可达距离评分（在图中但 BFS 到不了 → 0.05）
 * - RS-06: 图未含距离评分（新文件/未扫描 → 0.1）
 * - RS-07: 关键词匹配评分（Jaccard 相似度）
 * - RS-08: 时间衰减评分（半衰期 30 分钟）
 * - RS-09: scoreBatch Top-K 排序
 * - RS-10: 总评分加权求和正确性
 * - SW-01: Top-K 相关文件保留
 * - SW-02: 最近 N 轮对话保留
 * - SW-03: Token 预算截断（V2-P2：超预算压缩而非丢弃，断言改为 compressedSnippets）
 * - SW-04: 超预算从低分端丢弃（V2-P2：低分端压缩为摘要）
 * - SW-05: 空候选窗口
 * - SW-06: 单文件窗口
 * - SW-07: compressionRatio 正确性
 * - SW-08: 保留文件路径列表正确性
 * - SW-09: 保留对话轮数正确性
 * - SW-10: 文件片段携带 relevance 评分
 * - SW-COMPRESS-01: 超预算片段被压缩为摘要（V2-P2 新增）
 * - SW-COMPRESS-02: 压缩后 Token 下降且 compressionRatio < 1.0（V2-P2 新增）
 * - SW-COMPRESS-03: getBudgetAllocation 三层预算分配正确（V2-P2 新增）
 * - SW-ASYNC-01: buildWindow 返回 Promise（V2-P2 新增）
 *
 * V2-P2 升级点：
 * - SlidingWindowManager 构造函数从 2 参数升级为 4 参数（+progressiveLoader +summarizer）
 * - buildWindow 从同步方法升级为 async 方法（compressOldSnippets 需异步调用 ContentSummarizer）
 * - SW-03/SW-04 断言适配：V2-P2 超预算片段压缩为摘要而非丢弃，droppedCount 语义变化
 *
 * 所有测试使用真实数据构造 CodeMap + 真实 RuleBasedSummarizer（非 mock），禁止 mock。
 *
 * @module v2/tests/context/sliding-window.test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RelevanceScorer } from "../../context/relevance-scorer";
import type { RelevanceScoreInput } from "../../context/relevance-scorer";
import { SlidingWindowManager } from "../../context/sliding-window";
import type { SlidingWindowConfig } from "../../context/sliding-window";
import type { TaskContext, FocusPoint } from "../../context/types";
import type { CodeMap, FileInfo } from "../../codemap/generator";
import type { ContextSnippet } from "../../integration/session-hook";
// V2-P2 新增导入：ProgressiveContextLoader + RuleBasedSummarizer（真实实现，非 mock）
import { ProgressiveContextLoader } from "../../context/progressive-loader";
import { RuleBasedSummarizer } from "../../memory/rule-based-summarizer";

// ============================================================================
// 辅助工厂
// ============================================================================

/**
 * 创建测试用文件信息（含 dependencies）
 *
 * @param path 文件路径
 * @param dependencies 依赖列表
 * @returns FileInfo
 */
function createFileInfo(path: string, dependencies: string[] = []): FileInfo {
  return {
    path,
    language: "typescript",
    classes: [],
    functions: [],
    imports: [],
    exports: [],
    lines: 10,
    parseStatus: "ok",
    dependencies,
  };
}

/**
 * 创建测试用 CodeMap
 *
 * @param files 文件列表（含 dependencies）
 * @returns CodeMap
 */
function createCodeMap(files: FileInfo[]): CodeMap {
  return {
    project: {
      name: "test-project",
      root: "/test",
      techStack: { frameworks: [], buildTools: [], packageManagers: [], testFrameworks: [], linters: [] },
      architecture: "unknown",
      languages: ["typescript"],
    },
    modules: [],
    files,
    callGraph: [],
    dependencyGraph: files.flatMap((f) =>
      f.dependencies.map((dep) => ({ source: f.path, target: dep, type: "import" as const, resolved: true }))
    ),
    cycles: [],
    generatedAt: new Date().toISOString(),
    stats: {
      totalFiles: files.length,
      parsedFiles: files.length,
      failedFiles: 0,
      totalClasses: 0,
      totalFunctions: 0,
      totalDependencies: files.reduce((sum, f) => sum + f.dependencies.length, 0),
      cyclesDetected: 0,
      unresolvedDeps: 0,
      generationTimeMs: 0,
    },
  };
}

/**
 * 创建测试用关注点
 *
 * @param ref 引用标识
 * @param priority 优先级
 * @param addedAt 添加时间
 * @returns FocusPoint
 */
function createFileFocusPoint(ref: string, priority = 0.5, addedAt?: string): FocusPoint {
  return {
    type: "file",
    ref,
    priority,
    addedAt: addedAt ?? new Date().toISOString(),
  };
}

/**
 * 创建测试用 TaskContext
 *
 * @param focusPoints 关注点列表
 * @param description 任务描述
 * @param startedAt 任务开始时间
 * @returns TaskContext
 */
function createTaskContext(focusPoints: FocusPoint[] = [], description = "测试任务", startedAt?: string): TaskContext {
  const now = startedAt ?? new Date().toISOString();
  return {
    taskId: "task-test",
    taskDefinition: {
      description,
      goals: [],
      constraints: [],
      taskType: "test",
      expectedOutput: "",
    },
    taskState: {
      status: "in_progress",
      progress: 50,
      startedAt: now,
      currentStage: "测试中",
    },
    workingMemory: {
      focusPoints,
      temporaryData: {},
      pendingItems: [],
      thoughtHistory: [],
      intermediateResults: [],
      contextWindow: [],
    },
    skillContext: { activeSkills: [], loadedHistory: [] },
    version: 1,
  };
}

/**
 * 创建测试用上下文片段
 *
 * @param type 片段类型
 * @param content 内容
 * @param source 来源
 * @returns ContextSnippet
 */
function createSnippet(type: string, content: string, source: string): ContextSnippet {
  return { type, content, source };
}

/**
 * 创建测试用 SlidingWindowManager（V2-P2 4 参构造）
 *
 * V2-P2 升级：SlidingWindowManager 构造函数从 2 参升级为 4 参（+progressiveLoader +summarizer）。
 * 本工厂统一注入真实的 ProgressiveContextLoader + RuleBasedSummarizer（非 mock），
 * 减少测试样板代码并确保三层预算比例与 SlidingWindowConfig 对齐。
 *
 * @param config 滑动窗口配置（部分字段，缺省使用 SlidingWindowManager.DEFAULT_CONFIG）
 * @param scorer 相关性评分器（可选，默认 new RelevanceScorer()）
 * @returns 4 参构造的 SlidingWindowManager 实例
 */
function createSlidingWindow(
  config: Partial<SlidingWindowConfig> = {},
  scorer: RelevanceScorer = new RelevanceScorer()
): SlidingWindowManager {
  // V2-P2：4 参构造，注入真实 ProgressiveContextLoader（tokenBudget 与 SW 对齐，保证三层预算分配正确）
  const tokenBudget = config.tokenBudget ?? 100_000;
  const progressiveLoader = new ProgressiveContextLoader({
    tokenBudget,
    metadataBudgetRatio: config.metadataBudgetRatio ?? 0.1,
    instructionBudgetRatio: config.instructionBudgetRatio ?? 0.4,
    resourceBudgetRatio: config.resourceBudgetRatio ?? 0.5,
  });
  // V2-P2：注入真实 RuleBasedSummarizer（真实启发式算法，非 mock，CI 环境无 DEEPSEEK_API_KEY 时使用）
  const summarizer = new RuleBasedSummarizer();
  return new SlidingWindowManager(config, scorer, progressiveLoader, summarizer);
}

// ============================================================================
// RelevanceScorer 测试（RS-01 ~ RS-10）
// ============================================================================

// ============================================================
// RS-01: 直达距离评分（d=0 → 1.0）
// ============================================================

test("RS-01: 直达距离评分（候选文件本身是 focusPoint → 1.0）", () => {
  const scorer = new RelevanceScorer();
  const codeMap = createCodeMap([createFileInfo("src/auth.ts", ["src/utils.ts"]), createFileInfo("src/utils.ts")]);
  const task = createTaskContext([createFileFocusPoint("src/auth.ts")]);

  const score = scorer.score({
    filePath: "src/auth.ts",
    taskContext: task,
    codeMap,
    now: new Date().toISOString(),
  });

  assert.equal(score.codeMapDistanceScore, 1.0, "候选文件本身是 focusPoint → 距离分 1.0");
  assert.ok(score.reason.includes("距离=1.00"), "reason 应包含距离分 1.00");
});

// ============================================================
// RS-02: 一跳距离评分（d=1 → 0.7）
// ============================================================

test("RS-02: 一跳距离评分（直接 import 关系 → 0.7）", () => {
  const scorer = new RelevanceScorer();
  // auth.ts 依赖 utils.ts → auth.ts 到 utils.ts 是 1 跳
  const codeMap = createCodeMap([createFileInfo("src/auth.ts", ["src/utils.ts"]), createFileInfo("src/utils.ts")]);
  // focusPoint 是 auth.ts，候选是 utils.ts → 1 跳
  const task = createTaskContext([createFileFocusPoint("src/auth.ts")]);

  const score = scorer.score({
    filePath: "src/utils.ts",
    taskContext: task,
    codeMap,
    now: new Date().toISOString(),
  });

  assert.equal(score.codeMapDistanceScore, 0.7, "直接 import 关系 → 距离分 0.7");
});

// ============================================================
// RS-03: 两跳距离评分（d=2 → 0.4）
// ============================================================

test("RS-03: 两跳距离评分（间接依赖 → 0.4）", () => {
  const scorer = new RelevanceScorer();
  // a.ts → b.ts → c.ts → d.ts（链式依赖）
  const codeMap = createCodeMap([
    createFileInfo("src/a.ts", ["src/b.ts"]),
    createFileInfo("src/b.ts", ["src/c.ts"]),
    createFileInfo("src/c.ts"),
  ]);
  // focusPoint 是 a.ts，候选是 c.ts → 2 跳
  const task = createTaskContext([createFileFocusPoint("src/a.ts")]);

  const score = scorer.score({
    filePath: "src/c.ts",
    taskContext: task,
    codeMap,
    now: new Date().toISOString(),
  });

  assert.equal(score.codeMapDistanceScore, 0.4, "两跳距离 → 距离分 0.4");
});

// ============================================================
// RS-04: 三跳距离评分（d=3 → 0.1）
// ============================================================

test("RS-04: 三跳距离评分（三跳 → 0.1）", () => {
  const scorer = new RelevanceScorer();
  // a.ts → b.ts → c.ts → d.ts
  const codeMap = createCodeMap([
    createFileInfo("src/a.ts", ["src/b.ts"]),
    createFileInfo("src/b.ts", ["src/c.ts"]),
    createFileInfo("src/c.ts", ["src/d.ts"]),
    createFileInfo("src/d.ts"),
  ]);
  // focusPoint 是 a.ts，候选是 d.ts → 3 跳
  const task = createTaskContext([createFileFocusPoint("src/a.ts")]);

  const score = scorer.score({
    filePath: "src/d.ts",
    taskContext: task,
    codeMap,
    now: new Date().toISOString(),
  });

  assert.equal(score.codeMapDistanceScore, 0.1, "三跳距离 → 距离分 0.1");
});

// ============================================================
// RS-05: 不可达距离评分（在图中但 BFS 到不了 → 0.05）
// ============================================================

test("RS-05: 不可达距离评分（在图中但无路径 → 0.05）", () => {
  const scorer = new RelevanceScorer();
  // 两个独立组件：{a.ts → b.ts} 和 {c.ts → d.ts}
  const codeMap = createCodeMap([
    createFileInfo("src/a.ts", ["src/b.ts"]),
    createFileInfo("src/b.ts"),
    createFileInfo("src/c.ts", ["src/d.ts"]),
    createFileInfo("src/d.ts"),
  ]);
  // focusPoint 是 a.ts，候选是 c.ts（不可达）
  const task = createTaskContext([createFileFocusPoint("src/a.ts")]);

  const score = scorer.score({
    filePath: "src/c.ts",
    taskContext: task,
    codeMap,
    now: new Date().toISOString(),
  });

  assert.equal(score.codeMapDistanceScore, 0.05, "在图中但不可达 → 距离分 0.05");
});

// ============================================================
// RS-06: 图未含距离评分（新文件/未扫描 → 0.1）
// ============================================================

test("RS-06: 图未含距离评分（候选不在 codeMap.files 中 → 0.1）", () => {
  const scorer = new RelevanceScorer();
  const codeMap = createCodeMap([createFileInfo("src/a.ts", ["src/b.ts"]), createFileInfo("src/b.ts")]);
  // focusPoint 是 a.ts，候选是新文件 new.ts（不在图中）
  const task = createTaskContext([createFileFocusPoint("src/a.ts")]);

  const score = scorer.score({
    filePath: "src/new.ts",
    taskContext: task,
    codeMap,
    now: new Date().toISOString(),
  });

  assert.equal(score.codeMapDistanceScore, 0.1, "图未含 → 距离分 0.1");
});

// ============================================================
// RS-07: 关键词匹配评分（Jaccard 相似度）
// ============================================================

test("RS-07: 关键词匹配评分（Jaccard 相似度）", () => {
  const scorer = new RelevanceScorer();
  const codeMap = createCodeMap([createFileInfo("src/auth/login.ts")]);

  // 任务描述含 "auth" 和 "login"，文件路径含 "auth" 和 "login"
  // Jaccard = 交集/并集
  const task1 = createTaskContext([], "auth login");
  const score1 = scorer.score({
    filePath: "src/auth/login.ts",
    taskContext: task1,
    codeMap,
    now: new Date().toISOString(),
  });
  // tokenize("auth login") = ["auth", "login"]
  // tokenize("src/auth/login.ts") = ["src", "auth", "login", "ts"]（标点被分隔）
  // 交集 = {auth, login} = 2，并集 = {src, auth, login, ts} = 4
  // Jaccard = 2/4 = 0.5
  assert.ok(score1.keywordMatchScore > 0, "任务描述与文件路径有共同 token → 关键词分 > 0");
  assert.equal(score1.keywordMatchScore, 0.5, "Jaccard = 交集2/并集4 = 0.5");

  // 任务描述与文件路径无共同 token
  const task2 = createTaskContext([], "database migration");
  const score2 = scorer.score({
    filePath: "src/auth/login.ts",
    taskContext: task2,
    codeMap,
    now: new Date().toISOString(),
  });
  assert.equal(score2.keywordMatchScore, 0, "无共同 token → 关键词分 0");
});

// ============================================================
// RS-08: 时间衰减评分（半衰期 30 分钟）
// ============================================================

test("RS-08: 时间衰减评分（半衰期 30 分钟）", () => {
  // 自定义半衰期为 60 秒（便于测试）
  const scorer = new RelevanceScorer({ timeDecayHalfLifeMs: 60_000 });
  const codeMap = createCodeMap([createFileInfo("src/a.ts")]);

  // 文件在 focusPoints 中，addedAt 为 60 秒前 → score = 0.5^1 = 0.5
  const now = new Date();
  const addedAt = new Date(now.getTime() - 60_000).toISOString(); // 60 秒前
  const task1 = createTaskContext([createFileFocusPoint("src/a.ts", 0.5, addedAt)]);
  const score1 = scorer.score({
    filePath: "src/a.ts",
    taskContext: task1,
    codeMap,
    now: now.toISOString(),
  });
  assert.ok(Math.abs(score1.timeDecayScore - 0.5) < 0.01, "60 秒前访问，半衰期 60 秒 → 时间分 ≈ 0.5");

  // 文件不在 focusPoints 中，用 taskState.startedAt
  // startedAt 为 120 秒前 → score = 0.5^2 = 0.25
  const startedAt = new Date(now.getTime() - 120_000).toISOString();
  const task2 = createTaskContext([], "测试", startedAt);
  const score2 = scorer.score({
    filePath: "src/a.ts",
    taskContext: task2,
    codeMap,
    now: now.toISOString(),
  });
  assert.ok(Math.abs(score2.timeDecayScore - 0.25) < 0.01, "120 秒前任务开始，半衰期 60 秒 → 时间分 ≈ 0.25");
});

// ============================================================
// RS-09: scoreBatch Top-K 排序
// ============================================================

test("RS-09: scoreBatch Top-K 排序（按 totalScore 降序）", () => {
  const scorer = new RelevanceScorer();
  const codeMap = createCodeMap([
    createFileInfo("src/auth.ts", ["src/utils.ts"]),
    createFileInfo("src/utils.ts"),
    createFileInfo("src/unrelated.ts"),
  ]);
  // focusPoint 是 auth.ts
  const task = createTaskContext([createFileFocusPoint("src/auth.ts")]);

  const inputs: RelevanceScoreInput[] = [
    { filePath: "src/auth.ts", taskContext: task, codeMap, now: new Date().toISOString() },
    { filePath: "src/utils.ts", taskContext: task, codeMap, now: new Date().toISOString() },
    { filePath: "src/unrelated.ts", taskContext: task, codeMap, now: new Date().toISOString() },
  ];

  // 取 Top-2
  const top2 = scorer.scoreBatch(inputs, 2);
  assert.equal(top2.length, 2, "Top-K 应返回 2 个结果");
  // auth.ts 是 focusPoint（距离 1.0），应排第一
  assert.equal(top2[0].filePath, "src/auth.ts", "Top-1 应为 auth.ts（距离 1.0）");
  // utils.ts 是 1 跳（距离 0.7），应排第二
  assert.equal(top2[1].filePath, "src/utils.ts", "Top-2 应为 utils.ts（距离 0.7）");
  // 验证降序
  assert.ok(top2[0].totalScore >= top2[1].totalScore, "Top-K 应按 totalScore 降序");
});

// ============================================================
// RS-10: 总评分加权求和正确性
// ============================================================

test("RS-10: 总评分加权求和正确性", () => {
  // 自定义权重：距离 0.5，关键词 0.3，时间 0.2
  const scorer = new RelevanceScorer({
    codeMapDistanceWeight: 0.5,
    keywordMatchWeight: 0.3,
    timeDecayWeight: 0.2,
    timeDecayHalfLifeMs: 60_000,
  });
  const codeMap = createCodeMap([createFileInfo("src/auth.ts")]);
  // focusPoint 是 auth.ts（距离 1.0）
  const task = createTaskContext([createFileFocusPoint("src/auth.ts")], "auth");

  const score = scorer.score({
    filePath: "src/auth.ts",
    taskContext: task,
    codeMap,
    now: new Date().toISOString(),
  });

  // 距离分 = 1.0（直达）
  assert.equal(score.codeMapDistanceScore, 1.0, "距离分应为 1.0");
  // 总评分 = 0.5 * 1.0 + 0.3 * keywordScore + 0.2 * timeDecayScore
  const expectedTotal = 0.5 * score.codeMapDistanceScore + 0.3 * score.keywordMatchScore + 0.2 * score.timeDecayScore;
  assert.ok(
    Math.abs(score.totalScore - expectedTotal) < 0.001,
    `总评分应为加权求和（${expectedTotal.toFixed(3)}），实际 ${score.totalScore.toFixed(3)}`
  );
});

// ============================================================================
// SlidingWindowManager 测试（SW-01 ~ SW-10）
// ============================================================================

// ============================================================
// SW-01: Top-K 相关文件保留
// ============================================================

test("SW-01: Top-K 相关文件保留（topKFiles=2 时保留 2 个高分文件）", async () => {
  const scorer = new RelevanceScorer();
  const window = createSlidingWindow({ tokenBudget: 100_000, topKFiles: 2 }, scorer);
  const codeMap = createCodeMap([
    createFileInfo("src/auth.ts", ["src/utils.ts"]),
    createFileInfo("src/utils.ts"),
    createFileInfo("src/unrelated.ts"),
  ]);
  const task = createTaskContext([createFileFocusPoint("src/auth.ts")]);

  // 3 个文件片段
  const candidates: ContextSnippet[] = [
    createSnippet("file_content", "auth content", "src/auth.ts"),
    createSnippet("file_content", "utils content", "src/utils.ts"),
    createSnippet("file_content", "unrelated content", "src/unrelated.ts"),
  ];

  // V2-P2：buildWindow 已改为 async，需 await
  const result = await window.buildWindow(candidates, task, codeMap);
  assert.equal(result.retainedFiles.length, 2, "topKFiles=2 应保留 2 个文件");
  // auth.ts（距离 1.0）和 utils.ts（距离 0.7）应被保留
  assert.ok(result.retainedFiles.includes("src/auth.ts"), "应保留 src/auth.ts（距离 1.0）");
  assert.ok(result.retainedFiles.includes("src/utils.ts"), "应保留 src/utils.ts（距离 0.7）");
  assert.ok(!result.retainedFiles.includes("src/unrelated.ts"), "不应保留 src/unrelated.ts（距离 0.05）");
});

// ============================================================
// SW-02: 最近 N 轮对话保留
// ============================================================

test("SW-02: 最近 N 轮对话保留（keepRecentTurns=2）", async () => {
  const scorer = new RelevanceScorer();
  const window = createSlidingWindow({ tokenBudget: 100_000, keepRecentTurns: 2 }, scorer);
  const codeMap = createCodeMap([createFileInfo("src/a.ts")]);
  const task = createTaskContext([createFileFocusPoint("src/a.ts")]);

  // 5 轮对话（最早的在前）
  const candidates: ContextSnippet[] = [
    createSnippet("conversation", "第1轮对话", "turn-1"),
    createSnippet("conversation", "第2轮对话", "turn-2"),
    createSnippet("conversation", "第3轮对话", "turn-3"),
    createSnippet("conversation", "第4轮对话", "turn-4"),
    createSnippet("conversation", "第5轮对话", "turn-5"),
  ];

  // V2-P2：buildWindow 已改为 async，需 await
  const result = await window.buildWindow(candidates, task, codeMap);
  assert.equal(result.retainedTurns, 2, "keepRecentTurns=2 应保留 2 轮对话");
  // 保留最后 2 轮（turn-4, turn-5）
  const conversationSources = result.retainedSnippets.filter((s) => s.type === "conversation").map((s) => s.source);
  assert.ok(conversationSources.includes("turn-4"), "应保留 turn-4");
  assert.ok(conversationSources.includes("turn-5"), "应保留 turn-5");
  assert.ok(!conversationSources.includes("turn-1"), "不应保留 turn-1");
});

// ============================================================
// SW-03: Token 预算截断
// ============================================================

test("SW-03: Token 预算截断（V2-P2：超预算片段压缩为摘要而非丢弃）", async () => {
  const scorer = new RelevanceScorer();
  // charsPerToken=4，tokenBudget=10 → 最大 40 字符
  const window = createSlidingWindow({ tokenBudget: 10, charsPerToken: 4, topKFiles: 10 }, scorer);
  const codeMap = createCodeMap([createFileInfo("src/a.ts"), createFileInfo("src/b.ts"), createFileInfo("src/c.ts")]);
  // focusPoint 是 a.ts，b/c 不在图中（距离 0.1）
  const task = createTaskContext([createFileFocusPoint("src/a.ts")]);

  // 3 个文件片段，每个 20 字符（5 token），总 60 字符（15 token）> 10 token 预算
  const candidates: ContextSnippet[] = [
    createSnippet("file_content", "a".repeat(20), "src/a.ts"), // 距离 1.0（直达）
    createSnippet("file_content", "b".repeat(20), "src/b.ts"), // 距离 0.1（图未含）
    createSnippet("file_content", "c".repeat(20), "src/c.ts"), // 距离 0.1（图未含）
  ];

  // V2-P2：buildWindow 已改为 async，需 await
  const result = await window.buildWindow(candidates, task, codeMap);
  // 预算 10 token，每片段 5 token → 最多保留 2 个，超预算的 1 个被压缩为摘要
  assert.ok(result.estimatedTokens <= 10, "估算 token 不应超预算");
  // V2-P2 断言适配：超预算片段被压缩为摘要而非丢弃，断言改为 compressedSnippets
  assert.ok(result.compressedSnippets.length >= 1, "应至少压缩 1 个片段为摘要");
  // a.ts（距离 1.0）应被保留（高分优先）
  assert.ok(result.retainedFiles.includes("src/a.ts"), "src/a.ts（高分）应被保留");
});

// ============================================================
// SW-04: 超预算从低分端丢弃
// ============================================================

test("SW-04: 超预算从低分端压缩（V2-P2：a.ts 高分保留，c.ts 低分压缩为摘要）", async () => {
  const scorer = new RelevanceScorer();
  // charsPerToken=4，tokenBudget=6 → 最大 24 字符 → 1 个片段（20 字符=5 token）
  const window = createSlidingWindow({ tokenBudget: 6, charsPerToken: 4, topKFiles: 10 }, scorer);
  const codeMap = createCodeMap([
    createFileInfo("src/a.ts", ["src/b.ts"]),
    createFileInfo("src/b.ts"),
    createFileInfo("src/c.ts"),
  ]);
  // focusPoint 是 a.ts
  const task = createTaskContext([createFileFocusPoint("src/a.ts")]);

  const candidates: ContextSnippet[] = [
    createSnippet("file_content", "a".repeat(20), "src/a.ts"), // 距离 1.0
    createSnippet("file_content", "b".repeat(20), "src/b.ts"), // 距离 0.7
    createSnippet("file_content", "c".repeat(20), "src/c.ts"), // 距离 0.1
  ];

  // V2-P2：buildWindow 已改为 async，需 await
  const result = await window.buildWindow(candidates, task, codeMap);
  // 预算 6 token，每片段 5 token → 最多保留 1 个（retainedSnippets 不含压缩片段）
  assert.ok(result.retainedSnippets.length === 1, "应仅保留 1 个片段（压缩片段不计入 retainedSnippets）");
  // a.ts（距离 1.0，最高分）应被保留
  assert.ok(result.retainedFiles.includes("src/a.ts"), "src/a.ts（最高分）应被保留");
  // c.ts（距离 0.1，最低分）不应在 retainedFiles 中（被压缩为摘要，不在保留列表）
  assert.ok(!result.retainedFiles.includes("src/c.ts"), "src/c.ts（最低分）应被压缩而非保留");
  // V2-P2 新增断言：b.ts 和 c.ts 应被压缩为 compressed_summary 类型片段
  assert.ok(result.compressedSnippets.length >= 1, "应至少压缩 1 个低分片段为摘要");
  const compressedSources = result.compressedSnippets.map((s) => s.source);
  // 低分端优先被压缩：c.ts（最低分）应在压缩列表中
  assert.ok(compressedSources.includes("src/c.ts"), "src/c.ts（最低分）应在压缩片段中");
});

// ============================================================
// SW-05: 空候选窗口
// ============================================================

test("SW-05: 空候选窗口（candidates=[] 返回空结果）", async () => {
  const scorer = new RelevanceScorer();
  const window = createSlidingWindow({}, scorer);
  const codeMap = createCodeMap([]);
  const task = createTaskContext();

  // V2-P2：buildWindow 已改为 async，需 await
  const result = await window.buildWindow([], task, codeMap);
  assert.equal(result.retainedSnippets.length, 0, "空候选应返回 0 个保留片段");
  assert.equal(result.compressedSnippets.length, 0, "空候选应压缩 0 个片段");
  assert.equal(result.droppedCount, 0, "空候选应丢弃 0 个片段");
  assert.equal(result.estimatedTokens, 0, "空候选估算 token 应为 0");
  assert.equal(result.originalTokens, 0, "空候选原始 token 应为 0");
  assert.equal(result.compressionRatio, 1.0, "空候选压缩率应为 1.0（无压缩）");
});

// ============================================================
// SW-06: 单文件窗口
// ============================================================

test("SW-06: 单文件窗口（1 个文件片段 + 1 轮对话）", async () => {
  const scorer = new RelevanceScorer();
  const window = createSlidingWindow({ topKFiles: 10, keepRecentTurns: 5 }, scorer);
  const codeMap = createCodeMap([createFileInfo("src/a.ts")]);
  const task = createTaskContext([createFileFocusPoint("src/a.ts")]);

  const candidates: ContextSnippet[] = [
    createSnippet("file_content", "file content", "src/a.ts"),
    createSnippet("conversation", "对话内容", "turn-1"),
  ];

  // V2-P2：buildWindow 已改为 async，需 await
  const result = await window.buildWindow(candidates, task, codeMap);
  assert.equal(result.retainedSnippets.length, 2, "应保留 2 个片段（1 文件 + 1 对话）");
  assert.equal(result.retainedFiles.length, 1, "应保留 1 个文件");
  assert.equal(result.retainedTurns, 1, "应保留 1 轮对话");
});

// ============================================================
// SW-07: compressionRatio 正确性
// ============================================================

test("SW-07: compressionRatio 正确性（estimatedTokens / originalTokens）", async () => {
  const scorer = new RelevanceScorer();
  // charsPerToken=4，tokenBudget=10 → 最大 40 字符
  const window = createSlidingWindow({ tokenBudget: 10, charsPerToken: 4, topKFiles: 10 }, scorer);
  const codeMap = createCodeMap([createFileInfo("src/a.ts"), createFileInfo("src/b.ts")]);
  const task = createTaskContext([createFileFocusPoint("src/a.ts")]);

  // 2 个文件片段，每个 40 字符（10 token），总 80 字符（20 token）> 10 token 预算
  const candidates: ContextSnippet[] = [
    createSnippet("file_content", "a".repeat(40), "src/a.ts"),
    createSnippet("file_content", "b".repeat(40), "src/b.ts"),
  ];

  // V2-P2：buildWindow 已改为 async，需 await
  const result = await window.buildWindow(candidates, task, codeMap);
  // originalTokens = 20，estimatedTokens = 10（仅保留 1 个；压缩片段不计入 estimatedTokens）
  assert.equal(result.originalTokens, 20, "原始 token 应为 20");
  assert.equal(result.estimatedTokens, 10, "估算 token 应为 10（不含压缩片段）");
  assert.equal(result.compressionRatio, 0.5, "压缩率应为 0.5");
});

// ============================================================
// SW-08: 保留文件路径列表正确性
// ============================================================

test("SW-08: 保留文件路径列表正确性", async () => {
  const scorer = new RelevanceScorer();
  const window = createSlidingWindow({ topKFiles: 2, keepRecentTurns: 0 }, scorer);
  const codeMap = createCodeMap([createFileInfo("src/auth.ts", ["src/utils.ts"]), createFileInfo("src/utils.ts")]);
  const task = createTaskContext([createFileFocusPoint("src/auth.ts")]);

  const candidates: ContextSnippet[] = [
    createSnippet("file_content", "auth", "src/auth.ts"),
    createSnippet("file_content", "utils", "src/utils.ts"),
    createSnippet("file_content", "unrelated", "src/unrelated.ts"),
  ];

  // V2-P2：buildWindow 已改为 async，需 await
  const result = await window.buildWindow(candidates, task, codeMap);
  assert.equal(result.retainedFiles.length, 2, "应保留 2 个文件");
  assert.deepEqual(
    result.retainedFiles.sort(),
    ["src/auth.ts", "src/utils.ts"].sort(),
    "保留文件应为 auth.ts 和 utils.ts"
  );
});

// ============================================================
// SW-09: 保留对话轮数正确性
// ============================================================

test("SW-09: 保留对话轮数正确性（keepRecentTurns=3，5 轮对话保留 3 轮）", async () => {
  const scorer = new RelevanceScorer();
  const window = createSlidingWindow({ keepRecentTurns: 3, topKFiles: 0 }, scorer);
  const codeMap = createCodeMap([]);
  const task = createTaskContext();

  const candidates: ContextSnippet[] = [
    createSnippet("conversation", "t1", "turn-1"),
    createSnippet("conversation", "t2", "turn-2"),
    createSnippet("conversation", "t3", "turn-3"),
    createSnippet("conversation", "t4", "turn-4"),
    createSnippet("conversation", "t5", "turn-5"),
  ];

  // V2-P2：buildWindow 已改为 async，需 await
  const result = await window.buildWindow(candidates, task, codeMap);
  assert.equal(result.retainedTurns, 3, "应保留 3 轮对话");
  // 保留最后 3 轮
  const sources = result.retainedSnippets.map((s) => s.source);
  assert.ok(sources.includes("turn-3"), "应保留 turn-3");
  assert.ok(sources.includes("turn-4"), "应保留 turn-4");
  assert.ok(sources.includes("turn-5"), "应保留 turn-5");
  assert.ok(!sources.includes("turn-1"), "不应保留 turn-1");
  assert.ok(!sources.includes("turn-2"), "不应保留 turn-2");
});

// ============================================================
// SW-10: 文件片段携带 relevance 评分
// ============================================================

test("SW-10: 文件片段携带 relevance 评分（由 scorer 计算）", async () => {
  const scorer = new RelevanceScorer();
  const window = createSlidingWindow({ topKFiles: 10 }, scorer);
  const codeMap = createCodeMap([createFileInfo("src/auth.ts")]);
  const task = createTaskContext([createFileFocusPoint("src/auth.ts")]);

  const candidates: ContextSnippet[] = [createSnippet("file_content", "auth content", "src/auth.ts")];

  // V2-P2：buildWindow 已改为 async，需 await
  const result = await window.buildWindow(candidates, task, codeMap);
  assert.equal(result.retainedSnippets.length, 1, "应保留 1 个片段");
  const retained = result.retainedSnippets[0];
  assert.ok(retained.relevance !== undefined, "文件片段应携带 relevance 评分");
  assert.ok(typeof retained.relevance === "number", "relevance 应为数字");
  assert.ok(retained.relevance >= 0 && retained.relevance <= 1, "relevance 应在 0-1 之间");
});

// ============================================================================
// V2-P2 新增测试（SW-COMPRESS-01 ~ SW-COMPRESS-03 + SW-ASYNC-01）
// ============================================================================

// ============================================================
// SW-COMPRESS-01: 超预算片段被压缩为摘要（type="compressed_summary"）
// ============================================================

test("SW-COMPRESS-01: 超预算片段被压缩为摘要（type=compressed_summary，content 前缀 [摘要]）", async () => {
  const scorer = new RelevanceScorer();
  // 预算 5 token（20 字符），2 个片段各 20 字符（5 token）→ 保留 1 个，压缩 1 个
  const window = createSlidingWindow(
    { tokenBudget: 5, charsPerToken: 4, topKFiles: 10, maxCompressedSnippets: 10 },
    scorer
  );
  const codeMap = createCodeMap([createFileInfo("src/a.ts"), createFileInfo("src/b.ts")]);
  const task = createTaskContext([createFileFocusPoint("src/a.ts")]);

  // 2 个片段，每个 20 字符（5 token），总 40 字符（10 token）> 5 token 预算
  const candidates: ContextSnippet[] = [
    createSnippet("file_content", "a".repeat(20), "src/a.ts"), // 距离 1.0（直达，保留）
    createSnippet("file_content", "b".repeat(20), "src/b.ts"), // 距离 0.1（图未含，压缩）
  ];

  const result = await window.buildWindow(candidates, task, codeMap);

  // 断言 1：compressedSnippets 非空（至少 1 个被压缩）
  assert.ok(result.compressedSnippets.length >= 1, "应至少压缩 1 个超预算片段");

  // 断言 2：压缩片段 type 为 "compressed_summary"
  const compressed = result.compressedSnippets[0];
  assert.equal(compressed.type, "compressed_summary", "压缩片段 type 应为 compressed_summary");

  // 断言 3：压缩片段 content 前缀为 "[摘要] "
  assert.ok(
    compressed.content.startsWith("[摘要] "),
    `压缩片段 content 应以 "[摘要] " 开头，实际：${compressed.content}`
  );

  // 断言 4：压缩片段 source 保留原始来源
  assert.equal(compressed.source, "src/b.ts", "压缩片段 source 应保留原始来源 src/b.ts");
});

// ============================================================
// SW-COMPRESS-02: 压缩后 Token 下降且 compressionRatio < 1.0
// ============================================================

test("SW-COMPRESS-02: 压缩后 estimatedTokens < originalTokens 且 compressionRatio < 1.0", async () => {
  const scorer = new RelevanceScorer();
  // 预算 5 token，2 个片段各 40 字符（10 token）→ 保留 1 个，压缩 1 个
  const window = createSlidingWindow(
    { tokenBudget: 5, charsPerToken: 4, topKFiles: 10, maxCompressedSnippets: 10 },
    scorer
  );
  const codeMap = createCodeMap([createFileInfo("src/a.ts"), createFileInfo("src/b.ts")]);
  const task = createTaskContext([createFileFocusPoint("src/a.ts")]);

  // 2 个片段，每个 40 字符（10 token），总 80 字符（20 token）> 5 token 预算
  const candidates: ContextSnippet[] = [
    createSnippet("file_content", "a".repeat(40), "src/a.ts"), // 距离 1.0（保留）
    createSnippet("file_content", "b".repeat(40), "src/b.ts"), // 距离 0.1（压缩）
  ];

  const result = await window.buildWindow(candidates, task, codeMap);

  // 断言 1：originalTokens = 20（全部候选累计 token）
  assert.equal(result.originalTokens, 20, "原始 token 应为 20");

  // 断言 2：estimatedTokens <= budget（5 token）
  assert.ok(result.estimatedTokens <= 5, `估算 token 不应超预算 5，实际：${result.estimatedTokens}`);

  // 断言 3：compressionRatio < 1.0（有压缩发生）
  assert.ok(result.compressionRatio < 1.0, `压缩率应 < 1.0（有压缩），实际：${result.compressionRatio}`);

  // 断言 4：compressedSnippets 非空
  assert.ok(result.compressedSnippets.length >= 1, "应至少压缩 1 个片段");

  // 断言 5：压缩片段的 summary 部分（去掉 "[摘要] " 前缀）长度 <= maxCompressedLength
  // 注：compressOldSnippets 的 maxCompressedLength = max(50, floor(content.length / 3))
  // 对于 40 字符内容：maxCompressedLength = max(50, 13) = 50
  // RuleBasedSummarizer 按句子分割，"b".repeat(40) 无标点 → 整句 40 字符 <= 50 → 保留整句
  // 压缩片段 content = "[摘要] " + "b".repeat(40)（前缀 5 字符 + 40 字符 = 45 字符）
  const compressed = result.compressedSnippets[0];
  const SUMMARY_PREFIX = "[摘要] ";
  const summaryPart = compressed.content.slice(SUMMARY_PREFIX.length);
  assert.ok(summaryPart.length <= 50, `压缩片段 summary 部分（${summaryPart.length}）应 <= maxCompressedLength（50）`);
});

// ============================================================
// SW-COMPRESS-03: getBudgetAllocation 三层预算分配正确
// ============================================================

test("SW-COMPRESS-03: getBudgetAllocation 三层预算分配（10%/40%/50%）", () => {
  const scorer = new RelevanceScorer();
  // tokenBudget=10000，比例 10%/40%/50% → metadata=1000, instruction=4000, resource=5000
  const window = createSlidingWindow(
    {
      tokenBudget: 10_000,
      metadataBudgetRatio: 0.1,
      instructionBudgetRatio: 0.4,
      resourceBudgetRatio: 0.5,
    },
    scorer
  );

  // 调用 getBudgetAllocation（代理 progressiveLoader.getBudgetAllocation）
  const allocation = window.getBudgetAllocation();

  // 断言：三层预算按 10%/40%/50% 分配
  assert.equal(allocation.metadata, 1_000, "Metadata 层预算应为 1000（10000 * 0.1）");
  assert.equal(allocation.instruction, 4_000, "Instruction 层预算应为 4000（10000 * 0.4）");
  assert.equal(allocation.resource, 5_000, "Resource 层预算应为 5000（10000 * 0.5）");
});

// ============================================================
// SW-ASYNC-01: buildWindow 返回 Promise（V2-P2 升级为 async）
// ============================================================

test("SW-ASYNC-01: buildWindow 返回 Promise（V2-P2 升级为 async 方法）", () => {
  const scorer = new RelevanceScorer();
  const window = createSlidingWindow({ topKFiles: 10 }, scorer);
  const codeMap = createCodeMap([createFileInfo("src/a.ts")]);
  const task = createTaskContext([createFileFocusPoint("src/a.ts")]);
  const candidates: ContextSnippet[] = [createSnippet("file_content", "content", "src/a.ts")];

  // 调用 buildWindow（不 await），验证返回值为 Promise
  const result = window.buildWindow(candidates, task, codeMap);
  assert.ok(result instanceof Promise, "buildWindow 应返回 Promise（V2-P2 升级为 async）");
});
