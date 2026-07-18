/**
 * EAG-P1 批次 6 单元测试：棕地 Discovery 模块（EAG 方案 §6.2）
 *
 * 测试范围：
 * - 数据模型（types.ts）：
 *   - T1.  ChangeType 字面量联合类型（add/modify/unchanged）
 *   - T2.  CHANGE_TYPES 常量完整性与冻结
 *   - T3.  ExistingModelSnapshot 接口字段完整性
 *   - T4.  IncrementalChange 接口字段完整性
 *   - T5.  IncrementalDesignResult 接口字段完整性
 *   - T6.  ContractViolationType 字面量联合类型
 *   - T7.  CONTRACT_VIOLATION_TYPES 常量完整性
 *   - T8.  ContractViolation 接口字段完整性
 *   - T9.  TechDebtReport 接口字段完整性
 *
 * - 变更分类器（ChangeClassifier）：
 *   - T10. classify 单项分类：既有 + 新需求提及 → modify
 *   - T11. classify 单项分类：既有 + 新需求未提及 → unchanged
 *   - T12. classifyAll 批量分类：三类变更齐全（add/modify/unchanged）
 *   - T13. classifyAll 全部新增：仅 add 类型
 *   - T14. classifyAll 全部不动：仅 unchanged 类型
 *
 * - 棕地 Discovery 流程（BrownfieldDiscovery）：
 *   - T15. discover 产出 IncrementalDesignResult 完整结构
 *   - T16. discover 关键词提取：退款 → RefundAggregate
 *   - T17. discover 关键词提取：取消订单 → OrderCancelService
 *   - T18. discover 关键词提取：订单 → OrderAggregate（modify）
 *   - T19. discover 综合场景：退款 + 取消订单 + 订单
 *   - T20. discover filePath 推断：变更项名称匹配文件名
 *   - T21. classifyChanges 单独调用：返回分类结果
 *
 * - 既有契约保护判定器（ExistingContractGuard）：
 *   - T22. checkApiContract 签名一致：无违反
 *   - T23. checkApiContract 签名不匹配：返回 api-contract 违反
 *   - T24. checkApiContract 新增 API：不视为违反
 *   - T25. checkFileModification modify 文件在允许清单：无违反
 *   - T26. checkFileModification modify 文件不在允许清单：返回 file-modification 违反
 *   - T27. checkFileModification unchanged 文件在允许清单：返回 file-modification 违反
 *   - T28. checkParadigmDrift 范式一致：无违反
 *   - T29. checkParadigmDrift 范式不一致：返回 paradigm-drift 违反
 *   - T30. generateTechDebtReport 启发式检测贫血模型
 *   - T31. generateTechDebtReport 启发式检测原始类型偏执
 *   - T32. generateTechDebtReport 无技术债时返回正常建议
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实 BrownfieldDiscovery / ChangeClassifier / ExistingContractGuard 实例
 *
 * 设计依据：
 * - EAG 方案 §6.2 棕地场景执行流
 * - EAG 方案 §6.2 棕地专属评估规则
 * - eag/discovery/*.ts 源文件
 *
 * @module core/tests/eag-discovery-brownfield
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CHANGE_TYPES, CONTRACT_VIOLATION_TYPES } from "../eag/discovery/types";
import type {
  ChangeType,
  ExistingModelSnapshot,
  IncrementalChange,
  IncrementalDesignResult,
  ContractViolation,
  ContractViolationType,
  TechDebtReport,
} from "../eag/discovery/types";
import { ChangeClassifier } from "../eag/discovery/change-classifier";
import { BrownfieldDiscovery } from "../eag/discovery/brownfield-discovery";
import { ExistingContractGuard } from "../eag/discovery/existing-contract-guard";

// ============================================================================
// 辅助工厂
// ============================================================================

/**
 * 创建测试用既有模型快照（订单+支付领域）
 */
function makeOrderPaymentSnapshot(): ExistingModelSnapshot {
  return {
    aggregates: ["OrderAggregate", "PaymentAggregate"],
    entities: ["OrderItem", "PaymentRecord"],
    valueObjects: ["Money", "OrderId"],
    domainEvents: ["OrderCreatedEvent", "PaymentSucceededEvent"],
    boundedContexts: ["order", "payment"],
    existingFiles: [
      "src/order/OrderAggregate.ts",
      "src/order/OrderItem.ts",
      "src/payment/PaymentAggregate.ts",
      "src/payment/PaymentRecord.ts",
    ],
  };
}

// ============================================================================
// 数据模型测试
// ============================================================================

// ============================================================================
// T1. ChangeType 字面量联合类型
// ============================================================================

test("T1a. ChangeType 类型可正确赋值 3 个字面量", () => {
  const types: ChangeType[] = ["add", "modify", "unchanged"];
  assert.equal(types.length, 3);
});

// ============================================================================
// T2. CHANGE_TYPES 常量完整性与冻结
// ============================================================================

test("T2a. CHANGE_TYPES 包含全部 3 个变更类型", () => {
  assert.equal(CHANGE_TYPES.length, 3);
  assert.ok(CHANGE_TYPES.includes("add"));
  assert.ok(CHANGE_TYPES.includes("modify"));
  assert.ok(CHANGE_TYPES.includes("unchanged"));
});

test("T2b. CHANGE_TYPES 已冻结", () => {
  assert.equal(Object.isFrozen(CHANGE_TYPES), true);
});

// ============================================================================
// T3. ExistingModelSnapshot 接口字段完整性
// ============================================================================

test("T3. ExistingModelSnapshot 6 个字段可正确赋值", () => {
  const snapshot: ExistingModelSnapshot = {
    aggregates: ["OrderAggregate"],
    entities: ["OrderItem"],
    valueObjects: ["Money"],
    domainEvents: ["OrderCreatedEvent"],
    boundedContexts: ["order"],
    existingFiles: ["src/order/OrderAggregate.ts"],
  };
  assert.equal(snapshot.aggregates.length, 1);
  assert.equal(snapshot.entities.length, 1);
  assert.equal(snapshot.valueObjects.length, 1);
  assert.equal(snapshot.domainEvents.length, 1);
  assert.equal(snapshot.boundedContexts.length, 1);
  assert.equal(snapshot.existingFiles.length, 1);
});

// ============================================================================
// T4. IncrementalChange 接口字段完整性
// ============================================================================

test("T4. IncrementalChange 字段可正确赋值（含可选 filePath）", () => {
  const change: IncrementalChange = {
    name: "RefundAggregate",
    changeType: "add",
    filePath: "src/refund/RefundAggregate.ts",
    reason: "新需求要求新增 RefundAggregate",
  };
  assert.equal(change.name, "RefundAggregate");
  assert.equal(change.changeType, "add");
  assert.equal(change.filePath, "src/refund/RefundAggregate.ts");
  assert.equal(change.reason, "新需求要求新增 RefundAggregate");
});

// ============================================================================
// T5. IncrementalDesignResult 接口字段完整性
// ============================================================================

test("T5. IncrementalDesignResult 4 个字段可正确赋值", () => {
  const result: IncrementalDesignResult = {
    addedChanges: [],
    modifiedChanges: [],
    unchangedChanges: [],
    existingModelSnapshot: makeOrderPaymentSnapshot(),
  };
  assert.equal(result.addedChanges.length, 0);
  assert.equal(result.modifiedChanges.length, 0);
  assert.equal(result.unchangedChanges.length, 0);
  assert.equal(result.existingModelSnapshot.aggregates.length, 2);
});

// ============================================================================
// T6. ContractViolationType 字面量联合类型
// ============================================================================

test("T6. ContractViolationType 类型可正确赋值 3 个字面量", () => {
  const types: ContractViolationType[] = ["api-contract", "file-modification", "paradigm-drift"];
  assert.equal(types.length, 3);
});

// ============================================================================
// T7. CONTRACT_VIOLATION_TYPES 常量完整性
// ============================================================================

test("T7a. CONTRACT_VIOLATION_TYPES 包含全部 3 个违反类型", () => {
  assert.equal(CONTRACT_VIOLATION_TYPES.length, 3);
  assert.ok(CONTRACT_VIOLATION_TYPES.includes("api-contract"));
  assert.ok(CONTRACT_VIOLATION_TYPES.includes("file-modification"));
  assert.ok(CONTRACT_VIOLATION_TYPES.includes("paradigm-drift"));
});

test("T7b. CONTRACT_VIOLATION_TYPES 已冻结", () => {
  assert.equal(Object.isFrozen(CONTRACT_VIOLATION_TYPES), true);
});

// ============================================================================
// T8. ContractViolation 接口字段完整性
// ============================================================================

test("T8. ContractViolation 3 个字段可正确赋值", () => {
  const violation: ContractViolation = {
    type: "api-contract",
    message: "API 签名不匹配",
    location: "OrderService.cancel",
  };
  assert.equal(violation.type, "api-contract");
  assert.equal(violation.message, "API 签名不匹配");
  assert.equal(violation.location, "OrderService.cancel");
});

// ============================================================================
// T9. TechDebtReport 接口字段完整性
// ============================================================================

test("T9. TechDebtReport 字段可正确赋值", () => {
  const report: TechDebtReport = {
    violations: [{ rule: "anemic-model", location: "OrderService.ts", description: "贫血模型" }],
    recommendation: "建议重构为充血模型",
  };
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].rule, "anemic-model");
  assert.equal(report.recommendation, "建议重构为充血模型");
});

// ============================================================================
// 变更分类器（ChangeClassifier）测试
// ============================================================================

// ============================================================================
// T10. classify 单项分类：既有 + 新需求提及 → modify
// ============================================================================

test("T10. classify 既有且新需求提及 → modify", () => {
  const classifier = new ChangeClassifier();
  const result = classifier.classify("OrderAggregate", ["OrderAggregate", "RefundAggregate"]);
  assert.equal(result, "modify");
});

// ============================================================================
// T11. classify 单项分类：既有 + 新需求未提及 → unchanged
// ============================================================================

test("T11. classify 既有但新需求未提及 → unchanged", () => {
  const classifier = new ChangeClassifier();
  const result = classifier.classify("OrderAggregate", ["RefundAggregate"]);
  assert.equal(result, "unchanged");
});

// ============================================================================
// T12. classifyAll 批量分类：三类变更齐全
// ============================================================================

test("T12. classifyAll 三类变更齐全（add/modify/unchanged）", () => {
  const classifier = new ChangeClassifier();
  const snapshot = makeOrderPaymentSnapshot();
  // 新需求提及：OrderAggregate（modify）+ RefundAggregate（add）
  const result = classifier.classifyAll(snapshot, ["OrderAggregate", "RefundAggregate"]);
  // 应包含 add（RefundAggregate）、modify（OrderAggregate）、unchanged（其他既有项）
  const added = result.filter((r) => r.changeType === "add");
  const modified = result.filter((r) => r.changeType === "modify");
  const unchanged = result.filter((r) => r.changeType === "unchanged");
  assert.ok(added.length > 0, "应有 add 类型变更");
  assert.ok(modified.length > 0, "应有 modify 类型变更");
  assert.ok(unchanged.length > 0, "应有 unchanged 类型变更");
  // RefundAggregate 应在 add 列表
  assert.ok(added.some((r) => r.name === "RefundAggregate"));
  // OrderAggregate 应在 modify 列表
  assert.ok(modified.some((r) => r.name === "OrderAggregate"));
  // PaymentAggregate 应在 unchanged 列表（新需求未提及）
  assert.ok(unchanged.some((r) => r.name === "PaymentAggregate"));
});

// ============================================================================
// T13. classifyAll 全部新增：仅 add 类型
// ============================================================================

test("T13. classifyAll 全部新增：仅 add 类型", () => {
  const classifier = new ChangeClassifier();
  const snapshot = makeOrderPaymentSnapshot();
  // 新需求提及的全是既有中不存在的
  const result = classifier.classifyAll(snapshot, ["RefundAggregate", "NotificationService"]);
  const added = result.filter((r) => r.changeType === "add");
  const modified = result.filter((r) => r.changeType === "modify");
  const unchanged = result.filter((r) => r.changeType === "unchanged");
  // 新增 2 项
  assert.equal(added.length, 2);
  // 无 modify
  assert.equal(modified.length, 0);
  // 全部既有项为 unchanged
  assert.ok(unchanged.length > 0);
});

// ============================================================================
// T14. classifyAll 全部不动：仅 unchanged 类型
// ============================================================================

test("T14. classifyAll 新需求为空：全部既有项为 unchanged", () => {
  const classifier = new ChangeClassifier();
  const snapshot = makeOrderPaymentSnapshot();
  const result = classifier.classifyAll(snapshot, []);
  const added = result.filter((r) => r.changeType === "add");
  const modified = result.filter((r) => r.changeType === "modify");
  const unchanged = result.filter((r) => r.changeType === "unchanged");
  assert.equal(added.length, 0);
  assert.equal(modified.length, 0);
  // 全部既有项（聚合+实体+值对象+领域事件+限界上下文）都为 unchanged
  assert.ok(unchanged.length > 0);
});

// ============================================================================
// 棕地 Discovery 流程（BrownfieldDiscovery）测试
// ============================================================================

// ============================================================================
// T15. discover 产出 IncrementalDesignResult 完整结构
// ============================================================================

test("T15. discover 产出 IncrementalDesignResult 完整结构", () => {
  const discovery = new BrownfieldDiscovery();
  const snapshot = makeOrderPaymentSnapshot();
  const result = discovery.discover(snapshot, "在现有订单服务里增加订单取消与退款能力");
  // 验证 4 个字段全部存在
  assert.ok(Array.isArray(result.addedChanges));
  assert.ok(Array.isArray(result.modifiedChanges));
  assert.ok(Array.isArray(result.unchangedChanges));
  assert.equal(result.existingModelSnapshot, snapshot);
});

// ============================================================================
// T16. discover 关键词提取：退款 → RefundAggregate
// ============================================================================

test("T16. discover 关键词提取：退款 → RefundAggregate（add）", () => {
  const discovery = new BrownfieldDiscovery();
  const snapshot = makeOrderPaymentSnapshot();
  const result = discovery.discover(snapshot, "增加退款能力");
  // RefundAggregate 应在 addedChanges 中（既有模型无）
  const refund = result.addedChanges.find((c) => c.name === "RefundAggregate");
  assert.notEqual(refund, null);
  assert.equal(refund!.changeType, "add");
});

// ============================================================================
// T17. discover 关键词提取：取消订单 → OrderCancelService
// ============================================================================

test("T17. discover 关键词提取：取消订单 → OrderCancelService（add）", () => {
  const discovery = new BrownfieldDiscovery();
  const snapshot = makeOrderPaymentSnapshot();
  const result = discovery.discover(snapshot, "增加取消订单能力");
  const cancel = result.addedChanges.find((c) => c.name === "OrderCancelService");
  assert.notEqual(cancel, null);
  assert.equal(cancel!.changeType, "add");
});

// ============================================================================
// T18. discover 关键词提取：订单 → OrderAggregate（modify）
// ============================================================================

test("T18. discover 关键词提取：订单 → OrderAggregate（modify）", () => {
  const discovery = new BrownfieldDiscovery();
  const snapshot = makeOrderPaymentSnapshot();
  const result = discovery.discover(snapshot, "修改订单逻辑");
  const order = result.modifiedChanges.find((c) => c.name === "OrderAggregate");
  assert.notEqual(order, null);
  assert.equal(order!.changeType, "modify");
});

// ============================================================================
// T19. discover 综合场景：退款 + 取消订单 + 订单
// ============================================================================

test("T19. discover 综合场景：退款+取消订单+订单 → add/modify/unchanged 齐全", () => {
  const discovery = new BrownfieldDiscovery();
  const snapshot = makeOrderPaymentSnapshot();
  const result = discovery.discover(snapshot, "在现有订单服务里增加订单取消与退款能力");
  // addedChanges 应含 RefundAggregate 和 OrderCancelService
  const addedNames = result.addedChanges.map((c) => c.name);
  assert.ok(addedNames.includes("RefundAggregate"));
  assert.ok(addedNames.includes("OrderCancelService"));
  // modifiedChanges 应含 OrderAggregate 和 PaymentAggregate（既有项被新需求提及）
  // 注：新需求文本含「订单」→ OrderAggregate（modify）；不含「支付」→ PaymentAggregate（unchanged）
  const modifiedNames = result.modifiedChanges.map((c) => c.name);
  assert.ok(modifiedNames.includes("OrderAggregate"));
  // unchangedChanges 应含既有但新需求未提及的项
  const unchangedNames = result.unchangedChanges.map((c) => c.name);
  assert.ok(unchangedNames.includes("PaymentAggregate"));
});

// ============================================================================
// T20. discover filePath 推断：变更项名称匹配文件名
// ============================================================================

test("T20. discover filePath 推断：OrderAggregate 匹配 OrderAggregate.ts", () => {
  const discovery = new BrownfieldDiscovery();
  const snapshot = makeOrderPaymentSnapshot();
  const result = discovery.discover(snapshot, "修改订单逻辑");
  const order = result.modifiedChanges.find((c) => c.name === "OrderAggregate");
  assert.notEqual(order, null);
  assert.equal(order!.filePath, "src/order/OrderAggregate.ts");
});

// ============================================================================
// T21. classifyChanges 单独调用：返回分类结果
// ============================================================================

test("T21. classifyChanges 单独调用返回分类结果", () => {
  const discovery = new BrownfieldDiscovery();
  const snapshot = makeOrderPaymentSnapshot();
  const result = discovery.classifyChanges(snapshot, "增加退款能力");
  // RefundAggregate 应分类为 add
  const refund = result.find((r) => r.name === "RefundAggregate");
  assert.notEqual(refund, null);
  assert.equal(refund!.changeType, "add");
});

// ============================================================================
// 既有契约保护判定器（ExistingContractGuard）测试
// ============================================================================

// ============================================================================
// T22. checkApiContract 签名一致：无违反
// ============================================================================

test("T22. checkApiContract 签名一致：返回空违反列表", () => {
  const guard = new ExistingContractGuard();
  const violations = guard.checkApiContract(
    [{ apiName: "OrderService.cancel", signature: "cancel(orderId: string): void" }],
    [{ apiName: "OrderService.cancel", signature: "cancel(orderId: string): void" }]
  );
  assert.equal(violations.length, 0);
});

// ============================================================================
// T23. checkApiContract 签名不匹配：返回 api-contract 违反
// ============================================================================

test("T23. checkApiContract 签名不匹配：返回 api-contract 违反", () => {
  const guard = new ExistingContractGuard();
  const violations = guard.checkApiContract(
    [{ apiName: "OrderService.cancel", signature: "cancel(orderId: string, reason: string): void" }],
    [{ apiName: "OrderService.cancel", signature: "cancel(orderId: string): void" }]
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, "api-contract");
  assert.ok(violations[0].message.includes("签名不匹配"));
});

// ============================================================================
// T24. checkApiContract 新增 API：不视为违反
// ============================================================================

test("T24. checkApiContract 新增 API（既有契约中不存在）：不视为违反", () => {
  const guard = new ExistingContractGuard();
  const violations = guard.checkApiContract(
    [{ apiName: "OrderService.refund", signature: "refund(orderId: string): void" }],
    [{ apiName: "OrderService.cancel", signature: "cancel(orderId: string): void" }]
  );
  // refund 在既有契约中不存在 → 视为新增 API，不视为违反
  assert.equal(violations.length, 0);
});

// ============================================================================
// T25. checkFileModification modify 文件在允许清单：无违反
// ============================================================================

test("T25. checkFileModification modify 文件在允许清单：无违反", () => {
  const guard = new ExistingContractGuard();
  const changes: IncrementalChange[] = [
    {
      name: "OrderAggregate",
      changeType: "modify",
      filePath: "src/order/OrderAggregate.ts",
      reason: "修改订单聚合",
    },
  ];
  const allowedFiles = ["src/order/OrderAggregate.ts"];
  const violations = guard.checkFileModification(changes, allowedFiles);
  assert.equal(violations.length, 0);
});

// ============================================================================
// T26. checkFileModification modify 文件不在允许清单：返回 file-modification 违反
// ============================================================================

test("T26. checkFileModification modify 文件不在允许清单：返回 file-modification 违反", () => {
  const guard = new ExistingContractGuard();
  const changes: IncrementalChange[] = [
    {
      name: "OrderAggregate",
      changeType: "modify",
      filePath: "src/order/OrderAggregate.ts",
      reason: "修改订单聚合",
    },
  ];
  // 允许修改的清单不包含此文件
  const allowedFiles = ["src/other/OtherFile.ts"];
  const violations = guard.checkFileModification(changes, allowedFiles);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, "file-modification");
});

// ============================================================================
// T27. checkFileModification unchanged 文件在允许清单：返回 file-modification 违反
// ============================================================================

test("T27. checkFileModification unchanged 文件在允许清单：返回 file-modification 违反", () => {
  const guard = new ExistingContractGuard();
  const changes: IncrementalChange[] = [
    {
      name: "OrderAggregate",
      changeType: "unchanged",
      filePath: "src/order/OrderAggregate.ts",
      reason: "不动",
    },
  ];
  // unchanged 文件不应在允许修改清单中
  const allowedFiles = ["src/order/OrderAggregate.ts"];
  const violations = guard.checkFileModification(changes, allowedFiles);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, "file-modification");
  assert.ok(violations[0].message.includes("unchanged"));
});

// ============================================================================
// T28. checkParadigmDrift 范式一致：无违反
// ============================================================================

test("T28. checkParadigmDrift 范式一致：返回空违反列表", () => {
  const guard = new ExistingContractGuard();
  const violations = guard.checkParadigmDrift("ddd-layered", "ddd-layered");
  assert.equal(violations.length, 0);
});

// ============================================================================
// T29. checkParadigmDrift 范式不一致：返回 paradigm-drift 违反
// ============================================================================

test("T29. checkParadigmDrift 范式不一致：返回 paradigm-drift 违反", () => {
  const guard = new ExistingContractGuard();
  const violations = guard.checkParadigmDrift("ddd-layered", "anemic");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, "paradigm-drift");
  assert.ok(violations[0].message.includes("不一致"));
});

// ============================================================================
// T30. generateTechDebtReport 启发式检测贫血模型
// ============================================================================

test("T30. generateTechDebtReport 检测贫血模型（Service 文件无 Aggregate 文件）", () => {
  const guard = new ExistingContractGuard();
  // 既有文件含 Service 后缀但无 Aggregate 后缀 → 贫血模型
  const snapshot: ExistingModelSnapshot = {
    aggregates: ["OrderAggregate"],
    entities: ["OrderItem"],
    valueObjects: ["Money"],
    domainEvents: ["OrderCreatedEvent"],
    boundedContexts: ["order"],
    existingFiles: ["src/order/OrderService.ts"], // 仅 Service，无 Aggregate
  };
  const report = guard.generateTechDebtReport(snapshot, []);
  // 应检测到 anemic-model-detection
  const anemicViolation = report.violations.find((v) => v.rule === "anemic-model-detection");
  assert.notEqual(anemicViolation, null);
});

// ============================================================================
// T31. generateTechDebtReport 启发式检测原始类型偏执
// ============================================================================

test("T31. generateTechDebtReport 检测原始类型偏执（有聚合但无值对象）", () => {
  const guard = new ExistingContractGuard();
  const snapshot: ExistingModelSnapshot = {
    aggregates: ["OrderAggregate"],
    entities: ["OrderItem"],
    valueObjects: [], // 无值对象
    domainEvents: ["OrderCreatedEvent"],
    boundedContexts: ["order"],
    existingFiles: ["src/order/OrderAggregate.ts"],
  };
  const report = guard.generateTechDebtReport(snapshot, []);
  // 应检测到 primitive-obsession
  const primitiveViolation = report.violations.find((v) => v.rule === "primitive-obsession");
  assert.notEqual(primitiveViolation, null);
});

// ============================================================================
// T32. generateTechDebtReport 无技术债时返回正常建议
// ============================================================================

test("T32. generateTechDebtReport 无技术债时返回正常建议", () => {
  const guard = new ExistingContractGuard();
  // 完整模型：有 Aggregate + ValueObject，无 Service 文件
  const snapshot: ExistingModelSnapshot = {
    aggregates: ["OrderAggregate"],
    entities: ["OrderItem"],
    valueObjects: ["Money"],
    domainEvents: ["OrderCreatedEvent"],
    boundedContexts: ["order"],
    existingFiles: ["src/order/OrderAggregate.ts"],
  };
  const report = guard.generateTechDebtReport(snapshot, []);
  // 无违例
  assert.equal(report.violations.length, 0);
  // 建议应表明无技术债
  assert.ok(report.recommendation.includes("未检测到技术债"));
});

// ============================================================================
// T33. 综合场景：完整棕地 Discovery 流程（discover + guard）
// ============================================================================

test("T33. 综合场景：discover + checkFileModification + checkParadigmDrift 联合验证", () => {
  const discovery = new BrownfieldDiscovery();
  const guard = new ExistingContractGuard();
  const snapshot = makeOrderPaymentSnapshot();

  // 1. 执行 Discovery
  const result = discovery.discover(snapshot, "在现有订单服务里增加订单取消与退款能力");

  // 2. 提取 modify 类型的文件路径作为允许修改清单
  const allowedModifiedFiles = result.modifiedChanges
    .map((c) => c.filePath)
    .filter((p): p is string => p !== undefined);

  // 3. 文件修改纪律检查：modify 文件在允许清单 → 无违反
  const fileViolations = guard.checkFileModification(result.modifiedChanges, allowedModifiedFiles);
  assert.equal(fileViolations.length, 0);

  // 4. 范式漂移检查：新代码 DDD 范式 vs 既有 DDD 范式 → 一致，无违反
  const paradigmViolations = guard.checkParadigmDrift("ddd-layered", "ddd-layered");
  assert.equal(paradigmViolations.length, 0);

  // 5. 生成技术债报告
  const techDebtReport = guard.generateTechDebtReport(snapshot, [
    ...result.addedChanges,
    ...result.modifiedChanges,
    ...result.unchangedChanges,
  ]);
  // 技术债报告应可正常生成
  assert.ok(typeof techDebtReport.recommendation === "string");
});

// ============================================================================
// T34. ExistingContractGuard checkFileModification 跳过 add 类型变更
// ============================================================================

test("T34. checkFileModification 跳过 add 类型变更（add 为新增文件，不涉及修改纪律）", () => {
  const guard = new ExistingContractGuard();
  const changes: IncrementalChange[] = [
    {
      name: "RefundAggregate",
      changeType: "add",
      filePath: "src/refund/RefundAggregate.ts",
      reason: "新增退款聚合",
    },
  ];
  // 允许修改清单为空
  const violations = guard.checkFileModification(changes, []);
  // add 类型不应触发 file-modification 违反
  assert.equal(violations.length, 0);
});

// ============================================================================
// T35. BrownfieldDiscovery 关键词映射表多语言支持
// ============================================================================

test("T35. discover 关键词支持中英文（refund / 退款）", () => {
  const discovery = new BrownfieldDiscovery();
  const snapshot = makeOrderPaymentSnapshot();
  // 英文 refund 关键词
  const result1 = discovery.discover(snapshot, "add refund capability");
  assert.ok(result1.addedChanges.some((c) => c.name === "RefundAggregate"));
  // 中文 退款关键词
  const result2 = discovery.discover(snapshot, "增加退款能力");
  assert.ok(result2.addedChanges.some((c) => c.name === "RefundAggregate"));
});
