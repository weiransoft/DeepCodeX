/**
 * EAG-P2 批次 8 单元测试：L3 业务流程还原器（BusinessFlowDiscoverer）
 *
 * 测试范围：
 * - T1. 实例化（含 projectRoot 校验）
 * - T2. discover 入参校验
 * - T3. 入口点查找（ClassName.method 格式 / 不存在入口）
 * - T4. 单一 HTTP 入口点发现
 * - T5. BFS 调用链发现（controller → service）
 * - T6. MQ 生产者识别（producer.send 通道提取）
 * - T7. MQ 消费者识别（@RabbitSubscribe 装饰器）
 * - T8. Mermaid 流程图渲染（flowchart TD 格式）
 * - T9. 状态机识别（status 字段 + 状态值字面量）
 * - T10. Mermaid 状态图渲染（stateDiagram-v2 格式）
 * - T11. 不可变性（FlowResult 冻结）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实文件系统（fs.mkdtemp 创建临时目录）
 * - 测试用例独立、可重复，每个用例自己创建与清理临时目录
 * - 中文详细注释，符合项目代码规范
 *
 * @module core/tests/eag-pkc-l3-business-flow
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { BusinessFlowDiscoverer, BusinessFlowDiscovererError } from "../eag/pkc/l3/business-flow-discoverer";

// ============================================================================
// 辅助函数：创建临时项目目录与文件
// ============================================================================

/**
 * 创建临时项目目录（基于 os.tmpdir + 随机数，保证唯一性）
 *
 * @returns 临时项目根目录绝对路径
 */
async function createTempProject(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "eag-pkc-flow-"));
  return tmpDir;
}

/**
 * 递归删除目录（测试结束后清理）
 *
 * @param dirPath 待删除目录
 */
async function removeTempDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // 忽略删除失败
  }
}

/**
 * 在指定项目根目录下写入文件（自动创建父目录）
 *
 * @param projectRoot 项目根目录
 * @param relativePath 文件相对路径（如 "src/controllers/OrderController.ts"）
 * @param content 文件内容
 */
async function writeProjectFile(projectRoot: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(projectRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf-8");
}

/**
 * 构建完整的业务流程测试项目（含 controller/service/consumer/entity）
 *
 * 项目结构：
 * - src/controllers/OrderController.ts：HTTP 入口 + 调用 service + 发送 MQ
 * - src/services/OrderService.ts：业务方法（含 send 调用）
 * - src/consumers/OrderConsumer.ts：MQ 消费者（@RabbitSubscribe 装饰器）
 * - src/entities/Order.ts：含 status 字段 + 状态值字面量
 *
 * @param projectRoot 项目根目录
 */
async function buildFullFlowProject(projectRoot: string): Promise<void> {
  // OrderController.ts：HTTP 处理器，调用 service + 发送 MQ
  await writeProjectFile(
    projectRoot,
    "src/controllers/OrderController.ts",
    [
      "/** 订单控制器 */",
      "export class OrderController {",
      "  /** 创建订单 */",
      "  async create(req: any): Promise<void> {",
      "    // 调用订单服务处理订单创建",
      "    await orderService.processOrderCreation(req.body);",
      "    // 发送订单创建消息到 MQ",
      '    producer.send("order.created", { id: 1 });',
      "  }",
      "}",
      "",
    ].join("\n")
  );

  // OrderService.ts：业务服务方法
  await writeProjectFile(
    projectRoot,
    "src/services/OrderService.ts",
    [
      "/** 订单服务 */",
      "export class OrderService {",
      "  /** 处理订单创建 */",
      "  async processOrderCreation(data: any): Promise<void> {",
      "    // 业务逻辑：保存订单到数据库",
      "    await repository.save(data);",
      "  }",
      "}",
      "",
    ].join("\n")
  );

  // OrderConsumer.ts：MQ 消费者（@RabbitSubscribe 装饰器）
  await writeProjectFile(
    projectRoot,
    "src/consumers/OrderConsumer.ts",
    [
      'import { RabbitSubscribe } from "../decorator";',
      "",
      "/** 订单消费者 */",
      "export class OrderConsumer {",
      "  /** 处理订单创建消息 */",
      '  @RabbitSubscribe("order.created")',
      "  async handleOrderCreated(payload: any): Promise<void> {",
      "    // 处理订单创建消息",
      '    console.log("处理订单创建", payload);',
      "  }",
      "}",
      "",
    ].join("\n")
  );

  // Order.ts：实体类，含 status 字段 + 状态值字面量
  await writeProjectFile(
    projectRoot,
    "src/entities/Order.ts",
    [
      "/** 订单实体 */",
      "export class Order {",
      "  public id: number;",
      "  public status: string;",
      "",
      "  constructor(id: number) {",
      "    this.id = id;",
      '    this.status = "pending";',
      "  }",
      "",
      "  /** 支付订单 */",
      "  pay(): void {",
      '    if (this.status === "pending") {',
      '      this.status = "paid";',
      "    }",
      "  }",
      "",
      "  /** 发货 */",
      "  ship(): void {",
      '    if (this.status === "paid") {',
      '      this.status = "shipped";',
      "    }",
      "  }",
      "",
      "  /** 完成 */",
      "  complete(): void {",
      '    if (this.status === "shipped") {',
      '      this.status = "completed";',
      "    }",
      "  }",
      "",
      "  /** 取消 */",
      "  cancel(): void {",
      '    if (this.status === "pending" || this.status === "paid") {',
      '      this.status = "cancelled";',
      "    }",
      "  }",
      "}",
      "",
    ].join("\n")
  );
}

// ============================================================================
// T1. BusinessFlowDiscoverer 实例化
// ============================================================================

test("T1a. BusinessFlowDiscoverer 可实例化（合法 projectRoot）", async () => {
  const tmpDir = await createTempProject();
  try {
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    assert.ok(discoverer instanceof BusinessFlowDiscoverer);
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T1b. BusinessFlowDiscoverer 空 projectRoot 抛 BusinessFlowDiscovererError", () => {
  assert.throws(
    () => new BusinessFlowDiscoverer(""),
    (err: unknown) => {
      assert.ok(err instanceof BusinessFlowDiscovererError);
      assert.equal(err.kind, "invalid-entry");
      return true;
    }
  );
});

test("T1c. BusinessFlowDiscoverer 空白 projectRoot 抛 BusinessFlowDiscovererError", () => {
  assert.throws(
    () => new BusinessFlowDiscoverer("   "),
    (err: unknown) => {
      assert.ok(err instanceof BusinessFlowDiscovererError);
      assert.equal(err.kind, "invalid-entry");
      return true;
    }
  );
});

test("T1d. BusinessFlowDiscoverer 自定义 maxDepth 可实例化", async () => {
  const tmpDir = await createTempProject();
  try {
    const discoverer = new BusinessFlowDiscoverer(tmpDir, 3);
    assert.ok(discoverer instanceof BusinessFlowDiscoverer);
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T2. discover 入参校验
// ============================================================================

test("T2a. discover 空入口点抛 BusinessFlowDiscovererError", async () => {
  const tmpDir = await createTempProject();
  try {
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    await assert.rejects(discoverer.discover(""), (err: unknown) => {
      assert.ok(err instanceof BusinessFlowDiscovererError);
      assert.equal(err.kind, "invalid-entry");
      return true;
    });
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T2b. discover 空白入口点抛 BusinessFlowDiscovererError", async () => {
  const tmpDir = await createTempProject();
  try {
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    await assert.rejects(discoverer.discover("   "), (err: unknown) => {
      assert.ok(err instanceof BusinessFlowDiscovererError);
      assert.equal(err.kind, "invalid-entry");
      return true;
    });
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T3. 入口点查找
// ============================================================================

test("T3a. discover 不存在的入口点抛 entry-not-found", async () => {
  const tmpDir = await createTempProject();
  try {
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    await assert.rejects(discoverer.discover("NotExist.method"), (err: unknown) => {
      assert.ok(err instanceof BusinessFlowDiscovererError);
      assert.equal(err.kind, "entry-not-found");
      return true;
    });
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T3b. discover ClassName.method 格式入口点可被发现", async () => {
  const tmpDir = await createTempProject();
  try {
    await writeProjectFile(
      tmpDir,
      "src/controllers/OrderController.ts",
      [
        "export class OrderController {",
        "  async create(req: any): Promise<void> {",
        '    console.log("create");',
        "  }",
        "}",
        "",
      ].join("\n")
    );
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    assert.ok(flow);
    assert.equal(flow.entryPoint, "OrderController.create");
    assert.ok(flow.steps.length > 0);
    assert.equal(flow.steps[0].symbolName, "OrderController.create");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T4. 单一 HTTP 入口点发现
// ============================================================================

test("T4a. discover 返回 FlowResult 对象", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    assert.ok(flow, "应返回 FlowResult 对象");
    assert.equal(flow.entryPoint, "OrderController.create");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T4b. 入口步骤 symbolName = OrderController.create", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    assert.ok(flow.steps.length > 0, "应至少有一个步骤");
    assert.equal(flow.steps[0].symbolName, "OrderController.create");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T4c. 入口步骤 filePath 指向 OrderController.ts", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    assert.ok(flow.steps[0].filePath.includes("OrderController.ts"));
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T4d. 入口步骤 startLine > 0", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    assert.ok(flow.steps[0].startLine > 0, "入口步骤起始行号应大于 0");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T5. BFS 调用链发现（controller → service）
// ============================================================================

test("T5a. BFS 发现 processOrderCreation 服务方法步骤", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    const serviceStep = flow.steps.find((s) => s.symbolName === "processOrderCreation");
    assert.ok(serviceStep, "应发现 processOrderCreation 服务方法步骤");
    assert.equal(serviceStep!.type, "service-method");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T5b. BFS 生成 controller → service 调用分支", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    const entryStep = flow.steps.find((s) => s.symbolName === "OrderController.create");
    const serviceStep = flow.steps.find((s) => s.symbolName === "processOrderCreation");
    assert.ok(entryStep && serviceStep, "应同时存在入口和服务步骤");
    const branch = flow.branches.find((b) => b.fromStepId === entryStep!.stepId && b.toStepId === serviceStep!.stepId);
    assert.ok(branch, "应存在入口到服务方法的调用分支");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T5c. 调用分支 label = call", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    const entryStep = flow.steps.find((s) => s.symbolName === "OrderController.create");
    const serviceStep = flow.steps.find((s) => s.symbolName === "processOrderCreation");
    const branch = flow.branches.find((b) => b.fromStepId === entryStep!.stepId && b.toStepId === serviceStep!.stepId);
    assert.ok(branch);
    assert.equal(branch!.label, "call");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T6. MQ 生产者识别
// ============================================================================

test("T6a. discover 识别 MQ 生产通道 order.created", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    // 应存在 order.created 通道的异步边界
    const orderBoundary = flow.asyncBoundaries.find((b) => b.channel === "order.created");
    assert.ok(orderBoundary, "应识别 order.created MQ 通道");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T6b. 异步边界 channelType = mq", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    const orderBoundary = flow.asyncBoundaries.find((b) => b.channel === "order.created");
    assert.ok(orderBoundary);
    assert.equal(orderBoundary!.channelType, "mq");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T7. MQ 消费者识别
// ============================================================================

test("T7a. discover 发现 order.created.consume 消费者步骤", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    const consumerStep = flow.steps.find((s) => s.symbolName === "order.created.consume");
    assert.ok(consumerStep, "应发现 order.created.consume 消费者步骤");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T7b. 消费者步骤 type = mq-consumer", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    const consumerStep = flow.steps.find((s) => s.symbolName === "order.created.consume");
    assert.ok(consumerStep);
    assert.equal(consumerStep!.type, "mq-consumer");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T7c. 消费者步骤 filePath 指向 OrderConsumer.ts", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    const consumerStep = flow.steps.find((s) => s.symbolName === "order.created.consume");
    assert.ok(consumerStep);
    assert.ok(consumerStep!.filePath.includes("OrderConsumer.ts"));
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T8. Mermaid 流程图渲染
// ============================================================================

test("T8a. mermaidFlow 包含 flowchart TD 声明", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    assert.ok(flow.mermaidFlow.includes("flowchart TD"), "应包含 flowchart TD 声明");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T8b. mermaidFlow 包含步骤节点（S1/S2 等）", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    assert.ok(flow.mermaidFlow.includes("S1["), "应包含步骤节点 S1");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T8c. mermaidFlow 包含 async 边（async: order.created）", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    assert.ok(flow.mermaidFlow.includes("async: order.created"), "应包含 async: order.created 边标签");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T9. 状态机识别
// ============================================================================

test("T9a. stateMachines 列表非空", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    assert.ok(flow.stateMachines.length > 0, "应识别到状态机");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T9b. stateMachines 包含 Order 实体", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    const orderSm = flow.stateMachines.find((sm) => sm.stateMachine.entityName === "Order");
    assert.ok(orderSm, "应识别 Order 实体的状态机");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T9c. Order 状态机的 stateField = status", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    const orderSm = flow.stateMachines.find((sm) => sm.stateMachine.entityName === "Order");
    assert.ok(orderSm);
    assert.equal(orderSm!.stateMachine.stateField, "status");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T9d. Order 状态机的 states 包含 pending 与 paid", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    const orderSm = flow.stateMachines.find((sm) => sm.stateMachine.entityName === "Order");
    assert.ok(orderSm);
    const states = orderSm!.stateMachine.states;
    assert.ok(states.includes("pending"), "states 应包含 pending");
    assert.ok(states.includes("paid"), "states 应包含 paid");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T10. Mermaid 状态图渲染
// ============================================================================

test("T10a. mermaidStateDiagram 包含 stateDiagram-v2 声明", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    const orderSm = flow.stateMachines.find((sm) => sm.stateMachine.entityName === "Order");
    assert.ok(orderSm);
    assert.ok(orderSm!.mermaidStateDiagram.includes("stateDiagram-v2"), "应包含 stateDiagram-v2 声明");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T10b. mermaidStateDiagram 包含 Order 实体注释", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    const orderSm = flow.stateMachines.find((sm) => sm.stateMachine.entityName === "Order");
    assert.ok(orderSm);
    assert.ok(orderSm!.mermaidStateDiagram.includes("Order"), "应包含 Order 实体名注释");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T10c. mermaidStateDiagram 包含终态声明（final）", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    const orderSm = flow.stateMachines.find((sm) => sm.stateMachine.entityName === "Order");
    assert.ok(orderSm);
    // Order 状态机中 transitions 为空，所有状态都视为终态
    assert.ok(orderSm!.mermaidStateDiagram.includes("<<final>>"), "应包含 <<final>> 终态声明");
  } finally {
    await removeTempDir(tmpDir);
  }
});

// ============================================================================
// T11. 不可变性
// ============================================================================

test("T11a. FlowResult 顶层对象冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    assert.equal(Object.isFrozen(flow), true, "FlowResult 应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T11b. steps 数组冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    assert.equal(Object.isFrozen(flow.steps), true, "steps 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T11c. branches 数组冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    assert.equal(Object.isFrozen(flow.branches), true, "branches 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T11d. asyncBoundaries 数组冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    assert.equal(Object.isFrozen(flow.asyncBoundaries), true, "asyncBoundaries 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T11e. stateMachines 数组冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    assert.equal(Object.isFrozen(flow.stateMachines), true, "stateMachines 数组应冻结");
  } finally {
    await removeTempDir(tmpDir);
  }
});

test("T11f. steps 中每个 FlowStep 对象冻结", async () => {
  const tmpDir = await createTempProject();
  try {
    await buildFullFlowProject(tmpDir);
    const discoverer = new BusinessFlowDiscoverer(tmpDir);
    const flow = await discoverer.discover("OrderController.create");
    for (const step of flow.steps) {
      assert.equal(Object.isFrozen(step), true, "每个 FlowStep 对象应冻结");
    }
  } finally {
    await removeTempDir(tmpDir);
  }
});
