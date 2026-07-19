/**
 * Fixture: TCS-SQL-02 批量查询（合规样例）
 *
 * @fixtureId sql-pattern-checker/tcs-sql-02-batch-query.compliant
 * @checker SqlPatternChecker
 * @redlineIds TCS-SQL-02
 * @kind compliant
 * @expectVerdict passed
 * @description 循环外批量查询 db.findMany({ where: { id: { in: ids } } })——符合 TCS-SQL-02 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/infrastructure/persistence/OrderRepository.ts",
    content: `// src/infrastructure/persistence/OrderRepository.ts
import { DatabaseClient } from "../database/DatabaseClient";

/**
 * 订单仓储——合规点：循环外批量查询
 */
export class OrderRepository {
  constructor(private readonly db: DatabaseClient) {}

  /**
   * 批量查询订单——合规点：循环外批量查询
   */
  async findByIds(orderIds: string[]): Promise<Order[]> {
    // 合规点：循环外批量查询 db.findMany({ where: { id: { in: orderIds } } })
    const orders = await this.db.findMany("orders", {
      where: {
        id: { in: orderIds },
      },
    });
    return orders;
  }
}

interface Order {
  id: string;
  userId: string;
  total: number;
  status: string;
}
`,
  },
]);
