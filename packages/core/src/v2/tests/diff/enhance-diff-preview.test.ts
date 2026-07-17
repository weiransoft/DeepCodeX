import { test } from "node:test";
import assert from "node:assert/strict";
import { enhanceDiffPreview } from "../../diff/enhance-diff-preview";

/**
 * enhanceDiffPreview 单元测试
 *
 * 测试覆盖：
 * - DR-01: 完全相同的文件返回空结果
 * - DR-02: 纯新增行（新文件）
 * - DR-03: 纯删除行
 * - DR-04: 修改单行
 * - DR-05: 大文件 diff 截断
 * - DR-06: contextLines=0 无上下文
 * - DR-07: contextLines=3 保留上下文
 * - DR-08: colorEnabled=false 无 ANSI
 * - DR-08b: colorEnabled=true 含 ANSI
 * - DR-12: 行号显示
 * - unified diff 格式验证
 * - 边界情况
 */

test("DR-01: 完全相同的文件 - 返回空渲染和零统计", () => {
  const result = enhanceDiffPreview("hello\nworld\n", "hello\nworld\n");
  assert.equal(result.rendered, "");
  assert.equal(result.stats.additions, 0);
  assert.equal(result.stats.deletions, 0);
  assert.equal(result.stats.changes, 0);
  assert.equal(result.hunks.length, 0);
});

test("DR-01b: 完全相同（无尾部换行）- 返回空渲染", () => {
  const result = enhanceDiffPreview("hello\nworld", "hello\nworld");
  assert.equal(result.rendered, "");
  assert.equal(result.stats.changes, 0);
});

test("DR-02: 纯新增行 - 全绿色", () => {
  const result = enhanceDiffPreview(null, "hello\nworld\n");
  // 新文件应有 +++ 头部
  assert.ok(result.rendered.includes("+++"));
  // /dev/null 表示原始内容不存在
  assert.ok(result.rendered.includes("/dev/null"));
  assert.equal(result.stats.additions, 2);
  assert.equal(result.stats.deletions, 0);
  assert.equal(result.stats.changes, 2);
});

test("DR-03: 纯删除行 - 全红色", () => {
  const result = enhanceDiffPreview("hello\nworld\n", "");
  // 删除内容应有 --- 头部
  assert.ok(result.rendered.includes("---"));
  assert.equal(result.stats.additions, 0);
  assert.equal(result.stats.deletions, 2);
  assert.equal(result.stats.changes, 2);
});

test("DR-04: 修改单行 - 1 红 1 绿", () => {
  const result = enhanceDiffPreview("hello\nold\nworld\n", "hello\nnew\nworld\n");
  assert.equal(result.stats.additions, 1);
  assert.equal(result.stats.deletions, 1);
  assert.equal(result.stats.changes, 2);
  // 验证 diff 内容包含删除的旧行和新增的新行
  assert.ok(result.rendered.includes("-old"));
  assert.ok(result.rendered.includes("+new"));
});

test("DR-05: 大文件 diff - maxDiffLines 截断", () => {
  const oldContent = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
  const newContent = Array.from({ length: 1000 }, (_, i) => `line ${i} modified`).join("\n");
  const result = enhanceDiffPreview(oldContent, newContent, { maxDiffLines: 50 });
  // 超过 maxDiffLines 应截断并包含提示
  assert.ok(result.rendered.includes("truncated"));
  // 截断提示应包含总行数
  assert.ok(result.rendered.includes("lines"));
});

test("DR-06: contextLines=0 - 无上下文行", () => {
  const result = enhanceDiffPreview("a\nb\nc\nd\ne\n", "a\nb\nX\nd\ne\n", { contextLines: 0 });
  // contextLines=0 时 hunk 中不应有 equal 操作
  for (const hunk of result.hunks) {
    const equalOps = hunk.ops.filter((op) => op.type === "equal");
    assert.equal(equalOps.length, 0, `hunk 中不应有 equal 操作，但发现 ${equalOps.length} 个`);
  }
  // 验证统计正确
  assert.equal(result.stats.additions, 1);
  assert.equal(result.stats.deletions, 1);
});

test("DR-07: contextLines=3 - 3 行上下文", () => {
  const oldLines = Array.from({ length: 10 }, (_, i) => `line${i}`);
  const newLines = [...oldLines];
  newLines[5] = "CHANGED";
  const result = enhanceDiffPreview(oldLines.join("\n"), newLines.join("\n"), { contextLines: 3 });
  // 第一个 hunk 应包含变更行前后各 3 行上下文
  const firstHunk = result.hunks[0];
  assert.ok(firstHunk.ops.length > 1);
  // 应包含 equal 操作（上下文行）
  assert.ok(firstHunk.ops.some((op) => op.type === "equal"));
  // 验证变更行存在
  assert.ok(firstHunk.ops.some((op) => op.type === "delete" && op.text === "line5"));
  assert.ok(firstHunk.ops.some((op) => op.type === "insert" && op.text === "CHANGED"));
});

test("DR-08: colorEnabled=false - 无 ANSI 转义码", () => {
  const result = enhanceDiffPreview("old\n", "new\n", { colorEnabled: false });
  assert.ok(!result.rendered.includes("\x1b["));
});

test("DR-08b: colorEnabled=true - 含 ANSI 转义码", () => {
  const result = enhanceDiffPreview("old\n", "new\n", { colorEnabled: true });
  // 应包含 ANSI 转义码
  assert.ok(result.rendered.includes("\x1b["));
  // 删除行应使用红色（\x1b[31m）
  assert.ok(result.rendered.includes("\x1b[31m"));
  // 新增行应使用绿色（\x1b[32m）
  assert.ok(result.rendered.includes("\x1b[32m"));
});

test("DR-12: 行号显示", () => {
  const result = enhanceDiffPreview("a\nb\nc\n", "a\nX\nc\n", { showLineNumbers: true });
  assert.ok(result.rendered.length > 0);
  // 行号模式下应包含 | 分隔符
  assert.ok(result.rendered.includes("|"));
});

test("unified diff 格式 - 头部正确", () => {
  const result = enhanceDiffPreview("a\nb\n", "a\nc\n");
  // 应包含 --- 和 +++ 文件头
  assert.ok(result.rendered.includes("--- a/file"));
  assert.ok(result.rendered.includes("+++ b/file"));
  // 应包含 @@ hunk 头部
  assert.ok(result.rendered.includes("@@"));
});

test("unified diff 格式 - hunk 头部行号", () => {
  const result = enhanceDiffPreview("line1\nline2\nline3\n", "line1\nCHANGED\nline3\n");
  // hunk 头部格式：@@ -oldStart,oldLines +newStart,newLines @@
  const hunkHeaderMatch = result.rendered.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
  assert.ok(hunkHeaderMatch, "应包含格式正确的 hunk 头部");
  // 验证行号范围合理
  const [, oldStart, oldLines, newStart, newLines] = hunkHeaderMatch;
  assert.ok(Number(oldStart) >= 1, `oldStart 应 >= 1，实际 ${oldStart}`);
  assert.ok(Number(newStart) >= 1, `newStart 应 >= 1，实际 ${newStart}`);
  assert.ok(Number(oldLines) > 0, `oldLines 应 > 0，实际 ${oldLines}`);
  assert.ok(Number(newLines) > 0, `newLines 应 > 0，实际 ${newLines}`);
});

test("空内容到非空 - 全新增", () => {
  const result = enhanceDiffPreview("", "new content\n");
  assert.equal(result.stats.additions, 1);
  assert.equal(result.stats.deletions, 0);
});

test("非空到空内容 - 全删除", () => {
  const result = enhanceDiffPreview("old content\n", "");
  assert.equal(result.stats.additions, 0);
  assert.equal(result.stats.deletions, 1);
});

test("CRLF 换行符 - 正确处理", () => {
  // CRLF 换行应被统一为 LF 处理
  const result = enhanceDiffPreview("a\r\nb\r\n", "a\r\nc\r\n");
  assert.equal(result.stats.additions, 1);
  assert.equal(result.stats.deletions, 1);
});

test("多处分散变更 - 全部识别", () => {
  const oldContent = "line1\nline2\nline3\nline4\nline5\n";
  const newContent = "CHANGED1\nline2\nCHANGED3\nline4\nCHANGED5\n";
  const result = enhanceDiffPreview(oldContent, newContent);
  // 3 处变更：line1→CHANGED1, line3→CHANGED3, line5→CHANGED5
  assert.equal(result.stats.additions, 3);
  assert.equal(result.stats.deletions, 3);
});

test("默认选项 - contextLines=3", () => {
  // 不传 options 时应使用默认 contextLines=3
  const oldLines = Array.from({ length: 20 }, (_, i) => `line${i}`);
  const newLines = [...oldLines];
  newLines[10] = "CHANGED";
  const result = enhanceDiffPreview(oldLines.join("\n"), newLines.join("\n"));
  // 默认 contextLines=3，hunk 应包含变更前后各 3 行上下文
  const hunk = result.hunks[0];
  const equalOps = hunk.ops.filter((op) => op.type === "equal");
  // 变更前后各 3 行 = 6 行上下文
  assert.equal(equalOps.length, 6);
});

test("maxDiffLines=0 - 立即截断", () => {
  const result = enhanceDiffPreview("a\n", "b\n", { maxDiffLines: 0 });
  // maxDiffLines=0 时任何输出都应被截断
  assert.ok(result.rendered.includes("truncated"));
});

test("stats 和 hunks 一致性", () => {
  const result = enhanceDiffPreview("a\nb\nc\n", "a\nB\nC\n");
  // stats 中的 additions/deletions 应与 hunks 中的实际操作数一致
  let hunkAdditions = 0;
  let hunkDeletions = 0;
  for (const hunk of result.hunks) {
    for (const op of hunk.ops) {
      if (op.type === "insert") hunkAdditions++;
      else if (op.type === "delete") hunkDeletions++;
    }
  }
  assert.equal(result.stats.additions, hunkAdditions);
  assert.equal(result.stats.deletions, hunkDeletions);
});

test("行号显示 - 格式正确", () => {
  const result = enhanceDiffPreview("a\nb\nc\n", "a\nX\nc\n", {
    showLineNumbers: true,
    contextLines: 0,
  });
  // 行号模式下应显示行号和分隔符
  assert.ok(result.rendered.includes("|"));
  // 应包含行号 2（被修改的行）
  assert.ok(result.rendered.includes("2"));
});
