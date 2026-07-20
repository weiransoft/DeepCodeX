/**
 * 销售业务类领域专家（1 个，来源：woagent sales 部门，选择性纳入）
 *
 * 来源文件：/Users/wangwei/workspace/woagent/woagent-app/src/main/resources/builtin-agent-templates.yml
 * 来源行号：3399-3707（sales 部门 4 个角色，选择性纳入 1 个）
 *
 * 专家清单：
 *   1. domain-solution-strategist  方案策略师
 *
 * 剔除原因（3 个）：outbound-strategist / opportunity-coach / sales-engineer
 *                 纯销售执行类，业务 review 价值低于 solution-strategist
 *
 * 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §2.2 销售业务类
 */

import type { DomainExpert } from "../types.js";
import { KARPATHY_PREAMBLE } from "../karpathy-preamble.js";
import type { DomainExpertRegistry } from "../domain-expert-registry.js";

// ============================================================================
// 专家 1：domain-solution-strategist（方案策略师）
// ============================================================================

const SOLUTION_STRATEGIST_PROMPT = `${KARPATHY_PREAMBLE}

# ROLE: Domain Solution Strategist（方案策略师 - 解决方案设计领域专家）

## 你的身份
你是解决方案设计领域专家，专注于需求挖掘、方案设计、提案文档、ROI 展示、技术讲解。
在 review 阶段为团队提供"这个方案对客户的真实价值与说服力"的专业判断。

## 核心职责
- 需求分析挖掘（隐性需求识别 / 决策链分析 / 预算评估）
- 解决方案设计（功能方案 / 实施方案 / 服务方案 / 商务方案）
- 提案文档制作（ executive summary / 技术方案 / 案例佐证 / 风险提示）
- ROI 计算展示（成本节约 / 收入增长 / 效率提升 / 风险降低的量化）
- 技术方案讲解（面向客户的高管 / 技术 / 业务三种话术）

## 思维框架
1. **SPIN 提问法**：Situation / Problem / Implication / Need-payoff
2. **解决方案钻石模型**：客户价值 / 能力匹配 / 差异化 / 可交付性
3. **ROI 三维测算**：财务 ROI / 战略 ROI / 风险 ROI
4. **方案呈现 SCQA**：Situation / Complication / Question / Answer
`;

const solutionStrategistExpert: DomainExpert = {
  expertId: "domain-solution-strategist",
  name: "方案策略师",
  nameEn: "Solution Strategist",
  category: "sales",
  specialty: "解决方案设计",
  description: "解决方案设计与销售提案专家，负责需求挖掘、方案设计、提案文档、ROI 测算、技术讲解",
  systemPromptPrefix: SOLUTION_STRATEGIST_PROMPT,
  systemPromptSuffix: "",
  capabilities: [
    "requirement-mining",
    "solution-design",
    "proposal-documentation",
    "roi-calculation",
    "technical-presentation",
    "spin-questioning",
    "scqa-framework",
    "stakeholder-mapping",
  ],
  skills: ["解决方案设计", "提案写作", "ROI测算", "SPIN", "SCQA", "客户演示", "决策链分析", "高管沟通"],
  keywords: ["方案", "提案", "ROI", "销售", "需求", "解决", "solution", "proposal", "roi", "spin"],
  domainTags: ["解决方案", "销售方案", "客户价值", "提案设计"],
  priority: 7,
  mutex: [],
  dependsOn: [],
  metadata: {
    color: "#4527a0",
    icon: "🎯",
    outputFormat: "markdown",
    enabledByDefault: true,
    source: "woagent",
    sourceRef: "builtin-agent-templates.yml:sales:solution-strategist",
    version: "1.0.0",
  },
};

// ============================================================================
// 注册函数：将 1 个销售业务类专家注册到 DomainExpertRegistry
// ============================================================================

/**
 * 注册销售业务类（sales）1 个领域专家（选择性纳入，剔除 3 个纯销售执行类）
 *
 * @param registry 领域专家注册中心
 * @throws {DomainExpertAlreadyRegisteredError} 当 expertId 已注册时
 * @throws {DomainExpertRoleIdCollisionError} 当 expertId 与 RoleId 冲突时
 */
export function register(registry: DomainExpertRegistry): void {
  registry.registerAll([solutionStrategistExpert]);
}

// ============================================================================
// 类型导出（供 index.ts barrel 导出使用）
// ============================================================================

export const salesExperts: ReadonlyArray<DomainExpert> = [solutionStrategistExpert];
