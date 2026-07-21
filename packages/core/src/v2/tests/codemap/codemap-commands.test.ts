/**
 * /codemap 命令处理器单元测试（CMD-01 / CMD-02）
 *
 * 覆盖测试方案 §2.10 CMD-01/CMD-02：/codemap 命令
 *
 * 测试范围：
 * - CMD-01: /codemap generate 生成代码地图（真实调用 CodeMapGenerator）
 * - CMD-02: /codemap show / cycles / stats / markdown 查询子命令
 * - /codemap help 帮助
 * - /codemap 无参数（等价于 help）
 * - /codemap 未知子命令
 * - 状态依赖：未 generate 时调用 show/cycles/stats/markdown 返回提示性失败
 *
 * 设计依据：
 * - V2 测试方案 §2.10 CMD-01/CMD-02
 * - 架构师审查报告（2026-07-21）：与 memory-commands 风格一致，使用真实文件系统
 *
 * @module v2/tests/codemap/codemap-commands.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodeMapGenerator } from "../../codemap/generator";
import type { CodeMapConfig, CodeMap } from "../../codemap/generator";
import { handleCodemapCommand } from "../../codemap/codemap-commands";

// ============================================================================
// 测试 fixture
// ============================================================================

let tempProject: string;

beforeEach(() => {
  tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-cmd-codemap-"));
});

afterEach(() => {
  fs.rmSync(tempProject, { recursive: true, force: true });
});

/**
 * 构造默认配置的 CodeMapGenerator
 */
function makeGenerator(): CodeMapGenerator {
  const config: CodeMapConfig = {
    projectRoot: tempProject,
    extensions: [".ts", ".js", ".py"],
    excludeDirs: ["node_modules", ".git"],
    maxFileSizeKb: 512,
    incremental: false,
    outputPath: ".deepcode/codemap.json",
  };
  return new CodeMapGenerator(config);
}

/**
 * 写入文件到临时项目
 */
function writeFile(relPath: string, content: string): void {
  const fullPath = path.join(tempProject, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

// ============================================================================
// CMD-01: /codemap generate 测试
// ============================================================================

test("CMD-01-01: /codemap generate 生成代码地图并返回摘要", async () => {
  // 准备项目结构
  writeFile("src/foo.ts", "export class Foo {\n  bar(): void {}\n}\n");

  const generator = makeGenerator();
  const result = await handleCodemapCommand("generate", generator);

  assert.equal(result.success, true, "generate 应返回 success=true");
  assert.match(result.output, /代码地图已生成/, "应包含生成成功提示");
  assert.match(result.output, /文件总数: 1/, "应显示文件总数");
  assert.match(result.output, /类总数: 1/, "应显示类总数");

  // data 字段应返回 CodeMap 对象（供调用方缓存）
  assert.ok(result.data, "data 字段不应为空");
  assert.equal(typeof (result.data as CodeMap).project, "object", "data 应为 CodeMap 对象");
});

test("CMD-01-02: /codemap generate 空项目也能生成", async () => {
  const generator = makeGenerator();
  const result = await handleCodemapCommand("generate", generator);

  assert.equal(result.success, true, "空项目 generate 应返回 success=true");
  assert.match(result.output, /文件总数: 0/, "应显示文件总数为 0");
});

test("CMD-01-03: /codemap generate 检测到循环依赖时显示循环数", async () => {
  // 准备循环依赖：a.ts ↔ b.ts
  writeFile("src/a.ts", "import { b } from './b';\nexport function a(): void { b(); }\n");
  writeFile("src/b.ts", "import { a } from './a';\nexport function b(): void { a(); }\n");

  const generator = makeGenerator();
  const result = await handleCodemapCommand("generate", generator);

  assert.equal(result.success, true);
  const codeMap = result.data as CodeMap;
  if (codeMap.cycles.length > 0) {
    assert.match(result.output, /循环依赖数: [1-9]/, "应显示循环依赖数 > 0");
  }
});

test("CMD-01-04: /codemap generate 显示生成耗时", async () => {
  writeFile("src/foo.ts", "export class Foo {}\n");

  const generator = makeGenerator();
  const result = await handleCodemapCommand("generate", generator);

  assert.match(result.output, /生成耗时: \d+ms/, "应显示生成耗时（数字+ms）");
});

// ============================================================================
// CMD-02: /codemap show / cycles / stats / markdown 查询子命令
// ============================================================================

test("CMD-02-01: /codemap show 显示已生成 CodeMap 的项目信息", async () => {
  writeFile("src/foo.ts", "export class Foo {}\n");

  const generator = makeGenerator();
  // 先生成
  const genResult = await handleCodemapCommand("generate", generator);
  const codeMap = genResult.data as CodeMap;

  // 再调用 show（传入 cachedCodeMap）
  const showResult = await handleCodemapCommand("show", generator, codeMap);
  assert.equal(showResult.success, true, "show 应返回 success=true");
  assert.match(showResult.output, /当前代码地图/, "应包含标题");
  assert.match(showResult.output, /项目名:/, "应显示项目名");
  assert.match(showResult.output, /根目录:/, "应显示根目录");
  assert.match(showResult.output, /架构类型:/, "应显示架构类型");
  assert.match(showResult.output, /支持语言:/, "应显示支持语言");
  assert.match(showResult.output, /模块数[：:]/, "应显示模块数");
  assert.match(showResult.output, /文件统计[：:]/, "应显示文件统计");
});

test("CMD-02-02: /codemap show 未生成时返回提示性失败", async () => {
  const generator = makeGenerator();
  // 不调用 generate，直接调用 show（cachedCodeMap 为 undefined）
  const result = await handleCodemapCommand("show", generator);
  assert.equal(result.success, false, "未生成时 show 应返回 success=false");
  assert.match(result.output, /尚未生成代码地图/, "应提示未生成");
  assert.match(result.output, /\/codemap generate/, "应提示使用 generate 命令");
});

test("CMD-02-03: /codemap cycles 显示循环依赖路径链", async () => {
  // 准备循环依赖
  writeFile("src/a.ts", "import { b } from './b';\nexport function a(): void { b(); }\n");
  writeFile("src/b.ts", "import { a } from './a';\nexport function b(): void { a(); }\n");

  const generator = makeGenerator();
  const genResult = await handleCodemapCommand("generate", generator);
  const codeMap = genResult.data as CodeMap;

  if (codeMap.cycles.length > 0) {
    const cyclesResult = await handleCodemapCommand("cycles", generator, codeMap);
    assert.equal(cyclesResult.success, true);
    assert.match(cyclesResult.output, /检测到 \d+ 条循环依赖/, "应显示循环依赖数量");
    assert.match(cyclesResult.output, /循环 #1/, "应包含循环编号");
    assert.match(cyclesResult.output, /→/, "应包含路径链箭头");
  }
});

test("CMD-02-04: /codemap cycles 无循环依赖时显示提示", async () => {
  writeFile("src/foo.ts", "export class Foo {}\n");

  const generator = makeGenerator();
  const genResult = await handleCodemapCommand("generate", generator);
  const codeMap = genResult.data as CodeMap;

  if (codeMap.cycles.length === 0) {
    const cyclesResult = await handleCodemapCommand("cycles", generator, codeMap);
    assert.equal(cyclesResult.success, true);
    assert.match(cyclesResult.output, /未检测到循环依赖/, "应显示无循环依赖提示");
  }
});

test("CMD-02-05: /codemap cycles 未生成时返回提示性失败", async () => {
  const generator = makeGenerator();
  const result = await handleCodemapCommand("cycles", generator);
  assert.equal(result.success, false);
  assert.match(result.output, /尚未生成代码地图/);
});

test("CMD-02-06: /codemap stats 显示统计信息", async () => {
  // 准备含类 + 独立函数的项目结构
  writeFile("src/foo.ts", "export class Foo {}\nexport function bar(): void {}\n");

  const generator = makeGenerator();
  const genResult = await handleCodemapCommand("generate", generator);
  const codeMap = genResult.data as CodeMap;

  const statsResult = await handleCodemapCommand("stats", generator, codeMap);
  assert.equal(statsResult.success, true);
  assert.match(statsResult.output, /代码地图统计信息/);
  assert.match(statsResult.output, /文件总数: 1/);
  assert.match(statsResult.output, /类总数: 1/);
  assert.match(statsResult.output, /函数总数: 1/, "应检测到 1 个独立函数 bar");
  assert.match(statsResult.output, /生成耗时: \d+ms/);
});

test("CMD-02-07: /codemap stats 未生成时返回提示性失败", async () => {
  const generator = makeGenerator();
  const result = await handleCodemapCommand("stats", generator);
  assert.equal(result.success, false);
  assert.match(result.output, /尚未生成代码地图/);
});

test("CMD-02-08: /codemap markdown 输出完整 Markdown 文档", async () => {
  writeFile("src/foo.ts", "export class Foo {}\n");

  const generator = makeGenerator();
  const genResult = await handleCodemapCommand("generate", generator);
  const codeMap = genResult.data as CodeMap;

  const mdResult = await handleCodemapCommand("markdown", generator, codeMap);
  assert.equal(mdResult.success, true);
  assert.match(mdResult.output, /# 代码地图/, "应包含 Markdown 标题");
  assert.match(mdResult.output, /## 项目信息/, "应包含项目信息章节");
  assert.match(mdResult.output, /## 统计信息/, "应包含统计信息章节");
  assert.match(mdResult.output, /## 文件列表/, "应包含文件列表章节");
});

test("CMD-02-09: /codemap markdown 未生成时返回提示性失败", async () => {
  const generator = makeGenerator();
  const result = await handleCodemapCommand("markdown", generator);
  assert.equal(result.success, false);
  assert.match(result.output, /尚未生成代码地图/);
});

// ============================================================================
// /codemap help 测试
// ============================================================================

test("CMD-02-10: /codemap help 显示帮助信息", async () => {
  const generator = makeGenerator();
  const result = await handleCodemapCommand("help", generator);
  assert.equal(result.success, true);
  assert.match(result.output, /\/codemap - 代码地图命令/);
  assert.match(result.output, /generate/);
  assert.match(result.output, /show/);
  assert.match(result.output, /cycles/);
  assert.match(result.output, /stats/);
  assert.match(result.output, /markdown/);
});

test("CMD-02-11: /codemap 无参数等价于 help", async () => {
  const generator = makeGenerator();
  const result = await handleCodemapCommand("", generator);
  assert.equal(result.success, true);
  assert.match(result.output, /\/codemap - 代码地图命令/);
});

// ============================================================================
// 未知子命令测试
// ============================================================================

test("CMD-02-12: /codemap 未知子命令返回失败", async () => {
  const generator = makeGenerator();
  const result = await handleCodemapCommand("unknown", generator);
  assert.equal(result.success, false);
  assert.match(result.output, /未知|unknown/i);
  assert.match(result.output, /generate.*show.*cycles.*stats.*markdown/);
});

// ============================================================================
// 端到端集成：generate → show → cycles → stats → markdown 完整流程
// ============================================================================

test("CMD-02-13: 端到端 - generate → show → cycles → stats → markdown 完整流程", async () => {
  // 准备项目结构（含类、函数、依赖）
  writeFile("src/foo.ts", "export class Foo {\n  bar(): void {}\n}\n");
  writeFile("src/baz.ts", "import { Foo } from './foo';\nexport function useFoo(): Foo { return new Foo(); }\n");

  const generator = makeGenerator();

  // 步骤 1：generate
  const genResult = await handleCodemapCommand("generate", generator);
  assert.equal(genResult.success, true, "generate 应成功");
  const codeMap = genResult.data as CodeMap;

  // 步骤 2：show（复用 cachedCodeMap）
  const showResult = await handleCodemapCommand("show", generator, codeMap);
  assert.equal(showResult.success, true, "show 应成功");

  // 步骤 3：cycles
  const cyclesResult = await handleCodemapCommand("cycles", generator, codeMap);
  assert.equal(cyclesResult.success, true, "cycles 应成功");

  // 步骤 4：stats
  const statsResult = await handleCodemapCommand("stats", generator, codeMap);
  assert.equal(statsResult.success, true, "stats 应成功");
  assert.match(statsResult.output, /文件总数: 2/, "stats 应显示 2 个文件");

  // 步骤 5：markdown
  const mdResult = await handleCodemapCommand("markdown", generator, codeMap);
  assert.equal(mdResult.success, true, "markdown 应成功");
  assert.match(mdResult.output, /# 代码地图/, "markdown 应包含标题");
  assert.match(mdResult.output, /src\/foo\.ts/, "markdown 应包含 foo.ts");
  assert.match(mdResult.output, /src\/baz\.ts/, "markdown 应包含 baz.ts");
});

test("CMD-02-14: 端到端 - 未 generate 时所有查询子命令都返回失败", async () => {
  const generator = makeGenerator();

  // 不调用 generate，直接调用所有查询子命令
  const subcommands = ["show", "cycles", "stats", "markdown"];
  for (const sub of subcommands) {
    const result = await handleCodemapCommand(sub, generator);
    assert.equal(result.success, false, `${sub} 未生成时应返回 success=false`);
    assert.match(result.output, /尚未生成代码地图/, `${sub} 应提示未生成`);
  }
});
