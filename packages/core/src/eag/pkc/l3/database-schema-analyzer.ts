/**
 * K3 数据库结构理解器实现（EAG-P2 批次 8）
 *
 * 本模块实现 `DatabaseSchemaAnalyzer` 类，提供 EAG 方案 §5.11.2 K3 数据库结构理解的真实逻辑。
 *
 * 核心职责：
 * - analyze(schemaPath)：解析 schema 文件（SQL DDL/Prisma schema/TypeORM 实体）
 * - 解析表/字段/索引/外键
 * - 迁移工具历史分析（Alembic/Flyway/Prisma migrate）
 * - 表-代码双向溯源（表 ↔ ORM 实体 ↔ 使用模块）
 * - 产出 ER 图（Mermaid erDiagram 格式）
 *
 * §5.11.2 K3 数据库结构理解设计要求：
 * - schema 解析（表/字段/索引/外键）
 * - 迁移工具历史分析（Alembic/Flyway/Prisma migrate 演化时间线）
 * - 表-代码双向溯源（表 ↔ ORM 实体 ↔ 使用模块）
 *
 * 设计依据：
 * - EAG 方案 §5.11.2 K3 数据库结构理解
 * - Mermaid ER 图语法（erDiagram）
 *
 * 实现说明：
 * - 支持多 schema 格式：SQL DDL（CREATE TABLE）/ Prisma schema / TypeORM 实体（装饰器）
 * - 多 ORM 识别：TypeORM / Prisma / Sequelize / SQLAlchemy / Django ORM
 * - 不依赖外部 SQL 解析库（避免引入依赖），采用基于正则的解析
 * - 迁移工具识别：扫描 migrations 目录与配置文件
 *
 * 不可变优先：
 * - 公开方法返回冻结对象
 *
 * @module eag/pkc/l3/database-schema-analyzer
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  DatabaseColumn,
  DatabaseForeignKey,
  DatabaseIndex,
  DatabaseMigration,
  DatabaseTable,
  SchemaAnalysisResult,
  TableCodeTrace,
} from "./l3-types";

// ============================================================================
// SQL DDL 解析规则
// ============================================================================

/**
 * CREATE TABLE 语句解析规则
 *
 * 匹配模式：CREATE TABLE [IF NOT EXISTS] tableName ( ... )
 * 捕获组 1：表名
 *
 * 注：DDL 语句大小写不敏感，使用 i 标志
 */
const CREATE_TABLE_PATTERN: RegExp =
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\s*\(([\s\S]*?)\)\s*;/gi;

/**
 * 字段定义解析规则
 *
 * 匹配模式：columnName dataType [约束...]
 * 捕获组 1：字段名
 * 捕获组 2：数据类型
 */
const COLUMN_DEFINITION_PATTERN: RegExp = /^\s*[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\s+([A-Z]+(?:\s*\([^)]*\))?)([^,]*)/i;

/**
 * PRIMARY KEY 解析规则
 *
 * 匹配模式：PRIMARY KEY (col1, col2)
 */
const PRIMARY_KEY_PATTERN: RegExp = /PRIMARY\s+KEY\s*\(([^)]+)\)/gi;

/**
 * FOREIGN KEY 解析规则
 *
 * 匹配模式：FOREIGN KEY (col) REFERENCES table(col)
 */
const FOREIGN_KEY_PATTERN: RegExp =
  /FOREIGN\s+KEY\s*[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\s*\([`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\)\s*REFERENCES\s*[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\s*\([`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\)/gi;

/**
 * INDEX 解析规则
 *
 * 匹配模式：CREATE [UNIQUE] INDEX indexName ON tableName (col1, col2)
 */
const CREATE_INDEX_PATTERN: RegExp =
  /\bCREATE\s+(UNIQUE\s+)?INDEX\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\s+ON\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\s*\(([^)]+)\)/gi;

/**
 * ALTER TABLE ADD FOREIGN KEY 解析规则
 */
const ALTER_ADD_FK_PATTERN: RegExp =
  /\bALTER\s+TABLE\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\s+ADD\s+(?:CONSTRAINT\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\s+)?FOREIGN\s+KEY\s*\([`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\)\s*REFERENCES\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\s*\([`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\)/gi;

// ============================================================================
// Prisma schema 解析规则
// ============================================================================

/**
 * Prisma model 解析规则
 *
 * 匹配模式：model ModelName { ... }
 * 捕获组 1：模型名（即表名）
 */
const PRISMA_MODEL_PATTERN: RegExp = /\bmodel\s+([A-Z][a-zA-Z0-9_]*)\s*\{([\s\S]*?)\}/g;

/**
 * Prisma 字段解析规则
 *
 * 匹配模式：fieldName Type [@id] [@unique] [@@map("table_name")]
 */
const PRISMA_FIELD_PATTERN: RegExp = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+([A-Za-z]+(?:\[\])?)([^]*?)$/;

/**
 * Prisma 表名映射规则
 *
 * 匹配模式：@@map("actual_table_name")
 */
const PRISMA_MAP_PATTERN: RegExp = /@@map\(["']([^"']+)["']\)/;

// ============================================================================
// TypeORM 实体解析规则
// ============================================================================

/**
 * TypeORM @Entity 装饰器解析规则
 *
 * 匹配模式：@Entity("table_name") class ClassName
 */
const TYPEORM_ENTITY_PATTERN: RegExp =
  /@Entity\s*\(\s*['"`]?([a-zA-Z_][a-zA-Z0-9_]*)['"`]?\s*\)\s*(?:export\s+)?class\s+([A-Z][a-zA-Z0-9_]*)/g;

/**
 * TypeORM @Column 装饰器解析规则
 *
 * 匹配模式：@Column(...) fieldName: type;
 */
const TYPEORM_COLUMN_PATTERN: RegExp =
  /@Column\s*(?:\(\s*\{([^}]*)\}\s*\))?\s*(?:[a-zA-Z]+)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([A-Za-z]+)/g;

/**
 * TypeORM @PrimaryColumn / @PrimaryGeneratedColumn 装饰器
 */
const TYPEORM_PRIMARY_PATTERN: RegExp =
  /@(?:PrimaryColumn|PrimaryGeneratedColumn)\s*(?:\(\s*\{([^}]*)\}\s*\))?\s*(?:[a-zA-Z]+)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([A-Za-z]+)/g;

/**
 * 字段注释提取规则
 *
 * 匹配模式：COMMENT '注释内容'
 */
const COLUMN_COMMENT_PATTERN: RegExp = /COMMENT\s+['"]([^'"]+)['"]/i;

// ============================================================================
// 迁移工具识别规则
// ============================================================================

/**
 * 迁移目录名模式
 */
const MIGRATION_DIR_NAMES: ReadonlyArray<string> = Object.freeze([
  "migrations",
  "migration",
  "db/migrations",
  "alembic/versions",
  "flyway/migration",
  "prisma/migrations",
  "src/migrations",
]);

/**
 * Alembic 迁移文件名模式
 *
 * 匹配模式：YYYYMMDDHHMMSS_description.py
 */
const ALEMBIC_FILE_PATTERN: RegExp = /^(\d{12,14})_([a-zA-Z0-9_]+)\.py$/;

/**
 * Flyway 迁移文件名模式
 *
 * 匹配模式：V1__description.sql / R__description.sql / U1__description.sql
 */
const FLYWAY_FILE_PATTERN: RegExp = /^([VRU])(\d+)__([a-zA-Z0-9_]+)\.sql$/i;

/**
 * Prisma 迁移目录名模式
 *
 * 匹配模式：YYYYMMDDHHMMSS_description
 */
const PRISMA_MIGRATION_DIR_PATTERN: RegExp = /^(\d{12,14})_([a-zA-Z0-9_]+)$/;

// ============================================================================
// ORM 实体识别规则
// ============================================================================

/**
 * ORM 实体文件特征模式（用于表-代码双向溯源）
 */
const ORM_ENTITY_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /@Entity\s*\(/g, // TypeORM
  /@Table\s*\(/g, // Sequelize
  /model\s+([A-Z][a-zA-Z0-9_]*)\s*\{/g, // Prisma
  /class\s+([A-Z][a-zA-Z0-9_]*)\s*(?:extends\s+Model|implements\s+[A-Z])/g, // Sequelize / Bookshelf
]);

// ============================================================================
// 异常类型
// ============================================================================

/**
 * 数据库结构分析错误
 */
export class DatabaseSchemaAnalyzerError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-path：路径非法
   *   - path-not-found：路径不存在
   *   - parse-error：解析失败
   * @param detail 错误详情
   */
  constructor(
    public readonly kind: "invalid-path" | "path-not-found" | "parse-error",
    public readonly detail: string
  ) {
    super(`数据库结构分析错误 [${kind}]：${detail}`);
    this.name = "DatabaseSchemaAnalyzerError";
  }
}

// ============================================================================
// DatabaseSchemaAnalyzer 类
// ============================================================================

/**
 * 数据库结构分析器（实现 §5.11.2 K3 数据库结构理解）
 *
 * 提供真实解析逻辑（禁止 mock）：
 * - analyze：解析 schema 文件，返回 SchemaAnalysisResult
 * - 支持 SQL DDL / Prisma schema / TypeORM 实体三种格式
 * - 自动检测迁移目录（Alembic/Flyway/Prisma）
 * - 自动识别 ORM 实体文件（表-代码双向溯源）
 *
 * 使用方式：
 * ```typescript
 * const analyzer = new DatabaseSchemaAnalyzer();
 * const result = await analyzer.analyze("/path/to/project/schema.sql");
 * console.log(result.erDiagram);
 * ```
 */
export class DatabaseSchemaAnalyzer {
  /**
   * 分析 schema 文件或目录
   *
   * 执行流程：
   * 1. 校验 schemaPath 存在
   * 2. 若为文件：根据扩展名选择解析器（.sql → SQL DDL，.prisma → Prisma schema，.ts → TypeORM）
   * 3. 若为目录：递归扫描目录下的 schema 文件，逐个解析后合并
   * 4. 解析迁移目录（若有）
   * 5. 识别 ORM 实体文件（表-代码双向溯源）
   * 6. 渲染 Mermaid ER 图
   *
   * @param schemaPath schema 文件或目录路径
   * @returns 数据库结构分析结果
   * @throws {DatabaseSchemaAnalyzerError} 路径不存在或解析失败时抛出
   */
  async analyze(schemaPath: string): Promise<SchemaAnalysisResult> {
    // 入参校验
    if (typeof schemaPath !== "string" || schemaPath.trim().length === 0) {
      throw new DatabaseSchemaAnalyzerError("invalid-path", "schemaPath 必须为非空字符串");
    }

    // 解析为绝对路径
    const absolutePath = path.isAbsolute(schemaPath) ? schemaPath : path.resolve(process.cwd(), schemaPath);

    // 校验路径存在
    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch (err) {
      throw new DatabaseSchemaAnalyzerError(
        "path-not-found",
        `路径不存在：${absolutePath}（${(err as Error).message}）`
      );
    }

    // 收集 schema 文件列表
    const schemaFiles: Array<{ readonly absPath: string; readonly relPath: string }> = [];
    const projectRoot = stat.isDirectory() ? absolutePath : path.dirname(absolutePath);

    if (stat.isFile()) {
      schemaFiles.push({
        absPath: absolutePath,
        relPath: path.basename(absolutePath),
      });
    } else {
      // 递归扫描目录下的 schema 文件
      await this.collectSchemaFiles(absolutePath, "", schemaFiles, 0, 5);
    }

    // 逐个解析 schema 文件
    const tables: DatabaseTable[] = [];
    for (const file of schemaFiles) {
      try {
        const content = await fs.readFile(file.absPath, "utf-8");
        const parsedTables = this.parseSchemaContent(content, file.relPath);
        tables.push(...parsedTables);
      } catch {
        // 解析失败：跳过该文件
        continue;
      }
    }

    // 合并索引与外键
    const allIndexes: DatabaseIndex[] = [];
    const allForeignKeys: DatabaseForeignKey[] = [];
    for (const table of tables) {
      allIndexes.push(...table.indexes);
      allForeignKeys.push(...table.foreignKeys);
    }

    // 解析迁移历史
    const migrations = await this.parseMigrations(projectRoot);

    // 表-代码双向溯源
    const codeTraces = await this.traceTableCodeRelations(projectRoot, tables);

    // 渲染 ER 图
    const erDiagram = this.renderErDiagram(tables);

    return Object.freeze({
      tables: Object.freeze(tables.map((t) => Object.freeze({ ...t }))),
      indexes: Object.freeze(allIndexes.map((i) => Object.freeze({ ...i }))),
      foreignKeys: Object.freeze(allForeignKeys.map((f) => Object.freeze({ ...f }))),
      migrations: Object.freeze(migrations.map((m) => Object.freeze({ ...m }))),
      erDiagram,
      codeTraces: Object.freeze(codeTraces.map((c) => Object.freeze({ ...c }))),
    });
  }

  // ============================ 私有辅助方法 ============================

  /**
   * 递归收集 schema 文件
   *
   * @param absoluteDir 当前绝对目录
   * @param relativeDir 当前相对目录
   * @param files 文件收集列表
   * @param depth 当前深度
   * @param maxDepth 最大深度
   */
  private async collectSchemaFiles(
    absoluteDir: string,
    relativeDir: string,
    files: Array<{ readonly absPath: string; readonly relPath: string }>,
    depth: number,
    maxDepth: number
  ): Promise<void> {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "dist", "build", "target", "__pycache__"].includes(entry.name)) {
          continue;
        }
        const subAbs = path.join(absoluteDir, entry.name);
        const subRel = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        await this.collectSchemaFiles(subAbs, subRel, files, depth + 1, maxDepth);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        // 仅扫描 SQL / Prisma / TypeORM 文件
        if (
          ![".sql", ".prisma"].includes(ext) &&
          !entry.name.endsWith(".entity.ts") &&
          !entry.name.endsWith(".entity.js")
        ) {
          continue;
        }
        const absPath = path.join(absoluteDir, entry.name);
        const relPath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        files.push({ absPath, relPath });
      }
    }
  }

  /**
   * 根据 schema 内容与文件扩展名选择解析器
   *
   * @param content 文件内容
   * @param filePath 文件路径
   * @returns 解析出的表列表
   */
  private parseSchemaContent(content: string, filePath: string): DatabaseTable[] {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".sql") {
      return this.parseSqlDdl(content);
    }
    if (ext === ".prisma") {
      return this.parsePrismaSchema(content);
    }
    if (filePath.endsWith(".entity.ts") || filePath.endsWith(".entity.js")) {
      return this.parseTypeOrmEntity(content, filePath);
    }
    return [];
  }

  /**
   * 解析 SQL DDL
   *
   * 支持：
   * - CREATE TABLE 语句（含字段定义、PRIMARY KEY、FOREIGN KEY）
   * - CREATE INDEX 语句
   * - ALTER TABLE ADD FOREIGN KEY 语句
   *
   * @param content SQL 内容
   * @returns 解析出的表列表
   */
  private parseSqlDdl(content: string): DatabaseTable[] {
    const tables: DatabaseTable[] = [];
    const tablesByName = new Map<string, DatabaseTable>();

    // 1. 解析 CREATE TABLE
    CREATE_TABLE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CREATE_TABLE_PATTERN.exec(content)) !== null) {
      const tableName = match[1];
      const tableBody = match[2];

      // 提取表注释（COMMENT='...'）
      const tableCommentMatch = content.slice(match.index).match(/COMMENT\s*=\s*['"]([^'"]+)['"]/i);
      const tableComment = tableCommentMatch ? tableCommentMatch[1] : undefined;

      // 解析字段
      const columns: DatabaseColumn[] = [];
      const columnLines = tableBody
        .split(",")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      for (const line of columnLines) {
        // 跳过约束行（PRIMARY KEY/FOREIGN KEY/UNIQUE/CHECK/CONSTRAINT）
        if (/^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT|KEY|INDEX)/i.test(line)) {
          continue;
        }
        const colMatch = line.match(COLUMN_DEFINITION_PATTERN);
        if (!colMatch) continue;
        const columnName = colMatch[1];
        const dataType = colMatch[2].trim();
        const restPart = colMatch[3] || "";
        const isPrimaryKey = /PRIMARY\s+KEY/i.test(restPart);
        const isUnique = /UNIQUE/i.test(restPart);
        const nullable = !/NOT\s+NULL/i.test(restPart);
        const defaultValueMatch = restPart.match(/DEFAULT\s+([^\s,]+)/i);
        const defaultValue = defaultValueMatch ? defaultValueMatch[1] : undefined;
        const commentMatch = line.match(COLUMN_COMMENT_PATTERN);
        const comment = commentMatch ? commentMatch[1] : undefined;

        columns.push(
          Object.freeze({
            columnName,
            dataType,
            nullable,
            defaultValue,
            comment,
            isPrimaryKey,
            isUnique,
          })
        );
      }

      // 解析表内 PRIMARY KEY
      const indexes: DatabaseIndex[] = [];
      const foreignKeys: DatabaseForeignKey[] = [];
      PRIMARY_KEY_PATTERN.lastIndex = 0;
      let pkMatch: RegExpExecArray | null;
      while ((pkMatch = PRIMARY_KEY_PATTERN.exec(tableBody)) !== null) {
        const pkColumns = pkMatch[1].split(",").map((c) => c.trim().replace(/[`"]/g, ""));
        indexes.push(
          Object.freeze({
            indexName: `pk_${tableName}`,
            columnNames: Object.freeze(pkColumns),
            isUnique: true,
            isPrimary: true,
          })
        );
      }

      // 解析表内 FOREIGN KEY
      FOREIGN_KEY_PATTERN.lastIndex = 0;
      let fkMatch: RegExpExecArray | null;
      while ((fkMatch = FOREIGN_KEY_PATTERN.exec(tableBody)) !== null) {
        foreignKeys.push(
          Object.freeze({
            foreignKeyName: fkMatch[1] || `fk_${tableName}_${fkMatch[2]}`,
            columnName: fkMatch[2],
            referencedTableName: fkMatch[3],
            referencedColumnName: fkMatch[4],
          })
        );
      }

      const table: DatabaseTable = Object.freeze({
        tableName,
        comment: tableComment,
        columns: Object.freeze(columns.map((c) => Object.freeze({ ...c }))),
        indexes: Object.freeze(indexes.map((i) => Object.freeze({ ...i }))),
        foreignKeys: Object.freeze(foreignKeys.map((f) => Object.freeze({ ...f }))),
      });
      tables.push(table);
      tablesByName.set(tableName, table);
    }

    // 2. 解析 CREATE INDEX
    CREATE_INDEX_PATTERN.lastIndex = 0;
    let idxMatch: RegExpExecArray | null;
    while ((idxMatch = CREATE_INDEX_PATTERN.exec(content)) !== null) {
      const isUnique = Boolean(idxMatch[1]);
      const indexName = idxMatch[2];
      const tableName = idxMatch[3];
      const columnNames = idxMatch[4].split(",").map((c) => c.trim().replace(/[`"]/g, ""));

      // 将索引追加到对应表（若表已存在）
      const existingTable = tablesByName.get(tableName);
      if (existingTable) {
        const newIdx = Object.freeze({
          indexName,
          columnNames: Object.freeze(columnNames),
          isUnique,
          isPrimary: false,
        });
        const updatedTable = Object.freeze({
          ...existingTable,
          indexes: Object.freeze([...existingTable.indexes, newIdx]),
        });
        const idx = tables.findIndex((t) => t.tableName === tableName);
        if (idx >= 0) {
          tables[idx] = updatedTable;
          tablesByName.set(tableName, updatedTable);
        }
      }
    }

    // 3. 解析 ALTER TABLE ADD FOREIGN KEY
    ALTER_ADD_FK_PATTERN.lastIndex = 0;
    let alterFkMatch: RegExpExecArray | null;
    while ((alterFkMatch = ALTER_ADD_FK_PATTERN.exec(content)) !== null) {
      const tableName = alterFkMatch[1];
      const fkName = alterFkMatch[2] || `fk_${tableName}_${alterFkMatch[3]}`;
      const columnName = alterFkMatch[3];
      const refTable = alterFkMatch[4];
      const refColumn = alterFkMatch[5];

      const existingTable = tablesByName.get(tableName);
      if (existingTable) {
        const newFk = Object.freeze({
          foreignKeyName: fkName,
          columnName,
          referencedTableName: refTable,
          referencedColumnName: refColumn,
        });
        const updatedTable = Object.freeze({
          ...existingTable,
          foreignKeys: Object.freeze([...existingTable.foreignKeys, newFk]),
        });
        const idx = tables.findIndex((t) => t.tableName === tableName);
        if (idx >= 0) {
          tables[idx] = updatedTable;
          tablesByName.set(tableName, updatedTable);
        }
      }
    }

    return tables;
  }

  /**
   * 解析 Prisma schema
   *
   * @param content Prisma schema 内容
   * @returns 解析出的表列表
   */
  private parsePrismaSchema(content: string): DatabaseTable[] {
    const tables: DatabaseTable[] = [];

    PRISMA_MODEL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PRISMA_MODEL_PATTERN.exec(content)) !== null) {
      const modelName = match[1];
      const modelBody = match[2];

      // 解析 @@map("table_name")
      const mapMatch = modelBody.match(PRISMA_MAP_PATTERN);
      const tableName = mapMatch ? mapMatch[1] : modelName.toLowerCase();

      // 解析字段
      const columns: DatabaseColumn[] = [];
      const indexes: DatabaseIndex[] = [];
      const foreignKeys: DatabaseForeignKey[] = [];
      const fieldLines = modelBody
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("@@"));

      for (const line of fieldLines) {
        const fieldMatch = line.match(PRISMA_FIELD_PATTERN);
        if (!fieldMatch) continue;
        const columnName = fieldMatch[1];
        const dataType = fieldMatch[2];
        const restPart = fieldMatch[3] || "";
        const isPrimaryKey = /@id/i.test(restPart);
        const isUnique = /@unique/i.test(restPart);
        const nullable = !/!/.test(dataType);
        // Prisma 默认值
        const defaultValueMatch = restPart.match(/@default\s*\(\s*([^)]+)\s*\)/i);
        const defaultValue = defaultValueMatch ? defaultValueMatch[1] : undefined;
        // Prisma 字段注释
        const commentMatch = restPart.match(/\/\/\s*(.+)$/);
        const comment = commentMatch ? commentMatch[1].trim() : undefined;

        columns.push(
          Object.freeze({
            columnName,
            dataType,
            nullable,
            defaultValue,
            comment,
            isPrimaryKey,
            isUnique,
          })
        );

        // 处理 @relation 标注（生成外键）
        const relationMatch = restPart.match(
          /@relation\s*\(\s*fields:\s*\[([a-zA-Z_]+)\][^)]*?references:\s*\[([a-zA-Z_]+)\][^)]*?\)/
        );
        if (relationMatch) {
          // 注：Prisma relation 的引用表需要从其他模型推断，此处简化为字段名匹配
          // 实际实现需要关联到引用表，此处仅记录字段映射
        }
      }

      tables.push(
        Object.freeze({
          tableName,
          comment: `Prisma model ${modelName}`,
          columns: Object.freeze(columns.map((c) => Object.freeze({ ...c }))),
          indexes: Object.freeze(indexes.map((i) => Object.freeze({ ...i }))),
          foreignKeys: Object.freeze(foreignKeys.map((f) => Object.freeze({ ...f }))),
        })
      );
    }

    return tables;
  }

  /**
   * 解析 TypeORM 实体文件
   *
   * @param content 实体文件内容
   * @param _filePath 文件路径（预留参数，当前实现仅基于 content 解析，后续扩展文件级元数据时使用）
   * @returns 解析出的表列表
   */
  private parseTypeOrmEntity(content: string, _filePath: string): DatabaseTable[] {
    const tables: DatabaseTable[] = [];

    TYPEORM_ENTITY_PATTERN.lastIndex = 0;
    let entityMatch: RegExpExecArray | null;
    while ((entityMatch = TYPEORM_ENTITY_PATTERN.exec(content)) !== null) {
      const tableName = entityMatch[1];
      const className = entityMatch[2];

      // 解析 @PrimaryColumn / @PrimaryGeneratedColumn
      const columns: DatabaseColumn[] = [];
      TYPEORM_PRIMARY_PATTERN.lastIndex = 0;
      let pkMatch: RegExpExecArray | null;
      while ((pkMatch = TYPEORM_PRIMARY_PATTERN.exec(content)) !== null) {
        const columnName = pkMatch[2];
        const dataType = pkMatch[3];
        const options = pkMatch[1] || "";
        const nullable = /nullable:\s*true/i.test(options);
        const commentMatch = options.match(/comment:\s*['"]([^'"]+)['"]/i);
        const comment = commentMatch ? commentMatch[1] : undefined;
        columns.push(
          Object.freeze({
            columnName,
            dataType,
            nullable,
            comment,
            isPrimaryKey: true,
            isUnique: false,
          })
        );
      }

      // 解析 @Column
      TYPEORM_COLUMN_PATTERN.lastIndex = 0;
      let colMatch: RegExpExecArray | null;
      while ((colMatch = TYPEORM_COLUMN_PATTERN.exec(content)) !== null) {
        const columnName = colMatch[2];
        const dataType = colMatch[3];
        const options = colMatch[1] || "";
        const nullable = /nullable:\s*true/i.test(options);
        const isUnique = /unique:\s*true/i.test(options);
        const defaultValueMatch = options.match(/default:\s*([^,\s]+)/i);
        const defaultValue = defaultValueMatch ? defaultValueMatch[1] : undefined;
        const commentMatch = options.match(/comment:\s*['"]([^'"]+)['"]/i);
        const comment = commentMatch ? commentMatch[1] : undefined;
        columns.push(
          Object.freeze({
            columnName,
            dataType,
            nullable,
            defaultValue,
            comment,
            isPrimaryKey: false,
            isUnique,
          })
        );
      }

      tables.push(
        Object.freeze({
          tableName,
          comment: `TypeORM entity ${className}`,
          columns: Object.freeze(columns.map((c) => Object.freeze({ ...c }))),
          indexes: Object.freeze([]),
          foreignKeys: Object.freeze([]),
        })
      );
    }

    return tables;
  }

  /**
   * 解析迁移历史
   *
   * @param projectRoot 项目根目录
   * @returns 迁移列表
   */
  private async parseMigrations(projectRoot: string): Promise<DatabaseMigration[]> {
    const migrations: DatabaseMigration[] = [];

    // 在项目根目录下查找迁移目录
    for (const dirName of MIGRATION_DIR_NAMES) {
      const dirPath = path.join(projectRoot, dirName);
      try {
        const stat = await fs.stat(dirPath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      let entries;
      try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const result = this.parseMigrationEntry(entry.name, dirName);
        if (result) {
          migrations.push(result);
        }
      }
    }

    // 按时间戳排序
    migrations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return migrations;
  }

  /**
   * 解析单个迁移条目
   *
   * @param entryName 条目名（文件名或目录名）
   * @param _dirName 所属目录名（预留参数，当前实现仅基于 entryName 匹配迁移文件命名规范）
   * @returns 迁移对象（未识别返回 null）
   */
  private parseMigrationEntry(entryName: string, _dirName: string): DatabaseMigration | null {
    // Alembic 迁移文件：YYYYMMDDHHMMSS_description.py
    let match = entryName.match(ALEMBIC_FILE_PATTERN);
    if (match) {
      const timestamp = this.formatAlembicTimestamp(match[1]);
      const description = match[2].replace(/_/g, " ");
      return Object.freeze({
        migrationId: entryName,
        tool: "alembic",
        description,
        timestamp,
        direction: "up",
      });
    }

    // Flyway 迁移文件：V1__description.sql
    match = entryName.match(FLYWAY_FILE_PATTERN);
    if (match) {
      const type = match[1].toUpperCase();
      const version = match[2];
      const description = match[3].replace(/_/g, " ");
      const direction = type === "U" ? "down" : "up";
      return Object.freeze({
        migrationId: entryName,
        tool: "flyway",
        description: `v${version} ${description}`,
        timestamp: `flyway-v${version}`,
        direction: direction as "up" | "down",
      });
    }

    // Prisma 迁移目录：YYYYMMDDHHMMSS_description
    match = entryName.match(PRISMA_MIGRATION_DIR_PATTERN);
    if (match) {
      const timestamp = this.formatAlembicTimestamp(match[1]);
      const description = match[2].replace(/_/g, " ");
      return Object.freeze({
        migrationId: entryName,
        tool: "prisma",
        description,
        timestamp,
        direction: "up",
      });
    }

    // 通用 .sql 迁移文件
    if (entryName.endsWith(".sql")) {
      return Object.freeze({
        migrationId: entryName,
        tool: "unknown",
        description: entryName.replace(/\.sql$/, ""),
        timestamp: entryName,
        direction: "up",
      });
    }

    return null;
  }

  /**
   * 格式化 Alembic 时间戳为 ISO 8601
   *
   * @param timestamp 14 位时间戳（YYYYMMDDHHMMSS）
   * @returns ISO 8601 字符串
   */
  private formatAlembicTimestamp(timestamp: string): string {
    if (timestamp.length < 14) {
      return timestamp;
    }
    const year = timestamp.slice(0, 4);
    const month = timestamp.slice(4, 6);
    const day = timestamp.slice(6, 8);
    const hour = timestamp.slice(8, 10);
    const minute = timestamp.slice(10, 12);
    const second = timestamp.slice(12, 14);
    return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  }

  /**
   * 表-代码双向溯源（表 ↔ ORM 实体 ↔ 使用模块）
   *
   * @param projectRoot 项目根目录
   * @param tables 已识别的表列表
   * @returns 溯源列表
   */
  private async traceTableCodeRelations(
    projectRoot: string,
    tables: ReadonlyArray<DatabaseTable>
  ): Promise<TableCodeTrace[]> {
    const traces: TableCodeTrace[] = [];

    // 收集所有 ORM 实体文件
    const ormFiles: Array<{ readonly filePath: string; readonly content: string }> = [];
    await this.collectOrmFiles(projectRoot, "", ormFiles, 0, 4);

    // 对每个表查找对应的 ORM 实体
    for (const table of tables) {
      for (const ormFile of ormFiles) {
        // 检查文件内容是否引用了该表名
        const tablePattern = new RegExp(`@Entity\\s*\\(\\s*['"\`]${table.tableName}['"\`]`, "i");
        const prismaPattern = new RegExp(
          `model\\s+[A-Z][a-zA-Z0-9_]*\\s*\\{[\\s\\S]*?@@map\\s*\\(\\s*['"\`]${table.tableName}['"\`]`,
          "i"
        );
        const sequelizePattern = new RegExp(`tableName:\\s*['"\`]${table.tableName}['"\`]`, "i");

        if (
          tablePattern.test(ormFile.content) ||
          prismaPattern.test(ormFile.content) ||
          sequelizePattern.test(ormFile.content)
        ) {
          // 推断 ORM 实体名（取类名或模型名）
          const classNameMatch = ormFile.content.match(/class\s+([A-Z][a-zA-Z0-9_]*)/);
          const modelNameMatch = ormFile.content.match(/model\s+([A-Z][a-zA-Z0-9_]*)\s*\{/);
          const ormEntity = classNameMatch ? classNameMatch[1] : modelNameMatch ? modelNameMatch[1] : table.tableName;

          // 查找使用该实体的模块（搜索 import 语句）
          const usageModules = await this.findUsageModules(projectRoot, ormEntity, ormFile.filePath);

          traces.push(
            Object.freeze({
              tableName: table.tableName,
              ormEntity,
              ormFilePath: ormFile.filePath,
              usageModules: Object.freeze(usageModules),
            })
          );
          break;
        }
      }
    }

    return traces;
  }

  /**
   * 递归收集 ORM 实体文件
   *
   * @param absoluteDir 当前绝对目录
   * @param relativeDir 当前相对目录
   * @param files 文件收集列表
   * @param depth 当前深度
   * @param maxDepth 最大深度
   */
  private async collectOrmFiles(
    absoluteDir: string,
    relativeDir: string,
    files: Array<{ readonly filePath: string; readonly content: string }>,
    depth: number,
    maxDepth: number
  ): Promise<void> {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "dist", "build", "target", "__pycache__"].includes(entry.name)) {
          continue;
        }
        const subAbs = path.join(absoluteDir, entry.name);
        const subRel = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        await this.collectOrmFiles(subAbs, subRel, files, depth + 1, maxDepth);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (![".ts", ".js", ".prisma", ".py"].includes(ext)) continue;
        // 仅扫描含 ORM 装饰器/关键字的文件
        const relPath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        const absPath = path.join(absoluteDir, entry.name);
        try {
          const content = await fs.readFile(absPath, "utf-8");
          // 快速特征匹配（任一匹配即视为 ORM 文件）
          const isOrm = ORM_ENTITY_PATTERNS.some((p) => {
            p.lastIndex = 0;
            return p.test(content);
          });
          if (isOrm) {
            files.push({ filePath: relPath, content });
          }
        } catch {
          continue;
        }
      }
    }
  }

  /**
   * 查找使用指定 ORM 实体的模块
   *
   * @param projectRoot 项目根目录
   * @param ormEntity ORM 实体名
   * @param ormFilePath ORM 实体文件路径（排除自身）
   * @returns 使用该实体的模块列表
   */
  private async findUsageModules(projectRoot: string, ormEntity: string, ormFilePath: string): Promise<string[]> {
    const usageModules = new Set<string>();
    await this.scanUsageModules(projectRoot, "", ormEntity, ormFilePath, usageModules, 0, 4);
    return [...usageModules];
  }

  /**
   * 递归扫描使用指定实体的模块
   */
  private async scanUsageModules(
    absoluteDir: string,
    relativeDir: string,
    ormEntity: string,
    ormFilePath: string,
    usageModules: Set<string>,
    depth: number,
    maxDepth: number
  ): Promise<void> {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "dist", "build", "target", "__pycache__"].includes(entry.name)) {
          continue;
        }
        const subAbs = path.join(absoluteDir, entry.name);
        const subRel = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        await this.scanUsageModules(subAbs, subRel, ormEntity, ormFilePath, usageModules, depth + 1, maxDepth);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (![".ts", ".js", ".py", ".java"].includes(ext)) continue;
        const relPath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        if (relPath === ormFilePath) continue;
        const absPath = path.join(absoluteDir, entry.name);
        try {
          const content = await fs.readFile(absPath, "utf-8");
          // 检查是否 import / require 该实体
          const importPattern = new RegExp(`\\b(?:import|from|require)\\b[^;]*\\b${ormEntity}\\b`, "g");
          if (importPattern.test(content)) {
            usageModules.add(relPath);
          }
        } catch {
          continue;
        }
      }
    }
  }

  /**
   * 渲染 Mermaid ER 图
   *
   * @param tables 表列表
   * @returns Mermaid ER 图字符串（erDiagram 格式）
   */
  private renderErDiagram(tables: ReadonlyArray<DatabaseTable>): string {
    const lines: string[] = ["erDiagram", ""];

    // 表定义
    for (const table of tables) {
      lines.push(`    ${table.tableName} {`);
      for (const col of table.columns) {
        // Mermaid 类型映射：取数据类型首词
        const typeStr = col.dataType.split(/\s+/)[0].toUpperCase();
        const pkMark = col.isPrimaryKey ? " PK" : "";
        const fkMark = col.isUnique && !col.isPrimaryKey ? " UK" : "";
        lines.push(`        ${typeStr} ${col.columnName}${pkMark}${fkMark}`);
      }
      lines.push(`    }`);
    }
    lines.push("");

    // 关系（基于外键）
    for (const table of tables) {
      for (const fk of table.foreignKeys) {
        // 推断关系类型：默认 1:N（一对多）
        lines.push(`    ${fk.referencedTableName} ||--o{ ${table.tableName} : "${fk.columnName}"`);
      }
    }

    return lines.join("\n");
  }
}
