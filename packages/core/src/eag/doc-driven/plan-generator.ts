/**
 * plan.md 生成器实现（EAG-P2 批次 8）
 *
 * 本模块实现 `PlanGenerator` 类，提供 EAG 方案 §5.10.1 三文档契约中 plan.md
 * 的真实生成逻辑。
 *
 * 核心职责：
 * - 接收 PlanGenerationInput（spec.md 内容 + 技术栈 + EDM 域裁剪 + 模块切分 +
 *   接口契约 + 数据迁移 + 风险与回退）
 * - 输出符合 Markdown 格式的 plan.md 字符串
 * - 含 5 个章节：1.实现方案 2.模块切分 3.接口契约 4.数据迁移 5.风险与回退
 *
 * §5.10.1 plan.md 设计要求：
 * - 产出 Loop：CODING Loop 首轮
 * - 内容：实现方案（模块切分/接口契约/数据迁移）+ 风险与回退
 * - 依赖：已批准的 spec.md（前置条件，G-1 门禁强制校验）
 *
 * 设计依据：
 * - EAG 方案 §5.10.1 三文档契约
 * - EAG 方案 §5.12.1 G-1 门禁（plan.md 必须已批准才允许进入 CODING Loop）
 *
 * 不可变优先与副作用说明：
 * - 类方法输入与输出均为不可变数据（readonly + Object.freeze）
 * - 方法本身不依赖外部可变状态，输出由输入决定（输入决定输出）
 * - 例外：renderHeader 中的生成时间戳使用 `new Date().toISOString()`，
 *   这是文档版本审计所必需的元信息，不属于业务逻辑输出。
 *   该时间戳副作用不影响其他方法的可测试性与确定性（可通过注入时间源进一步抽离）。
 *
 * @module eag/doc-driven/plan-generator
 */

import type { DataMigration, InterfaceContract, ModuleSplit, PlanGenerationInput, RiskItem } from "./types";

// ============================================================================
// 异常类型
// ============================================================================

/**
 * plan.md 生成器错误（输入非法时抛出）
 *
 * 包含错误字段与详细信息，便于调用方定位问题。
 */
export class PlanGeneratorError extends Error {
  /**
   * @param field 非法字段名
   * @param reason 非法原因
   */
  constructor(
    public readonly field: string,
    public readonly reason: string
  ) {
    super(`plan.md 生成器错误：字段 ${field} 非法——${reason}`);
    this.name = "PlanGeneratorError";
  }
}

// ============================================================================
// 章节渲染辅助类型
// ============================================================================

/**
 * 接口契约类型中文名映射（用于章节 3 表格展示）
 *
 * 使用 Object.freeze 冻结。
 */
const INTERFACE_TYPE_CHINESE: Readonly<Record<InterfaceContract["type"], string>> = Object.freeze({
  "rest-api": "REST API",
  "service-method": "服务方法",
  "event-handler": "事件处理器",
  job: "定时任务",
});

/**
 * 数据迁移变更类型中文名映射（用于章节 4 表格展示）
 *
 * 使用 Object.freeze 冻结。
 */
const MIGRATION_CHANGE_TYPE_CHINESE: Readonly<Record<DataMigration["changeType"], string>> = Object.freeze({
  "create-table": "建表",
  "add-column": "加列",
  "modify-column": "改列",
  "drop-column": "删列",
  "create-index": "建索引",
  "seed-data": "初始化数据",
});

/**
 * 风险严重性中文名映射（用于章节 5 表格展示）
 *
 * 使用 Object.freeze 冻结。
 */
const RISK_SEVERITY_CHINESE: Readonly<Record<RiskItem["severity"], string>> = Object.freeze({
  high: "高",
  medium: "中",
  low: "低",
});

// ============================================================================
// PlanGenerator 类
// ============================================================================

/**
 * plan.md 生成器（实现 §5.10.1 三文档契约中 plan.md 的生成）
 *
 * 提供真实生成逻辑（禁止 mock）：
 * - generate：接收 PlanGenerationInput，输出符合 Markdown 格式的 plan.md 字符串
 *
 * 输出文档结构（5 章节）：
 * 1. 实现方案（综合 spec.md 摘要 + 技术栈 + 模块切分思路）
 * 2. 模块切分（按聚合/模块对实现方案的切分，含依赖关系与关键文件）
 * 3. 接口契约（模块对外暴露的 API 与服务间接口，含签名/请求/响应/错误码）
 * 4. 数据迁移（schema 变更与数据迁移脚本，含回滚策略）
 * 5. 风险与回退（识别实现方案中的风险并给出回退方案）
 *
 * 文档头部附加 EAG 元信息（生成时间、版本号、文档路径），便于版本审计。
 *
 * 使用方式：
 * ```typescript
 * const generator = new PlanGenerator();
 * const planMd = generator.generate(input);
 * ```
 */
export class PlanGenerator {
  /**
   * 生成 plan.md 字符串
   *
   * 执行流程：
   * 1. 校验入参（specContent/constitutionContent/moduleSplits/interfaceContracts
   *    /dataMigrations/risks/techStack 字段合法性）
   * 2. 渲染文档头部（标题 + 元信息）
   * 3. 渲染章节 1：实现方案
   * 4. 渲染章节 2：模块切分
   * 5. 渲染章节 3：接口契约
   * 6. 渲染章节 4：数据迁移
   * 7. 渲染章节 5：风险与回退
   * 8. 拼接全部章节返回完整 Markdown 字符串
   *
   * @param input plan.md 生成器输入
   * @returns plan.md 字符串（Markdown 格式）
   * @throws {PlanGeneratorError} 任一字段非法时抛出
   */
  generate(input: PlanGenerationInput): string {
    // 校验入参
    this.validateInput(input);

    // 渲染各章节
    const header = this.renderHeader();
    const section1 = this.renderImplementationPlan(input);
    const section2 = this.renderModuleSplits(input.moduleSplits);
    const section3 = this.renderInterfaceContracts(input.interfaceContracts);
    const section4 = this.renderDataMigrations(input.dataMigrations);
    const section5 = this.renderRisks(input.risks);

    // 拼接全部章节
    return [header, section1, section2, section3, section4, section5].join("\n\n").trim() + "\n";
  }

  // ============================ 私有辅助方法 ============================

  /**
   * 校验 PlanGenerationInput 字段合法性
   *
   * @param input 待校验输入
   * @throws {PlanGeneratorError} 任一字段非法时抛出
   */
  private validateInput(input: PlanGenerationInput): void {
    if (typeof input.specContent !== "string" || input.specContent.trim().length === 0) {
      throw new PlanGeneratorError("specContent", "必须为非空字符串");
    }
    if (typeof input.constitutionContent !== "string" || input.constitutionContent.trim().length === 0) {
      throw new PlanGeneratorError("constitutionContent", "必须为非空字符串");
    }
    if (!Array.isArray(input.moduleSplits)) {
      throw new PlanGeneratorError("moduleSplits", "必须为数组");
    }
    if (!Array.isArray(input.interfaceContracts)) {
      throw new PlanGeneratorError("interfaceContracts", "必须为数组");
    }
    if (!Array.isArray(input.dataMigrations)) {
      throw new PlanGeneratorError("dataMigrations", "必须为数组");
    }
    if (!Array.isArray(input.risks)) {
      throw new PlanGeneratorError("risks", "必须为数组");
    }
    if (!Array.isArray(input.techStack)) {
      throw new PlanGeneratorError("techStack", "必须为数组");
    }
    // 校验每个 moduleSplit 的字段
    for (const [idx, ms] of input.moduleSplits.entries()) {
      if (typeof ms.moduleName !== "string" || ms.moduleName.trim().length === 0) {
        throw new PlanGeneratorError(`moduleSplits[${idx}].moduleName`, "必须为非空字符串");
      }
      if (typeof ms.responsibility !== "string" || ms.responsibility.trim().length === 0) {
        throw new PlanGeneratorError(`moduleSplits[${idx}].responsibility`, "必须为非空字符串");
      }
      if (!Array.isArray(ms.dependsOn)) {
        throw new PlanGeneratorError(`moduleSplits[${idx}].dependsOn`, "必须为数组");
      }
      if (!Array.isArray(ms.keyFiles)) {
        throw new PlanGeneratorError(`moduleSplits[${idx}].keyFiles`, "必须为数组");
      }
    }
    // 校验每个 interfaceContract 的字段
    for (const [idx, ic] of input.interfaceContracts.entries()) {
      if (typeof ic.interfaceName !== "string" || ic.interfaceName.trim().length === 0) {
        throw new PlanGeneratorError(`interfaceContracts[${idx}].interfaceName`, "必须为非空字符串");
      }
      if (typeof ic.signature !== "string" || ic.signature.trim().length === 0) {
        throw new PlanGeneratorError(`interfaceContracts[${idx}].signature`, "必须为非空字符串");
      }
      if (typeof ic.description !== "string" || ic.description.trim().length === 0) {
        throw new PlanGeneratorError(`interfaceContracts[${idx}].description`, "必须为非空字符串");
      }
    }
    // 校验每个 dataMigration 的字段
    for (const [idx, dm] of input.dataMigrations.entries()) {
      if (typeof dm.migrationId !== "string" || dm.migrationId.trim().length === 0) {
        throw new PlanGeneratorError(`dataMigrations[${idx}].migrationId`, "必须为非空字符串");
      }
      if (typeof dm.tableName !== "string" || dm.tableName.trim().length === 0) {
        throw new PlanGeneratorError(`dataMigrations[${idx}].tableName`, "必须为非空字符串");
      }
      if (typeof dm.rollbackStrategy !== "string" || dm.rollbackStrategy.trim().length === 0) {
        throw new PlanGeneratorError(`dataMigrations[${idx}].rollbackStrategy`, "必须为非空字符串");
      }
    }
    // 校验每个 risk 的字段
    for (const [idx, r] of input.risks.entries()) {
      if (typeof r.riskId !== "string" || r.riskId.trim().length === 0) {
        throw new PlanGeneratorError(`risks[${idx}].riskId`, "必须为非空字符串");
      }
      if (typeof r.description !== "string" || r.description.trim().length === 0) {
        throw new PlanGeneratorError(`risks[${idx}].description`, "必须为非空字符串");
      }
      if (typeof r.mitigation !== "string" || r.mitigation.trim().length === 0) {
        throw new PlanGeneratorError(`risks[${idx}].mitigation`, "必须为非空字符串");
      }
      if (typeof r.rollbackPlan !== "string" || r.rollbackPlan.trim().length === 0) {
        throw new PlanGeneratorError(`risks[${idx}].rollbackPlan`, "必须为非空字符串");
      }
    }
  }

  /**
   * 渲染文档头部（标题 + 元信息）
   *
   * @returns 头部 Markdown 字符串
   */
  private renderHeader(): string {
    const lines: string[] = [
      "# 实现方案（plan.md）",
      "",
      "<!-- EAG 文档驱动开发 Loop 自动生成（§5.10.1 三文档契约） -->",
      "<!-- 文档状态机：draft → reviewing → approved（G-1 门禁强制校验） -->",
      `<!-- 生成时间：${new Date().toISOString()} -->`,
      `<!-- 文档路径：docs/eag/plan.md -->`,
      "",
    ];
    return lines.join("\n");
  }

  /**
   * 渲染章节 1：实现方案
   *
   * 综合呈现 spec.md 摘要、技术栈锁定清单与模块切分思路。
   *
   * @param input 生成器输入
   * @returns 章节 1 Markdown 字符串
   */
  private renderImplementationPlan(input: PlanGenerationInput): string {
    const lines: string[] = ["## 1. 实现方案", ""];

    // 技术栈锁定清单（来自 spec.md 决策表 + CONSTITUTION 不可协商项）
    lines.push("### 1.1 技术栈锁定清单", "");
    if (input.techStack.length === 0) {
      lines.push("> 无显式技术栈声明（从 spec.md 与 CONSTITUTION 提取）。", "");
    } else {
      for (const tech of input.techStack) {
        lines.push(`- ${tech}`);
      }
      lines.push("");
    }

    // spec.md 摘要（提取前 500 字符作为方案上下文）
    lines.push("### 1.2 spec.md 摘要", "");
    const specSummary = input.specContent.length > 500 ? input.specContent.slice(0, 500) + "..." : input.specContent;
    lines.push("```markdown", specSummary, "```", "");

    // CONSTITUTION 不可协商项摘要
    lines.push("### 1.3 CONSTITUTION 不可协商项摘要", "");
    const constitutionSummary =
      input.constitutionContent.length > 500
        ? input.constitutionContent.slice(0, 500) + "..."
        : input.constitutionContent;
    lines.push("```markdown", constitutionSummary, "```", "");

    // 模块切分思路概述
    lines.push("### 1.4 模块切分思路", "");
    if (input.moduleSplits.length === 0) {
      lines.push("> 无模块切分条目。", "");
    } else {
      lines.push(`共切分 ${input.moduleSplits.length} 个模块（详见章节 2）：`, "");
      for (const ms of input.moduleSplits) {
        lines.push(`- **${ms.moduleName}**：${ms.responsibility}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * 渲染章节 2：模块切分
   *
   * @param moduleSplits 模块切分条目列表
   * @returns 章节 2 Markdown 字符串
   */
  private renderModuleSplits(moduleSplits: ReadonlyArray<ModuleSplit>): string {
    const lines: string[] = ["## 2. 模块切分", ""];

    if (moduleSplits.length === 0) {
      lines.push("> 无模块切分条目。", "");
      return lines.join("\n");
    }

    // 使用索引循环避免 O(N²) 复杂度（原 moduleSplits.indexOf(ms) 每次都需线性扫描）
    for (const [idx, ms] of moduleSplits.entries()) {
      lines.push(`### 2.${idx + 1} ${ms.moduleName}`, "");
      lines.push(`- **职责**：${ms.responsibility}`);
      if (ms.dependsOn.length > 0) {
        lines.push(`- **依赖模块**：${ms.dependsOn.join("、")}`);
      } else {
        lines.push("- **依赖模块**：无");
      }
      if (ms.keyFiles.length > 0) {
        lines.push("- **关键文件**：");
        for (const file of ms.keyFiles) {
          lines.push(`  - \`${file}\``);
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * 渲染章节 3：接口契约
   *
   * @param interfaceContracts 接口契约条目列表
   * @returns 章节 3 Markdown 字符串
   */
  private renderInterfaceContracts(interfaceContracts: ReadonlyArray<InterfaceContract>): string {
    const lines: string[] = ["## 3. 接口契约", ""];

    if (interfaceContracts.length === 0) {
      lines.push("> 无接口契约条目。", "");
      return lines.join("\n");
    }

    // 使用索引循环避免 O(N²) 复杂度（原 interfaceContracts.indexOf(ic) 每次都需线性扫描）
    for (const [idx, ic] of interfaceContracts.entries()) {
      const typeChinese = INTERFACE_TYPE_CHINESE[ic.type] ?? ic.type;
      lines.push(`### 3.${idx + 1} ${ic.interfaceName}`, "");
      lines.push(`- **类型**：${typeChinese}`);
      lines.push(`- **签名**：\`${ic.signature}\``);
      lines.push(`- **描述**：${ic.description}`);
      if (ic.requestSchema) {
        lines.push("- **请求 Schema**：");
        lines.push("```json", ic.requestSchema, "```", "");
      }
      if (ic.responseSchema) {
        lines.push("- **响应 Schema**：");
        lines.push("```json", ic.responseSchema, "```", "");
      }
      if (ic.errorCodes.length > 0) {
        lines.push("- **错误码**：");
        for (const code of ic.errorCodes) {
          lines.push(`  - ${code}`);
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * 渲染章节 4：数据迁移
   *
   * @param dataMigrations 数据迁移条目列表
   * @returns 章节 4 Markdown 字符串
   */
  private renderDataMigrations(dataMigrations: ReadonlyArray<DataMigration>): string {
    const lines: string[] = ["## 4. 数据迁移", ""];

    if (dataMigrations.length === 0) {
      lines.push("> 无数据迁移条目。", "");
      return lines.join("\n");
    }

    // 表格形式呈现迁移清单
    lines.push("| 迁移 ID | 变更类型 | 表名 | 描述 | 回滚策略 |");
    lines.push("|---------|---------|------|------|---------|");
    for (const dm of dataMigrations) {
      const changeTypeChinese = MIGRATION_CHANGE_TYPE_CHINESE[dm.changeType] ?? dm.changeType;
      lines.push(
        `| ${dm.migrationId} | ${changeTypeChinese} | ${dm.tableName} | ${dm.description} | ${dm.rollbackStrategy} |`
      );
    }
    lines.push("");

    // 详细回滚策略
    lines.push("### 4.1 详细迁移说明", "");
    for (const dm of dataMigrations) {
      const changeTypeChinese = MIGRATION_CHANGE_TYPE_CHINESE[dm.changeType] ?? dm.changeType;
      lines.push(`#### ${dm.migrationId}`);
      lines.push("");
      lines.push(`- **变更类型**：${changeTypeChinese}`);
      lines.push(`- **表名**：${dm.tableName}`);
      lines.push(`- **描述**：${dm.description}`);
      lines.push(`- **回滚策略**：${dm.rollbackStrategy}`);
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * 渲染章节 5：风险与回退
   *
   * @param risks 风险与回退条目列表
   * @returns 章节 5 Markdown 字符串
   */
  private renderRisks(risks: ReadonlyArray<RiskItem>): string {
    const lines: string[] = ["## 5. 风险与回退", ""];

    if (risks.length === 0) {
      lines.push("> 无风险与回退条目。", "");
      return lines.join("\n");
    }

    // 表格形式呈现风险清单
    lines.push("| 风险 ID | 严重性 | 描述 | 缓解措施 | 回退方案 |");
    lines.push("|---------|--------|------|---------|---------|");
    for (const r of risks) {
      const severityChinese = RISK_SEVERITY_CHINESE[r.severity] ?? r.severity;
      lines.push(`| ${r.riskId} | ${severityChinese} | ${r.description} | ${r.mitigation} | ${r.rollbackPlan} |`);
    }
    lines.push("");

    // 详细风险说明
    lines.push("### 5.1 详细风险说明", "");
    for (const r of risks) {
      const severityChinese = RISK_SEVERITY_CHINESE[r.severity] ?? r.severity;
      lines.push(`#### ${r.riskId}（${severityChinese}）`);
      lines.push("");
      lines.push(`- **描述**：${r.description}`);
      lines.push(`- **缓解措施**：${r.mitigation}`);
      lines.push(`- **回退方案**：${r.rollbackPlan}`);
      lines.push("");
    }

    return lines.join("\n");
  }
}
