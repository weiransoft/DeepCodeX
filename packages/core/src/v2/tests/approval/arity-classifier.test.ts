/**
 * CommandSafetyClassifier 单元测试（F-APPR-04 Arity Dictionary）
 *
 * 测试覆盖：
 * - AC-01: git status arity=2 匹配白名单（US-APPR-004 核心验收）
 * - AC-02: git push 不匹配 git status 规则（US-APPR-004 防注入验收）
 * - AC-03: rm -rf 识别为 dangerous
 * - AC-04: 未知命令保守评估为 caution
 * - AC-05: 命令归一化（多余空白折叠）
 * - AC-06: 长前缀优先匹配（git push --force 优先于 git push）
 * - AC-07: 带参数的命令匹配（git status --short → git status）
 * - AC-08: isSafe / isDestructive 快捷方法
 * - AC-09: 空命令处理
 * - AC-10: 自定义字典
 * - AC-11: DEFAULT_ARITY_DICTIONARY 包含 20 条
 * - AC-12: sudo 命令识别为 dangerous
 *
 * 所有测试使用真实数据，无 mock。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandSafetyClassifier, DEFAULT_ARITY_DICTIONARY, type ArityEntry } from "../../approval/arity-classifier";

// ============================================================
// US-APPR-004 核心验收测试
// ============================================================

test("AC-01: git status arity=2 匹配白名单（US-APPR-004 核心验收）", () => {
  // 验收标准：git status arity=2 匹配白名单
  const classifier = new CommandSafetyClassifier();
  const result = classifier.classify("git status");

  assert.equal(result.resolvedPrefix, "git status", "resolvedPrefix 应为 'git status'");
  assert.equal(result.arity, 2, "arity 应为 2（git + status）");
  assert.equal(result.safety, "safe", "safety 应为 safe");
  assert.equal(result.isWhitelisted, true, "isWhitelisted 应为 true");
  assert.equal(result.isBlacklisted, false, "isBlacklisted 应为 false");
  assert.equal(result.rawCommand, "git status", "rawCommand 应为归一化后的命令");
});

test("AC-02: git push 不匹配 git status 规则（US-APPR-004 防注入验收）", () => {
  // 验收标准：git push arity=2 但前缀不同，不匹配 git status 规则
  const classifier = new CommandSafetyClassifier();
  const result = classifier.classify("git push");

  // git push 的前缀不等于 git status，不会误匹配为 safe
  assert.notEqual(result.resolvedPrefix, "git status", "git push 不应匹配 git status 规则");
  assert.equal(result.resolvedPrefix, "git push", "resolvedPrefix 应为 'git push'");
  assert.equal(result.arity, 2, "arity 应为 2");
  assert.equal(result.safety, "dangerous", "safety 应为 dangerous");
  assert.equal(result.isWhitelisted, false, "isWhitelisted 应为 false");
  assert.equal(result.isBlacklisted, true, "isBlacklisted 应为 true");
});

// ============================================================
// 安全等级分类测试
// ============================================================

test("AC-03: rm -rf 识别为 dangerous", () => {
  const classifier = new CommandSafetyClassifier();
  const result = classifier.classify("rm -rf /tmp/test");

  // rm -rf arity=2，命令词数=3 > arity=2，后续为参数，匹配 rm -rf 条目
  assert.equal(result.resolvedPrefix, "rm -rf", "resolvedPrefix 应为 'rm -rf'");
  assert.equal(result.arity, 2, "arity 应为 2");
  assert.equal(result.safety, "dangerous", "safety 应为 dangerous");
  assert.equal(result.isBlacklisted, true, "isBlacklisted 应为 true");
});

test("AC-04: 未知命令保守评估为 caution", () => {
  const classifier = new CommandSafetyClassifier();
  const result = classifier.classify("some-unknown-command --flag");

  // 未命中字典条目，保守评估为 caution
  assert.equal(result.safety, "caution", "未知命令 safety 应为 caution");
  assert.equal(result.isWhitelisted, false, "未知命令 isWhitelisted 应为 false");
  assert.equal(result.isBlacklisted, false, "未知命令 isBlacklisted 应为 false");
  assert.equal(result.resolvedPrefix, "some-unknown-command", "resolvedPrefix 应为首词");
});

// ============================================================
// 命令归一化测试
// ============================================================

test("AC-05: 命令归一化（多余空白折叠）", () => {
  const classifier = new CommandSafetyClassifier();
  // 多余空白应被折叠为单个空格
  const result = classifier.classify("git    status    --short");

  assert.equal(result.rawCommand, "git status --short", "多余空白应被折叠");
  assert.equal(result.resolvedPrefix, "git status", "归一化后应匹配 git status");
  assert.equal(result.safety, "safe", "应识别为 safe");
});

// ============================================================
// 长前缀优先匹配测试
// ============================================================

test("AC-06: 长前缀优先匹配（git push --force 优先于 git push）", () => {
  const classifier = new CommandSafetyClassifier();

  // git push --force (arity=3) 应优先于 git push (arity=2) 匹配
  const result = classifier.classify("git push --force origin main");
  assert.equal(result.resolvedPrefix, "git push --force", "应匹配更具体的长前缀");
  assert.equal(result.arity, 3, "arity 应为 3");
  assert.equal(result.safety, "dangerous", "safety 应为 dangerous");

  // git push（不带 --force）应匹配 git push 条目
  const result2 = classifier.classify("git push origin main");
  assert.equal(result2.resolvedPrefix, "git push", "应匹配 git push");
  assert.equal(result2.arity, 2, "arity 应为 2");
});

// ============================================================
// 带参数命令匹配测试
// ============================================================

test("AC-07: 带参数的命令匹配（git status --short → git status）", () => {
  const classifier = new CommandSafetyClassifier();
  const result = classifier.classify("git status --short");

  // 命令前 2 个词 "git status" 匹配字典条目，后续 "--short" 为参数
  assert.equal(result.resolvedPrefix, "git status", "应匹配 git status 前缀");
  assert.equal(result.arity, 2, "arity 应为 2（字典条目的 arity）");
  assert.equal(result.safety, "safe", "safety 应为 safe");
});

// ============================================================
// 快捷方法测试
// ============================================================

test("AC-08: isSafe / isDestructive 快捷方法", () => {
  const classifier = new CommandSafetyClassifier();

  // safe 命令
  assert.equal(classifier.isSafe("git status"), true, "git status 应为 safe");
  assert.equal(classifier.isSafe("ls"), true, "ls 应为 safe");
  assert.equal(classifier.isDestructive("git status"), false, "git status 不应为 destructive");

  // dangerous 命令
  assert.equal(classifier.isDestructive("rm -rf /tmp"), true, "rm -rf 应为 destructive");
  assert.equal(classifier.isDestructive("sudo apt install"), true, "sudo 应为 destructive");
  assert.equal(classifier.isSafe("rm -rf /tmp"), false, "rm -rf 不应为 safe");

  // caution 命令（既非 safe 也非 destructive）
  assert.equal(classifier.isSafe("git add"), false, "git add 不应为 safe");
  assert.equal(classifier.isDestructive("git add"), false, "git add 不应为 destructive");
});

// ============================================================
// 边界情况测试
// ============================================================

test("AC-09: 空命令处理", () => {
  const classifier = new CommandSafetyClassifier();
  const result = classifier.classify("");

  // 空命令未命中任何条目，保守评估为 caution
  assert.equal(result.safety, "caution", "空命令应为 caution");
  assert.equal(result.resolvedPrefix, "", "空命令 resolvedPrefix 应为空字符串");
  assert.equal(result.arity, 0, "空命令 arity 应为 0");
  assert.equal(result.rawCommand, "", "空命令 rawCommand 应为空字符串");
});

test("AC-09b: 仅空白命令处理", () => {
  const classifier = new CommandSafetyClassifier();
  const result = classifier.classify("   ");

  // 仅空白归一化后为空字符串，与空命令行为一致
  assert.equal(result.safety, "caution", "仅空白命令应为 caution");
  assert.equal(result.rawCommand, "", "仅空白归一化后应为空字符串");
});

// ============================================================
// 自定义字典测试
// ============================================================

test("AC-10: 自定义字典", () => {
  // 自定义字典替换默认字典
  const customDict: ArityEntry[] = [
    { prefix: "my-safe-command", arity: 1, safety: "safe" },
    { prefix: "my-dangerous-command", arity: 1, safety: "dangerous" },
  ];

  const classifier = new CommandSafetyClassifier(customDict);

  // 自定义 safe 命令
  const safeResult = classifier.classify("my-safe-command --flag");
  assert.equal(safeResult.resolvedPrefix, "my-safe-command", "应匹配自定义 safe 命令");
  assert.equal(safeResult.safety, "safe", "应为 safe");

  // 自定义 dangerous 命令
  const dangerousResult = classifier.classify("my-dangerous-command");
  assert.equal(dangerousResult.resolvedPrefix, "my-dangerous-command", "应匹配自定义 dangerous 命令");
  assert.equal(dangerousResult.safety, "dangerous", "应为 dangerous");

  // 默认字典中的命令不在自定义字典中，应保守评估为 caution
  const defaultCommand = classifier.classify("git status");
  assert.equal(defaultCommand.safety, "caution", "自定义字典中不含 git status，应为 caution");
});

// ============================================================
// 字典完整性测试
// ============================================================

test("AC-11: DEFAULT_ARITY_DICTIONARY 包含 20 条（V2-P0b 精简范围）", () => {
  // §11.1: F-APPR-04：Arity Dictionary（精简至 20 条最常用）
  assert.equal(
    DEFAULT_ARITY_DICTIONARY.length,
    20,
    `DEFAULT_ARITY_DICTIONARY 应包含 20 条，实际 ${DEFAULT_ARITY_DICTIONARY.length} 条`
  );
});

test("AC-11b: DEFAULT_ARITY_DICTIONARY 条目格式完整", () => {
  // 每条目必须包含 prefix、arity、safety 三个字段
  for (const entry of DEFAULT_ARITY_DICTIONARY) {
    assert.ok(typeof entry.prefix === "string" && entry.prefix.length > 0, `prefix 应为非空字符串: ${entry.prefix}`);
    assert.ok(typeof entry.arity === "number" && entry.arity >= 1, `arity 应为 >=1 的数字: ${entry.arity}`);
    assert.ok(
      ["safe", "caution", "dangerous"].includes(entry.safety),
      `safety 应为 safe/caution/dangerous: ${entry.safety}`
    );
  }
});

// ============================================================
// sudo 命令测试
// ============================================================

test("AC-12: sudo 命令识别为 dangerous", () => {
  const classifier = new CommandSafetyClassifier();

  // sudo arity=1，后续为参数
  const result = classifier.classify("sudo apt install nginx");
  assert.equal(result.resolvedPrefix, "sudo", "应匹配 sudo 条目");
  assert.equal(result.arity, 1, "arity 应为 1");
  assert.equal(result.safety, "dangerous", "safety 应为 dangerous");
  assert.equal(result.isBlacklisted, true, "isBlacklisted 应为 true");
});

// ============================================================
// 各安全等级命令覆盖测试
// ============================================================

test("AC-13: safe 等级命令全覆盖", () => {
  const classifier = new CommandSafetyClassifier();

  // 所有 safe 命令
  const safeCommands = [
    "git status",
    "git log",
    "git diff",
    "git branch",
    "ls",
    "cat",
    "head",
    "tail",
    "npm test",
    "npm run build",
  ];

  for (const cmd of safeCommands) {
    const result = classifier.classify(cmd);
    assert.equal(result.safety, "safe", `'${cmd}' 应为 safe`);
    assert.equal(result.isWhitelisted, true, `'${cmd}' isWhitelisted 应为 true`);
  }
});

test("AC-14: caution 等级命令全覆盖", () => {
  const classifier = new CommandSafetyClassifier();

  // 所有 caution 命令
  const cautionCommands = ["git add .", "git commit -m 'test'", "git checkout main", "npm install express"];

  for (const cmd of cautionCommands) {
    const result = classifier.classify(cmd);
    assert.equal(result.safety, "caution", `'${cmd}' 应为 caution`);
    assert.equal(result.isWhitelisted, false, `'${cmd}' isWhitelisted 应为 false`);
    assert.equal(result.isBlacklisted, false, `'${cmd}' isBlacklisted 应为 false`);
  }
});

test("AC-15: dangerous 等级命令全覆盖", () => {
  const classifier = new CommandSafetyClassifier();

  // 所有 dangerous 命令
  const dangerousCommands = [
    "git push origin main",
    "git push --force origin main",
    "git reset --hard HEAD~1",
    "rm /tmp/file",
    "rm -rf /tmp/dir",
    "sudo rm /file",
  ];

  for (const cmd of dangerousCommands) {
    const result = classifier.classify(cmd);
    assert.equal(result.safety, "dangerous", `'${cmd}' 应为 dangerous`);
    assert.equal(result.isBlacklisted, true, `'${cmd}' isBlacklisted 应为 true`);
  }
});
