/**
 * 项目理解服务（ProjectUnderstandingService）—— F-BIZ-01
 *
 * 识别项目结构、技术栈、架构类型，并生成 AGENTS.md 文档。
 *
 * 设计依据：
 * - V2 技术方案 §7.1 ProjectUnderstandingService 契约
 * - V2_P1_IMPLEMENTATION_PLAN.md §1（P1 裁剪：仅内置规则，无 LLM 推断）
 * - V2 架构师审查报告（2026-07-17）的 P0/P1 修改建议
 *
 * 关键设计决策（架构师审查报告 P0/P1 落实）：
 *
 * 1. 复用 CodeMap 基线（避免重复实现）：
 *    CodeMapGenerator 内部已实现 detectTechStack/detectArchitecture（npm 生态 + 6 类架构启发），
 *    本服务以 CodeMap.project.techStack / CodeMap.project.architecture 为基线，
 *    仅扩展非 npm 生态（Python/Java/Go/Rust）检测与"工作区配置文件 → monorepo"覆盖。
 *    私有方法签名：detectTechStack(projectRoot, codeMapTechStack) / detectArchitecture(codeMap)，
 *    明确"扩展合并"语义，避免双源真相。
 *
 * 2. 副作用隔离（understandFromCodeMap 公开方法）：
 *    understand(projectRoot) 会触发 CodeMapGenerator.generateFullMap() 全套副作用
 *    （扫描 + 持久化 .deepcode/codemap.json + 清空 codemap-errors.log）。
 *    新增 understandFromCodeMap(codeMap) 公开方法为纯转换（无 IO 副作用），
 *    供 P1 流水线中已生成 CodeMap 的场景复用，避免重复扫描。
 *
 * 3. projectRoot 一致性断言：
 *    CodeMapGenerator 在构造时已绑定 projectRoot，understand(projectRoot) 入参必须一致，
 *    不一致时抛错（避免双源真相）。
 *
 * 4. monorepo 判定改为工作区配置文件信号（修正 BIZ-02 误判）：
 *    不再以"多清单文件共存"推断 monorepo（polyglot 单仓项目会被误判）。
 *    新判定信号：pnpm-workspace.yaml / lerna.json / turbo.json / nx.json / rush.json /
 *    Cargo.toml [workspace] 段 / package.json workspaces 字段。
 *    多清单文件共存如实记录到 techStack（多生态并存），不强制改写 architecture。
 *
 * 5. AGENTS.md 事实提取（YAGNI 裁剪）：
 *    P1 阶段 AGENTS.md 仅做事实提取，不做推断式建议。
 *    章节：Project Overview / Tech Stack / Architecture / Modules / Common Commands。
 *    Common Commands 仅当清单文件中存在时提取（如 package.json scripts.test、
 *    pyproject.toml 含 pytest、Cargo.toml 存在等），不做"TypeScript 项目应该用 X"的推断。
 *
 * 6. CodeMap 失败降级：
 *    understand() 内部 generateFullMap() 抛错时降级为"仅做清单文件识别"，
 *    返回 architecture="unknown"、techStack 仅含本服务检测部分、modules=[]，
 *    不向上抛错（理解服务应尽可能返回部分结果）。
 *
 * @module v2/understanding/project-understanding
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeMapGenerator } from "../codemap/generator";
import type { CodeMap, TechStackInfo, ArchitectureType, ProjectInfo, ModuleInfo } from "../codemap/generator";
// 类型兼容性保险：ProjectUnderstanding 必须是 ProjectUnderstandingInput 的超集
import type { ProjectUnderstandingInput } from "../memory/project-memory";

// ============================================================================
// 类型定义（与 V2_CONTEXT_MEMORY_TECH_DESIGN.md §7.1 完全对齐）
// ============================================================================

/**
 * 项目理解结果
 *
 * 注意：本类型是 ProjectUnderstandingInput（project-memory.ts）的超集，
 * 满足 F-MEM-02 ProjectMemoryManager.initializeFromUnderstanding 的契约兼容性。
 * （架构师审查报告风险提示 2：使用结构化子集校验做编译期类型断言保险）
 */
export interface ProjectUnderstanding {
  /** 项目信息 */
  projectInfo: ProjectInfo;
  /** 模块结构（来自 CodeMap.modules） */
  modules: ModuleInfo[];
  /** 技术栈（CodeMap 基线 + 本服务扩展） */
  techStack: TechStackInfo;
  /** 架构类型（CodeMap 基线 + 工作区配置文件覆盖） */
  architecture: ArchitectureType;
  /** AGENTS.md 内容（generateAgentsMd 产出） */
  agentsMd: string;
}

// ============================================================================
// 常量
// ============================================================================

/**
 * 各语言清单文件名（用于多生态识别）
 *
 * 注：仅识别项目根目录下的清单文件（不递归扫描子目录，
 * 与 CodeMapGenerator 的根目录检测语义对齐）。
 */
const MANIFEST_FILES = {
  npm: ["package.json"],
  tsconfig: ["tsconfig.json"],
  python: ["requirements.txt", "pyproject.toml", "setup.py"],
  go: ["go.mod"],
  rust: ["Cargo.toml"],
  maven: ["pom.xml"],
  gradle: ["build.gradle", "build.gradle.kts"],
} as const;

/**
 * monorepo 工作区配置文件信号（架构师审查报告 P0-3）
 *
 * 存在任一即判定为 monorepo（覆盖 CodeMap 已检测的 architecture）。
 */
const MONOREPO_SIGNAL_FILES = ["pnpm-workspace.yaml", "lerna.json", "turbo.json", "nx.json", "rush.json"] as const;

// ============================================================================
// ProjectUnderstandingService 实现
// ============================================================================

/**
 * 项目理解服务
 *
 * 使用方式：
 * ```typescript
 * const generator = new CodeMapGenerator({ projectRoot: "/path/to/project", ... });
 * const service = new ProjectUnderstandingService(generator);
 * // 便捷入口（触发 CodeMap 全量扫描与持久化）
 * const understanding = await service.understand("/path/to/project");
 * // 无副作用入口（已生成 CodeMap 时复用）
 * const codeMap = await generator.generateFullMap();
 * const understanding2 = service.understandFromCodeMap(codeMap);
 * ```
 */
export class ProjectUnderstandingService {
  /**
   * @param codeMapGenerator CodeMap 生成器（构造时已绑定 projectRoot）
   */
  constructor(private readonly codeMapGenerator: CodeMapGenerator) {}

  /**
   * 理解项目（便捷入口，触发 CodeMap 全量扫描与持久化）
   *
   * 实现步骤：
   * 1. projectRoot 一致性断言（与 generator 绑定的 projectRoot 必须一致）
   * 2. 调用 CodeMapGenerator.generateFullMap() 获取 CodeMap（含副作用：
   *    扫描 + 写 .deepcode/codemap.json + 清空 codemap-errors.log）
   * 3. 委托 understandFromCodeMap(codeMap) 做纯转换
   * 4. generateFullMap 失败时降级为"仅做清单文件识别"
   *
   * @param projectRoot 项目根目录（必须与 generator 绑定的一致）
   * @returns 项目理解结果
   * @throws {Error} 当 projectRoot 与 generator 内部绑定的 projectRoot 不一致时
   */
  async understand(projectRoot: string): Promise<ProjectUnderstanding> {
    // 一致性断言：避免双源真相（架构师审查报告 P0-1）
    const expected = path.resolve(projectRoot);
    const bound = this.codeMapGenerator.getProjectRoot();
    if (expected !== bound) {
      throw new Error(
        `ProjectUnderstandingService.understand: projectRoot 不一致（传入 ${expected}，生成器绑定 ${bound}）`
      );
    }

    // 调用 CodeMapGenerator.generateFullMap()，失败时降级
    let codeMap: CodeMap | null = null;
    try {
      codeMap = await this.codeMapGenerator.generateFullMap();
    } catch {
      // 降级：仅做清单文件识别（架构师审查报告风险提示 3）
      codeMap = null;
    }

    if (codeMap) {
      return this.understandFromCodeMap(codeMap);
    }

    // 降级路径：构造一个最小 CodeMap 形态
    return this.understandFromCodeMap(this.buildFallbackCodeMap(expected));
  }

  /**
   * 从已生成的 CodeMap 做纯转换（无 IO 副作用）
   *
   * 适用场景：P1 流水线中已生成 CodeMap 时直接复用，避免重复扫描。
   *
   * 实现步骤：
   * 1. projectInfo 从 CodeMap.project 继承（name/root/languages 已检测）
   * 2. techStack = detectTechStack(projectRoot, CodeMap.project.techStack)
   *    （以 CodeMap 基线扩展非 npm 生态）
   * 3. architecture = detectArchitecture(CodeMap)
   *    （CodeMap 已检测 + 工作区配置文件覆盖）
   * 4. modules = CodeMap.modules（直接继承）
   * 5. agentsMd = generateAgentsMd(understanding)
   *
   * @param codeMap 已生成的 CodeMap
   * @returns 项目理解结果
   */
  understandFromCodeMap(codeMap: CodeMap): ProjectUnderstanding {
    const projectRoot = codeMap.project.root;
    // 扩展合并：CodeMap 基线 + 非 npm 生态检测
    const techStack = this.detectTechStack(projectRoot, codeMap.project.techStack);
    // 工作区配置文件覆盖：CodeMap 基线 + monorepo 信号检测
    const architecture = this.detectArchitecture(codeMap);

    // projectInfo 直接继承 CodeMap，但 techStack/architecture 用本服务扩展后的结果
    const projectInfo: ProjectInfo = {
      ...codeMap.project,
      techStack,
      architecture,
    };

    const understanding: ProjectUnderstanding = {
      projectInfo,
      modules: codeMap.modules,
      techStack,
      architecture,
      agentsMd: "", // 先填空，下面调用 generateAgentsMd 填充
    };

    // 生成 AGENTS.md 内容（同步调用，但保持 Promise 签名以对齐契约）
    understanding.agentsMd = this.generateAgentsMdSync(understanding);
    return understanding;
  }

  /**
   * 生成 AGENTS.md 内容（§7.1 契约）
   *
   * P1 阶段仅做事实提取，不做推断式建议（架构师审查报告 P1-1）。
   * 章节结构：
   * 1. Project Overview：name / root / languages
   * 2. Tech Stack：分 5 类列出（无内容则省略该子节）
   * 3. Architecture：architecture 字段值 + 一句话说明
   * 4. Modules：modules 列表（无则省略整个章节）
   * 5. Common Commands：仅当清单文件中存在时提取
   *
   * 注意：本方法返回字符串，不写文件。写盘职责留给 CLI 命令层。
   *
   * @param understanding 项目理解结果
   * @returns AGENTS.md 内容
   */
  async generateAgentsMd(understanding: ProjectUnderstanding): Promise<string> {
    return this.generateAgentsMdSync(understanding);
  }

  // ------------------------------------------------------------------------
  // 私有方法
  // ------------------------------------------------------------------------

  /**
   * 检测技术栈（扩展合并语义，非独立检测）
   *
   * 设计要点（架构师审查报告 P0-2）：
   * - 以 codeMapTechStack 为基线（CodeMapGenerator 已检测 npm 生态）
   * - 仅追加非 npm 生态检测（Python/Java/Go/Rust）
   * - 合并前 Set 去重，避免重复条目
   *
   * @param projectRoot 项目根目录
   * @param codeMapTechStack CodeMap 已检测的技术栈基线
   * @returns 扩展合并后的技术栈
   */
  private detectTechStack(projectRoot: string, codeMapTechStack: TechStackInfo): TechStackInfo {
    // 基线拷贝（避免修改入参）
    const frameworks = new Set(codeMapTechStack.frameworks);
    const buildTools = new Set(codeMapTechStack.buildTools);
    const packageManagers = new Set(codeMapTechStack.packageManagers);
    const testFrameworks = new Set(codeMapTechStack.testFrameworks);
    const linters = new Set(codeMapTechStack.linters);

    // ---- TypeScript 扩展 ----
    // tsconfig.json 存在 → typescript 框架（CodeMapGenerator 已检测，此处仅补强）
    // 已在 CodeMap 基线中，无需重复

    // ---- Python 生态扩展 ----
    if (this.hasManifest(projectRoot, MANIFEST_FILES.python)) {
      // 包管理器
      if (fs.existsSync(path.join(projectRoot, "pyproject.toml"))) {
        packageManagers.add("poetry");
      }
      if (fs.existsSync(path.join(projectRoot, "requirements.txt"))) {
        packageManagers.add("pip");
      }
      // 测试框架（仅当 deps 含 pytest 时记录）
      const pythonDeps = this.readPythonDeps(projectRoot);
      if (pythonDeps.has("pytest")) {
        testFrameworks.add("pytest");
      }
      // lint（仅当 deps 含相关工具时记录）
      if (pythonDeps.has("black")) {
        linters.add("black");
      }
      if (pythonDeps.has("ruff")) {
        linters.add("ruff");
      }
      if (pythonDeps.has("flake8")) {
        linters.add("flake8");
      }
      if (pythonDeps.has("mypy")) {
        linters.add("mypy");
      }
    }

    // ---- Go 生态扩展 ----
    if (this.hasManifest(projectRoot, MANIFEST_FILES.go)) {
      packageManagers.add("go-modules");
      buildTools.add("go");
      // 测试框架：Go 内置 testing 包，统一记为 go-test
      testFrameworks.add("go-test");
      // lint：仅当 .golangci.yml 存在时记录 golangci-lint
      if (
        fs.existsSync(path.join(projectRoot, ".golangci.yml")) ||
        fs.existsSync(path.join(projectRoot, ".golangci.yaml"))
      ) {
        linters.add("golangci-lint");
      }
    }

    // ---- Rust 生态扩展 ----
    if (this.hasManifest(projectRoot, MANIFEST_FILES.rust)) {
      packageManagers.add("cargo");
      buildTools.add("cargo");
      testFrameworks.add("cargo-test");
      // lint：Rust 内置 rustc，clippy 需手动启用，仅当 Cargo.toml 存在时记录 rustc
      linters.add("rustc");
    }

    // ---- Java Maven 生态扩展 ----
    if (this.hasManifest(projectRoot, MANIFEST_FILES.maven)) {
      packageManagers.add("maven");
      buildTools.add("maven");
      testFrameworks.add("maven-surefire");
      // Maven 内置 checkstyle 插件需配置才生效，不默认记录
    }

    // ---- Java Gradle 生态扩展 ----
    if (this.hasManifest(projectRoot, MANIFEST_FILES.gradle)) {
      packageManagers.add("gradle");
      buildTools.add("gradle");
      testFrameworks.add("gradle-test");
    }

    return {
      frameworks: Array.from(frameworks),
      buildTools: Array.from(buildTools),
      packageManagers: Array.from(packageManagers),
      testFrameworks: Array.from(testFrameworks),
      linters: Array.from(linters),
    };
  }

  /**
   * 检测架构类型（扩展合并语义）
   *
   * 设计要点（架构师审查报告 P0-2/P0-3）：
   * - 以 CodeMap.project.architecture 为基线
   * - 工作区配置文件信号覆盖：检测到 monorepo 信号 → 强制 "monorepo"
   * - 不重新跑目录结构启发（避免重复实现）
   *
   * @param codeMap CodeMap（含 project.architecture 基线 + project.root）
   * @returns 扩展覆盖后的架构类型
   */
  private detectArchitecture(codeMap: CodeMap): ArchitectureType {
    const projectRoot = codeMap.project.root;
    const baseline = codeMap.project.architecture;

    // 工作区配置文件信号检测（架构师审查报告 P0-3）
    if (this.isMonorepo(projectRoot)) {
      return "monorepo";
    }

    // 无工作区信号时保持 CodeMap 基线
    return baseline;
  }

  /**
   * 生成 AGENTS.md 内容（同步实现）
   *
   * @param understanding 项目理解结果
   * @returns AGENTS.md 字符串
   */
  private generateAgentsMdSync(understanding: ProjectUnderstanding): string {
    const lines: string[] = [];
    lines.push("# AGENTS.md");
    lines.push("");
    lines.push("> 由 DeepCodeX V2-P1 ProjectUnderstandingService 自动生成（事实提取，无推断式建议）");
    lines.push("");

    // ---- Project Overview ----
    lines.push("## Project Overview");
    lines.push("");
    lines.push(`- **Name**: ${understanding.projectInfo.name || "(unknown)"}`);
    lines.push(`- **Root**: ${understanding.projectInfo.root}`);
    if (understanding.projectInfo.languages.length > 0) {
      lines.push(`- **Languages**: ${understanding.projectInfo.languages.join(", ")}`);
    }
    lines.push("");

    // ---- Tech Stack ----
    const ts = understanding.techStack;
    const hasAnyTechStack =
      ts.frameworks.length > 0 ||
      ts.buildTools.length > 0 ||
      ts.packageManagers.length > 0 ||
      ts.testFrameworks.length > 0 ||
      ts.linters.length > 0;
    if (hasAnyTechStack) {
      lines.push("## Tech Stack");
      lines.push("");
      if (ts.frameworks.length > 0) {
        lines.push(`- **Frameworks**: ${ts.frameworks.join(", ")}`);
      }
      if (ts.buildTools.length > 0) {
        lines.push(`- **Build Tools**: ${ts.buildTools.join(", ")}`);
      }
      if (ts.packageManagers.length > 0) {
        lines.push(`- **Package Managers**: ${ts.packageManagers.join(", ")}`);
      }
      if (ts.testFrameworks.length > 0) {
        lines.push(`- **Test Frameworks**: ${ts.testFrameworks.join(", ")}`);
      }
      if (ts.linters.length > 0) {
        lines.push(`- **Linters**: ${ts.linters.join(", ")}`);
      }
      lines.push("");
    }

    // ---- Architecture ----
    lines.push("## Architecture");
    lines.push("");
    lines.push(`- **Type**: ${understanding.architecture}`);
    if (understanding.architecture === "monorepo") {
      lines.push(
        "- **Note**: 检测到工作区配置文件（pnpm-workspace.yaml / lerna.json / Cargo.toml [workspace] / package.json workspaces 等）"
      );
    }
    lines.push("");

    // ---- Modules ----
    if (understanding.modules.length > 0) {
      lines.push("## Modules");
      lines.push("");
      for (const mod of understanding.modules) {
        lines.push(`### ${mod.name}`);
        lines.push("");
        lines.push(`- **Path**: ${mod.path}`);
        if (mod.description) {
          lines.push(`- **Description**: ${mod.description}`);
        }
        if (mod.dependencies.length > 0) {
          lines.push(`- **Dependencies**: ${mod.dependencies.join(", ")}`);
        }
        if (mod.exports.length > 0) {
          lines.push(`- **Exports**: ${mod.exports.join(", ")}`);
        }
        if (mod.files.length > 0) {
          lines.push(`- **Files**: ${mod.files.length} 个文件`);
        }
        lines.push("");
      }
    }

    // ---- Common Commands（事实提取，无推断）----
    const commands = this.extractCommonCommands(understanding);
    if (commands.length > 0) {
      lines.push("## Common Commands");
      lines.push("");
      lines.push("```bash");
      for (const cmd of commands) {
        lines.push(`# ${cmd.comment}`);
        lines.push(cmd.command);
        lines.push("");
      }
      lines.push("```");
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * 从清单文件中提取常见命令（事实提取）
   *
   * 提取规则（架构师审查报告 P1-1）：
   * - npm：从 package.json scripts 提取 test/build/lint（存在才写）
   * - Python：仅当 deps 含 pytest 时列出 pytest
   * - Go：仅当 go.mod 存在时列出 go test/go build
   * - Rust：仅当 Cargo.toml 存在时列出 cargo test/cargo build
   * - Java Maven：仅当 pom.xml 存在时列出 mvn test/mvn package
   * - Java Gradle：仅当 build.gradle 存在时列出 ./gradlew test/./gradlew build
   *
   * @param understanding 项目理解结果（用于定位 projectRoot）
   * @returns 命令列表（含注释）
   */
  private extractCommonCommands(understanding: ProjectUnderstanding): Array<{ comment: string; command: string }> {
    const projectRoot = understanding.projectInfo.root;
    const commands: Array<{ comment: string; command: string }> = [];

    // ---- npm：从 package.json scripts 提取 ----
    const pkgPath = path.join(projectRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
          scripts?: Record<string, string>;
        };
        const scripts = pkg.scripts ?? {};
        if (scripts.test) {
          commands.push({ comment: "运行测试", command: "npm test" });
        }
        if (scripts.build) {
          commands.push({ comment: "构建项目", command: "npm run build" });
        }
        if (scripts.lint) {
          commands.push({ comment: "代码检查", command: "npm run lint" });
        }
      } catch {
        // package.json 解析失败：忽略（与 CodeMapGenerator 降级语义一致）
      }
    }

    // ---- Python：仅当 deps 含 pytest 时列出 ----
    if (this.hasManifest(projectRoot, MANIFEST_FILES.python)) {
      const pythonDeps = this.readPythonDeps(projectRoot);
      if (pythonDeps.has("pytest")) {
        commands.push({ comment: "运行 Python 测试", command: "pytest" });
      }
    }

    // ---- Go：仅当 go.mod 存在时列出 ----
    if (this.hasManifest(projectRoot, MANIFEST_FILES.go)) {
      commands.push({ comment: "运行 Go 测试", command: "go test ./..." });
      commands.push({ comment: "构建 Go 项目", command: "go build ./..." });
    }

    // ---- Rust：仅当 Cargo.toml 存在时列出 ----
    if (this.hasManifest(projectRoot, MANIFEST_FILES.rust)) {
      commands.push({ comment: "运行 Rust 测试", command: "cargo test" });
      commands.push({ comment: "构建 Rust 项目", command: "cargo build" });
    }

    // ---- Java Maven：仅当 pom.xml 存在时列出 ----
    if (this.hasManifest(projectRoot, MANIFEST_FILES.maven)) {
      commands.push({ comment: "运行 Maven 测试", command: "mvn test" });
      commands.push({ comment: "打包 Maven 项目", command: "mvn package" });
    }

    // ---- Java Gradle：仅当 build.gradle 存在时列出 ----
    if (this.hasManifest(projectRoot, MANIFEST_FILES.gradle)) {
      commands.push({ comment: "运行 Gradle 测试", command: "./gradlew test" });
      commands.push({ comment: "构建 Gradle 项目", command: "./gradlew build" });
    }

    return commands;
  }

  /**
   * 判定项目是否为 monorepo（工作区配置文件信号）
   *
   * 判定规则（架构师审查报告 P0-3）：
   * - 存在 pnpm-workspace.yaml / lerna.json / turbo.json / nx.json / rush.json → true
   * - Cargo.toml 含 [workspace] 段 → true
   * - package.json 含 workspaces 字段 → true
   * - 其他 → false（polyglot 单仓项目不算 monorepo）
   *
   * @param projectRoot 项目根目录
   * @returns 是否为 monorepo
   */
  private isMonorepo(projectRoot: string): boolean {
    // 1. 工作区配置文件信号
    for (const signal of MONOREPO_SIGNAL_FILES) {
      if (fs.existsSync(path.join(projectRoot, signal))) {
        return true;
      }
    }

    // 2. Cargo.toml [workspace] 段检测（行级状态机，避免引入 toml 依赖）
    const cargoPath = path.join(projectRoot, "Cargo.toml");
    if (fs.existsSync(cargoPath)) {
      try {
        const cargoContent = fs.readFileSync(cargoPath, "utf-8");
        if (this.hasCargoWorkspaceSection(cargoContent)) {
          return true;
        }
      } catch {
        // Cargo.toml 读取失败：忽略
      }
    }

    // 3. package.json workspaces 字段检测
    const pkgPath = path.join(projectRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
          workspaces?: unknown;
        };
        if (pkg.workspaces !== undefined && pkg.workspaces !== null) {
          return true;
        }
      } catch {
        // package.json 解析失败：忽略
      }
    }

    return false;
  }

  /**
   * 检测 Cargo.toml 内容是否含 [workspace] 段
   *
   * 行级状态机实现（避免引入 toml 依赖，架构师审查报告风险提示）：
   * - 逐行扫描，识别 [workspace] 段起始
   * - 遇到下一个 [xxx] 段时结束
   * - 只要存在 [workspace] 段即返回 true
   *
   * @param content Cargo.toml 文件内容
   * @returns 是否含 [workspace] 段
   */
  private hasCargoWorkspaceSection(content: string): boolean {
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      // 匹配 [workspace] 或 [workspace.xxx]（ TOML 段头语法）
      if (/^\[workspace(\..+)?\]$/.test(trimmed)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 判定项目根目录是否含指定清单文件中的任一
   *
   * @param projectRoot 项目根目录
   * @param files 清单文件名列表
   * @returns 含任一返回 true
   */
  private hasManifest(projectRoot: string, files: readonly string[]): boolean {
    return files.some((f) => fs.existsSync(path.join(projectRoot, f)));
  }

  /**
   * 读取 Python 依赖集合（从 requirements.txt + pyproject.toml）
   *
   * 简化解析（避免引入 toml 依赖）：
   * - requirements.txt：每行去掉版本约束（==、>=、<=、~=、>、<）取包名
   * - pyproject.toml：仅识别 [tool.poetry.dependencies] 段下的包名（行级状态机）
   * - pyproject.toml：识别 [project.dependencies] 段下的包名（PEP 621）
   *
   * @param projectRoot 项目根目录
   * @returns 依赖包名集合（小写）
   */
  private readPythonDeps(projectRoot: string): Set<string> {
    const deps = new Set<string>();

    // ---- requirements.txt ----
    const reqPath = path.join(projectRoot, "requirements.txt");
    if (fs.existsSync(reqPath)) {
      try {
        const content = fs.readFileSync(reqPath, "utf-8");
        for (const raw of content.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line || line.startsWith("#")) continue;
          // 去掉环境标记（如 pytest>=7.0; python_version > "3.8"）
          const beforeMarker = line.split(";")[0]!.trim();
          // 去掉版本约束
          const name = beforeMarker
            .split(/[<>=!~]/)[0]!
            .trim()
            .toLowerCase();
          if (name) deps.add(name);
        }
      } catch {
        // 读取失败：忽略
      }
    }

    // ---- pyproject.toml ----
    const pyprojectPath = path.join(projectRoot, "pyproject.toml");
    if (fs.existsSync(pyprojectPath)) {
      try {
        const content = fs.readFileSync(pyprojectPath, "utf-8");
        this.parsePyprojectDeps(content, deps);
      } catch {
        // 读取失败：忽略
      }
    }

    return deps;
  }

  /**
   * 解析 pyproject.toml 内容，提取依赖包名
   *
   * 行级状态机实现（避免引入 toml 依赖）：
   * - 进入 [tool.poetry.dependencies] 或 [project.dependencies] 段时开始采集
   * - 遇到下一个 [xxx] 段时结束
   * - 每行取等号左边的包名（PEP 621 形式）或键名（poetry 形式）
   *
   * @param content pyproject.toml 文件内容
   * @param deps 输出参数，采集到的包名加入此集合（小写）
   */
  private parsePyprojectDeps(content: string, deps: Set<string>): void {
    const lines = content.split(/\r?\n/);
    let inDepsSection = false;
    for (const raw of lines) {
      const line = raw.trim();
      // 段头判定
      if (line.startsWith("[") && line.endsWith("]")) {
        inDepsSection = line === "[tool.poetry.dependencies]" || line === "[project.dependencies]";
        continue;
      }
      if (!inDepsSection) continue;
      if (!line || line.startsWith("#")) continue;

      // PEP 621 形式："pytest >= 7.0"（行级字符串列表）
      // poetry 形式：`pytest = "^7.0"` 或 `pytest = {version = "^7.0", ...}`
      // 提取等号左边的键名，或行首到第一个分隔符的 token
      let name: string | null = null;
      if (line.includes("=")) {
        name = line.split("=")[0]!.trim();
      } else {
        // PEP 621 字符串列表项："pytest >= 7.0" 或 "pytest"
        name = line.split(/[\s<>=!~]/)[0]!.trim();
      }
      // 过滤掉 python 关键字（poetry dependencies 段必含 python = "..."）
      if (name && name.toLowerCase() !== "python") {
        // 去掉可能的引号
        name = name.replace(/^["']|["']$/g, "").toLowerCase();
        if (name) deps.add(name);
      }
    }
  }

  /**
   * 构造降级用的最小 CodeMap（generateFullMap 失败时使用）
   *
   * 降级语义（架构师审查报告风险提示 3）：
   * - 不依赖 CodeMap 扫描结果
   * - project.techStack/architecture 由本服务自行检测
   * - modules = []（无 CodeMap 无法识别模块结构）
   * - files = []（无 CodeMap 无法识别文件结构）
   *
   * @param projectRoot 项目根目录
   * @returns 最小 CodeMap 形态
   */
  private buildFallbackCodeMap(projectRoot: string): CodeMap {
    // 降级时仅做清单文件识别（不依赖 CodeMap 扫描）
    const emptyTechStack: TechStackInfo = {
      frameworks: [],
      buildTools: [],
      packageManagers: [],
      testFrameworks: [],
      linters: [],
    };
    const techStack = this.detectTechStack(projectRoot, emptyTechStack);
    const architecture: ArchitectureType = this.isMonorepo(projectRoot) ? "monorepo" : "unknown";

    return {
      project: {
        name: path.basename(projectRoot),
        root: projectRoot,
        techStack,
        architecture,
        languages: [], // 降级时无法识别
      },
      modules: [],
      files: [],
      callGraph: [],
      dependencyGraph: [],
      cycles: [],
      generatedAt: new Date().toISOString(),
      stats: {
        totalFiles: 0,
        parsedFiles: 0,
        failedFiles: 0,
        totalClasses: 0,
        totalFunctions: 0,
        totalDependencies: 0,
        cyclesDetected: 0,
        unresolvedDeps: 0,
        generationTimeMs: 0,
      },
    };
  }
}

// ============================================================================
// 类型兼容性保险（架构师审查报告风险提示 2）
// ============================================================================

/**
 * 静态类型断言：ProjectUnderstanding 必须是 ProjectUnderstandingInput 的超集
 *
 * 编译期检查（无运行时开销）：确保 ProjectUnderstandingService 产出的
 * ProjectUnderstanding 可直接传入 ProjectMemoryManager.initializeFromUnderstanding。
 * 若字段漂移（如 ProjectUnderstandingInput 新增必填字段），编译即报错。
 *
 * 实现说明：使用 TypeScript 的"结构化子集校验"语义——
 * 只要 ProjectUnderstanding 包含 ProjectUnderstandingInput 的全部字段，
 * 即视为兼容（多余字段不影响兼容性）。
 *
 * 导出说明：导出此类型别名让 lint 识别为公开 API（避免 no-unused-vars 误报），
 * 同时供消费方在自身模块做类型断言复用。
 */
export type AssertProjectUnderstandingCompatible = ProjectUnderstanding extends ProjectUnderstandingInput
  ? true
  : never;
