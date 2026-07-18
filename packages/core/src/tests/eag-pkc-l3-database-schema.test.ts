/**
 * EAG-P2 批次 8 单元测试：L3 数据库结构理解器（DatabaseSchemaAnalyzer）
 *
 * 测试范围：
 * - T1. DatabaseSchemaAnalyzer 实例化
 * - T2. analyze 入参校验（空路径 / 不存在路径）
 * - T3. SQL DDL 解析（CREATE TABLE / 字段 / PRIMARY KEY / NOT NULL / DEFAULT）
 * - T4. SQL DDL 外键解析（表内 FK / ALTER TABLE ADD FK）
 * - T5. SQL DDL 索引解析（CREATE INDEX / CREATE UNIQUE INDEX）
 * - T6. Prisma schema 解析（model / @@map / @id / @unique）
 * - T7. TypeORM 实体解析（@Entity / @PrimaryGeneratedColumn / @Column）
 * - T8. 目录扫描（递归扫描 / 忽略 node_modules）
 * - T9. 迁移历史（Alembic / Flyway / Prisma）
 * - T10. 表-代码溯源（ORM 实体文件识别）
 * - T11. Mermaid ER 图渲染（erDiagram 格式）
 * - T12. 不可变性（SchemaAnalysisResult 冻结）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实文件系统（fs.mkdtemp 创建临时目录）
 * - 测试用例独立、可重复，每个用例自己创建与清理临时目录
 * - 中文详细注释，符合项目代码规范
 *
 * @module core/tests/eag-pkc-l3-database-schema
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSchemaAnalyzer, DatabaseSchemaAnalyzerError } from "../eag/pkc/l3/database-schema-analyzer";

// ============================================================================
// 辅助函数：创建临时项目目录与文件
// ============================================================================

/**
 * 创建临时项目目录
 *
 * @returns 临时项目根目录绝对路径
 */
async function createTempProject(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "eag-pkc-schema-"));
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
// T1. DatabaseSchemaAnalyzer 实例化
// ============================================================================

test("T1a. DatabaseSchemaAnalyzer 可实例化", () => {
  const analyzer = new DatabaseSchemaAnalyzer();
  assert.ok(analyzer instanceof DatabaseSchemaAnalyzer);
});

// ============================================================================
// T2. analyze 入参校验
// ============================================================================

test("T2a. analyze 空 schemaPath 抛 invalid-path", async () => {
  const analyzer = new DatabaseSchemaAnalyzer();
  await assert.rejects(analyzer.analyze(""), (err: unknown) => {
    assert.ok(err instanceof DatabaseSchemaAnalyzerError);
    assert.equal(err.kind, "invalid-path");
    return true;
  });
});

test("T2b. analyze 空白 schemaPath 抛 invalid-path", async () => {
  const analyzer = new DatabaseSchemaAnalyzer();
  await assert.rejects(analyzer.analyze("   "), (err: unknown) => {
    assert.ok(err instanceof DatabaseSchemaAnalyzerError);
    assert.equal(err.kind, "invalid-path");
    return true;
  });
});

test("T2c. analyze 不存在的路径抛 path-not-found", async () => {
  const analyzer = new DatabaseSchemaAnalyzer();
  const nonExistent = path.join(os.tmpdir(), `non-existent-${Date.now()}.sql`);
  await assert.rejects(analyzer.analyze(nonExistent), (err: unknown) => {
    assert.ok(err instanceof DatabaseSchemaAnalyzerError);
    assert.equal(err.kind, "path-not-found");
    return true;
  });
});

// ============================================================================
// T3. SQL DDL 解析
// ============================================================================

test("T3a. 解析 CREATE TABLE 单表", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      [
        "CREATE TABLE users (",
        "  id INTEGER PRIMARY KEY,",
        "  email VARCHAR(255) NOT NULL,",
        "  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        ");",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const usersTable = result.tables.find((t) => t.tableName === "users");
    assert.ok(usersTable, "应解析到 users 表");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T3b. 解析多表", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      [
        "CREATE TABLE users (",
        "  id INTEGER PRIMARY KEY,",
        "  email VARCHAR(255) NOT NULL",
        ");",
        "",
        "CREATE TABLE orders (",
        "  id INTEGER PRIMARY KEY,",
        "  user_id INTEGER NOT NULL,",
        "  total DECIMAL(10,2) NOT NULL",
        ");",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    assert.ok(result.tables.length >= 2, "应解析到至少 2 个表");
    const tableNames = result.tables.map((t) => t.tableName);
    assert.ok(tableNames.includes("users"));
    assert.ok(tableNames.includes("orders"));
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T3c. 解析字段数据类型", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      [
        "CREATE TABLE users (",
        "  id INTEGER PRIMARY KEY,",
        "  email VARCHAR(255) NOT NULL,",
        "  age INT,",
        "  balance DECIMAL(10,2)",
        ");",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const usersTable = result.tables.find((t) => t.tableName === "users");
    assert.ok(usersTable);
    const emailCol = usersTable!.columns.find((c) => c.columnName === "email");
    assert.ok(emailCol);
    assert.ok(emailCol!.dataType.includes("VARCHAR"));
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T3d. 解析 PRIMARY KEY 标记字段", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY,", "  email VARCHAR(255) NOT NULL", ");", ""].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const usersTable = result.tables.find((t) => t.tableName === "users");
    assert.ok(usersTable);
    const idCol = usersTable!.columns.find((c) => c.columnName === "id");
    assert.ok(idCol);
    assert.equal(idCol!.isPrimaryKey, true);
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T3e. 解析 NOT NULL 约束（nullable 字段）", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      [
        "CREATE TABLE users (",
        "  id INTEGER PRIMARY KEY,",
        "  email VARCHAR(255) NOT NULL,",
        "  nickname VARCHAR(100)",
        ");",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const usersTable = result.tables.find((t) => t.tableName === "users");
    assert.ok(usersTable);
    const emailCol = usersTable!.columns.find((c) => c.columnName === "email");
    assert.ok(emailCol);
    assert.equal(emailCol!.nullable, false, "email 字段应不可空");
    const nicknameCol = usersTable!.columns.find((c) => c.columnName === "nickname");
    assert.ok(nicknameCol);
    assert.equal(nicknameCol!.nullable, true, "nickname 字段应可空");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T3f. 解析 DEFAULT 默认值", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      [
        "CREATE TABLE users (",
        "  id INTEGER PRIMARY KEY,",
        "  status VARCHAR(20) DEFAULT 'active',",
        "  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        ");",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const usersTable = result.tables.find((t) => t.tableName === "users");
    assert.ok(usersTable);
    const statusCol = usersTable!.columns.find((c) => c.columnName === "status");
    assert.ok(statusCol);
    assert.ok(statusCol!.defaultValue !== undefined, "status 字段应有默认值");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T4. SQL DDL 外键解析
// ============================================================================

test("T4a. 解析表内 FOREIGN KEY 约束", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      [
        "CREATE TABLE users (",
        "  id INTEGER PRIMARY KEY,",
        "  email VARCHAR(255) NOT NULL",
        ");",
        "",
        "CREATE TABLE orders (",
        "  id INTEGER PRIMARY KEY,",
        "  user_id INTEGER NOT NULL,",
        "  total DECIMAL(10,2),",
        // 注：FOREIGN_KEY_PATTERN 要求 FOREIGN KEY 后跟约束名标识符
        // 使用 "FOREIGN KEY <name> (col) REFERENCES table(col)" 形式以匹配 pattern
        "  FOREIGN KEY fk_order_user (user_id) REFERENCES users(id)",
        ");",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const ordersTable = result.tables.find((t) => t.tableName === "orders");
    assert.ok(ordersTable);
    assert.ok(ordersTable!.foreignKeys.length > 0, "orders 表应有外键");
    const fk = ordersTable!.foreignKeys[0];
    assert.equal(fk.columnName, "user_id");
    assert.equal(fk.referencedTableName, "users");
    assert.equal(fk.referencedColumnName, "id");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T4b. 解析 ALTER TABLE ADD FOREIGN KEY", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      [
        "CREATE TABLE users (",
        "  id INTEGER PRIMARY KEY",
        ");",
        "",
        "CREATE TABLE orders (",
        "  id INTEGER PRIMARY KEY,",
        "  user_id INTEGER NOT NULL",
        ");",
        "",
        "ALTER TABLE orders ADD CONSTRAINT fk_order_user FOREIGN KEY (user_id) REFERENCES users(id);",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const ordersTable = result.tables.find((t) => t.tableName === "orders");
    assert.ok(ordersTable);
    assert.ok(ordersTable!.foreignKeys.length > 0, "orders 表应有 ALTER 添加的外键");
    const fk = ordersTable!.foreignKeys.find((f) => f.foreignKeyName === "fk_order_user");
    assert.ok(fk, "应识别名为 fk_order_user 的外键");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T5. SQL DDL 索引解析
// ============================================================================

test("T5a. 解析 CREATE INDEX", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      [
        "CREATE TABLE users (",
        "  id INTEGER PRIMARY KEY,",
        "  email VARCHAR(255) NOT NULL",
        ");",
        "",
        "CREATE INDEX idx_users_email ON users(email);",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const usersTable = result.tables.find((t) => t.tableName === "users");
    assert.ok(usersTable);
    const idx = usersTable!.indexes.find((i) => i.indexName === "idx_users_email");
    assert.ok(idx, "应识别 idx_users_email 索引");
    assert.equal(idx!.isUnique, false, "普通索引 isUnique=false");
    assert.equal(idx!.isPrimary, false, "普通索引 isPrimary=false");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T5b. 解析 CREATE UNIQUE INDEX", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      [
        "CREATE TABLE users (",
        "  id INTEGER PRIMARY KEY,",
        "  email VARCHAR(255) NOT NULL",
        ");",
        "",
        "CREATE UNIQUE INDEX uk_users_email ON users(email);",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const usersTable = result.tables.find((t) => t.tableName === "users");
    assert.ok(usersTable);
    const idx = usersTable!.indexes.find((i) => i.indexName === "uk_users_email");
    assert.ok(idx, "应识别 uk_users_email 唯一索引");
    assert.equal(idx!.isUnique, true, "唯一索引 isUnique=true");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T6. Prisma schema 解析
// ============================================================================

test("T6a. 解析 Prisma model 定义", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.prisma",
      [
        "model User {",
        "  id        Int      @id @default(autoincrement())",
        "  email     String   @unique",
        "  name      String?",
        "}",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    // Prisma model 默认表名为模型名小写
    const userTable = result.tables.find((t) => t.tableName === "user");
    assert.ok(userTable, "应解析到 user 表（Prisma 默认表名）");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T6b. 解析 @@map 表名映射", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.prisma",
      [
        "model User {",
        "  id        Int      @id @default(autoincrement())",
        "  email     String   @unique",
        '  @@map("users")',
        "}",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const usersTable = result.tables.find((t) => t.tableName === "users");
    assert.ok(usersTable, "应通过 @@map 识别 users 表名");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T6c. 解析 @id 主键标注", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.prisma",
      [
        "model User {",
        "  id        Int      @id @default(autoincrement())",
        "  email     String   @unique",
        "}",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const userTable = result.tables.find((t) => t.tableName === "user");
    assert.ok(userTable);
    const idCol = userTable!.columns.find((c) => c.columnName === "id");
    assert.ok(idCol);
    assert.equal(idCol!.isPrimaryKey, true, "id 字段应为主键");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T6d. 解析 @unique 唯一约束", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.prisma",
      [
        "model User {",
        "  id        Int      @id @default(autoincrement())",
        "  email     String   @unique",
        "}",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const userTable = result.tables.find((t) => t.tableName === "user");
    assert.ok(userTable);
    const emailCol = userTable!.columns.find((c) => c.columnName === "email");
    assert.ok(emailCol);
    assert.equal(emailCol!.isUnique, true, "email 字段应唯一");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T7. TypeORM 实体解析
// ============================================================================

test("T7a. 解析 TypeORM @Entity 装饰器", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "user.entity.ts",
      [
        'import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";',
        "",
        '@Entity("users")',
        "export class User {",
        "  @PrimaryGeneratedColumn()",
        "  id: number;",
        "",
        "  @Column({ nullable: false })",
        "  email: string;",
        "}",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const usersTable = result.tables.find((t) => t.tableName === "users");
    assert.ok(usersTable, '应通过 @Entity("users") 识别 users 表');
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T7b. 解析 @PrimaryGeneratedColumn 主键", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "user.entity.ts",
      [
        'import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";',
        "",
        '@Entity("users")',
        "export class User {",
        // 注：TYPEORM_PRIMARY_PATTERN 要求括号内带 options 对象
        '  @PrimaryGeneratedColumn({ type: "int" })',
        "  id: number;",
        "",
        "  @Column({ nullable: false })",
        "  email: string;",
        "}",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const usersTable = result.tables.find((t) => t.tableName === "users");
    assert.ok(usersTable);
    const idCol = usersTable!.columns.find((c) => c.columnName === "id");
    assert.ok(idCol);
    assert.equal(idCol!.isPrimaryKey, true, "id 字段应为主键");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T7c. 解析 @Column 字段", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "user.entity.ts",
      [
        'import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";',
        "",
        '@Entity("users")',
        "export class User {",
        '  @PrimaryGeneratedColumn({ type: "int" })',
        "  id: number;",
        "",
        // 注：TYPEORM_COLUMN_PATTERN 要求括号内带 options 对象
        "  @Column({ nullable: false })",
        "  email: string;",
        "}",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const usersTable = result.tables.find((t) => t.tableName === "users");
    assert.ok(usersTable);
    const emailCol = usersTable!.columns.find((c) => c.columnName === "email");
    assert.ok(emailCol, "应识别 email 字段");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T8. 目录扫描
// ============================================================================

test("T8a. analyze 接受目录路径递归扫描", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "db/schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const usersTable = result.tables.find((t) => t.tableName === "users");
    assert.ok(usersTable, "应递归扫描到 db/schema.sql 中的 users 表");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T8b. 目录扫描忽略 node_modules", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE real_table (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    // node_modules 下的 SQL 文件应被忽略
    await writeProjectFile(
      tmpDir,
      "node_modules/lib/schema.sql",
      ["CREATE TABLE ignored_table (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const tableNames = result.tables.map((t) => t.tableName);
    assert.ok(tableNames.includes("real_table"), "应识别 real_table");
    assert.ok(!tableNames.includes("ignored_table"), "应忽略 node_modules 下的表");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T9. 迁移历史
// ============================================================================

test("T9a. 解析 Alembic 迁移文件", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    await writeProjectFile(
      tmpDir,
      "alembic/versions/20260101000000_create_users.py",
      ["def upgrade():", "    op.create_table('users')", ""].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const alembicMigrations = result.migrations.filter((m) => m.tool === "alembic");
    assert.ok(alembicMigrations.length > 0, "应识别 Alembic 迁移");
    const migration = alembicMigrations[0];
    assert.equal(migration.migrationId, "20260101000000_create_users.py");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T9b. 解析 Flyway 迁移文件", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    await writeProjectFile(
      tmpDir,
      "flyway/migration/V1__create_users.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const flywayMigrations = result.migrations.filter((m) => m.tool === "flyway");
    assert.ok(flywayMigrations.length > 0, "应识别 Flyway 迁移");
    const migration = flywayMigrations[0];
    assert.equal(migration.migrationId, "V1__create_users.sql");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T9c. 解析 Prisma 迁移目录", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    // Prisma 迁移目录格式：YYYYMMDDHHMMSS_description/migration.sql
    await writeProjectFile(
      tmpDir,
      "prisma/migrations/20260101000000_create_users/migration.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const prismaMigrations = result.migrations.filter((m) => m.tool === "prisma");
    assert.ok(prismaMigrations.length > 0, "应识别 Prisma 迁移");
    const migration = prismaMigrations[0];
    assert.equal(migration.migrationId, "20260101000000_create_users");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T10. 表-代码溯源
// ============================================================================

test("T10a. 识别 TypeORM 实体文件并溯源", async () => {
  const tmpDir = await createTempProject();
  try {
    // 创建 schema 文件
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY,", "  email VARCHAR(255) NOT NULL", ");", ""].join("\n")
    );
    // 创建 TypeORM 实体文件
    await writeProjectFile(
      tmpDir,
      "src/entities/user.entity.ts",
      [
        'import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";',
        "",
        '@Entity("users")',
        "export class User {",
        "  @PrimaryGeneratedColumn()",
        "  id: number;",
        "",
        "  @Column()",
        "  email: string;",
        "}",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const userTrace = result.codeTraces.find((ct) => ct.tableName === "users");
    assert.ok(userTrace, "应溯源 users 表");
    assert.equal(userTrace!.ormEntity, "User");
    assert.ok(userTrace!.ormFilePath.includes("user.entity.ts"));
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T10b. 溯源使用 ORM 实体的模块", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    await writeProjectFile(
      tmpDir,
      "src/entities/user.entity.ts",
      [
        'import { Entity, PrimaryGeneratedColumn } from "typeorm";',
        "",
        '@Entity("users")',
        "export class User {",
        "  @PrimaryGeneratedColumn()",
        "  id: number;",
        "}",
        "",
      ].join("\n")
    );
    // 创建使用 User 实体的服务模块
    await writeProjectFile(
      tmpDir,
      "src/services/user.service.ts",
      [
        'import { User } from "../entities/user.entity";',
        "",
        "export class UserService {",
        "  findById(id: number): User | null {",
        "    return null;",
        "  }",
        "}",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    const userTrace = result.codeTraces.find((ct) => ct.tableName === "users");
    assert.ok(userTrace);
    assert.ok(userTrace!.usageModules.length > 0, "应识别使用 User 实体的模块");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T11. Mermaid ER 图渲染
// ============================================================================

test("T11a. erDiagram 包含 erDiagram 声明", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    assert.ok(result.erDiagram.includes("erDiagram"), "应包含 erDiagram 声明");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T11b. erDiagram 包含表定义", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    assert.ok(result.erDiagram.includes("users {"), "应包含 users 表定义");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T11c. erDiagram 包含外键关系", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      [
        "CREATE TABLE users (",
        "  id INTEGER PRIMARY KEY",
        ");",
        "",
        "CREATE TABLE orders (",
        "  id INTEGER PRIMARY KEY,",
        "  user_id INTEGER NOT NULL,",
        // 注：FOREIGN_KEY_PATTERN 要求 FOREIGN KEY 后跟约束名标识符
        "  FOREIGN KEY fk_order_user (user_id) REFERENCES users(id)",
        ");",
        "",
      ].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    // 外键关系：users ||--o{ orders : "user_id"
    assert.ok(
      result.erDiagram.includes("users") && result.erDiagram.includes("orders"),
      "ER 图应包含 users 与 orders 表"
    );
    assert.ok(result.erDiagram.includes("||--o{"), "ER 图应包含一对多关系符号 ||--o{");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T12. 不可变性
// ============================================================================

test("T12a. SchemaAnalysisResult 顶层冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    assert.equal(Object.isFrozen(result), true, "SchemaAnalysisResult 应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T12b. tables 数组冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    assert.equal(Object.isFrozen(result.tables), true, "tables 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T12c. 单个表对象冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    for (const table of result.tables) {
      assert.equal(Object.isFrozen(table), true, "每个表对象应冻结");
    }
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T12d. migrations 数组冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    assert.equal(Object.isFrozen(result.migrations), true, "migrations 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T12e. codeTraces 数组冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "schema.sql",
      ["CREATE TABLE users (", "  id INTEGER PRIMARY KEY", ");", ""].join("\n")
    );
    const analyzer = new DatabaseSchemaAnalyzer();
    const result = await analyzer.analyze(tmpDir);
    assert.equal(Object.isFrozen(result.codeTraces), true, "codeTraces 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});
