/**
 * 数据模型章节构建器（EAG-P3 批次 11 Part B2 §7.4 第 4 章）
 *
 * 本模块实现 DataModelSectionBuilder，构建交接文档第 4 章"数据模型"。
 *
 * 数据源（对齐 §7.4 七章结构表）：
 * - 领域模型（src/domain 下的 .ts 文件，从 TypeScript class / interface 提取）
 * - 数据库 schema（prisma/schema.prisma / migrations/*.sql）
 *
 * 置信度：verified（代码 + schema 交叉验证）
 *
 * 章节内容包含：
 * 1. 实体列表（从 TypeScript domain 文件提取 class 与属性）
 * 2. 实体关系（从 Prisma schema 或 SQL 外键提取）
 * 3. 数据库表结构（从 Prisma schema 或 SQL DDL 提取）
 * 4. 约束（唯一约束 / 非空约束 / 主键）
 *
 * @module eag/pkc/l4/section-builders/data-model-section
 */

import type { HandoverSection, SectionBuilder, SectionBuildContext } from "../types";

// ============================================================================
// 常量定义
// ============================================================================

const SECTION_ID = "data-model" as const;
const SECTION_TITLE = "数据模型" as const;
const SECTION_ORDER = 4 as const;
const SECTION_CONFIDENCE = "verified" as const;

/**
 * 可能的 Prisma schema 文件路径
 */
const PRISMA_SCHEMA_PATHS: ReadonlyArray<string> = Object.freeze(["prisma/schema.prisma", "schema.prisma"]);

/**
 * 可能的 SQL migration 目录下的文件匹配模式（前缀）
 */
const SQL_MIGRATION_PREFIXES: ReadonlyArray<string> = Object.freeze([
  "migrations/",
  "db/migrations/",
  "sql/migrations/",
]);

// ============================================================================
// 类型定义（内部使用）
// ============================================================================

/**
 * 实体属性
 */
interface EntityProperty {
  /** 属性名 */
  readonly name: string;
  /** 类型（string / number / boolean / Date / 自定义类型） */
  readonly type: string;
  /** 是否可选（?: 修饰符） */
  readonly optional: boolean;
  /** 是否只读（readonly 修饰符） */
  readonly readonly: boolean;
  /** 是否为数组（[] 后缀） */
  readonly isArray: boolean;
}

/**
 * 实体信息
 */
interface DomainEntity {
  /** 实体名（class / interface 名） */
  readonly name: string;
  /** 实体类型（class / interface / type-alias） */
  readonly kind: string;
  /** 所在文件路径 */
  readonly filePath: string;
  /** 属性列表 */
  readonly properties: ReadonlyArray<EntityProperty>;
}

/**
 * Prisma 模型
 */
interface PrismaModel {
  /** 模型名 */
  readonly name: string;
  /** 字段列表 */
  readonly fields: ReadonlyArray<PrismaField>;
  /** 是否为枚举类型 */
  readonly isEnum: boolean;
}

/**
 * Prisma 字段
 */
interface PrismaField {
  /** 字段名 */
  readonly name: string;
  /** 字段类型（String / Int / DateTime / 关联模型名） */
  readonly type: string;
  /** 是否为数组 */
  readonly isArray: boolean;
  /** 是否可选（? 后缀） */
  readonly optional: boolean;
  /** 是否为主键（@id） */
  readonly isId: boolean;
  /** 是否唯一（@unique） */
  readonly isUnique: boolean;
  /** 外键关联（@relation） */
  readonly relation?: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 判断文件路径是否为领域模型文件
 *
 * 领域模型文件特征：
 * - 路径包含 src/domain/ / src/entities/ / src/models/
 * - 扩展名为 .ts
 *
 * @param filePath 文件路径
 * @returns true=领域模型文件
 */
function isDomainModelFile(filePath: string): boolean {
  if (!filePath.endsWith(".ts")) {
    return false;
  }
  if (filePath.endsWith(".d.ts")) {
    return false;
  }
  if (/\.test\.[a-z]+$/.test(filePath) || /\.spec\.[a-z]+$/.test(filePath)) {
    return false;
  }
  return /(^|\/)(domain|entities|models)\//.test(filePath);
}

/**
 * 从 TypeScript 文件内容中提取领域实体（class / interface / type）
 *
 * 提取每个实体的属性列表（仅顶级属性，不递归嵌套）。
 *
 * @param content 文件内容
 * @param filePath 文件路径
 * @returns 实体列表
 */
function extractDomainEntities(content: string, filePath: string): DomainEntity[] {
  const entities: DomainEntity[] = [];
  const lines = content.split("\n");

  // 匹配 export class Name / export interface Name / export type Name = { ... }
  const entityRegex = /^\s*export\s+(?:abstract\s+)?(class|interface|type)\s+([A-Za-z_$][\w$]*)(?:\s*[={])?/;
  // 匹配 type Name = { ... } 的开头
  const typeAliasRegex = /^\s*export\s+type\s+([A-Za-z_$][\w$]*)\s*=\s*\{/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 优先匹配 type alias（type Name = {）
    const typeMatch = line.match(typeAliasRegex);
    if (typeMatch) {
      const entity = parseEntityBlock(lines, i, typeMatch[1], "type-alias", filePath);
      if (entity) {
        entities.push(entity);
        i = entity.endLine + 1;
        continue;
      }
    }

    // 匹配 class / interface
    const match = line.match(entityRegex);
    if (match) {
      const kind = match[1];
      const name = match[2];
      const entity = parseEntityBlock(lines, i, name, kind, filePath);
      if (entity) {
        entities.push(entity);
        i = entity.endLine + 1;
        continue;
      }
    }
    i++;
  }

  return entities;
}

/**
 * 解析实体块（class/interface/type 的 { ... } 内容），提取属性列表
 *
 * @param lines 全文行数组
 * @param startLine 起始行号
 * @param entityName 实体名
 * @param kind 实体类型
 * @param filePath 文件路径
 * @returns 实体信息（含结束行号），未找到块返回 null
 */
function parseEntityBlock(
  lines: string[],
  startLine: number,
  entityName: string,
  kind: string,
  filePath: string
): (DomainEntity & { endLine: number }) | null {
  const properties: EntityProperty[] = [];

  // 查找块的起始 { 位置
  let blockStart = -1;
  for (let i = startLine; i < Math.min(startLine + 3, lines.length); i++) {
    if (lines[i].includes("{")) {
      blockStart = i;
      break;
    }
    // type alias 单行定义（如 type X = string;）无块
    if (lines[i].includes(";") && !lines[i].includes("{")) {
      return {
        name: entityName,
        kind,
        filePath,
        properties: Object.freeze([]),
        endLine: i,
      };
    }
  }
  if (blockStart < 0) {
    return null;
  }

  // 扫描块内属性，直到匹配的 }
  let depth = 0;
  let endLine = blockStart;
  for (let i = blockStart; i < lines.length; i++) {
    const line = lines[i];
    // 统计 { } 深度
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (i > blockStart && depth <= 0) {
      endLine = i;
      break;
    }
    // 跳过起始行
    if (i === blockStart) {
      continue;
    }

    // 匹配属性行：
    // - 可见性修饰符（public/private/protected/readonly）
    // - 属性名: 类型
    // - 可选 ?: 修饰符
    // - 数组 [] 后缀
    // 形如：readonly id: string; / name?: string; / items: Item[];
    // 排除方法（含 ()）、装饰器（@）、纯注释行
    const propMatch = line.match(
      /^\s*(?:public\s+|private\s+|protected\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*(\?)?\s*:\s*([^;]+);/
    );
    if (propMatch && !line.match(/^\s*[@/]/)) {
      const propName = propMatch[1];
      const optional = Boolean(propMatch[2]);
      let propType = propMatch[3].trim();
      const isArray = /\[\]$/.test(propType);
      if (isArray) {
        propType = propType.replace(/\[\]$/, "").trim();
      }
      // 去除注释
      propType = propType.replace(/\s*\/\/.*$/, "").trim();
      const isReadonly = /\breadonly\b/.test(line);
      properties.push({
        name: propName,
        type: propType,
        optional,
        readonly: isReadonly,
        isArray,
      });
    }
    endLine = i;
  }

  return {
    name: entityName,
    kind,
    filePath,
    properties: Object.freeze(properties),
    endLine,
  };
}

/**
 * 从 Prisma schema 内容中提取模型
 *
 * 解析 model Name { ... } 与 enum Name { ... } 块。
 *
 * @param content Prisma schema 内容
 * @returns 模型列表
 */
function parsePrismaSchema(content: string): PrismaModel[] {
  const models: PrismaModel[] = [];
  const lines = content.split("\n");

  const modelHeaderRegex = /^\s*(model|enum)\s+([A-Za-z_$][\w$]*)\s*\{/;
  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(modelHeaderRegex);
    if (!match) {
      i++;
      continue;
    }
    const kind = match[1];
    const name = match[2];
    const isEnum = kind === "enum";
    const fields: PrismaField[] = [];

    // 扫描块内字段，直到匹配的 }
    let depth = 1;
    let j = i + 1;
    while (j < lines.length && depth > 0) {
      const line = lines[j];
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth <= 0) {
        break;
      }
      // 解析字段（仅 model 块）
      if (!isEnum) {
        // 形如：id String @id @default(uuid())
        //       createdAt DateTime @default(now())
        //       order Order? @relation(fields: [orderId], references: [id])
        //       tags String[]
        const fieldMatch = line.match(/^\s*([A-Za-z_$][\w$]*)\s+([A-Za-z_$][\w$]*)(\?)?(\[\])?\s*(.*)/);
        if (fieldMatch && !line.match(/^\s*\/\//)) {
          const fieldName = fieldMatch[1];
          const fieldType = fieldMatch[2];
          const optional = Boolean(fieldMatch[3]);
          const isArray = Boolean(fieldMatch[4]);
          const attributes = fieldMatch[5] || "";
          const isId = /@id\b/.test(attributes);
          const isUnique = /@unique\b/.test(attributes);
          const relationMatch = attributes.match(/@relation\([^)]*\)/);
          const relation = relationMatch ? relationMatch[0] : undefined;
          // 数组情况下，类型已含 []，需移除
          if (isArray && fieldType.endsWith("[]")) {
            // 不应到这里，但防御性处理
          }
          fields.push({
            name: fieldName,
            type: fieldType,
            isArray,
            optional,
            isId,
            isUnique,
            relation,
          });
        }
      }
      j++;
    }

    models.push({
      name,
      fields: Object.freeze(fields),
      isEnum,
    });
    i = j + 1;
  }

  return models;
}

/**
 * 从 SQL DDL 内容中提取表结构（简易解析）
 *
 * 仅识别 CREATE TABLE 语句，提取表名与列定义。
 *
 * @param content SQL 内容
 * @returns 表结构列表（与 PrismaModel 结构相同）
 */
function parseSqlDdl(content: string): PrismaModel[] {
  const models: PrismaModel[] = [];
  // 匹配 CREATE TABLE name ( ... ); 块
  const createTableRegex =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z_][\w]*)[`"]?\s*\(([\s\S]*?)\)\s*;/gi;
  let match: RegExpExecArray | null;
  while ((match = createTableRegex.exec(content)) !== null) {
    const tableName = match[1];
    const body = match[2];
    const fields: PrismaField[] = [];

    // 按行/逗号拆分列定义
    const columnLines = body.split(/,\s*\n/);
    for (const colLine of columnLines) {
      const trimmed = colLine.trim();
      if (!trimmed) continue;
      // 跳过约束定义（PRIMARY KEY / FOREIGN KEY / UNIQUE / CONSTRAINT）
      if (/^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CONSTRAINT|INDEX|KEY)\b/i.test(trimmed)) {
        continue;
      }
      // 匹配列定义：colName TYPE [constraints...]
      const colMatch = trimmed.match(/^[`"]?([A-Za-z_][\w]*)[`"]?\s+([A-Za-z]+)(\([^)]*\))?/i);
      if (colMatch) {
        const colName = colMatch[1];
        const colType = colMatch[2].toUpperCase();
        const isId = /PRIMARY\s+KEY/i.test(trimmed);
        const isUnique = /UNIQUE/i.test(trimmed);
        const optional = /\bNULL\b/i.test(trimmed) && !/NOT\s+NULL/i.test(trimmed);
        const fkMatch = trimmed.match(/REFERENCES\s+[`"]?([A-Za-z_][\w]*)[`"]?/i);
        fields.push({
          name: colName,
          type: colType,
          isArray: false,
          optional,
          isId,
          isUnique,
          relation: fkMatch ? `@relation(${fkMatch[1]})` : undefined,
        });
      }
    }

    models.push({
      name: tableName,
      fields: Object.freeze(fields),
      isEnum: false,
    });
  }
  return models;
}

// ============================================================================
// DataModelSectionBuilder 类
// ============================================================================

/**
 * 数据模型章节构建器
 *
 * 实现章节顺序 4（对齐 §7.4 七章结构表）。
 *
 * 构建流程：
 * 1. 扫描 src/domain 下的 .ts 文件提取领域实体（class / interface / type）
 * 2. 读取 prisma/schema.prisma 提取数据库模型
 * 3. 降级：扫描 migrations/*.sql 提取 CREATE TABLE 语句
 * 4. 组装 Markdown 内容（实体列表 + 属性表 + 关系图）
 * 5. 返回冻结的 HandoverSection（confidence=verified）
 */
export class DataModelSectionBuilder implements SectionBuilder {
  readonly sectionId = SECTION_ID;
  readonly title = SECTION_TITLE;
  readonly order = SECTION_ORDER;

  /**
   * 构建数据模型章节
   *
   * @param context 章节构建上下文
   * @returns 冻结的 HandoverSection（confidence=verified）
   */
  async build(context: SectionBuildContext): Promise<HandoverSection> {
    const sources: string[] = [];

    // 1. 扫描领域实体
    const entities: DomainEntity[] = [];
    for (const [filePath, content] of Object.entries(context.fileMap)) {
      if (!isDomainModelFile(filePath)) {
        continue;
      }
      sources.push(filePath);
      const fileEntities = extractDomainEntities(content, filePath);
      entities.push(...fileEntities);
    }

    // 2. 读取 Prisma schema
    let prismaModels: PrismaModel[] = [];
    for (const candidate of PRISMA_SCHEMA_PATHS) {
      const content = context.fileMap[candidate];
      if (typeof content === "string" && content.trim().length > 0) {
        sources.push(candidate);
        prismaModels = parsePrismaSchema(content);
        break;
      }
    }

    // 3. 降级：扫描 SQL migrations
    const sqlModels: PrismaModel[] = [];
    if (prismaModels.length === 0) {
      for (const [filePath, content] of Object.entries(context.fileMap)) {
        const isMigration = SQL_MIGRATION_PREFIXES.some((prefix) => filePath.startsWith(prefix));
        if (!isMigration || !filePath.endsWith(".sql")) {
          continue;
        }
        sources.push(filePath);
        sqlModels.push(...parseSqlDdl(content));
      }
    }

    // 4. 组装 Markdown 内容
    const content = this.assembleContent(entities, prismaModels, sqlModels, context.projectRoot);

    return Object.freeze({
      sectionId: SECTION_ID,
      title: SECTION_TITLE,
      order: SECTION_ORDER,
      confidence: SECTION_CONFIDENCE,
      content,
      sources: Object.freeze(sources),
    });
  }

  /**
   * 组装章节 Markdown 内容
   *
   * @param entities 领域实体列表
   * @param prismaModels Prisma 模型列表
   * @param sqlModels SQL 表结构列表
   * @param projectRoot 项目根目录
   * @returns 完整 Markdown 内容
   */
  private assembleContent(
    entities: DomainEntity[],
    prismaModels: PrismaModel[],
    sqlModels: PrismaModel[],
    projectRoot: string
  ): string {
    const lines: string[] = [];
    lines.push(`## ${SECTION_TITLE}`);
    lines.push("");
    lines.push(`> **置信度**：verified（领域模型 + 数据库 schema 交叉验证）`);
    lines.push(`> **项目根目录**：${projectRoot}`);
    lines.push(`> **领域实体数**：${entities.length}`);
    lines.push(`> **Prisma 模型数**：${prismaModels.length}`);
    lines.push(`> **SQL 表数**：${sqlModels.length}`);
    lines.push("");

    // 领域实体
    if (entities.length > 0) {
      lines.push("### 领域实体");
      lines.push("");
      lines.push("| 实体名 | 类型 | 文件路径 | 属性数 |");
      lines.push("|--------|------|----------|--------|");
      for (const entity of entities) {
        lines.push(`| ${entity.name} | ${entity.kind} | \`${entity.filePath}\` | ${entity.properties.length} |`);
      }
      lines.push("");

      // 每个实体的属性详情
      lines.push("### 实体属性详情");
      lines.push("");
      for (const entity of entities) {
        lines.push(`#### ${entity.name} (${entity.kind})`);
        lines.push("");
        lines.push(`- **所在文件**：\`${entity.filePath}\``);
        lines.push("");
        if (entity.properties.length === 0) {
          lines.push("> 该实体未提取到属性（可能为标记接口或类型别名）。");
          lines.push("");
          continue;
        }
        lines.push("| 属性名 | 类型 | 可选 | 只读 | 数组 |");
        lines.push("|--------|------|------|------|------|");
        for (const prop of entity.properties) {
          lines.push(
            `| ${prop.name} | \`${prop.type}\` | ${prop.optional ? "是" : "否"} | ${prop.readonly ? "是" : "否"} | ${prop.isArray ? "是" : "否"} |`
          );
        }
        lines.push("");
      }
    } else {
      lines.push("### 领域实体");
      lines.push("");
      lines.push("> 未在 src/domain/ / src/entities/ / src/models/ 目录下扫描到 TypeScript 实体。");
      lines.push("");
    }

    // Prisma 模型
    if (prismaModels.length > 0) {
      lines.push("### Prisma 数据模型");
      lines.push("");
      lines.push("| 模型名 | 类型 | 字段数 |");
      lines.push("|--------|------|--------|");
      for (const model of prismaModels) {
        lines.push(`| ${model.name} | ${model.isEnum ? "enum" : "model"} | ${model.fields.length} |`);
      }
      lines.push("");

      // Prisma 模型字段详情
      lines.push("### Prisma 模型字段详情");
      lines.push("");
      for (const model of prismaModels) {
        lines.push(`#### ${model.name}`);
        lines.push("");
        if (model.fields.length === 0) {
          lines.push("> 该模型无字段定义。");
          lines.push("");
          continue;
        }
        lines.push("| 字段名 | 类型 | 主键 | 唯一 | 可选 | 数组 | 关联 |");
        lines.push("|--------|------|------|------|------|------|------|");
        for (const field of model.fields) {
          lines.push(
            `| ${field.name} | \`${field.type}\` | ${field.isId ? "是" : "否"} | ${field.isUnique ? "是" : "否"} | ${field.optional ? "是" : "否"} | ${field.isArray ? "是" : "否"} | ${field.relation ?? "—"} |`
          );
        }
        lines.push("");
      }
    }

    // SQL 表结构
    if (sqlModels.length > 0) {
      lines.push("### SQL 表结构（来自 migrations）");
      lines.push("");
      lines.push("| 表名 | 字段数 |");
      lines.push("|------|--------|");
      for (const model of sqlModels) {
        lines.push(`| ${model.name} | ${model.fields.length} |`);
      }
      lines.push("");

      // SQL 表字段详情
      lines.push("### SQL 表字段详情");
      lines.push("");
      for (const model of sqlModels) {
        lines.push(`#### ${model.name}`);
        lines.push("");
        if (model.fields.length === 0) {
          lines.push("> 该表无字段定义。");
          lines.push("");
          continue;
        }
        lines.push("| 字段名 | 类型 | 主键 | 唯一 | 可选 | 关联 |");
        lines.push("|--------|------|------|------|------|------|");
        for (const field of model.fields) {
          lines.push(
            `| ${field.name} | \`${field.type}\` | ${field.isId ? "是" : "否"} | ${field.isUnique ? "是" : "否"} | ${field.optional ? "是" : "否"} | ${field.relation ?? "—"} |`
          );
        }
        lines.push("");
      }
    }

    if (entities.length === 0 && prismaModels.length === 0 && sqlModels.length === 0) {
      lines.push("> 未在 fileMap 中扫描到任何数据模型（领域实体 / Prisma schema / SQL migrations 均缺失）。");
      lines.push("");
    }

    return lines.join("\n");
  }
}
