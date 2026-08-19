/**
 * 单元测试：lcov 合并去重脚本（S1-D6）
 *
 * 测试范围：
 * - T1. 解析：单 section 结构完整提取（TN:/SF: ... end_of_record）
 * - T2. 解析：多 section 顺序提取
 * - T3. 解析：SF: 行缺少路径 → 抛错（fail-closed）
 * - T4. 解析：section 缺少 end_of_record → 抛错（fail-closed）
 * - T5. 解析：兼容 \r\n 换行
 * - T6. 解析：文件头部垃圾行（首个 SF 之前的注释）保留在 preamble
 * - T7. 去重：无重复时全量保留且顺序不变
 * - T8. 去重：同 SF 两条 section 保留累计命中数（LH+BRH+FNH）更大的一条
 * - T9. 去重：平局保留首次出现的那条（输出确定性）
 * - T10. 去重：跨包同名 SF（不同物理文件同名字符串）同样按命中数择优
 * - T11. 去重：明细 dedupedGroups 仅报告发生丢弃的分组
 * - T12. 序列化：输出以换行结尾、section 之间无空行堆积
 * - T13. 序列化：preamble 空行被过滤
 * - T14. CLI：真实子进程去重含重复的 lcov 文件 → 退出码 0、输出文件正确、stderr 含摘要
 * - T15. CLI：无重复的 lcov 原样语义保留（section 数不变）→ 退出码 0
 * - T16. CLI：参数缺失 → 退出码 1
 * - T17. CLI：输入文件不存在 → 退出码 1
 * - T18. CLI：--help → 退出码 0
 * - T19. CLI：格式损坏（end_of_record 缺失）→ 退出码 1
 * - T20. 端到端：去重后输出可被 check-coverage-threshold.js 正确消费（计数字段不重复累加）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实临时文件 + 真实 CLI 子进程调用
 *
 * 设计依据：
 * - docs/optimization-plan-20260819.md §2.2 D6（lcov SF 重复统计风险）
 * - scripts/dedupe-lcov.js（被测脚本）
 *
 * @module core/tests/lcov-dedupe
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseLcovSections, dedupeBySf, serializeLcov } from "../../../../scripts/dedupe-lcov.js";

// ============================================================================
// 路径与 fixture
// ============================================================================

/**
 * 被测脚本路径：scripts/dedupe-lcov.js
 *
 * 使用 import.meta.url 推算项目根目录，避免硬编码绝对路径。
 * 测试文件位于 packages/core/src/tests/，回退 4 级到项目根 DeepCodeX-cli：
 *   - ../           → packages/core/src/
 *   - ../../        → packages/core/
 *   - ../../../     → packages/
 *   - ../../../../  → DeepCodeX-cli/（项目根）
 */
const testFilename = fileURLToPath(import.meta.url);
const testDirname = path.dirname(testFilename);
const PROJECT_ROOT = path.resolve(testDirname, "../../../..");
const SCRIPT_PATH = path.join(PROJECT_ROOT, "scripts", "dedupe-lcov.js");

/** 覆盖率阈值脚本路径（T20 端到端消费方） */
const THRESHOLD_SCRIPT_PATH = path.join(PROJECT_ROOT, "scripts", "check-coverage-threshold.js");

/**
 * 构造一条标准 lcov section 文本
 *
 * @param {string} sf - SF 路径
 * @param {{lf: number, lh: number, brf: number, brh: number, fnf: number, fnh: number}} counters - 六项计数
 * @returns {string} section 完整文本（含首尾换行语义）
 */
function makeSection(sf, counters) {
  return [
    "TN:",
    `SF:${sf}`,
    `FN:1,doWork`,
    `FNDA:${counters.fnh},doWork`,
    `FNF:${counters.fnf}`,
    `FNH:${counters.fnh}`,
    "BRDA:2,0,0,1",
    `BRF:${counters.brf}`,
    `BRH:${counters.brh}`,
    "DA:1,1",
    `LF:${counters.lf}`,
    `LH:${counters.lh}`,
    "end_of_record",
    "",
  ].join("\n");
}

/** 每个测试用例独立的临时目录（真实文件系统，禁止 mock） */
let tempDir;

test.beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lcov-dedupe-test-"));
});

test.afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ============================================================================
// 解析：parseLcovSections
// ============================================================================

test("T1. 解析：单 section 结构完整提取（含 TN: 归属）", () => {
  const content = makeSection("src/a.ts", { lf: 10, lh: 5, brf: 4, brh: 2, fnf: 3, fnh: 1 });
  const { preamble, sections } = parseLcovSections(content);

  assert.equal(sections.length, 1);
  assert.equal(sections[0].sf, "src/a.ts");
  // TN: 行归属 section 而非 preamble（preamble 仅剩内容末尾换行产生的空串，无有效行）
  assert.equal(preamble.filter((line) => line.length > 0).length, 0);
  assert.ok(sections[0].lines[0].startsWith("TN:"));
  assert.ok(sections[0].lines.includes("end_of_record"));
  // 累计命中数 = LH(5) + BRH(2) + FNH(1) = 8
  assert.equal(sections[0].accumulatedHits, 8);
});

test("T2. 解析：多 section 顺序提取", () => {
  const content =
    makeSection("src/a.ts", { lf: 10, lh: 5, brf: 4, brh: 2, fnf: 3, fnh: 1 }) +
    makeSection("src/b.ts", { lf: 20, lh: 10, brf: 8, brh: 4, fnf: 6, fnh: 2 });
  const { sections } = parseLcovSections(content);

  assert.equal(sections.length, 2);
  assert.equal(sections[0].sf, "src/a.ts");
  assert.equal(sections[1].sf, "src/b.ts");
});

test("T3. 解析：SF: 行缺少路径抛错（fail-closed）", () => {
  assert.throws(() => parseLcovSections("SF:\nend_of_record\n"), /缺少源文件路径/);
});

test("T4. 解析：section 缺少 end_of_record 抛错（fail-closed）", () => {
  assert.throws(() => parseLcovSections("SF:src/a.ts\nLF:10\n"), /缺少 end_of_record/);
});

test("T5. 解析：兼容 \\r\\n 换行", () => {
  const content = makeSection("src/a.ts", {
    lf: 10,
    lh: 5,
    brf: 4,
    brh: 2,
    fnf: 3,
    fnh: 1,
  }).replace(/\n/g, "\r\n");
  const { sections } = parseLcovSections(content);

  assert.equal(sections.length, 1);
  assert.equal(sections[0].sf, "src/a.ts");
  assert.equal(sections[0].accumulatedHits, 8);
});

test("T6. 解析：文件头部垃圾行保留在 preamble", () => {
  const content = "# 注释行\n\n" + makeSection("src/a.ts", { lf: 10, lh: 5, brf: 4, brh: 2, fnf: 3, fnh: 1 });
  const { preamble, sections } = parseLcovSections(content);

  assert.equal(sections.length, 1);
  assert.equal(preamble[0], "# 注释行");
});

// ============================================================================
// 去重：dedupeBySf
// ============================================================================

test("T7. 去重：无重复时全量保留且顺序不变", () => {
  const { sections } = parseLcovSections(
    makeSection("src/a.ts", { lf: 10, lh: 5, brf: 4, brh: 2, fnf: 3, fnh: 1 }) +
      makeSection("src/b.ts", { lf: 20, lh: 10, brf: 8, brh: 4, fnf: 6, fnh: 2 })
  );
  const { keptSections, dedupedGroups } = dedupeBySf(sections);

  assert.equal(keptSections.length, 2);
  assert.deepEqual(
    keptSections.map((s) => s.sf),
    ["src/a.ts", "src/b.ts"]
  );
  assert.equal(dedupedGroups.length, 0);
});

test("T8. 去重：同 SF 保留累计命中数更大的一条", () => {
  // 第一条命中 8（LH5+BRH2+FNH1），第二条命中 16（LH10+BRH4+FNH2）
  const { sections } = parseLcovSections(
    makeSection("src/a.ts", { lf: 10, lh: 5, brf: 4, brh: 2, fnf: 3, fnh: 1 }) +
      makeSection("src/b.ts", { lf: 20, lh: 10, brf: 8, brh: 4, fnf: 6, fnh: 2 }) +
      makeSection("src/a.ts", { lf: 10, lh: 10, brf: 4, brh: 4, fnf: 3, fnh: 2 })
  );
  const { keptSections, dedupedGroups } = dedupeBySf(sections);

  assert.equal(keptSections.length, 2);
  // src/a.ts 保留命中数 16 的第二条
  const keptA = keptSections.find((s) => s.sf === "src/a.ts");
  assert.equal(keptA.accumulatedHits, 16);
  assert.ok(keptA.lines.includes("LH:10"));
  // 明细报告 1 个分组、丢弃 1 条
  assert.equal(dedupedGroups.length, 1);
  assert.equal(dedupedGroups[0].sf, "src/a.ts");
  assert.equal(dedupedGroups[0].dropped, 1);
  assert.equal(dedupedGroups[0].kept, 16);
});

test("T9. 去重：平局保留首次出现的一条（输出确定性）", () => {
  const { sections } = parseLcovSections(
    makeSection("src/a.ts", { lf: 10, lh: 5, brf: 4, brh: 2, fnf: 3, fnh: 1 }) +
      makeSection("src/a.ts", { lf: 10, lh: 5, brf: 4, brh: 2, fnf: 3, fnh: 1 })
  );
  const { keptSections } = dedupeBySf(sections);

  assert.equal(keptSections.length, 1);
  // 两条完全一致时保留首条：LF 值相同无法区分，改用对象引用断言
  assert.strictEqual(keptSections[0], sections[0]);
});

test("T10. 去重：跨包同名 SF（不同物理文件同名字符串）按命中数择优", () => {
  // 模拟 core-v2 与 quality 各产出一条 ../codemap/generator.ts
  const { sections } = parseLcovSections(
    makeSection("../codemap/generator.ts", { lf: 100, lh: 30, brf: 40, brh: 10, fnf: 20, fnh: 5 }) +
      makeSection("../codemap/generator.ts", { lf: 60, lh: 50, brf: 20, brh: 15, fnf: 10, fnh: 8 })
  );
  const { keptSections, dedupedGroups } = dedupeBySf(sections);

  // 命中数：第一条 30+10+5=45，第二条 50+15+8=73 → 保留第二条
  assert.equal(keptSections.length, 1);
  assert.equal(keptSections[0].accumulatedHits, 73);
  assert.equal(dedupedGroups.length, 1);
});

test("T11. 去重：明细仅报告发生丢弃的分组", () => {
  const { sections } = parseLcovSections(
    makeSection("src/a.ts", { lf: 10, lh: 5, brf: 4, brh: 2, fnf: 3, fnh: 1 }) +
      makeSection("src/b.ts", { lf: 20, lh: 10, brf: 8, brh: 4, fnf: 6, fnh: 2 }) +
      makeSection("src/b.ts", { lf: 20, lh: 1, brf: 8, brh: 0, fnf: 6, fnh: 0 })
  );
  const { dedupedGroups } = dedupeBySf(sections);

  // src/a.ts 无重复不应出现在明细
  assert.equal(dedupedGroups.length, 1);
  assert.equal(dedupedGroups[0].sf, "src/b.ts");
});

// ============================================================================
// 序列化：serializeLcov
// ============================================================================

test("T12. 序列化：输出以换行结尾且 section 内容原样保留", () => {
  const { preamble, sections } = parseLcovSections(
    makeSection("src/a.ts", { lf: 10, lh: 5, brf: 4, brh: 2, fnf: 3, fnh: 1 })
  );
  const output = serializeLcov(preamble, sections);

  assert.ok(output.endsWith("\n"));
  assert.ok(output.includes("SF:src/a.ts"));
  assert.ok(output.includes("end_of_record"));
  // 可被重新解析（往返一致）
  const reparsed = parseLcovSections(output);
  assert.equal(reparsed.sections.length, 1);
});

test("T13. 序列化：preamble 空行被过滤", () => {
  const output = serializeLcov(["", "# comment", ""], []);
  assert.equal(output, "# comment\n");
});

// ============================================================================
// CLI：真实子进程调用
// ============================================================================

test("T14. CLI：含重复的 lcov 去重成功（退出码 0 + 摘要输出）", () => {
  const input = path.join(tempDir, "in.lcov");
  const output = path.join(tempDir, "out.lcov");
  fs.writeFileSync(
    input,
    makeSection("src/a.ts", { lf: 10, lh: 5, brf: 4, brh: 2, fnf: 3, fnh: 1 }) +
      makeSection("src/a.ts", { lf: 10, lh: 9, brf: 4, brh: 3, fnf: 3, fnh: 2 }) +
      makeSection("src/b.ts", { lf: 20, lh: 10, brf: 8, brh: 4, fnf: 6, fnh: 2 }),
    "utf-8"
  );

  const result = spawnSync(process.execPath, [SCRIPT_PATH, input, output], {
    encoding: "utf-8",
  });

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  // 摘要输出在 stderr
  assert.ok(result.stderr.includes("lcov 去重完成"));
  assert.ok(result.stderr.includes("section 3 → 2"));
  // 输出文件仅含 2 个 section
  const outContent = fs.readFileSync(output, "utf-8");
  assert.equal((outContent.match(/^SF:/gm) || []).length, 2);
  // 保留的是命中数更大的第二条 a.ts（LH:9）
  assert.ok(outContent.includes("LH:9"));
});

test("T15. CLI：无重复的 lcov 原样语义保留（section 数不变）", () => {
  const input = path.join(tempDir, "in.lcov");
  const output = path.join(tempDir, "out.lcov");
  fs.writeFileSync(
    input,
    makeSection("src/a.ts", { lf: 10, lh: 5, brf: 4, brh: 2, fnf: 3, fnh: 1 }) +
      makeSection("src/b.ts", { lf: 20, lh: 10, brf: 8, brh: 4, fnf: 6, fnh: 2 }),
    "utf-8"
  );

  const result = spawnSync(process.execPath, [SCRIPT_PATH, input, output], {
    encoding: "utf-8",
  });

  assert.equal(result.status, 0);
  assert.ok(result.stderr.includes("丢弃 0 条"));
  const outContent = fs.readFileSync(output, "utf-8");
  assert.equal((outContent.match(/^SF:/gm) || []).length, 2);
});

test("T16. CLI：参数缺失退出码 1", () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: "utf-8" });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("参数非法"));
});

test("T17. CLI：输入文件不存在退出码 1", () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, path.join(tempDir, "nonexistent.lcov"), path.join(tempDir, "out.lcov")],
    { encoding: "utf-8" }
  );
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("不存在"));
});

test("T18. CLI：--help 退出码 0", () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, "--help"], {
    encoding: "utf-8",
  });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("lcov 合并去重脚本"));
});

test("T19. CLI：格式损坏（end_of_record 缺失）退出码 1", () => {
  const input = path.join(tempDir, "broken.lcov");
  const output = path.join(tempDir, "out.lcov");
  fs.writeFileSync(input, "SF:src/a.ts\nLF:10\n", "utf-8");

  const result = spawnSync(process.execPath, [SCRIPT_PATH, input, output], {
    encoding: "utf-8",
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("解析失败"));
});

test("T20. 端到端：去重后输出可被阈值脚本正确消费（计数不重复累加）", () => {
  // 构造：同一文件两条 section（各 LF=10/LH=5），未去重时阈值脚本会算出
  // LF=20/LH=10（50%）；去重后应为 LF=10/LH=5（50% 持平）。
  // 为体现「去重避免低估并集」，第二条 section 覆盖不同行：LH=10。
  // 去重保留命中数更大的第二条 → 阈值脚本读到 LF=10/LH=10 = 100%。
  const input = path.join(tempDir, "in.lcov");
  const deduped = path.join(tempDir, "deduped.lcov");
  fs.writeFileSync(
    input,
    makeSection("src/a.ts", { lf: 10, lh: 5, brf: 4, brh: 2, fnf: 3, fnh: 1 }) +
      makeSection("src/a.ts", { lf: 10, lh: 10, brf: 4, brh: 4, fnf: 3, fnh: 3 }),
    "utf-8"
  );

  const dedupeResult = spawnSync(process.execPath, [SCRIPT_PATH, input, deduped], {
    encoding: "utf-8",
  });
  assert.equal(dedupeResult.status, 0);

  // 阈值脚本消费去重后文件：行覆盖率应为 100%（LF=10/LH=10）
  const thresholdResult = spawnSync(
    process.execPath,
    [THRESHOLD_SCRIPT_PATH, deduped, "--lines", "80", "--branches", "70", "--functions", "85"],
    { encoding: "utf-8" }
  );
  assert.equal(thresholdResult.status, 0, `stdout: ${thresholdResult.stdout}`);
  assert.ok(thresholdResult.stdout.includes("行覆盖率：100.00%"));
});
