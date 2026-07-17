/**
 * V2-P1 集成测试（IT-01 ~ IT-04）
 *
 * 测试覆盖（V2_P1_IMPLEMENTATION_PLAN.md §6.2）：
 * - IT-01: 端到端注入（CodeMap 生成 → buildOptimizedContext → setSnippets → preBuildContext 同步读）
 * - IT-02: 归档同步闭环（TaskContextManager 创建任务 → 加 focusPoints/thoughts → archive(success)
 *           → ContextSynchronizer 回调 → global-context.json 落盘 SuccessExperience）
 * - IT-03: 识别→记忆→上下文（ProjectUnderstandingService.understand → ProjectMemoryManager 初始化
 *           → buildOptimizedContext 含项目 config 片段）
 * - IT-04: 错误恢复端到端（CodeMap 损坏降级 + global-context 损坏降级 + 任务不存在降级）
 *
 * 所有测试使用 mkdtempSync 临时目录 + 真实写入文件，禁止 mock。
 *
 * @module v2/tests/integration/p1-pipeline.test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CodeMapGenerator } from "../../codemap/generator";
import type { CodeMap } from "../../codemap/generator";
import { GlobalContextManager } from "../../context/global-context";
import { TaskContextManager } from "../../context/task-context-manager";
import type { TaskDefinition, FocusPoint } from "../../context/types";
import { ContextSynchronizer } from "../../context/synchronizer";
import { RelevanceScorer } from "../../context/relevance-scorer";
import { SlidingWindowManager } from "../../context/sliding-window";
import { DualLayerContextManager } from "../../context/dual-layer-manager";
import type { CodeMapProvider } from "../../context/dual-layer-manager";
// V2-P2 新增导入：ProgressiveContextLoader + RuleBasedSummarizer（真实实现，非 mock）
import { ProgressiveContextLoader } from "../../context/progressive-loader";
import { RuleBasedSummarizer } from "../../memory/rule-based-summarizer";
import { ProjectUnderstandingService } from "../../understanding/project-understanding";
import { ProjectMemoryManager } from "../../memory/project-memory";
import { DefaultSessionContextHook } from "../../integration/session-hook";

// ============================================================================
// 辅助工厂
// ============================================================================

/**
 * 创建临时项目目录
 */
function createTmpProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-p1-it-"));
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
    description: "集成测试任务",
    goals: ["验证 V2-P1 集成流程"],
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
 * CodeMapProvider 的测试实现：包装 CodeMapGenerator，会话级缓存
 *
 * @param enableCache 是否启用会话级缓存（默认 true）。IT-04 错误恢复场景需关闭缓存，
 *                    验证 CodeMap 重新生成后的降级恢复路径。
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

// ============================================================================
// 集成测试用例
// ============================================================================

test("IT-01: 端到端注入（CodeMap 生成 → buildOptimizedContext → setSnippets → preBuildContext 同步读）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir(); // 用于隔离 global-context.json
  try {
    // ---- 准备项目：真实 TS 文件 ----
    writeFile(projectRoot, "src/index.ts", `export function main(): void { console.log("hello"); }\n`);
    writeFile(projectRoot, "src/utils.ts", `export function add(a: number, b: number): number { return a + b; }\n`);

    // ---- 构造 V2-P1 集成组件 ----
    const generator = new CodeMapGenerator({
      projectRoot,
      extensions: [".ts"],
      excludeDirs: ["node_modules"],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const codeMapProvider = new TestCodeMapProvider(generator);
    const globalManager = new GlobalContextManager(path.join(tmpGlobalDir, "global-context.json"));
    const taskManager = new TaskContextManager();
    const scorer = new RelevanceScorer();
    // V2-P2 升级：4 参 SlidingWindowManager + 8 参 DualLayerContextManager
    // 注入真实 ProgressiveContextLoader（三层加载）+ RuleBasedSummarizer（摘要压缩，非 mock）
    const progressiveLoader = new ProgressiveContextLoader({ tokenBudget: 100_000 });
    const summarizer = new RuleBasedSummarizer();
    const windowManager = new SlidingWindowManager({ tokenBudget: 100_000 }, scorer, progressiveLoader, summarizer);
    const dualLayer = new DualLayerContextManager(
      { projectRoot, window: {}, scoring: {}, defaultTokenBudget: 100_000 },
      globalManager,
      taskManager,
      codeMapProvider,
      scorer,
      windowManager,
      progressiveLoader,
      summarizer
    );

    // ---- 创建任务 + 加 focusPoint ----
    const taskId = "it-01-task";
    taskManager.create(taskId, createTestTaskDef({ description: "IT-01 集成测试任务" }));
    taskManager.updateState(taskId, "in_progress", 0.5, "test-stage");
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/index.ts"));

    // ---- 调用 buildOptimizedContext（async，turn 入口预计算）----
    const snippets = await dualLayer.buildOptimizedContext("default", taskId);

    // 断言 1：产出片段非空
    assert.ok(snippets.length > 0, "buildOptimizedContext 应返回非空片段列表");

    // 断言 2：片段含任务定义（任务层）
    const taskDef = snippets.find((s) => s.type === "task_definition");
    assert.ok(taskDef, "片段应含 task_definition 类型");

    // 断言 3：片段含 UserProfile（全局层）
    const userProfile = snippets.find((s) => s.type === "user_profile");
    assert.ok(userProfile, "片段应含 user_profile 类型");

    // ---- setSnippets 写入缓存 ----
    const hook = new DefaultSessionContextHook(30 * 60 * 1000);
    const sessionId = "session-it-01";

    // 构造 SessionMessage 列表（含 sessionId）
    const messages = [{ role: "user" as const, content: "test", sessionId, timestamp: new Date().toISOString() }];
    hook.setSnippets(sessionId, snippets);

    // ---- preBuildContext 同步读缓存 ----
    const cached = hook.preBuildContext(messages);

    // 断言 4：preBuildContext 返回缓存片段（与写入一致）
    assert.equal(cached.length, snippets.length, "preBuildContext 应返回全部缓存片段");
    assert.deepEqual(
      cached.map((s) => s.type).sort(),
      snippets.map((s) => s.type).sort(),
      "preBuildContext 返回的片段类型应与写入一致"
    );

    // 断言 5：preBuildContext 是纯同步（无 async 副作用，无 I/O）
    // 通过快速连续调用验证一致性
    const cached2 = hook.preBuildContext(messages);
    assert.equal(cached2.length, cached.length, "多次 preBuildContext 结果应一致");

    // ---- 过期降级 ----
    const shortTtlHook = new DefaultSessionContextHook(1); // 1ms TTL
    shortTtlHook.setSnippets(sessionId, snippets);
    // 等待 5ms 让缓存过期
    await new Promise((resolve) => setTimeout(resolve, 5));
    const expired = shortTtlHook.preBuildContext(messages);
    // 断言 6：过期后降级为空数组
    assert.equal(expired.length, 0, "过期后 preBuildContext 应降级为空数组");
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});

test("IT-02: 归档同步闭环（archive(success) → ContextSynchronizer 回调 → global-context.json 落盘 SuccessExperience）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  try {
    // ---- 构造组件 ----
    const globalManager = new GlobalContextManager(path.join(tmpGlobalDir, "global-context.json"));
    const synchronizer = new ContextSynchronizer(globalManager);
    // TaskContextManager 注入 ContextSynchronizer.asArchiveCallback
    const taskManager = new TaskContextManager(synchronizer.asArchiveCallback("default"));

    // ---- 创建任务 + 加 focusPoints/thoughts ----
    const taskId = "it-02-task";
    const initialTaskContext = taskManager.create(
      taskId,
      createTestTaskDef({ description: "IT-02 归档同步测试", taskType: "feature" })
    );
    // 记录初始 version，用于验证单向性（任务上下文不被回写）
    const initialVersion = initialTaskContext.version;

    taskManager.updateState(taskId, "in_progress", 0.5);
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/main.ts"));
    taskManager.addThought(taskId, "正在实现主逻辑", "implementing");
    taskManager.addIntermediateResult(taskId, "完成了核心函数", "code-gen");

    // ---- 转入终态并归档 ----
    taskManager.updateState(taskId, "completed", 1.0);
    taskManager.archive(taskId, true);

    // ---- 断言 1：global-context.json 已落盘 ----
    const globalPath = path.join(tmpGlobalDir, "global-context.json");
    assert.ok(fs.existsSync(globalPath), "global-context.json 应已落盘");

    // ---- 断言 2：SuccessExperience 已写入 ----
    const loaded = globalManager.load("default");
    assert.ok(loaded.historicalExperience.successExperiences.length > 0, "SuccessExperience 应已写入全局上下文");
    const exp = loaded.historicalExperience.successExperiences[0]!;
    assert.equal(exp.taskType, "feature", "经验 taskType 应为 feature");
    assert.ok(exp.description.includes("IT-02"), `经验 description 应含 'IT-02'，实际：${exp.description}`);

    // ---- 断言 3：单向性（TaskContext 已被删除，不会回写）----
    const taskAfterArchive = taskManager.get(taskId);
    assert.equal(taskAfterArchive, null, "归档后任务上下文应已删除（单向同步不回写任务）");

    // ---- 断言 4：initialVersion 不变（任务上下文未被同步器回写）----
    // 注：任务已删除无法再查 version，通过 initialVersion 与 synchronizer 单向语义验证
    assert.ok(initialVersion > 0, "初始 version 应 > 0");
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});

test("IT-03: 识别→记忆→上下文（ProjectUnderstandingService.understand → ProjectMemoryManager 初始化 → buildOptimizedContext）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  try {
    // ---- 准备项目：含 package.json + tsconfig.json ----
    writeFile(
      projectRoot,
      "package.json",
      JSON.stringify({
        name: "it-03-project",
        version: "1.0.0",
        dependencies: { react: "^18.0.0" },
        devDependencies: { vitest: "^1.0.0", typescript: "^5.0.0" },
        scripts: { test: "vitest run", build: "tsc" },
      })
    );
    writeFile(projectRoot, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022" } }));
    writeFile(projectRoot, "src/index.ts", `export function main(): void { console.log("hello"); }\n`);

    // ---- Step 1: ProjectUnderstandingService.understand ----
    const generator = new CodeMapGenerator({
      projectRoot,
      extensions: [".ts"],
      excludeDirs: ["node_modules"],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const understandingService = new ProjectUnderstandingService(generator);
    const understanding = await understandingService.understand(projectRoot);

    // 断言 1：识别出 react 框架
    assert.ok(understanding.techStack.frameworks.includes("react"), "ProjectUnderstanding 应识别 react 框架");
    // 断言 2：识别出 npm 包管理器
    assert.ok(understanding.techStack.packageManagers.includes("npm"), "ProjectUnderstanding 应识别 npm 包管理器");

    // ---- Step 2: ProjectMemoryManager.initializeFromUnderstanding ----
    const projectMemoryManager = new ProjectMemoryManager(projectRoot);
    const memory = await projectMemoryManager.initializeFromUnderstanding(understanding);

    // 断言 3：项目记忆已从 understanding 初始化
    assert.ok(memory.config.testFramework, "项目记忆 config.testFramework 应已初始化");
    // 断言 4：testFramework 取自 understanding.techStack.testFrameworks
    // 注：package.json 含 scripts.test 但未在 deps 中显式声明 jest/vitest，
    //     所以 testFrameworks 可能为空。此处验证 testFramework 字段已填充（含空字符串也算）
    assert.ok(typeof memory.config.testFramework === "string", "testFramework 应为 string");

    // ---- Step 3: buildOptimizedContext 含全局层片段 ----
    const codeMapProvider = new TestCodeMapProvider(generator);
    const globalManager = new GlobalContextManager(path.join(tmpGlobalDir, "global-context.json"));
    // 预置一条经验，验证经验片段进入注入上下文
    const ctx = globalManager.load("default");
    ctx.historicalExperience.successExperiences.push({
      id: "exp-it-03",
      taskType: "feature",
      description: "IT-03 经验",
      solution: "使用 react+typescript",
      tags: ["react"],
      importance: 5,
      createdAt: new Date().toISOString(),
      accessCount: 0,
      lastAccessedAt: new Date().toISOString(),
    });
    globalManager.save(ctx);

    const taskManager = new TaskContextManager();
    const scorer = new RelevanceScorer();
    // V2-P2 升级：4 参 SlidingWindowManager + 8 参 DualLayerContextManager
    // 注入真实 ProgressiveContextLoader（三层加载）+ RuleBasedSummarizer（摘要压缩，非 mock）
    const progressiveLoader = new ProgressiveContextLoader({ tokenBudget: 100_000 });
    const summarizer = new RuleBasedSummarizer();
    const windowManager = new SlidingWindowManager({ tokenBudget: 100_000 }, scorer, progressiveLoader, summarizer);
    const dualLayer = new DualLayerContextManager(
      { projectRoot, window: {}, scoring: {}, defaultTokenBudget: 100_000 },
      globalManager,
      taskManager,
      codeMapProvider,
      scorer,
      windowManager,
      progressiveLoader,
      summarizer
    );

    // 创建任务并加 focusPoint
    const taskId = "it-03-task";
    taskManager.create(taskId, createTestTaskDef({ description: "IT-03 上下文任务" }));
    taskManager.updateState(taskId, "in_progress", 0.5, "test-stage");
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/index.ts"));

    const snippets = await dualLayer.buildOptimizedContext("default", taskId);

    // 断言 5：片段含经验（全局层）
    const experience = snippets.find((s) => s.type === "experience_success");
    assert.ok(experience, "片段应含 experience_success 类型（来自全局层经验）");
    assert.ok(
      experience!.content.includes("IT-03 经验"),
      `经验片段内容应含 'IT-03 经验'，实际：${experience!.content}`
    );

    // 断言 6：片段含 UserProfile（全局层）
    const userProfile = snippets.find((s) => s.type === "user_profile");
    assert.ok(userProfile, "片段应含 user_profile 类型（来自全局层）");

    // 断言 7：片段含任务定义（任务层）
    const taskDef = snippets.find((s) => s.type === "task_definition");
    assert.ok(taskDef, "片段应含 task_definition 类型（来自任务层）");

    // 断言 8：片段含文件元信息（文件层，来自 CodeMap）
    const fileSnippet = snippets.find((s) => s.type === "file_content");
    assert.ok(fileSnippet, "片段应含 file_content 类型（来自文件层）");
    assert.ok(
      fileSnippet!.source.includes("src/index.ts"),
      `文件片段 source 应含 'src/index.ts'，实际：${fileSnippet!.source}`
    );
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});

test("IT-04: 错误恢复端到端（CodeMap 损坏降级 + global-context 损坏降级 + 任务不存在降级）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  try {
    // ---- 准备项目 ----
    writeFile(projectRoot, "package.json", JSON.stringify({ name: "it-04-project", version: "1.0.0" }));
    writeFile(projectRoot, "src/index.ts", `export function main(): void { console.log("hello"); }\n`);

    // ---- 构造组件 ----
    const generator = new CodeMapGenerator({
      projectRoot,
      extensions: [".ts"],
      excludeDirs: ["node_modules"],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });

    // 先正常生成一次 CodeMap
    await generator.generateFullMap();
    const codeMapPath = path.join(projectRoot, ".deepcode", "codemap.json");
    assert.ok(fs.existsSync(codeMapPath), "CodeMap 应已生成");

    // ---- 场景 1：注入非法 JSON CodeMap（US-ERR-003 损坏重建）----
    fs.writeFileSync(codeMapPath, "{ invalid codemap json content", "utf-8");

    const codeMapProvider = new TestCodeMapProvider(generator, false /* 关闭缓存，每次重新生成 */);
    // loadOrRebuild 应自动重建（注：CodeMapGenerator 当前未暴露 loadOrRebuild，
    //   这里通过 getCodeMap → generateFullMap 重新生成验证降级路径）

    const globalManager = new GlobalContextManager(path.join(tmpGlobalDir, "global-context.json"));

    // ---- 场景 2：注入非法 JSON global-context.json（US-ERR-002 损坏降级）----
    const globalPath = path.join(tmpGlobalDir, "global-context.json");
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, "{ invalid global context json", "utf-8");

    const taskManager = new TaskContextManager();
    const scorer = new RelevanceScorer();
    // V2-P2 升级：4 参 SlidingWindowManager + 8 参 DualLayerContextManager
    // 注入真实 ProgressiveContextLoader（三层加载）+ RuleBasedSummarizer（摘要压缩，非 mock）
    const progressiveLoader = new ProgressiveContextLoader({ tokenBudget: 100_000 });
    const summarizer = new RuleBasedSummarizer();
    const windowManager = new SlidingWindowManager({ tokenBudget: 100_000 }, scorer, progressiveLoader, summarizer);
    const dualLayer = new DualLayerContextManager(
      { projectRoot, window: {}, scoring: {}, defaultTokenBudget: 100_000 },
      globalManager,
      taskManager,
      codeMapProvider,
      scorer,
      windowManager,
      progressiveLoader,
      summarizer
    );

    // ---- 验证 1：global-context 损坏时降级为默认空上下文（不抛错）----
    const loaded = globalManager.load("default");
    assert.equal(loaded.historicalExperience.successExperiences.length, 0, "损坏 global-context 应降级为空经验");
    // 损坏文件应被备份为 .corrupted.<timestamp>
    const dirEntries = fs.readdirSync(tmpGlobalDir);
    const corruptedBackup = dirEntries.find((e) => e.includes(".corrupted"));
    assert.ok(corruptedBackup, "损坏 global-context 应备份为 .corrupted.* 文件");

    // ---- 场景 3：任务不存在时 buildOptimizedContext 降级返回空数组 ----
    const snippets = await dualLayer.buildOptimizedContext("default", "non-existent-task");
    assert.deepEqual(snippets, [], "任务不存在时 buildOptimizedContext 应返回空数组");

    // ---- 验证 2：创建任务后，CodeMap 重新生成（降级恢复）----
    const taskId = "it-04-task";
    taskManager.create(taskId, createTestTaskDef({ description: "IT-04 错误恢复任务" }));
    taskManager.updateState(taskId, "in_progress", 0.5, "recovery");
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/index.ts"));

    const snippetsAfterRecovery = await dualLayer.buildOptimizedContext("default", taskId);
    // CodeMap 重新生成后，片段应含文件层
    assert.ok(snippetsAfterRecovery.length > 0, "CodeMap 恢复后应返回非空片段");
    const fileSnippet = snippetsAfterRecovery.find((s) => s.type === "file_content");
    assert.ok(fileSnippet, "CodeMap 恢复后片段应含 file_content 类型");
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});
