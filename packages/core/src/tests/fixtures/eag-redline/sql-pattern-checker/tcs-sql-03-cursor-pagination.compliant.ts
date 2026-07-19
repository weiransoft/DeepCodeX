/**
 * Fixture: TCS-SQL-03 游标分页（合规样例）
 *
 * @fixtureId sql-pattern-checker/tcs-sql-03-cursor-pagination.compliant
 * @checker SqlPatternChecker
 * @redlineIds TCS-SQL-03
 * @kind compliant
 * @expectVerdict passed
 * @description 游标分页 WHERE id > lastId ORDER BY id LIMIT 20——无 OFFSET，符合 TCS-SQL-03 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/infrastructure/persistence/ReportRepository.ts",
    content: `// src/infrastructure/persistence/ReportRepository.ts
import { DatabaseClient } from "../database/DatabaseClient";

/**
 * 报表仓储——合规点：游标分页（无 OFFSET）
 */
export class ReportRepository {
  constructor(private readonly db: DatabaseClient) {}

  /**
   * 分页查询日志——合规点：使用游标分页
   */
  async findLogs(lastId: string | null, pageSize: number): Promise<Log[]> {
    // 合规点：游标分页 WHERE id > lastId ORDER BY id LIMIT 20，无 OFFSET
    const sql = lastId
      ? \`SELECT id, message, created_at FROM logs WHERE id > ? ORDER BY id LIMIT \${pageSize}\`
      : \`SELECT id, message, created_at FROM logs ORDER BY id LIMIT \${pageSize}\`;
    const params = lastId ? [lastId] : [];
    const rows = await this.db.query(sql, params);
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
