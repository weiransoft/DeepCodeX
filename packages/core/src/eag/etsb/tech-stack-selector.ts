/**
 * 技术选型决策器（Tech Stack Selector）
 *
 * 本模块实现 EAG 方案 §5.6.1 选型决策流程的核心逻辑：
 * - 根据需求信号（并发量/团队栈存量/部署环境/合规要求）从矩阵推导决策表
 * - 每层默认选 priority=1 的首选方案
 * - 基于信号调整特定层的首选（如 concurrency=high → message-queue 选 Kafka）
 * - 生成选型理由（基于信号 + 矩阵内容）
 *
 * 设计依据：
 * - EAG 方案 §5.6.1 选型决策流程（需求信号 → 矩阵候选过滤 → 决策表）
 * - 纯规则匹配，不依赖 LLM（确保选型可解释、可审计、可重放）
 *
 * 信号调整规则（真实实现，非 mock）：
 * 1. **teamStackLegacy 覆盖**：若提供 teamStackLegacy 且与 input.language 不同，
 *    则强制使用 teamStackLegacy 作为实际语言（团队存量栈优先级高于临时指定）
 * 2. **concurrency=high → message-queue 选 Kafka**：高并发场景下优先选 Kafka
 *    （如该语言的 message-queue 选项中包含 Kafka，则选中 Kafka；否则保持首选）
 * 3. **compliance=strict → auth 选企业级方案**：严格合规场景下优先选企业级认证方案
 *    （如 Spring Security + OAuth2 / Casdoor 等企业级方案；若无企业级备选则保持首选）
 * 4. **deployEnv=cloud-native**：部署环境为云原生时，在决策表生成时记录信号
 *    （蓝图选择由 deployment-blueprints.ts 的 selectDeploymentBlueprint 处理）
 *
 * 输出 TechStackDecisionTable：
 * - language：实际使用的主语言（可能被 teamStackLegacy 覆盖）
 * - decisions：10 层各一条决策（含 selectedOption / reason / alternatives / risks）
 * - humanConfirmed：固定为 false（待 HUMAN_CHECKPOINT 用户确认）
 *
 * @module eag/etsb/tech-stack-selector
 */

import type {
  TechLanguage,
  TechLayer,
  TechStackMatrix,
  TechStackOption,
  TechStackDecision,
  TechStackDecisionTable,
  TechStackSelectionInput,
} from "./types";
import { TECH_LAYERS } from "./types";
import { TECH_STACK_MATRIX } from "./tech-stack-registry";

// ============================================================================
// 内部可变类型（用于决策表构建过程中的临时操作）
// ============================================================================

/**
 * 可变决策对象（构建过程中使用，最终转换为 readonly TechStackDecision）
 *
 * 由于 TechStackDecision 的字段全部 readonly，在 adjustForSignals 阶段
 * 需要替换 selectedOption，故使用可变内部类型，最终构建为不可变对象。
 */
interface MutableTechStackDecision {
  layer: TechLayer;
  selectedOption: TechStackOption;
  reason: string;
  alternatives: TechStackOption[];
  risks: string[];
}

// ============================================================================
// TechStackSelector 类
// ============================================================================

/**
 * 技术选型决策器（纯规则匹配，不依赖 LLM）
 *
 * 提供真实选型逻辑（禁止 mock）：
 * - 主入口 select(input)：根据输入信号生成决策表
 * - 信号调整 adjustForSignals：基于 concurrency/teamStackLegacy/compliance 调整首选
 * - 理由生成 generateReason：基于信号 + 矩阵内容生成中文选型理由
 * - 风险生成 generateRisks：基于层 + 选中方案生成风险清单
 *
 * 使用方式：
 * ```typescript
 * const selector = new TechStackSelector();
 * const decisionTable = selector.select({
 *   language: "typescript",
 *   concurrency: "high",
 *   compliance: "strict",
 * });
 * ```
 */
export class TechStackSelector {
  /**
   * 技术选型矩阵（构造时注入，默认使用 TECH_STACK_MATRIX）
   *
   * 通过依赖注入支持测试时传入自定义矩阵（如测试信号调整规则时使用最小矩阵）。
   */
  private readonly matrix: Readonly<TechStackMatrix>;

  /**
   * @param matrix 技术选型矩阵（默认使用 TECH_STACK_MATRIX 全局常量）
   */
  constructor(matrix: Readonly<TechStackMatrix> = TECH_STACK_MATRIX) {
    this.matrix = matrix;
  }

  /**
   * 主入口：根据输入信号生成决策表
   *
   * 执行流程：
   * 1. 解析实际语言（teamStackLegacy 优先级高于 input.language）
   * 2. 遍历 10 层，每层选 priority=1 的首选方案，构建初始决策
   * 3. 调用 adjustForSignals 基于信号调整特定层的首选
   * 4. 为每层生成选型理由与风险清单
   * 5. 转换为不可变 TechStackDecisionTable 并返回
   *
   * @param input 选型输入信号（language 必填，其他信号可选）
   * @returns 完整决策表（10 层各一条决策，humanConfirmed=false）
   */
  select(input: TechStackSelectionInput): TechStackDecisionTable {
    // 步骤 1：解析实际语言（teamStackLegacy 覆盖 input.language）
    const actualLanguage = this.resolveActualLanguage(input);

    // 步骤 2：构建初始决策（每层选 priority=1 的首选）
    const mutableDecisions: MutableTechStackDecision[] = [];
    for (const layer of TECH_LAYERS) {
      const options = this.matrix.cells[actualLanguage][layer];
      const selectedOption = this.selectPriorityOne(options);
      const alternatives = options.filter((opt) => opt !== selectedOption);
      mutableDecisions.push({
        layer,
        selectedOption,
        reason: "", // 理由在 adjustForSignals 后生成（含信号调整信息）
        alternatives,
        risks: [],
      });
    }

    // 步骤 3：基于信号调整特定层的首选
    this.adjustForSignals(mutableDecisions, input, actualLanguage);

    // 步骤 4：为每层生成选型理由与风险清单
    for (const decision of mutableDecisions) {
      decision.reason = this.generateReason(decision.layer, decision.selectedOption, input, actualLanguage);
      decision.risks = this.generateRisks(decision.layer, decision.selectedOption, actualLanguage);
    }

    // 步骤 5：转换为不可变 TechStackDecisionTable
    const decisions: ReadonlyArray<TechStackDecision> = Object.freeze(
      mutableDecisions.map((d) =>
        Object.freeze({
          layer: d.layer,
          selectedOption: d.selectedOption,
          reason: d.reason,
          alternatives: Object.freeze(d.alternatives),
          risks: Object.freeze(d.risks),
        })
      )
    );

    return Object.freeze({
      language: actualLanguage,
      decisions,
      humanConfirmed: false,
    });
  }

  // ============================ 私有辅助方法 ============================

  /**
   * 解析实际使用的主语言
   *
   * 信号调整规则：teamStackLegacy 覆盖 input.language
   * - 若 input.teamStackLegacy 提供且与 input.language 不同，则使用 teamStackLegacy
   *   （团队存量栈优先级高于临时指定，对齐"团队栈存量"信号语义）
   * - 否则使用 input.language
   *
   * @param input 选型输入信号
   * @returns 实际使用的主语言
   */
  private resolveActualLanguage(input: TechStackSelectionInput): TechLanguage {
    if (input.teamStackLegacy !== undefined && input.teamStackLegacy !== input.language) {
      return input.teamStackLegacy;
    }
    return input.language;
  }

  /**
   * 从选项列表中选择 priority=1 的首选方案
   *
   * 矩阵中每个单元格的 options 按 priority 升序排列，priority=1 为首选。
   * 若无 priority=1 的选项（理论不应发生，矩阵保证每个单元格至少 1 个选项），
   * 取第一个选项作为兜底。
   *
   * @param options 选项列表（按 priority 升序）
   * @returns 首选方案（priority=1 或第一个）
   */
  private selectPriorityOne(options: ReadonlyArray<TechStackOption>): TechStackOption {
    // 优先选 priority=1 的选项
    for (const opt of options) {
      if (opt.priority === 1) {
        return opt;
      }
    }
    // 兜底：取第一个（矩阵保证每个单元格至少 1 个选项）
    return options[0];
  }

  /**
   * 根据信号调整特定层的首选方案
   *
   * 信号调整规则（真实实现，非 mock）：
   * 1. **concurrency=high → message-queue 选 Kafka**：
   *    - 遍历 message-queue 层的选项，若包含名称含 "Kafka" 的选项，则选中它
   *    - 同步更新 alternatives（原首选移入备选，Kafka 从备选移除）
   *    - 若不含 Kafka 则保持首选（如 Go 系 Kafka 已是首选则无变化）
   * 2. **compliance=strict → auth 选企业级方案**：
   *    - 遍历 auth 层的选项，若存在 priority > 1 的备选（企业级方案通常为备选），
   *      且名称含 "Spring Security" / "Casdoor" / "OAuth2" 等企业级关键词，则选中它
   *    - 同步更新 alternatives
   *    - 若无企业级备选则保持首选
   * 3. **deployEnv=cloud-native**：
   *    - 不直接调整技术选型（蓝图选择由 deployment-blueprints.ts 处理）
   *    - 信号通过 generateReason 体现在选型理由中
   *
   * @param decisions 可变决策列表（按 TECH_LAYERS 顺序）
   * @param input 选型输入信号
   * @param actualLanguage 实际使用的主语言（已解析 teamStackLegacy 覆盖）
   */
  private adjustForSignals(
    decisions: MutableTechStackDecision[],
    input: TechStackSelectionInput,
    actualLanguage: TechLanguage
  ): void {
    // 信号 1：concurrency=high → message-queue 选 Kafka
    if (input.concurrency === "high") {
      const mqDecision = decisions.find((d) => d.layer === "message-queue");
      if (mqDecision) {
        const allOptions = this.matrix.cells[actualLanguage]["message-queue"];
        const kafkaOption = allOptions.find((opt) => opt.name.includes("Kafka"));
        if (kafkaOption && kafkaOption !== mqDecision.selectedOption) {
          // 替换首选：原首选移入备选，Kafka 从备选移除
          const oldSelected = mqDecision.selectedOption;
          mqDecision.selectedOption = kafkaOption;
          mqDecision.alternatives = allOptions.filter((opt) => opt !== kafkaOption && opt !== oldSelected);
          // 将原首选插入备选列表头部（按 priority 排序）
          mqDecision.alternatives.unshift(oldSelected);
          // 按 priority 排序备选
          mqDecision.alternatives.sort((a, b) => a.priority - b.priority);
        }
      }
    }

    // 信号 2：compliance=strict → auth 选企业级方案
    if (input.compliance === "strict") {
      const authDecision = decisions.find((d) => d.layer === "auth");
      if (authDecision) {
        const allOptions = this.matrix.cells[actualLanguage]["auth"];
        // 查找企业级方案（名称含 Spring Security / Casdoor / OAuth2 等关键词）
        const enterpriseKeywords = ["Spring Security", "Casdoor", "OAuth2", "OAuth"];
        const enterpriseOption = allOptions.find((opt) => enterpriseKeywords.some((kw) => opt.name.includes(kw)));
        // 仅当企业级方案存在且不是当前首选时才替换
        if (enterpriseOption && enterpriseOption !== authDecision.selectedOption) {
          const oldSelected = authDecision.selectedOption;
          authDecision.selectedOption = enterpriseOption;
          authDecision.alternatives = allOptions.filter((opt) => opt !== enterpriseOption && opt !== oldSelected);
          authDecision.alternatives.unshift(oldSelected);
          authDecision.alternatives.sort((a, b) => a.priority - b.priority);
        }
      }
    }

    // 信号 3：deployEnv=cloud-native
    // 不直接调整技术选型，蓝图选择由 selectDeploymentBlueprint 处理
    // 此处仅记录信号，选型理由由 generateReason 体现
  }

  /**
   * 生成选型理由（基于信号 + 矩阵内容）
   *
   * 理由模板：
   * - 基础理由："<层中文名> 选用 <方案名>（优先级 <priority>）"
   * - 信号增强：根据信号补充调整理由（如"高并发场景优先选 Kafka"）
   * - 团队栈覆盖：若 teamStackLegacy 覆盖了 input.language，补充覆盖理由
   *
   * @param layer 技术层
   * @param selected 选中方案
   * @param input 选型输入信号
   * @param actualLanguage 实际使用的主语言
   * @returns 中文选型理由
   */
  private generateReason(
    layer: TechLayer,
    selected: TechStackOption,
    input: TechStackSelectionInput,
    actualLanguage: TechLanguage
  ): string {
    const layerName = LAYER_CHINESE_NAMES[layer];
    const parts: string[] = [];

    // 基础理由
    parts.push(`${layerName}选用「${selected.name}」（优先级 ${selected.priority}）`);

    // 备注（如有）
    if (selected.notes) {
      parts.push(`理由：${selected.notes}`);
    }

    // 信号调整理由：concurrency=high + message-queue
    if (input.concurrency === "high" && layer === "message-queue" && selected.name.includes("Kafka")) {
      parts.push("高并发场景（> 1000 QPS）优先选 Kafka，满足高吞吐需求");
    }

    // 信号调整理由：compliance=strict + auth
    if (input.compliance === "strict" && layer === "auth") {
      const enterpriseKeywords = ["Spring Security", "Casdoor", "OAuth2", "OAuth"];
      const isEnterprise = enterpriseKeywords.some((kw) => selected.name.includes(kw));
      if (isEnterprise) {
        parts.push("严格合规场景优先选企业级认证方案，满足审计与合规要求");
      }
    }

    // 团队栈覆盖理由
    if (
      input.teamStackLegacy !== undefined &&
      input.teamStackLegacy !== input.language &&
      actualLanguage === input.teamStackLegacy
    ) {
      parts.push(
        `团队存量栈为 ${input.teamStackLegacy}，覆盖临时指定的 ${input.language}，采用团队熟悉的技术栈降低学习成本`
      );
    }

    // 部署环境信号理由（云原生）
    if (input.deployEnv === "cloud-native") {
      parts.push("部署环境为云原生，建议配合云原生微服务蓝图（API Gateway + 服务发现 + 配置中心 + 链路追踪）");
    }

    return parts.join("；");
  }

  /**
   * 生成风险清单（基于层 + 选中方案）
   *
   * 风险模板（按层 + 方案特征生成）：
   * - 通用风险：每层都有"技术栈锁定后变更需用户显式批准（SEED-06）"
   * - 层特定风险：如 message-queue 选 Kafka 时提示运维复杂度
   * - 方案特定风险：如选 Spring Security 提示学习曲线陡峭
   *
   * @param layer 技术层
   * @param selected 选中方案
   * @param actualLanguage 实际使用的主语言
   * @returns 风险清单（中文）
   */
  private generateRisks(layer: TechLayer, selected: TechStackOption, _actualLanguage: TechLanguage): string[] {
    const risks: string[] = [];

    // 通用风险：SEED-06 锁定
    risks.push("技术栈锁定后任何变更必须用户显式批准（SEED-06 规则）");

    // 层特定风险
    if (layer === "message-queue" && selected.name.includes("Kafka")) {
      risks.push("Kafka 运维复杂度高，需独立集群与专业运维人员");
      risks.push("Kafka 消息语义需根据业务场景选择（at-least-once / exactly-once）");
    }
    if (layer === "message-queue" && selected.name.includes("BullMQ")) {
      risks.push("BullMQ 依赖 Redis，高并发下 Redis 可能成为瓶颈");
    }
    if (layer === "auth" && selected.name.includes("Spring Security")) {
      risks.push("Spring Security 学习曲线陡峭，配置复杂度高");
    }
    if (layer === "auth" && selected.name.includes("Casdoor")) {
      risks.push("Casdoor 需独立部署，增加运维成本");
    }
    if (layer === "backend-framework" && selected.name.includes("NestJS")) {
      risks.push("NestJS 装饰器风格对团队不熟悉时学习成本较高");
    }
    if (layer === "orm" && selected.name.includes("Prisma")) {
      risks.push("Prisma schema 迁移需谨慎管理，生产环境需双人 review");
    }
    if (layer === "orm" && selected.name.includes("MyBatis-Plus")) {
      risks.push("MyBatis-Plus SQL 写在 XML 中，重构时需注意 SQL 与代码的同步");
    }
    if (layer === "frontend" && selected.name.includes("前后端分离")) {
      risks.push("前后端分离架构需配套 API 契约管理（OpenAPI），避免接口漂移");
    }

    return risks;
  }
}

// ============================================================================
// 辅助常量
// ============================================================================

/**
 * 技术层中文名映射（用于生成选型理由）
 *
 * 将字面量联合 TechLayer 映射为中文层名，便于人类阅读。
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
const LAYER_CHINESE_NAMES: Readonly<Record<TechLayer, string>> = Object.freeze({
  frontend: "前端",
  "backend-framework": "后端框架",
  orm: "ORM/数据访问",
  cache: "缓存",
  "message-queue": "消息队列",
  "object-storage": "对象存储",
  search: "搜索",
  "task-scheduler": "任务调度",
  auth: "认证授权",
  "api-contract": "API 契约",
});
