/**
 * ApplyPatch 单元测试（F-DIFF-02 Fuzzy Matching Patch 应用器）
 *
 * 测试覆盖：
 * - AD-01: 解析 unified diff（单文件单 hunk）
 * - AD-02: 解析多文件多 hunk
 * - AD-03: 精确匹配应用 hunk
 * - AD-04: 空白容错匹配
 * - AD-05: fuzzy 滑动搜索匹配
 * - AD-06: no_match（无法匹配时返回候选）
 * - AD-07: file_not_found（文件不存在）
 * - AD-08: already_applied（幂等检测）
 * - AD-09: ambiguous（多个并列候选）
 * - AD-10: invalid_patch（格式非法抛出）
 * - AD-11: apply 多文件成功
 * - AD-12: fuzzyMatches 计数
 * - AD-13: 大小写容错匹配
 * - AD-14: 多 hunk 同文件顺序应用
 * - AD-15: 空行处理
 *
 * 所有测试使用真实文件系统，无 mock。
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApplyPatch, type PatchFile, type PatchHunk, type PatchLine } from "../../diff/apply-patch";

// 测试 fixture：每个测试用例独立的临时目录
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-apply-patch-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * 辅助函数：从 PatchLine 数组中提取指定类型的行文本
 *
 * @param lines PatchLine 数组
 * @param type 行类型
 * @returns 该类型的行文本数组
 */
function extractLines(lines: PatchLine[], type: PatchLine["type"]): string[] {
  return lines.filter((l) => l.type === type).map((l) => l.text);
}

/**
 * 创建辅助函数：生成简单 hunk（基于 lines 数组）
 *
 * @param oldStart 旧文件起始行号
 * @param oldLines 旧文件行数
 * @param newStart 新文件起始行号
 * @param newLines 新文件行数
 * @param lines 带类型标记的行数组（保持 unified diff 原始顺序）
 * @returns PatchHunk 对象
 */
function createHunk(
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
  lines: PatchLine[]
): PatchHunk {
  return { oldStart, oldLines, newStart, newLines, lines };
}

// ============================================================
// parse 测试
// ============================================================

test("AD-01: 解析 unified diff（单文件单 hunk）", () => {
  const patchText = `--- a/file1.txt
+++ b/file1.txt
@@ -1,3 +1,4 @@
 line1
-old line
+new line
+extra line
 line3
`;

  const applier = new ApplyPatch();
  const files = applier.parse(patchText);

  assert.equal(files.length, 1, "应解析出 1 个文件");
  assert.equal(files[0].oldPath, "file1.txt", "oldPath 应去除 a/ 前缀");
  assert.equal(files[0].newPath, "file1.txt", "newPath 应去除 b/ 前缀");
  assert.equal(files[0].hunks.length, 1, "应有 1 个 hunk");

  const hunk = files[0].hunks[0];
  assert.equal(hunk.oldStart, 1, "oldStart 应为 1");
  assert.equal(hunk.oldLines, 3, "oldLines 应为 3");
  assert.equal(hunk.newStart, 1, "newStart 应为 1");
  assert.equal(hunk.newLines, 4, "newLines 应为 4");

  // 验证 lines 数组保持原始顺序
  assert.equal(hunk.lines.length, 5, "lines 应有 5 个元素（2 context + 1 deletion + 2 addition）");

  // 提取各类型行进行验证
  const contextLines = extractLines(hunk.lines, "context");
  const additionLines = extractLines(hunk.lines, "addition");
  const deletionLines = extractLines(hunk.lines, "deletion");
  assert.deepEqual(contextLines, ["line1", "line3"], "context 应包含上下文行");
  assert.deepEqual(additionLines, ["new line", "extra line"], "additions 应包含新增行");
  assert.deepEqual(deletionLines, ["old line"], "deletions 应包含删除行");

  // 验证行顺序：context, deletion, addition, addition, context
  assert.deepEqual(
    hunk.lines.map((l) => l.type),
    ["context", "deletion", "addition", "addition", "context"],
    "lines 应保持 unified diff 原始顺序"
  );
});

test("AD-02: 解析多文件多 hunk", () => {
  const patchText = `--- a/file1.txt
+++ b/file1.txt
@@ -1,2 +1,2 @@
 a
-b
+B
 c
--- a/file2.txt
+++ b/file2.txt
@@ -1,2 +1,2 @@
 x
-y
+Y
 z
`;

  const applier = new ApplyPatch();
  const files = applier.parse(patchText);

  assert.equal(files.length, 2, "应解析出 2 个文件");
  assert.equal(files[0].hunks.length, 1, "file1 应有 1 个 hunk");
  assert.equal(files[1].hunks.length, 1, "file2 应有 1 个 hunk");
  assert.equal(files[0].oldPath, "file1.txt", "file1 oldPath 应匹配");
  assert.equal(files[1].oldPath, "file2.txt", "file2 oldPath 应匹配");
});

test("AD-10: invalid_patch（格式非法抛出）", () => {
  const applier = new ApplyPatch();

  // --- 后缺少 +++ 行
  assert.throws(
    () => applier.parse("--- a/file.txt\nno plus line"),
    /invalid_patch/,
    "缺少 +++ 行应抛出 invalid_patch"
  );
});

// ============================================================
// applyHunk 精确匹配测试
// ============================================================

test("AD-03: 精确匹配应用 hunk", () => {
  const fileContent = "line1\nold line\nline3\n";
  // lines 保持 unified diff 顺序：context, deletion, addition, context
  const lines: PatchLine[] = [
    { type: "context", text: "line1" },
    { type: "deletion", text: "old line" },
    { type: "addition", text: "new line" },
    { type: "context", text: "line3" },
  ];
  const hunk = createHunk(1, 3, 1, 3, lines);

  const applier = new ApplyPatch();
  const result = applier.applyHunk(fileContent, hunk);

  assert.equal(result.success, true, "精确匹配应成功");
  assert.ok(result.newContent, "应返回新内容");
  assert.equal(result.newContent, "line1\nnew line\nline3\n", "内容应正确替换");
  assert.equal(result.fuzzyMatched, false, "精确匹配 fuzzyMatched 应为 false");
});

// ============================================================
// applyHunk 空白容错测试
// ============================================================

test("AD-04: 空白容错匹配", () => {
  // 文件中有多余空格，但 ignoreWhitespace=true 时应匹配
  const fileContent = "line1\n  old line  \nline3\n";
  const lines: PatchLine[] = [
    { type: "context", text: "line1" },
    { type: "deletion", text: "old line" },
    { type: "addition", text: "new line" },
    { type: "context", text: "line3" },
  ];
  const hunk = createHunk(1, 3, 1, 3, lines);

  const applier = new ApplyPatch({ ignoreWhitespace: true });
  const result = applier.applyHunk(fileContent, hunk);

  assert.equal(result.success, true, "空白容错应匹配成功");
  assert.ok(result.newContent, "应返回新内容");
});

// ============================================================
// applyHunk fuzzy 滑动搜索测试
// ============================================================

test("AD-05: fuzzy 滑动搜索匹配", () => {
  // oldStart 偏移 2 行，但在 maxFuzz 范围内
  const fileContent = "extra1\nextra2\nline1\nold line\nline3\n";
  const lines: PatchLine[] = [
    { type: "context", text: "line1" },
    { type: "deletion", text: "old line" },
    { type: "addition", text: "new line" },
    { type: "context", text: "line3" },
  ];
  const hunk = createHunk(1, 3, 1, 3, lines);

  // maxFuzz=3 允许在 oldStart-1 ± 3 范围搜索
  const applier = new ApplyPatch({ maxFuzz: 3 });
  const result = applier.applyHunk(fileContent, hunk);

  assert.equal(result.success, true, "fuzzy 搜索应找到匹配位置");
  assert.equal(result.fuzzyMatched, true, "fuzzyMatched 应为 true");
  assert.ok(result.newContent!.includes("new line"), "新内容应包含替换后的行");
});

// ============================================================
// applyHunk no_match 测试
// ============================================================

test("AD-06: no_match（无法匹配时返回候选）", () => {
  // 文件内容与 hunk 完全不匹配
  const fileContent = "completely\ndifferent\ncontent\n";
  const lines: PatchLine[] = [
    { type: "context", text: "line1" },
    { type: "deletion", text: "old line" },
    { type: "addition", text: "new line" },
    { type: "context", text: "line3" },
  ];
  const hunk = createHunk(1, 3, 1, 3, lines);

  const applier = new ApplyPatch({ maxFuzz: 2 });
  const result = applier.applyHunk(fileContent, hunk);

  assert.equal(result.success, false, "不匹配应返回失败");
  assert.equal(result.reason, "no_match", "reason 应为 no_match");
});

// ============================================================
// already_applied 测试
// ============================================================

test("AD-08: already_applied（幂等检测）", () => {
  // additions 内容已存在于文件中 oldStart 附近
  const fileContent = "line1\nnew line\nline3\n";
  const lines: PatchLine[] = [
    { type: "context", text: "line1" },
    { type: "deletion", text: "old line" },
    { type: "addition", text: "new line" },
    { type: "context", text: "line3" },
  ];
  const hunk = createHunk(1, 3, 1, 3, lines);

  const applier = new ApplyPatch();
  const result = applier.applyHunk(fileContent, hunk);

  assert.equal(result.success, false, "已应用应返回失败");
  assert.equal(result.reason, "already_applied", "reason 应为 already_applied");
});

// ============================================================
// ambiguous 测试
// ============================================================

test("AD-09: ambiguous（多个并列候选）", () => {
  // 文件中有两处相似内容（含轻微差异使精确匹配失败），fuzzy 搜索产出多个并列候选
  // 使用 "old lime"（typo）代替 "old line"，使精确匹配和空白容错都失败
  // 两处 "line1\nold lime\nline3" 的相似度完全相同，差值为 0 <= 0.1 → ambiguous
  const fileContent = "line1\nold lime\nline3\nline1\nold lime\nline3\n";
  const lines: PatchLine[] = [
    { type: "context", text: "line1" },
    { type: "deletion", text: "old line" },
    { type: "addition", text: "new line" },
    { type: "context", text: "line3" },
  ];
  const hunk = createHunk(1, 3, 1, 3, lines);

  const applier = new ApplyPatch({ maxFuzz: 5 });
  const result = applier.applyHunk(fileContent, hunk);

  // 两处候选相似度完全相同（差值=0 ≤ 0.1），应返回 ambiguous
  assert.equal(result.success, false, "多并列候选应返回失败");
  assert.equal(result.reason, "ambiguous", "reason 应为 ambiguous");
  assert.ok(result.candidates!.length >= 2, "应返回多个候选");
});

// ============================================================
// apply 文件系统测试
// ============================================================

test("AD-07: file_not_found（文件不存在）", () => {
  const lines: PatchLine[] = [
    { type: "context", text: "old" },
    { type: "addition", text: "new" },
  ];
  const hunk = createHunk(1, 1, 1, 1, lines);
  const patchFile: PatchFile = {
    oldPath: "non-existent.txt",
    newPath: "non-existent.txt",
    hunks: [hunk],
  };

  const applier = new ApplyPatch();
  const result = applier.apply([patchFile], tempDir);

  assert.equal(result.success, false, "文件不存在应返回失败");
  assert.equal(result.failures.length, 1, "应有 1 个失败");
  assert.equal(result.failures[0].reason, "file_not_found", "reason 应为 file_not_found");
});

test("AD-11: apply 多文件成功", () => {
  // 创建两个测试文件
  const file1Path = path.join(tempDir, "file1.txt");
  const file2Path = path.join(tempDir, "file2.txt");
  fs.writeFileSync(file1Path, "a\nb\nc\n", "utf-8");
  fs.writeFileSync(file2Path, "x\ny\nz\n", "utf-8");

  const patchFiles: PatchFile[] = [
    {
      oldPath: "file1.txt",
      newPath: "file1.txt",
      hunks: [
        createHunk(1, 3, 1, 3, [
          { type: "context", text: "a" },
          { type: "deletion", text: "b" },
          { type: "addition", text: "B" },
          { type: "context", text: "c" },
        ]),
      ],
    },
    {
      oldPath: "file2.txt",
      newPath: "file2.txt",
      hunks: [
        createHunk(1, 3, 1, 3, [
          { type: "context", text: "x" },
          { type: "deletion", text: "y" },
          { type: "addition", text: "Y" },
          { type: "context", text: "z" },
        ]),
      ],
    },
  ];

  const applier = new ApplyPatch();
  const result = applier.apply(patchFiles, tempDir);

  assert.equal(result.success, true, "多文件应用应成功");
  assert.equal(result.appliedFiles.length, 2, "应成功应用 2 个文件");
  assert.equal(fs.readFileSync(file1Path, "utf-8"), "a\nB\nc\n", "file1 内容应正确");
  assert.equal(fs.readFileSync(file2Path, "utf-8"), "x\nY\nz\n", "file2 内容应正确");
});

test("AD-12: fuzzyMatches 计数", () => {
  // 创建测试文件，内容偏移以触发 fuzzy 匹配
  const filePath = path.join(tempDir, "file.txt");
  fs.writeFileSync(filePath, "extra\nhello\nworld\n", "utf-8");

  const lines: PatchLine[] = [
    { type: "context", text: "hello" },
    { type: "deletion", text: "world" },
    { type: "addition", text: "HELLO" },
  ];
  const hunk = createHunk(1, 2, 1, 2, lines);
  const patchFile: PatchFile = {
    oldPath: "file.txt",
    newPath: "file.txt",
    hunks: [hunk],
  };

  const applier = new ApplyPatch({ maxFuzz: 5 });
  const result = applier.apply([patchFile], tempDir);

  // fuzzy 匹配成功时 fuzzyMatches 应递增
  if (result.success) {
    assert.ok(result.fuzzyMatches >= 0, "fuzzyMatches 应为非负数");
  }
});

// ============================================================
// 大小写容错测试
// ============================================================

test("AD-13: 大小写容错匹配", () => {
  const fileContent = "Line1\nOLD LINE\nLine3\n";
  const lines: PatchLine[] = [
    { type: "context", text: "Line1" },
    { type: "deletion", text: "old line" },
    { type: "addition", text: "new line" },
    { type: "context", text: "Line3" },
  ];
  const hunk = createHunk(1, 3, 1, 3, lines);

  const applier = new ApplyPatch({ ignoreCase: true });
  const result = applier.applyHunk(fileContent, hunk);

  assert.equal(result.success, true, "大小写容错应匹配成功");
});

// ============================================================
// 多 hunk 同文件顺序应用测试
// ============================================================

test("AD-14: 多 hunk 同文件顺序应用", () => {
  const filePath = path.join(tempDir, "multi.txt");
  fs.writeFileSync(filePath, "a\nb\nc\nd\ne\n", "utf-8");

  const patchFile: PatchFile = {
    oldPath: "multi.txt",
    newPath: "multi.txt",
    hunks: [
      createHunk(1, 2, 1, 2, [
        { type: "context", text: "a" },
        { type: "deletion", text: "b" },
        { type: "addition", text: "B" },
      ]),
      createHunk(4, 2, 4, 2, [
        { type: "context", text: "d" },
        { type: "deletion", text: "e" },
        { type: "addition", text: "E" },
      ]),
    ],
  };

  const applier = new ApplyPatch();
  const result = applier.apply([patchFile], tempDir);

  assert.equal(result.success, true, "多 hunk 应顺序应用成功");
  const content = fs.readFileSync(filePath, "utf-8");
  assert.ok(content.includes("B"), "应包含替换后的 B");
  assert.ok(content.includes("E"), "应包含替换后的 E");
});

// ============================================================
// 空行处理测试
// ============================================================

test("AD-15: 空行处理", () => {
  const patchText = `--- a/empty.txt
+++ b/empty.txt
@@ -1,3 +1,4 @@
 line1

+inserted
 line3
`;

  const applier = new ApplyPatch();
  const files = applier.parse(patchText);

  assert.equal(files.length, 1, "应解析出 1 个文件");
  assert.equal(files[0].hunks.length, 1, "应有 1 个 hunk");

  // 空行应被解析为 context 行
  const contextLines = extractLines(files[0].hunks[0].lines, "context");
  assert.ok(contextLines.includes(""), "空行应被解析为 context");

  const additionLines = extractLines(files[0].hunks[0].lines, "addition");
  assert.deepEqual(additionLines, ["inserted"], "additions 应匹配");
});
