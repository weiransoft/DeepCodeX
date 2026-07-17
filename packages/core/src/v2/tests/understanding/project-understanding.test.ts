/**
 * ProjectUnderstandingService 单元测试（F-BIZ-01）
 *
 * 测试覆盖：
 * - BIZ-01: package.json 识别（含 react+express → techStack 含 React+Express）
 * - BIZ-02a: 多清单共存（package.json + pom.xml + Cargo.toml）→ 多语言项目（不强制 monorepo）
 * - BIZ-02b: 真 monorepo（pnpm-workspace.yaml + packages/）→ architecture = monorepo
 * - BIZ-03: 框架推断（package.json dependencies 含 react → 推断框架为 React）
 * - BIZ-04: 分层架构识别（MVC 结构 controllers/models → architecture = mvc）
 *
 * 架构师审查报告 P1 必修补充用例：
 * - 空目录降级（无清单文件 → techStack 全空，architecture=unknown）
 * - 损坏 package.json 降级（JSON.parse 失败不抛错）
 * - understandFromCodeMap 无副作用路径
 * - projectRoot 不一致断言
 * - AGENTS.md 内容断言（章节标题存在）
 * - Python/Go/Rust/Java 多生态检测
 *
 * 所有测试使用 mkdtempSync 临时目录 + 真实写入清单文件，禁止 mock。
 *
 * @module v2/tests/understanding/project-understanding.test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CodeMapGenerator } from "../../codemap/generator";
import type { CodeMap, FileInfo } from "../../codemap/generator";
import { ProjectUnderstandingService } from "../../understanding/project-understanding";
import type { ProjectUnderstanding } from "../../understanding/project-understanding";

// ============================================================================
// 辅助工厂
// ============================================================================

/**
 * 创建临时项目目录
 *
 * @returns 临时目录绝对路径（测试结束后由 cleanupTmpDir 清理）
 */
function createTmpProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-biz-test-"));
}

/**
 * 清理临时目录（递归删除）
 *
 * @param dir 临时目录
 */
function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败（不影响测试断言）
  }
}

/**
 * 写入文件（自动创建父目录）
 *
 * @param projectRoot 项目根
 * @param relativePath 相对路径
 * @param content 文件内容
 */
function writeFile(projectRoot: string, relativePath: string, content: string): void {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

/**
 * 创建 package.json 内容
 *
 * @param overrides 覆盖字段
 * @returns package.json 字符串
 */
function createPackageJson(overrides?: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  workspaces?: unknown;
}): string {
  return JSON.stringify(
    {
      name: "test-project",
      version: "1.0.0",
      dependencies: overrides?.dependencies ?? {},
      devDependencies: overrides?.devDependencies ?? {},
      scripts: overrides?.scripts ?? {},
      ...(overrides?.workspaces !== undefined ? { workspaces: overrides.workspaces } : {}),
    },
    null,
    2
  );
}

/**
 * 构造 CodeMap 测试桩（无副作用，用于 understandFromCodeMap 测试）
 *
 * @param projectRoot 项目根
 * @param architecture 基线架构类型
 * @param files 文件列表
 * @returns CodeMap
 */
function createCodeMap(
  projectRoot: string,
  architecture: CodeMap["project"]["architecture"] = "unknown",
  files: FileInfo[] = []
): CodeMap {
  return {
    project: {
      name: path.basename(projectRoot),
      root: projectRoot,
      techStack: {
        frameworks: [],
        buildTools: [],
        packageManagers: [],
        testFrameworks: [],
        linters: [],
      },
      architecture,
      languages: files.length > 0 ? [files[0]!.language] : [],
    },
    modules: [],
    files,
    callGraph: [],
    dependencyGraph: [],
    cycles: [],
    generatedAt: new Date().toISOString(),
    stats: {
      totalFiles: files.length,
      parsedFiles: files.length,
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

// ============================================================================
// 测试用例
// ============================================================================

test("BIZ-01: package.json 识别（含 react+express → techStack 含 React+Express）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(
      dir,
      "package.json",
      createPackageJson({
        dependencies: { react: "^18.0.0", express: "^4.18.0" },
      })
    );

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    // 验证 React 框架被识别
    assert.ok(
      understanding.techStack.frameworks.includes("react"),
      `frameworks 应含 react，实际：${understanding.techStack.frameworks.join(",")}`
    );
    // 验证 Express 框架被识别
    assert.ok(
      understanding.techStack.frameworks.includes("express"),
      `frameworks 应含 express，实际：${understanding.techStack.frameworks.join(",")}`
    );
    // 验证 npm 包管理器被识别
    assert.ok(
      understanding.techStack.packageManagers.includes("npm"),
      `packageManagers 应含 npm，实际：${understanding.techStack.packageManagers.join(",")}`
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-02a: 多清单共存（package.json + pom.xml + Cargo.toml）→ 多语言项目（不强制 monorepo）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(dir, "package.json", createPackageJson({ dependencies: { react: "^18.0.0" } }));
    writeFile(
      dir,
      "pom.xml",
      `<?xml version="1.0" encoding="UTF-8"?>\n<project>\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.example</groupId>\n  <artifactId>demo</artifactId>\n  <version>1.0.0</version>\n</project>\n`
    );
    writeFile(dir, "Cargo.toml", `[package]\nname = "demo"\nversion = "0.1.0"\n`);

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    // 多清单共存时记录多生态（npm + maven + cargo）
    assert.ok(understanding.techStack.packageManagers.includes("npm"), "packageManagers 应含 npm");
    assert.ok(understanding.techStack.packageManagers.includes("maven"), "packageManagers 应含 maven");
    assert.ok(understanding.techStack.packageManagers.includes("cargo"), "packageManagers 应含 cargo");
    // 无工作区配置文件时，architecture 不应为 monorepo（polyglot 单仓 ≠ monorepo）
    assert.notEqual(
      understanding.architecture,
      "monorepo",
      `无工作区配置文件时 architecture 不应为 monorepo，实际：${understanding.architecture}`
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-02b: 真 monorepo（pnpm-workspace.yaml + packages/）→ architecture = monorepo", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(dir, "package.json", createPackageJson());
    writeFile(dir, "pnpm-workspace.yaml", `packages:\n  - 'packages/*'\n`);
    // 创建 packages 子包目录
    writeFile(dir, "packages/pkg-a/package.json", createPackageJson({ dependencies: { lodash: "^4.0.0" } }));

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: ["node_modules"],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    // 工作区配置文件存在 → monorepo
    assert.equal(
      understanding.architecture,
      "monorepo",
      `architecture 应为 monorepo，实际：${understanding.architecture}`
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-03: 框架推断（package.json dependencies 含 react → 推断框架为 React）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(dir, "package.json", createPackageJson({ dependencies: { react: "^18.0.0" } }));

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    assert.ok(
      understanding.techStack.frameworks.includes("react"),
      `frameworks 应含 react，实际：${understanding.techStack.frameworks.join(",")}`
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-04: 分层架构识别（MVC 结构 controllers/models → architecture = mvc）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(dir, "package.json", createPackageJson());
    // 创建 MVC 结构目录 + 占位文件（CodeMap 扫描需要文件，不只是空目录）
    writeFile(dir, "src/controllers/user.ts", "export class UserController {}\n");
    writeFile(dir, "src/models/user.ts", "export class User {}\n");

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [".ts"],
      excludeDirs: ["node_modules"],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    // CodeMapGenerator 应识别为 mvc
    assert.equal(understanding.architecture, "mvc", `architecture 应为 mvc，实际：${understanding.architecture}`);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-05: 空目录降级（无清单文件 → techStack 全空，architecture=unknown）", async () => {
  const dir = createTmpProjectDir();
  try {
    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    // 空目录：techStack 全空数组
    assert.deepEqual(understanding.techStack.frameworks, [], "frameworks 应为空数组");
    assert.deepEqual(understanding.techStack.buildTools, [], "buildTools 应为空数组");
    assert.deepEqual(understanding.techStack.packageManagers, [], "packageManagers 应为空数组");
    assert.deepEqual(understanding.techStack.testFrameworks, [], "testFrameworks 应为空数组");
    assert.deepEqual(understanding.techStack.linters, [], "linters 应为空数组");
    // 空目录：architecture = unknown
    assert.equal(
      understanding.architecture,
      "unknown",
      `architecture 应为 unknown，实际：${understanding.architecture}`
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-06: 损坏 package.json 降级（JSON.parse 失败不抛错）", async () => {
  const dir = createTmpProjectDir();
  try {
    // 写入损坏的 package.json（无效 JSON）
    writeFile(dir, "package.json", "{ invalid json content without closing brace");

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);

    // 不应抛错（CodeMapGenerator 内部已 try/catch 降级）
    const understanding = await service.understand(dir);
    // npm 包管理器仍应被识别（仅检测文件存在性，不依赖 JSON 解析）
    assert.ok(
      understanding.techStack.packageManagers.includes("npm"),
      "损坏 package.json 时 npm 仍应被识别（基于文件存在性）"
    );
    // 框架不应被识别（依赖 JSON 解析 dependencies）
    assert.ok(!understanding.techStack.frameworks.includes("react"), "损坏 package.json 时 react 不应被识别");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-07: understandFromCodeMap 无副作用路径（不触发 generateFullMap）", async () => {
  const dir = createTmpProjectDir();
  try {
    // 不写入任何文件，构造 CodeMap 桩直接调用 understandFromCodeMap
    const codeMap = createCodeMap(dir, "layered");

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = service.understandFromCodeMap(codeMap);

    // 应继承 CodeMap 桩的 architecture
    assert.equal(
      understanding.architecture,
      "layered",
      `architecture 应继承 CodeMap 桩的 layered，实际：${understanding.architecture}`
    );
    // 不应触发 .deepcode/codemap.json 持久化（无副作用）
    assert.ok(
      !fs.existsSync(path.join(dir, ".deepcode", "codemap.json")),
      "understandFromCodeMap 不应触发 .deepcode/codemap.json 持久化"
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-08: projectRoot 不一致断言（understand 传入与 generator 绑定的不一致时抛错）", async () => {
  const dir = createTmpProjectDir();
  const otherDir = createTmpProjectDir();
  try {
    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);

    // 传入与 generator 绑定不一致的 projectRoot 应抛错
    await assert.rejects(
      () => service.understand(otherDir),
      /projectRoot 不一致/,
      "understand 传入与 generator 绑定不一致的 projectRoot 时应抛 'projectRoot 不一致' 错误"
    );
  } finally {
    cleanupTmpDir(dir);
    cleanupTmpDir(otherDir);
  }
});

test("BIZ-09: Python 生态检测（requirements.txt + pytest）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(dir, "requirements.txt", "pytest>=7.0\nblack>=22.0\nrequests>=2.28\n");

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    assert.ok(understanding.techStack.packageManagers.includes("pip"), "packageManagers 应含 pip");
    assert.ok(understanding.techStack.testFrameworks.includes("pytest"), "testFrameworks 应含 pytest");
    assert.ok(understanding.techStack.linters.includes("black"), "linters 应含 black");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-10: Python pyproject.toml 生态检测（poetry + pytest）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(
      dir,
      "pyproject.toml",
      `[tool.poetry]\nname = "demo"\n\n[tool.poetry.dependencies]\npython = "^3.10"\npytest = "^7.0"\nruff = "^0.1.0"\n`
    );

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    assert.ok(understanding.techStack.packageManagers.includes("poetry"), "packageManagers 应含 poetry");
    assert.ok(understanding.techStack.testFrameworks.includes("pytest"), "testFrameworks 应含 pytest");
    assert.ok(understanding.techStack.linters.includes("ruff"), "linters 应含 ruff");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-11: Go 生态检测（go.mod）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(dir, "go.mod", `module github.com/example/demo\n\ngo 1.21\n`);

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    assert.ok(understanding.techStack.packageManagers.includes("go-modules"), "packageManagers 应含 go-modules");
    assert.ok(understanding.techStack.buildTools.includes("go"), "buildTools 应含 go");
    assert.ok(understanding.techStack.testFrameworks.includes("go-test"), "testFrameworks 应含 go-test");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-12: Rust 生态检测（Cargo.toml）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(
      dir,
      "Cargo.toml",
      `[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde = "1.0"\n`
    );

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    assert.ok(understanding.techStack.packageManagers.includes("cargo"), "packageManagers 应含 cargo");
    assert.ok(understanding.techStack.buildTools.includes("cargo"), "buildTools 应含 cargo");
    assert.ok(understanding.techStack.testFrameworks.includes("cargo-test"), "testFrameworks 应含 cargo-test");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-13: Rust workspace 检测（Cargo.toml [workspace] 段 → monorepo）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(dir, "Cargo.toml", `[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "0.1.0"\n`);

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    // Cargo.toml [workspace] 段 → monorepo
    assert.equal(
      understanding.architecture,
      "monorepo",
      `architecture 应为 monorepo（Cargo.toml [workspace]），实际：${understanding.architecture}`
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-14: Java Maven 生态检测（pom.xml）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(
      dir,
      "pom.xml",
      `<?xml version="1.0" encoding="UTF-8"?>\n<project>\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.example</groupId>\n  <artifactId>demo</artifactId>\n  <version>1.0.0</version>\n</project>\n`
    );

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    assert.ok(understanding.techStack.packageManagers.includes("maven"), "packageManagers 应含 maven");
    assert.ok(understanding.techStack.buildTools.includes("maven"), "buildTools 应含 maven");
    assert.ok(understanding.techStack.testFrameworks.includes("maven-surefire"), "testFrameworks 应含 maven-surefire");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-15: Java Gradle 生态检测（build.gradle）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(dir, "build.gradle", `plugins {\n  id 'java'\n}\nrepositories {\n  mavenCentral()\n}\n`);

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    assert.ok(understanding.techStack.packageManagers.includes("gradle"), "packageManagers 应含 gradle");
    assert.ok(understanding.techStack.buildTools.includes("gradle"), "buildTools 应含 gradle");
    assert.ok(understanding.techStack.testFrameworks.includes("gradle-test"), "testFrameworks 应含 gradle-test");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-16: package.json workspaces 字段 → monorepo", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(dir, "package.json", createPackageJson({ workspaces: ["packages/*"] }));

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    assert.equal(
      understanding.architecture,
      "monorepo",
      `architecture 应为 monorepo（package.json workspaces 字段），实际：${understanding.architecture}`
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-17: AGENTS.md 内容断言（章节标题存在）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(
      dir,
      "package.json",
      createPackageJson({
        dependencies: { react: "^18.0.0" },
        scripts: { test: "tsx --test", build: "tsc", lint: "eslint ." },
      })
    );

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    const md = understanding.agentsMd;
    // 必备章节标题
    assert.ok(md.includes("# AGENTS.md"), "AGENTS.md 应含 # AGENTS.md 主标题");
    assert.ok(md.includes("## Project Overview"), "AGENTS.md 应含 ## Project Overview");
    assert.ok(md.includes("## Architecture"), "AGENTS.md 应含 ## Architecture");
    // 有 techStack 时应有 Tech Stack 章节
    assert.ok(md.includes("## Tech Stack"), "AGENTS.md 应含 ## Tech Stack");
    // 有 Common Commands 时应有该章节（npm scripts 存在）
    assert.ok(md.includes("## Common Commands"), "AGENTS.md 应含 ## Common Commands");
    // Common Commands 应含 npm test
    assert.ok(md.includes("npm test"), "AGENTS.md 应含 'npm test' 命令");
    assert.ok(md.includes("npm run build"), "AGENTS.md 应含 'npm run build' 命令");
    assert.ok(md.includes("npm run lint"), "AGENTS.md 应含 'npm run lint' 命令");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-18: AGENTS.md 不应包含推断式建议（YAGNI 裁剪）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(dir, "package.json", createPackageJson());

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    const md = understanding.agentsMd;
    // 禁止出现推断式建议章节（架构师审查报告 P1-1）
    assert.ok(!md.includes("开发约定"), "AGENTS.md 不应含 '开发约定' 章节");
    assert.ok(!md.includes("代码风格建议"), "AGENTS.md 不应含 '代码风格建议' 章节");
    assert.ok(!md.includes("提交规范"), "AGENTS.md 不应含 '提交规范' 章节");
    assert.ok(!md.includes("分支策略"), "AGENTS.md 不应含 '分支策略' 章节");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-19: generateAgentsMd 单独调用（返回字符串不写文件）", async () => {
  const dir = createTmpProjectDir();
  try {
    // 构造 understanding 桩直接调用 generateAgentsMd
    const understanding: ProjectUnderstanding = {
      projectInfo: {
        name: "test-project",
        root: dir,
        techStack: {
          frameworks: ["react"],
          buildTools: ["vite"],
          packageManagers: ["npm"],
          testFrameworks: ["vitest"],
          linters: ["eslint"],
        },
        architecture: "layered",
        languages: ["typescript"],
      },
      modules: [
        {
          name: "core",
          path: "src/core",
          description: "核心模块",
          dependencies: [],
          exports: ["main"],
          files: ["src/core/index.ts"],
        },
      ],
      techStack: {
        frameworks: ["react"],
        buildTools: ["vite"],
        packageManagers: ["npm"],
        testFrameworks: ["vitest"],
        linters: ["eslint"],
      },
      architecture: "layered",
      agentsMd: "",
    };

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const md = await service.generateAgentsMd(understanding);

    // 验证返回非空字符串
    assert.ok(typeof md === "string", "generateAgentsMd 应返回 string");
    assert.ok(md.length > 0, "generateAgentsMd 应返回非空字符串");
    // 验证含 modules 章节
    assert.ok(md.includes("## Modules"), "AGENTS.md 应含 ## Modules 章节");
    assert.ok(md.includes("### core"), "AGENTS.md 应含 ### core 模块");
    // 验证不写文件（generateAgentsMd 仅返回字符串）
    assert.ok(!fs.existsSync(path.join(dir, "AGENTS.md")), "generateAgentsMd 不应写文件");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("BIZ-20: ProjectUnderstanding 是 ProjectUnderstandingInput 的超集（类型兼容性）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(dir, "package.json", createPackageJson());

    const generator = new CodeMapGenerator({
      projectRoot: dir,
      extensions: [],
      excludeDirs: [],
      maxFileSizeKb: 512,
      incremental: false,
      outputPath: ".deepcode/codemap.json",
    });
    const service = new ProjectUnderstandingService(generator);
    const understanding = await service.understand(dir);

    // 类型兼容性验证：ProjectUnderstanding 必须含 ProjectUnderstandingInput 全部字段
    // projectInfo: { name, root, languages }
    assert.ok(typeof understanding.projectInfo.name === "string", "projectInfo.name 应为 string");
    assert.ok(typeof understanding.projectInfo.root === "string", "projectInfo.root 应为 string");
    assert.ok(Array.isArray(understanding.projectInfo.languages), "projectInfo.languages 应为 Array");
    // techStack: 5 个字段
    assert.ok(Array.isArray(understanding.techStack.frameworks), "techStack.frameworks 应为 Array");
    assert.ok(Array.isArray(understanding.techStack.buildTools), "techStack.buildTools 应为 Array");
    assert.ok(Array.isArray(understanding.techStack.packageManagers), "techStack.packageManagers 应为 Array");
    assert.ok(Array.isArray(understanding.techStack.testFrameworks), "techStack.testFrameworks 应为 Array");
    assert.ok(Array.isArray(understanding.techStack.linters), "techStack.linters 应为 Array");
    // architecture: string
    assert.ok(typeof understanding.architecture === "string", "architecture 应为 string");
  } finally {
    cleanupTmpDir(dir);
  }
});
