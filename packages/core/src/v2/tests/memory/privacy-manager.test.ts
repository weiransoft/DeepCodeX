/**
 * MemoryPrivacyManager 单元测试（PRIV-EXP-01 ~ PRIV-DEL-08 + 边界用例）
 *
 * 设计依据：V2_CONTEXT_MEMORY_TECH_DESIGN.md §8.7 隐私管理
 *
 * 测试覆盖：
 * - PRIV-EXP-01: exportAll 导出全部记忆为单一 JSON 文件
 * - PRIV-EXP-02: 导出文件 schema 校验（MemoryExportSchema）
 * - PRIV-EXP-03: 缺失文件段视为 null（不报错）
 * - PRIV-EXP-04: 导出文件名含时间戳（export-<timestamp>.json）
 * - PRIV-EXP-05: 导出计数正确（userGlobalFacts/projects/experiences/changelog）
 * - PRIV-EXP-06: 项目记忆目录扫描（.json 文件聚合为 projects 段）
 * - PRIV-EXP-07: 跳过 export-*.json 和 .corrupted 文件
 * - PRIV-EXP-08: 原子写入（tmp+fsync+rename，落盘即合法）
 * - PRIV-DEL-01: deleteAll 严格匹配 "DELETE ALL"
 * - PRIV-DEL-02: 错误令牌抛 InvalidConfirmTokenError，零文件删除
 * - PRIV-DEL-03: 大小写敏感（"delete all" 小写不通过）
 * - PRIV-DEL-04: 带空格不通过（" DELETE ALL "）
 * - PRIV-DEL-05: 删除全部文件（含 redaction.log 与历史 export-*.json）
 * - PRIV-DEL-06: 空目录幂等（deletedCount=0，不抛错）
 * - PRIV-DEL-07: 删除报告含文件清单与计数
 * - PRIV-DEL-08: 删除后目录保留（不删除目录本身）
 *
 * 所有测试使用真实文件系统（mkdtempSync 临时目录），禁止 mock。
 *
 * @module v2/tests/memory/privacy-manager.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryPrivacyManager, InvalidConfirmTokenError, MemoryExportSchema } from "../../memory/privacy-manager";

// ============================================================================
// 测试 fixture：每个用例独立的临时 memoryDir 与 projectMemoryDir
// ============================================================================

let tempMemoryDir: string;
let tempProjectMemoryDir: string;

beforeEach(() => {
  tempMemoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-privacy-memory-"));
  tempProjectMemoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-privacy-project-"));
});

afterEach(() => {
  fs.rmSync(tempMemoryDir, { recursive: true, force: true });
  fs.rmSync(tempProjectMemoryDir, { recursive: true, force: true });
});

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 写入 JSON 文件
 */
function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

// ============================================================================
// PRIV-EXP-01 ~ PRIV-EXP-08 导出测试用例
// ============================================================================

test("PRIV-EXP-01: exportAll 导出全部记忆为单一 JSON 文件", async () => {
  // 准备：在 memoryDir 写入 user-global / experience / changelog
  writeJson(path.join(tempMemoryDir, "global.json"), {
    facts: [{ key: "lang", value: "TypeScript" }],
  });
  writeJson(path.join(tempMemoryDir, "experience.json"), {
    entries: [{ id: "exp1", summary: "test" }],
  });
  writeJson(path.join(tempMemoryDir, "changelog.json"), {
    entries: [{ id: "chg1", action: "add" }],
  });

  // 在 projectMemoryDir 写入两个项目记忆
  writeJson(path.join(tempProjectMemoryDir, "proj-alpha.json"), { memory: "alpha" });
  writeJson(path.join(tempProjectMemoryDir, "proj-beta.json"), { memory: "beta" });

  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);
  const result = await manager.exportAll();

  // 验证导出文件存在
  assert.ok(fs.existsSync(result.exportPath), "导出文件应存在");
  assert.ok(path.basename(result.exportPath).startsWith("export-"), "文件名应以 export- 开头");
  assert.ok(path.basename(result.exportPath).endsWith(".json"), "文件名应以 .json 结尾");
});

test("PRIV-EXP-02: 导出文件 schema 校验（MemoryExportSchema）", async () => {
  writeJson(path.join(tempMemoryDir, "global.json"), { facts: [] });

  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);
  const result = await manager.exportAll();

  // 读取导出文件并校验 schema
  const content = fs.readFileSync(result.exportPath, "utf8");
  const exported = JSON.parse(content);

  const parsed = MemoryExportSchema.safeParse(exported);
  assert.ok(parsed.success, "导出文件应通过 MemoryExportSchema 校验");
  if (parsed.success) {
    assert.equal(parsed.data.schemaVersion, 1);
    assert.ok(parsed.data.exportedAt, "应含 exportedAt 时间戳");
  }
});

test("PRIV-EXP-03: 缺失文件段视为 null（不报错）", async () => {
  // memoryDir 完全为空（不创建任何文件）
  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);
  const result = await manager.exportAll();

  const content = fs.readFileSync(result.exportPath, "utf8");
  const exported = JSON.parse(content);

  assert.equal(exported.userGlobal, null, "缺失 global.json 时 userGlobal 应为 null");
  assert.equal(exported.experiences, null, "缺失 experience.json 时 experiences 应为 null");
  assert.equal(exported.changelog, null, "缺失 changelog.json 时 changelog 应为 null");
  assert.deepEqual(exported.projects, {}, "缺失项目记忆时 projects 应为空对象");
});

test("PRIV-EXP-04: 导出文件名含时间戳（export-<timestamp>.json）", async () => {
  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);
  const result = await manager.exportAll();

  const fileName = path.basename(result.exportPath);
  // 文件名格式：export-YYYYMMDD-HHMMSS-sss.json
  assert.match(fileName, /^export-\d{8}-\d{6}-\d{3}\.json$/);
});

test("PRIV-EXP-05: 导出计数正确（userGlobalFacts/projects/experiences/changelog）", async () => {
  writeJson(path.join(tempMemoryDir, "global.json"), {
    facts: [{ k: "v1" }, { k: "v2" }, { k: "v3" }],
  });
  writeJson(path.join(tempMemoryDir, "experience.json"), {
    entries: [{ id: "e1" }, { id: "e2" }],
  });
  writeJson(path.join(tempMemoryDir, "changelog.json"), {
    entries: [{ id: "c1" }],
  });
  writeJson(path.join(tempProjectMemoryDir, "p1.json"), { x: 1 });
  writeJson(path.join(tempProjectMemoryDir, "p2.json"), { x: 2 });

  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);
  const result = await manager.exportAll();

  assert.equal(result.counts.userGlobalFacts, 3, "应正确计数 facts 条数");
  assert.equal(result.counts.projects, 2, "应正确计数项目数");
  assert.equal(result.counts.experiences, 2, "应正确计数经验条目数");
  assert.equal(result.counts.changelog, 1, "应正确计数变更日志条目数");
});

test("PRIV-EXP-06: 项目记忆目录扫描（.json 文件聚合为 projects 段）", async () => {
  writeJson(path.join(tempProjectMemoryDir, "proj-alpha.json"), { memory: "alpha" });
  writeJson(path.join(tempProjectMemoryDir, "proj-beta.json"), { memory: "beta" });
  writeJson(path.join(tempProjectMemoryDir, "proj-gamma.json"), { memory: "gamma" });

  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);
  const result = await manager.exportAll();

  const content = fs.readFileSync(result.exportPath, "utf8");
  const exported = JSON.parse(content);

  assert.ok(exported.projects["proj-alpha"], "projects 应包含 proj-alpha");
  assert.ok(exported.projects["proj-beta"], "projects 应包含 proj-beta");
  assert.ok(exported.projects["proj-gamma"], "projects 应包含 proj-gamma");
  assert.equal(exported.projects["proj-alpha"].memory, "alpha");
  assert.equal(result.counts.projects, 3);
});

test("PRIV-EXP-07: 跳过 export-*.json 和 .corrupted 文件", async () => {
  // 项目记忆目录中放置一个 export-xxx.json（应被跳过）
  writeJson(path.join(tempProjectMemoryDir, "export-20260101-120000-000.json"), {
    shouldNotBeIncluded: true,
  });
  // 一个 .corrupted 文件（应被跳过）
  writeJson(path.join(tempProjectMemoryDir, "proj-bad.corrupted.json"), {
    shouldNotBeIncluded: true,
  });
  // 一个正常的项目记忆文件
  writeJson(path.join(tempProjectMemoryDir, "proj-good.json"), { ok: true });

  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);
  const result = await manager.exportAll();

  const content = fs.readFileSync(result.exportPath, "utf8");
  const exported = JSON.parse(content);

  assert.ok(exported.projects["proj-good"], "正常项目应被包含");
  assert.equal(exported.projects["proj-bad"], undefined, ".corrupted 文件应被跳过");
  assert.equal(Object.keys(exported.projects).length, 1, "应只包含 1 个项目（跳过 export 和 corrupted）");
  assert.equal(result.counts.projects, 1);
});

test("PRIV-EXP-08: 原子写入（tmp+fsync+rename，落盘即合法）", async () => {
  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);
  const result = await manager.exportAll();

  // 验证导出文件是完整合法的 JSON（非部分写入）
  const content = fs.readFileSync(result.exportPath, "utf8");
  assert.doesNotThrow(() => JSON.parse(content), "导出文件应是完整合法的 JSON");

  // 验证不存在 .tmp 残留文件
  const tempFiles = fs.readdirSync(tempMemoryDir).filter((f) => f.endsWith(".tmp"));
  assert.equal(tempFiles.length, 0, "不应有 .tmp 残留文件");
});

// ============================================================================
// PRIV-DEL-01 ~ PRIV-DEL-08 删除测试用例
// ============================================================================

test("PRIV-DEL-01: deleteAll 严格匹配 'DELETE ALL'", async () => {
  // 准备一些文件
  writeJson(path.join(tempMemoryDir, "global.json"), { facts: [] });
  writeJson(path.join(tempMemoryDir, "redaction.log"), "log line\n");

  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);
  const report = await manager.deleteAll("DELETE ALL");

  assert.ok(report.deletedCount >= 2, "应删除全部文件");
  assert.ok(report.deletedFiles.length >= 2);
});

test("PRIV-DEL-02: 错误令牌抛 InvalidConfirmTokenError，零文件删除", async () => {
  writeJson(path.join(tempMemoryDir, "global.json"), { facts: [] });

  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);

  await assert.rejects(
    async () => {
      await manager.deleteAll("WRONG TOKEN");
    },
    (err: unknown) => {
      assert.ok(err instanceof InvalidConfirmTokenError, "应抛 InvalidConfirmTokenError");
      assert.equal((err as InvalidConfirmTokenError).providedToken, "WRONG TOKEN");
      return true;
    }
  );

  // 验证零文件被删除
  assert.ok(fs.existsSync(path.join(tempMemoryDir, "global.json")), "错误令牌时文件不应被删除");
});

test("PRIV-DEL-03: 大小写敏感（'delete all' 小写不通过）", async () => {
  writeJson(path.join(tempMemoryDir, "global.json"), { facts: [] });

  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);

  await assert.rejects(
    async () => manager.deleteAll("delete all"),
    (err: unknown) => err instanceof InvalidConfirmTokenError
  );

  assert.ok(fs.existsSync(path.join(tempMemoryDir, "global.json")), "小写令牌不应触发删除");
});

test("PRIV-DEL-04: 带空格不通过（' DELETE ALL '）", async () => {
  writeJson(path.join(tempMemoryDir, "global.json"), { facts: [] });

  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);

  await assert.rejects(
    async () => manager.deleteAll(" DELETE ALL "),
    (err: unknown) => err instanceof InvalidConfirmTokenError
  );

  assert.ok(fs.existsSync(path.join(tempMemoryDir, "global.json")), "带空格令牌不应触发删除");
});

test("PRIV-DEL-05: 删除全部文件（含 redaction.log 与历史 export-*.json）", async () => {
  writeJson(path.join(tempMemoryDir, "global.json"), { facts: [] });
  writeJson(path.join(tempMemoryDir, "experience.json"), { entries: [] });
  fs.writeFileSync(path.join(tempMemoryDir, "redaction.log"), "line1\nline2\n", "utf8");
  writeJson(path.join(tempMemoryDir, "export-20260101-120000-000.json"), { exported: true });

  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);
  const report = await manager.deleteAll("DELETE ALL");

  assert.equal(report.deletedCount, 4, "应删除全部 4 个文件");
  // 验证目录为空
  const remaining = fs.readdirSync(tempMemoryDir);
  assert.equal(remaining.length, 0, "删除后目录应为空");
});

test("PRIV-DEL-06: 空目录幂等（deletedCount=0，不抛错）", async () => {
  // tempMemoryDir 为空目录
  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);
  const report = await manager.deleteAll("DELETE ALL");

  assert.equal(report.deletedCount, 0, "空目录应返回 0");
  assert.deepEqual(report.deletedFiles, []);
});

test("PRIV-DEL-07: 删除报告含文件清单与计数", async () => {
  writeJson(path.join(tempMemoryDir, "global.json"), { facts: [] });
  writeJson(path.join(tempMemoryDir, "redaction.log"), "log");

  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);
  const report = await manager.deleteAll("DELETE ALL");

  assert.equal(report.deletedCount, report.deletedFiles.length, "计数与清单长度一致");
  // 验证清单中的路径是绝对路径
  for (const filePath of report.deletedFiles) {
    assert.ok(path.isAbsolute(filePath), "清单应为绝对路径");
    assert.ok(filePath.startsWith(tempMemoryDir), "清单应在 memoryDir 内");
  }
});

test("PRIV-DEL-08: 删除后目录保留（不删除目录本身）", async () => {
  writeJson(path.join(tempMemoryDir, "global.json"), { facts: [] });

  const manager = new MemoryPrivacyManager(tempMemoryDir, tempProjectMemoryDir);
  await manager.deleteAll("DELETE ALL");

  // 目录本身应保留
  assert.ok(fs.existsSync(tempMemoryDir), "目录本身不应被删除");
  const stat = fs.statSync(tempMemoryDir);
  assert.ok(stat.isDirectory(), "memoryDir 应仍为目录");
});

test("PRIV-DEL-09: InvalidConfirmTokenError 是 Error 子类", () => {
  const err = new InvalidConfirmTokenError("bad-token");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "InvalidConfirmTokenError");
  assert.equal(err.providedToken, "bad-token");
  assert.match(err.message, /DELETE ALL/);
});
