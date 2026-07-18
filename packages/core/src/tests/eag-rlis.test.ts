/**
 * EAG-RLIS 单元测试：规则学习与注入系统（Rule Learning & Injection System）
 *
 * 测试范围：
 * - A. seed-rules.ts：10 条内置种子规则的结构与字段完整性
 * - B. rule-store.ts：三层规则存储（种子/用户/项目）的加载、合并、持久化、格式化
 *
 * 测试约定（与项目既有测试一致）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架（按用户硬性规则），RuleStore 测试使用真实文件系统（临时目录）
 * - 临时目录通过 fs.mkdtempSync 创建，afterEach 中 fs.rmSync recursive 清理
 * - 中文注释，详细说明每个测试用例意图
 *
 * 设计依据：
 * - EAG 方案 §5.5.2 三层规则存储表
 * - EAG 方案 §5.5.3 规则注入（directRetainSnippets 通道复用）
 * - eag/rlis/types.ts、seed-rules.ts、rule-store.ts 实现契约
 *
 * 注意：任务描述中部分字段（confirmedBy / category / content / "builtin-seed" /
 * 大写 severity / "generator" 注入目标）与实际代码不一致。
 * 本测试以【实际代码】为准，差异点在最终报告中说明。
 *
 * @module tests/eag-rlis
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SEED_RULES } from "../eag/rlis/seed-rules";
import { getSeedRuleCount, getSeedRulesBySeverity, getSeedRulesForInjection } from "../eag/rlis/seed-rules";
import {
  RuleStore,
  validateRule,
  ruleToRedline,
  estimateTokens,
  DEFAULT_USER_RULES_PATH,
  DEFAULT_TOKEN_BUDGET,
  RULES_FILE_VERSION,
  getDefaultProjectRulesPath,
} from "../eag/rlis/rule-store";
import type { RuleDefinition, RuleSeverity, RuleSource, MergedRuleSet } from "../eag/rlis/types";
import type { RedlineDefinition } from "../eag/evaluator/types";

// ============================================================================
// 临时目录管理（参考 prompt.test.ts 模式，禁止 mock，使用真实文件系统）
// ============================================================================

/** 收集所有临时目录，afterEach 统一清理 */
const tempDirs: string[] = [];

/**
 * 创建临时目录并登记，测试结束后自动清理
 * @param prefix 临时目录前缀
 * @returns 临时目录绝对路径
 */
function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 每个测试用例后清理所有临时目录，防止残留 */
test.afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 测试数据工厂（内联构造真实对象，非 mock）
// ============================================================================

/**
 * 构造一条合法的用户规则（默认值，可通过 overrides 覆盖任意字段）
 * @param overrides 覆盖字段
 * @returns 完整的 RuleDefinition
 */
function makeUserRule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    id: "USER-01",
    name: "测试用户规则",
    description: "这是一条用于测试的用户规则，描述非空且包含中文。",
    severity: "major",
    source: "user",
    injectionTargets: ["system_prompt", "evaluator"],
    pattern: null,
    tags: ["test", "user-rule"],
    removable: true,
    ...overrides,
  };
}

/**
 * 构造一条合法的项目规则（默认值，可通过 overrides 覆盖任意字段）
 * @param overrides 覆盖字段
 * @returns 完整的 RuleDefinition
 */
function makeProjectRule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    id: "PROJ-01",
    name: "测试项目规则",
    description: "这是一条用于测试的项目规则，描述非空且包含中文。",
    severity: "blocker",
    source: "project",
    injectionTargets: ["system_prompt", "evaluator"],
    pattern: "console\\.log\\(",
    tags: ["test", "project-rule"],
    removable: true,
    ...overrides,
  };
}

/**
 * 规则文件 JSON 结构（与 rule-store.ts 的私有接口 RuleFile 对齐）
 * 持久化到磁盘的格式：{ version, rules, removedSeedIds }
 */
interface RuleFileJson {
  version: number;
  rules: RuleDefinition[];
  removedSeedIds: string[];
}

/**
 * 将规则文件对象写入磁盘（自动创建父目录）
 * @param filePath 文件路径
 * @param file 规则文件对象
 */
function writeRuleFile(filePath: string, file: RuleFileJson): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2) + "\n", "utf8");
}

/**
 * 读取并解析规则文件
 * @param filePath 文件路径
 * @returns 规则文件对象；不存在时返回 null
 */
function readRuleFile(filePath: string): RuleFileJson | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as RuleFileJson;
}

/**
 * 构造测试用 RuleStore（使用临时目录，不污染真实 ~/.deepcode）
 * @returns 包含临时 user/project 路径的 RuleStore 与路径信息
 */
function createTempStore(): {
  store: RuleStore;
  userPath: string;
  projectPath: string;
  tmpDir: string;
} {
  const tmpDir = createTempDir("eag-rlis-");
  const userPath = path.join(tmpDir, "user-rules.json");
  const projectPath = path.join(tmpDir, "project-rules.json");
  const store = new RuleStore({
    userRulesPath: userPath,
    projectRulesPath: projectPath,
  });
  return { store, userPath, projectPath, tmpDir };
}

// ============================================================================
// A. seed-rules.ts 测试
// ============================================================================

test("A1. SEED_RULES 常量存在且为非空数组", () => {
  // 验证种子规则常量已导出且包含数据
  assert.ok(Array.isArray(SEED_RULES), "SEED_RULES 必须是数组");
  assert.ok(SEED_RULES.length > 0, "SEED_RULES 不能为空数组");
});

test("A2. SEED_RULES 包含 10 条规则（SEED-01 ~ SEED-10）", () => {
  // 验证种子规则数量为 10
  assert.equal(SEED_RULES.length, 10, "种子规则数量必须为 10");
  // 验证 ID 范围 SEED-01 ~ SEED-10
  for (let i = 1; i <= 10; i++) {
    const expectedId = `SEED-${String(i).padStart(2, "0")}`;
    const found = SEED_RULES.find((r) => r.id === expectedId);
    assert.ok(found, `必须包含 ${expectedId}`);
  }
  // getSeedRuleCount 应返回 10
  assert.equal(getSeedRuleCount(), 10);
});

test("A3. 每条种子规则 id 唯一", () => {
  // 验证所有种子规则 ID 互不重复
  const ids = SEED_RULES.map((r) => r.id);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, "种子规则 ID 必须唯一");
});

test("A4. 每条种子规则 severity 为 blocker/major/warning 之一", () => {
  // 注意：实际代码使用小写 severity（blocker/major/warning）
  // 任务描述中的大写（BLOCKER/MAJOR/WARNING）与代码不符，此处按代码实际行为测试
  const validSeverities: RuleSeverity[] = ["blocker", "major", "warning"];
  for (const rule of SEED_RULES) {
    assert.ok(validSeverities.includes(rule.severity), `规则 ${rule.id} 的 severity "${rule.severity}" 不在合法枚举内`);
  }
});

test("A5. 每条种子规则 source 为 'seed'", () => {
  // 注意：实际代码 source 为 "seed"，任务描述中的 "builtin-seed" 与代码不符
  // 此处按代码实际行为测试 source === "seed"
  for (const rule of SEED_RULES) {
    assert.equal(rule.source, "seed", `规则 ${rule.id} 的 source 必须为 "seed"`);
  }
});

test("A6. 每条种子规则 removable 字段为 boolean（替代 confirmedBy 检查）", () => {
  // 注意：实际代码无 confirmedBy 字段（任务描述与代码不符）
  // 改为验证 removable 字段为 boolean 类型（决定规则是否可被 /rules remove 移除）
  for (const rule of SEED_RULES) {
    assert.equal(typeof rule.removable, "boolean", `规则 ${rule.id} 的 removable 必须是 boolean`);
  }
});

test("A7. 每条种子规则 description 非空且包含中文（替代 content 检查）", () => {
  // 注意：实际代码无 content 字段（任务描述与代码不符），规则描述字段为 description
  // 验证 description 非空且包含中文字符（种子规则均为中文描述）
  for (const rule of SEED_RULES) {
    assert.ok(rule.description && rule.description.trim().length > 0, `规则 ${rule.id} 的 description 不能为空`);
    // 验证包含中文字符（CJK 统一表意文字）
    assert.ok(/[\u4e00-\u9fff]/.test(rule.description), `规则 ${rule.id} 的 description 必须包含中文`);
    // name 也应非空
    assert.ok(rule.name && rule.name.trim().length > 0, `规则 ${rule.id} 的 name 不能为空`);
  }
});

test("A8. 每条种子规则 tags 为非空数组（替代 category 检查）", () => {
  // 注意：实际代码无 category 字段（任务描述与代码不符），分类用 tags 数组表示
  // 验证 tags 是数组且非空（每条规则至少有一个分类标签）
  for (const rule of SEED_RULES) {
    assert.ok(Array.isArray(rule.tags), `规则 ${rule.id} 的 tags 必须是数组`);
    assert.ok(rule.tags.length > 0, `规则 ${rule.id} 的 tags 不能为空`);
    // 验证每个 tag 是非空字符串
    for (const tag of rule.tags) {
      assert.equal(typeof tag, "string");
      assert.ok(tag.trim().length > 0, `规则 ${rule.id} 的 tag 不能为空字符串`);
    }
  }
});

test("A9. BLOCKER 级种子规则（severity='blocker'）的 removable=false（不可移除）", () => {
  // 验证所有 BLOCKER 级种子规则不可移除——系统硬约束永远生效
  const blockerRules = SEED_RULES.filter((r) => r.severity === "blocker");
  assert.ok(blockerRules.length > 0, "至少应有一条 BLOCKER 级种子规则");
  for (const rule of blockerRules) {
    assert.equal(rule.removable, false, `BLOCKER 级种子规则 ${rule.id} 必须 removable=false`);
  }
  // 反向验证：removable=true 的规则不能是 blocker 级
  const removableRules = SEED_RULES.filter((r) => r.removable);
  for (const rule of removableRules) {
    assert.notEqual(rule.severity, "blocker", `可移除规则 ${rule.id} 不能是 blocker 级`);
  }
});

test("A10. SEED-01（禁 mock/占位/简化/逃避式删除）存在且为 BLOCKER 级", () => {
  // 验证 SEED-01 是禁止 mock/占位/简化的核心硬约束，且为 BLOCKER 级不可移除
  const seed01 = SEED_RULES.find((r) => r.id === "SEED-01");
  assert.ok(seed01, "必须存在 SEED-01 规则");
  assert.equal(seed01!.severity, "blocker", "SEED-01 必须为 blocker 级");
  assert.equal(seed01!.removable, false, "SEED-01 必须不可移除");
  // 验证描述内容涉及 mock/占位/简化
  const desc = seed01!.description;
  assert.ok(desc.includes("mock") || desc.includes("模拟"), "SEED-01 应涉及 mock/模拟");
  assert.ok(desc.includes("占位"), "SEED-01 应涉及占位");
  assert.ok(desc.includes("简化"), "SEED-01 应涉及简化");
  // 验证注入目标包含 system_prompt 和 evaluator（双重注入）
  assert.ok(seed01!.injectionTargets.includes("system_prompt"));
  assert.ok(seed01!.injectionTargets.includes("evaluator"));
  // 验证有静态检测模式（pattern 非空）
  assert.ok(seed01!.pattern, "SEED-01 应有静态检测 pattern");
});

test("A11. getSeedRulesBySeverity 按级别过滤正确", () => {
  // 验证辅助函数 getSeedRulesBySeverity 正确过滤
  const blockerRules = getSeedRulesBySeverity("blocker");
  const majorRules = getSeedRulesBySeverity("major");
  const warningRules = getSeedRulesBySeverity("warning");
  // 三类规则数量之和应等于总数
  assert.equal(blockerRules.length + majorRules.length + warningRules.length, SEED_RULES.length);
  // 每条 blocker 规则的 severity 都是 blocker
  for (const r of blockerRules) {
    assert.equal(r.severity, "blocker");
  }
});

test("A12. getSeedRulesForInjection 按注入目标过滤正确", () => {
  // 验证辅助函数 getSeedRulesForInjection 正确过滤
  const promptRules = getSeedRulesForInjection("system_prompt");
  const evaluatorRules = getSeedRulesForInjection("evaluator");
  // 每条 promptRules 的 injectionTargets 应包含 system_prompt
  for (const r of promptRules) {
    assert.ok(r.injectionTargets.includes("system_prompt"));
  }
  // 每条 evaluatorRules 的 injectionTargets 应包含 evaluator
  for (const r of evaluatorRules) {
    assert.ok(r.injectionTargets.includes("evaluator"));
  }
});

// ============================================================================
// B.1 构造与加载
// ============================================================================

test("B11. 默认构造使用 DEFAULT_USER_RULES_PATH（~/.deepcode/rules/user-rules.json）", () => {
  // 验证不传 options 时使用默认路径 ~/.deepcode/rules/user-rules.json
  const store = new RuleStore();
  assert.equal(store.getUserRulesPath(), DEFAULT_USER_RULES_PATH);
  // DEFAULT_USER_RULES_PATH 应指向 ~/.deepcode/rules/user-rules.json
  const expected = path.join(os.homedir(), ".deepcode", "rules", "user-rules.json");
  assert.equal(DEFAULT_USER_RULES_PATH, expected);
});

test("B12. 自定义构造使用指定的 user/project 规则文件路径", () => {
  // 验证传入 options 时使用自定义路径
  const tmpDir = createTempDir("eag-rlis-custom-");
  const customUser = path.join(tmpDir, "my-user-rules.json");
  const customProject = path.join(tmpDir, "my-project-rules.json");
  const store = new RuleStore({
    userRulesPath: customUser,
    projectRulesPath: customProject,
  });
  assert.equal(store.getUserRulesPath(), customUser);
  assert.equal(store.getProjectRulesPath(), customProject);
});

test("B12b. projectRoot 参数推导默认项目规则路径", () => {
  // 验证 getDefaultProjectRulesPath 按 <root>/.deepcode/rules/project-rules.json 推导
  const fakeRoot = "/fake/project/root";
  const expected = path.join(fakeRoot, ".deepcode", "rules", "project-rules.json");
  assert.equal(getDefaultProjectRulesPath(fakeRoot), expected);
  // 验证 RuleStore 不传 projectRulesPath 时按 projectRoot 推导
  const store = new RuleStore({ projectRoot: fakeRoot });
  assert.equal(store.getProjectRulesPath(), expected);
});

test("B13. 规则文件不存在时 loadMergedRuleset 返回仅含种子规则的结果", () => {
  // 验证无 user/project 规则文件时，仅返回种子规则
  const { store } = createTempStore();
  const ruleset = store.loadMergedRuleset();
  // 规则数量应等于种子规则数量
  assert.equal(ruleset.rules.length, SEED_RULES.length);
  assert.equal(ruleset.seedCount, SEED_RULES.length);
  assert.equal(ruleset.userCount, 0);
  assert.equal(ruleset.projectCount, 0);
  assert.equal(ruleset.removedSeedIds.length, 0);
  // 所有规则 source 应为 seed
  for (const rule of ruleset.rules) {
    assert.equal(rule.source, "seed");
  }
});

// ============================================================================
// B.2 三层合并优先级（§5.5.2）
// ============================================================================

test("B14. 仅种子层：loadMergedRuleset 返回 SEED_RULES 全部规则", () => {
  // 验证无 user/project 规则时返回全部种子规则
  const { store } = createTempStore();
  const ruleset = store.loadMergedRuleset();
  assert.equal(ruleset.rules.length, SEED_RULES.length);
  // 每条种子规则都应出现
  for (const seed of SEED_RULES) {
    const found = ruleset.rules.find((r) => r.id === seed.id);
    assert.ok(found, `应包含种子规则 ${seed.id}`);
    assert.equal(found!.name, seed.name);
  }
});

test("B15. 种子 + 用户层：用户规则追加到种子规则后", () => {
  // 验证用户层规则与种子规则合并（不同 ID 全部生效）
  const { store, userPath } = createTempStore();
  const userRule = makeUserRule({ id: "USER-CUSTOM-01" });
  writeRuleFile(userPath, {
    version: RULES_FILE_VERSION,
    rules: [userRule],
    removedSeedIds: [],
  });
  const ruleset = store.loadMergedRuleset();
  // 总数 = 种子规则 + 1 条用户规则
  assert.equal(ruleset.rules.length, SEED_RULES.length + 1);
  assert.equal(ruleset.seedCount, SEED_RULES.length);
  assert.equal(ruleset.userCount, 1);
  // 用户规则应出现且 source 为 user
  const found = ruleset.rules.find((r) => r.id === "USER-CUSTOM-01");
  assert.ok(found);
  assert.equal(found!.source, "user");
  assert.equal(found!.name, userRule.name);
});

test("B16. 种子 + 项目层：项目规则追加到种子规则后", () => {
  // 验证项目层规则与种子规则合并
  const { store, projectPath } = createTempStore();
  const projectRule = makeProjectRule({ id: "PROJ-CUSTOM-01" });
  writeRuleFile(projectPath, {
    version: RULES_FILE_VERSION,
    rules: [projectRule],
    removedSeedIds: [],
  });
  const ruleset = store.loadMergedRuleset();
  assert.equal(ruleset.rules.length, SEED_RULES.length + 1);
  assert.equal(ruleset.seedCount, SEED_RULES.length);
  assert.equal(ruleset.projectCount, 1);
  const found = ruleset.rules.find((r) => r.id === "PROJ-CUSTOM-01");
  assert.ok(found);
  assert.equal(found!.source, "project");
});

test("B17. 种子 + 用户 + 项目三层：三层规则全部合并", () => {
  // 验证三层规则全部生效（不同 ID 全部出现）
  const { store, userPath, projectPath } = createTempStore();
  writeRuleFile(userPath, {
    version: RULES_FILE_VERSION,
    rules: [makeUserRule({ id: "USER-3LAYER-01" })],
    removedSeedIds: [],
  });
  writeRuleFile(projectPath, {
    version: RULES_FILE_VERSION,
    rules: [makeProjectRule({ id: "PROJ-3LAYER-01" })],
    removedSeedIds: [],
  });
  const ruleset = store.loadMergedRuleset();
  // 总数 = 种子 + 1 用户 + 1 项目
  assert.equal(ruleset.rules.length, SEED_RULES.length + 2);
  assert.equal(ruleset.seedCount, SEED_RULES.length);
  assert.equal(ruleset.userCount, 1);
  assert.equal(ruleset.projectCount, 1);
  assert.ok(ruleset.rules.find((r) => r.id === "USER-3LAYER-01"));
  assert.ok(ruleset.rules.find((r) => r.id === "PROJ-3LAYER-01"));
});

test("B18. 同 ID 规则覆盖优先级：project > user > seed", () => {
  // 验证同 ID 规则按优先级覆盖：项目层覆盖用户层和种子层
  // 构造三层都有 SEED-01 的场景：用户层覆盖种子层，项目层覆盖用户层
  const { store, userPath, projectPath } = createTempStore();
  const userOverride: RuleDefinition = {
    ...SEED_RULES[0], // SEED-01
    id: "SEED-01",
    name: "用户层覆盖版",
    source: "user",
  };
  const projectOverride: RuleDefinition = {
    ...SEED_RULES[0],
    id: "SEED-01",
    name: "项目层覆盖版",
    source: "project",
  };
  writeRuleFile(userPath, {
    version: RULES_FILE_VERSION,
    rules: [userOverride],
    removedSeedIds: [],
  });
  writeRuleFile(projectPath, {
    version: RULES_FILE_VERSION,
    rules: [projectOverride],
    removedSeedIds: [],
  });
  const ruleset = store.loadMergedRuleset();
  // SEED-01 应被项目层覆盖（项目层优先级最高）
  const rule = ruleset.rules.find((r) => r.id === "SEED-01");
  assert.ok(rule);
  assert.equal(rule!.source, "project", "同 ID 时项目层应覆盖用户层和种子层");
  assert.equal(rule!.name, "项目层覆盖版");
  // 总数应仍为种子规则数（覆盖不新增）
  assert.equal(ruleset.rules.length, SEED_RULES.length);
  assert.equal(ruleset.projectCount, 1);
  assert.equal(ruleset.userCount, 0); // 被项目层覆盖，不计入 userCount
});

test("B18b. 同 ID 覆盖：user > seed（项目层无覆盖时用户层生效）", () => {
  // 验证项目层无同 ID 规则时，用户层覆盖种子层
  const { store, userPath } = createTempStore();
  const userOverride: RuleDefinition = {
    ...SEED_RULES[1], // SEED-02（major 级，可被覆盖）
    id: "SEED-02",
    name: "用户层覆盖 SEED-02",
    source: "user",
  };
  writeRuleFile(userPath, {
    version: RULES_FILE_VERSION,
    rules: [userOverride],
    removedSeedIds: [],
  });
  const ruleset = store.loadMergedRuleset();
  const rule = ruleset.rules.find((r) => r.id === "SEED-02");
  assert.ok(rule);
  assert.equal(rule!.source, "user", "用户层应覆盖种子层");
  assert.equal(rule!.name, "用户层覆盖 SEED-02");
});

// ============================================================================
// B.3 removedSeedIds 机制
// ============================================================================

test("B19. 用户层 removedSeedIds 标记的可移除种子规则被移除", () => {
  // 验证用户层 removedSeedIds 数组中的可移除种子规则被跳过
  // SEED-02 是 major 级，removable=true，可被移除
  const { store, userPath } = createTempStore();
  const seed02 = SEED_RULES.find((r) => r.id === "SEED-02");
  assert.ok(seed02?.removable, "SEED-02 应为可移除");
  writeRuleFile(userPath, {
    version: RULES_FILE_VERSION,
    rules: [],
    removedSeedIds: ["SEED-02"],
  });
  const ruleset = store.loadMergedRuleset();
  // SEED-02 应被移除
  const found = ruleset.rules.find((r) => r.id === "SEED-02");
  assert.equal(found, undefined, "SEED-02 应被 removedSeedIds 移除");
  // 总数 = 种子数 - 1
  assert.equal(ruleset.rules.length, SEED_RULES.length - 1);
  assert.equal(ruleset.seedCount, SEED_RULES.length - 1);
  // removedSeedIds 应包含 SEED-02
  assert.ok(ruleset.removedSeedIds.includes("SEED-02"));
});

test("B20. 项目层 removedSeedIds 标记的可移除种子规则被移除", () => {
  // 验证项目层 removedSeedIds 同样能移除可移除种子规则
  const { store, projectPath } = createTempStore();
  // SEED-05 是 major 级，removable=true
  const seed05 = SEED_RULES.find((r) => r.id === "SEED-05");
  assert.ok(seed05?.removable, "SEED-05 应为可移除");
  writeRuleFile(projectPath, {
    version: RULES_FILE_VERSION,
    rules: [],
    removedSeedIds: ["SEED-05"],
  });
  const ruleset = store.loadMergedRuleset();
  const found = ruleset.rules.find((r) => r.id === "SEED-05");
  assert.equal(found, undefined, "SEED-05 应被项目层 removedSeedIds 移除");
  assert.equal(ruleset.rules.length, SEED_RULES.length - 1);
});

test("B21. BLOCKER 级种子规则（removable=false）即使被 removedSeedIds 标记也保留", () => {
  // 验证 BLOCKER 级种子规则（不可移除）即使在 removedSeedIds 中也保留
  // SEED-01 是 blocker 级，removable=false
  const { store, userPath, projectPath } = createTempStore();
  const seed01 = SEED_RULES.find((r) => r.id === "SEED-01");
  assert.equal(seed01?.removable, false, "SEED-01 应不可移除");
  // 用户层和项目层都标记移除 SEED-01
  writeRuleFile(userPath, {
    version: RULES_FILE_VERSION,
    rules: [],
    removedSeedIds: ["SEED-01"],
  });
  writeRuleFile(projectPath, {
    version: RULES_FILE_VERSION,
    rules: [],
    removedSeedIds: ["SEED-01"],
  });
  const ruleset = store.loadMergedRuleset();
  // SEED-01 仍应存在（BLOCKER 级不可移除）
  const found = ruleset.rules.find((r) => r.id === "SEED-01");
  assert.ok(found, "BLOCKER 级种子规则 SEED-01 即使被 removedSeedIds 标记也必须保留");
  assert.equal(found!.source, "seed");
  // 所有 BLOCKER 级种子规则都应保留
  const blockerRules = SEED_RULES.filter((r) => r.severity === "blocker");
  for (const blocker of blockerRules) {
    const stillThere = ruleset.rules.find((r) => r.id === blocker.id);
    assert.ok(stillThere, `BLOCKER 级规则 ${blocker.id} 必须保留`);
  }
});

// ============================================================================
// B.4 addRule / removeRule / getRuleById
// ============================================================================

test("B22. addRule 添加用户规则（USER-xx 前缀），持久化到 user-rules.json", () => {
  // 验证 addRule 添加用户规则并持久化到 user-rules.json
  const { store, userPath } = createTempStore();
  const rule = makeUserRule({ id: "USER-ADD-01" });
  const result = store.addRule(rule, "user");
  assert.equal(result.success, true, "addRule 应成功");
  assert.equal(result.ruleId, "USER-ADD-01");
  // 验证文件已写入
  const file = readRuleFile(userPath);
  assert.ok(file, "user-rules.json 应已创建");
  assert.equal(file!.rules.length, 1);
  assert.equal(file!.rules[0].id, "USER-ADD-01");
  // 验证 source 被强制覆盖为 user
  assert.equal(file!.rules[0].source, "user");
  // 验证 loadMergedRuleset 能读到
  const ruleset = store.loadMergedRuleset();
  const found = ruleset.rules.find((r) => r.id === "USER-ADD-01");
  assert.ok(found);
  assert.equal(found!.source, "user");
});

test("B23. addRule 添加项目规则（PROJ-xx 前缀），持久化到 project-rules.json", () => {
  // 验证 addRule 添加项目规则并持久化到 project-rules.json
  const { store, projectPath } = createTempStore();
  const rule = makeProjectRule({ id: "PROJ-ADD-01" });
  const result = store.addRule(rule, "project");
  assert.equal(result.success, true);
  assert.equal(result.ruleId, "PROJ-ADD-01");
  const file = readRuleFile(projectPath);
  assert.ok(file);
  assert.equal(file!.rules[0].id, "PROJ-ADD-01");
  assert.equal(file!.rules[0].source, "project");
});

test("B24. addRule 同层内同 ID 规则时返回失败（不覆盖）", () => {
  // 注意：任务描述说"同 ID 覆盖"，但实际代码是同层内同 ID 返回失败（不覆盖）
  // 此处按代码实际行为测试：addRule 同层内同 ID 时返回 success=false
  const { store, userPath } = createTempStore();
  const rule1 = makeUserRule({ id: "USER-DUP-01", name: "第一条" });
  const result1 = store.addRule(rule1, "user");
  assert.equal(result1.success, true);
  // 再次添加同 ID 规则应失败
  const rule2 = makeUserRule({ id: "USER-DUP-01", name: "第二条" });
  const result2 = store.addRule(rule2, "user");
  assert.equal(result2.success, false, "同层内同 ID 应返回失败");
  assert.ok(result2.error, "失败时应提供 error 信息");
  assert.match(result2.error!, /已存在/);
  // 验证原规则未被覆盖（仍是"第一条"）
  const file = readRuleFile(userPath);
  assert.equal(file!.rules.length, 1);
  assert.equal(file!.rules[0].name, "第一条");
});

test("B24b. addRule 拒绝添加 source='seed' 层的规则", () => {
  // 验证 addRule 不允许添加种子层规则（种子规则在代码中维护）
  const { store } = createTempStore();
  const result = store.addRule(makeUserRule(), "seed");
  assert.equal(result.success, false, "不应允许添加 seed 层规则");
  assert.match(result.error!, /种子规则/);
});

test("B24c. addRule 非法规则返回失败（触发 validateRule）", () => {
  // 验证 addRule 对非法规则返回失败
  const { store } = createTempStore();
  const invalidRule = makeUserRule({ id: "", name: "空 ID" });
  const result = store.addRule(invalidRule, "user");
  assert.equal(result.success, false);
  assert.ok(result.error);
});

test("B25. removeRule 移除用户/项目规则", () => {
  // 验证 removeRule 从对应文件中删除规则
  const { store, userPath, projectPath } = createTempStore();
  // 先添加用户规则和项目规则
  store.addRule(makeUserRule({ id: "USER-RM-01" }), "user");
  store.addRule(makeProjectRule({ id: "PROJ-RM-01" }), "project");
  // 移除用户规则
  const result1 = store.removeRule("USER-RM-01");
  assert.equal(result1.success, true);
  assert.equal(result1.ruleId, "USER-RM-01");
  // 验证 user-rules.json 中已无该规则
  const userFile = readRuleFile(userPath);
  assert.equal(
    userFile!.rules.find((r) => r.id === "USER-RM-01"),
    undefined
  );
  // 移除项目规则
  const result2 = store.removeRule("PROJ-RM-01");
  assert.equal(result2.success, true);
  const projFile = readRuleFile(projectPath);
  assert.equal(
    projFile!.rules.find((r) => r.id === "PROJ-RM-01"),
    undefined
  );
});

test("B26. removeRule 移除可移除的种子规则（加入 removedSeedIds）", () => {
  // 验证 removeRule 移除可移除种子规则时写入 removedSeedIds
  // SEED-02 是 major 级，removable=true
  const { store, userPath } = createTempStore();
  const result = store.removeRule("SEED-02");
  assert.equal(result.success, true);
  assert.equal(result.ruleId, "SEED-02");
  // 验证 removedSeedIds 包含 SEED-02
  const file = readRuleFile(userPath);
  assert.ok(file);
  assert.ok(file!.removedSeedIds.includes("SEED-02"));
  // 验证 loadMergedRuleset 不再返回 SEED-02
  const ruleset = store.loadMergedRuleset();
  assert.equal(
    ruleset.rules.find((r) => r.id === "SEED-02"),
    undefined
  );
});

test("B26b. removeRule 重复移除同一种子规则不重复写入 removedSeedIds", () => {
  // 验证重复移除可移除种子规则时 removedSeedIds 不重复
  const { store, userPath } = createTempStore();
  store.removeRule("SEED-02");
  store.removeRule("SEED-02");
  const file = readRuleFile(userPath);
  const count = file!.removedSeedIds.filter((id) => id === "SEED-02").length;
  assert.equal(count, 1, "removedSeedIds 不应包含重复 ID");
});

test("B27. removeRule 移除 BLOCKER 级种子规则（removable=false）失败", () => {
  // 验证 removeRule 移除 BLOCKER 级种子规则返回失败
  // SEED-01 是 blocker 级，removable=false
  const { store } = createTempStore();
  const result = store.removeRule("SEED-01");
  assert.equal(result.success, false, "移除 BLOCKER 级种子规则应失败");
  assert.ok(result.error, "失败时应提供 error 信息");
  assert.match(result.error!, /不可移除|BLOCKER/i);
  // 验证 SEED-01 仍存在
  const ruleset = store.loadMergedRuleset();
  assert.ok(ruleset.rules.find((r) => r.id === "SEED-01"));
});

test("B27b. removeRule 移除不存在的规则 ID 返回失败", () => {
  // 验证 removeRule 对不存在的规则 ID 返回失败
  const { store } = createTempStore();
  const result = store.removeRule("NON-EXISTENT-99");
  assert.equal(result.success, false);
  assert.match(result.error!, /不存在/);
});

test("B28. getRuleById 返回对应规则（含合并后的优先级）", () => {
  // 验证 getRuleById 返回合并后优先级最高的规则版本
  const { store, userPath, projectPath } = createTempStore();
  // 三层都有 SEED-02：种子层 + 用户层 + 项目层
  const userOverride: RuleDefinition = {
    ...SEED_RULES[1],
    id: "SEED-02",
    name: "用户层版本",
    source: "user",
  };
  const projectOverride: RuleDefinition = {
    ...SEED_RULES[1],
    id: "SEED-02",
    name: "项目层版本",
    source: "project",
  };
  writeRuleFile(userPath, {
    version: RULES_FILE_VERSION,
    rules: [userOverride],
    removedSeedIds: [],
  });
  writeRuleFile(projectPath, {
    version: RULES_FILE_VERSION,
    rules: [projectOverride],
    removedSeedIds: [],
  });
  // getRuleById 应返回项目层版本（最高优先级）
  const rule = store.getRuleById("SEED-02");
  assert.ok(rule);
  assert.equal(rule!.source, "project");
  assert.equal(rule!.name, "项目层版本");
  // 验证不存在时返回 null
  assert.equal(store.getRuleById("NON-EXISTENT"), null);
});

// ============================================================================
// B.5 formatForSystemPrompt
// ============================================================================

test("B29. 空规则集返回空字符串", () => {
  // 验证空规则集时 formatForSystemPrompt 返回空字符串
  const { store } = createTempStore();
  const emptyRuleset: MergedRuleSet = {
    rules: [],
    seedCount: 0,
    userCount: 0,
    projectCount: 0,
    removedSeedIds: [],
  };
  const output = store.formatForSystemPrompt(emptyRuleset);
  assert.equal(output, "", "空规则集应返回空字符串");
});

test("B30. 按 severity 分组：BLOCKER 置顶，MAJOR 次之，WARNING 最后", () => {
  // 注意：任务描述说"CRITICAL 次之"，但代码实际是 MAJOR（无 CRITICAL 级）
  // 此处按代码实际行为测试：BLOCKER → MAJOR → WARNING 顺序
  const { store } = createTempStore();
  const ruleset = store.loadMergedRuleset();
  const output = store.formatForSystemPrompt(ruleset);
  // 验证包含分组标题
  assert.ok(output.includes("### BLOCKER 级"), "应包含 BLOCKER 分组");
  assert.ok(output.includes("### MAJOR 级"), "应包含 MAJOR 分组");
  // 验证顺序：BLOCKER 在 MAJOR 之前
  const blockerIdx = output.indexOf("### BLOCKER 级");
  const majorIdx = output.indexOf("### MAJOR 级");
  assert.ok(blockerIdx >= 0 && majorIdx >= 0);
  assert.ok(blockerIdx < majorIdx, "BLOCKER 分组应在 MAJOR 之前");
});

test("B30b. WARNING 级规则出现在 MAJOR 之后", () => {
  // 验证 WARNING 分组在 MAJOR 之后（若有 WARNING 规则）
  const { store, userPath } = createTempStore();
  // 添加一条 WARNING 级用户规则
  writeRuleFile(userPath, {
    version: RULES_FILE_VERSION,
    rules: [makeUserRule({ id: "USER-WARN-01", severity: "warning" })],
    removedSeedIds: [],
  });
  const ruleset = store.loadMergedRuleset();
  const output = store.formatForSystemPrompt(ruleset);
  const majorIdx = output.indexOf("### MAJOR 级");
  const warningIdx = output.indexOf("### WARNING 级");
  assert.ok(majorIdx >= 0 && warningIdx >= 0);
  assert.ok(majorIdx < warningIdx, "MAJOR 分组应在 WARNING 之前");
});

test("B31. Token 预算截断：超预算时 WARNING 最先被裁", () => {
  // 验证超 token 预算时 WARNING 段最先被裁剪
  // 设置极小 budget，BLOCKER 永不裁（仍出现），WARNING 被裁（不出现）
  const { store, userPath } = createTempStore();
  writeRuleFile(userPath, {
    version: RULES_FILE_VERSION,
    rules: [makeUserRule({ id: "USER-WARN-02", severity: "warning" })],
    removedSeedIds: [],
  });
  const ruleset = store.loadMergedRuleset();
  // tokenBudget=1（极小），BLOCKER 段无条件输出，WARNING 段被裁
  const output = store.formatForSystemPrompt(ruleset, { tokenBudget: 1 });
  // header 永远存在
  assert.ok(output.includes("## 项目规则清单"), "header 应存在");
  // BLOCKER 永不裁
  assert.ok(output.includes("### BLOCKER 级"), "BLOCKER 段应保留（永不裁）");
  // WARNING 段被裁（budget 不足）
  assert.ok(!output.includes("### WARNING 级"), "WARNING 段应被裁");
});

test("B31b. Token 预算充足时所有 severity 段都输出", () => {
  // 验证预算充足时所有段都输出（不裁剪）
  const { store, userPath } = createTempStore();
  writeRuleFile(userPath, {
    version: RULES_FILE_VERSION,
    rules: [makeUserRule({ id: "USER-WARN-03", severity: "warning" })],
    removedSeedIds: [],
  });
  const ruleset = store.loadMergedRuleset();
  // 设置足够大的 budget
  const output = store.formatForSystemPrompt(ruleset, { tokenBudget: 100000 });
  assert.ok(output.includes("### BLOCKER 级"));
  assert.ok(output.includes("### MAJOR 级"));
  assert.ok(output.includes("### WARNING 级"));
});

test("B32. includeCategoryHeaders=false 时不包含 category 子分组标题", () => {
  // 注意：任务描述说"不包含分组标题"，但代码实际行为是：
  // - severity 分组标题（### BLOCKER 级...）始终存在
  // - includeCategoryHeaders 控制的是 severity 分组【内】的 category 子分组标题（**[tag]**）
  // 此处按代码实际行为测试：includeCategoryHeaders=false 时不出现 **[tag]** 子标题
  const { store } = createTempStore();
  const ruleset = store.loadMergedRuleset();
  const output = store.formatForSystemPrompt(ruleset, { includeCategoryHeaders: false });
  // severity 分组标题仍存在
  assert.ok(output.includes("### BLOCKER 级"), "severity 分组标题应存在");
  // category 子分组标题（**[tag]**）不应出现
  // 种子规则的 tags 包含 "code-quality" 等，includeCategoryHeaders=true 时会出现 **[code-quality]**
  assert.ok(!/\*\*\[.+?\]\*\*/.test(output), "includeCategoryHeaders=false 时不应出现 category 子分组标题 **[tag]**");
});

test("B32b. includeCategoryHeaders=true 时包含 category 子分组标题", () => {
  // 反向验证：includeCategoryHeaders=true 时出现 **[tag]** 子分组标题
  const { store } = createTempStore();
  const ruleset = store.loadMergedRuleset();
  const output = store.formatForSystemPrompt(ruleset, { includeCategoryHeaders: true });
  assert.ok(/\*\*\[.+?\]\*\*/.test(output), "includeCategoryHeaders=true 时应出现 category 子分组标题 **[tag]**");
});

test("B33. includeWarnings=false 时不包含 WARNING 级规则", () => {
  // 验证 includeWarnings=false 时 WARNING 段不出现
  const { store, userPath } = createTempStore();
  writeRuleFile(userPath, {
    version: RULES_FILE_VERSION,
    rules: [makeUserRule({ id: "USER-WARN-04", severity: "warning" })],
    removedSeedIds: [],
  });
  const ruleset = store.loadMergedRuleset();
  const output = store.formatForSystemPrompt(ruleset, { includeWarnings: false });
  assert.ok(!output.includes("### WARNING 级"), "includeWarnings=false 时不应有 WARNING 段");
  // 反向验证：includeWarnings=true（默认）时 WARNING 段出现
  const output2 = store.formatForSystemPrompt(ruleset, { includeWarnings: true });
  assert.ok(output2.includes("### WARNING 级"), "includeWarnings=true 时应有 WARNING 段");
});

test("B33b. formatForSystemPrompt 单条规则描述超 200 字符时截断", () => {
  // 验证超长描述被截断到 200 字符并加 "..."
  const { store, userPath } = createTempStore();
  const longDesc = "这是一条超长的描述。" + "测试".repeat(150);
  writeRuleFile(userPath, {
    version: RULES_FILE_VERSION,
    rules: [makeUserRule({ id: "USER-LONG-01", description: longDesc, severity: "major" })],
    removedSeedIds: [],
  });
  const ruleset = store.loadMergedRuleset();
  const output = store.formatForSystemPrompt(ruleset, { tokenBudget: 100000 });
  assert.ok(output.includes("..."), "超长描述应被截断并加 ...");
});

// ============================================================================
// B.6 formatForEvaluator
// ============================================================================

test("B34. 仅返回 injectionTargets 包含 'evaluator' 的规则", () => {
  // 验证 formatForEvaluator 仅返回注入目标包含 evaluator 的规则
  const { store, userPath } = createTempStore();
  // 添加一条仅 system_prompt 的规则（不应出现）+ 一条 evaluator 规则（应出现）
  writeRuleFile(userPath, {
    version: RULES_FILE_VERSION,
    rules: [
      makeUserRule({ id: "USER-PROMPT-ONLY", injectionTargets: ["system_prompt"] }),
      makeUserRule({ id: "USER-EVAL-OK", injectionTargets: ["system_prompt", "evaluator"] }),
    ],
    removedSeedIds: [],
  });
  const ruleset = store.loadMergedRuleset();
  const redlines = store.formatForEvaluator(ruleset);
  // USER-PROMPT-ONLY 不应出现
  assert.equal(
    redlines.find((r) => r.id === "USER-PROMPT-ONLY"),
    undefined,
    "仅 system_prompt 的规则不应进入 evaluator"
  );
  // USER-EVAL-OK 应出现
  assert.ok(redlines.find((r) => r.id === "USER-EVAL-OK"));
  // 种子规则中 injectionTargets 包含 evaluator 的也应出现（如 SEED-01）
  assert.ok(redlines.find((r) => r.id === "SEED-01"));
});

test("B35. 返回 RedlineDefinition 数组（含 id/name/description/severity/checkMethod/checkType/fixGuidance）", () => {
  // 验证返回的每条都是合法的 RedlineDefinition 结构
  const { store } = createTempStore();
  const ruleset = store.loadMergedRuleset();
  const redlines = store.formatForEvaluator(ruleset);
  assert.ok(redlines.length > 0);
  for (const rl of redlines) {
    // 验证 RedlineDefinition 必填字段
    assert.equal(typeof rl.id, "string");
    assert.equal(typeof rl.name, "string");
    assert.equal(typeof rl.description, "string");
    assert.ok(["blocker", "major", "warning"].includes(rl.severity));
    assert.equal(typeof rl.checkMethod, "string");
    assert.ok(["static", "reasoning"].includes(rl.checkType));
    assert.equal(typeof rl.fixGuidance, "string");
  }
});

// ============================================================================
// B.7 validateRule 函数
// ============================================================================

test("B36. 合法规则通过验证（返回 null）", () => {
  // 验证合法规则通过 validateRule 校验
  const rule = makeUserRule();
  const error = validateRule(rule);
  assert.equal(error, null, "合法规则应通过校验");
});

test("B37. 缺少必填字段（id/name/description/severity 等）时验证失败", () => {
  // 验证缺少各种必填字段时 validateRule 返回错误信息
  const base = makeUserRule();
  // 缺少 id（空字符串）
  assert.ok(validateRule({ ...base, id: "" }) !== null, "空 id 应校验失败");
  // 缺少 name（空字符串）
  assert.ok(validateRule({ ...base, name: "" }) !== null, "空 name 应校验失败");
  // 缺少 description（空字符串）
  assert.ok(validateRule({ ...base, description: "" }) !== null, "空 description 应校验失败");
  // injectionTargets 为空数组
  assert.ok(validateRule({ ...base, injectionTargets: [] }) !== null, "空 injectionTargets 应校验失败");
  // tags 不是数组
  assert.ok(validateRule({ ...base, tags: "not-array" as unknown as string[] }) !== null, "tags 非数组应校验失败");
  // removable 不是 boolean
  assert.ok(
    validateRule({ ...base, removable: "yes" as unknown as boolean }) !== null,
    "removable 非 boolean 应校验失败"
  );
});

test("B38. severity 不在枚举内时验证失败", () => {
  // 验证 severity 不在 blocker/major/warning 枚举内时校验失败
  const base = makeUserRule();
  const error = validateRule({ ...base, severity: "CRITICAL" as unknown as RuleSeverity });
  assert.ok(error !== null, "非法 severity 应校验失败");
  assert.match(error!, /severity 无效/);
  // source 非法也应失败
  const error2 = validateRule({ ...base, source: "unknown" as unknown as RuleSource });
  assert.ok(error2 !== null, "非法 source 应校验失败");
  assert.match(error2!, /source 无效/);
});

// ============================================================================
// B.8 ruleToRedline 函数
// ============================================================================

test("B39. 正确将 RuleDefinition 转换为 RedlineDefinition（静态模式）", () => {
  // 验证 ruleToRedline 转换：pattern 非空时为 static 模式
  const rule: RuleDefinition = {
    id: "TEST-STATIC",
    name: "静态检测规则",
    description: "通过正则静态检测的规则",
    severity: "blocker",
    source: "user",
    injectionTargets: ["evaluator"],
    pattern: "console\\.log\\(",
    tags: ["test"],
    removable: true,
  };
  const redline = ruleToRedline(rule);
  assert.equal(redline.id, "TEST-STATIC");
  assert.equal(redline.name, "静态检测规则");
  assert.equal(redline.description, "通过正则静态检测的规则");
  assert.equal(redline.severity, "blocker");
  // pattern 非空 → static
  assert.equal(redline.checkType, "static");
  assert.match(redline.checkMethod, /正则模式扫描/);
  // checkMethod = "正则模式扫描: console\.log\("，验证包含 pattern 内容
  assert.ok(redline.checkMethod.includes("console"));
  // fixGuidance 应包含规则名和描述
  assert.match(redline.fixGuidance!, /静态检测规则/);
  assert.match(redline.fixGuidance!, /通过正则静态检测的规则/);
});

test("B39b. 正确将 RuleDefinition 转换为 RedlineDefinition（推理模式）", () => {
  // 验证 ruleToRedline 转换：pattern 为 null 时为 reasoning 模式
  const rule: RuleDefinition = {
    id: "TEST-REASONING",
    name: "推理判定规则",
    description: "需要 LLM 推理判定的规则",
    severity: "major",
    source: "user",
    injectionTargets: ["evaluator"],
    pattern: null,
    tags: ["test"],
    removable: true,
  };
  const redline = ruleToRedline(rule);
  assert.equal(redline.id, "TEST-REASONING");
  assert.equal(redline.severity, "major");
  // pattern 为 null → reasoning
  assert.equal(redline.checkType, "reasoning");
  assert.match(redline.checkMethod!, /LLM 推理判定/);
  assert.match(redline.fixGuidance!, /推理判定规则/);
});

test("B40. ruleToRedline 字段映射完整（替代 injectionTargets 默认值检查）", () => {
  // 注意：任务描述说"injectionTargets 默认包含 generator 和 evaluator"
  // 但实际代码 InjectionTarget 类型为 "system_prompt" | "evaluator"（无 "generator"）
  // 且 ruleToRedline 不处理 injectionTargets（RedlineDefinition 无此字段）
  // 此处改为验证 ruleToRedline 的完整字段映射
  const rule: RuleDefinition = {
    id: "FULL-MAP-01",
    name: "完整字段映射测试",
    description: "验证所有字段都被正确映射到 RedlineDefinition",
    severity: "warning",
    source: "project",
    injectionTargets: ["system_prompt", "evaluator"],
    pattern: "TODO\\s*:",
    tags: ["mapping"],
    removable: false,
  };
  const redline: RedlineDefinition = ruleToRedline(rule);
  // 验证字段一一映射
  assert.equal(redline.id, rule.id);
  assert.equal(redline.name, rule.name);
  assert.equal(redline.description, rule.description);
  assert.equal(redline.severity, rule.severity);
  // checkType/checkMethod 由 pattern 派生
  assert.equal(redline.checkType, "static");
  assert.ok(redline.checkMethod.includes(rule.pattern!));
  // fixGuidance 由 name + description 派生
  assert.ok(redline.fixGuidance!.includes(rule.name));
  assert.ok(redline.fixGuidance!.includes(rule.description));
  // RedlineDefinition 不应有 injectionTargets 字段（类型层面保证）
  assert.equal("injectionTargets" in redline, false);
});

// ============================================================================
// B.9 estimateTokens 函数
// ============================================================================

test("B41. 空字符串返回 0", () => {
  // 验证 estimateTokens 对空字符串返回 0
  assert.equal(estimateTokens(""), 0);
});

test("B41b. null/undefined 输入返回 0", () => {
  // 验证 estimateTokens 对 null/undefined 安全返回 0
  assert.equal(estimateTokens(null as unknown as string), 0);
  assert.equal(estimateTokens(undefined as unknown as string), 0);
});

test("B42. 中文文本 Token 估算合理（非零）", () => {
  // 验证 estimateTokens 对中文文本返回非零值
  // 1 个中文字符 ≈ 2 Token
  const cnText = "你好世界"; // 4 个中文字符
  const tokens = estimateTokens(cnText);
  assert.ok(tokens > 0, "中文文本应返回非零 Token 数");
  // 4 个中文字符 ≈ 8 Token
  assert.equal(tokens, 8);
});

test("B42b. 英文文本 Token 估算合理", () => {
  // 验证 estimateTokens 对英文文本返回非零值
  // 1 个英文单词 ≈ 1.3 Token
  const enText = "hello world"; // 2 个单词
  const tokens = estimateTokens(enText);
  assert.ok(tokens > 0);
  // 2 单词 * 1.3 = 2.6 → ceil = 3
  assert.equal(tokens, 3);
});

test("B42c. 中英混合文本 Token 估算", () => {
  // 验证 estimateTokens 对中英混合文本正确估算
  const mixedText = "你好 hello 世界 world"; // 4 中文 + 2 英文单词
  const tokens = estimateTokens(mixedText);
  // 4 * 2 + 2 * 1.3 = 8 + 2.6 = 10.6 → ceil = 11
  assert.equal(tokens, 11);
});

test("B42d. DEFAULT_TOKEN_BUDGET 常量存在且为正数", () => {
  // 验证默认 Token 预算常量
  assert.ok(DEFAULT_TOKEN_BUDGET > 0, "默认 Token 预算应为正数");
  assert.equal(typeof DEFAULT_TOKEN_BUDGET, "number");
});

// ============================================================================
// B.10 原子写入
// ============================================================================

test("B43. 写入文件后可正确读取（tmp file + rename 原子操作）", () => {
  // 验证 saveRuleFile（通过 addRule 调用）使用原子写入，写入后可正确读取
  // saveRuleFile 是私有方法，通过 addRule 间接测试
  const { store, userPath } = createTempStore();
  const rule = makeUserRule({ id: "USER-ATOMIC-01" });
  const result = store.addRule(rule, "user");
  assert.equal(result.success, true);
  // 验证文件存在且可正确读取（原子写入后内容完整）
  const file = readRuleFile(userPath);
  assert.ok(file, "文件应存在");
  assert.equal(file!.version, RULES_FILE_VERSION);
  assert.equal(file!.rules.length, 1);
  assert.equal(file!.rules[0].id, "USER-ATOMIC-01");
  assert.equal(file!.rules[0].name, rule.name);
  // 验证 JSON 格式正确（可被 JSON.parse 解析）
  const rawContent = fs.readFileSync(userPath, "utf8");
  assert.doesNotThrow(() => JSON.parse(rawContent), "写入的文件应是合法 JSON");
  // 验证没有残留的 .tmp 临时文件（原子写入后应已被 rename）
  const dir = path.dirname(userPath);
  const files = fs.readdirSync(dir);
  const tmpFiles = files.filter((f) => f.includes(".tmp."));
  assert.equal(tmpFiles.length, 0, "不应残留 .tmp 临时文件");
});

test("B43b. 连续多次 addRule 都能正确持久化", () => {
  // 验证连续多次原子写入都成功
  const { store, userPath } = createTempStore();
  for (let i = 1; i <= 5; i++) {
    const result = store.addRule(makeUserRule({ id: `USER-MULTI-${String(i).padStart(2, "0")}` }), "user");
    assert.equal(result.success, true, `第 ${i} 次 addRule 应成功`);
  }
  const file = readRuleFile(userPath);
  assert.ok(file);
  assert.equal(file!.rules.length, 5);
  // 验证每条规则都在
  for (let i = 1; i <= 5; i++) {
    const id = `USER-MULTI-${String(i).padStart(2, "0")}`;
    assert.ok(
      file!.rules.find((r) => r.id === id),
      `应包含 ${id}`
    );
  }
});

test("B43c. saveRuleFile 自动创建多层父目录", () => {
  // 验证写入时自动创建多层父目录（mkdir recursive）
  const tmpDir = createTempDir("eag-rlis-mkdir-");
  const deepPath = path.join(tmpDir, "a", "b", "c", "user-rules.json");
  const store = new RuleStore({
    userRulesPath: deepPath,
    projectRulesPath: path.join(tmpDir, "project-rules.json"),
  });
  const result = store.addRule(makeUserRule({ id: "USER-DEEP-01" }), "user");
  assert.equal(result.success, true, "应自动创建多层父目录并写入");
  assert.ok(fs.existsSync(deepPath), "深层路径文件应存在");
});

// ============================================================================
// 集成场景测试
// ============================================================================

test("C1. 完整流程：添加 → 加载 → 格式化为 system prompt → 格式化为 evaluator", () => {
  // 端到端集成测试：验证完整流程正确
  const { store } = createTempStore();
  // 1. 添加用户规则
  const userRule = makeUserRule({
    id: "USER-FLOW-01",
    severity: "blocker",
    pattern: "console\\.log\\(",
    injectionTargets: ["system_prompt", "evaluator"],
  });
  const addResult = store.addRule(userRule, "user");
  assert.equal(addResult.success, true);
  // 2. 加载合并规则集
  const ruleset = store.loadMergedRuleset();
  assert.ok(ruleset.rules.find((r) => r.id === "USER-FLOW-01"));
  assert.ok(ruleset.rules.find((r) => r.id === "SEED-01")); // 种子规则也在
  // 3. 格式化为 system prompt
  const promptText = store.formatForSystemPrompt(ruleset);
  assert.ok(promptText.includes("USER-FLOW-01"), "system prompt 应包含用户规则");
  assert.ok(promptText.includes("### BLOCKER 级"));
  // 4. 格式化为 evaluator 红线清单
  const redlines = store.formatForEvaluator(ruleset);
  assert.ok(redlines.find((r) => r.id === "USER-FLOW-01"));
  assert.ok(redlines.find((r) => r.id === "SEED-01"));
  // USER-FLOW-01 应为 static 模式（pattern 非空）
  const userRedline = redlines.find((r) => r.id === "USER-FLOW-01");
  assert.equal(userRedline!.checkType, "static");
});

test("C2. removedSeedIds 与用户规则共存场景", () => {
  // 验证移除可移除种子规则 + 添加用户规则可同时生效
  const { store, userPath } = createTempStore();
  // 用户文件：移除 SEED-02（可移除）+ 添加用户规则
  writeRuleFile(userPath, {
    version: RULES_FILE_VERSION,
    rules: [makeUserRule({ id: "USER-COEXIST-01" })],
    removedSeedIds: ["SEED-02", "SEED-05"],
  });
  const ruleset = store.loadMergedRuleset();
  // SEED-02 / SEED-05 应被移除
  assert.equal(
    ruleset.rules.find((r) => r.id === "SEED-02"),
    undefined
  );
  assert.equal(
    ruleset.rules.find((r) => r.id === "SEED-05"),
    undefined
  );
  // SEED-01（BLOCKER）应保留
  assert.ok(ruleset.rules.find((r) => r.id === "SEED-01"));
  // 用户规则应存在
  assert.ok(ruleset.rules.find((r) => r.id === "USER-COEXIST-01"));
  // removedSeedIds 应包含两条
  assert.ok(ruleset.removedSeedIds.includes("SEED-02"));
  assert.ok(ruleset.removedSeedIds.includes("SEED-05"));
});

test("C3. RULES_FILE_VERSION 常量存在且为正整数", () => {
  // 验证规则文件版本号常量
  assert.equal(typeof RULES_FILE_VERSION, "number");
  assert.ok(RULES_FILE_VERSION > 0, "文件版本号应为正整数");
  assert.equal(RULES_FILE_VERSION, 1, "当前版本应为 1");
});
