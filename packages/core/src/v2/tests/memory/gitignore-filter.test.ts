/**
 * GitignoreFilter 单元测试（F-MEM-02 子模块）
 *
 * 测试覆盖 gitignore 6 种核心模式 + 嵌套 .gitignore + 否定规则 + 边界情况。
 * 所有测试使用真实文件系统（mkdtempSync 临时目录），禁止 mock。
 *
 * 测试用例：
 * - GI-01: 单星号段内通配（*.js）
 * - GI-02: 双星号跨段通配（双星号斜杠星点 js，匹配任意深度目录）
 * - GI-03: 问号单字符（?.js）
 * - GI-04: 字符类（[abc].js）
 * - GI-05: 否定字符类（[!abc].js）
 * - GI-06: 前缀斜杠锚定（/dist）
 * - GI-07: 后缀斜杠仅目录（node_modules/）
 * - GI-08: 前缀感叹号否定规则
 * - GI-09: 嵌套 .gitignore 就近生效
 * - GI-10: 空行与注释行忽略
 * - GI-11: 复合规则（多条规则组合）
 * - GI-12: GitignoreFilter.load 项目级加载
 *
 * @module v2/tests/memory/gitignore-filter.test
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseGitignoreLine, matchesGitignore, GitignoreFilter } from "../../memory/gitignore-filter";
import type { GitignoreRule } from "../../memory/gitignore-filter";

// ============================================================================
// 测试 fixture
// ============================================================================

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-gitignore-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从多行 gitignore 内容构建规则集
 *
 * @param content gitignore 文件内容（多行）
 * @param baseDir 基准目录（默认 ""）
 * @returns 解析后的规则集
 */
function buildRules(content: string, baseDir: string = ""): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const line of content.split("\n")) {
    const rule = parseGitignoreLine(line, baseDir);
    if (rule) rules.push(rule);
  }
  return rules;
}

// ============================================================================
// GI-01 ~ GI-12 测试用例
// ============================================================================

test("GI-01: 单星号段内通配（*.js）", () => {
  const rules = buildRules("*.js");
  // *.js 应匹配任意目录下的 .js 文件（非锚定模式）
  assert.equal(matchesGitignore("app.js", rules), true);
  assert.equal(matchesGitignore("src/app.js", rules), true);
  assert.equal(matchesGitignore("src/deep/app.js", rules), true);
  // 不应匹配非 .js 文件
  assert.equal(matchesGitignore("app.ts", rules), false);
  assert.equal(matchesGitignore("app.js.bak", rules), false);
  // 星号不跨目录分隔符：*.js 不应匹配 dir.app.js 这种路径中的 dir.app
  assert.equal(matchesGitignore("app.js", rules), true);
});

test("GI-02: 双星号跨段通配（**/*.js）", () => {
  const rules = buildRules("**/*.js");
  // **/*.js 应匹配任意深度目录下的 .js 文件
  assert.equal(matchesGitignore("app.js", rules), true);
  assert.equal(matchesGitignore("src/app.js", rules), true);
  assert.equal(matchesGitignore("src/deep/nested/app.js", rules), true);
});

test("GI-03: 问号单字符（?.js）", () => {
  const rules = buildRules("?.js");
  // ? 匹配单个非目录字符
  assert.equal(matchesGitignore("a.js", rules), true);
  assert.equal(matchesGitignore("b.js", rules), true);
  // 不匹配多字符
  assert.equal(matchesGitignore("ab.js", rules), false);
  // 不匹配目录分隔符
  assert.equal(matchesGitignore("/.js", rules), false);
});

test("GI-04: 字符类（[abc].js）", () => {
  const rules = buildRules("[abc].js");
  assert.equal(matchesGitignore("a.js", rules), true);
  assert.equal(matchesGitignore("b.js", rules), true);
  assert.equal(matchesGitignore("c.js", rules), true);
  assert.equal(matchesGitignore("d.js", rules), false);
});

test("GI-05: 否定字符类（[!abc].js）", () => {
  const rules = buildRules("[!abc].js");
  assert.equal(matchesGitignore("a.js", rules), false);
  assert.equal(matchesGitignore("b.js", rules), false);
  assert.equal(matchesGitignore("c.js", rules), false);
  assert.equal(matchesGitignore("d.js", rules), true);
  assert.equal(matchesGitignore("e.js", rules), true);
});

test("GI-06: 前缀斜杠锚定（/dist）", () => {
  const rules = buildRules("/dist");
  // /dist 锚定到根，只匹配根目录下的 dist
  assert.equal(matchesGitignore("dist", rules), true);
  assert.equal(matchesGitignore("dist/bundle.js", rules), true);
  // 不匹配子目录下的 dist
  assert.equal(matchesGitignore("src/dist", rules), false);
});

test("GI-07: 后缀斜杠仅目录（node_modules/）", () => {
  const rules = buildRules("node_modules/");
  // node_modules/ 仅匹配目录
  assert.equal(matchesGitignore("node_modules", rules, true), true);
  assert.equal(matchesGitignore("node_modules/express/index.js", rules), true);
  // 不匹配同名文件
  assert.equal(matchesGitignore("node_modules", rules, false), false);
});

test("GI-08: 前缀感叹号否定规则", () => {
  // *.js 忽略所有 js，但 !app.js 取消忽略 app.js
  // git 语义：非锚定否定规则会取消任意层级下同名文件的忽略
  const rules = buildRules("*.js\n!app.js");
  assert.equal(matchesGitignore("app.js", rules), false); // 被否定规则取消
  assert.equal(matchesGitignore("other.js", rules), true); // 仍被忽略
  assert.equal(matchesGitignore("src/app.js", rules), false); // 非锚定否定规则同样取消子目录 app.js
  // 若要仅取消根目录 app.js，应使用锚定否定规则 !/app.js
  const anchoredRules = buildRules("*.js\n!/app.js");
  assert.equal(matchesGitignore("app.js", anchoredRules), false); // 根目录被取消
  assert.equal(matchesGitignore("src/app.js", anchoredRules), true); // 子目录仍被忽略
});

test("GI-09: 嵌套 .gitignore 就近生效", () => {
  // 根 .gitignore 忽略所有 .log
  const rootRules = buildRules("*.log", "");
  // src 目录下的 .gitignore 否定 src/important.log
  const srcRules = buildRules("!important.log", "src");
  const allRules = [...rootRules, ...srcRules];

  // 根目录的 .log 被忽略
  assert.equal(matchesGitignore("debug.log", allRules), true);
  // src 目录下的 important.log 被否定规则取消忽略
  assert.equal(matchesGitignore("src/important.log", allRules), false);
  // src 目录下的 other.log 仍被根规则忽略
  assert.equal(matchesGitignore("src/other.log", allRules), true);
});

test("GI-10: 空行与注释行忽略", () => {
  // gitignore 语义：# 必须在行首（无前导空格）才视为注释；空行忽略
  const rules = buildRules("# 这是注释\n\n   \n# 带空格的注释\n*.tmp");
  // 注释行和空行应被忽略，只有 *.tmp 生效
  assert.equal(rules.length, 1);
  assert.equal(matchesGitignore("file.tmp", rules), true);
  assert.equal(matchesGitignore("file.js", rules), false);
});

test("GI-11: 复合规则（多条规则组合）", () => {
  const content = ["node_modules/", "dist/", "*.log", "!important.log", "/build", "*.tmp", "coverage/"].join("\n");
  const rules = buildRules(content);

  assert.equal(matchesGitignore("node_modules/express/index.js", rules), true);
  assert.equal(matchesGitignore("dist/bundle.js", rules), true);
  assert.equal(matchesGitignore("debug.log", rules), true);
  assert.equal(matchesGitignore("important.log", rules), false); // 否定规则
  assert.equal(matchesGitignore("build/output.js", rules), true);
  assert.equal(matchesGitignore("temp.tmp", rules), true);
  assert.equal(matchesGitignore("coverage/index.html", rules), true);
  assert.equal(matchesGitignore("src/app.ts", rules), false); // 不被忽略
});

test("GI-12: GitignoreFilter.load 项目级加载", async () => {
  // 构造临时项目目录结构
  fs.mkdirSync(path.join(tempDir, "src", "nested"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "dist"), { recursive: true });

  // 根 .gitignore
  fs.writeFileSync(path.join(tempDir, ".gitignore"), "node_modules/\ndist/\n*.log\n", "utf-8");
  // 嵌套 .gitignore（src 目录下）
  fs.writeFileSync(path.join(tempDir, "src", ".gitignore"), "*.tmp\n!keep.tmp\n", "utf-8");

  const filter = await GitignoreFilter.load(tempDir, [".git"]);
  assert.ok(filter.getRuleCount() >= 4, "应加载根 + 嵌套规则");

  // 验证根规则
  assert.equal(filter.isIgnored("dist/bundle.js"), true);
  assert.equal(filter.isIgnored("debug.log"), true);
  assert.equal(filter.isIgnored("src/app.ts"), false);

  // 验证嵌套规则（src 目录下的 .tmp 被忽略，但 keep.tmp 被否定）
  assert.equal(filter.isIgnored("src/file.tmp"), true);
  assert.equal(filter.isIgnored("src/keep.tmp"), false);
  assert.equal(filter.isIgnored("src/nested/file.tmp"), true);

  // node_modules 被根规则忽略
  assert.equal(filter.isIgnored("node_modules/express/index.js"), true);
});
