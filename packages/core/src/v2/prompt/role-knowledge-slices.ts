/**
 * EAG-P6 Phase 3 角色 phaseKnowledgeSlice 静态切片表
 *
 * 本模块定义 5 角色 × 4 LoopPhase = 20 个静态知识切片，供 RolePromptCustomizer
 * 在运行时按 (role, phase) 拼接注入到角色 prompt 的 [PHASE_KNOWLEDGE_SLICE] 段。
 *
 * 设计依据：
 * - EAG-P6-REQUIREMENTS.md §2 US-2（AC-2.1~AC-2.5：五段式 prompt + phaseKnowledgeSlice
 *   按阶段动态拼接 + skill 融合关键内容）
 * - EAG-P6-ARCHITECTURE.md §5.2 接口契约 3（RolePromptCustomizer）
 *   + §4 模块清单（phaseKnowledgeSlice 静态化 + 运行时拼接）
 *   + D-4 决策（静态化保证可测试，运行时按阶段动态拼接）
 *   + D-8 决策（5 角色 × 4 阶段 = 20 切片，DevOps 延后 Phase 6）
 * - EAG-P6-TASKS.md §3 TASK-P6-3-04（5 角色 phaseKnowledgeSlice）
 * - EAG-P6-TEST-CASES.md TC-ROLE-001~025（5 角色 skill 融合断言）
 *
 * 角色集合（5 角色，与 multi-agent-team skill v2.7 对齐）：
 * - architect         ：架构师（D-8：DESIGN 阶段注入范式库切片）
 * - product_manager   ：产品经理（bite-sized 任务粒度 + 三级分解）
 * - solo_coder        ：独立开发者（TDD 铁律：NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST）
 * - test_expert       ：测试专家（证据驱动调试法：假设→插桩→复现→分析→修复→验证）
 * - ui_designer       ：UI 设计师（反 AI-slop + 禁用字体清单 + Bold aesthetic direction）
 *
 * LoopPhase 集合（4 阶段，与用户任务描述对齐）：
 * - design   ：架构设计阶段（架构师主导，输出 ADR + 接口定义）
 * - coding   ：编码实现阶段（Solo Coder 主导，TDD 红→绿→重构）
 * - testing  ：测试验证阶段（Test Expert 主导，证据驱动调试法）
 * - handover ：交付部署阶段（产出 handover 文档 + 部署清单）
 *
 * 注意（LoopPhase 命名差异）：
 * - v2/context/dynamic-window-types.ts 的 LoopPhase 使用 "deploy"
 * - 用户任务描述使用 "handover"（更准确表达"交接+部署"语义）
 * - 本模块定义本地 RolePhase 类型，并提供 toV2LoopPhase() 映射函数
 *   将 "handover" 映射为 v2 的 "deploy"，保证与 Phase 2 DynamicWindowManager 兼容
 *
 * 每切片字段（与 AC-2.2 phaseKnowledgeSlice 字段对齐）：
 * - phaseGoal          ：阶段目标（1-2 句话说明本阶段角色应完成的核心目标）
 * - keyChecks          ：关键检查项（数组，每项一条具体可验证的检查点）
 * - commonPitfalls     ：常见陷阱（数组，每项一条常见错误与规避方法）
 * - outputFormat       ：输出格式约束（string，明确产出文档/代码格式）
 * - historicalExperience：历史经验提示（string，沉淀历史成功模式与失败教训）
 *
 * skill 融合关键内容（AC-2.5，每个角色至少一条标志性字符串）：
 * - architect         ：含 "四步分析框架"（架构风格识别→核心组件→技术栈→扩展性评估）
 * - product_manager   ：含 "bite-sized" 与 "每步 2-5 分钟可验证"
 * - solo_coder        ：含 "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"
 * - test_expert       ：含 "假设→插桩→复现→分析→修复→验证"
 * - ui_designer       ：含 "反 AI-slop" 与禁用字体清单（Inter/Roboto/Arial/system-ui）
 *
 * 不可变优先原则（对齐 NFR-8）：
 * - 所有字段 readonly + ReadonlyArray + Object.freeze
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层枚举常量使用 Object.freeze 冻结
 *
 * @module v2/prompt/role-knowledge-slices
 */

// ============================================================================
// 1. RoleKind 枚举（5 角色，下划线风格，对齐 multi-agent-team skill）
// ============================================================================

/**
 * 角色 ID 枚举（5 角色，下划线风格）
 *
 * 设计取舍（与 team/types.ts RoleId 的关系）：
 * - team/types.ts 的 RoleId 使用 kebab-case（"architect", "product-manager" 等）
 * - 本模块使用下划线风格（"architect", "product_manager" 等），与
 *   multi-agent-team skill v2.7 的 Python 角色命名一致
 * - 用户任务描述明确使用下划线风格，故以用户任务描述为准
 * - 提供 toTeamRoleId() 映射函数，便于与 team 模块互操作
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type RoleKind = "architect" | "product_manager" | "solo_coder" | "test_expert" | "ui_designer";

/**
 * RoleKind 全部合法值（用于运行时枚举、测试断言、参数校验）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改（NFR-8 不可变优先）。
 */
export const ROLE_KINDS: ReadonlyArray<RoleKind> = Object.freeze([
  "architect",
  "product_manager",
  "solo_coder",
  "test_expert",
  "ui_designer",
]);

// ============================================================================
// 2. RolePhase 枚举（4 阶段，含 handover）
// ============================================================================

/**
 * 角色 Loop 阶段枚举（4 阶段，对齐用户任务描述）
 *
 * 与 v2/context/dynamic-window-types.ts 的 LoopPhase 区别：
 * - v2 LoopPhase：design / coding / testing / deploy
 * - 本模块 RolePhase：design / coding / testing / handover
 *
 * "handover" 比 "deploy" 语义更准确：交接阶段不仅包含部署，还包含
 * 文档交付、知识转移、运维培训等内容。
 *
 * 字面量联合而非 string，避免拼写错误。
 */
export type RolePhase = "design" | "coding" | "testing" | "handover";

/**
 * RolePhase 全部合法值（用于运行时枚举、测试断言、参数校验）
 *
 * 使用 Object.freeze 冻结。
 */
export const ROLE_PHASES: ReadonlyArray<RolePhase> = Object.freeze(["design", "coding", "testing", "handover"]);

// ============================================================================
// 3. PhaseKnowledgeSlice 数据结构
// ============================================================================

/**
 * 阶段知识切片（PhaseKnowledgeSlice）
 *
 * 描述某角色在某 LoopPhase 的阶段目标、关键检查项、常见陷阱、
 * 输出格式约束与历史经验提示。供 RolePromptCustomizer 在运行时
 * 按 (role, phase) 拼接注入到角色 prompt 的 [PHASE_KNOWLEDGE_SLICE] 段。
 *
 * 字段说明：
 * - role：角色 ID（architect / product_manager / solo_coder / test_expert / ui_designer）
 * - phase：Loop 阶段（design / coding / testing / handover）
 * - phaseGoal：阶段目标（1-2 句话说明本阶段角色应完成的核心目标）
 * - keyChecks：关键检查项（数组，每项一条具体可验证的检查点）
 * - commonPitfalls：常见陷阱（数组，每项一条常见错误与规避方法）
 * - outputFormat：输出格式约束（明确产出文档/代码格式）
 * - historicalExperience：历史经验提示（沉淀历史成功模式与失败教训）
 *
 * 不可变优先：所有字段 readonly + ReadonlyArray，构建后通过 Object.freeze 冻结。
 */
export interface PhaseKnowledgeSlice {
  /** 角色 ID（architect / product_manager / solo_coder / test_expert / ui_designer） */
  readonly role: RoleKind;
  /** Loop 阶段（design / coding / testing / handover） */
  readonly phase: RolePhase;
  /** 阶段目标（1-2 句话说明本阶段角色应完成的核心目标） */
  readonly phaseGoal: string;
  /** 关键检查项（数组，每项一条具体可验证的检查点） */
  readonly keyChecks: ReadonlyArray<string>;
  /** 常见陷阱（数组，每项一条常见错误与规避方法） */
  readonly commonPitfalls: ReadonlyArray<string>;
  /** 输出格式约束（明确产出文档/代码格式） */
  readonly outputFormat: string;
  /** 历史经验提示（沉淀历史成功模式与失败教训） */
  readonly historicalExperience: string;
}

// ============================================================================
// 4. Phase ↔ v2 LoopPhase 映射函数
// ============================================================================

/**
 * 将 RolePhase 映射为 v2 LoopPhase（与 Phase 2 DynamicWindowManager 兼容）
 *
 * 映射规则：
 * - design   → design
 * - coding   → coding
 * - testing  → testing
 * - handover → deploy（v2 使用 "deploy"，本模块使用 "handover"）
 *
 * 用途：RolePromptCustomizer 调用 DynamicWindowManager.computeWindow 时，
 * 需将本模块的 RolePhase 转换为 v2 LoopPhase。
 *
 * @param phase 角色 Loop 阶段（含 handover）
 * @returns v2 LoopPhase（含 deploy）
 */
export function toV2LoopPhase(phase: RolePhase): "design" | "coding" | "testing" | "deploy" {
  switch (phase) {
    case "design":
      return "design";
    case "coding":
      return "coding";
    case "testing":
      return "testing";
    case "handover":
      // handover 映射为 v2 的 deploy（语义对齐：交接阶段包含部署）
      return "deploy";
    default: {
      // 防御性处理：未知 phase 抛错（编程错误，不应在运行时发生）
      const exhaustive: never = phase;
      throw new Error(`Unknown RolePhase: ${String(exhaustive)}`);
    }
  }
}

// ============================================================================
// 5. 5 角色 × 4 阶段 = 20 个静态切片定义
// ============================================================================

/**
 * 全部 20 个 phaseKnowledgeSlice（5 角色 × 4 阶段）
 *
 * 顺序：角色优先级降序（architect → product_manager → solo_coder → test_expert → ui_designer）
 * 角色内：按 LoopPhase 顺序（design → coding → testing → handover）
 *
 * 使用 Object.freeze 冻结整个数组与每个切片对象，防止运行期被篡改。
 *
 * skill 融合关键内容（AC-2.5，每个角色至少一条标志性字符串）：
 * - architect         ：含 "四步分析框架"（架构风格识别→核心组件→技术栈→扩展性评估）
 * - product_manager   ：含 "bite-sized" 与 "每步 2-5 分钟可验证"
 * - solo_coder        ：含 "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"
 * - test_expert       ：含 "假设→插桩→复现→分析→修复→验证"
 * - ui_designer       ：含 "反 AI-slop" 与禁用字体清单
 */
export const PHASE_KNOWLEDGE_SLICES: ReadonlyArray<PhaseKnowledgeSlice> = Object.freeze([
  // ========================================================================
  // 角色 1：架构师 (Architect) — 4 个切片
  // ========================================================================

  /**
   * 架构师 · design 阶段切片
   *
   * 设计依据：AC-2.5 架构师 prompt 含"四步分析框架"
   * （架构风格识别→核心组件→技术栈→扩展性评估）
   */
  Object.freeze({
    role: "architect",
    phase: "design",
    phaseGoal:
      "输出可落地、可验证的架构方案，含模块依赖图、ADR、接口定义与风险登记；" +
      "使用四步分析框架（架构风格识别→核心组件→技术栈→扩展性评估）系统化推进。",
    keyChecks: Object.freeze([
      "架构风格识别：明确分层 / 微服务 / 事件驱动 / CQRS 等风格选择与权衡",
      "核心组件识别：每个核心组件有明确职责、接口契约与依赖关系",
      "技术栈选择：3+ 候选方案对比，给出选型理由（YAGNI 优先但考虑扩展点）",
      "扩展性评估：识别性能瓶颈、单点故障、安全风险，给出缓解措施",
      "ADR 完整性：每个关键决策 1 段 ADR（背景/选项/决策/理由）",
      "接口定义：zod schema / TypeScript interface，类型完整可校验",
    ]),
    commonPitfalls: Object.freeze([
      "过度设计：引入未明确需要的抽象层（违反 YAGNI）",
      "技术栈锁定：未提供候选方案对比，直接选定单一技术",
      "接口模糊：接口字段类型为 any / unknown，无法类型校验",
      "风险遗漏：未识别单点故障、安全风险、性能瓶颈",
      "ADR 缺失：关键决策无文档，后续维护者无法理解决策背景",
    ]),
    outputFormat: "Markdown 文档：架构图（Mermaid）+ ADR 列表 + 接口定义（TypeScript）+ 风险登记表",
    historicalExperience:
      "历史成功模式：DDD 分层 + 显式接口契约 + 风险登记表，可维护性高；" +
      "历史失败教训：过度抽象导致上手成本陡增，YAGNI 优先但保留扩展点。",
  } as PhaseKnowledgeSlice),

  /**
   * 架构师 · coding 阶段切片
   *
   * 设计依据：架构师在编码阶段提供红线清单，确保实现不偏离架构
   */
  Object.freeze({
    role: "architect",
    phase: "coding",
    phaseGoal:
      "为 Solo Coder 提供架构红线清单与接口契约守护，确保实现不偏离架构设计；" +
      "审阅 PR 时重点检查跨层调用、循环依赖与契约一致性。",
    keyChecks: Object.freeze([
      "分层契约：领域层不依赖基础设施层，应用服务不直接调用 ORM",
      "接口契约：实现与 design 阶段定义的 TypeScript interface 完全一致",
      "循环依赖：模块依赖图为 DAG，无循环依赖",
      "单点故障：关键服务有降级/熔断/限流策略",
      "性能红线：关键路径有 benchmark 数据，符合 NFR 指标",
      "安全红线：无硬编码密钥，输入经 zod 校验，SQL/命令注入已防护",
    ]),
    commonPitfalls: Object.freeze([
      "实现偏离：Solo Coder 因图省事修改接口签名，破坏契约",
      "跨层调用：UI 层直接调用 Repository，绕过 Application Service",
      "循环依赖：A 依赖 B，B 依赖 A，编译期不报错但运行期崩溃",
      "性能退化：未做 benchmark，上线后才发现 P99 超阈值",
    ]),
    outputFormat: "PR 评审意见（Markdown）：契约一致性检查 + 红线违规清单 + 改进建议",
    historicalExperience:
      "历史成功模式：CI 自动校验接口契约 + 静态分析检测循环依赖；" +
      "历史失败教训：人工 review 漏检跨层调用，导致后期重构成本高昂。",
  } as PhaseKnowledgeSlice),

  /**
   * 架构师 · testing 阶段切片
   *
   * 设计依据：架构师在测试阶段评估测试覆盖与架构风险
   */
  Object.freeze({
    role: "architect",
    phase: "testing",
    phaseGoal:
      "评估测试覆盖是否满足架构质量目标，识别高风险符号与架构薄弱点；" +
      "为 Test Expert 提供风险热点 Top-N 清单（基于 CodeMap DW-3）。",
    keyChecks: Object.freeze([
      "核心组件覆盖率：领域层 / 应用服务层关键组件单元测试覆盖率 ≥ 85%",
      "集成测试：跨模块协作场景有集成测试覆盖",
      "风险热点覆盖：CodeMap DW-3 返回的高 importance 符号必须有测试",
      "契约测试：对外暴露的 API 有契约测试（避免破坏性变更）",
      "性能测试：关键路径有压力测试数据（P50/P95/P99）",
      "故障演练：单点故障有降级/熔断测试",
    ]),
    commonPitfalls: Object.freeze([
      "只测 happy path：忽略边界条件与异常场景",
      "mock 滥用：mock 掉真实依赖，测试通过但生产崩溃",
      "覆盖率虚高：测试用例无断言，覆盖率达标但质量低",
      "性能测试缺位：上线后才发现 QPS 不达标",
    ]),
    outputFormat: "架构风险评估报告（Markdown）：覆盖率分析 + 风险热点清单 + 测试缺口建议",
    historicalExperience:
      "历史成功模式：DW-3 风险热点驱动用例优先级，高风险符号 100% 覆盖；" +
      "历史失败教训：mock 滥用导致集成测试失效，生产环境暴露真实问题。",
  } as PhaseKnowledgeSlice),

  /**
   * 架构师 · handover 阶段切片
   *
   * 设计依据：架构师在交接阶段产出架构 handover 文档与运维清单
   */
  Object.freeze({
    role: "architect",
    phase: "handover",
    phaseGoal:
      "产出架构 handover 文档（含部署拓扑、监控指标、回滚策略）与运维 runbook；" +
      "确保运维团队理解架构决策背景与关键风险点。",
    keyChecks: Object.freeze([
      "部署拓扑图：含服务节点、网络、数据库、缓存、消息队列",
      "监控指标：业务指标（QPS/错误率）+ 系统指标（CPU/内存/磁盘）+ 自定义指标",
      "告警规则：关键指标有告警阈值与通知渠道",
      "回滚策略：蓝绿 / 金丝雀 / 滚动三种策略选型与触发条件",
      "runbook：常见故障排查步骤（5W2H：什么/为什么/谁/何时/何处/如何/多少）",
      "架构决策背景：关键 ADR 摘要，便于运维理解决策原因",
    ]),
    commonPitfalls: Object.freeze([
      "文档过时：架构变更后未同步更新 handover 文档",
      "监控缺失：关键指标未采集，故障发生后才发现",
      "回滚未演练：回滚策略只在文档中，从未实际演练",
      "知识断层：架构师离职后，运维团队无法理解决策背景",
    ]),
    outputFormat: "Handover 文档（Markdown）：部署拓扑 + 监控指标 + 回滚策略 + runbook + ADR 摘要",
    historicalExperience:
      "历史成功模式：handover 文档与代码同步更新，运维自主排查率 ≥ 70%；" +
      "历史失败教训：文档过时导致故障恢复时间翻倍，MTTR 严重超标。",
  } as PhaseKnowledgeSlice),

  // ========================================================================
  // 角色 2：产品经理 (Product Manager) — 4 个切片
  // ========================================================================

  /**
   * 产品经理 · design 阶段切片
   *
   * 设计依据：AC-2.5 PM prompt 含 "bite-sized" 与 "每步 2-5 分钟可验证"
   * + AC-6.1 / AC-6.2 / AC-6.3 / AC-6.4
   */
  Object.freeze({
    role: "product_manager",
    phase: "design",
    phaseGoal:
      "定义用户价值清晰、需求明确、可落地、可验收的产品方案；" +
      "采用 bite-sized 任务粒度（每步 2-5 分钟可验证），用户故事→验收标准→任务卡三级分解。",
    keyChecks: Object.freeze([
      "用户故事：As a / I want / So that 三段式完整，含用户画像",
      "验收标准：每个用户故事至少 3 条可测量验收标准（Given/When/Then）",
      "bite-sized 任务粒度：每步 2-5 分钟可验证，避免大颗粒任务",
      "三级分解：用户故事 → 验收标准 → 任务卡，逐层细化可追踪",
      "PLAN.md 文档头：Goal / Architecture / Tech Stack 三字段必填",
      "可测量成功标准：北极星指标 + 输入指标，每个需求必须可量化",
      "MoSCoW 优先级：Must / Should / Could / Won't 显式标注",
    ]),
    commonPitfalls: Object.freeze([
      "需求模糊：用户故事缺少 So that，无法回答'为谁解决什么问题'",
      "验收标准不可测：'界面美观' / '性能良好' 等无法量化",
      "任务粒度过大：单个任务 > 30 分钟，无法快速验证",
      "缺少优先级：所有任务同等重要，团队无法聚焦",
      "PLAN.md 文档头缺失：Goal / Architecture / Tech Stack 未填写",
    ]),
    outputFormat: "PRD.md（产品需求文档）：用户故事 + 验收标准 + 任务卡 + 成功指标 + PLAN.md 文档头模板",
    historicalExperience:
      "历史成功模式：bite-sized 任务粒度 + 三级分解，需求变更影响范围可控；" +
      "历史失败教训：大颗粒任务导致进度不可见，团队陷入'完成 80% 还需 80%'困境。",
  } as PhaseKnowledgeSlice),

  /**
   * 产品经理 · coding 阶段切片
   *
   * 设计依据：PM 在编码阶段验证实现是否符合需求
   */
  Object.freeze({
    role: "product_manager",
    phase: "coding",
    phaseGoal:
      "验证 Solo Coder 实现的功能是否符合用户故事与验收标准；" + "需求变更时及时更新任务卡，保持需求-代码可追溯。",
    keyChecks: Object.freeze([
      "功能完整性：每个验收标准都有对应代码实现",
      "需求追溯：任务卡 → 代码 commit → 验收标准 三向可追溯",
      "变更管理：需求变更走变更流程，更新任务卡并通知团队",
      "用户视角验证：从用户操作流程验证功能，不只看技术实现",
      "边界场景：异常输入、空数据、并发场景有处理",
    ]),
    commonPitfalls: Object.freeze([
      "需求偏离：实现的功能与用户故事不符，但未被及时发现",
      "变更失控：口头变更未记录，导致测试与文档脱节",
      "技术视角优先：只验证技术正确性，忽略用户体验",
      "边界场景遗漏：happy path 通过，但异常场景崩溃",
    ]),
    outputFormat: "需求验证报告（Markdown）：验收标准检查清单 + 变更记录 + 缺口清单",
    historicalExperience:
      "历史成功模式：需求-代码三向追溯，变更影响范围可视化；" +
      "历史失败教训：口头变更导致测试遗漏，上线后出现回归 bug。",
  } as PhaseKnowledgeSlice),

  /**
   * 产品经理 · testing 阶段切片
   *
   * 设计依据：PM 在测试阶段参与 UAT 与验收
   */
  Object.freeze({
    role: "product_manager",
    phase: "testing",
    phaseGoal:
      "参与用户验收测试（UAT），从业务视角验证功能满足用户故事；" + "为 Test Expert 提供业务场景与验收标准清单。",
    keyChecks: Object.freeze([
      "UAT 场景覆盖：每个用户故事至少 1 个 UAT 场景",
      "验收标准验证：每条验收标准都有对应测试用例",
      "业务流程连贯：端到端业务流程可走通，无断点",
      "用户画像匹配：测试场景覆盖主要用户画像",
      "非功能性需求：性能、安全、可访问性有验收",
    ]),
    commonPitfalls: Object.freeze([
      "UAT 缺位：只做技术测试，未做业务验收",
      "验收标准遗漏：部分验收标准无测试用例",
      "业务流程断裂：单点功能正常，但端到端流程走不通",
      "非功能性忽略：性能/安全/可访问性未纳入验收",
    ]),
    outputFormat: "UAT 报告（Markdown）：场景覆盖矩阵 + 验收标准检查 + 缺陷清单 + 上线建议",
    historicalExperience:
      "历史成功模式：UAT + 验收标准矩阵，上线后业务返工率 < 5%；" +
      "历史失败教训：跳过 UAT 直接上线，业务流程断裂导致紧急回滚。",
  } as PhaseKnowledgeSlice),

  /**
   * 产品经理 · handover 阶段切片
   *
   * 设计依据：PM 在交接阶段产出产品手册与培训材料
   */
  Object.freeze({
    role: "product_manager",
    phase: "handover",
    phaseGoal: "产出产品手册、用户培训材料与运营 runbook；" + "确保运营/客服团队理解产品功能、目标用户与成功指标。",
    keyChecks: Object.freeze([
      "产品手册：功能清单 + 操作指引 + FAQ",
      "用户培训材料：视频 / 文档 / 演示，覆盖主要用户画像",
      "运营 runbook：常见问题处理流程 + 升级机制",
      "成功指标基线：上线前北极星指标基线，便于效果评估",
      "反馈渠道：用户反馈收集机制（工单/问卷/访谈）",
    ]),
    commonPitfalls: Object.freeze([
      "文档缺失：产品手册未及时更新，运营/客服无法答疑",
      "培训缺位：新功能上线未培训，运营团队不了解",
      "指标基线缺失：上线后无法评估效果",
      "反馈渠道断裂：用户反馈无收集机制，问题暴露滞后",
    ]),
    outputFormat: "产品交付包（Markdown + 视频）：产品手册 + 培训材料 + 运营 runbook + 指标基线",
    historicalExperience:
      "历史成功模式：完整交付包 + 培训视频，运营自主答疑率 ≥ 80%；" +
      "历史失败教训：文档缺失导致客服工单堆积，用户满意度下降。",
  } as PhaseKnowledgeSlice),

  // ========================================================================
  // 角色 3：独立开发者 (Solo Coder) — 4 个切片
  // ========================================================================

  /**
   * 独立开发者 · design 阶段切片
   *
   * 设计依据：Solo Coder 在 design 阶段理解架构，准备 TDD 环境
   */
  Object.freeze({
    role: "solo_coder",
    phase: "design",
    phaseGoal:
      "理解架构设计与接口契约，准备 TDD 开发环境；" +
      "为每个接口契约编写失败测试用例（Red 阶段），等待实现使其通过（Green 阶段）。",
    keyChecks: Object.freeze([
      "架构理解：通读 ADR 与接口定义，理解决策背景",
      "TDD 红灯：每个接口契约至少 1 个失败测试用例（Red 阶段）",
      "测试环境：Vitest / pytest / cargo test 等测试框架可运行",
      "CodeMap 熟悉：通过 DW-1 焦点符号直供了解待实现符号上下文",
      "依赖检查：所需依赖已在 package.json / Cargo.toml 中声明",
    ]),
    commonPitfalls: Object.freeze([
      "跳过 TDD：直接写实现，测试后补，违反红绿重构铁律",
      "架构理解偏差：未通读 ADR，实现与架构决策不一致",
      "测试环境未就绪：写完代码才发现测试框架未配置",
      "依赖缺失：实现过程中才发现依赖未安装，打断节奏",
    ]),
    outputFormat: "TDD 红灯测试用例（TypeScript / Python / Rust）+ 开发环境就绪清单",
    historicalExperience:
      "历史成功模式：先写失败测试再写实现，bug 率降低 60%；" +
      "历史失败教训：跳过 TDD 直接实现，回归测试覆盖率不足 40%。",
  } as PhaseKnowledgeSlice),

  /**
   * 独立开发者 · coding 阶段切片
   *
   * 设计依据：AC-2.5 Solo Coder prompt 含
   * "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"（TDD 铁律）
   */
  Object.freeze({
    role: "solo_coder",
    phase: "coding",
    phaseGoal:
      "严格遵循 TDD 红→绿→重构铁律：NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST；" +
      "每次提交 ≤ 200 行，PR 评审更易通过；Surgical Changes，只改必要的代码。",
    keyChecks: Object.freeze([
      "TDD 铁律：NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST（无失败测试不写生产代码）",
      "红灯阶段：先写失败测试，确认测试框架报告失败",
      "绿灯阶段：写最小实现使测试通过，不过度设计",
      "重构阶段：测试通过后重构，消除重复代码与坏味道",
      "小步提交：每次提交 ≤ 200 行，PR 评审更易通过",
      "Surgical Changes：只改必要的代码，不顺手改无关代码",
      "错误处理：每个可能失败的操作必须显式处理（try/catch 或 Result 类型）",
      "CodeMap 上下文：通过 DW-1/DW-2 了解焦点符号与影响面",
    ]),
    commonPitfalls: Object.freeze([
      "测试后补：先写实现再补测试，违反 TDD 铁律",
      "过度设计：预留未来可能用到的抽象（违反 YAGNI）",
      "大颗粒提交：单次提交 > 500 行，PR 评审困难",
      "顺手重构：修改与任务无关的代码，引入意外 bug",
      "空 catch 块：catch (e) {} 吞掉异常，问题难以定位",
    ]),
    outputFormat: "源代码（TypeScript / Python / Rust）+ 单元测试 + 集成测试 + JSDoc 文档",
    historicalExperience:
      "历史成功模式：TDD 红→绿→重构 + 小步提交，bug 率降低 70%；" +
      "历史失败教训：跳过 TDD + 大颗粒提交，PR 评审周期 > 3 天，bug 率上升 200%。",
  } as PhaseKnowledgeSlice),

  /**
   * 独立开发者 · testing 阶段切片
   *
   * 设计依据：Solo Coder 在测试阶段修复 bug，遵循证据驱动
   */
  Object.freeze({
    role: "solo_coder",
    phase: "testing",
    phaseGoal:
      "修复 Test Expert 报告的 bug，每个修复都有对应测试用例验证；" +
      "遵循证据驱动：先复现 bug，再修复，最后验证修复有效。",
    keyChecks: Object.freeze([
      "bug 复现：每个 bug 都有最小重现步骤与失败测试用例",
      "修复验证：修复后失败测试用例通过，且无新测试失败",
      "回归测试：修复未破坏既有功能，全量测试通过",
      "性能验证：修复未引入性能退化（benchmark 对比）",
      "CodeMap 影响面：通过 DW-2 爆炸半径分析修复影响范围",
    ]),
    commonPitfalls: Object.freeze([
      "未复现就修复：猜测 bug 原因直接改代码，修复无效",
      "修复破坏既有功能：未跑回归测试，引入新 bug",
      "性能退化：修复引入性能问题，未做 benchmark 对比",
      "影响面遗漏：修改一个函数，未检查调用者是否受影响",
    ]),
    outputFormat: "Bug 修复 PR（源代码 + 测试用例 + 修复说明 + benchmark 对比）",
    historicalExperience:
      "历史成功模式：先复现再修复 + DW-2 影响面分析，回归 bug 率 < 5%；" +
      "历史失败教训：未复现直接修复，30% 的修复引入新 bug。",
  } as PhaseKnowledgeSlice),

  /**
   * 独立开发者 · handover 阶段切片
   *
   * 设计依据：Solo Coder 在交接阶段产出技术文档与部署脚本
   */
  Object.freeze({
    role: "solo_coder",
    phase: "handover",
    phaseGoal:
      "产出技术文档（README + JSDoc + 架构引用）、部署脚本与依赖清单；" +
      "确保运维团队可独立部署、回滚与排查常见问题。",
    keyChecks: Object.freeze([
      "README 完整：项目简介 + 快速开始 + 配置说明 + 部署步骤",
      "JSDoc 覆盖：所有 exported 函数/类/接口有 JSDoc 注释",
      "部署脚本：Dockerfile / k8s manifest / Helm chart 完整可运行",
      "依赖清单：package.json / Cargo.toml / requirements.txt 锁定版本",
      "环境变量：.env.example 列出全部必需环境变量与示例值",
      "健康检查：/health 端点返回 200，含数据库/缓存/消息队列连通性",
    ]),
    commonPitfalls: Object.freeze([
      "README 缺失：新成员上手困难，文档与代码脱节",
      "JSDoc 缺失：exported 函数无注释，调用方不知道参数含义",
      "部署脚本不可运行：本地能跑，生产环境报错",
      "依赖未锁定：版本漂移导致生产环境行为不一致",
      "环境变量遗漏：未在 .env.example 列出，运维不知道要配置什么",
    ]),
    outputFormat: "技术交付包（Markdown + 脚本）：README + JSDoc + 部署脚本 + 依赖清单 + .env.example",
    historicalExperience:
      "历史成功模式：完整交付包 + .env.example，新成员 1 天内可独立部署；" +
      "历史失败教训：文档缺失 + 依赖未锁定，新成员 1 周仍无法本地运行。",
  } as PhaseKnowledgeSlice),

  // ========================================================================
  // 角色 4：测试专家 (Test Expert) — 4 个切片
  // ========================================================================

  /**
   * 测试专家 · design 阶段切片
   *
   * 设计依据：Test Expert 在 design 阶段设计测试策略
   */
  Object.freeze({
    role: "test_expert",
    phase: "design",
    phaseGoal:
      "设计测试策略与测试用例框架，覆盖等价类、边界值、场景法；" +
      "为每个验收标准设计至少 3 个测试用例（正常/边界/异常）。",
    keyChecks: Object.freeze([
      "测试策略：单元/集成/E2E/性能/安全测试分层与覆盖目标",
      "等价类划分：有效等价类 + 无效等价类，每类至少 1 个用例",
      "边界值分析：边界条件（min/max/null/empty/overflow）有专门用例",
      "场景法：端到端业务场景有 E2E 用例覆盖",
      "验收标准映射：每条验收标准至少 3 个测试用例（正常/边界/异常）",
      "测试 fixture：真实数据 fixture，禁止 mock 业务逻辑",
    ]),
    commonPitfalls: Object.freeze([
      "只测 happy path：忽略边界条件与异常场景",
      "mock 滥用：mock 掉真实依赖，测试通过但生产崩溃",
      "测试用例无断言：只调用不验证，覆盖率虚高",
      "fixture 失真：测试数据与生产数据差异大，问题未暴露",
    ]),
    outputFormat: "测试计划（Markdown）：测试策略 + 用例清单 + fixture 设计 + 覆盖率目标",
    historicalExperience:
      "历史成功模式：等价类 + 边界值 + 场景法三层覆盖，缺陷发现率提升 3 倍；" +
      "历史失败教训：只测 happy path，生产环境边界条件崩溃。",
  } as PhaseKnowledgeSlice),

  /**
   * 测试专家 · coding 阶段切片
   *
   * 设计依据：Test Expert 在编码阶段编写自动化测试
   */
  Object.freeze({
    role: "test_expert",
    phase: "coding",
    phaseGoal:
      "编写自动化测试用例（单元/集成/E2E），覆盖率 ≥ 85%；" +
      "通过 DW-3 风险热点驱动用例优先级，高风险符号 100% 覆盖。",
    keyChecks: Object.freeze([
      "单元测试覆盖率：行覆盖率 ≥ 85%，分支覆盖率 ≥ 75%",
      "集成测试：模块间协作场景有集成测试",
      "E2E 测试：核心业务流程端到端可走通",
      "风险热点覆盖：CodeMap DW-3 返回的高 importance 符号 100% 覆盖",
      "测试命名：test_<场景>_<预期> 格式，可读性强",
      "断言密度：每个测试用例至少 1 个断言，避免无断言测试",
      "测试独立性：用例间无依赖，可任意顺序执行",
    ]),
    commonPitfalls: Object.freeze([
      "覆盖率虚高：测试用例无断言，覆盖率达标但质量低",
      "用例依赖：用例 A 依赖用例 B 的副作用，无法独立运行",
      "mock 滥用：mock 掉真实业务逻辑，测试失真",
      "命名混乱：test1/test2/test3，无法从命名理解测试意图",
    ]),
    outputFormat: "自动化测试代码（Vitest / pytest / Playwright）+ 覆盖率报告 + 风险热点覆盖矩阵",
    historicalExperience:
      "历史成功模式：DW-3 风险热点驱动 + 命名规范，高风险符号 100% 覆盖；" +
      "历史失败教训：mock 滥用 + 命名混乱，覆盖率 90% 但生产环境频繁崩溃。",
  } as PhaseKnowledgeSlice),

  /**
   * 测试专家 · testing 阶段切片
   *
   * 设计依据：AC-2.5 Test Expert prompt 含
   * "假设→插桩→复现→分析→修复→验证"（证据驱动调试法）
   */
  Object.freeze({
    role: "test_expert",
    phase: "testing",
    phaseGoal:
      "执行测试并定位缺陷，遵循证据驱动调试法：" +
      "假设→插桩→复现→分析→修复→验证；" +
      "禁止逻辑修改直到有日志证据。每个 bug 报告含最小重现步骤。",
    keyChecks: Object.freeze([
      "证据驱动调试法：假设→插桩→复现→分析→修复→验证 六步完整",
      "禁止逻辑修改直到有日志证据：先有证据再改代码，不猜测",
      "bug 报告完整：标题 + 严重度 + 最小重现步骤 + 环境 + 修复建议",
      "性能测试：P50/P95/P99 + QPS + 错误率，关键路径有 benchmark",
      "回归测试：修复后全量回归，无新测试失败",
      "FIX 失败上限：单 Loop 连续 3 次 FIX 失败强制 HUMAN_CHECKPOINT",
      "CodeMap DW-3：风险热点 Top-N 符号必须优先被测试覆盖",
    ]),
    commonPitfalls: Object.freeze([
      "猜测式修复：未复现就改代码，修复无效甚至引入新 bug",
      "bug 报告不完整：缺少重现步骤，开发无法定位",
      "跳过回归测试：修复后未跑全量测试，引入新 bug",
      "FIX 死循环：连续失败超过 3 次仍继续，浪费资源",
    ]),
    outputFormat: "Bug 报告（Markdown）+ 性能报告（P50/P95/P99）+ 回归测试报告",
    historicalExperience:
      "历史成功模式：证据驱动调试法 + 最小重现步骤，平均修复时间 < 2 小时；" +
      "历史失败教训：猜测式修复 + 缺少重现步骤，平均修复时间 > 2 天。",
  } as PhaseKnowledgeSlice),

  /**
   * 测试专家 · handover 阶段切片
   *
   * 设计依据：Test Expert 在交接阶段产出测试报告与质量门禁
   */
  Object.freeze({
    role: "test_expert",
    phase: "handover",
    phaseGoal: "产出测试报告、覆盖率报告与质量门禁规则；" + "确保 CI/CD 集成自动化质量门禁，覆盖率不达标不能合并。",
    keyChecks: Object.freeze([
      "测试报告：通过/失败/跳过统计 + 缺陷密度 + MTTR",
      "覆盖率报告：行/分支/函数覆盖率，达标阈值 ≥ 85%",
      "质量门禁：CI 集成覆盖率检查，不达标 PR 自动拒绝",
      "性能基线：关键路径 benchmark 基线，便于后续对比",
      "E2E 回归集：核心业务流程 E2E 用例集，每次发版回归",
      "视觉回归基线：UI 关键页面截图基线，像素级 Diff 检测",
    ]),
    commonPitfalls: Object.freeze([
      "测试报告缺失：只有通过/失败数，无缺陷密度与 MTTR",
      "覆盖率门禁未启用：CI 不检查覆盖率，质量退化无感知",
      "性能基线缺失：无 benchmark 基线，性能退化无法对比",
      "E2E 回归集缺失：发版前手动测试，遗漏率高",
    ]),
    outputFormat: "测试交付包（Markdown + JSON）：测试报告 + 覆盖率报告 + 质量门禁规则 + 性能基线",
    historicalExperience:
      "历史成功模式：CI 质量门禁 + E2E 回归集，线上缺陷率降低 80%；" +
      "历史失败教训：无质量门禁，覆盖率从 85% 退化到 40%，线上缺陷激增。",
  } as PhaseKnowledgeSlice),

  // ========================================================================
  // 角色 5：UI 设计师 (UI Designer) — 4 个切片
  // ========================================================================

  /**
   * UI 设计师 · design 阶段切片
   *
   * 设计依据：AC-2.5 UI Designer prompt 含 "反 AI-slop" 与
   * 禁用字体清单（Inter/Roboto/Arial/system-ui）+ Bold aesthetic direction
   * + AC-4.1 / AC-4.2 / AC-4.3 / AC-4.4
   */
  Object.freeze({
    role: "ui_designer",
    phase: "design",
    phaseGoal:
      "设计独特、生产级 UI 界面，遵循反 AI-slop 原则（禁通用字体 + 禁紫色渐变白底 + Bold aesthetic direction）；" +
      "WCAG 2.1 AA 无障碍标准强制执行，设计 Token 符合 W3C DTCG 格式。",
    keyChecks: Object.freeze([
      "反 AI-slop：禁用 Inter / Roboto / Arial / system-ui 四种通用字体",
      "字体替代：提供 10+ 替代字体推荐（Geist / Satoshi / Clash Display 等）",
      "反 AI-slop：禁用紫色渐变白底（purple-500 → white 渐变）作为主背景",
      "Bold aesthetic direction：10+ 风格极值可选（editorial / brutalist / minimalism / dark mode 等）",
      "WCAG 2.1 AA：正常文本对比度 ≥ 4.5:1，大文本 ≥ 3:1",
      "WCAG 2.1 AA：键盘可达 + 屏幕阅读器支持",
      "设计 Token W3C DTCG：UI 双件交付（UI-SPEC.md + ui-tokens.json）符合规范",
      "响应式：桌面 / 平板 / 手机全覆盖，断点合理",
    ]),
    commonPitfalls: Object.freeze([
      "AI slop 美学：使用 Inter/Roboto/Arial + 紫色渐变白底，缺乏品牌识别度",
      "对比度不足：浅灰文字配白底，可访问性不达标",
      "键盘不可达：关键操作只能鼠标点击，键盘用户无法使用",
      "断点不合理：手机端布局错乱，文字溢出",
      "设计 Token 格式不规范：自定义格式，前端无法直接消费",
    ]),
    outputFormat: "UI 双件交付：UI-SPEC.md（设计规范）+ ui-tokens.json（W3C DTCG 格式设计 Token）",
    historicalExperience:
      "历史成功模式：反 AI-slop + Bold aesthetic direction，品牌识别度提升 3 倍；" +
      "历史失败教训：AI slop 美学 + 对比度不足，用户流失率上升 20%。",
  } as PhaseKnowledgeSlice),

  /**
   * UI 设计师 · coding 阶段切片
   *
   * 设计依据：UI Designer 在编码阶段审阅前端实现
   */
  Object.freeze({
    role: "ui_designer",
    phase: "coding",
    phaseGoal: "审阅前端实现是否符合 UI-SPEC 与 ui-tokens.json；" + "确保组件复用设计 Token，无硬编码颜色/字号/间距。",
    keyChecks: Object.freeze([
      "Token 复用：颜色/字号/间距 100% 引用 ui-tokens.json，无硬编码",
      "组件一致性：与设计系统对齐，不随意发明新组件",
      "响应式实现：桌面/平板/手机三端布局正确，断点与设计一致",
      "无障碍实现：ARIA 属性完整，键盘可达，屏幕阅读器友好",
      "动效规范：200-500ms，不阻塞，有目的（非装饰性）",
      "反 AI-slop 检查：未使用 Inter/Roboto/Arial/system-ui 字体",
    ]),
    commonPitfalls: Object.freeze([
      "硬编码：颜色写死 #fff，未引用 design token",
      "组件偏离：前端自创组件，与设计系统不一致",
      "响应式断点错误：手机端布局错乱",
      "ARIA 缺失：图标按钮无 aria-label，屏幕阅读器无法识别",
      "AI slop 残留：使用 system-ui 字体 fallback",
    ]),
    outputFormat: "UI 审阅报告（Markdown）：Token 复用率 + 组件一致性 + 无障碍检查 + 改进建议",
    historicalExperience:
      "历史成功模式：100% Token 复用 + ARIA 完整，可访问性评分 100；" +
      "历史失败教训：硬编码颜色 + ARIA 缺失，可访问性评分 60，被投诉。",
  } as PhaseKnowledgeSlice),

  /**
   * UI 设计师 · testing 阶段切片
   *
   * 设计依据：UI Designer 在测试阶段执行视觉回归与 UX 巡检
   */
  Object.freeze({
    role: "ui_designer",
    phase: "testing",
    phaseGoal:
      "执行视觉回归测试（像素级 Diff）与 UI/UX 巡检（可访问性 / 交互质量 / 布局响应式 / UX 反模式）；" +
      "确保 UI 实现与设计稿一致，无视觉退化。",
    keyChecks: Object.freeze([
      "视觉回归：UI 关键页面截图与基线对比，像素级 Diff 检测",
      "UI/UX 巡检 - 可访问性：WCAG 2.1 AA 全部通过",
      "UI/UX 巡检 - 交互质量：所有交互元素有明确反馈",
      "UI/UX 巡检 - 布局响应式：桌面/平板/手机三端布局正确",
      "UI/UX 巡检 - UX 反模式：无暗模式 / 强制注册 / 模态弹窗滥用",
      "数据显示完整性：长文本不截断，数据完整显示",
      "显示错误检测：无错位 / 重叠 / 溢出",
    ]),
    commonPitfalls: Object.freeze([
      "视觉回归缺失：UI 改动未做截图对比，视觉退化无感知",
      "可访问性跳过：只测视觉，不测键盘/屏幕阅读器",
      "数据显示不全：长文本截断，用户看不到完整信息",
      "UX 反模式：暗模式注册 / 模态弹窗滥用，用户体验差",
    ]),
    outputFormat: "视觉回归报告 + UI/UX 巡检报告（含截图 Diff + 问题清单 + 修复建议）",
    historicalExperience:
      "历史成功模式：像素级 Diff + UI/UX 巡检，UI 缺陷率降低 90%；" +
      "历史失败教训：无视觉回归，UI 改动引入视觉退化，用户投诉。",
  } as PhaseKnowledgeSlice),

  /**
   * UI 设计师 · handover 阶段切片
   *
   * 设计依据：UI Designer 在交接阶段产出设计系统与品牌资产
   */
  Object.freeze({
    role: "ui_designer",
    phase: "handover",
    phaseGoal: "产出设计系统文档、品牌资产包与前端组件库；" + "确保后续团队成员可复用设计系统，保持 UI 一致性。",
    keyChecks: Object.freeze([
      "设计系统文档：组件用法 + Token 说明 + 设计原则",
      "品牌资产包：Logo / 字体 / 配色 / 图标，含 SVG 与 PNG",
      "前端组件库：Storybook 文档，每个组件有交互 demo",
      "设计 Token 文件：ui-tokens.json（W3C DTCG 格式）+ 多主题支持",
      "无障碍指南：WCAG 2.1 AA 实施指南 + 常见模式",
      "Figma 源文件：含组件库 + 自动布局 + 变量",
    ]),
    commonPitfalls: Object.freeze([
      "设计系统缺失：每个新功能重新设计，UI 风格不统一",
      "品牌资产散落：Logo/字体/配色分散在多处，难以维护",
      "组件库无文档：组件无 Storybook，开发不知道如何使用",
      "Figma 文件混乱：无组件库，无自动布局，难以维护",
    ]),
    outputFormat: "设计交付包（Markdown + JSON + Figma）：设计系统文档 + 品牌资产 + 组件库 + Token 文件",
    historicalExperience:
      "历史成功模式：完整设计系统 + Storybook，新功能 UI 一致性 100%；" +
      "历史失败教训：无设计系统，每个功能 UI 风格不同，品牌识别度低。",
  } as PhaseKnowledgeSlice),
]);

// ============================================================================
// 6. 切片查询函数（供 RolePromptCustomizer 使用）
// ============================================================================

/**
 * 切片查询索引（role + phase → PhaseKnowledgeSlice，O(1) 查找）
 *
 * 构造时一次性构建，后续只读。
 * 键格式：`${role}|${phase}`，如 "architect|design"
 */
const SLICE_INDEX: ReadonlyMap<string, PhaseKnowledgeSlice> = Object.freeze(
  new Map(PHASE_KNOWLEDGE_SLICES.map((slice) => [`${slice.role}|${slice.phase}`, slice]))
);

/**
 * 按 (role, phase) 查询 phaseKnowledgeSlice
 *
 * 查找规则：
 * 1. 构造索引键 `${role}|${phase}`
 * 2. 从 SLICE_INDEX 中 O(1) 查找
 * 3. 找到则返回切片；未找到则抛错（编程错误，role/phase 应为合法值）
 *
 * 边界处理：
 * - role 不在 ROLE_KINDS 中：抛错
 * - phase 不在 ROLE_PHASES 中：抛错
 * - (role, phase) 组合未定义切片：抛错（应为 5×4=20 全覆盖，缺切片是编程错误）
 *
 * @param role 角色 ID（architect / product_manager / solo_coder / test_expert / ui_designer）
 * @param phase Loop 阶段（design / coding / testing / handover）
 * @returns 对应的 PhaseKnowledgeSlice（已冻结，不可变）
 * @throws {Error} role/phase 非法或 (role, phase) 组合未定义切片时抛错
 */
export function getPhaseKnowledgeSlice(role: RoleKind, phase: RolePhase): PhaseKnowledgeSlice {
  // ---------- 边界处理 ----------
  if (!ROLE_KINDS.includes(role)) {
    throw new Error(`非法 RoleKind: ${String(role)}，合法值: ${ROLE_KINDS.join(" / ")}`);
  }
  if (!ROLE_PHASES.includes(phase)) {
    throw new Error(`非法 RolePhase: ${String(phase)}，合法值: ${ROLE_PHASES.join(" / ")}`);
  }

  // ---------- 索引查找 ----------
  const key = `${role}|${phase}`;
  const slice = SLICE_INDEX.get(key);
  if (slice === undefined) {
    // 理论上不会发生（5×4=20 全覆盖），防御性处理
    throw new Error(`未找到 phaseKnowledgeSlice: role=${String(role)}, phase=${String(phase)}`);
  }
  return slice;
}

/**
 * 列出全部 phaseKnowledgeSlice（用于测试断言 20 个切片完整性）
 *
 * @returns 全部 20 个切片的只读数组（已冻结）
 */
export function listAllPhaseKnowledgeSlices(): ReadonlyArray<PhaseKnowledgeSlice> {
  return PHASE_KNOWLEDGE_SLICES;
}

/**
 * 按角色列出该角色的全部 4 个阶段切片
 *
 * @param role 角色 ID
 * @returns 该角色的 4 个阶段切片（按 design → coding → testing → handover 顺序）
 */
export function listSlicesByRole(role: RoleKind): ReadonlyArray<PhaseKnowledgeSlice> {
  if (!ROLE_KINDS.includes(role)) {
    throw new Error(`非法 RoleKind: ${String(role)}，合法值: ${ROLE_KINDS.join(" / ")}`);
  }
  return PHASE_KNOWLEDGE_SLICES.filter((slice) => slice.role === role);
}

/**
 * 按阶段列出该阶段的全部 5 个角色切片
 *
 * @param phase Loop 阶段
 * @returns 该阶段的 5 个角色切片
 */
export function listSlicesByPhase(phase: RolePhase): ReadonlyArray<PhaseKnowledgeSlice> {
  if (!ROLE_PHASES.includes(phase)) {
    throw new Error(`非法 RolePhase: ${String(phase)}，合法值: ${ROLE_PHASES.join(" / ")}`);
  }
  return PHASE_KNOWLEDGE_SLICES.filter((slice) => slice.phase === phase);
}
