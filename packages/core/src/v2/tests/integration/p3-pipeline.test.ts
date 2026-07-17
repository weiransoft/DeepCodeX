/**
 * V2-P3 集成测试（IT-P3-01 ~ IT-P3-11）
 *
 * 测试覆盖（V2-P3 集成架构师审查 v1 落实）：
 * - IT-P3-01: DomainKnowledge 注入（persistToGlobalContext → buildOptimizedContext 含 domain_concept/domain_rule）
 * - IT-P3-02: UserGlobalMemory 注入（updateGlobalMemory → buildOptimizedContext 含 user_global_memory）
 * - IT-P3-03: ExperienceRecommender 注入（recommend → buildOptimizedContext 含 experience_recommendation）
 * - IT-P3-04: 三模块联合注入（构造时注入 2 个模块，返回值含 V2-P3 + V2-P1/P2 全部类型）
 * - IT-P3-05: 降级测试（2 个模块均未注入，buildOptimizedContext 正常工作，与 V2-P2 行为一致）
 * - IT-P3-06: 部分降级（仅注入 userGlobalMemory 或 experienceRecommender，非对称降级语义）
 * - IT-P3-07: Token 预算超限（directRetain 总量 > defaultTokenBudget，scoringCandidates remainingBudget=0 不崩溃）
 * - IT-P3-08: accessCount 不膨胀（连续调用 buildOptimizedContext N 次，推荐经验 accessCount 增量=0，P0-2 修复核心断言）
 * - IT-P3-09: 经验去重（同一条经验同时满足"最近"和"RAG 推荐"，仅出现一次，P1-2 修复）
 * - IT-P3-10: collectXxx 异常降级（推荐器抛异常时其他片段正常返回）
 * - IT-P3-11: ConceptEntry 无 confidence 适配（domainKnowledge 持久化后 collectDomainKnowledgeSnippets 正常工作，P0-1 修复）
 *
 * 所有测试使用真实组件（CodeMapGenerator + GlobalContextManager + TaskContextManager +
 * ProgressiveContextLoader + RuleBasedSummarizer + UserGlobalMemoryManager + ExperienceRecommender +
 * DomainModeler），禁止 mock。通过临时目录隔离避免污染真实 ~/.deepcode。
 *
 * 设计依据：
 * - V2-P3 集成架构师审查报告 v1（2026-07-17）§五 测试覆盖度评估
 * - P0-1/P0-2/P0-3/P1-1/P1-2/P1-3/P1-4 修复后验证
 *
 * @module v2/tests/integration/p3-pipeline.test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { CodeMapGenerator } from "../../codemap/generator";
import type { CodeMap } from "../../codemap/generator";
import { GlobalContextManager } from "../../context/global-context";
import type { SuccessExperience } from "../../context/global-context";
import { TaskContextManager } from "../../context/task-context-manager";
import type { TaskDefinition, FocusPoint } from "../../context/types";
import { RelevanceScorer } from "../../context/relevance-scorer";
import { SlidingWindowManager } from "../../context/sliding-window";
import { DualLayerContextManager } from "../../context/dual-layer-manager";
import type { CodeMapProvider } from "../../context/dual-layer-manager";
import { ProgressiveContextLoader } from "../../context/progressive-loader";
import { RuleBasedSummarizer } from "../../memory/rule-based-summarizer";
// V2-P3 新增导入
import { MemoryStore } from "../../memory/memory-store";
import { UserGlobalMemoryManager } from "../../memory/user-global-memory";
import type { Fact } from "../../memory/user-global-memory";
import { ExperienceRecommender } from "../../memory/experience-recommender";
import { TFIDFEmbedder } from "../../integration/v1-adapters";
import { DomainModeler } from "../../understanding/domain-modeler";
import type { DomainModel } from "../../understanding/domain-modeler";

// ============================================================================
// 辅助工厂
// ============================================================================

/**
 * 创建临时项目目录
 */
function createTmpProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-p3-it-"));
}

/**
 * 清理临时目录
 */
function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

/**
 * 写入文件（自动创建父目录）
 */
function writeFile(projectRoot: string, relativePath: string, content: string): void {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

/**
 * 创建测试用 TaskDefinition
 */
function createTestTaskDef(overrides?: Partial<TaskDefinition>): TaskDefinition {
  return {
    description: "V2-P3 集成测试任务",
    goals: ["验证 V2-P3 集成流程"],
    constraints: ["不依赖外部资源"],
    taskType: "test",
    expectedOutput: "测试通过",
    ...overrides,
  };
}

/**
 * 创建测试用 FocusPoint（file 类型）
 */
function createFileFocusPoint(ref: string, priority = 0.8): FocusPoint {
  return {
    type: "file",
    ref,
    priority,
    addedAt: new Date().toISOString(),
  };
}

/**
 * 创建测试用成功经验
 */
function makeSuccessExp(overrides: Partial<SuccessExperience> = {}): SuccessExperience {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    taskType: "bugfix",
    description: "修复内存泄漏",
    solution: "释放事件监听器",
    tags: ["memory"],
    importance: 5,
    createdAt: now,
    accessCount: 0,
    lastAccessedAt: now,
    ...overrides,
  };
}

/**
 * 创建测试用 Fact
 */
function makeFact(overrides: Partial<Fact> = {}): Fact {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    content: "测试事实",
    confidence: 0.7,
    source: "auto_extracted",
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    ...overrides,
  };
}

/**
 * CodeMapProvider 的测试实现：包装 CodeMapGenerator，会话级缓存
 */
class TestCodeMapProvider implements CodeMapProvider {
  private cache: Map<string, CodeMap> = new Map();
  constructor(
    private readonly generator: CodeMapGenerator,
    private readonly enableCache: boolean = true
  ) {}
  async getCodeMap(projectRoot: string): Promise<CodeMap> {
    if (this.enableCache) {
      const cached = this.cache.get(projectRoot);
      if (cached) return cached;
    }
    const map = await this.generator.generateFullMap();
    if (this.enableCache) {
      this.cache.set(projectRoot, map);
    }
    return map;
  }
}

/**
 * 创建 V2-P3 完整集成组件
 *
 * @param projectRoot 项目根目录
 * @param globalManager 全局上下文管理器
 * @param taskManager 任务上下文管理器
 * @param codeMapProvider CodeMap 提供者
 * @param options 可选注入参数（V2-P3 新增：userGlobalMemory / experienceRecommender）
 * @returns 含 dualLayer + 相关组件的集成组件
 */
function createV2P3Components(
  projectRoot: string,
  globalManager: GlobalContextManager,
  taskManager: TaskContextManager,
  codeMapProvider: CodeMapProvider,
  options: {
    tokenBudget?: number;
    userGlobalMemory?: UserGlobalMemoryManager;
    experienceRecommender?: ExperienceRecommender;
  } = {}
): {
  dualLayer: DualLayerContextManager;
  windowManager: SlidingWindowManager;
  progressiveLoader: ProgressiveContextLoader;
  summarizer: RuleBasedSummarizer;
} {
  const tokenBudget = options.tokenBudget ?? 100_000;
  const scorer = new RelevanceScorer();
  const progressiveLoader = new ProgressiveContextLoader({ tokenBudget });
  const summarizer = new RuleBasedSummarizer();
  const windowManager = new SlidingWindowManager({ tokenBudget }, scorer, progressiveLoader, summarizer);
  // V2-P3：构造时可选注入 userGlobalMemory + experienceRecommender
  const dualLayer = new DualLayerContextManager(
    { projectRoot, window: {}, scoring: {}, defaultTokenBudget: tokenBudget },
    globalManager,
    taskManager,
    codeMapProvider,
    scorer,
    windowManager,
    progressiveLoader,
    summarizer,
    options.userGlobalMemory,
    options.experienceRecommender
  );
  return { dualLayer, windowManager, progressiveLoader, summarizer };
}

/**
 * 创建 V2-P3 集成测试 fixture（含临时项目 + 全局上下文 + 用户记忆目录）
 */
function createV2P3Fixture(projectRoot: string, globalContextPath: string) {
  const generator = new CodeMapGenerator({
    projectRoot,
    extensions: [".ts"],
    excludeDirs: ["node_modules"],
    maxFileSizeKb: 512,
    incremental: false,
    outputPath: ".deepcode/codemap.json",
  });
  const codeMapProvider = new TestCodeMapProvider(generator);
  const globalManager = new GlobalContextManager(globalContextPath);
  const taskManager = new TaskContextManager();
  return { generator, codeMapProvider, globalManager, taskManager };
}

// ============================================================================
// 集成测试用例（IT-P3-01 ~ IT-P3-11）
// ============================================================================

// ============================================================
// IT-P3-01: DomainKnowledge 注入（DomainModeler.persistToGlobalContext → buildOptimizedContext 含 domain_concept/domain_rule）
// ============================================================

test("IT-P3-01: DomainKnowledge 注入（persistToGlobalContext → 返回值含 domain_concept 和 domain_rule 类型）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  try {
    // ---- 准备项目：含 @Entity 装饰器的 TS 文件（触发 DomainModeler 高置信度提取）----
    writeFile(
      projectRoot,
      "src/user.ts",
      `import { Entity } from "typeorm";\n@Entity()\nexport class User {\n  id: number;\n  name: string;\n}\n`
    );

    // ---- 构造 fixture ----
    const globalContextPath = path.join(tmpGlobalDir, "global-context.json");
    const { generator, codeMapProvider, globalManager, taskManager } = createV2P3Fixture(
      projectRoot,
      globalContextPath
    );

    // ---- 通过 DomainModeler 持久化领域知识到 GlobalContext ----
    const modeler = new DomainModeler(generator, globalManager);
    const model: DomainModel = await modeler.model(projectRoot);
    await modeler.persistToGlobalContext("default", model);

    // 验证：DomainModel 应含至少 1 个概念（UserEntity）
    assert.ok(model.concepts.length > 0, `DomainModel 应含至少 1 个概念，实际：${model.concepts.length}`);

    // ---- 构造 V2-P3 集成组件（不注入 userGlobalMemory / experienceRecommender，仅测试 domainKnowledge）----
    const { dualLayer } = createV2P3Components(projectRoot, globalManager, taskManager, codeMapProvider);

    // ---- 创建任务 ----
    const taskId = "it-p3-01-task";
    taskManager.create(taskId, createTestTaskDef({ description: "IT-P3-01 DomainKnowledge 注入测试" }));
    taskManager.updateState(taskId, "in_progress", 0.5, "test-stage");

    // ---- 调用 buildOptimizedContext ----
    const snippets = await dualLayer.buildOptimizedContext("default", taskId);

    // 断言 1：返回值含 type=domain_concept 片段
    const conceptSnippets = snippets.filter((s) => s.type === "domain_concept");
    assert.ok(
      conceptSnippets.length >= 1,
      `应含至少 1 个 domain_concept 片段，实际类型：${snippets.map((s) => s.type).join(", ")}`
    );

    // 断言 2：domain_concept 片段 source 前缀为 "global:domain:concept:"
    assert.ok(
      conceptSnippets[0].source.startsWith("global:domain:concept:"),
      `domain_concept source 应以 "global:domain:concept:" 开头，实际：${conceptSnippets[0].source}`
    );

    // 断言 3：domain_concept 片段 content 含 "[业务概念]"
    assert.ok(
      conceptSnippets[0].content.includes("[业务概念]"),
      `domain_concept content 应含 "[业务概念]"，实际：${conceptSnippets[0].content}`
    );
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});

// ============================================================
// IT-P3-02: UserGlobalMemory 注入（updateGlobalMemory → buildOptimizedContext 含 user_global_memory）
// ============================================================

test("IT-P3-02: UserGlobalMemory 注入（updateGlobalMemory → 返回值含 user_global_memory 类型）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  const tmpMemoryDir = createTmpProjectDir();
  try {
    // ---- 准备项目：单个 TS 文件 ----
    writeFile(projectRoot, "src/index.ts", `export function main(): void { console.log("hello"); }\n`);

    // ---- 构造 fixture ----
    const globalContextPath = path.join(tmpGlobalDir, "global-context.json");
    const { codeMapProvider, globalManager, taskManager } = createV2P3Fixture(projectRoot, globalContextPath);

    // ---- 创建 UserGlobalMemoryManager 并写入用户记忆 ----
    // 设置 HOME 隔离用户记忆目录
    const originalHome = process.env.HOME;
    process.env.HOME = tmpMemoryDir;
    try {
      const memoryStore = new MemoryStore(null);
      const userGlobalMemory = new UserGlobalMemoryManager(memoryStore);
      userGlobalMemory.updateGlobalMemory("default", {
        personalContext: "偏好中文注释",
        workContext: "这是一个 TypeScript CLI 项目",
        facts: [makeFact({ content: "用户偏好 4 空格缩进", confidence: 0.9 })],
      });

      // ---- 构造 V2-P3 集成组件（注入 userGlobalMemory）----
      const { dualLayer } = createV2P3Components(projectRoot, globalManager, taskManager, codeMapProvider, {
        userGlobalMemory,
      });

      // ---- 创建任务 ----
      const taskId = "it-p3-02-task";
      taskManager.create(
        taskId,
        createTestTaskDef({ description: "IT-P3-02 UserGlobalMemory 注入测试", taskType: "feature" })
      );
      taskManager.updateState(taskId, "in_progress", 0.5, "implementing");

      // ---- 调用 buildOptimizedContext ----
      const snippets = await dualLayer.buildOptimizedContext("default", taskId);

      // 断言 1：返回值含 type=user_global_memory 片段
      const memorySnippets = snippets.filter((s) => s.type === "user_global_memory");
      assert.ok(
        memorySnippets.length === 1,
        `应含恰好 1 个 user_global_memory 片段（MAX_USER_MEMORY_SNIPPETS=1），实际：${memorySnippets.length}`
      );

      // 断言 2：片段 source 为 "global:user_global_memory"
      assert.equal(
        memorySnippets[0].source,
        "global:user_global_memory",
        `source 应为 "global:user_global_memory"，实际：${memorySnippets[0].source}`
      );

      // 断言 3：片段 content 含 "偏好中文注释" 和 "TypeScript CLI"
      const content = memorySnippets[0].content;
      assert.ok(content.includes("偏好中文注释"), `content 应含 "偏好中文注释"，实际：${content}`);
      assert.ok(content.includes("TypeScript CLI"), `content 应含 "TypeScript CLI"，实际：${content}`);

      // 断言 4：片段 relevance=1.0（用户级最高优先级）
      assert.equal(memorySnippets[0].relevance, 1.0, `relevance 应为 1.0，实际：${memorySnippets[0].relevance}`);
    } finally {
      // 还原 HOME
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
    cleanupTmpDir(tmpMemoryDir);
  }
});

// ============================================================
// IT-P3-03: ExperienceRecommender 注入（recommend → buildOptimizedContext 含 experience_recommendation）
// ============================================================

test("IT-P3-03: ExperienceRecommender 注入（recommend → 返回值含 experience_recommendation 类型）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  try {
    // ---- 准备项目：单个 TS 文件 ----
    writeFile(projectRoot, "src/index.ts", `export function main(): void { console.log("hello"); }\n`);

    // ---- 构造 fixture ----
    const globalContextPath = path.join(tmpGlobalDir, "global-context.json");
    const { codeMapProvider, globalManager, taskManager } = createV2P3Fixture(projectRoot, globalContextPath);

    // ---- 添加 3 条成功经验到 GlobalContext（taskType=feature）----
    const exp1 = makeSuccessExp({
      taskType: "feature",
      description: "实现用户登录功能",
      solution: "使用 JWT + bcrypt",
      importance: 8,
    });
    const exp2 = makeSuccessExp({
      taskType: "feature",
      description: "实现数据导出功能",
      solution: "使用 csv-writer",
      importance: 6,
    });
    globalManager.addSuccessExperience("default", exp1);
    globalManager.addSuccessExperience("default", exp2);

    // ---- 创建 ExperienceRecommender（注入 globalManager + TFIDFEmbedder）----
    const embedder = new TFIDFEmbedder({ max_features: 5000, norm: "l2" });
    const experienceRecommender = new ExperienceRecommender(globalManager, embedder);

    // ---- 构造 V2-P3 集成组件（注入 experienceRecommender）----
    const { dualLayer } = createV2P3Components(projectRoot, globalManager, taskManager, codeMapProvider, {
      experienceRecommender,
    });

    // ---- 创建任务（taskType=feature，与经验匹配）----
    const taskId = "it-p3-03-task";
    taskManager.create(
      taskId,
      createTestTaskDef({
        description: "IT-P3-03 ExperienceRecommender 注入测试，实现用户认证",
        taskType: "feature",
      })
    );
    taskManager.updateState(taskId, "in_progress", 0.5, "implementing");

    // ---- 调用 buildOptimizedContext ----
    const snippets = await dualLayer.buildOptimizedContext("default", taskId);

    // 断言 1：返回值含 type=experience_recommendation 片段
    const recSnippets = snippets.filter((s) => s.type === "experience_recommendation");
    assert.ok(
      recSnippets.length >= 1,
      `应含至少 1 个 experience_recommendation 片段，实际类型：${snippets.map((s) => s.type).join(", ")}`
    );

    // 断言 2：片段 source 前缀为 "global:experience:recommendation:"
    assert.ok(
      recSnippets[0].source.startsWith("global:experience:recommendation:"),
      `source 应以 "global:experience:recommendation:" 开头，实际：${recSnippets[0].source}`
    );

    // 断言 3：片段 content 含 "推荐成功经验" 或 "推荐失败教训"
    assert.ok(
      recSnippets[0].content.includes("推荐成功经验") || recSnippets[0].content.includes("推荐失败教训"),
      `content 应含 "推荐成功经验" 或 "推荐失败教训"，实际：${recSnippets[0].content}`
    );

    // 断言 4：片段 content 含 "推荐理由:"（OPT-3：reason 字段提升 LLM 可解释性）
    assert.ok(
      recSnippets[0].content.includes("推荐理由:"),
      `content 应含 "推荐理由:"，实际：${recSnippets[0].content}`
    );
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});

// ============================================================
// IT-P3-04: 三模块联合注入（构造时注入 2 个模块，返回值含 V2-P3 + V2-P1/P2 全部类型）
// ============================================================

test("IT-P3-04: 三模块联合注入（userGlobalMemory + experienceRecommender + domainKnowledge → 返回值含全部 V2-P3 类型）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  const tmpMemoryDir = createTmpProjectDir();
  try {
    // ---- 准备项目：含 @Entity 装饰器 + 普通 TS 文件 ----
    writeFile(
      projectRoot,
      "src/user.ts",
      `import { Entity } from "typeorm";\n@Entity()\nexport class User { id: number; name: string; }\n`
    );
    writeFile(projectRoot, "src/index.ts", `export function main(): void { console.log("hello"); }\n`);

    // ---- 构造 fixture ----
    const globalContextPath = path.join(tmpGlobalDir, "global-context.json");
    const { generator, codeMapProvider, globalManager, taskManager } = createV2P3Fixture(
      projectRoot,
      globalContextPath
    );

    // ---- 1. 持久化 DomainKnowledge ----
    const modeler = new DomainModeler(generator, globalManager);
    const model = await modeler.model(projectRoot);
    await modeler.persistToGlobalContext("default", model);

    // ---- 2. 添加历史经验 ----
    globalManager.addSuccessExperience(
      "default",
      makeSuccessExp({
        taskType: "feature",
        description: "实现用户认证",
        solution: "JWT + bcrypt",
        importance: 8,
      })
    );

    // ---- 3. 创建 userGlobalMemory + experienceRecommender ----
    const originalHome = process.env.HOME;
    process.env.HOME = tmpMemoryDir;
    try {
      const memoryStore = new MemoryStore(null);
      const userGlobalMemory = new UserGlobalMemoryManager(memoryStore);
      userGlobalMemory.updateGlobalMemory("default", {
        personalContext: "偏好中文注释",
        workContext: "TypeScript CLI 项目",
      });

      const embedder = new TFIDFEmbedder({ max_features: 5000, norm: "l2" });
      const experienceRecommender = new ExperienceRecommender(globalManager, embedder);

      // ---- 构造 V2-P3 集成组件（注入两个模块）----
      const { dualLayer } = createV2P3Components(projectRoot, globalManager, taskManager, codeMapProvider, {
        userGlobalMemory,
        experienceRecommender,
      });

      // ---- 创建任务 ----
      const taskId = "it-p3-04-task";
      taskManager.create(
        taskId,
        createTestTaskDef({
          description: "IT-P3-04 三模块联合注入测试，实现用户认证",
          taskType: "feature",
        })
      );
      taskManager.updateState(taskId, "in_progress", 0.5, "implementing");
      taskManager.addFocusPoint(taskId, createFileFocusPoint("src/index.ts"));
      taskManager.addThought(taskId, "分析需求", "analyzing");

      // ---- 调用 buildOptimizedContext ----
      const snippets = await dualLayer.buildOptimizedContext("default", taskId);

      // 断言 1：返回值含 V2-P3 三种类型
      const types = new Set(snippets.map((s) => s.type));
      assert.ok(types.has("user_global_memory"), `应含 user_global_memory 类型，实际类型：${[...types].join(", ")}`);
      assert.ok(types.has("domain_concept"), `应含 domain_concept 类型，实际类型：${[...types].join(", ")}`);
      assert.ok(
        types.has("experience_recommendation"),
        `应含 experience_recommendation 类型，实际类型：${[...types].join(", ")}`
      );

      // 断言 2：返回值含 V2-P1 既有类型（user_profile + experience_success/failure + task_*）
      assert.ok(types.has("user_profile"), `应含 user_profile 类型，实际类型：${[...types].join(", ")}`);
      assert.ok(types.has("task_definition"), `应含 task_definition 类型，实际类型：${[...types].join(", ")}`);

      // 断言 3：返回值含 V2-P2 既有类型（progressive_metadata/instruction）
      assert.ok(
        types.has("progressive_metadata") || types.has("progressive_instruction"),
        `应含 V2-P2 PCL 类型，实际类型：${[...types].join(", ")}`
      );
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
    cleanupTmpDir(tmpMemoryDir);
  }
});

// ============================================================
// IT-P3-05: 降级测试（2 个模块均未注入，buildOptimizedContext 正常工作，与 V2-P2 行为一致）
// ============================================================

test("IT-P3-05: 降级测试（不注入 userGlobalMemory / experienceRecommender → 返回值不含 V2-P3 新增类型）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  try {
    // ---- 准备项目：单个 TS 文件 ----
    writeFile(projectRoot, "src/index.ts", `export function main(): void { console.log("hello"); }\n`);

    // ---- 构造 fixture ----
    const globalContextPath = path.join(tmpGlobalDir, "global-context.json");
    const { codeMapProvider, globalManager, taskManager } = createV2P3Fixture(projectRoot, globalContextPath);

    // ---- 构造 V2-P3 集成组件（不注入 V2-P3 模块）----
    const { dualLayer } = createV2P3Components(projectRoot, globalManager, taskManager, codeMapProvider);

    // ---- 创建任务 ----
    const taskId = "it-p3-05-task";
    taskManager.create(taskId, createTestTaskDef({ description: "IT-P3-05 降级测试" }));
    taskManager.updateState(taskId, "in_progress", 0.5, "test-stage");
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/index.ts"));

    // ---- 调用 buildOptimizedContext ----
    const snippets = await dualLayer.buildOptimizedContext("default", taskId);

    // 断言 1：返回值非空（应含 V2-P1/P2 既有片段）
    assert.ok(snippets.length > 0, "降级路径应返回非空片段列表（V2-P1/P2 既有片段）");

    // 断言 2：返回值不含 V2-P3 userGlobalMemory 类型
    const types = new Set(snippets.map((s) => s.type));
    assert.ok(!types.has("user_global_memory"), "降级路径不应含 user_global_memory 类型");

    // 断言 3：返回值不含 V2-P3 experienceRecommendation 类型
    assert.ok(!types.has("experience_recommendation"), "降级路径不应含 experience_recommendation 类型");

    // 断言 4：返回值仍含 V2-P1 既有 user_profile 类型
    assert.ok(types.has("user_profile"), `降级路径应仍含 user_profile，实际类型：${[...types].join(", ")}`);

    // 断言 5：返回值仍含 V2-P1 既有 task_definition 类型
    assert.ok(types.has("task_definition"), `降级路径应仍含 task_definition，实际类型：${[...types].join(", ")}`);
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});

// ============================================================
// IT-P3-06: 部分降级（仅注入 userGlobalMemory 或 experienceRecommender，非对称降级语义）
// ============================================================

test("IT-P3-06: 部分降级（仅注入 userGlobalMemory，不注入 experienceRecommender → 含 user_global_memory 不含 experience_recommendation）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  const tmpMemoryDir = createTmpProjectDir();
  try {
    writeFile(projectRoot, "src/index.ts", `export function main(): void { console.log("hello"); }\n`);
    const globalContextPath = path.join(tmpGlobalDir, "global-context.json");
    const { codeMapProvider, globalManager, taskManager } = createV2P3Fixture(projectRoot, globalContextPath);

    const originalHome = process.env.HOME;
    process.env.HOME = tmpMemoryDir;
    try {
      const memoryStore = new MemoryStore(null);
      const userGlobalMemory = new UserGlobalMemoryManager(memoryStore);
      userGlobalMemory.updateGlobalMemory("default", { personalContext: "偏好中文注释" });

      // 仅注入 userGlobalMemory，不注入 experienceRecommender
      const { dualLayer } = createV2P3Components(projectRoot, globalManager, taskManager, codeMapProvider, {
        userGlobalMemory,
      });

      const taskId = "it-p3-06-task";
      taskManager.create(taskId, createTestTaskDef({ description: "IT-P3-06 部分降级测试", taskType: "feature" }));
      taskManager.updateState(taskId, "in_progress", 0.5, "test");

      const snippets = await dualLayer.buildOptimizedContext("default", taskId);
      const types = new Set(snippets.map((s) => s.type));

      // 断言：含 user_global_memory（已注入）
      assert.ok(types.has("user_global_memory"), `应含 user_global_memory，实际类型：${[...types].join(", ")}`);
      // 断言：不含 experience_recommendation（未注入）
      assert.ok(!types.has("experience_recommendation"), "不应含 experience_recommendation（未注入）");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
    cleanupTmpDir(tmpMemoryDir);
  }
});

// ============================================================
// IT-P3-07: Token 预算超限（directRetain 总量 > defaultTokenBudget，scoringCandidates 不崩溃）
// ============================================================

test("IT-P3-07: Token 预算超限（directRetain 总量 > defaultTokenBudget，scoringCandidates remainingBudget=0 不崩溃）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  const tmpMemoryDir = createTmpProjectDir();
  try {
    writeFile(projectRoot, "src/index.ts", `export function main(): void { console.log("hello"); }\n`);
    const globalContextPath = path.join(tmpGlobalDir, "global-context.json");
    const { codeMapProvider, globalManager, taskManager } = createV2P3Fixture(projectRoot, globalContextPath);

    // 准备大量经验（挤占 directRetain 预算）
    for (let i = 0; i < 20; i++) {
      globalManager.addSuccessExperience(
        "default",
        makeSuccessExp({
          taskType: "feature",
          description: `实现功能 ${i} 的详细描述用于挤占 token 预算`,
          solution: `解决方案 ${i} 的详细说明`,
          importance: 5,
        })
      );
    }

    const originalHome = process.env.HOME;
    process.env.HOME = tmpMemoryDir;
    try {
      const memoryStore = new MemoryStore(null);
      const userGlobalMemory = new UserGlobalMemoryManager(memoryStore);
      // 写入超长 personalContext 挤占预算
      userGlobalMemory.updateGlobalMemory("default", {
        personalContext: "A".repeat(5000),
      });

      const embedder = new TFIDFEmbedder({ max_features: 5000, norm: "l2" });
      const experienceRecommender = new ExperienceRecommender(globalManager, embedder);

      // 极小 tokenBudget=10，确保 directRetain 超预算
      const { dualLayer } = createV2P3Components(projectRoot, globalManager, taskManager, codeMapProvider, {
        userGlobalMemory,
        experienceRecommender,
        tokenBudget: 10,
      });

      const taskId = "it-p3-07-task";
      taskManager.create(taskId, createTestTaskDef({ description: "IT-P3-07 超预算测试", taskType: "feature" }));
      taskManager.updateState(taskId, "in_progress", 0.5, "test");
      taskManager.addFocusPoint(taskId, createFileFocusPoint("src/index.ts"));

      // 调用 buildOptimizedContext 不应抛错
      const snippets = await dualLayer.buildOptimizedContext("default", taskId);

      // 断言：返回值非空（即使超预算，directRetain 片段仍返回）
      assert.ok(snippets.length > 0, "超预算路径应仍返回非空片段（directRetain 片段）");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
    cleanupTmpDir(tmpMemoryDir);
  }
});

// ============================================================
// IT-P3-08: accessCount 不膨胀（连续调用 buildOptimizedContext N 次，推荐经验 accessCount 增量=0，P0-2 修复核心断言）
// ============================================================

test("IT-P3-08: accessCount 不膨胀（连续调用 buildOptimizedContext 5 次，推荐经验 accessCount 增量=0，P0-2 修复）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  try {
    writeFile(projectRoot, "src/index.ts", `export function main(): void { console.log("hello"); }\n`);
    const globalContextPath = path.join(tmpGlobalDir, "global-context.json");
    const { codeMapProvider, globalManager, taskManager } = createV2P3Fixture(projectRoot, globalContextPath);

    // 添加 2 条经验
    const exp1 = makeSuccessExp({
      taskType: "feature",
      description: "实现用户认证",
      solution: "JWT",
      importance: 8,
    });
    const exp2 = makeSuccessExp({
      taskType: "feature",
      description: "实现数据导出",
      solution: "CSV",
      importance: 6,
    });
    globalManager.addSuccessExperience("default", exp1);
    globalManager.addSuccessExperience("default", exp2);

    // 记录初始 accessCount
    const ctxBefore = globalManager.load("default");
    const exp1Before = ctxBefore.historicalExperience.successExperiences.find((e) => e.id === exp1.id);
    const exp2Before = ctxBefore.historicalExperience.successExperiences.find((e) => e.id === exp2.id);
    const exp1CountBefore = exp1Before?.accessCount ?? 0;
    const exp2CountBefore = exp2Before?.accessCount ?? 0;

    const embedder = new TFIDFEmbedder({ max_features: 5000, norm: "l2" });
    const experienceRecommender = new ExperienceRecommender(globalManager, embedder);
    const { dualLayer } = createV2P3Components(projectRoot, globalManager, taskManager, codeMapProvider, {
      experienceRecommender,
    });

    const taskId = "it-p3-08-task";
    taskManager.create(
      taskId,
      createTestTaskDef({ description: "IT-P3-08 accessCount 不膨胀测试", taskType: "feature" })
    );
    taskManager.updateState(taskId, "in_progress", 0.5, "test");

    // 连续调用 buildOptimizedContext 5 次
    for (let i = 0; i < 5; i++) {
      await dualLayer.buildOptimizedContext("default", taskId);
    }

    // 验证：accessCount 增量应为 0（P0-2 修复：buildOptimizedContext 传 recordAccess: false）
    const ctxAfter = globalManager.load("default");
    const exp1After = ctxAfter.historicalExperience.successExperiences.find((e) => e.id === exp1.id);
    const exp2After = ctxAfter.historicalExperience.successExperiences.find((e) => e.id === exp2.id);

    assert.ok(exp1After, `经验 ${exp1.id} 应存在`);
    assert.ok(exp2After, `经验 ${exp2.id} 应存在`);

    assert.equal(
      exp1After.accessCount - exp1CountBefore,
      0,
      `连续 5 次调用后 exp1 accessCount 增量应为 0（P0-2 修复），实际增量：${exp1After.accessCount - exp1CountBefore}`
    );
    assert.equal(
      exp2After.accessCount - exp2CountBefore,
      0,
      `连续 5 次调用后 exp2 accessCount 增量应为 0（P0-2 修复），实际增量：${exp2After.accessCount - exp2CountBefore}`
    );
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});

// ============================================================
// IT-P3-09: 经验去重（同一条经验同时满足"最近"和"RAG 推荐"，仅出现一次，P1-2 修复）
// ============================================================

test("IT-P3-09: 经验去重（同一条经验同时满足最近和 RAG 推荐，仅出现一次，P1-2 修复）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  try {
    writeFile(projectRoot, "src/index.ts", `export function main(): void { console.log("hello"); }\n`);
    const globalContextPath = path.join(tmpGlobalDir, "global-context.json");
    const { codeMapProvider, globalManager, taskManager } = createV2P3Fixture(projectRoot, globalContextPath);

    // 添加 2 条经验（taskType=feature，与任务匹配，会同时被 RAG 推荐和兜底最近召回）
    const exp1 = makeSuccessExp({
      taskType: "feature",
      description: "实现用户认证",
      solution: "JWT",
      importance: 8,
      createdAt: "2026-07-15T00:00:00.000Z", // 较新
    });
    const exp2 = makeSuccessExp({
      taskType: "feature",
      description: "实现数据导出",
      solution: "CSV",
      importance: 6,
      createdAt: "2026-07-10T00:00:00.000Z", // 较旧
    });
    globalManager.addSuccessExperience("default", exp1);
    globalManager.addSuccessExperience("default", exp2);

    const embedder = new TFIDFEmbedder({ max_features: 5000, norm: "l2" });
    const experienceRecommender = new ExperienceRecommender(globalManager, embedder);
    const { dualLayer } = createV2P3Components(projectRoot, globalManager, taskManager, codeMapProvider, {
      experienceRecommender,
    });

    const taskId = "it-p3-09-task";
    taskManager.create(taskId, createTestTaskDef({ description: "IT-P3-09 经验去重测试", taskType: "feature" }));
    taskManager.updateState(taskId, "in_progress", 0.5, "test");

    const snippets = await dualLayer.buildOptimizedContext("default", taskId);

    // 收集所有经验片段（recommendation + success + failure）的 source 中的经验 id
    const experienceSnippets = snippets.filter(
      (s) =>
        s.type === "experience_recommendation" || s.type === "experience_success" || s.type === "experience_failure"
    );
    const experienceIds = experienceSnippets.map((s) => s.source.split(":").pop() as string);

    // 断言：每个经验 id 仅出现一次（无重复）
    const uniqueIds = new Set(experienceIds);
    assert.equal(
      experienceIds.length,
      uniqueIds.size,
      `经验 id 应无重复（P1-2 修复），实际：${experienceIds.length} 个片段 vs ${uniqueIds.size} 个唯一 id`
    );

    // 断言：exp1 和 exp2 都被注入（一条作为 recommendation，一条作为 success 兜底）
    assert.ok(uniqueIds.has(exp1.id), `exp1 (${exp1.id}) 应被注入`);
    assert.ok(uniqueIds.has(exp2.id), `exp2 (${exp2.id}) 应被注入`);
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});

// ============================================================
// IT-P3-10: collectXxx 异常降级（推荐器抛异常时其他片段正常返回）
// ============================================================

test("IT-P3-10: collectXxx 异常降级（experienceRecommender.recommend 抛异常时其他片段正常返回）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  try {
    writeFile(projectRoot, "src/index.ts", `export function main(): void { console.log("hello"); }\n`);
    const globalContextPath = path.join(tmpGlobalDir, "global-context.json");
    const { codeMapProvider, globalManager, taskManager } = createV2P3Fixture(projectRoot, globalContextPath);

    // 创建一个会抛异常的 ExperienceRecommender 子类
    class FailingRecommender extends ExperienceRecommender {
      recommend(): never {
        throw new Error("模拟 recommend 异常");
      }
    }
    const embedder = new TFIDFEmbedder({ max_features: 5000, norm: "l2" });
    const failingRecommender = new FailingRecommender(globalManager, embedder);

    const { dualLayer } = createV2P3Components(projectRoot, globalManager, taskManager, codeMapProvider, {
      experienceRecommender: failingRecommender,
    });

    const taskId = "it-p3-10-task";
    taskManager.create(taskId, createTestTaskDef({ description: "IT-P3-10 异常降级测试", taskType: "feature" }));
    taskManager.updateState(taskId, "in_progress", 0.5, "test");

    // 调用 buildOptimizedContext 不应抛错（异常被 try-catch 降级）
    const snippets = await dualLayer.buildOptimizedContext("default", taskId);

    // 断言：返回值非空（其他片段正常返回）
    assert.ok(snippets.length > 0, "异常降级路径应返回非空片段（其他片段正常收集）");

    // 断言：返回值不含 experience_recommendation（异常降级）
    const types = new Set(snippets.map((s) => s.type));
    assert.ok(!types.has("experience_recommendation"), "异常降级不应含 experience_recommendation");

    // 断言：返回值仍含 user_profile 和 task_definition
    assert.ok(types.has("user_profile"), `应仍含 user_profile，实际类型：${[...types].join(", ")}`);
    assert.ok(types.has("task_definition"), `应仍含 task_definition，实际类型：${[...types].join(", ")}`);
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});

// ============================================================
// IT-P3-11: ConceptEntry 无 confidence 适配（domainKnowledge 持久化后 collectDomainKnowledgeSnippets 正常工作，P0-1 修复）
// ============================================================

test("IT-P3-11: ConceptEntry 无 confidence 适配（persistToGlobalContext 后 collectDomainKnowledgeSnippets 不依赖 confidence，P0-1 修复）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  try {
    // 准备项目：含多个 @Entity 类（生成多个 ConceptEntry）
    writeFile(
      projectRoot,
      "src/user.ts",
      `import { Entity } from "typeorm";\n@Entity()\nexport class User { id: number; name: string; }\n`
    );
    writeFile(
      projectRoot,
      "src/order.ts",
      `import { Entity } from "typeorm";\n@Entity()\nexport class Order { id: number; userId: number; }\n`
    );

    const globalContextPath = path.join(tmpGlobalDir, "global-context.json");
    const { generator, codeMapProvider, globalManager, taskManager } = createV2P3Fixture(
      projectRoot,
      globalContextPath
    );

    // 持久化领域知识
    const modeler = new DomainModeler(generator, globalManager);
    const model = await modeler.model(projectRoot);
    await modeler.persistToGlobalContext("default", model);

    // 验证：ConceptEntry 含 confidence 字段（V2-P3 多角色审查 L-4 修复后保留推断置信度）
    const ctx = globalManager.load("default");
    const concepts = ctx.domainKnowledge.conceptLibrary;
    assert.ok(concepts.length > 0, "应含至少 1 个 ConceptEntry");
    const sample = concepts[0];
    assert.ok(
      "confidence" in sample,
      `ConceptEntry 应含 confidence 字段（L-4 修复后保留推断置信度），实际字段：${Object.keys(sample).join(", ")}`
    );
    assert.ok(
      typeof sample.confidence === "number" && sample.confidence > 0,
      `confidence 应为正数（@Entity 装饰器 confidence ≥ 0.85），实际：${sample.confidence}`
    );

    // 构造 V2-P3 集成组件
    const { dualLayer } = createV2P3Components(projectRoot, globalManager, taskManager, codeMapProvider);

    const taskId = "it-p3-11-task";
    taskManager.create(taskId, createTestTaskDef({ description: "IT-P3-11 ConceptEntry 无 confidence 适配测试" }));
    taskManager.updateState(taskId, "in_progress", 0.5, "test");

    // 调用 buildOptimizedContext 不应抛错（P0-1 修复：不依赖 confidence 字段）
    const snippets = await dualLayer.buildOptimizedContext("default", taskId);

    // 断言：返回值含 domain_concept 片段（即使 ConceptEntry 无 confidence 字段）
    const conceptSnippets = snippets.filter((s) => s.type === "domain_concept");
    assert.ok(
      conceptSnippets.length >= 1,
      `应含至少 1 个 domain_concept 片段（P0-1 修复后不依赖 confidence），实际类型：${snippets.map((s) => s.type).join(", ")}`
    );

    // 断言：片段 content 含概念名（User 或 Order）
    const contents = conceptSnippets.map((s) => s.content).join("\n");
    assert.ok(
      contents.includes("User") || contents.includes("Order"),
      `片段 content 应含 "User" 或 "Order"，实际：${contents}`
    );
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});

// ============================================================
// IT-P3-12: ConceptEntry.confidence 字段持久化与排序（V2-P3 多角色审查 L-4 修复端到端）
// ============================================================

test("IT-P3-12: ConceptEntry.confidence 字段持久化与排序（L-4 修复端到端，优先 confidence 降序回退 relatedConcepts.length）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  try {
    const globalContextPath = path.join(tmpGlobalDir, "global-context.json");
    const { generator, codeMapProvider, globalManager, taskManager } = createV2P3Fixture(
      projectRoot,
      globalContextPath
    );

    // 构造 DomainModel 含 3 个不同 confidence 的概念：
    // - low-conf-concept: confidence 0.6, relatedConcepts 5 个（仅后缀匹配，低置信度但关联多）
    // - mid-conf-concept: confidence 0.75, relatedConcepts 2 个（仅后缀匹配，中置信度）
    // - high-conf-concept: confidence 0.9, relatedConcepts 1 个（@Entity+后缀双重匹配，高置信度）
    // 期望排序：high-conf(0.9) > mid-conf(0.75) > low-conf(0.6)
    // 注：若按 relatedConcepts.length 排序会是 low-conf(5) > mid-conf(2) > high-conf(1)，与 confidence 排序相反
    const model: DomainModel = {
      concepts: [
        {
          id: "low-conf-concept",
          name: "LowConf",
          type: "value_object",
          source: "src/low.ts",
          description: "低置信度概念",
          properties: [],
          confidence: 0.6,
        },
        {
          id: "mid-conf-concept",
          name: "MidConf",
          type: "entity",
          source: "src/mid.ts",
          description: "中置信度概念",
          properties: [],
          confidence: 0.75,
        },
        {
          id: "high-conf-concept",
          name: "HighConf",
          type: "entity",
          source: "src/high.ts",
          description: "高置信度概念",
          properties: [],
          confidence: 0.9,
        },
      ],
      relations: [
        // low-conf 关联 5 个（通过 relations 体现，persistToGlobalContext 会填充 relatedConcepts）
        { source: "low-conf-concept", target: "rel-1", type: "references", confidence: 0.7 },
        { source: "low-conf-concept", target: "rel-2", type: "references", confidence: 0.7 },
        { source: "low-conf-concept", target: "rel-3", type: "references", confidence: 0.7 },
        { source: "low-conf-concept", target: "rel-4", type: "references", confidence: 0.7 },
        { source: "low-conf-concept", target: "rel-5", type: "references", confidence: 0.7 },
        // mid-conf 关联 2 个
        { source: "mid-conf-concept", target: "rel-1", type: "references", confidence: 0.8 },
        { source: "mid-conf-concept", target: "rel-2", type: "references", confidence: 0.8 },
        // high-conf 关联 1 个
        { source: "high-conf-concept", target: "rel-1", type: "references", confidence: 0.9 },
      ],
      rules: [],
      knowledgeGraph: { nodes: [], edges: [] },
    };

    const modeler = new DomainModeler(generator, globalManager);
    await modeler.persistToGlobalContext("default", model);

    // 验证 1：ConceptEntry 保留了 confidence 字段（L-4 修复核心断言）
    const ctx = globalManager.load("default");
    const library = ctx.domainKnowledge.conceptLibrary;
    assert.equal(library.length, 3, "应持久化 3 个 concept");

    const lowConf = library.find((c) => c.id === "low-conf-concept");
    const midConf = library.find((c) => c.id === "mid-conf-concept");
    const highConf = library.find((c) => c.id === "high-conf-concept");
    assert.ok(lowConf && midConf && highConf, "三个概念均应持久化");
    assert.equal(lowConf!.confidence, 0.6, "low-conf confidence 应为 0.6");
    assert.equal(midConf!.confidence, 0.75, "mid-conf confidence 应为 0.75");
    assert.equal(highConf!.confidence, 0.9, "high-conf confidence 应为 0.9");

    // 验证 2：relatedConcepts 已被 persistToGlobalContext 填充
    assert.equal(lowConf!.relatedConcepts.length, 5, "low-conf 应有 5 个 relatedConcepts");
    assert.equal(midConf!.relatedConcepts.length, 2, "mid-conf 应有 2 个 relatedConcepts");
    assert.equal(highConf!.relatedConcepts.length, 1, "high-conf 应有 1 个 relatedConcepts");

    // 构造 V2-P3 集成组件（不注入 userGlobalMemory/experienceRecommender，仅测 domain 排序）
    const { dualLayer } = createV2P3Components(projectRoot, globalManager, taskManager, codeMapProvider);

    const taskId = "it-p3-12-task";
    taskManager.create(taskId, createTestTaskDef({ description: "IT-P3-12 confidence 排序测试" }));
    taskManager.updateState(taskId, "in_progress", 0.5, "test");

    // 调用 buildOptimizedContext
    const snippets = await dualLayer.buildOptimizedContext("default", taskId);

    // 验证 3：返回值含 domain_concept 片段，且按 confidence 降序排列
    const conceptSnippets = snippets.filter((s) => s.type === "domain_concept");
    assert.ok(conceptSnippets.length >= 1, "应含至少 1 个 domain_concept 片段");

    // 提取片段中的概念名顺序（content 格式：[业务概念] <name>: <desc>）
    // 正则用 [^:\s]+ 匹配 ":" 前的非空白字符，避免 \S+ 把 ":" 也匹配进来
    const conceptNames = conceptSnippets.map((s) => {
      const match = s.content.match(/\[业务概念\]\s+([^:\s]+)/);
      return match ? match[1] : "";
    });

    // 期望顺序：HighConf(0.9) → MidConf(0.75) → LowConf(0.6)
    // 若按 relatedConcepts.length 排序会是相反：LowConf(5) → MidConf(2) → HighConf(1)
    const highIdx = conceptNames.indexOf("HighConf");
    const midIdx = conceptNames.indexOf("MidConf");
    const lowIdx = conceptNames.indexOf("LowConf");

    assert.ok(highIdx >= 0 && midIdx >= 0 && lowIdx >= 0, "三个概念均应出现在片段中");

    // 核心断言：high 在 mid 之前，mid 在 low 之前（按 confidence 降序）
    assert.ok(
      highIdx < midIdx,
      `HighConf(0.9) 应在 MidConf(0.75) 之前（按 confidence 降序），实际顺序：${conceptNames.join(" → ")}`
    );
    assert.ok(
      midIdx < lowIdx,
      `MidConf(0.75) 应在 LowConf(0.6) 之前（按 confidence 降序），实际顺序：${conceptNames.join(" → ")}`
    );

    // 验证 4：向后兼容 — 旧 ConceptEntry 无 confidence 时按 relatedConcepts.length 回退排序
    globalManager.update("default", (ctx2) => {
      // 添加 2 个无 confidence 的旧概念（模拟 V2-P3 之前的持久化数据）
      ctx2.domainKnowledge.conceptLibrary.push(
        {
          id: "legacy-few-related",
          name: "LegacyFewRelated",
          description: "旧数据无 confidence，关联少",
          relatedConcepts: ["a"],
          // 无 confidence 字段
        },
        {
          id: "legacy-many-related",
          name: "LegacyManyRelated",
          description: "旧数据无 confidence，关联多",
          relatedConcepts: ["a", "b", "c", "d", "e"],
          // 无 confidence 字段
        }
      );
      return ctx2; // update 回调必须返回 ctx
    });

    const snippets2 = await dualLayer.buildOptimizedContext("default", taskId);
    const conceptSnippets2 = snippets2.filter((s) => s.type === "domain_concept");
    const conceptNames2 = conceptSnippets2.map((s) => {
      const match = s.content.match(/\[业务概念\]\s+([^:\s]+)/);
      return match ? match[1] : "";
    });

    // 期望：有 confidence 的概念在前（按 confidence 降序），无 confidence 的概念在后（按 relatedConcepts.length 降序）
    // 即：HighConf → MidConf → LowConf → LegacyManyRelated(5) → LegacyFewRelated(1)
    const legacyManyIdx = conceptNames2.indexOf("LegacyManyRelated");
    const legacyFewIdx = conceptNames2.indexOf("LegacyFewRelated");
    assert.ok(legacyManyIdx >= 0 && legacyFewIdx >= 0, "两个旧概念均应出现");

    // 旧概念之间按 relatedConcepts.length 降序
    assert.ok(
      legacyManyIdx < legacyFewIdx,
      `LegacyManyRelated(5 关联) 应在 LegacyFewRelated(1 关联) 之前（无 confidence 时回退 relatedConcepts.length 降序），实际顺序：${conceptNames2.join(" → ")}`
    );

    // 有 confidence 的概念应在无 confidence 的概念之前（confidence ?? 0 = 0 < 0.6）
    const lastConfIdx = Math.max(
      conceptNames2.indexOf("HighConf"),
      conceptNames2.indexOf("MidConf"),
      conceptNames2.indexOf("LowConf")
    );
    assert.ok(
      lastConfIdx < legacyManyIdx,
      `有 confidence 的概念应均在无 confidence 的概念之前，实际顺序：${conceptNames2.join(" → ")}`
    );
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});
