/**
 * HandoverDocumentBuilder 交接文档编排器（EAG-P3 批次 11 Part B2 §7.5）
 *
 * 本模块实现 HandoverDocumentBuilder 类，提供 EAG 方案 §5.11.3 / §5.11.4 PKC L4 交接文档层的
 * 完整编排逻辑——并行调用 7 个 SectionBuilder.build(context)，聚合为 HandoverDocument。
 *
 * 核心职责：
 * - 编排 7 个 SectionBuilder 并行构建章节
 * - 聚合章节为 HandoverDocument
 * - 计算整体置信度（取最低，对齐 §5.11.4 三级置信度）
 * - 生成 Markdown 目录（含 anchor）
 *
 * 设计原则（对齐 Karpathy Simplicity First）：
 * - 无状态：builder 本身不持有运行期状态
 * - 不可变优先：返回的 HandoverDocument 通过 Object.freeze 冻结
 * - 防御性编程：构造函数校验 builder 数量与 order 唯一性
 *
 * 不变式（构造时校验，运行期保证）：
 * - sectionBuilders.length === 7
 * - sectionBuilders[i].order ∈ {1, 2, 3, 4, 5, 6, 7}
 * - sectionBuilders[i].order 互不重复
 * - sectionBuilders[i].sectionId 互不重复
 *
 * @module eag/pkc/l4/handover-doc-builder
 */

import type { ConfidenceLevel, HandoverDocument, HandoverSection, SectionBuilder, SectionBuildContext } from "./types";
import { CONFIDENCE_PRIORITY, HandoverDocumentBuilderError, INFERRED_SECTION_NOTICE, SECTION_COUNT } from "./types";

// ============================================================================
// HandoverDocumentBuilder 类
// ============================================================================

/**
 * HandoverDocumentBuilder：交接文档构建器
 *
 * 职责：
 * - 编排 7 个 SectionBuilder 并行构建章节
 * - 聚合章节为 HandoverDocument
 * - 计算整体置信度（取最低）
 * - 生成目录（Markdown 格式）
 *
 * 使用方式：
 * ```typescript
 * const builder = new HandoverDocumentBuilder([
 *   new ArchitectureSectionBuilder(),
 *   new ModuleMapSectionBuilder(),
 *   new ApiContractSectionBuilder(),
 *   new DataModelSectionBuilder(),
 *   new TestStrategySectionBuilder(),
 *   new RiskDebtSectionBuilder(),
 *   new RunbookSectionBuilder(),
 * ]);
 * const doc = await builder.build(context, "handover-a1b2c3d4", "a1b2c3d4e5f6");
 * console.log(doc.overallConfidence); // "inferred"（取最低）
 * console.log(Object.isFrozen(doc)); // true
 * ```
 */
export class HandoverDocumentBuilder {
  /**
   * 7 个 SectionBuilder 实例（不可变，构造时确定）
   *
   * 通过 Object.freeze 冻结内部数组，防止运行期被篡改。
   */
  private readonly sectionBuilders: ReadonlyArray<SectionBuilder>;

  /**
   * 构造函数（含不变式校验）
   *
   * 校验规则：
   * 1. sectionBuilders.length === 7（对齐 §7.4 七章结构）
   * 2. sectionBuilders[i].order ∈ {1, 2, 3, 4, 5, 6, 7}
   * 3. sectionBuilders[i].order 互不重复
   * 4. sectionBuilders[i].sectionId 互不重复
   *
   * @param sectionBuilders 7 个 SectionBuilder 实例
   * @throws {HandoverDocumentBuilderError} 任一不变式违反时抛出
   */
  constructor(sectionBuilders: ReadonlyArray<SectionBuilder>) {
    // 校验数量
    if (sectionBuilders.length !== SECTION_COUNT) {
      throw new HandoverDocumentBuilderError(
        "invalid-builder-count",
        `交接文档必须包含 ${SECTION_COUNT} 个章节，实际 ${sectionBuilders.length} 个`
      );
    }

    // 校验 order 范围与唯一性
    const seenOrders = new Set<number>();
    const seenIds = new Set<string>();
    for (const builder of sectionBuilders) {
      // 校验 order 范围（1~7 整数）
      if (
        typeof builder.order !== "number" ||
        !Number.isInteger(builder.order) ||
        builder.order < 1 ||
        builder.order > SECTION_COUNT
      ) {
        throw new HandoverDocumentBuilderError(
          "invalid-section-order",
          `SectionBuilder.order 非法（必须为 1~${SECTION_COUNT} 整数）：${String(builder.order)}（sectionId=${builder.sectionId}）`
        );
      }
      // 校验 order 唯一性
      if (seenOrders.has(builder.order)) {
        throw new HandoverDocumentBuilderError(
          "duplicate-section-order",
          `SectionBuilder.order 重复：${builder.order}（sectionId=${builder.sectionId}）`
        );
      }
      seenOrders.add(builder.order);
      // 校验 sectionId 唯一性
      if (seenIds.has(builder.sectionId)) {
        throw new HandoverDocumentBuilderError(
          "duplicate-section-id",
          `SectionBuilder.sectionId 重复：${builder.sectionId}`
        );
      }
      seenIds.add(builder.sectionId);
    }

    // 冻结内部数组（浅冻结，元素本身不可变性由 SectionBuilder 实现保证）
    this.sectionBuilders = Object.freeze([...sectionBuilders]);
  }

  /**
   * 构建交接文档
   *
   * 算法：
   * 1. 并行调用 7 个 SectionBuilder.build(context)（Promise.all），每个调用独立 try/catch
   *    隔离异常——单 SectionBuilder 抛异常时返回降级章节（confidence="inferred"，
   *    content 含 INFERRED_SECTION_NOTICE 提示 + 错误信息），不影响其他章节构建
   * 2. 按 order 排序章节
   * 3. 计算整体置信度（取最低，使用 calculateOverallConfidence）
   * 4. 生成 Markdown 目录（使用 generateTableOfContents）
   * 5. 返回 Object.freeze 冻结的 HandoverDocument
   *
   * 错误隔离策略（架构师审查 B2-M1 修复，对齐 B1 ComplianceEngine 错误隔离策略）：
   * - 原 Promise.all 直接 map(builder.build) 任一抛异常会 reject 整个 Promise.all，
   *   导致整个交接文档构建失败
   * - 修复后：在 map 内部用 async + try/catch 包裹 builder.build，
   *   单章节失败时返回降级章节（confidence="inferred"，sources=[]），
   *   保证文档仍可生成（其他章节正常）+ 标注失败章节需人工审核
   *
   * @param context 章节构建上下文（含 fileMap / projectRoot / runId / PKC 数据等）
   * @param documentId 文档 ID（如 "handover-a1b2c3d4"）
   * @param runId run-id（追溯 RunState）
   * @returns 冻结的 HandoverDocument（任一章节失败时该章节为降级 inferred 章节）
   */
  async build(context: SectionBuildContext, documentId: string, runId: string): Promise<Readonly<HandoverDocument>> {
    // 1. 并行构建 7 个章节（每个 builder 独立 try/catch 错误隔离——B2-M1 修复）
    //    单 builder.build 抛异常时返回降级章节（confidence="inferred"），不影响其他章节
    const sections = await Promise.all(
      this.sectionBuilders.map(async (builder) => {
        try {
          return await builder.build(context);
        } catch (e) {
          // 异常对象归一化为 Error 实例（避免 throw 非错误对象时丢失 message）
          const error: Error = e instanceof Error ? e : new Error(String(e));
          // 构造降级章节：confidence="inferred"，content 含 INFERRED_SECTION_NOTICE 提示 + 错误信息
          // 满足 HandoverSection 接口约束（sectionId / title / order / confidence / content / sources）
          // sources 为空数组（失败章节无可靠引用源）
          return Object.freeze({
            sectionId: builder.sectionId,
            title: builder.title,
            order: builder.order,
            confidence: "inferred" as const,
            content: INFERRED_SECTION_NOTICE + `## ${builder.title}\n\n> ⚠️ 章节构建失败：${error.message}\n`,
            sources: Object.freeze([] as string[]),
          }) as HandoverSection;
        }
      })
    );

    // 2. 按 order 排序（防御性排序——构造函数已保证 order 唯一，但 Promise.all 返回顺序与
    //    sectionBuilders 顺序一致，理论上已是 order 顺序，此处仍显式排序以保证健壮性）
    const sortedSections = [...sections].sort((a, b) => a.order - b.order);

    // 3. 计算整体置信度（取最低）
    const overallConfidence = this.calculateOverallConfidence(sortedSections);

    // 4. 生成 Markdown 目录
    const tableOfContents = this.generateTableOfContents(sortedSections);

    // 5. 深度冻结章节与文档（Object.isFrozen === true）
    const frozenSections = Object.freeze(
      sortedSections.map((s) =>
        Object.freeze({
          ...s,
          sources: Object.freeze([...s.sources]),
        })
      )
    );

    return Object.freeze({
      documentId,
      projectRoot: context.projectRoot,
      generatedAt: new Date().toISOString(),
      runId,
      sections: frozenSections,
      overallConfidence,
      tableOfContents,
    });
  }

  /**
   * 计算整体置信度（取所有章节中最低的）
   *
   * 排序规则：inferred < documented < verified
   *
   * 实现说明（架构师审查 B2-M7 修复）：
   * - 初始值使用 `sections[0].confidence`（首个章节的置信度），而非误导性的 "verified"
   * - 构造函数已校验 sectionBuilders.length === 7，故 sections 必非空
   * - 若章节置信度全为 verified，reduce 会正确返回 verified
   * - 若首章为 inferred，后续章节无论置信度多高都会保留 inferred
   * - 空数组防御（虽构造函数已校验非空，仍保留防御性编程）返回 "inferred"
   *
   * @param sections 章节列表（已按 order 排序）
   * @returns 最低置信度
   */
  private calculateOverallConfidence(sections: ReadonlyArray<HandoverSection>): ConfidenceLevel {
    // 空数组防御（防御性编程，对齐 §7.5 注释）
    if (sections.length === 0) {
      return "inferred";
    }
    // 初始值用首章置信度，避免 "verified" 误导读者
    // 若首章为 inferred，后续章节无论置信度多高都会保留 inferred
    return sections.reduce<ConfidenceLevel>(
      (min, s) => (CONFIDENCE_PRIORITY[s.confidence] < CONFIDENCE_PRIORITY[min] ? s.confidence : min),
      sections[0].confidence
    );
  }

  /**
   * 生成 Markdown 目录
   *
   * 格式（对齐 §7.5 generateTableOfContents）：
   * ```
   * 1. [架构概览](#architecture-overview)
   * 2. [模块地图](#module-map)
   * 3. [API 契约](#api-contract)
   * 4. [数据模型](#data-model)
   * 5. [测试策略](#test-strategy)
   * 6. [风险与技术债](#risks-debt)
   * 7. [运维手册](#runbook)
   * ```
   *
   * @param sections 章节列表（已按 order 排序）
   * @returns Markdown 格式目录字符串
   */
  private generateTableOfContents(sections: ReadonlyArray<HandoverSection>): string {
    return sections.map((s) => `${s.order}. [${s.title}](#${s.sectionId})`).join("\n");
  }
}
