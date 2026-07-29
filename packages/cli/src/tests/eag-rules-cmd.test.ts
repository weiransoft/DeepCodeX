/**
 * /rules CLI 命令组单元测试
 *
 * 测试范围：
 * - A. formatRulesHelp：help 文本生成
 * - B. executeRulesCommand - list：列出三层规则
 * - C. executeRulesCommand - add：添加用户规则
 * - D. executeRulesCommand - remove：提示手动编辑规则文件
 * - E. executeRulesCommand - show：查看规则详情
 * - F. executeRulesCommand - path：显示文件路径
 * - G. executeRulesCommand - 无效/未知子命令
 * - H. generateRuleId（未导出，通过 add 间接验证）
 * - I. UserRule 字段完整性（通过 show 与文件读取验证）
 * - J. OutputBuffer（未导出，通过 executeRulesCommand 的返回值间接验证）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实 RuleStore 实例和真实临时目录
 * - 每个测试用例独立隔离：临时 projectRoot + 备份/恢复全局用户规则文件
 * - 测试后清理临时目录与备份文件
 *
 * 新 RLIS API 适配说明（EAG-P1 批次 6）：
 * - 类型：RuleDefinition → UserRule，RuleStorageLayer → RuleStoreLayer
 * - 字段：移除 name/description/injectionTargets/pattern/tags/removable；
 *   新增 category/content/confirmedBy/usageCount/violationCount/createdAt
 * - severity：小写 → 大写（blocker → BLOCKER）
 * - source：user/project/seed → user-explicit/learned/builtin-seed
 * - RuleStore：纯内存版，文件持久化由 CLI 层负责
 *   - 全局用户层：~/.deepcodeX/rules/global-rules.json
 *   - 项目层：<projectRoot>/.deepcode/rules/project-rules.json
 * - remove：新 API 不支持运行时删除，改为提示手动编辑规则文件
 *
 * 测试文件位置说明：
 *   rules-cmd.ts 在 packages/cli/src/rules/ 下，无法被 packages/core 的测试导入
 *   （core 不依赖 cli）。因此测试文件放在 packages/cli/src/tests/ 下，
 *   通过相对路径导入 ../rules/rules-cmd。
 *
 * @module cli/tests/eag-rules-cmd
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 被测对象：/rules 命令实现
import { executeRulesCommand, formatRulesHelp, type RulesCommandArgs } from "../rules/rules-cmd";
// 真实 RuleStore（非 mock）：用于测试中直接验证文件系统状态
import { RuleStore, SEED_RULES, type UserRule, type RuleSeverity } from "@vegamo/deepcode-core";

// ============================================================================
// 测试基础设施：临时目录与全局用户规则文件备份/恢复
// ============================================================================

/**
 * 真实全局用户层规则文件路径
 *
 * 新 RLIS API 的全局用户层规则文件位于 ~/.deepcodeX/rules/global-rules.json。
 * 由于 executeRulesCommand 内部仅接收 projectRoot，无法注入自定义路径，
 * 因此测试期间需要备份并清空此文件，避免污染用户环境。
 */
const realGlobalRulesPath = path.join(os.homedir(), ".deepcodeX", "rules", "global-rules.json");

/** 全局用户规则文件备份内容（beforeEach 设置，afterEach 恢复） */
let globalRulesBackup: { exists: boolean; content: string } | null = null;

/** 临时目录集合（每个测试独立使用，after 统一清理） */
const tempDirs: string[] = [];

/**
 * 创建一个临时目录作为 projectRoot
 *
 * @param prefix 临时目录前缀（便于排查）
 * @returns 临时目录绝对路径
 */
function createTempProjectRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * 备份并清空全局用户规则文件
 *
 * 由于新 RLIS API 的 RuleStore 为纯内存版，CLI 层负责读写
 * ~/.deepcodeX/rules/global-rules.json 文件。测试 add 子命令前必须先备份并清空
 * 该文件，测试结束后恢复，避免污染用户环境。
 */
function backupAndClearGlobalRules(): void {
  globalRulesBackup = { exists: false, content: "" };
  if (fs.existsSync(realGlobalRulesPath)) {
    globalRulesBackup = {
      exists: true,
      content: fs.readFileSync(realGlobalRulesPath, "utf8"),
    };
    fs.rmSync(realGlobalRulesPath);
  }
}

/**
 * 恢复全局用户规则文件
 *
 * 如果测试前文件存在，恢复原内容；否则删除测试期间产生的文件。
 * 同时清理测试期间可能创建的空 rules 目录（仅当目录为空时）。
 */
function restoreGlobalRules(): void {
  if (!globalRulesBackup) return;
  if (globalRulesBackup.exists) {
    fs.mkdirSync(path.dirname(realGlobalRulesPath), { recursive: true });
    fs.writeFileSync(realGlobalRulesPath, globalRulesBackup.content, "utf8");
  } else {
    if (fs.existsSync(realGlobalRulesPath)) {
      fs.rmSync(realGlobalRulesPath);
    }
    // 清理可能被创建的空 rules 目录：仅当目录为空时移除，避免误删用户其他文件
    const rulesDir = path.dirname(realGlobalRulesPath);
    if (fs.existsSync(rulesDir)) {
      const entries = fs.readdirSync(rulesDir);
      if (entries.length === 0) {
        fs.rmdirSync(rulesDir);
      }
    }
  }
  globalRulesBackup = null;
}

beforeEach(() => {
  // 每个测试开始前备份并清空全局用户规则文件，确保测试隔离
  backupAndClearGlobalRules();
});

afterEach(() => {
  // 测试结束后恢复用户规则文件，清理所有临时目录
  restoreGlobalRules();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 辅助：从文件系统构造 RuleStore（与 rules-cmd.ts 内部 createStore 同逻辑）
// ============================================================================

/**
 * 从 JSON 文件读取 UserRule 列表
 *
 * @param filePath 规则文件路径
 * @returns 规则列表（文件不存在/格式非法时返回空数组）
 */
function readRulesFromFile(filePath: string): UserRule[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as UserRule[];
  } catch {
    return [];
  }
}

/**
 * 从文件系统构造 RuleStore 实例（用于测试中直接验证规则状态）
 *
 * @param projectRoot 项目根目录
 * @returns 已合并三层的 RuleStore 实例
 */
function createStoreFromFileSystem(projectRoot: string): RuleStore {
  const globalRulesFile = path.join(os.homedir(), ".deepcodeX", "rules", "global-rules.json");
  const projectRulesFile = path.join(projectRoot, ".deepcode", "rules", "project-rules.json");
  return new RuleStore(SEED_RULES, readRulesFromFile(globalRulesFile), readRulesFromFile(projectRulesFile));
}

// ============================================================================
// 辅助：构造 RulesCommandArgs
// ============================================================================

/**
 * 构造 list 子命令参数
 *
 * @param projectRoot 项目根目录（用于隔离测试）
 */
function listArgs(projectRoot: string): RulesCommandArgs {
  return { subcommand: "list", projectRoot };
}

/**
 * 构造 add 子命令参数
 *
 * @param content 规则内容
 * @param projectRoot 项目根目录
 * @param overrides 其他可选参数（severity / layer）
 */
function addArgs(content: string, projectRoot: string, overrides?: Partial<RulesCommandArgs>): RulesCommandArgs {
  return {
    subcommand: "add",
    content,
    projectRoot,
    ...overrides,
  };
}

/**
 * 构造 remove 子命令参数
 */
function removeArgs(ruleId: string, projectRoot: string): RulesCommandArgs {
  return { subcommand: "remove", ruleId, projectRoot };
}

/**
 * 构造 show 子命令参数
 */
function showArgs(ruleId: string, projectRoot: string): RulesCommandArgs {
  return { subcommand: "show", ruleId, projectRoot };
}

/**
 * 构造 path 子命令参数
 */
function pathArgs(projectRoot: string): RulesCommandArgs {
  return { subcommand: "path", projectRoot };
}

// ============================================================================
// A. formatRulesHelp 测试
// ============================================================================

test("A1. formatRulesHelp 返回非空字符串", () => {
  const help = formatRulesHelp();
  assert.equal(typeof help, "string");
  assert.ok(help.length > 0, "help 文本不能为空");
});

test("A2. formatRulesHelp 包含所有子命令名称（list/add/remove/show/path）", () => {
  const help = formatRulesHelp();
  // 5 个子命令名都应出现在 help 文本中
  assert.match(help, /\blist\b/, "help 应包含 list 子命令");
  assert.match(help, /\badd\b/, "help 应包含 add 子命令");
  assert.match(help, /\bremove\b/, "help 应包含 remove 子命令");
  assert.match(help, /\bshow\b/, "help 应包含 show 子命令");
  assert.match(help, /\bpath\b/, "help 应包含 path 子命令");
});

test("A3. formatRulesHelp 包含用法说明", () => {
  const help = formatRulesHelp();
  // 用法说明应包含 "用法" 关键字与子命令格式示例
  assert.match(help, /用法/, "help 应包含'用法'关键字");
  assert.match(help, /deepcode rules/, "help 应包含命令格式示例");
});

// ============================================================================
// B. executeRulesCommand - list 子命令测试
// ============================================================================

test("B4. list 命令默认总有种子规则生效（'无规则'分支不可达）", async () => {
  // 实现说明：SEED_RULES 在代码中硬编码 10 条，永远加载，
  // 因此 effectiveRules.length === 0 分支在正常调用下不可达。
  // 此测试验证实际行为：list 输出始终包含种子规则。
  const projectRoot = createTempProjectRoot("deepcode-list-seed-");
  const result = await executeRulesCommand(listArgs(projectRoot), false);
  assert.equal(result.exitCode, 0);
  // 输出应包含"共 10 条"，而非"无规则生效"
  assert.match(result.stdout, /共\s*10\s*条/);
  assert.doesNotMatch(result.stdout, /无规则生效/);
});

test("B5. list 仅有种子规则时输出 10 条种子规则", async () => {
  // 全新临时 projectRoot + 已清空的用户规则文件 → 仅种子规则
  const projectRoot = createTempProjectRoot("deepcode-list-only-seed-");
  const result = await executeRulesCommand(listArgs(projectRoot), false);
  assert.equal(result.exitCode, 0);
  // 输出统计行应包含"共 10 条"与"种子 10"
  assert.match(result.stdout, /共\s*10\s*条.*种子\s*10/);
  // 应包含 BLOCKER 分组（4 条 BLOCKER 级种子规则：SEED-01/03/06/10）
  assert.match(result.stdout, /BLOCKER 级/);
  // 应包含 MAJOR 分组（6 条 MAJOR 级种子规则：SEED-02/04/05/07/08/09）
  assert.match(result.stdout, /MAJOR 级/);
  // 应包含 SEED-01 ID
  assert.match(result.stdout, /SEED-01/);
});

test("B6. list 有用户规则时输出 种子规则 + 用户规则", async () => {
  const projectRoot = createTempProjectRoot("deepcode-list-with-user-");
  // 先添加一条用户规则
  const addResult = await executeRulesCommand(addArgs("禁止使用 console.log 调试语句", projectRoot), false);
  assert.equal(addResult.exitCode, 0);
  // 再执行 list
  const listResult = await executeRulesCommand(listArgs(projectRoot), false);
  assert.equal(listResult.exitCode, 0);
  // 输出统计应包含"种子 10 + 用户 1"或类似格式
  assert.match(listResult.stdout, /共\s*11\s*条/);
  assert.match(listResult.stdout, /用户\s*1/);
  // 输出应包含新规则的 ID（USER-001）
  assert.match(listResult.stdout, /USER-001/);
});

test("B7. list 命令成功时 exitCode=0", async () => {
  const projectRoot = createTempProjectRoot("deepcode-list-exit-");
  const result = await executeRulesCommand(listArgs(projectRoot), false);
  assert.equal(result.exitCode, 0);
  // 同时验证 stdout 非空（list 始终有输出）
  assert.ok(result.stdout.length > 0);
});

// ============================================================================
// C. executeRulesCommand - add 子命令测试
// ============================================================================

test("C8. add 添加用户规则成功，exitCode=0", async () => {
  const projectRoot = createTempProjectRoot("deepcode-add-success-");
  const result = await executeRulesCommand(addArgs("禁止在生产代码中使用 var 声明变量", projectRoot), false);
  assert.equal(result.exitCode, 0);
  // 输出应包含"规则已添加"
  assert.match(result.stdout, /规则已添加/);
  // 输出应包含"用户"层标识
  assert.match(result.stdout, /用户层|user/);
});

test("C9. add 后 list 可见新规则", async () => {
  const projectRoot = createTempProjectRoot("deepcode-add-then-list-");
  const content = "禁止使用 eval 执行动态代码";
  const addResult = await executeRulesCommand(addArgs(content, projectRoot), false);
  assert.equal(addResult.exitCode, 0);

  // 用 list 验证
  const listResult = await executeRulesCommand(listArgs(projectRoot), false);
  assert.equal(listResult.exitCode, 0);
  // list 输出应包含新规则内容
  assert.match(listResult.stdout, /eval/);
  // 应包含 USER-001 ID
  assert.match(listResult.stdout, /USER-001/);

  // 同时通过真实 RuleStore 直接验证文件系统状态（新 API 字段）
  const store = createStoreFromFileSystem(projectRoot);
  const rule = store.getRuleById("USER-001");
  assert.ok(rule, "USER-001 应存在于 RuleStore");
  // 新 API：description → content
  assert.equal(rule?.content, content);
  // 新 API：source 值为 "user-explicit"（非旧 "user"）
  assert.equal(rule?.source, "user-explicit");
  // 新 API：confirmedBy 字段（用户显式添加为 "auto"）
  assert.equal(rule?.confirmedBy, "auto");
  // 新 API：category 字段（默认 code-truth）
  assert.equal(rule?.category, "code-truth");
  // 新 API：usageCount/violationCount 初始化为 0
  assert.equal(rule?.usageCount, 0);
  assert.equal(rule?.violationCount, 0);
  // 新 API：createdAt 字段（ISO 8601 时间戳）
  assert.ok(typeof rule?.createdAt === "string");
  assert.match(rule?.createdAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("C10. add 缺少 --content 参数时失败，exitCode 非 0", async () => {
  const projectRoot = createTempProjectRoot("deepcode-add-no-content-");
  // content 为 undefined
  const result = await executeRulesCommand({ subcommand: "add", projectRoot }, false);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.exitCode, 1);
  // stderr 应包含错误说明
  assert.match(result.stderr, /content|参数/i);
  // stderr 应包含用法提示
  assert.match(result.stderr, /用法/);
});

test("C11. add 添加的规则 id 为 USER-xxx 格式（自动生成）", async () => {
  const projectRoot = createTempProjectRoot("deepcode-add-id-format-");
  const result = await executeRulesCommand(addArgs("禁止使用 any 类型", projectRoot), false);
  assert.equal(result.exitCode, 0);
  // 输出应包含符合 USER-xxx 格式的 ID
  assert.match(result.stdout, /USER-\d{3}/);
  // 验证 USER-001（首条用户规则）
  assert.match(result.stdout, /USER-001/);
});

// ============================================================================
// D. executeRulesCommand - remove 子命令测试（新 API：提示手动编辑）
// ============================================================================

test("D12. remove 输出手动编辑提示，exitCode=0", async () => {
  // 新 RLIS API 不支持运行时删除规则，remove 命令改为提示手动编辑规则文件
  const projectRoot = createTempProjectRoot("deepcode-remove-tip-");
  const result = await executeRulesCommand(removeArgs("USER-001", projectRoot), false);
  assert.equal(result.exitCode, 0);
  // 输出应包含"手动编辑"提示
  assert.match(result.stdout, /手动编辑/);
  // 输出应包含规则 ID
  assert.match(result.stdout, /USER-001/);
  // 输出应包含全局用户层文件路径
  assert.match(result.stdout, /global-rules\.json/);
});

test("D13. remove 后 list 仍包含该规则（不实际删除）", async () => {
  // 新 API 不实际删除规则，list 输出应不受 remove 影响
  const projectRoot = createTempProjectRoot("deepcode-remove-noop-");
  // 先添加一条用户规则
  await executeRulesCommand(addArgs("禁止使用 document.write", projectRoot), false);
  // 执行 remove（仅提示，不实际删除）
  await executeRulesCommand(removeArgs("USER-001", projectRoot), false);

  const listResult = await executeRulesCommand(listArgs(projectRoot), false);
  assert.equal(listResult.exitCode, 0);
  // list 输出应仍包含 USER-001（remove 不实际删除）
  assert.match(listResult.stdout, /USER-001/);
  // 用户规则数应仍为 1
  assert.match(listResult.stdout, /用户\s*1/);
});

test("D14. remove 不存在的规则 ID 仍输出提示（exitCode=0）", async () => {
  // 新 API 下 remove 不校验规则是否存在，统一输出手动编辑提示
  const projectRoot = createTempProjectRoot("deepcode-remove-missing-");
  const result = await executeRulesCommand(removeArgs("USER-999", projectRoot), false);
  // 新行为：exitCode=0（仅提示，不报错）
  assert.equal(result.exitCode, 0);
  // stdout 应包含手动编辑提示
  assert.match(result.stdout, /手动编辑/);
  assert.match(result.stdout, /USER-999/);
});

test("D15. remove 种子规则仍输出提示（新 API 不区分规则类型）", async () => {
  // 新 API 不支持运行时删除任何规则（包括种子规则），统一输出提示
  const projectRoot = createTempProjectRoot("deepcode-remove-seed-");
  const result = await executeRulesCommand(removeArgs("SEED-01", projectRoot), false);
  assert.equal(result.exitCode, 0);
  // stdout 应包含手动编辑提示
  assert.match(result.stdout, /手动编辑/);
  assert.match(result.stdout, /SEED-01/);
  // 提示中应说明 SEED-xxx 规则为内置不可删除
  assert.match(result.stdout, /SEED-xxx|内置/i);
  // 验证 SEED-01 仍然存在于规则集
  const store = createStoreFromFileSystem(projectRoot);
  const rule = store.getRuleById("SEED-01");
  assert.ok(rule, "SEED-01 应仍然存在");
});

// ============================================================================
// E. executeRulesCommand - show 子命令测试
// ============================================================================

test("E16. show 存在的规则 ID 输出规则详情，exitCode=0", async () => {
  const projectRoot = createTempProjectRoot("deepcode-show-existing-");
  // 查看种子规则 SEED-01
  const result = await executeRulesCommand(showArgs("SEED-01", projectRoot), false);
  assert.equal(result.exitCode, 0);
  // 输出应包含规则详情标题
  assert.match(result.stdout, /规则详情/);
  assert.match(result.stdout, /SEED-01/);
  assert.match(result.stdout, /ID\s*:/);
  // 新 API 字段：分类、内容、严重级别、来源、确认来源、注入次数、违规次数、创建时间
  assert.match(result.stdout, /分类/);
  assert.match(result.stdout, /内容/);
  assert.match(result.stdout, /严重级别/);
  assert.match(result.stdout, /来源/);
  assert.match(result.stdout, /确认来源/);
  assert.match(result.stdout, /注入次数/);
  assert.match(result.stdout, /违规次数/);
  assert.match(result.stdout, /创建时间/);
  // 新 API：severity 为大写形式 BLOCKER
  assert.match(result.stdout, /BLOCKER/);
  // 不应再包含旧 API 字段名
  assert.doesNotMatch(result.stdout, /名称\s*:/);
  assert.doesNotMatch(result.stdout, /描述\s*:/);
  assert.doesNotMatch(result.stdout, /注入目标/);
  assert.doesNotMatch(result.stdout, /正则模式/);
  assert.doesNotMatch(result.stdout, /标签/);
  assert.doesNotMatch(result.stdout, /可移除/);
});

test("E17. show 不存在的规则 ID 时失败，exitCode 非 0", async () => {
  const projectRoot = createTempProjectRoot("deepcode-show-missing-");
  const result = await executeRulesCommand(showArgs("USER-999", projectRoot), false);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.exitCode, 1);
  // stderr 应提示不存在
  assert.match(result.stderr, /不存在/);
  assert.match(result.stderr, /USER-999/);
});

// ============================================================================
// F. executeRulesCommand - path 子命令测试
// ============================================================================

test("F18. path 输出全局用户层和项目层规则文件路径", async () => {
  const projectRoot = createTempProjectRoot("deepcode-path-");
  const result = await executeRulesCommand(pathArgs(projectRoot), false);
  assert.equal(result.exitCode, 0);
  // 输出应包含"规则文件路径"
  assert.match(result.stdout, /规则文件路径/);
  // 应包含全局用户层文件路径（global-rules.json）
  assert.match(result.stdout, /global-rules\.json/);
  // 应包含项目层文件路径（project-rules.json）
  assert.match(result.stdout, /project-rules\.json/);
  // 应包含 projectRoot 路径前缀
  assert.ok(result.stdout.includes(projectRoot), "path 输出应包含 projectRoot 路径");
});

test("F19. path 命令成功时 exitCode=0", async () => {
  const projectRoot = createTempProjectRoot("deepcode-path-exit-");
  const result = await executeRulesCommand(pathArgs(projectRoot), false);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.length > 0);
});

// ============================================================================
// G. executeRulesCommand - 无效/未知子命令测试
// ============================================================================

test("G20. 未知子命令时输出错误，exitCode 非 0", async () => {
  const projectRoot = createTempProjectRoot("deepcode-unknown-cmd-");
  // TypeScript 类型不允许非法 subcommand，需 cast 为 any 测试运行时行为
  const args = {
    subcommand: "unknown" as unknown as "list",
    projectRoot,
  } as RulesCommandArgs;
  const result = await executeRulesCommand(args, false);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.exitCode, 1);
  // stderr 应提示未知子命令
  assert.match(result.stderr, /未知.*子命令|unknown/i);
});

test("G21. 空字符串子命令时输出错误（无参数场景的等价运行时行为）", async () => {
  // 实现说明：executeRulesCommand 强制要求 subcommand 字段。
  // 实际 CLI 层在无 subcommand 时会调用 formatRulesHelp() 显示帮助。
  // 此处测试传入空字符串触发 default 分支的运行时行为。
  const projectRoot = createTempProjectRoot("deepcode-empty-cmd-");
  const args = {
    subcommand: "" as unknown as "list",
    projectRoot,
  } as RulesCommandArgs;
  const result = await executeRulesCommand(args, false);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.exitCode, 1);
  // 由于 default 分支捕获 never 类型，空字符串会进入 default
  assert.match(result.stderr, /未知.*子命令|unknown/i);
});

// ============================================================================
// H. generateRuleId 间接测试（函数未导出，通过 add 验证）
// ============================================================================

test("H22. 自动生成 USER-001 / PROJ-001 格式的 ID", async () => {
  const projectRoot = createTempProjectRoot("deepcode-id-format-");
  // user 层默认生成 USER-xxx
  const userResult = await executeRulesCommand(addArgs("禁止使用 var", projectRoot, { layer: "user" }), false);
  assert.equal(userResult.exitCode, 0);
  assert.match(userResult.stdout, /USER-001/);

  // project 层应生成 PROJ-xxx
  const projResult = await executeRulesCommand(
    addArgs("禁止使用 let，必须 const", projectRoot, { layer: "project" }),
    false
  );
  assert.equal(projResult.exitCode, 0);
  assert.match(projResult.stdout, /PROJ-001/);
});

test("H23. ID 递增：USER-001 → USER-002", async () => {
  const projectRoot = createTempProjectRoot("deepcode-id-increment-");
  // 添加第一条 → USER-001
  const r1 = await executeRulesCommand(addArgs("禁止使用 console.log", projectRoot), false);
  assert.equal(r1.exitCode, 0);
  assert.match(r1.stdout, /USER-001/);

  // 添加第二条 → USER-002
  const r2 = await executeRulesCommand(addArgs("禁止使用 debugger 语句", projectRoot), false);
  assert.equal(r2.exitCode, 0);
  assert.match(r2.stdout, /USER-002/);

  // 通过 RuleStore 直接验证两条都存在
  const store = createStoreFromFileSystem(projectRoot);
  assert.ok(store.getRuleById("USER-001"));
  assert.ok(store.getRuleById("USER-002"));
});

// ============================================================================
// I. UserRule 字段完整性测试（通过 add + show + 文件读取验证）
// ============================================================================

test("I24. add 构造的 UserRule 字段完整（含 category/content/confirmedBy/usageCount/violationCount/createdAt）", async () => {
  const projectRoot = createTempProjectRoot("deepcode-rule-fields-");
  const content = "禁止使用 eval 执行动态代码";
  const result = await executeRulesCommand(addArgs(content, projectRoot), false);
  assert.equal(result.exitCode, 0);

  // 通过真实 RuleStore 直接验证完整字段
  const store = createStoreFromFileSystem(projectRoot);
  const rule = store.getRuleById("USER-001");
  assert.ok(rule, "USER-001 应存在");

  // 新 API 必需字段全部存在且类型正确
  assert.equal(typeof rule?.id, "string", "id 应为 string");
  assert.equal(rule?.id, "USER-001");
  assert.equal(typeof rule?.category, "string", "category 应为 string");
  assert.equal(rule?.category, "code-truth");
  assert.equal(typeof rule?.severity, "string", "severity 应为 string");
  assert.equal(rule?.severity, "MAJOR");
  assert.equal(typeof rule?.content, "string", "content 应为 string");
  assert.equal(rule?.content, content);
  assert.equal(typeof rule?.source, "string", "source 应为 string");
  assert.equal(rule?.source, "user-explicit");
  assert.equal(typeof rule?.confirmedBy, "string", "confirmedBy 应为 string");
  assert.equal(rule?.confirmedBy, "auto");
  assert.equal(typeof rule?.usageCount, "number", "usageCount 应为 number");
  assert.equal(rule?.usageCount, 0);
  assert.equal(typeof rule?.violationCount, "number", "violationCount 应为 number");
  assert.equal(rule?.violationCount, 0);
  assert.equal(typeof rule?.createdAt, "string", "createdAt 应为 string");
  // createdAt 应为合法 ISO 8601 时间戳
  assert.match(rule?.createdAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "createdAt 应为 ISO 8601 格式");

  // 旧 API 字段不应存在于新 UserRule 对象上
  const ruleObj = rule as unknown as Record<string, unknown>;
  assert.equal(ruleObj.name, undefined, "新 UserRule 不应有 name 字段");
  assert.equal(ruleObj.description, undefined, "新 UserRule 不应有 description 字段");
  assert.equal(ruleObj.injectionTargets, undefined, "新 UserRule 不应有 injectionTargets 字段");
  assert.equal(ruleObj.pattern, undefined, "新 UserRule 不应有 pattern 字段");
  assert.equal(ruleObj.tags, undefined, "新 UserRule 不应有 tags 字段");
  assert.equal(ruleObj.removable, undefined, "新 UserRule 不应有 removable 字段");
});

// ============================================================================
// J. OutputBuffer 间接测试（类未导出，通过 executeRulesCommand 返回值验证）
// ============================================================================

test("J25. 收集 stdout 和 stderr 输出", async () => {
  // 通过 executeRulesCommand 的返回值验证 OutputBuffer 的收集行为：
  // - 成功输出（stdout）：list 命令的规则列表
  // - 错误输出（stderr）：show 不存在规则的错误
  const projectRoot = createTempProjectRoot("deepcode-buffer-collect-");

  // 验证 stdout 收集（list 命令成功）
  const listResult = await executeRulesCommand(listArgs(projectRoot), false);
  assert.equal(listResult.exitCode, 0);
  assert.ok(listResult.stdout.length > 0, "stdout 应包含 list 输出");
  // list 输出应包含种子规则信息
  assert.match(listResult.stdout, /生效规则/);

  // 验证 stderr 收集（show 不存在的规则）
  const showResult = await executeRulesCommand(showArgs("USER-999", projectRoot), false);
  assert.notEqual(showResult.exitCode, 0);
  assert.ok(showResult.stderr.length > 0, "stderr 应包含错误信息");
  assert.match(showResult.stderr, /不存在/);

  // 验证 stdout 和 stderr 独立收集，不混淆：
  // - list 成功时 stderr 应为空（无错误）
  assert.equal(listResult.stderr, "", "list 成功时 stderr 应为空");

  // show 失败时 stdout 不应包含错误标记"✖"
  assert.doesNotMatch(showResult.stdout, /✖/, "show 的 stdout 不应包含错误标记");
  // show 失败时 stderr 应包含错误关键字"不存在"
  assert.match(showResult.stderr, /不存在/);
  assert.doesNotMatch(showResult.stderr, /BLOCKER 级（不可豁免/, "show 的 stderr 不应包含规则列表分组");
});

test("J26. printToTerminal=false 时不输出到终端，仅收集到 buffer", async () => {
  // 验证 printToTerminal=false 时：
  // 1. 返回值中 stdout/stderr 已被收集
  // 2. 实际终端未被写入（通过拦截 process.stdout/process.stderr 验证）
  const projectRoot = createTempProjectRoot("deepcode-buffer-no-terminal-");

  // 拦截真实 process.stdout.write 与 process.stderr.write，
  // 记录是否被调用（这是真实拦截，非 mock）
  const stdoutWrites: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    // printToTerminal=false：仅收集，不打印
    const result = await executeRulesCommand(listArgs(projectRoot), false);

    // 返回值应有内容
    assert.ok(result.stdout.length > 0, "buffer 中应收集到 stdout");
    assert.equal(result.exitCode, 0);

    // 实际终端不应被写入（拦截到的输出为空）
    const capturedStdout = stdoutWrites.join("");
    assert.equal(capturedStdout.length, 0, "printToTerminal=false 时不应写入 process.stdout");
  } finally {
    // 恢复原始 write 方法（必须在 finally 中恢复，避免污染后续测试）
    process.stdout.write = origStdoutWrite;
  }
});

// ============================================================================
// 附加测试：printToTerminal=true 时应写入终端
// ============================================================================

test("J26b. printToTerminal=true 时实际写入终端", async () => {
  // 对照测试：printToTerminal=true 应该实际调用 process.stdout.write
  const projectRoot = createTempProjectRoot("deepcode-buffer-to-terminal-");

  const stdoutWrites: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const result = await executeRulesCommand(listArgs(projectRoot), true);
    assert.equal(result.exitCode, 0);

    // 拦截到的输出应与返回值的 stdout 一致
    const captured = stdoutWrites.join("");
    assert.ok(captured.length > 0, "printToTerminal=true 时应写入 process.stdout");
    assert.equal(captured, result.stdout);
  } finally {
    process.stdout.write = origStdoutWrite;
  }
});

// ============================================================================
// 附加测试：add 子命令的 severity 参数支持（大写形式）
// ============================================================================

test("C8b. add 指定 --severity BLOCKER 时规则级别为 BLOCKER", async () => {
  const projectRoot = createTempProjectRoot("deepcode-add-blocker-");
  const result = await executeRulesCommand(
    addArgs("数据库事务必须显式提交", projectRoot, { severity: "BLOCKER" }),
    false
  );
  assert.equal(result.exitCode, 0);

  // 通过 RuleStore 直接验证 severity 字段（新 API 大写形式）
  const store = createStoreFromFileSystem(projectRoot);
  const rule = store.getRuleById("USER-001");
  assert.ok(rule);
  assert.equal(rule?.severity, "BLOCKER");
});

test("C8c. add 默认 severity 为 MAJOR", async () => {
  const projectRoot = createTempProjectRoot("deepcode-add-default-sev-");
  const result = await executeRulesCommand(addArgs("变量命名必须有意义", projectRoot), false);
  assert.equal(result.exitCode, 0);

  const store = createStoreFromFileSystem(projectRoot);
  const rule = store.getRuleById("USER-001");
  assert.ok(rule);
  assert.equal(rule?.severity, "MAJOR");
});

test("C8d. add 指定 --severity WARNING 时规则级别为 WARNING", async () => {
  const projectRoot = createTempProjectRoot("deepcode-add-warning-");
  const result = await executeRulesCommand(
    addArgs("函数命名应使用 camelCase", projectRoot, { severity: "WARNING" as RuleSeverity }),
    false
  );
  assert.equal(result.exitCode, 0);

  const store = createStoreFromFileSystem(projectRoot);
  const rule = store.getRuleById("USER-001");
  assert.ok(rule);
  assert.equal(rule?.severity, "WARNING");
});

// ============================================================================
// 附加测试：add 持久化到正确文件（user → global-rules.json，project → project-rules.json）
// ============================================================================

test("C8e. add --layer user 持久化到全局用户层文件", async () => {
  const projectRoot = createTempProjectRoot("deepcode-add-layer-user-");
  const result = await executeRulesCommand(addArgs("禁止使用 var", projectRoot, { layer: "user" }), false);
  assert.equal(result.exitCode, 0);

  // 验证全局用户层文件存在且包含该规则
  const globalRulesFile = path.join(os.homedir(), ".deepcodeX", "rules", "global-rules.json");
  assert.ok(fs.existsSync(globalRulesFile), "全局用户层文件应被创建");
  const rules = readRulesFromFile(globalRulesFile);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, "USER-001");

  // 项目层文件不应被创建
  const projectRulesFile = path.join(projectRoot, ".deepcode", "rules", "project-rules.json");
  assert.ok(!fs.existsSync(projectRulesFile), "项目层文件不应被创建");
});

test("C8f. add --layer project 持久化到项目层文件", async () => {
  const projectRoot = createTempProjectRoot("deepcode-add-layer-project-");
  const result = await executeRulesCommand(addArgs("禁止使用 let", projectRoot, { layer: "project" }), false);
  assert.equal(result.exitCode, 0);

  // 验证项目层文件存在且包含该规则
  const projectRulesFile = path.join(projectRoot, ".deepcode", "rules", "project-rules.json");
  assert.ok(fs.existsSync(projectRulesFile), "项目层文件应被创建");
  const rules = readRulesFromFile(projectRulesFile);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, "PROJ-001");

  // 全局用户层文件不应被创建
  const globalRulesFile = path.join(os.homedir(), ".deepcodeX", "rules", "global-rules.json");
  assert.ok(!fs.existsSync(globalRulesFile), "全局用户层文件不应被创建");
});

// ============================================================================
// 附加测试：remove 缺少 --rule-id 参数时失败
// ============================================================================

test("D13b. remove 缺少 --rule-id 参数时失败，exitCode 非 0", async () => {
  const projectRoot = createTempProjectRoot("deepcode-remove-no-id-");
  const result = await executeRulesCommand({ subcommand: "remove", projectRoot }, false);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.exitCode, 1);
  // stderr 应提示需要 rule-id 参数
  assert.match(result.stderr, /rule-id|参数/i);
});

// ============================================================================
// 附加测试：种子规则数量验证（确保 SEED_RULES 数量稳定）
// ============================================================================

test("SEED_RULES 包含 10 条种子规则（与 list 输出一致）", async () => {
  // 直接验证 SEED_RULES 常量
  assert.equal(SEED_RULES.length, 10);
  // 至少包含 SEED-01 到 SEED-10
  const ids = SEED_RULES.map((r) => r.id);
  for (let i = 1; i <= 10; i++) {
    const expectedId = `SEED-${String(i).padStart(2, "0")}`;
    assert.ok(ids.includes(expectedId), `SEED_RULES 应包含 ${expectedId}`);
  }
});
