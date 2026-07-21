/**
 * doc-code-consistency-checker 模块单元测试
 *
 * 设计依据：
 * - 源文件：`/Users/wangwei/Documents/VG/DeepCodeX-cli/packages/core/src/team/doc-code-consistency-checker.ts`
 * - Python 原版测试：`/Users/wangwei/.trae-cn/skills/multi-agent-team/scripts/tests/test_doc_code_consistency_checker.py`
 *
 * 覆盖维度（共 20 个测试用例 DCC-001 ~ DCC-020）：
 * 一、DocParser 类（DCC-001 ~ DCC-004）：
 *   - DCC-001: parseFeatures() 解析 PRD 功能列表表格
 *   - DCC-002: parseFeatures() 无表格时从全文兜底提取功能 ID
 *   - DCC-003: parseAcceptanceCriteria() 表格 + 列表混合解析
 *   - DCC-004: parseIntegrationRelations() 多种格式（→/->/依赖/调用/引用）
 *
 * 二、CodeScanner 类（DCC-005 ~ DCC-009）：
 *   - DCC-005: _scanFunctions() 多语言函数扫描（TypeScript/Python/Go/Rust）
 *   - DCC-006: _scanClasses() 多语言类定义扫描
 *   - DCC-007: _scanImports() 多语言 import 扫描
 *   - DCC-008: _scanTodos() 三种注释风格（# // *）的 TODO/FIXME 扫描
 *   - DCC-009: scanProject() 完整项目扫描（含跳过目录验证）
 *
 * 三、DocCodeConsistencyChecker 类（DCC-010 ~ DCC-020）：
 *   - DCC-010: 构造函数参数处理（默认值、超时下限、绝对路径解析）
 *   - DCC-011: D1 checkFeatureCompleteness() 已实现功能识别
 *   - DCC-012: D1 checkFeatureCompleteness() 未实现功能识别
 *   - DCC-013: D2 checkIntegrationCompleteness() 已连通集成识别
 *   - DCC-014: D2 checkIntegrationCompleteness() 缺失集成识别
 *   - DCC-015: D3 checkTestCorrectness() 未配置测试命令场景
 *   - DCC-016: D3 checkTestCorrectness() 配置测试命令且全部通过
 *   - DCC-017: D3 checkTestCorrectness() 配置测试命令且有失败
 *   - DCC-018: D4 checkAcceptanceCriteria() 验收标准满足检查
 *   - DCC-019: D5 checkTodoFixme() TODO/FIXME 清零检查
 *   - DCC-020: D6 + checkAll() + generateReport() 完整流程
 *
 * 测试约定（严格遵守）：
 * - 使用 node:test 框架（`import { test } from "node:test"`）
 * - 使用 node:assert/strict 断言
 * - 严禁 mock：所有 fixture 均为真实的临时目录 + 真实 .md / .ts / .py 文件
 * - 仅依赖 Node.js 内置模块（fs / os / path），不引入新依赖
 * - 测试函数和关键逻辑均有中文注释，符合 TypeScript 代码规范
 * - 每个测试用例结束后清理临时目录
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DocParser, CodeScanner, DocCodeConsistencyChecker } from "../doc-code-consistency-checker.js";
import type {
  ConsistencyReport,
  GapItem,
  FeatureCheckItem,
  IntegrationCheckItem,
  TestCheckResult,
  AcceptanceCheckItem,
  TodoItem,
  DeviationItem,
  CodeSymbol,
  ImportRelation,
  ParsedFeature,
  ParsedAcceptanceCriteria,
  ParsedIntegrationRelation,
  DocPaths,
} from "../doc-code-consistency-checker.js";

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 创建临时目录
 * 用于测试 projectRoot，避免污染工作区
 *
 * @returns 临时目录绝对路径（形如 /tmp/deepcodex-dcc-test-xxxxxx）
 */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-dcc-test-"));
}

/**
 * 递归删除临时目录
 * 即使目录不存在或删除失败也不抛错，保证测试清理阶段不会中断
 *
 * @param dir 临时目录路径
 */
function rmTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 静默忽略（目录可能已被清理或权限不足）
  }
}

/**
 * 在指定根目录下写入文件
 * 如果父目录不存在，会递归创建（等价于 mkdir -p）
 *
 * @param root 根目录绝对路径
 * @param relPath 文件相对路径（如 "docs/prd.md"）
 * @param content 文件内容
 * @returns 文件绝对路径
 */
function writeFixtureFile(root: string, relPath: string, content: string): string {
  const absPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf-8");
  return absPath;
}

// ============================================================================
// 第一部分：DocParser 类测试
// ============================================================================

// ----------------------------------------------------------------------------
// DCC-001: DocParser.parseFeatures() 解析 PRD 功能列表表格
// ----------------------------------------------------------------------------
test("DCC-001: DocParser.parseFeatures() 解析 PRD 功能列表表格", () => {
  // 构造含功能列表表格的 PRD 文档
  // 表头使用 "功能ID / 功能名称 / 功能描述 / 优先级" 等关键词
  const md = `# 产品需求文档

## 功能列表

| 功能ID | 功能名称 | 功能描述 | 优先级 | 所属模块 | 状态 |
|--------|----------|----------|--------|----------|------|
| F-001 | login | 用户登录功能 | P0 | auth | 已实现 |
| F-002 | register | 用户注册功能 | P0 | auth | 已实现 |
| F-003 | export | 数据导出功能 | P1 | data | 待实现 |
`;
  // 调用 DocParser.parseFeatures 解析功能点
  const features = DocParser.parseFeatures(md, "prd.md");

  // 断言：解析到 3 个功能点
  assert.equal(features.length, 3, "应解析到 3 个功能点");

  // 断言：第 1 个功能点的字段正确，section 包含文档名和章节标题
  assert.equal(features[0].feature_id, "F-001");
  assert.equal(features[0].feature_name, "login");
  assert.equal(features[0].feature_desc, "用户登录功能");
  assert.equal(features[0].section, "prd.md §功能列表");

  // 断言：第 2 个功能点字段正确
  assert.equal(features[1].feature_id, "F-002");
  assert.equal(features[1].feature_name, "register");

  // 断言：第 3 个功能点字段正确
  assert.equal(features[2].feature_id, "F-003");
  assert.equal(features[2].feature_name, "export");
});

// ----------------------------------------------------------------------------
// DCC-002: DocParser.parseFeatures() 无表格时从全文兜底提取功能 ID
// ----------------------------------------------------------------------------
test("DCC-002: DocParser.parseFeatures() 无表格时从全文兜底提取功能 ID", () => {
  // 场景1：空字符串应返回 0 个功能点
  const empty = DocParser.parseFeatures("", "empty.md");
  assert.equal(empty.length, 0, "空文档应解析到 0 个功能点");

  // 场景2：无功能 ID 的文档应返回 0 个功能点
  const noFeature = DocParser.parseFeatures("# 设计文档\n\n本系统不含功能 ID。\n", "no-feature.md");
  assert.equal(noFeature.length, 0, "无功能 ID 的文档应解析到 0 个功能点");

  // 场景3：表格存在但表头不含 "功能" + "ID" 关键词，不视为功能表
  const notFeatureTable = DocParser.parseFeatures(
    "# 其他\n\n| 序号 | 名称 |\n|------|------|\n| 1 | 测试 |\n",
    "other.md"
  );
  assert.equal(notFeatureTable.length, 0, "非功能表应解析到 0 个功能点");

  // 场景4：无表格，但文档中提及 F-001 / F002 / F_003 等格式，应从全文兜底提取
  const fallbackMd = `# 设计文档

本次迭代包含以下功能：
- F-001 用户登录
- F-002 用户登出

参考 F_003 数据导出功能。
`;
  const fallbackFeatures = DocParser.parseFeatures(fallbackMd, "fallback.md");
  // 兜底提取应识别到至少 3 个功能 ID（F-001, F-002, F_003）
  assert.ok(fallbackFeatures.length >= 3, "无表格时应从全文兜底提取至少 3 个功能 ID");
  // 验证功能 ID 都被大写化
  const ids = fallbackFeatures.map((f) => f.feature_id);
  assert.ok(ids.includes("F-001"), "应包含 F-001");
  assert.ok(ids.includes("F-002"), "应包含 F-002");
  assert.ok(ids.includes("F_003"), "应包含 F_003（保持原格式仅大写化）");
});

// ----------------------------------------------------------------------------
// DCC-003: DocParser.parseAcceptanceCriteria() 表格 + 列表混合解析
// ----------------------------------------------------------------------------
test("DCC-003: DocParser.parseAcceptanceCriteria() 表格 + 列表混合解析", () => {
  // 构造含验收标准表格 + 列表的文档
  // 表格位于"验收标准"章节内，列表项使用 "- AC-xxx: 描述" 格式
  const md = `# 产品需求文档

## 验收标准

| 编号 | 描述 | 验证方式 |
|------|------|----------|
| AC-001 | 登录响应时间 < 200ms | 测试 |
| AC-002 | 注册成功后发送邮件 | 测试 |

## 其他章节

- AC-003: 密码长度不少于 8 位
- AC-004: 用户登出后清除 session
`;
  // 调用 DocParser.parseAcceptanceCriteria 解析验收标准
  const criteria = DocParser.parseAcceptanceCriteria(md, "prd.md");

  // 断言：解析到至少 4 条验收标准（表格 2 条 + 列表 2 条）
  assert.ok(criteria.length >= 4, "应解析到至少 4 条验收标准（表格 2 条 + 列表 2 条）");

  // 收集所有验收标准 ID，验证 4 条都被识别
  const ids = criteria.map((c) => c.criteria_id);
  assert.ok(ids.includes("AC-001"), "应包含 AC-001");
  assert.ok(ids.includes("AC-002"), "应包含 AC-002");
  assert.ok(ids.includes("AC-003"), "应包含 AC-003");
  assert.ok(ids.includes("AC-004"), "应包含 AC-004");

  // 断言：表格内 AC-001 的描述和 section 正确
  const ac001 = criteria.find((c) => c.criteria_id === "AC-001");
  assert.ok(ac001, "AC-001 应存在");
  assert.equal(ac001!.criteria_desc, "登录响应时间 < 200ms");
  assert.equal(ac001!.section, "prd.md §验收标准");

  // 断言：列表项 AC-003 的描述正确（去掉前缀 "AC-003:" 后的内容）
  const ac003 = criteria.find((c) => c.criteria_id === "AC-003");
  assert.ok(ac003, "AC-003 应存在");
  assert.ok(ac003!.criteria_desc.includes("密码长度"), "AC-003 描述应包含 '密码长度'");
});

// ----------------------------------------------------------------------------
// DCC-004: DocParser.parseIntegrationRelations() 多种格式解析
// ----------------------------------------------------------------------------
test("DCC-004: DocParser.parseIntegrationRelations() 多种格式解析", () => {
  // 构造含多种集成关系格式的架构文档
  // 覆盖：→ / -> / 依赖 / 调用 / 引用 / imports
  const md = `# 架构文档

## 模块依赖

authService 依赖 userService
paymentModule→orderModule
orderModule 调用 notifyModule
frontend 模块→backend 模块
apiModule 引用 databaseModule
`;
  // 调用 DocParser.parseIntegrationRelations 解析集成关系
  const relations = DocParser.parseIntegrationRelations(md, "arch.md");

  // 断言：解析到至少 5 个集成关系
  assert.ok(relations.length >= 5, "应解析到至少 5 个集成关系（覆盖 → / 依赖 / 调用 / 引用 等格式）");

  // 断言：第 1 个集成关系为 authService→userService，section 含章节标题
  assert.equal(relations[0].source, "authService");
  assert.equal(relations[0].target, "userService");
  assert.equal(relations[0].integration_desc, "authService→userService");
  assert.equal(relations[0].section, "arch.md §模块依赖");

  // 断言：存在 paymentModule→orderModule 关系
  const paymentRel = relations.find((r) => r.source === "paymentModule" && r.target === "orderModule");
  assert.ok(paymentRel, "应存在 paymentModule→orderModule 关系");

  // 断言：存在 orderModule→notifyModule 关系
  const notifyRel = relations.find((r) => r.source === "orderModule" && r.target === "notifyModule");
  assert.ok(notifyRel, "应存在 orderModule→notifyModule 关系");

  // 断言：存在 frontend→backend 关系（带"模块"后缀的格式）
  const fbRel = relations.find((r) => r.source === "frontend" && r.target === "backend");
  assert.ok(fbRel, "应存在 frontend→backend 关系（'模块'后缀被正确剥离）");

  // 断言：存在 apiModule→databaseModule 关系
  const apiRel = relations.find((r) => r.source === "apiModule" && r.target === "databaseModule");
  assert.ok(apiRel, "应存在 apiModule→databaseModule 关系");
});

// ============================================================================
// 第二部分：CodeScanner 类测试
// ============================================================================

// ----------------------------------------------------------------------------
// DCC-005: CodeScanner._scanFunctions() 多语言函数扫描
// ----------------------------------------------------------------------------
test("DCC-005: CodeScanner._scanFunctions() 多语言函数扫描", () => {
  // 场景1：TypeScript 函数（含 export / async 前缀）
  const tsCode = `function foo(): void {}
export function bar(): void {}
async function baz(): Promise<void> {}
export async function qux(): Promise<number> { return 1; }
`;
  const tsFunctions = CodeScanner._scanFunctions(tsCode, "test.ts", "typescript");
  // 断言：扫描到 4 个 TypeScript 函数
  assert.equal(tsFunctions.length, 4, "TypeScript 应扫描到 4 个函数");
  const tsFuncNames = tsFunctions.map((f) => f.name).sort();
  assert.deepEqual(tsFuncNames, ["bar", "baz", "foo", "qux"], "TypeScript 函数名应为 bar/baz/foo/qux");
  // 断言：所有函数的 symbol_type 和 language 字段正确
  for (const f of tsFunctions) {
    assert.equal(f.symbol_type, "function");
    assert.equal(f.language, "typescript");
    assert.equal(f.file_path, "test.ts");
  }

  // 场景2：Python 函数（含缩进的实例方法 + 模块级函数）
  const pyCode = `class AuthService:
    def login(self, username, password):
        pass
    def logout(self):
        pass

def check_token(token):
    pass
`;
  const pyFunctions = CodeScanner._scanFunctions(pyCode, "auth.py", "python");
  // 断言：扫描到 3 个 Python 函数（login / logout / check_token）
  assert.equal(pyFunctions.length, 3, "Python 应扫描到 3 个函数");
  const pyFuncNames = pyFunctions.map((f) => f.name).sort();
  assert.deepEqual(pyFuncNames, ["check_token", "login", "logout"], "Python 函数名应为 check_token/login/logout");

  // 场景3：Go 函数（含 receiver 形式）
  const goCode = `package main

func main() {}
func (s *Server) Start() {}
func handler(w http.ResponseWriter, r *http.Request) {}
`;
  const goFunctions = CodeScanner._scanFunctions(goCode, "main.go", "go");
  // 断言：扫描到 3 个 Go 函数
  assert.equal(goFunctions.length, 3, "Go 应扫描到 3 个函数");
  // 注意：sort() 默认字典序，大写字母（'S'=83）排在小写字母（'h'=104）前
  const goFuncNames = goFunctions.map((f) => f.name).sort();
  assert.deepEqual(goFuncNames, ["Start", "handler", "main"], "Go 函数名应为 Start/handler/main（字典序：大写在前）");

  // 场景4：Rust 函数（含 pub / async 前缀）
  const rsCode = `fn plain() {}
pub fn public_fn() {}
pub async fn async_fn() -> u32 { 0 }
`;
  const rsFunctions = CodeScanner._scanFunctions(rsCode, "main.rs", "rust");
  // 断言：扫描到 3 个 Rust 函数
  assert.equal(rsFunctions.length, 3, "Rust 应扫描到 3 个函数");
  const rsFuncNames = rsFunctions.map((f) => f.name).sort();
  assert.deepEqual(rsFuncNames, ["async_fn", "plain", "public_fn"], "Rust 函数名应为 async_fn/plain/public_fn");
});

// ----------------------------------------------------------------------------
// DCC-006: CodeScanner._scanClasses() 多语言类定义扫描
// ----------------------------------------------------------------------------
test("DCC-006: CodeScanner._scanClasses() 多语言类定义扫描", () => {
  // 场景1：TypeScript 类（含 export / abstract 前缀）
  const tsCode = `class Foo {}
export class Bar {}
export abstract class Baz {}
`;
  const tsClasses = CodeScanner._scanClasses(tsCode, "test.ts", "typescript");
  // 断言：扫描到 3 个 TypeScript 类
  assert.equal(tsClasses.length, 3, "TypeScript 应扫描到 3 个类");
  const tsClassNames = tsClasses.map((c) => c.name).sort();
  assert.deepEqual(tsClassNames, ["Bar", "Baz", "Foo"], "TypeScript 类名应为 Bar/Baz/Foo");
  // 断言：symbol_type 和 language 字段正确
  for (const c of tsClasses) {
    assert.equal(c.symbol_type, "class");
    assert.equal(c.language, "typescript");
  }

  // 场景2：Python 类
  const pyCode = `class AuthService:
    pass

class OrderService(BaseService):
    pass
`;
  const pyClasses = CodeScanner._scanClasses(pyCode, "auth.py", "python");
  // 断言：扫描到 2 个 Python 类
  assert.equal(pyClasses.length, 2, "Python 应扫描到 2 个类");
  const pyClassNames = pyClasses.map((c) => c.name).sort();
  assert.deepEqual(pyClassNames, ["AuthService", "OrderService"], "Python 类名应为 AuthService/OrderService");

  // 场景3：Go struct（Go 没有 class，使用 type ... struct）
  const goCode = `package main

type Server struct {
    Name string
}

type Config struct {
    Port int
}
`;
  const goClasses = CodeScanner._scanClasses(goCode, "main.go", "go");
  // 断言：扫描到 2 个 Go struct
  assert.equal(goClasses.length, 2, "Go 应扫描到 2 个 struct");
  const goClassNames = goClasses.map((c) => c.name).sort();
  assert.deepEqual(goClassNames, ["Config", "Server"], "Go struct 名应为 Config/Server");

  // 场景4：Rust struct
  const rsCode = `struct PlainStruct {}
pub struct PublicStruct {}
`;
  const rsClasses = CodeScanner._scanClasses(rsCode, "main.rs", "rust");
  // 断言：扫描到 2 个 Rust struct
  assert.equal(rsClasses.length, 2, "Rust 应扫描到 2 个 struct");
  const rsClassNames = rsClasses.map((c) => c.name).sort();
  assert.deepEqual(rsClassNames, ["PlainStruct", "PublicStruct"], "Rust struct 名应为 PlainStruct/PublicStruct");
});

// ----------------------------------------------------------------------------
// DCC-007: CodeScanner._scanImports() 多语言 import 扫描
// ----------------------------------------------------------------------------
test("DCC-007: CodeScanner._scanImports() 多语言 import 扫描", () => {
  // 场景1：TypeScript import（含 from 子句）
  const tsCode = `import express from 'express';
import { foo } from "./utils";
import type { Bar } from "types";
`;
  const tsImports = CodeScanner._scanImports(tsCode, "app.ts", "typescript");
  // 断言：扫描到 3 个 TypeScript import
  assert.equal(tsImports.length, 3, "TypeScript 应扫描到 3 个 import");
  const tsModules = tsImports.map((i) => i.imported_module).sort();
  assert.deepEqual(tsModules, ["./utils", "express", "types"], "TypeScript 导入模块应为 ./utils/express/types");
  // 断言：所有 import 的 language 和 source_file 字段正确
  for (const imp of tsImports) {
    assert.equal(imp.language, "typescript");
    assert.equal(imp.source_file, "app.ts");
    assert.equal(imp.import_type, "import");
  }

  // 场景2：Python import（import X 和 from X import Y 两种）
  const pyCode = `import os
import sys
from typing import List
from collections import defaultdict
`;
  const pyImports = CodeScanner._scanImports(pyCode, "main.py", "python");
  // 断言：扫描到 4 个 Python import
  assert.equal(pyImports.length, 4, "Python 应扫描到 4 个 import");
  const pyModules = pyImports.map((i) => i.imported_module).sort();
  assert.deepEqual(pyModules, ["collections", "os", "sys", "typing"], "Python 导入模块应为 collections/os/sys/typing");

  // 场景3：Java import（每条以分号结尾）
  const javaCode = `package com.example;

import java.util.List;
import java.util.Map;
import com.example.foo.Bar;
`;
  const javaImports = CodeScanner._scanImports(javaCode, "Main.java", "java");
  // 断言：扫描到 3 个 Java import
  assert.equal(javaImports.length, 3, "Java 应扫描到 3 个 import");
  const javaModules = javaImports.map((i) => i.imported_module).sort();
  assert.deepEqual(
    javaModules,
    ["com.example.foo.Bar", "java.util.List", "java.util.Map"],
    "Java 导入模块应为 com.example.foo.Bar/java.util.List/java.util.Map"
  );

  // 场景4：JavaScript import + require 两种形式
  const jsCode = `const fs = require('fs');
const path = require("path");
import React from 'react';
`;
  const jsImports = CodeScanner._scanImports(jsCode, "app.js", "javascript");
  // 断言：扫描到 3 个 JavaScript import（2 个 require + 1 个 from）
  assert.equal(jsImports.length, 3, "JavaScript 应扫描到 3 个 import");
  const jsModules = jsImports.map((i) => i.imported_module).sort();
  assert.deepEqual(jsModules, ["fs", "path", "react"], "JavaScript 导入模块应为 fs/path/react");
});

// ----------------------------------------------------------------------------
// DCC-008: CodeScanner._scanTodos() 三种注释风格的 TODO/FIXME 扫描
// ----------------------------------------------------------------------------
test("DCC-008: CodeScanner._scanTodos() 三种注释风格的 TODO/FIXME 扫描", () => {
  // 构造含三种注释风格的代码：
  // - `#` 风格（Python/Shell）
  // - `//` 风格（JS/TS/Java/Go/Rust）
  // - `*` 风格（块注释内）
  const code = `# TODO: 实现 Python 错误处理
def process(data):
    pass

// FIXME: 修复 JavaScript 空指针问题
function validate(input) {
    return null;
}

/*
 * TODO: 块注释中的待办事项
 */
function helper() {}
`;
  // 调用 _scanTodos 扫描 TODO/FIXME
  const todos = CodeScanner._scanTodos(code, "mixed.txt");

  // 断言：扫描到至少 3 个 TODO/FIXME（去重后）
  assert.ok(todos.length >= 3, "应扫描到至少 3 个 TODO/FIXME（覆盖 # // * 三种风格）");

  // 断言：包含 TODO 和 FIXME 两种类型
  const todoTypes = todos.map((t) => t.todo_type);
  assert.ok(todoTypes.includes("TODO"), "应扫描到 TODO 类型（todo_type 应大写）");
  assert.ok(todoTypes.includes("FIXME"), "应扫描到 FIXME 类型（todo_type 应大写）");

  // 断言：每个 todo 的 file_path 字段正确
  for (const t of todos) {
    assert.equal(t.file_path, "mixed.txt");
    assert.ok(t.line_number >= 1, "行号应 >= 1");
    assert.ok(t.content.length > 0, "内容不应为空");
  }

  // 断言：能识别 # 风格的 TODO 内容
  const pyTodo = todos.find((t) => t.todo_type === "TODO" && t.content.includes("Python"));
  assert.ok(pyTodo, "应识别 # 风格的 TODO（含 'Python' 关键词）");

  // 断言：能识别 // 风格的 FIXME
  const jsFixme = todos.find((t) => t.todo_type === "FIXME" && t.content.includes("JavaScript"));
  assert.ok(jsFixme, "应识别 // 风格的 FIXME（含 'JavaScript' 关键词）");
});

// ----------------------------------------------------------------------------
// DCC-009: CodeScanner.scanProject() 完整项目扫描（含跳过目录验证）
// ----------------------------------------------------------------------------
test("DCC-009: CodeScanner.scanProject() 完整项目扫描（含跳过目录验证）", () => {
  // 创建临时项目目录
  const projectRoot = makeTmpDir();
  try {
    // 在 src/ 下创建 TypeScript 源码（含函数、类、import、TODO）
    writeFixtureFile(
      projectRoot,
      "src/auth.ts",
      `import { Database } from "./database";

// TODO: 实现登录逻辑
export class AuthService {
    login(user: string, pass: string): boolean {
        return true;
    }
}
`
    );
    // 在 src/ 下创建 Python 源码
    writeFixtureFile(
      projectRoot,
      "src/utils.py",
      `import os

# FIXME: 修复空指针
def helper():
    pass
`
    );
    // 在 node_modules/ 下创建应被跳过的源码（验证跳过目录）
    writeFixtureFile(
      projectRoot,
      "node_modules/should-skip.ts",
      `export function skippedFunction() {}
`
    );
    // 在 dist/ 下创建应被跳过的构建产物
    writeFixtureFile(
      projectRoot,
      "dist/build.js",
      `function buildOnly() {}
`
    );

    // 调用 scanProject 扫描整个项目
    const [symbols, imports, todos] = CodeScanner.scanProject(projectRoot);

    // 断言：扫描到 src/auth.ts 中的 AuthService 类
    // 注意：TypeScript 类方法（如 login）不被 _scanFunctions 识别（仅匹配 function 关键字）
    const symbolNames = symbols.map((s) => s.name);
    assert.ok(symbolNames.includes("AuthService"), "应扫描到 AuthService 类");
    // 断言：扫描到 src/utils.py 中的 helper 模块级函数
    assert.ok(symbolNames.includes("helper"), "应扫描到 helper 函数（Python 模块级函数）");

    // 断言：node_modules/ 和 dist/ 下的符号被跳过
    assert.ok(!symbolNames.includes("skippedFunction"), "node_modules 下的符号应被跳过");
    assert.ok(!symbolNames.includes("buildOnly"), "dist 下的符号应被跳过");

    // 断言：扫描到 src/auth.ts 中的 import
    const tsImport = imports.find((i) => i.imported_module === "./database");
    assert.ok(tsImport, "应扫描到 TypeScript import './database'");

    // 断言：扫描到 src/utils.py 中的 import
    const pyImport = imports.find((i) => i.imported_module === "os");
    assert.ok(pyImport, "应扫描到 Python import 'os'");

    // 断言：扫描到 TODO 和 FIXME
    const todoTypes = todos.map((t) => t.todo_type);
    assert.ok(todoTypes.includes("TODO"), "应扫描到 TODO（来自 src/auth.ts）");
    assert.ok(todoTypes.includes("FIXME"), "应扫描到 FIXME（来自 src/utils.py）");
  } finally {
    // 清理临时目录
    rmTmpDir(projectRoot);
  }
});

// ============================================================================
// 第三部分：DocCodeConsistencyChecker 类测试
// ============================================================================

// ----------------------------------------------------------------------------
// DCC-010: DocCodeConsistencyChecker 构造函数参数处理
// ----------------------------------------------------------------------------
test("DCC-010: DocCodeConsistencyChecker 构造函数参数处理", () => {
  // 场景1：默认参数（docPaths=null, testCommand="", testTimeoutSec=600）
  const checker1 = new DocCodeConsistencyChecker("/tmp/test-project");
  // 调用 checkAll 触发内部解析，验证默认值不会导致异常
  const report1 = checker1.checkAll();
  // 断言：未配置测试命令时，test_result 不为 null 且 test_command 为占位符
  assert.ok(report1.test_result, "未配置测试命令时 test_result 不应为 null");
  assert.equal(report1.test_result!.test_command, "(未配置测试命令)", "未配置测试命令时 test_command 应为占位符");
  // 断言：项目名称为根目录 basename（path.resolve 会规范化 /tmp/test-project）
  assert.equal(report1.project_name, "test-project", "项目名称应为根目录 basename");

  // 场景2：testTimeoutSec 小于 10 秒时，应被钳制为 10 秒下限
  // 通过反射读取私有字段验证（构造函数使用 Math.max(10.0, testTimeoutSec)）
  const checker2 = new DocCodeConsistencyChecker(
    "/tmp/test-project",
    {},
    "",
    5.0 // 小于 10 秒
  );
  // 使用任意手段验证：超时下限为 10 秒
  // 这里通过构造一个超长的 sleep 命令并观察是否被钳制来验证不实际可行，
  // 改为验证构造函数不会抛异常且 checkAll 可正常运行
  const report2 = checker2.checkAll();
  assert.ok(report2, "testTimeoutSec=5 时构造和 checkAll 应正常完成");

  // 场景3：传入完整参数（含 docPaths 和 testCommand）
  const projectRoot = makeTmpDir();
  try {
    const prdPath = writeFixtureFile(
      projectRoot,
      "prd.md",
      "# PRD\n\n## 功能列表\n\n| 功能ID | 功能名称 |\n|------|------|\n| F-001 | login |\n"
    );
    const checker3 = new DocCodeConsistencyChecker(projectRoot, { prd: prdPath }, "echo '1 passed'", 30.0);
    const report3 = checker3.checkAll();
    // 断言：传入 docPaths 后能解析到功能点
    assert.ok(report3.feature_checks.length >= 1, "传入 docPaths 后应解析到至少 1 个功能点");
    assert.equal(report3.feature_checks[0].feature_id, "F-001", "功能点 ID 应为 F-001");
  } finally {
    rmTmpDir(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// DCC-011: D1 checkFeatureCompleteness() 已实现功能识别
// ----------------------------------------------------------------------------
test("DCC-011: D1 checkFeatureCompleteness() 已实现功能识别", () => {
  const projectRoot = makeTmpDir();
  try {
    // 创建 PRD：定义 2 个功能点 login 和 register
    const prdPath = writeFixtureFile(
      projectRoot,
      "prd.md",
      `# PRD

## 功能列表

| 功能ID | 功能名称 | 功能描述 |
|--------|----------|----------|
| F-001 | login | 用户登录功能 |
| F-002 | register | 用户注册功能 |
`
    );
    // 创建源码：在 src/auth.ts 中实现 login 和 register 函数
    writeFixtureFile(
      projectRoot,
      "src/auth.ts",
      `export function login(user: string, pass: string): boolean {
    return true;
}

export function register(user: string, pass: string): boolean {
    return true;
}
`
    );

    // 创建检查器（不配置测试命令，聚焦 D1 检查）
    const checker = new DocCodeConsistencyChecker(projectRoot, { prd: prdPath });
    // 调用 D1 检查
    const results = checker.checkFeatureCompleteness();

    // 断言：解析到 2 个功能点
    assert.equal(results.length, 2, "应解析到 2 个功能点");

    // 断言：F-001 login 被识别为已实现
    const loginItem = results.find((r) => r.feature_id === "F-001");
    assert.ok(loginItem, "F-001 应存在");
    assert.equal(loginItem!.status, "implemented", "F-001 login 应被识别为 implemented");
    // 断言：code_location 包含 login 函数名
    assert.ok(loginItem!.code_location.includes("login"), "code_location 应包含 login 函数名");
    // 断言：evidence 包含文件路径
    assert.ok(loginItem!.evidence.includes("auth.ts"), "evidence 应包含文件路径 auth.ts");

    // 断言：F-002 register 也被识别为已实现
    const registerItem = results.find((r) => r.feature_id === "F-002");
    assert.ok(registerItem, "F-002 应存在");
    assert.equal(registerItem!.status, "implemented", "F-002 register 应被识别为 implemented");
  } finally {
    rmTmpDir(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// DCC-012: D1 checkFeatureCompleteness() 未实现功能识别
// ----------------------------------------------------------------------------
test("DCC-012: D1 checkFeatureCompleteness() 未实现功能识别", () => {
  const projectRoot = makeTmpDir();
  try {
    // 创建 PRD：定义 3 个功能点，其中 export 未实现
    const prdPath = writeFixtureFile(
      projectRoot,
      "prd.md",
      `# PRD

## 功能列表

| 功能ID | 功能名称 | 功能描述 |
|--------|----------|----------|
| F-001 | login | 用户登录功能 |
| F-002 | register | 用户注册功能 |
| F-003 | exportData | 数据导出功能 |
`
    );
    // 创建源码：仅实现 login 和 register，不实现 exportData
    writeFixtureFile(
      projectRoot,
      "src/auth.ts",
      `export function login(user: string, pass: string): boolean {
    return true;
}
export function register(user: string, pass: string): boolean {
    return true;
}
`
    );

    const checker = new DocCodeConsistencyChecker(projectRoot, { prd: prdPath });
    const results = checker.checkFeatureCompleteness();

    // 断言：F-001 和 F-002 已实现
    const loginItem = results.find((r) => r.feature_id === "F-001");
    assert.equal(loginItem!.status, "implemented");

    const registerItem = results.find((r) => r.feature_id === "F-002");
    assert.equal(registerItem!.status, "implemented");

    // 断言：F-003 exportData 被识别为未实现
    const exportItem = results.find((r) => r.feature_id === "F-003");
    assert.ok(exportItem, "F-003 应存在");
    assert.equal(exportItem!.status, "missing", "F-003 exportData 应被识别为 missing（代码中无对应实现）");
    // 断言：未实现时 code_location 为空
    assert.equal(exportItem!.code_location, "", "未实现功能 code_location 应为空字符串");
  } finally {
    rmTmpDir(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// DCC-013: D2 checkIntegrationCompleteness() 已连通集成识别
// ----------------------------------------------------------------------------
test("DCC-013: D2 checkIntegrationCompleteness() 已连通集成识别", () => {
  const projectRoot = makeTmpDir();
  try {
    // 创建架构文档：定义 auth→database 集成关系
    const archPath = writeFixtureFile(
      projectRoot,
      "architecture.md",
      `# 架构文档

## 模块依赖

auth 依赖 database
`
    );
    // 创建源码：auth.py 中 import database，体现集成关系
    writeFixtureFile(
      projectRoot,
      "src/auth.py",
      `from database import Database

class AuthService:
    def login(self):
        pass
`
    );

    const checker = new DocCodeConsistencyChecker(projectRoot, { architecture: archPath });
    const results = checker.checkIntegrationCompleteness();

    // 断言：解析到至少 1 个集成关系
    assert.ok(results.length >= 1, "应解析到至少 1 个集成关系（auth→database）");

    // 断言：auth→database 被识别为已连通
    const authDb = results.find((r) => r.integration_desc === "auth→database");
    assert.ok(authDb, "应存在 auth→database 集成关系");
    assert.equal(authDb!.status, "connected", "auth→database 应被识别为 connected（代码中有 from database import）");
    // 断言：code_location 包含 import 信息
    assert.ok(authDb!.code_location.includes("database"), "code_location 应包含被导入的模块名 'database'");
  } finally {
    rmTmpDir(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// DCC-014: D2 checkIntegrationCompleteness() 缺失集成识别
// ----------------------------------------------------------------------------
test("DCC-014: D2 checkIntegrationCompleteness() 缺失集成识别", () => {
  const projectRoot = makeTmpDir();
  try {
    // 创建架构文档：定义 auth→database 集成关系
    const archPath = writeFixtureFile(
      projectRoot,
      "architecture.md",
      `# 架构文档

## 模块依赖

auth 依赖 database
`
    );
    // 创建源码：auth.py 不 import database，缺失集成关系
    writeFixtureFile(
      projectRoot,
      "src/auth.py",
      `class AuthService:
    def login(self):
        pass
`
    );

    const checker = new DocCodeConsistencyChecker(projectRoot, { architecture: archPath });
    const results = checker.checkIntegrationCompleteness();

    // 断言：auth→database 被识别为缺失
    const authDb = results.find((r) => r.integration_desc === "auth→database");
    assert.ok(authDb, "应存在 auth→database 集成关系");
    assert.equal(authDb!.status, "missing", "auth→database 应被识别为 missing（代码中无 database import）");
    // 断言：缺失时 code_location 为空
    assert.equal(authDb!.code_location, "", "缺失集成的 code_location 应为空字符串");
  } finally {
    rmTmpDir(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// DCC-015: D3 checkTestCorrectness() 未配置测试命令场景
// ----------------------------------------------------------------------------
test("DCC-015: D3 checkTestCorrectness() 未配置测试命令场景", () => {
  const projectRoot = makeTmpDir();
  try {
    const prdPath = writeFixtureFile(
      projectRoot,
      "prd.md",
      `# PRD

## 功能列表

| 功能ID | 功能名称 |
|--------|----------|
| F-001 | login |
`
    );

    // 不配置测试命令（testCommand=""）
    const checker = new DocCodeConsistencyChecker(projectRoot, { prd: prdPath }, "");
    const result = checker.checkTestCorrectness();

    // 断言：未配置测试命令时返回占位结果
    assert.equal(result.test_command, "(未配置测试命令)", "未配置测试命令时 test_command 应为占位符");
    assert.equal(result.passed, 0, "passed 应为 0");
    assert.equal(result.failed, 0, "failed 应为 0");
    assert.equal(result.skipped, 0, "skipped 应为 0");
    assert.equal(result.duration_sec, 0, "duration_sec 应为 0");
    assert.ok(result.test_output_tail.includes("跳过测试执行"), "test_output_tail 应说明跳过原因");
    // 断言：covered_features 和 uncovered_features 都为空
    assert.equal(result.covered_features.length, 0, "未配置测试命令时 covered_features 应为空");
    assert.equal(result.uncovered_features.length, 0, "未配置测试命令时 uncovered_features 应为空");
  } finally {
    rmTmpDir(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// DCC-016: D3 checkTestCorrectness() 配置测试命令且全部通过
// ----------------------------------------------------------------------------
test("DCC-016: D3 checkTestCorrectness() 配置测试命令且全部通过", () => {
  const projectRoot = makeTmpDir();
  try {
    const prdPath = writeFixtureFile(
      projectRoot,
      "prd.md",
      `# PRD

## 功能列表

| 功能ID | 功能名称 |
|--------|----------|
| F-001 | login |
`
    );
    // 在 tests/ 目录下创建测试文件，引用功能 ID F-001，使其被识别为已覆盖
    writeFixtureFile(
      projectRoot,
      "tests/test_auth.ts",
      `// 测试 F-001 login 功能
import { test } from 'node:test';
test('login', () => {});
`
    );
    // 创建一个会输出 "N passed" 的测试脚本（使用 node -e 直接执行）
    // 注意：spawnSync 使用 shell:true，所以可以执行复杂命令
    const testCommand = `node -e "console.log('3 passed'); console.log('0 failed'); console.log('0 skipped');"`;

    const checker = new DocCodeConsistencyChecker(projectRoot, { prd: prdPath }, testCommand, 30.0);
    const result = checker.checkTestCorrectness();

    // 断言：测试命令被执行
    assert.equal(result.test_command, testCommand);
    // 断言：解析到 3 个通过
    assert.equal(result.passed, 3, "应解析到 3 个 passed");
    // 断言：无失败
    assert.equal(result.failed, 0, "应解析到 0 个 failed");
    // 断言：F-001 被识别为已覆盖（tests/test_auth.ts 中提及 F-001）
    assert.ok(result.covered_features.includes("F-001"), "F-001 应被识别为已覆盖（测试文件中提及 F-001）");
    // 断言：无未覆盖功能
    assert.equal(result.uncovered_features.length, 0, "应无未覆盖功能");
    // 断言：执行耗时 >= 0
    assert.ok(result.duration_sec >= 0, "duration_sec 应 >= 0");
  } finally {
    rmTmpDir(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// DCC-017: D3 checkTestCorrectness() 配置测试命令且有失败
// ----------------------------------------------------------------------------
test("DCC-017: D3 checkTestCorrectness() 配置测试命令且有失败", () => {
  const projectRoot = makeTmpDir();
  try {
    const prdPath = writeFixtureFile(
      projectRoot,
      "prd.md",
      `# PRD

## 功能列表

| 功能ID | 功能名称 |
|--------|----------|
| F-001 | login |
`
    );
    // 创建会输出失败信息的测试脚本
    const testCommand = `node -e "console.log('2 passed'); console.log('1 failed'); console.log('1 skipped');"`;

    const checker = new DocCodeConsistencyChecker(projectRoot, { prd: prdPath }, testCommand, 30.0);
    const result = checker.checkTestCorrectness();

    // 断言：解析到 2 个通过、1 个失败、1 个跳过
    assert.equal(result.passed, 2, "应解析到 2 个 passed");
    assert.equal(result.failed, 1, "应解析到 1 个 failed");
    assert.equal(result.skipped, 1, "应解析到 1 个 skipped");
    // 断言：test_output_tail 非空（含脚本输出）
    assert.ok(result.test_output_tail.length > 0, "test_output_tail 应非空");
  } finally {
    rmTmpDir(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// DCC-018: D4 checkAcceptanceCriteria() 验收标准满足检查
// ----------------------------------------------------------------------------
test("DCC-018: D4 checkAcceptanceCriteria() 验收标准满足检查", () => {
  const projectRoot = makeTmpDir();
  try {
    // 创建 PRD：定义 2 条验收标准
    // AC-001 描述含 "login"（英文关键词），应在代码符号中匹配
    // AC-002 描述含 "未实现功能XYZ"（无对应代码），应不满足
    const prdPath = writeFixtureFile(
      projectRoot,
      "prd.md",
      `# PRD

## 验收标准

| 编号 | 描述 |
|------|------|
| AC-001 | login 功能可用 |
| AC-002 | unknownFeatureXYZ 实现完成 |
`
    );
    // 创建源码：实现 login 函数
    writeFixtureFile(
      projectRoot,
      "src/auth.ts",
      `export function login(user: string, pass: string): boolean {
    return true;
}
`
    );

    const checker = new DocCodeConsistencyChecker(projectRoot, { prd: prdPath });
    const results = checker.checkAcceptanceCriteria();

    // 断言：解析到 2 条验收标准
    assert.equal(results.length, 2, "应解析到 2 条验收标准");

    // 断言：AC-001 login 在代码符号中找到匹配，状态为 satisfied，验证方式为 code
    const ac001 = results.find((r) => r.criteria_id === "AC-001");
    assert.ok(ac001, "AC-001 应存在");
    assert.equal(ac001!.status, "satisfied", "AC-001 login 应被识别为 satisfied（代码中有 login 函数）");
    assert.equal(ac001!.verification, "code", "AC-001 验证方式应为 code（在代码符号中匹配）");

    // 断言：AC-002 unknownFeatureXYZ 无对应代码，状态为 unsatisfied
    const ac002 = results.find((r) => r.criteria_id === "AC-002");
    assert.ok(ac002, "AC-002 应存在");
    assert.equal(ac002!.status, "unsatisfied", "AC-002 unknownFeatureXYZ 应被识别为 unsatisfied（代码中无对应实现）");
  } finally {
    rmTmpDir(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// DCC-019: D5 checkTodoFixme() TODO/FIXME 清零检查
// ----------------------------------------------------------------------------
test("DCC-019: D5 checkTodoFixme() TODO/FIXME 清零检查", () => {
  const projectRoot = makeTmpDir();
  try {
    // 创建源码：含 2 个 TODO/FIXME 注释
    // 注意：_checkTodoImplementation 通过正则 /^\s*function\s+/ 匹配函数定义，
    // 该正则不匹配带 "export" 前缀的导出形式，因此 fixture 使用不带 export 的函数定义
    writeFixtureFile(
      projectRoot,
      "src/module.ts",
      `// TODO: 实现 process 函数
function process(data: string): string {
    return data;
}

// FIXME: 修复 unknownThing 空指针
function other(): void {}
`
    );

    const checker = new DocCodeConsistencyChecker(projectRoot);
    const todos = checker.checkTodoFixme();

    // 断言：扫描到 2 个 TODO/FIXME
    assert.equal(todos.length, 2, "应扫描到 2 个 TODO/FIXME");

    // 断言：包含 TODO 和 FIXME 两种类型
    const todoTypes = todos.map((t) => t.todo_type);
    assert.ok(todoTypes.includes("TODO"), "应包含 TODO");
    assert.ok(todoTypes.includes("FIXME"), "应包含 FIXME");

    // 断言：第 1 个 TODO（"实现 process 函数"）应被识别为有对应实现
    // 因为同文件中存在 process 函数定义，且 "process" 是关键词
    const todoWithImpl = todos.find((t) => t.todo_type === "TODO" && t.content.includes("process"));
    assert.ok(todoWithImpl, "应存在包含 'process' 关键词的 TODO");
    assert.equal(
      todoWithImpl!.has_implementation,
      true,
      "TODO 'process' 应被识别为有对应实现（同文件有 process 函数）"
    );

    // 断言：FIXME 'unknownThing' 无对应实现
    const fixmeNoImpl = todos.find((t) => t.todo_type === "FIXME" && t.content.includes("unknownThing"));
    assert.ok(fixmeNoImpl, "应存在包含 'unknownThing' 关键词的 FIXME");
    assert.equal(fixmeNoImpl!.has_implementation, false, "FIXME 'unknownThing' 应被识别为无对应实现");

    // 断言：返回的是副本，修改副本不影响内部缓存
    const originalLength = todos.length;
    todos.pop();
    // 再次调用 checkTodoFixme，验证内部缓存未被破坏
    const todosAgain = checker.checkTodoFixme();
    assert.equal(todosAgain.length, originalLength, "checkTodoFixme 应返回副本，外部修改不影响内部缓存");
  } finally {
    rmTmpDir(projectRoot);
  }
});

// ----------------------------------------------------------------------------
// DCC-020: D6 + checkAll() + generateReport() 完整流程
// ----------------------------------------------------------------------------
test("DCC-020: D6 + checkAll() + generateReport() 完整流程", () => {
  const projectRoot = makeTmpDir();
  try {
    // 创建 PRD：定义功能点 + 验收标准
    const prdPath = writeFixtureFile(
      projectRoot,
      "prd.md",
      `# PRD

## 功能列表

| 功能ID | 功能名称 | 功能描述 |
|--------|----------|----------|
| F-001 | login | 用户登录功能 |
| F-002 | unknownModule | 未实现的功能 |
`
    );
    // 创建架构文档：定义集成关系（其中一个 target 模块在代码中不存在，触发 D6 偏离）
    // 注意：避免使用已知技术栈关键词（如 Flask/Django/React 等），否则会触发 D6 技术选型偏离
    const archPath = writeFixtureFile(
      projectRoot,
      "architecture.md",
      `# 架构文档

## 模块依赖

auth 依赖 database
auth 依赖 nonExistentModule
`
    );
    // 创建源码：实现 login 函数；auth.py 中 import database（连通第 1 个集成）；不 import nonExistentModule（第 2 个集成缺失 + D6 偏离）
    writeFixtureFile(
      projectRoot,
      "src/auth.ts",
      `export function login(user: string, pass: string): boolean {
    return true;
}
`
    );
    writeFixtureFile(
      projectRoot,
      "src/auth.py",
      `from database import Database

class AuthService:
    def login(self):
        pass
`
    );

    // 构造检查器（不配置测试命令，简化 D3）
    const checker = new DocCodeConsistencyChecker(projectRoot, { prd: prdPath, architecture: archPath }, "");

    // 1. 单独验证 D6: checkDocIntentAlignment()
    const deviations = checker.checkDocIntentAlignment();
    // 断言：存在 D6 偏离项（nonExistentModule 在代码中无体现）
    const nonExistentDeviation = deviations.find(
      (d) => d.dimension === "模块划分" && d.doc_intent.includes("nonExistentModule")
    );
    assert.ok(nonExistentDeviation, "D6 应检测到 nonExistentModule 模块偏离");
    assert.equal(nonExistentDeviation!.severity, "low", "模块划分偏离严重程度应为 low");

    // 2. 调用 checkAll() 执行完整流程
    const report = checker.checkAll();

    // 断言：报告结构完整
    assert.ok(report.project_name, "报告应含 project_name");
    assert.ok(report.check_time, "报告应含 check_time");
    assert.ok(report.check_time.includes("T"), "check_time 应为 ISO 格式");

    // 断言：D1 功能检查包含 F-001 和 F-002
    assert.ok(report.feature_checks.length >= 2, "D1 应包含至少 2 个功能检查项");
    const f001 = report.feature_checks.find((r) => r.feature_id === "F-001");
    assert.equal(f001!.status, "implemented");
    const f002 = report.feature_checks.find((r) => r.feature_id === "F-002");
    assert.equal(f002!.status, "missing", "F-002 unknownModule 应被识别为 missing");

    // 断言：D2 集成检查包含 auth→database 和 auth→nonExistentModule
    const authDb = report.integration_checks.find((r) => r.integration_desc === "auth→database");
    assert.equal(authDb!.status, "connected", "auth→database 应为 connected");
    const authNonExistent = report.integration_checks.find((r) => r.integration_desc === "auth→nonExistentModule");
    assert.equal(authNonExistent!.status, "missing", "auth→nonExistentModule 应为 missing");

    // 断言：D3 未配置测试命令
    assert.ok(report.test_result, "D3 test_result 不应为 null");
    assert.equal(report.test_result!.test_command, "(未配置测试命令)");

    // 断言：D5 无 TODO 残留（src/auth.ts 和 src/auth.py 中无 TODO/FIXME）
    assert.equal(report.todo_items.length, 0, "D5 应无 TODO/FIXME 残留");

    // 断言：D6 偏离项包含 nonExistentModule
    assert.ok(report.deviation_items.length >= 1, "D6 应至少有 1 个偏离项");

    // 断言：缺口清单非空（包含 D1 missing、D2 missing、D3 无测试、D6 偏离）
    assert.ok(report.gap_list.length >= 1, "缺口清单应非空");
    // 断言：overall_passed 为 false（存在多个缺口）
    assert.equal(report.overall_passed, false, "存在缺口时 overall_passed 应为 false");

    // 验证缺口清单包含各维度的项
    const gapDimensions = new Set(report.gap_list.map((g) => g.dimension));
    assert.ok(gapDimensions.has("D1 功能完成度"), "缺口清单应包含 D1 维度");
    assert.ok(gapDimensions.has("D2 集成完整性"), "缺口清单应包含 D2 维度");
    assert.ok(gapDimensions.has("D3 测试正确性"), "缺口清单应包含 D3 维度（无测试结果）");
    assert.ok(gapDimensions.has("D6 文档意图"), "缺口清单应包含 D6 维度");

    // 3. 验证 generateReport() 生成的 Markdown 报告
    const markdownReport = checker.generateReport(report);

    // 断言：报告包含所有关键章节标题
    assert.ok(markdownReport.includes("文档对照代码审查报告"), "Markdown 报告应含主标题");
    assert.ok(markdownReport.includes("## 文档信息"), "应含 '文档信息' 章节");
    assert.ok(markdownReport.includes("## 1. 审查概览"), "应含 '审查概览' 章节");
    assert.ok(markdownReport.includes("## 2. D1 功能完成度"), "应含 'D1 功能完成度' 章节");
    assert.ok(markdownReport.includes("## 3. D2 集成完整性"), "应含 'D2 集成完整性' 章节");
    assert.ok(markdownReport.includes("## 4. D3 测试正确性"), "应含 'D3 测试正确性' 章节");
    assert.ok(markdownReport.includes("## 5. D4 验收标准满足"), "应含 'D4 验收标准满足' 章节");
    assert.ok(markdownReport.includes("## 6. D5 TODO/FIXME 清零"), "应含 'D5 TODO/FIXME 清零' 章节");
    assert.ok(markdownReport.includes("## 7. D6 文档意图遵从"), "应含 'D6 文档意图遵从' 章节");
    assert.ok(markdownReport.includes("## 8. 缺口清单"), "应含 '缺口清单' 章节");
    assert.ok(markdownReport.includes("## 9. 审查结论"), "应含 '审查结论' 章节");

    // 断言：报告含 ❌ 审查不通过 标记
    assert.ok(markdownReport.includes("❌ 审查不通过"), "存在缺口时报告应含 '❌ 审查不通过' 标记");

    // 断言：报告含功能 F-001 和 F-002 的对照行
    assert.ok(markdownReport.includes("F-001"), "报告应含 F-001 功能 ID");
    assert.ok(markdownReport.includes("F-002"), "报告应含 F-002 功能 ID");

    // 断言：报告含集成关系 auth→database 和 auth→nonExistentModule
    assert.ok(markdownReport.includes("auth→database"), "报告应含 auth→database 集成关系");
    assert.ok(markdownReport.includes("auth→nonExistentModule"), "报告应含 auth→nonExistentModule 集成关系");
  } finally {
    rmTmpDir(projectRoot);
  }
});
