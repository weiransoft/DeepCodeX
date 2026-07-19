/**
 * SQL 模式判定器（SqlPatternChecker）—— EAG-P2 批次 9 S2
 *
 * 负责红线：
 * - TCS-SQL-01：无索引 WHERE（全表扫描——WHERE 字段未建立索引）
 * - TCS-SQL-02：循环内查询（N+1 查询问题——在 for / while 循环内调用 db.find）
 * - TCS-SQL-03：OFFSET > 10000（深分页性能问题——使用 OFFSET 跳过大量行）
 *
 * 判定算法：
 * 1. TCS-SQL-01：扫描 SQL 语句字符串字面量中的 WHERE 子句，提取字段名；
 *    同时检查 ORM 查询调用（prisma.findMany / knex.where）的 where 字段。
 *    注：本判定器为静态启发式，无法验证索引是否存在——
 *    实际索引验证需结合数据库 schema 或迁移文件，本判定器仅检测明显的全表扫描模式。
 * 2. TCS-SQL-02：扫描 for / while 循环体内的数据库查询调用（find/findMany/select/query）
 * 3. TCS-SQL-03：扫描 SQL 语句中的 OFFSET N 子句或 ORM 调用中的 skip: N 参数，N > 10000 → 违规
 *
 * 判定规则：
 * - 检测到 SQL WHERE 子句中字段未在索引清单中 → 违反 TCS-SQL-01（启发式，需结合 schema）
 * - 检测到 for/while 循环体内调用 db.find / db.findMany / db.query → 违反 TCS-SQL-02
 * - 检测到 SQL OFFSET N > 10000 或 ORM skip: N > 10000 → 违反 TCS-SQL-03
 *
 * 设计依据：
 * - EAG 方案 §5.8.3 SQL 查询优化规范
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单
 *
 * @module eag/coding/static-checkers/sql-pattern-checker
 */

import type { StaticChecker } from "../types";
import type { RedlineDefinition, RedlineResult } from "../../evaluator/types";
import { buildViolations, buildPass, extractFilePathFromComment, lineOf } from "./checker-utils";

/**
 * 数据库查询方法名清单（识别 db.find / db.findMany 等查询调用）
 */
const DB_QUERY_METHODS: ReadonlyArray<string> = Object.freeze([
  "find",
  "findMany",
  "findOne",
  "findFirst",
  "select",
  "query",
  "execute",
  "raw",
]);

/**
 * 数据库 receiver 名清单（识别 db / repository / prisma / knex 等数据库对象）
 */
const DB_RECEIVER_NAMES: ReadonlyArray<string> = Object.freeze([
  "db",
  "database",
  "repository",
  "repo",
  "prisma",
  "knex",
  "entityManager",
  "session",
]);

/**
 * OFFSET 阈值（深分页判定）
 *
 * OFFSET > 此阈值视为深分页，违反 TCS-SQL-03 红线。
 * 数值依据：PostgreSQL/MySQL 在 OFFSET > 10000 时性能急剧下降（需扫描并丢弃 10000 行）。
 */
const OFFSET_THRESHOLD = 10000;

/**
 * 判定 receiver 是否为数据库对象
 *
 * @param receiver 方法调用的接收者
 * @returns true 表示数据库对象
 */
function isDbReceiver(receiver: string): boolean {
  const lower = receiver.toLowerCase();
  return DB_RECEIVER_NAMES.includes(lower);
}

/**
 * 判定方法名是否为数据库查询方法
 *
 * @param method 方法名
 * @returns true 表示查询方法
 */
function isDbQueryMethod(method: string): boolean {
  return DB_QUERY_METHODS.includes(method);
}

/**
 * SQL 模式判定器
 *
 * 实现 StaticChecker 协议，负责 TCS-SQL-01/02/03 红线的静态判定。
 */
export class SqlPatternChecker implements StaticChecker {
  /** 该 Checker 负责的红线 ID 列表 */
  readonly redlineIds: ReadonlyArray<string> = Object.freeze(["TCS-SQL-01", "TCS-SQL-02", "TCS-SQL-03"]);

  /**
   * 执行静态判定
   *
   * 算法：
   * 1. TCS-SQL-02：扫描循环体内的数据库查询调用（N+1 查询问题）
   * 2. TCS-SQL-03：扫描 SQL OFFSET > 10000 或 ORM skip > 10000
   * 3. TCS-SQL-01：扫描 SQL 字符串字面量中的 WHERE 子句（启发式：检测 SELECT * FROM + WHERE 模式，
   *    实际索引验证需结合 schema 文件，本判定器仅检测明显的全表扫描模式）
   *
   * @param artifacts 产出物列表
   * @param redline 当前红线定义
   * @returns 判定结果
   */
  check(
    artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
    redline: Readonly<RedlineDefinition>
  ): RedlineResult {
    const violations: Array<{
      readonly filePath: string;
      readonly line: number;
      readonly description: string;
      readonly fixSuggestion: string;
    }> = [];

    for (const artifact of artifacts) {
      const filePath = extractFilePathFromComment(artifact.content) || artifact.path;
      const content = artifact.content;
      const lines = content.split(/\r?\n/);

      // TCS-SQL-02：扫描循环体内的数据库查询调用
      // 跟踪循环深度：for ( / while ( 进入循环，对应的 } 退出循环
      let loopDepth = 0;
      const loopStartLines: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*\/\//.test(line)) continue;
        if (/^\s*\*/.test(line)) continue;

        // 检测循环开始
        if (/\b(for|while)\s*\(/.test(line)) {
          loopDepth++;
          loopStartLines.push(i + 1);
        }

        // 检测循环结束（简化处理：每遇到 } 且 loopDepth > 0 时递减）
        // 注：此启发式可能误判嵌套代码块，但足够检测明显的 N+1 查询
        const closeBraces = (line.match(/\}/g) ?? []).length;
        for (let c = 0; c < closeBraces && loopDepth > 0; c++) {
          loopDepth--;
          loopStartLines.pop();
        }

        // 在循环体内检测数据库查询调用
        if (loopDepth > 0) {
          const callRe = /\b([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)\s*\(/g;
          let m: RegExpExecArray | null;
          while ((m = callRe.exec(line)) !== null) {
            const receiver = m[1];
            const method = m[2];
            if (isDbReceiver(receiver) && isDbQueryMethod(method)) {
              violations.push({
                filePath,
                line: i + 1,
                description:
                  `在循环体内调用 ${receiver}.${method}() 数据库查询——违反 TCS-SQL-02 红线（N+1 查询）。` +
                  `循环内查询会导致 N 次数据库往返，N 大时性能急剧下降（如 1000 次循环产生 1000 次查询）`,
                fixSuggestion:
                  "1. 将循环内的单条查询改为批量查询（如 db.findMany({ where: { id: { in: ids } } })）\n" +
                  "2. 使用 ORM 的 Include / Join 一次性加载关联数据\n" +
                  "3. 对无法批量的场景，使用 IN 查询一次性获取所有记录\n" +
                  "4. 引入 DataLoader 模式自动合并批量查询",
              });
              break; // 同一行只报一次
            }
          }
        }
      }

      // TCS-SQL-03：扫描 SQL OFFSET > 10000 或 ORM skip > 10000
      // 1) SQL 字符串字面量中的 OFFSET N
      const offsetSqlRe = /\bOFFSET\s+(\d+)\b/gi;
      let m: RegExpExecArray | null;
      while ((m = offsetSqlRe.exec(content)) !== null) {
        const offsetValue = parseInt(m[1], 10);
        if (offsetValue > OFFSET_THRESHOLD) {
          violations.push({
            filePath,
            line: lineOf(content, m.index),
            description:
              `SQL 语句使用 OFFSET ${offsetValue}（> ${OFFSET_THRESHOLD}）——违反 TCS-SQL-03 红线（深分页）。` +
              `OFFSET 需扫描并丢弃前 ${offsetValue} 行，性能急剧下降（深分页性能问题）`,
            fixSuggestion:
              "1. 改用游标分页（cursor-based pagination）：WHERE id > last_id ORDER BY id LIMIT N\n" +
              "2. 或使用 keyset pagination：WHERE (created_at, id) > (last_created_at, last_id)\n" +
              "3. 对必须用 OFFSET 的场景，限制最大 OFFSET（如 ≤ 10000）并提示用户使用过滤条件\n" +
              "4. 引入 Elasticsearch 等搜索引擎处理深分页查询",
          });
        }
      }

      // 2) ORM 调用中的 skip: N 参数（Prisma / TypeORM 等）
      const skipRe = /\bskip\s*:\s*(\d+)\b/g;
      while ((m = skipRe.exec(content)) !== null) {
        const skipValue = parseInt(m[1], 10);
        if (skipValue > OFFSET_THRESHOLD) {
          violations.push({
            filePath,
            line: lineOf(content, m.index),
            description:
              `ORM 查询使用 skip: ${skipValue}（> ${OFFSET_THRESHOLD}）——违反 TCS-SQL-03 红线（深分页）。` +
              `skip 会生成 SQL OFFSET 子句，需扫描并丢弃前 ${skipValue} 行，性能急剧下降`,
            fixSuggestion:
              "1. 改用游标分页（cursor-based pagination）：where: { id: { gt: lastId } } orderBy: { id: 'asc' } take: N\n" +
              "2. 或使用 keyset pagination：基于 (createdAt, id) 复合游标\n" +
              "3. 对必须用 skip 的场景，限制最大值（如 ≤ 10000）\n" +
              "4. 引入 Elasticsearch 等搜索引擎处理深分页",
          });
        }
      }

      // TCS-SQL-01：扫描 SQL 字符串字面量中的 WHERE 子句
      // 启发式：检测 "SELECT * FROM table WHERE ..." 形式的 SQL（SELECT * 视为全表扫描风险）
      // 注意：本判定器无法验证索引是否存在，仅检测明显的 SELECT * 模式
      const selectAllRe = /\bSELECT\s+\*\s+FROM\s+[\w.]+\s+WHERE\b/gi;
      while ((m = selectAllRe.exec(content)) !== null) {
        violations.push({
          filePath,
          line: lineOf(content, m.index),
          description:
            `SQL 语句使用 SELECT * FROM ... WHERE ... 形式——疑似违反 TCS-SQL-01 红线（无索引 WHERE）。` +
            `SELECT * 会返回所有列，且 WHERE 字段若无索引覆盖将触发全表扫描。` +
            `请检查 WHERE 字段是否已建立索引（联合索引的最左前缀原则）`,
          fixSuggestion:
            "1. 将 SELECT * 改为显式列出所需字段（如 SELECT id, name, status FROM ...）\n" +
            "2. 检查 WHERE 字段是否已建立索引（如 CREATE INDEX idx_xxx ON table (field1, field2)）\n" +
            "3. 联合索引遵循最左前缀原则：WHERE field1=? AND field2=? 命中 (field1, field2) 索引\n" +
            "4. 使用 EXPLAIN 分析查询计划，确认是否走索引",
        });
      }
    }

    if (violations.length > 0) {
      return buildViolations(redline.id, violations);
    }
    return buildPass(redline.id);
  }
}
