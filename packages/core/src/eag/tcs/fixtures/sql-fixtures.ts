/**
 * TCS SQL 优化红线 fixtures（TCS-SQL-01 / TCS-SQL-02 / TCS-SQL-03）
 *
 * 每条红线 1 个违规样例 + 1 个合规样例（共 6 个 fixture），
 * 用于测试评估器对 SQL 优化红线的判定准确性。
 *
 * 设计依据：
 * - EAG 方案 §5.8.3 SQL 查询优化规范
 * - eag/tcs/sql-optimizer.ts（IndexReviewer + NPlusOneDetector + PaginationChecker + SqlOptimizer）
 * - eag/tcs/tcs-redlines.ts（TCS-SQL-01/02/03 红线定义）
 *
 * @module eag/tcs/fixtures/sql-fixtures
 */

// 引入 deepFreeze 用于递归冻结 fixture 及其嵌套的 expectedViolations 数组。
// Object.freeze 是浅冻结，无法冻结嵌套的 expectedViolations 数组本身——
// F12 测试断言 Object.isFrozen(f.expectedViolations) 必须为 true，
// 因此改用 deepFreeze（types.ts 中已实现）递归冻结所有层级。
import { deepFreeze, type RedlineFixture } from "../types";

// ============================================================================
// TCS-SQL-01：全表扫描（无索引覆盖的 WHERE）
// ============================================================================

/**
 * TCS-SQL-01 违规样例：WHERE 字段未建立索引（全表扫描）
 *
 * 场景：查询 orders 表时 WHERE status='PAID' AND created_at > '2026-01-01'，
 * 但 idx_orders_status_created_at 索引不存在，导致全表扫描。
 */
export const SQL_01_VIOLATION: RedlineFixture = deepFreeze({
  redlineId: "TCS-SQL-01",
  kind: "violation",
  description:
    "业务代码（order-query.ts）生成的 SQL 查询 WHERE status='PAID' AND created_at > '2026-01-01'，" +
    "但 orders 表仅有主键索引，未在 (status, created_at) 上建立联合索引，" +
    "导致全表扫描。orders 表数据量 100 万行，查询耗时从毫秒级退化为秒级，DB CPU 负载激增。",
  code: [
    "// src/services/order-query.ts",
    "import type { PrismaClient } from '@prisma/client';",
    "",
    "export class OrderQueryService {",
    "  constructor(private readonly prisma: PrismaClient) {}",
    "",
    "  /** 查询待支付订单（违规：WHERE 字段无索引覆盖，全表扫描） */",
    "  async findPendingOrders(since: Date): Promise<Order[]> {",
    "    // 违规：status 与 created_at 字段均无索引，触发全表扫描",
    "    return await this.prisma.order.findMany({",
    "      where: {",
    "        status: 'PAID',",
    "        createdAt: { gt: since },",
    "      },",
    "      orderBy: { createdAt: 'desc' },",
    "    });",
    "  }",
    "}",
    "",
    "// 数据库迁移脚本（缺失联合索引）",
    "// CREATE TABLE orders (",
    "//   id BIGINT PRIMARY KEY,",
    "//   status VARCHAR(20) NOT NULL,",
    "//   created_at DATETIME NOT NULL,",
    "//   amount DECIMAL(10,2) NOT NULL",
    "// );",
    "// 缺少：CREATE INDEX idx_orders_status_created_at ON orders (status, created_at);",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [
    {
      filePath: "src/services/order-query.ts",
      line: 11,
      description:
        "WHERE status='PAID' AND created_at > ? 字段未建立索引覆盖，触发全表扫描，违反 TCS-SQL-01 红线。应添加 CREATE INDEX idx_orders_status_created_at ON orders (status, created_at)",
    },
  ],
  expectedVerdict: "violated",
});

/**
 * TCS-SQL-01 合规样例：WHERE 字段建立联合索引（最左前缀）
 *
 * 场景：在 (status, created_at) 上建立联合索引 idx_orders_status_created_at，
 * 查询 WHERE status='PAID' AND created_at > '2026-01-01' 命中索引最左前缀。
 */
export const SQL_01_COMPLIANT: RedlineFixture = deepFreeze({
  redlineId: "TCS-SQL-01",
  kind: "compliant",
  description:
    "业务代码（order-query.ts）查询 orders 表 WHERE status='PAID' AND created_at > '2026-01-01'，" +
    "数据库迁移脚本在 (status, created_at) 上建立联合索引 idx_orders_status_created_at，" +
    "查询命中索引最左前缀，符合 §5.8.3 规范。",
  code: [
    "// src/services/order-query.ts",
    "import type { PrismaClient } from '@prisma/client';",
    "",
    "export class OrderQueryService {",
    "  constructor(private readonly prisma: PrismaClient) {}",
    "",
    "  /** 查询待支付订单（合规：WHERE 字段有联合索引覆盖） */",
    "  async findPendingOrders(since: Date): Promise<Order[]> {",
    "    // 合规：(status, created_at) 已建立联合索引，命中索引",
    "    return await this.prisma.order.findMany({",
    "      where: {",
    "        status: 'PAID',",
    "        createdAt: { gt: since },",
    "      },",
    "      orderBy: { createdAt: 'desc' },",
    "    });",
    "  }",
    "}",
    "",
    "// 数据库迁移脚本（已建立联合索引）",
    "// CREATE TABLE orders (",
    "//   id BIGINT PRIMARY KEY,",
    "//   status VARCHAR(20) NOT NULL,",
    "//   created_at DATETIME NOT NULL,",
    "//   amount DECIMAL(10,2) NOT NULL",
    "// );",
    "// CREATE INDEX idx_orders_status_created_at ON orders (status, created_at);",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [],
  expectedVerdict: "passed",
});

// ============================================================================
// TCS-SQL-02：循环内单条查询（N+1）
// ============================================================================

/**
 * TCS-SQL-02 违规样例：循环内调用 findOne（N+1 查询）
 *
 * 场景：业务代码在 for 循环内对每个 order 调用 userRepo.findOne(order.userId)，
 * 查询次数从 1 次退化为 N+1 次（N 为订单数量），网络往返次数激增。
 */
export const SQL_02_VIOLATION: RedlineFixture = deepFreeze({
  redlineId: "TCS-SQL-02",
  kind: "violation",
  description:
    "业务代码（order-list.ts）在 for 循环内对每个订单调用 userRepo.findOne(order.userId) 查询用户信息，" +
    "形成 N+1 查询模式。100 个订单需要 101 次查询（1 次订单列表 + 100 次用户查询），" +
    "网络往返次数激增，DB 连接池在高并发场景下快速耗尽。",
  code: [
    "// src/services/order-list.ts",
    "import type { PrismaClient } from '@prisma/client';",
    "",
    "export class OrderListService {",
    "  constructor(private readonly prisma: PrismaClient) {}",
    "",
    "  /** 查询订单列表含用户信息（违规：循环内单条查询，N+1 模式） */",
    "  async listOrdersWithUser(): Promise<Array<Order & { user: User | null }>> {",
    "    const orders = await this.prisma.order.findMany({ take: 100 });",
    "    const result: Array<Order & { user: User | null }> = [];",
    "    // 违规：循环内单条查询用户（N+1 模式）",
    "    for (const order of orders) {",
    "      const user = await this.prisma.user.findUnique({",
    "        where: { id: order.userId },",
    "      });",
    "      result.push({ ...order, user });",
    "    }",
    "    return result;",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [
    {
      filePath: "src/services/order-list.ts",
      line: 14,
      description:
        "for 循环内调用 prisma.user.findUnique——N+1 查询模式，违反 TCS-SQL-02 红线。应改为循环外批量查询：findMany({ where: { id: { in: userIds } } })",
    },
  ],
  expectedVerdict: "violated",
});

/**
 * TCS-SQL-02 合规样例：循环外批量查询（findMany + IN）
 *
 * 场景：业务代码先批量查询所有订单，再批量查询所有用户（findMany + IN 子句），
 * 最后从内存 Map 中查找用户，查询次数固定为 2 次（1 次订单 + 1 次用户）。
 */
export const SQL_02_COMPLIANT: RedlineFixture = deepFreeze({
  redlineId: "TCS-SQL-02",
  kind: "compliant",
  description:
    "业务代码（order-list.ts）循环外批量查询所有用户（findMany + IN 子句），" +
    "再用内存 Map 关联订单与用户。查询次数固定为 2 次（1 次订单 + 1 次用户），" +
    "符合 §5.8.3 规范。",
  code: [
    "// src/services/order-list.ts",
    "import type { PrismaClient } from '@prisma/client';",
    "",
    "export class OrderListService {",
    "  constructor(private readonly prisma: PrismaClient) {}",
    "",
    "  /** 查询订单列表含用户信息（合规：循环外批量查询） */",
    "  async listOrdersWithUser(): Promise<Array<Order & { user: User | null }>> {",
    "    const orders = await this.prisma.order.findMany({ take: 100 });",
    "    // 合规：循环外批量查询所有用户",
    "    const userIds = orders.map((o) => o.userId);",
    "    const users = await this.prisma.user.findMany({",
    "      where: { id: { in: userIds } },",
    "    });",
    "    // 合规：内存 Map 关联订单与用户",
    "    const userMap = new Map(users.map((u) => [u.id, u]));",
    "    return orders.map((order) => ({",
    "      ...order,",
    "      user: userMap.get(order.userId) ?? null,",
    "    }));",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [],
  expectedVerdict: "passed",
});

// ============================================================================
// TCS-SQL-03：深分页 offset 滥用
// ============================================================================

/**
 * TCS-SQL-03 违规样例：深分页 OFFSET 100000
 *
 * 场景：业务代码使用 prisma.order.findMany({ skip: 100000, take: 20 }) 深分页，
 * DB 需扫描 100020 行后丢弃前 100000 行，性能极差。
 */
export const SQL_03_VIOLATION: RedlineFixture = deepFreeze({
  redlineId: "TCS-SQL-03",
  kind: "violation",
  description:
    "业务代码（order-export.ts）使用 prisma.order.findMany({ skip: 100000, take: 20 }) 深分页，" +
    "OFFSET=100000 超过 §5.8.3 规范允许的 10000 阈值（DEEP_PAGINATION_THRESHOLD）。" +
    "DB 需扫描 100020 行后丢弃前 100000 行，性能极差，DB CPU 与 IO 负载激增。",
  code: [
    "// src/services/order-export.ts",
    "import type { PrismaClient } from '@prisma/client';",
    "",
    "export class OrderExportService {",
    "  constructor(private readonly prisma: PrismaClient) {}",
    "",
    "  /** 分页导出订单（违规：深分页 OFFSET 100000） */",
    "  async exportOrders(page: number, pageSize: number): Promise<Order[]> {",
    "    // 违规：OFFSET 100000 深分页，超过 10000 阈值",
    "    return await this.prisma.order.findMany({",
    "      skip: page * pageSize, // 当 page=5000, pageSize=20 时 skip=100000",
    "      take: pageSize,",
    "      orderBy: { id: 'asc' },",
    "    });",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [
    {
      filePath: "src/services/order-export.ts",
      line: 10,
      description:
        "findMany skip=100000 超过深分页阈值 10000——违反 TCS-SQL-03 红线。应改用游标分页：WHERE id > ?last_id ORDER BY id LIMIT 20",
    },
  ],
  expectedVerdict: "violated",
});

/**
 * TCS-SQL-03 合规样例：游标分页（keyset pagination）
 *
 * 场景：业务代码使用 WHERE id > ?last_id ORDER BY id LIMIT 20 游标分页，
 * DB 只需扫描 20 行（从 last_id 位置开始），性能稳定。
 */
export const SQL_03_COMPLIANT: RedlineFixture = deepFreeze({
  redlineId: "TCS-SQL-03",
  kind: "compliant",
  description:
    "业务代码（order-export.ts）使用游标分页（WHERE id > ?last_id ORDER BY id LIMIT 20），" +
    "DB 只需扫描 20 行（从 last_id 位置开始），性能稳定不随页数增加退化，符合 §5.8.3 规范。",
  code: [
    "// src/services/order-export.ts",
    "import type { PrismaClient } from '@prisma/client';",
    "",
    "export class OrderExportService {",
    "  constructor(private readonly prisma: PrismaClient) {}",
    "",
    "  /** 游标分页导出订单（合规：WHERE id > last_id） */",
    "  async exportOrders(lastId: number | null, pageSize: number): Promise<Order[]> {",
    "    // 合规：游标分页，DB 只扫描 pageSize 行",
    "    return await this.prisma.order.findMany({",
    "      where: lastId !== null ? { id: { gt: lastId } } : undefined,",
    "      take: pageSize,",
    "      orderBy: { id: 'asc' },",
    "    });",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [],
  expectedVerdict: "passed",
});

// ============================================================================
// SQL fixtures 聚合导出
// ============================================================================

/**
 * SQL 优化全部 fixtures（6 个，TCS-SQL-01/02/03 各 2 个）
 */
export const SQL_FIXTURES: ReadonlyArray<RedlineFixture> = Object.freeze([
  SQL_01_VIOLATION,
  SQL_01_COMPLIANT,
  SQL_02_VIOLATION,
  SQL_02_COMPLIANT,
  SQL_03_VIOLATION,
  SQL_03_COMPLIANT,
]);
