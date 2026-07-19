/**
 * Fixture: TCS-SQL-03 深分页 OFFSET 滥用（违规样例）
 *
 * @fixtureId sql-pattern-checker/tcs-sql-03-deep-offset.violation
 * @checker SqlPatternChecker
 * @redlineIds TCS-SQL-03
 * @kind violation
 * @expectVerdict violated
 * @description SQL 含 OFFSET 15000（> 10000 阈值）——深分页性能问题，违反 TCS-SQL-03 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/infrastructure/persistence/ReportRepository.ts",
    content: `// src/infrastructure/persistence/ReportRepository.ts
import { DatabaseClient } from "../database/DatabaseClient";

/**
 * 报表仓储——违规点：深分页 OFFSET 滥用
 */
export class ReportRepository {
  constructor(private readonly db: DatabaseClient) {}

  /**
   * 分页查询日志——违规点：使用 OFFSET 15000 深分页
   */
  async findLogs(page: number, pageSize: number): Promise<Log[]> {
    const offset = (page - 1) * pageSize;
    // 违规点：SQL 含 OFFSET 15000（> 10000 阈值）
    const sql = \`SELECT id, message, created_at FROM logs ORDER BY id LIMIT \${pageSize} OFFSET \${offset}\`;
    const rows = await this.db.query(sql);
    return rows.map((row) => this.mapToLog(row));
  }

  private mapToLog(row: Record<string, unknown>): Log {
    return {
      id: row.id as string,
      message: row.message as string,
      createdAt: row.created_at as Date,
    };
  }
}

interface Log {
  id: string;
  message: string;
  createdAt: Date;
}
`,
  },
]);
