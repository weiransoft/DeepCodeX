/**
 * SQL 查询优化规范包（SQL Optimization Specification，§5.8.3）
 *
 * 本模块实现 EAG 方案 §5.8.3 SQL 查询优化规范的运行期访问入口：
 * - 定义统一抽象接口 SqlOptimizationPort（reviewIndex / detectNPlusOne / checkPagination）
 * - 实现索引评审器（IndexReviewer）：评审 WHERE/ORDER BY/JOIN 字段索引覆盖情况
 * - 实现 N+1 查询检测器（NPlusOneDetector）：静态扫描循环内单条查询模式
 * - 实现分页规范检查器（PaginationChecker）：检测深分页（offset > 10000）
 *
 * 设计依据：
 * - EAG 方案 §5.8.3 SQL 查询优化规范
 * - §5.12.4 G-A6d 配置冻结原则
 * - SQL 索引评审标准实践（最左前缀匹配 / 覆盖索引）
 * - N+1 查询检测的静态分析模式（循环 + 查询调用）
 *
 * 红线合规设计：
 * - TCS-SQL-01：索引评审器检测 WHERE 字段未被索引覆盖时标记 fullTableScanRisk=true
 * - TCS-SQL-02：N+1 检测器扫描循环内单条查询模式，输出检测到的位置与修复建议
 * - TCS-SQL-03：分页检查器检测 offset > 10000 时标记 isDeepPagination=true
 *
 * @module eag/tcs/sql-optimizer
 */

import type {
  IndexReviewInput,
  IndexReviewResult,
  IndexDefinition,
  NPlusOneDetectionResult,
  PaginationCheckResult,
} from "./types";

// ============================================================================
// 1. 默认配置常量
// ============================================================================

/**
 * 深分页阈值（10000）
 *
 * 对齐 §5.8.3 规范"禁止深分页（offset > 10000 改用游标/keyset 分页）"——
 * 当 offset 超过此阈值时，应改用游标分页（cursor-based pagination）或 keyset 分页。
 */
export const DEEP_PAGINATION_THRESHOLD = 10000;

/**
 * N+1 查询检测的查询调用关键词清单
 *
 * 用于识别代码中的 ORM/数据库查询调用，配合循环语句检测 N+1 模式。
 * 包含主流 ORM/数据库库的查询方法名：
 * - Prisma：findUnique / findFirst / findMany
 * - TypeORM：findOne / find / createQueryBuilder
 * - Sequelize：findByPk / findOne / findAll
 * - Mongoose：findById / findOne / find
 * - 原生 SQL：query / execute
 */
export const QUERY_CALL_KEYWORDS: ReadonlyArray<string> = Object.freeze([
  "findUnique",
  "findFirst",
  "findMany",
  "findOne",
  "findById",
  "findByPk",
  "findAll",
  "find",
  "query",
  "execute",
  "createQueryBuilder",
  "select",
]);

/**
 * N+1 查询检测的循环语句关键词清单
 *
 * 用于识别代码中的循环语句，配合查询调用检测 N+1 模式。
 */
export const LOOP_KEYWORDS: ReadonlyArray<string> = Object.freeze([
  "for",
  "forEach",
  "while",
  "map",
  "filter",
  "reduce",
  "flatMap",
]);

/**
 * N+1 检测的最小置信度阈值
 *
 * 检测结果的置信度低于此值时不计入 patterns（避免误报）。
 * 置信度计算：循环 + 查询调用 = 0.7，循环 + 查询调用 + await = 0.9
 */
export const MIN_DETECTION_CONFIDENCE = 0.5;

// ============================================================================
// 2. SqlOptimizationPort 抽象接口
// ============================================================================

/**
 * SQL 查询优化统一抽象接口（Port，§5.8.3）
 *
 * 业务代码（CODING Loop 生成迁移脚本时）通过依赖注入获取 SqlOptimizationPort，
 * 强制进行索引评审与 N+1 检测，禁止绕过。
 */
export interface SqlOptimizationPort {
  /**
   * 评审索引覆盖情况
   *
   * 评审给定 SQL 语句在现有索引下的覆盖情况：
   * - WHERE 字段是否被索引覆盖（避免全表扫描，对齐 TCS-SQL-01 红线）
   * - ORDER BY 字段是否被索引覆盖（避免 filesort）
   * - JOIN 字段是否被索引覆盖（避免 nested loop join）
   *
   * @param input 索引评审输入（含 SQL 语句、现有索引、模型字段）
   * @returns 索引评审结果（含覆盖情况、缺失索引建议）
   */
  reviewIndex(input: IndexReviewInput): IndexReviewResult;

  /**
   * 检测代码片段中的 N+1 查询模式
   *
   * 静态扫描代码片段，识别循环内的单条查询调用（N+1 模式），对齐 TCS-SQL-02 红线。
   *
   * @param filePath 文件路径
   * @param codeContent 代码内容
   * @returns N+1 检测结果（含检测到的模式位置、修复建议）
   */
  detectNPlusOne(filePath: string, codeContent: string): NPlusOneDetectionResult;

  /**
   * 检查分页规范合规性
   *
   * 检查 SQL 语句的分页参数是否合规（对齐 TCS-SQL-03 红线——禁止深分页 offset > 10000）。
   *
   * @param sql SQL 语句
   * @returns 分页规范检查结果（含是否深分页、修复建议）
   */
  checkPagination(sql: string): PaginationCheckResult;
}

// ============================================================================
// 3. 索引评审器实现（IndexReviewer）
// ============================================================================

/**
 * 索引评审器实现
 *
 * 实现 SqlOptimizationPort.reviewIndex 方法，评审 SQL 语句的索引覆盖情况。
 *
 * 评审算法：
 * 1. 解析每条 SQL 的 WHERE 子句字段列表
 * 2. 对每个 WHERE 字段，检查是否被现有索引覆盖（含联合索引最左前缀匹配）
 * 3. 同理检查 ORDER BY 字段与 JOIN 字段
 * 4. 若任一 WHERE 字段未覆盖，标记 fullTableScanRisk=true（对齐 TCS-SQL-01 红线）
 * 5. 生成缺失索引建议（建议添加覆盖未索引字段的索引）
 */
export class IndexReviewer {
  /**
   * 评审索引覆盖情况
   *
   * @param input 索引评审输入
   * @returns 索引评审结果
   */
  review(input: IndexReviewInput): IndexReviewResult {
    // 使用可变数组累加中间结果，最终返回时通过 Object.freeze 冻结为 ReadonlyArray
    const whereCoverage: Array<{
      sql: string;
      whereColumns: string[];
      covered: boolean;
      coveringIndex: string | null;
    }> = [];
    const orderByCoverage: Array<{
      sql: string;
      orderByColumns: string[];
      covered: boolean;
      coveringIndex: string | null;
    }> = [];
    const joinCoverage: Array<{
      sql: string;
      joinColumns: string[];
      covered: boolean;
      coveringIndex: string | null;
    }> = [];
    const suggestedIndexes: IndexDefinition[] = [];
    let fullTableScanRisk = false;

    // 逐条评审 SQL 语句
    for (const sql of input.sqlStatements) {
      // 解析 WHERE 字段
      const whereColumns = this.extractWhereColumns(sql);
      if (whereColumns.length > 0) {
        // 检查 WHERE 字段的索引覆盖情况（整体检查——联合索引最左前缀匹配）
        // 联合索引 (A, B, C) 可覆盖 WHERE A, WHERE A AND B, WHERE A AND B AND C
        // 但不能覆盖 WHERE B, WHERE C, WHERE B AND C（缺少最左前缀 A）
        // WHERE 字段顺序不重要（SQL 语义上 WHERE A AND B 等价于 WHERE B AND A）
        const matchedIndex = this.findCoveringIndexForWhere(whereColumns, input.existingIndexes);
        const covered = matchedIndex !== null;
        const coveringIndex = covered ? matchedIndex!.name : null;

        // 若未覆盖，找出未覆盖的字段（用于生成缺失索引建议）
        const uncoveredColumns: string[] = [];
        if (!covered) {
          for (const col of whereColumns) {
            // 单字段检查：该字段是否是任何索引的首列（用于生成精准的缺失索引建议）
            const colIndex = this.findCoveringIndex(col, input.existingIndexes);
            if (!colIndex) {
              uncoveredColumns.push(col);
            }
          }
          // 兜底：若所有字段都是某个索引首列（但整体不满足最左前缀），则未覆盖字段为全部 WHERE 字段
          // 这种场景例如 WHERE B AND C，索引 (A, B, C)——B 和 C 都不是首列，但整体不满足最左前缀
          if (uncoveredColumns.length === 0) {
            uncoveredColumns.push(...whereColumns);
          }
          // 存在未覆盖的 WHERE 字段，标记全表扫描风险（对齐 TCS-SQL-01 红线）
          fullTableScanRisk = true;
        }

        whereCoverage.push({
          sql,
          whereColumns,
          covered,
          coveringIndex,
        });

        // 若未覆盖，生成缺失索引建议（按未覆盖字段构造联合索引）
        if (!covered && uncoveredColumns.length > 0) {
          suggestedIndexes.push({
            name: `idx_${input.tableName}_${uncoveredColumns.join("_")}`,
            columns: Object.freeze([...uncoveredColumns]),
            type: "btree",
            unique: false,
            isPrimaryKey: false,
          });
        }
      }

      // 解析 ORDER BY 字段
      const orderByColumns = this.extractOrderByColumns(sql);
      if (orderByColumns.length > 0) {
        let coveringIndex: string | null = null;
        let covered = true;
        for (const col of orderByColumns) {
          const matchedIndex = this.findCoveringIndex(col, input.existingIndexes);
          if (matchedIndex) {
            coveringIndex = matchedIndex.name;
          } else {
            covered = false;
          }
        }
        orderByCoverage.push({
          sql,
          orderByColumns,
          covered,
          coveringIndex: covered ? coveringIndex : null,
        });
      }

      // 解析 JOIN 字段
      const joinColumns = this.extractJoinColumns(sql);
      if (joinColumns.length > 0) {
        let coveringIndex: string | null = null;
        let covered = true;
        for (const col of joinColumns) {
          const matchedIndex = this.findCoveringIndex(col, input.existingIndexes);
          if (matchedIndex) {
            coveringIndex = matchedIndex.name;
          } else {
            covered = false;
            // JOIN 字段未覆盖也建议添加索引（外键索引）
            const suggestedName = `idx_${input.tableName}_fk_${col}`;
            if (!suggestedIndexes.find((i) => i.name === suggestedName)) {
              suggestedIndexes.push({
                name: suggestedName,
                columns: Object.freeze([col]),
                type: "btree",
                unique: false,
                isPrimaryKey: false,
              });
            }
          }
        }
        joinCoverage.push({
          sql,
          joinColumns,
          covered,
          coveringIndex: covered ? coveringIndex : null,
        });
      }
    }

    // 决策评审结论
    let verdict: IndexReviewResult["verdict"] = "pass";
    if (fullTableScanRisk) {
      verdict = "fail";
    } else if (suggestedIndexes.length > 0) {
      verdict = "warn";
    }

    // 构建评审备注
    const notes = this.buildReviewNotes(
      input.tableName,
      whereCoverage,
      orderByCoverage,
      joinCoverage,
      suggestedIndexes,
      fullTableScanRisk
    );

    return {
      tableName: input.tableName,
      verdict,
      whereCoverage: Object.freeze(whereCoverage),
      orderByCoverage: Object.freeze(orderByCoverage),
      joinCoverage: Object.freeze(joinCoverage),
      suggestedIndexes: Object.freeze(suggestedIndexes),
      fullTableScanRisk,
      notes,
    };
  }

  /**
   * 从 SQL 语句中提取 WHERE 子句使用的字段
   *
   * 解析算法（简化版，覆盖 80% 常见 SQL 模式）：
   * 1. 提取 WHERE 子句（不区分大小写）
   * 2. 按逗号 / AND / OR 分割
   * 3. 提取每段中的字段名（去除运算符与值），支持表别名前缀（如 `u.id` 提取 `id`）
   *
   * 表别名处理（对齐 §5.8.3 索引评审规范）：
   * - 形如 `alias.column` 的条件应提取 column 部分（去掉 alias 前缀），
   *   否则索引覆盖检查会按 alias 字段名查找，导致误判全表扫描风险。
   * - 不带别名前缀的纯字段名（如 `id`）保持原样提取。
   *
   * @param sql SQL 语句
   * @returns WHERE 子句使用的字段列表（已剥离表别名前缀）
   */
  private extractWhereColumns(sql: string): string[] {
    // 提取 WHERE 子句（不区分大小写）
    const whereMatch = sql.match(/\bWHERE\b\s+(.+?)(\bORDER\b|\bGROUP\b|\bLIMIT\b|\bJOIN\b|\bUNION\b|$)/is);
    if (!whereMatch) {
      return [];
    }
    const whereClause = whereMatch[1]!;
    // 按 AND / OR 分割（不区分大小写）
    const conditions = whereClause.split(/\s+(?:AND|OR)\s+/i);
    const columns: string[] = [];
    for (const cond of conditions) {
      // 提取字段名（去除运算符与值）：field = value / field IN (...) / field BETWEEN ... AND ...
      // 支持表别名前缀（alias.column）：通过 (?:[a-zA-Z_][a-zA-Z0-9_]*\.)? 可选匹配 alias. 前缀，
      // 真正捕获组 1 为 column 部分（剥离 alias 前缀）。
      // 例：
      //   "u.id = 1"     → 提取 "id"（剥离 "u." 别名前缀）
      //   "id = 1"       → 提取 "id"（无别名前缀）
      //   "users.id = 1" → 提取 "id"（剥离 "users." 表名前缀）
      const colMatch = cond.trim().match(/^(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?([a-zA-Z_][a-zA-Z0-9_]*)/);
      if (colMatch) {
        columns.push(colMatch[1]!);
      }
    }
    return columns;
  }

  /**
   * 从 SQL 语句中提取 ORDER BY 子句使用的字段
   *
   * @param sql SQL 语句
   * @returns ORDER BY 子句使用的字段列表
   */
  private extractOrderByColumns(sql: string): string[] {
    const orderMatch = sql.match(/\bORDER\s+BY\b\s+(.+?)(\bLIMIT\b|\bOFFSET\b|$)/is);
    if (!orderMatch) {
      return [];
    }
    const orderClause = orderMatch[1]!;
    // 按逗号分割
    const items = orderClause.split(",").map((s) => s.trim());
    const columns: string[] = [];
    for (const item of items) {
      // 提取字段名（去除 ASC/DESC 关键字）
      const colMatch = item.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
      if (colMatch) {
        columns.push(colMatch[1]!);
      }
    }
    return columns;
  }

  /**
   * 从 SQL 语句中提取 JOIN 子句使用的字段
   *
   * @param sql SQL 语句
   * @returns JOIN 子句使用的字段列表（去重）
   */
  private extractJoinColumns(sql: string): string[] {
    // 提取所有 JOIN ... ON ... 子句中的 ON 条件字段
    const joinMatches = sql.matchAll(
      /\bJOIN\b\s+\S+\s+\w*\s+ON\s+(.+?)(\bWHERE\b|\bORDER\b|\bGROUP\b|\bLIMIT\b|\bJOIN\b|$)/gis
    );
    const columns: string[] = [];
    for (const match of joinMatches) {
      const onClause = match[1]!;
      // 提取 = 左右两侧的字段名
      const fieldMatches = onClause.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([a-zA-Z_][a-zA-Z0-9_]*)/g);
      for (const fieldMatch of fieldMatches) {
        // 取等式两侧的字段名（去除表别名前缀，如 u.user_id 取 user_id）
        const leftCol = fieldMatch[1]!.split(".").pop()!;
        const rightCol = fieldMatch[2]!.split(".").pop()!;
        // 只添加当前表字段（取等式一侧）
        if (!columns.includes(leftCol)) {
          columns.push(leftCol);
        }
        if (!columns.includes(rightCol)) {
          columns.push(rightCol);
        }
      }
    }
    return columns;
  }

  /**
   * 查找覆盖 WHERE 子句所有字段的索引（联合索引最左前缀匹配）
   *
   * 联合索引最左前缀匹配规则（对齐 §5.8.3 SQL 查询优化规范）：
   * - 索引 (A, B, C) 可覆盖 WHERE A, WHERE A AND B, WHERE A AND B AND C
   *   （WHERE 字段是索引最左前缀子集的子集）
   * - 不能覆盖 WHERE B, WHERE C, WHERE B AND C
   *   （缺少最左前缀 A，索引无法使用，触发全表扫描）
   * - WHERE 字段顺序不重要（SQL 语义上 WHERE A AND B 等价于 WHERE B AND A）
   *
   * 算法：
   * 1. 对于每个索引，取其前 N 列作为最左前缀子集（N = WHERE 字段数）
   * 2. 检查 WHERE 的所有字段是否都在最左前缀子集中
   * 3. 若是，则该索引覆盖 WHERE 子句（不会全表扫描）
   *
   * 使用场景：
   * - WHERE 覆盖检查（判断是否全表扫描，对齐 TCS-SQL-01 红线）
   * - 整体匹配——与 findCoveringIndex（单字段检查）不同，本方法考虑 WHERE 全部字段
   *
   * @param whereColumns WHERE 子句使用的字段列表
   * @param indexes 现有索引清单
   * @returns 覆盖 WHERE 子句的索引；未找到返回 null
   */
  private findCoveringIndexForWhere(
    whereColumns: string[],
    indexes: ReadonlyArray<IndexDefinition>
  ): IndexDefinition | null {
    // 使用 Set 去重 WHERE 字段（同一字段多次出现视为一次）
    const whereSet = new Set(whereColumns);
    for (const index of indexes) {
      // 取索引的前 whereColumns.length 列作为最左前缀子集
      // 例如索引 (A, B, C)，WHERE A AND B → 取前 2 列 [A, B]
      // 例如索引 (A, B, C)，WHERE A → 取前 1 列 [A]
      const prefixColumns = index.columns.slice(0, whereColumns.length);
      // 检查 WHERE 的所有字段都在最左前缀子集中
      let allCovered = true;
      for (const col of whereSet) {
        if (!prefixColumns.includes(col)) {
          allCovered = false;
          break;
        }
      }
      if (allCovered) {
        return index;
      }
    }
    return null;
  }

  /**
   * 查找覆盖指定字段的索引（单字段检查）
   *
   * 实现最左前缀匹配规则：
   * - 单字段索引：字段名匹配即可
   * - 联合索引：字段必须是索引的第一个字段（最左前缀）
   *
   * 使用场景：
   * - ORDER BY / JOIN 覆盖检查（单字段检查）
   * - WHERE 未覆盖时，识别未覆盖字段（用于生成精准的缺失索引建议）
   *
   * 注：WHERE 覆盖检查使用 findCoveringIndexForWhere（整体检查），本方法仅用于单字段场景
   *
   * @param column 字段名
   * @param indexes 现有索引清单
   * @returns 覆盖该字段的索引；未找到返回 null
   */
  private findCoveringIndex(column: string, indexes: ReadonlyArray<IndexDefinition>): IndexDefinition | null {
    for (const index of indexes) {
      // 联合索引最左前缀匹配：字段必须是索引的第一个字段
      if (index.columns[0] === column) {
        return index;
      }
    }
    return null;
  }

  /**
   * 构建评审备注
   *
   * @param tableName 表名
   * @param whereCoverage WHERE 覆盖情况
   * @param orderByCoverage ORDER BY 覆盖情况
   * @param joinCoverage JOIN 覆盖情况
   * @param suggestedIndexes 建议新增的索引
   * @param fullTableScanRisk 全表扫描风险
   * @returns 评审备注字符串
   */
  private buildReviewNotes(
    tableName: string,
    whereCoverage: IndexReviewResult["whereCoverage"],
    orderByCoverage: IndexReviewResult["orderByCoverage"],
    joinCoverage: IndexReviewResult["joinCoverage"],
    suggestedIndexes: ReadonlyArray<IndexDefinition>,
    fullTableScanRisk: boolean
  ): string {
    const lines: string[] = [];
    lines.push(`索引评审报告 - 表 ${tableName}`);
    lines.push(
      `- 评审 SQL 数量：WHERE=${whereCoverage.length} ORDER BY=${orderByCoverage.length} JOIN=${joinCoverage.length}`
    );
    lines.push(`- 全表扫描风险：${fullTableScanRisk ? "是（TCS-SQL-01 违规）" : "否"}`);
    if (suggestedIndexes.length > 0) {
      lines.push(`- 建议新增索引：`);
      for (const idx of suggestedIndexes) {
        lines.push(`  - ${idx.name}: (${idx.columns.join(", ")}) type=${idx.type}`);
      }
    } else {
      lines.push(`- 建议新增索引：无`);
    }
    return lines.join("\n");
  }
}

// ============================================================================
// 4. N+1 查询检测器实现（NPlusOneDetector）
// ============================================================================

/**
 * N+1 查询检测器实现
 *
 * 实现 SqlOptimizationPort.detectNPlusOne 方法，静态扫描代码片段检测 N+1 查询模式。
 *
 * 检测算法：
 * 1. 识别代码中的循环语句（for / forEach / while / map 等）
 * 2. 在循环体内识别查询调用（findUnique / findOne / query 等）
 * 3. 若循环内存在查询调用，标记为 N+1 模式（对齐 TCS-SQL-02 红线）
 * 4. 计算置信度：循环 + 查询调用 = 0.7，循环 + 查询调用 + await = 0.9
 * 5. 生成修复建议（建议使用批量查询如 findMany + IN 子句）
 *
 * 检测准确性：
 * - 真阳性：循环内调用 findUnique / findOne 等单条查询
 * - 误报风险：循环内调用 findMany 等批量查询（误报可通过 patterns.querySnippet 验证）
 * - 漏报风险：循环内通过函数调用间接查询（静态分析无法识别）
 */
export class NPlusOneDetector {
  /**
   * 检测代码片段中的 N+1 查询模式
   *
   * @param filePath 文件路径
   * @param codeContent 代码内容
   * @returns N+1 检测结果
   */
  detect(filePath: string, codeContent: string): NPlusOneDetectionResult {
    const lines = codeContent.split("\n");
    // 使用可变数组累加检测结果，最终返回时通过 Object.freeze 冻结
    const patterns: Array<{
      startLine: number;
      endLine: number;
      loopType: "for" | "forEach" | "while" | "map";
      querySnippet: string;
      confidence: number;
      fixSuggestion: string;
    }> = [];
    const visitedLines = new Set<number>();

    // 构建查询关键词正则（匹配如 .findUnique( / .findOne( / await query( 等）
    const queryCallRegex = new RegExp(`\\.?(?:${QUERY_CALL_KEYWORDS.join("|")})\\s*\\(`, "g");

    // 检测每行代码
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNumber = i + 1;

      // 检测循环语句（for / forEach / while / map / filter / reduce / flatMap）
      // 字符类内 ( 与 { 均为字面字符，无需转义
      const loopMatch = line.match(/\b(for|forEach|while|map|filter|reduce|flatMap)\b\s*[({]/);
      if (!loopMatch) {
        continue;
      }
      if (visitedLines.has(lineNumber)) {
        continue;
      }
      visitedLines.add(lineNumber);

      const loopType = this.normalizeLoopType(loopMatch[1]!);

      // 检查循环所在行是否是无大括号箭头函数（如 orders.map((o) => o.userId)）
      // 无大括号箭头函数（=> expression）的循环体只到当前行结束，
      // 不应向后扫描——否则会将循环外的查询调用误报为循环内 N+1 模式。
      // 例如：
      //   const userIds = orders.map((o) => o.userId);  // 循环体只到本行
      //   const users = await prisma.user.findMany(...);  // 这是循环外的查询，不是 N+1
      //
      // 判定规则：
      // - 若行内含 => 且 => 后第一个非空白字符为 {，则为大括号块箭头函数（=> { ... }），循环体可跨行，需向后扫描
      // - 若行内含 => 但 => 后第一个非空白字符不是 {，则为表达式箭头函数（=> expression），循环体仅当前行
      //
      // 实现说明：
      // - 不能使用 /=>\s*[^{]/ 检测表达式箭头函数，因为正则回溯会让 \s* 匹配 0 个字符，
      //   导致 "=> {" 中的空格被 [^{] 匹配，错误地将块箭头函数识别为表达式箭头函数。
      // - 正确做法是显式检测块箭头函数（=>\s*\{），再通过"含 => 但不含块箭头"判定表达式箭头。
      const hasArrow = /=>/.test(line);
      const hasArrowBlock = /=>\s*\{/.test(line);
      const isSingleLineArrow = hasArrow && !hasArrowBlock;

      let queryLine: number | null = null;
      let querySnippet = "";
      let confidence = 0.7; // 基础置信度：循环 + 查询调用

      if (isSingleLineArrow) {
        // 无大括号箭头函数——循环体只到当前行
        // 仅检查当前行是否有查询调用（单表达式箭头函数内很少有查询调用，但仍需检查）
        const queryMatch = line.match(queryCallRegex);
        if (queryMatch) {
          queryLine = lineNumber;
          querySnippet = line.trim();
          // 若查询调用前有 await 关键字，置信度提升至 0.9（明确异步查询）
          if (/\bawait\b/.test(line)) {
            confidence = 0.9;
          }
        }
      } else {
        // 有大括号的循环体（for/while/=> { ... }）——向后扫描查找查询调用
        // 简化算法：向后扫描最多 50 行，查找查询调用
        const maxLookAhead = 50;
        const endLine = Math.min(lines.length, lineNumber + maxLookAhead);

        for (let j = lineNumber; j < endLine; j++) {
          const innerLine = lines[j - 1]!;
          const queryMatch = innerLine.match(queryCallRegex);
          if (queryMatch) {
            queryLine = j;
            querySnippet = innerLine.trim();
            // 若查询调用前有 await 关键字，置信度提升至 0.9（明确异步查询）
            if (/\bawait\b/.test(innerLine)) {
              confidence = 0.9;
            }
            break;
          }
          // 简化的循环体结束判定：遇到与循环同级的闭合大括号
          if (innerLine.match(/^\s*\}\s*[,;]?$/) && j > lineNumber) {
            break;
          }
        }
      }

      if (queryLine !== null && confidence >= MIN_DETECTION_CONFIDENCE) {
        patterns.push({
          startLine: lineNumber,
          endLine: queryLine,
          loopType,
          querySnippet,
          confidence,
          fixSuggestion: this.buildFixSuggestion(loopType, querySnippet),
        });
      }
    }

    // 按起始行号排序
    patterns.sort((a, b) => a.startLine - b.startLine);

    return {
      filePath,
      detected: patterns.length > 0,
      patterns: Object.freeze(patterns),
      notes: this.buildDetectionNotes(patterns),
    };
  }

  /**
   * 规范化循环类型
   *
   * 将检测到的循环关键词映射到标准类型。
   *
   * @param keyword 循环关键词
   * @returns 标准循环类型
   */
  private normalizeLoopType(keyword: string): "for" | "forEach" | "while" | "map" {
    switch (keyword) {
      case "for":
        return "for";
      case "forEach":
        return "forEach";
      case "while":
        return "while";
      case "map":
      case "filter":
      case "reduce":
      case "flatMap":
        return "map"; // 这些方法本质都是迭代
      default:
        return "for";
    }
  }

  /**
   * 构建修复建议
   *
   * 根据循环类型与查询调用，生成具体的修复建议。
   *
   * @param loopType 循环类型
   * @param querySnippet 查询调用片段
   * @returns 修复建议字符串
   */
  private buildFixSuggestion(loopType: string, querySnippet: string): string {
    // 从查询调用中提取被查询的实体名（如 userRepo.findUnique → userRepo）
    const entityMatch = querySnippet.match(
      /([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*(?:findUnique|findOne|findById|findByPk|find)/
    );
    const entityName = entityMatch ? entityMatch[1] : "repository";

    return [
      `检测到 ${loopType} 循环内单条查询调用：${querySnippet}`,
      `修复建议（消除 N+1 模式）：`,
      `1. 在循环外批量查询所需数据，使用 IN 子句一次性获取：`,
      `   const ids = items.map(item => item.id);`,
      `   const ${entityName}Map = await ${entityName}.findMany({ where: { id: { in: ids } } });`,
      `2. 在循环内从 Map 中查找已批量加载的数据：`,
      `   const data = ${entityName}Map.find(d => d.id === item.id);`,
      `3. 若使用 ORM，启用 include/fetch 策略一次性加载关联数据：`,
      `   await ${entityName}.findMany({ include: { related: true } });`,
    ].join("\n");
  }

  /**
   * 构建检测备注
   *
   * @param patterns 检测到的 N+1 模式列表
   * @returns 检测备注字符串
   */
  private buildDetectionNotes(patterns: NPlusOneDetectionResult["patterns"]): string {
    if (patterns.length === 0) {
      return "未检测到 N+1 查询模式（合规）";
    }
    const lines: string[] = [];
    lines.push(`检测到 ${patterns.length} 处 N+1 查询模式（TCS-SQL-02 违规）：`);
    for (const p of patterns) {
      lines.push(`- 行 ${p.startLine}-${p.endLine} (${p.loopType} 循环内查询，置信度 ${p.confidence})`);
    }
    return lines.join("\n");
  }
}

// ============================================================================
// 5. 分页规范检查器实现（PaginationChecker）
// ============================================================================

/**
 * 分页规范检查器实现
 *
 * 实现 SqlOptimizationPort.checkPagination 方法，检查 SQL 语句的分页参数合规性。
 *
 * 检查规则（对齐 §5.8.3 规范与 TCS-SQL-03 红线）：
 * - 解析 LIMIT 与 OFFSET 子句
 * - 若 OFFSET > 10000，标记为深分页（isDeepPagination=true）
 * - 提供修复建议：改用游标分页（cursor-based pagination）或 keyset 分页
 */
export class PaginationChecker {
  /**
   * 检查分页规范合规性
   *
   * @param sql SQL 语句
   * @returns 分页规范检查结果
   */
  check(sql: string): PaginationCheckResult {
    // 解析 LIMIT 子句
    const limitMatch = sql.match(/\bLIMIT\s+(\d+)/i);
    const offsetMatch = sql.match(/\bOFFSET\s+(\d+)/i);

    const limit = limitMatch ? parseInt(limitMatch[1]!, 10) : 0;
    const offset = offsetMatch ? parseInt(offsetMatch[1]!, 10) : 0;

    // 判定是否为深分页（offset > 10000）
    const isDeepPagination = offset > DEEP_PAGINATION_THRESHOLD;

    // 构建修复建议
    let fixSuggestion: string | null = null;
    if (isDeepPagination) {
      fixSuggestion = [
        `检测到深分页：OFFSET=${offset}（超过阈值 ${DEEP_PAGINATION_THRESHOLD}），违反 TCS-SQL-03 红线。`,
        `修复建议（改用游标/keyset 分页）：`,
        `1. 游标分页（推荐）：基于上一页最后一条记录的 ID 进行分页`,
        `   SELECT * FROM table WHERE id > ?last_id ORDER BY id ASC LIMIT ?page_size;`,
        `2. Keyset 分页：基于上一页最后一条记录的排序键进行分页`,
        `   SELECT * FROM table WHERE (created_at, id) > (?last_created_at, ?last_id) ORDER BY created_at, id LIMIT ?page_size;`,
        `3. 子查询优化：先通过覆盖索引查询主键，再 JOIN 获取完整记录`,
        `   SELECT * FROM table t INNER JOIN (SELECT id FROM table ORDER BY id LIMIT ?page_size OFFSET ?offset) tmp ON t.id = tmp.id;`,
      ].join("\n");
    }

    return {
      sql,
      isDeepPagination,
      offset,
      limit,
      compliant: !isDeepPagination,
      fixSuggestion,
    };
  }
}

// ============================================================================
// 6. 综合优化器实现（SqlOptimizer，组合三个检查器）
// ============================================================================

/**
 * SQL 查询优化器实现（组合 IndexReviewer + NPlusOneDetector + PaginationChecker）
 *
 * 实现 SqlOptimizationPort 接口，将三个检查器组合在一起，
 * 为业务代码提供统一的 SQL 优化入口。
 *
 * 业务代码禁止直接 import 本类，必须通过依赖注入获取 SqlOptimizationPort。
 */
export class SqlOptimizer implements SqlOptimizationPort {
  /** 索引评审器 */
  private readonly indexReviewer: IndexReviewer;
  /** N+1 查询检测器 */
  private readonly nplusOneDetector: NPlusOneDetector;
  /** 分页规范检查器 */
  private readonly paginationChecker: PaginationChecker;

  constructor() {
    this.indexReviewer = new IndexReviewer();
    this.nplusOneDetector = new NPlusOneDetector();
    this.paginationChecker = new PaginationChecker();
  }

  /** @inheritdoc */
  reviewIndex(input: IndexReviewInput): IndexReviewResult {
    return this.indexReviewer.review(input);
  }

  /** @inheritdoc */
  detectNPlusOne(filePath: string, codeContent: string): NPlusOneDetectionResult {
    return this.nplusOneDetector.detect(filePath, codeContent);
  }

  /** @inheritdoc */
  checkPagination(sql: string): PaginationCheckResult {
    return this.paginationChecker.check(sql);
  }
}

// ============================================================================
// 7. 工厂函数
// ============================================================================

/**
 * 构造默认 SqlOptimizationPort 实例
 *
 * @returns SqlOptimizer 实例（实现 SqlOptimizationPort 接口）
 */
export function createSqlOptimizer(): SqlOptimizationPort {
  return new SqlOptimizer();
}
