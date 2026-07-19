/**
 * EAG-P3 批次 11 Part B2 单元测试：PKC L4 七个 SectionBuilder 独立测试
 *
 * 测试范围：
 * - T1. ArchitectureSectionBuilder（架构概览，第 1 章，documented）
 *   - T1a. 章节 ID / 标题 / 顺序元信息
 *   - T1b. 从 spec.md + CONSTITUTION.md 真实内容构建章节
 *   - T1c. content 包含项目定位 / 技术栈 / 分层架构 / 设计原则四段
 *   - T1d. confidence=documented
 *   - T1e. 返回 HandoverSection 被 Object.freeze 冻结
 *   - T1f. sources 包含 spec.md 与 CONSTITUTION.md
 * - T2. ModuleMapSectionBuilder（模块地图，第 2 章，verified）
 *   - T2a. 元信息正确
 *   - T2b. 从真实 TypeScript 代码扫描模块
 *   - T2c. 提取 export class / interface / function 符号
 *   - T2d. 提取 import 依赖关系
 *   - T2e. confidence=verified
 *   - T2f. 跳过测试文件
 * - T3. ApiContractSectionBuilder（API 契约，第 3 章，verified）
 *   - T3a. 元信息正确
 *   - T3b. 从 NestJS 装饰器提取端点（@Get / @Post）
 *   - T3c. 从 Express 路由提取端点
 *   - T3d. 从 OpenAPI JSON spec 提取端点
 *   - T3e. confidence=verified
 * - T4. DataModelSectionBuilder（数据模型，第 4 章，verified）
 *   - T4a. 元信息正确
 *   - T4b. 从 src/domain 提取领域实体（class / interface）
 *   - T4c. 从 Prisma schema 提取模型与字段
 *   - T4d. confidence=verified
 * - T5. TestStrategySectionBuilder（测试策略，第 5 章，documented）
 *   - T5a. 元信息正确
 *   - T5b. 扫描 .test.ts 文件并提取 describe / it 数量
 *   - T5c. 推断测试层级（unit / integration / e2e）
 *   - T5d. confidence=documented
 *   - T5e. 注入 testResults 时展示覆盖率
 * - T6. RiskDebtSectionBuilder（风险与技术债，第 6 章，inferred）
 *   - T6a. 元信息正确
 *   - T6b. content 头部含 INFERRED_SECTION_NOTICE 提示
 *   - T6c. 扫描 TODO / FIXME / HACK 注释
 *   - T6d. 检测循环依赖
 *   - T6e. 检测大文件
 *   - T6f. confidence=inferred
 * - T7. RunbookSectionBuilder（运维手册，第 7 章，inferred）
 *   - T7a. 元信息正确
 *   - T7b. content 头部含 INFERRED_SECTION_NOTICE 提示
 *   - T7c. 解析 docker-compose.yml 环境变量
 *   - T7d. 解析 Makefile targets
 *   - T7e. 解析 Dockerfile 基础镜像与端口
 *   - T7f. confidence=inferred
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，构造真实 fileMap（含真实 Markdown / 真实 TypeScript 代码 / 真实 YAML）
 * - 中文详细注释
 *
 * @module core/tests/eag-pkc-l4-section-builders
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ArchitectureSectionBuilder } from "../eag/pkc/l4/section-builders/architecture-section";
import { ModuleMapSectionBuilder } from "../eag/pkc/l4/section-builders/module-map-section";
import { ApiContractSectionBuilder } from "../eag/pkc/l4/section-builders/api-contract-section";
import { DataModelSectionBuilder } from "../eag/pkc/l4/section-builders/data-model-section";
import { TestStrategySectionBuilder } from "../eag/pkc/l4/section-builders/test-strategy-section";
import { RiskDebtSectionBuilder } from "../eag/pkc/l4/section-builders/risk-debt-section";
import { RunbookSectionBuilder } from "../eag/pkc/l4/section-builders/runbook-section";
import { INFERRED_SECTION_NOTICE } from "../eag/pkc/l4/types";
import type { SectionBuildContext } from "../eag/pkc/l4/types";

// ============================================================================
// 辅助函数：构造真实 fileMap
// ============================================================================

/**
 * 构造完整的真实项目 fileMap（含 spec.md / CONSTITUTION.md / TypeScript 代码 / 测试 / 部署配置）
 *
 * 项目结构（虚拟）：
 * - spec.md：项目规格说明（含项目定位 / 技术栈 / 分层架构章节）
 * - CONSTITUTION.md：项目宪法（含设计原则章节）
 * - package.json：依赖列表
 * - src/domain/order.ts：Order 实体（class）
 * - src/domain/order-repository.ts：OrderRepository 接口
 * - src/application/order-service.ts：OrderService（依赖 domain）
 * - src/interfaces/order-controller.ts：OrderController（NestJS 装饰器）
 * - src/index.ts：应用入口
 * - tests/unit/order.test.ts：单元测试
 * - tests/integration/order-flow.test.ts：集成测试
 * - prisma/schema.prisma：Prisma 数据模型
 * - docker-compose.yml：部署配置
 * - Dockerfile：容器镜像定义
 * - Makefile：构建脚本
 * - .env.example：环境变量示例
 *
 * @returns 真实 fileMap
 */
function buildFullProjectFileMap(): Record<string, string> {
  const fileMap: Record<string, string> = {};

  // spec.md
  fileMap["spec.md"] = [
    "# 订单系统规格说明",
    "",
    "## 项目定位",
    "",
    "本项目是一个企业级订单管理系统，提供订单创建、支付、查询等核心业务能力。",
    "面向 B 端商家与 C 端消费者，支持高并发场景下的订单处理。",
    "",
    "## 技术栈",
    "",
    "- 后端：NestJS + TypeScript + Prisma",
    "- 数据库：PostgreSQL",
    "- 消息队列：RabbitMQ",
    "- 缓存：Redis",
    "- 部署：Docker + Kubernetes",
    "",
    "## 分层架构",
    "",
    "本项目采用 DDD 分层架构：",
    "- 接口层（interfaces）：HTTP Controller / DTO",
    "- 应用层（application）：ApplicationService / Command Handler",
    "- 领域层（domain）：Aggregate / Entity / ValueObject / DomainService",
    "- 基础设施层（infrastructure）：Repository 实现 / MQ 适配器 / 外部服务客户端",
    "",
    "## 业务流程",
    "",
    "下单 → 支付 → 发货 → 收货 → 完成。",
    "",
  ].join("\n");

  // CONSTITUTION.md
  fileMap["CONSTITUTION.md"] = [
    "# 项目宪法",
    "",
    "## 设计原则",
    "",
    "1. **领域层纯净**：领域层不得依赖框架或基础设施层（对齐 DDD 原则）。",
    "2. **接口契约先行**：所有对外 API 必须有 OpenAPI spec，禁止无契约变更。",
    "3. **幂等性**：所有写操作必须支持幂等键，防止重复提交。",
    "4. **可观测性**：所有关键业务事件必须输出结构化日志与监控指标。",
    "5. **测试覆盖**：领域层行覆盖率 ≥ 80%，高风险符号 100% 覆盖。",
    "",
  ].join("\n");

  // package.json
  fileMap["package.json"] = JSON.stringify(
    {
      name: "order-system",
      version: "1.0.0",
      dependencies: {
        "@nestjs/core": "^10.0.0",
        "@nestjs/common": "^10.0.0",
        "@prisma/client": "^5.0.0",
        "reflect-metadata": "^0.1.13",
        rxjs: "^7.8.0",
      },
      devDependencies: {
        typescript: "^5.0.0",
        "@types/node": "^20.0.0",
        prisma: "^5.0.0",
        vitest: "^1.0.0",
      },
    },
    null,
    2
  );

  // src/domain/order.ts
  fileMap["src/domain/order.ts"] = [
    "/** 订单实体 */",
    "export class Order {",
    "  readonly id: string;",
    "  readonly customerId: string;",
    "  amount: number;",
    "  status: OrderStatus;",
    "  createdAt: Date;",
    "  items: OrderItem[];",
    "}",
    "",
    "export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'completed';",
    "",
    "export interface OrderItem {",
    "  productId: string;",
    "  quantity: number;",
    "  price: number;",
    "}",
    "",
  ].join("\n");

  // src/domain/order-repository.ts
  fileMap["src/domain/order-repository.ts"] = [
    "import type { Order } from './order';",
    "",
    "export interface OrderRepository {",
    "  findById(id: string): Promise<Order | null>;",
    "  save(order: Order): Promise<void>;",
    "}",
    "",
  ].join("\n");

  // src/application/order-service.ts
  fileMap["src/application/order-service.ts"] = [
    "import type { Order } from '../domain/order';",
    "import type { OrderRepository } from '../domain/order-repository';",
    "",
    "export class OrderService {",
    "  constructor(private readonly repo: OrderRepository) {}",
    "",
    "  async createOrder(order: Order): Promise<void> {",
    "    // TODO: 添加幂等键校验",
    "    await this.repo.save(order);",
    "  }",
    "",
    "  async getOrder(id: string): Promise<Order | null> {",
    "    return this.repo.findById(id);",
    "  }",
    "}",
    "",
  ].join("\n");

  // src/interfaces/order-controller.ts
  fileMap["src/interfaces/order-controller.ts"] = [
    "import { Controller, Get, Post, Body, Param } from '@nestjs/common';",
    "import { OrderService } from '../application/order-service';",
    "",
    "@Controller('/api/v1/orders')",
    "export class OrderController {",
    "  constructor(private readonly service: OrderService) {}",
    "",
    "  @Post()",
    "  async create(@Body() body: any): Promise<void> {",
    "    // FIXME: 添加 DTO 校验",
    "    return this.service.createOrder(body);",
    "  }",
    "",
    "  @Get(':id')",
    "  async get(@Param('id') id: string): Promise<any> {",
    "    return this.service.getOrder(id);",
    "  }",
    "}",
    "",
  ].join("\n");

  // src/index.ts
  fileMap["src/index.ts"] = [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module';",
    "",
    "async function bootstrap() {",
    "  const app = await NestFactory.create(AppModule);",
    "  await app.listen(3000);",
    "}",
    "bootstrap();",
    "",
  ].join("\n");

  // src/app.module.ts（含 Express 风格路由示例）
  fileMap["src/app.module.ts"] = [
    "import { Module } from '@nestjs/common';",
    "import { OrderController } from './interfaces/order-controller';",
    "import { OrderService } from './application/order-service';",
    "",
    "@Module({",
    "  controllers: [OrderController],",
    "  providers: [OrderService],",
    "})",
    "export class AppModule {}",
    "",
  ].join("\n");

  // 一个大文件（用于 RiskDebtSectionBuilder 大文件检测，行数 >= 500）
  // 通过重复内容生成 600 行
  fileMap["src/large-file.ts"] = Array.from({ length: 600 }, (_, i) => `// 第 ${i + 1} 行 - 用于测试大文件检测`).join(
    "\n"
  );

  // tests/unit/order.test.ts
  fileMap["tests/unit/order.test.ts"] = [
    "import { test, describe } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "",
    "describe('Order 实体', () => {",
    "  test('应正确创建订单', () => {",
    "    const order = { id: '1', status: 'pending' };",
    "    assert.equal(order.status, 'pending');",
    "  });",
    "",
    "  test('应正确转换状态', () => {",
    "    const status = 'paid';",
    "    assert.equal(status, 'paid');",
    "  });",
    "});",
    "",
  ].join("\n");

  // tests/integration/order-flow.test.ts
  fileMap["tests/integration/order-flow.test.ts"] = [
    "import { test, describe } from 'node:test';",
    "",
    "describe('订单流程集成测试', () => {",
    "  test('下单→支付→查询全链路', () => {",
    "    // 集成测试占位",
    "  });",
    "});",
    "",
  ].join("\n");

  // prisma/schema.prisma
  fileMap["prisma/schema.prisma"] = [
    "model Order {",
    "  id          String   @id @default(uuid())",
    "  customerId  String",
    "  amount      Float",
    '  status      String   @default("pending")',
    "  createdAt   DateTime @default(now())",
    "  items       OrderItem[]",
    "}",
    "",
    "model OrderItem {",
    "  id        String  @id @default(uuid())",
    "  orderId   String",
    "  order     Order   @relation(fields: [orderId], references: [id])",
    "  productId String",
    "  quantity  Int",
    "  price     Float",
    "}",
    "",
    "enum OrderStatus {",
    "  pending",
    "  paid",
    "  shipped",
    "  completed",
    "}",
    "",
  ].join("\n");

  // docker-compose.yml
  fileMap["docker-compose.yml"] = [
    "version: '3.8'",
    "services:",
    "  app:",
    "    build: .",
    "    ports:",
    "      - '3000:3000'",
    "    environment:",
    "      - NODE_ENV=production",
    "      - DATABASE_URL=postgresql://user:pass@db:5432/orders",
    "      - REDIS_URL=redis://redis:6379",
    "    depends_on:",
    "      - db",
    "      - redis",
    "  db:",
    "    image: postgres:15",
    "    ports:",
    "      - '5432:5432'",
    "  redis:",
    "    image: redis:7",
    "    ports:",
    "      - '6379:6379'",
    "",
  ].join("\n");

  // Dockerfile
  fileMap["Dockerfile"] = [
    "FROM node:20-alpine",
    "WORKDIR /app",
    "COPY package*.json ./",
    "RUN npm ci --production",
    "COPY . .",
    "RUN npm run build",
    "EXPOSE 3000",
    'CMD ["node", "dist/index.js"]',
    "",
  ].join("\n");

  // Makefile
  fileMap["Makefile"] = [
    ".PHONY: install build test run",
    "",
    "# 安装依赖",
    "install:",
    "\tnpm install",
    "",
    "# 构建",
    "build:",
    "\tnpm run build",
    "",
    "# 运行测试",
    "test:",
    "\tnpm test",
    "",
    "# 启动开发服务器",
    "run:",
    "\tnpm start",
    "",
  ].join("\n");

  // .env.example
  fileMap[".env.example"] = [
    "# 数据库连接字符串",
    "DATABASE_URL=postgresql://user:pass@localhost:5432/orders",
    "",
    "# Redis 连接字符串",
    "REDIS_URL=redis://localhost:6379",
    "",
    "# 应用端口",
    "PORT=3000",
    "",
    "# 日志级别",
    "LOG_LEVEL=info",
    "",
  ].join("\n");

  // logger 配置
  fileMap["src/infrastructure/logger.ts"] = [
    "import winston from 'winston';",
    "",
    "export const logger = winston.createLogger({",
    "  format: winston.format.combine(",
    "    winston.format.timestamp(),",
    "    winston.format.json()",
    "  ),",
    "  transports: [new winston.transports.Console()]",
    "});",
    "",
  ].join("\n");

  return fileMap;
}

/**
 * 构造 SectionBuildContext（含真实 fileMap 与可选 testResults）
 *
 * @param fileMap 项目文件清单
 * @param testResults 测试结果（可选）
 * @returns SectionBuildContext
 */
function buildContext(fileMap: Record<string, string>, testResults?: ReadonlyArray<unknown>): SectionBuildContext {
  return {
    projectRoot: "/tmp/test-project",
    runId: "test-run-id-001",
    fileMap,
    testResults,
  };
}

// ============================================================================
// T1. ArchitectureSectionBuilder
// ============================================================================

test("T1a: ArchitectureSectionBuilder 元信息正确", () => {
  const builder = new ArchitectureSectionBuilder();
  assert.equal(builder.sectionId, "architecture-overview");
  assert.equal(builder.title, "架构概览");
  assert.equal(builder.order, 1);
});

test("T1b: ArchitectureSectionBuilder 从 spec.md + CONSTITUTION.md 构建章节", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new ArchitectureSectionBuilder();
  const section = await builder.build(context);
  assert.equal(section.sectionId, "architecture-overview");
  assert.equal(section.title, "架构概览");
  assert.equal(section.order, 1);
  assert.equal(section.confidence, "documented");
});

test("T1c: ArchitectureSectionBuilder content 包含项目定位 / 技术栈 / 分层架构 / 设计原则四段", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new ArchitectureSectionBuilder();
  const section = await builder.build(context);
  assert.match(section.content, /项目定位/);
  assert.match(section.content, /技术栈/);
  assert.match(section.content, /分层架构/);
  assert.match(section.content, /设计原则/);
  // 内容应包含真实提取的内容（来自 spec.md / CONSTITUTION.md）
  assert.match(section.content, /企业级订单管理系统/);
  assert.match(section.content, /NestJS/);
  assert.match(section.content, /DDD 分层架构/);
  assert.match(section.content, /领域层纯净/);
});

test("T1d: ArchitectureSectionBuilder confidence=documented", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new ArchitectureSectionBuilder();
  const section = await builder.build(context);
  assert.equal(section.confidence, "documented");
});

test("T1e: ArchitectureSectionBuilder 返回 HandoverSection 被 Object.freeze 冻结", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new ArchitectureSectionBuilder();
  const section = await builder.build(context);
  assert.equal(Object.isFrozen(section), true);
  assert.equal(Object.isFrozen(section.sources), true);
});

test("T1f: ArchitectureSectionBuilder sources 包含 spec.md 与 CONSTITUTION.md", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new ArchitectureSectionBuilder();
  const section = await builder.build(context);
  assert.ok(section.sources.includes("spec.md"));
  assert.ok(section.sources.includes("CONSTITUTION.md"));
});

// ============================================================================
// T2. ModuleMapSectionBuilder
// ============================================================================

test("T2a: ModuleMapSectionBuilder 元信息正确", () => {
  const builder = new ModuleMapSectionBuilder();
  assert.equal(builder.sectionId, "module-map");
  assert.equal(builder.title, "模块地图");
  assert.equal(builder.order, 2);
});

test("T2b: ModuleMapSectionBuilder 从真实 TypeScript 代码扫描模块", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new ModuleMapSectionBuilder();
  const section = await builder.build(context);
  // 应包含 src/domain / src/application / src/interfaces / src 等模块
  assert.match(section.content, /src\/domain/);
  assert.match(section.content, /src\/application/);
  assert.match(section.content, /src\/interfaces/);
  assert.match(section.content, /src\/infrastructure/);
});

test("T2c: ModuleMapSectionBuilder 提取 export class / interface 符号", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new ModuleMapSectionBuilder();
  const section = await builder.build(context);
  // 应包含 Order class / OrderRepository interface / OrderService class
  assert.match(section.content, /Order/);
  assert.match(section.content, /OrderRepository/);
  assert.match(section.content, /OrderService/);
});

test("T2d: ModuleMapSectionBuilder 提取 import 依赖关系", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new ModuleMapSectionBuilder();
  const section = await builder.build(context);
  // application 模块依赖 domain 模块
  assert.match(section.content, /依赖模块/);
  // 应包含 Mermaid 依赖图
  assert.match(section.content, /```mermaid/);
});

test("T2e: ModuleMapSectionBuilder confidence=verified", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new ModuleMapSectionBuilder();
  const section = await builder.build(context);
  assert.equal(section.confidence, "verified");
});

test("T2f: ModuleMapSectionBuilder 跳过测试文件（不纳入模块地图）", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new ModuleMapSectionBuilder();
  const section = await builder.build(context);
  // 测试文件 tests/unit/order.test.ts 不应出现在模块列表中
  assert.doesNotMatch(section.content, /tests\/unit/);
  // 但单元测试文件中的 describe 不应被识别为 export
  assert.doesNotMatch(section.content, /\| Order 实体 \|/);
});

// ============================================================================
// T3. ApiContractSectionBuilder
// ============================================================================

test("T3a: ApiContractSectionBuilder 元信息正确", () => {
  const builder = new ApiContractSectionBuilder();
  assert.equal(builder.sectionId, "api-contract");
  assert.equal(builder.title, "API 契约");
  assert.equal(builder.order, 3);
});

test("T3b: ApiContractSectionBuilder 从 NestJS 装饰器提取端点（@Get / @Post）", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new ApiContractSectionBuilder();
  const section = await builder.build(context);
  // 应识别 @Post() 与 @Get(':id')，且路径含 Controller 前缀 /api/v1/orders
  assert.match(section.content, /POST/);
  assert.match(section.content, /GET/);
  assert.match(section.content, /\/api\/v1\/orders/);
});

test("T3c: ApiContractSectionBuilder 端点含 handler 信息（类名.方法名）", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new ApiContractSectionBuilder();
  const section = await builder.build(context);
  // handler 应包含 OrderController.create / OrderController.get
  assert.match(section.content, /OrderController\.create/);
  assert.match(section.content, /OrderController\.get/);
});

test("T3d: ApiContractSectionBuilder 从 OpenAPI JSON spec 提取端点", async () => {
  // 构造含 OpenAPI spec 的 fileMap
  const fileMap: Record<string, string> = {
    "openapi.json": JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/api/v1/users": {
          get: { summary: "获取用户列表" },
          post: { summary: "创建用户" },
        },
        "/api/v1/users/{userId}": {
          get: { summary: "获取用户详情" },
          delete: { summary: "删除用户" },
        },
      },
    }),
  };
  const context = buildContext(fileMap);
  const builder = new ApiContractSectionBuilder();
  const section = await builder.build(context);
  assert.match(section.content, /GET/);
  assert.match(section.content, /POST/);
  assert.match(section.content, /DELETE/);
  assert.match(section.content, /\/api\/v1\/users/);
});

test("T3e: ApiContractSectionBuilder confidence=verified", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new ApiContractSectionBuilder();
  const section = await builder.build(context);
  assert.equal(section.confidence, "verified");
});

// ============================================================================
// T4. DataModelSectionBuilder
// ============================================================================

test("T4a: DataModelSectionBuilder 元信息正确", () => {
  const builder = new DataModelSectionBuilder();
  assert.equal(builder.sectionId, "data-model");
  assert.equal(builder.title, "数据模型");
  assert.equal(builder.order, 4);
});

test("T4b: DataModelSectionBuilder 从 src/domain 提取领域实体（class / interface）", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new DataModelSectionBuilder();
  const section = await builder.build(context);
  // 应包含 Order class / OrderRepository interface / OrderItem interface
  assert.match(section.content, /Order/);
  assert.match(section.content, /OrderRepository/);
  assert.match(section.content, /OrderItem/);
});

test("T4c: DataModelSectionBuilder 从 Prisma schema 提取模型与字段", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new DataModelSectionBuilder();
  const section = await builder.build(context);
  // 应包含 Prisma 模型 Order / OrderItem
  assert.match(section.content, /Prisma/);
  assert.match(section.content, /id/);
  assert.match(section.content, /customerId/);
});

test("T4d: DataModelSectionBuilder confidence=verified", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new DataModelSectionBuilder();
  const section = await builder.build(context);
  assert.equal(section.confidence, "verified");
});

test("T4e: DataModelSectionBuilder 降级到 SQL migrations 解析", async () => {
  // 构造无 Prisma schema 但有 SQL migration 的 fileMap
  const fileMap: Record<string, string> = {
    "migrations/001_create_orders.sql": [
      "CREATE TABLE orders (",
      "  id VARCHAR(36) PRIMARY KEY,",
      "  customer_id VARCHAR(36) NOT NULL,",
      "  amount DECIMAL(10, 2) NOT NULL,",
      "  status VARCHAR(20) NOT NULL DEFAULT 'pending',",
      "  created_at TIMESTAMP NOT NULL DEFAULT NOW()",
      ");",
      "",
      "CREATE TABLE order_items (",
      "  id VARCHAR(36) PRIMARY KEY,",
      "  order_id VARCHAR(36) NOT NULL,",
      "  product_id VARCHAR(36) NOT NULL,",
      "  quantity INT NOT NULL,",
      "  price DECIMAL(10, 2) NOT NULL,",
      "  FOREIGN KEY (order_id) REFERENCES orders(id)",
      ");",
      "",
    ].join("\n"),
  };
  const context = buildContext(fileMap);
  const builder = new DataModelSectionBuilder();
  const section = await builder.build(context);
  // 应包含 SQL 表结构信息
  assert.match(section.content, /orders/);
  assert.match(section.content, /order_items/);
  assert.match(section.content, /SQL/);
});

// ============================================================================
// T5. TestStrategySectionBuilder
// ============================================================================

test("T5a: TestStrategySectionBuilder 元信息正确", () => {
  const builder = new TestStrategySectionBuilder();
  assert.equal(builder.sectionId, "test-strategy");
  assert.equal(builder.title, "测试策略");
  assert.equal(builder.order, 5);
});

test("T5b: TestStrategySectionBuilder 扫描 .test.ts 文件并提取 describe / it 数量", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new TestStrategySectionBuilder();
  const section = await builder.build(context);
  // 应包含 tests/unit/order.test.ts 与 tests/integration/order-flow.test.ts
  assert.match(section.content, /tests\/unit\/order\.test\.ts/);
  assert.match(section.content, /tests\/integration\/order-flow\.test\.ts/);
  // 应含 describe 数量
  assert.match(section.content, /describe/);
});

test("T5c: TestStrategySectionBuilder 推断测试层级（unit / integration）", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new TestStrategySectionBuilder();
  const section = await builder.build(context);
  // 测试金字塔分布表应含 unit / integration
  assert.match(section.content, /unit/);
  assert.match(section.content, /integration/);
});

test("T5d: TestStrategySectionBuilder confidence=documented", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new TestStrategySectionBuilder();
  const section = await builder.build(context);
  assert.equal(section.confidence, "documented");
});

test("T5e: TestStrategySectionBuilder 注入 testResults 时展示覆盖率", async () => {
  const fileMap = buildFullProjectFileMap();
  // 注入含 coverage 字段的 testResults
  const testResults = [
    {
      coverage: {
        lines: 85.5,
        branches: 72.3,
        functions: 88.0,
      },
    },
  ];
  const context = buildContext(fileMap, testResults);
  const builder = new TestStrategySectionBuilder();
  const section = await builder.build(context);
  // 应展示覆盖率数值
  assert.match(section.content, /85\.50%/);
  assert.match(section.content, /72\.30%/);
  assert.match(section.content, /88\.00%/);
});

// ============================================================================
// T6. RiskDebtSectionBuilder
// ============================================================================

test("T6a: RiskDebtSectionBuilder 元信息正确", () => {
  const builder = new RiskDebtSectionBuilder();
  assert.equal(builder.sectionId, "risks-debt");
  assert.equal(builder.title, "风险与技术债");
  assert.equal(builder.order, 6);
});

test("T6b: RiskDebtSectionBuilder content 头部含 INFERRED_SECTION_NOTICE 提示", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new RiskDebtSectionBuilder();
  const section = await builder.build(context);
  // inferred 章节 content 必须以 INFERRED_SECTION_NOTICE 开头
  assert.ok(section.content.startsWith(INFERRED_SECTION_NOTICE));
});

test("T6c: RiskDebtSectionBuilder 扫描 TODO / FIXME 注释", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new RiskDebtSectionBuilder();
  const section = await builder.build(context);
  // 应识别 TODO（来自 order-service.ts）与 FIXME（来自 order-controller.ts）
  assert.match(section.content, /TODO/);
  assert.match(section.content, /FIXME/);
});

test("T6d: RiskDebtSectionBuilder 检测大文件（行数 >= 500）", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new RiskDebtSectionBuilder();
  const section = await builder.build(context);
  // 应识别 src/large-file.ts（600 行）
  assert.match(section.content, /大文件/);
  assert.match(section.content, /src\/large-file\.ts/);
});

test("T6e: RiskDebtSectionBuilder confidence=inferred", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new RiskDebtSectionBuilder();
  const section = await builder.build(context);
  assert.equal(section.confidence, "inferred");
});

test("T6f: RiskDebtSectionBuilder 检测循环依赖（构造循环 import 的 fileMap）", async () => {
  // 构造循环依赖：src/a → src/b → src/c → src/a
  // 每个文件位于独立子目录，确保模块路径分别为 src/a / src/b / src/c
  const fileMap: Record<string, string> = {
    "src/a/a.ts": "import { b } from '../b/b';\nexport const a = b;\n",
    "src/b/b.ts": "import { c } from '../c/c';\nexport const b = c;\n",
    "src/c/c.ts": "import { a } from '../a/a';\nexport const c = a;\n",
  };
  const context = buildContext(fileMap);
  const builder = new RiskDebtSectionBuilder();
  const section = await builder.build(context);
  // 应检测到循环依赖
  assert.match(section.content, /循环依赖/);
  // 应含至少一条循环路径（含 src/a / src/b / src/c 三个模块）
  assert.match(section.content, /src\/a/);
  assert.match(section.content, /src\/b/);
  assert.match(section.content, /src\/c/);
});

// ============================================================================
// T7. RunbookSectionBuilder
// ============================================================================

test("T7a: RunbookSectionBuilder 元信息正确", () => {
  const builder = new RunbookSectionBuilder();
  assert.equal(builder.sectionId, "runbook");
  assert.equal(builder.title, "运维手册");
  assert.equal(builder.order, 7);
});

test("T7b: RunbookSectionBuilder content 头部含 INFERRED_SECTION_NOTICE 提示", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new RunbookSectionBuilder();
  const section = await builder.build(context);
  // inferred 章节 content 必须以 INFERRED_SECTION_NOTICE 开头
  assert.ok(section.content.startsWith(INFERRED_SECTION_NOTICE));
});

test("T7c: RunbookSectionBuilder 解析 docker-compose.yml 环境变量", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new RunbookSectionBuilder();
  const section = await builder.build(context);
  // 应提取环境变量 DATABASE_URL / REDIS_URL / NODE_ENV
  assert.match(section.content, /DATABASE_URL/);
  assert.match(section.content, /REDIS_URL/);
  assert.match(section.content, /NODE_ENV/);
});

test("T7d: RunbookSectionBuilder 解析 Makefile targets", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new RunbookSectionBuilder();
  const section = await builder.build(context);
  // 应含 Makefile targets：install / build / test / run
  assert.match(section.content, /install/);
  assert.match(section.content, /build/);
  assert.match(section.content, /test/);
  assert.match(section.content, /run/);
});

test("T7e: RunbookSectionBuilder 解析 Dockerfile 基础镜像与端口", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new RunbookSectionBuilder();
  const section = await builder.build(context);
  // 应含 Docker 基础镜像 node:20-alpine 与端口 3000
  assert.match(section.content, /node:20-alpine/);
  assert.match(section.content, /3000/);
});

test("T7f: RunbookSectionBuilder confidence=inferred", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new RunbookSectionBuilder();
  const section = await builder.build(context);
  assert.equal(section.confidence, "inferred");
});

test("T7g: RunbookSectionBuilder 解析 .env.example 环境变量（含描述）", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new RunbookSectionBuilder();
  const section = await builder.build(context);
  // .env.example 中的注释应被提取为变量描述
  assert.match(section.content, /数据库连接字符串/);
  assert.match(section.content, /Redis 连接字符串/);
  assert.match(section.content, /应用端口/);
});

test("T7h: RunbookSectionBuilder 返回 HandoverSection 被 Object.freeze 冻结", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new RunbookSectionBuilder();
  const section = await builder.build(context);
  assert.equal(Object.isFrozen(section), true);
  assert.equal(Object.isFrozen(section.sources), true);
});
