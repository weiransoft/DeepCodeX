/**
 * Fixture: TCS-SQL-01 显式列字段（合规样例）
 *
 * @fixtureId sql-pattern-checker/tcs-sql-01-explicit-columns.compliant
 * @checker SqlPatternChecker
 * @redlineIds TCS-SQL-01
 * @kind compliant
 * @expectVerdict passed
 * @description SQL 显式列字段 SELECT id, name, status FROM users WHERE status = ?——符合 TCS-SQL-01 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/infrastructure/persistence/UserRepository.ts",
    content: `// src/infrastructure/persistence/UserRepository.ts
import { DatabaseClient } from "../database/DatabaseClient";

/**
 * 用户仓储——合规点：SQL 显式列字段
 */
export class UserRepository {
  constructor(private readonly db: DatabaseClient) {}

  /**
   * 按状态查询用户——合规点：显式列字段，避免全表扫描
   */
  async findByStatus(status: string): Promise<User[]> {
    // 合规点：SQL 显式列字段 SELECT id, name, status FROM users WHERE status = ?
    const sql = "SELECT id, username, email, status FROM users WHERE status = ?";
    const rows = await this.db.query(sql, [status]);
    return rows.map((row) => this.mapToUser(row));
  }

  private mapToUser(row: Record<string, unknown>): User {
    return {
      id: row.id as string,
      username: row.username as string,
      email: row.email as string,
      status: row.status as string,
    };
  }
}

interface User {
  id: string;
  username: string;
  email: string;
  status: string;
}
`,
  },
]);
