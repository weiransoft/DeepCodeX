/**
 * Fixture: TCS-SQL-01 全表扫描（违规样例）
 *
 * @fixtureId sql-pattern-checker/tcs-sql-01-select-all.violation
 * @checker SqlPatternChecker
 * @redlineIds TCS-SQL-01
 * @kind violation
 * @expectVerdict violated
 * @description SQL 字符串含 SELECT * FROM users WHERE status = ?——疑似全表扫描，违反 TCS-SQL-01 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/infrastructure/persistence/UserRepository.ts",
    content: `// src/infrastructure/persistence/UserRepository.ts
import { DatabaseClient } from "../database/DatabaseClient";

/**
 * 用户仓储——违规点：SQL 含 SELECT * 全表扫描
 */
export class UserRepository {
  constructor(private readonly db: DatabaseClient) {}

  /**
   * 按状态查询用户——违规点：使用 SELECT * 全表扫描
   */
  async findByStatus(status: string): Promise<User[]> {
    // 违规点：SQL 字符串含 SELECT * FROM users WHERE status = ?
    const sql = "SELECT * FROM users WHERE status = ?";
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
