/**
 * DESIGN Loop 文档 schema 定义与渲染器（EAG-P1 批次 3）
 *
 * 本模块定义 ARCHITECTURE.md 和 DOMAIN-MODEL.md 的固定章节结构，
 * 并提供将 ArchitectureDocument / DomainModelDocument 渲染为 Markdown 字符串的渲染器，
 * 以及校验渲染结果是否包含全部章节的校验器。
 *
 * 设计依据：
 * - EAG 方案 §5.2.2 产出物：ARCHITECTURE.md（范式+分层+依赖规则）+ DOMAIN-MODEL.md（聚合/实体/值对象/领域事件）
 * - 文档章节结构对齐方案表格与 §5.3 架构师角色唤起知识（范式库+反模式）
 *
 * 章节结构（不可变）：
 * - ARCHITECTURE_MD_SECTIONS：5 章（范式选择/限界上下文/分层架构/依赖规则/技术选型）
 * - DOMAIN_MODEL_MD_SECTIONS：4 章（聚合清单/实体清单/值对象清单/领域事件清单）
 *
 * 渲染规则：
 * - 每章以 Markdown H2（##）开头
 * - 章节内容按结构化数据展开，每条记录为列表项或子标题
 * - 渲染结果用于持久化到 docs/eag/design/ARCHITECTURE.md 与 DOMAIN-MODEL.md
 *
 * 不可变优先原则：
 * - 章节常量使用 ReadonlyArray<string> + Object.freeze 冻结
 * - 渲染函数为纯函数，无副作用
 *
 * @module eag/design/artifacts-schema
 */

import type { ArchitectureDocument, DomainModelDocument, AttributeDefinition } from "./design-models";

// ============================================================================
// 章节结构定义（不可变常量）
// ============================================================================

/**
 * ARCHITECTURE.md 章节结构（5 章）
 *
 * 对应 EAG 方案 §5.2.2 产出物 ARCHITECTURE.md 的固定章节模板：
 * 1. 范式选择：选中范式 ID + 选择理由 + 信号证据
 * 2. 限界上下文：上下文名称 + 职责 + 聚合清单
 * 3. 分层架构：层名 + 职责 + 允许依赖
 * 4. 依赖规则：规则 ID + 描述 + 源层 + 禁止目标层 + 严重级别
 * 5. 技术选型（引用 ETSB 决策表）：本批次仅生成章节占位，实际内容由 ETSB 模块填充
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改章节结构。
 */
export const ARCHITECTURE_MD_SECTIONS: ReadonlyArray<string> = Object.freeze([
  "1. 范式选择",
  "2. 限界上下文",
  "3. 分层架构",
  "4. 依赖规则",
  "5. 技术选型（引用 ETSB 决策表）",
]);

/**
 * DOMAIN-MODEL.md 章节结构（4 章）
 *
 * 对应 EAG 方案 §5.2.2 产出物 DOMAIN-MODEL.md 的固定章节模板：
 * 1. 聚合清单：聚合名 + 聚合根 + 不变式 + 内部实体 + 值对象 + 发布事件
 * 2. 实体清单：实体名 + 所属聚合 + 属性 + 行为
 * 3. 值对象清单：值对象名 + 属性 + 不可变性保证
 * 4. 领域事件清单：事件名 + 发布者 + 订阅者 + 负载
 *
 * 使用 Object.freeze 冻结。
 */
export const DOMAIN_MODEL_MD_SECTIONS: ReadonlyArray<string> = Object.freeze([
  "1. 聚合清单",
  "2. 实体清单",
  "3. 值对象清单",
  "4. 领域事件清单",
]);

// ============================================================================
// 渲染器：ArchitectureDocument → ARCHITECTURE.md
// ============================================================================

/**
 * 将属性列表渲染为 Markdown 字符串
 *
 * 渲染格式：
 *   - name (type, 必填/可选)
 *
 * @param attrs 属性列表
 * @param indent 缩进前缀（如 "  "）
 * @returns 渲染后的 Markdown 列表项字符串（多行）
 */
function renderAttributes(attrs: ReadonlyArray<AttributeDefinition>, indent: string): string {
  if (attrs.length === 0) {
    return `${indent}- （无属性）\n`;
  }
  return attrs.map((a) => `${indent}- ${a.name} (${a.type}, ${a.required ? "必填" : "可选"})`).join("\n") + "\n";
}

/**
 * 将 ArchitectureDocument 渲染为 ARCHITECTURE.md 字符串
 *
 * 渲染规则：
 * - 顶部 H1 标题："ARCHITECTURE.md"
 * - 章节 1（范式选择）：H2 标题 + 范式 ID + 选择理由 + 信号证据
 * - 章节 2（限界上下文）：H2 标题 + 每个上下文为 H3 + 职责 + 聚合清单
 * - 章节 3（分层架构）：H2 标题 + 每层为列表项 + 职责 + 允许依赖
 * - 章节 4（依赖规则）：H2 标题 + 每条规则为列表项 + ID + 描述 + 源层 + 禁止目标层 + 级别
 * - 章节 5（技术选型）：H2 标题 + 占位说明（本批次不渲染 ETSB 决策表内容）
 *
 * @param doc 架构设计文档
 * @returns 渲染后的 ARCHITECTURE.md 字符串
 */
export function renderArchitectureMd(doc: ArchitectureDocument): string {
  const lines: string[] = [];

  // 顶部 H1 标题
  lines.push("# ARCHITECTURE.md");
  lines.push("");
  lines.push("> 由 EAG DESIGN Loop 自动生成，对应 EAG 方案 §5.2.2 产出物。");
  lines.push("");

  // 章节 1：范式选择
  lines.push(`## ${ARCHITECTURE_MD_SECTIONS[0]}`);
  lines.push("");
  lines.push(`- **选中范式**：${doc.selectedParadigmId}`);
  lines.push(`- **选择理由**：${doc.paradigmRationale}`);
  lines.push("- **信号证据**：");
  const evidenceKeys = Object.keys(doc.signalEvidence);
  if (evidenceKeys.length === 0) {
    lines.push("  - （无信号证据，自主选择场景下评估器将打回）");
  } else {
    for (const key of evidenceKeys) {
      lines.push(`  - ${key}: ${doc.signalEvidence[key]}`);
    }
  }
  lines.push("");

  // 章节 2：限界上下文
  lines.push(`## ${ARCHITECTURE_MD_SECTIONS[1]}`);
  lines.push("");
  if (doc.boundedContexts.length === 0) {
    lines.push("- （无限界上下文）");
  } else {
    for (const ctx of doc.boundedContexts) {
      lines.push(`### ${ctx.name}`);
      lines.push(`- **职责**：${ctx.responsibility}`);
      lines.push("- **聚合清单**：");
      if (ctx.aggregates.length === 0) {
        lines.push("  - （无聚合）");
      } else {
        for (const agg of ctx.aggregates) {
          lines.push(`  - ${agg}`);
        }
      }
      lines.push("");
    }
  }

  // 章节 3：分层架构
  lines.push(`## ${ARCHITECTURE_MD_SECTIONS[2]}`);
  lines.push("");
  if (doc.layering.length === 0) {
    lines.push("- （无分层定义）");
  } else {
    for (const layer of doc.layering) {
      lines.push(`- **${layer.name}**：${layer.responsibility}`);
      if (layer.allowedDependencies.length === 0) {
        lines.push(`  - 允许依赖：（无，零外部依赖层）`);
      } else {
        lines.push(`  - 允许依赖：${layer.allowedDependencies.join(", ")}`);
      }
    }
  }
  lines.push("");

  // 章节 4：依赖规则
  lines.push(`## ${ARCHITECTURE_MD_SECTIONS[3]}`);
  lines.push("");
  if (doc.dependencyRules.length === 0) {
    lines.push("- （无依赖规则）");
  } else {
    for (const rule of doc.dependencyRules) {
      lines.push(`- **${rule.id}** [${rule.severity}]：${rule.description}`);
      lines.push(`  - 源层：${rule.fromLayer}`);
      lines.push(`  - 禁止目标层：${rule.forbiddenToLayers.join(", ")}`);
    }
  }
  lines.push("");

  // 章节 5：技术选型（引用 ETSB 决策表）
  lines.push(`## ${ARCHITECTURE_MD_SECTIONS[4]}`);
  lines.push("");
  lines.push("> 本章由 ETSB（企业技术栈蓝图）模块填充，本批次 DESIGN Loop 仅生成章节占位。");
  lines.push("> 实际技术选型决策表（语言/框架/ORM/MQ/Cache 等）由 ETSB 模块在 CODING Loop 启动前注入。");
  lines.push("");

  return lines.join("\n");
}

// ============================================================================
// 渲染器：DomainModelDocument → DOMAIN-MODEL.md
// ============================================================================

/**
 * 将 DomainModelDocument 渲染为 DOMAIN-MODEL.md 字符串
 *
 * 渲染规则：
 * - 顶部 H1 标题："DOMAIN-MODEL.md"
 * - 章节 1（聚合清单）：H2 标题 + 每个聚合为 H3 + 根实体 + 不变式 + 内部实体 + 值对象 + 发布事件
 * - 章节 2（实体清单）：H2 标题 + 每个实体为 H3 + 所属聚合 + 属性 + 行为
 * - 章节 3（值对象清单）：H2 标题 + 每个值对象为 H3 + 属性 + 不可变性保证
 * - 章节 4（领域事件清单）：H2 标题 + 每个事件为 H3 + 发布者 + 订阅者 + 负载
 *
 * @param doc 领域模型文档
 * @returns 渲染后的 DOMAIN-MODEL.md 字符串
 */
export function renderDomainModelMd(doc: DomainModelDocument): string {
  const lines: string[] = [];

  // 顶部 H1 标题
  lines.push("# DOMAIN-MODEL.md");
  lines.push("");
  lines.push("> 由 EAG DESIGN Loop 自动生成，对应 EAG 方案 §5.2.2 产出物。");
  lines.push("");

  // 章节 1：聚合清单
  lines.push(`## ${DOMAIN_MODEL_MD_SECTIONS[0]}`);
  lines.push("");
  if (doc.aggregates.length === 0) {
    lines.push("- （无聚合）");
  } else {
    for (const agg of doc.aggregates) {
      lines.push(`### ${agg.name}`);
      lines.push(`- **聚合根**：${agg.rootEntity}`);
      lines.push("- **不变式**：");
      if (agg.invariants.length === 0) {
        lines.push("  - （无显式不变式）");
      } else {
        for (const inv of agg.invariants) {
          lines.push(`  - ${inv}`);
        }
      }
      lines.push(`- **内部实体**：${agg.containedEntities.length === 0 ? "（无）" : agg.containedEntities.join(", ")}`);
      lines.push(`- **值对象**：${agg.valueObjects.length === 0 ? "（无）" : agg.valueObjects.join(", ")}`);
      lines.push(`- **发布事件**：${agg.publishedEvents.length === 0 ? "（无）" : agg.publishedEvents.join(", ")}`);
      lines.push("");
    }
  }

  // 章节 2：实体清单
  lines.push(`## ${DOMAIN_MODEL_MD_SECTIONS[1]}`);
  lines.push("");
  if (doc.entities.length === 0) {
    lines.push("- （无实体）");
  } else {
    for (const ent of doc.entities) {
      lines.push(`### ${ent.name}`);
      lines.push(`- **所属聚合**：${ent.aggregate}`);
      lines.push("- **属性**：");
      lines.push(renderAttributes(ent.attributes, "  ").trimEnd());
      lines.push("- **行为**：");
      if (ent.behaviors.length === 0) {
        lines.push("  - （无行为，可能命中贫血模型反模式）");
      } else {
        for (const beh of ent.behaviors) {
          lines.push(`  - ${beh.name}: ${beh.description}`);
          if (beh.publishedEvents.length > 0) {
            lines.push(`    - 触发事件：${beh.publishedEvents.join(", ")}`);
          }
        }
      }
      lines.push("");
    }
  }

  // 章节 3：值对象清单
  lines.push(`## ${DOMAIN_MODEL_MD_SECTIONS[2]}`);
  lines.push("");
  if (doc.valueObjects.length === 0) {
    lines.push("- （无值对象）");
  } else {
    for (const vo of doc.valueObjects) {
      lines.push(`### ${vo.name}`);
      lines.push("- **属性**：");
      lines.push(renderAttributes(vo.attributes, "  ").trimEnd());
      lines.push(`- **不可变性保证**：${vo.immutabilityGuarantee}`);
      lines.push("");
    }
  }

  // 章节 4：领域事件清单
  lines.push(`## ${DOMAIN_MODEL_MD_SECTIONS[3]}`);
  lines.push("");
  if (doc.domainEvents.length === 0) {
    lines.push("- （无领域事件）");
  } else {
    for (const evt of doc.domainEvents) {
      lines.push(`### ${evt.name}`);
      lines.push(`- **发布者**：${evt.publisher}`);
      lines.push(`- **订阅者**：${evt.subscribers.length === 0 ? "（无）" : evt.subscribers.join(", ")}`);
      lines.push("- **负载**：");
      lines.push(renderAttributes(evt.payload, "  ").trimEnd());
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ============================================================================
// 校验器：检查渲染的 markdown 是否含全部章节
// ============================================================================

/**
 * 校验 ARCHITECTURE.md 字符串是否包含全部 5 个章节
 *
 * 校验规则：检查 markdown 中是否包含每个章节的 H2 标题（## 1. 范式选择 等）。
 *
 * @param md 渲染后的 ARCHITECTURE.md 字符串
 * @returns 校验结果：valid=true 表示全部章节存在；missingSections 列出缺失章节
 */
export function validateArchitectureMd(md: string): { valid: boolean; missingSections: string[] } {
  const missingSections: string[] = [];
  for (const section of ARCHITECTURE_MD_SECTIONS) {
    // 检查 H2 标题行：## <section>
    const header = `## ${section}`;
    if (!md.includes(header)) {
      missingSections.push(section);
    }
  }
  return {
    valid: missingSections.length === 0,
    missingSections,
  };
}

/**
 * 校验 DOMAIN-MODEL.md 字符串是否包含全部 4 个章节
 *
 * 校验规则：检查 markdown 中是否包含每个章节的 H2 标题（## 1. 聚合清单 等）。
 *
 * @param md 渲染后的 DOMAIN-MODEL.md 字符串
 * @returns 校验结果：valid=true 表示全部章节存在；missingSections 列出缺失章节
 */
export function validateDomainModelMd(md: string): { valid: boolean; missingSections: string[] } {
  const missingSections: string[] = [];
  for (const section of DOMAIN_MODEL_MD_SECTIONS) {
    const header = `## ${section}`;
    if (!md.includes(header)) {
      missingSections.push(section);
    }
  }
  return {
    valid: missingSections.length === 0,
    missingSections,
  };
}
