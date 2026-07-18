/**
 * EAG-P2 批次 7 单元测试：TCS SQL 优化器（sql-optimizer.ts）
 *
 * 测试范围：
 * - S1. DEEP_PAGINATION_THRESHOLD 为 10000（深分页阈值）
 * - S2. IndexReviewer 索引评审——WHERE 字段被索引覆盖
 * - S3. IndexReviewer 索引评审——WHERE 字段无索引（fullTableScanRisk=true，TCS-SQL-01 红线）
 * - S4. IndexReviewer 联合索引最左前缀匹配
 * - S5. IndexReviewer 生成缺失索引建议（suggestedIndexes）
 * - S6. NPlusOneDetector 检测循环内 findUnique（N+1 模式，TCS-SQL-02 红线）
 * - S7. NPlusOneDetector 检测循环内 findOne / find / query
 * - S8. NPlusOneDetector 循环外查询不报错（合规）
 * - S9. PaginationChecker 浅分页合规（offset ≤ 10000）
 * - S10. PaginationChecker 深分页违规（offset > 10000，TCS-SQL-03 红线）
 * - S11. SqlOptimizer 实现 SqlOptimizationPort 接口
 * - S12. createSqlOptimizer 工厂函数
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，直接调用真实 IndexReviewer/NPlusOneDetector/PaginationChecker/SqlOptimizer
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - EAG 方案 §5.8.3 SQL 查询优化规范
 * - eag/tcs/sql-optimizer.ts 源文件（被测对象）
 *
 * @module core/tests/eag-tcs-sql-optimizer
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEEP_PAGINATION_THRESHOLD,
  QUERY_CALL_KEYWORDS,
  LOOP_KEYWORDS,
  MIN_DETECTION_CONFIDENCE,
  IndexReviewer,
  NPlusOneDetector,
  PaginationChecker,
  SqlOptimizer,
  createSqlOptimizer,
  type SqlOptimizationPort,
} from "../eag/tcs/sql-optimizer";
import type {
  IndexReviewInput,
  IndexDefinition,
  ModelFieldDefinition,
  IndexReviewResult,
  NPlusOneDetectionResult,
  PaginationCheckResult,
} from "../eag/tcs/types";

// ============================================================================
// 辅助：构造测试数据
// ============================================================================

/**
 * 构造测试用索引（联合索引 idx_orders_status_created_at (status, created_at)）
 */
function makeCompositeIndex(): IndexDefinition {
  return {
    name: "idx_orders_status_created_at",
    columns: ["status", "created_at"],
    type: "btree",
    unique: false,
    isPrimaryKey: false,
  };
}

/**
 * 构造测试用主键索引
 */
function makePrimaryKeyIndex(): IndexDefinition {
  return {
    name: "PRIMARY",
    columns: ["id"],
    type: "btree",
    unique: true,
    isPrimaryKey: true,
  };
}

/**
 * 构造测试用 ORM 模型字段
 */
function makeOrderModelFields(): ReadonlyArray<ModelFieldDefinition> {
  return [
    { name: "id", type: "number", nullable: false, isForeignKey: false },
    { name: "status", type: "string", nullable: false, isForeignKey: false },
    { name: "created_at", type: "Date", nullable: false, isForeignKey: false },
    { name: "amount", type: "number", nullable: false, isForeignKey: false },
    { name: "user_id", type: "number", nullable: false, isForeignKey: true, referencesTable: "users" },
  ];
}

// ============================================================================
// S1. DEEP_PAGINATION_THRESHOLD
// ============================================================================

test("S1a. DEEP_PAGINATION_THRESHOLD 为 10000", () => {
  assert.equal(DEEP_PAGINATION_THRESHOLD, 10000);
});

test("S1b. QUERY_CALL_KEYWORDS 包含常见 ORM 查询方法名", () => {
  // 应包含 findUnique / findOne / find / query 等查询关键字
  const keywords = [...QUERY_CALL_KEYWORDS];
  assert.ok(keywords.length > 0);
  // 至少包含 find 或 query 相关关键字
  assert.ok(keywords.some((k) => k.includes("find") || k.includes("query")));
});

test("S1c. LOOP_KEYWORDS 包含常见循环关键字", () => {
  const keywords = [...LOOP_KEYWORDS];
  assert.ok(keywords.includes("for"));
  assert.ok(keywords.includes("forEach") || keywords.includes("foreach"));
  assert.ok(keywords.includes("while"));
});

test("S1d. MIN_DETECTION_CONFIDENCE 在 (0, 1] 范围内", () => {
  assert.ok(MIN_DETECTION_CONFIDENCE > 0);
  assert.ok(MIN_DETECTION_CONFIDENCE <= 1);
});

// ============================================================================
// S2. IndexReviewer WHERE 字段被索引覆盖
// ============================================================================

test("S2. IndexReviewer WHERE 字段被索引覆盖时 fullTableScanRisk=false", () => {
  const reviewer = new IndexReviewer();
  const input: IndexReviewInput = {
    tableName: "orders",
    sqlStatements: ["SELECT * FROM orders WHERE status = 'PAID' AND created_at > '2026-01-01'"],
    existingIndexes: [makePrimaryKeyIndex(), makeCompositeIndex()],
    modelFields: makeOrderModelFields(),
  };
  const result: IndexReviewResult = reviewer.review(input);
  assert.equal(result.tableName, "orders");
  assert.equal(result.fullTableScanRisk, false, "WHERE 字段被索引覆盖时不应有全表扫描风险");
  assert.ok(result.whereCoverage.length > 0, "应有 WHERE 覆盖记录");
  // 至少有一个 WHERE 覆盖记录的 covered=true
  const coveredRecords = result.whereCoverage.filter((c) => c.covered);
  assert.ok(coveredRecords.length > 0, "应有被覆盖的 WHERE 字段");
});

// ============================================================================
// S3. IndexReviewer WHERE 字段无索引（TCS-SQL-01 红线）
// ============================================================================

test("S3. IndexReviewer WHERE 字段无索引时 fullTableScanRisk=true（TCS-SQL-01 违规）", () => {
  const reviewer = new IndexReviewer();
  const input: IndexReviewInput = {
    tableName: "orders",
    sqlStatements: ["SELECT * FROM orders WHERE status = 'PAID' AND created_at > '2026-01-01'"],
    // 仅有主键索引，无 (status, created_at) 联合索引
    existingIndexes: [makePrimaryKeyIndex()],
    modelFields: makeOrderModelFields(),
  };
  const result = reviewer.review(input);
  assert.equal(result.fullTableScanRisk, true, "WHERE 字段无索引覆盖时应标记全表扫描风险");
  assert.notEqual(result.verdict, "pass", "存在未覆盖 WHERE 字段时 verdict 不应为 pass");
});

// ============================================================================
// S4. 联合索引最左前缀匹配
// ============================================================================

test("S4. IndexReviewer 联合索引最左前缀匹配——WHERE 仅含首字段也应覆盖", () => {
  const reviewer = new IndexReviewer();
  const input: IndexReviewInput = {
    tableName: "orders",
    // 仅查询 status（联合索引的最左前缀）
    sqlStatements: ["SELECT * FROM orders WHERE status = 'PAID'"],
    existingIndexes: [makePrimaryKeyIndex(), makeCompositeIndex()],
    modelFields: makeOrderModelFields(),
  };
  const result = reviewer.review(input);
  // status 是联合索引的最左前缀，应被覆盖
  assert.equal(result.fullTableScanRisk, false, "WHERE 仅含联合索引最左前缀字段时不应有全表扫描风险");
});

// ============================================================================
// S4b. WHERE 字段含表别名前缀应正确提取 column（M-1 修复验证）
// ============================================================================

test("S4b. IndexReviewer WHERE 含表别名前缀（u.id）应正确提取 column=id（M-1 修复）", () => {
  // M-1 修复：原 extractWhereColumns 正则 ^([a-zA-Z_][a-zA-Z0-9_]*) 对 `u.id = 1`
  // 提取 `u` 而非 `id`，导致索引覆盖检查按 `u` 字段名查找，误判为全表扫描风险。
  // 修复后正则 ^(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?([a-zA-Z_][a-zA-Z0-9_]*) 可剥离表别名前缀，
  // 正确提取 column 部分（id）。
  const reviewer = new IndexReviewer();
  // 构造 SQL：SELECT * FROM users u WHERE u.id = 1
  // 现有索引 idx_users_id (id)，应被覆盖
  const input: IndexReviewInput = {
    tableName: "users",
    sqlStatements: ["SELECT * FROM users u WHERE u.id = 1"],
    existingIndexes: [
      {
        name: "idx_users_id",
        columns: ["id"],
        type: "btree",
        unique: false,
        isPrimaryKey: false,
      },
    ],
    modelFields: [{ name: "id", type: "number", nullable: false, isForeignKey: false }],
  };
  const result = reviewer.review(input);
  // 修复后：WHERE 字段提取为 `id`（剥离 `u.` 别名前缀），应被 idx_users_id 覆盖
  assert.equal(
    result.fullTableScanRisk,
    false,
    `WHERE u.id = 1 应提取 column=id 被索引覆盖，实际 whereColumns=${result.whereCoverage[0]?.whereColumns}`
  );
  // 显式断言 whereColumns 已剥离表别名前缀
  assert.ok(result.whereCoverage.length > 0, "应有 WHERE 覆盖记录");
  assert.ok(
    result.whereCoverage[0]!.whereColumns.includes("id"),
    `WHERE 字段应包含 id（已剥离 u. 别名前缀），实际: ${result.whereCoverage[0]!.whereColumns}`
  );
  assert.ok(
    !result.whereCoverage[0]!.whereColumns.includes("u"),
    `WHERE 字段不应包含别名 u（修复前 bug 表现），实际: ${result.whereCoverage[0]!.whereColumns}`
  );
});

// ============================================================================
// S5. 缺失索引建议
// ============================================================================

test("S5. IndexReviewer 在 fullTableScanRisk=true 时生成 suggestedIndexes", () => {
  const reviewer = new IndexReviewer();
  const input: IndexReviewInput = {
    tableName: "orders",
    sqlStatements: ["SELECT * FROM orders WHERE status = 'PAID' AND created_at > '2026-01-01'"],
    existingIndexes: [makePrimaryKeyIndex()],
    modelFields: makeOrderModelFields(),
  };
  const result = reviewer.review(input);
  assert.equal(result.fullTableScanRisk, true);
  // 应生成建议索引
  assert.ok(result.suggestedIndexes.length > 0, "fullTableScanRisk=true 时应生成 suggestedIndexes 建议");
});

// ============================================================================
// S6. NPlusOneDetector 检测循环内 findUnique（TCS-SQL-02 红线）
// ============================================================================

test("S6. NPlusOneDetector 检测 for 循环内 findUnique——detected=true（TCS-SQL-02 违规）", () => {
  const detector = new NPlusOneDetector();
  const code = [
    "async function listOrders(orders) {",
    "  for (const order of orders) {",
    "    const user = await prisma.user.findUnique({ where: { id: order.userId } });",
    "    console.log(user);",
    "  }",
    "}",
  ].join("\n");
  const result: NPlusOneDetectionResult = detector.detect("src/services/order-list.ts", code);
  assert.equal(result.detected, true, "应检测到 N+1 模式");
  assert.ok(result.patterns.length > 0, "应有 N+1 模式详情");
  assert.equal(result.patterns[0].loopType, "for");
  assert.ok(result.patterns[0].confidence >= MIN_DETECTION_CONFIDENCE, "置信度应 ≥ 阈值");
});

// ============================================================================
// S7. NPlusOneDetector 检测循环内 findOne / find / query
// ============================================================================

test("S7a. NPlusOneDetector 检测 forEach 循环内 findOne", () => {
  const detector = new NPlusOneDetector();
  const code = [
    "async function processOrders(orders) {",
    "  await orders.forEach(async (order) => {",
    "    const user = await User.findOne({ where: { id: order.userId } });",
    "  });",
    "}",
  ].join("\n");
  const result = detector.detect("src/services/process.ts", code);
  assert.equal(result.detected, true, "应检测到 forEach 内 findOne 的 N+1 模式");
});

test("S7b. NPlusOneDetector 检测 while 循环内 query", () => {
  const detector = new NPlusOneDetector();
  const code = [
    "async function batchProcess() {",
    "  let i = 0;",
    "  while (i < items.length) {",
    "    const result = await db.query('SELECT * FROM users WHERE id = ?', [items[i].id]);",
    "    i++;",
    "  }",
    "}",
  ].join("\n");
  const result = detector.detect("src/services/batch.ts", code);
  assert.equal(result.detected, true, "应检测到 while 内 query 的 N+1 模式");
});

// ============================================================================
// S8. 循环外查询不报错（合规）
// ============================================================================

test("S8. NPlusOneDetector 循环外批量查询 detected=false（合规）", () => {
  const detector = new NPlusOneDetector();
  const code = [
    "async function listOrdersWithUser(orders) {",
    "  const userIds = orders.map((o) => o.userId);",
    "  const users = await prisma.user.findMany({ where: { id: { in: userIds } } });",
    "  const userMap = new Map(users.map((u) => [u.id, u]));",
    "  return orders.map((o) => ({ ...o, user: userMap.get(o.userId) }));",
    "}",
  ].join("\n");
  const result = detector.detect("src/services/order-list.ts", code);
  assert.equal(result.detected, false, "循环外批量查询不应被检测为 N+1");
});

test("S8b. NPlusOneDetector 无循环代码 detected=false", () => {
  const detector = new NPlusOneDetector();
  const code = ["async function getUser(id) {", "  return await prisma.user.findUnique({ where: { id } });", "}"].join(
    "\n"
  );
  const result = detector.detect("src/services/user.ts", code);
  assert.equal(result.detected, false, "无循环代码不应被检测为 N+1");
});

// ============================================================================
// S9. PaginationChecker 浅分页合规
// ============================================================================

test("S9a. PaginationChecker 浅分页（offset=100）compliant=true", () => {
  const checker = new PaginationChecker();
  const result: PaginationCheckResult = checker.check("SELECT * FROM orders ORDER BY id LIMIT 20 OFFSET 100");
  assert.equal(result.isDeepPagination, false);
  assert.equal(result.offset, 100);
  assert.equal(result.limit, 20);
  assert.equal(result.compliant, true);
});

test("S9b. PaginationChecker 边界——offset=10000（等于阈值）合规", () => {
  const checker = new PaginationChecker();
  const result = checker.check("SELECT * FROM orders ORDER BY id LIMIT 20 OFFSET 10000");
  assert.equal(result.isDeepPagination, false);
  assert.equal(result.compliant, true, "offset=10000（等于阈值）应合规");
});

test("S9c. PaginationChecker 无 offset 的分页合规", () => {
  const checker = new PaginationChecker();
  const result = checker.check("SELECT * FROM orders ORDER BY id LIMIT 20");
  assert.equal(result.isDeepPagination, false);
  assert.equal(result.compliant, true);
});

// ============================================================================
// S10. PaginationChecker 深分页违规（TCS-SQL-03 红线）
// ============================================================================

test("S10a. PaginationChecker 深分页（offset=10001）isDeepPagination=true（TCS-SQL-03 违规）", () => {
  const checker = new PaginationChecker();
  const result = checker.check("SELECT * FROM orders ORDER BY id LIMIT 20 OFFSET 10001");
  assert.equal(result.isDeepPagination, true);
  assert.equal(result.compliant, false);
  assert.ok(result.fixSuggestion, "应提供修复建议");
  // 修复建议应包含游标分页或 keyset 分页
  assert.ok(
    /游标|cursor|keyset|WHERE.*>/i.test(result.fixSuggestion!),
    `修复建议应包含游标/keyset 分页建议，实际: ${result.fixSuggestion}`
  );
});

test("S10b. PaginationChecker 深分页（offset=100000）isDeepPagination=true", () => {
  const checker = new PaginationChecker();
  const result = checker.check("SELECT * FROM orders ORDER BY id LIMIT 20 OFFSET 100000");
  assert.equal(result.isDeepPagination, true);
  assert.equal(result.offset, 100000);
  assert.equal(result.compliant, false);
});

// ============================================================================
// S11. SqlOptimizer 实现 SqlOptimizationPort 接口
// ============================================================================

test("S11a. SqlOptimizer 提供 reviewIndex / detectNPlusOne / checkPagination 三个方法", () => {
  const optimizer = new SqlOptimizer();
  assert.equal(typeof optimizer.reviewIndex, "function");
  assert.equal(typeof optimizer.detectNPlusOne, "function");
  assert.equal(typeof optimizer.checkPagination, "function");
});

test("S11b. SqlOptimizer reviewIndex 与 IndexReviewer 行为一致", () => {
  const optimizer = new SqlOptimizer();
  const input: IndexReviewInput = {
    tableName: "orders",
    sqlStatements: ["SELECT * FROM orders WHERE status = 'PAID'"],
    existingIndexes: [makePrimaryKeyIndex()],
    modelFields: makeOrderModelFields(),
  };
  const result = optimizer.reviewIndex(input);
  assert.equal(result.tableName, "orders");
  assert.equal(result.fullTableScanRisk, true);
});

test("S11c. SqlOptimizer detectNPlusOne 与 NPlusOneDetector 行为一致", () => {
  const optimizer = new SqlOptimizer();
  const code = [
    "for (const item of items) {",
    "  const result = await prisma.item.findUnique({ where: { id: item.id } });",
    "}",
  ].join("\n");
  const result = optimizer.detectNPlusOne("test.ts", code);
  assert.equal(result.detected, true);
});

test("S11d. SqlOptimizer checkPagination 与 PaginationChecker 行为一致", () => {
  const optimizer = new SqlOptimizer();
  const result = optimizer.checkPagination("SELECT * FROM t LIMIT 10 OFFSET 99999");
  assert.equal(result.isDeepPagination, true);
  assert.equal(result.compliant, false);
});

// ============================================================================
// S12. createSqlOptimizer 工厂函数
// ============================================================================

test("S12. createSqlOptimizer 返回 SqlOptimizer 实例并实现 SqlOptimizationPort", () => {
  const optimizer = createSqlOptimizer();
  assert.ok(optimizer instanceof SqlOptimizer, "createSqlOptimizer 应返回 SqlOptimizer 实例");
  // SqlOptimizationPort 接口方法存在
  assert.equal(typeof optimizer.reviewIndex, "function");
  assert.equal(typeof optimizer.detectNPlusOne, "function");
  assert.equal(typeof optimizer.checkPagination, "function");
});
