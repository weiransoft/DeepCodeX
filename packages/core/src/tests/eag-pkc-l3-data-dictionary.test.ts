/**
 * EAG-P2 批次 8 单元测试：L3 业务数据理解器（DataDictionaryExtractor）
 *
 * 测试范围：
 * - T1. DataDictionaryExtractor 实例化
 * - T2. extract 入参校验（空路径 / 不存在路径 / 文件路径）
 * - T3. 枚举识别（TypeScript enum）
 * - T4. 枚举识别（TypeScript const dict）
 * - T5. 枚举识别（Java enum）
 * - T6. 枚举识别（Python enum）
 * - T7. 字典表识别（表名 + key/value 列）
 * - T8. 字段业务语义推断（id / created_at / amount）
 * - T9. 敏感字段识别（password / email / name）
 * - T10. 不可变性（DataDictionary 冻结）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实文件系统（fs.mkdtemp 创建临时目录）
 * - 测试用例独立、可重复，每个用例自己创建与清理临时目录
 * - 中文详细注释，符合项目代码规范
 *
 * @module core/tests/eag-pkc-l3-data-dictionary
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DataDictionaryExtractor, DataDictionaryExtractorError } from "../eag/pkc/l3/data-dictionary-extractor";

// ============================================================================
// 辅助函数：创建临时项目目录与文件
// ============================================================================

/**
 * 创建临时项目目录
 *
 * @returns 临时项目根目录绝对路径
 */
async function createTempProject(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "eag-pkc-dict-"));
  return tmpDir;
}

/**
 * 递归删除目录（测试结束后清理）
 *
 * @param dirPath 待删除目录
 */
async function removeTempDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // 忽略删除失败
  }
}

/**
 * 写入文件（自动创建父目录）
 *
 * @param projectRoot 项目根目录
 * @param relativePath 文件相对路径
 * @param content 文件内容
 */
async function writeProjectFile(projectRoot: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(projectRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf-8");
}

// ============================================================================
// T1. DataDictionaryExtractor 实例化
// ============================================================================

test("T1a. DataDictionaryExtractor 可实例化", () => {
  const extractor = new DataDictionaryExtractor();
  assert.ok(extractor instanceof DataDictionaryExtractor);
});

// ============================================================================
// T2. extract 入参校验
// ============================================================================

test("T2a. extract 空 projectRoot 抛 invalid-path", async () => {
  const extractor = new DataDictionaryExtractor();
  await assert.rejects(extractor.extract(""), (err: unknown) => {
    assert.ok(err instanceof DataDictionaryExtractorError);
    assert.equal(err.kind, "invalid-path");
    return true;
  });
});

test("T2b. extract 空白 projectRoot 抛 invalid-path", async () => {
  const extractor = new DataDictionaryExtractor();
  await assert.rejects(extractor.extract("   "), (err: unknown) => {
    assert.ok(err instanceof DataDictionaryExtractorError);
    assert.equal(err.kind, "invalid-path");
    return true;
  });
});

test("T2c. extract 不存在的路径抛 path-not-found", async () => {
  const extractor = new DataDictionaryExtractor();
  const nonExistent = path.join(os.tmpdir(), `non-existent-${Date.now()}`);
  await assert.rejects(extractor.extract(nonExistent), (err: unknown) => {
    assert.ok(err instanceof DataDictionaryExtractorError);
    assert.equal(err.kind, "path-not-found");
    return true;
  });
});

test("T2d. extract 文件路径（非目录）抛 invalid-path", async () => {
  const tmpDir = await createTempProject();
  try {
    const filePath = path.join(tmpDir, "some-file.txt");
    await fs.writeFile(filePath, "test", "utf-8");
    const extractor = new DataDictionaryExtractor();
    await assert.rejects(extractor.extract(filePath), (err: unknown) => {
      assert.ok(err instanceof DataDictionaryExtractorError);
      assert.equal(err.kind, "invalid-path");
      return true;
    });
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T3. 枚举识别（TypeScript enum）
// ============================================================================

test("T3a. 识别 TypeScript enum 定义", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/enums.ts",
      [
        "/** 订单状态枚举 */",
        "export enum OrderStatus {",
        "  PENDING = 1,",
        "  PAID = 2,",
        "  SHIPPED = 3,",
        "  COMPLETED = 4,",
        "  CANCELLED = 5,",
        "}",
        "",
      ].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const orderStatusEnum = dict.enums.find((e) => e.enumName === "OrderStatus");
    assert.ok(orderStatusEnum, "应识别 OrderStatus 枚举");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T3b. 提取 enum 枚举值", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/enums.ts",
      ["export enum OrderStatus {", "  PENDING = 1,", "  PAID = 2,", "}", ""].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const orderStatusEnum = dict.enums.find((e) => e.enumName === "OrderStatus");
    assert.ok(orderStatusEnum);
    assert.ok(orderStatusEnum!.values.length >= 2, "应至少提取到 2 个枚举值");
    const pendingValue = orderStatusEnum!.values.find((v) => v.value === "1");
    assert.ok(pendingValue, "应提取到 PENDING = 1");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T3c. 提取 enum 上方注释作为描述", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/enums.ts",
      ["/** 订单状态枚举 */", "export enum OrderStatus {", "  PENDING = 1,", "  PAID = 2,", "}", ""].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const orderStatusEnum = dict.enums.find((e) => e.enumName === "OrderStatus");
    assert.ok(orderStatusEnum);
    assert.ok(orderStatusEnum!.description.includes("订单状态"), "描述应包含注释内容");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T4. 枚举识别（TypeScript const dict）
// ============================================================================

test("T4a. 识别 TypeScript const dict as const", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/constants.ts",
      ["export const ORDER_STATUS = {", "  PENDING: 1,", "  PAID: 2,", "  SHIPPED: 3,", "} as const;", ""].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const orderStatusConst = dict.enums.find((e) => e.enumName === "ORDER_STATUS");
    assert.ok(orderStatusConst, "应识别 ORDER_STATUS 常量字典");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T5. 枚举识别（Java enum）
// ============================================================================

test("T5a. 识别 Java enum 定义", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/OrderStatus.java",
      [
        "package com.example;",
        "",
        "public enum OrderStatus {",
        '    PENDING(1, "待支付"),',
        '    PAID(2, "已支付"),',
        '    SHIPPED(3, "已发货");',
        "",
        "    private final int code;",
        "    private final String label;",
        "",
        "    OrderStatus(int code, String label) {",
        "        this.code = code;",
        "        this.label = label;",
        "    }",
        "}",
        "",
      ].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const orderStatusEnum = dict.enums.find((e) => e.enumName === "OrderStatus");
    assert.ok(orderStatusEnum, "应识别 Java OrderStatus 枚举");
    // Java 枚举带构造参数：PENDING(1, "待支付")
    const pendingValue = orderStatusEnum!.values.find((v) => v.value === "1");
    assert.ok(pendingValue, "应提取到 PENDING = 1");
    assert.equal(pendingValue!.label, "待支付");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T6. 枚举识别（Python enum）
// ============================================================================

test("T6a. 识别 Python Enum 类", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/enums.py",
      [
        "from enum import Enum",
        "",
        "class OrderStatus(Enum):",
        "    PENDING = 1",
        "    PAID = 2",
        "    SHIPPED = 3",
        "",
      ].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const orderStatusEnum = dict.enums.find((e) => e.enumName === "OrderStatus");
    assert.ok(orderStatusEnum, "应识别 Python OrderStatus 枚举");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T7. 字典表识别
// ============================================================================

test("T7a. 识别字典表（表名含 dict_ 前缀）", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      [
        "CREATE TABLE dict_order_status (",
        "  code VARCHAR(20) PRIMARY KEY,",
        "  name VARCHAR(50) NOT NULL,",
        "  description VARCHAR(200)",
        ");",
        "",
      ].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const dictTable = dict.dictionaryTables.find((d) => d.tableName === "dict_order_status");
    assert.ok(dictTable, "应识别 dict_order_status 为字典表");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T7b. 字典表含 key 列与 value 列", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      [
        "CREATE TABLE dict_order_status (",
        "  code VARCHAR(20) PRIMARY KEY,",
        "  name VARCHAR(50) NOT NULL",
        ");",
        "",
      ].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const dictTable = dict.dictionaryTables.find((d) => d.tableName === "dict_order_status");
    assert.ok(dictTable);
    assert.equal(dictTable!.keyColumn, "code");
    assert.equal(dictTable!.valueColumn, "name");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T7c. 普通业务表不识别为字典表", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      [
        "CREATE TABLE orders (",
        "  id INTEGER PRIMARY KEY,",
        "  user_id INTEGER NOT NULL,",
        "  total DECIMAL(10,2)",
        ");",
        "",
      ].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const ordersDict = dict.dictionaryTables.find((d) => d.tableName === "orders");
    assert.equal(ordersDict, undefined, "orders 表不应识别为字典表");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T8. 字段业务语义推断
// ============================================================================

test("T8a. 推断 id 字段为唯一标识符", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY,", "  email VARCHAR(255) NOT NULL", ");", ""].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const idSemantics = dict.fieldSemantics.find((fs) => fs.tableName === "users" && fs.columnName === "id");
    assert.ok(idSemantics, "应推断 id 字段语义");
    assert.ok(idSemantics!.inferredSemantics.includes("唯一标识符"), "id 字段应推断为唯一标识符");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T8b. 推断 created_at 字段为记录创建时间", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY,", "  created_at TIMESTAMP NOT NULL", ");", ""].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const createdAtSemantics = dict.fieldSemantics.find(
      (fs) => fs.tableName === "users" && fs.columnName === "created_at"
    );
    assert.ok(createdAtSemantics, "应推断 created_at 字段语义");
    assert.ok(createdAtSemantics!.inferredSemantics.includes("创建时间"), "created_at 字段应推断为记录创建时间");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T8c. 推断 amount 字段为金额", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE orders (", "  id INTEGER PRIMARY KEY,", "  amount DECIMAL(10,2) NOT NULL", ");", ""].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const amountSemantics = dict.fieldSemantics.find((fs) => fs.tableName === "orders" && fs.columnName === "amount");
    assert.ok(amountSemantics, "应推断 amount 字段语义");
    assert.ok(amountSemantics!.inferredSemantics.includes("金额"), "amount 字段应推断为金额");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T9. 敏感字段识别
// ============================================================================

test("T9a. 识别 password 字段为 high 敏感", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY,", "  password VARCHAR(255) NOT NULL", ");", ""].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const passwordField = dict.sensitiveFields.find((sf) => sf.tableName === "users" && sf.columnName === "password");
    assert.ok(passwordField, "应识别 password 为敏感字段");
    assert.equal(passwordField!.sensitivity, "high");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T9b. 识别 email 字段为 medium 敏感", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY,", "  email VARCHAR(255) NOT NULL", ");", ""].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const emailField = dict.sensitiveFields.find((sf) => sf.tableName === "users" && sf.columnName === "email");
    assert.ok(emailField, "应识别 email 为敏感字段");
    assert.equal(emailField!.sensitivity, "medium");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T9c. 识别 name 字段为 low 敏感", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY,", "  name VARCHAR(100) NOT NULL", ");", ""].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const nameField = dict.sensitiveFields.find((sf) => sf.tableName === "users" && sf.columnName === "name");
    assert.ok(nameField, "应识别 name 为敏感字段");
    assert.equal(nameField!.sensitivity, "low");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T9d. 敏感字段含脱敏规则", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY,", "  password VARCHAR(255) NOT NULL", ");", ""].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    const passwordField = dict.sensitiveFields.find((sf) => sf.tableName === "users" && sf.columnName === "password");
    assert.ok(passwordField);
    assert.ok(passwordField!.desensitizationRule !== undefined, "password 字段应有脱敏规则");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T10. 不可变性
// ============================================================================

test("T10a. DataDictionary 顶层冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    assert.equal(Object.isFrozen(dict), true, "DataDictionary 应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T10b. enums 数组冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/enums.ts",
      ["export enum OrderStatus {", "  PENDING = 1,", "  PAID = 2,", "}", ""].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    assert.equal(Object.isFrozen(dict.enums), true, "enums 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T10c. dictionaryTables 数组冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      [
        "CREATE TABLE dict_order_status (",
        "  code VARCHAR(20) PRIMARY KEY,",
        "  name VARCHAR(50) NOT NULL",
        ");",
        "",
      ].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    assert.equal(Object.isFrozen(dict.dictionaryTables), true, "dictionaryTables 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T10d. fieldSemantics 数组冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    assert.equal(Object.isFrozen(dict.fieldSemantics), true, "fieldSemantics 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T10e. sensitiveFields 数组冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY,", "  password VARCHAR(255) NOT NULL", ");", ""].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    assert.equal(Object.isFrozen(dict.sensitiveFields), true, "sensitiveFields 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T10f. 单个 enum 对象冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/enums.ts",
      ["export enum OrderStatus {", "  PENDING = 1,", "  PAID = 2,", "}", ""].join("\n")
    );
    const extractor = new DataDictionaryExtractor();
    const dict = await extractor.extract(tmpDir);
    for (const e of dict.enums) {
      assert.equal(Object.isFrozen(e), true, "每个 enum 对象应冻结");
    }
  } finally {
    await removeTempDir(tmpDir);
  }
});
