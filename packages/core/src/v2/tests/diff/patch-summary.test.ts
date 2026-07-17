import { test } from "node:test";
import assert from "node:assert/strict";
import { PatchSummaryGenerator, type DiffResult, type PatchSummary } from "../../diff/patch-summary";
import { enhanceDiffPreview } from "../../diff/enhance-diff-preview";

/**
 * PatchSummaryGenerator 单元测试（F-DIFF-03）
 *
 * 测试覆盖：
 * - PS-01: 空输入（0 文件）
 * - PS-02: 单文件纯新增
 * - PS-03: 单文件纯删除
 * - PS-04: 单文件混合变更
 * - PS-05: 多文件场景（设计文档 §3.2.3 示例）
 * - PS-06: 渲染格式 - 文件行 emoji 前缀
 * - PS-07: 渲染格式 - 分隔线（37 个 ─）
 * - PS-08: 渲染格式 - 总计行
 * - PS-09: 总计计算正确性
 * - PS-10: hunks 数量提取
 * - PS-11: 不含 ANSI 颜色码
 * - PS-12: render 独立可复用（手动构造 PatchSummary）
 * - PS-13: summarize 内部调用 render 填充 rendered 字段
 * - PS-14: 文件顺序保持
 * - PS-15: 与 myers-diff / enhanceDiffPreview 集成（真实 DiffResult）
 * - PS-16: 多次调用无状态泄漏（线程安全/幂等）
 */

/** 构造一个最小化的 DiffResult，便于测试 */
function makeDiff(filePath: string, additions: number, deletions: number, hunksCount: number): DiffResult {
  return {
    filePath,
    // 构造指定数量的 hunk（每个 hunk 用空 ops 占位，hunks.length 才是测试关注点）
    hunks: Array.from({ length: hunksCount }, () => ({
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: 0,
      ops: [],
    })),
    stats: {
      additions,
      deletions,
      changes: additions + deletions,
    },
  };
}

test("PS-01: 空输入 - 返回空 files 和零总计", () => {
  const gen = new PatchSummaryGenerator();
  const summary = gen.summarize([]);

  assert.equal(summary.files.length, 0);
  assert.equal(summary.totalAdditions, 0);
  assert.equal(summary.totalDeletions, 0);
  assert.equal(summary.totalFiles, 0);
  // 空输入仍应渲染分隔线 + 总计行
  assert.equal(summary.rendered, "─".repeat(37) + "\nTotal: 0 files changed, +0 -0");
});

test("PS-02: 单文件纯新增 - additions 正确，deletions 为 0", () => {
  const gen = new PatchSummaryGenerator();
  const summary = gen.summarize([makeDiff("a.ts", 10, 0, 1)]);

  assert.equal(summary.files.length, 1);
  assert.equal(summary.files[0].additions, 10);
  assert.equal(summary.files[0].deletions, 0);
  assert.equal(summary.files[0].hunks, 1);
  assert.equal(summary.totalAdditions, 10);
  assert.equal(summary.totalDeletions, 0);
  assert.equal(summary.totalFiles, 1);
});

test("PS-03: 单文件纯删除 - deletions 正确，additions 为 0", () => {
  const gen = new PatchSummaryGenerator();
  const summary = gen.summarize([makeDiff("b.ts", 0, 7, 2)]);

  assert.equal(summary.files[0].additions, 0);
  assert.equal(summary.files[0].deletions, 7);
  assert.equal(summary.files[0].hunks, 2);
  assert.equal(summary.totalAdditions, 0);
  assert.equal(summary.totalDeletions, 7);
});

test("PS-04: 单文件混合变更 - additions 和 deletions 同时存在", () => {
  const gen = new PatchSummaryGenerator();
  const summary = gen.summarize([makeDiff("c.ts", 5, 3, 1)]);

  assert.equal(summary.files[0].additions, 5);
  assert.equal(summary.files[0].deletions, 3);
  assert.equal(summary.totalAdditions, 5);
  assert.equal(summary.totalDeletions, 3);
});

test("PS-05: 多文件场景 - 复刻设计文档 §3.2.3 示例", () => {
  const gen = new PatchSummaryGenerator();
  const diffs: DiffResult[] = [
    makeDiff("packages/core/src/v2/diff/enhance-diff-preview.ts", 125, 3, 4),
    makeDiff("packages/core/src/v2/types.ts", 45, 8, 2),
    makeDiff("packages/cli/src/ui/views/diff-view.tsx", 89, 12, 3),
  ];
  const summary = gen.summarize(diffs);

  assert.equal(summary.totalFiles, 3);
  assert.equal(summary.totalAdditions, 259); // 125 + 45 + 89
  assert.equal(summary.totalDeletions, 23); // 3 + 8 + 12
  // 验证渲染输出与设计文档示例完全一致
  const expected =
    "📄 packages/core/src/v2/diff/enhance-diff-preview.ts (+125 -3)\n" +
    "📄 packages/core/src/v2/types.ts (+45 -8)\n" +
    "📄 packages/cli/src/ui/views/diff-view.tsx (+89 -12)\n" +
    "─".repeat(37) +
    "\n" +
    "Total: 3 files changed, +259 -23";
  assert.equal(summary.rendered, expected);
});

test("PS-06: 渲染格式 - 文件行包含 📄 emoji 前缀和 (+N -M) 后缀", () => {
  const gen = new PatchSummaryGenerator();
  const summary = gen.summarize([makeDiff("foo.ts", 12, 4, 1)]);
  const lines = summary.rendered.split("\n");
  // 第一行应为文件行
  assert.equal(lines[0], "📄 foo.ts (+12 -4)");
  // 必须包含 📄 emoji
  assert.ok(lines[0].startsWith("📄 "));
});

test("PS-07: 渲染格式 - 分隔线为 37 个 ─（U+2500）", () => {
  const gen = new PatchSummaryGenerator();
  const summary = gen.summarize([makeDiff("x.ts", 1, 1, 1)]);
  const lines = summary.rendered.split("\n");
  // 分隔线位于文件行之后、总计行之前
  const separatorLine = lines[1];
  assert.equal(separatorLine, "─".repeat(37));
  assert.equal(separatorLine.length, 37);
  // 确认是 U+2500 字符
  assert.equal(separatorLine.codePointAt(0), 0x2500);
});

test("PS-08: 渲染格式 - 总计行格式 'Total: N files changed, +N -M'", () => {
  const gen = new PatchSummaryGenerator();
  const summary = gen.summarize([makeDiff("a.ts", 5, 2, 1), makeDiff("b.ts", 3, 1, 1)]);
  const lines = summary.rendered.split("\n");
  const totalLine = lines[lines.length - 1];
  assert.equal(totalLine, "Total: 2 files changed, +8 -3");
});

test("PS-09: 总计计算 - 多文件 additions/deletions 求和正确", () => {
  const gen = new PatchSummaryGenerator();
  const summary = gen.summarize([
    makeDiff("a", 10, 1, 1),
    makeDiff("b", 20, 2, 1),
    makeDiff("c", 30, 3, 1),
    makeDiff("d", 0, 0, 0),
  ]);
  assert.equal(summary.totalAdditions, 60); // 10+20+30+0
  assert.equal(summary.totalDeletions, 6); // 1+2+3+0
  assert.equal(summary.totalFiles, 4);
});

test("PS-10: hunks 数量 - 从 DiffResult.hunks.length 正确提取", () => {
  const gen = new PatchSummaryGenerator();
  const summary = gen.summarize([makeDiff("a", 1, 1, 1), makeDiff("b", 1, 1, 5), makeDiff("c", 1, 1, 0)]);
  assert.equal(summary.files[0].hunks, 1);
  assert.equal(summary.files[1].hunks, 5);
  assert.equal(summary.files[2].hunks, 0);
});

test("PS-11: 不含 ANSI 颜色码 - 输出为纯文本", () => {
  const gen = new PatchSummaryGenerator();
  const summary = gen.summarize([makeDiff("a.ts", 100, 50, 3), makeDiff("b.ts", 0, 99, 1)]);
  // ANSI 转义序列以 \x1b[ 开头，输出中不应出现
  assert.ok(!summary.rendered.includes("\x1b["));
  assert.ok(!/\x1b\[\d+m/.test(summary.rendered));
});

test("PS-12: render 独立可复用 - 手动构造 PatchSummary 也能正确渲染", () => {
  const gen = new PatchSummaryGenerator();
  const manual: PatchSummary = {
    files: [
      { filePath: "x.ts", additions: 7, deletions: 2, hunks: 1 },
      { filePath: "y.ts", additions: 0, deletions: 5, hunks: 2 },
    ],
    totalAdditions: 7,
    totalDeletions: 7,
    totalFiles: 2,
    rendered: "",
  };
  const rendered = gen.render(manual);
  const lines = rendered.split("\n");
  assert.equal(lines[0], "📄 x.ts (+7 -2)");
  assert.equal(lines[1], "📄 y.ts (+0 -5)");
  assert.equal(lines[2], "─".repeat(37));
  assert.equal(lines[3], "Total: 2 files changed, +7 -7");
});

test("PS-13: summarize 内部调用 render 填充 rendered 字段", () => {
  const gen = new PatchSummaryGenerator();
  const summary = gen.summarize([makeDiff("a.ts", 3, 1, 1)]);
  // rendered 应与独立调用 render 的结果一致
  const directRendered = gen.render({
    files: summary.files,
    totalAdditions: summary.totalAdditions,
    totalDeletions: summary.totalDeletions,
    totalFiles: summary.totalFiles,
    rendered: "",
  });
  assert.equal(summary.rendered, directRendered);
  assert.notEqual(summary.rendered, "");
});

test("PS-14: 文件顺序保持 - 与输入 diffs 顺序一致", () => {
  const gen = new PatchSummaryGenerator();
  const summary = gen.summarize([
    makeDiff("first.ts", 1, 0, 1),
    makeDiff("second.ts", 2, 0, 1),
    makeDiff("third.ts", 3, 0, 1),
  ]);
  assert.equal(summary.files[0].filePath, "first.ts");
  assert.equal(summary.files[1].filePath, "second.ts");
  assert.equal(summary.files[2].filePath, "third.ts");
  // 渲染顺序同样保持
  const lines = summary.rendered.split("\n");
  assert.ok(lines[0].includes("first.ts"));
  assert.ok(lines[1].includes("second.ts"));
  assert.ok(lines[2].includes("third.ts"));
});

test("PS-15: 集成测试 - 与 enhanceDiffPreview 产出真实 DiffResult", () => {
  const gen = new PatchSummaryGenerator();

  // 使用 enhanceDiffPreview 生成真实的 hunks 和 stats
  // 文件 1：纯新增（新文件）
  const diff1 = enhanceDiffPreview(null, "line1\nline2\nline3\n");
  // 文件 2：修改（替换中间行）
  const diff2 = enhanceDiffPreview("a\nold\nb\n", "a\nnew\nb\n");
  // 文件 3：纯删除
  const diff3 = enhanceDiffPreview("x\ny\nz\n", "");

  const diffs: DiffResult[] = [
    { filePath: "new-file.ts", hunks: diff1.hunks, stats: diff1.stats },
    { filePath: "modified.ts", hunks: diff2.hunks, stats: diff2.stats },
    { filePath: "deleted.ts", hunks: diff3.hunks, stats: diff3.stats },
  ];

  const summary = gen.summarize(diffs);

  // 验证各文件统计与 enhanceDiffPreview 输出一致
  assert.equal(summary.files[0].additions, 3); // 纯新增 3 行
  assert.equal(summary.files[0].deletions, 0);
  assert.ok(summary.files[0].hunks >= 1);

  assert.equal(summary.files[1].additions, 1); // 替换 1 行
  assert.equal(summary.files[1].deletions, 1);
  assert.ok(summary.files[1].hunks >= 1);

  assert.equal(summary.files[2].additions, 0); // 纯删除 3 行
  assert.equal(summary.files[2].deletions, 3);
  assert.ok(summary.files[2].hunks >= 1);

  // 总计
  assert.equal(summary.totalAdditions, 4); // 3 + 1 + 0
  assert.equal(summary.totalDeletions, 4); // 0 + 1 + 3
  assert.equal(summary.totalFiles, 3);

  // 验证渲染输出结构完整：3 文件行 + 分隔线 + 总计行 = 5 行
  const lines = summary.rendered.split("\n");
  assert.equal(lines.length, 5);
  assert.ok(lines[0].startsWith("📄 new-file.ts (+3 -0)"));
  assert.ok(lines[1].startsWith("📄 modified.ts (+1 -1)"));
  assert.ok(lines[2].startsWith("📄 deleted.ts (+0 -3)"));
  assert.equal(lines[3], "─".repeat(37));
  assert.equal(lines[4], "Total: 3 files changed, +4 -4");
});

test("PS-16: 幂等性 - 多次调用 summarize 无状态泄漏", () => {
  const gen = new PatchSummaryGenerator();
  const diffs1 = [makeDiff("a.ts", 5, 1, 1)];
  const diffs2 = [makeDiff("b.ts", 10, 2, 2), makeDiff("c.ts", 3, 0, 1)];

  const s1 = gen.summarize(diffs1);
  const s2 = gen.summarize(diffs2);
  // 再次调用 s1 的输入，结果应与 s1 完全一致（无状态污染）
  const s1Again = gen.summarize(diffs1);

  assert.equal(s1.totalFiles, 1);
  assert.equal(s2.totalFiles, 2);
  assert.equal(s1Again.totalFiles, 1);
  assert.equal(s1Again.totalAdditions, 5);
  assert.equal(s1Again.rendered, s1.rendered);
});
