/**
 * EAG-P1 批次 5 单元测试：PKC L1 全局视野层数据模型
 *
 * 测试范围：
 * - T1. PkcLayer 字面量联合完整性
 *   - T1a. PkcLayer 包含 4 个合法值（L1/L2/L3/L4）
 *   - T1b. PKC_LAYERS 常量顺序正确
 *   - T1c. PKC_LAYERS 常量已冻结
 * - T2. IMPLEMENTED_PKC_LAYERS 当前批次实施范围
 *   - T2a. 仅实施 L1
 *   - T2b. 常量已冻结
 * - T3. RepositoryMap 接口字段完整性
 * - T4. DirectoryNode 接口字段完整性（含递归 children）
 * - T5. FileNode 接口字段完整性
 * - T6. EntryPointType 字面量联合完整性
 *   - T6a. 4 类入口点类型
 *   - T6b. ENTRY_POINT_TYPES 常量顺序
 *   - T6c. 常量已冻结
 * - T7. EntryPoint 接口字段完整性
 * - T8. TechStackFingerprint 接口字段完整性
 * - T9. LayeredArchitectureParadigm 字面量联合完整性
 *   - T9a. 5 类范式（含 unknown）
 * - T10. LayeredArchitecture 接口字段完整性
 * - T11. L1GlobalView 接口字段完整性
 * - T12. DEFAULT_IGNORED_DIRECTORIES 常量
 *   - T12a. 含 node_modules
 *   - T12b. 含 .git
 *   - T12c. 含 dist
 *   - T12d. 含 build
 *   - T12e. 常量已冻结
 * - T13. DEFAULT_IGNORED_EXTENSIONS 常量
 *   - T13a. 含 .png
 *   - T13b. 含 .jpg
 *   - T13c. 含 .svg
 *   - T13d. 含 .pdf
 *   - T13e. 常量已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 *
 * @module core/tests/eag-pkc-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PKC_LAYERS,
  IMPLEMENTED_PKC_LAYERS,
  ENTRY_POINT_TYPES,
  DEFAULT_IGNORED_DIRECTORIES,
  DEFAULT_IGNORED_EXTENSIONS,
} from "../eag/pkc/types";
import type {
  PkcLayer,
  RepositoryMap,
  DirectoryNode,
  FileNode,
  EntryPointType,
  EntryPoint,
  TechStackFingerprint,
  LayeredArchitecture,
  LayeredArchitectureParadigm,
  L1GlobalView,
} from "../eag/pkc/types";

// ============================================================================
// T1. PkcLayer 字面量联合完整性
// ============================================================================

test("T1a. PkcLayer 包含 4 个合法值（L1/L2/L3/L4）", () => {
  assert.equal(PKC_LAYERS.length, 4);
});

test("T1b. PKC_LAYERS 常量顺序正确（L1→L2→L3→L4）", () => {
  const expected: ReadonlyArray<PkcLayer> = ["L1", "L2", "L3", "L4"];
  assert.deepEqual([...PKC_LAYERS], [...expected]);
});

test("T1c. PKC_LAYERS 常量已冻结", () => {
  assert.equal(Object.isFrozen(PKC_LAYERS), true);
});

// ============================================================================
// T2. IMPLEMENTED_PKC_LAYERS 当前批次实施范围
// ============================================================================

test("T2a. IMPLEMENTED_PKC_LAYERS 仅实施 L1", () => {
  assert.equal(IMPLEMENTED_PKC_LAYERS.length, 1);
  assert.equal(IMPLEMENTED_PKC_LAYERS[0], "L1");
});

test("T2b. IMPLEMENTED_PKC_LAYERS 常量已冻结", () => {
  assert.equal(Object.isFrozen(IMPLEMENTED_PKC_LAYERS), true);
});

// ============================================================================
// T3. RepositoryMap 接口字段完整性
// ============================================================================

test("T3. RepositoryMap 接口字段完整性", () => {
  const map: RepositoryMap = {
    rootPath: "/tmp/project",
    directories: [],
    files: [],
    totalFiles: 0,
    totalDirectories: 0,
  };
  assert.equal(map.rootPath, "/tmp/project");
  assert.equal(map.directories.length, 0);
  assert.equal(map.files.length, 0);
  assert.equal(map.totalFiles, 0);
  assert.equal(map.totalDirectories, 0);
});

// ============================================================================
// T4. DirectoryNode 接口字段完整性（含递归 children）
// ============================================================================

test("T4. DirectoryNode 接口字段完整性（含递归 children）", () => {
  const child: DirectoryNode = {
    path: "src/domain",
    name: "domain",
    moduleResponsibility: "领域层（DDD）",
    children: [],
  };
  const parent: DirectoryNode = {
    path: "src",
    name: "src",
    moduleResponsibility: "源代码",
    children: [child],
  };
  assert.equal(parent.path, "src");
  assert.equal(parent.name, "src");
  assert.equal(parent.moduleResponsibility, "源代码");
  assert.equal(parent.children.length, 1);
  assert.equal(parent.children[0].name, "domain");
  assert.equal(parent.children[0].children.length, 0);
});

test("T4b. DirectoryNode moduleResponsibility 可选", () => {
  const node: DirectoryNode = {
    path: "unknown",
    name: "unknown",
    children: [],
  };
  assert.equal(node.moduleResponsibility, undefined);
});

// ============================================================================
// T5. FileNode 接口字段完整性
// ============================================================================

test("T5. FileNode 接口字段完整性", () => {
  const file: FileNode = {
    path: "src/index.ts",
    name: "index.ts",
    extension: ".ts",
    lines: 42,
  };
  assert.equal(file.path, "src/index.ts");
  assert.equal(file.name, "index.ts");
  assert.equal(file.extension, ".ts");
  assert.equal(file.lines, 42);
});

// ============================================================================
// T6. EntryPointType 字面量联合完整性
// ============================================================================

test("T6a. EntryPointType 包含 4 类入口点", () => {
  assert.equal(ENTRY_POINT_TYPES.length, 4);
});

test("T6b. ENTRY_POINT_TYPES 常量顺序正确", () => {
  const expected: ReadonlyArray<EntryPointType> = ["main", "http-route", "scheduled-task", "mq-consumer"];
  assert.deepEqual([...ENTRY_POINT_TYPES], [...expected]);
});

test("T6c. ENTRY_POINT_TYPES 常量已冻结", () => {
  assert.equal(Object.isFrozen(ENTRY_POINT_TYPES), true);
});

// ============================================================================
// T7. EntryPoint 接口字段完整性
// ============================================================================

test("T7. EntryPoint 接口字段完整性", () => {
  const ep: EntryPoint = {
    type: "http-route",
    filePath: "src/interfaces/UserController.ts",
    symbolName: "UserController",
    description: "NestJS @Controller 装饰器声明的用户控制器",
  };
  assert.equal(ep.type, "http-route");
  assert.equal(ep.filePath, "src/interfaces/UserController.ts");
  assert.equal(ep.symbolName, "UserController");
  assert.ok(ep.description.includes("NestJS"));
});

// ============================================================================
// T8. TechStackFingerprint 接口字段完整性
// ============================================================================

test("T8. TechStackFingerprint 接口字段完整性", () => {
  const fp: TechStackFingerprint = {
    languages: ["typescript"],
    frameworks: ["NestJS", "Express"],
    packageManager: "npm",
    dependencyFiles: ["package.json", "tsconfig.json"],
  };
  assert.equal(fp.languages.length, 1);
  assert.equal(fp.languages[0], "typescript");
  assert.equal(fp.frameworks.length, 2);
  assert.equal(fp.packageManager, "npm");
  assert.equal(fp.dependencyFiles.length, 2);
});

test("T8b. TechStackFingerprint packageManager 可选", () => {
  const fp: TechStackFingerprint = {
    languages: ["javascript"],
    frameworks: [],
    dependencyFiles: [],
  };
  assert.equal(fp.packageManager, undefined);
});

// ============================================================================
// T9. LayeredArchitectureParadigm 字面量联合完整性
// ============================================================================

test("T9a. LayeredArchitectureParadigm 包含 5 类范式（含 unknown）", () => {
  const paradigms: LayeredArchitectureParadigm[] = [
    "ddd-layered",
    "clean-architecture",
    "cqrs-es",
    "microservice",
    "unknown",
  ];
  assert.equal(paradigms.length, 5);
});

// ============================================================================
// T10. LayeredArchitecture 接口字段完整性
// ============================================================================

test("T10. LayeredArchitecture 接口字段完整性", () => {
  const arch: LayeredArchitecture = {
    paradigm: "ddd-layered",
    evidence: ["存在 src/domain/ 目录", "存在 src/application/ 目录"],
    confidence: 0.85,
  };
  assert.equal(arch.paradigm, "ddd-layered");
  assert.equal(arch.evidence.length, 2);
  assert.equal(arch.confidence, 0.85);
});

// ============================================================================
// T11. L1GlobalView 接口字段完整性
// ============================================================================

test("T11. L1GlobalView 接口字段完整性", () => {
  const view: L1GlobalView = {
    repositoryMap: {
      rootPath: "/tmp/project",
      directories: [],
      files: [],
      totalFiles: 0,
      totalDirectories: 0,
    },
    entryPoints: [],
    techStackFingerprint: {
      languages: [],
      frameworks: [],
      dependencyFiles: [],
    },
    layeredArchitecture: {
      paradigm: "unknown",
      evidence: [],
      confidence: 0,
    },
  };
  assert.equal(view.repositoryMap.rootPath, "/tmp/project");
  assert.equal(view.entryPoints.length, 0);
  assert.equal(view.techStackFingerprint.languages.length, 0);
  assert.equal(view.layeredArchitecture.paradigm, "unknown");
});

// ============================================================================
// T12. DEFAULT_IGNORED_DIRECTORIES 常量
// ============================================================================

test("T12a. DEFAULT_IGNORED_DIRECTORIES 含 node_modules", () => {
  assert.ok(DEFAULT_IGNORED_DIRECTORIES.includes("node_modules"));
});

test("T12b. DEFAULT_IGNORED_DIRECTORIES 含 .git", () => {
  assert.ok(DEFAULT_IGNORED_DIRECTORIES.includes(".git"));
});

test("T12c. DEFAULT_IGNORED_DIRECTORIES 含 dist", () => {
  assert.ok(DEFAULT_IGNORED_DIRECTORIES.includes("dist"));
});

test("T12d. DEFAULT_IGNORED_DIRECTORIES 含 build", () => {
  assert.ok(DEFAULT_IGNORED_DIRECTORIES.includes("build"));
});

test("T12e. DEFAULT_IGNORED_DIRECTORIES 常量已冻结", () => {
  assert.equal(Object.isFrozen(DEFAULT_IGNORED_DIRECTORIES), true);
});

// ============================================================================
// T13. DEFAULT_IGNORED_EXTENSIONS 常量
// ============================================================================

test("T13a. DEFAULT_IGNORED_EXTENSIONS 含 .png", () => {
  assert.ok(DEFAULT_IGNORED_EXTENSIONS.includes(".png"));
});

test("T13b. DEFAULT_IGNORED_EXTENSIONS 含 .jpg", () => {
  assert.ok(DEFAULT_IGNORED_EXTENSIONS.includes(".jpg"));
});

test("T13c. DEFAULT_IGNORED_EXTENSIONS 含 .svg", () => {
  assert.ok(DEFAULT_IGNORED_EXTENSIONS.includes(".svg"));
});

test("T13d. DEFAULT_IGNORED_EXTENSIONS 含 .pdf", () => {
  assert.ok(DEFAULT_IGNORED_EXTENSIONS.includes(".pdf"));
});

test("T13e. DEFAULT_IGNORED_EXTENSIONS 常量已冻结", () => {
  assert.equal(Object.isFrozen(DEFAULT_IGNORED_EXTENSIONS), true);
});
