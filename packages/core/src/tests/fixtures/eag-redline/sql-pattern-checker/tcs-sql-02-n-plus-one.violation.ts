/**
 * Fixture: TCS-SQL-02 N+1 查询（违规样例）
 *
 * @fixtureId sql-pattern-checker/tcs-sql-02-n-plus-one.violation
 * @checker SqlPatternChecker
 * @redlineIds TCS-SQL-02
 * @kind violation
 * @expectVerdict violated
 * @description for 循环体内调用 db.findOne(id)——N+1 查询问题，违反 TCS-SQL-02 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/infrastructure/persistence/OrderRepository.ts",
    content: `// src/infrastructure/persistence/OrderRepository.ts
import { DatabaseClient } from "../database/DatabaseClient";

/**
 * 订单仓储——违规点：循环内单条查询（N+1 问题）
 */
export class OrderRepository {
  constructor(private readonly db: DatabaseClient) {}

  /**
   * 批量查询订单——违规点：循环内调用 db.findOne
   */
  async findByIds(orderIds: string[]): Promise<Order[]> {
    const orders: Order[] = [];
    // 违规点：for 循环体内逐条调用 db.findOne，导致 N+1 查询问题
    for (const id of orderIds) {
      const order = await this.db.findOne("orders", id);
      if (order) {
        orders.push(order);
      }
    }
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
