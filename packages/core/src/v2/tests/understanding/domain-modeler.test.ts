/**
 * DomainModeler 单元测试（DM-01 ~ DM-12 + DM-07b）
 *
 * 测试覆盖 V2-P3 F-BIZ-02 业务领域建模器的核心能力：
 * - DM-01: TypeScript @Entity 装饰器提取 entity 概念（confidence ≥ 0.9）
 * - DM-02: TypeScript interface XxxProps 提取 value_object 概念（confidence ≥ 0.8）
 * - DM-03: SQL CREATE TABLE 提取 entity 概念（source 含 .sql 路径）
 * - DM-04: SQL FOREIGN KEY 提取 belongs_to 关系（confidence ≥ 0.9）
 * - DM-05: Express app.get("/api/users") 提取 service 概念
 * - DM-06: 嵌套路由 /api/users/:userId/orders 提取 has_many 关系（confidence ≥ 0.85）
 * - DM-07: Spring @GetMapping 提取 service 概念（confidence ≥ 0.85）
 * - DM-07b: Python @app.get("/api/users") 提取 service 概念（confidence ≥ 0.8）
 * - DM-08: Go http.HandleFunc 提取 service 概念（confidence ≥ 0.8）
 * - DM-09: @business-rule 注释提取业务规则（source 含文件路径）
 * - DM-10: 置信度 < 0.75 的条目被过滤
 * - DM-11: persistToGlobalContext 合并语义（重复调用不覆盖）
 * - DM-12: modelFromCodeMap 轻量无 IO 提取（置信度 0.6-0.75）
 *
 * 所有测试使用真实文件系统（mkdtempSync 临时目录隔离），禁止 mock。
 * GlobalContextManager 使用自定义 filePath 避免污染真实 ~/.deepcode/global-context.json。
 *
 * 设计依据：
 * - V2-P3 实施计划 §5.1.1（v1.1 修订 P0-1/P0-2/P0-3/P2-2/P2-3）
 * - V2-P3 架构师审查报告 P0（签名扩展）+ P2-3（Python 路由识别）
 *
 * @module v2/tests/understanding/domain-modeler.test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CodeMapGenerator } from "../../codemap/generator";
import type { CodeMap, FileInfo } from "../../codemap/generator";
import type { ClassInfo, FunctionInfo } from "../../codemap/regex-analyzer";
import { GlobalContextManager } from "../../context/global-context";
import { DomainModeler } from "../../understanding/domain-modeler";
import type { DomainModel } from "../../understanding/domain-modeler";

// ============================================================================
// 辅助工厂
// ============================================================================

/**
 * 创建临时项目目录
 *
 * @returns 临时目录绝对路径
 */
function createTmpProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-dm-test-"));
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
    // 忽略清理失败
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
 * 创建 CodeMapGenerator（配置标准化，输出到临时目录的 .deepcode/）
 *
 * @param projectRoot 项目根
 * @returns CodeMapGenerator 实例
 */
function createGenerator(projectRoot: string): CodeMapGenerator {
  return new CodeMapGenerator({
    projectRoot,
    extensions: [],
    excludeDirs: [],
    maxFileSizeKb: 512,
    incremental: false,
    outputPath: ".deepcode/codemap.json",
  });
}

/**
 * 创建 GlobalContextManager（自定义 filePath，避免污染真实 ~/.deepcode）
 *
 * @param tempDir 临时目录
 * @returns GlobalContextManager 实例
 */
function createGlobalManager(tempDir: string): GlobalContextManager {
  const filePath = path.join(tempDir, "global-context.json");
  return new GlobalContextManager(filePath);
}

/**
 * 构造 ClassInfo 测试桩
 */
function makeClassInfo(overrides: Partial<ClassInfo> = {}): ClassInfo {
  return {
    name: "TestClass",
    type: "class",
    methods: [],
    properties: [],
    startLine: 1,
    endLine: 10,
    ...overrides,
  };
}

/**
 * 构造 FunctionInfo 测试桩
 */
function makeFunctionInfo(overrides: Partial<FunctionInfo> = {}): FunctionInfo {
  return {
    name: "testFn",
    signature: "testFn()",
    params: "",
    returnType: "",
    startLine: 1,
    endLine: 5,
    calls: [],
    ...overrides,
  };
}

/**
 * 构造 FileInfo 测试桩
 */
function makeFileInfo(overrides: Partial<FileInfo> = {}): FileInfo {
  return {
    path: "src/test.ts",
    language: "typescript",
    classes: [],
    functions: [],
    imports: [],
    exports: [],
    lines: 10,
    parseStatus: "ok",
    dependencies: [],
    ...overrides,
  };
}

/**
 * 构造 CodeMap 测试桩（用于 modelFromCodeMap 测试，避免触发真实扫描）
 *
 * @param projectRoot 项目根
 * @param architecture 架构类型（默认 unknown）
 * @param files 文件列表（默认空数组）
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

// ----------------------------------------------------------------------------
// DM-01: TypeScript @Entity 装饰器提取 entity 概念
// ----------------------------------------------------------------------------

test("DM-01: 从 TypeScript @Entity 装饰器提取概念（confidence ≥ 0.9）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(
      dir,
      "src/User.ts",
      [
        "import { Entity, PrimaryColumn } from 'typeorm';",
        "",
        "@Entity()",
        "export class UserEntity {",
        "  @PrimaryColumn()",
        "  id: string;",
        "  name: string;",
        "}",
        "",
      ].join("\n")
    );

    const generator = createGenerator(dir);
    const globalManager = createGlobalManager(dir);
    const modeler = new DomainModeler(generator, globalManager);

    const model = await modeler.model(dir);

    // 验证存在 entity 类型的 User 概念
    const userConcept = model.concepts.find((c) => c.name === "UserEntity");
    assert.ok(userConcept, `concepts 应含 UserEntity，实际：${model.concepts.map((c) => c.name).join(",")}`);
    assert.equal(userConcept!.type, "entity");
    assert.ok(
      userConcept!.confidence >= 0.9,
      `confidence 应 ≥ 0.9（类名后缀 + 装饰器双重匹配），实际：${userConcept!.confidence}`
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

// ----------------------------------------------------------------------------
// DM-02: TypeScript interface XxxProps 提取 value_object 概念
// ----------------------------------------------------------------------------

test("DM-02: 从 TypeScript interface XxxProps 提取值对象（confidence ≥ 0.8）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(
      dir,
      "src/UserProps.ts",
      ["export interface UserProps {", "  id: string;", "  name: string;", "}", ""].join("\n")
    );

    const generator = createGenerator(dir);
    const globalManager = createGlobalManager(dir);
    const modeler = new DomainModeler(generator, globalManager);

    const model = await modeler.model(dir);

    // 验证存在 value_object 类型的 UserProps 概念
    const propsConcept = model.concepts.find((c) => c.name === "UserProps");
    assert.ok(propsConcept, `concepts 应含 UserProps，实际：${model.concepts.map((c) => c.name).join(",")}`);
    assert.equal(propsConcept!.type, "value_object");
    assert.ok(
      propsConcept!.confidence >= 0.8,
      `confidence 应 ≥ 0.8（interface + 后缀双重匹配），实际：${propsConcept!.confidence}`
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

// ----------------------------------------------------------------------------
// DM-03: SQL CREATE TABLE 提取 entity 概念
// ----------------------------------------------------------------------------

test("DM-03: 从 SQL CREATE TABLE 提取概念（source 含 .sql 文件路径）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(
      dir,
      "migrations/001_init.sql",
      ["CREATE TABLE users (", "  id VARCHAR(36) PRIMARY KEY,", "  name VARCHAR(255) NOT NULL", ");", ""].join("\n")
    );

    const generator = createGenerator(dir);
    const globalManager = createGlobalManager(dir);
    const modeler = new DomainModeler(generator, globalManager);

    const model = await modeler.model(dir);

    // 验证存在从 SQL 提取的 User 概念（users → User 单数化）
    const userConcept = model.concepts.find((c) => c.name === "User");
    assert.ok(
      userConcept,
      `concepts 应含 User（从 users 表提取），实际：${model.concepts.map((c) => c.name).join(",")}`
    );
    assert.equal(userConcept!.type, "entity");
    assert.ok(userConcept!.source.includes(".sql"), `source 应含 .sql 文件路径，实际：${userConcept!.source}`);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ----------------------------------------------------------------------------
// DM-04: SQL FOREIGN KEY 提取 belongs_to 关系
// ----------------------------------------------------------------------------

test("DM-04: 从 SQL FOREIGN KEY 提取 belongs_to 关系（confidence ≥ 0.9）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(
      dir,
      "migrations/001_init.sql",
      [
        "CREATE TABLE users (",
        "  id VARCHAR(36) PRIMARY KEY",
        ");",
        "",
        "CREATE TABLE orders (",
        "  id VARCHAR(36) PRIMARY KEY,",
        "  user_id VARCHAR(36) NOT NULL,",
        "  FOREIGN KEY (user_id) REFERENCES users(id)",
        ");",
        "",
      ].join("\n")
    );

    const generator = createGenerator(dir);
    const globalManager = createGlobalManager(dir);
    const modeler = new DomainModeler(generator, globalManager);

    const model = await modeler.model(dir);

    // 验证存在 belongs_to 关系：order → user
    const belongsToRel = model.relations.find(
      (r) => r.type === "belongs_to" && r.source === "order" && r.target === "user"
    );
    assert.ok(belongsToRel, `relations 应含 belongs_to（order → user），实际：${JSON.stringify(model.relations)}`);
    assert.ok(belongsToRel!.confidence >= 0.9, `confidence 应 ≥ 0.9，实际：${belongsToRel!.confidence}`);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ----------------------------------------------------------------------------
// DM-05: Express app.get("/api/users") 提取 service 概念
// ----------------------------------------------------------------------------

test("DM-05: 从 Express app.get('/api/users') 提取 service", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(
      dir,
      "src/routes.ts",
      [
        "import express from 'express';",
        "const app = express();",
        "",
        "app.get('/api/users', (req, res) => {",
        "  res.json([]);",
        "});",
        "",
      ].join("\n")
    );

    const generator = createGenerator(dir);
    const globalManager = createGlobalManager(dir);
    const modeler = new DomainModeler(generator, globalManager);

    const model = await modeler.model(dir);

    // 验证存在 service 类型的 Users 概念
    const usersService = model.concepts.find((c) => c.type === "service" && c.name === "Users");
    assert.ok(
      usersService,
      `concepts 应含 service 类型 Users，实际：${model.concepts.map((c) => `${c.name}(${c.type})`).join(",")}`
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

// ----------------------------------------------------------------------------
// DM-06: 嵌套路由 /api/users/:userId/orders 提取 has_many 关系
// ----------------------------------------------------------------------------

test("DM-06: 从嵌套路由 /api/users/:userId/orders 提取 has_many（confidence ≥ 0.85）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(
      dir,
      "src/routes.ts",
      [
        "import express from 'express';",
        "const app = express();",
        "",
        "app.get('/api/users/:userId/orders', (req, res) => {",
        "  res.json([]);",
        "});",
        "",
      ].join("\n")
    );

    const generator = createGenerator(dir);
    const globalManager = createGlobalManager(dir);
    const modeler = new DomainModeler(generator, globalManager);

    const model = await modeler.model(dir);

    // 验证存在 has_many 关系：user → order（单数化）
    const hasManyRel = model.relations.find(
      (r) => r.type === "has_many" && r.source === "user" && r.target === "order"
    );
    assert.ok(hasManyRel, `relations 应含 has_many（user → order），实际：${JSON.stringify(model.relations)}`);
    assert.ok(hasManyRel!.confidence >= 0.85, `confidence 应 ≥ 0.85，实际：${hasManyRel!.confidence}`);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ----------------------------------------------------------------------------
// DM-07: Spring @GetMapping 提取 service 概念
// ----------------------------------------------------------------------------

test("DM-07: 从 Spring @GetMapping 提取 service（confidence ≥ 0.85）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(
      dir,
      "src/UserController.java",
      [
        "package com.example;",
        "",
        "import org.springframework.web.bind.annotation.GetMapping;",
        "import org.springframework.web.bind.annotation.RestController;",
        "",
        "@RestController",
        "public class UserController {",
        '  @GetMapping("/api/users")',
        "  public String getUsers() {",
        '    return "users";',
        "  }",
        "}",
        "",
      ].join("\n")
    );

    const generator = createGenerator(dir);
    const globalManager = createGlobalManager(dir);
    const modeler = new DomainModeler(generator, globalManager);

    const model = await modeler.model(dir);

    // 验证存在 service 类型的 Users 概念（confidence ≥ 0.85）
    const usersService = model.concepts.find((c) => c.type === "service" && c.name === "Users");
    assert.ok(
      usersService,
      `concepts 应含 service 类型 Users，实际：${model.concepts.map((c) => `${c.name}(${c.type})`).join(",")}`
    );
    assert.ok(
      usersService!.confidence >= 0.85,
      `confidence 应 ≥ 0.85（Spring 强类型装饰器），实际：${usersService!.confidence}`
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

// ----------------------------------------------------------------------------
// DM-07b: Python @app.get("/api/users") 提取 service 概念
// ----------------------------------------------------------------------------

test("DM-07b: 从 Python @app.get('/api/users') 提取 service（confidence ≥ 0.8）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(
      dir,
      "src/app.py",
      [
        "from fastapi import FastAPI",
        "app = FastAPI()",
        "",
        "@app.get('/api/users')",
        "def get_users():",
        "    return []",
        "",
      ].join("\n")
    );

    const generator = createGenerator(dir);
    const globalManager = createGlobalManager(dir);
    const modeler = new DomainModeler(generator, globalManager);

    const model = await modeler.model(dir);

    // 验证存在 service 类型的 Users 概念
    const usersService = model.concepts.find((c) => c.type === "service" && c.name === "Users");
    assert.ok(
      usersService,
      `concepts 应含 service 类型 Users，实际：${model.concepts.map((c) => `${c.name}(${c.type})`).join(",")}`
    );
    assert.ok(usersService!.confidence >= 0.8, `confidence 应 ≥ 0.8，实际：${usersService!.confidence}`);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ----------------------------------------------------------------------------
// DM-08: Go http.HandleFunc 提取 service 概念
// ----------------------------------------------------------------------------

test("DM-08: 从 Go http.HandleFunc 提取 service（confidence ≥ 0.8）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(
      dir,
      "src/main.go",
      [
        "package main",
        "",
        "import (",
        '  "net/http"',
        ")",
        "",
        "func main() {",
        '  http.HandleFunc("/api/users", func(w http.ResponseWriter, r *http.Request) {',
        '    w.Write([]byte("users"))',
        "  })",
        "}",
        "",
      ].join("\n")
    );

    const generator = createGenerator(dir);
    const globalManager = createGlobalManager(dir);
    const modeler = new DomainModeler(generator, globalManager);

    const model = await modeler.model(dir);

    // 验证存在 service 类型的 Users 概念
    const usersService = model.concepts.find((c) => c.type === "service" && c.name === "Users");
    assert.ok(
      usersService,
      `concepts 应含 service 类型 Users，实际：${model.concepts.map((c) => `${c.name}(${c.type})`).join(",")}`
    );
    assert.ok(usersService!.confidence >= 0.8, `confidence 应 ≥ 0.8，实际：${usersService!.confidence}`);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ----------------------------------------------------------------------------
// DM-09: @business-rule 注释提取业务规则
// ----------------------------------------------------------------------------

test("DM-09: 从 @business-rule 注释提取业务规则（source 含文件路径）", async () => {
  const dir = createTmpProjectDir();
  try {
    writeFile(
      dir,
      "src/validators.ts",
      [
        "// @business-rule: 用户名长度必须大于 3",
        "export function validateUsername(name: string): boolean {",
        "  return name.length > 3;",
        "}",
        "",
      ].join("\n")
    );

    const generator = createGenerator(dir);
    const globalManager = createGlobalManager(dir);
    const modeler = new DomainModeler(generator, globalManager);

    const model = await modeler.model(dir);

    // 验证存在业务规则
    const rule = model.rules.find((r) => r.rule.includes("用户名长度"));
    assert.ok(rule, `rules 应含用户名长度规则，实际：${model.rules.map((r) => r.rule).join(",")}`);
    assert.ok(rule!.source.includes("validators.ts"), `source 应含文件路径，实际：${rule!.source}`);
    assert.ok(rule!.confidence >= 0.75, `confidence 应 ≥ 0.75，实际：${rule!.confidence}`);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ----------------------------------------------------------------------------
// DM-10: 置信度 < 0.75 的条目被过滤
// ----------------------------------------------------------------------------

test("DM-10: 置信度 < 0.75 的条目被过滤", async () => {
  const dir = createTmpProjectDir();
  try {
    // 构造一个综合项目：含高置信度 + 低置信度信号
    // - UserEntity（@Entity 装饰器，confidence 0.9）→ 通过过滤
    // - @business-rule 注释（confidence 0.85）→ 通过过滤
    // - 普通 class Foo（无后缀无装饰器，不识别，根本不进入过滤）
    writeFile(
      dir,
      "src/User.ts",
      [
        "import { Entity } from 'typeorm';",
        "",
        "@Entity()",
        "export class UserEntity {",
        "  id: string;",
        "}",
        "",
        "// 普通类，无后缀无装饰器",
        "export class Foo {",
        "  bar: string;",
        "}",
        "",
        "// @business-rule: 订单金额必须大于 0",
        "export function validateAmount(amt: number): boolean {",
        "  return amt > 0;",
        "}",
        "",
      ].join("\n")
    );

    const generator = createGenerator(dir);
    const globalManager = createGlobalManager(dir);
    const modeler = new DomainModeler(generator, globalManager);

    const model = await modeler.model(dir);

    // 验证所有 concepts 的 confidence ≥ 0.75
    for (const c of model.concepts) {
      assert.ok(c.confidence >= 0.75, `concept ${c.name} confidence 应 ≥ 0.75，实际：${c.confidence}`);
    }
    // 验证所有 relations 的 confidence ≥ 0.75
    for (const r of model.relations) {
      assert.ok(r.confidence >= 0.75, `relation ${r.source}->${r.target} confidence 应 ≥ 0.75，实际：${r.confidence}`);
    }
    // 验证所有 rules 的 confidence ≥ 0.75
    for (const r of model.rules) {
      assert.ok(r.confidence >= 0.75, `rule "${r.rule}" confidence 应 ≥ 0.75，实际：${r.confidence}`);
    }
    // 验证 Foo（普通类无后缀无装饰器）不被识别
    const fooConcept = model.concepts.find((c) => c.name === "Foo");
    assert.equal(fooConcept, undefined, "普通类 Foo 不应被识别为概念");
  } finally {
    cleanupTmpDir(dir);
  }
});

// ----------------------------------------------------------------------------
// DM-11: persistToGlobalContext 合并语义（重复调用不覆盖）
// ----------------------------------------------------------------------------

test("DM-11: persistToGlobalContext 写入 GlobalContext.domainKnowledge（合并语义，重复调用不覆盖）", async () => {
  const dir = createTmpProjectDir();
  try {
    const generator = createGenerator(dir);
    const globalManager = createGlobalManager(dir);
    const modeler = new DomainModeler(generator, globalManager);

    // 构造第一个 DomainModel
    const model1: DomainModel = {
      concepts: [
        {
          id: "user",
          name: "User",
          type: "entity",
          source: "src/User.ts",
          description: "首次描述",
          properties: ["id", "name"],
          confidence: 0.9,
        },
      ],
      relations: [
        {
          source: "order",
          target: "user",
          type: "belongs_to",
          confidence: 0.9,
        },
      ],
      rules: [
        {
          id: "rule-1",
          rule: "用户名必填",
          source: "src/User.ts",
          confidence: 0.85,
        },
      ],
      knowledgeGraph: {
        nodes: [{ id: "user", label: "User", type: "entity", properties: {} }],
        edges: [{ source: "order", target: "user", relation: "belongs_to", weight: 0.9 }],
      },
    };

    // 第一次持久化
    await modeler.persistToGlobalContext("default", model1);

    // 验证第一次写入成功
    const ctx1 = globalManager.load("default");
    assert.equal(ctx1.domainKnowledge.conceptLibrary.length, 1, "首次写入应含 1 个 concept");
    assert.equal(ctx1.domainKnowledge.conceptLibrary[0]!.id, "user");
    assert.equal(ctx1.domainKnowledge.conceptLibrary[0]!.description, "首次描述");
    assert.equal(ctx1.domainKnowledge.knowledgeGraph.nodes.length, 1, "首次写入应含 1 个 node");
    assert.equal(ctx1.domainKnowledge.knowledgeGraph.edges.length, 1, "首次写入应含 1 个 edge");
    assert.equal(ctx1.domainKnowledge.ruleLibrary.length, 1, "首次写入应含 1 个 rule");

    // 构造第二个 DomainModel（含相同 id 的 concept，描述不同）
    const model2: DomainModel = {
      concepts: [
        {
          id: "user",
          name: "User",
          type: "entity",
          source: "src/User.ts",
          description: "二次描述（应被忽略）",
          properties: [],
          confidence: 0.9,
        },
        {
          id: "order",
          name: "Order",
          type: "entity",
          source: "src/Order.ts",
          description: "新增订单概念",
          properties: [],
          confidence: 0.85,
        },
      ],
      relations: [
        {
          source: "order",
          target: "user",
          type: "belongs_to",
          confidence: 0.9,
        },
      ],
      rules: [
        {
          id: "rule-1",
          rule: "用户名必填（应被忽略）",
          source: "src/User.ts",
          confidence: 0.85,
        },
        {
          id: "rule-2",
          rule: "订单金额必填",
          source: "src/Order.ts",
          confidence: 0.85,
        },
      ],
      knowledgeGraph: {
        nodes: [
          { id: "user", label: "User", type: "entity", properties: {} },
          { id: "order", label: "Order", type: "entity", properties: {} },
        ],
        edges: [{ source: "order", target: "user", relation: "belongs_to", weight: 0.9 }],
      },
    };

    // 第二次持久化（合并语义）
    await modeler.persistToGlobalContext("default", model2);

    // 验证合并语义
    const ctx2 = globalManager.load("default");

    // conceptLibrary：按 id 去重，已存在的不覆盖
    assert.equal(ctx2.domainKnowledge.conceptLibrary.length, 2, "合并后应含 2 个 concept（user + order）");
    const userConcept = ctx2.domainKnowledge.conceptLibrary.find((c) => c.id === "user");
    assert.ok(userConcept, "应含 user concept");
    assert.equal(userConcept!.description, "首次描述", "已存在的 concept 不应被覆盖，应保留首次值");

    // knowledgeGraph.nodes：按 id 去重
    assert.equal(ctx2.domainKnowledge.knowledgeGraph.nodes.length, 2, "合并后应含 2 个 node（user + order）");

    // knowledgeGraph.edges：追加（不去重，允许同一关系多次记录）
    assert.equal(
      ctx2.domainKnowledge.knowledgeGraph.edges.length,
      2,
      "edges 应追加（不去重），合并后应含 2 条 edge（两次 belongs_to）"
    );

    // ruleLibrary：按 id 去重
    assert.equal(ctx2.domainKnowledge.ruleLibrary.length, 2, "合并后应含 2 个 rule（rule-1 + rule-2）");
    const rule1 = ctx2.domainKnowledge.ruleLibrary.find((r) => r.id === "rule-1");
    assert.ok(rule1, "应含 rule-1");
    assert.equal(rule1!.rule, "用户名必填", "已存在的 rule 不应被覆盖");
  } finally {
    cleanupTmpDir(dir);
  }
});

// ----------------------------------------------------------------------------
// DM-12: modelFromCodeMap 轻量无 IO 提取（置信度 0.6-0.75）
// ----------------------------------------------------------------------------

test("DM-12: modelFromCodeMap 轻量无 IO 提取（不触发 CodeMap 扫描，置信度 0.6-0.75）", () => {
  const dir = createTmpProjectDir();
  try {
    // 手动构造 CodeMap（不调用 generateFullMap，避免触发真实扫描）
    // 含 UserEntity 类（如果读取原始文件会发现 @Entity 装饰器，confidence 0.9）
    // 但 modelFromCodeMap 不读取原始文件，所以 confidence 应为 0.75（仅后缀）
    const codeMap = createCodeMap(dir, "unknown", [
      makeFileInfo({
        path: "src/User.ts",
        language: "typescript",
        classes: [
          makeClassInfo({
            name: "UserEntity",
            type: "class",
            properties: ["id", "name"],
            startLine: 1,
            endLine: 10,
          }),
        ],
      }),
      makeFileInfo({
        path: "src/OrderProps.ts",
        language: "typescript",
        classes: [
          makeClassInfo({
            name: "OrderProps",
            type: "interface",
            properties: ["id", "amount"],
            startLine: 1,
            endLine: 5,
          }),
        ],
      }),
      makeFileInfo({
        path: "src/UserService.ts",
        language: "typescript",
        functions: [
          makeFunctionInfo({
            name: "createUser",
            signature: "createUser()",
            startLine: 1,
            endLine: 5,
          }),
        ],
      }),
    ]);

    const generator = createGenerator(dir);
    const globalManager = createGlobalManager(dir);
    const modeler = new DomainModeler(generator, globalManager);

    // 调用 modelFromCodeMap（无 IO，不触发 generateFullMap）
    const model = modeler.modelFromCodeMap(codeMap);

    // 验证基于类名后缀提取的概念（confidence 0.75）
    const userEntity = model.concepts.find((c) => c.name === "UserEntity");
    assert.ok(userEntity, `应含 UserEntity 概念，实际：${model.concepts.map((c) => c.name).join(",")}`);
    assert.equal(userEntity!.type, "entity");
    assert.equal(
      userEntity!.confidence,
      0.75,
      `modelFromCodeMap 类名后缀匹配 confidence 应为 0.75，实际：${userEntity!.confidence}`
    );

    // 验证 interface 类型提取（confidence 0.7）
    const orderProps = model.concepts.find((c) => c.name === "OrderProps");
    assert.ok(orderProps, `应含 OrderProps 概念，实际：${model.concepts.map((c) => c.name).join(",")}`);
    assert.equal(orderProps!.type, "value_object");
    assert.equal(
      orderProps!.confidence,
      0.7,
      `modelFromCodeMap interface confidence 应为 0.7，实际：${orderProps!.confidence}`
    );

    // 验证函数名前缀提取 service 概念（confidence 0.6）
    const userService = model.concepts.find((c) => c.name === "User");
    assert.ok(
      userService,
      `应含 User service 概念（从 createUser 提取），实际：${model.concepts.map((c) => c.name).join(",")}`
    );
    assert.equal(userService!.type, "service");
    assert.equal(
      userService!.confidence,
      0.6,
      `modelFromCodeMap 函数名前缀 confidence 应为 0.6，实际：${userService!.confidence}`
    );

    // 验证所有 confidence 在 0.6-0.75 范围内
    for (const c of model.concepts) {
      assert.ok(
        c.confidence >= 0.6 && c.confidence <= 0.75,
        `concept ${c.name} confidence 应在 0.6-0.75 范围内，实际：${c.confidence}`
      );
    }

    // 验证轻量模式不提取 relations 和 rules（无 IO 推断不到）
    assert.equal(model.relations.length, 0, "轻量模式不应提取 relations");
    assert.equal(model.rules.length, 0, "轻量模式不应提取 rules");
  } finally {
    cleanupTmpDir(dir);
  }
});
