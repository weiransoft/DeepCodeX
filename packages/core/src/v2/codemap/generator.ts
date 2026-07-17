/**
 * CodeMap 生成器（F-FOCUS-01 主模块）
 *
 * 扫描项目目录，调用 RegexASTAnalyzer 分析每个文件，构建代码地图：
 *   - 文件列表（FileInfo[]）
 *   - 同文件调用关系（CallEdge[]）
 *   - 跨文件依赖关系（DependencyEdge[]，仅同项目内相对路径）
 *   - 循环依赖检测（cycles: string[][]）
 *   - 项目信息（techStack / architecture / languages）
 *   - 统计信息（CodeMapStats）
 *
 * 设计依据：
 * - V2 技术方案 §6.1 CodeMap 生成器（v2.6 补充 cycles/CodeMapStats/FileInfo.parseStatus/dependencies）
 * - 架构师审查报告（2026-07-17）：
 *   R1 接口扩展（cycles + dependencies + CodeMapStats）
 *   R2 依赖路径解析（扩展名补全 + 文件存在性检查 + 裸模块跳过）
 *   R3 循环检测（DFS 三色标记 + 环路径提取 + 去重 + 自环处理）
 *   R4 持久化（原子写入 + .deepcode 目录创建）
 *   R5 测试 API 对齐设计文档（generateFullMap + CodeMapConfig）
 * - 测试方案 §2.5 CM-01~CM-12（CM-05/06/07 Java/Rust/Go 延后至 V2-P2）
 *
 * @module v2/codemap/generator
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  RegexASTAnalyzer,
  detectLanguage,
  type FileInfo,
  type FunctionInfo,
  type SupportedLanguage,
} from "./regex-analyzer";
import { GitignoreFilter } from "../memory/gitignore-filter";

// Re-export: FileInfo / FunctionInfo / SupportedLanguage 作为 codemap 模块门面的一部分，
// 供 v2/context、v2/understanding、v2/tests 等模块统一从 generator 导入，
// 避免调用方直接依赖 regex-analyzer 内部实现细节（TS 错误 TS2459 修复）。
export type { FileInfo, FunctionInfo, SupportedLanguage };

// ============================================================================
// 类型定义（与设计文档 §6.1 对齐）
// ============================================================================

/** CodeMap 生成器配置 */
export interface CodeMapConfig {
  /** 项目根目录（绝对路径） */
  projectRoot: string;
  /** 要扫描的文件扩展名（如 [".ts", ".js", ".py"]）；为空时自动检测全部支持的语言 */
  extensions: string[];
  /** 要排除的目录名（如 ["node_modules", ".git", "dist"]） */
  excludeDirs: string[];
  /** 最大文件大小（KB，超过跳过，避免分析超大文件阻塞） */
  maxFileSizeKb: number;
  /** 是否启用增量更新 */
  incremental: boolean;
  /** CodeMap 持久化存储路径（相对 projectRoot，默认 .deepcode/codemap.json） */
  outputPath: string;
}

/** 调用关系边（同文件内调用） */
export interface CallEdge {
  /** 调用方函数全名 */
  caller: string;
  /** 被调用方函数名 */
  callee: string;
  /** 调用所在文件路径（相对项目根） */
  file: string;
  /** 调用所在行号 */
  line: number;
}

/** 依赖关系边（跨文件，仅同项目内相对路径） */
export interface DependencyEdge {
  /** 源文件路径（相对项目根） */
  source: string;
  /** 目标文件路径（相对项目根，已做扩展名补全） */
  target: string;
  /** 依赖类型 */
  type: "import" | "require" | "from";
  /** 目标是否已解析到真实文件（R2：文件不存在时为 false） */
  resolved: boolean;
}

/** 项目技术栈信息 */
export interface TechStackInfo {
  frameworks: string[];
  buildTools: string[];
  packageManagers: string[];
  testFrameworks: string[];
  linters: string[];
}

/** 架构类型 */
export type ArchitectureType = "monorepo" | "mvc" | "clean" | "hexagonal" | "layered" | "microservices" | "unknown";

/** 项目信息 */
export interface ProjectInfo {
  name: string;
  root: string;
  techStack: TechStackInfo;
  architecture: ArchitectureType;
  languages: string[];
}

/** 模块信息（按顶层目录分组） */
export interface ModuleInfo {
  name: string;
  path: string;
  description: string;
  dependencies: string[];
  exports: string[];
  files: string[];
}

/** CodeMap 统计信息 */
export interface CodeMapStats {
  totalFiles: number;
  parsedFiles: number;
  failedFiles: number;
  totalClasses: number;
  totalFunctions: number;
  totalDependencies: number;
  cyclesDetected: number;
  unresolvedDeps: number;
  generationTimeMs: number;
}

/** 完整代码地图 */
export interface CodeMap {
  project: ProjectInfo;
  modules: ModuleInfo[];
  files: FileInfo[];
  callGraph: CallEdge[];
  dependencyGraph: DependencyEdge[];
  /** 检测到的循环依赖路径列表 */
  cycles: string[][];
  generatedAt: string;
  stats: CodeMapStats;
}

// ============================================================================
// 简易信号量（零依赖并发限制，架构师审查 R5：禁止 p-limit）
// ============================================================================

/**
 * 异步信号量
 *
 * 用于限制文件并行分析并发数（默认 10），避免同时打开过多文件描述符。
 * Node.js 单线程，并发主要让 I/O 等待重叠，CPU 密集的正则匹配仍串行。
 */
class Semaphore {
  /** 当前活跃任务数 */
  private active = 0;
  /** 等待队列（resolve 回调） */
  private readonly queue: Array<() => void> = [];

  /**
   * @param max 最大并发数
   */
  constructor(private readonly max: number) {}

  /**
   * 执行一个异步任务，受并发限制
   *
   * @param task 异步任务函数
   * @returns 任务返回值
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    // 达到并发上限时排队等待
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      // 唤醒队列中下一个任务
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// ============================================================================
// 依赖路径解析（架构师审查 R2）
// ============================================================================

/** 各语言扩展名补全候选优先级（R2 规则表） */
const EXTENSION_CANDIDATES: Record<string, string[]> = {
  typescript: [".ts", ".tsx", ".d.ts", "/index.ts", "/index.tsx"],
  javascript: [".js", ".jsx", ".mjs", ".cjs", "/index.js", "/index.jsx"],
  python: [".py", "/__init__.py"],
};

/**
 * 判断导入说明符是否为同项目内相对路径
 *
 * 规则（R2）：
 * - ./ 或 ../ 开头 → 相对路径，需解析
 * - / 开头 → 绝对路径，跳过（非项目内）
 * - 裸模块名（react、lodash、os、node:fs）→ 跳过
 * - node: 前缀 → Node.js 内置模块，跳过
 *
 * @param spec 导入说明符
 * @returns 是否为相对路径
 */
function isRelativeImport(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

/**
 * 解析导入说明符为目标文件相对路径
 *
 * 算法（R2）：
 * 1. 仅处理 ./ ../ 相对路径；其余返回 null（跳过）
 * 2. 基于源文件所在目录 + 说明符计算目标路径
 * 3. 按语言候选扩展名优先级逐一检查文件存在性
 * 4. 首个存在的候选作为目标；都不存在返回 { target: 原始, resolved: false }
 *
 * @param spec 导入说明符（如 "./bar"）
 * @param sourceFile 源文件相对项目根路径（如 "src/foo.ts"）
 * @param projectRoot 项目根绝对路径
 * @param language 源文件语言
 * @returns { target, resolved } target 为相对项目根的 POSIX 路径；不可解析时 resolved=false
 */
function resolveDependency(
  spec: string,
  sourceFile: string,
  projectRoot: string,
  language: SupportedLanguage
): { target: string; resolved: boolean } {
  if (!isRelativeImport(spec)) {
    return { target: spec, resolved: false };
  }

  // 源文件所在目录（相对项目根）
  const sourceDir = path.dirname(sourceFile);
  // 拼接目标路径（相对项目根）
  const targetRel = path.posix.normalize(path.posix.join(sourceDir, spec));
  // 候选扩展名列表
  const candidates = EXTENSION_CANDIDATES[language] ?? [];

  for (const candidate of candidates) {
    // candidate 可能是扩展名（.ts）或索引文件（/index.ts）
    const candidatePath = path.join(projectRoot, targetRel + candidate);
    try {
      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
        return { target: targetRel + candidate, resolved: true };
      }
    } catch {
      // 存在性检查异常：跳过该候选
    }
  }

  // 所有候选都不存在：返回原始路径，标记未解析
  return { target: targetRel, resolved: false };
}

// ============================================================================
// 循环依赖检测（架构师审查 R3：DFS 三色标记 + 环路径提取 + 去重）
// ============================================================================

/** DFS 节点颜色：白=未访问，灰=访问中（在栈中），黑=已完成 */
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

/**
 * 检测依赖图中的循环依赖
 *
 * 算法（R3）：DFS 三色标记法
 * - 白 → 灰：首次访问
 * - 灰 → 灰：发现环（当前节点的邻居仍在栈中）
 * - 灰 → 黑：完成访问
 *
 * 环路径提取：发现灰→灰边时，从 DFS 栈中找到被指向的灰色节点位置，
 * 切片到栈顶即得完整环路径。
 *
 * 环去重：将环路径旋转至字典序最小的起点，再做唯一性判断，避免同一环
 * 从不同起点被重复记录。
 *
 * 自环处理：文件 import 自身（source == target）不计入 cycles，
 * 单独统计到 stats（由调用方处理）。
 *
 * @param adjacencyList 邻接表：key=文件路径，value=该文件直接依赖的文件路径列表
 * @returns 去重后的循环依赖路径列表（每条为构成环的文件路径数组）
 */
function detectCycles(adjacencyList: Map<string, string[]>): string[][] {
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();

  // 初始化所有节点为白色
  for (const node of adjacencyList.keys()) {
    color.set(node, WHITE);
  }

  /**
   * DFS 递归访问
   *
   * @param node 当前节点
   */
  function dfs(node: string): void {
    color.set(node, GRAY);
    stack.push(node);

    const neighbors = adjacencyList.get(node) ?? [];
    for (const neighbor of neighbors) {
      // 邻居不在图中（未解析的目标）：跳过
      if (!color.has(neighbor)) continue;
      // 自环：跳过（不计入 cycles）
      if (neighbor === node) continue;

      const neighborColor = color.get(neighbor);
      if (neighborColor === GRAY) {
        // 发现环：从栈中找到 neighbor 位置，切片得到环路径
        const idx = stack.indexOf(neighbor);
        if (idx !== -1) {
          const cycle = stack.slice(idx);
          // 环去重：旋转至字典序最小的起点
          const normalized = normalizeCycle(cycle);
          const key = normalized.join("|");
          if (!seenCycleKeys.has(key)) {
            seenCycleKeys.add(key);
            cycles.push(normalized);
          }
        }
      } else if (neighborColor === WHITE) {
        dfs(neighbor);
      }
      // BLACK：已完成，跳过
    }

    stack.pop();
    color.set(node, BLACK);
  }

  // 对每个白色节点启动 DFS（处理非连通图）
  for (const node of adjacencyList.keys()) {
    if (color.get(node) === WHITE) {
      dfs(node);
    }
  }

  return cycles;
}

/**
 * 环路径规范化：旋转至字典序最小的起点
 *
 * 将环 [B, C, A] 旋转为 [A, B, C]（A 为字典序最小），使同一环的不同起点
 * 表示归一为相同 key，便于去重。
 *
 * @param cycle 原始环路径
 * @returns 规范化后的环路径
 */
function normalizeCycle(cycle: string[]): string[] {
  if (cycle.length <= 1) return cycle;
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i]! < cycle[minIdx]!) {
      minIdx = i;
    }
  }
  // 旋转：minIdx 起始 + 原始顺序
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
}

// ============================================================================
// 项目信息检测
// ============================================================================

/**
 * 检测项目技术栈
 *
 * 通过检查配置文件存在性推断技术栈：
 * - package.json → packageManagers（npm）/ yarn.lock（yarn）/ pnpm-lock.yaml（pnpm）
 * - tsconfig.json → frameworks 含 typescript
 * - jest.config.* / vitest.config.* → testFrameworks
 * - .eslintrc.* / eslint.config.* → linters
 * - webpack/vite/rollup 配置 → buildTools
 *
 * @param projectRoot 项目根绝对路径
 * @returns 技术栈信息
 */
function detectTechStack(projectRoot: string): TechStackInfo {
  const info: TechStackInfo = {
    frameworks: [],
    buildTools: [],
    packageManagers: [],
    testFrameworks: [],
    linters: [],
  };

  // 包管理器
  if (fs.existsSync(path.join(projectRoot, "package.json"))) {
    info.packageManagers.push("npm");
  }
  if (fs.existsSync(path.join(projectRoot, "yarn.lock"))) {
    info.packageManagers.push("yarn");
  }
  if (fs.existsSync(path.join(projectRoot, "pnpm-lock.yaml"))) {
    info.packageManagers.push("pnpm");
  }

  // 框架
  if (fs.existsSync(path.join(projectRoot, "tsconfig.json"))) {
    info.frameworks.push("typescript");
  }
  // 从 package.json 依赖进一步检测框架
  try {
    const pkgPath = path.join(projectRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const allDeps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      if (allDeps["react"]) info.frameworks.push("react");
      if (allDeps["vue"]) info.frameworks.push("vue");
      if (allDeps["express"]) info.frameworks.push("express");
      if (allDeps["next"]) info.frameworks.push("nextjs");
      if (allDeps["@nestjs/core"]) info.frameworks.push("nestjs");
      // 构建工具
      if (allDeps["webpack"]) info.buildTools.push("webpack");
      if (allDeps["vite"]) info.buildTools.push("vite");
      if (allDeps["rollup"]) info.buildTools.push("rollup");
      if (allDeps["esbuild"]) info.buildTools.push("esbuild");
      // 测试框架
      if (allDeps["jest"]) info.testFrameworks.push("jest");
      if (allDeps["vitest"]) info.testFrameworks.push("vitest");
      if (allDeps["mocha"]) info.testFrameworks.push("mocha");
      if (allDeps["@playwright/test"]) info.testFrameworks.push("playwright");
      // lint
      if (allDeps["eslint"]) info.linters.push("eslint");
      if (allDeps["ruff"]) info.linters.push("ruff");
      if (allDeps["prettier"]) info.linters.push("prettier");
    }
  } catch {
    // package.json 解析失败：忽略，技术栈检测降级
  }

  // 配置文件直接检测
  const eslintConfigs = [
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.json",
    ".eslintrc.yml",
    "eslint.config.js",
    "eslint.config.mjs",
  ];
  if (eslintConfigs.some((c) => fs.existsSync(path.join(projectRoot, c)))) {
    if (!info.linters.includes("eslint")) info.linters.push("eslint");
  }

  return info;
}

/**
 * 检测项目架构类型
 *
 * 简单推断规则（正则分析器无 AST，仅按目录结构）：
 * - 存在 packages/ 多包目录 → monorepo
 * - 存在 src/controllers + src/models + src/views → mvc
 * - 存在 src/domain + src/usecase + src/infra → clean
 * - 存在 src/ → layered（默认分层）
 * - 其余 → unknown
 *
 * @param projectRoot 项目根绝对路径
 * @returns 架构类型
 */
function detectArchitecture(projectRoot: string): ArchitectureType {
  const hasDir = (name: string): boolean =>
    fs.existsSync(path.join(projectRoot, name)) && fs.statSync(path.join(projectRoot, name)).isDirectory();

  const hasSrcSubDir = (sub: string): boolean =>
    fs.existsSync(path.join(projectRoot, "src", sub)) && fs.statSync(path.join(projectRoot, "src", sub)).isDirectory();

  if (hasDir("packages")) return "monorepo";
  if (hasSrcSubDir("controllers") && hasSrcSubDir("models")) return "mvc";
  if (hasSrcSubDir("domain") && hasSrcSubDir("usecase")) return "clean";
  if (hasSrcSubDir("hexagon") || hasSrcSubDir("ports")) return "hexagonal";
  if (hasDir("services") && hasDir("gateways")) return "microservices";
  if (hasDir("src")) return "layered";
  return "unknown";
}

// ============================================================================
// CodeMapGenerator 类
// ============================================================================

/** 默认配置常量 */
const DEFAULT_MAX_FILE_SIZE_KB = 512;
const DEFAULT_EXCLUDE_DIRS = ["node_modules", ".git", "dist", "build", ".deepcode"];
const DEFAULT_OUTPUT_PATH = ".deepcode/codemap.json";
const CONCURRENCY = 10;

/**
 * CodeMap 代码地图生成器
 *
 * 扫描项目目录，并行分析源文件，构建代码地图并持久化。
 *
 * 用法：
 * ```typescript
 * const generator = new CodeMapGenerator({
 *   projectRoot: "/path/to/project",
 *   extensions: [".ts", ".js", ".py"],
 *   excludeDirs: ["node_modules", ".git"],
 *   maxFileSizeKb: 512,
 *   incremental: false,
 *   outputPath: ".deepcode/codemap.json",
 * });
 * const codeMap = await generator.generateFullMap();
 * console.log(`扫描 ${codeMap.stats.totalFiles} 文件，识别 ${codeMap.stats.totalFunctions} 函数`);
 * ```
 */
export class CodeMapGenerator {
  /** 生成器配置 */
  private readonly config: CodeMapConfig;
  /** 项目根绝对路径 */
  private readonly projectRoot: string;
  /** 持久化文件绝对路径 */
  private readonly outputFilePath: string;
  /** .deepcode 目录绝对路径 */
  private readonly deepcodeDir: string;
  /** 错误日志文件绝对路径 */
  private readonly errorLogPath: string;
  /** 当前 CodeMap 缓存（用于增量更新） */
  private currentMap: CodeMap | null = null;

  /**
   * @param config 生成器配置
   */
  constructor(config: CodeMapConfig) {
    // maxFileSizeKb <= 0 时使用默认值，避免误传 0 导致全部文件被跳过
    this.config = config.maxFileSizeKb > 0 ? config : { ...config, maxFileSizeKb: DEFAULT_MAX_FILE_SIZE_KB };
    this.projectRoot = path.resolve(config.projectRoot);
    this.outputFilePath = path.join(this.projectRoot, config.outputPath || DEFAULT_OUTPUT_PATH);
    this.deepcodeDir = path.dirname(this.outputFilePath);
    this.errorLogPath = path.join(this.deepcodeDir, "codemap-errors.log");
  }

  /**
   * 获取生成器绑定的项目根绝对路径
   *
   * F-BIZ-01 ProjectUnderstandingService 需要此 getter 做一致性断言：
   * 调用 understand(projectRoot) 时 projectRoot 必须与生成器内部绑定的 projectRoot 一致，
   * 避免双源真相（生成器已绑定 projectRoot，understand 再传 projectRoot 时不一致即抛错）。
   *
   * @returns 项目根绝对路径（path.resolve 后）
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  /**
   * 生成完整代码地图
   *
   * 实现步骤：
   * 1. 加载 .gitignore 过滤器（复用 F-MEM-02 GitignoreFilter）
   * 2. 递归扫描项目目录，收集待分析文件列表
   * 3. 并行分析文件（并发限制 10，Semaphore）
   * 4. 解析依赖路径，构建 DependencyEdge[]
   * 5. 填充每个 FileInfo.dependencies
   * 6. 构建邻接表，DFS 检测循环依赖
   * 7. 构建 CallEdge[]（同文件内调用）
   * 8. 检测项目信息（techStack / architecture）
   * 9. 组装 CodeMap，持久化到 .deepcode/codemap.json
   * 10. 解析失败文件写入 codemap-errors.log
   *
   * @returns 完整代码地图
   */
  async generateFullMap(): Promise<CodeMap> {
    const startTime = Date.now();

    // 确保 .deepcode 目录存在（R4）
    this.ensureDeepcodeDir();

    // 清空旧的错误日志
    this.clearErrorLog();

    // 加载 .gitignore 过滤器
    const allExcludeDirs = [...new Set([...DEFAULT_EXCLUDE_DIRS, ...this.config.excludeDirs])];
    let gitignoreFilter: GitignoreFilter | null = null;
    try {
      gitignoreFilter = await GitignoreFilter.load(this.projectRoot, allExcludeDirs);
    } catch {
      // gitignore 加载失败：降级为仅按 excludeDirs 过滤
      gitignoreFilter = null;
    }

    // 扫描文件列表
    const filePaths = await this.scanProjectFiles(gitignoreFilter, allExcludeDirs);

    // 并行分析文件
    const semaphore = new Semaphore(CONCURRENCY);
    const fileInfos = await Promise.all(
      filePaths.map((filePath) => semaphore.run(async () => this.analyzeFileSafe(filePath)))
    );

    // 构建 CodeMap
    const codeMap = this.buildCodeMap(fileInfos, startTime);
    this.currentMap = codeMap;

    // 持久化
    await this.persistCodeMap(codeMap);

    return codeMap;
  }

  /**
   * 增量更新（仅重新分析变更文件）
   *
   * 算法（CM-10）：
   * 1. 读取已有 CodeMap（currentMap 或从磁盘加载）
   * 2. 对 changedFiles 重新分析，替换 files 数组中对应条目
   * 3. 重新构建依赖图、调用图、循环检测（图结构受变更影响需重建）
   * 4. 持久化
   *
   * @param changedFiles 变更文件列表（相对项目根路径）
   * @returns 更新后的代码地图
   */
  async updateIncremental(changedFiles: string[]): Promise<CodeMap> {
    // 获取基线 CodeMap
    let baseline = this.currentMap;
    if (!baseline) {
      baseline = await this.readCodeMap();
    }
    if (!baseline) {
      // 无基线：降级为全量生成
      return this.generateFullMap();
    }

    const startTime = Date.now();
    this.ensureDeepcodeDir();
    this.clearErrorLog();

    // 重新分析变更文件
    const changedSet = new Set(changedFiles);
    // 用绝对路径分析
    const semaphore = new Semaphore(CONCURRENCY);
    const reanalyzed = await Promise.all(
      changedFiles.map((relPath) =>
        semaphore.run(async () => this.analyzeFileSafe(path.join(this.projectRoot, relPath)))
      )
    );
    const reanalyzedMap = new Map<string, FileInfo>();
    for (const info of reanalyzed) {
      const relPath = path.relative(this.projectRoot, info.path);
      reanalyzedMap.set(relPath, info);
    }

    // 合并：未变更文件保留原样，变更文件替换
    const mergedFiles: FileInfo[] = [];
    for (const oldInfo of baseline.files) {
      const relPath = path.relative(this.projectRoot, oldInfo.path);
      if (changedSet.has(relPath)) {
        const newInfo = reanalyzedMap.get(relPath);
        if (newInfo) {
          mergedFiles.push(newInfo);
        }
        // 变更文件被删除则不 push（自然移除）
      } else {
        mergedFiles.push(oldInfo);
      }
    }
    // 新增文件（changedFiles 中不在 baseline.files 的）
    for (const [relPath, info] of reanalyzedMap) {
      const exists = baseline.files.some((f) => path.relative(this.projectRoot, f.path) === relPath);
      if (!exists) mergedFiles.push(info);
    }

    const codeMap = this.buildCodeMap(mergedFiles, startTime);
    this.currentMap = codeMap;
    await this.persistCodeMap(codeMap);
    return codeMap;
  }

  /**
   * 读取已持久化的 CodeMap
   *
   * @returns CodeMap；文件不存在或损坏返回 null
   */
  async readCodeMap(): Promise<CodeMap | null> {
    try {
      const content = await fs.promises.readFile(this.outputFilePath, "utf-8");
      const data = JSON.parse(content) as CodeMap;
      this.currentMap = data;
      return data;
    } catch {
      // 文件不存在或 JSON 损坏：返回 null
      return null;
    }
  }

  /**
   * 获取统计信息
   *
   * @returns 统计信息；未生成过 CodeMap 返回 null
   */
  async getStats(): Promise<CodeMapStats | null> {
    const map = this.currentMap ?? (await this.readCodeMap());
    return map?.stats ?? null;
  }

  // ------------------------------------------------------------------------
  // 私有方法
  // ------------------------------------------------------------------------

  /**
   * 确保 .deepcode 目录存在（R4）
   */
  private ensureDeepcodeDir(): void {
    if (!fs.existsSync(this.deepcodeDir)) {
      fs.mkdirSync(this.deepcodeDir, { recursive: true });
    }
  }

  /**
   * 清空错误日志
   */
  private clearErrorLog(): void {
    try {
      fs.writeFileSync(this.errorLogPath, "", "utf-8");
    } catch {
      // 忽略：可能无写权限
    }
  }

  /**
   * 追加写入错误日志
   *
   * @param message 错误消息
   */
  private appendErrorLog(message: string): void {
    try {
      fs.appendFileSync(this.errorLogPath, message + "\n", "utf-8");
    } catch {
      // 忽略：日志写入失败不应中断主流程
    }
  }

  /**
   * 递归扫描项目文件
   *
   * 过滤规则：
   * 1. 跳过 excludeDirs 中的目录
   * 2. 跳过 .gitignore 忽略的文件
   * 3. 跳过超大文件（> maxFileSizeKb）
   * 4. 仅保留 config.extensions 指定扩展名的文件（为空时保留全部支持语言）
   *
   * @param gitignoreFilter gitignore 过滤器（可能为 null）
   * @param excludeDirs 排除目录列表
   * @returns 待分析文件绝对路径列表
   */
  private async scanProjectFiles(gitignoreFilter: GitignoreFilter | null, excludeDirs: string[]): Promise<string[]> {
    const excludeSet = new Set(excludeDirs);
    const extensions =
      this.config.extensions.length > 0 ? new Set(this.config.extensions.map((e) => e.toLowerCase())) : null;
    const maxBytes = this.config.maxFileSizeKb * 1024;
    const result: string[] = [];

    /**
     * 递归扫描目录
     *
     * @param dirPath 当前目录绝对路径
     */
    const scanDir = async (dirPath: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        // 跳过排除目录
        if (entry.isDirectory() && excludeSet.has(entry.name)) continue;

        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.isFile()) {
          // 扩展名过滤
          const ext = path.extname(entry.name).toLowerCase();
          if (extensions && !extensions.has(ext)) continue;

          // 语言检测：跳过不支持的语言
          const lang = detectLanguage(fullPath);
          if (!lang) continue;

          // gitignore 过滤
          if (gitignoreFilter) {
            const relPath = path.relative(this.projectRoot, fullPath);
            if (gitignoreFilter.isIgnored(relPath)) continue;
          }

          // 文件大小过滤
          try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.size > maxBytes) continue;
          } catch {
            continue;
          }

          result.push(fullPath);
        }
      }
    };

    await scanDir(this.projectRoot);
    return result;
  }

  /**
   * 安全分析单个文件（捕获异常，记录错误日志）
   *
   * @param filePath 文件绝对路径
   * @returns 文件分析结果（parseStatus="ok" 或 "failed"）
   */
  private async analyzeFileSafe(filePath: string): Promise<FileInfo> {
    const lang = detectLanguage(filePath);
    if (!lang) {
      // 不支持的语言：返回 failed
      return {
        path: filePath,
        language: "typescript", // 默认占位（实际不应发生）
        classes: [],
        functions: [],
        imports: [],
        exports: [],
        lines: 0,
        parseStatus: "failed",
        dependencies: [],
      };
    }

    const analyzer = new RegexASTAnalyzer(lang);
    const info = analyzer.analyzeFile(filePath);

    // 失败时记录错误日志（CM-11）
    if (info.parseStatus === "failed") {
      const relPath = path.relative(this.projectRoot, filePath);
      this.appendErrorLog(`[${new Date().toISOString()}] 解析失败: ${relPath}`);
    }

    return info;
  }

  /**
   * 组装完整 CodeMap
   *
   * @param fileInfos 文件分析结果列表
   * @param startTime 生成开始时间戳
   * @returns 完整代码地图
   */
  private buildCodeMap(fileInfos: FileInfo[], startTime: number): CodeMap {
    // 1. 构建依赖图 + 填充 FileInfo.dependencies
    const { dependencyGraph, adjacencyList, unresolvedCount } = this.buildDependencyGraph(fileInfos);

    // 2. 循环检测
    const cycles = detectCycles(adjacencyList);

    // 3. 构建调用图（同文件内）
    const callGraph = this.buildCallGraph(fileInfos);

    // 4. 项目信息
    const languages = [...new Set(fileInfos.map((f) => f.language))];
    const project: ProjectInfo = {
      name: path.basename(this.projectRoot),
      root: this.projectRoot,
      techStack: detectTechStack(this.projectRoot),
      architecture: detectArchitecture(this.projectRoot),
      languages,
    };

    // 5. 模块信息（按顶层 src/ 子目录分组）
    const modules = this.buildModules(fileInfos);

    // 6. 统计信息
    const parsedFiles = fileInfos.filter((f) => f.parseStatus === "ok").length;
    const failedFiles = fileInfos.filter((f) => f.parseStatus === "failed").length;
    const totalClasses = fileInfos.reduce((sum, f) => sum + f.classes.length, 0);
    const totalFunctions = fileInfos.reduce((sum, f) => sum + f.functions.length, 0);

    const stats: CodeMapStats = {
      totalFiles: fileInfos.length,
      parsedFiles,
      failedFiles,
      totalClasses,
      totalFunctions,
      totalDependencies: dependencyGraph.length,
      cyclesDetected: cycles.length,
      unresolvedDeps: unresolvedCount,
      generationTimeMs: Date.now() - startTime,
    };

    return {
      project,
      modules,
      files: fileInfos,
      callGraph,
      dependencyGraph,
      cycles,
      generatedAt: new Date().toISOString(),
      stats,
    };
  }

  /**
   * 构建依赖图
   *
   * 遍历每个 FileInfo 的 imports，对相对路径说明符做扩展名补全解析，
   * 生成 DependencyEdge[]，同时填充 FileInfo.dependencies 和邻接表。
   *
   * @param fileInfos 文件分析结果列表
   * @returns 依赖图 + 邻接表 + 未解析依赖计数
   */
  private buildDependencyGraph(fileInfos: FileInfo[]): {
    dependencyGraph: DependencyEdge[];
    adjacencyList: Map<string, string[]>;
    unresolvedCount: number;
  } {
    const dependencyGraph: DependencyEdge[] = [];
    const adjacencyList = new Map<string, string[]>();
    let unresolvedCount = 0;

    // 初始化邻接表（每个文件作为节点）
    for (const info of fileInfos) {
      const relPath = path.relative(this.projectRoot, info.path);
      adjacencyList.set(relPath, []);
    }

    // 遍历每个文件的 imports
    for (const info of fileInfos) {
      const sourceRel = path.relative(this.projectRoot, info.path);
      const deps: string[] = [];

      for (const spec of info.imports) {
        const { target, resolved } = resolveDependency(spec, sourceRel, this.projectRoot, info.language);

        // 仅记录相对路径依赖（裸模块跳过）
        if (!isRelativeImport(spec)) continue;

        dependencyGraph.push({
          source: sourceRel,
          target,
          type: "import",
          resolved,
        });

        if (resolved) {
          deps.push(target);
          // 邻接表：仅含已解析且在图中的目标
          if (adjacencyList.has(target)) {
            adjacencyList.get(sourceRel)!.push(target);
          }
        } else {
          unresolvedCount++;
        }
      }

      // 填充 FileInfo.dependencies
      info.dependencies = deps;
    }

    return { dependencyGraph, adjacencyList, unresolvedCount };
  }

  /**
   * 构建调用图（同文件内调用）
   *
   * 遍历每个文件的每个函数的 calls 列表，生成 CallEdge。
   * 调用行号取函数体内首次出现 callee 的行号。
   *
   * @param fileInfos 文件分析结果列表
   * @returns 调用关系边列表
   */
  private buildCallGraph(fileInfos: FileInfo[]): CallEdge[] {
    const callGraph: CallEdge[] = [];

    for (const info of fileInfos) {
      const relPath = path.relative(this.projectRoot, info.path);

      for (const fn of info.functions) {
        for (const callee of fn.calls) {
          // 查找 callee 在函数体内的首次出现行号
          const line = this.findCallLine(info, fn, callee);
          callGraph.push({
            caller: fn.name,
            callee,
            file: relPath,
            line,
          });
        }
      }

      // 类方法调用也纳入
      for (const cls of info.classes) {
        for (const method of cls.methods) {
          for (const callee of method.calls) {
            const line = this.findCallLine(info, method, callee);
            callGraph.push({
              caller: method.name,
              callee,
              file: relPath,
              line,
            });
          }
        }
      }
    }

    return callGraph;
  }

  /**
   * 查找 callee 在函数体内的首次出现行号
   *
   * @param info 文件信息
   * @param fn 函数信息
   * @param callee 被调用函数名
   * @returns 行号（1-based）；找不到返回 fn.startLine
   */
  private findCallLine(info: FileInfo, fn: FunctionInfo, callee: string): number {
    // 重新读取文件内容查找（info 不缓存行内容，简化处理）
    try {
      const content = fs.readFileSync(info.path, "utf-8");
      const lines = content.split("\n");
      const callRe = new RegExp(`\\b${escapeRegExp(callee)}\\s*\\(`);
      for (let i = fn.startLine - 1; i < fn.endLine && i < lines.length; i++) {
        if (callRe.test(lines[i] ?? "")) {
          return i + 1;
        }
      }
    } catch {
      // 读取失败：fallback
    }
    return fn.startLine;
  }

  /**
   * 构建模块信息（按顶层 src/ 子目录分组）
   *
   * @param fileInfos 文件分析结果列表
   * @returns 模块信息列表
   */
  private buildModules(fileInfos: FileInfo[]): ModuleInfo[] {
    const moduleMap = new Map<string, FileInfo[]>();

    for (const info of fileInfos) {
      const relPath = path.relative(this.projectRoot, info.path);
      // 取第一层目录作为模块名
      const segments = relPath.split(path.sep);
      const moduleName = segments.length > 1 ? segments[0]! : ".";
      if (!moduleMap.has(moduleName)) moduleMap.set(moduleName, []);
      moduleMap.get(moduleName)!.push(info);
    }

    const modules: ModuleInfo[] = [];
    for (const [name, files] of moduleMap) {
      const allExports = files.flatMap((f) => f.exports);
      const allDeps = files.flatMap((f) => f.dependencies);
      modules.push({
        name,
        path: name,
        description: `${files.length} 文件`,
        dependencies: [...new Set(allDeps)],
        exports: allExports,
        files: files.map((f) => path.relative(this.projectRoot, f.path)),
      });
    }

    return modules;
  }

  /**
   * 持久化 CodeMap 到 JSON 文件（原子写入）
   *
   * 算法（R4）：
   * 1. 确保 .deepcode 目录存在
   * 2. 写入临时文件（.tmp 后缀）
   * 3. fsync 刷盘
   * 4. rename 为目标文件（原子操作）
   *
   * @param codeMap 代码地图
   */
  private async persistCodeMap(codeMap: CodeMap): Promise<void> {
    this.ensureDeepcodeDir();
    const tmpPath = this.outputFilePath + ".tmp";
    const content = JSON.stringify(codeMap, null, 2);

    // 原子写入：temp → fsync → rename
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, content, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.outputFilePath);
  }
}

/**
 * 转义正则元字符（用于动态构建调用查找正则）
 *
 * @param str 原始字符串
 * @returns 转义后的正则安全字符串
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
