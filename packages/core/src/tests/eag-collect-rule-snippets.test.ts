/**
 * EAG-P0 单元测试：DualLayerContextManager.collectRuleSnippets
 *
 * 测试范围（§5.5.3 规则注入通道）：
 * - A. collectRuleSnippets 三分支覆盖（通过 buildOptimizedContext 间接验证）
 *   - A1: ruleStore 未注入 → 无 user_rule 片段
 *   - A2: ruleStore 注入但规则集为空 → 无 user_rule 片段
 *   - A3: ruleStore 注入且有种子规则 → 含 user_rule 片段
 * - B. user_rule 片段结构验证
 *   - B4: type="user_rule"
 *   - B5: source="rlis:user_rules"
 *   - B6: relevance=1.0
 *   - B7: content 非空
 * - C. Token 预算截断
 *   - C8: USER_RULE_TOKEN_BUDGET=4000，超预算时按 severity 截断（WARNING 最先裁）
 *   - C9: MAX_USER_RULE_SNIPPETS=1，仅返回单条汇总片段
 * - D. formatForSystemPrompt 集成
 *   - D10: BLOCKER 级规则在 content 中置顶
 *   - D11: 多层规则（种子+用户+项目）合并后注入
 * - E. 降级语义
 *   - E12: ruleStore.loadMergedRuleset() 异常 → 不影响 buildOptimizedContext 整体流程
 *
 * 测试约定（与项目既有测试一致）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架（按用户硬性规则），使用真实 RuleStore + 真实临时目录
 * - 对真实 RuleStore 无法覆盖的极端场景（空规则集、loadMergedRuleset 抛错），
 *   使用 RuleStore 子类（真实的最简实现，非 mock 框架），参考 v2/tests/integration/p3-pipeline.test.ts
 *   的 TestCodeMapProvider 模式
 * - 中文注释
 *
 * 设计依据：
 * - EAG 方案 §5.5.3 规则注入通道
 * - dual-layer-manager.ts 第 741-819 行 collectRuleSnippets 私有方法
 * - dual-layer-manager.ts 第 161-177 行 MAX_USER_RULE_SNIPPETS / USER_RULE_TOKEN_BUDGET 常量
 * - dual-layer-manager.ts 第 390-402 行 buildOptimizedContext 中 4.8 调用点
 *
 * @module tests/eag-collect-rule-snippets
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// 导入被测类型与依赖（真实实现，非 mock）
import { DualLayerContextManager } from "../v2/context/dual-layer-manager";
import type { CodeMapProvider } from "../v2/context/dual-layer-manager";
import { GlobalContextManager } from "../v2/context/global-context";
import { TaskContextManager } from "../v2/context/task-context-manager";
import { RelevanceScorer } from "../v2/context/relevance-scorer";
import { SlidingWindowManager } from "../v2/context/sliding-window";
import { ProgressiveContextLoader } from "../v2/context/progressive-loader";
import { RuleBasedSummarizer } from "../v2/memory/rule-based-summarizer";
import { RuleStore } from "../eag/rlis/rule-store";
import { SEED_RULES } from "../eag/rlis/seed-rules";
import type { RuleDefinition, MergedRuleSet } from "../eag/rlis/types";
import type { CodeMap } from "../v2/codemap/generator";
import type { TaskDefinition } from "../v2/context/types";

// ============================================================================
// 临时目录管理（参考 eag-rlis.test.ts 模式，禁止 mock，使用真实文件系统）
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
 * 创建测试用 TaskDefinition（最小必填字段）
 * @param overrides 部分字段覆盖
 * @returns 完整的 TaskDefinition
 */
function createTestTaskDef(overrides?: Partial<TaskDefinition>): TaskDefinition {
  return {
    description: "测试任务",
    goals: ["验证 collectRuleSnippets"],
    constraints: [],
    taskType: "test",
    expectedOutput: "测试通过",
    ...overrides,
  };
}

/**
 * 构造一条合法的用户规则（默认值，可通过 overrides 覆盖任意字段）
 * @param overrides 覆盖字段
 * @returns 完整的 RuleDefinition
 */
function makeUserRule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    id: "USER-TEST-01",
    name: "测试用户规则",
    description: "这是一条用于测试的用户规则，描述非空且包含中文。",
    severity: "major",
    source: "user",
    injectionTargets: ["system_prompt"],
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
    id: "PROJ-TEST-01",
    name: "测试项目规则",
    description: "这是一条用于测试的项目规则，描述非空且包含中文。",
    severity: "blocker",
    source: "project",
    injectionTargets: ["system_prompt", "evaluator"],
    pattern: null,
    tags: ["test", "project-rule"],
    removable: true,
    ...overrides,
  };
}

/**
 * 规则文件 JSON 结构（与 rule-store.ts 的私有接口 RuleFile 对齐）
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

// ============================================================================
// Stub 类（真实的最简实现，非 mock 框架）
// ============================================================================

/**
 * 空规则集 RuleStore 子类
 *
 * 用于测试 case A2: ruleStore 注入但规则集为空。
 *
 * 背景：真实 RuleStore 的 loadMergedRuleset 会始终加载 SEED_RULES，
 * 且 BLOCKER 级种子规则（removable=false）不可通过 removedSeedIds 移除，
 * 因此真实 RuleStore 无法构造"完全空的规则集"。
 * 本子类重写 loadMergedRuleset 直接返回空集，是真实的最简实现
 * （参考 p3-pipeline.test.ts 的 TestCodeMapProvider 模式，非 mock 框架）。
 *
 * formatForSystemPrompt 无需重写——父类对空 ruleset 已返回空字符串。
 */
class EmptyRuleStore extends RuleStore {
  /** 重写为返回空规则集 */
  loadMergedRuleset(): MergedRuleSet {
    return {
      rules: [],
      seedCount: 0,
      userCount: 0,
      projectCount: 0,
      removedSeedIds: [],
    };
  }
}

/**
 * 抛异常 RuleStore 子类
 *
 * 用于测试 case E12: ruleStore.loadMergedRuleset() 异常时降级。
 *
 * 背景：真实 RuleStore 的 loadRuleFile 内部 try-catch 包裹，
 * 文件损坏时降级返回 null（不抛错），最终 loadMergedRuleset 仍返回种子规则。
 * 本子类重写 loadMergedRuleset 直接抛错，模拟规则文件损坏场景，
 * 是真实的最简实现（非 mock 框架）。
 */
class ThrowingRuleStore extends RuleStore {
  /** 重写为始终抛错，模拟规则文件损坏 */
  loadMergedRuleset(): MergedRuleSet {
    throw new Error("模拟规则文件损坏：loadMergedRuleset 抛出异常");
  }
}

/**
 * 抛异常的 CodeMapProvider 实现
 *
 * 用于让 buildOptimizedContext 跳过文件层（CodeMap 获取失败时降级为 null）。
 * 这样测试只需关注 directRetainSnippets 通道（含 user_rule 片段），
 * 无需构造真实项目文件与 CodeMapGenerator。
 *
 * 参考 dual-layer-manager.ts 第 312-319 行：
 *   try { codeMap = await this.codeMapProvider.getCodeMap(...) } catch { codeMap = null }
 */
class ThrowingCodeMapProvider implements CodeMapProvider {
  /** 始终抛错，使 buildOptimizedContext 内部 catch 后置 codeMap=null */
  async getCodeMap(_projectRoot: string): Promise<CodeMap> {
    throw new Error("test: no code map（测试桩，跳过文件层）");
  }
}

// ============================================================================
// DualLayerContextManager 工厂
// ============================================================================

/**
 * 构造测试用 DualLayerContextManager 及其真实依赖
 *
 * 使用真实 GlobalContextManager + TaskContextManager + RelevanceScorer +
 * SlidingWindowManager + ProgressiveContextLoader + RuleBasedSummarizer，
 * 仅 CodeMapProvider 使用抛异常的最简实现（跳过文件层，简化测试）。
 *
 * @param projectRoot 项目根目录（临时目录）
 * @param globalContextPath GlobalContext 持久化路径
 * @param options 可选注入参数（ruleStore 等）
 * @returns 含 dualLayer + taskManager + globalManager 的测试组件
 */
function createDualLayerManager(
  projectRoot: string,
  globalContextPath: string,
  options: {
    ruleStore?: RuleStore;
    tokenBudget?: number;
  } = {}
): {
  dualLayer: DualLayerContextManager;
  taskManager: TaskContextManager;
  globalManager: GlobalContextManager;
} {
  const tokenBudget = options.tokenBudget ?? 100_000;
  // 真实全局上下文管理器（指向临时文件，不污染 ~/.deepcode）
  const globalManager = new GlobalContextManager(globalContextPath);
  // 真实任务上下文管理器（内存 Map）
  const taskManager = new TaskContextManager();
  // 真实相关性评分器
  const scorer = new RelevanceScorer();
  // 真实渐进式三层加载器
  const progressiveLoader = new ProgressiveContextLoader({ tokenBudget });
  // 真实基于规则的摘要器（不依赖 LLM）
  const summarizer = new RuleBasedSummarizer();
  // 真实滑动窗口管理器（注入 progressiveLoader + summarizer）
  const windowManager = new SlidingWindowManager({ tokenBudget }, scorer, progressiveLoader, summarizer);
  // 最简 CodeMapProvider（抛错跳过文件层）
  const codeMapProvider = new ThrowingCodeMapProvider();

  // 构造 DualLayerContextManager，注入真实依赖 + 可选 ruleStore
  // 注：userGlobalMemory / experienceRecommender 不注入（本测试不关注这两类片段）
  const dualLayer = new DualLayerContextManager(
    { projectRoot, window: {}, scoring: {}, defaultTokenBudget: tokenBudget },
    globalManager,
    taskManager,
    codeMapProvider,
    scorer,
    windowManager,
    progressiveLoader,
    summarizer,
    undefined, // userGlobalMemory 不注入
    undefined, // experienceRecommender 不注入
    options.ruleStore
  );

  return { dualLayer, taskManager, globalManager };
}

/**
 * 创建并激活一个任务（buildOptimizedContext 要求任务存在且非 pending）
 *
 * @param taskManager 任务管理器
 * @param taskId 任务 ID
 * @param desc 任务描述
 */
function createAndActivateTask(taskManager: TaskContextManager, taskId: string, desc: string): void {
  taskManager.create(taskId, createTestTaskDef({ description: desc }));
  taskManager.updateState(taskId, "in_progress", 0.5, "test-stage");
}

/**
 * 构造临时 RuleStore（使用临时目录，不污染真实 ~/.deepcode）
 * @returns 包含 store + 路径信息
 */
function createTempRuleStore(): {
  store: RuleStore;
  userPath: string;
  projectPath: string;
  tmpDir: string;
} {
  const tmpDir = createTempDir("eag-p0-rules-");
  const userPath = path.join(tmpDir, "user-rules.json");
  const projectPath = path.join(tmpDir, "project-rules.json");
  const store = new RuleStore({
    userRulesPath: userPath,
    projectRulesPath: projectPath,
  });
  return { store, userPath, projectPath, tmpDir };
}

// ============================================================================
// A. collectRuleSnippets 三分支覆盖
// ============================================================================

/**
 * A1: ruleStore 未注入 → 返回的 snippets 中无 type="user_rule" 片段
 *
 * 验证 collectRuleSnippets 第 772-775 行：
 *   if (!this.ruleStore) { return []; }
 */
test("A1. ruleStore 未注入 → 返回的 snippets 中无 type=user_rule 片段", async () => {
  const projectRoot = createTempDir("eag-p0-a1-");
  const globalContextPath = path.join(projectRoot, "global-context.json");
  // 不传 ruleStore（构造函数最后一个可选参数）
  const { dualLayer, taskManager } = createDualLayerManager(projectRoot, globalContextPath);

  const taskId = "task-a1";
  createAndActivateTask(taskManager, taskId, "A1 测试：ruleStore 未注入");

  const snippets = await dualLayer.buildOptimizedContext("default", taskId);

  // 验证：无 user_rule 片段
  const ruleSnippets = snippets.filter((s) => s.type === "user_rule");
  assert.equal(ruleSnippets.length, 0, "ruleStore 未注入时不应有 user_rule 片段");
});

/**
 * A2: ruleStore 注入但规则集为空 → 返回的 snippets 中无 type="user_rule" 片段
 *
 * 验证 collectRuleSnippets 第 781-784 行：
 *   if (ruleset.rules.length === 0) { return []; }
 *
 * 注意：真实 RuleStore 的 SEED_RULES 硬编码且 BLOCKER 级种子规则不可移除，
 * 无法构造完全空的规则集。故使用 EmptyRuleStore 子类（真实的最简实现）。
 */
test("A2. ruleStore 注入但规则集为空 → 返回的 snippets 中无 type=user_rule 片段", async () => {
  const projectRoot = createTempDir("eag-p0-a2-");
  const globalContextPath = path.join(projectRoot, "global-context.json");
  // 使用 EmptyRuleStore 子类模拟空规则集
  const emptyStore = new EmptyRuleStore();
  const { dualLayer, taskManager } = createDualLayerManager(projectRoot, globalContextPath, { ruleStore: emptyStore });

  const taskId = "task-a2";
  createAndActivateTask(taskManager, taskId, "A2 测试：规则集为空");

  const snippets = await dualLayer.buildOptimizedContext("default", taskId);

  // 验证：无 user_rule 片段
  const ruleSnippets = snippets.filter((s) => s.type === "user_rule");
  assert.equal(ruleSnippets.length, 0, "规则集为空时不应有 user_rule 片段");
});

/**
 * A3: ruleStore 注入且有种子规则 → 返回的 snippets 中包含 type="user_rule" 片段
 *
 * 验证 collectRuleSnippets 第 799-818 行：种子规则非空时产出单条汇总片段。
 *
 * 使用真实 RuleStore（无用户/项目规则文件，仅内置 SEED_RULES 10 条）。
 */
test("A3. ruleStore 注入且有种子规则 → 返回的 snippets 中包含 type=user_rule 片段", async () => {
  const projectRoot = createTempDir("eag-p0-a3-");
  const globalContextPath = path.join(projectRoot, "global-context.json");
  // 使用真实 RuleStore（仅种子规则，无用户/项目规则文件）
  const { store: ruleStore } = createTempRuleStore();
  const { dualLayer, taskManager } = createDualLayerManager(projectRoot, globalContextPath, { ruleStore });

  const taskId = "task-a3";
  createAndActivateTask(taskManager, taskId, "A3 测试：有种子规则");

  const snippets = await dualLayer.buildOptimizedContext("default", taskId);

  // 验证：含 user_rule 片段
  const ruleSnippets = snippets.filter((s) => s.type === "user_rule");
  assert.ok(ruleSnippets.length >= 1, `有种子规则时应有 user_rule 片段，实际数量：${ruleSnippets.length}`);
});

// ============================================================================
// B. user_rule 片段结构验证
// ============================================================================

/**
 * B4-B7: user_rule 片段结构（type/source/relevance/content）
 *
 * 验证 collectRuleSnippets 第 802-817 行产出的片段字段：
 * - B4: type="user_rule"
 * - B5: source="rlis:user_rules"
 * - B6: relevance=1.0
 * - B7: content 非空（含规则文本）
 */
test("B4-B7. user_rule 片段结构（type/source/relevance/content）", async () => {
  const projectRoot = createTempDir("eag-p0-b-");
  const globalContextPath = path.join(projectRoot, "global-context.json");
  const { store: ruleStore } = createTempRuleStore();
  const { dualLayer, taskManager } = createDualLayerManager(projectRoot, globalContextPath, { ruleStore });

  const taskId = "task-b";
  createAndActivateTask(taskManager, taskId, "B 测试：片段结构验证");

  const snippets = await dualLayer.buildOptimizedContext("default", taskId);

  const ruleSnippets = snippets.filter((s) => s.type === "user_rule");
  assert.ok(ruleSnippets.length >= 1, "应有 user_rule 片段");

  const snippet = ruleSnippets[0];

  // B4: type="user_rule"
  assert.equal(snippet.type, "user_rule", `type 应为 "user_rule"，实际：${snippet.type}`);

  // B5: source="rlis:user_rules"
  assert.equal(snippet.source, "rlis:user_rules", `source 应为 "rlis:user_rules"，实际：${snippet.source}`);

  // B6: relevance=1.0
  assert.equal(snippet.relevance, 1.0, `relevance 应为 1.0，实际：${snippet.relevance}`);

  // B7: content 非空
  assert.ok(snippet.content.length > 0, `content 不应为空，实际长度：${snippet.content.length}`);
  // content 应含规则清单标题（formatForSystemPrompt 产出）
  assert.ok(
    snippet.content.includes("项目规则清单"),
    `content 应含 "项目规则清单" 标题，实际内容片段：${snippet.content.slice(0, 100)}`
  );
  // content 应含至少一条种子规则 ID（如 SEED-01）
  assert.ok(
    snippet.content.includes("SEED-01"),
    `content 应含 SEED-01 规则，实际内容片段：${snippet.content.slice(0, 200)}`
  );
});

// ============================================================================
// C. Token 预算截断
// ============================================================================

/**
 * C8: USER_RULE_TOKEN_BUDGET=4000，规则文本超预算时按 severity 截断（WARNING 最先裁）
 *
 * 验证 collectRuleSnippets 第 790-792 行：
 *   const content = this.ruleStore.formatForSystemPrompt(ruleset, {
 *     tokenBudget: USER_RULE_TOKEN_BUDGET,
 *   });
 *
 * 测试策略：
 * - 添加大量 WARNING 用户规则（描述超长，确保超 4000 Token 预算）
 * - 验证 BLOCKER 种子规则保留（永不裁剪）
 * - 验证 WARNING 规则被截断（含"已截断"标记）
 *
 * Token 估算：rule-store.ts 的 estimateTokens 中中文 2 token/字，
 * 4000 Token ≈ 2000 中文字符。每条 WARNING 规则描述 500 字符，
 * 10 条 = 5000 字符 ≈ 10000 Token，远超 4000 预算。
 */
test("C8. 超 USER_RULE_TOKEN_BUDGET 时按 severity 截断（WARNING 最先裁）", async () => {
  const projectRoot = createTempDir("eag-p0-c8-");
  const globalContextPath = path.join(projectRoot, "global-context.json");
  const { store: ruleStore, userPath } = createTempRuleStore();

  // 构造 10 条 WARNING 用户规则，每条描述 500 字符（"警告"重复 250 次）
  // 总描述 ≈ 5000 字符 ≈ 10000 Token，远超 4000 Token 预算
  const longDesc = "警告".repeat(250); // 500 个中文字符
  const warningRules: RuleDefinition[] = [];
  for (let i = 0; i < 10; i++) {
    warningRules.push({
      id: `USER-WARN-${String(i + 1).padStart(2, "0")}`,
      name: `测试警告规则 ${i + 1}`,
      description: longDesc,
      severity: "warning",
      source: "user",
      injectionTargets: ["system_prompt"],
      pattern: null,
      tags: ["test", "truncation"],
      removable: true,
    });
  }

  // 写入用户规则文件
  writeRuleFile(userPath, {
    version: 1,
    rules: warningRules,
    removedSeedIds: [],
  });

  const { dualLayer, taskManager } = createDualLayerManager(projectRoot, globalContextPath, { ruleStore });

  const taskId = "task-c8";
  createAndActivateTask(taskManager, taskId, "C8 测试：Token 预算截断");

  const snippets = await dualLayer.buildOptimizedContext("default", taskId);

  const ruleSnippets = snippets.filter((s) => s.type === "user_rule");
  assert.ok(ruleSnippets.length >= 1, "应有 user_rule 片段");

  const content = ruleSnippets[0].content;

  // 断言 1：BLOCKER 种子规则应保留（永不裁剪，第 528-537 行）
  assert.ok(content.includes("SEED-01"), "BLOCKER 种子规则 SEED-01 应保留（永不裁剪）");

  // 断言 2：WARNING 规则应被截断（含"已截断"标记，第 807-809 行）
  assert.ok(content.includes("已截断"), "超预算时 WARNING 规则应被截断，content 应含 '已截断' 标记");

  // 断言 3：不应包含所有 10 条 WARNING 规则（至少有一条被裁）
  // 通过统计 USER-WARN-xx 出现次数验证
  const warnCount = (content.match(/USER-WARN-\d{2}/g) ?? []).length;
  assert.ok(warnCount < 10, `WARNING 规则应被截断，实际出现 ${warnCount} 条（应 < 10）`);
});

/**
 * C9: MAX_USER_RULE_SNIPPETS=1，仅返回单条汇总片段
 *
 * 验证 collectRuleSnippets 第 802-818 行：
 *   return [ { ... } ].slice(0, MAX_USER_RULE_SNIPPETS);
 *
 * 即使有大量规则，collectRuleSnippets 也只产出 1 条汇总片段
 * （formatForSystemPrompt 已在单条片段内做 severity 分组 + Token 截断）。
 */
test("C9. MAX_USER_RULE_SNIPPETS=1 → 仅返回单条汇总片段", async () => {
  const projectRoot = createTempDir("eag-p0-c9-");
  const globalContextPath = path.join(projectRoot, "global-context.json");
  const { store: ruleStore, userPath, projectPath } = createTempRuleStore();

  // 添加多条用户规则和项目规则（验证仍只产出 1 条片段）
  writeRuleFile(userPath, {
    version: 1,
    rules: [
      makeUserRule({ id: "USER-C9-01", severity: "warning" }),
      makeUserRule({ id: "USER-C9-02", severity: "warning" }),
      makeUserRule({ id: "USER-C9-03", severity: "major" }),
    ],
    removedSeedIds: [],
  });
  writeRuleFile(projectPath, {
    version: 1,
    rules: [makeProjectRule({ id: "PROJ-C9-01" })],
    removedSeedIds: [],
  });

  const { dualLayer, taskManager } = createDualLayerManager(projectRoot, globalContextPath, { ruleStore });

  const taskId = "task-c9";
  createAndActivateTask(taskManager, taskId, "C9 测试：单条汇总片段");

  const snippets = await dualLayer.buildOptimizedContext("default", taskId);

  const ruleSnippets = snippets.filter((s) => s.type === "user_rule");
  assert.equal(ruleSnippets.length, 1, `MAX_USER_RULE_SNIPPETS=1，应仅返回单条汇总片段，实际：${ruleSnippets.length}`);
});

// ============================================================================
// D. formatForSystemPrompt 集成
// ============================================================================

/**
 * D10: BLOCKER 级规则在 content 中置顶
 *
 * 验证 formatForSystemPrompt 第 528-537 行：BLOCKER 段落先于 MAJOR/WARNING 段落。
 *
 * 真实种子规则含 5 条 BLOCKER（SEED-01/03/04/06/08）和 5 条 MAJOR（SEED-02/05/07/09/10）。
 */
test("D10. BLOCKER 级规则在 content 中置顶", async () => {
  const projectRoot = createTempDir("eag-p0-d10-");
  const globalContextPath = path.join(projectRoot, "global-context.json");
  const { store: ruleStore } = createTempRuleStore();
  const { dualLayer, taskManager } = createDualLayerManager(projectRoot, globalContextPath, { ruleStore });

  const taskId = "task-d10";
  createAndActivateTask(taskManager, taskId, "D10 测试：BLOCKER 置顶");

  const snippets = await dualLayer.buildOptimizedContext("default", taskId);

  const ruleSnippets = snippets.filter((s) => s.type === "user_rule");
  assert.ok(ruleSnippets.length >= 1, "应有 user_rule 片段");

  const content = ruleSnippets[0].content;

  // 验证 BLOCKER 段落标题存在
  const blockerIdx = content.indexOf("BLOCKER");
  assert.ok(blockerIdx >= 0, "content 应含 BLOCKER 段落标题");

  // 验证 MAJOR 段落标题存在
  const majorIdx = content.indexOf("MAJOR");
  assert.ok(majorIdx >= 0, "content 应含 MAJOR 段落标题");

  // 验证 BLOCKER 在 MAJOR 之前
  assert.ok(blockerIdx < majorIdx, `BLOCKER 应在 MAJOR 之前（blockerIdx=${blockerIdx}, majorIdx=${majorIdx}）`);

  // 额外验证：BLOCKER 段落应含 SEED-01（禁止 mock 开发）
  // 截取 BLOCKER 段落到 MAJOR 之前的部分验证
  const blockerSection = content.slice(blockerIdx, majorIdx);
  assert.ok(blockerSection.includes("SEED-01"), "BLOCKER 段落应含 SEED-01（禁止 mock 开发，BLOCKER 级种子规则）");
});

/**
 * D11: 多层规则（种子+用户+项目）合并后注入
 *
 * 验证 collectRuleSnippets 调用 ruleStore.loadMergedRuleset() 后，
 * 三层规则（种子 + 用户 + 项目）合并文本均出现在 content 中。
 *
 * 合并优先级（rule-store.ts 第 258-272 行）：项目 > 用户 > 种子
 */
test("D11. 多层规则（种子+用户+项目）合并后注入", async () => {
  const projectRoot = createTempDir("eag-p0-d11-");
  const globalContextPath = path.join(projectRoot, "global-context.json");
  const { store: ruleStore, userPath, projectPath } = createTempRuleStore();

  // 写入用户规则
  writeRuleFile(userPath, {
    version: 1,
    rules: [
      makeUserRule({
        id: "USER-D11-01",
        name: "用户层规则D11",
        severity: "major",
      }),
    ],
    removedSeedIds: [],
  });

  // 写入项目规则
  writeRuleFile(projectPath, {
    version: 1,
    rules: [
      makeProjectRule({
        id: "PROJ-D11-01",
        name: "项目层规则D11",
        severity: "blocker",
      }),
    ],
    removedSeedIds: [],
  });

  const { dualLayer, taskManager } = createDualLayerManager(projectRoot, globalContextPath, { ruleStore });

  const taskId = "task-d11";
  createAndActivateTask(taskManager, taskId, "D11 测试：多层规则合并");

  const snippets = await dualLayer.buildOptimizedContext("default", taskId);

  const ruleSnippets = snippets.filter((s) => s.type === "user_rule");
  assert.ok(ruleSnippets.length >= 1, "应有 user_rule 片段");

  const content = ruleSnippets[0].content;

  // 验证种子规则存在（SEED-01 作为 BLOCKER 永远存在）
  assert.ok(content.includes("SEED-01"), "应含种子规则 SEED-01");

  // 验证用户规则存在
  assert.ok(content.includes("USER-D11-01"), "应含用户规则 USER-D11-01");

  // 验证项目规则存在
  assert.ok(content.includes("PROJ-D11-01"), "应含项目规则 PROJ-D11-01");
});

// ============================================================================
// E. 降级语义
// ============================================================================

/**
 * E12: ruleStore.loadMergedRuleset() 异常 → 不影响 buildOptimizedContext 整体流程
 *
 * 验证 collectRuleSnippets 上层 try-catch（第 396-402 行）：
 *   try {
 *     const ruleSnippets = this.collectRuleSnippets();
 *     directRetainSnippets.push(...ruleSnippets);
 *   } catch {
 *     // RuleStore 收集失败：降级为无规则片段（不中断整体 buildOptimizedContext 流程）
 *   }
 *
 * 测试策略：
 * - 使用 ThrowingRuleStore 子类（loadMergedRuleset 抛错）
 * - 验证 buildOptimizedContext 不抛错（降级语义）
 * - 验证无 user_rule 片段（降级为空）
 * - 验证其他片段正常返回（如 task_definition，证明整体流程未中断）
 *
 * 注意：真实 RuleStore 的 loadMergedRuleset 内部 try-catch 不会抛错
 * （loadRuleFile 捕获异常后返回 null），故用 ThrowingRuleStore 子类模拟。
 */
test("E12. ruleStore.loadMergedRuleset() 异常 → 不影响 buildOptimizedContext 整体流程", async () => {
  const projectRoot = createTempDir("eag-p0-e12-");
  const globalContextPath = path.join(projectRoot, "global-context.json");
  // 使用 ThrowingRuleStore 子类模拟规则文件损坏
  const throwingStore = new ThrowingRuleStore();
  const { dualLayer, taskManager } = createDualLayerManager(projectRoot, globalContextPath, {
    ruleStore: throwingStore,
  });

  const taskId = "task-e12";
  createAndActivateTask(taskManager, taskId, "E12 测试：降级语义");

  // buildOptimizedContext 不应抛错（上层 try-catch 降级为无规则片段）
  const snippets = await dualLayer.buildOptimizedContext("default", taskId);

  // 验证 1：无 user_rule 片段（降级为空）
  const ruleSnippets = snippets.filter((s) => s.type === "user_rule");
  assert.equal(ruleSnippets.length, 0, "loadMergedRuleset 异常时不应有 user_rule 片段（降级为空）");

  // 验证 2：整体流程未崩溃——应返回其他 directRetain 片段
  // task_definition 片段由 collectTaskSnippets 产出（不依赖 ruleStore）
  const hasTaskDef = snippets.some((s) => s.type === "task_definition");
  assert.ok(hasTaskDef, "应含 task_definition 片段（证明整体流程未中断，其他 directRetain 正常工作）");

  // 验证 3：应含 progressive_metadata 片段（PCL 三层加载也不依赖 ruleStore）
  const hasPclMetadata = snippets.some((s) => s.type === "progressive_metadata");
  assert.ok(hasPclMetadata, "应含 progressive_metadata 片段（PCL 加载未受 ruleStore 异常影响）");
});

// ============================================================================
// 补充：种子规则基础验证（确认测试数据完整性）
// ============================================================================

/**
 * 补充验证：SEED_RULES 非空（确保 A3/B/C/D 测试有规则可注入）
 *
 * 如果 SEED_RULES 为空，A3/B/C/D 测试将无法通过——此用例作为前置条件验证。
 */
test("补充. SEED_RULES 非空（前置条件，确保 A3/B/C/D 测试有规则可注入）", () => {
  assert.ok(Array.isArray(SEED_RULES), "SEED_RULES 应为数组");
  assert.ok(SEED_RULES.length > 0, `SEED_RULES 应非空（实际：${SEED_RULES.length} 条）`);
  // 验证含至少 1 条 BLOCKER 级种子规则（用于 D10 测试）
  const blockerCount = SEED_RULES.filter((r) => r.severity === "blocker").length;
  assert.ok(blockerCount > 0, `SEED_RULES 应含至少 1 条 BLOCKER 级规则（实际：${blockerCount} 条）`);
});
