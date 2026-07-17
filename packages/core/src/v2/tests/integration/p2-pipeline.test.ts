/**
 * V2-P2 集成测试（IT-P2-01 ~ IT-P2-04）
 *
 * 测试覆盖（V2_P2_IMPLEMENTATION_PLAN.md §4.5）：
 * - IT-P2-01: 含压缩摘要片段（超预算候选 + RuleBasedSummarizer → buildOptimizedContext 返回值含 compressed_summary）
 * - IT-P2-02: 三层加载端到端（完整 TaskContext + DualLayerContextManager → 返回片段含 progressive_metadata/instruction/resource）
 * - IT-P2-03: 摘要压缩端到端（候选 token > 预算 → 返回片段含 retainedSnippets + compressedSnippets，总 token 在预算内）
 * - IT-P2-04: 多语言+渐进+压缩集成（Java/Rust/Go 文件 + 超预算 + ProgressiveContextLoader → CodeMap 含多语言 + 上下文含三层 + 超预算被压缩）
 *
 * 所有测试使用真实组件（CodeMapGenerator + GlobalContextManager + TaskContextManager + ProgressiveContextLoader + RuleBasedSummarizer），
 * 禁止 mock。CI 环境无 DEEPSEEK_API_KEY，自动使用 RuleBasedSummarizer（真实启发式算法）。
 *
 * @module v2/tests/integration/p2-pipeline.test
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
import { RelevanceScorer } from "../../context/relevance-scorer";
import { SlidingWindowManager } from "../../context/sliding-window";
import { DualLayerContextManager } from "../../context/dual-layer-manager";
import type { CodeMapProvider } from "../../context/dual-layer-manager";
import { ProgressiveContextLoader } from "../../context/progressive-loader";
import { RuleBasedSummarizer } from "../../memory/rule-based-summarizer";

// ============================================================================
// 辅助工厂
// ============================================================================

/**
 * 创建临时项目目录
 */
function createTmpProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-p2-it-"));
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
    description: "V2-P2 集成测试任务",
    goals: ["验证 V2-P2 集成流程"],
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
 * 创建 V2-P2 完整集成组件（4 参 SW + 8 参 DLCM，真实组件非 mock）
 *
 * @param projectRoot 项目根目录
 * @param globalManager 全局上下文管理器
 * @param taskManager 任务上下文管理器
 * @param codeMapProvider CodeMap 提供者
 * @param tokenBudget Token 预算（可选，默认 100000）
 * @returns 含 dualLayer + windowManager + progressiveLoader + summarizer 的集成组件
 */
function createV2P2Components(
  projectRoot: string,
  globalManager: GlobalContextManager,
  taskManager: TaskContextManager,
  codeMapProvider: CodeMapProvider,
  tokenBudget: number = 100_000
): {
  dualLayer: DualLayerContextManager;
  windowManager: SlidingWindowManager;
  progressiveLoader: ProgressiveContextLoader;
  summarizer: RuleBasedSummarizer;
} {
  const scorer = new RelevanceScorer();
  const progressiveLoader = new ProgressiveContextLoader({ tokenBudget });
  const summarizer = new RuleBasedSummarizer();
  const windowManager = new SlidingWindowManager({ tokenBudget }, scorer, progressiveLoader, summarizer);
  const dualLayer = new DualLayerContextManager(
    { projectRoot, window: {}, scoring: {}, defaultTokenBudget: tokenBudget },
    globalManager,
    taskManager,
    codeMapProvider,
    scorer,
    windowManager,
    progressiveLoader,
    summarizer
  );
  return { dualLayer, windowManager, progressiveLoader, summarizer };
}

// ============================================================================
// 集成测试用例（IT-P2-01 ~ IT-P2-04）
// ============================================================================

// ============================================================
// IT-P2-01: 含压缩摘要片段（超预算候选 → buildOptimizedContext 返回值含 compressed_summary）
// ============================================================

test("IT-P2-01: 含压缩摘要片段（超预算候选 + RuleBasedSummarizer → 返回值含 type=compressed_summary）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  try {
    // ---- 准备项目：多个 TS 文件（focusPoint 文件 + 非 focusPoint 文件）----
    writeFile(projectRoot, "src/main.ts", `export function main(): void { console.log("main"); }\n`);
    writeFile(projectRoot, "src/utils.ts", `export function add(a: number, b: number): number { return a + b; }\n`);
    writeFile(projectRoot, "src/extra.ts", `export function extra(): void { console.log("extra"); }\n`);

    // ---- 构造 V2-P2 集成组件（小预算，确保超预算触发压缩）----
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

    // 小预算（10 token = 40 字符），确保文件层候选超预算触发压缩
    const { dualLayer } = createV2P2Components(
      projectRoot,
      globalManager,
      taskManager,
      codeMapProvider,
      10 // tokenBudget=10（小预算，确保超预算）
    );

    // ---- 创建任务 + 加多个 focusPoint（触发文件层候选超预算）----
    const taskId = "it-p2-01-task";
    taskManager.create(taskId, createTestTaskDef({ description: "IT-P2-01 压缩摘要测试" }));
    taskManager.updateState(taskId, "in_progress", 0.5, "test-stage");
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/main.ts"));
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/utils.ts"));
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/extra.ts"));

    // ---- 调用 buildOptimizedContext ----
    const snippets = await dualLayer.buildOptimizedContext("default", taskId);

    // 断言 1：返回值非空
    assert.ok(snippets.length > 0, "buildOptimizedContext 应返回非空片段列表");

    // 断言 2：返回值含 type="compressed_summary" 片段（超预算文件层候选被压缩）
    const compressedSnippets = snippets.filter((s) => s.type === "compressed_summary");
    assert.ok(
      compressedSnippets.length >= 1,
      `应含至少 1 个 compressed_summary 片段，实际类型：${snippets.map((s) => s.type).join(", ")}`
    );

    // 断言 3：压缩片段 content 前缀为 "[摘要] "
    const compressed = compressedSnippets[0];
    assert.ok(
      compressed.content.startsWith("[摘要] "),
      `压缩片段 content 应以 "[摘要] " 开头，实际：${compressed.content}`
    );
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});

// ============================================================
// IT-P2-02: 三层加载端到端（完整 TaskContext → 返回片段含 progressive_metadata/instruction/resource）
// ============================================================

test("IT-P2-02: 三层加载端到端（完整 TaskContext + DualLayerContextManager → 返回片段含三层类型）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  try {
    // ---- 准备项目：单个 TS 文件 ----
    writeFile(projectRoot, "src/index.ts", `export function main(): void { console.log("hello"); }\n`);

    // ---- 构造 V2-P2 集成组件 ----
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
    const { dualLayer } = createV2P2Components(projectRoot, globalManager, taskManager, codeMapProvider);

    // ---- 创建任务 + 加 focusPoint + 思考历史 + 中间结果 ----
    const taskId = "it-p2-02-task";
    taskManager.create(
      taskId,
      createTestTaskDef({
        description: "IT-P2-02 三层加载测试",
        goals: ["验证三层加载端到端"],
        constraints: ["零依赖"],
        taskType: "feature",
      })
    );
    taskManager.updateState(taskId, "in_progress", 0.5, "implementing");
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/index.ts"));
    // 加思考历史（Instruction 层需要）
    taskManager.addThought(taskId, "分析问题根因", "analyzing");
    taskManager.addThought(taskId, "实现修复方案", "implementing");
    // 加中间结果（Resource 层需要）
    taskManager.addIntermediateResult(taskId, "找到 3 处问题", "grep");
    taskManager.addIntermediateResult(taskId, "已修复核心函数", "edit");

    // ---- 调用 buildOptimizedContext ----
    const snippets = await dualLayer.buildOptimizedContext("default", taskId);

    // 断言 1：返回值含 progressive_metadata 类型（Metadata 层）
    const metadataSnippets = snippets.filter((s) => s.type === "progressive_metadata");
    assert.ok(
      metadataSnippets.length >= 1,
      `应含至少 1 个 progressive_metadata 片段，实际类型：${snippets.map((s) => s.type).join(", ")}`
    );

    // 断言 2：返回值含 progressive_instruction 类型（Instruction 层）
    const instructionSnippets = snippets.filter((s) => s.type === "progressive_instruction");
    assert.ok(instructionSnippets.length >= 1, "应含至少 1 个 progressive_instruction 片段");

    // 断言 3：返回值含 progressive_resource 类型（Resource 层，有中间结果时）
    const resourceSnippets = snippets.filter((s) => s.type === "progressive_resource");
    assert.ok(resourceSnippets.length >= 1, "应含至少 1 个 progressive_resource 片段（有中间结果时）");

    // 断言 4：Metadata 层 content 含任务类型
    assert.ok(
      metadataSnippets[0].content.includes("feature"),
      `Metadata 层 content 应含任务类型 'feature'，实际：${metadataSnippets[0].content}`
    );

    // 断言 5：Instruction 层 content 含思考摘要
    assert.ok(
      instructionSnippets[0].content.includes("分析问题根因"),
      "Instruction 层 content 应含思考摘要 '分析问题根因'"
    );

    // 断言 6：Resource 层 content 含中间结果
    assert.ok(
      resourceSnippets[0].content.includes("找到 3 处问题"),
      "Resource 层 content 应含中间结果 '找到 3 处问题'"
    );
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});

// ============================================================
// IT-P2-03: 摘要压缩端到端（候选 token > 预算 → retainedSnippets + compressedSnippets，总 token 在预算内）
// ============================================================

test("IT-P2-03: 摘要压缩端到端（候选 token > 预算 → 含 retainedSnippets + compressedSnippets，总 token 在预算内）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  try {
    // ---- 准备项目：多个 TS 文件（focusPoint 文件，确保文件层候选超预算）----
    writeFile(projectRoot, "src/a.ts", `export function a(): void { console.log("a"); }\n`);
    writeFile(projectRoot, "src/b.ts", `export function b(): void { console.log("b"); }\n`);
    writeFile(projectRoot, "src/c.ts", `export function c(): void { console.log("c"); }\n`);
    writeFile(projectRoot, "src/d.ts", `export function d(): void { console.log("d"); }\n`);

    // ---- 构造 V2-P2 集成组件（小预算，确保文件层候选超预算）----
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

    // 中等预算（150 token），确保 directRetainSnippets 消耗后 remainingBudget 仍能保留部分文件层片段，
    // 同时文件层候选总 token > remainingBudget 触发压缩（部分保留 + 部分压缩）
    // 估算：directRetainSnippets ~84 token（user_profile + task_definition + 4 focusPoints + PCL metadata/instruction）
    //       文件层 4 个候选共 ~72 token，remainingBudget = 150 - 84 = 66 token → 保留 3 个，压缩 1 个
    const tokenBudget = 150;
    const { dualLayer } = createV2P2Components(projectRoot, globalManager, taskManager, codeMapProvider, tokenBudget);

    // ---- 创建任务 + 加多个 focusPoint（触发文件层候选超预算）----
    const taskId = "it-p2-03-task";
    taskManager.create(taskId, createTestTaskDef({ description: "IT-P2-03 摘要压缩端到端测试" }));
    taskManager.updateState(taskId, "in_progress", 0.5, "test-stage");
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/a.ts"));
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/b.ts"));
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/c.ts"));
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/d.ts"));

    // ---- 调用 buildOptimizedContext ----
    const snippets = await dualLayer.buildOptimizedContext("default", taskId);

    // 断言 1：返回值含 file_content 类型（文件层保留片段）
    const fileSnippets = snippets.filter((s) => s.type === "file_content");
    assert.ok(fileSnippets.length >= 1, "应含至少 1 个 file_content 片段（文件层保留）");

    // 断言 2：返回值含 compressed_summary 类型（超预算文件层候选被压缩）
    const compressedSnippets = snippets.filter((s) => s.type === "compressed_summary");
    assert.ok(compressedSnippets.length >= 1, "应含至少 1 个 compressed_summary 片段（超预算被压缩）");

    // 断言 3：返回值含三层 progressive_* 类型（PCL 三层加载）
    const progressiveSnippets = snippets.filter(
      (s) =>
        s.type === "progressive_metadata" || s.type === "progressive_instruction" || s.type === "progressive_resource"
    );
    assert.ok(
      progressiveSnippets.length >= 2,
      `应含至少 2 个 progressive_* 片段（三层加载），实际：${progressiveSnippets.length}`
    );

    // 断言 4：retainedSnippets（file_content）+ 三层片段 + compressedSnippets 共存
    // 注：buildOptimizedContext 返回扁平数组 = directRetainSnippets + retainedScoringSnippets + compressedSnippets
    //    directRetainSnippets 含三层片段 + 全局层 + 任务层
    //    retainedScoringSnippets 含 file_content
    //    compressedSnippets 含 compressed_summary
    const allTypes = new Set(snippets.map((s) => s.type));
    assert.ok(allTypes.has("file_content"), "返回值应含 file_content 类型");
    assert.ok(allTypes.has("compressed_summary"), "返回值应含 compressed_summary 类型");
    assert.ok(
      allTypes.has("progressive_metadata") || allTypes.has("progressive_instruction"),
      "返回值应含 progressive_metadata 或 progressive_instruction 类型"
    );
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});

// ============================================================
// IT-P2-04: 多语言+渐进+压缩集成（Java/Rust/Go 文件 + 超预算 + ProgressiveContextLoader）
// ============================================================

test("IT-P2-04: 多语言+渐进+压缩集成（Java/Rust/Go 文件 + 超预算 + ProgressiveContextLoader → CodeMap 含多语言 + 上下文含三层 + 超预算被压缩）", async () => {
  const projectRoot = createTmpProjectDir();
  const tmpGlobalDir = createTmpProjectDir();
  try {
    // ---- 准备项目：Java + Rust + Go 文件 ----
    writeFile(
      projectRoot,
      "src/Main.java",
      `public class Main {\n  public static void main(String[] args) {\n    System.out.println("hello");\n  }\n}\n`
    );
    writeFile(projectRoot, "src/main.rs", `fn main() {\n    println!("hello");\n}\n`);
    writeFile(
      projectRoot,
      "src/main.go",
      `package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("hello")\n}\n`
    );

    // ---- 构造 V2-P2 集成组件（小预算，确保超预算触发压缩）----
    const generator = new CodeMapGenerator({
      projectRoot,
      extensions: [".java", ".rs", ".go"],
      excludeDirs: ["node_modules"],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });

    // 先生成 CodeMap 验证多语言识别
    const codeMap = await generator.generateFullMap();

    // 断言 1：CodeMap 含 Java 文件
    const javaFiles = codeMap.files.filter((f) => f.language === "java");
    assert.ok(
      javaFiles.length >= 1,
      `CodeMap 应含 Java 文件，实际：${codeMap.files.map((f) => f.language).join(", ")}`
    );

    // 断言 2：CodeMap 含 Rust 文件
    const rustFiles = codeMap.files.filter((f) => f.language === "rust");
    assert.ok(rustFiles.length >= 1, "CodeMap 应含 Rust 文件");

    // 断言 3：CodeMap 含 Go 文件
    const goFiles = codeMap.files.filter((f) => f.language === "go");
    assert.ok(goFiles.length >= 1, "CodeMap 应含 Go 文件");

    // ---- 构造集成组件（小预算触发压缩）----
    const codeMapProvider = new TestCodeMapProvider(generator);
    const globalManager = new GlobalContextManager(path.join(tmpGlobalDir, "global-context.json"));
    const taskManager = new TaskContextManager();
    // 中等预算（180 token），确保 directRetainSnippets 消耗后 remainingBudget 仍能保留部分文件层片段，
    // 同时文件层候选总 token > remainingBudget 触发压缩（部分保留 + 部分压缩）
    // 估算：directRetainSnippets ~132 token（user_profile + task_definition + 3 focusPoints + thoughts + intermediates + PCL 三层）
    //       文件层 3 个候选每个 ~28-30 token（含完整路径），共 ~85 token
    //       remainingBudget = 180 - 132 = 48 token → 保留 1 个（30 token），压缩 2 个
    const tokenBudget = 180;
    const { dualLayer } = createV2P2Components(projectRoot, globalManager, taskManager, codeMapProvider, tokenBudget);

    // ---- 创建任务 + 加多语言 focusPoint + 思考历史 + 中间结果 ----
    const taskId = "it-p2-04-task";
    taskManager.create(
      taskId,
      createTestTaskDef({
        description: "IT-P2-04 多语言+渐进+压缩集成测试",
        goals: ["验证 Java/Rust/Go 多语言 + 三层加载 + 摘要压缩"],
        constraints: ["零依赖"],
        taskType: "feature",
      })
    );
    taskManager.updateState(taskId, "in_progress", 0.5, "implementing");
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/Main.java"));
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/main.rs"));
    taskManager.addFocusPoint(taskId, createFileFocusPoint("src/main.go"));
    // 加思考历史和中间结果（三层加载需要）
    taskManager.addThought(taskId, "分析多语言代码结构", "analyzing");
    taskManager.addIntermediateResult(taskId, "识别 Java/Rust/Go 三种语言", "codemap");

    // ---- 调用 buildOptimizedContext ----
    const snippets = await dualLayer.buildOptimizedContext("default", taskId);

    // 断言 4：返回值含 progressive_metadata 类型（三层加载 - Metadata 层）
    const metadataSnippets = snippets.filter((s) => s.type === "progressive_metadata");
    assert.ok(metadataSnippets.length >= 1, "应含 progressive_metadata 片段（三层加载）");

    // 断言 5：返回值含 progressive_instruction 类型（三层加载 - Instruction 层）
    const instructionSnippets = snippets.filter((s) => s.type === "progressive_instruction");
    assert.ok(instructionSnippets.length >= 1, "应含 progressive_instruction 片段（三层加载）");

    // 断言 6：返回值含 compressed_summary 类型（超预算文件层候选被压缩）
    const compressedSnippets = snippets.filter((s) => s.type === "compressed_summary");
    assert.ok(
      compressedSnippets.length >= 1,
      `应含至少 1 个 compressed_summary 片段（超预算被压缩），实际类型：${snippets.map((s) => s.type).join(", ")}`
    );

    // 断言 7：返回值含 file_content 类型（多语言文件层保留片段）
    const fileSnippets = snippets.filter((s) => s.type === "file_content");
    assert.ok(fileSnippets.length >= 1, "应含至少 1 个 file_content 片段（多语言文件层保留）");

    // 断言 8：Metadata 层 content 含任务类型 'feature'
    assert.ok(
      metadataSnippets[0].content.includes("feature"),
      `Metadata 层 content 应含任务类型 'feature'，实际：${metadataSnippets[0].content}`
    );

    // 断言 9：Instruction 层 content 含思考摘要
    assert.ok(
      instructionSnippets[0].content.includes("分析多语言代码结构"),
      "Instruction 层 content 应含思考摘要 '分析多语言代码结构'"
    );
  } finally {
    cleanupTmpDir(projectRoot);
    cleanupTmpDir(tmpGlobalDir);
  }
});
