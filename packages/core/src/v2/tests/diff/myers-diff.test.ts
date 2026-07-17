import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMyersDiff, groupIntoHunks, computeStats, type DiffOp } from "../../diff/myers-diff";

/**
 * Myers diff 算法单元测试
 *
 * 测试覆盖：
 * - DR-09: Myers 算法 LCS 基础场景（相同/新增/删除/修改/经典案例）
 * - groupIntoHunks: hunk 分组逻辑（contextLines 0 和 3）
 * - computeStats: 统计信息计算
 * - 行号正确性验证
 * - 边界情况（空输入、单行、大文件降级）
 */

test("DR-09: Myers 算法 LCS - 完全相同", () => {
  const ops = computeMyersDiff(["A", "B", "C"], ["A", "B", "C"]);
  // 完全相同的内容应全部为 equal 操作
  assert.equal(ops.length, 3);
  assert.ok(ops.every((op) => op.type === "equal"));
  // 验证行号正确：oldLineNo 和 newLineNo 都从 1 开始
  assert.equal(ops[0].oldLineNo, 1);
  assert.equal(ops[0].newLineNo, 1);
  assert.equal(ops[2].oldLineNo, 3);
  assert.equal(ops[2].newLineNo, 3);
});

test("DR-09: Myers 算法 LCS - 纯新增", () => {
  const ops = computeMyersDiff([], ["A", "B"]);
  // 原始为空，全部为新增
  assert.equal(ops.length, 2);
  assert.ok(ops.every((op) => op.type === "insert"));
  // 验证新行号
  assert.equal(ops[0].newLineNo, 1);
  assert.equal(ops[1].newLineNo, 2);
  // insert 操作不应有 oldLineNo
  assert.equal(ops[0].oldLineNo, undefined);
});

test("DR-09: Myers 算法 LCS - 纯删除", () => {
  const ops = computeMyersDiff(["A", "B"], []);
  // 新序列为空，全部为删除
  assert.equal(ops.length, 2);
  assert.ok(ops.every((op) => op.type === "delete"));
  // 验证旧行号
  assert.equal(ops[0].oldLineNo, 1);
  assert.equal(ops[1].oldLineNo, 2);
  // delete 操作不应有 newLineNo
  assert.equal(ops[0].newLineNo, undefined);
});

test("DR-09: Myers 算法 LCS - 修改单行", () => {
  const ops = computeMyersDiff(["A", "B", "C"], ["A", "D", "C"]);
  // 中间行 B 被替换为 D，应为 equal A, delete B, insert D, equal C
  assert.equal(ops.length, 4);
  assert.equal(ops[0].type, "equal");
  assert.equal(ops[0].text, "A");
  assert.equal(ops[1].type, "delete");
  assert.equal(ops[1].text, "B");
  assert.equal(ops[2].type, "insert");
  assert.equal(ops[2].text, "D");
  assert.equal(ops[3].type, "equal");
  assert.equal(ops[3].text, "C");
});

test("DR-09: Myers 算法 LCS - 经典 ABCABBA vs CBABBA", () => {
  const ops = computeMyersDiff("ABCABBA".split(""), "CBABBA".split(""));
  // Myers 论文经典示例
  // LCS = "BABBA"（长度 5），SES = (7-5) + (6-5) = 3
  // 但论文中给出的最大编辑距离为 5，这里验证 changes <= 5
  const stats = computeStats(ops);
  assert.ok(stats.changes <= 5, `期望 changes <= 5，实际 ${stats.changes}`);
  // 验证操作序列能正确重构：删除旧行 + 插入新行 + 保留匹配行
  // 从 ops 重建 newLines：取 insert + equal 的 text 按 newLineNo 顺序
  const reconstructed: string[] = [];
  for (const op of ops) {
    if (op.type === "insert" || op.type === "equal") {
      reconstructed.push(op.text);
    }
  }
  assert.deepEqual(reconstructed, "CBABBA".split(""));
});

test("DR-09: Myers 算法 LCS - 验证 oldLines 重构", () => {
  const ops = computeMyersDiff("ABCABBA".split(""), "CBABBA".split(""));
  // 从 ops 重建 oldLines：取 delete + equal 的 text 按 oldLineNo 顺序
  const reconstructed: string[] = [];
  for (const op of ops) {
    if (op.type === "delete" || op.type === "equal") {
      reconstructed.push(op.text);
    }
  }
  assert.deepEqual(reconstructed, "ABCABBA".split(""));
});

test("Myers 算法 - 空输入", () => {
  // 两个空序列
  const ops = computeMyersDiff([], []);
  assert.equal(ops.length, 0);
});

test("Myers 算法 - 单行相同", () => {
  const ops = computeMyersDiff(["hello"], ["hello"]);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, "equal");
});

test("Myers 算法 - 单行不同", () => {
  const ops = computeMyersDiff(["old"], ["new"]);
  // 单行不同应为 delete old + insert new
  assert.equal(ops.length, 2);
  assert.equal(ops[0].type, "delete");
  assert.equal(ops[0].text, "old");
  assert.equal(ops[1].type, "insert");
  assert.equal(ops[1].text, "new");
});

test("Myers 算法 - 多处分散变更", () => {
  // 验证 Myers 能识别文件中间的多处独立变更（prefix/suffix 方法无法处理）
  const oldLines = ["a", "b", "c", "d", "e", "f"];
  const newLines = ["a", "X", "c", "Y", "e", "Z"];
  const ops = computeMyersDiff(oldLines, newLines);
  const stats = computeStats(ops);
  // 3 处变更：b→X, d→Y, f→Z，每处 1 删 1 增 = 6
  assert.equal(stats.additions, 3);
  assert.equal(stats.deletions, 3);
  assert.equal(stats.changes, 6);
  // 验证 equal 行保留：a, c, e 应为 equal
  const equalTexts = ops.filter((op) => op.type === "equal").map((op) => op.text);
  assert.deepEqual(equalTexts, ["a", "c", "e"]);
});

test("Myers 算法 - 行号连续性验证", () => {
  const oldLines = ["line1", "line2", "line3", "line4"];
  const newLines = ["line1", "modified", "line3", "line4"];
  const ops = computeMyersDiff(oldLines, newLines);
  // 验证 equal 操作的行号连续递增
  const equalOps = ops.filter((op) => op.type === "equal");
  assert.equal(equalOps.length, 3);
  assert.equal(equalOps[0].oldLineNo, 1);
  assert.equal(equalOps[0].newLineNo, 1);
  assert.equal(equalOps[1].oldLineNo, 3);
  assert.equal(equalOps[1].newLineNo, 3);
  assert.equal(equalOps[2].oldLineNo, 4);
  assert.equal(equalOps[2].newLineNo, 4);
});

test("groupIntoHunks: contextLines=0", () => {
  const ops = computeMyersDiff(["A", "B", "C"], ["A", "X", "C"]);
  const hunks = groupIntoHunks(ops, 0);
  // contextLines=0 时只含变更行，不含上下文
  assert.ok(hunks.length >= 1);
  // 验证 hunk 中只有 delete 和 insert，没有 equal
  for (const hunk of hunks) {
    const equalOps = hunk.ops.filter((op) => op.type === "equal");
    assert.equal(equalOps.length, 0);
  }
});

test("groupIntoHunks: contextLines=3", () => {
  const ops = computeMyersDiff(["A", "B", "C", "D", "E"], ["A", "B", "X", "D", "E"]);
  const hunks = groupIntoHunks(ops, 3);
  // 含上下文，应包含 equal 操作
  assert.ok(hunks.length >= 1);
  assert.ok(hunks[0].ops.some((op) => op.type === "equal"));
});

test("groupIntoHunks: 多个独立 hunk", () => {
  // 两个相距较远的变更应生成两个独立 hunk
  const oldLines = Array.from({ length: 20 }, (_, i) => `line${i}`);
  const newLines = [...oldLines];
  newLines[2] = "CHANGED1";
  newLines[15] = "CHANGED2";
  const ops = computeMyersDiff(oldLines, newLines);
  const hunks = groupIntoHunks(ops, 2);
  // 两个变更相距 13 行（index 2 和 15），contextLines=2，间隔 > 4，应生成两个 hunk
  assert.equal(hunks.length, 2);
});

test("groupIntoHunks: 相邻变更合并为单个 hunk", () => {
  // 两个相邻的变更应合并到一个 hunk
  const ops = computeMyersDiff(["a", "b", "c"], ["X", "Y", "Z"]);
  const hunks = groupIntoHunks(ops, 3);
  assert.equal(hunks.length, 1);
});

test("groupIntoHunks: 纯插入 hunk 的 oldStart", () => {
  const ops = computeMyersDiff([], ["A", "B"]);
  const hunks = groupIntoHunks(ops, 3);
  assert.equal(hunks.length, 1);
  // 纯插入，oldStart 应为 0（git 约定）
  assert.equal(hunks[0].oldStart, 0);
  assert.equal(hunks[0].oldLines, 0);
  assert.equal(hunks[0].newStart, 1);
  assert.equal(hunks[0].newLines, 2);
});

test("groupIntoHunks: 纯删除 hunk 的 newStart", () => {
  const ops = computeMyersDiff(["A", "B"], []);
  const hunks = groupIntoHunks(ops, 3);
  assert.equal(hunks.length, 1);
  // 纯删除，newStart 应为 0（git 约定）
  assert.equal(hunks[0].newStart, 0);
  assert.equal(hunks[0].newLines, 0);
  assert.equal(hunks[0].oldStart, 1);
  assert.equal(hunks[0].oldLines, 2);
});

test("groupIntoHunks: 空操作序列", () => {
  const hunks = groupIntoHunks([], 3);
  assert.equal(hunks.length, 0);
});

test("groupIntoHunks: hunk 行号范围正确", () => {
  const oldLines = ["a", "b", "c", "d", "e"];
  const newLines = ["a", "b", "X", "d", "e"];
  const ops = computeMyersDiff(oldLines, newLines);
  const hunks = groupIntoHunks(ops, 1);
  assert.equal(hunks.length, 1);
  const hunk = hunks[0];
  // oldStart 应为 2（b 的行号），oldLines 应为 3（b, c, d）
  assert.equal(hunk.oldStart, 2);
  assert.equal(hunk.oldLines, 3);
  // newStart 应为 2，newLines 应为 3（b, X, d）
  assert.equal(hunk.newStart, 2);
  assert.equal(hunk.newLines, 3);
});

test("computeStats: 正确统计", () => {
  const ops: DiffOp[] = [
    { type: "equal", text: "A" },
    { type: "delete", text: "B" },
    { type: "insert", text: "C" },
  ];
  const stats = computeStats(ops);
  assert.equal(stats.additions, 1);
  assert.equal(stats.deletions, 1);
  assert.equal(stats.changes, 2);
});

test("computeStats: 空操作序列", () => {
  const stats = computeStats([]);
  assert.equal(stats.additions, 0);
  assert.equal(stats.deletions, 0);
  assert.equal(stats.changes, 0);
});

test("computeStats: 全部 equal", () => {
  const ops: DiffOp[] = [
    { type: "equal", text: "A" },
    { type: "equal", text: "B" },
  ];
  const stats = computeStats(ops);
  assert.equal(stats.additions, 0);
  assert.equal(stats.deletions, 0);
  assert.equal(stats.changes, 0);
});

test("Myers 算法 - 大文件降级", () => {
  // 超过 NAIVE_DIFF_THRESHOLD (20000) 时应降级为朴素 diff
  // 朴素 diff 全部为 delete + insert
  const oldLines = Array.from({ length: 15000 }, (_, i) => `old${i}`);
  const newLines = Array.from({ length: 15000 }, (_, i) => `new${i}`);
  const ops = computeMyersDiff(oldLines, newLines);
  const stats = computeStats(ops);
  // 朴素 diff：全部删除 + 全部插入
  assert.equal(stats.deletions, 15000);
  assert.equal(stats.additions, 15000);
  // 验证无 equal 操作（朴素 diff 不计算匹配）
  assert.ok(ops.every((op) => op.type !== "equal"));
});
