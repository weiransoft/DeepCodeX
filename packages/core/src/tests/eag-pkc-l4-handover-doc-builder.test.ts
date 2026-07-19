/**
 * EAG-P3 批次 11 Part B2 集成测试：HandoverDocumentBuilder 编排器
 *
 * 测试范围：
 * - T1. 构造函数校验
 *   - T1a. builder 数量 < 7 时抛错（invalid-builder-count）
 *   - T1b. builder 数量 > 7 时抛错
 *   - T1c. builder 数量 = 7 但 order 重复时抛错（duplicate-section-order）
 *   - T1d. builder 数量 = 7 但 sectionId 重复时抛错（duplicate-section-id）
 *   - T1e. builder 数量 = 7 但 order 超出 1~7 时抛错（invalid-section-order）
 *   - T1f. 合法 7 个 builder 构造成功
 * - T2. build 完整流程
 *   - T2a. 返回 HandoverDocument 含 7 章
 *   - T2b. 章节按 order 排序（1~7）
 *   - T2c. 整体置信度取最低（inferred）
 *   - T2d. 目录含 7 行（每章一行）
 *   - T2e. 文档被 Object.freeze 冻结
 *   - T2f. sections 数组被 Object.freeze 冻结
 *   - T2g. 每个 section 被 Object.freeze 冻结
 * - T3. 并行构建验证
 *   - T3a. 7 个 SectionBuilder 串行执行的总时间应大于并行执行（间接验证 Promise.all）
 * - T4. 端到端真实数据
 *   - T4a. 使用真实 fileMap 构建，文档内容含真实信息
 *   - T4b. 整体置信度为 inferred（risks-debt 与 runbook 为 inferred）
 * - T5. 单 SectionBuilder 抛异常时其他章节正常构建（架构师审查 B2-M1 修复验证）
 *   - T5a. 单 builder.build 抛异常时文档仍含 7 章（不丢失章节）
 *   - T5b. 失败章节降级为 confidence="inferred"
 *   - T5c. 失败章节 content 包含错误信息（"章节构建失败" + 错误消息）
 *   - T5d. 失败章节 content 包含 INFERRED_SECTION_NOTICE 提示
 *   - T5e. 其他 6 个章节正常构建（content 不为空）
 *   - T5f. overallConfidence === "inferred"（因存在降级章节）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，构造真实 fileMap（含真实 Markdown / 真实 TypeScript 代码）
 * - 中文详细注释
 *
 * @module core/tests/eag-pkc-l4-handover-doc-builder
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HandoverDocumentBuilder } from "../eag/pkc/l4/handover-doc-builder";
import {
  ArchitectureSectionBuilder,
  ModuleMapSectionBuilder,
  ApiContractSectionBuilder,
  DataModelSectionBuilder,
  TestStrategySectionBuilder,
  RiskDebtSectionBuilder,
  RunbookSectionBuilder,
} from "../eag/pkc/l4/index";
import { HandoverDocumentBuilderError, INFERRED_SECTION_NOTICE, SECTION_COUNT } from "../eag/pkc/l4/types";
import type { SectionBuilder, SectionBuildContext, HandoverSection } from "../eag/pkc/l4/types";

// ============================================================================
// 辅助函数：构造真实 fileMap 与 context
// ============================================================================

/**
 * 构造完整真实项目 fileMap（与 section-builders 测试相同结构）
 *
 * @returns 真实 fileMap
 */
function buildFullProjectFileMap(): Record<string, string> {
  const fileMap: Record<string, string> = {};

  fileMap["spec.md"] = [
    "# 订单系统规格说明",
    "",
    "## 项目定位",
    "",
    "本项目是企业级订单管理系统。",
    "",
    "## 技术栈",
    "",
    "- NestJS + TypeScript",
    "",
    "## 分层架构",
    "",
    "DDD 分层：interfaces / application / domain / infrastructure",
    "",
  ].join("\n");

  fileMap["CONSTITUTION.md"] = ["# 项目宪法", "", "## 设计原则", "", "1. 领域层纯净", "2. 接口契约先行", ""].join("\n");

  fileMap["src/domain/order.ts"] = [
    "export class Order {",
    "  readonly id: string;",
    "  amount: number;",
    "}",
    "",
    "export interface OrderRepo {",
    "  findById(id: string): Promise<Order | null>;",
    "}",
    "",
  ].join("\n");

  fileMap["src/application/order-service.ts"] = [
    "import { OrderRepo } from '../domain/order';",
    "",
    "export class OrderService {",
    "  constructor(private repo: OrderRepo) {}",
    "  // TODO: 添加幂等键校验",
    "  async create(o: any): Promise<void> {}",
    "}",
    "",
  ].join("\n");

  fileMap["src/interfaces/order-controller.ts"] = [
    "import { Controller, Get, Post } from '@nestjs/common';",
    "",
    "@Controller('/api/v1/orders')",
    "export class OrderController {",
    "  @Post()",
    "  async create() {}",
    "",
    "  @Get(':id')",
    "  async get() {}",
    "}",
    "",
  ].join("\n");

  fileMap["prisma/schema.prisma"] = ["model Order {", "  id     String @id", "  amount Float", "}", ""].join("\n");

  fileMap["tests/unit/order.test.ts"] = [
    "import { test, describe } from 'node:test';",
    "describe('Order', () => {",
    "  test('应创建', () => {});",
    "});",
    "",
  ].join("\n");

  fileMap["docker-compose.yml"] = [
    "services:",
    "  app:",
    "    environment:",
    "      - DATABASE_URL=postgresql://x",
    "",
  ].join("\n");

  fileMap["Dockerfile"] = ["FROM node:20", "EXPOSE 3000", 'CMD ["node", "dist/index.js"]', ""].join("\n");

  fileMap["Makefile"] = ["build:", "\tnpm run build", "", "test:", "\tnpm test", ""].join("\n");

  return fileMap;
}

/**
 * 构造 SectionBuildContext
 *
 * @param fileMap 项目文件清单
 * @returns SectionBuildContext
 */
function buildContext(fileMap: Record<string, string>): SectionBuildContext {
  return {
    projectRoot: "/tmp/test-project",
    runId: "test-run-id-001",
    fileMap,
  };
}

/**
 * 创建 7 个真实的 SectionBuilder 实例
 *
 * @returns 7 个 SectionBuilder 数组
 */
function createDefaultBuilders(): ReadonlyArray<SectionBuilder> {
  return [
    new ArchitectureSectionBuilder(),
    new ModuleMapSectionBuilder(),
    new ApiContractSectionBuilder(),
    new DataModelSectionBuilder(),
    new TestStrategySectionBuilder(),
    new RiskDebtSectionBuilder(),
    new RunbookSectionBuilder(),
  ];
}

/**
 * 创建自定义 SectionBuilder（用于测试不变式校验）
 *
 * @param sectionId 章节 ID
 * @param order 章节顺序
 * @param confidence 置信度
 * @returns SectionBuilder 实例
 */
function createCustomBuilder(
  sectionId: string,
  order: number,
  confidence: "documented" | "inferred" | "verified" = "documented"
): SectionBuilder {
  return {
    sectionId,
    title: `测试章节-${sectionId}`,
    order,
    async build(): Promise<HandoverSection> {
      return Object.freeze({
        sectionId,
        title: `测试章节-${sectionId}`,
        order,
        confidence,
        content: `## 测试章节-${sectionId}\n`,
        sources: Object.freeze([]),
      });
    },
  };
}

/**
 * 创建会抛异常的 SectionBuilder（用于 T5 系列错误隔离测试）
 *
 * 在 build 方法中直接抛出 Error，模拟 SectionBuilder 内部异常场景，
 * 验证 HandoverDocumentBuilder.build 的 Promise.all 错误隔离策略（B2-M1 修复）。
 *
 * @param sectionId 章节 ID
 * @param order 章节顺序
 * @param errorMessage build 方法抛出的错误消息（默认 "test failure"）
 * @returns SectionBuilder 实例（build 方法会抛异常）
 */
function createFailingBuilder(sectionId: string, order: number, errorMessage: string = "test failure"): SectionBuilder {
  return {
    sectionId,
    title: `测试章节-${sectionId}`,
    order,
    async build(): Promise<HandoverSection> {
      // 模拟 SectionBuilder 内部异常（如文件解析失败 / PKC 数据缺失等）
      throw new Error(errorMessage);
    },
  };
}

// ============================================================================
// T1. 构造函数校验
// ============================================================================

test("T1a: builder 数量 < 7 时抛错（invalid-builder-count）", () => {
  const builders = createDefaultBuilders().slice(0, 6); // 仅 6 个
  assert.throws(
    () => new HandoverDocumentBuilder(builders),
    (err: unknown) => {
      assert.ok(err instanceof HandoverDocumentBuilderError);
      const e = err as HandoverDocumentBuilderError;
      assert.equal(e.kind, "invalid-builder-count");
      return true;
    }
  );
});

test("T1b: builder 数量 > 7 时抛错", () => {
  // 7 个默认 + 1 个自定义（order=1，会触发 order 重复，但先触发 count 检查）
  const builders = [...createDefaultBuilders(), createCustomBuilder("extra-section", 1)];
  assert.throws(
    () => new HandoverDocumentBuilder(builders),
    (err: unknown) => {
      assert.ok(err instanceof HandoverDocumentBuilderError);
      assert.equal((err as HandoverDocumentBuilderError).kind, "invalid-builder-count");
      return true;
    }
  );
});

test("T1c: builder 数量 = 7 但 order 重复时抛错（duplicate-section-order）", () => {
  // 构造 7 个 builder，但其中两个 order=1
  const builders: SectionBuilder[] = [
    createCustomBuilder("sec1", 1),
    createCustomBuilder("sec2", 1), // order 重复
    createCustomBuilder("sec3", 3),
    createCustomBuilder("sec4", 4),
    createCustomBuilder("sec5", 5),
    createCustomBuilder("sec6", 6),
    createCustomBuilder("sec7", 7),
  ];
  assert.throws(
    () => new HandoverDocumentBuilder(builders),
    (err: unknown) => {
      assert.ok(err instanceof HandoverDocumentBuilderError);
      assert.equal((err as HandoverDocumentBuilderError).kind, "duplicate-section-order");
      return true;
    }
  );
});

test("T1d: builder 数量 = 7 但 sectionId 重复时抛错（duplicate-section-id）", () => {
  // 构造 7 个 builder，order 唯一但 sectionId 重复
  const builders: SectionBuilder[] = [
    createCustomBuilder("dup", 1),
    createCustomBuilder("dup", 2), // sectionId 重复
    createCustomBuilder("sec3", 3),
    createCustomBuilder("sec4", 4),
    createCustomBuilder("sec5", 5),
    createCustomBuilder("sec6", 6),
    createCustomBuilder("sec7", 7),
  ];
  assert.throws(
    () => new HandoverDocumentBuilder(builders),
    (err: unknown) => {
      assert.ok(err instanceof HandoverDocumentBuilderError);
      assert.equal((err as HandoverDocumentBuilderError).kind, "duplicate-section-id");
      return true;
    }
  );
});

test("T1e: builder 数量 = 7 但 order 超出 1~7 时抛错（invalid-section-order）", () => {
  const builders: SectionBuilder[] = [
    createCustomBuilder("sec1", 1),
    createCustomBuilder("sec2", 2),
    createCustomBuilder("sec3", 3),
    createCustomBuilder("sec4", 4),
    createCustomBuilder("sec5", 5),
    createCustomBuilder("sec6", 6),
    createCustomBuilder("sec8", 8), // order=8 超出 1~7
  ];
  assert.throws(
    () => new HandoverDocumentBuilder(builders),
    (err: unknown) => {
      assert.ok(err instanceof HandoverDocumentBuilderError);
      assert.equal((err as HandoverDocumentBuilderError).kind, "invalid-section-order");
      return true;
    }
  );
});

test("T1f: 合法 7 个 builder 构造成功", () => {
  const builders = createDefaultBuilders();
  const builder = new HandoverDocumentBuilder(builders);
  assert.ok(builder instanceof HandoverDocumentBuilder);
});

// ============================================================================
// T2. build 完整流程
// ============================================================================

test("T2a: build 返回 HandoverDocument 含 7 章", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createDefaultBuilders());
  const doc = await builder.build(context, "handover-test-001", "run-001");
  assert.equal(doc.sections.length, SECTION_COUNT);
});

test("T2b: build 章节按 order 排序（1~7）", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createDefaultBuilders());
  const doc = await builder.build(context, "handover-test-002", "run-002");
  const orders = doc.sections.map((s) => s.order);
  assert.deepEqual(orders, [1, 2, 3, 4, 5, 6, 7]);
});

test("T2c: build 整体置信度取最低（inferred）", async () => {
  // 默认 7 个 builder 中 risks-debt 与 runbook 为 inferred，故整体应为 inferred
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createDefaultBuilders());
  const doc = await builder.build(context, "handover-test-003", "run-003");
  assert.equal(doc.overallConfidence, "inferred");
});

test("T2d: build 目录含 7 行（每章一行）", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createDefaultBuilders());
  const doc = await builder.build(context, "handover-test-004", "run-004");
  const tocLines = doc.tableOfContents.split("\n");
  assert.equal(tocLines.length, 7);
  // 每行格式应为 "N. [标题](#sectionId)"
  assert.match(tocLines[0], /^1\. \[架构概览\]\(#architecture-overview\)$/);
  assert.match(tocLines[6], /^7\. \[运维手册\]\(#runbook\)$/);
});

test("T2e: build 文档被 Object.freeze 冻结", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createDefaultBuilders());
  const doc = await builder.build(context, "handover-test-005", "run-005");
  assert.equal(Object.isFrozen(doc), true);
});

test("T2f: build sections 数组被 Object.freeze 冻结", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createDefaultBuilders());
  const doc = await builder.build(context, "handover-test-006", "run-006");
  assert.equal(Object.isFrozen(doc.sections), true);
});

test("T2g: build 每个 section 被 Object.freeze 冻结", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createDefaultBuilders());
  const doc = await builder.build(context, "handover-test-007", "run-007");
  for (const section of doc.sections) {
    assert.equal(Object.isFrozen(section), true);
    assert.equal(Object.isFrozen(section.sources), true);
  }
});

test("T2h: build documentId / projectRoot / runId / generatedAt 字段正确填充", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createDefaultBuilders());
  const doc = await builder.build(context, "handover-test-008", "run-008");
  assert.equal(doc.documentId, "handover-test-008");
  assert.equal(doc.projectRoot, "/tmp/test-project");
  assert.equal(doc.runId, "run-008");
  // generatedAt 应为有效 ISO 8601 字符串
  assert.match(doc.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  // 验证可被 Date 解析
  const parsed = new Date(doc.generatedAt);
  assert.ok(!isNaN(parsed.getTime()));
});

// ============================================================================
// T3. 并行构建验证
// ============================================================================

test("T3a: 7 个 SectionBuilder 并行执行（通过 Promise.all）", async () => {
  // 通过对比"串行总延迟"与"并行实际延迟"间接验证 Promise.all
  // 串行：每个 builder 延迟 50ms，7 个串行 = 350ms
  // 并行：7 个并行 = ~50ms
  const delayBuilders: SectionBuilder[] = [];
  for (let i = 0; i < 7; i++) {
    delayBuilders.push({
      sectionId: `sec-${i}`,
      title: `章节-${i}`,
      order: i + 1,
      async build(): Promise<HandoverSection> {
        // 每个 builder 延迟 50ms
        await new Promise((resolve) => setTimeout(resolve, 50));
        return Object.freeze({
          sectionId: `sec-${i}`,
          title: `章节-${i}`,
          order: i + 1,
          confidence: "documented",
          content: `## 章节-${i}\n`,
          sources: Object.freeze([]),
        });
      },
    });
  }

  const builder = new HandoverDocumentBuilder(delayBuilders);
  const context = buildContext({});
  const start = Date.now();
  await builder.build(context, "handover-parallel", "run-parallel");
  const elapsed = Date.now() - start;

  // 并行执行：总时间应远小于 350ms（7 × 50ms）
  // 由于 setTimeout 不精确，放宽至 200ms 阈值
  assert.ok(elapsed < 200, `并行执行总耗时 ${elapsed}ms 应 < 200ms（串行需 350ms）`);
});

// ============================================================================
// T4. 端到端真实数据
// ============================================================================

test("T4a: 使用真实 fileMap 构建，文档内容含真实信息", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createDefaultBuilders());
  const doc = await builder.build(context, "handover-e2e", "run-e2e");

  // 第 1 章 架构概览 应含真实项目定位信息
  const archSection = doc.sections.find((s) => s.sectionId === "architecture-overview");
  assert.ok(archSection);
  assert.match(archSection!.content, /企业级订单管理系统/);

  // 第 2 章 模块地图 应含真实模块路径
  const moduleMapSection = doc.sections.find((s) => s.sectionId === "module-map");
  assert.ok(moduleMapSection);
  assert.match(moduleMapSection!.content, /src\/domain/);

  // 第 3 章 API 契约 应含真实端点
  const apiSection = doc.sections.find((s) => s.sectionId === "api-contract");
  assert.ok(apiSection);
  assert.match(apiSection!.content, /\/api\/v1\/orders/);

  // 第 4 章 数据模型 应含真实实体 Order
  const dataModelSection = doc.sections.find((s) => s.sectionId === "data-model");
  assert.ok(dataModelSection);
  assert.match(dataModelSection!.content, /Order/);

  // 第 5 章 测试策略 应含真实测试文件
  const testStrategySection = doc.sections.find((s) => s.sectionId === "test-strategy");
  assert.ok(testStrategySection);
  assert.match(testStrategySection!.content, /tests\/unit\/order\.test\.ts/);

  // 第 6 章 风险与技术债 应含 inferred 提示与 TODO
  const risksSection = doc.sections.find((s) => s.sectionId === "risks-debt");
  assert.ok(risksSection);
  assert.match(risksSection!.content, /置信度提示/);
  assert.match(risksSection!.content, /TODO/);

  // 第 7 章 运维手册 应含 inferred 提示与部署信息
  const runbookSection = doc.sections.find((s) => s.sectionId === "runbook");
  assert.ok(runbookSection);
  assert.match(runbookSection!.content, /置信度提示/);
  assert.match(runbookSection!.content, /DATABASE_URL/);
});

test("T4b: 整体置信度为 inferred（risks-debt 与 runbook 为 inferred）", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createDefaultBuilders());
  const doc = await builder.build(context, "handover-confidence", "run-confidence");
  assert.equal(doc.overallConfidence, "inferred");
});

test("T4c: 章节置信度与 §7.4 七章结构表默认值一致", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createDefaultBuilders());
  const doc = await builder.build(context, "handover-conf-check", "run-conf-check");

  // 七章置信度应对齐 §7.4 表格
  const expectedConfidence: Record<string, string> = {
    "architecture-overview": "documented",
    "module-map": "verified",
    "api-contract": "verified",
    "data-model": "verified",
    "test-strategy": "documented",
    "risks-debt": "inferred",
    runbook: "inferred",
  };

  for (const section of doc.sections) {
    assert.equal(
      section.confidence,
      expectedConfidence[section.sectionId],
      `sectionId=${section.sectionId} 置信度与 §7.4 不一致`
    );
  }
});

test("T4d: 目录 anchor 与 sectionId 一一对应", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createDefaultBuilders());
  const doc = await builder.build(context, "handover-toc", "run-toc");

  // 解析目录中的 anchor
  const anchorRegex = /\(#([^)]+)\)/g;
  const anchors: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(doc.tableOfContents)) !== null) {
    anchors.push(match[1]);
  }
  assert.equal(anchors.length, 7);

  // anchors 应与 sections 的 sectionId 一一对应
  const sectionIds = doc.sections.map((s) => s.sectionId);
  assert.deepEqual(anchors, sectionIds);
});

// ============================================================================
// T5. 单 SectionBuilder 抛异常时其他章节正常构建（架构师审查 B2-M1 修复验证）
//
// 测试场景：构造 7 个 SectionBuilder，其中第 3 章（api-contract，order=3）使用
// createFailingBuilder（build 方法直接抛 Error），其他 6 章使用真实 SectionBuilder。
// 验证 HandoverDocumentBuilder.build 的 Promise.all 错误隔离策略：
// - 单 builder.build 抛异常时不影响其他章节构建
// - 失败章节降级为 confidence="inferred"
// - 失败章节 content 包含 INFERRED_SECTION_NOTICE 提示 + 错误信息
// - overallConfidence === "inferred"（因存在降级章节）
// ============================================================================

/**
 * 构造 T5 系列测试的 7 个 builder（6 真实 + 1 失败）
 *
 * 第 3 章（api-contract，order=3）使用 createFailingBuilder 抛 "test failure" 异常，
 * 其他 6 章使用真实 SectionBuilder，验证错误隔离策略。
 *
 * @returns 7 个 SectionBuilder（含 1 个会抛异常的 builder）
 */
function createBuildersWithOneFailure(): ReadonlyArray<SectionBuilder> {
  return [
    new ArchitectureSectionBuilder(), // order=1 真实
    new ModuleMapSectionBuilder(), // order=2 真实
    createFailingBuilder("api-contract", 3, "test failure"), // order=3 失败
    new DataModelSectionBuilder(), // order=4 真实
    new TestStrategySectionBuilder(), // order=5 真实
    new RiskDebtSectionBuilder(), // order=6 真实
    new RunbookSectionBuilder(), // order=7 真实
  ];
}

test("T5a: 单 builder.build 抛异常时文档仍含 7 章（不丢失章节）", async () => {
  // 验证错误隔离：单 builder 抛异常不应导致整个文档构建失败
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createBuildersWithOneFailure());
  const doc = await builder.build(context, "handover-fail-isolation", "run-fail-1");

  // 文档仍应含 7 章（失败章节降级为 inferred，不丢失）
  assert.equal(doc.sections.length, SECTION_COUNT);
});

test("T5b: 失败章节降级为 confidence=inferred", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createBuildersWithOneFailure());
  const doc = await builder.build(context, "handover-fail-inferred", "run-fail-2");

  // 找到失败的章节（sectionId="api-contract"）
  const failedSection = doc.sections.find((s) => s.sectionId === "api-contract");
  assert.ok(failedSection, "应找到失败的 api-contract 章节");

  // 失败章节的 confidence 应降级为 "inferred"
  assert.equal(failedSection!.confidence, "inferred", `失败章节应降级为 inferred，实际：${failedSection!.confidence}`);
});

test("T5c: 失败章节 content 包含错误信息（章节构建失败 + 错误消息）", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createBuildersWithOneFailure());
  const doc = await builder.build(context, "handover-fail-msg", "run-fail-3");

  const failedSection = doc.sections.find((s) => s.sectionId === "api-contract");
  assert.ok(failedSection);

  // 失败章节 content 应包含 "章节构建失败" 提示
  assert.ok(
    failedSection!.content.includes("章节构建失败"),
    `失败章节 content 应包含 "章节构建失败"，实际：${failedSection!.content}`
  );
  // 失败章节 content 应包含具体错误消息 "test failure"
  assert.ok(
    failedSection!.content.includes("test failure"),
    `失败章节 content 应包含错误消息 "test failure"，实际：${failedSection!.content}`
  );
});

test("T5d: 失败章节 content 包含 INFERRED_SECTION_NOTICE 提示", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createBuildersWithOneFailure());
  const doc = await builder.build(context, "handover-fail-notice", "run-fail-4");

  const failedSection = doc.sections.find((s) => s.sectionId === "api-contract");
  assert.ok(failedSection);

  // 失败章节 content 应以 INFERRED_SECTION_NOTICE 开头（对齐 §7.4 inferred 章节约束）
  assert.ok(
    failedSection!.content.startsWith(INFERRED_SECTION_NOTICE),
    `失败章节 content 应以 INFERRED_SECTION_NOTICE 开头，实际起始：${failedSection!.content.slice(0, 80)}`
  );
  // 同时验证 content 包含置信度提示文案（INFERRED_SECTION_NOTICE 的核心内容）
  assert.ok(
    failedSection!.content.includes("置信度提示"),
    `失败章节 content 应包含 "置信度提示"，实际：${failedSection!.content}`
  );
});

test("T5e: 其他 6 个章节正常构建（content 不为空）", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createBuildersWithOneFailure());
  const doc = await builder.build(context, "handover-fail-others", "run-fail-5");

  // 排除失败的 api-contract 章节，其他 6 个章节应正常构建
  const otherSections = doc.sections.filter((s) => s.sectionId !== "api-contract");
  assert.equal(otherSections.length, 6, `其他正常章节应为 6 个，实际：${otherSections.length}`);

  // 每个正常章节的 content 不应为空
  for (const section of otherSections) {
    assert.ok(
      section.content.trim().length > 0,
      `章节 ${section.sectionId} content 不应为空，实际：${section.content}`
    );
    // 正常章节的 confidence 不应为 "inferred"（除非原本就是 inferred，如 risks-debt / runbook）
    // 此处仅验证 content 非空，不强制 confidence（risks-debt 与 runbook 原本就是 inferred）
  }

  // 验证其他 6 个章节的 sectionId 与预期一致（确保失败章节被正确替换，其他章节未被错误降级）
  const expectedOtherIds = [
    "architecture-overview",
    "module-map",
    "data-model",
    "test-strategy",
    "risks-debt",
    "runbook",
  ];
  const actualOtherIds = otherSections.map((s) => s.sectionId).sort();
  assert.deepEqual(actualOtherIds, [...expectedOtherIds].sort());
});

test("T5f: overallConfidence === inferred（因存在降级章节）", async () => {
  const fileMap = buildFullProjectFileMap();
  const context = buildContext(fileMap);
  const builder = new HandoverDocumentBuilder(createBuildersWithOneFailure());
  const doc = await builder.build(context, "handover-fail-overall", "run-fail-6");

  // 因存在降级章节（confidence="inferred"），整体置信度应取最低值 "inferred"
  // 注：即使其他 6 个章节中有 verified / documented，整体仍为 inferred
  assert.equal(
    doc.overallConfidence,
    "inferred",
    `存在降级章节时 overallConfidence 应为 inferred，实际：${doc.overallConfidence}`
  );
});
